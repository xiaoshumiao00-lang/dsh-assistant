/**
 * 秘书会话「卡片分页」与「模型上下文滚动摘要」的**同一套口径**（宿主与客户端共用）。
 *
 * 为什么要有这个文件：分页判据（哪张卡算第几张、标题怎么截、什么算合成通知）与上下文口径
 * （词数怎么算、哪几轮进上下文、哪些行属于「中间汇报」）在宿主 route 与客户端卡片里必须
 * 一字不差，两边各写一遍迟早漂移。这里只有纯函数，没有 DOM、没有 fs，两边都能 import。
 *
 * 严禁的三件事（2026-11-21 用户定案）与本文件无关但与之冲突时以本文件为准：
 * 不换 sessionId、不分片日切、不离线重拼 session.v4.jsonl.zstd。
 */

/** 卡壳主题标识：秘书回复卡 assistant（白底紫）、用户卡 user（冷蓝）、通知卡 notice（中性灰）。 */
export const CARD_KIND_ASSISTANT = 'assistant'
export const CARD_KIND_USER = 'user'
export const CARD_KIND_NOTICE = 'notice'

/** 默认只渲染最近这么多张卡（三种卡都计入，按卡计数，不是按 DOM 行数）。 */
export const CARD_WINDOW_DEFAULT = 30
/** 上滚一段取回多少张。 */
export const CARD_PAGE_SIZE = 30
/** 一次最多渲染这么多张卡；超过就停，并显示「更早的内容请到轨迹/搜索里看」。 */
export const CARD_RENDER_CAP = 120
/** 折叠行短标题：该条首行前 24 字（码点口径，同一输入永远得到同一标题）。 */
export const CARD_TITLE_MAX_CHARS = 24
/** 宿主分页每条带回的正文预览上限（字符），防止一次取数把整段会话灌进客户端。 */
export const HISTORY_PREVIEW_MAX_CHARS = 900
/** 渲染上限用完后页面上那句提示。 */
export const EARLIER_HINT_TEXT = '更早的内容请到轨迹/搜索里看'
/** 滚动到达列表顶部多远处才取下一段（px）。 */
export const SCROLL_TOP_THRESHOLD_PX = 240
/** 一次请求最多要多少张（客户端不许要更多）。 */
export const HISTORY_MAX_LIMIT = 60

/* ---------------- 合成通知判据（与卡片三态同一套，不许另立） ---------------- */

/** 判据 ①：首行是「（系统通知，不是用户说的话）」（宽/半角括号、方括号写法都算）。 */
export const NOTICE_HEAD_LINE_RE = /^\s*[（(【\[]?\s*系统通知/
/** 判据 ②：正文里带 `[[session:id|标题]]` 引用行（src/assistant-cu-watch.ts 注入格式）。 */
export const NOTICE_SESSION_REF_LINE_RE = /(^|\n)\s*(最后单独一行原样输出：)?\s*\[\[session:[^\]]*\]\]/
/** 会话引用标记（全局扫描，用于把 chip 抽出来）。 */
export const SESSION_REF_RE = /\[\[session:([^\]|\s]+)\s*(?:\|\s*([^\]]*))?\]\]/g

/** 这条 user 角色正文是不是插件自己塞进来的合成通知。 */
export function isSyntheticNoticeUserText(raw: string): boolean {
  const text = String(raw ?? '')
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return false
  if (NOTICE_HEAD_LINE_RE.test(lines[0])) return true
  return lines.some((line) => NOTICE_SESSION_REF_LINE_RE.test(`\n${line}`))
}

/** 剥掉合成通知的头部标记与「最后单独一行原样输出：」前缀（卡片正文只留真实内容）。 */
export function stripNoticeSyntheticHead(raw: string): string {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (text === '') return ''
  const lines = text.split('\n')
  while (lines.length > 0 && NOTICE_HEAD_LINE_RE.test(lines[0])) lines.shift()
  const cleaned = lines.map((line) => line
    .replace(/^\s*最后单独一行原样输出[：:]\s*/, '')
    .trim())
  return cleaned.filter((line) => line !== '').join('\n')
}

/** 抽出 `[[session:id|标题]]` 引用（宿主与客户端同一口径）。 */
export function parseSessionRefs(raw: string): { id: string; title: string }[] {
  const text = String(raw ?? '')
  const out: { id: string; title: string }[] = []
  const pattern = new RegExp(SESSION_REF_RE.source, 'g')
  let match: RegExpExecArray | null = pattern.exec(text)
  while (match !== null) {
    const id = String(match[1] ?? '').trim()
    const title = String(match[2] ?? '').trim()
    if (id !== '') out.push({ id, title })
    const consumed = pattern.lastIndex
    match = pattern.exec(text)
    if (match !== null && pattern.lastIndex === consumed) pattern.lastIndex += 1
  }
  return out
}

/* ---------------- 卡片 key 口径（既是朗读 key，也是已读 cardKey、分页 cardKey） ---------------- */

/** 用户卡 key：`user:` + 宿主那条消息的稳定 key；没有 key 就退回轮次。 */
export function userCardSpeechKey(messageKey: string, turnNo = ''): string {
  const key = String(messageKey ?? '').trim()
  if (key !== '') return `user:${key}`
  const turn = String(turnNo ?? '').trim()
  return turn === '' ? '' : `user:turn:${turn}`
}

/** 通知卡 key：`notice:` + 宿主那条消息的稳定 key。 */
export function noticeCardSpeechKey(messageKey: string, turnNo = ''): string {
  const key = String(messageKey ?? '').trim()
  if (key !== '') return `notice:${key}`
  const turn = String(turnNo ?? '').trim()
  return turn === '' ? '' : `notice:turn:${turn}`
}

/** 秘书回复卡 key：`assistant:turn:N`（每个 turn 一张卡）。 */
export function assistantCardSpeechKey(turnNo: string | number): string {
  const turn = String(turnNo ?? '').trim()
  return turn === '' ? '' : `assistant:turn:${turn}`
}

/* ---------------- 词数口径（实现里只允许这一个口径：词数，不是 token） ---------------- */

/**
 * 词数口径（2026-11-21 定案，上下文触发与轮次预算都只按这个算）：
 *   - 拉丁/数字连成的一个 run 算一个词（含 `-'`、`_`、小数点与千分位写法）；
 *   - 每个 CJK 字符（含中文标点与全角字符）单独算一个词；
 *   - 其它字符只作为分隔符。
 * 稳定可复现：同一输入永远得到同一数字，不依赖 tokenizer、不依赖模型。
 */
export function countWords(text: string): number {
  const value = String(text ?? '')
  if (value === '') return 0
  const latin = value.match(/[A-Za-z0-9\u00C0-\u02BC\u2019'._-]+/g) ?? []
  const cjk = value.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3001-\u3003\u3008-\u3011\uFF01-\uFF5E]/g) ?? []
  return latin.length + cjk.length
}

/** 折叠行短标题：该条首行的前 24 个字符（码点口径），被截断时补一个「…」。 */
export function truncateCardTitle(raw: string): string {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (text === '') return ''
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
  const codePoints = Array.from(firstLine)
  if (codePoints.length <= CARD_TITLE_MAX_CHARS) return codePoints.join('')
  return `${codePoints.slice(0, CARD_TITLE_MAX_CHARS).join('')}…`
}

/** 预览正文：稳定截断（同一输入同一输出），用于折叠行点击时跳到的原始文本预览。 */
export function truncatePreview(raw: string, maxChars = HISTORY_PREVIEW_MAX_CHARS): string {
  const codePoints = Array.from(String(raw ?? ''))
  const cap = Math.max(1, Math.min(Number(maxChars) || HISTORY_PREVIEW_MAX_CHARS, HISTORY_PREVIEW_MAX_CHARS))
  if (codePoints.length <= cap) return codePoints.join('')
  return `${codePoints.slice(0, cap).join('')}…`
}

/* ---------------- 事件 → 卡片条目（宿主分页与单测同一口径） ---------------- */

/** 事件里的正文块 → 纯文本（宿主 user/assistant 消息同一个取法）。 */
export function eventText(event: any): string {
  const content = event?.data?.content ?? event?.data?.message?.content ?? event?.data?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => String(block?.text ?? ''))
    .join('\n')
    .trim()
}

/** 一条会话事件对应的卡片 kind（assistant/notice 都判定得出来）。 */
export function eventCardKind(event: any): string {
  const type = String(event?.type ?? '')
  if (type === 'assistant/message') return CARD_KIND_ASSISTANT
  if (type === 'user/message') return isSyntheticNoticeUserText(eventText(event)) ? CARD_KIND_NOTICE : CARD_KIND_USER
  return ''
}

export interface HistoryCardItem {
  /** 会话日志里的 seq（分页游标就靠它，客户端不许把整条会话读回来）。 */
  seq: number
  /** 卡片 key（与朗读/已读同一套前缀口径）。 */
  cardKey: string
  /** assistant 卡按 turn 匹配；user/notice 卡按消息 key 匹配。 */
  turn: string
  messageKey: string
  kind: string
  /** epoch 毫秒（客户端自己按卡片口径格式化成 HH:MM）。 */
  time: number
  /** 折叠行的短标题（宿主与客户端同一口径）。 */
  title: string
  /** 原始文本预览（截断稳定）。 */
  preview: string
  /** 会话引用 chip（通知卡/秘书卡正文里的 [[session:…]]）。 */
  refs: { id: string; title: string }[]
}

export interface HistoryPage {
  items: HistoryCardItem[]
  /** 还有更旧的卡吗（客户端据此决定要不要继续上滚）。 */
  hasMore: boolean
  /** 整条会话一共多少张卡（分页前就知道，客户端不许为了分页读全量）。 */
  totalCards: number
  fromSeq: number
  toSeq: number
  /** 下一页的游标（比 fromSeq 更旧）。 */
  nextBefore: number
  /** 会话正文总词数（词数口径，上下文触发也用它）。 */
  totalWords: number
}

/** 事件流 → 卡片条目（按 seq 升序、assistant 卡每个 turn 只留一条）。 */
export function historyItemsFromEvents(events: readonly any[]): HistoryCardItem[] {
  const ordered = [...events]
    .filter((event) => event !== null && typeof event === 'object' && String(event?.type ?? '') !== '')
    .sort((left, right) => Number(left?.seq ?? 0) - Number(right?.seq ?? 0))
  const items: HistoryCardItem[] = []
  const assistantByTurn = new Map<string, HistoryCardItem>()
  for (const event of ordered) {
    const kind = eventCardKind(event)
    if (kind === '') continue
    const text = eventText(event)
    if (text === '') continue
    const seq = Number(event?.seq ?? 0)
    const time = Number(event?.time ?? 0)
    if (kind === CARD_KIND_ASSISTANT) {
      const turn = String(event?.data?.turn ?? '').trim()
      if (turn === '') continue
      const cardKey = assistantCardSpeechKey(turn)
      const existing = assistantByTurn.get(turn)
      const item: HistoryCardItem = {
        seq,
        cardKey,
        turn,
        messageKey: '',
        kind,
        time,
        title: truncateCardTitle(text),
        preview: truncatePreview(text),
        refs: parseSessionRefs(text),
      }
      if (existing === undefined) { assistantByTurn.set(turn, item); items.push(item); continue }
      // 同一 turn 里多步回复：卡片还是那一张，标题/预览取这一 turn 最长的那条正文
      if (item.preview.length > existing.preview.length) {
        existing.seq = item.seq
        existing.time = item.time
        existing.title = item.title
        existing.preview = item.preview
        existing.refs = item.refs
      }
      continue
    }
    const messageKey = String(event?.data?.id ?? event?.data?.message?.id ?? '').trim()
    const turn = String(event?.data?.turn ?? '').trim()
    const key = kind === CARD_KIND_NOTICE
      ? noticeCardSpeechKey(messageKey, turn)
      : userCardSpeechKey(messageKey, turn)
    if (key === '') continue
    const body = kind === CARD_KIND_NOTICE ? stripNoticeSyntheticHead(text) : text
    items.push({
      seq,
      cardKey: key,
      turn,
      messageKey,
      kind,
      time,
      title: truncateCardTitle(body),
      preview: truncatePreview(body),
      refs: parseSessionRefs(body),
    })
  }
  return items
}

export function normalizeHistoryLimit(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return CARD_PAGE_SIZE
  return Math.max(1, Math.min(Math.floor(value), HISTORY_MAX_LIMIT))
}

/** 游标归一：只接受正整数 seq（`before=<seq>`），别的都当「没给游标」。 */
export function normalizeHistoryCursor(raw: unknown): number | undefined {
  const value = Number(String(raw ?? '').trim())
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/**
 * 从事件流取一页卡（宿主 route 的实现，也是单测的口径）：
 *   - `beforeSeq` 给了 → 取比它更旧的那一段；没给 → 取最近的那一段。
 *   - 只回一页，绝不全量下发（totalCards/totalWords 是顺带算出来的统计）。
 */
export function buildHistoryPage(events: readonly any[], options: { limit?: number; beforeSeq?: number } = {}): HistoryPage {
  const all = historyItemsFromEvents(events)
  const totalCards = all.length
  const totalWords = all.reduce((sum, item) => sum + countWords(item.preview), 0)
  const limit = normalizeHistoryLimit(options.limit)
  const beforeSeq = normalizeHistoryCursor(options.beforeSeq)
  const pool = beforeSeq === undefined ? all : all.filter((item) => item.seq < beforeSeq)
  const tail = pool.slice(Math.max(0, pool.length - limit))
  const fromSeq = tail.length === 0 ? 0 : tail[0].seq
  const toSeq = tail.length === 0 ? 0 : tail[tail.length - 1].seq
  return {
    items: tail,
    hasMore: tail.length > 0 ? pool.length > tail.length : totalCards > 0 && beforeSeq === undefined,
    totalCards,
    fromSeq,
    toSeq,
    nextBefore: fromSeq,
    totalWords,
  }
}

/** 客户端取回一段后该不该继续上滚（累计渲染上限在这里钉死，绝不把整条会话塞进 DOM）。 */
export function canRenderMore(renderedCount: number): boolean {
  return Number(renderedCount) < CARD_RENDER_CAP
}

/** 渲染窗口：只留最近 `limit` 张（按卡计数），其余一律折叠行。 */
export function windowOfItems(items: readonly HistoryCardItem[], limit = CARD_WINDOW_DEFAULT): HistoryCardItem[] {
  const size = Math.max(1, Number(limit) || CARD_WINDOW_DEFAULT)
  return items.length <= size ? [...items] : items.slice(items.length - size)
}

/**
 * 「上滚才取回下一段」的唯一判据（客户端与测试共用一份，不许两处各写一遍）：
 * 只有滚动到达顶部阈值、还有更旧的、没到渲染上限、不在取数中、不在扩段中，才取下一段。
 */
export function shouldExpandOnScroll(input: {
  scrollTop: number;
  threshold?: number;
  hasMore: boolean;
  capped: boolean;
  loading: boolean;
  alreadyExpanding?: boolean;
}): boolean {
  if (input.hasMore !== true) return false
  if (input.capped === true) return false
  if (input.loading === true) return false
  if (input.alreadyExpanding === true) return false
  const threshold = Number(input.threshold ?? SCROLL_TOP_THRESHOLD_PX)
  const top = Number(input.scrollTop)
  if (!Number.isFinite(top) || !Number.isFinite(threshold)) return false
  return top <= threshold
}

/* ---------------- 模型上下文滚动摘要口径 ---------------- */

/**
 * 每轮送进模型的原文轮数（实测定案，见 src/assistant-secretary-context.ts 顶部注释）：
 * 现役秘书会话实测：51 轮 / 正文 5965 词 / 每轮均值 117 词 / 中位 67 词 / 最大单轮 942 词；
 * 最近 6 轮 498 词、7 轮 543、8 轮 580、9 轮 631、10 轮 668；单次请求实测 totalTokens ≈ 58.7k。
 * 取 8：注入预算 1200 词按均值刚好够 10 轮但会被两个大轮（942 词级）挤爆，8 轮留 264 词余量给摘要段。
 */
export const CONTEXT_RECENT_ROUNDS = 8
/** 上下文注入预算（词数口径，与 countWords 同一口径）。 */
export const CONTEXT_RECENT_WORD_BUDGET = 1200
/** 触发点：比上次摘要多满 12 轮（2026-11-22 用户定案：30 → 12，让旧轮挤出尽快生效）。 */
export const CONTEXT_ROUND_TRIGGER = 12
/** 触发点：或累计词数够 10000（口径 = 词数，不是 token）。 */
export const CONTEXT_WORD_TRIGGER = 10000
/** 单条摘要段最长字符数（把「已完成任务、结论、待办」压成一小段的预算）。 */
export const CONTEXT_SUMMARY_SEGMENT_MAX_CHARS = 260
/** 滚动摘要总预算（超了就丢最旧的那些段）。 */
export const CONTEXT_SUMMARY_MAX_CHARS = 3000
/** 摘要生成超时（毫秒）：超时或失败就降级成「只带最近 N 轮原文」，绝不阻塞会话。 */
export const CONTEXT_SUMMARY_TIMEOUT_MS = 4000
/** 摘要文件里最多记多少轮明细。 */
export const CONTEXT_ROUND_LOG_MAX = 60

/**
 * 中间汇报与取证过程不进上下文：这些行都是「正在调用工具」「收到执行请求」之类的流水账，
 * 或宿主自己塞的系统通知头，压摘要时一律丢掉。
 */
export const CONTEXT_PROGRESS_LINE_RE = /^\s*(\[?(工具|tool)\]?|正在|已开始|收到执行请求|执行请求已|后台会话|job|pwsh|computer_use|subagent|取证|待办清单|todo_write)/i
/** 一条正文是不是属于「中间汇报/取证过程」（不进摘要）。 */
export function isProgressLine(line: string): boolean {
  const value = String(line ?? '').trim()
  if (value === '') return true
  if (CONTEXT_PROGRESS_LINE_RE.test(value)) return true
  if (NOTICE_HEAD_LINE_RE.test(value)) return true
  if (/^\s*最后单独一行原样输出[：:]/.test(value)) return true
  if (/^\s*\[\[session:[^\]]*\]\]/.test(value)) return true
  if (/^\s*(§|---|===)/.test(value)) return true
  return false
}

/** 一轮正文 → 压成一小段：已完成任务 / 结论 / 待办。 */
export function summarizeRoundText(raw: string): { task: string; conclusion: string; todos: string[] } {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !isProgressLine(line))
  const todoLine = (line: string) => /^[-·*]\s*(待办|下一步|还需|接下来|TODO)/i.test(line) || /待办|下一步|还需|接下来/i.test(line)
  const first = lines[0] ?? ''
  const nonTodo = lines.filter((line) => !todoLine(line))
  const last = nonTodo.length > 1 ? (nonTodo[nonTodo.length - 1] ?? '') : ''
  const todos = lines
    .filter((line) => todoLine(line))
    .slice(0, 4)
    .map((line) => line.replace(/^[-·*]\s*/, '').slice(0, 80))
  const cap = (value: string) => {
    const codePoints = Array.from(value)
    return codePoints.length <= CONTEXT_SUMMARY_SEGMENT_MAX_CHARS ? value : `${codePoints.slice(0, CONTEXT_SUMMARY_SEGMENT_MAX_CHARS).join('')}…`
  }
  return { task: cap(first), conclusion: cap(last === first ? '' : last), todos }
}

/** 最近 N 轮原文（按词数预算裁，上限 CONTEXT_RECENT_ROUNDS）。 */
export function selectRecentRounds<T extends { words: number }>(rounds: readonly T[], limit = CONTEXT_RECENT_ROUNDS, wordBudget = CONTEXT_RECENT_WORD_BUDGET): T[] {
  const cap = Math.max(1, Math.min(Number(limit) || CONTEXT_RECENT_ROUNDS, CONTEXT_RECENT_ROUNDS))
  const budget = Math.max(1, Number(wordBudget) || CONTEXT_RECENT_WORD_BUDGET)
  const picked: T[] = []
  let words = 0
  for (const round of [...rounds].reverse()) {
    const nextWords = words + Math.max(1, Number(round?.words) || 0)
    if (picked.length >= cap) break
    // 词数口径裁窗口：装不下就停（至少保证 1 轮）
    if (picked.length > 0 && nextWords > budget) break
    picked.unshift(round)
    words = nextWords
  }
  return picked
}

/** 把摘要段拼成一小段模型可见文本（已完成任务、结论、待办）。 */
export function rollingSummaryText(entries: readonly { task?: string; conclusion?: string; todos?: readonly string[]; turn?: string | number }[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    const task = String(entry?.task ?? '').trim()
    const conclusion = String(entry?.conclusion ?? '').trim()
    const todos = (entry?.todos ?? []).map((todo) => String(todo ?? '').trim()).filter((todo) => todo !== '')
    if (task === '' && conclusion === '' && todos.length === 0) continue
    const turn = String(entry?.turn ?? '').trim()
    lines.push(`- ${turn !== '' ? `第 ${turn} 轮 ` : ''}已完成：${task || '（无）'}${conclusion !== '' ? ` ｜结论：${conclusion}` : ''}${todos.length > 0 ? ` ｜待办：${todos.join('；')}` : ''}`)
  }
  const joined = lines.join('\n')
  const codePoints = Array.from(joined)
  if (codePoints.length <= CONTEXT_SUMMARY_MAX_CHARS) return joined
  // 超预算就丢最旧的段，只留最近的（滚动摘要的「滚动」就在这儿）
  return `…\n${codePoints.slice(codePoints.length - CONTEXT_SUMMARY_MAX_CHARS).join('')}`
}

/** 单测/探针用的纯函数面（口径都在这儿，宿主和客户端两边不许各写一遍）。 */
export const secretCardSharedTestSurface = {
  CARD_WINDOW_DEFAULT,
  CARD_PAGE_SIZE,
  CARD_RENDER_CAP,
  CARD_TITLE_MAX_CHARS,
  HISTORY_MAX_LIMIT,
  HISTORY_PREVIEW_MAX_CHARS,
  EARLIER_HINT_TEXT,
  SCROLL_TOP_THRESHOLD_PX,
  CONTEXT_RECENT_ROUNDS,
  CONTEXT_RECENT_WORD_BUDGET,
  CONTEXT_ROUND_TRIGGER,
  CONTEXT_WORD_TRIGGER,
  CONTEXT_SUMMARY_TIMEOUT_MS,
  CONTEXT_ROUND_LOG_MAX,
  isSyntheticNoticeUserText,
  stripNoticeSyntheticHead,
  parseSessionRefs,
  countWords,
  truncateCardTitle,
  truncatePreview,
  eventCardKind,
  eventText,
  historyItemsFromEvents,
  buildHistoryPage,
  normalizeHistoryLimit,
  normalizeHistoryCursor,
  canRenderMore,
  shouldExpandOnScroll,
  windowOfItems,
  isProgressLine,
  summarizeRoundText,
  selectRecentRounds,
  rollingSummaryText,
  userCardSpeechKey,
  noticeCardSpeechKey,
  assistantCardSpeechKey,
}
