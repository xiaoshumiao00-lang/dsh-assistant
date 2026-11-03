/** 手机端性能计数与 perf 信标的回归：node scripts/test-perf-counters.mjs */
import assert from 'node:assert/strict'

const {
  PERF_MAX_KEYS,
  PERF_MAX_FIELDS,
  PERF_REPORT_MS,
  perfBump,
  perfObserveMs,
  perfSnapshot,
  perfReset,
  perfSetEnabled,
  perfIsEnabled,
  perfNowMs,
  buildPerfPayload,
  perfPayloadBytes,
  startPerfBeacon,
} = await import('../src/client/perfCounters.ts')

const cases = []

cases.push(['计数累加与快照取整', () => {
  perfReset()
  perfBump('asm')
  perfBump('asm')
  perfBump('asm', 3)
  perfBump('idxHit', 2.6)
  const snap = perfSnapshot()
  assert.equal(snap.asm, 5)
  assert.equal(snap.idxHit, 3, '小数计数四舍五入')
  assert.equal(Object.values(snap).every((v) => typeof v === 'number' && Number.isFinite(v)), true)
}])

cases.push(['耗时观测给出次数 / 均值 / 最大值', () => {
  perfReset()
  perfObserveMs('idxBuild', 4)
  perfObserveMs('idxBuild', 10)
  perfObserveMs('idxBuild', 7)
  const snap = perfSnapshot()
  assert.equal(snap.idxBuildN, 3)
  assert.equal(snap.idxBuildAvg, 7)
  assert.equal(snap.idxBuildMax, 10)
}])

cases.push(['非法输入不计数（NaN / 负数 / 0 / 非数字）', () => {
  perfReset()
  perfBump('a', 0)
  perfBump('a', Number.NaN)
  perfBump('a', Number.POSITIVE_INFINITY)
  perfBump('a', 'x')
  perfObserveMs('b', -1)
  perfObserveMs('b', Number.NaN)
  assert.deepEqual(perfSnapshot(), {}, '一个都不该落账')
}])

cases.push(['键集有上限，超出直接丢而不是无限长', () => {
  perfReset()
  for (let i = 0; i < PERF_MAX_KEYS + 20; i += 1) perfBump(`k${i}`)
  const snap = perfSnapshot()
  assert.equal(Object.keys(snap).length, PERF_MAX_KEYS)
  assert.equal(snap.k0, 1)
  assert.equal(snap[`k${PERF_MAX_KEYS + 19}`], undefined, '超出上限的新键不落账')
  perfBump('k0', 5)
  assert.equal(perfSnapshot().k0, 6, '已有键仍然可以继续累加')
}])

cases.push(['总开关关掉后完全不计也不发，重新打开继续', () => {
  perfReset()
  perfSetEnabled(false)
  assert.equal(perfIsEnabled(), false)
  perfBump('hidden')
  perfObserveMs('hidden', 9)
  assert.deepEqual(perfSnapshot(), {})
  perfSetEnabled(true)
  perfBump('visible')
  assert.equal(perfSnapshot().visible, 1)
}])

cases.push(['payload：丢零值、extras 覆盖同名键、键排序、字段数与体积有上限', () => {
  const payload = buildPerfPayload(
    { b: 0, a: 1.26, c: 0.04, d: 12 },
    { a: 3, e: 7 },
  )
  assert.equal(payload.b, undefined, '零值不写进 payload')
  assert.equal(payload.a, 3, 'extras 覆盖同名键')
  assert.equal(payload.c, 0, '0.04 四舍五入成 0（仍然写，值本身不是零）')
  assert.deepEqual(Object.keys(payload), ['a', 'c', 'd', 'e'], '键按字典序，便于肉眼比对')
  const many = {}
  for (let i = 0; i < 60; i += 1) many[`f${i}`] = i + 1
  const capped = buildPerfPayload(many)
  assert.equal(Object.keys(capped).length, PERF_MAX_FIELDS)
  assert.ok(perfPayloadBytes(capped) < 900, `payload 体积要小：${perfPayloadBytes(capped)}`)
  assert.equal(perfPayloadBytes(undefined), 0, '不可序列化时返回 0 而不是抛错')
}])

cases.push(['信标：按注入的定时器上报、后台不发、stop 后不再发', () => {
  perfReset()
  perfBump('asm', 2)
  const timers = []
  const cleared = []
  const sent = []
  const stop = startPerfBeacon({
    read: () => perfSnapshot(),
    extra: () => ({ factHit: 9 }),
    post: (ev, payload) => sent.push({ ev, payload }),
    isHidden: () => hidden.now,
    intervalMs: 1000, // 低于下限，应被抬到 5000
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return { id: timers.length } },
    clearIntervalFn: (handle) => cleared.push(handle),
  })
  const hidden = { now: false }
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 5000, '间隔下限 5 s（不会把信标打成每秒一条）')
  timers[0].fn()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].ev, 'perf')
  assert.equal(sent[0].payload.p.asm, 2)
  assert.equal(sent[0].payload.p.factHit, 9, '宿主侧计数要一并带上')
  hidden.now = true
  timers[0].fn()
  assert.equal(sent.length, 1, '页面不可见时不发')
  hidden.now = false
  perfSetEnabled(false)
  timers[0].fn()
  assert.equal(sent.length, 1, '关掉总开关后不发')
  perfSetEnabled(true)
  stop()
  assert.equal(cleared.length, 1, 'stop 要清掉定时器')
  assert.equal(PERF_REPORT_MS, 60000)
}])

cases.push(['信标：计数为空 / post 抛错都不打断后续', () => {
  perfReset()
  const ticks = []
  let throwOnce = true
  const stop = startPerfBeacon({
    read: () => perfSnapshot(),
    post: () => {
      if (throwOnce) { throwOnce = false; throw new Error('boom') }
      ticks.push(1)
    },
    isHidden: () => false,
    setIntervalFn: (fn) => { ticks.fn = fn; return 1 },
    clearIntervalFn: () => {},
  })
  ticks.fn()
  assert.equal(ticks.filter((v) => v === 1).length, 0, '空计数不发')
  perfBump('asm')
  ticks.fn()
  assert.equal(ticks.filter((v) => v === 1).length, 0, '第一次 post 抛错被吞掉')
  ticks.fn()
  assert.equal(ticks.filter((v) => v === 1).length, 1, '抛错之后照旧上报')
  stop()
}])

cases.push(['perfNowMs 单调可用（浏览器与 node 都有 performance）', () => {
  const a = perfNowMs()
  const b = perfNowMs()
  assert.equal(Number.isFinite(a), true)
  assert.ok(b >= a)
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.log('  FAIL ' + name)
    console.log('       ' + (err && err.message ? err.message : String(err)))
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
