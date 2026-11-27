/**
 * 个人秘书「更换会话」的客户端半部（控制室卡片上的按钮 → 会话选择面板）。
 *
 * 纯逻辑：无 react / 无 DOM / 无宿主依赖，node 单测直接跑（scripts/test-secretary-session-switch.mjs）。
 * 路由本身（GET 列候选 / POST 定绑定）由宿主侧 assistant-secretary.ts 提供，这里只负责
 * 将「宿主答的话」收成面板能显示的行，以及宿主答不上时的降级口径。
 *
 * 三条口径（2026-11-27）：
 *   1. 候选一律来自宿主会话表（持久化清单 + 活会话表），客户端快照只在宿主答不上时兜底；
 *   2. 当前绑定的那条**保留在列表里、标记「当前」，并且不可再选**（用户要的就是「换掉它」，
 *      重选同一条等于没动，宿主那边也有 unchanged 去抖，不该白写一次盘）；
 *   3. 坏 id 一律不进候选（id 形状不对 / 宿主说已归档 / 宿主明确读不回来的那条由后端拒绝）。
 */

/** 宿主路由（与 src/assistant-secretary.ts 的 ASSISTANT_SECRETARY_SESSIONS_ROUTE 同一个值）。 */
export const SECRETARY_SESSIONS_ROUTE = '/api/assistant/secretary/sessions'
/** 面板一次最多显示多少条（宿主也是这个上限口径；手机别指望一次刷两千行）。 */
export const SWITCH_PANEL_LIMIT = 200
/** 搜索框里空着 = 不筛选；超过这个长度只吃前 80 字符（与后端同一口径）。 */
export const SWITCH_QUERY_MAX = 80

/** 面板一行需要的字段。 */
export type SecretarySwitchRow = {
  id: string
  title: string
  updatedAt: number
  cwd: string
  /** 当前秘书绑定的那条 */
  bound: boolean
  /** 宿主说这条此刻挂在内存里 */
  live?: boolean
}

/** 宿主列候选的答复形状（宿主答不上时整个是 null，调用方降级用本地快照）。 */
export interface SecretarySwitchCandidates {
  current: string
  rows: SecretarySwitchRow[]
  source: string
  truncated: boolean
}

/** 换绑定的结果：`ok=false` 时 `sessionId` 是宿主当前真正挂着的那条（本地缓存不该跟着动）。 */
export interface SecretarySwitchBindResult {
  ok: boolean
  sessionId: string
  reason: string
  unchanged?: boolean
}

/** 归一一行候选（宿主答的形状不对就整条丢，别拿一条选不了的行糊在面板上）。 */
export function normalizeSwitchRow(raw: unknown, currentId = ''): SecretarySwitchRow | null {
  const record = raw as Record<string, unknown> | null
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  const id = String(record.sessionId ?? record.id ?? '').trim()
  if (id === '' || !/^[A-Za-z0-9._:-]{1,256}$/.test(id)) return null
  const titleRaw = typeof record.title === 'string' ? record.title : ''
  const cwdRaw = typeof record.cwd === 'string' ? record.cwd : ''
  const stamp = Number(record.updatedAt ?? 0)
  const updatedAt = Number.isFinite(stamp) && stamp > 0 ? stamp : 0
  const row: SecretarySwitchRow = {
    id,
    title: titleRaw.replace(/\s+/g, ' ').trim() || id,
    updatedAt,
    cwd: cwdRaw.slice(0, 300),
    bound: id === String(currentId ?? '').trim(),
  }
  if (record.bound === true) row.bound = true
  if (record.live === true) row.live = true
  return row
}

/**
 * 宿主 GET 响应 → 面板行。
 * 当前绑定的那条一定留着（哪怕它被 limit 截掉了），排序按最近更新倒序、时间未知的排最后。
 */
export function switchRowsFromResponse(body: unknown, currentId = ''): SecretarySwitchRow[] {
  const data = body as Record<string, unknown> | null
  if (data === null || typeof data !== 'object' || !Array.isArray(data.items)) return []
  const limit = Number(data.limit) > 0 ? Number(data.limit) : SWITCH_PANEL_LIMIT
  const asked = String(currentId ?? '').trim() !== '' ? String(currentId).trim() : String(data.sessionId ?? '').trim()
  const rows: SecretarySwitchRow[] = []
  for (const item of data.items) {
    const normalized = normalizeSwitchRow(item, asked)
    if (normalized === null) continue
    if (item !== null && typeof item === 'object' && (item as Record<string, unknown>).archived === true) continue
    rows.push(normalized)
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  const capped = rows.slice(0, limit)
  const bound = rows.find((row) => row.bound)
  if (bound !== undefined && !capped.includes(bound)) capped.unshift(bound)
  return capped
}

/** 本地即时筛选（宿主还没答话时也先让用户看得见东西）：标题 / id / 目录，不分大小写。 */
export function filterSwitchRows(rows: readonly SecretarySwitchRow[], keyword: string): SecretarySwitchRow[] {
  const needle = String(keyword ?? '').replace(/\s+/g, ' ').trim().slice(0, SWITCH_QUERY_MAX).toLowerCase()
  const list = Array.from(rows ?? [])
  if (needle === '') return list
  return list.filter((row) => row.bound
    || row.title.toLowerCase().includes(needle)
    || row.id.toLowerCase().includes(needle)
    || row.cwd.toLowerCase().includes(needle))
}

/**
 * 行的**主标题**（2026-11-27 用户要求：以会话标题为主显示，id 只作次要信息）。
 * 宿主还没给出标题时 normalizeSwitchRow 会把 title 落成 id——这里把这种「标题就是 id」的行
 * 换成「未命名会话」占位，免得原始 id 又跑到主行位置上来。
 */
export function switchRowName(row: SecretarySwitchRow | null | undefined, untitled = '未命名会话'): string {
  const title = String(row?.title ?? '').replace(/\s+/g, ' ').trim()
  if (title === '' || title === String(row?.id ?? '')) return untitled
  return title
}

/**
 * 次要行里显示的会话 id 短名：`session-83bca3e3-bcd1-49f0-…` → `83bca3e3`。
 * 只用来「认人」（汇报、报错时对得上号），不占主行位置。
 */
export function shortSessionId(id: unknown): string {
  const raw = String(id ?? '').trim()
  if (raw === '') return ''
  const body = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  const head = body.split('-')[0] ?? ''
  return head !== '' ? head.slice(0, 8) : body.slice(0, 8)
}

/** 面板时间口径：刚刚 / N 分钟前 / N 小时前 / N 天前；没有时间戳就明说「时间未知」。 */
export function switchTimeText(updatedAt: unknown, now = Date.now()): string {
  const stamp = Number(updatedAt ?? 0)
  if (!Number.isFinite(stamp) || stamp <= 0) return '时间未知'
  const diff = Math.max(0, now - stamp)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/**
 * 页面侧会话列表快照里的一条标题（宿主投影行 title）。
 * 快照形状与本插件 cu-title-bold.ts 用的是同一套（实测）：byId[id].projectionValues.title /
 * byId[id].projections.values.title / displayTitle / title，值可能被 { val } / { value } 包一层。
 * 取不到、或取出来就是 id 本身 → 空串（调用方保留原样）。
 */
export function snapshotSessionTitle(byId: unknown, id: unknown): string {
  const sessionId = String(id ?? '').trim()
  if (sessionId === '' || byId === null || typeof byId !== 'object') return ''
  const entry = (byId as Record<string, any>)[sessionId]
  if (entry === null || entry === undefined || typeof entry !== 'object') return ''
  const candidates = [
    entry.projectionValues?.title,
    entry.projections?.values?.title,
    entry.projectionValues?.displayTitle,
    entry.displayTitle,
    entry.title,
    entry.header?.title,
  ]
  for (const candidate of candidates) {
    const raw = typeof candidate === 'string'
      ? candidate
      : (candidate !== null && typeof candidate === 'object' ? (candidate.val ?? candidate.value) : '')
    const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
    if (title !== '' && title !== sessionId) return title.slice(0, 160)
  }
  return ''
}

/**
 * 把页面快照里的标题补到「标题还是 id」的候选行上（宿主答复没带标题时的页面侧兜底：
 * 老宿主不重启也能显示标题，但能覆盖的范围只到本页快照里有的会话）。
 */
export function fillSwitchRowTitles(rows: readonly SecretarySwitchRow[], byId: unknown): SecretarySwitchRow[] {
  return Array.from(rows ?? []).map((row) => {
    if (row.title !== row.id) return row
    const title = snapshotSessionTitle(byId, row.id)
    return title === '' ? row : { ...row, title }
  })
}

/**
 * 降级口径（老宿主没这条路由 / 网络失败）：用控制室已经拿到的宿主会话快照造同一份形状的行。
 * 快照形状 = ctx.sessions.list.getSnapshot().byId（displayTitle / title / cwd / updatedAt）。
 * 已归档的（工作区快照里 archivedSessionIds）不进候选。
 */
export function rowsFromSessionSnapshot(
  byId: Record<string, any> | null | undefined,
  opts: { currentId?: string; archivedIds?: Iterable<string> | null; limit?: number } = {},
): SecretarySwitchRow[] {
  const asked = String(opts.currentId ?? '').trim()
  const archived = new Set(opts.archivedIds ? Array.from(opts.archivedIds).map(String) : [])
  const rows: SecretarySwitchRow[] = []
  for (const [id, entryRaw] of snapshotEntries(byId)) {
    const normalized = normalizeSwitchRow({
      sessionId: id,
      title: (entryRaw && (entryRaw.displayTitle || entryRaw.title)) || '',
      cwd: entryRaw?.cwd ?? '',
      updatedAt: Number(entryRaw?.updatedAt ?? 0),
    }, asked)
    if (normalized === null) continue
    if (archived.has(id)) continue
    if (entryRaw?.running === true) normalized.live = true
    rows.push(normalized)
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : SWITCH_PANEL_LIMIT
  const capped = rows.slice(0, limit)
  const bound = rows.find((row) => row.bound)
  if (bound !== undefined && !capped.includes(bound)) capped.unshift(bound)
  return capped
}

/** 快照形状不对（没下发 / 不是普通对象）就回空数组，异常一律不抛到渲染层。 */
function snapshotEntries(byId: unknown): [string, any][] {
  if (byId === null || byId === undefined || typeof byId !== 'object' || Array.isArray(byId)) return []
  try { return Object.entries(byId as Record<string, any>) } catch { return [] }
}
