/**
 * 个人秘书页「用户卡」+「通知卡」（2026-11-21 两批需求）：
 *   - 真实用户消息 → 冷蓝用户卡（kind=user，无未读红点）；
 *   - 插件塞进来的合成通知（「（系统通知，不是用户说的话）」开头或带 `[[session:…]]` 的合成行）
 *     → 中性灰通知卡（kind=notice，带未读红点、可点跳的会话引用 chip）；
 *   外壳与秘书回复卡同一套规格（宽 620px、16px 圆角、0.5px #E5E6EB 边、无阴影、脚部 HH:MM 时间 + 复制），
 *   折叠/字号/点卡展开三种卡一律共用 SecretaryReplyCard.tsx 那一套实现，不许各自漂移。
 *
 * 挂载与取证：
 *   - 卡片内容来自宿主那条用户行本身：`[data-chat-flow-kind="user"]` →
 *     `[data-slot="conversation.user.text.node"]` 的纯文本 run（不是本插件自制的会话页）；
 *   - 卡片经 React portal 挂进宿主用户行，行里出现卡片后 CSS 把宿主气泡收起来
 *     （带附件的行保留气泡，只收纯文本 run，附件芯片不丢）；
 *   - 三条路径的判据都在 collectSecretaryCardRows（secretary-cards.ts）里，测试逐条断言防止串味。
 *
 * 朗读按钮接现有那套状态机：每张卡自己的 key（user: / notice: 前缀），换卡停上一条、
 * 单击暂停/继续、长按 600ms 从头重读；用户卡不自动朗读（自动朗读只属于秘书回复卡与通知卡）。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CopyAnswerButton, ExpandCollapseButton, inlineAnswerText, turnEndTime, useCardFoldMeasure, useCardFoldRegion,
  useSecretaryReadState,
} from './SecretaryReplyCard.tsx'
import { CollapsedSecretaryCard, useSecretaryCardWindow, useSecretaryPagerVersion } from './SecretaryCollapsedCard.tsx'
import { SecretarySpeakButton } from './SecretarySpeakButton.tsx'
import {
  assistantCardSpeechKey, buildSecretaryPagerCards, CARD_KIND_NOTICE, CARD_KIND_USER, cardFoldStyle, collectSecretaryCardRows, formatClock,
  noticeCardSpeechKey, parseNoticeCardBody, parseSessionRefs, parseUserCardBody, secretaryPager, stripSessionRefs,
  userCardSpeechKey, EARLIER_HINT_TEXT, SCROLL_TOP_THRESHOLD_PX, scrollAnchorTopPatch, shouldExpandOnScroll,
  type PagerDomCard, type SecretaryCardRow,
} from './secretary-cards.ts'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import { currentSessionViaBridge } from '../../session-open.ts'
import type { OrbApi } from './orb-api.ts'

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

/** 秘书固定会话 id（已读集合按会话存，通知卡/回复卡都要靠它）。 */
function secretarySessionId(): string {
  try { return String(peekSecretarySessionId() ?? '') } catch { return '' }
}

/** 同一批用户行（key、正文、时间、容器都一致）就不用换状态，避免 observer 触发重渲染风暴。 */
function sameRows(prev: SecretaryCardRow[], next: SecretaryCardRow[]): boolean {
  if (prev.length !== next.length) return false
  return prev.every((row, index) => {
    const other = next[index]
    return row.key === other.key && row.text === other.text && row.clockText === other.clockText &&
      row.element === other.element && row.kind === other.kind
  })
}

function cardTimeText(row: SecretaryCardRow): string {
  // 宿主给的时间文本优先（真实用户行 / 通知行都有）；没有就退回轮次结束时间
  const hostClock = row.clockText
  if (hostClock !== '') return formatClock(toEpoch(hostClock))
  return ''
}

function toEpoch(clockText: string): string {
  const raw = String(clockText ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return ''
  const sameDay = raw.match(/^今天\s*([01]?\d|2[0-3]):([0-5]\d)$/)
  if (sameDay !== null) {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(Number(sameDay[1])).padStart(2, '0')}:${sameDay[2]}:00`
  }
  const bare = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (bare !== null) {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(Number(bare[1])).padStart(2, '0')}:${bare[2]}:00`
  }
  return raw
}

/** 一张卡（用户卡 / 通知卡）：与秘书回复卡同一套外壳与折叠实现。 */
function SecretaryMessageCard({ row, api }: { row: SecretaryCardRow; api?: OrbApi }): any {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const notice = row.kind === CARD_KIND_NOTICE
  const speechKey = notice ? noticeCardSpeechKey(row.key, row.turnNo) : userCardSpeechKey(row.key, row.turnNo)
  const readKey = notice ? speechKey : ''
  const readState = useSecretaryReadState(secretarySessionId())
  // 分页窗口：这张用户卡/通知卡完整渲染还是压成一行折叠行（hooks 一律在条件 return 之前）
  const windowState = useSecretaryCardWindow(speechKey)
  const blocks = notice ? parseNoticeCardBody(row.text) : { title: '', paragraphs: parseUserCardBody(row.text) }
  const refs = notice ? parseSessionRefs(row.text) : []
  // 复制拿的永远是这条消息的原文（用户卡不许改写；通知卡复制去掉内部合成标记，方便粘出去用）
  const copyText = notice ? stripSessionRefs(row.text) : row.text
  const hasBody = notice ? (blocks.title !== '' || blocks.paragraphs.length > 0) : blocks.paragraphs.length > 0
  const unread = notice && readKey !== '' && !readState.isRead(readKey)
  const timeText = cardTimeText(row)

  // 折叠态：与秘书回复卡共用同一套测量与补测（正文最多 3 行、卡标题最多 2 行、固定高度）
  const { overflow, collapsedMaxHeight, measured } = useCardFoldMeasure(contentRef, true, open, `${row.text}|${blocks.paragraphs.length}|${refs.length}`)

  const markRead = (): void => { if (readKey !== '') readState.markRead(readKey) }
  const toggle = (): void => { setOpen((value) => !value); markRead() }
  const { foldProps } = useCardFoldRegion(open, overflow, toggle)

  if (!hasBody && refs.length === 0) return null
  // 分页窗口外（比最近 30 张更旧）：这张卡压成一行折叠行，绝不把整张老卡拉回渲染
  if (windowState.collapsed) {
    return (
      <CollapsedSecretaryCard
        cardKey={speechKey}
        kind={notice ? CARD_KIND_NOTICE : CARD_KIND_USER}
        turnNo={row.turnNo}
        timeText={timeText}
        fallbackTitle={blocks.title}
        fallbackText={row.text}
      />
    )
  }
  // 折叠落点 → 内联样式（与秘书回复卡共用 cardFoldStyle：测量前不放开、没溢出才放开）
  const bodyStyle = cardFoldStyle(open, measured, collapsedMaxHeight)

  return (
    <article
      data-dsh-scard="card"
      data-dsh-scard-kind={notice ? CARD_KIND_NOTICE : CARD_KIND_USER}
      data-dsh-scard-turn={row.turnNo}
      data-dsh-scard-key={speechKey}
      data-empty="0"
      data-open={open ? '1' : '0'}
      data-overflow={overflow ? '1' : '0'}
      data-unread={unread ? '1' : '0'}
      aria-label={notice ? '系统通知' : '你的消息'}
    >
      {unread && <span data-dsh-scard="unread-dot" role="img" aria-label="未读" title="未读" />}
      <div data-dsh-scard="head">
        <div data-dsh-scard="identity">
          <span data-dsh-scard="mark" aria-hidden="true">
            {notice ? (
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3.2a5.4 5.4 0 0 0-5.4 5.4c0 4.2-1.6 5.9-1.6 6.4h14c0-.5-1.6-2.2-1.6-6.4A5.4 5.4 0 0 0 12 3.2z" />
                <path d="M9.8 18.4a2.4 2.4 0 0 0 4.4 0" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 12a4 4 0 1 0 0-6.5 4 4 0 0 0 0 6.5z" />
                <path d="M4.8 19.5a7.2 7.2 0 0 1 14.4 0" />
              </svg>
            )}
          </span>
          {notice ? <span data-dsh-scard="tag">系统 · 通知</span> : (
            <>
              <span data-dsh-scard="name">你</span>
              <span data-dsh-scard="tag">用户消息</span>
            </>
          )}
        </div>
        <SecretarySpeakButton
          speakKey={speechKey}
          rawText={row.text}
          labelBase={notice ? '朗读这条通知' : '朗读这条消息'}
          readKey={readKey || undefined}
        />
      </div>
      <div {...foldProps}>
        <div data-dsh-scard="content" ref={contentRef as any} style={bodyStyle}>
          {notice && blocks.title !== '' && <h1 data-dsh-scard="title">{inlineAnswerText(blocks.title)}</h1>}
          {blocks.paragraphs.map((block, index) => (
            <p key={`para:${index}`} data-dsh-scard="para">{notice ? inlineAnswerText(block) : block}</p>
          ))}
          {refs.map((ref) => (
            <button
              key={ref.sessionId}
              type="button"
              data-dsh-scard="ref"
              title={`打开会话：${ref.title}`}
              onClick={(event: any) => {
                event.stopPropagation()
                markRead()
                try { api?.openSession?.(ref.sessionId) } catch { /* 交给 focusSession 兜底 */ }
                void api?.focusSession?.(ref.sessionId).catch(() => {})
              }}
            >
              <span data-dsh-scard="ref-icon" aria-hidden="true">↗</span>
              <span data-dsh-scard="ref-title">{ref.title}</span>
            </button>
          ))}
          {overflow && !open && <span data-dsh-scard="ellipsis" aria-hidden="true">…</span>}
        </div>
      </div>
      <div data-dsh-scard="foot">
        <time data-dsh-scard="time">{timeText}</time>
        <div data-dsh-scard="actions">
          <CopyAnswerButton fullText={copyText} label={notice ? '复制这条通知' : '复制这条消息'} onCopied={markRead} />
          {overflow && <span data-dsh-scard="separator" aria-hidden="true" />}
          <ExpandCollapseButton open={open} overflow={overflow} collapseTitle="收起正文" onToggle={toggle} />
        </div>
      </div>
    </article>
  )
}

/** 行里是不是已经挂了我们自己的卡（完整卡或折叠行都算：折叠切换不该引起反复重挂）。 */
function rowHasCard(row: Element): boolean {
  return row.querySelector('[data-dsh-scard="card"], [data-dsh-scard="collapsed-row"]') !== null
}

/**
 * 对话流的滚动宿主：优先宿主自己标在 scrollport 上的 `[data-conversation-scroll]`，
 * 退路是从卡片往上找第一个真能滚的元素（宿主换标记了也不会瞎）。
 */
export function findConversationScrollHost(doc: Document): HTMLElement | null {
  const marked = doc.querySelector('[data-conversation-scroll]')
  if (marked instanceof HTMLElement) return marked
  const card = doc.querySelector('[data-dsh-scard="card"], [data-dsh-scard="collapsed-row"]')
  let node: Element | null = card?.parentElement ?? null
  while (node !== null) {
    if (node.scrollHeight > node.clientHeight + 8) return node as HTMLElement
    node = node.parentElement
  }
  const scrolling = doc.scrollingElement
  if (scrolling instanceof HTMLElement) return scrolling
  return doc.documentElement instanceof HTMLElement ? doc.documentElement : null
}

/** 等 DOM 真的长够了再补 scrollTop：连续量到 scrollHeight 不再变为止（最多 16 轮 rAF）。 */
function settleScrollHeight(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let attempts = 0
    let previous = -1
    let stable = 0
  const step = (): void => {
      const current = el.scrollHeight
      stable = current === previous ? stable + 1 : 0
      previous = current
      attempts += 1
      if ((stable >= 2 && attempts >= 3) || attempts >= 16) { resolve(); return }
      window.requestAnimationFrame(step)
    }
    window.requestAnimationFrame(step)
  })
}

/**
 * 渲染上限用完（或宿主说没有更旧的了）时显示的那一行提示。
 * 直接插在渲染区前面（不用 React portal）：宿主重画对话流时扫描层会再补一次，幂等。
 */
export function syncEarlierHint(doc: Document, visible: boolean): void {
  const existing = doc.querySelector('[data-dsh-scard="earlier-hint"]')
  if (!visible) {
    try { existing?.parentNode?.removeChild(existing) } catch { /* 已经被宿主重画掉了 */ }
    return
  }
  const cards = doc.querySelectorAll('[data-dsh-scard="card"], [data-dsh-scard="collapsed-row"]')
  const first = cards[0]
  const container = first?.parentElement
  if (container === null || container === undefined) {
    try { existing?.parentNode?.removeChild(existing) } catch { /* 没地方放就先不放在 */ }
    return
  }
  if (existing !== null && existing.parentNode === container && container.firstChild === existing) return
  try { existing?.parentNode?.removeChild(existing) } catch { /* 挪位置：先摘掉再插到最前 */ }
  const hint = doc.createElement('div')
  hint.setAttribute('data-dsh-scard', 'earlier-hint')
  hint.setAttribute('data-dsh-scard-kind', 'notice')
  const text = doc.createElement('span')
  text.setAttribute('data-dsh-scard', 'earlier-hint-text')
  text.textContent = EARLIER_HINT_TEXT
  hint.appendChild(text)
  container.insertBefore(hint, container.firstChild ?? null)
}

/**
 * 挂载层（挂在 shell.overlay，整页常驻）：扫对话流里的 user 角色行，
 * 真实用户行 portal 一张冷蓝用户卡、合成通知行 portal 一张灰底通知卡；
 * 行被宿主重画、卡片被外间改动抹掉时靠 MutationObserver 自愈。
 *
 * 分页（第四批需求 A）：这一层是唯一持有分页 store 的地方——
 *   - 每次扫描把页面上已有的卡（完整卡 + 折叠行）按 document 顺序送进 pager；
 *   - 进页面/刷新/恢复选择只取最近一段（ensureWindow），绝不自动回填老卡；
 *   - 只有滚动到达顶部阈值才 expandOlder 取下一段，取回后用 scroll-anchoring 补回 scrollTop，位置不跳；
 *   - 到 CARD_RENDER_CAP 就停，并把「更早的内容请到轨迹/搜索里看」插在渲染区前面。
 */
export function SecretaryUserCards({ api }: { api?: OrbApi }): any {
  const [rows, setRows] = useState<SecretaryCardRow[]>([])
  const [rev, setRev] = useState(0)
  const pager = secretaryPager()
  const pagerVersion = useSecretaryPagerVersion()
  const expandingRef = useRef(false)

  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const scan = (): void => {
      if (!alive) return
      if (!secretaryPageActive()) {
        setRows((prev) => (prev.length === 0 ? prev : []))
        syncEarlierHint(document, false)
        return
      }
      const next = collectSecretaryCardRows(document)
      const domCards: PagerDomCard[] = buildSecretaryPagerCards(document)
      pager.setSession(secretarySessionId())
      pager.noteDomCards(domCards)
      // 只取最近一段（幂等）：绝不在这里回填更旧的卡
      void pager.ensureWindow()
      const missing = next.some((row) => !rowHasCard(row.element))
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

  // 上滚才取回下一段：只有 scrollTop 到达顶部阈值才触发，别的滚法一概不取
  useEffect(() => {
    let attached: HTMLElement | null = null
    let frame = 0
    const onScroll = (): void => {
      const el = attached
      if (el === null) return
      const state = pager.state()
      // 唯一判据（口径在 secretary-card-shared.ts）：到顶部阈值、有更旧的、没到上限、没在取数、没在扩段
      if (!shouldExpandOnScroll({
        scrollTop: el.scrollTop,
        threshold: SCROLL_TOP_THRESHOLD_PX,
        hasMore: state.hasMore,
        capped: state.capped,
        loading: state.loading,
        alreadyExpanding: expandingRef.current,
      })) return
      expandingRef.current = true
      const beforeTop = el.scrollTop
      const beforeHeight = el.scrollHeight
      void Promise.resolve(pager.expandOlder()).then(async () => {
        await settleScrollHeight(el)
        const delta = scrollAnchorTopPatch(beforeHeight, el.scrollHeight)
        if (delta > 0) el.scrollTop = beforeTop + delta
        expandingRef.current = false
      }, () => { expandingRef.current = false })
    }
    const attach = (): void => {
      const el = findConversationScrollHost(document)
      if (el === attached) return
      if (attached !== null) attached.removeEventListener('scroll', onScroll)
      attached = el
      if (el !== null) el.addEventListener('scroll', onScroll, { passive: true })
    }
    attach()
    const observer = new MutationObserver(() => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => { frame = 0; attach() })
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== 0) window.cancelAnimationFrame(frame)
      if (attached !== null) attached.removeEventListener('scroll', onScroll)
    }
  }, [pager])

  useEffect(() => {
    syncEarlierHint(document, pager.hintVisible())
  }, [pager, pagerVersion, rows.length, rev])

  useEffect(() => () => { try { syncEarlierHint(document, false) } catch { /* 卸载时的 DOM 已经没了 */ } }, [])

  if (rows.length === 0) return null
  return (
    <>
      {rows.map((row) => {
        const portalKey = `${row.key}#${rev}`
        return createPortal(<SecretaryMessageCard row={row} api={api} />, row.element, portalKey)
      })}
    </>
  )
}

/** 测试与共享实现引用（避免两处漂移）：折叠预算与行内渲染都从 SecretaryReplyCard.tsx 那一套走。 */
export { assistantCardSpeechKey, turnEndTime, FOLD_GAP }