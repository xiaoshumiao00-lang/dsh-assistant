// 手机代理的 opening follow 数值截窗：只改客户端本来就在发送的合法请求参数。
// 不碰 endpoint / streamId / address / 帧边界 / 下行事件；session.page 旧历史保持原样。

export const MOBILE_OPENING_HISTORY_MESSAGES = 20

export function capMobileSessionFollowMessage(input, limit = MOBILE_OPENING_HISTORY_MESSAGES) {
  if (typeof input !== 'string') return { text: input, changed: false }
  let message
  try { message = JSON.parse(input) } catch { return { text: input, changed: false } }
  if (message?.type !== 'open' || message?.endpoint !== 'session/follow') return { text: input, changed: false }
  const request = message?.payload?.args?.request
  if (request === null || typeof request !== 'object') return { text: input, changed: false }
  const max = Math.max(1, Math.floor(Number(limit) || MOBILE_OPENING_HISTORY_MESSAGES))
  let changed = false
  if (Number.isFinite(Number(request.maxMessages)) && Number(request.maxMessages) > max) {
    request.maxMessages = max
    changed = true
  }
  const turnWindow = request.turnWindow
  if (turnWindow && typeof turnWindow === 'object'
    && Number.isFinite(Number(turnWindow.minMessages)) && Number(turnWindow.minMessages) > max) {
    turnWindow.minMessages = max
    changed = true
  }
  return changed ? { text: JSON.stringify(message), changed: true } : { text: input, changed: false }
}
