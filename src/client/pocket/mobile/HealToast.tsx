import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

/**
 * auto-heal 的**短暂**提示（本轮改写：常驻的「布局」浮标胶囊已按用户要求删掉）。
 *
 * 存在理由：残留的 `dsh-pocket.layout='desktop'` 被自动清掉、切回抽屉布局时，
 * 必须告诉用户"刚才不是你选的布局，是我们自救的结果"，否则他会以为手机自己变了。
 *
 * 为什么不是常驻控件（用户原话：不希望有右下角的布局小胶囊）：
 *   - 几秒后自动消失，且整块不参与命中（pointer-events: none），
 *     所以永远不会压住 composer、输入框或状态行；
 *   - 三态布局开关唯一的常驻入口是 pocket 设置页「手机访问」分区
 *     （client/index.jsx），手机上够得着。
 *
 * 定位：FAB 在 right 14px / 38px 宽 / bottom safe+92px（见 mobile.css.ts 的几何带注释：
 * 下沿 8px composer 内边距 + 28px 状态行 ≈36px）。提示条走**更上一档** bottom safe+132px，
 * 右边界避开 FAB 那条 48px 带 → 两者不重叠、也不覆盖输入区。
 * 样式全内联：不依赖 MOBILE_CSS 有没有注入（heal 只发生在抽屉分支，但保持独立更安全）。
 */

/** sessionStorage：同一次会话里只提示一次，避免反复刷新时刷屏。 */
const HEAL_NOTICE_KEY = 'dsh-pocket.layout-healed'

/** 自动消失时长（毫秒）。够读完一句话，又不会常驻。 */
const AUTO_DISMISS_MS = 6000

const toastStyle: CSSProperties = {
  position: 'fixed',
  left: 12,
  right: 'calc(14px + 38px + 10px)',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 132px)',
  zIndex: 1301,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderLeft: '4px solid var(--dsw-alias-state-warn-primary, #b45309)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2, rgba(243, 244, 246, .96))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: 12,
  lineHeight: 1.5,
  boxShadow: '0 6px 24px rgba(0, 0, 0, .18)',
  // 整块默认不吃点击：它只是告知，不该挡住底下的输入区。
  pointerEvents: 'none',
}

const dismissStyle: CSSProperties = {
  // 唯一例外：这颗「知道了」要能点，所以单独把它放回命中链。
  pointerEvents: 'auto',
  flex: '0 0 auto',
  height: 26,
  padding: '0 10px',
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .12))',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  fontFamily: 'inherit',
  fontSize: 12,
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
}

export interface HealToastProps {
  /** 本次加载是否触发了"残留电脑布局 → 自动切回手机抽屉"。 */
  healed: boolean
  /** 手机端判据（shouldShowLayoutBadge 算好的纯值）：真桌面上不必打扰。 */
  show: boolean
  /** pocket 词典的 t()（文案只在 pocket-locales.js 里）。 */
  t: (key: string) => string
}

/**
 * 短暂 heal 提示。全部 props 都是纯值（不依赖 store），所以注册时机最自由。
 * @param props - 见 HealToastProps。
 * @returns 需要提示时返回浮层，否则 null。
 */
export function HealToast({ healed, show, t }: HealToastProps) {
  const [visible, setVisible] = useState<boolean>(() => {
    if (!healed || !show) return false
    try {
      return globalThis.sessionStorage?.getItem(HEAL_NOTICE_KEY) !== '1'
    } catch {
      return true
    }
  })

  useEffect(() => {
    if (!visible) return () => {}
    try {
      globalThis.sessionStorage?.setItem(HEAL_NOTICE_KEY, '1')
    } catch {
      /* 无痕模式 / WebView 禁用存储：照样提示，只是可能重复一次 */
    }
    const timer = globalThis.setTimeout?.(() => setVisible(false), AUTO_DISMISS_MS)
    return () => {
      try {
        if (typeof timer === 'number') globalThis.clearTimeout?.(timer)
      } catch {
        /* 忽略 */
      }
    }
  }, [visible])

  if (!visible) return null
  return (
    <div data-dshp-heal-toast="" style={toastStyle}>
      <span style={{ flex: '1 1 auto' }}>{t('layoutHealedToast')}</span>
      <button type="button" style={dismissStyle} onClick={() => setVisible(false)}>
        {t('layoutHealedDismiss')}
      </button>
    </div>
  )
}
