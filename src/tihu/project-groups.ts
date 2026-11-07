/**
 * 主页屏项目聚合（纯函数，便于单测）。
 *
 * 控制室的项目卡在主客户端（ConsolePane）内存里，host lane 拿不到；
 * 这里用会话快照按 cwd 归并成「项目」兜底：
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
}

/** 把 cwd 归一到控制室的项目名（合并仓库子目录/已知项目目录）。 */
export function projectNameOf(cwd: string | undefined): string {
  const raw = String(cwd ?? '').replace(/[\\/]+$/, '')
  if (raw === '') return '其他'
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  const lower = parts.map((part) => part.toLowerCase())
  const find = (needle: string): number => lower.findIndex((part) => part.includes(needle))

  // 2026-11-07 用户要求：宿主工作区（默认会话都落在这里）叫「个人助手」，不再叫「控制室」。
  if (find('dsh_orb') >= 0 || find('profiles') >= 0 || (find('.dsh') >= 0 && find('assistant') >= 0)) return '个人助手'
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

/** 聚合项目并按「进行中 → 已完成 → 空闲、同级最近活动倒序」排序。 */
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
    const latest = group.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
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
      const title = humanTitle(latest?.title ?? '')
      if (title !== '未命名会话') summary = fitLine(toSpeechText(title), 240, 12)
    }
    items.push({ name, status, summary, updatedAt: latest?.updatedAt ?? 0 })
  }
  const rank: Record<ProjectStatus, number> = { running: 0, done: 1, idle: 2 }
  return items.sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}
