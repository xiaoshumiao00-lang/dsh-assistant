/**
 * 单测：托管 · 决策自动应答（src/tuoguan-autoanswer.ts）。
 *   node scripts/test-tuoguan-autoanswer.mjs
 *
 * 固定这几条边界：
 *   - 托管开 → 审批就地给 `allowed-once`，**不再调用 next**（请求到不了浏览器那张卡）；
 *   - 托管关 / 读不到状态 / 请求没有会话身份 → 原样 `next()`，官方卡片照旧；
 *   - 提问：有选项选首选项，plan-review 选 `intent.approve`，没选项回自由文本；
 *     缺 id 的题没法按契约作答 → 交回人工；
 *   - 子代理的审批跟着父会话的开关走；普通 fork（深度 0）不往上继承；
 *   - 安装器两个监听都带 `prepend: true`（抢在 api-remotes 转发之前），卸载后摘干净。
 */
import assert from 'node:assert/strict'
import {
  APPROVAL_OUTCOME,
  FREE_TEXT_DEFAULT,
  createAutoAnswer,
  defaultAnswerBatch,
  defaultAnswerLabel,
  installAutoAnswer,
  sessionAncestry,
  sessionIdOf,
  tuoguanOnForChain,
} from '../src/tuoguan-autoanswer.ts'

/** 一条「不该被走到的」next 兜底：调用即记录，返回 sentinel。 */
function makeNext(value = 'next-value') {
  const calls = []
  const next = async () => {
    calls.push(value)
    return value
  }
  return { next, calls }
}

const approvalOf = (sessionId, toolName = 'pwsh') => ({ agent: { session: { id: sessionId } }, toolName })

const questionOf = (sessionId, questions) => ({
  agent: { session: { id: sessionId } },
  questions,
})

function makeController(state, options = {}) {
  const logs = []
  const controller = createAutoAnswer({
    readState: options.readState ?? (() => state),
    ancestryOf: options.ancestryOf,
    log: (line) => logs.push(line),
  })
  return { controller, logs }
}

const cases = []

cases.push(['会话链判定：最近的显式设置优先，都没有才用默认值', () => {
  assert.equal(tuoguanOnForChain({ defaultOn: true }, ['s1']), true, '缺省开')
  assert.equal(tuoguanOnForChain({ defaultOn: false }, ['s1']), false, '默认关')
  assert.equal(tuoguanOnForChain({ defaultOn: true, off: { s1: true } }, ['s1']), false, '显式关盖过默认开')
  assert.equal(tuoguanOnForChain({ defaultOn: false, on: { s1: true } }, ['s1']), true, '显式开盖过默认关')
  assert.equal(tuoguanOnForChain(undefined, ['s1']), true, '没有状态文件 = 老行为（托管中）')
  // 子代理继承：子会话没设置 → 看父；父显式关 → 关
  assert.equal(tuoguanOnForChain({ defaultOn: true, off: { parent: true } }, ['child', 'parent']), false, '父关 → 子关')
  // 子自己被显式开过 → 子优先
  assert.equal(tuoguanOnForChain({ defaultOn: true, on: { child: true }, off: { parent: true } }, ['child', 'parent']), true, '子显式开 → 子开')
  assert.equal(tuoguanOnForChain({ defaultOn: true }, ['', 's1']), true, '空 id 跳过')
}])

cases.push(['会话链：子代理往上走，普通 fork 不继承', () => {
  const agents = {
    child: { session: { id: 'child', header: { origin: 'subagent', parentSession: 'root', delegationDepth: 1 } } },
    grandchild: { session: { id: 'grandchild', header: { parentSession: 'child', delegationDepth: 2 } } },
    fork: { session: { id: 'fork', header: { parentSession: 'root', delegationDepth: 0 } } },
    root: { session: { id: 'root', header: { delegationDepth: 0 } } },
  }
  const agentOf = (id) => agents[id] ?? null
  assert.deepEqual(sessionAncestry('child', agentOf), ['child', 'root'], '一级子代理带父')
  assert.deepEqual(sessionAncestry('grandchild', agentOf), ['grandchild', 'child', 'root'], '两级也能一路走上去')
  assert.deepEqual(sessionAncestry('fork', agentOf), ['fork'], '普通 fork 不继承')
  assert.deepEqual(sessionAncestry('root', agentOf), ['root'])
  assert.deepEqual(sessionAncestry('missing', agentOf), ['missing'], '取不到 Agent 就只判自己')
}])

cases.push(['审批：托管开 → allowed-once，next 一次都不许调', async () => {
  const { controller, logs } = makeController({ defaultOn: true })
  const { next, calls } = makeNext()
  const outcome = await controller.answerApproval(approvalOf('s1', 'pwsh'), next)
  assert.equal(outcome, APPROVAL_OUTCOME)
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(calls, [], '自动作答后不许再往下走')
  assert.equal(logs.some((line) => line.includes('审批 pwsh')), true, '要留一条宿主日志')
}])

cases.push(['审批：托管关 → 原样 next（官方卡片照旧）', async () => {
  const { controller } = makeController({ defaultOn: true, off: { s1: true } })
  const { next, calls } = makeNext('human-card')
  assert.equal(await controller.answerApproval(approvalOf('s1'), next), 'human-card')
  assert.equal(calls.length, 1)
}])

cases.push(['审批：读不到托管状态 → 按不托管处理，不抛错', async () => {
  const { controller, logs } = makeController(undefined, {
    readState: () => { throw new Error('state file is gone') },
  })
  const { next, calls } = makeNext()
  assert.equal(await controller.answerApproval(approvalOf('s1'), next), 'next-value')
  assert.equal(calls.length, 1)
  assert.equal(logs.some((line) => line.includes('读不到托管状态')), true)
}])

cases.push(['审批：请求没有会话身份 → 交回人工', async () => {
  const { controller } = makeController({ defaultOn: true })
  for (const request of [undefined, null, {}, { agent: null }, { agent: { session: {} } }]) {
    const { next, calls } = makeNext()
    assert.equal(await controller.answerApproval(request, next), 'next-value')
    assert.equal(calls.length, 1)
  }
  assert.equal(sessionIdOf(undefined), '')
  assert.equal(sessionIdOf(approvalOf('s1')), 's1')
}])

cases.push(['提问：默认选首选项，多题各答各的', async () => {
  const { controller } = makeController({ defaultOn: true })
  const request = questionOf('s1', [
    { id: 'q1', question: '选哪个？', options: [{ label: '方案 A' }, { label: '方案 B' }] },
    { id: 'q2', question: '再选一个？', options: [{ label: '继续' }] },
  ])
  const { next, calls } = makeNext()
  const answer = await controller.answerQuestion(request, next)
  assert.deepEqual(answer, {
    answers: [
      { id: 'q1', selected: ['方案 A'] },
      { id: 'q2', selected: ['继续'] },
    ],
  })
  assert.deepEqual(calls, [])
}])

cases.push(['提问：plan-review 选 intent.approve 指定的那一个', async () => {
  const { controller } = makeController({ defaultOn: true })
  const label = defaultAnswerLabel({
    id: 'p1',
    intent: { kind: 'plan-review', approve: '批准这个计划' },
    options: [{ label: '再看看' }, { label: '批准这个计划' }],
  })
  assert.equal(label, '批准这个计划', '批准项按名字找，不靠选项顺序')
  const answer = await controller.answerQuestion(questionOf('s1', [{
    id: 'p1',
    intent: { kind: 'plan-review', approve: '批准这个计划' },
    options: [{ label: '再看看' }, { label: '批准这个计划' }],
  }]), makeNext().next)
  assert.deepEqual(answer.answers[0].selected, ['批准这个计划'])
}])

cases.push(['提问：没有选项 → 自由文本走 custom，selected 留空', async () => {
  const { controller } = makeController({ defaultOn: true })
  const answer = await controller.answerQuestion(questionOf('s1', [
    { id: 'free', question: '还有别的要补充吗？' },
    { id: 'empty', question: '空选项？', options: [] },
  ]), makeNext().next)
  assert.deepEqual(answer, {
    answers: [
      { id: 'free', selected: [], custom: FREE_TEXT_DEFAULT },
      { id: 'empty', selected: [], custom: FREE_TEXT_DEFAULT },
    ],
  })
  assert.deepEqual(defaultAnswerBatch([]), { answers: [] })
}])

cases.push(['提问：托管关 / 缺 id / 空题单 → 交回人工', async () => {
  const off = makeController({ defaultOn: true, off: { s1: true } })
  const withOptions = [{ id: 'q1', options: [{ label: 'A' }] }]
  const a = makeNext()
  assert.equal(await off.controller.answerQuestion(questionOf('s1', withOptions), a.next), 'next-value')
  assert.equal(a.calls.length, 1)

  const on = makeController({ defaultOn: true })
  const b = makeNext()
  assert.equal(await on.controller.answerQuestion(questionOf('s1', [{ options: [{ label: 'A' }] }]), b.next), 'next-value')
  assert.equal(b.calls.length, 1, '缺 id 的题没法按契约作答')

  const c = makeNext()
  assert.equal(await on.controller.answerQuestion(questionOf('s1', []), c.next), 'next-value')
  assert.equal(await on.controller.answerQuestion({ questions: withOptions }, c.next), 'next-value', '没有会话身份')
  assert.equal(c.calls.length, 2)
}])

cases.push(['子代理：父会话显式关 → 子代理审批也交回人工', async () => {
  const agents = {
    child: { session: { id: 'child', header: { origin: 'subagent', parentSession: 'root', delegationDepth: 1 } } },
    root: { session: { id: 'root', header: { delegationDepth: 0 } } },
  }
  const agentOf = (id) => agents[id] ?? null
  const { controller } = makeController({ defaultOn: true, off: { root: true } }, {
    ancestryOf: (sessionId) => sessionAncestry(sessionId, agentOf),
  })
  const { next, calls } = makeNext()
  assert.equal(await controller.answerApproval(approvalOf('child'), next), 'next-value')
  assert.equal(calls.length, 1)

  const open = makeController({ defaultOn: false, on: { root: true } }, {
    ancestryOf: (sessionId) => sessionAncestry(sessionId, agentOf),
  })
  const answer = await open.controller.answerApproval(approvalOf('child'), makeNext().next)
  assert.equal(answer, APPROVAL_OUTCOME, '父显式开 → 子代理自动放行')
}])

/** 造一个只认 `on(name, listener, options)` / `get('agents')` 的假宿主，外加一条简易 waterfall。 */
function makeFakeHost() {
  const hooks = new Map()
  const agents = new Map()
  const ctx = {
    on(name, listener, options) {
      const list = hooks.get(name) ?? []
      list.push({ listener, options: options ?? {} })
      hooks.set(name, list)
      return () => {
        hooks.set(name, (hooks.get(name) ?? []).filter((hook) => hook.listener !== listener))
      }
    },
    get(name) {
      if (name === 'agents') return { get: (sessionId) => agents.get(sessionId) }
      return undefined
    },
  }
  const addAgent = (sessionId, header) => {
    agents.set(sessionId, { session: { id: sessionId, header } })
  }
  // 简易 waterfall：prepend 的排前面（其余保持注册顺序），不调 next 即作答。
  const waterfall = async (name, request) => {
    const list = [...(hooks.get(name) ?? [])]
      .sort((a, b) => Number(b.options.prepend === true) - Number(a.options.prepend === true))
    const visited = []
    const run = async (index) => {
      const hook = list[index]
      if (hook === undefined) return 'builtin-unavailable'
      visited.push(index)
      return await hook.listener(request, async () => await run(index + 1))
    }
    return { answer: await run(0), visited, count: list.length }
  }
  return { ctx, hooks, addAgent, waterfall }
}

cases.push(['安装器：两个监听都 prepend，抢在转发给浏览器之前作答', async () => {
  const host = makeFakeHost()
  host.addAgent('s1', { delegationDepth: 0 })
  // 模拟 @deepseek-ai/dsh-api-remotes 注册的转发监听（普通顺序）。
  const forwarded = []
  host.ctx.on('approval/request', async () => { forwarded.push('approval'); return 'browser-card' })
  host.ctx.on('user-questions/request', async () => { forwarded.push('question'); return { answers: [] } })

  const dispose = installAutoAnswer(host.ctx, { readState: () => ({ defaultOn: true }), log: () => {} })
  for (const name of ['approval/request', 'user-questions/request']) {
    assert.equal(
      host.hooks.get(name).some((hook) => hook.options.prepend === true),
      true,
      `${name} 要有 prepend 监听`,
    )
  }

  const approval = await host.waterfall('approval/request', approvalOf('s1'))
  assert.equal(approval.answer, APPROVAL_OUTCOME)
  assert.equal(forwarded.includes('approval'), false, '托管开着时请求不该再到浏览器')
  assert.equal(approval.visited.length, 1, '只走了 prepend 的那一个')

  const question = await host.waterfall('user-questions/request', questionOf('s1', [
    { id: 'q1', options: [{ label: '默认项' }] },
  ]))
  assert.deepEqual(question.answer, { answers: [{ id: 'q1', selected: ['默认项'] }] })
  assert.equal(forwarded.includes('question'), false)

  dispose()
  assert.equal((host.hooks.get('approval/request') ?? []).length, 1, '卸载后只剩转发监听')
  assert.equal((host.hooks.get('user-questions/request') ?? []).length, 1)
}])

cases.push(['安装器：托管关时原样放行给浏览器那张卡', async () => {
  const host = makeFakeHost()
  host.addAgent('s1', { delegationDepth: 0 })
  const forwarded = []
  host.ctx.on('approval/request', async () => { forwarded.push('approval'); return 'browser-card' })
  const dispose = installAutoAnswer(host.ctx, {
    readState: () => ({ defaultOn: true, off: { s1: true } }),
    log: () => {},
  })
  const approval = await host.waterfall('approval/request', approvalOf('s1'))
  assert.equal(approval.answer, 'browser-card')
  assert.deepEqual(forwarded, ['approval'])
  dispose()
}])

cases.push(['安装器：宿主没有事件总线时安静降级，不抛错', () => {
  const logs = []
  const bare = { on: null, get: () => undefined }
  const dispose = installAutoAnswer(bare, { readState: () => ({ defaultOn: true }), log: (line) => logs.push(line) })
  dispose()
  assert.equal(logs.some((line) => line.includes('未启用')), true)

  const host = makeFakeHost()
  const disposeHost = installAutoAnswer(host.ctx, { readState: () => ({ defaultOn: true }), log: () => {} })
  assert.equal((host.hooks.get('approval/request') ?? []).length, 1)
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
