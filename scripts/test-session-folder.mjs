/**
 * 单测：项目文件夹 → 会话归属判定（src/client/sessionFolder.ts）。
 * 卡片状态灯（绿/黄）与中间流式进度都依赖它，所以把边界固定下来：
 *   node scripts/test-session-folder.mjs
 */
import assert from 'node:assert/strict'
import { normalizeFolderPath, sessionsUnderFolder } from '../src/client/sessionFolder.ts'

const cases = []

cases.push(['规范化：混合分隔符 + 尾部斜杠', () => {
  assert.equal(normalizeFolderPath('D:\\a\\b\\'), 'D:/a/b')
  assert.equal(normalizeFolderPath('D:/a/b//'), 'D:/a/b')
  assert.equal(normalizeFolderPath(''), '')
  assert.equal(normalizeFolderPath(null), '')
}])

cases.push(['同目录 + 子目录命中，相似前缀不命中', () => {
  const byId = {
    a: { cwd: 'D:\\hpg' },
    b: { cwd: 'D:/hpg/09-报告' },
    c: { cwd: 'D:/hpg2' },          // 相似前缀：不是子目录
    d: { cwd: 'D:/other/hpg' },
  }
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual(sessionsUnderFolder(ids, byId, 'D:\\hpg'), ['a', 'b'])
}])

cases.push(['Windows 大小写不敏感（盘符/目录名）', () => {
  const byId = { a: { cwd: 'd:/HPG/Sub' } }
  assert.deepEqual(sessionsUnderFolder(['a'], byId, 'D:\\hpg'), ['a'])
}])

cases.push(['排除子代理会话（parentId / origin）', () => {
  const byId = {
    p: { cwd: 'D:/proj' },
    kid1: { cwd: 'D:/proj', parentId: 'p' },
    kid2: { cwd: 'D:/proj', origin: 'subagent' },
  }
  assert.deepEqual(sessionsUnderFolder(['p', 'kid1', 'kid2'], byId, 'D:/proj'), ['p'])
}])

cases.push(['排除无 cwd / 快照缺失的会话，保持原顺序', () => {
  const byId = {
    a: { cwd: 'D:/proj/b' },
    b: {},
    c: { cwd: 'D:/proj/a' },
  }
  assert.deepEqual(sessionsUnderFolder(['a', 'b', 'ghost', 'c'], byId, 'D:/proj'), ['a', 'c'])
}])

cases.push(['空目录基准 → 空结果（不误把全部会话算进项目）', () => {
  const byId = { a: { cwd: 'D:/x' } }
  assert.deepEqual(sessionsUnderFolder(['a'], byId, ''), [])
  assert.deepEqual(sessionsUnderFolder(['a'], byId, '   '), [])
  assert.deepEqual(sessionsUnderFolder(['a'], null, 'D:/x'), [])
}])

cases.push(['目录名本身以斜杠结尾的基准也能匹配根会话', () => {
  const byId = { a: { cwd: 'D:/proj' }, b: { cwd: 'D:/proj/x' } }
  assert.deepEqual(sessionsUnderFolder(['a', 'b'], byId, 'D:/proj/'), ['a', 'b'])
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
