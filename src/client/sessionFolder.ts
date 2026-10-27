/**
 * 项目文件夹 → 会话归属判定（纯函数、零依赖、可 node 单测）。
 *
 * 控制室卡片的状态灯（绿=在跑 / 黄=等决策）、中间那块流式进度、运行时长，
 * 都按「该项目文件夹下的全部会话」算，而不是只看绑定会话——用户从「会话列表」
 * 进去跑任务时，绑定会话可能正闲着。
 *
 * 规则与卡片「会话列表」浮层保持同一口径：
 *   - 路径统一成正斜杠、去掉尾部斜杠再比；
 *   - Windows 大小写不敏感 → 比对键用小写（返回的仍是原始 id，不做路径改写）；
 *   - 子目录算同一项目（模板步骤目录 09-xxx 之类）；
 *   - 排除子代理会话（parentId / origin === 'subagent'）；
 *   - 排除没有 cwd 的会话（宿主没给目录 → 无法归属）。
 */

/** 规范化路径：去首尾空白、反斜杠→斜杠、去尾部斜杠 */
export function normalizeFolderPath(path: unknown): string {
  return String(path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 取某个目录（含子目录）下的会话 id。
 * @param ids - 候选会话 id（保持原顺序）
 * @param byId - 会话快照 byId 表（每项可含 cwd / parentId / origin）
 * @param base - 项目文件夹（任意分隔符；空 = 无法归属，返回空数组）
 * @returns 归属该目录的会话 id
 */
export function sessionsUnderFolder(ids: readonly string[], byId: Record<string, any> | null | undefined, base: string): string[] {
  const baseN = normalizeFolderPath(base)
  if (!baseN) return []
  const baseKey = baseN.toLowerCase()
  const out: string[] = []
  const table = byId ?? {}
  for (const sid of ids ?? []) {
    const e = table[sid]
    if (!e) continue
    if (e.parentId || e.origin === 'subagent') continue
    const cwd = normalizeFolderPath(e.cwd)
    if (!cwd) continue
    const key = cwd.toLowerCase()
    if (key !== baseKey && !key.startsWith(baseKey + '/')) continue
    out.push(sid)
  }
  return out
}

/**
 * 「游离会话」：不属于任何项目文件夹、也不是绑定会话 / 模板步骤会话的根会话。
 * 控制室临时卡片「正在运行」用它收纳「在别的目录里跑、任何项目卡片都看不到」的任务。
 *
 * 规则与卡片「会话列表」保持同一口径：
 *   - 排除子代理会话（parentId / origin === 'subagent'）与无 cwd 的会话；
 *   - 属于任一项目文件夹（含子目录）的不算游离；
 *   - owned 里的会话（各项目绑定会话 + 模板步骤会话）不算游离；
 *   - 已归档会话（archived）不算游离——归档语义就是「从列表移除」。
 *
 * @param ids - 候选会话 id（保持原顺序）
 * @param byId - 会话快照 byId 表
 * @param folders - 全部项目文件夹（任意分隔符；空项忽略）
 * @param owned - 已被项目占用的会话 id（绑定 / 模板步骤）
 * @param archived - 已归档会话 id
 * @returns 游离根会话 id（保持原顺序）
 */
export function unownedSessionIds(
  ids: readonly string[],
  byId: Record<string, any> | null | undefined,
  folders: readonly string[],
  owned: Iterable<string>,
  archived: Iterable<string> = [],
): string[] {
  const table = byId ?? {}
  const ownedSet = new Set(owned)
  const archivedSet = new Set(archived)
  const folderKeys: string[] = []
  for (const folder of folders ?? []) {
    const key = normalizeFolderPath(folder).toLowerCase()
    if (key) folderKeys.push(key)
  }
  const out: string[] = []
  for (const sid of ids ?? []) {
    const e = table[sid]
    if (!e) continue
    if (e.parentId || e.origin === 'subagent') continue
    if (ownedSet.has(sid) || archivedSet.has(sid)) continue
    const cwd = normalizeFolderPath(e.cwd)
    if (!cwd) continue
    const key = cwd.toLowerCase()
    let ownedByFolder = false
    for (const base of folderKeys) {
      if (key === base || key.startsWith(base + '/')) { ownedByFolder = true; break }
    }
    if (ownedByFolder) continue
    out.push(sid)
  }
  return out
}

/** 临时卡片「正在运行」的单条可见性输入。 */
export type TransientVisibilityInput = {
  /** 正在运行（含子代理在跑） */
  running: boolean
  /** 停在等用户决策 */
  awaiting: boolean
  /** 已完成 */
  done: boolean
  /** 异常终止 */
  error: boolean
  /** 空白会话（没有消息） */
  blank: boolean
  /** 宿主列表的 updatedAt = 最后一次提示词时间（不是结束时间！） */
  updatedAt: number
  /** 生命周期跟踪器观察到的「跑 → 停」时间（0 = 没观察到） */
  observedFinishedAt: number
  /** 用户「收工」时间（0 = 没点过） */
  dismissedAt: number
  /** 当前时间 */
  now: number
  /** 没有观察到「跑 → 停」时，完成会话用提示词时间兜底的窗口（只决定是否首次收纳，不是保留期） */
  doneFallbackMs: number
  /** 没有观察到「跑 → 停」时，异常会话用提示词时间兜底的窗口（只决定是否首次收纳，不是保留期） */
  errorFallbackMs: number
}

/** 临时卡片单条可见性结果。 */
export type TransientVisibility = {
  /** 是否进入卡片（运行 / 待决 / 已结束但还没收工） */
  show: boolean
  /** 是否已结束（运行/待决 = false） */
  finished: boolean
  /** 采用的结束时间（仅 finished 时有意义；0 = 无法判定，不展示） */
  finishedAt: number
}

/**
 * 临时卡片是否收纳某条游离会话（纯函数，可单测）。
 *
 * 结束时间不能用宿主 updatedAt：它只在新提示词时前进，长任务跑完后会被误判成「很久前结束」。
 * 优先用生命周期跟踪器记录的真实结束时间；宿主重启等没有记录时，只有本轮提示词仍在兜底窗口内
 * 才用提示时间作为结束时间（避免历史会话在首次打开时淹没卡片）。
 *
 * 结束后**不按时间过期**：已收纳的会话一直留在卡片上，直到用户手动「收工」（或同一会话开始新一轮）。
 */
export function transientVisibility(input: TransientVisibilityInput): TransientVisibility {
  if (input.running || input.awaiting) return { show: true, finished: false, finishedAt: 0 }
  if (input.blank) return { show: false, finished: true, finishedAt: 0 }
  const observed = input.observedFinishedAt > 0 && input.observedFinishedAt >= input.updatedAt
    ? input.observedFinishedAt
    : 0
  // 没有观察记录时的兜底窗口：完成看 30 分钟，异常看 12 小时（异常更重要，给足发现时间）
  const fallbackWindow = input.error ? input.errorFallbackMs : input.doneFallbackMs
  const fallback = input.updatedAt > 0 && input.now - input.updatedAt <= fallbackWindow
    ? input.updatedAt
    : 0
  const finishedAt = observed > 0 ? observed : fallback
  if (finishedAt <= 0) return { show: false, finished: true, finishedAt: 0 }
  if (input.dismissedAt > 0 && input.dismissedAt >= finishedAt) {
    return { show: false, finished: true, finishedAt }
  }
  // 结束（完成 / 异常）后一直保留，直到用户手动收工；不再按时间自动消失
  return { show: input.done || input.error, finished: true, finishedAt }
}
