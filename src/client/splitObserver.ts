/** 仅在本分栏工作区存活期间观察外来 .ta_split 浮层；关闭后立即释放 body 子树观察器。 */
export function observeExternalSplit(onExternalSplit: () => void): () => void {
  if (typeof document === 'undefined' || !document.body || typeof MutationObserver === 'undefined') return () => {}
  let active = true
  const check = (): void => {
    if (active && document.querySelector('.ta_split')) onExternalSplit()
  }
  const observer = new MutationObserver(check)
  observer.observe(document.body, { childList: true, subtree: true })
  // open() 的同步 claim/外部回调可能已插入浮层；按 MutationObserver 同款微任务时序补现态检查。
  queueMicrotask(check)
  return () => {
    if (!active) return
    active = false
    observer.disconnect()
  }
}
