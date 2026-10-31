/** 手机模型设置错误提示：首扫整页，之后只处理实际新增/改变的文本根。 */
import { domGate, insideComposer } from '../../compositionGate.ts'

const PHRASES = ['加载提供方目录失败', 'Settings are unavailable in this browser']
const NOTICE = '手机上不支持模型设置，请去电脑端修改设置'
/** 让路窗口结束后再来一次（补丁队列不会丢）。 */
const PATCHER_RETRY_MS = 400
/** 队列上限：流式渲染期间只留最新节点，绝不无界增长。 */
const PATCHER_QUEUE_CAP = 800

export function createModelSettingsNoticePatcher() {
  // 只遍历文本节点，不读每个元素的 textContent（长会话下会复制整棵子树文本）。
  const patchText = (node: Text): void => {
    const value = node.nodeValue ?? ''
    if (value === '' || !PHRASES.some((p) => value.includes(p))) return
    const el = node.parentElement
    if (el === null || el.dataset?.dshpModelNotice === '1') return
    if (el.closest('[data-dshp-model-notice]') !== null) return
    // 输入框里的文本不碰：改写宿主 Lexical 编辑器里的文本节点会让正在进行的
    // 语音 / 拼音组合当场中断。
    if (insideComposer(el)) return
    el.textContent = NOTICE
    el.dataset.dshpModelNotice = '1'
  }
  const patchTree = (root: Node): void => {
    if (root.nodeType === Node.TEXT_NODE) {
      patchText(root as Text)
      return
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null) {
      patchText(node as Text)
      node = walker.nextNode()
    }
  }
  const pending = new Set<Node>()
  const flush = (): void => {
    // 隐藏时保留队列；恢复可见后仍能处理，不丢已到达的设置错误。
    if (document.hidden) return
    // 用户正在输入框里打字（含语音实时转写）：队列留着，等窗口结束再处理，绝不丢批次。
    if (domGate.isPaused()) {
      if (pending.size > 0) window.setTimeout(flush, PATCHER_RETRY_MS)
      return
    }
    const batch = [...pending]
    pending.clear()
    for (const node of batch) {
      if (node.isConnected === false) continue
      patchTree(node)
    }
  }
  return {
    patchAll(): void {
      if (document.hidden) return
      patchTree(document.body)
    },
    /** 收集 mutation；返回是否有待处理节点（纯删除无需调度）。 */
    collect(mutations: readonly MutationRecord[]): boolean {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          // 输入框里每个字都在换文本节点：那些节点我们【从不补丁】，连队列都不进。
          const target = mutation.target
          if (insideComposer(target)) continue
          pending.add(target)
        } else if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (insideComposer(node)) return
            pending.add(node)
          })
        }
        // 队列上限：长会话流式渲染期间只留最新 800 个节点，绝不无界增长。
        if (pending.size > PATCHER_QUEUE_CAP) {
          const oldest = [...pending].slice(0, pending.size - PATCHER_QUEUE_CAP)
          for (const node of oldest) pending.delete(node)
        }
      }
      return pending.size > 0
    },
    flush,
  }
}
