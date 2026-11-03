// 控制室「活动扫描」的取样策略（P0-2/P0-3 的纯函数部分，便于回归）。
//
// 背景（2026-11-02 诊断）：1.2 s 一轮的扫描每轮最多开 6 条 follow 流（每条都是
// 一次 mux 上的开场快照），任务运行时这 6 条会和流式帧抢同一条下行链路——手机
// 上就是「点一下要等」。这里只做三件事，语义不变：
//   1. 同一条会话按状态分级取样：在跑的 1.5 s 一次、空闲的 20 s 一次；
//   2. 每轮最多取 MAX_TAILS_PER_ROUND 条，刚跑完（settle）的优先；
//   3. 刚取过就跳过（entry.at），不再每轮重开同一条流。

/** 正在运行的会话：每 2.5 s 允许取一次（卡片上的进度行本来就比帧率粗）。 */
export const RUNNING_TAIL_TTL_MS = 2500
/** 空闲会话：20 s 一次就够（卡片上的「最近进度」不会因此变得不可用）。 */
export const IDLE_TAIL_TTL_MS = 20_000
/** 一轮最多开几条 follow 流：从 6 降到 2，避免同一批里 6 条开场快照一起压下行链路。 */
export const MAX_TAILS_PER_ROUND = 2

/**
 * 这条会话现在该不该取一次尾快照。
 * @param {{at?: number, key?: string}} entry - 上次取到的缓存条目（含取样时刻 at）
 * @param {{running: boolean, key: string, now: number}} ctx - 当前状态与时钟
 * @returns {boolean}
 */
export function shouldFetchTail(entry, ctx) {
  if (!entry) return true
  if (entry.key !== ctx.key) return true
  if (entry.running !== ctx.running) return true
  const at = Number(entry.at) || 0
  const ttl = ctx.running ? RUNNING_TAIL_TTL_MS : IDLE_TAIL_TTL_MS
  return ctx.now - at >= ttl
}

/**
 * 从候选里挑这一轮真正要取的：刚跑完（settle）的先看，其余按「多久没被取样」轮转。
 *
 * 多会话并发时的那一刀：一轮只取 max 条（默认 2）。原来排完 settle 就按候选表插入
 * 顺序取前几名，于是同一批会话每轮都抢同样的名额——其余在跑的会话永远排不到，
 * 卡片进度不更新，同时那几条被反复重开的 follow 流把下行链路一直占着（手机端
 * 「有任务在跑就哪都慢」正是这条链叠出来的）。
 * 现在把「最久没被取样」的排在前面（从没取过的 at = 0 因此最先补上），
 * 判定口径一点没变：还是 settle 优先、还是按节奏取样、还是至多 max 条。
 *
 * @param {Array<{sid: string, settle?: boolean, at?: number}>} candidates
 * @param {{max?: number}} [opts]
 * @returns {Array<{sid: string, settle?: boolean, at?: number}>}
 */
export function pickTailBatch(candidates, opts = {}) {
  const max = Math.max(1, Number(opts.max) || MAX_TAILS_PER_ROUND)
  const ranked = (candidates ?? []).slice().sort((a, b) => {
    const settle = Number(Boolean(b?.settle)) - Number(Boolean(a?.settle))
    if (settle !== 0) return settle
    const aAge = Number(a?.at) || 0
    const bAge = Number(b?.at) || 0
    if (aAge !== bAge) return aAge - bAge
    // 同一档按 sid 定序（同一批候选每轮排法一致，测试与观感都不依赖 Set 的不确定顺序）
    return String(a?.sid ?? '') < String(b?.sid ?? '') ? -1 : 1
  })
  return ranked.slice(0, max)
}
