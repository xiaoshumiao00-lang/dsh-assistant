/**
 * 会话面快照的极短 TTL 缓存。
 *
 * 为什么要缓存：卡片组装 / 提醒表 / 待决表 / 临时卡片判定各自都要读同一条会话的会话面
 * （`sessions.binding(sid).session.getSnapshot()`，宿主侧要投影整棵会话状态），
 * 一次宿主通知里同一个会话要读三四遍，再乘上同时挂着的工作台实例（侧栏工作台 + headless 数据宿主）。
 * 这一层把同一会话在一帧内的重复读并成一次；TTL 只有 100ms，
 * 待决 / 在跑 的真正变化仍由宿主订阅推出来（pendingInteractionsStore 与 sessions.list 通知），不会被压住。
 *
 * 纯模块（不读宿主状态）——`read` 由调用方注入，可离线单测。
 */

/** 缓存窗口（毫秒）：只跨「同一批渲染」，不跨轮通知。 */
export const FACE_SNAPSHOT_TTL_MS = 100

export type FaceSnapshotCache = {
  get(sid: string): any
  invalidate(sid: string): void
  invalidateAll(): void
  /** 测试与自检用 */
  cachedIds: () => string[]
}

/**
 * @param options.read - 真正的读法（宿主会话面快照；抛错一律按 null）。
 * @param options.now - 时钟注入（默认 Date.now）。
 * @param options.ttlMs - 窗口（默认 FACE_SNAPSHOT_TTL_MS）。
 */
export function createFaceSnapshotCache(options: {
  read: (sid: string) => any
  now?: () => number
  ttlMs?: number
}): FaceSnapshotCache {
  const read = options.read
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : FACE_SNAPSHOT_TTL_MS
  const cache = new Map<string, { at: number; snapshot: any }>()

  const get = (sid: string): any => {
    if (typeof sid !== 'string' || sid === '') return null
    const at = now()
    const cached = cache.get(sid)
    // 窗口是「严格小于」：整 TTL 毫秒这一刻就算过期（不能差一毫秒还留着旧状态）
    if (cached !== undefined && at - cached.at < ttlMs) return cached.snapshot
    let snapshot: any = null
    try {
      snapshot = read(sid) ?? null
    } catch {
      snapshot = null
    }
    // 取不到不缓存：下一条消息挂上来时必须立刻看得见
    if (snapshot === null) { cache.delete(sid); return null }
    cache.set(sid, { at, snapshot })
    return snapshot
  }

  return {
    get,
    invalidate: (sid: string): void => { cache.delete(sid) },
    invalidateAll: (): void => { cache.clear() },
    cachedIds: (): string[] => [...cache.keys()],
  }
}
