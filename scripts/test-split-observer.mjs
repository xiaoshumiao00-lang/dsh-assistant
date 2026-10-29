/** 分栏互斥观察器：只由调用方在分栏存活期安装，回调与幂等释放语义不变。 */
import assert from 'node:assert/strict'
import { observeExternalSplit } from '../src/client/splitObserver.ts'

let externalSplitPresent = false
let observedTarget = null
let observedOptions = null
let disconnects = 0
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.disconnected = false
    FakeMutationObserver.instance = this
  }
  observe(target, options) {
    observedTarget = target
    observedOptions = options
  }
  disconnect() {
    this.disconnected = true
    disconnects += 1
  }
  trigger() {
    if (!this.disconnected) this.callback([])
  }
}
const body = { name: 'body' }
globalThis.document = {
  body,
  querySelector(selector) {
    assert.equal(selector, '.ta_split')
    return externalSplitPresent ? { name: 'ta-split' } : null
  },
}
globalThis.MutationObserver = FakeMutationObserver

assert.equal(FakeMutationObserver.instance ?? null, null, '模块导入不得自行安装 body 观察器')
let calls = 0
const stop = observeExternalSplit(() => { calls += 1 })
const observer = FakeMutationObserver.instance
assert.equal(observedTarget, body)
assert.deepEqual(observedOptions, { childList: true, subtree: true })
observer.trigger()
assert.equal(calls, 0, '没有外来分栏时不关闭本工作区')
externalSplitPresent = true
observer.trigger()
assert.equal(calls, 1, '外来分栏出现时仍立即让位')
stop()
stop()
assert.equal(disconnects, 1, '清理必须幂等')
observer.trigger()
assert.equal(calls, 1, '释放后不再处理流式 DOM 变更')

// open 同步阶段已经插入的外来浮层：安装后按微任务补现态检查，不能漏互斥。
const stopExisting = observeExternalSplit(() => { calls += 1 })
assert.equal(calls, 1, '现态检查保持 MutationObserver 的异步时序')
await Promise.resolve()
assert.equal(calls, 2, '安装前已存在的 .ta_split 也必须让位')
stopExisting()

delete globalThis.document
delete globalThis.MutationObserver
console.log('split-observer: lazy install + external split + idempotent dispose OK')
