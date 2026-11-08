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
import { createTihuRuntime, buildTihuUserMessage, REPLY_HISTORY_LIMIT, TIHU_LANE_PATH, TIHU_PAGE_PATH } from '../src/tihu/lane.ts'
import {
  activityEntryOf,
  applyEarlyThinking,
  applySessionEvent,
  clipText,
  confirmationFrame,
  createProgressState,
  decodeRateOf,
  pushDecodeSample,
  SPEED_WINDOW_MS,
  describeTool,
  formatElapsed,
  sanitizeScreenLine,
  summarizeToolResult,
} from '../src/tihu/progress.ts'
import { ACTUAL_SIZE_SCALE, CONTENT_WIDTH_PX, PENDING_RAIL_WIDTH_PX, SCREEN_SPEC, TEXT_WRAP_SAFETY_PX, clipScreenTitle, fitLine, fitScreenLines, measureTextPx, wrapTextPx } from '../src/tihu/screen-spec.ts'
import { fitViewport, replyViewport, replyWindow, splitReplySentences, splitSpeechSegments, wrapReplyLines } from '../src/tihu/reply.ts'
import { stripToolNoise, toSpeechText } from '../src/tihu/speech-text.ts'
import { groupProjects, humanTitle, projectNameOf } from '../src/tihu/project-groups.ts'
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

test('screen.gesture 校验：swipe/tap 字段合法才收', () => {
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'swipe', dy: -40, phase: 'move' }, 60))) !== null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'tap', x: 12, y: 34 }, 61))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'swipe', dy: '40', phase: 'move' }, 62))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'swipe', dy: 1, phase: 'x' }, 63))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'tap', x: 1 }, 64))), null)
})

test('版本号与类型清单固定', () => {
  assert.equal(TIHU_PROTOCOL_VERSION, '0')
  assert.deepEqual([...TIHU_UPSTREAM_TYPES], ['hello', 'audio.frame', 'text.input', 'confirm.reply', 'session.end', 'sessions.query', 'session.bind', 'screen.gesture', 'voice.list', 'voice.create', 'voice.select', 'tts.sample', 'ping'])
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
  // 试听：text 可选；给了就必须是短句（超 200 字/不是字符串一律忽略）
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('tts.sample', {}, 38))) !== null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('tts.sample', { text: '试听：我是云健' }, 39))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('tts.sample', { text: 123 }, 41))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('tts.sample', { text: 'x'.repeat(201) }, 42))), null)
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
      if (id === 'workspaceRegistry') return overrides.workspaceRegistry
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
  assert.ok(html.includes('offlineOnly'), '页面要有仅离线开关')
  assert.ok(html.includes('tihu.offlineOnly'), '仅离线开关要持久化')
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
  assert.ok(framesOf(socket).some((frame) => frame.type === 'screen.frame' && frame.payload.title.includes('已绑定')))
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

await testAsync('lane：没有 CU 会话时默认显示主页屏（不再整屏引导）', async () => {
  const records = [cuRecord('session-standard', { lastPromptAt: 99999, preset: 'standard' })]
  const { runtime } = runtimeFor(records)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'c7', protocol: '0', auto: true }, 1)))
  socket.emit('data', clientFrame(buildUpstream('sessions.query', { limit: 20 }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 50))

  const frames = framesOf(socket)
  assert.equal(frames.some((frame) => frame.type === 'session.bound'), false, '没有 CU 会话就不该绑定')
  assert.ok(frames.some((frame) => frame.type === 'event.alert' && String(frame.payload.text).includes('没有可自动绑定的 Computer Use 会话')))
  const screen = frames.filter((frame) => frame.type === 'screen.frame').map((frame) => frame.payload).pop()
  assert.equal(screen.mode, 'home', '无绑定时默认主页屏')
  assert.ok(!JSON.stringify(screen).includes('还没有选定'), '旧引导文案不得占满屏')
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

await testAsync('lane：多句回复 tts.audio 按句 index 顺序到达、末块 final、之后回主页', async () => {
  process.env.TIHU_HOME_AFTER_MS = '200'
  process.env.TIHU_HOME_RECHECK_MS = '100'
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pipe-order', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第一句内容。第二句内容。第三句内容。第四句内容。' }] } },
  })
  // 等朗读 + 回主页计时全部走完（假 TTS 立即返回，home 计时 200ms + 余量）。
  await new Promise((resolve) => setTimeout(resolve, 800))

  const audioFrames = framesOf(socket).filter((frame) => frame.type === 'tts.audio')
  assert.ok(audioFrames.length >= 4, `至少 4 个音频块，实际 ${audioFrames.length}`)
  const byIndex = new Map()
  for (const frame of audioFrames) {
    const idx = frame.payload.index
    if (!byIndex.has(idx)) byIndex.set(idx, [])
    byIndex.get(idx).push(frame.payload)
  }
  // 每个句 index 内部块连续（seq 从 0 开始、final 在最后一块）。
  for (const [idx, chunks] of byIndex) {
    assert.deepEqual(chunks.map((c) => c.seq), [...Array(chunks.length).keys()], `句 ${idx} 的 seq 从 0 连续`)
    assert.equal(chunks[chunks.length - 1].final, true, `句 ${idx} 最后一块 final=true`)
  }
  // 全局看：句 index 单调不减（流水线允许相邻句边界交叠，但不允许乱序）。
  const indices = audioFrames.map((frame) => frame.payload.index)
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i] >= indices[i - 1], `句 index 单调不减：${indices.join(',')}`)
  }
  // 回主页语义：TTS 播完后 scheduleHome 触发，出现 mode=home 帧。
  const homes = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home')
  assert.ok(homes.length > 0, '朗读完成后应回主页')
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS
  runtime.dispose()
})

await testAsync('lane：预取流水线——并发合成、每句只合成一次、音频按序下发', async () => {
  // 假 TTS：每句分 3 块、块间延迟 15ms；记录同时在途的合成数与启动/完成顺序。
  let inFlight = 0
  let maxInFlight = 0
  const startOrder = []
  const finishOrder = []
  const pipelineTts = {
    async ensureServer() {},
    status: () => ({ available: true, model: 'pipe-test' }),
    engineLabel: () => 'pipe-test',
    takeEngineNote: () => '',
    deviceFallback: () => '',
    available: () => true,
    async synthesize(text, options) {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      startOrder.push(text)
      for (let seq = 0; seq < 3; seq += 1) {
        await new Promise((resolve) => setTimeout(resolve, 15))
        options.onChunk({ data: Buffer.alloc(4800), seq, total: 3, final: seq === 2 })
      }
      inFlight -= 1
      finishOrder.push(text)
    },
    async createVoice() { throw new Error('n/a') },
    async listVoices() { return [{ name: 'default', kind: 'default' }] },
    dispose() {},
  }
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: pipelineTts })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pipe', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '甲句。乙句。丙句。丁句。戊句。' }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))

  // 断言 1：预取确实并发（不止 1 个在途合成）。
  assert.ok(maxInFlight >= 2, `预取应出现并发合成，实际 maxInFlight=${maxInFlight}`)
  // 断言 2：5 句每句只启动一次（旧实现用 index+inFlight.size 会重复合成同一句）。
  assert.equal(startOrder.length, 5, '5 句全部启动')
  assert.equal(new Set(startOrder).size, 5, `每句只能合成一次，实际启动：${startOrder.join('｜')}`)
  assert.equal(finishOrder.length, 5, '5 句全部完成')
  // 断言 3：音频帧 index 单调不减（合成本身并发，下发必须按句序）。
  const audioFrames = framesOf(socket).filter((frame) => frame.type === 'tts.audio')
  const indices = audioFrames.map((frame) => frame.payload.index)
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i] >= indices[i - 1], `句 index 单调不减：${indices.join(',')}`)
  }
  assert.equal(audioFrames.length, 15, `5 句 × 3 块 = 15 块，实际 ${audioFrames.length}`)
  runtime.dispose()
})

/* ---------- 预取后「高亮文字与语音不同步」回归 ---------- */

/** 带时间戳的 socket：lane 每次 send 恰好一次 write（= 一个 WS 帧），据此记录下发时刻。 */
class TimedSocket extends FakeSocket {
  constructor() { super(); this.timed = [] }
  write(chunk) {
    const bytes = Buffer.from(chunk)
    this.timed.push({ at: Date.now(), bytes })
    return super.write(bytes)
  }
  /** [{ at, type, payload }]（跳过 HTTP 握手那一笔）。 */
  timedFrames() {
    const out = []
    for (const entry of this.timed) {
      if (entry.bytes.toString('latin1').startsWith('HTTP/1.1')) continue
      let offset = 0
      while (offset + 2 <= entry.bytes.length) {
        const len0 = entry.bytes[offset + 1] & 0x7f
        let length = len0
        let header = 2
        if (len0 === 126) { length = entry.bytes.readUInt16BE(offset + 2); header = 4 }
        const payload = entry.bytes.subarray(offset + header, offset + header + length).toString('utf8')
        offset += header + length
        try {
          const msg = JSON.parse(payload)
          out.push({ at: entry.at, type: msg.type, payload: msg.payload || {} })
        } catch { /* 半帧：忽略 */ }
      }
    }
    return out
  }
}
function openTimedLane(runtime) {
  const socket = new TimedSocket()
  runtime.handleUpgrade({ url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: {} }, socket, Buffer.alloc(0))
  return socket
}

await testAsync('lane：高亮屏帧按累计播放时长推进（预取后文字不得跑在语音前面）', async () => {
  // 三句实际音频 1.2s / 3.1s / 0.8s，这里按 1/10 缩放成 120 / 310 / 80 ms。
  const durations = [120, 310, 80]
  const FIRST_CHUNK_MS = 40
  const CHUNK_AUDIO_MS = 40
  const DECODE_MS = 5
  const BYTES_PER_MS = 48
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const speechTts = {
    async ensureServer() {},
    status: () => ({ available: true, model: 'sync-test' }),
    engineLabel: () => 'sync-test',
    takeEngineNote: () => '',
    deviceFallback: () => '',
    available: () => true,
    async synthesize(text, options) {
      // 句序：甲/乙/丙 = 第 0/1/2 段
      const which = text.includes('甲') ? 0 : text.includes('乙') ? 1 : 2
      const durMs = durations[which]
      await sleep(FIRST_CHUNK_MS)
      let seq = 0
      for (let sent = 0; sent < durMs; sent += CHUNK_AUDIO_MS) {
        const ms = Math.min(CHUNK_AUDIO_MS, durMs - sent)
        options.onChunk({ data: Buffer.alloc(ms * BYTES_PER_MS), seq, total: 0, final: false })
        seq += 1
        await sleep(DECODE_MS)
      }
      return { sampleRate: 24000, firstChunkMs: FIRST_CHUNK_MS, audioMs: durMs, totalMs: FIRST_CHUNK_MS, chunks: seq }
    },
    async createVoice() { throw new Error('n/a') },
    async listVoices() { return [{ name: 'default', kind: 'default' }] },
    dispose() {},
  }
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: speechTts })
  const socket = openTimedLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'sync', protocol: '0', sessionId: 'session-1' }, 1)))
  await sleep(30)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const t0 = Date.now()
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '甲句内容。乙句内容。丙句内容。' }] } },
  })
  await sleep(1200)

  const timed = socket.timedFrames()
  // 每句首块到达时刻（页面就是在这之后把这段音频排进 AudioContext 时间轴的）
  const firstAudioAt = new Map()
  for (const frame of timed) {
    if (frame.type !== 'tts.audio') continue
    const index = frame.payload.index
    if (!firstAudioAt.has(index)) firstAudioAt.set(index, frame.at - t0)
  }
  assert.equal(firstAudioAt.size, 3, `应有 3 段音频，实际 ${firstAudioAt.size}`)
  // 每句「宣布高亮到它」的屏帧到达时刻（currentIndex 首次变成该句）
  const firstFrameAt = new Map()
  for (const frame of timed) {
    if (frame.type !== 'screen.frame' || frame.payload.mode !== 'reply') continue
    const index = frame.payload.reply.currentIndex
    if (!firstFrameAt.has(index)) firstFrameAt.set(index, frame.at - t0)
  }
  assert.equal(firstFrameAt.size, 3, `应出现 currentIndex 0/1/2 三帧，实际 ${[...firstFrameAt.keys()].join(',')}`)

  // 播放时间轴：start[0] = 首块到达；start[i] = max(首块到达, start[i-1] + 音频时长)
  const starts = []
  for (let i = 0; i < durations.length; i += 1) {
    const arrival = firstAudioAt.get(i)
    const prevEnd = i === 0 ? 0 : starts[i - 1] + durations[i - 1]
    starts.push(Math.max(arrival, prevEnd))
  }
  const toleranceMs = 35
  // 关键断言：第 i 句的高亮屏帧不得早于它真正开始播放的时刻（预取让合成很早就完成）。
  // i=0 的帧是「回复正文刚出现」那一帧（按设计在出声前就下发），不参与这条判断。
  for (let i = 1; i < durations.length; i += 1) {
    const at = firstFrameAt.get(i)
    assert.ok(
      at >= starts[i] - toleranceMs,
      `第 ${i} 句高亮帧在 ${at}ms 就到了，但它的音频 ${starts[i]}ms 才开始播（文字跑在语音前面）`,
    )
  }
  // 累计口径：高亮下标必须随累计音频时长推进，而不是随合成完成推进。
  assert.ok(
    firstFrameAt.get(2) - firstFrameAt.get(0) >= durations[0] + durations[1] - toleranceMs,
    `高亮从第 0 句到第 2 句只用了 ${firstFrameAt.get(2) - firstFrameAt.get(0)}ms，累计音频是 ${durations[0] + durations[1]}ms`,
  )
  // 收尾帧（念完/回主页前最后一屏）也不能早于最后一段播完。
  const replyFrames = timed.filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  const finalAt = replyFrames[replyFrames.length - 1].at - t0
  const audioEnd = starts[durations.length - 1] + durations[durations.length - 1]
  assert.ok(
    finalAt >= audioEnd - toleranceMs,
    `收尾帧在 ${finalAt}ms 就发了，但音频要到 ${audioEnd}ms 才播完`,
  )
  runtime.dispose()
})

/* ---------- 2026-11-07 回归：长回复朗读「读了几句没声音了」（预取被抽干） ----------
 *
 * 实测（本机 edge-tts zh-CN-YunjianNeural rate +45%，8 段干净样本）：
 *   - 单段合成总耗时 1.87–2.53s（均值 2.21s）；
 *   - 首块 1.55–2.31s（均值 1.90s）≈ 合成总耗时的 86% → edge 基本不流式，首块≈整段；
 *   - 单段音频 1.56–2.71s（均值 2.07s）；
 *   - 限流抖动时单段能到 6.1s（> 2 段音频）。
 * 预取只有 2 段 ≈ 4s 余量，一次抖动就抽干；更糟的是旧泵用 `index + inFlight.size`
 * 算下一个要启动的段号——后启动的段先完成时，会**把同一段再合成一遍**，把并发额度
 * 白烧掉（等价并发变 1），于是「合成跟不上播放」→ 中途静音。
 * 下面按实测比例缩时（合成 300ms / 首块 270ms / 音频 180ms，每 4 段一次 600ms 抖动），
 * 用页面 playPcm 的口径复算静音缝。
 */
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 按每段实际音频时长把 tts.audio 帧还原成页面 AudioContext 的排程，返回静音缝。 */
function silenceGaps(audioFrames, gapToleranceMs = 200) {
  const gaps = []
  let nextAt = null
  for (const frame of audioFrames) {
    const bytes = Buffer.from(String(frame.payload.data || ''), 'base64').length
    const durationMs = (bytes / 2 / 24000) * 1000
    if (nextAt !== null && frame.at > nextAt + gapToleranceMs) gaps.push({ at: frame.at, silenceMs: Math.round(frame.at - nextAt) })
    nextAt = Math.max(nextAt === null ? frame.at : nextAt, frame.at) + durationMs
  }
  return gaps
}

await testAsync('lane：长回复朗读不中途静音（预取吃得住抖动，且每段只合成一次）', async () => {
  const SEGMENTS = 12
  const SYNTH_MS = 300
  const FIRST_MS = 270
  const AUDIO_MS = 180
  const SLOW_MS = 600
  const CHUNK_MS = 30
  const calls = []
  const drainTts = {
    async ensureServer() {},
    status: () => ({ available: true, model: 'drain-test' }),
    engineLabel: () => 'drain-test',
    takeEngineNote: () => '',
    deviceFallback: () => '',
    available: () => true,
    async synthesize(text, options) {
      calls.push(text)
      const index = Number(/第(\d+)段/.exec(text)?.[1] ?? 0)
      const synthMs = index % 4 === 3 ? SLOW_MS : SYNTH_MS
      // 首块之前一个字节都没有（edge 实测：首块≈合成结束）
      await waitMs(FIRST_MS)
      let seq = 0
      for (let sent = 0; sent < AUDIO_MS; sent += CHUNK_MS) {
        options.onChunk({ data: Buffer.alloc(CHUNK_MS * 48), seq, total: 0, final: false })
        seq += 1
        await waitMs(2)
      }
      await waitMs(Math.max(0, synthMs - FIRST_MS))
      return { sampleRate: 24000, firstChunkMs: FIRST_MS, audioMs: AUDIO_MS, totalMs: synthMs, chunks: seq }
    },
    async createVoice() { throw new Error('n/a') },
    async listVoices() { return [{ name: 'default', kind: 'default' }] },
    dispose() {},
  }
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: drainTts })
  const socket = openTimedLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'drain', protocol: '0', sessionId: 'session-1' }, 1)))
  await waitMs(30)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const text = Array.from({ length: SEGMENTS }, (_, i) => `第${i}段内容。`).join('')
  const t0 = Date.now()
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })
  // 朗读 + 收尾（12 段 × 180ms ≈ 2.2s 音频；给足余量）
  await waitMs(6000)

  const audio = socket.timedFrames().filter((frame) => frame.type === 'tts.audio')
  const byIndex = new Map()
  for (const frame of audio) {
    const index = frame.payload.index
    if (!byIndex.has(index)) byIndex.set(index, [])
    byIndex.get(index).push(frame)
  }
  // 1) 每段只合成一次（旧泵 index+inFlight.size 会把先完成的段重复合成，白烧并发额度）
  assert.equal(calls.length, SEGMENTS, `每段应只合成一次，实际合成 ${calls.length} 次（重复合成会拖垮预取）`)
  // 2) 12 段一段不落，且按 index 顺序下发（预取不能乱序）
  assert.equal(byIndex.size, SEGMENTS, `12 段音频都要下发，实际 ${byIndex.size} 段（缺段 = 读到一半静音）`)
  const indices = audio.map((frame) => frame.payload.index)
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i] >= indices[i - 1], `句 index 必须单调不减：${indices.join(',')}`)
  }
  // 3) 按页面 playPcm 的口径：没有超过 200ms 的静音缝
  const gaps = silenceGaps(audio)
  const totalSilence = gaps.reduce((sum, gap) => sum + gap.silenceMs, 0)
  assert.equal(
    gaps.length,
    0,
    `朗读中途出现 ${gaps.length} 处静音（合计 ${totalSilence}ms）：${gaps.map((gap) => `${gap.at - t0}ms 断 ${gap.silenceMs}ms`).join(' / ')}`,
  )
  runtime.dispose()
})

/* ---------- 两级链：edge 失败 → Qwen；都失败 → 无语音 ---------- */

function fakeTts({ model = 'qwen3-tts 0.6b-cuda', fail = false } = {}) {
  return {
    async ensureServer() {},
    status: () => ({ available: true, model }),
    engineLabel: (voice) => '本地 TTS：' + model + ' / 音色 ' + voice,
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

await testAsync('lane：edge 失败 → Qwen 本地引擎出声', async () => {
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
  assert.ok(progress.includes('本地 TTS：qwen3-tts 0.6b-cuda / 音色 default'), `引擎标识应为 Qwen，实际 ${progress.join(' | ')}`)
  assert.ok(frames.some((frame) => frame.type === 'tts.audio'), 'Qwen 也要下发 tts.audio')
  assert.ok(!frames.some((frame) => String(frame.payload.text ?? '').includes('SAPI')), '不能再出现 SAPI 引擎标识')
  runtime.dispose()
})

/* ---------- 试听：页面点「试听」→ 宿主合成一句示例语音（不再只响 0.6s 嘟声） ---------- */

await testAsync('lane：试听 tts.sample → 走同一条 TTS 链路下发带 sample 标记的 tts.audio', async () => {
  const { runtime } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'sample', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const before = framesOf(socket).length
  socket.emit('data', clientFrame(buildUpstream('tts.sample', {}, 2)))
  await new Promise((resolve) => setTimeout(resolve, 80))

  const frames = framesOf(socket).slice(before)
  const audio = frames.filter((frame) => frame.type === 'tts.audio')
  assert.ok(audio.length > 0, '试听必须下发 tts.audio（不能再只响嘟声）')
  assert.equal(audio[audio.length - 1].payload.sample, true, '试听音频要带 sample 标记（页面据此不写进本轮朗读缓存）')
  assert.equal(audio[audio.length - 1].payload.final, true, '最后一块 final=true')
  assert.ok(audio.every((frame) => frame.payload.index === 0), '试听只有一段，index 恒为 0')
  assert.ok(String(audio[0].payload.text || '').includes('试听'), '试听语句要有可读示例文本')
  // 试听不是一轮回复：不发 tts.text、不动屏（否则会顶掉正在读的正文）
  assert.equal(frames.filter((frame) => frame.type === 'tts.text').length, 0, '试听不能当成一轮回复（不发 tts.text）')
  assert.equal(frames.filter((frame) => frame.type === 'screen.frame').length, 0, '试听不能改屏')
  runtime.dispose()
})

await testAsync('lane：试听合成失败 → 红告警且不出音频（页面退到提示音，不静默）', async () => {
  const { runtime } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: fakeTts({ fail: true }) })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'sample-fail', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const before = framesOf(socket).length
  socket.emit('data', clientFrame(buildUpstream('tts.sample', { text: '试听一句话。' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 80))

  const frames = framesOf(socket).slice(before)
  const alerts = frames.filter((frame) => frame.type === 'event.alert').map((frame) => frame.payload)
  assert.ok(alerts.some((alert) => alert.level === 'error' && String(alert.text).includes('试听')), '试听失败必须发红告警')
  assert.equal(frames.filter((frame) => frame.type === 'tts.audio').length, 0, '合成失败不能下发空音频')
  runtime.dispose()
})

await testAsync('lane：edge 与 Qwen 都失败 → alert 且不出声，屏幕保留 reply 正文', async () => {
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
  assert.ok(alerts.some((alert) => alert.level === 'error' && String(alert.text).includes('本次无语音')), '必须发无语音 alert')
  assert.ok(!frames.some((frame) => frame.type === 'tts.audio'), '都失败时不能下发 tts.audio')
  const screens = frames.filter((frame) => frame.type === 'screen.frame')
  const last = screens[screens.length - 1].payload
  assert.equal(last.mode, 'reply')
  assert.ok(Array.isArray(last.reply.sentences) && last.reply.sentences.length > 0, '屏幕正文不能清掉')
  runtime.dispose()
})

await testAsync('lane：上滑回看历史、下滑回底恢复 follow、新回复归零', async () => {
  const { runtime, events } = runtimeFor([cuRecord('session-1', { live: true, lastPromptAt: 1000 })], {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'scroll', protocol: '0', sessionId: 'session-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}句内容。`).join('')
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: long }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  let screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  let reply = screens[screens.length - 1].payload.reply
  assert.ok(reply.scroll.maxOffset > 0, '长回复要有可滚动历史')
  // 先回到底部，拿稳定的首行，再上滑
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'swipe', dy: 10000, phase: 'end' }, 9)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  reply = screens[screens.length - 1].payload.reply
  const topLine = reply.lines[0].text
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'swipe', dy: -200, phase: 'move' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  reply = screens[screens.length - 1].payload.reply
  assert.ok(reply.scroll.offset > 0, '上滑后 offset 增大')
  assert.equal(reply.follow, false, '离开底部后停止跟随')
  assert.notEqual(reply.lines[0].text, topLine, '首行变成更早内容')
  const scrolled = reply.scroll.offset
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'swipe', dy: 10000, phase: 'end' }, 3)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  reply = screens[screens.length - 1].payload.reply
  assert.equal(reply.scroll.offset, 0, '下滑回底')
  assert.equal(reply.follow, true, '回底恢复跟随')
  assert.ok(scrolled > 0)
  // 新回复重置
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'swipe', dy: -300, phase: 'move' }, 4)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '新回复第一句。新回复第二句。' }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  reply = screens[screens.length - 1].payload.reply
  assert.equal(reply.scroll.offset, 0, '新回复归零')
  assert.equal(reply.follow, true)
  runtime.dispose()
})


await testAsync('lane：完成 + 10s 回主页；未完成/浏览模式不切', async () => {
  process.env.TIHU_HOME_AFTER_MS = '60'
  process.env.TIHU_HOME_RECHECK_MS = '40'
  const records = []
  for (let i = 1; i <= 6; i += 1) {
    const cwds = ['D:/dsh-assistant', 'D:/陈潘HBEU/2027青年基金', 'D:/陈潘HBEU/磷石膏SCI', 'D:/LLM STRATA', 'C:/Users/x/.dsh/assistant', 'C:/Users/x/.dsh/dsh_orb']
    records.push(cuRecord('session-home-' + i, { live: false, cwd: cwds[i - 1], lastPromptAt: 1000 + i, title: '项目 ' + i + ' 的最新进展' }))
  }
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'home', protocol: '0', sessionId: 'session-home-1' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-home-1', header: { id: 'session-home-1' } }, event)
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一句。第二句。' }] } } })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  let screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  assert.notEqual(screens[screens.length - 1].payload.mode, 'home', '刚回复完（朗读还没播完）不能切主页')
  // 朗读播完（假 TTS 每段 100ms 音频）+ 空闲计时过后才回主页
  await new Promise((resolve) => setTimeout(resolve, 600))
  screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  const home = screens[screens.length - 1].payload
  assert.equal(home.mode, 'home', '朗读播完 + 空闲计时后回主页')
  assert.equal(home.home.projects.length, 5, '主页一屏 5 个项目')
  assert.equal(home.home.page.total, 1, '5 个项目一页')
  assert.equal(home.home.total, 5)
  // 未完成不切
  emit({ type: 'turn/start', data: { turn: 2 } })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '失败句。' }] } } })
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } })
  await new Promise((resolve) => setTimeout(resolve, 160))
  screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  assert.notEqual(screens[screens.length - 1].payload.mode, 'home', '未完成不切主页')
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS
  runtime.dispose()
})


await testAsync('lane：A turn 进行中（turn/start 后无 turn/end），TTS 播完且超时 → 不收 home 帧；turn/end 后回主页', async () => {
  process.env.TIHU_HOME_AFTER_MS = '300'
  process.env.TIHU_HOME_RECHECK_MS = '100'
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'guard', protocol: '0', sessionId: 'session-a' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)

  // 第一轮完整走完：TTS 播完 + done=true，屏幕在会话屏
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A 的第一句。A 的第二句。' }] } } })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 100))

  // 第二轮开始但不结束：turn/start 后无 turn/end（A 的 turn 进行中）
  const framesBefore = framesOf(socket).filter((frame) => frame.type === 'screen.frame').length
  emit({ type: 'turn/start', data: { turn: 2 } })
  await new Promise((resolve) => setTimeout(resolve, 500))

  const homeDuring = framesOf(socket)
    .filter((frame) => frame.type === 'screen.frame')
    .slice(framesBefore)
    .filter((frame) => frame.payload.mode === 'home')
  assert.equal(homeDuring.length, 0, 'turn 进行中不得发 home 帧（超过 TIHU_HOME_AFTER_MS 也不行）')

  // turn 结束 → 等 TIHU_HOME_AFTER_MS 后应收到 home 帧
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 800))
  const homeAfter = framesOf(socket)
    .filter((frame) => frame.type === 'screen.frame')
    .filter((frame) => frame.payload.mode === 'home')
  assert.ok(homeAfter.length > 0, 'turn 结束后应回主页')
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS
  runtime.dispose()
})


await testAsync('lane：无回复 turn（无 assistant/message）也能回主页', async () => {
  process.env.TIHU_HOME_AFTER_MS = '200'
  process.env.TIHU_HOME_RECHECK_MS = '100'
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'noreply', protocol: '0', sessionId: 'session-a' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const homes = framesOf(socket)
    .filter((frame) => frame.type === 'screen.frame')
    .filter((frame) => frame.payload.mode === 'home')
  assert.ok(homes.length > 0, '无回复 turn 结束 + 超时后应回主页')
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS
  runtime.dispose()
})


/* ---------- 2026-11-07 回归：朗读没结束就跳控制室主页，随后又被残留屏帧切回 reply ----------
 *
 * 机制：正文 assistant/message 一到就开朗读，turn/end 紧接着结束（真实宿主就是这样），
 * 旧 scheduleHome 只看 runningSessions 空不空——turn 已停、但音频还在播/队列还没播完，
 * TIHU_HOME_AFTER_MS 一到就发 home 帧；之后 speakLocally 里按播放时刻排的 reply 屏帧
 * 陆续到期，把模式切回 reply（用户看到的「先跳主页、过一会又自己跳回来继续读」）。
 */
await testAsync('lane：朗读没播完不得回主页，回主页后也不再被残留屏帧切回 reply', async () => {
  process.env.TIHU_HOME_AFTER_MS = '150'
  process.env.TIHU_HOME_RECHECK_MS = '40'
  const SEGMENTS = 6
  const SYNTH_MS = 260
  const FIRST_MS = 240
  const AUDIO_MS = 200
  const CHUNK_MS = 40
  const slowTts = {
    async ensureServer() {},
    status: () => ({ available: true, model: 'home-gate' }),
    engineLabel: () => 'home-gate',
    takeEngineNote: () => '',
    deviceFallback: () => '',
    available: () => true,
    async synthesize(_text, options) {
      await waitMs(FIRST_MS)
      let seq = 0
      for (let sent = 0; sent < AUDIO_MS; sent += CHUNK_MS) {
        options.onChunk({ data: Buffer.alloc(CHUNK_MS * 48), seq, total: 0, final: false })
        seq += 1
        await waitMs(2)
      }
      await waitMs(Math.max(0, SYNTH_MS - FIRST_MS))
      return { sampleRate: 24000, firstChunkMs: FIRST_MS, audioMs: AUDIO_MS, totalMs: SYNTH_MS, chunks: seq }
    },
    async createVoice() { throw new Error('n/a') },
    async listVoices() { return [{ name: 'default', kind: 'default' }] },
    dispose() {},
  }
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: slowTts })
  const socket = openTimedLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'home-gate', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(30)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)
  const text = Array.from({ length: SEGMENTS }, (_, i) => `第${i}段内容。`).join('')

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  // 宿主真实时序：正文下发后 turn 立即结束，朗读才刚开始
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // 6 段 ≈ 1.2s 音频；给足时间看「播完才回主页」
  await waitMs(3000)
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS

  const timed = socket.timedFrames()
  const audio = timed.filter((frame) => frame.type === 'tts.audio')
  assert.ok(audio.length > 0, '应下发 tts.audio')
  const lastAudioAt = audio[audio.length - 1].at
  // 绑定时本来就会先发一帧主页屏（开机画面），这里只看「出问题的那段朗读」之后
  const firstReply = timed.find((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  assert.ok(firstReply, '应出现 reply 屏帧')
  const homes = timed.filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home' && frame.at >= firstReply.at)
  const earlyHomes = homes.filter((frame) => frame.at < lastAudioAt)
  assert.equal(
    earlyHomes.length,
    0,
    `朗读没播完就回了 ${earlyHomes.length} 次主页：home@${earlyHomes.map((frame) => frame.at - audio[0].at).join(',')}ms / 末块@${lastAudioAt - audio[0].at}ms`,
  )
  assert.ok(homes.length > 0, '朗读播完后仍要回主页（不能因为守门就永不回主页）')
  // 回主页之后不能再有 reply 屏帧（否则就是「跳主页又自己跳回来」）
  const firstHome = homes[0]
  const replyAfterHome = timed.filter((frame) => frame.at > firstHome.at && frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  assert.equal(
    replyAfterHome.length,
    0,
    `回主页后仍收到 ${replyAfterHome.length} 个 reply 屏帧（残留屏帧把屏切了回去）`,
  )
  runtime.dispose()
})

await testAsync('lane：用户浏览历史（follow=false）时朗读结束也不回主页', async () => {
  process.env.TIHU_HOME_AFTER_MS = '80'
  process.env.TIHU_HOME_RECHECK_MS = '40'
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'browse', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(30)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)
  const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}句内容。`).join('')
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(40)
  // 上滑回看：follow=false
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'swipe', dy: -200, phase: 'move' }, 2)))
  await waitMs(500)
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS
  const screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  const firstReply = screens.findIndex((frame) => frame.payload.mode === 'reply')
  assert.ok(firstReply >= 0, '应出现 reply 屏帧')
  const homes = screens.slice(firstReply).filter((frame) => frame.payload.mode === 'home')
  assert.equal(homes.length, 0, '用户正在浏览历史，不得切主页')
  runtime.dispose()
})


await testAsync('lane：B 发 turn/start → 绑定到空闲会话 A 的设备收到 session.bound followed=true 且绑定到 B', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 1000, title: '会话 B' }),
  ]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'follow', protocol: '0', sessionId: 'session-a' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)

  // A 空闲（无 turn 在跑）；B 开始 turn
  emit('session-b', { type: 'turn/start', data: { turn: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const bounds = framesOf(socket).filter((frame) => frame.type === 'session.bound')
  const followed = bounds.filter((frame) => frame.payload.followed === true)
  assert.ok(followed.length > 0, '应收到 followed=true 的 session.bound')
  assert.equal(followed[followed.length - 1].payload.sessionId, 'session-b', '应绑定到 B')
  // 跟随提示
  const progresses = framesOf(socket)
    .filter((frame) => frame.type === 'event.progress' && frame.payload.stage === '跟随')
  assert.ok(progresses.length > 0, '应发「跟随」event.progress')
  runtime.dispose()
})


await testAsync('lane：别的会话完成入待读气泡，tap 切屏并从头朗读，不打断当前会话', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 1000, title: '会话 B' }),
  ]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socketA = openLane(runtime)
  const socketB = openLane(runtime)
  socketA.emit('data', clientFrame(buildUpstream('hello', { clientId: 'dev-a', protocol: '0', sessionId: 'session-a' }, 1)))
  socketB.emit('data', clientFrame(buildUpstream('hello', { clientId: 'dev-b', protocol: '0', sessionId: 'session-b' }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 40))
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)

  // A 正在回复
  emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A 的第一句。A 的第二句。' }] } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const audioBefore = framesOf(socketA).filter((frame) => frame.type === 'tts.audio').length

  // B 完成 → A 右侧 pending，A 不被切
  emit('session-b', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B 的第一句。B 的第二句。' }] } } })
  emit('session-b', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  let screens = framesOf(socketA).filter((frame) => frame.type === 'screen.frame')
  let last = screens[screens.length - 1].payload
  assert.equal(last.mode, 'reply')
  assert.equal(last.pending.length, 1)
  assert.equal(last.pending[0].sessionId, 'session-b')
  assert.equal(framesOf(socketA).filter((frame) => frame.type === 'tts.audio').length, audioBefore, '入队不打断当前朗读')

  // 重复完成去重
  emit('session-b', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  screens = framesOf(socketA).filter((frame) => frame.type === 'screen.frame')
  assert.equal(screens[screens.length - 1].payload.pending.length, 1, '同会话去重')

  // tap 气泡 → 切到 B 并从头朗读，队列移除
  const tapFrame = buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 30, hit: 'chip', targetSessionId: 'session-b' }, 2)
  socketA.emit('data', clientFrame(tapFrame))
  await new Promise((resolve) => setTimeout(resolve, 80))
  screens = framesOf(socketA).filter((frame) => frame.type === 'screen.frame')
  last = screens[screens.length - 1].payload
  assert.equal(last.mode, 'reply')
  assert.equal(last.pending.length, 0, '切屏后队列移除')
  assert.ok(last.reply.sentences.some((sentence) => sentence.text.includes('B 的第一句')), '显示 B 的回复')
  const bound = framesOf(socketA).filter((frame) => frame.type === 'session.bound')
  assert.equal(bound[bound.length - 1].payload.sessionId, 'session-b')

  // 非法 targetSessionId 不得切屏
  const boundBefore = framesOf(socketA).filter((frame) => frame.type === 'session.bound').length
  socketA.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 30, hit: 'chip', targetSessionId: 'session-x' }, 3)))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(framesOf(socketA).filter((frame) => frame.type === 'session.bound').length, boundBefore, '非法 target 不切屏')
  runtime.dispose()
})


/* ---------- 2026-11-07 已定位 bug：鹈鹕首页项目与 DSH 控制室不一致 ----------
 *
 * 根因：lane.sendHome 用「会话快照按 cwd 分组」凑项目，而项目卡其实只存在于主客户端。
 * 于是 D:\dsh-app、C:\Users\Administrator\.dsh\skills 这类「只跑过会话、从没在控制室
 * 建过项目」的目录成了幽灵项目，控制室里有会话的老项目反倒漏掉。
 * 真源是宿主 workspace 服务（ctx.get('workspaceRegistry') → list()：id/path/title/
 * createdAt/updatedAt/sessionIds），首页必须按它列项目、按 updatedAt 倒序排。
 */

/** 宿主 workspace 实体的形状（每个字段都是 getter，代码不许按 plain object 读）。 */
function workspaceEntityOf(entry) {
  return {
    get id() { return entry.id },
    get path() { return entry.path },
    get title() { return entry.title },
    get createdAt() { return entry.createdAt },
    get updatedAt() { return entry.updatedAt },
    get sessionIds() { return [...entry.sessionIds] },
  }
}

function workspaceRegistryFixture(entries) {
  return { list: () => entries.map(workspaceEntityOf) }
}

/** 右下角 tap（x≥240 且 y≥180）= 立刻回主页：用它重算一次项目清单，不依赖空闲计时器。 */
async function tapHomeFrame(socket) {
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 300, y: 200 }, 90)))
  await waitMs(60)
  const homes = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home')
  assert.ok(homes.length > 0, '应下发主页屏帧')
  return homes[homes.length - 1].payload.home
}

await testAsync('lane：主页项目清单取 workspaceRegistry 真源（标题、updatedAt 倒序、无 cwd 幽灵项目）', async () => {
  const now = Date.now()
  const iso = (agoMs) => new Date(now - agoMs).toISOString()
  const records = [
    // 控制室里有项目的会话
    cuRecord('session-a', { preset: 'standard', live: true, cwd: 'D:\\陈潘HBEU\\10：高掺量磷石膏混凝土\\SCI', lastPromptAt: now - 30_000, title: '磷石膏 会话 A' }),
    cuRecord('session-b', { preset: 'computer-use', cwd: 'D:\\陈潘HBEU\\11：气象桥梁温度场\\paper', lastPromptAt: now - 20 * 60_000, title: '温度场 会话 B' }),
    cuRecord('session-c', { preset: 'standard', cwd: 'D:\\dsh-assistant', lastPromptAt: now - 30 * 60_000, title: '空闲项目 会话 C' }),
    // 幽灵：只在某个目录跑过会话，控制室从来没有这个项目
    cuRecord('session-ghost-app', { preset: 'computer-use', live: true, cwd: 'D:\\dsh-app', lastPromptAt: now - 10_000, title: '只在 dsh-app 跑过会话' }),
    cuRecord('session-ghost-skills', { preset: 'standard', cwd: 'C:\\Users\\Administrator\\.dsh\\skills', lastPromptAt: now - 10_000, title: '只在 skills 目录跑过会话' }),
  ]
  // 首页项目：list() 顺序刻意打乱；「空闲项目」的 updatedAt 最新（不能按 running→done→idle 排）
  const workspaces = [
    { id: 'ws-b', path: 'D:\\陈潘HBEU\\11：气象桥梁温度场', title: '桥梁温度场', createdAt: iso(400_000), updatedAt: iso(80_000), sessionIds: ['session-b'] },
    { id: 'ws-old', path: 'D:\\dsh-assistant\\scripts', title: '最旧项目', createdAt: iso(500_000), updatedAt: iso(300_000), sessionIds: [] },
    { id: 'ws-a', path: 'D:\\陈潘HBEU\\10：高掺量磷石膏混凝土', title: '磷石膏SCI', createdAt: iso(420_000), updatedAt: iso(40_000), sessionIds: ['session-a'] },
    { id: 'ws-e', path: 'D:\\dsh-assistant\\src', title: 'GNN-dPINN拓扑优化', createdAt: iso(410_000), updatedAt: iso(120_000), sessionIds: [] },
    { id: 'ws-c', path: 'D:\\陈潘HBEU\\Desktop\\2027 毕设', title: '空闲项目', createdAt: iso(430_000), updatedAt: iso(3_000), sessionIds: ['session-c'] },
    { id: 'ws-d', path: 'C:\\Users\\Administrator\\.dsh\\assistant', title: 'assistant', createdAt: iso(440_000), updatedAt: iso(100_000), sessionIds: [] },
  ]
  const { runtime, events } = runtimeFor(records, { workspaceRegistry: workspaceRegistryFixture(workspaces) })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'ws-home', protocol: '0', sessionId: 'session-b' }, 1)))
  await waitMs(40)
  // session-b 有一条最近的 assistant 回复（该项目该判 done 的依据）
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-b', header: { id: 'session-b' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '温度场重建：跨中三室箱梁尺寸已定稿。下一步做验证。' }] } },
  })
  await waitMs(40)

  const home = await tapHomeFrame(socket)
  const names = home.projects.map((item) => item.name)
  assert.deepEqual(
    names,
    ['空闲项目', '磷石膏SCI', '桥梁温度场', '个人助手', 'GNN-dPINN拓扑优化'],
    `项目名与顺序都要来自 workspace.title 与 updatedAt 倒序，实际 ${JSON.stringify(names)}`,
  )
  // 没有「只跑过会话、没建过项目」的 cwd 幽灵条目
  assert.equal(names.includes('dsh-app'), false, 'cwd 为 D:\\dsh-app 的会话不该成为项目')
  assert.equal(names.includes('skills'), false, 'cwd 为 .dsh\\skills 的会话不该成为项目')
  // 状态按该项目 sessionIds 对应的会话算（不再用 cwd 前缀匹配猜归属）
  assert.deepEqual(home.projects.map((item) => item.status), ['idle', 'running', 'done', 'idle', 'idle'], `状态：${JSON.stringify(home.projects.map((item) => item.status))}`)
  // 摘要仍是「最近回复首句 → 会话名 → 等待新消息」
  assert.ok(home.projects[2].summary.startsWith('温度场重建'), `摘要取最近回复首句：${home.projects[2].summary}`)
  assert.equal(home.projects[3].name, '个人助手', 'workspace 标题要保留既有别名（C:\\Users\\Administrator\\.dsh\\assistant）')
  assert.equal(home.projects[3].summary, '等待新消息', 'workspace 没有会话就只给占位摘要')
  // 分页与计数字段不变（5 条一页）
  assert.equal(home.projects.length, 5, '主页一屏 5 个项目')
  assert.equal(home.total, 6)
  assert.equal(home.page.total, 2)
  runtime.dispose()
})

await testAsync('lane：workspaceRegistry 不可用或 list 抛错时完全回退旧的 cwd 分组', async () => {
  const now = Date.now()
  const records = [
    cuRecord('session-ghost-app', { preset: 'standard', live: true, cwd: 'D:\\dsh-app', lastPromptAt: now - 20_000, title: '只在 dsh-app 跑过会话' }),
    cuRecord('session-ghost-skills', { preset: 'standard', cwd: 'C:\\Users\\Administrator\\.dsh\\skills', lastPromptAt: now - 20_000, title: '只在 skills 目录跑过会话' }),
    cuRecord('session-assistant', { preset: 'standard', live: true, cwd: 'C:\\Users\\Administrator\\.dsh\\assistant', lastPromptAt: now - 20_000, title: '宿主工作区会话' }),
  ]
  /** 两种兜底来源：拿不到服务（命令行测试环境没有宿主服务）与 list() 抛错。 */
  const fallbackHome = async (extra) => {
    const { runtime } = runtimeFor(records, extra)
    const socket = openLane(runtime)
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'ws-fallback', protocol: '0', auto: true }, 1)))
    await waitMs(60)
    const homes = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home')
    const home = homes.length > 0 ? homes[homes.length - 1].payload.home : undefined
    runtime.dispose()
    return home
  }
  const expected = ['dsh-app', '个人助手', 'skills']
  for (const [label, extra] of [
    ['list 抛错', { workspaceRegistry: { list: () => { throw new Error('workspace store broken') } } }],
    ['服务不存在', {}],
    ['服务没有 list 函数', { workspaceRegistry: { resolveByPath: () => undefined } }],
  ]) {
    const home = await fallbackHome(extra)
    assert.ok(home !== undefined, `${label}：应下发主页屏帧`)
    const names = home.projects.map((item) => item.name)
    assert.equal(names.length, 3, `${label}：回退到 cwd 分组应得 3 个项目，实际 ${JSON.stringify(names)}`)
    for (const name of expected) assert.ok(names.includes(name), `${label}：应含 cwd 兜底命名的「${name}」，实际 ${JSON.stringify(names)}`)
    assert.equal(names.includes('桥梁温度场'), false, `${label}：不得用到 workspace 标题`)
    assert.equal(home.projects[0].status, 'running', `${label}：回退仍按 running→done→idle 排序`)
    assert.equal(home.projects.filter((item) => item.status === 'running').length, 2, `${label}：两条 live 会话都是 running`)
    assert.equal(home.total, 3, `${label}：回退的总数按 cwd 分组`)
  }
})

test('主页项目聚合：同 cwd 合并、摘要人话、三态状态', () => {
  const now = 1_000_000
  const same = Array.from({ length: 6 }, (_, i) => ({
    sessionId: 's' + i,
    cwd: 'D:/dsh-assistant/src/tihu',
    updatedAt: now - i * 1000,
    live: false,
  }))
  assert.equal(groupProjects(same, {}, now).length, 1, '6 个会话同一 cwd → 1 个项目')

  const different = [
    { sessionId: 'a', cwd: 'D:/陈潘HBEU/2027青年基金', updatedAt: now, live: false },
    { sessionId: 'b', cwd: 'D:/陈潘HBEU/磷石膏SCI', updatedAt: now, live: false },
  ]
  assert.equal(groupProjects(different, {}, now).length, 2)

  // 摘要取最近 assistant 回复首句，绝不出现裸 session id
  const replied = groupProjects(different, {
    a: { text: '**完成** tihu 公网绑定。第二句。', at: now - 60_000 },
  }, now)
  const a = replied.find((item) => item.name === '青年基金申请书')
  assert.ok(a.summary.includes('完成') && !a.summary.includes('session'))
  assert.ok(!/^[0-9a-f]{8}$/i.test(a.summary))

  // 三态：live 且最近 2 分钟 → running；最近 10 分钟有回复 → done；否则 idle
  const running = groupProjects([{ sessionId: 'r', cwd: 'D:/dsh-assistant', updatedAt: now - 30_000, live: true }], {}, now)[0]
  assert.equal(running.status, 'running')
  const done = groupProjects([{ sessionId: 'd', cwd: 'D:/LLM STRATA', updatedAt: now - 3 * 60_000, live: false }], {
    d: { text: '做完了。', at: now - 60_000 },
  }, now)[0]
  assert.equal(done.status, 'done')
  const idle = groupProjects([{ sessionId: 'i', cwd: 'D:/陈潘HBEU/磷石膏SCI', updatedAt: now - 3600_000, live: false }], {}, now)[0]
  assert.equal(idle.status, 'idle')
  assert.equal(idle.summary, '等待新消息')
  assert.equal(projectNameOf('D:/dsh-assistant/src/tihu'), 'dsh-assistant')
})


test('humanTitle：剥掉裸 id/uuid，纯 id → 未命名会话', () => {
  assert.equal(humanTitle('已绑定：tihu 目录文件与自我简介 bbf68ac2').includes('bbf68ac2'), false)
  assert.equal(humanTitle('9b20811a'), '未命名会话')
  assert.equal(humanTitle('6f1c2a4e-8b7d-4c3e-9a1f-2d5e6b7c8a9d'), '未命名会话')
  assert.equal(humanTitle('修复 tihu 绑定'), '修复 tihu 绑定')
})

await testAsync('lane：自动绑定成功仍回主页，只有回复才切 session', async () => {
  const records = [cuRecord('session-live', { live: true, cwd: 'D:/dsh-assistant', lastPromptAt: 5000, title: 'tihu 绑定 bbf68ac2' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'h', protocol: '0', auto: true }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 60))
  let screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  assert.equal(screens[screens.length - 1].payload.mode, 'home', '自动绑定后仍是主页')
  assert.ok(!JSON.stringify(screens).includes('bbf68ac2'), '屏帧不得出现裸 id')
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-live', header: { id: 'session-live' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '有回复了。' }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  assert.equal(screens[screens.length - 1].payload.mode, 'reply', '有回复才切 session')
  runtime.dispose()
})


test('朗读清洗：wait/screenshot/hotkey/XML/坐标/图片哈希一律不进 TTS', () => {
  const raw = ['截图', '✓ Waited 60s. Coordinates remain 0-1000.', '<coordinate_space>0-1000</coordinate_space>', '<frontmost_app>Chrome</frontmost_app>', 'Pressed hotkey ctrl+alt+w', 'Clicked screen 0 at [500, 200]', '实际回复内容', '[image omitted...]', '(sha256:abcd1234)', 'Normalized copy (read-only...)'].join('\n')
  const cleaned = toSpeechText(raw)
  assert.equal(cleaned, '实际回复内容')
  assert.equal(stripToolNoise('<coordinate_space>0-1000</coordinate_space>结果').trim(), '结果')
})

test('工具动作翻译表：不再裸显英文工具名', () => {
  const names = {
    screenshot: '截图', wait: '等待', long_wait: '长等待', click: '点击', hotkey: '按键',
    scroll: '滚动', drag: '拖拽', input_text: '输入文字', open_in_browser: '打开网页',
    open_in_finder: '打开文件/目录', open_app: '打开应用', list_apps: '列出应用',
    code_agent: '派发后台任务', ask_user_question: '等待确认', skill: '加载技能',
    mnemon_remember: '记忆操作', present: '展示结果', working_directory: '切换目录',
    web_search: '搜索', web_fetch: '抓取网页',
  }
  for (const [tool, title] of Object.entries(names)) {
    assert.equal(describeTool(tool, {}).title, title, `${tool} → ${title}`)
  }
  assert.equal(describeTool('unknown_thing', {}).title.startsWith('执行 '), true)
})

test('工具结果尾行：XML/image/sha256 元数据被过滤', () => {
  const summary = summarizeToolResult('<coordinate_space>0-1000</coordinate_space>\n[image omitted...]\n(sha256:abcd1234)\n实际结果行', false)
  assert.equal(summary.output, '实际结果行')
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
  assert.ok(measureTextPx(shell.title, SCREEN_SPEC.titleFontPx) <= CONTENT_WIDTH_PX, '标题不超过 304px')
  const web = describeTool('web_search', { query: 'ESP32-S3-BOX-3' })
  assert.equal(web.stage, '搜索')
  assert.equal(web.title, '搜索')
  const other = describeTool('computer_use', { task: '打开浏览器' })
  assert.equal(other.stage, '思考')
  assert.equal(other.title, '执行 computer_use')
  // 超长参数截断且不出现半字
  const long = describeTool('pwsh', { command: 'x'.repeat(200) })
  assert.ok(measureTextPx(long.title, SCREEN_SPEC.titleFontPx) <= CONTENT_WIDTH_PX)
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
  // 新版四行格式：第一行会话标题、第二行「阶段词：第一句」、第三行步骤用时、第四行统计
  assert.equal(call1.screen.stage, '')
  assert.equal(call1.screen.title, '读取 a.ts')
  assert.ok(call1.screen.bullets[0].startsWith('思考'), 'turn/start 之后第一拍就要有思考占位：' + call1.screen.bullets[0])
  assert.equal(call1.screen.bullets[1], '读文件 · a.ts', '第二行是明细条目：' + call1.screen.bullets[1])
  assert.ok(call1.screen.bullets[2].includes('步') && call1.screen.bullets[2].includes('统计中'), '第三行是步数用时与统计合并：' + call1.screen.bullets[2])
  assert.equal(call1.screen.bullets.length, 3, '两条明细 + 合并统计行，不再留空行')
  push({ type: 'tool/result', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'const a = 1\n第二个文件结尾' }], isError: false } } }, 4000)
  assert.equal(state.tone, 'ok')
  assert.ok(state.lastResult.line.startsWith('✓'))
  assert.ok(measureTextPx(state.lastResult.line, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX)

  // 第 2 步：跑命令失败
  push({ type: 'step/start', data: { turn: 7, step: 2 } }, 5000)
  const call2 = push({ type: 'tool/call', data: { turn: 7, step: 2, name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force build-with-a-very-long-name-here' } } }, 6000)
  assert.equal(call2.screen.stage, '')
  assert.ok(call2.screen.bullets[1].startsWith('运行命令 · Remove-Item'), '第三行是最新明细：' + call2.screen.bullets[1])
  push({ type: 'tool/result', data: { turn: 7, step: 2, message: { content: [{ type: 'text', text: '拒绝访问：文件被占用（详细信息在日志里）' }], isError: true } } }, 7000)
  assert.equal(state.tone, 'alert')
  assert.ok(state.lastResult.line.startsWith('✗'))
  assert.ok(measureTextPx(state.lastResult.line, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX)

  // 回答
  const answer = push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一行回答\n最后一行是输出尾行' }] } } }, 8000)
  assert.equal(answer.screen.stage, '')
  assert.ok(answer.screen.bullets[1].startsWith('回答 · 第一行回答'), '最新明细在第三行：' + answer.screen.bullets[1])
  assert.ok(answer.screen.bullets.length <= SCREEN_SPEC.maxBodyLines)
  for (const line of answer.screen.bullets) assert.ok(measureTextPx(line, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX, `行超宽：${line}`)

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

test('屏幕文本按像素截断：标题 ≤304px，正文按宽度折行', () => {
  const title = clipText('这是一个非常非常长的标题'.repeat(3), 28)
  assert.ok(measureTextPx(title, SCREEN_SPEC.titleFontPx) <= CONTENT_WIDTH_PX)
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

test('进度屏：步骤开始时不再把上一轮内容顶到「思考」下面（残留 bug 回归）', () => {
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 2 } }, 1000)
  applySessionEvent(state, { type: 'step/start', data: { turn: 2, step: 1 } }, 1000)
  const edit = applySessionEvent(state, { type: 'tool/call', data: { turn: 2, step: 1, name: 'edit', arguments: { file_path: 'D:/dsh-assistant/src/tihu/lane.ts' } } }, 2000)
  assert.equal(edit.screen.bullets[1], '改文件 · lane.ts')
  const next = applySessionEvent(state, { type: 'step/start', data: { turn: 2, step: 2 } }, 3000)
  assert.equal(next.screen.bullets[1], '改文件 · lane.ts', '步骤开始不该改写上一条明细：' + next.screen.bullets[1])
  assert.ok(!next.screen.bullets.some((line) => line.startsWith('思考：')), '不应出现「思考：<上一轮内容>」：' + next.screen.bullets.join(' / '))
})

test('进度屏：明细条目格式「标签 · 明细」，跑命令取真正干活的一段', () => {
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 3 } }, 1000)
  const call = applySessionEvent(state, { type: 'tool/call', data: { turn: 3, step: 1, name: 'pwsh', arguments: { command: 'Set-Location "D:\\dsh-assistant"; node scripts/test-tihu-protocol.mjs 2>&1 | Select-Object -Last 3' } } }, 2000)
  assert.ok(call.screen.bullets[0].startsWith('思考'), '第一行是思考占位：' + call.screen.bullets[0])
  assert.ok(call.screen.bullets[1].startsWith('运行命令 · node scripts/test-tihu-prot'), '明细：' + call.screen.bullets[1])
  assert.ok(measureTextPx(call.screen.bullets[1], SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX)
  const glob = applySessionEvent(state, { type: 'tool/call', data: { turn: 3, step: 1, name: 'glob', arguments: { pattern: '**/*tihu*' } } }, 3000)
  assert.equal(glob.screen.bullets[1], '查找文件 · **/*tihu*', '第二条明细：' + glob.screen.bullets[1])
  const grep = applySessionEvent(state, { type: 'tool/call', data: { turn: 3, step: 1, name: 'grep', arguments: { pattern: 'TIHU_SYNTH_MAX_INFLIGHT' } } }, 4000, { stats: { tokPerSec: 137, totalTokens: 586600, contextPercent: 26 } })
  assert.ok(grep.screen.bullets[1].startsWith('搜索文件内容 · TIHU_SYNTH_MAX'), '第三条明细：' + grep.screen.bullets[1])
  for (const line of grep.screen.bullets) assert.ok(measureTextPx(line, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX, '行超宽：' + line)
  assert.equal(grep.screen.bullets.length, 3, '两条明细 + 合并统计行')
  assert.ok(grep.screen.bullets[2].includes('步') && grep.screen.bullets[2].includes('%'), '第四行合并步数与统计：' + grep.screen.bullets[2])
  assert.ok(grep.screen.bullets[2].includes('tok/s'), '第四行带解码速度：' + grep.screen.bullets[2])
  assert.ok(measureTextPx(grep.screen.bullets[2], SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX, '第四行超宽：' + grep.screen.bullets[2])
  // 桌面工具用内置中文名，不裸显英文工具名
  assert.equal(activityEntryOf('screenshot', {}).label, '截图')
  assert.equal(activityEntryOf('click', {}).label, '点击')
  assert.equal(activityEntryOf('unknown_tool_xyz', { path: 'a.ts' }).label, '工具')
  assert.equal(activityEntryOf('edit', { file_path: 'src/tihu/lane.ts' }).detail, 'lane.ts')
})

/* ---------- 2026-11-07 已定位 bug：鹈鹕「运行命令 · 明细」与 DSH 客户端不一致 ----------
 *
 * DSH 工具卡显示的是 pwsh 工具 arguments.description（「Search asar for workspace service」），
 * 鹈鹕却显示从 command 里截出来的碎片（「$files」）。明细必须优先取 description，
 * 没有 description 才退回 salientCommand(command)。
 */
test('进度屏：命令类明细优先 arguments.description（DSH 工具卡同源），没有才退回 command', () => {
  const described = activityEntryOf('pwsh', {
    description: '  Search  asar for  workspace  service ',
    command: '$files = Get-ChildItem -Recurse | Select-String "workspaceRegistry"; $files',
  })
  assert.equal(described.label, '运行命令')
  assert.equal(described.detail, 'Search asar for workspace service', `明细：${described.detail}`)

  // 只有 command：口径不变（仍是去掉 cd/Set-Location 与管道尾巴的那一段）
  const commandOnly = activityEntryOf('pwsh', { command: 'Set-Location "D:\\dsh-assistant"; node scripts/test-tihu-protocol.mjs 2>&1 | Select-Object -Last 3' })
  assert.equal(commandOnly.detail, 'node scripts/test-tihu-protocol.mjs', `明细：${commandOnly.detail}`)

  // description 空白/空串一律忽略，退回 command
  const blankDescription = activityEntryOf('pwsh', { description: '   ', command: 'git status' })
  assert.equal(blankDescription.detail, 'git status', `空白 description 要忽略：${blankDescription.detail}`)
  const emptyDescription = activityEntryOf('bash', { description: '', command: 'ls -la' })
  assert.equal(emptyDescription.detail, 'ls -la', `空 description 要忽略：${emptyDescription.detail}`)

  // 屏帧走的也是这条口径（第三行最新明细）
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 1 } }, 1000)
  const frame = applySessionEvent(state, {
    type: 'tool/call',
    data: { turn: 1, step: 1, name: 'pwsh', arguments: { description: 'Search asar for workspace service', command: '$files = Get-ChildItem D:\\dsh-assistant' } },
  }, 2000)
  assert.ok(frame.screen.bullets[1].startsWith('运行命令 · Search asar'), `屏帧明细：${frame.screen.bullets[1]}`)

  // 其它工具规则不动：读/写/改仍是文件名，pwsh 之外不受 description 影响
  assert.equal(activityEntryOf('read', { file_path: 'src/tihu/lane.ts', description: 'Read lane source' }).detail, 'lane.ts')
  assert.equal(activityEntryOf('glob', { pattern: '**/*tihu*', description: 'Find tihu files' }).detail, '**/*tihu*')
})

test('进度屏：思考条目取模型 thinking 文本的第一句', () => {
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 4 } }, 1000)
  const frame = applySessionEvent(state, {
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'thinking', thinking: 'Let me start by exploring the repository layout. Then I will patch lane.ts.' }, { type: 'text', text: '先看一下目录结构。' }] },
    },
  }, 2000)
  assert.ok(frame.screen.bullets[0].startsWith('思考 · Let me start by exploring'), '思考明细：' + frame.screen.bullets[0])
  assert.ok(frame.screen.bullets[1].startsWith('回答 · '), '回答明细：' + frame.screen.bullets[1])
})

test('进度屏：工具失败记一条「出错」明细', () => {
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 5 } }, 1000)
  applySessionEvent(state, { type: 'tool/call', data: { turn: 5, step: 1, name: 'pwsh', arguments: { command: 'Get-ChildItem C:/nope' } } }, 2000)
  const bad = applySessionEvent(state, { type: 'tool/result', data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'ENOENT: no such file or directory' }], isError: true } } }, 3000)
  assert.equal(bad.screen.bullets[1], '出错 · 命令没找到', '出错明细：' + bad.screen.bullets[1])
})

test('进度屏：新的一轮清空上一轮明细', () => {
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 1 } }, 1000)
  applySessionEvent(state, { type: 'tool/call', data: { turn: 1, step: 1, name: 'read', arguments: { file_path: 'a.ts' } } }, 2000)
  const fresh = applySessionEvent(state, { type: 'turn/start', data: { turn: 2 } }, 3000)
  assert.ok(!fresh.screen.bullets.some((line) => line.includes('读文件')), '新一轮不带上一轮明细：' + fresh.screen.bullets.join(' / '))
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
  assert.ok(screens.some((frame) => frame.bullets[0] === '读文件 · README.md'), '第二行应显示「读文件 · README.md」')
  // 屏上不再显示命令状态/输出尾行，只留四行：标题、阶段行、步骤行、统计行
  const statusFrames = screens.filter((frame) => (frame.mode ?? 'status') === 'status')
  assert.ok(statusFrames.length > 0, '应有状态帧')
  const lastStatus = statusFrames[statusFrames.length - 1]
  assert.equal(lastStatus.bullets.length, 3, '状态帧正文固定三行')
  assert.ok(!lastStatus.bullets.some((line) => line.includes('最后一行输出')), '屏上不贴命令输出尾行')
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
  assert.equal(SCREEN_SPEC.maxBodyLines, 4)
  assert.equal(SCREEN_SPEC.stageFontPx, 12)
  assert.ok(ACTUAL_SIZE_SCALE > 0.7 && ACTUAL_SIZE_SCALE < 0.75, `实际尺寸缩放 ${ACTUAL_SIZE_SCALE}`)

  // 40 字标题 → 28 字内（含省略号）；不出现半个字
  const title = clipScreenTitle('这是一个非常长的标题'.repeat(4))
  assert.ok(measureTextPx(title, SCREEN_SPEC.titleFontPx) <= CONTENT_WIDTH_PX)
  assert.ok(title.endsWith('…'))
  assert.equal(clipScreenTitle('短标题'), '短标题')

  // 像素宽度：长 ASCII 不截断，20 个汉字截到 ~19 字，ASCII 容量约 2× 汉字
  const ascii = 'Get-ChildItem D:\\dsh-assistant\\src\\tihu'
  assert.equal(fitLine(ascii, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx), ascii, 'ASCII 行不应被截')
  assert.ok(measureTextPx(ascii, SCREEN_SPEC.bodyFontPx) < CONTENT_WIDTH_PX)
  const cjk20 = '一二三四五六七八九十一二三四五六七八九十'
  const fittedCjk = fitLine(cjk20, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)
  assert.ok(fittedCjk.endsWith('…'))
  assert.ok([...fittedCjk].length >= 18 && [...fittedCjk].length <= 20)
  const asciiCapacity = [...Array(80)].map(() => 'A').join('')
  const fittedAscii = fitLine(asciiCapacity, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)
  // 大写字母按 0.62em 估（实测真实字体比 0.47em 宽，按 0.47 估会让行在浏览器里折成两行）
  assert.ok([...fittedAscii].length > 28, 'ASCII 一行应容纳 28+ 字符：' + [...fittedAscii].length)
  assert.ok(measureTextPx(fittedAscii, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX)

  // 5 行正文只保留前 3 行，每行 ≤18 字
  const five = ['一', '二', '三', '四', '五'].map((line) => line.repeat(20))
  const fitted = fitScreenLines(five)
  assert.equal(fitted.length, 4)
  for (const line of fitted) assert.ok(measureTextPx(line, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX)
  assert.deepEqual(fitScreenLines(['a', '', 'b', 'c', 'd']), ['a', 'b', 'c', 'd'])
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
  // 试听按钮不再只响嘟声：没缓存时请宿主合成一句示例（tts.sample），收到 sample 音频再播
  assert.ok(html.includes("send('tts.sample'"), '试听要发 tts.sample')
  assert.ok(html.includes('已播放试听语音'), '收到试听音频要有明确回执文案')
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
  for (const line of viewport.lines) assert.ok(measureTextPx(line.text, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX, `行超宽：${line.text}`)
  assert.ok(viewport.currentLine >= 3 && viewport.currentLine <= 6, `当前句应在中部，实际第 ${viewport.currentLine} 行`)
  assert.ok(viewport.lines[viewport.currentLine].sentenceIndex === middle)

  // 行拼起来不丢字（窗口内）
  const wrapped = wrapReplyLines(replyWindow(sentences, middle), 18)
  assert.equal(wrapped.map((line) => line.text).join(''), replyWindow(sentences, middle).map((s) => s.text.replace(/\s+/g, ' ').trim()).join(''))

  // 空文本
  assert.deepEqual(splitReplySentences(''), [])
  assert.deepEqual(fitViewport([], 0).lines, [])
  assert.equal(SCREEN_SPEC.replyVisibleLines, 9)
})

test('TTS 分段带字符区间：tts.text 的 charStart/charEnd 与句边界一致', () => {
  const text = '第一句。第二句！第三句？'
  const sentences = splitReplySentences(text)
  assert.deepEqual(sentences.map((s) => [s.start, s.end]), [[0, 4], [4, 8], [8, 12]])
  assert.equal(sentences.map((s) => s.text).join(''), text)
})

test('TTS 文本清洗：markdown/emoji/链接，屏幕原文不动', () => {
  assert.equal(toSpeechText('**加粗**'), '加粗')
  assert.equal(toSpeechText('☑️ 已完成'), '已完成')
  assert.equal(toSpeechText('[文档](http://x)'), '文档')
  assert.equal(toSpeechText('🔴🟢📌🎯'), '')
  assert.equal(toSpeechText('# 标题\n- 第一项\n- 第二项'), '标题 第一项 第二项')
  assert.equal(toSpeechText('看这里 https://example.com/a 谢谢'), '看这里 链接 谢谢')
  assert.equal(toSpeechText('`code` 和 ~~删除~~'), 'code 和 删除')
  assert.equal(toSpeechText('✅ **完成**：\n> 引用'), '完成： 引用')
  // 清洗后不能留下连续空白/换行
  assert.equal(/\s{2,}/.test(toSpeechText('**a**\n\n☑️ b')), false)
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

test('回复行不出现省略号：折行留安全边距、页面 CSS 不再 ellipsis', () => {
  const text = '这是一段用于验证回复行不会被裁成省略号的真实中文回复，包含标点、英文 Word 和数字 12345。'.repeat(12)
  const lines = wrapTextPx(text, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)
  assert.ok(lines.length > 1, '长文本必须折成多行')
  const limit = CONTENT_WIDTH_PX - TEXT_WRAP_SAFETY_PX
  for (const line of lines) {
    assert.equal(line.includes('…'), false, '行内不应出现省略号：' + line)
    const width = measureTextPx(line, SCREEN_SPEC.bodyFontPx)
    assert.ok(width <= limit, '行宽 ' + width + ' 超出安全宽 ' + limit + '：' + line)
  }
  // 19 个全角字恰好等于 304px 容器宽，必须被拆成两行（否则真机会被浏览器裁成省略号）
  const full = '一二三四五六七八九十一二三四五六七八九'
  assert.equal([...full].length, 19)
  const fullLines = wrapTextPx(full, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)
  assert.equal(fullLines.length, 2, '19 字满宽行应折成两行，实际 ' + fullLines.length)
  assert.ok(measureTextPx(fullLines[0], SCREEN_SPEC.bodyFontPx) <= limit)
  assert.equal(fullLines.join(''), full, '折行不能丢字')
  // 页面 CSS：.reply-line 不得再用 text-overflow:ellipsis
  const pageSource = readFileSync(new URL('../src/tihu/page.ts', import.meta.url), 'utf8')
  const rule = pageSource.split(String.fromCharCode(10)).find((line) => line.includes('.reply-line {'))
  assert.ok(rule !== undefined, '找不到 .reply-line 规则')
  assert.equal(rule.includes('text-overflow'), false, 'reply-line 不应有 text-overflow：' + rule)
})

/* ---------- 2026-11-07 审计回归（P0 批次）：闸门 / 握手 / 朗读帧 ---------- */

{
  const mkGateAgent = (sessionId, userMessageId) => ({
    sessionId,
    session: {
      header: { cwd: process.cwd() },
      deriveMessages: () => [{ id: userMessageId, role: 'user', content: [] }],
    },
    followup() {},
  })

  function gateRuntime(options = {}) {
    const events = []
    const injected = []
    const agent = mkGateAgent('session-1', 'ignored')
    agent.followup = (message) => injected.push(message)
    const ctx = {
      on(name, handler) { events.push({ name, handler }); return () => {} },
      get(id) { return id === 'agents' ? { get: () => agent } : undefined },
    }
    const runtime = createTihuRuntime(ctx, { log: () => {}, ...options })
    const socket = new FakeSocket()
    runtime.handleUpgrade({ url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: {} }, socket, Buffer.alloc(0))
    return { runtime, socket, events, agent, injected }
  }

  async function armTihuTurn(fixture) {
    const { socket, events, agent, injected } = fixture
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'gate', protocol: '0', sessionId: 'session-1' }, 1)))
    socket.emit('data', clientFrame(buildUpstream('text.input', { text: '看一下 git 状态', source: 'voice' }, 2)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    agent.session.deriveMessages = () => [{ id: injected[0].id, role: 'user', content: [] }]
    return events.find((entry) => entry.name === 'tools/pre-execute').handler
  }

  await testAsync('闸门 R-P0-1：next() 抛错时原样抛出，工具不得被执行第二次', async () => {
    const fixture = gateRuntime()
    const handler = await armTihuTurn(fixture)
    let nextCalls = 0
    const failure = new Error('工具自己炸了')
    await assert.rejects(
      () => handler(
        { name: 'pwsh', arguments: { command: 'git status' }, agent: fixture.agent, callId: 'r1' },
        async () => { nextCalls += 1; throw failure },
      ),
      (error) => error === failure,
    )
    assert.equal(nextCalls, 1, 'next() 只能调用一次（旧实现 catch 里再调一次 = 工具跑两遍）')
    fixture.runtime.dispose()
  })

  await testAsync('闸门 R-P0-1b：确认器 ask 抛错 → 危险动作 fail-closed 拒绝', async () => {
    const fixture = gateRuntime({
      confirmBroker: {
        ask: async () => { throw new Error('broker 崩了') },
        reply: () => false,
        failAll() {},
        pendingCount: () => 0,
      },
    })
    const handler = await armTihuTurn(fixture)
    const decision = await Promise.race([
      handler(
        { name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force build' }, agent: fixture.agent, callId: 'r2' },
        async () => ({ kind: 'allow' }),
      ),
      new Promise((resolve) => { setTimeout(() => resolve({ kind: 'test-timeout' }), 800) }),
    ])
    assert.equal(decision.kind, 'deny', '确认器自己出错时危险动作必须拒绝，实际 ' + JSON.stringify(decision))
    fixture.runtime.dispose()
  })
}

class ThrowingSocket extends FakeSocket {
  write() { throw new Error('EPIPE: socket 已销毁') }
}

await testAsync('握手 R-P0-2：socket 写失败不抛异常（不打死 pocket 进程）', async () => {
  const { ctx } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {} })
  const socket = new ThrowingSocket()
  let threw = null
  try {
    const handled = runtime.handleUpgrade({ url: '/tihu/lane', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, socket: {} }, socket, Buffer.alloc(0))
    assert.equal(handled, true)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, null, '握手期 socket 异常必须被兜住，实际抛出：' + (threw && threw.message))
  runtime.dispose()
})

await testAsync('朗读帧 R-P0-3：帧回调抛错只记日志，不逃出 setTimeout 打死进程', async () => {
  const lane = await import('../src/tihu/lane.ts')
  assert.equal(typeof lane.scheduleFrameAt, 'function', 'lane 需要导出可测的帧定时器 scheduleFrameAt')
  let captured = null
  await lane.scheduleFrameAt(Date.now(), () => { throw new Error('帧渲染炸了') }, (error) => { captured = error })
  assert.equal(String(captured && captured.message).includes('帧渲染炸了'), true, '异常必须被 onError 捕获而不是逃出定时器')
})

/* ---------- 2026-11-07 审计回归（P1 批次）：回主页 / 屏宽 / 气泡 ---------- */

/** 条件轮询：等到某类帧出现（不用固定 sleep 猜时间）。 */
async function waitForFrame(socket, predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = framesOf(socket).filter(predicate)
    if (hit.length > 0) return hit[hit.length - 1]
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return undefined
}

/** 打开一个绑好会话的 lane，返回驱动 session/event 的 emit。 */
async function laneWithSession(records, sessionId, extras = {}, ttsOptions = { instance: fakeTts() }) {
  const fixture = runtimeFor(records, extras, ttsOptions)
  const socket = openLane(fixture.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'r-' + sessionId, protocol: '0', sessionId }, 1)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const onSessionEvent = fixture.events.find((entry) => entry.name === 'session/event').handler
  const emit = (target, event) => onSessionEvent({ id: target, header: { id: target } }, event)
  return { ...fixture, socket, emit }
}

await testAsync('回主页 R-P1-4：完成一轮后点一下屏，仍会按空闲条件回主页', async () => {
  process.env.TIHU_HOME_AFTER_MS = '300'
  process.env.TIHU_HOME_RECHECK_MS = '40'
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, socket, emit } = await laneWithSession(records, 'session-a')
  emit('session-a', { type: 'turn/start', data: { turn: 1 } })
  emit('session-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // 等回主页倒计时真正挂上（turn/end 后 50ms 才 scheduleHome），再点一下屏。
  await new Promise((resolve) => setTimeout(resolve, 120))
  const isHome = (frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home'
  const baseline = framesOf(socket).filter(isHome).length // hello 时已有一张主页帧，只认「新来的」
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 10, y: 10 }, 2)))
  const deadline = Date.now() + 1500
  while (Date.now() < deadline && framesOf(socket).filter(isHome).length <= baseline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(framesOf(socket).filter(isHome).length > baseline, '点屏取消倒计时之后仍必须重新挂计时并回主页（条件轮询 1.5s 内）')
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS
  runtime.dispose()
})

await testAsync('定时器 R-P1-5a：TIHU_HOME_RECHECK_MS 非数字/0 被钳制，不再 0ms 空转', async () => {
  const lane = await import('../src/tihu/lane.ts')
  assert.equal(typeof lane.tihuHomeRecheckMs, 'function', 'lane 需要导出可测的 tihuHomeRecheckMs')
  process.env.TIHU_HOME_RECHECK_MS = 'abc'
  assert.equal(lane.tihuHomeRecheckMs(), 2000, '非数字要退回默认 2000ms')
  process.env.TIHU_HOME_RECHECK_MS = '0'
  assert.equal(lane.tihuHomeRecheckMs(), 250, '0 要钳到下限 250ms')
  process.env.TIHU_HOME_RECHECK_MS = '40'
  assert.equal(lane.tihuHomeRecheckMs(), 40)
  delete process.env.TIHU_HOME_RECHECK_MS
  assert.equal(lane.tihuHomeRecheckMs(), 2000)
})

await testAsync('回主页 R-P1-5b：turn/start 后没有 turn/end（agent 被中断），超过 TIHU_TURN_STALE_MS 也会回主页', async () => {
  process.env.TIHU_HOME_AFTER_MS = '60'
  process.env.TIHU_HOME_RECHECK_MS = '40'
  process.env.TIHU_TURN_STALE_MS = '80'
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, socket, emit } = await laneWithSession(records, 'session-a')
  const isHome = (frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home'
  const baseline = framesOf(socket).filter(isHome).length
  emit('session-a', { type: 'turn/start', data: { turn: 1 } }) // 故意不发 turn/end
  const deadline = Date.now() + 1500
  while (Date.now() < deadline && framesOf(socket).filter(isHome).length <= baseline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(
    framesOf(socket).filter(isHome).length > baseline,
    '被中断的 turn 必须自愈（stale 窗口后回主页），否则屏永久卡在会话页',
  )
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS
  delete process.env.TIHU_TURN_STALE_MS
  runtime.dispose()
})

await testAsync('屏宽 R-P1-6：有气泡时状态屏按 240px 排版（不再被 CSS 裁掉）', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 1000, title: '会话 B' }),
  ]
  const { runtime, socket, emit } = await laneWithSession(records, 'session-a')
  emit('session-b', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B 完成了。' }] } } })
  emit('session-b', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  emit('session-a', {
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      name: 'pwsh',
      arguments: { command: 'npm test', description: 'Run the full unit test suite and capture the complete stdout into a temporary log file so we can inspect every failure' },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const screens = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
  const last = screens[screens.length - 1].payload
  assert.ok((last.pending || []).length > 0, '这一帧应带气泡（前提）')
  for (const line of last.bullets) {
    const width = measureTextPx(line, SCREEN_SPEC.bodyFontPx)
    assert.ok(width <= 240, `行宽 ${width} 超过气泡占用后的 240px：${line}`)
  }
  runtime.dispose()
})

await testAsync('气泡 R-P1-7：直发屏幕帧（聆听/转写）也带 pending，气泡不会被擦掉', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 1000, title: '会话 B' }),
  ]
  const { runtime, socket, emit } = await laneWithSession(records, 'session-a')
  emit('session-b', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B 完成了。' }] } } })
  emit('session-b', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  socket.emit('data', clientFrame(buildUpstream('audio.frame', {
    audioBase64: tinyWavBase64(), format: 'wav', sampleRate: 16000, channels: 1, bits: 16,
  }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 80))
  const listen = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '聆听').pop()
  assert.ok(listen, '应有聆听帧')
  assert.ok((listen.payload.pending || []).length > 0, '聆听帧必须带气泡，否则页面会把气泡轨整条清空')
  runtime.dispose()
})

await testAsync('气泡 R-P1-8：没绑定设备的会话完成后，点气泡能显示正文（不能是空白）', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 1000, title: '会话 B' }),
  ]
  const { runtime, socket, emit } = await laneWithSession(records, 'session-a')
  emit('session-b', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B 的正文在这里。第二句也在这里。' }] } } })
  emit('session-b', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 300, y: 60, hit: 'chip', targetSessionId: 'session-b' }, 3)))
  await new Promise((resolve) => setTimeout(resolve, 150))
  const reply = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply').pop()
  assert.ok(reply, '点气泡后必须切到 B 的正文（旧实现早退时没记 lastReplies → 只有空白）')
  const text = (reply.payload.reply?.sentences ?? []).map((sentence) => sentence.text).join('')
  assert.ok(text.includes('B 的正文'), '正文内容必须来自 B 的回复，实际 ' + text)
  runtime.dispose()
})

await testAsync('多设备 R-P1-9：一台在看历史时，另一台在底部仍会收到主页（不被别人的浏览状态卡住）', async () => {
  process.env.TIHU_HOME_AFTER_MS = '60'
  process.env.TIHU_HOME_RECHECK_MS = '40'
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const fixture = runtimeFor(records, {}, { instance: fakeTts() })
  const socket1 = openLane(fixture.runtime)
  const socket2 = openLane(fixture.runtime)
  for (const socket of [socket1, socket2]) {
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'multi', protocol: '0', sessionId: 'session-a' }, 1)))
  }
  await new Promise((resolve) => setTimeout(resolve, 40))
  const onSessionEvent = fixture.events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)
  const longText = '这是一段足够长的回复，用来保证正文超过十行，从而可以向上滚动查看历史内容。'.repeat(6)
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: longText }] } } })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  // 设备 1 上滑看历史（follow=false）
  socket1.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'swipe', dy: -80, phase: 'move' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const isHome = (frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home'
  const baseline2 = framesOf(socket2).filter(isHome).length
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && framesOf(socket2).filter(isHome).length <= baseline2) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(
    framesOf(socket2).filter(isHome).length > baseline2,
    '设备 2 在底部、没有任何浏览动作，必须能回主页（旧实现被设备 1 的 follow=false 全局挡住）',
  )
  delete process.env.TIHU_HOME_AFTER_MS
  delete process.env.TIHU_HOME_RECHECK_MS
  fixture.runtime.dispose()
})

await testAsync('换绑 R-P1-10：朗读中切到别的会话，旧会话的音频必须停（不能屏是 B、声还是 A）', async () => {
  const slowTts = {
    ...fakeTts(),
    async synthesize(_text, options) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      options.onChunk({ data: Buffer.alloc(4800), seq: 0, total: 1, final: true })
    },
  }
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 1000, title: '会话 B' }),
  ]
  const { runtime, socket, emit } = await laneWithSession(records, 'session-a', {}, { instance: slowTts })
  const longText = '第一句。第二句。第三句。第四句。第五句。第六句。第七句。第八句。第九句。第十句。'
  emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: longText }] } } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  socket.emit('data', clientFrame(buildUpstream('session.bind', { sessionId: 'session-b' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const framesBefore = framesOf(socket).length
  await new Promise((resolve) => setTimeout(resolve, 400))
  const after = framesOf(socket).slice(framesBefore)
  const audioAfter = after.filter((frame) => frame.type === 'tts.audio')
  assert.equal(audioAfter.length, 0, '切到 B 之后不应再收到 A 的 tts.audio，实际 ' + audioAfter.length + ' 块')
  runtime.dispose()
})

await testAsync('主页 R-P1-11：workspaceRegistry 某条实体 getter 抛错，仍要出主页（不能整条链断掉）', async () => {
  const records = [cuRecord('session-a', { live: true, cwd: '/ok', lastPromptAt: 2000, title: '会话 A' })]
  const good = { id: 'w1', path: '/ok', title: '正常项目', sessionIds: ['session-a'], updatedAt: '2026-11-07T10:00:00.000Z' }
  const bad = {
    id: 'w2',
    get path() { throw new Error('entity disposed') },
    title: '坏项目',
    sessionIds: [],
    updatedAt: '2026-11-07T10:00:00.000Z',
  }
  const { runtime, socket } = await laneWithSession(records, 'session-a', { workspaceRegistry: { list: () => [bad, good] } })
  const home = await waitForFrame(socket, (frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home', 1200)
  assert.ok(home, '坏条目不能让主页帧发不出来（旧实现 getter 抛错 → sendHome 整条 reject）')
  assert.ok(
    (home.payload.home.projects || []).some((project) => project.name === '正常项目'),
    '正常项目必须还在，实际 ' + JSON.stringify(home.payload.home.projects),
  )
  runtime.dispose()
})

test('标题 R-P1-12：标题按加粗宽度排版、页面不再按字数二次截断', () => {
  const title = clipScreenTitle('W'.repeat(60))
  const boldWidth = measureTextPx(title, SCREEN_SPEC.titleFontPx) * 1.06
  assert.ok(boldWidth <= CONTENT_WIDTH_PX + 0.5, `加粗渲染宽 ${boldWidth.toFixed(1)} 超过 304px（真机会被裁）：${title}`)
  assert.ok(title.includes('…'), '超宽标题要有省略号')
  const pageSource = readFileSync(new URL('../src/tihu/page.ts', import.meta.url), 'utf8')
  const titleLine = pageSource.split(String.fromCharCode(10)).find((line) => line.includes("$('title').textContent"))
  assert.ok(titleLine !== undefined, '找不到标题渲染行')
  assert.equal(titleLine.includes('clipScreen'), false, '页面不得再按字数二次截断标题（宿主已按像素截过）：' + titleLine)
})

test('手势 R-P2-1：越界触摸坐标钳到屏幕内（不忽略，也不能把负值传进热点判定）', () => {
  const clampedLow = parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'tap', x: -40, y: -8 }, 70)))
  assert.ok(clampedLow, '越界坐标仍要收下（钳制而不是丢弃）')
  assert.equal(clampedLow.payload.x, 0)
  assert.equal(clampedLow.payload.y, 0)
  const clampedHigh = parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'tap', x: 999, y: 480 }, 71)))
  assert.ok(clampedHigh, '超屏坐标也要收下')
  assert.equal(clampedHigh.payload.x, 320)
  assert.equal(clampedHigh.payload.y, 240)
  const normal = parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'tap', x: 12, y: 34 }, 72)))
  assert.equal(normal.payload.x, 12)
  assert.equal(normal.payload.y, 34)
})

/* ---------- 2026-11-07 断音根因回归（断在合成层的超时门限，不是页面） ----------
 *
 * 现场实测（C:\Users\Administrator\.dsh\repro\tihu-tts-cut\probe-edge.mjs）：
 *   - 4 路并发首块 2263–3317ms；8 路并发开始有段被杀；**12 路并发（=3 个标签页 × 4 并发）
 *     8/12 段 first=-1 / audio=0**，全部由 tts.ts 的 3500ms first-chunk 定时器杀掉；
 *   - 被杀之后落本地 Qwen，本机 CPU 首包实测 **54485ms**（probe-qwen.mjs），
 *     而 synthesize() 给默认音色套的是 4500ms 中止 → 兜底必挂；
 *   - tts.audio 按句序 flush，卡住的那一段把后面已合成好的段全压住 → 页面念一句后静音。
 * 这一批用例盯死这四件事：门限、兜底门限、单段卡顿、同会话并读。
 */

await testAsync('lane：12 并发下 edge 首块门限不误杀', async () => {
  const ttsModule = await import('../src/tihu/tts.ts')
  assert.equal(typeof ttsModule.edgeFirstChunkMs, 'function', 'tts 需要导出可测的 edgeFirstChunkMs()')
  delete process.env.TIHU_EDGE_FIRST_MS
  const fallback = ttsModule.edgeFirstChunkMs()
  assert.ok(
    fallback >= 8000,
    `12 路并发实测首块到 3304ms 且 8/12 段被门限杀掉，默认门限 ${fallback}ms 仍然太紧（会把整段杀成 0 字节）`,
  )
  process.env.TIHU_EDGE_FIRST_MS = '12000'
  assert.equal(ttsModule.edgeFirstChunkMs(), 12000, 'TIHU_EDGE_FIRST_MS 要能覆盖默认值')
  process.env.TIHU_EDGE_FIRST_MS = '0'
  assert.equal(ttsModule.edgeFirstChunkMs(), 3000, '0/负数要钳到下限 3000ms')
  process.env.TIHU_EDGE_FIRST_MS = 'abc'
  assert.equal(ttsModule.edgeFirstChunkMs(), fallback, '非数字要退回默认值')
  process.env.TIHU_EDGE_FIRST_MS = '999999'
  assert.equal(ttsModule.edgeFirstChunkMs(), 60000, '过大要钳到上限 60000ms')
  delete process.env.TIHU_EDGE_FIRST_MS

  // 首块超时：先重试一次 edge，不能直接落本地（本地 CPU 首包 54s，等于放弃这一句）
  const instance = new ttsModule.TihuTts({ log: () => {}, threads: 1 })
  let edgeCalls = 0
  let codecCalls = 0
  instance.edgeReady = () => true
  instance.synthesizeEdge = async (_text, options) => {
    edgeCalls += 1
    if (edgeCalls === 1) throw new Error('edge-tts 首块超时（8000ms 未返回音频）')
    options.onChunk({ data: Buffer.alloc(4800), seq: 0, total: 1, final: true })
    return { sampleRate: 24000, firstChunkMs: 120, audioMs: 2400, totalMs: 260, chunks: 1 }
  }
  instance.synthesizeCodec = async () => { codecCalls += 1; throw new Error('不该走到本地兜底') }
  const result = await instance.synthesize('第一句。', { onChunk: () => {} })
  assert.equal(edgeCalls, 2, `首块超时必须先重试 edge 一次，实际只调了 ${edgeCalls} 次`)
  assert.equal(codecCalls, 0, '重试成功后不该再落本地兜底')
  assert.equal(result.audioMs, 2400, '重试成功要正常返回音频时长')
  instance.dispose()

  // 非超时失败（403/无音频）不做无谓重试，仍按原样落兜底路径
  const strict = new ttsModule.TihuTts({ log: () => {}, threads: 1 })
  let strictEdge = 0
  strict.edgeReady = () => true
  strict.backend = () => 'none'
  strict.synthesizeEdge = async () => { strictEdge += 1; throw new Error('edge-tts 失败（exit 1）：403') }
  await assert.rejects(strict.synthesize('第一句。', { onChunk: () => {} }), /403/)
  assert.equal(strictEdge, 1, '非首块超时不要重试 edge（避免 403 白等两轮）')
  strict.dispose()
})

await testAsync('tts：本地 Qwen CPU 首包 54s 时不得 4.5s 中止', async () => {
  const ttsModule = await import('../src/tihu/tts.ts')
  assert.equal(typeof ttsModule.localFallbackAbortMs, 'function', 'tts 需要导出可测的 localFallbackAbortMs()')
  assert.equal(typeof ttsModule.cpuFallbackBlocked, 'function', 'tts 需要导出可测的 cpuFallbackBlocked()')

  delete process.env.TIHU_TTS_CPU_FALLBACK
  assert.equal(ttsModule.cpuFallbackBlocked(false, 'cpu'), true, '默认音色 + CPU：不能再等本地兜底（首包 54s，必挂）')
  assert.equal(ttsModule.cpuFallbackBlocked(true, 'cpu'), false, '克隆音色只有本地引擎，必须放行')
  assert.equal(ttsModule.cpuFallbackBlocked(false, 'qwen-cuda'), false, 'GPU 兜底照常可用')
  process.env.TIHU_TTS_CPU_FALLBACK = '1'
  assert.equal(ttsModule.cpuFallbackBlocked(false, 'cpu'), false, 'TIHU_TTS_CPU_FALLBACK=1 时允许用 CPU 兜底')
  const allowedMs = ttsModule.localFallbackAbortMs(false, 'cpu')
  assert.ok(
    allowedMs === 0 || allowedMs >= 54000,
    `允许 CPU 兜底时中止门限 ${allowedMs}ms 也必须长于实测首包 54485ms（0 = 不单独中止）`,
  )
  process.env.TIHU_TTS_CPU_FALLBACK = '1'
  delete process.env.TIHU_TTS_CPU_FALLBACK
  // 默认音色 + CPU + edge 失败：立刻给出明确原因，不进 4.5s/45s 的本地等待，更不能静默返回 0 字节
  const instance = new ttsModule.TihuTts({ log: () => {}, threads: 1 })
  let codecCalls = 0
  instance.edgeReady = () => true
  instance.backend = () => 'cpu'
  instance.ensureServer = async () => {}
  instance.synthesizeEdge = async () => { throw new Error('edge-tts 没有返回音频：') }
  instance.synthesizeCodec = async () => { codecCalls += 1; throw new Error('不该走到本地兜底') }
  await assert.rejects(
    instance.synthesize('第一句。', { onChunk: () => {} }),
    /CPU/,
    'CPU 兜底被禁用时要抛出带 CPU 原因的错，不能静默返回空音频',
  )
  assert.equal(codecCalls, 0, `CPU 兜底禁用时不许再发一次 54s 的请求，实际发了 ${codecCalls} 次`)
  instance.dispose()
})

await testAsync('lane：单段卡 12s 不得出现 >1.5s 静音缝', async () => {
  const AUDIO_MS = 2000
  const CHUNK_MS = 200
  const FIRST_MS = 200
  const STALL_INDEX = 2
  const STALL_MS = 12_000
  let seq = 0
  const stallTts = {
    async ensureServer() {},
    status: () => ({ available: true, model: 'stall-test' }),
    engineLabel: () => 'stall-test',
    takeEngineNote: () => '',
    deviceFallback: () => '',
    available: () => true,
    async synthesize(text, options) {
      const index = Number(/第(\d+)段/.exec(text)?.[1] ?? 0)
      await waitMs(FIRST_MS)
      const chunks = Math.round(AUDIO_MS / CHUNK_MS)
      for (let i = 0; i < chunks; i += 1) {
        if (index === STALL_INDEX && i === 1) {
          // edge 实测过的长尾：首块已到、后续块卡住 12s
          await waitMs(STALL_MS)
        }
        options.onChunk({ data: Buffer.alloc(CHUNK_MS * 48), seq, total: 0, final: i === chunks - 1 })
        seq += 1
        await waitMs(2)
      }
      return { sampleRate: 24000, firstChunkMs: FIRST_MS, audioMs: AUDIO_MS, totalMs: FIRST_MS + AUDIO_MS, chunks }
    },
    async createVoice() { throw new Error('n/a') },
    async listVoices() { return [] },
    dispose() {},
  }
  const records = [cuRecord('session-1', { live: true, lastPromptAt: 1000 })]
  const { runtime, events } = runtimeFor(records, {}, { instance: stallTts })
  const socket = openTimedLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'stall', protocol: '0', sessionId: 'session-1' }, 1)))
  await waitMs(30)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const text = Array.from({ length: 6 }, (_, i) => `第${i}段内容。`).join('')
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })
  await waitMs(4000)

  const audio = socket.timedFrames().filter((frame) => frame.type === 'tts.audio')
  // 容差 1500ms：卡住那段的已有音频播完后，最多 1.5s 内必须接上下一句
  const gaps = silenceGaps(audio, 1500)
  assert.equal(
    gaps.length,
    0,
    `单段卡 ${STALL_MS}ms 就整轮静音：出现 ${gaps.length} 处 >1.5s 静音（${gaps.map((gap) => `停在 ${gap.at}ms 断 ${gap.silenceMs}ms`).join(' / ')}）`,
  )
  // 不能悄悄停：卡住时要有一条「第 k 句」的人话提示
  const progress = socket.timedFrames()
    .filter((frame) => frame.type === 'event.progress')
    .map((frame) => String(frame.payload.text ?? ''))
  assert.ok(
    progress.some((line) => /第 3\/6/.test(line)),
    `卡住时要告诉用户卡在第几句，实际进度：${progress.join(' | ')}`,
  )
  runtime.dispose()
})

await testAsync('lane：同会话连续两条 assistant/message 不得并读', async () => {
  const LATENCY = 600
  let inFlight = 0
  let peak = 0
  const calls = []
  const slowTts = {
    async ensureServer() {},
    status: () => ({ available: true, model: 'slow-test' }),
    engineLabel: () => 'slow-test',
    takeEngineNote: () => '',
    deviceFallback: () => '',
    available: () => true,
    async synthesize(text, options) {
      calls.push(text)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await waitMs(LATENCY)
        options.onChunk({ data: Buffer.alloc(4800), seq: 0, total: 1, final: true })
        return { sampleRate: 24000, firstChunkMs: LATENCY, audioMs: 1500, totalMs: LATENCY, chunks: 1 }
      } finally {
        inFlight -= 1
      }
    },
    async createVoice() { throw new Error('n/a') },
    async listVoices() { return [] },
    dispose() {},
  }
  const records = [cuRecord('session-1', { live: true, lastPromptAt: 1000 })]
  const { runtime, events } = runtimeFor(records, {}, { instance: slowTts })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'dupe', protocol: '0', sessionId: 'session-1' }, 1)))
  await waitMs(30)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const first = Array.from({ length: 12 }, (_, i) => `第${i}段。`).join('')
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: first }] } },
  })
  await waitMs(360)
  const second = first + '追加两句，说明这是流式更新后的更长正文。'
  onSessionEvent({ id: 'session-1', header: { id: 'session-1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: second }] } },
  })
  await waitMs(3500)

  // 第一轮必须先被掐掉：否则两轮的合成同时跑（旧实现实测 26 次合成、页面收到两遍 index 0..11）
  assert.ok(
    calls.length <= 14 + 4,
    `两轮都完整合成了一遍（${calls.length} 次，并发峰值 ${peak}）；第一轮应当在第二轮到达时被取消`,
  )
  const errors = framesOf(socket)
    .filter((frame) => frame.type === 'event.alert' && frame.payload.level === 'error')
    .map((frame) => String(frame.payload.text ?? ''))
  assert.equal(errors.length, 0, '取消上一轮是正常行为，不能报「本次无语音」：' + errors.join(' | '))
  const audio = framesOf(socket).filter((frame) => frame.type === 'tts.audio')
  assert.ok(audio.length > 0, '第二轮仍要正常出声')
  runtime.dispose()
})

test('page：stage=回答中 的新 reply 帧不得清空朗读队列', () => {
  const { ctx } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {}, tts: { disabled: true } })
  const html = runtime.page()
  runtime.dispose()
  assert.equal(
    html.includes("payload.stage === '回复'"),
    false,
    "lane 的回复帧 stage 恒为「回答中」，页面上这条 stage==='回复' 的 reset 是死代码（永远不会触发），要删掉",
  )
  const source = readFileSync(new URL('../src/tihu/page.ts', import.meta.url), 'utf8')
  const screenCaseStart = source.indexOf("case 'screen.frame'")
  const transcriptCaseStart = source.indexOf("case 'transcript'")
  assert.ok(screenCaseStart > 0 && transcriptCaseStart > screenCaseStart, '找不到 screen.frame / transcript 分支')
  const screenCase = source.slice(screenCaseStart, transcriptCaseStart)
  assert.equal(
    screenCase.includes('resetTurnAudio'),
    false,
    'screen.frame 分支不得清空朗读队列：' + screenCase.split(String.fromCharCode(10)).join(' / '),
  )
  // 清队列这件事只留给「用户新的语音输入」（transcript），这条要留着
  const transcriptCase = source.slice(transcriptCaseStart, source.indexOf("case 'tts.text'"))
  assert.ok(transcriptCase.includes('resetTurnAudio'), 'transcript 仍要停掉上一轮残留音频')
})


await testAsync('lane：主页项目帧带 sessionId，点项目行（hit=project）即绑定进入该会话', async () => {
  const now = Date.now()
  const iso = (agoMs) => new Date(now - agoMs).toISOString()
  const records = [
    cuRecord('session-a', { preset: 'computer-use', live: true, cwd: 'D:\\磷石膏SCI', lastPromptAt: now - 30_000, title: '磷石膏 会话 A' }),
    cuRecord('session-b', { preset: 'computer-use', cwd: 'D:\\桥梁温度场', lastPromptAt: now - 20 * 60_000, title: '温度场 会话 B' }),
  ]
  const workspaces = [
    { id: 'ws-a', path: 'D:\\磷石膏SCI', title: '磷石膏SCI', createdAt: iso(400_000), updatedAt: iso(30_000), sessionIds: ['session-a'] },
    { id: 'ws-b', path: 'D:\\桥梁温度场', title: '桥梁温度场', createdAt: iso(420_000), updatedAt: iso(50_000), sessionIds: ['session-b'] },
  ]
  const { runtime } = runtimeFor(records, { workspaceRegistry: workspaceRegistryFixture(workspaces) })
  const socket = openLane(runtime)
  // 不带 sessionId、不带 auto：未绑定设备，hello 后直接给主页
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'tap-project', protocol: '0' }, 1)))
  await waitMs(60)
  const homes = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home')
  assert.ok(homes.length > 0, '未绑定设备 hello 后应收主页')
  const home = homes[homes.length - 1].payload.home
  const withId = home.projects.filter((item) => typeof item.sessionId === 'string' && item.sessionId !== '')
  assert.ok(withId.length >= 2, `主页项目应带 sessionId（点项目进入），实际 ${JSON.stringify(home.projects)}`)
  const target = home.projects.find((item) => item.sessionId === 'session-b')
  assert.ok(target, 'session-b 应在主页清单里')
  // 点项目行 → 绑定到 session-b（未绑定设备也要能吃这个 tap）
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 40, y: 60, hit: 'project', project: target.name, sessionId: 'session-b' }, 2)))
  await waitMs(80)
  const bounds = framesOf(socket).filter((frame) => frame.type === 'session.bound')
  assert.ok(bounds.some((frame) => frame.payload.sessionId === 'session-b'), '点项目后应收 session.bound(session-b)')
  runtime.dispose()
})

await testAsync('lane：已绑定设备点别的项目行会换绑，点右下角仍回主页', async () => {
  const now = Date.now()
  const iso = (agoMs) => new Date(now - agoMs).toISOString()
  const records = [
    cuRecord('session-a', { preset: 'computer-use', live: true, cwd: 'D:\\磷石膏SCI', lastPromptAt: now - 30_000, title: '磷石膏 会话 A' }),
    cuRecord('session-b', { preset: 'computer-use', cwd: 'D:\\桥梁温度场', lastPromptAt: now - 20 * 60_000, title: '温度场 会话 B' }),
  ]
  const workspaces = [
    { id: 'ws-a', path: 'D:\\磷石膏SCI', title: '磷石膏SCI', createdAt: iso(400_000), updatedAt: iso(30_000), sessionIds: ['session-a'] },
    { id: 'ws-b', path: 'D:\\桥梁温度场', title: '桥梁温度场', createdAt: iso(420_000), updatedAt: iso(50_000), sessionIds: ['session-b'] },
  ]
  const { runtime } = runtimeFor(records, { workspaceRegistry: workspaceRegistryFixture(workspaces) })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'tap-switch', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(60)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 40, y: 96, hit: 'project', project: '桥梁温度场', sessionId: 'session-b' }, 2)))
  await waitMs(80)
  const bounds = framesOf(socket).filter((frame) => frame.type === 'session.bound' && frame.payload.sessionId === 'session-b')
  assert.ok(bounds.length > 0, '已绑定设备点别的项目应收 session.boound(session-b)')
  // 右下角 tap → 回主页
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 300, y: 200 }, 3)))
  await waitMs(80)
  const homes = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home')
  assert.ok(homes.length > 0, '右下角 tap 仍应回主页')
  runtime.dispose()
})


test('进度屏：第一步就有「思考」占位，真实 thinking 到了原地替换不留两条', () => {
  const state = createProgressState(1000)
  const start = applySessionEvent(state, { type: 'turn/start', data: { turn: 9 } }, 1000)
  assert.ok(start.screen.bullets[0].startsWith('思考'), 'turn/start 首帧就要显示思考：' + start.screen.bullets[0])
  const step = applySessionEvent(state, { type: 'step/start', data: { turn: 9, step: 1 } }, 1200)
  assert.ok(step.screen.bullets[0].startsWith('思考'), 'step/start 首帧也要显示思考：' + step.screen.bullets[0])
  const thought = applySessionEvent(state, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'thinking', thinking: '先看仓库结构，再改 lane.ts。' }, { type: 'text', text: '好。' }] } },
  }, 2000)
  const thinkingLines = thought.screen.bullets.filter((line) => line.startsWith('思考'))
  assert.equal(thinkingLines.length, 1, '只留一条思考：' + thought.screen.bullets.join(' / '))
  assert.ok(thinkingLines[0].includes('先看仓库结构'), '改成真实思考内容：' + thinkingLines[0])
})


await testAsync('lane：回复屏带停止/重读/回主页三个按钮，点了各自生效', async () => {
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'reply-actions', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
  emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一句话。第二句话。' }] } } })
  await waitMs(150)
  let replyFrames = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  assert.ok(replyFrames.length > 0, '应有回复帧')
  const actions = replyFrames[replyFrames.length - 1].payload.actions
  assert.ok(Array.isArray(actions) && actions.length === 3, '回复帧要带三个按钮：' + JSON.stringify(actions))
  assert.deepEqual(actions.map((item) => item.id), ['stop', 'replay', 'home'])
  assert.equal(replyFrames[replyFrames.length - 1].payload.running, undefined, '回复屏不列运行中会话')

  const audioBeforeStop = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 40, y: 220, hit: 'action', actionId: 'stop' }, 2)))
  await waitMs(220)
  const audioAfterStop = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
  assert.equal(audioAfterStop, audioBeforeStop, '停止后不得再发音频')

  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 160, y: 220, hit: 'action', actionId: 'replay' }, 3)))
  await waitMs(150)
  replyFrames = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  assert.ok(replyFrames.some((frame) => frame.payload.reply.currentIndex === 0), '重读要先回到第一句：' + JSON.stringify(replyFrames.slice(-3).map((frame) => frame.payload.reply.currentIndex)))
  const audioAfterReplay = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
  assert.ok(audioAfterReplay > audioAfterStop, '重读要重新发音频')

  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 4)))
  await waitMs(120)
  assert.ok(framesOf(socket).some((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home'), '回主页按钮要回主页')
  runtime.dispose()
})

await testAsync('lane：状态屏底部列出其他运行中会话，运行状态一变就刷新，点了能切过去', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 3000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 2000, title: '会话 B' }),
    cuRecord('session-c', { live: true, cwd: '/c', lastPromptAt: 1000, title: '会话 C' }),
  ]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'running-list', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
  emit('session-b', { type: 'turn/start', data: { turn: 1 } })
  await waitMs(80)
  emit('session-c', { type: 'turn/start', data: { turn: 1 } })
  await waitMs(150)
  const statusFrames = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode !== 'home' && frame.payload.mode !== 'reply' && Array.isArray(frame.payload.running))
  assert.ok(statusFrames.length > 0, '状态屏要带 other running 列表')
  const last = statusFrames[statusFrames.length - 1].payload
  assert.ok(last.running.some((item) => item.sessionId === 'session-c'), '要列出正在跑的 c：' + JSON.stringify(last.running))
  assert.ok(!last.running.some((item) => item.sessionId === 'session-b'), '不列自己')

  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 120, y: 218, hit: 'switch', targetSessionId: 'session-c' }, 2)))
  await waitMs(150)
  const bounds = framesOf(socket).filter((frame) => frame.type === 'session.bound')
  assert.equal(bounds[bounds.length - 1].payload.sessionId, 'session-c', '点了就切到 c')
  runtime.dispose()
})


await testAsync('lane：回复屏带停止/重读/回主页三个按钮，点了各自生效', async () => {
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'reply-actions', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
  emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一句话。第二句话。' }] } } })
  await waitMs(150)
  let replyFrames = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  assert.ok(replyFrames.length > 0, '应有回复帧')
  const actions = replyFrames[replyFrames.length - 1].payload.actions
  assert.ok(Array.isArray(actions) && actions.length === 3, '回复帧要带三个按钮：' + JSON.stringify(actions))
  assert.deepEqual(actions.map((item) => item.id), ['stop', 'replay', 'home'])
  assert.equal(replyFrames[replyFrames.length - 1].payload.running, undefined, '回复屏不列运行中会话')

  const audioBeforeStop = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 40, y: 220, hit: 'action', actionId: 'stop' }, 2)))
  await waitMs(220)
  const audioAfterStop = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
  assert.equal(audioAfterStop, audioBeforeStop, '停止后不得再发音频')

  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 160, y: 220, hit: 'action', actionId: 'replay' }, 3)))
  await waitMs(150)
  replyFrames = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  assert.ok(replyFrames.some((frame) => frame.payload.reply.currentIndex === 0), '重读要先回到第一句')
  const audioAfterReplay = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
  assert.ok(audioAfterReplay > audioAfterStop, '重读要重新发音频')

  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 4)))
  await waitMs(120)
  assert.ok(framesOf(socket).some((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home'), '回主页按钮要回主页')
  runtime.dispose()
})

await testAsync('lane：状态屏底部只列 Computer Use 模式的运行中会话，点了能切过去', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 3000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 2000, title: '会话 B' }),
    cuRecord('session-c', { live: true, cwd: '/c', lastPromptAt: 1000, title: '会话 C' }),
    cuRecord('session-d', { live: true, cwd: '/d', lastPromptAt: 500, title: '会话 D', preset: 'standard' }),
  ]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'running-list', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
  emit('session-b', { type: 'turn/start', data: { turn: 1 } })
  await waitMs(80)
  emit('session-c', { type: 'turn/start', data: { turn: 1 } })
  emit('session-d', { type: 'turn/start', data: { turn: 1 } })
  await waitMs(150)
  const statusFrames = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode !== 'home' && frame.payload.mode !== 'reply' && Array.isArray(frame.payload.running))
  assert.ok(statusFrames.length > 0, '状态屏要带 other running 列表')
  const last = statusFrames[statusFrames.length - 1].payload
  assert.ok(last.running.some((item) => item.sessionId === 'session-c'), '要列出正在跑的 c：' + JSON.stringify(last.running))
  assert.ok(!last.running.some((item) => item.sessionId === 'session-b'), '不列自己')
  assert.ok(!last.running.some((item) => item.sessionId === 'session-d'), '只要 Computer Use 模式的会话，standard 不列：' + JSON.stringify(last.running))

  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 120, y: 218, hit: 'switch', targetSessionId: 'session-c' }, 2)))
  await waitMs(150)
  const bounds = framesOf(socket).filter((frame) => frame.type === 'session.bound')
  assert.equal(bounds[bounds.length - 1].payload.sessionId, 'session-c', '点了就切到 c')
  runtime.dispose()
})


await testAsync('lane：首页项目清单与控制室卡片一致（隐藏/删除的都不显示）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tihu-cards-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({
    projects: {
      order: ['layout-a', 'wt-assistant', 'layout-hidden', 'layout-removed'],
      layouts: [{ id: 'layout-a', title: '磷石膏SCI' }, { id: 'layout-hidden', title: '隐藏项目' }, { id: 'layout-removed', title: '删除项目' }],
      hidden: ['layout-hidden'],
      removed: ['layout-removed'],
      nameOverrides: { 'wt-assistant': '个人助手' },
      folders: {
        'layout-a': 'D:\\proj\\phosphogypsum',
        'layout-hidden': 'D:\\proj\\hidden',
        'layout-removed': 'D:\\proj\\removed',
      },
    },
  }), 'utf8')
  process.env.TIHU_PROJECTS_STATE = file
  const now = Date.now()
  const iso = (ago) => new Date(now - ago).toISOString()
  const records = [
    cuRecord('session-a', { preset: 'computer-use', cwd: 'D:\\proj\\phosphogypsum\\a', live: true, lastPromptAt: now - 20_000, title: '会话 A' }),
    cuRecord('session-h', { preset: 'computer-use', cwd: 'D:\\proj\\hidden', live: true, lastPromptAt: now - 10_000, title: '隐藏会话' }),
    cuRecord('session-r', { preset: 'computer-use', cwd: 'D:\\proj\\removed', live: true, lastPromptAt: now - 5_000, title: '删掉会话' }),
    cuRecord('session-g', { preset: 'computer-use', cwd: 'D:\\proj\\never-card', live: true, lastPromptAt: now - 1_000, title: '没建卡' }),
  ]
  const workspaces = [
    { id: 'ws-a', path: 'D:\\proj\\phosphogypsum', title: 'phosphogypsum', createdAt: iso(400_000), updatedAt: iso(20_000), sessionIds: ['session-a'] },
    { id: 'ws-h', path: 'D:\\proj\\hidden', title: 'hidden', createdAt: iso(400_000), updatedAt: iso(10_000), sessionIds: ['session-h'] },
    { id: 'ws-r', path: 'D:\\proj\\removed', title: 'removed', createdAt: iso(400_000), updatedAt: iso(5_000), sessionIds: ['session-r'] },
    { id: 'ws-g', path: 'D:\\proj\\never-card', title: 'never-card', createdAt: iso(400_000), updatedAt: iso(1_000), sessionIds: ['session-g'] },
  ]
  const { runtime } = runtimeFor(records, { workspaceRegistry: workspaceRegistryFixture(workspaces) })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'cards', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(60)
  const home = await tapHomeFrame(socket)
  const names = home.projects.map((item) => item.name)
  assert.deepEqual(names, ['磷石膏SCI'], '只显示控制室可见卡（隐藏/删除/未建卡都不显示），实际 ' + JSON.stringify(names))
  assert.equal(home.total, 1)
  runtime.dispose()
  delete process.env.TIHU_PROJECTS_STATE
  rmSync(dir, { recursive: true, force: true })
})


await testAsync('lane：绑定后的「已绑定」提示屏停 3 秒就回主页，不必等空闲计时', async () => {
  process.env.TIHU_BIND_HOME_MS = '120'
  process.env.TIHU_HOME_AFTER_MS = '60000'
  try {
    const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
    const { runtime } = runtimeFor(records, {}, { instance: fakeTts() })
    const socket = openLane(runtime)
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'bind-home', protocol: '0' }, 1)))
    await waitMs(40)
    const homesBefore = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home').length
    // 手动绑定（页面重连后补发 session.bind 就是这条路）：会先出「已绑定」提示屏
    socket.emit('data', clientFrame(buildUpstream('session.bind', { sessionId: 'session-a' }, 2)))
    await waitMs(60)
    const afterBind = framesOf(socket).filter((frame) => frame.type === 'screen.frame')
    assert.ok(afterBind.some((frame) => frame.payload.title.includes('已绑定')), '绑定瞬间应有「已绑定」提示屏')
    await waitMs(260)
    const homes = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'home').length
    assert.ok(homes > homesBefore, '绑定后应主动回主页（不能等 TIHU_HOME_AFTER_MS）：' + homesBefore + ' → ' + homes)
    runtime.dispose()
  } finally {
    delete process.env.TIHU_BIND_HOME_MS
    delete process.env.TIHU_HOME_AFTER_MS
  }
})

await testAsync('lane：正在朗读回复时，「绑定回主页」计时不得把屏切走', async () => {
  process.env.TIHU_BIND_HOME_MS = '120'
  try {
    const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
    const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
    const socket = openLane(runtime)
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'bind-reply', protocol: '0', sessionId: 'session-a' }, 1)))
    await waitMs(40)
    const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
    onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答复第一句。答复第二句。' }] } } })
    await waitMs(260)
    const lastFrame = framesOf(socket).filter((frame) => frame.type === 'screen.frame').pop()
    assert.notEqual(lastFrame.payload.mode, 'home', '正在朗读回复时不能被绑定计时切回主页')
    runtime.dispose()
  } finally {
    delete process.env.TIHU_BIND_HOME_MS
  }
})


await testAsync('lane：刚开的 CU 会话还没进列表缓存，也要立刻出现在运行中清单里', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' }),
  ]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'fresh-cu', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
  // a 自己在跑：设备不会跟上别人，屏留在 a
  emit('session-a', { type: 'turn/start', data: { turn: 1 } })
  await waitMs(80)
  // 新会话不在列表缓存里，只从事件里带来 agentPreset
  onSessionEvent({ id: 'session-new', header: { id: 'session-new', agentPreset: 'computer-use' } }, { type: 'turn/start', data: { turn: 1 } })
  await waitMs(150)
  const statusFrames = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && Array.isArray(frame.payload.running))
  assert.ok(statusFrames.length > 0, '应有带 running 的状态帧')
  const last = statusFrames[statusFrames.length - 1].payload
  assert.ok(last.running.some((item) => item.sessionId === 'session-new'), '新开的 CU 会话要立刻进清单：' + JSON.stringify(last.running))
  runtime.dispose()
})


/* ---------- 2026-11-08：第四行解码速度改为实时窗口速度 ---------- */
test('速度窗口：decodeRateOf 只看 token 增量 ÷ 解码毫秒增量', () => {
  assert.equal(decodeRateOf([]), undefined)
  assert.equal(decodeRateOf([{ at: 1, decodeMs: 1000, decodeTokens: 100 }]), undefined, '只有一段样本时给不出增量速度')
  const pair = [{ at: 1000, decodeMs: 10_000, decodeTokens: 1_000 }, { at: 2000, decodeMs: 20_000, decodeTokens: 3_000 }]
  assert.equal(decodeRateOf(pair), 200)
  assert.equal(decodeRateOf([{ at: 1, decodeMs: 1000, decodeTokens: 100 }, { at: 2, decodeMs: 1050, decodeTokens: 120 }]), undefined, '不足 200ms 跳动不算速度')
  const pruned = pushDecodeSample(pair, { at: 3000, decodeMs: 500, decodeTokens: 50 })
  assert.equal(pruned.length, 1, '换轮重置后只留新样本：' + JSON.stringify(pruned))
  const aged = pushDecodeSample([{ at: 0, decodeMs: 1000, decodeTokens: 100 }], { at: 20_000, decodeMs: 3000, decodeTokens: 300 })
  assert.equal(aged.length, 1, '超出 15s 窗口的旧样本丢弃')
  assert.equal(SPEED_WINDOW_MS, 15_000)
})

await testAsync('速度行：状态屏第四行是窗口实时速度，不再是全程平均', async () => {
  const projection = {
    title: '会话 A',
    agentPreset: 'computer-use',
    sessionListMetadata: { blank: false, lastPromptAt: 2000 },
    sessionStats: { decodeMs: 10_000, decodeTokens: 1_000 },
    tokenUsage: { totalTokens: 20_000 },
    contextPressure: { contextWindow: 100_000, pressureTokens: 20_000 },
  }
  const records = [{ ...cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000 }), projection }]
  const { runtime, socket, emit } = await laneWithSession(records, 'session-a', { sessions: { get: () => ({ header: { id: 'session-a' } }) } })
  const statsLine = () => {
    const frames = framesOf(socket).filter((f) => f.type === 'screen.frame' && f.payload.mode !== 'home' && f.payload.mode !== 'reply'
      && Array.isArray(f.payload.bullets) && f.payload.bullets.some((line) => line.includes('tok/s')))
    const last = frames[frames.length - 1]
    return last === undefined ? '' : (last.payload.bullets ?? []).join(' / ')
  }
  emit('session-a', { type: 'turn/start', data: { turn: 1 } })
  await waitMs(60)
  assert.ok(statsLine().includes('100 tok/s'), '首帧只有平均可用：' + statsLine())
  projection.sessionStats = { decodeMs: 20_000, decodeTokens: 3_000 }
  emit('session-a', { type: 'tool/call', data: { turn: 1, step: 1, name: 'pwsh', arguments: { command: 'node x.mjs' } } })
  await waitMs(60)
  assert.ok(statsLine().includes('200 tok/s'), '第二帧该给窗口增量 200：' + statsLine())
  projection.sessionStats = { decodeMs: 25_000, decodeTokens: 3_500 }
  emit('session-a', { type: 'tool/call', data: { turn: 1, step: 2, name: 'glob', arguments: { pattern: '**/*.ts' } } })
  await waitMs(60)
  const line = statsLine()
  assert.ok(line.includes('167 tok/s'), '窗口整体速度 167：' + line)
  assert.ok(!line.includes('100 tok/s'), '不得再显示全程平均 100：' + line)
  runtime.dispose()
})


/* ---------- 2026-11-08：状态屏第四行统计小 2 号 ---------- */
test('统计行字号：SCREEN_SPEC 比正文小 2 号，statusFrame 标出 statsTail', () => {
  assert.equal(SCREEN_SPEC.statsFontPx, SCREEN_SPEC.bodyFontPx - 2, '第四行要比正文小 2 号')
  assert.equal(SCREEN_SPEC.statsLineHeightPx, SCREEN_SPEC.bodyLineHeightPx - 2)
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 2 } }, 1000)
  applySessionEvent(state, { type: 'tool/call', data: { turn: 2, step: 1, name: 'glob', arguments: { pattern: '**/a.ts' } } }, 1500, { stats: { tokPerSec: 128, totalTokens: 5000, contextPercent: 30 } })
  const frame = applySessionEvent(state, { type: 'tool/call', data: { turn: 2, step: 2, name: 'grep', arguments: { pattern: 'x' } } }, 2000, { stats: { tokPerSec: 128, totalTokens: 5000, contextPercent: 30 } }).screen
  assert.equal(frame.statsTail, 1, '最后一行才是统计行：' + JSON.stringify(frame.bullets))
  assert.ok(frame.bullets[frame.bullets.length - 1].includes('tok/s'), '统计行内容不变：' + frame.bullets.join(' / '))
  assert.ok(frame.bullets[0].includes('查找文件'), '第二行仍是明细：' + frame.bullets[0])
})

await testAsync('统计行渲染：lane 透传 statsTail，页面用 statsFontPx 排版', async () => {
  const { runtime } = runtimeFor([cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000 })])
  const html = runtime.page()
  assert.ok(html.includes('statsTail'), '页面要读 payload.statsTail')
  assert.ok(html.includes('SCREEN.statsFontPx'), '页面按 SCREEN_SPEC.statsFontPx 排统计行')
  assert.ok(html.includes('SCREEN.statsLineHeightPx'), '统计行行高也走规格')
  runtime.dispose()
})


/* ---------- 2026-11-08：运行中清单显示会话名称，不是会话代号 ---------- */
await testAsync('运行中清单：投影没标题时读标题快照，屏上显示会话名称', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000 }),
    {
      ...cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 1000 }),
      // 投影里刻意不给 title：屏上必须靠标题快照给出名字，不能剩成代号
      projection: { agentPreset: 'computer-use', sessionListMetadata: { blank: false, lastPromptAt: 1000 } },
    },
  ]
  const asked = [] 
  const query = {
    listSessions: async () => records.map(({ projection, ...record }) => record),
    readTitleSnapshots: async (ids) => {
      asked.push(ids.slice())
      return ids.map((id) => ({ session: { id }, title: { title: '名字-' + id } }))
    },
  }
  const { runtime, socket, emit } = await laneWithSession(records, 'session-a', { sessionQuery: query })
  emit('session-a', { type: 'turn/start', data: { turn: 1 } })   // 设备自己这一轮在跑：状态帧才会带运行中清单
  emit('session-b', { type: 'turn/start', data: { turn: 1 } })
  const deadline = Date.now() + 2500
  let named = false
  while (Date.now() < deadline && !named) {
    const frames = framesOf(socket).filter((f) => f.type === 'screen.frame' && Array.isArray(f.payload.running))
    for (const frame of frames) {
      for (const item of frame.payload.running) {
        if (item.sessionId === 'session-b' && item.title.includes('名字-')) named = true
      }
    }
    if (!named) await waitMs(60)
  }
  assert.ok(named, '运行中清单要给会话名称：' + JSON.stringify(framesOf(socket).filter((f) => Array.isArray(f.payload.running)).slice(-1)[0]?.payload.running))
  assert.ok(asked.some((ids) => ids.includes('session-b')), '缺标题的会话必须去读一次标题快照')
  runtime.dispose()
})


/* ---------- 2026-11-08：统计行按小字号量宽，不再被省略号裁掉 ---------- */
test('统计行宽：1234.0M 这类长统计放得下，正文字号才会放不下', () => {
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 1 } }, 1000)
  const stats = { tokPerSec: 99, totalTokens: 1_234_000_000, contextPercent: 41 }
  applySessionEvent(state, { type: 'tool/call', data: { turn: 1, step: 25, name: 'glob', arguments: { pattern: '**/a.ts' } } }, 2000, { stats })
  const frame = applySessionEvent(state, { type: 'tool/call', data: { turn: 1, step: 26, name: 'grep', arguments: { pattern: 'x' } } }, 439_000, { stats }).screen
  const tail = frame.bullets[frame.bullets.length - 1]
  assert.ok(tail.includes('1234.0M'), '总 token 不该被裁：' + tail)
  assert.ok(!tail.endsWith('\u2026'), '统计行不该带省略号：' + tail)
  // 同样的统计串按正文字号量宽更挤，小 2 号才有地方放完整文本
  assert.ok(fitLine(tail, CONTENT_WIDTH_PX, SCREEN_SPEC.statsFontPx) === tail, '统计行该是完整串：' + tail)
  const narrow = applySessionEvent(state, { type: 'tool/call', data: { turn: 1, step: 26, name: 'grep', arguments: { pattern: 'x' } } }, 439_000, { stats, narrow: true }).screen
  const narrowTail = narrow.bullets[narrow.bullets.length - 1]
  assert.ok(measureTextPx(narrowTail, SCREEN_SPEC.statsFontPx) <= PENDING_RAIL_WIDTH_PX, '气泡轨占位时统计行也要放得下：' + narrowTail)
  assert.ok(measureTextPx(tail, SCREEN_SPEC.statsFontPx) <= CONTENT_WIDTH_PX, '按统计字号刚好放得下：' + tail)
  for (const line of frame.bullets.slice(0, -1)) assert.ok(measureTextPx(line, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX, '明细行超宽：' + line)
})

/* ---------- 2026-11-08：主页按钮（退出朗读 + 钉住主页）与「最近回答」/上一条/下一条 ---------- */

/** 造一个「按句慢慢合成」的假 TTS：点主页时后续句子还在合成，能验证它们不再下发音频。 */
function pacedTts() {
  return {
    async ensureServer() {},
    status: () => ({ available: true, model: 'paced-test' }),
    engineLabel: () => 'paced-test',
    takeEngineNote: () => '',
    deviceFallback: () => '',
    available: () => true,
    async synthesize(text, options) {
      // 第一句 20ms 出音频；后续句 300ms 才出——点主页时它们还在合成中。
      await waitMs(String(text).includes('第一句') ? 20 : 300)
      if (options.signal?.aborted) throw new Error('aborted')
      options.onChunk({ data: Buffer.alloc(4800), seq: 0, total: 1, final: true })
      return { sampleRate: 24000, audioMs: 100, chunks: 1 }
    },
    async createVoice() { throw new Error('n/a') },
    async listVoices() { return [] },
    dispose() {},
  }
}

function screenFramesOf(socket) {
  return framesOf(socket).filter((frame) => frame.type === 'screen.frame')
}

/** 一屏回复的正文（单句回复时就是整句）。 */
function replyTextOf(frame) {
  if (frame === undefined || frame.payload.reply === undefined) return ''
  return (frame.payload.reply.sentences || []).map((sentence) => sentence.text).join('')
}

test('screen.gesture 校验：hit=recent（首页最近回答行）合法，未知 hit 仍忽略', () => {
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'tap', x: 20, y: 22, hit: 'recent', sessionId: 'session-a' }, 65))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('screen.gesture', { action: 'tap', x: 20, y: 22, hit: 'recent2' }, 66))), null)
})

await testAsync('lane：主页按钮 = 取消本轮朗读 + 钉住主页（不再发「已停止朗读」）', async () => {
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: pacedTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'home-pin', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第一句。第二句。第三句。第四句。' }] } },
  })
  await waitMs(80)
  const audioBefore = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
  assert.ok(audioBefore > 0, '点主页前应已经开始朗读')
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(500)
  const frames = framesOf(socket)
  assert.equal(
    frames.filter((frame) => frame.type === 'tts.audio').length,
    audioBefore,
    '点主页必须取消本轮朗读：后续句子不得再下发音频',
  )
  const progress = frames.filter((frame) => frame.type === 'event.progress').map((frame) => String(frame.payload.text ?? ''))
  assert.ok(!progress.some((text) => text.includes('已停止朗读')), '点主页不得刷「已停止朗读」提示：' + progress.join(' | '))
  const screens = frames.filter((frame) => frame.type === 'screen.frame')
  assert.equal(screens[screens.length - 1].payload.mode, 'home', '点主页后屏要停在主页')
  runtime.dispose()
})

await testAsync('lane：钉住期间 reply/status 帧不覆盖主页，气泡轨仍可见', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 3000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 2000, title: '会话 B' }),
  ]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pin-frames', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
  emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先有一条回答。' }] } } })
  await waitMs(80)
  // 点主页 → 钉住
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(80)
  const mark = framesOf(socket).length
  // 钉住期间：状态帧（工具调用）、同会话 reply 帧、别的会话完成的气泡，都不能把屏切走
  emit('session-a', { type: 'tool/call', data: { turn: 2, step: 1, name: 'read', arguments: { file_path: '/a/x.ts' } } })
  emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这条回复不许顶掉主页。' }] } } })
  emit('session-b', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '会话 B 也完成了。' }] } } })
  emit('session-b', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(200)
  const screens = framesOf(socket).slice(mark).filter((frame) => frame.type === 'screen.frame')
  const nonHome = screens.filter((frame) => frame.payload.mode !== 'home')
  assert.equal(
    nonHome.length,
    0,
    '钉住期间不得有 status/reply 帧覆盖主页：' + JSON.stringify(nonHome.slice(-2).map((frame) => frame.payload.mode)),
  )
  const homes = screens.filter((frame) => frame.payload.mode === 'home')
  assert.ok(homes.length > 0, '气泡/状态变化时仍应下发主页帧（只刷气泡）')
  const last = homes[homes.length - 1].payload
  assert.ok(
    (last.pending || []).some((item) => item.sessionId === 'session-b'),
    '气泡轨仍要可见（挂在主页帧上）：' + JSON.stringify(last.pending),
  )
  runtime.dispose()
})

await testAsync('lane：新的 turn/start 解除主页钉住，回到会话屏并正常出回复', async () => {
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pin-turn', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回答。' }] } } })
  await waitMs(80)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(80)
  const mark = screenFramesOf(socket).length
  emit({ type: 'turn/start', data: { turn: 2 } })
  await waitMs(100)
  const screens = screenFramesOf(socket).slice(mark)
  assert.ok(screens.length > 0, '新 turn/start 后要重新出会话屏')
  assert.notEqual(screens[screens.length - 1].payload.mode, 'home', '新 turn/start 必须解除钉住、回到会话屏')
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新回答。' }] } } })
  await waitMs(120)
  const last = screenFramesOf(socket).pop()
  assert.equal(last.payload.mode, 'reply', '解除钉住后新回复要正常出朗读屏')
  assert.ok(replyTextOf(last).includes('新回答'), '新回复正文要上屏：' + replyTextOf(last))
  runtime.dispose()
})

await testAsync('lane：首页「最近回答 · 会话名」行出现，点它回到那条回答的朗读屏', async () => {
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'recent-row', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(60)
  // 还没有存回复：主页帧不带「最近回答」行
  const initial = screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').pop()
  assert.ok(initial !== undefined, '绑定后应收到主页帧')
  assert.equal(initial.payload.home.recent, undefined, '没有存的回复时不该出「最近回答」行')
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '刚才那条回答。' }] } },
  })
  await waitMs(80)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(100)
  const homeFrame = screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').pop()
  const recent = homeFrame.payload.home.recent
  assert.ok(recent, '有存的回复时首页要出「最近回答」行：' + JSON.stringify(homeFrame.payload.home))
  assert.equal(recent.sessionId, 'session-a')
  assert.ok(String(recent.title).includes('会话 A'), '会话名要能读：' + recent.title)
  assert.equal(/session-|^[0-9a-f]{6,}$/i.test(String(recent.title)), false, '不得显示裸会话 id：' + recent.title)
  const mark = framesOf(socket).length
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 20, y: 22, hit: 'recent', sessionId: 'session-a' }, 3)))
  await waitMs(120)
  const frames = framesOf(socket).slice(mark)
  const replies = frames.filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  assert.ok(replies.length > 0, '点「最近回答」要回到朗读屏')
  const last = replies[replies.length - 1].payload
  assert.ok(replyTextOf({ payload: last }).includes('刚才那条回答'), '要回到刚才那条回答：' + replyTextOf({ payload: last }))
  assert.deepEqual((last.actions || []).map((item) => item.id), ['stop', 'replay', 'home'], '单条历史时只有原来三个按钮')
  assert.equal(frames.filter((frame) => frame.type === 'tts.audio').length, 0, '点最近回答只回屏，不自动朗读（要朗读点重读）')
  runtime.dispose()
})

await testAsync('lane：上一条/下一条 翻页只换屏不自动朗读，浏览期间 10 秒计时器不切走', async () => {
  process.env.TIHU_HOME_AFTER_MS = '60'
  process.env.TIHU_HOME_RECHECK_MS = '40'
  try {
    const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
    const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
    const socket = openLane(runtime)
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'browse', protocol: '0', sessionId: 'session-a' }, 1)))
    await waitMs(40)
    const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
    const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)
    for (const text of ['第一条回答。', '第二条回答。', '第三条回答。']) {
      emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
      await waitMs(80)
    }
    await waitMs(120)
    // 回主页（钉住），再从「最近回答」回到最新一条
    socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
    await waitMs(80)
    socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 20, y: 22, hit: 'recent', sessionId: 'session-a' }, 3)))
    await waitMs(120)
    const lastReply = () => screenFramesOf(socket).filter((frame) => frame.payload.mode === 'reply').pop()
    const ids = (frame) => (frame.payload.actions || []).map((item) => item.id)
    assert.ok(lastReply() !== undefined, '点最近回答后应显示朗读屏')
    assert.equal(replyTextOf(lastReply()), '第三条回答。', '最近回答 = 最新一条')
    assert.deepEqual(ids(lastReply()), ['stop', 'replay', 'home', 'prev'], '最新一条只有「上一条」')
    // 翻页前记下音频数：翻页不得触发新的朗读
    let audioBaseline = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
    const homeAtBrowse = screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').length

    socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 120, y: 220, hit: 'action', actionId: 'prev' }, 4)))
    await waitMs(80)
    assert.equal(replyTextOf(lastReply()), '第二条回答。', '上一条回到第 2 条')
    assert.deepEqual(ids(lastReply()), ['stop', 'replay', 'home', 'prev', 'next'], '中间一条两个翻页按钮都在（加原三个共 5 个）')

    // 重读念「屏上正在看的那条」：翻过历史后重读不能跳回最新
    socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 160, y: 220, hit: 'action', actionId: 'replay' }, 45)))
    await waitMs(140)
    assert.equal(replyTextOf(lastReply()), '第二条回答。', '重读仍停在正在看的那条（不能跳回最新）')
    audioBaseline = framesOf(socket).filter((frame) => frame.type === 'tts.audio').length
    assert.ok(audioBaseline > 0, '重读要重新下发这一条的音频')

    socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 120, y: 220, hit: 'action', actionId: 'prev' }, 5)))
    await waitMs(80)
    assert.equal(replyTextOf(lastReply()), '第一条回答。', '再上一条回到第 1 条')
    assert.deepEqual(ids(lastReply()), ['stop', 'replay', 'home', 'next'], '最早一条只剩「下一条」，原三个按钮不被挤掉')

    // 下一条回到最新；最新再点下一条不动
    for (const seq of [6, 7, 8]) {
      socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 160, y: 220, hit: 'action', actionId: 'next' }, seq)))
      await waitMs(80)
    }
    assert.equal(replyTextOf(lastReply()), '第三条回答。', '翻到最新就停住')
    assert.equal(ids(lastReply()).includes('next'), false, '最新一条不该再有「下一条」')
    assert.equal(framesOf(socket).filter((frame) => frame.type === 'tts.audio').length, audioBaseline, '翻页只换屏，不自动朗读')
    // 一轮结束（turn/end）会排 10 秒回主页，但正在浏览时必须暂停
    emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    await waitMs(320)
    assert.equal(
      screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').length,
      homeAtBrowse,
      '浏览期间 10 秒自动回主页必须暂停（turn/end 也不能把屏切走）',
    )
    assert.equal(replyTextOf(lastReply()), '第三条回答。', '浏览期间屏仍停在回复上')
    // 显式点主页才回主页
    socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 9)))
    await waitMs(120)
    assert.equal(
      screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').length,
      homeAtBrowse + 1,
      '显式点主页才回主页',
    )
    runtime.dispose()
  } finally {
    delete process.env.TIHU_HOME_AFTER_MS
    delete process.env.TIHU_HOME_RECHECK_MS
  }
})

await testAsync('lane：每会话回复历史最多 8 条，翻到最早就停住', async () => {
  assert.equal(REPLY_HISTORY_LIMIT, 8, '历史上限是 8 条')
  const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
  const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'history-cap', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(40)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  for (let i = 1; i <= 10; i += 1) {
    onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '第' + i + '条回答。' }] } },
    })
    await waitMs(30)
  }
  await waitMs(180)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(80)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 20, y: 22, hit: 'recent', sessionId: 'session-a' }, 3)))
  await waitMs(100)
  const seen = []
  const recordLatest = () => {
    const frame = screenFramesOf(socket).filter((item) => item.payload.mode === 'reply').pop()
    const text = replyTextOf(frame)
    if (text !== '' && seen[seen.length - 1] !== text) seen.push(text)
  }
  recordLatest()
  for (let i = 0; i < 12; i += 1) {
    socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 120, y: 220, hit: 'action', actionId: 'prev' }, 10 + i)))
    await waitMs(40)
    recordLatest()
  }
  assert.equal(seen.length, 8, '每会话只留 8 条历史：' + JSON.stringify(seen))
  assert.deepEqual(
    seen,
    ['第10条回答。', '第9条回答。', '第8条回答。', '第7条回答。', '第6条回答。', '第5条回答。', '第4条回答。', '第3条回答。'],
    '超出的旧回复必须被挤掉：' + JSON.stringify(seen),
  )
  runtime.dispose()
})

/* ---------- 2026-11-08 实机缺陷：首页「最近回答」三级兜底 + 主页帧不能被重发路径丢掉 ---------- */

/** 带日志收口的 lane 运行时（核对 sendHome 打的 home recent 日志）。 */
function laneRuntime(records, logs) {
  const fixture = fakeCtx({
    sessionQuery: sessionQueryFixture(records),
    sessionProjectionCache: projectionCacheFixture(records),
  })
  const runtime = createTihuRuntime(fixture.ctx, {
    log: (line) => {
      if (logs !== undefined) logs.push(String(line))
    },
    tts: { disabled: true, instance: fakeTts() },
  })
  return { runtime, events: fixture.events }
}

await testAsync('lane：符号回复（只有 replyHistory、没有 lastReplies）仍要出「最近回答」行', async () => {
  const logs = []
  const { runtime, events } = laneRuntime([cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })], logs)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'symbol-reply', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(60)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '✅✅✅' }] } },
  })
  await waitMs(120)
  const frames = framesOf(socket)
  assert.equal(frames.filter((frame) => frame.type === 'tts.audio').length, 0, '没有可念的语音就不该下发音频')
  assert.ok(frames.some((frame) => String(frame.payload?.text ?? '').includes('本次无语音')), '仍要给无语音告警')
  const reply = screenFramesOf(socket).filter((frame) => frame.payload.mode === 'reply').pop()
  assert.ok(reply !== undefined, '符号回复也要上屏')
  assert.ok(replyTextOf(reply).includes('✅'), '屏上仍是这条正文：' + replyTextOf(reply))
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(160)
  const home = screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').pop()
  assert.ok(home.payload.home.recent !== undefined, 'lastReplies 查不到时要兜 replyHistory：' + JSON.stringify(home.payload.home))
  assert.equal(home.payload.home.recent.sessionId, 'session-a')
  assert.ok(String(home.payload.home.recent.title).includes('会话 A'), '行文字仍是「最近回答 · 会话名」：' + home.payload.home.recent.title)
  const logLine = logs.filter((line) => line.startsWith('tihu home recent')).pop()
  assert.ok(logLine !== undefined, 'sendHome 要留下可核对的日志：' + JSON.stringify(logs.slice(-3)))
  assert.ok(/hasLastReply=false/.test(logLine), '这一条走的是 replyHistory 兜底：' + logLine)
  assert.ok(/history=1/.test(logLine), '绑定会话的回答历史条数要能核对：' + logLine)
  runtime.dispose()
})

await testAsync('lane：整条 lane 都没有回复时不出现「最近回答」行', async () => {
  const { runtime } = laneRuntime([cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })])
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'no-reply', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(60)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(120)
  const home = screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').pop()
  assert.ok(home !== undefined, '点主页后要收到主页帧')
  assert.ok(home.payload.home.recent === undefined, 'lane 里没有任何回复时不该出这一行')
  runtime.dispose()
})

await testAsync('lane：自动跟随换过绑定后点主页，「最近回答」兜回朗读那条会话', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 3000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 2000, title: '会话 B' }),
  ]
  const { runtime, events } = laneRuntime(records)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'follow-rebind', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(60)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
  emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正在念的这条回答。' }] } } })
  await waitMs(140)
  emit('session-b', { type: 'turn/start', data: { turn: 1 } })
  await waitMs(200)
  const bound = framesOf(socket).filter((frame) => frame.type === 'session.bound').pop()
  assert.ok(bound !== undefined && bound.payload.sessionId === 'session-b', '设备应已自动跟随到正在跑的会话')
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(200)
  const recent = screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').pop().payload.home.recent
  assert.ok(recent !== undefined, '绑定会话没有回复时也要出「最近回答」')
  assert.equal(recent.sessionId, 'session-a', '要兜到 lane 里最近一条有回复的会话')
  assert.ok(String(recent.title).includes('会话 A'), '行文字仍是「最近回答 · 会话名」：' + recent.title)
  const mark = framesOf(socket).length
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 20, y: 22, hit: 'recent', sessionId: 'session-a' }, 3)))
  await waitMs(160)
  const replies = framesOf(socket).slice(mark).filter((frame) => frame.type === 'screen.frame' && frame.payload.mode === 'reply')
  assert.ok(replies.length > 0, '点这一行要回到那条回答的朗读屏')
  assert.ok(replyTextOf(replies[replies.length - 1]).includes('正在念的这条回答'), '要回到朗读那条：' + replyTextOf(replies[replies.length - 1]))
  runtime.dispose()
})

await testAsync('lane：钉住补发与气泡刷新后的主页帧仍带 home.recent', async () => {
  const records = [
    cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 3000, title: '会话 A' }),
    cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 2000, title: '会话 B' }),
  ]
  const { runtime, events } = laneRuntime(records)
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pinned-recent', protocol: '0', sessionId: 'session-a' }, 1)))
  await waitMs(60)
  const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
  const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
  emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '钉住期间也要带最近回答。' }] } } })
  await waitMs(120)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 280, y: 220, hit: 'action', actionId: 'home' }, 2)))
  await waitMs(120)
  const mark = framesOf(socket).length
  emit('session-a', { type: 'tool/call', data: { turn: 2, step: 1, name: 'read', arguments: { file_path: '/a/x.ts' } } })
  emit('session-b', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '会话 B 完成了。' }] } } })
  emit('session-b', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(240)
  const screens = framesOf(socket).slice(mark).filter((frame) => frame.type === 'screen.frame')
  assert.ok(screens.length > 0, '钉住期间仍要有补发的主页帧')
  for (const frame of screens) {
    assert.equal(frame.payload.mode, 'home', '钉住期间补发的只能是主页帧：' + JSON.stringify(frame.payload.mode))
    assert.ok(frame.payload.home?.recent !== undefined, '补发与气泡刷新的主页帧必须带最近回答：' + JSON.stringify(frame.payload.home))
    assert.equal(frame.payload.home.recent.sessionId, 'session-a', '最近回答仍是钉住前那条会话：' + JSON.stringify(frame.payload.home.recent))
  }
  runtime.dispose()
})

await testAsync('lane：空闲自动回主页后气泡刷新仍停在主页、仍带最近回答', async () => {
  process.env.TIHU_HOME_AFTER_MS = '80'
  process.env.TIHU_HOME_RECHECK_MS = '40'
  try {
    const records = [
      cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 3000, title: '会话 A' }),
      cuRecord('session-b', { live: true, cwd: '/b', lastPromptAt: 2000, title: '会话 B' }),
    ]
    const { runtime, events } = laneRuntime(records)
    const socket = openLane(runtime)
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'home-bubble', protocol: '0', sessionId: 'session-a' }, 1)))
    await waitMs(60)
    const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
    const emit = (id, event) => onSessionEvent({ id, header: { id } }, event)
    emit('session-a', { type: 'turn/start', data: { turn: 1 } })
    emit('session-a', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '自动回主页后气泡刷新也要带最近回答。' }] } } })
    emit('session-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await waitMs(600)
    const home1 = screenFramesOf(socket).filter((frame) => frame.payload.mode === 'home').pop()
    assert.ok(home1 !== undefined && home1.payload.home?.recent !== undefined, '自动回主页要带最近回答：' + JSON.stringify(home1?.payload.home))
    const mark = framesOf(socket).length
    emit('session-b', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '会话 B 完成。' }] } } })
    emit('session-b', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await waitMs(260)
    const screens = framesOf(socket).slice(mark).filter((frame) => frame.type === 'screen.frame')
    assert.ok(screens.length > 0, '气泡刷新要下发屏帧')
    for (const frame of screens) {
      assert.equal(frame.payload.mode, 'home', '气泡刷新不能把已回主页的屏拽回旧回复：' + JSON.stringify(frame.payload.mode))
      assert.ok(frame.payload.home?.recent !== undefined, '重发的主页帧仍要带最近回答：' + JSON.stringify(frame.payload.home))
      assert.equal(frame.payload.home.recent.sessionId, 'session-a')
    }
    runtime.dispose()
  } finally {
    delete process.env.TIHU_HOME_AFTER_MS
    delete process.env.TIHU_HOME_RECHECK_MS
  }
})


test('page：首页有「最近回答」行，动作条有上一条/下一条的小字号样式', () => {
  const { ctx } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {}, tts: { disabled: true } })
  const html = runtime.page()
  runtime.dispose()
  assert.ok(html.includes('homeRecent'), '首页要渲染最近回答行')
  assert.ok(html.includes('home-recent'), '最近回答行要有自己的样式')
  assert.ok(html.includes("hit: 'recent'"), '点最近回答行要上报 hit=recent')
  assert.ok(html.includes('上一条') && html.includes('下一条'), '翻页按钮文案要有上一条/下一条')
  assert.ok(html.includes('action-bar many'), '5 个按钮时用小字号、不换行')
})

/* ---------- 2026-11-08：状态屏第二行显示模型真实思考（不再老停在「模型推理中…」） ---------- */

test('进度屏：早思考只取第一句，替换占位符；同一句不重复出帧，超长按屏宽截断', () => {
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 1 } }, 1000)
  applySessionEvent(state, { type: 'step/start', data: { turn: 1, step: 1 } }, 1100)
  assert.equal(state.activity.length, 1, '刚进入第一步时只有一条占位')
  assert.ok(state.activity[0].detail.includes('模型推理中'), '还没有思考文本时才是占位符')

  const first = applyEarlyThinking(state, '先确认宿主有没有早期思考文本。再决定怎么接。', 1200)
  assert.ok(first?.screen, '有思考文本就要出帧')
  assert.ok(
    first.screen.bullets[0].startsWith('思考 · 先确认宿主有没有早期思考文本'),
    '第二行要换成第一句：' + first.screen.bullets[0],
  )
  assert.ok(!first.screen.bullets.some((line) => line.includes('模型推理中')), '占位符必须被替换')

  // 同一句（例如节流窗口重复 flush）不再出帧
  assert.equal(applyEarlyThinking(state, '先确认宿主有没有早期思考文本。再决定怎么接。', 1300), undefined)
  // 第一句还没写完（没有句末标点）时要跟着变长
  const grown = applyEarlyThinking(state, '先确认宿主有没有早期思考', 1400)
  assert.ok(grown?.screen.bullets[0].includes('早期思考'), '第一句没写完时跟着更新：' + grown?.screen.bullets[0])

  // 超长没有句末标点的思考：按 screen-spec 的 fitLine 量宽截断，不溢出 304px
  const long = applyEarlyThinking(state, '这是一段没有句号而且非常非常长的思考内容'.repeat(20), 1500)
  assert.ok(long?.screen, '长文本也要出帧')
  const line = long.screen.bullets[0]
  assert.ok(measureTextPx(line, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX, '思考行不得超宽：' + line)
  assert.ok(line.endsWith('…'), '超长要省略号收尾：' + line)
})

test('进度屏：真实宿主的 reasoning 块（type=reasoning/text）与 thinking 块同口径，stream 兜底也认', () => {
  const reasoningState = createProgressState(1000)
  applySessionEvent(reasoningState, { type: 'turn/start', data: { turn: 1 } }, 1000)
  applySessionEvent(reasoningState, {
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content: [{ type: 'reasoning', text: '先核对宿主事件形状。再改代码。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
    },
  }, 2000)
  const reasoningDetail = (reasoningState.activity.find((entry) => entry.label === '思考') || {}).detail ?? ''
  assert.ok(reasoningDetail.startsWith('先核对宿主事件形状'), 'reasoning 块要认（只有 reasoning+tool-call、没有 text 时也写进活动行）：' + reasoningDetail)

  const streamState = createProgressState(1000)
  applySessionEvent(streamState, { type: 'turn/start', data: { turn: 1 } }, 1000)
  const streamFrame = applySessionEvent(streamState, {
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text: '好。' }] },
      stream: [{ type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['流式兜底的第一句。后面。'] }],
    },
  }, 2000)
  assert.ok(streamFrame.screen.bullets[0].startsWith('思考 · 流式兜底的第一句'), 'reasoning-chunks 兜底要认：' + streamFrame.screen.bullets[0])
})

test('进度屏：assistant/message 的思考与早期流式同一句时不重复入栈', () => {
  const state = createProgressState(1000)
  applySessionEvent(state, { type: 'turn/start', data: { turn: 1 } }, 1000)
  applySessionEvent(state, { type: 'step/start', data: { turn: 1, step: 1 } }, 1100)
  applyEarlyThinking(state, '先看宿主有没有早期思考文本，再决定怎么接。后面还有很长的分析。', 1200)
  applySessionEvent(state, { type: 'tool/call', data: { turn: 1, step: 1, name: 'read', arguments: { file_path: 'a.ts' } } }, 1300)
  const frame = applySessionEvent(state, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '先看宿主有没有早期思考文本，再决定怎么接。后面还有很长的分析。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } },
  }, 1400).screen
  const thinkingCount = state.activity.filter((entry) => entry.label === '思考').length
  assert.equal(thinkingCount, 1, '同一句思考只留一条：' + JSON.stringify(state.activity))
  void frame
})

await testAsync('lane：agent/assistant-stream 的 reasoning-delta 一到，第二行就从占位符变成第一句', async () => {
  process.env.TIHU_THINKING_FLUSH_MS = '30'
  try {
    const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
    const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
    const socket = openLane(runtime)
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'think-stream', protocol: '0', sessionId: 'session-a' }, 1)))
    await waitMs(40)
    const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
    const onStream = events.find((entry) => entry.name === 'agent/assistant-stream')?.handler
    assert.ok(onStream, 'lane 必须订阅 agent/assistant-stream（模型早期思考）')
    const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)
    const stream = (frame) => onStream({ agent: { session: { id: 'session-a' } }, frame })
    emit({ type: 'turn/start', data: { turn: 2 } })
    emit({ type: 'step/start', data: { turn: 2, step: 1 } })
    await waitMs(40)
    const statusFrames = () => framesOf(socket)
      .filter((frame) => frame.type === 'screen.frame' && frame.payload.mode !== 'home' && frame.payload.mode !== 'reply')
      .map((frame) => frame.payload)
    assert.ok(
      statusFrames().some((payload) => (payload.bullets || []).some((line) => line.includes('模型推理中'))),
      '思考还没开始时先显示占位符',
    )

    const mark = framesOf(socket).length
    stream({ type: 'start', attemptId: 'a1', revision: 1, turn: 2, step: 1 })
    for (const text of ['先看宿主有没有早期思考文本', '，再决定怎么接', '。后面还有很长的分析。']) {
      stream({ type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text } })
    }
    await waitMs(140)
    const streamed = framesOf(socket).slice(mark)
      .filter((frame) => frame.type === 'screen.frame' && frame.payload.mode !== 'home' && frame.payload.mode !== 'reply')
      .map((frame) => frame.payload)
    assert.ok(streamed.length > 0, '流式思考要出屏帧（不用等该步 assistant/message）')
    const last = streamed[streamed.length - 1]
    assert.ok(
      (last.bullets || []).some((line) => line.startsWith('思考 · 先看宿主有没有早期思考文本')),
      '第二行是第一句：' + JSON.stringify(last.bullets),
    )
    assert.ok(!(last.bullets || []).some((line) => line.includes('模型推理中')), '占位符必须消失：' + JSON.stringify(last.bullets))

    // 该步 assistant/message（只有 reasoning + tool-call、没有 text）到达也不重复
    stream({ type: 'end', attemptId: 'a1', revision: 1, index: 3, outcome: { kind: 'abandoned' } })
    emit({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: '先看宿主有没有早期思考文本，再决定怎么接。后面还有很长的分析。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } },
    })
    emit({ type: 'step/start', data: { turn: 2, step: 2 } })
    await waitMs(60)
    const afterMessage = statusFrames().pop()
    const thinkingLines = (afterMessage.bullets || []).filter((line) => line.startsWith('思考'))
    assert.equal(thinkingLines.length, 1, '第二步的帧里只留一条思考：' + JSON.stringify(afterMessage.bullets))
    assert.ok(thinkingLines[0].includes('先看宿主有没有早期思考文本'), '思考内容仍是第一句：' + thinkingLines[0])
    runtime.dispose()
  } finally {
    delete process.env.TIHU_THINKING_FLUSH_MS
  }
})

await testAsync('lane：tool/call 到达时若该步已有思考，先替换占位符再出帧（不等节流）', async () => {
  process.env.TIHU_THINKING_FLUSH_MS = '5000'
  try {
    const records = [cuRecord('session-a', { live: true, cwd: '/a', lastPromptAt: 2000, title: '会话 A' })]
    const { runtime, events } = runtimeFor(records, {}, { instance: fakeTts() })
    const socket = openLane(runtime)
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'think-tool', protocol: '0', sessionId: 'session-a' }, 1)))
    await waitMs(40)
    const onSessionEvent = events.find((entry) => entry.name === 'session/event').handler
    const onStream = events.find((entry) => entry.name === 'agent/assistant-stream')?.handler
    const emit = (event) => onSessionEvent({ id: 'session-a', header: { id: 'session-a' } }, event)
    const stream = (frame) => onStream({ agent: { session: { id: 'session-a' } }, frame })
    emit({ type: 'turn/start', data: { turn: 3 } })
    emit({ type: 'step/start', data: { turn: 3, step: 1 } })
    stream({ type: 'start', attemptId: 'a2', revision: 2, turn: 3, step: 1 })
    stream({ type: 'chunk', attemptId: 'a2', revision: 2, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先确认口径，再动手。后面另说。' } })
    await waitMs(20) // 节流 5000ms 还没到
    emit({ type: 'tool/call', data: { turn: 3, step: 1, name: 'read', arguments: { file_path: '/a/x.ts' } } })
    await waitMs(60)
    const last = framesOf(socket).filter((frame) => frame.type === 'screen.frame').pop().payload
    assert.ok(!(last.bullets || []).some((line) => line.includes('模型推理中')), '工具帧不得再带占位符：' + JSON.stringify(last.bullets))
    assert.ok((last.bullets || []).some((line) => line.startsWith('思考 · 先确认口径')), '工具帧要先带第一句：' + JSON.stringify(last.bullets))
    runtime.dispose()
  } finally {
    delete process.env.TIHU_THINKING_FLUSH_MS
  }
})

/* ---------- 汇总 ---------- */
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failed}`)
if (failed > 0) process.exit(1)
process.exit(0)
