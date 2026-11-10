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
import { CONTENT_WIDTH_PX, DONE_TITLE_FONT_PX, SCREEN_SPEC, TITLE_BOLD_FACTOR, clipScreenTitle, fitLine, fitScreenLines, wrapTextPx } from './screen-spec.ts'
import { splitReplySentences } from './reply.ts'
import { capsuleOf, formatUsedMs, type TihuTask } from './task-ledger.ts'

/** 派单回执自动回棋盘的秒数（设计 §8.2：5 秒够看清落点，又不挡下一句）。 */
export const RECEIPT_SECONDS = 5

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
  const folderName = shortFolderPath(input.folder)
  const bullets: string[] = []
  if (folderName !== '') bullets.push(`文件夹 ${folderName}`)
  bullets.push(input.etaText !== undefined && input.etaText !== '' ? `约 ${input.etaText}后开始跑` : '马上开始跑')
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

/** 完成屏正文：15px、左右各 8px 内边距后的可用宽（288px）。 */
export const DONE_BODY_FONT_PX = 15
export const DONE_BODY_TEXT_WIDTH_PX = CONTENT_WIDTH_PX - 16

/**
 * 回答正文开头的「状态勾」不是屏上内容：模型常把 ✅/✓/✔/☑ 当结论标记写在第一句前面，
 * 完成页上就成了青底行左边多一个勾形图标（2026-11-10 实机验收，参考图里没有）。
 * 只剥**行首**的勾＋其后的空白，正文里的勾（表格、清单）原样保留。
 */
const LEADING_STATUS_MARK = /^[\s\uFEFF]*(?:[\u2705\u2713\u2714\u2611\u2717\u274c]\uFE0F?\s*)+/u

/** 逐行剥掉行首的状态勾（完成页正文只留整行青底黑字）。 */
export function stripStatusMarks(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(LEADING_STATUS_MARK, ''))
    .join('\n')
}

/** 回答正文 → 完成屏的折行（按像素折，不切半个字；保留原句顺序）。 */
export function doneLinesOf(text: string): string[] {
  const clean = stripStatusMarks(String(text ?? '').replace(/\r\n?/g, '\n')).trim()
  if (clean === '') return []
  const lines: string[] = []
  for (const sentence of splitReplySentences(clean)) {
    for (const line of wrapTextPx(sentence.text, DONE_BODY_TEXT_WIDTH_PX, DONE_BODY_FONT_PX)) {
      if (line.trim() !== '') lines.push(line)
    }
  }
  return lines
}

/**
 * 任务进度（屏 4）：**实时**一屏——标题是任务名，正文只有「最新一条状态 + 第 N 步/已用 + tokens」。
 * 最新状态行由宿主按事件重算（applySessionEvent 的 lastEventLine），页面不做翻译。
 */
export function detailFrame(input: {
  taskId: string
  /** 会话标题／任务标题（一行，超长省略）。 */
  title: string
  /** 最新一条状态（思考 · … / 工具调用 · … / 回复 · …，原样）。 */
  liveLine?: string
  step: number
  elapsedMs: number
  /** `82 tok/s · 12.3k tok · 上下文 41%`。 */
  statsLine: string
}): ScreenFramePayload {
  const liveLine = fitLine(input.liveLine || '思考 · 模型推理中…', CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)
  const stepLine = fitLine(`第 ${input.step} 步 · 已用 ${formatUsedMs(input.elapsedMs)}`, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)
  const statsLine = fitLine(input.statsLine === '' ? '统计中…' : input.statsLine, CONTENT_WIDTH_PX, SCREEN_SPEC.statsFontPx)
  return {
    stage: '进度',
    title: clipScreenTitle(input.title === '' ? '任务进度' : input.title),
    bullets: [liveLine, stepLine, statsLine].filter((line) => line !== ''),
    statsTail: 1,
    actions: [
      { id: 'taskStop', label: '停止' },
      { id: 'taskBoard', label: '主页' },
    ],
    taskId: input.taskId,
    tone: 'busy',
    mode: 'status',
  }
}

/**
 * 完成页（屏 6）：**大标题是任务/会话标题**（不是回答第一句），下面是回答摘要
 * 7 行窗口（当前朗读行反白），状态行给「完成 · N/M」与「另有 N 条」。
 */
export function doneFrame(input: {
  taskId: string
  /** 会话标题／任务标题（一行大字，超长省略）。 */
  title: string
  /** 一句话结果（播报与回退正文用，不再是屏上大标题）。 */
  resultLine: string
  /** 完整回答正文：完成屏 7 行正文从它折行。 */
  replyText?: string
  /** 回退正文（没有完整回答时用 resultLine）。 */
  bullets?: readonly string[]
  /** 同一批里其它已完成条数（>0 时顶栏右端「另有 N 条」）。 */
  others?: number
}): ScreenFramePayload {
  const body = String(input.replyText ?? '').trim() !== ''
    ? String(input.replyText)
    : ((input.bullets ?? []).join(' ').trim() !== '' ? (input.bullets ?? []).join('\n') : input.resultLine)
  const lines = doneLinesOf(body)
  const fallback = doneLinesOf(input.resultLine)
  const rawTitle = input.title === '' ? '任务完成' : input.title
  return {
    stage: '完成',
    // 大标题是 20px 加粗（比状态屏标题 18px 大）：按 20px×加粗系数量宽裁一次，
    // 屏幕上的 CSS 省略号只当兜底——宿主先裁，才不会出现「字被浏览器切一半」。
    title: fitLine(rawTitle, CONTENT_WIDTH_PX, DONE_TITLE_FONT_PX * TITLE_BOLD_FACTOR),
    bullets: fitScreenLines([stripStatusMarks(input.resultLine || '做完了')], SCREEN_SPEC.maxBodyLines),
    done: { lines: lines.length > 0 ? lines : fallback, current: 0 },
    ...(input.others !== undefined && input.others > 0 ? { more: { count: input.others, text: `另有 ${input.others} 条` } } : {}),
    actions: [
      { id: 'stop', label: '停止' },
      { id: 'replay', label: '重读' },
      { id: 'taskBoard', label: '主页' },
    ],
    taskId: input.taskId,
    tone: 'ok',
    mode: 'status',
  }
}

/**
 * 待决策页（屏 5）：问题一行大字，最多两个选项 + 主页；到点回棋盘（不替用户选）。
 * 选项 id 与歧义追问（pick1/pick2）分开：这里答的是**已经派出去的那条任务**。
 */
export function decisionFrame(input: {
  taskId: string
  title?: string
  question?: string
  detail?: string
  options: readonly string[]
  defaultIndex?: number
  seconds: number
}): ScreenFramePayload {
  const options = input.options.filter((option) => String(option ?? '').trim() !== '')
  const defaultLabel = options[input.defaultIndex ?? 0] ?? options[0] ?? ''
  const bullets: string[] = []
  const detail = String(input.detail ?? '').replace(/\s+/g, ' ').trim()
  if (detail !== '') bullets.push(detail)
  if (defaultLabel !== '') bullets.push(`不选就按「${defaultLabel}」`)
  const actions = options.slice(0, 2).map((label, index) => ({ id: `taskAnswer${index + 1}`, label }))
  actions.push({ id: 'taskBoard', label: '主页' })
  return {
    stage: '待决策',
    title: clipScreenTitle(input.question || input.title || '要你定一下'),
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    countdown: { seconds: Math.max(1, Math.trunc(input.seconds)), totalSeconds: Math.max(1, Math.trunc(input.seconds)), text: '' },
    actions,
    taskId: input.taskId,
    tone: 'warn',
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
    stage: '追问',
    title: clipScreenTitle('这句话派给谁？'),
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    ask: {
      candidates: input.candidates.slice(0, 2).map((item, index) => ({
        index: index + 1,
        projectName: item.projectName,
        source: String(item.doing ?? '').trim(),
      })),
    },
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

/**
 * 屏上文件夹路径：保留地址首尾（盘符/根 + 末级目录），中间用「…」。
 * 例：`C:\Users\me\.dsh\assistant` → `C:\…\assistant`。
 */
export function shortFolderPath(folder: string | undefined): string {
  const raw = String(folder ?? '')
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length <= 2) return raw
  const last = [...parts[parts.length - 1]].slice(-10).join('')
  const sep = raw.includes('\\') ? '\\' : '/'
  return `${parts[0]}${sep}…${sep}${last}`
}

/** 棋盘上「项目 · 第 N 步」的胶囊文案（供页面/测试复用，避免两处各写一遍）。 */
export function capsuleTextOf(task: TihuTask): string {
  return capsuleOf(task.state)
}
