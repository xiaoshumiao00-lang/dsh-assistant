/** 实测某一 HTML 首屏在精简前后的 application batch 原始网络字节数。 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { optimizeMobileBoot } from '../src/pocket-host/mobile-boot.mjs'

const [htmlFile, base = 'http://127.0.0.1:64165/'] = process.argv.slice(2)
if (!htmlFile) throw new Error('usage: node scripts/measure-mobile-boot.mjs <html> [base]')
const html = readFileSync(htmlFile, 'utf8')
const optimized = optimizeMobileBoot(html)
const graphOf = (text) => JSON.parse(/<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/.exec(text)[1])
const download = (url) => new Promise((resolve, reject) => {
  const target = new URL(url, base)
  http.get(target, { headers: { 'accept-encoding': 'gzip', 'user-agent': 'mobile-boot-measure' } }, (res) => {
    let bytes = 0
    res.on('data', (chunk) => { bytes += chunk.length })
    res.on('end', () => resolve({ status: res.statusCode, bytes, encoding: res.headers['content-encoding'] ?? 'identity' }))
    res.on('error', reject)
  }).on('error', reject)
})
for (const [label, text] of [['before', html], ['after', optimized.html]]) {
  const graph = graphOf(text)
  const rows = []
  for (const batch of graph.batches.filter((row) => row.phase === 'application')) {
    const result = await download(batch.url)
    rows.push({ modules: batch.entries.length, ...result })
  }
  console.log(JSON.stringify({ label, modules: graph.entries.length, omitted: optimized.omitted, batches: rows, totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0) }, null, 2))
}
