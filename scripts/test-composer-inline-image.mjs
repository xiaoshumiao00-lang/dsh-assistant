/**
 * composer 图片光标标记回归（2026-11-25 需求）：
 *   node scripts/test-composer-inline-image.mjs
 *
 * 需求：多张图片统一堆在输入框上方 chip 条，和正文脱节；用户要在光标处写「第 N 张图」
 * 并让模型对上号。实现路线（RE 结论，报告 composer-inline-image-20261125.md）：
 *   宿主输入框是 Lexical contenteditable，编辑器节点类型建编辑器时固定，插件无法注册
 *   新 decorator 节点 → 「真内联缩略图」必须改宿主，不做；走光标标记兜底——图片进附件
 *   管线时在光标处插入 `[图N:名字]` 纯文本标记（走宿主公开 inputActions.captureInsertion
 *   + insertText，draftRev CAS），删除图片后按名字自愈重编号/清残标。
 *
 * 本文件分两层：
 *   1) 纯核心 + driver 离线断言：假宿主完整复刻 facade.ts 的 CAS 语义
 *      （insertText: frozen→false；span.draftRev !== rev→false；detect 坐标切片），
 *      粘贴/混排/删除/含 chip 坐标换算/CAS 冲突/冻结/空名/手打标记/开关，全离线。
 *   2) 构建产物断言：lib/client.js 必须真的带上这条链（注册 id + 标记字形）——
 *      对改动前的旧 bundle 这条 FAIL（旧代码没有该功能），build 之后 PASS。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONVERSATION_STORAGE_PREFIX,
  DISABLE_KEY,
  MAX_EDITS_PER_CALL,
  createComposerInlineImageDriver,
  detectOffsetOfClipboardOffset,
  diffImageIds,
  formatImageMarker,
  imageAttachmentsOf,
  planReconcile,
  readChipSpansFromStorage,
  sanitizeImageName,
  scanImageMarkers,
} from '../src/client/pocket/orb/composerInlineImage.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const ATOMIC = '￼'
const SID = 'session-inline-image-test'
const STORAGE_KEY = `${CONVERSATION_STORAGE_PREFIX}${SID}`
const FROZEN = new Set(['adjudicating', 'submitting', 'sending'])

const cases = []
const check = (name, fn) => cases.push([name, fn])

/* ══ 1. 纯核心 ═══════════════════════════════════════════════════════════ */

check('标记格式：有名字 [图N:名字]，无名字 [图N]', () => {
  assert.equal(formatImageMarker(1, 'a.png'), '[图1:a.png]')
  assert.equal(formatImageMarker(12, ''), '[图12]')
  assert.equal(formatImageMarker(0, 'x.png'), '[图1:x.png]', '序号下限 1')
})

check('文件名消毒：剥括号/换行/控制字符、限长 60', () => {
  assert.equal(sanitizeImageName('a]b[c.png'), 'abc.png')
  assert.equal(sanitizeImageName('x\ny\r.png'), 'xy.png')
  assert.equal(sanitizeImageName('  '), '')
  assert.equal(sanitizeImageName(null), '')
  assert.equal(sanitizeImageName('截图 2026-11-25 上午.png'), '截图 2026-11-25 上午.png', '中文与空格保留')
  const long = `${'长'.repeat(80)}.png`
  assert.equal(sanitizeImageName(long).length, 60)
  assert.ok(sanitizeImageName(long).endsWith('…'))
})

check('标记扫描：文本顺序、数字段坐标、名字段', () => {
  const text = '前 [图1:a.png] 中 [图2] 后 [图10:长 名字.png] 尾'
  const markers = scanImageMarkers(text)
  assert.equal(markers.length, 3)
  assert.deepEqual(markers.map((m) => [m.ordinal, m.name]), [[1, 'a.png'], [2, ''], [10, '长 名字.png']])
  for (const m of markers) {
    assert.equal(text.slice(m.start, m.end).startsWith('[图'), true)
    assert.equal(text.slice(m.digitsStart, m.digitsEnd), String(m.ordinal), '数字段正好罩住序号')
  }
  assert.deepEqual(scanImageMarkers('没有标记 [图x] [图] [图1'), [])
})

check('图片子序列：文件类附件不进图片编号', () => {
  const attachments = [
    { id: 'f1', kind: 'file', file: { name: 'a.pdf' } },
    { id: 'i1', kind: 'image', file: { name: 'a.png' } },
    { id: 'i2', kind: 'image', file: { name: 'b.png' } },
  ]
  assert.deepEqual(imageAttachmentsOf(attachments).map((a) => a.id), ['i1', 'i2'])
})

check('id 序列 diff：只追加的宿主语义下给出新增与移除', () => {
  assert.deepEqual(diffImageIds(['a', 'b'], ['a', 'b', 'c']), { added: ['c'], removed: [] })
  assert.deepEqual(diffImageIds(['a', 'b', 'c'], ['a', 'c']), { added: [], removed: ['b'] })
  assert.deepEqual(diffImageIds([], []), { added: [], removed: [] })
})

check('clipboard→detect 换算：每个完整在前的 chip 少算 length−1', () => {
  const chips = [{ offset: 3, length: 9 }, { offset: 20, length: 5 }]
  assert.equal(detectOffsetOfClipboardOffset(0, chips), 0)
  assert.equal(detectOffsetOfClipboardOffset(3, chips), 3, 'chip 起点不受影响')
  assert.equal(detectOffsetOfClipboardOffset(12, chips), 12 - 8, '跨过 9 长 chip：detect = 12 − 8')
  assert.equal(detectOffsetOfClipboardOffset(25, chips), 25 - 8 - 4)
})

check('localStorage 镜像：text 一致才给 chip 表，不一致/坏形状给 null', () => {
  const draft = '看 @a.png 和 [图1:b.png] '
  const raw = JSON.stringify({
    draft: {
      text: draft,
      references: [{ source: 'reference', ref: '@a.png', offset: 2, length: 7, label: 'a.png', clipboardText: '@a.png' }],
      quotes: [],
    },
    view: null,
  })
  const chips = readChipSpansFromStorage(raw, draft)
  assert.deepEqual(chips, [{ offset: 2, length: 7 }])
  assert.equal(readChipSpansFromStorage(raw, `${draft} `), null, 'live draft 多一个字符 → 镜像过期 → 不动手')
  assert.equal(readChipSpansFromStorage('not json', draft), null)
  assert.equal(readChipSpansFromStorage(null, draft), null)
  assert.equal(readChipSpansFromStorage(JSON.stringify({ draft: { text: draft, references: [{ offset: -1, length: 3 }] } }), draft), null, '越界 chip 拒收')
})

check('reconcile：名字对上的改序号，对不上的删掉（连着一个空格）', () => {
  const draft = '甲 [图1:a.png] 乙 [图2:b.png] 丙 [图3:c.png] 丁'
  // b 被移除：images 剩 a、c（wire 序 1、2）
  const plan = planReconcile(draft, [{ name: 'a.png' }, { name: 'c.png' }])
  assert.equal(plan.converged, false)
  const byStart = [...plan.edits].sort((x, y) => x.start - y.start)
  assert.equal(byStart.length, 2)
  // 升序看：先删 b 的标记（连一个空格），再把 c 的 图3 改成 图2
  assert.equal(draft.slice(byStart[0].start, byStart[0].end), '[图2:b.png] ')
  assert.equal(byStart[0].replacement, '')
  assert.equal(draft.slice(byStart[1].start, byStart[1].end), '3')
  assert.equal(byStart[1].replacement, '2')
  // 模拟应用两处（降序应用不影响低偏移），收敛
  let next = applyEditsDesc(draft, plan.edits)
  assert.equal(next, '甲 [图1:a.png] 乙 丙 [图2:c.png] 丁')
  assert.equal(planReconcile(next, [{ name: 'a.png' }, { name: 'c.png' }]).converged, true)
})

check('reconcile：同名多张按出现次序一一对应', () => {
  const draft = '[图1:image.png] 和 [图2:image.png] 和 [图3:image.png]'
  // 同名三张剩两张（wire 序 1、2）：按名字出现次序，前两个标记对上，第三个（多出来的）删除
  const plan = planReconcile(draft, [{ name: 'image.png' }, { name: 'image.png' }])
  const next = applyEditsDesc(draft, plan.edits)
  assert.equal(next, '[图1:image.png] 和 [图2:image.png] 和 ', '前两个标记按名字次序归位，第三个删除')
  assert.equal(planReconcile(next, [{ name: 'image.png' }, { name: 'image.png' }]).converged, true)
})

check('reconcile：无名标记按「第 N 张」序号语义，不乱删手打内容', () => {
  // 用户在只有 1 张图时手打 [图1]：保留
  assert.equal(planReconcile('看图 [图1] 说话', [{ name: 'a.png' }]).converged, true)
  // 2 张图时 [图9] 超出 → 删
  const plan = planReconcile('甲 [图1] 乙 [图9] 丙', [{ name: 'a.png' }, { name: 'b.png' }])
  assert.equal(plan.edits.length, 1)
  assert.equal(applyEditsDesc('甲 [图1] 乙 [图9] 丙', plan.edits), '甲 [图1] 乙 丙')
  // 0 张图时不动无名标记（多半是手打，别误删）
  assert.equal(planReconcile('先写 [图1] 待会补图', []).converged, true)
})

check('reconcile：没有可动的就是收敛（空计划）', () => {
  assert.equal(planReconcile('', []).converged, true)
  assert.equal(planReconcile('普通文本没有标记', [{ name: 'a.png' }]).converged, true)
})

/* ══ 2. 假宿主 + driver 集成 ════════════════════════════════════════════ */

/** 把 plan 的修改按降序一次性应用到文本（模拟 driver 多轮收敛后的终态）。 */
function applyEditsDesc(text, edits) {
  let out = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    assert.equal(out.slice(edit.start, edit.end), edit.expect, `expect 校验：${JSON.stringify(edit)}`)
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
  }
  return out
}

/**
 * 假宿主：完整复刻 facade.ts 的写入语义——
 *   insertText: frozen→false；span.draftRev !== rev→false；detect 坐标切片；
 *   captureInsertion: 当前 caret 的 detect span + 当前 rev；
 *   persist: 每次成功编辑后把 {draft:{text,references,quotes}} 写进 localStorage 镜像。
 * 文档用 segment 序列建模：text 段与 chip 段（detect 里 1 个 U+FFFC，clipboard 里展开）。
 */
function makeFakeHost() {
  const host = {
    segments: [],
    caret: 0,
    rev: 0,
    phase: 'plain',
    attachments: new Map(),
    storage: new Map(),
    insertCalls: [],
  }
  const detectText = () => host.segments.map((s) => (s.kind === 'chip' ? ATOMIC : s.text)).join('')
  const clipboardText = () => host.segments.map((s) => (s.kind === 'chip' ? s.clipboardText : s.text)).join('')
  const persist = () => {
    let clip = 0
    const references = []
    for (const seg of host.segments) {
      if (seg.kind === 'chip') {
        references.push({
          source: 'reference', ref: seg.clipboardText, offset: clip, length: seg.clipboardText.length,
          label: seg.clipboardText, clipboardText: seg.clipboardText,
        })
        clip += seg.clipboardText.length
      } else {
        clip += seg.text.length
      }
    }
    host.storage.set(STORAGE_KEY, JSON.stringify({
      draft: { text: clipboardText(), references, quotes: [] },
      view: null,
      viewRequest: null,
    }))
  }
  host.api = {
    captureInsertion: () => ({ start: host.caret, end: host.caret, draftRev: host.rev }),
    insertText: (text, span) => {
      host.insertCalls.push({ text, span: { ...span } })
      if (FROZEN.has(host.phase)) return false
      if (span.draftRev !== host.rev) return false
      const dt = detectText()
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end < span.start || span.end > dt.length) return false
      let pos = 0
      for (const seg of host.segments) {
        const len = seg.kind === 'chip' ? 1 : seg.text.length
        if (span.start >= pos && span.end <= pos + len) {
          if (seg.kind === 'chip') return false // 测试里我们的修改永不落在 chip 内
          seg.text = seg.text.slice(0, span.start - pos) + text + seg.text.slice(span.end - pos)
          host.caret = span.start + text.length
          host.rev += 1
          persist()
          return true
        }
        pos += len
      }
      // 空文档：宿主 $replaceDetectSpanWithText 会落进第一个段落，这里补一个文本段
      if (host.segments.length === 0 && span.start === 0 && span.end === 0) {
        host.segments.push({ kind: 'text', text })
        host.caret = text.length
        host.rev += 1
        persist()
        return true
      }
      return false
    },
    resolveAttachments: (ids) => ids.map((id) => host.attachments.get(id)).filter(Boolean),
    readStorage: (key) => (host.storage.has(key) ? host.storage.get(key) : null),
  }
  host.input = () => ({
    draft: clipboardText(),
    attachmentIds: [...host.attachments.keys()],
    draftRev: host.rev,
    phase: host.phase,
  })
  host.addImage = (id, name) => { host.attachments.set(id, { id, kind: 'image', file: { name } }) }
  host.addFile = (id, name) => { host.attachments.set(id, { id, kind: 'file', file: { name } }) }
  host.remove = (id) => { host.attachments.delete(id) }
  host.setText = (text) => { host.segments = text === '' ? [] : [{ kind: 'text', text }]; host.caret = text.length; persist() }
  host.clipboard = clipboardText
  host.detect = detectText
  return host
}

function makeDriver(host) {
  return createComposerInlineImageDriver({
    insertText: host.api.insertText,
    captureInsertion: host.api.captureInsertion,
    resolveAttachments: host.api.resolveAttachments,
    readStorage: host.api.readStorage,
  })
}

/** 模拟「渲染循环」：每改一次草稿宿主就再渲染一次，直到收敛（rev 不再动）。 */
function runUntilSettled(driver, host, maxRounds = 40) {
  let lastRev = -1
  for (let i = 0; i < maxRounds; i++) {
    driver.onInput(host.input(), SID)
    if (host.rev === lastRev) return i + 1
    lastRev = host.rev
  }
  throw new Error('driver 40 轮还没收敛，疑似死循环')
}

check('driver：粘贴 3 张图，光标处落下 [图1..3:名字]，序号=图片 wire 序', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('左边 右边')
  host.caret = 3 // 「左边 」之后
  runUntilSettled(driver, host) // 首轮： adopting（0 张图），不动
  host.addImage('i1', 'a.png'); host.addImage('i2', 'b.png'); host.addImage('i3', 'c.png')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '左边 [图1:a.png] [图2:b.png] [图3:c.png] 右边')
  assert.equal(host.detect(), host.clipboard(), '纯文本草稿 detect==clipboard')
  assert.equal(host.insertCalls.length, 1, '一批 3 张只插一次')
})

check('driver：文件与图片混排，只有图片进编号', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('')
  runUntilSettled(driver, host)
  host.addFile('f1', '说明书.pdf')
  host.addImage('i1', 'a.png')
  host.addFile('f2', 'b.docx')
  host.addImage('i2', 'b.png')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '[图1:a.png] [图2:b.png] ')
})

check('driver：删掉中间一张，残标清除 + 后面的重编号（收敛后序号=wire 序）', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('看这几张：')
  host.caret = host.detect().length
  runUntilSettled(driver, host)
  host.addImage('i1', 'a.png'); host.addImage('i2', 'b.png'); host.addImage('i3', 'c.png')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '看这几张：[图1:a.png] [图2:b.png] [图3:c.png] ')
  host.remove('i2')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '看这几张：[图1:a.png] [图2:c.png] ', 'b 的标记没了，c 从 图3 改成 图2')
})

check('driver：连续删两张（分两次），每次都正确重编号', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('')
  runUntilSettled(driver, host)
  for (const [id, name] of [['i1', 'a.png'], ['i2', 'b.png'], ['i3', 'c.png'], ['i4', 'd.png']]) host.addImage(id, name)
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '[图1:a.png] [图2:b.png] [图3:c.png] [图4:d.png] ')
  host.remove('i1')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '[图1:b.png] [图2:c.png] [图3:d.png] ')
  host.remove('i3') // 注意此时 i3=c.png 的 wire 序是 2
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '[图1:b.png] [图2:d.png] ')
})

check('driver：草稿里有 @文件 chip 时，重编号的 detect 坐标换算精确（不写坏 chip）', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  // 草稿：「参考 @图纸.png 然后 [图1:a.png] [图2:b.png] [图3:c.png] 」——chip 在标记之前
  host.segments = [
    { kind: 'text', text: '参考 ' },
    { kind: 'chip', clipboardText: '@图纸.png' },
    { kind: 'text', text: ' 然后 ' },
  ]
  host.caret = host.detect().length
  persistHost(host)
  runUntilSettled(driver, host)
  host.addImage('i1', 'a.png'); host.addImage('i2', 'b.png'); host.addImage('i3', 'c.png')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '参考 @图纸.png 然后 [图1:a.png] [图2:b.png] [图3:c.png] ')
  assert.equal(host.detect(), `参考 ${ATOMIC} 然后 [图1:a.png] [图2:b.png] [图3:c.png] `)
  host.remove('i2')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '参考 @图纸.png 然后 [图1:a.png] [图2:c.png] ')
  assert.equal(host.detect(), `参考 ${ATOMIC} 然后 [图1:a.png] [图2:c.png] `, 'chip 段原样，detect 长度变化只在纯文本段')
})

/** persist 是 makeFakeHost 闭包内的，测试里直接补写镜像（与 insertText 内的 persist 同形）。 */
function persistHost(host) {
  let clip = 0
  const references = []
  for (const seg of host.segments) {
    if (seg.kind === 'chip') {
      references.push({
        source: 'reference', ref: seg.clipboardText, offset: clip, length: seg.clipboardText.length,
        label: seg.clipboardText, clipboardText: seg.clipboardText,
      })
      clip += seg.clipboardText.length
    } else {
      clip += seg.text.length
    }
  }
  host.storage.set(STORAGE_KEY, JSON.stringify({ draft: { text: host.clipboard(), references, quotes: [] }, view: null }))
}

check('driver：用户在两次渲染之间打字 → CAS 拒绝 → 本轮放弃，不写坏草稿', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('开头 ')
  host.caret = host.detect().length
  runUntilSettled(driver, host)
  host.addImage('i1', 'a.png'); host.addImage('i2', 'b.png')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '开头 [图1:a.png] [图2:b.png] ')
  // 删掉 i1，但在 driver 动手前用户又敲了一个字（rev 变了）
  host.remove('i1')
  const staleRev = host.rev
  host.segments[0].text = `开头 嗯${host.segments[0].text.slice(3)}`
  host.rev += 1
  persistHost(host)
  // driver 这一轮看到的 input 是旧 rev 的？不——driver 总是读最新 input；
  // 这里模拟的是「driver 拿着旧 span 撞上 CAS」：直接调 insertText 验证假宿主的 CAS 语义本身。
  assert.equal(host.api.insertText('X', { start: 0, end: 0, draftRev: staleRev }), false, '旧 rev 的 span 必须被拒绝')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '开头 嗯[图1:b.png] ', 'i2 的标记重编号为 图1，用户打的字原样保留')
})

check('driver：冻结阶段（发送中）不插标记', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('')
  runUntilSettled(driver, host)
  host.phase = 'sending'
  host.addImage('i1', 'a.png')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '', 'frozen 时附件根本加不进来，自然也没有标记')
  host.phase = 'plain'
  runUntilSettled(driver, host)
})

check('driver：空名字图片 → [图N] 无名字段', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('')
  runUntilSettled(driver, host)
  host.addImage('i1', '')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '[图1] ')
})

check('driver：用户把标记名字改成对不上的 → reconcile 清掉它', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('')
  runUntilSettled(driver, host)
  host.addImage('i1', 'a.png')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '[图1:a.png] ')
  // 用户手改成 [图1:别的.png]
  host.segments[0].text = '[图1:别的.png] '
  host.rev += 1
  persistHost(host)
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '', '名字对不上现存图片 → 残标清除')
})

check('driver：会话切换 adopting——存量图片不补插标记', () => {
  const host = makeFakeHost()
  const driver = makeDriver(host)
  host.setText('旧草稿 ')
  host.addImage('i1', 'a.png')
  runUntilSettled(driver, host) // 第一次见这个会话： adopting，不插
  assert.equal(host.clipboard(), '旧草稿 ')
  assert.equal(host.insertCalls.length, 0)
})

check('driver：开关关掉（localStorage=0）整套不动作', () => {
  const host = makeFakeHost()
  host.storage.set(DISABLE_KEY, '0')
  const driver = makeDriver(host)
  host.setText('')
  runUntilSettled(driver, host)
  host.addImage('i1', 'a.png')
  runUntilSettled(driver, host)
  assert.equal(host.clipboard(), '')
  assert.equal(host.insertCalls.length, 0)
})

check('driver：readStorage 抛异常也不崩（隐私模式兜底）', () => {
  const host = makeFakeHost()
  const driver = createComposerInlineImageDriver({
    insertText: host.api.insertText,
    captureInsertion: host.api.captureInsertion,
    resolveAttachments: host.api.resolveAttachments,
    readStorage: () => { throw new Error('denied') },
  })
  host.setText('')
  host.addImage('i1', 'a.png')
  assert.doesNotThrow(() => runUntilSettled(driver, host))
})

check('driver：MAX_EDITS_PER_CALL 是有限的（一轮最多 4 处，靠渲染轮收敛）', () => {
  assert.ok(Number.isInteger(MAX_EDITS_PER_CALL) && MAX_EDITS_PER_CALL >= 1 && MAX_EDITS_PER_CALL <= 8)
})

/* ══ 3. 构建产物断言（旧 bundle FAIL / 新 bundle PASS） ════════════════ */

check('lib/client.js 带上了图片光标标记链（注册 id + 槽位 + 标记字形 + 存储键）', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  for (const marker of [
    'assistant-composer-inline-image',
    'conversation.input.left',
    '[图',
    'dsh.conversation.',
    'dsh-assistant.composerInlineImage',
  ]) {
    assert.ok(source.includes(marker), `lib/client.js 缺「${marker}」——先跑 node build.mjs`)
  }
})

/* ══ 跑 ══════════════════════════════════════════════════════════════════ */

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(`  ${String(error?.message ?? error).split('\n').join('\n  ')}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} PASS`)
if (failed > 0) process.exit(1)
