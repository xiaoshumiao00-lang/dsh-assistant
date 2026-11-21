/**
 * 打开链路诊断日志的落盘契约（不需要启动 DSH，不写用户的 ~/.dsh）：
 *   node scripts/test-assistant-open-diag.mjs
 *
 * 钉住三件事：
 *   1. POST /api/assistant/open-diag 的 JSON 一行一条写进日志，GET 能读回来；
 *   2. 非法 JSON / 空 body 不炸，按 { raw } 落；
 *   3. 超过 512KB 自动清空（日志不会长到把磁盘吃掉）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const root = mkdtempSync(join(tmpdir(), 'assistant-open-diag-'))
const logPath = join(root, 'dsh-assistant-open.log')
// 必须在 import 之前指好：模块在加载时就把日志路径定下来
process.env.DSH_ASSISTANT_OPEN_DIAG_LOG = logPath

const assistant = await import('../lib/index.js')
const { appendOpenDiag, readOpenDiagTail, handleOpenDiag } = assistant

function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? null }
  out.end = (payload) => { out.body = String(payload ?? '') }
  return out
}
function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = assistant.OPEN_DIAG_PATH ?? '/api/assistant/open-diag'
  return req
}
const call = async (method, body) => {
  const res = fakeRes()
  await handleOpenDiag(fakeReq(method, body), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.status, json, raw: res.body }
}

// 别往用户的真实日志写：确认这次用的是临时文件
assert.ok(logPath.startsWith(root), '日志路径必须落在临时目录')
assert.notEqual(logPath, join(homedir(), '.dsh', 'dsh-assistant-open.log'), '不许写到用户的真实日志文件')

const cases = []

cases.push(['POST 一条诊断 → 落盘；GET 读回原样', async () => {
  const r = await call('POST', JSON.stringify({ step: 'fallback-console', sessionId: 'session-x', reason: '开不了' }))
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  const entry = JSON.parse(lines[lines.length - 1])
  assert.equal(entry.step, 'fallback-console')
  assert.equal(entry.sessionId, 'session-x')
  assert.equal(entry.reason, '开不了')
  assert.equal(entry.from, 'client')
  assert.ok(typeof entry.at === 'string' && entry.at.includes('T'))
  const g = await call('GET', undefined)
  assert.equal(g.status, 200)
  assert.ok(Array.isArray(g.json.lines))
  assert.ok(g.json.lines.some((line) => line.includes('fallback-console')), 'GET 必须把落下的诊断读回来')
}])

cases.push(['非法 JSON / 空 body 不炸（按 raw 落一条）', async () => {
  const r = await call('POST', 'not json at all')
  assert.equal(r.status, 200)
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  const entry = JSON.parse(lines[lines.length - 1])
  assert.equal(entry.raw, 'not json at all')
  const empty = await call('POST', undefined)
  assert.equal(empty.status, 200)
  assert.equal(JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').slice(-1)[0]).raw, '')
}])

cases.push(['不认识的 HTTP 方法 → 405', async () => {
  const r = await call('DELETE', undefined)
  assert.equal(r.status, 405)
}])

cases.push(['超过 512KB 自动清空（日志不吃磁盘）', async () => {
  writeFileSync(logPath, 'x'.repeat(600 * 1024), 'utf8')
  assert.ok(statSync(logPath).size > 512 * 1024)
  appendOpenDiag({ step: 'after-rotation' })
  const size = statSync(logPath).size
  assert.ok(size < 4096, `应该被清空后只剩这一条，实际 ${size} 字节`)
  assert.ok(readFileSync(logPath, 'utf8').includes('after-rotation'))
}])

cases.push(['readOpenDiagTail 只给尾部（不返回整本日志）', async () => {
  for (let i = 0; i < 25; i += 1) appendOpenDiag({ step: 'row', index: i })
  const tail = readOpenDiagTail(5)
  assert.equal(tail.length, 5)
  assert.ok(tail[4].includes('"index":24'), '最后一条必须是最新写入的')
  assert.ok(!tail.some((line) => line.includes('"index":0')), '不许把整本日志都端回去')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}
try { rmSync(root, { recursive: true, force: true }) } catch {}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} assistant-open-diag`)
