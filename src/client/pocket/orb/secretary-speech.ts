/**
 * 秘书卡片朗读——浏览器侧胶水（只在页面里跑）。
 *
 * 播放器工厂：文本经 splitSpeechChunks 分块后逐块 POST 给宿主 /api/assistant/tts
 * （微软 edge-tts，MP3），第 1 块合成完即播，后续块在播放中预取合成，Web Audio
 * 时间轴上首尾相接排播（块间样本级连续、不重不漏）。**没有 speechSynthesis、
 * 没有任何其它引擎兜底**——微软这条路失败就是失败（每块重试一次），状态机进
 * error，按钮变成「朗读失败（原因）」。
 *
 * 缓存：块音频（解码后的 AudioBuffer）按文本指纹 LRU 缓存，同一句第二次朗读零合成秒播。
 * 打断：换卡片/停止/重读由控制器先停旧播放器——流水线程内 abort 全部 in-flight 请求并
 * 停掉已排播音频，不会和新文本叠声。
 */
import { createSpeechController, type SpeechPlayer } from './secretary-cards.ts'
import { createChunkPipeline, createSpeechClipCache, type SpeechSynthClip, type SpeechPlayback } from './secretary-speech-pipeline.ts'

const TTS_ROUTE = '/api/assistant/tts'

/** 预取窗口（块数）：第 N 块播放时 N+1 / N+2 已在合成。 */
const PREFETCH_CHUNKS = 2
/** 排播提前量：给音频线程留调度余量，避免块间可感知间隙。 */
const LEAD_IN_SEC = 0.03
/** 每块失败后的重试间隔（只重试一次）。 */
const RETRY_DELAY_MS = 300
/** 块音频缓存上限（LRU）。 */
const CLIP_CACHE_LIMIT = 64

let sharedCtx: AudioContext | null = null

function audioContext(): AudioContext {
  if (sharedCtx === null) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    sharedCtx = new Ctor!()
  }
  return sharedCtx
}

/** 进程内共享的块音频缓存（跨卡片/跨次播放复用）。 */
const clipCache = createSpeechClipCache(CLIP_CACHE_LIMIT)

async function decodeMp3(buf: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    // 新老实现兼容：有的返回 Promise，有的走回调
    const maybe = audioContext().decodeAudioData(buf, resolve, reject) as unknown
    if (maybe !== undefined && typeof (maybe as Promise<AudioBuffer>).then === 'function') {
      (maybe as Promise<AudioBuffer>).then(resolve, reject)
    }
  })
}

/** 单块合成：POST /api/assistant/tts → MP3 → 解码成 AudioBuffer。signal 必须贯穿 fetch。 */
async function synthesizeChunk(text: string, signal: AbortSignal): Promise<SpeechSynthClip> {
  const response = await fetch(TTS_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!response.ok) {
    let detail = `TTS ${response.status}`
    try { detail = (await response.json())?.error ?? detail } catch { /* 保留状态码 */ }
    throw new Error(detail)
  }
  const buf = await response.arrayBuffer()
  if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  const decoded = await decodeMp3(buf)
  return { durationSec: decoded.duration, payload: decoded }
}

/** 把一块音频排在音频时间轴的 whenSec 时刻（首尾相接靠调用方算准时间）。 */
function scheduleClip(clip: SpeechSynthClip, whenSec: number): SpeechPlayback {
  const ctx = audioContext()
  const source = ctx.createBufferSource()
  source.buffer = clip.payload as AudioBuffer
  source.connect(ctx.destination)
  let done!: () => void
  const finished = new Promise<void>((resolve) => { done = resolve })
  source.onended = () => done()
  try { source.start(whenSec) } catch (error) { done(); throw error }
  return {
    stop(): void {
      try { source.onended = null } catch { /* ignore */ }
      try { source.stop() } catch { /* 已播完的源 stop 会抛 InvalidStateError */ }
    },
    finished,
  }
}

/** 解锁提示：context 被自动播放策略挂起时，等真正 running 再报 playing（最多等 5s）。 */
function whenAudible(cb: () => void): void {
  const ctx = audioContext()
  if (ctx.state === 'running') { cb(); return }
  let fired = false
  const fire = (): void => { if (fired) return; fired = true; try { ctx.removeEventListener('statechange', onState) } catch { /* ignore */ }; cb() }
  const onState = (): void => { if (ctx.state === 'running') fire() }
  try { ctx.addEventListener('statechange', onState) } catch { fire(); return }
  window.setTimeout(fire, 5000)
}

/** 单条文本 → 一个分块流水线播放器实例（fetch 合成 → Web Audio 排播）。 */
function playerFactory(_key: string, text: string): SpeechPlayer {
  const pipeline = createChunkPipeline({
    now: () => audioContext().currentTime,
    synthesize: synthesizeChunk,
    schedule: scheduleClip,
    suspend: () => { void audioContext().suspend() },
    resume: () => { void audioContext().resume().catch(() => { /* 无手势时拒绝：等用户手势 */ }) },
    wait: (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms) }),
  }, { text, cache: clipCache, prefetch: PREFETCH_CHUNKS, leadInSec: LEAD_IN_SEC, retryDelayMs: RETRY_DELAY_MS })

  return {
    play: () => pipeline.play(),
    pause: () => pipeline.pause(),
    resume: () => pipeline.resume(),
    restart: () => pipeline.restart(),
    stop: () => pipeline.stop(),
    onEnded: (cb) => pipeline.onEnded(cb),
    onPlaying: (cb) => pipeline.onPlaying(() => whenAudible(cb)),
    onError: (cb) => pipeline.onError(cb),
  }
}

/** 全局唯一朗读控制器（切卡片停上一条由控制器内部保证）。 */
export const secretarySpeech = createSpeechController(playerFactory)
