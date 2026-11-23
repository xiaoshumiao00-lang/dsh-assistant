/**
 * 输入框旁边的「带引用」提示（2026-11-23 追加需求）。
 *
 * 用户原话：「我希望点击引用后在输入框有个提示，不然不知道是否有引用对话」。
 * 卡片脚部那颗引用按钮按下去之后，页面上原来只有按钮自己变勾 + 一句「已引用」（在卡里，很容易看漏）；
 * 这一颗把它挪到输入框旁边：`带引用` + `第 N 轮 · 这张卡是什么` + 那张卡正文开头一小段 + 一颗 × 取消。
 * 位置：宿主 `conversation.input.right`（与托管那颗胶囊同一槽位，就在输入框那一行）。
 * 样式：src/client/pocket/orb/secretary-cards.css.ts 里 `--dsh-squote-*` 数值与卡片脚部
 * 那棵复制/引用按钮同一套（同 muted 色、同 8px 圆角、同 hover、16px 图标 strokeWidth 1.6）。
 *
 * 三条收口口径（逐条对应要求）：
 *   - 没按引用 → 这个组件一个 DOM 都不出（quoteChipParts(null) → null，不留空壳、不出占位）；
 *   - 消息发出去 → secretary-cards.ts 的 noteLatestUserCard 把引用吃掉（只算真实用户行，通知行不算）；
 *   - 30 分钟 TTL 到期 → store 自己排的到期定时器收掉它（服务端那份也请它一起清）。
 * 另外：服务端路由答不上（宿主没重启 → 404）时照用 localStorage 那份，输入框提示与卡片按钮都不崩。
 */
import { useEffect, useState } from 'react'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import { COMPOSITION_GRACE_MS, domGate } from '../../compositionGate.ts'
import {
  QUOTE_CHIP_CANCEL_TEXT, quoteChipParts, quoteChipVisible, secretaryQuoteStore, type SecretaryQuoteStore,
} from './secretary-cards.ts'

/**
 * 引用 store 的版本订阅（只重排我们自己这颗胶囊，不碰 Lexical 那棵 contenteditable）。
 * 用户在输入框里打字 / 手机语音实时转写期间（domGate 让路窗口）这一帧不重排输入框那一棵树，
 * 等收尾窗过了再补一次——口径与托管那颗胶囊一样（见 tuoguan.tsx 的 domGate 用法）。
 */
function useQuoteStoreVersion(store: SecretaryQuoteStore): number {
  const [version, setVersion] = useState(store.getVersion())

  useEffect(() => {
    let pending: number | null = null
    const sync = (): void => { setVersion(store.getVersion()) }
    const off = store.subscribe(() => {
      if (domGate.isPaused()) {
        if (pending !== null) window.clearTimeout(pending)
        pending = window.setTimeout(() => { pending = null; sync() }, COMPOSITION_GRACE_MS + 120)
        return
      }
      sync()
    })
    sync()
    return () => {
      off()
      if (pending !== null) window.clearTimeout(pending)
    }
  }, [store])

  return version
}

function CancelQuoteIcon(): any {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12" />
      <path d="M18 6 12 18" />
    </svg>
  )
}

function QuoteGlyphIcon(): any {
  // 与卡片脚部那颗引用按钮同一个引号形图标（同 16px、同 strokeWidth 1.6）
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.4 6.8C6.6 8.4 5 10.9 5 13.8c0 2 1.4 3.5 3.2 3.5 1.7 0 3-1.3 3-3 0-1.7-1.3-3-3-3" />
      <path d="M18.6 6.8C15.8 8.4 14.2 10.9 14.2 13.8c0 2 1.4 3.5 3.2 3.5 1.7 0 3-1.3 3-3 0-1.7-1.3-3-3-3" />
    </svg>
  )
}

/**
 * 输入框那一行的引用提示。sessionId 由宿主槽位的 inject 工厂下发（与托管开关同一拿法）。
 * 只渲染固定秘书会话那一侧：别的会话、以及没有引用的任何时候，都是整个 return null。
 */
export function SecretaryQuoteChip({ sessionId }: { sessionId?: string }): any {
  const store = secretaryQuoteStore()
  const version = useQuoteStoreVersion(store)

  useEffect(() => {
    const id = String(sessionId ?? '')
    if (id === '') return
    store.setSession(id)
    void store.hydrate()
  }, [store, sessionId])

  const secretaryId = (() => { try { return String(peekSecretarySessionId() ?? '') } catch { return '' } })()
  if (!quoteChipVisible(secretaryId, sessionId)) return null
  const record = store.active()
  const parts = quoteChipParts(record)
  if (parts === null || record === null) return null

  const onCancel = (event: any): void => {
    event?.stopPropagation?.()
    store.clearQuote(record.cardKey)
  }

  return (
    <div
      data-dsh-squote="chip"
      data-dsh-squote-kind={record.kind}
      data-dsh-squote-key={record.cardKey}
      data-quote-version={version}
      role="status"
      aria-live="polite"
      aria-label={parts.label}
      title={parts.label}
    >
      <span data-dsh-squote="flag">
        <QuoteGlyphIcon />
        <span data-dsh-squote="flag-text">{parts.flag}</span>
      </span>
      {/* 「· 卡片种类」这一截由 CSS 按档收放：粗指针那一档（手机）与窄桌面那一档（宿主那一行 ≤ 720px，容器查询）都收掉，
          只留「第 N 轮」——卡片本身已经看得出是什么卡，而且提示条不许把宿主那一行顶成第二行；宽桌面那一档整段照露。
          aria/tooltip 那份全文（parts.label）不受这一档影响。 */}
      <span data-dsh-squote="meta">
        {parts.turnLabel}
        <span data-dsh-squote="meta-kind"> · {parts.kindLabel}</span>
      </span>
      {parts.preview !== '' && <span data-dsh-squote="preview">{parts.preview}</span>}
      <button
        type="button"
        data-dsh-squote="cancel"
        aria-label={QUOTE_CHIP_CANCEL_TEXT}
        title={`${QUOTE_CHIP_CANCEL_TEXT}：下一条消息就不带引用（服务端那份也一起清）`}
        onClick={onCancel}
      >
        <CancelQuoteIcon />
      </button>
    </div>
  )
}