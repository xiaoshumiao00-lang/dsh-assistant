/**
 * Mobile drawer chrome, mounted from plain DOM instead of host slots.
 *
 * Why not slots: the three `ctx.slots.inject(...)` contributions this module
 * replaces (header toggle / shell overlay / sidebar footer) never rendered in
 * the DSH build served today. The plugin's own beacon recorded `marker=''`,
 * `slots{tog:0,fab:0,bk:0,acts:0}` and the official `55.99px` grid at
 * post-mount time while apply() reported no error, on the phone (WeChat XWEB)
 * and on a 1920px desktop browser forced to `?dsh-layout=mobile` alike.
 * Plain DOM sidesteps the whole slot / props / locale path.
 *
 * Everything here is idempotent and null-safe: `mobileApply` runs before the
 * official AppFrame mounts, so the frame is re-resolved on every call and a
 * short retry loop waits for `[data-shell-overlay]` to appear.
 */
import {
  DRAWER_MARKER_ATTR,
  OFFICIAL_COLLAPSED_ATTR,
  writeDrawerPref,
} from './drawer-state.mjs'
import { isOverlayTap } from './nav-targets.mjs'
import { mountDrawerSwipe } from './swipe.mjs'
import { domGate, INTERACTION_PAUSE_MS } from '../../compositionGate.ts'

/** Frame marker value that switches the drawer stylesheet on. */
export const FRAME_MARKER_ATTR = 'data-mobile-nav'
/** The official overlay layer that hosts the backdrop / FAB / hamburger. */
export const OVERLAY_SELECTOR = '[data-shell-overlay]'
/** One-shot "layout was healed" toast, removed after HEAL_TOAST_MS. */
export const HEAL_TOAST_ATTR = 'data-dshp-heal-toast'
export const HEAL_TOAST_MS = 6000
export const CHROME_RETRY_MS = 250
export const CHROME_RETRY_LIMIT = 48
/**
 * 预升级时机（毫秒）：把「图标 rail → 完整菜单列表」那次宿主重渲染放到首屏之后做。
 * 原来它挂在第一次点汉堡上：那次点击要等 AppFrame 换列 + SidebarRoot 重挂载 +
 * 会话列表重建（手机上实测几百毫秒）才开始滑 → 就是「点开左侧菜单有点慢」的根因。
 */
export const PRE_UPGRADE_MS = 700
/** 抽屉 transform 过渡时长（mobile.css.ts 的 .28s），只用于打点与兜底。 */
export const DRAWER_TRANSITION_MS = 280
/** will-change 的兜底清理时长：transitionend 没来也必须清掉（它会成为 fixed 后代的包含块）。 */
export const DRAWER_WILL_CHANGE_MS = 520

const MENU_ICON =
  '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
  '<path d="M3.25 5.75h13.5M3.25 10h13.5M3.25 14.25h13.5" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>'
const LOG_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M8 2.5v7.2M4.9 6.9 8 10l3.1-3.1M3 12.5h10" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'

export interface DrawerChromeOptions {
  findFrame: () => HTMLElement | null
  /** Upgrade the official collapsed rail into the full menu (never downgrade). */
  expandSidebar?: () => void
  labels: { menu: string; sessionLog: string }
  onDownloadSessionLog?: () => void
  /** 一次开抽屉的打点：ms = 点击到「那一帧真的开始滑」；upgrade = 这次是否补做了宿主升级。 */
  onMeasure?: (info: { ms: number; upgrade: boolean }) => void
  doc?: Document
  win?: Window
  storage?: Storage | null
}

/**
 * Mount the backdrop / floating button / hamburger and own the open state.
 * @returns a cleanup function for the owning effect.
 */
export function mountDrawerChrome(options: DrawerChromeOptions): () => void {
  const doc = options.doc ?? globalThis.document
  const storage = options.storage ?? safeStorage()
  // Spec (user-confirmed): every page load starts CLOSED — the stored
  // preference is written for diagnostics but deliberately NOT restored, so a
  // drawer left open on one visit never eats the screen on the next one.
  let open = false
  let frame: HTMLElement | null = null
  let backdrop: HTMLElement | null = null
  let toggle: HTMLButtonElement | null = null
  let logButton: HTMLButtonElement | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let tries = 0
  let disposed = false
  /** 首屏后的那次「图标 rail → 完整菜单」升级只做一次。 */
  let preUpgraded = false
  let preUpgradeTimer: ReturnType<typeof setTimeout> | null = null
  let willChangeTimer: ReturnType<typeof setTimeout> | null = null

  const win: any = options.win ?? (globalThis as any).window
  const nowMs = (): number =>
    (typeof win?.performance?.now === 'function' ? win.performance.now() : Date.now())

  const overlayLayer = (): HTMLElement | null =>
    doc.querySelector<HTMLElement>(OVERLAY_SELECTOR)

  /** Re-resolve the frame and write both markers; null when not mounted yet. */
  const syncFrame = (): HTMLElement | null => {
    frame = options.findFrame() ?? null
    if (frame === null) return null
    frame.setAttribute(FRAME_MARKER_ATTR, 'frame')
    frame.setAttribute(DRAWER_MARKER_ATTR, open ? 'open' : 'closed')
    return frame
  }

  const applyState = (): void => {
    syncFrame()
    // The official stylesheet only paints the backdrop; "hidden unless open"
    // used to come from React conditional rendering. Owning the state in plain
    // DOM means we must toggle visibility ourselves, or the whole page stays
    // dimmed while the drawer is closed.
    if (backdrop !== null) backdrop.style.display = open ? 'block' : 'none'
    writeDrawerPref(open, storage)
  }

  /** 抽屉那一列（frame 的第一个网格子元素）：CSS 的 transform 过渡打在它身上。 */
  const drawerColumn = (): HTMLElement | null => {
    const child = frame?.firstElementChild ?? null
    return child === null ? null : (child as HTMLElement)
  }

  /**
   * 动画期间把那一列提到独立合成层：transform 过渡跑在合成器上，主线程同时在忙宿主
   * 重排也不掉帧。到点必须撤 —— `will-change: transform` 会让这一列成为 fixed 后代
   * （宿主设置抽屉的 portal）的包含块，久留就重演「设置面板偏 102px」那个老 bug。
   */
  const armColumnCompositing = (): void => {
    const column = drawerColumn()
    if (column === null) return
    try { column.style.willChange = 'transform' } catch { return }
    if (willChangeTimer !== null) clearTimeout(willChangeTimer)
    willChangeTimer = setTimeout(() => {
      willChangeTimer = null
      try { column.style.willChange = 'auto' } catch { /* 撤不掉就算了 */ }
    }, DRAWER_WILL_CHANGE_MS)
  }

  /** 打点：点击 → 两帧之后（排版绘制完成）= 真的开始滑的时刻。 */
  const measureOpen = (startedAt: number, upgrade: boolean): void => {
    const reporter = options.onMeasure
    if (reporter === undefined) return
    const raf = (fn: () => void): void => {
      if (typeof win?.requestAnimationFrame === 'function') win.requestAnimationFrame(() => fn())
      else setTimeout(fn, 0)
    }
    raf(() => {
      raf(() => {
        try {
          reporter({ ms: Math.round(nowMs() - startedAt), upgrade })
        } catch { /* 打点绝不影响抽屉 */ }
      })
    })
  }

  const openDrawer = (): void => {
    if (open) return
    const startedAt = nowMs()
    /* 只在「首屏预升级还没做 / 做不成」时同步补做：此后每次开抽屉都是纯 CSS 动画。 */
    const needsUpgrade = frame !== null && frame.hasAttribute(OFFICIAL_COLLAPSED_ATTR)
    if (needsUpgrade) {
      try {
        options.expandSidebar?.()
      } catch {
        /* 展开失败不影响抽屉本身 */
      }
    }
    open = true
    // 开合动画窗口内插件自己的扫描/补丁先让路（免得 0.28s 过渡被主线程抢帧）
    domGate.pause(INTERACTION_PAUSE_MS)
    armColumnCompositing()
    applyState()
    measureOpen(startedAt, needsUpgrade)
  }

  const closeDrawer = (): void => {
    if (!open) return
    open = false
    domGate.pause(INTERACTION_PAUSE_MS)
    applyState()
    armColumnCompositing()
  }

  /**
   * 首屏之后主动做一次官方升级（图标 rail → 完整列表）。
   * 原来这次重渲染挂在第一次点汉堡上：手机上要等 AppFrame 换列 + SidebarRoot 重挂载 +
   * 会话列表重建（几百毫秒）才开始滑 —— 就是「点左侧菜单有点慢」的根因。
   */
  const armPreUpgrade = (): void => {
    if (preUpgraded || disposed) return
    if (frame === null) return
    if (!frame.hasAttribute(OFFICIAL_COLLAPSED_ATTR)) { preUpgraded = true; return }
    preUpgraded = true
    preUpgradeTimer = setTimeout(() => {
      preUpgradeTimer = null
      try {
        if (frame !== null && frame.hasAttribute(OFFICIAL_COLLAPSED_ATTR)) options.expandSidebar?.()
      } catch { /* 升级失败：开抽屉时会照旧同步补做 */ }
    }, PRE_UPGRADE_MS)
  }

  const onBackdropClick = (): void => closeDrawer()

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && open) closeDrawer()
  }

  /** Outside taps close the drawer (the backdrop itself is click-through). */
  const onDocumentPointerDown = (event: Event): void => {
    if (!open) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target === toggle || target === backdrop) return
    /* Portaled popups (account menu / workspace menus / session kebab) are
       children of document.body, i.e. outside the drawer DOM. Without this
       exemption the first tap on a menu item closes the drawer — and the sheet
       that tap opens (the host settings dialog is a body-level portal too, see
       mobile.css.ts) lands on screen while the drawer slides away underneath.
       Issue #72's guard, re-armed here because the drawer chrome is plain DOM
       now, not the old MobileNavOverlay. */
    if (isOverlayTap(target)) return
    /* 抽屉里的点击（导航行 / 会话行 / 抽屉页脚）先判：这条比 [aria-modal] 的全页
       querySelector 便宜得多，放前面。长会话详情有 ~2 万节点，整页扫描每次点击都要
       花掉几毫秒，正是抽屉开合时卡顿的组成部分。 */
    if (target.closest(`[${DRAWER_MARKER_ATTR}="open"] > :first-child`) !== null) return
    /* A modal dialog (the host settings sheet, the export dialog) owns the
       screen while it is up: its scrim swallows the tap anyway, and sliding the
       drawer out from under it would leave the user back at the conversation
       when they only meant to dismiss the sheet. Same guard the old
       MobileNavOverlay carried. */
    if (doc.querySelector('[aria-modal="true"]') !== null) return
    closeDrawer()
  }

  const buildChrome = (layer: HTMLElement): void => {
    if (backdrop === null) {
      backdrop = doc.createElement('div')
      backdrop.setAttribute('data-mobile-nav', 'backdrop')
      backdrop.setAttribute('aria-hidden', 'true')
      backdrop.addEventListener('click', onBackdropClick)
      layer.appendChild(backdrop)
      backdrop.style.display = open ? 'block' : 'none'
    }
    if (toggle === null) {
      toggle = doc.createElement('button')
      toggle.type = 'button'
      toggle.setAttribute('data-mobile-nav', 'toggle')
      toggle.setAttribute('aria-label', options.labels.menu)
      toggle.innerHTML = MENU_ICON
      toggle.style.position = 'fixed'
      toggle.style.top = 'calc(env(safe-area-inset-top, 0px) + 8px)'
      toggle.style.left = '8px'
      toggle.style.zIndex = '1201'
      toggle.addEventListener('click', () => (open ? closeDrawer() : openDrawer()))
      /* 按下去（pointerdown）就先把那一列提上合成层，别等 click 才 arm：合成层的创建
         要花一帧，提前 arm 才赶得上 0.28s 的开合滑行动画。 */
      toggle.addEventListener('pointerdown', () => { armColumnCompositing() })
      layer.appendChild(toggle)
    }
    syncLogButton()
  }

  /** Session-log download living at the bottom of the (official) drawer. */
  const syncLogButton = (): void => {
    const host = options.onDownloadSessionLog
    if (host === undefined) return
    const target = frame?.querySelector<HTMLElement>('[class*="sidebarCol"]') ?? null
    if (target === null) return
    if (logButton === null) {
      logButton = doc.createElement('button')
      logButton.type = 'button'
      logButton.setAttribute('data-mobile-nav', 'session-log')
      logButton.setAttribute('aria-label', options.labels.sessionLog)
      logButton.innerHTML = LOG_ICON
      logButton.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;gap:6px;' +
        'margin:8px 10px 0;padding:6px 10px;border-radius:8px;border:1px solid ' +
        'var(--dsw-alias-border-l1, rgba(0,0,0,.12));background:transparent;' +
        'color:var(--dsw-alias-label-secondary, inherit);font-size:12px'
      logButton.addEventListener('click', () => {
        try {
          options.onDownloadSessionLog?.()
        } catch {
          /* 下载失败不该影响抽屉 */
        }
      })
    }
    if (logButton.parentElement !== target) target.appendChild(logButton)
  }

  const attempt = (): void => {
    if (disposed) return
    syncFrame()
    const layer = overlayLayer()
    if (layer !== null) {
      buildChrome(layer)
      armPreUpgrade()
    } else if (tries < CHROME_RETRY_LIMIT) {
      tries += 1
      retryTimer = setTimeout(attempt, CHROME_RETRY_MS)
    }
  }

  const stopSwipe = mountDrawerSwipe({
    isDrawerOpen: () => open,
    onOpen: openDrawer,
    onClose: closeDrawer,
    doc,
  })

  doc.addEventListener('keydown', onKeyDown)
  doc.addEventListener('pointerdown', onDocumentPointerDown, true)
  attempt()
  applyState()

  return () => {
    disposed = true
    if (retryTimer !== null) clearTimeout(retryTimer)
    if (preUpgradeTimer !== null) { clearTimeout(preUpgradeTimer); preUpgradeTimer = null }
    if (willChangeTimer !== null) { clearTimeout(willChangeTimer); willChangeTimer = null }
    try {
      const column = drawerColumn()
      if (column !== null) column.style.willChange = 'auto'
    } catch { /* 样式撤不掉无所谓 */ }
    stopSwipe?.()
    doc.removeEventListener('keydown', onKeyDown)
    doc.removeEventListener('pointerdown', onDocumentPointerDown, true)
    backdrop?.remove()
    toggle?.remove()
    logButton?.remove()
    if (frame !== null) frame.removeAttribute(FRAME_MARKER_ATTR)
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * One-shot toast, plain DOM: 6 seconds, click-through, never covers the composer.
 * @param message - already localised text.
 * @param dismissLabel - already localised "got it" label.
 */
export function showHealToast(message: string, dismissLabel: string): void {
  try {
    const doc = globalThis.document
    doc.querySelector(`[${HEAL_TOAST_ATTR}]`)?.remove()
    const toast = doc.createElement('div')
    toast.setAttribute(HEAL_TOAST_ATTR, '1')
    toast.setAttribute('role', 'status')
    toast.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom, 0px) + 132px);' +
      'z-index:1301;pointer-events:none;display:flex;align-items:center;gap:8px;' +
      'padding:8px 10px;border-radius:10px;font-size:12px;line-height:1.4;' +
      'background:var(--dsw-alias-bg-elevated, #fff);color:var(--dsw-alias-label-primary, #111);' +
      'box-shadow:0 6px 18px rgba(0,0,0,.18)'
    const text = doc.createElement('span')
    text.textContent = message
    text.style.cssText = 'flex:1 1 auto'
    toast.appendChild(text)
    const dismiss = doc.createElement('span')
    dismiss.textContent = dismissLabel
    dismiss.style.cssText = 'flex:none;opacity:.65'
    toast.appendChild(dismiss)
    doc.body.appendChild(toast)
    setTimeout(() => toast.remove(), HEAL_TOAST_MS)
  } catch {
    /* toast 永远不能打断启动 */
  }
}