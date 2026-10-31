// composerLedger：语音组合期间的输入框 DOM 变更账本（只读取证）。
//
// 现象是「手机语音说半句就停、时好时坏、换个会话又正常」——这类中断竞争只能靠现场数字定位：
// 组合期间到底有没有人改了输入框子树、改动落没落进编辑器本体、编辑器本体有没有被换掉。
import assert from 'node:assert/strict'
import { createComposerLedger, nodeLabel, clip, LEDGER_CAP } from '../src/client/composerLedger.ts'
import { createVoiceProbe, describeVoiceSample } from '../src/client/compositionGate.ts'

let pass = 0
const ok = (name, fn) => { fn(); pass += 1; console.log('  ✓ ' + name) }

const EDITOR_SELECTOR = '[data-lexical-editor="true"], [contenteditable="true"]'
const CARD_SELECTOR = '[data-composer-card]'

const makeNode = (name, attrs = {}, parent = null) => {
  const node = {
    nodeName: name,
    isConnected: true,
    attrs,
    parent,
    getAttribute(key) { return this.attrs[key] ?? null },
    contains(other) {
      if (other === this) return true
      let cur = other
      while (cur !== null && cur !== undefined) {
        if (cur === this) return true
        cur = cur.parent
      }
      return false
    },
  }
  return node
}

const makeEnv = (options = {}) => {
  const observers = []
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.observed = 0; this.disconnects = 0; observers.push(this) }
    observe(target, config) { this.observed += 1; this.target = target; this.config = config }
    disconnect() { this.disconnects += 1 }
    fire(records) { this.callback(records) }
  }
  const editor = makeNode('DIV', { class: 'RlGAzG_editor', 'data-lexical-editor': 'true' })
  const card = makeNode('DIV', { class: 'RlGAzG_card', 'data-composer-card': 'true' })
  card.closest = (selector) => (selector === '[data-phase]'
    ? { getAttribute: (key) => (key === 'data-phase' ? (options.phase ?? 'hero') : null) }
    : null)
  let currentEditor = editor
  const doc = {
    querySelector(selector) {
      if (selector === CARD_SELECTOR) return options.card === undefined ? card : options.card
      if (selector === EDITOR_SELECTOR) return currentEditor
      return null
    },
  }
  let now = 0
  const ledger = createComposerLedger({
    doc,
    clock: () => (now += 7),
    Observer: FakeObserver,
    ...options,
  })
  return {
    ledger, observers, editor, card, doc,
    setEditor(next) { currentEditor = next },
    get observer() { return observers[0] },
  }
}

ok('nodeLabel / clip：短标签带 class 前缀，超长截断', () => {
  assert.equal(nodeLabel(makeNode('DIV', { class: 'RlGAzG_editor extra' })), 'div.RlGAzG_editor')
  assert.equal(nodeLabel(null), '?')
  assert.equal(clip('x'.repeat(60), 8), 'xxxxxxxx…')
})

ok('没有输入框就不记账：observe 一次都不调，stop 给空摘要', () => {
  const env = makeEnv({ card: null })
  env.ledger.start()
  assert.equal(env.observers.length, 0)
  const summary = env.ledger.stop()
  assert.deepEqual(summary.muts, [])
  assert.equal(summary.touched, false)
  assert.equal(summary.replaced, false)
})

ok('组合期间记账：变更签名去重、带毫秒偏移、phase 取自 [data-phase]', () => {
  const env = makeEnv({ phase: 'hero' })
  env.ledger.start()
  assert.equal(env.observer.observed, 1)
  assert.equal(env.observer.target, env.card)
  assert.equal(env.observer.config.subtree, true)
  env.observer.fire([
    { type: 'childList', target: env.card, addedNodes: [makeNode('SPAN', { class: 'RlGAzG_tip' })], removedNodes: [] },
    { type: 'childList', target: env.card, addedNodes: [makeNode('SPAN', { class: 'RlGAzG_tip' })], removedNodes: [] },
  ])
  const summary = env.ledger.stop()
  assert.equal(summary.muts.length, 1, '同样的变更只记一次')
  assert.match(summary.muts[0], /^\d+ms kids div\.RlGAzG_card \+span\.RlGAzG_tip$/)
  assert.equal(summary.phase, 'hero')
  assert.equal(summary.touched, false, '改的是卡片外壳，不是编辑器本体')
})

ok('落进编辑器本体 = touched（最可疑的一类）', () => {
  const env = makeEnv()
  env.ledger.start()
  const span = makeNode('SPAN', { class: 'RlGAzG_highlight' }, env.editor)
  env.observer.fire([{ type: 'childList', target: env.editor, addedNodes: [span], removedNodes: [] }])
  const summary = env.ledger.stop()
  assert.equal(summary.touched, true)
  assert.match(summary.muts[0], /kids div\.RlGAzG_editor \+span\.RlGAzG_highlight/)
})

ok('编辑器本体被换掉 / 脱离文档 = replaced（几乎必然中断输入法）', () => {
  const env = makeEnv()
  env.ledger.start()
  env.setEditor(makeNode('DIV', { class: 'RlGAzG_editor' }))
  assert.equal(env.ledger.stop().replaced, true, '同一位置换了新节点')

  const env2 = makeEnv()
  env2.ledger.start()
  env2.editor.isConnected = false
  assert.equal(env2.ledger.stop().replaced, true, '原节点被摘掉')

  const env3 = makeEnv()
  env3.ledger.start()
  assert.equal(env3.ledger.stop().replaced, false, '原节点还在原位 = 没换')
})

ok('记账有上限：超出 cap 的变更直接丢，且 stop 会断开观察者', () => {
  const env = makeEnv()
  env.ledger.start()
  const records = []
  for (let i = 0; i < LEDGER_CAP + 6; i += 1) {
    records.push({ type: 'attributes', target: env.card, attributeName: `data-x${i}` })
  }
  env.observer.fire(records)
  const summary = env.ledger.stop()
  assert.equal(summary.muts.length, LEDGER_CAP)
  assert.equal(env.observer.disconnects, 1)
  assert.equal(env.ledger.active(), false)
})

ok('宿主把 data-phase 翻掉 = phaseChanged（hero → 普通，整页重排的经典时机）', () => {
  const env = makeEnv({ phase: 'hero' })
  env.ledger.start()
  assert.equal(env.observers.length, 2, '卡片子树 + 宿主 phase 各一个观察者')
  assert.equal(env.ledger.stop().phaseChanged, false, '没翻就是 false')

  const env2 = makeEnv({ phase: 'hero' })
  env2.ledger.start()
  env2.observers[0].fire([{ type: 'attributes', target: env2.doc, attributeName: 'data-phase' }])
  const summary = env2.ledger.stop()
  assert.equal(summary.phaseChanged, true)
  assert.equal(summary.phase, 'hero', 'phase 记的是组合开始时的值')
})

ok('start 幂等 + stop 后能再开一轮（下一段组合重新记账）', () => {
  const env = makeEnv()
  env.ledger.start()
  env.ledger.start()
  assert.equal(env.observers.length, 2, '重复 start 不再挂第二对观察者')
  env.ledger.stop()
  env.ledger.start()
  assert.equal(env.observers.length, 4, '下一段组合重新挂')
  assert.equal(env.ledger.active(), true)
  env.ledger.stop()
})

ok('探针把现场带进样本：muts / touched / replaced / phase', () => {
  const samples = []
  const summary = { muts: ['42ms kids div.editor +span'], touched: true, replaced: true, phase: 'hero' }
  let starts = 0
  let stops = 0
  const probe = createVoiceProbe({
    doc: {},
    clock: (() => { let t = 0; return () => (t += 500) })(),
    reader: () => 0,
    ledger: { start() { starts += 1 }, stop() { stops += 1; return summary } },
    onSample: (sample) => samples.push(sample),
  })
  probe.onStart()
  probe.onEnd()
  assert.equal(starts, 1)
  assert.equal(stops, 1)
  assert.equal(samples.length, 1)
  assert.equal(samples[0].touched, true)
  assert.equal(samples[0].replaced, true)
  assert.equal(samples[0].phase, 'hero')
  assert.deepEqual(samples[0].muts, summary.muts)
  assert.equal(samples[0].kind, 'silent-short')
})

ok('可疑样本压成一行现场：种类@时长 + 标记 + 前几条变更（超长截断）', () => {
  const line = describeVoiceSample({
    ms: 1234, chars: 0, delta: 0, kind: 'interrupted', phase: 'hero', replaced: true, touched: true,
    muts: ['1ms kids div.editor +span.x', '2ms attr div.card class'],
  })
  assert.match(line, /^interrupted@1234ms phase=hero EDITOR-SWAPPED EDITOR-TOUCHED /)
  assert.match(line, /1ms kids div\.editor \+span\.x \| 2ms attr div\.card class$/)
  const long = describeVoiceSample({
    ms: 9, chars: 0, delta: 0, kind: 'silent-long', phase: '', replaced: false, touched: false,
    muts: Array.from({ length: 8 }, () => 'x'.repeat(50)),
  })
  assert.ok(long.length <= 181, '一行现场必须压短')
  assert.ok(long.endsWith('…'))
})

console.log('test-composer-ledger: PASS ' + pass + '/' + pass)
