/**
 * 鹈鹕（tihu）设备协议 v0 —— 手机/浏览器模拟设备 ⇄ 宿主 lane 的唯一线格式。
 *
 * 设计约束（P0）：
 *   - 所有消息统一信封 `{ v, type, id, seq, ts, payload }`；`v` 恒为 "0"。
 *   - **字段只增不删**：解析器只校验必需字段，多出来的字段原样保留（新固件可以
 *     带旧宿主不认识的字段，旧宿主不认识就忽略，不能因此判整条消息非法）。
 *   - **未知 type 必须忽略**：`parseUpstream()` 对不认识的 type、坏 JSON、超长的
 *     文本一律返回 `null`，绝不抛错——设备端以后加消息类型时，老宿主不能崩。
 *   - 上行只有五种：hello / audio.frame / text.input / confirm.reply / ping。
 *   - 下行八种：transcript / tts.text / screen.frame / event.progress /
 *     event.alert / event.done / confirm.ask（以及宿主回给设备的 ping 回执）。
 *
 * 为什么单独一层：P1 要换成真板子（ESP32-S3-BOX-3）固件，协议必须能脱离
 * WebSocket 实现被单测覆盖——`scripts/test-tihu-protocol.mjs` 直接 import 本文件。
 */

/** 协议版本。设备与宿主不一致时由 hello 的 `protocol` 字段拒绝（见 lane）。 */
export const TIHU_PROTOCOL_VERSION = '0' as const

/** 上行消息类型（设备 → 宿主）。 */
export const TIHU_UPSTREAM_TYPES = ['hello', 'audio.frame', 'text.input', 'confirm.reply', 'ping'] as const
/** 下行消息类型（宿主 → 设备）。 */
export const TIHU_DOWNSTREAM_TYPES = [
  'transcript',
  'tts.text',
  'screen.frame',
  'event.progress',
  'event.alert',
  'event.done',
  'confirm.ask',
  'pong',
] as const

export type TihuUpstreamType = (typeof TIHU_UPSTREAM_TYPES)[number]
export type TihuDownstreamType = (typeof TIHU_DOWNSTREAM_TYPES)[number]

/** 统一信封。`id` 由发送方生成（设备端可用随机十六进制），`seq` 单调递增。 */
export interface TihuEnvelope<T extends string, P> {
  /** 协议版本，恒为 "0"。 */
  v: typeof TIHU_PROTOCOL_VERSION
  /** 消息类型。 */
  type: T
  /** 消息 id（回声用：confirm.reply 必须带上对面 confirm.ask 的 id）。 */
  id: string
  /** 发送方自增序号，便于发现丢帧；宿主不依赖它排序。 */
  seq: number
  /** 毫秒时间戳（设备本地时钟即可，宿主只用于日志）。 */
  ts: number
  /** 载荷。 */
  payload: P
}

/* ---------- 上行载荷（设备 → 宿主） ---------- */

/** 能力声明：设备自报支持哪些下行能力（宿主据此决定要不要发 TTS）。 */
export interface TihuCapabilities {
  /** 能本地朗读（浏览器 speechSynthesis / P1 的本地 VITS）。 */
  tts?: boolean
  /** 有屏幕，能渲染 screen.frame。 */
  screen?: boolean
  /** 有麦克风（浏览器 getUserMedia 可用）。 */
  microphone?: boolean
  /** 能播放音频文件（P1 的 Opus 下行）。 */
  speaker?: boolean
}

export interface HelloPayload {
  /** 设备唯一标识：P0 用浏览器 localStorage 生成的随机串，P1 用 MAC。 */
  clientId: string
  /** 设备端实现版本（模拟页 / 固件版本号，仅日志用）。 */
  clientVersion?: string
  /** 设备实现的协议版本，必须等于 TIHU_PROTOCOL_VERSION。 */
  protocol?: string
  /** 能力集合。 */
  capabilities?: TihuCapabilities
  /** 设备名（屏上显示用）。 */
  deviceName?: string
  /**
   * 目标会话 id。模拟页从同源 localStorage 的 `dsh.sessions.current` 读，
   * 也就是「手机上当前打开的那个会话」——不另建并行会话体系。
   */
  sessionId?: string
}

/** 一段 WAV 音频：16 kHz / 单声道 / 16 bit，base64（不含 data: 前缀）。 */
export interface AudioFramePayload {
  /** 编码格式；P0 只接受 wav（P1 加 opus）。 */
  format: 'wav'
  /** 采样率，必须 16000（官方 speech 服务按 16k 校验）。 */
  sampleRate: number
  /** 声道数，必须 1。 */
  channels: number
  /** 位深，必须 16。 */
  bits: number
  /** 裸 base64（标准字母表，无换行）。 */
  audioBase64: string
  /** 时长（毫秒），仅日志与上限判断。 */
  durationMs?: number
}

export interface TextInputPayload {
  /** 文本（文字兜底输入，或设备侧已转写的文本）。 */
  text: string
  /** 来源：语音转写 / 键盘输入 / 撤回重说。 */
  source?: 'voice' | 'keyboard' | 'retry'
}

export interface ConfirmReplyPayload {
  /** 对应 confirm.ask 的 id。 */
  confirmId: string
  /** 用户点了「确认」还是「取消」。 */
  approved: boolean
}

export interface PingPayload {
  /** 设备生成的随机数，宿主原样回在 pong 里。 */
  nonce?: string
}

/* ---------- 下行载荷（宿主 → 设备） ---------- */

export interface TranscriptPayload {
  /** 转写文本。 */
  text: string
  /** 是否最终结果（P0 只有最终结果；P1 接流式时先落中间态）。 */
  final: boolean
  /** 来源。 */
  source: 'voice' | 'keyboard'
  /** 是否允许设备「撤回重说」（转写错误时）。 */
  retryable?: boolean
}

export interface TtsTextPayload {
  /** 待朗读文本。 */
  text: string
  /** 分段序号（长回复按句切段，从 0 开始）。 */
  index?: number
  /** 总段数。 */
  total?: number
  /** 语言（P0 固定 zh-CN；浏览器 speechSynthesis 用）。 */
  lang?: string
}

/** 320×240 屏幕帧：阶段标签 / 标题 / 要点行 / 进度数字。 */
export interface ScreenFramePayload {
  /** 阶段标签，如「聆听」「思考」「动手」「完成」。 */
  stage: string
  /** 标题（一行，最多约 18 个汉字）。 */
  title: string
  /** 要点行（每条最多约 20 个汉字，P0 最多 4 条）。 */
  bullets: string[]
  /** 进度：已完成 / 总数；没有总量的阶段给 done。 */
  progress?: { done: number; total?: number }
  /** 视觉基调：idle | busy | ok | alert。 */
  tone?: 'idle' | 'busy' | 'ok' | 'alert'
}

export interface ProgressPayload {
  /** 阶段。 */
  stage: string
  /** 一行事件文本。 */
  text: string
  /** 可选进度数字。 */
  done?: number
  /** 可选总量。 */
  total?: number
}

export interface AlertPayload {
  /** 级别。 */
  level: 'info' | 'warn' | 'error'
  /** 一行告警文本。 */
  text: string
}

export interface DonePayload {
  /** 收尾文本（可空）。 */
  text?: string
  /** 是否正常完成。 */
  ok?: boolean
  /** 本次动作落在哪个会话（便于设备端核对）。 */
  sessionId?: string
}

export interface ConfirmAskPayload {
  /** 确认请求 id（设备回 confirm.reply 时必须带同一个）。 */
  confirmId: string
  /** 一行标题，如「删除文件」。 */
  title: string
  /** 详情（目标路径 / 命令原文）。 */
  detail: string
  /** 两个动作的文案（P0 固定「确认 / 取消」）。 */
  options: [string, string]
  /** 超时毫秒；超时按「取消」处理（安全侧默认）。 */
  timeoutMs: number
  /** 风险等级。 */
  risk?: 'high' | 'medium'
}

/* ---------- 消息联合类型 ---------- */

export type TihuUpstreamMessage =
  | TihuEnvelope<'hello', HelloPayload>
  | TihuEnvelope<'audio.frame', AudioFramePayload>
  | TihuEnvelope<'text.input', TextInputPayload>
  | TihuEnvelope<'confirm.reply', ConfirmReplyPayload>
  | TihuEnvelope<'ping', PingPayload>

export type TihuDownstreamMessage =
  | TihuEnvelope<'transcript', TranscriptPayload>
  | TihuEnvelope<'tts.text', TtsTextPayload>
  | TihuEnvelope<'screen.frame', ScreenFramePayload>
  | TihuEnvelope<'event.progress', ProgressPayload>
  | TihuEnvelope<'event.alert', AlertPayload>
  | TihuEnvelope<'event.done', DonePayload>
  | TihuEnvelope<'confirm.ask', ConfirmAskPayload>
  | TihuEnvelope<'pong', PingPayload>

/* ---------- 解析与构造 ---------- */

/** 单条消息上限：音频 base64 最大 4 MB（≈ 官方 speech 的 maxAudioBytes），文本 64 KB。 */
export const TIHU_MAX_MESSAGE_BYTES = 6 * 1024 * 1024
/** 文本输入上限（字符）。 */
export const TIHU_MAX_TEXT_CHARS = 4000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 信封骨架是否成立（不校验 payload）。坏数据一律 false，不抛错。 */
export function isTihuEnvelope(value: unknown): value is TihuEnvelope<string, unknown> {
  if (!isObject(value)) return false
  if (value.v !== TIHU_PROTOCOL_VERSION) return false
  if (typeof value.type !== 'string' || value.type === '') return false
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return false
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts)) return false
  return isObject(value.payload)
}

/** 从 base64 中取出 WAV 头四个字节，判断是不是 RIFF/WAVE。 */
export function looksLikeWavBase64(audioBase64: string): boolean {
  if (typeof audioBase64 !== 'string' || audioBase64.length < 12) return false
  // "UklGR" 是 "RIFF" 的 base64 前缀；"V0FWR" 是 "WAVE"（第 9 字节起）的 base64 片段。
  return audioBase64.startsWith('UklGR')
}

/**
 * 解析一条上行消息。
 *
 * 返回值：
 *   - 合法且认识的类型 → 信封对象（多出来的字段保留）；
 *   - 未知 type / 坏 JSON / 字段缺失 / 超限 → `null`（调用方必须当「忽略」处理）。
 *
 * 任何情况下都不抛错——设备端不能把宿主打崩。
 */
export function parseUpstream(raw: unknown): TihuUpstreamMessage | null {
  try {
    let value: unknown = raw
    if (typeof raw === 'string') {
      if (raw.length > TIHU_MAX_MESSAGE_BYTES) return null
      value = JSON.parse(raw)
    } else if (Buffer.isBuffer(raw)) {
      if (raw.length > TIHU_MAX_MESSAGE_BYTES) return null
      value = JSON.parse(raw.toString('utf8'))
    }
    if (!isTihuEnvelope(value)) return null
    const type = value.type
    if (!(TIHU_UPSTREAM_TYPES as readonly string[]).includes(type)) return null
    const payload = value.payload as Record<string, unknown>

    switch (type) {
      case 'hello': {
        if (typeof payload.clientId !== 'string' || payload.clientId === '') return null
        if (payload.clientId.length > 200) return null
        if (payload.sessionId !== undefined && (typeof payload.sessionId !== 'string' || payload.sessionId.length > 256)) return null
        if (payload.capabilities !== undefined && !isObject(payload.capabilities)) return null
        return value as TihuUpstreamMessage
      }
      case 'audio.frame': {
        if (typeof payload.audioBase64 !== 'string' || payload.audioBase64 === '') return null
        if (payload.audioBase64.length > TIHU_MAX_MESSAGE_BYTES) return null
        if (payload.format !== 'wav') return null
        if (payload.sampleRate !== 16000 || payload.channels !== 1 || payload.bits !== 16) return null
        return value as TihuUpstreamMessage
      }
      case 'text.input': {
        if (typeof payload.text !== 'string') return null
        if (payload.text.length > TIHU_MAX_TEXT_CHARS) return null
        return value as TihuUpstreamMessage
      }
      case 'confirm.reply': {
        if (typeof payload.confirmId !== 'string' || payload.confirmId === '') return null
        if (typeof payload.approved !== 'boolean') return null
        return value as TihuUpstreamMessage
      }
      case 'ping': return value as TihuUpstreamMessage
      default: return null
    }
  } catch {
    return null
  }
}

/** 递增序号生成器（每个连接一个）。 */
export function createSeq(): () => number {
  let seq = 0
  return () => { seq += 1; return seq }
}

/** 构造一条下行消息。`id` 不给就随机生成。 */
export function buildDownstream<T extends TihuDownstreamType, P>(
  type: T,
  payload: P,
  seq: number,
  id?: string,
): TihuEnvelope<T, P> {
  return {
    v: TIHU_PROTOCOL_VERSION,
    type,
    id: id ?? randomId('srv'),
    seq,
    ts: Date.now(),
    payload,
  }
}

/** 构造一条上行消息（模拟页与单测共用，保证两端线格式一致）。 */
export function buildUpstream<T extends TihuUpstreamType, P>(
  type: T,
  payload: P,
  seq: number,
  id?: string,
): TihuEnvelope<T, P> {
  return {
    v: TIHU_PROTOCOL_VERSION,
    type,
    id: id ?? randomId('dev'),
    seq,
    ts: Date.now(),
    payload,
  }
}

/** 短随机 id（不依赖 crypto.randomUUID：老 Safari/Android WebView 没有）。 */
export function randomId(prefix = 'tihu'): string {
  const rand = Math.random().toString(16).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

/**
 * 日志用摘要：**绝不把 audioBase64 打进日志**（一条 4 MB base64 会把日志撑爆，
 * 且音频属于用户隐私）。其它字段照常。
 */
export function summarizeForLog(message: { type?: unknown; id?: unknown; payload?: unknown }): string {
  const type = typeof message?.type === 'string' ? message.type : '?'
  const id = typeof message?.id === 'string' ? message.id.slice(0, 40) : '?'
  const payload = isObject(message?.payload) ? { ...message.payload } : {}
  if (typeof payload.audioBase64 === 'string') payload.audioBase64 = `<${payload.audioBase64.length} 字符>`
  let body = ''
  try { body = JSON.stringify(payload).slice(0, 300) } catch { body = '<unserializable>' }
  return `${type}#${id} ${body}`
}

/* ---------- 屏幕帧辅助 ---------- */

/** 把一段回复切成适合 320×240 屏显示的要点行（按标点断句，最多 max 条）。 */
export function toBullets(text: string, max = 4, perLine = 20): string[] {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return []
  const sentences = clean.split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const sentence of sentences) {
    if (out.length >= max) break
    out.push(sentence.length > perLine ? `${sentence.slice(0, perLine)}…` : sentence)
  }
  if (out.length === 0) out.push(clean.slice(0, perLine))
  return out
}

/** 把长回复按句切成若干段给 TTS（每段不超过 perSegment 字符，P0 最多 maxSegments 段）。 */
export function toTtsSegments(text: string, maxSegments = 4, perSegment = 80): string[] {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return []
  const parts: string[] = []
  let rest = clean
  while (rest !== '' && parts.length < maxSegments) {
    if (rest.length <= perSegment) { parts.push(rest); break }
    // 在 perSegment 附近找最近的句末标点，找不到就硬切。
    const window = rest.slice(0, perSegment + 20)
    const match = window.match(/[^。！？；!?;]*[。！？；!?;]/)
    const cut = match ? match[0].length : perSegment
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  return parts.filter(Boolean)
}
