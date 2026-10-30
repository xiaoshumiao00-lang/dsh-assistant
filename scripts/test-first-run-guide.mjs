/** 首启引导的状态与文案回归（P0-6 / P0-8）：node scripts/test-first-run-guide.mjs */
import assert from 'node:assert/strict'

// Node 里没有 localStorage：先装一个内存假象（引导模块每次调用都现读，不缓存）
const fake = new Map()
globalThis.localStorage = {
  getItem: (key) => (fake.has(key) ? fake.get(key) : null),
  setItem: (key, value) => { fake.set(key, String(value)) },
  removeItem: (key) => { fake.delete(key) },
}

const guide = await import('../src/client/firstRunGuide.ts')
const { GUIDE_STATE_KEY, guideStatus, shouldAutoShow, markGuideSeen, markGuideSkipped, resetGuideStatus, guideScreens, showFirstRunGuide } = guide

const cases = []

cases.push(['第一次用（没有状态）会自动弹；弹过就不再自动弹', () => {
  fake.clear()
  assert.equal(guideStatus(), 'never')
  assert.equal(shouldAutoShow(), true)
  assert.equal(markGuideSeen(), 'seen')
  assert.equal(guideStatus(), 'seen')
  assert.equal(shouldAutoShow(), false)
  fake.clear()
  assert.equal(markGuideSkipped(), 'skipped')
  assert.equal(shouldAutoShow(), false)
  // 不认识的值一律当「没显示过」，不猜
  fake.set(GUIDE_STATE_KEY, 'garbage')
  assert.equal(guideStatus(), 'never')
  assert.equal(shouldAutoShow(), true)
  resetGuideStatus()
  assert.equal(guideStatus(), 'never')
}])

cases.push(['三屏文案：zh 与 en 都有、内容条数一致、id 一致', () => {
  const zh = guideScreens('zh')
  const en = guideScreens('en')
  assert.equal(zh.screens.length, 3, 'zh 引导该有三屏')
  assert.equal(en.screens.length, 3, 'en 引导该有三屏')
  assert.deepEqual(zh.screens.map((s) => s.id), ['orb', 'click', 'memory'])
  assert.deepEqual(en.screens.map((s) => s.id), ['orb', 'click', 'memory'])
  for (const screen of [...zh.screens, ...en.screens]) {
    assert.ok(screen.title.length > 4, `${screen.id} 缺标题`)
    assert.equal(screen.body.length, 3, `${screen.id} 该有 3 行说明`)
    for (const line of screen.body) assert.ok(line.trim().length > 8, `${screen.id} 有空行`)
    assert.ok(screen.primary && screen.secondary && screen.skip, `${screen.id} 缺按钮文案`)
    assert.ok(['orb', 'click', 'memory'].includes(screen.id), `${screen.id} 不是预期的屏幕 id`)
  }
}])

cases.push(['引导内容讲清三件事：悬浮球用途 / 单击 vs 长按 / 记忆在哪看怎么删', () => {
  const all = guideScreens('zh').screens.map((s) => [s.title, ...s.body].join('\n')).join('\n')
  assert.ok(all.includes('悬浮球'), '没说清悬浮球是干什么的')
  assert.ok(all.includes('长按') && all.includes('单击'), '单击 / 长按区别没写进去')
  assert.ok(all.includes('600'), '长按时长没说明')
  assert.ok(all.includes('它记下了什么'), '没有告诉用户记忆面板在哪')
  assert.ok(all.includes('重启'), '删记忆要重启这件事没说明')
  assert.ok(all.includes('USER.md') && all.includes('MEMORY.md'), '记忆两侧没说明')
  const enText = guideScreens('en').screens.map((s) => [s.title, ...s.body].join('\n')).join('\n')
  assert.ok(/press and hold/i.test(enText), '英文引导缺长按说明')
  assert.ok(/600/.test(enText), '英文引导缺长按时长')
  assert.ok(/USER\.md/.test(enText) && /MEMORY\.md/.test(enText), '英文引导缺记忆两侧说明')
  assert.ok(/restart/i.test(enText), '英文引导缺重启说明')
  assert.ok(/control room/i.test(enText), '英文引导没说是控制室')
}])

cases.push(['引导文案里没有本机个人化内容', () => {
  const text = JSON.stringify(guideScreens('zh')) + JSON.stringify(guideScreens('en'))
  for (const banned of ['陈潘', 'HBEU', 'Administrator', '微信联系人', '01_content']) {
    assert.ok(!text.includes(banned), `引导文案里出现了本机个人化内容：${banned}`)
  }
}])

cases.push(['没有 localStorage（隐私模式）时读写都不崩、状态退回 never', () => {
  const real = globalThis.localStorage
  // 先用真存储立一个状态：'seen'
  resetGuideStatus()
  markGuideSeen()
  assert.equal(guideStatus(), 'seen')
  const broken = {
    getItem: () => { throw new Error('SecurityError') },
    setItem: () => { throw new Error('QuotaExceeded') },
    removeItem: () => { throw new Error('SecurityError') },
  }
  globalThis.localStorage = broken
  try {
    assert.equal(guideStatus(), 'never', '读不到存储就退回「没显示过」，且不抛')
    assert.equal(markGuideSeen(), 'seen', '写失败也要返回当前状态，不抛错')
    resetGuideStatus() // 不该抛
  } finally {
    globalThis.localStorage = real
  }
  assert.equal(guideStatus(), 'seen', '坏存储期间的写入不该改掉已有状态')
  delete globalThis.localStorage
  try {
    assert.equal(guideStatus(), 'never', '完全没有 localStorage 时也不该抛错')
    assert.equal(shouldAutoShow(), true)
    showFirstRunGuide({ auto: true })
  } catch (err) {
    throw new Error('没有 DOM / 没有存储时引导不该抛：' + err.message)
  } finally {
    globalThis.localStorage = real
  }
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : err))
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
