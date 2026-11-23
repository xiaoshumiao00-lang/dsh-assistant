/**
 * 个人秘书「派活目录由模型决定 + 规则兜底」单测（不启动 DSH、不碰真实目录）：
 *   node scripts/test-assistant-dispatch.mjs
 *
 * 覆盖：
 *   - 模型给了合法绝对路径 → 用模型的目录（decidedBy='model'），不再跑规则；
 *   - 模型没给 / 给了非法路径 → 规则函数兜底（decidedBy='rules'），三条规则仍然生效；
 *   - 工具定义形状（参数/输出 schema 合法，名称固定）；
 *   - 提示词段落只对秘书会话有内容，且把三条规则 + 助手目录 + 项目清单写进去；
 *   - 派活回执三态口径（2026-11-23 用户定案）：观测到会话接上话才写「已派活」；只入队写
 *     「已入队（未确认在跑）」；入队抛错 = 抛错、绝不新建、绝不出「已派活」；
 *     续接轮失败（error/aborted）→ 自动改新建并如实写「续接失败已改新建」；
 *   - 续接候选的模型可用性：读得到清单就按「模型还配着吗」排除退役会话（回执指名跳过哪条），
 *     读不到清单或读不到模型选择 = 不猜、不排除。
 */
import assert from 'node:assert/strict'

const lib = await import('../lib/index.js')
const surface = lib.assistantDispatchTestSurface

const ASSISTANT = 'C:\\Users\\<ACCOUNT>\\.dsh\\assistant'
const PARENT = 'D:\\Projects'
const NOW = new Date(2026, 10, 20, 23, 30)
const QQ_SCREEN_QUESTION = '你看我打开的 QQ 页面，他们说的 38 fn 指什么模型？'

const projects = [
  { dir: 'D:\\hpg', name: 'hpg 小程序', titles: ['修店铺详情页白屏'], lastUsedAt: 3 },
  { dir: 'D:\\<PRIVATE-ARCHIVE-ROOT>\\15 高珂中文论文', name: '高珂中文论文', titles: ['第5章算法改用SCI完整算法'], lastUsedAt: 2 },
]

const cases = []

cases.push(['模型给合法目录 → 采用模型判断', () => {
  const r = surface.resolveDispatchTarget({
    task: '把 hpg 小程序的门店详情页再改一下',
    cwd: 'D:\\hpg',
    kind: 'existing',
    projects,
    assistantHome: ASSISTANT,
    newFolderParent: PARENT,
  })
  assert.equal(r.decidedBy, 'model')
  assert.equal(r.kind, 'existing')
  assert.equal(r.cwd, 'D:\\hpg')
  assert.match(r.reason, /模型/)
}])

cases.push(['模型目录末尾分隔符被归一', () => {
  const r = surface.resolveDispatchTarget({ task: 'x', cwd: 'D:\\hpg\\', projects, assistantHome: ASSISTANT })
  assert.equal(r.cwd, 'D:\\hpg')
  assert.equal(r.decidedBy, 'model')
}])

cases.push(['模型没给目录 → 规则兜底：旧项目', () => {
  const r = surface.resolveDispatchTarget({
    task: '继续改高珂中文论文第5章的表',
    projects,
    assistantHome: ASSISTANT,
    newFolderParent: PARENT,
    now: NOW,
  })
  assert.equal(r.decidedBy, 'rules')
  assert.equal(r.kind, 'existing')
  assert.equal(r.cwd, 'D:\\<PRIVATE-ARCHIVE-ROOT>\\15 高珂中文论文')
}])

cases.push(['模型没给目录 → 规则兜底：简单动手活也新建专项文件夹', () => {
  const r = surface.resolveDispatchTarget({
    task: '帮我把桌面那张截图裁一下',
    projects,
    assistantHome: ASSISTANT,
    newFolderParent: PARENT,
    now: NOW,
  })
  assert.equal(r.decidedBy, 'rules')
  assert.equal(r.kind, 'new-folder')
  assert.match(r.cwd, /^D:\\Projects\\/)
}])

cases.push(['模型没给目录 → 规则兜底：复杂新活新建专项文件夹', () => {
  const r = surface.resolveDispatchTarget({
    task: '新建一个爬虫工程：先抓数据，然后合并，最后导出 Excel，所有文件都要加日志',
    projects,
    assistantHome: ASSISTANT,
    newFolderParent: PARENT,
    now: NOW,
  })
  assert.equal(r.decidedBy, 'rules')
  assert.equal(r.kind, 'new-folder')
  assert.match(r.cwd, /^D:\\Projects\\/)
  assert.ok(r.folderName)
}])

cases.push(['非法目录（相对路径/空）不采用，退回规则', () => {
  for (const cwd of ['', '   ', 'relative\\dir', 'hpg']) {
    const r = surface.resolveDispatchTarget({ task: '帮我把这句话翻译成英文', cwd, projects, assistantHome: ASSISTANT, newFolderParent: PARENT, now: NOW })
    assert.equal(r.decidedBy, 'rules', `cwd=${JSON.stringify(cwd)}`)
    assert.equal(surface.isUsableTargetDir(cwd), false)
  }
  assert.equal(surface.isUsableTargetDir('D:\\a'), true)
  assert.equal(surface.isUsableTargetDir('\\\\server\\share'), true)
  assert.equal(surface.isUsableTargetDir('/home/x'), true)
}])

cases.push(['纯知识随口问不派活（今天几号）', () => {
  for (const task of ['个人秘书是干什么的', '今天几号']) {
    const r = surface.resolveDispatchTarget({ task, projects, assistantHome: ASSISTANT, newFolderParent: PARENT })
    assert.equal(r.kind, 'chat', task)
    assert.equal(r.cwd, '', task)
  }
}])

cases.push(['用户 QQ 原话：看屏问题默认走分层 C，不许直接终答', () => {
  const r = surface.resolveDispatchTarget({ task: QQ_SCREEN_QUESTION, projects, assistantHome: ASSISTANT, newFolderParent: PARENT, now: NOW })
  assert.equal(r.kind, 'new-folder')
  assert.match(r.cwd, /^D:\\Projects\\/)
  assert.notEqual(r.kind, 'chat')
  assert.notEqual(r.kind, 'assistant')
}])

cases.push(['工具定义：名字/schema/渲染齐全', () => {
  const tool = surface.dispatchToolDefinition({})
  assert.equal(tool.name, 'secretary_dispatch')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['task'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['cwd', 'kind', 'task'])
  assert.deepEqual(tool.parameters.properties.kind.enum, ['existing', 'new-folder'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.output.schema.type, 'object')
  assert.ok(tool.output.schema.required.includes('verification'), '回执必须带三态字段')
  assert.ok(tool.output.schema.required.includes('verified'), '回执必须带 verified')
  assert.ok(tool.output.schema.required.includes('redispatched'), '回执必须带降级标记')
  const text = tool.output.render({}, { session_id: 's1', cwd: 'D:\\hpg', kind: 'existing', reason: 'r', decided_by: 'model', created_folder: false, continued: true, agent_preset: 'computer-use', verification: 'confirmed', verified: true, redispatched: false, turn: 3, pending: false })[0].text
  assert.match(text, /已派活/)
  assert.match(text, /已确认在跑/)
  assert.match(text, /秘书模型判断/)
  assert.match(text, /D:\\hpg/)
  assert.match(text, /Computer Use/)
  // 工具描述里必须带 A/B/C 分层与「只派 Computer Use 会话」
  assert.match(tool.description, /默认|必须调用本工具/)
  assert.match(tool.description, /新建专项文件夹|new-folder/)
  assert.match(tool.description, /Computer Use/)
  assert.match(tool.description, /看屏幕|看当前.*页面/)
  assert.match(tool.description, /只读联网|web_search|联网/)
  assert.match(tool.description, /天气/)
  assert.match(tool.description, /看不到.*(?:收工|终答|做不了)|(?:收工|终答|做不了).*看不到/)
}])

cases.push(['宿主注册：secretary_dispatch 真的注册进工具清单', () => {
  const registered = []
  const ctx = {
    get: () => undefined,
    tools: { register(definition) { registered.push(definition.name); return () => {} } },
    on: () => () => {},
    logger: { warn() {} },
  }
  const dispose = surface.registerAssistantDispatch(ctx)
  assert.ok(registered.includes('secretary_dispatch'), '秘书回合的工具清单里必须有 secretary_dispatch')
  dispose()
}])

cases.push(['tools 服务晚就绪：延迟注册，不静默跳过', () => {
  const registered = []
  const scope = { tools: { register(definition) { registered.push(definition.name); return () => {} } } }
  let injected = []
  const ctx = {
    get: () => undefined,
    inject(deps, callback) { injected = deps; callback(scope); return {} },
    on: () => () => {},
    logger: { warn() {} },
  }
  const dispose = surface.registerAssistantDispatch(ctx)
  assert.deepEqual(injected, ['tools'], '必须等 tools 服务就绪再注册')
  assert.ok(registered.includes('secretary_dispatch'))
  dispose()
}])

cases.push(['用户原话「明天天气」：派活兜底也能成功建 CU 会话', async () => {
  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'sec-1'
  const calls = []
  const tool = surface.dispatchToolDefinition({
    get: () => undefined,
    sessionController: {
      create: async (req) => { calls.push(['create', req]); return { sessionId: 'cu-weather', agentPreset: 'computer-use' } },
      rename: async () => {},
      prompt: async (req) => { calls.push(['prompt', req]) },
    },
  })
  const out = await tool.execute({ task: '明天天气' }, { agent: { session: { id: 'sec-1' } } })
  assert.equal(out.session_id, 'cu-weather')
  assert.equal(out.agent_preset, 'computer-use')
  assert.equal(calls.find(([kind]) => kind === 'prompt')?.[1]?.content?.[0]?.text, '明天天气')
}])

cases.push(['提示词段落：A/B/C 分层 + 新项目父目录 + 项目清单', () => {
  const text = surface.dispatchPromptSection({}, projects)
  assert.match(text, /派活分层/)
  assert.match(text, /secretary_dispatch/)
  assert.match(text, /纯知识/)
  assert.match(text, /new-folder/)
  assert.doesNotMatch(text, /简单日常杂活.*直接/)
  assert.match(text, /D:\\hpg/)
  assert.match(text, /Computer Use/)
  assert.match(text, /看屏幕/)
  assert.match(text, /操作应用/)
  assert.match(text, /读.*本机文件/)
  // 只读联网查询由秘书直接做；联网不等于必须派活
  assert.match(text, /web_search/)
  assert.match(text, /web_fetch|只读联网/)
  assert.match(text, /天气/)
  assert.match(text, /禁止.*看不到|不得.*看不到/)
  assert.match(text, /先.*secretary_dispatch.*再.*已派|先派.*再.*已派/)
}])

cases.push(['用户 QQ 原话：工具产生 computer-use 派活并投递原话', async () => {
  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'sec-1'
  const calls = []
  const tool = surface.dispatchToolDefinition({
    get: () => undefined,
    sessionController: {
      create: async (req) => { calls.push(['create', req]); return { sessionId: 'cu-qq-screen', agentPreset: 'computer-use' } },
      rename: async () => {},
      prompt: async (req) => { calls.push(['prompt', req]) },
    },
  })
  const out = await tool.execute(
    { task: QQ_SCREEN_QUESTION, cwd: 'D:\\qq-screen-check', kind: 'existing' },
    { agent: { session: { id: 'sec-1' } } },
  )
  assert.equal(out.session_id, 'cu-qq-screen')
  assert.equal(out.agent_preset, 'computer-use')
  assert.equal(out.continued, false)
  assert.deepEqual(calls.find(([kind]) => kind === 'create')?.[1], { cwd: 'D:\\qq-screen-check', agentPreset: 'computer-use' })
  const prompt = calls.find(([kind]) => kind === 'prompt')?.[1]
  assert.equal(prompt?.sessionId, 'cu-qq-screen')
  assert.equal(prompt?.content?.[0]?.text, QQ_SCREEN_QUESTION)
}])

cases.push(['纯知识问题不建会话、不投 prompt', async () => {
  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'sec-1'
  let writes = 0
  const tool = surface.dispatchToolDefinition({
    get: () => undefined,
    sessionController: {
      create: async () => { writes += 1; return { sessionId: 'must-not-create', agentPreset: 'computer-use' } },
      prompt: async () => { writes += 1 },
    },
  })
  await assert.rejects(
    () => tool.execute({ task: '今天几号' }, { agent: { session: { id: 'sec-1' } } }),
    /纯知识|直接.*回答/,
  )
  assert.equal(writes, 0)
}])

cases.push(['工具执行：非秘书会话调用被拒', async () => {
  // 让进程里存在一条「固定秘书会话」，再从一个别的会话调用工具
  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'sec-1'
  const tool = surface.dispatchToolDefinition({
    tools: { register: () => () => {} },
    sessionController: { create: async () => ({ sessionId: 'x' }), prompt: async () => {}, rename: async () => {} },
  })
  await assert.rejects(
    () => tool.execute({ task: '做点事', cwd: 'D:\\hpg' }, { agent: { session: { id: 'someone-else' } } }),
    /只能在个人秘书会话里调用/,
  )
}])

/* ---------- 控制室项目清单实时快照段（2026-11-22 用户新需求；临时注册表，不动真注册表） ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function makeTempRegistry(state) {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dispatch-reg-'))
  writeFileSync(join(dir, 'dsh-assistant-state.json'), JSON.stringify(state))
  return dir
}

cases.push(['全景段：实时快照注明 + 目录行数 = 当次取到的项目数（临时注册表）', async () => {
  const { rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = await makeTempRegistry({
    projects: {
      folders: { a: 'D:\\proj-a', b: 'D:\\proj-b', c: 'D:\\proj-c', d: 'D:\\proj-d' },
      removed: ['d'],
      hidden: ['c'],
      nameOverrides: { a: '甲项目' },
      layouts: [{ id: 'b', title: '乙项目卡' }],
    },
  })
  surface.setDispatchRegistryDir(dir)
  surface.resetDispatchCacheForTests()
  surface.resetPromptSnapshotForTests()
  try {
    const ctx = {
      sessions: {
        list: () => [
          { header: { id: 's1', cwd: 'D:\\proj-a', title: '旧任务', updatedAt: 5 } },
          { header: { id: 's2', cwd: 'D:\\proj-x', title: '散会话', updatedAt: 9 } },
        ],
      },
    }
    const projects = surface.promptProjectSnapshot(ctx)
    // 注册表 a/b/c（d 被 removed 排除）∪ 会话 proj-a（同目录归并）/proj-x = 4 条
    assert.equal(projects.length, 4, 'removed 排除 + 同目录归并')
    const text = surface.consoleProjectsPromptSection(projects)
    assert.match(text, /实时快照/, '段落注明实时快照')
    assert.match(text, /以它为准/, '段落末尾注明以它为准')
    const dirLines = text.split('\n').filter((line) => line.startsWith('- '))
    assert.equal(dirLines.length, projects.length, '目录行数 = 当次取到的项目数')
    assert.ok(dirLines.some((line) => line.startsWith('- D:\\proj-a（甲项目）')), 'nameOverrides 名字沿用')
    assert.ok(dirLines.some((line) => line.startsWith('- D:\\proj-b（乙项目卡）')), 'layout 标题作名字')
    const hiddenLine = dirLines.find((line) => line.includes('D:\\proj-c'))
    assert.ok(hiddenLine && hiddenLine.includes('（隐藏）'), '隐藏卡保留并标注')
    assert.ok(!dirLines.some((line) => line.includes('proj-d')), 'removed 的目录不出现')
    assert.ok(dirLines.find((line) => line.includes('D:\\proj-x')), '无卡片的散会话目录也在全景里')
    assert.ok(projects[0].dir === 'D:\\proj-x' || projects[0].dir === 'D:\\proj-a', '最近在用的排前面（会话目录按 updatedAt 降序）')
  } finally {
    surface.setDispatchRegistryDir('')
    rmSync(dir, { recursive: true, force: true })
    surface.resetDispatchCacheForTests()
    surface.resetPromptSnapshotForTests()
  }
}])

cases.push(['全景段与派活段同源：同一快照引用、会话行同次组装只读一次', async () => {
  const { rmSync } = await import('node:fs')
  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'sec-panorama'
  // 临时注册表（不动真注册表）：两个活跃目录 + 一个隐藏卡
  const dir = await makeTempRegistry({
    projects: {
      folders: { a: 'D:\\pan-a', b: 'D:\\pan-b', h: 'D:\\pan-hidden' },
      removed: [],
      hidden: ['h'],
      nameOverrides: {},
      layouts: [],
    },
  })
  surface.setDispatchRegistryDir(dir)
  surface.resetDispatchCacheForTests()
  surface.resetPromptSnapshotForTests()
  const sections = new Map()
  let listCalls = 0
  const ctx = {
    get(name) {
      if (name === 'systemPrompt') return { section(s) { sections.set(s.order, s); return () => sections.delete(s.order) } }
      if (name === 'sessionQuery') return { listSessions: async () => { listCalls += 1; return [{ header: { id: 's1', cwd: 'D:\\pan-a', title: '旧任务', updatedAt: 5 } }] } }
      return undefined
    },
    on: () => () => {},
    logger: { warn() {} },
  }
  const dispose = surface.registerAssistantDispatch(ctx)
  try {
    const panorama = sections.get(1775)
    const dispatch = sections.get(1790)
    assert.ok(panorama, '1775 全景段已注册')
    assert.ok(dispatch, '1790 派活段已注册')
    const context = { agent: { session: { id: 'sec-panorama' } } }
    const textPanorama = panorama.text(context)
    const textDispatch = dispatch.text(context)
    assert.match(textPanorama, /控制室项目清单（实时快照）/)
    assert.match(textPanorama, /以它为准/)
    assert.match(textDispatch, /派活分层/)
    await sleep(250) // 等当次 force 刷新落地再数读取次数
    assert.equal(listCalls, 1, '同一次提示词组装只读一次会话行（快照窗口 + inflight 去重，两边各读一次不许发生）')
    // 逐字同源：B 层「既有项目目录」的每个目录都出现在全景段（B 不带隐藏、带最近会话标题，按目录比对）
    const dirOf = (line) => line.slice(2).split('（')[0].trim()
    const panoramaLines = textPanorama.split('\n').filter((line) => line.startsWith('- '))
    const panoramaDirs = new Set(panoramaLines.map(dirOf))
    const bLines = textDispatch.split('\n').filter((line) => line.startsWith('- '))
    assert.equal(panoramaLines.length, 3, '全景 = 注册表 3 条（隐藏保留）')
    assert.ok(bLines.length === 2, 'B 层候选保持原口径：隐藏卡片不进既有项目目录')
    assert.ok(!bLines.some((line) => line.includes('pan-hidden')), 'B 层不含隐藏卡')
    for (const line of bLines) {
      assert.ok(panoramaDirs.has(dirOf(line)), `B 层目录与全景段同源：${line}`)
    }
    assert.ok(panoramaLines.some((line) => line.includes('pan-hidden') && line.includes('（隐藏）')), '全景段保留隐藏卡并标注')
    // 其它会话一个字都不注入
    assert.equal(panorama.text({ agent: { session: { id: 'someone-else' } } }), '')
    assert.equal(dispatch.text({ agent: { session: { id: 'someone-else' } } }), '')
  } finally {
    dispose()
    lib.assistantSecretaryTestSurface.secretarySessionRef.id = ''
    surface.setDispatchRegistryDir('')
    rmSync(dir, { recursive: true, force: true })
    surface.resetDispatchCacheForTests()
    surface.resetPromptSnapshotForTests()
  }
}])

cases.push(['提示词路径绕过 30s 缓存：控制室新建/删除文件夹 + 新会话目录都当轮收紧', async () => {
  const { rmSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = await makeTempRegistry({ projects: { folders: { a: 'D:\\reg-a' }, removed: [], hidden: [], nameOverrides: {}, layouts: [] } })
  surface.setDispatchRegistryDir(dir)
  surface.resetDispatchCacheForTests()
  surface.resetPromptSnapshotForTests()
  const list = [{ header: { id: 's1', cwd: 'D:\\sess-1', title: 't', updatedAt: 1 } }]
  const ctx = { sessions: { list: () => list } }
  try {
    const first = surface.promptProjectSnapshot(ctx)
    assert.equal(first.length, 2, '注册表 reg-a ∪ 会话 sess-1')
    await sleep(250) // force 刷新落地：30s 缓存此刻是「新鲜」的
    // 控制室变了：注册表加文件夹、删文件夹，同时出现新会话目录——模拟「缓存未过期」
    writeFileSync(join(dir, 'dsh-assistant-state.json'), JSON.stringify({ projects: { folders: { b: 'D:\\reg-b' }, removed: [], hidden: [], nameOverrides: {}, layouts: [] } }))
    list.push({ header: { id: 's2', cwd: 'D:\\sess-2', title: 't2', updatedAt: 2 } })
    surface.resetPromptSnapshotForTests() // 只清快照窗口、不动 30s 缓存：模拟「下一轮组装」
    const second = surface.promptProjectSnapshot(ctx)
    assert.ok(second.some((p) => p.dir === 'D:\\reg-b'), '注册表新建文件夹当轮立即可见（同步重读注册表，不吃 30s 缓存）')
    assert.ok(!second.some((p) => p.dir === 'D:\\reg-a'), '注册表删除文件夹当轮立即消失')
    await sleep(250) // 当次 force 刷新把新会话行写进缓存
    const third = surface.promptProjectSnapshot(ctx)
    assert.ok(third.some((p) => p.dir === 'D:\\sess-2'), '新会话目录经当轮 force 刷新后下一轮可见')
  } finally {
    surface.setDispatchRegistryDir('')
    rmSync(dir, { recursive: true, force: true })
    surface.resetDispatchCacheForTests()
    surface.resetPromptSnapshotForTests()
  }
}])

/* ---------- 派活回执三态口径（2026-11-23 用户定案：只入队不许说成已派活） ---------- */

function execOf() { return { agent: { session: { id: 'sec-1' } } } }

function sessionRow(id, cwd, preset = 'computer-use') {
  return { header: { id, cwd, title: `会话 ${id}`, updatedAt: 1000, agentPreset: preset } }
}

/** 假宿主：会话行 + 事件总线 + 投影模型选择 + llm 清单 + sessionController 调用记录。 */
function fakeDispatchCtx(options) {
  const calls = []
  const handlers = []
  const models = options.models instanceof Map ? options.models : new Map(Object.entries(options.models ?? {}))
  const emit = (session, event) => { for (const fn of handlers.slice()) fn(session, event) }
  const ctx = {
    calls,
    emit,
    sessions: { list: () => options.rows ?? [] },
    get(name) {
      if (name === 'sessionProjections') {
        return {
          cachedSnapshot: (source) => {
            const id = String(source?.header?.id ?? source?.id ?? '')
            const model = models.get(id)
            if (model === undefined) return { values: {} }
            return { values: { modelSelection: { lastUsed: model, next: model } } }
          },
        }
      }
      if (name === 'llm') return options.llm
      return undefined
    },
    sessionController: {
      create: options.create ?? (async (req) => {
        calls.push(['create', req])
        return { sessionId: options.newSessionId ?? 'session-cu-new', agentPreset: 'computer-use' }
      }),
      rename: async (req) => { calls.push(['rename', req]) },
      prompt: async (req) => {
        calls.push(['prompt', req])
        if (typeof options.onPrompt === 'function') await options.onPrompt(req, emit)
      },
    },
    on(name, fn) {
      if (name === 'session/event') handlers.push(fn)
      return () => { const index = handlers.indexOf(fn); if (index >= 0) handlers.splice(index, 1) }
    },
  }
  return ctx
}

/** 宿主事件模拟：这条派活被消费、起了轮、跑出了一步。 */
function hostStartedTurn(turn) {
  return (req, emit) => {
    emit({ id: req.sessionId }, { type: 'agent/inbox/spliced', data: { turn, inserted: [{ source: { kind: 'user', rpcId: req.requestId } }] } })
    emit({ id: req.sessionId }, { type: 'turn/start', data: { turn } })
    emit({ id: req.sessionId }, { type: 'step/start', data: { turn, step: 1 } })
  }
}

/** 宿主事件模拟：起轮后一 0 步就崩（钉着的模型已退役那种），kind 可传 error/aborted/interrupted。 */
function hostFailedTurn(turn, kind, error) {
  return (req, emit) => {
    emit({ id: req.sessionId }, { type: 'agent/inbox/spliced', data: { turn, inserted: [{ source: { kind: 'user', rpcId: req.requestId } }] } })
    emit({ id: req.sessionId }, { type: 'turn/start', data: { turn } })
    emit({ id: req.sessionId }, { type: 'turn/end', data: { turn, reason: { kind, error } } })
  }
}

const RETIRED_MODEL = { provider: 'strata', model: 'qwen3.8-flash-next-iq3_s' }
const UNKNOWN_MODEL_ERROR = {
  message: 'pi-ai provider "strata" has no configured model "qwen3.8-flash-next-iq3_s"',
  code: 'UNKNOWN_MODEL',
}

async function withVerifyMs(value, run) {
  const previous = process.env.DSH_ASSISTANT_DISPATCH_VERIFY_MS
  process.env.DSH_ASSISTANT_DISPATCH_VERIFY_MS = String(value)
  try { return await run() } finally {
    if (previous === undefined) delete process.env.DSH_ASSISTANT_DISPATCH_VERIFY_MS
    else process.env.DSH_ASSISTANT_DISPATCH_VERIFY_MS = previous
  }
}

function freshDispatch() {
  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'sec-1'
  surface.resetDispatchCacheForTests()
  surface.resetModelChecksForTests()
}

cases.push(['回执文案：确认在跑才写「已派活」，只入队写「已入队（未确认在跑）」', () => {
  const confirmed = surface.dispatchReceiptText({ cwd: 'D:\\x', continued: true, decided_by: 'model', reason: 'r', verification: 'confirmed', verified: true, turn: 7 })
  assert.match(confirmed, /^已派活（Computer Use 续接·已确认在跑 第 7 轮）/)
  assert.match(confirmed, /秘书模型判断/)
  const queued = surface.dispatchReceiptText({ cwd: 'D:\\x', continued: true, decided_by: 'rules', reason: 'r', verification: 'unverified', verified: false, pending: true })
  assert.match(queued, /^已入队（未确认在跑，Computer Use 续接·消息还排在待办队列里）/)
  assert.ok(!queued.includes('已派活'), `只入队不许出现「已派活」：${queued}`)
  const unknown = surface.dispatchReceiptText({ cwd: 'D:\\x', continued: false, decided_by: 'rules', reason: 'r', verification: undefined })
  assert.match(unknown, /已入队（未确认在跑，Computer Use 新建·宿主窗口内没给出证据）/, '没有 verification 字段也只许写未确认')
  const redispatched = surface.dispatchReceiptText({ cwd: 'D:\\x', continued: false, decided_by: 'rules', reason: 'r', verification: 'confirmed', verified: true, turn: 1, redispatched: true })
  assert.match(redispatched, /续接失败已改新建/, '自动降级要在回执里如实写出来')
}])

cases.push(['入队失败（宿主 prompt 抛错）：execute 抛错、绝不新建、绝不出「已派活」', async () => {
  freshDispatch()
  const ctx = fakeDispatchCtx({ rows: [sessionRow('session-cu-old', 'D:\\proj-a')], onPrompt: async (req) => { throw new Error('宿主会话已收工，入队被拒') } })
  const tool = surface.dispatchToolDefinition(ctx)
  let error = null
  try {
    await withVerifyMs(0, () => tool.execute({ task: '把报名表填完', cwd: 'D:\\proj-a', kind: 'existing' }, execOf()))
  } catch (error_) { error = error_ }
  assert.ok(error instanceof Error, '入队失败必须抛错，不许静默成「已入队」')
  assert.match(error.message, /派活失败/)
  assert.match(error.message, /入队被拒/, '失败原因要原文带在错里')
  assert.ok(!error.message.includes('已派活'), `不许出「已派活」文案：${error.message}`)
  assert.deepEqual(ctx.calls.map(([kind]) => kind), ['prompt'], '入队失败不许偷偷新建会话')
}])

cases.push(['只入队、窗口内没证据：verification=unverified，文案不是「已派活」', async () => {
  freshDispatch()
  const ctx = fakeDispatchCtx({ rows: [sessionRow('session-cu-old', 'D:\\proj-a')] })
  const tool = surface.dispatchToolDefinition(ctx)
  const out = await withVerifyMs(0, () => tool.execute({ task: '把报名表填完', cwd: 'D:\\proj-a', kind: 'existing' }, execOf()))
  assert.equal(out.continued, true)
  assert.equal(out.verification, 'unverified')
  assert.equal(out.verified, false)
  assert.equal(out.redispatched, false)
  const text = tool.output.render({}, out)[0].text
  assert.match(text, /已入队（未确认在跑/)
  assert.ok(!text.includes('已派活'), `未确认在跑不许出现「已派活」：${text}`)
  assert.deepEqual(ctx.calls.map(([kind]) => kind), ['prompt'], '未确认也不许新建会话')
}])

cases.push(['观测到会话接上话（消费 → 起轮 → 起步）：verification=confirmed 才出「已派活（续接）」', async () => {
  freshDispatch()
  const ctx = fakeDispatchCtx({ rows: [sessionRow('session-cu-old', 'D:\\proj-a')], onPrompt: hostStartedTurn(9) })
  const tool = surface.dispatchToolDefinition(ctx)
  const out = await withVerifyMs(0, () => tool.execute({ task: '把报名表填完', cwd: 'D:\\proj-a', kind: 'existing' }, execOf()))
  assert.equal(out.verification, 'confirmed')
  assert.equal(out.verified, true)
  assert.equal(out.turn, 9)
  assert.equal(out.continued, true)
  const text = tool.output.render({}, out)[0].text
  assert.match(text, /^已派活（Computer Use 续接·已确认在跑 第 9 轮）/, '确认到在跑才许写已派活')
}])

cases.push(['续接的会话这一轮失败（UNKNOWN_MODEL）：自动改新建并如实写「续接失败已改新建」', async () => {
  freshDispatch()
  const ctx = fakeDispatchCtx({
    rows: [sessionRow('session-cu-old', 'D:\\proj-a')],
    models: new Map([['session-cu-old', RETIRED_MODEL]]),
    onPrompt: (req, emit) => {
      if (req.sessionId === 'session-cu-old') return hostFailedTurn(9, 'error', UNKNOWN_MODEL_ERROR)(req, emit)
      return hostStartedTurn(1)(req, emit)
    },
  })
  const tool = surface.dispatchToolDefinition(ctx)
  const out = await withVerifyMs(0, () => tool.execute({ task: '把报名表填完', cwd: 'D:\\proj-a', kind: 'existing' }, execOf()))
  assert.equal(out.continued, false, '降级后的回执走的是新建会话')
  assert.equal(out.redispatched, true)
  assert.equal(out.failed_session_id, 'session-cu-old')
  assert.equal(out.session_id, 'session-cu-new')
  assert.equal(out.verification, 'confirmed')
  assert.match(out.reason, /续接会话 session-cu-old 这一轮失败/)
  assert.match(out.reason, /UNKNOWN_MODEL/, '错误码要写进回执')
  assert.match(out.reason, /已改新建 Computer Use 会话 session-cu-new/)
  assert.match(out.reason, /它钉的模型 strata\/qwen3\.8-flash-next-iq3_s/)
  const text = tool.output.render({}, out)[0].text
  assert.match(text, /续接失败已改新建/, '回执照实写降级')
  assert.ok(ctx.calls.some(([kind]) => kind === 'create'), '降级确实新建了一条会话')
}])

cases.push(['aborted 轮口径：同样算失败、也自动改新建（不许说成已派活）', async () => {
  freshDispatch()
  const ctx = fakeDispatchCtx({
    rows: [sessionRow('session-cu-old', 'D:\\proj-a')],
    onPrompt: (req, emit) => {
      if (req.sessionId === 'session-cu-old') return hostFailedTurn(4, 'aborted', { message: '用户中断了这一轮', code: 'ABORTED' })(req, emit)
      return hostStartedTurn(1)(req, emit)
    },
  })
  const tool = surface.dispatchToolDefinition(ctx)
  const out = await withVerifyMs(0, () => tool.execute({ task: '把报名表填完', cwd: 'D:\\proj-a', kind: 'existing' }, execOf()))
  assert.equal(out.redispatched, true)
  assert.equal(out.verification, 'confirmed')
  assert.match(out.reason, /这一轮失败/)
  assert.match(out.reason, /aborted\/ABORTED/, 'kind 与错误码要写进回执')
  assert.match(out.reason, /用户中断了这一轮/, '错误原文要写进回执')
  assert.ok(!out.reason.includes('已完成'), '失败轮不许说成已完成')
}])

cases.push(['候选会话钉着已退役模型 → 排除它、改新建（回执写清跳过了哪条）', async () => {
  freshDispatch()
  const ctx = fakeDispatchCtx({
    rows: [sessionRow('session-cu-stale', 'D:\\proj-a')],
    models: new Map([['session-cu-stale', RETIRED_MODEL]]),
    llm: { listModels: async (provider) => (provider === 'strata' ? [{ provider: 'strata', id: 'qwen3.8-flash-next-iq3_xxs', name: 'iq3_xxs' }] : []) },
    onPrompt: hostStartedTurn(1),
  })
  const tool = surface.dispatchToolDefinition(ctx)
  const out = await withVerifyMs(0, () => tool.execute({ task: '把报名表填完', cwd: 'D:\\proj-a', kind: 'existing' }, execOf()))
  assert.equal(out.continued, false)
  assert.equal(out.redispatched, false, '没续接过就不该写「续接失败已改新建」')
  assert.match(out.reason, /跳过 1 条钉着已退役模型的 Computer Use 会话/)
  assert.match(out.reason, /session-cu-stale→strata\/qwen3\.8-flash-next-iq3_s/, '要指名是哪条会话钉着哪个模型')
  assert.deepEqual(ctx.calls.map(([kind]) => kind), ['create', 'rename', 'prompt'])
}])

cases.push(['读不到模型清单 → 不排除（不许猜），照旧续接', async () => {
  freshDispatch()
  const ctx = fakeDispatchCtx({
    rows: [sessionRow('session-cu-old', 'D:\\proj-a')],
    models: new Map([['session-cu-old', RETIRED_MODEL]]),
    onPrompt: hostStartedTurn(3),
  })
  const tool = surface.dispatchToolDefinition(ctx)
  const out = await withVerifyMs(0, () => tool.execute({ task: '把报名表填完', cwd: 'D:\\proj-a', kind: 'existing' }, execOf()))
  assert.equal(ctx.get('llm'), undefined, '这条假宿主没给 llm 服务')
  assert.equal(out.continued, true, '读不到模型清单就不许据此排除候选')
  assert.equal(out.redispatched, false)
  assert.ok(!out.reason.includes('跳过'), '没有排除依据时不该写「跳过」')
}])

cases.push(['读不到模型选择 → 也不排除（不猜）', async () => {
  freshDispatch()
  const ctx = fakeDispatchCtx({
    rows: [sessionRow('session-cu-old', 'D:\\proj-a')],
    llm: { listModels: async () => [{ provider: 'strata', id: 'qwen3.8-flash-next-iq3_xxs', name: 'iq3_xxs' }] },
    onPrompt: hostStartedTurn(3),
  })
  const tool = surface.dispatchToolDefinition(ctx)
  const out = await withVerifyMs(0, () => tool.execute({ task: '把报名表填完', cwd: 'D:\\proj-a', kind: 'existing' }, execOf()))
  assert.equal(out.continued, true, '会话行里没有模型信息时不许排除它')
}])

cases.push(['纯观测器：入队抛错=failed(queue-throw)、队列还排着=unverified+pending、起轮 0 步就崩=failed', async () => {
  const requestId = 'rpc-1'
  const handlers = []
  const ctx = {
    get: (name) => (name === 'agents' ? { get: () => ({ inbox: { nextTurn: [{ source: { kind: 'user', rpcId: requestId } }], nextStep: [] } }) } : undefined),
    on: (name, fn) => { if (name === 'session/event') handlers.push(fn); return () => {} },
  }
  const queued = await surface.observeDispatchPrompt({ ctx, sessionId: 's-1', requestId, timeoutMs: 0, prompt: async () => {} })
  assert.equal(queued.verification, 'unverified', '消息还排在待办队列里 = 只入队，未确认在跑')
  assert.equal(queued.pending, true)
  assert.equal(queued.observed_via, 'poll')
  const thrown = await surface.observeDispatchPrompt({ ctx, sessionId: 's-1', requestId, timeoutMs: 0, prompt: async () => { throw Object.assign(new Error('入队被拒'), { code: 'SESSION_CLOSED' }) } })
  assert.equal(thrown.verification, 'failed')
  assert.equal(thrown.failure.kind, 'queue-throw')
  assert.equal(thrown.failure.code, 'SESSION_CLOSED')
  assert.match(thrown.failure.message, /入队被拒/)
  assert.equal(thrown.observed_via, 'queue-throw')
  const busy = []
  const ctx2 = { get: () => undefined, on: (name, fn) => { busy.push(fn); return () => {} } }
  const failed = await surface.observeDispatchPrompt({
    ctx: ctx2,
    sessionId: 's-2',
    requestId: 'rpc-2',
    timeoutMs: 5_000,
    graceMs: 300,
    pollMs: 5,
    prompt: async () => {
      for (const fn of busy) {
        fn({ id: 's-2' }, { type: 'agent/inbox/spliced', data: { turn: 8, inserted: [{ source: { kind: 'user', rpcId: 'rpc-2' } }] } })
        fn({ id: 's-2' }, { type: 'turn/start', data: { turn: 8 } })
        fn({ id: 's-2' }, { type: 'turn/end', data: { turn: 8, reason: { kind: 'error', error: { message: 'no configured model', code: 'UNKNOWN_MODEL' } } } })
      }
    },
  })
  assert.equal(failed.verification, 'failed', '起轮后 0 步就崩（grace 期内就失败）不许算 confirmed')
  assert.equal(failed.failure.code, 'UNKNOWN_MODEL')
  assert.equal(failed.turn, 8)
  assert.equal(failed.observed_via, 'bus')
}])

cases.push(['观测确认走宽限期：起了轮、跑出一 step 才算已派活（grace 内没等到失败）', async () => {
  const handlers = []
  const ctx = { get: () => undefined, on: (name, fn) => { handlers.push(fn); return () => {} } }
  const evidence = await surface.observeDispatchPrompt({
    ctx,
    sessionId: 's-3',
    requestId: 'rpc-3',
    timeoutMs: 4_000,
    graceMs: 60,
    pollMs: 10,
    prompt: async () => {
      for (const fn of handlers) {
        fn({ id: 's-3' }, { type: 'agent/inbox/spliced', data: { turn: 5, inserted: [{ source: { kind: 'user', rpcId: 'rpc-3' } }] } })
        fn({ id: 's-3' }, { type: 'turn/start', data: { turn: 5 } })
      }
      setTimeout(() => { for (const fn of handlers) fn({ id: 's-3' }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } }) }, 120)
    },
  })
  assert.equal(evidence.verification, 'confirmed', '轮收尾（completed）也算接上了话')
  assert.equal(evidence.turn, 5)
}])

cases.push(['宿主既没事件流也没活队列：立刻判未确认，不空等 10 秒', async () => {
  const started = Date.now()
  const evidence = await surface.observeDispatchPrompt({
    ctx: { get: () => undefined },
    sessionId: 's-4',
    requestId: 'rpc-4',
    prompt: async () => {},
  })
  assert.equal(evidence.verification, 'unverified')
  assert.equal(evidence.observed_via, 'none')
  assert.ok(Date.now() - started < 1_000, `没有可观测通道时不该等满窗口：${Date.now() - started}ms`)
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} assistant-dispatch`)
