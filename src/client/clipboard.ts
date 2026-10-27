/**
 * 复制文本到剪贴板（浏览器端通用）：
 *   - 安全上下文（https / localhost / Electron 自定义协议）：直接走异步 Clipboard API；
 *   - 非安全上下文（手机经隧道或局域网以 http 访问 DSH 时就是这种）：跳过 Clipboard API，
 *     用临时 textarea + document.execCommand('copy')。这一步必须在点击回调里同步执行，
 *     挪到 await 之后系统会认定不是用户手势而拒绝（iOS 尤其严格）；
 *     并且要显式 setSelectionRange(0, len)，否则 iOS 只复制第一行。
 * 返回是否复制成功，调用方据此给「已复制 / 复制失败」反馈。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = String(text ?? '')
  if (value === '') return false
  const win = typeof window === 'undefined' ? undefined : window
  // 没有 window（node 单测）按安全上下文处理；浏览器里以真实 isSecureContext 为准
  const secure = win === undefined || win.isSecureContext !== false
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (secure && clip !== undefined && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(value)
      return true
    } catch { /* 权限被拒：走兜底 */ }
  }
  try {
    if (typeof document === 'undefined') return false
    const el = document.createElement('textarea')
    el.value = value
    el.setAttribute('readonly', '') // 只读：不弹键盘，且不触发页面滚动
    el.setAttribute('aria-hidden', 'true')
    el.style.position = 'fixed'
    el.style.top = '0'
    el.style.left = '0'
    el.style.width = '1px'
    el.style.height = '1px'
    el.style.padding = '0'
    el.style.border = '0'
    el.style.opacity = '0'
    el.style.pointerEvents = 'none'
    // iOS 只在字号 ≥16px 时不自动放大页面：兜底复制不能顺带把界面缩放一下
    el.style.fontSize = '16px'
    document.body.appendChild(el)
    el.focus()
    el.select()
    el.setSelectionRange(0, value.length)
    const ok = document.execCommand('copy')
    el.remove()
    return ok
  } catch {
    return false
  }
}
