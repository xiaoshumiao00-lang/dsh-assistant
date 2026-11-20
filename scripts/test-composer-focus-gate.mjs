/**
 * 手机端「点「＋」不弹输入法」回归（2026-11-05 起点，2026-11-20 定稿口径）。
 *
 * 口径（本轮定稿，见 composerFocusGate.ts 头部的真页面取证）：
 *   ① 默认不聚焦 + 窄白名单 —— 只有真实落点在输入框本体 / 卡片控件行以外的空白 /
 *      发送钮 / 语音那颗才算「要打字」；「＋」本体、包着「＋」的整组工具按钮
 *      （权限 / 计划 / 模型 / 托管胶囊、Tooltip 包层、_tools / _modes / _trailing /
 *      _standardControls / _row）、命令菜单与 PathBrowser 面板、dock chips、
 *      以及输入区外的落点（换会话、侧栏、悬浮球）全是「挑东西」的落点。
 *   ② 面板类落点那一刻把输入框**已有的焦点收掉**（blur）——0.2.33/0.2.34 只挡
 *      `HTMLElement.prototype.focus`，挡不住「输入框本来就聚焦着，安卓在下一次手势里
 *      把 IME 重新顶起来」这条真实路径。
 *   ③ focusin 兜底：Lexical 提交 DOM 选区时给 contenteditable 附送的焦点不经过
 *      prototype.focus，也要收掉。
 *   ④ 用户手指点输入框本体走浏览器原生聚焦，照常弹键盘、照常打字。
 *
 * 用假 DOM 是因为这里要验的正是「宿主调 focus() / 宿主的选区副作用那一刻发生了什么」——
 * 仓库不引第三方断言框架，也不引 jsdom。
 */
import assert from 'node:assert/strict'
import {
  COMPOSER_INPUT_SELECTOR,
  COMPOSER_SEAT_SELECTOR,
  COMPOSER_CARD_SELECTOR,
  COMPOSER_COMMAND_BUTTON_SELECTOR,
  COMPOSER_MENU_SELECTOR,
  COMPOSER_OVERLAY_SELECTOR,
  COMPOSER_EDITOR_BODY_SELECTOR,
  COMPOSER_TYPING_CONTROL_SELECTOR,
  COMPOSER_BLOCK_AREA_SELECTOR,
  COMPOSER_CONTROL_SELECTOR,
  IME_SHRINK_THRESHOLD_PX,
  COMPOSER_FOCUS_LOG_QUERY,
  createComposerFocusGate,
  installComposerFocusGate,
} from '../src/client/pocket/mobile/composerFocusGate.ts'

// --- 1. 纯判定（默认不聚焦，没有时间窗）------------------------------------------
const gate = createComposerFocusGate()
assert.deepEqual(gate.inspect(), { intent: 'picker', kind: 'outside', reason: 'no-tap' }, '开局没有落点 → 不聚焦')
assert.equal(gate.shouldBlock(), true, '从列表点进会话、还没点过输入框 → 要挡')
gate.notePointer('other', 'controls-area')
assert.equal(gate.shouldBlock(), true, '输入区里的非白名单落点也是 block 落点')
gate.notePointer('outside', 'out-of-seat')
assert.equal(gate.shouldBlock(), true, '点会话行 / 悬浮球 / 控制台卡片（区外）不算要打字')
gate.notePointer('menu', 'command-button')
assert.equal(gate.shouldBlock(), true, '点「＋」：挡（这行就是 0.2.34 漏掉的那条路的前提）')
gate.notePointer('typing', 'editor-body')
assert.equal(gate.shouldBlock(), false, '点输入框本体 → 放行')
assert.equal(gate.shouldBlock(), false, '放行不是「窗口」，下一次判定还是放行（没有 1.2 s 计时器）')
gate.notePointer('menu', 'composer-overlay')
assert.equal(gate.shouldBlock(), true, '菜单落点立刻把放行收回（谁更晚听谁的）')
gate.notePointer('typing', 'card-whitespace')
assert.equal(gate.shouldBlock(), false, '卡片空白（控件行之外）→ 放行')
gate.notePointer('typing', 'typing-control')
assert.equal(gate.shouldBlock(), false, '发送 / 语音那颗 → 放行')
assert.deepEqual(gate.inspect(), { intent: 'typing', kind: 'typing', reason: 'typing-control' }, '快照如实反映状态')
gate.notePointer('outside')
assert.equal(gate.inspect().reason, '', '没给 reason 时不编造理由')
assert.equal(gate.shouldBlock(), true, '区外落点 → 挡')

// 选择器就是宿主活代码（profile 里 @deepseek-ai/dsh-client-ui-conversation/lib/client.js）用的那几个
assert.equal(COMPOSER_INPUT_SELECTOR, '[data-composer-input]')
assert.equal(COMPOSER_SEAT_SELECTOR, '[data-conversation-region="composer"]')
assert.equal(COMPOSER_CARD_SELECTOR, '[data-composer-card]')
assert.equal(COMPOSER_COMMAND_BUTTON_SELECTOR, 'button[aria-haspopup="listbox"]')
assert.equal(COMPOSER_MENU_SELECTOR, '[data-trigger-menu]')
assert.equal(COMPOSER_OVERLAY_SELECTOR, '[data-composer-overlay]')
assert.equal(COMPOSER_EDITOR_BODY_SELECTOR, '[data-composer-input], [data-lexical-editor="true"], [contenteditable]')
assert.equal(COMPOSER_TYPING_CONTROL_SELECTOR, '[class$="_primary"], [data-voice-activity], [class$="_activity"]')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[class$="_tools"]'), 'block 区里有工具行（「＋」所在的那一行）')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[class$="_modes"]'), 'block 区里有权限 / 计划那一行')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[class$="_trailing"]'), 'block 区里有尾部那一区')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[class$="_standardControls"]'), 'block 区里有模型 / 发送 / 语音所在的标准控件组')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[class$="_row"]'), 'block 区里有控件行容器本身')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[class$="_dock"]'), 'block 区里有会话 dock')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[data-slot="conversation.input.dock"]'), 'block 区里有 slot 锚点层的 dock（data-slot div）')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[data-slot="conversation.composer.dock"]'), 'block 区里有插件自己的 composer 统计 chip')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[data-slot="conversation.input.permission"]'), 'block 区里有权限胶囊的 slot 锚点')
assert.equal(COMPOSER_BLOCK_AREA_SELECTOR.includes('[data-slot="conversation.input.activity"]'), false, '语音那颗不在 block 区里：它是打字意图白名单')
assert.equal(COMPOSER_CONTROL_SELECTOR, 'button, a, input, select, textarea, [role="button"], [aria-haspopup], [aria-expanded], [tabindex]')
assert.equal(COMPOSER_FOCUS_LOG_QUERY, 'composerFocusLog', '取证开关的名字别乱改：手机 URL 要用')
assert.equal(IME_SHRINK_THRESHOLD_PX, 120, '输入法观测阈值：视口高度阶跃下跌 > 120px')

// --- 2. 假 DOM -------------------------------------------------------------------
/** 本文件的选择器只用到 tag / [attr] / [attr="v"] / [class$="v"]，自己写个小匹配器。 */
const matchOne = (el, selector) => selector.split(',').some((token) => {
  token = token.trim()
  if (token === '') return false
  const head = token.match(/^([A-Za-z][A-Za-z0-9-]*)?/)
  if (head?.[1] && el.tag !== head[1].toLowerCase()) return false
  return (token.match(/\[[^\]]+\]/g) ?? []).every((clause) => {
    const inner = clause.slice(1, -1)
    const eq = inner.match(/^([^=]+)="(.*)"$/)
    if (eq) {
      const name = eq[1].trim()
      if (name.endsWith('$')) {
        const value = String(el.attrs[name.slice(0, -1)] ?? '')
        return value === eq[2] || value.split(/\s+/).some((item) => item.endsWith(eq[2]))
      }
      return String(el.attrs[name]) === eq[2]
    }
    return el.attrs[inner.trim()] !== undefined
  })
})

/** 假 DOM 的焦点表：焦点落在谁身上（null = body）。 */
const focusState = { active: null }

/** focusin 监听（真浏览器里 focus() 成功会同步派发一次）。 */
const focusInListeners = new Set()

class FakeHTMLElement {
  constructor(tag, attrs = {}) {
    this.tag = tag
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.dataset = {}
    for (const [name, value] of Object.entries(attrs)) {
      if (!name.startsWith('data-')) continue
      const key = name.slice(5).replace(/-([a-z])/g, (_all, ch) => ch.toUpperCase())
      this.dataset[key] = String(value)
    }
  }

  get tagName() {
    return this.tag.toUpperCase()
  }

  getAttributes() {
    return Object.entries(this.attrs).map(([name, value]) => ({ name, value: String(value) }))
  }

  getAttribute(name) {
    return this.attrs[name] === undefined ? null : String(this.attrs[name])
  }

  get parentElement() {
    return this.parent
  }

  matches(selector) {
    return matchOne(this, selector)
  }

  closest(selector) {
    let current = this
    while (current !== null && current !== undefined) {
      if (matchOne(current, selector)) return current
      current = current.parent ?? null
    }
    return null
  }

  contains(other) {
    let current = other ?? null
    while (current !== null && current !== undefined) {
      if (current === this) return true
      current = current.parent ?? null
    }
    return false
  }

  querySelector(selector) {
    for (const kid of this.children) {
      if (matchOne(kid, selector)) return kid
      const nested = kid.querySelector(selector)
      if (nested !== null) return nested
    }
    return null
  }

  focus() {
    focusState.active = this
    for (const listener of [...focusInListeners]) listener({ type: 'focusin', target: this })
  }

  blur() {
    if (focusState.active === this) focusState.active = null
  }
}

const HTMLElement = FakeHTMLElement

const listeners = new Map()
const visualViewport = {
  height: 844,
  handlers: new Set(),
  addEventListener(type, handler) {
    if (type === 'resize') this.handlers.add(handler)
  },
  removeEventListener(type, handler) {
    if (type === 'resize') this.handlers.delete(handler)
  },
  /** 模拟「输入法弹起来」：高度阶跃下跌再派发 resize。 */
  shrinkTo(height) {
    this.height = height
    for (const handler of [...this.handlers]) handler()
  },
}

const doc = {
  defaultView: {
    HTMLElement,
    performance: { now: () => 1000 },
    location: { href: 'http://127.0.0.1:57593/pocket' },
    visualViewport,
  },
  get activeElement() {
    return focusState.active
  },
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(handler)
    if (type === 'focusin') focusInListeners.add(handler)
  },
  removeEventListener(type, handler) {
    const set = listeners.get(type)
    if (set === undefined) return
    set.delete(handler)
    if (set.size === 0) listeners.delete(type)
    if (type === 'focusin') focusInListeners.delete(handler)
  },
}

/**
 * 宿主 InputBar 的真实形状（类名与 data-* 都按活代码 lib/client.js 里的字面量写死；
 * 真页面实测：`button._7tt59G_add` 直接挂在 `div._7tt59G_tools` 下，中间没有 Tooltip 包层）：
 *   seat → card → overlayAnchor[data-composer-overlay]（命令菜单 / 电脑文件 PathBrowser）
 *   scroll → [data-composer-input]（Lexical contenteditable）
 *   row → tools（button[aria-haspopup="listbox"]._7tt59G_add）
 *   modes（权限 / 计划胶囊）→ trailing → standardControls（_root 模型 / _primary 发送 / _activity 麦克风）
 *   dock（队列 / 目标 / 上行历史 chip，会话作用域才有）
 */
const node = (tag, attrs = {}) => new FakeHTMLElement(tag, attrs)

const link = (parent, ...kids) => {
  for (const kid of kids) {
    kid.parent = parent
    parent.children.push(kid)
  }
  return parent
}

const composerTree = (hero = false) => {
  const seat = node('div', { class: hero ? '_3Oyx4a_composerSeat _3Oyx4a_composerHero' : '_3Oyx4a_composerSeat', 'data-conversation-region': 'composer', 'data-composer-seat': '' })
  const card = node('div', { class: '_7tt59G_card', 'data-composer-card': 'true' })
  const overlay = node('div', { class: '_7tt59G_overlayAnchor', 'data-composer-overlay': 'true' })
  const menu = node('div', { class: '_7tt59G_menu', 'data-trigger-menu': 'true', role: 'listbox' })
  const menuItem = node('div', { class: '_7tt59G_item', role: 'option' })
  const pathBrowser = node('div', { class: '_9YPp_G_root', 'data-pocket-pathbrowser': 'true' })
  const scroll = node('div', { class: '_7tt59G_scroll' })
  const editor = node('div', {
    class: '_7tt59G_input',
    'data-composer-input': 'true',
    contenteditable: 'true',
    'data-lexical-editor': 'true',
    role: 'textbox',
  })
  const paragraph = node('p', {})
  const row = node('div', { class: '_7tt59G_row' })
  const tools = node('div', { class: '_7tt59G_tools' })
  const plus = node('button', { class: '_7tt59G_add', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' })
  const icon = node('svg', { class: '_9YPp_G_icon' })
  const modes = node('div', { class: '_7tt59G_modes' })
  const permissionCapsule = node('button', { class: '_9YPp_G_trigger', type: 'button', 'aria-haspopup': 'menu' })
  const trailing = node('div', { class: '_7tt59G_trailing' })
  const standardControls = node('div', { class: '_7tt59G_standardControls' })
  const modelRoot = node('div', { class: '_7tt59G_root' })
  const modelCapsule = node('button', { class: '_9YPp_G_trigger', type: 'button', 'aria-haspopup': 'menu' })
  const primary = node('button', { class: '_7tt59G_primary', type: 'button', 'aria-label': '发送' })
  const activity = node('div', { class: '_7tt59G_activity' })
  const voiceRow = node('div', { class: '_8ab3fC_captureRow', 'data-voice-activity': 'idle' })
  const voiceButton = node('button', { class: '_8ab3fC_captureButton', type: 'button' })
  const tuoguan = node('div', { class: '_9YPp_G_root', 'data-tuoguan-toggle': 'true' })
  const tuoguanButton = node('button', { class: '_9YPp_G_button', type: 'button' })
  const dock = node('div', { class: '_7tt59G_dock', 'data-slot': 'conversation.input.dock' })
  const dockChip = node('button', { class: '_7tt59G_dockButton' })
  const composerDock = node('div', { 'data-slot': 'conversation.composer.dock' })
  const composerChip = node('button', { class: '_9YPp_G_stats' })
  const fileInput = node('input', { type: 'file', hidden: 'hidden' })
  link(menu, menuItem)
  link(overlay, menu, pathBrowser)
  link(plus, icon)
  link(tools, plus, fileInput)
  link(modes, permissionCapsule)
  link(modelRoot, modelCapsule)
  link(voiceRow, voiceButton)
  link(activity, voiceRow)
  link(standardControls, modelRoot, primary, activity)
  link(tuoguan, tuoguanButton)
  link(trailing, standardControls, tuoguan)
  link(row, tools, modes, trailing)
  link(card, overlay, scroll, row)
  link(scroll, editor)
  link(editor, paragraph)
  link(dock, dockChip)
  link(composerDock, composerChip)
  link(seat, composerDock, dock, card)
  return {
    seat, card, overlay, menu, menuItem, pathBrowser, scroll, editor, paragraph, row, tools, plus, icon,
    modes, permissionCapsule, trailing, standardControls, modelRoot, modelCapsule, primary, activity,
    voiceRow, voiceButton, tuoguan, tuoguanButton, dock, dockChip, composerDock, composerChip, fileInput,
  }
}

const outsideRow = node('div', { class: '_9YPp_G_sessionRow' })

const beacon = []
const decisions = []
const imeEvents = []
const uninstall = installComposerFocusGate({
  document: doc,
  onBlocked: (count, decision) => beacon.push({ count, action: decision.action, kind: decision.kind, reason: decision.reason }),
  onDecision: (decision) => decisions.push(decision),
  onImeOpen: (event) => imeEvents.push(event),
})

assert.equal(listeners.get('pointerdown')?.size, 1, '主路监听是 pointerdown')
assert.equal(listeners.get('touchstart')?.size, 1, '老 WebView 靠 touchstart 兜底')
assert.equal(listeners.get('focusin')?.size, 1, 'focusin 兜底：非 focus() 路径的聚焦也要收')
assert.equal(decisions.length, 0, '取证开关默认关：不开就不发决策记录')

/** 真机落点：target 就是被点到的那个节点（图标 / 文本节点靠 parentElement 往上爬）。 */
const tap = (el) => {
  const event = { type: 'pointerdown', target: el }
  for (const handler of [...(listeners.get('pointerdown') ?? [])]) handler(event)
}

/** 宿主的程序化聚焦：每次都当新的 [data-composer-input] 节点（会话重挂载后就是新节点）。 */
const programmaticFocus = () => {
  const fresh = new HTMLElement('div', { 'data-composer-input': 'true', contenteditable: 'true' })
  fresh.focus()
  return focusState.active === fresh
}

/** 模拟「Lexical 提交 DOM 选区时顺带把 contenteditable 聚焦」：不经过 prototype.focus。 */
const selectionFocus = (editor) => {
  focusState.active = editor
  for (const listener of [...focusInListeners]) listener({ type: 'focusin', target: editor })
  return focusState.active === editor
}

// 2.1 进会话那一刻的自动聚焦被挡下
assert.equal(programmaticFocus(), false, '进入会话那一刻的自动聚焦被挡下（键盘不弹）')
assert.deepEqual(beacon.slice(-1), [{ count: 1, action: 'block', kind: 'outside', reason: 'no-tap' }], '第一次挡下时发一条诊断 beacon')
assert.equal(programmaticFocus(), false, '宿主重试聚焦也照样挡住')
assert.equal(beacon.length, 1, 'beacon 不刷屏（同一次进入只报一条）')

// 2.2 直接点输入框本体：放行，输入法正常弹起（这一条不能被 ② 的收焦点误伤）
const session = composerTree(false)
tap(session.editor)
assert.equal(programmaticFocus(), true, '点输入框本体 → 放行')
assert.equal(focusState.active !== null, true, '焦点真的落上去了')
tap(session.scroll)
assert.equal(programmaticFocus(), true, '点输入卡片里的空白（控件行之外）→ 放行')
tap(session.primary)
assert.equal(programmaticFocus(), true, '点发送 / 停止那颗 → 放行（发完继续打字键盘不该收）')
tap(session.activity)
assert.equal(programmaticFocus(), true, '点语音那颗（activity 位）→ 放行')
tap(session.voiceButton)
assert.equal(programmaticFocus(), true, '点语音按钮本体 → 放行')
tap(session.paragraph)
assert.equal(programmaticFocus(), true, '点在输入框里的段落节点上 → 放行')

// 2.3 本轮根因：点「＋」之前输入框就持有焦点 → 这一点必须把焦点收掉（键盘才会收/不弹）
tap(session.editor)
const editorFocus = new HTMLElement('div', { class: '_7tt59G_input', 'data-composer-input': 'true', contenteditable: 'true' })
editorFocus.focus()
assert.equal(focusState.active, editorFocus, '前提：输入框此刻持有焦点（用户先前点过 / 打过字）')
tap(session.plus)
assert.equal(focusState.active, null, '点「＋」→ 输入框的已持有焦点被收掉（安卓：不聚焦就不弹输入法）')
assert.ok(
  beacon.some((item) => item.action === 'blur' && item.reason === 'command-button'),
  '收焦点也发一条 beacon（action=blur，带落点意图）',
)
assert.equal(programmaticFocus(), false, '收掉之后宿主再想聚焦，照样挡')

// 2.3b 菜单里的选项行不收回焦点：宿主的 / 命令面板就是在有焦点时挑的，挑完还要接着打字
const menuTapTree = composerTree(false)
tap(menuTapTree.editor)
menuTapTree.editor.focus()
assert.equal(focusState.active, menuTapTree.editor, '前提：输入框持有焦点')
tap(menuTapTree.menuItem)
assert.equal(focusState.active, menuTapTree.editor, '点命令菜单里的选项行 → 焦点留着（挑完还能接着打字）')
assert.equal(programmaticFocus(), false, '但宿主若想再往输入框里塞焦点，仍然挡')

// 2.4 历史会话里点「＋」整条工具行：全部挡（这一串就是 0.2.33/0.2.34 反复复发的那一批）
const blocking = [
  'plus', 'icon', 'tools', 'row', 'modes', 'permissionCapsule', 'trailing', 'standardControls',
  'modelRoot', 'modelCapsule', 'tuoguan', 'menuItem', 'pathBrowser', 'dock', 'dockChip',
  'composerDock', 'composerChip', 'fileInput',
]
for (const key of blocking) {
  const tree = composerTree(false)
  tap(tree[key])
  assert.equal(programmaticFocus(), false, `点 ${key}：挡`)
  assert.equal(programmaticFocus(), false, `点 ${key}：连续重试聚焦照样挡`)
}

// 2.5 换会话不能借到上一次「点过输入框」的放行（没有时间窗，谁更晚听谁的）
tap(session.editor)
assert.equal(programmaticFocus(), true, '先直接点输入框：放行')
tap(outsideRow)
assert.equal(programmaticFocus(), false, '又点侧栏换会话 → 新挂载的 [data-composer-input] 节点照样挡')
assert.equal(programmaticFocus(), false, '连续两次程序化聚焦都挡（重挂载 / 尾快照补齐 / 选区同步）')

// 2.6 挡完之后用户要点输入框必须还能弹键盘
tap(session.editor)
assert.equal(programmaticFocus(), true, '挡完之后直接点输入框 → 输入法照常弹起')
tap(session.plus)
assert.equal(programmaticFocus(), false, '再点「＋」：又回到挡')
tap(session.editor)
assert.equal(programmaticFocus(), true, '菜单开过之后点输入框 → 放行')

// 2.7 落点意图（reason）逐条对得上：这是手机上判断「到底哪一片被点」的唯一线索
doc.defaultView.location = { href: `http://127.0.0.1:57593/pocket?${COMPOSER_FOCUS_LOG_QUERY}=1` }
const reasonTree = composerTree(false)
for (const [key, kind, reason] of [
  ['plus', 'menu', 'command-button'],
  ['icon', 'menu', 'command-button'],
  ['tools', 'other', 'controls-area'],
  ['modelCapsule', 'other', 'controls-area'],
  ['menuItem', 'menu', 'menu-item'],
  ['pathBrowser', 'menu', 'composer-overlay'],
  ['editor', 'typing', 'editor-body'],
  ['primary', 'typing', 'typing-control'],
  ['scroll', 'typing', 'card-whitespace'],
]) {
  tap(reasonTree[key])
  programmaticFocus()
  const decision = decisions[decisions.length - 1]
  assert.equal(decision.kind, kind, `${key} 的落点意图 = ${kind}`)
  assert.equal(decision.reason, reason, `${key} 的判据 = ${reason}`)
}
tap(outsideRow)
programmaticFocus()
const outsideDecision = decisions[decisions.length - 1]
assert.equal(outsideDecision.kind, 'outside', '区外落点（侧栏换会话）单独一类')
assert.equal(outsideDecision.reason, 'out-of-seat', '区外落点的判据')
doc.defaultView.location = { href: 'http://127.0.0.1:57593/pocket' }

// 2.8 非 focus() 路径的聚焦：Lexical 的选区副作用（setBaseAndExtent）也会给 contenteditable 焦点
tap(reasonTree.plus)
const sideEffect = composerTree(false)
assert.equal(selectionFocus(sideEffect.editor), false, 'focusin 兜底把选区副作用带来的焦点收掉')
assert.equal(focusState.active, null, '收掉之后 activeElement 是 body → 安卓不会顶输入法')

// 2.9 用户主动点输入框时，焦点不会被兜底误伤（intent=typing）
tap(reasonTree.editor)
const userEditor = composerTree(false).editor
assert.equal(selectionFocus(userEditor), true, '点过输入框之后，聚焦（含选区副作用）照常放行')

// 2.9 hero（新开会话）同一片落点也一律挡
const hero = composerTree(true)
assert.equal(programmaticFocus(), true, 'hero：上一轮是 typing，先放行一次作基线')
tap(hero.plus)
assert.equal(programmaticFocus(), false, 'hero 里点「＋」：挡')
tap(hero.tools)
assert.equal(programmaticFocus(), false, 'hero 里点工具行空白：挡')
tap(hero.editor)
assert.equal(programmaticFocus(), true, 'hero 里点输入框本体：放行')

// 2.10 结构判据：宿主换了 CSS-module 哈希前缀 / 类名后缀时，靠「谁包着『＋』」照样认得出
const renamed = composerTree(false)
renamed.tools.attrs.class = 'somethingElse_alpha'      // 不再是 [class$="_tools"]
renamed.row.attrs.class = 'somethingElse_beta'        // 不再是 [class$="_row"]
tap(renamed.plus)
assert.equal(programmaticFocus(), false, '类名换了：点「＋」本体照样挡')
tap(renamed.tools)
assert.equal(programmaticFocus(), false, '类名换了：点包着「＋」的容器照样挡（结构判据）')

// 2.11 别的输入框与插件自己的 textarea 不受影响
const search = new HTMLElement('input', { 'data-search-input': 'true' })
search.focus()
assert.equal(focusState.active, search, '别的输入框（搜索 / 插件自己的 textarea）永远不受影响')

// 2.12 卸载还原
uninstall()
const after = new HTMLElement('div', { 'data-composer-input': 'true' })
after.focus()
assert.equal(focusState.active, after, '卸载后宿主行为完全还原')
assert.equal(listeners.has('pointerdown'), false, 'pointerdown 监听摘干净')
assert.equal(listeners.has('touchstart'), false, 'touchstart 监听摘干净')
assert.equal(listeners.has('focusin'), false, 'focusin 监听摘干净')
assert.equal(visualViewport.handlers.size, 0, 'visualViewport 观测摘干净')

// 重复 install 只装一次（mobile-apply 重跑不会套娃）
const first = installComposerFocusGate({ document: doc })
const second = installComposerFocusGate({ document: doc })
assert.equal(listeners.size, 3, '第二次 install 不会再加监听（pointerdown / touchstart / focusin 就三条）')
const blockedAgain = new HTMLElement('div', { 'data-composer-input': 'true' })
blockedAgain.focus()
assert.notEqual(focusState.active, blockedAgain, '重新装上后照样生效')
second()
first()
const restored = new HTMLElement('div', { 'data-composer-input': 'true' })
restored.focus()
assert.equal(focusState.active, restored, '最终还原')

// --- 3. 取证开关 + 输入法观测 ------------------------------------------------------
focusState.active = null
doc.defaultView.location = { href: `http://127.0.0.1:57593/pocket?${COMPOSER_FOCUS_LOG_QUERY}=1` }
const loggedDecisions = []
const loggedIme = []
const logged = installComposerFocusGate({
  document: doc,
  onDecision: (decision) => loggedDecisions.push(decision),
  onImeOpen: (event) => loggedIme.push(event),
})
const tree = composerTree(false)
tap(tree.editor)
const focused = new HTMLElement('div', { 'data-composer-input': 'true' })
focused.focus()
tap(tree.plus)
assert.ok(loggedDecisions.some((item) => item.action === 'allow'), '开关打开后放行也留一条（action=allow）')
assert.ok(loggedDecisions.some((item) => item.action === 'blur'), '收焦点留一条（action=blur）')
const blockedDecision = loggedDecisions.find((item) => item.action === 'block')
assert.equal(blockedDecision, undefined, '这一轮没有新的聚焦被挡（都被 ② 收掉了）')

// 输入法真弹起来：visualViewport 高度阶跃下跌 → 一条现场记录
tap(tree.plus)
visualViewport.shrinkTo(844 - IME_SHRINK_THRESHOLD_PX - 80)
assert.equal(loggedIme.length, 1, '视口下跌 > 阈值 → 报一条输入法现场')
assert.equal(loggedIme[0].shrink, IME_SHRINK_THRESHOLD_PX + 80, '带下跌像素数')
assert.equal(loggedIme[0].editorFocused, false, '带「那一刻输入框有没有焦点」')
assert.equal(loggedIme[0].kind, 'menu', '带最近一次落点意图')
visualViewport.shrinkTo(844)
assert.equal(loggedIme.length, 1, '视口恢复不重复报')
visualViewport.shrinkTo(844 - (IME_SHRINK_THRESHOLD_PX - 20))
assert.equal(loggedIme.length, 1, '下跌不到阈值不算输入法')
logged()

console.log('ok test-composer-focus-gate')
