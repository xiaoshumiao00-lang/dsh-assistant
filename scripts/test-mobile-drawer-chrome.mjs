/**
 * 抽屉 chrome 的入口回归（2026-11-03 手机端"三条横线点几次都进不去"）：
 * 用最小假 DOM 直接跑 mountDrawerChrome，钉住四件事 ——
 *   1) 点按钮（click）开抽屉，并且只翻转一次；
 *   2) 点在按钮外沿用（命中区里、按钮盒外）也能开 —— 这正是这次修的主症状；
 *   3) 指针路径开过之后，随后合成的 click 不许把它再关回去；
 *   4) 下方「对话 / 轨迹」标签条上的点击绝不能被汉堡钮抢走。
 * 真机上看不到 console，这类判定只能在 node 里用假 DOM 跑。
 */
import assert from 'node:assert/strict'

// --- 最小假 DOM ---------------------------------------------------------------
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.style = {}
    this.children = []
    this.attrs = new Map()
    this.listeners = new Map()
    this.parentElement = null
    this.rect = { left: 0, top: 0, width: 0, height: 0 }
  }

  setAttribute(name, value) { this.attrs.set(name, String(value)) }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null }
  hasAttribute(name) { return this.attrs.has(name) }
  removeAttribute(name) { this.attrs.delete(name) }

  appendChild(child) {
    this.children.push(child)
    child.parentElement = this
    return child
  }

  remove() {
    const parent = this.parentElement
    if (parent === null) return
    const index = parent.children.indexOf(this)
    if (index >= 0) parent.children.splice(index, 1)
    this.parentElement = null
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  getBoundingClientRect() { return this.rect }
  querySelector() { return null }
  querySelectorAll() { return [] }
  closest() { return null }
  contains(node) {
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }
}

globalThis.Element = FakeElement

const docListeners = new Map()
const doc = {
  body: new FakeElement('body'),
  createElement(tag) { return new FakeElement(tag) },
  addEventListener(type, fn) {
    const list = docListeners.get(type) ?? []
    list.push(fn)
    docListeners.set(type, list)
  },
  removeEventListener(type, fn) {
    const list = docListeners.get(type) ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  },
  querySelector(selector) {
    if (selector === '[data-shell-overlay]') return layer
    return null
  },
  querySelectorAll() { return [] },
}

const layer = new FakeElement('div')
const frame = new FakeElement('div')
const headerTab = new FakeElement('button')
frame.setAttribute('data-sidebar-collapsed', '') // 窄屏默认：官方侧栏还是图标 rail

let now = 1000
const win = {
  PointerEvent: function PointerEvent() {},
  performance: { now: () => now },
  requestAnimationFrame(fn) { fn(); return 1 },
}

globalThis.document = doc
globalThis.window = win

const { mountDrawerChrome } = await import('../src/client/pocket/mobile/drawer-chrome.ts')

let storageValue = null
const storage = {
  getItem: () => storageValue,
  setItem: (key, value) => { storageValue = value },
}

const opens = []
const stop = mountDrawerChrome({
  findFrame: () => frame,
  labels: { menu: '打开菜单', sessionLog: '下载会话日志' },
  onMeasure: (info) => { opens.push(info) },
  doc,
  win,
  storage,
})

const toggle = layer.children.find((el) => el.getAttribute('data-mobile-nav') === 'toggle')
const backdrop = layer.children.find((el) => el.getAttribute('data-mobile-nav') === 'backdrop')
assert.ok(toggle, '汉堡钮必须挂在 shell overlay 层里')
assert.ok(backdrop, '遮罩也要挂上（=关闭时点击穿透用的那块）')
assert.equal(frame.getAttribute('data-dshp-drawer'), 'closed', '挂载后默认是关的')
assert.equal(toggle.style.width, '44px', '按钮必须有兜底尺寸，不能退回 20px 的死角')

// 真机上的矩形：left 4 / top 4 / 44×44（手机 400px 宽）
toggle.rect = { left: 4, top: 4, width: 44, height: 44 }

const fire = (target, type, props = {}) => {
  const event = { type, target, ...props }
  // 文档级（capture）监听先跑：真机上 capture 在目标之前。
  for (const fn of docListeners.get(type) ?? []) fn(event)
  for (const fn of target?.listeners?.get(type) ?? []) fn(event)
}
const headerRow = new FakeElement('div')

const state = () => frame.getAttribute('data-dshp-drawer')

// --- 1) 直接点按钮 ------------------------------------------------------------
now += 1000
fire(toggle, 'click', { detail: 1 })
assert.equal(state(), 'open', '点按钮要能开')
assert.deepEqual(opens.map((o) => o.src), ['btn'], '打点要记下入口来源：按钮')

// 关上（点遮罩），再验证"指针路径 + 合成 click"只翻转一次
now += 1000
fire(backdrop, 'click', { detail: 1 })
assert.equal(state(), 'closed', '点遮罩要能关')

// --- 2) 点在按钮外沿（旧版本是死角）--------------------------------------------
now += 1000
fire(headerRow, 'pointerdown', { clientX: 50, clientY: 45 })
fire(headerRow, 'pointerup', { clientX: 50, clientY: 45 })
assert.equal(state(), 'open', '按钮盒外的外沿（x50 / y45）也要能开')
assert.equal(opens.at(-1).src, 'zone', '这次来源应记为命中区')

// --- 3) 指针路径之后的合成 click 不许再关回去 ----------------------------------
fire(toggle, 'click', { detail: 1 })
assert.equal(state(), 'open', '同一次点击的合成 click 必须被吞掉，不能关掉刚开的抽屉')
assert.equal(opens.length, 2, '一次点击只能产生一次开合打点')

now += 1000
fire(backdrop, 'click', { detail: 1 })
assert.equal(state(), 'closed')

// --- 4) 标签条上的点击不归汉堡钮 -----------------------------------------------
now += 1000
fire(headerTab, 'pointerdown', { clientX: 26, clientY: 58 })
fire(headerTab, 'pointerup', { clientX: 26, clientY: 58 })
assert.equal(state(), 'closed', '「对话 / 轨迹」标签条（y≈58）不能被汉堡钮抢走')
assert.equal(opens.length, 2, '抢走会多出一条开合打点')

// --- 5) 滑动不等于点击 ---------------------------------------------------------
now += 1000
fire(headerRow, 'pointerdown', { clientX: 20, clientY: 20 })
fire(headerRow, 'pointerup', { clientX: 20, clientY: 60 })
assert.equal(state(), 'closed', '往下滑 40px（滚动）不能开抽屉')

// --- 6) 老 WebView：只有 click（没有指针事件）时仍然要能开 ----------------------
now += 1000
fire(toggle, 'click', { detail: 1 })
assert.equal(state(), 'open', '没有指针事件时 click 还是要管用')

stop()
assert.equal(layer.children.length, 0, '卸载后 overlay 层里不留我们的元素')
console.log('ok test-mobile-drawer-chrome')
