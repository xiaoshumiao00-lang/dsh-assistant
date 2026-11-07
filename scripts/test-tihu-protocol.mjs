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
import {
  applySessionEvent,
  clipText,
  confirmationFrame,
  createProgressState,
  describeTool,
  formatElapsed,
  sanitizeScreenLine,
  summarizeToolResult,
} from '../src/tihu/progress.ts'
import { ACTUAL_SIZE_SCALE, SCREEN_SPEC, clipScreenTitle, fitScreenLines } from '../src/tihu/screen-spec.ts'
import { fitViewport, replyViewport, replyWindow, splitReplySentences, splitSpeechSegments, wrapReplyLines } from '../src/tihu/reply.ts'
import { Pcm16Chunker, TTS_CHUNK_BYTES, TTS_SAMPLE_RATE, validateReferenceWav } from '../src/tihu/audio.ts'
import { normalizeVoiceName } from '../src/tihu/tts.ts'
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
  assert.deepEqual([...TIHU_UPSTREAM_TYPES], ['hello', 'audio.frame', 'text.input', 'confirm.reply', 'session.end', 'sessions.query', 'session.bind', 'voice.list', 'voice.create', 'voice.select', 'ping'])
  assert.equal(TIHU_DOWNSTREAM_TYPES.length, 14)
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('tts.audio'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('sessions.list'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('session.bound'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('session.invalid'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('voice.list'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('voice.created'))
  assert.equal(TIHU_PAGE_PATH, '/tihu')
  assert.equal(TIHU_LANE_PATH, '/tihu/lane')
})

test('voice.list / voice.create / voice.select 字段校验', () => {
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('voice.list', {}, 30))) !== null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('voice.create', { name: 'my_voice', wavBase64: 'UklGR' }, 31))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('voice.create', { name: 'bad name!', wavBase64: 'UklGR' }, 32))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('voice.create', { name: 'ok', wavBase64: '' }, 33))), null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('voice.select', { name: 'default' }, 34))) !== null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('voice.select', { name: 'default', edgeVoice: 'zh-CN-YunjianNeural' }, 36))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('voice.select', { name: 'default', edgeVoice: 123 }, 37))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('voice.select', { name: '' }, 35))), null)
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
  const long = '这是一个非常长的句子'.repeat(150) // 1500 字、无标点
  const segments = toTtsSegments(long, 80)
  assert.ok(segments.length > 4, '1500 字不能只切 4 段')
  assert.equal(segments.length, 19, '1500 / 80 → 19 段（18×80 + 60）')
  assert.ok(segments.every((s) => s.length <= 80))
  assert.equal(segments.join(''), long, '不能丢字')
  assert.ok(segments[0].startsWith('这是一个非常长的句子'))
  assert.ok(segments[segments.length - 1].endsWith('这是一个非常长的句子'))
})

test('toTtsSegments：1500 字带标点必须切出 >4 段、首尾都在、index/total 可连续', () => {
  const sentence = '第一段内容比较长但还在八十个字以内，用来验证切分会按句号断开来保证朗读自然；'
  const text = sentence.repeat(30).slice(0, 1500)
  const segments = toTtsSegments(text)
  assert.ok(segments.length > 4, `段数 ${segments.length} 应大于 4`)
  assert.ok(segments[0].length > 0 && segments[segments.length - 1].length > 0)
  assert.equal(segments.join(''), text.replace(/\s+/g, ' ').trim(), '首尾/中间都不能丢')
  // index/total 就是数组下标：从 0 到 total-1 连续
  const total = segments.length
  segments.forEach((segment, index) => {
    assert.equal(segment, segments[index])
    assert.ok(index >= 0 && index < total)
    assert.ok(segment.length <= 80, `第 ${index} 段 ${segment.length} 字超过 80`)
  })
})

test('toTtsSegments：无标点超长单句仍硬切，不丢字', () => {
  const text = '无'.repeat(300)
  const segments = toTtsSegments(text)
  assert.equal(segments.length, 4, '300 / 80 → 80+80+80+60')
  assert.deepEqual(segments.map((s) => s.length), [80, 80, 80, 60])
  assert.equal(segments.join(''), text)
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
  assert.ok(!html.includes('speechSynthesis'), '页面必须彻底移除 speechSynthesis')
  assert.ok(html.includes('edgeVoiceSelect'), '页面要有兜底音色下拉')
  assert.ok(html.includes('tihu.edgeVoice'), '兜底音色要持久化到 localStorage')
  assert.ok(html.includes('zh-CN-YunjianNeural'), '默认兜底音色是云健')
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

function runtimeFor(records, extras = {}, ttsOptions = {}) {
  const fixture = fakeCtx({
    sessionQuery: sessionQueryFixture(records),
    sessionProjectionCache: projectionCacheFixture(records),
    ...extras,
  })
  return { ...fixture, runtime: createTihuRuntime(fixture.ctx, { log: () => {}, tts: { disabled: true, ...ttsOptions } }) }
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

await testAsync('lane：长回复的 TTS 段全部下发（不再丢 320 字以后），index/total 连续', async () => {
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })])
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'tts', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))

  const text = '这是一段用于验证朗读完整性的长文本，'.repeat(60)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const frames = framesOf(socket).filter((frame) => frame.type === 'tts.text')
  assert.ok(frames.length > 4, `应切出 >4 段，实际 ${frames.length}`)
  assert.deepEqual(frames.map((frame) => frame.payload.index), [...Array(frames.length).keys()], 'index 从 0 连续')
  assert.ok(frames.every((frame) => frame.payload.total === frames.length), 'total 必须一致')
  assert.equal(frames.map((frame) => frame.payload.text).join(''), text.replace(/\s+/g, ' ').trim(), '不能丢字')
  runtime.dispose()
})

/* ---------- 降级链：GPU 不可用 / SAPI 失败 ---------- */

function fakeTts({ model = 'Windows SAPI', fail = false } = {}) {
  return {
    async ensureServer() {},
    status: () => ({ available: true, model }),
    engineLabel: (voice) => model === 'Windows SAPI' ? '离线兜底：Windows SAPI Huihui' : ('本地 TTS：' + model + ' / 音色 ' + voice),
    takeEngineNote: () => '',
    deviceFallback: () => '',
    available: () => true,
    async synthesize(_text, options) {
      if (fail) throw new Error('SAPI 无法发声')
      options.onChunk({ data: Buffer.alloc(4800), seq: 0, total: 1, final: true })
    },
    async createVoice() { throw new Error('n/a') },
    async listVoices() { return [{ name: 'default', kind: 'default' }] },
    dispose() {},
  }
}

await testAsync('lane：GPU 不可用 → 直接 SAPI，不出现 CPU 引擎', async () => {
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'sapi', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第一句。第二句。' }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const frames = framesOf(socket)
  const progress = frames.filter((frame) => frame.type === 'event.progress').map((frame) => frame.payload.text)
  assert.ok(progress.includes('离线兜底：Windows SAPI Huihui'), `引擎标识应为 SAPI，实际 ${progress.join(' | ')}`)
  assert.ok(frames.some((frame) => frame.type === 'tts.audio'), 'SAPI 也要下发 tts.audio')
  assert.ok(!frames.some((frame) => JSON.stringify(frame.payload).includes('qwen')), '不能再出现 GPU/CPU 引擎标识')
  runtime.dispose()
})

await testAsync('lane：SAPI 也失败 → error alert，屏幕仍保留 reply 正文', async () => {
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: fakeTts({ fail: true }) })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'sapi-fail', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第一句。第二句。' }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const frames = framesOf(socket)
  const alerts = frames.filter((frame) => frame.type === 'event.alert').map((frame) => frame.payload)
  assert.ok(alerts.some((alert) => alert.level === 'error' && String(alert.text).includes('所有本地 TTS 均不可用')), '必须发 error alert')
  const screens = frames.filter((frame) => frame.type === 'screen.frame')
  const last = screens[screens.length - 1].payload
  assert.equal(last.mode, 'reply')
  assert.ok(Array.isArray(last.reply.sentences) && last.reply.sentences.length > 0, '屏幕正文不能清掉')
  runtime.dispose()
})

/* ---------- 屏幕进度映射 ---------- */

console.log('[tihu] 屏幕进度映射')

test('工具名 → 人话标题（读取/写入/修改/搜索/执行/联网查）', () => {
  const read = describeTool('read', { file_path: 'D:\\proj\\src\\README.md' })
  assert.equal(read.stage, '读文件')
  assert.equal(read.title, '读取 README.md')
  const write = describeTool('write_file', { path: '/tmp/a.txt' })
  assert.equal(write.stage, '写文件')
  assert.equal(write.title, '写入 a.txt')
  const edit = describeTool('apply_patch', { file_path: 'a/b/c.ts' })
  assert.equal(edit.stage, '写文件')
  assert.equal(edit.title, '修改 c.ts')
  const grep = describeTool('Grep', { pattern: 'tihu' })
  assert.equal(grep.stage, '搜索')
  assert.equal(grep.title, '搜索 tihu')
  const shell = describeTool('pwsh', { command: 'Get-ChildItem D:\\dsh-assistant\\src' })
  assert.equal(shell.stage, '跑命令')
  assert.ok(shell.title.startsWith('执行 Get-ChildItem'))
  assert.ok([...shell.title].length <= 28, '标题不超过 28 字')
  const web = describeTool('web_search', { query: 'ESP32-S3-BOX-3' })
  assert.equal(web.stage, '搜索')
  assert.equal(web.title, '联网查 ESP32-S3-BOX-3')
  const other = describeTool('computer_use', { task: '打开浏览器' })
  assert.equal(other.stage, '思考')
  assert.equal(other.title, 'computer_use')
  // 超长参数截断且不出现半字
  const long = describeTool('pwsh', { command: 'x'.repeat(200) })
  assert.ok([...long.title].length <= 28)
  assert.ok([...long.detail].length <= 120)
})

test('进度状态机：步骤递增、失败 tone=alert、完成帧保留、正文最多 3 行', () => {
  const state = createProgressState(1000)
  const events = []
  const push = (event, now) => { const update = applySessionEvent(state, event, now); events.push(update); return update }

  assert.equal(push({ type: 'turn/start', data: { turn: 7 } }, 1000).screen.title, '开始新一轮')
  assert.equal(state.step, 0)
  // 第 1 步：读文件成功
  push({ type: 'step/start', data: { turn: 7, step: 1 } }, 2000)
  const call1 = push({ type: 'tool/call', data: { turn: 7, step: 1, name: 'read', arguments: { file_path: 'src/a.ts' } } }, 3000)
  assert.equal(call1.screen.stage, '读文件')
  assert.equal(call1.screen.title, '读取 a.ts')
  assert.ok(call1.screen.bullets[0].includes('第 1 步'))
  push({ type: 'tool/result', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'const a = 1\n第二个文件结尾' }], isError: false } } }, 4000)
  assert.equal(state.tone, 'ok')
  assert.ok(state.lastResult.line.startsWith('✓'))
  assert.ok([...state.lastResult.line].length <= 18)

  // 第 2 步：跑命令失败
  push({ type: 'step/start', data: { turn: 7, step: 2 } }, 5000)
  const call2 = push({ type: 'tool/call', data: { turn: 7, step: 2, name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force build-with-a-very-long-name-here' } } }, 6000)
  assert.equal(call2.screen.stage, '跑命令')
  push({ type: 'tool/result', data: { turn: 7, step: 2, message: { content: [{ type: 'text', text: '拒绝访问：文件被占用（详细信息在日志里）' }], isError: true } } }, 7000)
  assert.equal(state.tone, 'alert')
  assert.ok(state.lastResult.line.startsWith('✗'))
  assert.ok([...state.lastResult.line].length <= 18)

  // 回答
  const answer = push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一行回答\n最后一行是输出尾行' }] } } }, 8000)
  assert.equal(answer.screen.stage, '回答')
  assert.ok(answer.screen.title.startsWith('回答 第一行回答'))
  assert.ok(answer.screen.bullets.length <= 3)
  for (const line of answer.screen.bullets) assert.ok([...line].length <= 18, `行超长：${line}`)

  // 结束帧：保留「完成 · 共 N 步 · 用时 Xs」，正文只留结果行（不重复标题、不带陈旧输出）
  const done = push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }, 13000)
  assert.ok(done.screen.title.startsWith('完成 · 共 2 步'))
  assert.ok(done.screen.title.includes('12s'))
  assert.equal(done.screen.tone, 'ok')
  assert.equal(done.screen.bullets.length, 1, '完成帧只保留结果一行')
  assert.equal(done.screen.bullets[0], '✓ 已生成回复')
  assert.ok(!done.screen.bullets.some((line) => line.includes('共 2 步')), '正文不重复标题')
  assert.ok(!done.screen.bullets.some((line) => line.includes('第二个文件结尾')), '不带陈旧 stdout 尾行')

  // 异常结束：tone=alert、正文给失败原因
  const failed = push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'error' } } }, 14000)
  assert.equal(failed.screen.tone, 'alert')
  assert.equal(failed.screen.bullets.length, 1)
  assert.ok(failed.screen.bullets[0].startsWith('✗'))
})

test('屏幕文本截断：40 字标题省略到 28 字内，5 行正文只留 3 行', () => {
  const title = clipText('这是一个非常非常长的标题'.repeat(3), 28)
  assert.ok([...title].length <= 28)
  assert.ok(title.endsWith('…'))
  const lines = ['第一行', '第二行', '第三行', '第四行', '第五行']
  const bullets = lines.slice(0, 3).map((line) => clipText(line, 18))
  assert.deepEqual(bullets, ['第一行', '第二行', '第三行'])
  assert.equal(formatElapsed(12500), '13s')
  assert.equal(formatElapsed(65000), '1m05s')
  assert.equal(confirmationFrame('删除文件', 'tmp/a.txt').stage, '等待确认')
  assert.equal(summarizeToolResult('ok\nlast line', false).output, 'last line')
  // 屏幕摘要去掉 markdown 噪音
  assert.equal(sanitizeScreenLine('```json'), '')
  assert.equal(sanitizeScreenLine('**粗体** 与 `代码`'), '粗体 与 代码')
  const fenced = summarizeToolResult('```\n结果行\n```', false)
  assert.equal(fenced.line, '✓ 结果行')
})

await testAsync('lane：执行事件生成有料的屏幕帧（读文件→跑命令→回答→完成）', async () => {
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true })])
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'prog', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, event)
  emit({ type: 'turn/start', data: { turn: 3 } })
  emit({ type: 'step/start', data: { turn: 3, step: 1 } })
  emit({ type: 'tool/call', data: { turn: 3, step: 1, name: 'read', arguments: { file_path: 'README.md' } } })
  emit({ type: 'tool/result', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '第一行结果\n最后一行输出' }], isError: false } } })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，我看完了。\n结论在最后。' }] } } })
  emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'stop' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame').map((frame) => frame.payload)
  assert.ok(screens.some((frame) => frame.stage === '读文件' && frame.title === '读取 README.md'))
  const resultFrame = screens.find((frame) => frame.bullets.some((line) => line.startsWith('✓')))
  assert.ok(resultFrame, '结果帧应带 ✓ 摘要')
  assert.ok(resultFrame.bullets.some((line) => line.includes('最后一行输出')))
  const progressTexts = framesOf(socket).filter((frame) => frame.type === 'event.progress').map((frame) => frame.payload.text)
  assert.ok(progressTexts.some((text) => text.includes('读取 README.md')))
  assert.ok(progressTexts.some((text) => text.startsWith('✓')))
  const last = screens[screens.length - 1]
  // 有 assistant 消息后进入 reply 模式；turn/end 不再用「完成」状态帧覆盖正文。
  assert.equal(last.mode, 'reply')
  assert.equal(last.stage, '回答中')
  assert.ok(Array.isArray(last.reply.sentences) && last.reply.sentences.length > 0)
  assert.equal(last.reply.currentIndex, 0)
  runtime.dispose()
})

test('真机屏幕规格：320×240 常量 + 标题/正文截断', () => {
  assert.equal(SCREEN_SPEC.widthPx, 320)
  assert.equal(SCREEN_SPEC.heightPx, 240)
  assert.equal(SCREEN_SPEC.paddingPx, 8)
  assert.equal(SCREEN_SPEC.bodyFontPx, 16)
  assert.equal(SCREEN_SPEC.bodyLineHeightPx, 20)
  assert.equal(SCREEN_SPEC.bodyCharsPerLine, 18)
  assert.equal(SCREEN_SPEC.maxBodyLines, 3)
  assert.equal(SCREEN_SPEC.titleChars, 28)
  assert.equal(SCREEN_SPEC.stageFontPx, 12)
  assert.ok(ACTUAL_SIZE_SCALE > 0.7 && ACTUAL_SIZE_SCALE < 0.75, `实际尺寸缩放 ${ACTUAL_SIZE_SCALE}`)

  // 40 字标题 → 28 字内（含省略号）；不出现半个字
  const title = clipScreenTitle('这是一个非常长的标题'.repeat(4))
  assert.ok([...title].length <= 28)
  assert.ok(title.endsWith('…'))
  assert.equal(clipScreenTitle('短标题'), '短标题')

  // 5 行正文只保留前 3 行，每行 ≤18 字
  const five = ['一', '二', '三', '四', '五'].map((line) => line.repeat(20))
  const fitted = fitScreenLines(five)
  assert.equal(fitted.length, 3)
  for (const line of fitted) assert.ok([...line].length <= 18)
  assert.deepEqual(fitScreenLines(['a', '', 'b', 'c', 'd']), ['a', 'b', 'c'])
})

await testAsync('页面包含真机外壳/320×240 固定尺寸/三档缩放/外壳开关', async () => {
  const { runtime } = runtimeFor([])
  const html = runtime.page()
  assert.ok(html.includes('ESP32-S3-BOX-3B · 2.4″ · 320×240 · 触摸屏'))
  assert.ok(html.includes('width:320px') && html.includes('height:240px'), '屏幕固定 320×240')
  assert.ok(html.includes('data-scale="1"') && html.includes('data-scale="2"') && html.includes('data-scale="actual"'))
  assert.ok(html.includes('实际尺寸'))
  assert.ok(html.includes('仅屏幕') && html.includes('shell-off'))
  assert.ok(html.includes('class="mics"') && html.includes('class="grille"') && html.includes('class="dock"'))
  runtime.dispose()
})

await testAsync('lane：turn/end 的 done.ok/tone——completed→true+ok，error→false+alert', async () => {
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true })])
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'end', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, event)

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好了' }] } } })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  let dones = framesOf(socket).filter((frame) => frame.type === 'event.done')
  let screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  assert.equal(dones[0].payload.ok, true, 'completed 必须 ok:true')
  assert.equal(dones[0].payload.text, '本轮完成')
  assert.equal(dones[0].payload.sessionId, 'session-1')
  assert.equal(screens[screens.length - 1].payload.tone, 'ok')

  emit({ type: 'turn/start', data: { turn: 2 } })
  emit({ type: 'tool/call', data: { turn: 2, step: 1, name: 'pwsh', arguments: { command: 'exit 1' } } })
  emit({ type: 'tool/result', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '命令失败：权限不足' }], isError: true } } })
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  dones = framesOf(socket).filter((frame) => frame.type === 'event.done')
  screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  assert.equal(dones[dones.length - 1].payload.ok, false, 'error 必须 ok:false')
  assert.equal(dones[dones.length - 1].payload.sessionId, 'session-1')
  const lastScreen = screens[screens.length - 1].payload
  assert.equal(lastScreen.tone, 'alert')
  assert.equal(lastScreen.bullets.length, 1)
  assert.ok(lastScreen.bullets[0].startsWith('✗'))
  runtime.dispose()
})

/* ---------- 本地 TTS：PCM 分块 / 参考音频 ---------- */

console.log('[tihu] 本地 TTS 音频')

/** 造一个标准 PCM WAV。 */
function makeWav({ sampleRate = 24000, channels = 1, bits = 16, ms = 5000 } = {}) {
  const samples = Math.round((sampleRate * ms) / 1000)
  const dataBytes = samples * channels * (bits / 8)
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * (bits / 8), 28)
  buffer.writeUInt16LE(channels * (bits / 8), 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE((i % 200) - 100, 44 + i * 2)
  return buffer
}

test('PCM 分块：120ms 固定块、偶数字节、不丢帧、只有最后一块 final', () => {
  const chunker = new Pcm16Chunker()
  const input = Buffer.alloc(TTS_CHUNK_BYTES * 3 + 1000, 0x5a)
  const emitted = []
  for (const piece of [input.subarray(0, 1000), input.subarray(1000, 9000), input.subarray(9000)]) {
    for (const chunk of chunker.push(piece)) emitted.push({ data: chunk, final: false })
  }
  for (const chunk of chunker.finish()) emitted.push(chunk)
  assert.ok(emitted.every((chunk) => chunk.data.length % 2 === 0), '块必须按 16bit 偶数边界')
  for (let i = 0; i < emitted.length - 1; i += 1) {
    assert.equal(emitted[i].data.length, TTS_CHUNK_BYTES, `第 ${i} 块应满 120ms`)
    assert.equal(emitted[i].final, false)
  }
  assert.equal(emitted[emitted.length - 1].final, true)
  assert.equal(emitted.filter((chunk) => chunk.final).length, 1)
  assert.deepEqual(Buffer.concat(emitted.map((chunk) => chunk.data)), input, '拼回来不能丢字节/错位')
  assert.equal(emitted.reduce((sum, chunk) => sum + chunk.data.length, 0), input.length)
})

test('PCM 分块：任意 TCP 分片边界都等价', () => {
  const input = Buffer.alloc(TTS_CHUNK_BYTES * 2 + 334, 1)
  const collect = (sizes) => {
    const chunker = new Pcm16Chunker()
    const out = []
    let offset = 0
    for (const size of sizes) {
      out.push(...chunker.push(input.subarray(offset, offset + size)))
      offset += size
    }
    out.push(...chunker.push(input.subarray(offset)))
    const tail = chunker.finish().map((chunk) => chunk.data)
    return Buffer.concat([...out, ...tail])
  }
  assert.deepEqual(collect([1, 2, 3, 5000, 7000, 9000]), input)
  assert.deepEqual(collect([input.length]), input)
  assert.deepEqual(collect(Array(input.length).fill(1)), input)
})

test('参考音频校验：3–10 秒、单声道 16bit、16k/24k', () => {
  assert.equal(normalizeVoiceName('my_voice-1'), 'my_voice-1')
  assert.equal(normalizeVoiceName('default'), null)
  assert.equal(normalizeVoiceName('bad name'), null)
  assert.equal(normalizeVoiceName('中文'), null)

  const ok24 = validateReferenceWav(makeWav({ sampleRate: 24000, ms: 5000 }))
  assert.equal(ok24.ok, true)
  const ok16 = validateReferenceWav(makeWav({ sampleRate: 16000, ms: 8000 }))
  assert.equal(ok16.ok, true)
  const tooShort = validateReferenceWav(makeWav({ ms: 2000 }))
  assert.equal(tooShort.ok, false)
  assert.ok(tooShort.reason.includes('3–10'))
  const stereo = validateReferenceWav(makeWav({ channels: 2 }))
  assert.equal(stereo.ok, false)
  const wrongRate = validateReferenceWav(makeWav({ sampleRate: 44100 }))
  assert.equal(wrongRate.ok, false)
  const notWav = validateReferenceWav(Buffer.from('not a wav at all'))
  assert.equal(notWav.ok, false)
})

test('TTS 采样率与块长常量符合协议', () => {
  assert.equal(TTS_SAMPLE_RATE, 24000)
  assert.equal(TTS_CHUNK_BYTES, 24000 * 2 * 0.12)
})

test('回复分句与滚动窗口：800 字下标连续、窗口居中、行不越界', () => {
  const text = ('这是一段用于测试滚动窗口的中文回复内容，需要足够长才能触发分句与滚动。').repeat(20).slice(0, 800)
  const sentences = splitReplySentences(text)
  assert.ok(sentences.length > 10, `800 字至少切出 10 句，实际 ${sentences.length}`)
  // 下标首尾相接、无缝、从 0 开始
  assert.equal(sentences[0].start, 0)
  for (let i = 1; i < sentences.length; i += 1) {
    assert.equal(sentences[i].start, sentences[i - 1].end, `第 ${i} 句起点应等于上一句终点`)
  }
  assert.equal(sentences[sentences.length - 1].end <= 800, true)
  assert.equal(sentences.map((sentence) => sentence.text).join(''), text.replace(/\s+/g, ' ').trim())

  // 中间句窗口 ±2，当前句在中间
  const middle = 10
  const window = replyWindow(sentences, middle, 2)
  assert.equal(window[0].index, middle - 2)
  assert.equal(window[window.length - 1].index, middle + 2)
  // 边界不越界
  assert.equal(replyWindow(sentences, 0, 2)[0].index, 0)
  assert.equal(replyWindow(sentences, sentences.length - 1, 2).slice(-1)[0].index, sentences.length - 1)

  // 可视窗口：10 行、当前句居中、每行 ≤18 字
  const viewport = replyViewport(sentences, middle)
  assert.ok(viewport.lines.length <= 10)
  for (const line of viewport.lines) assert.ok([...line.text].length <= 18, `行超长：${line.text}`)
  assert.ok(viewport.currentLine >= 3 && viewport.currentLine <= 6, `当前句应在中部，实际第 ${viewport.currentLine} 行`)
  assert.ok(viewport.lines[viewport.currentLine].sentenceIndex === middle)

  // 行拼起来不丢字（窗口内）
  const wrapped = wrapReplyLines(replyWindow(sentences, middle), 18)
  assert.equal(wrapped.map((line) => line.text).join(''), replyWindow(sentences, middle).map((s) => s.text.replace(/\s+/g, ' ').trim()).join(''))

  // 空文本
  assert.deepEqual(splitReplySentences(''), [])
  assert.deepEqual(fitViewport([], 0).lines, [])
  assert.equal(SCREEN_SPEC.replyVisibleLines, 10)
})

test('TTS 分段带字符区间：tts.text 的 charStart/charEnd 与句边界一致', () => {
  const text = '第一句。第二句！第三句？'
  const sentences = splitReplySentences(text)
  assert.deepEqual(sentences.map((s) => [s.start, s.end]), [[0, 4], [4, 8], [8, 12]])
  assert.equal(sentences.map((s) => s.text).join(''), text)
})

test('语音切段：长句按逗号/32 字切分，首包不必等整句', () => {
  const text = '这是一个用于测试语音切段的长句子，' + '它需要在逗号处断开，'.repeat(12) + '最后结束。'
  const sentences = splitReplySentences(text)
  const segments = splitSpeechSegments(text)
  assert.ok(segments.length > sentences.length)
  assert.equal(segments[0].start, 0)
  for (let i = 1; i < segments.length; i += 1) assert.ok(segments[i].start >= segments[i - 1].end)
  for (const segment of segments) {
    assert.ok([...segment.text].length <= 32, `片段超长：${segment.text}`)
    assert.equal([...text].slice(segment.start, segment.end).join('').trim(), segment.text)
    assert.ok(segment.sentenceIndex >= 0 && segment.sentenceIndex < sentences.length)
    assert.ok(segment.start >= sentences[segment.sentenceIndex].start && segment.end <= sentences[segment.sentenceIndex].end)
  }
})

/* ---------- 汇总 ---------- */
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failed}`)
if (failed > 0) process.exit(1)
