// 「会话尾快照」短缓存 + 在途去重（P0-2 的纯函数部分）。
//
// 背景：控制室卡片每 1.2 s 扫一轮进度，每取一条就是**在 mux 上新开一条 follow 流**
// （开场快照）。同一条会话在一轮里被卡片、提醒表、待决表各要一次时会开好几次。
// 这里给「同一条会话 + 同一组参数」加一个很短的窗口（默认 900 ms）与在途去重：
// 语义不变（进度最多晚 0.9 s 显示），但同一条流的开场快照最多开一次。
//
// 第 3 步（性能整改）补的两件事：表容量上限 + 按 TTL 的过期清扫。原来这张 Map 只增不删
// （条目过期只是「不再复用」，本体永远留在表里），长会话的控制室会攒下会话数 × 参数组合
// 数量的条目；现在过期条目会被清掉，容量也硬上限，超出后按最早过期的已结算条目淘汰。
// 命中窗口的复用语义（含在途 promise）一点没动。

/** 尾快照缓存窗口（毫秒）。 */
export const SESSION_TAIL_TTL_MS = 900

/**
 * 缓存表容量上限（条）。默认 256 的理由：
 * 一张卡片一条尾快照，键是「会话 × (maxMessages, stream 参数组合)」，
 * 控制室一轮里最多几个后台会话 × 2 组参数 = 个位数级别；900 ms 窗口意味着条目
 * 活不过一秒，256 条足够把「多标签控制室 + 十几个后台会话」都兜住，
 * 再多就只是累积（窗口早过期，没有复用价值），所以按最早过期淘汰。
 */
export const SESSION_TAIL_MAX_ENTRIES = 256

/**
 * 每轮清扫最多扫几条。默认 = 表容量上限，也就是说一次 run() 的遍历上界就是 256 次
 * Map 迭代（不是「Map 有多大就扫多大」），不会造成无界遍历。
 */
export const SESSION_TAIL_SWEEP_MAX_SCANS = SESSION_TAIL_MAX_ENTRIES

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxEntries] - 表容量上限（至少 1）
 * @param {number} [options.sweepMaxScans] - 每次 run() 的清扫遍历上界
 * @param {() => number} [options.now] - 时钟（测试注入）
 */
export function createTailCache(options = {}) {
  const ttlMs = Math.max(0, Number(options.ttlMs ?? SESSION_TAIL_TTL_MS) || 0)
  const maxEntries = Math.max(1, Math.floor(Number(options.maxEntries ?? SESSION_TAIL_MAX_ENTRIES) || SESSION_TAIL_MAX_ENTRIES))
  const sweepMaxScans = Math.max(1, Math.floor(Number(options.sweepMaxScans ?? SESSION_TAIL_SWEEP_MAX_SCANS) || SESSION_TAIL_SWEEP_MAX_SCANS))
  const now = options.now ?? (() => Date.now())
  /** @type {Map<string, {at: number, promise: Promise<any>, pending: boolean, session: string}>} */
  const map = new Map()

  /**
   * 缓存键里会话那段：`key()` 拼的是 `sessionId|maxMessages|stream 位`，宿主给的会话
   * 标识（`session-xxxxxxxx`）不含 `|`，所以按第一个 `|` 切就够用来做「按会话失效」。
   * （手工塞进来的任意键也能用：没有 `|` 时整串就是会话段。）
   */
  function sessionOfKey(key) {
    const text = String(key)
    const index = text.indexOf('|')
    return index === -1 ? text : text.slice(0, index)
  }

  /** 条目的窗口是否已经过去了（与命中判断同一个口径：`<` 窗口内，`>=` 过期）。 */
  function expired(entry) {
    return now() - entry.at >= ttlMs
  }

  /**
   * 清扫过期条目。有界：最多扫 `sweepMaxScans` 条（默认 = 表容量上限），
   * 遍历 Map 时删除当前键是安全的（规范允许）。返回清掉了几条。
   */
  function sweepExpired() {
    let removed = 0
    let scanned = 0
    for (const [cachedKey, entry] of map) {
      if (scanned >= sweepMaxScans) break
      scanned += 1
      if (expired(entry)) {
        map.delete(cachedKey)
        removed += 1
      }
    }
    return removed
  }

  /**
   * 给新条目腾位置：容量满了就淘汰**最早过期（at 最小）的已结算条目**。
   * 在途的条目永不淘汰——正在跑的 follow 流不该被缓存表踢掉。
   * 全表都在途（并发请求超过容量）时返回 false：这一次不进表、不缓存，
   * 但 factory 照跑（语义仍是「没命中就取一次」），表容量也因此不会被越推越深。
   */
  function makeRoom() {
    while (map.size >= maxEntries) {
      let oldestKey = ''
      let oldestAt = Infinity
      for (const [cachedKey, entry] of map) {
        if (entry.pending) continue
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = cachedKey
        }
      }
      if (oldestKey === '') return false
      map.delete(oldestKey)
    }
    return true
  }

  return {
    /** 稳定的缓存键：会话 + 请求参数（参数不同不能复用同一条快照）。 */
    key(sessionId, maxMessages, stream) {
      return `${String(sessionId)}|${String(maxMessages)}|${stream ? 1 : 0}`
    },
    /**
     * 命中窗口就复用（包括在途的 promise），否则跑一次 factory。
     * 每次调用先做一轮有界的过期清扫，再决定是否插入新条目。
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} factory
     * @returns {Promise<T>}
     */
    run(key, factory) {
      sweepExpired()
      const hit = map.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.promise
      const promise = Promise.resolve().then(factory)
      const entry = { at: now(), promise, pending: true, session: sessionOfKey(key) }
      const settle = () => { entry.pending = false }
      promise.then(settle, settle)
      // 失败不缓存（下一轮必须重试），避免一次抖动把卡片进度钉死 0.9 s。
      promise.catch(() => { if (map.get(key)?.promise === promise) map.delete(key) })
      if (!map.has(key) && !makeRoom()) return promise
      map.set(key, entry)
      return promise
    },
    /** 按会话失效：清掉这条会话的所有尾快照键，返回失效了几条。 */
    invalidate(sessionId) {
      const wanted = String(sessionId ?? '')
      let removed = 0
      for (const [cachedKey, entry] of map) {
        if (entry.session === wanted) {
          map.delete(cachedKey)
          removed += 1
        }
      }
      return removed
    },
    /** 全表作废（会话列表整体刷新时用），返回作废前有多少条。 */
    invalidateAll() {
      const removed = map.size
      map.clear()
      return removed
    },
    /** 表容量上限（给测试与调用方读）。 */
    maxEntries() { return maxEntries },
    size() { return map.size },
    clear() { map.clear() },
  }
}
