import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFolderOpenOutline16, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import type { DrawerController } from './MobileNavOverlay.tsx'

/** Full props for the session-header directory toggle. */
export interface MobileNavToggleProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
  /** 自持开合的抽屉控制器（见 drawer-state.mjs）；汉堡钮是抽屉的第二条召唤路径。 */
  drawer: DrawerController
}

/**
 * Mobile-only icon buttons next to the session title:
 * - toggle: opens / closes the directory drawer (改造 #3: kept as the top
 *   hamburger entry even though the FAB now stays resident — with the drawer
 *   shut the FAB and this button are the two visible summoners; on the
 *   hero / blank phases this header does not exist, so the FAB is the fallback).
 * - files: toggles the dsh-web-ui explorer sheet directly — one tap opens,
 *   a second tap closes it, no drawer round-trip. (The drawer footer keeps
 *   a Files entry for the hero/blank phases where this header does not
 *   exist.)
 * Hidden entirely on wide screens (CSS media query) unless the phone layout is
 * forced (body[data-dsh-pocket-layout="mobile"]).
 */
export function MobileNavToggle({ drawer, t }: MobileNavToggleProps) {
  // 只读 marker 的开关状态：aria-label 才跟真实状态一致（开着的汉堡钮是"收起"）。
  const [open, setOpen] = useState(() => drawer.getOpen())
  useEffect(() => drawer.subscribe(setOpen), [drawer])
  const toggleExplorer = (): void => {
    const frame = document.querySelector('[data-mobile-nav="frame"]')
    if (frame === null) return
    if (frame.hasAttribute('data-aionui-explorer-open')) {
      frame.removeAttribute('data-aionui-explorer-open')
    } else {
      frame.setAttribute('data-aionui-explorer-open', '')
    }
  }
  return (
    <>
      <button
        type="button"
        data-mobile-nav="toggle"
        aria-label={open ? t('close') : t('open')}
        title={open ? t('close') : t('open')}
        aria-expanded={open}
        onClick={() => { drawer.toggle() }}
      >
        <IconPanelLeftOutline16 size={16} />
      </button>
      <button
        type="button"
        data-mobile-nav="files"
        aria-label={t('files')}
        title={t('files')}
        onClick={toggleExplorer}
      >
        <IconFolderOpenOutline16 size={16} />
      </button>
    </>
  )
}
