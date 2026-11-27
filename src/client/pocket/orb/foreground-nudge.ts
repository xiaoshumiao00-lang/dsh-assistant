/**
 * 前台即重连（2026-11-27「切后台秒恢复」需求）。
 *
 * 背景：手机切到微信再回来时，DSH 连接层（@deepseek-ai/dsh-client-connection）的
 * WebSocket 可能已经在后台死掉，它的自愈是指数退避重连（base 500ms ×2，封顶 10s）
 * ——运气不好正好睡到长退避上，用户就要盯着「重新连接」白等几秒。
 *
 * 这里做的只有一件事：**页面重新可见的那一刻**，如果连接不在 connected 态，立刻
 * 调 `connection.reconnect()`（连接层自带的手动重连：退避计数清零、马上重试），
 * 并按 NUDGE_RETRY_MS 阶梯补几刀（连接层自己在长退避里睡着时，把它拍醒）。
 * 连接还活着（connected）时什么都不做——秒恢复靠的就是「连接根本没断」
 * （原生前台服务保活 + 代理 30s 协议层 ping），这里只是断线后的加速器。
 *
 * 判态只读 `connection.state.getSnapshot()`（connected/connecting/disconnected），
 * 不碰连接层内部；所有调用都有 try/catch，旧宿主缺 state/reconnect 时静默空转。
 *
 * 同时把连接状态读数挂到 `window.__dshAssistantConnState`：安卓外壳 onResume 的
 * 页面探活（MainActivity.probePageAlive）读它判断「页面还活着」。
 */

/** DSH 连接层插件面（只声明用到的两个口子，与 dsh-client-connection 的 handle 对齐）。 */
export interface ConnectionLike {
  state?: { getSnapshot?: () => unknown }
  reconnect?: () => void
}

/** 可见期间的补刀阶梯（毫秒）：立即一次之后，仍没连上按 2s→4s→8s→15s→30s 再拍几次。 */
export const NUDGE_RETRY_MS = [2000, 4000, 8000, 15000, 30000] as const

/** 读连接状态：'connected' | 'connecting' | 'disconnected' | 'unknown'（缺服务/异常都归 unknown）。 */
export function connectionStateOf(conn: ConnectionLike | null | undefined): string {
  try {
    const s = conn?.state?.getSnapshot?.()
    return typeof s === 'string' && s !== '' ? s : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 要不要拍醒连接层：不是 connected 就拍（connecting/disconnected/unknown）。
 * reconnect() 对没在跑的连接层是空操作（owner 未挂时静默返回），乱拍无害。
 */
export function shouldNudge(state: string): boolean {
  return state !== 'connected'
}

interface TimerLike {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

/**
 * 安装「可见即重连」。返回卸载函数（页面插件一般不卸，测试用）。
 * doc/win 可注入假对象单测；缺 document（node）时直接不装。
 */
export function installForegroundNudge(
  ctx: { connection?: ConnectionLike } | null | undefined,
  doc: Document | undefined = (globalThis as { document?: Document }).document,
  win: TimerLike | undefined = globalThis as unknown as TimerLike,
): () => void {
  if (doc === undefined || win === undefined) return () => {}
  const conn = ctx?.connection

  // 原生探活读取口（MainActivity.probePageAlive）：页面活着就一定能答出状态
  try {
    ;(globalThis as Record<string, unknown>).__dshAssistantConnState = () => connectionStateOf(conn)
  } catch { /* 只读全局就算了，探活会走 'unknown' 分支 */ }

  let timers: unknown[] = []
  const clearAll = (): void => {
    for (const id of timers) { try { win.clearTimeout(id) } catch { /* ignore */ } }
    timers = []
  }

  const nudge = (): void => {
    if (doc.hidden) return
    if (!shouldNudge(connectionStateOf(conn))) return
    try { conn?.reconnect?.() } catch { /* 旧宿主没有 reconnect：静默 */ }
  }

  const runLadder = (): void => {
    clearAll()
    nudge() // 可见的瞬间先拍一次（立即重试，不等任何退避）
    for (const ms of NUDGE_RETRY_MS) {
      timers.push(win.setTimeout(() => {
        if (!doc.hidden) nudge()
      }, ms))
    }
  }

  const onVisibility = (): void => {
    if (doc.hidden) clearAll()
    else runLadder()
  }
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearAll()
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
