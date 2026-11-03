// 控制室卡片刷新节流（P0-3 的纯函数部分）。
//
// 背景：宿主每个流式帧都会通知插件一次，卡片「全量重组装」（1,000+ 会话 × 一遍扫）
// 原来只按 requestAnimationFrame 合并——一帧内多次能合并，但**跨帧不设上限**，
// 流式输出时等于最多 60 次/秒全表重组。这里给它加一个最小间隔（默认 150 ms），
// 语义不变：卡片最终仍会刷新，只是把「连续刷新」压成「至多 ~6.7 次/秒」。

/** 卡片重组装的最小间隔（毫秒）。 */
export const CARD_REFRESH_MIN_INTERVAL_MS = 150

/**
 * 创建一个「前导立即 + 尾随补一次」的节流器。
 * @param {object} [options]
 * @param {number} [options.minIntervalMs] - 最小间隔
 * @param {() => number} [options.now] - 时钟（测试注入）
 * @param {(fn: () => void, ms: number) => any} [options.schedule] - 定时器（测试注入）
 * @param {(handle: any) => void} [options.cancel] - 取消定时器
 * @returns {{bump: (run: () => void) => void, pending: () => boolean, dispose: () => void}}
 */
export function createCardRefreshCoalescer(options = {}) {
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs ?? CARD_REFRESH_MIN_INTERVAL_MS) || 0)
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  let last = 0
  let handle = null

  return {
    /** 请求一次刷新；间隔内只安排一次尾随刷新。 */
    bump(run) {
      const wait = Math.max(0, minIntervalMs - (now() - last))
      if (wait === 0) {
        if (handle != null) { cancel(handle); handle = null }
        last = now()
        run()
        return
      }
      if (handle != null) return
      handle = schedule(() => {
        handle = null
        last = now()
        run()
      }, wait)
    },
    /** 是否还有一次尾随刷新没跑。 */
    pending() { return handle != null },
    /** 卸载时清掉尾随定时器。 */
    dispose() {
      if (handle != null) { cancel(handle); handle = null }
    },
  }
}
