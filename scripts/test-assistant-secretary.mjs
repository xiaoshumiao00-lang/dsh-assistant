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
cases.push(['工具闸：默认拒绝执行/本机读取，放行只读联网、汇总与派活', async () => {
  for (const name of ['write', 'edit', 'pwsh', 'bash', 'computer_use', 'code_agent', 'subagent', 'subagent_fork', 'send_message', 'mcp__desktop__click', 'read', 'grep', 'glob', 'read_image', 'some_future_tool']) {
    assert.equal(surface.secretaryToolDenied(name), true, `${name} 应拒绝`)
  }
  for (const name of ['ask_user_question', 'mnemon_recall', 'session_search', 'secretary_dispatch', 'web_search', 'web_fetch']) {
    assert.equal(surface.secretaryToolDenied(name), false, `${name} 应放行`)
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
