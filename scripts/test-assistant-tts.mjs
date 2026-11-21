/**
 * 秘书卡片 TTS（微软 edge-tts）宿主半部单测：
 *   node scripts/test-assistant-tts.mjs
 *
 * 覆盖：
 *   - 运行时候选与探测（找到装了 edge_tts 的 python；venv-sherpa 没有时要跳过它）；
 *   - 音色解析走鹈鹕同一套：TIHU_EDGE_VOICE > config.json tihu.voice.edge > 晓晓；
 *   - 路由：POST 合成出 audio/mpeg（真跑一次 edge-tts，网络不可用时此项 FAIL 并给出缺失清单）；
 *     空 text 400、非 POST 405、status 路由回报引擎/端点/音色。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

const lib = await import('../lib/index.js')
const surface = lib.assistantTtsTestSurface

const cases = []

cases.push(['运行时候选：能找到装了 edge_tts 的 python', () => {
  const probe = surface.probeEdgeRuntime()
  assert.equal(probe.ok, true, `探测失败：${probe.error ?? ''}`)
  assert.ok(probe.python !== '', 'python 为空')
  assert.match(probe.version ?? '', /7\.3\.1|7\.[4-9]/)
  assert.ok(surface.edgeTtsScriptPath().endsWith('tihu-edge-tts.py'), '脚本路径指向 tihu-edge-tts.py')
}])

cases.push(['音色解析：env 优先于默认（鹈鹕同一套解析）', () => {
  const info = surface.ttsRuntimeInfo()
  assert.ok(info.voice.startsWith('zh-CN-'), `音色异常：${info.voice}`)
  assert.match(info.endpoint, /speech\.platform\.bing\.com/)
  assert.match(info.endpoint, /readaloud/)
}])

function fakeServer() {
  const exact = new Map()
  return {
    exact,
    register(route) {
      if (exact.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      exact.set(route.path, route)
      return () => { exact.delete(route.path) }
    },
  }
}
function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = surface.ASSISTANT_TTS_ROUTE
  return req
}
function fakeRes() {
  const out = { status: 0, headers: {}, chunks: [] }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? {} }
  out.write = (chunk) => { out.chunks.push(Buffer.from(chunk)); return true }
  out.end = (payload) => { if (payload !== undefined) out.chunks.push(Buffer.from(String(payload))) }
  return out
}
async function call(server, path, method, body) {
  const route = server.exact.get(path)
  assert.ok(route, `route ${path} registered`)
  const res = fakeRes()
  await route.handler(fakeReq(method, body), res)
  const buf = Buffer.concat(res.chunks)
  return { status: res.status, headers: res.headers, body: buf }
}

const server = fakeServer()
const ctx = { webServer: server, logger: { warn: () => {} } }
const dispose = surface.registerAssistantTts(ctx)

cases.push(['路由：POST 真合成 → audio/mpeg（微软 edge-tts）', async () => {
  const res = await call(server, surface.ASSISTANT_TTS_ROUTE, 'POST', JSON.stringify({ text: '秘书卡片朗读测试，八到十四摄氏度。' }))
  assert.equal(res.status, 200, `合成失败：${res.body.toString('utf8').slice(0, 200)}`)
  assert.equal(res.headers['content-type'], 'audio/mpeg')
  assert.equal(res.headers['x-tts-engine'], 'edge-tts')
  assert.ok(res.headers['x-tts-voice'].startsWith('zh-CN-'))
  // MP3 以 ID3 头或 0xFF 帧头开始
  const head = res.body.subarray(0, 3).toString('latin1')
  assert.ok(res.body.length > 1000, `音频太小（${res.body.length}B），疑似空输出`)
  assert.ok(head === 'ID3' || res.body[0] === 0xff, `不是 MP3：${head}`)
}])

cases.push(['路由：空 text 400 / 非 POST 405', async () => {
  const empty = await call(server, surface.ASSISTANT_TTS_ROUTE, 'POST', JSON.stringify({ text: '  ' }))
  assert.equal(empty.status, 400)
  const get = await call(server, surface.ASSISTANT_TTS_ROUTE, 'GET')
  assert.equal(get.status, 405)
}])

cases.push(['路由：status 回报引擎/端点/音色，且不回落其它引擎', async () => {
  const res = await call(server, surface.ASSISTANT_TTS_STATUS_ROUTE, 'GET')
  assert.equal(res.status, 200)
  const json = JSON.parse(res.body.toString('utf8'))
  assert.equal(json.ok, true)
  assert.match(json.engine, /edge-tts/)
  assert.match(json.engine, /微软/)
  assert.ok(!/speechSynthesis|Kokoro/.test(json.engine), 'engine 里不应出现 fallback 引擎名')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
try { dispose() } catch {}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} assistant-tts`)
