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

function fakeReq(method, body, extraHeaders = {}, url = '/api/assistant/config') {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  stream.method = method
  stream.url = url
  // 这份 fixture 代表「桌面浏览器在本机打开设置页」：dsh web 只认本机 HTTP 层，
  // 所以必须带 loopback Host——危险字段（allowAllLocalPaths / allowedRoots）只在回环写才放行
  // （2026-11-28 手机访问安全整改第 3 项）。不带 Host 的旧写法等于「来源不明」，会被 fail closed 拒。
  stream.headers = { host: '127.0.0.1:53691', 'content-type': 'application/json', ...extraHeaders }
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

const call = async (method, payload, extraHeaders = {}) => {
  const res = fakeRes()
  await route.handler(fakeReq(method, payload === undefined ? undefined : JSON.stringify(payload), extraHeaders), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.status, headers: res.headers, json, raw: res.body }
}

const readFileJson = () => JSON.parse(readFileSync(configFile, 'utf8'))
// 一次性口令路由（第 4 项）：同一批 registerAssistantConfigRoutes 注册的另一个 exact 路径
const hatchRoute = server.exact.get('/api/assistant/escape-hatch')
assert.ok(hatchRoute, '没有注册 /api/assistant/escape-hatch')
const hatchFile = join(assistantDir, 'escape-hatch.json')
const callHatch = async (method, extraHeaders = {}) => {
  const res = fakeRes()
  await hatchRoute.handler(fakeReq(method, undefined, extraHeaders, '/api/assistant/escape-hatch'), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.status, json, raw: res.body }
}
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

cases.push(['逃生开关要一次性口令（口令不在源码里、只在本机回环显示、用完即作废）', async () => {
  // 源码与构建产物里都不该再有那个公开常量
  const sourceText = readFileSync(new URL('../src/assistant-config.ts', import.meta.url), 'utf8')
  const bundleText = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const pocketBundleText = readFileSync(new URL('../lib/pocket.js', import.meta.url), 'utf8')
  assert.ok(!sourceText.includes('ALLOW-ALL'), 'assistant-config.ts 里还留着公开确认词')
  assert.ok(!bundleText.includes('ALLOW-ALL'), '构建产物 lib/index.js 里还留着公开确认词')
  assert.ok(!pocketBundleText.includes('ALLOW-ALL'), '构建产物 lib/pocket.js 里还留着公开确认词')

  const missing = await call('POST', { allowAllLocalPaths: true })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error, 'confirm-required')
  const guessed = await call('POST', { allowAllLocalPaths: true, confirm: 'guess-me-0123456789' })
  assert.equal(guessed.status, 400, '乱猜的口令不该过：' + guessed.raw)
  assert.ok(!/ALLOW-ALL/.test(guessed.json.hint ?? ''), '错误提示里也不该再出现公开词：' + guessed.json.hint)

  const fetched = await callHatch('GET')
  assert.equal(fetched.status, 200, `本机该取到口令：${fetched.raw}`)
  const token = fetched.json?.token
  assert.ok(typeof token === 'string' && token.length >= 24, '口令该是 24 位随机值：' + token)
  assert.ok(!/ALLOW/i.test(token), '口令里不该带任何公开常量字样')
  assert.ok(!/[+/=]/.test(token), 'base64url：口令本身不带需要转义的字符')
  assert.equal(existsSync(hatchFile), true, '口令没落在助手目录里')
  assert.ok(!readFileSync(configFile, 'utf8').includes(token), '口令不该出现在本机配置文件里')

  // 非本机来源取不到口令（403，而且不回吐）
  for (const headers of [{ 'x-dsh-pocket-source': 'lan' }, { 'x-dsh-pocket-source': 'public' }, { host: 'pocket.example.com' }, { 'cf-connecting-ip': '203.0.113.7' }]) {
      const phone = await callHatch('GET', headers)
      assert.equal(phone.status, 403, `手机来源该被拒（${JSON.stringify(headers)}）：${phone.raw}`)
      assert.ok(!phone.raw.includes(token), '拒的时候也不该回吐口令本体')
  }

  const allowed = await call('POST', { allowAllLocalPaths: true, confirm: token })
  assert.equal(allowed.status, 200, allowed.raw)
  assert.equal(allowed.json.allowAllLocalPaths, true)
  // 一次性：同一串再用必须作废，而且文件里那份已经换新
  const reused = await call('POST', { allowAllLocalPaths: true, confirm: token })
  assert.equal(reused.status, 400, '同一个口令该即刻作废：' + reused.raw)
  const rotated = readFileSync(hatchFile, 'utf8')
  assert.ok(!rotated.includes(token), '旧口令还在文件里，等于「即刻作废」没生效')

  // 关掉开关不需要口令
  const off = await call('POST', { allowAllLocalPaths: false })
  assert.equal(off.status, 200)
  assert.equal(off.json.allowAllLocalPaths, false)
  // GET 下发的那份客户端视图永远不含口令本体
  const g = await call('GET')
  assert.equal(g.json.allowAllLocalPaths, false)
  assert.ok(!g.raw.includes(token), 'GET /api/assistant/config 回吐了口令本体')
}])

cases.push(['一次性口令相关的中英文文案都补齐（两份，且源码里不再有公开确认词）', async () => {
  const loc = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  for (const key of [
    'localConfig.allowAllConfirm',
    'localConfig.allowAllBadConfirm',
    'localConfig.allowAllNeedToken',
    'localConfig.allowAllTokenBtn',
    'localConfig.allowAllTokenFetching',
    'localConfig.allowAllTokenTaken',
    'localConfig.allowAllTokenFailed',
    'localConfig.allowAllTokenDesc',
  ]) {
    assert.equal((loc.match(new RegExp("'" + key + "'", 'g')) ?? []).length, 2, key + ' 缺中英两份')
  }
  const panel = readFileSync(new URL('../src/client/assistant-local-config.tsx', import.meta.url), 'utf8')
  const literal = ['ALLOW', '-', 'ALL'].join('')
  assert.ok(!panel.includes(literal), '设置页源码里还留着公开确认词')
  assert.ok(!loc.includes(literal), '文案里还留着公开确认词')
  assert.ok(!assistant.escapeHatchTestSurface.escapeHatchStatus().file.includes(literal), '口令文件名带公开词')
}])

cases.push(['危险字段只允许本机回环写（手机来源即使带确认词也 403，且不落盘）', async () => {
  const marker = 'x-dsh-pocket-source'
  for (const headers of [{ [marker]: 'lan' }, { [marker]: 'public' }, { 'cf-connecting-ip': '203.0.113.7' }, { host: 'pocket.example.com' }]) {
    const deniedRoots = await call('POST', { allowedRoots: [join(tempHome, 'from-phone')] }, headers)
    assert.equal(deniedRoots.status, 403, `来源 ${JSON.stringify(headers)} 该被拒：${deniedRoots.raw}`)
    assert.equal(deniedRoots.json.error, 'loopback-only')
    const deniedEscape = await call('POST', { allowAllLocalPaths: true, confirm: 'not-a-valid-passphrase' }, headers)
    assert.equal(deniedEscape.status, 403, '回环判定该走在确认之前：' + deniedEscape.raw)
    assert.equal(deniedEscape.json.field, 'allowAllLocalPaths')
  }
  assert.ok(!readFileSync(configFile, 'utf8').includes('from-phone'), '非本机来源把目录边界改宽了')
  assert.ok(!/"allowAllLocalPaths"\s*:\s*true/.test(readFileSync(configFile, 'utf8')), '非本机来源把逃生开关打开了')
  // 不需要边界特权的字段照旧可写（手机改自己的设置是正常用法）
  const normal = await call('POST', { termEnvAllow: ['FROM_PHONE_OK'] }, { [marker]: 'lan' })
  assert.equal(normal.status, 200, `普通字段不该被来源判定挡住：${normal.raw}`)
  // 本机回环照旧能写危险字段（上面 403 用例的对照面）
  const local = await call('POST', { allowedRoots: [join(tempHome, 'from-desktop')] })
  assert.equal(local.status, 200, `本机回环该能改边界：${local.raw}`)
  assert.ok(readFileSync(configFile, 'utf8').includes('from-desktop'))
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
