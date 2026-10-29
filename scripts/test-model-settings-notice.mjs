/** 手机模型设置提示：首扫 + 增量 mutation 的行为与扫描范围回归。 */
import assert from 'node:assert/strict'
import { createModelSettingsNoticePatcher } from '../src/client/pocket/mobile/modelSettingsNotice.ts'

const NOTICE = '手机上不支持模型设置，请去电脑端修改设置'
const walkerRoots = []
let visited = 0

function text(value, parentElement = null) {
  return { nodeType: 3, nodeValue: value, parentElement, isConnected: true }
}
function element(children = []) {
  const el = {
    nodeType: 1,
    dataset: {},
    children: [],
    parentElement: null,
    isConnected: true,
    closest(selector) {
      if (selector !== '[data-dshp-model-notice]') return null
      if (el.dataset.dshpModelNotice === '1') return el
      return el.parentElement?.closest(selector) ?? null
    },
    set textContent(value) {
      el.children = [text(String(value), el)]
    },
    get textContent() {
      return el.children.map((child) => child.nodeValue ?? child.textContent ?? '').join('')
    },
  }
  for (const child of children) {
    child.parentElement = el
    el.children.push(child)
  }
  return el
}
function textDescendants(root, out = []) {
  for (const child of root.children ?? []) {
    if (child.nodeType === 3) out.push(child)
    else textDescendants(child, out)
  }
  return out
}

const initialError = element([text('加载提供方目录失败')])
const streamRows = Array.from({ length: 20000 }, () => text('普通流式内容'))
const body = element([initialError, ...streamRows])
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 }
globalThis.NodeFilter = { SHOW_TEXT: 4 }
globalThis.document = {
  hidden: false,
  body,
  createTreeWalker(root) {
    walkerRoots.push(root)
    const nodes = textDescendants(root)
    let index = 0
    return {
      nextNode() {
        const node = nodes[index++] ?? null
        if (node) visited += 1
        return node
      },
    }
  },
}

const patcher = createModelSettingsNoticePatcher()
patcher.patchAll()
assert.equal(initialError.dataset.dshpModelNotice, '1')
assert.equal(initialError.children[0].nodeValue, NOTICE)
assert.equal(walkerRoots[0], body)
assert.equal(visited, 20001, '首屏保留一次完整文本扫描')

// 普通流式 characterData：只检查目标文本，不再每批遍历整篇 2 万节点。
walkerRoots.length = 0
visited = 0
const mutations = streamRows.slice(0, 100).map((target) => ({ type: 'characterData', target }))
assert.equal(patcher.collect(mutations), true)
patcher.flush()
assert.equal(visited, 0)
assert.equal(walkerRoots.length, 0)
assert.equal(body.children.length, 20001)

// 后到的嵌套设置错误仍必须替换，且只遍历新增子树。
const nested = element([element([text('Settings are unavailable in this browser')])])
assert.equal(patcher.collect([{ type: 'childList', addedNodes: [nested] }]), true)
patcher.flush()
const nestedError = nested.children[0]
assert.equal(nestedError.dataset.dshpModelNotice, '1')
assert.equal(nestedError.children[0].nodeValue, NOTICE)
assert.equal(walkerRoots.at(-1), nested)
assert.equal(visited, 1)

// 原 textNode 被改写也能命中；纯删除无需调度，已脱离 DOM 的新增节点不再扫。
const changed = element([text('普通内容')])
const changedText = changed.children[0]
changedText.nodeValue = '加载提供方目录失败'
patcher.collect([{ type: 'characterData', target: changedText }])
patcher.flush()
assert.equal(changed.dataset.dshpModelNotice, '1')
assert.equal(changed.children[0].nodeValue, NOTICE)
assert.equal(patcher.collect([{ type: 'childList', addedNodes: [] }]), false)
const detached = element([text('加载提供方目录失败')])
detached.isConnected = false
const rootsBefore = walkerRoots.length
patcher.collect([{ type: 'childList', addedNodes: [detached] }])
patcher.flush()
assert.equal(walkerRoots.length, rootsBefore)
assert.equal(detached.dataset.dshpModelNotice, undefined)

// hidden 时 flush 不得丢队列；恢复可见且没有新 mutation 也要补上提示。
const hiddenTarget = element([text('加载提供方目录失败')])
globalThis.document.hidden = true
patcher.collect([{ type: 'childList', addedNodes: [hiddenTarget] }])
patcher.flush()
assert.equal(hiddenTarget.dataset.dshpModelNotice, undefined)
globalThis.document.hidden = false
patcher.flush()
assert.equal(hiddenTarget.dataset.dshpModelNotice, '1')
assert.equal(hiddenTarget.children[0].nodeValue, NOTICE)

delete globalThis.document
delete globalThis.Node
delete globalThis.NodeFilter
console.log('model-settings-notice: first scan + nested/characterData/detached + 20k-node incremental guard OK')
