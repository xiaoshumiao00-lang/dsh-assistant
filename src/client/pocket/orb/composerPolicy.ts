// 悬浮球输入框的「打字路径」纯策略（便于回归，不碰 React）。
//
// 背景（2026-11-02 第二轮：输入框/IME 卡顿）：
//   - 键盘弹起/收起时 Android XWEB 会连发一串 resize；原来的 autosize 每个事件都做
//     「写 height:auto → 读 scrollHeight → 写 height」，等于每个事件一次强制同步布局。
//     其实内容高度没变时完全不必重排：只要「上限跟着视口走」。
//   - 输入法组合期间（拼音候选未上屏）不该测量/不该重排：一测就可能让 WebView 在
//     composition 中间同步 layout，候选词上屏就慢半拍。
//
// 这里只放纯函数，Composer.tsx 只负责调用。

/** 输入框高度上限：视口的 40%。 */
export const COMPOSER_MAX_VIEWPORT_RATIO = 0.4

/** 高度上限（px）。视口未知时给 0 = 不设上限。 */
export function composerHeightCap(viewportHeight: number): number {
  const h = Number(viewportHeight)
  if (!Number.isFinite(h) || h <= 0) return 0
  return Math.max(24, Math.floor(h * COMPOSER_MAX_VIEWPORT_RATIO))
}

/**
 * 真正要写进 textarea.style.height 的值。
 * @param contentHeight scrollHeight（内容高度）
 * @param cap 高度上限（0 = 不设上限）
 */
export function composerHeightFor(contentHeight: number, cap: number): number {
  const content = Number(contentHeight)
  if (!Number.isFinite(content) || content <= 0) return 0
  if (cap > 0 && content > cap) return cap
  return Math.ceil(content)
}

/**
 * 这次 resize/输入是否需要重新测量内容高度。
 *
 * 判据：
 *   - 从没量过（prev.contentHeight < 0）→ 要量；
 *   - 上限没变（键盘动画中间那些事件）→ 不量（内容没变，只是视口在动）；
 *   - 上限变小且上次已经顶到上限 → 要量（要把滚动条/裁切重新算出来）；
 *   - 其余（上限变大 / 首次算上限）→ 不量：高度由 cap 决定，直接写 cap 即可。
 *
 * @param {{contentHeight: number, cap: number}} prev - 上一次测量的结果
 * @param {number} nextCap - 本次的上限
 */
export function shouldRemeasure(prev: { contentHeight: number; cap: number }, nextCap: number): boolean {
  if (!prev || prev.contentHeight < 0) return true
  if (prev.cap === nextCap) return false
  if (nextCap > 0 && prev.cap > 0 && nextCap < prev.cap && prev.contentHeight >= prev.cap) return true
  return false
}

/**
 * 组合输入（输入法候选未上屏）期间要不要推迟重排/重算。
 * 明确「只有正在组合时才推迟」，组合结束（compositionend）由调用方补一次。
 * @param {boolean} composing
 * @param {boolean} hidden - document.hidden
 */
export function shouldDeferComposerLayout(composing: boolean, hidden: boolean): boolean {
  return composing === true || hidden === true
}

/**
 * 组合输入追踪器：textarea 的 compositionstart/end 只改一个布尔。
 * 用对象而不是 state，避免「组合开始」本身触发一轮渲染。
 */
export function createCompositionTracker() {
  let composing = false
  return {
    start(): void { composing = true },
    end(): void { composing = false },
    /** 组合中插入的文本是否已经由 React 受控值处理（永远是 true：不做二次格式化）。 */
    isComposing(): boolean { return composing },
  }
}
