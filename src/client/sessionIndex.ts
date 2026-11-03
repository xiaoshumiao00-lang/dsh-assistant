import { folderKeyOf } from './sessionFolder.ts'
import { perfBump, perfNowMs, perfObserveMs } from './perfCounters.ts'

/**
 * 一份宿主会话快照的共享派生索引。
 * 控制室卡片、游离会话生命周期和侧栏提醒只读复用，禁止修改返回的 Map/Set/数组。
 */
export type SessionSnapshotIndex = {
  kidsByParent: Map<string, Set<string>>
  folderRows: { id: string; key: string }[]
  snapshotIds: string[]
  /** 目录键（小写） → folderRows 里那些会话的下标（保持快照原有顺序） */
  dirPositions: Map<string, number[]>
  /** 去重后的目录键；数量是「不同的项目目录」，远小于会话数 */
  dirKeys: string[]
}

const EMPTY_INDEX: SessionSnapshotIndex = {
  kidsByParent: new Map(),
  folderRows: [],
  snapshotIds: [],
  dirPositions: new Map(),
  dirKeys: [],
}

let cached: {
  snapshot: any
  byId: any
  subagentsByParent: any
  value: SessionSnapshotIndex
} | null = null

/** 宿主每次发布会话列表通知时先失效；即使旧宿主原地修改快照也不会读到旧索引。 */
export function invalidateSessionSnapshotIndex(): void {
  cached = null
}

/** 按快照身份缓存派生索引；宿主发布新快照（或替换内部表）时才重建。 */
export function sessionSnapshotIndexOf(snapshot: any): SessionSnapshotIndex {
  if (!snapshot) return EMPTY_INDEX
  const byId = snapshot.byId ?? {}
  const subagentsByParent = snapshot.subagentsByParent ?? {}
  if (cached?.snapshot === snapshot && cached.byId === byId && cached.subagentsByParent === subagentsByParent) {
    perfBump('idxHit')
    return cached.value
  }
  const startedAt = perfNowMs()

  const kidsByParent = new Map<string, Set<string>>()
  const addKid = (parent: unknown, child: unknown): void => {
    if (typeof parent !== 'string' || !parent || typeof child !== 'string' || !child) return
    let set = kidsByParent.get(parent)
    if (!set) { set = new Set<string>(); kidsByParent.set(parent, set) }
    set.add(child)
  }
  for (const [child, entry] of Object.entries<any>(byId)) addKid(entry?.parentId, child)
  for (const [parent, value] of Object.entries<any>(subagentsByParent)) {
    const rows = Array.isArray(value) ? value : (value?.entries ?? value?.items ?? [])
    if (Array.isArray(rows)) for (const child of rows) addKid(parent, child?.sessionId ?? child?.id)
  }

  const snapshotIds: string[] = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(byId)
  const folderRows: { id: string; key: string }[] = []
  const dirPositions = new Map<string, number[]>()
  for (const id of snapshotIds) {
    const entry = byId[id]
    if (!entry || entry.parentId || entry.origin === 'subagent') continue
    const key = folderKeyOf(entry.cwd)
    if (!key) continue
    const positions = dirPositions.get(key)
    const index = folderRows.length
    folderRows.push({ id, key })
    if (positions) positions.push(index)
    else dirPositions.set(key, [index])
  }

  const value: SessionSnapshotIndex = {
    kidsByParent,
    folderRows,
    snapshotIds,
    dirPositions,
    dirKeys: [...dirPositions.keys()],
  }
  cached = { snapshot, byId, subagentsByParent, value }
  perfBump('idxBuild')
  perfObserveMs('idxBuild', perfNowMs() - startedAt)
  return value
}

/**
 * 某个目录（含各子目录）下的会话 id，保持快照顺序。
 * 与 sessionFolder.ts 的 sessionsUnderFolder 同一判定口径（同一张派生索引里已过滤掉
 * 子代理与没有 cwd 的会话），但成本从「每个项目都扫一遍全部会话」变成「扫一遍不同的目录」。
 * 卡片组装与活动扫描每次都问十几个项目、每个项目一次全表过滤（会话 1,000+ 时就是
 * 每刷一次卡片多扫上万次），这一刀把工作量降到目录数级别，返回值与旧写法完全一致。
 */
export function sessionIdsUnderFolderOf(index: SessionSnapshotIndex, base: string): string[] {
  const baseKey = folderKeyOf(base)
  if (!baseKey) return []
  const hit = index.dirPositions.get(baseKey)
  let matched: number[] | null = null
  if (hit) matched = hit.slice()
  for (const key of index.dirKeys) {
    if (key === baseKey) continue
    if (!key.startsWith(baseKey + '/')) continue
    const positions = index.dirPositions.get(key)
    if (!positions) continue
    if (matched === null) matched = positions.slice()
    else for (const p of positions) matched.push(p)
  }
  if (matched === null || matched.length === 0) return []
  if (matched.length > 1) matched.sort((a, b) => a - b)
  return matched.map((p) => index.folderRows[p].id)
}
