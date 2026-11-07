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
import { existsSync } from 'node:fs'
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
import { applySessionEvent, confirmationFrame, createProgressState, type TihuProgressState } from './progress.ts'
import { TihuTts, type TihuTtsPaths } from './tts.ts'
import { replyWindow, splitReplySentences, splitSpeechSegments, type ReplySentence, type SpeechSegment } from './reply.ts'
import { toSpeechText } from './speech-text.ts'
import { CONTENT_WIDTH_PX, SCREEN_SPEC, wrapTextPx } from './screen-spec.ts'
import type { TtsAudioPayload, VoiceCreatedPayload, VoiceListPayload } from './protocol.ts'

/** 页面与 WebSocket 的路径（代理侧按这两个前缀放行）。 */
export const TIHU_PAGE_PATH = '/tihu'
export const TIHU_LANE_PATH = '/tihu/lane'

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
  }
  const screenStates = new Map<string, ScreenScrollState>()
  /** 每会话的屏幕模式与回主页计时。 */
  const homeStates = new Map<string, { mode: 'home' | 'session'; page: number; done: boolean; timer?: ReturnType<typeof setTimeout> }>()
  /** 会话 id → 屏幕进度状态（步骤计数 / 用时 / 上一步结果）。 */
  const progressStates = new Map<string, TihuProgressState>()
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
  }  const confirmBroker: ConfirmBroker = createConfirmBroker({
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
        device.send('screen.frame', confirmationFrame(request.title, request.detail))
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
  function screen(sessionId: string, frame: Omit<ScreenFramePayload, 'bullets'> & { bullets?: string[] }): void {
    broadcast(sessionId, 'screen.frame', {
      stage: frame.stage,
      title: frame.title,
      bullets: frame.bullets ?? [],
      ...(frame.progress === undefined ? {} : { progress: frame.progress }),
      ...(frame.mode === undefined ? {} : { mode: frame.mode }),
      ...(frame.reply === undefined ? {} : { reply: frame.reply }),
      ...(frame.home === undefined ? {} : { home: frame.home }),
      tone: frame.tone ?? 'idle',
    } satisfies ScreenFramePayload)
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
    const found = await findSession(sessionId)
    if (found.status === 'missing') {
      device.sessionId = undefined
      device.send('session.invalid', {
        sessionId,
        reason: `会话 ${shortSessionId(sessionId)} 不存在（可能已归档或删除），请在下面的会话列表里重新选一个`,
        showPicker: true,
      } satisfies SessionInvalidPayload)
      device.send('event.alert', { level: 'warn', text: `会话 ${shortSessionId(sessionId)} 不存在：请从下面的会话列表里选一个` })
      device.send('screen.frame', {
        stage: '选择会话',
        title: '还没有选定会话',
        bullets: [`会话 ${shortSessionId(sessionId)} 不存在`, '点下面的会话列表选一个'],
        tone: 'alert',
      } satisfies ScreenFramePayload)
      log(`tihu bind rejected session=${sessionId} reason=missing`)
      return
    }
    device.sessionId = sessionId
    const row = found.row
    let title = row?.title ?? titleCache.get(sessionId)?.title ?? ''
    if (title === '' && found.status !== 'unknown') {
      // 标题要读会话日志：单独给 1.5 秒上限（URL 直接带会话时列表还没拉过）。
      const base: TihuSessionRow = { sessionId, title: '', preset: row?.preset ?? '', updatedAt: row?.updatedAt ?? 0, live: found.status === 'live' }
      const [titled] = await Promise.race([
        attachTitles([base]),
        new Promise<TihuSessionRow[]>((resolve) => { setTimeout(() => resolve([base]), 1500) }),
      ])
      title = titled?.title ?? ''
    }
    const preset = row?.preset ?? ''
    const computerUse = isComputerUsePreset(preset)
    const live = found.status === 'live' || row?.live === true
    device.send('session.bound', {
      sessionId,
      title,
      live,
      preset,
      computerUse,
      ...(options.auto === true ? { auto: true } : {}),
      ...(options.followed === true ? { followed: true } : {}),
    } satisfies SessionBoundPayload)
    if (computerUse) {
      device.send('screen.frame', {
        stage: options.followed === true ? '跟随' : '会话',
        title: options.followed === true
          ? (title !== '' ? `已自动跟随到：${title}` : '已自动跟随到新的 CU 会话')
          : (title !== '' ? `已绑定：${title}` : '已绑定会话'),
        bullets: [
          shortSessionId(sessionId),
          live ? '桌面正开着这个会话' : '还没在桌面打开（注入前先打开它）',
        ],
        tone: 'idle',
      } satisfies ScreenFramePayload)
    } else {
      // 要求 4：允许绑定（?session= 显式指定时不静默改写用户意图），但必须显著提示。
      device.send('event.alert', {
        level: 'error',
        text: `这条会话不是 Computer Use 模式（preset=${preset || '未知'}）：无法看屏/点按，请换一个 Computer Use 会话`,
      })
      device.send('screen.frame', {
        stage: '非 Computer Use',
        title: '这条不是 Computer Use 模式',
        bullets: ['无法看屏/点按', '请换一个 Computer Use 会话'],
        tone: 'alert',
      } satisfies ScreenFramePayload)
    }
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
        device.send('event.alert', { level: 'warn', text: '没有可自动绑定的 Computer Use 会话：先在桌面端新建一个 CU 会话' })
        device.send('screen.frame', {
          stage: '等待会话',
          title: '没有可自动绑定的 CU 会话',
          bullets: ['先在桌面端新建 Computer Use 会话', '再回来点「刷新会话列表」'],
          tone: 'alert',
        } satisfies ScreenFramePayload)
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
    let state = screenStates.get(sessionId)
    if (state === undefined || state.sentences !== sentences) {
      const lines: { text: string; sentenceIndex: number }[] = []
      for (const sentence of sentences) {
        for (const line of wrapTextPx(sentence.text, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)) {
          lines.push({ text: line, sentenceIndex: sentence.index })
        }
      }
      state = { lines, offset: state?.offset ?? 0, follow: state?.follow ?? true, sentences, currentIndex, charPos }
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
    }
  }

  function sendReply(sessionId: string, sentences: ReplySentence[], currentIndex: number, charPos: number, includeAll: boolean): void {
    screen(sessionId, replyScreen(sessionId, sentences, currentIndex, charPos, includeAll))
  }

  /** 主页屏：用会话快照按 cwd 分组兜底（控制室卡片本体在主客户端，host 拿不到）。 */
  async function sendHome(sessionId: string): Promise<void> {
    let rows: TihuSessionRow[] = []
    try { rows = (await collectSessionRows()).rows } catch { rows = [] }
    const groups = new Map<string, { name: string; rows: TihuSessionRow[] }>()
    for (const row of rows) {
      const cwd = row.cwd ?? ''
      const name = cwd === '' ? '其他' : (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd)
      const key = cwd === '' ? '__other__' : cwd
      if (!groups.has(key)) groups.set(key, { name, rows: [] })
      groups.get(key)!.rows.push(row)
    }
    const now = Date.now()
    const projects = [...groups.values()].map((group) => {
      const latest = group.rows.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const running = group.rows.some((row) => row.live && now - row.updatedAt < 5 * 60_000)
      const recent = latest !== undefined && now - latest.updatedAt < 24 * 3600_000
      const status: 'running' | 'idle' | 'done' = running ? 'running' : recent ? 'done' : 'idle'
      return {
        name: group.name,
        status,
        summary: latest === undefined ? '暂无会话' : (latest.title || shortSessionId(latest.sessionId)),
        updatedAt: latest?.updatedAt ?? 0,
      }
    }).sort((a, b) => {
      const rank = { running: 0, done: 1, idle: 2 } as Record<string, number>
      return rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt
    })
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
    }))
    screen(sessionId, {
      stage: '控制室',
      title: '',
      bullets: [],
      tone: 'ok',
      mode: 'home',
      home: { projects: pageProjects, page: { index: state.page, total: totalPages }, total: projects.length },
    })
  }

  function cancelHomeTimer(sessionId: string): void {
    const state = homeStates.get(sessionId)
    if (state?.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  function scheduleHome(sessionId: string): void {
    const state = homeStates.get(sessionId)
    if (state === undefined || !state.done) return
    cancelHomeTimer(sessionId)
    const delay = Number(process.env.TIHU_HOME_AFTER_MS ?? 10_000)
    state.timer = setTimeout(() => {
      const current = homeStates.get(sessionId)
      if (current === undefined || !current.done) return
      const scroll = screenStates.get(sessionId)
      if (scroll !== undefined && !scroll.follow) return   // 用户正在浏览历史，禁止切
      void sendHome(sessionId).catch((error) => log(`tihu home failed: ${(error as Error)?.message ?? String(error)}`))
    }, Number.isFinite(delay) ? delay : 10_000)
  }
  async function speakLocally(device: TihuDevice, sessionId: string, sentences: ReplySentence[], speechSegments: SpeechSegment[], includeAll: boolean): Promise<void> {
    if (speechSegments.length === 0) return
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
    try {
      for (let index = 0; index < speechSegments.length; index += 1) {
        const segment = speechSegments[index]
        const scrollState = screenStates.get(sessionId)
        if (scrollState !== undefined && scrollState.follow) {
          const lineIndex = scrollState.lines.findIndex((line) => line.sentenceIndex === segment.sentenceIndex)
          if (lineIndex >= 0) {
            const maxOffset = Math.max(0, scrollState.lines.length - SCREEN_SPEC.replyVisibleLines)
            scrollState.offset = Math.max(0, Math.min(lineIndex - 2, maxOffset))
          }
        }
        sendReply(sessionId, sentences, segment.sentenceIndex, segment.start, includeAll)
        await tts.synthesize(segment.text, {
          voice,
          sessionId,
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
              index: segment.index,
              text: segment.text,
              charStart: segment.start,
              charEnd: segment.end,
              ...(chunk.final ? { final: true } : {}),
            } satisfies TtsAudioPayload)
          },
        })
        const engineNote = tts.takeEngineNote()
        if (engineNote.startsWith('在线兜底')) {
          device.send('event.progress', { stage: 'tts', text: engineNote } satisfies ProgressPayload)
        }
      }
      // 念完停在最后一屏（最后一帧）。
      const last = sentences[sentences.length - 1]
      sendReply(sessionId, sentences, sentences.length - 1, last.end, includeAll)
      setTimeout(() => scheduleHome(sessionId), 50)
    } catch (error) {
      const message = (error as Error)?.message ?? String(error)
      log(`tihu tts failed session=${sessionId} voice=${voice}: ${message}`)
      device.send('event.alert', { level: 'error', text: `本次无语音：在线兜底不可用且本地引擎未就绪（原因：${message}）` })
      setTimeout(() => scheduleHome(sessionId), 50)
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
    try {
      const sessionId = tihuTurnOf(exec)
      if (sessionId === undefined) return await next()
      const tool = String(exec?.name ?? '')
      const workspace = workspaceFor(sessionId, exec?.agent)
      const args = argsOf(exec)
      const rawTarget = targetPathOf(args)
      const command = commandOf(args)
      const target = rawTarget !== undefined ? rawTarget : command
      const exists = rawTarget !== undefined ? existsSyncSafe(workspace, rawTarget) : undefined
      // 关键：shell 类按**命令本身**判只读，不再按工具名一刀切（P0 事故根因）。
      const action = classifyTool(tool, exists, command)

      // 不碰文件的只读工具（读、搜索、只读 shell…）不拦、不审计，避免把日志刷满。
      if (!action.touchesFiles && !action.dangerous) return await next()

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
      return await next()
    } catch (error) {
      // 闸自己出错时**不能**放行危险动作：记录后交给宿主默认策略（next）。
      log(`tihu pre-execute failed: ${(error as Error)?.stack ?? String(error)}`)
      return await next()
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
      if (![...devices].some((device) => device.sessionId === sessionId)) return
      const type = String(event?.type ?? '')
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
      }
      const update = applySessionEvent(state, event)
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
        const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b?.text ?? '')).join('\n').trim()
        if (text === '') return
        // 按句切分（同时带字符区间）：tts.text/tts.audio/reply 屏帧共用这套下标。
        const sentences = splitReplySentences(text)
        if (sentences.length === 0) return
        const speechSegments = splitSpeechSegments(text)
          .map((segment) => ({ ...segment, text: toSpeechText(segment.text) }))
          .filter((segment) => segment.text !== '')
        const includeAll = [...text].length <= 2000
        if (speechSegments.length === 0) {
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
        // 不在这里启动计时：要等朗读真正结束（speakLocally 完成/失败）再计时。
        return
      }
    } catch (error) {
      log(`tihu session event failed: ${(error as Error)?.stack ?? String(error)}`)
    }
  })

  /* ---------- WebSocket ---------- */

  function handleUpgrade(req: any, socket: any, head: Buffer): boolean {
    if (pathnameOf(req) !== TIHU_LANE_PATH) return false
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
      } else if (payload.auto === true) {
        // 默认路径：自动绑定「最近活跃的 Computer Use 会话」。
        device.autoFollow = true
        await autoBindActive(device, 'hello')
      } else {
        device.autoFollow = false
        device.sessionId = undefined
        device.send('screen.frame', {
          stage: '连接',
          title: payload.deviceName ?? '鹈鹕模拟设备',
          bullets: [
            `协议 v${TIHU_PROTOCOL_VERSION}`,
            '还没有选定 Computer Use 会话：在页面下面的列表里选一个',
            caps.microphone === false ? '无麦克风：用 WAV 文件驱动' : '麦克风可用',
          ],
          tone: 'idle',
        } satisfies ScreenFramePayload)
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
      device.send('screen.frame', {
        stage: '空闲', title: '已结束本次会话', bullets: ['闸门已关闭', '按住说话可再开始'], tone: 'idle',
      } satisfies ScreenFramePayload)
      return
    }

    if (type === 'screen.gesture') {
      const payload = message.payload as { action?: string; dy?: number; phase?: string; x?: number; y?: number }
      if (device.sessionId !== undefined) cancelHomeTimer(device.sessionId)
      if (payload.action === 'tap' && device.sessionId !== undefined && typeof payload.x === 'number' && typeof payload.y === 'number') {
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
        device.send('screen.frame', { stage: '聆听', title: '正在转写…', bullets: ['本机 speech 服务'], tone: 'busy' } satisfies ScreenFramePayload)
        try {
          text = await transcribe(String(message.payload.audioBase64 ?? ''))
        } catch (error) {
          device.send('event.alert', { level: 'error', text: `转写失败：${(error as Error)?.message ?? String(error)}` })
          device.send('screen.frame', { stage: '转写失败', title: '请用文字输入', bullets: [], tone: 'alert' } satisfies ScreenFramePayload)
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
        device.send('screen.frame', { stage: '思考', title: '模型处理中', bullets: [text.slice(0, 20)], tone: 'busy' } satisfies ScreenFramePayload)
      } catch (error) {
        device.send('event.alert', { level: 'error', text: `注入失败：${(error as Error)?.message ?? String(error)}` })
      }
    }
  }

  return {
    page: () => tihuPageHtml({ lanePath: TIHU_LANE_PATH, protocol: TIHU_PROTOCOL_VERSION }),
    handleUpgrade,
    dispose: () => {
      ;(confirmBroker as any).failAll?.('disposed')
      for (const [sessionId, state] of homeStates) {
        if (state.timer !== undefined) clearTimeout(state.timer)
        homeStates.delete(sessionId)
      }
      tts.dispose()
      for (const device of devices) device.close()
      devices.clear()
      for (const disposer of [disposePre, disposePost, disposeSession]) {
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
