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
let preTool = null
const ctx = {
  webServer: server,
  get(name) {
    if (name === 'profileContext') return { dir: root }
    return undefined
  },
  on(name, fn) {
    if (name === 'tools/pre-execute') preTool = fn
    return () => { preTool = null }
  },
}

const dispose = surface.registerAssistantSecretary(ctx)
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
cases.push(['工具闸：默认拒绝执行/本机读取/联网，只放行汇总与派活', async () => {
  for (const name of ['write', 'edit', 'pwsh', 'bash', 'computer_use', 'code_agent', 'subagent', 'subagent_fork', 'send_message', 'mcp__desktop__click', 'read', 'grep', 'glob', 'read_image', 'web_search', 'web_fetch', 'some_future_tool']) {
    assert.equal(surface.secretaryToolDenied(name), true, `${name} 应拒绝`)
  }
  for (const name of ['ask_user_question', 'mnemon_recall', 'session_search', 'secretary_dispatch']) {
    assert.equal(surface.secretaryToolDenied(name), false, `${name} 应放行`)
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
  const web = await preTool({
    name: 'web_search',
    agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(web.kind, 'deny', '上网查证必须派 CU，不能由秘书自己搜完')
  assert.match(web.reason, /secretary_dispatch/)
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
cases.push(['坏文件/坏字段按空处理', async () => {
  assert.equal(surface.normalizeSecretaryState(null), null)
  assert.equal(surface.normalizeSecretaryState({ sessionId: '' }), null)
  assert.equal(surface.normalizeSecretaryState({ sessionId: 'a'.repeat(257) }), null)
  assert.equal(surface.normalizeSecretaryState({ sessionId: 'session-ok' }).sessionId, 'session-ok')
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
