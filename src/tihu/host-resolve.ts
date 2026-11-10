/**
 * 宿主会话恢复入口的返回值判读（2026-11-10 实机核对 app.asar 后单独抽出来的小工具）。
 *
 * 宿主服务 `sessionController`（`@deepseek-ai/dsh-api-session-controller`，
 * `super(ctx, 'sessionController', { namespace: 'session' })`）**公开的是
 * `resolveAgent(sessionId)`**：内部依次 liveAgent → `ctx.sessions.get` → 去重的 `resume()`，
 * 返回**活 Agent**（或 `{ agent }`）**或** `{ error: RemoteError }`（`session/not-found`、
 * `session/writer-held`、`session/agent-busy`、`gateway/internal`）。旧的 `resume` 是它的私有
 * 步骤，宿主没有公开它——所以 lane 曾经每次承接都判成「宿主没有 sessionController.resume」。
 *
 * 这三个判读函数单独成一个文件：这样它们可以直接进单测（不必整套宿主 ctx）。
 */

/** 可检索的失败描述：错误码＋原文（lane.log 就写这一句）。 */
export interface TihuResolveFailure {
  /** 宿主错误码（`session/not-found` … 没有就空串）。 */
  code: string
  /** 带错误码前缀的一句话（`session/writer-held：会话 …`）。 */
  message: string
}

/** 异常 message（换行压成空格；空 message 给个可检索的占位）。 */
function messageOf(error: unknown): string {
  const text = String((error as { message?: unknown })?.message ?? error ?? '').replace(/\s+/g, ' ').trim()
  return text === '' ? 'unknown error' : text
}

/** 错误码：宿主 RemoteError 的 `code`；没有就退回异常名。空串表示「没有码」。 */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && code.trim() !== '') return code.trim()
  const name = (error as { name?: unknown })?.name
  return typeof name === 'string' && name !== 'Error' ? name : ''
}

/**
 * 把宿主抛出的异常（或 `{ error: RemoteError }` 里的 error）翻译成失败描述。
 * @param prefix - 可选前缀，标明是哪一步抛的（`resolveAgent 抛错` / `resume 抛错`）。
 */
export function tihuRemoteFailureOf(error: unknown, prefix = ''): TihuResolveFailure {
  const code = codeOf(error)
  const message = messageOf(error)
  const text = code === '' ? message : `${code}：${message}`
  return { code, message: prefix === '' ? text : `${prefix} ${text}` }
}

/** 活 Agent 的最小认得出来的形状（Agent 实例 / `{ agent }` 包装都算）。 */
function looksLikeAgent(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return 'session' in record || 'followup' in record || 'status' in record || 'prompt' in record
}

/**
 * `resolveAgent` 的**返回值**判读：拿到 agent 就返回 undefined，否则给出失败描述。
 *
 * 认这三种形状：
 *   - `{ error: RemoteError }` → 失败（把错误码带进 message）；
 *   - `{ agent }` / 活 Agent → 成功（`agent` 是 undefined/null 也算失败）；
 *   - 直接抛出来的 RemoteError（包装层会这么做）→ 失败。
 */
export function tihuResolveAgentFailureOf(returned: unknown): TihuResolveFailure | undefined {
  if (returned === undefined || returned === null) {
    return { code: '', message: 'resolveAgent 没有返回会话 agent' }
  }
  if (typeof returned !== 'object') {
    return { code: '', message: `resolveAgent 返回的不是对象（${typeof returned}）` }
  }
  const record = returned as Record<string, unknown>
  if ('error' in record) {
    return tihuRemoteFailureOf(record.error, 'resolveAgent 失败')
  }
  if ('agent' in record) {
    const agent = record.agent
    if (agent === undefined || agent === null) return { code: 'session/not-live', message: 'resolveAgent 返回了 { agent }，但 agent 是空的' }
    return undefined
  }
  if (looksLikeAgent(returned)) return undefined
  // 不是 agent 形状：只有当它带 message（RemoteError/Error）时才判失败，否则交给调用方复核。
  if (typeof record.message === 'string') return tihuRemoteFailureOf(returned, 'resolveAgent 失败')
  return undefined
}

/** 失败描述 → Error（message 带错误码；`code` 挂在异常上，日志与屏都认它）。 */
export function tihuFailureError(failure: TihuResolveFailure, sessionId: string): Error {
  const error = new Error(`${failure.message}（会话 ${sessionId.slice(0, 12)}…）`)
  ;(error as Error & { code?: string }).code = failure.code
  return error
}
