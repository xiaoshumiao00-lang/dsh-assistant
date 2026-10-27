/** 宿主 uiSession 的会话状态源：新版为 sessionStatus，旧版曾暴露 pendingInteractions。 */
export function sessionStatusSourceOf(owner: any): any | null {
  for (const source of [owner?.sessionStatus, owner?.pendingInteractions]) {
    if (source && typeof source.getSnapshot === 'function' && typeof source.subscribe === 'function') return source
  }
  return null
}

/**
 * 判断会话是否等待用户交互。
 * 新版 sessionStatus 为每个会话都保留一行，必须检查该行里的 pendingInteraction，
 * 不能用 Map.has()，否则空闲/运行中的会话也会被误判为等待提问。
 * 旧版 pendingInteractions 只登记待决会话，Map 中的非空值本身就是交互对象。
 */
export function hasPendingInteraction(map: ReadonlyMap<string, any> | null | undefined, sid: string | undefined): boolean {
  if (!sid || !map) return false
  try {
    const value = map.get(sid)
    if (value == null) return false
    if (typeof value === 'object' && 'pendingInteraction' in value) return value.pendingInteraction != null
    return true
  } catch {
    return false
  }
}

/** 待决会话集合签名：忽略 running 等高频但与本插件提醒无关的字段变化。 */
export function pendingInteractionSignature(map: ReadonlyMap<string, any> | null | undefined): string {
  if (!map) return ''
  const ids: string[] = []
  try {
    for (const sid of map.keys()) if (hasPendingInteraction(map, sid)) ids.push(sid)
  } catch { return '' }
  ids.sort()
  return ids.join('\u0000')
}
