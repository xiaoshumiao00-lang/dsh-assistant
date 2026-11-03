// 手机端性能计数（纯函数 + 一个可关的信标）。
//
// 为什么需要：控制室那一套「少扫一点 / 少开一条流」的改动，收益一直只有策略级数字
// （少做了多少次判定、少开几条 follow），没有真机毫秒。手机上又看不到 console，
// 所以这里把关键计数攒起来，每 60 s 一条 `perf` 信标走既有的 `/.dsh-pocket/diag`
// 通道落进 `diagnostic.jsonl` —— 宿主侧不需要任何改动（它本来就是一行一条 JSON 原样落盘）。
//
// 纪律：
//   - 只存数字、键集固定（调用点决定），上限 64 个键，绝不按会话 id 建键；
//   - 关掉开关（perfSetEnabled(false)）后连计数器都不碰，回退粒度到「一个开关」；
//   - 页面不可见时不发信标（省流量、也不在后台吵醒 WebView）；
//   - payload 里零值不写，整条信标 < 900 B，不挤占 1 MB / 1 MB 的诊断流水上限。

/** 计数器键上限：调用点是有限的，超过说明有人拿动态字符串当键了。 */
export const PERF_MAX_KEYS = 64
/** 信标事件名（宿主只按 ev 计数，不校验 schema）。 */
export const PERF_EVENT = 'perf'
/** 默认上报间隔。真机上 60 s 一条 ≈ 1.4 KB/小时，可忽略。 */
export const PERF_REPORT_MS = 60_000
/** payload 里最多带多少个数字字段（含 read() 追加的宿主侧计数）。 */
export const PERF_MAX_FIELDS = 24

/** 单调时钟（毫秒）：浏览器与 Node 都带 performance；拿不到就退化到 Date.now。 */
export function perfNowMs(): number {
  try {
    const perf = (globalThis as any).performance
    if (perf && typeof perf.now === 'function') return perf.now()
  } catch {
    /* 忽略 */
  }
  return Date.now()
}

let enabled = true
const counters = new Map<string, number>()
const observations = new Map<string, { n: number; sum: number; max: number }>()

function canAdd(key: string): boolean {
  if (counters.has(key) || observations.has(key)) return true
  return counters.size + observations.size < PERF_MAX_KEYS
}

/** 计数 +n（默认 1）。 */
export function perfBump(name: string, n = 1): void {
  if (!enabled) return
  const key = String(name)
  if (!canAdd(key)) return
  const add = Number(n)
  if (!Number.isFinite(add) || add === 0) return
  counters.set(key, (counters.get(key) ?? 0) + add)
}

/** 记录一次耗时（毫秒）：会同时给出次数 / 均值 / 最大值。 */
export function perfObserveMs(name: string, ms: number): void {
  if (!enabled) return
  const key = String(name)
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return
  if (!canAdd(key)) return
  const entry = observations.get(key) ?? { n: 0, sum: 0, max: 0 }
  entry.n += 1
  entry.sum += value
  if (value > entry.max) entry.max = value
  observations.set(key, entry)
}

/** 取一份快照（整数计数 + 耗时三件套，全部四舍五入到 0.1 ms）。 */
export function perfSnapshot(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of counters) out[key] = Math.round(value)
  for (const [key, entry] of observations) {
    out[`${key}N`] = entry.n
    out[`${key}Avg`] = Math.round((entry.sum / Math.max(1, entry.n)) * 10) / 10
    out[`${key}Max`] = Math.round(entry.max * 10) / 10
  }
  return out
}

/** 清空（测试用；运行时不调用）。 */
export function perfReset(): void {
  counters.clear()
  observations.clear()
}

/** 总开关：false = 完全不计数、也不发信标（回退粒度）。 */
export function perfSetEnabled(on: boolean): void {
  enabled = on === true
}

export function perfIsEnabled(): boolean {
  return enabled
}

/**
 * 整理成信标 payload：丢掉零值与非法值，最多 PERF_MAX_FIELDS 个字段，键按字典序保证稳定。
 * @param snapshot 计数字典
 * @param extras 额外字段（例如事实缓存命中数），后写覆盖同名键
 */
export function buildPerfPayload(
  snapshot: Record<string, number>,
  extras: Record<string, number> = {},
): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const source of [snapshot, extras]) {
    if (!source || typeof source !== 'object') continue
    for (const [key, raw] of Object.entries(source)) {
      const value = Number(raw)
      if (!Number.isFinite(value) || value === 0) continue
      merged[String(key).slice(0, 16)] = Math.round(value * 10) / 10
    }
  }
  const keys = Object.keys(merged).sort()
  const out: Record<string, number> = {}
  for (const key of keys.slice(0, PERF_MAX_FIELDS)) out[key] = merged[key]
  return out
}

/** 估算 payload 的 JSON 体积（用于回归里卡体积上限）。 */
export function perfPayloadBytes(payload: Record<string, number>): number {
  try {
    return JSON.stringify(payload).length
  } catch {
    return 0
  }
}

export interface PerfBeaconOptions {
  /** 读取当前计数（每次上报前调用，保证拿到最新值）。 */
  read: () => Record<string, number>
  /** 读取额外字段（宿主侧计数等）。 */
  extra?: () => Record<string, number>
  /** 发一条信标。 */
  post: (event: string, payload: Record<string, unknown>) => void
  /** 是否在后台（不可见时不发）。 */
  isHidden?: () => boolean
  intervalMs?: number
  /** 定时器注入（测试用）。 */
  setIntervalFn?: (fn: () => void, ms: number) => any
  clearIntervalFn?: (handle: any) => void
}

/**
 * 起一个周期上报。返回 stop()：清定时器、不再发。
 * 每次上报前重新读计数，所以不会把「上一次的快照」重复发出去。
 */
export function startPerfBeacon(options: PerfBeaconOptions): () => void {
  const intervalMs = Math.max(5_000, Number(options.intervalMs ?? PERF_REPORT_MS) || PERF_REPORT_MS)
  const setInt = options.setIntervalFn ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms))
  const clearInt = options.clearIntervalFn ?? ((handle: any) => globalThis.clearInterval(handle))
  const hidden = options.isHidden ?? (() => {
    try {
      return (globalThis as any).document?.hidden === true
    } catch {
      return false
    }
  })
  let stopped = false
  const tick = (): void => {
    if (stopped || !enabled) return
    if (hidden()) return
    let payload: Record<string, number>
    try {
      const extras = options.extra ? options.extra() : {}
      payload = buildPerfPayload(options.read(), extras)
    } catch {
      return
    }
    if (Object.keys(payload).length === 0) return
    if (perfPayloadBytes(payload) > 1200) return
    try {
      options.post(PERF_EVENT, { p: payload })
    } catch {
      /* 信标失败绝不影响页面 */
    }
  }
  const handle = setInt(tick, intervalMs)
  try {
    if (handle && typeof handle.unref === 'function') handle.unref()
  } catch {
    /* 浏览器里没有 unref */
  }
  return () => {
    stopped = true
    try {
      clearInt(handle)
    } catch {
      /* 忽略 */
    }
  }
}
