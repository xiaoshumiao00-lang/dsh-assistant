// 手机会话列表的数据级截页：只减少交给宿主 WorkspaceBrowser 的行集合，
// 不改 sessions.list / workspaces.list 本体，也不改后端协议与排序动作。

export const SESSION_PAGE_SIZE = 20
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

const currentIdOf = (list) => Object.values(list?.byId ?? {})
  .find((row) => Number(row?.retainedBy?.mainView ?? 0) > 0)?.id

const orderByRecency = (ids, byId) => ids.flatMap((id) => {
  const row = byId[id]
  return row === undefined ? [] : [{ id, rank: Number(row.updatedAt) || 0 }]
}).sort((a, b) => a.rank !== b.rank ? b.rank - a.rank : (a.id < b.id ? -1 : 1)).map((row) => row.id)

// 与宿主 dsh-client-ui-workspace 的 reconcileManualOrder 同口径：已保存相对顺序优先，
// 新 pinned 在前，普通新行按 recency，归档垫底，普通 fork 紧跟其 source。
const reconcileManualOrder = (memberIds, savedOrder, byId, pinnedIds, archivedIds) => {
  const members = new Map(memberIds.map((id) => [id, id]))
  const included = new Set()
  const ordered = []
  for (const key of savedOrder ?? []) {
    const id = members.get(key)
    if (id === undefined || included.has(key)) continue
    ordered.push(id)
    included.add(key)
  }
  const archived = new Set(archivedIds)
  const pins = []
  for (const id of pinnedIds) {
    if (!members.has(id) || included.has(id) || archived.has(id) || byId[id] === undefined) continue
    pins.push(id)
    included.add(id)
  }
  const ordinary = []
  const archives = []
  for (const id of orderByRecency([...members.values()].filter((id) => !included.has(id)), byId)) {
    if (archived.has(id)) archives.push(id)
    else ordinary.push(id)
  }
  const result = [...pins, ...ordered, ...ordinary, ...archives]
  const pending = new Set(ordinary)
  const placeFork = (id) => {
    if (!pending.delete(id)) return
    const parentId = byId[id]?.parentId
    if (parentId === undefined || parentId === id || !result.includes(parentId)) return
    placeFork(parentId)
    result.splice(result.indexOf(id), 1)
    result.splice(result.indexOf(parentId), 0, id)
  }
  for (const id of [...ordinary].reverse()) placeFork(id)
  return result
}

/**
 * 生成当前视图的截页投影。visibleIds 始终是完整 orderedIds 的有序子序列；
 * 当前主面板 Session 若不在首 limit 内，只额外保留这一条（因此首屏最多 limit+1）。
 */
export function sessionPageModel(list, workspaceSnapshot, view = {}, requestedLimit = SESSION_PAGE_SIZE) {
  const byId = list?.byId ?? {}
  const current = currentIdOf(list)
  const pinnedIds = Array.isArray(workspaceSnapshot?.pinnedSessionIds) ? workspaceSnapshot.pinnedSessionIds : []
  const archivedIds = Array.isArray(workspaceSnapshot?.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : []
  const pinned = new Set(pinnedIds)
  const archived = new Set(archivedIds)
  const archivedFilter = view?.archivedFilter ?? 'default'
  const members = (Array.isArray(list?.ids) ? list.ids : []).filter((id) => {
    const row = byId[id]
    if (row === undefined || row.origin === 'subagent') return false
    return row.blank !== true || id === current
  })
  const base = view?.orderBy === 'manual'
    ? reconcileManualOrder(members, view?.sessionOrderByAccount?.[FLAT_SESSION_ORDER_KEY], byId, pinnedIds, archivedIds)
    : orderByRecency(members, byId)
  const blankFirst = current !== undefined && byId[current]?.blank === true
    ? [current, ...base.filter((id) => id !== current)]
    : [...base]
  const filtered = blankFirst.filter((id) => {
    if (archivedFilter === 'show') return true
    if (archivedFilter === 'only') return archived.has(id)
    return !archived.has(id)
  })
  // deriveFlat 最后还会做 blank → pinned → ordinary 的稳定分区；截页必须基于同一最终顺序。
  const orderedIds = [
    ...filtered.filter((id) => byId[id]?.blank === true),
    ...filtered.filter((id) => byId[id]?.blank !== true && !archived.has(id) && pinned.has(id)),
    ...filtered.filter((id) => byId[id]?.blank !== true && (archived.has(id) || !pinned.has(id))),
  ]
  const limit = Math.max(0, Math.floor(Number(requestedLimit) || 0))
  const allowed = new Set(orderedIds.slice(0, limit))
  if (current !== undefined && orderedIds.includes(current)) allowed.add(current)
  const visibleIds = orderedIds.filter((id) => allowed.has(id))
  const items = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : []
  return {
    list: { ...list, ids: (Array.isArray(list?.ids) ? list.ids : []).filter((id) => allowed.has(id)) },
    workspaces: {
      ...workspaceSnapshot,
      items: items.map((workspace) => ({
        ...workspace,
        sessionIds: (Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []).filter((id) => allowed.has(id)),
      })),
    },
    orderedIds,
    visibleIds,
    currentId: current,
    loaded: visibleIds.length,
    total: orderedIds.length,
    hasMore: visibleIds.length < orderedIds.length,
  }
}
