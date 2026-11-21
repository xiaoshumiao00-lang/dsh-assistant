/**
 * 客户端「宿主会话桥」共享引用（插件内部用，纯模块，无 react）。
 *
 * 为什么需要它：控制室（src/client/index.tsx）在 apply 时把宿主的
 * `{ sessions, list, uiWorkspace, workspaces, conversation }` 存进模块作用域的 `sessionBridge`，
 * 那一份是**能真正切页**的（`window.__dshOpenSession` 实测有效）。
 * 而插件在别处（悬浮球、个人秘书入口）拿到的 ctx 是「声明式注入门禁」代理：
 * `ctx.uiWorkspace` / `ctx.get('uiWorkspace')` 在部分宿主版本上拿不到可用实例，
 * 于是 `openSession()` 静默失败——这正是 2026-11-21 真页面实测「第一次长按没切过去、
 * 第二次才切」的根因（第二次能成只因为那条会话已经被别的动作顶进了会话列表）。
 *
 * 所以：所有「切到某条会话」的动作统一走这里取到的桥，取不到才退回 ctx。
 */

export interface SessionBridgeLike {
  sessions?: any
  list?: any
  uiWorkspace?: any
  workspaces?: any
  conversation?: any
}

let bridgeGetter: (() => SessionBridgeLike | null | undefined) | null = null

/** 安装桥读取器（控制室 apply 时调用一次；传入 getter 以跟随后续重新赋值）。 */
export function setSessionBridge(getter: () => SessionBridgeLike | null | undefined): void {
  bridgeGetter = getter
}

/** 取宿主会话桥（拿不到返回 null）。 */
export function sessionBridgeRef(): SessionBridgeLike | null {
  try {
    return bridgeGetter?.() ?? null
  } catch {
    return null
  }
}

/** 是否已安装桥（诊断/测试用）。 */
export function hasSessionBridge(): boolean {
  return sessionBridgeRef() !== null
}

/**
 * 切到某条会话（与点侧栏会话行完全同一条路径）。
 * @param sessionId - 目标会话 id。
 * @returns 是否真的调到了宿主的 openSession。
 */
function safeOpen(uiWorkspace: any, sessionId: string): boolean {
  if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') return false
  try {
    uiWorkspace.openSession(sessionId)
    return true
  } catch {
    return false
  }
}

/** 用桥切页；没有桥或宿主拒绝时返回 false（调用方再退回其它路径）。 */
export function openSessionViaBridge(sessionId: string): boolean {
  const bridge = sessionBridgeRef()
  if (bridge === null) return false
  return safeOpen(bridge.uiWorkspace, sessionId)
}

/** 桥里的当前会话 id（读不到返回空串）。 */
export function currentSessionViaBridge(): string {
  const bridge = sessionBridgeRef()
  try {
    return String(bridge?.uiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '')
  } catch {
    return ''
  }
}

/** 桥里的 sessions 服务（focusSession 需要它来 retain / refresh）。 */
export function sessionsViaBridge(): { sessions: any; list: any; uiWorkspace: any } {
  const bridge = sessionBridgeRef()
  return { sessions: bridge?.sessions, list: bridge?.list, uiWorkspace: bridge?.uiWorkspace }
}
