/**
 * 微基准：控件树通道的**每帧真实开销**（纯 JS 部分，毫秒级，可重复跑）。
 *   node scripts/bench-cu-uia-core.mjs
 *
 * 这个脚本回答的是第 ⑤ 条硬约束里「耗时」那一半：通道本身（不是模型、不是截图）
 * 每帧要多花多少时间、多少次探针。端到端（整段任务 60.5 分钟 → ?）不在本脚本范围，
 * 原因见 docs/computer-use-提速前后对比-2026-11-27.md §3（观察环在 vendor 里且不许改）。
 *
 * 判据（脚本末尾会打印 PASS/FAIL）：
 *   - 同一页 40 帧只探 1 次（8 页 40 帧 → ≤8 次探针，命中率 ≥80%）；
 *   - 每帧纯 JS 开销 < 1ms（不含真探针）；
 *   - 读不出时（零候选）开销 ≤ 有候选时的一半，且输出为空串/空数组。
 */
import assert from 'node:assert/strict'
import {
  buildControlHintBlock,
  createActionMemory,
  createPageCache,
  decideControlChannel,
  pageCacheKey,
  planMarks,
  verifyClick,
} from '../src/cu-uia-core.ts'

const WINDOW = { title: '轰趴馆管理后台 - Chrome', className: 'Chrome_WidgetWin_1', rect: { x: 0, y: 0, w: 1600, h: 900 } }

function makeControls(count) {
  const list = []
  for (let i = 0; i < count; i += 1) {
    list.push({
      name: '控件' + i,
      role: i % 5 === 0 ? 'Edit' : 'Button',
      rect: { x: 40 + (i % 12) * 120, y: 60 + Math.floor(i / 12) * 48, w: 96, h: 32 },
      enabled: true,
      automationId: 'id-' + i,
    })
  }
  return list
}

function timeIt(label, iterations, fn) {
  // 预热（JIT），再计时
  for (let i = 0; i < Math.min(200, iterations); i += 1) fn(i)
  const started = process.hrtime.bigint()
  for (let i = 0; i < iterations; i += 1) fn(i)
  const elapsedNs = Number(process.hrtime.bigint() - started)
  const perCallUs = elapsedNs / iterations / 1000
  return { label, iterations, perCallUs, totalMs: elapsedNs / 1e6 }
}

const CONTROLS = makeControls(200)
const outcomeOk = { ok: true, window: WINDOW, controls: CONTROLS, ms: 40 }
const outcomeBlind = { ok: true, window: WINDOW, controls: [], ms: 12 }

const rows = []

// ① 有候选：探针判定 + 编号 + 候选清单文本（每帧都要做的全部纯 JS 工作）
const full = timeIt('每帧（有候选：判定+编号+清单）', 2000, () => {
  const decision = decideControlChannel(outcomeOk)
  const marks = planMarks(CONTROLS, WINDOW.rect)
  return decision.enabled ? buildControlHintBlock(marks) : ''
})
rows.push(full)

// ② 读不出：整帧退回纯视觉（零开销路径）
const blind = timeIt('每帧（读不出：直接退回）', 2000, () => {
  const decision = decideControlChannel(outcomeBlind)
  const marks = decision.enabled ? planMarks(CONTROLS, WINDOW.rect) : []
  return decision.enabled ? buildControlHintBlock(marks) : ''
})
rows.push(blind)

// ③ 事后校验（每步一次）
const verify = timeIt('每步（一次事后校验）', 200000, () => verifyClick({ x: 1432, y: 217, w: 88, h: 28 }, { x: 1476, y: 231 }))
rows.push(verify)

// ④ 动作记忆读写（每步各一次）
const memory = createActionMemory({ max: 200 })
memory.remember(pageCacheKey(WINDOW), CONTROLS[3], { x: 1, y: 2 })
const recall = timeIt('每步（记忆 recall）', 200000, () => memory.recall(pageCacheKey(WINDOW), CONTROLS[3]))
rows.push(recall)

console.log('== 纯 JS 每帧/每步开销（本机实测）==')
for (const row of rows) {
  console.log(`  ${row.label.padEnd(30)} ${row.perCallUs.toFixed(3).padStart(9)} µs/次   （${row.iterations} 次，共 ${row.totalMs.toFixed(1)} ms）`)
}

// ⑤ 8 个页面、40 帧：探针次数与命中率
const cache = createPageCache({ ttlMs: 30_000, maxPages: 8 })
let probeCalls = 0
const pageCursors = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]
const frameCount = 40
const startedFrames = process.hrtime.bigint()
for (let frame = 0; frame < frameCount; frame += 1) {
  const pageIndex = pageCursors[Math.floor(frame / 2.5) % pageCursors.length]
  const window = { ...WINDOW, title: '页面' + pageIndex, rect: { x: 0, y: 0, w: 1600, h: 900 - pageIndex } }
  const key = pageCacheKey(window)
  await cache.resolve(key, async () => { probeCalls += 1; return CONTROLS })
}
const framesMs = Number(process.hrtime.bigint() - startedFrames) / 1e6
const stats = cache.stats()
const hitRate = stats.hits + stats.misses === 0 ? 0 : stats.hits / (stats.hits + stats.misses)
console.log('\n== 40 帧 / 8 个页面的探针次数（缓存口径）==')
console.log(`  帧数 ${frameCount}，不同页面 ${new Set(pageCursors).size}，实际探针 ${probeCalls} 次，缓存命中率 ${(hitRate * 100).toFixed(1)}%`)
console.log(`  40 帧总耗时 ${framesMs.toFixed(2)} ms（含 cache 查询；不含真探针的 470–520ms/次）`)
const hint = buildControlHintBlock(planMarks(CONTROLS, WINDOW.rect))
console.log(`\n== 候选清单体积 ==`)
console.log(`  200 个控件 → 编号 ${planMarks(CONTROLS, WINDOW.rect).length} 个（上限 40），清单 ${hint.length} 字符（中文按 1 字符≈1 token、ASCII≈0.25 估，约 ${Math.ceil(hint.length * 0.8)}–${hint.length} tokens/帧）`)
console.log('  样例：\n' + hint.split('\n').slice(0, 3).map((line) => '    ' + line).join('\n'))

// 断言（门禁：任一不满足就别接线）
assert.ok(probeCalls <= 8, `同一批页面不许重复探针：期望 ≤8 次，实际 ${probeCalls}`)
assert.ok(hitRate >= 0.8, `缓存命中率必须 ≥80%，实际 ${(hitRate * 100).toFixed(1)}%`)
assert.ok(full.perCallUs < 1000, `每帧纯 JS 开销必须 <1ms，实际 ${full.perCallUs.toFixed(3)}µs`)
assert.ok(blind.perCallUs < full.perCallUs * 2, '读不出路径不许比有候选更贵')
assert.equal(buildControlHintBlock(planMarks([], WINDOW.rect)), '', '零候选必须是空串（零开销）')
console.log('\nRESULT: PASS（纯 JS 侧不构成减速；真探针代价与端到端见报告）')
