/**
 * 任务登记簿 → 320×240 屏帧（纯函数）。
 *
 * 为什么单独一个文件：lane 里有 4000 行设备/朗读/闸门逻辑，屏版式再混进去就没人敢改文案了。
 * 这里只做「任务数据 → ScreenFramePayload」，文案纪律也在这里统一守：
 *   - **同一屏不重复同一事实**（标题说了「已派给 X」，正文就不再写一遍项目名）；
 *   - **状态必须有文字**（胶囊写「执行中」，不只靠颜色）；
 *   - **进度给精确值**（计时走文字，环只做辅助）；
 *   - **删解释性废话**（不写「不用按住」「16 kHz 单声道」这类技术参数）。
 *
 * 容量约束全部来自 screen-spec.ts：正文 4 行、每行约 18 字、标题 1 行、按钮行 32px。
 */
import type { ScreenFramePayload, TaskBoardPayload } from './protocol.ts'
import { clipScreenTitle, fitScreenLines, SCREEN_SPEC } from './screen-spec.ts'
import { capsuleOf, formatUsedMs, type TihuTask } from './task-ledger.ts'

/** 派单回执自动回棋盘的秒数（设计 §8.2：5 秒够看清落点，又不挡下一句）。 */
export const RECEIPT_SECONDS = 5
/** 待决策不答就按默认项走的秒数（与 confirmBroker 的 60 秒同口径）。 */
export const DECISION_SECONDS = 60

/** 任务棋盘（屏 1）；`empty` 时是同一个版式的空态，不另开一屏。 */
export function boardFrame(board: TaskBoardPayload): ScreenFramePayload {
  return {
    stage: '',
    title: '',
    bullets: [],
    tone: board.empty ? 'idle' : 'ok',
    mode: 'home',
    board,
  }
}

/** 派单回执（屏 2）。 */
export function receiptFrame(input: {
  taskId: string
  projectName: string
  folder?: string
  /** 前面还有几条在排队（0 表示马上就轮到你）。 */
  queueAhead: number
  /** 人类可读的预计开始时间，如「约 1 分钟」。 */
  etaText?: string
}): ScreenFramePayload {
  const ahead = Math.max(0, Math.trunc(input.queueAhead))
  const folderName = folderBase(input.folder)
  const bullets: string[] = []
  if (folderName !== '') bullets.push(`文件夹 ${folderName}`)
  bullets.push(ahead === 0 ? '马上开始跑' : input.etaText !== undefined && input.etaText !== '' ? `约 ${input.etaText} 后开始跑` : '等前面的跑完就轮到它')
  bullets.push(`${RECEIPT_SECONDS} 秒后自动回棋盘`)
  return {
    stage: '派单',
    title: clipScreenTitle(`已派给 ${input.projectName || '助手'}`),
    bullets: fitScreenLines(bullets, 3),
    steps: [
      { label: '已入队', state: 'done' },
      { label: ahead === 0 ? '轮到它' : `排队 ${ahead} 个`, state: ahead === 0 ? 'done' : 'active' },
      { label: '开始跑', state: ahead === 0 ? 'active' : 'pending' },
    ],
    countdown: { seconds: RECEIPT_SECONDS, totalSeconds: RECEIPT_SECONDS, text: '' },
    actions: [
      { id: 'taskOpen', label: '看任务' },
      { id: 'taskCancel', label: '撤单' },
    ],
    taskId: input.taskId,
    tone: 'busy',
    mode: 'status',
  }
}

/** 任务详情（屏 4）：正文口径完全照 progress.ts 的 statusFrame，不翻译、不加标签。 */
export function detailFrame(input: {
  taskId: string
  /** 工具阶段词（`跑命令` / `读文件` …）。 */
  stageWord: string
  step: number
  elapsedMs: number
  /** 最近两条「标签 · 明细」（与设备屏同一格式）。 */
  activity: readonly { label: string; detail: string }[]
  /** `82 tok/s · 12.3k tok · 上下文 41%`。 */
  statsLine: string
  projectName: string
  sessionTitle: string
}): ScreenFramePayload {
  const recent = input.activity.slice(-2).map((entry) => (entry.detail === '' ? entry.label : `${entry.label} · ${entry.detail}`))
  const stepLine = `第 ${input.step} 步 · 已用 ${formatUsedMs(input.elapsedMs)}`
  const bullets = [...recent, input.statsLine, `${input.projectName} · ${input.sessionTitle}`]
  return {
    stage: input.stageWord,
    title: clipScreenTitle(stepLine),
    bullets: fitScreenLines(bullets.filter((line) => line !== ''), SCREEN_SPEC.maxBodyLines),
    statsTail: 1,
    actions: [
      { id: 'taskSession', label: '看会话' },
      { id: 'taskStop', label: '停止' },
      { id: 'taskBoard', label: '回棋盘' },
    ],
    taskId: input.taskId,
    tone: 'busy',
    mode: 'status',
  }
}

/** 待决策（屏 5）：只有托管没点亮时才会出现；内容与电脑端同一个问题、同一组选项。 */
export function awaitingFrame(input: {
  taskId: string
  question: string
  options: readonly string[]
  defaultIndex: number
  projectName: string
  sessionTitle: string
  /** 危险动作的目标路径（没有就不占一行）。 */
  detail?: string
  secondsLeft: number
}): ScreenFramePayload {
  const options = input.options.length > 0 ? input.options : ['确认', '取消']
  const defaultIndex = Math.max(0, Math.min(input.defaultIndex, options.length - 1))
  const defaultLabel = options[defaultIndex]
  const seconds = Math.max(0, Math.trunc(input.secondsLeft))
  const bullets: string[] = [`${input.projectName} · ${input.sessionTitle}`]
  if (input.detail !== undefined && input.detail.trim() !== '') bullets.push(input.detail.trim())
  bullets.push(`${seconds} 秒不答，就按「${defaultLabel}」走`)
  bullets.push('说「确认」或「留着」也行')
  return {
    stage: '待决策 · 托管未开',
    title: clipScreenTitle(input.question || '要你定一下'),
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    countdown: { seconds, totalSeconds: DECISION_SECONDS, text: '' },
    actions: options.map((label, index) => ({
      id: `taskOption${index}`,
      // 默认项打标记：与托管开着时它的自动选择是同一条规则，两条路的结论一致。
      label: index === defaultIndex ? `${label}·默认` : label,
    })),
    taskId: input.taskId,
    tone: 'alert',
    mode: 'status',
  }
}

/** 完成播报（屏 6）：一行结果 ＋（可选）正文；其它完成收进 `more`（另有 N 条）。 */
export function doneFrame(input: {
  taskId: string
  resultLine: string
  /** 正文行（任务回复的要点；没有就只显示结果行）。 */
  bullets?: readonly string[]
  /** 同一批里其它已完成条数（>0 时右端显示「另有 N 条 ▸」）。 */
  others: number
}): ScreenFramePayload {
  const bullets = (input.bullets ?? []).filter((line) => String(line ?? '').trim() !== '')
  return {
    stage: '完成',
    title: clipScreenTitle(input.resultLine || '做完了'),
    bullets: fitScreenLines(bullets.length > 0 ? bullets : [input.resultLine || '做完了'], SCREEN_SPEC.maxBodyLines),
    ...(input.others > 0 ? { more: { count: input.others, text: `另有 ${input.others} 条` } } : {}),
    actions: [
      { id: 'stop', label: '停止' },
      { id: 'replay', label: '重读' },
      { id: 'taskBoard', label: '棋盘' },
    ],
    taskId: input.taskId,
    tone: 'ok',
    mode: 'status',
  }
}

/** 歧义追问（屏 7）：只问一次，两个候选 ＋「都不是」。 */
export function askWhichFrame(input: {
  candidates: readonly { projectName: string; doing: string }[]
  /** 记在哪条任务上（追问不落任务，用它回到同一条屏）。 */
  taskId?: string
}): ScreenFramePayload {
  const bullets = input.candidates.slice(0, 2).map((item, index) => {
    const doing = String(item.doing ?? '').trim()
    return doing === '' ? `${index + 1} ${item.projectName}` : `${index + 1} ${item.projectName} · ${doing}`
  })
  const actions = input.candidates.slice(0, 2).map((_item, index) => ({ id: `pick${index + 1}`, label: String(index + 1) }))
  actions.push({ id: 'pickNone', label: '都不是' })
  return {
    stage: '追问 · 只问一次',
    title: clipScreenTitle('这句话派给谁？'),
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    actions,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    tone: 'alert',
    mode: 'status',
  }
}

/** 一句提示屏（撤单、停止、归档这类轻动作的结果；不占棋盘也不进气泡）。 */
export function noticeFrame(input: { stage: string; title: string; lines?: readonly string[]; tone?: 'idle' | 'busy' | 'ok' | 'alert'; taskId?: string }): ScreenFramePayload {
  return {
    stage: input.stage,
    title: clipScreenTitle(input.title),
    bullets: fitScreenLines(input.lines ?? [], SCREEN_SPEC.maxBodyLines),
    tone: input.tone ?? 'idle',
    mode: 'status',
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  }
}

/**
 * 任务完成的一句话播报（**只念这一句**，正文不上耳朵）。
 * 用任务标题而不是会话标题：会话标题可能是「97b9a58b」，念出来毫无意义。
 */
export function doneAnnouncementOf(task: TihuTask): string {
  const title = task.title || '刚才那件事'
  const line = String(task.resultLine ?? '').replace(/\s+/g, ' ').trim()
  if (line === '') return `${title}，做完了`
  return `${title}——${line}`
}

/** 派单时念的一句（设计：派单不念，只有回执屏；保留这个函数给「看任务」的确认语）。 */
export function dispatchedAnnouncementOf(task: TihuTask): string {
  return `已派给${task.projectName || '助手'}：${task.title}`
}

/** 文件夹最后一级（屏上只放目录名，绝对路径放不下也没意义）。 */
export function folderBase(folder: string | undefined): string {
  const parts = String(folder ?? '').split(/[\\/]+/).filter(Boolean)
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/** 棋盘上「项目 · 第 N 步」的胶囊文案（供页面/测试复用，避免两处各写一遍）。 */
export function capsuleTextOf(task: TihuTask): string {
  return capsuleOf(task.state)
}
