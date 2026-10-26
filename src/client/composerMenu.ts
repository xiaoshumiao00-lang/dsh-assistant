/** 会话输入框「＋」命令菜单：再次点击加号收起。
 *
 *  宿主原始流程里，第二次点加号会先因输入框聚焦触发一次关闭/重排，随后 click 又把它打开。
 *  这里在 document 捕获阶段识别「菜单已开时按下同一个加号」：先用一次外部 pointerdown
 *  走宿主自己的 dismiss 路径，再吞掉紧随其后的 click，避免它重新打开。
 */

const PLUS_SELECTOR = '[data-composer-card] button[aria-haspopup="listbox"]'
const MENU_SELECTOR = '[data-trigger-menu]'

/** 走宿主的「点击外部关闭」逻辑，不依赖其内部 controller。 */
function dismissThroughOutsideTap(): void {
  const event = typeof PointerEvent === 'function'
    ? new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' })
    : new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
}

export function installComposerMenuToggle(): () => void {
  /** 本次按下已请求收起：记录加号节点，click 到同一节点时只吞事件。 */
  let suppressPlus: Element | null = null
  let suppressUntil = 0

  const onPointerDown = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const plus = target.closest(PLUS_SELECTOR)
    if (!(plus instanceof Element)) return
    if (plus.getAttribute('aria-expanded') !== 'true') return
    const card = plus.closest('[data-composer-card]')
    if (!(card instanceof Element) || card.querySelector(MENU_SELECTOR) === null) return
    suppressPlus = plus
    suppressUntil = performance.now() + 1000
    dismissThroughOutsideTap()
  }

  const onClick = (event: MouseEvent): void => {
    const plus = suppressPlus
    if (plus === null || performance.now() > suppressUntil) {
      suppressPlus = null
      return
    }
    const target = event.target
    if (!(target instanceof Node) || !plus.contains(target)) return
    suppressPlus = null
    suppressUntil = 0
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClick, true)
    suppressPlus = null
  }
}
