/**
 * 个人秘书打开动作的稳定态守卫单测（纯函数，不需要浏览器）：
 *   node scripts/test-secretary-open-guard.mjs
 *
 * 这些断言就是「闪烁不再复发」的机器证明：
 *   1. 同一条会话只会真正 open 一次（重复长按只做幂等 focus，不重新装载页面）；
 *   2. 换会话才会再 open 一次（不会因为「已经开过别的」就永远不开）；
 *   3. 骨架屏最多允许一次，且只在「本地无缓存 + 还没渲染过 + 还没尝试过」时；
 *   4. 幂等状态落盘：内容没变不落状态（远端刷新不会引起重渲染）。
 */
import assert from 'node:assert/strict'
import {
  createPanelOpenGuard,
  skeletonAllowed,
  stableChange,
} from '../src/client/secretary-open-guard.ts'

const cases = []

cases.push(['同一条会话只 open 一次，重复打开只 focus', () => {
  const guard = createPanelOpenGuard()
  assert.equal(guard.decide('s1'), 'open')
  assert.equal(guard.decide('s1'), 'focus')
  assert.equal(guard.decide('s1'), 'focus')
  assert.equal(guard.shown(), 's1')
  // 连按 10 次也不会再 open（= 主面板不会被反复重新装载）
  const actions = Array.from({ length: 10 }, () => guard.decide('s1'))
  assert.deepEqual(actions, Array(10).fill('focus'))
}])

cases.push(['换会话会再 open 一次', () => {
  const guard = createPanelOpenGuard()
  assert.equal(guard.decide('s1'), 'open')
  assert.equal(guard.decide('s2'), 'open')
  assert.equal(guard.decide('s2'), 'focus')
  assert.equal(guard.decide('s1'), 'open')
}])

cases.push(['空 id 不 open（会话还没就绪时不做无意义切页）', () => {
  const guard = createPanelOpenGuard()
  assert.equal(guard.decide(''), 'focus')
  assert.equal(guard.shown(), '')
}])

cases.push(['骨架屏只在首次无缓存时允许一次', () => {
  assert.equal(skeletonAllowed({ hadCache: false, attempts: 0, renderedOnce: false }), true)
  // 已经有缓存内容 → 永不骨架（旧版本就是在这里交替闪的）
  assert.equal(skeletonAllowed({ hadCache: true, attempts: 0, renderedOnce: false }), false)
  // 已经渲染过真实内容 → 永不回退到骨架
  assert.equal(skeletonAllowed({ hadCache: false, attempts: 0, renderedOnce: true }), false)
  // 已经尝试过一次（哪怕是失败）→ 不再反复骨架
  assert.equal(skeletonAllowed({ hadCache: false, attempts: 1, renderedOnce: false }), false)
  // 模拟「刷新 → 清空 → 再刷新」的旧病：任何一次重试都不允许骨架重新出现
  let attempts = 0
  const allowed = []
  for (let i = 0; i < 5; i += 1) {
    allowed.push(skeletonAllowed({ hadCache: false, attempts, renderedOnce: false }))
    attempts += 1
  }
  assert.deepEqual(allowed, [true, false, false, false, false])
}])

cases.push(['幂等落状态：内容没变就不落（防重渲染震荡）', () => {
  const equal = (a, b) => a.turns === b.turns && a.tokens === b.tokens
  assert.equal(stableChange({ turns: 1, tokens: 10 }, { turns: 1, tokens: 10 }, equal), null)
  assert.deepEqual(stableChange({ turns: 1, tokens: 10 }, { turns: 1, tokens: 11 }, equal), { turns: 1, tokens: 11 })
  assert.equal(stableChange(null, null, (a, b) => a === b), null)
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} secretary-open-guard`)
