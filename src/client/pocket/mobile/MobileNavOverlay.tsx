import { useEffect, useLayoutEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import {
  DRAWER_SELECTOR,
  TOGGLE_SELECTOR,
  isOverlayTap,
  navTargetFor,
} from './nav-targets.mjs'
import {
  OFFICIAL_COLLAPSED_ATTR,
  clearDrawerMarker,
  findFrame,
  isDrawerOpenFrame,
  isOfficialSidebarCollapsed,
  shouldMirrorOfficialCollapse,
} from './drawer-state.mjs'
import { mountDrawerSwipe } from './swipe.mjs'

/**
 * 抽屉控制器的最小形状（实现见 drawer-state.mjs 的 createDrawerController）。
 * 会话头汉堡、浮动按钮、左边缘手势、Esc / 点抽屉外 / 点导航行 —— 六个关闭路径
 * 共用一个实例，开合状态只有一份，不再各自镜像官方 layout store。
 */
export interface DrawerController {
  getOpen: () => boolean
  open: () => boolean
  close: () => boolean
  toggle: () => boolean
  sync: () => boolean
  subscribe: (listener: (open: boolean) => void) => () => void
}

/** Full props for the shell overlay entry. */
export interface MobileNavOverlayProps extends PropsRuntime<'shell.overlay'>, PropsLocale<typeof NS> {
  /** 自持开合的抽屉控制器（marker + localStorage + 一次性"升到展开"）。 */
  drawer: DrawerController
  /** ?dsh-layout=mobile / 三态开关选了「抽屉」：宽屏也走抽屉，matchMedia 不再是判据。 */
  forceMobile: boolean
}

/** Same breakpoint as the shell's SIDEBAR_AUTO_COLLAPSE (viewport < 1024). */
const MOBILE_QUERY = '(max-width: 1023px)'

/** Live matchMedia hook for the narrow breakpoint (forced mobile pins it true). */
function useMobile(forced: boolean): boolean {
  const [mobile, setMobile] = useState(() => forced || window.matchMedia(MOBILE_QUERY).matches)
  useEffect(() => {
    if (forced === true) {
      setMobile(true)
      return
    }
    const query = window.matchMedia(MOBILE_QUERY)
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    setMobile(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [forced])
  return mobile
}

/** 带我们 marker 的 AppFrame（marker 缺失 = 这套抽屉规则整体不成立）。 */
function markedFrame(): Element | null {
  return document.querySelector('[data-mobile-nav="frame"]')
}

/**
 * 卸载 / 退回宽屏时擦掉我们打在 frame 上的两个 marker。
 * `data-mobile-nav="frame"` 一没，所有抽屉规则（含离屏基态）都不再命中，宽屏
 * 完全退回官方原样；`data-dshp-drawer` 一没，CSS 的开态选择器自然不匹配。
 */
function clearFrameMarkers(frame: Element | null): void {
  if (frame === null) return
  frame.removeAttribute('data-mobile-nav')
  clearDrawerMarker(frame)
}

/**
 * Mobile shell overlay: owns the `data-mobile-nav` marker on the AppFrame
 * element (the CSS restructure keys off it), keeps React in sync with the
 * drawer controller's open state, and renders the dimmed backdrop plus the
 * floating directory button.
 *
 * 开合不再镜像官方的 `data-sidebar-collapsed`（改造 #1/#5）：那个属性来自不持久化的
 * 官方 store（刷新后必回"收起"，记住上次开合做不到），而且它的"收起"会把侧栏 DOM
 * 换成只剩图标的 rail —— 抽屉里就没菜单了。现在 CSS 只认 `[data-dshp-drawer="open"]`
 * （由 drawer-state.mjs 写），官方 toggleSidebar() 只在"把 rail 升成完整列表"时调
 * 一次，绝不降回（那条开关在桌面端归用户自己）。
 */
export function MobileNavOverlay({ drawer, forceMobile, t }: MobileNavOverlayProps) {
  const mobile = useMobile(forceMobile)
  const [open, setOpen] = useState(() => drawer.getOpen())

  // React 状态跟着控制器走：backdrop 与 FAB 的显隐由此驱动（三个入口谁按都一样）。
  useEffect(() => {
    setOpen(drawer.getOpen())
    return drawer.subscribe(setOpen)
  }, [drawer])

  // Frame ownership + marker 生命周期。宽屏（auto 模式）时这个 effect 完全惰性：
  // marker 不写，抽屉规则也就不会命中。
  useLayoutEffect(() => {
    if (!mobile) {
      // 从窄屏拖回宽屏：擦掉 marker，离屏基态与 rail 布局都退回官方原样。
      clearFrameMarkers(markedFrame())
      setOpen(false)
      return
    }
    const frame = findFrame()
    if (frame === null) return
    frame.setAttribute('data-mobile-nav', 'frame')
    // marker ← localStorage（读不到 = closed，即默认抽屉收起；上次是开的就保持开，
    // 这也是"刷新后记住开合"这件事官方 store 做不到的原因）。
    drawer.sync()
    // 反向同步（只跟不抢）：别人把官方侧栏降回 collapsed 时，侧栏 DOM 会退化成
    // 48px 图标 rail（悬浮球入口 OrbEntry、第三方自建抽屉、桌面端用户自己收起），
    // 我们的抽屉若还标着 open 就等于把一条 rail 滑进屏幕 → 跟着关掉抽屉。
    // 我们**从不**主动调 toggleSidebar() 去降回收起，只是跟随已经发生的降级；
    // 下次开抽屉时 shouldUpgradeOfficialSidebar 会再升一次，自洽。
    // 观察者只盯这一个元素的这一个属性 —— 和被删掉的旧镜像观察同量级，
    // 不是 documentElement 全树扫描。
    const observer = new MutationObserver(() => {
      if (shouldMirrorOfficialCollapse(isDrawerOpenFrame(frame), isOfficialSidebarCollapsed(frame))) {
        drawer.close()
      }
    })
    observer.observe(frame, { attributes: true, attributeFilter: [OFFICIAL_COLLAPSED_ATTR] })
    return () => {
      observer.disconnect()
      clearFrameMarkers(frame)
    }
  }, [mobile, drawer])

  // 手势召唤（改造 #3）：左边缘右滑开、抽屉内左滑关。passive 监听，不
  // preventDefault，绝不劫持 [data-mobile-nav="stats"] 的横向滚动（判定见 swipe.mjs）。
  useEffect(() => {
    if (!mobile) return
    return mountDrawerSwipe({
      isDrawerOpen: () => isDrawerOpenFrame(markedFrame()),
      onOpen: () => { drawer.open() },
      onClose: () => { drawer.close() },
      drawerSelector: DRAWER_SELECTOR,
    })
  }, [mobile, drawer])

  // Escape closes the drawer — but yields to an open modal dialog (e.g. the
  // settings panel), which owns its own Escape handling.
  useEffect(() => {
    if (!mobile || !open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.querySelector('[aria-modal="true"]') === null) drawer.close()
    }
    // Capture phase: run before the settings panel's own document-bubble Escape
    // handler, so the modal is still present when we yield to it.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [mobile, open, drawer])

  // Navigation inside the drawer closes it: tapping a session row or a
  // plugin takeover entry (task board / ssh) must hand the screen to the
  // content it just opened. Mouse clicks keep the direct close path. Touch
  // session rows close only after aria-selected changes, so live session
  // updates cannot strand a delayed click on a detached DOM target.
  //
  // Deliberately NOT closed by this rule:
  // - Settings / Session log: their dialogs render INSIDE the drawer DOM
  //   (portaled into the sidebar); closing the drawer would slide the dialog
  //   off-screen with it.
  // - Workspace folder rows (YDXeBa_projectRow), the logo: pure UI toggles,
  //   not navigation — see NAV_TARGETS in nav-targets.mjs.
  // - Anything while a modal dialog is open: the dialog owns the screen.
  useEffect(() => {
    if (!mobile || !open) return
    let lastTouchNavAt = 0
    let lastTouchX = 0
    let lastTouchY = 0
    let suppressTouchClickUntil = 0
    let pendingTouchRow: Element | null = null
    let selectedRowAtArm: Element | null = null
    let navClickArrived = false
    let navObserver: MutationObserver | null = null
    let navTimer: number | null = null

    const drawerRoot = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(DRAWER_SELECTOR)

    const disarmNav = (): void => {
      navObserver?.disconnect()
      navObserver = null
      if (navTimer !== null) window.clearTimeout(navTimer)
      navTimer = null
      pendingTouchRow = null
      selectedRowAtArm = null
      navClickArrived = false
    }

    const armNav = (row: Element): void => {
      disarmNav()
      pendingTouchRow = row
      const drawerEl = drawerRoot()
      selectedRowAtArm = drawerEl?.querySelector('[role="treeitem"][aria-selected="true"]') ?? null
      if (drawerEl === null) return
      navObserver = new MutationObserver(() => {
        const frame = markedFrame()
        // 开态判据换成自己的 marker（旧的 data-sidebar-collapsed 不再跟踪开合）。
        if (frame === null || !isDrawerOpenFrame(frame)) {
          disarmNav()
          return
        }
        const selectedRow = drawerRoot()?.querySelector('[role="treeitem"][aria-selected="true"]') ?? null
        if (navClickArrived && selectedRow !== null && selectedRow !== selectedRowAtArm) {
          disarmNav()
          drawer.close()
        }
      })
      navObserver.observe(drawerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-selected'],
      })
      navTimer = window.setTimeout(disarmNav, 2000)
    }

    const navigationTarget = (target: EventTarget | null): Element | null => {
      if (document.querySelector('[aria-modal="true"]') !== null) return null
      const frame = markedFrame()
      if (frame === null || !isDrawerOpenFrame(frame)) return null
      if (!(target instanceof Element)) return null
      const drawerEl = drawerRoot()
      if (drawerEl === null || !drawerEl.contains(target)) return null
      return navTargetFor(target)
    }

    const isPendingTouchClick = (event: MouseEvent): boolean => {
      const capabilities = (event as MouseEvent & {
        sourceCapabilities?: { firesTouchEvents?: boolean }
      }).sourceCapabilities
      if (capabilities?.firesTouchEvents === true) return true
      return Math.hypot(event.clientX - lastTouchX, event.clientY - lastTouchY) <= 24
    }

    const onDrawerClick = (event: MouseEvent): void => {
      // A touch row tap owns the close through the selection observer. Let the
      // browser click reach React without a capture-phase close racing it.
      if (performance.now() < suppressTouchClickUntil) return
      if (
        pendingTouchRow !== null
        && performance.now() - lastTouchNavAt < 500
        && isPendingTouchClick(event)
      ) {
        const target = navigationTarget(event.target)
        const row = target?.closest('[role="treeitem"]')
        if (row !== null && row !== undefined) {
          pendingTouchRow = row
          navClickArrived = true
          return
        }
      }
      if (navigationTarget(event.target) !== null) drawer.close()
    }

    const onDrawerPointerUp = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
      const target = navigationTarget(event.target)
      if (target === null) return

      const row = target.closest('[role="treeitem"]')
      if (row !== null) {
        if (row.getAttribute('aria-selected') === 'true') {
          // Already-selected rows will not navigate; closing now is safe.
          suppressTouchClickUntil = performance.now() + 500
          drawer.close()
        } else {
          // Let React navigate first, then close on the selection mutation.
          lastTouchNavAt = performance.now()
          lastTouchX = event.clientX
          lastTouchY = event.clientY
          armNav(row)
        }
        return
      }

      // Non-row targets keep their existing click path; only host
      // session/search rows participate in the selected-state hand-off.
    }

    document.addEventListener('click', onDrawerClick, true)
    document.addEventListener('pointerup', onDrawerPointerUp, true)
    return () => {
      disarmNav()
      document.removeEventListener('click', onDrawerClick, true)
      document.removeEventListener('pointerup', onDrawerPointerUp, true)
    }
  }, [mobile, open, drawer])

  // Tap-outside closes the drawer (issue #38). The backdrop is now
  // pointer-events: none (pure dimming layer that never steals clicks), so
  // "tap the dimmed area to close" moves here: any click outside the drawer
  // (and outside the header toggle) closes it, keeping the standard
  // interaction while letting drawer contents receive clicks normally.
  // Capture phase: the close happens before the content processes the tap
  // (same first-tap-closes behaviour as before).
  useEffect(() => {
    if (!mobile || !open) return
    const onOutsideClick = (event: MouseEvent) => {
      if (document.querySelector('[aria-modal="true"]') !== null) return
      const target = event.target as HTMLElement | null
      if (target === null) return
      if (target.closest(TOGGLE_SELECTOR) !== null) return
      // Portaled overlays (issue #72): the workspace section's "视图选项" /
      // "添加工作区" and the session row kebab all open menus that live on
      // document.body — outside the drawer DOM. Without this exemption the
      // first tap on a menu item is eaten: the drawer slides away, the menu
      // unmounts with the sidebar, and the item's onClick never runs, so
      // every workspace control reads as "点了没反应" on a phone.
      if (isOverlayTap(target)) return
      const frame = markedFrame()
      if (frame === null || !isDrawerOpenFrame(frame)) return
      const drawerEl = document.querySelector<HTMLElement>(DRAWER_SELECTOR)
      if (drawerEl !== null && drawerEl.contains(target)) return
      drawer.close()
    }
    document.addEventListener('click', onOutsideClick, true)
    return () => document.removeEventListener('click', onOutsideClick, true)
  }, [mobile, open, drawer])

  if (!mobile) return null
  return (
    <>
      {open && (
        <div data-mobile-nav="backdrop" />
      )}
      {/* 改造 #3：FAB 常驻（只在抽屉开着时让位，由 CSS ${OPEN} 那条规则隐藏）。
          旧实现要求 [data-phase="active"] 不存在才显示（把 FAB 当"没有会话头时的
          备用入口"），结果手机上根本找不到召唤入口；而且那个观察者监听整棵
          documentElement 的 childList+attributes，是 2 万节点会话里最大的
          CPU 尖峰来源之一 —— 现在删掉，FAB 只跟 open 状态有关。 */}
      {!open && (
        <button
          type="button"
          data-mobile-nav="fab"
          aria-label={t('open')}
          title={t('open')}
          onClick={() => { drawer.open() }}
        >
          <IconPanelLeftOutline16 size={18} />
        </button>
      )}
    </>
  )
}
