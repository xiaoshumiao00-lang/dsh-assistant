/** 记忆面板的写回逻辑回归：node scripts/test-assistant-memory.mjs */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const assistant = await import('../lib/index.js')
const memory = assistant.assistantMemoryTestSurface

const cases = []

cases.push(['投影按单独一行 `§` 拆条目（多行条目也能拆开）', () => {
  const entries = memory.splitEntries('第一条\n继续一行\n§\n第二条\n§\n\n第三条')
  assert.equal(entries.length, 3)
  assert.equal(entries[0].content, '第一条\n继续一行')
  assert.equal(entries[2].content, '第三条')
  assert.equal(entries.map((e) => e.index).join(','), '0,1,2')
  assert.equal(memory.joinEntries(entries.slice(1)), '第二条\n§\n第三条')
}])

cases.push(['没有 memories.json：readRuntimeMemory 报不可写，删除返回原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-memory-empty-'))
  process.env.MNEMON_DATA_DIR = dir
  try {
    const view = memory.readRuntimeMemory()
    assert.equal(view.dir, dir)
    assert.equal(view.writable, false, '没有真源就是不可写')
    assert.ok(view.note.includes('memories.json'))
    assert.equal(view.targets.length, 2)
    assert.deepEqual(view.targets[0].entries, [])
    const result = memory.deleteRuntimeMemoryEntry('memory', 'x')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'store-unavailable')
  } finally {
    delete process.env.MNEMON_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
}])

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-memory-'))
  process.env.MNEMON_DATA_DIR = dir
  writeFileSync(join(dir, 'USER.md'), '他是谁\n§\n他的雷区', 'utf8')
  writeFileSync(join(dir, 'MEMORY.md'), '硬事实A\n§\n硬事实B', 'utf8')
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({
    version: 1,
    entries: [
      { content: '他是谁', target: 'user', importance: 'critical' },
      { content: '他的雷区', target: 'user' },
      { content: '硬事实A', target: 'memory', importance: 'normal', updated_at: '2026-10-01T00:00:00.000Z' },
      { content: '硬事实B', target: 'memory', branches: ['main'] },
    ],
  }), 'utf8')
  return dir
}

cases.push(['删除一条：真源少一条、投影同步、user 侧不动、备份写出来', () => {
  const dir = seed()
  try {
    const result = memory.deleteRuntimeMemoryEntry('memory', '硬事实A', 'exact')
    assert.equal(result.ok, true)
    assert.equal(result.storeRemoved, 1)
    assert.equal(result.projectionRemoved, 1)
    assert.equal(result.restartRequired, true, '必须报告要重启')
    assert.ok(result.backups.length >= 2, `备份：${result.backups.length}`)
    const store = JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8'))
    assert.equal(store.entries.length, 3)
    assert.ok(store.entries.every((item) => item.content !== '硬事实A'))
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').trim(), '硬事实B')
    assert.equal(readFileSync(join(dir, 'USER.md'), 'utf8'), '他是谁\n§\n他的雷区', 'user 侧不许动')
    assert.ok(existsSync(result.backups[0]), '备份文件真在盘上')
  } finally {
    delete process.env.MNEMON_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['删除不上的（别的 target / 模糊内容）一律 no-match，不写盘', () => {
  const dir = seed()
  try {
    const before = readFileSync(join(dir, 'memories.json'), 'utf8')
    assert.equal(memory.deleteRuntimeMemoryEntry('user', '硬事实A').error, 'no-match')
    assert.equal(memory.deleteRuntimeMemoryEntry('memory', '硬事实C').error, 'no-match')
    assert.equal(memory.deleteRuntimeMemoryEntry('memory', '').error, 'empty-content')
    assert.equal(readFileSync(join(dir, 'memories.json'), 'utf8'), before, '失败时文件一点没动')
  } finally {
    delete process.env.MNEMON_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['contains 模式：一条里含片段即整条删（不是只删片段）', () => {
  const dir = seed()
  try {
    const result = memory.deleteRuntimeMemoryEntry('memory', '硬事实', 'contains')
    assert.equal(result.ok, true)
    assert.equal(result.storeRemoved, 2)
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '')
  } finally {
    delete process.env.MNEMON_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['清空只清 target 那一侧，另一侧完整保留', () => {
  const dir = seed()
  try {
    const result = memory.clearRuntimeMemory('memory')
    assert.equal(result.ok, true)
    assert.equal(result.storeRemoved, 2)
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '')
    const store = JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8'))
    assert.equal(store.entries.length, 2)
    assert.ok(store.entries.every((item) => item.target === 'user'))
    assert.equal(readFileSync(join(dir, 'USER.md'), 'utf8'), '他是谁\n§\n他的雷区')
    assert.equal(memory.clearRuntimeMemory('user').ok, true, '再清 user 侧')
    assert.equal(readFileSync(join(dir, 'USER.md'), 'utf8'), '')
    assert.equal(memory.clearRuntimeMemory('user').error, 'no-match', '已经空了就是 no-match')
  } finally {
    delete process.env.MNEMON_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['readRuntimeMemory 把真源元数据挂到条目上（面板显示 [importance] / 分支 / 改于）', () => {
  const dir = seed()
  try {
    const view = memory.readRuntimeMemory()
    const memoryTarget = view.targets.find((item) => item.target === 'memory')
    assert.equal(memoryTarget.entries[0].importance, 'normal')
    assert.equal(memoryTarget.entries[0].updated_at, '2026-10-01T00:00:00.000Z')
    assert.deepEqual(memoryTarget.entries[1].branches, ['main'])
    assert.equal(view.totalEntries, 4)
    assert.equal(view.writable, true)
  } finally {
    delete process.env.MNEMON_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : err))
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
