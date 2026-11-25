/**
 * 个人秘书页「用户卡」+「通知卡」（2026-11-21 两批需求）：
 *   - 真实用户消息 → 冷蓝用户卡（kind=user，无未读红点）；
 *   - 插件塞进来的合成通知（「（系统通知，不是用户说的话）」开头或带 `[[session:…]]` 的合成行）
 *     → 中性灰通知卡（kind=notice，带未读红点、可点跳的会话引用 chip）；
 *   外壳与秘书回复卡同一套规格（宽 620px、16px 圆角、0.5px #E5E6EB 边、无阴影、脚部 引用 + HH:MM 时间 + 复制），
 *   折叠/字号/点卡展开三种卡一律共用 SecretaryReplyCard.tsx 那一套实现，不许各自漂移。
 *
 * 两条新的口径：
 *   - 通知卡活 10 秒（2026-11-24 用户改档，原 10 分钟）只在渲染层收成空壳
 *     （noticeCardExpired / noticeExpiry / NOTICE_CARD_TTL_MS + 首次观察的到达时刻），会话数据一个字都不删；
 *   - 脚部那颗引用按钮（QuoteCardButton）三种卡都有，挂在时间左边。
 *
 * 挂载与取证：
 *   - 卡片内容来自宿主那条用户行本身：`[data-chat-flow-kind="user"]` 与「跑任务途中插话」那一类
 *     `[data-chat-flow-kind="steering"]`（2026-11-24 现场 dump 的两种 kind，共用 SECRETARY_USER_ROW_SELECTOR）→
 *     collectUserCardRuns 的块顺序（文本 run 与附件 run 按页面里的顺序，不是本插件自制的会话页）；
 *   - 卡片经 React portal 挂进宿主用户行，行里出现卡片后 CSS 把宿主气泡收起来
 *     （完整卡接管整条宿主行：气泡与原生附件芯片都不再出图，图片/文件嵌在卡片内部——2026-11-24 附件批次；
 *     分页窗口外的折叠行仍保留宿主气泡里的附件芯片，老消息的附件不许丢）；
 *   - 三条路径的判据都在 collectSecretaryCardRows（secretary-cards.ts）里，测试逐条断言防止串味。
 *
 * 朗读按钮接现有那套状态机：每张卡自己的 key（user: / notice: 前缀），换卡停上一条、
 * 单击暂停/继续、长按 600ms 从头重读；用户卡不自动朗读（自动朗读只属于秘书回复卡与通知卡）。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CopyAnswerButton, ExpandCollapseButton, inlineAnswerText, turnEndTime, useCardFoldMeasure, useCardFoldRegion,
  QuoteCardButton, useSecretaryQuoteState,
  useSecretaryReadState,
} from './SecretaryReplyCard.tsx'
import { CollapsedSecretaryCard, useSecretaryCardWindow, useSecretaryPagerVersion } from './SecretaryCollapsedCard.tsx'
import { SecretarySpeakButton } from './SecretarySpeakButton.tsx'
import {
  assistantCardSpeechKey, buildSecretaryPagerCards, buildUserCardBody, CARD_KIND_NOTICE, CARD_KIND_USER, cardFoldStyle, collectSecretaryCardRows,
  clearSecretaryCompactHintRows, formatClock,
  latestRealUserCardRef, noticeArrivalStore, noticeCardExpired, noticeCardSpeechKey, nearestNoticeExpiryMs, NOTICE_CARD_TTL_MS,
  parseNoticeCardBody, parseSessionRefs, parseUserCardBody, secretaryPager,
  secretaryQuoteStore, stripSessionRefs, tagSecretaryCompactHintRows, clearLatestTurnProcessTags, tagLatestTurnProcessRows, userCardSpeechKey, EARLIER_HINT_TEXT, SCROLL_TOP_THRESHOLD_PX,
  scrollAnchorTopPatch, shouldExpandOnScroll,
  type PagerDomCard, type SecretaryCardRow, type UserCardAttachment, type UserCardBodyBlock,
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
      row.element === other.element && row.kind === other.kind && rowSignature(row) === rowSignature(other)
  })
}

/** 一条用户行的渲染签名：正文文本 + 附件那份 src 的快照（宿主图片晚一拍才 load 出来 → 必须换状态重渲染）。 */
function rowSignature(row: SecretaryCardRow): string {
  const attachments = row.attachments ?? []
  return `${row.text}|${attachments.map((item) => `${item.kind}:${item.name}:${item.meta}:${item.src}`).join(',')}`
}

/** 嵌在卡片内部的一个附件块：图片出缩略图 + 文件名，文件出文件名 + 大小/类型。 */
function CardAttachmentBlock({ attachment }: { attachment: UserCardAttachment }): any {
  const [src, setSrc] = useState(attachment.src)
  const [broken, setBroken] = useState(false)
  useEffect(() => { setSrc(attachment.src); setBroken(false) }, [attachment.src])
  if (attachment.kind === 'image' && src !== '' && !broken) {
    return (
      <div data-dsh-scard="attachment" data-dsh-scard-attachment-kind="image" title={attachment.name}>
        <img data-dsh-scard="attachment-thumb" src={src} alt={attachment.name} loading="lazy" draggable={false} onError={() => setBroken(true)} />
        <span data-dsh-scard="attachment-name">{attachment.name}</span>
      </div>
    )
  }
  if (attachment.kind === 'image') {
    return (
      <div
        data-dsh-scard="attachment"
        data-dsh-scard-attachment-kind="image"
        data-dsh-scard-attachment-pending={src === '' ? '1' : '0'}
        title={attachment.name}
      >
        <span data-dsh-scard="attachment-icon" aria-hidden="true">IMG</span>
        <span data-dsh-scard="attachment-name">{attachment.name}</span>
        <span data-dsh-scard="attachment-status">{src === '' ? '图片还在加载' : '这张图宿主那份地址已经失效'}</span>
      </div>
    )
  }
  return (
    <div data-dsh-scard="attachment" data-dsh-scard-attachment-kind="file" title={attachment.name}>
      <span data-dsh-scard="attachment-icon" aria-hidden="true">📎</span>
      <span data-dsh-scard="attachment-name">{attachment.name}</span>
      {attachment.meta !== '' && <span data-dsh-scard="attachment-meta">{attachment.meta}</span>}
    </div>
  )
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

/**
 * 一张卡（用户卡 / 通知卡）：与秘书回复卡同一套外壳与折叠实现。
 * 通知卡多一条口径（2026-11-24 改档 10 秒）：从首次观察到到满 10 秒后这张卡在渲染层收成**空壳**
 * （原文还在宿主会话里，插件一个字都不删），空壳仍然挂在宿主那条用户行上，把宿主气泡压住不给它冒回来。
 */
function SecretaryMessageCard({ row, api }: { row: SecretaryCardRow; api?: OrbApi }): any {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const notice = row.kind === CARD_KIND_NOTICE
  const speechKey = notice ? noticeCardSpeechKey(row.key, row.turnNo) : userCardSpeechKey(row.key, row.turnNo)
  const readKey = notice ? speechKey : ''
  // 秒级判据：首次观察到这张通知卡的那一刻（落 localStorage，整页刷新后沿用同一条）；
  // 没有记录就退回钟面文本兜底（只晚不早，误差上界 59.999 秒）。
  const noticeArrival = notice ? noticeArrivalStore().at(speechKey) : null
  const noticeExpired = notice ? noticeCardExpired(row, Date.now(), NOTICE_CARD_TTL_MS, noticeArrival) : false
  const readState = useSecretaryReadState(secretarySessionId())
  // 分页窗口：这张用户卡/通知卡完整渲染还是压成一行折叠行（hooks 一律在条件 return 之前）
  const windowState = useSecretaryCardWindow(speechKey)
  const blocks = notice ? parseNoticeCardBody(row.text) : { title: '', paragraphs: parseUserCardBody(row.text) }
  const refs = notice ? parseSessionRefs(row.text) : []
  // 用户卡正文：文本段落与附件按宿主页面的顺序排（附件前后的文字都在，附件嵌在卡片内部）
  const userBody: UserCardBodyBlock[] = notice ? [] : buildUserCardBody(row.runs ?? [{ type: 'text', text: row.text }])
  // 复制拿的永远是这条消息的原文（用户卡不许改写；通知卡复制去掉内部合成标记，方便粘出去用）
  const copyText = notice ? stripSessionRefs(row.text) : row.text
  const hasBody = notice ? (blocks.title !== '' || blocks.paragraphs.length > 0) : userBody.length > 0
  const unread = notice && readKey !== '' && !readState.isRead(readKey)
  const timeText = cardTimeText(row)

  // 折叠态：与秘书回复卡共用同一套测量与补测（正文最多 3 行、卡标题最多 2 行、固定高度）
  const { overflow, collapsedMaxHeight, measured } = useCardFoldMeasure(contentRef, true, open, `${row.text}|${blocks.paragraphs.length}|${userBody.length}|${refs.length}|${rowSignature(row)}`)

  const markRead = (): void => { if (readKey !== '') readState.markRead(readKey) }
  const toggle = (): void => { setOpen((value) => !value); markRead() }
  const { foldProps } = useCardFoldRegion(open, overflow, toggle)
  const quoteState = useSecretaryQuoteState(secretarySessionId())

  // 过期通知卡（活满 10 秒）：只收成空壳。原文还在宿主会话里，插件一个字都不删；
  // 空壳 kind=notice 仍然撑着那条 :has 判据，宿主气泡不会冒回来。
  if (noticeExpired) {
    return (
      <article
        data-dsh-scard="card"
        data-dsh-scard-kind={CARD_KIND_NOTICE}
        data-dsh-scard-key={speechKey}
        data-dsh-scard-turn={row.turnNo}
        data-dsh-scard-expired="1"
        data-empty="1"
        aria-hidden="true"
      />
    )
  }

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
      data-quoted={quoteState.isQuoted(speechKey) ? '1' : '0'}
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
          {notice
            ? blocks.paragraphs.map((block, index) => (
              <p key={`para:${index}`} data-dsh-scard="para">{inlineAnswerText(block)}</p>
            ))
            : userBody.map((block, index) => (block.type === 'attachment' && block.attachment !== undefined
              ? <CardAttachmentBlock key={`attach:${index}`} attachment={block.attachment} />
              : <p key={`para:${index}`} data-dsh-scard="para">{block.text}</p>))}
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
        {/* 脚部那颗引用按钮（第 4 项需求）：三种卡都把它放在**时间左边**，规格与时间右边那棵复制按钮一样 */}
        <QuoteCardButton
          cardKey={speechKey}
          kind={notice ? CARD_KIND_NOTICE : CARD_KIND_USER}
          turnNo={row.turnNo}
          preview={copyText}
          body={copyText}
          attachments={notice ? [] : (row.attachments ?? []).map((item) => ({ name: item.name, kind: item.kind, meta: item.meta }))}
          refSessionIds={refs.map((ref) => ref.sessionId)}
          onToggled={markRead}
        />
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
 * 挂载层（挂在 shell.overlay，整页常驻）：扫对话流里的 user 角色行（含 2026-11-24 补的「跑任务途中插话」那一类行），
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
    // 通知卡过期定时器：算出最近一个过期时点，到点 bump rev → 每张卡重新按现在的时间判一次（空壳出口在卡片里）
    let expiryTimer: number | null = null
    const scan = (): void => {
      if (!alive) return
      if (!secretaryPageActive()) {
        setRows((prev) => (prev.length === 0 ? prev : []))
        syncEarlierHint(document, false)
        // 离开秘书页：把自己打过的 compact 标记清干净（宿主行本身一个属性都没动过，只清我们加的）
        clearSecretaryCompactHintRows(document)
        // 第 5 项：离开秘书页也把「最新一轮过程行」的标记清掉（别的会话页一个都不许留）
        clearLatestTurnProcessTags(document)
        if (expiryTimer !== null) { window.clearTimeout(expiryTimer); expiryTimer = null }
        return
      }
      // 第 3 项需求：compact 提示两行只在秘书页压掉（CSS 按 kind + 这里打的标记）
      tagSecretaryCompactHintRows(document)
      // 第 5 项需求（2026-11-24）：只把「最新一条 user/steering 行那一轮」的过程行标成可见。
      // 每次扫描都重算：标记跟着最新一条用户消息移动，历史轮次自动收回隐藏。
      tagLatestTurnProcessRows(document)
      const next = collectSecretaryCardRows(document)
      // 秒级来源（2026-11-24 改档 10 秒）：**第一眼看到**这批通知卡就地记到达时刻（幂等，只增不改）。
      // 必须在 buildSecretaryPagerCards 之前登记，否则首帧那张卡要等到下一次扫描才有 10 秒起点。
      const arrivals = noticeArrivalStore()
      arrivals.observeAll(next.filter((row) => row.kind === CARD_KIND_NOTICE).map((row) => noticeCardSpeechKey(row.key, row.turnNo)))
      const domCards: PagerDomCard[] = buildSecretaryPagerCards(document)
      pager.setSession(secretarySessionId())
      pager.noteDomCards(domCards)
      // 引用吃掉口径（2026-11-23 追加需求）：把这条会话页面上最末那条**真实**用户消息卡送进引用 store。
      // 它比「引用登记那一刻的基线」更靠前，就说明用户已经把那条消息发出去了 → 输入框旁边那颗提示该收。
      // 合成通知行一律不算（latestRealUserCardRef 只认 kind=user），口径同宿主注入段「通知轮不吃引用」。
      secretaryQuoteStore().noteLatestUserCard(latestRealUserCardRef(next))
      // 只取最近一段（幂等）：绝不在这里回填更旧的卡
      void pager.ensureWindow()
      const missing = next.some((row) => !rowHasCard(row.element))
      setRows((prev) => (sameRows(prev, next) ? prev : next))
      if (missing) setRev((value) => value + 1)
      // 通知卡 10 秒（2026-11-24 改档）：还有没到点的通知卡 → 排一次定时器，到点强制重判
      // （不排就永远等下一次 DOM 变化）。到达时刻优先（秒级），没有记录才退到钟面兜底。
      const expiresAt = nearestNoticeExpiryMs(next, Date.now(), NOTICE_CARD_TTL_MS,
        (row) => noticeArrivalStore().at(noticeCardSpeechKey(row.key ?? '', row.turnNo ?? '')))
      if (expiryTimer !== null) { window.clearTimeout(expiryTimer); expiryTimer = null }
      if (expiresAt !== null) {
        const delay = Math.max(1000, expiresAt - Date.now())
        expiryTimer = window.setTimeout(() => {
          expiryTimer = null
          if (!alive) return
          setRev((value) => value + 1)
          scan()
        }, delay)
      }
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
      attributeFilter: ['data-dsh-secretary', 'data-chat-turn', 'class', 'src'],
    })
    return () => {
      alive = false
      observer.disconnect()
      window.clearTimeout(initial)
      if (timer !== null) window.clearTimeout(timer)
      if (expiryTimer !== null) window.clearTimeout(expiryTimer)
      expiryTimer = null
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