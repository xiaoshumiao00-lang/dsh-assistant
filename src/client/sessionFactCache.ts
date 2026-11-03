// 会话「事实」跨卡片刷新缓存（多会话并发时的主 CPU 那一刀）。
//
// 为什么要它：控制室每次刷新（≥150 ms 一次）都要把「项目关联会话 + 全部游离会话」
// 重算一遍在跑/等决策/完成/异常，而这些判定要读会话面（sessions.binding(sid).session
// .getSnapshot()）。会话 1,000+ 时就是每刷一次卡片做上千次会话面读取——手机上几条会话
// 同时在跑，主线程就被这件事吃满，点哪儿都慢。
//
// 口径不变：
//   1. 缓存只存「同一组廉价输入签名」下的同一结论；任一输入变了就立刻重算（会话开始跑、
//      跑完、开了新一轮、出现异常、被确认、新起子代理都会变）。
//   2. 签名看不到的那类变化（只有会话面自己变了，宿主列表项没动）靠分层 TTL 兜底：
//      在跑/等决策的会话 800 ms 一取，最近一分钟内有活动的 6 s 一取，冷会话 45 s 一取。
//      也就是「热的勤取、冷的稀取」，而不是全部会话每刷一次就全扫一遍。
//   3. 判定本体（compute）由调用方注入，本模块只决定「要不要重算」，不做任何业务判断。

/** 正在跑 / 正在等决策 / 最近一分钟内活动过的会话：每 800 ms 允许重算一次。 */
export const FACT_TTL_HOT_MS = 800
/** 最近一分钟内有过活动：算热档。 */
export const FACT_HOT_WINDOW_MS = 60_000
/** 热档之外、这一档以内：6 s 重算一次。 */
export const FACT_TTL_WARM_MS = 6000
/** 会话面/提示时间多久以内算「热」。 */
export const FACT_WARM_WINDOW_MS = 600_000
/** 冷会话（最后一次活动超出 10 分钟）：45 s。 */
export const FACT_TTL_COLD_MS = 45_000
/** 缓存条数上限：超了整表丢弃（缓存只是加速器，不能无限长）。 */
export const FACT_CACHE_MAX_ENTRIES = 4096

export type SessionFactInputs = {
  /** 宿主列表项的「本轮提示时间」 */
  updatedAt: number
  /** 宿主 running 位 */
  running: boolean
  /** 宿主 completed 位 */
  completed: boolean
  /** 空白会话（一条消息都没有） */
  blank: boolean
  /** 宿主列表项自带 pendingInteraction */
  entryPending: boolean
  /** 插件自己的待决表命中 */
  awaitingDecision: boolean
  /** 本地已记录的「异常终止」标记 */
  errorMark: boolean
  /** 子代理数量（新起子代理 = 判定输入变了） */
  kidsCount: number
  /** 子代理里正在跑的条数 */
  kidsRunning: number
  /** 子代理里等决策的条数 */
  kidsAwaiting: number
}

/**
 * 判定输入签名：只读宿主列表项与本地表的廉价字段（不读会话面）。
 * 任一字段变了，这条会话的「在跑 / 等决策 / 完成 / 异常」就必须重算。
 * @param {SessionFactInputs} inputs
 * @returns {string}
 */
export function sessionFactSignatureOf(inputs: SessionFactInputs): string {
  const flag = (v: unknown): string => (v === true ? '1' : '0')
  return [
    Number(inputs.updatedAt) || 0,
    flag(inputs.running),
    flag(inputs.completed),
    flag(inputs.blank),
    flag(inputs.entryPending),
    flag(inputs.awaitingDecision),
    flag(inputs.errorMark),
    Number(inputs.kidsCount) || 0,
    Number(inputs.kidsRunning) || 0,
    Number(inputs.kidsAwaiting) || 0,
  ].join(':')
}

/**
 * 这条会话该用哪一档节奏。热的（正在跑 / 正在等决策 / 刚活动过）取得勤，冷会话取得稀。
 * @param {{running?: boolean, awaiting?: boolean, kidsRunning?: number, updatedAt?: number, observedFinishedAt?: number, now: number}} ctx
 * @returns {{tier: 'hot'|'warm'|'cold', ttlMs: number}}
 */
export function factTierOf(ctx: {
  running?: boolean
  awaiting?: boolean
  kidsRunning?: number
  updatedAt?: number
  observedFinishedAt?: number
  now: number
}): { tier: 'hot' | 'warm' | 'cold'; ttlMs: number } {
  const updatedAt = Number(ctx.updatedAt) || 0
  const finishedAt = Number(ctx.observedFinishedAt) || 0
  const freshest = Math.max(updatedAt, finishedAt)
  const active = ctx.running === true || ctx.awaiting === true || Number(ctx.kidsRunning) > 0
  if (active || freshest > ctx.now - FACT_HOT_WINDOW_MS) return { tier: 'hot', ttlMs: FACT_TTL_HOT_MS }
  if (freshest > ctx.now - FACT_WARM_WINDOW_MS) return { tier: 'warm', ttlMs: FACT_TTL_WARM_MS }
  return { tier: 'cold', ttlMs: FACT_TTL_COLD_MS }
}

export type SessionFactRecord<T> = { signature: string; at: number; ttlMs: number; value: T }

/**
 * 创建一个「会话事实」缓存存储。
 * @param {object} [options]
 * @param {() => number} [options.now] - 时钟（测试注入）
 */
export function createSessionFactStore(options: { now?: () => number } = {}) {
  const now = options.now ?? ((): number => Date.now())
  const store = new Map<string, SessionFactRecord<any>>()
  let hits = 0
  let recomputed = 0
  return {
    /** 命中且没过期就复用结论，否则跑一次 compute（判定本体在调用方）。 */
    read<T>(sid: string, signature: string, tier: { ttlMs: number }, compute: () => T): T {
      const clock = now()
      const hit = store.get(sid)
      if (hit && hit.signature === signature && clock - hit.at < hit.ttlMs) {
        hits += 1
        return hit.value as T
      }
      recomputed += 1
      const value = compute()
      if (store.size >= FACT_CACHE_MAX_ENTRIES) store.clear()
      store.set(sid, { signature, at: clock, ttlMs: Math.max(0, Number(tier.ttlMs) || 0), value })
      return value
    },
    /** 丢掉某条会话的缓存（本地确认了异常/ack 之类外部变化时用）。 */
    drop(sid: string): void {
      store.delete(sid)
    },
    /**
     * 「这条判定说它在跑」→ 把它的重算节奏提到热档。
     * 会话面兜底（宿主列表项没动、但轮次还开着）也能跟得上，不会退化成冷档的 45 s。
     */
    promote(sid: string, ttlMs: number): void {
      const hit = store.get(sid)
      if (!hit) return
      const next = Math.max(0, Number(ttlMs) || 0)
      if (hit.ttlMs !== next) { hit.ttlMs = next; hit.at = now() }
    },
    stats: (): { size: number; hits: number; recomputed: number } => ({ size: store.size, hits, recomputed }),
  }
}
