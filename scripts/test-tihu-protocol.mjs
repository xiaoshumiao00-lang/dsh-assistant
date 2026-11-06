/**
 * 鹈鹕（tihu）P0 脚本级测试：协议 v0 合法性 / 未知消息容错 / 屏幕帧 / 三道闸 / lane 端到端。
 *
 *   node scripts/test-tihu-protocol.mjs
 *
 * 盯住这些边界（改了协议或闸门先看这里）：
 *   - 信封缺字段、坏 JSON、未知 type、超长文本 → 一律「忽略」（parse 返回 null），**绝不抛错**；
 *   - 字段只增不删：多余字段保留，旧字段少一个才判非法；
 *   - audio.frame 必须是 16k / 单声道 / 16 bit 的 WAV（P0 只认这一种）；
 *   - 屏帧要点行与 TTS 分段有上限（320×240 屏装不下长文本）；
 *   - 三道闸：危险动作才确认、超时按取消、写前快照落在 .tihu/snapshots、审计是 JSONL；
 *   - lane：hello 绑会话 + text.input 注入走 agents.followup（不是另建会话体系）。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TIHU_DOWNSTREAM_TYPES,
  TIHU_PROTOCOL_VERSION,
  TIHU_UPSTREAM_TYPES,
  buildDownstream,
  buildUpstream,
  isTihuEnvelope,
  looksLikeWavBase64,
  parseUpstream,
  summarizeForLog,
  toBullets,
  toTtsSegments,
} from '../src/tihu/protocol.ts'
import {
  appendAudit,
  classifyTool,
  createConfirmBroker,
  diffSummary,
  isReadOnlyCommand,
  readAudit,
  takeSnapshot,
  targetPathOf,
} from '../src/tihu/guard.ts'
import { createTihuRuntime, buildTihuUserMessage, TIHU_LANE_PATH, TIHU_PAGE_PATH } from '../src/tihu/lane.ts'
import { encodeFrame } from '../src/pocket-host/ws-deflate.mjs'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`)
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`)
  }
}

/** 一段最小合法 WAV 的 base64（44 字节头 + 16 个采样）。 */
function tinyWavBase64() {
  const samples = 16
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer.toString('base64')
}

/* ---------- 协议 ---------- */

console.log('[tihu] 协议 v0')

test('版本号与类型清单固定', () => {
  assert.equal(TIHU_PROTOCOL_VERSION, '0')
  assert.deepEqual([...TIHU_UPSTREAM_TYPES], ['hello', 'audio.frame', 'text.input', 'confirm.reply', 'session.end', 'ping'])
  assert.equal(TIHU_DOWNSTREAM_TYPES.length, 8)
  assert.equal(TIHU_PAGE_PATH, '/tihu')
  assert.equal(TIHU_LANE_PATH, '/tihu/lane')
})

test('hello：合法信封通过，多余字段保留（字段只增不删）', () => {
  const message = buildUpstream('hello', {
    clientId: 'web-1',
    clientVersion: 'p0-page-1',
    protocol: '0',
    capabilities: { microphone: false },
    sessionId: 'session-abc',
    futureField: '新固件带来的字段',
  }, 1)
  const parsed = parseUpstream(JSON.stringify(message))
  assert.ok(parsed !== null)
  assert.equal(parsed.type, 'hello')
  assert.equal(parsed.payload.sessionId, 'session-abc')
  assert.equal(parsed.payload.futureField, '新固件带来的字段')
})

test('未知 type / 坏 JSON / 缺字段 / 不是对象 → 一律 null，不抛错', () => {
  const valid = buildUpstream('ping', { nonce: '1' }, 2)
  const unknown = { ...valid, type: 'audio.opuS' }
  assert.equal(parseUpstream(JSON.stringify(unknown)), null)
  assert.equal(parseUpstream('{ 这不是 json'), null)
  assert.equal(parseUpstream(JSON.stringify({ ...valid, payload: undefined })), null)
  assert.equal(parseUpstream(JSON.stringify({ ...valid, v: '1' })), null)
  assert.equal(parseUpstream(JSON.stringify({ ...valid, id: '' })), null)
  assert.equal(parseUpstream(42), null)
  assert.equal(parseUpstream(null), null)
  assert.equal(parseUpstream('[]'), null)
})

test('audio.frame：必须是 16k / 单声道 / 16bit / WAV', () => {
  const wav = tinyWavBase64()
  assert.ok(looksLikeWavBase64(wav))
  const ok = buildUpstream('audio.frame', { format: 'wav', sampleRate: 16000, channels: 1, bits: 16, audioBase64: wav }, 3)
  assert.ok(parseUpstream(JSON.stringify(ok)) !== null)

  const wrongRate = buildUpstream('audio.frame', { format: 'wav', sampleRate: 44100, channels: 1, bits: 16, audioBase64: wav }, 4)
  assert.equal(parseUpstream(JSON.stringify(wrongRate)), null)
  const wrongFormat = buildUpstream('audio.frame', { format: 'opus', sampleRate: 16000, channels: 1, bits: 16, audioBase64: wav }, 5)
  assert.equal(parseUpstream(JSON.stringify(wrongFormat)), null)
  assert.equal(looksLikeWavBase64('AAAA'), false)
})

test('text.input / confirm.reply 的必填字段', () => {
  const text = buildUpstream('text.input', { text: '读一下 README', source: 'keyboard' }, 6)
  assert.ok(parseUpstream(JSON.stringify(text)) !== null)
  assert.equal(parseUpstream(JSON.stringify({ ...text, payload: { source: 'keyboard' } })), null)
  const confirm = buildUpstream('confirm.reply', { confirmId: 'confirm-1', approved: true }, 7)
  assert.ok(parseUpstream(JSON.stringify(confirm)) !== null)
  assert.equal(parseUpstream(JSON.stringify({ ...confirm, payload: { confirmId: 'confirm-1', approved: 'yes' } })), null)
})

test('信封校验：v/type/id/seq/ts/payload 缺一不可', () => {
  assert.equal(isTihuEnvelope({ v: '0', type: 'ping', id: 'x', seq: 1, ts: 2, payload: {} }), true)
  assert.equal(isTihuEnvelope({ v: '0', type: 'ping', id: 'x', seq: 1, ts: 2 }), false)
  assert.equal(isTihuEnvelope({ v: '1', type: 'ping', id: 'x', seq: 1, ts: 2, payload: {} }), false)
})

test('下行构造：seq 单调、ts 是数字、类型在清单里', () => {
  const first = buildDownstream('screen.frame', { stage: '聆听', title: 't', bullets: [] }, 1)
  const second = buildDownstream('event.done', { ok: true }, 2)
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)
  assert.equal(typeof first.id, 'string')
  assert.ok(Number.isFinite(first.ts))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes(first.type))
})

test('日志摘要不打印音频原文', () => {
  const summary = summarizeForLog({ type: 'audio.frame', id: 'x', payload: { audioBase64: 'UklGR'.repeat(100), format: 'wav' } })
  assert.ok(summary.includes('字符>'))
  assert.ok(!summary.includes('UklGRUklGR'))
})

test('屏帧要点行与 TTS 分段有上限', () => {
  const bullets = toBullets('第一句。第二句！第三句？第四句；第五句。第六句。', 4, 20)
  assert.ok(bullets.length <= 4)
  const long = '这是一个非常长的句子'.repeat(30)
  const segments = toTtsSegments(long, 4, 80)
  assert.ok(segments.length <= 4)
  assert.ok(segments.every((s) => s.length <= 100))
})

/* ---------- 三道闸 ---------- */

console.log('[tihu] 三道闸')

test('工具分类：写/改/删/命令/发送，覆盖才危险', () => {
  assert.equal(classifyTool('write', false).dangerous, false)
  assert.equal(classifyTool('write', true).dangerous, true)
  assert.equal(classifyTool('edit', true).dangerous, true)
  assert.equal(classifyTool('delete', false).dangerous, true)
  assert.equal(classifyTool('shell', false).dangerous, true)
  assert.equal(classifyTool('read').touchesFiles, false)
  assert.equal(classifyTool('read').dangerous, false)
  assert.equal(classifyTool('send_email').dangerous, true)
})

test('目标路径从参数里取（path / file_path）', () => {
  assert.equal(targetPathOf({ path: 'tmp/a.txt' }), 'tmp/a.txt')
  assert.equal(targetPathOf({ file_path: 'tmp/b.txt' }), 'tmp/b.txt')
  assert.equal(targetPathOf({}), undefined)
  assert.equal(targetPathOf(null), undefined)
})

/* 2026-11-06 P0 事故回归：语音注入后**只读命令必须放行**，只有真危险动作才要确认。 */
test('只读命令放行（查看 / 搜索 / git status|diff|log / 只读探测 curl）', () => {
  const readOnly = [
    'Get-ChildItem D:\\dsh-assistant',
    'ls -la',
    'dir',
    'Get-Content README.md -TotalCount 20',
    'cat package.json',
    'Select-String -Path src\\*.ts -Pattern tihu',
    'grep -n "foo" bar.txt',
    'git status',
    'git diff --stat',
    'git log --oneline -5',
    'git show HEAD',
    'git branch -a',
    'git config --get user.name',
    'curl -s http://127.0.0.1:3081/tihu',
    'ping -n 1 127.0.0.1',
    'Get-Process',
    'node --version',
    'npm ls --depth=0',
    'cd D:\\dsh-assistant; Get-ChildItem',
    'Get-ChildItem | Select-Object Name',
  ]
  for (const command of readOnly) {
    assert.equal(isReadOnlyCommand(command), true, `应判只读：${command}`)
    assert.equal(classifyTool('pwsh', undefined, command).dangerous, false, `不应危险：${command}`)
  }
})

test('危险命令仍拦（删除 / 写入 / 提权 / 发请求 / 跑脚本）', () => {
  const dangerous = [
    'Remove-Item -Recurse -Force build',
    'rm -rf build',
    'del a.txt',
    'Move-Item a.txt b.txt',
    'Set-Content -Path a.txt -Value "x"',
    'Get-ChildItem > out.txt',
    'Get-Content a.txt | Out-File b.txt',
    'git push origin main',
    'git reset --hard',
    'git checkout -b x',
    'npm install',
    'npm run build',
    'pip install requests',
    'curl -X POST http://example.com -d "a=1"',
    'curl -o out.bin http://example.com/x',
    'node -e "require(\'fs\').rmSync(\'x\')"',
    'sudo rm -rf /',
    'ssh root@1.2.3.4',
  ]
  for (const command of dangerous) {
    assert.equal(isReadOnlyCommand(command), false, `应判危险：${command}`)
    assert.equal(classifyTool('pwsh', undefined, command).dangerous, true, `应拦：${command}`)
  }
  // 拿不到命令原文（参数结构变了）时仍然 fail closed
  assert.equal(classifyTool('shell', undefined, undefined).dangerous, true)
  assert.equal(classifyTool('pwsh', undefined, '').dangerous, true)
})

test('session.end 是合法上行，缺少可选字段也能过', () => {
  const end = buildUpstream('session.end', { reason: 'button' }, 9)
  const parsed = parseUpstream(JSON.stringify(end))
  assert.ok(parsed !== null)
  assert.equal(parsed.type, 'session.end')
  assert.equal(parsed.payload.reason, 'button')
  const bad = { ...end, payload: { sessionId: 42 } }
  assert.equal(parseUpstream(JSON.stringify(bad)), null)
})


const workspace = mkdtempSync(join(tmpdir(), 'tihu-ws-'))
try {
  test('写前快照：复制到 .tihu/snapshots/<stamp>/ 且保留相对路径', () => {
    mkdirSync(join(workspace, 'tmp'), { recursive: true })
    writeFileSync(join(workspace, 'tmp', 'tihu-test.txt'), '第一版内容\n', 'utf8')
    const snapshot = takeSnapshot(workspace, 'tmp/tihu-test.txt', '20261106-220000-000')
    assert.equal(snapshot.copied, true)
    assert.equal(snapshot.existed, true)
    const copy = join(workspace, '.tihu', 'snapshots', '20261106-220000-000', 'tmp', 'tihu-test.txt')
    assert.ok(existsSync(copy))
    assert.equal(readFileSync(copy, 'utf8'), '第一版内容\n')
  })

  test('写前快照：新文件不复制但仍记录 not-found；越界拒绝', () => {
    const missing = takeSnapshot(workspace, 'tmp/not-yet.txt', 'stamp-2')
    assert.equal(missing.copied, false)
    assert.equal(missing.reason, 'not-found')
    const outside = takeSnapshot(workspace, '../../Windows/win.ini', 'stamp-3')
    assert.equal(outside.copied, false)
    assert.equal(outside.reason, 'outside-workspace')
  })

  test('审计：JSONL 一行一条，读回来字段完整', () => {
    appendAudit(workspace, { ts: '2026-11-06T14:00:00.000Z', source: 'tihu', sessionId: 's1', action: 'edit', tool: 'edit', target: 'tmp/tihu-test.txt', decision: 'allow', result: 'executed', diff: { added: 1, removed: 1 } })
    appendAudit(workspace, { ts: '2026-11-06T14:00:01.000Z', source: 'tihu', action: 'shell', tool: 'pwsh', decision: 'rejected' })
    const entries = readAudit(workspace)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].action, 'edit')
    assert.deepEqual(entries[0].diff, { added: 1, removed: 1 })
    assert.equal(entries[1].decision, 'rejected')
  })

  test('diff 摘要：+N / -M 行；未变化给「内容未变化」', () => {
    const changed = diffSummary('a\nb\nc\n', 'a\nB\nc\nd\n')
    assert.equal(changed.added, 3)
    assert.equal(changed.removed, 2)
    assert.ok(changed.summary.includes('+3 行'))
    assert.ok(changed.summary.includes('-2 行'))
    assert.equal(diffSummary('same\n', 'same\n').summary, '内容未变化')
  })

  await testAsync('确认：设备点确认 → approved；取消 → rejected；超时 → timeout', async () => {
    const seen = []
    const broker = createConfirmBroker({ onAsk: (request) => seen.push(request.id) })
    const approved = broker.ask({ title: '删除', detail: 'tmp/a.txt', timeoutMs: 1000 })
    assert.equal(seen.length, 1)
    assert.equal(broker.reply(seen[0], true), true)
    assert.equal((await approved).outcome, 'approved')

    const rejected = broker.ask({ title: '删除', detail: 'tmp/b.txt', timeoutMs: 1000 })
    assert.equal(broker.reply(seen[1], false), true)
    assert.equal((await rejected).outcome, 'rejected')

    const timedOut = await broker.ask({ title: '命令', detail: 'rm -rf', timeoutMs: 1000 })
    assert.equal(timedOut.outcome, 'timeout')

    const offline = broker.ask({ title: '命令', detail: 'x', timeoutMs: 5000 })
    broker.failAll('offline')
    assert.equal((await offline).outcome, 'offline')
    assert.equal(broker.pendingCount(), 0)
  })
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

/* ---------- lane 端到端（假 socket / 假 ctx） ---------- */

console.log('[tihu] lane 端到端')

/** 假 socket：收集写出的字节，能手动喂数据。 */
class FakeSocket extends EventEmitter {
  constructor() { super(); this.chunks = [] }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true }
  destroy() { this.emit('close') }
  setNoDelay() {}
  /** 取出所有 WebSocket 帧（跳过 HTTP 握手应答那一行）。 */
  frames() {
    const text = Buffer.concat(this.chunks).toString('latin1')
    const split = text.indexOf('\r\n\r\n')
    if (split === -1) return []
    const body = Buffer.concat(this.chunks).subarray(split + 4)
    const out = []
    let offset = 0
    while (offset + 2 <= body.length) {
      const len0 = body[offset + 1] & 0x7f
      let length = len0
      let header = 2
      if (len0 === 126) { length = body.readUInt16BE(offset + 2); header = 4 }
      const payload = body.subarray(offset + header, offset + header + length)
      out.push(payload.toString('utf8'))
      offset += header + length
    }
    return out
  }
}

function fakeCtx(overrides = {}) {
  const injected = []
  const events = []
  const ctx = {
    on(name, handler) { events.push({ name, handler }); return () => {} },
    get(id) {
      if (id === 'agents') return { get: (sessionId) => sessionId === 'session-1' ? { followup: (message) => injected.push(message) } : undefined }
      if (id === 'speechController') return { transcribe: async () => '读一下 README' }
      return undefined
    },
    ...overrides,
  }
  return { ctx, injected, events }
}

/** 造一条已掩码的客户端帧。 */
function clientFrame(message) {
  return encodeFrame({ fin: true, opcode: 1, payload: Buffer.from(JSON.stringify(message), 'utf8'), clientMask: true })
}

await testAsync('页面 HTML 包含 lane 地址与屏幕区', async () => {
  const { ctx } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {} })
  const html = runtime.page()
  assert.ok(html.includes('/tihu/lane'))
  assert.ok(html.includes('鹈鹕'))
  assert.ok(html.includes('speechSynthesis'))
  assert.ok(html.includes('audio.frame'))
  runtime.dispose()
})

await testAsync('lane：hello 绑会话 + text.input 走 agents.followup', async () => {
  const { ctx, injected, events } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {} })
  const socket = new FakeSocket()
  const req = { url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(runtime.handleUpgrade(req, socket, Buffer.alloc(0)), true)
  // 握手成功
  const handshake = Buffer.concat(socket.chunks).toString('latin1')
  assert.ok(handshake.startsWith('HTTP/1.1 101'))

  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'test', protocol: '0', sessionId: 'session-1', capabilities: { microphone: false } }, 1)))
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '读一下 README', source: 'keyboard' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(injected.length, 1)
  const message = injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, '读一下 README')
  assert.equal(typeof message.id, 'string')

  const frames = socket.frames().map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  assert.ok(frames.some((f) => f.type === 'screen.frame'))
  assert.ok(frames.some((f) => f.type === 'event.progress'))
  assert.ok(frames.some((f) => f.type === 'transcript'))
  // 事件监听挂在 tools 与 session 上
  assert.ok(events.some((e) => e.name === 'tools/pre-execute'))
  assert.ok(events.some((e) => e.name === 'session/event'))
  runtime.dispose()
})

await testAsync('lane：未知 type 被忽略，连接不断、不注入', async () => {
  const { ctx, injected } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {} })
  const socket = new FakeSocket()
  const req = { url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: { remoteAddress: '127.0.0.1' } }
  runtime.handleUpgrade(req, socket, Buffer.alloc(0))
  socket.emit('data', clientFrame({ v: '0', type: 'audio.opus', id: 'x', seq: 1, ts: 1, payload: {} }))
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 't', sessionId: 'session-1' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(injected.length, 0)
  runtime.dispose()
})

await testAsync('lane：没有会话时 text.input 只提示，不注入', async () => {
  const { ctx, injected } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {} })
  const socket = new FakeSocket()
  const req = { url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: { remoteAddress: '127.0.0.1' } }
  runtime.handleUpgrade(req, socket, Buffer.alloc(0))
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '你好' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(injected.length, 0)
  runtime.dispose()
})

await testAsync('lane：非 /tihu/lane 路径不接走（返回 false，交给原代理）', async () => {
  const { ctx } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {} })
  const socket = new FakeSocket()
  const req = { url: '/api/events.mux', headers: { 'sec-websocket-key': 'x' }, socket: {} }
  assert.equal(runtime.handleUpgrade(req, socket, Buffer.alloc(0)), false)
  runtime.dispose()
})

test('用户消息形状与 turn-guard 一致（进会话历史不会写坏日志）', () => {
  const message = buildTihuUserMessage('你好')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 10)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.deepEqual(message.content, [{ type: 'text', text: '你好' }])
})


{
  /**
   * 闸门归属回归：只有「tihu 注入那条消息开始的 turn」才受闸门约束。
   * - 只读 shell → 直接放行；
   * - 危险 shell + 设备不在线 → 立刻 deny（不再等 60 秒）；
   * - 用户自己发起的 turn（最后一条 user 消息不是注入的那条）→ 完全不管。
   */
  const mkAgent = (sessionId, userMessageId) => ({
    sessionId,
    session: {
      header: { cwd: process.cwd() },
      deriveMessages: () => [
        { id: 'old-user', role: 'user', content: [] },
        { id: 'assistant-1', role: 'assistant', content: [] },
        { id: userMessageId, role: 'user', content: [] },
      ],
    },
    followup() {},
  })

  const preHook = (ctx) => {
    const entry = ctx.__events.find((e) => e.name === 'tools/pre-execute')
    return entry.handler
  }

  await testAsync('闸门：tihu turn 里只读命令放行、危险命令设备离线立刻拒绝', async () => {
    const injected = []
    const events = []
    const agent = mkAgent('session-1', 'ignored')
    agent.followup = (message) => injected.push(message)
    const ctx = {
      on(name, handler) { events.push({ name, handler }); return () => {} },
      get(id) {
        if (id === 'agents') return { get: () => agent }
        return undefined
      },
      __events: events,
    }
    const runtime = createTihuRuntime(ctx, { log: () => {} })
    // 直接驱动一次注入：tihu 窗口点亮，注入的消息 id 进窗口
    const fakeSocket = new FakeSocket()
    runtime.handleUpgrade({ url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: {} }, fakeSocket, Buffer.alloc(0))
    fakeSocket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c1', protocol: '0', sessionId: 'session-1' }, 1)))
    const handler = preHook(ctx)

    fakeSocket.emit('data', clientFrame(buildUpstream('text.input', { text: '看一下 git 状态', source: 'voice' }, 2)))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(injected.length, 1, '应注入一条 tihu 消息')    // 会话里最后一条 user 消息 = tihu 刚注入的那条 → 属于 tihu turn
    agent.session.deriveMessages = () => [{ id: injected[0].id, role: 'user', content: [] }]

    // 只读命令：放行（next 被调用）
    let nextCalled = false
    const readonlyDecision = await handler(
      { name: 'pwsh', arguments: { command: 'git status' }, agent, callId: 'c-read' },
      async () => { nextCalled = true; return { kind: 'allow' } },
    )
    assert.equal(nextCalled, true)
    assert.equal(readonlyDecision.kind, 'allow')

    // 危险命令 + 设备掉线 → 立刻 deny，不等 60 秒超时
    fakeSocket.destroy() // 设备断开（页面关掉 / 手机没网）
    await new Promise((r) => setTimeout(r, 10))
    const started = Date.now()
    const deny = await handler(
      { name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force build' }, agent, callId: 'c-write' },
      async () => ({ kind: 'allow' }),
    )
    assert.equal(deny.kind, 'deny')
    assert.ok(String(deny.reason).includes('设备不在线'), `reason=${deny.reason}`)
    assert.ok(Date.now() - started < 1000, '设备离线不应等待 60 秒')
    runtime.dispose()
  })

  await testAsync('闸门：用户自己的 turn（最后一条 user 消息不是注入的）完全不受影响', async () => {
    const events = []
    const agent = mkAgent('session-1', 'user-typed-later')
    const ctx = {
      on(name, handler) { events.push({ name, handler }); return () => {} },
      get(id) {
        if (id === 'agents') return { get: () => agent }
        return undefined
      },
    }
    const runtime = createTihuRuntime(ctx, { log: () => {} })
    const fakeSocket = new FakeSocket()
    runtime.handleUpgrade({ url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: {} }, fakeSocket, Buffer.alloc(0))
    fakeSocket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c2', protocol: '0', sessionId: 'session-1' }, 1)))
    fakeSocket.emit('data', clientFrame(buildUpstream('text.input', { text: '随便说一句', source: 'voice' }, 2)))
    await new Promise((r) => setTimeout(r, 20))
    const handler = events.find((e) => e.name === 'tools/pre-execute').handler
    let nextCalled = false
    const decision = await handler(
      { name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force build' }, agent, callId: 'c-user' },
      async () => { nextCalled = true; return { kind: 'allow' } },
    )
    assert.equal(nextCalled, true)
    assert.equal(decision.kind, 'allow')
    runtime.dispose()
  })

  await testAsync('闸门：页面「结束本次语音会话」立即清除窗口', async () => {
    const events = []
    const injected = []
    const agent = mkAgent('session-1', 'ignored')
    agent.followup = (m) => injected.push(m)
    const ctx = {
      on(name, handler) { events.push({ name, handler }); return () => {} },
      get(id) {
        if (id === 'agents') return { get: () => agent }
        return undefined
      },
    }
    const runtime = createTihuRuntime(ctx, { log: () => {} })
    const fakeSocket = new FakeSocket()
    runtime.handleUpgrade({ url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: {} }, fakeSocket, Buffer.alloc(0))
    fakeSocket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c3', protocol: '0', sessionId: 'session-1' }, 1)))
    fakeSocket.emit('data', clientFrame(buildUpstream('text.input', { text: '帮我整理一下', source: 'voice' }, 2)))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(runtime.stats().activeSessions.includes('session-1'), true)
    fakeSocket.emit('data', clientFrame(buildUpstream('session.end', { reason: 'button' }, 3)))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(runtime.stats().activeSessions.includes('session-1'), false)
    // 结束后即便消息仍是注入的那条，也不再受闸门约束
    agent.session.deriveMessages = () => [{ id: injected[0]?.id ?? 'nope', role: 'user', content: [] }]
    const handler = events.find((e) => e.name === 'tools/pre-execute').handler
    let nextCalled = false
    await handler(
      { name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force build' }, agent, callId: 'c-after-end' },
      async () => { nextCalled = true; return { kind: 'allow' } },
    )
    assert.equal(nextCalled, true)
    runtime.dispose()
  })

  /* 2026-11-06 回归：speech.transcribe() 返回的是 Transcript 对象，不是字符串。
     旧实现 String(result) → 注入 "[object Object]"（实测 chars=15）。 */
  await testAsync('语音：Transcript 对象 → 纯文本（不再注入 [object Object]）', async () => {
    const injected = []
    const events = []
    const agent = mkAgent('session-1', 'ignored')
    agent.followup = (m) => injected.push(m)
    const ctx = {
      on(name, handler) { events.push({ name, handler }); return () => {} },
      get(id) {
        if (id === 'agents') return { get: () => agent }
        if (id === 'speechController') return {
          transcribe: async (input) => {
            assert.ok(input.audio instanceof Uint8Array, '应传 audio 字节，不是 base64')
            return { text: '对我做了介绍啊，那么我想说的是呢。', audioSeconds: 5.6, inferenceSeconds: 0.16 }
          },
        }
        return undefined
      },
    }
    const runtime = createTihuRuntime(ctx, { log: () => {} })
    const fakeSocket = new FakeSocket()
    runtime.handleUpgrade({ url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: {} }, fakeSocket, Buffer.alloc(0))
    fakeSocket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c4', protocol: '0', sessionId: 'session-1' }, 1)))
    fakeSocket.emit('data', clientFrame(buildUpstream('audio.frame', {
      format: 'wav', sampleRate: 16000, channels: 1, bits: 16, audioBase64: tinyWavBase64(), durationMs: 16,
    }, 2)))
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(injected.length, 1)
    assert.equal(injected[0].content[0].text, '对我做了介绍啊，那么我想说的是呢。')
    const transcriptFrame = fakeSocket.frames()
      .map((raw) => { try { return JSON.parse(raw) } catch { return null } })
      .find((frame) => frame?.type === 'transcript')
    assert.ok(transcriptFrame, '应下发 transcript 帧')
    assert.equal(transcriptFrame.payload.text, '对我做了介绍啊，那么我想说的是呢。')
    runtime.dispose()
  })
}

/* ---------- 汇总 ---------- */

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failed}`)
if (failed > 0) process.exit(1)
