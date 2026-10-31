// 组合输入 / 抽屉动画闸门的回归测试（纯 Node，不依赖 DOM）。
// 覆盖：让路判据、有界轮询的观察者闸门、补丁节流的重试语义、绝不碰输入框的判据。
import assert from 'node:assert/strict'
import {
  createGate,
  createGatedThrottle,
  installCompositionGate,
  insideComposer,
  COMPOSITION_GRACE_MS,
  LONG_COMPOSITION_MS,
} from '../src/client/compositionGate.ts'
import { startFeaturePresenceWatch } from '../src/client/pocket/mobile/featurePresence.mjs'

let pass = 0
const ok = (label, fn) => {
  fn()
  pass += 1
  console.log('  ✓ ' + label)
}

// ── 1. 闸门本身：假时钟，判据要精确 ─────────────────────────────
ok('打字期间 isPaused 为真，组合结束后还留 COMPOSITION_GRACE_MS 的收尾窗', () => {
  let t = 1000
  const gate = createGate(() => t)
  assert.equal(gate.isPaused(), false)
  gate.beginComposition()
  assert.equal(gate.isComposing(), true)
  assert.equal(gate.isPaused(), true)
  gate.endComposition()
  assert.equal(gate.isComposing(), false)
  assert.equal(gate.isPaused(), true, '组合结束后立刻仍算让路（引擎常在之后才补发 keydown）')
  t += COMPOSITION_GRACE_MS + 1
  assert.equal(gate.isPaused(), false)
})

ok('pause(ms) 覆盖交互窗口，且不会被后来的短窗口缩短', () => {
  let t = 0
  const gate = createGate(() => t)
  gate.pause(1000)
  t = 500
  gate.pause(10)
  assert.equal(gate.isPaused(), true)
  t = 999
  assert.equal(gate.isPaused(), true)
  t = 1000
  assert.equal(gate.isPaused(), false)
})

ok('tryRun 只在没让路时执行，让路时返回 undefined（调用方不必自己判）', () => {
  let t = 0
  const gate = createGate(() => t)
  gate.pause(100)
  assert.equal(gate.tryRun(() => 'x'), undefined)
  t = 100
  assert.equal(gate.tryRun(() => 'x'), 'x')
})

ok('引擎不发 compositionend 的兜底：超过 LONG_COMPOSITION_MS 自动放行', () => {
  let t = 0
  const gate = createGate(() => t)
  gate.beginComposition()
  t = LONG_COMPOSITION_MS - 1
  assert.equal(gate.isPaused(), true, '长语音组合期间仍然让路')
  t = LONG_COMPOSITION_MS + 1
  assert.equal(gate.isPaused(), false, '超时后必须放行，否则补丁器永久锁死')
  assert.equal(gate.isComposing(), false)
})

ok('installCompositionGate 接事件 / 卸事件并复位', () => {
  const bag = new Map()
  const doc = {
    addEventListener: (name, fn, capture) => { bag.set(name + '|' + capture, fn) },
    removeEventListener: (name, fn, capture) => { assert.equal(bag.get(name + '|' + capture), fn); bag.delete(name + '|' + capture) },
  }
  let t = 0
  const gate = createGate(() => t)
  const off = installCompositionGate(gate, doc)
  assert.equal(bag.size, 2, '必须用捕获阶段：宿主自己的 composer 监听在先')
  gate.beginComposition()
  assert.equal(gate.isComposing(), true)
  off()
  assert.equal(bag.size, 0)
  assert.equal(gate.isPaused(), false, '卸载时复位闸门')
  assert.equal(typeof installCompositionGate(gate, null), 'function')
})

// ── 2. 补丁节流：让路时不跑也不丢 ─────────────────────────────
const makeFakeClockTimers = () => {
  const queued = []
  return {
    queue: queued,
    schedule: (fn, ms) => { queued.push({ fn, ms }); return queued.length },
    cancel: (handle) => { queued.splice(handle - 1, 1) },
    drain: () => { const items = queued.splice(0, queued.length); items.forEach((it) => it.fn()); return items },
  }
}

ok('到点了但正在让路 → 排下一次，不执行也不清空调用方的状态', () => {
  let t = 0
  const gate = createGate(() => t)
  const timers = makeFakeClockTimers()
  let runs = 0
  const schedule = createGatedThrottle({
    run: () => { runs += 1 },
    gate,
    waitMs: 300,
    skipMs: 400,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  gate.beginComposition()
  schedule()
  timers.drain()
  assert.equal(runs, 0, '用户在输入框里打字时绝不跑')
  assert.equal(timers.queue.length, 1, '必须自己重来')
  assert.equal(timers.queue[0].ms, 400)
  gate.endComposition()
  assert.equal(gate.isPaused(), true, '组合结束后仍在收尾窗内')
  // 假时钟走过收尾窗：只有这样才该真的开始跑
  t += COMPOSITION_GRACE_MS + 1
  timers.drain()
  assert.equal(runs, 1)
})

ok('连续让路有上限：maxSkips 用尽后强跑一次，不让某个补丁需求被无限推迟', () => {
  let t = 0
  const gate = createGate(() => t)
  const timers = makeFakeClockTimers()
  let runs = 0
  const schedule = createGatedThrottle({
    run: () => { runs += 1 },
    gate,
    waitMs: 100,
    skipMs: 100,
    maxSkips: 2,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  gate.beginComposition()
  schedule()
  timers.drain() // skip 1
  timers.drain() // skip 2
  timers.drain() // 上限到了 → 这一轮必须跑
  assert.equal(runs, 1)
  gate.endComposition()
})

ok('gate 为空 = 纯节流（照旧每 waitMs 合并一次，不改变原有行为）', () => {
  const timers = makeFakeClockTimers()
  let runs = 0
  const schedule = createGatedThrottle({ run: () => { runs += 1 }, gate: null, waitMs: 300, schedule: timers.schedule, cancel: timers.cancel })
  schedule()
  schedule()
  schedule()
  assert.equal(timers.queue.length, 1, '同一批次只排一个 timer')
  timers.drain()
  assert.equal(runs, 1)
})

// ── 3. 「绝不碰输入框」判据 ────────────────────────────────────
const fakeEl = (path) => ({ closest: (sel) => (path.includes(sel) ? { matched: true } : null) })

const COMPOSER_HOOK = '[data-composer-card]'
const EDITOR_HOOK = '[contenteditable="true"]'

ok('insideComposer：元素在输入框 subtree 里 → true', () => {
  assert.equal(insideComposer(fakeEl([COMPOSER_HOOK])), true)
  assert.equal(insideComposer(fakeEl([])), false)
  assert.equal(insideComposer(null), false)
})

ok('insideComposer：文本节点走 parentElement（Lexical 每个字都换文本节点）', () => {
  const textNode = { parentElement: fakeEl([COMPOSER_HOOK]) }
  assert.equal(insideComposer(textNode), true)
  assert.equal(insideComposer({ parentElement: fakeEl([]) }), false)
  assert.equal(insideComposer({}), false, '没有 closest 也没有 parentElement → 不认定在输入框内')
})

ok('insideComposer 可换判据（编辑器本体用 contenteditable）', () => {
  assert.equal(insideComposer(fakeEl([EDITOR_HOOK]), EDITOR_HOOK), true)
  assert.equal(insideComposer(fakeEl([COMPOSER_HOOK]), EDITOR_HOOK), false)
})

// ── 4. 宿主特性存在性闸门：没有那两列就不留整页观察者 ──────────
ok('纯 DSH 宿主（查不到 [data-aionui-*]）：窗口内轮询，到期后彻底不观察', () => {
  const doc = { querySelector: () => null }
  const queued = []
  let t = 0
  const watch = startFeaturePresenceWatch({
    selectors: ['[data-aionui-explorer-col]'],
    doc,
    pollMs: 100,
    timeoutMs: 300,
    // 假时钟：每次排下一次都把时钟推过 ms（等价于真 setTimeout 会等 ms）
    schedule: (fn, ms) => { t += ms; queued.push(fn); return queued.length },
    cancel: (handle) => { queued.pop() },
    now: () => t,
  })
  assert.equal(watch.active(), false)
  // 排入 = 立刻查一次（0ms）→ 100 → 200 → 300：窗口内共 4 次确认
  for (let i = 0; i < 6; i += 1) {
    const items = queued.splice(0, queued.length)
    items.forEach((it) => it())
    if (queued.length === 0) break
  }
  assert.equal(watch.active(), false, '找不到就不该挂任何观察者')
  assert.equal(queued.length, 0, '到期必须停轮，不能留着一排 timer')
  watch.dispose()
})

ok('宿主真有那两列：立刻挂上真观察者，并且只挂一次', () => {
  const doc = { querySelector: () => ({ tag: 'column' }) }
  const queued = []
  let installs = 0
  let disposed = 0
  const watch = startFeaturePresenceWatch({
    selectors: ['[data-aionui-explorer-col]'],
    doc,
    schedule: (fn, ms) => { queued.push({ fn, ms }); return queued.length },
    cancel: (handle) => { queued.splice(handle - 1, 1) },
    onActive: () => { installs += 1; return () => { disposed += 1 } },
  })
  queued.splice(0, queued.length).forEach((it) => it.fn())
  assert.equal(installs, 1)
  assert.equal(watch.active(), true)
  watch.recheck()
  assert.equal(installs, 1, 'recheck 不能把观察者挂第二遍')
  watch.dispose()
  assert.equal(disposed, 1)
})

ok('recheck：宿主后来才长出那两列（第三方套件晚挂载）→ 补挂观察者', () => {
  let has = false
  const queued = []
  let installs = 0
  const watch = startFeaturePresenceWatch({
    selectors: ['[data-aionui-preview-col]'],
    doc: { querySelector: () => (has ? { tag: 'preview' } : null) },
    pollMs: 50,
    timeoutMs: 200,
    schedule: (fn, ms) => { queued.push({ fn, ms }); return queued.length },
    cancel: (handle) => { queued.splice(handle - 1, 1) },
    onActive: () => { installs += 1 },
  })
  queued.splice(0, queued.length).forEach((it) => it.fn())
  assert.equal(installs, 0)
  has = true
  assert.equal(watch.recheck(), true)
  assert.equal(installs, 1)
  watch.dispose()
})

ok('存在性判据可注入（不依赖真 DOM）+ 选择器空表不挂载', () => {
  let installs = 0
  const watch = startFeaturePresenceWatch({
    selectors: [],
    exists: () => true,
    schedule: () => 0,
    cancel: () => {},
    onActive: () => { installs += 1 },
  })
  assert.equal(watch.active(), false, '没有判据选择器就不该挂任何东西')
  watch.dispose()
  assert.equal(installs, 0)
})

// ── 5. 抽屉里那颗「打开侧边栏」必须被收掉（只在抽屉那一列里）──
import { MOBILE_CSS } from '../src/client/pocket/mobile/mobile.css.ts'
import { createDrawerController } from '../src/client/pocket/mobile/drawer-state.mjs'
import { domGate } from '../src/client/compositionGate.ts'

ok('开抽屉 = 插件的扫描/补丁一起让路；且照旧「只升到展开，绝不降回收起」', () => {
  domGate.reset()
  const attrs = new Map([['data-sidebar-collapsed', '']])
  const frame = {
    hasAttribute: (name) => attrs.has(name),
    setAttribute: (name, value) => { attrs.set(name, value) },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    removeAttribute: (name) => { attrs.delete(name) },
  }
  let upgrades = 0
  const controller = createDrawerController({
    findFrame: () => frame,
    expandSidebar: () => { upgrades += 1 },
    storage: null,
  })
  assert.equal(controller.open(), true)
  assert.equal(upgrades, 1, '官方侧栏还是图标 rail → 补做一次升级')
  assert.equal(domGate.isPaused(), true, '开抽屉后动画窗口内插件必须让路')
  assert.equal(frame.getAttribute('data-dshp-drawer'), 'open')
  assert.equal(controller.close(), false)
  assert.equal(upgrades, 1, '关抽屉绝不降回 collapsed（会和用户自己的切换打架的老 bug）')
  domGate.reset()
})

ok('抽屉布局收掉官方 logoRow 的 toggle（两条判据都限定在抽屉那一列内）', () => {
  assert.match(MOBILE_CSS, /\[data-mobile-nav="frame"\] > :first-child \[data-window-drag\] button\[class\*="_toggle"\]/)
  assert.match(MOBILE_CSS, /\[data-window-drag\] button\[aria-label="打开侧边栏"\]/)
  assert.match(MOBILE_CSS, /\[data-window-drag\] button\[aria-label="收起侧边栏"\]/)
  // 强制手机布局那份里也要有（scopeRules 加前缀后规则照样存在）
  const scoped = MOBILE_CSS.split('\n').filter((line) => line.includes('body[data-dsh-pocket-layout="mobile"]') && line.includes('_toggle'))
  assert.ok(scoped.length >= 1, '改造 #4：窄屏规则文本要输出两遍，强制手机布局同样收掉')
})

ok('收按钮的规则绝不落在输入框 / 会话列表上（只限定 [data-window-drag] 那条）', () => {
  const selectorLines = MOBILE_CSS.split('\n').filter((line) => line.includes('_toggle') && line.trim().endsWith('{'))
  assert.ok(selectorLines.length >= 1)
  for (const line of selectorLines) {
    assert.ok(line.includes('[data-window-drag]'), '必须限定在官方 logoRow 里面：' + line.trim())
    assert.ok(line.includes('[data-mobile-nav="frame"]'), '必须限定在抽屉那一列里面：' + line.trim())
    assert.ok(!line.includes('contenteditable'), '不能拿它去遮编辑器本体')
  }
})

// ── 5. 语音探针：把「说几个词就自己停」变成数字 ────────────────
import {
  createVoiceProbe,
  classifyCompositionSample,
  composerTextLength,
  setVoiceReporter,
  hasVoiceReporter,
  VOICE_LONG_MS,
  VOICE_SILENT_MS,
} from '../src/client/compositionGate.ts'

ok('归类：长段写进去 / 短段写进去 / 说了很久不进字 / 短组合不进字', () => {
  assert.equal(classifyCompositionSample(VOICE_LONG_MS + 1, 12), 'long-typed')
  assert.equal(classifyCompositionSample(900, 3), 'typed')
  assert.equal(classifyCompositionSample(VOICE_SILENT_MS + 1, 0), 'silent-long')
  assert.equal(classifyCompositionSample(200, 0), 'silent-short')
})

ok('探针只在边界读一次：组合时长 + 进字增量，绝不写 DOM', () => {
  let chars = 0
  const reads = []
  const samples = []
  const probe = createVoiceProbe({
    doc: {},
    clock: (() => { let t = 0; return () => (t += 1000) })(),
    reader: () => { reads.push(chars); return chars },
    onSample: (sample) => samples.push(sample),
  })
  probe.onStart()
  chars = 7 // 语音一边说一边进字：7 个字
  probe.onEnd()
  assert.equal(samples.length, 1)
  assert.equal(samples[0].kind, 'typed')
  assert.equal(samples[0].delta, 7)
  assert.equal(reads.length, 2, '只在该读的时候读（start 一次、end 一次）')
  probe.dispose()
})

ok('没等到 compositionend 就再来一段 = 那段被中止（interrupted）', () => {
  const samples = []
  const probe = createVoiceProbe({
    doc: {},
    clock: (() => { let t = 0; return () => (t += 1000) })(),
    reader: () => 0,
    onSample: (sample) => samples.push(sample),
  })
  probe.onStart()
  probe.onStart() // 新的一段开始：上一段没有结束事件
  assert.equal(samples.length, 1)
  assert.equal(samples[0].kind, 'interrupted')
  probe.onEnd()
  assert.equal(samples.length, 2)
  probe.dispose()
})

ok('没人接样本就不读 DOM（探针在手机布局之外等于零成本）', () => {
  assert.equal(hasVoiceReporter(), false)
  let reads = 0
  const probe = createVoiceProbe({ doc: {}, reader: () => { reads += 1; return 0 } })
  probe.onStart()
  probe.onEnd()
  assert.equal(reads, 0, '默认没有 reporter：不读整页')
  const seen = []
  setVoiceReporter((sample) => { seen.push(sample) })
  assert.equal(hasVoiceReporter(), true)
  probe.onStart()
  probe.onEnd()
  assert.equal(reads, 2, '接上 reporter 才开始读')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'silent-short')
  setVoiceReporter(null)
  assert.equal(hasVoiceReporter(), false)
  probe.dispose()
})

ok('installCompositionGate 把样本送给 reporter（走的是同一对捕获阶段监听）', () => {
  const bag = new Map()
  let chars = 0
  const doc = {
    addEventListener: (name, fn, capture) => { bag.set(`${name}|${capture}`, fn) },
    removeEventListener: (name, fn, capture) => { bag.delete(`${name}|${capture}`) },
    querySelector: () => ({ textContent: 'x'.repeat(chars) }),
  }
  const seen = []
  setVoiceReporter((sample) => { seen.push(sample) })
  const gate = createGate(() => 0)
  const off = installCompositionGate(gate, doc)
  const start = bag.get('compositionstart|true')
  const end = bag.get('compositionend|true')
  start()
  assert.equal(gate.isComposing(), true, '闸门仍然照常生效')
  chars = 11 // 组合期间：语音一边说一边往输入框里写字
  end()
  assert.equal(gate.isComposing(), false)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].delta, 11)
  assert.equal(seen[0].kind, 'typed')
  off()
  setVoiceReporter(null)
  assert.equal(bag.size, 0)
})

ok('composerTextLength：拿不到输入框就报 0，绝不出错', () => {
  assert.equal(composerTextLength(null), 0)
  assert.equal(composerTextLength({}), 0)
  assert.equal(composerTextLength({ querySelector: () => null }), 0)
  assert.equal(composerTextLength({ querySelector: () => { throw new Error('宿主查询炸了') } }), 0)
  assert.equal(composerTextLength({ querySelector: () => ({ textContent: '中文abc' }) }), 5)
})

// ── 6. 语音汇总：可疑中止立刻发，正常打字每 20 段合并发一次 ────
import { createVoiceTally, VOICE_TALLY_BATCH } from '../src/client/compositionGate.ts'

const sampleOf = (kind, ms, delta) => ({ ms, chars: delta, delta, kind })

ok('汇总计数：段数 / 各类计数 / 字数累加 / 最长组合时长', () => {
  const tally = createVoiceTally()
  assert.equal(tally.bump(sampleOf('typed', 300, 5)), false)
  assert.equal(tally.bump(sampleOf('long-typed', 6000, 120)), false)
  assert.equal(tally.bump(sampleOf('silent-short', 200, 0)), false)
  const snapshot = tally.snapshot()
  assert.equal(snapshot.n, 3)
  assert.equal(snapshot.typed, 1)
  assert.equal(snapshot.longTyped, 1)
  assert.equal(snapshot.silentShort, 1)
  assert.equal(snapshot.chars, 125, '字数只累真正的增量')
  assert.equal(snapshot.maxMs, 6000)
  tally.reset()
  assert.equal(tally.snapshot().n, 0)
})

ok('可疑中止（interrupted / silent-long）必须立刻上报，别等攒够 20 段', () => {
  const tally = createVoiceTally()
  assert.equal(tally.bump(sampleOf('interrupted', 1200, 0)), true)
  assert.equal(tally.bump(sampleOf('silent-long', 4000, 0)), true)
})

ok('正常打字每 20 段合并发一次：前 19 段都不发', () => {
  const tally = createVoiceTally()
  for (let i = 0; i < VOICE_TALLY_BATCH - 1; i += 1) {
    assert.equal(tally.bump(sampleOf('typed', 120, 2)), false, `第 i=${i + 1} 段不该发`)
  }
  assert.equal(tally.bump(sampleOf('typed', 120, 2)), true)
  assert.equal(tally.snapshot().n, VOICE_TALLY_BATCH, '汇总器自己不重置：发出去由调用方重置')
  tally.reset()
  assert.equal(tally.bump(sampleOf('typed', 120, 2)), false, '重置后重新攒够 20 段才再发一条')
})

console.log('test-composition-gate: PASS ' + pass + '/' + pass)
