import { assistantHome, dshRoot } from './personal-context-lib.mjs'
/**
 * turn-guard 日志落盘的轮转与「只落标识」回归：node scripts/test-turn-guard-log-rotation.mjs
 *
 * 固定这几条边界（第 3 步日志整改）：
 *   - 日志文件超过 MAX_LOG_BYTES 会轮转到 `.1`，写它的下一次追加先 statSync 再决定；
 *   - 只留 1 份历史（每次轮转覆写同一个 `.1`，不堆 `.2`）；
 *   - 轮转之后文件大小低于阈值；轮转失败/写不出去都不抛（诊断不该让插件崩）；
 *   - 插件加载口径：现存的大日志在写第一行新日志之前就被归档（rotate 先于 append）；
 *   - 日志行只有标识：turn 号、会话标识、判据分支名、预设名、阈值数字、正文字符数；
 *     不落回复正文片段、不落本机绝对路径（盘符路径与 \Users\ 形态一律掩成 <path>）；
 *   - 既有判定行为（installTurnGuard 补步/跳过）没被改形。
 * 隔离风格照抄仓库既有测试：mkdtempSync + 临时目录，绝不往用户真实的 ~/.dsh 写。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_LOG_BYTES,
  MAX_LOG_LINE_CHARS,
  appendTurnGuardLog,
  installTurnGuard,
  rotateTurnGuardLog,
  sanitizeTurnGuardLine,
  sessionIdOf,
} from '../src/turn-guard.ts'

const root = mkdtempSync(join(tmpdir(), 'turn-guard-log-rotation-'))
const logFile = join(root, 'dsh-assistant-turn-guard.log')
const archiveFile = `${logFile}.1`

/** 造一条会话夹具（照 test-turn-guard.mjs 的形状），带 id 与预设名。 */
function sessionOf(events, extra = {}) {
  return { snapshotEvents: () => events, ...extra }
}
const assistantEvent = (blocks) => ({ type: 'assistant/message', data: { message: { content: blocks } } })
const textBlock = (text) => ({ type: 'text', text })
const reasoningBlock = (text) => ({ type: 'reasoning', text })

const stateOf = (over = {}) => ({ enabled: true, presets: ['*'], maxPerTurn: 3, steerEmptyText: true, revision: 0, updatedAt: '', ...over })

/** 挂一个把日志真写进临时文件的 guard（走真实落盘口径，不只是收集字符串）。 */
function mountedFileBacked(file, initialState = {}) {
  const handlers = new Map()
  const ctx = {
    handlers,
    on(event, callback) {
      handlers.set(event, callback)
      return () => { handlers.delete(event) }
    },
  }
  let state = stateOf(initialState)
  const dispose = installTurnGuard(ctx, {
    readState: () => state,
    log: (line) => { appendTurnGuardLog(file, line) },
  })
  const turnStopping = (session, turn = 1) => {
    ctx.handlers.get('agent/turn-stopping')({
      turn,
      agent: {
        session,
        send(message, kind, internal) {
          if (typeof state.sendHook === 'function') state.sendHook({ message, kind, internal })
        },
      },
    })
  }
  return { ctx, dispose, turnStopping, setState: (next) => { state = next } }
}

const cases = []

cases.push(['阈值常量：MAX_LOG_BYTES = 200 KB（本机那份实测 >1 MB 的存量就是照它轮转的）', () => {
  assert.equal(MAX_LOG_BYTES, 200 * 1024, '轮转阈值就是 200 * 1024')
}])

cases.push(['低于阈值不轮转：小日志原样留着', () => {
  writeFileSync(logFile, 'verdict turn=1 steer=false branch=text-ok\n', 'utf8')
  assert.equal(rotateTurnGuardLog(logFile), false, '没超阈值不轮转')
  assert.ok(existsSync(logFile), '原文件还在')
  assert.ok(!existsSync(archiveFile), '不该有归档件')
  rmSync(logFile, { force: true })
}])

cases.push(['超阈值轮转成 .1：原件不再存在、归档件留着原字节', () => {
  const stock = `${'x'.repeat(MAX_LOG_BYTES + 1)}\n`
  writeFileSync(logFile, stock, 'utf8')
  const beforeBytes = statSync(logFile).size
  assert.ok(beforeBytes > MAX_LOG_BYTES, '先造出「比阈值大」的存量')
  assert.equal(rotateTurnGuardLog(logFile), true, '超阈值必须轮转')
  assert.ok(!existsSync(logFile), '原件被轮转走（不是复制一份留原地）')
  assert.equal(statSync(archiveFile).size, beforeBytes, '归档件字节 = 轮转前的字节')
  assert.equal(rotateTurnGuardLog(logFile), false, '原件不在了，statSync 失败就静默返回 false（不抛）')
  rmSync(archiveFile, { force: true })
}])

cases.push(['本机那种 1 MB 存量的归档尺寸：1055303 字节那份被整份归档', () => {
  const stock = Buffer.alloc(1055303, 0x61)
  writeFileSync(logFile, stock)
  assert.equal(rotateTurnGuardLog(logFile), true)
  assert.equal(statSync(archiveFile).size, 1055303, '存量字节数原样落进归档件')
  rmSync(archiveFile, { force: true })
}])

cases.push(['只留 1 份历史：连续轮转不堆 .2/.3，归档件被覆写', () => {
  writeFileSync(logFile, Buffer.alloc(MAX_LOG_BYTES + 10, 0x62))
  assert.equal(rotateTurnGuardLog(logFile), true)
  writeFileSync(logFile, Buffer.alloc(MAX_LOG_BYTES + 20, 0x63))
  assert.equal(rotateTurnGuardLog(logFile), true)
  const names = readdirSync(root)
  assert.equal(names.filter((name) => name.endsWith('.1')).length, 1, '只有一份 .1')
  assert.equal(names.some((name) => /turn-guard\.log\.[2-9]/.test(name)), false, '不许多出 .2/.3 之类的历史')
  assert.equal(readFileSync(archiveFile, 'utf8')[0], 'c', '归档件是最近那次轮转的内容（旧的被覆写掉）')
  assert.equal(statSync(archiveFile).size, MAX_LOG_BYTES + 20)
  rmSync(archiveFile, { force: true })
}])

cases.push(['写前先 statSync：appendTurnGuardLog 自己就把超阈值的存量轮走，写出的新文件低于阈值', () => {
  writeFileSync(logFile, Buffer.alloc(MAX_LOG_BYTES + 5, 0x64))
  const beforeBytes = statSync(logFile).size
  assert.equal(appendTurnGuardLog(logFile, 'verdict turn=99 steer=false branch=cap injected=3/3 maxPerTurn=3'), true)
  assert.ok(existsSync(archiveFile), '旧存量被轮转到 .1')
  assert.equal(statSync(archiveFile).size, beforeBytes)
  assert.ok(statSync(logFile).size < MAX_LOG_BYTES, '轮转后新日志大小低于阈值')
  const fresh = readFileSync(logFile, 'utf8')
  assert.ok(fresh.includes('verdict turn=99'), '新行写进去了')
  assert.ok(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}(\.[0-9]+)?Z \[pid [0-9]+\] /.test(fresh.split('\n')[0]), '行首还是 ISO 时间戳 + [pid N] 的形状')
  rmSync(logFile, { force: true })
  rmSync(archiveFile, { force: true })
}])

cases.push(['写入不抛错：目录不存在 / 路径不可写时只返回 false（诊断写不出去也不该让插件崩）', () => {
  const missing = join(root, 'nope', 'dsh-assistant-turn-guard.log')
  assert.equal(appendTurnGuardLog(missing, 'load: v1.1.0 enabled=true'), false, '写不进就返回 false')
  assert.throws(() => statSync(missing), /ENOENT|no such file|cannot be stat/, '确实没写成（不是抛出来的）')
  const bad = join(root, 'a-file', 'sub', 'x.log')
  writeFileSync(join(root, 'a-file'), 'not-a-dir', 'utf8')
  assert.equal(appendTurnGuardLog(bad, 'steer turn=1'), false, '父级是个文件时也不抛')
  assert.equal(rotateTurnGuardLog(bad), false)
  rmSync(join(root, 'a-file'), { force: true })
}])

cases.push(['日志行只有标识：不落回复正文片段、不落本机绝对路径', () => {
  const secretBody = '这一段是助手回复正文，日志里不许出现它'
  const localPath = dshRoot() + '\\dsh-assistant-turn-guard.json'
  assert.equal(sanitizeTurnGuardLine(secretBody), secretBody, '纯标识（无路径）原样保留')
  const masked = sanitizeTurnGuardLine(`状态文件 ${localPath}（档位 desktop）`)
  assert.ok(!/[A-Za-z]:[\\/]/.test(masked), '盘符绝对路径必须被掩掉')
  assert.ok(!masked.includes('Users'), 'Users 目录形态也被掩掉')
  assert.ok(masked.includes('状态文件') && masked.includes('档位'), '标识本身留着')
  const unc = sanitizeTurnGuardLine('读 D:/deepseek-harness/resources/app.asar/dsh/lib 失败')
  assert.ok(!/[A-Za-z]:[\\/]/.test(unc), '正斜杠形态的盘符路径也要掩')
  const flattened = sanitizeTurnGuardLine('第一行\n第二行\r\n第三行')
  assert.ok(!flattened.includes('\n'), '多行被压成一行（别把整段落盘）')
  const long = sanitizeTurnGuardLine('x'.repeat(5000))
  assert.ok(long.length <= MAX_LOG_LINE_CHARS + 3, `超 MAX_LOG_LINE_CHARS 截断（最多 ${String(MAX_LOG_LINE_CHARS)} + 3 个点）`)
  assert.ok(long.length < 5000)
  assert.ok(long.endsWith('...'), '截断标记在尾巴')
  assert.equal(sessionIdOf({ id: 'session-83bca3e3' }, {}), 'session-83bca3e3', '会话标识取 id')
  assert.equal(sessionIdOf(undefined, { sessionId: 'session-abc' }), 'session-abc', 'payload 上带 sessionId 也能拿到')
  assert.equal(sessionIdOf(undefined, undefined), '?', '拿不到就写 ?（绝不落标题或正文）')
}])

cases.push(['真落盘口径：verdict / steer 行的字段照旧、正文与路径都不出现', () => {
  const file = join(root, 'real-lines.log')
  const guard = mountedFileBacked(file, {})
  const bodyMarker = '助手回复正文里的敏感片段'
  guard.turnStopping(sessionOf([assistantEvent([textBlock(bodyMarker)])], { id: 'session-1111aaaa' }), 1)
  guard.turnStopping(sessionOf([assistantEvent([reasoningBlock('只有思考'), textBlock('')])], { id: 'session-2222bb' }), 2)
  guard.turnStopping(sessionOf([assistantEvent([textBlock('<tool_call>\n</function>')])], { id: 'session-3333cc' }), 3)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  assert.ok(lines.length >= 3, `每轮决策都得有一行 verdict：${String(lines.length)}`)
  assert.ok(lines.some((line) => line.includes('verdict turn=1') && line.includes('branch=text-ok') && line.includes('session=session-1111aaaa') && line.includes('textChars=')), 'verdict 行标识齐')
  assert.ok(lines.some((line) => line.includes('branch=empty') && line.includes('steer=true') && line.includes('session=session-2222bb')), '补步判定也写 verdict 行')
  assert.ok(lines.some((line) => line.includes('steer turn=3') && line.includes('reason=leak') && line.includes('injected=1/3') && line.includes('session=session-3333cc')), 'steer 行只落标识')
  assert.ok(!text.includes(bodyMarker), '正文片段不落盘（会话日志里已经有它了）')
  assert.ok(!text.includes('tool_call'), '连判据引用的标记都不落')
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), '没有盘符绝对路径')
  assert.ok(!text.includes('Users'), '没有 Users 目录形态')
  guard.dispose()
  rmSync(file, { force: true })
}])

cases.push(['预设名与阈值数字进日志、开关关闭也留一行 verdict', () => {
  const file = join(root, 'preset-skip.log')
  const guard = mountedFileBacked(file, { presets: ['computer-use'], maxPerTurn: 5 })
  guard.turnStopping(sessionOf([assistantEvent([textBlock('<tool_call>')])], { header: { agentPreset: 'standard' }, id: 'session-std1' }), 4)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('branch=preset-skip') && text.includes('preset=standard') && text.includes('allowed=[computer-use]') && text.includes('maxPerTurn=5'), '预设名与名单与阈值数字都留着')
  assert.ok(text.includes('session=session-std1'), '会话标识留着')
  guard.setState(stateOf({ enabled: false }))
  guard.turnStopping(sessionOf([assistantEvent([textBlock('<tool_call>')])], { id: 'session-off1' }), 5)
  const again = readFileSync(file, 'utf8')
  assert.ok(again.includes('verdict turn=5') && again.includes('branch=disabled') && again.includes('session=session-off1'), '开关关闭也要写 verdict 行')
  guard.dispose()
  rmSync(file, { force: true })
}])

cases.push(['错误行也不再带堆栈：steer 失败只落错误种类与清洗过的消息', () => {
  const file = join(root, 'steer-failed.log')
  const guard = mountedFileBacked(file, {})
  // 用 sendHook 造一次失败：agent.send 抛错（消息里塞本机绝对路径，路径尾巴里带着正文字样）
  const broken = stateOf()
  broken.sendHook = () => {
    throw new Error('宿主拒绝写入 ' + assistantHome() + '\\正文片段XYZ.json')
  }
  guard.setState(broken)
  guard.turnStopping(sessionOf([assistantEvent([textBlock('<tool_call>')])], { id: 'session-fail1' }), 6)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('steer failed kind=Error'), '失败行只落错误种类与消息')
  assert.ok(text.includes('宿主拒绝写入'), '消息中可读的部分留着（便于核对是哪个环节失败）')
  assert.ok(text.includes('<path>'), '路径被掩成 <path>')
  assert.ok(!text.includes('正文片段XYZ'), '路径尾巴里的正文字样没落盘')
  assert.equal(/at\s+[A-Za-z]/.test(text), false, '没有堆栈帧（堆栈里全是本机路径）')
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), '错误消息里的盘符路径被掩掉')
  assert.ok(!text.includes('secret.json') && !text.includes('assistant'), '路径本体与尾巴都不剩')
  assert.ok(text.includes('session=session-fail1'), '会话标识仍在')
  guard.dispose()
  rmSync(file, { force: true })
}])

cases.push(['写满阈值会自动轮转：连写多轮也不许把文件推过阈值', () => {
  const file = join(root, 'rotation-while-running.log')
  const guard = mountedFileBacked(file, {})
  const session = sessionOf([assistantEvent([textBlock('<tool_call>')])], { id: 'session-loop' })
  for (let turn = 1; turn <= 4000; turn += 1) guard.turnStopping(session, turn)
  const size = statSync(file).size
  assert.ok(size < MAX_LOG_BYTES, `日志文件必须留在阈值以内（实际 ${String(size)}）`)
  assert.ok(existsSync(`${file}.1`), '途中自动轮转过一次')
  assert.ok(statSync(`${file}.1`).size > MAX_LOG_BYTES, '归档件就是超限那份')
  const names = readdirSync(root).filter((name) => name === 'rotation-while-running.log.1')
  assert.equal(names.length, 1, '还是只有 1 份历史')
  guard.dispose()
  rmSync(file, { force: true })
  rmSync(`${file}.1`, { force: true })
}])

let failed = 0
for (const item of cases) {
  try {
    await item[1]()
    console.log('  ok   ' + item[0])
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + item[0] + '\n       ' + (error && error.message ? error.message : String(error)))
  }
}
console.log(failed === 0 ? 'PASS ' + String(cases.length) + '/' + String(cases.length) : 'FAIL ' + String(failed) + '/' + String(cases.length))
rmSync(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
