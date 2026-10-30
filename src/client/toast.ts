/**
 * 小提示（右下角浮层）：助手自己看不见的东西，至少让用户看得见（P0-6 建卡失败提示用得上）。
 * 纯 DOM，不依赖宿主样式；多条消息往上叠。
 */
const ZINDEX = 2147483001
const MAX_LINES = 4

export function showToast(text: string, ms = 5200): void {
  if (typeof document === 'undefined' || !document.body) return
  let wrap = document.getElementById('dsh-assistant-toast')
  if (!wrap) {
    wrap = document.createElement('div')
    wrap.id = 'dsh-assistant-toast'
    wrap.setAttribute('data-dsh-assistant-toast', '1')
    Object.assign(wrap.style, {
      position: 'fixed', right: '14px', bottom: '14px', zIndex: String(ZINDEX),
      display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: 'min(92vw, 420px)',
      pointerEvents: 'none',
    } as Record<string, string>)
    document.body.appendChild(wrap)
  }
  const line = document.createElement('div')
  Object.assign(line.style, {
    background: 'var(--dsw-alias-bg-layer-1, rgba(24,26,30,.94))',
    color: 'var(--dsw-alias-label-primary, #fff)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14))',
    borderRadius: '10px', padding: '8px 11px', fontSize: '12.5px', lineHeight: '1.5',
    whiteSpace: 'pre-wrap', boxShadow: '0 8px 24px rgba(0,0,0,.22)',
  } as Record<string, string>)
  line.textContent = text
  wrap.appendChild(line)
  const kill = (): void => { try { line.remove() } catch { /* 已经不在了 */ } }
  const timer = setTimeout(kill, ms)
  line.onclick = () => { clearTimeout(timer); kill() }
  const children = Array.from(wrap.children)
  if (children.length > MAX_LINES) {
    for (const old of children.slice(0, children.length - MAX_LINES)) { try { old.remove() } catch { /* 同上 */ } }
  }
}
