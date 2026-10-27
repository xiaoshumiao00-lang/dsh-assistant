/**
 * 单测：项目文件夹 → 会话归属判定（src/client/sessionFolder.ts）。
 * 卡片状态灯（绿/黄）与中间流式进度都依赖它，所以把边界固定下来：
 *   node scripts/test-session-folder.mjs
 */
import assert from 'node:assert/strict'
import { normalizeFolderPath, sessionsUnderFolder, unownedSessionIds, transientVisibility } from '../src/client/sessionFolder.ts'

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

cases.push(['游离会话：只保留不在任何项目文件夹里的根会话', () => {
  const byId = {
    a: { cwd: 'D:/proj' },                 // 项目根
    b: { cwd: 'D:/proj/09-报告' },          // 项目子目录
    c: { cwd: 'D:/scratch' },               // 另一个目录 → 游离
    d: { cwd: 'D:/proj2' },                 // 相似前缀，不是子目录 → 游离
    e: { cwd: 'd:/SCRATCH/sub' },           // 大小写不同也算另一个目录 → 游离
  }
  assert.deepEqual(unownedSessionIds(['a', 'b', 'c', 'd', 'e'], byId, ['D:\\proj'], []), ['c', 'd', 'e'])
}])

cases.push(['游离会话：排除绑定 / 模板步骤 / 归档 / 子代理 / 无 cwd', () => {
  const byId = {
    bound: { cwd: 'D:/scratch' },
    step: { cwd: 'D:/scratch' },
    archived: { cwd: 'D:/scratch' },
    kid1: { cwd: 'D:/scratch', parentId: 'root' },
    kid2: { cwd: 'D:/scratch', origin: 'subagent' },
    nocwd: {},
    live: { cwd: 'D:/scratch' },
    root: { cwd: 'D:/scratch' },
  }
  const ids = ['bound', 'step', 'archived', 'kid1', 'kid2', 'nocwd', 'live', 'root']
  assert.deepEqual(
    unownedSessionIds(ids, byId, ['D:/proj'], ['bound', 'step'], ['archived']),
    ['live', 'root'],
  )
}])

cases.push(['游离会话：没有项目文件夹时全部根会话都游离，但子代理仍排除', () => {
  const byId = {
    a: { cwd: 'D:/a' },
    b: { cwd: 'D:/b' },
    kid: { cwd: 'D:/a', parentId: 'a' },
  }
  assert.deepEqual(unownedSessionIds(['a', 'b', 'kid'], byId, [], []), ['a', 'b'])
  assert.deepEqual(unownedSessionIds(['a', 'b'], null, ['D:/a'], []), [])
}])

// ── 临时卡片「正在运行」的可见性策略 ──
const DONE_FALLBACK = 30 * 60 * 1000
const ERROR_FALLBACK = 12 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const vis = (patch = {}) => transientVisibility({
  running: false,
  awaiting: false,
  done: true,
  error: false,
  blank: false,
  updatedAt: 0,
  observedFinishedAt: 0,
  dismissedAt: 0,
  now: NOW,
  doneFallbackMs: DONE_FALLBACK,
  errorFallbackMs: ERROR_FALLBACK,
  ...patch,
})

cases.push(['临时卡片：运行中 / 等决策 → 常驻（收工也不压住新一轮）', () => {
  assert.deepEqual(vis({ running: true }), { show: true, finished: false, finishedAt: 0 })
  assert.deepEqual(vis({ running: true, awaiting: true, dismissedAt: NOW }), { show: true, finished: false, finishedAt: 0 })
  assert.deepEqual(vis({ awaiting: true }), { show: true, finished: false, finishedAt: 0 })
}])

cases.push(['临时卡片：完成后一直保留，不按时间过期', () => {
  assert.deepEqual(vis({ observedFinishedAt: NOW - 10 * 60_000 }), { show: true, finished: true, finishedAt: NOW - 10 * 60_000 })
  assert.deepEqual(vis({ observedFinishedAt: NOW - 31 * 60_000 }), { show: true, finished: true, finishedAt: NOW - 31 * 60_000 })
  assert.deepEqual(vis({ observedFinishedAt: NOW - 365 * 24 * 3600_000 }), {
    show: true, finished: true, finishedAt: NOW - 365 * 24 * 3600_000,
  })
}])

cases.push(['临时卡片：异常终止同样一直保留；12 小时只是无观察记录时的兜底窗口', () => {
  assert.equal(vis({ done: false, error: true, observedFinishedAt: NOW - 11 * 3600_000 }).show, true)
  assert.equal(vis({ done: false, error: true, observedFinishedAt: NOW - 13 * 3600_000 }).show, true)
  assert.equal(vis({ done: false, error: true, observedFinishedAt: NOW - 30 * 24 * 3600_000 }).show, true)
  assert.equal(vis({ done: true, error: true, observedFinishedAt: NOW - 11 * 3600_000 }).show, true)
  // 没有观察记录、提示词已超过 12 小时 → 不把历史异常塞进卡片
  assert.equal(vis({ done: false, error: true, updatedAt: NOW - 13 * 3600_000 }).show, false)
}])

cases.push(['临时卡片：没有观察记录时只用「本轮提示词在兜底窗口内」判断是否首次收纳', () => {
  // 提示词 10 分钟前、没观察到跑停 → 可认为刚结束，展示
  assert.deepEqual(vis({ updatedAt: NOW - 10 * 60_000 }), { show: true, finished: true, finishedAt: NOW - 10 * 60_000 })
  // 长任务提示词在 2 小时前、没有观察记录 → 无法判定结束时间，不把历史会话塞进卡片
  assert.deepEqual(vis({ updatedAt: NOW - 2 * 3600_000 }), { show: false, finished: true, finishedAt: 0 })
  // 观察记录属于上一轮（早于 updatedAt）→ 不采用，改用提示词兜底
  assert.deepEqual(
    vis({ updatedAt: NOW - 10 * 60_000, observedFinishedAt: NOW - 3 * 3600_000 }),
    { show: true, finished: true, finishedAt: NOW - 10 * 60_000 },
  )
}])

cases.push(['临时卡片：异常且无观察记录 → 用 12 小时提示窗口兜底', () => {
  assert.equal(vis({ done: false, error: true, updatedAt: NOW - 2 * 3600_000 }).show, true)
  assert.equal(vis({ done: false, error: true, updatedAt: NOW - 13 * 3600_000 }).show, false)
}])

cases.push(['临时卡片：收工只压住这一轮；新结束时间晚于收工 → 重新出现', () => {
  assert.equal(vis({ observedFinishedAt: NOW - 10 * 60_000, dismissedAt: NOW - 5 * 60_000 }).show, false)
  assert.equal(vis({ observedFinishedAt: NOW - 2 * 60_000, dismissedAt: NOW - 10 * 60_000 }).show, true)
}])

cases.push(['临时卡片：空白会话 / 无完成或异常标记的结束会话不展示', () => {
  assert.equal(vis({ blank: true }).show, false)
  assert.equal(vis({ done: false, error: false, observedFinishedAt: NOW - 60_000 }).show, false)
  // 运行中的空白会话仍要展示（极少见，但状态诚实）
  assert.equal(vis({ blank: true, running: true }).show, true)
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
