// 手势召唤抽屉（移动端布局改造 #3）
//
// 左边缘右滑 = 开抽屉；抽屉内左滑 = 关抽屉。判定写成纯函数（classifySwipe），
// 挂载函数（mountDrawerSwipe）只负责 passive 监听 + DOM 查询，node 单测只测纯函数。
//
// 为什么要限制起手区：
//   - 右滑只认视口左边缘 SWIPE_EDGE_ZONE 内起手，否则正文里任何一次向右滑动
//     （选字、滚动惯性、横向表格）都会把抽屉甩出来；
//   - 左滑只认"起手点在抽屉里"，否则会劫持会话状态行 [data-mobile-nav="stats"]
//     的横向滚动（那条 28px 的指标流是手机上唯一能看全 TTFT/cache 的地方），
//     也会劫持 aionui explorer/preview 两个 sheet 内的横向滚动；
//   - SWIPE_BLOCK_SELECTOR 里的可滚动/可输入区一律不参与手势（输入框上的滑动
//     应该改光标位置，不是开合抽屉）。

/** 视口左边缘的起手区宽度（CSS px）。 */
export const SWIPE_EDGE_ZONE = 28

/** 判定为一次抽屉手势所需的最小横向位移。 */
export const SWIPE_MIN_DX = 56

/** 横向位移必须超过纵向位移的这个倍数，否则算纵向滚动。 */
export const SWIPE_MIN_RATIO = 1.5

/** 起手落在这些区域就不参与抽屉手势（各自的横向滚动 / 文本选择优先）。 */
export const SWIPE_BLOCK_SELECTOR = [
  '[data-mobile-nav="stats"]',
  '[data-aionui-explorer-col]',
  '[data-aionui-preview-col]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="listbox"]',
  'input',
  'textarea',
  '[contenteditable="true"]',
].join(', ')

/**
 * 起手点是否落在"不该被手势劫持"的区域里。
 * @param {Element | null | undefined} target - pointerdown 的 target。
 * @returns {boolean}
 */
export function isSwipeBlockedTarget(target) {
  if (target == null || typeof target.closest !== 'function') return false
  return target.closest(SWIPE_BLOCK_SELECTOR) !== null
}

/**
 * 纯判定：一次滑动该开抽屉、关抽屉，还是什么都不做。
 *
 * @param {object} gesture
 * @param {number} gesture.startX - 起手 X（clientX）。
 * @param {number} gesture.startY - 起手 Y（clientY）。
 * @param {number} gesture.endX - 收尾 X。
 * @param {number} gesture.endY - 收尾 Y。
 * @param {number} [gesture.viewportWidth] - 视口宽度（限制左边缘起手区用）。
 * @param {boolean} [gesture.drawerOpen] - 抽屉当前是否开着。
 * @param {boolean} [gesture.startInDrawer] - 起手点是否在抽屉内。
 * @param {number} [gesture.edgeZone] - 左边缘起手区宽度。
 * @param {number} [gesture.minDx] - 最小横向位移。
 * @param {number} [gesture.minRatio] - 横/纵位移比下限。
 * @returns {'open' | 'close' | null}
 */
export function classifySwipe({
  startX,
  startY,
  endX,
  endY,
  viewportWidth,
  drawerOpen = false,
  startInDrawer = false,
  edgeZone = SWIPE_EDGE_ZONE,
  minDx = SWIPE_MIN_DX,
  minRatio = SWIPE_MIN_RATIO,
} = {}) {
  const dx = Number(endX) - Number(startX)
  const dy = Number(endY) - Number(startY)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null
  if (Math.abs(dx) < minDx) return null
  if (Math.abs(dx) <= Math.abs(dy) * minRatio) return null

  if (dx > 0) {
    // 右滑开：抽屉已经开着就没什么可做，也不接管抽屉内的向右滑（那是返回手势）。
    if (drawerOpen === true) return null
    const vw = Number(viewportWidth)
    const zone = Number.isFinite(vw) && vw > 0 ? Math.min(edgeZone, vw) : edgeZone
    if (Number(startX) > zone) return null
    return 'open'
  }

  // 左滑关：起手必须在抽屉内，否则就是劫持页面里别的横向滚动。
  if (drawerOpen !== true) return null
  if (startInDrawer !== true) return null
  return 'close'
}

/**
 * 挂上手势监听（passive，不 preventDefault，不阻塞滚动）。
 * @param {object} options
 * @param {() => boolean} options.isDrawerOpen - 当前开态（读 marker / 控制器）。
 * @param {() => void} options.onOpen - 判定为"开"时调用。
 * @param {() => void} options.onClose - 判定为"关"时调用。
 * @param {string} [options.drawerSelector] - 抽屉本体选择器（判定起手点用）。
 * @param {number} [options.edgeZone] - 左边缘起手区宽度。
 * @param {Document} [options.doc]
 * @param {Window} [options.win]
 * @returns {() => void} 卸载函数。
 */
export function mountDrawerSwipe({
  isDrawerOpen,
  onOpen,
  onClose,
  drawerSelector = '[data-mobile-nav="frame"] > :first-child',
  edgeZone = SWIPE_EDGE_ZONE,
  doc = globalThis.document,
  win = globalThis.window,
} = {}) {
  if (doc == null || typeof doc.addEventListener !== 'function') return () => {}

  /** @type {{ x: number, y: number, inDrawer: boolean } | null} */
  let start = null

  const isTouchy = (event) =>
    event.pointerType === undefined || event.pointerType === 'touch' || event.pointerType === 'pen'

  const inDrawer = (target) => {
    if (target == null) return false
    const drawer = typeof doc.querySelector === 'function' ? doc.querySelector(drawerSelector) : null
    if (drawer == null || typeof drawer.contains !== 'function') return false
    return drawer.contains(target)
  }

  const onPointerDown = (event) => {
    if (!isTouchy(event) || isSwipeBlockedTarget(event.target)) {
      start = null
      return
    }
    start = { x: event.clientX, y: event.clientY, inDrawer: inDrawer(event.target) }
  }

  const onPointerUp = (event) => {
    const origin = start
    start = null
    if (origin === null || !isTouchy(event)) return
    const gesture = classifySwipe({
      startX: origin.x,
      startY: origin.y,
      endX: event.clientX,
      endY: event.clientY,
      viewportWidth: win?.innerWidth,
      drawerOpen: typeof isDrawerOpen === 'function' ? isDrawerOpen() === true : false,
      startInDrawer: origin.inDrawer,
      edgeZone,
    })
    if (gesture === 'open' && typeof onOpen === 'function') onOpen()
    else if (gesture === 'close' && typeof onClose === 'function') onClose()
  }

  const onPointerCancel = () => { start = null }

  doc.addEventListener('pointerdown', onPointerDown, { passive: true })
  doc.addEventListener('pointerup', onPointerUp, { passive: true })
  doc.addEventListener('pointercancel', onPointerCancel, { passive: true })

  return () => {
    start = null
    doc.removeEventListener('pointerdown', onPointerDown)
    doc.removeEventListener('pointerup', onPointerUp)
    doc.removeEventListener('pointercancel', onPointerCancel)
  }
}
