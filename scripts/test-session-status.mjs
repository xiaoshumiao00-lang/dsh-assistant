/** 控制室「等待提问」状态回归：node scripts/test-session-status.mjs */
import assert from 'node:assert/strict'
import { hasPendingInteraction, sessionStatusSourceOf, pendingInteractionSignature } from '../src/client/sessionStatus.ts'

const cases = []
const question = { kind: 'question', questions: [{ id: 'q1' }] }
const source = () => ({ getSnapshot() { return new Map() }, subscribe() { return () => {} } })

cases.push(['读取新版 uiSession.sessionStatus，而不是不存在的 pendingInteractions', () => {
  const sessionStatus = source()
  assert.equal(sessionStatusSourceOf({ sessionStatus }), sessionStatus)
  assert.equal(sessionStatusSourceOf({}), null)
}])

cases.push(['旧版 pendingInteractions 状态源仍兼容', () => {
  const pendingInteractions = source()
  assert.equal(sessionStatusSourceOf({ pendingInteractions }), pendingInteractions)
}])

cases.push(['运行中 + 等待提问 → 待决为真（控制室黄色优先于绿色）', () => {
  const map = new Map([['s1', { running: true, pendingInteraction: question }]])
  assert.equal(hasPendingInteraction(map, 's1'), true)
}])

cases.push(['sessionStatus 普通运行行有 Map 记录但 pendingInteraction 为空 → 不误判', () => {
  const map = new Map([
    ['busy', { running: true, pendingInteraction: undefined, completionUnread: false }],
    ['idle', { running: false, pendingInteraction: undefined, completionUnread: false }],
    ['done', { running: false, pendingInteraction: null, completionUnread: true }],
  ])
  assert.equal(hasPendingInteraction(map, 'busy'), false)
  assert.equal(hasPendingInteraction(map, 'idle'), false)
  assert.equal(hasPendingInteraction(map, 'done'), false)
}])

cases.push(['提问被回答后 pendingInteraction 清空 → 立即退出待决', () => {
  const row = { running: true, pendingInteraction: question }
  const map = new Map([['s1', row]])
  assert.equal(hasPendingInteraction(map, 's1'), true)
  row.pendingInteraction = undefined
  assert.equal(hasPendingInteraction(map, 's1'), false)
}])

cases.push(['旧版原始交互 Map / 缺失会话 / 异常 Map 均按各自语义处理', () => {
  assert.equal(hasPendingInteraction(new Map([['s1', question]]), 's1'), true)
  assert.equal(hasPendingInteraction(new Map(), 's1'), false)
  assert.equal(hasPendingInteraction(null, 's1'), false)
  assert.equal(hasPendingInteraction(new Map([['s1', question]]), undefined), false)
  assert.equal(hasPendingInteraction({ get() { throw new Error('broken') } }, 's1'), false)
}])

cases.push(['待决签名只看待决集合：running 字段与 Map 顺序变化不触发重绘', () => {
  const a = new Map([
    ['s1', { running: false, pendingInteraction: question }],
    ['s2', { running: false, pendingInteraction: null }],
  ])
  const b = new Map([
    ['s2', { running: true, pendingInteraction: undefined }],
    ['s1', { running: true, pendingInteraction: question }],
  ])
  assert.equal(pendingInteractionSignature(a), 's1')
  assert.equal(pendingInteractionSignature(a), pendingInteractionSignature(b))
}])

cases.push(['待决签名在提问新增 / 回答清除时变化，兼容旧版原始交互 Map', () => {
  const pending = new Map([['s1', { running: true, pendingInteraction: question }]])
  const before = pendingInteractionSignature(pending)
  pending.set('s2', { running: true, pendingInteraction: question })
  assert.notEqual(pendingInteractionSignature(pending), before)
  pending.get('s1').pendingInteraction = null
  pending.get('s2').pendingInteraction = undefined
  assert.equal(pendingInteractionSignature(pending), '')
  assert.equal(pendingInteractionSignature(new Map([['legacy', question]])), 'legacy')
  assert.equal(pendingInteractionSignature(null), '')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL ' + name + '\n       ' + String((err && err.message) || err))
  }
}
console.log('')
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAILED ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
