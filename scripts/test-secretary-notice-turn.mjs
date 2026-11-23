/**
 * 秘书「CU 完成汇报」投递通道回归（2026-11-21 事故后重写）。
 *
 * 事故回顾：旧实现自己拼 turn/start → step/start → assistant/message → step/end →
 * turn/end 往秘书会话里写"合成轮"，turn 号按日志最大 turn + 1 算。宿主的 turn 号来自
 * AgentLoop 内存计数器（agent.ts: `phase.turn + 1`），不读日志，于是插件写的 turn 7
 * 和宿主下一轮的 turn 7 撞号，v4 恢复器直接抛
 * `SessionFormatError: turn/start does not open the expected turn`，会话再也打不开
 * （session-33044545 的 seq 103/127/149）。
 *
 * 本用例锁死新契约：
 *   1. 只走宿主官方 prompt 通道 `agent.followup(message)`，**一个会话事件都不写**；
 *   2. 消息形状是宿主认的 user 消息（role/source/content），正文含系统通知说明与会话引用；
 *   3. 拿不到活 agent（宿主没提供 followup）→ 返回 false，绝不退回"自己写事件"；
 *   4. 通知回合只禁动手类：模型不能借通知回合再派活，避免「通知→派活→再通知」的回路；
 *      纯读类（read/glob/grep）与目标类（create_goal/update_goal/get_goal）仍放行——
 *      通知原文被截断时读报告文件是唯一补救（2026-11-23 用户实报）。用户真实回合完全不受影响。
 *
 *   node scripts/test-secretary-notice-turn.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const assistant = await import('../lib/index.js')
const watch = assistant.assistantCuWatchTestSurface
const secretary = assistant.assistantSecretaryTestSurface

const cases = []

/* ---------- 1. 只投提示，不写事件 ---------- */
cases.push(['投递只走 agent.followup，一个会话事件都不写', () => {
  const appended = []
  const followups = []
  const session = {
    id: 'session-notice-1',
    // 旧实现会调用它；新实现一旦调用就说明又回到"自己拼日志"的老路。
    append: (...args) => { appended.push(args); throw new Error('插件不该自己写会话日志') },
    snapshotEvents: () => [],
  }
  const agent = { session, followup: (message) => { followups.push(message) } }
  const ok = watch.postSecretaryNotice(agent, { sessionId: 'cu-1', title: '门店详情页', summary: '白屏修好了。' })
  assert.equal(ok, true)
  assert.equal(appended.length, 0, '绝不能自己 append turn/step 事件')
  assert.equal(followups.length, 1, '必须交给宿主 prompt 通道')
  const message = followups[0]
  assert.equal(message.role, 'user', '宿主 prompt 通道只接受 user 消息')
  assert.equal(message.source.kind, 'user')
  assert.equal(typeof message.id, 'string')
  const text = message.content[0].text
  assert.match(text, /系统通知/, '必须自报是系统通知，避免模型当作用户说话')
  assert.match(text, /门店详情页/)
  assert.match(text, /白屏修好了/)
  assert.ok(text.includes('[[session:cu-1|门店详情页]]'), '会话引用要原样留在通知里，卡片才能渲染可点跳')
  assert.match(text, /动手类工具已禁用/, '要明确告诉模型这一轮不能动手')
  assert.match(text, /read\/glob\/grep 放行/, '读文件在这一轮是放行的（原文截断时的唯一补救）')
}])

/* ---------- 2. 没有官方通道就放弃，绝不自己写 ---------- */
cases.push(['拿不到 agent.followup → false，且绝不退回写事件', () => {
  const appended = []
  const noFollowup = { session: { append: (...args) => { appended.push(args) } } }
  assert.equal(watch.postSecretaryNotice(noFollowup, { sessionId: 'cu-2', title: '', summary: '' }), false)
  assert.equal(watch.postSecretaryNotice(null, { sessionId: 'cu-2', title: '', summary: '' }), false)
  assert.equal(appended.length, 0, '没有官方通道时宁可丢这条通知，也不许写日志')
}])

/* ---------- 3. notifySecretary 从 ctx 取 agent ---------- */
cases.push(['notifySecretary 按固定 id 取到 agent 并投递', () => {
  secretary.secretarySessionRef.id = 'session-notice-3'
  const followups = []
  const agent = { session: { id: 'session-notice-3' }, followup: (message) => followups.push(message) }
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => (id === 'session-notice-3' ? agent : undefined) }
      return undefined
    },
  }
  const logs = []
  const ok = watch.notifySecretary(ctx, { sessionId: 'cu-3', title: '爬虫工程', summary: '抓完了。' }, (line) => logs.push(line))
  assert.equal(ok, true)
  assert.equal(followups.length, 1)
  assert.ok(logs.some((line) => line.includes('agent.followup')), '日志要写清楚走的是官方通道')

  // 秘书 id 对应的 agent 不存在 → false + 明确日志，不写事件
  const missing = watch.notifySecretary({ get: () => ({ get: () => undefined }) }, { sessionId: 'cu-4', title: 'x', summary: '' }, (line) => logs.push(line))
  assert.equal(missing, false)
  assert.ok(logs.some((line) => line.includes('没有活的 agent')), '跳过原因要写进日志')
}])

/* ---------- 4. 通知回合只禁动手类（防止派活回路） ---------- */
function fakeServer() {
  const exact = new Map()
  return {
    exact,
    register(route) {
      if (exact.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      exact.set(route.path, route)
      return () => { exact.delete(route.path) }
    },
  }
}
function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = secretary.ASSISTANT_SECRETARY_ROUTE
  return req
}
function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? null }
  out.end = (payload) => { out.body = String(payload ?? '') }
  return out
}

cases.push(['通知回合只禁动手类；用户真实回合恢复放行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-notice-turn-'))
  const server = fakeServer()
  const hooks = new Map()
  const ctx = {
    webServer: server,
    get(name) { return name === 'profileContext' ? { dir: root } : undefined },
    on(name, fn) { hooks.set(name, fn); return () => { if (hooks.get(name) === fn) hooks.delete(name) } },
  }
  const dispose = secretary.registerAssistantSecretary(ctx)
  try {
    const route = server.exact.get(secretary.ASSISTANT_SECRETARY_ROUTE)
    const res = fakeRes()
    await route.handler(fakeReq('POST', JSON.stringify({ sessionId: 'session-notice-4' })), res)
    assert.equal(JSON.parse(res.body).sessionId, 'session-notice-4')
    const preStep = hooks.get('agent/pre-step')
    const preTool = hooks.get('tools/pre-execute')
    assert.equal(typeof preStep, 'function')
    assert.equal(typeof preTool, 'function')
    const next = async () => ({ kind: 'allow' })

    // 用户真实消息 → 正常按白名单放行只读联网
    await preStep({ agent: { session: { id: 'session-notice-4' } }, messages: [{ id: 'user-1', role: 'user' }], turn: 1, step: 1 }, next)
    const userTurn = await preTool({ name: 'web_search', agent: { session: { id: 'session-notice-4' } } }, next)
    assert.equal(userTurn.kind, 'allow', '用户自己的回合不受影响')

    // 系统通知消息 → 这一轮动手类工具全禁（连白名单里的派活/联网也禁）
    const noticeId = 'notice-4'
    secretary.registerNoticeMessageId(noticeId)
    await preStep({ agent: { session: { id: 'session-notice-4' } }, messages: [{ id: noticeId, role: 'user' }], turn: 2, step: 1 }, next)
    for (const name of ['secretary_dispatch', 'web_search', 'write', 'edit', 'apply_patch', 'bash', 'pwsh', 'computer_use', 'subagent']) {
      let allowed = false
      const denied = await preTool({ name, agent: { session: { id: 'session-notice-4' } } }, async () => { allowed = true; return { kind: 'allow' } })
      assert.equal(allowed, false, `${name} 在通知回合不该被执行`)
      assert.equal(denied.kind, 'deny')
      assert.match(denied.reason, /系统通知/)
      // 闸的措辞与通知模板同口径：要求完整汇报，不再要求短句；只禁动手类
      assert.match(denied.reason, /完整汇报/, '闸的口径要跟上撤掉的长度限制')
      assert.ok(!denied.reason.includes('一两句'), `闸的措辞里还留着长度限制：${denied.reason}`)
      assert.match(denied.reason, /动手类工具已禁用/)
      assert.match(denied.reason, /read\/glob\/grep/, '要告诉模型读文件是这一轮允许的补救手段')
    }

    // 2026-11-23 用户实报：读类与 goal 类在通知回合也不该被误伤——截断的原文要靠读报告文件补齐。
    for (const name of ['read', 'glob', 'grep', 'create_goal', 'update_goal', 'get_goal']) {
      let allowed = false
      const result = await preTool({ name, agent: { session: { id: 'session-notice-4' } } }, async () => { allowed = true; return { kind: 'allow' } })
      assert.equal(allowed, true, `${name} 不写不跑不派活，通知回合不该被禁`)
      assert.equal(result.kind, 'allow')
    }

    // turn/end 之后回到正常
    const onEvent = hooks.get('session/event')
    if (typeof onEvent === 'function') onEvent({ id: 'session-notice-4' }, { type: 'turn/end', data: { turn: 2 } })
    const after = await preTool({ name: 'web_search', agent: { session: { id: 'session-notice-4' } } }, next)
    assert.equal(after.kind, 'allow', '通知轮结束后必须恢复')
  } finally {
    dispose()
    secretary.clearNoticeMessageIds()
    rmSync(root, { recursive: true, force: true })
  }
}])

/* ---------- 5. 摘要与正文 ---------- */
cases.push(['摘要带整段原文（不再只取首句）、缺标题时兜底', () => {
  const two = '第一句完成了。第二句细节。'
  assert.equal(watch.summarizeCompletion(two), two, '通知要带得下全文，秘书才谈得上完整转述')
  const bare = watch.buildCompletionNotice({ sessionId: 'cu-1', title: '', summary: '' })
  assert.ok(bare.includes('[[session:cu-1|电脑上的任务]]'))
  assert.match(bare, /没有留下文字结果/)
  assert.match(bare, /完整展示/, '正文要求完整展示这条结果')
  assert.ok(!bare.includes('一两句'), `正文里不该再有「一两句」限制：${bare}`)
  assert.match(bare, /动手类工具已禁用/, '工具禁用约束句保留（与硬闸同口径）')
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
console.log(`PASS ${cases.length}/${cases.length} secretary-notice-turn`)
