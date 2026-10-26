// 抽屉底部的「悬浮球」入口（与 文件/会话日志 同排）。点击打开悬浮球页并收起抽屉。
import type { OrbKey } from './locales.ts'
import { orbStore } from './state.ts'

export interface OrbEntryProps {
  /** Bound ctx.layout.toggleSidebar()：抽屉展开时把它收掉。 */
  toggleSidebar: () => void
  t: (key: OrbKey) => string
}

export function OrbEntry({ toggleSidebar, t }: OrbEntryProps) {
  return (
    <button
      type="button"
      data-mobile-nav="orb"
      aria-label={t('open')}
      title={t('open')}
      onClick={() => {
        orbStore.setOpen(true, 'drawer-entry')
        toggleSidebar()
      }}
    >
      <span>🔮</span>
      <span>{t('open')}</span>
    </button>
  )
}
