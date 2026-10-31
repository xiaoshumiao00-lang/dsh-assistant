// 客户端 localStorage 读缓存（同一份内容只 JSON.parse 一次）。
//
// 为什么需要：控制室每刷一次卡片就要读三份持久化状态（异常终止标记 / 提醒 ack / 临时卡片收工记录）。
// 这些读本来就在 1.2 秒一轮的活动扫描里被反复触发，每一发都是一次同步 localStorage 读 + JSON.parse；
// 手机上一旦会话多了，parse 就挤在用户正在打字 / 滚动的那段主线程里 —— 典型的「每隔一会儿卡一下」。
//
// 语义保持：缓存只认「原始字符串完全一样」才复用；拿到手的结果一律是克隆（调用方原地改动
// 不会污染缓存，也不会像原来那样被下一次读看到），写盘后缓存立即跟着新内容。

const cache = new Map<string, { raw: string; value: any }>()

/** 浅克隆一层（含 Map / Set）：让调用方的原地改动只影响这一次。 */
export function cloneCached(value: any): any {
  if (value instanceof Map) return new Map(value)
  if (value instanceof Set) return new Set(value)
  if (Array.isArray(value)) return value.slice()
  if (value !== null && typeof value === 'object') return { ...value }
  return value
}

/**
 * 读一份持久化 JSON：内容没变就直接复用上次 parse 出来的结果（克隆版）。
 * @param key - localStorage 键。
 * @param revive - 只有缓存没命中时才调用：把原始字符串变成调用方要的形状（返回 null / 非法一律按空对象处理由调用方决定）。
 */
export function cachedJsonRead<T = any>(key: string, revive: (raw: string | null) => T): T {
  let raw: string | null = null
  try {
    raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    raw = null
  }
  const cached = cache.get(key)
  if (cached !== undefined && cached.raw === raw && raw !== null) return cloneCached(cached.value) as T
  let value: T
  try {
    value = revive(raw)
  } catch {
    value = ({} as T)
  }
  // 读不到（raw === null）不缓存：下一次读仍然是 null，也不该白留一份空对象
  if (raw !== null) cache.set(key, { raw, value })
  else cache.delete(key)
  return cloneCached(value) as T
}

/** 写盘并同步缓存（写完立刻读也省得多 parse 一次）。 */
export function cachedJsonWrite(key: string, value: any): void {
  let raw: string | null = null
  try {
    raw = JSON.stringify(value)
  } catch {
    cache.delete(key)
    return
  }
  cache.set(key, { raw, value })
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, raw)
  } catch {
    /* 写失败（配额 / 隐私模式）：缓存仍与新内容一致 */
  }
}

/** 显式作废（外部改过这份键、或测试重置时用）。 */
export function invalidateCached(key: string): void {
  cache.delete(key)
}

/** 测试与自检用：当前缓存了哪些键。 */
export function cachedKeys(): string[] {
  return [...cache.keys()]
}
