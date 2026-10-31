// 抽屉开合状态自持（移动端布局改造 #1/#2）
//
// 官方 layout store（app.asar 内的 AppFrame）不能直接拿来当"抽屉开关"用：
//   1) 窄屏 sidebarCollapsed = !layoutInfo.narrowExpanded，narrowExpanded 初始 false
//      且该 store 不持久化 —— 刷新后永远回到"收起"，手机记住上次开合做不到；
//   2) 更关键的是它的"收起"会把侧栏 DOM 切成只剩图标的 rail
//      （renderSlot("sidebar", { collapsed })），抽屉里就没列表了；
//   3) 宽屏 toggleSidebar() 是在 sidebar 0/280 之间切，跟手机上要的抽屉不是一回事。
// 所以开合改由本模块自持：frame 上的 data-dshp-drawer="open|closed" 是 CSS 里
// **唯一**的抽屉开态锚点，localStorage 的 dsh-pocket.drawer 是刷新后的记忆。
// 离屏基态仍挂在 [data-mobile-nav="frame"] > :first-child 上（默认就是关）。
//
// 唯一保留的官方调用：打开抽屉时若 frame 上还挂着 data-sidebar-collapsed
// （官方窄屏默认值 → 侧栏只有图标 rail），先调一次 ctx.layout.toggleSidebar()
// 把侧栏内容换成完整列表；此后**绝不**主动把官方状态降回 collapsed ——
// 只做"升到展开"，不做"降回收起"，避免和用户自己在电脑端的切换打架。
//
// 纯函数 + 依赖注入（storage / findFrame / expandSidebar），node 单测不需要 DOM。

import { domGate, INTERACTION_PAUSE_MS } from '../../compositionGate.ts'

/** localStorage key：值为 'open' | 'closed'；读不到一律按 'closed'（默认关）。 */
export const DRAWER_PREF_KEY = 'dsh-pocket.drawer'

/** frame 上的开合 marker —— CSS 抽屉开态选择器只认它。 */
export const DRAWER_MARKER_ATTR = 'data-dshp-drawer'

/** 官方 AppFrame 的收起态属性（窄屏默认 true：侧栏 DOM 只剩图标 rail）。 */
export const OFFICIAL_COLLAPSED_ATTR = 'data-sidebar-collapsed'

/** 我们的 frame marker（MobileNavOverlay 挂载时打在 AppFrame 上）。 */
export const FRAME_SELECTOR = '[data-mobile-nav="frame"]'

/** 抽屉本体：被拉成离屏抽屉的侧栏列（frame 的第一个网格子元素）。 */
export const DRAWER_SELECTOR = `${FRAME_SELECTOR} > :first-child`

/** 开态完整选择器：JS 侧守卫（点抽屉外 / 点导航行）用它判断"抽屉是否开着"。 */
export const DRAWER_OPEN_SELECTOR = `${FRAME_SELECTOR}[${DRAWER_MARKER_ATTR}="open"]`

/**
 * 归一化偏好值：只有字面 'open' 算开，其它（含缺失、损坏、隐私模式读失败）一律 'closed'。
 * @param {unknown} value - localStorage 里的原始值。
 * @returns {'open' | 'closed'}
 */
export function normalizeDrawerPref(value) {
  return String(value ?? '').trim() === 'open' ? 'open' : 'closed'
}

/**
 * 读抽屉开合偏好。
 * @param {Storage} [storage] - 注入的 storage（默认 globalThis.localStorage）。
 * @returns {'open' | 'closed'} 读不到 / 抛异常一律 'closed'。
 */
export function readDrawerPref(storage = globalThis.localStorage) {
  if (storage == null || typeof storage.getItem !== 'function') return 'closed'
  try {
    return normalizeDrawerPref(storage.getItem(DRAWER_PREF_KEY))
  } catch {
    return 'closed' // 隐私模式 / 禁用 storage → 默认关
  }
}

/**
 * 写抽屉开合偏好。
 * @param {boolean} open - 开 = true。
 * @param {Storage} [storage] - 注入的 storage。
 * @returns {'open' | 'closed'} 实际写入的值（storage 不可用时只回显，不抛）。
 */
export function writeDrawerPref(open, storage = globalThis.localStorage) {
  const pref = open === true ? 'open' : 'closed'
  if (storage != null && typeof storage.setItem === 'function') {
    try {
      storage.setItem(DRAWER_PREF_KEY, pref)
    } catch { /* 隐私模式 → 本次会话内仍自持（marker + 内存态） */ }
  }
  return pref
}

/**
 * 写 frame 上的开态 marker。用属性值（open/closed）而不是布尔属性：
 * 属性删掉 = marker 缺失，缺失时 CSS 走的是"离屏基态"（默认不命中），
 * 保留显式 closed 让 devtools 里看得出当前状态。
 * @param {Element | null} frame - AppFrame 元素。
 * @param {boolean} open - 开 = true。
 */
export function setDrawerMarker(frame, open) {
  if (frame == null || typeof frame.setAttribute !== 'function') return
  try {
    frame.setAttribute(DRAWER_MARKER_ATTR, open === true ? 'open' : 'closed')
  } catch { /* 忽略：marker 只是渲染提示 */ }
}

/**
 * 擦掉 marker（effect 卸载 / 宽屏不再走抽屉布局时）。
 * @param {Element | null} frame - AppFrame 元素。
 */
export function clearDrawerMarker(frame) {
  if (frame == null || typeof frame.removeAttribute !== 'function') return
  try {
    frame.removeAttribute(DRAWER_MARKER_ATTR)
  } catch { /* 忽略 */ }
}

/**
 * frame 上的 marker 是否处于开态（JS 侧守卫的唯一判据）。
 * @param {Element | null} frame
 * @returns {boolean}
 */
export function isDrawerOpenFrame(frame) {
  if (frame == null || typeof frame.getAttribute !== 'function') return false
  return frame.getAttribute(DRAWER_MARKER_ATTR) === 'open'
}

/**
 * 官方侧栏是否处于 collapsed（图标 rail）状态。
 * @param {Element | null} frame
 * @returns {boolean}
 */
export function isOfficialSidebarCollapsed(frame) {
  if (frame == null || typeof frame.hasAttribute !== 'function') return false
  return frame.hasAttribute(OFFICIAL_COLLAPSED_ATTR)
}

/**
 * 是否需要（且允许）调用一次官方 toggleSidebar()：只在"要把抽屉亮出来，
 * 而官方侧栏还是图标 rail"时为 true。关抽屉永远返回 false（不降回收起）。
 * @param {boolean} open - 目标状态。
 * @param {boolean} collapsed - frame 当前是否 collapsed。
 * @returns {boolean}
 */
export function shouldUpgradeOfficialSidebar(open, collapsed) {
  return open === true && collapsed === true
}

/**
 * 反向同步判据（只跟不抢）：**别人**把官方侧栏降回了 collapsed（悬浮球入口
 * OrbEntry、第三方插件的自建抽屉、用户在桌面端自己点收起）→ 侧栏 DOM 退化成
 * 48px 图标 rail，这时我们的抽屉若还标着 open，就等于把一条 rail 滑进屏幕。
 * 于是把抽屉关掉（写 marker + 偏好）。注意方向：我们从不主动调 toggleSidebar()
 * 去降回收起（那归用户），只是跟随别人已经做出的降级。
 * @param {boolean} drawerOpen - 我们的 marker 是否 open。
 * @param {boolean} collapsed - frame 当前是否 collapsed。
 * @returns {boolean}
 */
export function shouldMirrorOfficialCollapse(drawerOpen, collapsed) {
  return drawerOpen === true && collapsed === true
}

/**
 * AppFrame：shell overlay 层的父元素（沿用 MobileNavOverlay 原有判据）。
 * @param {Document} [doc]
 * @returns {Element | null}
 */
export function findFrame(doc = globalThis.document) {
  if (doc == null || typeof doc.querySelector !== 'function') return null
  const overlay = doc.querySelector('[data-shell-overlay]')
  return overlay?.parentElement ?? null
}

/**
 * 抽屉控制器：marker + localStorage + 一次性"升到展开"，三者在这里收口。
 * 组件（overlay / toggle / footer）只调 open/close/toggle，状态经 subscribe 广播，
 * 免得三个入口各自维护一份 open 状态打架。
 *
 * @param {object} options
 * @param {() => Element | null} [options.findFrame] - 取 AppFrame。
 * @param {() => void} [options.expandSidebar] - 绑定的 ctx.layout.toggleSidebar()。
 * @param {Storage} [options.storage] - 偏好存储。
 */
export function createDrawerController({
  findFrame: resolveFrame = findFrame,
  expandSidebar,
  storage = globalThis.localStorage,
} = {}) {
  let open = false
  /** @type {Set<(open: boolean) => void>} */
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) {
      try { listener(open) } catch { /* 单个订阅者出错不影响其它 */ }
    }
  }

  const apply = (next) => {
    const frame = typeof resolveFrame === 'function' ? resolveFrame() : null
    if (shouldUpgradeOfficialSidebar(next, isOfficialSidebarCollapsed(frame)) && typeof expandSidebar === 'function') {
      // 只升到展开：官方把侧栏 DOM 从图标 rail 换成完整列表。
      // 旧实现把 toggleSidebar() 同时用作"开/关抽屉"，宽屏下会把侧栏降回 0 轨，
      // 也会在 auto 布局里和用户自己的切换互相打架 —— 现在不再这么用。
      try { expandSidebar() } catch { /* 宿主没给 layout 服务：抽屉照样能开 */ }
    }
    // 与抽屉 chrome 同一条纪律：开合动画窗口里插件自己的扫描/补丁让路。
    domGate?.pause?.(INTERACTION_PAUSE_MS)
    open = next === true
    setDrawerMarker(frame, open)
    writeDrawerPref(open, storage)
    emit()
    return open
  }

  return {
    /** 当前开态（内存态，与 marker 同步）。 */
    getOpen: () => open,
    open: () => apply(true),
    close: () => apply(false),
    toggle: () => apply(!open),
    /** 挂载时把 marker / 内存态对齐到 localStorage 偏好（刷新后保持上次开合）。 */
    sync: () => apply(readDrawerPref(storage) === 'open'),
    /**
     * 订阅开态变化。
     * @param {(open: boolean) => void} listener
     * @returns {() => void} 退订。
     */
    subscribe: (listener) => {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
