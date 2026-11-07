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
import { WsFrameParser, encodeFrame } from '../src/pocket-host/ws-deflate.mjs'

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
  assert.deepEqual([...TIHU_UPSTREAM_TYPES], ['hello', 'audio.frame', 'text.input', 'confirm.reply', 'session.end', 'sessions.query', 'session.bind', 'ping'])
  assert.equal(TIHU_DOWNSTREAM_TYPES.length, 11)
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('sessions.list'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('session.bound'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('session.invalid'))
  assert.equal(TIHU_PAGE_PATH, '/tihu')
  assert.equal(TIHU_LANE_PATH, '/tihu/lane')
})

test('sessions.query / session.bind：字段合法才收，越界一律忽略', () => {
  const query = buildUpstream('sessions.query', { limit: 20, checkId: 'session-abc' }, 10)
  assert.ok(parseUpstream(JSON.stringify(query)) !== null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('sessions.query', {}, 11))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('sessions.query', { limit: 0 }, 12))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('sessions.query', { limit: 51 }, 13))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('sessions.query', { limit: 'x' }, 14))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('sessions.query', { checkId: 42 }, 15))), null)

  const bind = buildUpstream('session.bind', { sessionId: 'session-abc' }, 16)
  assert.ok(parseUpstream(JSON.stringify(bind)) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('session.bind', {}, 17))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('session.bind', { sessionId: '' }, 18))), null)
})

test('自动绑定：hello.auto 与 session.bind {auto:true}', () => {
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('hello', { clientId: 'c', auto: true }, 20))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('hello', { clientId: 'c', auto: 'yes' }, 21))), null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('session.bind', { auto: true }, 22))) !== null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('session.bind', { sessionId: 'session-x', auto: true }, 23))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('session.bind', { auto: false }, 24))), null)
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
      if (id === 'agents') return overrides.agents ?? { get: (sessionId) => sessionId === 'session-1' ? { followup: (message) => injected.push(message) } : undefined }
      if (id === 'speechController') return { transcribe: async () => '读一下 README' }
      if (id === 'sessions') return overrides.sessions
      if (id === 'sessionQuery') return overrides.sessionQuery
      if (id === 'sessionProjections') return overrides.sessionProjections
      if (id === 'sessionProjectionCache') return overrides.sessionProjectionCache
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
  // 2026-11-07 P0：公网 origin 下页面要能自己选会话（会话记忆只存本 origin 的 key）
  assert.ok(html.includes('dsh.tihu.session'), '页面要使用自己的会话 key')
  assert.ok(html.includes('sessions.query'), '页面要主动向宿主拉会话列表')
  assert.ok(html.includes('session.bind'), '页面点选后要能绑定会话')
  assert.ok(html.includes('还没有选定会话，点下面选一个'), '文案要可操作')
  assert.ok(html.includes('结束本次语音会话'), '保留结束本次语音会话按钮')
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

/* ---------- 2026-11-07 P0：页面自建会话选择（公网 origin 下不报「还没有会话」） ---------- */

/** 把 fake socket 的帧解析成 JSON 数组。 */
function framesOf(socket) {
  return socket.frames().map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}

/** 一条会话记录：header 带 agentPreset（回退用），projection 是投影缓存（权威）。 */
function cuRecord(id, options = {}) {
  const {
    createdAt = 0,
    lastPromptAt = 0,
    preset = 'computer-use',
    live = false,
    cwd = '/w',
    title = '标题:' + id,
  } = options
  return {
    header: { id, createdAt, cwd, agentPreset: preset },
    live,
    persisted: !live,
    projection: { title, agentPreset: preset, sessionListMetadata: { blank: false, lastPromptAt } },
  }
}

function sessionQueryFixture(records) {
  return {
    listSessions: async () => records.map(({ projection, ...record }) => record),
    readTitleSnapshots: async (ids) => ids.map((id) => ({ session: { id }, title: { title: '标题:' + id } })),
  }
}

function projectionCacheFixture(records) {
  const byId = new Map(records.map((record) => [record.header.id, record.projection ?? {}]))
  return {
    cachedSnapshot: (source) => ({ values: byId.get(source?.header?.id ?? source?.id) ?? {} }),
  }
}

function agentsFixture(ids) {
  const calls = []
  return {
    calls,
    agents: {
      get: (sessionId) => ids.includes(sessionId)
        ? { followup: (message) => calls.push({ sessionId, message }) }
        : undefined,
    },
  }
}

function runtimeFor(records, extras = {}) {
  const fixture = fakeCtx({
    sessionQuery: sessionQueryFixture(records),
    sessionProjectionCache: projectionCacheFixture(records),
    ...extras,
  })
  return { ...fixture, runtime: createTihuRuntime(fixture.ctx, { log: () => {} }) }
}

function openLane(runtime) {
  const socket = new FakeSocket()
  runtime.handleUpgrade({ url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: {} }, socket, Buffer.alloc(0))
  return socket
}

await testAsync('lane：sessions.query 只列 CU 会话，按活跃时间倒序，带 activeSessionId/check', async () => {
  const records = [
    cuRecord('session-standard', { createdAt: 100, lastPromptAt: 99999, preset: 'standard' }),
    cuRecord('session-old', { createdAt: 1000 }),
    cuRecord('session-new', { createdAt: 3000, lastPromptAt: 5000 }),
  ]
  const { runtime } = runtimeFor(records)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c1', protocol: '0' }, 1)))
  socket.emit('data', clientFrame(buildUpstream('sessions.query', { limit: 2, checkId: 'session-old' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 40))

  const list = framesOf(socket).find((frame) => frame.type === 'sessions.list')
  assert.ok(list, '应下发 sessions.list')
  assert.equal(list.payload.total, 3)
  assert.equal(list.payload.cuTotal, 2)
  assert.equal(list.payload.source, 'sessionQuery')
  assert.equal(list.payload.sessions.length, 2)
  // 标准模式即使更新也不进列表；CU 按 updatedAt 倒序
  assert.equal(list.payload.sessions[0].sessionId, 'session-new')
  assert.equal(list.payload.sessions[1].sessionId, 'session-old')
  assert.equal(list.payload.sessions[0].computerUse, true)
  assert.equal(list.payload.sessions[0].updatedAt, 5000)
  assert.equal(list.payload.activeSessionId, 'session-new')
  assert.deepEqual(list.payload.check, { sessionId: 'session-old', found: true, preset: 'computer-use', computerUse: true })
  runtime.dispose()
})

await testAsync('lane：hello 带一个不存在的会话 → session.invalid，页面不会被绑死', async () => {
  const records = [cuRecord('session-new', { createdAt: 3000, live: true })]
  const { runtime } = runtimeFor(records)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c2', protocol: '0', sessionId: 'session-404' }, 1)))
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '你好' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 40))

  const frames = framesOf(socket)
  const invalid = frames.find((frame) => frame.type === 'session.invalid')
  assert.ok(invalid, '应下发 session.invalid')
  assert.equal(invalid.payload.sessionId, 'session-404')
  assert.ok(invalid.payload.reason.includes('不存在'), invalid.payload.reason)
  assert.equal(invalid.payload.showPicker, true)
  // 绑定失败后 text.input 不能再注入（会话没绑上）→ 只提示「还没有选定会话」
  assert.ok(frames.some((frame) => frame.type === 'event.alert' && String(frame.payload.text).includes('还没有选定会话')))
  runtime.dispose()
})

await testAsync('lane：手动 session.bind 成功 → session.bound（CU 标记）', async () => {
  const records = [cuRecord('session-1', { createdAt: 3000, live: true })]
  const { runtime } = runtimeFor(records)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c3', protocol: '0' }, 1)))
  socket.emit('data', clientFrame(buildUpstream('session.bind', { sessionId: 'session-1' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const bound = framesOf(socket).find((frame) => frame.type === 'session.bound')
  assert.ok(bound, '应下发 session.bound')
  assert.equal(bound.payload.sessionId, 'session-1')
  assert.equal(bound.payload.title, '标题:session-1')
  assert.equal(bound.payload.live, true)
  assert.equal(bound.payload.computerUse, true)
  assert.equal(bound.payload.preset, 'computer-use')
  assert.ok(framesOf(socket).some((frame) => frame.type === 'screen.frame' && frame.payload.title.includes('标题:session-1')))
  runtime.dispose()
})

await testAsync('lane：hello {auto:true} 自动绑定最活跃的 CU 会话（标准模式再新也不选）', async () => {
  const records = [
    cuRecord('session-standard', { lastPromptAt: 99999, preset: 'standard' }),
    cuRecord('session-a', { lastPromptAt: 5000 }),
    cuRecord('session-b', { lastPromptAt: 9000 }),
  ]
  const { runtime } = runtimeFor(records)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c4', protocol: '0', auto: true }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 40))

  const bound = framesOf(socket).find((frame) => frame.type === 'session.bound')
  assert.ok(bound, '应自动下发 session.bound')
  assert.equal(bound.payload.sessionId, 'session-b')
  assert.equal(bound.payload.auto, true)
  assert.equal(bound.payload.computerUse, true)
  runtime.dispose()
})

await testAsync('lane：自动跟随——注入前最活跃 CU 变了就跟过去并注入新会话', async () => {
  const records = [
    cuRecord('session-a', { lastPromptAt: 5000, live: true }),
    cuRecord('session-b', { lastPromptAt: 9000, live: true }),
  ]
  const { agents, calls } = agentsFixture(['session-a', 'session-b'])
  const { runtime, events } = runtimeFor(records, { agents })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c5', protocol: '0', auto: true }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 40))
  // 初始自动绑定到最活跃的 b
  assert.equal(framesOf(socket).find((frame) => frame.type === 'session.bound').payload.sessionId, 'session-b')

  // 模拟用户在桌面端给 a 发了消息（活跃时间刷新）
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, {
    type: 'user/message',
    data: { source: { kind: 'user' } },
    time: Date.now() + 1000,
  })

  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '看下屏幕', source: 'voice' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 60))

  const bounds = framesOf(socket).filter((frame) => frame.type === 'session.bound')
  const follow = bounds[bounds.length - 1]
  assert.equal(follow.payload.sessionId, 'session-a')
  assert.equal(follow.payload.followed, true)
  assert.ok(framesOf(socket).some((frame) => frame.type === 'screen.frame' && frame.payload.title.includes('已自动跟随到')))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'session-a')
  runtime.dispose()
})

await testAsync('lane：手动绑定后不再自动漂移（即使别的 CU 会话更新）', async () => {
  const records = [
    cuRecord('session-a', { lastPromptAt: 5000, live: true }),
    cuRecord('session-b', { lastPromptAt: 9000, live: true }),
  ]
  const { agents, calls } = agentsFixture(['session-a', 'session-b'])
  const { runtime, events } = runtimeFor(records, { agents })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c6', protocol: '0', auto: true }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 40))
  socket.emit('data', clientFrame(buildUpstream('session.bind', { sessionId: 'session-a' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 30))

  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-b', header: { id: 'session-b' } }, {
    type: 'user/message',
    data: { source: { kind: 'user' } },
    time: Date.now() + 5000,
  })
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '继续', source: 'voice' }, 3)))
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'session-a', '手动绑定后不跟随')
  const bounds = framesOf(socket).filter((frame) => frame.type === 'session.bound')
  assert.equal(bounds[bounds.length - 1].payload.sessionId, 'session-a')
  assert.notEqual(bounds[bounds.length - 1].payload.followed, true)
  runtime.dispose()
})

await testAsync('lane：没有 CU 会话时给出可操作提示（自动绑定不硬绑非 CU）', async () => {
  const records = [cuRecord('session-standard', { lastPromptAt: 99999, preset: 'standard' })]
  const { runtime } = runtimeFor(records)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c7', protocol: '0', auto: true }, 1)))
  socket.emit('data', clientFrame(buildUpstream('sessions.query', { limit: 20 }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 50))

  const frames = framesOf(socket)
  assert.equal(frames.some((frame) => frame.type === 'session.bound'), false, '没有 CU 会话就不该绑定')
  assert.ok(frames.some((frame) => frame.type === 'event.alert' && String(frame.payload.text).includes('没有可自动绑定的 Computer Use 会话')))
  assert.ok(frames.some((frame) => frame.type === 'screen.frame' && frame.payload.title.includes('没有可自动绑定')))
  const list = frames.find((frame) => frame.type === 'sessions.list')
  assert.equal(list.payload.cuTotal, 0)
  assert.equal(list.payload.total, 1)
  assert.equal(list.payload.sessions.length, 0)
  assert.equal(list.payload.activeSessionId, undefined)
  runtime.dispose()
})

/* ---------- 2026-11-07 P0：Chrome 大消息分片（FIN=0 + continuation）必须重组 ---------- */

console.log('[tihu] WS 分片重组')

test('分片消息：FIN=0 起始帧 + continuation 帧 → 一次完整回调', () => {
  const message = JSON.stringify({ v: '0', type: 'audio.frame', id: 'x', seq: 1, ts: 2, payload: { format: 'wav', audioBase64: 'UklGR' + 'A'.repeat(2000) } })
  const half = Math.floor(message.length / 2)
  const first = encodeFrame({ fin: false, opcode: 0x1, payload: Buffer.from(message.slice(0, half)), clientMask: true })
  const second = encodeFrame({ fin: true, opcode: 0x0, payload: Buffer.from(message.slice(half)), clientMask: true })
  const frames = []
  const parser = new WsFrameParser((frame) => frames.push(frame), (error) => { throw error })
  // 逐块喂入，模拟 TCP 分片
  const all = Buffer.concat([first, second])
  for (let i = 0; i < all.length; i += 37) parser.push(all.subarray(i, i + 37))
  assert.equal(frames.length, 1, '两片应重组为一帧')
  assert.equal(frames[0].opcode, 0x1)
  assert.equal(frames[0].payload.toString('utf8'), message)
})

await testAsync('lane：分片到达的 audio.frame 也能触发转写（页面大帧不再静默丢）', async () => {
  const records = [cuRecord('session-1', { lastPromptAt: 5000, live: true })]
  const { runtime } = runtimeFor(records)
  const socket = openLane(runtime)
  const message = JSON.stringify({
    v: '0', type: 'audio.frame', id: 'dev-frag', seq: 2, ts: Date.now(),
    payload: { format: 'wav', sampleRate: 16000, channels: 1, bits: 16, audioBase64: tinyWavBase64(), durationMs: 16 },
  })
  const cut = 60
  const first = encodeFrame({ fin: false, opcode: 0x1, payload: Buffer.from(message.slice(0, cut)), clientMask: true })
  const second = encodeFrame({ fin: true, opcode: 0x0, payload: Buffer.from(message.slice(cut)), clientMask: true })
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'cf', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  socket.emit('data', Buffer.concat([first, second]))
  await new Promise((resolve) => setTimeout(resolve, 120))

  const frames = framesOf(socket)
  assert.ok(frames.some((frame) => frame.type === 'screen.frame' && frame.payload.stage === '聆听'), '应进入转写')
  assert.ok(frames.some((frame) => frame.type === 'transcript'), '应回 transcript')
  runtime.dispose()
})

await testAsync('页面 HTML 含自动模式/跟随/恢复自动/模式徽标', async () => {
  const { runtime } = runtimeFor([])
  const html = runtime.page()
  assert.ok(html.includes('dsh.tihu.session'))
  assert.ok(html.includes('sessions.query'))
  assert.ok(html.includes("send('session.bind', { auto: true })"), '页面要能切回自动')
  assert.ok(html.includes('已自动跟随到'), '跟随提示')
  assert.ok(html.includes('（自动）'), '模式徽标')
  assert.ok(html.includes('（手动）'))
  assert.ok(html.includes('恢复自动'))
  assert.ok(html.includes('没有可自动绑定的 CU 会话'))
  assert.ok(html.includes('结束本次语音会话'))
  // 音频兜底：不能干等
  assert.ok(html.includes('转写超时'))
  assert.ok(html.includes('已上行，等待转写'))
  assert.ok(html.includes('连接已断开，2 秒后自动重连'))
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
