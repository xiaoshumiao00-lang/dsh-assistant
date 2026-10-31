/** 会话活跃度排序与「点卡片进入哪条会话」回归：node scripts/test-session-rank.mjs */
import assert from 'node:assert/strict'
import { sessionTierOf, sortSessionsByActivity, pickActiveSession } from '../src/client/sessionRank.ts'

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
