/** 剪贴板复制兜底逻辑回归：node scripts/test-clipboard.mjs
 *  手机经 http（隧道/局域网）访问 DSH 时没有 navigator.clipboard，必须靠 textarea + execCommand。 */
import assert from 'node:assert/strict'
import { copyTextToClipboard } from '../src/client/clipboard.ts'

const cases = []

/** 用假 navigator/document/window 跑一次复制，结束后恢复原全局（Node 自带 navigator）。 */
async function withDom(globals, run) {
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const docDesc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const winDesc = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'navigator', { value: globals.navigator, configurable: true, writable: true })
  if ('document' in globals) Object.defineProperty(globalThis, 'document', { value: globals.document, configurable: true, writable: true })
  if ('window' in globals) Object.defineProperty(globalThis, 'window', { value: globals.window, configurable: true, writable: true })
  try {
    return await run()
  } finally {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc)
    else delete globalThis.navigator
    if (docDesc) Object.defineProperty(globalThis, 'document', docDesc)
    else delete globalThis.document
    if (winDesc) Object.defineProperty(globalThis, 'window', winDesc)
    else delete globalThis.window
  }
}

/** 记录所有操作的假 textarea / document。 */
function fakeDocument(execResult = true) {
  const calls = []
  const el = {
    value: '',
    style: {},
    setAttribute: (name, value) => { calls.push(['attr', name, value]) },
    focus: () => { calls.push(['focus']) },
    select: () => { calls.push(['select']) },
    setSelectionRange: (start, end) => { calls.push(['range', start, end]) },
    remove: () => { calls.push(['remove']) },
  }
  return {
    calls,
    el,
    createElement: (tag) => { calls.push(['createElement', tag]); return el },
    body: { appendChild: (node) => { calls.push(['appendChild', node === el]) } },
    execCommand: (cmd) => { calls.push(['execCommand', cmd]); return execResult },
  }
}

cases.push(['Clipboard API 可用：直接写入，不碰 DOM', async () => {
  const seen = []
  const result = await withDom({
    navigator: { clipboard: { writeText: async (text) => { seen.push(text) } } },
    document: { createElement: () => { throw new Error('不该走 DOM 兜底') } },
  }, () => copyTextToClipboard('D:\\陈潘HBEU\\项目 A'))
  assert.equal(result, true)
  assert.deepEqual(seen, ['D:\\陈潘HBEU\\项目 A'])
}])

cases.push(['安全上下文但 Clipboard API 被拒 → textarea + execCommand 兜底', async () => {
  const doc = fakeDocument(true)
  const result = await withDom({
    navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError') } } },
    document: doc,
  }, () => copyTextToClipboard('D:\\陈潘HBEU\\Desktop\\删除'))
  assert.equal(result, true)
  assert.equal(doc.el.value, 'D:\\陈潘HBEU\\Desktop\\删除')
  assert.deepEqual(doc.calls.filter((c) => c[0] === 'execCommand'), [['execCommand', 'copy']])
  // iOS Safari 只默认选第一行：必须显式给出整个选区
  assert.deepEqual(doc.calls.filter((c) => c[0] === 'range'), [['range', 0, 'D:\\陈潘HBEU\\Desktop\\删除'.length]])
  // 临时节点必须收掉，不能留在页面里
  assert.deepEqual(doc.calls.filter((c) => c[0] === 'remove'), [['remove']])
}])

cases.push(['没有 navigator.clipboard（手机 http 页面）→ 兜底可用', async () => {
  const doc = fakeDocument(true)
  const result = await withDom({ navigator: {}, document: doc }, () => copyTextToClipboard('/home/pan'))
  assert.equal(result, true)
  assert.equal(doc.el.value, '/home/pan')
}])

cases.push(['非安全上下文（手机 http）：不碰 Clipboard API，直接同步 execCommand', async () => {
  let apiCalls = 0
  const doc = fakeDocument(true)
  const result = await withDom({
    window: { isSecureContext: false },
    navigator: { clipboard: { writeText: async () => { apiCalls += 1 } } },
    document: doc,
  }, () => copyTextToClipboard('D:\\陈潘HBEU\\Desktop\\删除'))
  assert.equal(result, true)
  // 走 await 之后就不是用户手势了，iOS 会拒：必须是点击回调里同步那一份
  assert.equal(apiCalls, 0)
  assert.deepEqual(doc.calls.filter((c) => c[0] === 'execCommand'), [['execCommand', 'copy']])
}])

cases.push(['execCommand 失败 → 返回 false，调度方显示「复制失败」', async () => {
  const doc = fakeDocument(false)
  const result = await withDom({ navigator: {}, document: doc }, () => copyTextToClipboard('x'))
  assert.equal(result, false)
  assert.deepEqual(doc.calls.filter((c) => c[0] === 'remove'), [['remove']])
}])

cases.push(['空文本直接返回 false，不弹键盘也不写剪贴板', async () => {
  let touched = false
  const result = await withDom({
    navigator: { clipboard: { writeText: async () => { touched = true } } },
    document: { createElement: () => { touched = true } },
  }, () => copyTextToClipboard(''))
  assert.equal(result, false)
  assert.equal(touched, false)
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
