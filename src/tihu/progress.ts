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
/** 动作翻译表：工具名 → { stage, title }（标题绝不裸显英文工具名）。 */
const TOOL_ACTIONS: Record<string, { stage: TihuStage; title: string }> = {
  screenshot: { stage: '搜索', title: '截图' },
  wait: { stage: '等待确认', title: '等待' },
  long_wait: { stage: '等待确认', title: '长等待' },
  click: { stage: '跑命令', title: '点击' },
  hotkey: { stage: '跑命令', title: '按键' },
  scroll: { stage: '跑命令', title: '滚动' },
  drag: { stage: '跑命令', title: '拖拽' },
  input_text: { stage: '写文件', title: '输入文字' },
  open_in_browser: { stage: '搜索', title: '打开网页' },
  open_in_finder: { stage: '读文件', title: '打开文件/目录' },
  open_app: { stage: '跑命令', title: '打开应用' },
  list_apps: { stage: '搜索', title: '列出应用' },
  code_agent: { stage: '思考', title: '派发后台任务' },
  ask_user_question: { stage: '等待确认', title: '等待确认' },
  skill: { stage: '思考', title: '加载技能' },
  present: { stage: '回答', title: '展示结果' },
  working_directory: { stage: '读文件', title: '切换目录' },
  web_search: { stage: '搜索', title: '搜索' },
  web_fetch: { stage: '搜索', title: '抓取网页' },
}

function describeToolAction(lower: string): { stage: TihuStage; title: string } | undefined {
  if (TOOL_ACTIONS[lower] !== undefined) return TOOL_ACTIONS[lower]
  if (lower.startsWith('mnemon_')) return { stage: '思考', title: '记忆操作' }
  return undefined
}

export function describeTool(name: string, args: unknown): { stage: TihuStage; title: string; detail: string } {
  const tool = String(name ?? '').trim()
  const lower = tool.toLowerCase()
  const params = asRecord(args)
  const file = firstString(params, ['path', 'file_path', 'filePath', 'file', 'filename', 'target', 'target_file'])
  const action = describeToolAction(lower)
  if (action !== undefined) {
    const detail = firstString(params, ['query', 'command', 'path', 'pattern', 'url', 'text', 'message', 'task', 'prompt', 'id'])
    return { stage: action.stage, title: clipText(action.title, TIHU_TITLE_CHARS), detail: clipText(detail, TIHU_EVENT_CHARS) }
  }

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
    title: clipText(`执行 ${tool || '未知工具'}`, TIHU_TITLE_CHARS),
    detail: clipText(detail, TIHU_EVENT_CHARS),
  }
}

/** 原始报错 → 一句人话（屏上一行放得下）。 */
export function humanizeError(text: string): string {
  const raw = String(text ?? '')
  if (/ENOENT|not recognized|not found|找不到|no such file/i.test(raw)) return '命令没找到'
  if (/EACCES|EPERM|denied|拒绝访问|permission/i.test(raw)) return '没有权限'
  if (/ETIMEDOUT|timed out|timeout|超时/i.test(raw)) return '超时了'
  if (/ECONNREFUSED|ECONNRESET|connect|socket|fetch failed/i.test(raw)) return '连不上'
  if (/spawn/i.test(raw)) return '程序没跑起来'
  return '执行出错'
}

/** 工具结果 → 「✓/✗ 摘要」+ 输出尾行（都 ≤18 字）。 */
export function summarizeToolResult(text: string, isError: boolean): { line: string; output: string } {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => sanitizeScreenLine(line)).filter((line) => {
    if (line === '') return false
    if (/^<[^>\s]+\/?>/.test(line)) return false
    if (/^\[image omitted/i.test(line)) return false
    if (/^\(sha256:/i.test(line)) return false
    if (/^Normalized copy/i.test(line)) return false
    if (/^(Coordinates remain|Waited \d|Clicked screen|Pressed hotkey|Opened https?|position \[)/i.test(line)) return false
    return true
  })
  const first = lines[0] ?? ''
  const last = lines.length > 0 ? lines[lines.length - 1] : ''
  const head = clipText(first, TIHU_LINE_CHARS - 2)
  const tail = clipText(last, TIHU_LINE_CHARS)
  if (isError) {
    // 屏上只给一句人话原因，不贴 spawn/ENOENT/路径这类原始报错（用户看不懂）。
    return { line: clipText(`✗ ${humanizeError(text)}`, TIHU_LINE_CHARS), output: '' }
  }
  return {
    line: clipText(`✓ ${head || '完成'}`, TIHU_LINE_CHARS),
    output: tail,
  }
}

/** 会话内累积的进度状态。 */
export interface TihuProgressState {
  turn: number
  step: number
  turnStartedAt: number
  lastResult?: { ok: boolean; line: string }
  lastOutput: string
  /** 阶段汉字（第二行冒号前：思考/执行命令/搜索…）。 */
  stageWord: string
  /** 第二行的第一句内容。 */
  firstLine: string
  /** 会话标题（第一行）。 */
  sessionTitle: string
  /** 第四行：解码速度 / 总 token / 上下文占比。 */
  stats?: { tokPerSec: number; totalTokens: number; contextPercent: number }
  stage: TihuStage
  title: string
  tone: 'idle' | 'busy' | 'ok' | 'alert'
}

export function createProgressState(now = Date.now()): TihuProgressState {
  return { turn: 0, step: 0, turnStartedAt: now, lastResult: undefined, lastOutput: '', stageWord: '思考', firstLine: '', sessionTitle: '', stage: '思考', title: '等待指令', tone: 'idle' }
}

export interface ProgressUpdate {
  screen?: ScreenFramePayload
  progress?: ProgressPayload
}

﻿/** 阶段汉字（第二行冒号前）。 */
const STAGE_WORD: Record<string, string> = {
  思考: '思考', 读文件: '读取文件', 写文件: '写文件', 搜索: '搜索', 跑命令: '执行命令', 回答: '回答', 等待确认: '等待确认',
}

﻿/** 命令里最有用的一段：去掉开头的 cd / Set-Location 和管道前缀，取最后一段真正干活的命令。 */
export function salientCommand(command: string): string {
  let text = String(command ?? '').replace(/\s+/g, ' ').trim()
  const strip = /^(?:Set-Location|cd|sl)\s+(?:"[^"]*"|'[^']*'|\S+)\s*;?\s*/i
  for (let i = 0; i < 3 && strip.test(text); i += 1) text = text.replace(strip, '')
  const parts = text.split(/;|&&|\|\|/).map((part) => part.trim()).filter(Boolean)
  const last = parts.length > 0 ? parts[parts.length - 1] : text
  // 去掉重定向和管道尾巴（2>&1 | Select-Object -Last 3 这类对用户没意义）。
  const cleaned = last.replace(/\s*\d?>&\d/g, '').split(/\s\|\s/)[0].trim()
  return cleaned === '' ? last : cleaned
}

/** 活动行（第二行冒号后）该写什么：命令取最有用的一段，其它工具去掉动词只看目标。 */
function activityLine(stage: string, title: string, detail: string): string {
  if (stage === '跑命令') return salientCommand(detail || title)
  const text = String(title ?? '').trim()
  const spaceAt = text.indexOf(' ')
  return spaceAt > 0 ? text.slice(spaceAt + 1).trim() : text
}

/** 第一句话：去掉多余空白、压成一行（放不下由 clipText 收省略号）。 */
function firstSentence(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const cut = text.split(/[。！？!?\n]/).map((part) => part.trim()).filter(Boolean)[0] ?? text
  return cut
}

/** token 数：99800 → 99.8k、99800000 → 99.8M。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M'
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k'
  return String(Math.round(value))
}

/**
 * 屏上四行（用户 2026-11-07 定的格式）：
 *   1 会话标题（title 大字）
 *   2 阶段词：第一句内容（放不下省略）
 *   3 第 x 步 · 已用 xx
 *   4 解码速度 · 总 token · 上下文占比
 */
function statusFrame(state: TihuProgressState, now: number): ScreenFramePayload {
  const word = STAGE_WORD[state.stageWord] ?? state.stageWord ?? '思考'
  const head = word + '：'
  const body = clipText(state.firstLine, Math.max(6, TIHU_LINE_CHARS - [...head].length))
  const line2 = body === '' ? head.replace(/：$/, '') : head + body
  const line3 = '第 ' + state.step + ' 步 · 已用 ' + formatElapsed(now - state.turnStartedAt)
  const stats = state.stats
  const line4 = stats === undefined
    ? '统计中…'
    : (stats.tokPerSec > 0 ? stats.tokPerSec.toFixed(0) + ' tok/s · ' : '') + (stats.totalTokens > 0 ? formatTokens(stats.totalTokens) + ' tok' : 'tok —') + ' · 上下文 ' + stats.contextPercent.toFixed(0) + '%'
  return {
    stage: '',
    title: clipText(state.sessionTitle || state.title, TIHU_TITLE_CHARS),
    bullets: [line2, line3, line4].map((line) => clipText(line, TIHU_LINE_CHARS)).slice(0, SCREEN_SPEC.maxBodyLines),
    tone: state.tone,
  }
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
export interface TihuScreenMeta {
  /** 会话标题（第一行）。 */
  title?: string
  /** 第四行统计（解码速度 / 总 token / 上下文占比）。 */
  stats?: { tokPerSec: number; totalTokens: number; contextPercent: number }
}

export function applySessionEvent(state: TihuProgressState, event: unknown, now = Date.now(), meta?: TihuScreenMeta): ProgressUpdate {
  if (meta?.title !== undefined && meta.title !== '') state.sessionTitle = meta.title
  if (meta?.stats !== undefined) state.stats = meta.stats
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
    state.stageWord = '思考'
    state.firstLine = '开始新一轮'
    state.tone = 'busy'
    return {
      screen: statusFrame(state, now),
      progress: { stage: 'turn', text: `开始第 ${turn} 轮` },
    }
  }

  if (type === 'step/start') {
    state.step = Number.isFinite(data.step) ? Number(data.step) : state.step + 1
    state.stage = '思考'
    state.title = '思考下一步'
    state.stageWord = '思考'
    if (state.firstLine === '') state.firstLine = '整理下一步'
    state.tone = 'busy'
    return {
      screen: statusFrame(state, now),
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
    state.stageWord = action.stage
    state.firstLine = firstSentence(activityLine(action.stage, action.title, action.detail) || action.title)
    state.tone = 'busy'
    return {
      screen: statusFrame(state, now),
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
      screen: statusFrame(state, now),
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
    state.stageWord = '回答'
    state.firstLine = firstSentence(firstLine)
    state.title = clipText(`回答 ${firstLine}`, TIHU_TITLE_CHARS)
    state.lastResult = { ok: true, line: '✓ 已生成回复' }
    // 第 3 行保持「最近一条工具输出尾行」，不被回答正文覆盖（回答正文进事件区）。
    state.tone = 'ok'
    return {
      screen: statusFrame(state, now),
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
