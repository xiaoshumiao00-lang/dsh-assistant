/** 会话面快照缓存回归：node scripts/test-face-cache.mjs
 *  盯的是「同一批判定里同一条会话只读一次」+「过期一定要重读」+「取不到不缓存」。 */
import assert from 'node:assert/strict'
import { createFaceSnapshotCache, FACE_SNAPSHOT_TTL_MS } from '../src/client/faceSnapshotCache.ts'

const cases = []

function makeStore(initial = {}) {
  const state = { reads: 0, clock: 0, data: { ...initial } }
  const cache = createFaceSnapshotCache({
    read: (sid) => { state.reads++; return state.data[sid] ?? null },
    now: () => state.clock,
    ttlMs: 1000,
  })
  const advance = (ms) => { state.clock += ms }
  return { cache, state, advance }
}

cases.push(['窗口内重复读只读宿主一次（卡片 + 提醒表 + 待决表都要读同一条会话）', () => {
  const { cache, state } = makeStore({ s1: { pending: ['q1'] } })
  const a = cache.get('s1')
  const b = cache.get('s1')
  const c = cache.get('s1')
  assert.equal(state.reads, 1, '只打了一次宿主 getSnapshot()）')
  assert.equal(a, b, '同一批里给的是同一份（宿主投影对象本来就复用））')
  assert.deepEqual(a, { pending: ['q1'] })
  assert.equal(c.pending[0], 'q1')
}])

cases.push(['过期必须重读（不能把在跑 / 待决的新状态压住）', () => {
  const { cache, state, advance } = makeStore({ s1: { completed: false } })
  cache.get('s1')
  state.data.s1 = { completed: true }
  assert.equal(cache.get('s1').completed, false, '窗口内仍是同一份）')
  advance(1000)
  assert.equal(cache.get('s1').completed, true, '过期后必须看见新状态）')
  assert.equal(state.reads, 2)
}])

cases.push(['取不到（null）不缓存：会话面挂上来以后马上要看得见', () => {
  const { cache, state } = makeStore({})
  assert.equal(cache.get('s2'), null)
  assert.equal(cache.get('s2'), null)
  assert.equal(state.reads, 2, '没缓存才每次都真读）')
  state.data.s2 = { pending: [] }
  assert.deepEqual(cache.get('s2'), { pending: [] })
  assert.equal(cache.cachedIds().includes('s2'), true)
}])

cases.push(['读抛错按 null（不能把宿主异常带进卡片渲染）', () => {
  const state = { reads: 0 }
  const cache = createFaceSnapshotCache({ read: () => { state.reads++; throw new Error('宿主炸了') }, now: () => 0 })
  assert.equal(cache.get('s3'), null)
  assert.equal(cache.cachedIds().length, 0)
}])

cases.push(['invalidate / invalidateAll 立刻看见新值（宿主通知或本地改动用）', () => {
  const { cache, state } = makeStore({ s1: { v: 1 } })
  cache.get('s1')
  state.data.s1 = { v: 2 }
  cache.invalidate('s1')
  assert.equal(cache.get('s1').v, 2, '作废后必须重读）')
  state.data.s1 = { v: 3 }
  cache.invalidateAll()
  assert.equal(cache.get('s1').v, 3)
  assert.equal(cache.cachedIds().length, 1)
}])

cases.push(['空 id / 非法 id 直接 null，不占缓存', () => {
  const { cache, state } = makeStore({ s1: { v: 1 } })
  assert.equal(cache.get(''), null)
  assert.equal(cache.get(undefined), null)
  assert.equal(cache.cachedIds().length, 0)
  assert.equal(state.reads, 0)
  assert.equal(FACE_SNAPSHOT_TTL_MS <= 200, true, '窗口必须短于一轮渲染（不许跨通知把状态压住）')
}])

let failed = 0
for (const item of cases) {
  try { item[1](); console.log('  ok   ' + item[0]) } catch (err) { failed++; console.log('  FAIL ' + item[0] + '\n       ' + (err && err.message ? err.message : err)) }
}
console.log(failed === 0 ? 'PASS ' + cases.length + '/' + cases.length : 'FAIL ' + failed + '/' + cases.length)
process.exit(failed === 0 ? 0 : 1)
