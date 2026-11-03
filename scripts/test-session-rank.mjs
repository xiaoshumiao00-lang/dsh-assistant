/** 会话活跃度排序与「点卡片进入哪条会话」回归：node scripts/test-session-rank.mjs */
import assert from 'node:assert/strict'
import { sessionTierOf, sessionLastAt, sortSessionsByActivity, pickActiveSession, pickLatestSession, pickEnterSession, progressOrderOf } from '../src/client/sessionRank.ts'

const cases = []

/** 与调用方一致的最小行形状：只带排序/挑选用到的字段 */
const row = (id, extra) => ({ id, updatedAt: 0, ...extra })

cases.push(['待决策档排在正在跑之前（黄 > 蓝）', () => {
  assert.equal(sessionTierOf({ awaiting: true, running: true }), 0)
  assert.equal(sessionTierOf({ running: true }), 1)
  assert.equal(sessionTierOf({ error: true }), 2)
  assert.equal(sessionTierOf({}), 3)
  assert.equal(sessionTierOf({ running: true, archived: true }), 4)
  assert.ok(sessionTierOf({ awaiting: true }) < sessionTierOf({ running: true }), '档位顺序')
  assert.ok(sessionTierOf({}) < sessionTierOf({ archived: true }), '已归档排最后')
}])

cases.push(['卡片进入优先选「正在跑」的会话，哪怕刚结束的那条提示词更新', () => {
  // 复刻用户场景：最新一条已跑完（updatedAt 更晚），第二条还在跑（updatedAt 更早）
  const rows = [row('finished', { updatedAt: 500 }), row('running', { updatedAt: 400, running: true })]
  assert.equal(pickActiveSession(rows)?.id, 'running', '应进入正在跑的会话')
}])

cases.push(['多条同时在跑时取最近有活动的那条；同档按 updatedAt 倒序', () => {
  const rows = [
    row('old', { updatedAt: 100, running: true }),
    row('live', { updatedAt: 300, running: true }),
    row('mid', { updatedAt: 200, running: true }),
  ]
  assert.equal(pickActiveSession(rows)?.id, 'live')
}])

cases.push(['当前会话已在活跃档里时保持不变（点卡片不该把人踢走）', () => {
  const rows = [
    row('live', { updatedAt: 100, running: true }),
    row('fresher', { updatedAt: 300, running: true }),
  ]
  assert.equal(pickActiveSession(rows, 'live')?.id, 'live')
  // 当前会话不在这一档时仍按活跃度换
  assert.equal(pickActiveSession(rows, 'other')?.id, 'fresher')
}])

cases.push(['待决策档整档优先于在跑档（即使在跑的那条更新）', () => {
  const rows = [
    row('run', { updatedAt: 900, running: true }),
    row('need', { updatedAt: 100, awaiting: true }),
  ]
  assert.equal(pickActiveSession(rows)?.id, 'need')
  assert.equal(pickActiveSession(rows, 'run')?.id, 'need', '整档优先：当前会话在跑、但有会话在等你回答 → 进待决策那条')
  assert.equal(pickActiveSession([{ id: 'run', updatedAt: 900, running: true, awaiting: true }, row('other', { updatedAt: 999 })], 'run')?.id, 'run', '当前会话就在待决档内 → 保持')
}])

cases.push(['没有进行中的会话时返回 null（调用方走最新步骤 / 最近更新兜底）', () => {
  const rows = [row('done', { updatedAt: 500 }), row('idle', { updatedAt: 100 })]
  assert.equal(pickActiveSession(rows), null)
  assert.equal(pickActiveSession([row('arched', { updatedAt: 900, running: true, archived: true })]), null, '已归档的不算在跑')
}])

cases.push(['活跃档内不抢置顶：置顶会话不在跑时仍在跑的优先', () => {
  const rows = [row('pin', { updatedAt: 900, pinned: true }), row('run', { updatedAt: 100, running: true })]
  assert.equal(pickActiveSession(rows)?.id, 'run')
}])

cases.push(['会话列表排序：置顶 > 待决策 > 在跑 > 异常 > 空闲(最近更新倒序)', () => {
  const rows = [
    row('idleNew', { updatedAt: 400 }),
    row('idleOld', { updatedAt: 100 }),
    row('err', { updatedAt: 200, error: true }),
    row('run', { updatedAt: 150, running: true }),
    row('need', { updatedAt: 120, awaiting: true }),
    row('pinIdle', { updatedAt: 1, pinned: true }),
    row('archived', { updatedAt: 999, archived: true }),
  ]
  assert.deepEqual(sortSessionsByActivity(rows).map((r) => r.id), [
    'pinIdle', 'need', 'run', 'err', 'idleNew', 'idleOld', 'archived',
  ])
}])

cases.push(['同档同时间时用相对目录与 id 做稳定兜底', () => {
  const rows = [row('b', { updatedAt: 10, rel: '09-翻译' }), row('a', { updatedAt: 10, rel: '' })]
  assert.deepEqual(sortSessionsByActivity(rows).map((r) => r.id), ['a', 'b'])
  assert.deepEqual(sortSessionsByActivity([row('b'), row('a')]).map((r) => r.id), ['a', 'b'])
}])

cases.push(['排序不改动调用方传入的数组（返回副本）', () => {
  const rows = [row('a', { updatedAt: 1 }), row('b', { updatedAt: 2 })]
  const sorted = sortSessionsByActivity(rows)
  assert.equal(rows[0].id, 'a')
  assert.equal(sorted[0].id, 'b')
  assert.notEqual(sorted, rows)
}])

cases.push(['卡片进度顺序：优先级最高那条排第一（含子代理），再按绑定/步骤/其余往下', () => {
  // 用户要求：不要「只有静止的正在执行」，要按会话优先级显示**优先级最高那条的最新消息**。
  const order = progressOrderOf({
    enteredPick: 'A',
    kidsOf: (sid) => (sid === 'A' ? ['A-kid'] : []),
    bound: 'B',
    steps: ['B-step'],
    candidates: ['A', 'B', 'C'],
  })
  assert.deepEqual(order, ['A', 'A-kid', 'B', 'B-step', 'C'], '去重且保持优先级顺序')
}])

cases.push(['其余关联会话的顺序完全由调用方（活跃度排序）决定，不再有第二个判据', () => {
  const ranked = sortSessionsByActivity([
    { id: 'old', updatedAt: 10 },
    { id: 'busy', updatedAt: 5, running: true },
    { id: 'need', updatedAt: 1, awaiting: true },
  ]).map((r) => r.id)
  const order = progressOrderOf({ enteredPick: 'need', kidsOf: () => [], candidates: ranked })
  assert.deepEqual(order, ['need', 'busy', 'old'])
}])

cases.push(['没有进行中的会话时从绑定会话起头；kidsOf 省掉也不炸', () => {
  assert.deepEqual(progressOrderOf({ enteredPick: null, bound: 'B', steps: [], candidates: ['C'] }), ['B', 'C'])
  assert.deepEqual(progressOrderOf({ enteredPick: 'A' }), ['A'])
  assert.deepEqual(progressOrderOf({ enteredPick: '', bound: null }), [])
}])

cases.push(['最后活动时间 = max(updatedAt, lastAt)：长任务跑完那一刻宿主 updatedAt 不前进', () => {
  // 宿主的 updatedAt 只有人工提示才前进；一轮跑了很久才结束时它还是很早的值。
  assert.equal(sessionLastAt({ updatedAt: 100, lastAt: 900 }), 900)
  assert.equal(sessionLastAt({ updatedAt: 900 }), 900)
  assert.equal(sessionLastAt({ updatedAt: 900, lastAt: 100 }), 900)
  assert.equal(sessionLastAt({}), 0)
}])

cases.push(['任务全部完成：进入「最后跑完」的那条，而不是「提示词更晚、其实更早结束」的旧会话', () => {
  // 复刻用户报的场景：A 10:00 发提示、跑了很久 22:00 才结束（updatedAt 仍 10:00）；
  // B 11:00 发过一句、11:05 就结束了（updatedAt 11:00 更晚）。三条都已完成（无在跑/待决）。
  const rows = [
    row('justFinished', { updatedAt: 1000, lastAt: 2200 }),
    row('olderChat', { updatedAt: 1100, lastAt: 1105 }),
  ]
  assert.equal(pickEnterSession(rows)?.id, 'justFinished', '应按真实活动时间')
  assert.deepEqual(sortSessionsByActivity(rows).map((r) => r.id), ['justFinished', 'olderChat'])
}])

cases.push(['点卡片不抬置顶：很早以前置顶的旧会话不许压住刚跑完的那条', () => {
  const rows = [
    row('pinnedOld', { updatedAt: 100, lastAt: 100, pinned: true }),
    row('justFinished', { updatedAt: 500, lastAt: 900 }),
  ]
  assert.equal(pickLatestSession(rows)?.id, 'justFinished', '进入判定按最后活动')
  assert.equal(pickEnterSession(rows)?.id, 'justFinished')
  // 「会话列表」浮层仍按置顶排第一（那是列表位置，不是进入判定）
  assert.equal(sortSessionsByActivity(rows)[0].id, 'pinnedOld')
}])

cases.push(['进入判定：有进行中的会话时仍按「待决 > 在跑」，空闲新旧不参与比较', () => {
  const rows = [
    row('idleFresh', { updatedAt: 5000, lastAt: 5000 }),
    row('running', { updatedAt: 1000, lastAt: 1200, running: true }),
  ]
  assert.equal(pickEnterSession(rows)?.id, 'running')
  const withNeed = [...rows, row('need', { updatedAt: 10, lastAt: 10, awaiting: true })]
  assert.equal(pickEnterSession(withNeed)?.id, 'need')
}])

cases.push(['一条可用会话都没有时 pickEnterSession 返回 null（调用方走模板步骤 / 绑定兜底）', () => {
  assert.equal(pickEnterSession([]), null)
  assert.equal(pickLatestSession([]), null)
  assert.equal(pickEnterSession([row('arched', { updatedAt: 999, archived: true })]), null, '归档的不参与进入判定')
  // 当前会话不在活跃档时不影响空闲兜底
  assert.equal(pickEnterSession([row('a', { updatedAt: 10, lastAt: 10 }), row('b', { updatedAt: 20 })], 'a')?.id, 'b')
}])

/** 参考实现：旧版「比较器里现算」的写法，原样留在这里当对照（顺序必须逐条一致）。 */
function referenceSort(rows, options = {}) {
  const pinnedFirst = options.pinnedFirst !== false
  const list = rows.slice()
  list.sort((a, b) => {
    if (pinnedFirst && !!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    const tier = sessionTierOf(a) - sessionTierOf(b)
    if (tier) return tier
    const at = sessionLastAt(b) - sessionLastAt(a)
    if (at) return at
    const relA = a.rel ?? ''
    const relB = b.rel ?? ''
    if (relA !== relB) return relA < relB ? -1 : 1
    return String(a.id).localeCompare(String(b.id))
  })
  return list
}

/** 参考实现：旧版「includes 判重」的进度顺序。 */
function referenceProgressOrder(options) {
  const order = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !order.includes(value)) order.push(value)
  }
  if (options.enteredPick !== null) {
    push(options.enteredPick)
    if (options.kidsOf !== undefined) for (const kid of options.kidsOf(options.enteredPick)) push(kid)
  }
  push(options.bound)
  for (const sid of options.steps ?? []) push(sid)
  for (const sid of options.candidates ?? []) push(sid)
  return order
}

cases.push(['排序与旧实现逐条等价（200 条混合：置顶 / 各档 / lastAt 交错 / 同 rel / 同名 id）', () => {
  // 固定种子的伪随机：可复现，不是每次跑都不一样
  let seed = 20261103
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const pick = (list) => list[Math.floor(rnd() * list.length) % list.length]
  const ids = ['a', 'A', 'b10', 'b9', '会话', 'x-1', 'x-10', 'x-2']
  const rels = [undefined, '', '01', '02', '10', 'A', 'a']
  const rows = []
  for (let i = 0; i < 200; i += 1) {
    rows.push({
      id: `${pick(ids)}-${i % 7}`,
      updatedAt: pick([0, 100, 200, 300, 1000]),
      lastAt: pick([0, 50, 150, 400, 900]),
      awaiting: rnd() < 0.12,
      running: rnd() < 0.2,
      error: rnd() < 0.1,
      pinned: rnd() < 0.15,
      archived: rnd() < 0.05,
      rel: pick(rels),
    })
  }
  const expected = referenceSort(rows).map((r) => r.id + '|' + (r.rel ?? ''))
  const actual = sortSessionsByActivity(rows).map((r) => r.id + '|' + (r.rel ?? ''))
  assert.deepEqual(actual, expected, '排序结果必须与旧实现完全一致')
  const expectedNoPin = referenceSort(rows, { pinnedFirst: false }).map((r) => r.id)
  const actualNoPin = sortSessionsByActivity(rows, { pinnedFirst: false }).map((r) => r.id)
  assert.deepEqual(actualNoPin, expectedNoPin, '不抬置顶时也要一致')
}])

cases.push(['排序键每行只算一次（不再在比较器里重复读 updatedAt / lastAt）', () => {
  const meta = []
  const rows = Array.from({ length: 60 }, (_, i) => {
    const counts = { updatedAt: 0, lastAt: 0 }
    meta.push(counts)
    const target = {
      id: `s${i}`,
      updatedAt: i * 10,
      lastAt: i % 3 === 0 ? i * 30 : 0,
      running: i % 4 === 0,
      error: i % 7 === 0,
      pinned: i % 11 === 0,
      rel: i % 5 === 0 ? '01' : '',
    }
    return new Proxy(target, {
      get(obj, prop) {
        if (prop === 'updatedAt' || prop === 'lastAt') counts[prop] += 1
        return obj[prop]
      },
    })
  })
  sortSessionsByActivity(rows)
  const worst = Math.max(...meta.map((c) => c.updatedAt + c.lastAt))
  assert.ok(worst <= 4, `每行最多读 4 次（新实现 = 1 次 updatedAt + 1 次 lastAt），实测 ${worst}`)
}])

cases.push(['进度顺序去重与旧实现一致（重复 id 散布在子代理 / 绑定 / 步骤 / 候选里）', () => {
  const casesIn = [
    { enteredPick: 'a', kidsOf: () => ['a', 'k1', 'k1', ''], bound: 'a', steps: ['s1', 'a', 's1'], candidates: ['c1', 'k1', 'c1', '', 's2'] },
    { enteredPick: null, kidsOf: () => ['x'], bound: null, steps: [], candidates: ['y', 'z', 'y'] },
    { enteredPick: '', bound: '', steps: ['', ''], candidates: [] },
  ]
  for (const input of casesIn) {
    assert.deepEqual(progressOrderOf(input), referenceProgressOrder(input))
  }
  // 规模版：2,000 候选 + 500 重复（旧的 includes 写法在手机上是 O(n²)，这里只验证结果一致）
  const big = []
  for (let i = 0; i < 2000; i += 1) big.push(`s${i}`)
  for (let i = 0; i < 500; i += 1) big.push(`s${i}`)
  const args = { enteredPick: 's0', kidsOf: () => ['s1', 's1'], bound: 's2', steps: ['s3', 's0'], candidates: big }
  const expected = referenceProgressOrder(args)
  const actual = progressOrderOf(args)
  assert.deepEqual(actual, expected)
  assert.equal(actual.length, 2000, '去重后应等于候选并集（2,000 条）')
  assert.equal(new Set(actual).size, actual.length, '没有重复')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : String(err)))
  }
}
console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ' ' + cases.length + '/' + cases.length)
if (failed > 0) process.exit(1)
