/**
 * 个人秘书「派活目录由模型决定 + 规则兜底」单测（不启动 DSH、不碰真实目录）：
 *   node scripts/test-assistant-dispatch.mjs
 *
 * 覆盖：
 *   - 模型给了合法绝对路径 → 用模型的目录（decidedBy='model'），不再跑规则；
 *   - 模型没给 / 给了非法路径 → 规则函数兜底（decidedBy='rules'），三条规则仍然生效；
 *   - 工具定义形状（参数/输出 schema 合法，名称固定）；
 *   - 提示词段落只对秘书会话有内容，且把三条规则 + 助手目录 + 项目清单写进去。
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
  const text = tool.output.render({}, { session_id: 's1', cwd: 'D:\\hpg', kind: 'existing', reason: 'r', decided_by: 'model', created_folder: false, continued: true, agent_preset: 'computer-use' })[0].text
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
