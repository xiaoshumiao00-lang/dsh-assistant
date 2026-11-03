/**
 * 单测：托管 · 输出截断自动续写（src/tuoguan-autocontinue.ts）。
 *   node scripts/test-tuoguan-autocontinue.mjs
 *
 * 固定这几条边界：
 *   - 判定与界面那条提示同源：`turn/end` 的 reason.kind === 'max-tokens' 才算截断；
 *   - 托管状态：显式关 > 显式开 > 默认值（缺省开）；
 *   - 只在**真没人接手**时补发：会话要空闲、next-turn 收件箱为空、截断还在保鲜期内；
 *   - 同一轮（sessionId + turn）只补一次；同一会话连续 8 次封顶；
 *   - 正常收尾（completed 等）与真人发话都把计数清零，自己补发的那条不算真人；
 *   - 子代理会话不补（父会话已按 max-tokens 收过它的结果）；
 *   - 补出去的就是一条普通用户消息（role=user / source.kind=user / 文本=继续）。
 */
import assert from 'node:assert/strict'
import {
  CONTINUE_TEXT,
  DEFAULT_FRESHNESS_MS,
  DEFAULT_MAX_CONSECUTIVE,
  createAutoContinue,
  createContinueMessage,
  installAutoContinue,
  isSubagentSession,
  tuoguanStateIsOn,
} from '../src/tuoguan-autocontinue.ts'

/** 造一个自带假 Agent、假时钟、假托管状态的控制器。 */
function makeHarness(options = {}) {
  const clock = options.clock ?? { now: 1_000_000 }
  const agents = new Map()
  const sent = []
  const logs = []
  const state = { value: options.state ?? { defaultOn: true } }
  let messageSeq = 0
  const makeAgent = (sessionId, overrides = {}) => {
    const agent = {
      status: 'idle',
      inbox: { nextTurn: [] },
      followup(message) { sent.push({ sessionId, message }) },
      whenIdle: async () => {},
      ...overrides,
    }
    agents.set(sessionId, agent)
    return agent
  }
  const controller = createAutoContinue({
    readState: () => state.value,
    agentOf: (sessionId) => agents.get(sessionId) ?? null,
    createMessage: (text) => {
      messageSeq += 1
      return { id: 'auto-' + messageSeq, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    },
    waitIdle: options.waitIdle ?? (async () => true),
    log: (message) => logs.push(message),
    now: () => clock.now,
    maxConsecutive: options.maxConsecutive ?? 3,
    freshnessMs: options.freshnessMs ?? DEFAULT_FRESHNESS_MS,
  })
  return { clock, agents, sent, logs, state, controller, makeAgent }
}

const turnEnd = (turn, kind) => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const humanMessage = (id) => ({ type: 'user/message', data: { id, source: { kind: 'user' } } })
const sessionOf = (sessionId, header) => ({ id: sessionId, header: header ?? { origin: undefined } })

/** 发一条截断事件并等所有在飞的补发收尾。 */
async function truncate(controller, sessionId, turn, header) {
  controller.handleSessionEvent(sessionOf(sessionId, header), turnEnd(turn, 'max-tokens'))
  await controller.settled()
}

const cases = []

cases.push(['托管状态判定：显式关 > 显式开 > 默认值（缺省开）', () => {
  assert.equal(tuoguanStateIsOn({ defaultOn: true }, 's1'), true, '缺省开')
  assert.equal(tuoguanStateIsOn({ defaultOn: false }, 's1'), false, '默认关')
  assert.equal(tuoguanStateIsOn({ defaultOn: false, on: { s1: true } }, 's1'), true, '显式开能盖过默认关')
  assert.equal(tuoguanStateIsOn({ defaultOn: true, off: { s1: true } }, 's1'), false, '显式关能盖过默认开')
  assert.equal(tuoguanStateIsOn({ on: { s1: true }, off: { s1: true } }, 's1'), false, '两边都有时以关为准')
  assert.equal(tuoguanStateIsOn(undefined, 's1'), true, '没有状态文件 = 老行为（托管中）')
  assert.equal(tuoguanStateIsOn({ defaultOn: true }, ''), false, '空 sessionId 一律不算')
}])

cases.push(['子代理会话判定：header.origin / delegationDepth', () => {
  assert.equal(isSubagentSession({ id: 's1', header: { origin: 'subagent' } }), true)
  assert.equal(isSubagentSession({ id: 's1', header: { delegationDepth: 2 } }), true)
  assert.equal(isSubagentSession({ id: 's1', header: { delegationDepth: 0 } }), false)
  assert.equal(isSubagentSession({ id: 's1', header: {} }), false)
  assert.equal(isSubagentSession({ id: 's1' }), false)
  assert.equal(isSubagentSession(null), false)
}])

cases.push(['补出去的就是一条普通用户消息：role=user / source.kind=user / 文本=继续 / 已冻结', () => {
  const message = createContinueMessage(CONTINUE_TEXT)
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: '继续' }])
  assert.equal(typeof message.id, 'string')
  assert.equal(message.id.length >= 32, true, 'id 要够像 uuid')
  assert.equal(Object.isFrozen(message), true, '收件箱会原样留着，必须冻结')
  assert.equal(Object.isFrozen(message.content[0]), true)
  assert.equal(DEFAULT_MAX_CONSECUTIVE, 8)
  assert.equal(DEFAULT_FRESHNESS_MS, 90_000)
}])

cases.push(['max-tokens + 托管开 + 空闲 → 补一条「继续」', async () => {
  const harness = makeHarness()
  harness.makeAgent('s1')
  await truncate(harness.controller, 's1', 3)
  assert.equal(harness.sent.length, 1)
  assert.equal(harness.sent[0].sessionId, 's1')
  assert.equal(harness.sent[0].message.content[0].text, '继续')
  assert.equal(harness.controller.streakOf('s1'), 1)
  assert.equal(harness.controller.handledTurnOf('s1'), 3)
}])

cases.push(['同一轮（sessionId + turn）只补一次', async () => {
  const harness = makeHarness()
  harness.makeAgent('s1')
  await truncate(harness.controller, 's1', 4)
  await truncate(harness.controller, 's1', 4)
  assert.equal(harness.sent.length, 1, '重复的 turn/end 不许再补')
}])

cases.push(['托管关着 → 不发（显式关 / 默认关都算）', async () => {
  const explicitOff = makeHarness({ state: { defaultOn: true, off: { s1: true } } })
  explicitOff.makeAgent('s1')
  await truncate(explicitOff.controller, 's1', 1)
  assert.equal(explicitOff.sent.length, 0)

  const defaultOff = makeHarness({ state: { defaultOn: false } })
  defaultOff.makeAgent('s1')
  await truncate(defaultOff.controller, 's1', 1)
  assert.equal(defaultOff.sent.length, 0, '默认关时不补')

  defaultOff.state.value = { defaultOn: false, on: { s1: true } }
  await truncate(defaultOff.controller, 's1', 2)
  assert.equal(defaultOff.sent.length, 1, '显式开之后要补')
}])

cases.push(['不是 max-tokens 的 turn/end 不补，而且把计数清零', async () => {
  const harness = makeHarness()
  harness.makeAgent('s1')
  await truncate(harness.controller, 's1', 1)
  assert.equal(harness.controller.streakOf('s1'), 1)
  harness.controller.handleSessionEvent(sessionOf('s1'), turnEnd(2, 'completed'))
  await harness.controller.settled()
  assert.equal(harness.controller.streakOf('s1'), 0, '正常收尾 = 这串截断结束')
  assert.equal(harness.sent.length, 1)
  await truncate(harness.controller, 's1', 3)
  assert.equal(harness.sent.length, 2)
  assert.equal(harness.controller.streakOf('s1'), 1, '新一轮从 1 数起')
}])

cases.push(['连续截断封顶：到上限就停手并留一条日志', async () => {
  const harness = makeHarness({ maxConsecutive: 3 })
  harness.makeAgent('s1')
  for (let turn = 1; turn <= 10; turn += 1) await truncate(harness.controller, 's1', turn)
  assert.equal(harness.sent.length, 3, '上限 3 次')
  assert.equal(harness.controller.streakOf('s1'), 3)
  assert.equal(harness.logs.some((line) => line.includes('已停止自动补发')), true)
}])

cases.push(['真人发话清零；自己补发的那条不清零', async () => {
  const harness = makeHarness({ maxConsecutive: 2 })
  harness.makeAgent('s1')
  await truncate(harness.controller, 's1', 1)
  await truncate(harness.controller, 's1', 2)
  assert.equal(harness.sent.length, 2)
  assert.equal(harness.controller.streakOf('s1'), 2)

  // 自己补发的消息（id 以 auto- 开头，控制器记过）回到日志里时不算真人
  harness.controller.handleSessionEvent(sessionOf('s1'), humanMessage('auto-1'))
  assert.equal(harness.controller.streakOf('s1'), 2, '自己发的继续不许当成人工确认')

  // 真人说话 → 重新给满额度
  harness.controller.handleSessionEvent(sessionOf('s1'), humanMessage('human-1'))
  assert.equal(harness.controller.streakOf('s1'), 0)
  await truncate(harness.controller, 's1', 3)
  assert.equal(harness.sent.length, 3)
}])

cases.push(['子代理会话不补（父会话已经按 max-tokens 收过结果）', async () => {
  const harness = makeHarness()
  harness.makeAgent('child')
  await truncate(harness.controller, 'child', 1, { origin: 'subagent' })
  assert.equal(harness.sent.length, 0)
  await truncate(harness.controller, 'child', 2, { delegationDepth: 1 })
  assert.equal(harness.sent.length, 0)
}])

cases.push(['会话还没空闲（等空闲超时）→ 不补', async () => {
  const harness = makeHarness({ waitIdle: async () => false })
  harness.makeAgent('s1')
  await truncate(harness.controller, 's1', 1)
  assert.equal(harness.sent.length, 0)
}])

cases.push(['收件箱里已经排了活 → 让那条先跑，不插队', async () => {
  const harness = makeHarness()
  harness.makeAgent('s1', { inbox: { nextTurn: [{ id: 'queued' }] } })
  await truncate(harness.controller, 's1', 1)
  assert.equal(harness.sent.length, 0)
}])

cases.push(['等太久（超过保鲜期）→ 不补，避免补到别的任务上', async () => {
  const clock = { now: 1_000_000 }
  const harness = makeHarness({
    clock,
    freshnessMs: 60_000,
    waitIdle: async () => { clock.now += 61_000; return true },
  })
  harness.makeAgent('s1')
  await truncate(harness.controller, 's1', 1)
  assert.equal(harness.sent.length, 0)
}])

cases.push(['会话没有 Agent（已销毁）→ 静默跳过', async () => {
  const harness = makeHarness()
  await truncate(harness.controller, 'missing', 1)
  assert.equal(harness.sent.length, 0)
}])

cases.push(['会话销毁后清掉计数（长跑宿主不攒内存）', async () => {
  const harness = makeHarness()
  harness.makeAgent('s1')
  await truncate(harness.controller, 's1', 1)
  assert.equal(harness.controller.streakOf('s1'), 1)
  harness.controller.handleSessionDisposed(sessionOf('s1'))
  assert.equal(harness.controller.streakOf('s1'), 0)
  assert.equal(harness.controller.handledTurnOf('s1'), undefined)
}])

cases.push(['读托管状态失败 → 按不续写处理，不抛错', async () => {
  const logs = []
  const controller = createAutoContinue({
    readState: () => { throw new Error('状态文件读不了') },
    agentOf: () => ({ status: 'idle', inbox: { nextTurn: [] }, followup() {} }),
    waitIdle: async () => true,
    log: (message) => logs.push(message),
  })
  controller.handleSessionEvent(sessionOf('s1'), turnEnd(1, 'max-tokens'))
  await controller.settled()
  assert.equal(logs.some((line) => line.includes('读不到托管状态')), true)
}])

cases.push(['多会话互不影响：各自计数、各自补发', async () => {
  const harness = makeHarness()
  harness.makeAgent('a')
  harness.makeAgent('b')
  await truncate(harness.controller, 'a', 1)
  await truncate(harness.controller, 'b', 7)
  await truncate(harness.controller, 'a', 2)
  assert.equal(harness.sent.length, 3)
  assert.deepEqual(harness.sent.map((item) => item.sessionId), ['a', 'b', 'a'])
  assert.equal(harness.controller.streakOf('a'), 2)
  assert.equal(harness.controller.streakOf('b'), 1)
}])

/** 造一个只认 `on` / `get('agents')` 的假宿主上下文，事件手动派发。 */
function makeFakeHost() {
  const listeners = new Map()
  const sent = []
  const agent = {
    status: 'idle',
    inbox: { nextTurn: [] },
    whenIdle: async () => {},
    followup(message) { sent.push(message) },
  }
  const ctx = {
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter((item) => item !== listener))
      }
    },
    get(name) {
      if (name === 'agents') return { get: (sessionId) => (sessionId === 's1' ? agent : undefined) }
      return undefined
    },
  }
  const emit = (name, ...args) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    return undefined
  }
  return { ctx, sent, emit, listeners }
}

/** 等安装器内部那条异步补发跑完（它不暴露 settled，靠让出事件循环 + 看结果）。 */
async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

cases.push(['安装器真的挂在 session/event 上：事件进来就补「继续」，卸载后不再补', async () => {
  const host = makeFakeHost()
  const dispose = installAutoContinue(host.ctx, { readState: () => ({ defaultOn: true }), log: () => {} })
  host.emit('session/event', sessionOf('s1'), turnEnd(1, 'max-tokens'))
  assert.equal(await waitFor(() => host.sent.length === 1), true)
  assert.equal(host.sent[0].content[0].text, '继续')
  assert.equal(host.sent[0].role, 'user')
  assert.equal(host.sent[0].source.kind, 'user')

  dispose()
  host.emit('session/event', sessionOf('s1'), turnEnd(2, 'max-tokens'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.sent.length, 1, '卸载后的事件不许再补')
  assert.equal((host.listeners.get('session/event') ?? []).length, 0, '事件监听要被摘干净')
}])

cases.push(['安装器拿不到 agents / 没有事件总线时安静降级，不抛错', async () => {
  const logs = []
  const bare = { on: null, get: () => undefined }
  const dispose = installAutoContinue(bare, { readState: () => ({ defaultOn: true }), log: (line) => logs.push(line) })
  dispose()
  assert.equal(logs.some((line) => line.includes('未启用')), true)

  const host = makeFakeHost()
  const disposeHost = installAutoContinue(host.ctx, { readState: () => ({ defaultOn: false }), log: () => {} })
  host.emit('session/event', sessionOf('s1'), turnEnd(1, 'max-tokens'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.sent.length, 0, '托管关着时安装器也不许发')
  disposeHost()
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (error && error.message ? error.message : error))
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
