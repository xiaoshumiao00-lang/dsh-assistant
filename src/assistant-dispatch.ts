/**
 * 个人秘书「派活目录」——改由**秘书模型理解后决定**（2026-11-20 用户第二次实测反馈）。
 *
 * 变化点：
 *   - 以前是客户端 send() 里直接跑规则函数 decideDispatchTarget(...) 决定目录；
 *     现在秘书页就是标准会话页，插件不再拦消息，所以判定必须发生在**会话内的模型决策**：
 *     秘书模型读懂了用户那句话，按下面三条规则挑一个目标目录，调用 `secretary_dispatch`
 *     把 task 和 cwd 一起交出来；宿主拿到 cwd 后才建目录/建会话/派活。
 *   - 提示词（三条规则 + 现有项目目录清单）由 systemPrompt section 注入，
 *     只对固定秘书会话生效，其它会话一个字都不多。
 *   - 原规则函数 src/client/secretary-dispatch.ts 保留为 **fallback**：模型没给 cwd、
 *     或给了个非法目录（不是绝对路径）时，宿主按同一套规则兜底，并如实回报
 *     decidedBy='rules'。它的单测（scripts/test-secretary-dispatch.mjs）保留不动。
 *
 * 工具闸：`secretary_dispatch` 只在固定秘书会话里可用；其它会话调用一律拒绝。
 */
import { mkdirSync } from 'node:fs'
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

/** 三条规则原文（提示词与工具描述共用，避免两处漂移）。 */
export const DISPATCH_RULES = [
  '1. 延续旧任务，或与下面某个既有项目相关 → cwd 填那个项目的目录（原样照抄清单里的路径）。',
  '2. 与任何既有项目都不相关、而且任务够大（多步骤 / 跨文件 / 建工程） → kind 填 new-folder、cwd 留空，由宿主在「新项目父目录」下建一个专项文件夹。',
  '3. 日常杂活（裁图、翻译一句、润色一段、查个东西、整理笔记） → cwd 填「个人助手目录」。',
].join('\n')

/** 工具描述（模型看到的就是这段）。 */
const DISPATCH_DESCRIPTION = [
  '把一件真正要动手的活派给一条独立的标准会话（不是子代理，子代理会继承本会话的只读档）。',
  '你是只读的个人秘书：自己能答的（闲聊、问句、查资料、总结）直接在会话里回答，不要调用本工具。',
  '要派活时，先在 cwd 里写清你选定的目标目录（绝对路径），再调用本工具；宿主会按这个目录建会话并把 task 发过去。',
  '选目录只能用这三条规则：',
  DISPATCH_RULES,
  '判断「延续旧任务」时参考系统提示里给出的既有项目目录与最近会话标题。',
  '只有在你确实无法判断时才省略 cwd：宿主会用旧规则兜底，但那样可能落错目录。',
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

/**
 * 读出全部会话行（只取 cwd / title / updatedAt）。
 * 优先 sessionQuery（持久化全集，重启后也在），退而用内存里的活会话。
 */
export async function listSessionRows(ctx: any): Promise<SessionRowLike[]> {
  const rows: SessionRowLike[] = []
  try {
    const query = ctx?.get?.('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      const list = await query.listSessions(undefined)
      for (const record of Array.isArray(list) ? list : []) {
        const header = record?.header ?? {}
        rows.push({
          cwd: String(header.cwd ?? ''),
          title: String(header.title ?? ''),
          updatedAt: toMs(header.updatedAt ?? header.createdAt),
        })
      }
    }
  } catch { /* 没有 sessionQuery：走内存那条 */ }
  try {
    const live = ctx?.sessions?.list?.() ?? []
    for (const session of Array.isArray(live) ? live : []) {
      const header = session?.header ?? {}
      rows.push({
        cwd: String(header.cwd ?? ''),
        title: String(header.title ?? ''),
        updatedAt: toMs(header.updatedAt),
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
  const home = safeAssistantHome()
  return projectsFromSessions(rows, home ? [home] : [])
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
  if (isUsableTargetDir(cwd)) {
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

/** 系统提示词段落：三条规则 + 现有项目目录清单（只对固定秘书会话生效）。 */
export function dispatchPromptSection(ctx: any, projects: DispatchProject[]): string {
  const home = safeAssistantHome()
  const parent = safeNewFolderParent()
  const lines: string[] = []
  lines.push('# 派活目录（个人秘书）')
  lines.push('')
  lines.push('你是只读的个人秘书：能自己答的就直接答；要真的动手（改文件、跑程序、写文档、做工程）时，')
  lines.push(`调用 ${SECRETARY_DISPATCH_TOOL} 工具，把用户原话放进 task，并在 cwd 里写清你选定的目标目录。`)
  lines.push('')
  lines.push('选目录只用这三条规则：')
  lines.push(DISPATCH_RULES)
  lines.push('')
  lines.push(`个人助手目录（规则 3）：${home || '（未知）'}`)
  lines.push(`新项目父目录（规则 2 新建文件夹的位置）：${parent || '（未知）'}`)
  lines.push('')
  if (projects.length > 0) {
    lines.push('既有项目目录（规则 1/2 的判断依据，最近在用的排在前面）：')
    for (const project of projects.slice(0, 12)) {
      const titles = (project.titles ?? []).slice(0, 2).join(' / ')
      lines.push(`- ${project.dir}${project.name && project.name !== project.dir ? `（${project.name}）` : ''}${titles ? ` 最近会话：${titles}` : ''}`)
    }
  } else {
    lines.push('既有项目目录：（暂时读不到，按规则 2/3 判断）')
  }
  lines.push('')
  lines.push(`不是要动手的问话（聊天、问状态、问你是谁）就直接回答，不要调用 ${SECRETARY_DISPATCH_TOOL}。`)
  void ctx
  return lines.join('\n')
}

/** 从模型参数里取会话标题（避免过长）。 */
function titleOf(task: string): string {
  const firstLine = String(task ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''
  const clean = firstLine.replace(/^[#*\s]+/, '').slice(0, 28)
  return `派活：${clean === '' ? '新任务' : clean}`
}

/** 调用方会话 id。 */
function callerOf(exec: any): string {
  return String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? '')
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
          description: '你选定的目标目录（绝对路径）。按三条规则挑；实在判断不了才省略。',
        },
        kind: {
          type: 'string',
          enum: ['existing', 'new-folder', 'assistant'],
          description: 'existing = 旧项目/旧任务延续；new-folder = 不相关的大活（宿主新建专项文件夹）；assistant = 日常杂活（个人助手目录）。',
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
        },
        required: ['session_id', 'cwd', 'kind', 'reason', 'decided_by', 'created_folder'],
      },
      render: (_args: unknown, value: any): any[] => [{
        type: 'text',
        text: `已派活 → ${value?.cwd ?? ''}（${value?.decided_by === 'model' ? '秘书模型判断' : '规则兜底'}：${value?.reason ?? ''}）`,
      }],
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
      if (target.kind === 'chat' || target.cwd === '') {
        throw new Error('这条看起来不像要派出去的活：直接在会话里回答用户，不要调用本工具。')
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

      const sessionController = ctx?.sessionController
      if (sessionController === undefined || typeof sessionController.create !== 'function') {
        throw new Error('宿主没有会话服务，无法派活')
      }
      const created = await sessionController.create({ cwd: target.cwd })
      const sessionId = String(created?.sessionId ?? '')
      if (sessionId === '') throw new Error('宿主没有返回新会话 id')
      try {
        if (typeof sessionController.rename === 'function') {
          await sessionController.rename({ sessionId, title: titleOf(task) })
        }
      } catch { /* 标题不是功能依赖 */ }
      await sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: task }],
      }, exec?.signal)

      return {
        session_id: sessionId,
        cwd: target.cwd,
        kind: target.kind,
        reason: target.reason,
        decided_by: target.decidedBy,
        created_folder: createdFolder,
      }
    },
  }
}

/** 注册工具 + 提示词段 + 非秘书会话的拒绝闸。 */
export function registerAssistantDispatch(ctx: any): () => void {
  const disposers: Array<() => void> = []
  const tool = dispatchToolDefinition(ctx)
  try {
    if (ctx?.tools && typeof ctx.tools.register === 'function') {
      const off = ctx.tools.register(tool)
      if (typeof off === 'function') disposers.push(off)
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] secretary_dispatch 工具注册失败：${String((error as Error)?.message ?? error)}`)
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
          const projects = buildProjects(projectCache.rows)
          void candidateProjects(ctx)
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
  DISPATCH_RULES,
  resolveDispatchTarget,
  isUsableTargetDir,
  dispatchPromptSection,
  listSessionRows,
  candidateProjects,
  resetDispatchCacheForTests,
  dispatchToolDefinition,
  registerAssistantDispatch,
}
