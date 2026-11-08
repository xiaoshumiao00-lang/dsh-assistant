/**
 * 鹈鹕（tihu）P0 宿主侧 lane：一条**受 pocket 鉴权保护**的 WebSocket 事件通道。
 *
 * 为什么挂在 pocket 代理上而不是新开端口：
 *   - pocket 已经把「局域网/公网 Host 判定 + token/PIN + HttpOnly cookie + 限速」
 *     这一整套做完了（src/pocket-host/proxy.mjs）。新开端口等于把这套安全逻辑
 *     再写一遍，多一个可被扫的入口；
 *   - 手机远程访问本来就是经 pocket 代理进来的：`https://<公网域名>/?token=…`。
 *     `/tihu` 与 `/tihu/lane` 走**同一个 cookie**，用户不需要第二套密码；
 *   - 代理侧的放行规则是按「路径前缀」挑处理函数，`/tihu` 与 `/tihu/lane`
 *     在鉴权通过后由本文件的 handleHttp / handleUpgrade 接走，不落到上游 dsh web。
 *
 * 数据流（P0，模拟设备页）：
 *
 *   页面 ──audio.frame(base64 WAV)──► handleUpgrade → 本 lane
 *        ◄─transcript / screen.frame / tts.text / event.* / confirm.ask──
 *
 *   本 lane 做的事：
 *     1. 语音：走官方 speech 服务（`ctx.get('speechController')`，也就是客户端
 *        `remote.speech` 背后的同一个服务），不新造 ASR、不引入模型依赖；
 *     2. 注入：`agents.get(sessionId).followup(message)` —— 与用户在会话里发消息
 *        同一条入口（普通 user/message），不另建并行会话；
 *     3. 屏：订阅 `session/event`（turn/start、tool/call、assistant/message、
 *        turn/end）→ screen.frame / event.progress / event.done / tts.text；
 *     4. 闸：`tools/pre-execute` / `tools/post-execute` → 快照、审计、危险确认
 *        （见 guard.ts）。只对「tihu 正在执行的会话」生效，不干扰桌面正常使用。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { WsFrameParser, encodeFrame } from '../pocket-host/ws-deflate.mjs'
import {
  TIHU_DOWNSTREAM_TYPES,
  TIHU_PROTOCOL_VERSION,
  TIHU_UPSTREAM_TYPES,
  buildDownstream,
  createSeq,
  looksLikeWavBase64,
  parseUpstream,
  randomId,
  summarizeForLog,
  type ConfirmAskPayload,
  type DonePayload,
  type HelloPayload,
  type ProgressPayload,
  type ScreenFramePayload,
  type SessionBoundPayload,
  type SessionInvalidPayload,
  type SessionsListPayload,
  type TranscriptPayload,
  type TtsTextPayload,
} from './protocol.ts'
import {
  appendAudit,
  classifyTool,
  commandOf,
  createConfirmBroker,
  diffSummary,
  readTextOrEmpty,
  takeSnapshot,
  targetPathOf,
  tihuDirOf,
  timestampSlug,
  type ConfirmBroker,
  type TihuActionClass,
} from './guard.ts'
import { tihuPageHtml } from './page.ts'
import { applyEarlyThinking, applySessionEvent, confirmationFrame, createProgressState, decodeRateOf, pushDecodeSample, type TihuDecodeSample, type TihuProgressState } from './progress.ts'
import { TihuTts, type TihuTtsPaths } from './tts.ts'
import { replyWindow, splitReplySentences, splitSpeechSegments, type ReplySentence, type SpeechSegment } from './reply.ts'
import { stripToolNoise, toSpeechText } from './speech-text.ts'
import { CONTENT_WIDTH_PX, PENDING_RAIL_WIDTH_PX, SCREEN_SPEC, wrapTextPx } from './screen-spec.ts'
import { cardsFromState, groupCardProjects, groupProjects, groupWorkspaceProjects, humanTitle, projectCardsSignature, projectNameOf, type ProjectReply, type TihuCardRow, type TihuWorkspaceRow } from './project-groups.ts'
import { matchSessionRows, type ControlSessionRow, type DeviceStatusView, type SessionProgressView, type TihuControlDevice, type TihuControlSurface } from './control.ts'
import type { AlertPayload, TtsAudioPayload, VoiceCreatedPayload, VoiceListPayload } from './protocol.ts'

/** 页面与 WebSocket 的路径（代理侧按这两个前缀放行）。 */
export const TIHU_PAGE_PATH = '/tihu'
export const TIHU_LANE_PATH = '/tihu/lane'

/**
 * 每会话回答历史上限（用户 2026-11-08 要求：最多 8 条，含 sentences/speechSegments/
 * includeAll 与时间）。朗读屏的「上一条 / 下一条」只在这份历史里翻页，翻页不自动朗读。
 */
export const REPLY_HISTORY_LIMIT = 8

/**
 * 试听默认示例语句（页面 `tts.sample` 不带 text 时用）。
 * 选一句自报家门的话：用户点「试听」听到的是真人的声音，而不是一声嘟。
 */
const TIHU_SAMPLE_TEXT = '试听：我是云健，声音正常吗？'

/** 单条 WS 文本帧上限（协议层还有更细的限制）。 */
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024
/** 转写超时。 */
const TRANSCRIBE_TIMEOUT_MS = 45_000
/**
 * 一次 tihu 语音会话的「活跃窗口」：**最后一次 tihu 消息之后**这么久内才算活着。
 *
 * 2026-11-06 P0 修复：原来是 15 分钟、而且任何 `turn/start` 都会把窗口点亮，
 * 于是「用一次语音，电脑 15 分钟不能干活」——用户自己在会话里打的命令也会被
 * 当成危险动作要设备确认，设备不在线就 60 秒超时失败。现在：
 *   - 只有 tihu 注入**自己这个 turn** 的工具调用才算（见 `tihuTurnOf`）；
 *   - 窗口 120 秒滑动，页面「结束本次语音会话」立即清零。
 */
const ACTIVE_WINDOW_MS = 120_000
/** 确认超时（设备在线但没人点）。 */
const CONFIRM_TIMEOUT_MS = 60_000
/**
 * 回主页守门重试间隔：scheduleHome 的 timer 触发时若还有任何会话的 turn 在跑
 * （runningSessions 非空），不回主页，按这个间隔再查一次。
 * 可用环境变量 TIHU_HOME_RECHECK_MS 覆盖（测试里设小）；非数字/0 一律回落到默认，
 * 否则 setTimeout(fn, NaN) 会变成 0ms 忙循环（2026-11-07 审计 P1-5）。
 */
export function tihuHomeRecheckMs(): number {
  const raw = Number(process.env.TIHU_HOME_RECHECK_MS ?? 2_000)
  if (!Number.isFinite(raw)) return 2_000
  // 0 / 负数会让 setTimeout 退化成 0ms 忙循环，必须抬到下限。
  if (raw <= 0) return 250
  return clampInt(raw, 20, 60_000)
}

/**
 * 一轮 turn 的最长寿命：超过它说明 turn/end 永远不会来了（agent 被杀、宿主重启、
 * 事件在早退分支前抛错），必须自愈，否则 runningSessions 里这条会永久挡住回主页。
 */
export function tihuTurnStaleMs(): number {
  const raw = Number(process.env.TIHU_TURN_STALE_MS ?? 30 * 60_000)
  if (!Number.isFinite(raw) || raw <= 0) return 30 * 60_000
  return clampInt(raw, 10, 6 * 60 * 60_000)
}

/**
 * 控制室卡片变化的巡检间隔（毫秒）。
 *
 * 设备停在主页时宿主不会自己重发主页帧（scheduleHome 见 mode==='home' 直接返回、
 * ping 只回 pong），于是控制室里隐藏/删除/改名一张卡，屏幕上还是旧清单，必须点一次球
 * 才刷新。这条巡检只在「卡片签名」真的变了时补一帧。
 *
 * 默认 30 秒（用户 2026-11-08 要求「刷新频率不用很频繁」）；TIHU_HOME_SYNC_MS=0 关闭；
 * 非数字回落默认，正数夹在 1s ~ 10min，防止手滑写成 0ms 忙循环。
 */
export function tihuHomeSyncMs(): number {
  const raw = Number(process.env.TIHU_HOME_SYNC_MS ?? 30_000)
  if (!Number.isFinite(raw)) return 30_000
  if (raw === 0) return 0
  return clampInt(raw, 1_000, 10 * 60_000)
}

/**
 * 流式思考刷屏节流（毫秒）。
 *
 * 模型的 reasoning-delta 每几十毫秒一块，屏帧不需要每块都刷：默认 300ms 取一次
 * 「已经到达的思考文本」→ 第一句话写进「思考」活动行。TIHU_THINKING_FLUSH_MS 可调
 * （夹在 20ms ~ 5s，0/负数/非数字回落默认），测试里设小。
 */
export function tihuThinkingFlushMs(): number {
  const raw = Number(process.env.TIHU_THINKING_FLUSH_MS ?? 300)
  if (!Number.isFinite(raw)) return 300
  return clampInt(raw, 20, 5_000)
}

/**
 * 朗读收尾余量：lane 的播放时间轴是「首块到达 + 累计音频时长」的投影，页面实际
 * 起播还差一个 ~30ms 的排程缓冲；留这点余量，回主页才不会被最后半句抢跑。
 */
const SPEAK_TAIL_MARGIN_MS = 120

/**
 * 每条会话最多留多少思考原文：只需要第一句话，整段思考可能 20KB+（实测 reasoning
 * 430 块 ≈ 16KB），留在内存里没意义；超出就停止累积（第一句早就够了）。
 */
const TIHU_THINKING_MAX_CHARS = 4_000

/** 环境变量整数化 + 夹到安全区间（NaN / 0 / 负数一律回落兜底值）。 */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

/** 一个已连接的设备（P0 一个页面一个连接）。 */
interface TihuDevice {
  id: string
  socket: any
  seq: () => number
  hello?: HelloPayload
  sessionId?: string
  /** 自动跟随模式：每次连上/注入前重新取「最活跃的 CU 会话」，变了就跟随。 */
  autoFollow: boolean
  /** 页面选中的音色（default / 克隆音色名）。 */
  voice: string
  /** edge-tts 兜底音色（在线兜底）。 */
  edgeVoice: string
  /** 仅离线：禁用 edge-tts。 */
  offlineOnly: boolean
  send: (type: string, payload: unknown) => void
  close: () => void
  /** 中止该设备当前这一轮朗读（换绑/断开时调用）：置 aborted，后续音频不再下发。 */
  cancelRound?: () => void
}

/**
 * 定时发一帧（朗读时按音频播放时刻推进屏帧）。
 *
 * 回调必须 try/catch：异常发生在 setTimeout 里，逃出去就是 uncaughtException，
 * 会把 pocket / DSH 宿主进程直接打死（2026-11-07 审计 P0-3）。
 */
export function scheduleFrameAt(at: number, fn: () => void, onError: (error: unknown) => void = () => {}): Promise<void> {
  return new Promise<void>((resolve) => {
    const delay = Math.max(0, at - Date.now())
    setTimeout(() => {
      try {
        fn()
      } catch (error) {
        onError(error)
      } finally {
        resolve()
      }
    }, delay)
  })
}

/** 一个「tihu 语音会话」的活跃窗口。 */
interface TihuWindow {
  /** 到期时间（毫秒）。 */
  until: number
  /** 这次注入的消息 id：只有「当前 turn 的提示消息就是它」才受闸门约束。 */
  messageId: string
}

export interface TihuRuntimeOptions {
  /** 日志函数（走宿主 logger）。 */
  log: (line: string) => void
  /** 当前工作区根目录的解析器（按会话 id）。 */
  workspaceOf?: (sessionId: string) => string | undefined
  /** 本地 TTS 覆盖（单测里禁用/注入假引擎）。 */
  tts?: { disabled?: boolean; threads?: number; port?: number; paths?: Partial<TihuTtsPaths>; instance?: TihuTts; prewarm?: boolean }
  /** 危险动作确认器覆盖（单测里注入会抛错的 broker，验证 fail-closed）。 */
  confirmBroker?: ConfirmBroker
  /** 控制室卡片巡检间隔（毫秒，0 = 关闭；缺省走 tihuHomeSyncMs()/环境变量）。 */
  homeSyncMs?: number
}

/** 提供给代理的两个入口 + 卸载函数。 */
export interface TihuRuntime {
  /** 模拟设备页 HTML。 */
  page: () => string
  /** WebSocket 升级处理；返回 true 表示这条 upgrade 已被 tihu 接走。 */
  handleUpgrade: (req: any, socket: any, head: Buffer) => boolean
  /** 卸掉所有监听。 */
  dispose: () => void
  /** 测试/诊断用。 */
  /** 控制面：tihu 全局工具用（薄壳转调内部函数，契约见 control.ts）。 */
  stats: () => { devices: number; activeSessions: string[]; pendingConfirms: number }
}

/** 可选服务：cordis 对未 inject 的服务直读会 throw，一律 ctx.get + try。 */
function optionalService(ctx: any, id: string): any {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(id)
  } catch { /* 服务不存在 */ }
  return undefined
}

/** 会话 id：不同版本宿主把它放在 session.id 或 session.header.id。 */
function sessionIdOf(session: any): string | undefined {
  const direct = session?.id
  if (typeof direct === 'string' && direct !== '') return direct
  const header = session?.header?.id
  return typeof header === 'string' && header !== '' ? header : undefined
}

function sessionIdOfAgent(agent: any): string | undefined {
  return sessionIdOf(agent?.session) ?? (typeof agent?.sessionId === 'string' ? agent.sessionId : undefined)
}

/** 屏上/提示里用的短会话 id（`session-98bb83cb-…` → `98bb83cb`）。 */
function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, 8) || sessionId.slice(0, 8)
}

/** 选择器一行（宿主内部形状；下发时映射成协议的 SessionChoice）。 */
interface TihuSessionRow {
  sessionId: string
  title: string
  /** agent preset（Computer Use 判定依据：投影 `agentPreset`，缺省回退 header）。 */
  preset: string
  cwd?: string
  createdAt?: number
  /** 活跃时间：max(createdAt, 投影 sessionListMetadata.lastPromptAt)。 */
  updatedAt: number
  live: boolean
}

/**
 * Computer Use（电脑操作）模式的 agent preset id。
 *
 * 2026-11-07 实测：`~/.dsh/storages/session_projcache/sessions/*.json` 里
 * `rows.agentPreset.val` 的取值只有 `standard` / `standard-slim-local` / `cordis` /
 * `computer-use`（另有 null/undefined 的老会话），与 cordis.patch.yml 里
 * `id: computer-use` 的预设一致。鹈鹕要靠 GUI 看屏/点按，只有这个模式能做。
 */
export const TIHU_COMPUTER_USE_PRESET = 'computer-use'

/** 构造一条普通用户消息（与 turn-guard 的 buildUserMessage 同形状）。 */
export function buildTihuUserMessage(text: string): any {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'user' },
  }
}

/** WebSocket 握手应答头。 */
function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

/** 从 upgrade 请求里取 pathname（坏 URL 一律当作不匹配）。 */
function pathnameOf(req: any): string {
  try { return new URL(String(req?.url ?? '/'), 'http://tihu.invalid').pathname } catch { return '' }
}

/**
 * 创建 tihu 运行时。不监听端口：页面与 WS 都由 pocket 代理在鉴权之后转进来。
 */
export function createTihuRuntime(ctx: any, options: TihuRuntimeOptions): TihuRuntime {
  const log = options.log ?? (() => {})
  const devices = new Set<TihuDevice>()
  /** 会话 id → 活跃窗口（只有 tihu 注入的那个 turn 的工具调用才受闸门约束）。 */
  const activeSessions = new Map<string, TihuWindow>()
  /** 会话 id → reply 历史滚动状态（宿主唯一权威）。 */
  interface ScreenScrollState {
    lines: { text: string; sentenceIndex: number }[]
    offset: number
    follow: boolean
    sentences: ReplySentence[]
    currentIndex: number
    charPos: number
    widthPx: number
  }
  const screenStates = new Map<string, ScreenScrollState>()
  /** 每会话的屏幕模式与回主页计时。 */
  const homeStates = new Map<string, { mode: 'home' | 'session'; page: number; done: boolean; timer?: ReturnType<typeof setTimeout> }>()
  /**
   * 最近一帧主页用的是哪份控制室卡片清单（签名）。卡片巡检只和它比：
   * 屏幕上的东西没变就不重发；没人停在主页时也不更新，等它下次回主页自己拿新的。
   */
  let shownCardSignature = ''
  /** 设备 id → 是否在浏览历史（回主页守门按设备算，避免多设备互相卡住）。 */
  const followByDevice = new Map<string, boolean>()
  /**
   * 「设备 | 会话」→ 朗读轮次号。
   *
   * 2026-11-07 断音根因之二：一个 turn 里每条 `assistant/message` 都会从头开一轮朗读，
   * 而旧实现**不取消上一轮**——两轮的合成同时跑（实测 26 次合成、页面收到两遍 index 0..11），
   * 页面按到达顺序把两轮 PCM 串起来播，听感就是「念一句然后乱掉/断掉」。
   * 新的一轮开始前先把自己的前辈掐掉（`device.cancelRound()`），并用轮次号做兜底判定。
   */
  const speakRounds = new Map<string, number>()
  /**
   * 运行中的 turn 跟踪：sessionId → turn/start 时间戳。
   * 2026-11-07 新需求：只要**任何** CU 会话有 turn 在跑，屏幕就必须停在会话详情，
   * 不允许回主页控制室；只有所有会话都停了才允许回主页。
   * 注意：这条跟踪必须在 session/event 处理器的「设备早退」**之前**更新——
   * 没绑定该会话的设备收不到事件，早退会把跟踪丢掉。
   */
  const runningSessions = new Map<string, number>()
  /** 事件里带来的会话模式（preset）：列表缓存有 60s TTL，刚建的会话只能靠它判 CU。 */
  const sessionPresets = new Map<string, string>()
  /**
   * 朗读（音频）状态：sessionId → { speaking, until }。
   *   - speaking：正在跑的 speakLocally 数（合成+下发还没结束就算「在播」）；
   *   - until：投影的播放结束时刻（按每段音频时长累加，与页面 AudioContext 同一口径）。
   * 2026-11-07 实测缺陷：长回复读到一半，turn 已经结束（runningSessions 空），
   * 但音频还在播/队列还没播完，旧的 scheduleHome 只看 runningSessions 就切了主页；
   * 之后 speakLocally 里按播放时刻排的 reply 屏帧到期，又把屏切回回复页——
   * 用户看到的就是「读到一半跳控制室主页，过一会自己跳回来继续读」。
   */
  const readingStates = new Map<string, { speaking: number; until: number }>()
  /** 显示会话 id → 待读气泡（别的会话完成时入队）。 */
  let disposed = false
  const pendingByDisplay = new Map<string, { sessionId: string; title: string; at: number }[]>()
  /** 会话 id → 最近一条回复（点气泡后从头朗读）。 */
  const lastReplies = new Map<string, { sentences: ReplySentence[]; speechSegments: SpeechSegment[]; includeAll: boolean }>()
  /** 一条回答历史：翻页要能整屏重放（只换屏，不再合成语音）。 */
  interface ReplyHistoryEntry {
    text: string
    sentences: ReplySentence[]
    speechSegments: SpeechSegment[]
    includeAll: boolean
    at: number
  }
  /** 会话 id → 回答历史（最新在末尾，最多 REPLY_HISTORY_LIMIT 条）：上一条/下一条 翻页用。 */
  const replyHistory = new Map<string, ReplyHistoryEntry[]>()
  /** 会话 id → 当前浏览到历史里的第几条（缺省/越界即最新一条）。 */
  const replyBrowseIndex = new Map<string, number>()
  /** 钉在主页的会话：钉住期间 status/reply 帧不再覆盖主页屏（点主页 = 退出朗读 + 钉住）。 */
  const homePinned = new Set<string>()
  /** 正在翻历史浏览的会话：10 秒自动回主页暂停，用户显式点主页/项目卡才回（用户 2026-11-08 要求）。 */
  const browsingHistory = new Set<string>()
  /** 钉住期间用的主页帧底子：只用它刷气泡轨，屏仍停在主页。 */
  const pinnedHomeFrames = new Map<string, ScreenFramePayload>()
  /** 钉住期间最近一次下发给页面的气泡轨签名（一样就不再重发，免得长回复残留帧反复刷屏）。 */
  const pinnedPendingSig = new Map<string, string>()
  /** 会话 id → 最近一条 assistant 原文（主页摘要用，避免显示裸 id）。 */
  const lastAssistant = new Map<string, ProjectReply>()
  /** 会话 id → 屏幕进度状态（步骤计数 / 用时 / 上一步结果）。 */
  const progressStates = new Map<string, TihuProgressState>()
  /**
   * 会话 id → 本次 attempt 已经收到的思考文本（agent/assistant-stream 的
   * reasoning-delta 累积；start 重置、end 清空）。宿主 session/event 要等该步
   * assistant/message 才有思考块，这里补的是模型正在想的那段时间。
   */
  const liveThinking = new Map<string, { attemptId: string; text: string }>()
  /** 会话 id → 思考节流定时器（每会话最多一个，避免每个 token 刷一屏）。 */
  const thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 正在 reply 阅读模式的会话（turn/end 不再用「完成」状态帧覆盖正文）。 */
  const replySessions = new Set<string>()
  /** 本地 TTS sidecar（独立进程；模型缺失时 available=false，页面走系统语音）。 */
  const tts = options.tts?.instance ?? new TihuTts({
    log,
    workspaceOf: options.workspaceOf,
    threads: options.tts?.threads ?? 8,
    ...(options.tts?.disabled === true ? { disabled: true } : {}),
    ...(options.tts?.port === undefined ? {} : { port: options.tts.port }),
    ...(options.tts?.paths === undefined ? {} : { paths: options.tts.paths }),
  })
  // 仅真实插件（pocket-host）启动时预热 GPU；单测传 prewarm=false，避免拉起 sidecar。
  if (options.tts?.prewarm === true && options.tts?.disabled !== true && tts.backend() === 'qwen-cuda') {
    void tts.ensureServer().catch((error) => log(`tihu tts prewarm failed: ${(error as Error)?.message ?? String(error)}`))
  }
  const confirmBroker: ConfirmBroker = options.confirmBroker ?? createConfirmBroker({
    onAsk: (request) => {
      for (const device of devices) {
        if (request.sessionId !== undefined && device.sessionId !== request.sessionId) continue
        const payload: ConfirmAskPayload = {
          confirmId: request.id,
          title: request.title,
          detail: request.detail,
          options: ['确认', '取消'],
          timeoutMs: request.timeoutMs,
          risk: request.risk,
        }
        device.send('confirm.ask', payload)
        // 屏幕也要切到「等待确认」，别让用户只看到上一步的执行画面。
        sendFrame(device, confirmationFrame(request.title, request.detail))
      }
      log(`tihu confirm.ask id=${request.id} title=${JSON.stringify(request.title)}`)
    },
  } as any)

  /** 发一条下行给「绑定到某会话」的所有设备。 */
  function broadcast(sessionId: string, type: string, payload: unknown): void {
    for (const device of devices) {
      if (device.sessionId !== sessionId) continue
      device.send(type, payload)
    }
  }

  /** 屏帧快捷方法。 */
  ﻿/** 屏帧需要的会话标题与统计（第一行标题 + 第四行 tok/s、总 token、上下文占比）。 */
function screenMetaOf(sessionId: string): { title?: string; stats?: { tokPerSec: number; totalTokens: number; contextPercent: number } } {
  const sessions = optionalService(ctx, 'sessions')
  let live: any
  try { live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined } catch { live = undefined }
  if (live === undefined || live === null) return {}
  const values = projectionValuesOf(live) as Record<string, any>
  // 累计 token：不同版本宿主把用量投影在不同小对象里（tokenUsage.totals / usage / sessionStats），
  // 统一扫一遍「键名以 Tokens 结尾」的数字，取各来源里最大的那个，避免一直是 0。
  const sumTokens = (node: any): number => {
    if (node === null || typeof node !== 'object') return 0
    let sum = 0
    for (const [key, value] of Object.entries(node)) {
      if (!/tokens$/i.test(key) || /window|limit/i.test(key)) continue
      const num = Number(value)
      if (Number.isFinite(num) && num > 0) sum += num
    }
    return sum
  }
  const totalTokens = Math.max(
    sumTokens(values?.tokenUsage),
    sumTokens(values?.usage),
    sumTokens(values?.sessionStats),
    0,
  )
  const decodeMs = Number(values?.sessionStats?.decodeMs ?? 0)
  const decodeTokens = Number(values?.sessionStats?.decodeTokens ?? 0)
  // 实时解码速度：只看最近窗口里的 token 增量 ÷ 解码毫秒增量，不再用全程平均（用户 2026-11-08 要求）
  const sample = { at: Date.now(), decodeMs, decodeTokens }
  const averageTokPerSec = decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : 0
  // 窗口不足两段时先退回全程平均，之后每一帧都改用最近 15 秒的增量速度
  const speedSamples = pushDecodeSample(speedWindows.get(sessionId) ?? [], sample)
  speedWindows.set(sessionId, speedSamples)
  const liveSpeed = decodeRateOf(speedSamples) ?? speedLive.get(sessionId) ?? averageTokPerSec
  speedLive.set(sessionId, liveSpeed)
  const tokPerSec = liveSpeed
  const contextWindow = Number(values?.contextPressure?.contextWindow ?? 0)
  const used = Number(values?.contextPressure?.pressureTokens ?? values?.contextPressure?.surfaceTokens ?? 0)
  const contextPercent = contextWindow > 0 ? Math.min(100, (used / contextWindow) * 100) : 0
  return { title: titleOf(live), stats: { tokPerSec, totalTokens, contextPercent } }
}

/** 每条会话的解码速度样本窗口与最近一次实时速度。 */
const speedWindows = new Map<string, TihuDecodeSample[]>()
/** 标题快照读取节流：同一会话 60 秒内只发一次请求。 */
const titleFetchAt = new Map<string, number>()
const speedLive = new Map<string, number>()
const lastFrames = new Map<string, Omit<ScreenFramePayload, 'bullets'> & { bullets?: string[] }>()

  /** 回复屏底部的三个动作按钮（设备端渲染、点按回传 actionId）。 */
  const REPLY_ACTIONS = [
    { id: 'stop', label: '停止' },
    { id: 'replay', label: '重读' },
    { id: 'home', label: '主页' },
  ] as const

  /**「已绑定」提示屏停留时长：默认 3 秒（TIHU_BIND_HOME_MS 可调，0 表示不停留）。 */
  function bindHomeDelayMs(): number {
    const raw = Number(process.env.TIHU_BIND_HOME_MS ?? 3000)
    if (!Number.isFinite(raw)) return 3000
    return Math.max(0, Math.min(raw, 60_000))
  }

  /** 这条会话是不是 Computer Use 模式：按列表缓存里的 preset 判，查不到当不是。 */
  function isComputerUseSession(sessionId: string): boolean {
    const live = sessionPresets.get(sessionId)
    if (live !== undefined && live !== '') return isComputerUsePreset(live)
    const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId)
    if (row === undefined) return false
    return isComputerUsePreset(row.preset ?? '')
  }

  /** 会话标题：投影（权威）→ 标题缓存 → 列表缓存 → 短 id 兜底（运行中列表要用）。 */
  function titleForSession(sessionId: string): string {
    const live = liveSessionOf(sessionId)
    const projected = live === undefined ? undefined : titleOf(live)
    if (projected !== undefined && projected !== '') return projected
    const cached = titleCache.get(sessionId)?.title
    if (cached !== undefined && cached !== '') return cached
    const rows = sessionListCache?.rows ?? []
    const hit = rows.find((row) => row.sessionId === sessionId)
    if (hit?.title !== undefined && hit.title !== '') return hit.title
    return shortSessionId(sessionId)
  }

  /** 取活会话对象：标题与 preset 都从这里读；服务缺失或查不到就给 undefined。 */
  function liveSessionOf(sessionId: string): any {
    const sessions = optionalService(ctx, 'sessions')
    if (sessions === undefined || typeof sessions?.get !== 'function') return undefined
    try {
      const live = sessions.get(sessionId)
      return live === undefined || live === null ? undefined : live
    } catch { return undefined }
  }

  /** 运行中清单里还缺标题的会话：读一次标题快照，读到了就重发这一屏。 */
  function ensureTitlesFor(sessionIds: string[]): void {
    if (sessionIds.length === 0) return
    const query = optionalService(ctx, 'sessionQuery')
    if (query === undefined || typeof query?.readTitleSnapshots !== 'function') return
    const now = Date.now()
    const missing = sessionIds.filter((sessionId) => {
      const fetched = titleFetchAt.get(sessionId)
      if (fetched !== undefined && now - fetched < 60_000) return false
      const cached = titleCache.get(sessionId)
      return cached === undefined || now - cached.at > 60_000
    })
    if (missing.length === 0) return
    for (const sessionId of missing) titleFetchAt.set(sessionId, now)
    void Promise.resolve().then(async () => {
      const snapshots = await query.readTitleSnapshots(missing)
      const at = Date.now()
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        const sessionId = String(snapshot?.session?.id ?? '')
        const raw = snapshot?.title
        const title = typeof raw === 'string' ? raw : typeof raw?.title === 'string' ? raw.title : ''
        if (sessionId !== '' && title !== '') titleCache.set(sessionId, { at, title })
      }
      refreshRunningLists()
    }).catch((error) => { log('tihu running titles failed: ' + String((error as Error)?.message ?? error)) })
  }

  /**
   * 主页帧的「最近回答」必须在每条重发路径上都在（钉住补发 / 气泡刷新 / 运行清单重发）：
   * 存底帧没带 recent 时按现成回复补一条（2026-11-08 实机：主页帧被陈旧底帧重发时就少了这一行）。
   */
  function homeFrameWithRecent(frame: ScreenFramePayload, sessionId: string): ScreenFramePayload {
    if (frame.home === undefined || frame.home.recent !== undefined) return frame
    const owner = recentReplyOwnerOf(sessionId)
    if (owner === undefined) return frame
    return { ...frame, home: { ...frame.home, recent: { sessionId: owner.sessionId, title: humanTitle(titleForSession(owner.sessionId)), at: owner.at } } }
  }

  /**
   * 帧附加信息（一处注入，所有发送路径都生效）：
   *   - 回复屏：底部三个按钮（停止 / 重读 / 主页）；
   *   - 状态屏：底部列出**其他**正在运行的会话，点了切过去（用户 2026-11-08 要求）；
   *   - 主页屏：不加按钮/运行清单，但「最近回答」这一行要由 homeFrameWithRecent 保证在。
   */

  function withFrameExtras(frame: ScreenFramePayload, sessionId: string | undefined): ScreenFramePayload {
    if (sessionId === undefined) return frame
    if (frame.mode === 'reply') {
      if (frame.actions !== undefined) return frame
      const running = frame.running
      const { running: _drop, ...rest } = frame
      void running
      return { ...rest, actions: replyActionsFor(sessionId) }
    }
    if (frame.mode === 'home') return homeFrameWithRecent(frame, sessionId)
    // 只列 Computer Use 模式的会话（用户 2026-11-08 要求）：模式以列表缓存里的 preset 为准，
    // 查不到定级的一律不列（宁可少列，也不把普通会话混进来）。
    const others = [...runningSessions.keys()]
      .filter((id) => id !== sessionId && isComputerUseSession(id))
      .slice(0, 3)
    if (others.length === 0) return frame
    const listed = others.map((id) => ({ sessionId: id, title: titleForSession(id) }))
    // 还在显示短 id 的那些先去读标题快照，读到了 refreshRunningLists 会重发这屏
    ensureTitlesFor(others.filter((id) => listed.find((item) => item.sessionId === id)?.title === shortSessionId(id)))
    return { ...frame, running: listed }
  }

  /** 运行中会话增减时，重发每台设备当前那屏，让底部清单实时跟着变。 */
  function refreshRunningLists(): void {
    for (const device of devices) {
      const id = device.sessionId
      if (id === undefined) continue
      const last = lastFrames.get(id)
      if (last === undefined) continue
      if (last.mode === 'home' || last.mode === 'reply') continue
      sendFrame(device, last as ScreenFramePayload, id)
    }
  }

  function screen(sessionId: string, frame: Omit<ScreenFramePayload, 'bullets'> & { bullets?: string[] }): void {
    // 主页钉住：会话帧不覆盖主页屏（气泡轨照常在主页帧上刷新）。否则点完主页又会被
    // 正在收尾的朗读帧/状态帧拉回会话页（用户 2026-11-08 实测）。
    if (homePinned.has(sessionId)) {
      if (frame.mode === 'home') {
        pinnedHomeFrames.set(sessionId, frame as ScreenFramePayload)
        pinnedPendingSig.set(sessionId, pendingSigOf(sessionId))
      } else {
        const sig = pendingSigOf(sessionId)
        if (pinnedPendingSig.get(sessionId) !== sig) {
          const pinned = pinnedHomeFrameOf(sessionId)
          if (pinned !== undefined) broadcast(sessionId, 'screen.frame', withFrameExtras(pinned, sessionId))
          pinnedPendingSig.set(sessionId, sig)
        }
        return
      }
    }
    lastFrames.set(sessionId, frame)
    // 待读气泡必须跟着**每一帧**下发：页面收到帧会整体重画气泡轨，
    // 旧实现只有 reply/主页帧带 pending，思考帧一来就把气泡擦掉了
    //（2026-11-07 用户实测：别的 CU 会话完成了，鹈鹕屏上看不到通知）。
    const pend = pendingByDisplay.get(sessionId) ?? []
    const pending = frame.pending ?? pend.slice(0, 4).map((item) => ({ sessionId: item.sessionId, title: item.title, at: item.at, unread: true as const }))
    const pendingCount = frame.pendingCount ?? pend.length
    broadcast(sessionId, 'screen.frame', withFrameExtras({
      stage: frame.stage,
      title: frame.title,
      bullets: frame.bullets ?? [],
      ...(frame.progress === undefined ? {} : { progress: frame.progress }),
      ...(frame.mode === undefined ? {} : { mode: frame.mode }),
      ...(frame.statsTail === undefined ? {} : { statsTail: frame.statsTail }),
      ...(frame.reply === undefined ? {} : { reply: frame.reply }),
      ...(frame.home === undefined ? {} : { home: frame.home }),
      pending,
      pendingCount,
      tone: frame.tone ?? 'idle',
    } satisfies ScreenFramePayload, sessionId))
  }

  /* ---------- 会话列表（页面自建选择器；复用宿主的 sessionQuery） ----------
   *
   * 2026-11-07 P0：公网 origin 的 localStorage 里没有 `dsh.sessions.current`
   * （按 origin 隔离），页面因此报「还没有会话」。这里给页面一条**自己选会话**的
   * 路：复用骨架里已有的会话列表服务 `ctx.sessionQuery`（手机端会话列表同源），
   * 不新造一套会话索引；拿不到这个服务时退回 `ctx.sessions.list()` 的在线会话。
   */

  /** 列表缓存：hello 校验与选择器查询共用，60 秒内不重复列（避免每次开页都全量扫）。 */
  let sessionListCache: { at: number; rows: TihuSessionRow[]; source: 'sessionQuery' | 'live' } | undefined
  /**
   * 给单台设备发屏帧：必须自己补上待读气泡。
   *
   * 页面收到任何 screen.frame 都会重画气泡轨（payload.pending 缺失 = 空数组 = 擦掉），
   * 所以绕过 screen() 的直发帧会「悄悄吃掉」别的会话完成通知（2026-11-07 审计 P1-7）。
   */
  function sendFrame(device: TihuDevice, frame: ScreenFramePayload, sessionId: string | undefined = device.sessionId): void {
    // 主页钉住：bind/思考/确认等直发帧也不能把屏从主页拉走（气泡轨照常刷新）。
    if (sessionId !== undefined && homePinned.has(sessionId) && frame.mode !== 'home') {
      const sig = pendingSigOf(sessionId)
      if (pinnedPendingSig.get(sessionId) !== sig) {
        const pinned = pinnedHomeFrameOf(sessionId)
        if (pinned !== undefined) device.send('screen.frame', withFrameExtras(pinned, sessionId))
        pinnedPendingSig.set(sessionId, sig)
      }
      return
    }
    // 记一份「这台设备最后看到的那屏」：运行中清单变化时按它重发（followRunningTurn 跟过来的会话还没有广播帧时也要有基准）。
    if (sessionId !== undefined && frame.mode !== 'reply') {
      lastFrames.set(sessionId, { ...frame, bullets: frame.bullets ?? [] })
    }
    const pend = sessionId === undefined ? [] : pendingByDisplay.get(sessionId) ?? []
    device.send('screen.frame', withFrameExtras({
      ...frame,
      ...(frame.pending === undefined
        ? { pending: pend.slice(0, 4).map((item) => ({ sessionId: item.sessionId, title: item.title, at: item.at, unread: true as const })) }
        : {}),
      ...(frame.pendingCount === undefined ? { pendingCount: pend.length } : {}),
    } satisfies ScreenFramePayload, sessionId))
  }

  const SESSION_LIST_TTL_MS = 60_000
  /** 标题缓存：readTitleSnapshots 要读日志，同一会话 60 秒内只读一次。 */
  const titleCache = new Map<string, { at: number; title: string }>()

  /**
   * 从**投影缓存**里读一行的投影值：与手机端会话列表同一个数据源
   * （`sessionProjections` / `sessionProjectionCache`），不读会话日志，几百条也是毫秒级。
   *
   * 关键：`agentPreset` 投影的 `init` 就是 `session.header.agentPreset ?? null`，
   * 之后由 `agent-preset/selected` 事件更新——所以它比 header 更能代表**当前**模式
   * （宿主 dsh-agent-preset-registry 的注释也写明「读投影，不读 header」）。
   */
  function projectionValuesOf(source: any): Record<string, unknown> {
    try {
      const projections = optionalService(ctx, 'sessionProjections')
      if (projections !== undefined && typeof projections?.cachedSnapshot === 'function') {
        const block = projections.cachedSnapshot(source)
        if (block !== undefined && block !== null && typeof block.values === 'object' && block.values !== null) return block.values
      }
    } catch { /* 投影不可用：下面再试缓存服务 */ }
    try {
      const cache = optionalService(ctx, 'sessionProjectionCache')
      if (cache !== undefined && typeof cache?.cachedSnapshot === 'function') {
        const block = cache.cachedSnapshot(source?.header ?? source)
        if (block !== undefined && block !== null && typeof block.values === 'object' && block.values !== null) return block.values
      }
    } catch { /* 同上 */ }
    return {}
  }

  /** 会话名（投影 `title`）。 */
  function titleOf(source: any): string {
    const value = projectionValuesOf(source).title
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object' && typeof value.title === 'string') return value.title
    return ''
  }

  /** 会话的 agent preset：投影 `agentPreset` 优先，缺省回退 `session.header.agentPreset`。 */
  function presetOf(source: any): string {
    const projected = projectionValuesOf(source).agentPreset
    if (typeof projected === 'string' && projected !== '') return projected
    const header = source?.header ?? source
    return typeof header?.agentPreset === 'string' ? header.agentPreset : ''
  }

  /** 只有 Computer Use 模式才允许出现在可语音操作的选择器里。 */
  function isComputerUsePreset(preset: string): boolean {
    return preset === TIHU_COMPUTER_USE_PRESET
  }

  /**
   * 活跃时间（毫秒）：与宿主/桌面会话列表同一个口径
   * `updatedAt = max(header.createdAt, 投影 sessionListMetadata.lastPromptAt)`。
   * 也就是「最后一次用户发言时间」——自动绑定取它最大的一条 CU 会话。
   */
  function activityOf(source: any): number {
    const header = source?.header ?? source
    const createdAt = Number.isFinite(header?.createdAt) ? Number(header.createdAt) : 0
    const metadata = projectionValuesOf(source).sessionListMetadata
    const lastPromptAt = metadata !== null && typeof metadata === 'object' && Number.isFinite((metadata as any).lastPromptAt)
      ? Number((metadata as any).lastPromptAt)
      : 0
    return Math.max(createdAt, lastPromptAt)
  }

  /** 宿主内存里的会话（至少桌面/手机正开着的那些）。 */
  function liveSessionRows(): TihuSessionRow[] {
    const sessions = optionalService(ctx, 'sessions')
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    if (!Array.isArray(list)) return []
    const rows: TihuSessionRow[] = []
    for (const session of list) {
      const sessionId = sessionIdOf(session)
      if (sessionId === undefined) continue
      rows.push({
        sessionId,
        title: titleOf(session),
        preset: presetOf(session),
        updatedAt: activityOf(session),
        ...(typeof session?.header?.cwd === 'string' ? { cwd: session.header.cwd } : {}),
        ...(Number.isFinite(session?.header?.createdAt) ? { createdAt: Number(session.header.createdAt) } : {}),
        live: true,
      })
    }
    return rows
  }

  /** 排序：**活跃时间倒序**（自动绑定取第一条 CU）；同一时间在线优先，最后用 id 兜底稳定。 */
  function sortSessionRows(rows: TihuSessionRow[]): TihuSessionRow[] {
    return rows.sort((a, b) => {
      const byActivity = (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
      if (byActivity !== 0) return byActivity
      if (a.live !== b.live) return a.live ? -1 : 1
      return a.sessionId.localeCompare(b.sessionId)
    })
  }

  /** 拉完整会话列表（带 60 秒缓存；`force` 用于「页面连上时重新判定」）。 */
  async function collectSessionRows(force = false): Promise<{ rows: TihuSessionRow[]; source: 'sessionQuery' | 'live' }> {
    const now = Date.now()
    if (!force && sessionListCache !== undefined && now - sessionListCache.at < SESSION_LIST_TTL_MS) {
      return { rows: sessionListCache.rows, source: sessionListCache.source }
    }
    const live = liveSessionRows()
    const query = optionalService(ctx, 'sessionQuery')
    if (query !== undefined && typeof query?.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        const rows: TihuSessionRow[] = []
        const seen = new Set<string>()
        for (const record of Array.isArray(records) ? records : []) {
          const sessionId = String(record?.header?.id ?? '')
          if (sessionId === '' || seen.has(sessionId)) continue
          seen.add(sessionId)
          rows.push({
            sessionId,
            title: titleOf(record?.header),
            preset: presetOf(record?.header),
            updatedAt: activityOf(record?.header),
            ...(typeof record?.header?.cwd === 'string' ? { cwd: record.header.cwd } : {}),
            ...(Number.isFinite(record?.header?.createdAt) ? { createdAt: Number(record.header.createdAt) } : {}),
            live: record?.live === true,
          })
        }
        // 新建但还没进持久化列表的空会话也要能选。
        for (const row of live) if (!seen.has(row.sessionId)) rows.push(row)
        sessionListCache = { at: now, rows: sortSessionRows(rows), source: 'sessionQuery' }
        return { rows: sessionListCache.rows, source: 'sessionQuery' }
      } catch (error) {
        log(`tihu sessions query failed: ${(error as Error)?.message ?? String(error)}`)
      }
    }
    sessionListCache = { at: now, rows: sortSessionRows(live), source: 'live' }
    return { rows: sessionListCache.rows, source: 'live' }
  }

  /** 给前 N 条补会话名；失败/超时就算了，页面会退回短 id。 */
  async function attachTitles(rows: TihuSessionRow[]): Promise<TihuSessionRow[]> {
    if (rows.length === 0) return rows
    const query = optionalService(ctx, 'sessionQuery')
    if (query === undefined || typeof query?.readTitleSnapshots !== 'function') return rows
    const now = Date.now()
    const missing = rows.filter((row) => {
      if (row.title !== '') return false   // 投影缓存已经给出标题，不必再读日志
      const cached = titleCache.get(row.sessionId)
      return cached === undefined || now - cached.at > 60_000
    })
    if (missing.length > 0) {
      try {
        const snapshots = await query.readTitleSnapshots(missing.map((row) => row.sessionId))
        for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
          const sessionId = String(snapshot?.session?.id ?? '')
          const raw = snapshot?.title
          const title = typeof raw === 'string' ? raw : typeof raw?.title === 'string' ? raw.title : ''
          if (sessionId !== '' && title !== '') titleCache.set(sessionId, { at: now, title })
        }
      } catch (error) {
        log(`tihu session titles failed: ${(error as Error)?.message ?? String(error)}`)
      }
    }
    return rows.map((row) => {
      const cached = titleCache.get(row.sessionId)
      return cached === undefined ? row : { ...row, title: cached.title }
    })
  }

  /** 回答一条 sessions.query：最近 N 条 **Computer Use** 会话 + 总条数 + checkId 核对结果。 */
  async function listSessionChoices(limit: number, checkId?: string): Promise<SessionsListPayload> {
    let collected: { rows: TihuSessionRow[]; source: 'sessionQuery' | 'live' }
    try {
      collected = await collectSessionRows()
    } catch (error) {
      log(`tihu sessions list failed: ${(error as Error)?.message ?? String(error)}`)
      collected = { rows: liveSessionRows(), source: 'live' }
    }
    const all = collected.rows
    const cuRows = all.filter((row) => isComputerUsePreset(row.preset)).sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
    const total = all.length
    const cuTotal = cuRows.length
    const checkRow = checkId === undefined ? undefined : all.find((row) => row.sessionId === checkId)
    const check = checkId === undefined
      ? undefined
      : {
          sessionId: checkId,
          found: checkRow !== undefined,
          ...(checkRow === undefined ? {} : { preset: checkRow.preset, computerUse: isComputerUsePreset(checkRow.preset) }),
        }
    const top = cuRows.slice(0, limit)
    // 标题要读会话日志：给个 3 秒上限，慢会话不至于把选择器卡死（拿不到就显示短 id）。
    const titled = await Promise.race([
      attachTitles(top),
      new Promise<TihuSessionRow[]>((resolve) => { setTimeout(() => resolve(top), 3000) }),
    ])
    return {
      sessions: titled.map((row) => ({
        sessionId: row.sessionId,
        title: row.title,
        preset: row.preset,
        computerUse: true,
        updatedAt: row.updatedAt,
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
        live: row.live,
      })),
      total,
      cuTotal,
      ...(cuRows[0] === undefined ? {} : { activeSessionId: cuRows[0].sessionId }),
      ...(check === undefined ? {} : { check }),
      source: collected.source,
    } satisfies SessionsListPayload
  }

  /** 当前最活跃的 Computer Use 会话（自动绑定目标）：按 updatedAt 取最大，不依赖数组顺序。 */
  async function activeComputerUseRow(force = false): Promise<TihuSessionRow | undefined> {
    let collected: { rows: TihuSessionRow[]; source: 'sessionQuery' | 'live' }
    try { collected = await collectSessionRows(force) } catch { return undefined }
    let best: TihuSessionRow | undefined
    for (const row of collected.rows) {
      if (!isComputerUsePreset(row.preset)) continue
      if (best === undefined || row.updatedAt > best.updatedAt) best = row
    }
    return best
  }

  /** 查一个会话：live / persisted / missing / unknown，并带回它的 title + preset。 */
  async function findSession(sessionId: string): Promise<{ status: 'live' | 'persisted' | 'missing' | 'unknown'; row?: TihuSessionRow }> {
    const sessions = optionalService(ctx, 'sessions')
    if (sessions !== undefined && typeof sessions?.get === 'function') {
      let live: any
      try { live = sessions.get(sessionId) } catch { live = undefined }
      if (live !== undefined && live !== null) {
        return {
          status: 'live',
          row: {
            sessionId: sessionIdOf(live) ?? sessionId,
            title: titleOf(live),
            preset: presetOf(live),
            updatedAt: activityOf(live),
            live: true,
            ...(typeof live?.header?.cwd === 'string' ? { cwd: live.header.cwd } : {}),
            ...(Number.isFinite(live?.header?.createdAt) ? { createdAt: Number(live.header.createdAt) } : {}),
          },
        }
      }
    }
    // 页面选择器给的 id 一定在刚拉过的列表里：**哪怕缓存过期也直接用**，不要为了
    // 校验一次而重新列 1870 条会话——那会让「点一条会话」等好几秒才有反馈。
    const cachedRow = sessionListCache?.rows.find((item) => item.sessionId === sessionId)
    if (cachedRow !== undefined) return { status: cachedRow.live ? 'live' : 'persisted', row: cachedRow }
    let collected: { rows: TihuSessionRow[]; source: 'sessionQuery' | 'live' }
    try { collected = await collectSessionRows() } catch { return { status: 'unknown' } }
    // 只有 sessionQuery 才能代表「全部逻辑会话」；退回 live 列表时不能据此判不存在。
    if (collected.source !== 'sessionQuery') return { status: 'unknown' }
    const row = collected.rows.find((item) => item.sessionId === sessionId)
    return row === undefined ? { status: 'missing' } : { status: row.live ? 'live' : 'persisted', row }
  }

  /** 绑定会话：非法 id 给可读提示并让页面退回选择器；非 CU 允许绑定但必须醒目告警。 */
  async function bindSession(
    device: TihuDevice,
    sessionId: string,
    options: { auto?: boolean; followed?: boolean } = {},
  ): Promise<void> {
    // 换会话先把上一轮的朗读掐掉（屏已经不显示它了，声音不能继续跟过来）。
    const previousSessionId = device.sessionId
    if (previousSessionId !== undefined && previousSessionId !== sessionId) {
      try { device.cancelRound?.() } catch { /* 忽略 */ }
      // 换绑定解除上一会话的主页钉住（用户 2026-11-08 规则：钉住不是永久的）。
      unpinHome(previousSessionId)
      browsingHistory.delete(previousSessionId)
    }
    // 目标会话也要解除钉住（用户主动换过来了，就该正常显示它的屏）；同会话补绑（页面重连）保留钉住。
    if (previousSessionId !== sessionId) {
      unpinHome(sessionId)
      browsingHistory.delete(sessionId)
    }
    const found = await findSession(sessionId)
    if (found.status === 'missing') {
      device.sessionId = undefined
      device.send('session.invalid', {
        sessionId,
        reason: `会话 ${shortSessionId(sessionId)} 不存在（可能已归档或删除），请在下面的会话列表里重新选一个`,
        showPicker: true,
      } satisfies SessionInvalidPayload)
      device.send('event.alert', { level: 'warn', text: `会话 ${shortSessionId(sessionId)} 不存在：请从下面的会话列表里选一个` })
      sendFrame(device, {
        stage: '选择会话',
        title: '还没有选定会话',
        bullets: [`会话 ${shortSessionId(sessionId)} 不存在`, '点下面的会话列表选一个'],
        tone: 'alert',
      } satisfies ScreenFramePayload, sessionId)
      log(`tihu bind rejected session=${sessionId} reason=missing`)
      return
    }
    device.sessionId = sessionId
    const row = found.row
    let rawTitle = row?.title ?? titleCache.get(sessionId)?.title ?? ''
    let title = rawTitle === '' ? '' : humanTitle(rawTitle)
    if (title === '' && found.status !== 'unknown') {
      // 标题要读会话日志：单独给 1.5 秒上限（URL 直接带会话时列表还没拉过）。
      const base: TihuSessionRow = { sessionId, title: '', preset: row?.preset ?? '', updatedAt: row?.updatedAt ?? 0, live: found.status === 'live' }
      const [titled] = await Promise.race([
        attachTitles([base]),
        new Promise<TihuSessionRow[]>((resolve) => { setTimeout(() => resolve([base]), 1500) }),
      ])
      title = titled?.title ? humanTitle(titled.title) : ''
    }
    const preset = row?.preset ?? ''
    const computerUse = isComputerUsePreset(preset)
    const live = found.status === 'live' || row?.live === true
    device.send('session.bound', {
      sessionId,
      title,
      project: projectNameOf(row?.cwd),
      live,
      preset,
      computerUse,
      ...(options.auto === true ? { auto: true } : {}),
      ...(options.followed === true ? { followed: true } : {}),
    } satisfies SessionBoundPayload)
    if (computerUse) {
      sendFrame(device, {
        stage: options.followed === true ? '跟随' : '会话',
        title: options.followed === true
          ? `已自动跟随到：${title}`
          : `已绑定：${projectNameOf(row?.cwd)}`,
        bullets: [
          `会话：${title}`,
          live ? '桌面正开着这个会话' : '还没在桌面打开（注入前先打开它）',
        ],
        tone: 'idle',
      } satisfies ScreenFramePayload, sessionId)
    } else {
      // 要求 4：允许绑定（?session= 显式指定时不静默改写用户意图），但必须显著提示。
      device.send('event.alert', {
        level: 'error',
        text: `这条会话不是 Computer Use 模式（preset=${preset || '未知'}）：无法看屏/点按，请换一个 Computer Use 会话`,
      })
      sendFrame(device, {
        stage: '非 Computer Use',
        title: '这条不是 Computer Use 模式',
        bullets: ['无法看屏/点按', '请换一个 Computer Use 会话'],
        tone: 'alert',
      } satisfies ScreenFramePayload, sessionId)
    }
    // 2026-11-08 实测缺陷：只有 hello/turn 事件会排「回主页」定时器，任何一次重新绑定
    //（页面重连后补发 session.bind、自动跟随、气泡切屏）都会停在「已绑定」信息屏上永不回主页。
    // 绑定成功就排一次空闲回主页：有人跑 turn / 还在朗读时，守门会自己推迟。
    const bindHome = homeStates.get(sessionId) ?? { mode: 'session' as const, page: 0, done: true }
    bindHome.mode = 'session'
    bindHome.done = true
    homeStates.set(sessionId, bindHome)
    scheduleHome(sessionId)
    // 用户 2026-11-08 要求：绑定后「已绑定」提示屏停一下（默认 3s）就回主页，不必等空闲计时。
    // 正在跑 turn、正在朗读、屏上已经是回复时不动，免得把正在看的内容切走。
    setTimeout(() => {
      if (disposed) return
      if (device.sessionId !== sessionId) return
      if (runningSessions.has(sessionId) || readingBusy(sessionId)) return
      if (lastFrames.get(sessionId)?.mode === 'reply') return
      if (homeStates.get(sessionId)?.mode === 'home') return
      void sendHome(sessionId, device).catch((error) => log(`tihu bind home failed: ${(error as Error)?.message ?? String(error)}`))
    }, bindHomeDelayMs())

    log(`tihu bind session=${sessionId} status=${found.status} preset=${JSON.stringify(preset)} cu=${String(computerUse)} title=${JSON.stringify(title)}`)
  }

  /**
   * 自动模式：绑定「当前最活跃的 Computer Use 会话」。
   *
   * 活跃 = 宿主会话列表的 `updatedAt = max(header.createdAt,
   * sessionListMetadata.lastPromptAt)`，也就是最后一次用户发言时间。
   * `reason='inject'` 时如果目标变了，会明确下发「已自动跟随到：…」。
   * 非 CU 会话永远不参与自动绑定（列表只筛 CU）。
   */
  async function autoBindActive(device: TihuDevice, reason: 'hello' | 'inject'): Promise<void> {
    // 页面连上 → 重新列一次（可能刚在桌面新建了 CU 会话）；
    // 注入前 → 先用缓存（事件里会把活跃时间刷到最新），超过 15 秒才重新列，避免每次说话都等全量列表。
    const stale = sessionListCache === undefined || Date.now() - sessionListCache.at > 15_000
    const active = await activeComputerUseRow(reason === 'hello' || stale)
    if (active === undefined) {
      device.sessionId = undefined
      if (reason === 'hello') {
        device.send('event.alert', { level: 'warn', text: '没有可自动绑定的 Computer Use 会话，已显示控制室主页' })
        await sendHome('__unbound__', device)
      }
      log(`tihu auto bind: no computer-use session (${reason})`)
      return
    }
    const changed = device.sessionId !== active.sessionId
    await bindSession(device, active.sessionId, { auto: true, followed: reason === 'inject' && changed })
    if (reason === 'inject' && changed) {
      device.send('event.progress', {
        stage: '跟随',
        text: `已自动跟随到：${active.title || shortSessionId(active.sessionId)}`,
      } satisfies ProgressPayload)
      log(`tihu auto follow session=${active.sessionId}`)
    }
    log(`tihu auto bind reason=${reason} session=${active.sessionId} changed=${String(changed)}`)
  }

  /** 构造 reply 模式屏帧：长回复只带当前句 ±2 句窗口，避免每帧全量传长文本。 */
  function replyScreen(sessionId: string, sentences: ReplySentence[], currentIndex: number, charPos: number, includeAll: boolean): ScreenFramePayload {
    const pending = pendingByDisplay.get(sessionId) ?? []
    const widthPx = pending.length > 0 ? 240 : CONTENT_WIDTH_PX
    let state = screenStates.get(sessionId)
    if (state === undefined || state.sentences !== sentences || state.widthPx !== widthPx) {
      const lines: { text: string; sentenceIndex: number }[] = []
      for (const sentence of sentences) {
        for (const line of wrapTextPx(sentence.text, widthPx, SCREEN_SPEC.bodyFontPx)) {
          lines.push({ text: line, sentenceIndex: sentence.index })
        }
      }
      const offset = state?.offset ?? 0
      state = { lines, offset, follow: state?.follow ?? true, sentences, currentIndex, charPos, widthPx }
      screenStates.set(sessionId, state)
    }
    state.currentIndex = currentIndex
    state.charPos = charPos
    const visibleLines = SCREEN_SPEC.replyVisibleLines
    const maxOffset = Math.max(0, state.lines.length - visibleLines)
    state.offset = Math.max(0, Math.min(state.offset, maxOffset))
    const list = includeAll ? sentences : replyWindow(sentences, currentIndex)
    const totalChars = sentences.length > 0 ? sentences[sentences.length - 1].end : 0
    return {
      stage: '回答中',
      title: '',
      bullets: [],
      tone: 'ok',
      mode: 'reply',
      reply: {
        sentences: list.map((sentence) => ({ index: sentence.index, start: sentence.start, end: sentence.end, text: sentence.text })),
        currentIndex,
        total: sentences.length,
        totalChars,
        charPos,
        lines: state.lines.slice(state.offset, state.offset + visibleLines),
        scroll: { offset: state.offset, maxOffset },
        follow: state.follow,
      },
      pending: pending.slice(0, 4).map((item) => ({ sessionId: item.sessionId, title: item.title, at: item.at, unread: true as const })),
      pendingCount: pending.length,
    }
  }

  function sendReply(sessionId: string, sentences: ReplySentence[], currentIndex: number, charPos: number, includeAll: boolean): void {
    screen(sessionId, replyScreen(sessionId, sentences, currentIndex, charPos, includeAll))
  }

  /** 把已到达的思考文本写进「思考」活动行（文本没变时 applyEarlyThinking 不出帧）。 */
  function flushLiveThinking(sessionId: string): void {
    const buffer = liveThinking.get(sessionId)
    if (buffer === undefined || buffer.text === '') return
    const state = progressStates.get(sessionId)
    if (state === undefined) return
    const narrow = (pendingByDisplay.get(sessionId)?.length ?? 0) > 0
    const update = applyEarlyThinking(state, buffer.text, Date.now(), narrow ? PENDING_RAIL_WIDTH_PX : CONTENT_WIDTH_PX)
    if (update?.screen !== undefined) screen(sessionId, update.screen)
  }

  /** 节流：一个会话同时只挂一个 flush 定时器。 */
  function scheduleLiveThinking(sessionId: string): void {
    if (thinkingTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      thinkingTimers.delete(sessionId)
      try {
        flushLiveThinking(sessionId)
      } catch (error) {
        log(`tihu thinking flush failed: ${(error as Error)?.message ?? String(error)}`)
      }
    }, tihuThinkingFlushMs())
    timer.unref?.()
    thinkingTimers.set(sessionId, timer)
  }

  /** 收尾：清掉该会话的缓冲与定时器；flush=true 时把最后一段先写进屏（attempt 结束）。 */
  function stopLiveThinking(sessionId: string, flush: boolean): void {
    const timer = thinkingTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      thinkingTimers.delete(sessionId)
    }
    if (flush) flushLiveThinking(sessionId)
    liveThinking.delete(sessionId)
  }

  /**
   * 控制室可见卡片（真实真源）：profile 目录下的 dsh-assistant-state.json 的 projects。
   * 隐藏卡在 hidden、删除卡在 removed，workspace 表里都还留着行——所以只信这份状态。
   * 可用 TIHU_PROJECTS_STATE 覆盖文件路径（测试/排障用）。
   */
  let cardCache: { mtimeMs: number; cards: TihuCardRow[] } | undefined
  function projectCards(): TihuCardRow[] | undefined {
    let file = process.env.TIHU_PROJECTS_STATE ?? ''
    if (file === '') {
      let dir = ''
      try {
        const profile = optionalService(ctx, 'profileContext')
        if (typeof profile?.dir === 'string' && profile.dir !== '') dir = profile.dir
      } catch { /* 忽略 */ }
      if (dir === '') {
        try {
          const homePaths = optionalService(ctx, 'homePaths')
          if (typeof homePaths?.home === 'string' && homePaths.home !== '') dir = homePaths.home
        } catch { /* 忽略 */ }
      }
      if (dir === '') dir = process.env.DSH_HOME ?? process.cwd()
      file = join(dir, 'dsh-assistant-state.json')
    }
    try {
      const info = statSync(file)
      if (cardCache !== undefined && cardCache.mtimeMs === info.mtimeMs) return cardCache.cards
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const cards = cardsFromState(parsed)
      cardCache = { mtimeMs: info.mtimeMs, cards }
      return cards
    } catch {
      return undefined
    }
  }

  /**
   * 首页项目的真源：DSH 宿主 workspace 服务
（@deepseek-ai/dsh-workspace 的
   * Service 名 "workspaceRegistry"，落盘就是 ~/.dsh/storages/workspace.json 的
   * tables.workspaces）。实体字段都是 getter：id / path / title / createdAt /
   * updatedAt（ISO 字符串）/ sessionIds（数组，顺序即显示顺序）。
   *
   * 返回 undefined 表示「宿主服务拿不到」或「list() 抛错」，调用方退回旧的 cwd 分组。
   */
  function workspaceRegistryRows(): TihuWorkspaceRow[] | undefined {
    const registry = optionalService(ctx, 'workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return undefined
    let listed: unknown
    try { listed = registry.list() } catch (error) {
      log(`tihu workspaceRegistry.list failed: ${(error as Error)?.message ?? String(error)}`)
      return undefined
    }
    if (!Array.isArray(listed)) return undefined
    const items: TihuWorkspaceRow[] = []
    for (const entry of listed) {
      try {
        const path = typeof entry?.path === 'string' ? entry.path : ''
        const title = typeof entry?.title === 'string' ? entry.title : ''
        if (path === '' && title === '') continue
        const rawUpdatedAt = entry?.updatedAt
        const parsed = typeof rawUpdatedAt === 'string' ? Date.parse(rawUpdatedAt) : Number(rawUpdatedAt)
        const sessionIds = Array.isArray(entry?.sessionIds) ? entry.sessionIds.map((id: unknown) => String(id)) : []
        items.push({
          id: typeof entry?.id === 'string' ? entry.id : '',
          path,
          title,
          sessionIds,
          updatedAt: Number.isFinite(parsed) ? parsed : 0,
        })
      } catch (error) {
        // 宿主实体是 getter：某一条（已 dispose/半删除）抛错不能把整个主页拖死（审计 P1-11）。
        log(`tihu workspace entry skipped: ${(error as Error)?.message ?? String(error)}`)
      }
    }
    return items
  }

  /** 该会话回答历史里的最新一条（与 lastReplies 互为兜底）。 */
  function latestReplyEntry(sessionId: string): ReplyHistoryEntry | undefined {
    const list = replyHistory.get(sessionId)
    if (list === undefined || list.length === 0) return undefined
    return list[list.length - 1]
  }

  /** 这条会话是不是真的存着回复（lastReplies 或回答历史任一到）。 */
  function hasStoredReply(sessionId: string): boolean {
    return lastReplies.get(sessionId) !== undefined || latestReplyEntry(sessionId) !== undefined
  }

  /** 朗读/重读要用的那条回复：lastReplies 优先，退回该会话回答历史最新一条。 */
  function replyPayloadOf(sessionId: string): { sentences: ReplySentence[]; speechSegments: SpeechSegment[]; includeAll: boolean } | undefined {
    const reply = lastReplies.get(sessionId)
    if (reply !== undefined) return reply
    const entry = latestReplyEntry(sessionId)
    if (entry === undefined) return undefined
    return { sentences: entry.sentences, speechSegments: entry.speechSegments, includeAll: entry.includeAll }
  }

  /**
   * 首页「最近回答」该指到哪条会话（2026-11-08 实机缺陷）。
   *
   * 以前只查「绑到这台设备的会话」的 lastReplies：实机上设备常被自动跟随 / 项目卡 / 气泡切屏换到
   * 另一条会话（那边可能一条回复都还没有），或那条回答只有 replyHistory（符号回复没有可念的语音），
   * 于是朗读中点主页就没有这一行。三级兜底：
   *   1. 绑定会话的 lastReplies；
   *   2. 该会话 replyHistory 最后一条；
   *   3. 整条 lane 里最近一条有回复的会话（按 lastAssistant / replyHistory 时间排）。
   */
  function recentReplyOwnerOf(sessionId: string, device?: TihuDevice): { sessionId: string; at: number } | undefined {
    const candidates: string[] = []
    const bound = device?.sessionId
    if (bound !== undefined && bound !== '') candidates.push(bound)
    if (sessionId !== '' && !candidates.includes(sessionId)) candidates.push(sessionId)
    for (const candidate of candidates) {
      if (lastReplies.get(candidate) !== undefined) {
        return { sessionId: candidate, at: lastAssistant.get(candidate)?.at ?? Date.now() }
      }
      const entry = latestReplyEntry(candidate)
      if (entry !== undefined) return { sessionId: candidate, at: entry.at }
    }
    let best: { sessionId: string; at: number } | undefined
    for (const [candidate, list] of replyHistory) {
      const entry = list[list.length - 1]
      if (entry === undefined) continue
      if (best === undefined || entry.at > best.at) best = { sessionId: candidate, at: entry.at }
    }
    for (const [candidate, reply] of lastAssistant) {
      if (!hasStoredReply(candidate)) continue
      const at = Number.isFinite(reply.at) ? reply.at : 0
      if (best === undefined || at > best.at) best = { sessionId: candidate, at }
    }
    return best
  }

  /** 主页屏：项目清单优先取宿主 workspace 注册表，取不到才用会话快照按 cwd 分组兜底。 */
  async function sendHome(sessionId: string, device?: TihuDevice): Promise<void> {
    // 已经回主页：浏览状态结束（下次进回复屏重新算）。
    browsingHistory.delete(sessionId)
    let rows: TihuSessionRow[] = []
    try { rows = (await collectSessionRows()).rows } catch { rows = [] }
    const projectRows = rows.map((row) => ({ sessionId: row.sessionId, title: row.title, cwd: row.cwd, updatedAt: row.updatedAt, live: row.live }))
    const replies: Record<string, ProjectReply | undefined> = {}
    for (const row of projectRows) replies[row.sessionId] = lastAssistant.get(row.sessionId)
    const workspaces = workspaceRegistryRows()
    // 注册表可用：项目名/顺序来自 workspace（状态按该项目 sessionIds 对应的会话算，不再按 cwd 猜归属）；
    // 拿不到（命令行测试环境没有宿主服务）：完全保持旧的 cwd 分组行为。
    const cards = projectCards()
    // 记下这一帧用的卡片清单：巡检据此判断控制室里是不是真的变了（隐藏/删除/改名/排序/新增）。
    shownCardSignature = projectCardsSignature(cards)
    const projects = (() => {
      if (workspaces === undefined) return groupProjects(projectRows, replies, Date.now())
      try {
        // 控制室卡片是权威：每张可见卡一行；拿不到状态文件才退回按 workspace 列表
        if (cards !== undefined) return groupCardProjects(cards, workspaces, projectRows, replies, Date.now())
        return groupWorkspaceProjects(workspaces, projectRows, replies, Date.now())
      } catch (error) {
        // 聚合层再兜一层：主页是「兜底屏」，绝不能因为注册表数据异常而发不出帧。
        log(`tihu home aggregate failed: ${(error as Error)?.stack ?? String(error)}`)
        return groupProjects(projectRows, replies, Date.now())
      }
    })()
    const pageSize = 5
    const totalPages = Math.max(1, Math.ceil(projects.length / pageSize))
    const state = homeStates.get(sessionId) ?? { mode: 'session' as const, page: 0, done: false }
    state.page = Math.max(0, Math.min(state.page, totalPages - 1))
    state.mode = 'home'
    homeStates.set(sessionId, state)
    const pageProjects = projects.slice(state.page * pageSize, (state.page + 1) * pageSize).map((project) => ({
      name: project.name,
      status: project.status,
      summary: project.summary,
      ...(project.enterSessionId !== undefined ? { sessionId: project.enterSessionId } : {}),
    }))
    // 首页顶部「最近回答 · 会话名」：绑定会话查不到就按三级兜底找（recentReplyOwnerOf）。
    const boundOwner = device?.sessionId ?? sessionId
    const owner = recentReplyOwnerOf(sessionId, device)
    const recent = owner === undefined
      ? undefined
      : { sessionId: owner.sessionId, title: humanTitle(titleForSession(owner.sessionId)), at: owner.at }
    log(`tihu home recent session=${sessionId} owner=${owner?.sessionId ?? '-'} hasLastReply=${String(lastReplies.get(boundOwner) !== undefined)} history=${String(replyHistory.get(boundOwner)?.length ?? 0)}`)
    const frame: ScreenFramePayload = {
      stage: '控制室',
      title: '',
      bullets: [],
      tone: 'ok',
      mode: 'home',
      home: {
        projects: pageProjects,
        page: { index: state.page, total: totalPages },
        total: projects.length,
        ...(recent === undefined ? {} : { recent }),
      },
      pending: (pendingByDisplay.get(sessionId) ?? []).slice(0, 4).map((item) => ({ sessionId: item.sessionId, title: item.title, at: item.at, unread: true as const })),
      pendingCount: (pendingByDisplay.get(sessionId) ?? []).length,
    }
    // 钉住期间它就是「屏上那帧」的底子：后续会话帧只用它刷气泡，不替换内容。
    if (homePinned.has(sessionId)) {
      pinnedHomeFrames.set(sessionId, frame)
      pinnedPendingSig.set(sessionId, pendingSigOf(sessionId))
    }
    // 这一帧也要当「设备最后看到的那屏」：气泡刷新与运行清单重发都以它为基准，
    // 否则陈旧的状态/回复帧会在重发时把主页（含最近回答）替换掉（2026-11-08 实机）。
    lastFrames.set(sessionId, frame)
    if (device !== undefined) device.send('screen.frame', withFrameExtras(frame, sessionId))
    else screen(sessionId, frame)
  }

  /**
   * 记下「最近一条回复」（正文 + 分句 + 语音片段）。
   *
   * 与是否绑定设备无关：没绑设备时也要记，否则气泡点开只有空白、主页摘要也缺正文
   *（2026-11-07 审计 P1-8）。
   */
  function rememberReply(sessionId: string, data: any): boolean {
    const blocks = Array.isArray(data?.message?.content) ? data.message.content : []
    const text = stripToolNoise(blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b?.text ?? '')).join('\n')).trim()
    if (text === '') return false
    const sentences = splitReplySentences(text)
    if (sentences.length === 0) return false
    const speechSegments = splitSpeechSegments(text)
      .map((segment) => ({ ...segment, text: toSpeechText(segment.text) }))
      .filter((segment) => segment.text !== '')
    pushReplyHistory(sessionId, text, sentences, speechSegments, [...text].length <= 2000)
    return true
  }

  function enqueuePending(completedSessionId: string): void {
    // 只给 Computer Use 模式的会话冒「新回复」泡（2026-11-08 用户要求）：标准/语音会话的
    // 新回复不上右侧未读轨。预设未知时按非 CU 处理。
    if (!isComputerUsePreset(sessionPresets.get(completedSessionId) ?? '')) return
    const title = sessionListCache?.rows.find((row) => row.sessionId === completedSessionId)?.title || shortSessionId(completedSessionId)
    const displays = new Set<string>()
    for (const device of devices) {
      if (device.sessionId !== undefined && device.sessionId !== completedSessionId) displays.add(device.sessionId)
    }
    for (const display of displays) {
      const list = pendingByDisplay.get(display) ?? []
      const existing = list.find((item) => item.sessionId === completedSessionId)
      if (existing !== undefined) existing.at = Date.now()
      else list.push({ sessionId: completedSessionId, title, at: Date.now() })
      list.sort((a, b) => a.at - b.at)
      pendingByDisplay.set(display, list)
      // 立即推一帧带气泡的屏帧；不触碰音频/朗读。
      const state = screenStates.get(display)
      const last = lastFrames.get(display)
      // 屏正停在主页（钉住或已回主页）：气泡只能刷在主页帧上，既不能把用户拽回旧回复屏，
      // 也不能把主页换成陈旧状态帧（2026-11-08 实机：那样 home.recent 就跟着没了）。
      const showsHome = homePinned.has(display) || last?.mode === 'home' || homeStates.get(display)?.mode === 'home'
      if (!showsHome && state !== undefined) {
        sendReply(display, state.sentences, state.currentIndex, state.charPos, true)
      } else if (last !== undefined) {
        // 基准帧自带的气泡不能留：重发前按当前待读清单重挂（screen 自己会补 pending/pendingCount）。
        const { pending: _dropPending, pendingCount: _dropPendingCount, ...rest } = last
        screen(display, rest)
      } else if (state !== undefined) {
        sendReply(display, state.sentences, state.currentIndex, state.charPos, true)
      }
    }
  }

  function cancelHomeTimer(sessionId: string): void {
    const state = homeStates.get(sessionId)
    if (state?.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** 主页钉住：点主页时置上；新的 turn/start、换绑定、点项目卡、点最近回答时解除。 */
  function pinHome(sessionId: string): void {
    homePinned.add(sessionId)
    browsingHistory.delete(sessionId)
    cancelHomeTimer(sessionId)
    const state = homeStates.get(sessionId)
    if (state !== undefined) state.mode = 'home'
  }

  function unpinHome(sessionId: string | undefined): void {
    if (sessionId === undefined || sessionId === '') return
    homePinned.delete(sessionId)
    pinnedHomeFrames.delete(sessionId)
    pinnedPendingSig.delete(sessionId)
  }

  /** 气泡轨签名：会话 id + 入队时间（内容一样就不用重发主页帧）。 */
  function pendingSigOf(sessionId: string): string {
    return (pendingByDisplay.get(sessionId) ?? []).map((item) => item.sessionId + '@' + item.at).join(',')
  }

  /** 钉住期间代替会话帧发出去的主页帧：只换气泡轨，屏不离开主页。 */
  function pinnedHomeFrameOf(sessionId: string): ScreenFramePayload | undefined {
    const last = lastFrames.get(sessionId)
    const base = pinnedHomeFrames.get(sessionId)
      ?? (last !== undefined && last.mode === 'home' ? (last as ScreenFramePayload) : undefined)
    if (base === undefined) return undefined
    const pend = pendingByDisplay.get(sessionId) ?? []
    return {
      ...base,
      pending: pend.slice(0, 4).map((item) => ({ sessionId: item.sessionId, title: item.title, at: item.at, unread: true as const })),
      pendingCount: pend.length,
    }
  }

  /** 回答历史：最新在末尾；同一段正文重复到达只替换末尾那条，不重复入栈。 */
  function pushReplyHistory(sessionId: string, text: string, sentences: ReplySentence[], speechSegments: SpeechSegment[], includeAll: boolean): void {
    // 新回复到达：屏要回到最新一条，浏览状态结束（自动回主页计时随后照旧）。
    browsingHistory.delete(sessionId)
    const list = replyHistory.get(sessionId) ?? []
    const entry: ReplyHistoryEntry = { text, sentences, speechSegments, includeAll, at: Date.now() }
    const last = list[list.length - 1]
    if (last !== undefined && last.text === text) list[list.length - 1] = entry
    else list.push(entry)
    if (list.length > REPLY_HISTORY_LIMIT) list.splice(0, list.length - REPLY_HISTORY_LIMIT)
    replyHistory.set(sessionId, list)
    // 只有确实有可念的语音时才记朗读载荷；符号/空白回复没有语音，但回答历史照记（主页「最近
    // 回答」与上一条/下一条都要认它，重读时只换屏不出声）。
    if (speechSegments.length > 0) lastReplies.set(sessionId, { sentences, speechSegments, includeAll })
    lastAssistant.set(sessionId, { text, at: entry.at })
    replyBrowseIndex.set(sessionId, list.length - 1)
  }

  /** 把浏览位置拨回最新一条（点气泡 / 重读 / 换会话时屏上就是最新回复）。 */
  function browseLatest(sessionId: string): void {
    const list = replyHistory.get(sessionId)
    replyBrowseIndex.set(sessionId, Math.max(0, (list?.length ?? 1) - 1))
    browsingHistory.delete(sessionId)
  }

  /** 当前浏览到历史第几条（没有历史 -1；缺省=最新一条）。 */
  function browseIndexOf(sessionId: string): number {
    const list = replyHistory.get(sessionId) ?? []
    if (list.length === 0) return -1
    const stored = replyBrowseIndex.get(sessionId)
    const index = stored === undefined ? list.length - 1 : stored
    return Math.max(0, Math.min(index, list.length - 1))
  }

  /**
   * 回复屏按钮：原三个（停止/重读/主页）恒在；只有确实还有上一条/下一条才追加，
   * 别把原按钮挤掉（屏宽 304px，页面按按钮数量收小字号）。
   */
  function replyActionsFor(sessionId: string): { id: string; label: string }[] {
    const list = replyHistory.get(sessionId) ?? []
    const index = browseIndexOf(sessionId)
    const actions: { id: string; label: string }[] = REPLY_ACTIONS.map((item) => ({ id: item.id, label: item.label }))
    if (index > 0) actions.push({ id: 'prev', label: '上一条' })
    if (index >= 0 && index < list.length - 1) actions.push({ id: 'next', label: '下一条' })
    return actions
  }

  /**
   * 上一条/下一条：只换屏，不自动朗读（要朗读点「重读」）。
   *
   * 浏览期间暂停 10 秒自动回主页：用户显式点主页/项目卡才回主页（用户 2026-11-08 要求）。
   * 翻页时把正在念的那一轮静默掐掉：屏已经翻到别的回答，声音不能继续念上一条。
   */
  function browseReplyHistory(device: TihuDevice, sessionId: string, step: -1 | 1): void {
    const list = replyHistory.get(sessionId) ?? []
    const current = browseIndexOf(sessionId)
    const target = current < 0 ? -1 : current + step
    if (target < 0 || target >= list.length) return
    try { device.cancelRound?.() } catch { /* 忽略 */ }
    unpinHome(sessionId)
    browsingHistory.add(sessionId)
    replyBrowseIndex.set(sessionId, target)
    screenStates.delete(sessionId)
    for (const item of devices) if (item.sessionId === sessionId) followByDevice.set(item.id, true)
    cancelHomeTimer(sessionId)
    const home = homeStates.get(sessionId) ?? { mode: 'session' as const, page: 0, done: false }
    home.mode = 'session'
    home.done = false
    homeStates.set(sessionId, home)
    const entry = list[target]
    sendReply(sessionId, entry.sentences, 0, 0, entry.includeAll)
    log(`tihu reply browse session=${sessionId} ${target + 1}/${list.length}`)
  }

  /** 朗读开始（多设备同会话会并发调用，按计数累加）。 */
  function speakingStart(sessionId: string): void {
    const state = readingStates.get(sessionId) ?? { speaking: 0, until: 0 }
    state.speaking += 1
    readingStates.set(sessionId, state)
    cancelHomeTimer(sessionId)
  }
  /** 播放时间轴推进：把投影的播完时刻往前推（只增不减）。 */
  function speakingProgress(sessionId: string, until: number): void {
    const state = readingStates.get(sessionId)
    if (state === undefined) return
    state.until = Math.max(state.until, until)
  }
  /** 朗读结束：留到最后一块音频真正播完（含少量余量）才算不忙。 */
  function speakingStop(sessionId: string, until: number): void {
    const state = readingStates.get(sessionId)
    if (state === undefined) return
    state.speaking = Math.max(0, state.speaking - 1)
    state.until = Math.max(state.until, until)
    if (state.speaking === 0 && state.until <= Date.now()) readingStates.delete(sessionId)
  }
  /** 还有音频在播/队列没播完 → 不能回主页。 */
  function readingBusy(sessionId: string): boolean {
    const state = readingStates.get(sessionId)
    if (state === undefined) return false
    if (state.speaking > 0) return true
    if (state.until > Date.now()) return true
    readingStates.delete(sessionId)
    return false
  }

  /**
   * 自愈：把「turn/start 之后永远没有 turn/end」的会话从运行跟踪里摘掉，并把该会话
   * 标成已完成，否则回主页守门（全局 runningSessions）会被一条僵尸条目永久挡住。
   */
  function pruneStaleTurns(): void {
    const stale = tihuTurnStaleMs()
    const now = Date.now()
    for (const [sessionId, startedAt] of runningSessions) {
      if (now - startedAt < stale) continue
      runningSessions.delete(sessionId)
      const state = homeStates.get(sessionId)
      if (state !== undefined && state.mode === 'session') state.done = true
    }
  }

  function scheduleHome(sessionId: string): void {
    if (disposed) return
    pruneStaleTurns()
    const state = homeStates.get(sessionId)
    if (state === undefined || !state.done) return
    cancelHomeTimer(sessionId)
    const delay = Number(process.env.TIHU_HOME_AFTER_MS ?? 10_000)
    state.timer = setTimeout(() => {
      if (disposed) return
      const current = homeStates.get(sessionId)
      if (current === undefined || !current.done) return
      // 已经在主页：手势重排的那一次不要再补发一张（避免重复 home 帧）。
      if (current.mode === 'home') return
      // 翻历史浏览期间暂停自动回主页：只有用户显式点主页/项目卡才回（用户 2026-11-08 要求）。
      // 结束浏览后下一次巡检会重新走一遍，仍然回主页，不会永久卡住。
      if (browsingHistory.has(sessionId)) {
        current.timer = setTimeout(() => scheduleHome(sessionId), tihuHomeRecheckMs())
        return
      }
      // 浏览状态按设备算：一台在看历史只挡它自己，不能把同会话的另一台也按住
      //（2026-11-07 审计 P1-9：旧实现用会话级 follow，两台设备互相卡死）。
      const bound = [...devices].filter((device) => device.sessionId === sessionId)
      const idle = bound.filter((device) => followByDevice.get(device.id) !== false)
      if (bound.length > 0 && idle.length === 0) {
        current.timer = setTimeout(() => scheduleHome(sessionId), tihuHomeRecheckMs())
        return
      }
      // 守门：只要还有任何会话的 turn 在跑，就不回主页——屏幕必须显示运行中的会话详情。
      // 按 TIHU_HOME_RECHECK_MS 再查一次；turn/end 会清掉 runningSessions，重试自然收敛。
      // 朗读也同理：音频还在播/待播队列非空就还不算「空闲」，否则长回复读到一半就跳主页，
      // 后面的 reply 屏帧到期又把屏切回来（用户实测的「跳主页又自己跳回来」）。
      if (runningSessions.size > 0 || readingBusy(sessionId)) {
        current.timer = setTimeout(() => scheduleHome(sessionId), tihuHomeRecheckMs())
        return
      }
      if (bound.length === 0) {
        void sendHome(sessionId).catch((error) => log(`tihu home failed: ${(error as Error)?.message ?? String(error)}`))
        return
      }
      for (const device of idle) {
        void sendHome(sessionId, device).catch((error) => log(`tihu home failed: ${(error as Error)?.message ?? String(error)}`))
      }
    }, Number.isFinite(delay) ? delay : 10_000)
  }
  async function speakLocally(device: TihuDevice, sessionId: string, sentences: ReplySentence[], speechSegments: SpeechSegment[], includeAll: boolean): Promise<void> {
    if (speechSegments.length === 0) return
    /**
     * 新的一轮开始前，先把这台设备上还在跑的那一轮掐掉（同一会话连续两条 assistant/message
     * 是真实会发生的：每个 settled 的 step 都是一条）。不掐的话两轮并读、页面收到两遍 index。
     */
    const roundKey = `${device.id}|${sessionId}`
    const roundToken = (speakRounds.get(roundKey) ?? 0) + 1
    speakRounds.set(roundKey, roundToken)
    const isCurrentRound = (): boolean => speakRounds.get(roundKey) === roundToken
    const previousCancel = device.cancelRound
    if (previousCancel !== undefined) {
      log(`tihu tts cancel previous round device=${device.id} session=${sessionId}`)
      try { previousCancel() } catch { /* 忽略：旧轮自己的清理逻辑不该影响新一轮 */ }
    }
    // 默认走 edge 云健，不必为每句唤醒 GPU；只有克隆音色或仅离线才需要本地 Qwen。
    if ((device.voice && device.voice !== 'default') || device.offlineOnly) await tts.ensureServer()
    const status = tts.status()
    if (!status.available) {
      device.send('event.alert', { level: 'error', text: `本次无语音：在线兜底不可用且本地引擎未就绪（原因：${status.error ?? '未安装模型'}）` })
      setTimeout(() => scheduleHome(sessionId), 50)
      return
    }
    const voice = device.voice || 'default'
    if (tts.deviceFallback() !== '') {
      device.send('event.alert', { level: 'warn', text: tts.deviceFallback() })
    }
    device.send('event.progress', { stage: 'tts', text: tts.engineLabel(voice) } satisfies ProgressPayload)
    /**
     * 预取流水线（2026-11-07 二修：治「读了几句没声音了」）。
     *
     * 实测（本机 edge-tts zh-CN-YunjianNeural rate +45%，8 段干净样本）：
     *   单段合成 1.87–2.53s（均值 2.21s）；首块 1.55–2.31s ≈ 合成总耗时的 86%
     *   （edge 几乎不流式：首块一到基本就是整段）；单段音频 1.56–2.71s（均值 2.07s）；
     *   限流抖动时单段能到 6.1s（≈ 2 段音频）。
     * 旧实现三个问题叠在一起：
     *   ① 预取只有 2 段（≈4s 余量），一次抖动就抽干 → 静音；
     *   ② 启动段号用 `index + inFlight.size` 推算：后启动的段先完成时会**把同一段
     *      再合成一遍**（实测 12 段被合成 30 次），并发额度全烧在重复合成上；
     *   ③ 任意一段失败就整轮终止（首块 3.5s 门限一到就杀进程），后半段永远不念。
     * 现在：启动游标单调递增（每段只合成一次）；按「已有着落的音频余量」补位，
     * 默认最多 4 段并发、目标提前量 12s（TIHU_SYNTH_MAX_INFLIGHT / TIHU_SYNTH_AHEAD_MS 可调）；
     * 单段失败重试一次，仍失败就跳过这一句并**红告警**，后面的照常念。
     * 合成本身并发，但 tts.audio 永远按句 index 顺序下发，首块到达即起播（首屏不等人）。
     */
    const maxInflight = clampInt(Number(process.env.TIHU_SYNTH_MAX_INFLIGHT ?? 4), 2, 8)
    const aheadTargetMs = clampInt(Number(process.env.TIHU_SYNTH_AHEAD_MS ?? 12_000), 3_000, 30_000)
    const errorText = (value: unknown): string => (value as Error)?.message ?? String(value)
    type SynthResult = { ok: true; audioMs: number } | { ok: false; error: unknown }
    /**
     * 播放时间轴（2026-11-07 修「高亮文字与语音不同步」）：
     * 高亮/滚动/屏帧必须在**音频真正开始播放**的时刻推进，而不是合成完成时刻。
     * 预取把「合成完成」提前到「音频还没播到」之前（最多一整句），旧实现照合成
     * 完成推进 → 正文窗口/滚动跑到语音前面，播放中的那一句被卷出可视区、高亮消失。
     * 这里用首块到达时刻 + 累计 audioMs 复刻页面 playPcm 的排程：
     *   startAt[i] = max(首块到达, startAt[i-1] + audioMs[i-1])
     */
    const playbackEndAt = { value: 0 }
    const frameAt = (at: number, fn: () => void): Promise<void> =>
      scheduleFrameAt(at, fn, (error) => log(`tihu frame failed: ${(error as Error)?.stack ?? String(error)}`))
    /**
     * 音频乱序防护：合成本身并发，但 **tts.audio 必须按句 index 顺序下发**
     * （客户端把 PCM 直接排在 AudioContext 时间轴上，跨句乱序会撞音）。
     * 每句一个缓冲区：正在播的句（flushIndex）实时流式下发；提前合成好的句
     * 先攒着，轮到它时一次放完——预取省掉的是**等待合成**的时间，不是发送顺序。
     */
    const audioBuffers: TtsAudioPayload[][] = speechSegments.map(() => [])
    /** 已合成结束（成功或失败）的句：缓冲区排空后可以把 flushIndex 往前推。 */
    const flushed = new Set<number>()
    /** 整轮放弃后不再下发任何音频（否则后半段 PCM 还会冒出来，而屏已经停在别处）。 */
    let aborted = false
    /** 首段就失败（本轮彻底没有可念的内容）：停发，但**不是**用户/换绑取消，必须照常报错。 */
    let roundFailed = false
    /** 这一轮是否还作数：被掐掉（换绑/断开/被更新的一轮取代）才为真。 */
    const roundDead = (): boolean => aborted || !isCurrentRound()
    let flushIndex = 0
    const flushAudio = (): void => {
      if (roundDead() || roundFailed) {
        for (const queue of audioBuffers) queue.length = 0
        return
      }
      while (flushIndex < audioBuffers.length) {
        const queue = audioBuffers[flushIndex]
        for (const payload of queue.splice(0)) device.send('tts.audio', payload)
        if (flushed.has(flushIndex)) {
          flushIndex += 1
          continue
        }
        break
      }
    }
    /** 本轮的取消信号：被新的一轮/换绑/断开取代时一起 abort 在途合成。 */
    const roundAbort = new AbortController()
    /**
     * 段内停顿看门狗（2026-11-07 断音根因之三）。
     *
     * edge 几乎不流式（首块≈整段），所以「已经开始吐块、却 1.2s 没有下一块」= 这条流断了。
     * 旧实现只会干等，而 tts.audio 必须按句序 flush —— 卡住的那一段把后面已经合成好的段
     * 全压住，页面就在念完上一句后整轮静音（现场实测：单段卡 12s → 6.9s 静音缝）。
     * 现在：超时就用手上已有的音频收尾、丢弃这条流的剩余块，并把 flushIndex 往前推，
     * 同时在事件区说一句「第 k 句音频中断」，绝不悄悄静音。
     */
    const stallMs = clampInt(Number(process.env.TIHU_SYNTH_STALL_MS ?? 1_200), 500, 10_000)
    const stalled = new Set<number>()
    const stallTimers = new Map<number, ReturnType<typeof setTimeout>>()
    const pushedBytes: number[] = speechSegments.map(() => 0)
    /** results 在 try 里才存在，用这个钩子把「卡住即收尾」回填进去。 */
    const stalledHook = { onStall: (_index: number): void => {} }
    const clearStall = (index: number): void => {
      const timer = stallTimers.get(index)
      if (timer !== undefined) clearTimeout(timer)
      stallTimers.delete(index)
    }
    const armStall = (index: number): void => {
      clearStall(index)
      stallTimers.set(index, setTimeout(() => {
        stallTimers.delete(index)
        if (roundDead() || flushed.has(index)) return
        const audioMs = Math.round((pushedBytes[index] / 2 / 24000) * 1000)
        stalled.add(index)
        flushed.add(index)
        log(`tihu tts stall session=${sessionId} index=${index}/${speechSegments.length} audio=${audioMs}ms`)
        device.send('event.progress', {
          stage: 'tts',
          text: `第 ${index + 1}/${speechSegments.length} 句音频中断（已收 ${(audioMs / 1000).toFixed(1)}s），跳过剩余部分`,
        } satisfies ProgressPayload)
        stalledHook.onStall(index)
        flushAudio()
      }, stallMs))
    }
    const synthAttempt = (segment: SpeechSegment, segmentIndex: number, onFirstChunk: () => void): Promise<SynthResult> =>
      tts.synthesize(segment.text, {
        voice,
        sessionId,
        edgeVoice: device.edgeVoice,
        offlineOnly: device.offlineOnly,
        signal: roundAbort.signal,
        onChunk: (chunk) => {
          if (roundDead() || roundFailed) return
          // 这一段已经按「卡住」收尾：后来迟到的块必须丢掉，不能补进已翻过去的句序里。
          if (stalled.has(segmentIndex)) return
          onFirstChunk()
          pushedBytes[segmentIndex] += chunk.data.length
          armStall(segmentIndex)
          audioBuffers[segmentIndex].push({
            seq: chunk.seq,
            total: chunk.total,
            sampleRate: 24000,
            channels: 1,
            format: 'pcm16',
            data: chunk.data.toString('base64'),
            index: segment.index,
            text: segment.text,
            charStart: segment.start,
            charEnd: segment.end,
            ...(chunk.final ? { final: true } : {}),
          } satisfies TtsAudioPayload)
          flushAudio()
        },
      }).then(
        (result) => ({ ok: true, audioMs: Math.max(0, Number(result?.audioMs) || 0) } as SynthResult),
        (error) => ({ ok: false, error } as SynthResult),
      )

    speakingStart(sessionId)
    // 换绑/断开/被更新的一轮取代时要把这一轮掐掉：否则屏已经切到别的会话，旧会话的 PCM
    // 还在往同一台设备发（2026-11-07 审计 P1-10）；顺手 abort 在途合成，别让 edge 白跑。
    const cancelRound = (): void => {
      aborted = true
      try { roundAbort.abort() } catch { /* 忽略 */ }
    }
    device.cancelRound = cancelRound
    try {
      const results = new Array<SynthResult | undefined>(speechSegments.length).fill(undefined)
      const inFlight = new Set<Promise<void>>()
      let firstError: unknown = undefined
      // 防丢失唤醒：notify 先自增 generation；waiter 挂上前比对——
      // 若期间已经 notify 过，立即返回，不等。
      let generation = 0
      let waiter: (() => void) | undefined = undefined
      const notify = (): void => {
        generation += 1
        const w = waiter
        waiter = undefined
        w?.()
      }
      const waitForChange = (seen: number): Promise<void> => {
        if (generation !== seen) return Promise.resolve()
        return new Promise<void>((resolve) => { waiter = resolve })
      }

      /** 每段首块到达的墙钟时刻（页面就是从这一刻开始排它进音频时间轴）。 */
      const firstChunkAt: number[] = speechSegments.map(() => 0)
      /** 已合成段的实际音频时长（用于估「在途合成还能产出多少音频」）。 */
      const audioMsList: number[] = []
      /**
       * 卡住的那一段按「已收到的音频」收尾：让 pump 立刻往下走（屏帧/高亮跟上），
       * 而不是干等 12s 让整条句序停在那儿。
       */
      stalledHook.onStall = (index: number): void => {
        if (results[index] !== undefined) return
        results[index] = { ok: true, audioMs: Math.round((pushedBytes[index] / 2 / 24000) * 1000) }
        notify()
      }

      /** 合成一段；失败重试一次（只在这一段还没吐出过任何音频时才重试，避免重复发声）。 */
      const runSegment = async (index: number): Promise<SynthResult> => {
        const segment = speechSegments[index]
        let last: SynthResult = { ok: false, error: new Error('未开始合成') }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (roundDead()) break
          last = await synthAttempt(segment, index, () => {
            if (firstChunkAt[index] === 0) firstChunkAt[index] = Date.now()
            notify()
          })
          if (last.ok) break
          if (audioBuffers[index].length > 0) break
          if (attempt === 0) log(`tihu tts retry session=${sessionId} index=${index}: ${errorText(last.error)}`)
        }
        clearStall(index)
        // 这一段结束了（成功或最终失败）都要标记，flushIndex 才能继续往前推进。
        flushed.add(index)
        flushAudio()
        return last
      }

      const launch = (index: number): void => {
        const done = runSegment(index).then((result) => {
          results[index] = result
          if (result.ok) audioMsList.push(result.audioMs)
          inFlight.delete(done)
          notify()
        })
        inFlight.add(done)
      }

      /**
       * 补位策略：按「已有着落的音频」补，而不是固定并发数。
       * aheadMs = 已排程未播完 + 在途合成预计产出的时长；不到目标提前量就继续启动。
       * 启动游标 nextToLaunch 单调递增——这是修「重复合成」的关键（旧代码用
       * index + inFlight.size，段完成乱序时会重合成同一段）。
       */
      let nextToLaunch = 0
      const avgAudioMs = (): number =>
        audioMsList.length === 0 ? 2_500 : audioMsList.reduce((sum, ms) => sum + ms, 0) / audioMsList.length
      const aheadMs = (): number => Math.max(0, playbackEndAt.value - Date.now()) + inFlight.size * avgAudioMs()
      const fill = (): void => {
        while (nextToLaunch < speechSegments.length && inFlight.size < maxInflight) {
          if (inFlight.size > 0 && aheadMs() >= aheadTargetMs) break
          launch(nextToLaunch)
          nextToLaunch += 1
        }
      }

      // 按句顺序消费结果：合成本身并发，但**推进屏帧的时机**严格按播放时间轴——
      // 预取让合成远早于播放，若照合成完成推进，文字/高亮会跑到语音前面。
      const frames: Promise<void>[] = []
      /**
       * 头段等很久都没音频时（edge 抖动/重试），给用户一句人话进度，别让页面看起来像卡死。
       * 阈值 `TIHU_SYNTH_HEAD_WARN_MS`，默认 4s（正常首块 2.2–3.3s）。
       */
      const headWarnMs = clampInt(Number(process.env.TIHU_SYNTH_HEAD_WARN_MS ?? 4_000), 1_000, 60_000)
      const pump = (async () => {
        for (let index = 0; index < speechSegments.length; index += 1) {
          fill()
          const waitFrom = Date.now()
          let warnedWait = false
          while (results[index] === undefined && firstError === undefined) {
            if (roundDead()) break
            fill()
            if (!warnedWait && Date.now() - waitFrom >= headWarnMs) {
              warnedWait = true
              const seconds = Math.max(1, Math.round((Date.now() - waitFrom) / 1000))
              device.send('event.progress', {
                stage: 'tts',
                text: `第 ${index + 1}/${speechSegments.length} 句合成较慢，正在等音频（已 ${seconds}s）`,
              } satisfies ProgressPayload)
            }
            if (results[index] !== undefined || firstError !== undefined) break
            await waitForChange(generation)
          }
          // 这一轮被掐掉（换绑/断开/被更新的一轮取代）：立刻停手，不报错、不再发帧。
          if (roundDead()) break
          if (firstError !== undefined) break
          const result = results[index] as SynthResult
          if (!result.ok) {
            if (index === 0) {
              // 第一段就失败了：没有可念的内容，整轮按失败处理（沿用「本次无语音」告警）。
              roundFailed = true
              firstError = result.error
              break
            }
            // 中途某段重试后仍失败：跳过这一句继续往下念，并红告警（绝不静默停下）。
            log(`tihu tts skip session=${sessionId} index=${index}/${speechSegments.length}: ${errorText(result.error)}`)
            device.send('event.alert', {
              level: 'error',
              text: `第 ${index + 1}/${speechSegments.length} 段朗读失败，已跳过继续（原因：${errorText(result.error).slice(0, 60)}）`,
            })
            continue
          }
          const segment = speechSegments[index]
          // 音频真正开始播放的时刻：首块到达，或上一段播完（页面按 pcmNextTime 排队）。
          const startAt = Math.max(firstChunkAt[index] > 0 ? firstChunkAt[index] : Date.now(), playbackEndAt.value)
          playbackEndAt.value = startAt + result.audioMs
          speakingProgress(sessionId, playbackEndAt.value)
          // 屏帧/滚动/引擎提示都在播放时刻推进——与音频同一个基准（不再用合成完成）。
          frames.push(frameAt(startAt, () => {
            const scrollState = screenStates.get(sessionId)
            if (scrollState !== undefined && scrollState.follow) {
              const lineIndex = scrollState.lines.findIndex((line) => line.sentenceIndex === segment.sentenceIndex)
              if (lineIndex >= 0) {
                const maxOffset = Math.max(0, scrollState.lines.length - SCREEN_SPEC.replyVisibleLines)
                scrollState.offset = Math.max(0, Math.min(lineIndex - 2, maxOffset))
              }
            }
            sendReply(sessionId, sentences, segment.sentenceIndex, segment.start, includeAll)
            const engineNote = tts.takeEngineNote()
            if (engineNote.startsWith('在线兜底')) {
              device.send('event.progress', { stage: 'tts', text: engineNote } satisfies ProgressPayload)
            }
          }))
        }
      })()

      // 出错时：等已启动的合成跑完发完（音频顺序不能乱），再把第一处错误抛给现有 catch。
      await Promise.all([pump, ...inFlight])
      // 被更新的一轮取代：安静收场（新一轮已经在念了，这里再报错就是假告警）。
      if (!roundDead() && firstError !== undefined) throw firstError
      // 等所有屏帧按播放时刻发完，再等最后一段音频播完——否则屏会先跳「念完」/回主页。
      await Promise.all(frames)
      if (roundDead()) return
      const tailMs = playbackEndAt.value - Date.now()
      if (tailMs > 0) await new Promise<void>((resolve) => { setTimeout(resolve, tailMs) })
      // 念完停在最后一屏（最后一帧）。
      const last = sentences[sentences.length - 1]
      sendReply(sessionId, sentences, sentences.length - 1, last.end, includeAll)
      setTimeout(() => scheduleHome(sessionId), 50)
    } catch (error) {
      const message = errorText(error)
      log(`tihu tts failed session=${sessionId} voice=${voice}: ${message}`)
      if (!roundDead()) {
        device.send('event.alert', { level: 'error', text: `本次无语音：在线兜底不可用且本地引擎未就绪（原因：${message}）` })
      }
      setTimeout(() => scheduleHome(sessionId), 50)
    } finally {
      for (const index of stallTimers.keys()) clearStall(index)
      if (speakRounds.get(roundKey) === roundToken) speakRounds.delete(roundKey)
      if (device.cancelRound === cancelRound) device.cancelRound = undefined
      // 已经下发的音频还在播：这段时间算「朗读中」，回主页要等它播完。
      speakingStop(sessionId, playbackEndAt.value + SPEAK_TAIL_MARGIN_MS)
    }
  }

  /**
   * 语音转写：官方 speech 服务。
   *
   * 2026-11-06 修：`transcribe()` 的返回值是 **Transcript 对象**
   * （`{ text, audioSeconds, inferenceSeconds }`），不是字符串。旧实现直接
   * `String(result)`，于是每次语音注入的都是字面量 "[object Object]" —— 实测
   * （scripts/tihu-voice-e2e.mjs + 日志 `chars=15`）确认过。这里按官方入参形状
   * 传 `{ audio, language }`（同时保留 `audioBase64` 兼容旧服务），并把返回值
   * 归一化成纯文本。
   */
  async function transcribe(audioBase64: string): Promise<string> {
    const speech = optionalService(ctx, 'speechController')
    if (speech === undefined || typeof speech?.transcribe !== 'function') {
      throw new Error('本机语音转写不可用：宿主没有加载 speech 服务（voice-input / speech-to-text 插件）')
    }
    if (!looksLikeWavBase64(audioBase64)) throw new Error('音频不是 WAV（需要 16k 单声道 16bit）')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
    try {
      const audio = new Uint8Array(Buffer.from(audioBase64, 'base64'))
      const result: any = await speech.transcribe({ audio, language: 'auto', audioBase64 }, controller.signal)
      const text = typeof result === 'string'
        ? result
        : String(result?.text ?? result?.transcript ?? result?.result ?? '').trim()
      return text.trim()
    } finally {
      clearTimeout(timer)
    }
  }

  /** 把文本注入当前会话（与用户手打一条消息同一条入口）。 */
  function inject(sessionId: string, text: string): void {
    const agents = optionalService(ctx, 'agents')
    const agent = agents?.get?.(sessionId)
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
      throw new Error(`会话 ${sessionId.slice(0, 8)}… 当前没有活动 agent（先在手机上把这个会话打开）`)
    }
    const message = buildTihuUserMessage(text)
    // 窗口只在「这条消息开始的 turn」里有效：记下消息 id，执行工具时回查会话里
    // 最后一条 user 消息是不是它——用户后来自己打的字不算 tihu 链路。
    activeSessions.set(sessionId, { until: Date.now() + ACTIVE_WINDOW_MS, messageId: String(message.id) })
    agent.followup(message)
    log(`tihu inject session=${sessionId} chars=${text.length}`)
  }

  /** 页面「结束本次语音会话」：立刻解除闸门（不等 120 秒）。 */
  function endSession(sessionId: string): boolean {
    const existed = activeSessions.delete(sessionId)
    if (existed) log(`tihu session end session=${sessionId}`)
    return existed
  }

  /** 会话窗口是否还活着（顺手清掉过期的）。 */
  function windowOf(sessionId: string): TihuWindow | undefined {
    const window = activeSessions.get(sessionId)
    if (window === undefined) return undefined
    if (window.until < Date.now()) {
      activeSessions.delete(sessionId)
      return undefined
    }
    return window
  }

  /** 续期（每次 tihu 上行都算一次「tihu 消息」，窗口滑动）。 */
  function touchWindow(sessionId: string): void {
    const window = activeSessions.get(sessionId)
    if (window === undefined) return
    window.until = Date.now() + ACTIVE_WINDOW_MS
  }

  /**
   * 会话里**最后一条 user 消息**的 id。
   *
   * 用来判断「这次工具调用是不是 tihu 触发的」：是 → 受闸门约束；不是（用户后来
   * 自己打到会话里的）→ 一律放行，绝不能让语音用一次就把用户自己的操作卡住。
   * `deriveMessages()` 是宿主缓存过的增量投影，长会话也只是一次浅遍历。
   */
  function lastUserMessageId(session: any): string | undefined {
    try {
      const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : undefined
      if (!Array.isArray(messages)) return undefined
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (!message || message.role !== 'user') continue
        return typeof message.id === 'string' ? message.id : undefined
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /* ---------- 工具闸（快照 / 审计 / 危险确认） ---------- */

  /** 一次已经过闸的工具调用的现场，供 post-execute 收尾。 */
  const pendingCalls = new Map<string, {
    sessionId: string
    workspace: string
    action: TihuActionClass
    tool: string
    target?: string
    snapshotPath?: string
    snapshotRoot?: string
  }>()

  /**
   * 这次工具调用是否落在「tihu 语音链路」上。
   *
   * 判据（缺一不可）：
   *   1. 该会话有一个未过期的 tihu 窗口（120 秒内收到过 tihu 消息）；
   *   2. 会话里**最后一条 user 消息**就是 tihu 刚注入的那条 —— 用户自己后来打的字
   *      会让条件 2 立刻失败，所以用户自己的操作永远不受影响。
   *
   * 拿不到消息列表时退回「窗口有效」判定（宁紧勿松，但窗口只有 120 秒）。
   */
  function tihuTurnOf(exec: any): string | undefined {
    const sessionId = sessionIdOfAgent(exec?.agent)
    if (sessionId === undefined) return undefined
    const window = windowOf(sessionId)
    if (window === undefined) return undefined
    const last = lastUserMessageId(exec?.agent?.session)
    if (last === undefined) return sessionId
    return last === window.messageId ? sessionId : undefined
  }

  /** 本会话当前是否有设备在线（决定危险动作是「等确认」还是「立刻拒绝」）。 */
  function deviceOnlineFor(sessionId: string): boolean {
    for (const device of devices) {
      if (device.sessionId === sessionId) return true
    }
    return false
  }

  /** 工具参数：宿主用 `arguments`，旧快照/单测里用 `args`。 */
  function argsOf(exec: any): unknown {
    return exec?.arguments ?? exec?.args
  }

  function workspaceFor(sessionId: string, agent: any): string {
    const fromOption = options.workspaceOf?.(sessionId)
    if (typeof fromOption === 'string' && fromOption !== '') return fromOption
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  }

  const disposePre = ctx.on?.('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    // 2026-11-07 审计 P0：next() 调用过之后抛错必须原样抛——旧实现在 catch 里再调一次 next()，
    // 等于把工具跑两遍（命令/写文件都会双执行）。闸内出错且工具还没跑时：危险动作 fail-closed
    // 拒绝，只读/不碰文件的仍按宿主默认策略放行。
    let dispatched = false
    let dangerousAction = false
    const runNext = async (): Promise<any> => { dispatched = true; return await next() }
    try {
      const sessionId = tihuTurnOf(exec)
      if (sessionId === undefined) return await runNext()
      const tool = String(exec?.name ?? '')
      const workspace = workspaceFor(sessionId, exec?.agent)
      const args = argsOf(exec)
      const rawTarget = targetPathOf(args)
      const command = commandOf(args)
      const target = rawTarget !== undefined ? rawTarget : command
      const exists = rawTarget !== undefined ? existsSyncSafe(workspace, rawTarget) : undefined
      // 关键：shell 类按**命令本身**判只读，不再按工具名一刀切（P0 事故根因）。
      const action = classifyTool(tool, exists, command)
      dangerousAction = action.dangerous

      // 不碰文件的只读工具（读、搜索、只读 shell…）不拦、不审计，避免把日志刷满。
      if (!action.touchesFiles && !action.dangerous) return await runNext()

      let snapshotPath: string | undefined
      let snapshotRoot: string | undefined
      if (action.touchesFiles && rawTarget !== undefined) {
        const snapshot = takeSnapshot(workspace, rawTarget, timestampSlug())
        snapshotPath = snapshot.snapshotPath
        snapshotRoot = snapshot.snapshotRoot
        if (snapshot.copied) {
          screen(sessionId, {
            stage: '动手',
            title: `${action.label}前已备份`,
            bullets: [snapshot.relativePath ?? '', `快照目录 .tihu/snapshots/${timestampSlug().slice(0, 15)}…`],
            tone: 'busy',
          })
          log(`tihu snapshot ${snapshot.relativePath} -> ${snapshot.snapshotPath}`)
        }
      }

      if (action.dangerous) {
        const detail = action.kind === 'shell'
          ? String(command ?? '').slice(0, 300)
          : String(rawTarget ?? target ?? '')
        // 设备不在线：立刻拒绝（旧实现要等 60 秒超时，把一次吐字拖成一条失败命令）。
        if (!deviceOnlineFor(sessionId)) {
          appendAudit(workspace, {
            ts: new Date().toISOString(),
            source: 'tihu',
            sessionId,
            action: action.kind,
            tool,
            ...(detail === '' ? {} : { target: detail }),
            ...(snapshotRoot === undefined ? {} : { snapshot: snapshotRoot }),
            decision: 'offline',
            note: '设备不在线，危险动作直接拒绝（不等待）',
          })
          return { kind: 'deny', reason: 'tihu: 设备不在线，危险动作默认取消' }
        }
        const answer = await (confirmBroker as any).ask({
          title: `${action.label}：需要你确认`,
          detail,
          timeoutMs: CONFIRM_TIMEOUT_MS,
          risk: action.kind === 'send' ? 'medium' : 'high',
          sessionId,
        })
        const approved = answer.outcome === 'approved'
        appendAudit(workspace, {
          ts: new Date().toISOString(),
          source: 'tihu',
          sessionId,
          action: action.kind,
          tool,
          ...(detail === '' ? {} : { target: detail }),
          ...(snapshotRoot === undefined ? {} : { snapshot: snapshotRoot }),
          decision: approved ? `confirm-${answer.outcome}` : answer.outcome,
          note: approved ? '设备确认通过' : '未获确认，已拒绝执行',
        })
        if (!approved) {
          const reason = answer.outcome === 'timeout'
            ? 'tihu: 危险动作确认超时，按取消处理'
            : answer.outcome === 'offline'
              ? 'tihu: 设备不在线，危险动作默认取消'
              : 'tihu: 用户在设备上取消了这次操作'
          screen(sessionId, { stage: '已取消', title: action.label, bullets: ['危险动作未执行'], tone: 'alert' })
          return { kind: 'deny', reason }
        }
        screen(sessionId, { stage: '动手', title: `${action.label}：已确认`, bullets: [String(detail).slice(0, 20)], tone: 'busy' })
      } else {
        appendAudit(workspace, {
          ts: new Date().toISOString(),
          source: 'tihu',
          sessionId,
          action: action.kind,
          tool,
          ...(rawTarget === undefined ? {} : { target: rawTarget }),
          ...(snapshotRoot === undefined ? {} : { snapshot: snapshotRoot }),
          decision: 'allow',
          note: snapshotPath === undefined ? '新文件或无文件目标' : '已快照',
        })
      }

      if (typeof exec?.callId === 'string') {
        pendingCalls.set(exec.callId, { sessionId, workspace, action, tool, target: rawTarget, snapshotPath, snapshotRoot })
      }
      return await runNext()
    } catch (error) {
      log(`tihu pre-execute failed: ${(error as Error)?.stack ?? String(error)}`)
      // 工具已经跑过：原样抛，绝不重跑。
      if (dispatched) throw error
      // 还没跑：危险动作 fail-closed（确认器自己坏掉时也绝不静默放行）。
      if (dangerousAction) return { kind: 'deny', reason: 'tihu: 闸内部出错，危险动作默认不执行' }
      return await runNext()
    }
  })

  const disposePost = ctx.on?.('tools/post-execute', async (exec: any, result: any, next: () => Promise<any>) => {
    try {
      const callId = typeof exec?.callId === 'string' ? exec.callId : undefined
      const pending = callId !== undefined ? pendingCalls.get(callId) : undefined
      if (pending !== undefined) {
        pendingCalls.delete(callId as string)
        const failed = result?.kind === 'failure' || result?.ok === false || result?.error !== undefined
        let diff: { added: number; removed: number } | undefined
        if (pending.snapshotPath !== undefined && pending.target !== undefined) {
          const before = readTextOrEmpty(pending.snapshotPath)
          const after = readTextOrEmpty(joinSafe(pending.workspace, pending.target))
          const summary = diffSummary(before, after)
          diff = { added: summary.added, removed: summary.removed }
          if (!failed) {
            screen(pending.sessionId, {
              stage: '动手',
              title: `${pending.action.label}完成`,
              bullets: [pending.target, summary.summary],
              tone: 'ok',
            })
          }
          broadcast(pending.sessionId, 'event.progress', {
            stage: 'diff',
            text: `${pending.target} ${summary.summary}`,
            done: diff.added,
          } satisfies ProgressPayload)
        }
        appendAudit(pending.workspace, {
          ts: new Date().toISOString(),
          source: 'tihu',
          sessionId: pending.sessionId,
          action: pending.action.kind,
          tool: pending.tool,
          ...(pending.target === undefined ? {} : { target: pending.target }),
          ...(pending.snapshotRoot === undefined ? {} : { snapshot: pending.snapshotRoot }),
          decision: 'executed',
          result: failed ? 'failed' : 'executed',
          ...(diff === undefined ? {} : { diff }),
        })
      }
    } catch (error) {
      log(`tihu post-execute failed: ${(error as Error)?.stack ?? String(error)}`)
    }
    return await next()
  })

  /* ---------- 会话事件 → 屏 ---------- */

  /**
   * turn/start 自动跟随：任何 CU 会话的 turn 一开始，「空闲且没有自己 turn 在跑」
   * 的设备自动跟随到这个会话——屏幕必须显示正在运行的会话详情。
   * 已绑定到该会话的设备不动；用户正在浏览历史（follow===false 且就是当前
   * 会话）的设备也不动，不打扰。
   * 放在设备早退**之外**：事件对应的会话可能没有任何设备绑定，但别的设备仍要跟过去。
   */
  function followRunningTurn(sessionId: string): void {
    for (const device of devices) {
      if (device.sessionId === undefined) continue
      if (device.sessionId === sessionId) continue
      if (runningSessions.has(device.sessionId)) continue
      const scroll = screenStates.get(device.sessionId)
      if (scroll !== undefined && !scroll.follow) continue
      void bindSession(device, sessionId, { auto: true, followed: true }).then(() => {
        device.send('event.progress', {
          stage: '跟随',
          text: `已自动跟随到：${titleForSession(sessionId)}`,
        } satisfies ProgressPayload)
      }).catch((error) => log(`tihu turn/start follow failed: ${(error as Error)?.message ?? String(error)}`))
    }
  }

  const disposeSession = ctx.on?.('session/event', (session: any, event: any) => {
    try {
      const sessionId = sessionIdOf(session)
      if (sessionId === undefined) return
      // 活跃时间跟着真实用户发言走（桌面端任何会话发消息都算）：
      // 会话列表缓存里的 updatedAt 立即刷新，自动跟随无需重新全量列会话。
      if (String(event?.type ?? '') === 'user/message' && event?.data?.source?.kind === 'user') {
        const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId)
        if (row !== undefined) {
          const at = Number.isFinite(event?.time) ? Number(event.time) : Date.now()
          row.updatedAt = Math.max(row.updatedAt, at)
          if (sessionListCache !== undefined) sessionListCache.rows = sortSessionRows(sessionListCache.rows)
        }
      }
      const type = String(event?.type ?? '')
      const sessionPreset = presetOf(session)
      if (sessionPreset !== '') sessionPresets.set(sessionId, sessionPreset)
      if (type === 'turn/start') {
        runningSessions.set(sessionId, Date.now())
        // 新的一轮开始：解除主页钉住与浏览态，让状态屏正常回到会话（用户 2026-11-08 规则）。
        unpinHome(sessionId)
        browsingHistory.delete(sessionId)
        // 上一轮如果没收到 end，别把上一条思考留到这一轮（start 事件会重新建缓冲）。
        stopLiveThinking(sessionId, false)
      }
      else if (type === 'turn/end') runningSessions.delete(sessionId)
      // 运行跟踪与自动跟随都在设备早退**之前**：没绑定该会话的设备收不到事件，
      // 若放在早退之后，别的会话的 turn/start/end 会把跟踪与跟随丢得一干二净。
      if (type === 'turn/start') followRunningTurn(sessionId)
      // 运行中会话一增一减，绑定别的会话的设备底部清单也要跟着变
      if (type === 'turn/start' || type === 'turn/end') setTimeout(() => refreshRunningLists(), 0)
      // 没有设备绑定这个会话时也要处 turn/end 的收尾：别的会话跑完了，
      // 当前屏右侧必须冒出「新回复」气泡（2026-11-07 用户实测：新开的 CU 会话完成，鹈鹕屏没通知）。
      if (![...devices].some((device) => device.sessionId === sessionId)) {
        // 没有设备绑定这个会话：仍要记下最近一条回复，点气泡/主页摘要都要用（审计 P1-8）。
        if (type === 'assistant/message') rememberReply(sessionId, event?.data)
        if (type === 'turn/end') enqueuePending(sessionId)
        return
      }
      const data = event?.data ?? {}

      // 屏幕帧 / 事件行统一交给纯函数映射（progress.ts）：stage、动词+目标、步骤计数、
      // 上一步结果、输出尾行都在那里统一截断，lane 只负责转发。
      const state = progressStates.get(sessionId) ?? createProgressState()
      progressStates.set(sessionId, state)
      // 思考/工具阶段切回 status；回答阶段切 reply（turn 结束后保持正文，不被完成帧覆盖）。
      if (type === 'turn/start' || type === 'step/start' || type === 'tool/call' || type === 'tool/result') {
        replySessions.delete(sessionId)
      }
      if (type === 'turn/start') {
        screenStates.delete(sessionId)
        cancelHomeTimer(sessionId)
        homeStates.set(sessionId, { mode: 'session', page: 0, done: false })
        // 兜底看门狗：这一轮如果永远等不到 turn/end（agent 被杀/宿主重启），到 stale
        // 窗口就自愈并重排回主页（2026-11-07 审计 P1-5）。
        const watchdog = setTimeout(() => {
          if (disposed || !runningSessions.has(sessionId)) return
          pruneStaleTurns()
          const hs = homeStates.get(sessionId)
          if (hs !== undefined && hs.done && hs.mode === 'session') scheduleHome(sessionId)
        }, tihuTurnStaleMs() + 10)
        watchdog.unref?.()
      }
      // 该步已经有模型早期思考（流式 reasoning）：先写进「思考」活动行，
      // 让这一帧 step/start / tool/call 直接带第一句话，而不是占位符。
      if (type === 'step/start' || type === 'tool/call') {
        const live = liveThinking.get(sessionId)
        if (live !== undefined && live.text !== '') {
          const narrow = (pendingByDisplay.get(sessionId)?.length ?? 0) > 0
          applyEarlyThinking(state, live.text, Date.now(), narrow ? PENDING_RAIL_WIDTH_PX : CONTENT_WIDTH_PX)
        }
      }
      const update = applySessionEvent(state, event, Date.now(), {
        ...screenMetaOf(sessionId),
        // 有气泡轨占位 → 页面把正文压到 240px，屏帧也按 240px 排版（审计 P1-6）。
        narrow: (pendingByDisplay.get(sessionId)?.length ?? 0) > 0,
      })
      if (type === 'turn/start') {
        // 注意：**不能**在这里点亮 tihu 窗口。用户自己在会话里打字同样会触发
        // turn/start，旧实现就是这么把用户自己的每个 turn 都变成「危险动作要确认」的。
        touchWindow(sessionId)
      }
      if (type === 'assistant/message') replySessions.add(sessionId)
      const keepReply = type === 'turn/end' && replySessions.has(sessionId)
      if (update.screen !== undefined && !keepReply) screen(sessionId, update.screen)
      if (update.progress !== undefined) broadcast(sessionId, 'event.progress', update.progress)

      if (type === 'assistant/message') {
        const blocks = data?.message?.content ?? []
        const text = stripToolNoise(blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b?.text ?? '')).join('\n')).trim()
        if (text === '') return
        // 按句切分（同时带字符区间）：tts.text/tts.audio/reply 屏帧共用这套下标。
        const sentences = splitReplySentences(text)
        if (sentences.length === 0) return
        const speechSegments = splitSpeechSegments(text)
          .map((segment) => ({ ...segment, text: toSpeechText(segment.text) }))
          .filter((segment) => segment.text !== '')
        const includeAll = [...text].length <= 2000
        if (speechSegments.length === 0) {
          pushReplyHistory(sessionId, text, sentences, [], includeAll)
          sendReply(sessionId, sentences, 0, 0, includeAll)
          broadcast(sessionId, 'event.alert', {
            level: 'error',
            text: '本次无语音：正文只有符号/空白，已清洗为空（仅显示文字）',
          })
          return
        }
        speechSegments.forEach((segment) => {
          broadcast(sessionId, 'tts.text', {
            text: segment.text,
            index: segment.index,
            total: speechSegments.length,
            lang: 'zh-CN',
            charStart: segment.start,
            charEnd: segment.end,
          } satisfies TtsTextPayload)
        })
        // 新回复：强制回到顶部并恢复跟随；取消回主页计时并切会话屏。
        screenStates.delete(sessionId)
        for (const device of devices) if (device.sessionId === sessionId) followByDevice.set(device.id, true)
        pushReplyHistory(sessionId, text, sentences, speechSegments, includeAll)
        cancelHomeTimer(sessionId)
        homeStates.set(sessionId, { mode: 'session', page: 0, done: false })
        sendReply(sessionId, sentences, 0, 0, includeAll)
        // 本地 TTS（Qwen3-TTS sidecar）：每个绑定设备按自己选的音色合成并流式下发；
        // 失败只影响该设备（页面收到 error alert 后立刻降级系统语音）。
        for (const device of devices) {
          if (device.sessionId === sessionId) {
            void speakLocally(device, sessionId, sentences, speechSegments, includeAll).catch((error) => {
              log(`tihu tts task failed: ${(error as Error)?.message ?? String(error)}`)
            })
          }
        }
        return
      }
      if (type === 'turn/end') {
        const reason = String(data?.reason?.kind ?? 'stop')
        // completed 与 stop 都是正常收尾（实测日志 reason.kind='completed'，旧代码只认 stop
        // 导致 ok:false）。error/aborted/cancelled 之类才判失败。
        const okReason = reason === 'stop' || reason === 'completed'
        broadcast(sessionId, 'event.done', {
          text: okReason ? '本轮完成' : `本轮结束（${reason}）`,
          ok: okReason,
          sessionId,
        } satisfies DonePayload)
        // 最终帧由 mapper 保留：「完成 · 共 N 步 · 用时 Xs」停在屏上，不清成「待命」。
        const hs = homeStates.get(sessionId) ?? { mode: 'session' as const, page: 0, done: false }
        hs.done = okReason
        homeStates.set(sessionId, hs)
        if (okReason) enqueuePending(sessionId)
        // 不在这里启动计时：要等朗读真正结束（speakLocally 完成/失败）再计时。
        // 无回复 turn（assistant/message 为空）也能回主页：这里兜底一次 scheduleHome，
        // 已有早退和 done 检查兜底，重复调用无害。
        setTimeout(() => scheduleHome(sessionId), 50)
        return
      }
    } catch (error) {
      log(`tihu session event failed: ${(error as Error)?.stack ?? String(error)}`)
    }
  })

  /**
   * 模型早期思考（进程内直播）：`agent/assistant-stream` 的 reasoning-delta 在模型
   * 一边想一边到，不等该步 assistant/message。这里按 attempt 累积文本、节流刷屏。
   *
   * 事件形状（@deepseek-ai/dsh-agent 的 AgentEventDispatch 注入 agent）：
   *   { agent, frame: { type: 'start', attemptId, revision, turn, step } }
   *   { agent, frame: { type: 'chunk', attemptId, revision, index, time,
   *                     chunk: { type: 'reasoning-delta', index, text } } }
   *   { agent, frame: { type: 'end', attemptId, revision, index, outcome } }
   * 只跟「有设备在看」的会话：没屏可刷的会话不占内存；其它 chunk（text/tool-call）忽略。
   */
  const disposeAssistantStream = ctx.on?.('agent/assistant-stream', (payload: any) => {
    try {
      const sessionId = sessionIdOfAgent(payload?.agent)
      if (sessionId === undefined) return
      const frame = payload?.frame
      if (frame === null || typeof frame !== 'object') return
      if (frame.type === 'start') {
        // 新 attempt：先扔掉上一条残留，再把这一次的思考缓冲建起来（中途有设备绑上也接得上）。
        stopLiveThinking(sessionId, false)
        liveThinking.set(sessionId, { attemptId: String(frame.attemptId ?? ''), text: '' })
        return
      }
      if (frame.type === 'chunk') {
        const chunk = frame.chunk
        if (chunk?.type !== 'reasoning-delta' || typeof chunk.text !== 'string' || chunk.text === '') return
        const buffer = liveThinking.get(sessionId)
        if (buffer === undefined) return
        if (buffer.text.length < TIHU_THINKING_MAX_CHARS) buffer.text += chunk.text
        scheduleLiveThinking(sessionId)
        return
      }
      if (frame.type === 'end') stopLiveThinking(sessionId, true)
    } catch (error) {
      log(`tihu assistant stream failed: ${(error as Error)?.message ?? String(error)}`)
    }
  })

  /* ---------- WebSocket ---------- */

  /** 握手外壳：异常一律兜住——pocket 代理是裸调用，这里漏一个 throw 就是一进程崩。 */
  function handleUpgrade(req: any, socket: any, head: Buffer): boolean {
    if (pathnameOf(req) !== TIHU_LANE_PATH) return false
    // 先挂 error 监听：101 应答之前对端就可能 abort，没有监听时 Node 会把
    // unhandled 'error' 事件抛成 uncaughtException（旧实现到 close 之后才挂）。
    try {
      socket.on?.('error', (error: unknown) => log(`tihu socket error: ${(error as Error)?.message ?? String(error)}`))
    } catch { /* 忽略 */ }
    try {
      return handleUpgradeSession(req, socket, head)
    } catch (error) {
      log(`tihu upgrade failed: ${(error as Error)?.stack ?? String(error)}`)
      try { socket.destroy?.() } catch { /* 忽略 */ }
      return true
    }
  }

  function handleUpgradeSession(req: any, socket: any, head: Buffer): boolean {
    const key = req?.headers?.['sec-websocket-key']
    if (typeof key !== 'string' || key === '') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      '',
      '',
    ].join('\r\n'))
    try { socket.setNoDelay?.(true) } catch { /* 忽略 */ }

    const seqOf = createSeq()
    const device: TihuDevice = {
      id: randomId('dev'),
      socket,
      seq: seqOf,
      autoFollow: false,
      voice: 'default',
      edgeVoice: process.env.TIHU_EDGE_VOICE ?? 'zh-CN-YunjianNeural',
      offlineOnly: process.env.TIHU_OFFLINE_ONLY === '1',
      send(type: string, payload: unknown) {
        try {
          const message = buildDownstream(type as any, payload, seqOf())
          socket.write(encodeFrame({ fin: true, opcode: 1, payload: Buffer.from(JSON.stringify(message), 'utf8') }))
        } catch { /* 连接已断，忽略 */ }
      },
      close() {
        try { socket.destroy() } catch { /* 忽略 */ }
      },
    }
    devices.add(device)
    log(`tihu device connected id=${device.id} ip=${req?.socket?.remoteAddress ?? '?'}`)

    // 上行**按到达顺序串行处理**：hello/session.bind 现在包含异步的会话校验（可能要读
    // 会话列表/标题），若并发执行，紧跟其后的 text.input 可能先到、在 sessionId 还没
    // 绑定前就被当成「还没选会话」丢掉。串行化后行为与「一条一条读」一致。
    let queue: Promise<void> = Promise.resolve()
    const enqueue = (message: any): void => {
      // 单条消息最多占队列 60 秒（转写自身 45 秒超时）：任何一步卡住都不能让后续
      // 上行永远排不到（2026-11-07 实测：页面音频无回音的兜底）。
      const guard = new Promise<void>((resolve) => {
        setTimeout(() => { log('tihu upstream message timed out (60s)'); resolve() }, 60_000).unref?.()
      })
      queue = queue
        .then(() => Promise.race([handleUpstream(device, message), guard]))
        .catch((error) => {
          log(`tihu upstream failed: ${(error as Error)?.stack ?? String(error)}`)
        })
    }
    const parser = new WsFrameParser(
      (frame: any) => {
        try {
          if (frame.opcode === 0x8) { // close
            device.close()
            return
          }
          if (frame.opcode === 0x9) { // ping → pong（控制帧）
            socket.write(encodeFrame({ fin: true, opcode: 0xA, payload: frame.payload }))
            return
          }
          if (frame.opcode !== 0x1) return // 只处理文本帧
          if (frame.payload.length > MAX_WS_MESSAGE_BYTES) return
          const message = parseUpstream(frame.payload)
          if (message === null) {
            // 未知 type / 坏消息：忽略，不崩、不回错（协议 v0 的兼容约定）。
            // **音频例外**：静默丢掉会让页面干等，必须回一条可读错误（2026-11-07 实测页面上传后无声）。
            const rejected = safeJson(frame.payload)
            log(`tihu ignored message: ${summarizeForLog(rejected)}`)
            if ((rejected as any)?.type === 'audio.frame') {
              device.send('event.alert', {
                level: 'error',
                text: '音频帧被拒绝：需要 16k 单声道 16bit WAV（base64 不超过 6 MB）',
              })
            }
            return
          }
          enqueue(message)
        } catch (error) {
          log(`tihu frame failed: ${(error as Error)?.stack ?? String(error)}`)
        }
      },
      (error: unknown) => {
        log(`tihu ws parse failed: ${(error as Error)?.message ?? String(error)}`)
        device.send('event.alert', { level: 'error', text: `连接数据解析失败：${(error as Error)?.message ?? String(error)}` })
      },
    )
    socket.on('data', (chunk: Buffer) => parser.push(chunk))
    socket.on('error', () => { /* 断开由 close 处理 */ })
    socket.on('close', () => {
      devices.delete(device)
      followByDevice.delete(device.id)
      // 断开的设备不再有屏：把还挂着的这一轮朗读掐掉，别继续烧合成额度。
      try { device.cancelRound?.() } catch { /* 忽略 */ }
      // 设备全断了：还挂着的危险动作确认一律按「离线」拒绝（安全侧默认）。
      if (devices.size === 0) (confirmBroker as any).failAll?.('offline')
      broadcastAll('event.alert', { level: 'info', text: '设备已断开' })
      log(`tihu device disconnected id=${device.id}`)
    })
    if (head !== undefined && head.length > 0) parser.push(head)
    return true
  }

  /** 广播给所有设备（设备上下线提示用）。 */
  function broadcastAll(type: string, payload: unknown): void {
    for (const device of devices) device.send(type, payload)
  }

  /** 处理一条合法上行。 */
  async function handleUpstream(device: TihuDevice, message: any): Promise<void> {
    const type = String(message.type)
    if (type === 'ping') {
      device.send('pong', { nonce: message?.payload?.nonce })
      return
    }
    if (type === 'hello') {
      const payload = message.payload as HelloPayload
      if (payload.protocol !== undefined && payload.protocol !== TIHU_PROTOCOL_VERSION) {
        device.send('event.alert', { level: 'error', text: `协议版本不匹配：设备 ${payload.protocol} / 宿主 ${TIHU_PROTOCOL_VERSION}` })
        return
      }
      device.hello = payload
      const caps = payload.capabilities ?? {}
      const requested = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : undefined
      if (requested !== undefined) {
        // 显式会话（URL）优先：手动绑定，不参与自动跟随。
        device.autoFollow = false
        await bindSession(device, requested)
        await sendHome(device.sessionId ?? '__unbound__', device)
      } else if (payload.auto === true) {
        // 默认路径：自动绑定「最近活跃的 Computer Use 会话」，但开机屏仍是主页；
        // 只有真正收到 assistant 回复时才切会话屏。
        device.autoFollow = true
        await autoBindActive(device, 'hello')
        if (device.sessionId !== undefined) await sendHome(device.sessionId, device)
        else await sendHome('__unbound__', device)
      } else {
        device.autoFollow = false
        device.sessionId = undefined
        await sendHome('__unbound__', device)
      }
      device.send('event.progress', { stage: '连接', text: `设备 ${device.id} 已就绪` } satisfies ProgressPayload)
      log(`tihu hello client=${payload.clientId} session=${device.sessionId ?? '?'} caps=${JSON.stringify(caps)}`)
      return
    }
    if (type === 'sessions.query') {
      // 页面自建会话选择：拉最近 N 条（默认 10，上限 50），并顺手核对页面手上的 id。
      const payload = message.payload ?? {}
      const limit = Number.isSafeInteger(payload.limit) ? Math.min(50, Math.max(1, payload.limit as number)) : 10
      const checkId = typeof payload.checkId === 'string' && payload.checkId !== '' ? payload.checkId : undefined
      const list = await listSessionChoices(limit, checkId)
      device.send('sessions.list', list)
      log(`tihu sessions.query limit=${limit} total=${list.total} cuTotal=${list.cuTotal} source=${list.source} check=${checkId ?? '-'}${list.check === undefined ? '' : ` found=${String(list.check.found)} cu=${String(list.check.computerUse)} preset=${list.check.preset ?? '-'}`}`)
      return
    }
    if (type === 'session.bind') {
      // 手动绑定（页面点选/URL）或切回自动跟随（{ auto: true }）。
      const payload = message.payload ?? {}
      if (payload.auto === true) {
        device.autoFollow = true
        await autoBindActive(device, 'hello')
        return
      }
      device.autoFollow = false
      await bindSession(device, String(payload.sessionId ?? ''))
      return
    }
    if (type === 'confirm.reply') {
      const payload = message.payload
      const handled = (confirmBroker as any).reply(payload.confirmId, payload.approved === true)
      device.send('event.progress', {
        stage: '确认',
        text: handled ? (payload.approved ? '已确认执行' : '已取消执行') : '这条确认已过期',
      } satisfies ProgressPayload)
      return
    }

    if (type === 'session.end') {
      // 页面「结束本次语音会话」：立刻解除闸门，不用等 120 秒窗口过期。
      const payload = message.payload ?? {}
      const sessionId = device.sessionId ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined)
      if (sessionId === undefined) {
        device.send('event.progress', { stage: '会话', text: '当前没有绑定会话' } satisfies ProgressPayload)
        return
      }
      const ended = endSession(sessionId)
      // 还挂着的危险动作确认也一并拒掉（用户已经明确结束本次会话）。
      ;(confirmBroker as any).failAll?.('rejected')
      device.send('event.progress', {
        stage: '会话',
        text: ended ? `已结束本次语音会话（${payload.reason ?? '页面按钮'}）` : '当前没有进行中的语音会话',
      } satisfies ProgressPayload)
      sendFrame(device, {
        stage: '空闲', title: '已结束本次会话', bullets: ['闸门已关闭', '按住说话可再开始'], tone: 'idle',
      } satisfies ScreenFramePayload, sessionId)
      return
    }

    if (type === 'screen.gesture') {
      const payload = message.payload as { action?: string; dy?: number; phase?: string; x?: number; y?: number }
      if (device.sessionId !== undefined) {
        cancelHomeTimer(device.sessionId)
        // 手势会打断回主页倒计时；处理完必须重新挂一次，否则「完成一轮后随手点一下屏」
        // 就永远停在会话页（2026-11-07 审计 P1-4）。
        const home = homeStates.get(device.sessionId)
        if (home !== undefined && home.done && home.mode === 'session') scheduleHome(device.sessionId)
      }
      if (payload.action === 'tap' && typeof payload.x === 'number' && typeof payload.y === 'number') {
        if ((payload as any).hit === 'action' && typeof (payload as any).actionId === 'string') {
          const actionId = (payload as any).actionId as string
          const sid = device.sessionId
          if (actionId === 'stop' && sid !== undefined) {
            try { device.cancelRound?.() } catch { /* 忽略 */ }
            device.send('event.progress', { stage: '停止', text: '已停止朗读（点重读可再来一遍）' } satisfies ProgressPayload)
            return
          }
          if (actionId === 'replay' && sid !== undefined) {
            // 重读念「屏上正在看的那条」：翻过历史就念那一条，不跳回最新（用户 2026-11-08 要求）。
            const list = replyHistory.get(sid) ?? []
            const index = browseIndexOf(sid)
            const reply = index >= 0 ? list[index] : replyPayloadOf(sid)
            if (reply !== undefined) {
              if (index < 0) browseLatest(sid)
              else browsingHistory.delete(sid)
              screenStates.delete(sid)
              sendReply(sid, reply.sentences, 0, 0, reply.includeAll)
              void speakLocally(device, sid, reply.sentences, reply.speechSegments, reply.includeAll).catch((error) => {
                log(`tihu replay speak failed: ${(error as Error)?.message ?? String(error)}`)
              })
            }
            return
          }
          if (actionId === 'home') {
            // 点主页 = 退出本轮朗读 + 钉住主页（用户 2026-11-08 要求）：
            // 不再发「已停止朗读」提示，免得每点一次就刷一条事件；钉住期间 status/reply
            // 帧不再覆盖主页屏，直到新的 turn/start / 换绑定 / 点项目卡 / 点最近回答。
            if (sid !== undefined) {
              try { device.cancelRound?.() } catch { /* 忽略 */ }
              pinHome(sid)
            }
            await sendHome(sid ?? '__unbound__', device)
            return
          }
          if ((actionId === 'prev' || actionId === 'next') && sid !== undefined) {
            browseReplyHistory(device, sid, actionId === 'prev' ? -1 : 1)
            return
          }
          return
        }
        if ((payload as any).hit === 'switch' && typeof (payload as any).targetSessionId === 'string') {
          const target = (payload as any).targetSessionId as string
          if (target === (device.sessionId ?? '')) return
          await bindSession(device, target)
          unpinHome(target)
          const reply = replyPayloadOf(target)
          if (reply !== undefined) {
            browseLatest(target)
            screenStates.delete(target)
            homeStates.set(target, { mode: 'session', page: 0, done: true })
            sendReply(target, reply.sentences, 0, 0, reply.includeAll)
          }
          scheduleHome(target)
          return
        }
        // 首页「最近回答」行：回到该会话最近那条回答的朗读屏（不自动朗读，要读点「重读」）。
        if ((payload as any).hit === 'recent' && typeof (payload as any).sessionId === 'string') {
          const target = (payload as any).sessionId as string
          const list = replyHistory.get(target) ?? []
          const index = list.length - 1
          if (index >= 0) {
            if (device.sessionId !== target) await bindSession(device, target)
            unpinHome(target)
            browseLatest(target)
            browsingHistory.add(target)
            screenStates.delete(target)
            for (const item of devices) if (item.sessionId === target) followByDevice.set(item.id, true)
            // 从「最近回答」进来算浏览：暂停自动回主页，用户点主页/项目卡才回。
            cancelHomeTimer(target)
            const home = homeStates.get(target) ?? { mode: 'session' as const, page: 0, done: false }
            home.mode = 'session'
            home.done = false
            homeStates.set(target, home)
            sendReply(target, list[index].sentences, 0, 0, list[index].includeAll)
          }
          return
        }
        // 气泡点击：targetSessionId 必须在当前 pending 队列里（防伪造切屏）。
        if (device.sessionId === undefined) {
          // 未绑定设备：点项目直接进入；点右下角回主页（只发给自己）
          if ((payload as any).hit === 'project' && typeof (payload as any).sessionId === 'string') {
            const target = (payload as any).sessionId as string
            unpinHome(target)
            browsingHistory.delete(target)
            await bindSession(device, target)
            screenStates.delete(target)
            homeStates.set(target, { mode: 'session', page: 0, done: true })
            scheduleHome(target)
            return
          }
          if (payload.x >= 240 && payload.y >= 180) await sendHome('__unbound__', device)
          return
        }
        if ((payload as any).hit === 'project' && typeof (payload as any).sessionId === 'string') {
          // 主页行点击：进入该项目最近会话（sessionId 由主页帧下发，bindSession 会再校验存在性）
          const target = (payload as any).sessionId as string
          unpinHome(target)
          browsingHistory.delete(target)
          if (target !== device.sessionId) {
            await bindSession(device, target)
            screenStates.delete(target)
            homeStates.set(target, { mode: 'session', page: 0, done: true })
          }
          scheduleHome(target)
          return
        }
        if ((payload as any).hit === 'chip' && typeof (payload as any).targetSessionId === 'string') {
          const target = (payload as any).targetSessionId as string
          const display = device.sessionId
          const list = pendingByDisplay.get(display) ?? []
          const index = list.findIndex((item) => item.sessionId === target)
          if (index >= 0) {
            list.splice(index, 1)
            pendingByDisplay.set(display, list)
            const reply = replyPayloadOf(target)
            await bindSession(device, target)
            unpinHome(target)
            browseLatest(target)
            screenStates.delete(target)
            homeStates.set(target, { mode: 'session', page: 0, done: true })
            if (reply !== undefined) {
              sendReply(target, reply.sentences, 0, 0, reply.includeAll)
              void speakLocally(device, target, reply.sentences, reply.speechSegments, reply.includeAll).catch((error) => {
                log(`tihu chip speak failed: ${(error as Error)?.message ?? String(error)}`)
              })
            }
          }
          return
        }
        // 右下角 tap = 立刻回主页（第一个 tap 业务）。
        if (payload.x >= 240 && payload.y >= 180) await sendHome(device.sessionId)
        return
      }
      if (payload.action === 'swipe' && device.sessionId !== undefined && typeof payload.dy === 'number') {
        const home = homeStates.get(device.sessionId)
        if (home?.mode === 'home') {
          if (payload.phase === 'move' || payload.phase === 'end') {
            home.page = Math.max(0, home.page + (payload.dy < 0 ? 1 : payload.dy > 0 ? -1 : 0))
            await sendHome(device.sessionId)
          }
          return
        }
        const scrollState = screenStates.get(device.sessionId)
        if (scrollState !== undefined) {
          // 手指上滑 dy<0 → 看更早内容 → offset 增大；约 20px 一行。
          const delta = -payload.dy / SCREEN_SPEC.bodyLineHeightPx
          if (payload.phase === 'move' || payload.phase === 'end') {
            const maxOffset = Math.max(0, scrollState.lines.length - SCREEN_SPEC.replyVisibleLines)
            scrollState.offset = Math.max(0, Math.min(scrollState.offset + delta, maxOffset))
            scrollState.follow = scrollState.offset < 0.5
            followByDevice.set(device.id, scrollState.follow)
            sendReply(device.sessionId, scrollState.sentences, scrollState.currentIndex, scrollState.charPos, true)
          }
        }
      }
      return
    }

    if (type === 'voice.list') {
      const voices = await tts.listVoices(device.sessionId)
      device.send('voice.list', { voices, selected: device.voice, engine: tts.status() } satisfies VoiceListPayload)
      return
    }
    if (type === 'voice.select') {
      const name = String(message.payload?.name ?? '')
      device.voice = name === '' ? 'default' : name
      if (typeof message.payload?.edgeVoice === 'string' && message.payload.edgeVoice !== '') device.edgeVoice = message.payload.edgeVoice
      if (typeof message.payload?.offlineOnly === 'boolean') device.offlineOnly = message.payload.offlineOnly
      if (device.voice !== 'default' && tts.available()) {
        void tts.ensureServer().catch((error) => log(`tihu tts clone prewarm failed: ${(error as Error)?.message ?? String(error)}`))
      }
      device.send('event.progress', { stage: '音色', text: `音色已切换：${device.voice}` } satisfies ProgressPayload)
      return
    }
    if (type === 'tts.sample') {
      /**
       * 试听：走与正式朗读**完全相同**的链路（edge-tts 云健 → 失败按原规则回退本地
       * Qwen），只是不发 tts.text、不动屏、不占朗读队列与回主页守门——试听不算一轮
       * 回复。页面收到带 `sample: true` 的 tts.audio 就播，且不写进本轮朗读缓存。
       * 合成彻底失败：红告警 + 明确告诉页面可以退到提示音（绝不静默）。
       */
      const requested = typeof message.payload?.text === 'string' ? message.payload.text.trim() : ''
      const sampleText = requested === '' ? TIHU_SAMPLE_TEXT : [...requested].slice(0, 60).join('')
      if (!tts.available()) {
        device.send('event.alert', {
          level: 'error',
          text: `试听无语音：${tts.status().error ?? '本地引擎未就绪'}（已改用提示音）`,
        } satisfies AlertPayload)
        return
      }
      if ((device.voice && device.voice !== 'default') || device.offlineOnly) {
        try { await tts.ensureServer() } catch { /* 合成阶段会给出可读错误 */ }
      }
      try {
        const result = await tts.synthesize(sampleText, {
          voice: device.voice,
          sessionId: device.sessionId,
          edgeVoice: device.edgeVoice,
          offlineOnly: device.offlineOnly,
          onChunk: (chunk) => {
            device.send('tts.audio', {
              seq: chunk.seq,
              total: chunk.total,
              sampleRate: 24000,
              channels: 1,
              format: 'pcm16',
              data: chunk.data.toString('base64'),
              index: 0,
              text: sampleText,
              sample: true,
              ...(chunk.final ? { final: true } : {}),
            } satisfies TtsAudioPayload)
          },
        })
        log(`tihu tts sample ok chars=${[...sampleText].length} voice=${device.voice} audio=${Math.round(Number(result?.audioMs) || 0)}ms`)
      } catch (error) {
        const reason = (error as Error)?.message ?? String(error)
        log(`tihu tts sample failed: ${reason}`)
        device.send('event.alert', { level: 'error', text: `试听无语音：${reason}（已改用提示音）` } satisfies AlertPayload)
      }
      return
    }
    if (type === 'voice.create') {
      const payload = message.payload ?? {}
      try {
        const created = await tts.createVoice({
          name: String(payload.name ?? ''),
          wavBase64: String(payload.wavBase64 ?? ''),
          ...(typeof payload.note === 'string' ? { note: payload.note } : {}),
        }, device.sessionId)
        device.send('voice.created', created satisfies VoiceCreatedPayload)
        device.send('event.progress', {
          stage: '音色',
          text: created.cached ? `音色 ${created.voice.name} 已存在（命中缓存）` : `已创建音色 ${created.voice.name}`,
        } satisfies ProgressPayload)
        device.send('voice.list', {
          voices: await tts.listVoices(device.sessionId),
          selected: device.voice,
          engine: tts.status(),
        } satisfies VoiceListPayload)
      } catch (error) {
        device.send('event.alert', { level: 'error', text: `创建音色失败：${(error as Error)?.message ?? String(error)}` })
      }
      return
    }

    if (type === 'text.input' || type === 'audio.frame') {
      // 页面先看到「已收到」，避免「已上行」之后再无任何回音（2026-11-07 实测问题）。
      device.send('event.progress', {
        stage: 'audio',
        text: type === 'audio.frame' ? '已收到音频，准备转写' : '已收到文字',
      } satisfies ProgressPayload)
      // 自动跟随（要求：每次注入前重新判定「最活跃的 CU 会话」，变了就跟过去）。
      // **必须有上限**：跟随失败/超时不能把整条消息队列卡死（页面就会干等转写）。
      if (device.autoFollow) {
        try {
          await Promise.race([
            autoBindActive(device, 'inject'),
            new Promise<void>((resolve) => { setTimeout(() => {
              log('tihu auto follow timeout (5s), keep current session')
              resolve()
            }, 5000) }),
          ])
        } catch (error) {
          log(`tihu auto follow failed: ${(error as Error)?.message ?? String(error)}`)
        }
      }
      if (device.sessionId === undefined) {
        device.send('event.alert', {
          level: 'warn',
          text: device.autoFollow
            ? '没有可自动绑定的 Computer Use 会话：先在桌面端新建一个'
            : '还没有选定会话：点页面下面的会话列表选一个',
        })
        await sendHome('__unbound__', device)
        return
      }
      // 收到 tihu 消息就续期（「120 秒无 tihu 消息自动失效」的另一半）。
      touchWindow(device.sessionId)
      let text = ''
      let source: 'voice' | 'keyboard' = 'keyboard'
      if (type === 'text.input') {
        text = String(message.payload.text ?? '').trim()
        source = message.payload.source === 'voice' ? 'voice' : 'keyboard'
        if (text === '') return
      } else {
        source = 'voice'
        sendFrame(device, { stage: '聆听', title: '正在转写…', bullets: ['本机 speech 服务'], tone: 'busy' } satisfies ScreenFramePayload)
        try {
          text = await transcribe(String(message.payload.audioBase64 ?? ''))
        } catch (error) {
          device.send('event.alert', { level: 'error', text: `转写失败：${(error as Error)?.message ?? String(error)}` })
          sendFrame(device, { stage: '转写失败', title: '请用文字输入', bullets: [], tone: 'alert' } satisfies ScreenFramePayload)
          return
        }
        if (text === '') {
          device.send('event.alert', { level: 'warn', text: '没有识别到语音内容，请再说一次' })
          return
        }
      }
      try {
        // 先回 transcript 再注入：即使这个会话已经被关掉/没有 agent，屏上也先看到
        // 「我听到的是什么」，而不是只剩一条「注入失败」（E2E 脚本也靠这条核对转写）。
        device.send('transcript', { text, final: true, source, retryable: true } satisfies TranscriptPayload)
        inject(device.sessionId, text)
        device.send('event.progress', { stage: '注入', text: '已送入当前会话' } satisfies ProgressPayload)
        sendFrame(device, { stage: '思考', title: '模型处理中', bullets: [text.slice(0, 20)], tone: 'busy' } satisfies ScreenFramePayload)
      } catch (error) {
        device.send('event.alert', { level: 'error', text: `注入失败：${(error as Error)?.message ?? String(error)}` })
      }
    }
  }

  /**
   * 控制室卡片变化 → 主页自动跟新（低频巡检，默认 30 秒）。
   *
   * 只和「屏幕上这一帧用的卡片清单」比：变了才补一帧，平时每轮只是一次 statSync
   * （projectCards 有 mtime 缓存），不重排、不重发，页面不会无谓地闪一下。
   * 没有设备停在主页时什么都不做——它下次回主页时 sendHome 自然画上新清单。
   *
   * 签名 '' 表示状态文件暂时读不到：保持现状等它恢复，绝不退回 workspaceRegistry 的旧清单。
   */
  let homeSyncTimer: ReturnType<typeof setInterval> | undefined
  const homeSyncEveryMs = options.homeSyncMs ?? tihuHomeSyncMs()
  if (homeSyncEveryMs > 0) {
    homeSyncTimer = setInterval(() => {
      if (disposed) return
      const signature = projectCardsSignature(projectCards())
      // '' = 状态文件暂时读不到：保持现状等它恢复，绝不退回 workspaceRegistry 的旧清单。
      if (signature === '' || signature === shownCardSignature) return
      // 只有停在主页的设备才需要补帧；没人停在主页时不更新基线，等它下次回主页自己拿新清单。
      for (const device of devices) {
        const sessionId = device.sessionId ?? '__unbound__'
        const state = homeStates.get(sessionId)
        if (state === undefined || state.mode !== 'home') continue
        void sendHome(sessionId, device).catch((error) => log(`tihu home card sync failed: ${(error as Error)?.message ?? String(error)}`))
      }
    }, homeSyncEveryMs)
    // 闲时巡检不该拖住进程退出（单测 / 宿主卸载都靠 dispose 收尾）。
    ;(homeSyncTimer as any).unref?.()
  }

  /* ---------- 控制面（tihu 全局工具用；全是薄壳转调，见 control.ts） ----------
   *
   * 单测覆盖说明：会话定位是纯函数（control.ts 的 matchSessionRows，已直接单测）；
   * bind/openBubble/replay/goHome/browse/openRecent 逐行复刻 screen.gesture 里
   * 手指点屏的分支，行为以 lane 端到端测试为准，薄壳本身不再重复设断言。
   * archiveSession 转调宿主 workspaceRegistry（stopActivity=true），
   * 「绑定中的会话拒绝删除」的守卫在 control.ts（可注入假控制面单测）。
   */

  /** 控制视图：TihuDevice → 可导出快照。 */
  function controlDeviceOf(device: TihuDevice): TihuControlDevice {
    return {
      id: device.id,
      ...(typeof device.hello?.clientId === 'string' && device.hello.clientId !== '' ? { clientId: device.hello.clientId } : {}),
      ...(device.sessionId === undefined ? {} : { sessionId: device.sessionId }),
      autoFollow: device.autoFollow,
      voice: device.voice,
      edgeVoice: device.edgeVoice,
      offlineOnly: device.offlineOnly,
    }
  }

  /** 按 id 或页面 clientId 找在线设备。 */
  function findControlDevice(deviceId: string): TihuDevice | undefined {
    return [...devices].find((device) => device.id === deviceId || device.hello?.clientId === deviceId)
  }

  function controlRowOf(row: TihuSessionRow): ControlSessionRow {
    return { sessionId: row.sessionId, title: humanTitle(row.title), preset: row.preset, live: row.live, updatedAt: row.updatedAt }
  }

  const control: TihuControlSurface = {
    listDevices: () => [...devices].map(controlDeviceOf),
    deviceOfSession: (sessionId) => {
      const device = [...devices].find((item) => item.sessionId === sessionId)
      return device === undefined ? undefined : controlDeviceOf(device)
    },
    deviceStatus: (deviceId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return undefined
      const display = device.sessionId ?? '__unbound__'
      const frame = lastFrames.get(display)
      return {
        device: controlDeviceOf(device),
        display,
        pinned: device.sessionId !== undefined && homePinned.has(device.sessionId),
        speaking: device.sessionId !== undefined && readingBusy(device.sessionId),
        pending: (pendingByDisplay.get(display) ?? []).map((item) => ({ sessionId: item.sessionId, title: item.title, at: item.at })),
        ...(frame === undefined ? {} : { screen: { stage: frame.stage ?? '', title: frame.title ?? '', mode: frame.mode ?? 'status', bullets: frame.bullets ?? [] } }),
      }
    },
    listSessions: async (fragment) => {
      try {
        const collected = await collectSessionRows()
        return matchSessionRows(collected.rows.map(controlRowOf), fragment)
      } catch {
        return { kind: 'none' }
      }
    },
    bind: async (deviceId, sessionId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      const found = await findSession(sessionId)
      if (found.status === 'missing') return `错误：会话 ${shortSessionId(sessionId)} 不存在（可能已归档或删除）`
      await bindSession(device, sessionId)
      return `已把设备 ${device.id} 绑定到「${titleForSession(sessionId)}」`
    },
    openBubble: async (deviceId, pick) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      const display = device.sessionId
      if (display === undefined) return '错误：这台设备还没绑定会话，屏幕右侧没有可点的气泡'
      const list = pendingByDisplay.get(display) ?? []
      if (list.length === 0) return '屏幕右侧现在没有待读气泡'
      let target: string | undefined
      if (pick.index !== undefined) {
        const item = list[Math.trunc(pick.index) - 1]
        if (item === undefined) return `错误：气泡序号 ${pick.index} 不存在（当前有 ${list.length} 个气泡，序号从 1 开始）`
        target = item.sessionId
      } else {
        const key = String(pick.title ?? '').trim().toLowerCase()
        const hit = key === '' ? undefined : list.find((item) => item.title.toLowerCase().includes(key))
        if (hit === undefined) return `错误：没有标题含「${pick.title}」的气泡（当前气泡：${list.map((item) => item.title).join('、')}）`
        target = hit.sessionId
      }
      const at = list.findIndex((item) => item.sessionId === target)
      if (at >= 0) {
        list.splice(at, 1)
        pendingByDisplay.set(display, list)
      }
      const reply = replyPayloadOf(target)
      await bindSession(device, target)
      unpinHome(target)
      browseLatest(target)
      screenStates.delete(target)
      homeStates.set(target, { mode: 'session', page: 0, done: true })
      if (reply !== undefined) {
        sendReply(target, reply.sentences, 0, 0, reply.includeAll)
        void speakLocally(device, target, reply.sentences, reply.speechSegments, reply.includeAll).catch((error) => log(`tihu control bubble speak failed: ${(error as Error)?.message ?? String(error)}`))
      }
      return `已点开气泡：「${titleForSession(target)}」`
    },
    progress: async (sessionId) => {
      const found = await findSession(sessionId)
      const title = found.row?.title !== undefined && found.row.title !== '' ? humanTitle(found.row.title) : titleForSession(sessionId)
      const state = progressStates.get(sessionId)
      return {
        sessionId,
        title,
        running: runningSessions.has(sessionId),
        speaking: readingBusy(sessionId),
        ...(state === undefined ? {} : { state: { turn: state.turn, step: state.step, stage: state.stage, stageWord: state.stageWord, title: state.title, turnStartedAt: state.turnStartedAt, activity: state.activity.slice(-6), ...(state.lastResult === undefined ? {} : { lastResult: state.lastResult }), ...(state.stats === undefined ? {} : { stats: state.stats }) } }),
        stats: screenMetaOf(sessionId).stats,
      }
    },
    archiveSession: async (sessionId) => {
      const registry = optionalService(ctx, 'workspaceRegistry')
      if (registry === undefined || typeof registry.archiveSession !== 'function') return '错误：宿主没有 workspaceRegistry 服务，无法归档会话'
      const found = await findSession(sessionId)
      if (found.status === 'missing') return `错误：会话 ${shortSessionId(sessionId)} 不存在（可能已归档或删除）`
      try {
        await registry.archiveSession(sessionId, { stopActivity: true })
      } catch (error) {
        return `错误：归档失败（${(error as Error)?.message ?? String(error)}）`
      }
      // 列表缓存作废：下次 listSessions/bind 自然看到归档后的世界。
      sessionListCache = undefined
      return `已删除（归档）会话「${found.row?.title !== undefined && found.row.title !== '' ? humanTitle(found.row.title) : shortSessionId(sessionId)}」`
    },
    stopSpeaking: async (deviceId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      try { device.cancelRound?.() } catch { /* 忽略 */ }
      return '已停止朗读（点重读可再来一遍）'
    },
    replay: async (deviceId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      const sid = device.sessionId
      if (sid === undefined) return '错误：这台设备还没绑定会话，没有可重读的回答'
      const list = replyHistory.get(sid) ?? []
      const index = browseIndexOf(sid)
      const reply = index >= 0 ? list[index] : replyPayloadOf(sid)
      if (reply === undefined) return '错误：这条会话还没有可重读的回答'
      if (index < 0) browseLatest(sid)
      else browsingHistory.delete(sid)
      screenStates.delete(sid)
      sendReply(sid, reply.sentences, 0, 0, reply.includeAll)
      void speakLocally(device, sid, reply.sentences, reply.speechSegments, reply.includeAll).catch((error) => log(`tihu control replay failed: ${(error as Error)?.message ?? String(error)}`))
      return '正在重读当前回答'
    },
    goHome: async (deviceId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      const sid = device.sessionId
      if (sid !== undefined) {
        try { device.cancelRound?.() } catch { /* 忽略 */ }
        pinHome(sid)
      }
      await sendHome(sid ?? '__unbound__', device)
      return '已回主页并钉住'
    },
    browse: async (deviceId, direction) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      const sid = device.sessionId
      if (sid === undefined) return '错误：这台设备还没绑定会话，没有可翻的回答历史'
      const before = browseIndexOf(sid)
      browseReplyHistory(device, sid, direction === 'prev' ? -1 : 1)
      const list = replyHistory.get(sid) ?? []
      const after = browseIndexOf(sid)
      if (after === before) return `已经${direction === 'prev' ? '是最早一条' : '是最新一条'}回答了（这条会话共 ${list.length} 条历史）`
      return `已翻到第 ${after + 1}/${list.length} 条回答`
    },
    openRecent: async (deviceId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      const owner = recentReplyOwnerOf(device.sessionId ?? '__unbound__', device)
      if (owner === undefined) return '错误：现在没有任何会话有「最近回答」'
      const target = owner.sessionId
      const list = replyHistory.get(target) ?? []
      const index = list.length - 1
      if (index < 0) return '错误：现在没有任何会话有「最近回答」'
      if (device.sessionId !== target) await bindSession(device, target)
      unpinHome(target)
      browseLatest(target)
      browsingHistory.add(target)
      screenStates.delete(target)
      for (const item of devices) if (item.sessionId === target) followByDevice.set(item.id, true)
      cancelHomeTimer(target)
      const home = homeStates.get(target) ?? { mode: 'session' as const, page: 0, done: false }
      home.mode = 'session'
      home.done = false
      homeStates.set(target, home)
      sendReply(target, list[index].sentences, 0, 0, list[index].includeAll)
      return `已打开「${titleForSession(target)}」的最近回答（要朗读点「重读」）`
    },
  }

  return {
    control,
    page: () => tihuPageHtml({ lanePath: TIHU_LANE_PATH, protocol: TIHU_PROTOCOL_VERSION }),
    handleUpgrade,
    dispose: () => {
      disposed = true
      if (homeSyncTimer !== undefined) clearInterval(homeSyncTimer)
      for (const [sessionId, timer] of thinkingTimers) {
        clearTimeout(timer)
        thinkingTimers.delete(sessionId)
      }
      liveThinking.clear()
      ;(confirmBroker as any).failAll?.('disposed')
      for (const [sessionId, state] of homeStates) {
        if (state.timer !== undefined) clearTimeout(state.timer)
        homeStates.delete(sessionId)
      }
      tts.dispose()
      for (const device of devices) device.close()
      devices.clear()
      for (const disposer of [disposePre, disposePost, disposeSession, disposeAssistantStream]) {
        try { if (typeof disposer === 'function') disposer() } catch { /* 忽略 */ }
      }
    },
    stats: () => ({ devices: devices.size, activeSessions: [...activeSessions.keys()], pendingConfirms: (confirmBroker as any).pendingCount?.() ?? 0 }),
  }
}

/* ---------- 小工具 ---------- */

function safeJson(buffer: Buffer): unknown {
  try { return JSON.parse(buffer.toString('utf8')) } catch { return { type: '<unparsable>' } }
}

/** 工作区内的绝对路径；越界与否由 guard 的快照逻辑再判一次（这里只拼路径）。 */
function joinSafe(workspace: string, target: string): string {
  return isAbsolute(target) ? target : join(workspace, target)
}

function existsSyncSafe(workspace: string, target: string): boolean {
  try { return existsSync(joinSafe(workspace, target)) } catch { return false }
}

/** 协议类型集合（测试与文档核对用）。 */
export const tihuProtocolSurface = { upstream: TIHU_UPSTREAM_TYPES, downstream: TIHU_DOWNSTREAM_TYPES, version: TIHU_PROTOCOL_VERSION, tihuDirOf }
