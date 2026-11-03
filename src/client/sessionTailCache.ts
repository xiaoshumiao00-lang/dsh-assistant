// 「会话尾快照」短缓存 + 在途去重（P0-2 的纯函数部分）。
//
// 背景：控制室卡片每 1.2 s 扫一轮进度，每取一条就是**在 mux 上新开一条 follow 流**
// （开场快照）。同一条会话在一轮里被卡片、提醒表、待决表各要一次时会开好几次。
// 这里给「同一条会话 + 同一组参数」加一个很短的窗口（默认 900 ms）与在途去重：
// 语义不变（进度最多晚 0.9 s 显示），但同一条流的开场快照最多开一次。

/** 尾快照缓存窗口（毫秒）。 */
export const SESSION_TAIL_TTL_MS = 900

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now] - 时钟（测试注入）
 */
export function createTailCache(options = {}) {
  const ttlMs = Math.max(0, Number(options.ttlMs ?? SESSION_TAIL_TTL_MS) || 0)
  const now = options.now ?? (() => Date.now())
  /** @type {Map<string, {at: number, promise: Promise<any>}>} */
  const map = new Map()

  return {
    /** 稳定的缓存键：会话 + 请求参数（参数不同不能复用同一条快照）。 */
    key(sessionId, maxMessages, stream) {
      return `${String(sessionId)}|${String(maxMessages)}|${stream ? 1 : 0}`
    },
    /**
     * 命中窗口就复用（包括在途的 promise），否则跑一次 factory。
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} factory
     * @returns {Promise<T>}
     */
    run(key, factory) {
      const hit = map.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.promise
      const promise = Promise.resolve().then(factory)
      map.set(key, { at: now(), promise })
      // 失败不缓存（下一轮必须重试），避免一次抖动把卡片进度钉死 0.9 s。
      promise.catch(() => { if (map.get(key)?.promise === promise) map.delete(key) })
      return promise
    },
    size() { return map.size },
    clear() { map.clear() },
  }
}
