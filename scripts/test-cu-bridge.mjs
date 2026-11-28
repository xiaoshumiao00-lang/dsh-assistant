import { archiveRoot as ARCHIVE_ROOT } from './personal-context-lib.mjs'
/**
 * 单测：后台 Code agent → Computer Use 会话的 GUI 回传桥（src/cu-bridge-core.mjs）。
 *   node scripts/test-cu-bridge.mjs
 *
 * 固定这几条边界：
 *   - 请求文本带任务与「只做这一步 / 回具体结果 / 不要再交给 code_agent」；
 *   - computer_use 只由后台会话调用；结果取前台会话新产生的 assistant 文字；
 *   - 同一前台会话串行处理（两个后台同时请求不会交错、各拿各的结果）；
 *   - 前台答复进结果工具的口径（2026-11-23 修第四个 bug）：notice 之后的几整段按顺序拼接、
 *     上限对齐 20000 字（旧 4000 与「只取第一条」都废掉），用户插话那条仍是硬边界；
 *   - 前台不在 / 没开始 / 超时 / 被取消都有明确、可继续的失败结果；
 *   - 回传次数有上限，防止后台反复来回。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPUTER_USE_TOOL,
  buildHandoffText,
  capText,
  createComputerUseBridgeTool,
  digestText,
  firstAssistantTextAfter,
  isQueued,
  lastAssistantText,
  MAX_RESULT_CHARS,
  resetBridgeQueues,
  RESULT_HEAD_KEEP_CHARS,
  RESULT_TAIL_KEEP_CHARS,
  resolveCallerId,
  writeBridgeDump
} from '../src/cu-bridge-core.mjs'
import { createWindowsDesktopBackend, windowSurfaceRect } from '../vendor/computer-use/backend-18yEf5Jq.js'

let seq = 0
const createUserMessage = (input) => ({
  id: `msg-${++seq}`,
  role: 'user',
  content: input.content,
  source: input.source
})
const boundContextSummary = (value) => value
const defineTool = (definition) => definition

function makeAgent(options = {}) {
  const id = options.id ?? 'cu-1'
  const handlers = new Map()
  const messages = []
  const events = []
  const seen = []
  const log = []
  let answerCount = 0
  const inbox = {
    nextTurn: [],
    nextStep: [],
    remove(messageId) {
      const index = inbox.nextTurn.findIndex((message) => message.id === messageId)
      if (index < 0) return false
      inbox.nextTurn.splice(index, 1)
      return true
    }
  }
  const agent = {
    id,
    status: 'idle',
    inbox,
    seen,
    log,
    messages,
    events,
    ctx: {
      on(name, callback) {
        const set = handlers.get(name) ?? new Set()
        set.add(callback)
        handlers.set(name, set)
        return () => set.delete(callback)
      }
    },
    session: { deriveMessages: () => messages, snapshotEvents: () => events },
    followup(message) {
      seen.push(message)
      log.push(`inject:${message.content[0].text.match(/任务：(.*)/)?.[1] ?? ''}`)
      inbox.nextTurn.push(message)
      if (options.autoStart === false) return
      if (agent.status === 'idle') startTurn()
    }
  }
  function emit(name) {
    for (const callback of [...(handlers.get(name) ?? [])]) callback({ agent })
  }
  function startTurn() {
    if (agent.status === 'running' || inbox.nextTurn.length === 0) return
    agent.status = 'running'
    emit('agent/status')
    const message = inbox.nextTurn.shift()
    events.push({ type: 'user/message', data: message })
    if (options.autoFinish === false) return
    setTimeout(() => {
      answerCount += 1
      const task = message.content[0].text.match(/任务：(.*)/)?.[1] ?? ''
      log.push(`answer:${task}`)
      const text = options.answer ? options.answer(task, answerCount) : `handled:${task}`
      const assistant = { role: 'assistant', content: [{ type: 'text', text }] }
      messages.push(assistant)
      events.push({ type: 'assistant/message', data: { message: assistant } })
      agent.status = 'idle'
      emit('agent/status')
      setTimeout(startTurn, 0)
    }, options.finishDelay ?? 1)
  }
  agent.finish = (text) => {
    messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    agent.status = 'idle'
    emit('agent/status')
  }
  return agent
}

function makeCtx(parent, backgroundId = 'bg-1') {
  const registry = { list: () => (parent ? [{ sessionId: backgroundId, callerId: parent.id }] : []) }
  return {
    registry,
    get(name) {
      if (name === 'agents') return { get: (id) => (parent && parent.id === id ? parent : undefined) }
      if (name === 'codeAgentRegistry') return registry
      return undefined
    }
  }
}

function buildTool(parent, background, extra = {}) {
  return createComputerUseBridgeTool({
    defineTool,
    createUserMessage,
    boundContextSummary,
    agent: background,
    ctx: makeCtx(parent),
    parentId: parent?.id,
    timeoutMs: 5000,
    ...extra
  })
}

const cases = []

cases.push(['请求文本带任务、只做一步、回结果、不要再转 code_agent', async () => {
  const text = buildHandoffText('打开微信，截图告诉我窗口标题')
  assert.match(text, /后台 Code agent/)
  assert.match(text, /任务：打开微信，截图告诉我窗口标题/)
  assert.match(text, /不要把这步再交给 code_agent/)
  assert.match(text, /具体结果/)
  assert.match(text, /ask_user_question/)
}])

cases.push(['capText 新口径：保留头 + 保留尾（不再只裁尾），结论与末尾路径都留下；lastAssistantText 支持只看注入之后的消息', async () => {
  assert.equal(MAX_RESULT_CHARS, 20000, '与秘书/CU 通知同一长度口径（旧 4000 已废弃）')
  assert.equal(RESULT_HEAD_KEEP_CHARS, 15000, '保留头 15000 字')
  assert.equal(RESULT_TAIL_KEEP_CHARS, 5000, '保留尾 5000 字')
  assert.equal(RESULT_HEAD_KEEP_CHARS + RESULT_TAIL_KEEP_CHARS, MAX_RESULT_CHARS, '头 + 尾 = 上限')
  assert.equal(capText('abc'), 'abc')
  const long = capText('x'.repeat(12000))
  assert.equal(long.length, 12000, '12000 字的结果不许被截断')
  const headPart = '甲'.repeat(10000)
  const middlePart = '乙'.repeat(10000)
  const tailPath = ARCHIVE_ROOT() + '\\结论.txt'
  const tailPart = `${'丙'.repeat(5000)}${tailPath}`
  const cut = capText(`${headPart}${middlePart}${tailPart}`)
  assert.ok(cut.startsWith(headPart), '头部 15000 字必须原样保留')
  assert.ok(cut.endsWith(tailPath), '尾部路径必须留在尾段（改前只裁尾会把它整段切掉）')
  assert.match(cut, /中间省略 \d+ 字/, '要写明省略了多少字')
  assert.match(cut, /第 15001–\d+ 字/, '要写明省略位置')
  assert.ok(cut.length <= MAX_RESULT_CHARS + 300, `头 + 尾 + 标注贴着上限：${cut.length}`)
  const digest = digestText(`${headPart}${middlePart}${tailPart}`)
  assert.equal(digest.truncated, true)
  assert.equal(digest.originalChars, headPart.length + middlePart.length + tailPart.length)
  assert.equal(cut, digest.text, 'capText 与 digestText 同一口径')
  assert.equal(capText('x'.repeat(MAX_RESULT_CHARS + 500), 200).length <= 200 + 300, true, '自定义上限同样走头 + 尾口径')
  const agent = makeAgent()
  agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'old' }] })
  agent.messages.push({ role: 'user', content: [{ type: 'text', text: 'notice' }] })
  agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'new' }] })
  assert.equal(lastAssistantText(agent), 'new')
  assert.equal(lastAssistantText(agent, { after: 2 }), 'new')
  assert.equal(lastAssistantText(agent, { after: 3 }), '')
  assert.equal(lastAssistantText({ session: { deriveMessages: () => [] } }), '')
}])

cases.push(['回传结果超上限时落盘完整原文：文件真存在、内容完整、工具结果里带绝对路径', async () => {
  resetBridgeQueues()
  const root = mkdtempSync(join(tmpdir(), 'cu-bridge-dump-'))
  try {
    const rows = []
    let n = 0
    while (rows.join('\n').length < 24000) {
      n += 1
      rows.push(`第 ${n} 步：窗口标题「文件传输助手」，数量 ${n}`)
    }
    const finalLine = '末尾：清单已写到 ' + ARCHIVE_ROOT() + '\\微信\\清单.md'
    const answer = `${rows.join('\n')}\n${finalLine}`
    const parent = makeAgent({ answer: () => answer })
    const background = makeAgent({ id: 'bg-1' })
    const tool = buildTool(parent, background, { dumpDir: root })
    const value = await tool.execute({ task: '导出清单' }, { agent: background })
    assert.equal(value.ok, true)
    assert.ok(value.result.includes(answer), 'result 里保留前台整段答复（不在这里裁）')
    const pathMatch = value.result.match(/完整全文已落盘：(.+?)。/)
    assert.ok(pathMatch !== null, `工具结果里要带落盘路径：${value.result.slice(-300)}`)
    const path = pathMatch[1].trim()
    assert.ok(existsSync(path), `落盘文件必须真存在：${path}`)
    assert.match(path, /cu-notice-full-\d{8}-\d{6}\.md$/, '文件名带时间戳')
    assert.ok(path.startsWith(root), '要落在注入的项目目录下')
    const content = readFileSync(path, 'utf8')
    assert.ok(content.includes(answer), '落盘文件必须整段完整（不是被裁的那截）')
    const rendered = tool.output.render({}, value)
    assert.ok(rendered[0].text.includes(path), '模型看到的那段文本里也要有路径')
    assert.ok(rendered[0].text.includes(finalLine), '末尾那一行不许被裁掉')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}])

cases.push(['firstAssistantTextAfter：notice 之后的几整段按顺序拼接（改前只取第一条），用户插话仍是硬边界', async () => {
  const events = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } },
    { type: 'user/message', data: { id: 'notice-1' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'gui answer' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '甲'.repeat(1200) }, { type: 'non-text' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '乙'.repeat(1200) }] } } },
    { type: 'user/message', data: { id: 'user-2' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'user answer' }] } } }
  ]
  const agent = { session: { snapshotEvents: () => events } }
  const answer = firstAssistantTextAfter(agent, 'notice-1')
  assert.equal(answer, `gui answer\n\n${'甲'.repeat(1200)}\n\n${'乙'.repeat(1200)}`, '跨消息的几整段要拼在一起')
  assert.ok(!answer.includes('user answer'), '用户插话之后的答复不算这次请求的结果')
  assert.ok(answer.length > 2400, `改前这里只带第一条（10 字），整段拼接后该有 2400 字以上：${answer.length}`)
  assert.equal(firstAssistantTextAfter(agent, 'missing'), '')
  assert.equal(firstAssistantTextAfter({ session: { snapshotEvents: () => [] } }, 'notice-1'), '')
}])

cases.push(['isQueued 只认自己那条消息', async () => {
  const agent = makeAgent()
  agent.inbox.nextTurn.push({ id: 'a' })
  agent.inbox.nextStep.push({ id: 'b' })
  assert.equal(isQueued(agent, 'a'), true)
  assert.equal(isQueued(agent, 'b'), true)
  assert.equal(isQueued(agent, 'c'), false)
  assert.equal(isQueued(agent, undefined), false)
}])

cases.push(['工具定义：名称 / 必需参数 / 输出结构', async () => {
  const parent = makeAgent()
  const background = makeAgent({ id: 'bg-1' })
  const tool = buildTool(parent, background)
  assert.equal(tool.name, COMPUTER_USE_TOOL)
  assert.equal(tool.parameters.task.required, true)
  assert.equal(tool.output.schema.properties.ok.required, true)
  assert.equal(tool.output.schema.properties.result.required, true)
  assert.equal(tool.isConcurrencySafe({}), false)
}])

cases.push(['execute 把 notice 交给前台并返回它的新结果', async () => {
  resetBridgeQueues()
  const parent = makeAgent({ answer: () => '微信窗口标题是「文件传输助手」' })
  const background = makeAgent({ id: 'bg-1' })
  const tool = buildTool(parent, background)
  const value = await tool.execute({ task: '打开微信看窗口标题' }, { agent: background })
  assert.deepEqual(value, { ok: true, result: '微信窗口标题是「文件传输助手」' })
  assert.equal(parent.seen.length, 1)
  assert.equal(parent.seen[0].source.kind, 'computer-use')
  assert.equal(parent.seen[0].source.form, 'notice')
  assert.match(parent.seen[0].content[0].text, /打开微信看窗口标题/)
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /Computer Use 已完成这一步/)
  assert.match(rendered[0].text, /文件传输助手/)
}])

cases.push(['同一前台串行：两个后台请求不会交错，各拿各的结果', async () => {
  resetBridgeQueues()
  const parent = makeAgent({
    finishDelay: 5,
    answer: (task) => `done:${task}`
  })
  const background = makeAgent({ id: 'bg-1' })
  const tool = buildTool(parent, background)
  const [a, b] = await Promise.all([
    tool.execute({ task: 'A' }, { agent: background }),
    tool.execute({ task: 'B' }, { agent: background })
  ])
  assert.equal(a.result, 'done:A')
  assert.equal(b.result, 'done:B')
  assert.equal(parent.seen.length, 2)
  assert.deepEqual(parent.log, ['inject:A', 'answer:A', 'inject:B', 'answer:B'], '第二条应等第一条结果出来再注入')
}])

cases.push(['找不到前台会话：明确失败并要求继续用现有工具', async () => {
  resetBridgeQueues()
  const background = makeAgent({ id: 'bg-1' })
  const tool = createComputerUseBridgeTool({
    defineTool,
    createUserMessage,
    boundContextSummary,
    agent: background,
    ctx: makeCtx(null),
    parentId: 'cu-missing',
    timeoutMs: 1000
  })
  const value = await tool.execute({ task: '打开微信' }, { agent: background })
  assert.equal(value.ok, false)
  assert.match(value.result, /已不在运行/)
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /不要重复调用/)
}])

cases.push(['registry 里的归属优先于创建时父会话（可换前台）', async () => {
  resetBridgeQueues()
  const oldParent = makeAgent({ id: 'cu-old' })
  const newParent = makeAgent({ id: 'cu-new', answer: () => 'new' })
  const background = makeAgent({ id: 'bg-1' })
  const tool = createComputerUseBridgeTool({
    defineTool,
    createUserMessage,
    boundContextSummary,
    agent: background,
    ctx: {
      get(name) {
        if (name === 'agents') return { get: (id) => (id === 'cu-new' ? newParent : undefined) }
        if (name === 'codeAgentRegistry') return { list: () => [{ sessionId: 'bg-1', callerId: 'cu-new' }] }
        return undefined
      }
    },
    parentId: 'cu-old',
    timeoutMs: 1000
  })
  const value = await tool.execute({ task: '截图' }, { agent: background })
  assert.equal(value.result, 'new')
  assert.equal(oldParent.seen.length, 0)
  assert.equal(newParent.seen.length, 1)
}])

cases.push(['前台一直不开始：移除排队 notice 并失败', async () => {
  resetBridgeQueues()
  const parent = makeAgent({ autoStart: false })
  const background = makeAgent({ id: 'bg-1' })
  const tool = buildTool(parent, background, { startWaitMs: 40 })
  const value = await tool.execute({ task: '截图' }, { agent: background })
  assert.equal(value.ok, false)
  assert.match(value.result, /没有开始处理/)
  assert.equal(parent.inbox.nextTurn.length, 0, '排队中的 notice 应撤回')
}])

cases.push(['排队的 notice 被清空（用户停止前台）：明确失败而不是返回空结果', async () => {
  resetBridgeQueues()
  const parent = makeAgent({ autoStart: false })
  const original = parent.followup
  parent.followup = (message) => {
    original(message)
    parent.inbox.nextTurn.length = 0
  }
  const background = makeAgent({ id: 'bg-1' })
  const tool = buildTool(parent, background, { startWaitMs: 40 })
  const value = await tool.execute({ task: '截图' }, { agent: background })
  assert.equal(value.ok, false)
  assert.match(value.result, /没有收到这条请求/)
}])

cases.push(['前台一直不结束：超时失败，不重复追同一步', async () => {
  resetBridgeQueues()
  const parent = makeAgent({ autoFinish: false })
  const background = makeAgent({ id: 'bg-1' })
  const tool = buildTool(parent, background, { timeoutMs: 40 })
  const value = await tool.execute({ task: '截图' }, { agent: background })
  assert.equal(value.ok, false)
  assert.match(value.result, /超时/)
}])

cases.push(['后台被停止：AbortError 原样抛出', async () => {
  resetBridgeQueues()
  const parent = makeAgent({ autoFinish: false })
  const background = makeAgent({ id: 'bg-1' })
  const tool = buildTool(parent, background, { timeoutMs: 5000 })
  const controller = new AbortController()
  const running = tool.execute({ task: '截图' }, { agent: background, signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(running, (error) => error?.name === 'AbortError')
}])

cases.push(['回传次数有上限', async () => {
  resetBridgeQueues()
  const parent = makeAgent({ answer: () => 'ok' })
  const background = makeAgent({ id: 'bg-1' })
  const tool = buildTool(parent, background, { maxHandoffs: 1 })
  const first = await tool.execute({ task: 'A' }, { agent: background })
  const second = await tool.execute({ task: 'B' }, { agent: background })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.match(second.result, /已经连续请求 GUI/)
  assert.equal(parent.seen.length, 1)
}])

cases.push(['resolveCallerId：registry 缺行时退回创建时的父会话', async () => {
  assert.equal(resolveCallerId({ get: () => ({ list: () => [] }) }, 'bg-1', 'cu-1'), 'cu-1')
  assert.equal(
    resolveCallerId({ get: () => ({ list: () => [{ sessionId: 'bg-1', callerId: 'cu-2' }] }) }, 'bg-1', 'cu-1'),
    'cu-2'
  )
  assert.equal(resolveCallerId({ get: () => undefined }, 'bg-1', 'cu-1'), 'cu-1')
}])

/** 记录型宿主：只记抓屏矩形、指针落点和前台判定，不碰真机。 */
function recordingHost(snapshot) {
  const log = []
  let cursor = { x: 0, y: 0 }
  return {
    log,
    listWindows: () => snapshot,
    foregroundWindowId: () => snapshot.foregroundHwnd,
    focusWindow: (hwnd) => {
      log.push({ kind: 'focusWindow', hwnd })
      return false
    },
    targetBlocksInput: () => false,
    capturePng: (bounds) => {
      log.push({ kind: 'capturePng', bounds })
      return Buffer.from([137, 80, 78, 71])
    },
    movePointer: (x, y) => {
      cursor = { x, y }
      log.push({ kind: 'movePointer', x, y })
    },
    mouseButton: (button, down, point) => {
      log.push({ kind: 'mouseButton', button, down, point })
    },
    cursorPosition: () => ({ ...cursor }),
    key: (virtualKey, down) => {
      log.push({ kind: 'key', virtualKey, down })
    },
    scrollWheel: () => {},
    virtualScreen: () => ({ x: 0, y: 0, width: 1920, height: 1080 })
  }
}

function wechatWindow(options = {}) {
  return {
    hwnd: 4000412,
    pid: 28788,
    ownerHwnd: 0,
    className: 'Qt51514QWindowIcon',
    appName: 'WeChat',
    title: '微信',
    visible: true,
    iconic: false,
    cloaked: false,
    toolWindow: false,
    popup: false,
    topmost: false,
    noActivate: false,
    clickThrough: false,
    frame: { x: 428, y: 146, width: 710, height: 756 },
    monitor: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    monitorDpi: 96,
    ...options
  }
}

cases.push(['回传那一步的点击必须落在前台会话看到的那块截图上（同一个 rect）', async () => {
  const target = wechatWindow()
  const host = recordingHost({ foregroundHwnd: target.hwnd, windows: [target] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  const grabbed = host.log.filter((entry) => entry.kind === 'capturePng')
  assert.deepEqual(grabbed[0].bounds, screens[0].bounds, '抓屏矩形必须等于观察面 bounds')
  assert.deepEqual(screens[0].bounds, windowSurfaceRect(target), '观察面 bounds 必须等于 frame ∩ workArea')
  const clicked = await backend.click({ screen: screens[0], position: [450, 19], button: 'left', count: 1 })
  const moved = host.log.filter((entry) => entry.kind === 'movePointer')
  assert.equal(moved.length, 1, '一次点击只摆一次指针')
  assert.deepEqual({ x: moved[0].x, y: moved[0].y }, { x: 748, y: 160 }, '428+0.45*710=747.5 四舍五入 748, 146+0.019*756=160')
  assert.deepEqual(clicked.landed, { x: 748, y: 160 }, '落点要能从结果里读出来')
  const buttons = host.log.filter((entry) => entry.kind === 'mouseButton')
  assert.deepEqual(buttons[0].point, buttons[1].point, 'down 与 up 必须同一个坐标')
  assert.deepEqual(host.log.map((entry) => entry.kind).filter((kind) => kind === 'movePointer' || kind === 'mouseButton'), ['movePointer', 'mouseButton', 'mouseButton'])
}])

cases.push(['前台会话本来就在前台时，回传这一步不该去抢焦点', async () => {
  const target = wechatWindow()
  const host = recordingHost({ foregroundHwnd: target.hwnd, windows: [target] })
  const backend = createWindowsDesktopBackend(host, {})
  const screens = await backend.listScreens()
  await backend.capture(screens[0])
  await backend.click({ screen: screens[0], position: [500, 500], button: 'left', count: 1 })
  await backend.hotkey({ keys: ['ctrl', 'alt', 'w'] })
  assert.deepEqual(host.log.filter((entry) => entry.kind === 'focusWindow'), [], '前台已经是目标窗口，不许 SetForegroundWindow')
}])

for (const [name, run] of cases) {
  try {
    await run()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    process.stdout.write(`FAIL ${name}\n`)
    throw error
  }
}
process.stdout.write(`\n${cases.length} cases passed\n`)
