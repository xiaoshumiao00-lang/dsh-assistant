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

export function registerAssistantTts(ctx: any): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  const webServer = routes.webServer
  const disposers: Array<() => void> = []

  try {
    const off = webServer.register({
      kind: 'exact',
      path: ASSISTANT_TTS_STATUS_ROUTE,
      handler: (_req: any, res: any) => {
        const info = ttsRuntimeInfo()
        sendJson(res, info.python ? 200 : 503, {
          ok: Boolean(info.python),
          engine: 'edge-tts（微软，无订阅 key）',
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
        const probe = probeEdgeRuntime()
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
        try {
          const child = spawn(probe.python, ['-u', probe.script, '--text', text, '--voice', voice], {
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let errored = ''
          child.stderr?.on('data', (chunk: any) => { errored += String(chunk) })
          res.writeHead(200, {
            'content-type': 'audio/mpeg',
            'cache-control': 'no-store',
            'x-tts-engine': 'edge-tts',
            'x-tts-voice': voice,
          })
          let sent = 0
          child.stdout?.on('data', (chunk: any) => { sent += chunk.length; try { res.write(chunk) } catch {} })
          const done = await new Promise<number>((resolve) => {
            const timer = setTimeout(() => { try { child.kill() } catch {} }, SYNTH_TIMEOUT_MS)
            child.on('close', (code: number | null) => { clearTimeout(timer); resolve(code ?? 1) })
            child.on('error', () => { clearTimeout(timer); resolve(1) })
          })
          try { res.end() } catch { /* 客户端可能已断开 */ }
          if (sent === 0 || done !== 0) {
            try { console.warn('[dsh-assistant] edge-tts 合成失败 exit=', done, errored.slice(0, 300)) } catch {}
          }
        } catch (err) {
          try { res.destroy() } catch {}
          try { console.warn('[dsh-assistant] edge-tts spawn 失败：', String((err as Error)?.message ?? err)) } catch {}
        }
      },
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    ctx?.logger?.warn?.(`[dsh-assistant] TTS 路由注册失败：${String((err as Error)?.message ?? err)}`)
  }

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
  probeEdgeRuntime,
  ttsRuntimeInfo,
  registerAssistantTts,
}
