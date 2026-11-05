/**
 * 单测：后台 Code agent → Computer Use 会话的 GUI 回传桥（src/cu-bridge-core.mjs）。
 *   node scripts/test-cu-bridge.mjs
 *
 * 固定这几条边界：
 *   - 请求文本带任务与「只做这一步 / 回具体结果 / 不要再交给 code_agent」；
 *   - computer_use 只由后台会话调用；结果取前台会话新产生的 assistant 文字；
 *   - 同一前台会话串行处理（两个后台同时请求不会交错、各拿各的结果）；
 *   - 前台不在 / 没开始 / 超时 / 被取消都有明确、可继续的失败结果；
 *   - 回传次数有上限，防止后台反复来回。
 */
import assert from 'node:assert/strict'
import {
  COMPUTER_USE_TOOL,
  buildHandoffText,
  capText,
  createComputerUseBridgeTool,
  firstAssistantTextAfter,
  isQueued,
  lastAssistantText,
  resetBridgeQueues,
  resolveCallerId
} from '../src/cu-bridge-core.mjs'

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

cases.push(['capText 保留结尾；lastAssistantText 支持只看注入之后的消息', async () => {
  assert.equal(capText('abc'), 'abc')
  assert.ok(capText('x'.repeat(100), 10).startsWith('…'))
  assert.ok(capText('x'.repeat(100), 10).endsWith('x'))
  const agent = makeAgent()
  agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'old' }] })
  agent.messages.push({ role: 'user', content: [{ type: 'text', text: 'notice' }] })
  agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'new' }] })
  assert.equal(lastAssistantText(agent), 'new')
  assert.equal(lastAssistantText(agent, { after: 2 }), 'new')
  assert.equal(lastAssistantText(agent, { after: 3 }), '')
  assert.equal(lastAssistantText({ session: { deriveMessages: () => [] } }), '')
}])

cases.push(['firstAssistantTextAfter：只取 notice 之后的第一条 assistant（用户插话也不串）', async () => {
  const events = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } },
    { type: 'user/message', data: { id: 'notice-1' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'gui answer' }] } } },
    { type: 'user/message', data: { id: 'user-2' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'user answer' }] } } }
  ]
  const agent = { session: { snapshotEvents: () => events } }
  assert.equal(firstAssistantTextAfter(agent, 'notice-1'), 'gui answer')
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
