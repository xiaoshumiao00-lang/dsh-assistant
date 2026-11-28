/**
 * 单测：Computer Use 坐标模式设置（src/coordinate-mode.ts）。
 *   node scripts/test-coordinate-mode.mjs
 *
 * 固定这几条边界：
 *   - 没有配置文件时按平台缺省（Windows 千分比、其它像素），与 dsh-orb 一致；
 *   - 已有 millifraction-coordinates.json 时直接继承老设置；
 *   - POST 写盘后服务 currentMode() 立刻变，GET 读回同一值；
 *   - 非布尔 body 拒绝；卸载函数摘掉服务。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { registerCoordinateMode, COORDINATE_MODE_ROUTE, computerUseCoordinatePolicyText, cuMeasureScriptPath, CU_POLICY_SECTION_ORDER, CU_COORDINATE_GATES, cuCoordinateGateLine, cuScanFrameScriptPath, cuTargetTableScriptPath, cuTargetTableDir, CU_TARGET_TABLE_ENV, CU_TARGET_TABLE_DEFAULT_ENABLED, CU_TARGET_TABLE_FALLBACK_BUDGET_MS, CU_TARGET_TABLE_MAX_RETRY, CU_TARGET_TABLE_STRUCT_GRID_PX, CU_TARGET_TABLE_JITTER_PX, CU_TARGET_TABLE_PREVIEW_SCALE, CU_TARGET_TABLE_INVALIDATING_ACTIONS, targetTableEnabled } from '../src/coordinate-mode.ts'

function makeCtx(dir, extra = {}) {
  const routes = new Map()
  const services = new Map()
  const errors = []
  const hooks = new Map()
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir }
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    on(name, fn) {
      const list = hooks.get(name) ?? []
      list.push(fn)
      hooks.set(name, list)
      return () => {
        const next = (hooks.get(name) ?? []).filter((item) => item !== fn)
        hooks.set(name, next)
      }
    },
    inject() {},
    webServer: {
      register(route) { routes.set(route.path, route) },
    },
    logger: () => ({ info() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) }),
    ...extra,
  }
  return { ctx, routes, services, errors, hooks }
}

async function call(handler, method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = COORDINATE_MODE_ROUTE
  let status = 0
  let raw = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { raw += chunk ?? '' },
  }
  await handler(req, res)
  return { status, body: raw ? JSON.parse(raw) : null }
}

// 2026-11-25 起缺省不再是「Windows 用千分比」：所有平台（含 win32）默认像素。
const platformDefault = false
const cases = []

cases.push(['无配置文件 → 平台缺省 + GET 读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    assert.ok(services.has('assistantCoordinateMode'), '应提供 assistantCoordinateMode 服务')
    const service = services.get('assistantCoordinateMode')
    assert.equal(service.currentMode(), platformDefault ? 'millifraction' : 'pixel')

    const route = routes.get(COORDINATE_MODE_ROUTE)
    assert.ok(route, '应注册坐标模式路由')
    const got = await call(route.handler, 'GET')
    assert.equal(got.status, 200)
    assert.equal(got.body.ok, true)
    assert.equal(got.body.enabled, platformDefault)
    assert.equal(got.body.mode, platformDefault ? 'millifraction' : 'pixel')
    dispose()
    assert.equal(services.has('assistantCoordinateMode'), false, '卸载后服务应移除')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['POST false → 写盘、服务变 pixel、GET 读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    const route = routes.get(COORDINATE_MODE_ROUTE)
    const service = services.get('assistantCoordinateMode')

    const posted = await call(route.handler, 'POST', { enabled: false })
    assert.equal(posted.status, 200)
    assert.equal(posted.body.enabled, false)
    assert.equal(posted.body.mode, 'pixel')
    assert.equal(service.currentMode(), 'pixel')

    const file = join(dir, 'millifraction-coordinates.json')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabled: false })

    const got = await call(route.handler, 'GET')
    assert.equal(got.body.enabled, false)
    assert.equal(got.body.mode, 'pixel')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['已有配置文件 → 继承（不覆盖用户老选择）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    assert.equal(services.get('assistantCoordinateMode').currentMode(), 'pixel')
    const got = await call(routes.get(COORDINATE_MODE_ROUTE).handler, 'GET')
    assert.equal(got.body.enabled, false)
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['非法 body → 400，且不改设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    const route = routes.get(COORDINATE_MODE_ROUTE)
    const before = services.get('assistantCoordinateMode').currentMode()

    const bad = await call(route.handler, 'POST', { enabled: 'no' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)
    assert.equal(services.get('assistantCoordinateMode').currentMode(), before)
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['服务 setter 与路由共用同一状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    const service = services.get('assistantCoordinateMode')
    await service.setMillifractionEnabled(false)
    assert.equal(service.currentMode(), 'pixel')
    const got = await call(routes.get(COORDINATE_MODE_ROUTE).handler, 'GET')
    assert.equal(got.body.enabled, false)
    await service.setMillifractionEnabled(true)
    assert.equal(service.currentMode(), 'millifraction')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['内嵌 computer-use 优先读个人助手服务（防止同步 vendor 时丢改动）', async () => {
  const vendor = readFileSync(new URL('../vendor/computer-use/index.js', import.meta.url), 'utf8')
  assert.match(
    vendor,
    /ctx\.get\("assistantCoordinateMode"\) \?\? ctx\.get\("orbCoordinateMode"\)/,
    'stampCoordinateMode 应优先读 assistantCoordinateMode，再回退 dsh-orb 的 orbCoordinateMode',
  )
}])

cases.push(['新建 CU 会话首轮不崩：像素模式下宿主播浪载荷缺 tools 也不许抛 map of undefined', async () => {
  // 2026-11-28 根因回归（真实 vendor 模块 + 真实服务，不 mock 出错的那一行）：
  // 宿主 dsh-system-prompt 的 system-prompt/assemble 载荷 PromptPresentation 只带
  // sections / contexts / variables，tools 是瀑布返回之后才挂的；内嵌 computer-use 的像素
  // 模式钩子却读 nextAssembly.tools 再 .map()（vendor/computer-use/index.js:329｜:1230）
  // ⇒ 新建 CU 会话（进程内新盖 pixel 戳）首轮必抛
  //   TypeError: Cannot read properties of undefined (reading 'map')
  // 修法：coordinate-mode 注册时把缺的 tools 补进同一个载荷对象（跑在 vendor 之外层）。
  const { applyComputerUse, createFakeDesktopBackend, resolveComputerUseConfig } = await import('../lib/computer-use.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    // 当前 profile 的真实取值：enabled=false → pixel
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const clickSchema = () => [{
      name: 'click',
      description: 'Click at a 0–1000 position on the attached frontmost-window screenshot.',
      parameters: {
        type: 'object',
        properties: {
          screen_index: { type: 'integer', description: 'Screen' },
          position: { type: 'array', description: '0–1000 position' },
        },
      },
    }]
    const { ctx, services, hooks } = makeCtx(dir, {
      tools: { schemas: () => clickSchema(), register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    })
    const dispose = registerCoordinateMode(ctx)
    assert.equal(services.get('assistantCoordinateMode').currentMode(), 'pixel', '前置：这条用例必须跑在像素模式')
    // 预设插件（内嵌 computer-use）之后才实例化 → 它的监听器排在我们后面（内层）
    applyComputerUse(ctx, createFakeDesktopBackend(), resolveComputerUseConfig({}))

    const session = { id: 'session-coordinate-mode-regression', snapshotEvents: () => [], append: () => ({ seq: 0 }) }
    for (const fn of hooks.get('agent/created') ?? []) await fn({ agent: { session } })

    const assembleHooks = hooks.get('system-prompt/assemble') ?? []
    assert.ok(assembleHooks.length >= 1, '内嵌 computer-use 应注册像素模式的 assemble 钩子')
    // 按 cordis waterfall 的真实语义串起来：同一个载荷对象依次进每个监听器，
    // 最内层 next() 返回这个对象本身（= 宿主 assemble() 的兜底 inner）。
    const payload = { sections: [], contexts: [], variables: {} }
    const context = { agent: { session }, modelSelection: { provider: 'x', model: 'y' } }
    let call = async () => payload
    for (let index = assembleHooks.length - 1; index >= 0; index -= 1) {
      const fn = assembleHooks[index]
      const inner = call
      call = () => fn(payload, context, inner)
    }
    let thrown = null
    try {
      await call()
    } catch (err) {
      thrown = err
    }
    assert.equal(thrown, null, `不该再抛错，实际：${thrown?.message ?? ''}`)
    assert.ok(Array.isArray(payload.tools), '载荷里应补上 tools（内嵌 SU 的像素模式前置条件）')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

/* ══════════════════════════════════════════════════════════════════════════
   2026-11-28 CU 坐标门注入回归（src/coordinate-mode.ts 的注入段）
   真监听器串联：宿主 SystemPrompt.section 的注册 → 宿主先解析段落 text(context) →
   system-prompt/assemble 瀑布按注册顺序（最外层先跑）依次喂同一个载荷 →
   瀑布之后才挂 tools。被测的那一段（注册 + 瀑布 + 门控）一律走真实代码，不 mock。
   ══════════════════════════════════════════════════════════════════════════ */

/** 规则里必须在场的关键句（用户口径：先量后点 / 包围盒 / 落点核对 / 连续 2 次 / 固定脚本 / 默认不等待 / REGION-ECHO）。 */
const RULE_MARKERS = ['先量后点', '包围盒', 'Pointer landed', '未命中', 'measure.ps1', 'attached_size', 'MERGE-SPAN', '默认不等待', 'REGION-ECHO']

/** 内嵌 computer-use 在 CU 会话装配里自己的策略段锚点。 */
const VENDOR_POLICY_MARKER = 'Coordinates:'

function clickSchemaForHarness() {
  return [{
    name: 'click',
    description: 'Click at a 0–1000 position on the attached frontmost-window screenshot.',
    parameters: {
      type: 'object',
      properties: {
        screen_index: { type: 'integer', description: 'Screen' },
        position: { type: 'array', description: '0–1000 position' },
      },
    },
  }]
}

/** 宿主侧装配台：段注册表 + 瀑布监听器 + agent/created 监听器（与真宿主的形状一致）。 */
function makeHostHarness(dir, { withSystemPrompt = true } = {}) {
  const routes = new Map()
  const services = new Map()
  const hooks = new Map()
  const sections = []
  const errors = []
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir }
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    on(name, fn) {
      const list = hooks.get(name) ?? []
      list.push(fn)
      hooks.set(name, list)
      return () => {
        const next = (hooks.get(name) ?? []).filter((item) => item !== fn)
        hooks.set(name, next)
      }
    },
    inject() {},
    webServer: { register(route) { routes.set(route.path, route) } },
    logger: () => ({ info() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) }),
    tools: { schemas: () => clickSchemaForHarness(), register: () => () => {} },
  }
  if (withSystemPrompt) {
    ctx.systemPrompt = {
      section(definition) {
        sections.push(definition)
        return () => {}
      },
    }
  }
  return { ctx, routes, services, hooks, sections, errors }
}

/** 跑一次「宿主 assemble」：解析注册段 → 瀑布 → 挂 tools。返回拼好的系统提示文本。 */
async function assemblePresentation(harness, session) {
  const context = { agent: { session }, modelSelection: { provider: 'x', model: 'y' } }
  const ordered = [...harness.sections].sort((a, b) => (
    (a.order - b.order) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  ))
  const payload = {
    sections: ordered.map((section) => ({
      name: section.name,
      text: typeof section.text === 'function' ? section.text(context) : section.text,
    })),
    contexts: [],
    variables: {},
  }
  const chain = harness.hooks.get('system-prompt/assemble') ?? []
  let cursor = 0
  const next = async () => {
    if (cursor >= chain.length) return payload
    const fn = chain[cursor]
    cursor += 1
    return fn(payload, context, next)
  }
  const assembly = await next()
  const text = (assembly.sections ?? []).map((section) => section.text).filter(Boolean).join('\n')
  return { assembly, text, context }
}

/** 新建会话的宿主会话记录：没有 session/end-seed，预设只在宿主投影里。 */
function newComputerUseSession(id) {
  return { id, snapshotEvents: () => [], append: () => ({ seq: 0 }) }
}

/** 续接会话的宿主会话记录：日志里已有 session/end-seed，预设只剩 header。 */
function resumedComputerUseSession(id) {
  return {
    id,
    header: { agentPreset: 'computer-use' },
    snapshotEvents: () => [{ type: 'session/end-seed' }],
    append: () => ({ seq: 0 }),
  }
}

/** 把内嵌 computer-use（预设里的真模块）挂到同一个装配台上：它自己的监听器排在我们之后（内层）。 */
async function mountComputerUse(harness) {
  const vendor = await import('../lib/computer-use.js')
  vendor.applyComputerUse(harness.ctx, vendor.createFakeDesktopBackend(), vendor.resolveComputerUseConfig({}))
  return vendor
}

/** 触发宿主 agent/created（内嵌 computer-use 在这里给新建会话盖坐标模式戳）。 */
async function fireAgentCreated(harness, session) {
  for (const fn of harness.hooks.get('agent/created') ?? []) await fn({ agent: { session } })
}

function assertRulePresent(text, label) {
  assert.ok(text.includes('CU 坐标门'), `${label}：装配出的系统提示里应有这段规则`)
  for (const marker of RULE_MARKERS) {
    assert.ok(text.includes(marker), `${label}：规则里缺关键句「${marker}」`)
  }
  assert.equal(text.split('CU 坐标门').length - 1, 1, `${label}：同一份装配里不许注入两遍`)
}

cases.push(['新建 CU 会话：装配出的系统提示带坐标硬规则（含落点核对与连续 2 次未命中改路）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cmpol-'))
  try {
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const harness = makeHostHarness(dir)
    const dispose = registerCoordinateMode(harness.ctx)
    // 新建会话：宿主投影里有 agentPreset，header 里还没有
    harness.ctx.provide('sessionProjections', {
      register: () => () => {},
      cachedSnapshot: () => ({ values: { agentPreset: 'computer-use' } }),
      stateOf: () => 'computer-use',
    })
    await mountComputerUse(harness)
    const session = newComputerUseSession('session-cu-policy-new')
    await fireAgentCreated(harness, session)

    const first = await assemblePresentation(harness, session)
    assertRulePresent(first.text, '新建 CU 会话')
    assert.ok(first.text.includes(VENDOR_POLICY_MARKER), '内嵌 computer-use 自己的坐标口径应在场')
    assert.ok(first.text.indexOf(VENDOR_POLICY_MARKER) < first.text.indexOf('CU 坐标门'),
      '规则应紧跟在这次会话的坐标口径之后')
    assert.ok(first.text.includes(cuMeasureScriptPath(harness.ctx)),
      '规则里的量坐标脚本路径应按宿主给的 profile 目录派生')
    assert.ok(Array.isArray(first.assembly.tools), '瀑布之后装配载荷仍应带 tools（4519444 的补丁没被冲垮）')

    const second = await assemblePresentation(harness, session)
    assert.ok(second.text.includes('先量后点'), '下一轮装配仍应带规则（不是会话创建时一次性拼死）')
    assert.equal(second.text.split('CU 坐标门').length - 1, 1, '下一轮也不许重复注入')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['续接的 CU 会话（日志已有 end-seed，预设只在 header 里）同样带这段规则', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cmpol-'))
  try {
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const harness = makeHostHarness(dir)
    const dispose = registerCoordinateMode(harness.ctx)
    await mountComputerUse(harness)
    const session = resumedComputerUseSession('session-cu-policy-resume')
    await fireAgentCreated(harness, session)

    const assembled = await assemblePresentation(harness, session)
    assertRulePresent(assembled.text, '续接 CU 会话')
    assert.ok(assembled.text.includes('0–1000 space'), '老会话仍按内嵌 computer-use 的千分比口径（回落不盖戳）')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['读不到预设时按坐标模式戳认 CU 会话（续接老会话的兜底判据）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cmpol-'))
  try {
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const harness = makeHostHarness(dir)
    const dispose = registerCoordinateMode(harness.ctx)
    await mountComputerUse(harness)
    const session = {
      id: 'session-cu-policy-stamp',
      snapshotEvents: () => [{ type: 'computer-use/coordinate-mode', data: { mode: 'pixel' } }],
      append: () => ({ seq: 0 }),
    }
    const assembled = await assemblePresentation(harness, session)
    assertRulePresent(assembled.text, '只有坐标模式戳可辨的 CU 会话')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['标准会话不受影响：规则一个字符都不多，门控返回空串', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cmpol-'))
  try {
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const harness = makeHostHarness(dir)
    const dispose = registerCoordinateMode(harness.ctx)
    harness.ctx.provide('sessionProjections', {
      register: () => () => {},
      cachedSnapshot: () => ({ values: { agentPreset: 'standard' } }),
      stateOf: () => 'standard',
    })
    const session = { id: 'session-standard-policy', snapshotEvents: () => [], append: () => ({ seq: 0 }) }
    const assembled = await assemblePresentation(harness, session)
    assert.ok(!assembled.text.includes('CU 坐标门'), '标准会话的提示里不该有 CU 规则')
    assert.ok(!assembled.text.includes('measure.ps1'), '标准会话的提示里不该有量坐标脚本路径')
    const gate = harness.sections.find((section) => section.name === 'assistant:computer-use-coordinate-policy')
    assert.ok(gate, '规则段应注册在全局层（靠门控决定这条会话要不要）')
    assert.equal(gate.text(assembled.context), '', '门控对标准会话必须返回空串')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['宿主没给 systemPrompt 服务时瀑布兜底补段，且不注册段也不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cmpol-'))
  try {
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const harness = makeHostHarness(dir, { withSystemPrompt: false })
    const dispose = registerCoordinateMode(harness.ctx)
    const session = resumedComputerUseSession('session-cu-policy-fallback')
    const assembled = await assemblePresentation(harness, session)
    assert.equal(harness.sections.length, 0, '这条用例必须在拿不到 systemPrompt.section 的宿主形状下跑')
    assertRulePresent(assembled.text, '瀑布兜底')
    assert.ok(assembled.assembly.sections.some((section) => section.name === 'assistant:computer-use-coordinate-policy'),
      '兜底补进去的段应带同一个名字')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['规则正文：坐标门与量测协议齐、长度受控、算式与脚本参数都在', async () => {
  const rule = computerUseCoordinatePolicyText()
  for (const marker of RULE_MARKERS) assert.ok(rule.includes(marker), `规则正文缺「${marker}」`)
  assert.ok(rule.includes('分数 = 中心像素 ÷ 截图宽或高 × 1000'), '缺少分数换算算式')
  assert.ok(rule.includes('click/drag/input_text/long_press'), '四个动手类工具必须逐个点名')
  assert.ok(rule.includes('同一目标跨帧未命中=2'), '缺少跨帧 2 次未命中的改路口径')
  assert.ok(rule.includes('禁止第 3 次同坐标'), '缺少不许第 3 次同坐标')
  assert.ok(rule.includes('-Mode dark|blue|yellow|gray -Split <int> -MinPixels <int>'), '脚本参数口径不完整')
  assert.ok(rule.includes('-X0 <int> -X1 <int> -Y0 <int> -Y1 <int>'), '包含边界四参数必须写清类型')
  assert.ok(rule.includes('TOTAL bbox') && rule.includes('center=(x,y) fraction=[x,y]'), '脚本输出字段没写清')
  assert.ok(rule.includes('frame=<量测打印值>'), '坐标必须带来源帧指纹')
  const cjk = (rule.match(/[\u4e00-\u9fff]/g) ?? []).length
  // 预算随门数走：12 道门时是 800 汉字 / 1800 字符；加 G14/G15 后 985 / 2427；G14 收紧后 1037 / 2594。
  // 2026-11-29 追加 G16…G20（14 → 19 道门）并把 G14/G15 里与脚本 usage 重复的说明删掉后，
  // 实测 1243 汉字 / 2962 字符——上限就是这两个实测值（提交说明里同步登记），
  // 再加门或再加判据句必须先删字，不许悄悄放宽上限。
  // 2026-11-29 追加 G21…G24（目标表：查表命中/结构变即作废/兜底单次/失效条件）与「扫→查→作废→兜底→换算」
  // 协议段后，实测 1821 汉字 / 4446 字符——上限同步提到这两个实测值（新增的是机制说明，不是重复话）。
  assert.ok(cjk <= 1821, `规则正文要短：汉字 ${cjk} 个（上限 1821 = 23 道门 + 目标表协议的实测值）、全段 ${[...rule].length} 字符`)
  assert.ok([...rule].length <= 4446, `规则正文字符数超限：${[...rule].length}（上限 4446 = 23 道门 + 目标表协议的实测值）`)
  assert.ok(CU_POLICY_SECTION_ORDER > 1750 && CU_POLICY_SECTION_ORDER < 1770, `段位次序应紧跟内嵌 SU 的 1750（实际 ${CU_POLICY_SECTION_ORDER}）`)
  assert.ok(cuMeasureScriptPath().endsWith(join('cu-click', 'measure.ps1')), '量坐标脚本路径应落在 <DSH_HOME>/cu-click 下')
  // 宿主真形态：profile 目录 = <DSH_HOME>/profiles/<名字>，脚本在 <DSH_HOME>/cu-click/ 下
  const fakeRoot = join(tmpdir(), 'dsh-root-fixture')
  const fakeCtx = { get: (name) => (name === 'profileContext' ? { dir: join(fakeRoot, 'profiles', 'desktop') } : undefined) }
  assert.equal(cuMeasureScriptPath(fakeCtx), join(fakeRoot, 'cu-click', 'measure.ps1'), '脚本路径应从 profile 目录退回 DSH_HOME')
}])

/* ══════════════════════════════════════════════════════════════════════════
   2026-11-28 坐标门机制化回归：门表 = 正文唯一来源，每条门都必须能机械判定
   （条件里带 ∈/∉/≠/≥/=，动作是祈使句，不许出现建议式措辞）。
   ══════════════════════════════════════════════════════════════════════════ */

/** 门行格式：`[G1 帧] 条件：… → 动作：…`；正则解析失败就是正文结构被写散了。 */
const GATE_LINE = /^\[(G\d+) ([^\]]+)\] 条件：(.+?) → 动作：(.+)$/
/** 散文式措辞黑名单：门是判定，不是建议。 */
const SOFT_WORDS = /建议|尽量|最好|酌情|视情况|可以考虑|或许|按需|争取/

/** 每道门必须点到的判据（用户逐条给的口径，少一条就算门没做完）。 */
const GATE_MARKERS = {
  G1: ['click/drag/input_text/long_press', '不带 frame=', '≠当前 frontmost 帧', '未命中≥1', '作废'],
  G2: ['改筛选', '排序', '滚动', '开窗', '换标签', '展开', '折叠', '窗口移动', 'resize', '纯输入/纯热键/纯读不算重排'],
  G3: ['加速键/Tab/Enter', '原生输入框/地址栏/名称字段/type-to-select/原生搜索', '大 hit 原生控件', '最后一级', '不禁用'],
  G4: ['y 带', 'x 跨度', '容器'],
  G5: ['MERGE-SPAN REJECT', '候选簇≥2', '拒绝取 center 值', '-Split', '拆区'],
  G6: ['跨帧未命中=2', '换定位方式', '第 3 次'],
  G7: ['caret', 'hover 预览', '浮层气泡', '放大镜', '不进入坐标候选'],
  G8: ['frontmost_app', '窗口偏移表', '无表项一律不减'],
  G9: ['frontmost_window', 'frontmost_folder', '≠ 期望实体名', '换帧重算'],
  G10: ['count∉{1,2}', 'scroll_level∉1..10', 'screen_index/position', '工具标签片段', '报出字段名'],
  // 2026-11-29 等待门收紧：默认不等待，只有「最新帧可见 loader/spinner/进度条/尚未出现的控件
  // 且该目标就是本次要继续操作的对象」这一个例外；wait 1s 最多连开 3 次，long_wait 全档禁。
  G11: ['默认不等待', 'loader', 'spinner', '进度条', '尚未出现的控件', '目标=本次要继续操作对象',
    '仅 wait 1s', '最多连开 3 次', '上限 3s', 'long_wait∈{10,30,60,120}', '全禁',
    'bash sleep/pwsh 等待全禁', '回执截图=最新帧', '换帧重取', 'screenshot'],
  G12: ['书签 JSON', '设置文件', '注册表', 'UI 真值'],
  // 2026-11-29 新增两道通用门（用户口径，门号按用户给定写成 G14/G15，G13 空号）。
  // G14 测量独立性：TOTAL bbox 与 region 两轴同形 ⇒ REGION-ECHO（中心值是猜测），但数值门槛固定 60 px：
  // 只有搜索区任一边 ≥ 60 px 才判回显；两边都 < 60 px（手工收窄到目标周围的小区）豁免，改判 ACCEPT。
  // 判据由 measure_core.py 在同一次测量输出里给出，只在真同形时触发一次重测（不逐目标预检）。
  // 2026-11-29 压缩：then 只留机械判据与出口，删掉「脚本自己会打印补救文字」那类重复说明
  // （REGION-ECHO 由本次输出给出、落点核对再讲一遍、<50×50 px 的键盘等效与 G3 重复），
  // 所以这里的判据表只列还留在门文里的字面。
  G14: ['TOTAL bbox 的 x 跨度 = region 的 x 跨度', 'y 跨度 = region 的 y 跨度', 'REGION-ECHO',
    '禁止取该中心', '-Split <int>', '重测一次', '元素/簇 bbox', '比对 region 不算命中',
    '静态 chrome', '标题栏', '菜单文字', '地址栏', '标签', '只在该行出现时重测一次', '不逐目标预检',
    'region 宽或高任一边 ≥ 60 px', 'region 两边都 < 60 px', 'span 相等不判 REGION-ECHO',
    'SPAN-EQUAL tight-region (<60px): center=ACCEPT', '照常用该中心与分数',
    '只豁免同形回显这一判据', 'MERGE-SPAN（簇间隙 ≥ -MergeGap）与簇中心照旧独立生效'],
  // G15 出口优先：读内容 / 发送类动作都先走应用自身出口，再退到逐屏 OCR / 点控件；
  // 只在出口存在时优先，出口不存在照旧走坐标（不禁用 GUI）。
  G15: ['读内容：网页/回答/文档/表格/日志/终端输出', '发送类动作：发送/确认/地址栏/重命名',
    '原生出口∈{复制钮,导出,下载,剪贴板,已有文件,命令读取}', '逐屏滚动 OCR',
    '先走键盘等效∈{Enter,Ctrl+Enter,Tab,加速键,原生输入框}', '点控件',
    '出口不存在时照旧走坐标', 'GUI 不禁用'],
  // 2026-11-29 第二批五道通用门（用户口径 G16…G20，仍不回填 G13）。条件里都有可机械求值的
  // ∈/≠/=，动作全是祈使句；五道门都不引入额外观察/量测轮次（G11 仍是唯一能提 screenshot 的门）。
  G16: ['帧∈{右键菜单,下拉,对话框,tooltip 浮层}', '同一次 -Split', '按行列出簇', '按该簇中心点击',
    '禁止用上一行 y 推算下一行坐标', '命中失败按 G6 换路'],
  G17: ['刚做过∈{下载,导出,另存,打印成文件}', 'Get-ChildItem', 'mtime 与字节数',
    '无新文件=该 UI 出口失效', '改走剪贴板', '禁止再点同一图标'],
  G18: ['任务∈{交付位图,取出位图}', '「复制为图像/复制为PNG」', '剪贴板落盘', '自动去边框',
    '截图裁剪只作最后兜底', '剪贴板给确定尺寸', '不受截图分辨率上限约束'],
  G19: ['原生命令/菜单项∈{变灰,不可用}', 'gating∈{锁定,未选中,分组,图层隐藏,只读,模态窗未关}',
    '再回同菜单同行重试', '禁止判定该功能不存在'],
  G20: ['input_text 焦点点击∈{画布,文本编辑器,表格,文档区}', '先量该字段 bbox', '回执帧见 caret',
    '无 caret=撤销一次（Ctrl+Z）', '复验对象状态', '禁止把 URL/正文打进编辑区'],
  // 2026-11-29 目标表（坐标缓存）四道硬门：查表命中零测量 / 结构变即作废 / 兜底单次 0.2s / 失效条件。
  // 数字口径与常量同源：0.03s/0.17s 是 scan_frame 实测，0.2s = CU_TARGET_TABLE_FALLBACK_BUDGET_MS，
  // 1.0714/1.0717 = CU_TARGET_TABLE_PREVIEW_SCALE。四道门都不许把观察/量测轮次加上去。
  G21: ['当前帧结构指纹 = 表内 structural_hash', 'coordinate_space = 表内 coordinate_space',
    '目标名字 ∈ 表内 elements', 'center 物理像素', '零测量、零等待、零新增调用', '一击命中'],
  G22: ['帧尺寸 ≠ 表内帧尺寸', '结构指纹 ≠ 表内 structural_hash',
    '上一动作 ∈ {滚动,弹窗开关,跳页,换标签,窗口移动,窗口缩放}', '整份旧表作废并重扫 1 次', '禁止用旧坐标点'],
  G23: ['表文件不存在', 'hit --name 命中 = 0', '同帧就地补扫 1 次', '同帧约 0.03s、冷扫约 0.17s',
    '扫到即点', '定位不到', '不等待、不循环、单次封顶 0.2s', '最多重试 1 次', 'scan 失败放行'],
  G24: ['滚动后', '弹窗开关', '跳页', '切换标签', '窗口移动', '窗口缩放', 'DPI 变化',
    '1792×963 预览 vs 1920×1032 帧', '旧表立即作废并重扫 1 次',
    '1920/1792≈1.0714', '1032/963≈1.0717', '预览坐标必乘回'],
}

/**
 * G1…G12 逐字冻结快照（2026-11-29 加 G14/G15 之前从门表原样抓的 12 行）。
 *
 * 这两道新门「一字不许动」的验收方式就是这张表：正文与门表都从它渲染/对比，
 * 旧门被顺手改一个字（包括上一轮刚收紧的 G11 等待门）这里立刻红。要改旧门，必须
 * 同时改这张表和门表，并在提交说明里写清为什么——不允许悄悄漂移。
 */
const FROZEN_GATE_LINES = [
  '[G1 帧] 条件：坐标动作（click/drag/input_text/long_press）不带 frame=，或 frame≠当前 frontmost 帧，或同一 frame 内该坐标未命中≥1 → 动作：该坐标作废，同帧重测一次后再点，禁止复用旧帧坐标',
  '[G2 重排] 条件：上一动作∈{改筛选,排序,滚动,开窗,换标签,展开,折叠,窗口移动,resize} → 动作：旧坐标全部作废并重测；纯输入/纯热键/纯读不算重排，本帧坐标继续用',
  '[G3 阶梯] 条件：目标∈{有加速键/Tab/Enter 路径, 有原生输入框/地址栏/名称字段/type-to-select/原生搜索, 有大 hit 原生控件} → 动作：按该级优先做；坐标是小目标最后一级，坐标不禁用',
  '[G4 锚点] 条件：目标∈容器（行/列/面板带） → 动作：先按 y 带定位，再在带内定 x 跨度，禁止直接量整块容器',
  '[G5 合并] 条件：量测输出=MERGE-SPAN REJECT，或 TOTAL bbox 覆盖候选簇≥2 → 动作：拒绝取 center 值，改用同次输出的簇中心，或 -Split <int> 取指定簇、收窄 -X0/-X1/-Y0/-Y1 拆区',
  '[G6 预算] 条件：同一目标跨帧未命中=2 → 动作：换定位方式（G3 上一级或键盘路径），禁止第 3 次同坐标',
  '[G7 黑名单] 条件：候选∈{harness caret 读数, hover 预览卡片, 浮层气泡, 放大镜/图标浮层} → 动作：不进入坐标候选',
  '[G8 偏移] 条件：回执=物理像素，要换算回截图坐标 → 动作：按 <frontmost_app> 查窗口偏移表；无表项一律不减（全局减是反效果）',
  '[G9 语义] 条件：导航型动作后，观察包 <frontmost_app>/<frontmost_window>/<frontmost_folder> ≠ 期望实体名 → 动作：换帧重算，禁止继续在本帧下结论',
  '[G10 参数] 条件：count∉{1,2}，或 scroll_level∉1..10，或缺 screen_index/position，或正文含工具标签片段 → 动作：拒收并立即报出字段名',
  '[G11 等待] 条件：默认不等待；仅当最新帧∈{loader/spinner/进度条/尚未出现的控件} 且目标=本次要继续操作对象 → 动作：仅 wait 1s，最多连开 3 次（上限 3s）；long_wait∈{10,30,60,120} 全禁；bash sleep/pwsh 等待全禁；回执截图=最新帧，换帧重取，不加 screenshot',
  '[G12 存储] 条件：动作=判断界面状态 → 动作：只读界面；app 私有存储（书签 JSON/设置文件/注册表）不作 UI 真值',
]

cases.push(['门表即正文：23 道门逐条渲染，条件可机械求值、动作是祈使句、没有散文式建议', async () => {
  const rule = computerUseCoordinatePolicyText()
  const gateLines = rule.split('\n').filter((line) => line.startsWith('[G'))
  assert.equal(gateLines.length, CU_COORDINATE_GATES.length, '正文里的门行数应等于门表条数')
  assert.equal(gateLines.length, 23, '用户口径 23 道门 = 原 12 道（帧/重排/阶梯/锚点/合并/预算/黑名单/偏移/语义/参数/等待/存储）+ G14 独立性 + G15 出口优先 + G16 弹层枚举 + G17 落盘核验 + G18 剪贴板优先 + G19 变灰必解状态 + G20 输入落点确认 + G21 目标表命中 + G22 结构变即作废 + G23 兜底单次 + G24 失效条件（G13 空号）')
  const parsed = []
  for (const line of gateLines) {
    const match = GATE_LINE.exec(line)
    assert.ok(match, `门行必须写成「[Gx 名] 条件：… → 动作：…」，实际：${line}`)
    const [, id, axis, when, then] = match
    assert.ok(!SOFT_WORDS.test(line), `${id} 不许写成建议/散文：${line}`)
    assert.match(when, /[∈∉≠≥=]/, `${id} 的条件必须含可机械求值的关系（∈/∉/≠/≥/=），实际：${when}`)
    assert.ok([...then].length >= 6, `${id} 的动作太短，必须是可执行祈使句`)
    assert.ok(!/^(可以|建议|考虑)/.test(then), `${id} 的动作不许以「可以/建议/考虑」开头`)
    parsed.push({ id, axis, when, then, line })
  }
  assert.deepEqual(parsed.map((gate) => gate.id), CU_COORDINATE_GATES.map((gate) => gate.id),
    '门号顺序应与门表一致（G1…G12、G14…G24）')
  assert.deepEqual(gateLines, CU_COORDINATE_GATES.map(cuCoordinateGateLine),
    '正文必须逐字来自门表（渲染器与门表不许漂移）')
}])

cases.push(['每道门的判据都在：帧指纹/重排清单/阶梯/锚点/合并/预算/黑名单/偏移/语义/参数/等待/存储/独立性/出口优先/弹层枚举/落盘核验/剪贴板优先/变灰必解状态/输入落点确认', async () => {
  const rule = computerUseCoordinatePolicyText()
  const lines = new Map()
  for (const line of rule.split('\n')) {
    const match = GATE_LINE.exec(line)
    if (match) lines.set(match[1], line)
  }
  for (const [id, markers] of Object.entries(GATE_MARKERS)) {
    const line = lines.get(id)
    assert.ok(line, `缺门 ${id}`)
    for (const marker of markers) {
      assert.ok(line.includes(marker), `${id} 缺判据「${marker}」：${line}`)
    }
  }
  assert.equal(lines.size, Object.keys(GATE_MARKERS).length, '门表与逐门判据表要一一对应，不许有空门')
}])

cases.push(['零新增轮次：门表不引入任何额外观察/量测调用，量测仍是每帧一次', async () => {
  const rule = computerUseCoordinatePolicyText()
  assert.ok(rule.includes('每帧最多 1 次扫描/量测'), '量测/扫描必须限每帧一次（否则就是新增轮次）')
  assert.ok(rule.includes('不要再复制截图'), '省略 -Shot 后不许再有复制截图这一步')
  assert.ok(rule.includes('-Shot <path>（省略=自动取最新观察帧）'), '一次调用取帧的口径必须写在正文里')
  assert.ok(rule.includes('image: WxH 必须等于本帧 attached_size'), '自动取帧要有免费的真帧校验')
  // 只有 G11 谈 screenshot，而且是禁止额外观察；其余门不许把调用数加上去。
  const mentions = CU_COORDINATE_GATES.filter((gate) => /screenshot/.test(gate.when + gate.then))
  assert.deepEqual(mentions.map((gate) => gate.id), ['G11'], '只有 G11 可以提 screenshot（禁止双观察）')
  // 重排门只作废旧坐标，不要求「每次都重测整屏」。
  const reflow = CU_COORDINATE_GATES.find((gate) => gate.id === 'G2')
  assert.ok(reflow.then.includes('纯输入/纯热键/纯读不算重排'), '纯读/纯输入不许被当成重排（否则每动作都重测）')
  assert.ok(!/每点|每次点击都量|每动一次量/.test(rule), '不许要求每次点击都重新量测')
  // G14 也不许把量测次数加上去：REGION-ECHO 判据在同一次输出里给，只在真同形时重测一次，
  // 而且明确禁止「每个目标都测」（静态 chrome 照旧不测）。
  const independence = CU_COORDINATE_GATES.find((gate) => gate.id === 'G14')
  assert.ok(independence, '缺 G14 测量独立性')
  assert.match(independence.when, /本次测量输出的 TOTAL bbox/,
    'REGION-ECHO 判据必须来自同一次测量输出的 TOTAL bbox（G14 的 then 已压缩，不再重复「输出里会给」）')
  assert.ok(independence.then.includes('只在该行出现时重测一次'), '同形才触发，且只触发一次重测')
  assert.ok(independence.then.includes('不逐目标预检'), '不许要求每个目标都先测一遍')
  assert.ok(independence.then.includes('静态 chrome') && independence.then.includes('不测'), '静态 chrome 照旧不测')
  // G15 是省轮次的门（复制/导出/命令读取一次拿全内容，替代逐屏滚动 OCR 的多轮观察）。
  const outlet = CU_COORDINATE_GATES.find((gate) => gate.id === 'G15')
  assert.ok(outlet, '缺 G15 出口优先')
  assert.ok(outlet.then.includes('逐屏滚动 OCR') && outlet.then.includes('再退到点控件'), '出口不存在时才退回读屏/点控件')
  assert.ok(outlet.then.includes('GUI 不禁用'), '出口门不许禁用 GUI')
  assert.ok(!/screenshot/.test(independence.when + independence.then + outlet.when + outlet.then),
    '两道新门都不许引入 screenshot（只有 G11 可以提）')
  // G16…G20 同样不许把观察/量测轮次加上去：全部门里只有 G11 能提 screenshot 与 wait/long_wait/bash sleep。
  const added = ['G16', 'G17', 'G18', 'G19', 'G20', 'G21', 'G22', 'G23', 'G24']
  for (const id of added) {
    const gate = CU_COORDINATE_GATES.find((item) => item.id === id)
    assert.ok(gate, `缺 ${id}`)
    assert.ok(!/screenshot|wait|sleep/.test(gate.when + gate.then), `${id} 不许提 screenshot/wait/sleep（不新增轮次）`)
  }
  const popup = CU_COORDINATE_GATES.find((gate) => gate.id === 'G16')
  assert.ok(popup.then.includes('同一次 -Split'), 'G16 的簇枚举复用同一次测量输出，不许再量一次')
  const disk = CU_COORDINATE_GATES.find((gate) => gate.id === 'G17')
  assert.ok(/1 条 Get-ChildItem/.test(disk.then), 'G17 只准 1 条目录查询，不许循环探目录')
  const caret = CU_COORDINATE_GATES.find((gate) => gate.id === 'G20')
  assert.ok(caret.then.includes('回执帧'), 'G20 看的是回执帧里的光标，不许额外 screenshot')
}])

/* ══════════════════════════════════════════════════════════════════════════
   2026-11-29 等待门收紧（用户硬指令）：一般情况绝不等待；确需等待时上限 3 秒。
   判据全部机械可判：默认不等待 / 唯一例外是显式集合 / wait 只准 1s×3 /
   long_wait 全档（10-30-60-120）禁止 + bash sleep / pwsh 等待禁止。
   ══════════════════════════════════════════════════════════════════════════ */

/** 含「等一下再看」意味的软措辞：等待门不许写成这种可自由裁量的句子。 */
const SOFT_WAIT_WORDS = /等一下|等一会|等一等|稍等|过会儿|再等等|再看看|等会儿|等一下再看/

cases.push(['等待门：默认不等待、唯一例外是显式集合、wait 1s 最多 3 次、long_wait 全档禁止', async () => {
  const rule = computerUseCoordinatePolicyText()
  const gate = CU_COORDINATE_GATES.find((item) => item.id === 'G11')
  assert.ok(gate, '缺等待门 G11')
  const line = cuCoordinateGateLine(gate)
  assert.equal(gate.axis, '等待', 'G11 已改为等待门')
  assert.ok(rule.includes(line), '渲染出的正文必须逐字包含等待门')
  assert.ok(line.includes('默认不等待'), '渲染出的门表里必须带「默认不等待」')
  // 默认不等待：正常流程不调 wait/long_wait——例外之外没有第二种等待理由。
  assert.ok(gate.when.startsWith('默认不等待'), `等待门条件必须以「默认不等待」开头，实际：${gate.when}`)
  assert.ok(gate.when.includes('仅当'), '除了唯一例外不许再有第二种等待理由')
  // 唯一允许等待的条件 = 最新帧出现显式集合里的元素，且它就是本次要继续操作的对象。
  const SET_HINT = ['loader', 'spinner', '进度条', '尚未出现的控件']
  const brace = /\{([^}]+)\}/.exec(gate.when)
  assert.ok(brace, `等待条件必须写成显式集合 {}，实际：${gate.when}`)
  assert.deepEqual(brace[1].split('/').sort(), SET_HINT.slice().sort(),
    '等待例外集合必须逐字是 loader/spinner/进度条/尚未出现的控件')
  assert.ok(gate.when.includes('目标=本次要继续操作对象'), '例外必须绑定本次要继续操作的对象')
  assert.match(gate.when, /∈/, '条件必须含集合隶属关系 ∈')
  assert.match(gate.when, /=/, '条件必须含对象相等关系 =')
  // 上限 3 秒：只准 wait 1s、最多连开 3 次。
  assert.ok(line.includes('仅 wait 1s'), '只允许 wait 1s 这一档')
  assert.ok(line.includes('最多连开 3 次'), 'wait 最多连开 3 次')
  assert.ok(line.includes('（上限 3s）'), '必须写明 1s×3 的上限是 3 秒')
  // long_wait 四个档位一律禁止。
  assert.match(line, /long_wait∈\{10,30,60,120\} 全禁/, 'long_wait 必须逐档点名 10/30/60/120 并全禁')
  // bash sleep / pwsh 等待同样禁止。
  assert.match(line, /bash sleep\/pwsh 等待全禁/, 'bash sleep / pwsh 等待必须同样禁止')
  // 判断进度靠换帧重取，不再加 screenshot（不新增调用轮次）。
  assert.ok(line.includes('回执截图=最新帧'), '动作回执自带的截图就是最新观察帧')
  assert.ok(line.includes('换帧重取'), '判断进度必须靠换帧重取')
  assert.ok(line.includes('不加 screenshot'), '不许再加 screenshot（双观察）')
  // 门表里只有等待门谈 wait/long_wait/bash sleep，其余门不许悄悄放行等待。
  const waitMentions = CU_COORDINATE_GATES.filter((item) => /wait|sleep/.test(item.when + item.then))
  assert.deepEqual(waitMentions.map((item) => item.id), ['G11'], '只有 G11 可以谈 wait/long_wait/bash sleep')
  // 正文不许出现「等一下再看」这类可自由裁量的等待措辞。
  assert.ok(!SOFT_WAIT_WORDS.test(rule), `正文出现软等待措辞：${rule.match(SOFT_WAIT_WORDS)?.[0]}`)
}])

/* ══════════════════════════════════════════════════════════════════════════
   2026-11-29 两道新通用门（用户口径）：G14 测量独立性 / G15 出口优先。
   验收两条：① 原 12 道门（含上一轮收紧的 G11）逐字未变，新门只追加在末尾；
   ② 两道新门进渲染门表、条件机械可判、判据逐条在，且都不新增调用轮次。
   ══════════════════════════════════════════════════════════════════════════ */

cases.push(['逐字冻结：原 12 道门（含新 G11）一字未改，G14…G24 只追加在末尾', async () => {
  const lines = CU_COORDINATE_GATES.map(cuCoordinateGateLine)
  assert.equal(lines.length, 23, `门表应有 23 道门，实际 ${lines.length}`)
  assert.deepEqual(lines.slice(0, 12), FROZEN_GATE_LINES,
    'G1…G12 必须逐字等于冻结快照（改旧门要同步改冻结表并在提交说明里写清）')
  assert.deepEqual(lines.slice(12).map((line) => GATE_LINE.exec(line)?.[1]),
    ['G14', 'G15', 'G16', 'G17', 'G18', 'G19', 'G20', 'G21', 'G22', 'G23', 'G24'],
    '新门只准追加在末尾，且门号就是用户给定的 G14/G15/G16…G20 与 G21…G24（G13 空号）')
  // 上一轮刚收紧的等待门：逐字在场，这次一个字都不许动。
  const g11 = lines[10]
  assert.ok(g11.startsWith('[G11 等待]'), 'G11 必须还是等待门，位置不变')
  for (const marker of ['默认不等待', '仅 wait 1s，最多连开 3 次（上限 3s）',
    'long_wait∈{10,30,60,120} 全禁', 'bash sleep/pwsh 等待全禁', '不加 screenshot']) {
    assert.ok(g11.includes(marker), `G11 逐字冻结被破坏，缺「${marker}」`)
  }
  // 只追加：新门不许吃掉旧行（每一条冻结行都仍逐字存在一次）。
  for (const line of FROZEN_GATE_LINES) {
    assert.equal(lines.filter((item) => item === line).length, 1, `冻结行被改动或重复：${line}`)
  }
  assert.equal(new Set(CU_COORDINATE_GATES.map((gate) => gate.id)).size, 23, '门号不许重复')
  assert.ok(!CU_COORDINATE_GATES.some((gate) => gate.id === 'G13'), 'G13 是空号，不许自己补门')
}])

cases.push(['G14/G15 与新增 G16…G20 进渲染门表：REGION-ECHO 判据、出口优先与新门条件都机械可判', async () => {
  const rule = computerUseCoordinatePolicyText()
  const gates = Object.fromEntries(CU_COORDINATE_GATES.map((gate) => [gate.id, gate]))
  const g14 = gates.G14
  assert.ok(g14, '缺 G14')
  assert.equal(g14.axis, '测量独立性', 'G14 是测量独立性门')
  assert.ok(rule.includes(cuCoordinateGateLine(g14)), 'G14 必须出现在渲染出的正文里')
  // 机械条件：两轴跨度相等（=）是「同形回显」，数值门槛固定 60 px（region 任一边 ≥ 60 px）。
  assert.match(g14.when, /TOTAL bbox 的 x 跨度 = region 的 x 跨度 且 y 跨度 = region 的 y 跨度/,
    'G14 条件必须写成「两轴跨度相等」这种可机械比对的式子')
  assert.ok(g14.when.includes('（同形回显）'), 'G14 条件必须点名「同形回显」这一机械判据')
  assert.ok(g14.when.includes('且 region 宽或高任一边 ≥ 60 px'),
    'G14 条件必须带数值门槛（任一边 ≥ 60 px 才判回显）')
  assert.ok(cuCoordinateGateLine(g14).includes('REGION-ECHO'), '门行必须点名 REGION-ECHO 这条输出判据（条件或动作任一处）')
  // 逐条判据（用户口径，少一条就算门没做完）。2026-11-29 压缩后 then 只留机械判据与出口，
  // 删掉的重复说明（「REGION-ECHO 由本次输出给出」/「落点核对再讲一遍」/「<50×50 px 键盘等效」
  // 与 G3 重复）不再在这里断言；机械判据一条没少。
  for (const marker of [
    '禁止取该中心', '收窄 -X0/-X1/-Y0/-Y1', '-Split <int>', '重测一次',
    '只用元素/簇 bbox 定中心', '比对 region 不算命中',
    '静态 chrome∈{标题栏,菜单文字,地址栏,标签} 不测', '只在该行出现时重测一次', '不逐目标预检',
    'region 两边都 < 60 px', 'span 相等不判 REGION-ECHO',
    'SPAN-EQUAL tight-region (<60px): center=ACCEPT', '照常用该中心与分数',
    '只豁免同形回显这一判据', 'MERGE-SPAN（簇间隙 ≥ -MergeGap）与簇中心照旧独立生效',
  ]) {
    assert.ok(g14.then.includes(marker), `G14 缺判据「${marker}」：${g14.then}`)
  }
  assert.ok(!SOFT_WORDS.test(cuCoordinateGateLine(g14)), 'G14 不许写成建议/散文')
  assert.match(g14.when, /[∈∉≠≥=]/, 'G14 条件必须含机械关系符')
  // G15：内容与动作都走应用自身出口，先于逐屏读图 / 先于点控件。
  const g15 = gates.G15
  assert.ok(g15, '缺 G15')
  assert.equal(g15.axis, '出口优先')
  assert.ok(rule.includes(cuCoordinateGateLine(g15)), 'G15 必须出现在渲染出的正文里')
  for (const marker of [
    '读内容：网页/回答/文档/表格/日志/终端输出', '发送类动作：发送/确认/地址栏/重命名',
    '原生出口∈{复制钮,导出,下载,剪贴板,已有文件,命令读取}', '取不到才逐屏滚动 OCR',
    '键盘等效∈{Enter,Ctrl+Enter,Tab,加速键,原生输入框}', '再退到点控件',
    '出口不存在时照旧走坐标', 'GUI 不禁用',
  ]) {
    assert.ok((g15.when + g15.then).includes(marker), `G15 缺判据「${marker}」`)
  }
  assert.ok(!SOFT_WORDS.test(cuCoordinateGateLine(g15)), 'G15 不许写成建议/散文')
  // G16…G20：条件带机械关系、动作是祈使句、判据逐条在场（判据表见 GATE_MARKERS）。
  for (const id of ['G16', 'G17', 'G18', 'G19', 'G20']) {
    const gate = gates[id]
    assert.ok(gate, `缺 ${id}`)
    const line = cuCoordinateGateLine(gate)
    assert.ok(rule.includes(line), `${id} 必须出现在渲染出的正文里`)
    assert.match(gate.when, /[∈∉≠≥=]/, `${id} 条件必须含机械关系符：${gate.when}`)
    assert.ok(!SOFT_WORDS.test(line), `${id} 不许写成建议/散文：${line}`)
    assert.ok(!/^(可以|建议|考虑)/.test(gate.then), `${id} 的动作不许以「可以/建议/考虑」开头`)
    for (const marker of GATE_MARKERS[id]) {
      assert.ok(line.includes(marker), `${id} 缺判据「${marker}」：${line}`)
    }
  }
  // 门表即正文：正文里的门行数 = 门表条数（由「门表即正文」用例逐条对比）。
  assert.equal(rule.split('\n').filter((line) => line.startsWith('[G')).length, 23, '正文门行数应为 23')
  assert.ok(rule.includes('REGION-ECHO'), '规则正文必须提到 REGION-ECHO 判据行')
}])

/* ══════════════════════════════════════════════════════════════════════════
   measure.ps1 真跑回归（本机资产：<DSH_HOME>/cu-click/measure.ps1）。
   脚本不在本机时这几条跳过并打 skip（可移植），在本机必须全绿。
   ══════════════════════════════════════════════════════════════════════════ */

const measurePath = cuMeasureScriptPath({
  get: (name) => (name === 'profileContext' ? { dir: join(homedir(), '.dsh', 'profiles', 'desktop') } : undefined),
})
const measureAvailable = existsSync(measurePath)

function runMeasure(scriptPath, args, timeout = 120000) {
  const shell = process.platform === 'win32' ? 'powershell' : 'pwsh'
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
    encoding: 'utf8',
    timeout,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 用 PIL 造一张 1200x800 白底 fixture；draw 是 Python 语句（画目标矩形）。 */
function writeFixturePng(file, draw) {
  const target = file.replace(/\\/g, '/')
  const code = [
    'from PIL import Image, ImageDraw',
    'im = Image.new("RGB", (1200, 800), (255, 255, 255))',
    'd = ImageDraw.Draw(im)',
    draw,
    `im.save("${target}", format="PNG")`,
  ].join('\n')
  const result = spawnSync('python', ['-c', code], { encoding: 'utf8' })
  assert.equal(result.status, 0, `造图失败：${result.stderr}`)
}

/** 同上但尺寸可指定（1510x35 这类宽 region 需要更大的底图）。 */
function writeFixturePngSize(file, width, height, draw) {
  const target = file.replace(/\\/g, '/')
  const code = [
    'from PIL import Image, ImageDraw',
    `im = Image.new("RGB", (${width}, ${height}), (255, 255, 255))`,
    'd = ImageDraw.Draw(im)',
    draw,
    `im.save("${target}", format="PNG")`,
  ].join('\n')
  const result = spawnSync('python', ['-c', code], { encoding: 'utf8' })
  assert.equal(result.status, 0, `造图失败：${result.stderr}`)
}

const MEASURE_SKIP = 'measure.ps1 不在本机（<DSH_HOME>/cu-click），跳过真跑'

cases.push(['measure.ps1 usage 写死参数类型与语义（-Split 是 int、四个边界是包含边界）', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const out = runMeasure(measurePath, ['-Usage'])
  assert.equal(out.status, 0, `-Usage 应退出 0：${out.stderr}`)
  for (const marker of ['-Shot <string>', '-X0 <int>', '-X1 <int>', '-Y0 <int>', '-Y1 <int>',
    '-Split <int>', 'dark|blue|yellow|gray', 'NOT a switch', 'INCLUSIVE', 'shot-cache.png',
    'REGION-ECHO', 'SPAN-EQUAL', 'center=ACCEPT', '>= 60 px', '< 60 px']) {
    assert.ok(out.stdout.includes(marker), `usage 缺「${marker}」：\n${out.stdout}`)
  }
}])

cases.push(['measure.ps1 单簇：一次调用就给出 frame/bbox/center，不误报合并跨度', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-single-'))
  try {
    const png = join(dir, 'one.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))')
    const out = runMeasure(measurePath, ['-Shot', png, '-X0', '0', '-X1', '600', '-Y0', '0', '-Y1', '300', '-Mode', 'blue'])
    assert.equal(out.status, 0, `退出码应为 0：${out.stderr}\n${out.stdout}`)
    assert.match(out.stdout, /frame=[0-9a-f]{16}/, '必须打印 16 位帧指纹')
    assert.match(out.stdout, /TOTAL bbox: x 100\.\.180 {2}y 100\.\.140/, 'bbox 应落在实测矩形上')
    assert.match(out.stdout, /center=\(140,120\)/, '单簇应直接给可用中心')
    assert.match(out.stdout, /fraction=\[/, '应给 fraction')
    assert.ok(!out.stdout.includes('MERGE-SPAN'), '单簇不许误报 MERGE-SPAN')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['measure.ps1 合并跨度：TOTAL 盖住 2 个候选 → 拒绝 center 值并在同一次调用里给出候选簇', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-merge-'))
  try {
    const png = join(dir, 'two.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))\nd.rectangle([220, 100, 300, 140], fill=(0, 0, 255))')
    const out = runMeasure(measurePath, ['-Shot', png, '-X0', '0', '-X1', '600', '-Y0', '0', '-Y1', '300', '-Mode', 'blue'])
    assert.equal(out.status, 0, `退出码应为 0：${out.stderr}\n${out.stdout}`)
    assert.ok(out.stdout.includes('MERGE-SPAN REJECT'), '跨度盖住 2 个候选必须拒绝')
    assert.ok(out.stdout.includes('center=REJECT'), '拒绝时不许再给出可用 center')
    assert.ok(out.stdout.includes('#1 bbox x 100..180'), '同一次调用要给候选簇 #1')
    assert.ok(out.stdout.includes('#2 bbox x 220..300'), '同一次调用要给候选簇 #2（拆簇不额外加调用）')
    assert.ok(out.stdout.includes('clusters: 2'), '簇数要写清')
    assert.ok(out.stdout.includes('center=(140,120)'), '候选簇 #1 的中心可直接点')
    assert.ok(out.stdout.includes('center=(260,120)'), '候选簇 #2 的中心可直接点')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['measure.ps1 -Split 与 -MinPixels 语义没改坏（旧口径：#k bbox / clusters: k / NO MATCH）', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-split-'))
  try {
    const png = join(dir, 'two.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))\nd.rectangle([220, 100, 300, 140], fill=(0, 0, 255))')
    const split = runMeasure(measurePath, ['-Shot', png, '-X0', '0', '-X1', '600', '-Y0', '0', '-Y1', '300', '-Mode', 'blue', '-Split', '8'])
    assert.equal(split.status, 0, `退出码应为 0：${split.stderr}\n${split.stdout}`)
    assert.ok(split.stdout.includes('#1 bbox x 100..180 y 100..140'), '-Split 应逐簇给 bbox（旧格式）')
    assert.ok(split.stdout.includes('clusters: 2'), '-Split 8 应切出 2 簇')
    const none = runMeasure(measurePath, ['-Shot', png, '-X0', '0', '-X1', '600', '-Y0', '0', '-Y1', '300', '-Mode', 'blue', '-MinPixels', '100000'])
    assert.equal(none.status, 0)
    assert.ok(none.stdout.includes('NO MATCH'), '-MinPixels 高阈值应 NO MATCH')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['measure.ps1 一帧一次调用：省略 -Shot 自动取最新观察帧、写固定缓存、帧指纹=文件哈希', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const root = mkdtempSync(join(tmpdir(), 'dsh-home-fixture-'))
  try {
    const cuDir = join(root, 'cu-click')
    mkdirSync(cuDir, { recursive: true })
    copyFileSync(measurePath, join(cuDir, 'measure.ps1'))
    copyFileSync(join(measurePath, '..', 'measure_core.py'), join(cuDir, 'measure_core.py'))
    const objects = join(root, 'attachments', 'v1', 'objects', 'ab')
    mkdirSync(objects, { recursive: true })
    const objectPath = join(objects, 'abcdef0123456789')
    writeFixturePng(objectPath, 'd.rectangle([50, 60, 120, 90], fill=(255, 210, 0))')
    const expectedFrame = createHash('sha256').update(readFileSync(objectPath)).digest('hex').slice(0, 16)

    const out = runMeasure(join(cuDir, 'measure.ps1'), ['-X0', '0', '-X1', '300', '-Y0', '0', '-Y1', '200', '-Mode', 'yellow'])
    assert.equal(out.status, 0, `省略 -Shot 应能一次跑通：${out.stderr}\n${out.stdout}`)
    assert.ok(out.stdout.includes(`shot=${objectPath}`), '应自动取到 attachments 里的最新观察帧')
    assert.ok(out.stdout.includes(`frame=${expectedFrame}`), '帧指纹必须是该帧文件的真实哈希')
    assert.match(out.stdout, /image: 1200x800/, '应打印真实图像尺寸供比对 attached_size')
    assert.ok(out.stdout.includes('center=(85,75)'), '自动取帧后仍按实测给中心')
    assert.ok(existsSync(join(cuDir, 'shot-cache.png')), '固定缓存 shot-cache.png 应被刷新')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}])

cases.push(['measure.ps1 -MergeGap 可调：小间隙默认单簇，收紧阈值后判成合并跨度', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-gap-'))
  try {
    const png = join(dir, 'close.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))\nd.rectangle([185, 100, 265, 140], fill=(0, 0, 255))')
    const loose = runMeasure(measurePath, ['-Shot', png, '-X0', '0', '-X1', '600', '-Y0', '0', '-Y1', '300', '-Mode', 'blue'])
    assert.equal(loose.status, 0)
    assert.ok(!loose.stdout.includes('MERGE-SPAN'), '4px 间隙小于默认 MergeGap(10) 时不该判成合并')
    const tight = runMeasure(measurePath, ['-Shot', png, '-X0', '0', '-X1', '600', '-Y0', '0', '-Y1', '300', '-Mode', 'blue', '-MergeGap', '3'])
    assert.equal(tight.status, 0)
    assert.ok(tight.stdout.includes('MERGE-SPAN REJECT'), '-MergeGap 3 时 4px 间隙应判成合并跨度')
    assert.ok(tight.stdout.includes('center=REJECT'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['measure.ps1 REGION-ECHO：TOTAL bbox 与 region 同形 → 拒 center 值并在同一次输出里给簇中心', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-echo-'))
  try {
    // 掩码正好铺满 region 100..300 × 100..200 ⇒ x、y 两轴跨度都与 region 相等。
    const png = join(dir, 'echo.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 300, 200], fill=(0, 0, 255))')
    const out = runMeasure(measurePath, ['-Shot', png, '-X0', '100', '-X1', '300', '-Y0', '100', '-Y1', '200', '-Mode', 'blue'])
    assert.equal(out.status, 0, `退出码应为 0：${out.stderr}\n${out.stdout}`)
    assert.match(out.stdout, /TOTAL bbox: x 100\.\.300 {2}y 100\.\.200/, 'bbox 应与 region 同形')
    assert.ok(out.stdout.includes('REGION-ECHO: center=REJECT'), '同形必须打出 REGION-ECHO: center=REJECT')
    assert.ok(out.stdout.includes('  center=REJECT'), '拒收时必须有 center=REJECT')
    assert.ok(!/^ {2}center=\(\d+,\d+\)/m.test(out.stdout), '拒收时不许再给出可用的单簇 center 行')
    assert.ok(out.stdout.includes('narrow -X0/-X1/-Y0/-Y1'), '判据行要给收窄 region 的出口')
    assert.ok(out.stdout.includes('-Split <int>'), '判据行要给 -Split 重测的出口')
    // 同一次调用就要给出可点的簇中心（不额外加调用）。
    assert.ok(out.stdout.includes('clusters: 1'), '同一次调用仍要给簇数')
    assert.match(out.stdout, /#1 bbox x 100\.\.300 y 100\.\.200 {2}size 201x101 center=\(200,150\)/,
      'REGION-ECHO 时也要给出可选簇中心')
    assert.ok(!out.stdout.includes('MERGE-SPAN'), '单簇不许误报 MERGE-SPAN（两条判据各自独立）')
    // 反向：bbox 落在 region 内部（不同形）时不许误报，中心照旧可用。
    const inside = runMeasure(measurePath, ['-Shot', png, '-X0', '0', '-X1', '600', '-Y0', '0', '-Y1', '300', '-Mode', 'blue'])
    assert.equal(inside.status, 0)
    assert.ok(!inside.stdout.includes('REGION-ECHO'), 'bbox 只在 region 内部时不许判 REGION-ECHO')
    assert.match(inside.stdout, /^ {2}center=\(200,150\)/m, '不同形时中心照旧可用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['measure.ps1 REGION-ECHO 与 MERGE-SPAN 各自独立：两条判据可同时命中，中心一律拒绝', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-echo2-'))
  try {
    // 左右两条竖带贴住 region 的左右边、贯通上下边 ⇒ bbox 与 region 同形，同时横向 2 簇。
    const png = join(dir, 'echo2.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 110, 200], fill=(0, 0, 255))\nd.rectangle([290, 100, 300, 200], fill=(0, 0, 255))')
    const out = runMeasure(measurePath, ['-Shot', png, '-X0', '100', '-X1', '300', '-Y0', '100', '-Y1', '200', '-Mode', 'blue'])
    assert.equal(out.status, 0, `退出码应为 0：${out.stderr}\n${out.stdout}`)
    assert.ok(out.stdout.includes('MERGE-SPAN REJECT'), '跨 2 簇仍必须判 MERGE-SPAN')
    assert.ok(out.stdout.includes('REGION-ECHO: center=REJECT'), '同形仍必须判 REGION-ECHO（互不替代）')
    assert.ok(!/^ {2}center=\(\d+,\d+\)/m.test(out.stdout), '两条判据任一命中都不许给可用中心')
    assert.ok(out.stdout.includes('#1 bbox x 100..110 y 100..200'), '簇 #1 要可直接点')
    assert.ok(out.stdout.includes('#2 bbox x 290..300 y 100..200'), '簇 #2 要可直接点')
    assert.ok(out.stdout.includes('center=(105,150)') && out.stdout.includes('center=(295,150)'), '两簇中心都要在')
    assert.ok(out.stdout.includes('clusters: 2'), '簇数要写清')
    // 顺序：两条判据 + 拒收都在簇行之前同一次输出里给完。
    const mergeAt = out.stdout.indexOf('MERGE-SPAN REJECT')
    const rejectAt = out.stdout.indexOf('  center=REJECT')
    const echoAt = out.stdout.indexOf('REGION-ECHO: center=REJECT')
    const firstCluster = out.stdout.indexOf('#1 bbox')
    assert.ok(mergeAt >= 0 && rejectAt > mergeAt && echoAt > rejectAt && firstCluster > echoAt,
      '输出顺序应为 MERGE-SPAN → center=REJECT → REGION-ECHO → 簇行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

/* ══════════════════════════════════════════════════════════════════════════
    2026-11-29 G14 收紧（用户口径）：同形回显只算「搜索区任一边 ≥ 60 px」那一支。
    数值门槛固定 60 px：不是命令行参数、不是第二个门、也不是新阈值。
    region 两边都 < 60 px（手工把搜索区收窄到目标周围）时同形不再判 REGION-ECHO，
    中心与分数照旧用；豁免只免同形这一判据，MERGE-SPAN 与簇中心照旧独立生效。
    ══════════════════════════════════════════════════════════════════════════ */

cases.push(['G14 门文本：60 px 数值门槛与「两边都 <60 px 不判回显」的豁免句都在，脚本侧门槛同源且不是 CLI 参数', async () => {
  const g14 = CU_COORDINATE_GATES.find((gate) => gate.id === 'G14')
  assert.ok(g14, '缺 G14 测量独立性')
  const line = cuCoordinateGateLine(g14)
  // ① 门文本的数值门槛（判 REGION-ECHO 那一支）。
  assert.ok(g14.when.includes('且 region 宽或高任一边 ≥ 60 px'), `G14 条件缺 60 px 数值门槛：${g14.when}`)
  // ② 门文本的豁免句（两边都 < 60 px 的手工窄区）。
  assert.ok(/region 两边都 < 60 px（[^）]+）/.test(g14.then), `G14 缺「两边都 < 60 px 不判回显」的豁免句：${g14.then}`)
  assert.ok(g14.then.includes('span 相等不判 REGION-ECHO'), 'G14 豁免句没写明小 region 不判回显')
  assert.ok(g14.then.includes('SPAN-EQUAL tight-region (<60px): center=ACCEPT'), 'G14 必须点名脚本的新输出行（与脚本侧逐字一致）')
  assert.ok(g14.then.includes('照常用该中心与分数'), 'G14 豁免句必须写明中心与分数照旧用')
  assert.ok(g14.then.includes('只豁免同形回显这一判据'), 'G14 必须限定豁免只免同形这一条')
  assert.ok(g14.then.includes('MERGE-SPAN（簇间隙 ≥ -MergeGap）与簇中心照旧独立生效'), 'G14 不许削弱 MERGE-SPAN 与簇中心')
  // ③ 不许自己发明别的阈值：G14 压缩后门里只剩 60 px 这一个 px 数字（50×50 小目标口径已与 G3 合并删掉）。
  const pxNumbers = [...new Set((line.match(/\d+×\d+ px|\d+ px/g) ?? []).map((text) => text.replace(/\s+/g, ' ')))].sort()
  assert.deepEqual(pxNumbers, ['60 px'], `G14 只准出现 60 px 门槛（不许新发明阈值），实际：${JSON.stringify(pxNumbers)}`)
  assert.equal((line.match(/60 px/g) ?? []).length, 2, '门槛 60 px 必须在「判回显」与「豁免」两处都写出来')
  assert.equal((line.match(/\(\u003C60px\)/g) ?? []).length, 1, '脚本输出行的 (<60px) 标记只准出现在豁免句里')
  // ④ 脚本侧同一门槛、同一数值，且没被做成命令行参数；既有默认值与包含边界语义一字不许改。
  const core = readFileSync(join(measurePath, '..', 'measure_core.py'), 'utf8')
  const legacy = existsSync(join(measurePath, '..', 'measure_legacy.ps1')) ? readFileSync(join(measurePath, '..', 'measure_legacy.ps1'), 'utf8') : ''
  const ps1 = readFileSync(measurePath, 'utf8')
  assert.match(core, /ECHO_MIN_SPAN_PX\s*=\s*60/, 'measure_core.py 必须写明固定 60 px 门槛')
  assert.ok(core.includes('region_w < ECHO_MIN_SPAN_PX and region_h < ECHO_MIN_SPAN_PX'), 'core 的豁免必须是「两边都 < 60 px」')
  assert.ok(core.includes('echo_reject = region_echo and not echo_exempt'), 'core 必须把「同形」与「门槛」拆成两件事')
  assert.ok(core.includes('SPAN-EQUAL tight-region (<60px): center=%s'), 'core 的新输出行必须与门文本逐字一致')
  assert.ok(ps1.includes('SPAN-EQUAL') && ps1.includes('center=ACCEPT'), 'measure.ps1 的 usage 必须提到新的 ACCEPT 行')
  assert.ok(ps1.includes('>= 60 px'), 'measure.ps1 的 usage 必须写明 60 px 门槛')
  assert.ok(!/\$Echo/.test(ps1), 'measure.ps1 不许把门槛做成 CLI 参数（不许新增 -$Env…/…Echo… 参数）')
  assert.ok(!/ECHO_MIN/.test(ps1), '门槛数值只准待在 measure_core.py 里，不许在 PS 侧另算一套')
  assert.ok(ps1.includes('[int]$MergeGap = 10') && ps1.includes('[int]$MinPixels = 3'), '默认值不许改（-MergeGap 10 / -MinPixels 3）')
  assert.ok(core.includes('merge_gap = int(argv[11]) if len(argv) > 11 else 10'), 'core 的 MergeGap 默认不许改')
  assert.ok(ps1.includes('INCLUSIVE start bound') && ps1.includes('INCLUSIVE end bound'), '包含边界语义不许改')
  if (legacy) {
    assert.match(legacy, /\$EchoMinSpanPx\s*=\s*60/, 'measure_legacy.ps1（-Split>0 的路径）必须用同一个 60 px 门槛')
    assert.ok(legacy.includes('SPAN-EQUAL tight-region (<60px): center=ACCEPT'), 'legacy 的新输出行必须与门文本一致')
    assert.ok(legacy.includes('REGION-ECHO: center=REJECT'), 'legacy 也必须保住大搜索区的拒中心')
  }
}])

cases.push(['真·假测量照旧被抓：1510x35（地址栏那类）与 111x61（发送钮那类）按新门槛判 REGION-ECHO / center=REJECT', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-echo-floor-'))
  try {
    // 掩码正好铺满 1510x35 与 111x61 两种 region：任一边 >= 60 px ⇒ 照旧判回显、照旧拒中心。
    const wide = join(dir, 'wide.png')
    writeFixturePngSize(wide, 1920, 1032, 'd.rectangle([100, 100, 1609, 134], fill=(0, 0, 255))')
    const outWide = runMeasure(measurePath, ['-Shot', wide, '-X0', '100', '-X1', '1609', '-Y0', '100', '-Y1', '134', '-Mode', 'blue'])
    assert.equal(outWide.status, 0, `退出码应为 0：${outWide.stderr}\n${outWide.stdout}`)
    assert.ok(outWide.stdout.includes('REGION-ECHO: center=REJECT'), '1510x35 的同形回显必须照旧判 REGION-ECHO')
    assert.ok(outWide.stdout.includes('region 1510x35 >= 60px'), '判据行要把 region 尺寸与门槛写在一起')
    assert.ok(outWide.stdout.includes('  center=REJECT'), '必须拒中心值')
    assert.ok(!/^ {2}center=\(\d+,\d+\)/m.test(outWide.stdout), '拒中心时不许给可用中心')
    assert.ok(!outWide.stdout.includes('SPAN-EQUAL'), '大搜索区不许走 <60 px 豁免')

    const tall = join(dir, 'sendbtn.png')
    writeFixturePngSize(tall, 1920, 1032, 'd.rectangle([200, 50, 310, 110], fill=(0, 0, 255))')
    const outTall = runMeasure(measurePath, ['-Shot', tall, '-X0', '200', '-X1', '310', '-Y0', '50', '-Y1', '110', '-Mode', 'blue'])
    assert.equal(outTall.status, 0, `退出码应为 0：${outTall.stderr}\n${outTall.stdout}`)
    assert.ok(outTall.stdout.includes('REGION-ECHO: center=REJECT'), '111x61（任一边 >= 60 px）也必须判回显，门槛不许放软')
    assert.ok(outTall.stdout.includes('region 111x61 >= 60px'), '判据行要给 111x61 的尺寸证据')
    assert.ok(outTall.stdout.includes('  center=REJECT'), '必须拒中心值')
    assert.ok(!/^ {2}center=\(\d+,\d+\)/m.test(outTall.stdout), '拒中心时不许给可用中心')
    assert.ok(!outTall.stdout.includes('SPAN-EQUAL'), '111x61 不算手工窄区，不许 exempt')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['误报消除：已知反例 region 14x14 / 与 region 同形 / pixels=51 按新门槛判 ACCEPT，中心与分数照旧给', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-tight-'))
  try {
    // 手工把搜索区收窄到目标周围：region 14x14，掩码顶到四条边（同形），共 51 个像素。
    const png = join(dir, 'tight.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 106, 106], fill=(0, 0, 255))\nd.rectangle([112, 113, 113, 113], fill=(0, 0, 255))')
    const out = runMeasure(measurePath, ['-Shot', png, '-X0', '100', '-X1', '113', '-Y0', '100', '-Y1', '113', '-Mode', 'blue'])
    assert.equal(out.status, 0, `退出码应为 0：${out.stderr}\n${out.stdout}`)
    assert.match(out.stdout, /TOTAL bbox: x 100\.\.113 {2}y 100\.\.113 {2}pixels=51/, '反例要复现：同形 + pixels=51')
    assert.ok(out.stdout.includes('SPAN-EQUAL tight-region (<60px): center=ACCEPT'), '两边都 < 60 px 必须打新的 ACCEPT 行')
    assert.ok(!out.stdout.includes('REGION-ECHO'), '手工窄区不许再被判成 REGION-ECHO')
    assert.ok(!out.stdout.includes('center=REJECT'), '豁免之后中心不许拒收')
    assert.match(out.stdout, /^ {2}center=\(\d+,\d+\) {2}fraction=\[[\d.]+, [\d.]+\]$/m, '必须照常给 center 与 fraction')
    assert.ok(!out.stdout.includes('MERGE-SPAN'), '5px 间隙 < MergeGap(10) 时不该判合并（豁免不碰这条）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['豁免只免同形这一判据：14x14 小 region 跨 2 簇时 MERGE-SPAN 照旧 REJECT、簇中心照旧独立生效', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-tight-merge-'))
  try {
    // 同形（bbox == 14x14 region）同时横向 2 簇（间隙 3px >= -MergeGap 2）：豁免不许顺带放软 MERGE-SPAN。
    const png = join(dir, 'tightmerge.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 103, 113], fill=(0, 0, 255))\nd.rectangle([107, 110, 113, 113], fill=(0, 0, 255))')
    const out = runMeasure(measurePath, ['-Shot', png, '-X0', '100', '-X1', '113', '-Y0', '100', '-Y1', '113', '-Mode', 'blue', '-MergeGap', '2'])
    assert.equal(out.status, 0, `退出码应为 0：${out.stderr}\n${out.stdout}`)
    assert.match(out.stdout, /TOTAL bbox: x 100\.\.113 {2}y 100\.\.113/, 'bbox 仍与 14x14 region 同形')
    assert.ok(out.stdout.includes('MERGE-SPAN REJECT'), '簇间隙 >= -MergeGap 时必须照旧判 MERGE-SPAN')
    assert.ok(out.stdout.includes('cluster gap >= 2px'), 'MERGE-SPAN 判据行仍要给簇间隙口径')
    assert.ok(out.stdout.includes('  center=REJECT'), 'MERGE-SPAN 命中时中心照旧拒收')
    assert.ok(!out.stdout.includes('REGION-ECHO'), '两边都 < 60 px 时不许再判 REGION-ECHO（豁免生效）')
    assert.ok(out.stdout.includes('SPAN-EQUAL tight-region (<60px): center=EXEMPT'), '豁免要在同一次输出里说清只免这一条')
    assert.ok(!out.stdout.includes('center=ACCEPT'), '小 region 也不会因此给出 ACCEPT 的中心')
    assert.ok(out.stdout.includes('#1 bbox x 100..103'), '簇 #1 要可直接点')
    assert.ok(out.stdout.includes('#2 bbox x 107..113'), '簇 #2 要可直接点')
    assert.ok(!/^ {2}center=\(\d+,\d+\)/m.test(out.stdout), '拒中心时不许给可用中心行')
    assert.ok(out.stdout.includes('clusters: 2'), '簇数要写清')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['measure_legacy.ps1（-Split>0 的路径）用同一个 60 px 门槛：大 region 判 REJECT，手工窄区判 ACCEPT', async () => {
  const legacyPath = join(measurePath, '..', 'measure_legacy.ps1')
  if (!measureAvailable || !existsSync(legacyPath)) return console.log(`  skip - ${MEASURE_SKIP}（measure_legacy.ps1 不在本机）`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-legacy-'))
  try {
    const png = join(dir, 'legacy.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 300, 200], fill=(0, 0, 255))\nd.rectangle([400, 400, 413, 413], fill=(0, 0, 255))')
    const big = runMeasure(legacyPath, ['-Shot', png, '-X0', '100', '-X1', '300', '-Y0', '100', '-Y1', '200', '-Mode', 'blue', '-Split', '8'])
    assert.equal(big.status, 0, `退出码应为 0：${big.stderr}\n${big.stdout}`)
    assert.ok(big.stdout.includes('REGION-ECHO: center=REJECT'), '201x101 的大搜索区同形必须照旧判回显、拒中心')
    assert.ok(big.stdout.includes('  center=REJECT'), 'legacy 也要拒中心')
    assert.ok(!/^ {2}center=\(\d+,\d+\)/m.test(big.stdout), '拒中心时不许再给可用中心行')
    assert.ok(!big.stdout.includes('SPAN-EQUAL'), '大搜索区不许走 <60 px 豁免')
    assert.ok(big.stdout.includes('#1 bbox x 100..300 y 100..200'), 'legacy 的 -Split 簇行照旧给（旧格式）')
    assert.ok(big.stdout.includes('clusters: 1'), 'legacy 的 clusters 行照旧给')

    const tight = runMeasure(legacyPath, ['-Shot', png, '-X0', '400', '-X1', '413', '-Y0', '400', '-Y1', '413', '-Mode', 'blue', '-Split', '8'])
    assert.equal(tight.status, 0, `退出码应为 0：${tight.stderr}\n${tight.stdout}`)
    assert.ok(tight.stdout.includes('SPAN-EQUAL tight-region (<60px): center=ACCEPT'), '14x14 手工窄区必须判 ACCEPT')
    assert.ok(!tight.stdout.includes('REGION-ECHO'), 'legacy 也不许再误判 REGION-ECHO')
    assert.match(tight.stdout, /^ {2}center=\(\d+,\d+\) {2}fraction=\[[\d.]+, [\d.]+\]$/m, 'ACCEPT 之后必须照常给 center 与 fraction')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['measure.ps1 坏边界立即拒收并报字段名（-X1 < -X0）', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-bad-'))
  try {
    const png = join(dir, 'one.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))')
    const out = runMeasure(measurePath, ['-Shot', png, '-X0', '500', '-X1', '100', '-Mode', 'blue'])
    assert.notEqual(out.status, 0, '坏边界必须非零退出')
    assert.ok(out.stdout.includes('bad bound'), '要报出 bad bound')
    assert.ok(out.stdout.includes('-X1') && out.stdout.includes('-X0'), '要报出具体字段名')
    assert.ok(out.stdout.includes('INCLUSIVE'), '要重申包含边界语义')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

/* ══════════════════════════════════════════════════════════════════════════
   2026-11-29 一批 G16…G20 与 measure.ps1 的 -Regions 批量口（省轮次的机制改动）。
   五道新门只追加、不新增观察/量测轮次；-Regions 一帧一次调用量多区，每区判据各自独立，
   单区旧 CLI 语义与默认值逐字向后兼容（回归里真跑脚本，不 mock）。
   ══════════════════════════════════════════════════════════════════════════ */

cases.push(['五道新门 G16…G20：只追加在末尾、门名与机械条件合规，且不新增观察或量测轮次', async () => {
  const rule = computerUseCoordinatePolicyText()
  const lines = CU_COORDINATE_GATES.map(cuCoordinateGateLine)
  assert.deepEqual(lines.slice(12).map((line) => GATE_LINE.exec(line)?.[1]),
    ['G14', 'G15', 'G16', 'G17', 'G18', 'G19', 'G20', 'G21', 'G22', 'G23', 'G24'],
    'G16…G20 与 G21…G24 只准按用户给定门号追加在末尾（G13 仍是空号）')
  const expected = { G16: '弹层枚举', G17: '落盘核验', G18: '剪贴板优先', G19: '变灰必解状态', G20: '输入落点确认' }
  for (const [id, axis] of Object.entries(expected)) {
    const gate = CU_COORDINATE_GATES.find((item) => item.id === id)
    assert.ok(gate, `缺 ${id}`)
    assert.equal(gate.axis, axis, `${id} 的门名应是「${axis}」`)
    assert.ok(rule.includes(cuCoordinateGateLine(gate)), `${id} 必须渲染进正文`)
    assert.match(gate.when, /[∈∉≠≥=]/, `${id} 条件必须含机械关系符（∈/∉/≠/≥/=）：${gate.when}`)
    assert.ok(!SOFT_WORDS.test(cuCoordinateGateLine(gate)), `${id} 不许写成建议/散文`)
    assert.ok(!/screenshot|wait|sleep/.test(gate.when + gate.then), `${id} 不许提 screenshot/wait/sleep`)
  }
  // 零新增轮次的具体证据：G16 复用同一次 -Split 的簇行、G17 只发 1 条目录查询、G20 只看回执帧。
  const g16 = CU_COORDINATE_GATES.find((gate) => gate.id === 'G16')
  assert.ok(g16.then.includes('同一次 -Split'), 'G16 的簇枚举必须复用同一次测量输出')
  assert.ok(g16.then.includes('禁止用上一行 y 推算下一行坐标'), 'G16 不许用上一行 y 推算下一行（会点偏）')
  const g17 = CU_COORDINATE_GATES.find((gate) => gate.id === 'G17')
  assert.ok(/1 条 Get-ChildItem/.test(g17.then), 'G17 只准 1 条 Get-ChildItem')
  assert.ok(g17.then.includes('mtime 与字节数'), 'G17 必须核 mtime 与字节数两个读数')
  const g18 = CU_COORDINATE_GATES.find((gate) => gate.id === 'G18')
  assert.ok(g18.then.includes('最后兜底'), 'G18 里截图裁剪只作最后兜底')
  assert.ok(g18.then.includes('剪贴板给确定尺寸'), 'G18 必须写明剪贴板给确定尺寸')
  const g19 = CU_COORDINATE_GATES.find((gate) => gate.id === 'G19')
  for (const state of ['锁定', '未选中', '分组', '图层隐藏', '只读', '模态窗未关']) {
    assert.ok(g19.then.includes(state), `G19 的 gating 集合缺「${state}」`)
  }
  assert.ok(g19.then.includes('禁止判定该功能不存在'), 'G19 不许把变灰当成功能不存在')
  const g20 = CU_COORDINATE_GATES.find((gate) => gate.id === 'G20')
  assert.ok(g20.then.includes('回执帧见 caret'), 'G20 必须在回执帧里确认 caret')
  assert.ok(g20.then.includes('Ctrl+Z'), 'G20 看不到光标要撤销一次')
  assert.equal(rule.split('\n').filter((line) => line.startsWith('[G')).length, 23, '正文门行数应为 23')
}])

cases.push(['measure.ps1 -Regions 批量口：一帧一次调用量 2 区，每区各自给 TOTAL bbox 与 center', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-regions-'))
  try {
    const png = join(dir, 'two.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))\nd.rectangle([700, 500, 780, 540], fill=(0, 0, 255))')
    const out = runMeasure(measurePath, ['-Shot', png, '-Mode', 'blue', '-Regions', '0,600,0,300;600,900,400,600'])
    assert.equal(out.status, 0, `批量口应一次跑通：${out.stderr}\n${out.stdout}`)
    assert.match(out.stdout, /image: 1200x800 {3}regions=2 {3}mode=blue/, '批量口要先给一次图像尺寸与区数')
    assert.equal((out.stdout.match(/frame=/g) ?? []).length, 1, '整次调用只有一个帧指纹（同一帧）')
    assert.ok(out.stdout.includes('[R1] region: x 0..600  y 0..300'), '每区要标出自己的 region')
    assert.ok(out.stdout.includes('[R1] TOTAL bbox: x 100..180  y 100..140'), 'R1 的 bbox 只覆盖 R1 的目标')
    assert.ok(out.stdout.includes('[R2] TOTAL bbox: x 700..780  y 500..540'), 'R2 的 bbox 只覆盖 R2 的目标')
    assert.match(out.stdout, /\[R1\] center=\(140,120\) {2}fraction=\[\d+\.\d, \d+\.\d\]/, 'R1 要给自己区的 center 与 fraction')
    assert.match(out.stdout, /\[R2\] center=\(740,520\) {2}fraction=\[\d+\.\d, \d+\.\d\]/, 'R2 要给自己区的 center 与 fraction')
    assert.ok(!out.stdout.includes('NO MATCH'), '两个区都有目标，不许报 NO MATCH')
    assert.ok(!out.stdout.includes('MERGE-SPAN'), '两个区各只有一个簇，不许误报 MERGE-SPAN')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['measure.ps1 -Regions 每区判据各自独立：同一调用里 MERGE-SPAN / SPAN-EQUAL ACCEPT / REGION-ECHO 互不串区', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-regions-mix-'))
  try {
    const png = join(dir, 'mix.png')
    writeFixturePng(png, [
      'd.rectangle([100, 100, 180, 240], fill=(0, 0, 255))',
      'd.rectangle([220, 100, 300, 240], fill=(0, 0, 255))',
      'd.rectangle([400, 400, 413, 413], fill=(0, 0, 255))',
      'd.rectangle([100, 500, 300, 600], fill=(0, 0, 255))',
    ].join('\n'))
    const out = runMeasure(measurePath, ['-Shot', png, '-Mode', 'blue', '-Regions', '0,600,0,300;400,413,400,413;100,300,500,600'])
    assert.equal(out.status, 0, `批量口应一次跑通：${out.stderr}\n${out.stdout}`)
    // R1：跨 2 簇 ⇒ MERGE-SPAN 拒中心，但两簇中心在同一次输出里各给。
    assert.ok(out.stdout.includes('[R1] MERGE-SPAN REJECT'), 'R1 跨 2 簇必须判 MERGE-SPAN')
    assert.ok(out.stdout.includes('[R1] center=REJECT'), 'R1 中心必须拒收')
    assert.ok(out.stdout.includes('[R1] #1 bbox x 100..180 y 100..240'), 'R1 簇 #1 照给')
    assert.ok(out.stdout.includes('[R1] #2 bbox x 220..300 y 100..240'), 'R1 簇 #2 照给')
    // R2：手工窄区（14x14，两边都 < 60 px）同形不判回显 ⇒ ACCEPT，中心照给。
    assert.ok(out.stdout.includes('[R2] SPAN-EQUAL tight-region (<60px): center=ACCEPT'), 'R2 是手工窄区，必须 ACCEPT')
    assert.ok(!out.stdout.includes('[R2] REGION-ECHO'), 'R2 不许被判 REGION-ECHO')
    assert.match(out.stdout, /\[R2\] center=\(407,407\)/, 'R2 中心可用')
    // R3：大搜索区同形 ⇒ REGION-ECHO 拒中心，但簇中心照给。
    assert.ok(out.stdout.includes('[R3] REGION-ECHO: center=REJECT'), 'R3 必须判 REGION-ECHO')
    assert.ok(out.stdout.includes('[R3] center=REJECT'), 'R3 中心必须拒收')
    assert.ok(out.stdout.includes('[R3] clusters: 1'), 'R3 同一次输出仍要给簇数')
    // 判据互不串区。
    assert.ok(!out.stdout.includes('[R1] REGION-ECHO') && !out.stdout.includes('[R1] SPAN-EQUAL'), 'R1 只有 MERGE-SPAN 这一条')
    assert.ok(!out.stdout.includes('[R2] MERGE-SPAN'), 'R2 不许出现 MERGE-SPAN')
    assert.ok(!out.stdout.includes('[R3] MERGE-SPAN') && !out.stdout.includes('[R3] SPAN-EQUAL'), 'R3 只有 REGION-ECHO 这一条')
    // 三个区段按 -Regions 顺序输出（一帧一次调用，不换帧）。
    const r1 = out.stdout.indexOf('[R1] region:')
    const r2 = out.stdout.indexOf('[R2] region:')
    const r3 = out.stdout.indexOf('[R3] region:')
    assert.ok(r1 >= 0 && r2 > r1 && r3 > r2, '三个区段应按 -Regions 顺序输出')
    assert.equal((out.stdout.match(/frame=/g) ?? []).length, 1, '批量口只量一次帧')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['-Regions 向后兼容：不给 -Regions 时单区输出逐字是旧格式，同一个区走批量口数值不变', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-measure-regions-compat-'))
  try {
    const png = join(dir, 'one.png')
    writeFixturePng(png, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))')
    const single = runMeasure(measurePath, ['-Shot', png, '-X0', '100', '-X1', '500', '-Y0', '50', '-Y1', '300', '-Mode', 'blue'])
    assert.equal(single.status, 0, `单区应照旧跑通：${single.stderr}\n${single.stdout}`)
    const lines = single.stdout.replace(/\r/g, '').split('\n')
    assert.match(lines[0], /^frame=[0-9a-f]{16}$/, '单区第一行仍是帧指纹')
    assert.match(lines[1], /^shot=.+bytes=\d+ {2}mtime=/, '单区第二行仍是 shot/bytes/mtime')
    assert.match(lines[2], /^image: 1200x800 {3}region: x 100\.\.500 {2}y 50\.\.300 {3}mode=blue$/, '单区第三行仍是旧 image/region 行')
    assert.ok(single.stdout.includes('TOTAL bbox: x 100..180  y 100..140'), '单区 bbox 一字节不变')
    assert.match(single.stdout, /^ {2}center=\(140,120\) {2}fraction=\[\d+\.\d, \d+\.\d\]$/m, '单区中心仍是两空格缩进的旧格式')
    assert.ok(!single.stdout.includes('[R'), '单区输出不许出现批量前缀')
    // 同一个区改走批量口：数值一模一样，只多前缀与 region 行。
    const batch = runMeasure(measurePath, ['-Shot', png, '-Mode', 'blue', '-Regions', '100,500,50,300'])
    assert.equal(batch.status, 0, `单区批量口应跑通：${batch.stderr}\n${batch.stdout}`)
    assert.ok(batch.stdout.includes('[R1] TOTAL bbox: x 100..180  y 100..140'), '同一区必须同一 bbox')
    assert.match(batch.stdout, /\[R1\] center=\(140,120\) {2}fraction=\[116\.7, 150\.0\]/, '同一区必须同一中心与分数')
    // 单区坏边界照旧立即拒收（批量口的加入没改坏旧语义）。
    const bad = runMeasure(measurePath, ['-Shot', png, '-X0', '500', '-X1', '100', '-Mode', 'blue'])
    assert.notEqual(bad.status, 0, '单区坏边界必须非零退出')
    assert.ok(bad.stdout.includes('bad bound') && bad.stdout.includes('INCLUSIVE'), '单区坏边界照旧报 bad bound/INCLUSIVE')
    // 批量口自己的坏格式也要报出字段名。
    const badBatch = runMeasure(measurePath, ['-Shot', png, '-Mode', 'blue', '-Regions', '1,2,3'])
    assert.notEqual(badBatch.status, 0, '批量格式错必须非零退出')
    assert.ok(badBatch.stdout.includes('-Regions'), '批量格式错必须报 -Regions 字段名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['-Regions usage 与参数语义：批量口径写进 -Usage，默认值与 60 px 门槛常量一字不动（不新增门槛参数）', async () => {
  if (!measureAvailable) return console.log(`  skip - ${MEASURE_SKIP}`)
  const ps1 = readFileSync(measurePath, 'utf8')
  const core = readFileSync(join(measurePath, '..', 'measure_core.py'), 'utf8')
  assert.ok(ps1.includes('-Regions "<x0,x1,y0,y1>;<x0,x1,y0,y1>"'), 'usage 必须写出 -Regions 的批量口径')
  assert.ok(/\$Regions/.test(ps1), 'measure.ps1 必须有 -Regions 参数')
  assert.ok(/one region/i.test(ps1) || ps1.includes('"x0,x1,y0,y1" regions measured in ONE call'), 'usage 必须说明一帧一次调用量多区')
  assert.ok(core.includes('def parse_regions'), 'core 必须解析 -Regions（分号分隔、区内逗号）')
  assert.ok(core.includes("regions_arg = argv[12] if len(argv) > 12 else ''"), 'core 只认第 12 个位置参数，旧 11 参调用不变')
  assert.ok(core.includes('ECHO_MIN_SPAN_PX = 60'), '门槛仍是同一个常量（不新增门槛参数、不做第二个门）')
  assert.ok(!/ECHO_MIN/.test(ps1), '门槛数值只准待在 core 里，PS 侧不许另算一套')
  assert.ok(ps1.includes('[int]$MinPixels = 3') && ps1.includes('[int]$MergeGap = 10')
    && ps1.includes('[int]$MinWidth = 2') && ps1.includes('[int]$MinHeight = 2'), '既有默认值一字不许改')
  const usage = runMeasure(measurePath, ['-Usage'])
  assert.equal(usage.status, 0, `-Usage 应退出 0：${usage.stderr}`)
  for (const marker of ['-Regions', 'ONE call', '[Rk]', 'INCLUSIVE', 'shot-cache.png']) {
    assert.ok(usage.stdout.includes(marker), `批量口径的 usage 缺「${marker}」：\n${usage.stdout}`)
  }
}])


cases.push(['没有 agent 的装配（诊断用）不许抛错也不注入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cmpol-'))
  try {
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const harness = makeHostHarness(dir)
    const dispose = registerCoordinateMode(harness.ctx)
    const chain = harness.hooks.get('system-prompt/assemble') ?? []
    const payload = { sections: [], contexts: [], variables: {} }
    let thrown = null
    try {
      for (const fn of chain) await fn(payload, {}, async () => payload)
    } catch (err) {
      thrown = err
    }
    assert.equal(thrown, null, `诊断装配不该抛错：${thrown?.message ?? ''}`)
    assert.ok(!payload.sections.some((section) => String(section?.name ?? '').includes('coordinate-policy')), '诊断装配不该带 CU 规则段')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

/* ══════════════════════════════════════════════════════════════════════════
   2026-11-29 目标表（坐标缓存）：门 G21…G24、开关、路径、真实 scan_frame + target_table.py 跑通。
   验收口径（用户定稿方案）：结构没变查表零测量；结构一变旧表作废重扫；兜底单次 0.2s；
   失效条件（滚动/弹窗/跳页/切标签/窗口移动缩放/DPI/coordinate_space）逐条可判。
   ══════════════════════════════════════════════════════════════════════════ */

const tableScriptCtx = { get: (name) => (name === 'profileContext' ? { dir: join(homedir(), '.dsh', 'profiles', 'desktop') } : undefined) }
const scanFramePath = cuScanFrameScriptPath(tableScriptCtx)
const targetTableScriptPath = cuTargetTableScriptPath(tableScriptCtx)
const TABLE_SKIP = 'target_table.py / scan_frame.ps1 不在本机（<DSH_HOME>/cu-click），跳过真跑'

function runTargetTable(args, env = {}) {
  const result = spawnSync('python', [targetTableScriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function outputField(stdout, name) {
  const match = new RegExp(`(?:^|\\s)${name}=(\\S*)`, 'm').exec(stdout)
  return match ? match[1] : ''
}

cases.push(['目标表开关：默认开启、DSH_CU_TARGET_TABLE=0/false/off 关闭、正文随开关切换', async () => {
  assert.equal(CU_TARGET_TABLE_DEFAULT_ENABLED, true, '缺省必须开启（关掉只要设环境变量）')
  assert.equal(targetTableEnabled({}), true, '没有环境变量时开启')
  assert.equal(targetTableEnabled({ [CU_TARGET_TABLE_ENV]: '1' }), true, '1 仍是开启')
  for (const off of ['0', 'false', 'no', 'off', 'disable', 'disabled', ' OFF ']) {
    assert.equal(targetTableEnabled({ [CU_TARGET_TABLE_ENV]: off }), false, `「${off}」应关闭目标表`)
  }
  const on = computerUseCoordinatePolicyText()
  assert.ok(on.includes('scan --shot'), '开启时正文必须写扫描命令')
  assert.ok(on.includes('hit --name'), '开启时正文必须写查表命令')
  const offText = computerUseCoordinatePolicyText(undefined, undefined, undefined, false)
  assert.ok(offText.includes('目标表已关闭'), '关闭时正文必须写明已关闭')
  assert.ok(!offText.includes('scan --shot'), '关闭时不许再让模型跑 scan（整套机制停用）')
  assert.ok(offText.includes('measure.ps1'), '关闭时仍要保留逐目标量测路径')
  // 门是规格，不随运行期开关消失（G21…G24 仍在门表里，开关句说明它们停用）。
  assert.equal(offText.split('\n').filter((line) => line.startsWith('[G')).length, 23, '关闭时门表仍是 23 道')
  assert.ok(offText.includes('G21…G24 停用'), '关闭句要点名 G21…G24 停用')
}])

cases.push(['目标表路径与常量：按 profile 目录退回 DSH_HOME，口径与门文同源', async () => {
  const fakeRoot = join(tmpdir(), 'dsh-root-fixture-target-table')
  const fakeCtx = { get: (name) => (name === 'profileContext' ? { dir: join(fakeRoot, 'profiles', 'desktop') } : undefined) }
  assert.equal(cuScanFrameScriptPath(fakeCtx), join(fakeRoot, 'cu-click', 'scan_frame.ps1'), '扫描器应落在 <DSH_HOME>/cu-click')
  assert.equal(cuTargetTableScriptPath(fakeCtx), join(fakeRoot, 'cu-click', 'target_table.py'), '目标表包装器应落在 <DSH_HOME>/cu-click')
  assert.equal(cuTargetTableDir(fakeCtx), join(fakeRoot, 'cu-click', 'target-table'), '表目录应落在 <DSH_HOME>/cu-click/target-table')
  assert.ok(cuScanFrameScriptPath().endsWith(join('cu-click', 'scan_frame.ps1')))
  assert.ok(cuTargetTableDir().endsWith(join('cu-click', 'target-table')))
  // 0.2s 封顶 / 重试 1 次 / 8 px 网格 / ±2 px 抖动 / 预览换算常数：门文里逐字对得上。
  assert.equal(CU_TARGET_TABLE_FALLBACK_BUDGET_MS, 200)
  assert.equal(CU_TARGET_TABLE_MAX_RETRY, 1)
  assert.equal(CU_TARGET_TABLE_STRUCT_GRID_PX, 8)
  assert.ok(CU_TARGET_TABLE_STRUCT_GRID_PX >= CU_TARGET_TABLE_JITTER_PX * 2, '网格至少是抖动的 2 倍，±2 px 才落在同一格')
  assert.ok(Math.abs(CU_TARGET_TABLE_PREVIEW_SCALE.x - 1920 / 1792) < 1e-12, 'x 换算常数 = 1920/1792')
  assert.ok(Math.abs(CU_TARGET_TABLE_PREVIEW_SCALE.y - 1032 / 963) < 1e-12, 'y 换算常数 = 1032/963')
  assert.ok(Math.abs(Number(CU_TARGET_TABLE_PREVIEW_SCALE.x.toFixed(4)) - 1.0714) < 1e-9)
  assert.ok(Math.abs(Number(CU_TARGET_TABLE_PREVIEW_SCALE.y.toFixed(4)) - 1.0717) < 1e-9)
  assert.deepEqual([...CU_TARGET_TABLE_INVALIDATING_ACTIONS].sort(),
    ['dialog', 'dpi-change', 'navigate', 'scroll', 'tab-switch', 'window-move', 'window-resize'])
  const rule = computerUseCoordinatePolicyText()
  assert.ok(rule.includes(`${CU_TARGET_TABLE_FALLBACK_BUDGET_MS / 1000}s`), '正文 0.2s 必须由常量渲染')
  assert.ok(rule.includes(`最多重试 ${CU_TARGET_TABLE_MAX_RETRY} 次`), '正文重试次数必须由常量渲染')
  // 包装器源码的两个硬口径：必须显式传 -Shot（省略=静默取最新附件，会取错帧）、必须读开关环境变量。
  if (existsSync(targetTableScriptPath)) {
    const cli = readFileSync(targetTableScriptPath, 'utf8')
    assert.ok(cli.includes("'-Shot', str(shot)"), 'target_table.py 必须显式传 -Shot')
    assert.ok(cli.includes('DSH_CU_TARGET_TABLE'), 'target_table.py 必须读 DSH_CU_TARGET_TABLE 开关')
    assert.ok(cli.includes('SCAN_BUDGET_MS = 200'), '兜底预算必须是 200ms（0.2s 封顶）')
  }
}])

cases.push(['策略正文：scan_frame 流程在场，不再只写 measure.ps1（上一轮退回纯目测的直接原因）', async () => {
  const rule = computerUseCoordinatePolicyText()
  for (const marker of ['scan_frame.ps1', 'scan --shot', 'target_table.py', 'target-table',
    '零测量、零等待、零新增调用', '定位不到', '同帧约 0.03s', '冷扫约 0.17s', '0.2s',
    '1.0714', '1.0717', 'coordinate_space', '--action', 'hit --name']) {
    assert.ok(rule.includes(marker), `策略正文缺「${marker}」`)
  }
  assert.ok(rule.includes('必须显式传 -Shot'), '省略 -Shot 会静默取最新附件，正文必须点明')
  assert.ok(rule.indexOf('scan_frame.ps1') < rule.indexOf('6. 量'), '查表/扫描流程必须排在量测路径之前')
  assert.ok(rule.includes('measure.ps1'), '表不可用时仍要给 measure.ps1 路径（放行，不拦死）')
}])

cases.push(['目标表真跑：建表→复用→命中→±2px 抖动不失效→结构变/尺寸变/坐标空间变作废', async () => {
  if (!existsSync(targetTableScriptPath) || !existsSync(scanFramePath)) return console.log(`  skip - ${TABLE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-target-table-'))
  const state = join(dir, 'state')
  try {
    // 一帧三块蓝色按钮：布局 A。
    const frameA = join(dir, 'a.png')
    writeFixturePngSize(frameA, 1200, 800, [
      'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))',
      'd.rectangle([400, 300, 480, 340], fill=(0, 0, 255))',
      'd.rectangle([700, 500, 780, 540], fill=(0, 0, 255))',
    ].join('\n'))
    const first = runTargetTable(['scan', '--shot', frameA, '--state', state])
    assert.equal(first.status, 0, `scan 应退出 0：${first.stderr}\n${first.stdout}`)
    assert.equal(outputField(first.stdout, 'target_table'), 'enabled')
    assert.equal(outputField(first.stdout, 'table_status'), 'rebuilt', '首扫必须建表')
    assert.equal(outputField(first.stdout, 'coordinate_space'), 'pixel:1200x800')
    assert.match(outputField(first.stdout, 'struct'), /^[0-9a-f]{16}$/, '结构指纹必须是 16 位 hex')
    assert.equal(outputField(first.stdout, 'budget_ms'), '200', '兜底预算常量必须是 200ms')
    assert.ok(['ok', 'over'].includes(outputField(first.stdout, 'budget')),
      `预算标记只准是 ok/over（实测 ${outputField(first.stdout, 'scan_elapsed_ms')}ms）`)
    assert.equal(outputField(first.stdout, 'reasons'), '', '首扫没有旧表，不该有失效原因')
    const tablePathA = outputField(first.stdout, 'table')
    assert.ok(existsSync(tablePathA), `表必须落盘：${tablePathA}`)
    assert.ok(tablePathA.includes('target-table'), '表要落在 target-table 目录下')

    const tableA = JSON.parse(readFileSync(tablePathA, 'utf8'))
    assert.equal(tableA.version, 1)
    assert.deepEqual(tableA.frame_size, { w: 1200, h: 800 })
    assert.equal(tableA.coordinate_space, 'pixel:1200x800')
    assert.match(tableA.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, '表里必须有生成时间')
    assert.ok(Array.isArray(tableA.elements) && tableA.elements.length >= 3, '三个按钮都应入表')
    for (const element of tableA.elements) {
      assert.match(element.name, /^R\d{2}C\d{2}-(button|input|menu-row|icon)$/, `元素名必须稳定可读：${element.name}`)
      assert.equal(typeof element.center.x, 'number')
      assert.equal(typeof element.center.y, 'number')
      assert.ok(element.bbox.x0 <= element.center.x && element.center.x <= element.bbox.x1, '中心必须落在 bbox 内')
    }
    const names = tableA.elements.map((element) => element.name)
    assert.equal(new Set(names).size, names.length, '元素名必须唯一')
    // 同一帧再扫：命中缓存表，不重建、不冒新表。
    const second = runTargetTable(['scan', '--shot', frameA, '--state', state])
    assert.equal(second.status, 0)
    assert.equal(outputField(second.stdout, 'table_status'), 'reused', '同一帧必须复用同一张表')
    assert.equal(outputField(second.stdout, 'table'), tablePathA, '同一帧的表路径不许变')
    assert.equal(outputField(second.stdout, 'reasons'), '', '同一帧不该报失效')

    // 零测量查表：hit 只读文件，不碰像素。
    const target = tableA.elements[0]
    const hit = runTargetTable(['hit', '--name', target.name, '--state', state])
    assert.equal(hit.status, 0)
    assert.equal(outputField(hit.stdout, 'hit'), '1', `按名字必须命中：${target.name}\n${hit.stdout}`)
    assert.ok(hit.stdout.includes(`center=(${target.center.x},${target.center.y})`), '命中必须给表内中心坐标')
    const miss = runTargetTable(['hit', '--name', 'R99C99-button', '--state', state])
    assert.equal(outputField(miss.stdout, 'hit'), '0')
    assert.ok(miss.stdout.includes('定位不到'), '未命中必须报「定位不到」')
    const byFrame = runTargetTable(['hit', '--frame-hash', tableA.frame_hash, '--state', state])
    assert.equal(outputField(byFrame.stdout, 'frame_hash_hit'), '1', '整帧像素级命中是零扫描快路')

    // 布局不变、像素变（内容整体挪 2 px）：帧哈希换了，结构指纹不变 ⇒ 表继续有效。
    const frameA2 = join(dir, 'a2.png')
    writeFixturePngSize(frameA2, 1200, 800, [
      'd.rectangle([102, 100, 182, 140], fill=(0, 0, 255))',
      'd.rectangle([402, 300, 482, 340], fill=(0, 0, 255))',
      'd.rectangle([702, 500, 782, 540], fill=(0, 0, 255))',
    ].join('\n'))
    const jitter = runTargetTable(['scan', '--shot', frameA2, '--state', state])
    assert.equal(jitter.status, 0)
    assert.notEqual(outputField(jitter.stdout, 'frame'), tableA.frame_hash, '两张图的帧哈希必须不同（像素级键会误判）')
    assert.equal(outputField(jitter.stdout, 'struct'), tableA.structural_hash, '±2 px 抖动不许换结构指纹')
    assert.equal(outputField(jitter.stdout, 'table_status'), 'reused', '±2 px 抖动必须复用旧表，不作废')
    assert.equal(outputField(jitter.stdout, 'table'), tablePathA)

    // 光标/caret 这类小簇一闪：不许换结构指纹（否则就是拿像素级哈希当唯一键）。
    // 造一个「光标尖」形状的小簇（两条细线拼成 18x25、像素很少），远小于真按钮。
    const frameCursor = join(dir, 'a-cursor.png')
    writeFixturePngSize(frameCursor, 1200, 800, [
      'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))',
      'd.rectangle([400, 300, 480, 340], fill=(0, 0, 255))',
      'd.rectangle([700, 500, 780, 540], fill=(0, 0, 255))',
      'd.rectangle([600, 200, 601, 224], fill=(20, 20, 20))',
      'd.rectangle([600, 200, 617, 201], fill=(20, 20, 20))',
    ].join('\n'))
    const cursor = runTargetTable(['scan', '--shot', frameCursor, '--state', state])
    assert.equal(cursor.status, 0)
    assert.equal(outputField(cursor.stdout, 'struct'), tableA.structural_hash, '光标小簇不许改结构指纹')
    assert.equal(outputField(cursor.stdout, 'table_status'), 'reused', '光标一闪必须复用旧表，不许作废')
    assert.ok(Number(outputField(cursor.stdout, 'transient_clusters')) >= 1, '小簇要记进 transient_clusters')
    const cursorTable = JSON.parse(readFileSync(outputField(cursor.stdout, 'table'), 'utf8'))
    assert.equal(cursorTable.structural_hash, tableA.structural_hash)
    assert.ok(cursorTable.transient_clusters >= 1, '表里要记 transient_clusters（供人核对）')
    assert.ok(cursorTable.struct_clusters >= 3, '表里要记参与指纹的结构簇数')
    assert.ok(!cursorTable.elements.some((element) => (
      element.bbox.x0 >= 595 && element.bbox.x1 <= 622 && element.bbox.y0 >= 195 && element.bbox.y1 <= 230
    )), '光标小簇不许进元素表（它不是可点元素）')

    // 布局变（多一个按钮）：结构指纹变 ⇒ 作废旧表并重建。
    const frameB = join(dir, 'b.png')
    writeFixturePngSize(frameB, 1200, 800, [
      'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))',
      'd.rectangle([400, 300, 480, 340], fill=(0, 0, 255))',
      'd.rectangle([700, 500, 780, 540], fill=(0, 0, 255))',
      'd.rectangle([900, 200, 980, 240], fill=(0, 0, 255))',
    ].join('\n'))
    const changed = runTargetTable(['scan', '--shot', frameB, '--state', state])
    assert.equal(changed.status, 0)
    assert.equal(outputField(changed.stdout, 'table_status'), 'rebuilt', '结构变必须重扫重建')
    assert.ok(outputField(changed.stdout, 'reasons').includes('structural_hash'), '失效原因必须点名 structural_hash')
    assert.equal(outputField(changed.stdout, 'invalidated'), tableA.table_key, '作废的旧表键必须报出来')
    assert.notEqual(outputField(changed.stdout, 'table'), tablePathA, '新结构必须是新表文件')

    // 动作类失效：滚动/弹窗/跳页/切标签/窗口移动缩放/DPI 必须带 --action 重扫。
    const action = runTargetTable(['scan', '--shot', frameB, '--state', state, '--action', 'scroll'])
    assert.equal(action.status, 0)
    assert.ok(outputField(action.stdout, 'reasons').includes('action:scroll'), '--action 必须记进失效原因')

    // 帧尺寸变：同一窗口缩放 ⇒ 旧表作废（frame_size）。
    const frameC = join(dir, 'c.png')
    writeFixturePngSize(frameC, 1400, 900, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))')
    const resized = runTargetTable(['scan', '--shot', frameC, '--state', state])
    assert.equal(resized.status, 0)
    assert.equal(outputField(resized.stdout, 'coordinate_space'), 'pixel:1400x900')
    assert.ok(outputField(resized.stdout, 'reasons').includes('frame_size'), '窗口缩放必须按 frame_size 作废')

    // 坐标空间变：1792x963 预览 ⇒ 旧表作废，并打印换算常数。
    const frameD = join(dir, 'd.png')
    writeFixturePngSize(frameD, 1792, 963, 'd.rectangle([100, 100, 180, 140], fill=(0, 0, 255))')
    const preview = runTargetTable(['scan', '--shot', frameD, '--state', state])
    assert.equal(preview.status, 0)
    assert.equal(outputField(preview.stdout, 'coordinate_space'), 'pixel:1792x963')
    assert.ok(outputField(preview.stdout, 'reasons').includes('coordinate_space'), '预览/帧坐标空间不同必须作废旧表')
    assert.equal(outputField(preview.stdout, 'scale_to_frame'), '1.0714,1.0717', '预览帧必须给换算常数')
    const previewTable = JSON.parse(readFileSync(outputField(preview.stdout, 'table'), 'utf8'))
    assert.deepEqual(previewTable.preview_scale.x, 1.0714)
    assert.deepEqual(previewTable.preview_scale.y, 1.0717)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['目标表放行与开关：扫失败不拦死（告警 + 原坐标），DSH_CU_TARGET_TABLE=0 时连扫都不扫', async () => {
  if (!existsSync(targetTableScriptPath) || !existsSync(scanFramePath)) return console.log(`  skip - ${TABLE_SKIP}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-target-table-off-'))
  const state = join(dir, 'state')
  try {
    const broken = runTargetTable(['scan', '--shot', join(dir, 'nope.png'), '--state', state])
    assert.equal(broken.status, 0, '扫失败也必须退出 0（放行，不许拦死）')
    assert.ok(broken.stdout.includes('scan=failed'), '要报 scan=failed')
    assert.ok(broken.stdout.includes('放行'), '要明确写「放行：按原坐标点并告警」')
    assert.ok(!existsSync(join(state, 'current.json')), '扫失败不许写活动表')

    const off = runTargetTable(['scan', '--shot', join(dir, 'nope.png'), '--state', state], { [CU_TARGET_TABLE_ENV]: '0' })
    assert.equal(off.status, 0)
    assert.equal(outputField(off.stdout, 'target_table'), 'disabled')
    assert.ok(off.stdout.includes('回退逐目标量测'), '关闭时必须说明回退 measure.ps1')
    const hitOff = runTargetTable(['hit', '--name', 'R01C01-button', '--state', state], { [CU_TARGET_TABLE_ENV]: '0' })
    assert.equal(outputField(hitOff.stdout, 'target_table'), 'disabled')
    assert.ok(!existsSync(join(state, 'current.json')), '关闭时查表也不许造活动表')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`ok - ${name}`)
  } catch (err) {
    failed += 1
    console.error(`fail - ${name}`)
    console.error(err)
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${cases.length} 失败`)
  process.exit(1)
}
console.log(`\n${cases.length}/${cases.length} 通过`)



