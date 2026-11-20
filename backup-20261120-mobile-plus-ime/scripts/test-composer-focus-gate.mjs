/**
 * 手机端「不自动弹输入法」闸门回归（2026-11-05 起点，2026-11-19 收紧口径）。
 *
 * 口径：默认全挡 + 窄白名单 —— 只有真实落点在输入框本体 / 卡片控件行以外的空白 /
 * 发送钮 / 语音那颗才算「要打字」；菜单落点、控件行容器（含那颗「＋」外面的 Tooltip
 * 包层与工具行空白）、权限/计划/模型/托管胶囊、PathBrowser 面板、上行历史 chip、
 * 以及输入区外的落点（换会话、侧栏、悬浮球）全都算 block 落点，谁更晚压住谁。
 *
 * 2026-11-19 复发的根因取证在 composerFocusGate.ts 文件头部（app.asar 行号 + 槽位条件），
 * 本文件的 2.3 段把「有历史记录的会话」那条真实形状复现出来：同一颗「＋」，
 * 手指落在按钮本体 → 挡；落在按钮外面的 _tools 行 / Tooltip 包层 / 胶囊容器 →
 * 旧口径把它们全判成「要打字」→ 宿主 focusDraftEditor 放行 → 键盘弹起。
 *
 * 用假 DOM 是因为这里要验的正是「宿主调 focus() 那一刻发生了什么」——
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
  SEAT_GRACE_MS,
  COMPOSER_FOCUS_LOG_QUERY,
  createComposerFocusGate,
  installComposerFocusGate,
} from '../src/client/pocket/mobile/composerFocusGate.ts'

// --- 1. 纯判定（新口径：默认全挡）------------------------------------------------
const gate = createComposerFocusGate()
assert.deepEqual(gate.inspect(), { lastTypingTapAt: null, lastBlockTapAt: null, graceMs: SEAT_GRACE_MS }, '开局什么落点都没有')
assert.equal(gate.shouldBlock(1000), true, '从列表点进会话、还没点过输入框 → 要挡')
gate.notePointer('other', 1500)
assert.equal(gate.shouldBlock(1501), true, '输入区里的非白名单落点也是 block 落点')
gate.notePointer('outside', 2000)
assert.equal(gate.shouldBlock(2001), true, '点会话行 / 悬浮球 / 控制台卡片（区外）不算要打字')
gate.notePointer('typing', 3000)
assert.equal(gate.shouldBlock(3000), false, '白名单落点的那一刻放行')
assert.equal(gate.shouldBlock(3000 + SEAT_GRACE_MS - 1), false, '窗口内都放行（发送后回填光标就在这几毫秒）')
assert.equal(gate.shouldBlock(3000 + SEAT_GRACE_MS + 1), true, '窗口外恢复拦截')
assert.equal(gate.shouldBlock(Number.NaN), true, '时钟读不到时保守拦截')
assert.equal(gate.shouldBlock(1000), true, '时钟倒退也挡：用户点输入框走的是浏览器原生 focus，不经过这里')
assert.deepEqual(gate.inspect(), { lastTypingTapAt: 3000, lastBlockTapAt: 2000, graceMs: SEAT_GRACE_MS }, '快照如实反映状态')

// 陈旧放行窗口不能被下一次换会话借走
gate.notePointer('typing', 4000)
assert.equal(gate.shouldBlock(4001), false, '刚点过输入框：放行')
gate.notePointer('outside', 4100)
assert.equal(gate.shouldBlock(4150), true, '又点了一下区外（换会话）→ 挂载聚焦必须挡，1.2 s 窗口不算数')
gate.notePointer('other', 4200)
assert.equal(gate.shouldBlock(4210), true, '输入区里的胶囊 / 容器也算 block')
gate.notePointer('typing', 4300)
assert.equal(gate.shouldBlock(4310), false, 'block 之后再直接点输入框 → 放行，键盘正常弹出')

const badGrace = createComposerFocusGate(Number.NaN)
assert.equal(badGrace.inspect().graceMs, SEAT_GRACE_MS, '非法窗口值回落默认值')

// 选择器就是宿主实际用的那几个（改了这里说明宿主 DOM 变了，需要重新取证）
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
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[data-slot="conversation.input.dock"]'), 'block 区里有 slot 锚点层的 dock（app.asar 26818562 的 data-slot div）')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[data-slot="conversation.composer.dock"]'), 'block 区里有插件自己的 composer 统计 chip')
assert.ok(COMPOSER_BLOCK_AREA_SELECTOR.includes('[data-slot="conversation.input.permission"]'), 'block 区里有权限胶囊的 slot 锚点')
assert.equal(COMPOSER_BLOCK_AREA_SELECTOR.includes('[data-slot="conversation.input.activity"]'), false, '语音那颗不在 block 区里：它是打字意图白名单')
assert.equal(COMPOSER_CONTROL_SELECTOR, 'button, a, input, select, textarea, [role="button"], [aria-haspopup], [aria-expanded], [tabindex]')
assert.equal(COMPOSER_FOCUS_LOG_QUERY, 'composerFocusLog', '取证开关的名字别乱改：手机 URL 要用')

// --- 2. 假 DOM -------------------------------------------------------------------
class FakeHTMLElement {
  constructor(selector) {
    this.selector = selector
    this.focused = false
  }

  matches(selector) {
    return this.selector === selector
  }

  focus() {
    this.focused = true
    return 'focused'
  }
}

const HTMLElement = class extends FakeHTMLElement {}
let now = 0
const listeners = new Map()
const doc = {
  defaultView: { HTMLElement, performance: { now: () => now }, location: { href: 'http://127.0.0.1:57593/pocket' } },
  addEventListener(type, handler) {
    listeners.set(type, handler)
  },
  removeEventListener(type) {
    listeners.delete(type)
  },
}

/**
 * 宿主 InputBar 的真实形状（类名与 data-* 都按 app.asar 里的字面量写死）：
 *   seat → card → overlayAnchor[data-composer-overlay]（命令菜单 / 电脑文件 PathBrowser）
 *   scroll → [data-composer-input]（Lexical contenteditable）
 *   row → tools（Tooltip 包层 → button[aria-haspopup="listbox"]._7tt59G_add）
 *   modes（权限 / 计划胶囊）→ trailing → standardControls（_root 模型 / _primary 发送 / _activity 麦克风）
 *   dock（队列 / 目标 / 上行历史 chip，会话作用域才有）
 */
const node = (tag, attrs = {}) => {
  const el = new FakeHTMLElement(attrs.class ?? '')
  el.tag = tag
  el.attrs = { ...attrs }
  el.children = []
  el.parent = null
  el.getAttribute = (name) => (el.attrs[name] === undefined ? null : String(el.attrs[name]))
  el.closest = (selector) => finder(el, selector)
  return el
}

/** 本文件的选择器只用到 tag / [attr] / [attr="v"] / [class$="v"]，自己写个小匹配器。 */
const finder = (el, selector) => {
  const matchOne = (candidate) => selector.split(',').some((token) => {
    token = token.trim()
    const head = token.match(/^([A-Za-z][A-Za-z0-9-]*)?/)
    if (head?.[1] && candidate.tag !== head[1].toLowerCase()) return false
    return (token.match(/\[[^\]]+\]/g) ?? []).every((clause) => {
      const inner = clause.slice(1, -1)
      const eq = inner.match(/^([^=]+)="(.*)"$/)
      if (eq) {
        const name = eq[1].trim()
        if (name.endsWith('$')) {
          const value = String(candidate.attrs[name.slice(0, -1)] ?? '')
          return value === eq[2] || value.split(/\s+/).some((item) => item.endsWith(eq[2]))
        }
        return String(candidate.attrs[name]) === eq[2]
      }
      return candidate.attrs[inner.trim()] !== undefined
    })
  })
  let current = el
  while (current !== null && current !== undefined) {
    if (matchOne(current)) return current
    current = current.parent ?? null
  }
  return null
}

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
    class: '_7tt59G_editor',
    'data-composer-input': 'true',
    contenteditable: 'true',
    'data-lexical-editor': 'true',
    role: 'textbox',
  })
  const row = node('div', { class: '_7tt59G_row' })
  const tools = node('div', { class: '_7tt59G_tools' })
  const tooltip = node('span', { class: '_9YPp_G_tooltipTrigger' })
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
  link(tooltip, plus)
  link(tools, tooltip, fileInput)
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
  link(dock, dockChip)
  link(composerDock, composerChip)
  link(seat, composerDock, dock, card)
  return {
    seat, card, overlay, menu, menuItem, pathBrowser, scroll, editor, row, tools, tooltip, plus, icon,
    modes, permissionCapsule, trailing, standardControls, modelRoot, modelCapsule, primary, activity,
    voiceRow, voiceButton, tuoguan, tuoguanButton, dock, dockChip, composerDock, composerChip, fileInput,
  }
}

const outsideRow = node('div', { class: '_9YPp_G_sessionRow' })

const beacon = []
const decisions = []
const uninstall = installComposerFocusGate({
  document: doc,
  onBlocked: (count, decision) => beacon.push({ count, kind: decision.kind, reason: decision.reason }),
  onDecision: (decision) => decisions.push(decision),
})

assert.equal(typeof listeners.get('pointerdown'), 'function', '主路监听是 pointerdown')
assert.equal(typeof listeners.get('touchstart'), 'function', '老 WebView 靠 touchstart 兜底')
assert.equal(decisions.length, 0, '取证开关默认关：不开就不发决策记录')

/** 真机落点：target 就是被点到的那个节点（图标 / 文本节点靠 parentElement 往上爬）。 */
const tap = (el) => {
  now += 10
  listeners.get('pointerdown')({ target: el })
}

/** 宿主的程序化聚焦：每次都当新的 [data-composer-input] 节点（会话重挂载后就是新节点）。 */
const programmaticFocus = () => {
  now += 1
  const fresh = new HTMLElement(COMPOSER_INPUT_SELECTOR)
  fresh.focus()
  return fresh.focused
}

/** 把输入卡片里那片区域按「旧口径最容易踩到」的方式点一遍：返回输入法会不会弹。 */
const tapAndFocus = (el) => {
  tap(el)
  return programmaticFocus()
}

// 2.1 进会话那一刻的自动聚焦被挡下
now = 100
assert.equal(programmaticFocus(), false, '进入会话那一刻的自动聚焦被挡下（键盘不弹）')
assert.deepEqual(beacon, [{ count: 1, kind: 'outside', reason: 'no-tap' }], '第一次挡下时发一条诊断 beacon')
assert.equal(programmaticFocus(), false, '宿主重试聚焦也照样挡住')
assert.equal(beacon.length, 1, 'beacon 不刷屏（同一次进入只报一条）')

// 2.2 直接点输入框本体：放行，输入法正常弹起
assert.equal(tapAndFocus(composerTree().editor), true, '点输入框本体 → 放行')
assert.equal(tapAndFocus(composerTree().scroll), true, '点输入卡片里的空白（控件行之外）→ 放行')
assert.equal(tapAndFocus(composerTree().primary), true, '点发送 / 停止那颗 → 放行（发完继续打字键盘不该收）')
assert.equal(tapAndFocus(composerTree().activity), true, '点语音那颗（activity 位）→ 放行')
assert.equal(tapAndFocus(composerTree().voiceButton), true, '点语音按钮本体 → 放行')

// 2.3 历史会话里点「＋」：宿主那两条 focus 都要挡 —— 本轮复发就是死在这一串上
const session = composerTree(false)
assert.equal(tapAndFocus(session.plus), false, '点「＋」按钮本体：挡（2026-11-19 修好的那条）')
assert.equal(tapAndFocus(session.icon), false, '点在「＋」里的图标节点上：挡')
assert.equal(tapAndFocus(session.tooltip), false, '点在「＋」外面的 Tooltip 包层上：挡（历史会话复发的那条）')
assert.equal(tapAndFocus(session.tools), false, '点工具行 _tools 自己的空白：挡')
assert.equal(tapAndFocus(session.row), false, '点控件行 _row 的空白：挡')
assert.equal(tapAndFocus(session.modes), false, '点权限 / 计划胶囊容器：挡（会话作用域才有）')
assert.equal(tapAndFocus(session.permissionCapsule), false, '点权限胶囊按钮：挡')
assert.equal(tapAndFocus(session.trailing), false, '点尾部那一区容器：挡')
assert.equal(tapAndFocus(session.standardControls), false, '点 _standardControls 容器：挡')
assert.equal(tapAndFocus(session.modelRoot), false, '点模型胶囊容器：挡')
assert.equal(tapAndFocus(session.tuoguan), false, '点插件自己的托管胶囊容器：挡')
assert.equal(tapAndFocus(session.menuItem), false, '点命令菜单里的选项行：挡')
assert.equal(tapAndFocus(session.pathBrowser), false, '点在电脑文件 PathBrowser 面板里：挡（挑路径不该弹输入法）')
assert.equal(tapAndFocus(session.dock), false, '点上行历史 / 队列 / 目标 chip：挡')
assert.equal(tapAndFocus(session.dockChip), false, '点 chip 上的按钮：挡')
assert.equal(tapAndFocus(session.composerDock), false, '点插件自己那两片 composer 统计 chip 的容器：挡')
assert.equal(tapAndFocus(session.composerChip), false, '点统计 chip 上的按钮：挡')
assert.equal(tapAndFocus(session.fileInput), false, '点卡片里那颗隐藏的 file input：挡')

// 2.4 换会话不能借到上一次「点过输入框」的放行窗口（gate 状态跨会话 / 跨重挂载仍生效）
tap(session.editor)
assert.equal(programmaticFocus(), true, '先直接点输入框：这一步本来该放行')
tap(outsideRow)
assert.equal(programmaticFocus(), false, '又点侧栏换会话 → 新挂载的 [data-composer-input] 节点照样挡')
assert.equal(programmaticFocus(), false, '连续两次程序化聚焦都挡（重挂载 / 尾快照补齐 / 选区同步）')

// 2.5 挡完之后用户要点输入框必须还能弹键盘
assert.equal(tapAndFocus(session.editor), true, '挡完之后直接点输入框 → 输入法照常弹起')
tap(session.plus)
assert.equal(programmaticFocus(), false, '再点「＋」：又回到挡')
assert.equal(tapAndFocus(session.editor), true, '菜单开过之后点输入框 → 放行')

// 2.6 别的输入框与插件自己的 textarea 不受影响
const search = new HTMLElement('[data-search-input]')
search.focus()
assert.equal(search.focused, true, '别的输入框（搜索 / 插件自己的 textarea）永远不受影响')

// 2.7 新开会话（hero 变体：会话作用域槽位全部不渲染）同一片落点也一律挡
const hero = composerTree(true)
assert.equal(tapAndFocus(hero.plus), false, 'hero 里点「＋」：挡')
assert.equal(tapAndFocus(hero.tooltip), false, 'hero 里点在「＋」外面的包层：挡（口径一致，不靠运气点准）')
assert.equal(tapAndFocus(hero.row), false, 'hero 里点控件行空白：挡')
assert.equal(tapAndFocus(hero.editor), true, 'hero 里点输入框本体：放行')

// 2.8 1.2 s 窗口过期后恢复拦截（相对最后一次白名单落点推窗口出去，不靠运气点准）
const lastTypingTapAt = now
now = lastTypingTapAt + SEAT_GRACE_MS + 5
assert.equal(programmaticFocus(), false, '落点窗口过期后再次进会话 → 挡（不会被上一次点击误放行）')

// --- 3. 卸载还原 -----------------------------------------------------------------
uninstall()
const after = new HTMLElement(COMPOSER_INPUT_SELECTOR)
after.focus()
assert.equal(after.focused, true, '卸载后宿主行为完全还原')
assert.equal(listeners.has('pointerdown'), false, 'pointerdown 监听摘干净')
assert.equal(listeners.has('touchstart'), false, 'touchstart 监听摘干净')

// 重复 install 只装一次（mobile-apply 重跑不会套娃）
const first = installComposerFocusGate({ document: doc })
const second = installComposerFocusGate({ document: doc })
assert.equal(listeners.size, 2, '第二次 install 不会再加监听（仍然只有两条）')
const blockedAgain = new HTMLElement(COMPOSER_INPUT_SELECTOR)
blockedAgain.focus()
assert.equal(blockedAgain.focused, false, '重新装上后照样生效')
second()
first()
const restored = new HTMLElement(COMPOSER_INPUT_SELECTOR)
restored.focus()
assert.equal(restored.focused, true, '最终还原')

// --- 4. 取证开关：?composerFocusLog=1 时放行与挡下都留一条决策记录 ----------------
doc.defaultView.location = { href: `http://127.0.0.1:57593/pocket?${COMPOSER_FOCUS_LOG_QUERY}=1` }
const logged = installComposerFocusGate({ document: doc, onDecision: (decision) => decisions.push(decision) })
tap(composerTree(false).plus)
new HTMLElement(COMPOSER_INPUT_SELECTOR).focus()
tap(composerTree(false).editor)
new HTMLElement(COMPOSER_INPUT_SELECTOR).focus()
assert.equal(decisions.length >= 2, true, '开关打开后决策记录进账（挡 / 放行各一条）')
const [blockedDecision, allowedDecision] = decisions
assert.equal(blockedDecision.blocked, true, '挡下那条报了 blocked=true')
assert.equal(blockedDecision.kind, 'menu', '挡下那条带落点意图（command-button / menu-item 一类）')
assert.equal(allowedDecision.blocked, false, '放行那条报了 blocked=false')
assert.equal(allowedDecision.reason, 'editor-body', '放行那条说清是哪条白名单放行的')
assert.ok(typeof allowedDecision.target === 'string' && allowedDecision.target.length > 0, '落点摘要不空')
logged()

console.log('ok test-composer-focus-gate')
