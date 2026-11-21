/**
 * 桌面悬浮球手势对调单测（不启动 Electron、不碰网络）：
 *   node scripts/test-desktop-ball-gestures.mjs
 *
 * 2026-11-21 用户要求对调：
 *   单击球（短按松手、未拖动） = 直接进「个人秘书」固定会话；
 *   长按 600ms              = 进控制室（原来的单击行为）；
 *   Ctrl+Alt+A              = 仍然进个人秘书。
 *
 * 这里不只测常量，还要测「真正写进 Electron helper 的那段代码」——
 * 上一版的问题就是映射写在生成的字符串里，常量对了、生成的代码仍可能是反的。
 */
import assert from 'node:assert/strict'

const lib = await import('../lib/index.js')
const surface = lib.desktopBallTestSurface

const cases = []

cases.push(['手势映射：单击=个人秘书，长按=控制室，热键=个人秘书', () => {
  assert.equal(surface.ballIntentFor('short-press'), 'assistant')
  assert.equal(surface.ballIntentFor('long-press'), 'console')
  assert.equal(surface.ballIntentFor('hotkey'), 'assistant')
  // 两者必须相反：串了就说明对调没生效
  assert.notEqual(surface.ballIntentFor('short-press'), surface.ballIntentFor('long-press'))
}])

cases.push(['生成的 helper：ball-up 发秘书、ball-long-press 发控制室', () => {
  const main = surface.helperMain()
  const shortPress = /ipcMain\.on\('ball-up'[\s\S]*?send\('([a-z]+)'\)/.exec(main)
  const longPress = /ipcMain\.on\('ball-long-press'[\s\S]*?send\('([a-z]+)'\)/.exec(main)
  assert.ok(shortPress, 'helper 里找不到 ball-up 的 send()')
  assert.ok(longPress, 'helper 里找不到 ball-long-press 的 send()')
  assert.equal(shortPress[1], 'assistant', `ball-up 实际发的是 ${shortPress[1]}`)
  assert.equal(longPress[1], 'console', `ball-long-press 实际发的是 ${longPress[1]}`)
  // 生成的代码必须和声明表一致（改了一边忘了另一边就会在这里红）
  assert.equal(shortPress[1], surface.ballIntentFor('short-press'))
  assert.equal(longPress[1], surface.ballIntentFor('long-press'))
  // 不能再有旧版「单击发 click」的写法（click 只允许作为 socket 的兼容别名）
  assert.ok(!/ball-up'[\s\S]{0,200}send\('click'\)/.test(main), 'ball-up 还在发旧的 click')
}])

cases.push(['生成的 helper：热键仍发秘书，且与长按不同向', () => {
  const main = surface.helperMain()
  const hotkey = /globalShortcut\.register\('Control\+Alt\+A'[\s\S]*?send\('([a-z]+)'\)/.exec(main)
  assert.ok(hotkey, 'helper 里找不到 Ctrl+Alt+A 的 send()')
  assert.equal(hotkey[1], 'assistant')
  assert.equal(hotkey[1], surface.ballIntentFor('hotkey'))
  const longPress = /ipcMain\.on\('ball-long-press'[\s\S]*?send\('([a-z]+)'\)/.exec(main)
  assert.notEqual(hotkey[1], longPress[1])
}])

cases.push(['socket 文本 → 意图：两个意图名都认，旧 click 只当控制室', () => {
  assert.equal(surface.socketBallIntent('assistant'), 'assistant')
  assert.equal(surface.socketBallIntent('console'), 'console')
  assert.equal(surface.socketBallIntent(' click '), 'console') // 旧 helper 的兼容别名
  assert.equal(surface.socketBallIntent(''), null)
  assert.equal(surface.socketBallIntent('nonsense'), null)
}])

cases.push(['生成的 helper：上行只可能发两个意图名，不会把 click 当秘书', () => {
  const main = surface.helperMain()
  const sent = [...main.matchAll(/send\('([a-z-]+)'\)/g)].map((match) => match[1])
  assert.ok(sent.length >= 3, `helper 里 send() 次数异常：${sent.join(',')}`)
  for (const value of sent) assert.ok(value === 'console' || value === 'assistant', `helper 发了未知意图 ${value}`)
}])

cases.push(['球体 HTML：拖动中不触发长按（移动超过阈值会取消计时）', () => {
  const html = surface.ballHtml()
  assert.match(html, /moved >= 6/)
  assert.match(html, /clearTimeout\(lpTimer\)/)
  assert.match(html, /ball-long-press/)
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
console.log(`PASS ${cases.length}/${cases.length} desktop-ball-gestures`)
