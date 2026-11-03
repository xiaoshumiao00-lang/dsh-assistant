/** 下行分道队列回归：node scripts/test-downlink-lanes.mjs
 *  盯的是：同流保序、异流小帧越过排队大帧、drain 背压、同 key 合并、唯一帧不丢。 */
import assert from 'node:assert/strict'
import { createDownlinkScheduler, classifyDownlinkMessage, DEFAULT_HIGH_LANE_BYTES } from '../src/pocket-host/downlink-lanes.mjs'

const cases = []

/** 可控假链路：write 只记账，不真排队；encode 有一个固定的虚拟耗时。 */
function harness({ encodeMs = 5, allowBypass = true, limits: extra = {} } = {}) {
  const state = { clock: 0, writes: [], resume: null }
  const scheduler = createDownlinkScheduler({
    encode: async (text) => {
      await new Promise((r) => setTimeout(r, 0))
      state.clock += encodeMs
      return { frame: text, raw: true }
    },
    write: (frame) => {
      state.writes.push({ at: state.clock, text: frame.toString('utf8') })
      return true
    },
    now: () => state.clock,
    limits: { allowBypass, ...extra },
  })
  return { scheduler, state }
}

const big = (sid, n) => JSON.stringify({ type: 'item', streamId: sid, value: { type: 'assistant-stream', chunk: 'x'.repeat(n) } })
const small = (sid, tag) => JSON.stringify({ type: 'item', streamId: sid, value: { type: 'projection', sessionId: sid, key: 'activity', tag, seq: 1 } })

cases.push(['分类：≤ 阈值走 high，大帧走 low，能认出厂 projection 的合并键', () => {
  const s = classifyDownlinkMessage(small('s1', 'a'))
  assert.equal(s.lane, 'high')
  assert.equal(s.streamId, 's1')
  assert.ok(s.coalesceKey && s.coalesceKey.includes('s1'), 'projection 帧要带合并键')
  const bigClass = classifyDownlinkMessage(big('s2', DEFAULT_HIGH_LANE_BYTES * 2))
  assert.equal(bigClass.lane, 'low')
  assert.equal(bigClass.streamId, 's2')
  assert.equal(bigClass.coalesceKey, null, '非 projection 帧不可合并')
}])

cases.push(['同流严格保序：同一条流的小帧不能越过它自己排队的大帧', async () => {
  const { scheduler, state } = harness()
  scheduler.push(big('A', 4000), 1)
  scheduler.push(small('A', 'after'), 1)
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(state.writes.map((w) => JSON.parse(w.text).value.tag ?? 'big'), ['big', 'after'])
}])

cases.push(['异流越过：B 流小帧必须抢在 A 流排队大帧之前送出', async () => {
  const { scheduler, state } = harness()
  scheduler.push(big('A', 4000), 1)
  scheduler.push(small('B', 'click'), 1)
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(state.writes.map((w) => JSON.parse(w.text).value.tag ?? 'big'), ['click', 'big'])
}])

cases.push(['慢链路 A/B：同样一大三小，开启越过把小帧的等待从 N 拍压到 1 拍', async () => {
  const run = async (allowBypass) => {
    const { scheduler, state } = harness({ encodeMs: 20, allowBypass })
    for (let i = 0; i < 3; i += 1) scheduler.push(big(`A${String(i)}`, 4000), 1)
    scheduler.push(small('B', 'click'), 1)
    await new Promise((r) => setTimeout(r, 80))
    const click = state.writes.find((w) => (JSON.parse(w.text).value.tag ?? '') === 'click')
    return click ? click.at : Infinity
  }
  const before = await run(false)
  const after = await run(true)
  assert.ok(before > 0 && after > 0, '两边都要真的送出')
  assert.ok(after < before / 2, `越过应显著降低等待：before=${String(before)}ms after=${String(after)}ms`)
  console.log(`       click 等待：FIFO ${String(before)}ms → 分道 ${String(after)}ms`)
}])

cases.push(['背压：write 说 false 就停，resume() 之后才继续', async () => {
  const state = { pause: true, writes: 0, resume: null }
  const scheduler = createDownlinkScheduler({
    encode: async (t) => ({ frame: t, raw: true }),
    write: () => { state.writes += 1; return !state.pause },
    now: () => 0,
  })
  scheduler.push(small('A', 'one'), 1)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(state.writes, 1)
  scheduler.push(small('B', 'two'), 1)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(state.writes, 1, '被背压挡住，第二帧不能写')
  assert.equal(scheduler.paused(), true)
  state.pause = false
  scheduler.resume()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(state.writes, 2, 'drain 之后继续写')
}])

cases.push(['合并：同一 key 的 projection 只送最新值（计数 + 唯一性 end 帧不丢）', async () => {
  const { scheduler, state } = harness({ encodeMs: 5 })
  const proj = (tag) => JSON.stringify({ type: 'item', streamId: 's9', value: { type: 'projection', sessionId: 's9', key: 'activity', tag, seq: 1 } })
  scheduler.push(proj('v1'), 1)
  scheduler.push(proj('v2'), 1)
  scheduler.push(proj('v3'), 1)
  scheduler.push(JSON.stringify({ type: 'end', streamId: 's9' }), 1)
  await new Promise((r) => setTimeout(r, 40))
  const frames = state.writes.map((w) => JSON.parse(w.text))
  const pros = frames.filter((f) => f.value && f.value.type === 'projection')
  assert.equal(pros.length, 1, '三条同 key 状态帧合并成一条')
  assert.equal(pros[0].value.tag, 'v3', '留下的是最新值')
  assert.ok(frames.some((f) => f.type === 'end'), '唯一性的收尾帧必须送达')
  const snap = scheduler.snapshot()
  assert.ok(snap.coalesced >= 1)
}])

cases.push(['饥饿闸门：low 大帧等够时限就先按原顺序发（否则大帧自己永远发不出去）', async () => {
  const { scheduler, state } = harness()
  scheduler.push(big('A', 4000), 1)
  state.clock += 4500 // 模拟真实时间流逝
  scheduler.push(small('B', 'click'), 1)
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(state.writes.map((w) => JSON.parse(w.text).value?.tag ?? 'big'), ['big', 'click'],
    '等了够时限的大帧优先于新来的小帧')
  assert.ok(scheduler.snapshot().agedLow >= 1, '闸门生效要记账（手机端日志靠这一眼）')
}])

cases.push(['闸门回退（maxLowLaneWaitMs = 0）：仍然是原来的「小帧越过排队大帧」口径', async () => {
  const { scheduler, state } = harness({ limits: { maxLowLaneWaitMs: 0 } })
  scheduler.push(big('A', 4000), 1)
  state.clock += 4500
  scheduler.push(small('B', 'click'), 1)
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(state.writes.map((w) => JSON.parse(w.text).value?.tag ?? 'big'), ['click', 'big'])
  assert.equal(scheduler.snapshot().agedLow, 0)
}])

cases.push(['深队列放行预算：窗口里已放过东西时，下一条超大 low 帧被按住，且不丢、同流保序', async () => {
  const limits = { deepQueueBytes: 1000, lowLaneWindowBytes: 5000, lowLaneWindowMs: 1000, maxLowLaneWaitMs: 300 }
  const { scheduler, state } = harness({ limits })
  scheduler.push(big('A1', 4000), 1) // 窗口空 → 直接放过
  scheduler.push(big('A2', 4000), 1) // 窗口已用掉 4000 B + 4000 B > 预算 → 被按住
  await new Promise((r) => setTimeout(r, 30))
  let writes = state.writes.map((w) => JSON.parse(w.text).streamId)
  assert.deepEqual(writes, ['A1'], '预算用完的那条大帧这一轮不该进隧道')
  assert.ok(scheduler.snapshot().pacedEvents >= 1, '放行预算要记账')
  state.clock += 400 // 超过闸门时限
  scheduler.push(small('C', 'click'), 1)
  await new Promise((r) => setTimeout(r, 40))
  writes = state.writes.map((w) => JSON.parse(w.text).streamId)
  assert.deepEqual(writes, ['A1', 'A2', 'C'], '被按住的帧靠饥饿闸门兜底发出去，一条都没丢')
  const snap = scheduler.snapshot()
  assert.equal(snap.dropped, 0)
  assert.equal(snap.sent, snap.enqueued, '按住过的帧最终全部送达')
}])

cases.push(['预算回退（paceWhenDeep = false）：同样一串帧的先后与老口径一致、不记账', async () => {
  const limits = { deepQueueBytes: 1000, lowLaneWindowBytes: 5000, lowLaneWindowMs: 1000, maxLowLaneWaitMs: 300, paceWhenDeep: false }
  const { scheduler, state } = harness({ limits })
  scheduler.push(big('A1', 4000), 1)
  scheduler.push(big('A2', 4000), 1)
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(state.writes.map((w) => JSON.parse(w.text).streamId), ['A1', 'A2'],
    '关掉预算就是原样按队列顺序放行')
  assert.equal(scheduler.snapshot().pacedEvents, 0)
}])

cases.push(['close() 清掉唤醒定时器：关连接后不再排队、也不再往外写', async () => {
  const limits = { deepQueueBytes: 1000, lowLaneWindowBytes: 5000, lowLaneWindowMs: 1000, maxLowLaneWaitMs: 300 }
  const { scheduler, state } = harness({ limits })
  scheduler.push(big('A1', 4000), 1)
  scheduler.push(big('A2', 4000), 1) // 被按住 → 挂着一个唤醒定时器
  await new Promise((r) => setTimeout(r, 20))
  scheduler.close()
  state.clock += 1200
  scheduler.push(big('A3', 4000), 1)
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(state.writes.map((w) => JSON.parse(w.text).streamId), ['A1'], '关掉之后一条都不写')
  assert.equal(scheduler.snapshot().queuedBytes, 0)
}])

let failed = 0
for (const item of cases) {
  try { await item[1](); console.log('  ok   ' + item[0]) } catch (err) { failed += 1; console.log('  FAIL ' + item[0] + '\n       ' + (err && err.message ? err.message : String(err))) }
}
console.log(failed === 0 ? 'PASS ' + String(cases.length) + '/' + String(cases.length) : 'FAIL ' + String(failed) + '/' + String(cases.length))
process.exit(failed === 0 ? 0 : 1)
