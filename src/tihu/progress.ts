/**
 * 鹈鹕（tihu）屏幕帧映射：把 `session/event` 序列翻译成 320×240 屏能看懂的
 * 「执行面板」（stage / 标题 / 2–3 行正文）+ 事件区用的细粒度 progress。
 *
 * 为什么单独成纯函数模块：
 *   - lane 只负责订阅与转发，映射规则可被 `scripts/test-tihu-protocol.mjs` 直接单测；
 *   - 屏幕只有 320×240（约每行 18 个汉字、最多 3 行正文），所有文案必须在这里
 *     统一截断（按 Unicode 码点，不会出现半个字/乱码）。
 *
 * 事件口径（取自 dsh-agent-loop 的 append）：
 *   turn/start {turn}
 *   step/start {turn, step}
 *   tool/call  {turn, step, callId, name, arguments}
 *   tool/result{turn, step, message:{content:[{type:'text',text}], isError}, error?}
 *   assistant/message {message.content}
 *   turn/end   {turn, reason:{kind}}
 */
import type { ProgressPayload, ScreenFramePayload } from './protocol.ts'
import { clipScreenText, CONTENT_WIDTH_PX, fitLine, SCREEN_SPEC, wrapTextPx } from './screen-spec.ts'

/** 屏幕阶段（固定这几类，别再加新词）。 */
export type TihuStage = '思考' | '读文件' | '跑命令' | '写文件' | '搜索' | '回答' | '等待确认'

/** 每行最多字符数（320×240、中文 16px）—— 与 screen-spec 同一事实来源。 */
export const TIHU_LINE_CHARS = SCREEN_SPEC.bodyCharsPerLine
/** 标题最多字符数。 */
export const TIHU_TITLE_CHARS = SCREEN_SPEC.titleChars
/** 事件区单行最多字符数。 */
export const TIHU_EVENT_CHARS = 120

/** 按 Unicode 码点截断，超长加省略号；不会切出半个字。 */
export function clipText(value: unknown, max: number): string {
  // 屏幕文本按像素宽度截断（304px），事件区仍按字符数（120）。
  if (max >= 40) return clipScreenText(value, max)
  const fontPx = max >= 20 ? SCREEN_SPEC.titleFontPx : SCREEN_SPEC.bodyFontPx
  return fitLine(value, CONTENT_WIDTH_PX, fontPx)
}

/** 屏幕上不显示 markdown 围栏/反引号等噪音（只影响屏幕摘要，事件区保留原文）。 */
export function sanitizeScreenLine(value: unknown): string {
  return String(value ?? '')
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*/, '')
    .replace(/```\s*$/, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/^[-*#>\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 秒数：`12s` / `1m05s`。 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** 工具参数有时是对象、有时是 JSON 字符串（不同宿主版本/序列化路径），两种都认。 */
function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return asRecord(JSON.parse(value)) } catch { return {} }
  }
  return asRecord(value)
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 路径取文件名（Windows / POSIX 都行）。 */
export function baseNameOf(path: string): string {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean)
  return parts.length === 0 ? String(path ?? '') : parts[parts.length - 1]
}

/** 一条工具调用 → 屏上的「动词 + 目标」+ 阶段 + 参数摘要。 */
export function describeTool(name: string, args: unknown): { stage: TihuStage; title: string; detail: string } {
  const tool = String(name ?? '').trim()
  const lower = tool.toLowerCase()
  const params = asRecord(args)
  const file = firstString(params, ['path', 'file_path', 'filePath', 'file', 'filename', 'target', 'target_file'])

  const matched = (list: readonly string[]): boolean => list.some((item) => lower === item || lower.includes(item))

  // 读文件
  if (matched(['read', 'read_file', 'readfile', 'view_file', 'cat', 'open_file'])) {
    return { stage: '读文件', title: clipText(`读取 ${baseNameOf(file) || '文件'}`, TIHU_TITLE_CHARS), detail: clipText(file, TIHU_EVENT_CHARS) }
  }
  // 写文件
  if (matched(['write', 'write_file', 'writefile', 'create_file', 'save_file'])) {
    return { stage: '写文件', title: clipText(`写入 ${baseNameOf(file) || '文件'}`, TIHU_TITLE_CHARS), detail: clipText(file, TIHU_EVENT_CHARS) }
  }
  // 改文件
  if (matched(['edit', 'apply_patch', 'str_replace', 'patch'])) {
    return { stage: '写文件', title: clipText(`修改 ${baseNameOf(file) || '文件'}`, TIHU_TITLE_CHARS), detail: clipText(file, TIHU_EVENT_CHARS) }
  }
  // 联网（要在「搜索」之前判断：web_search 也含 search）
  if (matched(['web_fetch', 'webfetch', 'web_search', 'websearch', 'fetch', 'browse'])) {
    const target = firstString(params, ['url', 'query', 'q', 'search', 'target'])
    return { stage: '搜索', title: clipText(`联网查 ${target || '资料'}`, TIHU_TITLE_CHARS), detail: clipText(target, TIHU_EVENT_CHARS) }
  }
  // 搜索
  if (matched(['grep', 'glob', 'search', 'find', 'select-string'])) {
    const keyword = firstString(params, ['pattern', 'query', 'q', 'glob', 'keyword'])
    return { stage: '搜索', title: clipText(`搜索 ${keyword || '内容'}`, TIHU_TITLE_CHARS), detail: clipText(keyword, TIHU_EVENT_CHARS) }
  }
  // 跑命令
  if (matched(['bash', 'pwsh', 'powershell', 'shell', 'terminal', 'exec', 'run_command', 'cmd'])) {
    const command = firstString(params, ['command', 'cmd', 'script', 'input'])
    return { stage: '跑命令', title: clipText(`执行 ${command.slice(0, 30)}`, TIHU_TITLE_CHARS), detail: clipText(command, TIHU_EVENT_CHARS) }
  }
  // 其它工具：直接显示工具名 + 主参数
  const detail = firstString(params, ['query', 'command', 'path', 'pattern', 'url', 'text', 'message', 'task', 'prompt', 'id'])
  return {
    stage: '思考',
    title: clipText(tool || '工具调用', TIHU_TITLE_CHARS),
    detail: clipText(detail, TIHU_EVENT_CHARS),
  }
}

/** 工具结果 → 「✓/✗ 摘要」+ 输出尾行（都 ≤18 字）。 */
export function summarizeToolResult(text: string, isError: boolean): { line: string; output: string } {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => sanitizeScreenLine(line)).filter(Boolean)
  const first = lines[0] ?? ''
  const last = lines.length > 0 ? lines[lines.length - 1] : ''
  const head = clipText(first, TIHU_LINE_CHARS - 2)
  const tail = clipText(last, TIHU_LINE_CHARS)
  if (isError) {
    return {
      line: clipText(`✗ ${head || '执行失败'}`, TIHU_LINE_CHARS),
      output: tail !== '' && tail !== head ? tail : '',
    }
  }
  return {
    line: clipText(`✓ ${head || '完成'}`, TIHU_LINE_CHARS),
    output: tail !== '' && tail !== head ? tail : '',
  }
}

/** 会话内累积的进度状态。 */
export interface TihuProgressState {
  turn: number
  step: number
  turnStartedAt: number
  lastResult?: { ok: boolean; line: string }
  lastOutput: string
  stage: TihuStage
  title: string
  tone: 'idle' | 'busy' | 'ok' | 'alert'
}

export function createProgressState(now = Date.now()): TihuProgressState {
  return { turn: 0, step: 0, turnStartedAt: now, lastResult: undefined, lastOutput: '', stage: '思考', title: '等待指令', tone: 'idle' }
}

export interface ProgressUpdate {
  screen?: ScreenFramePayload
  progress?: ProgressPayload
}

function bulletsOf(state: TihuProgressState, now: number): string[] {
  const lines = [`第 ${state.step} 步 · 已用 ${formatElapsed(now - state.turnStartedAt)}`]
  if (state.lastResult) lines.push(state.lastResult.line)
  if (state.lastOutput) lines.push(state.lastOutput)
  return lines.slice(0, SCREEN_SPEC.maxBodyLines).map((line) => clipText(line, TIHU_LINE_CHARS))
}

function messageText(message: unknown): string {
  const content = asRecord(message).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => asRecord(block).type === 'text')
    .map((block) => String(asRecord(block).text ?? ''))
    .join('\n')
    .trim()
}

/** 把一条 session 事件映射成屏帧/事件行；原地更新 state（便于 lane 按会话保存）。 */
export function applySessionEvent(state: TihuProgressState, event: unknown, now = Date.now()): ProgressUpdate {
  const record = asRecord(event)
  const type = String(record.type ?? '')
  const data = asRecord(record.data)

  if (type === 'turn/start') {
    const turn = Number.isFinite(data.turn) ? Number(data.turn) : state.turn + 1
    state.turn = turn
    state.step = 0
    state.turnStartedAt = now
    state.lastResult = undefined
    state.lastOutput = ''
    state.stage = '思考'
    state.title = '开始新一轮'
    state.tone = 'busy'
    return {
      screen: { stage: '思考', title: state.title, bullets: bulletsOf(state, now), tone: 'busy' },
      progress: { stage: 'turn', text: `开始第 ${turn} 轮` },
    }
  }

  if (type === 'step/start') {
    state.step = Number.isFinite(data.step) ? Number(data.step) : state.step + 1
    state.stage = '思考'
    state.title = '思考下一步'
    state.tone = 'busy'
    return {
      screen: { stage: '思考', title: state.title, bullets: bulletsOf(state, now), tone: 'busy' },
      progress: { stage: 'step', text: `第 ${state.step} 步` },
    }
  }

  if (type === 'tool/call') {
    const name = String(data.name ?? asRecord(data.call).name ?? '工具')
    const args = asArguments(data.arguments ?? asRecord(data.call).arguments)
    const action = describeTool(name, args)
    if (Number.isFinite(data.step)) state.step = Number(data.step)
    state.stage = action.stage
    state.title = action.title
    state.tone = 'busy'
    return {
      screen: { stage: action.stage, title: action.title, bullets: bulletsOf(state, now), tone: 'busy' },
      progress: {
        stage: 'tool',
        text: clipText(`${action.title}｜参数 ${action.detail || '（无）'}`, TIHU_EVENT_CHARS),
      },
    }
  }

  if (type === 'tool/result') {
    const message = asRecord(data.message)
    const text = messageText(message)
    const isError = message.isError === true || data.error !== undefined
    const summary = summarizeToolResult(text, isError)
    state.lastResult = { ok: !isError, line: summary.line }
    state.lastOutput = summary.output
    state.tone = isError ? 'alert' : 'ok'
    return {
      screen: { stage: state.stage, title: state.title, bullets: bulletsOf(state, now), tone: state.tone },
      progress: {
        stage: 'result',
        text: clipText(`${summary.line}｜${text || (isError ? '工具报错' : '（无输出）')}`, TIHU_EVENT_CHARS),
      },
    }
  }

  if (type === 'assistant/message') {
    const text = messageText(data.message)
    if (text === '') return {}
    const lines = text.split(/\r?\n/).map((line) => sanitizeScreenLine(line)).filter(Boolean)
    const firstLine = lines[0] ?? ''
    state.stage = '回答'
    state.title = clipText(`回答 ${firstLine}`, TIHU_TITLE_CHARS)
    state.lastResult = { ok: true, line: '✓ 已生成回复' }
    // 第 3 行保持「最近一条工具输出尾行」，不被回答正文覆盖（回答正文进事件区）。
    state.tone = 'ok'
    return {
      screen: { stage: '回答', title: state.title, bullets: bulletsOf(state, now), tone: 'ok' },
      progress: { stage: 'answer', text: clipText(text, TIHU_EVENT_CHARS) },
    }
  }

  if (type === 'turn/end') {
    const reason = String(asRecord(data.reason).kind ?? 'stop')
    // completed / stop 都算正常完成；error / aborted / cancelled 之类才算失败。
    const okReason = reason === 'completed' || reason === 'stop'
    const doneTitle = clipText(`完成 · 共 ${state.step} 步 · 用时 ${formatElapsed(now - state.turnStartedAt)}`, TIHU_TITLE_CHARS)
    state.stage = '回答'
    state.title = doneTitle
    state.tone = okReason ? 'ok' : 'alert'
    // 最终帧只留「结果」一行：不再重复标题（共 N 步/用时），也不再挂上一条命令的
    // stdout 尾行（2026-11-07 用户实测：完成帧出现了上一轮命令的陈旧输出）。
    const resultLine = okReason
      ? (state.lastResult?.ok === false ? state.lastResult.line : (state.lastResult?.line ?? '✓ 本轮完成'))
      : (state.lastResult?.ok === false ? state.lastResult.line : `✗ 本轮中断（${reason}）`)
    return {
      // 最终帧保留在屏上（不要立刻清成「本轮完成」）
      screen: {
        stage: '回答',
        title: doneTitle,
        bullets: [clipText(resultLine, TIHU_LINE_CHARS)],
        tone: state.tone,
      },
      progress: { stage: 'end', text: okReason ? '本轮完成' : `本轮结束（${reason}）` },
    }
  }

  return {}
}

/** 危险动作确认时的屏帧（stage 固定「等待确认」）。 */
export function confirmationFrame(title: string, detail: string): ScreenFramePayload {
  return {
    stage: '等待确认',
    title: clipText(`等待确认 ${title || '危险操作'}`, TIHU_TITLE_CHARS),
    bullets: [clipText(detail || '请确认是否执行', TIHU_LINE_CHARS), '在下方点确认或取消'],
    tone: 'alert',
  }
}
