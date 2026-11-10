/**
 * 鹈鹕设备控制工具（tihu）：一个全局原生工具，让用户在任意会话里
 * （尤其是鹈鹕语音指令）用自然语言控制鹈鹕（tihu）模拟设备。
 *
 * 分层：
 *   - 本文件只做**参数解析、会话定位、安全守卫、文案组织**；
 *   - 真正动设备/会话的操作全在 lane.ts 的 `control` 控制面里，
 *     那里只是**薄壳转调**既有的内部函数（bindSession / sendHome /
 *     browseReplyHistory / speakLocally / workspaceRegistry.archiveSession…），
 *     保证和手指点屏的效果逐字节一致；
 *   - 会话标题匹配等纯函数（matchSessionRows）从这里导出，脚本测试直接验。
 *
 * 可扩展性：新命令只需一行 `defineAction('名字', '描述', handler)`，
 * 工具 schema 与「未知 action」报错文案都从注册表自动生成，无需改别处。
 *
 * 参数固定只有四个（action/session/index/confirm），action 不用枚举类型：
 * execute 里查注册表，报错信息会列出全部合法 action。
 *
 * 安全红线：
 *   - archive 必须 confirm===true（模型须先让用户口头确认）；
 *   - 任何一台在线设备正在绑定的会话一律拒绝删除；
 *   - 找不到会话/设备一律给可操作的错误文案，不抛裸异常。
 *
 * 宿主依赖（defineTool）在 registerTihuControl 被调用时才经 cu-peer 从
 * 正在运行的 DSH 里加载——本文件的纯函数与单测不触碰宿主包。
 */
import { loadPeer } from '../cu-peer.mjs'
import { formatElapsed, formatTokens } from './progress.ts'
import type { ScreenFramePayload } from './protocol.ts'

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

/** deviceStatus 返回的「这台设备现在什么样」。 */
export interface DeviceStatusView {
  device: TihuControlDevice
  /** 屏帧键：绑定会话 id，未绑定为 '__unbound__'。 */
  display: string
  /** 最近一次下发/记录的屏帧（没有则缺省）。 */
  screen?: { stage: string; title: string; mode: string; bullets: string[] }
  speaking: boolean
  pinned: boolean
  /** 右侧待读气泡。 */
  pending: { sessionId: string; title: string; at: number }[]
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

/** 登记簿一行（tihu 工具 list_tasks 用；不带会话正文）。 */
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
 * lane 暴露的控制面。所有方法都是薄壳：内部转调 lane 既有函数，
 * 不重新实现任何设备/会话逻辑（保证与手指点屏效果一致）。
 */
export interface TihuControlSurface {
  /** 所有在线设备。 */
  listDevices(): TihuControlDevice[]
  /** 绑定到某会话的那台设备（没有返回 undefined）。 */
  deviceOfSession(sessionId: string): TihuControlDevice | undefined
  /** 一台设备的现状（不在线返回 undefined）。 */
  deviceStatus(deviceId: string): DeviceStatusView | undefined
  /** 列会话；fragment 为空返回最近 20 条。 */
  listSessions(fragment?: string): Promise<SessionRowsOutcome>
  /** 把设备绑定到会话（校验存在性；返回人话结果）。 */
  bind(deviceId: string, sessionId: string): Promise<string>
  /** 点开右侧气泡：按 1 起序号或标题关键词。 */
  openBubble(deviceId: string, pick: { index?: number; title?: string }): Promise<string>
  /** 一条会话的进度视图（lane 里没见过则只有 running/speaking/title）。 */
  progress(sessionId: string): Promise<SessionProgressView>
  /** 归档（删除）一条会话；失败返回人话错误串。 */
  archiveSession(sessionId: string): Promise<string>
  stopSpeaking(deviceId: string): Promise<string>
  replay(deviceId: string): Promise<string>
  goHome(deviceId: string): Promise<string>
  browse(deviceId: string, direction: 'prev' | 'next'): Promise<string>
  openRecent(deviceId: string): Promise<string>
  /** 派单：把一句话派到某个项目/文件夹的新会话里跑（登记簿记账，屏上出回执）。 */
  dispatch(input: ControlDispatchInput): Promise<string>
  /** 登记簿里还没归档的任务（棋盘数据源）。 */
  listTasks(): ControlTaskRow[]
  /** 撤一条还没起跑的任务（起跑过的要先停再撤）。 */
  cancelTask(ref?: string): Promise<string>
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

/* ---------- 动作注册表 ---------- */

/** 工具入参（action/session/index/confirm 固定四个，另加派单用的 text/target）。 */
export interface TihuControlArgs {
  action: string
  session?: string
  index?: number
  confirm?: boolean
  /** 派单：用户原话（dispatch 必填）。 */
  text?: string
  /** 派单：目标项目卡名或文件夹关键词（可选）。 */
  target?: string
  /** 派单：自定义标题（可选；不给就按原话规范化）。 */
  title?: string
  /** 派单：明确新建（灰区由指挥台判「不是接着之前那条」时用）。 */
  newSession?: boolean
}

/** handler 可用的上下文。 */
export interface TihuControlApi {
  surface: TihuControlSurface
  /** 调用方会话 id（设备缺省约定：取绑定到它的那台设备）。 */
  callerSessionId?: string
}

type ActionHandler = (args: TihuControlArgs, api: TihuControlApi) => Promise<string>

const actions = new Map<string, { description: string; handler: ActionHandler }>()

/** 注册一条命令：加新 action 只需这一行（可扩展性硬要求的入口）。 */
function defineAction(name: string, description: string, handler: ActionHandler): void {
  actions.set(name, { description, handler })
}

export function tihuActionNames(): string[] {
  return [...actions.keys()]
}

/** 归一化入参：坏的 index/confirm 直接丢给缺省逻辑，不炸。 */
export function normalizeControlArgs(raw: unknown): TihuControlArgs {
  const input = (raw ?? {}) as Record<string, unknown>
  const action = String(input.action ?? '').trim()
  const sessionRaw = input.session
  const session = typeof sessionRaw === 'string' && sessionRaw.trim() !== '' ? sessionRaw.trim() : undefined
  const indexRaw = input.index
  const index = typeof indexRaw === 'number' && Number.isFinite(indexRaw) ? Math.trunc(indexRaw) : undefined
  const confirm = input.confirm === true
  const textRaw = input.text
  const text = typeof textRaw === 'string' && textRaw.trim() !== '' ? textRaw.trim() : undefined
  const targetRaw = input.target
  const target = typeof targetRaw === 'string' && targetRaw.trim() !== '' ? targetRaw.trim() : undefined
  const titleRaw = input.title
  const title = typeof titleRaw === 'string' && titleRaw.trim() !== '' ? titleRaw.trim() : undefined
  const newSession = input.newSession === true
  return {
    action,
    ...(session === undefined ? {} : { session }),
    ...(index === undefined ? {} : { index }),
    confirm,
    ...(text === undefined ? {} : { text }),
    ...(target === undefined ? {} : { target }),
    ...(title === undefined ? {} : { title }),
    ...(newSession ? { newSession } : {}),
  }
}

/** 设备缺省约定：调用会话绑定的那台 → 只有一台在线就用那台 → 报错并给操作指引。 */
export function resolveControlDevice(api: TihuControlApi): TihuControlDevice {
  if (api.callerSessionId !== undefined && api.callerSessionId !== '') {
    const bound = api.surface.deviceOfSession(api.callerSessionId)
    if (bound !== undefined) return bound
  }
  const all = api.surface.listDevices()
  if (all.length === 1) return all[0]
  if (all.length === 0) {
    throw new Error('当前没有鹈鹕设备在线：请先在手机/浏览器打开鹈鹕模拟设备页（/tihu），再用本工具控制它。')
  }
  throw new Error(`有 ${all.length} 台鹈鹕设备在线，但没有一台绑定到当前会话，无法确定要操作哪台：请先在目标设备屏上绑定本会话；或只在会话详情里使用本工具。可用 list_devices 查看在线设备。`)
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
  throw new Error(`找不到会话「${ref}」：可以先用 list_sessions 加关键词列一下当前会话。`)
}

function requireDevice(api: TihuControlApi): TihuControlDevice {
  return resolveControlDevice(api)
}

/* ---------- action 全集（调研后确定，一个不能漏） ---------- */

defineAction('status', '读取当前设备屏幕：模式、标题、正文行、右侧气泡、是否在朗读、绑定会话、音色设置。', async (_args, api) => {
  const device = requireDevice(api)
  const view = api.surface.deviceStatus(device.id)
  if (view === undefined) throw new Error(`鹈鹕设备 ${device.id} 不在线（可能刚断开），可用 list_devices 重新确认。`)
  const lines: string[] = []
  const bound = view.device.sessionId
  lines.push(`设备：${view.device.id}${view.device.clientId !== undefined ? `（${view.device.clientId}）` : ''}`)
  lines.push(`绑定会话：${bound === undefined ? '未绑定' : `${view.device.sessionId}`}`)
  if (view.screen !== undefined) {
    lines.push(`屏幕：模式=${view.screen.mode} · 阶段=${view.screen.stage || '-'} · 标题=${view.screen.title || '-'}`)
    const body = view.screen.bullets.filter((line) => line.trim() !== '').slice(0, 4)
    if (body.length > 0) lines.push(`正文：${body.join(' / ')}`)
  } else {
    lines.push('屏幕：还没有下发过任何屏帧')
  }
  lines.push(view.pending.length > 0
    ? `气泡：${view.pending.map((item, index) => `${index + 1}. ${item.title}（${shortSessionId(item.sessionId)}）`).join('、')}`
    : '气泡：无')
  lines.push(`朗读中：${view.speaking ? '是' : '否'} · 主页钉住：${view.pinned ? '是' : '否'}`)
  lines.push(`音色：主=${view.device.voice || 'default'} · 兜底=${view.device.edgeVoice}${view.device.offlineOnly ? ' · 仅离线' : ''}`)
  return lines.join('\n')
})

defineAction('list_devices', '列出所有在线鹈鹕设备（id、绑定会话、音色）。', async (_args, api) => {
  const devices = api.surface.listDevices()
  if (devices.length === 0) return '当前没有鹈鹕设备在线。'
  return devices.map((device) => {
    const bound = device.sessionId
    return `· ${device.id}${device.clientId !== undefined ? `（${device.clientId}）` : ''} → ${bound === undefined ? '未绑定' : `绑定 ${bound}`} · 音色 ${device.voice || 'default'}/${device.edgeVoice}`
  }).join('\n')
})

defineAction('bind', '按标题关键词或代号把设备绑定切换到另一条会话（session 必填）。', async (args, api) => {
  const device = requireDevice(api)
  const row = await resolveControlSession(api, args.session, 'bind')
  return api.surface.bind(device.id, row.sessionId)
})

defineAction('open_bubble', '点开屏幕右侧的待读气泡：给 index（1 起序号）或 session 参数当标题关键词。', async (args, api) => {
  const device = requireDevice(api)
  if (args.index === undefined && args.session === undefined) {
    throw new Error('open_bubble 需要 index（气泡序号，从 1 开始）或 session（标题关键词）。')
  }
  return api.surface.openBubble(device.id, { ...(args.index === undefined ? {} : { index: args.index }), ...(args.session === undefined ? {} : { title: args.session }) })
})

defineAction('progress', '查任意会话的步骤、用时、速度、上下文占比、是否在跑（session 必填）。', async (args, api) => {
  const row = await resolveControlSession(api, args.session, 'progress')
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

defineAction('list_sessions', '按关键词列会话（标题模糊匹配：精确/前缀/包含；空关键词列最近 20 条）。', async (args, api) => {
  const outcome = await api.surface.listSessions(args.session)
  if (outcome.kind === 'none') {
    throw new Error(`找不到会话「${args.session ?? ''}」：换个关键词，或留空列最近 20 条。`)
  }
  const rows = outcome.kind === 'one' ? [outcome.row] : outcome.rows
  if (rows.length === 0) return '当前没有任何会话。'
  return `${outcome.kind === 'many' ? `「${args.session}」匹配到 ${rows.length} 条，请再精确一些：` : '会话列表：'}\n${formatSessionCandidates(rows)}`
})

defineAction('archive', '删除（归档）会话：必须先让用户口头确认，再以 confirm=true 调用（session 必填）。', async (args, api) => {
  if (args.confirm !== true) {
    throw new Error('删除会话是危险操作：必须先让用户口头确认，然后以 confirm=true 再调一次 tihu（action=archive）。未确认不会执行任何删除。')
  }
  const row = await resolveControlSession(api, args.session, 'archive')
  // 安全红线：任何一台在线设备正在绑定的会话一律拒绝删除。
  const boundDevices = api.surface.listDevices().filter((device) => device.sessionId === row.sessionId)
  if (boundDevices.length > 0) {
    throw new Error(`拒绝删除：会话「${row.title}」正绑定在鹈鹕设备 ${boundDevices.map((device) => device.id).join('、')} 上。请先在设备上换绑或断开，再删除。`)
  }
  return api.surface.archiveSession(row.sessionId)
})

defineAction('stop_speaking', '立即停止当前朗读。', async (_args, api) => {
  const device = requireDevice(api)
  return api.surface.stopSpeaking(device.id)
})

defineAction('replay', '重读当前正在看的回答（翻过历史就重读那一条）。', async (_args, api) => {
  const device = requireDevice(api)
  return api.surface.replay(device.id)
})

defineAction('go_home', '回控制室主页并钉住（钉住期间新状态帧不覆盖主页）。', async (_args, api) => {
  const device = requireDevice(api)
  return api.surface.goHome(device.id)
})

defineAction('browse', '翻回答历史：session 参数传 prev（上一条）或 next（下一条），缺省 next。', async (args, api) => {
  const device = requireDevice(api)
  const direction = args.session === 'prev' ? 'prev' : 'next'
  return api.surface.browse(device.id, direction)
})

defineAction('open_recent', '点首页「最近回答」行，打开最近有回复的那条会话的回答屏。', async (_args, api) => {
  const device = requireDevice(api)
  return api.surface.openRecent(device.id)
})

/**
 * 派单（第 13 个 action，2026-11-09 统一指挥会话）。
 *
 * 这是**指挥会话唯一的动手方式**：它自己不做正文，只把用户那句话派给某条任务会话，
 * 由登记簿记账、屏上出派单回执。`target` 只是「我建议落在哪个项目」，最终落点仍由
 * lane 的派单器按「卡片文件夹 → 模板最新步骤目录 → 绑定会话 cwd → 助手 home」定，
 * 模型指错也不会写错地方。
 */
defineAction('dispatch', '派单：把用户的一句话派给某个项目的 Computer Use 任务会话去执行（text 必填＝用户原话；target 可选＝项目卡名或文件夹关键词；session 可选＝接着那条已有 CU 会话的短号/标题；newSession=true 表示明确新建）。设备语音派单已改由指挥台一行 JSON 结论完成，指挥会话不需要调用本工具。', async (args, api) => {
  if (args.text === undefined) {
    throw new Error('dispatch 需要 text 参数（用户原话）。只传项目名不行：要派的是「做什么」。')
  }
  return api.surface.dispatch({
    text: args.text,
    ...(args.target === undefined ? {} : { project: args.target }),
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.session === undefined ? {} : { session: args.session }),
    ...(args.newSession === true ? { newSession: true } : {}),
  })
})

defineAction('list_tasks', '列出任务登记簿里还没归档的任务（任务号、标题、状态、项目·第几步）。', async (_args, api) => {
  const rows = api.surface.listTasks()
  if (rows.length === 0) return '登记簿里现在没有任务（棋盘是空的）。'
  return `任务（${rows.length} 条）：\n${formatTaskRows(rows)}`
})

defineAction('cancel', '撤掉一条还没起跑的任务（session 传任务号如 t3，或标题关键词；不传就撤最近一条排队中的）。', async (args, api) => {
  return api.surface.cancelTask(args.session)
})

/* ---------- 执行器（单测用假控制面直接驱动） ---------- */

/**
 * 造一个「参数 → 文案」执行器：registerTihuControl 的 execute 走这里，
 * 测试用假 TihuControlSurface 直接驱动全部 action。
 */
export function createTihuControlRunner(surface: TihuControlSurface) {
  return async function runTihuControl(rawArgs: unknown, caller?: { sessionId?: string }): Promise<string> {
    const args = normalizeControlArgs(rawArgs)
    const entry = actions.get(args.action)
    if (entry === undefined) throw new Error(unknownActionError(args.action, tihuActionNames()))
    return entry.handler(args, { surface, ...(caller?.sessionId === undefined || caller.sessionId === '' ? {} : { callerSessionId: caller.sessionId }) })
  }
}

/* ---------- 系统提示词段落（≤120 字） ---------- */

export const TIHU_CONTROL_SECTION_NAME = 'tihu:control'

export const TIHU_CONTROL_SECTION_TEXT = '鹈鹕设备上的任务由指挥台一行 JSON 决定落点，别自己动手做正文。删除会话前必须先让用户口头确认，再以 confirm=true 调用。'

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
 * 注册全局原生工具 tihu + 系统提示段落。
 *
 * @param ctx 插件 cordis 上下文（tools / systemPrompt 服务）
 * @param surface lane 暴露的 control 控制面
 * @param log 日志函数
 * @returns 注销函数（注销工具 + 提示段落）
 */
export async function registerTihuControl(ctx: any, surface: TihuControlSurface, log: (line: string) => void = () => {}): Promise<() => void> {
  const run = createTihuControlRunner(surface)
  // defineTool 必须与宿主共用同一份实例（registry 身份），从正在运行的 DSH 加载。
  const { defineTool } = await loadPeer('@deepseek-ai/dsh-tools')
  const tools = serviceOf(ctx, 'tools') ?? ctx?.tools
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    throw new Error('宿主没有 tools 服务：tihu 控制工具注册失败')
  }
  const names = tihuActionNames()
  const offTool = tools.register(defineTool({
    name: 'tihu',
    description: [
      '控制鹈鹕（tihu）设备：看设备屏（status）、列设备（list_devices）、**派单（dispatch）**、看任务（list_tasks）、撤单（cancel）、切换绑定（bind）、点右侧气泡（open_bubble）、查会话进度（progress）、列会话（list_sessions）、删除会话（archive，须 confirm=true 且先征得用户口头确认）、停止朗读（stop_speaking）、重读（replay）、回主页（go_home）、看最近完成的任务（open_recent）；棋盘固定最近 5 条，browse 已无翻页。',
      '铁律：设备上听到的每句话都是**任务**，不是让你自己动手的活——要把「做什么」用 dispatch 派到对应项目的任务会话里，由登记簿记账、屏上出派单回执。不要把任务正文留在指挥会话里做。',
      `合法 action：${names.join(' / ')}。`,
      '设备缺省取绑定到当前会话的那台；会话按标题关键词或代号模糊匹配（精确/前缀/包含），多个候选会返回清单让你追问。',
    ].join(''),
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: `要执行的操作。合法值：${names.join(' / ')}。`,
      },
      session: {
        type: 'string',
        required: false,
        description: '会话标题关键词或会话代号（bind / progress / list_sessions / archive 必填；browse 用 prev/next；open_bubble 可当标题关键词）。',
      },
      index: {
        type: 'number',
        required: false,
        description: '气泡序号，从 1 开始（open_bubble 用）。',
      },
      confirm: {
        type: 'boolean',
        required: false,
        description: 'archive 专用：必须 true（已让用户口头确认）才会删除。',
      },
      text: {
        type: 'string',
        required: false,
        description: 'dispatch 专用：用户原话（要做什么）。',
      },
      target: {
        type: 'string',
        required: false,
        description: 'dispatch 专用（可选）：项目卡名或文件夹关键词；不填就按规则自动判落点。',
      },
      title: {
        type: 'string',
        required: false,
        description: 'dispatch 专用（可选）：任务标题；不填就按原话规范化。',
      },
    },
    execute: async (args: unknown, exec: any) => run(args, { sessionId: callerSessionIdOf(exec) }),
  }))
  const offSection = registerControlSection(ctx, log)
  log(`[dsh-assistant] tihu 控制工具已注册（${names.length} 个 action）`)
  return () => {
    try { if (typeof offTool === 'function') offTool() } catch { /* 忽略 */ }
    try { offSection?.() } catch { /* 忽略 */ }
  }
}
