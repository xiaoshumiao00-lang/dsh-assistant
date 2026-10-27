/** 手机运行实例跨 HMR 复用：同代码不断线，代码变化才替换，禁用后延迟回收。 */
import assert from 'node:assert/strict'
import { acquirePocketRuntime, releasePocketRuntime } from '../src/pocket-host/runtime.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let created = 0
const make = () => ({ id: ++created, disposals: 0, async dispose() { this.disposals++ } })

const first = acquirePocketRuntime('test-a', make, { graceMs: 30 })
releasePocketRuntime(first)
const reopened = acquirePocketRuntime('test-a', make, { graceMs: 30 })
assert.equal(reopened, first, '同一代码哈希的 HMR 必须复用原服务')
assert.equal(created, 1, '重载不得重复创建代理')
releasePocketRuntime(reopened)

const replacement = acquirePocketRuntime('test-b', make, { graceMs: 30 })
assert.notEqual(replacement.service, first.service, '代码变化才创建新实例')
assert.equal(first.service.disposals, 1, '被替换的旧代码实例必须清理')
releasePocketRuntime(replacement)
await sleep(70)
assert.equal(replacement.service.disposals, 1, '真正禁用后应按宽限期回收')

console.log('pocket-runtime: HMR reuse + revision replacement + delayed disposal OK')
