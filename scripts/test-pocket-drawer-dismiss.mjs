/**
 * 抽屉「关得掉」回归（2026-11-25，用户原话：
 *   「点击左上角的侧边栏按钮打开抽屉以后，点击右侧空白区域时侧边栏仍显示、没有消失，
 *    而且侧边栏右上角也没有收起按钮」）。
 *
 * 三条关闭路径必须在**同一个状态机**（mountDrawerChrome 的 open / closeDrawer）里落地：
 *   1) 点抽屉外任意空白 —— 证据：宿主 0.2.2 打开抽屉时把侧栏本身渲染成
 *      `role="dialog" aria-modal="true" data-shortcut-modal="sidebar"`（真机实测），
 *      旧判据 `document.querySelector('[aria-modal="true"]')` 因此对每一次点空白都
 *      return，closeDrawer 永远不执行；这里用一个同样带 aria-modal 的侧栏对话框复现。
 *   2) 抽屉顶部右上角的收起按钮（我们自己的按钮，不许调宿主 toggleSidebar 折成图标 rail）。
 *   3) 点抽屉里的会话行进详情 —— 抽屉同时收起。
 *
 * 另钉两件不许回归的事：
 *   4) 抽屉**外**的模态框（设置面板 / 导出面板）仍然掌屏：那时候点空白不许把抽屉滑走。
 *   5) 关抽屉全程不碰宿主 toggleSidebar（expandSidebar 只在「把图标 rail 升成完整列表」时叫一次）。
 *
 * 真机看不到 console，这一层用最小假 DOM（带 closest/matches 的极简选择器引擎）跑真实现。
 */
import assert from 'node:assert/strict'

// --- 极简选择器引擎（够 drawer-chrome / nav-targets 用）-------------------------

/** 解析单个复合选择器：tag + [attr] / [attr="v"] / [attr*="v"]。 */
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

/** 单个复合选择器是否命中元素。 */
function matchesCompound(el, compound) {
  if (compound === null) return false
  const tagOk = compound.tag === '' || el.tagName.toLowerCase() === compound.tag
  if (!tagOk) return false
  for (const attr of compound.attrs) {
    const value = el.getAttribute(attr.name)
    if (value === null) return false
    if (attr.op === '=' && value !== attr.value) return false
    if (attr.op === '*=' && !value.includes(attr.value)) return false
  }
  return true
}

/** 把选择器拆成「复合选择器 + 组合符」链。只支持后代（空格）与子代（>）。 */
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
  if (index === 0) {
    if (scope == null) return true
    return el === scope
  }
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

// --- 最小假 DOM ---------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    /* 真 DOM 里 style.cssText = '...' 会把每条声明摊成 style.top / style.right：
       这里同样摊开，好让测试直接断言内联定位（安全区 / 贴右沿）。 */
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

/** 宿主 AppFrame（真机：div[data-mobile-nav="frame"] 由我们打标记）。 */
const frame = body.appendChild(new FakeElement('div'))
frame.setAttribute('data-sidebar-drawer', '')
frame.setAttribute('data-sidebar-collapsed', '')

/** 宿主原厂压暗层（pointer-events 归另一条 CSS 修复线，这里只要它在）。 */
const hostMask = frame.appendChild(new FakeElement('div'))
hostMask.setAttribute('data-sidebar-mask', '')

/** 抽屉本体：被拉成抽屉的侧栏列；官方的 role=dialog 侧栏根就在它里面。 */
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

/** 主内容列（宿主在抽屉打开时给它 inert，真机上点击因此被改派到 frame）。 */
const centerCol = frame.appendChild(new FakeElement('div'))
centerCol.setAttribute('class', 'mP3x-q_centerCol')
centerCol.setAttribute('inert', '')

/** shell overlay 层（宿主：position:absolute; inset:0; z-index:20; pointer-events:none）。 */
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

/** 收起按钮的稳定锚点（CSS 与测试都只认这个属性，不认哈希类名）。 */
const DRAWER_CLOSE_SELECTOR = '[data-mobile-nav="drawer-close"]'

const { mountDrawerChrome } = await import('../src/client/pocket/mobile/drawer-chrome.ts')

let storageValue = null
const storage = {
  getItem: () => storageValue,
  setItem: (key, value) => { storageValue = value },
}

let expandCalls = 0
const stop = mountDrawerChrome({
  findFrame: () => frame,
  expandSidebar: () => { expandCalls += 1 },
  labels: { menu: '打开菜单', sessionLog: '下载会话日志', close: '收起菜单' },
  doc,
  win,
  storage,
})

const state = () => frame.getAttribute('data-dshp-drawer')

/** 真机事件路径：document 捕获监听先跑，再跑目标元素自己的监听。 */
const fire = (target, type, props = {}) => {
  const event = { type, target, ...props }
  for (const fn of docListeners.get(type) ?? []) fn(event)
  for (const fn of target?.listeners?.get(type) ?? []) fn(event)
}

const toggle = overlayLayer.children.find((el) => el.getAttribute('data-mobile-nav') === 'toggle')
assert.ok(toggle, '汉堡钮必须挂在 shell overlay 层里')
toggle.rect = { left: 4, top: 4, width: 44, height: 44 }

/** 点汉堡开抽屉（真机：pointerdown zone → pointerup zone 同一套状态机）。 */
const openDrawer = () => {
  now += 1000
  fire(toggle, 'click', { detail: 1 })
  assert.equal(state(), 'open', '点汉堡要能开抽屉')
}

let passed = 0
/** 本文件的断言条数（改测试时同步改这里，打印才算「PASS n/n」）。 */
const EXPECTED = 8
const failures = []
const ok = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(`${name} — ${error instanceof Error ? error.message : String(error)}`)
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- 0) 现场条件：宿主侧栏本身就是一个 aria-modal 对话框（真机实测）------------
ok('现场条件：抽屉里的宿主侧栏带 role=dialog + aria-modal（旧判据会误判）', () => {
  assert.ok(doc.querySelector('[aria-modal="true"]') !== null)
  assert.equal(doc.querySelector('[aria-modal="true"]'), sidebarDialog)
})

// --- 1) 点抽屉外任意空白 ⇒ 立刻收起 -------------------------------------------
ok('点抽屉外空白（target 被 inert 改派到 frame）能关抽屉', () => {
  openDrawer()
  now += 1000
  fire(frame, 'pointerdown', { clientX: 404, clientY: 448 })
  assert.equal(state(), 'closed', '点空白必须把 marker 置回 closed')
})

// --- 2) 抽屉顶部右上角的收起按钮 ----------------------------------------------
ok('抽屉右上角有可见可点的收起按钮（在抽屉列里，自带 safe-area 上边距）', () => {
  assert.ok(drawerColumn.querySelector(DRAWER_CLOSE_SELECTOR) !== null, '收起按钮必须挂在抽屉列里')
  openDrawer()
  const button = drawerColumn.querySelector(DRAWER_CLOSE_SELECTOR)
  assert.equal(button.style.display, 'inline-flex', '抽屉开着时必须可见')
  assert.ok(String(button.style.top).includes('safe-area-inset-top'), '位置必须避开安全区/刘海')
  assert.ok(String(button.style.right).endsWith('px'), '必须贴抽屉右侧')
})

ok('点收起按钮 ⇒ 收起（走我们自己的 closeDrawer，不叫宿主 toggleSidebar）', () => {
  const before = expandCalls
  const button = drawerColumn.querySelector(DRAWER_CLOSE_SELECTOR)
  now += 1000
  fire(button, 'pointerdown', { clientX: 250, clientY: 26 })
  fire(button, 'click', { detail: 1 })
  assert.equal(state(), 'closed', '点收起按钮必须关抽屉')
  assert.equal(expandCalls, before, '关抽屉不许再调宿主 toggleSidebar（那会把侧栏折成图标 rail）')
})

ok('抽屉关着时收起按钮隐藏（不会在电脑布局里露出一个 ×）', () => {
  const button = drawerColumn.querySelector(DRAWER_CLOSE_SELECTOR)
  assert.equal(button.style.display, 'none')
})

// --- 3) 点抽屉里的会话行进详情 ⇒ 抽屉同时收起 ---------------------------------
ok('点会话行进详情 ⇒ 抽屉同时收起', () => {
  openDrawer()
  now += 1000
  fire(sessionRow, 'pointerdown', { clientX: 40, clientY: 300 })
  fire(sessionRow, 'click', { detail: 1 })
  assert.equal(state(), 'closed', '点会话行必须把抽屉收起')
})

// --- 4) 抽屉外的模态框仍然掌屏 -------------------------------------------------
ok('抽屉外的模态框（设置面板）开着时，点空白不关抽屉', () => {
  const settingsOverlay = body.appendChild(new FakeElement('div'))
  const settingsDialog = settingsOverlay.appendChild(new FakeElement('div'))
  settingsDialog.setAttribute('role', 'dialog')
  settingsDialog.setAttribute('aria-modal', 'true')
  openDrawer()
  now += 1000
  fire(frame, 'pointerdown', { clientX: 404, clientY: 448 })
  assert.equal(state(), 'open', '模态框掌屏时不许把抽屉滑走')
  // 收尾：关掉模态框 + 抽屉
  settingsOverlay.remove()
  now += 1000
  fire(frame, 'pointerdown', { clientX: 404, clientY: 448 })
  assert.equal(state(), 'closed', '模态框关掉后点空白应恢复关闭')
})

// --- 5) 老路径不回归：点汉堡关自己 --------------------------------------------
ok('开着抽屉再点汉堡 ⇒ 收起（同一次点击不二次翻转）', () => {
  openDrawer()
  now += 1000
  fire(toggle, 'pointerdown', { clientX: 26, clientY: 26 })
  fire(toggle, 'pointerup', { clientX: 26, clientY: 26 })
  fire(toggle, 'click', { detail: 1 })
  assert.equal(state(), 'closed', '再点汉堡必须收起')
})

stop()
assert.equal(overlayLayer.children.length, 0, '卸载后 overlay 层里不留我们的元素')
assert.equal(drawerColumn.querySelector(DRAWER_CLOSE_SELECTOR), null, '卸载后抽屉里不留收起按钮')

assert.equal(passed, EXPECTED, '断言条数与 EXPECTED 对不上')
assert.equal(failures.length, 0, `有 ${failures.length} 条断言失败`)
console.log(`ok test-pocket-drawer-dismiss — PASS ${passed}/${EXPECTED}`)
