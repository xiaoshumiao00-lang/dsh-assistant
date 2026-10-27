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
const proxy = await createPocketProxy({
  port: 0, host: '127.0.0.1',
  upstream: { host: '127.0.0.1', port: upstream.address().port },
  heartbeat: false,
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
  console.log('mobile-proxy: identity HTML + grouped gzip JS batch OK')
} finally {
  await proxy.close()
  await new Promise((resolve) => upstream.close(resolve))
}
