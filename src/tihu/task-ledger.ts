/**
 * 鹈鹕任务登记簿（Task Ledger）—— 统一指挥会话的**唯一事实源**。
 *
 * 为什么要有它：2026-11-09 之前的屏与播报全部按「会话 id」投影（`pendingByDisplay`、
 * `homePinned`、`runningSessions`、`lastReplies` 都以 sessionId 建键），于是「完成通知
 * 必须点气泡→切会话→才看到回复」这件事写在了数据模型里。这里把事实源换成**任务 id**：
 * 会话只是任务的一个字段（`sessionIds`），不再是投影的父级。
 *
 * 分层纪律：
 *   - 本文件是**纯逻辑**：不碰 WebSocket、不读文件、不认识 TihuDevice；
 *   - 时间一律由调用方传入（`now`），单测可以拨表；
 *   - 屏帧不在本文件里拼（那是 task-screens.ts 的事），这里只产出棋盘数据（`board()`）。
 *
 * 状态机（只允许这几条边）：
 *
 *   queued ──派单──► running ──完成──► done ──归档──► archived
 *      │                │
 *      └────撤单────────┴──要人──► awaiting ──回答──► running
 *
 * `awaiting` 只有一个来源：**托管没点亮**时问题落回人身上（`tuoguan-autoanswer.ts` 开着时
 * 它替人答首选项，根本不会有待决策）。所以「出现待决策」本身就等于「托管没开」。
 */
import type { TaskBoardPayload, TaskBoardRow, TaskNotifyLevel, TaskState } from './protocol.ts'
import type { TihuCardRow } from './project-groups.ts'

/** 时长环满圈＝30 分钟（超过继续转琥珀＝跑久了）。 */
export const RING_FULL_MS = 30 * 60_000
/** 语音播报合并窗口：这段时间内攒下的 P1/P2 压成一句（屏气泡仍逐条）。 */
export const ANNOUNCE_WINDOW_MS = 8_000
/** 只有一条时也等这么久再念：留给同一秒内到达的其它完成，凑成一句。 */
export const ANNOUNCE_SINGLE_DELAY_MS = 400
/** 棋盘每页行数（与屏幕 320×240 的可读行数一致）。 */
export const BOARD_PAGE_SIZE = 5
/** 登记簿内存上限：棋盘只显示最近这些，更早的直接归档。 */
export const LEDGER_MAX_TASKS = 60
/** 完成/已播报态在棋盘上留多久后自动归档（毫秒）：用户要求至少 3 天，不能更早。 */
export const DONE_KEEP_MS = 3 * 24 * 60 * 60_000

/** 一条任务。字段最小集：屏/播报/归档各自只用自己需要的那些。 */
export interface TihuTask {
  /** 稳定短号（`t1`、`t2`…）：屏与播报都用它。 */
  taskId: string
  /** 一句话意图的规范化短语。 */
  title: string
  /** 项目卡 id（日常任务是 `wt-assistant`）。 */
  projectId: string
  /** 项目名（屏上「项目 · 第 N 步」用）。 */
  projectName: string
  /** 落点文件夹（绝对路径）。 */
  folder?: string
  /** 承载执行的一条或多条会话（登记簿持有 task→session 映射）。 */
  sessionIds: string[]
  /** standard / computer-use。 */
  preset: string
  state: TihuTaskState
  /** 第几步工具调用（没有分母）。 */
  step: number
  /** 最近 8 步耗时（毫秒）：棋盘微条用，纯展示，不参与状态。 */
  stepDurations?: number[]
  /** 上一步发生的时刻（算微条间隔）。 */
  lastStepAt?: number
  /** 第几轮 turn。 */
  turn: number
  /** 派单时刻（时长环从它算起）。 */
  startedAt: number
  /** 最后一次状态变化。 */
  updatedAt: number
  /** 完成时刻。 */
  finishedAt?: number
  /** 完成时的一行结果摘要（不是正文）。 */
  resultLine?: string
  /** 任务行摘要（里程碑更新它）。 */
  summary: string
  /** 已播报时刻（防止重复念）。 */
  spokenAt?: number
  /** 待决策：电脑端同一个问题（原样）。 */
  question?: string
  /** 待决策的上下文一行（危险动作的目标路径/命令原文）。 */
  detail?: string
  /** 待决策：同一组选项（顺序也一致）。 */
  options?: string[]
  /** 默认项下标＝首选项（与托管开着时的自动选择同一条规则）。 */
  defaultIndex?: number
  /** 待决策截止（到点按默认项走）。 */
  decisionDeadline?: number
  /** 谁拍的板（`设备 60 秒超时` / `设备点选` / `口头确认`）。 */
  answeredBy?: string
  /** 归档时刻。 */
  archivedAt?: number
  /** journal 行写过没有（只写一次）。 */
  journaled?: boolean
}

/** 登记簿里的状态；`archived` 是终态（任务移出棋盘，会话与文件夹原样保留）。 */
export type TihuTaskState = TaskState | 'archived'

/** 状态→屏上胶囊文字（文字优先，颜色只做辅助）。 */
export function capsuleOf(state: TihuTaskState): string {
  switch (state) {
    case 'queued': return '排队'
    case 'dispatched': return '派单'
    case 'running': return '执行中'
    case 'awaiting': return '待决策'
    case 'done': return '完成'
    // 屏 1 的胶囊与图一致仍写「完成」；`announced` 是登记簿的第七态（已播报），
    // 用于播报去重与归档，不再多造一个屏上词。
    case 'announced': return '完成'
    case 'archived': return '已归档'
    default: return '排队'
  }
}

/** 完成家族：棋盘胶囊还分「完成/已播报」，但时长环、排序、归档按同一族处理。 */
export function isFinishedState(state: TihuTaskState): boolean {
  return state === 'done' || state === 'announced'
}

/** 排序权重：**要人的永远在最上**，完成沉底。 */
function stateRank(state: TihuTaskState): number {
  switch (state) {
    case 'awaiting': return 0
    case 'running': return 1
    case 'dispatched': return 2
    case 'queued': return 3
    case 'done': return 4
    case 'announced': return 5
    default: return 6
  }
}

/** 一句话 → 任务标题：去噪音、压空白、按像素省略（18 字以内）。 */
export function taskTitleOf(text: unknown, maxChars = 18): string {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[，,。.、\s]+/, '')
    .replace(/[。！？!?；;，,、\s]+$/g, '')
    .trim()
  if (clean === '') return '这条任务'
  const chars = [...clean]
  if (chars.length <= maxChars) return clean
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

/** 副行「项目 · 第 N 步」；还没起跑时不编步数。 */
export function subLineOf(task: TihuTask, projectName?: string): string {
  const project = String(projectName ?? task.projectName ?? '').trim()
  const head = project === '' ? '' : project
  if (task.state === 'queued') return head === '' ? '排队中' : `${head} · 排队中`
  if (task.state === 'dispatched') return head === '' ? '已派出' : `${head} · 已派出`
  if (isFinishedState(task.state)) return head === '' ? '已完成' : `${head} · 已完成`
  if (task.step <= 0) return head === '' ? '已派出' : `${head} · 已派出`
  return head === '' ? `第 ${task.step} 步` : `${head} · 第 ${task.step} 步`
}

/** 时长环：排队/派单空环、完成满环、跑久了转琥珀（30 分钟为界）。 */
export function ringOf(task: TihuTask, now: number): TaskBoardRow['ring'] {
  if (task.state === 'queued' || task.state === 'dispatched' || task.state === 'archived') return { percent: 0, tone: 'empty' }
  if (isFinishedState(task.state)) return { percent: 1, tone: 'done' }
  const end = task.state === 'awaiting' ? task.updatedAt : now
  const elapsed = Math.max(0, end - task.startedAt)
  const percent = Math.min(1, elapsed / RING_FULL_MS)
  return { percent, tone: elapsed > RING_FULL_MS ? 'warn' : 'normal' }
}

/** 任务行（棋盘一行）。待决策行给琥珀问号，不显示时长。 */
export function rowOf(task: TihuTask, now: number): TaskBoardRow {
  const row: TaskBoardRow = {
    taskId: task.taskId,
    title: task.title,
    state: task.state === 'archived' ? 'done' : task.state,
    capsule: capsuleOf(task.state),
    sub: subLineOf(task),
    ring: ringOf(task, now),
  }
  if (task.state === 'awaiting') {
    row.badge = 'ask'
    row.ring = { percent: 0, tone: 'empty' }
  }
  if (task.stepDurations !== undefined && task.stepDurations.length > 0) row.micro = task.stepDurations.slice(-8)
  return row
}

/**
 * 棋盘数据：排序固定（待决策 → 执行中 → 排队 → 完成），同一项目连续多条只留最新一条，
 * 其余折叠成 `merged`（屏上画「+N 条」；点开看的是项目里最新那条）。
 *
 * 为什么按「连续」而不是「全项目」折叠：用户看棋盘是自上而下扫一眼，「刚才那三条基金」
 * 挨着才折叠得有意义；一旦中间夹了别的项目，它就是另一段上下文，不该被吞掉。
 */
export function boardOf(tasks: readonly TihuTask[], now: number, page = 0): TaskBoardPayload {
  const live = tasks.filter((task) => task.state !== 'archived')
  const sorted = [...live].sort((a, b) => {
    const byRank = stateRank(a.state) - stateRank(b.state)
    if (byRank !== 0) return byRank
    // 同状态：新动静的在前（完成态用完成时刻，避免「刚完成的反而排后面」）。
    const aAt = isFinishedState(a.state) ? a.finishedAt ?? a.updatedAt : a.updatedAt
    const bAt = isFinishedState(b.state) ? b.finishedAt ?? b.updatedAt : b.updatedAt
    if (aAt !== bAt) return bAt - aAt
    return a.taskId.localeCompare(b.taskId)
  })
  const rows: TaskBoardRow[] = []
  const kept = new Map<string, TaskBoardRow>()
  for (const task of sorted) {
    const key = `${task.state}|${task.projectId}`
    const existing = kept.get(key)
    if (existing !== undefined) {
      existing.merged = (existing.merged ?? 0) + 1
      continue
    }
    const row = rowOf(task, now)
    kept.set(key, row)
    rows.push(row)
  }
  const totalPages = Math.max(1, Math.ceil(rows.length / BOARD_PAGE_SIZE))
  const index = Math.max(0, Math.min(Math.trunc(page), totalPages - 1))
  const counts = countsOf(tasks)
  return {
    rows: rows.slice(index * BOARD_PAGE_SIZE, (index + 1) * BOARD_PAGE_SIZE),
    counts,
    page: { index, total: totalPages },
    total: rows.length,
    empty: rows.length === 0,
  }
}

/** 顶行三段计数（在跑 / 等你 / 排队）。 */
export function countsOf(tasks: readonly TihuTask[]): TaskBoardPayload['counts'] {
  let running = 0
  let awaiting = 0
  let queued = 0
  for (const task of tasks) {
    if (task.state === 'running') running += 1
    else if (task.state === 'awaiting') awaiting += 1
    else if (task.state === 'queued' || task.state === 'dispatched') queued += 1
  }
  return { running, awaiting, queued }
}

/** 新派一条任务的入参。 */
export interface NewTaskInput {
  title: string
  projectId: string
  projectName: string
  folder?: string
  preset?: string
  sessionIds?: string[]
  now?: number
}

/**
 * 登记簿本体。所有方法同步、无 IO；lane 只做「把事件翻译成这些调用」。
 */
export class TaskLedger {
  private readonly tasks = new Map<string, TihuTask>()
  private seq = 0
  /**
   * 归档行的落地口（lane 传「往 journal 追加一行」）。
   * 自动归档（prune）也走它：不然清掉老任务时那一行就悄悄丢了。
   * 注意：node 的 strip-only 模式不支持构造函数参数属性（`constructor(private x)`），
   * 所以这里显式声明字段 ＋ 赋值。
   */
  private readonly journal?: (line: string) => void

  constructor(journal?: (line: string) => void) {
    this.journal = journal
  }

  /** 新派（或追加）一条任务。返回登记簿里的这一条（同一对象，后续原地更新）。 */
  add(input: NewTaskInput): TihuTask {
    const now = input.now ?? Date.now()
    // 短号严格递增：撤单/归档也不回退（屏上截图对不上号最容易被当成 bug）。
    this.seq += 1
    const task: TihuTask = {
      taskId: `t${this.seq}`,
      title: taskTitleOf(input.title),
      projectId: input.projectId,
      projectName: input.projectName,
      sessionIds: [...(input.sessionIds ?? [])],
      preset: input.preset ?? 'standard',
      state: 'queued',
      step: 0,
      turn: 0,
      startedAt: now,
      updatedAt: now,
      summary: '',
      ...(input.folder === undefined || input.folder === '' ? {} : { folder: input.folder }),
    }
    this.tasks.set(task.taskId, task)
    this.prune()
    return task
  }

  get(taskId: string): TihuTask | undefined {
    return this.tasks.get(taskId)
  }

  /** 按会话反查任务（事件归一到任务要靠它）。 */
  ofSession(sessionId: string): TihuTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.state === 'archived') continue
      if (task.sessionIds.includes(sessionId)) return task
    }
    return undefined
  }

  /** 全部任务（含归档；棋盘投影自己会滤掉归档）。 */
  list(): TihuTask[] {
    return [...this.tasks.values()].sort((a, b) => Number(a.taskId.slice(1)) - Number(b.taskId.slice(1)))
  }

  size(): number {
    return this.tasks.size
  }

  /** 屏上当前这条（待决策/详情用）：优先未归档里最新动的。 */
  current(): TihuTask | undefined {
    let best: TihuTask | undefined
    for (const task of this.tasks.values()) {
      if (task.state === 'archived') continue
      if (best === undefined || task.updatedAt >= best.updatedAt) best = task
    }
    return best
  }

  /** 绑上承载会话（派单成功后调用）。 */
  attachSession(taskId: string, sessionId: string, now = Date.now()): TihuTask | undefined {
    const task = this.tasks.get(taskId)
    if (task === undefined) return undefined
    if (!task.sessionIds.includes(sessionId)) task.sessionIds.push(sessionId)
    // 七态第 2 态「派单」：会话已建、消息还没开跑；turn/start 才进执行中。
    if (task.state === 'queued') task.state = 'dispatched'
    task.startedAt = task.startedAt === 0 ? now : task.startedAt
    task.updatedAt = now
    return task
  }

  /** 会话开始跑（turn/start）：排队/派单/回答完 → 执行中。 */
  markRunning(taskId: string, now = Date.now()): TihuTask | undefined {
    const task = this.tasks.get(taskId)
    if (task === undefined) return undefined
    if (task.state === 'queued' || task.state === 'dispatched' || task.state === 'awaiting') {
      task.state = 'running'
      task.updatedAt = now
    }
    return task
  }

  /** 步数推进（tool/call）：只增不减；顺手记最近 8 步耗时给棋盘微条。 */
  noteStep(taskId: string, step: number, now = Date.now()): void {
    const task = this.tasks.get(taskId)
    if (task === undefined) return
    const next = Number.isFinite(step) ? Math.max(0, Math.trunc(step)) : task.step + 1
    if (next > task.step) {
      const from = task.lastStepAt ?? task.startedAt
      const elapsed = Math.max(0, now - from)
      task.stepDurations = [...(task.stepDurations ?? []), elapsed].slice(-8)
      task.lastStepAt = now
      task.step = next
    }
    task.updatedAt = now
  }

  /** 里程碑：任务行摘要更新（P2，可播但低优先）。 */
  noteMilestone(taskId: string, summary: string, now = Date.now()): void {
    const task = this.tasks.get(taskId)
    if (task === undefined) return
    const text = String(summary ?? '').trim()
    if (text === '') return
    task.summary = text
    task.updatedAt = now
  }

  /**
   * 要人（待决策／危险动作确认）：只有托管没点亮时才会走到这里。
   * `options` 与电脑端同序，`defaultIndex` ＝首选项。
   */
  ask(taskId: string, input: { question: string; options: string[]; defaultIndex?: number; timeoutMs: number; detail?: string; now?: number }): TihuTask | undefined {
    const task = this.tasks.get(taskId)
    if (task === undefined) return undefined
    const now = input.now ?? Date.now()
    task.state = 'awaiting'
    task.question = String(input.question ?? '').trim()
    const detail = String(input.detail ?? '').trim()
    if (detail !== '') task.detail = detail
    task.options = input.options.slice(0, 4)
    task.defaultIndex = Math.max(0, Math.min(input.defaultIndex ?? 0, task.options.length - 1))
    task.decisionDeadline = now + Math.max(0, input.timeoutMs)
    task.updatedAt = now
    return task
  }

  /** 人答了（点选项 / 口头 / 60 秒到点走默认）：回到执行中。 */
  answer(taskId: string, by: string, now = Date.now()): TihuTask | undefined {
    const task = this.tasks.get(taskId)
    if (task === undefined) return undefined
    if (task.state !== 'awaiting') return task
    task.state = 'running'
    task.answeredBy = by
    task.question = undefined
    task.detail = undefined
    task.options = undefined
    task.defaultIndex = undefined
    task.decisionDeadline = undefined
    task.updatedAt = now
    return task
  }

  /** 完成：写一行结果摘要（不是正文）。 */
  complete(taskId: string, input: { resultLine?: string; summary?: string; now?: number } = {}): TihuTask | undefined {
    const task = this.tasks.get(taskId)
    if (task === undefined) return undefined
    const now = input.now ?? Date.now()
    task.state = 'done'
    task.finishedAt = now
    task.updatedAt = now
    const line = String(input.resultLine ?? '').trim()
    if (line !== '') task.resultLine = line
    const summary = String(input.summary ?? line).trim()
    if (summary !== '') task.summary = summary
    task.question = undefined
    task.detail = undefined
    task.options = undefined
    task.decisionDeadline = undefined
    return task
  }

  /** 标记已播报（同一条不重复念）；七态第 6 态「已播报」。 */
  markSpoken(taskId: string, now = Date.now()): void {
    const task = this.tasks.get(taskId)
    if (task === undefined) return
    task.spokenAt = now
    if (task.state === 'done') task.state = 'announced'
  }

  /** 撤单：还没起跑的排队任务直接从棋盘拿掉（起跑过的要先停再撤，那是危险动作）。 */
  drop(taskId: string, now = Date.now()): TihuTask | undefined {
    const task = this.tasks.get(taskId)
    if (task === undefined) return undefined
    task.state = 'archived'
    task.archivedAt = now
    return task
  }

  /**
   * 归档：任务移出棋盘 ＋ 往 journal 追加一行摘要；**会话不删、文件夹不动**。
   * 返回需要写进 journal 的那一行（调用方只写一次，看 `task.journaled`）。
   */
  archive(taskId: string, now = Date.now()): string | undefined {
    const task = this.tasks.get(taskId)
    if (task === undefined) return undefined
    task.state = 'archived'
    task.archivedAt = task.archivedAt ?? now
    if (task.journaled === true) return undefined
    task.journaled = true
    return journalLineOf(task)
  }

  /** 内存上限：先归档最老的完成态，再归档最老的空闲任务（自动归档也落 journal 一行）。 */
  prune(now = Date.now()): void {
    const keep = (taskId: string): void => {
      const line = this.archive(taskId, now)
      if (line !== undefined) this.journal?.(line)
    }
    if (this.tasks.size <= LEDGER_MAX_TASKS) {
      for (const task of this.tasks.values()) {
        if (isFinishedState(task.state) && task.finishedAt !== undefined && now - task.finishedAt > DONE_KEEP_MS) keep(task.taskId)
      }
      return
    }
    const byAge = this.list().filter((task) => isFinishedState(task.state) || task.state === 'queued' || task.state === 'dispatched')
    while (this.tasks.size > LEDGER_MAX_TASKS && byAge.length > 0) {
      const oldest = byAge.shift()
      if (oldest !== undefined) keep(oldest.taskId)
    }
  }

  /** 清空（单测/换绑诊断用）。 */
  clear(): void {
    this.tasks.clear()
    this.seq = 0
  }
}

/** journal 一行：`- [t3] 标题 / 项目 / 会话 / 用时 / 结果 / 谁拍的板`。 */
export function journalLineOf(task: TihuTask, now = Date.now()): string {
  const end = task.finishedAt ?? task.archivedAt ?? now
  const used = Math.max(0, end - task.startedAt)
  const parts = [
    `[${task.taskId}] ${task.title}`,
    task.projectName || '未分项目',
    task.sessionIds.length === 0 ? '无会话' : task.sessionIds.map((id) => id.replace(/^session-/, '').slice(0, 8)).join('+'),
    `用时 ${formatUsedMs(used)}`,
    task.resultLine ?? (isFinishedState(task.state) ? '已完成' : '已归档'),
  ]
  if (task.answeredBy !== undefined) parts.push(task.answeredBy)
  return `- ${parts.join(' / ')}`
}

/** 用时：`45s` / `1m23s` / `2h05m`（与 progress.ts 的 formatElapsed 同口径，便于眼熟）。 */
export function formatUsedMs(ms: number): string {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/* ---------- 通知总线（优先级 ＋ 8 秒合并） ---------- */

/** 一条待播报。 */
export interface TihuAnnouncement {
  level: TaskNotifyLevel
  taskIds: string[]
  /** 合并后的那一句（可能压了多件事）。 */
  text: string
}

interface QueuedAnnouncement {
  level: TaskNotifyLevel
  taskId: string
  text: string
  at: number
}

/**
 * 播报队列。三条硬规则：
 *   1. **P0 插队**：要人的永远立刻念，不等窗口（漏掉一次确认比多打扰一次贵）；
 *   2. **P1/P2 合并**：8 秒窗口内攒下的多条压成一句「三件事完了：A、B、C」，只念一次；
 *   3. **P3 不播**：进度只在屏上。
 */
export class TaskNotifyBus {
  private readonly queue: QueuedAnnouncement[] = []

  push(level: TaskNotifyLevel, taskId: string, text: string, now = Date.now()): void {
    if (level === 3) return
    const value = String(text ?? '').trim()
    if (value === '') return
    this.queue.push({ level, taskId, text: value, at: now })
  }

  /** 还有几条等着念（回主页守门、测试都用它）。 */
  pending(): number {
    return this.queue.length
  }

  /**
   * 取一条现在该念的（没有就到点再来）。
   *   - 有 P0 → 立刻取这一条（其余留在队里）；
   *   - P1/P2 攒够 2 条且窗口到了 → 合并成一句；
   *   - 只有 1 条且过了单条延迟 → 立刻念。
   */
  take(now = Date.now()): TihuAnnouncement | undefined {
    if (this.queue.length === 0) return undefined
    const urgent = this.queue.findIndex((item) => item.level === 0)
    if (urgent >= 0) {
      const [item] = this.queue.splice(urgent, 1)
      return { level: 0, taskIds: [item.taskId], text: item.text }
    }
    const first = this.queue[0]
    const waited = now - first.at
    if (this.queue.length === 1) {
      if (waited < ANNOUNCE_SINGLE_DELAY_MS) return undefined
      const [item] = this.queue.splice(0, 1)
      return { level: item.level, taskIds: [item.taskId], text: item.text }
    }
    if (waited < ANNOUNCE_WINDOW_MS) return undefined
    const batch = this.queue.splice(0, this.queue.length)
    const level = Math.min(...batch.map((item) => item.level)) as TaskNotifyLevel
    return { level, taskIds: batch.map((item) => item.taskId), text: mergeAnnouncements(batch) }
  }

  /** 下次该来取的时刻（调用方据此挂定时器，不用轮询）。 */
  nextAt(): number | undefined {
    if (this.queue.length === 0) return undefined
    const urgent = this.queue.some((item) => item.level === 0)
    if (urgent) return Date.now()
    if (this.queue.length === 1) return this.queue[0].at + ANNOUNCE_SINGLE_DELAY_MS
    return this.queue[0].at + ANNOUNCE_WINDOW_MS
  }

  clear(): void {
    this.queue.length = 0
  }
}

/**
 * 多条播报压成一句。
 *   一条 → 原文；两条/三条 → 「三件事完了：A、B、C」；更多 → 只念前三件并说「等 N 件」。
 */
export function mergeAnnouncements(items: readonly { text: string; level: TaskNotifyLevel }[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0].text
  const texts = items.map((item) => String(item.text ?? '').trim()).filter((text) => text !== '')
  if (texts.length === 1) return texts[0]
  const allDone = items.every((item) => item.level === 1)
  const count = texts.length
  if (!allDone) return texts.join('；')
  const head = count >= 4 ? `${count} 件事完了` : `${['零', '一', '两', '三'][count]}件事完了`
  const shown = texts.slice(0, 3)
  const tail = count > 3 ? '等' : ''
  return `${head}：${shown.join('、')}${tail}`
}

/* ---------- 派单路由（快路径规则表，纯函数） ---------- */

/** 路由结果：派给某张卡／追加到已有任务／日常任务／歧义追问。 */
export type TaskRoute =
  | { kind: 'card'; card: TihuCardRow; matched: string }
  | { kind: 'append'; task: TihuTask }
  | { kind: 'daily' }
  | { kind: 'ambiguous'; candidates: TihuCardRow[] }
  | { kind: 'none' }

/** 设备屏上的轻命令（说一句就能用，不用点屏）。 */
export type ScreenCommand =
  | { kind: 'board' }
  | { kind: 'open'; index?: number; taskId?: string }
  | { kind: 'stop' }
  | { kind: 'cancel' }
  | { kind: 'confirm'; approved: boolean; optionIndex?: number }
  | { kind: 'pick'; index: number }

const COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; command: ScreenCommand }> = [
  { pattern: /^(?:回|去|看)?(?:任务)?(?:棋盘|主页|首页|看板)$/, command: { kind: 'board' } },
  { pattern: /^(?:回)(?:到)?(?:棋盘|主页|首页)$/, command: { kind: 'board' } },
  { pattern: /^(?:看|打开|进)(?:一下)?(?:任务|这条|第[一二三四五]条)/, command: { kind: 'open' } },
  { pattern: /^(?:停止|停下|别念了|别读了|停)$/, command: { kind: 'stop' } },
  { pattern: /^(?:撤单|撤销|取消这条|不做了)$/, command: { kind: 'cancel' } },
  { pattern: /^(?:确认|同意|可以|执行|确认删除|删吧|批准)$/, command: { kind: 'confirm', approved: true } },
  { pattern: /^(?:取消|不|别|留|先留|先留着|别删|不要)$/, command: { kind: 'confirm', approved: false } },
]

/** 中文数字 → 序号（1 起）。 */
export function chineseIndex(text: string): number | undefined {
  const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  const digits = raw.match(/^第?\s*(\d)\s*(?:条|个|号)?$/)
  if (digits !== null) return Number(digits[1])
  const cn = raw.match(/^第?\s*([一二三四五六七八九])\s*(?:条|个|号)?$/)
  if (cn !== null) return map[cn[1]]
  return undefined
}

/**
 * 句首唤醒词：「你好，鹈鹕」「嗨鹈鹕」「鹈鹕，」——设备级噪声，不是任务正文。
 *
 * 真机固件与浏览器的关键词聆听都会把唤醒词一起转写进来（2026-11-09 实测：
 * 「你好，鹈鹕回棋盘」没被当命令，反而作为一条任务派给了个人助手）。这里只剥
 * **句首**的唤醒词，正文里出现的「鹈鹕」一个字都不动。
 */
const WAKE_WORD_PREFIX = /^(?:你好|嗨|嘿|喂)?[，,、。．.！!？?～~\s]*鹈鹕[，,、。．.！!？?～~\s]*/

/** 去掉句首唤醒词；整句只有唤醒词时返回空串（上层当空话丢弃）。 */
export function stripWakeWord(text: string): string {
  const raw = String(text ?? '').trim()
  if (raw === '') return ''
  return raw.replace(WAKE_WORD_PREFIX, '').trim()
}

/**
 * 一句口头指令 → 屏上命令。返回 undefined 表示「不是命令，是任务」。
 *
 * 只认完整短句（`^…$`）：任务本身可能包含「取消」「确认」这些词（「确认一下这个基金的
 * 预算表」），用包含匹配就会把任务当成命令吞掉——那是比不识别更糟的错。
 *
 * 唤醒词先剥一层再判（「你好，鹈鹕回棋盘」＝「回棋盘」）；剥不出命令就按原文继续走路由，
 * 所以「鹈鹕是什么」这类正文不会被误吞。
 */
export function parseScreenCommand(text: string): ScreenCommand | undefined {
  const raw = String(text ?? '')
  const stripped = stripWakeWord(raw)
  const candidates = stripped !== '' && stripped !== raw.trim() ? [raw, stripped] : [raw]
  for (const candidate of candidates) {
    const command = commandOfText(candidate)
    if (command !== undefined) return command
  }
  return undefined
}

/** parseScreenCommand 的正文匹配（已剥过唤醒词的候选句）。 */
function commandOfText(text: string): ScreenCommand | undefined {
  const clean = String(text ?? '').replace(/[，,。！!？?\s]+/g, '')
  if (clean === '' || clean.length > 14) return undefined
  const index = chineseIndex(clean)
  if (index !== undefined) return { kind: 'pick', index }
  for (const item of COMMAND_PATTERNS) {
    if (item.pattern.test(clean)) return item.command
  }
  const openMatch = clean.match(/^(?:看|打开|进)(?:一下)?第([一二三四五\d])(?:条|个)$/)
  if (openMatch !== null) {
    const at = chineseIndex(openMatch[1])
    if (at !== undefined) return { kind: 'open', index: at }
  }
  return undefined
}

/** 「接着说同一件事」的开头词（追加到已有任务，不新建）。 */
const CONTINUATION = /^(?:接着|继续|再|还|然后|顺便|另外|补充|上一条|那个|这个)/

/** 明显要产出东西的动词（这类不是日常任务，不该落助手文件夹）。 */
const PRODUCE_VERBS = /(生成|写|做|改|画|整理|导出|翻译|跑|运行|部署|提交|分析|调研|排版|校对|建|搭|实现|修复|重构|安装|下载|爬|润色|打磨|精修|出图|存|保存|转换|转成|合并|拆分|替换)/

/**
 * 日常简单任务判定（落「个人助手」卡片）：**单步、问答、查一下、改一句**。
 *
 * 判据只有两条路，不做「猜复杂度」那种玄学：
 *   1. 疑问/只读式开头（与 `tihuVoiceAutoEligible` 的白名单同一套前缀）且没有产出动词；
 *   2. 很短（≤14 字）且没有产出动词 —— 一句家常话，不值得为它建项目卡。
 *
 * 反例守着设计里那格「复杂任务」：跨步骤、要产出文件、要跑很久的，一律**不是**日常，
 * 交给项目卡或慢路径（指挥会话的模型）去决定。宁可多问一句，也不把大活塞进助手文件夹。
 */
export function looksSimpleTask(text: string): boolean {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return false
  const chars = [...clean].length
  if (PRODUCE_VERBS.test(clean)) return false
  if (/^(?:请|帮我|麻烦)?(?:查看|看|读取|读|查询|查|搜索|总结|解释|翻译|列出|汇报|告诉|分析|什么|怎么|哪|现在|目前|几|谁)/.test(clean)) return true
  if (chars <= 40 && /[?？]$/.test(clean)) return true
  return chars <= 12
}

/** 文本与卡片名的匹配分：整名命中 100+，否则按最长公共片段给分（≥2 字才算）。 */
export function scoreCardAlias(text: string, card: TihuCardRow): { score: number; matched: string; via: 'name' | 'folder' | 'fragment' } {
  const haystack = normalizeAlias(text)
  if (haystack === '') return { score: 0, matched: '', via: 'fragment' }
  const names: { value: string; via: 'name' | 'folder' }[] = [
    { value: card.name, via: 'name' },
    ...(folderBase(card.folder) === '' ? [] : [{ value: folderBase(card.folder), via: 'folder' as const }]),
  ].filter((item) => normalizeAlias(item.value).length >= 2) as { value: string; via: 'name' | 'folder' }[]
  let best = 0
  let matched = ''
  let via: 'name' | 'folder' | 'fragment' = 'fragment'
  for (const item of names) {
    const name = normalizeAlias(item.value)
    if (haystack.includes(name)) {
      const score = 100 + [...name].length
      // 同分时保住「整名」：用户点名了卡片，不能被另一个卡的文件夹短名挤成歧义。
      if (score > best || (score === best && item.via === 'name')) {
        best = score
        matched = item.value
        via = item.via
      }
      continue
    }
    const common = longestCommonRun(haystack, name)
    if (common >= 2 && common * 10 > best) {
      best = common * 10
      matched = item.value
      via = 'fragment'
    }
  }
  return { score: best, matched, via }
}

function normalizeAlias(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，,。.!！?？:：、"'"'（）()\[\]【】《》\-_/\\]+/g, '')
}

function folderBase(folder: string | undefined): string {
  const parts = String(folder ?? '').split(/[\\/]+/).filter(Boolean)
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/** 最长公共子串长度（两组都很短：卡片名与一句话，动规够快）。 */
export function longestCommonRun(a: string, b: string): number {
  const left = [...a]
  const right = [...b]
  if (left.length === 0 || right.length === 0) return 0
  let best = 0
  let previous = new Array<number>(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array<number>(right.length + 1).fill(0)
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      }
    }
    previous = current
  }
  return best
}

/**
 * 快路径派单（零模型）：命中就用，不命中得 `{ kind: 'none' }`，由慢路径（指挥会话的模型）接手。
 *
 * 顺序即优先级，与设计 §6 一致：
 *   1. 点名了某张项目卡（整名命中）→ 派到那张卡；
 *   2. 「接着/继续/再…」且同项目有未完成任务 → 追加；
 *   3. 明显是日常小事 → 个人助手卡片；
 *   4. 只有一个像的候选（片段命中 ≥2 字）→ 派给它；
 *   5. 两个以上差不多像 → 追问（屏 7），绝不猜。
 */
export function routeQuick(input: {
  text: string
  cards: readonly TihuCardRow[]
  tasks: readonly TihuTask[]
  assistantCardId?: string
}): TaskRoute {
  const text = String(input.text ?? '').trim()
  if (text === '') return { kind: 'none' }
  const scored = input.cards
    .map((card) => ({ card, ...scoreCardAlias(text, card) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
  const exact = scored.filter((item) => item.score >= 100)
  // 整名命中优先于「文件夹短名」：`dsh-assistant` 里包含 `assistant`，旧实现会把
  // 个人助手（文件夹 ...\assistant）当成第二个整名，把真正点名的 HPG 挤掉。
  // 只要有一张卡是整名命中，就只在整名命中里判歧义；只有全是文件夹命中时才用文件夹。
  const namedExact = exact.filter((item) => item.via === 'name')
  const decisive = namedExact.length > 0 ? namedExact : exact
  // 两个卡名都整字出现：这句真的能派给两处，必须问（屏 7）。
  if (decisive.length > 1) return { kind: 'ambiguous', candidates: decisive.slice(0, 2).map((item) => item.card) }

  // 「接着 / 继续 / 再…」＝同一件事接着说：优先追加到点名那张卡的在办任务，
  // 没点名就追加到最近在办的那条（设计 §6 快路径第 2 条：上一条任务接续）。
  const activeOf = (projectId: string | undefined): TihuTask | undefined =>
    input.tasks
      .filter((task) => task.state === 'running' || task.state === 'awaiting' || task.state === 'queued' || task.state === 'dispatched')
      .filter((task) => projectId === undefined || task.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (decisive.length === 1) {
    const follow = CONTINUATION.test(text) ? activeOf(decisive[0].card.id) : undefined
    if (follow !== undefined) return { kind: 'append', task: follow }
    return { kind: 'card', card: decisive[0].card, matched: decisive[0].matched }
  }

  if (CONTINUATION.test(text)) {
    const follow = activeOf(undefined)
    if (follow !== undefined) return { kind: 'append', task: follow }
  }

  const best = scored[0]
  /**
   * 片段命中的门槛：≥3 个字（score ≥ 30）。
   *
   * 为什么把它排在「日常小事」**前面**：点名了项目比句子短是更强的信号——
   * 「青年基金第 4 段逻辑理顺」只有 12 个字，但它明确说了是哪个项目；
   * 先判日常就会把它扔进助手文件夹（这正是「错派」的来源）。
   */
  if (best !== undefined && best.score >= 30) {
    const close = scored.filter((item) => item.score * 100 >= best.score * 80)
    if (close.length > 1) return { kind: 'ambiguous', candidates: close.slice(0, 2).map((item) => item.card) }
    return { kind: 'card', card: best.card, matched: best.matched }
  }
  if (looksSimpleTask(text)) return { kind: 'daily' }
  if (best === undefined) return { kind: 'none' }
  // 只剩「2 个字撞上」的弱命中：同样先看有没有第二个候选，再落卡。
  const close = scored.filter((item) => item.score * 100 >= best.score * 80)
  if (close.length > 1) return { kind: 'ambiguous', candidates: close.slice(0, 2).map((item) => item.card) }
  return { kind: 'card', card: best.card, matched: best.matched }
}

/**
 * 文件夹兜底优先级（设计 §7 的「兜底」一格）：
 *   ① 卡片自己填的文件夹 → ② 模板最新步骤目录（调用方给）→ ③ 绑定会话 cwd → ④ 助手 home。
 * 纯函数只做「按顺序取第一个非空」，真正解析路径是 lane 的事。
 */
export function firstFolderOf(candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value !== '') return value
  }
  return undefined
}
