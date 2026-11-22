/**
 * 本机配置写入链路契约测试（P0-1）：node scripts/test-assistant-config-write.mjs
 *
 * 验的是「设置 → 个人助手 → 本机配置」背后那条 `GET/POST /api/assistant/config`：
 *   - GET/POST 分明（旧版本 POST 会 200 下发查询结果，改动被静默丢弃）；
 *   - 白名单字段 + 类型校验（未知字段/错类型必须 400，且不落盘）；
 *   - 原子写（tmp → rename，不留 .tmp 残留）+ 写后立即回读（缓存失效）；
 *   - 文件坏了不覆盖；未管理的键原样保留。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const assistant = await import('../lib/index.js')
const surface = assistant.assistantConfigTestSurface

const tempHome = mkdtempSync(join(tmpdir(), 'assistant-config-write-'))
const assistantDir = join(tempHome, '.dsh', 'assistant')
const configFile = join(tempHome, 'config.json')
process.env.DSH_ASSISTANT_CONFIG = configFile
process.env.DSH_ASSISTANT_HOME = assistantDir
process.env.DSH_HOME = join(tempHome, '.dsh')

/** 与 scripts/test-web-routes.mjs 同款假 webServer（host 只要求 register 返回注销函数）。 */
function fakeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  return {
    exact,
    prefixes,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => { table.delete(route.path) }
    },
  }
}

function fakeReq(method, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  stream.method = method
  stream.url = '/api/assistant/config'
  return stream
}

function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? null }
  out.end = (payload) => { out.body = String(payload ?? '') }
  return out
}

const server = fakeWebServer()
const dispose = surface.registerAssistantConfigRoutes({
  webServer: server,
  get: () => undefined,
  logger: () => ({ info() {}, warn() {}, error() {} }),
})
const route = server.exact.get('/api/assistant/config')
assert.ok(route, '没有注册 /api/assistant/config')

const call = async (method, payload) => {
  const res = fakeRes()
  await route.handler(fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload)), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.status, headers: res.headers, json, raw: res.body }
}

const readFileJson = () => JSON.parse(readFileSync(configFile, 'utf8'))
const cases = []

cases.push(['GET 在没有配置文件时下发通用默认（不报错、不建文件）', async () => {
  const r = await call('GET')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.newProjectParentSource, 'desktop')
  assert.equal(r.json.allowAllLocalPaths, false)
  assert.equal(r.json.updateCheckEnabled, false)
  assert.equal(r.json.configSource, '')
  assert.equal(existsSync(configFile), false, '只读 GET 不该创建配置文件')
}])

cases.push(['POST 落盘 + GET 立刻读回（缓存失效，不是靠 mtime）', async () => {
  const projectParent = join(tempHome, 'projects')
  const skillRoot = join(tempHome, 'skills')
  const r = await call('POST', { newProjectParent: projectParent, skillRoot })
  assert.equal(r.status, 200)
  assert.deepEqual([...r.json.saved].sort(), ['newProjectParent', 'skillRoot'])
  assert.equal(r.json.newProjectParent, projectParent)
  assert.equal(r.json.skillRoot, skillRoot)
  assert.equal(r.json.skillRootSource, 'config')
  assert.equal(existsSync(configFile), true)

  const g = await call('GET')
  assert.equal(g.json.newProjectParent, projectParent, '写后 GET 必须读回新值')
  assert.equal(g.json.skillRoot, skillRoot)
  assert.equal(g.json.configSource, configFile)
}])

cases.push(['写盘是原子的：目录里不留 .tmp 残留', async () => {
  const leftovers = readdirSync(tempHome).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [], `残留临时文件：${leftovers.join(', ')}`)
}])

cases.push(['未知字段被拒（400 unknown-field），且不改动文件', async () => {
  const before = readFileSync(configFile, 'utf8')
  const r = await call('POST', { notAField: 1 })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'unknown-field')
  assert.equal(r.json.field, 'notAField')
  assert.equal(readFileSync(configFile, 'utf8'), before, '被拒的请求不该改文件')
}])

cases.push(['类型校验：路径必须绝对、开关必须是布尔、词表必须是数组', async () => {
  const relative = await call('POST', { newProjectParent: 'relative/dir' })
  assert.equal(relative.status, 400)
  assert.equal(relative.json.error, 'expected-absolute-path')
  assert.equal(relative.json.field, 'newProjectParent')

  const bool = await call('POST', { allowAllLocalPaths: 'yes' })
  assert.equal(bool.status, 400)
  assert.equal(bool.json.field, 'allowAllLocalPaths')

  const arr = await call('POST', { asrTerms: 'not-an-array' })
  assert.equal(arr.status, 400)
  assert.equal(arr.json.field, 'asrTerms')

  const term = await call('POST', { termEnvAllow: ['BAD NAME'] })
  assert.equal(term.status, 400)
  assert.equal(term.json.field, 'termEnvAllow')

  const empty = await call('POST', {})
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error, 'nothing-to-change')
}])

cases.push(['逃生开关要显式确认（allowAllLocalPaths 需 confirm:"ALLOW-ALL"）', async () => {
  const denied = await call('POST', { allowAllLocalPaths: true })
  assert.equal(denied.status, 400)
  assert.equal(denied.json.error, 'confirm-required')
  const allowed = await call('POST', { allowAllLocalPaths: true, confirm: 'ALLOW-ALL' })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.json.allowAllLocalPaths, true)
  const g = await call('GET')
  assert.equal(g.json.allowAllLocalPaths, true)
  // 关回去不需要确认
  const off = await call('POST', { allowAllLocalPaths: false })
  assert.equal(off.status, 200)
  assert.equal(off.json.allowAllLocalPaths, false)
}])

cases.push(['词表与目录边界：整表替换、空数组合法', async () => {
  const terms = [{ pattern: '示例人名|示例人明', replace: '示例人名' }, { pattern: 'ADHD|A型', replace: '示例术语', flags: 'gi' }]
  const roots = [join(tempHome, 'extra-a'), join(tempHome, 'extra-b')]
  const w = await call('POST', { asrTerms: terms, allowedRoots: roots, termEnvAllow: ['my_var'] })
  assert.equal(w.status, 200)
  assert.equal(w.json.asrTerms.length, 2)
  assert.deepEqual(w.json.allowedRoots, roots)
  assert.deepEqual(w.json.termEnvAllow, ['MY_VAR'], '环境变量名统一大写')
  const cleared = await call('POST', { asrTerms: [] })
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.json.asrTerms, [])
}])

cases.push(['未管理的键原样保留（别人写进 config.json 的东西不能被我们吃掉）', async () => {
  const current = readFileJson()
  writeFileSync(configFile, JSON.stringify({ ...current, myOwnNote: 'keep-me' }), 'utf8')
  surface.resetAssistantConfigCacheForTests()
  const w = await call('POST', { skillRoot: join(tempHome, 'skills2') })
  assert.equal(w.status, 200)
  const after = readFileJson()
  assert.equal(after.myOwnNote, 'keep-me', '未管理的键被吃掉了')
  assert.equal(after.skillRoot, join(tempHome, 'skills2'))
}])

cases.push(['已存在的配置坏掉时拒绝覆盖（500 config-unreadable，文件原样）', async () => {
  writeFileSync(configFile, '{ this is not json', 'utf8')
  surface.resetAssistantConfigCacheForTests()
  const r = await call('POST', { skillRoot: join(tempHome, 'skills3') })
  assert.equal(r.status, 500)
  assert.ok(String(r.json.error).startsWith('config-unreadable'), `错误码不对：${r.json.error}`)
  assert.equal(readFileSync(configFile, 'utf8'), '{ this is not json', '坏文件被覆盖了')
  // 复原，后续用例继续用
  writeFileSync(configFile, JSON.stringify({ skillRoot: join(tempHome, 'skills') }, null, 2) + '\n', 'utf8')
  surface.resetAssistantConfigCacheForTests()
}])

cases.push(['方法分辨率：PUT 等同 POST，其它方法 405 + Allow 头', async () => {
  const put = await call('PUT', { skillRoot: join(tempHome, 'skills-put') })
  assert.equal(put.status, 200)
  assert.equal(readFileJson().skillRoot, join(tempHome, 'skills-put'))
  const del = await call('DELETE')
  assert.equal(del.status, 405)
  assert.match(String(del.headers?.allow ?? ''), /POST/)
}])

cases.push(['非法 JSON / 空 body 一律 400（不能当成"没改动"静默 200）', async () => {
  const malformed = fakeRes()
  await route.handler(fakeReq('POST', '{oops'), malformed)
  assert.equal(malformed.status, 400)
  const empty = fakeRes()
  await route.handler(fakeReq('POST', undefined), empty)
  assert.equal(empty.status, 400)
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : err))
  }
}

try { dispose() } catch { /* 忽略 */ }
rmSync(tempHome, { recursive: true, force: true })
delete process.env.DSH_ASSISTANT_CONFIG
delete process.env.DSH_ASSISTANT_HOME
delete process.env.DSH_HOME
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
