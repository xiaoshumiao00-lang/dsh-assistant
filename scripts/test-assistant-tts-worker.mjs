/**
 * 常驻 edge-tts worker 连接/池单测（假 spawn，不启动 python）：
 *   node scripts/test-assistant-tts-worker.mjs
 *
 * 覆盖（scripts/tihu-edge-tts-worker.py 的行帧 + 长度帧协议）：
 *   - 合成成功：JSON 头 + MP3 负载正确组装（含跨 chunk 分包、头身分开发）；
 *   - 顺序队列：一条连接上多条请求按序应答；
 *   - 失败帧 → reject 带 worker 错误信息；
 *   - 进程退出 → 在途请求全部拒绝、连接判死、池下次换新的（仍只走微软 edge-tts）；
 *   - 池：size 条连接轮转，并发请求落到不同连接；
 *   - 协议垃圾帧 → 连接报协议错误（不挂死）。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

const lib = await import('../lib/index.js')
const surface = lib.assistantTtsTestSurface

const cases = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假 worker 子进程：按给定行为应答写入 stdin 的每一行 JSON 请求。 */
function makeFakeChild(behavior = 'ok') {
  const child = new EventEmitter()
  child.stdinWrites = []
  child.stdin = {
    write(s) {
      child.stdinWrites.push(String(s))
      const req = JSON.parse(String(s).trim())
      queueMicrotask(() => {
        if (behavior === 'garbage') { child.stdout.emit('data', Buffer.from('not-json\n')); return }
        if (behavior === 'die') { child.emit('close', 3); return }
        if (behavior === 'fail') {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ id: req.id, ok: false, error: 'edge-tts 403' }) + '\n'))
          return
        }
        // ok：MP3 负载与头分两个包发，且负载内故意含换行字节（二进制安全验证）
        const payload = Buffer.from([0xff, 0xfb, 0x0a, 0x90, req.id, 0x0a])
        const head = Buffer.from(JSON.stringify({ id: req.id, ok: true, bytes: payload.length }) + '\n', 'utf8')
        child.stdout.emit('data', head)
        // 负载拆两片发
        setTimeout(() => {
          child.stdout.emit('data', payload.subarray(0, 2))
          child.stdout.emit('data', payload.subarray(2))
        }, 5)
      })
    },
    end() {},
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => { child.killed = true }
  child.killed = false
  return child
}

function makeConn(behavior = 'ok') {
  const spawned = []
  const conn = new surface.EdgeTtsWorkerConn({
    python: 'fake-python',
    script: 'fake-worker.py',
    rate: '+45%',
    proxy: null,
    spawnImpl: (cmd, args) => { const c = makeFakeChild(behavior); spawned.push({ cmd, args, child: c }); return c },
  })
  return { conn, spawned }
}

cases.push(['worker：合成成功，头/负载分包 + 负载内换行字节都正确组装', async () => {
  const { conn, spawned } = makeConn('ok')
  const buf = await conn.synth('你好。', 'zh-CN-XiaoxiaoNeural', 10000)
  assert.equal(spawned.length, 1)
  assert.deepEqual(spawned[0].args, ['-u', 'fake-worker.py'])
  const req = JSON.parse(spawned[0].child.stdinWrites[0])
  assert.equal(req.text, '你好。')
  assert.equal(req.voice, 'zh-CN-XiaoxiaoNeural')
  assert.equal(req.rate, '+45%')
  assert.equal(buf.length, 6)
  assert.equal(buf[2], 0x0a, '负载里的换行字节不能被帧解析吃掉')
  conn.dispose()
  assert.equal(spawned[0].child.killed, true)
}])

cases.push(['worker：一条连接顺序处理多条请求', async () => {
  const { conn, spawned } = makeConn('ok')
  const [a, b] = await Promise.all([
    conn.synth('第一句。', 'v', 10000),
    conn.synth('第二句。', 'v', 10000),
  ])
  assert.equal(spawned.length, 1, '单连接只 spawn 一次')
  assert.equal(a.length, 6)
  assert.equal(b.length, 6)
  assert.equal(JSON.parse(spawned[0].child.stdinWrites[0]).text, '第一句。')
  assert.equal(JSON.parse(spawned[0].child.stdinWrites[1]).text, '第二句。')
  conn.dispose()
}])

cases.push(['worker：失败帧 → reject 带错误信息', async () => {
  const { conn } = makeConn('fail')
  await assert.rejects(conn.synth('任何文本', 'v', 10000), /403/)
  assert.equal(conn.isDead(), false, '单条失败不杀死连接（worker 语义：逐请求回错误帧）')
  // 后续请求照常
  conn.dispose()
}])

cases.push(['worker：进程退出 → 在途全部拒绝且连接判死', async () => {
  const { conn } = makeConn('die')
  await assert.rejects(conn.synth('你好', 'v', 10000), /退出/)
  assert.equal(conn.isDead(), true)
  await assert.rejects(conn.synth('再来', 'v', 10000), /已退出/)
  conn.dispose()
}])

cases.push(['worker：协议垃圾帧 → 协议错误（不挂死）', async () => {
  const { conn } = makeConn('garbage')
  await assert.rejects(conn.synth('你好', 'v', 10000), /协议错误/)
  conn.dispose()
}])

cases.push(['池：并发请求落到不同连接（size=2 轮转）', async () => {
  const children = []
  const pool = new surface.EdgeTtsWorkerPool({
    python: 'fake-python',
    rate: '+45%',
    proxy: null,
    size: 2,
    spawnImpl: (cmd, args) => { const c = makeFakeChild('ok'); children.push(c); return c },
  })
  const [a, b] = await Promise.all([
    pool.synth('甲句。', 'v', 10000),
    pool.synth('乙句。', 'v', 10000),
  ])
  assert.equal(children.length, 2, '两条并发 → 两条连接')
  assert.ok(a.length > 0 && b.length > 0)
  // 死连接被替换
  children[0].emit('close', 1)
  await sleep(10)
  const c = pool.synth('丙句。', 'v', 10000)
  await c
  assert.equal(children.length, 3, '死连接换掉并补新')
  pool.dispose()
  // children[0] 已因 close 事件判死并被池子丢弃（进程已退出，kill 本就是 no-op），后两条必须被杀
  assert.ok(children.slice(1).every((ch) => ch.killed === true))
}])

cases.push(['池：dispose 释放全部连接并拒绝在途请求', async () => {
  const children = []
  const pool = new surface.EdgeTtsWorkerPool({
    python: 'fake-python',
    rate: '+45%',
    proxy: null,
    size: 1,
    spawnImpl: (cmd, args) => {
      const c = new EventEmitter()
      c.stdin = { write() {}, end() {} }
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      c.kill = () => { c.killed = true }
      c.killed = false
      children.push(c)
      return c
    },
  })
  const pending = pool.synth('慢请求', 'v', 60000)
  const assertion = assert.rejects(pending, /已释放/)
  await sleep(10)
  pool.dispose()
  await assertion
  assert.equal(children[0].killed, true)
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
console.log(`PASS ${cases.length}/${cases.length} assistant-tts-worker`)
