/** 会话列表浮层的空白/归档过滤回归：node scripts/test-session-list-filter.mjs */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { archivableBlankRows, sessionRowVisible, sessionRowsVisible, looksBlankWithoutFlag } from '../src/client/sessionFolder.ts'

const cases = []
const test = (name, fn) => cases.push([name, fn])

// 1. 默认：藏空白、藏归档；当前那条空白照常留着（否则高亮会指到不存在的行）
test('默认过滤：空白与归档都不显示，当前会话例外', () => {
  const rows = [
    { id: 'real', blank: false },
    { id: 'blank', blank: true },
    { id: 'blankCur', blank: true, current: true },
    { id: 'arch', blank: false, archived: true },
    { id: 'archBlank', blank: true, archived: true },
  ]
  assert.deepEqual(sessionRowsVisible(rows, { showArchived: false, showBlank: false }).map((r) => r.id), ['real', 'blankCur'])
})

// 2. 两个开关各自独立：只开空白 → 归档仍藏
test('只显示空白（归档仍藏）', () => {
  const rows = [{ id: 'a', blank: true }, { id: 'b', blank: false, archived: true }]
  assert.deepEqual(sessionRowsVisible(rows, { showArchived: false, showBlank: true }).map((r) => r.id), ['a'])
  assert.deepEqual(sessionRowsVisible(rows, { showArchived: true, showBlank: false }).map((r) => r.id), ['b'])
  assert.deepEqual(sessionRowsVisible(rows, { showArchived: true, showBlank: true }).map((r) => r.id), ['a', 'b'])
})

// 3. 纯函数入口与组件里的调用同一口径（sessionRowVisible 单行判定）
test('sessionRowVisible 单行判定', () => {
  assert.equal(sessionRowVisible({ blank: true }, { showArchived: false, showBlank: false }), false)
  assert.equal(sessionRowVisible({ blank: false }, { showArchived: false, showBlank: false }), true)
  assert.equal(sessionRowVisible({ blank: true, archived: true }, { showArchived: true, showBlank: false }), true)
})

// 4. 老宿主兜底判据：没标题 / 标题就是会话 id / 标题就是目录末段名 → 算空白
test('looksBlankWithoutFlag 兜底判据', () => {
  const A = 'assistant'
  assert.equal(looksBlankWithoutFlag({ title: '', id: 'x1', cwd: `C:/Users/me/.dsh/${A}` }), true)
  assert.equal(looksBlankWithoutFlag({ title: 'x1', id: 'x1', cwd: `C:/Users/me/.dsh/${A}` }), true)
  assert.equal(looksBlankWithoutFlag({ title: 'x1-占位', id: 'x1', cwd: `C:/Users/me/.dsh/${A}` }), true)
  assert.equal(looksBlankWithoutFlag({ title: A, id: 'x1', cwd: `C:\\Users\\me\\.dsh\\${A}` }), true)
  assert.equal(looksBlankWithoutFlag({ title: '个人助手移动端卡顿优化', id: 'x1', cwd: `C:/Users/me/.dsh/${A}` }), false)
  assert.equal(looksBlankWithoutFlag({ title: 'assistant', id: 'x1', cwd: 'D:/paper/01-选题', }), false)
})

// 5. 兜底判据不许误伤：在跑 / 置顶 / 归档的会话一律不算空白
test('兜底判据的护栏', () => {
  assert.equal(looksBlankWithoutFlag({ title: 'assistant', id: 'x1', cwd: 'C:/x/assistant', running: true }), false)
  assert.equal(looksBlankWithoutFlag({ title: 'assistant', id: 'x1', cwd: 'C:/x/assistant', pinned: true }), false)
  assert.equal(looksBlankWithoutFlag({ title: 'assistant', id: 'x1', cwd: 'C:/x/assistant', archived: true }), false)
  assert.equal(looksBlankWithoutFlag({ title: '', id: '', cwd: '' }), true)
})

// 6. 组件确实按这套过滤渲染（源码口径回归，防止以后改动把开关丢掉）
test('split.tsx 的浮层用到 sessionRowsVisible 与空白开关', () => {
  const text = readFileSync(new URL('../src/client/split.tsx', import.meta.url), 'utf8')
  assert.ok(/sessShowBlank/.test(text), '空白开关没接进浮层')
  assert.ok(/sessVisibleRows\.length/.test(text), '计数用的是可见行')
  assert.ok(/sessVisibleRows\.map/.test(text), '列表渲染用的是可见行')
  assert.ok(/sessionRowsVisible\(sessPop\.items/.test(text), '浮层没用 sessionRowsVisible')
  assert.ok(/console\.showBlank/.test(text), '底部缺「显示空白会话」按钮')
  const idx = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.ok(/looksBlankWithoutFlag/.test(idx), '宿主 blank 投影缺失时没有兜底判据')
})

// 7. 「一键归档」的候选口径与显示口径同一套判据：空白、未归档、未置顶、不在跑、不是当前会话
test('archivableBlankRows 只收可归档的空白行', () => {
  const rows = [
    { id: 'blankArch', blank: true, archived: true },
    { id: 'blankPinned', blank: true, pinned: true },
    { id: 'blankCurrent', blank: true, current: true },
    { id: 'blankRunning', blank: true, running: true },
    { id: 'blankOk', blank: true },
    { id: 'real', blank: false },
  ]
  assert.deepEqual(archivableBlankRows(rows).map((r) => r.id), ['blankOk'])
})

// 8. 浮层确实装了「归档空白会话」按钮，且走的是 index.tsx 那个批量归档入口
test('split.tsx + index.tsx 的批量归档按钮接好了', () => {
  const text = readFileSync(new URL('../src/client/split.tsx', import.meta.url), 'utf8')
  assert.ok(/archivableBlankRows\(sessPop\.items\)/.test(text), '浮层没算可归档的空白条数')
  assert.ok(/console\.archiveBlanks/.test(text), '底部缺「归档空白会话」按钮')
  assert.ok(/onArchiveBlankSessions\?:/.test(text), '浮层没有声明这个桥')
  const idx = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.ok(/onArchiveBlankSessions: \(pid\) => archiveBlankProjectSessions\(pid\)/.test(idx), '桥没接到实现')
  assert.ok(/const archiveBlankProjectSessions = async \(pid: string\)/.test(idx), '实现没定义')
  assert.ok(/archivableBlankRows\(projectSessionsOf\(pid\)\)/.test(idx), '实现没用同一套候选口径')
  const loc = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  for (const key of ['console.archiveBlanks', 'console.archiveBlanksConfirm', 'console.archiveBlanksRunning', 'console.archiveBlanksTip']) {
    assert.equal((loc.match(new RegExp("'" + key + "'", 'g')) ?? []).length, 2, key + ' 缺中英两份')
  }
})

let failed = 0
for (const [name, fn] of cases) {
  try { fn(); console.log('ok  ' + name) }
  catch (err) { failed++; console.error('FAIL ' + name + ' :: ' + (err?.stack ?? err)) }
}
console.log(`\nsession-list-filter: ${cases.length - failed}/${cases.length} 通过`)
if (failed > 0) process.exit(1)
