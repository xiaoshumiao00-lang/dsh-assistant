// 悬浮球语音输入：手机麦克风录音 → 16kHz 单声道 PCM16 WAV → base64。
//
// 转写不在手机上做，而是交给**运行 DSH 的那台电脑**（官方 voice-input bundle 的
// speech Remote + 本地 SenseVoice）。所以手机只要能把音频送过去，转写质量与
// 语言能力完全跟电脑端一致，音频也不出局域网/隧道。
//
// 音频格式必须与官方实现逐字节一致：16kHz / 单声道 / 16bit WAV（44 字节头），
// 否则 Host 端会拒收或转出乱码。

/** Host 端 SenseVoice 期望的采样率。 */
export const TARGET_RATE = 16000

/** 浏览器能否录音（安全上下文 + 麦克风 API + MediaRecorder 三者缺一不可）。 */
export function voiceBlocked(): 'insecure' | 'unsupported' | null {
  if (typeof window === 'undefined') return 'unsupported'
  // 局域网 http 访问时 getUserMedia 直接不存在/拒绝——先给出可解释的原因，
  // 别让用户以为是权限没点。
  if (window.isSecureContext === false) return 'insecure'
  const devices = navigator.mediaDevices
  if (devices === undefined || typeof devices.getUserMedia !== 'function') return 'unsupported'
  if (typeof MediaRecorder === 'undefined') return 'unsupported'
  return null
}

export type VoiceErrorKind = 'permission' | 'empty' | 'unsupported' | 'interrupted'

/** 录音失败：kind 供调用方映射成本地化提示。 */
export class VoiceError extends Error {
  kind: VoiceErrorKind

  constructor(kind: VoiceErrorKind) {
    super(kind)
    this.kind = kind
    this.name = 'VoiceError'
  }
}

/** 去直流偏置 + 峰值归一化。手机离得远、说话偏小时，这一步能明显减少听错。 */
export function condition(samples: Float32Array): Float32Array {
  const length = samples.length
  if (length === 0) return samples
  let mean = 0
  for (let i = 0; i < length; i += 1) mean += samples[i]
  mean /= length
  const out = new Float32Array(length)
  let peak = 0
  for (let i = 0; i < length; i += 1) {
    const value = samples[i] - mean
    out[i] = value
    const abs = value < 0 ? -value : value
    if (abs > peak) peak = abs
  }
  // 最多放大 8 倍：再大就把底噪也放大成"声音"，反而更糟
  const gain = peak > 1e-4 ? Math.min(0.95 / peak, 8) : 1
  if (gain !== 1) {
    for (let i = 0; i < length; i += 1) {
      const value = out[i] * gain
      out[i] = value > 1 ? 1 : value < -1 ? -1 : value
    }
  }
  return out
}

/** 掐掉首尾静音（留 150ms 余量）：安静的头尾会让模型"听空"，也拖慢识别。 */
export function trimSilence(samples: Float32Array): Float32Array {
  const frameLen = Math.floor(TARGET_RATE * 0.02) // 20ms
  const frames = Math.floor(samples.length / frameLen)
  if (frames < 5) return samples
  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    const base = f * frameLen
    for (let i = base; i < base + frameLen; i += 1) sum += samples[i] * samples[i]
    rms[f] = Math.sqrt(sum / frameLen)
  }
  let maxR = 0
  for (let f = 0; f < frames; f += 1) if (rms[f] > maxR) maxR = rms[f]
  const threshold = Math.max(0.006, maxR * 0.05)
  let first = 0
  while (first < frames && rms[first] < threshold) first += 1
  let last = frames - 1
  while (last > first && rms[last] < threshold) last -= 1
  if (last <= first) return samples
  const pad = Math.floor((0.15 * TARGET_RATE) / frameLen)
  const startSample = Math.max(0, first - pad) * frameLen
  const endSample = Math.min(samples.length, (last + 1 + pad) * frameLen)
  return endSample > startSample ? samples.subarray(startSample, endSample) : samples
}

/** 切出来的一段音频 + 它前面的停顿长度（毫秒，第一段为 0）。 */
export interface VoiceSegment {
  /** base64 WAV */
  audio: string
  /** 这段之前停了多久：用来决定拼接处是句号、逗号还是直接连上 */
  gapMs: number
}

/** 静音点切段：在**真正的停顿**处切开（不是每 15 秒硬切一刀），
 * 每段 1.5–20 秒，这样每段都是一句完整的话，标点和识别率都会好很多。 */
export function splitSamples(samples: Float32Array, segmentSeconds = 20): Array<{ samples: Float32Array; gapMs: number }> {
  const rate = TARGET_RATE
  const frameLen = Math.floor(rate * 0.1) // 100ms 一帧
  const frames = Math.floor(samples.length / frameLen)
  if (frames === 0) return [{ samples, gapMs: 0 }]
  if (samples.length / rate <= segmentSeconds) return [{ samples, gapMs: 0 }]

  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    const base = f * frameLen
    for (let i = base; i < base + frameLen; i += 1) sum += samples[i] * samples[i]
    rms[f] = Math.sqrt(sum / frameLen)
  }
  let maxR = 0
  for (let f = 0; f < frames; f += 1) if (rms[f] > maxR) maxR = rms[f]
  // 停顿阈值：低于峰值的 6%，且不低于 0.004（纯静音）
  const threshold = Math.max(0.004, maxR * 0.06)

  // 连续 ≥200ms 的低声区间 = 一个停顿；记下"切点帧"和"这个停顿有多长"
  const cuts: Array<{ frame: number; ms: number }> = []
  let runStart = -1
  for (let f = 0; f < frames; f += 1) {
    const quiet = rms[f] < threshold
    if (quiet && runStart < 0) runStart = f
    if (runStart >= 0 && (!quiet || f === frames - 1)) {
      const runEnd = quiet ? f : f - 1
      const runFrames = runEnd - runStart + 1
      if (runFrames >= 2) {
        cuts.push({ frame: Math.round((runStart + runEnd + 1) / 2), ms: runFrames * 100 })
      }
      runStart = -1
    }
  }

  const minFrames = Math.floor(1.5 * 10) // 最短 1.5s
  const maxFrames = Math.floor(segmentSeconds * 10)
  const out: Array<{ samples: Float32Array; gapMs: number }> = []
  let startFrame = 0
  let pendingGap = 0
  while (startFrame < frames) {
    const hardEnd = Math.min(startFrame + maxFrames, frames)
    let endFrame = hardEnd
    let gapMs = 0
    if (hardEnd < frames) {
      // 取区间内**最后一个**停顿点：尽量让每段都停在一句话说完的地方
      let best: { frame: number; ms: number } | null = null
      for (const cut of cuts) {
        if (cut.frame > startFrame + minFrames && cut.frame <= hardEnd) best = cut
      }
      if (best !== null) {
        endFrame = best.frame
        gapMs = best.ms
      }
    }
    out.push({ samples: samples.subarray(startFrame * frameLen, endFrame * frameLen), gapMs: pendingGap })
    pendingGap = gapMs
    startFrame = endFrame
  }
  // 丢掉 <0.5s 的碎片（多半是咳嗽/杂音）
  const kept = out.filter((piece) => piece.samples.length > rate * 0.5)
  return kept.length > 0 ? kept : [{ samples, gapMs: 0 }]
}

/** 采样 → 若干段（每段带"前面停顿多久"，用来决定拼接处用句号还是逗号）。 */
export function samplesToSegments(samples: Float32Array, maxSeconds: number): VoiceSegment[] {
  const usable = samples.length > maxSeconds * TARGET_RATE
    ? samples.subarray(0, Math.floor(maxSeconds * TARGET_RATE))
    : samples
  return splitSamples(trimSilence(condition(usable))).map((piece) => ({
    audio: toBase64(encodeWave(piece.samples)),
    gapMs: piece.gapMs,
  }))
}

/**
 * 把用户选中的音频文件（系统录音机 / 相册里的录音）转成同格式的分段 base64 WAV。
 * http 局域网下浏览器不给实时麦克风，用「系统录音 → 选文件」这条路兜底：
 * 文件选择框不受安全上下文限制，所以这条路在 http 上也能用。
 */
export async function audioFileToBase64(file: File, maxSeconds: number): Promise<VoiceSegment[]> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer())
    const seconds = Math.min(decoded.duration, Math.max(1, maxSeconds))
    const frames = Math.max(1, Math.floor(seconds * TARGET_RATE))
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return samplesToSegments(rendered.getChannelData(0), maxSeconds)
  } finally {
    try {
      if (context.state !== 'closed') await context.close()
    } catch { /* 关不掉不影响结果 */ }
  }
}

/** 单声道 float 采样 → PCM16 WAV（Host 接受的规范格式）。 */
function encodeWave(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, TARGET_RATE, true)
  view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

/** 二进制 → base64（不带 dataURL 前缀）。分块避免超长参数栈溢出。 */
function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)))
  }
  return btoa(text)
}

/**
 * 一次麦克风采集。
 * 生命周期：start() → level() 轮询 → stop() 或 cancel()。
 * 全部资源在 stop/cancel 后释放；调用方必须在组件卸载时 cancel()。
 */
export class MicCapture {
  private stream?: MediaStream
  private recorder?: MediaRecorder
  private context?: AudioContext
  private analyser?: AnalyserNode
  private buffer = new Float32Array(256)
  private chunks: Blob[] = []
  private starting = false
  private disposed = false

  /** 打开麦克风并开始录制。必须在用户手势（点击）里同步调用。 */
  async start(): Promise<void> {
    const blocked = voiceBlocked()
    if (blocked !== null) throw new VoiceError('unsupported')
    if (this.starting || this.recorder !== undefined) throw new VoiceError('interrupted')
    this.starting = true

    // AudioContext 先建：iOS 要求在用户手势的同一个调用栈里创建，
    // 等 await getUserMedia 之后再建会被自动播放策略静音（录出空音）。
    let context: AudioContext
    try {
      context = new AudioContext()
    } catch {
      this.starting = false
      throw new VoiceError('unsupported')
    }
    this.context = context

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // 手机上的「噪声抑制」常把字尾吃掉（尤其爆破音），识别反而更差；
        // 自动增益保留——离得远时能把音量拉起来。回声消除只影响外放场景，留着。
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
        video: false,
      })
    } catch (error) {
      this.starting = false
      await this.release()
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        throw new VoiceError('permission')
      }
      throw error
    }

    // 授权过程中用户可能已经取消（组件卸载/点了取消）。
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop())
      this.starting = false
      throw new VoiceError('interrupted')
    }

    this.stream = stream
    try {
      this.analyser = context.createAnalyser()
      this.analyser.fftSize = this.buffer.length
      context.createMediaStreamSource(stream).connect(this.analyser)
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (event: BlobEvent) => {
        if (!this.disposed && event.data.size > 0) this.chunks.push(event.data)
      }
      this.recorder = recorder
      recorder.start()
    } catch (error) {
      this.starting = false
      await this.release()
      throw error instanceof VoiceError ? error : new VoiceError('unsupported')
    }
    this.starting = false
  }

  /** 当前音量（RMS，0~1），用于录音时的电平条。 */
  level(): number {
    const analyser = this.analyser
    if (analyser === undefined) return 0
    analyser.getFloatTimeDomainData(this.buffer)
    let sum = 0
    for (const sample of this.buffer) sum += sample * sample
    return Math.min(1, Math.sqrt(sum / this.buffer.length) * 6)
  }

  /**
   * 结束录音并返回分段 base64 WAV（长录音按静音点切开，每段单独转写）。
   * @param maxSeconds Host 允许的最长时长，超出部分截断。
   */
  async stop(maxSeconds: number): Promise<VoiceSegment[]> {
    const recorder = this.recorder
    const context = this.context
    if (recorder === undefined || context === undefined || recorder.state !== 'recording') {
      await this.release()
      throw new VoiceError('empty')
    }
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }))
        recorder.onerror = () => reject(new VoiceError('interrupted'))
        recorder.stop()
      })
      this.stream?.getTracks().forEach((track) => track.stop())
      if (blob.size === 0) throw new VoiceError('empty')

      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      const seconds = Math.min(decoded.duration, Math.max(1, maxSeconds))
      const frames = Math.max(1, Math.floor(seconds * TARGET_RATE))
      // 用离线上下文重采样到 16k 单声道：MediaRecorder 在 Android 出 webm/opus、
      // 在 iOS 出 mp4/aac，编解码差异全靠这一步抹平。
      const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      return samplesToSegments(rendered.getChannelData(0), maxSeconds)
    } finally {
      await this.release()
    }
  }

  /** 放弃本次录音。 */
  cancel(): void {
    void this.release()
  }

  private async release(): Promise<void> {
    this.disposed = true
    try {
      if (this.recorder !== undefined && this.recorder.state === 'recording') this.recorder.stop()
    } catch { /* 已经停了 */ }
    this.recorder = undefined
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    this.analyser = undefined
    this.chunks = []
    const context = this.context
    this.context = undefined
    if (context !== undefined) {
      try {
        if (context.state !== 'closed') await context.close()
      } catch { /* 关不掉也不影响下次录音 */ }
    }
  }
}
