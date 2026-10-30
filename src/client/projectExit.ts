/**
 * 「当前会话是否已经离开这个项目」的纯判定（零依赖、可 node 单测）。
 *
 * 项目 × 对话联动：分栏工作区打开期间，用户切到**项目之外**的会话时自动收起项目，
 * 回到普通会话布局。判定口径按「项目 = 文件夹」：
 *   - 会话就是项目绑定会话 / 打开项目时切过去的那条（attached）→ 没离开；
 *   - 项目有文件夹 → 会话 cwd 在该文件夹（含模板步骤子目录）内 = 没离开；
 *   - 会话没有 cwd（刚建出来、列表行还没到）→ 视为已离开（助手会话就是这种时序）；
 *   - 内置控制室没有文件夹 → 退回「是否还是 attached」。
 *
 * 这样修掉了两个边界：模板项目里在各步会话之间跳转不会误关项目（它们都在项目文件夹下），
 * 而长按悬浮球打开的私人助手（cwd = ~/.dsh/assistant）会正常收起项目。
 */
import { normalizeFolderPath } from './sessionFolder.ts'

export interface ProjectExitQuery {
  /** 切换后的当前会话 id */
  sessionId: string
  /** 打开项目时切过去的那条会话（项目归属会话；取不到 = null） */
  attached: string | null
  /** 项目绑定会话（无绑定 = null） */
  bound?: string | null
  /** 项目文件夹（空 = 该项目没有文件夹，例如内置控制室） */
  folder?: string | null
  /** 该会话的工作目录（取不到 = 空串） */
  cwd?: string | null
  /** 当前打开的是内置控制室这一类「无文件夹」项目 */
  isConsole?: boolean
}

export function sessionLeavesProject(q: ProjectExitQuery): boolean {
  const sessionId = String(q.sessionId ?? '').trim()
  if (!sessionId) return false
  const attached = String(q.attached ?? '').trim()
  const bound = String(q.bound ?? '').trim()
  if (sessionId === attached || (bound && sessionId === bound)) return false
  if (q.isConsole === true) return true
  const base = normalizeFolderPath(q.folder ?? '')
  if (!base) return true
  const cwd = normalizeFolderPath(q.cwd ?? '')
  if (!cwd) return true
  const baseKey = base.toLowerCase()
  const key = cwd.toLowerCase()
  return key !== baseKey && !key.startsWith(baseKey + '/')
}
