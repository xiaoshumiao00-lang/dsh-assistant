/**
 * CU 会话「语音播报友好」系统提示词测试。
 *
 *   node scripts/test-cu-broadcast-style.mjs
 *
 * 盯住三件事：
 *   1. CU 会话（header.agentPreset / 投影形态）→ 返回约束文案；
 *   2. 非 CU 会话（standard 等）→ 返回空字符串，别的模式一个字都不多；
 *   3. 宿主没有 systemPrompt 服务 → 不抛错、只记警告（插件照样能启动）。
 */
import assert from 'node:assert/strict'

import {
  CU_BROADCAST_STYLE_TEXT,
  CU_COMPUTER_USE_PRESET,
  isComputerUseSessionForPrompt,
  registerCuBroadcastStyle,
} from '../src/cu-broadcast-style.ts'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`)
  }
}

/** 假 systemPrompt 服务：记下每次 section() 的入参，方便断言。 */
function fakeSystemPrompt() {
  const registered = []
  return {
    registered,
    section(options) {
      registered.push(options)
      let disposed = false
      return () => { disposed = true }
    },
  }
}

/** 假 ctx：get(id) 返回假服务；overrides 可覆盖任何服务。 */
function fakeCtx(overrides = {}) {
  return {
    get(id) {
      if (id === 'systemPrompt') return overrides.systemPrompt
      return overrides[id]
    },
    ...overrides,
  }
}

/** 造型：context.agent.session 是 text 回调唯一读到的入口。 */
function contextFor(session) {
  return { agent: { session } }
}

console.log('[cu-broadcast-style] 文案与判定')

test('文案覆盖四条要点（150 字 / 口语不用符号 / 路径保留原文 / 少汇报）', () => {
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('150 字'), '要有 150 字上限')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('先给结论'), '要先给结论')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('口语'), '要口语化')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('markdown'), '要禁 markdown')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('表格'), '要禁表格')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('代码块'), '要禁代码块')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('表情符号'), '要禁 emoji')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('任务本身'), '要留「任务本身需要时除外」的例外')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('文件路径'), '路径要保留原文')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('一两句话总结结果'), '做完只做简短总结')
  assert.ok(CU_BROADCAST_STYLE_TEXT.includes('320×240'), '要说明小屏场景')
})

test('CU 判定：header.agentPreset / 直接字段 / 投影三种形态都命中', () => {
  assert.equal(CU_COMPUTER_USE_PRESET, 'computer-use')
  assert.equal(isComputerUseSessionForPrompt({ header: { agentPreset: 'computer-use' } }), true)
  assert.equal(isComputerUseSessionForPrompt({ agentPreset: 'computer-use' }), true)
  assert.equal(isComputerUseSessionForPrompt({ projection: { values: { agentPreset: 'computer-use' } } }), true)
  assert.equal(isComputerUseSessionForPrompt({ projection: { values: { agentPreset: { val: 'computer-use' } } } }), true)
  assert.equal(isComputerUseSessionForPrompt({ header: { agentPreset: { val: 'computer-use' } } }), false, 'header 只认字符串')
  assert.equal(isComputerUseSessionForPrompt({ header: { agentPreset: 'standard' } }), false)
  assert.equal(isComputerUseSessionForPrompt({}), false)
  assert.equal(isComputerUseSessionForPrompt(undefined), false)
  assert.equal(isComputerUseSessionForPrompt(null), false)
})

console.log('[cu-broadcast-style] 注册与求值')

test('CU 会话 → text 回调返回约束文案', () => {
  const sp = fakeSystemPrompt()
  const ctx = fakeCtx({ systemPrompt: sp })
  const dispose = registerCuBroadcastStyle(ctx)
  assert.equal(sp.registered.length, 1, '应注册一段')
  const section = sp.registered[0]
  assert.equal(section.name, 'tihu:broadcast-style')
  assert.equal(section.order, 1800, '排在 CU 策略段 1750 之后')
  assert.equal(typeof section.text, 'function')
  // header 形态
  assert.equal(section.text(contextFor({ header: { agentPreset: 'computer-use' } })), CU_BROADCAST_STYLE_TEXT)
  // 投影形态
  assert.equal(section.text(contextFor({ projection: { values: { agentPreset: 'computer-use' } } })), CU_BROADCAST_STYLE_TEXT)
  assert.equal(typeof dispose, 'function', '返回注销函数')
})

test('非 CU 会话 → 空字符串（一个字都不多说）', () => {
  const sp = fakeSystemPrompt()
  registerCuBroadcastStyle(fakeCtx({ systemPrompt: sp }))
  const section = sp.registered[0]
  assert.equal(section.text(contextFor({ header: { agentPreset: 'standard' } })), '')
  assert.equal(section.text(contextFor({ header: { agentPreset: 'standard-slim-local' } })), '')
  assert.equal(section.text(contextFor({ header: { agentPreset: 'cordis' } })), '')
  assert.equal(section.text(contextFor(undefined)), '')
  assert.equal(section.text({}), '', 'context 没有 agent 也不能抛')
  assert.equal(section.text(undefined), '', 'context 是 undefined 也不能抛')
})

test('没有 systemPrompt 服务 → 只记警告、不抛错', () => {
  const warnings = []
  const dispose = registerCuBroadcastStyle(fakeCtx({}), (line) => warnings.push(line))
  assert.equal(dispose, undefined)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('systemPrompt'), `警告要说清原因，实际：${warnings[0]}`)
  // 服务存在但没有 section 方法：同样安全
  const noSection = []
  assert.equal(registerCuBroadcastStyle(fakeCtx({ systemPrompt: {} }), (line) => noSection.push(line)), undefined)
  assert.equal(noSection.length, 1)
  // ctx 本身是坏的（get 抛错）也不能炸
  const broken = { get() { throw new Error('no service') } }
  const brokenWarnings = []
  assert.equal(registerCuBroadcastStyle(broken, (line) => brokenWarnings.push(line)), undefined)
  assert.equal(brokenWarnings.length, 1)
})

test('section 抛错时被吞掉并记警告（不影响插件启动）', () => {
  const warnings = []
  const sp = { section() { throw new Error('host rejected') } }
  const dispose = registerCuBroadcastStyle(fakeCtx({ systemPrompt: sp }), (line) => warnings.push(line))
  assert.equal(dispose, undefined)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('host rejected'))
})

test('ctx.systemPrompt 直接挂在 ctx 上（没有 get）也能注册', () => {
  const sp = fakeSystemPrompt()
  const dispose = registerCuBroadcastStyle({ systemPrompt: sp })
  assert.equal(sp.registered.length, 1)
  assert.equal(typeof dispose, 'function')
})

console.log(failed === 0 ? `\nPASS ${passed}/${passed + failed}` : `\nFAIL ${passed}/${passed + failed}`)
if (failed > 0) process.exitCode = 1
