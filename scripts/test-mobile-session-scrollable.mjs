/**
 * 「会话详情过一会就卡死」回归（2026-11-25 用户报障）：
 *   「个人助手手机端打开 DSH 时，点进会话详情，过一会会话详情就卡死了，
 *     不能操作、不能上下滑动，画面一直卡住。只有点侧边栏里的其他会话才能
 *     跳转；跳进新会话详情，过一会又卡死。」
 *
 * 根因（真页面 probe4 实锤，inert 是卡死的充要条件：摘掉立刻复活、装回复冻）：
 *   宿主 AppFrame 在 drawerOpen（= 视口<768 && 官方侧栏展开）时给主内容四列打
 *   inert；我们的抽屉 PRE_UPGRADE 会在首屏后 ~700ms 把官方侧栏展开成「宿主 modal」
 *   却从不收回，三条关闭路径也只滑走视觉、不动宿主状态 → 主内容永久 inert。
 *   修复后的铁律：**抽屉模式（frame 带 data-sidebar-drawer）下官方侧栏展开 ⟺
 *   我们的抽屉开着** —— 关抽屉经延迟对账收回收起；PRE_UPGRADE 在抽屉模式直接跳过
 *   （那里 SidebarRoot wide=drawer 恒真，会话列表本来就常驻挂载，没有可预热的东西）。
 *   非抽屉模式（宽屏强制手机布局）保持老纪律：只升不降（收起 = 图标 rail，归用户）。
 *
 * 本测试用最小假 DOM 模拟宿主 AppFrame 的 inert 语义：
 *   官方展开 ⇒ 摘掉 data-sidebar-collapsed 并给主内容列打 inert；
 *   官方收起 ⇒ 反之。FROZEN := 抽屉关着（data-dshp-drawer=closed）且主内容列带 inert。
 *
 * 旧代码跑本文件必须红（PRE_UPGRADE 把主内容 inert 掉、关闭路径不收官方）；
 *   新代码必须全绿。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// --- 极简选择器引擎（与 test-pocket-drawer-dismiss.mjs 同构，够用即可）------------

function parseCompound(text) {
  const source = String(text).trim()
  if (source === '') return null
  const tag = /^[a-zA-Z][\w-]*/.exec(source)?.[0] ?? ''
  const attrs = []
  const pattern = /\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g
  let match = pattern.exec(source)
  while (match !== null) {
    attrs.push({ name: match[1], op: match[2] ?? '', value: match[3] ?? '' })
    match = pattern.exec(source)
  }
  return { tag: tag.toLowerCase(), attrs }
}

function matchesCompound(el, compound) {
  if (compound === null) return false
  if (!(compound.tag === '' || el.tagName.toLowerCase() === compound.tag)) return false
  for (const attr of compound.attrs) {
    const value = el.getAttribute(attr.name)
    if (value === null) return false
    if (attr.op === '=' && value !== attr.value) return false
    if (attr.op === '*=' && !value.includes(attr.value)) return false
  }
  return true
}

function parseChain(selector) {
  return String(selector)
    .trim()
    .replace(/\s*>\s*/g, ' > ')
    .split(/\s+/)
    .reduce((chain, token) => {
      if (token === '>') chain.push({ combinator: '>', compound: null })
      else if (chain.length > 0 && chain.at(-1).compound === null) chain.at(-1).compound = parseCompound(token)
      else chain.push({ combinator: ' ', compound: parseCompound(token) })
      return chain
    }, [])
}

function matchesChain(el, chain, index, scope) {
  const link = chain[index]
  if (link === null || link.compound === null) return false
  if (!matchesCompound(el, link.compound)) return false
  if (index === 0) return scope == null ? true : el === scope
  const previous = chain[index - 1]
  if (previous.compound === null) return false
  let ancestor = el.parentElement
  if (link.combinator === '>') {
    return ancestor !== null && matchesChain(ancestor, chain, index - 1, scope)
  }
  while (ancestor !== null) {
    if (matchesChain(ancestor, chain, index - 1, scope)) return true
    ancestor = ancestor.parentElement
  }
  return false
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    const style = {}
    let cssText = ''
    Object.defineProperty(style, 'cssText', {
      get: () => cssText,
      set: (value) => {
        cssText = String(value)
        for (const declaration of cssText.split(';')) {
          const colon = declaration.indexOf(':')
          if (colon < 0) continue
          style[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
        }
      },
    })
    this.style = style
    this.children = []
    this.attrs = new Map()
    this.listeners = new Map()
    this.parentElement = null
    this.rect = { left: 0, top: 0, width: 0, height: 0 }
    this.innerHTML = ''
  }

  get className() { return this.getAttribute('class') ?? '' }

  setAttribute(name, value) { this.attrs.set(name, String(value)) }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null }
  hasAttribute(name) { return this.attrs.has(name) }
  removeAttribute(name) { this.attrs.delete(name) }

  appendChild(child) {
    if (child.parentElement !== null) child.remove()
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

  contains(node) {
    if (node === null || node === undefined) return false
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }

  matches(selector) {
    return String(selector).split(',').some((part) => {
      const chain = parseChain(part)
      return chain.length > 0 && matchesChain(this, chain, chain.length - 1, undefined)
    })
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (node.matches(selector) === true) return node
      node = node.parentElement
    }
    return null
  }

  querySelectorAll(selector) {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector) === true) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  querySelector(selector) {
    const scoped = /^:scope\s*>\s*(.+)$/.exec(String(selector).trim())
    if (scoped !== null) {
      for (const child of this.children) {
        if (child.matches(scoped[1]) === true) return child
      }
      return null
    }
    return this.querySelectorAll(selector)[0] ?? null
  }

  getBoundingClientRect() { return this.rect }
}

// --- 场景 A：真手机抽屉模式（frame 带 data-sidebar-drawer，官方初始收起）-------

const docListeners = new Map()
const root = new FakeElement('html')
const body = root.appendChild(new FakeElement('body'))

const doc = {
  body,
  documentElement: root,
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
  querySelector(selector) { return root.querySelector(selector) },
  querySelectorAll(selector) { return root.querySelectorAll(selector) },
}

/** 宿主 AppFrame：抽屉模式（真机：div[data-mobile-nav="frame"] 由我们打标记）。 */
const frame = body.appendChild(new FakeElement('div'))
frame.setAttribute('data-sidebar-drawer', '')
frame.setAttribute('data-sidebar-collapsed', '')

/** 宿主原厂压暗层。 */
const hostMask = frame.appendChild(new FakeElement('div'))
hostMask.setAttribute('data-sidebar-mask', '')

/** 抽屉本体：被拉成抽屉的侧栏列。 */
const drawerColumn = frame.appendChild(new FakeElement('div'))
drawerColumn.setAttribute('class', 'mP3x-q_sidebarCol')

const sidebarDialog = drawerColumn.appendChild(new FakeElement('div'))
sidebarDialog.setAttribute('class', 'wtg9ga_root wtg9ga_quietBars')
sidebarDialog.setAttribute('role', 'dialog')
sidebarDialog.setAttribute('aria-modal', 'true')
sidebarDialog.setAttribute('data-shortcut-modal', 'sidebar')

const sessionRow = sidebarDialog.appendChild(new FakeElement('div'))
sessionRow.setAttribute('class', 'YDXeBa_sessionRow')
sessionRow.setAttribute('role', 'treeitem')

/** 主内容列：宿主在官方抽屉打开时给它 inert —— 卡死判据的核心。 */
const centerCol = frame.appendChild(new FakeElement('div'))
centerCol.setAttribute('class', 'mP3x-q_centerCol')

/** shell overlay 层。 */
const overlayLayer = frame.appendChild(new FakeElement('div'))
overlayLayer.setAttribute('data-shell-overlay', '')

let now = 1000
const win = {
  PointerEvent: function PointerEvent() {},
  performance: { now: () => now },
  requestAnimationFrame(fn) { fn(); return 1 },
}

globalThis.Element = FakeElement
globalThis.document = doc
globalThis.window = win

const { mountDrawerChrome } = await import('../src/client/pocket/mobile/drawer-chrome.ts')

let storageValue = null
const storage = {
  getItem: () => storageValue,
  setItem: (key, value) => { storageValue = value },
}

/**
 * 假宿主：模拟 AppFrame 的 inert 语义。
 *   官方展开 ⇒ 摘掉 data-sidebar-collapsed + 给主内容列打 inert；
 *   官方收起 ⇒ 反之。宿主 toggleSidebar 是盲翻转，方向由「当前是否 collapsed」决定。
 */
let expandCalls = 0
let collapseCalls = 0
const expandSidebar = () => {
  expandCalls += 1
  frame.removeAttribute('data-sidebar-collapsed')
  centerCol.setAttribute('inert', '')
}
const collapseSidebar = () => {
  collapseCalls += 1
  frame.setAttribute('data-sidebar-collapsed', '')
  centerCol.removeAttribute('inert')
}

const stop = mountDrawerChrome({
  findFrame: () => frame,
  expandSidebar,
  collapseSidebar,
  labels: { menu: '打开菜单', sessionLog: '下载会话日志', close: '收起菜单' },
  doc,
  win,
  storage,
})

const state = () => frame.getAttribute('data-dshp-drawer')
/** 卡死判据：我们的抽屉关着、而官方还展开着（主内容列被宿主 inert）。 */
const frozen = () => state() === 'closed' && !frame.hasAttribute('data-sidebar-collapsed')

const fire = (target, type, props = {}) => {
  const event = { type, target, ...props }
  for (const fn of docListeners.get(type) ?? []) fn(event)
  for (const fn of target?.listeners?.get(type) ?? []) fn(event)
}

const toggle = overlayLayer.children.find((el) => el.getAttribute('data-mobile-nav') === 'toggle')
assert.ok(toggle, '汉堡钮必须挂在 shell overlay 层里')
toggle.rect = { left: 4, top: 4, width: 44, height: 44 }

const openDrawer = () => {
  now += 1000
  fire(toggle, 'click', { detail: 1 })
  assert.equal(state(), 'open', '点汉堡要能开抽屉')
}

const pump = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
/** 本文件的断言条数（改测试时同步改这里，打印才算「PASS n/n」）。 */
const EXPECTED = 10
const failures = []
const ok = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(`${name} — ${error instanceof Error ? error.message : String(error)}`)
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- 1) 静置不复冻：首屏后官方不被预展开，主内容列全程没有 inert -----------------
await ok('静置 1s：抽屉模式不触发 PRE_UPGRADE，主内容列无 inert（不卡死）', async () => {
  await pump(1000)
  assert.equal(expandCalls, 0, '抽屉模式里官方侧栏本来就常驻挂载，不许预展开（旧代码这里会调用）')
  assert.equal(collapseCalls, 0)
  assert.equal(frame.hasAttribute('data-sidebar-collapsed'), true, '官方保持收起')
  assert.equal(centerCol.hasAttribute('inert'), false, '主内容列绝不能被宿主 inert')
  assert.equal(frozen(), false)
})

// --- 2) 开抽屉：官方展开（宿主 modal 语义），主内容列被 inert 是抽屉开着时的正常行为
await ok('开抽屉：marker=open 且官方展开（对账/同步补齐）', async () => {
  openDrawer()
  assert.equal(frame.hasAttribute('data-sidebar-collapsed'), false, '开抽屉必须把官方展开')
  assert.equal(centerCol.hasAttribute('inert'), true, '抽屉开着时主内容 inert 是正常模态行为')
  assert.equal(frozen(), false)
})

// --- 3) 点抽屉外空白关闭：主内容立刻解冻 ---------------------------------------
await ok('点空白关抽屉：官方被收回收起，主内容列 inert 解除', async () => {
  now += 1000
  fire(frame, 'pointerdown', { clientX: 404, clientY: 448 })
  assert.equal(state(), 'closed')
  await pump(50)
  assert.equal(frame.hasAttribute('data-sidebar-collapsed'), true, '关抽屉必须收回官方（旧代码不收 → 主内容永久 inert）')
  assert.equal(centerCol.hasAttribute('inert'), false, '主内容列必须解冻')
  assert.equal(frozen(), false)
})

// --- 4) 右上角 × 关闭 ------------------------------------------------------------
await ok('点右上角 × 关抽屉：官方收回，主内容解冻', async () => {
  openDrawer()
  const button = drawerColumn.querySelector('[data-mobile-nav="drawer-close"]')
  assert.ok(button !== null)
  now += 1000
  fire(button, 'pointerdown', { clientX: 250, clientY: 26 })
  fire(button, 'click', { detail: 1 })
  assert.equal(state(), 'closed')
  await pump(50)
  assert.equal(frame.hasAttribute('data-sidebar-collapsed'), true)
  assert.equal(centerCol.hasAttribute('inert'), false)
})

// --- 5) 点抽屉里的会话行进详情：宿主 selectPanel 会自己收官方，对账不得抢翻 -------
await ok('点会话行关抽屉：与宿主 selectPanel 共存，最终官方收起、主内容解冻', async () => {
  openDrawer()
  now += 1000
  fire(sessionRow, 'pointerdown', { clientX: 40, clientY: 300 })
  /* 真机：宿主 selectPanel 在我们捕获监听之后才把官方收起。 */
  collapseSidebar()
  fire(sessionRow, 'click', { detail: 1 })
  assert.equal(state(), 'closed')
  await pump(500)
  assert.equal(frame.hasAttribute('data-sidebar-collapsed'), true, '对账不许把官方再翻回去')
  assert.equal(centerCol.hasAttribute('inert'), false)
  assert.equal(frozen(), false)
})

// --- 6) 对账收敛后不再动作（空转保护） ------------------------------------------
await ok('对账收敛：静候 600ms 宿主 toggleSidebar 调用次数不再增长', async () => {
  const beforeE = expandCalls
  const beforeC = collapseCalls
  await pump(600)
  assert.equal(expandCalls, beforeE, '收敛后不许再翻官方（盲翻转来回抖会把主内容又 inert 掉）')
  assert.equal(collapseCalls, beforeC)
})

// --- 7) 非抽屉模式保持老纪律：只升不降，绝不替用户折 rail ------------------------
await ok('非抽屉模式（宽屏强制手机布局）：PRE_UPGRADE 仍预展开一次，关闭不收回', async () => {
  /* 独立文档：mountDrawerChrome 的 querySelector 会命中树里第一个 overlay 层，
     跟场景 A 共用一个 document 会把 chrome 挂错地方。 */
  const listeners2 = new Map()
  const root2 = new FakeElement('html')
  const body2 = root2.appendChild(new FakeElement('body'))
  const doc2 = {
    body: body2,
    documentElement: root2,
    createElement(tag) { return new FakeElement(tag) },
    addEventListener(type, fn) {
      const list = listeners2.get(type) ?? []
      list.push(fn)
      listeners2.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = listeners2.get(type) ?? []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    querySelector(selector) { return root2.querySelector(selector) },
    querySelectorAll(selector) { return root2.querySelectorAll(selector) },
  }
  const fire2 = (target, type, props = {}) => {
    const event = { type, target, ...props }
    for (const fn of listeners2.get(type) ?? []) fn(event)
    for (const fn of target?.listeners?.get(type) ?? []) fn(event)
  }
  /* 宽屏强制手机布局：frame 没有 data-sidebar-drawer，官方侧栏是常驻网格列。 */
  const frame2 = body2.appendChild(new FakeElement('div'))
  frame2.setAttribute('data-sidebar-collapsed', '')
  const overlay2 = frame2.appendChild(new FakeElement('div'))
  overlay2.setAttribute('data-shell-overlay', '')
  const column2 = frame2.appendChild(new FakeElement('div'))
  column2.setAttribute('class', 'Ab12Cd_sidebarCol')
  let expand2 = 0
  let collapse2 = 0
  const stop2 = mountDrawerChrome({
    findFrame: () => frame2,
    expandSidebar: () => { expand2 += 1; frame2.removeAttribute('data-sidebar-collapsed') },
    collapseSidebar: () => { collapse2 += 1; frame2.setAttribute('data-sidebar-collapsed', '') },
    labels: { menu: '打开菜单', sessionLog: '下载会话日志', close: '收起菜单' },
    doc: doc2,
    win,
    storage,
  })
  await pump(1000)
  assert.equal(expand2, 1, '非抽屉模式保留 PRE_UPGRADE（rail → 列表的重建确实贵）')
  const toggle2 = overlay2.children.find((el) => el.getAttribute('data-mobile-nav') === 'toggle')
  assert.ok(toggle2, '非抽屉模式也要挂上汉堡钮')
  toggle2.rect = { left: 4, top: 4, width: 44, height: 44 }
  now += 1000
  fire2(toggle2, 'click', { detail: 1 })
  assert.equal(frame2.getAttribute('data-dshp-drawer'), 'open')
  now += 1000
  fire2(frame2, 'pointerdown', { clientX: 900, clientY: 448 })
  await pump(500)
  assert.equal(frame2.getAttribute('data-dshp-drawer'), 'closed')
  assert.equal(collapse2, 0, '非抽屉模式收起官方 = 折成图标 rail，对账绝不许碰（老纪律）')
  assert.equal(frame2.hasAttribute('data-sidebar-collapsed'), false, '升上去就不许降')
  stop2()
})

// --- 8) CSS 锚点不许被本次修复波及 ------------------------------------------------
await ok('CSS 锚点完好：287308b 类名后缀 + aa1a101 压暗层 + f8e1b3b backdrop 兜底', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const cssText = readFileSync(join(here, '../src/client/pocket/mobile/mobile.css.ts'), 'utf8')
  assert.ok(cssText.includes('[class*="_sidebarCol"]'), '侧栏列类名后缀锚点必须还在')
  assert.ok(cssText.includes('[class*="_centerCol"]'), '主内容列类名后缀锚点必须还在')
  assert.ok(cssText.includes('data-sidebar-mask'), '官方压暗层的两条规则必须还在')
  assert.ok(
    cssText.includes('${OPEN}[data-sidebar-collapsed] [data-mobile-nav="backdrop"]'),
    'f8e1b3b 的「开着+官方收起时隐藏自家 backdrop」兜底规则必须还在',
  )
})

// --- 9) 卸载后定时器全部熄火 -------------------------------------------------------
await ok('卸载后对账定时器不再动作', async () => {
  stop()
  const beforeE = expandCalls
  const beforeC = collapseCalls
  await pump(700)
  assert.equal(expandCalls, beforeE)
  assert.equal(collapseCalls, beforeC)
})

// --- 10) 卡死判据自始至终未出现过 --------------------------------------------------
await ok('全程 frozen 判据未在「抽屉关着」时成立（逐场景断言已覆盖，这里收尾）', async () => {
  assert.equal(frozen(), false, '测试结束时绝不能还处在卡死态')
})

assert.equal(passed, EXPECTED, '断言条数与 EXPECTED 对不上')
assert.equal(failures.length, 0, `有 ${failures.length} 条断言失败`)
console.log(`ok test-mobile-session-scrollable — PASS ${passed}/${EXPECTED}`)
