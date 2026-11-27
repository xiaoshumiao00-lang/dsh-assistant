/**
 * 秘书回复卡片（卡片规范 v1.1，2026-11-21 第二轮改动）：白卡 + 头部助手标识/朗读按钮 + 正文标题段落 + 底部操作栏。
 *
 * 结构（自上而下）：
 *   1. 未读红点：只在「这条卡没被朗读过、也没被点过/复制过」时出现（8px #D83A2B，卡头顶边、标识组左侧）；
 *   2. 头部：左 32px 紫色四角星助手标识、名称「个人秘书」、身份标签「AI 助手」；右只有一个 34px 朗读按钮；
 *   3. 正文：**折叠态固定高度 = 最多 2 行结论 + 最多 3 行详情**（超出打「…」省略标记 + 「展开全文」入口，不用渐变遮罩）；
 *      18px/600 结论行（稍大、加粗、主文字色） + 14px/26px 详情段落（稍小、次要文字色）——2026-11-23 第 2 项需求，
 *      只动字号与字重，「结论—细节」的**表达**顺序不动、正文一个字都不删；
 *      模型名自动渲染成浅紫等宽行内标签；会话引用渲染成可点击 chip；
 *   4. 卡体正文区域本身可点击/可键盘切换（Enter/Space）展开与收起：role=button + aria-expanded，
 *      内部那颗朗读/复制/展开全文按钮与引用 chip 都 stopPropagation，点卡体不会触发它们；
 *   5. 底部操作栏：**引用按钮（时间左边，与复制按钮同一套规格）→ 时间（HH:MM）紧贴复制按钮左侧 → 复制 → 0.5px 分隔线 → 「展开全文」（仅溢出时）；
 *   6. 朗读按钮只出现在头部，不出在底部；
 *   7. 附件区（2026-11-26 需求）：正文里的 `[[attach:<绝对路径>|<显示名>]]` 渲染成图片缩略图或行式文件条，
 *      放在**折叠区之外**（卡体与脚部之间）——始终可见、不参与折叠高度测量；点开走宿主只读路由
 *      `/api/worktable/file?path=`。2026-11-27 需求「所有附件都通过下载实现」：安卓端图片与文件
 *      收敛成同一条判定（openAttach）——一律加 download=1 走系统下载，桌面保持 window.open 新标签页。
 *
 * TTS 状态机不变：换卡停上一条、单击暂停/继续、长按 600ms 从头重读。
 * 已读判据：这条卡被朗读过（含自动朗读，成功或被中断都算）或用户点过卡体/展开全文/复制 → 立刻写进已读集合。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import {
  answerInlineTokens, assistantCardSpeechKey, collectTurnText, foldClipFromBlocks, foldCollapsedCapPx, formatClock, latestReplyTurnNo, parseAnswerBody,
  parseSessionRefs, stripSessionRefs, normalizeForSpeech, secretaryReadStore, secretaryQuoteStore, QUOTE_PREVIEW_MAX_CHARS,
  parseAttachRefs, stripAttachRefs, isAttachImage, attachFileUrl, attachDownloadUrl, attachOpenViaDownload, attachTypeBadge, formatFileSize,
  CARD_KIND_ASSISTANT, CARD_KIND_NOTICE, CARD_KIND_USER, FOLD_BODY_LINE_BUDGET, FOLD_BLOCK_GAP, FOLD_TITLE_LINE_BUDGET, FOLD_FALLBACK_LINE_HEIGHT_PX, cardFoldStyle,
  type AttachRef, type FoldBlockBox, type FoldGeometryOut, type SecretaryQuoteAttachment,
} from './secretary-cards.ts'
import { secretarySpeech } from './secretary-speech.ts'
import { SecretarySpeakButton } from './SecretarySpeakButton.tsx'
import { CollapsedSecretaryCard, useSecretaryCardWindow } from './SecretaryCollapsedCard.tsx'
import type { OrbApi } from './orb-api.ts'

/** 已经自动朗读过的轮次 key（防止重挂载后反复自动读）。 */
const autoReadKeys = new Set<string>()

/** 从宿主 turn 对象里尽量拿轮次结束时间（epoch ms 或 ISO；拿不到回空串，底行就不显示时间）。 */
export function turnEndTime(turn: any): string {
  try {
    const value = turn?.end?.time ?? turn?.end?.event?.time ?? turn?.end?.data?.time ?? ''
    if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value))
    return typeof value === 'string' ? value : ''
  } catch { return '' }
}

/** 行内渲染计划：重点句用 strong，模型名/量化版本用行内标签。 */
export function inlineAnswerText(text: string): any {
  const tokens = answerInlineTokens(String(text ?? ''))
  return tokens.map((token, index) => {
    const key = `${token.kind}:${index}`
    if (token.kind === 'strong') return <strong key={key}>{token.value}</strong>
    if (token.kind === 'model') return <span key={key} data-dsh-scard="model-code">{token.value}</span>
    return <span key={key}>{token.value}</span>
  })
}

async function copyAnswerText(text: string): Promise<boolean> {
  const value = String(text ?? '')
  if (value === '') return false
  try {
    if (typeof navigator?.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch { /* 继续走传统剪贴板 */ }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.cssText = 'position:fixed;top:-10000px;left:-10000px;opacity:0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    textarea.remove()
    return ok === true
  } catch {
    return false
  }
}

export function CopyAnswerButton({ fullText, label = '复制完整回答', onCopied }: { fullText: string; label?: string; onCopied?: () => void }): any {
  const [status, setStatus] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timerRef = useRef<number | null>(null)

  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])

  const show = (next: 'ok' | 'fail'): void => {
    setStatus(next)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setStatus('idle'), next === 'ok' ? 1500 : 4000)
  }

  const onCopy = async (event: any): Promise<void> => {
    // 点复制按钮不能把卡体折叠态带下去（卡体 onClick 要靠这里断掉冒泡）
    event.stopPropagation()
    const ok = await copyAnswerText(fullText)
    if (ok && typeof onCopied === 'function') onCopied()
    show(ok ? 'ok' : 'fail')
  }

  const ariaLabel = status === 'ok' ? '已复制' : status === 'fail' ? '复制失败' : label
  return (
    <>
      <button type="button" data-dsh-scard="copy" title={label} aria-label={ariaLabel} onClick={(event: any) => void onCopy(event)}>
        {status === 'ok' ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="8" y="8" width="10" height="10" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" />
          </svg>
        )}
      </button>
      {status !== 'idle' && (
        <span data-dsh-scard="copy-status" aria-live="polite">{status === 'ok' ? '已复制' : '复制失败，请手动选择文本'}</span>
      )}
    </>
  )
}

/**
 * 引用登记状态（2026-11-23 第 4 项需求）：与已读集合同一套 store 口径——
 * 真值在宿主 `/api/assistant/secretary-quote`（→ dsh-assistant-secretary-quote.json），
 * localStorage 只是首屏缓存与宿主答不上时的兜底。卡片靠它决定那颗按钮的引用态与状态文字。
 */
export function useSecretaryQuoteState(sessionId: string): {
  isQuoted: (cardKey: string) => boolean
  register: (record: { cardKey: string; kind: string; turnNo?: string; preview?: string; refSessionIds?: string[] }) => boolean
  cancel: (cardKey: string) => boolean
} {
  const store = secretaryQuoteStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  useEffect(() => {
    const id = String(sessionId ?? '')
    if (id === '') return
    store.setSession(id)
    void store.hydrate()
  }, [store, sessionId])
  return {
    isQuoted: (cardKey: string) => store.isQuoted(cardKey),
    register: (record) => store.setQuote(record),
    cancel: (cardKey: string) => store.clearQuote(cardKey),
  }
}

/**
 * 卡片脚部「引用」按钮（三种卡共用同一颗实现，规格与复制那棵一模一样：30×30、同一灰、同一 hover、16px 图标）。
 * 位置由调用方决定：秘书回复卡、用户卡、通知卡都把它放在**时间左边**。
 * 点一次 = 把这张卡登记成「下一条消息要回复的对象」（宿主引用注入段随后就把这张卡喂给秘书模型）；
 * 再点一次 = 取消登记。卡片带 `[[session:…]]` 引用时把那条会话 id 一起登记进去。
 */
export function QuoteCardButton({ cardKey, kind, turnNo = '', preview = '', body = '', attachments = [], refSessionIds = [], onToggled }: {
  cardKey: string
  kind: string
  turnNo?: string
  preview?: string
  /** 卡片正文全文（引用链路自己的字段：不截成 QUOTE_PREVIEW_MAX_CHARS，宿主那段「必须回答的卡」用它）。 */
  body?: string
  /** 卡片里的附件（只有文件信息；图片本体不随引用注入）。 */
  attachments?: SecretaryQuoteAttachment[]
  refSessionIds?: string[]
  onToggled?: (quoted: boolean) => void
}): any {
  const store = secretaryQuoteStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  const [status, setStatus] = useState<'idle' | 'on' | 'off'>('idle')
  const timerRef = useRef<number | null>(null)

  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])

  const show = (next: 'on' | 'off'): void => {
    setStatus(next)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setStatus('idle'), next === 'on' ? 2600 : 1500)
  }

  const quoted = store.isQuoted(cardKey)
  const onQuote = (event: any): void => {
    // 引用按钮不能把卡体的折叠态带下去
    event.stopPropagation()
    if (quoted) {
      store.clearQuote(cardKey)
      show('off')
      if (typeof onToggled === 'function') onToggled(false)
      return
    }
    store.setQuote({ cardKey, kind, turnNo, preview: truncateQuotePreview(preview), body, attachments, refSessionIds })
    show('on')
    if (typeof onToggled === 'function') onToggled(true)
  }

  const label = quoted ? '取消引用这条卡' : '引用这条卡：下一条消息就接着它说'
  return (
    <>
      <button type="button" data-dsh-scard="quote" data-quoted={quoted ? '1' : '0'} aria-pressed={quoted} title={label} aria-label={label} onClick={onQuote}>
        {quoted ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.4 6.8C6.6 8.4 5 10.9 5 13.8c0 2 1.4 3.5 3.2 3.5 1.7 0 3-1.3 3-3 0-1.7-1.3-3-3-3" />
            <path d="M18.6 6.8C15.8 8.4 14.2 10.9 14.2 13.8c0 2 1.4 3.5 3.2 3.5 1.7 0 3-1.3 3-3 0-1.7-1.3-3-3-3" />
          </svg>
        )}
      </button>
      {status !== 'idle' && (
        <span data-dsh-scard="quote-status" aria-live="polite">{status === 'on' ? '已引用' : '引用已取消'}</span>
      )}
    </>
  )
}

/** 引用的正文摘录只用来告诉模型「引用的是哪段话」，上限与客户端口径同一个数（QUOTE_PREVIEW_MAX_CHARS）。 */
function truncateQuotePreview(text: string): string {
  const raw = String(text ?? '')
  if (raw.length <= QUOTE_PREVIEW_MAX_CHARS) return raw
  return `${raw.slice(0, QUOTE_PREVIEW_MAX_CHARS - 1)}…`
}

/** 展开全文入口（仅溢出时渲染）：点它既切换折叠，也算「这条已读」。 */
export function ExpandCollapseButton({ open, onToggle, overflow, collapseTitle = '收起回答' }: { open: boolean; onToggle: () => void; overflow: boolean; collapseTitle?: string }): any {
  if (!overflow) return null
  return (
    <button
      type="button"
      data-dsh-scard="expand"
      aria-expanded={open}
      onClick={(event: any) => { event.stopPropagation(); onToggle() }}
      title={open ? collapseTitle : '展开全文'}
    >
      <span data-dsh-scard="expand-text">{open ? '收起' : '展开全文'}</span>
      <svg data-dsh-scard="expand-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  )
}

/** 一个正文块的行高：CSS 详情正文 14px / 26px → 26px（结论行 18px / 1.5 → 27px）；取 computed 值，不在组件里写死数字。 */
export function blockLineHeightPx(el: HTMLElement): number {
  const cs = (typeof window !== 'undefined' ? window : el.ownerDocument?.defaultView ?? window).getComputedStyle(el)
  const lineHeight = Number.parseFloat(cs?.lineHeight ?? '')
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
  const fontSize = Number.parseFloat(cs?.fontSize ?? '') || 14
  return Math.max(1, Math.round((fontSize * FOLD_FALLBACK_LINE_HEIGHT_PX) / 14))
}

/** 折叠几何输出直接沿用 secretary-cards.ts 的那套（避免两套定义漂移）。 */
export type FoldGeometry = FoldGeometryOut

/**
 * 从 DOM 量出正文块的位置与高度，算术全交给 secretary-cards.ts 的 foldClipFromBlocks（测试也直接验它）。
 *
 * 判据一律是**内容高度**（offsetTop / offsetHeight / scrollHeight），绝不按字符数算：字号或行高变了也稳。
 * 卡标题也进折叠预算（最多 2 行）：现网实测旧口径让长卡的折叠落点随首段行数膨胀（321–346px / 卡高 456–481px）。
 * 标题被 CSS 行夹裁过时，`titleEl.scrollHeight > titleEl.clientHeight` 就是「还有文字被藏着」的判据，
 * 这类卡（整条回复只有一段连续文字）也必须折叠——旧实现这时会判成「不溢出」，卡片整段平铺。
 */
export function measureFoldClip(contentEl: HTMLElement, budget: number = FOLD_BODY_LINE_BUDGET): FoldGeometry {
  const blocks = [...contentEl.querySelectorAll('[data-dsh-scard="title"], [data-dsh-scard="para"], [data-dsh-scard="ref"]')] as HTMLElement[]
  const titleEl = blocks.find((el) => el.getAttribute('data-dsh-scard') === 'title') ?? null
  const bodyEls = blocks.filter((el) => el.getAttribute('data-dsh-scard') !== 'title')
  const natural = Math.max(1, contentEl.scrollHeight)
  if (blocks.length === 0) {
    // 正文区还挂着但块没到位（测量早于布局稳定）：按固定上限折叠，绝不留下平铺状态
    const cap = foldCollapsedCapPx({ lineHeight: FOLD_FALLBACK_LINE_HEIGHT_PX, hasTitle: false })
    return { collapsedMaxHeight: cap, overflow: natural > cap, bodyLines: 0, clip: cap, cap }
  }
  const lineHeight = blockLineHeightPx(bodyEls[0] ?? titleEl ?? contentEl)
  const titleLineHeight = titleEl !== null ? blockLineHeightPx(titleEl) : lineHeight
  const boxes: FoldBlockBox[] = blocks.map((el) => ({
    kind: String(el.getAttribute('data-dsh-scard')) as 'title' | 'para' | 'ref',
    top: el.offsetTop,
    height: el.offsetHeight,
  }))
  const titleClippedHidden = titleEl !== null && titleEl.scrollHeight > titleEl.clientHeight + 1
  return foldClipFromBlocks({ blocks: boxes, naturalHeight: natural, lineHeight, titleLineHeight, titleClippedHidden, budget })
}

/** 首帧之后再补测几次：现网卡片是「paint 完才 useEffect 测量」，手机 WebView 上布局可能晚一帧才稳定。 */
const FOLD_MEASURE_RETRY_DELAYS_MS = [100, 400, 1200, 2500]
/** 收正文的补读时点（与补测量同源同口径）：投影/分页/流式收尾晚到时也不留下「只读到一半」的卡。 */
const TEXT_READ_RETRY_DELAYS_MS = [100, 400, 1200, 2500]

/**
 * 折叠测量（三种卡共用一套实现）：正文一变就重新量，字体落完再量一次，
 * 布局晚到的卡也不会留下「测量发生在布局稳定前」的过期不折叠状态。
 */
export function useCardFoldMeasure(contentRef: RefObject<HTMLDivElement | null>, active: boolean, open: boolean, signature: string) {
  const [overflow, setOverflow] = useState(false)
  const [collapsedMaxHeight, setCollapsedMaxHeight] = useState<number | undefined>(undefined)
  // 没量过之前不许把折叠上限写成「放开」：CSS 那条首帧固定上限（--dsh-card-fold-cap，162px）要先顶住，
  // 否则卡片挂载到 effect 测量之间的那一帧就是整段平铺（实测现网长卡首帧 748–856px）。
  const [measured, setMeasured] = useState(false)

  useEffect(() => {
    const el = contentRef.current
    if (!active || open || el === null) return
    let alive = true
    const measure = (): void => {
      if (!alive) return
      const geometry = measureFoldClip(el)
      setOverflow(geometry.overflow)
      setCollapsedMaxHeight(geometry.collapsedMaxHeight)
      setMeasured(true)
    }
    measure()
    const timers = FOLD_MEASURE_RETRY_DELAYS_MS.map((ms) => window.setTimeout(measure, ms))
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    // webfont / 系统字体后落会改行高与换行：等 ready 再重测一次
    const fonts = (typeof document !== 'undefined' ? document.fonts : undefined) as { ready?: Promise<unknown> } | undefined
    if (fonts?.ready instanceof Promise) void fonts.ready.then(() => measure()).catch(() => { /* 字体 API 不支持就靠补测兜底 */ })
    // 宿主轮次文字会边走边变（streaming/收尾重写）：正文一变就重新量，绝不留下过期的折叠落点
    // （实测过期状态：max-height 245px 但正文只有 211px → 没有真截断却还挂着「…」标记）。
    let frame = 0
    const remeasure = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => { frame = 0; measure() })
    }
    const mutationObserver = new MutationObserver(remeasure)
    // 观察卡体（正文区的父节点）而不只是正文区：宿主往这一轮里补节点时也要重测
    const region = el.parentElement ?? el
    mutationObserver.observe(region, { childList: true, subtree: true, characterData: true })
    const resizeObserver = new ResizeObserver(remeasure)
    resizeObserver.observe(el)
    if (region !== el) resizeObserver.observe(region)
    return () => {
      alive = false
      for (const timer of timers) window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      if (frame !== 0) window.cancelAnimationFrame(frame)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [active, open, signature, contentRef])

  return { overflow, collapsedMaxHeight, measured }
}

/** 卡体正文区域（可点击/可键盘展开收起）：三种卡共用同一套语义与手势。 */
export function useCardFoldRegion(open: boolean, overflow: boolean, toggle: () => void) {
  const regionRef = useRef<HTMLDivElement | null>(null)

  const guard = (event: any): boolean => {
    // 卡体里的按钮（引用 chip）与脚部/头部按钮都不会经由卡体触发
    const target: HTMLElement | null = event?.target instanceof HTMLElement ? event.target : null
    if (target !== null && target.closest('[data-dsh-speak="button"], [data-dsh-scard="copy"], [data-dsh-scard="quote"], [data-dsh-scard="expand"], [data-dsh-scard="ref"], [data-dsh-scard="head"]') !== null) return true
    return false
  }

  const onBodyClick = (event: any): void => {
    // 点卡体必须 stopPropagation：不冒泡去触发头部标识组、紫色 chip、脚部那颗按钮
    event.stopPropagation()
    if (guard(event)) return
    if (!overflow) return
    toggle()
  }

  const onBodyKeyDown = (event: any): void => {
    if (event?.key !== 'Enter' && event?.key !== ' ' && event?.key !== 'Spacebar') return
    // 只有卡体自己被聚焦时才算展开/收起；内部按钮自己的 Enter/Space 不掺进来
    if (regionRef.current !== null && event?.target !== regionRef.current) return
    event.preventDefault()
    event.stopPropagation()
    if (!overflow) return
    toggle()
  }

  const foldProps = {
    ref: regionRef,
    'data-dsh-scard': 'body',
    'data-dsh-scard-fold': overflow ? 'toggle' : 'static',
    role: 'button',
    tabIndex: 0,
    'aria-expanded': overflow ? (open ? 'true' : 'false') : 'true',
    'aria-label': open ? '收起正文' : '展开正文',
    title: overflow ? (open ? '收起正文' : '展开全文') : undefined,
    onClick: onBodyClick,
    onKeyDown: onBodyKeyDown,
  }
  return { foldProps, regionRef }
}

/** 已读集合（未读红点）的订阅 hook：宿主 GET 拿到集合 → 再叠本地缓存；宿主答不上按本地缓存继续。 */
export function useSecretaryReadState(sessionId: string): { isRead: (key: string) => boolean; markRead: (key: string) => void } {
  const store = secretaryReadStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  useEffect(() => {
    const id = String(sessionId ?? '')
    if (id === '') return
    store.setSession(id)
    void store.hydrate()
  }, [sessionId])
  return {
    isRead: (key: string) => store.isRead(key),
    markRead: (key: string) => { if (String(key ?? '') !== '') store.markRead(key) },
  }
}

/**
 * 附件大小（文件条右端那行）：只发 HEAD 问响应头，宿主 /api/worktable/file 已支持 HEAD + content-length，
 * 不把整份（上限 100MB）正文读回来。同一地址只问一次（模块级缓存，重渲染/翻页回来不再发请求）；
 * 拿不到大小（接口报错、老宿主没有 HEAD）就不显示，绝不写 0 B 误导人。
 */
const attachSizeCache = new Map<string, string>()

function useAttachFileSize(url: string): string {
  const [text, setText] = useState(() => (url === '' ? '' : (attachSizeCache.get(url) ?? '')))
  useEffect(() => {
    if (url === '') { setText(''); return }
    const cached = attachSizeCache.get(url)
    if (cached !== undefined) { setText(cached); return }
    let alive = true
    void fetch(url, { method: 'HEAD' })
      .then((res) => {
        if (!res.ok) return ''
        const raw = res.headers.get('content-length')
        return raw === null || raw.trim() === '' ? '' : formatFileSize(Number(raw))
      })
      .then((label) => {
        if (!alive || label === '') return
        attachSizeCache.set(url, label)
        setText(label)
      })
      .catch(() => { /* 拿不到大小不影响打开，静默降级 */ })
    return () => { alive = false }
  }, [url])
  return text
}

/**
 * 打开附件（2026-11-27 需求「不只是图片，所有附件——apk、docx、pdf、zip、音频、图片——都通过
 * 下载实现」）：图片缩略图与文件条收敛成**同一条判定**，不再两套 handler。
 *
 * 真机 bug 的根因：APK 的 WebView setSupportMultipleWindows(false)，window.open 变成**同页导航**
 * 到 /api/worktable/file；服务端对图片/文档回 inline（file-disposition.ts 的
 * INLINE_FILE_EXTENSIONS）时 WebView 在当前页直接渲染，卡片页被整个刷掉（用户看到的就是
 * 「APK 重新刷新、重新进」）。
 *
 * 修法（不新造 JS 桥，事实上的桥是 WebView 的 DownloadListener）：安卓端（UA 带 Android，含
 * APK 的 WebView）**任何附件**点击都走 attachDownloadUrl——同一条只读路由加 download=1，
 * 宿主对所有类型强制回 attachment，WebView 的 DownloadListener 把它交给系统下载器（带 cookie，
 * MainActivity.startDownload），下载完成由 MainActivity 按 MIME 分流拉起系统应用（看图/文档/
 * apk 安装/…），页面全程不动。
 * 桌面/其余浏览器 attachOpenViaDownload 为 false，保持 window.open 新标签页（图片/pdf 内联看，
 * office 文件浏览器自己下载）。
 */
function openAttach(event: any, path: string): void {
  event.stopPropagation()
  const ua = String((globalThis as any).navigator?.userAgent ?? '')
  const url = attachOpenViaDownload(ua) ? attachDownloadUrl(path) : attachFileUrl(path)
  try {
    window.open(url, '_blank')
  } catch {
    try { window.location.href = url } catch { /* 两个通道都被拦就到此为止，卡片本身不炸 */ }
  }
}

/**
 * 附件区里的一件附件（2026-11-26 需求）：
 *   - 图片扩展名（png/jpg/jpeg/gif/webp/bmp/svg）→ 内联缩略图（lazy、圆角、最大高 180px、超出裁剪）；
 *   - 其余（docx/xlsx/pptx/zip/pdf…）→ 行式文件条：类型角标 + 显示名 + 拿得到的大小。
 * 两种都是 44px 以上触控目标，手机上点得中；点开一律走同一个 openAttach（安卓 → 系统下载，
 * 桌面 → window.open 新标签页），不再图片一套、文件一套。
 */
export function ReplyAttachmentPiece({ attachment }: { attachment: AttachRef }): any {
  const url = attachFileUrl(attachment.path)
  const image = isAttachImage(attachment.path)
  // 图片读不出来（路径越界被 403、文件被删、宿主还没加载新构建）→ 退化成文件条：名字与「点开」都还在
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [url])
  const size = useAttachFileSize(image && !broken ? '' : url)
  const badge = attachTypeBadge(attachment.path)

  if (image && !broken) {
    return (
      <button
        type="button"
        data-dsh-scard="attach-image"
        title={`打开图片：${attachment.name}`}
        aria-label={`打开图片：${attachment.name}`}
        onClick={(event: any) => openAttach(event, attachment.path)}
      >
        <img
          data-dsh-scard="attach-thumb"
          src={url}
          alt={attachment.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
        />
        <span data-dsh-scard="attach-name">{attachment.name}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      data-dsh-scard="attach-file"
      data-dsh-scard-attach-ext={badge}
      title={`打开附件：${attachment.name}`}
      aria-label={`打开附件：${attachment.name}`}
      onClick={(event: any) => openAttach(event, attachment.path)}
    >
      <span data-dsh-scard="attach-badge" aria-hidden="true">{badge}</span>
      <span data-dsh-scard="attach-name">{attachment.name}</span>
      {size !== '' && <span data-dsh-scard="attach-size">{size}</span>}
    </button>
  )
}

export function SecretaryReplyCard({ sessionId, turn, api }: { sessionId?: string; turn?: any; api?: OrbApi }): any {
  const id = String(sessionId ?? '')
  const isSecretary = id !== '' && id === peekSecretarySessionId()
  const wrapRef = useRef<HTMLElement | null>(null)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const [turnNo, setTurnNo] = useState('')
  const [body, setBody] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!isSecretary) return
    const el = wrapRef.current
    if (el === null) return
    let alive = true
    const read = (): void => {
      if (!alive) return
      const no = el.closest('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? ''
      setTurnNo(no)
      setBody(collectTurnText(document, no))
    }
    read()
    // 尾节点与正文同帧挂载，但投影/分页/流式收尾可能晚一拍：补读几次，别只靠一次 400ms 兜底
    const timers = TEXT_READ_RETRY_DELAYS_MS.map((ms) => window.setTimeout(read, ms))
    // 宿主往这一轮里补写 assistant-step 文字时（streaming 收尾、投影改写）也重新收一次正文，
    // 卡片正文与折叠落点才不会停在「只读到一半」的过期状态（纯读取 DOM，不写任何 turn 事件）。
    const row = el.closest('[data-chat-turn]') ?? el.parentElement
    let readFrame = 0
    const mutationObserver = new MutationObserver(() => {
      if (!alive || readFrame !== 0) return
      readFrame = window.requestAnimationFrame(() => { readFrame = 0; read() })
    })
    if (row !== null) mutationObserver.observe(row, { childList: true, subtree: true, characterData: true })
    return () => {
      alive = false
      for (const timer of timers) window.clearTimeout(timer)
      if (readFrame !== 0) window.cancelAnimationFrame(readFrame)
      mutationObserver.disconnect()
    }
  }, [isSecretary])

  const key = assistantCardSpeechKey(turnNo)
  const readState = useSecretaryReadState(id)
  const quoteState = useSecretaryQuoteState(id)
  // 分页窗口：这张秘书回复卡是完整渲染还是压成一行折叠行（hooks 全部在此之前，条件 return 之后不能再有 hook）
  const windowState = useSecretaryCardWindow(key)
  // 附件标记也剔除：卡片正文、复制文本、朗读文本里都不许出现绝对路径
  const display = stripAttachRefs(stripSessionRefs(body)).trim()
  const speechText = normalizeForSpeech(body)
  const { title, paragraphs } = parseAnswerBody(display)
  const refs = parseSessionRefs(body)
  const attaches = parseAttachRefs(body)
  const unread = turnNo !== '' && !readState.isRead(key)

  // 自动朗读：只读最末一轮，每轮一次；读过（含被中断）就算这条已读
  useEffect(() => {
    if (!isSecretary || turnNo === '' || speechText === '') return
    if (turnNo !== latestReplyTurnNo(document)) return
    if (autoReadKeys.has(key)) return
    autoReadKeys.add(key)
    secretarySpeech.request(key, speechText)
    readState.markRead(key)
  }, [isSecretary, turnNo, speechText, key, readState])

  // 折叠态：正文最多 3 行、卡标题最多 2 行；溢出与落点都由 measureFoldClip 的落点判断，未溢出就不渲染省略标记与展开全文
  const { overflow, collapsedMaxHeight, measured } = useCardFoldMeasure(mainRef, isSecretary && display !== '', open, `${display}|${paragraphs.length}|${refs.length}`)

  // 折叠区里的 hooks（useCardFoldRegion）必须在任何条件 return 之前调用：
  // 首帧正文为空 → 走到空壳 return，下一帧正文到位 → 走到完整 return，
  //  hooks 数量对不上就是「Rendered more hooks than during the previous render」，
  //  宿主 slot 的错误边界吃掉它，卡片整块静默消失（实测：页面上没有任何 assistant 卡）。
  const toggle = (): void => { setOpen((value) => !value); if (turnNo !== '') readState.markRead(key) }
  const { foldProps } = useCardFoldRegion(open, overflow, toggle)
  const timeText = formatClock(turnEndTime(turn))
  // 折叠落点 → 内联样式（三种卡共用 cardFoldStyle：测量前不放开、没溢出才放开）
  const bodyStyle = cardFoldStyle(open, measured, collapsedMaxHeight)

  if (!isSecretary) return null
  // 根节点必须无条件渲染（ref 要靠它定位轮次）；空壳由 CSS 整体隐藏（不输出占位条）
  // 2026-11-26：只有附件标记、正文全是标记时**不是空壳**——附件区照样要出图，否则交付物整块消失
  if (display === '' && attaches.length === 0) return <article ref={wrapRef as any} data-dsh-scard="card" data-dsh-scard-kind={CARD_KIND_ASSISTANT} data-empty="1" />

  // 分页窗口外（比最近 30 张更旧）：压成一行折叠行，绝不把整张老卡拉回渲染
  if (windowState.collapsed) {
    return (
      <CollapsedSecretaryCard
        cardKey={key}
        kind={CARD_KIND_ASSISTANT}
        turnNo={turnNo}
        timeText={timeText}
        fallbackTitle={title}
        fallbackText={display}
      />
    )
  }

  return (
    <article
      ref={wrapRef as any}
      data-dsh-scard="card"
      data-dsh-scard-kind={CARD_KIND_ASSISTANT}
      data-dsh-scard-turn={turnNo}
      data-dsh-scard-key={key}
      data-empty="0"
      data-open={open ? '1' : '0'}
      data-overflow={overflow ? '1' : '0'}
      data-unread={unread ? '1' : '0'}
      data-quoted={quoteState.isQuoted(key) ? '1' : '0'}
    >
      {unread && <span data-dsh-scard="unread-dot" role="img" aria-label="未读" title="未读" />}
      <div data-dsh-scard="head">
        <div data-dsh-scard="identity">
          <span data-dsh-scard="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3.8l1.9 5.7 5.7 1.9-5.7 1.9L12 19l-1.9-5.7L4.4 11.4l5.7-1.9L12 3.8z" />
              <path d="M4.6 4.6l2 2" />
              <path d="M17.4 19.4l2 2" />
              <path d="M19.4 4.6l-2 2" />
              <path d="M4.6 19.4l2-2" />
            </svg>
          </span>
          <span data-dsh-scard="name">个人秘书</span>
          <span data-dsh-scard="tag">AI 助手</span>
        </div>
        <SecretarySpeakButton speakKey={key} rawText={body} readKey={key} />
      </div>
      <div {...foldProps}>
        <div data-dsh-scard="content" ref={mainRef} style={bodyStyle}>
          {title !== '' && <h1 data-dsh-scard="title">{inlineAnswerText(title)}</h1>}
          {paragraphs.map((line, index) => (<p key={`para:${index}`} data-dsh-scard="para">{inlineAnswerText(line)}</p>))}
          {refs.map((ref) => (
            <button
              key={ref.sessionId}
              type="button"
              data-dsh-scard="ref"
              title={`打开会话：${ref.title}`}
              onClick={(event: any) => {
                event.stopPropagation()
                if (turnNo !== '') readState.markRead(key)
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
      {/* 附件区：折叠区之外，始终可见，也不进折叠高度测量（mainRef 只包住折叠区里的 content） */}
      {attaches.length > 0 && (
        <div data-dsh-scard="attachments" aria-label="附件">
          {attaches.map((attachment) => (
            <ReplyAttachmentPiece key={attachment.path} attachment={attachment} />
          ))}
        </div>
      )}
      <div data-dsh-scard="foot">
        {/* 三种卡同一颗引用按钮：都放在时间左边，规格与时间右边那棵复制按钮完全一样 */}
        <QuoteCardButton
          cardKey={key}
          kind={CARD_KIND_ASSISTANT}
          turnNo={turnNo}
          preview={display}
          body={display}
          refSessionIds={refs.map((ref) => ref.sessionId)}
          onToggled={() => { if (turnNo !== '') readState.markRead(key) }}
        />
        <time data-dsh-scard="time">{timeText}</time>
        <div data-dsh-scard="actions">
          <CopyAnswerButton fullText={display} onCopied={() => { if (turnNo !== '') readState.markRead(key) }} />
          {overflow && <span data-dsh-scard="separator" aria-hidden="true" />}
          <ExpandCollapseButton open={open} overflow={overflow} onToggle={toggle} />
        </div>
      </div>
    </article>
  )
}

/** 脚部时间（时间紧贴复制按钮左侧）与折叠块间距：给测试与两种卡共用。 */
export const CARD_FOLD_BLOCK_GAP = FOLD_BLOCK_GAP