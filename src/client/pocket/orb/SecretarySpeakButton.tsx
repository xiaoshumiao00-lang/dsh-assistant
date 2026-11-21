/**
 * 秘书卡片「朗读气泡」：小圆形按钮，放在卡片标题行最右。
 *
 * 交互（与需求逐条对应，状态机不变）：
 *   - 单击：暂停 / 继续；
 *   - 长按 600ms：从头重读；
 *   - 换卡片（换 key request）：全局唯一 controller 先停上一条；
 *   - 只用宿主 /api/assistant/tts（微软 edge-tts），不用 speechSynthesis。
 *
 * 回复卡与主动服务卡共用这一个按钮；自动朗读只由回复卡（最末一轮）发起。
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
  const label = status === 'playing' ? '暂停朗读' : status === 'paused' ? '继续朗读'
    : status === 'loading' ? '朗读中…' : status === 'error' ? `朗读失败（${state.error}）` : '朗读本条'

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
      aria-label={label}
      title={`${label}（长按从头重读）`}
      onPointerDown={(event: any) => { event.stopPropagation(); onDown() }}
      onPointerUp={(event: any) => { event.stopPropagation(); onUp() }}
      onPointerLeave={clearLp}
      onClick={(event: any) => { event.stopPropagation() }}
      onKeyDown={(event: any) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); secretarySpeech.toggle(speakKey, speechText) }
      }}
    >
      {status === 'playing' ? '⏸' : status === 'paused' ? '▶' : status === 'loading' ? '…' : '🔊'}
    </button>
  )
}
