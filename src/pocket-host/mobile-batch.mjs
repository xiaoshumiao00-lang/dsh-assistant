// 手机精简后的本地合包：上游逐模块取回（loopback，快且不占公网），
// 在代理内合并成少量 JS，再一次 gzip / Brotli 下发。避免改写 Host combo URL 的 404。

import { request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { gzip, brotliCompress, constants as zlibConstants } from 'node:zlib'

const PREFIX = '/dsh-pocket-mobile-batch/'
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024

function gzipAsync(body) {
  return new Promise((resolve, reject) => gzip(body, { level: 6 }, (err, out) => err ? reject(err) : resolve(out)))
}
function brotliAsync(body) {
  return new Promise((resolve, reject) => brotliCompress(body, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
  }, (err, out) => err ? reject(err) : resolve(out)))
}

export function createMobileBatchStore({ upstream, rewriteHeaders, log = null }) {
  /** @type {Map<string, {entries:any[], promise?:Promise<{identity:Buffer,gzip:Buffer,br:Buffer}>}>} */
  const definitions = new Map()

  const register = (entries) => {
    const signature = JSON.stringify(entries.map((row) => [row.id, row.url, row.rev]))
    const key = createHash('sha256').update(signature).digest('hex').slice(0, 24)
    if (!definitions.has(key)) {
      definitions.set(key, { entries: entries.map((row) => ({ id: row.id, url: row.url, rev: row.rev })) })
      // 只保留最近几代图，避免频繁构建时累积元数据。
      while (definitions.size > 8) definitions.delete(definitions.keys().next().value)
    }
    return `dsh-pocket-mobile-batch/${key}.js`
  }

  const fetchEntry = (req, entry) => new Promise((resolve, reject) => {
    // entry.url 来自 Host 注入的 boot graph，而不是客户端自定义 URL。
    if (!String(entry.url).startsWith('plugins/??')) {
      reject(new Error(`invalid module url for ${entry.id}`)); return
    }
    const headers = rewriteHeaders({ ...req.headers, accept: 'application/javascript', 'accept-encoding': 'identity' }, upstream)
    const call = httpRequest({ host: upstream.host, port: upstream.port, method: 'GET', path: `/${entry.url}`, headers, agent: false }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk)
        else call.destroy(new Error(`module too large: ${entry.id}`))
      })
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`${entry.id}: HTTP ${res.statusCode}`)); return }
        const text = Buffer.concat(chunks).toString('utf8').replace(SOURCE_MAP_TRAILER, '')
        resolve(Buffer.from(text, 'utf8'))
      })
      res.on('error', reject)
    })
    call.setTimeout(15_000, () => call.destroy(new Error(`module timeout: ${entry.id}`)))
    call.on('error', reject)
    call.end()
  })

  const build = (req, definition) => {
    if (!definition.promise) {
      definition.promise = (async () => {
        const parts = await Promise.all(definition.entries.map((entry) => fetchEntry(req, entry)))
        const identity = Buffer.concat(parts.map((part) => Buffer.concat([part, Buffer.from('\n')])))
        const [gz, br] = await Promise.all([gzipAsync(identity), brotliAsync(identity)])
        return { identity, gzip: gz, br }
      })().catch((err) => {
        definition.promise = null
        throw err
      })
    }
    return definition.promise
  }

  const handle = (req, res) => {
    let pathname = ''
    try { pathname = new URL(req.url ?? '/', 'http://pocket.invalid').pathname } catch { return false }
    if (!pathname.startsWith(PREFIX)) return false
    const key = pathname.slice(PREFIX.length).replace(/\.js$/, '')
    const definition = definitions.get(key)
    if (!definition) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('mobile batch not found')
      return true
    }
    void build(req, definition).then((bodies) => {
      const acceptEncoding = String(req.headers['accept-encoding'] ?? '')
      const encoding = /\bbr\b/.test(acceptEncoding) ? 'br' : /\bgzip\b/.test(acceptEncoding) ? 'gzip' : 'identity'
      const body = bodies[encoding]
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-length': String(body.length),
        'content-encoding': encoding,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-dsh-pocket-mobile-batch': String(definition.entries.length),
        ...(encoding === 'identity' ? {} : { vary: 'Accept-Encoding' }),
      })
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    }).catch((err) => {
      log?.(`dsh-pocket: mobile batch failed: ${err?.message ?? err}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`mobile batch failed: ${err?.message ?? err}`)
    })
    return true
  }

  return { register, handle }
}
