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

cases.push(['模型没给目录 → 规则兜底：日常杂活进助手目录', () => {
  const r = surface.resolveDispatchTarget({
    task: '帮我把桌面那张截图裁一下',
    projects,
    assistantHome: ASSISTANT,
    newFolderParent: PARENT,
    now: NOW,
  })
  assert.equal(r.decidedBy, 'rules')
  assert.equal(r.kind, 'assistant')
  assert.equal(r.cwd, ASSISTANT)
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

cases.push(['纯聊天不派活（规则返回 chat，工具层会拒绝）', () => {
  const r = surface.resolveDispatchTarget({ task: '个人秘书是干什么的', projects, assistantHome: ASSISTANT, newFolderParent: PARENT })
  assert.equal(r.kind, 'chat')
  assert.equal(r.cwd, '')
}])

cases.push(['工具定义：名字/schema/渲染齐全', () => {
  const tool = surface.dispatchToolDefinition({})
  assert.equal(tool.name, 'secretary_dispatch')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['task'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['cwd', 'kind', 'task'])
  assert.deepEqual(tool.parameters.properties.kind.enum, ['existing', 'new-folder', 'assistant'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.output.schema.type, 'object')
  const text = tool.output.render({}, { session_id: 's1', cwd: 'D:\\hpg', kind: 'existing', reason: 'r', decided_by: 'model', created_folder: false })[0].text
  assert.match(text, /秘书模型判断/)
  assert.match(text, /D:\\hpg/)
  // 工具描述里必须带三条规则（提示词的一部分）
  assert.match(tool.description, /延续旧任务/)
  assert.match(tool.description, /新建专项文件夹|new-folder/)
  assert.match(tool.description, /个人助手目录/)
}])

cases.push(['提示词段落：三条规则 + 助手目录 + 项目清单', () => {
  const text = surface.dispatchPromptSection({}, projects)
  assert.match(text, /派活目录/)
  assert.match(text, /secretary_dispatch/)
  assert.match(text, /延续旧任务/)
  assert.match(text, /new-folder/)
  assert.match(text, /日常杂活/)
  assert.match(text, /D:\\hpg/)
  assert.match(text, /个人助手目录/)
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
