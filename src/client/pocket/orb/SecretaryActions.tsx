/**
 * 秘书回复卡片的「右侧操作区」：朗读按钮气泡 + 会话引用块。
 *
 * 挂在 conversation.chat.assistant-actions（宿主渲染在每条助理消息的图标行里），
 * 只对固定秘书会话出现，其它会话返回 null —— 普通会话外观零变化。
 *
 * 朗读交互（与需求逐条对应）：
 *   - 默认自动朗读：最末一轮的卡片出现后自动开读（每轮只自动读一次）；
 *   - 单击：暂停 / 继续；
 *   - 长按 600ms：从头重读；
 *   - 只读当前卡片内容：文本来自本轮 DOM 正文，经 normalizeForSpeech；
 *   - 切卡片停上一条：全局唯一 controller，request 新 key 先停旧播放器。
 *   - 只用宿主 /api/assistant/tts（微软 edge-tts），不用 speechSynthesis。
 *
 * 引用块：正文里的 [[session:<id>|<标题>]] 渲染成可点 chips，点击按会话 id
 * 走既有会话选择逻辑（orb-api 的 openSession/focusSession），不新造路由。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { peekSecretarySessionId } from '../../assistant-entry.ts'
import { collectTurnText, normalizeForSpeech, parseSessionRefs } from './secretary-cards.ts'
import { secretarySpeech } from './secretary-speech.ts'
import type { OrbApi } from './orb-api.ts'

/** 已经自动朗读过的轮次 key（防止重挂载后反复自动读）。 */
const autoReadKeys = new Set<string>()

/** 当前 DOM 里最大的轮次号（= 最末一轮）。 */
function latestTurnNo(doc: Document): string {
  let max = -1
  let out = ''
  for (const el of doc.querySelectorAll('[data-chat-turn]')) {
    const value = Number(el.getAttribute('data-chat-turn'))
    if (Number.isFinite(value) && value > max) { max = value; out = String(value) }
  }
  return out
}

const LONG_PRESS_MS = 600

export function SecretaryActions({ sessionId, api }: { sessionId?: string; api?: OrbApi }): any {
  const id = String(sessionId ?? '')
  const isSecretary = id !== '' && id === peekSecretarySessionId()
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const [turn, setTurn] = useState('')
  const [rawText, setRawText] = useState('')
  const lpTimer = useRef<number | null>(null)
  const lpFired = useRef(false)
  const state = useSyncExternalStore(secretarySpeech.subscribe, secretarySpeech.getSnapshot)

  useEffect(() => {
    if (!isSecretary) return
    const el = rootRef.current
    if (el === null) return
    let alive = true
    const read = (): void => {
      if (!alive) return
      const turnNo = el.closest('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? ''
      setTurn(turnNo)
      setRawText(collectTurnText(document, turnNo))
    }
    read()
    const timer = window.setTimeout(read, 400)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [isSecretary])

  const key = `turn:${turn}`
  const speechText = normalizeForSpeech(rawText)

  // 自动朗读：只读最末一轮，每轮一次
  useEffect(() => {
    if (!isSecretary || turn === '' || speechText === '') return
    if (turn !== latestTurnNo(document)) return
    if (autoReadKeys.has(key)) return
    autoReadKeys.add(key)
    secretarySpeech.request(key, speechText)
  }, [isSecretary, turn, speechText, key])

  useEffect(() => () => { if (lpTimer.current !== null) window.clearTimeout(lpTimer.current) }, [])

  if (!isSecretary) return null
  // 根节点必须无条件渲染（ref 要靠它定位轮次取正文）；没有正文时只渲染空壳
  if (rawText.trim() === '') return <span ref={rootRef} data-dsh-speak="wrap" data-empty="1" />
  const refs = parseSessionRefs(rawText)
  const mine = state.key === key
  const status = mine ? state.status : 'idle'
  const label = status === 'playing' ? '暂停朗读' : status === 'paused' ? '继续朗读'
    : status === 'loading' ? '朗读中…' : status === 'error' ? `朗读失败（${state.error}）` : '朗读本条'

  const clearLp = (): void => { if (lpTimer.current !== null) { window.clearTimeout(lpTimer.current); lpTimer.current = null } }
  const onDown = (): void => {
    lpFired.current = false
    clearLp()
    lpTimer.current = window.setTimeout(() => { lpTimer.current = null; lpFired.current = true; secretarySpeech.restart(key, speechText) }, LONG_PRESS_MS)
  }
  const onUp = (): void => {
    clearLp()
    if (lpFired.current) { lpFired.current = false; return }
    secretarySpeech.toggle(key, speechText)
  }

  return (
    <span ref={rootRef} data-dsh-speak="wrap">
      <button
        type="button"
        data-dsh-speak="button"
        data-status={status}
        aria-label={label}
        title={`${label}（长按从头重读）`}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerLeave={clearLp}
        onKeyDown={(event: any) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); secretarySpeech.toggle(key, speechText) }
        }}
      >
        {status === 'playing' ? '⏸' : status === 'paused' ? '▶' : status === 'loading' ? '…' : '🔊'}
      </button>
      {refs.map((ref) => (
        <button
          key={ref.sessionId}
          type="button"
          data-dsh-speak="ref"
          title={`打开会话：${ref.title}`}
          onClick={() => {
            try { api?.openSession?.(ref.sessionId) } catch { /* 交给 focusSession 兜底 */ }
            void api?.focusSession?.(ref.sessionId).catch(() => {})
          }}
        >
          ↗ {ref.title}
        </button>
      ))}
    </span>
  )
}
