/**
 * 单测：code_agent 完成通知的时机与文案（vendor/computer-use/code-agent-registry）。
 *   node scripts/test-cu-code-agent-notice.mjs
 *
 * 对着 2026-11-20「录入店铺到轰趴后台」那次实录立的规矩：后台 Code 会话派完第一个片段后
 * 自己还在续跑下一轮，通知要等 `whenIdle` 才回传 —— 前台 Computer Use 白等 5.4 分钟，
 * 整场 60.5 分钟里有 27.9 分钟（46%）是这种空等。
 *
 * 固定这几条边界：
 *   - 自己那一轮出现新的 `turn/end` 就回传，会话仍在跑也回传（不再等整条会话 idle）；
 *   - 没有 `snapshotEvents`（测试假 agent）时旧路径 `whenIdle` 照旧能用；
 *   - abort 后不追通知；
 *   - 通知文案分「跑完了」/「这一片段交付完了、会话还在跑后续轮」两种，
 *     后者明说前台现在就能接着做 GUI，并提醒别把无关的新片段排到 busy 的会话后面；
 *   - 用户从主窗口停掉的会话仍走「stopped by the user」文案，且不许自动重开；
 *   - 前台被别的 Computer Use 会话占着时仍带屏幕忙后缀（旧行为）；
 *   - 后台 Code 会话的结果进通知的口径（2026-11-23 修第四个 bug）：整段带全（上限 20000 字，
 *     与秘书通知 CU_NOTICE_RESULT_MAX_CHARS 同一口径），跨消息交回的几整段按顺序拼接，
 *     真超上限才截尾并在正文里照实标注「cut here … tail is missing」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const registryPath = new URL('../vendor/computer-use/code-agent-registry-DDJfS2Fl.js', import.meta.url)
const source = readFileSync(registryPath, 'utf8')
// 这份 vendored 模块只 import @deepseek-ai/dsh-llm（宿主侧才有），测试里换成本地桩。
const body = source
  .replace(/^import[^\n]*\n/m, '')
  .replace(/^export \{[^\n]*\n?/m, '')
const factory = new Function('boundContextSummary', 'createUserMessage', `${body}\nreturn { runWatch, raceCompletionSignals, completionNoticeText, lastAssistantText, lastTurnEndIndex, anotherComputerUseRunning, CODE_AGENT_NOTICE_MAX_CHARS, NO_ASSISTANT, SCREEN_BUSY_SUFFIX };`)
const stubs = {
  boundContextSummary: (text) => String(text).slice(0, 120),
  createUserMessage: (message) => message,
}
const registry = factory(stubs.boundContextSummary, stubs.createUserMessage)

const cases = []

function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

/**
 * 假的 Code agent。`events` 会被就地追加，模拟「这一轮跑完」。
 * @param options.status - 会话状态。
 * @param options.supportsSnapshotEvents - 关掉时读不到 `turn/end`（旧路径测试用）。
 * @param options.resolveIdle - whenIdle 多快返回。
 */
function fakeCodeAgent(options = {}) {
  const events = options.events ?? []
  const agent = {
    id: 'code-1',
    status: options.status ?? 'running',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { on: () => () => {}, logger: { warn() {} } },
    session: {
      id: 'code-1',
      deriveMessages: () => options.messages ?? [assistantMessage('写好了 C:\\stores.xlsx，共 3 家店。')],
    },
    whenIdle: () => new Promise((resolve) => {
      setTimeout(() => {
        if (agent.status === 'running') agent.status = 'idle'
        resolve()
      }, options.idleMs ?? 1e4)
    }),
  }
  if (options.supportsSnapshotEvents ?? true) agent.session.snapshotEvents = () => events.slice()
  return agent
}

function fakeCaller(options = {}) {
  const caller = {
    id: 'cu-1',
    status: 'idle',
    notices: [],
    ctx: { on: () => () => {}, logger: { warn() {} } },
    whenIdle: async () => {},
    followup: (message) => { caller.notices.push(message) },
  }
  return caller
}

function fakeWatch({ code, caller, running = [] }) {
  return {
    code,
    caller,
    requestId: 'rpc-1',
    sessionId: 'code-1',
    task: '录入 3 家门店到后台',
    agents: {
      get: (id) => (id === caller.id ? caller : undefined),
      list: () => running,
    },
  }
}

async function withAbort(runner) {
  const controller = new AbortController()
  const result = await runner({ controller, signal: controller.signal })
  controller.abort()
  return result
}

cases.push(['自己那一轮结束就回传，不等整条会话 idle（会话还在跑也算完成）', async () => {
  const events = []
  const code = fakeCodeAgent({ events, status: 'running', idleMs: 3e4 })
  setTimeout(() => events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 200)
  const started = Date.now()
  const outcome = await withAbort(({ controller }) => raceWithTimeout(registry.raceCompletionSignals(code, controller.signal), 3e3))
  assert.ok(outcome === 'settled', '按轮结束的路径没有回传')
  assert.ok(Date.now() - started < 2500, '回传晚了：' + Date.now() - started)
  assert.equal(code.status, 'running', '这条测试要求会话仍在跑后续轮')
}])

cases.push(['没有 snapshotEvents 时旧路径（whenIdle）照旧能用', async () => {
  const code = fakeCodeAgent({ supportsSnapshotEvents: false, idleMs: 300 })
  const outcome = await withAbort(({ controller }) => raceWithTimeout(registry.raceCompletionSignals(code, controller.signal), 3e3))
  assert.equal(outcome, 'settled')
  assert.equal(code.status, 'idle')
}])

cases.push(['abort 之后不追通知', async () => {
  const events = []
  const code = fakeCodeAgent({ events, idleMs: 3e4 })
  const caller = fakeCaller()
  const watch = fakeWatch({ code, caller })
  setTimeout(() => events.push({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }), 400)
  await withAbort(async ({ controller }) => {
    setTimeout(() => controller.abort(), 120)
    await registry.runWatch(watch, controller.signal)
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(caller.notices.length, 0, 'abort 之后不该再有通知')
  assert.deepEqual(events.map((event) => event.type), ['turn/end'])
}])

cases.push(['通知文案：会话还在跑后续轮时按「这一片段交付完了」讲，并允许前台继续', async () => {
  const events = []
  const code = fakeCodeAgent({ events, idleMs: 3e4 })
  const caller = fakeCaller()
  const watch = fakeWatch({ code, caller })
  await withAbort(async ({ controller }) => {
    const running = registry.runWatch(watch, controller.signal)
    setTimeout(() => events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 150)
    await running
  })
  assert.equal(caller.notices.length, 1)
  const notice = caller.notices[0]
  const text = notice.content[0].text
  assert.equal(notice.source.kind, 'computer-use')
  assert.equal(notice.source.form, 'notice')
  assert.match(notice.source.summary, /completed the dispatched stretch/)
  assert.match(text, /its own turns are still running/)
  assert.match(text, /still working on later rounds/)
  assert.match(text, /code_agent_status/)
  assert.match(text, /录入 3 家门店到后台/)
  assert.match(text, /C:\\stores\.xlsx/)
  assert.ok(!text.includes(registry.SCREEN_BUSY_SUFFIX), '屏幕不忙时不该带忙后缀')
}])

cases.push(['通知文案：会话空了才回传时仍按「finished this task」讲', async () => {
  const events = [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]
  const code = fakeCodeAgent({ events, idleMs: 120 })
  const caller = fakeCaller()
  await withAbort(({ controller }) => registry.runWatch(fakeWatch({ code, caller }), controller.signal))
  assert.equal(caller.notices.length, 1)
  const text = caller.notices[0].content[0].text
  assert.match(text, /finished this task/)
  assert.ok(!text.includes('still running'))
  assert.match(caller.notices[0].source.summary, /finished$/)
}])

cases.push(['用户从主窗口停掉的会话：文案按 stopped 讲，且不许自动重开', async () => {
  const events = [{ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }]
  const code = fakeCodeAgent({ events, idleMs: 80 })
  const caller = fakeCaller()
  await withAbort(({ controller }) => registry.runWatch(fakeWatch({ code, caller }), controller.signal))
  const text = caller.notices[0].content[0].text
  assert.match(text, /The user stopped background Code agent session code-1/)
  assert.match(text, /Do not restart this task/)
  assert.ok(!text.includes('still working on later rounds'))
}])

cases.push(['前台被别的 Computer Use 会话占着时仍带屏幕忙后缀（旧行为）', async () => {
  const events = [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]
  const code = fakeCodeAgent({ events, idleMs: 80 })
  const caller = fakeCaller()
  const other = { id: 'cu-2', status: 'running', session: { header: { agentPreset: 'computer-use' } } }
  await withAbort(({ controller }) => registry.runWatch(fakeWatch({ code, caller, running: [other] }), controller.signal))
  assert.match(caller.notices[0].content[0].text, new RegExp(registry.SCREEN_BUSY_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(registry.anotherComputerUseRunning({ caller, agents: { list: () => [{ id: 'cu-2', status: 'idle', session: { header: { agentPreset: 'computer-use' } } }] } }), false)
}])

cases.push(['lastTurnEndIndex：只数真正关闭的轮，缺 snapshotEvents 读 -1', () => {
  assert.equal(registry.lastTurnEndIndex(fakeCodeAgent({ events: [{ type: 'turn/start' }, { type: 'turn/end', data: {} }] })), 1)
  assert.equal(registry.lastTurnEndIndex(fakeCodeAgent({ supportsSnapshotEvents: false })), -1)
  assert.equal(registry.lastTurnEndIndex({ session: undefined }), -1)
}])

cases.push(['completionNoticeText 新口径：后台长结果整段带全（不再 4000 拦腰截），真超上限才截尾并照实标注', () => {
  const cap = registry.CODE_AGENT_NOTICE_MAX_CHARS
  assert.equal(cap, 20000, '与秘书通知那条唯一口径（CU_NOTICE_RESULT_MAX_CHARS）对齐')
  assert.ok(cap > 4000, '不许退回旧的 4000 上限')
  // 改前这条会拦腰砍：12000 字后台结果 → 只带 4000 字
  const long = 'x'.repeat(12000)
  const whole = registry.completionNoticeText('code-1', '任务', long, false, false, false)
  assert.ok(whole.includes(long), '12000 字的结果要整段带全')
  assert.ok(!whole.endsWith('…'), '整段带全时不许留省略号')
  assert.ok(!whole.includes('cut here'), '没截断就不许带截断标注')
  // 真正超出新上限的极端长结果：截尾 + 省略号 + 明确说后半段不在通知里
  const overflow = registry.completionNoticeText('code-1', '任务', 'y'.repeat(cap + 5000), false, false, false)
  assert.ok(overflow.includes('y'.repeat(cap)), '截断前的一半必须完整带出')
  assert.ok(!overflow.includes('y'.repeat(cap + 1)), '超出上限的那部分不该带出')
  assert.match(overflow, /That reply is cut here at 20000 characters/, '截断要在通知正文里如实标注')
  assert.match(overflow, /the tail after the .…. is missing/, '要说清后半段不在通知里')
  assert.match(overflow, /read the full text back from the file that Code session wrote/, '要给出补救办法（读回整段 / 开那条会话）')
  assert.match(overflow, /Dispatch another stretch to that session only when the user asked you to/, '截断补救不许自己造「通知→再派活→再通知」回路')
  assert.ok(overflow.length < cap + 5000 + 400, '正文里除了上限本身不该再塞全量结果')
  // stopped 与 busy 两条支路互不干扰（旧口径保留）
  const stopped = registry.completionNoticeText('code-1', '任务', '结果', true, true, true)
  assert.match(stopped, /The user stopped/)
  assert.match(stopped, new RegExp(registry.SCREEN_BUSY_SUFFIX.slice(0, 20)))
  assert.ok(!stopped.includes('still working'))
}])

cases.push(['后台结果跨消息交回时按顺序拼接进通知（改前只取最新一条 assistant，前面几整段丢掉）', async () => {
  const events = [
    { type: 'user/message', data: { id: 'm-1', source: { kind: 'user', rpcId: 'rpc-1' } } },
    { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '甲'.repeat(1200) }] } } },
    { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '乙'.repeat(1200) }, { type: 'toolCall', name: 'pwsh' }] } } },
    { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '丙'.repeat(1200) }, { type: 'text', text: '丁'.repeat(900) }] } } },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ]
  const code = fakeCodeAgent({ events, idleMs: 80 })
  const caller = fakeCaller()
  await withAbort(({ controller }) => registry.runWatch(fakeWatch({ code, caller }), controller.signal))
  assert.equal(caller.notices.length, 1)
  const text = caller.notices[0].content[0].text
  assert.ok(text.includes('甲'.repeat(1200)), '第一条消息的整段要在')
  assert.ok(text.includes('乙'.repeat(1200)), '第二条消息的整段要在')
  assert.ok(text.includes('丙'.repeat(1200)), '一条消息里第一个 text 块要在')
  assert.ok(text.includes('丁'.repeat(900)), '同一条消息的第二个 text 块也不许丢')
  assert.ok(!text.endsWith('…'), '整段带全时不许留省略号：' + text.slice(-24))
  assert.match(text, /甲{1200}\n\n乙{1200}/, '按顺序拼接（段之间隔一个空行）')
  // 没有派发边界（老会话/没有 rpcId）时退回「最后关闭那一轮」的整段，也不许再只取一条
  const noBoundary = [
    { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'text', text: '戊'.repeat(1500) }] } } },
    { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'text', text: '己'.repeat(1500) }] } } },
    { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } },
  ]
  const code2 = fakeCodeAgent({ events: noBoundary, idleMs: 80 })
  const caller2 = fakeCaller()
  await withAbort(({ controller }) => registry.runWatch(fakeWatch({ code: code2, caller: caller2 }), controller.signal))
  const text2 = caller2.notices[0].content[0].text
  assert.ok(text2.includes('戊'.repeat(1500)) && text2.includes('己'.repeat(1500)), '按轮次拼接也要两条都在')
}])

cases.push(['提示词口径也不再要求「为简短而裁」：code_agent 工具描述、CU 提示词、cordis 预设三处同步', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const codeAgent = read('../vendor/computer-use/code-agent.js')
  const cuIndex = read('../vendor/computer-use/index.js')
  const patch = read('../cordis.patch.yml')
  for (const [label, text] of [['code_agent 工具描述', codeAgent], ['CU 提示词', cuIndex], ['cordis 预设', patch]]) {
    assert.ok(!text.includes('Do not recite a long report'), `${label} 里不许再留「不要念长报告」`)
    assert.ok(!text.includes('tell the user the short conclusion'), `${label} 里不许再要求只说短结论`)
  }
  assert.ok(codeAgent.includes('pass it on as it is instead of trimming it for length'), '工具描述要要求把通知里的整段结果原样转给用户')
  assert.ok(codeAgent.includes('give them in full instead of compressing them into a summary'), '后台角色文本不许再把完整调查结果压成摘要')
  assert.ok(cuIndex.includes('pass it on instead of trimming it for length'), 'CU 提示词同样不许裁')
  assert.ok(patch.includes('pass it on instead of trimming it for length'), 'cordis 预设那条也要对齐')
  assert.ok(codeAgent.includes('omit session_id and start a second Code session'), '别把无关片段排到 busy 的会话后面这条闸不许被顺手删掉')
  assert.ok(cuIndex.includes('call code_agent with that session_id'), '续接同一条会话的闸保留')
  assert.ok(patch.includes('通知说后台会话还在跑后续轮次时'), 'busy 会话那条中文提醒保留')
}])

/** 给 await 加一层超时，避免测试因为路径没回传而挂到 node 自己退出。 */
function raceWithTimeout(work, ms) {
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish('timeout'), ms)
    work.then(() => finish('settled'), () => finish('rejected'))
  })
}

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
