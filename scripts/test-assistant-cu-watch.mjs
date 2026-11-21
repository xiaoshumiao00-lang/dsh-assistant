/**
 * 秘书「管理 CU 会话 + 派活分层」单测（不启动 DSH、不碰真实目录）：
 *   node scripts/test-assistant-cu-watch.mjs
 *
 * 覆盖（与需求逐条对应）：
 *   1. CU 模式判定：投影 agentPreset 优先、header 兜底；standard / 空 ≠ CU；
 *   2. 完成汇报闸：只有 CU + completed 才报；**标准会话不汇报**、子代理不汇报、
 *      秘书自身不汇报、max-tokens/aborted/error 不汇报；
 *   3. 事件控制器：CU 会话完成 → notify 带该会话 id 与标题；标准会话完成 → 不收集也不 notify；
 *      同一轮只报一次；
 *   4. 通知正文含 [[session:<id>|<标题>]] 引用标记（渲染成可点跳信息行），口语简洁；
 *   5. 合成完成轮：turn 号接在现有最大 turn 后，五个事件按序落盘；
 *   6. 派活分层：A 纯知识随口问直接回答；B 有 CU 会话续接最近的、
 *      无 CU 会话新建；C 新项目建文件夹；标准会话不作为续接候选；
 *   7. 项目卡片数据源合并：注册表条目给显示名、removed/hidden 排除、会话归并补集。
 */
import assert from 'node:assert/strict'

const lib = await import('../lib/index.js')
const watch = lib.assistantCuWatchTestSurface
const dispatch = lib.assistantDispatchTestSurface

const cases = []

/* ---------- 1. CU 判定 ---------- */
cases.push(['CU 判定：投影优先、header 兜底、空按标准', () => {
  assert.equal(watch.presetOfSource('computer-use', 'standard'), 'computer-use')
  assert.equal(watch.presetOfSource('', 'computer-use'), 'computer-use')
  assert.equal(watch.presetOfSource('standard', 'computer-use'), 'standard', '投影说标准就是标准（模式被切走）')
  assert.equal(watch.presetOfSource('', ''), '')
  assert.equal(watch.presetOfSource(undefined, undefined), '')
}])

/* ---------- 2. 完成汇报闸 ---------- */
cases.push(['汇报闸：CU + completed 才报，标准会话一律不汇报', () => {
  assert.equal(watch.shouldReportCompletion({ preset: 'computer-use', reasonKind: 'completed' }), true)
  assert.equal(watch.shouldReportCompletion({ preset: 'standard', reasonKind: 'completed' }), false, '标准会话不汇报')
  assert.equal(watch.shouldReportCompletion({ preset: '', reasonKind: 'completed' }), false)
  assert.equal(watch.shouldReportCompletion({ preset: 'computer-use', reasonKind: 'max-tokens' }), false)
  assert.equal(watch.shouldReportCompletion({ preset: 'computer-use', reasonKind: 'aborted' }), false)
  assert.equal(watch.shouldReportCompletion({ preset: 'computer-use', reasonKind: 'error' }), false)
  assert.equal(watch.shouldReportCompletion({ preset: 'computer-use', reasonKind: 'completed', origin: 'subagent' }), false)
  assert.equal(watch.shouldReportCompletion({ preset: 'computer-use', reasonKind: 'completed', delegationDepth: 1 }), false)
  assert.equal(watch.shouldReportCompletion({ preset: 'computer-use', reasonKind: 'completed', isSecretary: true }), false)
}])

/* ---------- 3. 事件控制器 ---------- */
cases.push(['控制器：CU 完成触发 notify（带会话 id 与标题），同一轮只报一次', async () => {
  const sent = []
  const ctl = watch.createCuWatch({
    presetOf: (session) => session.preset,
    titleOf: (session) => session.header.title,
    secretaryId: () => 'sec-1',
    notify: (payload) => { sent.push(payload) },
  })
  const cu = { id: 'cu-1', preset: 'computer-use', header: { title: '武汉出差攻略' } }
  ctl.handleSessionEvent(cu, { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '攻略已经写好，放在 notes 里。细节略。' }] } } })
  assert.equal(ctl.collectedOf('cu-1', 3), 1)
  ctl.handleSessionEvent(cu, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, 'cu-1')
  assert.equal(sent[0].title, '武汉出差攻略')
  assert.match(sent[0].summary, /攻略已经写好/)
  // 同一轮重复 turn/end 不再报
  ctl.handleSessionEvent(cu, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 1)
  assert.equal(ctl.reportedOf('cu-1', 3), true)
}])

cases.push(['控制器：标准会话完成 → 不收集、不汇报；子代理不汇报', async () => {
  const sent = []
  const ctl = watch.createCuWatch({
    presetOf: (session) => session.preset,
    titleOf: (session) => session.header.title,
    secretaryId: () => 'sec-1',
    notify: (payload) => { sent.push(payload) },
  })
  const std = { id: 'std-1', preset: 'standard', header: { title: 'CU 后台派出的标准会话' } }
  ctl.handleSessionEvent(std, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '标准会话也跑完了' }] } } })
  assert.equal(ctl.collectedOf('std-1', 1), 0, '标准会话文本都不收集')
  ctl.handleSessionEvent(std, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const sub = { id: 'cu-sub', preset: 'computer-use', header: { title: '子代理', origin: 'subagent' } }
  ctl.handleSessionEvent(sub, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '子代理完成' }] } } })
  ctl.handleSessionEvent(sub, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  const self = { id: 'sec-1', preset: 'computer-use', header: { title: '秘书自己' } }
  ctl.handleSessionEvent(self, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 0, '标准会话 / 子代理 / 秘书自身都不汇报')
}])

/* ---------- 4. 通知正文 ---------- */
cases.push(['通知正文：口语 + 末尾可点跳引用标记 [[session:id|title]]', () => {
  const text = watch.buildCompletionNotice({ sessionId: 'cu-9', title: '门店详情页', summary: '白屏修好了。' })
  assert.match(text, /门店详情页/)
  assert.match(text, /跑完了/)
  assert.ok(text.includes('[[session:cu-9|门店详情页]]'), '含会话引用标记（卡片渲染成跳转信息行）')
  const bare = watch.buildCompletionNotice({ sessionId: 'cu-1', title: '', summary: '' })
  assert.ok(bare.includes('[[session:cu-1|电脑上的任务]]'))
  assert.equal(watch.summarizeCompletion('第一句完成了。第二句细节。'), '第一句完成了。')
}])

/* ---------- 5. 合成完成轮 ---------- */
cases.push(['合成轮：turn 接在最大 turn 后，五事件按序落盘', () => {
  const appended = []
  const session = {
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 4 } },
      { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
    ],
    append: (type, data) => { appended.push([type, data]) },
  }
  const ok = watch.postSecretaryNotice(session, { sessionId: 'cu-2', title: '爬虫工程', summary: '抓完了。' })
  assert.equal(ok, true)
  assert.deepEqual(appended.map(([type]) => type), ['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  assert.equal(appended[0][1].turn, 5, 'turn = 现有最大 4 + 1')
  const message = appended[2][1].message
  assert.equal(message.role, 'assistant')
  assert.deepEqual(appended[2][1].stream, [], '宿主 assistant/message 事件必须带 stream，即使合成通知没有流式分片')
  assert.ok(message.content[0].text.includes('[[session:cu-2|爬虫工程]]'))
  assert.equal(appended[4][1].reason.kind, 'completed')
  // 会话不可用 → false 不抛
  assert.equal(watch.postSecretaryNotice(null, { sessionId: 'x', title: '', summary: '' }), false)
  assert.equal(watch.nextTurnOf([]), 1)
}])

/* ---------- 6. 派活分层 A/B/C ---------- */
const ROWS = [
  { sessionId: 'cu-old', cwd: 'D:\\hpg', agentPreset: 'computer-use', title: '旧 CU 会话', updatedAt: 100 },
  { sessionId: 'cu-new', cwd: 'D:\\hpg', agentPreset: 'computer-use', title: '最近 CU 会话', updatedAt: 300 },
  { sessionId: 'std-1', cwd: 'D:\\hpg', agentPreset: 'standard', title: '标准会话', updatedAt: 500 },
  { sessionId: 'cu-sub', cwd: 'D:\\hpg', agentPreset: 'computer-use', origin: 'subagent', updatedAt: 400 },
  { sessionId: 'sec-1', cwd: 'D:\\hpg', agentPreset: 'computer-use', title: '秘书自己', updatedAt: 600 },
]

cases.push(['分层 B：续接该项目最近的 CU 会话（标准会话/子代理/秘书自身都不算）', () => {
  const hit = dispatch.pickCuSessionToContinue(ROWS, 'D:\\hpg', 'sec-1')
  assert.ok(hit !== null)
  assert.equal(hit.sessionId, 'cu-new', '跳过 updatedAt 更大的标准会话与秘书自身、以及子代理')
  assert.equal(dispatch.pickCuSessionToContinue(ROWS, 'D:\\empty', 'sec-1'), null, '没有 CU 会话的项目 → null（新建）')
  assert.equal(dispatch.pickCuSessionToContinue([{ sessionId: 'std-1', cwd: 'D:\\x', agentPreset: 'standard', updatedAt: 1 }], 'D:\\x'), null, '标准会话不作续接候选')
}])

cases.push(['分层 A：只有纯知识随口问直接回答，不建会话', async () => {
  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'sec-1'
  const tool = dispatch.dispatchToolDefinition({
    sessionController: {
      create: async () => { throw new Error('分层 A 绝不该建会话') },
      prompt: async () => { throw new Error('分层 A 绝不该投 prompt') },
    },
  })
  await assert.rejects(
    () => tool.execute({ task: '今天几号' }, { agent: { session: { id: 'sec-1' } } }),
    /纯知识.*直接.*回答|只有纯知识/,
  )
}])

cases.push(['分层 B（无 CU 可续）/ C：新建 computer-use 会话并核对回执预设', async () => {
  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'sec-1'
  const calls = []
  const tool = dispatch.dispatchToolDefinition({
    get: () => undefined,
    sessionController: {
      create: async (req) => { calls.push(['create', req]); return { sessionId: 'cu-created', agentPreset: 'computer-use' } },
      rename: async () => {},
      prompt: async (req) => { calls.push(['prompt', req]) },
    },
  })
  // cwd 指向一个没有任何 CU 会话的项目 → 新建 CU
  const out = await tool.execute(
    { task: '把 D:\\fresh-proj 这个工程重构成插件化，先拆分再合并', cwd: 'D:\\fresh-proj', kind: 'existing' },
    { agent: { session: { id: 'sec-1' } } },
  )
  assert.equal(out.session_id, 'cu-created')
  assert.equal(out.continued, false)
  assert.equal(out.agent_preset, 'computer-use')
  const create = calls.find(([kind]) => kind === 'create')
  assert.deepEqual(create[1], { cwd: 'D:\\fresh-proj', agentPreset: 'computer-use' }, '新建必须带 computer-use 预设')
  // 回执落成 standard → 拒绝派活
  const bad = dispatch.dispatchToolDefinition({
    sessionController: {
      create: async () => ({ sessionId: 'x', agentPreset: 'standard' }),
      rename: async () => {},
      prompt: async () => { throw new Error('模式不符绝不该投 prompt') },
    },
  })
  await assert.rejects(
    () => bad.execute({ task: '重构 D:\\fresh-proj 工程，先拆再合', cwd: 'D:\\fresh-proj', kind: 'existing' }, { agent: { session: { id: 'sec-1' } } }),
    /computer-use/,
  )
}])

/* ---------- 7. 项目卡片数据源合并 ---------- */
cases.push(['项目卡数据源：注册表给显示名、removed/hidden 排除、会话归并补集', () => {
  const registry = dispatch.parseConsoleProjects({
    projects: {
      folders: { p1: 'D:\\hpg', p2: 'D:\\gone', p3: 'D:\\hidden', p4: 'D:\\registered-only' },
      nameOverrides: { p1: 'hpg 轰趴馆' },
      layouts: [{ id: 'p4', title: '只在注册表的项目' }],
      removed: ['p2'],
      hidden: ['p3'],
    },
  })
  assert.equal(registry.length, 2, 'removed/hidden 不算候选')
  const merged = dispatch.mergeConsoleProjects(registry, [
    { dir: 'D:\\hpg', name: 'hpg', titles: ['旧会话'], lastUsedAt: 5 },
    { dir: 'D:\\other', name: 'other', titles: [], lastUsedAt: 3 },
  ])
  const hpg = merged.find((p) => p.dir === 'D:\\hpg')
  assert.equal(hpg.name, 'hpg 轰趴馆', '注册表显示名覆盖目录名')
  assert.deepEqual(hpg.titles, ['旧会话'], '会话归并的标题保留')
  assert.ok(merged.some((p) => p.dir === 'D:\\registered-only'), '只在注册表的项目也进候选')
  assert.ok(merged.some((p) => p.dir === 'D:\\other'), '会话归并的目录保留')
  assert.equal(dispatch.parseConsoleProjects(null).length, 0)
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
console.log(`PASS ${cases.length}/${cases.length} assistant-cu-watch`)
