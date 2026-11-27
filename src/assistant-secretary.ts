/**
 * 个人秘书固定会话的宿主侧锚点。
 *
 * 只做两件事：
 *   1. 把唯一的秘书 sessionId 持久化到 profile（浏览器 localStorage 会随缓存丢失，
 *      手机/电脑也不能共享，所以真值必须在宿主）；
 *   2. 给秘书会话装一道工具闸：只读权限仍然带着 shell / 写文件 / Computer Use /
 *      子代理这些工具，子代理还会继承父会话的只读档，所以秘书会话在工具入口
 *      deny 自己执行任务的能力；`secretary_dispatch` 必须显式放行，由它创建或续接
 *      独立的 Computer Use 会话。只读限制写文件/终端，绝不能把建会话与派活一起禁掉。
 *
 * 路由：
 *   GET    /api/assistant/secretary            → { ok, sessionId, updatedAt }
 *   GET    /api/assistant/secretary?verify=1   → 加 { exists }：这条固定会话还在不在宿主会话表
 *   GET    /api/assistant/secretary?verify=1&sessionId=<id>
 *                                            → 问**指定候选 id**（用于「新建出来的会话到底 retain 得住吗」，
 *                                              答 `<id>` 的真值，不用先把 state 写过去；回 `queried`）
 *   POST   /api/assistant/secretary  body { sessionId } → 覆盖；同一个 id 不再写盘（去抖，防多客户端互相覆盖）
 *   DELETE /api/assistant/secretary  → 清空（测试/重置用）
 *
 *   GET    /api/assistant/secretary/sessions?q=<关键词>&limit=<n>
 *                                            → 列「可绑定会话」（宿主持久化清单 + 活会话表合并去重，
 *                                              按 updatedAt 倒序、丢归档、标记当前绑定的那条）
 *   POST   /api/assistant/secretary/sessions  body { sessionId }
 *                                            → 控制室「更换会话」专用：先在宿主会话表里认这条 id
 *                                              （认不到直接 400，坏 id 绝不写进 state），
 *                                              写盘后必须回读校验；回读不成立就把之前那条恢复回去
 *
 *   控制室卡片的换绑定走上面那条严格路由；既有 POST /api/assistant/secretary 留给
 *   「固定 id 已失效 → 新建一条并把 state 指过去」的重建链路，两条各自独立。
 *
 * 已读卡集合（未读红点，2026-11-21 第三批需求）另落 dsh-assistant-secretary-read.json：
 *   GET    /api/assistant/secretary-read?sessionId=<id>            → { ok, sessionId, cards, count }
 *   POST   /api/assistant/secretary-read  { sessionId, cardKey, mark:'read' } → { ok, cardKey, read, count }
 *   DELETE /api/assistant/secretary-read?sessionId=<id>            → 清空该会话的已读集合
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { manageWebRoutes } from './web-routes'
import { appendOpenDiag } from './assistant-open-diag'

export const ASSISTANT_SECRETARY_ROUTE = '/api/assistant/secretary'
export const SECRETARY_DISPATCH_POLICY = 'default-computer-use-v2'
const STATE_FILENAME = 'dsh-assistant-secretary.json'
const MAX_BODY_BYTES = 4096
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/

/* ── 更换会话（2026-11-27 需求，控制室「个人秘书」卡片上的按钮）────────────────
 *  为什么列表要在宿主这一侧算：固定秘书 id 的硬约束是「必须指向宿主能读回来的会话」
 *  （判据在宿主的持久化清单 / 活会话表里，只有宿主知道某条会话是不是坏 id）。
 *  所以在宿主把坏 id 写进 state 之前先拿住它自己的会话清单——客户端那份 localStorage 缓存
 *  说了不算，客户端快照也不说了算。
 *  路由：
 *    GET /api/assistant/secretary/sessions?q=<关键词>&limit=<n>
 *      → { ok, sessionId(当前绑定), updatedAt, items[{sessionId,title,updatedAt,cwd}], total, returned, limit, source }
 *    POST /api/assistant/secretary { sessionId }（既有路由， tightened 语义）
 *      → 先在宿主会话表里认这条 id：明确认不到就 400 session-not-in-host-list，不写盘；
 *        写完之后必须回读文件校验（回读不成立就恢复成之前那条，绝不留坏 state）。 */
export const ASSISTANT_SECRETARY_SESSIONS_ROUTE = '/api/assistant/secretary/sessions'
/** 会话表两千多行（实测），一次别给手机发太多：默认 200 条，上限 600 条。 */
export const SECRETARY_SESSIONS_DEFAULT_LIMIT = 200
export const SECRETARY_SESSIONS_MAX_LIMIT = 600
/** 搜索关键词的上限：超过就只吃前 80 个字符（防把整段日志当关键词）。 */
const SECRETARY_SESSIONS_QUERY_MAX = 80
/** 列表行里标题/目录的截断长度（面板一行显示得下，也别把整条路径塞进 JSON）。 */
const TITLE_MAX_CHARS = 160
const CWD_MAX_CHARS = 300

/** `?verify=1`：客户端问「这条固定会话还在不在宿主的会话表里」；会话表两千多行，答案缓存 30s。 */
const EXISTENCE_TTL_MS = 30_000
let existenceCache: { id: string; value: boolean; at: number } | null = null

/**
 * 从请求 URL 里取「要问的那条 id」与「要不要 verify」。
 * 只认 `verify=1` 与 `sessionId=<session id>`；没有 sessionId 就问 state 里当前挂着的那条。
 */
export function parseSecretaryRequestQuery(rawUrl: string): { wantsVerify: boolean; requestedId: string } {
  const url = String(rawUrl ?? '')
  const queryIndex = url.indexOf('?')
  const query = queryIndex === -1 ? '' : url.slice(queryIndex + 1)
  const wantsVerify = /(?:^|&)verify=1(?:&|$)/.test(query)
  const match = query.match(/(?:^|&)session(?:Id)?=([^&]*)/)
  const raw = match === null ? '' : decodeURIComponent(match[1])
  const trimmed = raw.trim()
  return { wantsVerify, requestedId: SESSION_ID_RE.test(trimmed) ? trimmed : '' }
}

/**
 * 宿主权威版：这条 sessionId 还在不在宿主的会话表里。
 *   true  = 在（内存活会话或持久化清单里找到了）
 *   false = 不在（问到过结果，没有）
 *   null  = 问不出结果（宿主既没给 sessions.list 也没给 sessionQuery）——调用方必须按「不新建」处理
 */
async function secretarySessionExistsOnHost(ctx: any, sessionId: string): Promise<boolean | null> {
  const id = String(sessionId ?? '').trim()
  if (id === '') return false
  const now = Date.now()
  if (existenceCache && existenceCache.id === id && now - existenceCache.at < EXISTENCE_TTL_MS) return existenceCache.value
  let asked = false
  try {
    const live = Array.isArray(ctx?.sessions?.list?.()) ? ctx.sessions.list() : null
    if (live !== null) {
      asked = true
      if (live.some((session: any) => String(session?.header?.id ?? session?.id ?? '') === id)) {
        existenceCache = { id, value: true, at: Date.now() }
        return true
      }
    }
  } catch { /* 没有 sessions.list：只剩持久化清单那条 */ }
  try {
    const query = ctx?.get?.('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      const list = await query.listSessions(undefined)
      asked = true
      const found = Array.isArray(list)
        ? list.some((record: any) => String(record?.header?.id ?? record?.sessionId ?? '') === id)
        : false
      existenceCache = { id, value: found, at: Date.now() }
      return found
    }
  } catch { /* 问不出结果 */ }
  if (!asked) return null
  existenceCache = { id, value: false, at: Date.now() }
  return false
}

/**
 * 一条会话行（宿主会话表里的最小可辨形状）。
 * `live` = 来自活会话表（这条会话此刻就挂在宿主内存里）；
 * `archived` 只有宿主明确说了才算数（没说过就当没归档，别凭空猜）。
 */
export interface BindableSecretarySession {
  sessionId: string
  title: string
  updatedAt: number
  cwd: string
  live?: boolean
  archived?: boolean
  /** 这条就是当前秘书绑定的那条（面板要标记它、也不许再选它一次） */
  bound?: boolean
}

/** 归一一条会话行：id 形状不对就整条丢（宁可不列，也不列一条选不了的）。 */
export function normalizeBindableSessionRow(raw: unknown): BindableSecretarySession | null {
  const record = raw as Record<string, unknown> | null
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  const header = (typeof record.header === 'object' && record.header !== null) ? record.header as Record<string, unknown> : record
  const id = String(header?.id ?? record?.sessionId ?? '').trim()
  if (!SESSION_ID_RE.test(id)) return null
  const titleRaw = typeof header.title === 'string' ? header.title : ''
  const displayTitle = typeof header.displayTitle === 'string' ? header.displayTitle : ''
  const title = (displayTitle || titleRaw || id).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS)
  const cwdRaw = typeof header.cwd === 'string' ? header.cwd : ''
  const stamp = Number(header.updatedAt ?? header.createdAt ?? 0)
  const updatedAt = Number.isFinite(stamp) && stamp > 0 ? stamp : 0
  const row: BindableSecretarySession = { sessionId: id, title, updatedAt, cwd: cwdRaw.slice(0, CWD_MAX_CHARS) }
  if (header.archived === true) row.archived = true
  // 已经是归一过的行（两路会话表合并时又过了一遍）就把它带的标记带上，别在这一步丢掉
  if (header.live === true) row.live = true
  if (header.bound === true) row.bound = true
  return row
}

/** 读 `?q=` 与 `?limit=`：只认这两个参数；limit 越界钳到上限，非法就当默认。 */
export function parseSecretarySessionsQuery(rawUrl: string): { query: string; limit: number } {
  const url = String(rawUrl ?? '')
  const index = url.indexOf('?')
  const query = index === -1 ? '' : url.slice(index + 1)
  const qMatch = query.match(/(?:^|&)q=([^&]*)/)
  const lMatch = query.match(/(?:^|&)limit=(\d{1,4})/)
  const keyword = qMatch === null ? '' : decodeURIComponent(qMatch[1]).replace(/\s+/g, ' ').trim().slice(0, SECRETARY_SESSIONS_QUERY_MAX)
  const parsed = lMatch === null ? 0 : Number(lMatch[1])
  const limit = Number.isFinite(parsed) && parsed > 0
  ? Math.min(parsed, SECRETARY_SESSIONS_MAX_LIMIT)
  : SECRETARY_SESSIONS_DEFAULT_LIMIT
  return { query: keyword, limit }
}

/** 搜索判据：标题 / id / 目录，任一大写小写都行（用户只会打字，不会记大小写）。 */
function sessionRowMatchesKeyword(row: BindableSecretarySession, keyword: string): boolean {
  if (keyword === '') return true
  const needle = keyword.toLowerCase()
  return row.title.toLowerCase().includes(needle)
    || row.sessionId.toLowerCase().includes(needle)
    || row.cwd.toLowerCase().includes(needle)
}

/**
 * 把宿主两路会话表（持久化清单 + 活会话表）合并成可绑定列表：
 * ① 按 id 去重（同一条两处都有时取更近的 updatedAt，并把 `live` 合上去）；
 * ② 丢掉归档会话（宿主明确说了归档的）；
 * ③ 关键词过滤；
 * ④ 按 updatedAt 倒序（时间未知的排最后，它们通常是被选错的那条）；
 * ⑤ 截断到 limit，但 `bound` 那条永远留着（不然翻页时用户看不到「当前绑定的到底是谁」）。
 */
export function pickBindableSessions(
  rows: readonly BindableSecretarySession[],
  opts: { currentId?: string; query?: string; limit?: number } = {},
): BindableSecretarySession[] {
  const currentId = String(opts.currentId ?? '').trim()
  const keyword = String(opts.query ?? '').trim()
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : SECRETARY_SESSIONS_DEFAULT_LIMIT
  const merged = new Map<string, BindableSecretarySession>()
  for (const row of Array.from(rows ?? [])) {
    const normalized = normalizeBindableSessionRow(row)
    if (normalized === null) continue
    if (normalized.archived === true) continue
    const previous = merged.get(normalized.sessionId)
    if (previous === undefined) { merged.set(normalized.sessionId, normalized); continue }
    if (normalized.updatedAt > previous.updatedAt) {
      previous.updatedAt = normalized.updatedAt
      if (normalized.title !== normalized.sessionId) previous.title = normalized.title
      if (normalized.cwd !== '') previous.cwd = normalized.cwd
    }
    if (normalized.live === true) previous.live = true
  }
  const current = currentId !== '' ? merged.get(currentId) : undefined
  if (current !== undefined) current.bound = true
  const filtered = Array.from(merged.values()).filter((row) => sessionRowMatchesKeyword(row, keyword))
  filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  if (filtered.length <= limit) return filtered
  const trimmed = filtered.slice(0, limit)
  if (current !== undefined && !trimmed.includes(current)) trimmed.unshift(current)
  return trimmed
}

/** 给列表打上「当前绑定」标记（客户端降级路径也要用同一套判据）。 */
export function markBoundSessions(rows: readonly BindableSecretarySession[], currentId: string): BindableSecretarySession[] {
  const id = String(currentId ?? '').trim()
  return Array.from(rows ?? []).map((row) => (row.sessionId === id ? { ...row, bound: true } : row))
}

/** 回读判据：文件里的 state 必须 exactly 等于刚写的那条 id（写坏了就不算成功）。 */
export function secretaryStateMatchesWrite(expected: string, readBack: SecretaryState | null): boolean {
  return readBack !== null && readBack.sessionId === expected
}

export interface SecretaryState {
  sessionId: string
  updatedAt: string
}

/**
 * 当前固定秘书会话 id 的**进程内共享引用**（只读消费方：派活工具 / 主动卡片 / 提示词段）。
 * 真值仍在 dsh-assistant-secretary.json；这里只是让同进程的其它半部不用各自去读盘。
 */
export const secretarySessionRef: { id: string } = { id: '' }

function profileDir(ctx: any): string {
  try {
    const p = ctx?.get?.('profileContext')
    if (p && typeof p.dir === 'string' && p.dir) return p.dir
  } catch {}
  try {
    const h = ctx?.get?.('homePaths')
    if (h && typeof h.home === 'string' && h.home) return h.home
  } catch {}
  return process.env.DSH_HOME || process.cwd()
}

/** 防御式归一：只接受 session id 形态，坏文件按“没有固定会话”处理。 */
export function normalizeSecretaryState(raw: unknown): SecretaryState | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  if (!SESSION_ID_RE.test(sessionId)) return null
  return {
    sessionId,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

/**
 * 只读闸的硬放行项：建/续独立 CU 会话不属于在秘书会话里写文件或跑终端。
 * 单列并优先判断，防止以后收紧白名单时又把派活能力一起 deny。
 */
const SECRETARY_DELEGATION_TOOLS = new Set([
  'secretary_dispatch',
])

/**
 * 纯读类：读文件 / 找文件 / 搜内容 / 看图片，一个字节都不写本机。
 *
 * 2026-11-23 用户实报：读类工具被只读闸一起拦掉后，秘书读不到 Computer Use 会话
 * 写出来的报告文件，只能干等那条会话回话，跟「必须先拿到完整内容再整理」的口径冲突。
 * 只读闸的正确语义是「禁止破坏性/动手类动作」，读不是动手，必须放行。
 */
const SECRETARY_READONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'read_image',
])

/**
 * 目标类工具名单。语义已经改过两轮：
 *   - 2026-11-23 用户实报：长任务（逐条核实 15 篇参考文献那种）在秘书侧立不了 goal，
 *     失去 goal-round-driver 的自动续跑兜底，当时把 create_goal / update_goal 放行了；
 *   - 2026-11-24 用户明确指令「个人秘书为什么会自己建立目标啊……请你禁用个人秘书建立目标完成任务」：
 *     这份名单现在只用来把这三件工具**拒死**——目标与续跑归 Computer Use 会话自己立、自己完成，
 *     秘书只派活（secretary_dispatch）+ 读回报告文件。
 */
const SECRETARY_GOAL_TOOLS = new Set([
  'create_goal', 'update_goal', 'get_goal',
])

/**
 * 「系统通知回合」的消息 id 登记表。
 *
 * CU 完成汇报不再拼日志事件，而是把一条 user 消息交给宿主官方 prompt 通道
 * （`agent.followup`），由宿主自己开轮、自己编号、自己落盘（见 assistant-cu-watch.ts）。
 * 代价是这一轮真的会跑模型，所以必须钉死两件事：
 *   1. 这一轮的**动手类**工具全部禁用——否则模型可能又去派活，派活 → CU 完成 → 通知 → 再派活，
 *      形成没有出口的回路；纯读类（read/glob/grep）
 *      不写不跑不派活，仍放行（见 secretaryNoticeTurnAllowed）；目标类 create_goal / update_goal / get_goal 2026-11-24 起一律拒绝；
 *   2. 只有这一轮禁用，用户正常发起的回合完全不受影响。
 */
const NOTICE_MESSAGE_IDS = new Set<string>()
const NOTICE_ID_LIMIT = 400

/** 登记一条"系统通知"消息 id（CU 完成汇报专用）。 */
export function registerNoticeMessageId(id: string): void {
  const value = String(id ?? '').trim()
  if (value === '') return
  NOTICE_MESSAGE_IDS.add(value)
  if (NOTICE_MESSAGE_IDS.size > NOTICE_ID_LIMIT) {
    const oldest = NOTICE_MESSAGE_IDS.values().next().value
    if (typeof oldest === 'string') NOTICE_MESSAGE_IDS.delete(oldest)
  }
}

/** 这条消息是不是宿主正在处理的那条系统通知。 */
export function isNoticeMessageId(id: unknown): boolean {
  const value = typeof id === 'string' ? id.trim() : ''
  return value !== '' && NOTICE_MESSAGE_IDS.has(value)
}

/** 单测用：清空登记表。 */
export function clearNoticeMessageIds(): void {
  NOTICE_MESSAGE_IDS.clear()
}

/**
 * 秘书会话的其它只读/汇总工具白名单；未知执行工具默认拒绝。
 *
 * 只读限制的对象是「会改本机或动屏幕」的动作：写文件、编辑文件、终端、直接 Computer Use、
 * 派子代理。以下两类**不是**动手，必须放行（2026-11-23 用户定语义）：
 *   - 纯读类 read / glob / grep / read_image（读文件、找文件、搜内容，见 SECRETARY_READONLY_TOOLS）；
 *   - 只读联网 web_search / web_fetch（「明天天气」这类轻量问题由秘书自己查）。
 * 目标类 create_goal / update_goal / get_goal 从 2026-11-24 起是**明确拒绝**的：长任务的目标与续跑归
 * Computer Use 会话自己立，秘书只派活 + 读回报告。会话/记忆摘要仍可按前缀放行。
 */
const SECRETARY_ALLOWED_TOOLS = new Set([
  'ask_user_question', 'present', 'skill',
  'todo_write',
  'list_agents', 'job_list', 'job_output',
  'proactive_card',
  'web_search', 'web_fetch',
  // 日程四件套只作用于本会话自己的提醒表（不落本机文件/不动屏幕/不跑终端），2026-11-22 用户要求放行。
  'schedule_list', 'schedule_create', 'schedule_update', 'schedule_delete',
])

export function secretaryToolDenied(toolName: string): boolean {
  const name = String(toolName ?? '').trim().toLowerCase()
  if (name === '') return false
  if (SECRETARY_DELEGATION_TOOLS.has(name)) return false
  if (SECRETARY_READONLY_TOOLS.has(name)) return false
  if (SECRETARY_GOAL_TOOLS.has(name)) return true // 2026-11-24 用户明确指令：秘书侧不立目标，goal 类一律拒绝（目标归 Computer Use 会话自己立）
  if (SECRETARY_ALLOWED_TOOLS.has(name)) return false
  // 宿主以后新增的 web 读工具（如 web_extract）同样是只读查询，按前缀放行。
  if (name.startsWith('web_')) return false
  // 会话查询是只读历史工具，未来装上时直接放行；mnemon_* 是记忆读写，不是任务执行。
  if (name.startsWith('session_')) return false
  if (name.startsWith('mnemon_')) return false
  return true
}

/**
 * 「系统通知回合」里仍然放行的工具：只有纯读类（2026-11-24 起目标类已改为一律拒绝）。
 *
 * 那条闸的用途只有一个——掐掉「通知 → 再派活 → 再通知」的回路，以及这一轮的动手能力；
 * 它不该顺手把读文件也禁掉：通知里的返回原文一旦被截断，秘书唯一的补救办法
 * 就是去读那条 CU 会话写出来的报告文件（用户 2026-11-23 实报的第二个后果）。
 * 纯读类不写本机文件、不跑命令、不派活，放行不会造成回路。
 */
export function secretaryNoticeTurnAllowed(toolName: string): boolean {
  const name = String(toolName ?? '').trim().toLowerCase()
  if (name === '') return false
  if (SECRETARY_READONLY_TOOLS.has(name)) return true
  // 2026-11-24 用户明确指令：通知回合也不放行目标类；create_goal/update_goal/get_goal 落到默认拒绝
  return false
}

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readJsonBody(req: any, maxBytes = MAX_BODY_BYTES): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    let size = 0
    req.on('data', (chunk: any) => {
      const text = String(chunk ?? '')
      size += Buffer.byteLength(text)
      if (size <= maxBytes) raw += text
    })
    req.on('end', () => {
      if (size > maxBytes) { resolve({ __tooLarge: true }); return }
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function readFileState(file: string): SecretaryState | null {
  try {
    return normalizeSecretaryState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** ── 已读卡集合（未读红点的宿主真值）───────────────────────────────
 *  只落 profile 文件，不写会话日志、不拼 turn 事件：
 *  GET  /api/assistant/secretary-read?sessionId=<id>            → { ok, sessionId, cards, count }
 *  POST /api/assistant/secretary-read  { sessionId, cardKey, mark:'read' } → { ok, sessionId, cardKey, read, count }
 *  DELETE /api/assistant/secretary-read?sessionId=<id>          → 清空那条会话的已读集合（测试/重置）
 */
export const ASSISTANT_SECRETARY_READ_ROUTE = '/api/assistant/secretary-read'
const READ_STATE_FILENAME = 'dsh-assistant-secretary-read.json'
/** 每个会话最多记这么多 cardKey（超过就把最旧的一批丢掉，防文件无限长）。 */
export const READ_MAX_KEYS = 400
const READ_CARD_KEY_RE = /^[A-Za-z0-9:._#-]{1,200}$/

/* ── 卡片引用登记（2026-11-23 第 4 项需求）────────────────────────────────
 * 客户端那颗「引用」按钮（卡片脚部、时间左边）写这条路由；插件落
 * dsh-assistant-secretary-quote.json（每条会话只留一条当前引用），随后由下面那条
 * systemPrompt 段落（order 1783，只喂秘书会话）把这张卡的种类 / 轮次 / 摘录 /
 * `[[session:…]]` 会话 id 喂给秘书模型——用户接下去那条消息就是接着它说的内容。
 * 真实用户消息把引用吃掉之后（那一轮 turn/end）清掉；用户一直没发消息 → 30 分钟过期。
 * 引用只喂上下文：只读闸、通知回合锁定一个字都没动，不给任何工具开口子。
 * cardKey 口径与已读集合同一条正则，与客户端 normalizeCardKey 同一形状。 */
export const ASSISTANT_SECRETARY_QUOTE_ROUTE = '/api/assistant/secretary-quote'
const QUOTE_STATE_FILENAME = 'dsh-assistant-secretary-quote.json'
/** 一条引用最多活多久（用户点了引用但一直没往下说时，不许无限挂着）。 */
export const QUOTE_TTL_MS = 30 * 60 * 1000
/** 引用摘录上限：只用于告诉模型「引用的是哪段话」，不是完整汇报口径。 */
export const QUOTE_PREVIEW_MAX_CHARS = 600
/** 引用登记的上限：base64 一律不认，但卡正文全文 + 附件信息要装得下（不借用普通 4KB 上限）。 */
const QUOTE_MAX_BODY_BYTES = 256 * 1024
/** 三种卡片种类（与客户端 CARD_KIND_* 同一组字面量）。 */
export const QUOTE_CARD_KINDS = ['assistant', 'user', 'notice'] as const
/** 引用注入段的段落号（1785 语音输入段、1790 派活分层段之间；不并入任何既有段落）。 */
export const SECRETARY_QUOTE_SECTION_ORDER = 1783
/**
 * 引用硬锚点段的段落号（2026-11-25 用户实报「引用不生效」的修法）：
 * 失效现场判据不是「引用没登记」——模型那一轮 prompt 里 1783 段是在的、内容也对，
 * 但它贴在派活分层(1790)之前，离这条用户消息还隔着一大段派活规则，且正文写的是
 * 「用户接下来那条消息」（未来时），模型这一轮手里已经握着这条消息，等于没被钉住。
 * 所以加一张贴在派活分层(1790)之后、最靠近这条用户消息的硬锚点段：既有 1783 段原样保留。
 */
export const SECRETARY_QUOTE_ANCHOR_SECTION_ORDER = 1791
/**
 * 拼进「本轮用户消息本体」的那块正文的固定开头标记（2026-11-25 第 3 次修法）。
 * 两个用途：① 给模型一个能一眼认出的边界（这段就是被引用的那张卡）；
 * ② 给「已经拼过」一个幂等判据——重试或重复 pre-step 不会把同一块拼第二遍。
 */
export const QUOTE_MESSAGE_BLOCK_OPEN = '【引用卡｜本轮必须回答的卡（个人秘书）】'
/**
 * 引用正文（body）的上限：**只属于引用链路**，不是卡片展示预算。
 * 卡片折叠/摘录那套 900/600/200 是渲染预算，一个字都不动；这里保的是「喂给模型的卡正文」——
 * 默认全文照录，只有超过 20000 字这种异常长卡才截断并显式标注（截断要看得见）。
 */
export const QUOTE_BODY_MAX_CHARS = 20_000
/** 一条引用最多带多少个附件（卡片脚部引用时登记的附件信息）。 */
export const QUOTE_ATTACHMENT_MAX = 12
/** 引用里附件名/附件说明各自的上限（防把超长文件名塞进 prompt）。 */
export const QUOTE_ATTACHMENT_TEXT_MAX = 160

/** 引用里连附件一起记：只有文件信息（名字/种类/大小那类说明），不带图片本体。 */
export interface SecretaryQuoteAttachment {
  name: string
  /** 'image' | 'file'（与客户端 UserCardAttachment.kind 同一组字面量）。 */
  kind: string
  /** 文件大小/类型那类说明（图片可能为空）。 */
  meta: string
}

export interface SecretaryQuoteRecord {
  cardKey: string
  kind: string
  turnNo: string
  /** 卡片正文摘录（定位用，最多 QUOTE_PREVIEW_MAX_CHARS；引用 chip 也用它）。 */
  preview: string
  /** 卡片正文全文（喂模型用，最多 QUOTE_BODY_MAX_CHARS；引用链路自己的字段，不借卡片展示预算）。 */
  body: string
  /** 卡片里带的附件（只有文件信息；图片本体不随引用注入）。 */
  attachments: SecretaryQuoteAttachment[]
  refSessionIds: string[]
  /** 客户端写入时刻（epoch ms）；TTL 就按它算。 */
  updatedAt: number
}

export function normalizeQuoteCardKey(raw: unknown): string {
  const value = String(raw ?? '').trim()
  return READ_CARD_KEY_RE.test(value) ? value : ''
}

/** 归一引用里的会话 id 列表：坏值丢、按序去重、最多 8 条（与客户端 normalizeQuoteSessionIds 同一口径）。 */
export function normalizeQuoteSessionIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const out: string[] = []
  for (const item of list) {
    const id = String(item ?? '').trim()
    if (id === '' || id.length > 120 || !SESSION_ID_RE.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= 8) break
  }
  return out
}

/** 归一引用里的附件：坏值丢、按序去重（name+kind）、截到上限；图片本体一律不认（只留文件信息）。 */
export function normalizeQuoteAttachments(raw: unknown): SecretaryQuoteAttachment[] {
  const list = Array.isArray(raw) ? raw : []
  const out: SecretaryQuoteAttachment[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const source = item as Record<string, unknown>
    const name = String(source.name ?? '').trim().slice(0, QUOTE_ATTACHMENT_TEXT_MAX)
    if (name === '') continue
    const kind = String(source.kind ?? '').trim() === 'image' ? 'image' : 'file'
    const meta = String(source.meta ?? '').trim().slice(0, QUOTE_ATTACHMENT_TEXT_MAX)
    if (out.some((existing) => existing.name === name && existing.kind === kind)) continue
    out.push({ name, kind, meta })
    if (out.length >= QUOTE_ATTACHMENT_MAX) break
  }
  return out
}

/**
 * 归一卡片正文全文：默认全文照录；只有超过 QUOTE_BODY_MAX_CHARS 才截断，并在末尾**显式**写出截断事实
 * （截断要看得见，不许悄悄少半截）。空串回空串，注入时再退回 preview。
 */
export function normalizeQuoteBody(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (text.length <= QUOTE_BODY_MAX_CHARS) return text
  const cut = text.slice(0, QUOTE_BODY_MAX_CHARS)
  return `${cut}\n（卡正文超过 ${QUOTE_BODY_MAX_CHARS} 字，引用链路只保到这里；后面还有 ${text.length - QUOTE_BODY_MAX_CHARS} 字未注入）`
}

/** 归一条引用记录：形状不对整条丢（宁可不注入也不乱注入；与客户端 normalizeQuoteRecord 同一口径）。 */
export function normalizeQuoteRecord(raw: unknown, now = Date.now()): SecretaryQuoteRecord | null {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (source === null) return null
  const cardKey = normalizeQuoteCardKey(source.cardKey)
  const kind = String(source.kind ?? '').trim()
  if (cardKey === '' || !(QUOTE_CARD_KINDS as readonly string[]).includes(kind)) return null
  const previewRaw = String(source.preview ?? '')
  const preview = previewRaw.length > QUOTE_PREVIEW_MAX_CHARS ? `${previewRaw.slice(0, QUOTE_PREVIEW_MAX_CHARS - 1)}…` : previewRaw
  const updatedAtRaw = Number(source.updatedAt)
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : now
  return {
    cardKey,
    kind,
    turnNo: String(source.turnNo ?? '').trim(),
    preview,
    body: normalizeQuoteBody(source.body),
    attachments: normalizeQuoteAttachments(source.attachments),
    refSessionIds: normalizeQuoteSessionIds(source.refSessionIds),
    updatedAt,
  }
}

/** 这条引用还在不在（与客户端 quoteAlive 同一口径）。 */
export function quoteAlive(record: SecretaryQuoteRecord | null, now = Date.now(), ttlMs = QUOTE_TTL_MS): boolean {
  if (record === null) return false
  return now - record.updatedAt <= ttlMs
}

/** 归一「sessionId → 当前引用」的存储：坏 sessionId 丢、坏记录丢、过期记录丢。 */
export function normalizeSecretaryQuoteState(raw: unknown, now = Date.now()): Record<string, SecretaryQuoteRecord> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: Record<string, SecretaryQuoteRecord> = {}
  for (const [sessionId, value] of Object.entries(source)) {
    if (!SESSION_ID_RE.test(String(sessionId ?? ''))) continue
    const record = normalizeQuoteRecord(value, now)
    if (record === null || !quoteAlive(record, now)) continue
    out[sessionId] = record
  }
  return out
}

const QUOTE_KIND_LABELS: Record<string, string> = {
  notice: '系统通知卡',
  user: '用户消息卡',
  assistant: '秘书回复卡',
}

/**
 * 引用注入段正文（纯函数，测试逐条断言）。
 * 语义：这张卡就是下一条消息要回复的对象；摘录只是定位用，结果口径仍然完整照实。
 */
export function secretaryQuoteInjectionText(record: SecretaryQuoteRecord | null): string {
  if (record === null) return ''
  const kindLabel = QUOTE_KIND_LABELS[record.kind] ?? '卡片'
  const lines = [
    '# 卡片引用（个人秘书）',
    `用户刚在会话页上按了「引用」，引用的就是下面这张${kindLabel}；用户这条消息就是要接着它说的内容。`,
    `定位：kind=${record.kind}｜轮次 ${record.turnNo === '' ? '未知' : record.turnNo}｜cardKey=${record.cardKey}`,
    `卡片正文摘录（不是完整汇报，只用来定位引用的是哪段话）：${record.preview}`,
  ]
  if (record.refSessionIds.length > 0) {
    lines.push(`这张卡里引用的会话 id：${record.refSessionIds.join('、')}——接着这件事要继续，就用 secretary_dispatch kind=existing 落到那条会话所在的项目目录。`)
  }
  lines.push('处理要求：把用户这条消息当作对这张卡的回应；不许因为摘录短就把用户这条消息里的要求吞掉，也不许把这张卡的原有内容改写成别的说法。引用登记只说明「接着哪张卡说」，不改变任何派活与工具规则。')
  lines.push('这张卡的正文全文与附件信息已经拼进本条用户消息的正文末尾（「引用卡」开头的那一块，不是系统提示里的一段说明）：回答口径以那条消息里的卡正文为准，本段的摘录只用来定位。')
  return lines.join('\n')
}

/**
 * 引用硬锚点段正文（纯函数，测试逐条断言；2026-11-25 用户实报「引用不生效」的修法）。
 * 与 1783 登记段分工：登记段说「引用的是哪张卡」，锚点段贴在这条用户消息之前，
 * 用不许改口的硬要求把这条消息里的指代钉在这张卡上——先回答这张卡，不许接到别的任务。
 */
export function secretaryQuoteAnchorText(record: SecretaryQuoteRecord | null): string {
  if (record === null) return ''
  const kindLabel = QUOTE_KIND_LABELS[record.kind] ?? '卡片'
  const lines = [
    '# 引用锚点（个人秘书）',
    `这条用户消息引用的就是这张${kindLabel}：cardKey=${record.cardKey}｜kind=${record.kind}｜轮次 ${record.turnNo === '' ? '未知' : record.turnNo}。`,
    `被引用卡正文：${record.preview}`,
    '处理要求：这条消息里的指代（这个、那张、它、这条任务）一律指向这张卡；先回答这张卡接着的那件事，不许把这条消息接到最近那条派活、最近那条系统通知或别的任务上；不许因为摘录短就吞掉这条消息里的要求；不许在多个候选任务里自己挑一个来接。引用锚点只说明「接着哪张卡说」，不改变任何派活与工具规则。',
  ]
  return lines.join('\n')
}

/**
 * 引用卡「拼进用户消息本体」的那一块正文（2026-11-25 第 3 次实报的修法；纯函数，测试逐条断言）。
 * 与前两轮的分工：1783/1791 两段只是系统提示里的说明文字；这一段由 `agent/pre-step` 直接拼到
 * **本轮用户消息的正文末尾**——宿主 asar 里 `dsh-agent-loop/lib/index.js:699-711` 把这个 step 的
 * messages 交出来，`:873-880` 把返回的 decision.messages 原样 append 成 user/message，所以这里
 * 拼进去的就是模型真正读到的那条用户消息本体，不是另一个 system 段。
 * 写法按用户原话钉死：① 优先级最高 ② 忽略无关的最近上下文 ③ 禁止多候选自选 ④ 模糊指代指向引用卡。
 */
export function secretaryQuoteCardBlockText(record: SecretaryQuoteRecord | null): string {
  if (record === null) return ''
  const kindLabel = QUOTE_KIND_LABELS[record.kind] ?? '卡片'
  const body = record.body.trim() === '' ? record.preview : record.body
  const attachments = record.attachments.length === 0
    ? '（这张卡没有附件）'
    : record.attachments.map((item) => `${item.name}｜${item.kind === 'image' ? '图片' : '文件'}${item.meta === '' ? '' : `｜${item.meta}`}`).join('；')
  const lines = [
    QUOTE_MESSAGE_BLOCK_OPEN,
    `这张卡是用户这条消息按「引用」选中的${kindLabel}（轮次 ${record.turnNo === '' ? '未知' : record.turnNo}｜cardKey=${record.cardKey}）：正文全文已经拼在下面，它是本轮唯一的回答对象。`,
    '—— 卡正文开始 ——',
    body,
    '—— 卡正文结束 ——',
    `卡里带的附件（只有文件信息，图片本体没有随引用送来）：${attachments}`,
    '【硬指令｜按优先级执行】',
    '① 这张引用卡的内容优先级最高，本轮回答必须针对它。',
    '② 忽略与引用无关的最近对话上下文（包括上一条任务、系统通知、待办提醒）：不许把本条消息接到最近那条派活上，也不许接到最近那条系统通知上，也不许接到最近一轮的任务进度上。',
    '③ 禁止在多个候选任务里自己挑一个来接。',
    '④ 用户这句模糊指代（这个、那张、它、这条任务、这个任务）一律指向这张引用卡。',
    '【附件口径】附件只有名字与种类：图里的内容没有随引用注入，不许编造图里没写的细节，也不许假装看过这张图。',
    '引用卡只说明回答哪张卡，不改变任何派活与工具规则。',
  ]
  return lines.join('\n')
}

/** 把引用卡块贴到消息最后一个 text 块后面（没有 text 块就补在末尾；附件块顺序一个都不动）。 */
function contentWithQuoteBlock(content: readonly any[], block: string): any[] | null {
  const blocks = Array.isArray(content) ? content.slice() : []
  if (blocks.length === 0) return null
  let lastText = -1
  for (let index = 0; index < blocks.length; index += 1) {
    const item = blocks[index]
    if (item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') lastText = index
  }
  if (lastText >= 0) blocks[lastText] = { ...blocks[lastText], text: `${blocks[lastText].text}\n\n${block}` }
  else blocks.push({ type: 'text', text: block })
  return blocks
}

/**
 * 把被引用卡的正文拼进本轮用户消息**本体**（2026-11-25 第 3 次修法；纯函数，测试逐条断言）。
 * 挑哪条：从后往前第一条「真实用户消息」——user 角色、有 content、不是插件登记的通知卡、
 * 不是宿主的运行时上下文快照。用户原话一个字不改，卡块贴在它后面（同一条消息里连续相邻）。
 * 幂等：消息里已经有 {@link QUOTE_MESSAGE_BLOCK_OPEN} 就不再拼第二遍（重试/重复 pre-step 不叠加）。
 * @param messages - `agent/pre-step` 交给插件的那一批（`decision.messages`，即将被 append 成 user/message）。
 * @param record - 当前会话活着的引用记录；null/空串视为没有引用。
 * @returns 新数组（不改入参）与「这次到底拼没拼」。
 */
export function spliceQuoteIntoUserMessage(
  messages: readonly unknown[] | null | undefined,
  record: SecretaryQuoteRecord | null,
): { messages: any[]; spliced: boolean } {
  const list = Array.isArray(messages) ? messages.slice() : []
  if (record === null) return { messages: list, spliced: false }
  const block = secretaryQuoteCardBlockText(record)
  if (block === '') return { messages: list, spliced: false }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index] as any
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    if (String(message.source?.kind ?? '') === 'runtime-context') continue
    if (isNoticeMessageId(message.id)) continue
    const content = Array.isArray(message.content) ? message.content : []
    if (content.length === 0) continue
    const already = content.some((item: any) => item !== null && typeof item === 'object'
      && item.type === 'text' && typeof item.text === 'string' && item.text.includes(QUOTE_MESSAGE_BLOCK_OPEN))
    if (already) return { messages: list, spliced: false }
    const nextContent = contentWithQuoteBlock(content, block)
    if (nextContent === null) continue
    list[index] = { ...message, content: nextContent }
    return { messages: list, spliced: true }
  }
  return { messages: list, spliced: false }
}


export function normalizeReadCardKey(raw: unknown): string {
  const value = String(raw ?? '').trim()
  return READ_CARD_KEY_RE.test(value) ? value : ''
}

/** 归一一个会话的 cardKey 列表：坏值丢掉、按序去重、截到上限（保留最新的）。 */
export function normalizeReadCardKeys(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const out: string[] = []
  for (const item of list) {
    const key = normalizeReadCardKey(item)
    if (key === '' || out.includes(key)) continue
    out.push(key)
  }
  return out.length > READ_MAX_KEYS ? out.slice(out.length - READ_MAX_KEYS) : out
}

/** 归一「sessionId → cardKey 列表」的存储：坏 sessionId 丢掉、坏 key 丢掉、每会话截到上限。 */
export function normalizeSecretaryReadState(raw: unknown): Record<string, string[]> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: Record<string, string[]> = {}
  for (const [sessionId, value] of Object.entries(source)) {
    if (!SESSION_ID_RE.test(String(sessionId ?? ''))) continue
    const keys = normalizeReadCardKeys(value)
    if (keys.length > 0) out[sessionId] = keys
  }
  return out
}

/** 往已读集合里加一条 cardKey（幂等、按插入顺序、超出上限丢最旧）。返回该会话现在的已读条数。 */
export function addReadCardKey(state: Record<string, string[]>, sessionId: string, cardKey: string): number {
  const key = normalizeReadCardKey(cardKey)
  if (key === '') return 0
  const list = Array.isArray(state[sessionId]) ? state[sessionId] : []
  if (!list.includes(key)) {
    list.push(key)
    while (list.length > READ_MAX_KEYS) list.shift()
  }
  state[sessionId] = list
  return list.length
}

/** 问不出结果（老宿主既没给 sessions.list 也没给 sessionQuery）时，客户端按「不许凭空写」处理。 */
const SESSION_SOURCE_NONE = 'none'

/**
 * 从宿主投影块里取标题：**{ asOfSeq, values: { title } }**（宿主自己的会话列表 API 也是这么取的）。
 * 形状不对 / 没有 title 行 / 不是字符串 → 空串（调用方据此保留 id 兜底，绝不因为没标题就丢这行）。
 */
export function titleFromProjectionBlock(block: unknown): string {
  const values = (block as any)?.values
  if (values === null || typeof values !== 'object') return ''
  const raw = (values as Record<string, unknown>).title
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS)
}

/**
 * 一条宿主会话的真实标题（2026-11-27 用户实测：控制室「更换会话」面板里全是 session-83bca3e3-… 原始 id）。
 *
 * 根因：宿主会话表的 header **只有身份**（id / cwd / createdAt / updatedAt），没有标题。
 * 标题是会话日志 fold 出来的投影行 `title`，宿主自己的会话列表也是从投影里取的：
 *   活会话 → `ctx.sessionProjections.cachedSnapshot(session)`（内存里现成，零 IO）；
 *   冷会话 → `ctx.sessionProjectionCache.cachedSnapshot(header)`（磁盘侧投影缓存，同样零日志读）；
 *            跨格式世代的老记录再退一步走 `cachedPredecessorTitle(header)`（只借前代 title 行）；
 *   最后兜底才问 `ctx.sessionTitle.get(session)`（只对活会话成立）。
 * 全都问不出来就回空串——外面拿 id 兜底，不许因为标题缺席把这条会话从候选里丢掉。
 */
function resolveHostSessionTitle(ctx: any, header: any, live: boolean): string {
  const sessionId = String(header?.id ?? '').trim()
  let liveSession: any
  try {
    if (live === true && sessionId !== '' && typeof ctx?.sessions?.get === 'function') liveSession = ctx.sessions.get(sessionId)
  } catch { /* 取不到活会话就只走缓存那一路 */ }
  try {
    const projections = ctx?.sessionProjections
    if (liveSession !== undefined && liveSession !== null && projections && typeof projections.cachedSnapshot === 'function') {
      const title = titleFromProjectionBlock(projections.cachedSnapshot(liveSession))
      if (title !== '') return title
    }
  } catch { /* 活会话那一路问不出：继续走投影缓存 */ }
  try {
    const cache = typeof ctx?.get === 'function' ? ctx.get('sessionProjectionCache') : undefined
    if (cache && typeof cache.cachedSnapshot === 'function') {
      let title = titleFromProjectionBlock(cache.cachedSnapshot(header))
      if (title === '' && typeof cache.cachedPredecessorTitle === 'function') {
        title = titleFromProjectionBlock(cache.cachedPredecessorTitle(header))
      }
      if (title !== '') return title
    }
  } catch { /* 投影缓存也没有：再问一次标题服务 */ }
  try {
    const titles = typeof ctx?.get === 'function' ? ctx.get('sessionTitle') : undefined
    if (liveSession !== undefined && liveSession !== null && titles && typeof titles.get === 'function') {
      const snapshot = titles.get(liveSession)
      const raw = typeof snapshot === 'string' ? snapshot : (snapshot as any)?.title
      const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS) : ''
      if (title !== '') return title
    }
  } catch { /* 标题服务不可用就算了：id 兜底 */ }
  return ''
}

/**
 * 取宿主两路会话表（持久化清单优先、活会话表补上 `live`），**并补上真实标题**。
 * 两路都试、都失败才回空——返回 empty 而不是 null 是因为「会话表空」本身是合法答案
 * （新 profile 一条会话都没有），客户端据此知道「真没有可选会话」，不用猜宿主答没答话。
 * 标题这一步见 {@link resolveHostSessionTitle}：宿主 header 里没有标题，得自己去投影缓存取。
 */
async function collectHostSessionRows(ctx: any): Promise<{ rows: BindableSecretarySession[]; source: string }> {
  const entries: { header: any; live: boolean }[] = []
  let source = SESSION_SOURCE_NONE
  try {
    const query = ctx?.get?.('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      const list = await query.listSessions(undefined)
      if (Array.isArray(list)) {
        source = 'session-query'
        for (const record of list) {
          const header = (record as any)?.header ?? record
          if (header === null || typeof header !== 'object') continue
          entries.push({ header, live: (record as any)?.live === true })
        }
      }
    }
  } catch { /* 没有 sessionQuery：只剩活会话表那一趟 */ }
  try {
    const live = Array.isArray(ctx?.sessions?.list?.()) ? ctx.sessions.list() : null
    if (live !== null) {
      if (source === SESSION_SOURCE_NONE) source = 'sessions-list'
      for (const session of live) {
        const header = (session as any)?.header ?? session
        if (header === null || typeof header !== 'object') continue
        entries.push({ header, live: true })
      }
    }
  } catch { /* 宿主没有 sessions.list：只剩持久化清单的结果 */ }
  const rows: BindableSecretarySession[] = []
  for (const entry of entries) {
    const row = normalizeBindableSessionRow(entry.header)
    if (row === null) continue
    if (entry.live) row.live = true
    // 宿主 header 里没有标题：标题自己去投影缓存取（取不到就留着 id 兜底）
    if (row.title === row.sessionId) {
      const title = resolveHostSessionTitle(ctx, entry.header, entry.live)
      if (title !== '') row.title = title
    }
    rows.push(row)
  }
  return { rows, source }
}

export function registerAssistantSecretary(ctx: any): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  const webServer = routes.webServer
  const file = join(profileDir(ctx), STATE_FILENAME)
  let state: SecretaryState | null = readFileState(file)
  let activeSessionId = state?.sessionId ?? ''
  secretarySessionRef.id = activeSessionId
  let chain: Promise<unknown> = Promise.resolve()

  const writeState = (sessionId: string): Promise<SecretaryState> => {
    const task = async (): Promise<SecretaryState> => {
      const next: SecretaryState = { sessionId, updatedAt: new Date().toISOString() }
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next), 'utf8')
      renameSync(tmp, file)
      state = next
      activeSessionId = next.sessionId
      secretarySessionRef.id = next.sessionId
      return next
    }
    const run = chain.then(task, task)
    chain = run.then(() => void 0, () => void 0)
    return run
  }

  const clearState = (): Promise<void> => {
    const task = async (): Promise<void> => {
      try { if (existsSync(file)) rmSync(file, { force: true }) } catch {}
      state = null
      activeSessionId = ''
      secretarySessionRef.id = ''
    }
    const run = chain.then(task, task)
    chain = run.then(() => void 0, () => void 0)
    return run
  }

  /** 写坏了的收场：把之前那条 state 恢复回去（恢复不了就明确回失败，绝不留着坏 id）。 */
  const restoreSecretaryState = async (previous: SecretaryState | null): Promise<SecretaryState | null> => {
    try {
      if (previous === null) {
        await clearState()
        return null
      }
      const back = await writeState(previous.sessionId)
      return secretaryStateMatchesWrite(previous.sessionId, readFileState(file)) ? back : null
    } catch {
      return null
    }
  }

  webServer.register({
    kind: 'exact',
    path: ASSISTANT_SECRETARY_ROUTE,
    handler: async (req: any, res: any) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      const current = state?.sessionId ?? ''
      try {
        if (method === 'GET' || method === 'HEAD') {
          const query = parseSecretaryRequestQuery(String(req.url ?? ''))
          // 显式问某条候选 id（客户端「新建出来的会话 retain 得住吗」预确认，不写 state 就问）；
          // 没带 sessionId 才问 state 里当前挂着的那条
          const askedId = query.requestedId !== '' ? query.requestedId : current
          const exists = query.wantsVerify
            ? (askedId === '' ? false : await secretarySessionExistsOnHost(ctx, askedId))
            : undefined
          if (query.wantsVerify && exists !== true) {
            appendOpenDiag({ step: 'host-secretary-verify', sessionId: askedId, exists })
          }
          sendJson(res, 200, {
            ok: true,
            sessionId: current || null,
            updatedAt: state?.updatedAt ?? '',
            dispatchPolicy: SECRETARY_DISPATCH_POLICY,
            ...(query.wantsVerify
              ? { exists, ...(query.requestedId !== '' ? { queried: query.requestedId } : {}) }
              : {}),
          })
          return
        }
        if (method === 'POST' || method === 'PUT') {
          const body = await readJsonBody(req)
          if (body?.__tooLarge === true) { sendJson(res, 413, { ok: false, error: 'too-large' }); return }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!SESSION_ID_RE.test(sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid-session-id' })
            return
          }
          // 去抖：宿主 state 里已经是这条 id 就不重写盘、不重刷 updatedAt——
          // 多客户端 / 重复点击反复 POST 同一个 id 不会互相覆盖、也不会刷日志。
          if (sessionId === current && state !== null) {
            appendOpenDiag({ step: 'host-state-skip-unchanged', sessionId })
            sendJson(res, 200, { ok: true, sessionId, updatedAt: state.updatedAt, unchanged: true })
            return
          }
          const next = await writeState(sessionId)
          appendOpenDiag({ step: 'host-state-write', sessionId, previous: current })
          sendJson(res, 200, { ok: true, sessionId: next.sessionId, updatedAt: next.updatedAt })
          return
        }
        if (method === 'DELETE') {
          appendOpenDiag({ step: 'host-state-clear', sessionId: current })
          await clearState()
          sendJson(res, 200, { ok: true, sessionId: null, updatedAt: '' })
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, DELETE' })
        res.end()
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) })
      }
    },
  })

  // ── 更换会话（控制室卡片上的「更换会话」按钮）────────────────────────
  // 同一条路由两种方法：GET 列候选、POST 定绑定。写 state 的严格边界都在这条路由上，
  // 既有 POST /api/assistant/secretary（重建链路在用）一个字没改。
  webServer.register({
    kind: 'exact',
    path: ASSISTANT_SECRETARY_SESSIONS_ROUTE,
    handler: async (req: any, res: any) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      const current = state?.sessionId ?? ''
      try {
        if (method === 'GET' || method === 'HEAD') {
          const parsed = parseSecretarySessionsQuery(String(req.url ?? ''))
          const collected = await collectHostSessionRows(ctx)
          // 先算一份「不截断」的候选：total/truncated 都以它为准——
          // 归档/搜索过滤掉的条数不算「截断」，不然面板会一直提示列表不全。
          const all = pickBindableSessions(collected.rows, {
            currentId: current,
            query: parsed.query,
            limit: Number.MAX_SAFE_INTEGER,
          })
          const items = pickBindableSessions(collected.rows, {
            currentId: current,
            query: parsed.query,
            limit: parsed.limit,
          })
          sendJson(res, 200, {
            ok: true,
            sessionId: current || null,
            updatedAt: state?.updatedAt ?? '',
            query: parsed.query,
            limit: parsed.limit,
            total: all.length,
            returned: items.length,
            truncated: all.length > items.length,
            source: collected.source,
            items,
          })
          return
        }
        if (method === 'POST' || method === 'PUT') {
          const body = await readJsonBody(req)
          if (body?.__tooLarge === true) { sendJson(res, 413, { ok: false, error: 'too-large' }); return }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!SESSION_ID_RE.test(sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid-session-id' })
            return
          }
          const previous = state
          const currentId = previous?.sessionId ?? ''
          if (sessionId === currentId && previous !== null) {
            appendOpenDiag({ step: 'host-switch-skip-unchanged', sessionId })
            sendJson(res, 200, { ok: true, sessionId, updatedAt: previous.updatedAt, unchanged: true })
            return
          }
          const collected = await collectHostSessionRows(ctx)
          const known = collected.rows.some((row) => row.sessionId === sessionId)
          if (!known) {
            // 硬约束：秘书 id 必须指向宿主读得回来的会话。认不到就不写，别把坏的写进去。
            appendOpenDiag({ step: 'host-switch-refused', sessionId, reason: collected.source === SESSION_SOURCE_NONE ? 'no-session-source' : 'session-not-in-host-list' })
            sendJson(res, 400, {
              ok: false,
              error: collected.source === SESSION_SOURCE_NONE ? 'no-session-source' : 'session-not-in-host-list',
              sessionId: currentId || null,
            })
            return
          }
          let next: SecretaryState | null = null
          let writeError = ''
          try {
            next = await writeState(sessionId)
          } catch (err: any) {
            writeError = String(err?.message ?? err)
          }
          if (next === null) {
            appendOpenDiag({ step: 'host-switch-write-failed', sessionId, error: writeError })
            sendJson(res, 500, { ok: false, error: 'state-write-failed', message: writeError, sessionId: currentId || null })
            return
          }
          if (!secretaryStateMatchesWrite(sessionId, readFileState(file))) {
            const restored = await restoreSecretaryState(previous)
            appendOpenDiag({ step: 'host-switch-read-back-mismatch', sessionId, restored: restored?.sessionId ?? '' })
            sendJson(res, 500, {
              ok: false,
              error: 'state-read-back-mismatch',
              sessionId: restored?.sessionId ?? null,
              restored: restored !== null,
            })
            return
          }
          appendOpenDiag({ step: 'host-switch-bind', sessionId, previous: currentId })
          sendJson(res, 200, {
            ok: true,
            sessionId: next.sessionId,
            updatedAt: next.updatedAt,
            previous: currentId || null,
            verified: true,
            readBack: true,
            dispatchPolicy: SECRETARY_DISPATCH_POLICY,
          })
          return
        }
        if (method === 'DELETE') {
          sendJson(res, 405, { ok: false, error: 'not-allowed', message: '秘书绑定只能用 POST 改；要重置请走 DELETE /api/assistant/secretary' })
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST, PUT' })
        res.end()
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) })
      }
    },
  })


  // ── 已读卡集合（未读红点的宿主真值）───────────────────────────────
  // 落 dsh-assistant-secretary-read.json（按 sessionId 存已读 cardKey 集合）：
  // 不写会话日志、不拼 turn 事件，纯文件读写，写盘走同一条 chain 防并发覆盖。
  const readStateFile = join(profileDir(ctx), READ_STATE_FILENAME)
  const readState: Record<string, string[]> = (() => {
    try {
      return normalizeSecretaryReadState(JSON.parse(readFileSync(readStateFile, 'utf8')))
    } catch {
      return {}
    }
  })()
  let readUpdatedAt = ''

  const persistReadState = (): Promise<void> => {
    const task = async (): Promise<void> => {
      mkdirSync(dirname(readStateFile), { recursive: true })
      const tmp = `${readStateFile}.${process.pid}.tmp`
      const payload = { version: 1, updatedAt: new Date().toISOString(), bySession: readState }
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, readStateFile)
      readUpdatedAt = payload.updatedAt
    }
    const run = chain.then(task, task)
    chain = run.then(() => void 0, () => void 0)
    return run
  }

  webServer.register({
    kind: 'exact',
    path: ASSISTANT_SECRETARY_READ_ROUTE,
    handler: async (req: any, res: any) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      try {
        if (method === 'POST' || method === 'PUT') {
          const body = await readJsonBody(req)
          if (body?.__tooLarge === true) { sendJson(res, 413, { ok: false, error: 'too-large' }); return }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          const cardKey = normalizeReadCardKey(body?.cardKey)
          const mark = typeof body?.mark === 'string' ? body.mark.trim() : ''
          if (!SESSION_ID_RE.test(sessionId)) { sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return }
          if (cardKey === '') { sendJson(res, 400, { ok: false, error: 'invalid-card-key' }); return }
          if (mark !== 'read') { sendJson(res, 400, { ok: false, error: 'invalid-mark' }); return }
          const already = (readState[sessionId] ?? []).includes(cardKey)
          const count = addReadCardKey(readState, sessionId, cardKey)
          if (!already) await persistReadState()
          sendJson(res, 200, { ok: true, sessionId, cardKey, read: true, unchanged: already, count, updatedAt: readUpdatedAt })
          return
        }
        const query = parseSecretaryRequestQuery(String(req.url ?? ''))
        const askedId = query.requestedId !== '' ? query.requestedId : (state?.sessionId ?? '')
        if (askedId === '' || !SESSION_ID_RE.test(askedId)) {
          sendJson(res, 400, { ok: false, error: 'invalid-session-id' })
          return
        }
        if (method === 'GET' || method === 'HEAD') {
          const cards = readState[askedId] ?? []
          sendJson(res, 200, { ok: true, sessionId: askedId, cards, count: cards.length, updatedAt: readUpdatedAt })
          return
        }
        if (method === 'DELETE') {
          const had = Array.isArray(readState[askedId])
          delete readState[askedId]
          if (had) await persistReadState()
          sendJson(res, 200, { ok: true, sessionId: askedId, cards: [], count: 0, cleared: had })
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, DELETE' })
        res.end()
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) })
      }
    },
  })

  // ── 卡片引用登记（未读红点那套 store 的同一形状：文件 + chain，不写会话日志）────
  const quoteFile = join(profileDir(ctx), QUOTE_STATE_FILENAME)
  const quoteState: Record<string, SecretaryQuoteRecord> = (() => {
    try {
        return normalizeSecretaryQuoteState(JSON.parse(readFileSync(quoteFile, 'utf8')).quoteBySession)
    } catch {
      return {}
    }
  })()
  let quoteUpdatedAt = ''
  // 引用登记（第 4 项）：真实用户消息那轮把引用吃掉 → 那一轮 turn/end 清掉这条引用。
  // 系统通知那轮不许吃掉（用户可能刚按了引用、CU 结果随后才送来）。
  let quoteConsumedTurn = false

  const persistQuoteState = (): Promise<void> => {
    const task = async (): Promise<void> => {
      mkdirSync(dirname(quoteFile), { recursive: true })
      const tmp = `${quoteFile}.${process.pid}.tmp`
      const payload = { version: 1, updatedAt: new Date().toISOString(), quoteBySession: quoteState }
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, quoteFile)
      quoteUpdatedAt = payload.updatedAt
    }
    const run = chain.then(task, task)
    chain = run.then(() => void 0, () => void 0)
    return run
  }

  const liveQuote = (sessionId: string): SecretaryQuoteRecord | null => {
    const record = quoteState[sessionId]
    if (record === undefined) return null
    if (!quoteAlive(record)) {
      delete quoteState[sessionId]
      void persistQuoteState().catch(() => void 0)
      return null
    }
    return record
  }

  webServer.register({
    kind: 'exact',
    path: ASSISTANT_SECRETARY_QUOTE_ROUTE,
    handler: async (req: any, res: any) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      try {
        if (method === 'POST' || method === 'PUT') {
          const body = await readJsonBody(req, QUOTE_MAX_BODY_BYTES)
          if (body?.__tooLarge === true) { sendJson(res, 413, { ok: false, error: 'too-large' }); return }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!SESSION_ID_RE.test(sessionId)) { sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return }
          const mark = typeof body?.mark === 'string' ? body.mark.trim() : ''
          if (mark === 'clear') {
            const had = quoteState[sessionId] !== undefined
            delete quoteState[sessionId]
            quoteConsumedTurn = false
            if (had) await persistQuoteState()
            sendJson(res, 200, { ok: true, sessionId, quote: null, cleared: had, updatedAt: quoteUpdatedAt })
            return
          }
          if (mark !== 'quote') { sendJson(res, 400, { ok: false, error: 'invalid-mark' }); return }
          const record = normalizeQuoteRecord({
            cardKey: body?.cardKey,
            kind: body?.kind,
            turnNo: body?.turnNo,
            preview: body?.preview,
            body: body?.body,
            attachments: body?.attachments,
            refSessionIds: body?.refSessionIds,
            updatedAt: typeof body?.updatedAt === 'number' ? body.updatedAt : Date.now(),
          })
          if (record === null) { sendJson(res, 400, { ok: false, error: 'invalid-quote' }); return }
          const previous = quoteState[sessionId]
          if (previous !== undefined && previous.cardKey === record.cardKey && previous.updatedAt === record.updatedAt) {
            sendJson(res, 200, { ok: true, sessionId, quote: record, unchanged: true, updatedAt: quoteUpdatedAt })
            return
          }
          quoteState[sessionId] = record
          quoteConsumedTurn = false
          await persistQuoteState()
          sendJson(res, 200, { ok: true, sessionId, quote: record, unchanged: false, updatedAt: quoteUpdatedAt })
          return
        }
        const query = parseSecretaryRequestQuery(String(req.url ?? ''))
        const askedId = query.requestedId !== '' ? query.requestedId : (state?.sessionId ?? '')
        if (askedId === '' || !SESSION_ID_RE.test(askedId)) {
          sendJson(res, 400, { ok: false, error: 'invalid-session-id' })
          return
        }
        if (method === 'GET' || method === 'HEAD') {
          sendJson(res, 200, { ok: true, sessionId: askedId, quote: liveQuote(askedId), ttlMs: QUOTE_TTL_MS, updatedAt: quoteUpdatedAt })
          return
        }
        if (method === 'DELETE') {
          const had = quoteState[askedId] !== undefined
          delete quoteState[askedId]
          if (had) await persistQuoteState()
          sendJson(res, 200, { ok: true, sessionId: askedId, quote: null, cleared: had })
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, DELETE' })
        res.end()
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) })
      }
    },
  })

  // 「系统通知回合」标记：由 agent/pre-step 里声明的那批消息判定，turn/end 或下一批真实
  // 用户消息到达时清掉；10 分钟兜底过期，绝不让一次异常把秘书的工具永久锁死。
  let noticeTurn = false
  let noticeTurnAt = 0


  const NOTICE_TURN_TTL_MS = 10 * 60 * 1000
  const noticeTurnActive = (): boolean => {
    if (!noticeTurn) return false
    if (Date.now() - noticeTurnAt > NOTICE_TURN_TTL_MS) { noticeTurn = false; return false }
    return true
  }
  let offNoticeReset: (() => void) | undefined
  try {
    const off = ctx.on?.('session/event', (session: any, event: any) => {
      if (String(session?.id ?? '') !== activeSessionId) return
      const type = String(event?.type ?? '')
      if (type === 'turn/end') {
        noticeTurn = false
        noticeTurnAt = 0
        // 引用吃掉口径：这一轮真的把某条引用喂过了（真实用户消息），就该收掉；没吃掉的不收
        if (quoteConsumedTurn) {
          quoteConsumedTurn = false
          if (quoteState[activeSessionId] !== undefined) {
            delete quoteState[activeSessionId]
            void persistQuoteState().catch(() => void 0)
          }
        }
      }
    })
    if (typeof off === 'function') offNoticeReset = off
  } catch {
    offNoticeReset = undefined
  }

  // 只拦秘书会话。其它会话/子代理完全不受影响。
  let offToolGate: (() => void) | undefined
  try {
    offToolGate = ctx.on?.('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
      if (activeSessionId === '') return next()
      const caller = String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? '')
      if (caller !== activeSessionId) return next()
      const tool = String(exec?.name ?? '')
      // 系统通知回合：动手类工具全禁（写文件/终端/屏幕/子代理/再派活），但纯读类与目标类放行——
      // 通知里的原文被截断时，读报告文件是这一轮唯一的补救办法，且读不写不跑，造不成回路。
      if (noticeTurnActive() && !secretaryNoticeTurnAllowed(tool)) {
        return {
          kind: 'deny',
          reason: '这一轮是插件自动送来的「电脑操作会话完成／失败」系统通知，不是用户的要求：动手类工具已禁用（写文件、编辑、终端、直接操作屏幕、派子代理、再派活都不行）。立目标也一样被拒（create_goal/update_goal/get_goal）——目标由 Computer Use 会话自己立、自己完成，这一轮秘书不做目标管理；确实还要动手就用 secretary_dispatch 改派。完成就把那条 Computer Use 会话的结果完整汇报给用户——先给结论，自己整理成简短的中文回复，保留文件名、大小、哈希、数字、提交号、判据、结论、待办等硬事实；不许整大段原封不动照抄、不许照抄表格与长路径、不许重复通知原文；原文被裁时可以用 read/glob/grep 按通知里的落盘路径把报告文件整段读回来再整理；失败轮就照实说是「派活失败／这一轮失败」，把错误码与错误原文完整汇报给用户并提示可以改派（新建一条 Computer Use 会话或换个项目目录），不许说成已派活／已完成。',
        }
      }
      if (!secretaryToolDenied(tool)) return next()
      return {
        kind: 'deny',
        reason: `个人秘书只读闸已拒绝 ${tool || '未知工具'}（写文件/编辑/终端/直接操作屏幕/派子代理不能在秘书会话执行；读文件 read/glob/grep 与只读联网 web_search/web_fetch 是放行的；create_goal / update_goal / get_goal 已被禁用——目标由 Computer Use 会话自己立、自己完成，秘书请用 secretary_dispatch 派活，不要自己建目标）。这不是收工理由：必须立即调用 secretary_dispatch，已有项目用 kind=existing + cwd，没有项目用 kind=new-folder；派活成功后照实回报回执文案——「已派活（…已确认在跑）」才是真接上了话，「已入队（未确认在跑）」不许说成已派活。`,
      }
    })
  } catch {
    offToolGate = undefined
  }

  // 「发送时的权限闸」+ 「引用卡正文拼进用户消息本体」（2026-11-25 第 3 次修法）：
  //   - 权限：标准会话页的发送由宿主处理，插件不能像以前那样在组件里拦消息，所以在**每一轮开始前**
  //     （agent/pre-step）确认这条会话真的还在只读档：读得到策略且确实 read-only → 放行；读得到策略
  //     但不是 read-only → 拦下这一轮并给人话原因；宿主没有 sandboxPolicy 服务 → 放行并告警一次。
  //   - 引用：这是宿主唯一合法的「改这一轮用户消息」的点——`agent/pre-step` 把这批被 claim 的消息
  //     交出来，返回的 decision.messages 会被原样 append 成 user/message（宿主 asar
  //     `dsh-agent-loop/lib/index.js:873-880`），所以在这里把被引用卡的正文拼到最后一条真实用户消息
  //     的末尾 = 真拼进本体，而不是再往系统提示里塞一段（10250 段已在本次修法里撤掉）。
  let offStepGate: (() => void) | undefined
  let warnedNoPolicy = false
  try {
    offStepGate = ctx.on?.('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
      if (activeSessionId === '') return next()
      const session = payload?.agent?.session ?? payload?.session ?? null
      const sessionId = String(session?.id ?? '')
      if (sessionId !== activeSessionId) return next()
      // 这一批被 claim 的消息里有没有系统通知：有 → 本轮工具全禁；有真实用户消息 → 解除。
      const claimed = Array.isArray(payload?.messages) ? payload.messages : []
      if (claimed.length > 0) {
        const notice = claimed.some((message: any) => isNoticeMessageId(message?.id))
        noticeTurn = notice
        noticeTurnAt = notice ? Date.now() : 0
        // 引用吃掉：真实用户消息（不是插件送进来的通知）这一轮确实接上了那张卡 → 本轮 turn/end 收掉引用
        if (!notice && quoteState[activeSessionId] !== undefined) quoteConsumedTurn = true
      }
      let mode = ''
      try {
        const policy = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
        const resolved = policy && typeof policy.resolve === 'function' ? policy.resolve({ session }) : null
        mode = String(resolved?.mode ?? '')
      } catch {
        mode = ''
      }
      if (mode === '') {
        if (!warnedNoPolicy) {
          warnedNoPolicy = true
          ctx?.logger?.warn?.('[dsh-assistant] 读不到 sandboxPolicy：秘书会话的只读确认这一轮跳过（不会因此锁死）')
        }
      } else if (!(mode === 'read-only' || mode === 'readonly')) {
        return {
          kind: 'deny',
          reason: `个人秘书会话没在只读档（当前 ${mode}），这条消息先拦下了。后台会继续把它切回「仅可查看」，确认后再发即可。`,
        }
      }
      const decision = await next()
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
      // 门与 1783/1791 完全同源：只喂固定秘书会话、过期即清并落盘、真实用户消息那轮 turn/end 一起收掉。
      const record = quoteState[sessionId]
      if (record === undefined) return decision
      if (!quoteAlive(record)) {
        delete quoteState[sessionId]
        void persistQuoteState().catch(() => void 0)
        return decision
      }
      const { messages: splicedMessages, spliced } = spliceQuoteIntoUserMessage(decision.messages, record)
      if (!spliced) return decision
      return { ...decision, messages: splicedMessages }
    })
  } catch {
    offStepGate = undefined
  }

  // 朗读友好输出规范（2026-11-21）：秘书每条回复都会渲染成卡片并被微软 TTS 朗读，
  // 所以单独加一段表达约束。只对本会话生效，其它会话一个字都不多。
  let offSpeechStyle: (() => void) | undefined
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      offSpeechStyle = systemPrompt.section({
        name: 'assistant:secretary-speech-style',
        order: 1780, // 派活规则段（1790）之前：先定表达，再谈派活
        text: (context: any) => {
          const sessionId = String(context?.agent?.session?.id ?? '')
          if (sessionId === '' || sessionId !== activeSessionId) return ''
          return SECRETARY_SPEECH_STYLE_TEXT
        },
      })
    }
  } catch {
    offSpeechStyle = undefined
  }

  // 语音输入提示（2026-11-22 用户新需求）：用户多用语音转文字，常带同音字/断句问题。
  // 单独一段，order 1785 紧贴派活分层段（1790）之前，不并入朗读规范、不改派活规则原文。
  let offVoiceInput: (() => void) | undefined
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      offVoiceInput = systemPrompt.section({
        name: 'assistant:secretary-voice-input',
        order: 1785,
        text: (context: any) => {
          const sessionId = String(context?.agent?.session?.id ?? '')
          if (sessionId === '' || sessionId !== activeSessionId) return ''
          return SECRETARY_VOICE_INPUT_TEXT
        },
      })
    }
  } catch {
    offVoiceInput = undefined
  }

  // 卡片引用注入段（2026-11-23 第 4 项需求）：用户按了「引用」以后，把那张卡的种类/轮次/摘录/
  // 会话 id 喂给秘书模型，让下一条消息接得上。只喂秘书会话；引用没过期前只喂这一轮。
  let offQuoteSection: (() => void) | undefined
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx?.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      offQuoteSection = systemPrompt.section({
        name: 'assistant:secretary-card-quote',
        order: SECRETARY_QUOTE_SECTION_ORDER, // 1785（语音输入）与 1790（派活分层）之间，不并入任何既有段落
        text: (context: any) => {
          const sessionId = String(context?.agent?.session?.id ?? '')
          if (sessionId === '' || sessionId !== activeSessionId) return ''
          const record = quoteState[sessionId]
          if (record === undefined) return ''
          if (!quoteAlive(record)) {
            delete quoteState[sessionId]
            void persistQuoteState().catch(() => void 0)
            return ''
          }
          return secretaryQuoteInjectionText(record)
        },
      })
    }
  } catch {
    offQuoteSection = undefined
  }

  // 引用硬锚点段（2026-11-25 修法）：与 1783 登记段同一条引用、同一道门（只喂固定秘书会话、
  // 过期即清、真实用户消息那轮 turn/end 一起收掉），但贴在派活分层(1790)之后——
  // 最靠近这条用户消息，用硬要求把指代钉在被引用的那张卡上。
  let offQuoteAnchorSection: (() => void) | undefined
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx?.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      offQuoteAnchorSection = systemPrompt.section({
        name: 'assistant:secretary-card-quote-anchor',
        order: SECRETARY_QUOTE_ANCHOR_SECTION_ORDER, // 派活分层(1790)之后，最靠近这条用户消息
        text: (context: any) => {
          const sessionId = String(context?.agent?.session?.id ?? '')
          if (sessionId === '' || sessionId !== activeSessionId) return ''
          const record = quoteState[sessionId]
          if (record === undefined) return ''
          if (!quoteAlive(record)) {
            delete quoteState[sessionId]
            void persistQuoteState().catch(() => void 0)
            return ''
          }
          return secretaryQuoteAnchorText(record)
        },
      })
    }
  } catch {
    offQuoteAnchorSection = undefined
  }

  // 引用「结构化卡块」段（2026-11-25 第 2 次修法的系统提示段）已在本轮撤掉：
  // 17:51 那轮现场证明「10250 排在整段系统提示最末」仍不服从（模型答成最近那条毕设任务），
  // 卡正文改由 agent/pre-step 直接拼进本轮用户消息本体（spliceQuoteIntoUserMessage）。
  // 同一张卡只留一个载体，避免两套措辞互相打架。

  return () => {
    try { offToolGate?.() } catch {}
    try { offNoticeReset?.() } catch {}
    try { offStepGate?.() } catch {}
    try { if (typeof offSpeechStyle === 'function') offSpeechStyle() } catch {}
    try { if (typeof offVoiceInput === 'function') offVoiceInput() } catch {}
    try { if (typeof offQuoteSection === 'function') offQuoteSection() } catch {}
    try { if (typeof offQuoteAnchorSection === 'function') offQuoteAnchorSection() } catch {}
    try { routes.dispose() } catch {}
  }
}

/**
 * 秘书会话「语音输入」提示段（系统提示段落正文，最多三行）。
 * 语义：内部纠同音、不改写原话、不因错别字失败/反问、歧义影响执行才最短确认；
 * 派活 task 照抄原话、用户卡与附件一律原文、改读要在正文说明。
 * 位置：紧接在派活分层段（1790）之前，由 1785 号段落挂载。
 */
export const SECRETARY_VOICE_INPUT_TEXT = [
  '# 语音输入（个人秘书）',
  '一、本页输入多是用户语音转文字：可能带同音字或相近音的错别字、断句不当、缺标点。按语义理解，同音纠正在你内部完成；不许悄悄改写用户原话，不许因一个错别字判任务失败或反问；只有歧义确实影响执行时，才用最短一句确认。',
  '二、派活时 secretary_dispatch 的 task 字段照抄用户原话，可在其后加括号注明「语音输入，可能有同音字误」，但不得替换关键词；秘书页用户卡（冷蓝那张）与附件内容一律显示原文、不显示纠正版本，附件一律不改写；若你在回复里改读了某个词，必须在正文说清改了哪个词。',
].join('\n')

/**
 * 秘书会话「卡片 + 朗读」输出规范（系统提示段落正文）。
 * 数字口径（2026-11-24 用户明确批准改档）：一律保留阿拉伯写法（8 到 14 摄氏度、27458 字符、2617×1215），禁止转写成汉字数字。
 * 简洁硬约束（2026-11-24 用户原话「太长太累、要结构清晰、结论先行、CU 回执先自己整理再回」）：
 * 第五、六、七条把「简洁」写成可执行口径——第一句直接回答、默认 3 到 5 句（展开最多 5 个要点、一行一个）、
 * 正文约 300 字上限（超了就是没整理）、禁止照抄/整段转述回执、先判断用户问的是哪件事再针对性回答。
 * 第八条（2026-11-26 附件需求）：交付文件或图片时在正文最后单独一行写 `[[attach:绝对路径|显示名]]`，
 * 正文里不再贴裸路径；卡片据此渲染缩略图/附件条（渲染见 SecretaryReplyCard 的附件区）。
 */
export const SECRETARY_SPEECH_STYLE_TEXT = [
  '# 输出与朗读（个人秘书）',
  '你的每条回复都会：① 在会话页渲染成一张卡片；② 由微软 TTS 自动朗读。请严格遵守：',
  '一、口语化短句，先给结论；只用正常中文标点；不要用 markdown 符号、表格、列表符号、表情符号、代码块。',
  '二、数字一律保留阿拉伯写法（这一条 2026-11-24 用户明确批准改口径）：字符数、token 数、字节数、尺寸与比例都照原样写，如 27458 字符、49915 token、9761427 字节、2617×1215；带单位的也照阿拉伯写（温度写 8 到 14 摄氏度、距离写 3 公里、重量写 2 公斤、时间写 8:12）；禁止把这些数转写成汉字数字；英文缩写尽量换成读得出的中文说法，必须保留时照原文写（如车次 G1545）。',
  '三、引用某条会话时用 [[session:会话id|会话标题]] 一行一个（会话 id 从上下文里取），卡片会把它渲染成可点击的引用块。',
  '四、不许整大段原封不动照抄 Computer Use 会话的回复，也不许整段转述：先给结论，自己整理成简短的中文回复，只保留关键硬事实（文件名、大小、哈希、数字、提交号、判据、结论、待办）；禁止照抄表格与长路径，禁止把回执里的日志原文堆进回复，禁止把通知原文再抄一遍。必须先拿到完整内容再整理——原文被裁就按通知里的落盘路径用 read 整段读回，不许只依据被裁的摘录作答。',
  '五、结论先行是硬口径：开头第一句直接回答用户这条消息问的那件事，答案先落地；不许铺垫、不许先复述用户的问题再回答（「好的」「关于你说的这件事」这类开场白不算第一句）。',
  '六、长度硬上限：默认 3 到 5 句讲完；确需展开时最多 5 个要点，每个要点独占一行，不把几个要点揉进一个长段；一次回复正文不超过约 300 字，超过 300 字就是没整理，必须压回 300 字以内再发。',
  '七、对准任务再回答：回复前先判断用户这条消息问的是哪个任务，只针对那件事给结论，不堆无关细节，不把别的任务的进展塞进这条回复。',
  '八、交付文件或图片时（Word、Excel、PPT、PDF、图片、压缩包等），在正文最后单独一行写 [[attach:绝对路径|显示名]]，一行一个，路径写本机绝对路径；正文里不要再贴裸路径，卡片会在正文下方把它渲染成缩略图或附件条，点开就是那个文件。没有交付物就不写这一行。',
].join('\n')

/* ---------- v4 日志修复（纯函数，不依赖宿主实例） ---------- */

type LogEventRecord = Record<string, any>

const REFERENCE_ARRAY_KEYS = new Set(['sourceEventSeqs', 'messageSeqs'])
const REFERENCE_SCALAR_KEYS = new Set(['sourceEventSeq', 'headerSeq'])
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

interface SecretaryLogRepairResult {
  lines: string[]
  droppedOldSeqs: number[]
  staleReferences: number
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseLogEventLine(line: string): LogEventRecord | null {
  const raw = String(line ?? '')
  if (raw.trim() === '') return null
  try {
    const event = JSON.parse(raw) as unknown
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return null
    return event as LogEventRecord
  } catch {
    return null
  }
}

function rewriteEventReferences(event: LogEventRecord, oldToNew: Map<number, number>): { staleReferences: number } {
  let staleReferences = 0
  const seen = new WeakSet<object>()

  const rewriteArray = (value: unknown[], key: string): unknown[] => {
    const out: unknown[] = []
    for (const item of value) {
      if (REFERENCE_ARRAY_KEYS.has(key) && typeof item === 'number' && Number.isFinite(item)) {
        const mapped = oldToNew.get(item)
        if (mapped === undefined) { staleReferences += 1; continue }
        out.push(mapped)
      } else {
        out.push(visit(item, key))
      }
    }
    if (REFERENCE_ARRAY_KEYS.has(key)) {
      const numbers = out.filter((item): item is number => typeof item === 'number')
      return Array.from(new Set(numbers)).sort((a, b) => a - b)
    }
    return out
  }

  const visit = (value: unknown, parentKey = ''): unknown => {
    if (Array.isArray(value)) return rewriteArray(value, parentKey)
    if (value === null || typeof value !== 'object' || seen.has(value)) return value
    seen.add(value)
    const record = value as LogEventRecord
    for (const key of Object.keys(record)) {
      if (REFERENCE_ARRAY_KEYS.has(key) && Array.isArray(record[key])) {
        record[key] = rewriteArray(record[key] as unknown[], key)
      } else if (REFERENCE_SCALAR_KEYS.has(key) && typeof record[key] === 'number') {
        const mapped = oldToNew.get(record[key])
        if (mapped === undefined) staleReferences += 1
        else record[key] = mapped
      } else {
        record[key] = visit(record[key], key)
      }
    }
    return record
  }

  visit(event, '')
  return { staleReferences }
}

/** 修复半截合成轮留下的坏状态：跳过不合法的轮/步开合事件，保留合法真实轮，并重编号与重映射引用。 */
export function repairSecretaryLogLines(input: readonly string[]): SecretaryLogRepairResult {
  const lines = Array.from(input ?? [], (line) => String(line ?? ''))
  const header = lines[0] ?? ''
  const kept: LogEventRecord[] = []
  const droppedOldSeqs: number[] = []
  const oldToNew = new Map<number, number>()
  let staleReferences = 0
  let openTurn = 0
  let openStep = 0
  let nextTurn = 1
  let nextStep = 1

  for (const raw of lines.slice(1)) {
    const event = parseLogEventLine(raw)
    if (event === null) {
      const seq = Number(event?.seq)
      if (Number.isFinite(seq)) droppedOldSeqs.push(seq)
      continue
    }

    const data = (event.data ?? {}) as LogEventRecord
    const type = String(event.type ?? '')
    const turn = Number(data.turn)
    const step = Number(data.step)
    let keep = true

    if (type === 'turn/start') {
      if (openTurn !== 0 || !isPositiveNumber(turn) || turn !== nextTurn) keep = false
      else {
        openTurn = turn
        openStep = 0
        nextStep = 1
      }
    } else if (type === 'step/start') {
      if (openTurn === 0 || openStep !== 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || step !== nextStep) keep = false
      else openStep = step
    } else if (type === 'step/end') {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || openStep !== step) keep = false
      else {
        openStep = 0
        nextStep = step + 1
      }
    } else if (type === 'turn/end') {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || openStep !== 0) keep = false
      else {
        openTurn = 0
        nextTurn = turn + 1
        nextStep = 1
      }
    } else if (type === 'assistant/message' || type === 'assistant/attempt' || type === 'tool/call' || type === 'tool/result') {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || step !== openStep) keep = false
    } else if (isPositiveNumber(turn) && turn !== openTurn) {
      keep = false
    }

    if (!keep) {
      const oldSeq = Number(event.seq)
      if (Number.isFinite(oldSeq)) droppedOldSeqs.push(oldSeq)
      continue
    }

    const oldSeq = Number(event.seq)
    const newSeq = kept.length
    if (Number.isFinite(oldSeq)) oldToNew.set(oldSeq, newSeq)
    kept.push(event)
  }

  const serialized = kept.map((event, index) => {
    staleReferences += rewriteEventReferences(event, oldToNew).staleReferences
    event.seq = index
    return JSON.stringify(event)
  })

  return { lines: [header, ...serialized], droppedOldSeqs, staleReferences }
}

export function repairSecretaryLogText(text: string): string {
  const raw = String(text ?? '')
  const result = repairSecretaryLogLines(raw.split(/\r?\n/))
  return `${result.lines.join('\n')}\n`
}

export function compressSessionLogText(text: string): Buffer {
  const zlib2 = zlib as any
  if (typeof zlib2.zstdCompressSync !== 'function') throw new Error('zstdCompressSync not available')
  return Buffer.from(zlib2.zstdCompressSync(Buffer.from(String(text ?? ''), 'utf8')))
}

export function decompressSessionLogBytes(data: Uint8Array | Buffer): string {
  const zlib2 = zlib as any
  if (typeof zlib2.zstdDecompressSync !== 'function') throw new Error('zstdDecompressSync not available')
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const first = buffer.indexOf(ZSTD_MAGIC)
  if (first === -1) {
    if (buffer.length === 0) return ''
    return Buffer.from(zlib2.zstdDecompressSync(buffer)).toString('utf8')
  }
  const chunks: string[] = []
  for (let cursor = first; cursor < buffer.length; ) {
    const next = buffer.indexOf(ZSTD_MAGIC, cursor + ZSTD_MAGIC.length)
    const end = next === -1 ? buffer.length : next
    chunks.push(Buffer.from(zlib2.zstdDecompressSync(buffer.subarray(cursor, end))).toString('utf8'))
    cursor = end
  }
  return chunks.join('')
}

/** 单测入口：不启动宿主也能验路由、归一与工具闸。 */
export const assistantSecretaryTestSurface = {
  ASSISTANT_SECRETARY_ROUTE,
  ASSISTANT_SECRETARY_READ_ROUTE,
  READ_MAX_KEYS,
  normalizeReadCardKey,
  normalizeReadCardKeys,
  normalizeSecretaryReadState,
  addReadCardKey,
  SECRETARY_DISPATCH_POLICY,
  normalizeSecretaryState,
  secretaryToolDenied,
  secretaryNoticeTurnAllowed,
  registerAssistantSecretary,
  secretarySessionRef,
  registerNoticeMessageId,
  isNoticeMessageId,
  clearNoticeMessageIds,
  SECRETARY_SPEECH_STYLE_TEXT,
  SECRETARY_VOICE_INPUT_TEXT,
  repairSecretaryLogLines,
  repairSecretaryLogText,
  compressSessionLogText,
  decompressSessionLogBytes,
  parseSecretaryRequestQuery,
  // 更换会话（控制室卡片按钮）这一块的离线测试入口
  ASSISTANT_SECRETARY_SESSIONS_ROUTE,
  SECRETARY_SESSIONS_DEFAULT_LIMIT,
  SECRETARY_SESSIONS_MAX_LIMIT,
  normalizeBindableSessionRow,
  titleFromProjectionBlock,
  collectHostSessionRows,
  parseSecretarySessionsQuery,
  pickBindableSessions,
  markBoundSessions,
  secretaryStateMatchesWrite,
  ASSISTANT_SECRETARY_QUOTE_ROUTE,
  SECRETARY_QUOTE_SECTION_ORDER,
  SECRETARY_QUOTE_ANCHOR_SECTION_ORDER,
  QUOTE_MESSAGE_BLOCK_OPEN,
  spliceQuoteIntoUserMessage,
  QUOTE_TTL_MS,
  QUOTE_PREVIEW_MAX_CHARS,
  QUOTE_BODY_MAX_CHARS,
  QUOTE_ATTACHMENT_MAX,
  QUOTE_CARD_KINDS,
  normalizeQuoteCardKey,
  normalizeQuoteSessionIds,
  normalizeQuoteAttachments,
  normalizeQuoteBody,
  normalizeQuoteRecord,
  quoteAlive,
  normalizeSecretaryQuoteState,
  secretaryQuoteInjectionText,
  secretaryQuoteAnchorText,
  secretaryQuoteCardBlockText,
}
