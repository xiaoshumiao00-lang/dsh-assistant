import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconDownloadOutline16, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import { nextLayoutOnWidth, readStoredLayout, writeLayout } from './layout-mode.mjs'
import type { DrawerController } from './MobileNavOverlay.tsx'

/** Full props for the sidebar footer action entry. */
export interface MobileDrawerFooterProps extends PropsRuntime<'sidebar.footer.action'>, PropsLocale<typeof NS> {
  /** Bound ctx.sessionLogDownload.download() for the current session. */
  downloadSessionLog: (sessionId: string) => void
  /** 自持开合的抽屉控制器：打开文件面板时把抽屉让位（见 drawer-state.mjs）。 */
  drawer: DrawerController
}

/** 存储值 → 文案 key（'' = 自动按屏宽）。 */
const LAYOUT_LABEL_KEYS: Record<string, 'layoutAuto' | 'layoutDrawer' | 'layoutDesktop'> = {
  '': 'layoutAuto',
  'mobile': 'layoutDrawer',
  'desktop': 'layoutDesktop',
}

/**
 * Mobile-only drawer footer actions, relocated from the session header to the
 * drawer footer (beside Settings):
 * - Files: opens the dsh-web-ui aionui explorer as a floating bottom sheet
 *   (the explorer column is hidden on mobile until this marker is set, so
 *   the suite's own persisted-expanded state can never cover the UI on load).
 * - Session log: the official session-log-export controller, so the
 *   progress/result dialog is shared with the desktop flow.
 * - Layout (改造 #5): 三态布局快切，自动 → 抽屉 → 电脑 → 自动，写的是和
 *   「手机访问」设置页分段控件、右下角布局徽章同一个 localStorage key。
 *   这里**不**自动刷新（连点三次要刷三次），只提示"刷新后生效"；徽章那条
 *   路径是选完立即 reload，因为它是卡死自救的逃生舱。
 * Hidden entirely on wide screens (CSS media query) unless the phone layout is
 * forced (body[data-dsh-pocket-layout="mobile"]).
 */
export function MobileDrawerFooter({ useSessions, downloadSessionLog, drawer, t }: MobileDrawerFooterProps) {
  const sessionId = useSessions((state) => state.current)
  const [layout, setLayout] = useState(() => readStoredLayout())
  const [justSwitched, setJustSwitched] = useState(false)
  const openExplorer = (): void => {
    document.querySelector('[data-mobile-nav="frame"]')?.setAttribute('data-aionui-explorer-open', '')
    drawer.close()
  }
  const cycleLayout = (): void => {
    // 只在三个值里轮：读不到值时也给 'mobile'（自动 → 抽屉）。
    // 窄于 1024（官方 SIDEBAR_AUTO_COLLAPSE 那条线）时跳过「电脑」这一档：
    // 这颗钮就在抽屉里，直板机横屏也有 740-900，误触两下就变成常驻 48px rail，
    // 与"手机端必须永远能拿到抽屉"冲突。真要电脑布局的人走右下角徽章 / 设置页，
    // 那里有 <1024 的二次确认（判据与 nextLayoutOnWidth 都在 layout-mode.mjs）。
    const next = nextLayoutOnWidth(layout, window.innerWidth)
    writeLayout(next)
    setLayout(next)
    setJustSwitched(true)
  }
  return (
    <div data-mobile-nav="drawer-actions">
      <button
        type="button"
        data-mobile-nav="explorer"
        aria-label={t('files')}
        title={t('files')}
        onClick={openExplorer}
      >
        <IconPanelLeftOutline16 size={14} />
        <span>{t('files')}</span>
      </button>
      <button
        type="button"
        data-mobile-nav="session-log"
        aria-label={t('sessionLog')}
        title={t('sessionLog')}
        disabled={sessionId === undefined}
        onClick={() => {
          if (sessionId !== undefined) downloadSessionLog(sessionId)
        }}
      >
        <IconDownloadOutline16 size={14} />
        <span>{t('sessionLog')}</span>
      </button>
      <button
        type="button"
        data-mobile-nav="layout"
        aria-label={`${t('layout')}: ${t(LAYOUT_LABEL_KEYS[layout] ?? LAYOUT_LABEL_KEYS[''])}`}
        title={`${t('layout')}: ${t(LAYOUT_LABEL_KEYS[layout] ?? LAYOUT_LABEL_KEYS[''])} — ${t('layoutSwitchHint')}`}
        onClick={cycleLayout}
      >
        <LayoutGlyph />
        <span>{t('layout')} · {t(LAYOUT_LABEL_KEYS[layout] ?? LAYOUT_LABEL_KEYS[''])}</span>
      </button>
      {justSwitched && (
        <span data-mobile-nav="layout-hint" style={{ flex: '1 1 100%', fontSize: 11, opacity: .7 }}>
          {t('layoutReloadHint')}
        </span>
      )}
    </div>
  )
}

/**
 * 布局切换的图标：手机屏 + 桌面板的两块拼图（内联 SVG）。
 * 不用 dsh-client-ui-primitives 的图标是故意的 —— 那个包在构建里是 external，
 * 名字写错只会在运行时炸，而这里要的语义（手机/电脑切换）没有可确认存在的现成图标。
 */
function LayoutGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.2" y="2.2" width="8.6" height="11.6" rx="1.6" />
      <path d="M4.6 12.2h2" />
      <path d="M11.4 5.4h3.4v6.2h-3.4z" />
      <path d="M12.2 12.6h2" />
    </svg>
  )
}
