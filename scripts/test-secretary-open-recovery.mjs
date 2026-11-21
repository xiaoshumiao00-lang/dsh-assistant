/**
 * 个人秘书「固定会话失效 → 恢复」决策表单测（纯函数，不需要浏览器）：
 *   node scripts/test-secretary-open-recovery.mjs
 *
 * 这些断言钉住 2026-11-21 的实测根因（宿主 state 指向一条已从会话表里消失的会话 →
 * 客户端 openSession 撞 sessions.retain: unknown session → 重试 8 次 → 静默放弃 → 单击悬浮球没反应）：
 *   1. 宿主说「这条会话还在」时 **绝不新建会话**（防「个人秘书长出第二条」的老病）；
 *   2. 宿主说「不在了」时才重建一次，重建也不成功就切控制室并带 reason；
 *   3. 宿主问不出结果（老宿主没 exists 字段）时，只有客户端报了 unknown session 才重建；
 *   4. 已重建过一次就不再重建（防无限造会话）；
 *   5. 退避序列与 unknown session 错误识别是恢复分支的输入，也要钉住。
 */
import assert from 'node:assert/strict'
import {
  isDeadSessionError,
  OPEN_RETRY_EXTRA_LIMIT,
  OPEN_RETRY_LIMIT,
  openRetryWaitMs,
  planRecovery,
} from '../src/client/secretary-open-recovery.ts'

const cases = []

cases.push(['已经打开好了 → 什么都不做', () => {
  const plan = planRecovery({
    opened: true,
    deadSignal: false,
    exists: false,
    usedExtraRetry: false,
    alreadyRebuilt: false,
    homeUsable: true,
  })
  assert.equal(plan.kind, 'none')
}])

cases.push(['宿主说「会话还在」：只多等一轮，绝不新建（实测根因防复发）', () => {
  const first = planRecovery({
    opened: false,
    deadSignal: true,
    exists: true,
    usedExtraRetry: false,
    alreadyRebuilt: false,
    homeUsable: true,
  })
  assert.equal(first.kind, 'retry-extra')
  const second = planRecovery({
    opened: false,
    deadSignal: true,
    exists: true,
    usedExtraRetry: true,
    alreadyRebuilt: false,
    homeUsable: true,
  })
  assert.equal(second.kind, 'console')
  assert.ok(second.reason.includes('控制室'))
}])

cases.push(['exists=true 的任何组合都不许出现 rebuild', () => {
  const inputs = []
  for (const opened of [false]) {
    for (const deadSignal of [false, true]) {
      for (const usedExtraRetry of [false, true]) {
        for (const alreadyRebuilt of [false, true]) {
          for (const homeUsable of [false, true]) {
            inputs.push({ opened, deadSignal, exists: true, usedExtraRetry, alreadyRebuilt, homeUsable })
          }
        }
      }
    }
  }
  assert.equal(inputs.length, 16)
  for (const input of inputs) {
    const plan = planRecovery(input)
    assert.notEqual(plan.kind, 'rebuild', `exists=true 却计划新建：${JSON.stringify(input)}`)
  }
}])

cases.push(['宿主说「会话不在了」→ 重建一次（state 指向已不存在会话的主分支）', () => {
  const plan = planRecovery({
    opened: false,
    deadSignal: true,
    exists: false,
    usedExtraRetry: false,
    alreadyRebuilt: false,
    homeUsable: true,
  })
  assert.equal(plan.kind, 'rebuild')
  assert.ok(plan.reason.length > 0)
}])

cases.push(['重建过一次还不行 → 切控制室，不再重建', () => {
  const plan = planRecovery({
    opened: false,
    deadSignal: true,
    exists: false,
    usedExtraRetry: true,
    alreadyRebuilt: true,
    homeUsable: true,
  })
  assert.equal(plan.kind, 'console')
  assert.ok(plan.reason.includes('仍然打不开'))
}])

cases.push(['家目录不可用时不许重建（建不出会话，白折腾）', () => {
  const plan = planRecovery({
    opened: false,
    deadSignal: true,
    exists: false,
    usedExtraRetry: false,
    alreadyRebuilt: false,
    homeUsable: false,
  })
  assert.equal(plan.kind, 'console')
  assert.ok(plan.reason.includes('家目录'))
}])

cases.push(['宿主问不出结果（老宿主没 exists 字段）：只有报 unknown session 才重建', () => {
  const dead = planRecovery({
    opened: false,
    deadSignal: true,
    exists: null,
    usedExtraRetry: false,
    alreadyRebuilt: false,
    homeUsable: true,
  })
  assert.equal(dead.kind, 'rebuild')
  const unsure = planRecovery({
    opened: false,
    deadSignal: false,
    exists: null,
    usedExtraRetry: false,
    alreadyRebuilt: false,
    homeUsable: true,
  })
  assert.equal(unsure.kind, 'retry-extra')
  const exhausted = planRecovery({
    opened: false,
    deadSignal: false,
    exists: null,
    usedExtraRetry: true,
    alreadyRebuilt: false,
    homeUsable: true,
  })
  assert.equal(exhausted.kind, 'console')
}])

cases.push(['退避序列：500ms 起、1.5 倍递增、封顶 3000ms', () => {
  const waits = Array.from({ length: 8 }, (_, i) => openRetryWaitMs(i))
  assert.deepEqual(waits.slice(0, 4), [500, 750, 1125, 1688])
  assert.deepEqual(waits.slice(4), [2531, 3000, 3000, 3000])
  assert.equal(openRetryWaitMs(0), 500)
  assert.equal(openRetryWaitMs(1000), 3000)
}])

cases.push(['上限值：第一遍 8 次、多等一轮 20 次', () => {
  assert.equal(OPEN_RETRY_LIMIT, 8)
  assert.equal(OPEN_RETRY_EXTRA_LIMIT, 20)
}])

cases.push(['unknown session 那一类错误要认得出来（实测原文）', () => {
  assert.equal(isDeadSessionError(new Error('sessions.retain: unknown session session-33044545-4737-4e86-960d-43f57b357dea')), true)
  assert.equal(isDeadSessionError('Error: session not found'), true)
  assert.equal(isDeadSessionError('no such session'), true)
  assert.equal(isDeadSessionError('无法打开会话'), false)
  assert.equal(isDeadSessionError('fetch failed: network timeout'), false)
  assert.equal(isDeadSessionError(''), false)
  assert.equal(isDeadSessionError(null), false)
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} secretary-open-recovery`)
