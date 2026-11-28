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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { registerCoordinateMode, COORDINATE_MODE_ROUTE, computerUseCoordinatePolicyText, cuMeasureScriptPath, CU_POLICY_SECTION_ORDER } from '../src/coordinate-mode.ts'

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
   2026-11-28 CU 坐标硬规则注入回归（src/coordinate-mode.ts 的注入段）
   真监听器串联：宿主 SystemPrompt.section 的注册 → 宿主先解析段落 text(context) →
   system-prompt/assemble 瀑布按注册顺序（最外层先跑）依次喂同一个载荷 →
   瀑布之后才挂 tools。被测的那一段（注册 + 瀑布 + 门控）一律走真实代码，不 mock。
   ══════════════════════════════════════════════════════════════════════════ */

/** 规则里必须在场的关键句（用户口径：先量后点 / 包围盒 / 落点核对 / 连续 2 次 / 固定脚本）。 */
const RULE_MARKERS = ['先量后点', '包围盒', 'Pointer landed', '连续 2 次', 'measure.ps1', 'attached_size']

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
  assert.ok(text.includes('坐标硬规则'), `${label}：装配出的系统提示里应有这段规则`)
  for (const marker of RULE_MARKERS) {
    assert.ok(text.includes(marker), `${label}：规则里缺关键句「${marker}」`)
  }
  assert.equal(text.split('坐标硬规则').length - 1, 1, `${label}：同一份装配里不许注入两遍`)
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
    assert.ok(first.text.indexOf(VENDOR_POLICY_MARKER) < first.text.indexOf('坐标硬规则'),
      '规则应紧跟在这次会话的坐标口径之后')
    assert.ok(first.text.includes(cuMeasureScriptPath(harness.ctx)),
      '规则里的量坐标脚本路径应按宿主给的 profile 目录派生')
    assert.ok(Array.isArray(first.assembly.tools), '瀑布之后装配载荷仍应带 tools（4519444 的补丁没被冲垮）')

    const second = await assemblePresentation(harness, session)
    assert.ok(second.text.includes('先量后点'), '下一轮装配仍应带规则（不是会话创建时一次性拼死）')
    assert.equal(second.text.split('坐标硬规则').length - 1, 1, '下一轮也不许重复注入')
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
    assert.ok(!assembled.text.includes('坐标硬规则'), '标准会话的提示里不该有 CU 规则')
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

cases.push(['规则正文：关键句齐、长度受控、坐标算式与脚本参数都在', async () => {
  const rule = computerUseCoordinatePolicyText()
  for (const marker of RULE_MARKERS) assert.ok(rule.includes(marker), `规则正文缺「${marker}」`)
  assert.ok(rule.includes('分数 = 中心像素 ÷ 截图宽或高 × 1000'), '缺少分数换算算式')
  assert.ok(rule.includes('click / drag / input_text / long_press'), '四个动手类工具必须逐个点名')
  assert.ok(rule.includes('同一目标连续 2 次未命中'), '缺少连续 2 次未命中的改路口径')
  assert.ok(rule.includes('不许第 3 次盲点'), '缺少不许第 3 次盲点')
  assert.ok(rule.includes('-Shot <截图> -X0 -X1 -Y0 -Y1 -Mode dark|blue|yellow|gray -Split -MinPixels'), '脚本参数口径不完整')
  assert.ok(rule.includes('TOTAL bbox') && rule.includes('center=(x,y) fraction=[x,y]'), '脚本输出字段没写清')
  const cjk = (rule.match(/[\u4e00-\u9fff]/g) ?? []).length
  assert.ok(cjk <= 300, `规则正文要短：汉字 ${cjk} 个（上限 300）、全段 ${[...rule].length} 字符`)
  assert.ok([...rule].length <= 700, `规则正文字符数超限：${[...rule].length}`)
  assert.ok(CU_POLICY_SECTION_ORDER > 1750 && CU_POLICY_SECTION_ORDER < 1770, `段位次序应紧跟内嵌 SU 的 1750（实际 ${CU_POLICY_SECTION_ORDER}）`)
  assert.ok(cuMeasureScriptPath().endsWith(join('cu-click', 'measure.ps1')), '量坐标脚本路径应落在 <DSH_HOME>/cu-click 下')
  // 宿主真形态：profile 目录 = <DSH_HOME>/profiles/<名字>，脚本在 <DSH_HOME>/cu-click/ 下
  const fakeRoot = join(tmpdir(), 'dsh-root-fixture')
  const fakeCtx = { get: (name) => (name === 'profileContext' ? { dir: join(fakeRoot, 'profiles', 'desktop') } : undefined) }
  assert.equal(cuMeasureScriptPath(fakeCtx), join(fakeRoot, 'cu-click', 'measure.ps1'), '脚本路径应从 profile 目录退回 DSH_HOME')
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
