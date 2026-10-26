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
