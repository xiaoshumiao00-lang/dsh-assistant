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
const plain = '<html><head></head>'
assert.equal(optimizeMobileBoot(plain).html, plain)
console.log('mobile-boot: graph + combo + preload + external guard OK')
