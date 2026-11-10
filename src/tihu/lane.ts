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
 *        ◄─transcript / screen.frame / tts.audio / event.* / task.*──
 *
 *   本 lane 做的事：
 *     1. 语音：走官方 speech 服务（`ctx.get('speechController')`，也就是客户端
 *        `remote.speech` 背后的同一个服务），不新造 ASR、不引入模型依赖；
 *     2. 注入：`agents.get(sessionId).followup(message)` —— 与用户在会话里发消息
 *        同一条入口（普通 user/message），不另建并行会话；
 *     3. 屏：订阅 `session/event`（turn/start、tool/call、assistant/message、
 *        turn/end）→ screen.frame / event.progress / task.notify / tts.audio；
 *     4. 闸：`tools/pre-execute` / `tools/post-execute` → 快照、审计（见 guard.ts）。
 *        危险动作的授权只在电脑端，绝不上设备屏。只对「tihu 正在执行的会话」生效。
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
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
  type HelloPayload,
  type ProgressPayload,
  type ScreenFramePayload,
  type SessionBoundPayload,
  type TranscriptPayload,
  type TaskBoardPayload,
  type TaskListPayload,
  type TaskNotifyPayload,
  type TaskReplyPayload,
  type TaskUpdatePayload,
} from './protocol.ts'
import {
  appendAudit,
  classifyTool,
  commandOf,
  diffSummary,
  readTextOrEmpty,
  takeSnapshot,
  targetPathOf,
  tihuDirOf,
  timestampSlug,
  type TihuActionClass,
} from './guard.ts'
import { tihuPageHtml } from './page.ts'
import { applyEarlyThinking, applySessionEvent, createProgressState, decodeRateOf, formatTokens, pushDecodeSample, type TihuDecodeSample, type TihuProgressState } from './progress.ts'
import { TihuTts, isKokoroVoice, type TihuTtsPaths } from './tts.ts'
import { replyVisibleWindow, replyWindow, splitReplySentences, splitSpeechSegments, type ReplySentence, type SpeechSegment } from './reply.ts'
import { stripToolNoise, toSpeechText } from './speech-text.ts'
import { CONTENT_WIDTH_PX, fitScreenLines, PENDING_RAIL_WIDTH_PX, REPLY_LAYOUT, SCREEN_SPEC, wrapTextPx } from './screen-spec.ts'
import { parseWav } from './audio.ts'
import { applyPersonalTerms, cleanFillers, fixTerms } from '../client/pocket/orb/asr-terms.ts'
import { loadAssistantConfig } from '../assistant-config.ts'
import { cardsFromState, groupCardProjects, groupProjects, groupWorkspaceProjects, humanTitle, projectCardsSignature, projectNameOf, type ProjectReply, type TihuCardRow, type TihuWorkspaceRow } from './project-groups.ts'
import { matchSessionRows, matchTaskRows, type ControlSessionRow, type ControlTaskRow, type DeviceStatusView, type SessionProgressView, type TihuControlDevice, type TihuControlSurface } from './control.ts'
import type { AlertPayload, TtsAudioPayload, VoiceCreatedPayload, VoiceListPayload } from './protocol.ts'
import {
  ANNOUNCE_WINDOW_MS,
  DONE_KEEP_MS,
  TaskLedger,
  TaskNotifyBus,
  bestCardMatchOf,
  boardOf,
  capsuleOf,
  chineseIndex,
  continuityCandidatesOf,
  continuityOf,
  parseScreenCommand,
  plainSummaryOf,
  routeQuick,
  scoreCardAlias,
  stripWakeWord,
  subLineOf,
  taskTitleOf,
  CONTINUITY_WINDOW_MS,
  type ScreenCommand,
  type TihuSessionCandidate,
  type TihuTask,
} from './task-ledger.ts'
import { commanderReplyTail, parseCommanderReply, type CommanderReply } from './dispatch-protocol.ts'
import {
  DONE_NO_REPLY_TEXT,
  RECEIPT_SECONDS,
  askWhichFrame,
  boardFrame,
  clarifySessionFrame,
  decisionFrame,
  detailFrame,
  doneAnnouncementOf,
  doneFrame,
  doneLineRangesOf,
  doneSpeechSegmentsOf,
  folderBase,
  noticeFrame,
  prepareDoneText,
  receiptFrame,
  type DoneSpeechSegment,
} from './task-screens.ts'
import { ensureAssistantHome } from '../assistant-home.ts'
import { TihuPreroll, prerollAudioMs } from './preroll.ts'

/** 页面与 WebSocket 的路径（代理侧按这两个前缀放行）。 */
export const TIHU_PAGE_PATH = '/tihu'
export const TIHU_LANE_PATH = '/tihu/lane'

/** 棋盘上有在跑的行时，隔多久重发一帧（让右侧蓝色弧跟着已运行时长往前走）。 */
export const BOARD_TICK_MS = 5_000

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
/** 朗读结束后自动回棋盘的等待（用户 2026-11-09：60 秒）。 */
export const HOME_AFTER_SPEECH_MS = 60_000
/** 进度页静置多久自动回棋盘（最新事件刷新会重新计时；用户 2026-11-10：三页都要能超时回棋盘）。 */
export const DETAIL_AUTO_HOME_MS = 60_000
/**
 * 进度页看门狗：这么久没有任何**新的会话帧**（步数/工具/回复/思考都没动）就回棋盘。
 *
 * 用户 2026-11-10 实机：电脑端 CU 会话已经回复完、turn/end 也到了，屏还挂在它的进度页
 * （第 20 步 · 已用 3m28s），而且用户回棋盘后又被拉回去。看门狗保证任何一张进度页
 * 都不会「无限挂着」：静置到点就回棋盘，卡还在（状态由登记簿说话）。
 * TIHU_PROGRESS_STALE_MS 仅供测试调小（夹在 1s ～ 10min）。
 */
export const PROGRESS_WATCHDOG_MS = 30_000
export function tihuProgressStaleMs(): number {
  const raw = Number(process.env.TIHU_PROGRESS_STALE_MS ?? PROGRESS_WATCHDOG_MS)
  if (!Number.isFinite(raw) || raw <= 0) return PROGRESS_WATCHDOG_MS
  return clampInt(raw, 1_000, 10 * 60_000)
}
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
 * 灰区（项目知道、接不接不知道）交给指挥台判一次的等待上限（毫秒）。
 *
 * 注意：这**不是**「派给哪个项目」的判断窗口。用户 2026-11-10 拍板：指挥台判项目
 * 不设超时，一直等到它回；灰区只是「接着哪条会话」的二次确认，到点没结论就按
 * 屏上澄清一次处理（不答就新建），所以这里保留一个有限窗口。
 * TIHU_GRAY_FALLBACK_MS 可覆盖（夹在 50ms ~ 2min；0/负数/非数字回落默认）。
 */
export function tihuGrayCommanderMs(): number {
  const raw = Number(process.env.TIHU_GRAY_FALLBACK_MS ?? 9_000)
  if (!Number.isFinite(raw) || raw <= 0) return 9_000
  return clampInt(raw, 50, 120_000)
}

/**
 * 会话衔接澄清在屏上最多等多久（毫秒，默认 15 秒）。
 *
 * 「新建，还是接着刚才那条」只问一次；到点没答就按**新建**派出，不再追问。
 * TIHU_CLARIFY_MS 可覆盖（夹在 100ms ~ 60s；0/负数/非数字回落默认）。
 */
export function tihuClarifyMs(): number {
  const raw = Number(process.env.TIHU_CLARIFY_MS ?? 15_000)
  if (!Number.isFinite(raw) || raw <= 0) return 15_000
  return clampInt(raw, 100, 60_000)
}

/**
 * 派单回执在屏上停多久（毫秒）：默认 `RECEIPT_SECONDS × 1000`（5 秒）。
 * 屏上倒计时数字仍由 {@link RECEIPT_SECONDS} 给，这里只调「到点分流」的时刻；
 * TIHU_RECEIPT_MS 仅供测试调小（夹在 50ms ~ 30s）。
 */
export function tihuReceiptHoldMs(): number {
  const raw = Number(process.env.TIHU_RECEIPT_MS ?? RECEIPT_SECONDS * 1000)
  if (!Number.isFinite(raw) || raw <= 0) return RECEIPT_SECONDS * 1000
  return clampInt(raw, 50, 30_000)
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

/** 只用于新增配置读取；避免把新的 process 全局引用计入既有 TS2591 基线。 */
const tihuRuntimeEnv = (globalThis as any).process?.env ?? {} as Record<string, string | undefined>

/* ---------- 电脑端（DSH 主 GUI）会话 → 屏幕上的「外部任务」（2026-11-09） ----------
 *
 * 需求：电脑端新建/运行的会话也要同步到鹈鹕屏，两端状态一致。做法不是新造一套同步，
 * 而是把「会话」当成登记簿里的一种任务（`source: 'pc'`），复用棋盘/计数/播报/详情：
 *   - 只读镜像：绝不派单、绝不往会话里投 prompt、绝不触发派单尾巴；
 *   - 数据源还是现有的 `sessionList`（sessions.list / query.listSessions），过滤掉
 *     指挥会话与已被派单任务绑定的会话，避免同一会话两张卡；
 *   - 状态只看会话自己：15 秒内有活动或 turn 在跑＝执行中，空闲＝完成，
 *     刚建好还没说过话＝排队。
 */

/** 「在跑」判定窗口：最近 15 秒内有活动，或 agent 的 turn 还在跑。 */
export const PC_ACTIVE_WINDOW_MS = 15_000
/**
 * 已经显示成「执行中的那一条」还被允许算作在跑的更宽窗口（默认 90 秒）。
 * 电脑端 CU 会话一步要等用户在这侧点屏幕（`computer_use` 就是等 GUI 动作），
 * 15 秒一过就把卡抖成「完成 → 执行中」：抖一次「已用」与时长环就归零一次，
 * 屏上看见的就是「已用 0s 永远不动」——所以抖完前先用这个更宽的窗口接着算。
 */
export const PC_RUNNING_STILL_MS = 90_000
/** 电脑端会话上屏窗口：与登记簿自动归档同口径（静置 3 天内还值得看一眼）。 */
export const PC_SESSION_WINDOW_MS = DONE_KEEP_MS
/** 刚建好、还没发过一句话的会话最多以「排队」占位多久（再久就不占棋盘了）。 */
export const PC_QUEUED_WINDOW_MS = 10 * 60_000
/** 同时上屏的电脑端会话上限：每页 4 条，得给鹈鹕派单的任务留位置。 */
export const PC_SESSION_MAX = 6

/**
 * 电脑端会话的轮询间隔（毫秒，默认 10 秒）。
 *
 * 轮询**不代表**每 10 秒就扫一遍全部会话：真正的列表请求走 `collectSessionRows()`，
 * 由 `sessionListTtlMs`（默认 60 秒）节流；这里只负责「把缓存里的状态重新推导一遍」
 * （15 秒无活动 → 完成、新会话上屏、会话没了就归档）。
 */
export function tihuPcSyncMs(): number {
  const raw = Number(tihuRuntimeEnv.TIHU_PC_SYNC_MS ?? 10_000)
  if (!Number.isFinite(raw)) return 10_000
  return clampInt(raw, 1_000, 5 * 60_000)
}

/**
 * 电脑端会话的展示名：cwd 的项目名（与项目卡片同一套别名）→ 目录末段 → 电脑端。
 * 屏幕副行固定写成「电脑端 · <这个名字>」，所以这里不返回「电脑端」以外的兜底词。
 */
export function externalProjectNameOf(cwd: string | undefined): string {
  const folder = String(cwd ?? '').trim()
  if (folder === '') return ''
  const parts = folder.split(/[\\/]+/).filter(Boolean)
  const tail = parts.length === 0 ? '' : String(parts[parts.length - 1])
  const named = projectNameOf(folder)
  if (named !== '' && named !== '其他') return named
  return tail
}

/** WAV 原始语音质量：在增益前判静音/低质量，避免归一化把底噪伪装成清晰语音。 */
export function inspectTihuVoiceWav(audioBase64: string): { kind: 'ok' | 'review' | 'reject'; reason: string } {
  try {
    const BufferCtor = (globalThis as any).Buffer
    const buffer = BufferCtor.from(String(audioBase64 ?? ''), 'base64')
    const info = parseWav(buffer)
    if (info === null || info.sampleRate !== 16000 || info.channels !== 1 || info.bits !== 16) return { kind: 'reject', reason: '音频格式不受支持' }
    const count = Math.floor(info.dataBytes / 2)
    if (count < 1600) return { kind: 'reject', reason: '录音太短' }
    let mean = 0
    for (let i = 0; i < count; i += 1) mean += buffer.readInt16LE(info.dataOffset + i * 2) / 32768
    mean /= count
    let energy = 0
    let peak = 0
    const frameSamples = 320
    let voicedFrames = 0
    let frames = 0
    for (let start = 0; start < count; start += frameSamples) {
      const end = Math.min(count, start + frameSamples)
      let frameEnergy = 0
      for (let i = start; i < end; i += 1) {
        const value = buffer.readInt16LE(info.dataOffset + i * 2) / 32768 - mean
        energy += value * value
        frameEnergy += value * value
        peak = Math.max(peak, Math.abs(value))
      }
      frames += 1
      if (Math.sqrt(frameEnergy / Math.max(1, end - start)) >= 0.006) voicedFrames += 1
    }
    const rms = Math.sqrt(energy / Math.max(1, count))
    const voicedMs = Math.round((voicedFrames * frameSamples / 16000) * 1000)
    if (peak < 0.001 || (rms < 0.003 && voicedMs < 100)) return { kind: 'reject', reason: '没有听到有效人声' }
    if (info.durationMs < 600 || voicedMs < 300 || voicedFrames / Math.max(1, frames) < 0.08) return { kind: 'review', reason: '声音较短或较弱，请确认后发送' }
    return { kind: 'ok', reason: '' }
  } catch {
    return { kind: 'reject', reason: '音频无法解析' }
  }
}

/** 自动发送只是 UX 门：白名单只读意图才自动，其余由用户显式发送，真正安全仍由工具闸兜底。 */
export function tihuVoiceAutoEligible(text: string): boolean {
  const value = String(text ?? '').trim()
  if ([...value].length < 2) return false
  if (/(删除|删掉|清空|格式化|写|修改|移动|覆盖|安装|卸载|运行|执行|脚本|重启|停止|关闭|结束|发送|发布|提交|推送|转账|支付|归档|commit|push|deploy|\brm\b|\bdel\b)/i.test(value)) return false
  return /^(?:请|帮我|麻烦)?(?:查看|看|读取|读|查询|查|搜索|总结|解释|翻译|列出|汇报|告诉|分析|什么|怎么|哪|现在|目前)/.test(value)
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
  /**
   * 统一指挥模式（2026-11-09 起是默认）：设备只绑指挥会话，说话走派单器，
   * 屏上是任务棋盘。显式 `?session=` 或 `auto: true` 的老路径把它置 false（逃生口保留）。
   */
  unified: boolean
  /** 屏上正在看哪条任务详情（进度事件据此只刷新这一屏）。 */
  focusedTask?: string
  /** 屏停在棋盘上（只有它才跟着登记簿自动重画）。 */
  onBoard?: boolean
  /** 这台设备现在停在哪一屏（sendFrame 记的；进度页每秒重画与回主页计时都按这份判）。 */
  screenStage?: string
  /** 朗读结束后 60 秒自动回棋盘的计时器（任何交互都取消）。 */
  homeTimer?: ReturnType<typeof setTimeout>
  /** 这个计时器是为哪条任务装的（undefined＝指挥会话的回答屏）。 */
  homeTask?: string
  /** 歧义追问待选：用户下一句「一 / 二」就是在答它。 */
  pendingPick?: { candidates: { id: string; name: string; folder?: string }[]; text: string }
  /**
   * 会话衔接澄清待答（只问一次）：用户下一句「一/二」或在屏上点选。
   * `sessionId` 空串表示没有可接着的候选（这时不会问，直接新建）。
   */
  pendingClarify?: {
    text: string
    card: { id: string; name: string; folder?: string }
    sessionId: string
    sessionTitle: string
    confidence: number
    /** 项目命中方式（写 lane.log 用）。 */
    via: string
  }
  /** 派单回执自动回棋盘的计时器（任何交互都取消它）。 */
  receiptTimer?: ReturnType<typeof setTimeout>
  /** 页面选中的音色（default / 克隆音色名）。 */
  voice: string
  /** edge-tts 兜底音色（在线兜底）。 */
  edgeVoice: string
  /** 仅离线：禁用 edge-tts。 */
  offlineOnly: boolean
  /** 绑定代际：手动操作使所有旧自动绑定失效；自动操作另有独立代际供超时失效。 */
  bindEpoch: number
  autoBindEpoch: number
  /** 语音输入代际：重说/新输入/换绑会使未完成 ASR 与待发送草稿失效。 */
  voiceAttempt: number
  /** 正在构造并行任务/提交输入：此间其他 turn 不得自动换绑。 */
  commitInFlight: boolean
  cancelAsr?: () => void
  pendingVoice?: {
    attempt: number
    text: string
    sessionId: string
    autoEligible: boolean
    timer?: ReturnType<typeof setTimeout>
  }
  voiceUi?: {
    roundKey: string
    round: number
    phase: 'preparing' | 'playing' | 'finished'
    alert: string
    playingStage: string
    degraded: boolean
    failedSegments: Set<number>
    waitSeconds: number
    startedAt: number
    timer?: ReturnType<typeof setTimeout>
  }
  send: (type: string, payload: unknown) => void
  close: () => void
  /** 中止该设备当前这一轮朗读（换绑/断开/停止/重读/P0 打断时调用）：后续音频不再下发。 */
  cancelRound?: () => void
  /**
   * 朗读轮次号：每次开始念/被打断都 +1。合成循环每发一块前对一次号，
   * 号变了就立刻停手——「停止/重读」才能真正掐断正在下发的那一轮 PCM。
   */
  speakEpoch?: number
  /**
   * 这条设备当前正在念正文的那条完成任务（完成页朗读）。
   * 有它就说明「屏上这份完整正文已经在这台设备上念过了」，P1 播报不再补念
   * 一遍「标题——第一句」（那正是朗读只念到第一句的直接原因）。
   */
  doneReadingTask?: string
  /** 棋盘翻页页码（0 起）；每页 4 条，用户点「上一页/下一页」就地改这一条。 */
  boardPage?: number
  /** 这台设备的棋盘上有没有「在跑」的行（决定棋盘时长弧需不需要按时钟重发）。 */
  boardHasRunning?: boolean
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
  /** 控制室卡片巡检间隔（毫秒，0 = 关闭；缺省走 tihuHomeSyncMs()/环境变量）。 */
  homeSyncMs?: number
  /** 语音预览自动发送延迟（默认 2000ms；测试可注入，不属于设备协议）。 */
  previewDelayMs?: number
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
  stats: () => { devices: number; activeSessions: string[]; tasks: number }
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

/** 不同宿主投影里的工作区 id；只读提取，不注册、不改绑定。 */
function workspaceIdOf(source: any): string | undefined {
  const header = source?.header ?? source
  const value = header?.workspaceId ?? source?.workspaceId ?? source?.workspace?.id
  return typeof value === 'string' && value !== '' ? value : undefined
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
  /** 子代理血缘：父会话 id（header.parentSession；只有 origin=subagent 才有）。 */
  parentSession?: string
  /** 子代理来源标记（header.origin，实测取值 'subagent'）。 */
  origin?: string
  workspaceId?: string
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

/* ---------- lane 详细日志（投递失败的**真实异常**，不只靠宿主 console） ---------- */

/** 单文件上限：超过就截断重开（重启后排查只需要最近一段）。 */
export const TIHU_LANE_LOG_MAX_BYTES = 2 * 1024 * 1024

/** 日志路径：`$TIHU_LANE_LOG`（测试/排查用）→ `$DSH_HOME/tihu/lane.log` → `~/.dsh/tihu/lane.log`。 */
export function tihuLaneLogPath(): string {
  const override = String(process.env.TIHU_LANE_LOG ?? '').trim()
  if (override !== '') return override
  const dshHome = String(process.env.DSH_HOME ?? '').trim()
  return join(dshHome !== '' ? dshHome : join(homedir(), '.dsh'), 'tihu', 'lane.log')
}

/** 异常 message（换行压成空格；空 message 给个可检索的占位）。 */
function compactErrorText(error: unknown): string {
  const text = String((error as Error)?.message ?? error ?? '').replace(/\s+/g, ' ').trim()
  return text === '' ? 'unknown error' : text
}

/**
 * 追加一条投递失败记录：时间 + sessionId + 真实 message + stack 首行（外加首个 at 帧）。
 *
 * 日志写失败（磁盘满/权限）绝不影响投递本身；单文件超过 2MB 先清空再写。
 */
export function appendTihuLaneLog(sessionId: string, error: unknown, note = ''): string {
  const message = compactErrorText(error)
  const stackLines = String((error as Error)?.stack ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const stackHead = stackLines[0] ?? ''
  const stackFrame = stackLines.find((line) => line.startsWith('at ')) ?? ''
  const parts = [
    `[${new Date().toISOString()}]`,
    `session=${sessionId}`,
    ...(note === '' ? [] : [`note=${note}`]),
    `message=${JSON.stringify(message)}`,
    ...(stackHead === '' ? [] : [`stack=${JSON.stringify(stackHead)}`]),
    ...(stackFrame === '' || stackFrame === stackHead ? [] : [`frame=${JSON.stringify(stackFrame)}`]),
  ]
  const line = `${parts.join(' ')}\n`
  try {
    const file = tihuLaneLogPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > TIHU_LANE_LOG_MAX_BYTES) writeFileSync(file, '', 'utf8')
    } catch { /* 文件还不存在 */ }
    appendFileSync(file, line, 'utf8')
  } catch { /* 日志失败不影响功能 */ }
  return line
}

/** 屏上一行硬截断（中文正文一行约 18 字；英文异常也不许把整屏吃掉）。 */
function clipScreenBullet(value: unknown, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

/** 设备屏第二行：一句 ≤20 字的真实原因摘要（常见宿主异常翻成中文，其余截原文）。 */
export function screenReasonOf(error: unknown): string {
  const message = compactErrorText(error)
  const rules: Array<[RegExp, string]> = [
    [/archiv|归档/i, '会话已归档'],
    [/not loaded|unload|未加载|没加载|加载失败/i, '会话没加载'],
    [/no such|not found|missing|不存在|找不到/i, '会话不存在'],
    [/busy|in progress|locked|正忙/i, '会话正忙'],
    [/timeout|timed out|超时/i, '响应超时'],
    [/permission|denied|forbidden|没权限|无权限|权限/i, '没有权限'],
    [/closed|disconnect|断开/i, '连接断了'],
    [/create|创建|新建|建不/i, '建不出会话'],
  ]
  for (const [pattern, reason] of rules) if (pattern.test(message)) return reason
  return clipScreenBullet(message, 20)
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
  /**
   * 运行中的 turn 跟踪：sessionId → turn/start 时间戳。
   * 任务（派单/电脑端）的完成判定、棋盘状态都从它读；没有设备的会话也要跟。
   */
  const runningSessions = new Map<string, number>()
  /**
   * 主回合已结束、等子代理跑完的任务：存下主回合的结论（完成屏/播报在子代理全结束后才出）。
   * 不入登记簿持久化：进程重启后最多重算一次（子代理本就不跨进程）。
   */
  const deferredReplies = new Map<string, { reply: string; resultLine: string }>()
  /** 子代理收敛的周期检查（事件漏收时兜底；2 秒一次，只扫有会话的任务）。 */
  let childReconcileTimer: ReturnType<typeof setInterval> | undefined
  /** 事件里带来的会话模式（preset）：列表缓存有 60s TTL，刚建的会话只能靠它判 CU。 */
  const sessionPresets = new Map<string, string>()
  /** 会话 id → 最近一条 assistant 原文（电脑端会话的完成摘要取自它）。 */
  const lastAssistant = new Map<string, ProjectReply>()
  /** 会话 id → 屏幕进度状态（步骤计数 / 用时 / 上一步结果）：屏 4 详情的数据源。 */
  const progressStates = new Map<string, TihuProgressState>()
  let disposed = false
  /* ---------- 任务登记簿（统一指挥会话的唯一事实源，2026-11-09） ----------
   *
   * 屏（棋盘/详情/待决策/完成）与播报全部按**任务 id** 取数：会话只是任务的一个字段。
   * 2026-11-09 第二轮：旧 session-follow 界面（项目主页/最近回答/翻页/气泡/回答滚动）
   * 已整体删除——设备永远只有新的七屏，绝无回退路径。
   */
  const tasks = new TaskLedger((line) => appendTaskJournal(line))
  /** 播报队列（P0 插队 / P1·P2 八秒合并 / P3 不播）。 */
  const notifyBus = new TaskNotifyBus()
  /** 唯一指挥会话 id（懒建一次；建不出来就直接上错误屏，不退回旧壳）。 */
  let commanderSessionId: string | undefined
  /**
   * 正在等指挥台判项目的那句话（用户 2026-11-10：**不设超时**，一直等到它回）。
   *
   * 屏上每秒重画「已等 N 秒」；用户按「主页」回棋盘时判断照旧在后台跑，
   * 只停止往屏上刷这一帧（`device.onBoard` 守门），任务卡仍留在棋盘排队区。
   */
  let commanderWait: {
    text: string
    key: string
    taskId: string
    startedAt: number
    ticker: ReturnType<typeof setInterval>
  } | undefined
  /**
   * 已上棋盘、还在等指挥台判项目的排队卡（字面归一化 key → taskId）。
   * 指挥台晚到的 dispatch 按这句话认领同一张卡：**taskId 不变**，绝不新建第二张。
   * 不设过期时间：用户拍板「一直等到判出结果」，卡只在转正 / 彻底失败 / 卸载时摘掉。
   */
  const pendingCommanderTask = new Map<string, { taskId: string; at: number }>()
  /**
   * 已经投给指挥台、正等它回「一行 JSON 结论」的那几句话（FIFO）。
   *
   * 2026-11-10 实机事故：指挥会话没有挂载 tihu 的 dispatch 工具，收到判断请求后
   * 自己把活做了（1 分 34 秒），排队卡永远转不正。现在指挥台**纯文本**只回一行
   * JSON，lane 收到 assistant/message 或 turn/end 后本地解析并派单；这里记录
   * 「哪句话在等哪个结论」，turn/end 时用 `askedAt` 卡住旧回复（空回复不许拿上
   * 一轮的 JSON 冒充结论）。
   */
  interface CommanderAsk {
    key: string
    text: string
    /** project＝慢路径判项目（有排队卡）；continuity＝灰区判「接着哪条」。 */
    kind: 'project' | 'continuity'
    /** 慢路径的排队卡：转正时 taskId 必须不变。 */
    taskId?: string
    /** 灰区已知的项目卡。 */
    card?: { id: string; name: string; folder?: string }
    candidates?: readonly TihuSessionCandidate[]
    confidence?: number
    via: string
    askedAt: number
    /** 这次提问落到指挥会话的第几轮（turn/start 时认领）：多句排队时不会互相抢回复。 */
    turn?: number
  }
  const commanderAsks: CommanderAsk[] = []
  /** 已经结算过回复的指挥会话 turn（防止同一轮的 turn/end 再顶替下一句等待）。 */
  const commanderTurnReplied = new Set<number>()
  /**
   * 超时兜底已经派过的一句（按字面归一化后的 key）：指挥会话晚到的同一条 dispatch
   * 不能再建第二条任务。只挡模型这条入口，快路径重复说同一句不受影响。
   */
  let fallbackDispatch: { key: string; taskId: string; at: number } | undefined
  /** 兜底去重窗口：模型最晚也就一两分钟才回（实测 TTFT 55s），5 分钟足够。 */
  const FALLBACK_DEDUPE_MS = 5 * 60_000
  /**
   * 灰区（会话衔接判不准）交给指挥台判一次的计时器：到点还没派出就按「一次澄清」处理。
   * 与「等指挥台判项目」分开：那一步不设超时，这里只是「接着哪条」的二次确认。
   */
  let grayFallback: {
    text: string
    key: string
    card: { id: string; name: string; folder?: string }
    confidence: number
    via: string
    timer: ReturnType<typeof setTimeout>
  } | undefined
  /** 会话衔接澄清的屏上计时器（只问一次；到点按新建）。 */
  let clarifyTimer: ReturnType<typeof setTimeout> | undefined
  /** 已经问过澄清的句子（字面归一化 key → 问的时刻）：同一条任务不许重复追问。 */
  const clarifyAsked = new Map<string, number>()
  /** 重复追问窗口外的旧记录可以清掉（10 分钟足够覆盖一条任务）。 */
  const CLARIFY_ONCE_MS = 10 * 60_000
  /* ---------- 电脑端会话镜像（source='pc'）的运行时状态 ---------- */
  /** 电脑端会话 id → 登记簿里的短号（`p1`…）：轮询与事件都按它认领任务。 */
  const pcTaskOfSession = new Map<string, string>()
  /** 用户撤掉的外部任务：同一会话没有更新的动静前，轮询不再把卡片放回来。 */
  const pcDismissedAt = new Map<string, number>()
  /** 电脑端会话最近一次事件时刻：列表缓存里的 lastPromptAt 不包含助手回复/工具步骤。 */
  const pcActivityAt = new Map<string, number>()
  /**
   * 这一轮跑起来的锚点（taskId → 时刻）。
   *
   * 「已用 …」和棋盘上那条时长弧都按它算。**先到先记**：旧实现把「列表里最后活动时间 /
   * 事件到达的此刻」当锚点反复回填，于是电脑端 CU 会话跑一步等用户在这侧点屏幕能空几十秒 ——
   * 每一次回填都把「已用」抹成 0s，屏上就是「tok 数在动，第 0 步 · 已用 0s 永远不动」
   * （2026-11-10 用户实机反馈）。只有真正的 `turn/start` 才容许换锚点（那才是新一轮）。
   */
  const runAnchorAt = new Map<string, number>()
  /**
   * 会话这一轮已经结束（sessionId → turn/end 时刻）。
   *
   * 用户 2026-11-10 实机：turn/end 之后列表投影里「最后一次发言时间」还在 15 秒活动窗口里，
   * 旧轮询把它当成「在跑」→ 已结束的会话又抖回执行中（顺带清掉 finishedAt、把「已用」的
   * 起点挪走），设备重连还会按这个旧状态自动跳进度页。有这条记录之后，活动再新也不算在跑；
   * 真来了新一轮（turn/start 或更新的发言时间）才作废。
   */
  const turnEndedAt = new Map<string, number>()
  /** 任务这一轮已经结束（taskId → turn/end 时刻）：「已用」到这里停住，不再跨回合累计。 */
  const runEndedAt = new Map<string, number>()
  /** 进度页看门狗：taskId → 最近一次真实进度事件（打开进度页也算一次）。 */
  const progressEventAt = new Map<string, number>()

  /** 定锚点：`reset = true` 只由真实的新一轮调用（其它一律不许把锚点往后挪）。 */
  function noteRunAnchor(taskId: string, at: number, reset = false): void {
    if (!Number.isFinite(at) || at <= 0) return
    if (reset) {
      runAnchorAt.set(taskId, at)
      return
    }
    const known = runAnchorAt.get(taskId)
    if (known === undefined || known <= 0 || at < known) runAnchorAt.set(taskId, at)
  }

  /** 这条任务已经跑了多久（毫秒）：完成/回合结束后封顶在结束那一刻；没有锚点就从「现在」起算。 */
  function elapsedOfTask(task: TihuTask, sessionId?: string): number {
    let anchor = runAnchorAt.get(task.taskId)
    if (anchor === undefined || anchor <= 0) {
      const candidates = [task.startedAt, sessionId === undefined ? undefined : runningSessions.get(sessionId)]
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
      anchor = candidates.length > 0 ? Math.min(...candidates) : Date.now()
      runAnchorAt.set(task.taskId, anchor)
    }
    // 用户 2026-11-10：回合结束「已用」立刻停住，不许再长（实机那行「已用 3m28s」就是
    // 完成之后还在按 now 算、把好几轮累加出来的）。
    const endedAt = runEndedAt.get(task.taskId) ?? task.finishedAt
    const end = endedAt !== undefined && Number.isFinite(endedAt) && endedAt > 0
      ? Math.min(Date.now(), endedAt)
      : Date.now()
    return Math.max(0, end - anchor)
  }

  /**
   * 电脑端这一轮的起点：优先「本进程看到的 `turn/start`」→ 列表投影的 lastPromptAt →
   * 兜底此刻。写进登记簿时必须用它，不能用「此刻」（那让「已用」与时长环反复归零）。
   */
  function pcStartAnchorOf(sessionId: string, fallback = Date.now()): number {
    const turn = runningSessions.get(sessionId)
    if (turn !== undefined && Number.isFinite(turn)) return turn
    const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId)
    const prompted = Number(row?.updatedAt ?? 0)
    if (Number.isFinite(prompted) && prompted > 0) return prompted
    return fallback
  }
  /** 电脑端会话轮询定时器（只在有统一指挥设备在线时跑）。 */
  let pcSyncTimer: ReturnType<typeof setInterval> | undefined
  /** 同一时刻只跑一次同步：轮询与 hello 撞车时后到的直接并入这一次。 */
  let pcSyncing = false
  /** 播报定时器（每台设备共用一条队，串行念）。 */
  let announceTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * P1/P2 合并窗口的「最早可取」时刻。
   *
   * 任务总线单条只等 400ms；但一条完成落袋时若还有别的任务在跑，就等满 8 秒再取，
   * 让同一批的后续完成并进同一句（否则「三件事完了」永远凑不齐）。
   * P0 一律清零：要人的话不能等。
   */
  let announceHoldUntil = 0
  /** 播报预录缓存（`~/.dsh/tihu/preroll/`）：同一句话第二次念不再合成。 */
  const preroll = new TihuPreroll()
  /** 正在念播报的设备（避免一条播报被两台设备重复合成）。 */
  const announcing = new Set<string>()

  /**
   * 打断该设备当前这一轮朗读：轮次号 +1，合成循环每发一块前对号，号变即停。
   * 「停止」之后不会再冒出新的 PCM（否则页面停了声音还在响、高亮却冻住，就是新的不同步）。
   */
  function cancelSpeaking(device: TihuDevice): void {
    device.speakEpoch = (device.speakEpoch ?? 0) + 1
    announcing.delete(device.id)
    // 正文这一轮被打断了：别再把它记成「已经念过」，否则后面的播报会一起被吞掉。
    device.doneReadingTask = undefined
  }
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
  /** 本地 TTS sidecar（独立进程；Kokoro 主引擎，缺模型/依赖时 available=false，页面走系统语音）。 */
  const tts = options.tts?.instance ?? new TihuTts({
    log,
    workspaceOf: options.workspaceOf,
    ...(options.tts?.threads === undefined ? {} : { threads: options.tts.threads }),
    ...(options.tts?.disabled === true ? { disabled: true } : {}),
    ...(options.tts?.port === undefined ? {} : { port: options.tts.port }),
    ...(options.tts?.paths === undefined ? {} : { paths: options.tts.paths }),
  })
  /**
   * 只对**显式常驻**的后端预热（`TIHU_TTS_ENGINE=kokoro` 或遗留 qwen）。
   * edge 主用时 backend() 恒为 none → 这里什么都不做：Kokoro 的 ~300MB 模型和 4 个线程
   * 只有在离线兜底真的触发、或用户手切 Kokoro 音色时（ensureKokoroServer）才允许拉起。
   */
  if (options.tts?.prewarm === true && options.tts?.disabled !== true && tts.backend() !== 'none') {
    void tts.ensureServer().catch((error) => log(`tihu tts prewarm failed: ${(error as Error)?.message ?? String(error)}`))
  }

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


  /** 列表缓存：hello / 电脑端同步 / findSession 共用，60 秒内不重复列（避免每次开页都全量扫）。 */
  let sessionListCache: { at: number; rows: TihuSessionRow[]; source: 'sessionQuery' | 'live' } | undefined

  /** 会话标题：投影（权威）→ 标题缓存 → 列表缓存 → 短 id 兜底。 */
  function titleForSession(sessionId: string): string {
    const live = liveSessionOf(sessionId)
    const projected = live === undefined ? undefined : titleOf(live)
    if (projected !== undefined && projected !== '') return projected
    const cached = titleCache.get(sessionId)?.title
    if (cached !== undefined && cached !== '') return cached
    const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId)
    if (row?.title !== undefined && row.title !== '') return row.title
    return shortSessionId(sessionId)
  }

  /** 取活会话对象：服务缺失或查不到就给 undefined。 */
  function liveSessionOf(sessionId: string): any {
    const sessions = optionalService(ctx, 'sessions')
    if (sessions === undefined || typeof sessions?.get !== 'function') return undefined
    try {
      const live = sessions.get(sessionId)
      return live === undefined || live === null ? undefined : live
    } catch { return undefined }
  }

  /**
   * 发一帧屏。
   *
   * 统一指挥之后只有这七屏（棋盘/回执/唤醒/进度详情/待决策/完成/追问）：这里只负责把帧发给设备
   * 并记一份「这台设备最后看到的那屏」（控制面诊断用），不再补旧气泡、不再恢复旧会话屏。
   */
  /** 屏帧的公共出口：记下这台设备现在停在哪一屏（进度页刷新与回主页计时都按这份判）。 */
  function pushFrame(device: TihuDevice, frame: ScreenFramePayload): void {
    device.screenStage = frame.stage
    device.send('screen.frame', frame)
  }

  function sendFrame(device: TihuDevice, frame: ScreenFramePayload, sessionId?: string): void {
    const outgoing: ScreenFramePayload = { ...frame, bullets: frame.bullets ?? [] }
    lastFrames.set(sessionId ?? device.sessionId ?? device.id, outgoing)
    pushFrame(device, outgoing)
  }

  const sessionListTtlMs = (): number => clampInt(Number(tihuRuntimeEnv.TIHU_SESSION_LIST_TTL_MS ?? 60_000), 100, 600_000)
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

  /* ---------- 子代理（subagent）血缘与在跑计数 ----------
   *
   * 宿主数据（2026-11-10 实测 DSH 4 的 session 存储）：
   *   - 子会话的 header 带 `parentSession`（父会话 id）、`origin: 'subagent'`、
   *     `delegationDepth`；`sessionQuery.listSessions()` 原样带回来；
   *   - 父会话的投影 `subagentCatalog` 是「直接子级清单」，但**不含运行状态**；
   *   - 在跑状态从 agent 注册表拿：`ctx.agents.list()` 的 `agent.status: 'idle' | 'running'`，
   *     与宿主 `workspace/session-activity` 判断「running subagent descendants」同一口径
   *     （沿 parentSession + origin=subagent 走到任意深度，只看 status=running）。
   * 因此这里优先用 agents 注册表；拿不到时退回「会话行血缘 + session/event 的 runningSessions」。
   */

  function headerOfSession(source: any): any {
    return source?.header ?? source
  }

  /** 一条活 agent 的会话 id（agent.session.header.id / agent.id）。 */
  function agentSessionIdOf(agent: any): string | undefined {
    const header = headerOfSession(agent?.session)
    if (typeof header?.id === 'string' && header.id !== '') return header.id
    return typeof agent?.id === 'string' && agent.id !== '' ? agent.id : undefined
  }

  /** 活 agent 列表（拿不到给 undefined，调用方退回会话行 + runningSessions）。 */
  function liveAgentList(): any[] | undefined {
    const registry = optionalService(ctx, 'agents') as { list?: () => any[] } | undefined
    try {
      if (typeof registry?.list !== 'function') return undefined
      const listed = registry.list()
      return Array.isArray(listed) ? listed : undefined
    } catch { return undefined }
  }

  /**
   * 这条会话（含任意深度后代）里正在跑的子代理数量。
   * 只数 `origin=subagent` + `parentSession` 血缘；fork 出来的会话不算（它是另一段对话）。
   */
  function runningSubagentCountOf(sessionId: string, agents: any[] | undefined = liveAgentList()): number {
    if (sessionId === '') return 0
    if (agents !== undefined) {
      const childrenOf = new Map<string, any[]>()
      for (const agent of agents) {
        const header = headerOfSession(agent?.session)
        const parent = header?.parentSession
        if (typeof parent !== 'string' || parent === '') continue
        if (header?.origin !== 'subagent') continue
        const siblings = childrenOf.get(parent) ?? []
        siblings.push(agent)
        childrenOf.set(parent, siblings)
      }
      let running = 0
      const pending = [sessionId]
      const visited = new Set<string>([sessionId])
      while (pending.length > 0) {
        const parentId = pending.shift() as string
        for (const child of childrenOf.get(parentId) ?? []) {
          const childId = agentSessionIdOf(child)
          if (childId === undefined || visited.has(childId)) continue
          visited.add(childId)
          if (child.status === 'running' || (child.status === undefined && runningSessions.has(childId))) running += 1
          pending.push(childId)
        }
      }
      return running
    }
    // 退化路径：没有 agents 注册表（老宿主/轻量桩）时，用缓存的会话行血缘 + 事件里的在跑集合。
    const rows = sessionListCache?.rows ?? []
    const childrenOf = new Map<string, TihuSessionRow[]>()
    for (const row of rows) {
      if (row.origin !== 'subagent' || row.parentSession === undefined) continue
      const siblings = childrenOf.get(row.parentSession) ?? []
      siblings.push(row)
      childrenOf.set(row.parentSession, siblings)
    }
    let running = 0
    const pending = [sessionId]
    const visited = new Set<string>([sessionId])
    while (pending.length > 0) {
      const parentId = pending.shift() as string
      for (const child of childrenOf.get(parentId) ?? []) {
        if (visited.has(child.sessionId)) continue
        visited.add(child.sessionId)
        if (runningSessions.has(child.sessionId)) running += 1
        pending.push(child.sessionId)
      }
    }
    return running
  }

  /** 从一条会话沿 parentSession 往上走，返回它自己与全部祖先（用于把子代理事件归到任务）。 */
  function ancestorSessionIdsOf(session: any, sessionId: string): string[] {
    const chain: string[] = [sessionId]
    const seen = new Set<string>([sessionId])
    let current = session
    for (let depth = 0; depth < 32; depth += 1) {
      const header = headerOfSession(current)
      const parent = header?.parentSession
      if (typeof parent !== 'string' || parent === '' || seen.has(parent)) break
      chain.push(parent)
      seen.add(parent)
      const live = liveSessionOf(parent)
      current = live ?? sessionListCache?.rows.find((row) => row.sessionId === parent)
      if (current === undefined) break
    }
    return chain
  }

  /**
   * 子代理的 turn 起落：把它所有祖先里的任务重新算一遍「在跑子任务数」；
   * 挂起的任务在归零时补完成（主回合的结论已经存下，不会丢）。
   */
  function reconcileTasksForChild(session: any, childId: string, at: number): void {
    for (const ancestorId of ancestorSessionIdsOf(session, childId).slice(1)) {
      const task = tasks.ofSession(ancestorId)
      if (task === undefined) continue
      const running = runningSubagentCountOf(ancestorId)
      if (tasks.setChildRunning(task.taskId, running, at)) refreshBoards()
      if (running === 0 && task.holdingForChildren === true) finalizeHeldTask(task, at)
    }
  }

  /**
   * 一条任务真的完成了：落完成态 ＋ 完成屏 ＋ 一句播报。
   *
   * **主回合结束但子代理还在跑时不许走这里**：先 holdForChildren，等子代理全部结束再补。
   * 完成屏的「另有 N 条」也不再按同批折叠（本次改版只留单条完成）。
   */
  function showCompletedTask(task: TihuTask, input: { reply: string; resultLine: string; at: number }): void {
    const resultLine = String(input.resultLine ?? '').trim() || '做完了'
    tasks.complete(task.taskId, { resultLine, now: input.at })
    task.doneText = input.reply
    const frame = doneFrame({
      taskId: task.taskId,
      title: task.title,
      resultLine,
      replyText: input.reply || DONE_NO_REPLY_TEXT,
      bullets: replyBulletsOf(input.reply),
    })
    for (const device of devices) {
      if (!device.unified) continue
      // 回执/追问/待决策是「要人先看清」的屏：完成帧不能夺屏（屏 2/5/7 优先）。
      if (device.receiptTimer !== undefined || device.pendingPick !== undefined) continue
      const focused = device.focusedTask === undefined ? undefined : tasks.get(device.focusedTask)
      if (focused?.state === 'awaiting') continue
      disarmAutoHome(device)
      device.focusedTask = task.taskId
      device.onBoard = false
      sendFrame(device, frame, device.sessionId)
      sendTaskUpdate(device, task)
      readDoneScreen(device, task)
    }
    pushTaskNotify(task, 1, doneAnnouncementOf(task))
    refreshBoards()
  }

  /** 子代理全部结束：把挂起的任务补成「完成」并补发完成屏/播报（用主回合存下的结论）。 */
  function finalizeHeldTask(task: TihuTask, at = Date.now()): void {
    const sessionId = task.sessionIds[task.sessionIds.length - 1]
    const stored = deferredReplies.get(task.taskId)
    deferredReplies.delete(task.taskId)
    const reply = stored?.reply ?? (sessionId === undefined ? '' : cachedAssistantText(sessionId))
    const resultLine = stored?.resultLine ?? task.pendingResultLine ?? (firstSentenceOf(reply) || '做完了')
    task.childRunning = undefined
    task.holdingForChildren = undefined
    task.pendingResultLine = undefined
    showCompletedTask(task, { reply, resultLine, at })
    log(`tihu subagents settled task=${task.taskId} children=0`)
  }

  /**
   * 扫一遍任务与子代理血缘：更新「子任务在跑」计数；挂起的任务在子代理全结束后补完成。
   * 由子代理事件即时触发，另有 2 秒周期兜底（事件漏收/进程晚启动）。
   */
  function reconcileChildTasks(reason: string): void {
    if (disposed) return
    const now = Date.now()
    const agents = liveAgentList()
    let changed = false
    for (const task of tasks.list()) {
      if (task.state === 'archived' || task.state === 'awaiting') continue
      if (task.sessionIds.length === 0) continue
      if (task.state === 'done' || task.state === 'announced') {
        if ((task.childRunning ?? 0) === 0 && task.holdingForChildren !== true) continue
      }
      const sessionId = task.sessionIds[task.sessionIds.length - 1]
      const running = runningSubagentCountOf(sessionId, agents)
      if ((task.childRunning ?? 0) !== running) {
        tasks.setChildRunning(task.taskId, running, now)
        changed = true
      }
      if (running === 0 && task.holdingForChildren === true) {
        finalizeHeldTask(task, now)
        changed = true
      }
    }
    if (changed) {
      refreshBoards()
      log(`tihu subagent reconcile reason=${reason}`)
    }
  }

  /** 有统一设备在线时每 2 秒对一次子代理计数（事件漏收也能收敛）。 */
  function ensureChildReconcile(): void {
    if (childReconcileTimer !== undefined) return
    const timer = setInterval(() => {
      try { reconcileChildTasks('tick') } catch (error) { log(`tihu subagent reconcile failed: ${(error as Error)?.message ?? String(error)}`) }
    }, 2_000)
    timer.unref?.()
    childReconcileTimer = timer
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
        ...(typeof session?.header?.parentSession === 'string' ? { parentSession: session.header.parentSession } : {}),
        ...(session?.header?.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        ...(workspaceIdOf(session) === undefined ? {} : { workspaceId: workspaceIdOf(session) }),
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
    if (!force && sessionListCache !== undefined && now - sessionListCache.at < sessionListTtlMs()) {
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
            ...(typeof record?.header?.parentSession === 'string' ? { parentSession: record.header.parentSession } : {}),
            ...(record?.header?.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
            ...(workspaceIdOf(record) === undefined ? {} : { workspaceId: workspaceIdOf(record) }),
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
            ...(workspaceIdOf(live) === undefined ? {} : { workspaceId: workspaceIdOf(live) }),
            ...(Number.isFinite(live?.header?.createdAt) ? { createdAt: Number(live.header.createdAt) } : {}),
          },
        }
      }
    }
    // 页面选择器给的 id 一定在刚拉过的列表里：**哪怕缓存过期也直接用**，不要为了
    // 校验一次而重新列 1870 条会话——那会让「点一条会话」等好几秒才有反馈。
    const cachedRow = sessionListCache?.rows.find((item) => item.sessionId === sessionId)
    if (cachedRow !== undefined) return { status: cachedRow.live ? 'live' : 'persisted', row: cachedRow }
    let collected: { rows: TihuSessionRow[]; source: 'sessionQuery' | 'live' } | undefined
    try { collected = await collectSessionRows() } catch { collected = undefined }
    // 只有 sessionQuery 才能代表「全部逻辑会话」；退回 live 列表时不能据此判不存在。
    if (collected?.source === 'sessionQuery') {
      const row = collected.rows.find((item) => item.sessionId === sessionId)
      return row === undefined ? { status: 'missing' } : { status: row.live ? 'live' : 'persisted', row }
    }
    // 没有完整列表的轻量宿主/测试桩：活动 agent 也是可核实的证据。
    try {
      const agent = optionalService(ctx, 'agents')?.get?.(sessionId)
      const live = agent?.session
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
            ...(workspaceIdOf(live) === undefined ? {} : { workspaceId: workspaceIdOf(live) }),
            ...(Number.isFinite(live?.header?.createdAt) ? { createdAt: Number(live.header.createdAt) } : {}),
          },
        }
      }
      if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
        return {
          status: 'live',
          row: {
            sessionId, title: titleCache.get(sessionId)?.title ?? '', preset: sessionPresets.get(sessionId) ?? '',
            updatedAt: Date.now(), live: true,
          },
        }
      }
    } catch { /* 继续按 unknown 处理 */ }
    return { status: 'unknown' }
  }



  /** 把已到达的思考文本写进「思考」活动行（文本没变时 applyEarlyThinking 不出帧）。 */
  function flushLiveThinking(sessionId: string): void {
    const buffer = liveThinking.get(sessionId)
    if (buffer === undefined || buffer.text === '') return
    const state = progressStates.get(sessionId)
    if (state === undefined) return
    const update = applyEarlyThinking(state, buffer.text, Date.now(), CONTENT_WIDTH_PX)
    if (update === undefined) return
    // 正在看这条任务进度页的设备：思考文本一变就换最新一行（不等下一个事件）。
    const task = tasks.ofSession(sessionId)
    if (task !== undefined) refreshFocusedDetail(task)
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
  /** 跨端状态文件（控制室卡片的真源）：与 assistant-store 的 profile 目录同一处理。 */
  function projectsStateFile(): string {
    let file = process.env.TIHU_PROJECTS_STATE ?? ''
    if (file !== '') return file
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
    return join(dir, 'dsh-assistant-state.json')
  }

  function projectCards(): TihuCardRow[] | undefined {
    const file = projectsStateFile()
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
   * 写跨端状态（控制室卡片的真源）：
   *   - 只动 `projects.layouts / folders / nameOverrides / order`，不碰 hidden/removed/view；
   *   - 保留文件既有的 `{ projects, view, revision, updatedAt }` 形状，revision 自增
   *     （控制室 800ms push / 3s poll，靠 revision 收敛，不会被这端盖掉）；
   *   - 顺手让卡片缓存失效，下一帧主页/棋盘立刻看到新卡。
   */
  function writeProjectsState(mutate: (projects: Record<string, any>) => boolean): boolean {
    const file = projectsStateFile()
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const projects = raw?.projects ?? raw
      if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return false
      if (!mutate(projects as Record<string, any>)) return false
      const next = raw?.projects === undefined
        ? { projects, view: null, revision: Number(raw?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
        : { ...raw, revision: Number(raw?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
      writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
      cardCache = undefined
      return true
    } catch (error) {
      log(`tihu projects state write failed: ${(error as Error)?.message ?? String(error)}`)
      return false
    }
  }

  /** 布局模板的兜底（'full' 预设的形状，字段与客户端 buildLayout 同名）。 */
  const LAYOUT_DEFAULTS = {
    leftWidth: { default: 260, min: 160, max: 480 },
    chatWidth: { default: 360, min: 240, max: 600 },
    chatWidthRatio: 0.3,
    topHeight: { default: 200, min: 120, max: 480 },
    topHeightRatio: 0.35,
    chatSide: 'right',
    chatFullHeight: false,
    chatHidden: false,
    chatOnly: false,
  } as const

  /**
   * 建卡并双写控制室（设计 §7 第 2 条「新建卡片必须双写」）。
   *
   * 为什么克隆一张既有布局而不是自己拼：卡片布局是客户端的 `LayoutSpec`（窗格/宽度/比例
   * 一堆字段），宿主这边手写一版就等着控制室渲染出半个空壳。克隆现成卡（优先「个人助手」）
   * 保证结构合法；只有一张卡都没有时才退回 `full` 预设的兜底形状。
   */
  function dispatchProjectCard(name: string, folder: string): TihuCardRow | undefined {
    const title = name.trim()
    if (title === '' || folder.trim() === '') return undefined
    const id = `card-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
    let created: TihuCardRow | undefined
    const ok = writeProjectsState((projects) => {
      const layouts = Array.isArray(projects.layouts) ? projects.layouts : []
      const folders = projects.folders !== null && typeof projects.folders === 'object' ? projects.folders : {}
      const overrides = projects.nameOverrides !== null && typeof projects.nameOverrides === 'object' ? projects.nameOverrides : {}
      const order = Array.isArray(projects.order) ? projects.order : []
      const template = layouts.find((layout: any) => layout?.id === ASSISTANT_CARD.id)
        ?? layouts.find((layout: any) => layout !== null && typeof layout === 'object')
      const layout = template === undefined || template === null
        ? { id, title, left: null, top: null, main: [{ id: 'p1', title: '窗口1', min: 200, content: null }], ...LAYOUT_DEFAULTS }
        : { ...JSON.parse(JSON.stringify(template)), id, title }
      projects.layouts = [...layouts, layout]
      projects.folders = { ...folders, [id]: folder }
      projects.nameOverrides = { ...overrides, [id]: title }
      projects.order = [id, ...order.filter((item: unknown) => String(item) !== id)]
      created = { id, name: title, folder }
      return true
    })
    if (!ok || created === undefined) return undefined
    log(`tihu card created id=${created.id} name=${JSON.stringify(title)} folder=${folder}`)
    return created
  }

  /** 按「卡名 / 文件夹关键词」找卡；找不到就建卡（新复杂任务同步控制室）。 */
  function resolveCardForDispatch(hint: string | undefined, text: string): TihuCardRow | undefined {
    const cards = projectCards() ?? []
    const key = String(hint ?? '').trim()
    if (key !== '') {
      const lower = key.toLowerCase()
      const hit = cards.find((card) => card.id === key
        || card.name === key
        || card.name.toLowerCase().includes(lower)
        || String(card.folder ?? '').toLowerCase().includes(lower))
      if (hit !== undefined) return hit
    }
    // 没给 hint（或 hint 不是已知卡）：按原话再嗅一次卡片名
    const scored = cards
      .map((card) => ({ card, ...scoreCardAlias(text, card) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => (b.via === 'name' ? 1 : 0) - (a.via === 'name' ? 1 : 0) || b.score - a.score)
    if (scored.length > 0) return scored[0].card
    if (key === '') return undefined
    // 给了一个具体目录：建一张新卡（复杂任务跟项目卡片走）
    const folder = isAbsolute(key) ? key : join(assistantFolder(), key)
    return dispatchProjectCard(nameFromFolder(key), folder)
  }

  /** 路径最后一级当卡名（`D:/proj/青年基金2027` → `青年基金2027`）。 */
  function nameFromFolder(path: string): string {
    const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean)
    const last = parts.length === 0 ? '' : parts[parts.length - 1]
    return last === '' ? '新项目' : last
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
  async function transcribe(audioBase64: string, externalSignal?: AbortSignal): Promise<string> {
    const speech = optionalService(ctx, 'speechController')
    if (speech === undefined || typeof speech?.transcribe !== 'function') {
      throw new Error('本机语音转写不可用：宿主没有加载 speech 服务（voice-input / speech-to-text 插件）')
    }
    if (!looksLikeWavBase64(audioBase64)) throw new Error('音频不是 WAV（需要 16k 单声道 16bit）')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
    const cancel = (): void => controller.abort()
    if (externalSignal?.aborted) controller.abort()
    else externalSignal?.addEventListener('abort', cancel, { once: true })
    try {
      const audio = new Uint8Array(Buffer.from(audioBase64, 'base64'))
      const result: any = await speech.transcribe({ audio, language: 'auto', audioBase64 }, controller.signal)
      const text = typeof result === 'string'
        ? result
        : String(result?.text ?? result?.transcript ?? result?.result ?? '').trim()
      applyPersonalTerms(loadAssistantConfig().asrTerms)
      return cleanFillers(fixTerms(text)).trim()
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', cancel)
    }
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

  /** 页面「结束本次语音会话」：立刻解除闸门（不等 120 秒窗口过期）。 */
  function endSession(sessionId: string): boolean {
    const existed = activeSessions.delete(sessionId)
    if (existed) log(`tihu session end session=${sessionId}`)
    return existed
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
    const window = sessionId === undefined ? undefined : windowOf(sessionId)
    const last = lastUserMessageId(exec?.agent?.session)
    if (sessionId === undefined) return undefined
    // 派单建立的**任务会话**里的工具调用一律算 tihu 轮：任务在册就受闸门管。
    // 不再依赖 messageId 相等——fallback inject 可能把「正文＋派单尾注」投成两条
    // user 消息，最后一条 id 与 arm 时的第一条不等，旧判定会把整段闸门漏掉。
    const task = tasks.ofSession(sessionId)
    // 电脑端任务（source='pc'）是只读镜像：它的 shell/写文件归电脑端审批，
    // 绝不再当成「鹈鹕语音轮」拦下来（2026-11-09 实测：电脑端 rg/构建被镜像成设备屏待决策）。
    if (task !== undefined && task.source !== 'pc'
      && task.state !== 'done' && task.state !== 'announced' && task.state !== 'archived') return sessionId
    if (window === undefined) return undefined
    if (last === undefined) return sessionId
    // 空 id＝prompt 刚投进去、宿主还没投影出这条 user 消息。此时必须按「tihu 轮」
    // 处理：派单建立的任务会话里工具调用可能抢在 prompt() 返回前发生，漏掉这一步
    // 就会整段绕过危险动作闸（2026-11-09 实测 `pwsh Remove-Item` 无 confirm/audit）。
    if (window.messageId === '') return sessionId
    return last === window.messageId ? sessionId : undefined
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
        if (snapshot.copied) log(`tihu snapshot ${snapshot.relativePath} -> ${snapshot.snapshotPath}`)
      }

      if (action.dangerous) {
        const detail = action.kind === 'shell'
          ? String(command ?? '').slice(0, 300)
          : String(rawTarget ?? target ?? '')
        // 2026-11-09 P0（用户实机反馈）：设备屏**永不显示**命令行与授权请求。
        // 这里只留快照与审计，授权交给电脑端：宿主的 approval/request 面板
        // （托管开着时由托管自动应答；没开就在电脑端处理，绝不再等设备）。
        appendAudit(workspace, {
          ts: new Date().toISOString(),
          source: 'tihu',
          sessionId,
          action: action.kind,
          tool,
          ...(detail === '' ? {} : { target: detail }),
          ...(snapshotRoot === undefined ? {} : { snapshot: snapshotRoot }),
          decision: 'host-approval',
          note: '危险动作交电脑端审批（设备屏不显示授权请求）',
        })
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
   * 一条指令没发出去：告警一行 + 屏上一句可操作的话。
   *
   * 屏上只留两行（正文一行约 18 字）：
   *   1. `friendly`（不传就用异常 message）截到 18 字；
   *   2. 真实原因摘要 ≤20 字（`screenReasonOf`）。
   * 完整异常另有 lane.log（见 appendTihuLaneLog），不指望屏上看得全。
   */
  function showInputError(device: TihuDevice, error: unknown, friendly?: string): void {
    const first = clipScreenBullet(friendly ?? compactErrorText(error), 18)
    const reason = screenReasonOf(error)
    const bullets = first === reason ? [first] : [first, reason]
    device.send('event.alert', { level: 'error', text: `${first}（${reason}）` })
    sendFrame(device, {
      stage: '会话', title: '指令未发送',
      bullets: fitScreenLines(bullets, 3),
      tone: 'alert', mode: 'status',
    } satisfies ScreenFramePayload)
  }

  /**
   * 已完成预览/键盘输入的统一提交口；统一指挥模式下走派单器，老路径仍注当前会话。
   *
   * 返回 true 表示「路由已经自己出了一屏」（回执/追问/棋盘/详情/提示）——调用方
   * 不能再补一条通用的「思考 · 模型处理中」帧，否则屏 2/7 会被 1ms 内盖掉。
   */
  async function routeCommittedText(device: TihuDevice, text: string): Promise<boolean> {
    // 统一指挥（2026-11-09）：设备只绑指挥会话，一句话先过派单器（快路径 → 慢路径），
    // 绝不直接注入「设备当前绑的那条会话」——那正是「得先找到是哪条会话」的老毛病。
    if (device.unified) {
      await dispatchUtterance(device, text)
      const key = device.sessionId
      if (key !== undefined) touchWindow(key)
      return true
    }
    // 统一指挥是唯一路径（2026-11-09）：设备绑的永远是指挥会话，说话只走派单器。
    await dispatchUtterance(device, text)
    const key = device.sessionId
    if (key !== undefined) touchWindow(key)
    return true
  }

  function cancelPendingVoice(device: TihuDevice): void {
    const pending = device.pendingVoice
    if (pending?.timer !== undefined) clearTimeout(pending.timer)
    device.pendingVoice = undefined
  }

  function invalidateVoiceInput(device: TihuDevice): void {
    device.voiceAttempt += 1
    cancelPendingVoice(device)
    try { device.cancelAsr?.() } catch { /* 忽略 */ }
    device.cancelAsr = undefined
  }

  async function commitPendingVoice(device: TihuDevice, pending: NonNullable<TihuDevice['pendingVoice']>): Promise<void> {
    if (device.pendingVoice !== pending || !devices.has(device)) return
    if (pending.attempt !== device.voiceAttempt) { cancelPendingVoice(device); return }
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    device.pendingVoice = undefined
    if (device.sessionId !== pending.sessionId) {
      showInputError(device, new Error(`已切换到：${titleForSession(device.sessionId ?? '')}；请重说一次`))
      return
    }
    await routeCommittedText(device, pending.text)
    device.send('event.progress', { stage: '注入', text: '已送入当前会话' } satisfies ProgressPayload)
  }

  /** ASR 完成后只形成宿主权威草稿；安全白名单才允许约 2 秒自动提交。 */
  function previewVoice(device: TihuDevice, text: string, attempt: number, quality: ReturnType<typeof inspectTihuVoiceWav>): void {
    if (attempt !== device.voiceAttempt || device.sessionId === undefined || !devices.has(device)) return
    cancelPendingVoice(device)
    const sessionId = device.sessionId
    const autoEligible = quality.kind === 'ok' && tihuVoiceAutoEligible(text)
      && !runningSessions.has(sessionId)
    const pending: NonNullable<TihuDevice['pendingVoice']> = { attempt, text, sessionId, autoEligible }
    device.pendingVoice = pending
    device.send('transcript', { text, final: true, source: 'voice', retryable: true } satisfies TranscriptPayload)
    sendFrame(device, {
      stage: '我听到', title: '确认这句指令',
      bullets: fitScreenLines([`我听到：${text}`, quality.kind === 'review' ? quality.reason : autoEligible ? '约 2 秒后自动发送' : '请点发送，或点重说'], 3),
      tone: autoEligible ? 'busy' : 'idle', mode: 'status',
      actions: [{ id: 'send', label: '发送' }, { id: 'retry', label: '重说' }],
    } satisfies ScreenFramePayload, sessionId)
    if (!autoEligible) return
    pending.timer = setTimeout(() => {
      if (device.pendingVoice !== pending) return
      void commitPendingVoice(device, pending).catch((error) => showInputError(device, error))
    }, options.previewDelayMs ?? 2000)
  }

  /** 助手回复 → 完成屏的正文行（去掉 markdown/长路径，最多 3 行短句）。 */
  function replyBulletsOf(reply: string): string[] {
    const text = String(reply ?? '').replace(/\s+/g, ' ').trim()
    if (text === '') return []
    const parts = text.split(/[。！？!?\n]/).map((part) => part.trim()).filter(Boolean)
    return parts.slice(0, 3).map((part) => taskTitleOf(part, 30))
  }

  /** turn 看门狗：turn/end 永远不来时自愈，避免 runningSessions 永久占位。 */
  function pruneStaleTurns(): void {
    const stale = tihuTurnStaleMs()
    const now = Date.now()
    for (const [sessionId, startedAt] of runningSessions) {
      if (now - startedAt < stale) continue
      runningSessions.delete(sessionId)
      log(`tihu stale turn pruned session=${sessionId}`)
    }
  }

  const disposeSession = ctx.on?.('session/event', (session: any, event: any) => {
    try {
      const sessionId = sessionIdOf(session)
      if (sessionId === undefined) return
      const type = String(event?.type ?? '')
      const data = event?.data ?? {}
      const at = Date.now()
      // 活跃时间跟着真实用户发言走（桌面端任何会话发消息都算）：电脑端会话同步靠它判「在跑」。
      if (type === 'user/message' && (data as any)?.source?.kind === 'user') {
        const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId)
        if (row !== undefined) {
          const time = Number.isFinite(event?.time) ? Number(event.time) : at
          row.updatedAt = Math.max(row.updatedAt, time)
          if (sessionListCache !== undefined) sessionListCache.rows = sortSessionRows(sessionListCache.rows)
        }
      }
      const sessionPreset = presetOf(session)
      if (sessionPreset !== '') sessionPresets.set(sessionId, sessionPreset)
      if (type === 'turn/start') {
        runningSessions.set(sessionId, at)
        // 真的开了新一轮：之前那条「这一轮已结束」作废（活动窗口重新有意义）。
        turnEndedAt.delete(sessionId)
        const startedTask = tasks.ofSession(sessionId)
        if (startedTask !== undefined) {
          runEndedAt.delete(startedTask.taskId)
          progressEventAt.set(startedTask.taskId, at)
        }
        stopLiveThinking(sessionId, false)
        // 注意：**不能**在这里点亮 tihu 窗口。用户自己在会话里打字同样会触发 turn/start。
        touchWindow(sessionId)
        for (const device of devices) {
          if (device.sessionId !== sessionId) continue
          if (device.voiceUi?.timer !== undefined) clearTimeout(device.voiceUi.timer)
          device.voiceUi = undefined
        }
      } else if (type === 'turn/end') {
        runningSessions.delete(sessionId)
        // ---------- 用户 2026-11-10：turn/end 时必须把「在跑」与活动行一起清掉 ----------
        // 1) 这一轮已结束（列表投影里的「最近发言时间」再新也不算在跑）；
        // 2) 「本次活动」时刻作废：旧轮询用 15/90 秒活动窗口又把已完成的会话 syncExternal 回
        //    running，屏上就停在旧进度页（实机就是这么被拉回去的）；
        // 3) 进度状态里的活动行（最新状态 + 明细栈）清空：旧的第 20 步/旧工具行不许再上屏。
        turnEndedAt.set(sessionId, at)
        pcActivityAt.delete(sessionId)
        const endedTask = tasks.ofSession(sessionId)
        if (endedTask !== undefined) {
          runEndedAt.set(endedTask.taskId, at)
          progressEventAt.set(endedTask.taskId, at)
          const progress = progressStates.get(sessionId)
          if (progress !== undefined) {
            progress.lastEventLine = ''
            progress.activity = []
          }
        }
        setTimeout(pruneStaleTurns, 0)
      }
      // 子代理的起落：沿 parentSession 把「子任务在跑」的状态与挂起任务的完成补上。
      // 不看它有没有绑定设备——任务状态必须与真实子代理一致。
      if (headerOfSession(session)?.origin === 'subagent' && (type === 'turn/start' || type === 'turn/end')) {
        reconcileTasksForChild(session, sessionId, at)
      }
      if (type === 'assistant/message') {
        const blocks = Array.isArray((data as any)?.message?.content) ? (data as any).message.content : []
        const text = stripToolNoise(blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b?.text ?? '')).join('\n')).trim()
        if (text !== '') lastAssistant.set(sessionId, { text, at } as ProjectReply)
      }
      // 指挥台纯文本结论：assistant/message 一到就试着解析（好让排队卡尽早转正），
      // turn/end 是最后期限——解析不出来也要给终态，绝不停在「等指挥台判断」。
      if (sessionId === commanderSessionId) {
        const turnValue = Number((data as any)?.turn)
        const turn = Number.isFinite(turnValue) && turnValue > 0 ? turnValue : undefined
        if (type === 'turn/start') {
          // 多句同时排队时，由 turn/start 把本轮认领给最早那句，回复不会串台。
          assignCommanderTurn(turn ?? 0)
        } else if (type === 'assistant/message') {
          // 只认**这一条消息**的正文：没有文字的（纯工具调用）消息不能拿上一轮的 JSON 顶替。
          const blocks = Array.isArray((data as any)?.message?.content) ? (data as any).message.content : []
          const replyText = stripToolNoise(blocks
            .filter((b: any) => b?.type === 'text')
            .map((b: any) => String(b?.text ?? ''))
            .join('\n')).trim()
          if (replyText !== '') {
            void settleCommanderReply(replyText, false, turn)
              .catch((error) => log(`tihu commander reply settle failed: ${(error as Error)?.message ?? String(error)}`))
          }
        } else if (type === 'turn/end') {
          const entry = lastAssistant.get(sessionId)
          const ask = commanderAskForTurn(turn, true)
          // 空回复不许拿上一轮的 JSON 冒充结论：只认这一问之后到达的回复。
          const fresh = entry !== undefined && (ask === undefined || entry.at >= ask.askedAt)
          void settleCommanderReply(fresh ? entry.text : '', true, turn)
            .catch((error) => log(`tihu commander reply settle failed: ${(error as Error)?.message ?? String(error)}`))
        }
      }
      // ---------- 任务登记簿：事件归一到任务（不看有没有设备绑着） ----------
      const taskOfSession = tasks.ofSession(sessionId)
      if (taskOfSession !== undefined && taskOfSession.source === 'pc') {
        /* 电脑端（DSH 主 GUI）会话 → 登记簿里的外部任务（`source='pc'`）。
         * 只把会话动静翻译成登记簿状态：不派单、不建会话、不往会话投 prompt、不触发派单尾巴。 */
        // 用户 2026-11-10 规则：只有 Computer Use 模式才上屏。运行中被切回普通模式时，
        // 这条卡要立刻下屏归档（下一次轮询也会做，这里只是快一步，别让事件再刷新它）。
        const livePreset = presetOf(session) || sessionPresets.get(sessionId) || ''
        if (livePreset !== '' && !isComputerUsePreset(livePreset)) {
          archivePcTask(taskOfSession.taskId, at, `preset=${livePreset}`)
          return
        }
        // 用户 2026-11-10：turn/end 不算「活动」——旧口径把结束那一刻也记成活动，
        // 15 秒窗口内轮询就会把这条已完成的会话又算成「执行中」。
        if (type !== 'turn/end') pcActivityAt.set(sessionId, at)
        if (type === 'turn/start' || type === 'step/start' || type === 'tool/call' || type === 'assistant/message') {
          progressEventAt.set(taskOfSession.taskId, at)
        }
        const progress = progressStates.get(sessionId) ?? createProgressState()
        progressStates.set(sessionId, progress)
        applySessionEvent(progress, event, at, screenMetaOf(sessionId))
        if (type !== 'turn/end') refreshFocusedDetail(taskOfSession)
        if (type === 'turn/start') {
          // 新一轮真的开始了：锚点与步数都从这一轮重新起算（上一轮的「第 20 步」不许带进来）。
          noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || at, true)
          tasks.resetStep(taskOfSession.taskId, at)
          tasks.syncExternal(taskOfSession.taskId, { state: 'running', startedAt: progress.turnStartedAt || at, at })
          refreshBoards()
          // 电脑端有任务在跑 → 设备自动切到这条任务的「进度」页（不是待决策）。
          // 只有真实的 turn/start 才允许跳屏，而且这条任务必须**此刻仍在 running**。
          followRunningTask(taskOfSession)
        } else if (type === 'step/start' || type === 'tool/call') {
          // 电脑端那侧的步数也进登记簿：第 N 步与棋盘微条都跟着真实事件走。
          const stepValue = Number((data as any)?.step)
          tasks.noteStep(taskOfSession.taskId, Number.isFinite(stepValue) ? stepValue : progress.step, at)
          noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || at)
          refreshFocusedDetail(taskOfSession)
          refreshBoards()
        } else if (type === 'assistant/message') {
          const pcLine = plainSummaryOf(lastAssistant.get(sessionId)?.text ?? '')
          if (pcLine !== '') {
            noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || pcStartAnchorOf(sessionId, at))
            tasks.syncExternal(taskOfSession.taskId, taskOfSession.state === 'running'
              ? { state: 'running', summary: pcLine, at }
              : { state: 'running', startedAt: pcStartAnchorOf(sessionId, at), summary: pcLine, at })
          }
        } else if (type === 'turn/end') {
          const pcReason = finishReasonOf(data)
          const pcOk = pcReason === 'stop' || pcReason === 'completed'
          // 内存里没有回复时先从活会话快照补一次（同步，不读盘）；轮询镜像任务
          // 的完成态可能是列表推出来的，`assistant/message` 不保证都在本进程里。
          const doneReply = lastAssistant.get(sessionId)?.text ?? cachedAssistantText(sessionId)
          const pcResult = plainSummaryOf(doneReply) || (pcOk ? '做完了' : `中断（${pcReason}）`)
          // 用户 2026-11-10：主回合结束 ≠ 任务完成——它派出的后台子代理可能还在跑。
          const childRunning = runningSubagentCountOf(sessionId)
          tasks.setChildRunning(taskOfSession.taskId, childRunning, at)
          if (childRunning > 0) {
            tasks.holdForChildren(taskOfSession.taskId, { childRunning, resultLine: pcResult, now: at })
            deferredReplies.set(taskOfSession.taskId, { reply: doneReply, resultLine: pcResult })
            refreshBoards()
            // 这一轮已经结束了：还停在它「进度」页的设备立刻离开（回棋盘），
            // 不许把旧步数/旧已用继续挂在屏上（用户 2026-11-10 实机）。
            leaveStaleProgress(taskOfSession, 'pc-turn-end-held')
            log(`tihu pc held for subagents task=${taskOfSession.taskId} children=${childRunning}`)
            return
          }
          // 完成屏➕一句播报：等子代理都结束才走到这里。
          showCompletedTask(taskOfSession, { reply: doneReply, resultLine: firstSentenceOf(doneReply) || pcResult, at })
          log(`tihu pc done task=${taskOfSession.taskId} ok=${String(pcOk)} line=${JSON.stringify(pcResult)}`)
        }
        return
      }
      if (taskOfSession !== undefined) {
        const progress = progressStates.get(sessionId) ?? createProgressState()
        progressStates.set(sessionId, progress)
        applySessionEvent(progress, event, at, screenMetaOf(sessionId))
        const stepValue = Number((data as any)?.step)
        if (type === 'turn/start') {
          tasks.markRunning(taskOfSession.taskId, at)
          // 新一轮开始：上一轮「等子代理」的挂起状态作废（这一轮会重新算）。
          tasks.clearChildHold(taskOfSession.taskId, at)
          // 新一轮真的开始了：锚点与步数都从这一轮重新起算（跨回合的「第 20 步」不许带进来）。
          noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || at, true)
          tasks.resetStep(taskOfSession.taskId, at)
          refreshBoards()
          refreshFocusedDetail(taskOfSession)
        } else if (type === 'step/start' || type === 'tool/call') {
          progressEventAt.set(taskOfSession.taskId, at)
          tasks.noteStep(taskOfSession.taskId, Number.isFinite(stepValue) ? stepValue : progress.step, at)
          noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || at)
          refreshFocusedDetail(taskOfSession)
          refreshBoards()
        } else if (type !== 'turn/end') {
          if (type === 'assistant/message' || type === 'tool/result') progressEventAt.set(taskOfSession.taskId, at)
          refreshFocusedDetail(taskOfSession)
        } else if (type === 'turn/end') {
          const reason = finishReasonOf(data)
          const ok = reason === 'stop' || reason === 'completed'
          const reply = lastAssistant.get(sessionId)?.text ?? cachedAssistantText(sessionId)
          const resultLine = firstSentenceOf(reply) || (ok ? '做完了' : `中断（${reason}）`)
          // 用户 2026-11-10：主回合结束 ≠ 任务完成——它派出的后台子代理可能还在跑。
          const childRunning = runningSubagentCountOf(sessionId)
          tasks.setChildRunning(taskOfSession.taskId, childRunning, at)
          if (childRunning > 0) {
            tasks.holdForChildren(taskOfSession.taskId, { childRunning, resultLine, now: at })
            deferredReplies.set(taskOfSession.taskId, { reply, resultLine })
            refreshBoards()
            // 这一轮已经结束：还停在旧进度页的设备离开（子代理没跑完，先不假装完成）。
            leaveStaleProgress(taskOfSession, 'turn-end-held')
            log(`tihu task held for subagents task=${taskOfSession.taskId} children=${childRunning}`)
            return
          }
          // 子代理全部结束才转完成、才播报（用户 2026-11-10 的硬要求）。
          showCompletedTask(taskOfSession, { reply, resultLine, at })
          log(`tihu task done task=${taskOfSession.taskId} ok=${String(ok)} line=${JSON.stringify(resultLine)}`)
        }
        return
      }
      // ---------- 指挥会话自己的回答（没有任务）：只出一屏「回答」，不再有朗读屏/主页 ----------
      if (type === 'turn/end' && sessionId === commanderSessionId) {
        const reply = lastAssistant.get(sessionId)?.text ?? ''
        const line = plainSummaryOf(reply, 60)
        if (line === '') return
        for (const device of devices) {
          if (!device.unified) continue
          const key = device.sessionId ?? device.id
          // 只有「我在，直接答」那一屏才把答案贴上去；慢路径派单的收尾话不上屏。
          if (device.screenStage !== '回答') continue
          if (device.receiptTimer !== undefined || device.pendingPick !== undefined) continue
          const lines = replyBulletsOf(reply).slice(0, 2)
          const frame = noticeFrame({ stage: '回答', title: line, lines, tone: 'ok' })
          lastFrames.set(key, frame)
          pushFrame(device, frame)
          void speakAnnouncement(device, line)
            .then((spokenMs) => { if (spokenMs >= 0) armAutoHome(device, spokenMs) })
            .catch((error) => log(`tihu answer speak failed: ${(error as Error)?.message ?? String(error)}`))
        }
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
      unified: true,
      bindEpoch: 0,
      autoBindEpoch: 0,
      voiceAttempt: 0,
      commitInFlight: false,
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
      // 停止/重读/回主页/P0 打断都走这里：把轮次号 +1，正在下发的那一轮 PCM 立刻哑火。
      cancelRound() { cancelSpeaking(device) },
    }
    devices.add(device)

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
          // 重说/新输入必须在排队前使旧 ASR 与草稿失效，否则慢队列会让旧文本先自动发送。
          const actionId = message.type === 'screen.gesture' ? String((message.payload as any)?.actionId ?? '') : ''
          if (message.type === 'audio.frame' || message.type === 'text.input'
            || message.type === 'session.end'
            || (message.type === 'screen.gesture' && actionId !== 'send')) invalidateVoiceInput(device)
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
      invalidateVoiceInput(device)
      devices.delete(device)
      // 断开的设备不再有屏：把还挂着的这一轮朗读掐掉，别继续烧合成额度。
      try { device.cancelRound?.() } catch { /* 忽略 */ }
      if (devices.size === 0) {
        // 没有屏可刷了：电脑端会话的轮询也停掉，等下一次 hello 再起。
        stopPcSync()
      }
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
      // 统一指挥是唯一入口（2026-11-09 第二轮）：没有 ?session=、没有自动跟随、没有旧主页。
      // 旧页面带了 sessionId 也当没带——屏上只可能是新七屏。
      device.autoFollow = false
      device.unified = true
      device.focusedTask = undefined
      device.onBoard = true
      const commander = await ensureCommanderSession()
      if (commander !== undefined) {
        device.sessionId = commander
        device.send('session.bound', {
          sessionId: commander,
          title: titleForSession(commander),
          project: projectNameOf(liveSessionOf(commander)?.header?.cwd),
          live: true,
          preset: TASK_PRESET,
          computerUse: false,
        } satisfies SessionBoundPayload)
        device.send('event.progress', { stage: '指挥', text: '统一指挥已就绪：说一句话就派单，不用挑会话' } satisfies ProgressPayload)
        // 电脑端会话也上棋盘：起一次轮询（列表请求仍由 sessionListTtlMs 节流）并立刻同步一遍。
        ensurePcSync()
        // 子代理状态也要跟着收敛：有屏在线时每 2 秒对一次「子任务在跑」计数。
        ensureChildReconcile()
        // 连上就只停在棋盘：**不许**按「同步看到的旧状态」自动跳进度页（用户 2026-11-10）。
        // 跳屏只有一条合法入口：真的 turn/start（见 session/event 的 pc 分支）。
        void syncExternalSessions().catch((error) => log(`tihu pc sync failed: ${(error as Error)?.message ?? String(error)}`))
        sendBoard(device)
      } else {
        // 指挥会话建不出来：不许退回旧壳，直接黑底一行错误提示，停在这里等重连。
        device.sessionId = undefined
        device.focusedTask = undefined
        sendFrame(device, noticeFrame({ stage: '', title: '鹈鹕指挥台不可用，请重启', lines: [], tone: 'alert' }))
        device.send('event.alert', { level: 'error', text: '鹈鹕指挥台不可用，请重启' })
        log('tihu unified mode unavailable: commander session could not be created')
      }
      device.send('event.progress', { stage: '连接', text: `设备 ${device.id} 已就绪` } satisfies ProgressPayload)
      log(`tihu hello client=${payload.clientId} session=${device.sessionId ?? '?'} caps=${JSON.stringify(caps)}`)
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
      device.send('event.progress', {
        stage: '会话',
        text: ended ? `已结束本次语音会话（${payload.reason ?? '页面按钮'}）` : '当前没有进行中的语音会话',
      } satisfies ProgressPayload)
      // 结束语音会话只关闸门：屏还停在棋盘/详情上，不回旧主页。
      sendBoard(device)
      return
    }

    if (type === 'task.reply') {
      // 屏上答问句 / 点选项 / 轻命令 → 回指挥会话（不是回任务会话）。
      const payload = (message.payload ?? {}) as TaskReplyPayload
      if (payload.command === 'board') { await runScreenCommand(device, { kind: 'board' }); return }
      if (payload.command === 'stop') { await runScreenCommand(device, { kind: 'stop' }); return }
      if (payload.command === 'cancel') { await runScreenCommand(device, { kind: 'cancel' }); return }
      if (payload.command === 'open') {
        const target = payload.taskId ?? device.focusedTask
        if (target !== undefined && openTask(device, target)) return
        await runScreenCommand(device, { kind: 'open' })
        return
      }
      return
    }
    if (type === 'screen.gesture') {
      const payload = message.payload as { action?: string; dy?: number; phase?: string; x?: number; y?: number }
      if (payload.action === 'tap' && typeof payload.x === 'number' && typeof payload.y === 'number') {
        const sid = device.sessionId
        if ((payload as any).hit === 'action' && typeof (payload as any).actionId === 'string') {
          const actionId = (payload as any).actionId as string
          /* ---- 新七屏上的按键：棋盘 / 回执 / 详情 / 待决策 / 追问 / 完成 ---- */
          if (actionId === 'taskBoard') {
            try { device.cancelRound?.() } catch { /* 忽略 */ }
            await runScreenCommand(device, { kind: 'board' })
            return
          }
          if (actionId === 'boardPrev' || actionId === 'boardNext') {
            // 棋盘翻页：就地换页（不重排任务、不派单）。页码夹到真实范围内。
            const current = Math.max(0, Math.trunc(device.boardPage ?? 0))
            const step = actionId === 'boardNext' ? 1 : -1
            const next = Math.max(0, current + step)
            if (next === current && step < 0) return
            device.boardPage = next
            sendBoard(device)
            log(`tihu board page device=${device.id} page=${device.boardPage + 1}`)
            return
          }
          if (actionId === 'replay') {
            // 重读：从第一段重新念（完成页打开后也能重读）；页面自己把高亮拉回第一行。
            const target = device.focusedTask === undefined
              ? tasks.list().filter((task) => task.state === 'done' || task.state === 'announced').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
              : tasks.get(device.focusedTask)
            if (target !== undefined) {
              try { device.cancelRound?.() } catch { /* 忽略 */ }
              // 正文还没补到（历史读取晚到/失败）：重读前再补一次，顺带重发完成帧；
              // 否则就照旧只把同一份正文再念一遍（页面清掉旧排程，从第一段重新对齐高亮）。
              if (String(target.doneText ?? '').trim() === '') {
                await showDone(device, target, true)
              } else {
                // 重读一整段（一行一段）：和完成页打开时念的是同一份正文。
                readDoneScreen(device, target)
              }
            }
            return
          }
          if (actionId === 'taskAnswer1' || actionId === 'taskAnswer2') {
            // 待决策页：点选项＝就地答这条任务（不派单、不新建会话），答完立刻回棋盘。
            const target = device.focusedTask === undefined ? undefined : tasks.get(device.focusedTask)
            if (target !== undefined && target.state === 'awaiting') {
              const index = actionId === 'taskAnswer1' ? 0 : 1
              const label = (target.options ?? [])[index] ?? ''
              tasks.answer(target.taskId, '设备点选', Date.now())
              device.send('event.progress', { stage: '待决策', text: `已选：${label}` } satisfies ProgressPayload)
              await runScreenCommand(device, { kind: 'board' })
            }
            return
          }
          if (actionId === 'taskOpen') {
            const target = device.focusedTask ?? boardOf(tasks.list(), Date.now(), Math.max(0, device.boardPage ?? 0)).rows[0]?.taskId
            if (target !== undefined) openTask(device, target)
            return
          }
          if (actionId === 'taskCancel') {
            const target = device.focusedTask ?? tasks.list().filter((task) => task.state === 'queued').sort((a, b) => b.updatedAt - a.updatedAt)[0]?.taskId
            if (target !== undefined) await cancelTask(device, target)
            return
          }
          if (actionId === 'taskStop') {
            try { device.cancelRound?.() } catch { /* 忽略 */ }
            device.send('event.progress', { stage: '停止', text: '已停止朗读（任务还在跑）' } satisfies ProgressPayload)
            return
          }
          if (actionId === 'pick1' || actionId === 'pick2') {
            const index = actionId === 'pick1' ? 1 : 2
            if (device.pendingClarify !== undefined) {
              await resolveClarify(device, index === 1 ? 'new' : 'same')
              return
            }
            const pick = device.pendingPick
            device.pendingPick = undefined
            const card = pick?.candidates[index - 1]
            if (pick !== undefined && card !== undefined) await dispatchWithContinuity(device, pick.text, card, { via: 'pick' }, { allowCommander: true })
            return
          }
          if (actionId === 'pickNone') {
            if (device.pendingClarify !== undefined) {
              // 澄清屏只有两个选项（没有「都不是」按钮）；留着当「新建」处理，避免卡死。
              await resolveClarify(device, 'new')
              return
            }
            const pick = device.pendingPick
            device.pendingPick = undefined
            if (pick !== undefined) await dispatchWithContinuity(device, pick.text, ASSISTANT_CARD, { via: 'pick-none' }, { allowCommander: true })
            return
          }
          if (actionId === 'send') {
            const pending = device.pendingVoice
            if (pending !== undefined) await commitPendingVoice(device, pending).catch((error) => showInputError(device, error))
            return
          }
          if (actionId === 'retry') {
            cancelPendingVoice(device)
            device.send('transcript', { text: '', final: true, source: 'voice', retryable: true } satisfies TranscriptPayload)
            sendFrame(device, {
              stage: '重说', title: '请重新说', bullets: ['上一条未发送', '说完后再确认'], tone: 'idle', mode: 'status',
            } satisfies ScreenFramePayload, sid)
            return
          }
          if (actionId === 'stop') {
            try { device.cancelRound?.() } catch { /* 忽略 */ }
            device.send('event.progress', { stage: '停止', text: '已停止朗读' } satisfies ProgressPayload)
            return
          }
          return
        }
        // 任务棋盘上点一行：看这条任务（电脑端卡片走它的会话详情）。
        if ((payload as any).hit === 'task' && typeof (payload as any).taskId === 'string') {
          openTask(device, String((payload as any).taskId))
          return
        }
        // 右下角 tap = 回棋盘。
        if (payload.x >= 240 && payload.y >= 180) await runScreenCommand(device, { kind: 'board' })
        return
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
      // 手切到 Kokoro 音色 / 勾了仅离线：这时才允许 spawn Kokoro sidecar（edge 主用不预热）。
      if (isKokoroVoice(device.voice) || device.offlineOnly) {
        if (typeof (tts as any).ensureKokoroServer === 'function') {
          void tts.ensureKokoroServer().catch((error) => log(`tihu kokoro prewarm failed: ${(error as Error)?.message ?? String(error)}`))
        }
      } else if (device.voice !== 'default' && tts.available()) {
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
      if (isKokoroVoice(device.voice) || device.offlineOnly) {
        if (typeof (tts as any).ensureKokoroServer === 'function') {
          try { await tts.ensureKokoroServer() } catch { /* 合成阶段会给出可读错误 */ }
        }
      } else if (device.voice && device.voice !== 'default') {
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
      const inputTarget = device.sessionId
      const source = type === 'audio.frame' ? 'voice' : message.payload.source === 'voice' ? 'voice' : 'keyboard'
      if (type === 'text.input' && message.payload.source === 'retry') {
        device.send('transcript', { text: '', final: true, source: 'voice', retryable: true } satisfies TranscriptPayload)
        sendFrame(device, { stage: '重说', title: '请重新说', bullets: ['上一条未发送'], tone: 'idle', mode: 'status' } satisfies ScreenFramePayload)
        return
      }
      device.send('event.progress', {
        stage: 'audio', text: type === 'audio.frame' ? '已收到音频，准备转写' : '已收到文字',
      } satisfies ProgressPayload)
      if (device.sessionId === undefined) {
        device.send('event.alert', { level: 'warn', text: '鹈鹕指挥台不可用，请重启' })
        sendFrame(device, noticeFrame({ stage: '', title: '鹈鹕指挥台不可用，请重启', lines: [], tone: 'alert' }))
        return
      }
      const expectedTarget = device.sessionId
      if (type === 'audio.frame') {
        const attempt = device.voiceAttempt
        const quality = inspectTihuVoiceWav(String(message.payload.audioBase64 ?? ''))
        if (quality.kind === 'reject') {
          device.send('transcript', { text: '', final: true, source: 'voice', retryable: true } satisfies TranscriptPayload)
          device.send('event.alert', { level: 'warn', text: quality.reason })
          sendFrame(device, { stage: '没听清', title: '请靠近后重说', bullets: [quality.reason], tone: 'alert', mode: 'status' } satisfies ScreenFramePayload, expectedTarget)
          return
        }
        sendFrame(device, { stage: '正在转写', title: '正在识别语音', bullets: ['本机 speech 服务'], tone: 'busy', mode: 'status' } satisfies ScreenFramePayload, expectedTarget)
        const asr = new AbortController()
        device.cancelAsr = () => asr.abort()
        let text = ''
        try {
          text = await transcribe(String(message.payload.audioBase64 ?? ''), asr.signal)
        } catch (error) {
          if (attempt !== device.voiceAttempt || asr.signal.aborted) return
          device.send('transcript', { text: '', final: true, source: 'voice', retryable: true } satisfies TranscriptPayload)
          device.send('event.alert', { level: 'error', text: `转写失败：${(error as Error)?.message ?? String(error)}` })
          sendFrame(device, { stage: '转写失败', title: '请重说一次', bullets: ['也可以点重说后再试'], tone: 'alert', mode: 'status' } satisfies ScreenFramePayload, expectedTarget)
          return
        } finally {
          device.cancelAsr = undefined
        }
        if (attempt !== device.voiceAttempt || device.sessionId !== expectedTarget) {
          if (device.sessionId !== expectedTarget) showInputError(device, new Error('识别期间目标已切换，请重说一次'))
          return
        }
        if (text === '') {
          device.send('transcript', { text: '', final: true, source: 'voice', retryable: true } satisfies TranscriptPayload)
          device.send('event.alert', { level: 'warn', text: '没有识别到语音内容，请再说一次' })
          sendFrame(device, { stage: '没听清', title: '请再说一次', bullets: ['这次没有识别到内容'], tone: 'alert', mode: 'status' } satisfies ScreenFramePayload, expectedTarget)
          return
        }
        previewVoice(device, text, attempt, quality)
        return
      }
      const text = String(message.payload.text ?? '').trim()
      if (text === '') return
      try {
        device.send('transcript', { text, final: true, source, retryable: true } satisfies TranscriptPayload)
        const screenOwned = await routeCommittedText(device, text)
        device.send('event.progress', { stage: '注入', text: '已送入当前会话' } satisfies ProgressPayload)
        // 统一指挥的路由自己已经出了屏（回执/追问/棋盘/详情）：通用「思考」帧会把它
        // 盖掉。这里只给老路径补帧；屏内「思考 ·」活动行本身不动。
        if (!screenOwned) {
          sendFrame(device, { stage: '思考', title: '模型处理中', bullets: [text.slice(0, 20)], tone: 'busy' } satisfies ScreenFramePayload)
        }
      } catch (error) {
        showInputError(device, error)
      }
    }
  }

  /**

  /* ---------- 统一指挥：派单器（指挥会话唯一的动手方式） ----------
   *
   * 三层，从快到慢：
   *   ① 屏上命令（回棋盘/看任务/停止/撤单/确认…）：零模型，说完即做；
   *   ② 快路径规则表（点名项目卡 / 接着说 / 日常小事 / 歧义追问）：零模型，命中即派；
   *   ③ 慢路径：交给指挥会话的模型判项目，再由它调 tihu dispatch（它自己不做正文）。
   *
   * 三条铁律落在这里：
   *   - 设备永远绑指挥会话，不再有会话选择器与「自动跟随最活跃会话」；
   *   - 屏与播报按**任务**投影（登记簿是唯一事实源），不按会话；
   *   - 完成＝屏上气泡 ＋ 一句播报，绝不要求先点进某条会话。
   */

  /** 指挥会话的会话名：重启后按标题找回同一条，不再新建第二条。 */
  const COMMANDER_TITLE = '鹈鹕指挥台'

  /** 「问答记忆」入口：自己直接答，不落任务（派单四出口之一）。 */
  const MEMORY_QUESTION = /^(?:你还记得|还记得|上次|之前|刚才|我们说过|记不记得)/

  /** 日常任务的固定卡片（id 与客户端 ASSISTANT_PROJECT_ID 一致，落点＝助手 home）。 */
  const ASSISTANT_CARD = { id: 'wt-assistant', name: '个人助手' } as const

  /**
   * 指挥会话用的预设：standard（它只看单、不看屏）。
   * 派单建的任务会话一律 {@link DISPATCH_PRESET}（computer-use），否则设备屏上的任务
   * 不能看屏/点按，而且「非 CU 会话不上屏」的规则会把它们当电脑端会话处理。
   */
  const TASK_PRESET = 'standard'

  /** 派单会话（含「接着旧会话」复用）必须是 Computer Use 模式。 */
  const DISPATCH_PRESET = TIHU_COMPUTER_USE_PRESET

  function assistantFolder(): string {
    try { return ensureAssistantHome().dir } catch { return process.env.DSH_ASSISTANT_HOME ?? process.cwd() }
  }

  /**
   * 在指定文件夹新建一条会话。
   *
   * **宿主真实入口是 `sessionController.create()`**：它就是 Typert 暴露成 `ctx.remote.session`
   * 的宿主本体（`dsh-api-session-controller` 里 `super(ctx, 'sessionController', { namespace: 'session' })`），
   * 返回 `{ sessionId }`、顺手拉起 agent。
   *
   * 2026-11-09 线上实测的旧实现两处都错，写在这里免得改回去：
   *   - `ctx.get('remote')` 在宿主 ctx 里是**客户端**网关服务（`dsh-api-gateway/lib/client.js`
   *     的 `super(ctx, 'remote')`），宿主侧拿不到；现在只当老宿主兼容路；
   *   - `sessions.create(base)` 签名错：`SessionStore.create(id, options)` 第一个参数是会话 id、
   *     返回 Session 而非 id，把 options 当 id 传必抛。
   * 两条都失败 → 指挥会话建不出来 → 裸 hello 无声退回项目卡片主页（这次的线上现象）。
   */
  async function createSessionAt(folder: string, preset: string): Promise<string | undefined> {
    const base = folder !== '' ? { cwd: folder } : {}
    const controller = optionalService(ctx, 'sessionController') as {
      create?: (request: { cwd?: string; agentPreset?: string }) => Promise<any>
    } | undefined
    if (typeof controller?.create === 'function') {
      try {
        const created: any = await controller.create({ ...base, agentPreset: preset })
        const sessionId = typeof created === 'string'
          ? created
          : typeof created?.sessionId === 'string' ? created.sessionId : undefined
        if (typeof sessionId === 'string' && sessionId !== '') {
          // 刚建的会话还没进列表缓存；不清掉的话 findSession 会判 missing，
          // bindSession 立刻回 session.invalid（2026-11-09 实测：建完却绑不上）。
          sessionListCache = undefined
          return sessionId
        }
        log(`tihu sessionController.create returned no sessionId: ${String(JSON.stringify(created ?? null)).slice(0, 140)}`)
      } catch (error) {
        log(`tihu sessionController.create failed: ${(error as Error)?.message ?? String(error)}`)
      }
    }
    // 老宿主兼容：有的版本把同一个 create 转成 remote.session 的 { ok, value } 信封。
    const remote = optionalService(ctx, 'remote') as { session?: { create?: (base: unknown) => Promise<any> } } | undefined
    if (typeof remote?.session?.create === 'function') {
      try {
        const result: any = await remote.session.create({ ...base, agentPreset: preset })
        if (result?.ok === true && typeof result?.value?.sessionId === 'string' && result.value.sessionId !== '') {
          sessionListCache = undefined
          return result.value.sessionId
        }
        log(`tihu remote.session.create rejected: ${String(JSON.stringify(result?.error ?? null)).slice(0, 140)}`)
      } catch (error) {
        log(`tihu remote.session.create failed: ${(error as Error)?.message ?? String(error)}`)
      }
    }
    log(`tihu create session unavailable: ${['sessionController', 'remote', 'sessions', 'agents']
      .map((id) => `${id}=${optionalService(ctx, id) === undefined ? 'missing' : 'ok'}`)
      .join(' ')}`)
    return undefined
  }

  /** 给会话写标题：指挥会话靠标题被下次 hello 找回（宿主 sessionTitle 服务，经 sessionController 暴露）。 */
  async function titleSession(sessionId: string, title: string): Promise<boolean> {
    const controller = optionalService(ctx, 'sessionController') as {
      rename?: (request: { sessionId: string; title: string }) => Promise<any>
    } | undefined
    if (typeof controller?.rename !== 'function') return false
    try {
      await controller.rename({ sessionId, title })
      return true
    } catch (error) {
      log(`tihu rename session=${sessionId} failed: ${(error as Error)?.message ?? String(error)}`)
      return false
    }
  }

  /** 给一条会话开「tihu 轮」窗口；messageId 空串表示刚投进去、还没投影出这条消息。 */
  function armTihuWindow(sessionId: string, messageId = ''): void {
    activeSessions.set(sessionId, { until: Date.now() + ACTIVE_WINDOW_MS, messageId })
  }

  /** 取活会话对象（用于读最后一条 user 消息 id；拿不到就返回 undefined）。 */
  function sessionForMessageId(sessionId: string): any {
    try {
      return optionalService(ctx, 'agents')?.get?.(sessionId)?.session ?? liveSessionOf(sessionId)
    } catch { return undefined }
  }

  /** 一次投递的结果：失败时把**真实异常**带回去（屏上原因摘要 + lane.log 都靠它）。 */
  interface PromptResult {
    ok: boolean
    /** 失败时的真实异常（成功时没有）。 */
    error?: unknown
    /** 失败来自 sessions.using（只有这种失败值得退避重试）。 */
    fromUsing?: boolean
  }

  /** 没投进去时的短退避（毫秒）：重启后宿主可能还在恢复旧会话。 */
  const PROMPT_RETRY_DELAY_MS = [300, 800]

  /**
   * 投一次（不做重试）。
   * 优先 `sessions.using(...).prompt()`（宿主会顺手拉起 agent），
   * 没有这个服务就退回 `agents.followup`（老宿主/测试桩）。
   *
   * **先 arm 再 prompt**：派单建立的会话里，工具调用可能抢在 prompt() 返回前开跑；
   * 旧实现只在 sessions.using 分支、prompt 之后才记 activeSessions，fallback inject
   * 分支更是一条都不记，于是危险动作闸判「不是 tihu 轮」整段放行（2026-11-09 实测
   * `pwsh Remove-Item` 无 confirm、无 audit）。空 messageId 在 tihuTurnOf 里按 tihu 轮算。
   */
  async function promptOnce(sessionId: string, blocks: { type: 'text'; text: string }[]): Promise<PromptResult> {
    const sessionsSvc = optionalService(ctx, 'sessions') as { using?: (id: string, opts: unknown, fn: (ref: any) => Promise<void>) => Promise<void> } | undefined
    if (typeof sessionsSvc?.using === 'function') {
      armTihuWindow(sessionId)
      let before: string | undefined
      let delivered = false
      try {
        await sessionsSvc.using(sessionId, { source: 'tihu-dispatch' }, async (reference: any) => {
          const session = reference?.binding?.session
          before = lastUserMessageId(session)
          await session?.prompt(blocks, 'steer')
          delivered = true
          const after = lastUserMessageId(session)
          if (after !== undefined && after !== before) armTihuWindow(sessionId, after)
        })
        return { ok: true }
      } catch (error) {
        if (delivered) {
          // 消息已经进去了：using 收尾抛错不能算投递失败，否则重试会重复投一遍。
          appendTihuLaneLog(sessionId, error, 'after-delivery')
          log(`tihu prompt session=${sessionId} delivered, dispose threw: ${(error as Error)?.message ?? String(error)}`)
          return { ok: true }
        }
        // 投递失败就别把窗口留着，免得后续用户自己的工具调用被误判成 tihu 轮。
        activeSessions.delete(sessionId)
        return { ok: false, error, fromUsing: true }
      }
    }
    armTihuWindow(sessionId)
    try {
      const before = lastUserMessageId(sessionForMessageId(sessionId))
      const agent = optionalService(ctx, 'agents')?.get?.(sessionId)
      if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
        throw new Error(`会话 ${sessionId.slice(0, 8)}… 当前没有活动 agent`)
      }
      const message = buildTihuUserMessage(String(blocks[0]?.text ?? ''))
      for (const block of blocks.slice(1)) message.content.push({ type: 'text', text: block.text })
      armTihuWindow(sessionId, String(message.id))
      agent.followup(message)
      const after = lastUserMessageId(sessionForMessageId(sessionId))
      if (after !== undefined && after !== before) armTihuWindow(sessionId, after)
      return { ok: true }
    } catch (error) {
      activeSessions.delete(sessionId)
      return { ok: false, error, fromUsing: false }
    }
  }

  /** 指挥会话换了 id：绑着旧会话的屏改绑到新会话（否则新会话的 turn 事件上不了屏）。 */
  function rebindCommanderSession(previous: string, next: string): void {
    if (previous === next) return
    for (const device of devices) {
      if (device.sessionId !== previous) continue
      device.sessionId = next
      device.send('session.bound', {
        sessionId: next,
        title: titleForSession(next),
        project: projectNameOf(liveSessionOf(next)?.header?.cwd),
        live: true,
        preset: TASK_PRESET,
        computerUse: false,
      } satisfies SessionBoundPayload)
    }
  }

  /** 正在重建的指挥会话：两句同时失败时只建一条，避免两条「鹈鹕指挥台」抢绑。 */
  let commanderRebuilding: Promise<string | undefined> | undefined

  /**
   * 指挥会话投不进去（重启后归档/没加载/卡在忙）→ 新建一条并重绑设备。
   *
   * 这里必须 **fresh**：按标题找回只会拿回同一个死 id，重试还是失败（2026-11-10 线上）。
   */
  async function rebuildCommanderSession(failedSessionId: string): Promise<string | undefined> {
    if (commanderRebuilding !== undefined) return await commanderRebuilding
    commanderRebuilding = (async () => {
      commanderSessionId = undefined
      const rebuilt = await ensureCommanderSession({ fresh: true })
      if (rebuilt === undefined) return undefined
      rebindCommanderSession(failedSessionId, rebuilt)
      log(`tihu commander rebuilt old=${failedSessionId} new=${rebuilt}`)
      return rebuilt
    })()
    try {
      return await commanderRebuilding
    } finally {
      commanderRebuilding = undefined
    }
  }

  /**
   * 往一条会话投一组消息，并对「重启后旧会话用不了」做兜底：
   *   1. 投递抛错先等 300ms、800ms 各重试一次（重启后宿主可能还在恢复）；
   *   2. 仍失败且目标是指挥会话 → 清空 commanderSessionId、新建「鹈鹕指挥台」并重绑设备后再投一次；
   *   3. 每次失败都把真实异常写进 lane.log（不只宿主 console）。
   *
   * 返回 `ok`（成功）或 `error`（最后一次真实异常）：调用方据此在设备屏第二行写原因摘要。
   */
  async function promptSession(sessionId: string, blocks: { type: 'text'; text: string }[]): Promise<PromptResult> {
    // 进函数时就记住「这是不是指挥会话」：后面重建会改 commanderSessionId。
    const isCommander = sessionId === commanderSessionId
    let last: PromptResult | undefined
    for (let attempt = 0; attempt <= PROMPT_RETRY_DELAY_MS.length; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => { setTimeout(resolve, PROMPT_RETRY_DELAY_MS[attempt - 1]) })
        if (disposed) return { ok: false, error: last?.error ?? new Error('鹈鹕已卸载'), fromUsing: false }
      }
      const result = await promptOnce(sessionId, blocks)
      if (result.ok) return result
      last = result
      const failure = result.error ?? new Error('投递失败')
      appendTihuLaneLog(sessionId, failure, `attempt=${attempt + 1}/${PROMPT_RETRY_DELAY_MS.length + 1}`)
      log(`tihu prompt session=${sessionId} attempt=${attempt + 1} failed: ${(failure as Error)?.message ?? String(failure)}`)
      // 只有 using 自己抛错才值得退避重试；fallback 没有活动 agent 时重试也一样。
      if (result.fromUsing !== true) break
    }
    if (!isCommander || disposed) {
      return { ok: false, error: last?.error ?? new Error('投递失败'), fromUsing: false }
    }
    const rebuilt = await rebuildCommanderSession(sessionId)
    if (rebuilt === undefined) {
      log(`tihu commander rebuild failed old=${sessionId}`)
      return { ok: false, error: last?.error ?? new Error('指挥会话重建失败'), fromUsing: false }
    }
    const retried = await promptOnce(rebuilt, blocks)
    if (retried.ok) {
      log(`tihu commander retry ok old=${sessionId} new=${rebuilt}`)
      return retried
    }
    appendTihuLaneLog(rebuilt, retried.error, 'attempt=rebuild')
    log(`tihu commander retry failed session=${rebuilt}: ${(retried.error as Error)?.message ?? String(retried.error)}`)
    return { ok: false, error: retried.error, fromUsing: retried.fromUsing }
  }

  /**
   * 指挥会话：按标题找回同一条；找不到才新建（落助手 home，standard 模式）。
   *
   * `fresh` 只给「投递连续失败后的重建」用：那条会话已经进不去（重启后归档/没加载/
   * 卡死在忙），再按标题找回来还是同一个死 id，所以直接新建一条并写回标题。
   */
  async function ensureCommanderSession(options: { fresh?: boolean } = {}): Promise<string | undefined> {
    if (options.fresh !== true && commanderSessionId !== undefined) {
      const found = await findSession(commanderSessionId)
      if (found.status !== 'missing') return commanderSessionId
      commanderSessionId = undefined
    }
    if (options.fresh === true) commanderSessionId = undefined
    if (options.fresh !== true) {
      let rows: TihuSessionRow[] = []
      try { rows = (await collectSessionRows()).rows } catch { rows = [] }
      const existing = rows.find((row) => String(row.title ?? '').includes(COMMANDER_TITLE))
      if (existing !== undefined) {
        commanderSessionId = existing.sessionId
        log(`tihu commander reused session=${existing.sessionId}`)
        return commanderSessionId
      }
    }
    const created = await createSessionAt(assistantFolder(), TASK_PRESET)
    if (created === undefined) return undefined
    commanderSessionId = created
    // 标题必须落库：下次 hello 靠「标题含 鹈鹕指挥台」找回同一条；不写就会每次新建一条。
    const titled = await titleSession(created, COMMANDER_TITLE)
    log(`tihu commander created session=${created}${titled ? ' titled' : ' (title not set)'}`)
    return created
  }

  /** 派单落点：卡片文件夹 → 助手 home（兜底）。空串表示让宿主用默认 cwd。 */
  function resolveTaskFolder(card: { folder?: string }): string {
    const folder = String(card.folder ?? '').trim()
    return folder !== '' ? folder : assistantFolder()
  }

  /* ---------- 会话衔接（同项目 CU 会话 → 追加 or 新建） ---------- */

  /** 路径归一：反斜杠、去尾部分隔符、小写（Windows 大小写不敏感）。 */
  function folderKeyOf(folder: string | undefined): string {
    return String(folder ?? '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  }

  /** child 是否在 base 目录里（含 base 本身）。空路径一律不算。 */
  function sameProjectFolder(base: string, child: string | undefined): boolean {
    const left = folderKeyOf(base)
    const right = folderKeyOf(child)
    if (left === '' || right === '') return false
    return right === left || right.startsWith(`${left}\\`)
  }

  /** 项目名/文件夹短名：算内容重合度前先剔掉，避免「同一个项目」被当成「同一件事」。 */
  function continuityHintsOf(card: { name?: string }, folder: string): string[] {
    const hints = [String(card.name ?? '').trim(), folderBase(folder)]
    return hints.filter((hint, index) => [...hint].length >= 2 && hints.indexOf(hint) === index)
  }

  /**
   * 该项目下最近的 CU 会话（最多 8 条）：只看 Computer Use 模式、同一项目文件夹、
   * 7 天内有活动的；标题取会话投影，摘要取登记簿里绑在这条会话上的任务摘要/结果行。
   *
   * 列表走 collectSessionRows（60 秒缓存），所以这一步是毫秒级，不为每次派单多打宿主。
   */
  async function projectCuSessionsOf(card: { id: string; name: string; folder?: string }): Promise<TihuSessionCandidate[]> {
    let rows: TihuSessionRow[] = []
    try { rows = (await collectSessionRows()).rows } catch { rows = [] }
    const folder = resolveTaskFolder(card)
    const now = Date.now()
    const candidates: TihuSessionCandidate[] = []
    for (const row of rows) {
      if (row.sessionId === commanderSessionId) continue
      if (!isComputerUsePreset(row.preset)) continue
      if (!sameProjectFolder(folder, row.cwd)) continue
      if (!(row.updatedAt > 0) || now - row.updatedAt > CONTINUITY_WINDOW_MS) continue
      const task = tasks.ofSession(row.sessionId)
      const title = humanTitle(String(task?.title ?? row.title ?? ''))
      const summary = String(task?.summary || task?.resultLine || task?.doneText || '').slice(0, 160)
      candidates.push({
        sessionId: row.sessionId,
        title: title !== '' ? title : String(row.title ?? ''),
        ...(summary === '' ? {} : { summary }),
        updatedAt: row.updatedAt,
      })
    }
    return continuityCandidatesOf(candidates)
  }

  /** 指挥台点名的会话：完整 id / 短号 / 标题（最后才做包含匹配）。 */
  function findContinuityTarget(candidates: readonly TihuSessionCandidate[], ref: string): TihuSessionCandidate | undefined {
    const key = String(ref ?? '').trim()
    if (key === '') return undefined
    const shortOf = (sessionId: string): string => sessionId.replace(/^session-/, '').slice(0, 8).toLowerCase()
    const lower = key.toLowerCase()
    return candidates.find((item) => item.sessionId === key)
      ?? candidates.find((item) => shortOf(item.sessionId) === shortOf(key) || shortOf(item.sessionId) === lower)
      ?? candidates.find((item) => item.title === key)
      ?? candidates.find((item) => item.title.toLowerCase().includes(lower))
  }

  /** 派单决策的上下文（写 lane.log 的四个字段：项目命中方式、会话、置信分、是否澄清）。 */
  interface DispatchMeta {
    /** 项目命中方式：name / folder / fragment / daily / append / commander / clarify。 */
    via: string
    /** 会话衔接结论：append / new / gray。 */
    continuity: string
    /** 本地置信分（0..1；没有就 undefined）。 */
    confidence?: number
    /** 是否经过澄清：no（没问）/ asked（问了没答，按新建）/ yes（用户选了）。 */
    clarify: 'no' | 'asked' | 'yes'
    /** 复用「等指挥台判断」的排队卡（taskId 不变，绝不新建第二张）。 */
    reuseTaskId?: string
    /** 回执屏上多写一句短提示（例如「指挥台没接住，先派给个人助手」）。 */
    note?: string
  }

  /** 决策原因落 ~/.dsh/tihu/lane.log（项目命中方式、会话命中 id、置信分、是否澄清）。 */
  function logDispatchDecision(projectName: string, sessionId: string | undefined, meta: DispatchMeta): void {
    const confidence = meta.confidence === undefined ? '-' : meta.confidence.toFixed(2)
    const message = `派单决策 项目=${projectName} 命中=${meta.via} 会话=${sessionId === undefined || sessionId === '' ? '新建' : sessionId} 衔接=${meta.continuity} 置信=${confidence} 澄清=${meta.clarify}`
    try { appendTihuLaneLog(sessionId === undefined || sessionId === '' ? '-' : sessionId, new Error(message), 'dispatch-decision') } catch { /* 日志失败不影响派单 */ }
    log(`tihu ${message}`)
  }

  /** 续聊尾巴：告诉任务会话「这是接着之前那条做」，别推翻已完成的部分。 */
  function appendTailOf(card: { name: string }, folder: string): string {
    return `【续聊 · 鹈鹕】这一句是接着本条会话前面的事继续做（项目「${card.name}」，工作目录 ${folder} 不变）。在已有进展上增量修改，别从头再来，也别动前面已经确认过的部分。做完后用简洁中文说明结果：先给结论，再给关键数字或进展，文字不要太长，适合直接朗读；不要表格、列表、代码块或长路径。`
  }

  /** 某项目「正在干什么」（追问屏的候选说明用）。 */
  function doingOf(projectId: string): string {
    const active = tasks.list()
      .filter((task) => task.projectId === projectId && task.state !== 'archived' && task.state !== 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (active === undefined) return ''
    if (active.state === 'awaiting') return '在等你答一句'
    if (active.step > 0) return `在跑第 ${active.step} 步`
    return '在跑'
  }

  /* ---------- 电脑端会话镜像：轮询 → 登记簿（source='pc'） ---------- */

  /** 会话标题 → 棋盘任务名（沿用 taskTitleOf 截断，裸 id 走 humanTitle 兜底）。 */
  function externalTitleOf(row: TihuSessionRow): string {
    const raw = String(row.title ?? '').trim()
    return taskTitleOf(humanTitle(raw !== '' ? raw : titleForSession(row.sessionId)))
  }

  /**
   * 让一条电脑端外部任务下屏并归档（用户 2026-11-10：非 CU 会话完全不上屏）。
   * 屏正停在它的详情页时，顺手把人送回棋盘——否则卡片没了、屏还停在幽灵任务上。
   */
  function archivePcTask(taskId: string, now: number, why: string): boolean {
    pcTaskOfSession.forEach((value, sessionId) => { if (value === taskId) pcTaskOfSession.delete(sessionId) })
    if (tasks.get(taskId)?.state === 'archived') return false
    const line = tasks.archive(taskId, now)
    if (line !== undefined) appendTaskJournal(line)
    for (const device of devices) {
      if (device.focusedTask !== taskId) continue
      sendBoard(device)
    }
    refreshBoards()
    log(`tihu pc task archive task=${taskId} why=${why}`)
    return true
  }

  /**
   * 把电脑端会话同步进登记簿（一次轮询）：新建 / 更新 / 归档外部任务。
   *
   * 纪律：
   *   1. 数据源只用现有会话列表（`collectSessionRows()` 自带 `sessionListTtlMs` 节流，
   *      不会因为轮询而额外狂调 `listSessions`）；
   *   2. 指挥会话、以及已被**派单任务**绑定的会话一律跳过（避免同一会话两张卡）；
   *   3. 只改登记簿：不派单、不建会话、不往任何会话投 prompt（外部任务是只读镜像）；
   *   4. 只镜像 Computer Use 模式的电脑端会话（用户 2026-11-10 规则，普通模式完全不上屏）。
   */
  async function syncExternalSessions(): Promise<void> {
    if (disposed || pcSyncing) return
    pcSyncing = true
    try {
      let rows: TihuSessionRow[]
      try {
        rows = (await collectSessionRows()).rows
      } catch (error) {
        log(`tihu pc sync list failed: ${(error as Error)?.message ?? String(error)}`)
        return
      }
      if (disposed) return
      const now = Date.now()
      const agents = liveAgentList()
      // 派单任务占着的会话不再上电脑端卡片：归档过的也算（那条会话已经属于鹈鹕任务）。
      const bound = new Set<string>()
      for (const task of tasks.list()) {
        if (task.source === 'pc') continue
        for (const sessionId of task.sessionIds) bound.add(sessionId)
      }
      const wanted = new Map<string, { row: TihuSessionRow; state: 'queued' | 'running' | 'done'; activity: number; start: number; childRunning: number }>()
      for (const row of rows) {
        if (wanted.size >= PC_SESSION_MAX) break
        const sessionId = row.sessionId
        if (sessionId === '') continue
        if (sessionId === commanderSessionId) continue
        if (bound.has(sessionId)) continue
        // 用户 2026-11-10 规则：**只有 Computer Use 模式的电脑端会话才上屏**。
        // 普通模式（standard / standard-slim-local / cordis…）一律不进登记簿、不上棋盘、
        // 不播报、不计入在跑/等你/排队。判定读宿主投影 `agentPreset`（缺省回退
        // header.agentPreset，见 presetOf；实测 projcache 里取值就是 computer-use/standard/…，
        // `computerUse` 只是绑定回执里的占位布尔，不代表模式）。
        if (!isComputerUsePreset(row.preset)) continue
        const known = pcTaskOfSession.get(sessionId)
        const createdAt = Number(row.createdAt) || 0
        const updatedAt = Number(row.updatedAt) || 0
        const agentRunning = runningSessions.has(sessionId)
        const activity = Math.max(updatedAt, pcActivityAt.get(sessionId) ?? 0)
        // 「刚创建还没发过消息」：既没有 lastPromptAt，也没有回复/事件（createdAt 之后的动静）。
        const blank = activity <= createdAt && lastAssistant.get(sessionId) === undefined
        // 3 天窗口（直接复用 DONE_KEEP_MS，与登记簿自动归档同一口径）：
        // 超过 3 天没活动的会话不进登记簿；已经在屏上的也在这一步被筛掉，随后按归档规则下屏。
        // 有 agent 正在跑的会话永远不按「静置」处理（turn 里没有新的会话列表活动时间）。
        if (!agentRunning && (activity <= 0 || now - activity > PC_SESSION_WINDOW_MS)) continue
        // 空会话只在「刚建」那段时间占位，过了排队窗口就不再上屏。
        if (blank && now - createdAt > PC_QUEUED_WINDOW_MS) continue
        if (known === undefined) {
          const dismissed = pcDismissedAt.get(sessionId)
          if (dismissed !== undefined && activity <= dismissed) continue
        }
        // 用户 2026-11-10：这一轮**已经结束**的会话，列表活动再新也不算在跑。
        // 旧口径只看「15 秒内有活动」，turn/end 那一刻也被算成活动，于是已完成的会话
        // 被下一轮 syncExternal 抖回 running（finishedAt 被清、已用从头再长）。
        // 判「结束在最后一次用户发言之后」：只有新的用户发言（lastPromptAt 变新）才算新一轮；
        // 迟到的 assistant/step 事件只更新 pcActivityAt，不能把回合重新打开。
        const endedAt = turnEndedAt.get(sessionId) ?? 0
        const turnOver = endedAt > 0 && (updatedAt <= 0 || endedAt >= updatedAt)
        const running = agentRunning || (!turnOver && now - activity <= PC_ACTIVE_WINDOW_MS)
        // 已经显示成「执行中」的那一条不许抖成「完成 → 执行中」：电脑端 CU 会话一步等用户
        // 在这侧点屏幕能空好几十秒，每一次抖动都把「已用」与时长环抹回 0（实机就是这个）。
        const stillRunning = !running && !turnOver && known !== undefined && known !== ''
          && tasks.get(known ?? '')?.state === 'running' && now - activity <= PC_RUNNING_STILL_MS
        // 子代理还在跑：主会话看起来完成了，这条任务也算「执行中」（用户 2026-11-10）。
        const childRunning = runningSubagentCountOf(sessionId, agents)
        const state: 'queued' | 'running' | 'done' = blank ? 'queued' : (running || stillRunning || childRunning > 0) ? 'running' : 'done'
        // 这一轮的起点：列表投影的 lastPromptAt（真实发言时刻），拿不到才退回活动时刻。
        const start = updatedAt > 0 ? updatedAt : (activity > 0 ? activity : (createdAt || now))
        wanted.set(sessionId, { row, state, activity: activity > 0 ? activity : (createdAt || now), start, childRunning })
      }
      let changed = false
      // 先撤掉不该再上屏的：会话被归档/删除、被派单任务接管、被用户撤掉、空了太久、
      // 或者**模式被切走**（Computer Use → 普通）。
      for (const [sessionId, taskId] of [...pcTaskOfSession]) {
        if (wanted.has(sessionId)) continue
        const row = rows.find((item) => item.sessionId === sessionId)
        const why = row === undefined ? 'session gone' : `preset=${row.preset || '?'}`
        if (archivePcTask(taskId, now, why)) changed = true
      }
      for (const [sessionId, item] of wanted) {
        const title = externalTitleOf(item.row)
        const projectName = externalProjectNameOf(item.row.cwd) || '电脑端'
        const existingId = pcTaskOfSession.get(sessionId)
        if (existingId === undefined) {
          const task = tasks.add({
            title,
            projectId: `pc:${sessionId}`,
            projectName,
            ...(item.row.cwd === undefined ? {} : { folder: item.row.cwd }),
            preset: item.row.preset,
            sessionIds: [sessionId],
            source: 'pc',
            state: item.state,
            startedAt: item.start,
            now,
          })
          pcTaskOfSession.set(sessionId, task.taskId)
          tasks.setChildRunning(task.taskId, item.childRunning, now)
          if (item.state === 'running') noteRunAnchor(task.taskId, pcStartAnchorOf(sessionId, item.start))
          changed = true
          log(`tihu pc task add task=${task.taskId} session=${sessionId} state=${item.state} children=${item.childRunning} title=${JSON.stringify(task.title)}`)
          continue
        }
        if (tasks.setChildRunning(existingId, item.childRunning, now)) changed = true
        const summary = item.state === 'done' ? plainSummaryOf(lastAssistant.get(sessionId)?.text ?? '') : ''
        if (tasks.syncExternal(existingId, {
          title,
          projectName,
          ...(item.row.cwd === undefined ? {} : { folder: item.row.cwd }),
          state: item.state,
          // 锚点＝这轮真正开始的时刻（列表投影里的 lastPromptAt），不是「此刻」：
          // 用此刻就会让「已用」在每次轮询归零（实机那条「已用 0s 永远不动」）。
          startedAt: pcStartAnchorOf(sessionId, item.start),
          at: now,
          ...(summary === '' ? {} : { summary }),
        })) changed = true
      }
      if (changed) refreshBoards()
      // 子代理可能刚好在这轮轮询前结束：补一次收敛（挂起的任务在这里转完成并补播报）。
      reconcileChildTasks('pc-sync')
      // 用户 2026-11-10 实机回归：同步/轮询**不许**跳进度页。
      // 旧实现按「第一次同步看到的在跑任务」自动跟随，回合结束后列表活动还在窗口里，
      // 设备一回棋盘就被下一次同步/重连拽回旧进度页（已用 3m28s 就是这么来的）。
      // 现在自动跳屏只剩一个入口：session/event 的 turn/start（见 followRunningTask）。
    } finally {
      pcSyncing = false
    }
  }

  /** 起轮询（有统一指挥设备在线才需要；真正的列表请求仍由 sessionListTtlMs 节流）。 */
  function ensurePcSync(): void {
    if (disposed || pcSyncTimer !== undefined) return
    const timer = setInterval(() => {
      void syncExternalSessions().catch((error) => log(`tihu pc sync failed: ${(error as Error)?.message ?? String(error)}`))
    }, tihuPcSyncMs()) as unknown as { unref?: () => void }
    timer.unref?.()
    pcSyncTimer = timer as unknown as ReturnType<typeof setInterval>
  }

  function stopPcSync(): void {
    if (pcSyncTimer !== undefined) {
      clearInterval(pcSyncTimer)
      pcSyncTimer = undefined
    }
  }

  /**
   * 打开电脑端外部任务卡：看它的**进度详情**（新屏 4），不是派单、也不是旧的会话屏。
   *
   * 外部任务卡是只读镜像：不新建会话、不投 prompt、不发派单回执、不触发派单尾巴；
   * 屏不会自动跳走，点/说「回棋盘」回来。
   */
  async function openExternalTask(device: TihuDevice, task: TihuTask): Promise<void> {
    if (device.receiptTimer !== undefined) {
      clearTimeout(device.receiptTimer)
      device.receiptTimer = undefined
    }
    disarmAutoHome(device)
    device.pendingPick = undefined
    device.focusedTask = task.taskId
    device.onBoard = false
    progressEventAt.set(task.taskId, Date.now())
    const frame = taskDetailFrameOf(task)
      ?? noticeFrame({ stage: '电脑端', title: task.title, lines: ['这条会话还没开始跑'], tone: 'idle' })
    sendFrame(device, frame, device.sessionId)
    armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, '进度')
    ensureDetailTicker()
    device.send('event.progress', {
      stage: '电脑端',
      text: `电脑端会话：${task.title}；点/说「回棋盘」可回来`,
    } satisfies ProgressPayload)
    log(`tihu pc open task=${task.taskId} session=${task.sessionIds[0] ?? '-'}`)
  }

  /** 用户撤掉一条电脑端任务：记下「别复活」（同一条会话没有新动静前不再上屏）。 */
  function dismissExternalTask(task: TihuTask): void {
    for (const [sessionId, taskId] of [...pcTaskOfSession]) {
      if (taskId !== task.taskId) continue
      pcDismissedAt.set(sessionId, Date.now())
      pcTaskOfSession.delete(sessionId)
    }
  }

  /** 棋盘一帧：每页 4 行，页码从这台设备的 `boardPage` 拿（翻不动就夹回最后一张页）。 */
  let boardTicker: ReturnType<typeof setInterval> | undefined
  function boardFrameFor(page: number): { frame: ScreenFramePayload; board: TaskBoardPayload } {
    const board = boardOf(tasks.list(), Date.now(), page)
    return { frame: boardFrame(board), board }
  }

  /** 屏 1：任务棋盘（含空态）。同一版式，有任务就是棋盘、没任务就是空盘。 */
  function sendBoard(device: TihuDevice, resetPage = false): void {
    const key = device.sessionId ?? device.id
    const { frame, board } = boardFrameFor(resetPage ? 0 : Math.max(0, Math.trunc(device.boardPage ?? 0)))
    // 页码夹到真实范围内（任务少了一条，最后一张页可能已经没了）。
    device.boardPage = board.page.index
    // 回棋盘＝明确离开回执/追问/详情：旧计时器与待选项一起清掉。
    if (device.receiptTimer !== undefined) {
      clearTimeout(device.receiptTimer)
      device.receiptTimer = undefined
    }
    disarmAutoHome(device)
    device.pendingPick = undefined
    device.focusedTask = undefined
    device.onBoard = true
    device.doneReadingTask = undefined
    lastFrames.set(key, frame)
    pushFrame(device, frame)
    device.send('task.list', { board } satisfies TaskListPayload)
    log(`tihu board device=${device.id} rows=${board.rows.length} page=${board.page.index + 1}/${board.page.total} awaiting=${board.counts.awaiting} running=${board.counts.running} queued=${board.counts.queued} done=${board.counts.done}`)
    device.boardHasRunning = board.rows.some((row) => row.state === 'running')
    ensureBoardTicker()
  }

  /**
   * 棋盘上有「在跑」的行时按时钟重发帧：右侧那条蓝色弧是按「已运行时长占 30 分钟的百分比」
   * 画的，不重发就永远停在打开那一刻的比例（原来只有任务事件才刷新）。
   */
  function ensureBoardTicker(): void {
    if (boardTicker !== undefined) return
    boardTicker = setInterval(() => {
      const stillRunning = [...devices].some((device) => device.unified && device.onBoard === true
        && device.focusedTask === undefined && device.boardHasRunning === true)
      if (!stillRunning) {
        clearInterval(boardTicker)
        boardTicker = undefined
        return
      }
      refreshBoards()
    }, BOARD_TICK_MS)
    boardTicker.unref?.()
  }

  /** 棋盘变化：还停在棋盘上的设备刷一帧（详情屏/回执屏不动，免得把人弹走）。 */
  function refreshBoards(): void {
    for (const device of devices) {
      if (!device.unified) continue
      if (device.focusedTask !== undefined) continue
      if (device.onBoard !== true) continue
      sendBoard(device)
    }
  }

  /**
   * 只更新棋盘数据、不换屏：失败撤单时屏还停在错误页/等待页，
   * 但下一次按「主页」必须看到这张卡已经没了（不能留一张假排队）。
   */
  function broadcastBoardSnapshot(): void {
    const board = boardOf(tasks.list(), Date.now())
    for (const device of devices) {
      if (device.unified) device.send('task.list', { board } satisfies TaskListPayload)
    }
  }

  /**
   * 电脑端任务开跑：设备自动切到这条任务的「进度」页（屏 4，不是待决策）。
   *
   * **只允许在真正的 turn/start 之后调用**（用户 2026-11-10 实机回归）：
   * 同步/轮询看到的「15 秒内有活动 / 之前显示成执行中」都是旧状态，不能触发跳屏，
   * 否则回合结束后设备回棋盘也会被下一次同步拽回旧进度页。调用点只有 session/event 的
   * turn/start 分支；这里再校验一遍任务此刻确实还在 running（子代理在跑也算）。
   */
  function followRunningTask(task: TihuTask): void {
    if (task.source !== 'pc') return
    if (!taskRunningNow(task)) {
      log(`tihu follow skipped task=${task.taskId} state=${task.state}`)
      return
    }
    for (const device of devices) {
      if (!device.unified) continue
      if (device.receiptTimer !== undefined || device.pendingPick !== undefined) continue
      if (device.pendingVoice !== undefined) continue
      const frame = taskDetailFrameOf(task)
      if (frame === undefined) continue
      disarmAutoHome(device)
      device.focusedTask = task.taskId
      device.onBoard = false
      progressEventAt.set(task.taskId, Date.now())
      sendFrame(device, frame, device.sessionId)
      armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, '进度')
      ensureDetailTicker()
      log(`tihu follow task=${task.taskId} device=${device.id}`)
    }
  }

  /** 这条任务此刻是真的在跑吗（turn 还在跑，或还有子代理在跑）。 */
  function taskRunningNow(task: TihuTask): boolean {
    if (task.state !== 'running') return false
    if ((task.childRunning ?? 0) > 0) return true
    const sessionId = task.sessionIds[task.sessionIds.length - 1]
    return sessionId !== undefined && runningSessions.has(sessionId)
  }

  /** 还停在这条任务「进度」页的设备：这一轮结束后立刻回棋盘，不许继续挂旧进度。 */
  function leaveStaleProgress(task: TihuTask, why: string): void {
    for (const device of devices) {
      if (!device.unified) continue
      if (device.focusedTask !== task.taskId) continue
      if (device.screenStage !== '进度') continue
      if (device.receiptTimer !== undefined || device.pendingPick !== undefined) continue
      log(`tihu progress leave device=${device.id} task=${task.taskId} why=${why}`)
      sendBoard(device)
    }
  }

  /** 取消「读完回棋盘」的计时（任何交互都取消）。 */
  function disarmAutoHome(device: TihuDevice): void {
    if (device.homeTimer !== undefined) clearTimeout(device.homeTimer)
    device.homeTimer = undefined
    device.homeTask = undefined
  }

  /**
   * 定时回棋盘（完成页 / 进度页 / 决策页共用）。
   *
   * `expectStage` 给定时还要求屏上仍是那一屏（完成后又被进度帧刷掉之类的情况不抢屏）；
   * 期间任何交互/换屏都会 disarm，计时器不会把用户从新页面弹走。
   */
  function armScreenHome(device: TihuDevice, waitMs: number, taskId?: string, expectStage?: string): void {
    disarmAutoHome(device)
    device.homeTask = taskId
    const wait = Math.max(0, Math.round(Number(waitMs) || 0))
    const timer = setTimeout(() => {
      device.homeTimer = undefined
      if (!devices.has(device)) return
      if (device.onBoard === true) return
      if (device.homeTask !== taskId) return
      if (taskId !== undefined && device.focusedTask !== taskId) return
      if (expectStage !== undefined && device.screenStage !== expectStage) return
      device.homeTask = undefined
      log(`tihu auto home device=${device.id} task=${taskId ?? '-'} stage=${expectStage ?? '-'}`)
      sendBoard(device)
    }, wait)
    timer.unref?.()
    device.homeTimer = timer
    log(`tihu auto home armed device=${device.id} after=${wait}ms stage=${expectStage ?? '-'}`)
  }

  /**
   * 朗读结束 → 60 秒后自动回棋盘（用户 2026-11-09）。
   *
   * 只在设备还停在「刚念完的那一屏」、期间没人交互时才回：用户点了别的任务、
   * 已经自己回棋盘、或在看另一条完成屏，都不许被这个计时器抢走。
   */
  function armAutoHome(device: TihuDevice, spokenMs: number, taskId?: string): void {
    armScreenHome(device, Math.max(0, Math.round(Number(spokenMs) || 0)) + HOME_AFTER_SPEECH_MS, taskId)
  }

  /** 单行变更（协议里的 task.update；固件按它只改一行，不重画整屏）。 */
  function sendTaskUpdate(device: TihuDevice, task: TihuTask): void {
    if (!device.unified) return
    const board = boardOf([task], Date.now())
    const row = board.rows[0]
    if (row === undefined) return
    device.send('task.update', {
      taskId: task.taskId,
      state: row.state,
      capsule: row.capsule,
      sub: row.sub,
      ring: row.ring,
      ...(task.summary === '' ? {} : { summary: task.summary }),
    } satisfies TaskUpdatePayload)
  }

  /** 通知总线 → 屏与播报（P0 立即、P1/P2 八秒合并、P3 不播）。 */
  function pushTaskNotify(task: TihuTask | undefined, level: 0 | 1 | 2 | 3, text: string): void {
    const taskId = task?.taskId ?? ''
    notifyBus.push(level, taskId, text)
    // P0 永远立刻；P1/P2 若还有别的任务在跑，就把 8 秒合并窗口打开（只由这一批的
    // 第一条开窗，后续完成不再顺延）。否则单条 400ms 就出队，同一批的后续完成
    // 永远并不到一句里（2026-11-09 实测三条完成被念三遍）。
    if (level === 0) {
      announceHoldUntil = 0
    } else if ((level === 1 || level === 2) && announceHoldUntil === 0
      && tasks.list().some((item) => item.taskId !== taskId
        && (item.state === 'running' || item.state === 'queued' || item.state === 'awaiting'))) {
      announceHoldUntil = Date.now() + ANNOUNCE_WINDOW_MS
    }
    for (const device of devices) {
      if (!device.unified) continue
      device.send('task.notify', { level, taskId, text, ...(taskId === '' ? {} : { bubbleId: taskId }), spoken: false } satisfies TaskNotifyPayload)
    }
    scheduleAnnounce()
  }

  function scheduleAnnounce(): void {
    if (disposed) return
    if (announceTimer !== undefined) {
      clearTimeout(announceTimer)
      announceTimer = undefined
    }
    const next = notifyBus.nextAt()
    if (next === undefined) return
    const at = Math.max(next, announceHoldUntil)
    announceTimer = setTimeout(() => {
      announceTimer = undefined
      try {
        flushAnnounce()
      } catch (error) {
        log(`tihu announce failed: ${(error as Error)?.stack ?? String(error)}`)
      }
    }, Math.max(0, at - Date.now()))
    announceTimer.unref?.()
  }

  function flushAnnounce(): void {
    const item = notifyBus.take()
    if (item === undefined) {
      scheduleAnnounce()
      return
    }
    // 这一批已经取走：窗口关掉，下一批重新开（否则会把下一批也拖到旧窗口）。
    announceHoldUntil = 0
    for (const taskId of item.taskIds) if (taskId !== '') tasks.markSpoken(taskId)
    for (const device of devices) {
      if (!device.unified) continue
      // P0（要人）**打断当前朗读**：漏掉一次确认比多打断一次贵得多（设计 §8.7 的优先级表）。
      if (item.level === 0) {
        try { device.cancelRound?.() } catch { /* 忽略 */ }
      }
      // 完成页正文已经在这台设备上念过了：这条「标题——第一句」不再另开一轮。
      // 另开一轮正是实测「只念第一句、后面全哑」的来源（新一轮会把正文的 PCM 中途掐掉）。
      const alreadyRead = item.taskIds.some((taskId) => taskId !== '' && taskId === device.doneReadingTask)
      device.send('task.notify', {
        level: item.level,
        taskId: item.taskIds[0] ?? '',
        text: item.text,
        spoken: !alreadyRead,
      } satisfies TaskNotifyPayload)
      if (alreadyRead) {
        log(`tihu announce skipped device=${device.id} task=${device.doneReadingTask}（完成页整段正文在念，不重复念标题）`)
        continue
      }
      void speakAnnouncement(device, item.text)
        .then((spokenMs) => { if (spokenMs >= 0) armAutoHome(device, spokenMs, item.taskIds[0] || undefined) })
        .catch((error) => log(`tihu announce speak failed: ${(error as Error)?.message ?? String(error)}`))
    }
    log(`tihu announce level=${item.level} tasks=${item.taskIds.join(',')} text=${JSON.stringify(item.text)}`)
    scheduleAnnounce()
  }

  /**
   * 念一句播报（只念这一句，正文不上耳朵）。
   *
   * 为什么不复用 speakLocally：那条链路是「回答屏 ＋ 逐句高亮 ＋ 预取」，播报没有正文可高亮，
   * 硬塞进去会往屏上推 reply 帧、把棋盘顶掉。这里按句**顺序合成顺序下发**（不做预取：
   * 播报就一两句，预取省不了多少，还会让两句的顺序在弱网下乱掉）。
   *
   * 单句播报先查**预录缓存**（`~/.dsh/tihu/preroll/`）：同一句话第二次念不再合成，
   * 直接把裸 PCM 发下去——这是「完成 → 3 秒内听到」最省的一刀（设计 §11 P3）。
   */
  async function speakAnnouncement(device: TihuDevice, text: string): Promise<number> {
    const key = device.sessionId ?? '__unbound__'
    const segments = splitSpeechSegments(text)
      .map((segment) => ({ ...segment, text: toSpeechText(segment.text) }))
      .filter((segment) => segment.text !== '')
    if (segments.length === 0) return -1
    // 一句话播报不打断正在进行的朗读（完成页整段正文、或另一条播报）。
    if (announcing.has(device.id)) return -1
    const epoch = (device.speakEpoch = (device.speakEpoch ?? 0) + 1)
    announcing.add(device.id)
    const stale = (): boolean => device.speakEpoch !== epoch
    /** 本次下发的 PCM 总时长（毫秒）：页面按同一时间轴排程，用来算「读完」。 */
    let spokenMs = 0
    const cacheable = segments.length === 1
    const sendPcm = (pcm: Buffer, segment: { text: string; index: number; start: number; end: number }, final = true): void => {
      device.send('tts.audio', {
        seq: 0,
        total: 1,
        sampleRate: 24000,
        channels: 1,
        format: 'pcm16',
        data: pcm.toString('base64'),
        index: segment.index,
        text: segment.text,
        charStart: segment.start,
        charEnd: segment.end,
        ...(final ? { final: true } : {}),
      } satisfies TtsAudioPayload)
    }
    try {
      if (cacheable) {
        const cached = preroll.get(device.voice, segments[0].text)
        if (cached !== undefined) {
          sendPcm(cached, segments[0])
          log(`tihu announce preroll hit chars=${[...segments[0].text].length} audio=${prerollAudioMs(cached.length)}ms`)
          return prerollAudioMs(cached.length)
        }
      }
      if (!tts.available()) {
        try { await tts.ensureServer() } catch { /* 合成阶段会给出可读错误 */ }
      }
      const status = tts.status()
      if (!status.available) {
        device.send('event.alert', { level: 'error', text: `本次无语音：${status.error ?? '本地引擎未就绪'}（任务结果已上屏）` })
        return 0
      }
      for (const segment of segments) {
        // 上一块还没发完就可能被「停止/重读/P0 打断」抢走：号变了就立刻停手。
        if (stale()) return spokenMs
        const startedAt = Date.now()
        const parts: Buffer[] = []
        const result = await tts.synthesize(segment.text, {
          voice: device.voice,
          sessionId: key,
          edgeVoice: device.edgeVoice,
          offlineOnly: device.offlineOnly,
          onChunk: (chunk) => {
            if (stale()) return
            if (cacheable) parts.push(chunk.data)
            spokenMs += chunk.data.length / 2 / 24000 * 1000
            device.send('tts.audio', {
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
          },
        })
        if (cacheable && parts.length > 0) {
          // 存进预录：下一次同一句话直接发，不再合成。
          preroll.put(device.voice, segment.text, Buffer.concat(parts))
        }
        // 播放时间轴＝首块到达时刻 ＋ 累计音频时长（与页面 AudioContext 排程同口径）。
      }
      return spokenMs
    } catch (error) {
      log(`tihu announce synth failed: ${(error as Error)?.message ?? String(error)}`)
      device.send('event.alert', { level: 'error', text: `播报没念出来：${(error as Error)?.message ?? String(error)}（任务结果已上屏）` })
      return spokenMs
    } finally {
      // 只有自己还是当前那一轮才清标记：被重读接管时，新一轮已经把 announcing 重新占上了。
      if (device.speakEpoch === epoch) announcing.delete(device.id)
    }
  }

  /* ---------- 完成页朗读：整段正文，一行一段（与屏上 done.ranges 同一坐标） ----------
   *
   * 2026-11-10 第三版（用户实机反馈）：完成页原来**只念了「标题——第一句」**，
   * 因为任务完成时只推了一条 P1 播报（`doneAnnouncementOf` = 标题＋结果第一句），
   * 完成页正文压根没进过朗读链路；而高亮却跟着 PCM 继续往前行 —— 两者读的根本不是
   * 同一份文本。现在统一成一件事：**完成屏上屏就念屏上那份完整正文，每一行念一遍，
   * 全部念完**，朗读分段直接来自 `done.ranges`（同一份 `prepareDoneText` 的结果），
   * 所以每块 PCM 的 `charStart/charEnd` 就是那一行的区间，不需要页面做任何推算。
   *
   * 三处必须同时念完的原因（原实现留下的坑）：
   *   1. 段与段之间没有 `return`/`break` 早退：唯一能中断的是「停止/重读/P0 抢屏」，
   *      那靠 `speakEpoch` 对号（号变了才停手），不是循环本身的出口；
   *   2. 播报（P1）不再抢正文这一轮：这条任务已经在该设备上念过正文，
   *      `flushAnnounce` 直接把这条播报标记成未念（见 `device.doneReadingTask`）；
   *   3. 合成不再逐段串行等首包：一段在合成时，后面几段已经在跑（`DONE_SYNTH_AHEAD`），
   *      下发仍按行序，页面时间轴首尾相接 → 高亮跟着真实播放走。
   */

  /** 完成页朗读把一整行的 PCM 再切成的块大小（120 ms @ 24 kHz 单声道 16 bit）。 */
  const DONE_READ_CHUNK_MS = 120
  const DONE_READ_SAMPLE_RATE = 24000
  const DONE_READ_CHUNK_BYTES = Math.round(DONE_READ_SAMPLE_RATE * DONE_READ_CHUNK_MS / 1000) * 2
  /** 朗读时往前预合成几段（不改变下发顺序）。 */
  const DONE_READ_AHEAD = 2

  /** 一段（若干整行）的合成结果 → 按行区间切成「每行自己的 PCM」。 */
  function sliceSegmentByLines(pcm: Buffer, segment: DoneSpeechSegment, ranges: readonly [number, number][], chars: readonly string[]): Array<{ line: number; start: number; end: number; pcm: Buffer }> {
    const lines = ranges.slice(segment.firstLine, segment.lastLine + 1)
    if (lines.length === 0 || pcm.length === 0) return []
    // 16 bit 单声道：切点必须落在**偶数**字节上。之前按比例四舍五入直接切，切到奇数位就等于
    // 把每对采样错开一个字节 —— 页面按小端 16 bit 解出来的全是满幅噪声（2026-11-10 实机「刺耳杂音」
    // 就是这么来的：只有按行分段这版会切，所以是它之后才出现）。
    const even = (value: number): number => Math.max(0, Math.min(pcm.length, Math.round(value / 2) * 2))
    // 占比按「真正送进合成的那份文本」算，不按屏上正文的长度算：`toSpeechText` 会剥掉 markdown、
    // 链接、符号，按屏上正文切会把行边界一点点拖到声音前面去（2026-11-10 实机「高亮还在往前走」）。
    const weights = lines.map(([start, end]) => Math.max(1, [...toSpeechText(chars.slice(start, end).join(''))].length))
    const totalWeight = weights.reduce((total, value) => total + value, 0) || 1
    const cuts: number[] = []
    let used = 0
    for (let i = 0; i < lines.length; i += 1) {
      used += weights[i] ?? 1
      const raw = i === lines.length - 1 ? pcm.length : Math.round(pcm.length * (used / totalWeight))
      cuts.push(even(raw))
    }
    // 行边界单调递增、最后一行收干整段尾巴（切不出重叠、也不留空洞）。
    for (let i = 1; i < cuts.length; i += 1) cuts[i] = Math.max(cuts[i], cuts[i - 1])
    cuts[cuts.length - 1] = even(pcm.length)
    const out: Array<{ line: number; start: number; end: number; pcm: Buffer }> = []
    let from = 0
    for (let i = 0; i < lines.length; i += 1) {
      const [start, end] = lines[i]
      const slice = pcm.subarray(Math.min(from, pcm.length), Math.max(Math.min(from, pcm.length), cuts[i] ?? pcm.length))
      if (slice.length > 0) out.push({ line: segment.firstLine + i, start, end, pcm: slice })
      from = cuts[i] ?? pcm.length
    }
    return out
  }

  /** 按固定长度切块下发（与 `tts.audio` 原来的 120 ms 分块同口径，页面时间轴不变）。 */
  function chunkLinePcm(pcm: Buffer): Buffer[] {
    // 每块都必须是整采样（偶数字节）：奇数长度说明尾部多了半个采样，砍掉它。
    const body = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, Math.max(0, pcm.length - 1))
    if (body.length === 0) return []
    if (body.length <= DONE_READ_CHUNK_BYTES) return [body]
    const parts: Buffer[] = []
    for (let at = 0; at < body.length; at += DONE_READ_CHUNK_BYTES) {
      parts.push(body.subarray(at, Math.min(body.length, at + DONE_READ_CHUNK_BYTES)))
    }
    return parts
  }

  /**
   * 念完一条完成任务的整段正文。返回下发音频的总时长（毫秒）；一段都没念成就返回 -1。
   */
  async function readDoneBody(device: TihuDevice, task: TihuTask): Promise<number> {
    const key = device.sessionId ?? '__unbound__'
    const body = doneBodyTextOf(task)
    const ranges = doneLineRangesOf(body)
    const plan = doneSpeechSegmentsOf(body)
    if (plan.length === 0 || ranges.length === 0) return -1
    if (!tts.available()) {
      try { await tts.ensureServer() } catch { /* 合成阶段给可读错误 */ }
    }
    const status = tts.status()
    if (!status.available) {
      device.send('event.alert', { level: 'error', text: `本次无语音：${status.error ?? '本地引擎未就绪'}（任务结果已上屏）` })
      return 0
    }
    const epoch = (device.speakEpoch = (device.speakEpoch ?? 0) + 1)
    // 这条任务在这台设备上已经（开始）念正文了：flushAnnounce 不再重复念「标题——第一句」。
    device.doneReadingTask = task.taskId
    announcing.add(device.id)
    const stale = (): boolean => device.speakEpoch !== epoch
    const chars = [...body]
    let spokenMs = 0
    let failedLines = 0
    // 合成窗口：段 i 在合成时，段 i+1 / i+2 也已经在跑；下发严格按段序。
    const queued: Array<Promise<Buffer> | undefined> = []
    const launchSegment = (index: number): void => {
      if (index < 0 || index >= plan.length || queued[index] !== undefined) return
      const segment = plan[index]
      const speech = toSpeechText(segment.text)
      if (speech === '') {
        queued[index] = Promise.resolve(Buffer.alloc(0))
        return
      }
      const cached = preroll.get(device.voice, speech)
      if (cached !== undefined) {
        log(`tihu done read preroll hit line=${segment.firstLine} chars=${[...speech].length}`)
        queued[index] = Promise.resolve(cached)
        return
      }
      const parts: Buffer[] = []
      queued[index] = tts.synthesize(speech, {
        voice: device.voice,
        sessionId: key,
        edgeVoice: device.edgeVoice,
        offlineOnly: device.offlineOnly,
        // 完成页朗读不在这里直接下发：先攒齐这一段的 PCM，再按行切开按序发（行边界＝区间边界）。
        onChunk: (chunk) => { if (!stale()) parts.push(chunk.data) },
      }).then(() => Buffer.concat(parts)).then((pcm) => {
        if (pcm.length > 0) preroll.put(device.voice, speech, pcm)
        return pcm
      }).catch((error) => {
        // 这一段念不出来不能整个 abort：不发静音占位，继续往后念剩下的行。
        log(`tihu done read synth failed line=${segment.firstLine}: ${(error as Error)?.message ?? String(error)}`)
        failedLines += 1
        return Buffer.alloc(0)
      })
    }
    launchSegment(0)
    for (let index = 0; index < plan.length; index += 1) {
      // 唯一的中途出口：被「停止 / 重读 / 回主页 / P0」抢走（号变了就停手），循环本身不 break。
      if (stale()) return spokenMs
      for (let ahead = 1; ahead <= DONE_READ_AHEAD; ahead += 1) launchSegment(index + ahead)
      const pcm = (await queued[index]) ?? Buffer.alloc(0)
      if (stale()) return spokenMs
      for (const line of sliceSegmentByLines(pcm, plan[index], ranges, chars)) {
        const blocks = chunkLinePcm(line.pcm)
        const lastLine = index === plan.length - 1 && line.line === plan[index].lastLine
        const lineText = chars.slice(line.start, line.end).join('')
        for (let seq = 0; seq < blocks.length; seq += 1) {
          if (stale()) return spokenMs
          spokenMs += blocks[seq].length / 2 / DONE_READ_SAMPLE_RATE * 1000
          device.send('tts.audio', {
            seq,
            total: blocks.length,
            sampleRate: DONE_READ_SAMPLE_RATE,
            channels: 1,
            format: 'pcm16',
            data: blocks[seq].toString('base64'),
            index: line.line,
            text: lineText,
            charStart: line.start,
            charEnd: line.end,
            read: 'done',
            ...(lastLine && seq === blocks.length - 1 ? { final: true } : {}),
          } satisfies TtsAudioPayload)
        }
      }
    }
    if (failedLines > 0) {
      device.send('event.alert', { level: 'warn', text: `有几行没念出来（${failedLines} 行，引擎/网络问题），其余照常在念` } satisfies AlertPayload)
    }
    return spokenMs
  }

  /** 完成屏上屏 → 念这条任务的整段正文；念完 + 60 秒回棋盘（期间任何交互都会撤销计时）。 */
  function readDoneScreen(device: TihuDevice, task: TihuTask): void {
    void readDoneBody(device, task)
      .then((spokenMs) => {
        if (spokenMs > 0) armScreenHome(device, spokenMs + HOME_AFTER_SPEECH_MS, task.taskId, '完成')
      })
      .catch((error) => log(`tihu done read failed: ${(error as Error)?.message ?? String(error)}`))
  }

  /** 屏 4 的数据源：标题是任务名；正文只有最新一条状态 + 第 N 步/已用 + tokens（全实时）。 */
  function taskDetailFrameOf(task: TihuTask): ScreenFramePayload | undefined {
    const sessionId = task.sessionIds[task.sessionIds.length - 1]
    if (sessionId === undefined) return undefined
    const state = progressStates.get(sessionId)
    const stats = state?.stats ?? screenMetaOf(sessionId).stats
    const statsLine = stats === undefined
      ? ''
      : [
          stats.tokPerSec > 0 ? `${stats.tokPerSec.toFixed(0)} tok/s` : '',
          stats.totalTokens > 0 ? `${formatTokens(stats.totalTokens)} tok` : '',
          `上下文 ${stats.contextPercent.toFixed(0)}%`,
        ].filter((part) => part !== '').join(' · ')
    const title = task.title
    // 这一轮已经结束（或者任务已转完成）：进度页不再显示会增长的「已用」，
    // 改成「第 N 步 · 已结束」——用户 2026-11-10 明确要求不能无限挂着旧进度。
    const endedAt = runEndedAt.get(task.taskId) ?? task.finishedAt
    const ended = endedAt !== undefined && Number.isFinite(endedAt) && endedAt > 0
    return detailFrame({
      taskId: task.taskId,
      title,
      liveLine: state?.lastEventLine ?? '',
      step: Math.max(task.step, state?.step ?? 0),
      // 已用时间按「这条任务这一轮跑起来的锚点」算：锚点先到先记、**永不被轮询推到后面**；
      // 回合结束（runEndedAt / finishedAt）那一刻封顶，不跨回合累计（见 elapsedOfTask）。
      elapsedMs: elapsedOfTask(task, sessionId),
      statsLine,
      ended,
    })
  }

  /**
   * 先从不花钱的地方取：内存 Map → 活会话的 `snapshotEvents()`（同步）。
   * 命中就回填 Map，后续同一任务再开完成页不再读日志。
   */
  function cachedAssistantText(sessionId: string): string {
    const known = String(lastAssistant.get(sessionId)?.text ?? '').trim()
    if (known !== '') return known
    const live = liveSessionOf(sessionId)
    const text = lastAssistantTextOfEvents(typeof live?.snapshotEvents === 'function' ? live.snapshotEvents() : undefined)
    if (text !== '') lastAssistant.set(sessionId, { text, at: Date.now() } as ProjectReply)
    return text
  }

  /**
   * 完成页正文的最终兜底：内存没有就读会话历史（`sessionQuery.readSession` 对 live/持久化
   * 都返回完整事件，且不需要把会话加载成活会话）。
   *
   * 2026-11-10 实机根因：电脑端 CU 任务只镜像列表投影，完成态常常是轮询推出来的；进程里
   * 没收到那一轮 `assistant/message` 时 `doneText` 永远为空，旧实现就退回任务标题。
   */
  async function readAssistantText(sessionId: string): Promise<string> {
    const immediate = cachedAssistantText(sessionId)
    if (immediate !== '') return immediate
    const query = optionalService(ctx, 'sessionQuery')
    if (query === undefined || typeof query.readSession !== 'function') return ''
    try {
      const loaded = await query.readSession(sessionId)
      const text = lastAssistantTextOfEvents(loaded?.events)
      if (text !== '') lastAssistant.set(sessionId, { text, at: Date.now() } as ProjectReply)
      return text
    } catch (error) {
      log(`tihu done text read failed session=${sessionId}: ${(error as Error)?.message ?? String(error)}`)
      return ''
    }
  }

  /** 完成页正文：优先完整回答，其次一句话结果/摘要（**绝不**再拿任务标题冒充）。 */
  function doneReadingTextOf(task: TihuTask): string {
    const text = String(task.doneText ?? '').trim()
    if (text !== '') return text
    const line = String(task.resultLine ?? '').trim()
    if (line !== '') return line
    return String(task.summary ?? '').trim()
  }

  /**
   * 完成页**朗读与折行共用**的一份正文：屏上的 7 行、每行的字符区间、下发给 TTS 的
   * `charStart/charEnd` 全部基于它，高亮才能跟着真实播放走（少一个字都对不上）。
   */
  function doneBodyTextOf(task: TihuTask): string {
    return prepareDoneText(doneReadingTextOf(task) || DONE_NO_REPLY_TEXT)
  }

  /** 完成页：任务名大标题 + 回答 7 行 + 停止/重读/主页。 */
  function doneScreenOf(task: TihuTask): ScreenFramePayload {
    const body = doneBodyTextOf(task)
    const resultLine = String(task.resultLine ?? '').trim() || body || DONE_NO_REPLY_TEXT
    return doneFrame({
      taskId: task.taskId,
      title: task.title,
      resultLine,
      replyText: body,
    })
  }

  function clearReceipt(device: TihuDevice): void {
    if (device.receiptTimer !== undefined) clearTimeout(device.receiptTimer)
    device.receiptTimer = undefined
  }

  /**
   * 看完成页：立即切屏（不派单、不建会话），并按「读完 + 60 秒」回棋盘。
   *
   * 2026-11-10：正文为空时先补一次会话历史再出帧——电脑端 CU 任务是轮询镜像，
   * 内存里没有回复时不能再拿标题糊弄（旧实现 `doneBodyTextOf` 的 `|| task.title`）。
   * 取历史可能读一次会话日志（毫秒级），所以这里改成 async；调用方不等它也行。
   */
  async function showDone(device: TihuDevice, task: TihuTask, speak = true): Promise<void> {
    clearReceipt(device)
    disarmAutoHome(device)
    device.pendingPick = undefined
    device.focusedTask = task.taskId
    device.onBoard = false
    if (String(task.doneText ?? '').trim() === '') {
      const sessionId = task.sessionIds[task.sessionIds.length - 1]
      if (sessionId !== undefined) {
        const text = await readAssistantText(sessionId)
        // 读历史期间用户可能已经回棋盘/切到别的任务：晚到的完成帧不许再抢屏。
        if (!devices.has(device) || device.focusedTask !== task.taskId || device.onBoard === true) return
        if (text !== '') {
          task.doneText = text
          if (String(task.resultLine ?? '').trim() === '') task.resultLine = firstSentenceOf(text)
        }
      }
    }
    sendFrame(device, doneScreenOf(task), device.sessionId)
    armScreenHome(device, HOME_AFTER_SPEECH_MS, task.taskId, '完成')
    if (!speak) return
    // 念屏上这份 7 行正文：分段与 done.ranges 同源，一行一段，全部念完。
    readDoneScreen(device, task)
  }

  /** 看待决策页：两个选项 + 主页；到点回棋盘（不替用户选）。 */
  function showDecision(device: TihuDevice, task: TihuTask): void {
    clearReceipt(device)
    disarmAutoHome(device)
    device.pendingPick = undefined
    device.focusedTask = task.taskId
    device.onBoard = false
    const seconds = Math.max(5, Math.round(((task.decisionDeadline ?? Date.now() + 60_000) - Date.now()) / 1000))
    sendFrame(device, decisionFrame({
      taskId: task.taskId,
      title: task.title,
      ...(task.question === undefined ? {} : { question: task.question }),
      ...(task.detail === undefined ? {} : { detail: task.detail }),
      options: task.options ?? [],
      ...(task.defaultIndex === undefined ? {} : { defaultIndex: task.defaultIndex }),
      seconds,
    }), device.sessionId)
    armScreenHome(device, seconds * 1000, task.taskId, '待决策')
  }

  /** 看进度页：立即切屏；之后每秒刷新「已用」，每个事件替换最新状态行。 */
  function showDetail(device: TihuDevice, task: TihuTask): boolean {
    const frame = taskDetailFrameOf(task)
    if (frame === undefined) return false
    clearReceipt(device)
    disarmAutoHome(device)
    device.pendingPick = undefined
    device.focusedTask = task.taskId
    device.onBoard = false
    progressEventAt.set(task.taskId, Date.now())
    sendFrame(device, frame, device.sessionId)
    armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, '进度')
    ensureDetailTicker()
    return true
  }

  /**
   * 按状态分流（用户 2026-11-10）：完成→完成页、待决策→决策页、其余→进度页。
   * 三页都**立即**出帧（不等下一轮电脑端同步），电脑端会话也绝不派单。
   */
  function openTask(device: TihuDevice, taskId: string): boolean {
    const task = tasks.get(taskId)
    if (task === undefined) return false
    disarmAutoHome(device)
    if (task.state === 'done' || task.state === 'announced') {
      void showDone(device, task)
      return true
    }
    if (task.state === 'awaiting') {
      showDecision(device, task)
      return true
    }
    if (task.source === 'pc') {
      // 外部任务卡是只读镜像：打开＝看进度页（不派单、不建会话、不发尾巴）。
      void openExternalTask(device, task).catch((error) => log(`tihu pc open failed: ${(error as Error)?.message ?? String(error)}`))
      return true
    }
    return showDetail(device, task)
  }

  /** 进度页每秒重画一次：「已用」实时走、tokens 跟着刷新（不新增协议消息，仍是 screen.frame）。 */
  let detailTicker: ReturnType<typeof setInterval> | undefined
  /** 正在把某台设备从进度页换到完成页（异步读历史期间不重复触发）。 */
  const leavingProgress = new Set<string>()
  function ensureDetailTicker(): void {
    if (detailTicker !== undefined) return
    detailTicker = setInterval(() => {
      if (disposed) return
      const now = Date.now()
      const staleMs = tihuProgressStaleMs()
      for (const device of devices) {
        if (!device.unified) continue
        if (device.onBoard === true) continue
        if (device.focusedTask === undefined) continue
        if (device.receiptTimer !== undefined || device.pendingPick !== undefined) continue
        // 判「屏上现在是不是进度页」用设备自己那份（不是 lastFrames 那份共享缓存）：
        // 完成帧/播报帧把缓存改写成别的屏，旧口径就把这条进度页当成「已经不在看了」，
        // 于是每秒那一跳再也不发帧 → 已用时间冻在 0s（2026-11-10 实机）。
        if (device.screenStage !== '进度') continue
        const key = device.sessionId ?? device.id
        const task = tasks.get(device.focusedTask)
        if (task === undefined) continue
        // 结束态还挂在进度页：换完成页（不朗读），不每秒重画旧进度。
        if (task.state === 'done' || task.state === 'announced') {
          if (!leavingProgress.has(device.id)) {
            leavingProgress.add(device.id)
            void showDone(device, task, false).finally(() => { leavingProgress.delete(device.id) })
          }
          continue
        }
        if (task.state === 'awaiting') {
          showDecision(device, task)
          continue
        }
        if (task.state === 'archived') {
          sendBoard(device)
          continue
        }
        // ---------- 进度页看门狗（用户 2026-11-10）----------
        // 超过 N 秒（默认 30 秒）没有任何新的会话帧，就别再把旧进度挂在屏上：
        // 回棋盘（任务卡还在，状态由登记簿说话），并且**不会**被同步/轮询再拉回来。
        const lastAt = progressEventAt.get(task.taskId) ?? 0
        if (lastAt > 0 && now - lastAt >= staleMs) {
          log(`tihu progress watchdog device=${device.id} task=${task.taskId} idle=${now - lastAt}ms`)
          sendBoard(device)
          continue
        }
        const frame = taskDetailFrameOf(task)
        if (frame === undefined) continue
        lastFrames.set(key, frame)
        pushFrame(device, frame)
      }
    }, 1000)
    detailTicker.unref?.()
  }

  /** 一条会话事件到达：正在看这条任务进度页的设备立刻换成最新状态行（不等下一秒）。 */
  function refreshFocusedDetail(task: TihuTask): void {
    if (task.state === 'done' || task.state === 'announced' || task.state === 'awaiting') return
    for (const device of devices) {
      if (!device.unified) continue
      if (device.onBoard === true) continue
      if (device.focusedTask !== task.taskId) continue
      if (device.receiptTimer !== undefined || device.pendingPick !== undefined) continue
      if (device.screenStage !== '进度') continue
      const key = device.sessionId ?? device.id
      const frame = taskDetailFrameOf(task)
      if (frame === undefined) continue
      lastFrames.set(key, frame)
      pushFrame(device, frame)
      armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, '进度')
    }
  }

  /** 派单回执（屏 2）：停 5 秒自动回棋盘；任何交互都会取消这个计时。 */
  function showReceipt(device: TihuDevice, task: TihuTask, note?: string): void {
    const key = device.sessionId ?? '__unbound__'
    const queuedAhead = tasks.list().filter((item) => (item.state === 'queued' || item.state === 'dispatched') && item.taskId !== task.taskId).length
    const frame = receiptFrame({
      taskId: task.taskId,
      projectName: task.projectName,
      ...(task.folder === undefined ? {} : { folder: task.folder }),
      ...(note === undefined || note === '' ? {} : { note }),
      queueAhead: queuedAhead,
      ...(queuedAhead > 0 ? { etaText: `${queuedAhead} 分钟` } : { etaText: '1 分钟' }),
    })
    lastFrames.set(key, frame)
    // 统一指挥是「一台设备一张屏」：回执必须发给**所有**统一设备，而不是只发
    // 派单的那台。否则第二台停在棋盘上，任务完成时它会先弹完成屏（实测两设备分叉）。
    const targets = [...devices].filter((item) => item.unified)
    if (targets.length === 0) targets.push(device)
    for (const target of targets) {
      disarmAutoHome(target)
      target.focusedTask = task.taskId
      pushFrame(target, frame)
      sendTaskUpdate(target, task)
      target.send('task.list', { board: boardOf(tasks.list(), Date.now()) } satisfies TaskListPayload)
      if (target.receiptTimer !== undefined) clearTimeout(target.receiptTimer)
      target.receiptTimer = setTimeout(() => {
        target.receiptTimer = undefined
        if (!devices.has(target)) return
        if (target.focusedTask !== task.taskId) return
        // 用户 2026-11-10：5 秒后不再一律回棋盘——有正在跑的就把那台的进度页亮出来。
        //   执行中 → 进度页（屏 4，实时状态行＋第 N 步）
        //   已完成 → 完成页（屏 6；一句话播报在 turn/end 已进总线，这里不再重念正文）
        //   待决策 → 决策页（要人拍板，不能只留一颗棋盘状态点）
        //   仍排队中 → 回棋盘
        const latest = tasks.get(task.taskId) ?? task
        if (latest.state === 'running' || latest.state === 'awaiting') {
          if (openTask(target, latest.taskId)) {
            log(`tihu receipt hold -> ${latest.state} task=${latest.taskId}`)
            return
          }
        } else if (latest.state === 'done' || latest.state === 'announced') {
          // 回执期间完成帧被挡在门外（见 session/event 的 receiptTimer 判断），这里把屏补上。
          // 不再念整段正文：完成播报已由通知总线念过一句，重念等于同一件事说两次。
          void showDone(target, latest, false)
          log(`tihu receipt hold -> done task=${latest.taskId}`)
          return
        }
        sendBoard(target)
        log(`tihu receipt hold -> board task=${latest.taskId} state=${latest.state}`)
      }, tihuReceiptHoldMs())
      target.receiptTimer.unref?.()
    }
  }

  /** 派单：建任务（或把「等指挥台判断」的排队卡转正）＋ 建 CU 会话 ＋ 投消息 ＋ 出回执。 */
  async function dispatchToCard(
    device: TihuDevice | undefined,
    text: string,
    card: { id: string; name: string; folder?: string },
    title?: string,
    meta?: DispatchMeta,
  ): Promise<TihuTask | undefined> {
    const folder = resolveTaskFolder(card)
    const decision: DispatchMeta = meta ?? { via: 'rule', continuity: 'new', clarify: 'no' }
    stopCommanderWait()
    // 这句话是不是已经在等指挥台判断？是就**复用那张卡**（taskId 不变，绝不新建第二张）。
    const reuseTaskId = decision.reuseTaskId ?? pendingCommanderTaskIdOf(text)
    let task: TihuTask | undefined
    if (reuseTaskId !== undefined) {
      const existing = tasks.get(reuseTaskId)
      if (existing !== undefined && existing.state !== 'archived') {
        task = tasks.adopt(existing.taskId, {
          title: title ?? text,
          projectId: card.id,
          projectName: card.name,
          folder,
          preset: DISPATCH_PRESET,
        })
      }
    }
    if (task === undefined) {
      task = tasks.add({
        title: title ?? text,
        projectId: card.id,
        projectName: card.name,
        folder,
        // 派单会话必须是 computer-use：设备屏要能看屏/点按，且必须是「项目文件夹」不变。
        preset: DISPATCH_PRESET,
      })
    }
    const sessionId = await createSessionAt(folder, DISPATCH_PRESET)
    if (sessionId === undefined) {
      tasks.drop(task.taskId)
      releasePendingCommanderTask(task.taskId)
      refreshBoards()
      broadcastBoardSnapshot()
      const message = '宿主还不能新建会话（sessionController.create 不可用，见 tihu 日志），这次没派出去'
      if (device !== undefined) {
        showInputError(device, new Error(message), '任务会话没建起来，请重说')
      }
      log(`tihu dispatch failed: no session service`)
      return undefined
    }
    const blocks = [
      { type: 'text' as const, text },
      {
        type: 'text' as const,
        text: `【派单 · 鹈鹕】鹈鹕是主人家里的语音小屏助手，负责把设备上说的话转交给对应项目，电脑端再执行任务。这句话已派到「${card.name}」，工作目录是 ${folder}。做完后用简洁中文说明结果：先给结论，再给关键数字或进展，文字不要太长，适合直接朗读；不要表格、列表、代码块或长路径。`,
      },
    ]
    // 先挂到任务再投消息：工具调用可能抢在 prompt() 返回前发生，闸门按
    // tasks.ofSession 找任务、待决策屏按任务取问题，晚挂一步就会漏。
    tasks.attachSession(task.taskId, sessionId)
    const sent = await promptSession(sessionId, blocks)
    if (!sent.ok) {
      tasks.drop(task.taskId)
      releasePendingCommanderTask(task.taskId)
      refreshBoards()
      broadcastBoardSnapshot()
      logDispatchDecision(card.name, sessionId, decision)
      if (device !== undefined) showInputError(device, sent.error, '任务会话没有接住这条消息，请重说')
      return undefined
    }
    // 同一句话晚到的 dispatch 不能再建第二条任务（新建会话这条路同样要立去重牌）。
    fallbackDispatch = { key: dispatchKeyOf(text), taskId: task.taskId, at: Date.now() }
    releasePendingCommanderTask(task.taskId)
    log(`tihu dispatch task=${task.taskId} project=${card.id} session=${sessionId} folder=${folder} preset=${DISPATCH_PRESET}`)
    // 派单已经发生（快路径 / 指挥会话 / 澄清）：灰区与澄清计时立刻撤掉。
    clearGrayFallback()
    clearClarifyPrompt()
    logDispatchDecision(card.name, sessionId, decision)
    if (device !== undefined) {
      showReceipt(device, task, decision.note)
      refreshBoards()
    }
    return task
  }

  /**
   * 追加到已有 CU 会话（不新建、不换文件夹）：把用户这句 ＋ 续聊尾巴投进原会话。
   *
   * 任务记账：这个会话已经有鹈鹕任务就复用（完成态拉回执行中）；没有就补一条任务挂上，
   * 但不新建会话。电脑端镜像任务（source='pc'）不当承接对象：那条卡是只读镜像。
   */
  async function appendToSession(
    device: TihuDevice | undefined,
    text: string,
    card: { id: string; name: string; folder?: string },
    target: { sessionId: string; title?: string },
    meta: DispatchMeta,
  ): Promise<TihuTask | undefined> {
    const folder = resolveTaskFolder(card)
    stopCommanderWait()
    clearGrayFallback()
    clearClarifyPrompt()
    const existing = tasks.ofSession(target.sessionId)
    if (existing !== undefined && existing.source === 'pc') {
      // 外部镜像卡不承接：用真正的鹈鹕任务接管这条会话（电脑端卡下一轮轮询会自己下屏）。
      archivePcTask(existing.taskId, Date.now(), 'tihu append')
    }
    // 这句已经在等指挥台判断：排队卡就是它，taskId 不变；这条会话改挂到这张卡上。
    const reuseTaskId = meta.reuseTaskId ?? pendingCommanderTaskIdOf(text)
    let task: TihuTask | undefined
    if (reuseTaskId !== undefined) {
      const reused = tasks.get(reuseTaskId)
      if (reused !== undefined && reused.state !== 'archived') {
        task = tasks.adopt(reused.taskId, {
          title: text,
          projectId: card.id,
          projectName: card.name,
          folder,
          preset: DISPATCH_PRESET,
        })
        if (existing !== undefined && existing.taskId !== task.taskId) {
          // 同一句话只留一张卡：会话从旧任务摘下来；旧任务还在跑就归档（不留一张永远不动的卡）。
          tasks.detachSession(existing.taskId, target.sessionId)
          if (existing.state !== 'done' && existing.state !== 'announced' && existing.state !== 'archived') {
            const removed = tasks.archive(existing.taskId, Date.now())
            if (removed !== undefined) appendTaskJournal(removed)
            log(`tihu append replace old task=${existing.taskId} -> ${task.taskId}`)
          }
        }
        tasks.attachSession(task.taskId, target.sessionId)
      }
    }
    const adoptedTask = task !== undefined
    if (task === undefined) {
      task = existing !== undefined && existing.source === 'pc' ? undefined : existing
      if (task === undefined) {
        task = tasks.add({
          title: text,
          projectId: card.id,
          projectName: card.name,
          folder,
          preset: DISPATCH_PRESET,
          sessionIds: [target.sessionId],
        })
        tasks.attachSession(task.taskId, target.sessionId)
      } else {
        tasks.reopenForAppend(task.taskId)
      }
    }
    const createdTask = adoptedTask || task.state === 'queued' || task.state === 'dispatched'
    const sent = await promptSession(target.sessionId, [
      { type: 'text', text },
      { type: 'text', text: appendTailOf(card, folder) },
    ])
    if (!sent.ok) {
      // 排队卡是我们自己立的（或这条任务是新建的）：失败就撤掉，不能让棋盘上留一张假排队。
      if (createdTask) {
        tasks.drop(task.taskId)
        releasePendingCommanderTask(task.taskId)
        refreshBoards()
        broadcastBoardSnapshot()
      }
      logDispatchDecision(card.name, target.sessionId, meta)
      if (device !== undefined) showInputError(device, sent.error, '那条会话没接住这句话，请重说')
      return undefined
    }
    tasks.markRunning(task.taskId)
    tasks.noteMilestone(task.taskId, `追加：${taskTitleOf(text)}`)
    // 同一句晚到的模型 dispatch 不能再建第二条（这条任务已经派过了）。
    fallbackDispatch = { key: dispatchKeyOf(text), taskId: task.taskId, at: Date.now() }
    releasePendingCommanderTask(task.taskId)
    logDispatchDecision(card.name, target.sessionId, meta)
    log(`tihu append task=${task.taskId} project=${card.id} session=${target.sessionId} folder=${folder} preset=${DISPATCH_PRESET}`)
    if (device !== undefined) {
      showReceipt(device, task, meta.note)
      refreshBoards()
    }
    return task
  }

  /** 派单结果（给指挥台回话用）。 */
  interface DispatchOutcome {
    task?: TihuTask
    message: string
  }

  /**
   * 派单第二步：项目定了之后判「接着哪条 CU 会话」。
   *
   * 高置信 append → 投回原会话；明确无关 new → 同项目新建；
   * 灰区 → 有人允许就问指挥台判一次（allowCommander），否则只问用户一次（屏上澄清）。
   */
  async function dispatchWithContinuity(
    device: TihuDevice | undefined,
    text: string,
    card: { id: string; name: string; folder?: string },
    meta: { via: string },
    options: { allowCommander?: boolean } = {},
  ): Promise<DispatchOutcome> {
    let candidates: TihuSessionCandidate[] = []
    try {
      candidates = await projectCuSessionsOf(card)
    } catch (error) {
      log(`tihu continuity list failed: ${(error as Error)?.message ?? String(error)}`)
    }
    const folder = resolveTaskFolder(card)
    const decision = continuityOf({
      text,
      sessions: candidates,
      now: Date.now(),
      projectHints: continuityHintsOf(card, folder),
    })
    const hitSession = decision.kind === 'append' ? decision.sessionId : decision.kind === 'gray' ? decision.sessionId ?? '-' : '-'
    log(`tihu continuity project=${card.id} via=${meta.via} kind=${decision.kind} score=${decision.confidence.toFixed(2)} session=${hitSession} ${decision.reason}`)

    if (decision.kind === 'append') {
      const target = candidates.find((item) => item.sessionId === decision.sessionId)
      const task = await appendToSession(
        device,
        text,
        card,
        { sessionId: decision.sessionId, ...(target?.title === undefined || target.title === '' ? {} : { title: target.title }) },
        { via: meta.via, continuity: 'append', confidence: decision.confidence, clarify: 'no' },
      )
      if (task === undefined) return { message: '错误：那条会话没接住这句话。' }
      return { task, message: `已接着「${task.projectName}」原有会话派出：${task.title}（任务 ${task.taskId}）` }
    }

    if (decision.kind === 'new') {
      const task = await dispatchToCard(device, text, card, undefined, { via: meta.via, continuity: 'new', confidence: decision.confidence, clarify: 'no' })
      if (task === undefined) return { message: '错误：这条任务没派出去（宿主不能新建会话，或任务会话没接住消息）。' }
      return { task, message: `已派给「${task.projectName}」：${task.title}（任务 ${task.taskId}，落在 ${task.folder ?? '默认目录'}）` }
    }

    // 灰区：先让指挥台判一次（项目已知时也可以直接问用户，见 showSessionClarify）。
    if (options.allowCommander === true && device !== undefined) {
      const asked = await askGrayCommander(device, text, card, decision, candidates, meta.via)
      return {
        message: asked
          ? '这句话的衔接在灰区：已请指挥会话判一次（接着哪条 / 还是新建）。'
          : '这句话的衔接在灰区：设备屏上会问一次「新建，还是接着刚才那条」。',
      }
    }
    await showSessionClarify(device, text, card, decision, candidates, meta.via)
    return { message: '已在设备屏上问一次：新建，还是接着刚才那条（同一条任务只问一次，不答就按新建派出）。' }
  }

  /** 灰区交给指挥台判一次：给它候选会话短号，它用 dispatch(session=…) 或 newSession 回话。 */
  async function askGrayCommander(
    device: TihuDevice,
    text: string,
    card: { id: string; name: string; folder?: string },
    decision: { confidence: number; sessionId?: string },
    candidates: readonly TihuSessionCandidate[],
    via: string,
  ): Promise<boolean> {
    const commander = await ensureCommanderSession()
    if (commander === undefined) {
      await showSessionClarify(device, text, card, { ...decision }, candidates, via)
      return false
    }
    device.unified = true
    // 灰区换屏（「正在看是不是接着做」）：停掉上一步的「已等 N 秒」秒表，排队卡留着。
    stopCommanderWait()
    const key = device.sessionId ?? device.id
    device.onBoard = false
    const frame = noticeFrame({
      stage: '派单',
      title: '正在看是不是接着做',
      lines: candidates.length > 0 ? [taskTitleOf(text, 16), `候选 ${candidates.length} 条会话`] : [taskTitleOf(text, 16)],
      tone: 'busy',
    })
    lastFrames.set(key, frame)
    const targets = [...devices].filter((item) => item.unified)
    if (targets.length === 0) targets.push(device)
    for (const target of targets) {
      if (target.receiptTimer !== undefined) {
        clearTimeout(target.receiptTimer)
        target.receiptTimer = undefined
      }
      disarmAutoHome(target)
      target.focusedTask = undefined
      pushFrame(target, frame)
    }
    const list = candidates.map((candidate, index) => {
      const short = candidate.sessionId.replace(/^session-/, '').slice(0, 8)
      const at = candidate.updatedAt > 0 ? new Date(candidate.updatedAt).toISOString().slice(5, 16).replace('T', ' ') : '未知时间'
      return `${index + 1}. ${candidate.title || '未命名会话'}（${short} · ${at}）`
    })
    const tail = [
      `【会话衔接 · 灰区】项目「${card.name}」下最近有这些 Computer Use 会话：`,
      list.length === 0 ? '（还没有 CU 会话）' : list.join('\n'),
      `用户这句话：「${text}」`,
      '判断它是不是接着其中某条在做（内容连续、指代、时间接近都算），然后**只输出一行 JSON**：',
      `{"project":"${card.name}","session":"append|new","append_to":"<那条的短号，新建留空>"}`,
      '· 接着某条 → "append"，append_to 写那条的短号；确实是一件新事 → "new"，append_to 留空。',
      '不要做正文、不要解释、不要调用任何工具；除这一行 JSON 外不要输出任何字符。拿不准就 "new"。',
    ].join('\n')
    const sent = await promptSession(commander, [{ type: 'text', text }, { type: 'text', text: tail }])
    if (!sent.ok) {
      await showSessionClarify(device, text, card, { ...decision }, candidates, via)
      return false
    }
    // 先登记再等回复：turn/start 可能抢在 promptSession 返回之后立刻到。
    // （灰区一次只处理一句：旧的连续追问等待先作废。）
    dropContinuityAsks()
    pushCommanderAsk({
      key: dispatchKeyOf(text),
      text,
      kind: 'continuity',
      card,
      candidates,
      confidence: decision.confidence,
      via,
      askedAt: Date.now(),
    })
    armGrayFallback(device, text, card, decision, candidates, via)
    return true
  }

  /** 灰区计时：指挥台在窗口内没派出 → 屏上澄清一次（不答就新建）。 */
  function armGrayFallback(
    device: TihuDevice,
    text: string,
    card: { id: string; name: string; folder?: string },
    decision: { confidence: number; sessionId?: string },
    candidates: readonly TihuSessionCandidate[],
    via: string,
  ): void {
    // 只清上一条计时器；刚登记的这句等待要留着（它的 turn 马上就到）。
    clearGrayFallback({ keepAsks: true })
    const waitMs = tihuGrayCommanderMs()
    const timer = setTimeout(() => {
      grayFallback = undefined
      if (disposed) return
      // 计时器到点：灰区的纯文本等待作废，晚到的指挥台回复不许再派一次。
      dropCommanderAsk(dispatchKeyOf(text))
      try {
        appendTihuLaneLog('-', new Error(`灰区衔接超时：${Math.round(waitMs / 1000)} 秒内指挥台没有派出「${taskTitleOf(text, 24)}」`), 'continuity-gray-timeout')
      } catch { /* 日志失败不影响兜底 */ }
      log(`tihu continuity-gray timeout after=${waitMs}ms text=${JSON.stringify(text)}`)
      void showSessionClarify(device, text, card, decision, candidates, via)
        .catch((error) => log(`tihu clarify failed: ${(error as Error)?.message ?? String(error)}`))
    }, waitMs)
    timer.unref?.()
    grayFallback = { text, key: dispatchKeyOf(text), card, confidence: decision.confidence, via, timer }
  }

  function clearGrayFallback(options: { keepAsks?: boolean } = {}): void {
    if (grayFallback === undefined) return
    clearTimeout(grayFallback.timer)
    grayFallback = undefined
    // 灰区已经有结论（派单/追加/澄清）：这支纯文本等待一并作废。
    if (options.keepAsks !== true) dropContinuityAsks()
  }

  /** 清掉屏上澄清（所有设备）与该计时器。 */
  function clearClarifyPrompt(): void {
    if (clarifyTimer !== undefined) {
      clearTimeout(clarifyTimer)
      clarifyTimer = undefined
    }
    for (const item of devices) item.pendingClarify = undefined
  }

  /**
   * 灰区且指挥台也没结论：屏上只问一次「新建，还是接着刚才那条」。
   * 已经问过同一条任务就不再问（直接按新建）；没有候选会话也直接新建。
   */
  async function showSessionClarify(
    device: TihuDevice | undefined,
    text: string,
    card: { id: string; name: string; folder?: string },
    decision: { confidence: number; sessionId?: string },
    candidates: readonly TihuSessionCandidate[],
    via: string,
  ): Promise<void> {
    const key = dispatchKeyOf(text)
    const askedAt = clarifyAsked.get(key)
    if (askedAt !== undefined && Date.now() - askedAt < CLARIFY_ONCE_MS) {
      await dispatchToCard(device, text, card, undefined, { via, continuity: 'new', confidence: decision.confidence, clarify: 'asked' })
      return
    }
    clarifyAsked.set(key, Date.now())
    for (const [oldKey, at] of clarifyAsked) {
      if (Date.now() - at > CLARIFY_ONCE_MS) clarifyAsked.delete(oldKey)
    }
    const sessionId = decision.sessionId ?? ''
    if (sessionId === '') {
      // 没有可接着的会话：不必问，直接按新建。
      await dispatchToCard(device, text, card, undefined, { via, continuity: 'new', confidence: decision.confidence, clarify: 'no' })
      return
    }
    const sessionTitle = candidates.find((item) => item.sessionId === sessionId)?.title ?? ''
    const frame = clarifySessionFrame({ sessionTitle })
    const targets = [...devices].filter((item) => item.unified)
    if (targets.length === 0 && device !== undefined) targets.push(device)
    if (targets.length === 0) {
      // 没有任何屏可问：按新建（灰区绝不猜旧会话）。
      await dispatchToCard(undefined, text, card, undefined, { via, continuity: 'new', confidence: decision.confidence, clarify: 'asked' })
      return
    }
    stopCommanderWait()
    clearGrayFallback()
    const displayKey = device?.sessionId ?? device?.id ?? targets[0].sessionId ?? targets[0].id
    lastFrames.set(displayKey, frame)
    for (const target of targets) {
      disarmAutoHome(target)
      if (target.receiptTimer !== undefined) {
        clearTimeout(target.receiptTimer)
        target.receiptTimer = undefined
      }
      target.pendingPick = undefined
      target.pendingClarify = {
        text,
        card,
        sessionId,
        sessionTitle,
        confidence: decision.confidence,
        via,
      }
      target.focusedTask = undefined
      target.onBoard = false
      pushFrame(target, frame)
    }
    if (clarifyTimer !== undefined) clearTimeout(clarifyTimer)
    const timer = setTimeout(() => {
      clarifyTimer = undefined
      if (disposed) return
      const waiting = [...devices].find((item) => item.pendingClarify !== undefined)
      const pending = waiting?.pendingClarify
      if (pending === undefined) return
      clearClarifyPrompt()
      log(`tihu clarify timeout text=${JSON.stringify(pending.text)}`)
      void dispatchToCard(waiting, pending.text, pending.card, undefined, {
        via: pending.via,
        continuity: 'new',
        confidence: pending.confidence,
        clarify: 'asked',
      }).catch((error) => log(`tihu clarify timeout dispatch failed: ${(error as Error)?.message ?? String(error)}`))
    }, tihuClarifyMs())
    timer.unref?.()
    clarifyTimer = timer
    log(`tihu clarify ask project=${card.id} session=${sessionId} score=${decision.confidence.toFixed(2)} title=${JSON.stringify(sessionTitle)}`)
  }

  /** 用户在屏上/口头答澄清：一＝新建，二＝接着那条。答完立刻派出，不再追问。 */
  async function resolveClarify(device: TihuDevice, choice: 'new' | 'same'): Promise<void> {
    const pending = device.pendingClarify
    if (pending === undefined) return
    clearClarifyPrompt()
    if (choice === 'same' && pending.sessionId !== '') {
      await appendToSession(
        device,
        pending.text,
        pending.card,
        { sessionId: pending.sessionId, ...(pending.sessionTitle === '' ? {} : { title: pending.sessionTitle }) },
        { via: pending.via, continuity: 'append', confidence: pending.confidence, clarify: 'yes' },
      )
      return
    }
    await dispatchToCard(device, pending.text, pending.card, undefined, {
      via: pending.via,
      continuity: 'new',
      confidence: pending.confidence,
      clarify: 'yes',
    })
  }

  /** 澄清待答的一句话/一次点选：「一/二」「新建/接着」都认。 */
  function clarifyChoiceOf(text: string): 'new' | 'same' | undefined {
    const clean = String(text ?? '').replace(/[\s，,。.!！?？:：、；;]+/g, '')
    if (clean === '') return undefined
    const index = chineseIndex(clean)
    if (index === 1) return 'new'
    if (index === 2) return 'same'
    if (/^(?:新建|新的|新的一条|新会话|另起|另开|重新开|单开)$/.test(clean)) return 'new'
    if (/^(?:接着|继续|原来那条|原来的|刚才那条|那条|同一个|同一会话|还那条)$/.test(clean)) return 'same'
    return undefined
  }

  /** 追加到已有任务（routeQuick 的 append 出口）：仍要过一遍会话衔接判定。 */
  async function appendToTask(device: TihuDevice, task: TihuTask, text: string): Promise<void> {
    const card = { id: task.projectId, name: task.projectName, ...(task.folder === undefined ? {} : { folder: task.folder }) }
    const outcome = await dispatchWithContinuity(device, text, card, { via: 'append' }, { allowCommander: true })
    if (outcome.task === undefined && outcome.message.startsWith('错误')) {
      showInputError(device, new Error(outcome.message), '这条没派出去，请重说')
    }
  }

  /** 歧义追问（屏 7）：只问一次；用户答「一 / 二 / 都不是」。 */
  function askWhich(device: TihuDevice, candidates: readonly TihuCardRow[], text: string): void {
    const list = candidates.slice(0, 2).map((card) => ({ id: card.id, name: card.name, ...(card.folder === undefined ? {} : { folder: card.folder }) }))
    // 候选顺序跟用户原话里出现的先后走（图 3：先说青年基金，就排第一），不按分数重排。
    list.sort((a, b) => {
      const ai = text.indexOf(a.name)
      const bi = text.indexOf(b.name)
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
    })
    const key = device.sessionId ?? device.id
    // 追问屏期间关掉「停在棋盘」标记：任务事件触发的 refreshBoards 不能把棋盘盖回来。
    for (const target of devices) if (target.unified) target.onBoard = false
    const frame = askWhichFrame({ candidates: list.map((card) => ({ projectName: card.name, doing: doingOf(card.id) || (card.folder ? `文件夹 ${folderBase(card.folder)}` : '暂无在跑任务') })) })
    lastFrames.set(key, frame)
    // 与回执一样：所有统一设备看同一张追问屏。
    const targets = [...devices].filter((item) => item.unified)
    if (targets.length === 0) targets.push(device)
    for (const target of targets) {
      target.pendingPick = { candidates: list, text }
      // 上一次派单的 5 秒回棋盘计时不能把这屏追问抢走。
      if (target.receiptTimer !== undefined) {
        clearTimeout(target.receiptTimer)
        target.receiptTimer = undefined
      }
      target.focusedTask = undefined
      pushFrame(target, frame)
    }
    pushTaskNotify(undefined, 0, `这句话派给谁：${list.map((card, index) => `${index + 1} ${card.name}`).join('，')}`)
    log(`tihu ask-which device=${device.id} candidates=${list.map((card) => card.id).join(',')}`)
  }

  /** 派单四出口之一：自己直接答（问答记忆，不落任务）。 */
  async function answerDirect(device: TihuDevice, text: string): Promise<void> {
    const commander = await ensureCommanderSession()
    if (commander === undefined) {
      showInputError(device, new Error('会话新建失败：宿主 sessionController 不可用'), '指挥会话还没建好，请重说')
      return
    }
    device.unified = true
    const key = device.sessionId ?? device.id
    device.onBoard = false
    const frame = noticeFrame({ stage: '回答', title: '我在，直接答', lines: [taskTitleOf(text, 18)], tone: 'busy' })
    lastFrames.set(key, frame)
    const targets = [...devices].filter((item) => item.unified)
    if (targets.length === 0) targets.push(device)
    for (const target of targets) {
      if (target.receiptTimer !== undefined) {
        clearTimeout(target.receiptTimer)
        target.receiptTimer = undefined
      }
      disarmAutoHome(target)
      target.pendingPick = undefined
      target.focusedTask = undefined
      pushFrame(target, frame)
    }
    const sent = await promptSession(commander, [
      { type: 'text', text },
      { type: 'text', text: '【只读问答 · 鹈鹕】这是记忆/只读问答：直接回答主人；不要调用 tihu dispatch，不要新建任务。' },
    ])
    if (!sent.ok) showInputError(device, sent.error, '指挥会话没有接住这句话，请重说')
  }

  /** 派单字面归一化：去空白与标点、转小写（去重与排队卡认领的 key）。 */
  function dispatchKeyOf(text: string): string {
    return String(text ?? '')
      .toLowerCase()
      .replace(/[\s，,。.!！?？:：、；;"'"'（）()\[\]【】《》\-_/\\]+/g, '')
  }

  /* ---------- 等指挥台判断（用户 2026-11-10：不设超时，一直等到它判出结果） ---------- */

  /**
   * 这句话对应的「等指挥台判断」排队卡。
   *
   * 指挥台晚到的 dispatch 只带原话，不带任务 id；靠字面归一化找回同一张卡，
   * 转正式任务时 **taskId 不变**，屏上不会凭空多出第二张。
   */
  function pendingCommanderTaskIdOf(text: string): string | undefined {
    const key = dispatchKeyOf(text)
    const hit = pendingCommanderTask.get(key)
    if (hit === undefined) return undefined
    const task = tasks.get(hit.taskId)
    if (task === undefined || task.state === 'archived') {
      pendingCommanderTask.delete(key)
      return undefined
    }
    return hit.taskId
  }

  /** 这张排队卡已经转成正式任务（或彻底失败）：从认领表里摘掉，并停掉秒表。 */
  function releasePendingCommanderTask(taskId: string): void {
    for (const [key, hit] of pendingCommanderTask) {
      if (hit.taskId === taskId) pendingCommanderTask.delete(key)
    }
    // 旧式工具派单（control.dispatch）也能把这张卡转正：对应的纯文本等待一并摘掉，
    // 否则指挥台随后的收尾话会被当成「没给出结论」，再派第二遍。
    dropCommanderAsksForTask(taskId)
    if (commanderWait?.taskId === taskId) stopCommanderWait()
  }

  /* ---------- 指挥台纯文本结论（2026-11-10：不依赖工具挂载） ---------- */

  /** 记一句「在等指挥台回 JSON」的话（同一句只留一条，新的替换旧的）。 */
  function pushCommanderAsk(ask: CommanderAsk): void {
    const at = commanderAsks.findIndex((item) => item.key === ask.key)
    if (at >= 0) commanderAsks.splice(at, 1)
    commanderAsks.push(ask)
  }

  /** 摘掉某一句话的等待（投递失败 / 灰区已经按澄清处理 / 新的一句顶替）。 */
  function dropCommanderAsk(key: string): void {
    for (let i = commanderAsks.length - 1; i >= 0; i -= 1) {
      if (commanderAsks[i].key === key) commanderAsks.splice(i, 1)
    }
  }

  /** 排队卡已经转正（含旧式工具 dispatch）：不再等这句的文本结论。 */
  function dropCommanderAsksForTask(taskId: string): void {
    for (let i = commanderAsks.length - 1; i >= 0; i -= 1) {
      if (commanderAsks[i].taskId === taskId) commanderAsks.splice(i, 1)
    }
  }

  /** 灰区已经走了澄清/计时器：纯文本等待作废（避免晚到回复再派一次）。 */
  function dropContinuityAsks(): void {
    for (let i = commanderAsks.length - 1; i >= 0; i -= 1) {
      if (commanderAsks[i].kind === 'continuity') commanderAsks.splice(i, 1)
    }
  }

  /** 日志里的一行原文（压空白 + 截断，避免把整段回复写进 lane.log）。 */
  function clipForLog(value: unknown, maxChars = 80): string {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    const chars = [...text]
    return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : text
  }

  /**
   * 指挥台提示里列出的「最近项目会话」（短号 + 标题）：append/append_to 才有据可依。
   * 每张卡最多 3 条、总共最多 8 行；列表走 60 秒缓存，不会为每次派单多打宿主。
   */
  async function commanderSessionHints(): Promise<string[]> {
    const hints: string[] = []
    for (const card of projectCards() ?? []) {
      if (hints.length >= 8) break
      let candidates: TihuSessionCandidate[] = []
      try { candidates = await projectCuSessionsOf(card) } catch { candidates = [] }
      for (const candidate of candidates.slice(0, 3)) {
        if (hints.length >= 8) break
        const short = candidate.sessionId.replace(/^session-/, '').slice(0, 8)
        const title = candidate.title.trim() === '' ? '未命名会话' : taskTitleOf(candidate.title, 14)
        hints.push(`- ${card.name}: ${short} ${title}`)
      }
    }
    return hints
  }

  /** 项目名 → 已知项目卡（找不到就 undefined，由调用方落个人助手；绝不按幻觉名字建新卡）。 */
  function cardForCommanderProject(project: string): { id: string; name: string; folder?: string } | undefined {
    const key = String(project ?? '').trim()
    if (key === '') return undefined
    if (/个人助手|assistant/i.test(key)) return ASSISTANT_CARD
    const cards = projectCards() ?? []
    const lower = key.toLowerCase()
    return cards.find((card) => card.id === key || card.name === key)
      ?? cards.find((card) => card.name.toLowerCase().includes(lower) || lower.includes(card.name.toLowerCase()))
      ?? cards.find((card) => String(card.folder ?? '').toLowerCase().includes(lower))
  }

  /** 这一轮（turn）对应哪一句等待；同一轮已经被 assistant/message 结算过就返回 undefined。 */
  function commanderAskForTurn(turn: number | undefined, final = false): CommanderAsk | undefined {
    if (turn !== undefined) {
      const hit = commanderAsks.find((ask) => ask.turn === turn)
      if (hit !== undefined) return hit
      // 这一轮的回复已经结算过（turn/end 只是收尾，或回复里没带可解析的结论）：
      // 绝不能让下一句等待被这一轮的文本顶替。
      if (final && commanderTurnReplied.has(turn)) return undefined
      // 回复里没有这一轮的认领记录（steer 进已在跑的 turn / turn/start 没看到）：
      // 只有一句没认领时才敢认。
      const unassigned = commanderAsks.filter((ask) => ask.turn === undefined)
      return unassigned.length === 1 ? unassigned[0] : undefined
    }
    // 拿不到 turn（老宿主/测试桩）：只有一句在等时才敢认，多句宁可等它下一轮。
    return commanderAsks.length === 1 ? commanderAsks[0] : undefined
  }

  /** 指挥会话 turn/start：把本轮认领给最早一句还没认领的等待。 */
  function assignCommanderTurn(turn: number): void {
    if (!Number.isFinite(turn) || turn <= 0) return
    const ask = commanderAsks.find((item) => item.turn === undefined)
    if (ask !== undefined) ask.turn = turn
  }

  /**
   * 指挥台回复到了（assistant/message 抢先解析，turn/end 是最后期限）。
   *
   * - 解析出可用结论 → 立刻执行（续到 append_to 指定会话 / 同项目新建 / 个人助手）；
   * - `final` 且解析失败或回复为空 → 退回 routeQuick / 最佳卡，给排队卡一个终态，
   *   绝不停在「等指挥台判断」。
   */
  async function settleCommanderReply(raw: string, final: boolean, turn?: number): Promise<void> {
    const ask = commanderAskForTurn(turn, final)
    if (ask === undefined) return
    if (turn !== undefined) {
      commanderTurnReplied.add(turn)
      if (commanderTurnReplied.size > 64) {
        // 只留最近一段（turn 单调递增）：清掉最旧的一半，避免长期运行无限增长。
        const keep = [...commanderTurnReplied].sort((a, b) => a - b).slice(-32)
        commanderTurnReplied.clear()
        for (const value of keep) commanderTurnReplied.add(value)
      }
    }
    const parsed = parseCommanderReply(raw)
    if (parsed === undefined) {
      if (!final) return
      commanderAsks.splice(commanderAsks.indexOf(ask), 1)
      await fallbackCommanderReply(ask, raw)
      return
    }
    commanderAsks.splice(commanderAsks.indexOf(ask), 1)
    await applyCommanderReply(ask, parsed, raw)
  }

  /** 按指挥台的 JSON 结论执行派单（纯文本链路；taskId 复用排队卡）。 */
  async function applyCommanderReply(ask: CommanderAsk, reply: CommanderReply, raw: string): Promise<void> {
    stopCommanderWait()
    const device = [...devices].find((item) => item.unified)
    const card = ask.kind === 'continuity' && ask.card !== undefined ? ask.card : cardForCommanderProject(reply.project)
    const target = card ?? ASSISTANT_CARD
    const meta: DispatchMeta = {
      via: ask.via,
      continuity: reply.session,
      confidence: ask.confidence ?? 1,
      clarify: 'no',
      ...(ask.taskId === undefined ? {} : { reuseTaskId: ask.taskId }),
    }
    const line = `指挥台 JSON 结论 原文=${JSON.stringify(clipForLog(raw))} 项目=${reply.project || '(未点名)'} 落点=${target.name} 会话=${reply.session}${reply.appendTo === '' ? '' : ` 续=${reply.appendTo}`}`
    try { appendTihuLaneLog(commanderSessionId ?? '-', new Error(line), 'commander-json') } catch { /* 日志失败不影响派单 */ }
    log(`tihu ${line}`)
    if (reply.session === 'append') {
      let candidates: TihuSessionCandidate[] = []
      try { candidates = await projectCuSessionsOf(target) } catch { candidates = [] }
      const hit = findContinuityTarget(candidates, reply.appendTo)
      if (hit !== undefined) {
        const task = await appendToSession(device, ask.text, target, hit, { ...meta, continuity: 'append' })
        if (task !== undefined) return
        // appendToSession 失败已经出错误屏并撤掉排队卡：不再二次派单（避免一句两卡）。
        return
      }
      try {
        appendTihuLaneLog('-', new Error(`指挥台说续 ${reply.appendTo}，但项目「${target.name}」下没有这条 CU 会话；按新建派出`), 'commander-append-miss')
      } catch { /* 日志失败不影响派单 */ }
      log(`tihu commander append miss target=${reply.appendTo} project=${target.id}`)
    }
    await dispatchToCard(device, ask.text, target, undefined, { ...meta, continuity: 'new' })
  }

  /**
   * 解析失败 / 回复为空：按 routeQuick → 最佳卡 → 个人助手依次兜底，立刻给终态。
   *
   * 灰区（continuity）不走这里：那条没有排队卡，仍由原来的澄清/计时器收尾。
   */
  async function fallbackCommanderReply(ask: CommanderAsk, raw: string): Promise<void> {
    if (ask.kind === 'continuity') {
      log(`tihu commander continuity reply unusable text=${JSON.stringify(clipForLog(raw))}`)
      return
    }
    stopCommanderWait()
    const reason = String(raw ?? '').trim() === '' ? '回复为空' : '回复里没有可用 JSON 结论'
    try {
      appendTihuLaneLog('-', new Error(`${reason}（${clipForLog(raw) || '空'}），退回 routeQuick/最佳卡`), 'commander-fallback')
    } catch { /* 日志失败不影响兜底 */ }
    log(`tihu commander ${reason} -> routeQuick/best-card fallback text=${JSON.stringify(ask.text)}`)
    const cards = projectCards() ?? []
    const route = routeQuick({ text: ask.text, cards, tasks: tasks.list() })
    let card: { id: string; name: string; folder?: string } | undefined
    let via = 'commander-fallback'
    if (route.kind === 'card') {
      card = route.card
      via = 'fallback-route'
    } else if (route.kind === 'daily') {
      card = ASSISTANT_CARD
      via = 'fallback-daily'
    } else if (route.kind === 'append') {
      card = { id: route.task.projectId, name: route.task.projectName, ...(route.task.folder === undefined ? {} : { folder: route.task.folder }) }
      via = 'fallback-append'
    } else if (route.kind === 'ambiguous') {
      card = route.candidates[0]
      via = 'fallback-best'
    }
    if (card === undefined) card = bestCardMatchOf(ask.text, cards)
    if (card === undefined) card = ASSISTANT_CARD
    const device = [...devices].find((item) => item.unified)
    const task = await dispatchToCard(device, ask.text, card, undefined, {
      via,
      continuity: 'new',
      clarify: 'no',
      reuseTaskId: ask.taskId,
      note: '指挥台没给出结论，先按最佳卡派出',
    })
    if (task !== undefined) log(`tihu commander fallback dispatched task=${task.taskId} project=${card.id} via=${via}`)
  }

  /** 停掉「已等 N 秒」的秒表（派单成功 / 新一句话 / 卸载时调用；排队卡本身不动）。 */
  function stopCommanderWait(): void {
    if (commanderWait === undefined) return
    clearInterval(commanderWait.ticker)
    commanderWait = undefined
  }

  /** 等待屏一帧：标题固定，正文第二行是「已等 N 秒」（每秒重画）。 */
  function commanderWaitFrameOf(text: string, startedAt: number): ScreenFramePayload {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    return {
      ...noticeFrame({ stage: '派单', title: '正在看该派给谁', lines: [taskTitleOf(text, 16), `已等 ${seconds} 秒`], tone: 'busy' }),
      // 等待不设超时：必须给一个「主页」出口，用户回棋盘后判断仍在后台继续。
      actions: [{ id: 'taskBoard', label: '主页' }],
    }
  }

  /**
   * 一句话刚进慢路径：**先**在棋盘上立一张排队卡（计入「●N 排队」），再投给指挥台。
   * 投递失败也复用这张卡派出去，不会出现「屏上等半天、棋盘上什么都没有」。
   */
  function createCommanderPendingTask(text: string): TihuTask {
    const task = tasks.add({
      title: text,
      projectId: ASSISTANT_CARD.id,
      projectName: ASSISTANT_CARD.name,
      preset: DISPATCH_PRESET,
      waitingCommander: true,
    })
    pendingCommanderTask.set(dispatchKeyOf(text), { taskId: task.taskId, at: Date.now() })
    refreshBoards()
    log(`tihu commander pending task=${task.taskId} text=${JSON.stringify(text)}`)
    return task
  }

  /**
   * 进入等待：所有统一设备上「派单 · 正在看该派给谁 / 已等 N 秒」，每 1 秒重画一次。
   * `onBoard === true` 的设备（用户按了「主页」）不再刷屏——判断在后台继续。
   */
  function beginCommanderWait(device: TihuDevice, text: string, taskId: string): void {
    stopCommanderWait()
    const startedAt = Date.now()
    const key = device.sessionId ?? device.id
    const frame = commanderWaitFrameOf(text, startedAt)
    lastFrames.set(key, frame)
    const targets = [...devices].filter((item) => item.unified)
    if (targets.length === 0) targets.push(device)
    for (const target of targets) {
      // 新一句话要看的屏不能被上一条回执/完成页的计时抢走。
      disarmAutoHome(target)
      if (target.receiptTimer !== undefined) {
        clearTimeout(target.receiptTimer)
        target.receiptTimer = undefined
      }
      target.pendingPick = undefined
      target.focusedTask = undefined
      target.onBoard = false
      pushFrame(target, frame)
    }
    const ticker = setInterval(() => {
      if (disposed || commanderWait === undefined) return
      const next = commanderWaitFrameOf(text, startedAt)
      // 重建指挥会话会改绑 device.sessionId：诊断用的 lastFrames 跟着新 id 走。
      lastFrames.set(device.sessionId ?? device.id, next)
      for (const target of devices) {
        if (!target.unified) continue
        // 用户回棋盘了：屏幕不再被秒表抢走，判断照旧在后台跑。
        if (target.onBoard === true) continue
        pushFrame(target, next)
      }
    }, 1_000)
    ticker.unref?.()
    commanderWait = { text, key, taskId, startedAt, ticker }
    log(`tihu commander wait task=${taskId} session=${commanderSessionId ?? '-'} text=${JSON.stringify(text)}`)
  }

  /**
   * 投递本身失败才走这里（指挥会话丢失 / prompt 抛错，含「当前没有活动 agent」）。
   *
   * `promptSession` 已经试过退避重试与重建指挥会话；到这里说明指挥台确实接不住这句话，
   * 立刻在「个人助手」下新建一条会话派出去，并在回执上留一句短提示。
   * 再失败也必须给终态（撤掉排队卡 + 错误屏），不能停在「等指挥台」。
   */
  async function fallbackCommanderDispatch(
    device: TihuDevice,
    text: string,
    pendingTaskId: string,
    error: unknown,
    stage: string,
  ): Promise<void> {
    stopCommanderWait()
    const reason = (error as Error)?.message ?? String(error)
    log(`tihu commander ${stage} failed -> personal assistant fallback: ${reason}`)
    try {
      const task = await dispatchToCard(device, text, ASSISTANT_CARD, undefined, {
        via: 'commander-fallback',
        continuity: 'new',
        clarify: 'no',
        reuseTaskId: pendingTaskId,
        note: '指挥台没接住，先派给个人助手',
      })
      if (task !== undefined) {
        device.send('event.progress', {
          stage: '派单',
          text: '指挥台没接住，已先派给个人助手',
        } satisfies ProgressPayload)
        log(`tihu commander fallback task=${task.taskId} session=${task.sessionIds[task.sessionIds.length - 1] ?? '-'}`)
        return
      }
    } catch (failure) {
      log(`tihu commander fallback dispatch threw: ${(failure as Error)?.message ?? String(failure)}`)
    }
    // 终态：排队卡撤掉，屏上明确说没派出去（绝不静默停住）。
    const task = tasks.get(pendingTaskId)
    if (task !== undefined && task.state !== 'archived') {
      tasks.drop(pendingTaskId)
      refreshBoards()
    }
    broadcastBoardSnapshot()
    releasePendingCommanderTask(pendingTaskId)
    showInputError(device, error, '指挥台没接住，个人助手也没派出去，请重说')
  }

  /**
   * 慢路径：交给指挥会话判项目。2026-11-10 起**纯文本**——指挥台只回一行 JSON，
   * lane 本地解析后派单（不要求指挥会话说挂任何工具）。
   *
   * 投递后不设超时（用户拍板「一直等到判出结果」）；但 turn/end 一到就必须有终态：
   * 解析不出来按 routeQuick/最佳卡兜底，绝不把排队卡停在「等指挥台判断」。
   */
  async function askCommander(device: TihuDevice, text: string): Promise<void> {
    device.unified = true
    stopCommanderWait()
    // 先上棋盘：排队卡在投递之前就存在（用户要求：立刻计入「●N 排队」）。
    const pending = createCommanderPendingTask(text)
    const key = dispatchKeyOf(text)
    try {
      const commander = await ensureCommanderSession()
      if (commander === undefined) {
        await fallbackCommanderDispatch(device, text, pending.taskId, new Error('会话新建失败：宿主 sessionController 不可用'), 'ensure')
        return
      }
      beginCommanderWait(device, text, pending.taskId)
      // 先登记再投递：assistant/message 可能抢在 prompt() 返回前到达。
      pushCommanderAsk({
        key,
        text,
        kind: 'project',
        taskId: pending.taskId,
        via: 'commander',
        askedAt: Date.now(),
      })
      // 最近的项目会话清单：让「append / append_to」有据可依（最多 8 行，不塞满提示词）。
      let hints: string[] = []
      try { hints = await commanderSessionHints() } catch { hints = [] }
      const sent = await promptSession(commander, [{ type: 'text', text }, { type: 'text', text: commanderReplyTail(hints) }])
      if (!sent.ok) {
        // 只有投递本身出错才兜底；投递成功就等，没有计时器。
        dropCommanderAsk(key)
        await fallbackCommanderDispatch(device, text, pending.taskId, sent.error, 'prompt')
      }
    } catch (error) {
      // 任何意外异常也要有终态（排队卡撤掉 + 错误屏），不能让设备静默停在等待。
      dropCommanderAsk(key)
      await fallbackCommanderDispatch(device, text, pending.taskId, error, 'exception')
    }
  }

  /** 撤一条任务：还没起跑就直接撤；起跑过的要先「停止」再撤（危险动作要确认）。 */
  async function cancelTask(device: TihuDevice, taskId: string): Promise<boolean> {
    const task = tasks.get(taskId)
    if (task === undefined) {
      device.send('event.progress', { stage: '撤单', text: '没有这条任务' } satisfies ProgressPayload)
      return false
    }
    if (task.source === 'pc') {
      // 电脑端任务是只读镜像：撤掉＝不再上屏，**不碰电脑端会话**（不停、不删、不 prompt）。
      const removed = tasks.archive(task.taskId)
      if (removed !== undefined) appendTaskJournal(removed)
      dismissExternalTask(task)
      device.focusedTask = undefined
      sendFrame(device, noticeFrame({ stage: '撤单', title: `已撤掉：${task.title}`, lines: ['电脑端会话照常，只是不再上屏'], tone: 'idle' }))
      refreshBoards()
      log(`tihu cancel pc task=${task.taskId}`)
      return true
    }
    if (task.state === 'running' || task.state === 'awaiting') {
      device.send('event.progress', {
        stage: '撤单',
        text: `「${task.title}」已经开跑了：要撤得先在电脑端停掉它，停了再撤`,
      } satisfies ProgressPayload)
      sendFrame(device, noticeFrame({ stage: '撤单', title: '这条已经开跑了', lines: ['在电脑端停掉它，再撤'], tone: 'alert' }))
      return false
    }
    const journal = tasks.archive(task.taskId)
    if (journal !== undefined) appendTaskJournal(journal)
    device.focusedTask = undefined
    sendFrame(device, noticeFrame({ stage: '撤单', title: `已撤掉：${task.title}`, lines: ['还没开始跑，直接拿掉了'], tone: 'idle' }))
    sendTaskUpdate(device, task)
    refreshBoards()
    log(`tihu cancel task=${task.taskId}`)
    return true
  }

  /** 归档行落 journal（纯文本追加；会话与文件夹原样保留）。 */
  function appendTaskJournal(line: string): void {
    try {
      const home = ensureAssistantHome()
      const day = new Date().toISOString().slice(0, 10)
      const file = join(home.journal, `${day}.md`)
      const header = `## 任务归档\n`
      let prefix = ''
      try {
        const existing = readFileSync(file, 'utf8')
        if (!existing.includes('## 任务归档')) prefix = existing.endsWith('\n') ? `\n${header}` : `\n\n${header}`
      } catch {
        prefix = `# ${day}\n\n${header}`
      }
      appendFileSync(file, `${prefix}${line}\n`, 'utf8')
    } catch (error) {
      log(`tihu journal failed: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  /** 屏上口头命令（零模型）。 */
  async function runScreenCommand(device: TihuDevice, command: ScreenCommand): Promise<void> {
    if (command.kind === 'board') {
      // 口头命令/主页键明确回棋盘：回到第一张页（最该看的那些排在前面）。
      sendBoard(device, true)
      return
    }
    if (command.kind === 'open') {
      // 「开第 N 条」指的是屏上这一页的第 N 行（翻页之后所见即所开）。
      const rows = boardOf(tasks.list(), Date.now(), Math.max(0, device.boardPage ?? 0)).rows
      const target = command.index !== undefined ? rows[command.index - 1] : rows[0]
      if (target === undefined) {
        sendFrame(device, noticeFrame({ stage: '任务', title: '现在没有可看的任务', lines: ['说一句话就派单'], tone: 'idle' }))
        return
      }
      openTask(device, target.taskId)
      return
    }
    if (command.kind === 'stop') {
      try { device.cancelRound?.() } catch { /* 忽略 */ }
      device.send('event.progress', { stage: '停止', text: '已停止朗读' } satisfies ProgressPayload)
      return
    }
    if (command.kind === 'cancel') {
      const target = device.focusedTask ?? tasks.list().filter((task) => task.state === 'queued' || task.state === 'running').sort((a, b) => b.updatedAt - a.updatedAt)[0]?.taskId
      if (target === undefined) {
        sendFrame(device, noticeFrame({ stage: '撤单', title: '现在没有可撤的任务', lines: [], tone: 'idle' }))
        return
      }
      await cancelTask(device, target)
      return
    }
    if (command.kind === 'confirm') {
      // 设备屏不承载授权：这类话只在电脑端处理（不弹、不念、不执行）。
      device.send('event.progress', { stage: '授权', text: '需要在电脑端确认，设备屏不处理授权' } satisfies ProgressPayload)
      return
    }
    if (command.kind === 'pick') {
      if (device.pendingClarify !== undefined) {
        await resolveClarify(device, command.index === 1 ? 'new' : 'same')
        return
      }
      if (device.pendingPick !== undefined) {
        const pick = device.pendingPick
        device.pendingPick = undefined
        const card = pick.candidates[command.index - 1]
        if (card !== undefined) {
          await dispatchWithContinuity(device, pick.text, card, { via: 'pick' }, { allowCommander: true })
          return
        }
      }
      const rows = boardOf(tasks.list(), Date.now()).rows
      const target = rows[command.index - 1]
      if (target !== undefined) openTask(device, target.taskId)
    }
  }

  /**
   * 一句设备输入（统一指挥模式）的完整分流。
   * 顺序：澄清待答 → 歧义待选 → 屏上命令 → 快路径规则（项目 + 本地会话衔接）→ 慢路径。
   */
  async function dispatchUtterance(device: TihuDevice, text: string): Promise<void> {
    // 唤醒词是设备噪声（「你好，鹈鹕，帮我查一下…」）：进门先剥掉一层，
    // 屏上命令、任务标题、派单文本都不再带「你好，鹈鹕」。
    const value = stripWakeWord(String(text ?? ''))
    if (value === '') return
    // 会话衔接澄清待答：「一/二」「新建/接着」立刻派；说了别的就先把原来那句按新建派出去。
    if (device.pendingClarify !== undefined) {
      const choice = clarifyChoiceOf(value)
      if (choice !== undefined) {
        await resolveClarify(device, choice)
        return
      }
      await resolveClarify(device, 'new')
    }
    const pick = device.pendingPick
    if (pick !== undefined) {
      const index = chineseIndex(value)
      if (index !== undefined && index <= pick.candidates.length) {
        device.pendingPick = undefined
        const card = pick.candidates[index - 1]
        await dispatchWithContinuity(device, pick.text, card, { via: 'pick' }, { allowCommander: true })
        return
      }
      if (/^(都不是|都不对|不对)/.test(value)) {
        device.pendingPick = undefined
        await dispatchWithContinuity(device, pick.text, ASSISTANT_CARD, { via: 'pick' }, { allowCommander: true })
        return
      }
      device.pendingPick = undefined
    }
    // 派单四出口之一：问答记忆，自己直接答，不落任务。
    if (MEMORY_QUESTION.test(value)) {
      await answerDirect(device, value)
      return
    }
    const command = parseScreenCommand(value)
    if (command !== undefined) {
      await runScreenCommand(device, command)
      return
    }
    const route = routeQuick({ text: value, cards: projectCards() ?? [], tasks: tasks.list() })
    if (route.kind === 'card') {
      await dispatchWithContinuity(device, value, route.card, { via: route.via ?? 'card' }, { allowCommander: true })
      return
    }
    if (route.kind === 'append') {
      await appendToTask(device, route.task, value)
      return
    }
    if (route.kind === 'daily') {
      await dispatchWithContinuity(device, value, ASSISTANT_CARD, { via: 'daily' }, { allowCommander: true })
      return
    }
    if (route.kind === 'ambiguous') {
      askWhich(device, route.candidates, value)
      return
    }
    await askCommander(device, value)
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
        pinned: device.onBoard === true,
        speaking: false,
        pending: [],
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
      const task = tasks.ofSession(sessionId)
      if (task === undefined) return `「${titleForSession(sessionId)}」不在棋盘上：统一指挥只有任务详情，没有单独的会话屏`
      openTask(device, task.taskId)
      return `已打开任务 ${task.taskId}「${task.title}」的详情`
    },
    openBubble: async () => '旧的待读气泡已删除：任务完成直接进棋盘、结果进一句播报',
    progress: async (sessionId) => {
      const found = await findSession(sessionId)
      const title = found.row?.title !== undefined && found.row.title !== '' ? humanTitle(found.row.title) : titleForSession(sessionId)
      const state = progressStates.get(sessionId)
      return {
        sessionId,
        title,
        running: runningSessions.has(sessionId),
        speaking: false,
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
      return '已停止播报'
    },
    replay: async (deviceId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      // 新界面没有「回答屏」可重读：重读＝把最近一条完成任务的结果再念一遍。
      const latest = tasks.list()
        .filter((task) => task.state === 'done' || task.state === 'announced')
        .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))[0]
      if (latest === undefined) return '现在没有可重读的完成结果'
      void speakAnnouncement(device, doneAnnouncementOf(latest))
        .then((spokenMs) => { if (spokenMs >= 0) armAutoHome(device, spokenMs, latest.taskId) })
        .catch((error) => log(`tihu control replay failed: ${(error as Error)?.message ?? String(error)}`))
      return `正在重读：${latest.title}`
    },
    goHome: async (deviceId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      try { device.cancelRound?.() } catch { /* 忽略 */ }
      sendBoard(device)
      return '已回棋盘'
    },
    browse: async (deviceId, direction) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      // 棋盘翻页（每页 4 条）：指挥模型的「下一页」和屏上「下一页」按钮走同一条路。
      device.boardPage = Math.max(0, Math.trunc(device.boardPage ?? 0) + (direction === 'prev' ? -1 : 1))
      sendBoard(device)
      const page = Math.max(0, device.boardPage ?? 0)
      const board = boardOf(tasks.list(), Date.now(), page)
      const titles = board.rows.map((row, index) => `${index + 1}. ${row.title}（${row.capsule}）`).join('\n')
      return `棋盘第 ${board.page.index + 1}/${board.page.total} 页（共 ${board.total} 条）：\n${titles === '' ? '（这页没有任务）' : titles}`
    },
    openRecent: async (deviceId) => {
      const device = findControlDevice(deviceId)
      if (device === undefined) return `错误：鹈鹕设备 ${deviceId} 不在线（先用 list_devices 看在线设备）`
      // 「最近回答」行已删除：这里打开最近一条完成任务的详情。
      const latest = tasks.list()
        .filter((task) => task.state === 'done' || task.state === 'announced')
        .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))[0]
      if (latest === undefined) return '现在没有已完成的任务'
      openTask(device, latest.taskId)
      return `已打开最近完成的任务：${latest.title}`
    },
    dispatch: async (input) => {
      const text = String(input.text ?? '').trim()
      if (text === '') return '错误：dispatch 需要 text（用户原话，也就是「要做什么」）。'
      // 同一句话已经派过一次（含「等指挥台判断」的排队卡转正）：晚到的 dispatch 不能建第二条任务。
      if (fallbackDispatch !== undefined
        && fallbackDispatch.key === dispatchKeyOf(text)
        && Date.now() - fallbackDispatch.at < FALLBACK_DEDUPE_MS) {
        log(`tihu dispatch skipped duplicate text=${JSON.stringify(text)} task=${fallbackDispatch.taskId || '-'}`)
        return `这条刚刚已经派成任务 ${fallbackDispatch.taskId} 了，不用再派一次。`
      }
      let card: { id: string; name: string; folder?: string } | undefined
      const folderHint = String(input.folder ?? '').trim()
      if (folderHint !== '') {
        const known = (projectCards() ?? []).find((item) => String(item.folder ?? '').toLowerCase() === folderHint.toLowerCase())
        card = known ?? dispatchProjectCard(nameFromFolder(folderHint), folderHint) ?? undefined
      } else {
        card = resolveCardForDispatch(input.project, text)
      }
      if (card === undefined) card = ASSISTANT_CARD
      const device = [...devices].find((item) => item.unified)
      const key = dispatchKeyOf(text)
      // 灰区正在等指挥台这一句结论：它带 session = 接着那条，不带 = 明确新建。
      const grayResolution = grayFallback !== undefined && grayFallback.key === key
      const grayConfidence = grayResolution ? grayFallback?.confidence : undefined
      const sessionHint = String(input.session ?? '').trim()
      if (sessionHint !== '') {
        const candidates = await projectCuSessionsOf(card)
        const target = findContinuityTarget(candidates, sessionHint)
        if (target === undefined) {
          return `没找到要接着的会话「${sessionHint}」：它必须是该项目文件夹下的 Computer Use 会话（可以先用 list_sessions 看短号）。`
        }
        const task = await appendToSession(
          device,
          text,
          card,
          { sessionId: target.sessionId, ...(target.title === '' ? {} : { title: target.title }) },
          { via: 'commander', continuity: 'append', confidence: grayConfidence ?? 1, clarify: 'no' },
        )
        if (task === undefined) return '错误：那条会话没接住这条消息（宿主投递失败）。'
        return `已接着「${task.projectName}」原有会话派出：${task.title}（任务 ${task.taskId}）`
      }
      if (input.newSession === true || grayResolution) {
        const task = await dispatchToCard(device, text, card, input.title, {
          via: 'commander',
          continuity: 'new',
          ...(grayConfidence === undefined ? {} : { confidence: grayConfidence }),
          clarify: grayResolution ? 'yes' : 'no',
        })
        if (task === undefined) return '错误：这条任务没派出去（宿主不能新建会话，或任务会话没接住消息）。'
        return `已派给「${task.projectName}」：${task.title}（任务 ${task.taskId}，落在 ${task.folder ?? '默认目录'}）`
      }
      // 没点名接哪条：本地衔接先判；灰区只问用户一次（指挥台已经在这条链路上，不能再递归问它）。
      const outcome = await dispatchWithContinuity(device, text, card, { via: 'commander' }, { allowCommander: false })
      return outcome.message
    },
    listTasks: () => tasks.list()
      .filter((task) => task.state !== 'archived')
      .map((task) => ({ taskId: task.taskId, title: task.title, capsule: capsuleOf(task.state), sub: subLineOf(task) })),
    cancelTask: async (ref) => {
      const rows: ControlTaskRow[] = tasks.list()
        .filter((task) => task.state !== 'archived')
        .map((task) => ({ taskId: task.taskId, title: task.title, capsule: capsuleOf(task.state), sub: subLineOf(task) }))
      if (rows.length === 0) return '登记簿里现在没有任务，没有可撤的。'
      const outcome = matchTaskRows(rows, ref)
      if (outcome.kind === 'none') return `找不到任务「${ref ?? ''}」：用 list_tasks 看一下任务号。`
      if (outcome.kind === 'many') return `「${ref ?? ''}」匹配到 ${outcome.rows.length} 条任务，请用任务号再精确一些：\n${outcome.rows.map((row) => `${row.taskId}. ${row.title}（${row.capsule}）`).join('\n')}`
      const row = outcome.kind === 'one' ? outcome.row : outcome.rows[0]
      const task = tasks.get(row.taskId)
      if (task === undefined) return `找不到任务 ${row.taskId}。`
      const device = [...devices].find((item) => item.unified)
      if (device !== undefined) {
        const ok = await cancelTask(device, task.taskId)
        return ok ? `已撤掉任务 ${task.taskId}「${task.title}」` : `任务 ${task.taskId}「${task.title}」已经开跑了：先让任务停下再撤。`
      }
      const journal = tasks.archive(task.taskId)
      if (journal !== undefined) appendTaskJournal(journal)
      if (task.source === 'pc') dismissExternalTask(task)
      return `已撤掉任务 ${task.taskId}「${task.title}」`
    },
  }

  return {
    control,
    page: () => tihuPageHtml({ lanePath: TIHU_LANE_PATH, protocol: TIHU_PROTOCOL_VERSION }),
    handleUpgrade,
    dispose: () => {
      disposed = true
      stopCommanderWait()
      pendingCommanderTask.clear()
      commanderAsks.length = 0
      commanderTurnReplied.clear()
      clearGrayFallback()
      clearClarifyPrompt()
      fallbackDispatch = undefined
      if (childReconcileTimer !== undefined) clearInterval(childReconcileTimer)
      childReconcileTimer = undefined
      deferredReplies.clear()
      stopPcSync()
      if (detailTicker !== undefined) clearInterval(detailTicker)
      detailTicker = undefined
      if (announceTimer !== undefined) clearTimeout(announceTimer)
      announceTimer = undefined
      notifyBus.clear()
      for (const device of devices) {
        if (device.receiptTimer !== undefined) clearTimeout(device.receiptTimer)
        device.receiptTimer = undefined
        if (device.homeTimer !== undefined) clearTimeout(device.homeTimer)
        device.homeTimer = undefined
      }
      for (const [sessionId, timer] of thinkingTimers) {
        clearTimeout(timer)
        thinkingTimers.delete(sessionId)
      }
      liveThinking.clear()
      tts.dispose()
      for (const device of devices) {
        invalidateVoiceInput(device)
        if (device.voiceUi?.timer !== undefined) clearTimeout(device.voiceUi.timer)
        device.close()
      }
      devices.clear()
      for (const disposer of [disposePre, disposePost, disposeSession, disposeAssistantStream]) {
        try { if (typeof disposer === 'function') disposer() } catch { /* 忽略 */ }
      }
    },
    stats: () => ({ devices: devices.size, activeSessions: [...activeSessions.keys()], tasks: tasks.size() }),
  }
}

/* ---------- 小工具 ---------- */

function safeJson(buffer: Buffer): unknown {
  try { return JSON.parse(buffer.toString('utf8')) } catch { return { type: '<unparsable>' } }
}

/**
 * 收尾原因（`reason.kind`）：老事件里可能是字符串也可能是对象，两种都认。
 * completed / stop 算正常完成，其余（error/aborted/cancelled）算中断。
 */
function finishReasonOf(data: unknown): string {
  const record = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
  const reason = record.reason
  if (typeof reason === 'string') return reason
  const kind = (reason !== null && typeof reason === 'object' ? (reason as Record<string, unknown>).kind : undefined)
    ?? record.kind
  return typeof kind === 'string' ? kind : 'stop'
}

/**
 * 会话事件 → 最后一条**有文字**的助手回复（原文）。
 *
 * 为什么不能只看内存里的 `lastAssistant`：电脑端 CU 会话是**轮询镜像**，任务完成态可能
 * 完全由列表缓存推导出来；鹈鹕进程重启、或者任务在事件到达之后才建，内存 Map 里就没有
 * 这条回复了（2026-11-10 实机核对：p2/p3/p4 三条完成卡全空，只有进程内跑过的 p1 有）。
 * 这里直接折叠会话事件，live 会话与持久化日志共用同一形状。
 *
 * 只收 `assistant/message` 的 text 块：reasoning（思考）与 tool-call 都不算回复；最后一条
 * 只有工具调用时继续往前找，直到找到真正的文字。
 */
function lastAssistantTextOfEvents(events: unknown): string {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as any
    if (event?.type !== 'assistant/message') continue
    const blocks = Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
    const text = stripToolNoise(blocks
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => String(block?.text ?? ''))
      .join('\n')).trim()
    if (text !== '') return text
  }
  return ''
}

/** 回复正文的第一句（屏 6 标题与一句播报都用它；超长的收省略号）。 */
function firstSentenceOf(text: unknown): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  const first = clean.split(/[。！？!?\n]/).map((part) => part.trim()).filter(Boolean)[0] ?? clean
  const chars = [...first]
  return chars.length > 24 ? `${chars.slice(0, 23).join('')}…` : first
}

/** 工作区内的绝对路径；越界与否由 guard 的快照逻辑再判一次（这里只拼路径）。 */function joinSafe(workspace: string, target: string): string {
  return isAbsolute(target) ? target : join(workspace, target)
}

function existsSyncSafe(workspace: string, target: string): boolean {
  try { return existsSync(joinSafe(workspace, target)) } catch { return false }
}

/** 协议类型集合（测试与文档核对用）。 */
export const tihuProtocolSurface = { upstream: TIHU_UPSTREAM_TYPES, downstream: TIHU_DOWNSTREAM_TYPES, version: TIHU_PROTOCOL_VERSION, tihuDirOf }
