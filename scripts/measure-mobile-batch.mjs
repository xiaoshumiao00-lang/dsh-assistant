/** 估算保留模块合并传输相比 49 路单包的 gzip / Brotli 收益。 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { optimizeMobileBoot } from '../src/pocket-host/mobile-boot.mjs'

const [htmlFile, base = 'http://127.0.0.1:64165/'] = process.argv.slice(2)
const optimized = optimizeMobileBoot(readFileSync(htmlFile, 'utf8'))
const script = /<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/.exec(optimized.html)[1]
const graph = JSON.parse(script)
const download = (url) => new Promise((resolve, reject) => {
  http.get(new URL(url, base), { headers: { 'accept-encoding': 'identity' } }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${res.statusCode} ${url}`)))
  }).on('error', reject)
})
const rows = []
for (const batch of graph.batches.filter((row) => row.phase === 'application')) {
  const bytes = await download(batch.url)
  rows.push({ id: batch.entries[0], bytes })
}
const stripMap = (buffer) => Buffer.from(buffer.toString('utf8').replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, ''), 'utf8')
const joined = Buffer.concat(rows.map((row) => stripMap(row.bytes)))
const gzip = gzipSync(joined, { level: 6 })
const brotli = brotliCompressSync(joined, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
console.log(JSON.stringify({ modules: graph.entries.length, rawBytes: joined.length, gzipBytes: gzip.length, brotliBytes: brotli.length, largest: rows.map((row) => ({ id: row.id, rawBytes: row.bytes.length })).sort((a, b) => b.rawBytes - a.rawBytes).slice(0, 12) }, null, 2))
