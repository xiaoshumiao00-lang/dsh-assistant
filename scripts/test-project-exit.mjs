/**
 * 单测：项目 × 对话联动的「离开项目」判定（src/client/projectExit.ts）。
 *
 * 背景（实测根因）：DSH 0.2 起「当前会话」在 ui-workspace 的选择快照里，
 * sessions.list 不再带 current 字段；旧代码读 snap.current 恒为空串，
 * 于是「切到项目外的会话 → 自动收起项目」从未触发——长按悬浮球进私人助手时，
 * 论文写作模板项目的流程窗格 + 对话列一直留着（用户看到的「还在左右分屏」）。
 *
 * 运行：node scripts/test-project-exit.mjs
 */
import assert from 'node:assert/strict'
import { sessionLeavesProject } from '../src/client/projectExit.ts'

const FOLDER = 'D:\\陈潘HBEU\\论文\\论文写作模板'

const cases = []

cases.push(['还在打开项目时那条会话上 → 不算离开', () => {
  assert.equal(sessionLeavesProject({ sessionId: 's1', attached: 's1', folder: FOLDER, cwd: FOLDER }), false)
}])

cases.push(['切到项目绑定会话 → 不算离开（即便它在项目子目录里）', () => {
  assert.equal(sessionLeavesProject({
    sessionId: 's2', attached: 's1', bound: 's2', folder: FOLDER, cwd: FOLDER + '\\02-框架',
  }), false)
}])

cases.push(['模板项目内部各步会话互切 → 不算离开', () => {
  assert.equal(sessionLeavesProject({
    sessionId: 'step-07', attached: 'step-05', folder: FOLDER, cwd: FOLDER + '\\07-图精修',
  }), false)
}])

cases.push(['项目文件夹根目录的会话 → 不算离开', () => {
  assert.equal(sessionLeavesProject({ sessionId: 'root', attached: 'step-05', folder: FOLDER, cwd: FOLDER + '\\' }), false)
}])

cases.push(['私人助手会话（cwd = ~/.dsh/assistant）→ 离开项目', () => {
  assert.equal(sessionLeavesProject({
    sessionId: 'assistant-1', attached: 'step-05', folder: FOLDER, cwd: 'C:\\Users\\Administrator\\.dsh\\assistant',
  }), true)
}])

cases.push(['路径大小写 / 反斜杠混用仍按 Windows 规则命中', () => {
  assert.equal(sessionLeavesProject({
    sessionId: 'x', attached: 'step-05', folder: 'D:\\Paper\\Proj', cwd: 'd:/paper/proj/03-初稿',
  }), false)
}])

cases.push(['相似前缀不是子目录 → 离开项目', () => {
  assert.equal(sessionLeavesProject({
    sessionId: 'x', attached: 'step-05', folder: 'D:\\Paper\\Proj', cwd: 'D:\\Paper\\Proj2',
  }), true)
}])

cases.push(['会话刚建、列表行还没有 cwd → 视为离开项目（助手会话的时序）', () => {
  assert.equal(sessionLeavesProject({ sessionId: 'new', attached: 'step-05', folder: FOLDER, cwd: '' }), true)
}])

cases.push(['没有文件夹的普通项目 → 退回「是否还是 attached」', () => {
  assert.equal(sessionLeavesProject({ sessionId: 's9', attached: 's1', folder: '', cwd: '' }), true)
  assert.equal(sessionLeavesProject({ sessionId: 's1', attached: 's1', folder: '', cwd: '' }), false)
}])

cases.push(['内置控制室（isConsole）→ 切走即离开，但绑定会话仍不算离开', () => {
  assert.equal(sessionLeavesProject({ sessionId: 's3', attached: 's1', folder: 'D:\\x', cwd: 'D:\\x', isConsole: true }), true)
  assert.equal(sessionLeavesProject({ sessionId: 's1', attached: 's1', folder: '', cwd: '', isConsole: true }), false)
}])

cases.push(['空会话 id → 不关项目（没有可判定对象）', () => {
  assert.equal(sessionLeavesProject({ sessionId: '', attached: 's1', folder: FOLDER, cwd: '' }), false)
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
