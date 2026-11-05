/**
 * 单测：turn-guard（src/turn-guard.ts）——防空转补步的判定、纠正文案、历史闸与状态规整。
 *   node scripts/test-turn-guard.mjs
 *
 * 固定这几条边界：
 *   - 正文里「引用」调用格式（行内代码 / 围栏代码块）不算泄漏；
 *   - 整行以调用标记开头才算把调用写成正文；
 *   - 有结构化 tool-call 时不干预；正常正文收尾不干预；
 *   - 只有 reasoning、正文为空时补一步（steerEmptyText 可关掉）；
 *   - 同一轮补到 maxPerTurn 就停手（不无限补）；
 *   - 纠正消息带 id 且以 [turn-guard] 开头；历史闸给缺 id 的消息补 uuid、丢掉没有 content 的；
 *   - 状态规整：缺字段用默认值（默认开启）、越界收敛、坏 JSON 不改语义。
 */
import assert from 'node:assert/strict'
import {
  MARK,
  buildUserMessage,
  correctiveText,
  defaultState,
  guardMessagesForHistory,
  installTurnGuard,
  judge,
  lastToolError,
  looksLikeCall,
  normalizeState,
} from '../src/turn-guard.ts'

/* ---------- 判定：泄漏 vs 正常引用 ---------- */

assert.equal(looksLikeCall('<tool_call>\n</function>\n</tool_call>'), true, '整行调用标记算泄漏')
assert.equal(looksLikeCall('<parameter=screen_index>5'), true, '参数行也算泄漏')
assert.equal(looksLikeCall('你可以这样写：`<tool_call>` 开头'), false, '行内代码里的标记不算')
assert.equal(looksLikeCall('```\n<tool_call>\n```'), false, '围栏代码块里的标记不算')
assert.equal(looksLikeCall('任务完成，结果已写进 output.docx'), false, '正常正文不算')
assert.equal(looksLikeCall(''), false, '空文本不算')

/* ---------- 造会话 ---------- */

function sessionOf(events) {
  return { snapshotEvents: () => events }
}

const assistantEvent = (blocks) => ({ type: 'assistant/message', data: { message: { content: blocks } } })
const textBlock = (text) => ({ type: 'text', text })
const toolCallBlock = () => ({ type: 'tool-call', name: 'click', arguments: {} })
const reasoningBlock = (text) => ({ type: 'reasoning', text })

const emptySession = sessionOf([])
assert.equal(judge(emptySession).steer, false, '没有 assistant 消息就不干预')

const normalSession = sessionOf([assistantEvent([textBlock('都做完了，结论是 A。')])])
assert.equal(judge(normalSession).steer, false, '正常收尾不干预')

const toolCallSession = sessionOf([assistantEvent([textBlock('继续点击'), toolCallBlock()])])
assert.equal(judge(toolCallSession).steer, false, '有结构化 tool-call 不干预')

const leakSession = sessionOf([assistantEvent([textBlock('<tool_call>\n</function>\n</tool_call>')])])
const leakVerdict = judge(leakSession)
assert.equal(leakVerdict.steer, true)
assert.equal(leakVerdict.reason, 'leak')

const emptyTextSession = sessionOf([assistantEvent([reasoningBlock('我想想下一步'), textBlock('')])])
const emptyVerdict = judge(emptyTextSession)
assert.equal(emptyVerdict.steer, true)
assert.equal(emptyVerdict.reason, 'empty')
assert.equal(judge(emptyTextSession, { steerEmptyText: false }).steer, false, '关掉空思考补步就不干预')

/* 同一轮补满 maxPerTurn 后停手 */
const already = (count) => Array.from({ length: count }, (_, index) => ({
  type: 'user/message',
  data: { id: `u-${index}`, content: [{ type: 'text', text: `${MARK} 补一步` }] },
}))
const maxedSession = sessionOf([...already(3), assistantEvent([textBlock('<tool_call>')])])
assert.equal(judge(maxedSession).steer, false, '补满 3 次就停手')
const onceSession = sessionOf([...already(1), assistantEvent([textBlock('<tool_call>')])])
assert.equal(judge(onceSession).steer, true, '还没补满就继续补')

/* ---------- 纠正文案与错误提取 ---------- */

const leakText = correctiveText('leak')
assert.ok(leakText.startsWith(MARK), '纠正消息以 [turn-guard] 开头')
assert.ok(leakText.includes('工具调用'), '文案说明要把调用重新发出来')

const emptyText = correctiveText('empty', 'INVALID_ARGS missing required property "screen_index"')
assert.ok(emptyText.startsWith(MARK))
assert.ok(emptyText.includes('INVALID_ARGS'), '把上一步工具错误带进纠正消息')

const errorSession = sessionOf([{
  type: 'tool/result',
  data: { error: { code: 'INVALID_ARGS' }, message: { content: [textBlock('Error: missing required property "position"')] } },
}])
assert.ok(lastToolError(errorSession).includes('INVALID_ARGS'), '能取到最后一条工具错误')
assert.equal(lastToolError(emptySession), '', '没有工具错误时返回空串')

/* ---------- 消息构造与历史闸 ---------- */

const message = buildUserMessage('继续', { kind: 'user', form: 'turn-guard' })
assert.equal(typeof message.id, 'string')
assert.ok(message.id.length > 0, '纠正消息自带 id')
assert.equal(message.role, 'user')
assert.deepEqual(message.content, [{ type: 'text', text: '继续' }])

const stamped = guardMessagesForHistory([
  { role: 'user', content: [{ type: 'text', text: '没有 id' }], source: { kind: 'user' } },
  { role: 'user', content: [{ type: 'text', text: '有 id' }], source: { kind: 'user' }, id: 'keep-me' },
])
assert.equal(stamped.length, 2)
assert.equal(stamped[1].id, 'keep-me', '已有 id 原样保留')
assert.ok(typeof stamped[0].id === 'string' && stamped[0].id.length > 0, '缺 id 就地补上')

const dropped = guardMessagesForHistory([{ role: 'user', content: 'not-an-array' }])
assert.equal(dropped.length, 0, '缺 id 且 content 不是数组的消息宁可丢掉也不写坏日志')

/* ---------- 状态规整 ---------- */

const defaults = normalizeState(undefined)
assert.equal(defaults.enabled, true, '缺省开启（并入前就是一直开着）')
assert.deepEqual(defaults.presets, ['*'], '默认所有预设生效')
assert.equal(defaults.maxPerTurn, 3)
assert.equal(defaults.steerEmptyText, true)
assert.deepEqual(defaultState(), defaults)

const custom = normalizeState({ enabled: false, presets: ['computer-use', 'standard'], maxPerTurn: 99, steerEmptyText: false, revision: 7 })
assert.equal(custom.enabled, false)
assert.deepEqual(custom.presets, ['computer-use', 'standard'])
assert.equal(custom.maxPerTurn, 20, 'maxPerTurn 收敛到 20')
assert.equal(custom.steerEmptyText, false)
assert.equal(custom.revision, 7)

const junk = normalizeState({ enabled: 'yes', presets: [], maxPerTurn: -5, revision: 'x' })
assert.equal(junk.enabled, true, '非布尔 enabled 退回默认')
assert.deepEqual(junk.presets, ['*'], '空预设退回默认')
assert.equal(junk.maxPerTurn, 0, '负数收敛到 0')
assert.equal(junk.revision, 0)

/* ---------- 挂载：turn-stopping 真的补一步；关了就一步都不补 ---------- */

function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(event, callback) {
      handlers.set(event, callback)
      return () => { handlers.delete(event) }
    },
  }
}

const stateOf = (over = {}) => ({ enabled: true, presets: ['*'], maxPerTurn: 3, steerEmptyText: true, revision: 0, updatedAt: '', ...over })

function mountedGuard(initialState) {
  const ctx = fakeCtx()
  const sent = []
  const logs = []
  let state = stateOf(initialState)
  const dispose = installTurnGuard(ctx, { readState: () => state, log: (line) => logs.push(line) })
  const turnStopping = (session, turn = 1) => {
    ctx.handlers.get('agent/turn-stopping')({
      turn,
      agent: {
        session,
        send(message, kind, internal) { sent.push({ message, kind, internal }) },
      },
    })
  }
  return { ctx, sent, logs, dispose, turnStopping, setState: (next) => { state = next } }
}

const leaky = mountedGuard()
leaky.turnStopping(sessionOf([assistantEvent([textBlock('<tool_call>\n</function>\n</tool_call>')])]))
assert.equal(leaky.sent.length, 1, '泄漏文本会补一步')
assert.equal(leaky.sent[0].kind, 'next-step', '补步走 next-step，循环不 break')
assert.ok(leaky.sent[0].message.id.length > 0, '补进去的消息带 id（不然会话会被写坏）')
assert.ok(leaky.sent[0].message.content[0].text.startsWith(MARK))

leaky.setState(stateOf({ enabled: false }))
leaky.turnStopping(sessionOf([assistantEvent([textBlock('<tool_call>')])]))
assert.equal(leaky.sent.length, 1, '开关关闭后不再补步')

leaky.setState(stateOf())
leaky.turnStopping(sessionOf([assistantEvent([textBlock('都做完了。')])]))
assert.equal(leaky.sent.length, 1, '正常收尾不补步')

const presetGuarded = mountedGuard({ presets: ['computer-use'] })
const standardSession = { ...sessionOf([assistantEvent([textBlock('<tool_call>')])]), header: { agentPreset: 'standard' } }
presetGuarded.turnStopping(standardSession)
assert.equal(presetGuarded.sent.length, 0, '不在 presets 名单里的预设不干预')

const cuSession = { ...sessionOf([assistantEvent([textBlock('<tool_call>')])]), header: { agentPreset: 'computer-use' } }
presetGuarded.turnStopping(cuSession)
assert.equal(presetGuarded.sent.length, 1, '名单内的预设照常补步')

/* 关掉后历史闸也停手（不偷偷改消息） */
const historyGuard = mountedGuard({ enabled: true })
const preStep = historyGuard.ctx.handlers.get('agent/pre-step')
const makeDecision = () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }] })
const guarded = await preStep({}, async () => makeDecision())
assert.ok(typeof guarded.messages[0].id === 'string' && guarded.messages[0].id.length > 0, '缺 id 的消息被补上')
historyGuard.setState(stateOf({ enabled: false }))
const untouched = await preStep({}, async () => makeDecision())
assert.equal(untouched.messages[0].id, undefined, '开关关闭时历史闸不碰消息')

console.log('turn-guard: 全部用例通过')
