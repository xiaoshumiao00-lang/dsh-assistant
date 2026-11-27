/**
 * 尾快照缓存的容量与清扫回归：node scripts/test-session-tail-cache.mjs
 *
 * 固定这几条边界（第 3 步性能整改加的上限/清扫/invalidate）：
 *   - 过期条目本体被清掉（不是「只不再复用」），容量因此不会被过期条目越推越深；
 *   - 每轮 run() 的清扫遍历上界 = sweepMaxScans（有界，不会无界遍历）；
 *   - 超过 maxEntries 时按「最早过期的已结算条目」淘汰；
 *   - 在途条目永不淘汰（正在跑的 follow 流不会被缓存表踢掉）；
 *   - 全表都在途时新请求不进表（factory 照跑、表不越界）；
 *   - 失败不缓存（现有语义没动）；
 *   - 命中窗口的复用语义一点没变：900 ms 内复用同一个 promise（含在途），到点就重取；
 *   - 同 key 在途去重：factory 只跑一次；
 *   - invalidate(sessionId) 只清这条会话的键；invalidateAll() 之后 size 归零。
 */
import assert from 'node:assert/strict'
import {
  createTailCache,
  SESSION_TAIL_MAX_ENTRIES,
  SESSION_TAIL_SWEEP_MAX_SCANS,
  SESSION_TAIL_TTL_MS,
} from '../src/client/sessionTailCache.ts'

const cases = []

/** 可注入的假时钟（createTailCache 已有 options.now） */
function fakeCache(overrides = {}) {
  const clock = { at: 0 }
  const cache = createTailCache({ now: () => clock.at, ...overrides })
  return { cache, clock }
}

cases.push(['新常量就位：默认上限 256，清扫上界与上限同源', () => {
  assert.equal(SESSION_TAIL_MAX_ENTRIES, 256, '表容量上限默认 256（注释里的理由：窗口只有 900 ms，256 条足以兜住多标签控制室）')
  assert.equal(SESSION_TAIL_SWEEP_MAX_SCANS, SESSION_TAIL_MAX_ENTRIES, '清扫遍历上界与容量同源，所以一次 run 的遍历是有界的')
  assert.equal(SESSION_TAIL_TTL_MS, 900, '窗口常量没被动过')
  const { cache } = fakeCache()
  assert.equal(cache.maxEntries(), SESSION_TAIL_MAX_ENTRIES, '不传 options.maxEntries 就用默认上限')
}])

cases.push(['上限与窗口语义都不变：窗口内复用、到点重取（900 ms 口径没改）', async () => {
  const { cache, clock } = fakeCache()
  let calls = 0
  const key = cache.key('s1', 8, true)
  const first = cache.run(key, async () => { calls += 1; return { n: calls } })
  const withinWindow = cache.run(key, async () => { calls += 1 })
  assert.equal(withinWindow, first, '窗口内复用同一个 promise（包括已经结算的）')
  const firstValue = await first
  assert.deepEqual(firstValue, { n: 1 })
  assert.equal(calls, 1)
  clock.at = SESSION_TAIL_TTL_MS - 1
  assert.equal(cache.run(key, async () => { calls += 1 }), first, 'ttl-1 仍在窗口内')
  assert.equal(calls, 1, '窗口边界还是老的 900 ms 口径')
  clock.at = SESSION_TAIL_TTL_MS
  const afterWindow = cache.run(key, async () => { calls += 1; return { n: calls } })
  assert.notEqual(afterWindow, first, '到点必须重取（不许把窗口拉长）')
  const secondValue = await afterWindow
  assert.deepEqual(secondValue, { n: 2 })
  assert.equal(cache.key('s1', 8, false) === key, false, '参数不同不能复用同一条快照')
}])

cases.push(['过期条目被清扫：条目本体真的从表里出去，不只是不再复用', async () => {
  const { cache, clock } = fakeCache()
  await Promise.all([
    cache.run(cache.key('s1', 8, true), async () => 's1'),
    cache.run(cache.key('s2', 8, true), async () => 's2'),
    cache.run(cache.key('s3', 8, true), async () => 's3'),
  ])
  assert.equal(cache.size(), 3, '三条都在表里')
  clock.at = SESSION_TAIL_TTL_MS + 1
  const s4Key = cache.key('s4', 8, true)
  await cache.run(s4Key, async () => 's4')
  assert.equal(cache.size(), 1, '过期条目的本体被清扫掉了，表里只剩新插的那一条')
  const reused = cache.run(s4Key, async () => 'again')
  assert.equal(await reused, 's4', '没过期的那条仍然复用原来的结果（清扫没有误伤）')
}])

cases.push(['清扫是有界的：每轮最多扫 sweepMaxScans 条', async () => {
  const { cache, clock } = fakeCache({ sweepMaxScans: 2 })
  await Promise.all([
    cache.run(cache.key('a', 8, true), async () => 'a'),
    cache.run(cache.key('b', 8, true), async () => 'b'),
    cache.run(cache.key('c', 8, true), async () => 'c'),
    cache.run(cache.key('d', 8, true), async () => 'd'),
  ])
  assert.equal(cache.size(), 4)
  clock.at = SESSION_TAIL_TTL_MS + 1
  await cache.run(cache.key('e', 8, true), async () => 'e')
  assert.equal(cache.size(), 3, '一轮清扫只清 2 条（4 - 2 + 新插的 1），没把整表扫穿')
}])

cases.push(['按最早过期淘汰：最老的已结算条目先出局，其余留着', async () => {
  const { cache, clock } = fakeCache({ maxEntries: 2 })
  const keyA = cache.key('a', 8, true)
  const keyB = cache.key('b', 8, true)
  const keyC = cache.key('c', 8, true)
  const promiseA = cache.run(keyA, async () => 'a1')
  await promiseA
  clock.at = 100
  const promiseB = cache.run(keyB, async () => 'b1')
  await promiseB
  clock.at = 200
  let cCalls = 0
  const promiseC = cache.run(keyC, () => { cCalls += 1; return new Promise(() => {}) })
  assert.equal(cache.size(), 2, '插入 c 时把最早过期的 a 淘汰（a 结算于 at=0，b 结算于 at=100）')
  let aCalls = 1
  const aAgain = cache.run(keyA, async () => { aCalls += 1; return 'a2' })
  assert.notEqual(aAgain, promiseA, '被淘汰的 a 不再复用')
  assert.equal(await aAgain, 'a2', '被淘汰的 a 重取一次')
  assert.equal(cCalls, 1, '淘汰只看已结算条目：c（在途）不会被踢')
  assert.equal(cache.run(keyC, async () => 'never'), promiseC, 'c 还在表里，仍复用同一条在途 promise')
  assert.equal(cCalls, 1, '复用在途条目不重跑 factory')
  assert.equal(cache.size(), 2, 'b 被淘汰后表仍不越界')
}])

cases.push(['全表都在途时不缓存新的：factory 照跑、表不越界、在途照旧复用', async () => {
  const { cache, clock } = fakeCache({ maxEntries: 1 })
  let xCalls = 0
  let yCalls = 0
  const promiseX = cache.run(cache.key('x', 8, true), () => { xCalls += 1; return new Promise(() => {}) })
  assert.equal(cache.size(), 1)
  const y1 = cache.run(cache.key('y', 8, true), async () => { yCalls += 1; return 'y1' })
  const y2 = cache.run(cache.key('y', 8, true), async () => { yCalls += 1; return 'y2' })
  assert.notEqual(y1, y2, '未缓存的同 key 不共享 promise')
  assert.deepEqual(await Promise.all([y1, y2]), ['y1', 'y2'])
  assert.equal(yCalls, 2, '表被在途占满 ⇒ y 不进表，两次都得自己跑 factory')
  assert.equal(cache.size(), 1, '容量不会被在途条目越推越深')
  assert.equal(cache.run(cache.key('x', 8, true), async () => 'never'), promiseX, '在途的 x 仍被复用')
  assert.equal(xCalls, 1, '复用在途条目不重跑 factory')
  assert.equal(clock.at, 0, '假时钟没被自己推进')
}])

cases.push(['失败不缓存（现有语义没动）：一次抖动不把卡片进度钉死 900 ms', async () => {
  const { cache, clock } = fakeCache()
  const key = cache.key('boom', 8, true)
  await cache.run(key, async () => { throw new Error('boom') }).catch(() => {})
  assert.equal(cache.size(), 0, '失败的结果留在表里就是钉死一轮窗口，必须被摘掉')
  let retried = false
  const value = await cache.run(key, async () => { retried = true; return 'ok' })
  assert.equal(retried, true, '失败不缓存 ⇒ 下一轮必须重试')
  assert.equal(value, 'ok')
  assert.equal(clock.at, 0)
}])

cases.push(['同 key 在途去重：factory 只跑一次', async () => {
  const { cache } = fakeCache()
  let calls = 0
  const key = cache.key('slow', 8, true)
  const first = cache.run(key, async () => { calls += 1; return { n: calls } })
  const second = cache.run(key, async () => { calls += 1; return { n: calls } })
  const third = cache.run(key, async () => { calls += 1; return { n: calls } })
  assert.equal(second, first, '在途的 promise 被复用')
  assert.equal(third, first, '第三次也一样')
  assert.deepEqual(await first, { n: 1 })
  assert.equal(calls, 1, '同一条 follow 流只开一次')
  assert.equal(cache.size(), 1)
}])

cases.push(['invalidate(sessionId)：只清这条会话的键，别的会话原样留着', async () => {
  const { cache } = fakeCache()
  const s2Key = cache.key('s2', 8, true)
  await Promise.all([
    cache.run(cache.key('s1', 8, true), async () => 'a'),
    cache.run(cache.key('s1', 20, false), async () => 'b'),
    cache.run(s2Key, async () => 'c'),
  ])
  assert.equal(cache.size(), 3)
  const removed = cache.invalidate('s1')
  assert.equal(removed, 2, '按会话失效清掉 s1 的两个参数组合')
  assert.equal(cache.size(), 1, 's2 不动')
  let s2Refetch = 0
  const reused = cache.run(s2Key, () => { s2Refetch += 1; return Promise.resolve('d') })
  assert.equal(await reused, 'c', 's2 还在窗口内，拿的还是原来那条快照结果')
  assert.equal(s2Refetch, 0, '按会话失效没有误伤别的会话（没重跑 factory）')
  let s1Refetch = 0
  const s1Again = cache.run(cache.key('s1', 8, true), async () => { s1Refetch += 1; return 'a2' })
  assert.equal(await s1Again, 'a2', '失效过的 s1 必须重取')
  assert.equal(s1Refetch, 1)
  assert.equal(cache.invalidate('nope'), 0, '没有这条会话时不报错、也不清任何东西')
}])

cases.push(['invalidateAll() 后 size 归零（全表作废）', async () => {
  const { cache } = fakeCache()
  await Promise.all([
    cache.run(cache.key('s1', 8, true), async () => 'a'),
    cache.run(cache.key('s2', 8, true), async () => 'b'),
  ])
  assert.equal(cache.size(), 2)
  assert.equal(cache.invalidateAll(), 2, '返回值说清作废了几条')
  assert.equal(cache.size(), 0, '作废后 size 归零')
  let calls = 0
  const value = await cache.run(cache.key('s1', 8, true), async () => { calls += 1; return 'new' })
  assert.equal(value, 'new', '作废后同一条会话必须重取')
  assert.equal(calls, 1)
  assert.equal(cache.size(), 1)
}])

cases.push(['上限硬生效：塞满会话不会把表推过容量', async () => {
  const { cache, clock } = fakeCache({ maxEntries: 3 })
  for (let i = 0; i < 12; i += 1) {
    clock.at = i
    await cache.run(cache.key(`s${String(i)}`, 8, true), async () => i)
  }
  assert.equal(cache.size(), 3, '12 个会话只有最后 3 条留下')
  assert.equal(cache.maxEntries(), 3)
}])

let failed = 0
for (const item of cases) {
  try {
    await item[1]()
    console.log('  ok   ' + item[0])
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + item[0] + '\n       ' + (error && error.message ? error.message : String(error)))
  }
}
console.log(failed === 0 ? 'PASS ' + String(cases.length) + '/' + String(cases.length) : 'FAIL ' + String(failed) + '/' + String(cases.length))
process.exit(failed === 0 ? 0 : 1)
