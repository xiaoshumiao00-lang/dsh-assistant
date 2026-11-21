/**
 * 个人秘书页「用户卡」（2026-11-21 需求）：秘书页里真实用户发的消息做成一张卡，
 * 外壳与秘书回复卡同一套规格（宽 620px、16px 圆角、0.5px #E5E6EB 边、无阴影、脚部时间+复制），
 * 主题走冷蓝（浅蓝底 #EEF4FF、强调 #184A80，标识与芯片同色系，见 secretary-cards.css.ts 的 --dsh-card-* 变量）。
 *
 * 挂载与取证：
 *   - 卡片内容来自宿主那条用户行本身：`[data-chat-flow-kind="user"]` →
 *     `[data-slot="conversation.user.text.node"]` 的纯文本 run（不是本插件自制的会话页）；
 *   - 卡片经 React portal 挂进宿主用户行，行里出现卡片后 CSS 把宿主气泡收起来
 *     （带附件的行保留气泡，只收纯文本 run，附件芯片不丢）；
 *   - 合成通知（正文首行「系统通知，不是用户说的话」或带 `[[session:…]]` 引用行）
 *     由 collectSecretaryUserRows 挡在门外，保持宿主原样，不伪装成用户发的卡。
 *
 * 朗读按钮接现有那套状态机：每张卡自己的 key（userCardSpeechKey），换卡停上一条、
 * 单击暂停/继续、长按 600ms 从头重读；用户卡不自动朗读（自动朗读只属于秘书回复卡）。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CopyAnswerButton, ExpandCollapseButton } from './SecretaryReplyCard.tsx'
import { SecretarySpeakButton } from './SecretarySpeakButton.tsx'
import {
  CARD_KIND_USER, collectSecretaryUserRows, formatUserCardClock, parseUserCardBody, userCardSpeechKey,
  type SecretaryUserRow,
} from './secretary-cards.ts'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import { currentSessionViaBridge } from '../../session-open.ts'

/** 折叠态只显示前 3 个正文块（与秘书回复卡同一套折叠规格）。 */
const FOLD_BLOCK_LIMIT = 3
/** 用户行文本块之间的间距，与 CSS 的 content gap 一致。 */
const FOLD_GAP = 10
const SCAN_DEBOUNCE_MS = 120
/** 尾行与正文同帧挂载，但宿主分页可能晚一拍：兜底再扫一次。 */
const RESCAN_DELAY_MS = 400

/** 当前页面是不是个人秘书会话页（与 orb-apply 的 body 标记同一套判据）。 */
function secretaryPageActive(): boolean {
  try {
    if (document.body.dataset.dshSecretary === '1') return true
    const secretary = peekSecretarySessionId()
    const current = currentSessionViaBridge()
    return secretary !== '' && current !== '' && current === secretary
  } catch {
    return false
  }
}

function cardAttached(row: SecretaryUserRow): boolean {
  try {
    return row.element.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="user"]') !== null
  } catch {
    return false
  }
}

/** 同一批用户行（key、正文、时间、容器都一致）就不用换状态，避免 observer 触发重渲染风暴。 */
function sameRows(prev: SecretaryUserRow[], next: SecretaryUserRow[]): boolean {
  if (prev.length !== next.length) return false
  return prev.every((row, index) => {
    const other = next[index]
    return row.key === other.key && row.text === other.text && row.clockText === other.clockText && row.element === other.element
  })
}

function userCardTime(row: SecretaryUserRow): string {
  return formatUserCardClock(row.clockText)
}

/** 一张用户卡：与秘书回复卡同规格，正文就是用户原文。 */
function UserCardView({ row }: { row: SecretaryUserRow }): any {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const [collapsedMaxHeight, setCollapsedMaxHeight] = useState<number | undefined>(undefined)
  const blocks = parseUserCardBody(row.text)
  const collapsedBlockCount = Math.min(FOLD_BLOCK_LIMIT, blocks.length)
  const speechKey = userCardSpeechKey(row.key, row.turnNo)
  const timeText = userCardTime(row)

  useEffect(() => {
    const el = contentRef.current
    if (el === null) return
    const measure = (): void => {
      const blockEls = [...el.querySelectorAll('[data-dsh-scard="para"]')] as HTMLElement[]
      const visible = blockEls.slice(0, collapsedBlockCount)
      const blockHeight = visible.reduce((sum, item) => sum + item.offsetHeight, 0)
      const collapsedHeight = blockHeight + Math.max(0, visible.length - 1) * FOLD_GAP
      setCollapsedMaxHeight(collapsedHeight)
      setOverflow(blockEls.length > collapsedBlockCount || el.scrollHeight > collapsedHeight + 1)
    }
    measure()
    const timer = window.setTimeout(measure, RESCAN_DELAY_MS)
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', onResize) }
  }, [collapsedBlockCount, open, row.text])

  const bodyStyle = open ? undefined : (collapsedMaxHeight === undefined ? undefined : { maxHeight: `${collapsedMaxHeight}px` })
  if (blocks.length === 0) return null
  return (
    <article
      data-dsh-scard="card"
      data-dsh-scard-kind={CARD_KIND_USER}
      data-dsh-scard-turn={row.turnNo}
      data-empty="0"
      data-open={open ? '1' : '0'}
      data-overflow={overflow ? '1' : '0'}
      aria-label="你的消息"
    >
      <div data-dsh-scard="head">
        <div data-dsh-scard="identity">
          <span data-dsh-scard="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 12a4 4 0 1 0 0-6.5 4 4 0 0 0 0 6.5z" />
              <path d="M4.8 19.5a7.2 7.2 0 0 1 14.4 0" />
            </svg>
          </span>
          <span data-dsh-scard="name">你</span>
          <span data-dsh-scard="tag">用户消息</span>
        </div>
        <SecretarySpeakButton speakKey={speechKey} rawText={row.text} labelBase="朗读这条消息" />
      </div>
      <div data-dsh-scard="body">
        <div data-dsh-scard="content" ref={contentRef as any} style={bodyStyle}>
          {blocks.map((block, index) => (<p key={`para:${index}`} data-dsh-scard="para">{block}</p>))}
        </div>
      </div>
      <div data-dsh-scard="foot">
        <time data-dsh-scard="time">{timeText}</time>
        <div data-dsh-scard="actions">
          <CopyAnswerButton fullText={row.text} label="复制这条消息" />
          {overflow && <span data-dsh-scard="separator" aria-hidden="true" />}
          <ExpandCollapseButton open={open} overflow={overflow} collapseTitle="收起正文" onToggle={() => setOpen((value) => !value)} />
        </div>
      </div>
    </article>
  )
}

/**
 * 用户卡挂载层（挂在 shell.overlay，整页常驻）：扫对话流里的真实用户行，
 * 每行 portal 一张卡；行被宿主重画、卡片被外间改动抹掉时靠 MutationObserver 自愈。
 */
export function SecretaryUserCards(): any {
  const [rows, setRows] = useState<SecretaryUserRow[]>([])
  const [rev, setRev] = useState(0)

  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const scan = (): void => {
      if (!alive) return
      if (!secretaryPageActive()) {
        setRows((prev) => (prev.length === 0 ? prev : []))
        return
      }
      const next = collectSecretaryUserRows(document)
      const missing = next.some((row) => !cardAttached(row))
      setRows((prev) => (sameRows(prev, next) ? prev : next))
      if (missing) setRev((value) => value + 1)
    }
    const schedule = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => { timer = null; scan() }, SCAN_DEBOUNCE_MS)
    }
    scan()
    const initial = window.setTimeout(() => { timer = null; scan() }, RESCAN_DELAY_MS)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-dsh-secretary', 'data-chat-turn', 'class'],
    })
    return () => {
      alive = false
      observer.disconnect()
      window.clearTimeout(initial)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  if (rows.length === 0) return null
  return (
    <>
      {rows.map((row) => {
        const portalKey = `${row.key}#${rev}`
        return createPortal(<UserCardView row={row} />, row.element, portalKey)
      })}
    </>
  )
}
