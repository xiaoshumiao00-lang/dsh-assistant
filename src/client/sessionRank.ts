/**
 * 会话「活跃度」排序：控制室卡片的「会话列表」浮层与「点卡片进入哪条会话」共用同一套判定。
 * 纯函数（不读宿主状态）——调用方负责把 awaiting / running / error 算准，所以能离线单测。
 */

/** 活跃度档：等待决策(0) > 正在跑(1) > 异常终止(2) > 其余（刚结束 / 空闲）(3) > 已归档(4) */
export const SESSION_TIERS = { need: 0, running: 1, error: 2, idle: 3, archived: 4 } as const
export type SessionTier = (typeof SESSION_TIERS)[keyof typeof SESSION_TIERS]

/** 排序 / 挑选共用的一行会话（字段口径与宿主会话条目一致） */
export type RankableSessionRow = {
  id: string
  /** 宿主列表的 updatedAt = 最后一次提示词时间（不是结束时间） */
  updatedAt: number
  /** 等你回答（pendingInteraction / 会话面 pending / 子代理待决） */
  awaiting?: boolean
  /** 此刻在跑（宿主 running 位 / 未结束的轮次） */
  running?: boolean
  /** 异常终止（卡片红点口径） */
  error?: boolean
  /** 已置顶 */
  pinned?: boolean
  /** 已归档 */
  archived?: boolean
  /** 相对项目根目录的子目录名（同档时的稳定兜底） */
  rel?: string
}

/** 该会话落在哪一档（待决与在跑同时为真是常态：原生 UI 以黄点优先，镜像必须一致） */
export function sessionTierOf(row: { awaiting?: boolean; running?: boolean; error?: boolean; archived?: boolean }): SessionTier {
  if (row.archived) return SESSION_TIERS.archived
  if (row.awaiting) return SESSION_TIERS.need
  if (row.running) return SESSION_TIERS.running
  if (row.error) return SESSION_TIERS.error
  return SESSION_TIERS.idle
}

/**
 * 统一排序：置顶 → 活跃度档 → 最近更新倒序 → 相对目录 → id。
 * `pinnedFirst:false` 时不抬置顶（进「正在跑」的会话不该被置顶抢先）。
 */
export function sortSessionsByActivity<T extends RankableSessionRow>(rows: T[], options: { pinnedFirst?: boolean } = {}): T[] {
  const pinnedFirst = options.pinnedFirst !== false
  const list = rows.slice()
  list.sort((a, b) => {
    if (pinnedFirst && !!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    const tier = sessionTierOf(a) - sessionTierOf(b)
    if (tier) return tier
    const at = (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
    if (at) return at
    const relA = a.rel ?? ''
    const relB = b.rel ?? ''
    if (relA !== relB) return relA < relB ? -1 : 1
    return String(a.id).localeCompare(String(b.id))
  })
  return list
}

/**
 * 点项目卡片时应进入的「进行中」会话：待决策 > 正在跑（同档内取最近更新最新的那条）。
 * 当前会话本身就在这一档里时保持它——否则点卡片会把用户正在看的会话踢走。
 * 没有进行中的会话时返回 null（调用方回退到「最新步骤 / 最近更新」判定）。
 */
export function pickActiveSession<T extends RankableSessionRow>(rows: T[], currentId?: string | null): T | null {
  const active = (tier: SessionTier): T[] => rows.filter((r) => sessionTierOf(r) === tier) as T[]
  for (const tier of [SESSION_TIERS.need, SESSION_TIERS.running] as SessionTier[]) {
    const pool = active(tier)
    if (pool.length === 0) continue
    const current = currentId ? pool.find((r) => r.id === currentId) : null
    if (current) return current
    return sortSessionsByActivity(pool, { pinnedFirst: false })[0] ?? null
  }
  return null
}
