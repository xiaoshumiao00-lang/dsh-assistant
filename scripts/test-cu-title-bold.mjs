/**
 * 「左侧面板 Computer Use 会话标题加粗」回归（2026-11-22 新需求）。
 *   node scripts/test-cu-title-bold.mjs
 *
 * 三层断言（口径都从 src/client/cu-title-bold.ts / 本次构建的 lib/client.js 直接取，不复制第二遍）：
 *   A. 判据与集合：presetOfSessionRow 四种形状、isComputerUseSessionRow（CU / 标准 / cordis / 空）、
 *      cuSessionIdsOfSnapshot（ids+byId 主口径、projectionsBySession 兜底、{val} 包装、扁平数组）。
 *   A5. 样式表只声明 font-weight（其它排版不动），选择器权重压得住宿主规则。
 *   B. 标记与安装（注入假 document / 假 Observer / 假定时器）：只改该改的（第二次 0 改动 = 增量语义）、
 *      观察者只看 childList + data-row-key、拆安装不留标记与样式残迹、缺服务不崩、只装一份。
 *   C. 真 Chromium 页面里的**宿主形状 DOM**（照 app.asar 取证写：data-row-key="session:<id>"
 *      + class hIlkoa_sessionRow + 内部 hIlkoa_title，并复刻宿主自己的标题规则）：
 *      CU 行 computed font-weight = 700、标准行保持 400、workspace 行永不标记、
 *      新行出现即增量加粗、preset 改回标准即撤粗。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const surface = (await import('../src/client/cu-title-bold.ts')).cuTitleBoldTestSurface

const failures = []
function check(name, fn) {
  try {
    const result = fn()
    if (result instanceof Promise) return result.then(() => console.log(`PASS ${name}`), (error) => {
      failures.push(`${name} — ${String(error?.message ?? error)}`)
      console.error(`FAIL ${name} — ${String(error?.message ?? error)}`)
    })
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name} — ${String(error?.message ?? error)}`)
  }
  return Promise.resolve()
}

/* ================= A. 判据与集合口径 ================= */

await check('A1 会话 id 只从 data-row-key 的 session: 前缀取（workspace 行返回空）', () => {
  assert.equal(surface.sessionIdFromRowKey('session:session-83bca3e3-bcd1-49f0-8b3c-2ec9edae14e3'), 'session-83bca3e3-bcd1-49f0-8b3c-2ec9edae14e3')
  assert.equal(surface.sessionIdFromRowKey('workspace:1ecf27a5-a768-46af-9f28-9137cf9babda'), '')
  assert.equal(surface.sessionIdFromRowKey('session:'), '')
  assert.equal(surface.sessionIdFromRowKey('session:a:b'), '')
  assert.equal(surface.sessionIdFromRowKey(undefined), '')
  assert.equal(surface.sessionIdFromRowKey(''), '')
})

await check('A2 预设取值覆盖列表快照的全部形状（投影拍平 / projections.values / 行顶层 / header / {val} 包装）', () => {
  assert.equal(surface.presetOfSessionRow({ projectionValues: { agentPreset: 'computer-use' } }), 'computer-use')
  assert.equal(surface.presetOfSessionRow({ projections: { values: { agentPreset: 'standard' } } }), 'standard')
  assert.equal(surface.presetOfSessionRow({ agentPreset: 'cordis' }), 'cordis')
  assert.equal(surface.presetOfSessionRow({ header: { agentPreset: 'computer-use' } }), 'computer-use')
  assert.equal(surface.presetOfSessionRow({ projectionValues: { agentPreset: { val: 'computer-use' } } }), 'computer-use')
  assert.equal(surface.presetOfSessionRow({ projectionValues: { agentPreset: { value: 'computer-use' } } }), 'computer-use')
  assert.equal(surface.presetOfSessionRow({ projectionValues: { agentPreset: null } }), '')
  assert.equal(surface.presetOfSessionRow(null), '')
  assert.equal(surface.presetOfSessionRow(undefined), '')
})

await check('A3 CU 判据：只有 preset === "computer-use" 才算（标准/cordis/minimal/空都不算）', () => {
  assert.equal(surface.CU_AGENT_PRESET, 'computer-use')
  assert.equal(surface.isComputerUseSessionRow({ projectionValues: { agentPreset: 'computer-use' } }), true)
  assert.equal(surface.isComputerUseSessionRow({ projectionValues: { agentPreset: 'standard' } }), false)
  assert.equal(surface.isComputerUseSessionRow({ projectionValues: { agentPreset: 'standard-slim-local' } }), false)
  assert.equal(surface.isComputerUseSessionRow({ projectionValues: { agentPreset: 'cordis' } }), false)
  assert.equal(surface.isComputerUseSessionRow({ projectionValues: { agentPreset: 'minimal' } }), false)
  assert.equal(surface.isComputerUseSessionRow({ projectionValues: { agentPreset: '' } }), false)
  assert.equal(surface.isComputerUseSessionRow({}), false)
  // 血缘不参与视觉判定：CU 后台 code_agent 派出来的是标准预设会话，本来就不该加粗
  assert.equal(surface.isComputerUseSessionRow({ projectionValues: { agentPreset: 'standard' }, origin: 'subagent', delegationDepth: 1 }), false)
})

await check('A4 CU 集合从列表快照取（ids+byId 主口径，projectionsBySession 兜底，扁平数组兼容）', () => {
  const ids = surface.cuSessionIdsOfSnapshot({
    ids: ['session-cu-1', 'session-cu-2', 'session-std', 'session-null'],
    byId: {
      'session-cu-1': { projectionValues: { agentPreset: 'computer-use' } },
      'session-cu-2': { projectionValues: { agentPreset: { val: 'computer-use' } } },
      'session-std': { projectionValues: { agentPreset: 'standard' } },
      'session-null': { projectionValues: { agentPreset: null } },
    },
    projectionsBySession: { 'session-cu-3': { values: { agentPreset: 'computer-use' } } },
  })
  assert.deepEqual([...ids].sort(), ['session-cu-1', 'session-cu-2', 'session-cu-3'])
  assert.equal(surface.cuSessionIdsOfSnapshot(null).size, 0)
  assert.equal(surface.cuSessionIdsOfSnapshot({}).size, 0)
  const flat = surface.cuSessionIdsOfSnapshot([
    { sessionId: 'session-a', agentPreset: 'computer-use' },
    { sessionId: 'session-b', agentPreset: 'standard' },
  ])
  assert.deepEqual([...flat], ['session-a'])
  // 没有 ids 时按 byId 的键走
  assert.deepEqual([...surface.cuSessionIdsOfSnapshot({ byId: { 'session-z': { header: { agentPreset: 'computer-use' } } } })], ['session-z'])
})

await check('A5 样式表只声明 font-weight（别的排版一律不碰），且行上两个属性把权重压过宿主标题规则', () => {
  const css = surface.cuTitleBoldCss()
  assert.ok(css.includes('[data-dsh-cu="1"][data-row-key^="session:"] [class*="_title"]'), css)
  // 字面量必须与选择器常量一致（改了常量忘了改字面量会被这条抓到）
  const expected = `[${surface.CU_ROW_ATTR}="1"][data-row-key^="${surface.SESSION_ROW_KEY_PREFIX}"] ${surface.TITLE_SELECTOR}{font-weight:700}`
  assert.equal(surface.CU_TITLE_BOLD_CSS, expected)
  const rules = css.split('\n').filter((line) => line.includes('{'))
  assert.equal(rules.length, 1, `样式应当只有一条规则：${css}`)
  for (const rule of rules) {
    const declarations = rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}')).split(';').map((x) => x.trim()).filter((x) => x !== '')
    assert.equal(declarations.length, 1, `样式规则里多出声明：${rule}`)
    assert.equal(declarations[0], 'font-weight:700')
  }
  assert.ok(!/(margin|padding|color|letter-spacing|font-size|line-height|font-family|display|text-)/.test(css), `样式里出现了排版属性：${css}`)
})

/* ================= B. 标记与安装（假 DOM） ================= */

class FakeEl {
  constructor(tag, attrs = {}) {
    this.tagName = tag
    this.nodeType = 1
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.removed = false
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  removeAttribute(name) { delete this.attrs[name] }
  matches(selector) {
    const m = /^\[([^\]=^]+)(\^?)="([^"]*)"\]$/.exec(selector)
    if (!m) return false
    const value = this.getAttribute(m[1])
    if (value === null) return false
    return m[2] === '^' ? value.startsWith(m[3]) : value === m[3]
  }
  querySelectorAll(selector) {
    const found = []
    const visit = (node) => { for (const child of node.children) { if (child.matches?.(selector)) found.push(child); visit(child) } }
    visit(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  appendChild(node) { node.parent = this; this.children.push(node); return node }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) }
}

function makeFakeDom() {
  const doc = {
    body: new FakeEl('body'),
    head: new FakeEl('head'),
    querySelectorAll(selector) { return doc.body.querySelectorAll(selector) },
    querySelector(selector) { return doc.head.querySelector(selector) ?? doc.body.querySelector(selector) },
    createElement(tag) { return new FakeEl(tag) },
  }
  const row = (sessionId) => {
    const el = new FakeEl('div', { 'data-row-key': `session:${sessionId}`, class: 'hIlkoa_sessionRow' })
    el.appendChild(new FakeEl('span', { class: 'hIlkoa_title' }))
    return el
  }
  const styleTags = () => doc.head.children.filter((el) => el.tagName === 'style')
  return { doc, row, styleTags }
}

await check('B1 markRows 只把 CU 行打属性；重复跑必须 0 改动（增量语义：正确的行不重画）', () => {
  const { doc, row } = makeFakeDom()
  const cu = row('session-cu-1')
  const std = row('session-std-1')
  const work = new FakeEl('div', { 'data-row-key': 'workspace:ws-1', class: 'hIlkoa_projectRow' })
  doc.body.appendChild(cu)
  doc.body.appendChild(std)
  doc.body.appendChild(work)
  assert.equal(surface.markRows([cu, std, work], new Set(['session-cu-1'])), 1)
  assert.equal(cu.getAttribute(surface.CU_ROW_ATTR), '1')
  assert.equal(std.getAttribute(surface.CU_ROW_ATTR), null)
  assert.equal(work.getAttribute(surface.CU_ROW_ATTR), null, 'workspace 行被标记了')
  assert.equal(surface.markRows([cu, std, work], new Set(['session-cu-1'])), 0)
  assert.equal(surface.markRows([cu], new Set()), 1, 'preset 变回标准时没撤粗')
  assert.equal(cu.getAttribute(surface.CU_ROW_ATTR), null)
})

await check('B2 installCuTitleBold：样式注入 + 列表订阅 + 观察者只看 childList 与 data-row-key', () => {
  const { doc, row, styleTags } = makeFakeDom()
  const cuRow = row('session-cu-1')
  const stdRow = row('session-std-1')
  doc.body.appendChild(cuRow)
  doc.body.appendChild(stdRow)

  const timers = []
  let observerCallback = null
  let observedOptions = null
  class FakeObserver {
    constructor(cb) { observerCallback = cb }
    observe(target, options) { observedOptions = options }
    disconnect() { observerCallback = null }
  }
  const listeners = []
  const list = {
    snapshot: {
      ids: ['session-cu-1', 'session-std-1'],
      byId: {
        'session-cu-1': { projectionValues: { agentPreset: 'computer-use' } },
        'session-std-1': { projectionValues: { agentPreset: 'standard' } },
      },
    },
    getSnapshot() { return list.snapshot },
    subscribe(listener) { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1) },
  }

  const dispose = surface.installCuTitleBold({
    ctx: { sessions: { list } },
    doc,
    Observer: FakeObserver,
    schedule: (fn, ms) => { const handle = { fn, ms }; timers.push(handle); return handle },
    cancel: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1) },
  })
  const pump = () => { for (const handle of timers.splice(0)) handle.fn() }

  pump()
  assert.equal(styleTags().length, 1, '样式标签数量不对')
  assert.equal(styleTags()[0].getAttribute('data-plugin'), surface.CU_STYLE_PLUGIN_KEY)
  assert.equal(styleTags()[0].textContent, surface.cuTitleBoldCss())
  assert.equal(cuRow.getAttribute(surface.CU_ROW_ATTR), '1', '首屏没把 CU 会话加粗')
  assert.equal(stdRow.getAttribute(surface.CU_ROW_ATTR), null, '标准会话被加粗')
  assert.ok(observerCallback, '没装 MutationObserver')
  assert.equal(observedOptions.childList, true)
  assert.equal(observedOptions.subtree, true)
  assert.equal(observedOptions.attributes, true)
  assert.deepEqual(observedOptions.attributeFilter, ['data-row-key'])

  // 增量：分页取回 / 派活新开 CU 会话 → 新行出现即加粗
  const newCuRow = row('session-cu-2')
  doc.body.appendChild(newCuRow)
  list.snapshot = {
    ids: [...list.snapshot.ids, 'session-cu-2'],
    byId: { ...list.snapshot.byId, 'session-cu-2': { projectionValues: { agentPreset: 'computer-use' } } },
  }
  observerCallback([{ type: 'childList', addedNodes: [newCuRow] }])
  pump()
  assert.equal(newCuRow.getAttribute(surface.CU_ROW_ATTR), '1', '新增行没被增量加粗')
  // 非行的节点变化不会误标记任何东西
  observerCallback([{ type: 'childList', addedNodes: [new FakeEl('div', { class: 'conversation' })] }])
  pump()
  assert.equal(doc.body.children.filter((el) => el.getAttribute(surface.CU_ROW_ATTR) === '1').length, 2)

  // 列表快照里 preset 改了 → 全量对齐撤粗，且不误伤别的行
  list.snapshot = {
    ids: ['session-cu-1', 'session-std-1', 'session-cu-2'],
    byId: {
      'session-cu-1': { projectionValues: { agentPreset: 'standard' } },
      'session-std-1': { projectionValues: { agentPreset: 'standard' } },
      'session-cu-2': { projectionValues: { agentPreset: 'computer-use' } },
    },
  }
  for (const listener of listeners) listener()
  pump()
  assert.equal(cuRow.getAttribute(surface.CU_ROW_ATTR), null, 'preset 变标准后没撤粗')
  assert.equal(newCuRow.getAttribute(surface.CU_ROW_ATTR), '1', '全量对齐丢了本该粗的行')

  dispose()
  assert.equal(doc.body.children.filter((el) => el.getAttribute(surface.CU_ROW_ATTR) === '1').length, 0, '拆安装后行上留了标记')
  assert.equal(styleTags().length, 0, '拆安装后样式标签没拆掉')
  assert.equal(listeners.length, 0, '拆安装后订阅没解除')
  assert.equal(observerCallback, null, '拆安装后观察者没断开')
})

await check('B3 applyCuTitleBold 同一页面只装一份样式（HMR/重复 apply 先拆旧的）', () => {
  const { doc, row, styleTags } = makeFakeDom()
  const scope = {}
  const ctx = { sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } } }
  const cuRow = row('session-cu-1')
  doc.body.appendChild(cuRow)
  const options = { doc, Observer: undefined, schedule: (fn) => { fn(); return null }, cancel: () => {} }
  surface.applyCuTitleBold(ctx, scope, options)
  surface.applyCuTitleBold(ctx, scope, options)
  surface.applyCuTitleBold(ctx, scope, options)
  assert.equal(styleTags().length, 1, `重复 apply 叠了 ${styleTags().length} 份样式`)
  const dispose = scope[surface.CU_INSTALL_KEY]
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(styleTags().length, 0)
  assert.equal(cuRow.getAttribute(surface.CU_ROW_ATTR), null)
  assert.equal(scope[surface.CU_INSTALL_KEY], undefined, '拆完还留着安装键')
})

await check('B4 缺服务/缺文档也不崩，且不会乱改 DOM', () => {
  const { doc, row } = makeFakeDom()
  const cuRow = row('session-cu-1')
  doc.body.appendChild(cuRow)
  const dispose = surface.installCuTitleBold({ ctx: {}, doc, Observer: undefined, schedule: (fn) => { fn(); return null }, cancel: () => {} })
  assert.equal(cuRow.getAttribute(surface.CU_ROW_ATTR), null, '读不到列表快照却改了 DOM')
  dispose()
  const none = surface.installCuTitleBold({ ctx: {}, doc: null })
  assert.equal(typeof none, 'function')
  none()
  const noSessions = surface.applyCuTitleBold({}, {}, { doc, Observer: undefined, schedule: (fn) => { fn(); return null }, cancel: () => {} })
  assert.equal(typeof noSessions, 'function')
  noSessions()
})

/* ================= C. 真 Chromium：宿主形状 DOM ================= */

const bundleSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
await check('C0 构建契约：lib/client.js 里带着这条样式与属性常量（源码改了产物没改会被抓）', () => {
  assert.ok(bundleSource.includes('[data-dsh-cu="1"][data-row-key^="session:"] [class*="_title"]'), 'lib/client.js 里找不到 CU 加粗样式')
  assert.ok(bundleSource.includes('dsh-assistant-cu-title'), 'lib/client.js 里找不到样式标签标识')
  assert.ok(bundleSource.includes('"computer-use"') || bundleSource.includes("'computer-use'"), 'lib/client.js 里找不到 CU 预设常量')
})

const moduleFile = join(mkdtempSync(join(tmpdir(), 'dsh-cu-bold-')), 'cu-title-bold.js')
await build({
  entryPoints: [join(ROOT, 'src/client/cu-title-bold.ts')],
  outfile: moduleFile,
  bundle: true,
  format: 'iife',
  globalName: 'dshCuBoldApi',
  platform: 'browser',
  target: ['es2022'],
  logLevel: 'silent',
})

// 宿主左侧面板会话列表的真实行形状（取证自 app.asar 的 dsh-client-ui-workspace/lib/client.js）
const FIXTURE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>cu bold fixture</title>
<style>
/* 宿主 Rows.module.css 的等价规则：宿主自己给标题写了 400，插件规则必须压得住 */
.hIlkoa_projectRow,.hIlkoa_sessionRow{border-radius:6px;padding:0 8px;cursor:pointer;color:#111;align-items:center;gap:6px;display:flex}
.hIlkoa_sessionRow{gap:0;height:32px}
.hIlkoa_sessionRow .hIlkoa_title{margin:0 6px 0 4px;flex:1;font-weight:400}
.hIlkoa_sessionRow .hIlkoa_time{font-size:12px;color:#888}
.hIlkoa_slot{width:16px;height:20px;flex:none}
[data-row-key^="workspace:"] .hIlkoa_title{font-weight:500}
</style></head>
<body>
<div id="list" role="tree" aria-label="Sessions">
  <div data-row-key="workspace:1ecf27a5-a768-46af-9f28-9137cf9babda" class="hIlkoa_projectRow" role="treeitem" aria-expanded="true">
    <span class="hIlkoa_title">项目分组行</span>
  </div>
  <div data-row-key="session:session-cu-0001" class="hIlkoa_sessionRow" role="treeitem" aria-selected="false">
    <span class="hIlkoa_slot"></span><span class="hIlkoa_title">看屏幕取模型名</span><span class="hIlkoa_time">16:02</span>
  </div>
  <div data-row-key="session:session-standard-0001" class="hIlkoa_sessionRow" role="treeitem" aria-selected="false">
    <span class="hIlkoa_slot"></span><span class="hIlkoa_title">普通对话会话</span><span class="hIlkoa_time">15:11</span>
  </div>
</div>
</body></html>`

/** 取真浏览器：先试 Playwright 自带 chromium（CI 上是装好的），再退回本机 Chrome（本机实测路径）。 */
const CHROME_CANDIDATES = [
  process.env.DSH_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter((path) => typeof path === 'string' && path !== '')

async function launchFixtureBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch { /* 这台机器没装 playwright 浏览器 */ }
  for (const path of CHROME_CANDIDATES) {
    try {
      return await chromium.launch({ headless: true, executablePath: path, args: ['--no-sandbox'] })
    } catch { /* 换下一个候选 */ }
  }
  return null
}

const browser = await launchFixtureBrowser()
if (browser === null) {
  console.log('SKIP C 段：本机找不到可用的 Chromium/Chrome（DSH_CHROME_PATH 可指定）；A/B 段已覆盖判据与样式口径')
} else try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))
  await page.setContent(FIXTURE_HTML)
  await page.addScriptTag({ path: moduleFile })

  const subscribed = await page.evaluate(() => {
    window.__snapshot = {
      ids: ['session-cu-0001', 'session-standard-0001'],
      byId: {
        'session-cu-0001': { sessionId: 'session-cu-0001', projectionValues: { agentPreset: 'computer-use' } },
        'session-standard-0001': { sessionId: 'session-standard-0001', projectionValues: { agentPreset: 'standard' } },
      },
    }
    const listeners = []
    window.__dispose = globalThis.dshCuBoldApi.applyCuTitleBold({
      sessions: {
        list: {
          getSnapshot: () => window.__snapshot,
          subscribe: (listener) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1) },
        },
      },
    })
    window.__notify = () => { for (const listener of listeners) listener() }
    return listeners.length
  })
  assert.ok(subscribed > 0, '客户端页面里列表订阅没挂上')
  await page.waitForTimeout(800)

  const facts = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-row-key]'))
    return rows.map((row) => ({
      key: row.getAttribute('data-row-key'),
      marked: row.getAttribute('data-dsh-cu'),
      titleWeight: getComputedStyle(row.querySelector('[class*="_title"]')).fontWeight,
      timeWeight: getComputedStyle(row.querySelector('[class*="_time"]') ?? row).fontWeight,
      titleText: row.querySelector('[class*="_title"]')?.textContent ?? '',
      otherStyle: (() => {
        const title = row.querySelector('[class*="_title"]')
        const cs = getComputedStyle(title)
        return { margin: cs.marginLeft, fontSize: cs.fontSize }
      })(),
    }))
  })
  const cu = facts.find((f) => f.key === 'session:session-cu-0001')
  const standard = facts.find((f) => f.key === 'session:session-standard-0001')
  const workspace = facts.find((f) => f.key.startsWith('workspace:'))

  await check('C1 CU 行：行上有插件属性，标题 computed font-weight = 700', () => {
    assert.equal(cu.marked, '1', JSON.stringify(cu))
    assert.equal(cu.titleWeight, '700', JSON.stringify(cu))
  })
  await check('C2 标准会话行：没有插件属性，标题维持宿主的 400', () => {
    assert.equal(standard.marked, null, JSON.stringify(standard))
    assert.equal(standard.titleWeight, '400', JSON.stringify(standard))
  })
  await check('C3 项目分组行（workspace: 前缀）永不标记，样式也不受影响', () => {
    assert.equal(workspace.marked, null, JSON.stringify(workspace))
    assert.equal(workspace.titleWeight, '500', JSON.stringify(workspace))
  })
  await check('C4 除 font-weight 之外没有别的排版被改（margin/字号/行高与标准行一致）', () => {
    assert.equal(cu.otherStyle.margin, standard.otherStyle.margin, `标题 margin 被改了：${cu.otherStyle.margin} vs ${standard.otherStyle.margin}`)
    assert.equal(cu.otherStyle.fontSize, standard.otherStyle.fontSize, `标题字号被改了：${cu.otherStyle.fontSize}`)
    assert.equal(cu.timeWeight, standard.timeWeight, `时间列字重被顺带动到了：${cu.timeWeight}`)
  })

  const styleInPage = await page.evaluate(() => {
    const tag = document.querySelector('style[data-plugin="dsh-assistant-cu-title"]')
    return { count: document.querySelectorAll('style[data-plugin="dsh-assistant-cu-title"]').length, text: tag?.textContent ?? '' }
  })
  await check('C5 样式表由插件注入（只有一份）且正文与源码口径一致', () => {
    assert.equal(styleInPage.count, 1, JSON.stringify(styleInPage))
    assert.equal(styleInPage.text, surface.cuTitleBoldCss())
  })

  // 增量：宿主插入新的 CU 会话行（分层 B/C 新开 CU 会话、分页取回）
  await page.evaluate(() => {
    const list = document.getElementById('list')
    const row = document.createElement('div')
    row.setAttribute('data-row-key', 'session:session-cu-0002')
    row.setAttribute('class', 'hIlkoa_sessionRow')
    row.setAttribute('role', 'treeitem')
    row.innerHTML = '<span class="hIlkoa_slot"></span><span class="hIlkoa_title">新派活的 CU 会话</span><span class="hIlkoa_time">16:20</span>'
    list.appendChild(row)
    window.__snapshot = {
      ids: [...window.__snapshot.ids, 'session-cu-0002'],
      byId: { ...window.__snapshot.byId, 'session-cu-0002': { projectionValues: { agentPreset: 'computer-use' } } },
    }
  })
  await page.waitForTimeout(900)
  const added = await page.evaluate(() => {
    const row = document.querySelector('[data-row-key="session:session-cu-0002"]')
    return { marked: row.getAttribute('data-dsh-cu'), weight: getComputedStyle(row.querySelector('[class*="_title"]')).fontWeight }
  })
  await check('C6 新会话行出现即增量加粗', () => {
    assert.equal(added.marked, '1', JSON.stringify(added))
    assert.equal(added.weight, '700', JSON.stringify(added))
  })

  // 快照里 preset 变回标准 → 撤粗
  await page.evaluate(() => {
    window.__snapshot = {
      ids: window.__snapshot.ids,
      byId: { ...window.__snapshot.byId, 'session-cu-0001': { projectionValues: { agentPreset: 'standard' } } },
    }
    window.__notify()
  })
  await page.waitForTimeout(900)
  const changed = await page.evaluate(() => {
    const row = document.querySelector('[data-row-key="session:session-cu-0001"]')
    return { marked: row.getAttribute('data-dsh-cu'), weight: getComputedStyle(row.querySelector('[class*="_title"]')).fontWeight }
  })
  await check('C7 会话预设改回标准：属性撤掉、标题回到 400', () => {
    assert.equal(changed.marked, null, JSON.stringify(changed))
    assert.equal(changed.weight, '400', JSON.stringify(changed))
  })

  const disposed = await page.evaluate(() => {
    window.__dispose()
    return {
      marked: document.querySelectorAll('[data-dsh-cu]').length,
      style: document.querySelectorAll('style[data-plugin="dsh-assistant-cu-title"]').length,
      weight: getComputedStyle(document.querySelector('[data-row-key="session:session-cu-0002"]') .querySelector('[class*="_title"]')).fontWeight,
    }
  })
  await check('C8 拆安装不留残迹（标记清零、样式拆掉、视觉回到宿主原样）', () => {
    assert.equal(disposed.marked, 0, JSON.stringify(disposed))
    assert.equal(disposed.style, 0, JSON.stringify(disposed))
    assert.equal(disposed.weight, '400', JSON.stringify(disposed))
  })

  await check('C9 页面没有未捕获异常', () => {
    assert.deepEqual(pageErrors, [], pageErrors.join('\n'))
  })
} finally {
  await browser.close()
}

if (failures.length > 0) {
  console.error(`\ntest-cu-title-bold: ${failures.length} 条失败`)
  for (const name of failures) console.error('  - ' + name)
  process.exit(1)
}
console.log('\ntest-cu-title-bold: 全绿')
