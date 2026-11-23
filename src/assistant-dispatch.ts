/**
 * 个人秘书「派活分层」——A/B/C 三层，由秘书模型理解后决定（2026-11-21 用户新规则）。
 *
 * 分层（提示词与工具共用同一套文案，避免两处漂移）：
 *   A. 纯知识性、无需动手的随口问题 / 闲聊 → 秘书页直接回答，**不建任何会话**。
 *   B. 需要看屏幕、操作应用、读写本机文件、保存下载或动手的任务，且已有对应项目文件夹
 *      → 在该项目文件夹下**续接最近的 Computer Use 会话**（没有 CU 会话时才新建）。
 *   C. 同类任务但没有对应项目文件夹 → 在「新项目父目录」下建专项文件夹，并新开 CU 会话。
 *      任务不再以「复杂专项」为派活门槛；裁图、翻译、润色、整理文件也不能塞进 A 直接收工。
 *   只读联网查询（web_search / web_fetch）属于 A 的延伸：天气、新闻这类轻量事实由秘书直接查，
 *   不为了「上网」本身派活；联网后要登录、下载、保存、点页面才算动手。
 *
 * 硬约束：
 *   - 派活目标**只许 computer-use 模式**（新建走 sessionController.create({cwd, agentPreset})
 *     并核对回执/投影的预设，对不上就报错，绝不把活派进标准会话）；
 *   - 标准会话一般由 CU 会话后台 code_agent 派发，秘书不管理标准会话、不给它们建卡片；
 *   - 项目文件夹与控制室项目卡片**同一份数据源**：宿主持久化的
 *     `dsh-assistant-state.json`（projects.folders + nameOverrides + layouts，就是控制室
 *     跨端同步的那份注册表，见 src/assistant-store.ts）∪ 会话 cwd 归并，不另造目录体系。
 *
 * 工具闸：`secretary_dispatch` 只在固定秘书会话里可用；其它会话调用一律拒绝。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assistantHomeDir } from './assistant-home'
import { resolveNewProjectParent } from './assistant-config'
import { secretarySessionRef } from './assistant-secretary'
import {
  decideDispatchTarget,
  projectsFromSessions,
  type DispatchProject,
  type SessionRowLike,
} from './client/secretary-dispatch'

export const SECRETARY_DISPATCH_TOOL = 'secretary_dispatch'
export const CU_AGENT_PRESET = 'computer-use'

/** A/B/C 分层规则原文（提示词与工具描述共用）。 */
export const DISPATCH_RULES = [
  'A. 只有纯知识、无需动手的随口问题（例如「今天几号」「解释一个概念」），以及用只读联网工具 web_search / web_fetch 一查就能答的轻量事实（天气、气温、新闻、汇率、路线时间等），才直接在秘书会话里回答，不调用本工具、不建会话。只读限制只限制写文件、跑终端、直接操作屏幕和派子代理；联网搜索/抓取是只读查询，允许秘书自己做。翻译、润色、裁图、整理文件仍然不是 A。',
  'B. 凡需要看屏幕、看当前页面、操作应用、读写本机文件、保存/下载/整理文件，或需要动手执行（跑命令、改文件、点应用）的任务，若与下面某个既有项目相关或是旧任务延续 → kind 填 existing，cwd 填那个项目的目录（原样照抄清单里的路径）；宿主续接该项目最近的 Computer Use 会话，没有才新建。',
  'C. 凡需要看屏幕、操作应用、读写本机文件、保存/下载或动手，但与任何既有项目都不相关 → kind 填 new-folder、cwd 留空；宿主新建专项文件夹 + Computer Use 模式会话。任务简单也照派，不许因「只是问一句」留在秘书页。',
].join('\n')

/** 工具描述（模型看到的就是这段）。 */
const DISPATCH_DESCRIPTION = [
  '把需要外部动手能力的任务派给一条 Computer Use 模式会话（不是标准会话、不是子代理）。需要看屏幕、操作应用、读写本机文件、保存/下载/整理文件时必须调用本工具；纯知识随口问题和只读联网一查就能答的轻量事实（如「明天天气」）不要调用，直接用 web_search / web_fetch 回答。',
  '禁止用「我看不到」「没有截图能力」「无法直接确认」「我做不了」直接终答或收工。遇到自己做不到的事，第一步必须先调用本工具；成功后照实回报回执文案：只有「已派活（…已确认在跑）」才是那条会话真接上了话，「已入队（未确认在跑）」就是只投进了队列、宿主还没给出证据——不许把未确认说成已派活；回执出现「续接失败已改新建」就是那条会话这一轮失败了（错误原文在 reason 里），照实说是派活失败并改用了新建会话。',
  '已有项目文件夹时 kind=existing 并填绝对路径 cwd（B）；没有对应项目时 kind=new-folder 且 cwd 留空（C）。不要再用 assistant 类型。',
  '宿主只建/续 Computer Use 模式会话。标准会话由 CU 会话在后台自行派发，不归你管，也不要给它们建卡片。',
  '选目录按这三层规则：',
  DISPATCH_RULES,
  '判断「延续旧任务」时参考系统提示里给出的既有项目目录与最近会话标题。',
  '只有确实无法判断目录时才省略 cwd：宿主会按同一套「纯知识直接答，其余 B/C」规则兜底。',
].join('\n')

/** 候选项目缓存：系统提示词每轮都要用，不能每轮打一次持久化列表。 */
const PROJECTS_TTL_MS = 30_000
const projectCache = { at: 0, rows: [] as SessionRowLike[] }
let projectsInflight: Promise<SessionRowLike[]> | null = null

function toMs(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n < 1e12) return n * 1000
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

/** 会话行（含 CU 判定与续接需要的字段）。 */
export interface CuSessionRow extends SessionRowLike {
  sessionId?: string
  agentPreset?: string
  origin?: string
  delegationDepth?: number
  /**
   * 会话钉住的模型选择（宿主 modelSelection 投影：next ?? lastUsed）。
   * undefined = 读不到（不参与可用性过滤，不许猜）；null = 读到了但这条会话没有记录模型。
   */
  model?: { provider: string; model: string } | null
}

/** 读一条会话投影里的 modelSelection（live = 用 sessionProjections，冷行 = 用 sessionProjectionCache）。 */
function modelSelectionFromBlock(block: any): { provider: string; model: string } | null | undefined {
  const view = block?.values?.modelSelection
  const selection = view?.next ?? view?.lastUsed
  if (view === undefined || view === null) return undefined
  if (selection === null || selection === undefined) return null
  if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
    return { provider: selection.provider, model: selection.model }
  }
  return null
}

/**
 * 会话钉的模型（provider/model）。读不到就 undefined——调用方据此「不猜、不拿它当排除依据」。
 * 宿主服务名字与 src/assistant-cu-watch.ts 的 agentPreset 读取同一套（sessionProjections /
 * sessionProjectionCache），零 I/O 的缓存视图，不读会话日志。
 */
export function modelSelectionOf(ctx: any, source: any, live = false): { provider: string; model: string } | null | undefined {
  if (source === undefined || source === null) return undefined
  if (live) {
    try {
      const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
      if (projections && typeof projections.cachedSnapshot === 'function') {
        const value = modelSelectionFromBlock(projections.cachedSnapshot(source, ['modelSelection']))
        if (value !== undefined) return value
      }
    } catch { /* 投影没就绪：继续试持久缓存 */ }
  }
  try {
    const cache = typeof ctx?.get === 'function' ? ctx.get('sessionProjectionCache') : undefined
    if (cache && typeof cache.cachedSnapshot === 'function') {
      return modelSelectionFromBlock(cache.cachedSnapshot(source?.header ?? source, ['modelSelection']))
    }
  } catch { /* 读不到就是 undefined */ }
  return undefined
}

/**
 * 读出全部会话行（cwd / title / updatedAt / sessionId / agentPreset / 血缘 / 钉住的模型）。
 * 优先 sessionQuery（持久化全集，重启后也在），退而用内存里的活会话。
 */
export async function listSessionRows(ctx: any): Promise<CuSessionRow[]> {
  const rows: CuSessionRow[] = []
  try {
    const query = ctx?.get?.('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      const list = await query.listSessions(undefined)
      for (const record of Array.isArray(list) ? list : []) {
        const header = record?.header ?? {}
        rows.push({
          sessionId: String(header.id ?? record?.sessionId ?? ''),
          cwd: String(header.cwd ?? ''),
          title: String(header.title ?? ''),
          updatedAt: toMs(header.updatedAt ?? header.createdAt),
          agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
          origin: typeof header.origin === 'string' ? header.origin : '',
          delegationDepth: Number(header.delegationDepth) || 0,
          model: modelSelectionOf(ctx, header ?? record),
        })
      }
    }
  } catch { /* 没有 sessionQuery：走内存那条 */ }
  try {
    const live = ctx?.sessions?.list?.() ?? []
    for (const session of Array.isArray(live) ? live : []) {
      const header = session?.header ?? {}
      rows.push({
        sessionId: String(header.id ?? session?.id ?? ''),
        cwd: String(header.cwd ?? ''),
        title: String(header.title ?? ''),
        updatedAt: toMs(header.updatedAt),
        agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
        origin: typeof session?.header?.origin === 'string' ? session.header.origin : '',
        delegationDepth: Number(header.delegationDepth) || 0,
        model: modelSelectionOf(ctx, session, true) ?? modelSelectionOf(ctx, header),
      })
    }
  } catch { /* 宿主没有 sessions.list：只剩 sessionQuery 的结果 */ }
  return rows.filter((row) => String(row.cwd ?? '').trim() !== '')
}

/** 候选项目（带 30s 缓存；失败返回上一次的结果）。 */
export async function candidateProjects(ctx: any, force = false): Promise<DispatchProject[]> {
  const now = Date.now()
  if (!force && projectCache.at !== 0 && now - projectCache.at < PROJECTS_TTL_MS) {
    return buildProjects(projectCache.rows)
  }
  if (projectsInflight === null) {
    projectsInflight = listSessionRows(ctx)
      .then((rows) => {
        projectCache.at = Date.now()
        projectCache.rows = rows
        return rows
      })
      .catch(() => projectCache.rows)
      .finally(() => { projectsInflight = null })
  }
  const rows = await projectsInflight
  return buildProjects(rows)
}

function buildProjects(rows: SessionRowLike[]): DispatchProject[] {
  return buildProjectsFromRegistry(readConsoleRegistry(), rows)
}

function buildProjectsFromRegistry(registry: ConsoleProjectEntry[], rows: SessionRowLike[]): DispatchProject[] {
  const home = safeAssistantHome()
  return mergeConsoleProjects(registry, projectsFromSessions(rows, home ? [home] : []))
}

/* ---------- 秘书提示词组装路径的项目快照（1775 全景段 与 1790 派活段同源） ---------- */

/**
 * 快照窗口：同一次提示词组装里相邻求值的两个段（order 1775 → 1790）落在窗口内，
 * 拿到的是同一数组引用——同源不是「两次读取恰好一致」，而是物理上同一份数据。
 * 窗口只用于合并同组装的多次求值；跨组装（>100ms）必然重算，绝不让旧组装的数据混进新组装。
 */
const PROMPT_SNAPSHOT_WINDOW_MS = 100
let promptSnapshot: { projects: DispatchProject[]; at: number } | null = null

/**
 * 秘书提示词组装路径的项目取数（2026-11-22 用户定案：每轮注入控制室项目清单实时快照）。
 * 口径 = parseConsoleProjects(includeHidden) ∪ projectsFromSessions，removed 排除、隐藏标注。
 * 注册表是 readFileSync 同步重读（一份小 JSON，毫秒级）——控制室新建/删除文件夹后秘书
 * 下一轮立即可见，天然绕过 projectCache 的 30s TTL（那个缓存只罩会话行，不罩注册表）。
 * 会话行提供最近使用排序/会话标题/无卡片的散会话目录：同步渲染用「缓存行 ∪ 内存活会话行」
 * （sessions.list 是同步内存调用，冷启动也不缺最近用的目录），同时 force 刷新
 * （candidateProjects(ctx, true)）在后台把持久化会话行收紧——选 force 而不选缓存监听的理由：
 * 注册表由控制室跨端同步写盘，没有可靠的变更通知钩子，同步重读是最简单且绝对实时的方案；
 * inflight 去重保证同刻并发只读一次，成本 = 读一份注册表 JSON + 枚举一次会话行，全本地毫秒级。
 */
export function promptProjectSnapshot(ctx: any): DispatchProject[] {
  const now = Date.now()
  if (promptSnapshot !== null && now - promptSnapshot.at < PROMPT_SNAPSHOT_WINDOW_MS) {
    return promptSnapshot.projects
  }
  const rows = [...projectCache.rows, ...liveSessionRows(ctx)]
  const projects = buildProjectsFromRegistry(readConsoleRegistryAll(), rows)
  promptSnapshot = { projects, at: now }
  void candidateProjects(ctx, true)
  return projects
}

/** 内存活会话行（同步；listSessionRows 的内存那一半，供提示词快照同步并集用）。 */
function liveSessionRows(ctx: any): SessionRowLike[] {
  try {
    const live = ctx?.sessions?.list?.() ?? []
    const rows: SessionRowLike[] = []
    for (const session of Array.isArray(live) ? live : []) {
      const header = session?.header ?? {}
      rows.push({
        sessionId: String(header.id ?? session?.id ?? ''),
        cwd: String(header.cwd ?? ''),
        title: String(header.title ?? ''),
        updatedAt: toMs(header.updatedAt),
      })
    }
    return rows.filter((row) => String(row.cwd ?? '').trim() !== '')
  } catch { return [] }
}

/** 测试用：清掉提示词快照（不动 30s 会话行缓存——专门用来构造「缓存未过期」场景）。 */
export function resetPromptSnapshotForTests(): void {
  promptSnapshot = null
}

/* ---------- 控制室项目卡片数据源（同一份注册表，不另造目录体系） ---------- */

export interface ConsoleProjectEntry {
  dir: string
  name: string
  /** 控制室项目卡被标为隐藏（全景清单段保留并标注；默认口径仍排除）。 */
  hidden?: boolean
}

/**
 * 读控制室项目注册表：`dsh-assistant-state.json` 就是 `/api/assistant/state` 跨端同步的那份
 * （src/assistant-store.ts），projects.folders = 项目卡 id → 文件夹，nameOverrides / layouts
 * 提供卡片显示名，removed 的卡片永远排除；hidden 默认排除，includeHidden 时保留并标 hidden。
 */
export function parseConsoleProjects(raw: any, options: { includeHidden?: boolean } = {}): ConsoleProjectEntry[] {
  const projects = raw?.projects ?? raw?.state?.projects ?? null
  if (projects === null || typeof projects !== 'object') return []
  const folders = projects.folders && typeof projects.folders === 'object' ? projects.folders : {}
  const removed = new Set(Array.isArray(projects.removed) ? projects.removed : [])
  const hidden = new Set(Array.isArray(projects.hidden) ? projects.hidden : [])
  const names = projects.nameOverrides && typeof projects.nameOverrides === 'object' ? projects.nameOverrides : {}
  const layouts = Array.isArray(projects.layouts) ? projects.layouts : []
  const out: ConsoleProjectEntry[] = []
  for (const [pid, dir] of Object.entries(folders)) {
    if (removed.has(pid)) continue
    const isHidden = hidden.has(pid)
    if (isHidden && options.includeHidden !== true) continue
    const cwd = String(dir ?? '').trim()
    if (cwd === '') continue
    const layout = layouts.find((l: any) => l?.id === pid)
    const name = String(names[pid] ?? layout?.title ?? '').trim()
    out.push({ dir: cwd, name, hidden: isHidden || undefined })
  }
  return out
}

/** 全景口径读注册表：hidden 保留（标「隐藏」），removed 照旧排除。秘书提示词路径专用。 */
function readConsoleRegistryAll(): ConsoleProjectEntry[] {
  try {
    const file = join(registryDir || dispatchProfileDir(), 'dsh-assistant-state.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return parseConsoleProjects(raw, { includeHidden: true })
  } catch {
    return []
  }
}

function readConsoleRegistry(): ConsoleProjectEntry[] {
  try {
    const file = join(registryDir || dispatchProfileDir(), 'dsh-assistant-state.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return parseConsoleProjects(raw)
  } catch {
    return []
  }
}

function dispatchProfileDir(): string {
  // registerAssistantDispatch 已把真 profile 目录记进 registryDir；这里只是未注册时的兜底。
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop')
}

/** ctx 感知版（register 时把真 profile 目录记下来，避免硬编码）。 */
let registryDir = ''
export function setDispatchRegistryDir(dir: string): void {
  registryDir = String(dir ?? '')
}

/** 注册表项目 ∪ 会话归并项目：注册表条目给显示名，同目录覆盖名字；hidden 标记随注册表条目带入。 */
export function mergeConsoleProjects(registry: ConsoleProjectEntry[], sessionProjects: DispatchProject[]): DispatchProject[] {
  const norm = (dir: string): string => String(dir ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const byDir = new Map<string, DispatchProject>()
  for (const project of sessionProjects) byDir.set(norm(project.dir), project)
  for (const entry of registry) {
    const key = norm(entry.dir)
    if (key === '') continue
    const existing = byDir.get(key)
    if (existing !== undefined) {
      if (entry.name !== '') existing.name = entry.name
      continue
    }
    byDir.set(key, { dir: entry.dir, name: entry.name !== '' ? entry.name : undefined, lastUsedAt: 0, titles: [], hidden: entry.hidden })
  }
  return [...byDir.values()].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
}

function safeAssistantHome(): string {
  try {
    return String(assistantHomeDir() ?? '')
  } catch {
    return ''
  }
}

function safeNewFolderParent(): string {
  try {
    return String(resolveNewProjectParent().parent ?? '')
  } catch {
    return ''
  }
}

/** 测试用：清掉项目缓存。 */
export function resetDispatchCacheForTests(): void {
  projectCache.at = 0
  projectCache.rows = []
  projectsInflight = null
}

/** 模型给的目录可用吗（必须绝对路径）。 */
export function isUsableTargetDir(cwd: string): boolean {
  const dir = String(cwd ?? '').trim()
  if (dir === '') return false
  if (/^[A-Za-z]:[\\/]/.test(dir)) return true
  if (dir.startsWith('\\\\')) return true
  return dir.startsWith('/')
}

export type DispatchKindArg = 'existing' | 'new-folder' | 'assistant'

/**
 * 纯判断：模型给的 cwd/kind 优先，缺省或非法才用规则函数兜底。
 * 抽成纯函数便于单测（不碰 fs / 宿主）。
 */
export function resolveDispatchTarget(input: {
  task: string
  cwd?: string
  kind?: string
  projects?: DispatchProject[]
  assistantHome: string
  newFolderParent?: string
  existingFolders?: string[]
  now?: Date
}): { kind: string; cwd: string; reason: string; decidedBy: 'model' | 'rules'; folderName?: string; signals?: string[] } {
  const task = String(input.task ?? '').trim()
  const cwd = String(input.cwd ?? '').trim()
  const kind = String(input.kind ?? '').trim()
  // assistant 是旧版 A 类杂活目录，已废除。即便旧提示词仍传来 assistant + cwd，
  // 也忽略该目录并重新走 B/C，绝不再把动手活丢回秘书直接回答。
  if (isUsableTargetDir(cwd) && kind !== 'assistant') {
    const normalized = cwd.replace(/[\\/]+$/, '')
    const decided = kind === 'new-folder' || kind === 'assistant' || kind === 'existing' ? kind : 'existing'
    return { kind: decided, cwd: normalized, reason: '秘书模型指定目录', decidedBy: 'model' }
  }
  const decision = decideDispatchTarget({
    text: task,
    projects: input.projects ?? [],
    assistantHome: String(input.assistantHome ?? ''),
    newFolderParent: String(input.newFolderParent ?? ''),
    existingFolders: input.existingFolders ?? [],
    now: input.now,
  })
  return { ...decision, decidedBy: 'rules' }
}

/** 系统提示词段落：A/B/C 分层 + 现有项目目录清单（只对固定秘书会话生效）。 */
export function dispatchPromptSection(ctx: any, projects: DispatchProject[]): string {
  const home = safeAssistantHome()
  const parent = safeNewFolderParent()
  const lines: string[] = []
  lines.push('# 派活分层（个人秘书）')
  lines.push('')
  lines.push('你是只读的个人秘书：只读限制你自己写文件、跑终端、直接操作屏幕和派子代理，不限制建会话与派活，也不限制只读联网查询。按 A/B/C 三层处理：')
  lines.push(DISPATCH_RULES)
  lines.push('')
  lines.push(`分层 A 直接回答，不调用 ${SECRETARY_DISPATCH_TOOL}、不建会话。纯知识问题，以及只读联网一查就能答的轻量事实（例如「明天天气」直接用 web_search 查），都属于 A。`)
  lines.push(`其余需要看屏幕、操作应用、读写本机文件、保存/下载/整理文件或动手的任务，一律先调用 ${SECRETARY_DISPATCH_TOOL}，把用户原话原样放进 task；宿主只建/续 **Computer Use 模式**会话，绝不派进标准会话。`)
  lines.push('标准会话由 Computer Use 会话在后台自行派发，不归你管，也不要给它们建卡片。')
  lines.push('')
  lines.push('禁止收工式回答：不得以「我看不到」「没有截图能力」「无法直接确认」「我做不了」作为终答，也不要先猜一个答案再结束；不得用「工具清单里没有派活工具」当终答。')
  lines.push(`遇到自己做不到或需要动手的任务，必须先派 ${SECRETARY_DISPATCH_TOOL}，工具成功后再照实回报回执文案：只有「已派活（…已确认在跑）」才是那条会话真接上了话，「已入队（未确认在跑）」就是只投进了队列、不许说成已派活，回执带「续接失败已改新建」就是那条会话这一轮失败了。`)
  lines.push(`例：「你看我打开的 QQ 页面，他们说的 38 fn 指什么模型？」需要看当前屏幕，必须先调用 ${SECRETARY_DISPATCH_TOOL}，绝不能在秘书页回答看不到。`)
  lines.push('例：「明天天气」是只读联网可查的轻量问题，直接用 web_search / web_fetch 查并给出结果；万一联网工具不可用，再派活，不能直接说没办成。')
  lines.push('例：「今天几号」是纯知识随口问，直接回答，不调用工具、不建会话。')
  lines.push('')
  lines.push(`新项目父目录（分层 C 新建文件夹的位置）：${parent || '（未知）'}`)
  if (home !== '') lines.push(`个人助手目录（仅供你理解环境；不再作为简单杂活的派活目标）：${home}`)
  lines.push('')
  if (projects.length > 0) {
    lines.push('既有项目目录（分层 B 的判断依据，与控制室项目卡片同一份数据；最近在用的排在前面）：')
    for (const project of projects.slice(0, 12)) {
      const titles = (project.titles ?? []).slice(0, 2).join(' / ')
      lines.push(`- ${project.dir}${project.name && project.name !== project.dir ? `（${project.name}）` : ''}${titles ? ` 最近会话：${titles}` : ''}`)
    }
  } else {
    lines.push('既有项目目录：（暂时读不到；纯知识问题走 A，其余一律走 C）')
  }
  lines.push('')
  lines.push(`再次强调：「今天几号」「明天天气」这类纯知识或只读联网可查的问题直接答（天气用 web_search / web_fetch）；只要需要看屏幕、动手或操作本机，就先调用 ${SECRETARY_DISPATCH_TOOL}，再说已派。`)
  void ctx
  return lines.join('\n')
}

/**
 * 系统提示词段落：控制室全部专项任务项目文件夹的当轮实时快照（2026-11-22 用户新需求）。
 * 与 1790 派活段共用 promptProjectSnapshot 的同一份结果；口径差异：全景段不截 12 条、
 * 含隐藏卡（标注「隐藏」）、不附会话标题；派活 B 层段保持原口径（隐藏排除、top 12、带最近会话标题）。
 */
export function consoleProjectsPromptSection(projects: DispatchProject[]): string {
  const lines: string[] = []
  lines.push('# 控制室项目清单（实时快照）')
  lines.push('')
  if (projects.length > 0) {
    lines.push('控制室当前全部专项任务项目文件夹，与控制室项目卡片同一份注册表（removed 已排除，隐藏卡片保留并标注；含会话目录归并，最近在用的排在前面）：')
    for (const project of projects) {
      const name = project.name && project.name !== project.dir ? `（${project.name}）` : ''
      lines.push(`- ${project.dir}${name}${project.hidden ? '（隐藏）' : ''}`)
    }
  } else {
    lines.push('控制室项目清单：（暂时读不到；分层 C 新建专项，或稍后重试）')
  }
  lines.push('')
  lines.push('此清单为当轮实时快照，以它为准；派活选目录时逐字照抄这里的路径。')
  return lines.join('\n')
}

/** 从模型参数里取会话标题（避免过长）。 */
function titleOf(task: string): string {
  const firstLine = String(task ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''
  const clean = firstLine.replace(/^[#*\s]+/, '').slice(0, 28)
  return `派活：${clean === '' ? '新任务' : clean}`
}

/** 该目录下可续接的 CU 会话行（归一 cwd、排除标准会话/子代理/秘书自身），按 updatedAt 降序。纯函数。 */
export function cuContinueCandidates(rows: CuSessionRow[], cwd: string, secretaryId = ''): CuSessionRow[] {
  const norm = (dir: string): string => String(dir ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const target = norm(cwd)
  if (target === '') return []
  return rows
    .filter((row) => {
      if (String(row.sessionId ?? '') === '') return false
      if (row.sessionId === secretaryId) return false
      if (row.agentPreset !== CU_AGENT_PRESET) return false
      if (row.origin === 'subagent' || (Number(row.delegationDepth) || 0) > 0) return false
      return norm(String(row.cwd ?? '')) === target
    })
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
}

/**
 * 分层 B 续接挑选：该项目文件夹下最近的 Computer Use 会话。
 * 排除：非 CU 模式（标准会话不归秘书管）、子代理会话、秘书固定会话自身、
 * 以及 `isUnusable` 判为不可用的会话（2026-11-23 新增：模型已退役的那种）。
 * 纯函数（单测直接驱动）。
 */
export function pickCuSessionToContinue(
  rows: CuSessionRow[],
  cwd: string,
  secretaryId = '',
  isUnusable?: (row: CuSessionRow) => boolean,
): CuSessionRow | null {
  const candidates = typeof isUnusable === 'function'
    ? cuContinueCandidates(rows, cwd, secretaryId).filter((row) => !isUnusable(row))
    : cuContinueCandidates(rows, cwd, secretaryId)
  return candidates[0] ?? null
}

/* ---------- 派活执行确认（2026-11-23 用户定案：回执不许谎报） ---------- */

/** 观测窗口默认值与轮询间隔；DSH_ASSISTANT_DISPATCH_VERIFY_MS / _POLL_MS 覆盖（0 = 不等）。 */
export const DISPATCH_VERIFY_TIMEOUT_MS = 10_000
export const DISPATCH_VERIFY_POLL_MS = 150
/** 起了轮但还没跑出一 step 时的宽限期：等这么久再看它是不是立刻崩成失败轮。 */
export const DISPATCH_VERIFY_GRACE_MS = 1_500

/** confirmed = 观测到会话真接上了话；unverified = 只入队没确认；failed = 入队失败或那一轮失败。 */
export type DispatchVerification = 'confirmed' | 'unverified' | 'failed'

export interface DispatchFailure { kind: string; message: string; code: string }

export interface DispatchEvidence {
  verification: DispatchVerification
  /** 观测到的轮次号（0 = 没观测到） */
  turn: number
  /** 失败轮的错误原文（只有 verification='failed' 有值） */
  failure?: DispatchFailure
  /** 观测到派活消息还躺在该会话的待办队列里（入队成功、尚未被消费） */
  pending: boolean
  /** 证据来源：宿主事件流 / 活的 agent 队列 / 入队就抛错 */
  observed_via: 'bus' | 'poll' | 'none' | 'queue-throw'
}

function clampMs(value: unknown, fallback: number, max: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw < 0) return fallback
  return Math.min(Math.floor(raw), max)
}

function envMs(name: string, fallback: number, max: number): number {
  return clampMs(process.env[name], fallback, max)
}

/** 该会话的待办队列里还有我们这条派活消息吗。null = 读不到队列（不猜）。 */
export function pendingRequestInAgent(ctx: any, sessionId: string, requestId: string): boolean | null {
  let agent: any
  try {
    const agents = (typeof ctx?.get === 'function' ? ctx.get('agents') : undefined) ?? ctx?.agents
    agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  } catch { return null }
  if (agent === undefined || agent === null) return null
  const lists = [agent?.inbox?.nextTurn, agent?.inbox?.nextStep]
  let known = false
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    known = true
    for (const message of list) {
      if (String(message?.source?.rpcId ?? '') === requestId) return true
    }
  }
  return known ? false : null
}

/**
 * 入队前后盯那条会话：观测窗口内看到「起了轮 / 跑了步 / 轮已收尾」= confirmed，
 * 看到失败轮（error/aborted/interrupted/blocked）= failed，入队本身抛错 = failed（kind=queue-throw），
 * 什么证据都没有 = unverified。只观测宿主事件，绝不写任何会话事件。
 */
export async function observeDispatchPrompt(input: {
  ctx: any
  sessionId: string
  requestId: string
  prompt: () => Promise<unknown>
  timeoutMs?: number
  pollMs?: number
  graceMs?: number
  signal?: AbortSignal
}): Promise<DispatchEvidence> {
  const ctx = input.ctx
  const sessionId = String(input.sessionId ?? '')
  const requestId = String(input.requestId ?? '')
  const timeoutMs = input.timeoutMs !== undefined ? clampMs(input.timeoutMs, DISPATCH_VERIFY_TIMEOUT_MS, 60_000) : envMs('DSH_ASSISTANT_DISPATCH_VERIFY_MS', DISPATCH_VERIFY_TIMEOUT_MS, 60_000)
  const pollMs = input.pollMs !== undefined ? clampMs(input.pollMs, DISPATCH_VERIFY_POLL_MS, 2_000) : envMs('DSH_ASSISTANT_DISPATCH_POLL_MS', DISPATCH_VERIFY_POLL_MS, 2_000)
  const graceMs = input.graceMs !== undefined ? clampMs(input.graceMs, DISPATCH_VERIFY_GRACE_MS, 30_000) : envMs('DSH_ASSISTANT_DISPATCH_GRACE_MS', DISPATCH_VERIFY_GRACE_MS, 30_000)
  const busAvailable = typeof ctx?.on === 'function'

  const state = {
    turn: 0,
    opened: false,
    worked: false,
    consumed: false,
    ended: false,
    pending: false,
    busSeen: false,
    failure: null as DispatchFailure | null,
  }
  let settled = false
  let resolveDone: (value: DispatchEvidence) => void = () => {}
  const done = new Promise<DispatchEvidence>((resolve) => { resolveDone = resolve })
  let timer: ReturnType<typeof setTimeout> | undefined
  let tick: ReturnType<typeof setInterval> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let offBus: unknown

  const evidenceOf = (verification: DispatchVerification): DispatchEvidence => ({
    verification,
    turn: state.turn,
    ...(state.failure !== null ? { failure: state.failure } : {}),
    pending: state.pending,
    observed_via: state.failure !== null && state.failure.kind === 'queue-throw'
      ? 'queue-throw'
      : (state.busSeen ? 'bus' : (pendingKnown.value !== null ? 'poll' : (busAvailable ? 'bus' : 'none'))),
  } as DispatchEvidence)

  const finish = (verification: DispatchVerification): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (tick !== undefined) clearInterval(tick)
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    if (typeof offBus === 'function') { try { offBus() } catch { /* 解绑失败不影响回执 */ } }
    resolveDone(evidenceOf(verification))
  }

  const pendingKnown: { value: boolean | null } = { value: null }
  const readPending = (): boolean | null => {
    const value = pendingRequestInAgent(ctx, sessionId, requestId)
    pendingKnown.value = value
    if (value !== null) state.pending = value
    return value
  }

  const evaluate = (): void => {
    if (settled) return
    const pending = readPending()
    const absorbed = state.consumed || pending === false
    if (state.failure !== null) return finish('failed')
    if (state.worked && pending !== true) return finish('confirmed')
    if (state.ended && absorbed) return finish('confirmed')
    // 起了轮、也接上了话，但一还没跑出一 step：先等 graceMs 再看宿主是不是立刻把这轮判成失败
    // （钉着已退役模型的会话就是这种：turn/start 后 60～130ms 内 0 步就 turn/end error）
    if (state.opened && absorbed && graceMs > 0 && graceTimer === undefined) {
      graceTimer = setTimeout(() => {
        graceTimer = undefined
        if (state.failure !== null) return finish('failed')
        finish('confirmed')
      }, graceMs)
    }
  }

  const handleEvent = (event: any): void => {
    const type = String(event?.type ?? '')
    const data = event?.data ?? {}
    const turn = Number(data?.turn)
    state.busSeen = true
    if (type === 'agent/inbox/spliced') {
      const inserted = Array.isArray(data?.inserted) ? data.inserted : []
      if (inserted.some((message: any) => String(message?.source?.rpcId ?? '') === requestId)) {
        state.consumed = true
        evaluate()
      }
      return
    }
    if (type === 'turn/start') {
      state.opened = true
      if (Number.isFinite(turn) && turn > 0) state.turn = turn
      evaluate()
      return
    }
    if (type === 'step/start' || type === 'assistant/message' || type === 'assistant/attempt' || type === 'tool/call') {
      state.worked = true
      if (Number.isFinite(turn) && turn > 0) state.turn = turn
      evaluate()
      return
    }
    if (type === 'turn/end') {
      const kind = String(data?.reason?.kind ?? '')
      if (Number.isFinite(turn) && turn > 0) state.turn = turn
      if (kind === 'error' || kind === 'aborted' || kind === 'interrupted' || kind === 'blocked') {
        // 这条失败轮是我们的消息造成的才算失败；我们的消息还排着队 = 别的轮出岔，不算这次派活失败
        if (readPending() === true) return
        state.failure = {
          kind,
          message: String(data?.reason?.error?.message ?? '').trim(),
          code: String(data?.reason?.error?.code ?? '').trim(),
        }
        evaluate()
        return
      }
      if (kind !== '') state.ended = true
      evaluate()
      return
    }
  }

  if (busAvailable) {
    try {
      offBus = ctx.on('session/event', (session: any, event: any) => {
        if (String(session?.id ?? '') !== sessionId) return
        handleEvent(event)
      })
    } catch { offBus = undefined }
  }

  try {
    await input.prompt()
  } catch (error) {
    state.failure = {
      kind: 'queue-throw',
      message: String((error as Error)?.message ?? error),
      code: String((error as any)?.code ?? ''),
    }
    finish('failed')
    return done
  }

  if (!busAvailable && pendingRequestInAgent(ctx, sessionId, requestId) === null) {
    // 宿主既不给事件流也读不到活的 agent 队列：没有任何可观测通道，如实报「未确认」，不空等
    finish('unverified')
    return done
  }
  if (input.signal?.aborted === true) {
    finish('unverified')
    return done
  }
  try { input.signal?.addEventListener?.('abort', () => finish('unverified')) } catch { /* 老信号实现没有 addEventListener */ }
  evaluate()
  if (!settled) {
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish('unverified'), timeoutMs)
      tick = setInterval(evaluate, pollMs)
    } else {
      // 窗口为 0 = 不等（测试口径）：当场没有证据就如实报未确认
      finish('unverified')
    }
  }
  return done
}

/* ---------- 续接候选的模型可用性（读得到就按「模型还配着吗」过滤，读不到就不猜） ---------- */

const MODEL_CHECK_TTL_MS = 30_000
const modelChecks = new Map<string, { at: number; value: boolean }>()

/** 测试用：清掉模型可用性缓存。 */
export function resetModelChecksForTests(): void {
  modelChecks.clear()
}

/**
 * 这个模型变体现在还在宿主配置的模型清单里吗。
 * true = 还配着；false = 已退役/没配（据此排除该会话）；null = 宿主读不到清单（不许据此排除）。
 */
export async function isModelConfigured(
  ctx: any,
  selection: { provider: string; model: string } | null | undefined,
): Promise<boolean | null> {
  if (selection === undefined || selection === null) return null
  const provider = String(selection.provider ?? '')
  const model = String(selection.model ?? '')
  if (provider === '' || model === '') return null
  let llm: any
  try { llm = (typeof ctx?.get === 'function' ? ctx.get('llm') : undefined) ?? ctx?.llm } catch { llm = undefined }
  if (llm === undefined || llm === null) return null
  const key = `${provider}\u0000${model}`
  const cached = modelChecks.get(key)
  if (cached !== undefined && Date.now() - cached.at < MODEL_CHECK_TTL_MS) return cached.value
  let value: boolean | null = null
  if (typeof llm.listModels === 'function') {
    try {
      const models = await llm.listModels(provider)
      value = Array.isArray(models) ? models.some((info: any) => String(info?.id ?? '') === model) : null
    } catch { value = null }
  }
  if (value === null && typeof llm.resolveModelInfo === 'function') {
    try {
      value = (await llm.resolveModelInfo(provider, model)) !== undefined
    } catch (error) {
      // 只有宿主明确说「没配这个模型」才算不可用；其它错误 = 不确定，不据此排除
      value = String((error as any)?.code ?? '') === 'UNKNOWN_MODEL' ? false : null
    }
  }
  if (value === null) return null
  modelChecks.set(key, { at: Date.now(), value })
  return value
}

/** 候选会话 → 逐条查它钉的模型还配着吗（读不到模型的行不进这张表，也就不排除）。 */
async function modelStatesForCandidates(ctx: any, rows: CuSessionRow[], cwd: string, secretaryId: string): Promise<Map<string, boolean | null>> {
  const map = new Map<string, boolean | null>()
  for (const row of cuContinueCandidates(rows, cwd, secretaryId)) {
    if (row.model === undefined) continue
    map.set(String(row.sessionId), await isModelConfigured(ctx, row.model))
  }
  return map
}

/** 调用方会话 id。 */
function callerOf(exec: any): string {
  return String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? '')
}

/**
 * 派活回执文案（三态口径，2026-11-23 用户定案）：
 * - confirmed：真正确认到那条会话接上了话（观测到它起了轮 / 跑了步）→ 才说「已派活」。
 * - unverified：只是入队成功、窗口内没看到它真在跑 → 只能说「已入队（未确认在跑）」，绝不写「已派活」。
 * - failed：入队失败或那一轮失败 → 由 execute() 抛错/自动改新建，绝不出「已派活」文案。
 */
export function dispatchReceiptText(value: any): string {
  const verification = String(value?.verification ?? 'unverified')
  const mode = value?.continued === true ? '续接' : '新建'
  const decided = value?.decided_by === 'model' ? '秘书模型判断' : '规则兜底'
  const head = verification === 'confirmed'
    ? `已派活（Computer Use ${mode}·已确认在跑${Number(value?.turn) > 0 ? ` 第 ${value.turn} 轮` : ''}）`
    : `已入队（未确认在跑，Computer Use ${mode}${value?.pending === true ? '·消息还排在待办队列里' : '·宿主窗口内没给出证据'}）`
  const redispatch = value?.redispatched === true ? '｜续接失败已改新建' : ''
  return `${head}${redispatch} → ${value?.cwd ?? ''}（${decided}：${value?.reason ?? ''}）`
}

/** 宿主工具定义（手写 JSON Schema：不依赖 @deepseek-ai/dsh-tools 的 defineTool）。 */
export function dispatchToolDefinition(ctx: any): any {
  return {
    name: SECRETARY_DISPATCH_TOOL,
    description: DISPATCH_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          description: '用户要干的活（用户原话，别改写、别总结）。必填。',
        },
        cwd: {
          type: 'string',
          description: '分层 B 的既有项目目录（绝对路径）；分层 C 必须留空。实在判断不了才省略，由宿主按 B/C 兜底。',
        },
        kind: {
          type: 'string',
          enum: ['existing', 'new-folder'],
          description: 'existing = 已有项目/旧任务延续（B）；new-folder = 没有对应项目，宿主新建专项文件夹 + CU 会话（C）。',
        },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string' },
          cwd: { type: 'string' },
          kind: { type: 'string' },
          reason: { type: 'string' },
          decided_by: { type: 'string' },
          created_folder: { type: 'boolean' },
          continued: { type: 'boolean' },
          agent_preset: { type: 'string' },
          /** confirmed = 观测到会话接上了话；unverified = 只入队没能确认；failed 只在抛错时出现（没有回执） */
          verification: { type: 'string', enum: ['confirmed', 'unverified'] },
          verified: { type: 'boolean' },
          /** 观测到的轮次号（0 = 没观测到） */
          turn: { type: 'number' },
          /** 观测窗口内这条派活消息是否还在会话待办队列里 */
          pending: { type: 'boolean' },
          /** 续接失败后自动改新建（回执如实写「续接失败已改新建」） */
          redispatched: { type: 'boolean' },
          failed_session_id: { type: 'string' },
        },
        required: ['session_id', 'cwd', 'kind', 'reason', 'decided_by', 'created_folder', 'continued', 'agent_preset', 'verification', 'verified', 'redispatched'],
      },
      render: (_args: unknown, value: any): any[] => [{ type: 'text', text: dispatchReceiptText(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: any, exec: any): Promise<any> {
      const caller = callerOf(exec)
      const secretary = secretarySessionRef.id
      if (secretary === '') throw new Error('个人秘书固定会话还没就绪，稍后再试')
      if (caller !== secretary) throw new Error(`${SECRETARY_DISPATCH_TOOL} 只能在个人秘书会话里调用`)
      const task = String(args?.task ?? '').trim()
      if (task === '') throw new Error('task 不能为空')
      const assistantHome = safeAssistantHome()
      const parent = safeNewFolderParent()
      const projects = await candidateProjects(ctx)
      const target = resolveDispatchTarget({
        task,
        cwd: args?.cwd,
        kind: args?.kind,
        projects,
        assistantHome,
        newFolderParent: parent,
      })
      // 只有纯知识随口问允许不派。看屏/读文件/联网/动手任务若被误分到这里，
      // 返回可纠正错误，要求模型改用 B/C；绝不把「看不到」当终答。
      if (target.kind === 'chat' || target.kind === 'assistant' || target.cwd === '') {
        throw new Error(`只有纯知识性、无需动手的随口问题（以及只读联网一查就能答的轻量事实，直接用 web_search / web_fetch）才直接在秘书会话里回答。若这句话需要看屏幕、操作应用、读写本机文件、保存下载或动手，必须重新调用 ${SECRETARY_DISPATCH_TOOL}：已有项目用 kind=existing，没有项目用 kind=new-folder；禁止以「我看不到」收工。`)
      }

      let createdFolder = false
      if (target.folderName !== undefined && target.folderName !== '') {
        try {
          mkdirSync(target.cwd, { recursive: true })
          createdFolder = true
        } catch (error) {
          throw new Error(`专项文件夹创建失败：${(error as Error)?.message ?? String(error)}`)
        }
      }

      // ctx.get 不受 inject 约束：插件没把 sessionController 声明成硬依赖时也能取到。
      let sessionController: any
      try {
        sessionController = (typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined) ?? ctx?.sessionController
      } catch { sessionController = undefined }
      if (sessionController === undefined || typeof sessionController.create !== 'function') {
        throw new Error('宿主没有会话服务，无法派活')
      }

      // 分层 B：该项目下已有 CU 会话 → 续接最近的一条（标准会话一律不续、不管理）
      const rows = projectCache.rows as CuSessionRow[]
      const candidates = cuContinueCandidates(rows, target.cwd, secretary)
      // 能读到宿主给这条会话钉住的模型就按「模型变体现在还配着吗」排除；读不到就不猜，照旧候选
      const modelStates = await modelStatesForCandidates(ctx, rows, target.cwd, secretary)
      const staleRows = candidates.filter((row) => modelStates.get(String(row.sessionId)) === false)
      const continuing = pickCuSessionToContinue(rows, target.cwd, secretary, (row) => modelStates.get(String(row.sessionId)) === false)
      const staleNote = staleRows.length === 0 ? '' : `；跳过 ${staleRows.length} 条钉着已退役模型的 Computer Use 会话（${staleRows.map((row) => `${row.sessionId}→${row.model?.provider}/${row.model?.model}`).join('、')}）`

      /** 新建一条 Computer Use 模式会话并重投任务（含观测确认）。 */
      const openNewCuSession = async (cwd: string): Promise<{ sessionId: string; preset: string; evidence: DispatchEvidence }> => {
        const created = await sessionController.create({ cwd, agentPreset: CU_AGENT_PRESET })
        const newId = String(created?.sessionId ?? '')
        if (newId === '') throw new Error('宿主没有返回新会话 id')
        const reportedPreset = typeof created?.agentPreset === 'string' ? created.agentPreset : ''
        if (reportedPreset !== '' && reportedPreset !== CU_AGENT_PRESET) {
          throw new Error(`新建会话落成了 ${reportedPreset} 模式（要求 computer-use），这次不派：请确认宿主已注册 computer-use 预设`)
        }
        try {
          if (typeof sessionController.rename === 'function') {
            await sessionController.rename({ sessionId: newId, title: titleOf(task) })
          }
        } catch { /* 标题不是功能依赖 */ }
        const requestId = randomUUID()
        const evidence = await observeDispatchPrompt({
          ctx,
          sessionId: newId,
          requestId,
          signal: exec?.signal,
          prompt: () => sessionController.prompt({
            requestId,
            sessionId: newId,
            mode: 'queue',
            content: [{ type: 'text', text: task }],
          }, exec?.signal),
        })
        return { sessionId: newId, preset: reportedPreset || CU_AGENT_PRESET, evidence }
      }

      if (continuing !== null && !createdFolder) {
        const sessionId = String(continuing.sessionId)
        const requestId = randomUUID()
        const evidence = await observeDispatchPrompt({
          ctx,
          sessionId,
          requestId,
          signal: exec?.signal,
          prompt: () => sessionController.prompt({
            requestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: task }],
          }, exec?.signal),
        })
        const failure: DispatchFailure = evidence.failure ?? { kind: '', message: '', code: '' }
        // 入队本身失败 → 抛错，绝不出「已派活」文案
        if (evidence.verification === 'failed' && failure.kind === 'queue-throw') {
          throw new Error(`派活失败：宿主没能把任务投进 Computer Use 会话 ${sessionId}（${failure.message || '入队报错'}）${staleNote}`)
        }
        if (evidence.verification === 'failed') {
          // 续接的会话这一轮直接失败（例如它钉的模型已从宿主配置里退役）→ 自动改新建并重投，回执照实写
          const pinned = continuing.model !== undefined && continuing.model !== null
            ? `它钉的模型 ${continuing.model.provider}/${continuing.model.model} `
            : ''
          const detail = `${failure.kind}${failure.code !== '' ? `/${failure.code}` : ''}：${failure.message || '宿主没给错误原文'}`
          const fallback = await openNewCuSession(target.cwd)
          return {
            session_id: fallback.sessionId,
            cwd: target.cwd,
            kind: target.kind,
            reason: `${target.reason}；续接会话 ${sessionId} 这一轮失败（${pinned}${detail}）；已改新建 Computer Use 会话 ${fallback.sessionId} 并重投同样的任务${staleNote}`,
            decided_by: target.decidedBy,
            created_folder: false,
            continued: false,
            redispatched: true,
            failed_session_id: sessionId,
            agent_preset: fallback.preset,
            verification: fallback.evidence.verification === 'failed' ? 'unverified' : fallback.evidence.verification,
            verified: fallback.evidence.verification === 'confirmed',
            turn: fallback.evidence.turn,
            pending: fallback.evidence.pending,
          }
        }
        return {
          session_id: sessionId,
          cwd: target.cwd,
          kind: target.kind,
          reason: `${target.reason}；续接该项目最近的 Computer Use 会话${staleNote}`,
          decided_by: target.decidedBy,
          created_folder: false,
          continued: true,
          redispatched: false,
          agent_preset: CU_AGENT_PRESET,
          verification: evidence.verification,
          verified: evidence.verification === 'confirmed',
          turn: evidence.turn,
          pending: evidence.pending,
        }
      }

      // 分层 B（无 CU 会话可续）/ C：新建 Computer Use 模式会话，并核对回执预设
      const fresh = await openNewCuSession(target.cwd)
      return {
        session_id: fresh.sessionId,
        cwd: target.cwd,
        kind: target.kind,
        reason: `${target.reason}${staleNote}`,
        decided_by: target.decidedBy,
        created_folder: createdFolder,
        continued: false,
        redispatched: false,
        agent_preset: fresh.preset,
        verification: fresh.evidence.verification,
        verified: fresh.evidence.verification === 'confirmed',
        turn: fresh.evidence.turn,
        pending: fresh.evidence.pending,
      }
    },
  }
}

/** 注册工具 + 提示词段 + 非秘书会话的拒绝闸。 */
export function registerAssistantDispatch(ctx: any): () => void {
  const disposers: Array<() => void> = []
  // 控制室项目注册表（dsh-assistant-state.json）所在目录 = 宿主 profile 目录，
  // 与 src/assistant-store.ts 同一套解析，保证读的就是控制室项目卡片那份数据。
  try {
    const p = ctx?.get?.('profileContext')
    if (p && typeof p.dir === 'string' && p.dir) setDispatchRegistryDir(p.dir)
    else {
      const h = ctx?.get?.('homePaths')
      if (h && typeof h.home === 'string' && h.home) setDispatchRegistryDir(h.home)
    }
  } catch { /* 拿不到就走 DSH_HOME 兜底 */ }
  const tool = dispatchToolDefinition(ctx)
  // 宿主工具注册：必须真正落到 ctx.tools 上，否则模型那回合的工具清单里就没有
  // secretary_dispatch（2026-11-21「明天天气」实测：清单 50 个工具里没有它）。
  // 插件 inject 已声明 'tools'；这里再做一层防呆——tools 服务若晚于本插件就绪，
  // 用 ctx.inject 等它出现再注册，绝不在它缺席时静默跳过。
  const registerTool = (tools: any): void => {
    if (!tools || typeof tools.register !== 'function') return
    try {
      const off = tools.register(tool)
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      ctx?.logger?.warn?.(`[dsh-assistant] secretary_dispatch 工具注册失败：${String((error as Error)?.message ?? error)}`)
    }
  }
  let tools: any
  try { tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined } catch { tools = undefined }
  if (tools && typeof tools.register === 'function') {
    registerTool(tools)
  } else {
    let deferred = false
    try {
      if (typeof ctx?.inject === 'function') {
        ctx.inject(['tools'], (scope: any) => { registerTool(scope?.tools) })
        deferred = true
      }
    } catch { deferred = false }
    if (!deferred) {
      try { registerTool(ctx?.tools) } catch (error) {
        ctx?.logger?.warn?.(`[dsh-assistant] secretary_dispatch 工具注册失败：${String((error as Error)?.message ?? error)}`)
      }
    }
  }

  // 系统提示词：控制室项目清单实时快照段，order 1775——滚动摘要段（1770）之后、
  // 朗读规范段（1780）/语音段（1785）/派活分层段（1790）之前。只对固定秘书会话生效；
  // 与 1790 段共用 promptProjectSnapshot 的同一份结果（100ms 窗口内同一引用，天然同源）。
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      const off = systemPrompt.section({
        name: 'assistant:secretary-console-projects',
        order: 1775,
        text: (context: any) => {
          const sessionId = String(context?.agent?.session?.id ?? '')
          if (sessionId === '' || sessionId !== secretarySessionRef.id) return ''
          return consoleProjectsPromptSection(promptProjectSnapshot(ctx))
        },
      })
      if (typeof off === 'function') disposers.push(off)
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] 控制室项目清单提示词注册失败：${String((error as Error)?.message ?? error)}`)
  }

  // 系统提示词：只对固定秘书会话生效（其它会话返回空串，等于没加这段）。
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      const off = systemPrompt.section({
        name: 'assistant:secretary-dispatch',
        order: 1790,
        text: (context: any) => {
          const sessionId = String(context?.agent?.session?.id ?? '')
          if (sessionId === '' || sessionId !== secretarySessionRef.id) return ''
          // 与 1775 全景段同源：promptProjectSnapshot 在快照窗口内返回同一引用；
          // B 层候选保持原口径——隐藏卡片不进「既有项目目录」，仍截 top 12。
          const projects = promptProjectSnapshot(ctx).filter((project) => !project.hidden)
          return dispatchPromptSection(ctx, projects)
        },
      })
      if (typeof off === 'function') disposers.push(off)
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] 派活提示词注册失败：${String((error as Error)?.message ?? error)}`)
  }

  // 其它会话调用 secretary_dispatch → 拒绝（工具是全局注册的，必须挡住越界使用）。
  try {
    const off = ctx?.on?.('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
      if (String(exec?.name ?? '') !== SECRETARY_DISPATCH_TOOL) return next()
      const caller = callerOf(exec)
      if (caller !== '' && caller === secretarySessionRef.id) return next()
      return { kind: 'deny', reason: `${SECRETARY_DISPATCH_TOOL} 只能在个人秘书会话里调用。` }
    })
    if (typeof off === 'function') disposers.push(off)
  } catch { /* 老宿主没有 pre-execute 钩子：工具内部的会话校验仍然拦得住 */ }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}

/** 单测入口。 */
export const assistantDispatchTestSurface = {
  SECRETARY_DISPATCH_TOOL,
  CU_AGENT_PRESET,
  DISPATCH_RULES,
  resolveDispatchTarget,
  isUsableTargetDir,
  dispatchPromptSection,
  consoleProjectsPromptSection,
  promptProjectSnapshot,
  resetPromptSnapshotForTests,
  listSessionRows,
  candidateProjects,
  resetDispatchCacheForTests,
  dispatchToolDefinition,
  dispatchReceiptText,
  registerAssistantDispatch,
  pickCuSessionToContinue,
  cuContinueCandidates,
  modelSelectionOf,
  isModelConfigured,
  resetModelChecksForTests,
  observeDispatchPrompt,
  pendingRequestInAgent,
  DISPATCH_VERIFY_TIMEOUT_MS,
  DISPATCH_VERIFY_POLL_MS,
  DISPATCH_VERIFY_GRACE_MS,
  parseConsoleProjects,
  mergeConsoleProjects,
  setDispatchRegistryDir,
}
