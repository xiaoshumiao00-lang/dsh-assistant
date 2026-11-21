/**
 * 秘书回复卡片（设计规范 v1.0）：白卡 + 头部助手标识/朗读按钮 + 正文标题段落 + 底部操作栏。
 *
 * 结构（自上而下）：
 *   1. 头部：左 32px 紫色四角星助手标识、名称「个人秘书」、身份标签「AI 助手」；右只有一个 34px 朗读按钮；
 *   2. 正文：15px 结论标题 + 13px/1.8 正文段落；模型名自动渲染成浅紫等宽行内标签；
 *   3. 底部操作栏：左侧时间，右侧复制 → 0.5px 分隔线 → 「展开全文」（仅溢出时）；
 *   4. 朗读按钮只出现在头部，不出现在底部；整张卡片不再承担点击展开职责。
 *
 * TTS 状态机不变：换卡停上一条、单击暂停/继续、长按 600ms 从头重读；本组件只改按钮呈现与可访问性。
 */
import { useEffect, useRef, useState } from 'react'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import {
  answerInlineTokens, collectTurnText, formatClock, latestReplyTurnNo, parseAnswerBody,
  parseSessionRefs, stripSessionRefs, normalizeForSpeech,
} from './secretary-cards.ts'
import { secretarySpeech } from './secretary-speech.ts'
import { SecretarySpeakButton } from './SecretarySpeakButton.tsx'
import type { OrbApi } from './orb-api.ts'

/** 已经自动朗读过的轮次 key（防止重挂载后反复自动读）。 */
const autoReadKeys = new Set<string>()

/** 从宿主 turn 对象里尽量拿轮次结束时间（epoch ms 或 ISO；拿不到回空串，底行就不显示时间）。 */
function turnEndTime(turn: any): string {
  try {
    const value = turn?.end?.time ?? turn?.end?.event?.time ?? turn?.end?.data?.time ?? ''
    if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value))
    return typeof value === 'string' ? value : ''
  } catch { return '' }
}

function inlineAnswerText(text: string): any {
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

function CopyAnswerButton({ fullText }: { fullText: string }): any {
  const [status, setStatus] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timerRef = useRef<number | null>(null)

  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])

  const show = (next: 'ok' | 'fail'): void => {
    setStatus(next)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setStatus('idle'), next === 'ok' ? 1500 : 4000)
  }

  const onCopy = async (): Promise<void> => {
    const ok = await copyAnswerText(fullText)
    show(ok ? 'ok' : 'fail')
  }

  const ariaLabel = status === 'ok' ? '已复制' : status === 'fail' ? '复制失败' : '复制完整回答'
  return (
    <>
      <button type="button" data-dsh-scard="copy" title="复制完整回答" aria-label={ariaLabel} onClick={() => void onCopy()}>
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

function ExpandCollapseButton({ open, onToggle, overflow }: { open: boolean; onToggle: () => void; overflow: boolean }): any {
  if (!overflow) return null
  return (
    <button type="button" data-dsh-scard="expand" aria-expanded={open} onClick={onToggle} title={open ? '收起回答' : '展开全文'}>
      <span data-dsh-scard="expand-text">{open ? '收起' : '展开全文'}</span>
      <svg data-dsh-scard="expand-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
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

  const key = `turn:${turnNo}`
  const display = stripSessionRefs(body).trim()
  const speechText = normalizeForSpeech(body)
  const { title, paragraphs } = parseAnswerBody(display)
  const refs = parseSessionRefs(body)
  const contentBlocks = paragraphs.length + refs.length
  const collapsedBlockCount = Math.min(3, contentBlocks)

  // 自动朗读：只读最末一轮，每轮一次
  useEffect(() => {
    if (!isSecretary || turnNo === '' || speechText === '') return
    if (turnNo !== latestReplyTurnNo(document)) return
    if (autoReadKeys.has(key)) return
    autoReadKeys.add(key)
    secretarySpeech.request(key, speechText)
  }, [isSecretary, turnNo, speechText, key])

  // 折叠态只显示前 3 个内容块；实际溢出的判断用 scrollHeight 对 clientHeight，未溢出则不渲染展开全文。
  useEffect(() => {
    if (!isSecretary || display === '' || open) return
    const el = mainRef.current
    if (el === null) return
    const measure = (): void => {
      const titleEl = el.querySelector('[data-dsh-scard="title"]') as HTMLElement | null
      const blockEls = [...el.querySelectorAll('[data-dsh-scard="para"], [data-dsh-scard="ref"]')] as HTMLElement[]
      const visible = blockEls.slice(0, collapsedBlockCount)
      const titleHeight = titleEl?.offsetHeight ?? 0
      const blockHeight = visible.reduce((sum, item) => sum + item.offsetHeight, 0)
      const gap = 10
      const collapsedHeight = titleHeight + blockHeight + visible.length * gap
      setCollapsedMaxHeight(collapsedHeight)
      const hasMoreBlocks = blockEls.length > collapsedBlockCount
      setOverflow(hasMoreBlocks || el.scrollHeight > collapsedHeight + 1)
    }
    measure()
    const timer = window.setTimeout(measure, 400)
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', onResize) }
  }, [collapsedBlockCount, display, isSecretary, open, paragraphs.length, refs.length])

  if (!isSecretary) return null
  // 根节点必须无条件渲染（ref 要靠它定位轮次）；空壳由 CSS 整体隐藏（不输出占位条）
  if (display === '') return <article ref={wrapRef as any} data-dsh-scard="card" data-empty="1" />

  const timeText = formatClock(turnEndTime(turn))
  const bodyStyle = open ? undefined : (collapsedMaxHeight === undefined ? undefined : { maxHeight: `${collapsedMaxHeight}px` })

  return (
    <article
      ref={wrapRef as any}
      data-dsh-scard="card"
      data-dsh-scard-turn={turnNo}
      data-empty="0"
      data-open={open ? '1' : '0'}
      data-overflow={overflow ? '1' : '0'}
    >
      <div data-dsh-scard="head">
        <div data-dsh-scard="assistant">
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
        <SecretarySpeakButton speakKey={key} rawText={body} />
      </div>
      <div data-dsh-scard="body">
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
                try { api?.openSession?.(ref.sessionId) } catch { /* 交给 focusSession 兜底 */ }
                void api?.focusSession?.(ref.sessionId).catch(() => {})
              }}
            >
              <span data-dsh-scard="ref-icon" aria-hidden="true">↗</span>
              <span data-dsh-scard="ref-title">{ref.title}</span>
            </button>
          ))}
        </div>
      </div>
      <div data-dsh-scard="foot">
        <time data-dsh-scard="time">{timeText}</time>
        <div data-dsh-scard="actions">
          <CopyAnswerButton fullText={display} />
          {overflow && <span data-dsh-scard="separator" aria-hidden="true" />}
          <ExpandCollapseButton open={open} overflow={overflow} onToggle={() => setOpen((value) => !value)} />
        </div>
      </div>
    </article>
  )
}
