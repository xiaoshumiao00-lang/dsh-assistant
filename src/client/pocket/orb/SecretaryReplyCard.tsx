/**
 * 秘书回复卡片：秘书会话里**每一条**模型回复渲染成一张层次分明的卡片。
 *
 * 结构（自上而下，2026-11-21 按用户手机实测反馈重做）：
 *   1. 标题行：小图标 +「个人秘书」标签 + 一句话摘要 + 最右朗读气泡（小圆形、淡描边）；
 *   2. 正文主区：14px、行高 1.6、按空行分段；[[session:<id>|<标题>]] 渲染成
 *      「左细竖线 + 淡底」的可点引用块（点击跳进对应会话，不触发折叠）；
 *   3. 底部信息行：12px 灰回复时间（从宿主 Turn 对象取）+ 右侧展开/收起轻提示。
 *
 * 固定高度 + 点击展开/折叠与主动服务卡共用 fold-card.css.ts 的实现
 * （data-dsh-fold="card|main|foot"；折叠 226/212px，超出的正文被底部渐隐遮罩盖住，
 * 不出现半个字；点整张卡片切换，展开态底部提示「点击收起」）。
 *
 * 实现方式（不碰其它会话）：
 *   - 挂在 conversation.chat.turnTail（每轮一个），只对固定秘书会话渲染；
 *   - 正文从同一轮的 DOM 里取（[data-chat-turn] 下非 reasoning 的 assistant-step），
 *     所以读到的就是模型真实回复，TTS 与展示同源；
 *   - CSS 在秘书会话里把原始 markdown 气泡、过程信息行、消息操作行隐藏
 *     （body[data-dsh-secretary="1"]）；其它会话这些选择器一律不命中。
 *
 * 朗读（需求①）：标题行最右的气泡，单击暂停/继续、长按 600ms 从头重读、
 * 换卡片停上一条（全局唯一 controller）；最末一轮的卡片出现后自动朗读一次。
 */
import { useEffect, useRef, useState } from 'react'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import {
  collectTurnText, formatClock, latestTurnNo, parseSessionRefs,
  stripSessionRefs, summarize, normalizeForSpeech,
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

export function SecretaryReplyCard({ sessionId, turn, api }: { sessionId?: string; turn?: any; api?: OrbApi }): any {
  const id = String(sessionId ?? '')
  const isSecretary = id !== '' && id === peekSecretarySessionId()
  const wrapRef = useRef<HTMLElement | null>(null)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const [turnNo, setTurnNo] = useState('')
  const [body, setBody] = useState('')
  const [open, setOpen] = useState(false)
  const [overflow, setOverflow] = useState(false)

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

  // 自动朗读：只读最末一轮，每轮一次
  useEffect(() => {
    if (!isSecretary || turnNo === '' || speechText === '') return
    if (turnNo !== latestTurnNo(document)) return
    if (autoReadKeys.has(key)) return
    autoReadKeys.add(key)
    secretarySpeech.request(key, speechText)
  }, [isSecretary, turnNo, speechText, key])

  // 折叠态才需要测溢出：正文超出固定高度 → 底行右侧给出「点击展开全文」提示
  useEffect(() => {
    if (open) return
    const el = mainRef.current
    if (el === null) return
    const measure = (): void => { setOverflow(el.scrollHeight > el.clientHeight + 1) }
    measure()
    const timer = window.setTimeout(measure, 400)
    return () => { window.clearTimeout(timer) }
  }, [display, open])

  if (!isSecretary) return null
  // 根节点必须无条件渲染（ref 要靠它定位轮次）；空壳由 CSS 整体隐藏（不输出占位条）
  if (display === '') return <article ref={wrapRef as any} data-dsh-scard="card" data-empty="1" />

  const refs = parseSessionRefs(body)
  const paragraphs = display.split(/\n{2,}|\n/).map((line) => line.trim()).filter((line) => line !== '')
  const timeText = formatClock(turnEndTime(turn))

  return (
    <article
      ref={wrapRef as any}
      data-dsh-scard="card"
      data-dsh-fold="card"
      data-dsh-scard-turn={turnNo}
      data-empty="0"
      data-open={open ? '1' : '0'}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event: any) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((value) => !value) }
      }}
    >
      <div data-dsh-scard="head">
        <span data-dsh-scard="icon" aria-hidden="true">✦</span>
        <span data-dsh-scard="badge">个人秘书</span>
        <span data-dsh-scard="title">{summarize(display)}</span>
        <SecretarySpeakButton speakKey={key} rawText={body} />
      </div>
      <div data-dsh-scard="main" data-dsh-fold="main" ref={mainRef}>
        <div data-dsh-scard="body">
          {paragraphs.map((line, index) => (<p key={index} data-dsh-scard="para">{line}</p>))}
        </div>
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
      <div data-dsh-scard="meta" data-dsh-fold="foot">
        <span data-dsh-scard="time">{timeText}</span>
        {overflow && (
          <span data-dsh-scard="hint">{open ? '点击收起' : '点击展开全文'}</span>
        )}
      </div>
    </article>
  )
}
