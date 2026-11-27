/**
 * 单测：Computer Use 控件树通道的核心逻辑（纯函数，离线可跑，不需要 UIA、不需要宿主）。
 *   node scripts/test-cu-uia-core.mjs
 *
 * 钉死的口径（五条「只增不减」硬约束）：
 *   ① 树读不出 → decideControlChannel 返回 enabled=false（few-controls / too-slow / low-coverage / error / no-window 五种原因）
 *      → 候选清单是空串、编号是空数组（整帧退回纯视觉，零开销）；
 *   ② 同一页只探一次（createPageCache.resolve 的 probes 计数），UI 变了（新键 / invalidate）才重跑；
 *   ③ verifyClick 只回 hit/miss/unknown，不返回新坐标；miss 时调用方只清缓存；
 *   ④ 没有 rollout：一次点击只取一次坐标（pickPoint 只回一个点），记忆只做预案；
 *   ⑤ 见 scripts/bench-cu-uia-core.mjs（同任务新旧各跑一遍的门禁脚本）。
 */
import assert from 'node:assert/strict'
import {
  UIA_HINT_MAX_CHARS,
  UIA_MARK_MAX,
  UIA_MIN_CONTROLS,
  UIA_PROBE_BUDGET_MS,
  absolutePoint,
  buildControlHintBlock,
  controlKeyOf,
  coverageOfControls,
  createActionMemory,
  createPageCache,
  decideControlChannel,
  filterMarkableControls,
  pageCacheKey,
  pickPoint,
  planChannelFrame,
  planMarks,
  rectArea,
  resolveChannelSwitch,
  verifyClick,
} from '../src/cu-uia-core.ts'
import { parseUiaProbeJson } from '../src/cu-uia-win.ts'

const WINDOW = { title: '轰趴馆管理后台 - Chrome', className: 'Chrome_WidgetWin_1', rect: { x: 0, y: 0, w: 1600, h: 900 } }

function control(name, role, x, y, w, h, extra = {}) {
  return { name, role, rect: { x, y, w, h }, enabled: true, ...extra }
}

const RICH = [
  control('更多', 'Button', 1597, 110, 40, 28, { automationId: 'more' }),
  control('复制链接', 'Button', 1432, 217, 88, 28, { automationId: 'copy' }),
  control('搜索门店', 'Edit', 240, 60, 260, 30),
  control('保存', 'Button', 1300, 800, 72, 30),
  control('管理后台', 'Window', 0, 0, 1600, 900, { enabled: false }),
]
const RICH_OUTCOME = { ok: true, window: WINDOW, controls: RICH, ms: 40 }

const cases = []
cases.push(['第 ①/② 条：读得出来才启动通道（预算 120ms、≥3 个可点控件、覆盖 ≥1%）', async () => {
  assert.equal(decideControlChannel(RICH_OUTCOME).enabled, true)
  assert.equal(decideControlChannel(RICH_OUTCOME).reason, 'ok', '正常页面必须启动通道')
  const few = { ok: true, window: WINDOW, controls: [control('画布', 'Pane', 0, 0, 1600, 900)], ms: 30 }
  assert.deepEqual(decideControlChannel(few), { enabled: false, reason: 'few-controls' }, '自绘/canvas 页读不出 → 不启动')
  const slow = { ok: true, window: WINDOW, controls: RICH, ms: UIA_PROBE_BUDGET_MS + 1 }
  assert.deepEqual(decideControlChannel(slow), { enabled: false, reason: 'too-slow' }, '超预算 → 整帧退回纯视觉')
  const tiny = { ok: true, window: WINDOW, controls: [control('a', 'Button', 0, 0, 4, 4), control('b', 'Button', 10, 10, 4, 4), control('c', 'Button', 20, 20, 4, 4)], ms: 20 }
  assert.deepEqual(decideControlChannel(tiny), { enabled: false, reason: 'few-controls' }, '4×4 的节点不算可点控件')
  const empty = { ok: true, window: WINDOW, controls: [], ms: 20 }
  assert.deepEqual(decideControlChannel(empty), { enabled: false, reason: 'few-controls' })
  assert.deepEqual(decideControlChannel(null), { enabled: false, reason: 'no-window' })
  assert.deepEqual(decideControlChannel({ ok: false, window: null, controls: [], ms: 9, error: 'bad-json' }), { enabled: false, reason: 'error' })
  assert.equal(decideControlChannel({ ok: true, window: { ...WINDOW, rect: { x: 0, y: 0, w: 0, h: 0 } }, controls: RICH, ms: 20 }).enabled, false, '没有观察面 rect 就不启动')
}])
cases.push(['第 ① 条：不启动时候选清单是空串、编号是空数组（零开销）', async () => {
  const marks = planMarks([], WINDOW.rect)
  assert.deepEqual(marks, [], '没有控件就没有编号（调用方原样返回原帧）')
  assert.equal(buildControlHintBlock(marks), '', '空候选=空提示段，不进模型上下文')
  assert.equal(buildControlHintBlock([]), '')
  assert.equal(coverageOfControls([], WINDOW.rect), 0)
  assert.equal(rectArea(null), 0)
  assert.equal(rectArea({ x: 0, y: 0, w: -5, h: 10 }), 0)
}])
cases.push(['第 ② 条：同一页只探一次，命中缓存不重解析；UI 变了才重跑', async () => {
  let clock = 1_000
  const cache = createPageCache({ now: () => clock, ttlMs: 30_000, maxPages: 2 })
  let probeCalls = 0
  const probe = async () => { probeCalls += 1; return RICH }
  const key = pageCacheKey(WINDOW)
  assert.equal(key, 'Chrome_WidgetWin_1|轰趴馆管理后台 - Chrome|1600x900')
  const frames = 40
  let resolutions = 0
  for (let i = 0; i < frames; i += 1) {
    const got = await cache.resolve(key, probe)
    if (got.probed) resolutions += 1
    clock += 50
  }
  assert.equal(probeCalls, 1, `40 帧同一页只许探 1 次，实际 ${probeCalls} 次`)
  assert.equal(resolutions, 1)
  const stats = cache.stats()
  assert.equal(stats.probes, 1)
  assert.equal(stats.hits, frames - 1, '其余帧全走缓存命中')
  cache.invalidate(key)
  const again = await cache.resolve(key, probe)
  assert.equal(again.probed, true, 'UI 变了（invalidate）才重跑')
  assert.equal(probeCalls, 2)
  clock += 31_000
  await cache.resolve(key, probe)
  assert.equal(probeCalls, 3, '超过 TTL 也要重跑（页面可能已经改了）')
  // 页面标题/尺寸变了 = 新键 = 自然 miss
  const other = pageCacheKey({ ...WINDOW, rect: { x: 0, y: 0, w: 1280, h: 720 } })
  assert.notEqual(other, key)
  await cache.resolve(other, probe)
  assert.equal(probeCalls, 4)
  assert.ok(cache.stats().size <= 2, '页面缓存有上限（别把内存吃满）')
}])
cases.push(['第 ② 步：编号按阅读顺序、去噪、上限 40；候选清单紧凑且可截断', async () => {
  const marks = planMarks(RICH, WINDOW.rect)
  assert.deepEqual(marks.map((m) => m.no), [1, 2, 3, 4], '编号从 1 开始连续')
  assert.deepEqual(marks.map((m) => m.control.name), ['搜索门店', '更多', '复制链接', '保存'], '按 y 再 x 的阅读顺序（y=60 的搜索框排第一）')
  assert.equal(filterMarkableControls(RICH, WINDOW.rect).some((c) => c.name === '管理后台'), false, '整页容器（90% 面积）不许进候选')
  const hint = buildControlHintBlock(marks)
  assert.match(hint, /^#1 Edit "搜索门店" @ \(240,60,260,30\)$/m)
  assert.match(hint, /^#2 Button "更多" @ \(1597,110,40,28\)$/m)
  assert.equal(hint.split('\n').length, 4)
  const many = Array.from({ length: 80 }, (_, i) => control('按钮' + i, 'Button', 10 + (i % 10) * 120, 20 + Math.floor(i / 10) * 60, 60, 30))
  const manyMarks = planMarks(many, WINDOW.rect)
  assert.equal(manyMarks.length, UIA_MARK_MAX, '一帧最多画 40 个编号（多了反而干扰）')
  const long = buildControlHintBlock(manyMarks, { maxChars: 80 })
  assert.ok(long.length <= 80, `候选清单必须受字符上限约束（实际 ${long.length}）`)
  assert.ok(buildControlHintBlock(manyMarks).length <= UIA_HINT_MAX_CHARS)
}])
cases.push(['第 ③ 条：事后校验只回 hit/miss/unknown，绝不改坐标', async () => {
  const rect = { x: 100, y: 100, w: 40, h: 20 }
  assert.equal(verifyClick(rect, { x: 120, y: 110 }), 'hit', '正中命中')
  assert.equal(verifyClick(rect, { x: 96, y: 110 }), 'hit', '容差 = 短边 10%（≥4px），边缘附近仍算中')
  assert.equal(verifyClick(rect, { x: 300, y: 400 }), 'miss', '点偏 200px 就是 miss')
  assert.equal(verifyClick(rect, null), 'unknown', '没有落点 → unknown（不判 UI 已变）')
  assert.equal(verifyClick(null, { x: 1, y: 1 }), 'unknown')
  assert.equal(verifyClick({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0 }), 'unknown')
  const before = { x: 120, y: 110 }
  verifyClick(rect, before)
  assert.deepEqual(before, { x: 120, y: 110 }, '校验函数不许改入参坐标（模型给的坐标原样执行）')
}])
cases.push(['第 ④ 步：动作记忆只做预案，视觉坐标永远优先；落空即遗忘', async () => {
  const memory = createActionMemory({ max: 3 })
  const key = pageCacheKey(WINDOW)
  const target = RICH[1]
  memory.remember(key, target, { x: 1476, y: 231 })
  assert.deepEqual(memory.recall(key, target), { point: { x: 1476, y: 231 }, controlKey: 'Button#copy' })
  assert.deepEqual(pickPoint({ x: 10, y: 20 }, memory.recall(key, target)), { point: { x: 10, y: 20 }, source: 'model' }, '模型给了坐标就用模型的')
  assert.deepEqual(pickPoint(null, memory.recall(key, target)), { point: { x: 1476, y: 231 }, source: 'memory' }, '模型没给才用记忆')
  assert.deepEqual(pickPoint(undefined, null), { point: null, source: 'none' })
  memory.forget(key)
  assert.equal(memory.recall(key, target), null, 'miss 之后必须能忘掉（判 UI 已变）')
  for (let i = 0; i < 5; i += 1) memory.remember(key, 'Button|x' + i, { x: i, y: i })
  assert.ok(memory.size() <= 3, '记忆有上限')
  assert.equal(controlKeyOf(null), '')
  assert.equal(controlKeyOf({ name: ' 复制   链接 ', role: 'Button' }), 'Button|复制 链接', '名字里的空白要归一')
}])
cases.push(['坐标换算与探针解析：窗口相对 → 屏幕绝对；坏输出一律如实回「读不出」', async () => {
  assert.deepEqual(absolutePoint(WINDOW, { x: 12, y: 34 }), { x: 12, y: 34 })
  assert.deepEqual(absolutePoint({ ...WINDOW, rect: { x: -8, y: -8, w: 800, h: 600 } }, { x: 100, y: 50 }), { x: 92, y: 42 })
  assert.equal(absolutePoint(null, { x: 1, y: 1 }), null)
  const sample = JSON.stringify({
    ok: true,
    title: '后台 - Chrome',
    className: 'Chrome_WidgetWin_1',
    frame: [-8, -8, 1936, 1048],
    controls: [
      { name: '更多', role: 'Button', id: 'more', x: 1597, y: 110, w: 40, h: 28, enabled: true },
      { name: '', role: 'Pane', id: '', x: 0, y: 0, w: 1920, h: 1032, enabled: false },
    ],
    ms: 487,
  })
  const parsed = parseUiaProbeJson(sample)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.controls.length, 2)
  assert.deepEqual(parsed.controls[0], { name: '更多', role: 'Button', rect: { x: 1597, y: 110, w: 40, h: 28 }, enabled: true, automationId: 'more' })
  assert.deepEqual(parsed.window.rect, { x: -8, y: -8, w: 1936, h: 1048 })
  assert.equal(parsed.ms, 487)
  assert.equal(decideControlChannel(parsed).reason, 'too-slow', '真机实测 487ms 已超过 120ms 预算 → 整帧退回纯视觉')
  assert.equal(decideControlChannel({ ok: true, window: WINDOW, controls: RICH, ms: UIA_PROBE_BUDGET_MS }).enabled, true, '恰好 120ms 仍算通过（边界不许含糊）')
  assert.equal(decideControlChannel({ ok: true, window: WINDOW, controls: RICH, ms: UIA_PROBE_BUDGET_MS + 1 }).reason, 'too-slow', '超过 120ms 一律不启动')
  assert.equal(parseUiaProbeJson('').error, 'empty-output')
  assert.equal(parseUiaProbeJson('not json').error, 'bad-json')
  assert.equal(parseUiaProbeJson('[]').error, 'bad-shape')
  assert.equal(parseUiaProbeJson(JSON.stringify({ ok: false, reason: 'boom', controls: [], frame: [0, 0, 10, 10] })).error, 'boom')
  assert.equal(parseUiaProbeJson(JSON.stringify({ ok: true, frame: [0, 0, 10, 10], controls: [] })).error, 'no-controls')
  assert.ok(UIA_MIN_CONTROLS >= 3)
}])

cases.push(['一键回退开关：默认关；env=0 关；env=1 才开；文件 false 压过 env=1（安全侧取胜）', async () => {
  assert.deepEqual(resolveChannelSwitch({}), { enabled: false, reason: 'default-off' }, '什么都不配 = 关（默认关）')
  assert.deepEqual(resolveChannelSwitch({ env: '0' }), { enabled: false, reason: 'env-off' })
  assert.deepEqual(resolveChannelSwitch({ env: 'off' }), { enabled: false, reason: 'env-off' })
  assert.deepEqual(resolveChannelSwitch({ env: '0', fileEnabled: true }), { enabled: false, reason: 'env-off' }, 'env=0 优先于文件 on')
  assert.deepEqual(resolveChannelSwitch({ env: '1', fileEnabled: false }), { enabled: false, reason: 'conflict-off' }, 'env=1 与文件 false 冲突时取安全侧')
  assert.deepEqual(resolveChannelSwitch({ env: '1' }), { enabled: true, reason: 'env-on' })
  assert.deepEqual(resolveChannelSwitch({ fileEnabled: false }), { enabled: false, reason: 'file-off' })
  assert.deepEqual(resolveChannelSwitch({ fileEnabled: true }), { enabled: true, reason: 'file-on' })
}])
cases.push(['关通道 = 改动前行为：帧不复制不编码、提示段返空、点击参数逐字节相同', async () => {
  const marks = planMarks(RICH, WINDOW.rect)
  const decision = decideControlChannel(RICH_OUTCOME)
  const closed = planChannelFrame({ switch: resolveChannelSwitch({ env: '0' }), decision, marks })
  assert.deepEqual(closed, { useMarks: false, marks: [], hint: '', copyFrame: false }, '关掉时一帧都不许动')
  const blind = planChannelFrame({ switch: { enabled: true, reason: 'env-on' }, decision: decideControlChannel({ ok: true, window: WINDOW, controls: [], ms: 10 }), marks: [] })
  assert.deepEqual(blind, { useMarks: false, marks: [], hint: '', copyFrame: false }, '读不出时同样不许动帧')
  const open = planChannelFrame({ switch: { enabled: true, reason: 'env-on' }, decision, marks })
  assert.equal(open.useMarks, true)
  assert.equal(open.copyFrame, true, '只有真要画编号时才复制帧')
  assert.ok(open.hint.length > 0)
  const modelPoint = { x: 1476, y: 231 }
  const snapshot = JSON.stringify(modelPoint)
  const picked = pickPoint(modelPoint, createActionMemory().recall('p', RICH[1]))
  assert.deepEqual(picked, { point: { x: 1476, y: 231 }, source: 'model' })
  verifyClick(marks[0].rect, modelPoint)
  assert.equal(JSON.stringify(modelPoint), snapshot, '模型坐标不许被任何通道函数改写')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log('ok  ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name + ' :: ' + (error?.stack ?? error))
  }
}
console.log(`\ncu-uia-core: ${cases.length - failed}/${cases.length} 通过`)
if (failed > 0) process.exit(1)
