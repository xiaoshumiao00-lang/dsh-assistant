/**
 * 秘书卡片朗读——浏览器侧胶水（只在页面里跑）。
 *
 * 播放器工厂：把文本 POST 给宿主 /api/assistant/tts（微软 edge-tts，MP3），
 * 拿回来用 HTMLAudioElement 播。**没有 speechSynthesis、没有任何其它引擎兜底**——
 * 微软这条路失败就是失败，状态机会进到 error，按钮变成「重试」。
 */
import { createSpeechController, type SpeechPlayer } from './secretary-cards.ts'

const TTS_ROUTE = '/api/assistant/tts'

/** 单条文本 → 一个播放器实例（fetch 合成 → blob → Audio）。 */
function playerFactory(_key: string, text: string): SpeechPlayer {
  let audio: HTMLAudioElement | null = null
  let objectUrl = ''
  let endedCb: (() => void) | null = null
  let playingCb: (() => void) | null = null
  let cancelled = false

  const ensure = async (): Promise<HTMLAudioElement> => {
    if (audio !== null) return audio
    const response = await fetch(TTS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      let detail = `TTS ${response.status}`
      try { detail = (await response.json())?.error ?? detail } catch { /* 保留状态码 */ }
      throw new Error(detail)
    }
    const blob = await response.blob()
    objectUrl = URL.createObjectURL(blob)
    audio = new Audio(objectUrl)
    audio.addEventListener('ended', () => { try { endedCb?.() } catch {} })
    audio.addEventListener('playing', () => { try { playingCb?.() } catch {} })
    return audio
  }

  return {
    async play(): Promise<void> {
      cancelled = false
      const el = await ensure()
      if (cancelled) return
      el.currentTime = 0
      await el.play()
    },
    pause(): void { try { audio?.pause() } catch {} },
    resume(): void { try { void audio?.play() } catch {} },
    restart(): void {
      cancelled = false
      void ensure().then((el) => { el.currentTime = 0; return el.play() }).catch(() => {})
    },
    stop(): void {
      cancelled = true
      try { audio?.pause() } catch {}
      try { if (objectUrl !== '') URL.revokeObjectURL(objectUrl) } catch {}
      audio = null
      objectUrl = ''
    },
    onEnded(cb: () => void): void { endedCb = cb },
    onPlaying(cb: () => void): void { playingCb = cb },
  }
}

/** 全局唯一朗读控制器（切卡片停上一条由控制器内部保证）。 */
export const secretarySpeech = createSpeechController(playerFactory)
