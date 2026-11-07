/**
 * 本地 TTS sidecar（Qwen3-TTS-12Hz-0.6B GGUF Q4，codec.cpp `tts-server`）。
 *
 * 设计：
 *   - **独立进程**：`tts-server.exe` 由本模块 spawn，只绑 127.0.0.1，DSH 主进程只做 HTTP 客户端；
 *   - 模型/二进制放 `~/.dsh/tihu/`，不进仓库；
 *   - 合成走 OpenAI 兼容 `POST /v1/audio/speech`（`response_format: "pcm"`），
 *     服务端按 `--stream-chunk-ms 120` 分块流式返回，这里再把字节流重新切成固定 120ms 块；
 *   - 音色：codec.cpp 的 custom voices（POST /v1/audio/voices，multipart）把 speaker
 *     embedding 存成 `.gguf`，服务重启时自动加载（第二次用同一音色不重算）。
 *     工作区 `.tihu/voices/<name>.wav|.json` 是用户可见的权威副本，json 里记 serverVoiceId。
 *
 * 失败策略：任何异常都以可读 Error 抛出，由 lane 发 `event.alert` 并让页面降级到
 * 系统语音；绝不静默。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Pcm16Chunker, TTS_CHUNK_MS, TTS_SAMPLE_RATE, parseWav, resamplePcm16, validateReferenceWav } from './audio.ts'
import { toTtsSegments } from './protocol.ts'
import type { VoiceInfo } from './protocol.ts'

const DEFAULT_PORT = 8731
const HEALTH_TIMEOUT_MS = 180_000
const FIRST_CHUNK_TIMEOUT_MS = 8_000

export interface TihuTtsPaths {
  root: string
  bin: string
  model: string
  codec: string
  serverVoices: string
}

export interface TihuTtsOptions {
  log: (line: string) => void
  /** 工作区（会话 cwd），音色元数据放 `<workspace>/.tihu/voices`。 */
  workspaceOf?: (sessionId: string) => string | undefined
  /** 线程数（默认 4，避开 strata/CPU 专家池）。 */
  threads?: number
  /** sidecar 端口（默认 8731，只绑 127.0.0.1）。 */
  port?: number
  /** 覆盖二进制/模型路径（测试/自定义安装）。 */
  paths?: Partial<TihuTtsPaths>
  /** 关闭 sidecar（测试用）。 */
  disabled?: boolean
}

export interface SynthResult {
  sampleRate: number
  /** 首块到达耗时（毫秒）。 */
  firstChunkMs: number
  /** 总音频时长（毫秒）。 */
  audioMs: number
  /** 合成总耗时（毫秒）。 */
  totalMs: number
  chunks: number
}

export interface VoiceRecord {
  name: string
  serverVoiceId?: string
  sampleRate?: number
  durationMs?: number
  createdAt: number
  note?: string
}

function tihuRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'tihu')
}

export function defaultTtsPaths(): TihuTtsPaths {
  const root = tihuRoot()
  return {
    root,
    bin: process.env.TIHU_TTS_SERVER ?? join(root, 'bin', 'tts-server.exe'),
    model: process.env.TIHU_TTS_MODEL ?? join(root, 'models', 'qwen3-tts-0.6b-q4_k_m.gguf'),
    codec: process.env.TIHU_TTS_CODEC ?? join(root, 'models', 'codec-q4_k_m.gguf'),
    serverVoices: process.env.TIHU_TTS_VOICES ?? join(root, 'voices-server'),
  }
}

/** 工作区音色目录。 */
export function voiceDirOf(workspace: string): string {
  return join(workspace, '.tihu', 'voices')
}

/** 音色名只允许安全字符（页面输入已校验，这里再兜一层）。 */
export function normalizeVoiceName(name: string): string | null {
  const value = String(name ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) return null
  if (value === 'default') return null
  return value
}

export class TihuTts {
  private options: TihuTtsOptions
  private paths: TihuTtsPaths
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private stderrTail = ''
  private port: number
  private modelLoaded = false
  private lastError = ''

  constructor(options: TihuTtsOptions) {
    this.options = options
    this.paths = { ...defaultTtsPaths(), ...(options.paths ?? {}) }
    this.port = options.port ?? DEFAULT_PORT
  }

  /** 当前后端：codec（Qwen3-TTS sidecar）/ sapi（Windows 系统语音占位）/ none。 */
  backend(): 'codec' | 'sapi' | 'none' {
    if (this.options.disabled) return 'none'
    if (existsSync(this.paths.bin) && existsSync(this.paths.model) && existsSync(this.paths.codec)) return 'codec'
    if (process.platform === 'win32') return 'sapi'
    return 'none'
  }

  /** 引擎是否可用。 */
  available(): boolean {
    return this.backend() !== 'none'
  }

  status(): { available: boolean; model?: string; error?: string } {
    const backend = this.backend()
    if (backend === 'codec') return { available: true, model: 'qwen3-tts-0.6b-q4_k_m' }
    if (backend === 'sapi') return { available: true, model: 'windows-sapi（Qwen3-TTS 未就绪）' }
    return {
      available: false,
      error: this.lastError || `本地 TTS 未安装：缺少 ${basename(this.paths.bin)} 或模型文件（${this.paths.root}）`,
    }
  }

  /** 确保 sidecar 已启动并加载完模型（SAPI 后端无需常驻进程）。 */
  async ensureServer(): Promise<void> {
    if (this.backend() !== 'codec') return
    if (this.child !== null && this.modelLoaded) return
    if (this.starting !== null) return this.starting
    this.starting = this.startServer().finally(() => { this.starting = null })
    return this.starting
  }

  private async startServer(): Promise<void> {
    await mkdir(this.paths.serverVoices, { recursive: true })
    const port = await this.pickPort()
    this.port = port
    const args = [
      '--model', this.paths.codec,
      '--backbone', this.paths.model,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--voice-dir', this.paths.serverVoices,
      '--allow-voice-create',
      '--n-threads', String(this.options.threads ?? 4),
      '--segment-bytes', '160',
      '--stream-chunk-ms', String(TTS_CHUNK_MS),
    ]
    this.log(`starting tts sidecar: ${this.paths.bin} (port ${port})`)
    const child = spawn(this.paths.bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-4000)
    })
    child.stdout?.on('data', () => { /* 访问日志忽略 */ })
    child.on('exit', (code, signal) => {
      const wasLoaded = this.modelLoaded
      this.child = null
      this.modelLoaded = false
      this.lastError = `本地 TTS 进程退出（code=${code ?? '?'} signal=${signal ?? '-'}）${this.stderrTail ? '：' + this.stderrTail.split('\n').filter(Boolean).slice(-2).join(' ') : ''}`
      if (wasLoaded) this.log(`tts sidecar exited: ${this.lastError}`)
    })

    const started = Date.now()
    for (;;) {
      if (Date.now() - started > HEALTH_TIMEOUT_MS) {
        throw new Error(`本地 TTS 启动超时（${Math.round(HEALTH_TIMEOUT_MS / 1000)}s）：${this.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ') || '无输出'}`)
      }
      if (this.child === null) throw new Error(this.lastError || '本地 TTS 进程启动失败')
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) })
        if (response.ok) break
      } catch { /* 继续等 */ }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    this.modelLoaded = true
    this.log(`tts sidecar ready in ${Date.now() - started} ms (port ${this.port})`)
  }

  private async pickPort(): Promise<number> {
    for (let offset = 0; offset < 8; offset += 1) {
      const port = (this.options.port ?? DEFAULT_PORT) + offset
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) })
        // 已有实例（例如热重载前遗留）：直接复用。
        if (response.ok) {
          this.modelLoaded = true
          return port
        }
      } catch { /* 端口空闲 */ }
      return port
    }
    return this.options.port ?? DEFAULT_PORT
  }

  /**
   * 合成一段文本并流式输出 PCM 块。
   * @returns 首块耗时 / 总时长 / 块数（用于报告与日志）。
   */
  async synthesize(
    text: string,
    options: {
      voice?: string
      sessionId?: string
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
    },
  ): Promise<SynthResult> {
    const backend = this.backend()
    if (backend === 'codec') return this.synthesizeCodec(text, options)
    if (backend === 'sapi') return this.synthesizeSapi(text, options)
    throw new Error(this.status().error ?? '本地 TTS 不可用')
  }

  /** Windows SAPI 占位后端：生成 24k PCM 后分块（不流式；Qwen sidecar 就绪前保证链路可用）。 */
  private async synthesizeSapi(
    text: string,
    options: {
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
    },
  ): Promise<SynthResult> {
    const started = Date.now()
    const file = join(tmpdir(), `tihu-sapi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.wav`)
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}');`,
      '$text = [Console]::In.ReadToEnd();',
      '$s.Speak($text);',
      '$s.Dispose();',
    ].join(' ')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`系统语音合成失败（exit ${code}）：${stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`))
      })
      child.stdin?.end(text, 'utf8')
    })
    try {
      const wav = await readFile(file)
      const info = parseWav(wav)
      if (info === null) throw new Error('系统语音返回的不是有效 WAV')
      const pcm = resamplePcm16(wav.subarray(info.dataOffset, info.dataOffset + info.dataBytes), info.sampleRate, TTS_SAMPLE_RATE)
      const chunker = new Pcm16Chunker()
      let chunks = 0
      let firstChunkAt = 0
      const emit = (data: Buffer, final: boolean) => {
        if (firstChunkAt === 0) firstChunkAt = Date.now()
        options.onChunk({ data, seq: chunks, total: 0, final })
        chunks += 1
      }
      for (const block of chunker.push(pcm)) emit(block, false)
      for (const block of chunker.finish()) emit(block.data, block.final)
      const totalMs = Date.now() - started
      const audioMs = Math.round((pcm.length / 2 / TTS_SAMPLE_RATE) * 1000)
      this.log(`tts(sapi) chars=${[...text].length} first=${firstChunkAt === 0 ? '?' : firstChunkAt - started}ms total=${totalMs}ms audio=${audioMs}ms chunks=${chunks}`)
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstChunkAt === 0 ? totalMs : firstChunkAt - started, audioMs, totalMs, chunks }
    } finally {
      import('node:fs/promises').then((fs) => fs.unlink(file).catch(() => {})).catch(() => {})
    }
  }

  private async synthesizeCodec(
    text: string,
    options: {
      voice?: string
      sessionId?: string
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
    },
  ): Promise<SynthResult> {
    await this.ensureServer()
    const body = {
      model: 'qwen3-tts',
      input: text,
      response_format: 'pcm',
      text: undefined,
      ...(options.voice !== undefined && options.voice !== '' && options.voice !== 'default'
        ? { voice: { id: await this.resolveServerVoice(options.voice, options.sessionId) } }
        : {}),
    }
    const started = Date.now()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const firstTimer = setTimeout(() => controller.abort(), FIRST_CHUNK_TIMEOUT_MS)
    let firstChunkAt = 0
    let bytes = 0
    let chunks = 0
    const chunker = new Pcm16Chunker()
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => '')
        throw new Error(`TTS 合成失败 HTTP ${response.status}：${detail.slice(0, 300) || response.statusText}`)
      }
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        if (firstChunkAt === 0) {
          firstChunkAt = Date.now()
          clearTimeout(firstTimer)
        }
        bytes += value.length
        const blocks = chunker.push(value)
        for (const block of blocks) {
          options.onChunk({ data: block, seq: chunks, total: 0, final: false })
          chunks += 1
        }
      }
      const tail = chunker.finish()
      for (const block of tail) {
        options.onChunk({ data: block.data, seq: chunks, total: chunks + 1, final: block.final })
        chunks += 1
      }
      const totalMs = Date.now() - started
      const audioMs = Math.round((bytes / 2 / TTS_SAMPLE_RATE) * 1000)
      if (audioMs < 50) throw new Error('TTS 没有返回有效音频（少于 50ms）')
      this.log(`tts ok chars=${[...text].length} voice=${options.voice ?? 'default'} first=${firstChunkAt === 0 ? '?' : firstChunkAt - started}ms total=${totalMs}ms audio=${audioMs}ms chunks=${chunks}`)
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstChunkAt === 0 ? totalMs : firstChunkAt - started, audioMs, totalMs, chunks }
    } catch (error) {
      const message = (error as Error)?.name === 'AbortError'
        ? `TTS 合成超时（首块 ${Math.round(FIRST_CHUNK_TIMEOUT_MS / 1000)}s 未返回）`
        : String((error as Error)?.message ?? error)
      this.lastError = message
      throw new Error(message)
    } finally {
      clearTimeout(firstTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 把文本切成 TTS 段（与 tts.text 同一套切分）。 */
  segments(text: string): string[] {
    return toTtsSegments(text)
  }

  /* ---------- 音色 ---------- */

  private workspaceDir(sessionId?: string): string {
    const workspace = (sessionId !== undefined ? this.options.workspaceOf?.(sessionId) : undefined) ?? process.cwd()
    return voiceDirOf(workspace)
  }

  /** 列出工作区音色（默认 + `.tihu/voices/*.json`）。 */
  async listVoices(sessionId?: string): Promise<VoiceInfo[]> {
    const voices: VoiceInfo[] = [{ name: 'default', kind: 'default' }]
    const dir = this.workspaceDir(sessionId)
    try {
      const files = await readdir(dir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const record = JSON.parse(await readFile(join(dir, file), 'utf8')) as VoiceRecord
          const name = normalizeVoiceName(record.name)
          if (name === null) continue
          voices.push({
            name,
            kind: 'cloned',
            durationMs: record.durationMs,
            sampleRate: record.sampleRate,
            createdAt: record.createdAt,
            note: record.note,
          })
        } catch { /* 坏 metadata 跳过 */ }
      }
    } catch { /* 目录不存在 */ }
    voices.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'default' ? -1 : 1))
    return voices
  }

  /** 读取工作区音色的 serverVoiceId（没有则视作未创建）。 */
  async readVoiceRecord(sessionId: string | undefined, name: string): Promise<VoiceRecord | null> {
    const normalized = normalizeVoiceName(name)
    if (normalized === null) return null
    const file = join(this.workspaceDir(sessionId), normalized + '.json')
    try {
      return JSON.parse(await readFile(file, 'utf8')) as VoiceRecord
    } catch {
      return null
    }
  }

  /**
   * 新建/复用克隆音色。
   * 同一 name 已有 serverVoiceId 且 embedding 文件还在 → 直接命中缓存，不再算 speaker。
   */
  async createVoice(
    payload: { name: string; wavBase64: string; note?: string },
    sessionId?: string,
  ): Promise<{ voice: VoiceInfo; cached: boolean }> {
    const name = normalizeVoiceName(payload.name)
    if (name === null) throw new Error('音色名只能包含英文/数字/下划线/短横线，1–32 字，且不能是 default')
    if (this.backend() !== 'codec') throw new Error('当前是 Windows SAPI 占位引擎，不支持音色克隆；装好 Qwen3-TTS sidecar 后可用')
    const dir = this.workspaceDir(sessionId)
    await mkdir(dir, { recursive: true })
    const wav = Buffer.from(payload.wavBase64, 'base64')
    const valid = validateReferenceWav(wav)
    if (!valid.ok) throw new Error('参考音频不合格：' + valid.reason)
    const existing = await this.readVoiceRecord(sessionId, name)
    if (existing?.serverVoiceId !== undefined && existsSync(join(this.paths.serverVoices, existing.serverVoiceId + '.gguf'))) {
      return {
        voice: { name, kind: 'cloned', durationMs: existing.durationMs, sampleRate: existing.sampleRate, createdAt: existing.createdAt, note: existing.note },
        cached: true,
      }
    }
    await this.ensureServer()
    // multipart 上传到 codec.cpp voice API（它会保存 <id>.gguf embedding）。
    const form = new FormData()
    form.append('name', name)
    form.append('audio_sample', new Blob([wav], { type: 'audio/wav' }), name + '.wav')
    const response = await fetch(`http://127.0.0.1:${this.port}/v1/audio/voices`, { method: 'POST', body: form })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`创建音色失败 HTTP ${response.status}：${detail.slice(0, 300) || response.statusText}`)
    }
    const created = await response.json() as { id?: string }
    const serverVoiceId = typeof created.id === 'string' && created.id !== '' ? created.id : ''
    if (serverVoiceId === '') throw new Error('创建音色失败：sidecar 没有返回 voice id')
    await writeFile(join(dir, name + '.wav'), wav)
    const record: VoiceRecord = {
      name,
      serverVoiceId,
      sampleRate: valid.info.sampleRate,
      durationMs: valid.info.durationMs,
      createdAt: Date.now(),
      ...(payload.note !== undefined && payload.note !== '' ? { note: payload.note.slice(0, 120) } : {}),
    }
    await writeFile(join(dir, name + '.json'), JSON.stringify(record, null, 2), 'utf8')
    this.log(`tts voice created name=${name} serverVoiceId=${serverVoiceId} duration=${valid.info.durationMs}ms`)
    return {
      voice: { name, kind: 'cloned', durationMs: record.durationMs, sampleRate: record.sampleRate, createdAt: record.createdAt, note: record.note },
      cached: false,
    }
  }

  private async resolveServerVoice(name: string, sessionId?: string): Promise<string> {
    const record = await this.readVoiceRecord(sessionId, name)
    if (record === null || record.serverVoiceId === undefined || record.serverVoiceId === '') {
      throw new Error(`音色 ${name} 没有可用的 embedding，请重新上传参考音频`)
    }
    if (!existsSync(join(this.paths.serverVoices, record.serverVoiceId + '.gguf'))) {
      throw new Error(`音色 ${name} 的 embedding 已丢失，请重新上传参考音频`)
    }
    return record.serverVoiceId
  }

  /** 关掉 sidecar（插件卸载/热重载）。 */
  dispose(): void {
    const child = this.child
    this.child = null
    this.modelLoaded = false
    if (child !== null) {
      try { child.kill() } catch { /* 忽略 */ }
    }
  }

  private log(line: string): void {
    try { this.options.log(line) } catch { /* 忽略 */ }
  }
}
