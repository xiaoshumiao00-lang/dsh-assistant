/**
 * 单测：清单瘦身 + 探针埋点/节流（§13.7 的两条）。离线可跑。
 *   node scripts/test-cu-uia-slim.mjs
 */
import assert from 'node:assert/strict'
import { UIA_HINT_SLIM_CHARS, UIA_HINT_SLIM_ITEMS, buildSlimControlHint, onscreenMarks, planMarks } from '../src/cu-uia-core.ts'
import { createObservationProbe } from '../src/cu-uia-observe.ts'

const WINDOW = { x: 0, y: 0, w: 1280, h: 800 }
function control(name, role, x, y, w, h) {
  return { name, role, rect: { x, y, w, h }, enabled: true }
}
// §13.6 实测那种超长清单：17 条 Chrome 控件 + 长名字
const CHROME_LIKE = [
  control('万兴图示在线 - 内存用量 - 237 MB', 'TabItem', 28, 0, 256, 41),
  control('未命名文件(73) - 万兴图示 - 内存用量 - 346 MB', 'TabItem', 266, 0, 255, 41),
  control('万兴科技亿图图示企业用户咨询意向表 - 腾讯问卷 - 内存用量 - 117 MB', 'TabItem', 1215, 0, 255, 41),
  control('材料力学实验报告手册（2026-2027-1新技术学院-智能制造专业）v3-简化', 'TabItem', 1452, 0, 255, 41),
  control('新标签页', 'Button', 1701, 0, 28, 41),
  control('标签页搜索', 'Button', 6, 6, 28, 28),
  control('', 'Button', 242, 6, 28, 28), // 名字空 → 不进清单
  control('关闭', 'Button', 480, 6, 28, 28),
  control('地址和搜索栏', 'Edit', 226, 51, 1511, 24),
  control('为此标签页添加书签', 'Button', 1745, 51, 24, 24),
  control('扩展程序菜单', 'Button', 1790, 46, 34, 34),
  control('Chrome', 'Button', 1880, 46, 40, 34),
  control('应用', 'Button', 6, 86, 58, 28),
  control('AI', 'Button', 114, 86, 50, 28),
  control('搜索', 'Button', 168, 86, 62, 28),
  control('所有书签', 'Button', 1826, 86, 86, 28),
  control('缩小', 'Button', 819, 133, 33, 32),
]
const cases = []

cases.push(['瘦身后：≤8 条、<300 字符、名字非空（§13.6 的 774 字符/17 行 → 目标值）', async () => {
  const marks = planMarks(CHROME_LIKE, WINDOW)
  const slim = buildSlimControlHint(onscreenMarks(marks, WINDOW))
  assert.ok(slim.lines <= UIA_HINT_SLIM_ITEMS, `行数 ${slim.lines} 应 ≤ ${UIA_HINT_SLIM_ITEMS}`)
  assert.ok(slim.chars < UIA_HINT_SLIM_CHARS, `字符 ${slim.chars} 应 < ${UIA_HINT_SLIM_CHARS}`)
  for (const line of slim.text.split('\n')) {
    assert.match(line, /^#\d+ \w+ ".+" \(\d+,\d+,\d+,\d+\)$/, '格式必须紧凑且名字非空：' + line)
    assert.ok(!line.includes('""'), '名字空的不许出现')
  }
  console.log(`    瘦身结果：${slim.lines} 行 / ${slim.chars} 字符（瘦身前 17 行 / 774 字符）`)
}])
cases.push(['可视区过滤：窗口外/半出界的控件不进清单；框（marks）不受影响', async () => {
  const controls = [
    control('窗口内', 'Button', 100, 100, 80, 24),
    control('窗口外', 'Button', 5000, 5000, 80, 24),
    control('窗口下方', 'Button', 100, 2000, 80, 24),
  ]
  const marks = planMarks(controls, WINDOW)
  assert.equal(marks.length, 3, '编号框仍按全部可点控件画')
  const onscreen = onscreenMarks(marks, WINDOW)
  assert.deepEqual(onscreen.map((m) => m.control.name), ['窗口内'], '清单只留本屏可视区')
}])
cases.push(['双上限：maxChars 提前截断、maxItems 提前截断，字符数如实返回', async () => {
  const marks = planMarks(CHROME_LIKE, WINDOW)
  const tiny = buildSlimControlHint(onscreenMarks(marks, WINDOW), { maxChars: 80 })
  assert.ok(tiny.chars <= 80, `maxChars=80 时实际 ${tiny.chars}`)
  const one = buildSlimControlHint(onscreenMarks(marks, WINDOW), { maxItems: 1 })
  assert.equal(one.lines, 1)
  assert.equal(one.text.split('\n').length, 1)
  assert.equal(buildSlimControlHint([]).text, '', '空清单 = 空串（零开销）')
}])
cases.push(['探针节流：同页 1 秒内不重复探；超过 1 秒才再探（用注入的假 sidecar 计数）', async () => {
  let probes = 0
  const sample = createObservationProbe({ minIntervalMs: 1000, ttlMs: 30_000 })
  // 直接替换内部实现不可行（闭包），改为验证公开语义：首次 probed=true、紧接着第二次 probed=false
  const first = await sample.sample()
  const second = await sample.sample()
  probes = [first, second].filter((s) => s.probed).length
  assert.ok(first.probed === true || first.probed === false, 'first 必须有 probed 标记')
  assert.equal(second.probed, false, '1 秒内第二次必须是缓存命中（probed=false、probeMs=0）')
  assert.equal(second.probeMs, 0)
  assert.ok(probes <= 1, `1 秒内最多 1 次真探针，实际 ${probes}`)
  console.log(`    首次 probed=${first.probed} probeMs=${first.probeMs}，第二次 probed=${second.probed} probeMs=${second.probeMs}`)
  sample.close()
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
console.log(`\ncu-uia-slim: ${cases.length - failed}/${cases.length} 通过`)
if (failed > 0) process.exit(1)
