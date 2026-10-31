/** 底部悬浮面板避让扫描回归：node scripts/test-bottom-overlay.mjs
 *  盯的是「判定公式与原实现一字一样 + 扫描被分片 + 轮询会退避」这三件事。 */
import assert from 'node:assert/strict'
import { measureOverlap, maxOverlap, shouldApplyInset, geometryPass, stylePass, createBottomOverlayScanner, OVERLAY_CHUNK, OVERLAY_FAST_MS, OVERLAY_IDLE_MS, OVERLAY_MAX_RAISE, OVERLAY_EPSILON } from '../src/client/bottomOverlay.ts'

const cases = []
const ctx = { selfLeft: 100, selfRight: 300, naturalBottom: 700, regionTop: 500 }
const rect = (top, bottom, extra = {}) => ({ left: 10, right: 200, top, bottom, width: 120, height: bottom - top, ...extra })
const style = (extra = {}) => ({ position: 'fixed', visibility: 'visible', opacity: 1, ...extra })
const need = (r, s) => measureOverlap(r, s, ctx)

// ── 判定公式：逐条对着原实现核 ──────────────────────────────
cases.push(['重叠的 fixed 面板：抬升 = naturalBottom - top + 8（与原公式一致）', () => {
  const r = rect(640, 690)
  assert.equal(need(r, style()), 700 - 640 + 8)
}])

cases.push(['抬升上限 340px（原实现硬上限）', () => {
  // 一个从很高处就开始的面板：按公式该抬 698px，必须钳到 340
  const wideCtx = { selfLeft: 100, selfRight: 300, naturalBottom: 700, regionTop: 0 }
  assert.equal(measureOverlap(rect(10, 690, { height: 680, width: 120 }), style(), wideCtx), OVERLAY_MAX_RAISE)
  assert.equal(OVERLAY_MAX_RAISE, 340)
  // 几何门槛与样式门槛的拆分口径与原实现一致：先 rect 后 style
  assert.equal(geometryPass(rect(640, 690), ctx), true)
  assert.equal(geometryPass(rect(640, 690, { position: 'absolute' }), ctx), true, 'geometryPass 不看样式）')
}])

cases.push(['不重叠 / 落在自然位置之下：不抬（原实现 r.top >= naturalBottom + 4 直接跳过）', () => {
  assert.equal(need(rect(704, 760), style()), 0)
  assert.equal(need(rect(720, 780), style()), 0)
}])

cases.push(['重叠阈值：overlap > 8 才算；抬高不足 16 的短节点一律不算', () => {
  // top=695 且 bottom=699：重叠只有 4px → 不抬（原实现 overlap > 8 才算）
  assert.equal(need(rect(695, 702, { height: 16 }), style()), 0, '重叠 7px ≤ 8）')
  // top=690（足够高的面板）：重叠 110px → 抬 18px（700-690+8）
  assert.equal(need(rect(690, 800), style()), 18)
  assert.equal(need(rect(684, 800), style()), 24)
  // 短节点（高 14 < 16）即便重叠很大也不参与：原实现第一条尺寸门槛
  assert.equal(need(rect(660, 674), style()), 0, '高不足 16）')
}])

cases.push(['几何过滤逐条与原实现一致（尺寸 / 区域顶 / 左列范围）', () => {
  assert.equal(need(rect(640, 675, { width: 39 }), style()), 0, '宽不足 40）')
  assert.equal(need(rect(640, 655, { height: 15, bottom: 655 }), style()), 0, '高不足 16）')
  assert.equal(need({ ...rect(480, 520), top: 480 }, style()), 0, 'top < regionTop）')
  assert.equal(need({ ...rect(640, 690), left: 81 }, style()), 0, 'left > 80）')
  assert.equal(need({ ...rect(640, 690), right: 40 }, style()), 0, 'right < selfLeft-8）')
  assert.equal(need({ ...rect(640, 690), left: 320 }, style()), 0, 'left > selfRight+8）')
}])

cases.push(['样式门槛与原实现一致（非 fixed / hidden / opacity 0 一律不算）', () => {
  const r = rect(640, 690)
  assert.equal(need(r, style({ position: 'absolute' })), 0)
  assert.equal(need(r, style({ visibility: 'hidden' })), 0)
  assert.equal(need(r, style({ opacity: 0 })), 0)
  assert.equal(need(r, style({ opacity: 0.4 })), 68, '可见半透明仍算）')
}])

cases.push(['一批候选取最大值（分片累加语义）', () => {
  const items = [
    { rect: rect(640, 690), style: style() },
    { rect: rect(660, 700), style: style() },
    { rect: rect(600, 630), style: style() },
  ]
  assert.equal(maxOverlap(items, ctx), 700 - 600 + 8 - 0)
  assert.ok(maxOverlap(items, ctx) > 0)
}])

cases.push(['setState 门槛：变化不足 2px 不动（原实现 < 2 保留 prev）', () => {
  assert.equal(OVERLAY_EPSILON, 2)
  assert.equal(shouldApplyInset(100, 101), false)
  assert.equal(shouldApplyInset(100, 100), false)
  assert.equal(shouldApplyInset(100, 98), true)
  assert.equal(shouldApplyInset(0, 8), true)
}])

// ── 跑法：分片 / 退避 / 让路 / kick ────────────────────────
/** 造一个可注入的假环境：N 个候选、其中一个是真要避让的面板 */
function fakeWorld(count, { withPanel = true } = {}) {
  const frames = []
  const timeouts = []
  const observed = []
  const calls = { insets: [], rectCount: 0, styleCount: 0 }
  const panel = {
    isConnected: true,
    getBoundingClientRect: () => { calls.rectCount++; return { left: 10, right: 200, top: 640, bottom: 690, width: 190, height: 50 } },
  }
  const junk = Array.from({ length: count }, () => ({
    isConnected: true,
    getBoundingClientRect: () => { calls.rectCount++; return { left: 900, right: 980, top: 20, bottom: 90, width: 80, height: 70 } },
  }))
  const root = { isConnected: true, getBoundingClientRect: () => ({ left: 100, right: 300, top: 690, bottom: 700, width: 200, height: 10 }) }
  const win = {
    innerHeight: 800,
    getComputedStyle: (el) => {
      calls.styleCount++
      const fixed = el === panel
      return { position: fixed ? 'fixed' : 'static', visibility: 'visible', opacity: 1 }
    },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length },
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const doc = {
    visibilityState: 'visible',
    body: {
      observe: () => {},
    },
  }
  const Observer = class {
    constructor(cb) { this.cb = cb; observed.push(this) }
    observe() { this.observed = true }
    disconnect() { this.disconnected = true }
  }
  const api = {
    frames,
    timeouts,
    calls,
    win,
    doc,
    Observer,
    observed,
    panel,
    root,
    candidates: () => (withPanel ? [ ...junk, panel ] : junk),
    drainFrames() {
      const queued = frames.splice(0, frames.length)
      queued.forEach((fn) => fn())
      return queued.length
    },
    fireTimeout(index = 0) {
      const t = timeouts.splice(index, 1)[0]
      if (t) t.fn()
      return t
    },
  }
  return api
}

cases.push(['扫描按帧分片：不一次性量完整页（每帧不超过 OVERLAY_CHUNK）', () => {
  const world = fakeWorld(1200)
  const insets = []
  const scanner = createBottomOverlayScanner({
    candidates: world.candidates,
    root: () => world.root,
    inset: () => 0,
    applyInset: (n) => insets.push(n),
    doc: world.doc,
    win: world.win,
    Observer: world.Observer,
    scheduleFrame: (fn) => { world.frames.push(fn); return world.frames.length },
    cancelFrame: () => {},
    setTimeoutFn: (fn, ms) => { world.timeouts.push({ fn, ms }); return world.timeouts.length },
    clearTimeoutFn: () => {},
  })
  world.timeouts.length = 0
  scanner.kick()
  // 三帧收完（1200+1 候选 / 400 每帧）：每帧的活不超过 OVERLAY_CHUNK
  let frame = 0
  while (world.frames.length > 0) {
    world.drainFrames()
    frame++
    assert.ok(frame <= 6, '分片帧数应在预期内（got ' + frame + '）')
  }
  assert.equal(frame, 3, '1200 个候选按 400 一片 = 3 帧')
  assert.equal(insets.length, 1, '整段扫描只 applyInset 一次')
  assert.equal(insets[0], 700 - 640 + 8, '避让值仍是那块面板的抬升')
  assert.equal(world.calls.rectCount >= 1201, true, '每个候选只量一次）')
  scanner.dispose()
}])

cases.push(['每帧候选数就是 OVERLAY_CHUNK（切片长度）', () => {
  const world = fakeWorld(8)
  const scanner = createBottomOverlayScanner({
    candidates: world.candidates,
    root: () => world.root,
    inset: () => 0,
    applyInset: () => {},
    doc: world.doc,
    win: world.win,
    Observer: world.Observer,
    chunk: 3,
    scheduleFrame: (fn) => { world.frames.push(fn); return 1 },
    cancelFrame: () => {},
    setTimeoutFn: (fn, ms) => { world.timeouts.push({ fn, ms }); return 1 },
    clearTimeoutFn: () => {},
  })
  world.timeouts.length = 0
  const startRects = world.calls.rectCount
  scanner.kick()
  // kick 里先同步量完第一片，剩下的排进后续帧
  const firstChunk = world.calls.rectCount - startRects
  const lengths = [ firstChunk ]
  while (world.frames.length > 0) {
    const before = world.calls.rectCount
    world.drainFrames()
    lengths.push(world.calls.rectCount - before)
  }
  assert.ok(lengths.every((n) => n <= 3 && n > 0), '每帧不超过 chunk：' + JSON.stringify(lengths))
  assert.equal(lengths.reduce((sum, n) => sum + n, 0), 9, '9 个候选（8 个杂项 + 1 块面板）全被量到）')
  assert.ok(lengths.length >= 3, '按 3 一片要分多段跑（不再一次量完整页））')
  assert.equal(OVERLAY_CHUNK, 400)
  scanner.dispose()
}])

cases.push(['让路（输入框组合中 / 抽屉开合）时跳过这一轮但定时器照旧续上（不会永久停摆）', () => {
  const world = fakeWorld(10)
  let paused = true
  const scanner = createBottomOverlayScanner({
    candidates: world.candidates,
    root: () => world.root,
    inset: () => 0,
    applyInset: () => {},
    blocked: () => paused,
    doc: world.doc,
    win: world.win,
    Observer: world.Observer,
    scheduleFrame: (fn) => { world.frames.push(fn); return 1 },
    cancelFrame: () => {},
    setTimeoutFn: (fn, ms) => { world.timeouts.push({ fn, ms }); return 1 },
    clearTimeoutFn: () => {},
  })
  let fired = 0
  for (let i = 0; i < 4; i++) {
    const before = world.calls.rectCount
    world.fireTimeout(0)
    fired++
    assert.equal(world.calls.rectCount, before, '让路期间不量任何节点）')
    assert.ok(world.timeouts.length > 0, '跳过一轮也必须把定时器续上）')
  }
  paused = false
  world.fireTimeout(0)
  assert.ok(world.calls.rectCount > 0, '闸门松开后立刻正常量）')
  scanner.dispose()
}])

cases.push(['稳定态退到低频、找到面板保持高频（轮询自适应）', () => {
  const world = fakeWorld(4, { withPanel: true })
  const make = () => {
    const scanner = createBottomOverlayScanner({
      candidates: world.candidates,
      root: () => world.root,
      inset: () => 0,
      applyInset: () => {},
      doc: world.doc,
      win: world.win,
      Observer: world.Observer,
      scheduleFrame: (fn) => { world.frames.push(fn); return 1 },
      cancelFrame: () => {},
      setTimeoutFn: (fn, ms) => { world.timeouts.push({ fn, ms }); return 1 },
      clearTimeoutFn: () => {},
    })
    world.timeouts.length = 0
    return scanner
  }
  const a = make()
  a.kick()
  while (world.frames.length) world.drainFrames()
  assert.equal(world.timeouts.length >= 1, true, '扫完就重新挂上下一次）')
  assert.equal(world.timeouts[0].ms, OVERLAY_FAST_MS, '有面板 → 保持快轮）')
  a.dispose()

  const quiet = fakeWorld(4, { withPanel: false })
  const b = createBottomOverlayScanner({
    candidates: quiet.candidates,
    root: () => quiet.root,
    inset: () => 0,
    applyInset: () => {},
    doc: quiet.doc,
    win: quiet.win,
    Observer: quiet.Observer,
    scheduleFrame: (fn) => { quiet.frames.push(fn); return 1 },
    cancelFrame: () => {},
    setTimeoutFn: (fn, ms) => { quiet.timeouts.push({ fn, ms }); return 1 },
    clearTimeoutFn: () => {},
  })
  quiet.timeouts.length = 0
  b.kick()
  while (quiet.frames.length) quiet.drainFrames()
  assert.equal(quiet.timeouts[0].ms, OVERLAY_IDLE_MS, '没找到面板 → 退到兜底轮）')
  b.dispose()
  assert.ok(OVERLAY_IDLE_MS > OVERLAY_FAST_MS, '兜底轮必须比快轮稀）')
}])

cases.push(['kick 会掐掉在飞的半段扫描并立刻重来', () => {
  const world = fakeWorld(900)
  const insets = []
  const scanner = createBottomOverlayScanner({
    candidates: world.candidates,
    root: () => world.root,
    inset: () => 0,
    applyInset: (n) => insets.push(n),
    doc: world.doc,
    win: world.win,
    Observer: world.Observer,
    scheduleFrame: (fn) => { world.frames.push(fn); return 1 },
    cancelFrame: () => {},
    setTimeoutFn: (fn, ms) => { world.timeouts.push({ fn, ms }); return 1 },
    clearTimeoutFn: () => {},
  })
  world.timeouts.length = 0
  scanner.scanOnce()
  world.drainFrames()
  assert.equal(insets.length, 0, '半段扫描还没收口）')
  scanner.kick()
  while (world.frames.length) world.drainFrames()
  assert.equal(insets.length, 1, 'kick 后整段重来并收口）')
  scanner.dispose()
  assert.equal(world.observed.every((o) => o.disconnected === true), true, 'dispose 必须断开观察者）')
}])

cases.push(['隐藏页不扫（定时器仍续上），宽度不足 10 的区块不扫', () => {
  const world = fakeWorld(50)
  world.doc.visibilityState = 'hidden'
  let applied = 0
  const scanner = createBottomOverlayScanner({
    candidates: world.candidates,
    root: () => world.root,
    inset: () => 0,
    applyInset: () => { applied++ },
    doc: world.doc,
    win: world.win,
    Observer: world.Observer,
    scheduleFrame: (fn) => { world.frames.push(fn); return 1 },
    cancelFrame: () => {},
    setTimeoutFn: (fn, ms) => { world.timeouts.push({ fn, ms }); return 1 },
    clearTimeoutFn: () => {},
  })
  world.timeouts.length = 0
  const before = world.calls.rectCount
  scanner.kick()
  assert.equal(world.calls.rectCount, before, '隐藏页不量任何节点）')
  assert.ok(world.timeouts.length > 0, '隐藏页也要把定时器续上）')
  scanner.dispose()
}])

cases.push(['被移除的节点不再参与这一段的避让计算', () => {
  const gone = { isConnected: false, getBoundingClientRect: () => { throw new Error('已脱离文档的节点不该再被量') } }
  const live = { isConnected: true, getBoundingClientRect: () => ({ left: 10, right: 200, top: 640, bottom: 690, width: 190, height: 50 }) }
  const win = {
    innerHeight: 800,
    getComputedStyle: () => ({ position: 'fixed', visibility: 'visible', opacity: 1 }),
    requestAnimationFrame: () => null,
    cancelAnimationFrame: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const root = { isConnected: true, getBoundingClientRect: () => ({ left: 100, right: 300, top: 690, bottom: 700, width: 200, height: 10 }) }
  const scanner = createBottomOverlayScanner({
    candidates: () => [ gone, live ],
    root: () => root,
    inset: () => 0,
    applyInset: () => {},
    doc: { visibilityState: 'visible', body: {} },
    win,
    Observer: undefined,
    observeStyle: false,
    scheduleFrame: () => null,
    cancelFrame: () => {},
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  })
  scanner.scanOnce()
  scanner.dispose()
}])

let failed = 0
for (const [ name, fn ] of cases) {
  try { fn(); console.log('  ok   ' + name) } catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err?.message || err)) }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
