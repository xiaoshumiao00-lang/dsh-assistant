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

/*
 * 汉堡钮的「命中区」—— 手机上点左上角那三条横线点不进去（2026-11-03 用户反馈）。
 * 按钮本体只有 28px，图标更小（15×10），还贴着屏幕左上角；手指落点普遍偏低/偏右
 * 十几像素，落在按钮盒子外面就是"点了没反应"，于是要连点好几次。这里把判定从
 * 「点中了按钮元素」改成「落点在按钮外扩一圈的矩形里」：指针路径（pointerdown/up）
 * 直接算坐标，不依赖 click 是否被合成、也不依赖哪个元素在最上面。
 */

/** 命中区在按钮本体外扩的像素（左/上更宽：拇指最容易落在左上角外侧）。 */
export const TOGGLE_ZONE_PAD_X = 6
export const TOGGLE_ZONE_PAD_Y = 6
/** 下沿只外扩 2px：紧挨着下面就是会话页的「对话 / 轨迹」标签条，别抢它们的点击。 */
export const TOGGLE_ZONE_PAD_BOTTOM = 2

/** 仍算"点一下"的最大位移（超过就是滑动 / 拖拽，不触发抽屉）。 */
export const TOGGLE_TAP_MAX_MOVE = 14

/** 仍算"点一下"的最长按压（毫秒）；长按多半是选择/菜单意图。 */
export const TOGGLE_TAP_MAX_MS = 800

/**
 * 由按钮的矩形算出命中区（已裁掉屏幕外侧的负数部分）。
 * @param {{left: number, top: number, width: number, height: number} | null | undefined} rect - getBoundingClientRect()。
 * @param {{padX?: number, padY?: number, padBottom?: number}} [options]
 * @returns {{x0: number, x1: number, y0: number, y1: number} | null} 矩形无效时返回 null。
 */
export function toggleHitZone(rect, { padX = TOGGLE_ZONE_PAD_X, padY = TOGGLE_ZONE_PAD_Y, padBottom = TOGGLE_ZONE_PAD_BOTTOM } = {}) {
  const left = Number(rect?.left)
  const top = Number(rect?.top)
  const width = Number(rect?.width)
  const height = Number(rect?.height)
  if (![left, top, width, height].every((v) => Number.isFinite(v))) return null
  if (width <= 0 || height <= 0) return null
  return {
    x0: Math.max(0, left - padX),
    x1: left + width + padX,
    y0: Math.max(0, top - padY),
    y1: top + height + padBottom,
  }
}

/**
 * 坐标是否落在命中区内。
 * @param {{x: number, y: number}} point
 * @param {{x0: number, x1: number, y0: number, y1: number} | null} zone
 * @returns {boolean}
 */
export function isInToggleZone(point, zone) {
  if (zone == null) return false
  const x = Number(point?.x)
  const y = Number(point?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return x >= Math.min(zone.x0, zone.x1) && x <= Math.max(zone.x0, zone.x1)
    && y >= Math.min(zone.y0, zone.y1) && y <= Math.max(zone.y0, zone.y1)
}

/**
 * 一次指针按下→抬起是否算"点了汉堡钮"。
 * @param {object} tap
 * @param {number} tap.startX - 按下点。
 * @param {number} tap.startY
 * @param {number} tap.endX - 抬起点。
 * @param {number} tap.endY
 * @param {{x0: number, x1: number, y0: number, y1: number} | null} tap.zone - 命中区。
 * @param {number} [tap.elapsedMs] - 按下到抬起的毫秒数。
 * @param {number} [tap.maxMove] - 允许的位移。
 * @param {number} [tap.maxMs] - 允许的时长。
 * @returns {boolean}
 */
export function classifyToggleTap({
  startX,
  startY,
  endX,
  endY,
  zone,
  elapsedMs = 0,
  maxMove = TOGGLE_TAP_MAX_MOVE,
  maxMs = TOGGLE_TAP_MAX_MS,
} = {}) {
  const sx = Number(startX)
  const sy = Number(startY)
  const ex = Number(endX)
  const ey = Number(endY)
  if (![sx, sy, ex, ey].every((v) => Number.isFinite(v))) return false
  if (Number(elapsedMs) > maxMs) return false
  if (Math.hypot(ex - sx, ey - sy) > maxMove) return false
  return isInToggleZone({ x: sx, y: sy }, zone) && isInToggleZone({ x: ex, y: ey }, zone)
}

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
