/** 手机模型设置错误提示：首扫整页，之后只处理实际新增/改变的文本根。 */
const PHRASES = ['加载提供方目录失败', 'Settings are unavailable in this browser']
const NOTICE = '手机上不支持模型设置，请去电脑端修改设置'

export function createModelSettingsNoticePatcher() {
  // 只遍历文本节点，不读每个元素的 textContent（长会话下会复制整棵子树文本）。
  const patchText = (node: Text): void => {
    const value = node.nodeValue ?? ''
    if (value === '' || !PHRASES.some((p) => value.includes(p))) return
    const el = node.parentElement
    if (el === null || el.dataset?.dshpModelNotice === '1') return
    if (el.closest('[data-dshp-model-notice]') !== null) return
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
  return {
    patchAll(): void {
      if (document.hidden) return
      patchTree(document.body)
    },
    /** 收集 mutation；返回是否有待处理节点（纯删除无需调度）。 */
    collect(mutations: readonly MutationRecord[]): boolean {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') pending.add(mutation.target)
        else if (mutation.type === 'childList') mutation.addedNodes.forEach((node) => pending.add(node))
      }
      return pending.size > 0
    },
    flush(): void {
      // 隐藏时保留队列；恢复可见后仍能处理，不丢已到达的设置错误。
      if (document.hidden) return
      const batch = [...pending]
      pending.clear()
      for (const node of batch) {
        if (node.isConnected === false) continue
        patchTree(node)
      }
    },
  }
}
