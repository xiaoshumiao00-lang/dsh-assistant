/** 手机端流畅度三件套的纯函数回归：node scripts/test-mobile-perf-policy.mjs
 *  1) 活动扫描取样节奏（在跑 1.5 s / 空闲 20 s、每轮最多 6 条、settle 优先）
 *  2) 卡片刷新节流（连续通知压到 ≤ 1/150 ms，尾随补一次，不可见时由调用方跳过）
 *  3) 尾快照短缓存（900 ms 内复用 + 在途去重，失败不缓存）
 */
import assert from 'node:assert/strict'
import { shouldFetchTail, pickTailBatch, RUNNING_TAIL_TTL_MS, IDLE_TAIL_TTL_MS, MAX_TAILS_PER_ROUND } from '../src/client/activitySweepPolicy.ts'
import { createCardRefreshCoalescer, CARD_REFRESH_MIN_INTERVAL_MS } from '../src/client/cardRefreshPolicy.ts'
import { createTailCache, SESSION_TAIL_TTL_MS } from '../src/client/sessionTailCache.ts'

const cases = []

cases.push(['扫描节奏：在跑的 2.5 s 一次，空闲的 20 s 一次', () => {
  const running = { line: 'x', key: 'k1', running: true, at: 1000 }
  assert.equal(shouldFetchTail(running, { running: true, key: 'k1', now: 1000 + RUNNING_TAIL_TTL_MS - 1 }), false)
  assert.equal(shouldFetchTail(running, { running: true, key: 'k1', now: 1000 + RUNNING_TAIL_TTL_MS }), true)
  const idle = { line: 'x', key: 'k1', running: false, at: 1000 }
  assert.equal(shouldFetchTail(idle, { running: false, key: 'k1', now: 1000 + IDLE_TAIL_TTL_MS - 1 }), false)
  assert.equal(shouldFetchTail(idle, { running: false, key: 'k1', now: 1000 + IDLE_TAIL_TTL_MS }), true)
  assert.equal(IDLE_TAIL_TTL_MS > RUNNING_TAIL_TTL_MS, true, '空闲必须比在跑稀疏')
}])

cases.push(['扫描节奏：版本/运行态变化时立刻重取（不能拿旧行充数）', () => {
  const entry = { line: 'x', key: 'k1', running: true, at: 1000 }
  assert.equal(shouldFetchTail(entry, { running: true, key: 'k2', now: 1001 }), true, 'updatedAt 前进 = 开了新一轮')
  assert.equal(shouldFetchTail(entry, { running: false, key: 'k1', now: 1001 }), true, '跑完了要抓最终答复')
  assert.equal(shouldFetchTail(undefined, { running: false, key: 'k1', now: 1 }), true, '没缓存当然要取')
}])

cases.push(['扫描节奏：一轮最多 2 条（常量），刚跑完(settle)的优先', () => {
  const candidates = Array.from({ length: 9 }, (_, i) => ({ sid: 's' + String(i), settle: i === 7 }))
  const batch = pickTailBatch(candidates)
  assert.equal(batch.length, MAX_TAILS_PER_ROUND)
  assert.equal(batch[0].sid, 's7', 'settle 排第一')
}])

cases.push(['卡片刷新节流：同一窗口内 10 次通知只重绘 1 次，尾随补最后一次', () => {
  let clock = 10_000
  const runs = []
  const timers = []
  const c = createCardRefreshCoalescer({
    now: () => clock,
    schedule: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length - 1 },
    cancel: (h) => { if (timers[h]) timers[h].cancelled = true },
  })
  c.bump(() => runs.push(clock))
  for (let i = 0; i < 9; i += 1) { clock += 5; c.bump(() => runs.push(clock)) }
  assert.equal(runs.length, 1, '前导立即一次')
  assert.equal(c.pending(), true, '尾随还挂着一次')
  // 时间推进到定时器触发点
  clock = timers[0].at
  if (!timers[0].cancelled) timers[0].fn()
  assert.equal(runs.length, 2, '尾随补一次')
  // 间隔足够后立刻又允许刷新
  clock += CARD_REFRESH_MIN_INTERVAL_MS
  c.bump(() => runs.push(clock))
  assert.equal(runs.length, 3)
}])

cases.push(['尾快照缓存：窗口内复用（含在途），过期重取，失败不缓存', async () => {
  let clock = 0
  let calls = 0
  const cache = createTailCache({ now: () => clock })
  const key = cache.key('s1', 8, true)
  const first = cache.run(key, async () => { calls += 1; return { n: calls } })
  const second = cache.run(key, async () => { calls += 1; return { n: calls } })
  assert.equal(first, second, '同一窗口返回同一个 promise（在途去重）')
  assert.deepEqual(await first, { n: 1 })
  assert.equal(calls, 1)
  clock = SESSION_TAIL_TTL_MS
  await cache.run(key, async () => { calls += 1; return { n: calls } })
  assert.equal(calls, 2, '过期必须重取')
  const badKey = cache.key('s2', 8, true)
  await cache.run(badKey, async () => { throw new Error('boom') }).catch(() => {})
  let retried = false
  await cache.run(badKey, async () => { retried = true })
  assert.equal(retried, true, '失败不留缓存')
  assert.equal(cache.key('s1', 8, false) === key, false, '参数不同不能复用同一条快照')
}])

let failed = 0
for (const item of cases) {
  try { await item[1](); console.log('  ok   ' + item[0]) } catch (err) { failed += 1; console.log('  FAIL ' + item[0] + '\n       ' + (err && err.message ? err.message : String(err))) }
}
console.log(failed === 0 ? 'PASS ' + String(cases.length) + '/' + String(cases.length) : 'FAIL ' + String(failed) + '/' + String(cases.length))
process.exit(failed === 0 ? 0 : 1)
