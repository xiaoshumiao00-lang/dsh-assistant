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
 *   - 两道闸：写前快照落在 .tihu/snapshots、审计是 JSONL；危险动作的授权只在电脑端（设备屏永不显示）；
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
  diffSummary,
  isReadOnlyCommand,
  readAudit,
  takeSnapshot,
  targetPathOf,
} from '../src/tihu/guard.ts'
import { createTihuRuntime, buildTihuUserMessage, REPLY_HISTORY_LIMIT, TIHU_LANE_PATH, TIHU_PAGE_PATH } from '../src/tihu/lane.ts'
import { BOARD_PAGE_SIZE } from '../src/tihu/task-ledger.ts'
import { TIHU_CONTROL_SECTION_TEXT, createTihuControlRunner, matchSessionRows, tihuActionNames } from '../src/tihu/control.ts'
import {
  activityEntryOf,
  applyEarlyThinking,
  applySessionEvent,
  clipText,
  createProgressState,
  decodeRateOf,
  pushDecodeSample,
  SPEED_WINDOW_MS,
  describeTool,
  formatElapsed,
  sanitizeScreenLine,
  summarizeToolResult,
} from '../src/tihu/progress.ts'
import { ACTUAL_SIZE_SCALE, CONTENT_WIDTH_PX, DONE_LAYOUT, PENDING_RAIL_WIDTH_PX, REPLY_LAYOUT, SCREEN_BORDER_PX, SCREEN_SPEC, TEXT_WRAP_SAFETY_PX, TITLE_BOLD_FACTOR, clipScreenTitle, fitLine, fitScreenLines, measureTextPx, wrapTextPx } from '../src/tihu/screen-spec.ts'
import { fitViewport, replyViewport, replyVisibleWindow, replyWindow, splitReplySentences, splitSpeechSegments, wrapReplyLines } from '../src/tihu/reply.ts'
import { stripToolNoise, toSpeechText } from '../src/tihu/speech-text.ts'
import { groupProjects, humanTitle, projectNameOf } from '../src/tihu/project-groups.ts'
import { Pcm16Chunker, TTS_CHUNK_BYTES, TTS_SAMPLE_RATE, validateReferenceWav } from '../src/tihu/audio.ts'
import {
  KOKORO_ZH_VOICES,
  kokoroModelPath,
  kokoroScriptPath,
  kokoroSid,
  kokoroVoiceName,
  isKokoroVoice,
  localFirstChunkMs,
  normalizeVoiceName,
  offlineFlagReason,
  probeEdgeReachable,
  repoModelDirs,
  resetEdgeProbeCache,
  ttsEngine,
} from '../src/tihu/tts.ts'
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

/** 800ms 非静音 PCM：语音事务测试不会依赖本机 ASR 或真实音频文件。 */
function voicedWavBase64() {
  const samples = 12800
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
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(i % 20 < 10 ? 5000 : -5000, 44 + i * 2)
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
  assert.deepEqual([...TIHU_UPSTREAM_TYPES], ['hello', 'audio.frame', 'text.input', 'session.end', 'screen.gesture', 'voice.list', 'voice.create', 'voice.select', 'tts.sample', 'task.reply', 'ping'])
  // 2026-11-09 统一指挥会话：下行 +3（task.list / task.update / task.notify），协议版本仍是 '0'。
  assert.equal(TIHU_DOWNSTREAM_TYPES.length, 12, '旧界面消息（tts.text/event.done/confirm.ask/sessions.list/session.invalid）已随界面删除')
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('tts.audio'))
  assert.equal(TIHU_DOWNSTREAM_TYPES.includes('sessions.list'), false)
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('session.bound'))
  assert.equal(TIHU_DOWNSTREAM_TYPES.includes('session.invalid'), false)
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('voice.list'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('voice.created'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('task.list'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('task.update'))
  assert.ok(TIHU_DOWNSTREAM_TYPES.includes('task.notify'))
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

test('text.input 的必填字段', () => {
  const text = buildUpstream('text.input', { text: '读一下 README', source: 'keyboard' }, 6)
  assert.ok(parseUpstream(JSON.stringify(text)) !== null)
  assert.equal(parseUpstream(JSON.stringify({ ...text, payload: { source: 'keyboard' } })), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('confirm.reply', { confirmId: 'x', approved: true }, 7))), null, '旧确认回执已删除')
})

test('信封校验：v/type/id/seq/ts/payload 缺一不可', () => {
  assert.equal(isTihuEnvelope({ v: '0', type: 'ping', id: 'x', seq: 1, ts: 2, payload: {} }), true)
  assert.equal(isTihuEnvelope({ v: '0', type: 'ping', id: 'x', seq: 1, ts: 2 }), false)
  assert.equal(isTihuEnvelope({ v: '1', type: 'ping', id: 'x', seq: 1, ts: 2, payload: {} }), false)
})

test('下行构造：seq 单调、ts 是数字、类型在清单里', () => {
  const first = buildDownstream('screen.frame', { stage: '聆听', title: 't', bullets: [] }, 1)
  const second = buildDownstream('event.progress', { stage: 'x', text: 'y' }, 2)
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
      if (id === 'speechController') return overrides.speechController ?? { transcribe: async () => '读一下 README' }
      if (id === 'sessions') return overrides.sessions
      if (id === 'remote') return overrides.remote
      if (id === 'sessionController') return overrides.sessionController
      if (id === 'workspaces') return overrides.workspaces
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

await testAsync('页面 HTML 包含 lane 地址与屏幕区（新七屏）', async () => {
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
  assert.ok(html.includes('audio.frame'))
  for (const legacy of ['sessions.query', 'session.bind', '最近回答', 'home-recent', 'pending-rail', 'reply-body', 'askTitle']) {
    assert.equal(html.includes(legacy), false, '旧界面残留：' + legacy)
  }
  assert.ok(html.includes('homeBody'), '任务棋盘容器还在')
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

  /* 2026-11-06 回归：speech.transcribe() 返回的是 Transcript 对象，不是字符串。
     旧实现 String(result) → 注入 "[object Object]"（实测 chars=15）。 */
}

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





/* ---------- 2026-11-07 回归：朗读没结束就跳控制室主页，随后又被残留屏帧切回 reply ----------
 *
 * 机制：正文 assistant/message 一到就开朗读，turn/end 紧接着结束（真实宿主就是这样），
 * 旧 scheduleHome 只看 runningSessions 空不空——turn 已停、但音频还在播/队列还没播完，
 * TIHU_HOME_AFTER_MS 一到就发 home 帧；之后 speakLocally 里按播放时刻排的 reply 屏帧
 * 陆续到期，把模式切回 reply（用户看到的「先跳主页、过一会又自己跳回来继续读」）。
 */



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

  // 可视窗口：7 行、当前句居中、每行不超宽
  const viewport = replyViewport(sentences, middle)
  assert.ok(viewport.lines.length <= 7)
  for (const line of viewport.lines) assert.ok(measureTextPx(line.text, SCREEN_SPEC.bodyFontPx) <= CONTENT_WIDTH_PX, `行超宽：${line.text}`)
  assert.ok(viewport.currentLine >= 3 && viewport.currentLine <= 6, `当前句应在中部，实际第 ${viewport.currentLine} 行`)
  assert.ok(viewport.lines[viewport.currentLine].sentenceIndex === middle)

  // 行拼起来不丢字（窗口内）
  const wrapped = wrapReplyLines(replyWindow(sentences, middle), 18)
  assert.equal(wrapped.map((line) => line.text).join(''), replyWindow(sentences, middle).map((s) => s.text.replace(/\s+/g, ' ').trim()).join(''))

  // 空文本
  assert.deepEqual(splitReplySentences(''), [])
  assert.deepEqual(fitViewport([], 0).lines, [])
  assert.equal(SCREEN_SPEC.replyVisibleLines, REPLY_LAYOUT.visibleLines)
})

/* ---------- 回答屏版式：气泡不压文字、末行留一整行安全高度（2026-11-08 第二轮） ---------- */

test('回答屏版式定量：正文 7 行、末行下 30px（含一整行 20px 安全行），304/240 都摆得下', () => {
  // 224 内容高 = 顶行 14 + 2×4 间隙 + 正文 170 + 按钮行 32
  assert.equal(REPLY_LAYOUT.contentHeightPx, 224)
  assert.equal(REPLY_LAYOUT.stageHeightPx, 14)
  assert.equal(REPLY_LAYOUT.actionBarHeightPx, 32)
  assert.equal(REPLY_LAYOUT.columnGapPx, 4)
  assert.equal(REPLY_LAYOUT.bodyHeightPx, 170)
  assert.equal(REPLY_LAYOUT.bodyHeightPx, 224 - 14 - 32 - 4 * 2)
  assert.equal(REPLY_LAYOUT.visibleLines, SCREEN_SPEC.replyVisibleLines)
  assert.equal(REPLY_LAYOUT.visibleLines, 7, '每屏 7 行')
  assert.equal(REPLY_LAYOUT.usedHeightPx, 140)
  assert.equal(REPLY_LAYOUT.bottomFreePx, 30, '末行下方 30px')
  assert.ok(REPLY_LAYOUT.bottomFreePx >= REPLY_LAYOUT.safeLinePx, '末行下至少要留一整行 20px 安全高度')
  // 页面 #screen 还有 1px 边框：实际内容 222、正文 168，7 行 140 仍留 28 ≥ 20。
  const actualBody = REPLY_LAYOUT.bodyHeightPx - SCREEN_BORDER_PX * 2
  assert.equal(actualBody, 168)
  assert.ok(actualBody - REPLY_LAYOUT.usedHeightPx >= REPLY_LAYOUT.safeLinePx, '带边框时末行下仍有 ≥20px')
  // 240 宽有轨：正文 240 + 气泡轨 64 = 304 ≤ 内容宽，横向不压字
  assert.equal(REPLY_LAYOUT.railBodyWidthPx, 240)
  assert.equal(REPLY_LAYOUT.railWidthPx, 64)
  assert.ok(REPLY_LAYOUT.railBodyWidthPx + REPLY_LAYOUT.railWidthPx <= REPLY_LAYOUT.plainBodyWidthPx)

  // 304（无轨）与 240（有轨）两种宽度：折行不超安全宽、窗口正好 7 行、高度预算不越界
  const longText = '这是一段用来验证回答屏版式定量的长文本，包含中文、English 和数字 2026。'.repeat(8)
  for (const widthPx of [REPLY_LAYOUT.plainBodyWidthPx, REPLY_LAYOUT.railBodyWidthPx]) {
    const wrapped = wrapTextPx(longText, widthPx, SCREEN_SPEC.bodyFontPx)
    assert.ok(wrapped.length > REPLY_LAYOUT.visibleLines, `${widthPx}px 折出的行数要多于可视行`)
    for (const line of wrapped) {
      assert.ok(measureTextPx(line, SCREEN_SPEC.bodyFontPx) <= widthPx - TEXT_WRAP_SAFETY_PX, `${widthPx}px 行超安全宽：${line}`)
    }
    const win = replyVisibleWindow(wrapped.map((text) => ({ text, sentenceIndex: 0 })), 0, { widthPx })
    assert.equal(win.lines.length, 7, `${widthPx}px 每屏 7 行`)
    assert.ok(win.lines.length * REPLY_LAYOUT.lineHeightPx + REPLY_LAYOUT.safeLinePx <= REPLY_LAYOUT.bodyHeightPx, `${widthPx}px 高度没给安全行留够`)
    assert.equal(win.offset, 0)
    assert.equal(win.maxOffset, wrapped.length - 7)
  }

  // 装不下的最后一行（例如旧帧按 304 折好、突然切到 240 有轨）：末尾省略号收住，不溢出
  const wideLines = wrapTextPx('一'.repeat(34), REPLY_LAYOUT.plainBodyWidthPx, SCREEN_SPEC.bodyFontPx)
  const cut = replyVisibleWindow(wideLines.map((text) => ({ text, sentenceIndex: 0 })), 0, { widthPx: REPLY_LAYOUT.railBodyWidthPx })
  assert.equal(cut.truncated, true, '超宽最后一行要被收住')
  assert.ok(cut.lines[cut.lines.length - 1].text.endsWith('…'), '末尾必须是省略号')
  assert.ok(measureTextPx(cut.lines[cut.lines.length - 1].text, SCREEN_SPEC.bodyFontPx) <= REPLY_LAYOUT.railBodyWidthPx, '省略后不得超宽')
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

test('语音切段：长句按逗号/80 字切分，首段 ≤20 字（先开口）', () => {
  const text = '这是一个用于测试语音切段的长句子，' + '它需要在逗号处断开，'.repeat(12) + '最后结束。'
  const sentences = splitReplySentences(text)
  const segments = splitSpeechSegments(text)
  assert.ok(segments.length > sentences.length)
  assert.equal(segments[0].start, 0)
  for (let i = 1; i < segments.length; i += 1) assert.ok(segments[i].start >= segments[i - 1].end)
  assert.ok([...segments[0].text].length <= 20, `首段必须 ≤20 字（首包），实际 ${[...segments[0].text].length}：${segments[0].text}`)
  for (const segment of segments) {
    assert.ok([...segment.text].length <= 80, `片段超长：${segment.text}`)
    assert.equal([...text].slice(segment.start, segment.end).join('').trim(), segment.text)
    assert.ok(segment.sentenceIndex >= 0 && segment.sentenceIndex < sentences.length)
    assert.ok(segment.start >= sentences[segment.sentenceIndex].start && segment.end <= sentences[segment.sentenceIndex].end)
  }
})

/* ---------- Kokoro 主引擎（2026-11-08 用户拍板） ---------- */

/** 临时改环境变量跑一段断言，结束后原样恢复。 */
function withEnv(vars, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('引擎默认值：edge 主引擎、Kokoro 只在手动/离线兜底、qwen 只有显式设置才启用', () => {
  withEnv({ TIHU_TTS_ENGINE: undefined }, () => assert.equal(ttsEngine(), 'edge', '默认必须是 edge'))
  withEnv({ TIHU_TTS_ENGINE: '' }, () => assert.equal(ttsEngine(), 'edge'))
  withEnv({ TIHU_TTS_ENGINE: 'edge' }, () => assert.equal(ttsEngine(), 'edge'))
  withEnv({ TIHU_TTS_ENGINE: 'qwen' }, () => assert.equal(ttsEngine(), 'qwen', '显式 qwen 才启用旧 sidecar'))
  withEnv({ TIHU_TTS_ENGINE: 'qwen-cuda' }, () => assert.equal(ttsEngine(), 'qwen', '旧值兼容成 qwen'))
  withEnv({ TIHU_TTS_ENGINE: 'kokoro' }, () => assert.equal(ttsEngine(), 'kokoro', '显式 kokoro 是手动切/离线兜底'))
  withEnv({ TIHU_TTS_ENGINE: 'nonsense' }, () => assert.equal(ttsEngine(), 'edge', '不认得的取值回落 edge'))
})

await testAsync('离线判定：只看明确依据（仅离线 / 宿主离线 / 网络探测 / edge 请求失败），不猜', async () => {
  withEnv({ TIHU_OFFLINE_ONLY: undefined, TIHU_HOST_OFFLINE: undefined }, () => {
    assert.equal(offlineFlagReason(), '', '没有开关时不算离线')
    assert.equal(offlineFlagReason(false), '')
  })
  assert.ok(offlineFlagReason(true).includes('仅离线'), '设备「仅离线」开关是明确依据')
  withEnv({ TIHU_OFFLINE_ONLY: '1' }, () => assert.ok(offlineFlagReason().includes('TIHU_OFFLINE_ONLY')))
  withEnv({ TIHU_HOST_OFFLINE: '1' }, () => assert.ok(offlineFlagReason().includes('TIHU_HOST_OFFLINE')))
  // 网络探测：指向一个必然连不上的本地端口 → 探测结果必须是 false（不是猜，是实测）。
  process.env.TIHU_EDGE_PROBE_URL = 'http://127.0.0.1:9/'
  resetEdgeProbeCache()
  try {
    assert.equal(await probeEdgeReachable(), false, '连不上探测目标必须判为离线')
  } finally {
    delete process.env.TIHU_EDGE_PROBE_URL
    resetEdgeProbeCache()
  }
})

test('本地首块门限：TIHU_LOCAL_FIRST_MS 默认 4000，夹在 1–60s', () => {
  withEnv({ TIHU_LOCAL_FIRST_MS: undefined }, () => assert.equal(localFirstChunkMs(), 4000, '默认 4000ms（兜底路径给足余量）'))
  withEnv({ TIHU_LOCAL_FIRST_MS: '1200' }, () => assert.equal(localFirstChunkMs(), 1200))
  withEnv({ TIHU_LOCAL_FIRST_MS: '0' }, () => assert.equal(localFirstChunkMs(), 1000, '下限 1000ms'))
  withEnv({ TIHU_LOCAL_FIRST_MS: '999999' }, () => assert.equal(localFirstChunkMs(), 60000, '上限 60000ms'))
  withEnv({ TIHU_LOCAL_FIRST_MS: 'abc' }, () => assert.equal(localFirstChunkMs(), 4000, '非数字回落默认'))
})

test('Kokoro 不默认自启：edge 主用时 backend=none、ensureServer 不 spawn、手切才走 Kokoro', async () => {
  const ttsModule = await import('../src/tihu/tts.ts')
  const saved = { engine: process.env.TIHU_TTS_ENGINE, offline: process.env.TIHU_OFFLINE_ONLY, host: process.env.TIHU_HOST_OFFLINE }
  delete process.env.TIHU_TTS_ENGINE
  delete process.env.TIHU_OFFLINE_ONLY
  delete process.env.TIHU_HOST_OFFLINE
  try {
    const instance = new ttsModule.TihuTts({ log: () => {}, threads: 1 })
    instance.edgeReady = () => true
    assert.equal(instance.backend(), 'none', 'edge 主用没有常驻 sidecar')
    assert.equal(instance.localPrimary(), false, 'edge 主用不按本地单路串行（最多 3 路）')
    assert.equal(instance.status().model, 'edge-tts 云健(Yunjian)')
    assert.equal(instance.engineFor(), 'edge')
    assert.equal(instance.engineFor('zf_060'), 'kokoro', '屏上手选 Kokoro 音色 = 手动切 Kokoro')
    assert.equal(instance.engineFor('default', true), 'kokoro', '仅离线开关 = 离线兜底')
    assert.equal(isKokoroVoice('zf_060'), true)
    assert.equal(isKokoroVoice('sid35'), true)
    assert.equal(isKokoroVoice('default'), false)
    assert.equal(isKokoroVoice('my_voice'), false)
    await instance.ensureServer()
    assert.equal(instance.child, null, 'edge 主用时 ensureServer 不许 spawn Kokoro sidecar')
    instance.dispose()
  } finally {
    if (saved.engine === undefined) delete process.env.TIHU_TTS_ENGINE
    else process.env.TIHU_TTS_ENGINE = saved.engine
    if (saved.offline === undefined) delete process.env.TIHU_OFFLINE_ONLY
    else process.env.TIHU_OFFLINE_ONLY = saved.offline
    if (saved.host === undefined) delete process.env.TIHU_HOST_OFFLINE
    else process.env.TIHU_HOST_OFFLINE = saved.host
  }
})

await testAsync('引擎链：edge 主用成功不碰 Kokoro；edge 失败 / 仅离线 / 手切才启用 Kokoro', async () => {
  const ttsModule = await import('../src/tihu/tts.ts')
  const result = { sampleRate: 24000, firstChunkMs: 10, audioMs: 100, totalMs: 20, chunks: 1 }
  const make = (logs = []) => {
    const instance = new ttsModule.TihuTts({ log: (line) => logs.push(line), threads: 1 })
    instance.edgeReady = () => true
    instance.kokoroReady = () => true
    instance.edgeNetworkReachable = async () => true
    instance.ensureKokoroServer = async () => {}
    return instance
  }
  const chunk = (options) => options.onChunk({ data: Buffer.alloc(4800), seq: 0, total: 0, final: false })

  // ① 默认 edge：成功就返回，绝不碰 Kokoro
  const ok = make()
  let okEdge = 0
  let okKokoro = 0
  ok.synthesizeEdge = async (_text, options) => { okEdge += 1; chunk(options); return result }
  ok.synthesizeKokoro = async (_text, options) => { okKokoro += 1; chunk(options); return result }
  await ok.synthesize('第一句。', { onChunk: () => {} })
  assert.equal(okEdge, 1, '默认必须走 edge')
  assert.equal(okKokoro, 0, 'edge 成功时不许启用 Kokoro')
  assert.equal(ok.activeEngine(), 'edge')
  ok.dispose()

  // ② edge 请求失败（网络可达）= edge 不可用 → 启用 Kokoro 兜底
  const logs = []
  const bad = make(logs)
  let badKokoro = 0
  bad.synthesizeEdge = async () => { throw new Error('edge-tts 失败（exit 1）：403') }
  bad.synthesizeKokoro = async (_text, options) => { badKokoro += 1; chunk(options); return result }
  await bad.synthesize('第一句。', { onChunk: () => {} })
  assert.equal(badKokoro, 1, 'edge 请求失败必须落 Kokoro 兜底')
  assert.equal(bad.activeEngine(), 'kokoro')
  assert.ok(logs.some((line) => line.includes('offline fallback')), '兜底要留下明确依据日志：' + logs.join(' | '))
  bad.dispose()

  // ③ 探测不到网络（edge 失败 + 探测 false）→ 兜底，且日志写明网络探测
  const netLogs = []
  const net = make(netLogs)
  net.edgeNetworkReachable = async () => false
  let netKokoro = 0
  net.synthesizeEdge = async () => { throw new Error('fetch failed') }
  net.synthesizeKokoro = async (_text, options) => { netKokoro += 1; chunk(options); return result }
  await net.synthesize('第一句。', { onChunk: () => {} })
  assert.equal(netKokoro, 1)
  assert.ok(netLogs.some((line) => line.includes('网络探测失败')), '离线依据要说清是网络探测失败：' + netLogs.join(' | '))
  net.dispose()

  // ④ 仅离线：一次 edge 请求都不发，直接 Kokoro
  const offline = make()
  let offlineEdge = 0
  let offlineKokoro = 0
  offline.synthesizeEdge = async () => { offlineEdge += 1; return result }
  offline.synthesizeKokoro = async (_text, options) => { offlineKokoro += 1; chunk(options); return result }
  await offline.synthesize('第一句。', { offlineOnly: true, onChunk: () => {} })
  assert.equal(offlineEdge, 0, '仅离线时不许发 edge 请求')
  assert.equal(offlineKokoro, 1)
  offline.dispose()

  // ⑤ 手切 Kokoro 音色：先走 Kokoro
  const manual = make()
  let manualEdge = 0
  let manualKokoro = 0
  manual.synthesizeEdge = async () => { manualEdge += 1; return result }
  manual.synthesizeKokoro = async (_text, options) => { manualKokoro += 1; chunk(options); return result }
  await manual.synthesize('第一句。', { voice: 'zf_001', onChunk: () => {} })
  assert.equal(manualKokoro, 1, '手切 Kokoro 音色必须先走 Kokoro')
  assert.equal(manualEdge, 0)
  manual.dispose()
})

test('Kokoro 模型路径：仓库内 fp32 model.onnx，绝不指向 int8', () => {
  withEnv({ TIHU_KOKORO_MODEL_DIR: undefined, TIHU_KOKORO_MODEL: undefined }, () => {
    const modelPath = kokoroModelPath()
    assert.ok(modelPath.endsWith('model.onnx'), `模型文件必须是 model.onnx，实际 ${modelPath}`)
    assert.equal(/int8/i.test(modelPath), false, `不能指向 int8：${modelPath}`)
    assert.ok(repoModelDirs()[0].includes(join('models', 'kokoro', 'kokoro-multi-lang-v1_1')), '仓库内 models 路径必须排第一')
    assert.ok(kokoroScriptPath().endsWith(join('scripts', 'tihu-kokoro-tts-server.py')), '驱动脚本必须在仓库 scripts/ 下')
  })
})

test('Kokoro 中文音色：女声 sid 3–57、男声 58–102，默认 sid 35 = zf_060', () => {
  assert.equal(KOKORO_ZH_VOICES.length, 100, '中文音色 100 个（55 女 + 45 男）')
  assert.deepEqual(KOKORO_ZH_VOICES[0], { sid: 3, name: 'zf_001', gender: 'f' })
  assert.deepEqual(KOKORO_ZH_VOICES[KOKORO_ZH_VOICES.length - 1], { sid: 102, name: 'zm_100', gender: 'm' })
  assert.equal(KOKORO_ZH_VOICES.filter((voice) => voice.gender === 'f').length, 55)
  assert.equal(KOKORO_ZH_VOICES.filter((voice) => voice.gender === 'm').length, 45)
  withEnv({ TIHU_KOKORO_SID: undefined }, () => {
    assert.equal(kokoroSid(), 35, '默认 sid 35')
    assert.equal(kokoroVoiceName(35), 'zf_060')
  })
  assert.equal(kokoroSid('zf_001'), 3, '音色名 → sid')
  assert.equal(kokoroSid('zm_100'), 102)
  assert.equal(kokoroSid('58'), 58)
  assert.equal(kokoroSid('sid70'), 70)
  withEnv({ TIHU_KOKORO_SID: '58' }, () => assert.equal(kokoroSid('default'), 58, 'TIHU_KOKORO_SID 生效'))
})

test('Kokoro 驱动脚本接上了 num-threads 与 number/date/phone 词典规则', () => {
  const script = readFileSync(new URL('./tihu-kokoro-tts-server.py', import.meta.url), 'utf8')
  for (const token of ['--num-threads', '--rule-fsts', 'number-zh.fst', 'date-zh.fst', 'phone-zh.fst', '--model-dir', '--lexicon', '--data-dir']) {
    assert.ok(script.includes(token), `驱动脚本缺少 ${token}`)
  }
  assert.ok(script.includes('int8'), '脚本要显式拒绝 int8 权重')
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
  // 本机装了 Kokoro 模型时 backend() 会是 kokoro；这条用例只测 edge 重试语义，固定按无本地引擎跑。
  instance.backend = () => 'none'
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
  // 这条用例只测「edge 失败后不再重试」，把离线兜底与网络探测钉成确定性空实现，
  // 免得在单测里真的去 spawn Kokoro / 探测公网（兜底行为由上面的引擎链用例覆盖）。
  strict.kokoroReady = () => false
  strict.edgeNetworkReachable = async () => true
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
  // 默认音色 + CPU + edge 失败：立刻给出明确原因，不进 4.5s/45s 的本地等待，更不能静默返回 0 字节。
  // 2026-11-08 起 Qwen 只有显式 TIHU_TTS_ENGINE=qwen 才启用，这条用例显式开 qwen 才能测到该路径。
  const instance = new ttsModule.TihuTts({ log: () => {}, threads: 1 })
  let codecCalls = 0
  instance.edgeReady = () => true
  instance.backend = () => 'cpu'
  instance.ensureServer = async () => {}
  instance.synthesizeEdge = async () => { throw new Error('edge-tts 没有返回音频：') }
  instance.synthesizeCodec = async () => { codecCalls += 1; throw new Error('不该走到本地兜底') }
  process.env.TIHU_TTS_ENGINE = 'qwen'
  try {
    await assert.rejects(
      instance.synthesize('第一句。', { onChunk: () => {} }),
      /CPU/,
      'CPU 兜底被禁用时要抛出带 CPU 原因的错，不能静默返回空音频',
    )
  } finally {
    delete process.env.TIHU_TTS_ENGINE
  }
  assert.equal(codecCalls, 0, `CPU 兜底禁用时不许再发一次 54s 的请求，实际发了 ${codecCalls} 次`)
  instance.dispose()
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

/* ---------- 2026-11-08：鹈鹕设备控制工具 tihu（control.ts + lane control 面） ---------- */

console.log('[tihu] 控制工具')

test('控制工具：action 全集固定，未知 action 报错列出全部合法值', () => {
  assert.deepEqual(tihuActionNames(), ['status', 'list_devices', 'bind', 'open_bubble', 'progress', 'list_sessions', 'archive', 'stop_speaking', 'replay', 'go_home', 'browse', 'open_recent', 'dispatch', 'list_tasks', 'cancel'])
})

test('控制工具：提示段落 ≤120 字，含「口头确认」红线', () => {
  assert.ok(TIHU_CONTROL_SECTION_TEXT.length <= 120, `提示段落 ${TIHU_CONTROL_SECTION_TEXT.length} 字，超 120：` + TIHU_CONTROL_SECTION_TEXT)
  assert.ok(TIHU_CONTROL_SECTION_TEXT.includes('口头确认'))
  assert.ok(TIHU_CONTROL_SECTION_TEXT.includes('confirm=true'))
})

test('控制工具：标题模糊匹配 精确/前缀/包含/多候选/无结果', () => {
  const rows = [
    { sessionId: 'session-98bb83cb-aaaa-1111', title: '鹈鹕语音调试', preset: 'computer-use', live: true, updatedAt: 100 },
    { sessionId: 'session-11cc22dd-bbbb-2222', title: '鹈鹕实验记录', preset: 'standard', live: false, updatedAt: 200 },
    { sessionId: 'session-7f33e944-cccc-3333', title: '桥梁温度场论文', preset: 'standard', live: true, updatedAt: 300 },
  ]
  const byShortId = matchSessionRows(rows, '98bb83cb')
  assert.equal(byShortId.kind, 'one')
  assert.equal(byShortId.row.title, '鹈鹕语音调试')
  const byFullTitle = matchSessionRows(rows, '桥梁温度场论文')
  assert.equal(byFullTitle.kind, 'one')
  assert.equal(byFullTitle.row.sessionId, 'session-7f33e944-cccc-3333')
  const prefixMany = matchSessionRows(rows, '鹈鹕')
  assert.equal(prefixMany.kind, 'many')
  assert.equal(prefixMany.rows.length, 2)
  const containsOne = matchSessionRows(rows, '实验')
  assert.equal(containsOne.kind, 'one')
  assert.equal(containsOne.row.title, '鹈鹕实验记录')
  assert.equal(matchSessionRows(rows, '完全不存在的词').kind, 'none')
  const all = matchSessionRows(rows, '')
  assert.equal(all.kind, 'all')
  assert.equal(all.rows.length, 3)
})

/** 假控制面：记录调用，供 execute 级用例注入。 */
function controlSurfaceFixture(options = {}) {
  const calls = []
  const archived = []
  const devices = options.devices ?? [{ id: 'dev-1', sessionId: 'session-98bb83cb-aaaa-1111', autoFollow: false, voice: 'default', edgeVoice: 'zh-CN-YunjianNeural', offlineOnly: false }]
  const rows = options.rows ?? [
    { sessionId: 'session-98bb83cb-aaaa-1111', title: '鹈鹕语音调试', preset: 'computer-use', live: true, updatedAt: 100 },
    { sessionId: 'session-11cc22dd-bbbb-2222', title: '鹈鹕实验记录', preset: 'standard', live: false, updatedAt: 200 },
  ]
  return {
    calls,
    archived,
    surface: {
      listDevices: () => devices.map((device) => ({ ...device })),
      deviceOfSession: (sessionId) => {
        const hit = devices.find((device) => device.sessionId === sessionId)
        return hit === undefined ? undefined : { ...hit }
      },
      deviceStatus: (deviceId) => {
        const hit = devices.find((device) => device.id === deviceId || device.clientId === deviceId)
        if (hit === undefined) return undefined
        return {
          device: { ...hit },
          display: hit.sessionId ?? '__unbound__',
          speaking: false,
          pinned: false,
          pending: options.pending ?? [],
          ...(options.screen === undefined ? {} : { screen: options.screen }),
        }
      },
      listSessions: async (fragment) => matchSessionRows(rows, fragment),
      bind: async (deviceId, sessionId) => { calls.push(['bind', deviceId, sessionId]); return `已绑定 ${sessionId}` },
      openBubble: async (deviceId, pick) => { calls.push(['openBubble', deviceId, JSON.stringify(pick)]); return '已点开气泡' },
      progress: async (sessionId) => { calls.push(['progress', sessionId]); return { sessionId, title: '进度标题', running: true, speaking: false } },
      archiveSession: async (sessionId) => { calls.push(['archive', sessionId]); archived.push(sessionId); return `已删除（归档）会话「${sessionId}」` },
      stopSpeaking: async (deviceId) => { calls.push(['stopSpeaking', deviceId]); return '已停止朗读' },
      replay: async (deviceId) => { calls.push(['replay', deviceId]); return '正在重读当前回答' },
      goHome: async (deviceId) => { calls.push(['goHome', deviceId]); return '已回主页并钉住' },
      browse: async (deviceId, direction) => { calls.push(['browse', deviceId, direction]); return `已翻到${direction === 'prev' ? '上' : '下'}一条` },
      openRecent: async (deviceId) => { calls.push(['openRecent', deviceId]); return '已打开最近回答' },
    },
  }
}

await testAsync('控制工具：未知 action 报错信息完整（列出全部合法 action）', async () => {
  const { surface } = controlSurfaceFixture()
  const run = createTihuControlRunner(surface)
  const failure = await run({ action: 'no_such' }).then(() => null, (error) => error)
  assert.ok(failure instanceof Error, '未知 action 必须报错')
  assert.ok(failure.message.includes('未知 action「no_such」'), failure.message)
  for (const name of tihuActionNames()) assert.ok(failure.message.includes(name), `报错要含 ${name}：` + failure.message)
})

await testAsync('控制工具：archive 未 confirm 直接拒绝，不碰控制面', async () => {
  const { surface, calls } = controlSurfaceFixture()
  const run = createTihuControlRunner(surface)
  const failure = await run({ action: 'archive', session: '实验' }).then(() => null, (error) => error)
  assert.ok(failure instanceof Error && failure.message.includes('口头确认'), String(failure))
  assert.equal(calls.length, 0, '未确认不得触发任何控制面调用')
})

await testAsync('控制工具：archive 拒绝删除在线设备绑定中的会话', async () => {
  const { surface, calls } = controlSurfaceFixture()
  const run = createTihuControlRunner(surface)
  const failure = await run({ action: 'archive', session: '鹈鹕语音调试', confirm: true }).then(() => null, (error) => error)
  assert.ok(failure instanceof Error && failure.message.includes('拒绝删除'), String(failure))
  assert.ok(failure.message.includes('dev-1'), '错误要指出是哪台设备：' + failure.message)
  assert.equal(calls.length, 0, '守卫触发后不得调用 archiveSession')
})

await testAsync('控制工具：archive 确认后且无人绑定 → 真正归档', async () => {
  const { surface, calls, archived } = controlSurfaceFixture({ devices: [] })
  const run = createTihuControlRunner(surface)
  const text = await run({ action: 'archive', session: '实验', confirm: true })
  assert.ok(text.includes('已删除（归档）'), text)
  assert.deepEqual(archived, ['session-11cc22dd-bbbb-2222'])
  assert.deepEqual(calls, [['archive', 'session-11cc22dd-bbbb-2222']])
})

await testAsync('控制工具：会话定位 多候选给清单追问 / 无结果建议 list_sessions / 缺 session 报错', async () => {
  const { surface, calls } = controlSurfaceFixture()
  const run = createTihuControlRunner(surface)
  const many = await run({ action: 'progress', session: '鹈鹕' }).then(() => null, (error) => error)
  assert.ok(many instanceof Error && many.message.includes('匹配到 2 条'), String(many))
  assert.ok(many.message.includes('鹈鹕语音调试') && many.message.includes('鹈鹕实验记录'), '候选清单要列全：' + many.message)
  const none = await run({ action: 'progress', session: '不存在的词' }).then(() => null, (error) => error)
  assert.ok(none instanceof Error && none.message.includes('list_sessions'), String(none))
  const missingRef = await run({ action: 'bind' }).then(() => null, (error) => error)
  assert.ok(missingRef instanceof Error && missingRef.message.includes('需要 session'), String(missingRef))
  const ok = await run({ action: 'progress', session: '实验' })
  assert.deepEqual(calls, [['progress', 'session-11cc22dd-bbbb-2222']])
  assert.ok(ok.includes('进度标题'), ok)
})

await testAsync('控制工具：设备缺省取调用会话绑定的设备；单台兜底；多台无绑定与零台报错', async () => {
  // ① 绑定到调用会话的那台优先
  const a = controlSurfaceFixture({ devices: [
    { id: 'dev-9', sessionId: 'session-x', autoFollow: false, voice: 'default', edgeVoice: 'e', offlineOnly: false },
    { id: 'dev-8', sessionId: 'session-y', autoFollow: false, voice: 'default', edgeVoice: 'e', offlineOnly: false },
  ] })
  const runA = createTihuControlRunner(a.surface)
  await runA({ action: 'stop_speaking' }, { sessionId: 'session-y' })
  assert.deepEqual(a.calls, [['stopSpeaking', 'dev-8']])
  // ② 调用会话没绑设备、只有一台在线 → 缺省用它
  const b = controlSurfaceFixture({ devices: [{ id: 'dev-only', sessionId: 'other', autoFollow: false, voice: 'default', edgeVoice: 'e', offlineOnly: false }] })
  const runB = createTihuControlRunner(b.surface)
  await runB({ action: 'go_home' }, { sessionId: 'session-nobound' })
  assert.deepEqual(b.calls, [['goHome', 'dev-only']])
  // ③ 多台在线且没有绑定到调用会话的 → 明确报错
  const c = controlSurfaceFixture({ devices: [
    { id: 'dev-1', sessionId: 's1', autoFollow: false, voice: 'default', edgeVoice: 'e', offlineOnly: false },
    { id: 'dev-2', sessionId: 's2', autoFollow: false, voice: 'default', edgeVoice: 'e', offlineOnly: false },
  ] })
  const runC = createTihuControlRunner(c.surface)
  const ambiguous = await runC({ action: 'replay' }, { sessionId: 'session-nobound' }).then(() => null, (error) => error)
  assert.ok(ambiguous instanceof Error && ambiguous.message.includes('无法确定'), String(ambiguous))
  // ④ 零台在线 → 明确报错
  const d = controlSurfaceFixture({ devices: [] })
  const runD = createTihuControlRunner(d.surface)
  const empty = await runD({ action: 'replay' }).then(() => null, (error) => error)
  assert.ok(empty instanceof Error && empty.message.includes('没有鹈鹕设备在线'), String(empty))
})

await testAsync('控制工具：browse 用 session 参数传方向；open_bubble 缺 index 与标题报错', async () => {
  const { surface, calls } = controlSurfaceFixture()
  const run = createTihuControlRunner(surface)
  const prev = await run({ action: 'browse', session: 'prev' })
  assert.ok(prev.includes('上一条'), prev)
  const next = await run({ action: 'browse' })
  assert.ok(next.includes('下一条'), next)
  const bubbleMissing = await run({ action: 'open_bubble' }).then(() => null, (error) => error)
  assert.ok(bubbleMissing instanceof Error && bubbleMissing.message.includes('index'), String(bubbleMissing))
  await run({ action: 'open_bubble', index: 1 })
  assert.deepEqual(calls.filter((call) => call[0] === 'openBubble'), [['openBubble', 'dev-1', '{"index":1}']])
})

await testAsync('控制工具：status 汇总屏幕/气泡/朗读/音色；list_devices 列在线设备', async () => {
  const { surface } = controlSurfaceFixture({
    pending: [{ sessionId: 'session-11cc22dd-bbbb-2222', title: '鹈鹕实验记录', at: 1 }],
    screen: { stage: '回答', title: '结论先行', mode: 'reply', bullets: ['第一句', '第二句'] },
  })
  const run = createTihuControlRunner(surface)
  const status = await run({ action: 'status' }, { sessionId: 'session-98bb83cb-aaaa-1111' })
  assert.ok(status.includes('模式=reply'), status)
  assert.ok(status.includes('鹈鹕实验记录'), '气泡要列出：' + status)
  assert.ok(status.includes('朗读中：否'), status)
  assert.ok(status.includes('zh-CN-YunjianNeural'), status)
  const listed = await run({ action: 'list_devices' })
  assert.ok(listed.includes('dev-1'), listed)
})

await testAsync('lane.control 薄壳：archiveSession 转调 workspaceRegistry（stopActivity=true），不存在给可读错误', async () => {
  let archivedWith = null
  const records = [cuRecord('session-a', { live: true, title: '会话 A' })]
  const registry = { archiveSession: async (sessionId, options) => { archivedWith = [sessionId, options] } }
  const { runtime } = runtimeFor(records, { workspaceRegistry: registry })
  const ok = await runtime.control.archiveSession('session-a')
  assert.ok(ok.includes('已删除（归档）'), ok)
  assert.deepEqual(archivedWith, ['session-a', { stopActivity: true }])
  const missing = await runtime.control.archiveSession('session-not-exist')
  assert.ok(missing.includes('不存在'), missing)
  runtime.dispose()
})


test('protocol：回复屏 scroll 多一个 total 字段仍是 v0 最小增量（旧字段一个都不动）', () => {
  const payload = {
    stage: '回答中',
    title: '',
    bullets: [],
    tone: 'ok',
    mode: 'reply',
    reply: {
      sentences: [{ index: 0, start: 0, end: 3, text: '第一句' }],
      currentIndex: 0,
      total: 1,
      totalChars: 3,
      charPos: 0,
      lines: [{ text: '第一句', sentenceIndex: 0 }],
      scroll: { offset: 0, maxOffset: 0, total: 1 },
      follow: true,
    },
    pending: [],
    pendingCount: 0,
  }
  const frame = buildDownstream('screen.frame', payload, 1)
  assert.ok(isTihuEnvelope(frame))
  assert.equal(frame.payload.reply.scroll.total, 1, 'total 要留在帧里（不删字段）')
  assert.equal(frame.payload.reply.scroll.maxOffset, 0)
  assert.deepEqual(TIHU_DOWNSTREAM_TYPES.filter((type) => type === 'screen.frame'), ['screen.frame'], '不开新协议版本、不加新消息类型')
  assert.equal(TIHU_PROTOCOL_VERSION, '0')
})

/* ---------- 2026-11-08 第二轮：首页顶行改成「本地时钟 + 连接状态图标」 ---------- */

/** 页面源码（CSS + 屏内 DOM + 屏内 JS 都从这份文本里查）。 */
function pageSourceOf() {
  return readFileSync(new URL('../src/tihu/page.ts', import.meta.url), 'utf8')
}

/** 渲染出来的真机屏 HTML（含 CSS 与脚本）。 */
function pageHtmlOf() {
  const { ctx } = fakeCtx()
  const runtime = createTihuRuntime(ctx, { log: () => {}, tts: { disabled: true } })
  const html = runtime.page()
  runtime.dispose()
  return html
}

/** 顶行那一截 DOM（只它一个元素，用来证明屏内那一行没有 emoji / 图片 / 图标字体 / 多写的「断开」）。 */
function homeTopDomOf(html) {
  const match = html.match(/<div id="homeTop"[\s\S]*?<\/div>/)
  assert.ok(match !== null, '屏内要有 #homeTop 这一行（首页最上方那一行）')
  return match[0]
}

test('page：首页最上方那一行换成本地时钟 + 三格信号柱（纯 CSS 内联元素，不用 emoji/图片/字体图标）', () => {
  const html = pageHtmlOf()
  const top = homeTopDomOf(html)
  // 旧那一行整段删掉：屏内没有任何「项目 N 个」文本，也没有那个「第 x/y 页」的 stage 拼装
  assert.equal(top.includes('项目'), false, '顶行不含「项目 …」计数')
  assert.equal(/个 · |\/\d+ 页/.test(top), false, '顶行不含「N 个 · x/y 页」尾巴')
  assert.equal(html.includes('homeStageText'), false, '主页 stage 拼装函数已删')
  // 时钟 + 信号柱都在屏内、且在项目列表之前（屏最上方那一行）
  assert.ok(/id="homeClock"/.test(top) && /id="homeSignal"/.test(top), '顶行要有时钟与信号柱两个元素')
  assert.ok(html.indexOf('id="homeTop"') < html.indexOf('id="homeBody"'), '顶行必须排在项目列表之前（屏最上方）')
  // 三格信号柱：三根柱、纯内联元素，没有 emoji、没有图片、没有外部字体图标
  const bars = top.match(/<span class="bar b\d"><\/span>/g) || []
  assert.equal(bars.length, 3, '三格信号柱要有三根柱：' + bars.length)
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u.test(top), false, '顶行不许用 emoji/符号图形')
  assert.equal(/<img|url\(|background-image|@font-face|font-icon|iconfont/i.test(top), false, '不许用图片、背景图、图标字体')
  // 只在主页屏出现：状态屏 / 回答屏那一行（stage）保持原样
  assert.ok(html.includes('#screen .home-top { display:none;'), '顶行默认不显示（只在 home-mode 出）')
  assert.ok(html.includes('#screen.home-mode .home-top { display:flex; }'), 'home-mode 用 flex 显示顶行')
  assert.ok(html.includes('#screen.home-mode .stage { display:none; }'), 'home-mode 收掉旧 stage 那一行')
  assert.equal(html.includes('#screen.reply-mode .home-top'), false, '回答屏不许出顶行')
})

test('page：时钟只显示到分钟（HH:MM、24 小时制、零补齐），走表刷新且不靠宿主帧', () => {
  const source = pageSourceOf()
  const fn = source.match(/function clockText\(\)\s*\{[\s\S]*?\n\s*\}/)
  assert.ok(fn !== null, '要有页面自己的时钟函数 clockText()')
  const body = fn[0]
  assert.ok(/getHours\(\)/.test(body) && /getMinutes\(\)/.test(body), '24 小时制（getHours）+ 只到分钟（getMinutes）')
  assert.equal(/getSeconds\(/.test(body), false, '只显示到分钟：不取秒')
  assert.equal(/toLocaleTimeString|toLocaleDateString|12\s*\)/.test(body), false, '不许按 locale 的 12 小时制走')
  assert.ok(body.includes("(hh < 10 ? '0' : '')") && body.includes("(mm < 10 ? '0' : '')"), '时与分都要零补齐（19:32）')
  assert.ok(body.includes("':'"), '输出形如 HH:MM')
  // 走表刷新：每秒 tick 一次；收到 screen.frame 时也重画一次
  assert.ok(/setInterval\(renderHomeTop,\s*1000\)/.test(source), '页面要每秒 tick 重画顶行')
  assert.ok(/function renderScreen\(payload\)\s*\{[\s\S]{0,300}?renderHomeTop\(\);/.test(source), '每来一帧也重画一次顶行')
  // 顶行不读宿主帧内容：时钟与连接都由页面本地状态出
  const renderBody = (source.match(/function renderHomeTop\(\)\s*\{[\s\S]*?\n\s*\}/) || [''])[0]
  assert.ok(renderBody !== '', '要有 renderHomeTop()')
  assert.equal(/payload/.test(renderBody), false, '顶行渲染不取 payload（不依赖宿主推时间）')
  assert.equal(/SCREEN\.clock|home\.clock/.test(source), false, '宿主帧里没有时钟字段可读')
})

test('page：连接图标接的是页面已有的那一份连接状态（绿/灰/红三档，断开只有颜色不写文字）', () => {
  const source = pageSourceOf()
  const html = pageHtmlOf()
  // 三档颜色：已连上=绿、连接中/重连中=灰（柱条稍淡）、断开=红
  assert.ok(/\.signal\.conn-online \.bar \{ background:#35d07f;/.test(html), '已连上宿主 → 绿')
  assert.ok(/\.signal\.conn-connecting \.bar \{ background:#6b7785; opacity:\.\d+;/.test(html), '连接中/重连中 → 灰、柱条稍淡')
  assert.ok(/\.signal\.conn-offline \.bar \{ background:var\(--err\);/.test(html), '断开 → 红')
  // 接同一份状态：#conn 那条 + ws.onopen/onclose 都要落到 setConnState
  assert.ok(html.includes("$('conn').textContent = '已连接'") && html.includes("$('conn').className = 'on'"), '屏外那条 conn 不动')
  assert.ok(html.includes("$('conn').textContent = '已断开'"), '断开事件仍走同一份状态（conn 元素）')
  assert.ok(/ws\.onopen = function \(\)\s*\{[\s\S]{0,200}?setConnState\('online'\)/.test(html), 'onopen 置 online（绿）')
  assert.ok(/ws\.onclose = function \(event\)\s*\{[\s\S]{0,200}?setConnState\('offline'\)/.test(html), 'onclose 置 offline（红）')
  assert.ok(/function connect\(\)\s*\{[\s\S]{0,200}?setConnState\('connecting'\)/.test(html), '拨号中（含每 2 秒重连）置 connecting（灰）')
  assert.ok(html.includes("setTimeout(connect, 2000)"), '断开后照旧自动重连（重连中该是灰）')
  // 断开只靠颜色区分：屏内那一行不写「断开」/「离线」文字
  assert.equal(homeTopDomOf(html).includes('断开'), false, '顶行不加「断开」文字')
  assert.equal(homeTopDomOf(html).includes('离线'), false, '顶行不加「离线」文字')
  assert.equal(html.includes("'离线 · '"), false, '旧的「离线 · 」前缀已去掉（那一行现在是时钟）')
  // 不新增协议字段：连接状态只在页面内部转，不往 lane 发新消息
  assert.equal(/send\('conn|send\('clock|send\('status/.test(html), false, '页面不上报连接状态（不新增协议字段）')
  // 宿主侧不掺和时钟与连接：lane 里没有时钟、也没有连接状态
  const laneSource = readFileSync(new URL('../src/tihu/lane.ts', import.meta.url), 'utf8')
  assert.equal(/clockText|connState|getHours\(\)/.test(laneSource), false, '时钟与连接归页面侧，lane 不掺和')
})

test('page：顶行 14px，棋盘不再有旧式翻页条，4 行 ×48px 收进 222 内容高', () => {
  const html = pageHtmlOf()
  assert.ok(/#screen \.home-top \{[^}]*height:14px/.test(html), '顶行高 14px（与 stage 那一行同高）')
  assert.ok(/#screen \.home-top \.signal \{[^}]*height:13px/.test(html), '信号柱容器高 13px（不越过行高）')
  assert.ok(/#screen \.home-top \.signal \.bar\.b3 \{ height:13px/.test(html), '最长那根柱 13px')
  assert.equal(html.includes('home-pager'), false, '旧式翻页条（上一页/下一页）已整体删除')
  const itemH = Number((html.match(/#screen \.board-item \{[^}]*height:(\d+)px/) || [0, 0])[1])
  assert.equal(itemH, 48, '棋盘一行 48px（4 行 × 两行字，含上下 6px 内边距）')
  assert.equal(BOARD_PAGE_SIZE, 4, '棋盘最多 4 条')
  const used = 14 + 4 + BOARD_PAGE_SIZE * itemH
  assert.ok(used <= SCREEN_SPEC.heightPx - 2 * SCREEN_SPEC.paddingPx, `棋盘内容高 ${used}px 不得超过 ${SCREEN_SPEC.heightPx - 2 * SCREEN_SPEC.paddingPx}px`)
  assert.ok(SCREEN_SPEC.heightPx - 2 * SCREEN_SPEC.paddingPx - used >= 8, '底部要留白（不贴屏底）')
})


/* ---------- 2026-11-09 四项整改：绑定 / 屏内恢复 / edge 开箱 / 语音预览 ---------- */

await testAsync('P0-4：edge 脚本走仓库，依赖可注入探测，代理只能显式配置', async () => {
  const tts = await import('../src/tihu/tts.ts')
  const script = tts.edgeScriptPath()
  assert.ok(script.endsWith(join('scripts', 'tihu-edge-tts.py')))
  assert.ok(existsSync(script))
  assert.ok(!script.includes(join('.dsh', 'tihu', 'tihu-edge-tts.py')))
  const calls = []
  const ok = tts.probeEdgeDependencies({ python: 'py-test', script, ffmpeg: 'ff-test' }, (command, args) => { calls.push([command, args]); return { status: 0 } })
  assert.equal(ok.ok, true)
  assert.ok(calls.some((call) => call[0] === 'py-test' && call[1].includes('-c') && call[1].includes('import edge_tts')))
  assert.ok(calls.some((call) => call[0] === 'ff-test' && call[1].includes('-version')))
  const missing = tts.probeEdgeDependencies({ python: 'py-test', script, ffmpeg: 'ff-test' }, (_command, args) => ({ status: args.includes('-c') ? 1 : 0 }))
  assert.equal(missing.ok, false)
  assert.ok(missing.error.includes('edge_tts'))
  const edgePy = readFileSync(new URL('./tihu-edge-tts.py', import.meta.url), 'utf8')
  assert.equal(edgePy.includes('7897'), false)
  assert.ok(edgePy.includes("os.environ.get(\"TIHU_EDGE_PROXY\")"))
})

await testAsync('P0-4：缺 edge 依赖时不请求 edge，直接进入既有 Kokoro 兜底', async () => {
  const { TihuTts } = await import('../src/tihu/tts.ts')
  const instance = new TihuTts({ log: () => {}, threads: 1 })
  instance.edgeReady = () => false
  instance.kokoroReady = () => true
  instance.ensureKokoroServer = async () => {}
  let edge = 0
  let kokoro = 0
  instance.synthesizeEdge = async () => { edge += 1 }
  instance.synthesizeKokoro = async (_text, options) => { kokoro += 1; options.onChunk({ data: Buffer.alloc(4800), seq: 0, total: 1, final: true }); return { sampleRate: 24000, firstChunkMs: 1, audioMs: 100, totalMs: 1, chunks: 1 } }
  await instance.synthesize('第一句。', { onChunk: () => {} })
  assert.equal(edge, 0)
  assert.equal(kokoro, 1)
  assert.equal(instance.activeEngine(), 'kokoro')
  instance.dispose()
})

await testAsync('P1-1：纯静音不进 ASR；危险指令不自动发；ASR 中重说使迟到结果失效', async () => {
  let transcribes = 0
  let resolveAsr
  const asrGate = new Promise((resolve) => { resolveAsr = resolve })
  const { agents, calls } = agentsFixture(['session-1'])
  const speechController = { transcribe: async () => { transcribes += 1; await asrGate; return { text: '删除当前文件' } } }
  const { runtime } = runtimeFor([cuRecord('session-1', { live: true })], { agents, speechController })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'voice-guard', protocol: '0', sessionId: 'session-1' }, 1)))
  await waitMs(30)
  socket.emit('data', clientFrame(buildUpstream('audio.frame', { format: 'wav', sampleRate: 16000, channels: 1, bits: 16, audioBase64: tinyWavBase64(), durationMs: 16 }, 2)))
  await waitMs(30)
  assert.equal(transcribes, 0, '纯静音不得进入 ASR')
  assert.equal(calls.length, 0)
  socket.emit('data', clientFrame(buildUpstream('audio.frame', { format: 'wav', sampleRate: 16000, channels: 1, bits: 16, audioBase64: voicedWavBase64(), durationMs: 800 }, 3)))
  await waitMs(20)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 20, y: 200, hit: 'action', actionId: 'retry' }, 4)))
  resolveAsr()
  await waitMs(2150)
  assert.equal(calls.length, 0, '危险指令及已取消的迟到 ASR 都不得自动注入')
  assert.equal(framesOf(socket).filter((frame) => frame.type === 'transcript' && frame.payload.text.includes('删除')).length, 0, '取消后不得再出现迟到 transcript')
  const page = pageSourceOf()
  assert.ok(page.includes('condition(') && page.includes('trimSilence('), '页面必须复用现有音频调理')
  assert.ok(page.includes('has-actions'), '状态屏预览动作必须在 320×240 内可见')
  runtime.dispose()
})


/* ---------- 2026-11-09 统一指挥会话：指挥会话 + 派单器 + 任务登记簿 ----------
 *
 * 这一组钉住三件事：
 *   1. 设备默认绑**唯一指挥会话**（不再挑最活跃会话、不再有会话选择器）；
 *   2. 一句话走派单器落到**项目文件夹**（卡片文件夹 / 助手 home / 追加不新建）；
 *   3. 完成由**任务**驱动：屏 6 ＋ 一句播报（八秒窗口合并），不需要点进任何会话。
 */

/** 造一套「有控制室卡片 + 有一条指挥会话」的工作区；顺手把两个环境变量指到临时目录。 */
function unifiedWorkspace(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tihu-unified-'))
  const home = join(root, 'assistant')
  const fundFolder = join(root, 'fixed-fund')
  mkdirSync(home, { recursive: true })
  mkdirSync(fundFolder, { recursive: true })
  const stateFile = join(root, 'dsh-assistant-state.json')
  const cards = options.cards ?? [{ id: 'card-fund', name: '青年基金申请书', folder: fundFolder }]
  writeFileSync(stateFile, JSON.stringify({
    projects: {
      layouts: cards.map((card) => ({ id: card.id, title: card.name })),
      folders: Object.fromEntries(cards.map((card) => [card.id, card.folder])),
      nameOverrides: {},
      order: cards.map((card) => card.id),
      hidden: [],
      removed: [],
    },
    view: null,
    revision: 1,
    updatedAt: new Date(0).toISOString(),
  }), 'utf8')
  process.env.DSH_ASSISTANT_HOME = home
  process.env.TIHU_PROJECTS_STATE = stateFile
  const created = []
  const prompted = []
  const renamed = []
  const records = options.seedCommander === false
    ? []
    : [cuRecord('session-cmd', { live: true, preset: 'standard', title: '鹈鹕指挥台' })]
  // 额外种子会话（电脑端外部任务那组用）：必须在 runtimeFor 之前放进去，
  // 投影缓存 fixture 是按数组快照建 Map 的，晚 push 的会话查不到标题。
  if (Array.isArray(options.records)) records.push(...options.records)
  // 宿主真实建会话入口（2026-11-09 修复）：sessionController.create/rename。
  const sessionController = {
    create: async (request) => {
      created.push(request)
      const id = 'session-task-' + created.length
      records.push(cuRecord(id, { live: true, preset: request.agentPreset, cwd: request.cwd, title: '任务 ' + created.length }))
      return { sessionId: id }
    },
    rename: async ({ sessionId, title }) => {
      renamed.push({ sessionId, title })
      const record = records.find((item) => item.header.id === sessionId)
      if (record !== undefined) record.projection.title = title
      return { title, seq: 1 }
    },
  }
  const remote = {
    session: {
      create: async (base) => {
        created.push(base)
        const id = 'session-task-' + created.length
        records.push(cuRecord(id, { live: true, preset: base.agentPreset, cwd: base.cwd, title: '任务 ' + created.length }))
        return { ok: true, value: { sessionId: id } }
      },
    },
  }
  const sessions = {
    using: async (id, _opts, fn) => fn({
      binding: {
        session: {
          prompt: async (blocks) => prompted.push({ id, blocks }),
          // 宿主用它给「tihu 语音链路」挂工具闸窗口：派单也算一次 tihu 注入。
          deriveMessages: () => [{ role: 'user', id: 'msg-' + id }],
        },
      },
    }),
  }
  const fixture = runtimeFor(records, options.noCreate === true
    ? { sessions }
    : { remote, sessions, sessionController }, options.tts ?? {})
  return {
    ...fixture,
    root,
    home,
    fundFolder,
    stateFile,
    cards,
    created,
    prompted,
    renamed,
    records,
    cleanup: () => {
      fixture.runtime.dispose()
      delete process.env.DSH_ASSISTANT_HOME
      delete process.env.TIHU_PROJECTS_STATE
      try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
    },
  }
}

await testAsync('统一指挥：hello 绑唯一指挥会话，屏上是空棋盘（不是项目清单）', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u1', protocol: '0' }, 1)))
  await waitMs(60)
  const frames = framesOf(socket)
  const bound = frames.filter((frame) => frame.type === 'session.bound').pop()
  assert.ok(bound !== undefined, '应下发 session.bound')
  assert.equal(bound.payload.sessionId, 'session-cmd', '要绑标题含「鹈鹕指挥台」的那条会话')
  const board = frames.filter((frame) => frame.type === 'screen.frame' && frame.payload.board).pop()
  assert.ok(board !== undefined, '屏帧要带 board（任务棋盘投影）')
  assert.equal(board.payload.mode, 'home')
  assert.equal(board.payload.board.empty, true, '一个任务都没有 = 同一版式的空态')
  assert.deepEqual(board.payload.board.counts, { running: 0, awaiting: 0, queued: 0 })
  assert.ok(frames.some((frame) => frame.type === 'task.list'), '棋盘数据也要单独发一条 task.list')
  assert.equal(w.created.length, 0, '已有指挥会话就不要再建')
  assert.equal(frames.some((frame) => frame.type === 'event.alert' && String(frame.payload.text).includes('Computer Use')), false,
    '指挥会话不是 CU 模式，但不该按「非 CU」告警')
  w.cleanup()
})

await testAsync('统一指挥：没有指挥会话时 hello 自动建「鹈鹕指挥台」并进空棋盘', async () => {
  const w = unifiedWorkspace({ seedCommander: false })
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u0', protocol: '0' }, 1)))
  await waitMs(80)

  const frames = framesOf(socket)
  assert.equal(w.created.length, 1, '没有指挥会话时要新建一条')
  assert.equal(w.created[0].cwd, w.home, '指挥会话落助手 home')
  assert.equal(w.created[0].agentPreset, 'standard', '指挥会话用 standard（它只看单、不看屏）')
  assert.equal(w.renamed.length, 1, '新建后要写一次标题')
  assert.deepEqual(w.renamed[0], { sessionId: 'session-task-1', title: '鹈鹕指挥台' }, '标题必须是「鹈鹕指挥台」，下次才找得回')

  const bound = frames.filter((frame) => frame.type === 'session.bound').pop()
  assert.ok(bound !== undefined, '应下发 session.bound')
  assert.equal(bound.payload.sessionId, 'session-task-1')
  const board = frames.filter((frame) => frame.type === 'screen.frame' && frame.payload.board).pop()
  assert.ok(board !== undefined, '屏帧要带 board')
  assert.equal(board.payload.board.empty, true)
  assert.equal(board.payload.board.rows.length, 0)
  assert.deepEqual(board.payload.board.counts, { running: 0, awaiting: 0, queued: 0 }, '顶行三段计数归零')
  assert.ok(frames.some((frame) => frame.type === 'task.list'))
  assert.equal(frames.some((frame) => frame.type === 'screen.frame' && frame.payload.home !== undefined), false,
    '绝不能退回项目卡片 home')

  // 第二次 hello 复用同一条（标题已落库），不再新建。
  const second = openLane(w.runtime)
  second.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u0b', protocol: '0' }, 1)))
  await waitMs(60)
  assert.equal(w.created.length, 1, '第二次 hello 要复用，不再新建指挥会话')
  const secondBound = framesOf(second).filter((frame) => frame.type === 'session.bound').pop()
  assert.equal(secondBound.payload.sessionId, 'session-task-1')
  w.cleanup()
})

await testAsync('统一指挥：建不出指挥会话时也进空棋盘，不退回项目卡片', async () => {
  const w = unifiedWorkspace({ seedCommander: false, noCreate: true })
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u9', protocol: '0' }, 1)))
  await waitMs(70)

  const frames = framesOf(socket)
  assert.equal(w.created.length, 0)
  const errorFrame = frames.filter((frame) => frame.type === 'screen.frame').pop()
  assert.ok(errorFrame !== undefined, '建不出指挥会话也要推一帧')
  assert.ok(String(errorFrame.payload.title).includes('鹈鹕指挥台不可用'), '黑底一行中文错误提示：' + JSON.stringify(errorFrame.payload))
  assert.equal(errorFrame.payload.tone, 'alert')
  assert.equal(frames.some((frame) => frame.type === 'screen.frame' && (frame.payload.board !== undefined || frame.payload.home !== undefined)), false,
    '不退回棋盘空态、更不退回旧主页')
  assert.ok(frames.some((frame) => frame.type === 'event.alert' && String(frame.payload.text).includes('鹈鹕指挥台不可用')),
    '要留下可诊断告警')
  w.cleanup()
})

await testAsync('统一指挥：问答记忆 → 自己直接答，不落任务', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u-answer', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '你还记得上次青年基金那件事吗', source: 'voice' }, 2)))
  await waitMs(90)
  assert.equal(w.created.length, 0, '问答记忆不建任务会话')
  assert.equal(w.prompted.length, 1, '直接投给指挥会话')
  assert.equal(w.prompted[0].id, 'session-cmd')
  const last = framesOf(socket).filter((frame) => frame.type === 'screen.frame').pop()
  assert.equal(last.payload.stage, '回答', '屏上进入直接回答')
  w.cleanup()
})

await testAsync('统一指挥：日常小事派到「个人助手」文件夹，回执屏带三拍圆点与 5 秒倒计时', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u2', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(90)
  assert.equal(w.created.length, 1, '要新建一条任务会话')
  assert.equal(w.created[0].cwd, w.home, '日常任务落助手 home（与长按悬浮球一致）')
  assert.equal(w.created[0].agentPreset, 'standard', '日常任务一律 standard')
  assert.equal(w.prompted.length, 1, '原话要进任务会话')
  assert.equal(w.prompted[0].blocks[0].text, '现在几点了')
  const dispatchTail = String(w.prompted[0].blocks[1].text)
  assert.ok(dispatchTail.includes(`这句话已派到「个人助手」`), '尾巴要带真实项目卡名')
  assert.ok(dispatchTail.includes(`工作目录是 ${w.created[0].cwd}`), '尾巴要带真实 cwd')
  assert.ok(dispatchTail.includes('鹈鹕是主人家里的语音小屏助手'), '新尾巴开场要一致')
  assert.ok(dispatchTail.includes('先给结论，再给关键数字或进展'), '朗读要求要带结论优先')
  assert.ok(dispatchTail.includes('不要表格、列表、代码块或长路径'), '朗读要求要禁长路径/表格')
  assert.equal(dispatchTail.includes('直接开始做'), false, '旧尾巴不能残留')
  assert.equal(dispatchTail.includes('需要人拍板'), false, '旧尾巴不能残留')
  const frames = framesOf(socket)
  const receipt = frames.filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '派单').pop()
  assert.ok(receipt !== undefined, '要出派单回执屏（屏 2）')
  assert.equal(receipt.payload.title, '已派给 个人助手')
  assert.deepEqual(receipt.payload.steps.map((step) => step.state), ['done', 'done', 'active'])
  assert.deepEqual(receipt.payload.actions.map((item) => item.id), ['taskOpen', 'taskCancel'])
  assert.equal(receipt.payload.countdown.seconds, 5)
  const list = frames.filter((frame) => frame.type === 'task.list').pop()
  assert.equal(list.payload.board.rows.length, 1)
  assert.equal(list.payload.board.rows[0].capsule, '派单', '回执阶段的登记簿态是「派单」')
  assert.equal(list.payload.board.rows[0].sub, '个人助手 · 已派出')
  w.cleanup()
})

await testAsync('统一指挥：点名项目卡 → 落那张卡的文件夹，且不改控制室状态', async () => {
  const w = unifiedWorkspace()
  const before = readFileSync(w.stateFile, 'utf8')
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u3', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '青年基金申请书第 3 段再改一遍，要有数据支撑', source: 'voice' }, 2)))
  await waitMs(90)
  assert.equal(w.created.length, 1)
  assert.equal(w.created[0].cwd, w.fundFolder, '复杂任务跟项目卡片走')
  const receipt = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '派单').pop()
  assert.equal(receipt.payload.title, '已派给 青年基金申请书')
  assert.equal(readFileSync(w.stateFile, 'utf8'), before, '已有卡就不要再写状态文件')
  w.cleanup()
})

await testAsync('统一指挥：回执 5 秒内不被通用思考帧与任务进度帧覆盖', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u-receipt', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(90)
  const receipt = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '派单').pop()
  assert.ok(receipt !== undefined, '派单要有回执屏')
  const afterReceipt = () => framesOf(socket).filter((frame) => frame.type === 'screen.frame').pop()
  assert.equal(afterReceipt().payload.stage, '派单', '回执后不能再补通用「思考」帧')
  const emit = w.events.find((entry) => entry.name === 'session/event').handler
  emit({ id: w.prompted[0].id }, { type: 'step/start', data: { turn: 1, step: 2 } })
  await waitMs(60)
  assert.equal(afterReceipt().payload.stage, '派单', '回执期间任务进度帧不得夺屏')
  w.cleanup()
})

await testAsync('统一指挥：连接后 3 秒的 bindHome 不得抢走回执', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u-bindhome', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(90)
  await waitMs(3100)
  const last = framesOf(socket).filter((frame) => frame.type === 'screen.frame').pop()
  assert.equal(last.payload.stage, '派单', 'bindHome 3 秒计时遇到回执必须让路')
  w.cleanup()
})

await testAsync('统一指挥：回执/追问期间「回棋盘」可清掉旧的 5 秒计时', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u-boardclear', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(90)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '回棋盘', source: 'voice' }, 3)))
  await waitMs(60)
  const board = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.board).pop()
  assert.ok(board !== undefined, '回棋盘要立刻出棋盘')
  const emit = w.events.find((entry) => entry.name === 'session/event').handler
  emit({ id: w.prompted[0].id }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: w.prompted[0].id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(80)
  const done = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '完成').pop()
  assert.ok(done !== undefined, '回棋盘后完成帧不能被旧回执计时挡住')
  w.cleanup()
})


await testAsync('统一指挥：两个卡名都点到 → 追问屏（只问一次），答「一」才派', async () => {
  const w = unifiedWorkspace({
    cards: [
      { id: 'card-fund', name: '青年基金申请书', folder: join(tmpdir(), 'tihu-fund-folder') },
      { id: 'card-lin', name: '磷石膏SCI', folder: join(tmpdir(), 'tihu-lin-folder') },
    ],
  })
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u4', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '把青年基金申请书和磷石膏SCI都整理一下投出去', source: 'voice' }, 2)))
  await waitMs(90)
  const ask = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '追问').pop()
  assert.ok(ask !== undefined, '有歧义必须问，不许猜')
  assert.equal(framesOf(socket).filter((frame) => frame.type === 'screen.frame').pop().payload.stage, '追问', '追问屏不能被通用思考帧盖掉')
  assert.equal(ask.payload.title, '这句话派给谁？')
  assert.deepEqual(ask.payload.actions.map((item) => item.id), ['pick1', 'pick2', 'pickNone'])
  assert.equal(w.created.length, 0, '没答之前不许乱派')
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '一', source: 'voice' }, 3)))
  await waitMs(90)
  assert.equal(w.created.length, 1, '答「一」才派单')
  assert.ok(String(w.created[0].cwd).includes('tihu-fund-folder'))
  w.cleanup()
})

await testAsync('统一指挥：任务 turn/end → 屏 6「完成」＋ 一行播报（八秒窗口合并）', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  const emit = w.events.find((entry) => entry.name === 'session/event').handler
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u5', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(90)
  // 回执要停满 5 秒；这里先显式回棋盘再看完成帧（同一会话在回执期间完成时，
  // 屏 2 优先，完成照常进 task.notify——见 live 验收）。
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '回棋盘', source: 'voice' }, 3)))
  await waitMs(60)
  const taskSession = w.prompted[0].id
  emit({ id: taskSession }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: taskSession }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '现在十七点三十一分。' }] } } })
  emit({ id: taskSession }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(90)
  const frames = framesOf(socket)
  const done = frames.filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '完成').pop()
  assert.ok(done !== undefined, '完成要有屏 6（不必点进会话）')
  assert.equal(done.payload.title, '现在几点了', '大标题是任务名（不是回答第一句）')
  assert.equal(done.payload.stage, '完成')
  assert.ok(Array.isArray(done.payload.done?.lines) && done.payload.done.lines.length > 0, '完成页要带回答正文行')
  assert.ok(done.payload.actions.some((item) => item.id === 'taskBoard'), '完成屏要能回棋盘')
  const note = frames.filter((frame) => frame.type === 'task.notify').pop()
  assert.ok(note !== undefined, '完成要进通知总线（屏气泡＋播报）')
  assert.equal(note.payload.level, 1)
  assert.ok(note.payload.text.includes('现在几点了'), '播报用任务标题，不念会话 id：' + note.payload.text)
  await waitMs(600)
  const spoken = framesOf(socket).filter((frame) => frame.type === 'task.notify' && frame.payload.spoken === true).pop()
  assert.ok(spoken !== undefined, '过了单条延迟要念（八秒窗口下第一条很快念）')
  w.cleanup()
})

await testAsync('统一指挥：完成屏＝回复版式（7 行正文＋当前句反色＋另有 N 条）', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  const emit = w.events.find((entry) => entry.name === 'session/event').handler
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u-done7', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(90)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '回棋盘', source: 'voice' }, 3)))
  await waitMs(60)
  const taskSession = w.prompted[0].id
  const long = '第 3 段改写完成。温度场结果已收敛，跨中腹板温差 1.1 ℃，比目标 1.5 ℃ 还好。'
    + '第 4 步把边界拆成了两段：夜间常数 2.448 ℃，白天用 ERA5。图 1 和表 2 已落到 04-结果目录。'
    + '文件名按昨天的规范改了，正文引用编号也同步。'
  emit({ id: taskSession }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: taskSession }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } })
  emit({ id: taskSession }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(100)
  const done = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '完成').pop()
  assert.ok(done !== undefined, '完成要有屏 6')
  assert.equal(done.payload.mode, 'status', '完成屏是状态屏（旧回复版式已删除）')
  assert.equal(done.payload.reply, undefined, '不该再有 reply 正文窗口')
  assert.equal(done.payload.title, '现在几点了', '大标题＝任务名，不是回答第一句')
  assert.ok(done.payload.bullets.length <= 4 && done.payload.bullets.length > 0, '正文最多 3 行：' + JSON.stringify(done.payload.bullets))
  assert.ok(Array.isArray(done.payload.done?.lines) && done.payload.done.lines.length >= 3, '长回答要按像素折行：' + JSON.stringify(done.payload.done?.lines))
  assert.equal(done.payload.done.current, 0, '进入完成页从第一行开始高亮')
  assert.equal(done.payload.more, undefined, '同批没有其它完成时不出「另有」')
  assert.deepEqual(done.payload.actions.map((item) => item.label), ['停止', '重读', '主页'])
  w.cleanup()
})

await testAsync('统一指挥：同一批两条完成 → 八秒窗口合并成一句播报', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  const emit = w.events.find((entry) => entry.name === 'session/event').handler
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u-merge', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(80)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '今天几号', source: 'voice' }, 3)))
  await waitMs(120)
  assert.equal(w.prompted.length, 2, '两条都要派出')
  const first = w.prompted[0].id
  const second = w.prompted[1].id
  emit({ id: first }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: second }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: first }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(500)
  emit({ id: second }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(8600)
  const spoken = framesOf(socket).filter((frame) => frame.type === 'task.notify' && frame.payload.spoken === true)
  assert.equal(spoken.length, 1, '同一批只念一次（实测曾念三遍）：' + JSON.stringify(spoken.map((item) => item.payload.text)))
  assert.ok(spoken[0].payload.text.includes('两件事完了'), '两条完成要压成「两件事完了」：' + spoken[0].payload.text)
  w.cleanup()
})

await testAsync('统一指挥：说「回棋盘」/「看第 1 条」按屏上命令走，不需要模型', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u6', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '青年基金申请书第 3 段再改一遍', source: 'voice' }, 2)))
  await waitMs(90)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '回棋盘', source: 'voice' }, 3)))
  await waitMs(60)
  let board = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.board).pop()
  assert.ok(board !== undefined)
  assert.equal(board.payload.board.rows.length, 1, '回棋盘要看到刚派的那条')
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '看第 1 条', source: 'voice' }, 4)))
  await waitMs(60)
  const detail = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && Array.isArray(frame.payload.actions)
    && frame.payload.actions.some((item) => item.id === 'taskBoard')).pop()
  assert.ok(detail !== undefined, '「看第 1 条」要进任务详情（屏 4）')
  assert.equal(detail.payload.title, '青年基金申请书第 3 段再改一遍', '详情大标题是任务名：' + detail.payload.title)
  assert.equal(w.created.length, 1, '看任务不新建会话')
  w.cleanup()
})

await testAsync('统一指挥：带唤醒词「你好，鹈鹕回棋盘」也按屏上命令走，不算任务', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u6w', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '青年基金申请书第 3 段再改一遍', source: 'voice' }, 2)))
  await waitMs(90)
  const created = w.created.length
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '你好，鹈鹕回棋盘', source: 'voice' }, 3)))
  await waitMs(60)
  const board = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.board).pop()
  assert.ok(board !== undefined, '带唤醒词的回棋盘要立刻出棋盘')
  assert.equal(board.payload.board.rows.length, 1, '棋盘上仍是刚派的那条')
  assert.equal(w.created.length, created, '唤醒词回棋盘不新建会话')
  w.cleanup()
})

await testAsync('统一指挥：点棋盘上一行（gesture hit=task）进详情，不换会话绑定', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u7', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '青年基金申请书第 3 段再改一遍', source: 'voice' }, 2)))
  await waitMs(90)
  const before = framesOf(socket).filter((frame) => frame.type === 'session.bound').length
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 40, y: 60, hit: 'task', taskId: 't1' }, 3)))
  await waitMs(60)
  const frames = framesOf(socket)
  const detail = frames.filter((frame) => frame.type === 'screen.frame' && Array.isArray(frame.payload.actions)
    && frame.payload.actions.some((item) => item.id === 'taskBoard')).pop()
  assert.ok(detail !== undefined, '点行要看任务详情')
  assert.equal(frames.filter((frame) => frame.type === 'session.bound').length, before, '点行不许换会话绑定')
  w.cleanup()
})

await testAsync('协议：task.reply 只收实质内容，坏帧一律忽略', async () => {
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('task.reply', { command: 'board' }, 1))) !== null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('task.reply', { taskId: 't3', optionIndex: 1 }, 2))) !== null)
  assert.ok(parseUpstream(JSON.stringify(buildUpstream('task.reply', { text: '先留着' }, 3))) !== null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('task.reply', {}, 4))), null, '全空 = 坏帧')
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('task.reply', { optionIndex: 9 }, 5))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('task.reply', { command: 'x' }, 6))), null)
  assert.equal(parseUpstream(JSON.stringify(buildUpstream('task.reply', { taskId: 'x'.repeat(80) }, 7))), null)
})

await testAsync('协议：task.list / task.update / task.notify 都是合法 v0 下行信封', async () => {
  const board = {
    rows: [{ taskId: 't1', title: '改写第 3 段', state: 'running', capsule: '执行中', sub: '青年基金申请书 · 第 7 步', ring: { percent: 0.4, tone: 'normal' } }],
    counts: { running: 1, awaiting: 0, queued: 0 },
    page: { index: 0, total: 1 },
    total: 1,
    empty: false,
  }
  const list = buildDownstream('task.list', { board }, 1)
  assert.ok(isTihuEnvelope(list))
  assert.equal(list.payload.board.rows[0].capsule, '执行中')
  const update = buildDownstream('task.update', { taskId: 't1', state: 'done', capsule: '完成', sub: '青年基金申请书 · 已完成', ring: { percent: 1, tone: 'done' } }, 2)
  assert.ok(isTihuEnvelope(update))
  const notify = buildDownstream('task.notify', { level: 1, taskId: 't1', text: '改写完成', spoken: true }, 3)
  assert.ok(isTihuEnvelope(notify))
  assert.equal(notify.payload.level, 1)
  // 屏帧上的任务棋盘与附加块都是可选字段（必填仍只有 stage/title/bullets）
  const frame = buildDownstream('screen.frame', { stage: '', title: '', bullets: [], board, steps: [{ label: '已入队', state: 'done' }], countdown: { seconds: 5 }, more: { count: 2, text: '另有 2 条' }, taskId: 't1' }, 4)
  assert.ok(isTihuEnvelope(frame))
  assert.equal(Object.keys(frame.payload).includes('board'), true)
})

await testAsync('统一指挥：危险动作不上设备屏、不弹授权（只在电脑端审批）', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u8', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '青年基金申请书第 3 段再改一遍', source: 'voice' }, 2)))
  await waitMs(90)
  const taskSession = w.prompted[0].id
  const pre = w.events.find((entry) => entry.name === 'tools/pre-execute').handler
  // 设备屏永远不显示命令行/授权请求：危险动作直接放给电脑端（宿主 approval/request）。
  const outcome = await pre({
    callId: 'call-1',
    name: 'pwsh',
    arguments: { command: 'Remove-Item -Recurse -Force .tihu' },
    agent: { session: { id: taskSession, deriveMessages: () => [{ role: 'user', id: 'msg-' + taskSession }] } },
  }, async () => ({ kind: 'ok' }))
  assert.notEqual(outcome && outcome.kind, 'deny', '设备屏不再拦危险动作：授权只在电脑端处理')
  const frames = framesOf(socket)
  assert.equal(frames.some((frame) => frame.type === 'screen.frame' && String(frame.payload.stage || '').includes('待决策')), false, '绝不能把待决策弹到设备屏')
  assert.equal(frames.some((frame) => frame.type === 'task.notify' && frame.payload.level === 0), false, '不再有 P0 授权播报')
  assert.equal(frames.some((frame) => frame.type === 'confirm.ask'), false, '协议里也没有确认屏了')
  w.cleanup()
})

await testAsync('§13 验收：同一项目连打 10 句，零错派（全落那张卡的文件夹）', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u9', protocol: '0' }, 1)))
  await waitMs(50)
  const sentences = [
    '青年基金申请书第 1 段加一句数据支撑',
    '青年基金的图 3 换成矢量图',
    '把青年基金申请书那节的参考文献补齐',
    '青年基金那边预算表再核一遍',
    '青年基金申请书的摘要压到 300 字',
    '青年基金第 4 段的逻辑要理顺一下',
    '青年基金的创新点写得更具体',
    '青年基金申请书里补一张技术路线图',
    '青年基金那篇的致谢别忘基金号',
    '青年基金申请书再通读一遍改错别字',
  ]
  for (let i = 0; i < sentences.length; i += 1) {
    socket.emit('data', clientFrame(buildUpstream('text.input', { text: sentences[i], source: 'voice' }, i + 2)))
    await waitMs(30)
  }
  await waitMs(150)
  assert.equal(w.created.length, sentences.length, '10 句各派一条任务会话')
  for (const base of w.created) {
    assert.equal(base.cwd, w.fundFolder, '每一句都必须落在青年基金卡的文件夹：' + JSON.stringify(base))
  }
  assert.equal(w.prompted.length, sentences.length, '每句都要真的投进任务会话')
  const board = framesOf(socket).filter((frame) => frame.type === 'task.list').pop()
  assert.ok(board.payload.board.total >= 1)
  w.cleanup()
})

await testAsync('统一指挥：同一句播报第二次走预录，不再合成（P3 缓存命中）', async () => {
  const prerollDir = mkdtempSync(join(tmpdir(), 'tihu-preroll-lane-'))
  const before = process.env.TIHU_PREROLL_DIR
  process.env.TIHU_PREROLL_DIR = prerollDir
  try {
    const synthCalls = []
    const engine = fakeTts()
    const realSynth = engine.synthesize
    engine.synthesize = async (text, options) => {
      synthCalls.push(text)
      return realSynth(text, options)
    }
    // 先往预录里塞一条「这句话已经念过」的 PCM（100ms / 4800 字节）
    const prerollModule = await import('../src/tihu/preroll.ts')
    const seeded = Buffer.alloc(4800)
    const announcementText = '现在几点了——现在十七点三十一分'
    assert.equal(new prerollModule.TihuPreroll(prerollDir).put('default', announcementText, seeded), true)

    const w = unifiedWorkspace({ tts: { instance: engine } })
    const socket = openLane(w.runtime)
    const emit = w.events.find((entry) => entry.name === 'session/event').handler
    socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u10', protocol: '0' }, 1)))
    await waitMs(50)
    socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
    await waitMs(90)
    const taskSession = w.prompted[0].id
    emit({ id: taskSession }, { type: 'turn/start', data: { turn: 1 } })
    emit({ id: taskSession }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '现在十七点三十一分。' }] } } })
    emit({ id: taskSession }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await waitMs(600)
    assert.equal(synthCalls.length, 0, '命中预录就不该再合成：' + JSON.stringify(synthCalls))
    const audio = framesOf(socket).filter((frame) => frame.type === 'tts.audio').pop()
    assert.ok(audio !== undefined, '命中也必须真的把 PCM 发下去')
    assert.equal(Buffer.from(audio.payload.data, 'base64').length, seeded.length, '发下去的就是缓存里那段 PCM')
    assert.equal(audio.payload.sampleRate, 24000)
    assert.equal(audio.payload.final, true)
    w.cleanup()
  } finally {
    if (before === undefined) delete process.env.TIHU_PREROLL_DIR
    else process.env.TIHU_PREROLL_DIR = before
    try { rmSync(prerollDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

/* ---------- 2026-11-09 新增：电脑端（DSH 主 GUI）会话同步上屏 ----------
 *
 * 需求：电脑端新建/运行的会话也要同步到鹈鹕屏，两端状态一致。这一组钉住：
 *   1. 外部会话以 `source='pc'` 的任务上棋盘（p 前缀、副行「电脑端 · 项目名」、三态映射）；
 *   2. 指挥会话、已被派单任务绑定的会话不上第二张卡（避免重复上屏）；
 *   3. 完成时进通知总线/播报，但**绝不**建会话、绝不往任何会话投 prompt、不发派单尾巴；
 *   4. 点卡片走 session.bind 详情，不是派单；
 *   5. 一次 hello 只拉一次会话列表（轮询复用 sessionListTtlMs，不额外狂调 listSessions）。
 */

await testAsync('电脑端会话：外部任务卡上棋盘（p 前缀 / 电脑端副行 / 三态映射）', async () => {
  const now = Date.now()
  const w = unifiedWorkspace({
    records: [
      cuRecord('session-pc-run', { live: true, preset: 'standard', cwd: '/work/论文', createdAt: now - 600_000, lastPromptAt: now - 1000, title: '把第三节的结果补上' }),
      cuRecord('session-pc-idle', { live: true, preset: 'standard', cwd: '/work/磷石膏', createdAt: now - 7_200_000, lastPromptAt: now - 120_000, title: '磷石膏出图' }),
      cuRecord('session-pc-new', { live: true, preset: 'standard', cwd: '/work/新目录', createdAt: now - 5000, title: '新会话' }),
    ],
  })
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pc-board', protocol: '0' }, 1)))
  await waitMs(150)
  const list = framesOf(socket).filter((frame) => frame.type === 'task.list').pop()
  assert.ok(list !== undefined, '棋盘要下发 task.list')
  const rows = list.payload.board.rows
  assert.equal(rows.length, 3, '三条电脑端会话都要上棋盘：' + JSON.stringify(rows))
  assert.equal(rows.every((row) => row.taskId.startsWith('p')), true, '外部任务短号用 p 前缀：' + JSON.stringify(rows.map((row) => row.taskId)))
  // 15 秒内有活动＝执行中；空闲＝完成；刚建没发过话＝排队。
  assert.deepEqual(rows.map((row) => row.state), ['running', 'queued', 'done'])
  assert.deepEqual(rows.map((row) => row.capsule), ['执行中', '排队', '完成'])
  const runningRow = rows[0]
  assert.equal(runningRow.title, '把第三节的结果补上', '标题用会话标题（taskTitleOf 截断）')
  assert.equal(runningRow.sub, '电脑端 · 论文', '副行＝电脑端 + 项目名/目录末段')
  assert.equal(rows[1].sub, '电脑端 · 新目录')
  assert.deepEqual(list.payload.board.counts, { running: 1, awaiting: 0, queued: 1 }, '计入「在跑/排队」计数')
  w.cleanup()
})

await testAsync('电脑端会话：指挥会话与派单会话不重复上屏', async () => {
  const now = Date.now()
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pc-filter', protocol: '0' }, 1)))
  await waitMs(60)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(120)
  // 把派单任务会话伪装成「电脑端刚刚活跃」：若不过滤，它会再上一张电脑端卡片。
  const taskRecord = w.records.find((record) => record.header.id === 'session-task-1')
  assert.ok(taskRecord !== undefined)
  taskRecord.projection.sessionListMetadata.lastPromptAt = Date.now() - 1000
  taskRecord.header.createdAt = now - 600_000
  process.env.TIHU_SESSION_LIST_TTL_MS = '50'
  // 再连一台设备＝再同步一遍（列表缓存已被 TTL 放过期）。
  const second = openLane(w.runtime)
  second.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pc-filter-2', protocol: '0' }, 1)))
  await waitMs(200)
  delete process.env.TIHU_SESSION_LIST_TTL_MS
  const list = framesOf(second).filter((frame) => frame.type === 'task.list').pop()
  const rows = list.payload.board.rows
  assert.equal(rows.length, 1, '只该有派单任务这一张卡：' + JSON.stringify(rows))
  assert.equal(rows[0].taskId, 't1')
  assert.equal(rows.some((row) => row.taskId.startsWith('p')), false, '指挥会话 / 派单会话都不能再上电脑端卡')
  w.cleanup()
})

await testAsync('电脑端会话：turn/end → 完成卡＋一句播报，不建会话、不投 prompt', async () => {
  const now = Date.now()
  const w = unifiedWorkspace({
    records: [cuRecord('session-pc', { live: true, preset: 'standard', cwd: '/work/论文', createdAt: now - 600_000, lastPromptAt: now - 1000, title: '把第三节的结果补上' })],
  })
  const socket = openLane(w.runtime)
  const emit = w.events.find((entry) => entry.name === 'session/event').handler
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pc-done', protocol: '0' }, 1)))
  await waitMs(120)
  assert.equal(framesOf(socket).filter((frame) => frame.type === 'session.bound').pop().payload.sessionId, 'session-cmd')
  const createdBefore = w.created.length
  const promptedBefore = w.prompted.length
  emit({ id: 'session-pc' }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: 'session-pc' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**改好了**，结果在 D:\\dsh-assistant\\src\\tihu\\lane.ts 里，温度场收敛。' }] } } })
  emit({ id: 'session-pc' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(700)
  assert.equal(w.created.length, createdBefore, '电脑端会话完成不许新建会话')
  assert.equal(w.prompted.length, promptedBefore, '电脑端会话完成不许往任何会话投 prompt')
  const note = framesOf(socket).filter((frame) => frame.type === 'task.notify').pop()
  assert.ok(note !== undefined, '完成要进通知总线（屏气泡＋播报）')
  assert.equal(note.payload.level, 1)
  assert.ok(note.payload.text.includes('把第三节的结果补上'), '播报用会话标题：' + note.payload.text)
  assert.ok(note.payload.text.includes('改好了'), '完成摘要取最后一条助手回复：' + note.payload.text)
  assert.equal(note.payload.text.includes('dsh-assistant'), false, '播报里不能念长路径：' + note.payload.text)
  assert.equal(note.payload.text.includes('**'), false, '播报里不能留 markdown：' + note.payload.text)
  // 2026-11-09：完成时设备自动切到完成屏（紧跟 turn/end），棋盘行改用 task.update 下发。
  const doneUpdate = framesOf(socket).filter((frame) => frame.type === 'task.update').pop()
  assert.ok(doneUpdate !== undefined, '完成要下发 task.update（棋盘行状态）')
  assert.equal(doneUpdate.payload.state, 'done')
  assert.equal(doneUpdate.payload.capsule, '完成')
  assert.equal(doneUpdate.payload.sub, '电脑端 · 论文')
  const doneScreen = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && String(frame.payload.stage) === '完成').pop()
  assert.ok(doneScreen !== undefined, '完成要自动进完成屏并开始朗读')
  w.cleanup()
})

await testAsync('电脑端会话：点卡片走 session.bind 详情，不发派单、不建会话', async () => {
  const now = Date.now()
  const w = unifiedWorkspace({
    records: [cuRecord('session-pc', { live: true, preset: 'standard', cwd: '/work/论文', createdAt: now - 600_000, lastPromptAt: now - 1000, title: '把第三节的结果补上' })],
  })
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pc-open', protocol: '0' }, 1)))
  await waitMs(140)
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 40, y: 60, hit: 'task', taskId: 'p1' }, 2)))
  await waitMs(160)
  const frames = framesOf(socket)
  const bound = frames.filter((frame) => frame.type === 'session.bound').pop()
  assert.equal(bound.payload.sessionId, 'session-cmd', '统一指挥永远绑指挥会话：点卡片不换绑')
  assert.equal(frames.some((frame) => String(frame.payload.stage) === '派单'), false, '不许弹派单回执')
  const detail = frames.filter((frame) => frame.type === 'screen.frame' && frame.payload.stage === '进度').pop()
  assert.ok(detail !== undefined, '电脑端卡片打开＝屏 4 进度详情：' + JSON.stringify(frames.filter((f) => f.type === 'screen.frame').map((f) => f.payload.stage)))
  assert.equal(detail.payload.tone, 'busy')
  assert.ok(detail.payload.actions.some((item) => item.id === 'taskBoard'), '详情要能回棋盘')
  assert.equal(frames.some((frame) => frame.type === 'event.alert' && frame.payload.level === 'error'), false)
  assert.equal(w.created.length, 0, '看电脑端会话不建会话')
  assert.equal(w.prompted.length, 0, '看电脑端会话不投 prompt')
  // 点「回棋盘」（详情屏的按钮）回到棋盘
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 20, y: 200, hit: 'action', actionId: 'taskBoard' }, 3)))
  await waitMs(120)
  const board = framesOf(socket).filter((frame) => frame.type === 'screen.frame' && frame.payload.board).pop()
  assert.ok(board !== undefined, '「回棋盘」要能回到棋盘')
  w.cleanup()
})

await testAsync('电脑端同步：一次 hello 只拉一次会话列表（复用 sessionListTtlMs，不额外狂调）', async () => {
  const now = Date.now()
  const records = [
    cuRecord('session-cmd', { live: true, preset: 'standard', title: '鹈鹕指挥台' }),
    cuRecord('session-pc-run', { live: true, preset: 'standard', cwd: '/work/论文', createdAt: now - 600_000, lastPromptAt: now - 1000, title: '把第三节的结果补上' }),
  ]
  const base = sessionQueryFixture(records)
  let listCalls = 0
  const sessionQuery = { ...base, listSessions: async () => { listCalls += 1; return base.listSessions() } }
  const { runtime } = runtimeFor(records, { sessionQuery })
  const socket = openLane(runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pc-throttle', protocol: '0' }, 1)))
  await waitMs(150)
  assert.equal(listCalls, 1, 'hello 里的指挥会话定位与电脑端同步共用同一次列表请求，实际 ' + listCalls + ' 次')
  const rows = framesOf(socket).filter((frame) => frame.type === 'task.list').pop().payload.board.rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].taskId, 'p1')
  runtime.dispose()
})

await testAsync('电脑端会话：超过 3 天没活动就不上屏；已在屏上的随后自动归档下屏', async () => {
  const now = Date.now()
  const w = unifiedWorkspace({
    records: [
      // 刚活跃的：要上屏
      cuRecord('session-pc-live', { live: true, preset: 'standard', cwd: '/work/论文', createdAt: now - 600_000, lastPromptAt: now - 1000, title: '把第三节的结果补上' }),
      // 4 天没活动的：不许进登记簿（活动时间＝max(createdAt, lastPromptAt)）
      cuRecord('session-pc-stale', { live: true, preset: 'standard', cwd: '/work/旧项目', createdAt: now - 8 * 24 * 3600_000, lastPromptAt: now - 4 * 24 * 3600_000, title: '四天前的会话' }),
    ],
  })
  const socket = openLane(w.runtime)
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pc-window', protocol: '0' }, 1)))
  await waitMs(150)
  let rows = framesOf(socket).filter((frame) => frame.type === 'task.list').pop().payload.board.rows
  assert.equal(rows.length, 1, '只有窗口内的会话上屏：' + JSON.stringify(rows))
  assert.equal(rows[0].title, '把第三节的结果补上')
  // 让这条已经在屏上的任务也变老（4 天没活动），下一次轮询要把它归档下屏。
  const liveRecord = w.records.find((record) => record.header.id === 'session-pc-live')
  liveRecord.projection.sessionListMetadata.lastPromptAt = now - 4 * 24 * 3600_000
  process.env.TIHU_SESSION_LIST_TTL_MS = '50'
  const second = openLane(w.runtime)
  second.emit('data', clientFrame(buildUpstream('hello', { clientId: 'pc-window-2', protocol: '0' }, 1)))
  await waitMs(220)
  delete process.env.TIHU_SESSION_LIST_TTL_MS
  const board = framesOf(second).filter((frame) => frame.type === 'task.list').pop().payload.board
  assert.equal(board.rows.length, 0, '静置超过 3 天的外部任务要下屏：' + JSON.stringify(board.rows))
  assert.equal(board.empty, true)
  w.cleanup()
})

/* ---------- 2026-11-10：棋盘 4 条 / 状态点 / 完成页三键 / 进度页实时 ---------- */

test('page：棋盘右侧是小状态点（10px），不再有大圆环/问号徽标', () => {
  const html = pageHtmlOf()
  assert.ok(/#screen \.board-dot \{[^}]*width:10px/.test(html), '状态点 10px')
  assert.ok(/#screen \.board-dot \{[^}]*margin-right:2px/.test(html), '点右缘离屏幕边 10px（8px 内边距 + 2px）')
  assert.ok(html.includes('.board-dot.running') && html.includes('.board-dot.awaiting') && html.includes('.board-dot.done'), '三种状态都有颜色')
  assert.equal(html.includes('board-ring'), false, '不再画大圆环')
  assert.equal(html.includes('board-ask'), false, '不再画问号徽标')
})

test('page：完成页三键可见（has-actions 有 display:flex 规则）＋ 7 行正文高度预算', () => {
  const html = pageHtmlOf()
  assert.ok(/#screen\.has-actions \.action-bar \{ display:flex; \}/.test(html), '有按钮时动作条必须显示（缺这条 → 完成页三键消失）')
  assert.ok(/#screen\.done-mode \.action-bar \{ display:flex; flex:none; height:30px/.test(html), '完成页三键高 30px')
  assert.ok(/#screen \.done-title \{[^}]*font-size:22px/.test(html), '任务名大标题 22px')
  assert.ok(/#screen \.done-line\.cur \{ background:#5FD2C8/.test(html), '当前朗读行青底反白')
  const used = DONE_LAYOUT.stageHeightPx + DONE_LAYOUT.titleHeightPx + DONE_LAYOUT.bodyHeightPx
    + DONE_LAYOUT.actionBarHeightPx + DONE_LAYOUT.columnGapPx * 3
  assert.ok(used <= 240 - 2 * 8 - 2, `完成页总高 ${used}px 不得超过 222px`)
  assert.equal(DONE_LAYOUT.visibleLines, 7)
})

await testAsync('统一指挥：点已完成卡片 → 立刻进完成页（三键，不派单）', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  const emit = w.events.find((entry) => entry.name === 'session/event').handler
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u-done-open', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '现在几点了', source: 'voice' }, 2)))
  await waitMs(90)
  const taskSession = w.prompted[0].id
  emit({ id: taskSession }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: taskSession }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '现在十七点三十一分。' }] } } })
  emit({ id: taskSession }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitMs(80)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '回棋盘', source: 'voice' }, 3)))
  await waitMs(60)
  const created = w.created.length
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 40, y: 60, hit: 'task', taskId: 't1' }, 4)))
  await waitMs(60)
  const frame = framesOf(socket).filter((item) => item.type === 'screen.frame').pop()
  assert.equal(frame.payload.stage, '完成', '完成卡片点开＝完成页：' + JSON.stringify(frame.payload.stage))
  assert.equal(frame.payload.title, '现在几点了', '大标题是任务名')
  assert.deepEqual(frame.payload.actions.map((item) => item.label), ['停止', '重读', '主页'])
  assert.ok(Array.isArray(frame.payload.done?.lines) && frame.payload.done.lines.length > 0)
  assert.equal(w.created.length, created, '点完成卡不派单')
  w.cleanup()
})

await testAsync('统一指挥：进度页实时——工具调用替换最新一行、步数跟着走、已用每秒刷新', async () => {
  const w = unifiedWorkspace()
  const socket = openLane(w.runtime)
  const emit = w.events.find((entry) => entry.name === 'session/event').handler
  socket.emit('data', clientFrame(buildUpstream('hello', { clientId: 'u-live', protocol: '0' }, 1)))
  await waitMs(50)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '把第三节的结果补上', source: 'voice' }, 2)))
  await waitMs(90)
  socket.emit('data', clientFrame(buildUpstream('text.input', { text: '回棋盘', source: 'voice' }, 3)))
  await waitMs(60)
  const taskSession = w.prompted[0].id
  emit({ id: taskSession }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: taskSession }, { type: 'step/start', data: { turn: 1, step: 2 } })
  socket.emit('data', clientFrame(buildUpstream('screen.gesture', { action: 'tap', x: 40, y: 60, hit: 'task', taskId: 't1' }, 4)))
  await waitMs(80)
  emit({ id: taskSession }, { type: 'tool/call', data: { step: 3, name: 'click', arguments: '{"screen_index":0,"position":{"x":40,"y":60}}' } })
  await waitMs(60)
  let frame = framesOf(socket).filter((item) => item.type === 'screen.frame' && item.payload.stage === '进度').pop()
  assert.ok(frame !== undefined, '要停在进度页')
  assert.ok(String(frame.payload.bullets[0]).startsWith('工具调用 · click · {"screen_index":0'), '最新状态行原样：' + frame.payload.bullets[0])
  assert.equal(frame.payload.bullets[1], '第 3 步 · 已用 0s', '步数跟事件递增：' + frame.payload.bullets[1])
  const elapsedBefore = frame.payload.bullets[1]
  await waitMs(1150)
  frame = framesOf(socket).filter((item) => item.type === 'screen.frame' && item.payload.stage === '进度').pop()
  assert.notEqual(frame.payload.bullets[1], elapsedBefore, '已用每秒实时走（不能停在 0s）：' + frame.payload.bullets[1])
  emit({ id: taskSession }, { type: 'assistant/message', data: { message: { content: [{ type: 'thinking', thinking: 'User: "补结果" lane.ts' }] } } })
  await waitMs(60)
  frame = framesOf(socket).filter((item) => item.type === 'screen.frame' && item.payload.stage === '进度').pop()
  assert.ok(String(frame.payload.bullets[0]).startsWith('思考 · User: "补结果" lane.ts'), '思考行原样（不过滤英文/路径）：' + frame.payload.bullets[0])
  w.cleanup()
})

/* ---------- 汇总 ---------- */console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failed}`)
if (failed > 0) process.exit(1)
process.exit(0)
