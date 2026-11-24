/**
 * 回归测试 — 「点会话行进详情，页面还是暗的，要再点一下才正常」（2026-11-25 用户报障）。
 *
 * 真凶不是宿主 0.2.2 的 div.drawerMask，而是**我们自己的** `[data-mobile-nav="backdrop"]`
 * （rgba(0,0,0,.45) 全屏）：抽屉 chrome 从 React overlay 改写成纯 DOM 之后，「点导航行
 * 就关抽屉」这条规则只活在已不再渲染的 MobileNavOverlay.tsx 里，文档级 pointerdown 又
 * 对「抽屉内的点击」一律放行 —— 于是点会话行 / 新会话之后 marker 仍是 open，那块 .45
 * 压暗层就一直盖在刚打开的会话详情上，直到用户再点一下「抽屉外」才被关掉。
 *
 * 本测试钉三件事：
 *   A. 状态机（node 最小假 DOM，直接跑 mountDrawerChrome）：
 *      1) 抽屉关着：点会话行不产生任何压暗层、marker 不变；
 *      2) 抽屉开着：点会话行（导航）→ marker 立刻 closed + backdrop display:none；
 *      3) 抽屉开着：点行内 kebab（NAV_EXCLUDE）不算导航 → 抽屉必须留着；
 *      4) 抽屉开着：点抽屉里的非导航空白处 → 不关（别把「点哪都关」当成修好）；
 *      5) 抽屉开着：点抽屉外 → 照旧关（老行为不能被这次改动弄丢）。
 *   B. 选择器（读构建产物 lib/client.js，钉住 aa1a101 那两条 + 本次兜底）：
 *      - 抽屉关着时原厂 div.drawerMask 必须 display:none（aa1a101）；
 *      - 抽屉开着时原厂遮罩不抢点击（aa1a101）；
 *      - 兜底：官方已 data-sidebar-collapsed（宿主把侧栏列 visibility:hidden 收走）时，
 *        我们自己的 backdrop 一律不许显示 —— marker 因任何原因没跟上都不会再留一块暗屏。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ---------- 最小假 DOM：够 mountDrawerChrome 跑，并支持 closest(选择器) ----------

/** 把一条 CSS 选择器列表拆成单个复合选择器（标签 / 类 / 属性 / 后代，够本测试用）。 */
function splitSelectors(selector) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim() !== '') parts.push(cur.trim())
  return parts
}

/** 单个复合选择器是否匹配这个假元素。 */
function matchesCompound(el, compound) {
  const tag = /^[a-z]+/i.exec(compound)?.[0]?.toUpperCase() ?? null
  if (tag !== null && el.tagName !== tag) return false
  for (const attr of compound.match(/\[[^\]]+\]/g) ?? []) {
    const body = attr.slice(1, -1)
    const eq = /^([\w-]+)="([^"]*)"$/.exec(body)
    const star = /^([\w-]+)\*="([^"]*)"$/.exec(body)
    if (eq) {
      if (el.getAttribute(eq[1]) !== eq[2]) return false
      continue
    }
    if (star) {
      const value = el.getAttribute(star[1])
      if (value === null || !value.includes(star[2])) return false
      continue
    }
    if (!el.hasAttribute(body)) return false
  }
  return true
}

/** 完整选择器（允许后代组合，如 `[class*="sessionRow"] button`）是否匹配。 */
function matchesSelector(el, selector) {
  return splitSelectors(selector).some((compoundSelector) => {
    const steps = compoundSelector.split(/\s+/).filter(Boolean)
    if (steps.length === 0) return false
    if (!matchesCompound(el, steps.at(-1))) return false
    let node = el.parentElement
    let index = steps.length - 2
    while (index >= 0) {
      let found = false
      while (node !== null) {
        if (matchesCompound(node, steps[index])) { found = true; node = node.parentElement; break }
        node = node.parentElement
      }
      if (!found) return false
      index -= 1
    }
    return true
  })
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.style = {}
    this.children = []
    this.attrs = new Map()
    this.listeners = new Map()
    this.parentElement = null
    this.rect = { left: 0, top: 0, width: 0, height: 0 }
    this.isConnected = true
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
    this.isConnected = false
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
  matches(selector) { return matchesSelector(this, selector) }
  closest(selector) {
    let node = this
    while (node !== null) {
      if (matchesSelector(node, selector)) return node
      node = node.parentElement
    }
    return null
  }
  contains(node) {
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }
}

/**
 * 假 DOM 的文档：只回答 mountDrawerChrome 真正会问的三处
 * （[data-shell-overlay]、[aria-modal="true"] 列表、body）。
 */
function makeDocument(layer) {
  const docListeners = new Map()
  const doc = {
    documentElement: new FakeElement('html'),
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
  return { doc, docListeners }
}

globalThis.Element = FakeElement

const layer = new FakeElement('div')
const frame = new FakeElement('div')
/** 抽屉那一列：mountDrawerChrome 用 `:scope > [class*="_sidebarCol"]` 找它。 */
const column = new FakeElement('div')
column.setAttribute('class', 'mP3x-q_sidebarCol')
frame.appendChild(column)
frame.querySelector = (selector) => (String(selector).includes('_sidebarCol') ? column : null)
// 抽屉布局（宿主 0.2.2：视口 <768 时才挂 div.drawerMask，并给 frame 打这个属性）
frame.setAttribute('data-sidebar-drawer', '')

const { doc, docListeners } = makeDocument(layer)
globalThis.document = doc

let now = 1000
const win = {
  PointerEvent: function PointerEvent() {},
  performance: { now: () => now },
  requestAnimationFrame(fn) { fn(); return 1 },
}
globalThis.window = win

const { mountDrawerChrome } = await import('../src/client/pocket/mobile/drawer-chrome.ts')

let storageValue = null
const storage = {
  getItem: () => storageValue,
  setItem: (key, value) => { storageValue = value },
}

mountDrawerChrome({
  findFrame: () => frame,
  labels: { menu: '打开菜单', sessionLog: '下载会话日志', close: '收起菜单' },
  doc,
  win,
  storage,
})

const byNav = (name) => layer.children.find((el) => el.getAttribute('data-mobile-nav') === name)
const toggle = byNav('toggle')
const backdrop = byNav('backdrop')
assert.ok(toggle, '汉堡钮必须挂上')
assert.ok(backdrop, '压暗层（backdrop）必须挂上')
toggle.rect = { left: 4, top: 4, width: 44, height: 44 }

/** 造一棵「抽屉里的会话行」：row > span，行内还有一颗 kebab 按钮。 */
const makeSessionRow = () => {
  const row = new FakeElement('div')
  row.setAttribute('class', 'YDXeBa_sessionRow')
  const label = new FakeElement('span')
  const kebab = new FakeElement('button')
  row.appendChild(label)
  row.appendChild(kebab)
  column.appendChild(row)
  return { row, label, kebab }
}

/** 派发事件：文档级监听先跑（capture 在目标之前），再跑目标自己的监听。 */
const fire = (target, type, props = {}) => {
  const event = { type, target, ...props }
  for (const fn of docListeners.get(type) ?? []) fn(event)
  for (const fn of target?.listeners?.get(type) ?? []) fn(event)
}
const marker = () => frame.getAttribute('data-dshp-drawer')
const backdropShown = () => backdrop.style.display !== 'none'

// ============ A1. 抽屉关着：点会话行不产生任何压暗层 ============
assert.equal(marker(), 'closed', '挂载后抽屉默认是关的')
assert.equal(backdropShown(), false, '关着时 backdrop 必须 display:none')
{
  const { label } = makeSessionRow()
  fire(label, 'click', { detail: 1 })
  assert.equal(marker(), 'closed', '抽屉关着时点会话行不该改 marker')
  assert.equal(backdropShown(), false, '抽屉关着时点会话行不该露出压暗层')
}

// ============ A2. 抽屉开着：点会话行 = 导航 → 立刻关抽屉、立刻亮 ============
now += 1000
fire(toggle, 'click', { detail: 1 })
assert.equal(marker(), 'open', '点汉堡要能开抽屉')
assert.equal(backdropShown(), true, '开着时 backdrop 才显示')
{
  const { label } = makeSessionRow()
  fire(label, 'click', { detail: 1 })
  assert.equal(marker(), 'closed',
    '点会话行（导航）必须立刻关抽屉：否则 .45 压暗层一直盖在刚打开的会话详情上，用户要再点一下才亮')
  assert.equal(backdropShown(), false, '关抽屉必须同时把压暗层收掉（同一帧）')
}

// ============ A3. 行内 kebab 不算导航：抽屉不许被关 ============
now += 1000
fire(toggle, 'click', { detail: 1 })
assert.equal(marker(), 'open')
{
  const { kebab } = makeSessionRow()
  fire(kebab, 'click', { detail: 1 })
  assert.equal(marker(), 'open', '行内 kebab（重命名/删除）点的是菜单不是导航，抽屉必须留着')
  assert.equal(backdropShown(), true, 'kebab 之后压暗层还在（抽屉仍开）')
}

// ============ A4. 抽屉里的非导航空白处：不关 ============
{
  const blank = new FakeElement('div')
  column.appendChild(blank)
  fire(blank, 'click', { detail: 1 })
  fire(blank, 'pointerdown', { clientX: 120, clientY: 400 })
  assert.equal(marker(), 'open', '抽屉内的非导航点击不该关抽屉（否则抽屉里点哪都没了）')
}

// ============ A5. 抽屉外的点击：照旧关（别把老行为改丢） ============
{
  const outside = new FakeElement('div')
  fire(outside, 'pointerdown', { clientX: 340, clientY: 500 })
  assert.equal(marker(), 'closed', '点抽屉外仍要关抽屉（宿主的点外关闭语义）')
  assert.equal(backdropShown(), false, '关掉后压暗层必须收掉')
}

// ============ B. 选择器：样式表里的三条关键规则 ============
// 直接拿 mobile.css.ts 导出的最终样式表文本（含 scopeRules 展开后的强制手机布局副本），
// 比读构建产物稳：不依赖压缩后的变量名，也不要求先 build。
const { MOBILE_CSS } = await import('../src/client/pocket/mobile/mobile.css.ts')
assert.ok(
  MOBILE_CSS.includes('[data-mobile-nav="frame"]:not([data-dshp-drawer="open"]) > [data-sidebar-mask]'),
  '抽屉关着时必须隐掉原厂 div.drawerMask（aa1a101 的规则，别被改回去）',
)
assert.ok(
  MOBILE_CSS.includes('[data-mobile-nav="frame"][data-dshp-drawer="open"] > [data-sidebar-mask]'),
  '抽屉开着时原厂遮罩不许抢点击（aa1a101 的规则）',
)
assert.ok(
  MOBILE_CSS.includes('[data-mobile-nav="frame"][data-dshp-drawer="open"][data-sidebar-collapsed] [data-mobile-nav="backdrop"]'),
  '兜底规则缺失：官方已 collapsed（宿主把侧栏列 visibility:hidden 收走）时，我们自己的 backdrop 必须 display:none',
)

console.log('PASS 13/13')
