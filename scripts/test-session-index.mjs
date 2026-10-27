/** 控制室共享会话索引回归：node scripts/test-session-index.mjs */
import assert from 'node:assert/strict'
import { sessionSnapshotIndexOf, invalidateSessionSnapshotIndex } from '../src/client/sessionIndex.ts'

const cases = []
const snapshot = () => ({
  ids: ['root', 'child', 'other', 'subagent'],
  byId: {
    root: { cwd: 'D:\\Work\\Project\\' },
    child: { cwd: 'D:/Work/Project', parentId: 'root' },
    other: { cwd: 'D:/Work/Project/09-报告' },
    subagent: { cwd: 'D:/Work/Project', origin: 'subagent' },
  },
  subagentsByParent: {
    root: [{ sessionId: 'remote-child' }],
    other: { entries: [{ id: 'other-child' }] },
  },
})

cases.push(['父子索引合并两种宿主来源并去重，目录索引排除子代理', () => {
  const index = sessionSnapshotIndexOf(snapshot())
  assert.deepEqual([...index.kidsByParent.get('root')].sort(), ['child', 'remote-child'])
  assert.deepEqual([...index.kidsByParent.get('other')], ['other-child'])
  assert.deepEqual(index.folderRows, [
    { id: 'root', key: 'd:/work/project' },
    { id: 'other', key: 'd:/work/project/09-报告' },
  ])
  assert.deepEqual(index.snapshotIds, ['root', 'child', 'other', 'subagent'])
}])

cases.push(['同一快照重复读取复用索引，新快照才自动重建', () => {
  const snap = snapshot()
  const first = sessionSnapshotIndexOf(snap)
  assert.equal(sessionSnapshotIndexOf(snap), first)
  const second = sessionSnapshotIndexOf(snapshot())
  assert.notEqual(second, first)
  assert.deepEqual(second.folderRows, first.folderRows)
}])

cases.push(['宿主原地修改同一快照时，通知前显式失效可强制重建', () => {
  const snap = snapshot()
  const first = sessionSnapshotIndexOf(snap)
  snap.byId.root.cwd = 'D:/Changed'
  snap.byId.added = { cwd: 'D:/Added', parentId: 'root' }
  snap.ids.push('added')
  assert.equal(sessionSnapshotIndexOf(snap), first)
  invalidateSessionSnapshotIndex()
  const next = sessionSnapshotIndexOf(snap)
  assert.notEqual(next, first)
  assert.equal(next.folderRows[0].key, 'd:/changed')
  assert.equal(next.kidsByParent.get('root').has('added'), true)
}])

cases.push(['缺失 ids / 空快照均可读，ids 缺失时回退 byId 键', () => {
  const empty = sessionSnapshotIndexOf(null)
  assert.equal(empty.folderRows.length, 0)
  assert.equal(empty.kidsByParent.size, 0)
  const index = sessionSnapshotIndexOf({ byId: { a: { cwd: 'D:/a' } } })
  assert.deepEqual(index.snapshotIds, ['a'])
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
