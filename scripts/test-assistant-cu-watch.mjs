/**
 * 秘书「管理 CU 会话 + 派活分层」单测（不启动 DSH、不碰真实目录）：
 *   node scripts/test-assistant-cu-watch.mjs
 *
 * 覆盖（与需求逐条对应）：
 *   1. CU 模式判定：投影 agentPreset 优先、header 兜底；standard / 空 ≠ CU；
 *   2. 轮次汇报闸：CU 会话的 completed 与失败轮（error / aborted / interrupted / blocked）都汇报；
 *      **标准会话不汇报**、子代理不汇报、秘书自身不汇报、max-tokens 不汇报（归托管自动续写管）；
 *   3. 事件控制器：CU 会话完成 → notify 带该会话 id 与标题；失败轮 → notify 带 outcome=failed 与
 *      错误原文（错误码、message）；标准会话完成 → 不收集也不 notify；同一轮只报一次；
 *   4. 通知正文含 [[session:<id>|<标题>]] 引用标记（渲染成可点跳信息行）；正文要求把 CU 会话
 *      的结果完整、原样转述（2026-11-22 定案：撤掉「一两句口语汇报」的长度限制），
 *      CU 结果带的是整段原文而不是首句；
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

/* ---------- 2. 轮次汇报闸（完成与失败都汇报） ---------- */
cases.push(['汇报闸：CU + completed / error / aborted / interrupted / blocked 都报，标准会话与 max-tokens 不报', () => {
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'completed' }), true)
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'error' }), true, '失败轮必须报（2026-11-23 用户定案：失败不许静默成已派活）')
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'aborted' }), true, 'aborted 轮也得出卡')
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'interrupted' }), true)
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'blocked' }), true)
  assert.equal(watch.shouldReportTurn({ preset: 'standard', reasonKind: 'completed' }), false, '标准会话不汇报')
  assert.equal(watch.shouldReportTurn({ preset: 'standard', reasonKind: 'error' }), false, '标准会话的失败轮也不归秘书汇报')
  assert.equal(watch.shouldReportTurn({ preset: '', reasonKind: 'completed' }), false)
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'max-tokens' }), false, 'max-tokens 归托管自动续写管')
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: '' }), false)
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: undefined }), false)
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'completed', origin: 'subagent' }), false)
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'error', origin: 'subagent' }), false)
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'completed', delegationDepth: 1 }), false)
  assert.equal(watch.shouldReportTurn({ preset: 'computer-use', reasonKind: 'completed', isSecretary: true }), false)
  // 轮次分类
  assert.equal(watch.classifyCuTurn('completed'), 'completed')
  assert.equal(watch.classifyCuTurn('error'), 'failed')
  assert.equal(watch.classifyCuTurn('aborted'), 'failed')
  assert.equal(watch.classifyCuTurn('interrupted'), 'failed')
  assert.equal(watch.classifyCuTurn('blocked'), 'failed')
  assert.equal(watch.classifyCuTurn('max-tokens'), null)
  assert.equal(watch.classifyCuTurn(''), null)
  assert.equal(watch.classifyCuTurn(undefined), null)
  // 失败轮的错误原文（宿主 turn/end 的 reason.error）
  assert.deepEqual(watch.failureOfTurnEnd({ reason: { kind: 'error', error: { message: '  pi-ai provider "strata" has no configured model "qwen3.8-flash-next-iq3_s"  ', code: 'UNKNOWN_MODEL' } } }), {
    kind: 'error',
    message: 'pi-ai provider "strata" has no configured model "qwen3.8-flash-next-iq3_s"',
    code: 'UNKNOWN_MODEL',
  })
  assert.deepEqual(watch.failureOfTurnEnd({ reason: { kind: 'aborted' } }), { kind: 'aborted', message: '', code: '' })
  assert.equal(watch.formatCuFailureLine({ kind: 'error', message: 'boom', code: 'UNKNOWN_MODEL' }), '（原因 error；错误码 UNKNOWN_MODEL；错误原文「boom」）')
  assert.equal(watch.formatCuFailureLine(undefined), '')
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

cases.push(['控制器：CU 失败轮（error + UNKNOWN_MODEL）→ notify 带 outcome=failed 与错误原文，同一轮只报一次', async () => {
  const sent = []
  const logs = []
  const ctl = watch.createCuWatch({
    presetOf: (session) => session.preset,
    titleOf: (session) => session.header.title,
    secretaryId: () => 'sec-1',
    notify: (payload) => { sent.push(payload) },
    log: (line) => { logs.push(line) },
  })
  const cu = { id: 'cu-fail-1', preset: 'computer-use', header: { title: '竞赛管理系统录入成果' } }
  ctl.handleSessionEvent(cu, { type: 'turn/start', data: { turn: 9 } })
  ctl.handleSessionEvent(cu, { type: 'turn/end', data: { turn: 9, reason: { kind: 'error', error: { message: 'pi-ai provider "strata" has no configured model "qwen3.8-flash-next-iq3_s"', code: 'UNKNOWN_MODEL' } } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 1, '失败轮要出汇报')
  assert.equal(sent[0].outcome, 'failed')
  assert.equal(sent[0].failure.kind, 'error')
  assert.equal(sent[0].failure.code, 'UNKNOWN_MODEL')
  assert.match(sent[0].failure.message, /no configured model/)
  assert.equal(sent[0].summary, '', '失败轮通常没有文本结果')
  // 同一失败轮重复 turn/end 只报一次
  ctl.handleSessionEvent(cu, { type: 'turn/end', data: { turn: 9, reason: { kind: 'error' } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 1, '同一轮只报一次')
  // max-tokens 轮不报（归托管自动续写管）
  ctl.handleSessionEvent(cu, { type: 'turn/end', data: { turn: 10, reason: { kind: 'max-tokens' } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 1, 'max-tokens 轮不出卡')
  // aborted 轮出卡（口径：失败，不是完成）
  ctl.handleSessionEvent(cu, { type: 'turn/end', data: { turn: 11, reason: { kind: 'aborted', error: { message: '用户中断这一轮', code: 'ABORTED' } } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 2)
  assert.equal(sent[1].outcome, 'failed')
  assert.equal(sent[1].failure.kind, 'aborted')
  assert.ok(logs.some((line) => /失败轮汇报/.test(line)), '失败轮要留一条日志')
}])

cases.push(['控制器：秘书自身的失败轮不汇报（防止自循环）', async () => {
  const sent = []
  const ctl = watch.createCuWatch({
    presetOf: (session) => session.preset,
    titleOf: (session) => session.header.title,
    secretaryId: () => 'sec-1',
    notify: (payload) => { sent.push(payload) },
  })
  const self = { id: 'sec-1', preset: 'computer-use', header: { title: '秘书自己' } }
  ctl.handleSessionEvent(self, { type: 'turn/end', data: { turn: 4, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN_MODEL' } } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 0)
}])

cases.push(['失败轮通知正文：照实说「这一轮失败了」并带错误码/错误原文，不许说成已完成，卡片两处结构不变', () => {
  const text = watch.buildCompletionNotice({
    sessionId: 'cu-9',
    title: '竞赛管理系统录入成果',
    summary: '',
    outcome: 'failed',
    failure: { kind: 'error', message: 'pi-ai provider "strata" has no configured model "qwen3.8-flash-next-iq3_s"', code: 'UNKNOWN_MODEL' },
  })
  assert.match(text, /这一轮失败了/)
  assert.match(text, /UNKNOWN_MODEL/, '卡片正文要带错误码')
  assert.match(text, /错误原文「pi-ai provider/, '卡片正文要带错误原文')
  assert.match(text, /派活失败/, '要写清这是派活失败')
  assert.match(text, /新建的 Computer Use 会话/, '要提示可以改新建一条会话')
  assert.ok(!text.includes('这一轮已经完成'), '失败轮不许说成已完成')
  assert.ok(text.includes('[[session:cu-9|竞赛管理系统录入成果]]'), '失败轮卡片也要能点开跳转')
  assert.ok(text.includes('这一回合工具已全部禁用，不要尝试派活或查询。'), '工具禁用约束句照留')
  const lines = text.split('\n')
  assert.match(lines[0], /^\s*[（(【\[]?\s*系统通知/, '首行仍是「系统通知」开头（NOTICE_HEAD_LINE_RE）')
  assert.match(lines[lines.length - 1], /^最后单独一行原样输出：\[\[session:[^\]]*\]\]$/, '引用行格式不变（NOTICE_SESSION_REF_LINE_RE）')
  // 不带 outcome 时仍是完成口径（旧文案不动）
  const done = watch.buildCompletionNotice({ sessionId: 'cu-9', title: '门店详情页', summary: '白屏修好了。' })
  assert.match(done, /这一轮已经完成/)
  assert.ok(!done.includes('失败了'), '完成轮不该带失败措辞')
  // 失败轮但宿主事件只给 kind、没给错误原文与错误码：也出卡，且不许编造错误码
  const noDetail = watch.buildCompletionNotice({ sessionId: 'cu-8', title: '录入成果', summary: '', outcome: 'failed', failure: { kind: 'aborted', message: '', code: '' } })
  assert.match(noDetail, /这一轮失败了（原因 aborted）。/)
  assert.ok(!noDetail.includes('错误码 UNKNOWN'), '读不到错误码就不编造')
  assert.match(noDetail, /没有留下文字结果/)
  const naked = watch.buildCompletionNotice({ sessionId: 'cu-7', title: 'T', summary: '', outcome: 'failed', failure: { kind: '', message: '', code: '' } })
  assert.match(naked, /这一轮失败了。/)
  assert.ok(!naked.includes('（原因'), 'kind 读不到就不写原因')
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
cases.push(['通知正文：完整转述口径（撤掉「一两句」长度限制）+ 末尾可点跳引用标记', () => {
  const text = watch.buildCompletionNotice({ sessionId: 'cu-9', title: '门店详情页', summary: '白屏修好了。' })
  assert.match(text, /门店详情页/)
  assert.match(text, /这一轮已经完成/)
  assert.ok(text.includes('[[session:cu-9|门店详情页]]'), '含会话引用标记（卡片渲染成跳转信息行）')
  // 新措辞：要求完整、原样转述，并点名必须保住的信息类别
  assert.match(text, /完整展示/, '要写清「完整展示」')
  assert.match(text, /原样转述/, '要写清「原样转述」')
  assert.match(text, /不许精简/, '要禁止为精简而删')
  assert.match(text, /文件名、路径、命令、数字、版本号、提交号、判据、结论/, '关键信息类别要逐条列出')
  assert.match(text, /被截断（末尾带 …）就照实说明/, '截断要照实说，不许补写')
  // 旧的精简口径必须已经不在正文里
  assert.ok(!text.includes('一两句'), `通知正文里还留着「一两句」限制：${text}`)
  assert.ok(!text.includes('口语向用户汇报'), `旧措辞还在：${text}`)
  // 技术性约束句保留原样（它不是长度限制，是与 tools/pre-execute 硬闸配套的闸）
  assert.ok(text.includes('这一回合工具已全部禁用，不要尝试派活或查询。'), '工具禁用约束句必须原样保留')
  // 卡片解析依赖的两处结构不许变（src/secretary-card-shared.ts 两条正则）
  const lines = text.split('\n')
  assert.match(lines[0], /^\s*[（(【\[]?\s*系统通知/, '首行仍是「系统通知」开头（NOTICE_HEAD_LINE_RE）')
  assert.match(lines[lines.length - 1], /^最后单独一行原样输出：\[\[session:[^\]]*\]\]$/, '引用行格式不变（NOTICE_SESSION_REF_LINE_RE）')
  const bare = watch.buildCompletionNotice({ sessionId: 'cu-1', title: '', summary: '' })
  assert.ok(bare.includes('[[session:cu-1|电脑上的任务]]'))
  assert.match(bare, /没有留下文字结果/)
  // CU 结果带的是整段，不再是首句
  const multiSentence = '第一句完成了。第二句细节。提交 259e27d，文件 src/a.ts。'
  assert.equal(watch.summarizeCompletion(multiSentence), multiSentence, '整段照录，不再只取首句')
  const multiline = watch.summarizeCompletion('结论：\n改了 a.ts\ncommit 259e27d')
  assert.ok(multiline.includes('\n'), '换行保留（卡片按段落解析）')
  const huge = watch.summarizeCompletion('字'.repeat(watch.CU_NOTICE_RESULT_MAX_CHARS + 300))
  assert.equal(huge.length, watch.CU_NOTICE_RESULT_MAX_CHARS + 1, '只有超出上限才截尾')
  assert.ok(huge.endsWith('…'), '截尾要留省略号（通知里要求照实说明）')
  assert.equal(watch.CU_NOTICE_RESULT_MAX_CHARS, 900, '收集与通知同一长度口径（长报告不再被切开）')
}])

/* ---------- 5. 通知投递 ---------- */
cases.push(['投递：只走宿主 agent.followup，不自己写 turn/step 事件', () => {
  const appended = []
  const followups = []
  const session = { id: 'sec-1', append: (...args) => { appended.push(args); throw new Error('插件不该写会话日志') } }
  const agent = { session, followup: (message) => { followups.push(message) } }
  const ok = watch.postSecretaryNotice(agent, { sessionId: 'cu-2', title: '爬虫工程', summary: '抓完了。' })
  assert.equal(ok, true)
  assert.equal(appended.length, 0, 'turn 号由宿主 AgentLoop 分配，插件自己拼会撞号写坏日志')
  assert.equal(followups.length, 1)
  assert.equal(followups[0].role, 'user')
  assert.ok(followups[0].content[0].text.includes('[[session:cu-2|爬虫工程]]'))
  // 没有官方通道 → false，不抛、不写
  assert.equal(watch.postSecretaryNotice(null, { sessionId: 'x', title: '', summary: '' }), false)
  assert.equal(watch.postSecretaryNotice({ session }, { sessionId: 'x', title: '', summary: '' }), false)
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
