/**
 * 手机端「进入会话不自动弹输入法」（2026-11-05）＋「点＋菜单不抢输入框焦点」（2026-11-19）回归：
 *   1) 纯判定：没点过输入框（切会话 / 启动恢复）→ 挡；点过输入框 1.2 s 内 → 放行；
 *      点「＋」或菜单里的选项行 → 挡，且菜单之后再点输入框照样放行；
 *   2) 假 DOM 装上后：宿主 contenteditable 的 programmatic focus 真的被吞掉，
 *      插件自己的输入框 / 搜索框不受影响；
 *   3) 卸载后 prototype.focus 与监听完全还原（不能留下全局副作用）。
 *
 * 用假 DOM 是因为这里要验的正是「宿主调 focus() 那一刻发生了什么」——
 * jsdom 不需要，仓库也不引第三方断言框架。
 */
import assert from 'node:assert/strict'
import {
  COMPOSER_INPUT_SELECTOR,
  COMPOSER_SEAT_SELECTOR,
  COMPOSER_COMMAND_BUTTON_SELECTOR,
  COMPOSER_MENU_SELECTOR,
  SEAT_GRACE_MS,
  createComposerFocusGate,
  installComposerFocusGate,
} from '../src/client/pocket/mobile/composerFocusGate.ts'

// --- 1. 纯判定 -----------------------------------------------------------------
const gate = createComposerFocusGate()
assert.equal(gate.shouldBlock(1000), true, '从列表点进会话、还没点过输入框 → 要挡')
gate.notePointer(false, 2000)
assert.equal(gate.shouldBlock(2001), true, '点会话行 / 悬浮球 / 控制台卡片（区外）不算要打字')
gate.notePointer(true, 3000)
assert.equal(gate.shouldBlock(3000), false, '点输入框的那一刻放行')
assert.equal(gate.shouldBlock(3000 + SEAT_GRACE_MS - 1), false, '窗口内都放行（发送后回填光标就在这几毫秒）')
assert.equal(gate.shouldBlock(3000 + SEAT_GRACE_MS + 1), true, '窗口外恢复拦截')
assert.equal(gate.shouldBlock(Number.NaN), true, '时钟读不到时保守拦截')
assert.equal(gate.shouldBlock(1000), false, '时钟倒退按「刚点过」放行，不能反过来挡用户')
assert.deepEqual(gate.inspect(), { lastSeatPointerAt: 3000, lastMenuTapAt: null, graceMs: SEAT_GRACE_MS }, '快照如实反映状态')

// 点「＋」命令菜单（2026-11-19）：那一下不是要打字，紧跟其后的程序化聚焦一律挡
gate.notePointer(true, 4000, 'menu')
assert.equal(gate.shouldBlock(4001), true, '点「＋」开菜单时宿主 keepFocus / toggleCommandMenu 的聚焦要挡下（输入法不弹）')
gate.notePointer(true, 4100, 'menu')
assert.equal(gate.shouldBlock(4101), true, '点菜单里的选项行（电脑文件 / 文件 / 目标 / 计划）也一样不抢焦点')
assert.equal(gate.inspect().lastMenuTapAt, 4100, '菜单落点记在独立的菜单槽上')
gate.notePointer(true, 5000)
assert.equal(gate.shouldBlock(5000), false, '菜单之后再直接点输入框 → 放行，键盘正常弹出')

const badGrace = createComposerFocusGate(Number.NaN)
assert.equal(badGrace.inspect().graceMs, SEAT_GRACE_MS, '非法窗口值回落默认值')

// 选择器就是宿主实际用的那几个（改了这里说明宿主 DOM 变了，需要重新取证）
assert.equal(COMPOSER_INPUT_SELECTOR, '[data-composer-input]')
assert.equal(COMPOSER_SEAT_SELECTOR, '[data-conversation-region="composer"]')
assert.equal(COMPOSER_COMMAND_BUTTON_SELECTOR, 'button[aria-haspopup="listbox"]')
assert.equal(COMPOSER_MENU_SELECTOR, '[data-trigger-menu]')

// --- 2. 假 DOM：装上之后真的挡得住 ------------------------------------------------
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

let now = 0
const listeners = new Map()
const HTMLElement = class extends FakeHTMLElement {}
const doc = {
  defaultView: { HTMLElement, performance: { now: () => now } },
  addEventListener(type, handler) {
    listeners.set(type, handler)
  },
  removeEventListener(type) {
    listeners.delete(type)
  },
}
const beacon = []
const uninstall = installComposerFocusGate({ document: doc, onBlocked: (n) => beacon.push(n) })

assert.equal(typeof listeners.get('pointerdown'), 'function', '主路监听是 pointerdown')
assert.equal(typeof listeners.get('touchstart'), 'function', '老 WebView 靠 touchstart 兜底')

/** 模拟一次手指落点：'typing' 点在输入框 / 卡片空白，'menu' 点「＋」或菜单里的选项行，'outside' 点在输入区外。 */
const pointer = (kind) => {
  const handler = listeners.get('pointerdown')
  handler({
    target: {
      closest: (selector) => {
        if (selector === COMPOSER_SEAT_SELECTOR) return kind === 'outside' ? null : {}
        if (kind === 'menu'
          && (selector === COMPOSER_MENU_SELECTOR || selector === COMPOSER_COMMAND_BUTTON_SELECTOR)) return {}
        return null
      },
    },
  })
}

const composer = new HTMLElement(COMPOSER_INPUT_SELECTOR)
now = 100
composer.focus()
assert.equal(composer.focused, false, '进入会话那一刻的自动聚焦被挡下（键盘不弹）')
assert.deepEqual(beacon, [1], '第一次挡下时发一条诊断 beacon')

composer.focus()
assert.equal(composer.focused, false, '宿主重试聚焦也照样挡住')
assert.deepEqual(beacon, [1], 'beacon 不刷屏（同一次进入只报一条）')

pointer('outside')
now = 200
composer.focus()
assert.equal(composer.focused, false, '点了会话列表（区外）不等于要打字')

pointer('typing')
now = 300
composer.focus()
assert.equal(composer.focused, true, '点输入框之后照常聚焦 → 键盘正常弹出')

const search = new HTMLElement('[data-search-input]')
search.focus()
assert.equal(search.focused, true, '别的输入框（搜索 / 插件自己的 textarea）永远不受影响')

now = 300 + SEAT_GRACE_MS + 10
const nextComposer = new HTMLElement(COMPOSER_INPUT_SELECTOR)
nextComposer.focus()
assert.equal(nextComposer.focused, false, '点过输入框 1.2 s 之后再进会话，仍然挡（不会被上一次点击误放行）')

// --- 2.5 「＋」命令菜单不抢输入框焦点（2026-11-19 的修复本体）---------------------
// 先让用户 1.6 s 前"刚"点过输入框，把放行窗口是活的状态带进来：
// 这一步的聚焦本来该发生（输入法弹起），说明后续断言不是在测"窗口已经过期"。
now = 1600
pointer('typing')
const typingComposer = new HTMLElement(COMPOSER_INPUT_SELECTOR)
typingComposer.focus()
assert.equal(typingComposer.focused, true, '直接点输入框：先聚焦，输入法正常弹起')

now = 1610
pointer('menu')
const plusComposer = new HTMLElement(COMPOSER_INPUT_SELECTOR)
plusComposer.focus()
assert.equal(plusComposer.focused, false, '点「＋」那一下：宿主 mousedown 的 keepFocus 被挡下（只出菜单，键盘不弹）')
plusComposer.focus()
assert.equal(plusComposer.focused, false, '同一次 click 里 toggleCommandMenu 的 focusDraftEditor 也照样挡住')

// 菜单里的选项行（电脑文件 / 文件 / 目标 / 计划）同样不该把光标抢进输入框
now = 1700
pointer('menu')
const pickComposer = new HTMLElement(COMPOSER_INPUT_SELECTOR)
pickComposer.focus()
assert.equal(pickComposer.focused, false, '挑完菜单那一下也不弹输入法')

// 菜单开过之后用户直接点输入框：必须放行，不能把键盘弄没
now = 1710
pointer('typing')
const afterMenuComposer = new HTMLElement(COMPOSER_INPUT_SELECTOR)
afterMenuComposer.focus()
assert.equal(afterMenuComposer.focused, true, '菜单之后再直接点输入框 → 输入法照常弹起（菜单类落点不越权）')

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

console.log('ok test-composer-focus-gate')
