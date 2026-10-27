import { normalizeFolderPath } from './sessionFolder.ts'

/**
 * 一份宿主会话快照的共享派生索引。
 * 控制室卡片、游离会话生命周期和侧栏提醒只读复用，禁止修改返回的 Map/Set/数组。
 */
export type SessionSnapshotIndex = {
  kidsByParent: Map<string, Set<string>>
  folderRows: { id: string; key: string }[]
  snapshotIds: string[]
}

const EMPTY_INDEX: SessionSnapshotIndex = {
  kidsByParent: new Map(),
  folderRows: [],
  snapshotIds: [],
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
    return cached.value
  }

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
  for (const id of snapshotIds) {
    const entry = byId[id]
    if (!entry || entry.parentId || entry.origin === 'subagent') continue
    const cwd = normalizeFolderPath(entry.cwd)
    if (cwd) folderRows.push({ id, key: cwd.toLowerCase() })
  }

  const value: SessionSnapshotIndex = { kidsByParent, folderRows, snapshotIds }
  cached = { snapshot, byId, subagentsByParent, value }
  return value
}
