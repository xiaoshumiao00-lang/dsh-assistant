/**
 * 鹈鹕（tihu）端控制工具：全局原生工具，让用户在任意会话里（尤其是鹈鹕语音指令）
 * 用自然语言控制鹈鹕设备。
 *
 * 形态（2026-11-10 用户拍板，规格书 §5 / §9）：
 *   - **15 个具名设备工具** `tihu_*`（停/暂停/继续/重读/回主页/翻页/开卡/跟随/结束会话/
 *     唤醒/答决策/了结决策/状态/列设备/设置）——名字本身就是意图，模型不用先学 action 字符串；
 *   - **1 个 `tihu_admin`** 收 6 条非设备杂项（dispatch / list_tasks / cancel_task /
 *     task_progress / list_sessions / archive_session），`archive_session` 的
 *     `confirm=true` 红线原样保留；
 *   - 旧的「一个 tihu + 15 个 action」形态**已删除**，不并存。
 *
 * 分层：
 *   - 本文件只做**参数校验、设备定位、文案组织、回执格式化**；
 *   - 真正动设备/会话的操作全在 lane.ts 的 `control` 控制面里（薄壳转调既有内部函数），
 *     保证「手指点屏」和「嘴说一句」效果逐字节一致；
 *   - 会话/任务标题匹配等纯函数从这里导出，脚本测试直接验。
 *
 * 返回文案（规格书 §5 约定）：`<结果> · <设备号> · <设备回执>`，例如
 * `已停止朗读 · d-8f21 · 停在 完成 第 3/12 行`。没等到设备回执时把「设备未回执」写进
 * 第三段，**不允许静默成功**（规格书 §8.3）。
 *
 * 设备缺省约定见 {@link resolveControlDevice}（规格书 §8.2：最近活跃的那台）。
 *
 * 宿主依赖（defineTool）在 registerTihuControl 被调用时才经 cu-peer 从正在运行的 DSH
 * 里加载——本文件的纯函数与单测不触碰宿主包。
 */
import { loadPeer } from '../cu-peer.mjs'
import { formatElapsed, formatTokens } from './progress.ts'

/* ---------- 控制面契约（lane.ts 实现，这里消费） ---------- */

/** 一台在线设备的控制视图（lane 内部 TihuDevice 的可导出快照）。 */
export interface TihuControlDevice {
  id: string
  clientId?: string
  sessionId?: string
  autoFollow: boolean
  /** 主音色（default / 克隆音色名）。 */
  voice: string
  /** edge-tts 兜底音色。 */
  edgeVoice: string
  offlineOnly: boolean
  /** 最后一次收到实质上行的时刻（规格书 §8.2 第 3 级：最近活跃的那台）。 */
  lastSeenAt?: number
  /** 连上的时刻（没有 lastSeenAt 时的兜底比较值）。 */
  connectedAt?: number
  /** 这台设备现在停在哪一屏（宿主记账：棋盘 / 回执 / 进度 / 完成 / 待决策 / 追问）。 */
  screenStage?: string
  /** 免按住（唤醒词聆听）开着吗；没报过就是 undefined。 */
  handsfree?: boolean
  /** 已经离线（只在 listDevices(true) 的「最近 10 分钟见过」里出现，永不被选来执行动作）。 */
  offline?: boolean
}

/** 会话列表一行（宿主无关的瘦形状）。 */
export interface ControlSessionRow {
  sessionId: string
  title: string
  preset: string
  live: boolean
  updatedAt: number
}

/** 会话定位结果：精确 > 前缀 > 包含，单层多条即「多候选」。 */
export type SessionRowsOutcome =
  | { kind: 'all'; rows: ControlSessionRow[] }
  | { kind: 'none' }
  | { kind: 'one'; row: ControlSessionRow }
  | { kind: 'many'; rows: ControlSessionRow[] }

/** 页面自报的播放状态（`playback.state` 缓存；页面是唯一写者）。 */
export interface DevicePlaybackView {
  phase: 'idle' | 'playing' | 'paused' | 'listening'
  taskId?: string
  /** 第几段（1 起）。 */
  segment?: number
  /** 第几行（0 起）。 */
  line?: number
  total?: number
  charStart?: number
}

/** 棋盘四段计数（工具读「回主页之后屏上是什么」用的真相源之一）。 */
export interface DeviceBoardView {
  page: number
  total: number
  counts: { running: number; awaiting: number; queued: number; done: number }
  totalTasks: number
}

/** deviceStatus 返回的「这台设备现在什么样」。 */
export interface DeviceStatusView {
  device: TihuControlDevice
  /** 屏帧键：绑定会话 id，未绑定为 '__unbound__'。 */
  display: string
  /** 最近一次下发/记录的屏帧（没有则缺省）。 */
  screen?: { stage: string; title: string; mode: string; bullets: string[] }
  /** 宿主记账的「现在在哪一屏」。 */
  stage?: string
  /** 页面自报的播放状态（没报过 = undefined，绝不猜）。 */
  playback?: DevicePlaybackView
  /** 屏上这条任务（完成/进度/待决策屏）。 */
  taskId?: string
  taskTitle?: string
  /** 棋盘计数与页码（任何屏都有，回主页后用它证明「真的回到棋盘了」）。 */
  board?: DeviceBoardView
  /** 屏上这道待决策。 */
  decision?: { taskId: string; question: string; options: string[]; secondsLeft: number; defaultIndex?: number }
  /** 现在是否在朗读（== playback.phase === 'playing'，不再靠猜）。 */
  speaking: boolean
  /** 屏停在棋盘上。 */
  pinned: boolean
}

/** progress 返回的「这条会话跑到哪了」。 */
export interface SessionProgressView {
  sessionId: string
  title: string
  running: boolean
  speaking: boolean
  state?: {
    turn: number
    step: number
    stage: string
    stageWord: string
    title: string
    turnStartedAt: number
    activity: { label: string; detail: string }[]
    lastResult?: { ok: boolean; line: string }
    stats?: { tokPerSec: number; totalTokens: number; contextPercent: number }
  }
  stats?: { tokPerSec: number; totalTokens: number; contextPercent: number }
}

/** 登记簿一行（tihu_admin list_tasks 用；不带会话正文）。 */
export interface ControlTaskRow {
  taskId: string
  title: string
  /** 排队 / 执行中 / 待决策 / 完成。 */
  capsule: string
  /** 「项目 · 第 N 步」。 */
  sub: string
  /** 归档了没有（list_tasks 默认只列未归档）。 */
  archived?: boolean
}

/** 派单入参（指挥会话调用 dispatch 时给的东西）。 */
export interface ControlDispatchInput {
  /** 用户原话（派单器据此写标题、判文件夹）。 */
  text: string
  /** 指定项目：卡片名 / 文件夹关键词（不给就按规则自己判）。 */
  project?: string
  /** 指定文件夹（绝对路径；给了就优先）。 */
  folder?: string
  /** 指定标题（不给就用原话规范化）。 */
  title?: string
  /** 指定「接着这条 CU 会话」：会话短号或标题关键词（灰区由指挥台判出来的结论）。 */
  session?: string
  /** 明确新建一条独立会话（指挥台判「不是接着之前那条」时的结论）。 */
  newSession?: boolean
}

/**
 * 一次设备动作的结果（lane 组织文案，本文件统一拼成
 * `<结果> · <设备号> · <设备回执>`）。
 */
export interface DeviceActionOutcome {
  /** 这台设备上实际生效的那件事（人话，可直接朗读）。 */
  text: string
  /** 实际生效的设备 id。 */
  deviceId: string
  /** 设备自报的当前屏/段落（不填＝设备没回执）。 */
  echo?: string
  /** 收到 `device.ack` 了吗；false 会在返回里写「设备未回执」。 */
  acked?: boolean
  /** 幂等：这个动作本来就已经达成，没有真的重发。 */
  already?: boolean
  /** 附带要多说一句的东西（如「还有 1 条待决策在等你」）。 */
  note?: string
}

/** 设备动作类的可选参数（各工具按需取用）。 */
export interface TihuDeviceActionOptions {
  scope?: 'round' | 'all'
  reason?: string
  taskId?: string
  segment?: number
  line?: number
  force?: boolean
  all?: boolean
  stopSpeaking?: boolean
  page?: number
  direction?: 'prev' | 'next'
  index?: number
  title?: string
  recent?: boolean
  until?: 'done' | 'turn'
  autoHome?: boolean
  prompt?: string
  timeoutMs?: number
  text?: string
  by?: string
  mode?: 'default' | 'reject' | 'delegate'
  key?: 'voice' | 'handsfree'
  value?: string | boolean
}

/**
 * lane 暴露的控制面。所有方法都是薄壳：内部转调 lane 既有函数，
 * 不重新实现任何设备/会话逻辑（保证与手指点屏效果一致）。
 *
 * 错误一律 **throw**（规格书 §8.3）：不再返回 `错误：…` 字符串让模型当普通结果读。
 */
export interface TihuControlSurface {
  /** 所有在线设备（includeOffline=true 时附带最近 10 分钟见过的离线设备）。 */
  listDevices(includeOffline?: boolean): TihuControlDevice[]
  /** 绑定到某会话的那台设备（没有返回 undefined）。 */
  deviceOfSession(sessionId: string): TihuControlDevice | undefined
  /** 一台设备的现状（不在线返回 undefined）。 */
  deviceStatus(deviceId: string): DeviceStatusView | undefined
  /** 列会话；fragment 为空返回最近 20 条。 */
  listSessions(fragment?: string): Promise<SessionRowsOutcome>
  /** 一条会话的进度视图（lane 里没见过则只有 running/speaking/title）。 */
  progress(sessionId: string): Promise<SessionProgressView>
  /** 归档（删除）一条会话；失败抛错。 */
  archiveSession(sessionId: string): Promise<string>
  /** 派单：把一句话派到某个项目/文件夹的新会话里跑（登记簿记账，屏上出回执）。 */
  dispatch(input: ControlDispatchInput): Promise<string>
  /** 登记簿里还没归档的任务（棋盘数据源）。 */
  listTasks(): ControlTaskRow[]
  /** 撤一条还没起跑的任务（起跑过的要先停再撤）。 */
  cancelTask(ref?: string): Promise<string>

  /* ---- 设备动作（15 个具名工具的落地实现） ---- */
  /** 停朗读：真的让页面 `stopPcm`，连已排进 WebAudio 时间轴的块一起清。 */
  stopSpeaking(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 暂停：记住停在第几段（段级续播）。 */
  pauseSpeaking(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 继续：从暂停那一行开头重念（1–3 秒重复，绝不跳字）。 */
  resumeSpeaking(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 重读：重发完成帧 + 从第 N 段重念。 */
  replay(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 回主页（棋盘）。 */
  goHome(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 棋盘翻页（页码夹到真实范围）。 */
  boardPage(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 打开某张卡的详情。 */
  openTaskCard(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 跟随一条正在跑的任务。 */
  followTask(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 结束本次语音会话（关闸门 + 页面画空闲）。 */
  endVoiceSession(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 强制进入「在听」。 */
  wake(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 替用户在待决策里点一个选项（与手指点屏同一条路）。 */
  answerDecision(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 按默认项了结 / 拒绝 / 交回电脑端。 */
  dismissDecision(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
  /** 设备设置（音色 / 免按住）。 */
  deviceSettings(deviceId: string, options: TihuDeviceActionOptions): Promise<DeviceActionOutcome>
}

/* ---------- 纯函数（脚本测试直接验） ---------- */

/** `session-98bb83cb-…` → `98bb83cb`。 */
export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, 8) || sessionId.slice(0, 8)
}

/**
 * 按标题/代号定位会话：精确（完整 id / 短 id / 完整标题）> 前缀 > 包含。
 * 每层命中多条都返回 many（交给模型拿候选清单追问），一条没有返回 none。
 * ref 为空/undefined 返回 all（最近 20 条）。
 */
export function matchSessionRows(rows: readonly ControlSessionRow[], ref?: string): SessionRowsOutcome {
  const key = String(ref ?? '').trim()
  if (key === '') return { kind: 'all', rows: rows.slice(0, 20) }
  const lower = key.toLowerCase()
  const short = (id: string): string => id.replace(/^session-/, '').slice(0, 8).toLowerCase()
  const exact = rows.filter((row) => row.sessionId === key || short(row.sessionId) === lower || row.title === key)
  if (exact.length === 1) return { kind: 'one', row: exact[0] }
  if (exact.length > 1) return { kind: 'many', rows: exact.slice(0, 8) }
  const prefix = rows.filter((row) => row.title.toLowerCase().startsWith(lower))
  if (prefix.length === 1) return { kind: 'one', row: prefix[0] }
  if (prefix.length > 1) return { kind: 'many', rows: prefix.slice(0, 8) }
  const contains = rows.filter((row) => row.title.toLowerCase().includes(lower) || short(row.sessionId).includes(lower))
  if (contains.length === 1) return { kind: 'one', row: contains[0] }
  if (contains.length > 1) return { kind: 'many', rows: contains.slice(0, 8) }
  return { kind: 'none' }
}

/** 多候选/列表的统一排版（供模型追问消歧）。 */
export function formatSessionCandidates(rows: readonly ControlSessionRow[]): string {
  return rows.map((row, index) => {
    const live = row.live ? '在线' : '未打开'
    const at = row.updatedAt > 0 ? new Date(row.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '未知时间'
    return `${index + 1}. ${row.title || shortSessionId(row.sessionId)}（${shortSessionId(row.sessionId)} · ${row.preset || '未知模式'} · ${live} · ${at}）`
  }).join('\n')
}

/** 未知 action 的报错文案：自动列出全部合法 action（加新命令不用改这里）。 */
export function unknownActionError(action: string, names: readonly string[]): string {
  return `未知 action「${action}」。合法 action：${names.join(' / ')}。用法见工具描述。`
}

/** 未知工具名的报错文案（tihu_admin 之外没有这个工具名）。 */
export function unknownToolError(name: string): string {
  return `没有这个鹈鹕工具「${name}」。合法工具：${tihuToolNames().join(' / ')}。`
}

/** 任务定位结果：精确号 > 号前缀 > 标题包含；单层多条即「多候选」。 */
export type TaskRowsOutcome =
  | { kind: 'all'; rows: ControlTaskRow[] }
  | { kind: 'none' }
  | { kind: 'one'; row: ControlTaskRow }
  | { kind: 'many'; rows: ControlTaskRow[] }

/**
 * 按任务号/标题定位任务。任务号是登记簿发的短号（`t1`、`t7`），用户口头会说「第 7 条」，
 * 所以 `7`、`t7` 都要认；标题包含只在没有命中号时才用（避免「第 3 步」这类词误伤）。
 */
export function matchTaskRows(rows: readonly ControlTaskRow[], ref?: string): TaskRowsOutcome {
  const key = String(ref ?? '').trim()
  if (key === '') return { kind: 'all', rows: rows.slice(0, 12) }
  const lower = key.toLowerCase()
  const idKey = /^\d+$/.test(lower) ? `t${lower}` : lower
  const exact = rows.filter((row) => row.taskId.toLowerCase() === idKey)
  if (exact.length === 1) return { kind: 'one', row: exact[0] }
  const prefix = rows.filter((row) => row.taskId.toLowerCase().startsWith(idKey))
  if (prefix.length === 1) return { kind: 'one', row: prefix[0] }
  if (prefix.length > 1) return { kind: 'many', rows: prefix.slice(0, 8) }
  const contains = rows.filter((row) => row.title.toLowerCase().includes(lower))
  if (contains.length === 1) return { kind: 'one', row: contains[0] }
  if (contains.length > 1) return { kind: 'many', rows: contains.slice(0, 8) }
  return { kind: 'none' }
}

/** 任务清单排版（一条一行，带胶囊与副行）。 */
export function formatTaskRows(rows: readonly ControlTaskRow[]): string {
  return rows.map((row) => `${row.taskId}. ${row.title}（${row.capsule} · ${row.sub}）`).join('\n')
}

/**
 * 一次设备动作 → 给模型看的那一句：`<结果> · <设备号> · <设备回执>`。
 * 没回执时第三段写「设备未回执」，绝不给「看起来像成功」的静默结果。
 */
export function formatDeviceResult(outcome: DeviceActionOutcome): string {
  const parts = [outcome.text, outcome.deviceId]
  const echo = String(outcome.echo ?? '').trim()
  if (echo !== '') parts.push(echo)
  else if (outcome.acked !== true && outcome.already !== true) parts.push('设备未回执')
  const line = parts.join(' · ')
  const note = String(outcome.note ?? '').trim()
  return note === '' ? line : `${line}（${note}）`
}

/** 最近活跃排序用的时刻：lastSeenAt → connectedAt → 0。 */
export function activityAtOf(device: TihuControlDevice): number {
  const seen = Number(device.lastSeenAt)
  if (Number.isFinite(seen) && seen > 0) return seen
  const connected = Number(device.connectedAt)
  if (Number.isFinite(connected) && connected > 0) return connected
  return 0
}

/** 在线设备里「最近活跃的那台」（同刻取先到的，保证确定性；离线设备永不入选）。 */
export function mostActiveDevice(devices: readonly TihuControlDevice[]): TihuControlDevice | undefined {
  let best: TihuControlDevice | undefined
  let bestAt = -1
  for (const device of devices) {
    if (device.offline === true) continue
    const at = activityAtOf(device)
    if (at > bestAt) { best = device; bestAt = at }
  }
  return best
}

/* ---------- 设备 / 会话定位 ---------- */

/** 调用方上下文。 */
export interface TihuControlApi {
  surface: TihuControlSurface
  /** 调用方会话 id（设备缺省约定：先看绑定到它的那台）。 */
  callerSessionId?: string
}

/** 在线设备清单（报错时给可操作的下一步）。 */
function deviceListHint(devices: readonly TihuControlDevice[]): string {
  if (devices.length === 0) return '当前没有鹈鹕设备在线：先打开鹈鹕模拟设备页（/tihu）或用 tihu_status 看状态。'
  return `在线设备：${devices.map((device) => device.id).join('、')}`
}

/**
 * 设备解析（规格书 §8.2 五级）：
 *   1. 显式 deviceId（也接受页面 clientId）；
 *   2. 绑定到调用方会话的那台；
 *   3. 最近活跃的那台（lastSeenAt / connectedAt）；
 *   4. 唯一在线的那台（第 3 级自然覆盖）；
 *   5. 都没有 → 报错并给 tihu_status / 打开 /tihu 的指引。
 */
export function resolveControlDevice(api: TihuControlApi, deviceId?: string): TihuControlDevice {
  const all = api.surface.listDevices().filter((device) => device.offline !== true)
  const wanted = String(deviceId ?? '').trim()
  if (wanted !== '') {
    const hit = all.find((device) => device.id === wanted || device.clientId === wanted)
    if (hit !== undefined) return hit
    throw new Error(`鹈鹕设备 ${wanted} 不在线（可能刚断开或换了一块屏）。${deviceListHint(all)}`)
  }
  if (api.callerSessionId !== undefined && api.callerSessionId !== '') {
    const bound = api.surface.deviceOfSession(api.callerSessionId)
    if (bound !== undefined) return bound
  }
  const active = mostActiveDevice(all)
  if (active !== undefined) return active
  throw new Error('当前没有鹈鹕设备在线：先打开鹈鹕模拟设备页（/tihu），再用 tihu_status 确认。')
}

/** 会话定位：一个 → 返回；多个 → 候选清单让模型追问；没有 → 报错并建议 list_sessions。 */
export async function resolveControlSession(api: TihuControlApi, ref: string | undefined, actionName: string): Promise<ControlSessionRow> {
  if (ref === undefined) throw new Error(`${actionName} 需要 session 参数（会话标题关键词或会话代号，如 98bb83cb）。`)
  const outcome = await api.surface.listSessions(ref)
  if (outcome.kind === 'one') return outcome.row
  if (outcome.kind === 'many') {
    throw new Error(`「${ref}」匹配到 ${outcome.rows.length} 条会话，请用更精确的关键词或代号区分：\n${formatSessionCandidates(outcome.rows)}`)
  }
  if (outcome.kind === 'all') throw new Error(`${actionName} 需要 session 参数（会话标题关键词或会话代号）。`)
  throw new Error(`找不到会话「${ref}」：可以先用 tihu_admin(action=list_sessions) 加关键词列一下当前会话。`)
}

/* ---------- 参数校验（每个工具都走这一层，坏参数给可读报错） ---------- */

export interface TihuToolParameter {
  type: 'string' | 'number' | 'boolean'
  required: boolean
  description: string
  /** 字符串参数的合法值全集（违反时能列出全部可选值）。 */
  enum?: readonly string[]
}

/** 工具定义（注册表与单测共用一份，不在两处各写一遍 schema）。 */
export interface TihuToolSpec {
  name: string
  description: string
  parameters: Record<string, TihuToolParameter>
  run(args: Record<string, unknown>, api: TihuControlApi): Promise<string>
}

/**
 * 归一化 + 校验入参：
 *   - 必填缺失 / 类型不对 / 枚举越界 → throw（文案里带工具名、参数名、合法值）；
 *   - 空串当「没给」（模型经常传 `''`），不因此报错。
 */
export function normalizeToolArgs(spec: TihuToolSpec, raw: unknown): Record<string, unknown> {
  const input = (raw ?? {}) as Record<string, unknown>
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error(`${spec.name} 的参数必须是一个对象。`)
  const out: Record<string, unknown> = {}
  for (const [key, param] of Object.entries(spec.parameters)) {
    const value = input[key]
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      if (param.required) throw new Error(`${spec.name} 缺少必填参数 ${key}（${param.description}）。`)
      continue
    }
    if (param.type === 'number') {
      const num = typeof value === 'number' ? value : Number(String(value))
      if (!Number.isFinite(num)) throw new Error(`${spec.name} 的 ${key} 必须是数字（${param.description}），收到「${String(value)}」。`)
      out[key] = num
      continue
    }
    if (param.type === 'boolean') {
      out[key] = value === true || value === 'true' || value === 1
      continue
    }
    const text = String(value).trim()
    if (param.enum !== undefined && !param.enum.includes(text)) {
      throw new Error(`${spec.name} 的 ${key} 只能是 ${param.enum.join(' / ')}，收到「${text}」。`)
    }
    out[key] = text
  }
  return out
}

/* ---------- 参数小工具 ---------- */

function strOf(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numOf(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boolOf(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

/** 设备动作类的公共参数片段（每个设备工具都带 deviceId）。 */
const DEVICE_PARAM: TihuToolParameter = {
  type: 'string',
  required: false,
  description: '设备 id 或页面 clientId；不填＝最近活跃的那台（见 tihu_list_devices）',
}

/** 从入参取设备（显式 deviceId 优先，否则按五级解析）。 */
function deviceFor(args: Record<string, unknown>, api: TihuControlApi): TihuControlDevice {
  return resolveControlDevice(api, strOf(args, 'deviceId'))
}

/* ---------- 工具全集：15 个设备工具 ---------- */

/** 15 个设备工具的注册顺序（也是系统提示里的顺序）。 */
export const TIHU_DEVICE_TOOL_NAMES = [
  'tihu_stop_speaking',
  'tihu_pause_speaking',
  'tihu_resume_speaking',
  'tihu_replay',
  'tihu_go_home',
  'tihu_board_page',
  'tihu_open_task',
  'tihu_follow_task',
  'tihu_end_voice_session',
  'tihu_wake',
  'tihu_answer_decision',
  'tihu_dismiss_decision',
  'tihu_status',
  'tihu_list_devices',
  'tihu_device_settings',
] as const

const deviceTools: TihuToolSpec[] = [
  /* ---- A. 播放控制（4） ---- */
  {
    name: 'tihu_stop_speaking',
    description: '用户说「停止阅读 / 别念了 / 安静 / 闭嘴」→ 立刻让设备停声（连已排进播放队列的音频一起清），屏不动。',
    parameters: {
      deviceId: DEVICE_PARAM,
      scope: { type: 'string', required: false, description: 'round=只停本轮（默认）；all=连排队中的播报一起清', enum: ['round', 'all'] },
      reason: { type: 'string', required: false, description: '只进日志（如「用户说停止阅读」）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.stopSpeaking(device.id, {
        scope: (strOf(args, 'scope') as 'round' | 'all' | undefined) ?? 'round',
        ...(strOf(args, 'reason') === undefined ? {} : { reason: strOf(args, 'reason') }),
      }))
    },
  },
  {
    name: 'tihu_pause_speaking',
    description: '用户说「先别念了 / 暂停 / 等会儿再念」→ 暂停并记住停在第几段。注意：继续时从本行开头重念 1–3 秒（段级续播，不是采样级无缝）。',
    parameters: { deviceId: DEVICE_PARAM },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.pauseSpeaking(device.id, {}))
    },
  },
  {
    name: 'tihu_resume_speaking',
    description: '用户说「继续念 / 接着说 / 念完它」→ 从暂停那一行接着念。注意：继续会从本行开头重念 1–3 秒（段级续播，不是采样级无缝）。',
    parameters: { deviceId: DEVICE_PARAM },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.resumeSpeaking(device.id, {}))
    },
  },
  {
    name: 'tihu_replay',
    description: '用户说「重读 / 再念一遍 / 从头念」→ 把完成页正文从第 1 段（或指定段）重新念一遍，屏上高亮同时回到那一行。只能重读已完成的任务，正在跑的会被拒绝。',
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: 'string', required: false, description: '任务短号（t3 / 3）或标题关键词；不填＝当前屏上那条' },
      segment: { type: 'number', required: false, description: '从完成页第几段开始（1 起，默认 1）' },
      line: { type: 'number', required: false, description: '按完成页第几行定位段（与 segment 二选一）' },
      force: { type: 'boolean', required: false, description: '正文还在念历史时是否打断重试（默认 false）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.replay(device.id, {
        ...(strOf(args, 'taskId') === undefined ? {} : { taskId: strOf(args, 'taskId') }),
        ...(numOf(args, 'segment') === undefined ? {} : { segment: numOf(args, 'segment') }),
        ...(numOf(args, 'line') === undefined ? {} : { line: numOf(args, 'line') }),
        force: boolOf(args, 'force', false),
      }))
    },
  },

  /* ---- B. 屏幕导航（4） ---- */
  {
    name: 'tihu_go_home',
    description: '用户说「回主页 / 回棋盘 / 回列表 / 退出这页」→ 设备回任务棋盘，默认同时停朗读（用户要主页通常就是要安静）。',
    parameters: {
      deviceId: DEVICE_PARAM,
      all: { type: 'boolean', required: false, description: '所有在线设备一起回（默认 false＝只回当前这台）' },
      stopSpeaking: { type: 'boolean', required: false, description: '回主页是否同时停朗读（默认 true）' },
      page: { type: 'number', required: false, description: '回第几页（0 起，默认 0）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.goHome(device.id, {
        all: boolOf(args, 'all', false),
        stopSpeaking: boolOf(args, 'stopSpeaking', true),
        ...(numOf(args, 'page') === undefined ? {} : { page: numOf(args, 'page') }),
      }))
    },
  },
  {
    name: 'tihu_board_page',
    description: '用户说「下一页 / 上一页 / 翻到第 2 页」→ 棋盘翻页（每页 4 条，页码自动夹到真实范围，到底了就停在末页）。',
    parameters: {
      deviceId: DEVICE_PARAM,
      direction: { type: 'string', required: false, description: 'prev / next（默认 next）', enum: ['prev', 'next'] },
      page: { type: 'number', required: false, description: '直接指定页码（0 起；给了就忽略 direction）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.boardPage(device.id, {
        direction: (strOf(args, 'direction') as 'prev' | 'next' | undefined) ?? 'next',
        ...(numOf(args, 'page') === undefined ? {} : { page: numOf(args, 'page') }),
      }))
    },
  },
  {
    name: 'tihu_open_task',
    description: '用户说「打开第 3 条 / 看那个任务 / 看最近完成的」→ 打开某张卡的详情（按状态自动进完成页/待决策页/进度页）。',
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: 'string', required: false, description: '任务短号 t3 / 纯数字 3' },
      index: { type: 'number', required: false, description: '当前棋盘页第几行（1 起）' },
      title: { type: 'string', required: false, description: '标题关键词（精确 > 前缀 > 包含，命中多条会给候选清单）' },
      recent: { type: 'boolean', required: false, description: '打开最近一条已完成任务（替代旧的 open_recent）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.openTaskCard(device.id, {
        ...(strOf(args, 'taskId') === undefined ? {} : { taskId: strOf(args, 'taskId') }),
        ...(numOf(args, 'index') === undefined ? {} : { index: numOf(args, 'index') }),
        ...(strOf(args, 'title') === undefined ? {} : { title: strOf(args, 'title') }),
        recent: boolOf(args, 'recent', false),
      }))
    },
  },
  {
    name: 'tihu_follow_task',
    description: '用户说「盯着这条 / 一直看着它跑 / 跟住」→ 让设备跟住一条正在跑的任务，进度页每秒刷新；不在跑的任务会自动改成看它对应的屏。',
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: 'string', required: false, description: '任务短号；不填＝当前屏上那条' },
      until: { type: 'string', required: false, description: 'done=跟到任务完成（默认）；turn=本轮结束就回棋盘', enum: ['done', 'turn'] },
      autoHome: { type: 'boolean', required: false, description: '结束后是否自动回棋盘（默认 false）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.followTask(device.id, {
        ...(strOf(args, 'taskId') === undefined ? {} : { taskId: strOf(args, 'taskId') }),
        until: (strOf(args, 'until') as 'done' | 'turn' | undefined) ?? 'done',
        autoHome: boolOf(args, 'autoHome', false),
      }))
    },
  },

  /* ---- C. 会话 / 唤醒（2） ---- */
  {
    name: 'tihu_end_voice_session',
    description: '用户说「结束会话 / 结束这次 / 别听了 / 收工」→ 关掉这台设备的语音会话闸门（屏停在原地变「空闲」，不自动回棋盘），并同时停声。',
    parameters: {
      deviceId: DEVICE_PARAM,
      reason: { type: 'string', required: false, description: '结束原因（只进日志，默认「电脑端指令」）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.endVoiceSession(device.id, {
        ...(strOf(args, 'reason') === undefined ? {} : { reason: strOf(args, 'reason') }),
      }))
    },
  },
  {
    name: 'tihu_wake',
    description: '用户说「喂 / 我说话呢 / 醒醒 / 在听吗」→ 强制设备进入「在听」并开麦（真机需固件支持 voice.listen，模拟页立即生效）。',
    parameters: {
      deviceId: DEVICE_PARAM,
      prompt: { type: 'string', required: false, description: '屏上那行小字（如「我在，说吧」）；不填用默认' },
      timeoutMs: { type: 'number', required: false, description: '多久没人说话自动退出（毫秒，夹 3000–60000，默认 10000）' },
      stopSpeaking: { type: 'boolean', required: false, description: '播报中唤醒是否先停声（默认 true）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.wake(device.id, {
        ...(strOf(args, 'prompt') === undefined ? {} : { prompt: strOf(args, 'prompt') }),
        ...(numOf(args, 'timeoutMs') === undefined ? {} : { timeoutMs: numOf(args, 'timeoutMs') }),
        stopSpeaking: boolOf(args, 'stopSpeaking', true),
      }))
    },
  },

  /* ---- D. 待决策（2） ---- */
  {
    name: 'tihu_answer_decision',
    description: '用户说「选第一个 / 同意 / 拒绝 / 第二个」→ 替用户在设备屏上的待决策里点一个选项（与手指点屏同一条路，答案真的交回会话）。',
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: 'string', required: false, description: '任务短号；不填＝当前屏上那条' },
      index: { type: 'number', required: false, description: '第几项（1 起，与屏上按钮序号一致）' },
      text: { type: 'string', required: false, description: '选项文本（精确 > 包含）；与 index 二选一' },
      by: { type: 'string', required: false, description: '谁答的（写进登记簿 answeredBy，默认「电脑端指令」）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.answerDecision(device.id, {
        ...(strOf(args, 'taskId') === undefined ? {} : { taskId: strOf(args, 'taskId') }),
        ...(numOf(args, 'index') === undefined ? {} : { index: numOf(args, 'index') }),
        ...(strOf(args, 'text') === undefined ? {} : { text: strOf(args, 'text') }),
        ...(strOf(args, 'by') === undefined ? {} : { by: strOf(args, 'by') }),
      }))
    },
  },
  {
    name: 'tihu_dismiss_decision',
    description: '用户说「随便 / 按默认 / 你决定 / 交回电脑」→ 按默认项了结（等同 60 秒超时）、或拒绝、或把决策交回电脑端卡片。绝不猜选项。',
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: 'string', required: false, description: '任务短号；不填＝当前屏上那条' },
      mode: { type: 'string', required: false, description: 'default=按默认项了结；reject=选否定项；delegate=还回电脑端', enum: ['default', 'reject', 'delegate'] },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      return formatDeviceResult(await api.surface.dismissDecision(device.id, {
        ...(strOf(args, 'taskId') === undefined ? {} : { taskId: strOf(args, 'taskId') }),
        mode: (strOf(args, 'mode') as 'default' | 'reject' | 'delegate' | undefined) ?? 'default',
      }))
    },
  },

  /* ---- E. 状态查询（2） ---- */
  {
    name: 'tihu_status',
    description: '用户问「设备现在在干嘛 / 念到哪了 / 在听吗 / 有几个任务」→ 读设备现状（在线、绑定、当前屏、读到第几段、棋盘计数、待决策、音色）。不填 deviceId 就列全部。',
    parameters: {
      deviceId: { type: 'string', required: false, description: '设备 id 或 clientId；不填＝返回所有设备一行一条' },
    },
    run: async (args, api) => {
      const wanted = strOf(args, 'deviceId')
      if (wanted !== undefined) {
        const device = resolveControlDevice(api, wanted)
        const view = api.surface.deviceStatus(device.id)
        if (view === undefined) throw new Error(`鹈鹕设备 ${device.id} 不在线（可能刚断开）。${deviceListHint(api.surface.listDevices())}`)
        return formatDeviceStatus(view)
      }
      const devices = api.surface.listDevices()
      if (devices.length === 0) throw new Error('当前没有鹈鹕设备在线：先打开鹈鹕模拟设备页（/tihu）。')
      const active = mostActiveDevice(devices)
      return devices.map((device) => {
        const view = api.surface.deviceStatus(device.id)
        const mark = device.id === active?.id ? '（默认控制这台）' : ''
        return view === undefined ? `${device.id}${mark} · 刚断开` : `${formatDeviceStatus(view)}${mark}`
      }).join('\n\n')
    },
  },
  {
    name: 'tihu_list_devices',
    description: '用户问「有几个设备 / 哪几块屏在线」→ 列在线鹈鹕设备（设备号、最近活跃、当前屏、是否在念）。默认只控最近活跃的那台，要指定就传 deviceId。',
    parameters: {
      includeOffline: { type: 'boolean', required: false, description: '连最近 10 分钟见过的离线设备也列出来（默认 false）' },
    },
    run: async (args, api) => {
      const includeOffline = boolOf(args, 'includeOffline', false)
      const devices = api.surface.listDevices(includeOffline)
      if (devices.length === 0) {
        throw new Error('当前没有鹈鹕设备在线：先打开鹈鹕模拟设备页（/tihu），连上后再问一次。')
      }
      const active = mostActiveDevice(devices)
      const lines = devices.map((device) => {
        const view = device.offline === true ? undefined : api.surface.deviceStatus(device.id)
        const parts = [device.id, `最近活跃 ${relativeTime(device.lastSeenAt)}`]
        if (device.offline === true) {
          parts.push('已离线')
          return `· ${parts.join(' · ')}`
        }
        if (view?.stage !== undefined && view.stage !== '') parts.push(view.stage)
        if (view?.board !== undefined) parts.push(`完成 ${view.board.counts.done}/${view.board.totalTasks}`)
        parts.push(view?.speaking === true ? '朗读中' : '没在念')
        if (device.id === active?.id) parts.push('默认控制')
        return `· ${parts.join(' · ')}`
      })
      const online = devices.filter((device) => device.offline !== true).length
      const hint = online > 1 ? '\n默认只控最近活跃的那台，要指定就传 deviceId。' : ''
      return `${online} 台鹈鹕设备在线：\n${lines.join('\n')}${hint}`
    },
  },

  /* ---- F. 设置（1） ---- */
  {
    name: 'tihu_device_settings',
    description: '用户说「换个声音 / 用晓晓念 / 开免按住 / 关免按住」→ 改设备音色或免按住。免按住只在模拟页/浏览器生效（真机是固件本地唤醒）。',
    parameters: {
      deviceId: DEVICE_PARAM,
      key: { type: 'string', required: true, description: 'voice=云音色；handsfree=免按住聆听', enum: ['voice', 'handsfree'] },
      value: { type: 'string', required: true, description: 'voice 填 zh-CN-*Neural 或音色名；handsfree 填 on/off（也认 true/false）' },
    },
    run: async (args, api) => {
      const device = deviceFor(args, api)
      const key = strOf(args, 'key') as 'voice' | 'handsfree'
      const raw = strOf(args, 'value') ?? ''
      if (key === 'voice') {
        if (!/^zh-CN-[A-Za-z]+Neural$/.test(raw)) {
          throw new Error(`tihu_device_settings 的 value 只认云端音色：zh-CN-YunjianNeural（云健）/ zh-CN-YunxiNeural（云希）/ zh-CN-XiaoxiaoNeural（晓晓）/ zh-CN-YunyangNeural（云扬）。收到「${raw}」。`)
        }
        return formatDeviceResult(await api.surface.deviceSettings(device.id, { key: 'voice', value: raw }))
      }
      const on = raw === 'on' || raw === 'true' || raw === '1' || raw === '开'
      if (raw !== 'on' && raw !== 'off' && raw !== 'true' && raw !== 'false' && raw !== '1' && raw !== '0' && raw !== '开' && raw !== '关') {
        throw new Error(`tihu_device_settings 的 value 只认 on / off（免按住开关），收到「${raw}」。`)
      }
      return formatDeviceResult(await api.surface.deviceSettings(device.id, { key: 'handsfree', value: on }))
    },
  },
]

/** 设备现状 → 多行文本（tihu_status 用；短、可读、只讲事实）。 */
export function formatDeviceStatus(view: DeviceStatusView): string {
  const device = view.device
  const lines: string[] = []
  const head = [`设备 ${device.id}`, `最近活跃 ${relativeTime(device.lastSeenAt)}`]
  lines.push(head.join(' · '))
  lines.push(`绑定：${device.sessionId === undefined || device.sessionId === '' ? '未绑定' : device.sessionId}`)
  const stage = view.stage !== undefined && view.stage !== '' ? view.stage : ''
  const screenTitle = view.screen?.title !== undefined && view.screen.title !== '' ? view.screen.title : ''
  const lineInfo = view.playback?.line !== undefined && view.playback.total !== undefined && view.playback.total > 0
    ? ` · 第 ${view.playback.line + 1}/${view.playback.total} 行`
    : ''
  const taskInfo = view.taskId === undefined ? '' : ` · ${view.taskId}${view.taskTitle === undefined || view.taskTitle === '' ? '' : `「${view.taskTitle}」`}`
  lines.push(`屏：${stage === '' ? '（还没下发过屏帧）' : stage}${lineInfo}${taskInfo}${stage === '' && screenTitle !== '' ? ` · ${screenTitle}` : ''}`)
  const playback = view.playback
  if (playback === undefined) lines.push('播放：页面还没上报（老固件）')
  else if (playback.phase === 'playing') {
    lines.push(`播放：朗读中${playback.segment === undefined ? '' : ` · 第 ${playback.segment} 段`}${playback.total === undefined ? '' : ` / 共 ${playback.total} 段`}`)
  } else if (playback.phase === 'paused') {
    lines.push(`播放：已暂停${playback.segment === undefined ? '' : ` · 停在第 ${playback.segment} 段`}（继续时从本行开头念）`)
  } else if (playback.phase === 'listening') {
    lines.push('播放：在听')
  } else {
    lines.push('播放：空闲')
  }
  if (view.board !== undefined) {
    const c = view.board.counts
    lines.push(`棋盘：等你 ${c.awaiting} · 在跑 ${c.running} · 排队 ${c.queued} · 完成 ${c.done}（第 ${view.board.page + 1}/${view.board.total} 页，共 ${view.board.totalTasks} 条）`)
  }
  if (view.decision !== undefined) {
    lines.push(`待决策：${view.decision.taskId}「${view.decision.question}」（还有 ${view.decision.secondsLeft} 秒，不选按默认项）`)
  }
  lines.push(`音色：${device.voice || 'default'} · 兜底 ${device.edgeVoice}${device.offlineOnly ? ' · 仅离线' : ''}`)
  return lines.join('\n')
}

/** 最近活跃的人话（3 秒前 / 42 分钟前 / 未知）。 */
export function relativeTime(at: number | undefined, now = Date.now()): string {
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return '未知'
  const diff = Math.max(0, now - value)
  if (diff < 1500) return '刚刚'
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  return `${Math.round(diff / 3_600_000)} 小时前`
}

/* ---------- tihu_admin：6 条非设备杂项 ---------- */

/** tihu_admin 的 action 全集（顺序即报错文案里的顺序）。 */
const adminActions = new Map<string, (args: Record<string, unknown>, api: TihuControlApi) => Promise<string>>()

function defineAdmin(name: string, handler: (args: Record<string, unknown>, api: TihuControlApi) => Promise<string>): void {
  adminActions.set(name, handler)
}

/** 非设备杂项的 action 名（报错文案与单测用）。 */
export function tihuActionNames(): string[] {
  return [...adminActions.keys()]
}

defineAdmin('dispatch', async (args, api) => {
  const text = strOf(args, 'text')
  if (text === undefined) throw new Error('dispatch 需要 text 参数（用户原话）。只传项目名不行：要派的是「做什么」。')
  return api.surface.dispatch({
    text,
    ...(strOf(args, 'target') === undefined ? {} : { project: strOf(args, 'target') }),
    ...(strOf(args, 'title') === undefined ? {} : { title: strOf(args, 'title') }),
    ...(strOf(args, 'session') === undefined ? {} : { session: strOf(args, 'session') }),
    ...(boolOf(args, 'newSession', false) ? { newSession: true } : {}),
  })
})

defineAdmin('list_tasks', async (_args, api) => {
  const rows = api.surface.listTasks()
  if (rows.length === 0) return '登记簿里现在没有任务（棋盘是空的）。'
  return `任务（${rows.length} 条）：\n${formatTaskRows(rows)}`
})

defineAdmin('cancel_task', async (args, api) => {
  return api.surface.cancelTask(strOf(args, 'session'))
})

defineAdmin('task_progress', async (args, api) => {
  const row = await resolveControlSession(api, strOf(args, 'session'), 'task_progress')
  const view = await api.surface.progress(row.sessionId)
  const stats = view.state?.stats ?? view.stats
  const status = view.running ? '正在运行' : view.speaking ? '朗读中' : '空闲'
  const head = `「${view.title}」：${status}`
  if (view.state === undefined) {
    return `${head} · 这条会话在鹈鹕 lane 里还没有进度记录（至少跑过一轮 turn 才会记录步骤）。`
  }
  const elapsed = formatElapsed(Math.max(0, Date.now() - view.state.turnStartedAt))
  const speed = stats !== undefined && stats.tokPerSec > 0 ? ` · ${stats.tokPerSec.toFixed(1)} tok/s` : ''
  const contextPart = stats !== undefined && stats.contextPercent > 0 ? ` · 上下文 ${stats.contextPercent.toFixed(0)}%` : ''
  const total = stats !== undefined && stats.totalTokens > 0 ? ` · 累计 ${formatTokens(stats.totalTokens)}` : ''
  const activity = view.state.activity.slice(-4)
    .map((entry) => `${entry.label}${entry.detail !== '' ? ` · ${entry.detail}` : ''}`)
    .join('；')
  return [
    `${head} · 第 ${view.state.step} 步（第 ${view.state.turn} 轮）· 阶段「${view.state.stageWord}」· 已用时 ${elapsed}${speed}${contextPart}${total}`,
    ...(activity !== '' ? [`最近活动：${activity}`] : []),
    ...(view.state.lastResult !== undefined ? [`上一步结果：${view.state.lastResult.ok ? '✓' : '✗'} ${view.state.lastResult.line}`] : []),
  ].join('\n')
})

defineAdmin('list_sessions', async (args, api) => {
  const outcome = await api.surface.listSessions(strOf(args, 'session'))
  if (outcome.kind === 'none') {
    throw new Error(`找不到会话「${strOf(args, 'session') ?? ''}」：换个关键词，或留空列最近 20 条。`)
  }
  const rows = outcome.kind === 'one' ? [outcome.row] : outcome.rows
  if (rows.length === 0) return '当前没有任何会话。'
  const ref = strOf(args, 'session')
  return `${outcome.kind === 'many' ? `「${ref}」匹配到 ${rows.length} 条，请再精确一些：` : '会话列表：'}\n${formatSessionCandidates(rows)}`
})

defineAdmin('archive_session', async (args, api) => {
  if (args.confirm !== true) {
    throw new Error('删除会话是危险操作：必须先让用户口头确认，然后以 confirm=true 再调一次 tihu_admin（action=archive_session）。未确认不会执行任何删除。')
  }
  const row = await resolveControlSession(api, strOf(args, 'session'), 'archive_session')
  // 安全红线：任何一台在线设备正在绑定的会话一律拒绝删除。
  const boundDevices = api.surface.listDevices().filter((device) => device.sessionId === row.sessionId)
  if (boundDevices.length > 0) {
    throw new Error(`拒绝删除：会话「${row.title}」正绑定在鹈鹕设备 ${boundDevices.map((device) => device.id).join('、')} 上。请先在设备上换绑或断开，再删除。`)
  }
  return api.surface.archiveSession(row.sessionId)
})

/** tihu_admin 的参数表（一条工具、一个 action 字段分发）。 */
const ADMIN_SPEC: TihuToolSpec = {
  name: 'tihu_admin',
  description: '非设备杂项（设备控制请用 tihu_* 具名工具）：dispatch=派单（text 必填，把用户原话派给某个项目的任务会话）；list_tasks=看登记簿；cancel_task=撤还没起跑的任务；task_progress=查会话跑到第几步；list_sessions=按关键词列会话；archive_session=删会话（须 confirm=true 且先征得用户口头确认）。',
  parameters: {
    action: { type: 'string', required: true, description: '要执行的操作', enum: [...adminActions.keys()] },
    session: { type: 'string', required: false, description: '会话标题关键词/代号（task_progress / list_sessions / archive_session 用；cancel_task 传任务号 t3）' },
    text: { type: 'string', required: false, description: 'dispatch 专用：用户原话（要做什么）' },
    target: { type: 'string', required: false, description: 'dispatch 可选：项目卡名或文件夹关键词' },
    title: { type: 'string', required: false, description: 'dispatch 可选：任务标题' },
    newSession: { type: 'boolean', required: false, description: 'dispatch 可选：明确新建一条独立会话' },
    confirm: { type: 'boolean', required: false, description: 'archive_session 专用：必须 true（已让用户口头确认）才会删除' },
  },
  run: async (args, api) => {
    const action = String(args.action)
    const handler = adminActions.get(action)
    if (handler === undefined) throw new Error(unknownActionError(action, tihuActionNames()))
    return handler(args, api)
  },
}

/** 16 个工具定义（15 设备 + 1 admin），注册与单测共用这一份。 */
export const TIHU_TOOLS: readonly TihuToolSpec[] = [...deviceTools, ADMIN_SPEC]

/** 所有工具名（15 设备 + tihu_admin）。 */
export function tihuToolNames(): string[] {
  return TIHU_TOOLS.map((tool) => tool.name)
}

/** 按名字取工具定义（单测与 registerTihuControl 共用）。 */
export function tihuToolSpec(name: string): TihuToolSpec | undefined {
  return TIHU_TOOLS.find((tool) => tool.name === name)
}

/* ---------- 执行器（单测用假控制面直接驱动） ---------- */

/**
 * 造一个「工具名 + 参数 → 文案」执行器：registerTihuControl 的 execute 走这里，
 * 测试用假 TihuControlSurface 直接驱动全部 16 个工具。
 *
 * 未知工具名 → 报错并列出全部合法工具名（模型不会因为拼错就静默失败）。
 */
export function createTihuToolRunner(surface: TihuControlSurface) {
  return async function runTihuTool(name: string, rawArgs?: unknown, caller?: { sessionId?: string }): Promise<string> {
    const spec = tihuToolSpec(name)
    if (spec === undefined) throw new Error(unknownToolError(name))
    const args = normalizeToolArgs(spec, rawArgs)
    return spec.run(args, {
      surface,
      ...(caller?.sessionId === undefined || caller.sessionId === '' ? {} : { callerSessionId: caller.sessionId }),
    })
  }
}

/**
 * 旧形态的兼容执行器（`{action: 'dispatch'}` 那一套）：只剩 `tihu_admin` 的 6 条。
 * 保留它是为了脚本测试与老调用方仍能按 action 驱动 admin 工具——**不是**第二套对外契约：
 * 注册给模型的只有 16 个具名工具。
 */
export function createTihuControlRunner(surface: TihuControlSurface) {
  const runTool = createTihuToolRunner(surface)
  return async function runTihuControl(rawArgs: unknown, caller?: { sessionId?: string }): Promise<string> {
    const input = (rawArgs ?? {}) as Record<string, unknown>
    const action = String(input.action ?? '').trim()
    if (!adminActions.has(action)) throw new Error(unknownActionError(action, tihuActionNames()))
    return runTool('tihu_admin', { ...input, action }, caller)
  }
}

/* ---------- 系统提示词段落（≤120 字） ---------- */

export const TIHU_CONTROL_SECTION_NAME = 'tihu:control'

export const TIHU_CONTROL_SECTION_TEXT = '鹈鹕设备控制走 tihu_* 具名工具：动作类一律单台下发、要等回执，不许静默成功。删除会话前必须先让用户口头确认，再以 confirm=true 调 tihu_admin。'

/** 挂系统提示段落（失败只记日志，绝不影响插件启动）。 */
function registerControlSection(ctx: any, log: (line: string) => void): (() => void) | undefined {
  let systemPrompt: any
  try {
    systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
  } catch {
    systemPrompt = ctx?.systemPrompt
  }
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== 'function') {
    log('[dsh-assistant] 没有 systemPrompt 服务：跳过 tihu 控制工具提示（不影响工具本身）')
    return undefined
  }
  try {
    const off = systemPrompt.section({
      name: TIHU_CONTROL_SECTION_NAME,
      // CU 策略段 1750、播报风格 1800：这里紧随其后。
      order: 1810,
      text: () => TIHU_CONTROL_SECTION_TEXT,
    })
    return typeof off === 'function' ? off : undefined
  } catch (error) {
    log(`[dsh-assistant] tihu 控制工具提示注册失败：${(error as Error)?.message ?? String(error)}`)
    return undefined
  }
}

/* ---------- 工具注册（插件 apply 处调用） ---------- */

/** 取宿主服务：cordis 对未 inject 的服务直读会 throw，一律 ctx.get + try。 */
function serviceOf(ctx: any, id: string): any {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(id)
  } catch { /* 服务不存在 */ }
  return undefined
}

/** exec.agent → 调用方会话 id（与 lane 的 sessionIdOfAgent 同口径，独立实现避免循环依赖）。 */
export function callerSessionIdOf(exec: any): string | undefined {
  const session = exec?.agent?.session
  const direct = session?.id
  if (typeof direct === 'string' && direct !== '') return direct
  const header = session?.header?.id
  if (typeof header === 'string' && header !== '') return header
  return typeof exec?.agent?.sessionId === 'string' && exec.agent.sessionId !== '' ? exec.agent.sessionId : undefined
}

/**
 * 注册 16 个全局原生工具（15 设备 + 1 admin）+ 系统提示段落。
 *
 * @param ctx 插件 cordis 上下文（tools / systemPrompt 服务）
 * @param surface lane 暴露的 control 控制面
 * @param log 日志函数
 * @returns 注销函数（注销全部工具 + 提示段落）
 */
export async function registerTihuControl(ctx: any, surface: TihuControlSurface, log: (line: string) => void = () => {}): Promise<() => void> {
  const run = createTihuToolRunner(surface)
  // defineTool 必须与宿主共用同一份实例（registry 身份），从正在运行的 DSH 加载。
  const { defineTool } = await loadPeer('@deepseek-ai/dsh-tools')
  const tools = serviceOf(ctx, 'tools') ?? ctx?.tools
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    throw new Error('宿主没有 tools 服务：tihu 控制工具注册失败')
  }
  const offs: Array<() => void> = []
  for (const spec of TIHU_TOOLS) {
    const parameters: Record<string, unknown> = {}
    for (const [key, param] of Object.entries(spec.parameters)) {
      parameters[key] = {
        type: param.type,
        required: param.required,
        description: param.description,
        ...(param.enum === undefined ? {} : { enum: [...param.enum] }),
      }
    }
    const off = tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters,
      execute: async (args: unknown, exec: any) => run(spec.name, args, { sessionId: callerSessionIdOf(exec) }),
    }))
    if (typeof off === 'function') offs.push(off)
  }
  const offSection = registerControlSection(ctx, log)
  log(`[dsh-assistant] 鹈鹕设备工具已注册（15 个设备工具 + tihu_admin）`)
  return () => {
    for (const off of offs) {
      try { off() } catch { /* 忽略 */ }
    }
    try { offSection?.() } catch { /* 忽略 */ }
  }
}
