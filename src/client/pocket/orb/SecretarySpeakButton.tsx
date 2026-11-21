/**
 * 卡片规范 v1.0 的头部朗读按钮：34px 右上角线性扬声器，不显示「...」或别的功能入口。
 *
 * TTS 状态机保持不变（与需求逐条对应）：
 *   - 单击：暂停 / 继续；
 *   - 长按 600ms：从头重读；
 *   - 换卡片（换 key request）：全局唯一 controller 先停上一条；
 *   - 只用宿主 /api/assistant/tts（微软 edge-tts），不用 speechSynthesis。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { normalizeForSpeech } from './secretary-cards.ts'
import { secretarySpeech } from './secretary-speech.ts'

const LONG_PRESS_MS = 600

export function SecretarySpeakButton({ speakKey, rawText }: { speakKey: string; rawText: string }): any {
  const lpTimer = useRef<number | null>(null)
  const lpFired = useRef(false)
  const state = useSyncExternalStore(secretarySpeech.subscribe, secretarySpeech.getSnapshot)
  const speechText = normalizeForSpeech(rawText)

  useEffect(() => () => { if (lpTimer.current !== null) window.clearTimeout(lpTimer.current) }, [])

  const mine = state.key === speakKey
  const status = mine ? state.status : 'idle'
  const active = mine && (status === 'playing' || status === 'paused')
  const label = status === 'playing' ? '停止朗读'
    : status === 'paused' ? '继续朗读'
      : status === 'loading' ? '朗读准备中…'
        : status === 'error' ? `朗读失败（${state.error}）`
          : '朗读回答'

  const clearLp = (): void => { if (lpTimer.current !== null) { window.clearTimeout(lpTimer.current); lpTimer.current = null } }
  const onDown = (): void => {
    lpFired.current = false
    clearLp()
    lpTimer.current = window.setTimeout(() => { lpTimer.current = null; lpFired.current = true; secretarySpeech.restart(speakKey, speechText) }, LONG_PRESS_MS)
  }
  const onUp = (): void => {
    clearLp()
    if (lpFired.current) { lpFired.current = false; return }
    secretarySpeech.toggle(speakKey, speechText)
  }

  return (
    <button
      type="button"
      data-dsh-speak="button"
      data-status={status}
      aria-pressed={active ? 'true' : 'false'}
      aria-label={label}
      title={label}
      onPointerDown={(event: any) => { event.stopPropagation(); onDown() }}
      onPointerUp={(event: any) => { event.stopPropagation(); onUp() }}
      onPointerLeave={clearLp}
      onClick={(event: any) => { event.stopPropagation() }}
      onKeyDown={(event: any) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); secretarySpeech.toggle(speakKey, speechText) }
      }}
    >
      <svg data-dsh-speak="icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 5.5 6.5 9H3.5v6h3L11 18.5z" />
        <path d="M14.8 8.2a4 4 0 0 1 0 7.6" />
        <path d="M17.6 5.8a7 7 0 0 1 0 12.4" />
      </svg>
    </button>
  )
}
