/**
 * web-rpc 的 PIN/Token 脱敏与「只在本机看密码」回归（2026-11-28 手机访问安全整改第 2 项）：
 *   node scripts/test-web-rpc-token-redaction.mjs
 *
 * 覆盖三件事：
 *   1. status 不许再回显 accessToken / lanToken 本体，只回「是否已设置 + 位数」；
 *   2. 新增的 pin.view 端点：本机回环给本体，手机（代理标记 lan/public）一律拒；
 *   3. lanTokenRefresh 与 pin.setCustom 对**非回环**来源不再返回原始 PIN；
 *   另外直接测 pocketRequestSource 的来源判定与 proxy 的 pocketSourceClass（含不可伪造口径）。
 * 测试走真实挂载路径（fake webServer → mountPocketWebRoute → pocketHttpBridge → handler），
 * 所以「桥把 HTTP 头交给业务层」这条 plumbing 也在断言里。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { installPocketRpc, pocketRequestSource } from '../src/pocket-host/web-rpc.js'
import { pocketSourceClass, POCKET_SOURCE_MARKER } from '../src/pocket-host/proxy.mjs'
import { POCKET_ENDPOINTS, pinMeta } from '../src/client/pocket/api.js'

const PUBLIC_PIN = 'pubPin12'
const LAN_PIN = 'lanPin34'
const NEW_LAN_PIN = 'lanPin99'

/** 业务层依赖（服务状态全部造假的，不碰真文件、不碰真进程） */
let lanRefreshes = 0
const service = {
  status: async () => ({ dshPort: 3080, proxyRunning: true, proxyPort: 3081, lanUrl: 'http://192.168.1.20:3081' }),
  stopTunnel() {},
  startTunnel: async () => {},
}
const settings = {
  getLanToken: () => LAN_PIN,
  getToken: () => PUBLIC_PIN,
  refreshLanToken: () => { lanRefreshes += 1; return NEW_LAN_PIN },
  setCustomPin: (which, value) => String(value ?? '').trim() || (which === 'lan' ? LAN_PIN : PUBLIC_PIN),
  getLanAuthEnabled: () => true,
  getLanEnabled: () => true,
  getPinCustom: () => false,
  getTunnelConfig: () => ({ mode: 'quick', hostname: '', tokenSet: false }),
}

function fakeRes() {
  const chunks = []
  return {
    statusCode: 0,
    headers: null,
    writableEnded: false,
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs ?? {} },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true },
    end() { this.writableEnded = true },
    on() {}, once() {}, off() {}, destroy() {},
    body() { return Buffer.concat(chunks).toString('utf8') },
  }
}

/** 挂一次插件的 RPC 通道，拿到 /dsh-pocket 的处理器 */
function mountRpc() {
  const routes = []
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    // connection 缺席 = 走 isTrustedLoopbackRequest 兜底路径（旧版 dsh），
    // 该路径只认 Host 是不是回环；来源标记由业务层 pocketRequestSource 把关。
    connection: undefined,
    logger: { info() {}, warn() {}, error() {} },
  }
  const dispose = installPocketRpc(ctx, { service, log: { info() {}, warn() {}, error() {} }, ...settings })
  return { rpc: routes[0], dispose }
}

async function rpcCall(route, endpoint, payload, extraHeaders = {}) {
  const body = JSON.stringify({ rpcId: `rpc-${endpoint}`, method: endpoint, payload: payload ?? {} })
  const req = Readable.from([Buffer.from(body, 'utf8')])
  req.method = 'POST'
  req.url = `/dsh-pocket/${endpoint}`
  req.headers = {
    host: '127.0.0.1:3080',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  }
  const res = fakeRes()
  await route.handler(req, res)
  const text = res.body()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 时留给断言报错 */ }
  return { status: res.statusCode, json, text }
}

/** 手机视角：代理把 Host 改写成本机权威，只剩来源标记能看出它其实来自局域网 */
const phoneHeaders = { [POCKET_SOURCE_MARKER]: 'lan' }
const cases = []

cases.push(['status 不再回显明文 PIN，只回「是否已设置 + 位数」', async () => {
  const { rpc } = mountRpc()
  const { json } = await rpcCall(rpc, POCKET_ENDPOINTS.status, {})
  const value = json.result.value
  const text = JSON.stringify(value)
  assert.ok(!text.includes(PUBLIC_PIN), 'status 里出现了公网 PIN 本体')
  assert.ok(!text.includes(LAN_PIN), 'status 里出现了局域网 PIN 本体')
  assert.equal('accessToken' in value, false, 'accessToken 字段应当撤掉')
  assert.equal('lanToken' in value, false, 'lanToken 字段应当撤掉')
  assert.equal(value.accessTokenSet, true)
  assert.equal(value.accessTokenLength, PUBLIC_PIN.length)
  assert.equal(value.lanTokenSet, true)
  assert.equal(value.lanTokenLength, LAN_PIN.length)
  assert.equal(value.pinViewAvailable, true, '本机来源应当能看密码')
  const phone = await rpcCall(rpc, POCKET_ENDPOINTS.status, {}, phoneHeaders)
  assert.equal(phone.json.result.value.pinViewAvailable, false, '手机来源不该声明「能看密码」')
  assert.ok(!JSON.stringify(phone.json).includes(LAN_PIN))
  assert.ok(!JSON.stringify(phone.json).includes(PUBLIC_PIN))
}])

cases.push(['pin.view：本机回环给本体，非回环来源即使已登录也拒', async () => {
  const { rpc } = mountRpc()
  const local = await rpcCall(rpc, POCKET_ENDPOINTS.pinView, { which: 'public' })
  assert.equal(local.json.result.ok, true)
  assert.equal(local.json.result.value.pin, PUBLIC_PIN)
  assert.equal(local.json.result.value.loopback, true)
  const lanPin = await rpcCall(rpc, POCKET_ENDPOINTS.pinView, { which: 'lan' })
  assert.equal(lanPin.json.result.value.pin, LAN_PIN)

  for (const headers of [phoneHeaders, { [POCKET_SOURCE_MARKER]: 'public' }, { 'cf-connecting-ip': '203.0.113.7' }]) {
    const res = await rpcCall(rpc, POCKET_ENDPOINTS.pinView, { which: 'public' }, headers)
    assert.equal(res.json.result.ok, false, `来源 ${JSON.stringify(headers)} 竟然拿到了密码`)
    assert.match(res.json.result.error.message, /loopback-only/, '拒绝文案要说明只在本机回环可用')
    assert.ok(!res.text.includes(PUBLIC_PIN), '拒绝响应里不许出现 PIN 本体')
  }
}])

cases.push(['lanTokenRefresh：非回环来源照样轮换，但不返回原始 PIN', async () => {
  const { rpc } = mountRpc()
  const phone = await rpcCall(rpc, POCKET_ENDPOINTS.lanTokenRefresh, {}, phoneHeaders)
  assert.equal(phone.json.result.ok, true)
  const value = phone.json.result.value
  assert.equal('lanToken' in value, false, '非本机来源不许出现 lanToken 本体')
  assert.equal(value.lanTokenRotated, true)
  assert.equal(value.lanTokenSet, true)
  assert.equal(value.lanTokenLength, NEW_LAN_PIN.length)
  assert.ok(!phone.text.includes(NEW_LAN_PIN), '轮换响应里不许出现新 PIN')
  assert.ok(!phone.text.includes(LAN_PIN), '轮换响应里不许出现旧 PIN')
  assert.equal(lanRefreshes, 1, '轮换该真的执行一次')

  const local = await rpcCall(rpc, POCKET_ENDPOINTS.lanTokenRefresh, {})
  assert.equal(local.json.result.value.lanToken, NEW_LAN_PIN, '本机来源要能拿到新密码（设置页得显示给用户）')
  assert.equal(lanRefreshes, 2)
}])

cases.push(['pin.setCustom：非回环来源只拿到掩码元数据', async () => {
  const { rpc } = mountRpc()
  const phone = await rpcCall(rpc, POCKET_ENDPOINTS.pinSetCustom, { which: 'public', value: 'customPin1' }, phoneHeaders)
  const value = phone.json.result.value
  assert.ok(!phone.text.includes('customPin1'), '非本机来源不许回显刚设的密码')
  assert.equal(value.accessTokenSet, true)
  assert.equal(value.accessTokenLength, 'customPin1'.length)
  assert.equal(value.loopback, false)
  const local = await rpcCall(rpc, POCKET_ENDPOINTS.pinSetCustom, { which: 'public', value: 'customPin1' })
  assert.equal(local.json.result.value.pin, 'customPin1')
}])

cases.push(['来源判定 pocketRequestSource：认标记、认 cf-connecting-ip，判不到按非本机', () => {
  assert.equal(pocketRequestSource(undefined).loopback, true, '旧版 rpc.handle 路径本来就是本机专用')
  assert.equal(pocketRequestSource({ headers: { host: '127.0.0.1:3080' } }).loopback, true)
  assert.equal(pocketRequestSource({ headers: { host: 'localhost:3080' } }).loopback, true)
  assert.equal(pocketRequestSource({ headers: { host: '[::1]:3080' } }).loopback, true)
  assert.equal(pocketRequestSource({ headers: { host: '127.0.0.1:3080', [POCKET_SOURCE_MARKER]: 'loopback' } }).loopback, true)
  assert.equal(pocketRequestSource({ headers: { host: '127.0.0.1:3080', [POCKET_SOURCE_MARKER]: 'lan' } }).loopback, false)
  assert.equal(pocketRequestSource({ headers: { host: '127.0.0.1:3080', [POCKET_SOURCE_MARKER]: 'public' } }).source, 'public')
  assert.equal(pocketRequestSource({ headers: { host: '127.0.0.1:3080', 'cf-connecting-ip': '203.0.113.7' } }).source, 'public')
  assert.equal(pocketRequestSource({ headers: { host: 'pocket.example.com' } }).loopback, false)
  assert.equal(pocketRequestSource({ headers: {} }).loopback, false, '没有 Host 头时该 fail closed')
  assert.equal(pocketRequestSource({ headers: { host: '10.0.0.8:3080' } }).loopback, false)
  assert.equal(pocketRequestSource({ headers: { host: '127.0.0.1:3080', [POCKET_SOURCE_MARKER]: 'lan' } }).reason, 'pocket-proxy:lan')
}])

cases.push(['代理侧 pocketSourceClass：TCP 源地址给 Host 设下限，隧道看 cf-connecting-ip', () => {
  const reqOf = (headers, socket) => ({ headers, socket })
  assert.equal(pocketSourceClass(reqOf({ host: '127.0.0.1:3080' }, { remoteAddress: '::1' })), 'loopback')
  assert.equal(pocketSourceClass(reqOf({ host: '127.0.0.1:3080' }, { remoteAddress: '192.168.1.20' })), 'lan')
  assert.equal(pocketSourceClass(reqOf({ host: '192.168.1.20:3081' }, { remoteAddress: '192.168.1.20' })), 'lan')
  assert.equal(pocketSourceClass(reqOf({ host: 'pocket.example.com' }, { remoteAddress: '198.51.100.9' })), 'public')
  // cloudflared 回连本机（socket 是 127.0.0.1）但带 cf-connecting-ip：真实客户端在公网
  assert.equal(pocketSourceClass(reqOf({ host: '127.0.0.1:3080', 'cf-connecting-ip': '203.0.113.7' }, { remoteAddress: '127.0.0.1' })), 'public')
  assert.equal(POCKET_SOURCE_MARKER, 'x-dsh-pocket-source')
}])

cases.push(['pinMeta 的口径：只有「已设置 + 位数」，永不含密码本体', () => {
  assert.deepEqual(pinMeta('lanToken', 'abc123'), { lanTokenSet: true, lanTokenLength: 6 })
  assert.deepEqual(pinMeta('lanToken', null), { lanTokenSet: false, lanTokenLength: 0 })
  assert.deepEqual(pinMeta('accessToken', undefined), { accessTokenSet: false, accessTokenLength: 0 })
  for (const meta of Object.values(pinMeta('lanToken', 'abc123'))) assert.ok(typeof meta !== 'string')
}])

cases.push(['源码里不许再出现「status 直接回显 token」的旧写法', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/pocket-host/web-rpc.js', import.meta.url), 'utf8')
  assert.ok(!/accessToken:\s*getToken/.test(src), 'web-rpc.js 还在往 status 里塞 accessToken')
  assert.ok(!/lanToken:\s*getLanToken/.test(src), 'web-rpc.js 还在往 status 里塞 lanToken')
  assert.ok(!/return ok\(\{ which, pin,/.test(src) || /loopback/.test(src), 'pin.setCustom 明文回显没配回环判定')
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
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
