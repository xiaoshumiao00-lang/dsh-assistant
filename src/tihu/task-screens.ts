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
import { CONTENT_WIDTH_PX, DONE_TITLE_FONT_PX, SCREEN_SPEC, TEXT_WRAP_SAFETY_PX, TITLE_BOLD_FACTOR, clipScreenTitle, fitLine, fitScreenLines, measureTextPx, wrapTextPx } from './screen-spec.ts'
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
  /** 额外一句短提示（例如「指挥台没接住，先派给个人助手」）。 */
  note?: string
}): ScreenFramePayload {
  const ahead = Math.max(0, Math.trunc(input.queueAhead))
  const folderName = shortFolderPath(input.folder)
  const bullets: string[] = []
  if (input.note !== undefined && input.note.trim() !== '') bullets.push(input.note.trim())
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
 * 取不到助手回复时的完成页正文。
 *
 * 为什么不是任务标题：2026-11-10 实机核对发现，电脑端 CU 会话的 `doneText` 为空时
 * 旧实现拿 `task.title` 兜底，屏上就成了「大标题 + 同一条标题的截断版」——等于用标题
 * 冒充正文。宁可明确写「没有文字回复」，也不能把人骗过去。
 */
export const DONE_NO_REPLY_TEXT = '（没有文字回复）'

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

/** 完成页单条路径的最大字符数（码点）：超过就缩写，缩写结果也不超过它。 */
export const DONE_PATH_MAX_CHARS = 40

/** 行首无序列表符（`- ` / `* ` / `+ `）；必须带空白，避免误伤 `-0.12`、`a-b`。 */
const LEADING_LIST_MARK = /^\s{0,3}[-*+]\s+/
/** 行首标题（`#`～`######`，可无空格）；只剥行首，正文中间的 `#` 不动。 */
const LEADING_HEADING_MARK = /^\s{0,3}#{1,6}\s*/
/** 整行分隔线（`---` / `***` / `___`）。 */
const THEMATIC_BREAK = /^\s*([-*_])\1{2,}\s*$/
/** 行首引用符 `> `。 */
const LEADING_QUOTE_MARK = /^\s{0,3}>\s?/

/**
 * 逐行清掉残留在完成页正文里的 markdown 记号：`**`、`` ` ``、行首 `#`、
 * `- `／`* `／`+ ` 列表符，以及分隔线和引用符。保留换行（分句/折行都按它排）。
 *
 * 为什么放在宿主：2026-11-10 实机看到正文里还有「**粗体**」「`路径`」「- 项」，
 * 屏上既不好看、朗读还会把星号/反引号念出来。正文和 TTS 共用这一份文本，清一次就够。
 */
export function stripMarkdownMarks(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      // 围栏代码块整行（``` / ```json）直接丢掉：语言名不念、也不占正文行。
      if (/^\s*```/.test(line)) return ''
      let out = line
        .replace(LEADING_HEADING_MARK, '')
        .replace(LEADING_LIST_MARK, '')
        .replace(LEADING_QUOTE_MARK, '')
      if (THEMATIC_BREAK.test(out)) return ''
      // 行内记号：粗体星号与反引号。占位符清掉后正文照常念。
      out = out.replace(/\*\*/g, '').replace(/`/g, '')
      return out
    })
    .join('\n')
}

/** 绝对路径（盘符 / UNC / POSIX）；只用来判断代码段里那串东西是不是路径。 */
function looksLikeAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]/.test(value) || /^\/(?:[^/\s]+\/)+/.test(value)
}

/**
 * 文件名仍然超过上限时，保留首尾、把中间折成省略号，并优先保住扩展名。
 * 例：`ICACHE2026_GNN_dPINN_20261108_191807_native_charts_tables.pptx`
 *   → `ICACHE2026_GNN…_charts_tables.pptx`。
 */
function shrinkFileName(name: string, maxChars: number): string {
  const chars = [...name]
  if (chars.length <= maxChars) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 9 ? name.slice(dot) : ''
  const extChars = [...ext]
  const stem = ext === '' ? chars : chars.slice(0, chars.length - extChars.length)
  const budget = maxChars - 1 - extChars.length
  if (budget <= 4) return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
  const headLen = Math.max(1, Math.floor(budget / 2))
  const tailLen = Math.max(1, budget - headLen)
  const head = stem.slice(0, headLen)
  while (head.length > 1 && ['_', '-', '.', ' '].includes(head[head.length - 1])) head.pop()
  // 尾部尽量从分隔符（_ - . 空格）开始：`…e_charts_tables.pptx` 比 `…_charts_tables.pptx`
  // 多一个半个词的字母，读起来更别扭。
  let tail = stem.slice(stem.length - tailLen)
  const cut = tail.findIndex((char) => char === '_' || char === '-' || char === '.' || char === ' ')
  if (cut > 0 && tail.length - cut >= 6) tail = tail.slice(cut)
  return `${head.join('')}…${tail.join('')}${ext}`
}

/** 15px 正文一行能放下的宽度（与 wrapTextPx 一样扣掉安全边距）。 */
const PATH_LINE_WIDTH_PX = DONE_BODY_TEXT_WIDTH_PX - TEXT_WRAP_SAFETY_PX

/**
 * 长路径缩写：只留「盘符/首段 + … + 文件名」；文件名本身还超长就再折文件名。
 *
 *   D:\陈潘HBEU\Desktop\…\exports\ICACHE2026_GNN_dPINN_…_tables.pptx
 *     → ICACHE2026_GNN…_charts_tables.pptx
 *
 * 上限是**字符**（码点）而不是字节，40 是硬上限；此外再按 15px 正文实测宽度收紧，
 * 保证整条路径不会被折行切成两段（2026-11-10 实渲染：40 字符的大写文件名宽 328px，
 * 一折就把 `.pptx` 切到下一行，等于白缩写）。短且一行放得下的路径原样返回。
 */
export function abbreviatePath(path: string, maxChars: number = DONE_PATH_MAX_CHARS): string {
  const raw = String(path ?? '').trim()
  if (raw === '') return ''
  const fitsLine = (value: string): boolean => measureTextPx(value, DONE_BODY_FONT_PX) <= PATH_LINE_WIDTH_PX
  if ([...raw].length <= maxChars && fitsLine(raw)) return raw
  const sep = raw.includes('\\') ? '\\' : '/'
  const unc = /^\\\\[^\\/]/.test(raw)
  const posix = !unc && !/^[A-Za-z]:[\\/]/.test(raw) && raw.startsWith('/')
  const parts = raw.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length < 2) return shrinkFileName(raw, maxChars)
  const head = unc
    ? `\\\\${parts[0]}`
    : (posix ? `${sep}${parts[0]}` : parts[0])
  const base = parts[parts.length - 1]
  const withHead = `${head}${sep}…${sep}${base}`
  // 盘符 + 文件名已经够短就用它；不够短就只留文件名（再不够就折文件名本身）。
  const candidate = [...withHead].length <= maxChars ? withHead : base
  if (fitsLine(candidate)) return candidate
  if (fitsLine(base)) return base
  // 逐字符收紧到「一行放得下」为止（仍不超过 40 字符硬上限）。
  for (let limit = Math.min(maxChars, [...base].length) - 1; limit >= 8; limit -= 1) {
    const shrunk = shrinkFileName(base, limit)
    if (fitsLine(shrunk)) return shrunk
  }
  return shrinkFileName(base, 8)
}

/** 裸路径 token（不含空白）：Windows 盘符/UNC + POSIX（URL 里的 `/` 由 lookbehind 排除）。 */
const WINDOWS_PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'`<>|?*，。；！？、）】》」』,;]+/g
const POSIX_PATH_TOKEN = /(?<![\w:.\/-])\/(?:[^\s/]+\/)+[^\s"'`<>|?*，。；！？、）】》」』,;]+/g
/** 反引号包着的路径（允许空格），先按代码段边界缩写，再统一清反引号。 */
const BACKTICKED_PATH = /`([^`\n]+)`/g

/** 文本里的长路径统一缩写（裸 token + 反引号包着的带空格路径）。 */
export function abbreviateLongPaths(text: string, maxChars: number = DONE_PATH_MAX_CHARS): string {
  const shorten = (token: string): string => abbreviatePath(token, maxChars)
  const coded = String(text ?? '').replace(BACKTICKED_PATH, (whole, inner: string) => {
    const value = inner.trim()
    return looksLikeAbsolutePath(value) ? abbreviatePath(value, maxChars) : whole
  })
  return coded
    .replace(WINDOWS_PATH_TOKEN, (token: string) => shorten(token))
    .replace(POSIX_PATH_TOKEN, (token: string) => shorten(token))
}

/**
 * 完成页朗读用的规范文本：换行统一、清 markdown 记号、去行首状态勾、长路径缩写、去首尾空白。
 * 折行（{@link doneLinesOf}）、字符区间（{@link doneLineRangesOf}）和
 * 宿主下发 TTS 的 `charStart/charEnd` **必须都基于这一份文本**，否则高亮会和声音错位。
 *
 * 顺序有讲究：先缩写路径（反引号里的路径允许带空格，必须在清反引号之前处理），
 * 再清 markdown（`- ✅ 完成` 要先把列表符拿掉，状态勾才露在行首）。
 */
export function prepareDoneText(text: unknown): string {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const withoutMarkdown = stripMarkdownMarks(abbreviateLongPaths(normalized))
  return stripStatusMarks(withoutMarkdown).trim()
}

/** 回答正文 → 完成屏的折行（按像素折，不切半个字；保留原句顺序）。 */
export function doneLinesOf(text: string): string[] {
  const clean = prepareDoneText(text)
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
 * 每一行正文在朗读文本里的字符区间 `[start, end)`（码点下标）。
 *
 * 这是「高亮严格跟随真实播放」的桥：宿主把每段 PCM 的 `charStart/charEnd` 一起下发，
 * 页面按 AudioContext 里那段 PCM 的实际起止时间（`source.start(at)` + buffer 时长）
 * 换算成当前字符位置，再落到对应的行——不再用固定 1.8 秒计时推进。
 * 区间和 {@link doneLinesOf} 的行一一对应、互不重叠、随文本单调递增。
 */
export function doneLineRangesOf(text: string): Array<[number, number]> {
  const clean = prepareDoneText(text)
  if (clean === '') return []
  const ranges: Array<[number, number]> = []
  for (const sentence of splitReplySentences(clean)) {
    // splitReplySentences 的下标是码点下标，从句子起点开始逐行累加（行文本已被 trim，
    // 折行只会丢掉空白，因此累加长度就是下一行的起点）。
    let cursor = sentence.start
    for (const line of wrapTextPx(sentence.text, DONE_BODY_TEXT_WIDTH_PX, DONE_BODY_FONT_PX)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const length = [...trimmed].length
      ranges.push([cursor, cursor + length])
      cursor += length
    }
  }
  return ranges
}

/** 完成页朗读一段的最大字符数（码点）：一段可以合并若干**整行**，但不超过这个长度。 */
export const DONE_SPEECH_MAX_CHARS = 80

/** 完成页朗读的一段：覆盖一到若干整行，坐标与 {@link doneLineRangesOf} 完全一致。 */
export interface DoneSpeechSegment {
  index: number
  /** 朗读文本里的码点区间起点（= 该段第一行在正文里的起点）。 */
  start: number
  /** 码点区间终点（不含）。 */
  end: number
  /** 这一段覆盖的第一屏行下标（页面高亮从这里开始）。 */
  firstLine: number
  /** 这一段覆盖的最后一屏行下标。 */
  lastLine: number
  /** 送 TTS 的文本（正文里的码点切片，含段间空白）。 */
  text: string
}

/**
 * 完成页**朗读分段**：和屏上折行、和 `done.ranges` 共用同一份文本、同一坐标系。
 *
 * 为什么按「整行」切：屏上 7 行窗口一行一行地念，高亮也一行一行地走 —— 分段边界就是
 * 行边界（`charStart/charEnd` 必定落在某条 `done.ranges` 的起点/终点），页面不需要
 * 再做任何按时间/按比例的行内推算，也就不会出现「念一行、跳四行」。
 * 首段只装第一行：完成屏出帧后第一段最早就开口（原来 20 字首段是为了抢首包，
 * 但它把一行正文从中间腰斩，高亮和声音就对不齐）。
 * 合并上限 `DONE_SPEECH_MAX_CHARS`（80 字）保持原样：一段一次合成，段间不必再等首包。
 */
export function doneSpeechSegmentsOf(text: string, maxChars: number = DONE_SPEECH_MAX_CHARS): DoneSpeechSegment[] {
  const clean = prepareDoneText(text)
  const ranges = doneLineRangesOf(clean)
  if (ranges.length === 0) return []
  const chars = [...clean]
  const out: DoneSpeechSegment[] = []
  let index = 0
  let line = 0
  while (line < ranges.length) {
    const start = ranges[line][0]
    let last = line
    if (index !== 0) {
      // 后面的段：能装下几整行就装几整行（首段只装一行，见上面的注释）。
      while (last + 1 < ranges.length && (ranges[last + 1][1] - start) <= maxChars) last += 1
    }
    const end = ranges[last][1]
    out.push({ index, start, end, firstLine: line, lastLine: last, text: chars.slice(start, end).join('') })
    index += 1
    line = last + 1
  }
  return out
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
  /**
   * 这一轮已经结束（turn/end / 任务完成）：步数行改「第 N 步 · 已结束」。
   * 用户 2026-11-10 实机：结束之后「已用 3m28s」还在按 now 长，必须停住并显式标结束。
   */
  ended?: boolean
}): ScreenFramePayload {
  const ended = input.ended === true
  const liveLine = fitLine(input.liveLine || (ended ? '已结束 · 本轮没有新状态' : '思考 · 模型推理中…'), CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)
  const stepLine = fitLine(ended
    ? `第 ${input.step} 步 · 已结束`
    : `第 ${input.step} 步 · 已用 ${formatUsedMs(input.elapsedMs)}`, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)
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
    tone: ended ? 'ok' : 'busy',
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
    : ((input.bullets ?? []).join(' ').trim() !== '' ? (input.bullets ?? []).join('\n') : (input.resultLine || DONE_NO_REPLY_TEXT))
  const lines = doneLinesOf(body)
  const fallback = doneLinesOf(input.resultLine)
  const shown = lines.length > 0 ? lines : fallback
  // 行字符区间要和**下发给 TTS 的那段文本**同一坐标系：这里和折行都用 body 走同一份
  // prepareDoneText，宿主朗读时也念这一份（见 lane 的 doneBodyTextOf）。
  const ranges = lines.length > 0 ? doneLineRangesOf(body) : []
  const rawTitle = input.title === '' ? '任务完成' : input.title
  return {
    stage: '完成',
    // 大标题是 20px 加粗（比状态屏标题 18px 大）：按 20px×加粗系数量宽裁一次，
    // 屏幕上的 CSS 省略号只当兜底——宿主先裁，才不会出现「字被浏览器切一半」。
    title: fitLine(rawTitle, CONTENT_WIDTH_PX, DONE_TITLE_FONT_PX * TITLE_BOLD_FACTOR),
    bullets: fitScreenLines([stripStatusMarks(input.resultLine || '做完了')], SCREEN_SPEC.maxBodyLines),
    done: {
      lines: shown,
      current: 0,
      ...(ranges.length === shown.length ? { ranges } : {}),
    },
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

/**
 * 会话衔接澄清（只问一次）：灰区且指挥台也给不出结论时，屏上问「新建，还是接着刚才那条」。
 *
 * 两个选项固定为「1 新建 / 2 接着<那条会话>」：用户点按钮或说「一/二」都走同一条路。
 * 超时（lane 的计时器）按「新建」走，所以这里不设倒计时数字，避免屏上读秒与实际动作不一致。
 */
export function clarifySessionFrame(input: {
  /** 候选会话名（没有就写「刚才那条」）。 */
  sessionTitle?: string
  taskId?: string
}): ScreenFramePayload {
  const title = clipScreenTitle('新建，还是接着刚才那条？')
  // 会话名截到 8 个字：屏上一行放得下，且不会把「接着「…」」折成两行。
  const rawLabel = String(input.sessionTitle ?? '').trim() || '刚才那条'
  const labelChars = [...rawLabel]
  const sessionLabel = labelChars.length > 8 ? `${labelChars.slice(0, 7).join('')}…` : rawLabel
  const bullets = ['1 新建一条独立会话', `2 接着「${sessionLabel}」`]
  return {
    stage: '澄清',
    title,
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    ask: {
      candidates: [
        { index: 1, projectName: '新建会话', source: '' },
        { index: 2, projectName: `接着「${sessionLabel}」`, source: '' },
      ],
    },
    actions: [{ id: 'pick1', label: '新建' }, { id: 'pick2', label: '接着' }],
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
  // 同一套清理：播报也可能念到第一句里的长路径/markdown，不能因为走的是通知通道就漏掉。
  const line = prepareDoneText(task.resultLine).replace(/\s+/g, ' ').trim()
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
