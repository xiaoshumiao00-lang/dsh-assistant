/** 控制室默认背景按需加载回归：原始字节、客户端 Blob 与服务端响应必须一致。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { loadWaveBgBlob, WAVE_BG_URL } from '../src/client/waveBg.ts'
import { CONSOLE_SEA01_ROUTE, serveConsoleSea01 } from '../src/consoleAsset.ts'

const original = await readFile(new URL('../src/console-sea01.jpg', import.meta.url))
assert.equal(original.length, 184856)
assert.equal(createHash('sha256').update(original).digest('hex'), 'db53e22970bebb8cb7bc474f97336067c9b813b349d712f8f1ad2475aaab85de')
assert.equal(WAVE_BG_URL, CONSOLE_SEA01_ROUTE)

let requestedUrl = ''
let requestedCache = ''
const blob = await loadWaveBgBlob(async (url, options) => {
  requestedUrl = String(url)
  requestedCache = String(options?.cache ?? '')
  return new Response(original, { status: 200, headers: { 'content-type': 'image/jpeg' } })
})
assert.equal(requestedUrl, CONSOLE_SEA01_ROUTE)
assert.equal(requestedCache, 'force-cache')
assert.equal(blob.type, 'image/jpeg')
assert.deepEqual(Buffer.from(await blob.arrayBuffer()), original)
await assert.rejects(() => loadWaveBgBlob(async () => new Response(null, { status: 503 })), /HTTP 503/)

function response() {
  return {
    status: 0,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      this.headersSent = true
    },
    end(body) { this.body = body ?? null },
  }
}

const get = response()
await serveConsoleSea01({ method: 'GET' }, get)
assert.equal(get.status, 200)
assert.equal(get.headers['content-type'], 'image/jpeg')
assert.equal(get.headers['content-length'], String(original.length))
assert.deepEqual(get.body, original)

const head = response()
await serveConsoleSea01({ method: 'HEAD' }, head)
assert.equal(head.status, 200)
assert.equal(head.body, null)
const post = response()
await serveConsoleSea01({ method: 'POST' }, post)
assert.equal(post.status, 405)
assert.equal(post.headers.allow, 'GET, HEAD')

console.log('console-assets: exact JPEG bytes + lazy Blob + GET/HEAD/405 OK')
