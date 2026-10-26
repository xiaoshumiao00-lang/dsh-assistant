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

/** Frame marker value that switches the drawer stylesheet on. */
export const FRAME_MARKER_ATTR = 'data-mobile-nav'
/** The official overlay layer that hosts the backdrop / FAB / hamburger. */
export const OVERLAY_SELECTOR = '[data-shell-overlay]'
/** One-shot "layout was healed" toast, removed after HEAL_TOAST_MS. */
export const HEAL_TOAST_ATTR = 'data-dshp-heal-toast'
export const HEAL_TOAST_MS = 6000
export const CHROME_RETRY_MS = 250
export const CHROME_RETRY_LIMIT = 48

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

  const openDrawer = (): void => {
    if (!open) {
      open = true
      /* Only ever upgrade the official rail into the full menu. */
      if (frame !== null && frame.hasAttribute(OFFICIAL_COLLAPSED_ATTR)) {
        try {
          options.expandSidebar?.()
        } catch {
          /* 展开失败不影响抽屉本身 */
        }
      }
    }
    applyState()
  }

  const closeDrawer = (): void => {
    open = false
    applyState()
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
    /* A modal dialog (the host settings sheet, the export dialog) owns the
       screen while it is up: its scrim swallows the tap anyway, and sliding the
       drawer out from under it would leave the user back at the conversation
       when they only meant to dismiss the sheet. Same guard the old
       MobileNavOverlay carried. */
    if (doc.querySelector('[aria-modal="true"]') !== null) return
    if (target.closest(`[${DRAWER_MARKER_ATTR}="open"] > :first-child`) !== null) return
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