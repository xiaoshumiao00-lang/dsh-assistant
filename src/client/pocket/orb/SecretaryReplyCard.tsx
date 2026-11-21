/**
 * 秘书回复卡片（卡片规范 v1.1，2026-11-21 第二轮改动）：白卡 + 头部助手标识/朗读按钮 + 正文标题段落 + 底部操作栏。
 *
 * 结构（自上而下）：
 *   1. 未读红点：只在「这条卡没被朗读过、也没被点过/复制过」时出现（8px #D83A2B，卡头顶边、标识组左侧）；
 *   2. 头部：左 32px 紫色四角星助手标识、名称「个人秘书」、身份标签「AI 助手」；右只有一个 34px 朗读按钮；
 *   3. 正文：**折叠态最多 3 行正文**（超出部分打「…」省略标记，不用渐变遮罩）；17px 结论标题 + 15px/1.8 正文段落；
 *      模型名自动渲染成浅紫等宽行内标签；会话引用渲染成可点击 chip；
 *   4. 卡体正文区域本身可点击/可键盘切换（Enter/Space）展开与收起：role=button + aria-expanded，
 *      内部那颗朗读/复制/展开全文按钮与引用 chip 都 stopPropagation，点卡体不会触发它们；
 *   5. 底部操作栏：时间（HH:MM）紧贴复制按钮左侧 → 复制 → 0.5px 分隔线 → 「展开全文」（仅溢出时）；
 *   6. 朗读按钮只出现在头部，不出现在底部。
 *
 * TTS 状态机不变：换卡停上一条、单击暂停/继续、长按 600ms 从头重读。
 * 已读判据：这条卡被朗读过（含自动朗读，成功或被中断都算）或用户点过卡体/展开全文/复制 → 立刻写进已读集合。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import {
  answerInlineTokens, assistantCardSpeechKey, collectTurnText, foldClipFromBlocks, formatClock, latestReplyTurnNo, parseAnswerBody,
  parseSessionRefs, stripSessionRefs, normalizeForSpeech, secretaryReadStore,
  CARD_KIND_ASSISTANT, FOLD_BODY_LINE_BUDGET, FOLD_BLOCK_GAP,
  type FoldBlockBox, type FoldGeometryOut,
} from './secretary-cards.ts'
import { secretarySpeech } from './secretary-speech.ts'
import { SecretarySpeakButton } from './SecretarySpeakButton.tsx'
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

/** 一个正文块的行高：CSS 正文 15px / 1.8 → 27px；取 computed 值，不在组件里写死数字。 */
export function blockLineHeightPx(el: HTMLElement): number {
  const cs = (typeof window !== 'undefined' ? window : el.ownerDocument?.defaultView ?? window).getComputedStyle(el)
  const lineHeight = Number.parseFloat(cs?.lineHeight ?? '')
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
  const fontSize = Number.parseFloat(cs?.fontSize ?? '') || 15
  return fontSize * 1.8
}

/** 折叠几何输出直接沿用 secretary-cards.ts 的那套（避免两套定义漂移）。 */
export type FoldGeometry = FoldGeometryOut

/** 从 DOM 量出正文块的位置与高度，算术全交给 secretary-cards.ts 的 foldClipFromBlocks（测试也直接验它）。 */
export function measureFoldClip(contentEl: HTMLElement, budget: number = FOLD_BODY_LINE_BUDGET): FoldGeometry {
  const blocks = [...contentEl.querySelectorAll('[data-dsh-scard="title"], [data-dsh-scard="para"], [data-dsh-scard="ref"]')] as HTMLElement[]
  const bodyEls = blocks.filter((el) => el.getAttribute('data-dsh-scard') !== 'title')
  const natural = Math.max(1, contentEl.scrollHeight)
  if (bodyEls.length === 0) return { collapsedMaxHeight: undefined, overflow: false, bodyLines: 0, clip: natural }
  const boxes: FoldBlockBox[] = blocks.map((el) => ({
    kind: String(el.getAttribute('data-dsh-scard')) as 'title' | 'para' | 'ref',
    top: el.offsetTop,
    height: el.offsetHeight,
  }))
  return foldClipFromBlocks({ blocks: boxes, naturalHeight: natural, lineHeight: blockLineHeightPx(bodyEls[0]), budget })
}

/** 卡体正文区域（可点击/可键盘展开收起）：三种卡共用同一套语义与手势。 */
export function useCardFoldRegion(open: boolean, overflow: boolean, toggle: () => void) {
  const regionRef = useRef<HTMLDivElement | null>(null)

  const guard = (event: any): boolean => {
    // 卡体里的按钮（引用 chip）与脚部/头部按钮都不会经由卡体触发
    const target: HTMLElement | null = event?.target instanceof HTMLElement ? event.target : null
    if (target !== null && target.closest('[data-dsh-speak="button"], [data-dsh-scard="copy"], [data-dsh-scard="expand"], [data-dsh-scard="ref"], [data-dsh-scard="head"]') !== null) return true
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

export function SecretaryReplyCard({ sessionId, turn, api }: { sessionId?: string; turn?: any; api?: OrbApi }): any {
  const id = String(sessionId ?? '')
  const isSecretary = id !== '' && id === peekSecretarySessionId()
  const wrapRef = useRef<HTMLElement | null>(null)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const [turnNo, setTurnNo] = useState('')
  const [body, setBody] = useState('')
  const [open, setOpen] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const [collapsedMaxHeight, setCollapsedMaxHeight] = useState<number | undefined>(undefined)

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
    // 尾节点与正文同帧挂载，但投影/分页可能晚一拍：400ms 后再读一次兜底
    const timer = window.setTimeout(read, 400)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [isSecretary])

  const key = assistantCardSpeechKey(turnNo)
  const readState = useSecretaryReadState(id)
  const display = stripSessionRefs(body).trim()
  const speechText = normalizeForSpeech(body)
  const { title, paragraphs } = parseAnswerBody(display)
  const refs = parseSessionRefs(body)
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

  // 折叠态：正文最多 3 行；实际溢出靠 measureFoldClip 的落点判断，未溢出就不渲染省略标记与展开全文
  useEffect(() => {
    if (!isSecretary || display === '' || open) return
    const el = mainRef.current
    if (el === null) return
    const measure = (): void => {
      const geometry = measureFoldClip(el)
      setCollapsedMaxHeight(geometry.collapsedMaxHeight)
      setOverflow(geometry.overflow)
    }
    measure()
    const timer = window.setTimeout(measure, 400)
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    // 宿主轮次文字会边走边变（streaming/收尾重写）：正文一变就重新量，绝不留下过期的折叠落点
    // （实测过期状态：max-height 245px 但正文只有 211px → 没有真截断却还挂着「…」标记）。
    let frame = 0
    const remeasure = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => { frame = 0; measure() })
    }
    const mutationObserver = new MutationObserver(remeasure)
    mutationObserver.observe(el, { childList: true, subtree: true, characterData: true })
    const resizeObserver = new ResizeObserver(remeasure)
    resizeObserver.observe(el)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      if (frame !== 0) window.cancelAnimationFrame(frame)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [display, isSecretary, open, paragraphs.length, refs.length])

  // 折叠区里的 hooks（useCardFoldRegion）必须在任何条件 return 之前调用：
  // 首帧正文为空 → 走到空壳 return，下一帧正文到位 → 走到完整 return，
  //  hooks 数量对不上就是「Rendered more hooks than during the previous render」，
  //  宿主 slot 的错误边界吃掉它，卡片整块静默消失（实测：页面上没有任何 assistant 卡）。
  const toggle = (): void => { setOpen((value) => !value); if (turnNo !== '') readState.markRead(key) }
  const { foldProps } = useCardFoldRegion(open, overflow, toggle)
  const timeText = formatClock(turnEndTime(turn))
  const bodyStyle = open ? undefined : (collapsedMaxHeight === undefined ? undefined : { maxHeight: `${collapsedMaxHeight}px` })

  if (!isSecretary) return null
  // 根节点必须无条件渲染（ref 要靠它定位轮次）；空壳由 CSS 整体隐藏（不输出占位条）
  if (display === '') return <article ref={wrapRef as any} data-dsh-scard="card" data-dsh-scard-kind={CARD_KIND_ASSISTANT} data-empty="1" />


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
          <h1 data-dsh-scard="title">{inlineAnswerText(title)}</h1>
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
      <div data-dsh-scard="foot">
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