/**
 * 单测：Computer Use 坐标硬门（src/cu-coordinate.ts + src/cu-coordinate-gate.ts）
 *   node scripts/test-cu-coordinate-gate.mjs
 *
 * 固定这几条边界（2026-11-28 用户新规则）：
 *   - 解析器算式正确：bbox 中心、0–1000 分数、harness 预测落点；
 *   - 分数换算回来落在 bbox 外时直接报 miss、偏差像素与建议分数；
 *   - pre-execute 对没有 coordinate_record 的点击给 missing-coordinate-record；
 *   - pre-execute 对落在 bbox 外的 position 给 coordinate-out-of-bounds（带建议分数）；
 *   - post-execute 用 Pointer landed at [x, y] 判命中/未命中；同一目标连续 2 次 miss
 *     必须引导改用非坐标手段（导航 URL / Tab-Enter / 读页面文本链接）；
 *   - 日志沿用 sanitizeTurnGuardLine 掩码与 MAX_LOG_BYTES 轮转；日志行带 textChars=、
 *     不带 text=" / 目标文本 / 本机绝对路径；
 *   - 解析器与两份档案的新小节不出现个人化标识、退役仓库名与已作废旧口令字面串。
 *
 * 隔离：记录与日志全部写 mkdtempSync 临时目录，绝不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isCoordinateRecordId,
  readCoordinateRecord,
  resolveCoordinates,
  validateCoordinateRecord,
  validatePositionForRecord,
  writeCoordinateRecord,
} from '../src/cu-coordinate.ts'
import {
  DENY_MISSING_RECORD,
  DENY_OUT_OF_BOUNDS,
  DENY_RECORD_INVALID,
  DENY_RECORD_STALE,
  DENY_TARGET_BLOCKED,
  coordinateGatePrompt,
  createCuCoordinateGate,
  installCuCoordinateGate,
  isComputerUseSession,
  sessionCoordinateMode,
  withCoordinateRecordFields,
} from '../src/cu-coordinate-gate.ts'
import { MAX_LOG_BYTES, appendTurnGuardLog, sanitizeTurnGuardLine } from '../src/turn-guard.ts'
import { lintMarkerClasses, neutralizeProtectedForms } from './personal-context-lib.mjs'

/* ---------- 断言计数（现场报 assertions=<n>） ---------- */
let assertions = 0
function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}
function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}
function deepEqual(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

const root = mkdtempSync(join(tmpdir(), 'cu-coordinate-gate-'))
const stateDir = join(root, 'records')
const gateLines = []
const BASE = 1700000000000
const sessionId = 'session-gate-test'
const realBbox = { x1: 346, y1: 888, x2: 471, y2: 917 }
const realScreenshot = { width: 1920, height: 1032 }

function sessionOf(mode = 'millifraction') {
  return {
    id: sessionId,
    header: { agentPreset: 'computer-use' },
    snapshotEvents: () => [{ type: 'computer-use/coordinate-mode', data: { mode } }],
  }
}

function execOf(session, args, name = 'click') {
  return { name, arguments: args, agent: { session } }
}

function nextSpy() {
  const spy = { calls: 0, fn: async () => { spy.calls += 1; return { kind: 'accept' } } }
  return spy
}

function recordFor(over = {}) {
  const record = resolveCoordinates({
    screenshot: realScreenshot,
    bbox: realBbox,
    mode: 'millifraction',
    sessionId,
    target: 'Publish release',
    now: BASE,
    id: 'aaaa1111',
    ...over,
  })
  writeCoordinateRecord(record, stateDir)
  return record
}

const cases = []

cases.push(['解析器算式：1920x1032 / Publish release bbox 346,888,471,917', () => {
  const record = resolveCoordinates({
    screenshot: realScreenshot,
    bbox: realBbox,
    mode: 'millifraction',
    target: 'Publish release',
    now: BASE,
    id: 'aaaa1111',
  })
  deepEqual(record.center, { x: 408.5, y: 902.5 }, '中心物理像素 = bbox 中点')
  ok(Math.abs(record.fractions.x - 212.76041666666669) < 1e-9, 'x 分数 = 408.5 ÷ 1920 × 1000')
  ok(Math.abs(record.fractions.y - 874.515503875969) < 1e-9, 'y 分数 = 902.5 ÷ 1032 × 1000')
  deepEqual(record.suggestedFractions, { x: 212.76, y: 874.52 }, '建议分数保留两位')
  deepEqual(record.predictedRounded, { x: 409, y: 903 }, 'harness 预测落点 = round(0 + 分数/1000 × 边长)')
  ok(record.formulas.x === '408.5 / 1920 × 1000 = 212.7604', 'x 算式原文')
  ok(record.formulas.y === '902.5 / 1032 × 1000 = 874.5155', 'y 算式原文')
  deepEqual(record.bbox, realBbox, 'bbox 起止原样保留')
  eq(record.v, 1, '记录版本 = 1')
  eq(record.mode, 'millifraction', '缺省坐标口径 = millifraction')
}])

cases.push(['三次实测未命中：偏差 66 / 18 / 68 px；第四次 [213,875] 命中', () => {
  const record = resolveCoordinates({ screenshot: realScreenshot, bbox: realBbox, mode: 'millifraction', now: BASE, id: 'bbbb2222' })
  const first = validatePositionForRecord(record, [146, 873])
  eq(first.hit, false, '第 1 次 [146,873] 未命中')
  deepEqual(first.landed, { x: 280, y: 901 }, '第 1 次实际落点 (280,901)')
  eq(first.deviationPx, 66, '第 1 次偏差 66 px')
  const second = validatePositionForRecord(record, [171, 873])
  eq(second.hit, false, '第 2 次 [171,873] 未命中')
  deepEqual(second.landed, { x: 328, y: 901 }, '第 2 次实际落点 (328,901)')
  eq(second.deviationPx, 18, '第 2 次偏差 18 px')
  const third = validatePositionForRecord(record, [145, 874])
  eq(third.hit, false, '第 3 次 [145,874] 未命中')
  deepEqual(third.landed, { x: 278, y: 902 }, '第 3 次实际落点 (278,902)')
  eq(third.deviationPx, 68, '第 3 次偏差 68 px')
  deepEqual(third.suggestion.fractions, { x: 212.76041666666669, y: 874.515503875969 }, '建议分数 = 中心换算值')
  deepEqual(third.suggestion.pixels, { x: 409, y: 903 }, '建议像素 = 中心取整')
  const fourth = validatePositionForRecord(record, [213, 875])
  eq(fourth.hit, true, '第 4 次 [213,875] 命中')
  deepEqual(fourth.landed, { x: 409, y: 903 }, '第 4 次实际落点 (409,903)')
  eq(fourth.deviationPx, 0, '命中时偏差 0')
}])

cases.push(['像素模式：[408,902] 命中、[280,901] miss；分数仍按截图换算', () => {
  const record = resolveCoordinates({ screenshot: realScreenshot, bbox: realBbox, mode: 'pixel', now: BASE, id: 'cccc3333' })
  eq(record.mode, 'pixel', '记录模式 pixel')
  eq(validatePositionForRecord(record, [408, 902]).hit, true, '像素 [408,902] 落在 bbox 内')
  const miss = validatePositionForRecord(record, [280, 901])
  eq(miss.hit, false, '像素 [280,901] 在 bbox 左边缘外')
  eq(miss.deviationPx, 66, '像素模式偏差同为 66 px')
  ok(Math.abs(record.fractions.x - 212.76041666666669) < 1e-9, '像素模式下分数仍是截图比例')
}])

cases.push(['记录读写：id 校验、TTL 过期、跨会话与坐标口径不一致', () => {
  const record = recordFor()
  const loaded = readCoordinateRecord('aaaa1111', stateDir)
  ok(loaded !== null, '按 id 能读回记录')
  eq(loaded?.bbox.x1, 346, '读回的 bbox 正确')
  eq(isCoordinateRecordId('aaaa1111'), true, '8 位十六进制 id 合法')
  eq(isCoordinateRecordId('../../etc/passwd'), false, '路径穿越形态不是合法 id')
  eq(readCoordinateRecord('../../etc/passwd', stateDir), null, '非法 id 读不到记录')
  eq(validateCoordinateRecord(loaded, { sessionId, mode: 'millifraction', now: BASE }).ok, true, '同会话同模式有效')
  const stale = validateCoordinateRecord(loaded, { sessionId, mode: 'millifraction', now: BASE + 11 * 60 * 1000 })
  eq(stale.ok, false, '超过 10 分钟失效')
  eq(stale.code, DENY_RECORD_STALE, '过期码 coordinate-record-stale')
  const other = validateCoordinateRecord(loaded, { sessionId: 'session-other', mode: 'millifraction', now: BASE })
  eq(other.ok, false, '跨会话不能复用')
  eq(other.code, DENY_RECORD_INVALID, '跨会话码 coordinate-record-invalid')
  const modeMismatch = validateCoordinateRecord(loaded, { sessionId, mode: 'pixel', now: BASE })
  eq(modeMismatch.ok, false, '坐标口径不一致要拒绝')
  ok(modeMismatch.message.includes('--mode pixel'), '提示写明重跑解析器加 --mode pixel')
}])

cases.push(['pre-execute：没有 coordinate_record 的 click 被拒，拒绝码与修正提示可执行', async () => {
  const gate = createCuCoordinateGate({ stateDir, now: () => BASE, resolverPath: 'scripts/cu-coordinate-resolver.mjs', log: () => {} })
  const session = sessionOf('millifraction')
  const exec = execOf(session, { screen_index: 0, position: [213, 875] })
  const next = nextSpy()
  const decision = await gate.preExecute(exec, next.fn)
  eq(decision.kind, 'deny', '缺记录必须 deny')
  eq(decision.info?.code, DENY_MISSING_RECORD, '拒绝码 missing-coordinate-record')
  eq(next.calls, 0, '拒绝时不许执行工具')
  ok(String(decision.reason).includes('coordinate_record'), '提示里点名 coordinate_record')
  ok(String(decision.reason).includes('--bbox'), '提示里给出解析器 --bbox 用法')
  ok(String(decision.reason).includes('不许目测分数'), '提示里禁止目测分数')
}])

cases.push(['pre-execute：带记录放行；分数落在 bbox 外给 coordinate-out-of-bounds + 建议分数', async () => {
  recordFor()
  const gate = createCuCoordinateGate({ stateDir, now: () => BASE, resolverPath: 'scripts/cu-coordinate-resolver.mjs', log: () => {} })
  const session = sessionOf('millifraction')
  const good = execOf(session, { screen_index: 0, position: [213, 875], coordinate_record: 'aaaa1111' })
  const goodNext = nextSpy()
  const allow = await gate.preExecute(good, goodNext.fn)
  deepEqual(allow, { kind: 'accept' }, '记录有效且落点在 bbox 内 → 放行')
  eq(goodNext.calls, 1, '放行时执行一次工具')

  const bad = execOf(session, { screen_index: 0, position: [146, 873], coordinate_record: 'aaaa1111' })
  const badNext = nextSpy()
  const deny = await gate.preExecute(bad, badNext.fn)
  eq(deny.kind, 'deny', '落点在外必须 deny')
  eq(deny.info?.code, DENY_OUT_OF_BOUNDS, '拒绝码 coordinate-out-of-bounds')
  eq(badNext.calls, 0, '拒绝时不许执行')
  ok(String(deny.reason).includes('66'), '提示里带偏差 66 px')
  ok(String(deny.reason).includes('212.76'), '提示里带建议分数 212.76')
  ok(String(deny.reason).includes('Tab-Enter'), '提示里带非坐标手段')
}])

cases.push(['pre-execute：记录口径与会话不一致时拒绝并指引 --mode', async () => {
  recordFor()
  const gate = createCuCoordinateGate({ stateDir, now: () => BASE, resolverPath: 'scripts/cu-coordinate-resolver.mjs', log: () => {} })
  const session = sessionOf('pixel')
  const exec = execOf(session, { screen_index: 0, position: [408, 902], coordinate_record: 'aaaa1111' })
  const decision = await gate.preExecute(exec, nextSpy().fn)
  eq(decision.kind, 'deny', '模式不一致必须 deny')
  eq(decision.info?.code, DENY_RECORD_INVALID, '拒绝码 coordinate-record-invalid')
  ok(String(decision.reason).includes('--mode pixel'), '提示写明重跑解析器加 --mode pixel')

  writeFileSync(join(stateDir, 'deadbeef.json'), '{not-json', 'utf8')
  const corrupt = execOf(session, { screen_index: 0, position: [408, 902], coordinate_record: 'deadbeef' })
  const corruptDecision = await gate.preExecute(corrupt, nextSpy().fn)
  eq(corruptDecision.kind, 'deny', '记录内容坏掉必须 deny')
  eq(corruptDecision.info?.code, DENY_RECORD_INVALID, '坏记录拒绝码 coordinate-record-invalid')
}])

cases.push(['post-execute：Pointer landed at [409,903] 命中，日志写 hit 且 deviationPx=0', async () => {
  recordFor()
  const logs = []
  const gate = createCuCoordinateGate({ stateDir, now: () => BASE, resolverPath: 'scripts/cu-coordinate-resolver.mjs', log: (line) => logs.push(line) })
  const session = sessionOf('millifraction')
  const exec = execOf(session, { screen_index: 0, position: [213, 875], coordinate_record: 'aaaa1111' })
  const preNext = nextSpy()
  await gate.preExecute(exec, preNext.fn)
  const postNext = nextSpy()
  const result = { isError: false, value: { landed: [409, 903] }, content: [{ type: 'text', text: 'Pointer landed at [409, 903] physical pixels.' }] }
  const decision = await gate.postExecute(exec, result, postNext.fn)
  deepEqual(decision, { kind: 'accept' }, '命中时原样放行')
  eq(postNext.calls, 1, '命中时继续下游')
  const hitLine = logs.find((line) => line.includes('cu-coord hit'))
  ok(hitLine !== undefined, '日志里有 cu-coord hit 行')
  ok(String(hitLine).includes('deviationPx=0'), '命中偏差 0')
  ok(String(hitLine).includes('streak=0'), '命中重置连续 miss')
  ok(String(hitLine).includes('textChars=0'), '沿用 textChars= 计数口径')
  ok(!String(hitLine).includes('text="'), '不落 excerpt（没有 text="）')
  ok(!String(hitLine).includes('Publish release'), '日志不落目标文本')
}])

cases.push(['post-execute：连续 2 次 miss，第 2 次必须引导改用非坐标手段', async () => {
  recordFor()
  const logs = []
  const gate = createCuCoordinateGate({ stateDir, now: () => BASE, resolverPath: 'scripts/cu-coordinate-resolver.mjs', log: (line) => logs.push(line) })
  const session = sessionOf('millifraction')

  const firstExec = execOf(session, { screen_index: 0, position: [213, 875], coordinate_record: 'aaaa1111' })
  await gate.preExecute(firstExec, nextSpy().fn)
  const first = await gate.postExecute(firstExec, { isError: false, value: { landed: [280, 901] } }, nextSpy().fn)
  eq(first.kind, 'block', '第 1 次 miss 返回 block 修正提示')
  ok(String(first.feedback?.[0]?.text).includes('未命中'), '第 1 次提示写未命中')
  ok(String(first.feedback?.[0]?.text).includes('66'), '第 1 次提示带偏差 66 px')
  ok(String(first.feedback?.[0]?.text).includes('212.76'), '第 1 次提示带建议分数')

  const secondExec = execOf(session, { screen_index: 0, position: [213, 875], coordinate_record: 'aaaa1111' })
  await gate.preExecute(secondExec, nextSpy().fn)
  const second = await gate.postExecute(secondExec, { isError: false, value: { landed: [328, 901] } }, nextSpy().fn)
  eq(second.kind, 'block', '第 2 次 miss 继续 block')
  const text = String(second.feedback?.[0]?.text)
  ok(text.includes('连续 2 次'), '第 2 次提示点名连续 2 次')
  ok(text.includes('导航 URL'), '提示改用地址栏导航 URL')
  ok(text.includes('Tab-Enter'), '提示改用键盘 Tab-Enter')
  ok(text.includes('页面文本链接'), '提示改读页面文本链接')
  const missLines = logs.filter((line) => line.includes('cu-coord miss'))
  eq(missLines.length, 2, '日志里两次 miss 都落行')
  ok(String(missLines[0]).includes('streak=1'), '第 1 行 streak=1')
  ok(String(missLines[1]).includes('streak=2'), '第 2 行 streak=2')
  ok(String(missLines[1]).includes('advice=non-coordinate'), '第 2 行带 advice=non-coordinate')

  const thirdExec = execOf(session, { screen_index: 0, position: [213, 875], coordinate_record: 'aaaa1111' })
  const third = await gate.preExecute(thirdExec, nextSpy().fn)
  eq(third.kind, 'deny', '同一 bbox 第 3 次点击被硬停')
  eq(third.info?.code, DENY_TARGET_BLOCKED, '硬停码 coordinate-target-blocked')
  ok(String(third.reason).includes('Tab-Enter'), '硬停提示带非坐标手段')
}])

cases.push(['日志掩码与轮转：sanitizeTurnGuardLine 生效、textChars= 保留、超阈值轮转', () => {
  const gate = createCuCoordinateGate({ stateDir, now: () => BASE, resolverPath: 'scripts/cu-coordinate-resolver.mjs', log: (line) => gateLines.push(line) })
  const masked = sanitizeTurnGuardLine('状态文件 C:\\Users\\X\\secret.txt（档位 desktop）')
  ok(!/[A-Za-z]:[\\/]/.test(masked), '盘符路径被掩掉')
  ok(!masked.includes('Users'), 'Users 形态被掩掉')
  ok(masked.includes('<path>'), '掩码标记是 <path>')
  const line = 'cu-coord probe path C:\\Users\\X\\secret.txt textChars=12'
  gate.log(line)
  const written = gateLines[gateLines.length - 1]
  ok(!String(written).includes('Users'), '注入日志出口也先过掩码')
  ok(String(written).includes('textChars=12'), 'textChars= 计数保留')
  ok(!String(written).includes('text="'), '没有 text=" excerpt')

  const logFile = join(root, 'rotate.log')
  writeFileSync(logFile, Buffer.alloc(MAX_LOG_BYTES + 1, 0x61))
  const fileGate = createCuCoordinateGate({ stateDir, now: () => BASE, logFile })
  fileGate.log('cu-coord probe tool=click code=missing-coordinate-record textChars=0')
  ok(existsSync(`${logFile}.1`), '超 MAX_LOG_BYTES 自动轮转到 .1')
  ok(statSync(logFile).size < MAX_LOG_BYTES, '轮转后新日志低于阈值')
  const fresh = readFileSync(logFile, 'utf8').trim()
  ok(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}(\.[0-9]+)?Z \[pid [0-9]+\] cu-coord probe/.test(fresh), '日志行仍是 ISO 时间戳 + [pid N] 形状')
  rmSync(`${logFile}.1`, { force: true })
  rmSync(logFile, { force: true })
}])

cases.push(['提示词与装配：CU 会话有硬门提示、普通会话为空、装卸两处钩子', async () => {
  const prompt = coordinateGatePrompt('scripts/cu-coordinate-resolver.mjs')
  ok(prompt.includes('coordinate_record'), '提示里点名 coordinate_record')
  ok(prompt.includes('suggestedFractions'), '提示里给分数用法')
  ok(prompt.includes('Pointer landed'), '提示里要求核对落点')
  ok(prompt.includes('Tab-Enter') && prompt.includes('URL'), '提示里给非坐标手段')

  const handlers = new Map()
  const sections = []
  const ctx = {
    on(event, callback) {
      handlers.set(event, callback)
      return () => { handlers.delete(event) }
    },
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return { section(options) { sections.push(options); return () => {} } }
    },
  }
  const dispose = installCuCoordinateGate(ctx, { stateDir, now: () => BASE, log: () => {} })
  ok(handlers.has('tools/pre-execute'), '挂上 tools/pre-execute')
  ok(handlers.has('tools/post-execute'), '挂上 tools/post-execute')
  ok(handlers.has('system-prompt/assemble'), '挂上 system-prompt/assemble')
  eq(sections.length, 1, '注册一段系统提示')
  const cuText = sections[0].text({ agent: { session: sessionOf('millifraction') } })
  ok(String(cuText).includes('点击前坐标硬门'), 'CU 会话提示词非空')
  const stdText = sections[0].text({ agent: { session: { header: { agentPreset: 'standard' }, snapshotEvents: () => [] } } })
  eq(stdText, '', '普通会话提示词为空')

  const baseAssembly = {
    tools: [
      { name: 'click', parameters: { type: 'object', properties: { position: { type: 'array' } } } },
      { name: 'drag', parameters: { type: 'object', properties: { start_position: { type: 'array' }, end_position: { type: 'array' } } } },
      { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
    ],
  }
  const assembled = await handlers.get('system-prompt/assemble')({}, {}, async () => baseAssembly)
  eq(assembled.tools[0].parameters.properties.coordinate_record.type, 'string', 'click schema 补上 coordinate_record')
  eq(assembled.tools[1].parameters.properties.coordinate_record_end.type, 'string', 'drag schema 补上 coordinate_record_end')
  eq(assembled.tools[2], baseAssembly.tools[2], '无关工具原样保留')
  ok(baseAssembly.tools[0].parameters.properties.coordinate_record === undefined, '不就地改原 assembly')
  const noTools = withCoordinateRecordFields({ tools: [] })
  eq(noTools.tools.length, 0, '空 tools 原样返回')
  const emptyAssembly = {}
  ok(withCoordinateRecordFields(emptyAssembly) === emptyAssembly, '没有 tools 的 assembly 原样返回')
  dispose()
  eq(handlers.has('tools/pre-execute'), false, '卸载后 pre-execute 钩子移除')
  eq(handlers.has('tools/post-execute'), false, '卸载后 post-execute 钩子移除')
  eq(handlers.has('system-prompt/assemble'), false, '卸载后 system-prompt/assemble 钩子移除')

  eq(isComputerUseSession(sessionOf('millifraction')), true, 'CU 会话判定 = 预设名/坐标事件')
  eq(isComputerUseSession({ header: { agentPreset: 'standard' }, snapshotEvents: () => [] }), false, '普通会话不判成 CU')
  eq(sessionCoordinateMode(sessionOf('pixel')), 'pixel', '会话坐标口径读 pixel')
  eq(sessionCoordinateMode({ header: { agentPreset: 'computer-use' }, snapshotEvents: () => [] }), 'millifraction', '无事件回退 millifraction')
}])

cases.push(['解析器与两份档案新小节：个人化标识 0、退役仓库名 0、已作废旧口令 0、无 64 位指纹', () => {
  const markers = lintMarkerClasses()
  // 旧口令不写成连续字面串，避免这份黑名单自己成为「代码里出现旧值」的反例。
  const retiredPatterns = [
    new RegExp('DSH' + '_CU' + '_UIA'),
    new RegExp('dsh' + '-assistant' + '-cu' + '-uia'),
    new RegExp('cu' + '-uia' + '-'),
    new RegExp('install' + 'CuObservation' + 'Wrapper'),
    new RegExp('build' + 'SlimControl' + 'Hint'),
  ]
  const resolverSource = readFileSync(new URL('../scripts/cu-coordinate-resolver.mjs', import.meta.url), 'utf8')
  ok(!/[A-Za-z]:[\\/]/.test(resolverSource), '解析器不写死任何盘符路径')
  ok(!/[A-Za-z]:[\\/]/.test(readFileSync(new URL('../src/cu-coordinate.ts', import.meta.url), 'utf8')), '解析器核心不写死盘符路径')

  const docsText = readFileSync(new URL('../docs/computer-use-提速前后对比-2026-11-27.md', import.meta.url), 'utf8')
  const docsStart = docsText.indexOf('## 16.7')
  ok(docsStart > 0, '档案存在 §16.7')
  const docsSection = docsText.slice(docsStart)
  const reportText = readFileSync(new URL('../reports/上架前整改-2026-11-28.md', import.meta.url), 'utf8')
  const reportStart = reportText.indexOf('## 13.')
  ok(reportStart > 0, '整改档案存在 §13')
  const reportSection = reportText.slice(reportStart)

  const sources = [
    ['scripts/cu-coordinate-resolver.mjs', resolverSource],
    ['src/cu-coordinate.ts', readFileSync(new URL('../src/cu-coordinate.ts', import.meta.url), 'utf8')],
    ['src/cu-coordinate-gate.ts', readFileSync(new URL('../src/cu-coordinate-gate.ts', import.meta.url), 'utf8')],
    ['docs §16.7', docsSection],
    ['reports §13', reportSection],
  ]
  for (const [name, raw] of sources) {
    const text = neutralizeProtectedForms(raw)
    for (const marker of markers.personal) ok(!text.includes(marker), `${name}: 不出现个人化标识（类别派生，不在断言里打印值）`)
    for (const marker of markers.retired) ok(!text.includes(marker), `${name}: 不出现退役仓库名`)
    for (const pattern of retiredPatterns) ok(!pattern.test(text), `${name}: 不出现已作废旧口令`)
    ok(!/[a-f0-9]{64}/i.test(text), `${name}: 没有 64 位 sha256 指纹`)
  }
}])

let failed = 0
for (const [label, run] of cases) {
  try {
    await run()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error && error.message ? error.message : String(error)}`)
  }
}
console.log(failed === 0 ? `\n${cases.length}/${cases.length} 通过 · assertions=${assertions}` : `\n${failed}/${cases.length} 失败 · assertions=${assertions}`)
rmSync(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
