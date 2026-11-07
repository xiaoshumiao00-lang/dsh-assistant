/**
 * 本地 TTS sidecar。
 *
 * 当前主引擎：Qwen3-TTS-12Hz-0.6B-Base 的 PyTorch CPU 实现（`scripts/tihu-qwen-tts-server.py`，
 * 官方 `qwen-tts` 包，fp32 + sdpa + 8 线程），仅绑 127.0.0.1，由本模块 spawn。
 * 旧 GGUF/codec.cpp 路径保留在 backend() 里作为备用；两者都不可用时回退 Windows SAPI。
 *
 * 设计：
 *   - **独立进程**：DSH 主进程只做 HTTP 客户端；
 *   - 模型/二进制放 `~/.dsh/tihu/`，不进仓库；
 *   - 合成走 OpenAI 兼容 `POST /v1/audio/speech`（`response_format: "pcm"`），
 *     服务端按 120ms 分块返回，这里再把字节流重新切成固定 120ms 块；
 *   - 音色：`POST /v1/audio/voices`（multipart）把 speaker embedding 存成
 *     `.embed.pt`（PyTorch）/ `.gguf`（codec），服务重启时自动加载（第二次用同一音色不重算）。
 *     工作区 `.tihu/voices/<name>.wav|.json` 是用户可见的权威副本，json 里记 serverVoiceId。
 *
 * 失败策略：任何异常都以可读 Error 抛出，由 lane 发 `event.alert` 并让页面降级到
 * 系统语音；绝不静默。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Pcm16Chunker, TTS_CHUNK_MS, TTS_SAMPLE_RATE, parseWav, resamplePcm16, validateReferenceWav } from './audio.ts'
import { toTtsSegments } from './protocol.ts'
import type { VoiceInfo } from './protocol.ts'

const DEFAULT_PORT = 8731
const HEALTH_TIMEOUT_MS = 180_000

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

export function binaryKind(path: string): 'windows' | 'linux' | 'unknown' {
  try {
    const fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    readSync(fd, head, 0, 4, 0)
    closeSync(fd)
    if (head.toString('ascii', 0, 2) === 'MZ') return 'windows'
    if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'linux'
  } catch { /* 读不到按平台猜 */ }
  return process.platform === 'win32' ? 'windows' : 'linux'
}

/** Windows 路径 → WSL 路径（C:\a\b → /mnt/c/a/b）。 */
export function toWslPath(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (match === null) return path.replace(/\\/g, '/')
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
}

function wslDistro(): string {
  return process.env.TIHU_TTS_WSL_DISTRO ?? 'Ubuntu'
}

/** 确保 WSL 发行版已启动（Stopped 时自动拉起）。 */
function ensureWslRunning(): void {
  const result = spawnSync('wsl.exe', ['-d', wslDistro(), '--', 'true'], { timeout: 30_000, windowsHide: true })
  if (result.status !== 0) {
    const detail = `${result.stderr?.toString('utf8') ?? ''}${result.stdout?.toString('utf8') ?? ''}`.trim()
    throw new Error(`WSL(${wslDistro()}) 启动失败：${detail || result.error?.message || '未知错误'}`)
  }
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
  /** PyTorch sidecar 实际设备（cuda/cpu），启动后由 /health 回填。 */
  private activeDevice: 'cuda' | 'cpu' = (process.env.TIHU_TTS_DEVICE ?? 'cpu') === 'cuda' ? 'cuda' : 'cpu'
  /** 显存不足回落 CPU 的提示（页面事件区用）。 */
  private fallbackNote = ''
  /** GPU 启动/合成失败后永久切 SAPI（本次进程内不再重试 GPU）。 */
  private gpuFailed = false
  /** 实际出声引擎（用于事件标识）。 */
  private activeEngine: 'gpu' | 'edge' | 'sapi' = 'gpu'
  private lastLabel = ''

  constructor(options: TihuTtsOptions) {
    this.options = options
    this.paths = { ...defaultTtsPaths(), ...(options.paths ?? {}) }
    this.port = options.port ?? DEFAULT_PORT
  }

  /** 当前后端：qwen-cuda（默认 GPU）/ q4（弃用备用）/ cpu（调试）/ sapi（唯一兜底）/ none。 */
  /** 当前后端：qwen-cuda（默认）/ q4 / cpu（调试）/ sapi（唯一兜底）/ none。 */
  backend(): 'qwen-cuda' | 'q4' | 'cpu' | 'sapi' | 'none' {
    if (this.options.disabled) return 'none'
    const engine = process.env.TIHU_TTS_ENGINE ?? ''
    if (engine === 'q4' && existsSync(this.paths.bin) && existsSync(this.paths.model) && existsSync(this.paths.codec)) return 'q4'
    if (engine === 'cpu' && this.qwenReady()) return 'cpu'
    if (this.qwenReady() && !this.gpuFailed) return 'qwen-cuda'
    if (process.platform === 'win32') return 'sapi'
    return 'none'
  }

  private qwenPython(): string {
    return process.env.TIHU_QWEN_PYTHON ?? join(this.paths.root, 'venv', 'Scripts', 'python.exe')
  }

  private qwenServerScript(): string {
    return process.env.TIHU_QWEN_SERVER ?? join(this.paths.root, 'qwen-tts-server.py')
  }

  private qwenModelDir(): string {
    return process.env.TIHU_QWEN_MODEL ?? join(this.paths.root, 'models', 'qwen3-tts-0.6b-pt')
  }

  private qwenReady(): boolean {
    return process.platform === 'win32' &&
      existsSync(this.qwenPython()) &&
      existsSync(this.qwenServerScript()) &&
      existsSync(join(this.qwenModelDir(), 'model.safetensors'))
  }

  /** 引擎是否可用。 */
  available(): boolean {
    return this.backend() !== 'none'
  }

  status(): { available: boolean; model?: string; error?: string } {
    const backend = this.backend()
    if (backend === 'qwen-cuda') return { available: true, model: 'qwen3-tts 0.6b-cuda' }
    if (backend === 'cpu') return { available: true, model: 'qwen3-tts 0.6b-pt' }
    if (backend === 'q4') return { available: true, model: 'qwen3-tts 0.6b-q4' }
    if (backend === 'sapi') return { available: true, model: 'Windows SAPI' }
    return {
      available: false,
      error: this.lastError || `本地 TTS 未安装：缺少 ${basename(this.qwenServerScript())} 或模型文件（${this.paths.root}）`,
    }
  }

  /** 显存不足回落 CPU 的原因（无回落返回空串）。 */
  deviceFallback(): string {
    return this.fallbackNote
  }

  /** 确保 sidecar 已启动并加载完模型（SAPI 后端无需常驻进程）。 */
  async ensureServer(): Promise<void> {
    const backend = this.backend()
    if (backend === 'sapi' || backend === 'none') return
    if (this.child !== null && this.modelLoaded) return
    if (this.starting !== null) return this.starting
    this.starting = this.startServer().catch((error) => {
      if (backend === 'qwen-cuda') {
        const message = (error as Error)?.message ?? String(error)
        this.gpuFailed = true
        this.fallbackNote = `GPU 不可用，已切换 Windows SAPI：${message}`
        this.log(`tts gpu unavailable, fallback sapi: ${message}`)
        return
      }
      throw error
    }).finally(() => { this.starting = null })
    return this.starting
  }

  private async startServer(): Promise<void> {
    await mkdir(this.paths.serverVoices, { recursive: true })
    const port = await this.pickPort()
    this.port = port
    const backend = this.backend()
    let command = this.paths.bin
    let args = [
      '--model', this.paths.codec,
      '--backbone', this.paths.model,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--voice-dir', this.paths.serverVoices,
      '--allow-voice-create',
      '--n-threads', String(this.options.threads ?? 4),
      '--segment-bytes', '160',
      '--stream-chunk-ms', String(TTS_CHUNK_MS),
      '--max-frames', '400',
      '--temp', '0.9', '--top-k', '50', '--top-p', '1.0',
      '--repeat-penalty', '1.05', '--repeat-last-n', '4096',
      '--samplers', 'penalties;temperature;top_k;top_p',
    ]
    // Q4 的 Base 模型没有内置音色：用预生成的 speaker 文件作为默认音色（否则必须上传参考音频）。
    if (existsSync(join(this.paths.serverVoices, 'default.gguf'))) {
      args.push('--speaker-file', join(this.paths.serverVoices, 'default.gguf'))
    }
    if (backend === 'qwen-cuda' || backend === 'cpu') {
      command = this.qwenPython()
      args = [
        '-u', this.qwenServerScript(),
        '--model', this.qwenModelDir(),
        '--voices', this.paths.serverVoices,
        '--default-ref', join(this.paths.root, 'default-ref.wav'),
        '--host', '127.0.0.1',
        '--port', String(port),
        '--threads', String(this.options.threads ?? 8),
        '--device', backend === 'cpu' ? 'cpu' : 'cuda',
        '--dtype', process.env.TIHU_TTS_DTYPE ?? 'bf16',
      ]
    } else if (process.platform === 'win32' && binaryKind(this.paths.bin) === 'linux') {
      // WSL 里编出来的 Linux ELF：经 wsl.exe 启动，WSL2 的 localhost 转发让 Windows 侧访问 127.0.0.1。
      ensureWslRunning()
      command = 'wsl.exe'
      const libDir = toWslPath(dirname(this.paths.bin))
      args = ['-d', wslDistro(), '--', 'env', `LD_LIBRARY_PATH=${libDir}`, toWslPath(this.paths.bin), ...args.map((arg) => (/^[A-Za-z]:[\\/]/.test(arg) ? toWslPath(arg) : arg))]
    }
    this.log(`starting tts sidecar (${backend}): ${command} (port ${port})`)
    const logPath = join(this.paths.root, 'tts-server.log')
    try { mkdirSync(this.paths.root, { recursive: true }) } catch { /* 忽略 */ }
    const appendLog = (line: string): void => {
      try { appendFileSync(logPath, line) } catch { /* 忽略 */ }
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.stderrTail = ''
    appendLog(`\n[${new Date().toISOString()}] start ${backend} ${command} ${args.join(' ')}\n`)
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-4000)
      appendLog(text)
    })
    child.stdout?.on('data', (chunk: Buffer) => { appendLog(chunk.toString('utf8')) })
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
        if (response.ok) {
          const info = await response.json().catch(() => null) as { device?: string; free_mb?: number } | null
          if (info?.device === 'cuda' || info?.device === 'cpu') {
            const requestedCuda = (process.env.TIHU_TTS_DEVICE ?? 'cuda') !== 'cpu'
            this.activeDevice = info.device
            if (requestedCuda && info.device === 'cpu') {
              this.fallbackNote = `显存不足（可用 ${Math.round(info.free_mb ?? 0)}MB），已回落 CPU 引擎`
            }
          }
          break
        }
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

  /** edge-tts 兜底是否可用（脚本 + Python；ffmpeg 由系统 PATH 提供）。 */
  edgeReady(): boolean {
    return existsSync(this.qwenPython()) && existsSync(join(this.paths.root, 'tihu-edge-tts.py'))
  }

  /** 当前引擎的中文标识（页面事件区）。 */
  engineLabel(voice: string): string {
    if (this.activeEngine === 'edge') return '在线兜底：edge-tts 云健(Yunjian)'
    if (this.activeEngine === 'sapi') return '离线兜底：Windows SAPI Huihui'
    return `本地 TTS：qwen3-tts 0.6b-cuda / 音色 ${voice || 'default'}`
  }

  /** 引擎切换后取一次提示（空串表示没变化）。 */
  takeEngineNote(): string {
    const label = this.lastLabel
    this.lastLabel = ''
    return label
  }

  /**
   * edge-tts 在线兜底：Python 流式输出 MP3 → ffmpeg 解码 24k PCM。
   * 首块 1.5s 不到立即杀掉并由调用方切 SAPI。
   */
  private async synthesizeEdge(
    text: string,
    options: {
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
      edgeVoice?: string
    },
  ): Promise<SynthResult> {
    const started = Date.now()
    const voice = options.edgeVoice || process.env.TIHU_EDGE_VOICE || 'zh-CN-YunjianNeural'
    const py = spawn(this.qwenPython(), ['-u', join(this.paths.root, 'tihu-edge-tts.py'), '--text', text, '--voice', voice], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const ff = spawn(process.env.TIHU_FFMPEG ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    py.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    ff.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    py.stdout?.pipe(ff.stdin)
    const chunker = new Pcm16Chunker()
    let chunks = 0
    let bytes = 0
    let firstAt = 0
    const abort = (reason: string) => {
      try { py.kill() } catch { /* 忽略 */ }
      try { ff.kill() } catch { /* 忽略 */ }
      throw new Error(reason)
    }
    const signal = options?.signal
    const onAbort = () => abort('edge-tts aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    const firstTimer = setTimeout(() => {
      try { py.kill() } catch { /* 忽略 */ }
      try { ff.kill() } catch { /* 忽略 */ }
    }, 3500)
    try {
      await new Promise<void>((resolve, reject) => {
        const done = () => resolve()
        ff.stdout?.on('data', (chunk: Buffer) => {
          if (firstAt === 0) { firstAt = Date.now(); clearTimeout(firstTimer) }
          bytes += chunk.length
          for (const block of chunker.push(chunk)) {
            options.onChunk({ data: block, seq: chunks, total: 0, final: false })
            chunks += 1
          }
        })
        ff.on('error', (error) => reject(error))
        ff.on('close', done)
        py.on('close', (code) => {
          if (code !== 0 && firstAt === 0) reject(new Error(`edge-tts 失败（exit ${code}）：${stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`))
        })
      })
      const tail = chunker.finish()
      if (firstAt === 0 && tail.length === 0) throw new Error(`edge-tts 没有返回音频：${stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`)
      for (const block of tail) {
        options.onChunk({ data: block.data, seq: chunks, total: chunks + 1, final: block.final })
        chunks += 1
      }
      const totalMs = Date.now() - started
      const audioMs = Math.round((bytes / 2 / TTS_SAMPLE_RATE) * 1000)
      if (audioMs < 50) throw new Error('edge-tts 返回音频过短')
      this.log(`edge-tts ok chars=${[...text].length} voice=${voice} first=${firstAt === 0 ? '?' : firstAt - started}ms total=${totalMs}ms audio=${audioMs}ms`)
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstAt === 0 ? totalMs : firstAt - started, audioMs, totalMs, chunks }
    } catch (error) {
      clearTimeout(firstTimer)
      try { py.kill() } catch { /* 忽略 */ }
      try { ff.kill() } catch { /* 忽略 */ }
      throw error
    } finally {
      clearTimeout(firstTimer)
      signal?.removeEventListener('abort', onAbort)
    }
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
      edgeVoice?: string
      offlineOnly?: boolean
      onChunk: (chunk: { data: Buffer; seq: number; total: number; final: boolean }) => void
      signal?: AbortSignal
    },
  ): Promise<SynthResult> {
    const wantsClone = typeof options.voice === 'string' && options.voice !== '' && options.voice !== 'default'
    const offline = options.offlineOnly === true || process.env.TIHU_OFFLINE_ONLY === '1'
    let primaryError = ''
    let triedEdge = false

    // 默认在线云健（不是克隆音色、且未开仅离线）：首块最快、音质最好。
    if (!wantsClone && !offline && this.edgeReady()) {
      triedEdge = true
      try {
        const result = await this.synthesizeEdge(text, { ...options, edgeVoice: options.edgeVoice })
        this.setEngine('edge')
        return result
      } catch (error) {
        primaryError = (error as Error)?.message ?? String(error)
        this.log(`edge-tts failed: ${primaryError}`)
      }
    }

    // 本地 Qwen：克隆音色必走；在线失败/仅离线时也走；GPU 不可用则直接跳 SAPI。
    const backend = this.backend()
    if (backend !== 'sapi' && backend !== 'none') {
      try {
        const result = await this.synthesizeCodec(text, options)
        this.setEngine('gpu')
        return result
      } catch (error) {
        primaryError = (error as Error)?.message ?? String(error)
        this.gpuFailed = true
        this.fallbackNote = `GPU 不可用：${primaryError}`
        this.log(`tts qwen failed: ${primaryError}`)
      }
    }

    if (!triedEdge && !offline && !wantsClone && this.edgeReady()) {
      try {
        const result = await this.synthesizeEdge(text, { ...options, edgeVoice: options.edgeVoice })
        this.setEngine('edge')
        return result
      } catch (error) {
        primaryError = (error as Error)?.message ?? String(error)
        this.log(`edge-tts failed: ${primaryError}`)
      }
    }

    try {
      const result = await this.synthesizeSapi(text, options)
      this.setEngine('sapi')
      if (this.fallbackNote === '') this.fallbackNote = `本地引擎不可用，已用 Windows SAPI：${primaryError}`
      return result
    } catch (error) {
      throw new Error(`所有本地 TTS 均不可用：${(error as Error)?.message ?? String(error)}（${primaryError}）`)
    }
  }

  private setEngine(engine: 'gpu' | 'edge' | 'sapi'): void {
    this.activeEngine = engine
    this.lastLabel = this.engineLabel('')
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
    const firstChunkBudget = this.backend() === 'q4' ? 60_000 : 45_000
    const firstTimer = setTimeout(() => controller.abort(), firstChunkBudget)
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
        ? `TTS 合成超时（首块 ${Math.round(firstChunkBudget / 1000)}s 未返回）`
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
    if (this.backend() === 'sapi' || this.backend() === 'none') throw new Error('当前只有 Windows SAPI 兜底，不支持音色克隆；本地 Qwen 引擎不可用')
    const dir = this.workspaceDir(sessionId)
    await mkdir(dir, { recursive: true })
    const wav = Buffer.from(payload.wavBase64, 'base64')
    const valid = validateReferenceWav(wav)
    if (!valid.ok) throw new Error('参考音频不合格：' + valid.reason)
    const existing = await this.readVoiceRecord(sessionId, name)
    const embedExt = this.backend() === 'q4' ? '.gguf' : '.embed.pt'
    if (existing?.serverVoiceId !== undefined && existsSync(join(this.paths.serverVoices, existing.serverVoiceId + embedExt))) {
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
    if (!existsSync(join(this.paths.serverVoices, record.serverVoiceId + (this.backend() === 'q4' ? '.gguf' : '.embed.pt')))) {
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
