// 宿主特性存在性闸门（手机流畅度改造）
//
// 手机上挂着的三个「dsh-web-ui 兼容」观察者（explorer 列 / preview 列 / 表格抬起动画）
// 都按 `document.body` 全量 childList/attributes 观察，回调里做 querySelector +
// getComputedStyle。但本机跑的是纯 DeepSeek Harness —— 它根本没有 `[data-aionui-*]`
// 那两列，于是这几个观察者等于永久挂着：长会话详情实测 ~2 万节点，每一次 DOM 变更
// （打字、流式渲染、抽屉开合）都排一批回调，主线程被抢帧 —— 抽屉那 0.28s transform
// 动画就是被这个吃掉的。
//
// 这份模块把「观察整页」换成「先确认宿主到底有没有那两列」：
//   - 存在 → 请调用方挂它真正的观察者（onActive），返回它的断开函数；
//   - 不存在 → 只在 pollMs 窗口内轮询到 timeoutMs，到期不再观察（彻底零成本）；
//   - 调用方随时可 recheck()（我们自己点 Files 入口、布局切换）重新确认一次。
//
// 纯函数 + 依赖注入（doc / schedule / clear），node 单测不需要真 DOM。

/** 轮询确认间隔（毫秒）。 */
export const PRESENCE_POLL_MS = 800
/** 轮询窗口上限（毫秒）：超过就认为宿主没有这个特性，不再观察。 */
export const PRESENCE_TIMEOUT_MS = 20000

/**
 * @param {object} options
 * @param {string[]} options.selectors - 任一命中即算「宿主真的有这个特性」。
 * @param {(found: boolean) => (void | (() => void))} [options.onActive] - 命中后挂载真观察者。
 * @param {(sel: string) => boolean} [options.exists] - 存在性判据注入（默认 doc.querySelector）。
 * @param {Document} [options.doc]
 * @param {(fn: () => void, ms: number) => any} [options.schedule]
 * @param {(handle: any) => void} [options.clear]
 * @param {number} [options.pollMs]
 * @param {number} [options.timeoutMs]
 * @returns {{ dispose: () => void, recheck: () => boolean, active: () => boolean }}
 */
export function startFeaturePresenceWatch(options = {}) {
  const doc = options.doc ?? globalThis.document
  const selectors = Array.isArray(options.selectors) ? options.selectors.filter((s) => typeof s === 'string' && s !== '') : []
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : PRESENCE_POLL_MS
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PRESENCE_TIMEOUT_MS
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = options.clear ?? ((handle) => clearTimeout(handle))
  /** 注入的时钟（测试可用假时钟走窗口；默认真时钟）。 */
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const exists = typeof options.exists === 'function'
    ? options.exists
    : (sel) => {
      if (doc === null || doc === undefined || typeof doc.querySelector !== 'function') return false
      try { return doc.querySelector(sel) !== null } catch { return false }
    }
  const onActive = typeof options.onActive === 'function' ? options.onActive : null

  let disposed = false
  let activated = false
  /** @type {null | (() => void)} */
  let disposeActive = null
  let timer = null
  let deadline = now() + timeoutMs

  const found = () => selectors.some((sel) => exists(sel))

  const activate = () => {
    if (activated || disposed) return activated
    if (!found()) return false
    activated = true
    try {
      const stop = onActive === null ? undefined : onActive(true)
      disposeActive = typeof stop === 'function' ? stop : null
    } catch {
      /* 挂载失败不影响后面：调用方自己 catch 得住 */
    }
    if (timer !== null) { clear(timer); timer = null }
    return true
  }

  const tick = () => {
    if (disposed) return
    if (activate()) return
    if (now() >= deadline) {
      if (timer !== null) { clear(timer); timer = null }
      return
    }
    timer = schedule(tick, pollMs)
  }

  timer = schedule(tick, 0)

  return {
    /** 外部主动确认一次（我们自己点 Files 入口 / 布局切换时调用）。 */
    recheck() {
      if (disposed) return false
      deadline = now() + timeoutMs
      if (activated) return true
      if (activate()) return true
      if (timer === null) timer = schedule(tick, pollMs)
      return activated
    },
    active() {
      return activated
    },
    dispose() {
      disposed = true
      if (timer !== null) { clear(timer); timer = null }
      try { disposeActive?.() } catch { /* 断开失败 */ }
      disposeActive = null
    },
  }
}
