/**
 * TTS 音频工具：PCM16 分块 + WAV 头解析（纯函数，可单测）。
 *
 * 为什么分块在宿主做：本地 TTS sidecar 以 24 kHz / pcm16 流式返回，HTTP 分块的
 * 边界随网络变化；页面要求 **100–200 ms 固定块**（这里 120 ms）才能无缝排队播放。
 * 分块必须按偶数字节切（16 bit 采样），否则页面解析会出现半个采样 → 爆音。
 */

/** 本地 TTS 固定输出采样率（Qwen3-TTS 12Hz codec）。 */
export const TTS_SAMPLE_RATE = 24000
/** 每块时长（毫秒），落在要求的 100–200ms 内。 */
export const TTS_CHUNK_MS = 120
/** 每块采样数。 */
export const TTS_CHUNK_SAMPLES = Math.round((TTS_SAMPLE_RATE * TTS_CHUNK_MS) / 1000)
/** 每块字节数（单声道 16bit = 2 字节/采样）。 */
export const TTS_CHUNK_BYTES = TTS_CHUNK_SAMPLES * 2

export interface PcmChunk {
  data: Buffer
  /** 是否是整段语音的最后一块。 */
  final: boolean
}

/**
 * 把任意边界的 pcm16 字节流重新切成固定 120ms 的块。
 *
 * 为了给最后一块打上 `final`，会**压住一块**：push() 只发到「倒数第二块」，
 * finish() 再把最后一块 + 尾巴一起发（尾巴也补成偶数字节）。
 */
export class Pcm16Chunker {
  private buffer: Buffer = Buffer.alloc(0)
  private pending: Buffer | null = null

  /** 喂入任意字节；返回可以立即下发的块（不含最后一块）。 */
  push(chunk: Buffer | Uint8Array): Buffer[] {
    if (chunk !== undefined && chunk !== null && chunk.length > 0) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    }
    const out: Buffer[] = []
    while (this.buffer.length >= TTS_CHUNK_BYTES) {
      const block = this.buffer.subarray(0, TTS_CHUNK_BYTES)
      this.buffer = this.buffer.subarray(TTS_CHUNK_BYTES)
      if (this.pending !== null) out.push(this.pending)
      this.pending = Buffer.from(block)
    }
    return out
  }

  /** 结束：补齐偶数长度并发出最后一块（final=true）。 */
  finish(): PcmChunk[] {
    const out: PcmChunk[] = []
    let rest = this.buffer
    if (rest.length % 2 !== 0) rest = rest.subarray(0, rest.length - 1)
    this.buffer = Buffer.alloc(0)
    if (this.pending !== null) {
      const last = this.pending
      this.pending = null
      if (rest.length === 0) {
        out.push({ data: last, final: true })
        return out
      }
      out.push({ data: last, final: false })
    }
    if (rest.length > 0) out.push({ data: Buffer.from(rest), final: true })
    else if (out.length > 0) out[out.length - 1].final = true
    return out
  }

  /** 尚未发出的字节数（测试/诊断）。 */
  pendingBytes(): number {
    return this.buffer.length + (this.pending === null ? 0 : this.pending.length)
  }
}

/** WAV 头解析结果。 */
export interface WavInfo {
  sampleRate: number
  channels: number
  bits: number
  dataOffset: number
  /** 音频数据字节数。 */
  dataBytes: number
  durationMs: number
}

/** 解析 44 字节标准 WAV 头（PCM）；坏文件返回 null。 */
export function parseWav(buffer: Buffer | Uint8Array): WavInfo | null {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let fmt: { sampleRate: number; channels: number; bits: number } | null = null
  let dataOffset = -1
  let dataBytes = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      const format = buf.readUInt16LE(body)
      if (format !== 1) return null // 只认 PCM
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataOffset = body
      dataBytes = Math.min(size, Math.max(0, buf.length - body))
      break
    }
    offset = body + size + (size % 2)
  }
  if (fmt === null || dataOffset < 0) return null
  const bytesPerSample = (fmt.bits / 8) * fmt.channels
  if (bytesPerSample <= 0) return null
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bits: fmt.bits,
    dataOffset,
    dataBytes,
    durationMs: Math.round((dataBytes / bytesPerSample / fmt.sampleRate) * 1000),
  }
}

/** 参考音频是否合格：单声道 16bit、16k/24k、3–10 秒。 */export function validateReferenceWav(buffer: Buffer | Uint8Array): { ok: true; info: WavInfo } | { ok: false; reason: string } {
  const info = parseWav(buffer)
  if (info === null) return { ok: false, reason: '不是合法的 PCM WAV 文件' }
  if (info.channels !== 1) return { ok: false, reason: '需要单声道（当前 ' + info.channels + ' 声道）' }
  if (info.bits !== 16) return { ok: false, reason: '需要 16bit（当前 ' + info.bits + 'bit）' }
  if (info.sampleRate !== 16000 && info.sampleRate !== 24000) {
    return { ok: false, reason: '需要 16k 或 24k 采样率（当前 ' + info.sampleRate + 'Hz）' }
  }
  if (info.durationMs < 3000 || info.durationMs > 10000) {
    return { ok: false, reason: '参考音频需 3–10 秒（当前 ' + (info.durationMs / 1000).toFixed(1) + ' 秒）' }
  }
  return { ok: true, info }
}

/**
 * pcm16 单声道线性插值重采样（SAPI 兜底用；Qwen sidecar 直接输出 24k）。
 * 末尾不完整采样会被丢弃。
 */
export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return Buffer.from(input.subarray(0, input.length - (input.length % 2)))
  const inLength = Math.floor(input.length / 2)
  if (inLength === 0) return Buffer.alloc(0)
  const sampleAt = (index: number): number => input.readInt16LE(index * 2)
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(inLength / ratio))
  const out = Buffer.alloc(outLength * 2)
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio
    const lo = Math.floor(pos)
    const hi = Math.min(lo + 1, inLength - 1)
    const frac = pos - lo
    const value = sampleAt(lo) * (1 - frac) + sampleAt(hi) * frac
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2)
  }
  return out
}

