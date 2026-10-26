// 原生输入框里的录音按钮（替换官方语音插件那一颗）。
//
// 为什么要自己写：官方那颗是"整段录音一次送进去"，不切段、不纠错、还会把
// 输入法顶起来。这里用悬浮球同一套管线：录音 → 按停顿切段 → 逐段转写 →
// 术语纠正 → 按停顿长短补标点 → 插进草稿（不自动发送）。
//
// 挂载位置：conversation.input.activity（官方那颗也在同一个槽位，靠 CSS 藏掉官方那颗）。
// 槽位宿主会传 inputActions（提供 insertText）与 sessionId，我们只用 insertText。
import { useEffect, useRef, useState } from 'react'
import { MicCapture, VoiceError, voiceBlocked } from './voice.ts'
import type { VoiceSegment } from './voice.ts'
import { cleanFillers, fixTerms } from './asr-terms.ts'

interface ComposerMicProps {
  sessionId?: string
  locked?: boolean
  inputActions?: { insertText?: (text: string, span?: unknown) => boolean }
  /** 由 orb-apply 注入：按服务名取 remote.speech（拿不到返回 undefined）。 */
  speech?: () => any
  t?: (key: string) => string
}

/** 录音机图标（与悬浮球那颗同款）。 */
function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.8a2.8 2.8 0 0 0-2.8 2.8v6.6a2.8 2.8 0 0 0 5.6 0V5.6A2.8 2.8 0 0 0 12 2.8Z" />
      <path d="M18.4 11.2v1a6.4 6.4 0 0 1-12.8 0v-1" />
      <path d="M12 18.6v2.6" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5.5" y="5.5" width="13" height="13" rx="3.5" fill="currentColor" />
    </svg>
  )
}

export function ComposerMic({ locked, inputActions, speech, t }: ComposerMicProps) {
  const [rec, setRec] = useState<{ elapsed: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const captureRef = useRef<MicCapture | null>(null)
  const tickRef = useRef<number | null>(null)

  /** 行内提示（不用 window.alert：Electron 里 alert 会阻塞渲染进程，看着像卡死）。 */
  const notify = (message: string): void => {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => (current === message ? '' : current)), 3600)
  }

  const stopTick = (): void => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current)
      tickRef.current = null
    }
  }

  useEffect(() => () => {
    stopTick()
    captureRef.current?.cancel()
    captureRef.current = null
  }, [])

  /** 分段转写 + 术语纠正 + 按停顿补标点（与悬浮球完全同一套规则）。 */
  const transcribeAll = async (segments: VoiceSegment[]): Promise<string> => {
    const service = speech?.()
    if (service === undefined || typeof service.transcribe !== 'function') throw new Error('speech unavailable')
    let out = ''
    for (const segment of segments) {
      const result = await service.transcribe({ audioBase64: segment.audio })
      if (result?.ok === false) throw new Error(result?.error?.message ?? 'transcribe rejected')
      const value = result?.ok === true ? result.value : result
      const part = cleanFillers(fixTerms(String(value?.text ?? '').trim()))
      if (part === '') continue
      if (out === '') {
        out = part
        continue
      }
      const sep = /[。！？!?…；;，,、]$/.test(out)
        ? ''
        : segment.gapMs >= 1200
          ? '。'
          : segment.gapMs >= 400
            ? '，'
            : ''
      out += sep + part
    }
    return out
  }

  const insert = (text: string): void => {
    if (text === '') return
    const inserted = inputActions?.insertText?.(text) ?? false
    if (!inserted) return
    // 插完立刻收键盘：说话场景不该被输入法挡着
    try { (document.activeElement as HTMLElement | null)?.blur?.() } catch { /* 忽略 */ }
  }

  const finish = async (): Promise<void> => {
    const capture = captureRef.current
    if (capture === null) return
    captureRef.current = null
    stopTick()
    setRec(null)
    setBusy(true)
    try {
      const segments = await capture.stop(60)
      insert(await transcribeAll(segments))
    } catch (error) {
      console.warn('[pocket-mic] transcribe failed:', error)
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    if (rec !== null || busy || locked === true) return
    if (voiceBlocked() !== null) {
      notify('当前地址不是 https，浏览器不给麦克风；请用 https 地址打开。')
      return
    }
    // 录音前收键盘
    try { (document.activeElement as HTMLElement | null)?.blur?.() } catch { /* 忽略 */ }
    const capture = new MicCapture()
    captureRef.current = capture
    try {
      await capture.start()
    } catch (error) {
      captureRef.current = null
      capture.cancel()
      if (error instanceof VoiceError && error.kind === 'permission') {
        notify('没有麦克风权限，请在浏览器里允许后重试。')
      }
      return
    }
    if (captureRef.current !== capture) {
      capture.cancel()
      return
    }
    setRec({ elapsed: 0 })
    const startedAt = Date.now()
    tickRef.current = window.setInterval(() => {
      setRec({ elapsed: Math.floor((Date.now() - startedAt) / 1000) })
      if (Date.now() - startedAt >= 60_000) void finish()
    }, 200)
  }

  const label = t?.('voice') ?? '语音输入'
  return (
    <>
      <button
        type="button"
        data-pocket-mic="button"
        data-recording={rec !== null ? '1' : undefined}
        disabled={busy || locked === true}
        title={rec !== null ? '点击停止并转写' : label}
        aria-label={rec !== null ? '停止录音' : label}
        onClick={() => { if (rec !== null) void finish(); else void start() }}
      >
        {rec !== null ? <StopIcon /> : <MicIcon />}
        {busy && <span data-pocket-mic="busy">…</span>}
      </button>
      {notice !== '' && <span data-pocket-mic="notice">{notice}</span>}
    </>
  )
}
