/**
 * 手机文件通道的目录边界回归（2026-11-28 手机访问安全整改第 3 项）：
 *   node scripts/test-fs-rpc-allowlist.mjs
 *
 * 断言四件事（外加两组 plumbing）：
 *   1. 允许根以内：能列、能读；
 *   2. 允许根以外：拒绝，错误码 outside-allowlist；
 *   3. `..` 遍历：拒绝，错误码 path-traversal-denied；
 *   4. 绝对盘符根 / POSIX /：拒绝，错误码 drive-root-denied
 *      ——也就是「拿一个 8 位 PIN 不能把整台电脑的磁盘翻一遍」。
 * 另外测危险字段写入门槛：allowAllLocalPaths / allowedRoots 只允许本机回环写
 * （经 pocket 代理进来的来源标记 lan/public，或带 cf-connecting-ip，一律 403）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { installPocketRpc } from '../src/pocket-host/web-rpc.js'
import { checkPath, listFs, listDrives, requireAllowedPath, FS_DENY_CODES, uploadsDir } from '../src/pocket-host/fs-rpc.mjs'
import { pocketSourceClass, POCKET_SOURCE_MARKER } from '../src/pocket-host/proxy.mjs'

const assistant = await import('../lib/index.js')
const { assistantConfigTestSurface } = assistant
const { registerAssistantConfigRoutes } = assistantConfigTestSurface

const tempHome = mkdtempSync(join(tmpdir(), 'pocket-allowlist-'))
const granted = join(tempHome, 'granted')
mkdirSync(granted, { recursive: true })
writeFileSync(join(granted, 'note.txt'), 'inside the allowlist', 'utf8')
const configFile = join(tempHome, 'assistant-config.json')
process.env.DSH_ASSISTANT_CONFIG = configFile
process.env.DSH_ASSISTANT_HOME = join(tempHome, '.dsh', 'assistant')
process.env.DSH_HOME = join(tempHome, '.dsh')
writeFileSync(configFile, JSON.stringify({ allowedRoots: [granted] }), 'utf8')
assistantConfigTestSurface.resetAssistantConfigCacheForTests()
mkdirSync(uploadsDir(), { recursive: true })

const forbidden = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc'
const volumeRoot = process.platform === 'win32' ? 'C:\\' : '/'
const outsideDeep = join(forbidden, 'drivers', 'etc')

const cases = []

cases.push(['允许根以内：列目录能过、读文件也能过', async () => {
  const ok = requireAllowedPath(granted)
  assert.equal(ok, granted)
  assert.equal(requireAllowedPath(join(granted, 'note.txt')), join(granted, 'note.txt'))
  const listing = await listFs(granted, { includeFiles: true })
  assert.equal(listing.path, granted)
  assert.ok(listing.entries.some((e) => e.name === 'note.txt'), '内层文件没列出来')
  assert.ok(checkPath(granted).ok)
}])

cases.push(['允许根以外：拒绝并带 outside-allowlist 错误码', () => {
  const denied = checkPath(forbidden)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, FS_DENY_CODES.outside)
  assert.match(denied.message, new RegExp(`^outside-allowlist:`))
  assert.ok(denied.message.includes(forbidden), '拒绝消息要说清差哪个路径：' + denied.message)
  assert.throws(() => requireAllowedPath(outsideDeep), (err) => err.dshFsCode === FS_DENY_CODES.outside)
  assert.throws(() => requireAllowedPath(''), (err) => err.dshFsCode === FS_DENY_CODES.empty)
}])

cases.push(['`..` 遍历：出界一律拒绝，错误码 path-traversal-denied', () => {
  const sep = process.platform === 'win32' ? '\\' : '/'
  // 入参里保留字面 `..`（path.join 会把 .. 消化掉，那就测不到遍历口径了）
  const escape = `..${sep}..${sep}Windows`
  const denied = checkPath(escape)
  assert.equal(denied.ok, false, `家目录往上两层应当被拒：${denied.message}`)
  assert.equal(denied.code, FS_DENY_CODES.traversal, '带 .. 的入参该给「遍历」这个码：' + denied.message)
  assert.match(denied.message, /^path-traversal-denied:/)
  const deep = `..${process.platform === 'win32' ? '\\' : '/'}..${process.platform === 'win32' ? '\\' : '/'}Windows${process.platform === 'win32' ? '\\System32' : ''}`
  assert.equal(checkPath(deep).code, FS_DENY_CODES.traversal, '相对遍历同样要拒：' + deep)
  assert.equal(checkPath(deep).ok, false)
  // 遍历一路往上走到盘符根本身：那也是拒绝，只是归到「盘符根」这一类码
  const up = checkPath(join(homedir(), '..', '..'))
  assert.equal(up.ok, false)
  assert.ok([FS_DENY_CODES.traversal, FS_DENY_CODES.driveRoot].includes(up.code), `${up.message}`)
}])

cases.push(['盘符根与 POSIX 根：拒绝并带 drive-root-denied（不能枚举整盘）', async () => {
  const denied = checkPath(volumeRoot)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, FS_DENY_CODES.driveRoot, `盘符根该单独一类：${denied.message}`)
  await assert.rejects(() => listFs(volumeRoot), (err) => err.dshFsCode === FS_DENY_CODES.driveRoot)
  // 盘符枚举本身（A–Z）不许变成「能列整盘内容」：根目录内容一律拒
  const drives = await listDrives()
  assert.ok(Array.isArray(drives) && drives.length > 0)
  for (const drive of drives) {
    if (drive === uploadsDir()) continue
    const result = checkPath(drive)
    if (result.ok) continue // 本机确实把某个盘符根放进了 allowedRoots：那是用户自己的配置
    assert.ok([FS_DENY_CODES.driveRoot, FS_DENY_CODES.outside].includes(result.code), `${drive} 被拒时错误码不清晰：${result.message}`)
  }
}])

cases.push(['上传落盘只在 uploads 目录内，且目录本身也过边界', async () => {
  const saved = await listFs(uploadsDir()).then(() => 'ok').catch(() => 'denied')
  assert.equal(saved, 'ok', 'pocket 自己的 uploads 目录该在允许根以内（$DSH_HOME 就是允许根）')
  assert.ok(requireAllowedPath(uploadsDir()).startsWith(uploadsDir()))
}])

/* ────────────── 走真实挂载路径：/dsh-pocket RPC ────────────── */

function mountRpc() {
  const routes = []
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: undefined,
    logger: { info() {}, warn() {}, error() {} },
  }
  const service = { status: async () => ({ dshPort: 3080 }), stopTunnel() {}, startTunnel: async () => {} }
  installPocketRpc(ctx, { service, log: { info() {}, warn() {}, error() {} } })
  return routes[0]
}

async function rpcCall(route, endpoint, payload, headers = {}) {
  const body = JSON.stringify({ rpcId: 'r-' + endpoint, method: endpoint, payload: payload ?? {} })
  const req = Readable.from([Buffer.from(body, 'utf8')])
  req.method = 'POST'
  req.url = `/dsh-pocket/${endpoint}`
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers }
  const chunks = []
  const res = {
    statusCode: 0, headers: {}, writableEnded: false,
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs ?? {} },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true },
    end() { this.writableEnded = true },
    on() {}, once() {}, off() {}, destroy() {},
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, json: JSON.parse(text), text }
}

cases.push(['fileRead RPC：越界与盘符根一律带码拒绝，允许根内正常返回内容', async () => {
  const rpc = mountRpc()
  const inside = await rpcCall(rpc, 'pocket.fileRead', { path: join(granted, 'note.txt') })
  assert.equal(inside.json.result.ok, true, '允许根以内该读出来：' + inside.text)
  assert.equal(inside.json.result.value.content, 'inside the allowlist')

  const outside = await rpcCall(rpc, 'pocket.fileRead', { path: forbidden })
  assert.equal(outside.json.result.ok, false)
  assert.match(outside.json.result.error.message, /outside-allowlist/)

  const root = await rpcCall(rpc, 'pocket.fileRead', { path: volumeRoot })
  assert.match(root.json.result.error.message, /drive-root-denied/, '盘符根要走单独一类码：' + root.json.result.error.message)

  const traversed = await rpcCall(rpc, 'pocket.fileRead', { path: join('..', '..', 'Windows') })
  assert.equal(traversed.json.result.ok, false)
  assert.match(traversed.json.result.error.message, /path-traversal-denied|outside-allowlist/)
}])

cases.push(['fs.list RPC：越界拒绝、手机来源同样拒绝（同一份 allowlist）', async () => {
  const rpc = mountRpc()
  const okLocal = await rpcCall(rpc, 'fs.list', { path: granted, includeFiles: true })
  assert.equal(okLocal.json.result.ok, true, '允许根内该列出来：' + okLocal.text)
  const phone = await rpcCall(rpc, 'fs.list', { path: forbidden }, { [POCKET_SOURCE_MARKER]: 'lan' })
  assert.equal(phone.json.result.ok, false)
  assert.match(phone.json.result.error.message, /outside-allowlist/, '手机来源也得走同一份目录边界')
  const phoneRoot = await rpcCall(rpc, 'fs.list', { path: volumeRoot }, { [POCKET_SOURCE_MARKER]: 'public' })
  assert.match(phoneRoot.json.result.error.message, /drive-root-denied|outside-allowlist/)
}])

/* ────────────── 危险字段写入门槛（/api/assistant/config） ────────────── */

function configRoute() {
  const routes = []
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  registerAssistantConfigRoutes(ctx)
  return routes[0]
}

async function configPost(route, payload, headers) {
  const body = JSON.stringify(payload)
  const req = Readable.from([Buffer.from(body, 'utf8')])
  req.method = 'POST'
  req.url = '/api/assistant/config'
  req.headers = { host: '127.0.0.1:53691', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers }
  const chunks = []
  const res = {
    code: 0, bodyText: '',
    writeHead(c, hdrs) { this.code = c; this.headers = hdrs },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true },
    end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); this.bodyText = Buffer.concat(chunks).toString('utf8') },
  }
  await route.handler(req, res)
  return { code: res.code, json: JSON.parse(res.bodyText || '{}'), text: res.bodyText }
}

cases.push(['危险字段 allowAllLocalPaths / allowedRoots 只允许本机回环写', async () => {
  const route = configRoute()
  const desktop = await configPost(route, { allowedRoots: [granted] }, {})
  assert.equal(desktop.code, 200, `本机回环该写得进去：${desktop.text}`)
  assert.ok(desktop.json.saved?.includes('allowedRoots'))

  for (const headers of [
    { [POCKET_SOURCE_MARKER]: 'lan' },
    { [POCKET_SOURCE_MARKER]: 'public' },
    { 'cf-connecting-ip': '203.0.113.7' },
    { host: 'pocket.example.com' },
    { 'x-dsh-pocket-source': 'lan' },
  ]) {
    const phone = await configPost(route, { allowedRoots: [granted, 'Z:\\outside-drive'] }, headers)
    assert.equal(phone.code, 403, `非本机来源该被拒（${JSON.stringify(headers)}）：${phone.text}`)
    assert.equal(phone.json.error, 'loopback-only')
    assert.equal(phone.json.field, 'allowedRoots')
    assert.match(phone.json.hint, /只在这台电脑上改/)
  }
  const noHost = await configPost(route, { allowAllLocalPaths: true }, { host: '' })
  assert.equal(noHost.code, 403, 'Host 头缺失时该 fail closed')
  assert.match(noHost.text, /loopback-only/)
  // 危险字段被拒时**不落盘**：那份「加宽边界」的改动不该写进配置文件
  assert.ok(!readFileSync(configFile, 'utf8').includes('outside-drive'), '非本机来源竟然把新根写进了配置文件')
}])

cases.push(['来源标记两处口径一致（pocket 代理 ↔ 工作台 bundle）', () => {
  const proxySrc = readFileSync(new URL('../src/pocket-host/proxy.mjs', import.meta.url), 'utf8')
  const configSrc = readFileSync(new URL('../src/assistant-config.ts', import.meta.url), 'utf8')
  assert.ok(proxySrc.includes(`'${POCKET_SOURCE_MARKER}'`), 'proxy.mjs 里的标记常量不认')
  assert.ok(configSrc.includes(`'${POCKET_SOURCE_MARKER}'`), 'assistant-config.ts 里的标记常量不认（两个 bundle 各自一份）')
  assert.equal(pocketSourceClass({ headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '192.168.1.7' } }), 'lan')
  assert.ok(POCKET_SOURCE_MARKER === 'x-dsh-pocket-source')
}])

cases.push(['构建产物真的接上了闸（lib/pocket.js 有边界、lib/index.js 有来源判定）', () => {
  const pocket = readFileSync(new URL('../lib/pocket.js', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(pocket.includes('outside-allowlist'), 'pocket bundle 里找不到目录边界')
  assert.ok(pocket.includes('drive-root-denied'), 'pocket bundle 里找不到盘符根拒绝')
  assert.ok(pocket.includes(POCKET_SOURCE_MARKER), 'pocket bundle 里找不到来源标记')
  assert.ok(index.includes(POCKET_SOURCE_MARKER), 'index bundle 里找不到来源标记')
  assert.ok(index.includes('loopback-only'), 'index bundle 里找不到危险字段的拒绝码')
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
rmSync(tempHome, { recursive: true, force: true })
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
