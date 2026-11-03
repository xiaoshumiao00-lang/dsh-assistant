/** 输入框 / IME 与控制室卡片三件套的纯函数回归：node scripts/test-native-input-policy.mjs
 *  1) 输入框高度策略：键盘动画中间那串 resize 不再重复强制布局（只有内容变了才重测）；
 *  2) 组合输入（拼音候选未上屏）期间推迟测量；
 *  3) 控制室卡片等价判据：一次 bump 只重渲染真变了的那几张卡。
 */
import assert from 'node:assert/strict'
import {
  COMPOSER_MAX_VIEWPORT_RATIO,
  composerHeightCap,
  composerHeightFor,
  createCompositionTracker,
  shouldDeferComposerLayout,
  shouldRemeasure,
} from '../src/client/pocket/orb/composerPolicy.ts'
import {
  CONSOLE_FIRST_MOUNT,
  countCardsNeedingRender,
  sameConsoleCard,
} from '../src/client/consoleCardPolicy.ts'

const cases = []

cases.push(['输入框：封顶跟着视口走（40%），视口未知不设上限', () => {
  assert.equal(composerHeightCap(800), Math.floor(800 * COMPOSER_MAX_VIEWPORT_RATIO))
  assert.equal(composerHeightCap(0), 0)
  assert.equal(composerHeightCap(Number.NaN), 0)
  assert.equal(composerHeightFor(120, 320), 120, '没到封顶就用内容高度')
  assert.equal(composerHeightFor(900, 320), 320, '超过封顶就裁到封顶')
  assert.equal(composerHeightFor(0, 320), 0)
}])

cases.push(['输入框：键盘动画中间的 resize 不再重排（同一封顶 → 不测）', () => {
  const prev = { contentHeight: 90, cap: 320 }
  assert.equal(shouldRemeasure(prev, 320), false, '封顶没变 = 键盘还在动画，不必再量')
  assert.equal(shouldRemeasure(prev, 400), false, '封顶变大 = 直接写封顶值就够')
  assert.equal(shouldRemeasure({ contentHeight: -1, cap: 0 }, 320), true, '从没量过必须量一次')
  // 键盘弹起：封顶变小，且内容本来就顶到上限 → 要重算一次（会出现滚动条）
  assert.equal(shouldRemeasure({ contentHeight: 320, cap: 320 }, 180), true)
  // 内容没顶到上限 → 封顶变小也不用量
  assert.equal(shouldRemeasure({ contentHeight: 90, cap: 320 }, 180), false)
}])

cases.push(['输入框：组合输入与页面不可见时推迟测量', () => {
  assert.equal(shouldDeferComposerLayout(true, false), true, '组合中输入法候选未上屏')
  assert.equal(shouldDeferComposerLayout(false, true), true, '页面不可见')
  assert.equal(shouldDeferComposerLayout(false, false), false)
  const tracker = createCompositionTracker()
  assert.equal(tracker.isComposing(), false)
  tracker.start()
  assert.equal(tracker.isComposing(), true)
  tracker.end()
  assert.equal(tracker.isComposing(), false, 'compositionend 之后必须恢复测量')
}])

const card = (over) => ({
  id: 'p1', name: '项目', icon: '📁', status: 'idle', count: 0, preview: '',
  live: false, glow: false, bound: true, temp: false, self: false,
  canNewSession: true, runtimeMs: null, ...over,
})

cases.push(['控制室：同一张卡的数据没变 → 不重渲染', () => {
  assert.equal(sameConsoleCard(card({}), card({})), true)
  assert.equal(sameConsoleCard(card({}), card({ status: 'busy' })), false, '状态变了要重渲染')
  assert.equal(sameConsoleCard(card({}), card({ preview: '新的一行' })), false, '预览变了要重渲染')
  assert.equal(sameConsoleCard(card({}), card({ runtimeMs: 1234 })), false, '计时基值变了要重渲染')
  assert.equal(sameConsoleCard(null, card({})), false)
}])

cases.push(['控制室：一次 bump 只重渲染变了的卡（多任务流式期的主收益）', () => {
  const before = Array.from({ length: 40 }, (_, i) => card({ id: 'p' + String(i), preview: '第 ' + String(i) + ' 段' }))
  // 40 张里只有一张在流式更新
  const after = before.map((c, i) => (i === 7 ? { ...c, preview: '第 7 段 + 新增 token', live: true } : c))
  assert.equal(countCardsNeedingRender(before, after), 1, '其余 39 张必须被 memo 挡住')
  assert.equal(sameConsoleCard(before[0], after[0]), true)
}])

cases.push(['控制室：首屏只挂前 12 张，其余空闲帧补齐', () => {
  assert.equal(CONSOLE_FIRST_MOUNT, 12)
  const many = Array.from({ length: 60 }, (_, i) => card({ id: 'p' + String(i) }))
  assert.equal(many.slice(0, CONSOLE_FIRST_MOUNT).length, 12)
  assert.equal(countCardsNeedingRender(many, many), 0, '同一份数组不该触发任何重渲染')
}])

let passed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (error) {
    console.error('  FAIL ' + name)
    console.error('       ' + (error?.message ?? String(error)))
    process.exitCode = 1
  }
}
console.log('[test-native-input-policy] ' + String(passed) + '/' + String(cases.length) + ' passed')
