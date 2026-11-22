/**
 * 个人秘书「回复卡片」共享逻辑（纯函数 + 状态机，node 可单测，无 react / DOM 依赖）。
 *
 * 内容三块：
 *   1. 朗读文本规范化（normalizeForSpeech）：去 markdown 符号 / 列表符 / 代码块 /
 *      表情 / URL，把能念的都转成口语；秘书提示词已要求模型照此写，这里兜底。
 *   2. 会话引用标记（parseSessionRefs）：回复里引用某条会话时按
 *      `[[session:<sessionId>|<标题>]]` 书写（提示词里说明）。渲染成引用块、
 *      朗读时剔除；点引用块按会话 id 走宿主既有会话选择逻辑。
 *   3. 朗读状态机（reduceSpeech + createSpeechController）：
 *      idle → loading → playing ⇄ paused；restart/切换/播完/失败都收拢到唯一出口。
 *      默认每条卡片出现后自动朗读；单击暂停/继续；长按从头重读；换卡片停上一条。
 *      **只用宿主 /api/assistant/tts（微软 edge-tts），不用 speechSynthesis。**
 *   4. 卡片脚部时间（2026-11-21 改动）：只写时间（`9:08`），不再带「今天」字样。
 *   5. 折叠预算：折叠态正文最多 **3 行**、卡标题最多 **2 行**（见 FOLD_BODY_LINE_BUDGET / FOLD_TITLE_LINE_BUDGET，
 *      三种卡共用一套；判据一律是内容高度，不看字符数）。
 *   6. 秘书页 user 角色行分类：真实用户输入 → 冷蓝用户卡；插件塞进来的合成通知 → 灰底通知卡
 *      （见 collectSecretaryCardRows / parseNoticeCardBody）。
 *   7. 已读卡集合（未读红点）：cardKey 沿用朗读 key（`assistant:` / `notice:` 前缀那套），
 *      真值落宿主 `/api/assistant/secretary-read` → dsh-assistant-secretary-read.json，
 *      localStorage 只是首屏缓存与降级兜底（见 createSecretaryReadStore）。
 *   8. 卡片分页（2026-11-21 第四批）：默认只渲染最近 30 张卡，更早的压成一行折叠行
 *      （时间 + 首行前 24 字短标题），上滚到达顶部阈值才取回下一段 30 张，累计上限 120 张
 *      后停在「更早的内容请到轨迹/搜索里看」。取数走宿主 `GET /api/assistant/secretary/history`，
 *      客户端绝不为分页把整条会话读回来（见 createSecretaryPager）。卡计数口径、24 字标题口径、
 *      词数口径都在 src/secretary-card-shared.ts，宿主与客户端共用。
 */

import {
  CARD_WINDOW_DEFAULT,
  CARD_PAGE_SIZE,
  CARD_RENDER_CAP,
  EARLIER_HINT_TEXT,
  SCROLL_TOP_THRESHOLD_PX,
  NOTICE_HEAD_LINE_RE,
  NOTICE_SESSION_REF_LINE_RE,
  assistantCardSpeechKey,
  canRenderMore,
  shouldExpandOnScroll,
  countWords,
  historyItemsFromEvents,
  isSyntheticNoticeUserText,
  noticeCardSpeechKey,
  normalizeHistoryCursor,
  normalizeHistoryLimit,
  stripNoticeSyntheticHead,
  truncateCardTitle,
  truncatePreview,
  userCardSpeechKey,
  windowOfItems,
} from '../../../secretary-card-shared'

export {
  CARD_WINDOW_DEFAULT,
  CARD_PAGE_SIZE,
  CARD_RENDER_CAP,
  EARLIER_HINT_TEXT,
  SCROLL_TOP_THRESHOLD_PX,
  NOTICE_HEAD_LINE_RE,
  NOTICE_SESSION_REF_LINE_RE,
  assistantCardSpeechKey,
  canRenderMore,
  shouldExpandOnScroll,
  countWords,
  historyItemsFromEvents,
  isSyntheticNoticeUserText,
  noticeCardSpeechKey,
  normalizeHistoryCursor,
  normalizeHistoryLimit,
  stripNoticeSyntheticHead,
  truncateCardTitle,
  userCardSpeechKey,
  windowOfItems,
}

/** ────────────────────────── 1. 朗读文本规范化 ────────────────────────── */

/** 需要念成中文读法的常用单位：紧贴数字的写法优先（\b 在「数字+字母」之间不成立）。 */
const UNIT_READINGS: Array<[RegExp, string]> = [
  [/℃/g, '摄氏度'],
  [/°C/gi, '摄氏度'],
  [/°F/gi, '华氏度'],
  [/(\d)km\/h/gi, '$1 公里每小时'],
  [/(\d)km\b/gi, '$1 公里'],
  [/(\d)mm\b/g, '$1 毫米'],
  [/(\d)cm\b/g, '$1 厘米'],
  [/(\d)m\b/g, '$1 米'],
  [/(\d)kg\b/gi, '$1 公斤'],
  [/(\d)g\b/g, '$1 克'],
  [/(\d)ml\b/gi, '$1 毫升'],
  [/(\d)l\b/gi, '$1 升'],
]

/** 数字区间「8–14」/「8-14」→「8 到 14」（edge-tts 读「到」最自然）。 */
function expandRanges(text: string): string {
  return text.replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 到 $2')
}

/** 去掉引用标记（朗读时不能念出来）。 */
export function stripSessionRefs(text: string): string {
  return String(text ?? '').replace(/\[\[session:[^\]|]*\|[^\]]*\]\]/g, '')
}

/** 把卡片正文整理成适合朗读的纯文本（纯函数，单测直接验）。 */
export function normalizeForSpeech(raw: string): string {
  let text = stripSessionRefs(String(raw ?? ''))
  // 代码块 / 行内代码：直接去掉围栏，保留内容
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`([^`]*)`/g, '$1')
  // markdown 标题 / 加粗 / 斜体 / 引用符 / 分隔线 / 链接
  text = text.replace(/^#{1,6}\s*/gm, '')
  text = text.replace(/(\*\*|__)([^*_]*)\1/g, '$2')
  text = text.replace(/(\*|\b_)([^*_]+)\1/g, '$2')
  text = text.replace(/^>\s?/gm, '')
  text = text.replace(/^-{3,}\s*$/gm, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 列表符号（- * 1. ①）整行去掉符号
  text = text.replace(/^\s*(?:[-*+]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])\s+/gm, '')
  // URL / 邮箱
  text = text.replace(/https?:\/\/\S+/gi, ' ')
  text = text.replace(/\S+@\S+\.\S+/g, ' ')
  // 表情（ BMP + 常见补充区 ）
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
  // 单位与区间
  for (const [pattern, reading] of UNIT_READINGS) text = text.replace(pattern, reading)
  text = expandRanges(text)
  // 数字与汉字之间补空格（「14摄氏度」→「14 摄氏度」），TTS 断字更自然
  text = text.replace(/(\d)([\u4e00-\u9fff])/g, '$1 $2')
  // 空白收拢
  return text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, ' ').replace(/\n/g, '，').trim()
}

/** ────────────────────────── 2.5 朗读分块（流式合成用） ────────────────────────── */

/**
 * 流式朗读分块器：把规范化后的朗读文本切成若干块，逐块送 TTS、边合成边播。
 * 硬约束：
 *   - chunks.join('') === 原文逐字符一致（含空白），调用方断言；
 *   - 只切在中文句读后（。！？；!?;\n），绝不切在数字/小数/百分号/单位/引号对/括号对/
 *     URL/文件路径/行内代码/emoji 序列中间；
 *   - 单块长度上限 maxChars（默认 200 字）、下限 minChars（默认 40 字，仅尾块可不足）；
 *     首块用更小的 firstMaxChars（默认 80 字）——第一块越小，首字可播越快；
 *   - 短文本（≤ maxChars）不切块，原样一块返回；
 *   - 超长句没有句读可切时，次级边界用「，、：」与空格，最后才退化为安全硬切
 *     （仍避开上述保护区间与代理对/补充平面字符边界）。
 */
export interface SpeechChunkOptions {
  /** 单块下限（字，码点计）。默认 40。 */
  minChars?: number
  /** 单块上限（字）。默认 200；短文本 ≤ 此值不切块。 */
  maxChars?: number
  /** 首块上限（字），抢首字可播时间。默认 80（自动不小于 minChars）。 */
  firstMaxChars?: number
}

export const SPEECH_CHUNK_MIN_CHARS = 40
export const SPEECH_CHUNK_MAX_CHARS = 200
export const SPEECH_CHUNK_FIRST_MAX_CHARS = 80

/** 中文句读（硬边界）。 */
const CHUNK_HARD_STOPS = new Set(['。', '！', '？', '；', '!', '?', ';', '\n'])
/** 次级边界（只有硬边界不可用时才切）。 */
const CHUNK_SECONDARY_STOPS = new Set(['，', ',', '、', '：', ':', ' '])

/** 成对符号：开 → 闭。闭包内（含闭符之前）不许切。 */
const CHUNK_PAIRS: Record<string, string> = {
  '“': '”', '‘': '’', '「': '」', '『': '』', '（': '）', '《': '》', '〈': '〉',
  '【': '】', '〔': '〕', '〖': '〗',
  '(': ')', '[': ']', '{': '}',
}
const CHUNK_CLOSERS = new Set(Object.values(CHUNK_PAIRS))

/** 保护区间：inclusiveEnd=true 是闭区间（引号/括号对，闭符本身不许开头新块）；false 是半开（token）。 */
interface ChunkSpan { start: number; end: number; inclusiveEnd: boolean }

/** token 保护（半开区间 [start, end)）：URL / 路径 / 日期 / 时间 / 数字小数百分号单位 / 行内代码。 */
const CHUNK_TOKEN_RES: RegExp[] = [
  /`[^`\n]*`/g,                                     // 行内代码
  /https?:\/\/[^\s，。！？；）】」』]+/gi,            // URL（吃到句读/闭括号前）
  /(?:[A-Za-z]:[\\/]|~[\\/]|\.\.?[\\/])[\w.\\/\\-]*/g, // 文件路径（Windows / ~ / 相对）
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g,                   // 2026-11-22
  /\d{1,2}:\d{2}(?::\d{2})?/g,                      // 10:30 / 10:30:00
  /\d+(?:[.,]\d+)*(?:\s*(?:%|‰|℃|°[CFcf]|[a-zA-Zμ°²³]{1,6}))?/g, // 数字/小数/千分位 + 单位百分号
]

function chunkProtectedSpans(text: string): ChunkSpan[] {
  const spans: ChunkSpan[] = []
  for (const re of CHUNK_TOKEN_RES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0] !== '') spans.push({ start: m.index, end: m.index + m[0].length, inclusiveEnd: false })
      if (m[0] === '') re.lastIndex += 1
    }
  }
  // 成对符号：栈扫描，未闭合的开符号不保护（避免一句没写完就把分块堵死）。
  const stack: Array<[string, number]> = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (CHUNK_PAIRS[ch] !== undefined) { stack.push([ch, i]); continue }
    if (CHUNK_CLOSERS.has(ch)) {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (CHUNK_PAIRS[stack[j][0]] === ch) { spans.push({ start: stack[j][1], end: i, inclusiveEnd: true }); stack.splice(j, 1); break }
      }
    }
  }
  return spans
}

function chunkIsBoundary(_text: string, spans: ChunkSpan[], pos: number): boolean {
  if (pos <= 0 || pos >= _text.length) return false
  for (const span of spans) {
    // 闭区间（引号/括号对）：切在 (start, end] 之内都不行；token 半开区间：切在 (start, end) 之内不行。
    if (span.inclusiveEnd) { if (span.start < pos && pos <= span.end) return false }
    else if (span.start < pos && pos < span.end) return false
  }
  return true
}

function chunkIsSafeHardSplit(text: string, spans: ChunkSpan[], pos: number): boolean {
  if (!chunkIsBoundary(text, spans, pos)) return false
  const prev = text.charCodeAt(pos - 1)
  const next = text.charCodeAt(pos)
  // 不劈开代理对（emoji/补充平面字符）
  if (prev >= 0xd800 && prev <= 0xdbff) return false
  if (next >= 0xdc00 && next <= 0xdfff) return false
  // 不劈开英文单词 / 字母数字串（避免半拉 token）
  const wordy = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  if (wordy(prev) && wordy(next)) return false
  // 小数点 / 千分位两侧不劈
  if (prev === 0x2e || prev === 0x2c || next === 0x2e || next === 0x2c) {
    if (wordy(text.charCodeAt(pos - 2) || 0) || wordy(text.charCodeAt(pos + 1) || 0)) return false
  }
  return true
}

/** 从 start 起数 count 个码点，返回字符串下标（不超过 text.length）。 */
function advanceCodePoints(text: string, start: number, count: number): number {
  let i = start
  let n = 0
  while (i < text.length && n < count) {
    const code = text.charCodeAt(i)
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1
    n += 1
  }
  return i
}

function codePointLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0xd800 || code > 0xdbff) n += 1
  }
  return n
}

/**
 * 朗读分块（纯函数）。不变式：chunks.length === 0（仅空串）或 chunks.join('') === text。
 * 全部边界都过 chunkIsBoundary —— 数字/单位/小数/百分号/引号对/括号对/URL/路径/行内代码
 * 中间永远不会成为切点。
 */
export function splitSpeechChunks(text: string, options: SpeechChunkOptions = {}): string[] {
  const src = String(text ?? '')
  if (src === '') return []
  const minChars = Math.max(1, options.minChars ?? SPEECH_CHUNK_MIN_CHARS)
  const maxChars = Math.max(minChars, options.maxChars ?? SPEECH_CHUNK_MAX_CHARS)
  const firstMaxChars = Math.max(minChars, options.firstMaxChars ?? Math.min(SPEECH_CHUNK_FIRST_MAX_CHARS, maxChars))
  if (codePointLength(src) <= maxChars) return [src]

  const spans = chunkProtectedSpans(src)
  const out: string[] = []
  let start = 0
  while (start < src.length) {
    const maxForThis = out.length === 0 ? firstMaxChars : maxChars
    const remaining = codePointLength(src.slice(start))
    if (remaining <= maxForThis) { out.push(src.slice(start)); break }
    const limit = advanceCodePoints(src, start, maxForThis)
    const minLimit = advanceCodePoints(src, start, minChars)
    let cut = -1
    // 1) 硬句读（从上限往下找最近的）
    for (let p = limit; p >= minLimit; p--) {
      if (CHUNK_HARD_STOPS.has(src[p - 1]) && chunkIsBoundary(src, spans, p)) { cut = p; break }
    }
    // 2) 次级边界（逗号/顿号/冒号/空格）
    if (cut < 0) {
      for (let p = limit; p >= minLimit; p--) {
        if (CHUNK_SECONDARY_STOPS.has(src[p - 1]) && chunkIsBoundary(src, spans, p)) { cut = p; break }
      }
    }
    // 3) 安全硬切（仍避开保护区间 / 代理对 / 单词）
    if (cut < 0) {
      for (let p = limit; p > start; p--) {
        if (chunkIsSafeHardSplit(src, spans, p)) { cut = p; break }
      }
    }
    // 4) 极端退化：直接按上限切（理论上到不了：limit 本身满足 safe split 的概率极高；
    //    若真退化，保护约束优先——往前找任意非保护点，找不到就原地切，保证前进）。
    if (cut <= start) {
      let p = limit
      while (p > start && !chunkIsBoundary(src, spans, p)) p--
      cut = p > start ? p : limit
    }
    out.push(src.slice(start, cut))
    start = cut
  }
  // 纯空白块（标点产生的边角）并入相邻块，避免 TTS 拿到空白文本；拼接不变式保持。
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== '' && /^\s*$/.test(out[i])) {
      if (i > 0) { out[i - 1] += out[i]; out.splice(i, 1) }
      else if (out.length > 1) { out[1] = out[0] + out[1]; out.splice(0, 1) }
    }
  }
  return out.length === 0 ? [src] : out
}

/** ────────────────────────── 2. 会话引用标记 ────────────────────────── */

export interface SessionRef {
  sessionId: string
  title: string
}

/** 从正文里解析 `[[session:<id>|<标题>]]` 引用块（纯函数）。 */
export function parseSessionRefs(raw: string): SessionRef[] {
  const out: SessionRef[] = []
  const text = String(raw ?? '')
  const pattern = /\[\[session:([^\]|]*)\|([^\]]*)\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const sessionId = String(match[1] ?? '').trim()
    const title = String(match[2] ?? '').trim()
    if (sessionId !== '') out.push({ sessionId, title: title === '' ? sessionId : title })
  }
  return out
}

/** ────────────────────────── 3. 朗读状态机 ────────────────────────── */

export type SpeechStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'
export type SpeechEvent =
  | { type: 'play'; key: string }
  | { type: 'playing'; key: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'toggle'; key: string }
  | { type: 'restart'; key: string }
  | { type: 'ended' }
  | { type: 'stop' }
  | { type: 'error'; error: string }

export interface SpeechState {
  status: SpeechStatus
  /** 当前这条内容的 key（turn key / card id），暂停/继续靠它。 */
  key: string
  error: string
}

export const SPEECH_IDLE: SpeechState = { status: 'idle', key: '', error: '' }

/**
 * 纯状态机（单测直接驱动）：
 *   play：换 key = 停旧启新（loading）；同 key 忽略。
 *   toggle：playing→paused；paused→playing；idle/loading→loading 不动；error→重播（play）。
 *   restart：无论播到哪，都回到 loading（播放器层从头 seek）。
 *   ended / stop / error：回 idle（error 记原因）。
 */
export function reduceSpeech(state: SpeechState, event: SpeechEvent): SpeechState {
  switch (event.type) {
    case 'play': {
      if (state.key === event.key && (state.status === 'loading' || state.status === 'playing' || state.status === 'paused')) return state
      return { status: 'loading', key: event.key, error: '' }
    }
    case 'playing':
      return state.key === event.key && state.status === 'loading' ? { status: 'playing', key: event.key, error: '' } : state
    case 'pause':
      return state.status === 'playing' ? { status: 'paused', key: state.key, error: '' } : state
    case 'resume':
      return state.status === 'paused' ? { status: 'playing', key: state.key, error: '' } : state
    case 'toggle': {
      if (state.key === event.key && state.status === 'playing') return { status: 'paused', key: state.key, error: '' }
      if (state.key === event.key && state.status === 'paused') return { status: 'playing', key: state.key, error: '' }
      if (state.key === event.key && state.status === 'loading') return state
      if (state.key === event.key && state.status === 'error') return { status: 'loading', key: event.key, error: '' }
      return { status: 'loading', key: event.key, error: '' }
    }
    case 'restart':
      return { status: 'loading', key: event.key, error: '' }
    case 'ended':
    case 'stop':
      return SPEECH_IDLE
    case 'error':
      return { status: 'error', key: state.key, error: String(event.error ?? '朗读失败') }
    default:
      return state
  }
}

/** 播放器抽象：浏览器里是 Web Audio 分块流水线，单测里是假的。 */
export interface SpeechPlayer {
  play(): Promise<void>
  pause(): void
  resume(): void
  restart(): void
  stop(): void
  onEnded(cb: () => void): void
  /** 真正开始出声（seek/restart 后也会再触发）：loading → playing 靠它。 */
  onPlaying?(cb: () => void): void
  /** 播放中途某块彻底失败（已重试过一次）时回调一次；控制器据此进 error 态给可见提示。 */
  onError?(cb: (message: string) => void): void
}

export type SpeechPlayerFactory = (key: string, text: string) => SpeechPlayer

/**
 * 朗读控制器：状态机 + 单一活动播放器（换 key 先停旧的 = 「切卡片停上一条」）。
 * React 侧用 useSyncExternalStore 订阅；单测里直接驱动事件。
 */
export function createSpeechController(factory: SpeechPlayerFactory) {
  let state: SpeechState = SPEECH_IDLE
  let player: SpeechPlayer | null = null
  let currentText = ''
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of [...listeners]) { try { listener() } catch {} } }
  const setState = (next: SpeechState): void => {
    if (next.status === state.status && next.key === state.key && next.error === state.error) return
    state = next
    emit()
  }

  const start = (key: string): void => {
    player?.stop()
    player = null
    currentText = ''
    const text = pendingText
    if (text === '') { setState(SPEECH_IDLE); return }
    currentText = text
    const next = factory(key, text)
    player = next
    next.onEnded(() => { if (player === next) { player = null; setState(reduceSpeech(state, { type: 'ended' })) } })
    try {
      next.onPlaying?.(() => { if (player === next && state.key === key) setState({ status: 'playing', key, error: '' }) })
    } catch { /* 播放器不支持 onPlaying 时靠 play() 的 Promise 兜底 */ }
    try {
      next.onError?.((message) => {
        if (player !== next) return
        player = null
        try { next.stop() } catch { /* 停不干净也不影响报错 */ }
        setState(reduceSpeech(state, { type: 'error', error: message }))
      })
    } catch { /* 播放器不支持 onError 时由 play() 的 Promise 兜底 */ }
    next.play()
      .then(() => { if (player === next) setState(reduceSpeech(state, { type: 'playing', key })) })
      .catch((error: unknown) => {
        if (player === next) { player = null; setState(reduceSpeech(state, { type: 'error', error: String((error as Error)?.message ?? error) })) }
      })
  }

  let pendingText = ''

  const api = {
    getSnapshot(): SpeechState { return state },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** 请求朗读一条内容（key 换 = 停上一条从头读；同 key 的 toggle 语义见状态机）。 */
    request(key: string, text: string): void {
      pendingText = text
      const before = state
      const next = reduceSpeech(state, { type: 'play', key })
      setState(next)
      if (next.key !== before.key || next.status === 'loading') start(key)
    },
    /**
     * 单击：暂停/继续；空闲/报错/换 key 时用**调用方传入的文本**起播。
     * text 必须是按钮所属卡片自己的规范化朗读文本 —— 绝不允许回退到
     * pendingText（那是「最后一次 request」的文本 = 自动朗读的最新一轮，
     * 历史卡点击会错读成最新一条，2026-11-21 实测 bug）。
     */
    toggle(key: string, text: string): void {
      if (state.key !== key || state.status === 'idle' || state.status === 'error') { api.request(key, text); return }
      if (state.status === 'loading') return
      if (state.status === 'playing') { player?.pause(); setState(reduceSpeech(state, { type: 'pause' })) }
      else if (state.status === 'paused') { player?.resume(); setState(reduceSpeech(state, { type: 'resume' })) }
    },
    /** 长按：从头发起（player 层 ensure 0 再播）。 */
    restart(key: string, text: string): void {
      if (state.key === key && player !== null) {
        setState(reduceSpeech(state, { type: 'restart', key }))
        player.restart() // 出声后由 onPlaying 把 loading → playing
        return
      }
      api.request(key, text)
    },
    stop(): void { player?.stop(); player = null; setState(SPEECH_IDLE) },
  }
  return api
}

/** ────────────────────────── 4. 轮文本收集（DOM 侧，客户端用） ────────────────────────── */

/**
 * 收集「某一轮」的秘书回复正文：同一 data-chat-turn 下、非 reasoning 的 assistant-step 文本。
 * 返回原文（未做朗读规范化；卡片展示用原文，朗读走 normalizeForSpeech）。
 *
 * 宿主已把 markdown 渲染成 DOM：`**重点**` 在页面上是 `<strong>重点</strong>`，直接读
 * textContent 会把星号丢掉，卡片就永远还原不出重点句。这里按节点序列化，把 strong/b
 * 重新包成 `**…**`，交给卡片自己的行内渲染（2026-11-21 卡片规范冒烟实测）。
 */
function stepTextWithEmphasis(el: any): string {
  const nodes = el?.childNodes ?? null
  if (nodes === null || nodes.length === 0) return String(el?.textContent ?? '')
  let out = ''
  for (const node of nodes) {
    if (node?.nodeType === 3) {
      out += String(node.textContent ?? '')
    } else if (node?.nodeType === 1) {
      const tag = String(node.tagName ?? '').toLowerCase()
      const inner = stepTextWithEmphasis(node)
      if (tag === 'strong' || tag === 'b') out += `**${inner}**`
      else if (tag === 'br') out += '\n'
      else out += inner
    }
  }
  return out
}

export function collectTurnText(doc: Document, turn: string): string {
  const out: string[] = []
  const turnNo = String(turn ?? '').trim()
  if (turnNo === '') return ''
  for (const el of doc.querySelectorAll(`[data-chat-turn="${turnNo}"][data-chat-flow-kind="assistant-step"]`)) {
    if (el.getAttribute('data-chat-group-part') === 'reasoning') continue
    const text = stepTextWithEmphasis(el).trim()
    if (text !== '') out.push(text)
  }
  return out.join('\n').trim()
}

/** 当前 DOM 里最大的轮次号（= 最末一轮；自动朗读只读它）。 */
export function latestTurnNo(doc: Document): string {
  let max = -1
  let out = ''
  for (const el of doc.querySelectorAll('[data-chat-turn]')) {
    const value = Number(el.getAttribute('data-chat-turn'))
    if (Number.isFinite(value) && value > max) { max = value; out = String(value) }
  }
  return out
}

/**
 * 最近一条**有正文的回复卡**轮次。合成通知若异常留下空白尾轮，
 * 自动朗读仍应读最后一条真实回复，不能被最大的 data-chat-turn 永久挡住。
 */
export function latestReplyTurnNo(doc: Document): string {
  let max = -1
  let out = ''
  for (const el of doc.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-turn]')) {
    if (el.getAttribute('data-dsh-scard-kind') === CARD_KIND_USER) continue
    if (el.getAttribute('data-empty') === '1') continue
    const value = Number(el.getAttribute('data-dsh-scard-turn'))
    if (Number.isFinite(value) && value > max) { max = value; out = String(value) }
  }
  return out
}

/** ────────────────────────── 5. 卡片呈现纯函数（node 可单测） ────────────────────────── */

/**
 * 主动卡胶囊色调：按 badge / 标题里的类型词归类，同类卡配色一致。
 *   主动关心 → care（暖橙）｜任务完成 → done（蓝）｜主动探索 → explore（紫）
 *   征求授权 → auth（红）｜默认主动服务 → serve（绿）
 */
export type BadgeTone = 'serve' | 'care' | 'done' | 'explore' | 'auth'
export function badgeTone(badge: string, title: string = ''): BadgeTone {
  const text = `${String(badge ?? '')} ${String(title ?? '')}`
  if (/授权|批准|确认/.test(text)) return 'auth'
  if (/完成|搞定|办结|交付/.test(text)) return 'done'
  if (/探索|发现|调研|找找|搜索/.test(text)) return 'explore'
  if (/关心|提醒|注意|建议|注意身体|出行|天气/.test(text)) return 'care'
  return 'serve'
}

/** 要点行拆分：「天气：武汉明日…」→ { prefix: '天气：', rest: '武汉明日…' }。
 *  前缀必须以汉字开头、不含数字（「10:30」这类时间不会被拆成前缀）。 */
export function splitItemPrefix(text: string): { prefix: string; rest: string } {
  const raw = String(text ?? '').trim()
  const match = raw.match(/^([一-鿿][^：:，,\d]{0,7}[：:])([\s\S]*)$/)
  if (match === null) return { prefix: '', rest: raw }
  return { prefix: match[1], rest: match[2].trim() }
}

/** 要点行小图标：按关键词给emoji（天气/车次/地点/时间），默认小圆点。 */
export function itemIcon(text: string): string {
  const raw = String(text ?? '')
  if (/天气|温度|气温|雨|雪|晴|阴|风/.test(raw)) return '🌤'
  if (/车|高铁|火车|航班|飞机|站|行程|出发|到达/.test(raw)) return '🚄'
  if (/地点|地址|会场|实验室|家里|公司|武汉|孝感/.test(raw)) return '📍'
  if (/时间|点钟|会议|截止|提醒|日程|安排/.test(raw)) return '🕐'
  return '·'
}

/** 一句话摘要：取首行、截断加省略号（旧主动卡仍可用）。 */
export function summarize(text: string, max = 22): string {
  const line = String(text ?? '').split('\n').map((s) => s.trim()).find((s) => s !== '') ?? ''
  const clean = line.replace(/\s+/g, ' ')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

export type AnswerTokenKind = 'text' | 'strong' | 'model'
export interface AnswerToken {
  kind: AnswerTokenKind
  value: string
}

const MODEL_NAME_RE = /\b(?:qwen[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|deepseek[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|glm(?:[-_.][A-Za-z0-9]+)*|kimi[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|llama[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|mistral[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|phi[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|gpt[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|claude[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|gemini[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|grok[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|IQ[1-9]_[A-Z][A-Z0-9]*|fp[1-9]\d*)\b/gi

/** 卡片正文解析：第一行做结论标题，其后按段落渲染；长首句退化为一句标题。 */
export function parseAnswerBody(text: string): { title: string; paragraphs: string[] } {
  const lines = String(text ?? '').split(/\n{2,}|\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return { title: '', paragraphs: [] }
  let [title, ...paragraphs] = lines
  if (title.length > 48) {
    const match = title.match(/^([\s\S]{1,48}?[。！？!?.])([\s\S]*)$/)
    if (match !== null) {
      title = match[1].trim()
      const rest = match[2].trim()
      if (rest !== '') paragraphs = [rest, ...paragraphs]
    }
  }
  return { title, paragraphs }
}

function splitStrongSegments(text: string): Array<{ kind: 'text' | 'strong'; value: string }> {
  const raw = String(text ?? '')
  const parts: Array<{ kind: 'text' | 'strong'; value: string }> = []
  const pattern = /\*\*([^*]+)\*\*/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) parts.push({ kind: 'text', value: raw.slice(cursor, match.index) })
    if (match[1] !== '') parts.push({ kind: 'strong', value: match[1] })
    cursor = match.index + match[0].length
  }
  if (cursor < raw.length) parts.push({ kind: 'text', value: raw.slice(cursor) })
  return parts
}

function splitModelTokens(text: string): AnswerToken[] {
  const raw = String(text ?? '')
  const tokens: AnswerToken[] = []
  const pattern = new RegExp(MODEL_NAME_RE.source, MODEL_NAME_RE.flags)
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) tokens.push({ kind: 'text', value: raw.slice(cursor, match.index) })
    tokens.push({ kind: 'model', value: match[0] })
    cursor = match.index + match[0].length
    if (match[0] === '') pattern.lastIndex += 1
  }
  if (cursor < raw.length) tokens.push({ kind: 'text', value: raw.slice(cursor) })
  return tokens
}

/** 行内渲染计划：重点句用 strong，模型名/量化版本用 model-code 标签。 */
export function answerInlineTokens(text: string): AnswerToken[] {
  return splitStrongSegments(text).flatMap((segment) => (
    segment.kind === 'strong' ? [{ kind: 'strong' as const, value: segment.value }] : splitModelTokens(segment.value)
  )).filter((token) => token.value !== '')
}

/** ISO/时间戳 → 卡片脚部时间（2026-11-21 用户改需求）：**只写时间**，不再带「今天」字样。
 *  当天 → `H:MM`（例 9:08，小时不补零、分钟补零）；昨天 → `昨天 H:MM`；更早 → `M月d日 H:MM`。
 *  解析不了回空串（脚部就不显示时间）。 */
export function formatClock(input: unknown, now: Date = new Date()): string {
  const raw = String(input ?? '').trim()
  if (raw === '') return ''
  const date = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const hm = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOf(now) - startOf(date)) / 86400000)
  if (dayDiff <= 0) return hm
  if (dayDiff === 1) return `昨天 ${hm}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
}

/** ─────────────── 6. 用户卡（秘书页真实用户消息）纯函数 ─────────────── */

/** 卡壳主题标识：秘书回复卡 kind=assistant（紫）、用户卡 kind=user（冷蓝）、通知卡 kind=notice（中性灰）。 */
export const CARD_KIND_ASSISTANT = 'assistant'
export const CARD_KIND_USER = 'user'
export const CARD_KIND_NOTICE = 'notice'

/**
 * 折叠态预算（2026-11-22 用户实测反馈改口径）：三种卡共用，折叠态最多 **3 行正文**（不是 3 个内容块）。
 *
 * 旧口径是「卡标题不参与预算、永远露出」——手机上一条长回复的整段首段会被排版成 230–255px 的标题块，
 * 于是折叠落点变成「首段全部 + 3 行正文」：现网实测 max-height 321–346px、卡高 456–481px（844px 高的
 * 手机 WebView 里就是「整段平铺、占满屏」）。还有更糟的：整条回复只有一段连续文字时正文块只剩标题一个，
 * 旧算法 `bodyBlocks.length === 0` 直接判「不溢出」→ 完全没有折叠、连「展开全文」入口都不渲染。
 *
 * 新口径：卡标题也进预算（最多 2 行，超出被自己裁掉），折叠高度由此固定；判据全部是**内容高度**
 * （offsetTop / offsetHeight / scrollHeight），不在任何地方按字符数算，字号或行高变了也稳。
 */
export const FOLD_BODY_LINE_BUDGET = 3
/** 折叠态卡标题最多几行（超出被行夹裁掉，展开态整段放开）。 */
export const FOLD_TITLE_LINE_BUDGET = 2
/** 卡片内正文块之间的距离（与 CSS 的 content gap 一致）。 */
export const FOLD_BLOCK_GAP = 10
/** 行高量不出来时的兜底行高（正文 15px / 1.8 = 27px）：量不到也必须折叠，绝不留下平铺状态。 */
export const FOLD_FALLBACK_LINE_HEIGHT_PX = 27

/** 一个正文块在卡片正文里的位置（offsetTop）与高度（offsetHeight）——浏览器量的，纯函数只管算术。 */
export interface FoldBlockBox {
  /** title = 卡标题（折叠态最多 2 行，也计入预算）；para = 正文段落；ref = 会话引用 chip。 */
  kind: 'title' | 'para' | 'ref'
  top: number
  height: number
}

export interface FoldGeometryOut {
  /** 折叠态正文的 max-height（px）；不溢出就是 undefined（正文自然高度）。 */
  collapsedMaxHeight: number | undefined
  /** 正文是不是被预算切掉了（决定「…」省略标记与「展开全文」入口）。 */
  overflow: boolean
  /** 折叠态实际露出的正文行数（<= budget）。 */
  bodyLines: number
  /** 切掉的行箱落点（px）；未溢出时 = 自然高度。 */
  clip: number
  /** 这张卡折叠态的固定上限（px）：标题行数 + 正文行数 + 块间距，测量退化时也用它兜底。 */
  cap: number
}

/**
 * 折叠态固定上限（纯算术，CSS 兜底与测试都引用这一个数）：
 *   有标题：`titleBudget * 标题行高 + gap + budget * 正文行高 + gap * (budget - 1)`
 *   没标题（用户卡只有段落）：`budget * 正文行高 + gap * (budget - 1)`
 * 现网标准字号（标题 17px/1.5、正文 15px/1.8）→ 51 + 10 + 81 + 20 = **162px**。
 */
export function foldCollapsedCapPx(input: {
  lineHeight: number
  titleLineHeight?: number
  hasTitle?: boolean
  budget?: number
  titleBudget?: number
  gap?: number
}): number {
  const budget = Math.max(1, Number(input.budget ?? FOLD_BODY_LINE_BUDGET))
  const titleBudget = Math.max(1, Number(input.titleBudget ?? FOLD_TITLE_LINE_BUDGET))
  const gap = Math.max(0, Number(input.gap ?? FOLD_BLOCK_GAP))
  const lineHeightRaw = Number(input.lineHeight)
  const lineHeight = Number.isFinite(lineHeightRaw) && lineHeightRaw > 0 ? lineHeightRaw : FOLD_FALLBACK_LINE_HEIGHT_PX
  const titleLineRaw = Number(input.titleLineHeight)
  const titleLine = Number.isFinite(titleLineRaw) && titleLineRaw > 0 ? titleLineRaw : lineHeight
  const bodyPart = budget * lineHeight + gap * (budget - 1)
  const titlePart = input.hasTitle === true ? titleBudget * titleLine + gap : 0
  return Math.max(1, Math.round(titlePart + bodyPart))
}

/**
 * 折叠落点 → 卡体内联样式（三种卡共用一套，纯函数，测试直接验它）：
 *   - 展开态：显式放开（CSS 里也有一条 `max-height:none !important`）；
 *   - **还没量过**：什么都不写，让 CSS 那条首帧固定上限（162px）先顶住，卡片挂载到测量之间的那一帧不会整段平铺；
 *   - 量过且判定不溢出：显式写 none 放开，盖掉 CSS 的首帧上限（短卡就该整张显示）。
 */
export function cardFoldStyle(open: boolean, measured: boolean, collapsedMaxHeight: number | undefined): { maxHeight: string } | undefined {
  if (open) return { maxHeight: 'none' }
  if (!measured) return undefined
  if (collapsedMaxHeight === undefined) return { maxHeight: 'none' }
  return { maxHeight: `${collapsedMaxHeight}px` }
}

/**
 * 折叠几何（三种卡共用一套算术，浏览器只负责量块的位置，算法在这里）：
 *   - 卡标题按自己的行高进预算（最多 titleBudget 行，落点停在第 titleBudget 行的行尾）；
 *   - 段落按行高累加，落点正好停在第 `budget` 行的行尾，绝不切出半行字；
 *   - 引用 chip 算一整块（不可切一半）；
 *   - 块与块之间的距离按 top 天然算进高度，落点再由 `foldCollapsedCapPx` 封顶；
 *   - `titleClippedHidden`：标题被 CSS 行夹裁掉但 scrollHeight 还留着全文 → 这种卡必须折叠。
 */
export function foldClipFromBlocks(input: {
  blocks: readonly FoldBlockBox[]
  naturalHeight: number
  lineHeight: number
  titleLineHeight?: number
  titleClippedHidden?: boolean
  budget?: number
  titleBudget?: number
}): FoldGeometryOut {
  const budget = Math.max(1, Number(input.budget ?? FOLD_BODY_LINE_BUDGET))
  const titleBudget = Math.max(1, Number(input.titleBudget ?? FOLD_TITLE_LINE_BUDGET))
  const lineHeightRaw = Number(input.lineHeight)
  // 行高量不出来（字体还没落、块被宿主藏起来）也要按兜底行高折叠，不许因为量不到就平铺
  const lineHeight = Number.isFinite(lineHeightRaw) && lineHeightRaw > 0 ? lineHeightRaw : FOLD_FALLBACK_LINE_HEIGHT_PX
  const titleLineRaw = Number(input.titleLineHeight)
  const titleLine = Number.isFinite(titleLineRaw) && titleLineRaw > 0 ? titleLineRaw : lineHeight
  const natural = Math.max(1, Math.round(Number(input.naturalHeight) || 1))
  const hasTitle = input.blocks.some((block) => block.kind === 'title')
  const cap = foldCollapsedCapPx({ lineHeight, titleLineHeight: titleLine, hasTitle, budget, titleBudget })
  if (input.blocks.length === 0) return { collapsedMaxHeight: undefined, overflow: false, bodyLines: 0, clip: natural, cap }

  let bodyLines = 0
  let titleLines = 0
  let lastBottom = 0
  let clip: number | undefined
  for (const block of input.blocks) {
    const isTitle = block.kind === 'title'
    const unit = isTitle ? titleLine : lineHeight
    const top = Math.max(0, Math.round(block.top))
    const height = Math.max(1, Math.round(block.height || unit))
    const lines = block.kind === 'ref' ? 1 : Math.max(1, Math.round(height / unit))
    const allowance = isTitle ? titleBudget : budget
    const used = isTitle ? titleLines : bodyLines
    const remaining = allowance - used
    if (remaining <= 0) { clip = lastBottom > 0 ? lastBottom : top; break }
    if (lines <= remaining) {
      if (isTitle) titleLines += lines
      else bodyLines += lines
      lastBottom = top + height
      continue
    }
    clip = top + remaining * unit
    if (isTitle) titleLines = allowance
    else bodyLines = allowance
    break
  }
  const titleClipped = input.titleClippedHidden === true
  if (clip === undefined) {
    // 全部块都放得下：只有「标题被行夹裁掉」这一种情况还得折叠（长卡只有首段的极端情形）
    if (!titleClipped) return { collapsedMaxHeight: undefined, overflow: false, bodyLines, clip: natural, cap }
    clip = lastBottom > 0 ? lastBottom : cap
  }
  const maxHeight = Math.max(1, Math.min(Math.round(clip), cap, natural))
  const overflow = maxHeight < natural - 1 || titleClipped
  return { collapsedMaxHeight: overflow ? maxHeight : undefined, overflow, bodyLines, clip: maxHeight, cap }
}


// 合成通知判据（NOTICE_HEAD_LINE_RE / NOTICE_SESSION_REF_LINE_RE / isSyntheticNoticeUserText）
// 与卡片 key 口径都在 src/secretary-card-shared.ts：宿主分页路由与客户端必须算出同一张卡。

/** 用户卡正文：显示用户原文（不做标题化、不改写、不删行），按空行分段。 */
export function parseUserCardBody(raw: string): string[] {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (text === '') return []
  return text.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== '')
}

/** 朗读 key（userCardSpeechKey / noticeCardSpeechKey / assistantCardSpeechKey）与
 *  通知卡正文剥头（stripNoticeSyntheticHead）都在 src/secretary-card-shared.ts，从那儿 re-export 上来。 */

/** 通知卡正文解析：与秘书回复卡同一套（首行做标题、其余段落），引用标记单独成 chip。 */
export function parseNoticeCardBody(raw: string): { title: string; paragraphs: string[] } {
  return parseAnswerBody(stripNoticeSyntheticHead(raw))
}

/** 底行时间：宿主操作行的时间文本 → 卡片脚部只写时间（去掉「今天」字样；已是「昨天 …」/「11月20日 …」原样用）。 */
export function formatUserCardClock(clockText: unknown): string {
  const raw = String(clockText ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return ''
  const stripped = raw.replace(/^今天\s+/, '')
  const match = stripped.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  return match === null ? stripped : stripped
}

export interface SecretaryUserRow {
  /** 卡片要挂进的那条宿主用户行（portal 容器）。 */
  element: Element
  /** 稳定 key（宿主的 data-chat-node-key / data-chat-flow-key，含消息 id）。 */
  key: string
  turnNo: string
  /** 用户原文（取自宿主纯文本 run）。 */
  text: string
  /** 宿主操作行上的时间文本（已按卡片规则格式化前）。 */
  clockText: string
}

/** 秘书页里那些「user 角色」行的分类：真实用户输入 → 冷蓝用户卡；插件塞进来的合成通知 → 灰底通知卡。 */
export type SecretaryCardKind = typeof CARD_KIND_USER | typeof CARD_KIND_NOTICE
export interface SecretaryCardRow extends SecretaryUserRow {
  kind: SecretaryCardKind
}

/**
 * 收集秘书页对话流里**所有 user 角色的行**并分类：
 *   - 只认宿主稳定语义标记 `[data-chat-flow-kind="user"]`；
 *   - 合成通知（系统通知 / `[[session:]]` 引用行）标成 notice（灰底通知卡，带可点引用 chip）；
 *   - 真实用户消息标成 user（冷蓝用户卡）；
 *   - 文本从 `[data-slot="conversation.user.text.node"]` 读，卡片自身挂在行上，不会把自己读回去。
 */
export function collectSecretaryCardRows(doc: Document): SecretaryCardRow[] {
  const out: SecretaryCardRow[] = []
  for (const row of doc.querySelectorAll('[data-chat-flow-kind="user"]')) {
    const key = row.getAttribute('data-chat-node-key') ?? row.getAttribute('data-chat-flow-key') ?? ''
    const turnNo = row.getAttribute('data-chat-turn') ?? ''
    const textEl = row.querySelector('[data-slot="conversation.user.text.node"]')
    const text = String(textEl?.textContent ?? '').trim()
    if (text === '') continue
    const clockEl = row.querySelector('[data-clock]')
    const kind: SecretaryCardKind = isSyntheticNoticeUserText(text) ? CARD_KIND_NOTICE : CARD_KIND_USER
    out.push({ element: row, key, turnNo, text, clockText: String(clockEl?.textContent ?? '').trim(), kind })
  }
  return out
}

/** 只取真实用户行（冷蓝用户卡用）；判据与 collectSecretaryCardRows 同一套，防止三条路径串味。 */
export function collectSecretaryUserRows(doc: Document): SecretaryUserRow[] {
  return collectSecretaryCardRows(doc).filter((row) => row.kind === CARD_KIND_USER)
}

/**
 * 扫描层：把页面上**已经挂出来的三种卡**（完整卡或折叠行）按 document 顺序送回来。
 * document 顺序就是宿主对话流的时间顺序；分页窗口（最近 N 张）与折叠行都靠它算，
 * 一张卡从完整卡换成折叠行不会改变顺序（同一张卡带同一个 key）。
 */
export interface SecretaryScannedCard extends PagerDomCard {
  element: Element
}

export function collectSecretaryCardElements(doc: Document): SecretaryScannedCard[] {
  const out: SecretaryScannedCard[] = []
  for (const element of doc.querySelectorAll('[data-dsh-scard="card"], [data-dsh-scard="collapsed-row"]')) {
    const cardKey = String(element.getAttribute('data-dsh-scard-key') ?? '').trim()
    const kind = String(element.getAttribute('data-dsh-scard-kind') ?? '').trim()
    const turnNo = String(element.getAttribute('data-dsh-scard-turn') ?? '').trim()
    if (cardKey === '' || kind === '') continue
    let text = ''
    let timeText = ''
    if (kind === CARD_KIND_USER || kind === CARD_KIND_NOTICE) {
      const row = element.closest('[data-chat-flow-kind="user"]') ?? element
      text = String(row.querySelector('[data-slot="conversation.user.text.node"]')?.textContent ?? '').trim()
      timeText = formatUserCardClock(row.querySelector('[data-clock]')?.textContent ?? '')
    } else {
      text = collectTurnText(doc, turnNo)
    }
    out.push({ element, cardKey, kind, turnNo, text, timeText })
  }
  return out
}

/** ─────────────── 7. 已读卡集合（未读红点的持久化） ─────────────── */

/** 宿主侧「已读卡」路由（服务端 src/assistant-secretary.ts 注册同一字符串）。 */
export const ASSISTANT_SECRETARY_READ_ROUTE = '/api/assistant/secretary-read'
/** 本地缓存键前缀（真值仍在宿主，localStorage 只是宿主答不上时的降级缓存）。 */
export const READ_STORAGE_PREFIX = 'dsh.assistant.secretary.read:'
/** 每个会话最多记多少条已读 cardKey（去噪：写满就把最旧的一条丢掉）。 */
export const MAX_READ_KEYS = 400
const CARD_KEY_RE = /^[A-Za-z0-9:._#-]{1,200}$/

/**
 * 扫描层（分页窗口用）：把「这条会话里会挂出来的卡」按时间顺序登记进 store。
 * 用户/通知卡来自宿主用户行，秘书卡来自宿主轮次（`[data-chat-turn]` 顺序 + 本轮真有正文的才算一张卡）；
 * 轮内顺序固定：用户/通知卡在前、秘书回复卡在尾（turnTail 就是这个位置）。
 * 首帧就把窗口算全，避免「先渲染 137 张完整卡、400ms 后才压成折叠行」的 DOM 抖动。
 */
export function buildSecretaryPagerCards(doc: Document): PagerDomCard[] {
  const rows = collectSecretaryCardRows(doc).map((row) => ({
    cardKey: row.kind === CARD_KIND_NOTICE ? noticeCardSpeechKey(row.key, row.turnNo) : userCardSpeechKey(row.key, row.turnNo),
    kind: row.kind,
    turnNo: row.turnNo,
    text: row.text,
    timeText: formatUserCardClock(row.clockText),
  }))
  const mountedAssistant = collectSecretaryCardElements(doc).filter((card) => card.kind === CARD_KIND_ASSISTANT)
  const turnOrder: string[] = []
  for (const element of doc.querySelectorAll('[data-chat-turn]')) {
    const turnNo = String(element.getAttribute('data-chat-turn') ?? '')
    if (turnNo === '' || turnOrder.includes(turnNo)) continue
    turnOrder.push(turnNo)
  }
  const out: PagerDomCard[] = []
  const used = new Set<string>()
  for (const turnNo of turnOrder) {
    for (const card of rows.filter((row) => row.turnNo === turnNo)) {
      if (used.has(card.cardKey)) continue
      used.add(card.cardKey)
      out.push(card)
    }
    const mounted = mountedAssistant.find((card) => card.turnNo === turnNo)
    if (mounted !== undefined) {
      if (!used.has(mounted.cardKey)) { used.add(mounted.cardKey); out.push({ cardKey: mounted.cardKey, kind: mounted.kind, turnNo: mounted.turnNo, text: mounted.text, timeText: mounted.timeText }) }
      continue
    }
    const text = collectTurnText(doc, turnNo)
    if (text === '') continue
    const key = assistantCardSpeechKey(turnNo)
    if (used.has(key)) continue
    used.add(key)
    out.push({ cardKey: key, kind: CARD_KIND_ASSISTANT, turnNo, text, timeText: '' })
  }
  for (const card of rows) {
    if (used.has(card.cardKey)) continue
    used.add(card.cardKey)
    out.push(card)
  }
  for (const card of mountedAssistant) {
    if (used.has(card.cardKey)) continue
    used.add(card.cardKey)
    out.push({ cardKey: card.cardKey, kind: card.kind, turnNo: card.turnNo, text: card.text, timeText: card.timeText })
  }
  return out
}

/** 归一一条 cardKey：只接受 key 形态，别的（空、超长、带空格）一律判坏。 */
export function normalizeCardKey(raw: unknown): string {
  const value = String(raw ?? '').trim()
  return CARD_KEY_RE.test(value) ? value : ''
}

/** 归一宿主/缓存送来的已读集合：坏值丢掉，按序去重，截到上限（保留最新的）。 */
export function normalizeReadKeys(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const out: string[] = []
  for (const item of list) {
    const key = normalizeCardKey(item)
    if (key === '' || out.includes(key)) continue
    out.push(key)
  }
  return out.length > MAX_READ_KEYS ? out.slice(out.length - MAX_READ_KEYS) : out
}

export interface SecretaryReadDeps {
  /** 浏览器里是 window.fetch；单测里是假实现。缺 → 按「宿主答不上」降级。 */
  fetchImpl?: (url: string, init?: any) => Promise<any>
  /** 本地兜底缓存（宿主答不上时还能立刻知道已读）；缺 → 只用心跳集合。 */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null
}

export interface SecretaryReadStore {
  session(): string
  setSession(sessionId: string): void
  isRead(cardKey: string): boolean
  /** 标记已读：立刻本地生效（红点当场消失），再写缓存 + 落宿主；宿主失败不阻塞。 */
  markRead(cardKey: string): boolean
  /** 取宿主已读集合（先宿主、再叠本地缓存）；宿主答不上时按本地缓存继续。 */
  hydrate(): Promise<{ ok: boolean; hostOk: boolean; count: number }>
  subscribe(listener: () => void): () => void
  /** useSyncExternalStore 的快照：一个版本号（卡片用它订阅，再问 isRead）。 */
  getVersion(): number
  keys(): string[]
}

export function createSecretaryReadStore(deps: SecretaryReadDeps = {}): SecretaryReadStore {
  const read = new Set<string>()
  const order: string[] = []
  const listeners = new Set<() => void>()
  const storageKey = READ_STORAGE_PREFIX
  let session = ''
  let version = 0
  let hydrateCall: Promise<{ ok: boolean; hostOk: boolean; count: number }> | null = null
  /** 宿主没答上过（404/网络失败）就别再反复打；本地缓存仍是权威兜底。 */
  let hostBroken = false

  const emit = (): void => { for (const listener of [...listeners]) { try { listener() } catch { /* 单个订阅者出错不影响别的 */ } } }
  const bump = (): void => { version += 1; emit() }
  const add = (cardKey: string): boolean => {
    const key = normalizeCardKey(cardKey)
    if (key === '' || read.has(key)) return false
    read.add(key)
    order.push(key)
    while (order.length > MAX_READ_KEYS) {
      const oldest = order.shift() ?? ''
      if (oldest !== '') read.delete(oldest)
    }
    return true
  }
  const addAll = (keys: readonly string[]): number => {
    let added = 0
    for (const key of keys) if (add(key)) added += 1
    if (added > 0) bump()
    return added
  }
  const storage = deps.storage ?? null
  const readCache = (): string[] => {
    if (storage === null || session === '') return []
    try { return normalizeReadKeys(JSON.parse(String(storage.getItem(`${storageKey}${session}`) ?? '[]')) as unknown) } catch { return [] }
  }
  const writeCache = (): void => {
    if (storage === null || session === '') return
    try { storage.setItem(`${storageKey}${session}`, JSON.stringify(order.slice(-MAX_READ_KEYS))) } catch { /* 缓存写不进去就靠集合内存 */ }
  }
  const postRead = (cardKey: string): void => {
    const fetchImpl = deps.fetchImpl
    if (hostBroken || typeof fetchImpl !== 'function' || session === '') return
    void Promise.resolve(fetchImpl(ASSISTANT_SECRETARY_READ_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session, cardKey, mark: 'read' }),
    })).then((res: any) => {
      if (res?.ok !== true) { hostBroken = true; return }
      return res.json?.().then((payload: any) => { if (payload?.ok !== true) hostBroken = true })
    }).catch(() => { hostBroken = true })
  }

  return {
    session: () => session,
    setSession(sessionId: string): void {
      const id = String(sessionId ?? '').trim()
      if (id === session) return
      session = id
      hydrateCall = null
      addAll(readCache())
    },
    isRead(cardKey: string): boolean {
      const key = normalizeCardKey(cardKey)
      return key !== '' && read.has(key)
    },
    markRead(cardKey: string): boolean {
      const key = normalizeCardKey(cardKey)
      if (key === '') return false
      if (read.has(key)) return true
      add(key)
      bump()
      writeCache()
      postRead(key)
      return true
    },
    hydrate(): Promise<{ ok: boolean; hostOk: boolean; count: number }> {
      if (hydrateCall !== null) return hydrateCall
      hydrateCall = (async (): Promise<{ ok: boolean; hostOk: boolean; count: number }> => {
        addAll(readCache())
        const fetchImpl = deps.fetchImpl
        if (hostBroken || session === '' || typeof fetchImpl !== 'function') {
          return { ok: true, hostOk: false, count: order.length }
        }
        try {
          const res = await fetchImpl(`${ASSISTANT_SECRETARY_READ_ROUTE}?sessionId=${encodeURIComponent(session)}`, { cache: 'no-store' })
          if (res?.ok !== true) { hostBroken = true; return { ok: true, hostOk: false, count: order.length } }
          const payload = await res.json()
          const hostKeys = normalizeReadKeys((payload as any)?.cards)
          if ((payload as any)?.ok !== true) { hostBroken = true; return { ok: true, hostOk: false, count: order.length } }
          addAll(hostKeys)
          writeCache()
          return { ok: true, hostOk: true, count: order.length }
        } catch {
          hostBroken = true
          return { ok: true, hostOk: false, count: order.length }
        }
      })()
      return hydrateCall
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    getVersion(): number { return version },
    keys(): string[] { return [...order] },
  }
}

/**
 * 卡片组件共用的**进程内已读 store**（懒创建）：真值在宿主 `/api/assistant/secretary-read`，
 * localStorage 只是首屏缓存与宿主答不上时的兜底；node 环境（没有 fetch/localStorage）不会去要。
 */
let cardReadStore: SecretaryReadStore | null = null
export function secretaryReadStore(): SecretaryReadStore {
  if (cardReadStore !== null) return cardReadStore
  const g: any = globalThis as any
  const fetchImpl = typeof g.fetch === 'function' ? (url: string, init?: any) => g.fetch(url, init) : undefined
  let storage: SecretaryReadDeps['storage'] = null
  try { if (g.localStorage && typeof g.localStorage.getItem === 'function') storage = g.localStorage } catch { storage = null }
  cardReadStore = createSecretaryReadStore({ fetchImpl, storage })
  return cardReadStore
}

/** 单测入口（node 直驱状态机与纯函数）。 */
/* ────────────────────────── 8. 卡片分页（第四批需求 A） ────────────────────────── */

/** 分页取数只走这条宿主接口（客户端绝不为分页把整条会话读回来）。 */
export const ASSISTANT_SECRETARY_HISTORY_ROUTE = '/api/assistant/secretary/history'

/** 宿主一页里给回来的卡片元数据（seq 是游标，preview 给折叠行点击时的原始文本预览）。 */
export interface PagerCardMeta {
  cardKey: string
  seq: number
  kind: string
  turnNo: string
  title: string
  preview: string
  time: number
}

/** DOM 扫描送来的卡（旧→新顺序，扫描层自己算）。 */
export interface PagerDomCard {
  cardKey: string
  kind: string
  turnNo: string
  text: string
  timeText: string
}

export interface SecretaryPagerDeps {
  /** 浏览器里是 window.fetch；单测里是假实现。缺 → 走 DOM 顺序降级，仍然只渲染有上限的一段。 */
  fetchImpl?: (url: string, init?: any) => Promise<any>
  windowSize?: number
  pageSize?: number
  cap?: number
}

export interface SecretaryPagerSnapshot {
  sessionId: string
  source: string
  windowSize: number
  renderedCount: number
  capped: boolean
  hasMore: boolean
  loading: boolean
  windowInitialized: boolean
  cursorSeq: number
  expandedBatches: number
}

/** 折叠行的短标题：同一输入永远得到同一标题（口径在 shared，宿主分页也算同一个）。 */
export function collapsedCardTitle(domText: string, hostTitle = ''): string {
  const fromHost = String(hostTitle ?? '').trim()
  if (fromHost !== '') return fromHost
  return truncateCardTitle(domText)
}

/** 上滚后保持原滚动位置不跳：新渲染把更旧的内容插到顶部，就要把 scrollTop 补回增量。 */
export function scrollAnchorTopPatch(beforeScrollHeight: number, afterScrollHeight: number): number {
  const delta = Math.round(Number(afterScrollHeight) - Number(beforeScrollHeight))
  return delta > 0 ? delta : 0
}

export function createSecretaryPager(deps: SecretaryPagerDeps = {}): SecretaryPagerStore {
  const baseWindowSize = Math.max(1, Number(deps.windowSize) || CARD_WINDOW_DEFAULT)
  const pageSize = Math.max(1, Number(deps.pageSize) || CARD_PAGE_SIZE)
  const cap = Math.max(baseWindowSize, Number(deps.cap) || CARD_RENDER_CAP)

  const listeners = new Set<() => void>()
  let version = 0
  let sessionId = ''
  let domOrder: string[] = []
  const domCards = new Map<string, PagerDomCard>()
  const metas = new Map<string, PagerCardMeta>()
  let windowSize = baseWindowSize
  let windowInitialized = false
  let cursorSeq = 0
  let hasMore = true
  let loadingCall: Promise<any> | null = null
  let source = 'dom'
  let expandedBatches = 0
  let capped = false

  const emit = (): void => { for (const listener of [...listeners]) { try { listener() } catch { /* 单个订阅者出错不影响别的 */ } } }
  const bump = (): void => { version += 1; emit() }

  const rankFromNewest = (cardKey: string): number => {
    const index = domOrder.indexOf(cardKey)
    if (index === -1) return -1
    return domOrder.length - 1 - index
  }

  const isCappedNow = (): boolean => windowSize >= cap || !canRenderMore(windowSize)

  const applyPage = (page: any, oldestSide: boolean): number => {
    const items: PagerCardMeta[] = []
    const rawItems = Array.isArray(page?.items) ? page.items : []
    for (const raw of rawItems) {
      const cardKey = String(raw?.cardKey ?? '').trim()
      if (cardKey === '') continue
      const meta: PagerCardMeta = {
        cardKey,
        seq: Number(raw?.seq) || 0,
        kind: String(raw?.kind ?? ''),
        turnNo: String(raw?.turn ?? ''),
        title: String(raw?.title ?? ''),
        preview: String(raw?.preview ?? ''),
        time: Number(raw?.time) || 0,
      }
      metas.set(cardKey, meta)
      items.push(meta)
    }
    const reportedCursor = Number(page?.nextBefore) || 0
    if (oldestSide && reportedCursor > 0) cursorSeq = reportedCursor
    else if (items.length > 0) {
      const oldest = Math.min(...items.map((item) => item.seq))
      if (oldest > 0) cursorSeq = oldest
    }
    if (typeof page?.hasMore === 'boolean') hasMore = page.hasMore
    return items.length
  }

  const fetchPage = async (before: number | undefined): Promise<{ ok: boolean; error: string; page: any }> => {
    const fetchImpl = deps.fetchImpl
    if (typeof fetchImpl !== 'function' || sessionId === '') return { ok: false, error: 'no fetch', page: null }
    const params = [`sessionId=${encodeURIComponent(sessionId)}`, `limit=${normalizeHistoryLimit(pageSize)}`]
    if (before !== undefined) params.push(`before=${encodeURIComponent(String(before))}`)
    const url = `${ASSISTANT_SECRETARY_HISTORY_ROUTE}?${params.join('&')}`
    try {
      const res = await fetchImpl(url, { cache: 'no-store' })
      if (res?.ok !== true) return { ok: false, error: `status:${res?.status ?? 'unknown'}`, page: null }
      const payload = await res.json()
      if (payload?.ok !== true) return { ok: false, error: 'payload-not-ok', page: null }
      return { ok: true, error: '', page: payload.page ?? null }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), page: null }
    }
  }

  return {
    session: () => sessionId,
    setSession(next: string): void {
      const id = String(next ?? '').trim()
      if (id === sessionId) return
      sessionId = id
      windowInitialized = false
      windowSize = baseWindowSize
      domOrder = []
      domCards.clear()
      metas.clear()
      cursorSeq = 0
      hasMore = true
      expandedBatches = 0
      capped = false
      loadingCall = null
      source = 'dom'
      bump()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getVersion(): number { return version },
    ensureWindow(): Promise<{ ok: boolean; source: string; cards: number; backfilled: boolean; error: string }> {
      if (loadingCall !== null) return loadingCall as any
      const run = async (): Promise<{ ok: boolean; source: string; cards: number; backfilled: boolean; error: string }> => {
        if (windowInitialized) return { ok: true, source, cards: windowSize, backfilled: false, error: '' }
        const fetched = await fetchPage(undefined)
        if (fetched.ok) {
          const cards = applyPage(fetched.page, false)
          source = 'host'
          windowInitialized = true
          bump()
          return { ok: true, source, cards, backfilled: false, error: '' }
        }
        // 宿主答不上（例如 401/404）也照样分页：按 DOM 顺序只渲染最近 windowSize 张，不去读整条会话
        source = 'dom'
        windowInitialized = true
        hasMore = domOrder.length > windowSize
        bump()
        return { ok: false, source, cards: 0, backfilled: false, error: fetched.error }
      }
      loadingCall = run().then((result) => { loadingCall = null; return result }, () => { loadingCall = null; return { ok: false, source: 'dom', cards: 0, backfilled: false, error: 'fetch-failed' } })
      return loadingCall as any
    },
    noteDomCards(cards: readonly PagerDomCard[]): void {
      let changed = false
      const order: string[] = []
      for (const card of cards) {
        const key = String(card?.cardKey ?? '').trim()
        if (key === '') continue
        order.push(key)
        const previous = domCards.get(key)
        if (previous === undefined || previous.text !== card.text || previous.timeText !== card.timeText || previous.kind !== card.kind) {
          domCards.set(key, { cardKey: key, kind: card.kind, turnNo: card.turnNo, text: card.text, timeText: card.timeText })
          changed = true
        }
      }
      if (order.join('|') !== domOrder.join('|')) { domOrder = order; changed = true }
      if (changed) bump()
      if (!windowInitialized && loadingCall === null && domOrder.length > 0) void this.ensureWindow()
    },
    windowSize(): number { return windowSize },
    isFullCard(cardKey: string): boolean {
      const rank = rankFromNewest(cardKey)
      if (rank === -1) return true
      return rank < windowSize
    },
    isCollapsedCard(cardKey: string): boolean {
      const rank = rankFromNewest(cardKey)
      if (rank === -1) return false
      return rank >= windowSize
    },
    collapsedTitle(cardKey: string): string {
      const meta = metas.get(cardKey)
      return collapsedCardTitle(domCards.get(cardKey)?.text ?? '', meta?.title ?? '')
    },
    previewText(cardKey: string): string {
      const meta = metas.get(cardKey)
      if (meta !== undefined && meta.preview !== '') return meta.preview
      return truncatePreview(domCards.get(cardKey)?.text ?? '')
    },
    expandOlder(): Promise<{ ok: boolean; added: number; capped: boolean; hasMore: boolean; source: string; windowSize: number }> {
      if (loadingCall !== null) return loadingCall as any
      if (isCappedNow()) {
        capped = true
        bump()
        return Promise.resolve({ ok: false, added: 0, capped: true, hasMore, source, windowSize })
      }
      const run = async (): Promise<{ ok: boolean; added: number; capped: boolean; hasMore: boolean; source: string; windowSize: number }> => {
        let added = 0
        let ok = false
        if (source === 'host' && cursorSeq > 0) {
          const fetched = await fetchPage(cursorSeq)
          if (fetched.ok) {
            ok = true
            added = applyPage(fetched.page, true)
          } else {
            hasMore = domOrder.length > windowSize
          }
        } else {
          // 没有宿主游标（宿主不通或还没拿到第一页）：只把 DOM 里更旧的这一段展开，不读全量
          ok = false
          hasMore = domOrder.length > windowSize
        }
        const next = Math.min(cap, windowSize + pageSize)
        added = Math.max(added, Math.min(pageSize, Math.max(0, domOrder.length - windowSize)))
        windowSize = next
        expandedBatches += 1
        capped = isCappedNow()
        if (capped) hasMore = false
        bump()
        return { ok, added, capped, hasMore, source, windowSize }
      }
      loadingCall = run().then((result) => { loadingCall = null; return result }, () => { loadingCall = null; return { ok: false, added: 0, capped, hasMore, source, windowSize } })
      return loadingCall as any
    },
    renderedCount(): number {
      const known = domOrder.length === 0 ? windowSize : Math.min(windowSize, domOrder.length)
      return Math.max(0, Math.min(known, cap))
    },
    isCapped(): boolean { return capped },
    hintVisible(): boolean { return capped || (!hasMore && domOrder.length > windowSize) },
    loading(): boolean { return loadingCall !== null },
    state(): SecretaryPagerSnapshot {
      return {
        sessionId,
        source,
        windowSize,
        renderedCount: this.renderedCount(),
        capped,
        hasMore,
        loading: loadingCall !== null,
        windowInitialized,
        cursorSeq,
        expandedBatches,
      }
    },
    reset(): void {
      windowInitialized = false
      windowSize = baseWindowSize
      cursorSeq = 0
      hasMore = true
      expandedBatches = 0
      capped = false
      loadingCall = null
      bump()
    },
  }
}

/** 组件共用的**进程内分页 store**（懒创建）：node 环境（没有 fetch）也会工作，只按 DOM 顺序分页。 */
let cardPager: SecretaryPagerStore | null = null
export function secretaryPager(): SecretaryPagerStore {
  if (cardPager !== null) return cardPager
  const g: any = globalThis as any
  const fetchImpl = typeof g.fetch === 'function' ? (url: string, init?: any) => g.fetch(url, init) : undefined
  cardPager = createSecretaryPager({ fetchImpl })
  return cardPager
}

export const secretaryCardsTestSurface = {
  normalizeForSpeech,
  stripSessionRefs,
  parseSessionRefs,
  splitSpeechChunks,
  SPEECH_CHUNK_MIN_CHARS,
  SPEECH_CHUNK_MAX_CHARS,
  SPEECH_CHUNK_FIRST_MAX_CHARS,
  reduceSpeech,
  createSpeechController,
  SPEECH_IDLE,
  latestTurnNo,
  latestReplyTurnNo,
  collectTurnText,
  badgeTone,
  splitItemPrefix,
  itemIcon,
  summarize,
  parseAnswerBody,
  answerInlineTokens,
  formatClock,
  CARD_KIND_ASSISTANT,
  CARD_KIND_USER,
  CARD_KIND_NOTICE,
  FOLD_BODY_LINE_BUDGET,
  FOLD_TITLE_LINE_BUDGET,
  FOLD_BLOCK_GAP,
  FOLD_FALLBACK_LINE_HEIGHT_PX,
  foldCollapsedCapPx,
  isSyntheticNoticeUserText,
  stripNoticeSyntheticHead,
  parseNoticeCardBody,
  parseUserCardBody,
  userCardSpeechKey,
  noticeCardSpeechKey,
  assistantCardSpeechKey,
  formatUserCardClock,
  collectSecretaryUserRows,
  collectSecretaryCardRows,
  collectSecretaryCardElements,
  foldClipFromBlocks,
  cardFoldStyle,
  ASSISTANT_SECRETARY_READ_ROUTE,
  READ_STORAGE_PREFIX,
  MAX_READ_KEYS,
  normalizeCardKey,
  normalizeReadKeys,
  createSecretaryReadStore,
  secretaryReadStore,
  ASSISTANT_SECRETARY_HISTORY_ROUTE,
  createSecretaryPager,
  secretaryPager,
  collapsedCardTitle,
  scrollAnchorTopPatch,
  CARD_WINDOW_DEFAULT,
  CARD_PAGE_SIZE,
  CARD_RENDER_CAP,
  EARLIER_HINT_TEXT,
  SCROLL_TOP_THRESHOLD_PX,
  truncateCardTitle,
  truncatePreview,
  countWords,
  windowOfItems,
  canRenderMore,
  shouldExpandOnScroll,
}
