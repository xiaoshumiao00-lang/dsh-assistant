/** 手机精简首屏：boot entries、combo batch 与 preload 必须同步减量。 */
import assert from 'node:assert/strict'
import { optimizeMobileBoot, omitFromComboUrl } from '../src/pocket-host/mobile-boot.mjs'

const core = '@deepseek-ai/dsh-client-connection'
const account = '@deepseek-ai/dsh-client-ui-settings-account'
const desktop = '@deepseek-ai/dsh-client-product-analytics'
const native = '@deepseek-ai/dsh-client-ui-directory-picker-native'
const hmr = '@deepseek-ai/dsh-client-hmr'
const assistant = 'dsh-assistant'
const mnemon = 'dsh-mnemon'
const skill = 'dsh-skill-mcp-panel'
const schedule = '@deepseek-ai/dsh-client-ui-schedule'
const voice = 'voice-test'
const entry = (id, extra = {}) => ({ id, url: `plugins/??${id}/client.js&rev=x`, rev: 'x', ...extra })
const graph = {
  rev: 'test', entries: [entry(core), entry(account), entry(assistant), entry(mnemon), entry(skill), entry(schedule), entry(desktop)],
  batches: [
    { phase: 'bootstrap', entries: ['@deepseek-ai/dsh-client-modules'], url: 'plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=x' },
    { phase: 'application', entries: [core, account, assistant, skill, schedule, desktop], url: `plugins/??${core}/client.js,${account}/client.js,${assistant}/client.js,${skill}/client.js,${schedule}/client.js,${desktop}/client.js&rev=x` },
    { phase: 'application', entries: [mnemon], url: `plugins/??${mnemon}/client.js&rev=x` },
  ],
}
const html = `<head><link rel="preload" as="script" href="plugins/??${core}/client.js,${account}/client.js,${assistant}/client.js,${skill}/client.js,${schedule}/client.js,${desktop}/client.js&amp;rev=x"><link rel="preload" as="script" href="plugins/??${mnemon}/client.js&amp;rev=x"><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)}</script></head>`
const out = optimizeMobileBoot(html)
assert.equal(out.changed, true)
assert.deepEqual(out.omitted, [desktop])
for (const kept of [core, account, assistant, mnemon, skill, schedule]) {
  assert.equal(out.html.includes(kept), true, `${kept} 的用户入口必须保留`)
}
assert.equal(out.html.includes(desktop), false, '桌面埋点模块仍可精简')
assert.equal(out.html.includes('&amp;rev=x'), true, '保留的 HTML preload 要维持合法转义')

const guarded = optimizeMobileBoot(`<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
  rev: 'x', entries: [entry(core), entry(account), entry(mnemon), entry(desktop), entry(native), entry(hmr), entry(assistant, { external: [desktop] }), entry(voice, { inject: [hmr] })],
  batches: [{ phase: 'application', entries: [core, account, assistant, mnemon, voice, desktop, native, hmr], url: `plugins/??${core}/client.js,${account}/client.js,${assistant}/client.js,${mnemon}/client.js,${voice}/client.js,${desktop}/client.js,${native}/client.js,${hmr}/client.js&rev=x` }],
})}</script>`)
assert.equal(guarded.omitted.includes(desktop), false, 'external 硬依赖必须自动保留')
assert.equal(guarded.omitted.includes(hmr), false, 'inject 服务硬依赖必须自动保留')
assert.equal(guarded.omitted.includes(native), true, '无依赖的桌面原生模块仍可省略')
assert.equal(omitFromComboUrl(`plugins/??${desktop}/client.js&rev=x`, new Set([desktop])), null)
// 真实包体回归（2026-11-17 本机 entry 实测）：旧权重会把 8.2MB 挤到一路，
// 另两路仅 2.6/3.4MB。三路按真实量级分配后，最大路不应超过最小路 35%。
const realWeights = {
  [assistant]: 1_556_328,
  [account]: 3_417_762,
  '@deepseek-ai/dsh-api-remotes': 1_083_970,
  [mnemon]: 913_546,
  '@deepseek-ai/dsh-client-ui-conversation': 799_490,
  '@deepseek-ai/dsh-client-ui-plugin-manager': 626_502,
  '@deepseek-ai/dsh-client-ui-chat': 622_931,
  '@deepseek-ai/dsh-cordis-client-runner': 402_344,
  '@deepseek-ai/dsh-client-ui-trajectory': 398_700,
  [schedule]: 328_499,
  'dsh-mnemon-source-memory-spaces': 291_111,
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': 286_625,
  [skill]: 238_501,
  '@deepseek-ai/dsh-client-ui-workspace': 232_805,
  '@deepseek-ai/dsh-client-ui-settings-models': 211_468,
  '@deepseek-ai/dsh-client-ui-tool': 198_235,
  '@deepseek-ai/dsh-client-ui-sidebar-right': 190_139,
  '@deepseek-ai/dsh-api-session-controller': 166_697,
}
const realEntries = [...Object.keys(realWeights), desktop, ...Array.from({ length: 25 }, (_, i) => `small-${i}`)].map((id) => entry(id))
const realHtml = `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'x', entries: realEntries, batches: [{ phase: 'application', entries: realEntries.map((row) => row.id), url: 'x' }] })}</script>`
const balanced = optimizeMobileBoot(realHtml, { createBatch: (_rows, index) => `batch-${index}` })
const balancedGraph = JSON.parse(/<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/.exec(balanced.html)[1])
const projected = balancedGraph.batches.filter((row) => row.phase === 'application')
  .map((row) => row.entries.reduce((sum, id) => sum + (realWeights[id] ?? 10_000), 0))
assert.equal(projected.length, 3)
assert.ok(Math.max(...projected) <= Math.min(...projected) * 1.35,
  `真实包体三路失衡：${projected.join(' / ')}`)

const plain = '<html><head></head>'
assert.equal(optimizeMobileBoot(plain).html, plain)
console.log(`mobile-boot: graph + combo + preload + external guard OK; real-size batches=${projected.join(' / ')}`)
