/** 浏览器声明 gzip 时仍命中精简；合包端点返回真实 JS 而非旧 combo / HTML。 */
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createGzip, gunzipSync } from 'node:zlib'
import { createPocketProxy } from '../src/pocket-host/proxy.mjs'

const core = '@deepseek-ai/dsh-client-connection'
const account = '@deepseek-ai/dsh-client-ui-settings-account'
const desktop = '@deepseek-ai/dsh-client-product-analytics'
const entry = (id) => ({ id, url: `plugins/??${id}/client.js&rev=x`, rev: 'x' })
const graph = {
  rev: 'x', entries: [entry(core), entry(account), entry(desktop)],
  batches: [{ phase: 'application', entries: [core, account, desktop], url: `plugins/??${core}/client.js,${account}/client.js,${desktop}/client.js&rev=x` }],
}
const html = `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)}</script></head><body></body></html>`
let upstreamEncoding = ''
const upstream = createServer((req, res) => {
  if (req.url.startsWith('/plugins/??')) {
    const resource = req.url.slice('/plugins/??'.length).split('&')[0]
    const id = resource.replace(/\/client\.js$/, '')
    res.setHeader('content-type', 'application/javascript; charset=utf-8')
    res.end(`window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:()=>({})});\n//# sourceMappingURL=client.js.map\n`)
    return
  }
  upstreamEncoding = String(req.headers['accept-encoding'] ?? '')
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (/\bgzip\b/.test(upstreamEncoding)) {
    res.setHeader('content-encoding', 'gzip')
    createGzip().end(html).pipe(res)
  } else {
    res.end(html)
  }
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
let asrCalls = 0
let asrBytes = 0
const tihu = {
  page: () => '<html><body>tihu</body></html>',
  handleUpgrade: () => false,
  // 代理只负责在鉴权之后把 POST /tihu/asr 接走，body 原样交给运行时。
  handleHttp: (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      asrCalls += 1
      asrBytes = Buffer.concat(chunks).length
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ text: '把 README 读一下', source: 'local', ms: 7 }))
    })
    return true
  },
}
const proxy = await createPocketProxy({
  port: 0, host: '127.0.0.1',
  upstream: { host: '127.0.0.1', port: upstream.address().port },
  heartbeat: false,
  tihu,
})
async function download(path, encoding = 'gzip') {
  return new Promise((resolve, reject) => {
    const call = request({
      host: '127.0.0.1', port: proxy.port, path, method: 'GET',
      headers: { accept: 'text/html', 'accept-encoding': encoding, 'user-agent': 'Mozilla/5.0 (Linux; Android 16) Mobile' },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: res.headers, status: res.statusCode }))
    })
    call.on('error', reject)
    call.end()
  })
}
async function post(path, body, type = 'audio/wav') {
  return new Promise((resolve, reject) => {
    const call = request({
      host: '127.0.0.1', port: proxy.port, path, method: 'POST',
      headers: { 'content-type': type, 'content-length': body.length },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ body: Buffer.concat(chunks), status: res.statusCode, headers: res.headers }))
    })
    call.on('error', reject)
    call.end(body)
  })
}
try {
  const response = await download('/')
  const body = response.body.toString('utf8')
  assert.equal(upstreamEncoding, 'identity')
  assert.equal(body.includes(account), true, '系统设置入口必须保留')
  assert.equal(body.includes(desktop), false, 'gzip 浏览器也必须收到精简后的 boot graph')
  assert.equal(body.includes(core), true)
  const lean = JSON.parse(/<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/.exec(body)[1])
  const batches = lean.batches.filter((row) => row.phase === 'application')
  assert.ok(batches.length > 0)
  let js = ''
  for (const batch of batches) {
    assert.ok(batch.url.startsWith('dsh-pocket-mobile-batch/'))
    const packed = await download(`/${batch.url}`)
    assert.equal(packed.status, 200)
    assert.equal(packed.headers['content-encoding'], 'gzip')
    js += gunzipSync(packed.body).toString('utf8')
  }
  assert.equal(js.includes(core), true)
  assert.equal(js.includes(account), true, '合包必须保留系统设置模块')
  assert.equal(js.includes(desktop), false)
  assert.equal(js.includes('sourceMappingURL'), false, '合包不应保留单包 sourcemap 尾注')
  // 手机壳的语音接口：POST /tihu/asr 必须在鉴权之后被 tihu 接走，body 原样到达。
  const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00])
  const asr = await post('/tihu/asr', wav)
  assert.equal(asr.status, 200)
  assert.equal(JSON.parse(asr.body.toString('utf8')).text, '把 README 读一下')
  assert.equal(asrCalls, 1, 'POST /tihu/asr 要被 tihu.handleHttp 接走')
  assert.equal(asrBytes, wav.length, '原始 WAV 字节要原样到运行时')
  // GET /tihu/asr 不接走（其它方法行为保持原样：继续按老规则转发）
  await download('/tihu/asr')
  assert.equal(asrCalls, 1, '只有 POST 才接走')
  console.log('mobile-proxy: identity HTML + grouped gzip JS batch + /tihu/asr wiring OK')
} finally {
  await proxy.close()
  await new Promise((resolve) => upstream.close(resolve))
}
