/** 控制室项目卡「进入项目」语义回归：node scripts/test-split-entry.mjs */
import assert from 'node:assert/strict'
import { splitOpenIntent } from '../src/client/splitEntry.ts'

const cases = []

cases.push(['没有打开任何项目 → 打开目标项目', () => {
  assert.equal(splitOpenIntent(null, 'p1', true), 'open')
  assert.equal(splitOpenIntent(null, 'p1', false), 'open')
}])

cases.push(['打开的是别的项目 → 打开目标项目（替换当前工作区）', () => {
  assert.equal(splitOpenIntent('p2', 'p1', true), 'open')
  assert.equal(splitOpenIntent('p2', 'p1', false), 'open')
}])

cases.push(['控制室卡片点已打开的项目 → 保持打开（不能再反选关闭）', () => {
  assert.equal(splitOpenIntent('p1', 'p1', true), 'keep')
}])

cases.push(['可见的侧栏卡片点已打开的项目 → 仍按原交互反选关闭', () => {
  assert.equal(splitOpenIntent('p1', 'p1', false), 'toggle')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (err instanceof Error ? err.message : String(err)))
  }
}
console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ' ' + (cases.length - failed) + '/' + cases.length)
if (failed > 0) process.exit(1)
