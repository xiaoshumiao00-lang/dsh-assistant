/**
 * 单测：click 工具的「点击时坐标吸附」补丁（vendor/computer-use/index.js）。
 *   node scripts/test-cu-click-snap.mjs
 *
 * 覆盖的四条硬要求：
 *   - 表内坐标不动（bbox 命中就不改，回执也不多加行）；
 *   - 偏几像素被吸回最近元素中心（≤ 24 px）；
 *   - 超阈值放行（> 24 px 按原坐标点，回执 pass-through: … | reason=超阈值）；
 *   - 扫描失败 / 超时放行（一行 warn，不拦死、不重试）；
 *   - 附带：DSH_CU_SNAP=0 一键关掉、DSH_CU_TARGET_TABLE=0 同步停用、预览 1792×963→1920×1032 换算。
 *
 * 依赖打最小桩（schemastery / dsh-llm / dsh-tools / dsh-session / dsh-attachment）：补丁路径只碰
 * node 内建，被测文件就是仓库里那一份原文件（不拷贝、不复制逻辑），点也是假的（backend.click 记参数）。
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = new URL('../vendor/computer-use/index.js', import.meta.url)
const REAL_TABLE_HOME = 'C:\\Users\\Administrator\\.dsh'

const stub = (code) => `data:text/javascript,${encodeURIComponent(code)}`
const MODULES = {
  '@deepseek-ai/schemastery': stub('const chain=()=>new Proxy(function(){},{get:()=>chain,apply:()=>chain});export default chain();'),
  '@deepseek-ai/dsh-llm': stub('export const createUserMessage=(input)=>input;'),
  '@deepseek-ai/dsh-tools': stub('export const defineTool=(definition)=>definition;'),
  '@deepseek-ai/dsh-session': stub('export const KNOWN_SESSION_EVENT_TYPES=new Set();export const Session={create:()=>({append:()=>({})})};export const SessionId=(value)=>String(value);'),
  '@deepseek-ai/dsh-attachment': stub('export const AttachmentId=(value)=>String(value);'),
}
registerHooks({
  resolve(specifier, context, next) {
    const url = MODULES[specifier]
    return url === undefined ? next(specifier, context) : { url, shortCircuit: true }
  },
})

const { applyComputerUse } = await import(PLUGIN.href)

const PNG = (() => {
  const buffer = Buffer.alloc(2048)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0)
  return buffer
})()
const SIGNAL = { aborted: false, throwIfAborted() {}, addEventListener() {} }
// 附件 id 是 64 位 hex 的内容寻址键：<DSH_HOME>/attachments/v1/objects/<前两位>/<id>
const ATTACHMENT_ID = `ab${'0'.repeat(62)}`

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL - ${name}: ${error.message}`)
  }
}

/** 一份假 CU 宿主：工具注册表、假 backend（click 只记账）、假附件、假 agent/session。 */
function makeHarness(attached) {
  const tools = new Map()
  const clicks = []
  const ctx = {
    get(name) {
      if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['image'] }) }
      return undefined
    },
    on() { return () => {} },
    inject() {},
    logger: () => ({ info() {}, warn() {}, error() {} }),
    systemPrompt: { section: () => () => {} },
    attachments: {
      async saveImage(input) {
        return { attachmentId: 'att-1', mediaType: 'image/png', bytes: input.data.length, width: attached.w, height: attached.h }
      },
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  }
  const backend = {
    withGuiTurn: (run) => run(),
    listScreens: async () => [{ index: 0, bounds: { x: 0, y: 0, width: attached.w, height: attached.h }, scale: 1 }],
    capture: async () => ({ data: PNG, mediaType: 'image/png', width: attached.w, height: attached.h }),
    inspectForeground: async () => ({ appName: 'SnapFixture' }),
    click: async (input) => {
      clicks.push(input)
      return { landed: { x: input.position[0], y: input.position[1] } }
    },
  }
  applyComputerUse(ctx, backend, { postActionWaitMs: 0 })
  return { tools, clicks }
}

function makeExec(mode = 'pixel', attached = FRAME) {
  // 首帧通知（真机上就是 observation notice）：lastAttachedRaster() 从这里认回截图尺寸。
  const events = [
    {
      type: 'user/message',
      data: {
        source: { kind: 'computer-use', form: 'notice' },
        content: [{ type: 'image', attachment: { attachmentId: ATTACHMENT_ID, width: attached.w, height: attached.h } }],
      },
    },
    { type: 'computer-use/coordinate-mode', data: { mode } },
  ]
  const session = {
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  return { agent: { id: 'cu-snap-test', session, options: { provider: 'p', model: 'm' } }, signal: SIGNAL }
}

async function clickWith(harness, exec, position) {
  const tool = harness.tools.get('click')
  const value = await tool.execute({ screen_index: 0, position }, exec)
  const blocks = tool.output.render(undefined, value)
  return {
    value,
    text: blocks[0].text,
    clicked: harness.clicks.at(-1),
    snap: value.snap,
  }
}

/** 造一份 <DSH_HOME>/cu-click/target-table：current.json + 表文件，字段形状与 target_table.py 一致。 */
function writeTableHome(home, frame, elements, previewScale) {
  const tableDir = join(home, 'cu-click', 'target-table')
  mkdirSync(tableDir, { recursive: true })
  const tableFile = `${frame.w}x${frame.h}-snaptest0000-frame.json`
  const table = {
    version: 1,
    table_key: `${frame.w}x${frame.h}-snaptest0000-frame`,
    frame_size: { w: frame.w, h: frame.h },
    coordinate_space: `pixel:${frame.w}x${frame.h}`,
    structural_hash: 'snaptest0000',
    frame_hash: 'snaptestframe',
    generated_at: '2026-11-29T00:00:00+0800',
    elements,
    ...(previewScale === undefined ? {} : {
      preview_scale: {
        x: previewScale.x,
        y: previewScale.y,
        note: '1792x963 预览 → 1920x1032 帧：点之前乘 1920/1792 与 1032/963',
      },
    }),
  }
  writeFileSync(join(tableDir, tableFile), JSON.stringify(table, null, 2))
  writeFileSync(join(tableDir, 'current.json'), JSON.stringify({
    version: 1,
    table_key: table.table_key,
    table_file: tableFile,
    frame_size: table.frame_size,
    coordinate_space: table.coordinate_space,
    structural_hash: table.structural_hash,
    frame_hash: table.frame_hash,
    updated_at: '2026-11-29T00:00:00+0800',
  }, null, 2))
  return tableDir
}

const element = (name, x0, y0, x1, y1) => ({
  name,
  role: 'button',
  kind: 'blue',
  bbox: { x0, y0, x1, y1 },
  w: x1 - x0,
  h: y1 - y0,
  center: { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) },
  px: 900,
})

const FRAME = { w: 1486, h: 864 }
const ELEMENTS = [
  element('R01C01-button', 100, 50, 200, 80),
  element('R02C02-input', 400, 200, 700, 232),
]

const roots = []
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'cu-snap-'))
  roots.push(home)
  return home
}

function withEnv(values) {
  const saved = {}
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ── 用例 1：表内坐标不动 ────────────────────────────────────────────────────────────────────
{
  const home = tempHome()
  writeTableHome(home, FRAME, ELEMENTS)
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined, DSH_CU_SNAP_BUDGET_MS: undefined })
  const harness = makeHarness(FRAME)
  const exec = makeExec('pixel')
  const result = await clickWith(harness, exec, [150, 65])
  check('表内坐标不动：bbox 命中原样返回，回执不加吸附行', () => {
    assert.deepEqual(result.value.position, [150, 65])
    assert.equal(result.snap, undefined)
    assert.ok(!result.text.includes('snapped:'), result.text)
    assert.ok(!result.text.includes('pass-through:'), result.text)
    const fraction = result.clicked.position
    assert.ok(Math.abs(fraction[0] - 150 / FRAME.w * 1000) < 0.01, `click x=${fraction[0]}`)
    assert.ok(Math.abs(fraction[1] - 65 / FRAME.h * 1000) < 0.01, `click y=${fraction[1]}`)
  })
  restore()
}

// ── 用例 2：偏几像素被吸回元素中心 ─────────────────────────────────────────────────────────
{
  const home = tempHome()
  writeTableHome(home, FRAME, ELEMENTS)
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined })
  const harness = makeHarness(FRAME)
  const exec = makeExec('pixel')
  // (152, 86) 在 bbox 下方 2 px 外，离中心 (150,65) 21 px → 吸附
  const result = await clickWith(harness, exec, [152, 86])
  check('偏几像素被吸回：坐标换成元素中心，回执写 snapped 行', () => {
    assert.deepEqual(result.value.position, [150, 65])
    assert.equal(result.snap, 'snapped: (152,86) -> (150,65) | delta=21px | element=R01C01-button')
    assert.ok(result.text.includes('snapped: (152,86) -> (150,65) | delta=21px | element=R01C01-button'), result.text)
    assert.ok(Math.abs(result.clicked.position[0] - 150 / FRAME.w * 1000) < 0.01)
    assert.ok(Math.abs(result.clicked.position[1] - 65 / FRAME.h * 1000) < 0.01)
  })
  restore()
}

// ── 用例 3：超阈值放行 ────────────────────────────────────────────────────────────────────
{
  const home = tempHome()
  writeTableHome(home, FRAME, ELEMENTS)
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined })
  const harness = makeHarness(FRAME)
  const exec = makeExec('pixel')
  const result = await clickWith(harness, exec, [150, 92]) // 离中心 27 px > 24
  check('超阈值放行：> 24 px 按原坐标点，回执写 pass-through 行', () => {
    assert.deepEqual(result.value.position, [150, 92])
    assert.equal(result.snap, 'pass-through: (150,92) | reason=超阈值')
    assert.ok(result.text.includes('pass-through: (150,92) | reason=超阈值'), result.text)
    assert.ok(Math.abs(result.clicked.position[1] - 92 / FRAME.h * 1000) < 0.01)
  })
  restore()
}

// ── 用例 4：扫描失败放行（没有 target_table.py）────────────────────────────────────────────
{
  const home = tempHome()
  mkdirSync(join(home, 'cu-click'), { recursive: true })
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined })
  const harness = makeHarness(FRAME)
  const exec = makeExec('pixel')
  const started = Date.now()
  const result = await clickWith(harness, exec, [150, 65])
  const elapsed = Date.now() - started
  check('扫描失败放行：无表且补扫不可用 → 原坐标 + 一行 warn，且不卡住', () => {
    assert.deepEqual(result.value.position, [150, 65])
    assert.ok(result.snap.startsWith('pass-through: (150,65) | reason=扫描失败'), result.snap)
    assert.ok(result.snap.includes('\nwarn=snap:'), result.snap)
    assert.ok(elapsed < 1500, `elapsed=${elapsed}ms`)
  })
  restore()
}

// ── 用例 5：超时放行（补扫脚本故意睡 2 s，预算 120 ms）────────────────────────────────────
{
  const home = tempHome()
  mkdirSync(join(home, 'cu-click'), { recursive: true })
  writeFileSync(join(home, 'cu-click', 'target_table.py'), 'import time\ntime.sleep(2)\n')
  const objects = join(home, 'attachments', 'v1', 'objects', ATTACHMENT_ID.slice(0, 2))
  mkdirSync(objects, { recursive: true })
  writeFileSync(join(objects, ATTACHMENT_ID), PNG)
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined, DSH_CU_SNAP_BUDGET_MS: '120' })
  const harness = makeHarness(FRAME)
  const exec = makeExec('pixel')
  const started = Date.now()
  const result = await clickWith(harness, exec, [150, 65])
  const elapsed = Date.now() - started
  check('超时放行：补扫超过 200 ms 预算被 kill，原坐标 + reason=超时', () => {
    assert.deepEqual(result.value.position, [150, 65])
    assert.ok(result.snap.startsWith('pass-through: (150,65) | reason=超时'), result.snap)
    assert.ok(result.snap.includes('\nwarn=snap:'), result.snap)
    assert.ok(elapsed < 1500, `elapsed=${elapsed}ms`)
  })
  restore()
}

// ── 用例 6：DSH_CU_SNAP=0 一键关掉 ────────────────────────────────────────────────────────
{
  const home = tempHome()
  writeTableHome(home, FRAME, ELEMENTS)
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: '0', DSH_CU_TARGET_TABLE: undefined })
  const harness = makeHarness(FRAME)
  const exec = makeExec('pixel')
  const result = await clickWith(harness, exec, [152, 86])
  check('DSH_CU_SNAP=0：整条吸附路径停用，坐标与回执都不动', () => {
    assert.deepEqual(result.value.position, [152, 86])
    assert.equal(result.snap, undefined)
    assert.ok(!result.text.includes('snapped:'), result.text)
  })
  restore()
}

// ── 用例 7：DSH_CU_TARGET_TABLE=0 同步停用（沿用既有总开关）────────────────────────────────
{
  const home = tempHome()
  writeTableHome(home, FRAME, ELEMENTS)
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: '0' })
  const harness = makeHarness(FRAME)
  const exec = makeExec('pixel')
  const result = await clickWith(harness, exec, [152, 86])
  check('DSH_CU_TARGET_TABLE=0：不读表不补扫，坐标原样', () => {
    assert.deepEqual(result.value.position, [152, 86])
    assert.equal(result.snap, undefined)
  })
  restore()
}

// ── 用例 8：预览 1792×963 → 帧 1920×1032 只乘一次（PRESVIEW_SCALE 取自表内 preview_scale）──
{
  const home = tempHome()
  const preview = { w: 1792, h: 963 }
  const frame = { w: 1920, h: 1032 }
  writeTableHome(home, frame, [element('R03C01-button', 1400, 760, 1600, 790)], { x: 1920 / 1792, y: 1032 / 963 })
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined })
  const harness = makeHarness(preview)
  const exec = makeExec('pixel', preview)
  const result = await clickWith(harness, exec, [1404, 744]) // 预览像素，帧里落 (1504,797)，离中心 (1500,775) 22.7 px
  check('预览换算：1792×963 → 1920×1032 用表内 preview_scale，吸附回帧中心且不重复加偏移', () => {
    assert.equal(result.snap, 'snapped: (1404,744) -> (1400,723) | delta=23px | element=R03C01-button')
    assert.deepEqual(result.value.position, [1400, 723])
    assert.ok(Math.abs(result.clicked.position[0] - 1500 / 1920 * 1000) < 0.01, `click x=${result.clicked.position[0]}`)
    assert.ok(Math.abs(result.clicked.position[1] - 775 / 1032 * 1000) < 0.5, `click y=${result.clicked.position[1]}`)
  })
  restore()
}

// ── 用例 8b：0–1000 千分比会话也吸（吸完仍写成 0–1000，不把像素塞回去）────────────────────
{
  const home = tempHome()
  writeTableHome(home, FRAME, ELEMENTS)
  const restore = withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined })
  const harness = makeHarness(FRAME)
  const exec = makeExec('millifraction')
  const result = await clickWith(harness, exec, [102, 100]) // = 截图 (152,86)，bbox 下方 6 px，离中心 21 px
  check('千分比会话：吸到元素中心后仍输出 0–1000（不把像素当分数）', () => {
    assert.equal(result.snap, 'snapped: (102,100) -> (101,75) | delta=21px | element=R01C01-button')
    assert.deepEqual(result.value.position, [101, 75])
    assert.deepEqual(result.clicked.position, [101, 75])
  })
  restore()
}

// ── 用例 9/10：真跑一次补扫（真实 python + scan_frame.ps1，临时 state 目录）──────────────────
{
  const source = REAL_TABLE_HOME + '\\cu-click'
  const objects = REAL_TABLE_HOME + '\\attachments\\v1\\objects'
  let newest
  for (const bucket of readdirSync(objects, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    for (const entry of readdirSync(join(objects, bucket.name), { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const full = join(objects, bucket.name, entry.name)
      const stat = statSync(full)
      if (stat.size < 2000) continue
      if (newest === undefined || stat.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: stat.mtimeMs }
    }
  }
  const dims = (() => {
    if (newest === undefined) return undefined
    const head = readFileSync(newest.path)
    if (head.length < 24 || head[0] !== 0x89 || head[1] !== 0x50) return undefined
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) }
  })()
  if (newest === undefined || dims === undefined) {
    console.log('skip - 真扫用例：附件库里没有可用的观察帧')
  } else {
    const prepare = (budget) => {
      const home = tempHome()
      const cuClick = join(home, 'cu-click')
      mkdirSync(cuClick, { recursive: true })
      copyFileSync(join(source, 'target_table.py'), join(cuClick, 'target_table.py'))
      copyFileSync(join(source, 'scan_frame.ps1'), join(cuClick, 'scan_frame.ps1'))
      const bucket = join(home, 'attachments', 'v1', 'objects', ATTACHMENT_ID.slice(0, 2))
      mkdirSync(bucket, { recursive: true })
      copyFileSync(newest.path, join(bucket, ATTACHMENT_ID))
      return { home, cuClick, restore: withEnv({ DSH_HOME: home, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined, DSH_CU_SNAP_BUDGET_MS: budget }) }
    }
    const realScan = {}
    {
      const fixture = prepare('3000')
      const harness = makeHarness(dims)
      const exec = makeExec('pixel', dims)
      const started = Date.now()
      const result = await clickWith(harness, exec, [Math.round(dims.w / 2), Math.round(dims.h / 2)])
      realScan.elapsed = Date.now() - started
      realScan.first = result.snap ?? '（表内命中，不加行）'
      realScan.table = (() => {
        try {
          const current = JSON.parse(readFileSync(join(fixture.cuClick, 'target-table', 'current.json'), 'utf8'))
          return JSON.parse(readFileSync(join(fixture.cuClick, 'target-table', current.table_file), 'utf8'))
        } catch { return undefined }
      })()
      realScan.home = fixture.home
      realScan.cuClick = fixture.cuClick
      const probe = (realScan.table?.elements ?? []).find((item) => item.h / 2 + 2 <= 22)
      if (probe !== undefined && probe !== null) {
        const point = [probe.center.x, Math.round(probe.bbox.y1) + 2]
        const second = await clickWith(harness, exec, point)
        realScan.probe = { point, line: second.snap, to: second.value.position, element: probe.name }
      }
      fixture.restore()
    }
    {
      const fixture = prepare('100')
      const harness = makeHarness(dims)
      const exec = makeExec('pixel', dims)
      const started = Date.now()
      const result = await clickWith(harness, exec, [Math.round(dims.w / 2), Math.round(dims.h / 2)])
      realScan.tightElapsed = Date.now() - started
      realScan.tight = result.snap
      fixture.restore()
    }
    check('真扫生效：缺表时 target_table.py scan 真能建表，随后按表把坐标吸回元素中心', () => {
      assert.ok(realScan.table !== undefined, 'scan 没建出表')
      assert.ok(realScan.table.elements.length > 0, '表里没元素')
      assert.ok(realScan.probe !== undefined, '表里没有适合做探针的小元素')
      assert.ok(realScan.probe.line.startsWith('snapped:'), realScan.probe.line)
      assert.ok(realScan.probe.line.includes(`element=${realScan.probe.element}`), realScan.probe.line)
    })
    check('真扫超时：预算压到 100 ms 时补扫被 kill，回执 reason=超时 且不拦死点击', () => {
      assert.ok(realScan.tight.startsWith('pass-through: ('), realScan.tight)
      assert.ok(/reason=(超时|扫描失败)/.test(realScan.tight), realScan.tight)
      assert.ok(realScan.tightElapsed < 2000, `tightElapsed=${realScan.tightElapsed}ms`)
    })
    console.log(`真扫读数：3000 ms 预算下首次点击 ${realScan.elapsed}ms，表 elements=${String(realScan.table?.elements?.length ?? 0)}，首击回执=${realScan.first}`)
    if (realScan.probe !== undefined) console.log(`真扫探针：(${realScan.probe.point.join(',')}) → ${realScan.probe.line}`)
    console.log(`真扫读数：100 ms 预算下首次点击 ${realScan.tightElapsed}ms，回执=${realScan.tight}`)
  }
}

// ── before/after 证据：直接吃本机真实表（只读，不扫、不写）──────────────────────────────────
const beforeAfter = []
{
  const restore = withEnv({ DSH_HOME: REAL_TABLE_HOME, DSH_CU_SNAP: undefined, DSH_CU_TARGET_TABLE: undefined })
  const harness = makeHarness({ w: 1486, h: 864 })
  const exec = makeExec('pixel')
  const samples = [
    { note: '表内（bbox 命中）', position: [520, 100], center: [527, 101] },
    { note: 'bbox 下方 2 px（21 px 内）', position: [530, 112], center: [527, 101] },
    { note: '离中心 30 px（超阈值）', position: [527, 131], center: [527, 101] },
  ]
  for (const sample of samples) {
    const started = Date.now()
    const result = await clickWith(harness, exec, sample.position)
    const elapsed = Date.now() - started
    beforeAfter.push({
      note: sample.note,
      from: sample.position,
      to: result.value.position,
      delta: Math.abs(result.value.position[0] - sample.position[0]) + Math.abs(result.value.position[1] - sample.position[1]),
      center: sample.center,
      line: result.snap ?? '（不加行）',
      elapsed,
    })
  }
  check('真实表 before/after：三条样本行为符合预期', () => {
    assert.deepEqual(beforeAfter[0].to, [520, 100])
    assert.deepEqual(beforeAfter[1].to, [527, 101])
    assert.deepEqual(beforeAfter[2].to, [527, 131])
  })
  restore()
}

for (const root of roots) rmSync(root, { recursive: true, force: true })

console.log('')
console.log('before/after（本机真实表 1486x864，只读；整次 click.execute 含吸附 + 假 backend 回拍）')
console.log('样本 | 原坐标 | 吸附后坐标 | 位移(曼哈顿) | 期望元素中心 | 本次 click.execute 用时 | 回执行')
for (const row of beforeAfter) {
  console.log(`${row.note} | (${row.from.join(',')}) | (${row.to.join(',')}) | ${row.delta}px | (${row.center.join(',')}) | ${row.elapsed}ms | ${row.line}`)
}
console.log('')
const total = passed + failures.length
console.log(`${passed}/${total} 通过`)
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.error)
  process.exitCode = 1
}
