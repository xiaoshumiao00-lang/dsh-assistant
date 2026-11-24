/**
 * 个人秘书固定会话：宿主 id 持久化 + 只读工具闸的纯契约测试。
 * 不启动 DSH，不碰真实 profile。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const assistant = await import('../lib/index.js')
const surface = assistant.assistantSecretaryTestSurface

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
  req.url = surface.ASSISTANT_SECRETARY_ROUTE
  return req
}
function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? null }
  out.end = (payload) => { out.body = String(payload ?? '') }
  return out
}

const root = mkdtempSync(join(tmpdir(), 'assistant-secretary-'))
const server = fakeServer()
const hooks = new Map()
const ctx = {
  webServer: server,
  get(name) {
    if (name === 'profileContext') return { dir: root }
    return undefined
  },
  on(name, fn) {
    hooks.set(name, fn)
    return () => { if (hooks.get(name) === fn) hooks.delete(name) }
  },
}
let preTool = null
const dispose = surface.registerAssistantSecretary(ctx)
preTool = hooks.get('tools/pre-execute')
assert.equal(typeof preTool, 'function', '没注册 tools/pre-execute')
const route = server.exact.get(surface.ASSISTANT_SECRETARY_ROUTE)
assert.ok(route, '没有注册 /api/assistant/secretary')

const call = async (method, payload) => {
  const res = fakeRes()
  await route.handler(fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload)), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.status, json }
}

const cases = []
cases.push(['插件 inject 声明 tools：宿主才会在秘书回合注册派活工具', async () => {
  assert.ok(Array.isArray(assistant.inject), '插件必须导出 inject')
  assert.ok(assistant.inject.includes('tools'), 'inject 缺 tools 时 ctx.tools 会抛 without inject，派活工具整块注册不上')
  assert.ok(assistant.inject.includes('webServer'))
}])
cases.push(['GET 初始为空', async () => {
  const r = await call('GET')
  assert.equal(r.status, 200)
  assert.equal(r.json.sessionId, null)
  assert.equal(r.json.dispatchPolicy, 'default-computer-use-v2')
}])
cases.push(['非法 sessionId 拒绝且不落盘', async () => {
  const r = await call('POST', { sessionId: '../escape' })
  assert.equal(r.status, 400)
  assert.equal(existsSync(join(root, 'dsh-assistant-secretary.json')), false)
}])
cases.push(['POST 原子持久化并回读', async () => {
  const r = await call('POST', { sessionId: 'session-11111111-2222-3333-4444-555555555555' })
  assert.equal(r.status, 200)
  assert.equal(r.json.sessionId, 'session-11111111-2222-3333-4444-555555555555')
  const file = join(root, 'dsh-assistant-secretary.json')
  assert.ok(existsSync(file))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessionId, r.json.sessionId)
  const g = await call('GET')
  assert.equal(g.json.sessionId, r.json.sessionId)
}])
cases.push(['工具闸：只禁动手类（写/编辑/补丁/终端/屏幕/子代理），纯读与目标类一律放行', async () => {
  for (const name of ['write', 'edit', 'apply_patch', 'pwsh', 'bash', 'terminal', 'computer_use', 'code_agent', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'mcp__desktop__click', 'some_future_tool']) {
    assert.equal(surface.secretaryToolDenied(name), true, `${name} 是动手类，应拒绝`)
  }
  // 2026-11-23 用户实报：读类与 goal 类曾被误拦（读不到 CU 报告、长任务立不了 goal）。
  for (const name of ['read', 'glob', 'grep', 'read_image', 'create_goal', 'update_goal', 'get_goal']) {
    assert.equal(surface.secretaryToolDenied(name), false, `${name} 不写本机文件/不动屏幕，不该被只读闸拦`)
  }
  for (const name of ['ask_user_question', 'present', 'mnemon_recall', 'session_search', 'secretary_dispatch', 'web_search', 'web_fetch']) {
    assert.equal(surface.secretaryToolDenied(name), false, `${name} 应放行`)
  }
}])
cases.push(['读类与 goal 类真的穿过 tools/pre-execute（不只是谓词层放行）', async () => {
  const session = { id: 'session-11111111-2222-3333-4444-555555555555' }
  for (const name of ['read', 'glob', 'grep', 'create_goal', 'update_goal', 'get_goal']) {
    let allowed = false
    const result = await preTool({ name, agent: { session } }, async () => { allowed = true; return { kind: 'allow' } })
    assert.equal(allowed, true, `${name} 在秘书会话里必须能跑到，不该被只读闸拒绝`)
    assert.equal(result.kind, 'allow')
  }
  for (const name of ['write', 'edit', 'apply_patch', 'pwsh', 'bash', 'computer_use', 'subagent']) {
    let allowed = false
    const result = await preTool({ name, agent: { session } }, async () => { allowed = true; return { kind: 'allow' } })
    assert.equal(allowed, false, `${name} 在秘书会话里必须仍被拒绝`)
    assert.equal(result.kind, 'deny')
    assert.match(result.reason, /个人秘书只读闸已拒绝/)
  }
}])
cases.push(['用户原话「明天天气」：只读联网工具真的能跑到，不再被只读闸拦死', async () => {
  for (const name of ['web_search', 'web_fetch']) {
    let allowed = false
    const result = await preTool({
      name,
      agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555' } },
    }, async () => { allowed = true; return { kind: 'allow' } })
    assert.equal(allowed, true, `${name} 是只读查询，不该被只读闸拦住`)
    assert.equal(result.kind, 'allow')
  }
}])
cases.push(['只读工具闸显式放行派活：secretary_dispatch 可建/续独立 CU 会话', async () => {
  let allowed = false
  const result = await preTool({
    name: 'secretary_dispatch',
    agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555' } },
  }, async () => { allowed = true; return { kind: 'allow' } })
  assert.equal(allowed, true, '只读必须限制写文件/终端，不许误拦建会话与派活')
  assert.equal(result.kind, 'allow')
}])
cases.push(['工具闸只对固定秘书会话生效', async () => {
  assert.equal(typeof preTool, 'function')
  const denied = await preTool({ name: 'write', agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555' } } }, async () => ({ kind: 'allow' }))
  assert.equal(denied.kind, 'deny')
  let allowed = false
  const other = await preTool({ name: 'write', agent: { session: { id: 'session-other' } } }, async () => { allowed = true; return { kind: 'allow' } })
  assert.equal(allowed, true)
  assert.equal(other.kind, 'allow')
}])
cases.push(['重新注册会从文件恢复固定 id', async () => {
  dispose()
  const server2 = fakeServer()
  let ctx2Pre = null
  const ctx2 = {
    webServer: server2,
    get(name) { return name === 'profileContext' ? { dir: root } : undefined },
    on(_name, fn) { ctx2Pre = fn; return () => { ctx2Pre = null } },
  }
  const dispose2 = surface.registerAssistantSecretary(ctx2)
  const route2 = server2.exact.get(surface.ASSISTANT_SECRETARY_ROUTE)
  const res = fakeRes()
  await route2.handler(fakeReq('GET'), res)
  assert.equal(JSON.parse(res.body).sessionId, 'session-11111111-2222-3333-4444-555555555555')
  assert.equal(typeof ctx2Pre, 'function')
  dispose2()
}])
cases.push(['DELETE 清空并删除文件', async () => {
  const d = await call('DELETE')
  assert.equal(d.status, 200)
  assert.equal(d.json.sessionId, null)
  assert.equal(existsSync(join(root, 'dsh-assistant-secretary.json')), false)
  const g = await call('GET')
  assert.equal(g.json.sessionId, null)
}])
const callVerify = async (method, urlSuffix) => {
  const res = fakeRes()
  const req = fakeReq(method, undefined)
  req.url = `${surface.ASSISTANT_SECRETARY_ROUTE}${urlSuffix}`
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.status, json }
}

cases.push(['普通 GET 不带 exists（首屏不该去翻两千多行会话表）', async () => {
  const g = await callVerify('GET', '')
  assert.equal(g.status, 200)
  assert.equal('exists' in g.json, false, `普通 GET 不该带 exists：${JSON.stringify(g.json)}`)
}])
cases.push(['?verify=1 但没有固定会话 → exists=false（不会静默说「在」）', async () => {
  const r = await callVerify('GET', '?verify=1')
  assert.equal(r.json.sessionId, null)
  assert.equal(r.json.exists, false)
}])
cases.push(['?verify=1 有固定会话、宿主两路都问不出 → exists=null（客户端按「不新建」处理）', async () => {
  await call('POST', { sessionId: 'session-22222222-2222-3222-4444-555555555555' })
  const r = await callVerify('GET', '?verify=1')
  assert.equal(r.json.sessionId, 'session-22222222-2222-3222-4444-555555555555')
  assert.equal(r.json.exists, null, `这份 ctx 没有会话表：必须回 null，实际=${JSON.stringify(r.json)}`)
  await call('DELETE')
}])
cases.push(['?verify=1 用宿主活会话表回答存在与否（实测根因的权威判定）', async () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'assistant-secretary-exists-'))
  const server = fakeServer()
  const ctx = {
    webServer: server,
    get(name) { return name === 'profileContext' ? { dir: sessionRoot } : undefined },
    sessions: { list: () => [{ id: 'session-alive-1', header: { id: 'session-alive-1' } }] },
    on() { return () => void 0 },
  }
  const disposeExtra = surface.registerAssistantSecretary(ctx)
  const extraRoute = server.exact.get(surface.ASSISTANT_SECRETARY_ROUTE)
  const call = async (method, payload, urlSuffix = '') => {
    const res = fakeRes()
    const req = fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload))
    req.url = `${surface.ASSISTANT_SECRETARY_ROUTE}${urlSuffix}`
    await extraRoute.handler(req, res)
    return JSON.parse(res.body)
  }
  try {
    await call('POST', { sessionId: 'session-alive-1' }, '')
    const hit = await call('GET', undefined, '?verify=1')
    assert.equal(hit.exists, true, '活会话表里有这条 → 必须回 true')
    await call('POST', { sessionId: 'session-33044545-4737-4e86-960d-43f57b357dea' }, '')
    const miss = await call('GET', undefined, '?verify=1')
    assert.equal(miss.exists, false, 'state 指向已消失的会话（2026-11-21 实测形状）→ 必须回 false')
  } finally {
    try { disposeExtra() } catch {}
    rmSync(sessionRoot, { recursive: true, force: true })
  }
}])
cases.push(['?verify=1 只剩持久化清单（ctx 没给 sessions.list）也能回答', async () => {
  const queryRoot = mkdtempSync(join(tmpdir(), 'assistant-secretary-query-'))
  const server = fakeServer()
  const ctx = {
    webServer: server,
    get(name) {
      if (name === 'profileContext') return { dir: queryRoot }
      if (name === 'sessionQuery') {
        return { listSessions: async () => [{ header: { id: 'session-from-query' } }] }
      }
      return undefined
    },
    on() { return () => void 0 },
  }
  const disposeExtra = surface.registerAssistantSecretary(ctx)
  const routeExtra = server.exact.get(surface.ASSISTANT_SECRETARY_ROUTE)
  const call = async (method, payload, urlSuffix = '') => {
    const res = fakeRes()
    const req = fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload))
    req.url = `${surface.ASSISTANT_SECRETARY_ROUTE}${urlSuffix}`
    await routeExtra.handler(req, res)
    return JSON.parse(res.body)
  }
  try {
    await call('POST', { sessionId: 'session-from-query' }, '')
    const hit = await call('GET', undefined, '?verify=1')
    assert.equal(hit.exists, true, '持久化清单里有这条 → 必须回 true')
    await call('POST', { sessionId: 'session-not-in-list' }, '')
    const miss = await call('GET', undefined, '?verify=1')
    assert.equal(miss.exists, false, '清单里没有 → 必须回 false（客户端据此重建）')
  } finally {
    try { disposeExtra() } catch {}
    rmSync(queryRoot, { recursive: true, force: true })
  }
}])
cases.push(['坏文件/坏字段按空处理', async () => {
  assert.equal(surface.normalizeSecretaryState(null), null)
  assert.equal(surface.normalizeSecretaryState({ sessionId: '' }), null)
  assert.equal(surface.normalizeSecretaryState({ sessionId: 'a'.repeat(257) }), null)
  assert.equal(surface.normalizeSecretaryState({ sessionId: 'session-ok' }).sessionId, 'session-ok')
}])
cases.push(['parseSecretaryRequestQuery：verify 标记 / 候选 id / 非法 id 拒收', async () => {
  const parse = surface.parseSecretaryRequestQuery
  assert.deepEqual(parse('/api/assistant/secretary'), { wantsVerify: false, requestedId: '' })
  assert.deepEqual(parse('/api/assistant/secretary?verify=1'), { wantsVerify: true, requestedId: '' })
  assert.deepEqual(parse('/api/assistant/secretary?verify=1&sessionId=session-abc-1'), { wantsVerify: true, requestedId: 'session-abc-1' })
  assert.deepEqual(parse('/api/assistant/secretary?verify=1&sessionId=..%2Fescape'), { wantsVerify: true, requestedId: '' }, '非法 id 必须拒收')
  assert.deepEqual(parse('/api/assistant/secretary?sessionId=session-abc-1'), { wantsVerify: false, requestedId: 'session-abc-1' })
}])
cases.push(['?verify=1&sessionId=<候选>：不问 state 当前值，直接问候选（重建预确认用）', async () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'assistant-secretary-queried-'))
  const server = fakeServer()
  const ctx = {
    webServer: server,
    get(name) { return name === 'profileContext' ? { dir: sessionRoot } : undefined },
    sessions: { list: () => [{ id: 'session-alive-1', header: { id: 'session-alive-1' } }] },
    on() { return () => void 0 },
  }
  const disposeExtra = surface.registerAssistantSecretary(ctx)
  const extraRoute = server.exact.get(surface.ASSISTANT_SECRETARY_ROUTE)
  const call = async (method, payload, urlSuffix = '') => {
    const res = fakeRes()
    const req = fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload))
    req.url = `${surface.ASSISTANT_SECRETARY_ROUTE}${urlSuffix}`
    await extraRoute.handler(req, res)
    return JSON.parse(res.body)
  }
  try {
    // state 故意指向另一条；候选 id 的存在性必须独立回答
    await call('POST', { sessionId: 'session-state-other' }, '')
    const hit = await call('GET', undefined, '?verify=1&sessionId=session-alive-1')
    assert.equal(hit.queried, 'session-alive-1')
    assert.equal(hit.exists, true, '候选在活会话表里 → true（不管 state 指向谁）')
    assert.equal(hit.sessionId, 'session-state-other', 'state 当前值原样带回')
    const miss = await call('GET', undefined, '?verify=1&sessionId=session-candidate-dead')
    assert.equal(miss.queried, 'session-candidate-dead')
    assert.equal(miss.exists, false, '候选不在表里 → false（客户端据此不写 state）')
  } finally {
    try { disposeExtra() } catch {}
    rmSync(sessionRoot, { recursive: true, force: true })
  }
}])
cases.push(['POST 同一个 id 去抖：不重写盘、不重刷 updatedAt（多客户端不互相覆盖）', async () => {
  const dupRoot = mkdtempSync(join(tmpdir(), 'assistant-secretary-dup-'))
  const server = fakeServer()
  const ctx = {
    webServer: server,
    get(name) { return name === 'profileContext' ? { dir: dupRoot } : undefined },
    on() { return () => void 0 },
  }
  const disposeExtra = surface.registerAssistantSecretary(ctx)
  const extraRoute = server.exact.get(surface.ASSISTANT_SECRETARY_ROUTE)
  const call = async (method, payload) => {
    const res = fakeRes()
    const req = fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload))
    await extraRoute.handler(req, res)
    return JSON.parse(res.body)
  }
  try {
    const first = await call('POST', { sessionId: 'session-dup-1' })
    assert.equal(first.unchanged, undefined)
    const file = join(dupRoot, 'dsh-assistant-secretary.json')
    const bytesBefore = readFileSync(file, 'utf8')
    const second = await call('POST', { sessionId: 'session-dup-1' })
    assert.equal(second.ok, true)
    assert.equal(second.unchanged, true, '同 id 重复 POST 必须回 unchanged=true')
    assert.equal(second.updatedAt, first.updatedAt, 'updatedAt 不许被重刷')
    assert.equal(readFileSync(file, 'utf8'), bytesBefore, '文件内容不许被重写')
    // 换一个 id 仍然正常写
    const third = await call('POST', { sessionId: 'session-dup-2' })
    assert.equal(third.sessionId, 'session-dup-2')
    assert.notEqual(third.unchanged, true)
  } finally {
    try { disposeExtra() } catch {}
    rmSync(dupRoot, { recursive: true, force: true })
  }
}])

cases.push(['语音输入提示段：三行内语义齐全，1785 挂在派活分层（1790）之前', async () => {
  const voiceRoot = mkdtempSync(join(tmpdir(), 'assistant-secretary-voice-'))
  const server = fakeServer()
  const sections = []
  const ctx = {
    webServer: server,
    get(name) {
      if (name === 'profileContext') return { dir: voiceRoot }
      if (name === 'systemPrompt') {
        return {
          section(definition) {
            sections.push(definition)
            return () => {}
          },
        }
      }
      return undefined
    },
    on() { return () => void 0 },
  }
  const disposeExtra = surface.registerAssistantSecretary(ctx)
  const routeExtra = server.exact.get(surface.ASSISTANT_SECRETARY_ROUTE)
  const call = async (method, payload) => {
    const res = fakeRes()
    const req = fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload))
    await routeExtra.handler(req, res)
    return JSON.parse(res.body)
  }
  try {
    await call('POST', { sessionId: 'session-voice-input-1' })
    const text = surface.SECRETARY_VOICE_INPUT_TEXT
    assert.equal(typeof text, 'string')
    const lines = text.split('\n')
    assert.ok(lines.length <= 3, `语音输入小节最多三行，实际 ${lines.length} 行`)
    for (const must of [
      '语音', '同音字', '相近音', '断句', '缺标点',
      '按语义理解', '同音纠正在你内部完成',
      '不许悄悄改写用户原话', '不许因一个错别字判任务失败或反问',
      '只有歧义确实影响执行时，才用最短一句确认',
      'secretary_dispatch', 'task 字段照抄用户原话', '不得替换关键词',
      '用户卡', '显示原文', '不显示纠正版本', '附件', '不改写',
      '改读了某个词', '说清改了哪个词',
    ]) {
      assert.ok(text.includes(must), `语音输入小节缺语义「${must}」：\n${text}`)
    }
    assert.equal(surface.SECRETARY_SPEECH_STYLE_TEXT.includes('语音输入'), false, '语音输入段必须独立，不许并进朗读规范')

    const speech = sections.find((item) => item.name === 'assistant:secretary-speech-style')
    const voice = sections.find((item) => item.name === 'assistant:secretary-voice-input')
    assert.ok(speech, '朗读规范段（1780）还在')
    assert.ok(voice, '没注册 assistant:secretary-voice-input 段')
    assert.equal(voice.order, 1785)
    assert.ok(voice.order > 1780 && voice.order < 1790, `语音段必须在朗读（1780）之后、派活分层（1790）之前，实际 ${voice.order}`)
    assert.equal(voice.text({ agent: { session: { id: 'session-voice-input-1' } } }), text)
    assert.equal(voice.text({ agent: { session: { id: 'session-other' } } }), '', '其它会话一个字都不多')
    assert.equal(speech.text({ agent: { session: { id: 'session-voice-input-1' } } }), surface.SECRETARY_SPEECH_STYLE_TEXT)
    // 每轮上下文字符数的增量只有这一小节：朗读规范原文一字未动，语音段独立成段。
    assert.equal(
      surface.SECRETARY_SPEECH_STYLE_TEXT.length + text.length,
      speech.text({ agent: { session: { id: 'session-voice-input-1' } } }).length + voice.text({ agent: { session: { id: 'session-voice-input-1' } } }).length,
    )
    assert.ok(text.length < 400, `语音输入小节本身要短（实际 ${text.length} 字），否则每轮上下文白涨`)
  } finally {
    try { disposeExtra() } catch {}
    rmSync(voiceRoot, { recursive: true, force: true })
  }
}])

cases.push(['引用登记段（第 4 项）：路由形状、落盘、吃掉一轮就收、通知轮不吃引用、1783 排在派活分层 1790 之前', async () => {
  const quoteRoot = mkdtempSync(join(tmpdir(), 'assistant-secretary-quote-'))
  const server = fakeServer()
  const sections = []
  const hooks = new Map()
  const ctx = {
    webServer: server,
    get(name) {
      if (name === 'profileContext') return { dir: quoteRoot }
      if (name === 'systemPrompt') return { section(definition) { sections.push(definition); return () => {} } }
      return undefined
    },
    on(name, fn) { hooks.set(name, fn); return () => { if (hooks.get(name) === fn) hooks.delete(name) } },
  }
  const disposeExtra = surface.registerAssistantSecretary(ctx)
  // 先固定秘书会话：引用段只在「当前那条固定会话」上注入，state 没落定前 activeSessionId 是空串
  const secretRoute = server.exact.get(surface.ASSISTANT_SECRETARY_ROUTE)
  {
    const res = fakeRes()
    await secretRoute.handler(fakeReq('POST', JSON.stringify({ sessionId: 'session-quote-1' })), res)
  }
  const quoteRoute = server.exact.get(surface.ASSISTANT_SECRETARY_QUOTE_ROUTE)
  assert.ok(quoteRoute, '没注册 /api/assistant/secretary-quote')
  const callQuote = async (method, payload, urlSuffix = '') => {
    const res = fakeRes()
    const req = fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload))
    req.url = `${surface.ASSISTANT_SECRETARY_QUOTE_ROUTE}${urlSuffix}`
    await quoteRoute.handler(req, res)
    let json = null
    try { json = JSON.parse(res.body) } catch { json = null }
    return { status: res.status, json, headers: res.headers ?? null, raw: res.body }
  }
  const readQuoteFile = () => {
    const raw = readFileSync(join(quoteRoot, 'dsh-assistant-secretary-quote.json'), 'utf8')
    return JSON.parse(raw)
  }
  const sessionEvent = hooks.get('session/event')
  const preStep = hooks.get('agent/pre-step')
  assert.equal(typeof sessionEvent, 'function', '没注册 session/event')
  assert.equal(typeof preStep, 'function', '没注册 agent/pre-step')
  const session = { id: 'session-quote-1' }
  try {
    // 空会话：GET 回 quote:null（客户端拿不到引用就不许凭空造话）
    const empty = await callQuote('GET', undefined, '?sessionId=session-quote-1')
    assert.equal(empty.status, 200)
    assert.equal(empty.json.quote, null, '没有引用时必须回 null')
    assert.equal(empty.json.ttlMs, surface.QUOTE_TTL_MS)

    // 标上引用
    const marked = await callQuote('POST', {
      sessionId: 'session-quote-1',
      mark: 'quote',
      cardKey: 'assistant:turn:77',
      kind: 'assistant',
      turnNo: '77',
      preview: '第 4 项那条汇报正文'.repeat(80),
      refSessionIds: ['session-cu-1', 'session-cu-1', '非法 id 带空格'],
    })
    assert.equal(marked.status, 200)
    assert.equal(marked.json.ok, true)
    assert.equal(marked.json.quote.cardKey, 'assistant:turn:77')
    assert.equal(marked.json.quote.kind, 'assistant')
    assert.equal(marked.json.quote.turnNo, '77')
    assert.ok(marked.json.quote.preview.length <= surface.QUOTE_PREVIEW_MAX_CHARS, '摘录必须截到上限字符内')
    assert.ok(marked.json.quote.preview.endsWith('…'), '截断要有省略号')
    assert.equal(marked.json.quote.refSessionIds.length, 1, '非法 id 与重复 id 都要被判据剔掉')
    assert.equal(marked.json.quote.refSessionIds[0], 'session-cu-1')

    // 同一张卡 + 同一个 updatedAt 再标一次：unchanged 不产生新时间戳、不重复落盘（判据是 cardKey+updatedAt）
    const again = await callQuote('POST', { sessionId: 'session-quote-1', mark: 'quote', cardKey: 'assistant:turn:77', kind: 'assistant', turnNo: '77', preview: '同一张卡', updatedAt: marked.json.quote.updatedAt })
    assert.equal(again.json.unchanged, true, '同一张卡同一 updatedAt 重复标引用必须算 unchanged')
    const later = await callQuote('POST', { sessionId: 'session-quote-1', mark: 'quote', cardKey: 'assistant:turn:77', kind: 'assistant', turnNo: '77', preview: '同一张卡', updatedAt: marked.json.quote.updatedAt + 1 })
    assert.equal(later.json.unchanged, false, '同一张卡换了 updatedAt 要算新的引用（覆盖上一条）')
    assert.equal(typeof marked.json.quote.updatedAt, 'number', '引用记录的时间戳是 epoch 毫秒')
    // 重标一次带上引用卡里的会话 id：注入段必须把它说清
    await callQuote('POST', { sessionId: 'session-quote-1', mark: 'quote', cardKey: 'assistant:turn:77', kind: 'assistant', turnNo: '77', preview: '第 4 项那条汇报正文', refSessionIds: ['session-cu-1'], updatedAt: marked.json.quote.updatedAt + 2 })

    const stored = readQuoteFile()
    assert.equal(stored.version, 1)
    assert.equal(typeof stored.quoteBySession, 'object', '落盘必须按会话分组（sessionId → 引用）')
    assert.equal(stored.quoteBySession['session-quote-1'].cardKey, 'assistant:turn:77')
    assert.equal(typeof stored.updatedAt, 'string', '落盘文件要带更新时间戳（ISO 串）')

    // GET 拿回引用
    const fetched = await callQuote('GET', undefined, '?sessionId=session-quote-1')
    assert.equal(fetched.json.quote.cardKey, 'assistant:turn:77')

    // 提示段：只有这条会话有引用时才注入，别会话一个字都不多
    const quoteSection = sections.find((item) => item.name === 'assistant:secretary-card-quote')
    assert.ok(quoteSection, '没注册 assistant:secretary-card-quote 段')
    assert.equal(quoteSection.order, 1783, `引用段必须排在语音输入(1785)之后、派活分层(1790)之前，实际 ${quoteSection.order}`)
    assert.ok(quoteSection.order > 1700 && quoteSection.order < 1790)
    const injected = quoteSection.text({ agent: { session } })
    assert.ok(injected.includes('assistant:turn:77'), '注入必须带卡片定位（cardKey）')
    assert.ok(injected.includes('kind=assistant') && injected.includes('轮次 77'), '注入要写清 kind 与轮次')
    assert.ok(injected.includes('session-cu-1'), '注入要带那张卡引用的会话 id')
    assert.ok(injected.includes('引用登记只说明'), '注入必须说明「引用不等于派活/不改变工具规则」')
    assert.ok(injected.includes('不是完整汇报'), '注入要说清这只是摘录')
    assert.equal(quoteSection.text({ agent: { session: { id: 'session-other-9' } } }), '', '别的会话不许沾到这条引用')
    assert.equal(quoteSection.text({ agent: { session: { id: 'session-quote-1' } } }), injected)

    // 通知轮（插件自己送进来的系统通知）不许吃掉引用：判据是「这条消息 id 是插件登记过的通知 id」
    const noticeMessageId = 'notice-message-1'
    surface.registerNoticeMessageId(noticeMessageId)
    assert.equal(surface.isNoticeMessageId(noticeMessageId), true, '通知 id 必须登记得上（否则本轮会被当真实用户消息吃掉引用）')
    const noticeMessage = { id: noticeMessageId, text: '（系统通知，不是用户说的话）\n\n卡片引用：无' }
    await preStep({ agent: { session }, messages: [noticeMessage] }, async () => null)
    sessionEvent(session, { type: 'turn/end' })
    const afterNoticeTurn = await callQuote('GET', undefined, '?sessionId=session-quote-1')
    assert.equal(afterNoticeTurn.json.quote !== null, true, '通知轮不许把引用收掉')

    // 真实用户消息那轮：pre-step 标记吃掉 → turn/end 收掉引用
    await preStep({ agent: { session }, messages: [{ id: 'user-message-1', text: '接着那张卡说' }] }, async () => null)
    sessionEvent(session, { type: 'turn/end' })
    const afterConsumed = await callQuote('GET', undefined, '?sessionId=session-quote-1')
    assert.equal(afterConsumed.json.quote, null, '引用只能被一条真实用户消息吃掉（本轮 turn/end 收掉）')

    // 清引用：mark=clear 与 DELETE 都回到 null
    await callQuote('POST', { sessionId: 'session-quote-1', mark: 'quote', cardKey: 'user:abc', kind: 'user', turnNo: '', preview: '用户消息卡' })
    const cleared = await callQuote('POST', { sessionId: 'session-quote-1', mark: 'clear' })
    assert.equal(cleared.json.quote, null)
    await callQuote('POST', { sessionId: 'session-quote-1', mark: 'quote', cardKey: 'user:def', kind: 'user', turnNo: '', preview: '再来一次' })
    const deleted = await callQuote('DELETE', undefined, '?sessionId=session-quote-1')
    assert.equal(deleted.status, 200)
    assert.equal(deleted.json.cleared, true)
    assert.equal((await callQuote('GET', undefined, '?sessionId=session-quote-1')).json.quote, null)

    // 非法输入全部 400
    const badSession = await callQuote('POST', { sessionId: '', mark: 'quote', cardKey: 'assistant:turn:1' })
    assert.equal(badSession.status, 400)
    assert.equal(badSession.json.error, 'invalid-session-id')
    const badMark = await callQuote('POST', { sessionId: 'session-quote-1', mark: 'nonsense', cardKey: 'assistant:turn:1' })
    assert.equal(badMark.status, 400)
    assert.equal(badMark.json.error, 'invalid-mark')
    const badKey = await callQuote('POST', { sessionId: 'session-quote-1', mark: 'quote', cardKey: '', kind: 'assistant' })
    assert.equal(badKey.status, 400)
    assert.equal(badKey.json.error, 'invalid-quote', '整条引用记录形状不对就一律 invalid-quote（缺 cardKey 也是这一支）')
    const badKind = await callQuote('POST', { sessionId: 'session-quote-1', mark: 'quote', cardKey: 'assistant:turn:2', kind: '乱写' })
    assert.equal(badKind.status, 400)
    assert.equal(badKind.json.error, 'invalid-quote', 'kind 不在三种卡种里也判 invalid-quote')
    const bareGet = await callQuote('GET', undefined, '')
    assert.equal(bareGet.status, 200, '不带 sessionId 的 GET 按当前固定会话答')
    assert.equal(bareGet.json.sessionId, 'session-quote-1')
    const junkGet = await callQuote('GET', undefined, '?sessionId=%20bad')
    // 查询串里塞非法字符：parseSecretaryRequestQuery 把脏部分丢掉 → 剩下「bad」当会话 id 答（宿主只认它自己那套 id 形状）
    assert.equal(junkGet.status, 200, '脏 sessionId 解析后当成另一条会话答，不许 500')
    assert.equal(junkGet.json.sessionId, 'bad')
    assert.equal(junkGet.json.quote, null, '另一条会话没有引用时必须回 null（不许把当前会话的引用串给别的会话）')
    const badPatch = await callQuote('PATCH', { sessionId: 'session-quote-1' })
    assert.equal(badPatch.status, 405)
    assert.equal(badPatch.headers.allow, 'GET, HEAD, POST, PUT, DELETE', '405 要带 allow 头（跟既有秘书路由同一形状）')
    assert.equal(badPatch.raw, '', '405 不带 JSON 正文（既有秘书路由就是这么回的）')

    // 没有固定会话（新 profile、从没 POST 过秘书路由）时：GET/DELETE 才回 400 invalid-session-id
    const noStateRoot = mkdtempSync(join(tmpdir(), 'assistant-secretary-quote-nostate-'))
    const noStateServer = fakeServer()
    const disposeNoState = surface.registerAssistantSecretary({
      webServer: noStateServer,
      get(name) { return name === 'profileContext' ? { dir: noStateRoot } : undefined },
      on() { return () => void 0 },
    })
    try {
      const noStateRoute = noStateServer.exact.get(surface.ASSISTANT_SECRETARY_QUOTE_ROUTE)
      assert.ok(noStateRoute, '没固定会话时也要注册引用路由')
      for (const method of ['GET', 'DELETE']) {
        const res = fakeRes()
        const req = fakeReq(method, undefined)
        req.url = surface.ASSISTANT_SECRETARY_QUOTE_ROUTE
        await noStateRoute.handler(req, res)
        const json = JSON.parse(res.body)
        assert.equal(res.status, 400, `${method} 在没有固定会话时必须 400`)
        assert.equal(json.error, 'invalid-session-id', `${method} 在没有固定会话时必须报 invalid-session-id`)
      }
      const postRes = fakeRes()
      const postReq = fakeReq('POST', JSON.stringify({ sessionId: '', mark: 'quote', cardKey: 'assistant:turn:1', kind: 'assistant' }))
      postReq.url = surface.ASSISTANT_SECRETARY_QUOTE_ROUTE
      await noStateRoute.handler(postReq, postRes)
      assert.equal(postRes.status, 400)
      assert.equal(JSON.parse(postRes.body).error, 'invalid-session-id')
    } finally {
      try { disposeNoState() } catch {}
      rmSync(noStateRoot, { recursive: true, force: true })
    }

    // TTL 与判据层（引用记录里的 updatedAt 是 epoch 毫秒，不是 ISO 串）
    const staleAt = Date.now() - surface.QUOTE_TTL_MS - 1000
    const old = { cardKey: 'assistant:turn:5', kind: 'assistant', turnNo: '5', preview: 'old', refSessionIds: [], updatedAt: staleAt }
    assert.equal(surface.quoteAlive(old, Date.now()), false, '超过 TTL 的引用必须判为已失效')
    assert.equal(surface.quoteAlive({ ...old, updatedAt: Date.now() }, Date.now()), true, '刚标的引用必须还活着')
    assert.equal(surface.normalizeQuoteRecord({ cardKey: 'bogus' }), null, '缺 kind 的记录要整条丢（宁可不注入）')
    assert.equal(surface.normalizeQuoteRecord({ cardKey: 'assistant:turn:5', kind: '不是卡种' }), null, 'kind 不在 assistant/user/notice 三种里的一律丢')
    assert.equal(surface.normalizeQuoteCardKey('带 空 格'), '', 'cardKey 判据不许放过带空格的值')
    assert.deepEqual(surface.normalizeQuoteSessionIds(['ok-1', '带 空格', 'ok-1', 'x'.repeat(121)]), ['ok-1'], '会话 id 坏值要丢、要按序去重')
    assert.deepEqual(surface.normalizeSecretaryQuoteState({ 'session-quote-1': old }), {}, '过期记录不进内存')
    assert.deepEqual(surface.normalizeSecretaryQuoteState({ '带 空格': { cardKey: 'assistant:turn:5', kind: 'assistant', updatedAt: Date.now() } }), {}, '坏 sessionId 不进内存')
    assert.equal(surface.secretaryQuoteInjectionText(null), '', '没有引用时提示文本必须是空串')
    const injectedText = surface.secretaryQuoteInjectionText({ cardKey: 'user:abc', kind: 'user', turnNo: '', preview: '用户原话', refSessionIds: ['session-cu-9'] })
    assert.ok(injectedText.includes('kind=user') && injectedText.includes('轮次 未知'), '没有轮次的用户卡要说清轮次未知')
    assert.ok(injectedText.includes('用户消息卡'), 'kind 要有中文标签')
    assert.ok(injectedText.includes('session-cu-9') && injectedText.includes('secretary_dispatch kind=existing'), '引用带会话 id 时要把落项目目录的话说清')
  } finally {
    try { disposeExtra() } catch {}
    rmSync(quoteRoot, { recursive: true, force: true })
  }
}])

cases.push(['朗读规范补「不照抄、要整理」：先给结论、禁止整大段照抄 CU 回复、硬事实保留、先读完整再整理', () => {
  const text = surface.SECRETARY_SPEECH_STYLE_TEXT
  assert.match(text, /先给结论/)
  assert.match(text, /自己整理|整理成简短/)
  assert.match(text, /不许整大段原封不动照抄/)
  assert.match(text, /禁止照抄表格|禁止照抄表格与长路径/)
  assert.match(text, /文件名.*大小.*哈希.*数字.*提交号.*判据.*结论.*待办/)
  assert.match(text, /必须先拿到完整内容再整理/)
  assert.match(text, /不许只依据被裁的摘录作答/)
  assert.ok(!text.includes('原样转述'), '旧「原样转述」口径必须撤掉')
  // 原有的口语化与朗读规则一条都不许丢
  assert.match(text, /口语化短句/)
  assert.match(text, /不要用 markdown 符号、表格、列表符号/)
  assert.match(text, /\[\[session:会话id\|会话标题\]\]/)
}])

cases.push(['数字口径改档（2026-11-24 用户明确批准）：注入段数字一律阿拉伯写法、汉字数字示例清零', () => {
  const text = surface.SECRETARY_SPEECH_STYLE_TEXT
  assert.match(text, /数字一律保留阿拉伯写法/, '新口径必须在注入段里说清「数字一律保留阿拉伯写法」')
  assert.match(text, /27458/, '阿拉伯数字示例：字符数')
  assert.match(text, /49915/, '阿拉伯数字示例：token 数')
  assert.match(text, /2617×1215/, '阿拉伯数字示例：画布比例（带乘号那份）')
  assert.match(text, /9761427/, '阿拉伯数字示例：字节数')
  assert.match(text, /8 到 14 摄氏度/, '带单位的写法照阿拉伯数字 + 中文单位')
  assert.match(text, /禁止[^。]*汉字数字|不许[^。]*汉字数字/, '必须明确禁止把数字转写成汉字数字')
  for (const old of ['念得出来', '八点十二分', '三公里', '两公斤']) {
    assert.ok(!text.includes(old), `旧汉字数字口径「${old}」必须从注入段清零`)
  }
  // 这条只改数字口径，其它规则一个字都不许动
  assert.match(text, /口语化短句，先给结论/)
  assert.match(text, /不要用 markdown 符号、表格、列表符号、表情符号、代码块/)
  assert.match(text, /英文缩写尽量换成读得出的中文说法/)
  assert.match(text, /车次 G1545/)
  assert.ok(text.includes('二、') && text.includes('三、') && text.includes('四、'), '注入段仍是那 4 条（顺序与编号不许变）')
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
try { dispose() } catch {}
rmSync(root, { recursive: true, force: true })
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} assistant-secretary`)
