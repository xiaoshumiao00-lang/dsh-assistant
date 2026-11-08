/**
 * 主页屏项目聚合（纯函数，便于单测）。
 *
 * 首页项目的**真源**是宿主 workspace 服务（groupWorkspaceProjects：项目清单与命名都来自
 * workspaceRegistry）。「只跑过会话、从没在控制室建过项目」的目录不会再变成幽灵项目。
 * 拿不到宿主服务时（命令行测试环境/服务未注入）才退回会话快照按 cwd 归并（groupProjects）：
 *   - 一个项目 = 一组 cwd 归一到同一项目名的会话；
 *   - 状态：任一会话 live 且 2 分钟内有活动 → running；
 *           最近 10 分钟内有 assistant 回复 → done；
 *           否则 idle；
 *   - 摘要：该项目最近一条 assistant 回复的首句；没有就「等待新消息」（绝不显示裸 id）。
 */
import { splitReplySentences } from './reply.ts'
import { fitLine } from './screen-spec.ts'
import { toSpeechText } from './speech-text.ts'

export type ProjectStatus = 'running' | 'done' | 'idle'

export interface ProjectSessionRow {
  sessionId: string
  title?: string
  cwd?: string
  updatedAt: number
  live: boolean
}

export interface ProjectReply {
  text: string
  at: number
}

/** 去掉标题里的裸 id/哈希/uuid；剥完为空给「未命名会话」。 */
export function humanTitle(value: unknown): string {
  const raw = String(value ?? '')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b[0-9a-f]{8,32}\b/gi, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return raw === '' ? '未命名会话' : raw
}

export interface ProjectItem {
  name: string
  status: ProjectStatus
  summary: string
  updatedAt: number
  /** 点该项目进入的默认会话（组内最近更新的一条）。 */
  enterSessionId?: string
}

/** 宿主 workspace 服务（workspaceRegistry.list()）的一条项目：实体字段都是 getter。 */
export interface TihuWorkspaceRow {
  id: string
  path: string
  title: string
  sessionIds: string[]
  /** workspace.updatedAt 解析出的毫秒数（ISO 字符串；解析不出来给 0，排在最旧）。 */
  updatedAt: number
}

/** 把 cwd 归一到控制室的项目名（合并仓库子目录/已知项目目录）。 */
export function projectNameOf(cwd: string | undefined): string {
  const raw = String(cwd ?? '').replace(/[\\/]+$/, '')
  if (raw === '') return '其他'
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  const lower = parts.map((part) => part.toLowerCase())
  const find = (needle: string): number => lower.findIndex((part) => part.includes(needle))

  // 2026-11-07 用户要求：宿主工作区（默认会话都落在这里）叫「个人助手」，不再叫「控制室」。
  // 这条别名与 workspace 真源命名共用同一个函数（hostWorkspaceAliasOf）。
  const hostAlias = hostWorkspaceAliasOf(cwd)
  if (hostAlias !== undefined) return hostAlias
  if (find('青年') >= 0 || find('基金') >= 0 || find('2027') >= 0) return '青年基金申请书'
  if (find('磷石膏') >= 0) return '磷石膏SCI'
  if (find('dsh-assistant') >= 0 || find('dsh-pocket') >= 0 || find('dsh-tuoguan') >= 0 || find('dsh desktop') >= 0) return 'dsh-assistant'
  if (find('strata') >= 0 || find('llm') >= 0) return 'STRATA'
  if (find('陈潘hbeu') >= 0) return ''
  // 2026-11-07 用户要求：电脑端控制室新建的项目/文件夹也要在鹈鹕首页出现，
  // 未知 cwd 用最后一级目录名兜底（临时目录这类杂项仍然不单独立项）。
  const last = parts[parts.length - 1] ?? ''
  if (/^(temp|tmp|outputs|node_modules|临时|删除)$/i.test(last)) return ''
  return last
}

/**
 * 宿主工作区（~/.dsh/assistant、profiles、dsh_orb）的固定别名。
 * 这是 workspace 真源命名唯一要保留的既有别名（其余项目一律照控制室的标题）。
 */
export function hostWorkspaceAliasOf(cwd: string | undefined): string | undefined {
  const parts = String(cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase())
  if (parts.length === 0) return undefined
  const find = (needle: string): number => parts.findIndex((part) => part.includes(needle))
  if (find('dsh_orb') >= 0 || find('profiles') >= 0 || (find('.dsh') >= 0 && find('assistant') >= 0)) return '个人助手'
  return undefined
}

/** 一条「聚合项」的公共算法：状态三态 + 摘要（最近回复首句 → 会话名 → 占位）。 */
function projectItemOf(
  name: string,
  group: readonly ProjectSessionRow[],
  replies: Record<string, ProjectReply | undefined>,
  now: number,
  updatedAt: number,
): ProjectItem {
  const running = group.some((row) => row.live && now - row.updatedAt < 2 * 60_000)
  let latestReply: ProjectReply | undefined
  for (const row of group) {
    const reply = replies[row.sessionId]
    if (reply !== undefined && (latestReply === undefined || reply.at > latestReply.at)) latestReply = reply
  }
  const done = !running && latestReply !== undefined && now - latestReply.at < 10 * 60_000
  const status: ProjectStatus = running ? 'running' : done ? 'done' : 'idle'
  let summary = '等待新消息'
  if (latestReply !== undefined) {
    const sentences = splitReplySentences(toSpeechText(latestReply.text))
    const first = sentences[0]?.text ?? toSpeechText(latestReply.text)
    summary = fitLine(first, 240, 12) || '等待新消息'
  } else {
    const latest = latestRow(group)
    const title = humanTitle(latest?.title ?? '')
    if (title !== '未命名会话') summary = fitLine(toSpeechText(title), 240, 12)
  }
  return { name, status, summary, updatedAt, enterSessionId: latestRow(group)?.sessionId }
}

function latestRow(group: readonly ProjectSessionRow[]): ProjectSessionRow | undefined {
  let latest: ProjectSessionRow | undefined
  for (const row of group) if (latest === undefined || row.updatedAt > latest.updatedAt) latest = row
  return latest
}

/** 聚合项目并按「进行中 → 已完成 → 空闲、同级最近活动倒序」排序（cwd 兜底路径专用）。 */
export function groupProjects(
  rows: readonly ProjectSessionRow[],
  replies: Record<string, ProjectReply | undefined> = {},
  now: number = Date.now(),
): ProjectItem[] {
  const groups = new Map<string, ProjectSessionRow[]>()
  for (const row of rows) {
    const name = projectNameOf(row.cwd)
    if (name === '') continue
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name)!.push(row)
  }
  const items: ProjectItem[] = []
  for (const [name, group] of groups) {
    items.push(projectItemOf(name, group, replies, now, latestRow(group)?.updatedAt ?? 0))
  }
  const rank: Record<ProjectStatus, number> = { running: 0, done: 1, idle: 2 }
  return items.sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

/**
 * 首页项目的**真源**：DSH 宿主 workspace 服务（`ctx.get('workspaceRegistry').list()`）。
 * 实体字段是 getter：id / path / title / createdAt / updatedAt / sessionIds（数组顺序即显示顺序）。
 *
 * 与 cwd 分组的差别：
 *   - 项目清单来自注册表（「只跑过会话、从没建过项目」的目录不会再变成幽灵项目，
 *     控制室里有会话的老项目也不会再被漏掉）；
 *   - 名字取 workspace.title（只保留宿主工作区「个人助手」这条既有别名，不做 cwd 兜底命名）；
 *   - 排序按 workspace.updatedAt 倒序（新的在前），**不**按 running→done→idle 排；
 *   - 状态/摘要按该项目 sessionIds 对应的会话算（按 id 查表，不用 cwd 前缀猜归属）。
 */
export function groupWorkspaceProjects(
  workspaces: readonly TihuWorkspaceRow[],
  rows: readonly ProjectSessionRow[],
  replies: Record<string, ProjectReply | undefined> = {},
  now: number = Date.now(),
): ProjectItem[] {
  const rowsById = new Map<string, ProjectSessionRow>()
  for (const row of rows) if (!rowsById.has(row.sessionId)) rowsById.set(row.sessionId, row)
  const items: ProjectItem[] = []
  const seen = new Set<string>()
  for (const workspace of workspaces) {
    const dedupeKey = workspace.id !== '' ? workspace.id : `${workspace.path} ${workspace.title}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    const name = workspaceProjectNameOf(workspace)
    if (name === '') continue
    const group: ProjectSessionRow[] = []
    for (const sessionId of workspace.sessionIds) {
      const row = rowsById.get(sessionId)
      if (row !== undefined) group.push(row)
    }
    items.push(projectItemOf(name, group, replies, now, workspace.updatedAt))
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

/** 项目名：workspace.title（宿主工作区仍叫「个人助手」）；标题空给「未命名项目」。 */
function workspaceProjectNameOf(workspace: TihuWorkspaceRow): string {
  const alias = hostWorkspaceAliasOf(workspace.path)
  if (alias !== undefined) return alias
  const title = String(workspace.title ?? '').replace(/\s+/g, ' ').trim()
  return title === '' ? '未命名项目' : title
}
