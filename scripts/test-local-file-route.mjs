/**
 * 只读文件路由 `/api/worktable/file` 的离线回归（不启动宿主）：
 *   node scripts/test-local-file-route.mjs
 *
 * 2026-11-26 上限 20MB → 100MB，同时把「readFile 整份进内存」改成 createReadStream 流式发送。
 * 这里验的正是这两件事，外加原本的行为不许回退：
 *   - 100MB 可下发、100MB+1 字节被 413（带 maxBytes），边界与客户端 PC_FILE_MAX_BYTES 同数；
 *   - 流式：100MB 文件是按块写出的（块数远大于 1、单块远小于整份），不是一次性 end(大 Buffer)；
 *   - HEAD 仍然只回头不给正文；content-length / content-disposition 不变；
 *   - 空文件、不存在的路径、目录、越界判定（denyOutside）都还是原来的口径。
 */
import assert from 'node:assert/strict'
import { open, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const { localFileRouteTestSurface } = await import('../lib/index.js')
const { LOCAL_FILE_MAX_BYTES, createLocalFileHandler } = localFileRouteTestSurface

const MB = 1024 * 1024
const root = await mkdtemp(join(tmpdir(), 'local-file-route-'))

/** 假 res：Writable 收字节 + 记状态码/响应头；collect=false 时只数字节不存内容（100MB 那档用） */
function fakeRes(collect = true) {
  const chunks = []
  const sizes = []
  let bytes = 0
  const res = new Writable({
    write(chunk, _enc, cb) {
      bytes += chunk.length
      sizes.push(chunk.length)
      if (collect) chunks.push(chunk)
      cb()
    },
  })
  res.status = 0
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers ?? null }
  res.bytesWritten = () => bytes
  res.chunkCount = () => sizes.length
  res.body = () => (collect ? Buffer.concat(chunks).toString('utf8') : '')
  res.sizes = () => sizes
  return res
}

function fakeReq(method, url) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  return req
}

const finished = (res) => new Promise((resolve) => {
  res.on('finish', resolve)
  res.on('close', resolve)
})

async function call(path, { method = 'GET', collect = true } = {}) {
  // 默认「允许」：目录边界判定本身由 scripts/test-path-guard.mjs 覆盖，这里只验路由行为
  const denyOutside = () => false
  const handler = createLocalFileHandler({ denyOutside, logger: { warn: () => {} } })
  const res = fakeRes(collect)
  const done = finished(res)
  await handler(fakeReq(method, `/api/worktable/file?path=${encodeURIComponent(path)}`), res)
  await done
  return res
}

const cases = []

cases.push(['常量：100MB，与服务端 413 用的是同一个数', () => {
  assert.equal(LOCAL_FILE_MAX_BYTES, 100 * MB)
  assert.equal(LOCAL_FILE_MAX_BYTES, 100 * 1024 * 1024)
}])

cases.push(['普通文件：200 + content-length + attachment，字节完整', async () => {
  const file = join(root, '小文件.docx')
  await writeFile(file, 'x'.repeat(1024))
  const res = await call(file)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-length'], '1024')
  assert.equal(res.bytesWritten(), 1024)
  assert.match(String(res.headers['content-disposition']), /^attachment; filename=".*"; filename\*=UTF-8''/)
}])

cases.push(['空文件：200 + content-length 0，不卡住', async () => {
  const file = join(root, 'empty.txt')
  await writeFile(file, '')
  const res = await call(file)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-length'], '0')
  assert.equal(res.bytesWritten(), 0)
}])

cases.push(['HEAD：只给头，一个字节正文都不发', async () => {
  const file = join(root, 'head.bin')
  await writeFile(file, 'y'.repeat(4096))
  const res = await call(file, { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-length'], '4096')
  assert.equal(res.bytesWritten(), 0)
}])

cases.push(['100MB 可下发，且是按块流式写出的（不是整份 Buffer 一次 end）', async () => {
  const file = join(root, 'big-100mb.bin')
  const fh = await open(file, 'w')
  await fh.truncate(100 * MB)   // 稀疏文件：不真写 100MB 数据，stat.size 仍是 100MB
  await fh.close()
  assert.equal((await stat(file)).size, 100 * MB)
  const res = await call(file, { collect: false })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-length'], String(100 * MB))
  assert.equal(res.bytesWritten(), 100 * MB)
  assert.ok(res.sizes().length > 10, `应分多块写出，实际 ${res.sizes().length} 块`)
  assert.ok(Math.max(...res.sizes()) < 8 * MB, '单块不应接近整份文件（那说明还是整份缓冲）')
}])

cases.push(['100MB + 1 字节：413 且带 maxBytes，不读正文', async () => {
  const file = join(root, 'over-limit.bin')
  const fh = await open(file, 'w')
  await fh.truncate(LOCAL_FILE_MAX_BYTES + 1)
  await fh.close()
  const res = await call(file, { method: 'HEAD' })
  assert.equal(res.status, 413)
  const body = JSON.parse(res.body())
  assert.equal(body.error, 'file too large')
  assert.equal(body.maxBytes, LOCAL_FILE_MAX_BYTES)
}])

cases.push(['不存在的文件 / 目录：还是 404', async () => {
  const missing = await call(join(root, '没有这个文件.txt'))
  assert.equal(missing.status, 404)
  const dir = await call(root)
  assert.equal(dir.status, 404)
}])

cases.push(['越界判定照旧短路（denyOutside 返回 true 就不再碰文件）', async () => {
  const file = join(root, 'blocked.txt')
  await writeFile(file, 'z')
  const handler = createLocalFileHandler({
    denyOutside: (res) => { res.writeHead(403); res.end('{"ok":false,"error":"outside-allowlist"}'); return true },
    logger: { warn: () => {} },
  })
  const res = fakeRes()
  const done = finished(res)
  await handler(fakeReq('GET', `/api/worktable/file?path=${encodeURIComponent(file)}`), res)
  await done
  assert.equal(res.status, 403)
  assert.equal(res.body(), '{"ok":false,"error":"outside-allowlist"}', '只回越界错误，绝不读文件正文')
}])

let failed = 0
for (const [name, fn] of cases) {
  try { await fn(); console.log('  ok   ' + name) } catch (err) {
    failed++
    console.log('  FAIL ' + name + '\n       ' + String((err && err.message) || err))
  }
}

await rm(root, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAILED ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
