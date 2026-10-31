/** localStorage 读缓存回归：node scripts/test-local-store.mjs
 *  盯的是「内容没变不重复 parse」+「返回的是克隆、原地改动不外泄」+「写盘后缓存跟得上」。 */
import assert from 'node:assert/strict'
import { cachedJsonRead, cachedJsonWrite, cloneCached, invalidateCached } from '../src/client/localStore.ts'

const cases = []

/** 假 localStorage：记录读 / 写 / parse 次数 */
function fakeStore(initial) {
  const data = new Map(Object.entries(initial || {}))
  const stats = { reads: 0, writes: 0, parses: 0 }
  globalThis.localStorage = {
    getItem: (key) => { stats.reads++; return data.has(key) ? data.get(key) : null },
    setItem: (key, value) => { stats.writes++; data.set(key, String(value)) },
    removeItem: (key) => { data.delete(key) },
  }
  return { data, stats, set: (key, value) => data.set(key, value) }
}

const reviveOf = (store) => (raw) => { store.stats.parses++; return raw ? JSON.parse(raw) : {} }

cases.push(['同一份内容连读三次只 parse 一次（getItem 仍每次都要读，保证外部改动可见）', () => {
  const store = fakeStore({ 'k.a': '{"x":1}' })
  invalidateCached('k.a')
  const revive = reviveOf(store)
  const a = cachedJsonRead('k.a', revive)
  const b = cachedJsonRead('k.a', revive)
  const c = cachedJsonRead('k.a', revive)
  assert.equal(store.stats.parses, 1, '只 parse 一次）')
  assert.equal(store.stats.reads, 3, '每次都真读过 localStorage（外部写进来也能看见））')
  assert.deepEqual(a, { x: 1 })
  assert.deepEqual(b, { x: 1 })
  assert.deepEqual(c, { x: 1 })
}])

cases.push(['返回的是克隆：调用方原地改动不会污染缓存，也不会像原实现那样被下一次读看到', () => {
  const store = fakeStore({ 'k.b': '{"a":1}' })
  invalidateCached('k.b')
  const revive = reviveOf(store)
  const first = cachedJsonRead('k.b', revive)
  first.a = 99
  first.added = true
  const second = cachedJsonRead('k.b', revive)
  assert.deepEqual(second, { a: 1 }, '旧内容不该被上一次的原地改动改写）')
  assert.notEqual(first, second, '两次读必须拿到不同实例（原实现就是每次新 parse））')
  assert.equal(store.data.get('k.b'), '{"a":1}', '没写盘就不能改存储）')
}])

cases.push(['内容真的变了才重新 parse（旧实现每次都 parse）', () => {
  const store = fakeStore({ 'k.c': '{"v":1}' })
  invalidateCached('k.c')
  const revive = reviveOf(store)
  cachedJsonRead('k.c', revive)
  store.set('k.c', '{"v":2}')
  const next = cachedJsonRead('k.c', revive)
  assert.equal(store.stats.parses, 2, '内容变了必须重 parse）')
  assert.deepEqual(next, { v: 2 })
}])

cases.push(['写盘后缓存跟着新内容：紧接着的读不许多 parse 一次', () => {
  const store = fakeStore({})
  invalidateCached('k.d')
  cachedJsonWrite('k.d', { sid: 'x', done: true })
  assert.equal(store.data.get('k.d'), JSON.stringify({ sid: 'x', done: true }))
  const read = cachedJsonRead('k.d', reviveOf(store))
  assert.equal(store.stats.parses, 0, '写过的内容立刻读不该再 parse）')
  assert.deepEqual(read, { sid: 'x', done: true })
  const again = cachedJsonRead('k.d', reviveOf(store))
  assert.equal(store.stats.parses, 0, '第二次也走缓存）')
  assert.notEqual(read, again)
}])

cases.push(['读不到（键不存在）不缓存空对象：下一次有值了要读得到', () => {
  const store = fakeStore({})
  invalidateCached('k.e')
  const empty = cachedJsonRead('k.e', reviveOf(store))
  assert.deepEqual(empty, {})
  store.set('k.e', '{"late":true}')
  const later = cachedJsonRead('k.e', reviveOf(store))
  assert.deepEqual(later, { late: true }, '不能被缓存里的空对象顶掉）')
}])

cases.push(['克隆覆盖 Map / Set / 数组（不同形状都要独立）', () => {
  const map = new Map([['a', 1]])
  const set = new Set(['x'])
  const arr = [1, 2, 3]
  const cm = cloneCached(map)
  const cs = cloneCached(set)
  const ca = cloneCached(arr)
  cm.set('b', 2); cs.add('y'); ca.push(4)
  assert.equal(map.size, 1)
  assert.equal(set.size, 1)
  assert.equal(arr.length, 3)
  assert.equal(cm.get('b'), 2)
  assert.equal(ca.length, 4)
  assert.equal(cloneCached(5), 5, '原始值原样返回）')
  assert.equal(cloneCached(null), null)
}])

cases.push(['非法 JSON / revive 抛错 / 循环引用都不能把调用方带炸', () => {
  const store = fakeStore({ 'k.f': 'not-json' })
  invalidateCached('k.f')
  const fallback = cachedJsonRead('k.f', (raw) => { JSON.parse(String(raw)); return {} })
  assert.deepEqual(fallback, {}, 'revive 抛错时按空对象交回）')
  const boom = cachedJsonRead('k.g', () => { throw new Error('revive 自己炸了') })
  assert.deepEqual(boom, {})
  const circular = {}
  circular.self = circular
  assert.equal(cachedJsonWrite('k.i', circular), undefined, '循环引用不能抛错）')
  const written = cachedJsonWrite('k.j', { ok: 1 })
  assert.equal(written, undefined)
  assert.equal(store.data.get('k.j'), JSON.stringify({ ok: 1 }), '正常写盘确实落到存储）')
  assert.equal(store.stats.writes, 1, '走的是 localStorage.setItem 一次）')
}])

let failed = 0
for (const item of cases) {
  try { item[1](); console.log('  ok   ' + item[0]) } catch (err) { failed++; console.log('  FAIL ' + item[0] + '\n       ' + (err && err.message ? err.message : err)) }
}
console.log(failed === 0 ? 'PASS ' + cases.length + '/' + cases.length : 'FAIL ' + failed + '/' + cases.length)
process.exit(failed === 0 ? 0 : 1)
