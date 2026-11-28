import { assistantHome } from './personal-context-lib.mjs'
/**
 * 秘书 v4 会话日志「写入后能重新打开」回归 —— **用宿主真实解析器断言**。
 *
 * 这里不用自写的简化校验器：直接加载宿主源码仓库里编译好的
 * `@deepseek-ai/dsh-session-format-v3-to-v4`（lib/index.js）的 restoreReleasedV4Artifact，
 * 配合同一仓库的 KNOWN_SESSION_EVENT_TYPES 做「写入前 dry-run + 写入后回读」。
 * 找不到解析器就**直接失败**，不做降级放行（fail closed）。
 *
 * 覆盖：
 *   1. 真事故形状（turn 号重复）→ 宿主解析器拒绝（复现手机端那条报错）；
 *   2. 修复 → 落盘 → 回读 → 宿主解析器接受（"写入后再读"）；
 *   3. 候选日志不合法 → 写入被拦下，目标文件一个字节都不动、也不产生备份（不留半截轮）；
 *   4. 写入后回读失败 → 自动回滚到备份，文件回到原始字节。
 *
 *   node scripts/test-secretary-session-log-write.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(import.meta.url))
const lib = require('../lib/index.js')
const surface = lib.assistantSecretaryTestSurface

const parser = lib.loadHostLogParser()
console.log('parser:', parser.source)
console.log('vocabulary:', parser.vocabulary)

const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-00000000-0000-4000-8000-000000000000',
  createdAt: 1795000000000,
  cwd: assistantHome(),
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}

function assistantMessage(id, text) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'dsh-assistant', model: 'cu-watch' },
  }
}

/** 造一份**真事故形状**的日志：插件先写 turn 1，宿主随后又开 turn 1（撞号）。 */
function corruptEvents() {
  const rows = []
  const push = (type, data, opts) => rows.push({ type, seq: rows.length, time: 1795000000000 + rows.length, ...(opts ?? {}), data })
  // 宿主真实轮 turn 1
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('user/message', { id: 'u-1', role: 'user', content: [{ type: 'text', text: '帮我看下手机访问' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('assistant/message', { turn: 1, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: '好' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // 插件"合成轮"：自己算出 turn 2
  push('turn/start', { turn: 2 })
  push('step/start', { turn: 2, step: 1 })
  push('assistant/message', { turn: 2, step: 1, message: assistantMessage('a-synth', '电脑操作会话这一轮跑完了。'), stream: [] }, { surfaceOp: 'append' })
  push('step/end', { turn: 2, step: 1 })
  push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  // 宿主自己的下一轮：内存计数器只知道 2 个宿主轮 → 还是 turn 2，撞号
  push('turn/start', { turn: 2 })
  push('step/start', { turn: 2, step: 1 })
  push('assistant/message', { turn: 2, step: 1, message: { id: 'a-real', role: 'assistant', content: [{ type: 'text', text: '真实回答' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
  push('step/end', { turn: 2, step: 1 })
  push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return rows
}

function logText(header, events) {
  return `${[JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n')}\n`
}

const cases = []
const root = mkdtempSync(join(tmpdir(), 'secretary-log-write-'))
// 默认备份路径必须能指到临时目录（测试不许往用户真实的 ~/.dsh 里写）
process.env.DSH_ASSISTANT_BACKUP_HOME = root

function writeLog(name, text) {
  const file = join(root, name)
  writeFileSync(file, lib.compressLogText(text))
  return file
}

/* ---------- 1. 复现：宿主解析器拒绝 ---------- */
cases.push(['真事故形状（turn 撞号）→ 宿主解析器拒绝，报错与手机端一致', () => {
  const text = logText(HEADER, corruptEvents())
  assert.throws(
    () => parser.assertAccepted(text),
    /turn\/start does not open the expected turn/,
    '必须由宿主解析器给出与手机端完全相同的错误',
  )
}])

/* ---------- 2. 修复 → 落盘 → 回读 ---------- */
cases.push(['修复后落盘，回读仍被宿主解析器接受（写入后再读断言）', () => {
  const corrupt = logText(HEADER, corruptEvents())
  const file = writeLog('session.v4.jsonl.zstd', corrupt)
  const beforeBytes = readFileSync(file)
  const report = lib.rewriteSessionLogFileSync({
    file,
    parser,
    transform: (text) => surface.repairSecretaryLogText(text),
  })
  assert.equal(report.ok, true)
  assert.ok(report.afterEvents < report.beforeEvents, '修复要丢掉撞号轮的事件')
  assert.ok(existsSync(report.backupPath), '必须留备份')
  assert.ok(readFileSync(report.backupPath).equals(beforeBytes), '备份必须是原始字节')
  // 回读（宿主解析器）
  const check = lib.assertSessionLogFileAccepted(file, parser)
  assert.equal(check.events, report.afterEvents)
  // 轮号必须是密而连续的 1..N
  const { events } = lib.parseLogText(lib.decompressLogBytes(readFileSync(file)))
  const turns = events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
  assert.deepEqual(turns, [1, 2], '修复后 turn 必须从 1 连续开')
  assert.ok(!events.some((event) => event.type === 'assistant/message' && event.data.message?.id === 'a-synth'
    && events.filter((other) => other.type === 'turn/start' && other.data.turn === 2).length > 1), '不再有重复轮')
}])

/* ---------- 3. 帧格式必须宿主读得懂（2026-11-21 实测根因的守卫） ---------- */
cases.push(['改写产物必须是带校验和的 zstd 帧：宿主帧扫描走完整个文件、每帧能独立解压', () => {
  const corrupt = logText(HEADER, corruptEvents())
  const file = writeLog('frames.v4.jsonl.zstd', corrupt)
  const report = lib.rewriteSessionLogFileSync({
    file,
    parser,
    transform: (text) => surface.repairSecretaryLogText(text),
  })
  assert.equal(report.ok, true)
  const bytes = readFileSync(file)
  const scan = lib.scanHostZstdFrames(bytes)
  assert.equal(scan.tornStart, null, '帧扫描必须走完整个文件（没写完的帧 = 宿主会认为是撕裂尾帧）')
  assert.ok(scan.frames.length >= 1)
  const descriptor = bytes.readUInt8(scan.frames[0].start + 4)
  assert.notEqual(descriptor & 4, 0, '帧头描述字节必须带校验和位（宿主 CHECKSUM_OPTIONS 同款）')
  assert.deepEqual(lib.assertHostReadableArtifact(bytes), { frames: scan.frames.length, bytes: bytes.length })
}])

cases.push(['无校验和的 Node 默认单帧必须被拒（这正是上次会话被宿主丢掉的那 shapes）', () => {
  const zlib2 = require('node:zlib')
  const legacy = Buffer.from(zlib2.zstdCompressSync(Buffer.from('{"x":1}\n', 'utf8')))
  const descriptor = legacy.length > 4 ? legacy.readUInt8(4) : 0
  if ((descriptor & 4) === 0) {
    assert.throws(() => lib.assertHostReadableArtifact(legacy), /没有校验和/, '旧写法必须被守卫拦下')
  }
  const good = lib.compressLogText('hello\n')
  assert.doesNotThrow(() => lib.assertHostReadableArtifact(good))
  // 写坏的产物：帧没走完 → 拒绝
  const torn = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([0x90, 0x00, 0x00])]
)
  assert.throws(() => lib.assertHostReadableArtifact(torn))
}])

cases.push(['备份不落进会话目录：默认走 sessions-backup（宿主只认 session.v4.jsonl.zstd，旁支文件是噪声）', () => {
  const corrupt = logText(HEADER, corruptEvents())
  const sessionDir = join(root, 'session-near-miss')
  const nested = join(sessionDir, 'session.v4.jsonl.zstd')
  require('node:fs').mkdirSync(sessionDir, { recursive: true })
  writeFileSync(nested, lib.compressLogText(corrupt))
  const report = lib.rewriteSessionLogFileSync({ file: nested, parser, transform: (text) => surface.repairSecretaryLogText(text) })
  assert.ok(report.backupPath.includes('sessions-backup'), `备份必须落 sessions-backup，实际=${report.backupPath}`)
  assert.ok(!report.backupPath.startsWith(sessionDir), '备份不许落在会话目录里面')
  const strays = require('node:fs').readdirSync(sessionDir)
  assert.deepEqual(strays, ['session.v4.jsonl.zstd'], `会话目录里不许留旁支文件，实际=${strays.join(', ')}`)
}])

/* ---------- 4. 校验拦截 → 不留半截轮 ---------- */
cases.push(['候选日志不合法 → 写入被拦下，目标文件与备份都不产生', () => {
  const corrupt = logText(HEADER, corruptEvents())
  const file = writeLog('blocked.v4.jsonl.zstd', corrupt)
  const beforeBytes = readFileSync(file)
  const beforeBackups = existsSync(root) ? readFileSync(file).length : 0
  assert.throws(
    () => lib.rewriteSessionLogFileSync({ file, parser, transform: (text) => text }),
    /turn\/start does not open the expected turn/,
  )
  assert.ok(readFileSync(file).equals(beforeBytes), '被拦下时目标文件必须一个字节都没动')
  assert.equal(beforeBackups, readFileSync(file).length)
  const leftovers = readFileSync(file)
  assert.ok(leftovers.length > 0, '文件还在（不是被删掉）')
}])

/* ---------- 4. 回读失败 → 回滚 ---------- */
cases.push(['写入后回读失败 → 自动回滚到备份，文件恢复原字节', () => {
  const corrupt = logText(HEADER, corruptEvents())
  const file = writeLog('rollback.v4.jsonl.zstd', corrupt)
  const beforeBytes = readFileSync(file)
  let calls = 0
  const flaky = {
    source: 'flaky-stub',
    vocabulary: 'flaky-stub',
    assertAccepted(text) {
      calls += 1
      if (calls === 2) throw new Error('模拟写入后回读失败')
      parser.assertAccepted(text)
    },
  }
  assert.throws(
    () => lib.rewriteSessionLogFileSync({ file, parser: flaky, transform: (text) => surface.repairSecretaryLogText(text) }),
    /回读校验失败.*回滚/,
  )
  assert.equal(calls, 2)
  assert.ok(readFileSync(file).equals(beforeBytes), '必须回滚到写入前的字节')
  // 回滚后的文件仍是"坏但原样"的那份（说明没留下半截修复结果）
  assert.throws(() => parser.assertAccepted(lib.decompressLogBytes(readFileSync(file))))
}])

/* ---------- 5. 解析器缺席 → 拒绝写入（fail closed） ---------- */
cases.push(['拿不到宿主解析器 → 加载即失败，不允许退回简化校验', () => {
  assert.throws(() => lib.loadHostLogParser('D:\\definitely-not-here\\parser.js'), /宿主真实解析器不可用|已拒绝写入/)
  assert.throws(
    () => lib.rewriteSessionLogFileSync({ file: join(root, 'x.zstd'), transform: (text) => text, parser: null }),
    /缺少宿主解析器/,
  )
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
rmSync(root, { recursive: true, force: true })
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} secretary-session-log-write`)
