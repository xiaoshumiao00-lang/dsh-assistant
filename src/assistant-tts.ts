/**
 * 个人秘书卡片朗读（TTS）——宿主侧合成服务。
 *
 * 服务与凭据（2026-11-21，用户指定「只用微软」）：
 *   - 服务：微软 Edge TTS（公开读端点，**不需要任何订阅 key / 证书**）。
 *   - 端点：edge-tts 内部的 wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/…
 *     （由 python 包发起，不是本仓库直连）。
 *   - 运行时：`scripts/tihu-edge-tts.py`（MP3 写 stdout），与本机鹈鹕端同一套 python 环境：
 *       env TIHU_EDGE_PY / TIHU_EDGE_PYTHON > `~/.dsh/tihu/venv/Scripts/python.exe`
 *       > `~/.dsh/tihu/venv-sherpa/Scripts/python.exe` > 系统 `python` / `py`。
 *   - 音色：`TIHU_EDGE_VOICE` > `~/.dsh/assistant/config.json` 的 `tihu.voice.edge` > 晓晓
 *     （`tihu/edge-voice.ts` 统一解析，和鹈鹕端听到的是同一个声音）。
 *
 * 明确不做：不回落浏览器 speechSynthesis、不回落本地 Kokoro——用户要求只要微软，
 * 缺什么就报什么，绝不静默换引擎。
 *
 * 路由：
 *   POST /api/assistant/tts { text, voice? } → audio/mpeg（边合成边回传）
 *   GET  /api/assistant/tts/status → { ok, python, voice, endpoint, error? }（诊断/冒烟用）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { manageWebRoutes } from './web-routes'
import { tihuEdgeVoiceResolution } from './tihu/edge-voice'

export const ASSISTANT_TTS_ROUTE = '/api/assistant/tts'
export const ASSISTANT_TTS_STATUS_ROUTE = '/api/assistant/tts/status'

/** 固定的合成超时（edge 公开端点国内直连可用；走代理只在 TIHU_EDGE_PROXY 显式设置时）。 */
const SYNTH_TIMEOUT_MS = 30_000
const MAX_TEXT = 2000

/** python 运行时候选（与 tihu/tts.ts 的 edgePythonCandidates 同优先级）。 */
export function edgePythonCandidates(home = homedir()): string[] {
  const env = (globalThis as any).process?.env ?? {}
  const explicit = [env.TIHU_EDGE_PY, env.TIHU_EDGE_PYTHON].filter((v) => typeof v === 'string' && v !== '')
  const tihuRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'tihu') : join(home, '.dsh', 'tihu')
  const legacy = join(tihuRoot, 'venv', 'Scripts', 'python.exe')
  const sherpa = join(tihuRoot, 'venv-sherpa', 'Scripts', 'python.exe')
  const system = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  return [...explicit, legacy, sherpa, ...system]
}

/** edge-tts 脚本路径（与 lib/ 打包后定位一致：lib/../scripts/tihu-edge-tts.py）。 */
export function edgeTtsScriptPath(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    return join(here, '..', 'scripts', 'tihu-edge-tts.py')
  } catch {
    return join(process.cwd(), 'scripts', 'tihu-edge-tts.py')
  }
}

/** 常驻 worker 脚本路径（lib/../scripts/tihu-edge-tts-worker.py）。 */
export function edgeTtsWorkerScriptPath(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    return join(here, '..', 'scripts', 'tihu-edge-tts-worker.py')
  } catch {
    return join(process.cwd(), 'scripts', 'tihu-edge-tts-worker.py')
  }
}

export interface EdgeProbe {
  ok: boolean
  python: string
  script: string
  version?: string
  error?: string
}

/** 探测可用的 python+edge_tts（status 路由与单测共用）。 */
export function probeEdgeRuntime(): EdgeProbe {
  const script = edgeTtsScriptPath()
  for (const python of edgePythonCandidates()) {
    try {
      const check = spawnSync(python, ['-c', 'import edge_tts,sys;print(edge_tts.__version__)'], {
        timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      })
      if (check.status === 0) {
        const version = String(check.stdout ?? '').trim().split('\n').pop() ?? ''
        return { ok: existsSync(script), python, script, version }
      }
    } catch { /* 这个 python 不可用：试下一个 */ }
  }
  return { ok: false, python: '', script, error: '找不到装了 edge_tts 的 python（候选：' + edgePythonCandidates().join(', ') + '）' }
}

/**
 * 探测结果缓存（60s TTL）。**瓶颈实测**（2026-11-22）：probe 每次 spawn 一次
 * `python -c import edge_tts`，固定 ~500ms；分块流式朗读每块都过这条路由，不缓存
 * 会把这 500ms 乘到每一块上。探测只与 python 环境有关，与文本无关，缓存安全。
 */
let probeCache: { at: number; value: EdgeProbe } | null = null
export function probeEdgeRuntimeCached(ttlMs = 60_000, now: number = Date.now()): EdgeProbe {
  if (probeCache === null || now - probeCache.at > ttlMs) probeCache = { at: now, value: probeEdgeRuntime() }
  return probeCache.value
}
export function resetProbeCacheForTests(): void { probeCache = null }

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk: any) => { if (raw.length < 8 * 1024) raw += String(chunk) })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}

/** 已选中的合成参数（status 路由回报用）。 */
export function ttsRuntimeInfo(): { python: string; script: string; voice: string; source: string; endpoint: string } {
  const probe = probeEdgeRuntime()
  const voice = tihuEdgeVoiceResolution()
  return {
    python: probe.python,
    script: probe.script,
    voice: voice.voice,
    source: voice.source,
    endpoint: 'edge-tts → wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud',
  }
}

/* ─────────────────── 常驻 edge-tts worker 池（免每请求 1.4s 进程启动开销） ─────────────────── */

export interface WorkerChild {
  stdin: { write(chunk: string): unknown; end(): unknown } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown; on(event: string, cb: (...args: any[]) => void): unknown } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  on(event: 'error' | 'close' | 'exit', cb: (...args: any[]) => void): unknown
  kill(): unknown
}
export type WorkerSpawn = (command: string, args: string[], opts: any) => WorkerChild

interface WorkerRequest {
  id: number
  text: string
  voice: string
  rate: string
  timeout: number
  proxy: string | null
}
interface QueuedSynth {
  req: WorkerRequest
  resolve: (buf: Buffer) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * 一条常驻 worker 连接（一个 python 进程，顺序处理）。
 * 协议见 scripts/tihu-edge-tts-worker.py：请求 = stdin 一行 JSON；
 * 应答 = stdout 一行 JSON 头（ok 时带 bytes）+ 可选 bytes 长度帧 MP3 负载。
 */
export class EdgeTtsWorkerConn {
  private child: WorkerChild | null = null
  private buf: Buffer = Buffer.alloc(0)
  private expecting: { id: number; bytes: number } | null = null
  private queue: QueuedSynth[] = []
  private active: QueuedSynth | null = null
  private timedOut = new Set<number>()
  private nextId = 1
  private dead = false
  private stderrTail = ''
  private readonly onExitKill: () => void

  constructor(private readonly opts: { python: string; script: string; rate: string; proxy: string | null; spawnImpl: WorkerSpawn; logger?: { warn?: (msg: string) => void } }) {
    this.onExitKill = (): void => { try { this.dispose(new Error('host exit')) } catch { /* ignore */ } }
    try { process.once('exit', this.onExitKill) } catch { /* 非 node 环境忽略 */ }
  }

  isDead(): boolean { return this.dead }

  private ensureChild(): void {
    if (this.child !== null || this.dead) return
    const child = this.opts.spawnImpl(this.opts.python, ['-u', this.opts.script], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => { try { this.onData(chunk) } catch { /* 解析错交给协议错误 */ } })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-400)
    })
    const die = (reason: string): void => {
      if (this.dead) return
      this.dead = true
      this.failAll(new Error(reason))
    }
    child.on('error', (error: any) => { die(`edge-tts worker spawn 失败：${String(error?.message ?? error)}`) })
    child.on('close', (code: number | null) => { die(`edge-tts worker 退出（code=${code ?? '?'}）${this.stderrTail ? '：' + this.stderrTail.split('\n').filter(Boolean).slice(-2).join(' ') : ''}`) })
  }

  synth(text: string, voice: string, timeoutMs: number): Promise<Buffer> {
    if (this.dead) return Promise.reject(new Error('edge-tts worker 已退出'))
    this.ensureChild()
    const req: WorkerRequest = {
      id: this.nextId++,
      text,
      voice,
      rate: this.opts.rate,
      // python 侧 wait_for 兜底比宿主超时略短，宿主 timer 只是 backstop
      timeout: Math.max(1, Math.round((timeoutMs - 2000) / 1000)),
      proxy: this.opts.proxy,
    }
    return new Promise<Buffer>((resolve, reject) => {
      const item: QueuedSynth = { req, resolve, reject, timer: null }
      item.timer = setTimeout(() => {
        item.timer = null
        this.timedOut.add(req.id)
        if (this.active === item) { this.active = null }
        else this.queue = this.queue.filter((q) => q !== item)
        reject(new Error('edge-tts worker 响应超时'))
        this.pump()
      }, timeoutMs + 3000)
      this.queue.push(item)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active !== null || this.dead || this.child === null) return
    const item = this.queue.shift()
    if (item === undefined) return
    this.active = item
    try {
      this.child.stdin?.write(JSON.stringify(item.req) + '\n')
    } catch (error) {
      this.active = null
      this.finish(item, undefined, error instanceof Error ? error : new Error(String(error)))
      this.pump()
    }
  }

  private finish(item: QueuedSynth, buf: Buffer | undefined, error: Error | undefined): void {
    if (item.timer !== null) { clearTimeout(item.timer); item.timer = null }
    if (this.active === item) this.active = null
    if (error !== undefined) item.reject(error)
    else if (buf !== undefined) item.resolve(buf)
    else item.reject(new Error('edge-tts 空输出'))
    this.pump()
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    for (;;) {
      if (this.expecting === null) {
        const nl = this.buf.indexOf(0x0a)
        if (nl < 0) return
        const line = this.buf.subarray(0, nl).toString('utf8')
        this.buf = this.buf.subarray(nl + 1)
        let msg: any = null
        try { msg = JSON.parse(line) } catch { msg = null }
        if (msg === null || typeof msg !== 'object') {
          this.dispose(new Error('edge-tts worker 协议错误（非 JSON 帧）'))
          return
        }
        if (msg.ok === true) this.expecting = { id: Number(msg.id), bytes: Math.max(0, Number(msg.bytes) || 0) }
        else {
          const error = new Error(String(msg.error ?? 'edge-tts 合成失败'))
          const item = this.take(Number(msg.id))
          if (item !== null) this.finish(item, undefined, error)
          // 不属于任何在途请求的错误帧（如迟到/已超时）直接丢
        }
      } else {
        if (this.buf.length < this.expecting.bytes) return
        const payload = this.buf.subarray(0, this.expecting.bytes)
        this.buf = this.buf.subarray(this.expecting.bytes)
        const frame = this.expecting
        this.expecting = null
        if (this.timedOut.has(frame.id)) { this.timedOut.delete(frame.id); continue } // 迟到帧丢弃
        const item = this.take(frame.id)
        if (item !== null) this.finish(item, Buffer.from(payload), undefined)
      }
    }
  }

  private take(id: number): QueuedSynth | null {
    if (this.active !== null && this.active.req.id === id) return this.active
    const idx = this.queue.findIndex((q) => q.req.id === id)
    if (idx >= 0) return this.queue.splice(idx, 1)[0]
    return null
  }

  private failAll(error: Error): void {
    const items = [...this.queue]
    this.queue = []
    if (this.active !== null) { items.push(this.active); this.active = null }
    for (const item of items) {
      if (item.timer !== null) clearTimeout(item.timer)
      try { item.reject(error) } catch { /* ignore */ }
    }
  }

  dispose(reason?: Error): void {
    this.dead = true
    try { process.removeListener('exit', this.onExitKill) } catch { /* ignore */ }
    const child = this.child
    this.child = null
    if (child !== null) { try { child.kill() } catch { /* ignore */ } try { child.stdin?.end() } catch { /* ignore */ } }
    this.failAll(reason ?? new Error('edge-tts worker 已释放'))
  }
}

/** 常驻 worker 池：size 条连接轮转（懒创建）。**仍只走微软 edge-tts**。 */
export class EdgeTtsWorkerPool {
  private conns: EdgeTtsWorkerConn[] = []
  private rr = 0
  private readonly size: number

  constructor(private readonly opts: { python: string; rate: string; proxy: string | null; size?: number; spawnImpl?: WorkerSpawn; logger?: { warn?: (msg: string) => void } }) {
    this.size = Math.max(1, opts.size ?? 2)
  }

  synth(text: string, voice: string, timeoutMs: number): Promise<Buffer> {
    return this.pick().synth(text, voice, timeoutMs)
  }

  private pick(): EdgeTtsWorkerConn {
    this.conns = this.conns.filter((c) => !c.isDead())
    while (this.conns.length < this.size) {
      this.conns.push(new EdgeTtsWorkerConn({
        python: this.opts.python,
        script: edgeTtsWorkerScriptPath(),
        rate: this.opts.rate,
        proxy: this.opts.proxy,
        spawnImpl: this.opts.spawnImpl ?? ((cmd, args, o) => spawn(cmd, args, o) as unknown as WorkerChild),
        logger: this.opts.logger,
      }))
    }
    this.rr = (this.rr + 1) % this.conns.length
    return this.conns[this.rr]
  }

  dispose(): void {
    for (const conn of this.conns.splice(0)) { try { conn.dispose() } catch { /* ignore */ } }
  }
}

/** 一次性合成（worker 不可用时的同引擎重试路径；也是历史行为）。 */
function synthOneShot(probe: EdgeProbe, text: string, voice: string, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(probe.python, ['-u', probe.script, '--text', text, '--voice', voice], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errored = ''
    const chunks: Buffer[] = []
    child.stderr?.on('data', (chunk: any) => { errored += String(chunk) })
    child.stdout?.on('data', (chunk: any) => { chunks.push(Buffer.from(chunk)) })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('edge-tts 合成超时'))
    }, timeoutMs)
    child.on('error', (error: Error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      const buf = Buffer.concat(chunks)
      if (code === 0 && buf.length > 0) resolve(buf)
      else reject(new Error(`edge-tts 合成失败（exit=${code ?? '?'}）${errored ? '：' + errored.slice(0, 200) : ''}`))
    })
  })
}

export function registerAssistantTts(ctx: any): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  const webServer = routes.webServer
  const disposers: Array<() => void> = []

  // 常驻 worker 池：懒创建（首次合成请求时才 spawn python），随插件卸载销毁。
  let pool: EdgeTtsWorkerPool | null = null
  const poolFor = (python: string): EdgeTtsWorkerPool => {
    if (pool === null || (pool as any).__python !== python) {
      try { pool?.dispose() } catch { /* ignore */ }
      pool = new EdgeTtsWorkerPool({
        python,
        rate: process.env.TIHU_EDGE_RATE || '+45%',
        proxy: process.env.TIHU_EDGE_PROXY || null,
        size: 2,
        logger: ctx?.logger,
      })
      ;(pool as any).__python = python
    }
    return pool
  }

  try {
    const off = webServer.register({
      kind: 'exact',
      path: ASSISTANT_TTS_STATUS_ROUTE,
      handler: (_req: any, res: any) => {
        const info = ttsRuntimeInfo()
        sendJson(res, info.python ? 200 : 503, {
          ok: Boolean(info.python),
          engine: 'edge-tts（微软，无订阅 key）',
          worker: existsSync(edgeTtsWorkerScriptPath()),
          ...info,
        })
      },
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    ctx?.logger?.warn?.(`[dsh-assistant] TTS 状态路由注册失败：${String((err as Error)?.message ?? err)}`)
  }

  try {
    const off = webServer.register({
      kind: 'exact',
      path: ASSISTANT_TTS_ROUTE,
      handler: async (req: any, res: any) => {
        const method = String(req.method ?? 'GET').toUpperCase()
        if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
        const body = await readJsonBody(req)
        const text = String(body?.text ?? '').trim()
        if (text === '') { sendJson(res, 400, { ok: false, error: 'text 不能为空' }); return }
        if (text.length > MAX_TEXT) { sendJson(res, 400, { ok: false, error: `text 超过 ${MAX_TEXT} 字` }); return }
        const probe = probeEdgeRuntimeCached()
        if (!probe.ok || probe.python === '') {
          sendJson(res, 503, {
            ok: false,
            engine: 'edge-tts（微软）',
            missing: [probe.error ?? 'python 不可用', existsSync(probe.script) ? '' : 'scripts/tihu-edge-tts.py 不存在'].filter(Boolean),
            hint: 'pip install "edge-tts>=7.3.1" 到任一候选 python（优先 ~/.dsh/tihu/venv）',
          })
          return
        }
        const voice = String(body?.voice ?? '').trim() || tihuEdgeVoiceResolution().voice
        let mp3: Buffer | null = null
        let lastError: unknown = null
        // 1) 常驻 worker（毫秒级固定开销）；2) 同引擎一次性合成兜底（worker 崩了也不换引擎）
        try {
          mp3 = await poolFor(probe.python).synth(text, voice, SYNTH_TIMEOUT_MS)
        } catch (error) {
          lastError = error
          try { ctx?.logger?.warn?.(`[dsh-assistant] edge-tts worker 失败，回退一次性合成：${String((error as Error)?.message ?? error)}`) } catch { /* ignore */ }
        }
        if (mp3 === null) {
          try {
            mp3 = await synthOneShot(probe, text, voice, SYNTH_TIMEOUT_MS)
          } catch (error) {
            lastError = error
          }
        }
        if (mp3 === null || mp3.length === 0) {
          sendJson(res, 502, { ok: false, engine: 'edge-tts（微软）', error: String((lastError as Error)?.message ?? lastError ?? 'edge-tts 合成失败') })
          return
        }
        res.writeHead(200, {
          'content-type': 'audio/mpeg',
          'cache-control': 'no-store',
          'x-tts-engine': 'edge-tts',
          'x-tts-voice': voice,
        })
        try { res.write(mp3); res.end() } catch { /* 客户端可能已断开 */ }
      },
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    ctx?.logger?.warn?.(`[dsh-assistant] TTS 路由注册失败：${String((err as Error)?.message ?? err)}`)
  }

  disposers.push(() => { try { pool?.dispose() } catch { /* ignore */ } })

  return () => {
    for (const dispose of disposers.reverse()) { try { dispose() } catch {} }
    try { routes.dispose() } catch {}
  }
}

/** 单测入口。 */
export const assistantTtsTestSurface = {
  ASSISTANT_TTS_ROUTE,
  ASSISTANT_TTS_STATUS_ROUTE,
  edgePythonCandidates,
  edgeTtsScriptPath,
  edgeTtsWorkerScriptPath,
  probeEdgeRuntime,
  probeEdgeRuntimeCached,
  resetProbeCacheForTests,
  ttsRuntimeInfo,
  registerAssistantTts,
  EdgeTtsWorkerConn,
  EdgeTtsWorkerPool,
}
