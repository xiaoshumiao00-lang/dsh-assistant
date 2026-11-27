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
 *   9. 通知卡过期（2026-11-24 改档：10 分钟 → 10 秒）：「系统 · 通知」那张卡从到达到消失只存在 10 秒
 *      （NOTICE_CARD_TTL_MS + noticeExpiry：秒级来源 = 首次观察到达时刻（落 localStorage，刷新不丢），
 *      钟面文本只作兜底；两条判据都只晚不早；过期只在渲染层收掉，绝不删宿主会话里的消息）。
 *  10. compact 提示抑制（2026-11-23 第 3 项）：按已核实的宿主来源压掉那两行文本，见下。
 *  11. 引用登记（2026-11-23 第 4 项）：createSecretaryQuoteStore 与宿主 `/api/assistant/secretary-quote`
 *      同一套口径（真值在宿主、localStorage 兜底），供卡片脚部那颗「引用」按钮使用。
 *  12. 输入框「带引用」提示（2026-11-23 追加）：同一套引用 store 多出三条口径——
 *      `noteLatestUserCard`（真实用户消息发出去即吃引用）、TTL 到期自己排定时器收、
 *      以及 `quoteChipParts` 那三段文案（轮次 + 卡片种类 + 正文开头一小段）。渲染落在
 *      src/client/pocket/orb/SecretaryQuoteChip.tsx（宿主 `conversation.input.right` 槽位）。
 *  13. 附件标记（2026-11-26）：`[[attach:<绝对路径>|<显示名>]]` → parseAttachRefs / stripAttachRefs，
 *      秘书回复卡把它渲染成缩略图或文件条，展示与朗读都剔除这串标记（见 §2.6）。
 *      点开（2026-11-27「所有附件都通过下载实现」）：安卓端图片与文件一律走 download=1 系统下载
 *      （下载完成由 MainActivity 按 MIME 分流拉起系统应用），桌面保持 window.open 新标签页。
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
  // 会话引用与附件标记都不能念出来（附件标记里是 Windows 绝对路径，念出来就是一串字母数字）
  let text = stripSessionRefs(stripAttachRefs(String(raw ?? '')))
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

/** ────────────────────────── 2.6 附件标记 ────────────────────────── */

/**
 * 附件标记（2026-11-26 需求「回复卡里要能附带图片附件、点开用手机默认程序打开」）：
 * 秘书交付文件或图片时，在正文**最后单独一行**写 `[[attach:<绝对路径>|<显示名>]]`（提示词
 * SECRETARY_SPEECH_STYLE_TEXT 第八条说明），正文里不再贴裸路径。
 * 卡片把它渲染成图片缩略图 / 行式文件条，点开走宿主既有的只读路由 `/api/worktable/file?path=`；
 * 展示文本与朗读文本都必须剔除这串标记（绝不能把 Windows 路径念出来，也不让它在卡片里露出来）。
 * 写法与 `[[session:…]]` 同一套：解析出数组喂渲染层，剔除靠一条正则。
 */
export interface AttachRef {
  /** 绝对路径（宿主 /api/worktable/file 直接读它）。 */
  path: string
  /** 卡片上显示的附件名（模型给的显示名，缺省取文件名）。 */
  name: string
}

/** 标记本体：`[[attach:<路径>|<显示名>]]`；显示名缺失时也认（退化取文件名）。 */
const ATTACH_REF_SOURCE = /\[\[attach:([^\]|]*)(?:\|([^\]]*))?\]\]/g

/** 路径去重口径：Windows 反斜杠与正斜杠视为同一条，大小写也不敏感（同一轮不重复出两个附件块）。 */
function attachPathKey(path: string): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').trim().toLowerCase()
}

/** 路径最后一段（显示名兜底）；两种分隔符都认。 */
function attachBaseName(path: string): string {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter((part) => part !== '')
  return parts.length === 0 ? String(path ?? '') : parts[parts.length - 1]
}

/** 从正文里解析 `[[attach:<绝对路径>|<显示名>]]`（纯函数；同一轮重复路径只留第一条）。 */
export function parseAttachRefs(raw: string): AttachRef[] {
  const out: AttachRef[] = []
  const seen = new Set<string>()
  const text = String(raw ?? '')
  const pattern = new RegExp(ATTACH_REF_SOURCE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const path = String(match[1] ?? '').trim()
    if (path === '') continue
    const key = attachPathKey(path)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const name = String(match[2] ?? '').trim()
    out.push({ path, name: name === '' ? attachBaseName(path) : name })
  }
  return out
}

/** 剔除附件标记（展示文本、朗读文本、折叠行兜底文本共用）。 */
export function stripAttachRefs(text: string): string {
  return String(text ?? '').replace(ATTACH_REF_SOURCE, '')
}

/** 图片扩展名：只有这些走内联缩略图，其余一律行式文件条。 */
export const ATTACH_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] as const

/** 路径/文件名的扩展名（小写、不含点；没有回空串）。 */
export function attachExtensionOf(pathOrName: string): string {
  const name = attachBaseName(pathOrName)
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** 这张附件是不是图片（决定缩略图还是文件条）。 */
export function isAttachImage(pathOrName: string): boolean {
  return (ATTACH_IMAGE_EXTENSIONS as readonly string[]).includes(attachExtensionOf(pathOrName))
}

/** 文件条的角标文字：图片/文件类型大写扩展名，没有扩展名就写「文件」。 */
export function attachTypeBadge(pathOrName: string): string {
  const ext = attachExtensionOf(pathOrName)
  if (ext === '') return '文件'
  if (ext === 'jpeg') return 'JPG'
  return ext.toUpperCase()
}

/** 宿主只读文件路由的地址（绝对路径必须 encodeURIComponent，Windows 路径里的 `\` 与中文都要过一遍）。 */
export function attachFileUrl(path: string): string {
  return `/api/worktable/file?path=${encodeURIComponent(String(path ?? ''))}`
}

/**
 * 安卓端**所有附件**点击统一的「下载意图」地址（2026-11-27 需求「不只是图片，所有附件都通过
 * 下载实现」）：同一条只读路由追加 download=1，宿主据此把 content-disposition 对**任何类型**
 * 强制成 attachment，WebView 的 DownloadListener 就会把它交给系统下载器（带 cookie 的那条
 * 原生链路），页面原地不动；下载完成由 MainActivity 按 MIME 分流拉起系统应用（看图/文档/
 * apk 安装/…）。
 * 不加这个参数时宿主对图片/pdf/文档回 inline，WebView 会同页导航去渲染，把卡片页整个刷掉。
 */
export function attachDownloadUrl(path: string): string {
  return `${attachFileUrl(path)}&download=1`
}

/**
 * 附件点击要不要改走系统下载器：只看 UA 里有没有 Android。
 * APK 的 WebView（`…; wv) …`）与安卓上的手机浏览器都命中——图片与文件同一条判定；
 * 桌面/其余浏览器一律 false，保持原来的新标签页（图片/pdf 内联看，office 浏览器自己下载），
 * 别把桌面改坏。
 */
export function attachOpenViaDownload(userAgent: string): boolean {
  return /\bAndroid\b/i.test(String(userAgent ?? ''))
}

/** 字节数 → 文件条上那行大小（拿不到大小就不显示，绝不写 0 B）。 */
export function formatFileSize(bytes: number): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${Math.round(value)} B`
  const kb = value / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
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
    /**
     * 请求朗读一条内容（key 换 = 停上一条从头读；同 key 的 toggle 语义见状态机）。
     *
     * **同 key 且已在 loading 时必须什么都不做**：状态机对「同 key + loading/playing/paused」
     * 会原样返回同一个 state 对象，所以「next !== before」就是「这次 request 真的换了一条 /
     * 从 error 重来」。早先用 `next.status === 'loading'` 判，会把「同 key 仍在 loading」也当成
     * 要起播，于是同一段文本被第二次 start()（丢掉已排好的首块、整条从头重排）——
     * 一次朗读被反复起播，正是「有时候」几路声音一起来的一半来源。
     */
    request(key: string, text: string): void {
      pendingText = text
      const before = state
      const next = reduceSpeech(state, { type: 'play', key })
      setState(next)
      if (next !== before) start(key)
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
/** 折叠态卡标题最多几行（超出被行夹裁掉，展开态整段放开）。
 *  卡标题就是这条的「结论」行（18px 加粗稍大），正文段落是「详情」（14px 稍小）——
 *  2026-11-23 第 2 项需求只改字号档，折叠口径、行数预算、展开全文入口都不动，正文一个字也不少。 */
export const FOLD_TITLE_LINE_BUDGET = 2
/** 卡片内正文块之间的距离（与 CSS 的 content gap 一致）。 */
export const FOLD_BLOCK_GAP = 10
/** 行高量不出来时的兜底行高（详情正文 14px / 26px 行）：量不到也必须折叠，绝不留下平铺状态。 */
export const FOLD_FALLBACK_LINE_HEIGHT_PX = 26

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
 * 现网标准字号（结论 18px/1.5 两行、详情 14px/26px 三行）→ 54 + 10 + 78 + 20 = **162px**。
 * 2026-11-23 改字号档之后总量不变（旧的 51 + 10 + 81 + 20 也是 162），只是构成从「17px 标题 + 15px 正文」
 * 换成「18px 加粗结论 + 14px 详情」——折叠口径本身一个字没动。
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

/**
 * ── 用户消息的「文本 / 附件」块口径（2026-11-24 修「附件后面的文字被截掉」）──────────
 *
 * 宿主编排器（asar 里 UserContent / contentParts）按 block 顺序排一条用户消息：
 *   相邻的纯文本 block 并进气泡 → 遇到图片/文件起一条 `[data-message-attachments]` 行 →
 *   后面的文字又起**新的气泡**。现网实测那条「文字 + 截图 + 文字」的消息在 DOM 里就是
 *   气泡 / 附件行 / 气泡 三块（`.tmp/probe-mixed-row.mjs` 的 dump）。
 * 旧口径只读第一条 `[data-slot="conversation.user.text.node"]`，于是附件之后的文字全丢。
 * 这里按 document 顺序把块收全，附件也带回来（图片那份 src 是宿主 blob:/data: URL 的快照）。
 */
export const USER_TEXT_RUN_SELECTOR = '[data-slot="conversation.user.text.node"]'
export const USER_ATTACHMENT_ROW_SELECTOR = '[data-message-attachments]'
export const USER_IMAGES_SLOT_SELECTOR = '[data-slot="conversation.chat.user.images"]'
/** 宿主那颗图片框的 title 是「查看原图」这种动作说明，不许被当成文件名。 */
const HOST_IMAGE_FRAME_TITLE = '查看原图'

export interface UserCardAttachment {
  /** image = 图片附件（卡片里嵌缩略图 + 文件名）；file = 文件附件（文件名 + 大小/类型那行）。 */
  kind: 'image' | 'file'
  name: string
  /** 图片那份 src（宿主 blob: URL 的快照；文件附件留空）。 */
  src: string
  /** 文件大小/类型那一行（宿主 fileCard 那份）；图片没有就是空串。 */
  meta: string
}

/** 一条用户消息按宿主页面的顺序排出来的块：文本 run 或附件。 */
export type UserCardRun =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachment: UserCardAttachment }

/** 卡片正文的渲染块：段落（用户原文，不改写）或嵌在卡里的附件。 */
export interface UserCardBodyBlock {
  type: 'para' | 'attachment'
  text?: string
  attachment?: UserCardAttachment
}

function elementMatches(el: Element, selector: string): boolean {
  return typeof el.matches === 'function' ? el.matches(selector) : false
}

function insideAttachmentRow(el: Element, row: Element): boolean {
  let node: Element | null = el
  while (node !== null && node !== row) {
    if (elementMatches(node, USER_ATTACHMENT_ROW_SELECTOR)) return true
    node = node.parentElement
  }
  return false
}

/** 这个元素的直接children 里有没有「还带块」的子元素（true = 这一层还得往下走，不是气泡叶子）。 */
function hasBlockBearingChild(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (elementMatches(child, USER_ATTACHMENT_ROW_SELECTOR)) return true
    if (child.querySelectorAll(USER_ATTACHMENT_ROW_SELECTOR).length > 0) return true
    if (child.querySelectorAll(USER_TEXT_RUN_SELECTOR).length > 0) return true
  }
  return false
}

/** 从这一层往下走，按 document 顺序产出块：气泡叶子 → 一条文本 run（含 chip 那份文字），附件行 → 附件 run。 */
function runsFromContainer(container: Element, row: Element): UserCardRun[] {
  const out: UserCardRun[] = []
  for (const child of Array.from(container.children)) {
    if (elementMatches(child, USER_ATTACHMENT_ROW_SELECTOR)) {
      out.push(...attachmentRunsIn(child, row))
      continue
    }
    const attachments = Array.from(child.querySelectorAll(USER_ATTACHMENT_ROW_SELECTOR))
    const texts = Array.from(child.querySelectorAll(USER_TEXT_RUN_SELECTOR)).filter((anchor) => !insideAttachmentRow(anchor, row))
    if (attachments.length > 0 && texts.length > 0) {
      out.push(...runsFromContainer(child, row))
      continue
    }
    if (attachments.length > 0) {
      for (const attach of attachments) out.push(...attachmentRunsIn(attach, row))
      continue
    }
    if (texts.length === 0) continue
    if (hasBlockBearingChild(child)) {
      out.push(...runsFromContainer(child, row))
      continue
    }
    const text = String(child.textContent ?? '')
    if (text.trim() !== '') out.push({ type: 'text', text })
  }
  return out
}

/**
 * 一条宿主用户行的块列表：从行根往下走，按页面里的顺序产出文本 run 与附件 run。
 * 附件前/后的文字各自成块（宿主本来就是两条气泡），谁也不许被丢掉。
 */
export function collectUserCardRuns(row: Element): UserCardRun[] {
  if (row.querySelectorAll(`${USER_TEXT_RUN_SELECTOR}, ${USER_ATTACHMENT_ROW_SELECTOR}`).length === 0) return []
  return runsFromContainer(row, row)
}
/** 附件的名字：宿主 img 的 alt 优先，再退到外面那颗框的 aria-label（「image.png，点击查看原图」）。 */
function attachmentNameOf(el: Element, row: Element, fallback: string): string {
  const alt = String(el.getAttribute('alt') ?? '').trim()
  if (alt !== '') return alt
  let node: Element | null = el
  while (node !== null && node !== row) {
    const label = String(node.getAttribute('aria-label') ?? '').trim()
    if (label !== '') return label.split('，')[0].trim()
    node = node.parentElement
  }
  const title = String(el.getAttribute('title') ?? '').trim()
  return title !== '' && title !== HOST_IMAGE_FRAME_TITLE ? title : fallback
}

/** 一个附件行里的附件条目（一行里可能不止一张图；图片还在加载途中时没有 img，也照样要占一块）。 */
function attachmentRunsIn(el: Element, row: Element): UserCardRun[] {
  const out: UserCardRun[] = []
  for (const img of Array.from(el.querySelectorAll('img'))) {
    out.push({ type: 'attachment', attachment: { kind: 'image', name: attachmentNameOf(img, row, '图片'), src: String(img.getAttribute('src') ?? ''), meta: '' } })
  }
  if (out.length > 0) return out
  const imageSlot = elementMatches(el, USER_IMAGES_SLOT_SELECTOR) ? el : el.querySelector(USER_IMAGES_SLOT_SELECTOR)
  if (imageSlot !== null) {
    for (const frame of Array.from(imageSlot.querySelectorAll('button'))) {
      out.push({ type: 'attachment', attachment: { kind: 'image', name: attachmentNameOf(frame, row, '图片'), src: String(frame.getAttribute('src') ?? ''), meta: '' } })
    }
    if (out.length > 0) return out
  }
  for (const card of Array.from(el.querySelectorAll('[title]'))) {
    const name = String(card.getAttribute('title') ?? '').trim()
    const text = String(card.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (name === '' || name === HOST_IMAGE_FRAME_TITLE || text === '') continue
    const meta = text === name ? '' : text.startsWith(name) ? text.slice(name.length).trim() : text
    out.push({ type: 'attachment', attachment: { kind: 'file', name, src: '', meta } })
  }
  return out
}

/** 卡片文本口径：只拼文本 run（附件不混进文字，朗读与复制拿的仍是纯文字）。 */
export function userCardRunText(runs: readonly UserCardRun[]): string {
  return runs
    .filter((run) => run.type === 'text')
    .map((run) => String((run as { text: string }).text ?? '').trim())
    .filter((text) => text !== '')
    .join('\n')
}

/** 卡片附件清单（按页面顺序）。 */
export function userCardAttachments(runs: readonly UserCardRun[]): UserCardAttachment[] {
  return runs.filter((run) => run.type === 'attachment').map((run) => (run as { attachment: UserCardAttachment }).attachment)
}

/**
 * 卡片正文渲染计划：文本 run 按空行分段、附件块按原位置嵌进去。
 * 用户原文一个字都不改写、不删、不重排（附件前后的文字都在各自的段落里）。
 */
export function buildUserCardBody(runs: readonly UserCardRun[]): UserCardBodyBlock[] {
  const out: UserCardBodyBlock[] = []
  for (const run of runs) {
    if (run.type === 'attachment') { out.push({ type: 'attachment', attachment: run.attachment }); continue }
    for (const paragraph of parseUserCardBody(run.text)) out.push({ type: 'para', text: paragraph })
  }
  return out
}

export interface SecretaryUserRow {
  /** 卡片要挂进的那条宿主用户行（portal 容器）。 */
  element: Element
  /** 稳定 key（宿主的 data-chat-node-key / data-chat-flow-key，含消息 id）。 */
  key: string
  turnNo: string
  /** 用户原文（宿主这条行的**全部**文本 run，按页面里的顺序拼回来）。 */
  text: string
  /** 宿主操作行上的时间文本（已按卡片规则格式化前）。 */
  clockText: string
  /** 这条消息按宿主编排顺序的块列表（文本 / 附件 / 文本…）——卡片照它排正文与附件。 */
  runs: UserCardRun[]
  /** 这条消息的附件清单（图片/文件），渲染与「卡片有没有内容」判据都看它。 */
  attachments: UserCardAttachment[]
}

/** 秘书页里那些「user 角色」行的分类：真实用户输入 → 冷蓝用户卡；插件塞进来的合成通知 → 灰底通知卡。 */
export type SecretaryCardKind = typeof CARD_KIND_USER | typeof CARD_KIND_NOTICE
export interface SecretaryCardRow extends SecretaryUserRow {
  kind: SecretaryCardKind
}

/**
 * 宿主对话流给「用户角色的行」打的语义 kind（现场 dump 2026-11-24，
 * 见 scripts 冒烟同一套连接口径拿到的 .tmp/dom-dump-live3.txt / dom-dump-live4.txt）：
 *   - `data-chat-flow-kind="user"`     —— 正常发送的用户消息（转写记录那一类）；
 *   - `data-chat-flow-kind="steering"` —— **秘书正在跑任务时用户的插话**：宿主 ChatView 把
 *     running 中的 steer 输入挂成 steering 节点（宿主 app.asar 里 `input.mode === "steer" ? "steering" : "queued"`，
 *     并且 `conversation.chat.node` 的 key="user" 与 key="steering" 注册的是同一个 UserMessageNodeView，
 *     内层 userRow/bubble/附件行完全同一套）。
 * 卡片收集器与 CSS 必须共用这一份白名单：只有 user 的话，插话那条就变回原生气泡（本批 bug ①）。
 */
export const USER_FLOW_KIND_USER = 'user'
export const USER_FLOW_KIND_STEERING = 'steering'
export const SECRETARY_USER_FLOW_KINDS = [USER_FLOW_KIND_USER, USER_FLOW_KIND_STEERING]
/** 收集器与 CSS 共用的行选择器（顺序无关，两个 kind 都要在里面）。 */
export const SECRETARY_USER_ROW_SELECTOR = SECRETARY_USER_FLOW_KINDS
  .map((kind) => `[data-chat-flow-kind="${kind}"]`)
  .join(', ')

/**
 * 收集秘书页对话流里**所有 user 角色的行**并分类：
 *   - 认宿主稳定语义标记 `[data-chat-flow-kind="user"]` 与 `[data-chat-flow-kind="steering"]`
 *     （后者 = 跑任务途中的插话，卡片化判据与 user 行完全同一套）；
 *   - 合成通知（系统通知 / `[[session:]]` 引用行）标成 notice（灰底通知卡，带可点引用 chip）；
 *   - 真实用户消息与插话标成 user（冷蓝用户卡）；
 *   - 文本按 `collectUserCardRuns` 的块顺序拼（附件前/后的文字都不丢），附件单独带回来；
 *   - 卡片自身挂在行上，不会把自己读回去（卡里没有 data-slot 与 data-message-attachments）。
 */
export function collectSecretaryCardRows(doc: Document): SecretaryCardRow[] {
  const out: SecretaryCardRow[] = []
  for (const row of doc.querySelectorAll(SECRETARY_USER_ROW_SELECTOR)) {
    const key = row.getAttribute('data-chat-node-key') ?? row.getAttribute('data-chat-flow-key') ?? ''
    const turnNo = row.getAttribute('data-chat-turn') ?? ''
    const runs = collectUserCardRuns(row)
    const attachments = userCardAttachments(runs)
    const text = userCardRunText(runs)
    if (text === '' && attachments.length === 0) continue
    const clockEl = row.querySelector('[data-clock]')
    const kind: SecretaryCardKind = text !== '' && isSyntheticNoticeUserText(text) ? CARD_KIND_NOTICE : CARD_KIND_USER
    out.push({ element: row, key, turnNo, text, clockText: String(clockEl?.textContent ?? '').trim(), kind, runs, attachments })
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
      const row = element.closest(SECRETARY_USER_ROW_SELECTOR) ?? element
      text = userCardRunText(collectUserCardRuns(row))
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
  const now = Date.now()
  // 过期的通知卡不再计入窗口：它已经收成空壳，不该占一个卡位、也不该被折叠行还原出来。
  // 2026-11-24 改档 10 秒后，判据带秒级到达时刻（noticeArrivalStore 里首次观察那一刻），没有记录才退到钟面。
  const arrivals = noticeArrivalStore()
  const rows = collectSecretaryCardRows(doc)
    .filter((row) => row.kind !== CARD_KIND_NOTICE
      || !noticeCardExpired(row, now, NOTICE_CARD_TTL_MS, arrivals.at(noticeCardSpeechKey(row.key, row.turnNo))))
    .map((row) => ({
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

/**
 * 旧的「按 scrollHeight 差值整体补偿」公式（2026-11-27 起被 planHistoryScrollRestore 取代，留作旧测试口径）：
 * 它假设加载期间所有高度增长都发生在阅读位置**上方**；实际上 expandOlder 把折叠行翻成完整卡的位置
 * （窗口边界）在用户阅读位置**下方**，整体补偿会把视图往下拽几千 px——这就是「加载完跳回最新」的根因。
 */
export function scrollAnchorTopPatch(beforeScrollHeight: number, afterScrollHeight: number): number {
  const delta = Math.round(Number(afterScrollHeight) - Number(beforeScrollHeight))
  return delta > 0 ? delta : 0
}

/* ───────── 加载更早消息时的阅读位置锚点（2026-11-27 「跳回最新」根因修复） ─────────
 *
 * 几何事实（手机实测 bug 的机理）：
 *   - 列表从上到下 = 折叠行（更旧的卡，一行一条）→ 完整卡窗口（最近 windowSize 张）→ 最新；
 *   - 用户上滚到顶部阈值（240px）时，眼睛落在**折叠行区**；expandOlder 把窗口边界处的
 *     pageSize 张折叠行翻成完整卡——增长发生在阅读位置**下方**，阅读位置本身一像素都没动；
 *   - 旧公式 scrollTop += (新 scrollHeight − 旧 scrollHeight) 把这份下方增长全加到滚动位置上，
 *     视图被拽向最新；落点若距底 < 25px，宿主 follow 采样（use-scroll-follow 的 nearBottom）
 *     还会把 followingTail 重新置真，之后每次内容增长都钉回底部——用户看到「跳回最新消息」。
 *
 * 修法（锚点口径，三条）：
 *   ① 加载前记下「第一个可见卡行」为锚点行（key + 它相对滚动口顶部的屏幕偏移）；
 *   ② 加载后重测同一 key 的行：锚点内容坐标位移 = (after.anchorOffset + after.scrollTop)
 *      − (before.anchorOffset + before.scrollTop)，只补偿这个位移——增长在锚点下方时位移为 0，
 *      一个像素都不写；增长在上方（宿主 prepend、「正在加载」提示插删、提示行插删）时精确补偿；
 *      等待期间用户自己上滚也不会被拽回（用户滚动同时改变 scrollTop 与锚点偏移，位移公式天然抵消）；
 *   ③ 只有加载前本来就距底 < HISTORY_FOLLOW_BOTTOM_PX 时才跟随最新（钉到底部）。
 */

/** 距底多少 px 以内算「本来就在底部附近」：只有这种情况加载更早后才跟随最新。 */
export const HISTORY_FOLLOW_BOTTOM_PX = 80

/** 滚动位置快照：scrollTop/scrollHeight/clientHeight + 锚点行（key 与屏幕偏移）。 */
export interface HistoryScrollSnapshot {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** 锚点行的 data-dsh-scard-key；没有可用锚点行时为 null。 */
  anchorKey: string | null
  /** 锚点行顶部相对滚动口顶部的偏移（px，可负）；没有锚点时为 null。 */
  anchorOffset: number | null
}

export interface HistoryScrollPlan {
  /** 要写入的 scrollTop；null = 一个像素都不许动（保持现状）。 */
  scrollTop: number | null
  reason: 'follow-tail' | 'anchor' | 'keep'
  /** 本次采用的补偿量（无手势 = 锚点屏幕偏移变化；有手势 = 锚点内容坐标位移）。 */
  delta: number
}

/**
 * 加载更早消息后的滚动恢复计划（纯函数，离线单测直接喂数值模型）。决策树：
 *   ① 跟随最新：加载前贴底（距底 < 80px）且加载后仍贴底（允许地板被 prepend 等推高带来的等量
 *      下移；用户向上滚走了就不钉）→ 钉到 after 的底；
 *   ② 有锚点行（before/after 同 key 且偏移可测）：
 *      - 等待期间**没有**用户手势 → 「屏幕偏移复原」：只补锚点屏幕偏移的变化量。
 *        宿主自己的 prepend 补偿（finishHistoryPrepend / overflow-anchor）已经把锚点屏幕位置
 *        保持住了（偏移变化 = 0）→ keep，绝不重复补偿；没人补偿过的上方增长（翻卡跨锚点、
 *        「正在加载」控件变高、提示行插删）→ 偏移变了多少就补多少；
 *      - 等待期间**有**用户手势 → 「内容坐标位移」：只补锚点内容坐标的位移（= 锚点上方净增长），
 *        用户自己的滚动分量天然抵消，绝不把用户拽回加载前的位置；
 *   ③ 锚点丢了（宿主整棵重画）→ keep，一个像素都不写（瞎补比不补更糟）。
 */
export function planHistoryScrollRestore(
  before: HistoryScrollSnapshot,
  after: HistoryScrollSnapshot,
  options: { userGestured?: boolean } = {},
): HistoryScrollPlan {
  const userGestured = options.userGestured === true
  const beforeFloor = Math.max(0, Number(before.scrollHeight) - Number(before.clientHeight))
  const afterFloor = Math.max(0, Number(after.scrollHeight) - Number(after.clientHeight))
  const beforeBottomGap = beforeFloor - Number(before.scrollTop)
  const afterBottomGap = afterFloor - Number(after.scrollTop)
  const floorGrowth = Math.max(0, afterFloor - beforeFloor)
  // floorGrowth > 0.5：内容真的长了才谈「跟随」；零增长（加载失败/空页）不把贴底用户再往地板上拽
  if (floorGrowth > 0.5 && beforeBottomGap < HISTORY_FOLLOW_BOTTOM_PX && afterBottomGap <= beforeBottomGap + floorGrowth + 1) {
    return { scrollTop: Math.round(afterFloor), reason: 'follow-tail', delta: 0 }
  }
  if (before.anchorKey !== null && before.anchorOffset !== null
    && after.anchorKey === before.anchorKey && after.anchorOffset !== null) {
    const delta = userGestured
      ? (Number(after.anchorOffset) + Number(after.scrollTop)) - (Number(before.anchorOffset) + Number(before.scrollTop))
      : Number(after.anchorOffset) - Number(before.anchorOffset)
    const target = Math.max(0, Math.round(Number(after.scrollTop) + delta))
    if (Math.abs(target - Number(after.scrollTop)) <= 0.5) return { scrollTop: null, reason: 'keep', delta }
    return { scrollTop: target, reason: 'anchor', delta }
  }
  return { scrollTop: null, reason: 'keep', delta: 0 }
}

/** 守护循环：补偿之后仍可能有异步高度增长（折叠卡 0→35px、图片晚到、折叠展开）把锚点顶走，
 * 而手机触摸/惯性滑动期间浏览器原生 scroll anchoring 被抑制，没人兜底——视图就会落到新加载批次顶部。
 * 所以补偿后一小段时间内逐帧核对锚点行的视口偏移，偏了就再补 scrollTop，直到安静 quietFrames 帧或到 maxMs 上限。 */
export const HISTORY_GUARD_MAX_MS = 600
export const HISTORY_GUARD_QUIET_FRAMES = 8
/** 最早收工时间：异步高度变化通常在前 300ms 内到达，早于它不许判「安静」。 */
export const HISTORY_GUARD_MIN_MS = 300
/** 锚点行短暂消失（翻卡/重画）容忍帧数。 */
export const HISTORY_GUARD_MISSING_GRACE_FRAMES = 45

export interface HistoryScrollGuardOptions {
  scroller: any
  /** 锚点行的 data-dsh-scard-key；空串一律不守护。 */
  anchorKey: string
  /** 期望的锚点行视口偏移（相对滚动口顶部，px）。 */
  expectOffset: number
  maxMs?: number
  quietFrames?: number
  missingGraceFrames?: number
  /** 是否挂 MutationObserver 同步纠偏（默认 true；离线数值模型可关掉）。 */
  observeMutations?: boolean
  now?: () => number
  raf?: (cb: () => void) => number
  caf?: (id: number) => void
}

/** 启动守护循环，返回停止函数（幂等）。 */
export function startHistoryScrollGuard(options: HistoryScrollGuardOptions): () => void {
  const scroller = options?.scroller
  const key = String(options?.anchorKey ?? '')
  if (scroller === null || scroller === undefined || key === '') return () => {}
  const view = typeof window === 'undefined' ? null : window
  const raf = options.raf ?? ((cb: () => void): number => (view === null ? 0 : view.requestAnimationFrame(cb)))
  const caf = options.caf ?? ((id: number): void => { try { view?.cancelAnimationFrame(id) } catch { /* 忽略 */ } })
  const now = options.now ?? ((): number => (typeof performance === 'undefined' ? Date.now() : performance.now()))
  const maxMs = Math.max(1, Number(options.maxMs ?? HISTORY_GUARD_MAX_MS) || HISTORY_GUARD_MAX_MS)
  const quietFrames = Math.max(1, Number(options.quietFrames ?? HISTORY_GUARD_QUIET_FRAMES) || HISTORY_GUARD_QUIET_FRAMES)
  const graceFrames = Math.max(1, Number(options.missingGraceFrames ?? HISTORY_GUARD_MISSING_GRACE_FRAMES) || HISTORY_GUARD_MISSING_GRACE_FRAMES)
  const expectOffset = Number(options.expectOffset) || 0
  const startedAt = now()
  let quiet = 0
  let missing = 0
  let observer: any = null
  let frame = 0
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (frame !== 0) { caf(frame); frame = 0 }
    if (observer !== null) { try { observer.disconnect() } catch { /* 忽略 */ } observer = null }
  }
  const findRow = (): any => {
    const rows = scroller?.querySelectorAll?.(HISTORY_CARD_ROW_SELECTOR) ?? []
    for (const item of Array.from(rows as ArrayLike<any>)) {
      if (String(item?.getAttribute?.('data-dsh-scard-key') ?? '') === key) return item
    }
    return null
  }
  /** 就地纠偏（同步）：返回是否还活着。MutationObserver 与 rAF 两条路都走它。 */
  const correct = (): boolean => {
    if (stopped) return false
    if (scroller?.isConnected === false) { stop(); return false }
    const row = findRow()
    const scrollerTop = Number(scroller?.getBoundingClientRect?.().top) || 0
    const rowTop = row === null ? null : Number(row?.getBoundingClientRect?.().top) || 0
    const rowHeight = row === null ? 0 : (Number(row?.getBoundingClientRect?.().height) || 0)
    // 翻卡/重画期间锚点行会短暂不在（或 0 高）：容忍若干帧，不许因此提前退出——
    // 提前退出等于放弃守护，异步增长一到就又跳了。
    if (rowTop === null || rowHeight <= 0) {
      missing += 1
      quiet = 0
      if (missing > graceFrames) { stop(); return false }
      return true
    }
    missing = 0
    const drift = rowTop - scrollerTop - expectOffset
    if (Math.abs(drift) >= 1) {
      quiet = 0
      // 同步写 scrollTop：MO 回调就跑在当前任务尾部，能在**同一帧**内把位置纠回来，不会画出跳帧
      scroller.scrollTop = (Number(scroller.scrollTop) || 0) + drift
    } else {
      quiet += 1
    }
    if (now() - startedAt >= maxMs) { stop(); return false }
    if (quiet >= quietFrames && now() - startedAt >= HISTORY_GUARD_MIN_MS) { stop(); return false }
    return true
  }
  const step = (): void => {
    frame = 0
    if (stopped) return
    if (!correct()) return
    frame = raf(step)
  }
  // 关键：MutationObserver 在 DOM 变化**同一任务尾部**触发（早于下一帧 rAF），宿主 prepend / 插件插卡
  // 这类同步生长当场就能纠偏，用户看到的不是「先跳一帧再回来」。
  if (options.observeMutations !== false && typeof MutationObserver !== 'undefined') {
    try {
      observer = new MutationObserver(() => { try { correct() } catch { /* 忽略 */ } })
      observer.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'height', 'data-open'] })
    } catch { observer = null }
  }
  const stopAll = (): void => {
    stop()
    if (observer !== null) { try { observer.disconnect() } catch { /* 忽略 */ } observer = null }
  }
  frame = raf(step)
  return stopAll
}

/** 卡行矩形（pickHistoryAnchorKey 的输入；DOM 侧由 captureHistoryScrollSnapshot 量好喂进来）。 */
export interface HistoryScrollRowRect {
  key: string
  top: number
  bottom: number
  height: number
}

/**
 * 锚点行 = 文档顺序里第一个「底部越过滚动口顶部」的卡行（用户正在看的那一行）；
 * 零高度行（还没长出来的）跳过；一行都没有 → null。
 */
export function pickHistoryAnchorKey(rows: readonly HistoryScrollRowRect[], scrollerTop: number): string | null {
  const top = Number(scrollerTop) || 0
  for (const row of rows) {
    if (Number(row?.height) > 0 && Number(row?.bottom) > top + 1) return String(row?.key ?? '') || null
  }
  return null
}

/** 卡行选择器：完整卡与折叠行都算（锚点行翻卡后 key 不变，还能找到）。 */
export const HISTORY_CARD_ROW_SELECTOR = '[data-dsh-scard="card"], [data-dsh-scard="collapsed-row"]'

/**
 * DOM 侧快照（组件与离线假 DOM 共用）：量滚动口与所有卡行矩形，定锚点行。
 * anchorKey 给了就按 key 找回同一行（找不到 → anchorOffset=null → 计划层 keep）。
 */
export function captureHistoryScrollSnapshot(scroller: any, anchorKey: string | null = null): HistoryScrollSnapshot {
  const scrollerTop = Number(scroller?.getBoundingClientRect?.().top) || 0
  const rows: HistoryScrollRowRect[] = []
  const list = scroller?.querySelectorAll?.(HISTORY_CARD_ROW_SELECTOR) ?? []
  for (const row of Array.from(list as ArrayLike<any>)) {
    const rect = row?.getBoundingClientRect?.() ?? { top: 0, bottom: 0, height: 0 }
    rows.push({
      key: String(row?.getAttribute?.('data-dsh-scard-key') ?? ''),
      top: Number(rect.top) || 0,
      bottom: Number(rect.bottom) || 0,
      height: Number(rect.height) || 0,
    })
  }
  const key = anchorKey ?? pickHistoryAnchorKey(rows, scrollerTop)
  const anchor = key === null ? null : rows.find((row) => row.key === key) ?? null
  return {
    scrollTop: Number(scroller?.scrollTop) || 0,
    scrollHeight: Number(scroller?.scrollHeight) || 0,
    clientHeight: Number(scroller?.clientHeight) || 0,
    anchorKey: key,
    anchorOffset: anchor === null ? null : anchor.top - scrollerTop,
  }
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

/* ───────── 9. 通知卡 10 秒自动消失（2026-11-24 用户改档：原 10 分钟） ─────────
 *
 * 需求原话（2026-11-24）：「个人秘书会话页面的系统通知的存活时间由 10 分钟改为 10 秒钟。」
 * 实现口径（**绝不动宿主会话数据**，也不新建宿主状态）：
 *
 *   ① 精度来源（主判据，秒级）：页面**第一次看到这张通知卡**时，就地把「到达时刻」= Date.now()
 *      按 cardKey 记进 localStorage（`NOTICE_ARRIVAL_STORAGE_KEY`）。宿主的 `[data-clock]` 只有
 *      「9:08」这种分钟文本，DOM 上没有任何 epoch 字段（已核实：宿主 MessageIconActions 只渲染
 *      data-clock=start|end + formatMessageClock 的文本），所以「首次观察时刻」是本页能拿到的最细时间源。
 *      到达时刻只可能**晚于**真实发送时刻（扫描去抖 120ms + 首帧补扫 400ms），因此
 *      过期时点 = 到达 + TTL 只会晚于真实过期时点 → **只晚不早**。
 *      误差上界（秒级路径）：观察延迟 ≤ 0.5 秒 + 挂载层定时器下限 1 秒 ≈ **1.5 秒**（全是晚，不早）。
 *
 *   ② 钟面兜底（宿主机钟文本）：没有到达记录时（存储被清、node 环境、别的 profile），
 *      按「那一分钟的最后 + TTL」算（`noticeExpiryFromClock`，TTL 已是 10 秒）。
 *      误差上界：钟面把发送时刻最多往前推 59.999 秒 → **最坏晚 59.999 秒**，绝不提前一秒。
 *
 *   ③ 两条判据取「谁说到点就到点」（OR）：两个过期时点都只可能晚于真实过期时点，
 *      取更早的那个仍然不早于真实过期时点 → 全程只晚不早。
 *
 *   ④ 认不出钟面文本（空串/乱码）且没有到达记录 → 永不过期（没有证据不许把消息收掉）。
 *      认不出钟面但有到达记录 → 按秒级 10 秒收（这种情况以前是「永不过期」，现在有依据了）。
 *
 *   ⑤ 整页刷新后的退化：到达时刻落在 localStorage，刷新后沿用同一条记录（不重读日志、不改宿主）；
 *      只有「存储被清 / 换了浏览器 profile / 通知在别的会话页到达而秘书页没开」这几种情况才退到 ②，
 *      即最坏晚 59.999 秒。到达记录只增不改（幂等），按 MAX_NOTICE_ARRIVAL_KEYS 修剪最旧，写失败静默降级成内存 Map。
 */

/** 通知卡从（首次观察到的）到达到消失只存在这么久（2026-11-24 用户改档：10 分钟 → 10 秒）。 */
export const NOTICE_CARD_TTL_MS = 10 * 1000
/** 宿主时钟只给到分钟：一分钟的长度（钟面兜底算过期时点用）。 */
export const NOTICE_CLOCK_MINUTE_MS = 60 * 1000
/** 到达时刻的本地缓存键（整页刷新后沿用同一条，不需要重读会话日志）。 */
export const NOTICE_ARRIVAL_STORAGE_KEY = 'dsh.assistant.secretary.notice-arrival'
/** 到达记录最多留多少条（超出按时间修剪最旧的；通知卡只活 10 秒，留这么多足够任何刷新窗口）。 */
export const MAX_NOTICE_ARRIVAL_KEYS = 200
/** 带日期的时间文本（宿主机场日历口径：昨天/前天、M月D日、YYYY-MM-DD）——这种一定早于 10 秒。 */
const CLOCK_DATED_RE = /(昨天|前天|上周|[01]?\d月[0-3]?\d日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/
/** 「今天 9:08」/「9:08」两种同一天的时间文本。 */
const CLOCK_TODAY_RE = /^(今天\s+)?([01]?[0-9]|2[0-3]):([0-5][0-9])$/

export interface NoticeExpiry {
  /** 这条通知的发送时刻（epoch ms，按分钟起点估）；认不出时间就是 null。 */
  sentAt: number | null
  /** 过期时刻（epoch ms）：分钟末 + TTL；认不出时间就是 null。 */
  expiresAt: number | null
  /** 现在这张通知卡该不该收掉。 */
  expired: boolean
  /** 判据来源，测试逐条断言：同一天的钟面 / 带日期的钟面 / 认不出时间。 */
  reason: 'same-day' | 'dated-label' | 'unknown-time'
}

/**
 * 通知卡过期判据（纯函数，node 直接测）——**只看钟面**这一条（兜底口径）：
 *   - 「9:08」「今天 9:08」→ 按今天的这一分钟算：过期时点 = 分钟起点 + 59.999s + TTL（宁可晚，不提前）；
 *   - 「昨天 9:08」「11月22日 9:08」这类带日期的 → 必然超过 TTL → 过期；
 *   - 认不出时间 → 不过期（保守：没有证据就不许把消息收掉）。
 */
export function noticeExpiryFromClock(clockText: unknown, now = Date.now(), ttlMs = NOTICE_CARD_TTL_MS): NoticeExpiry {
  const raw = String(clockText ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return { sentAt: null, expiresAt: null, expired: false, reason: 'unknown-time' }
  const day = new Date(now)
  const today = raw.match(CLOCK_TODAY_RE)
  if (today !== null) {
    const startMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(today[2]), Number(today[3]), 0, 0).getTime()
    // 钟面指到明天（跨午夜、或宿主时钟与本地时钟偏差）：这一分钟不可能还在 10 分钟窗口里之前
    const minuteStart = Number.isFinite(startMs) && startMs <= now ? startMs : now
    const expiresAt = minuteStart + NOTICE_CLOCK_MINUTE_MS - 1 + ttlMs
    return { sentAt: minuteStart, expiresAt, expired: now >= expiresAt, reason: 'same-day' }
  }
  if (CLOCK_DATED_RE.test(raw)) return { sentAt: null, expiresAt: null, expired: true, reason: 'dated-label' }
  return { sentAt: null, expiresAt: null, expired: false, reason: 'unknown-time' }
}

/** 通知卡过期判据的精度来源（测试逐条断言，报告里也按这个口径写误差）。 */
export type NoticePrecision = 'seconds' | 'minute' | 'none'

export interface NoticeExpiryDetail extends NoticeExpiry {
  /** 这张卡按哪条判据算的：seconds=有到达时刻（10 秒精度的主判据）；minute=只有钟面文本；none=证据不足。 */
  precision: NoticePrecision
}

/**
 * 通知卡过期判据（合成口径）：**秒级到达时刻** + **钟面兜底**两条判据取更早的那个过期时点。
 *
 * 两条判据的过期时点都只可能晚于真实过期时点（到达只会晚、钟面只会往前推），所以
 * 「谁说到点就到点」不会造成提前收；到期判断永远是「现在 ≥ min(两个时点)」。
 */
export function noticeExpiry(
  row: { kind: string; clockText: string },
  now = Date.now(),
  ttlMs = NOTICE_CARD_TTL_MS,
  arrivalAt: number | null = null,
): NoticeExpiryDetail {
  const clock = noticeExpiryFromClock(row.clockText, now, ttlMs)
  if (row.kind !== CARD_KIND_NOTICE) {
    // 用户卡与回复卡永不按 TTL 收（只走卡种判据，不看时间）
    return { sentAt: clock.sentAt, expiresAt: null, expired: false, reason: clock.reason, precision: 'none' }
  }
  const secondsAt = typeof arrivalAt === 'number' && Number.isFinite(arrivalAt) && arrivalAt > 0 ? arrivalAt + ttlMs : null
  // 带日期的钟面是最硬的证据（必然早于 TTL）→ 直接收，不再等秒级判据
  if (clock.reason === 'dated-label') {
    return { sentAt: clock.sentAt, expiresAt: secondsAt, expired: true, reason: clock.reason, precision: secondsAt === null ? 'minute' : 'seconds' }
  }
  const candidates = [secondsAt, clock.expiresAt].filter((value): value is number => value !== null && Number.isFinite(value))
  const expiresAt = candidates.length === 0 ? null : Math.min(...candidates)
  const precision: NoticePrecision = secondsAt !== null ? 'seconds' : (clock.reason === 'same-day' ? 'minute' : 'none')
  const expired = expiresAt === null ? false : now >= expiresAt
  return { sentAt: clock.sentAt, expiresAt, expired, reason: clock.reason, precision }
}

/** 一批通知卡里最近的那个过期时点（没有待过期的一定通知 → null）。挂载层靠它自己排一次定时器。 */
export function nearestNoticeExpiryMs(
  rows: readonly { kind: string; clockText: string; key?: string }[],
  now = Date.now(),
  ttlMs = NOTICE_CARD_TTL_MS,
  arrivalOf: ((row: { kind: string; clockText: string; key?: string }) => number | null) | null = null,
): number | null {
  let nearest: number | null = null
  for (const row of rows) {
    if (row.kind !== CARD_KIND_NOTICE) continue
    const arrivalAt = arrivalOf === null ? null : arrivalOf(row)
    const expiry = noticeExpiry(row, now, ttlMs, arrivalAt)
    if (expiry.expiresAt === null || expiry.expired) continue
    if (nearest === null || expiry.expiresAt < nearest) nearest = expiry.expiresAt
  }
  return nearest
}

/** 这张通知卡现在是不是已经过了 10 秒（用户卡与回复卡永远 false）。 */
export function noticeCardExpired(
  row: { kind: string; clockText: string; key?: string },
  now = Date.now(),
  ttlMs = NOTICE_CARD_TTL_MS,
  arrivalAt: number | null = null,
): boolean {
  if (row.kind !== CARD_KIND_NOTICE) return false
  return noticeExpiry(row, now, ttlMs, arrivalAt).expired
}

/** ─── 到达时刻 store（2026-11-24）：秒级来源；localStorage 持久化 + 内存兜底，只增不改 ─── */

export interface SecretaryNoticeArrivalStore {
  /** 这张卡的到达时刻（epoch ms）；没记过 → null。 */
  at(cardKey: string): number | null
  /** 幂等登记：没记过就记成 now，已记过一字不改（绝不把过期时点往后挪，更不许往前挪成提前收）。返回该卡最终到达时刻。 */
  observe(cardKey: string, now?: number): number
  /** 批量登记（一次扫描到的那批通知卡）。 */
  observeAll(cardKeys: readonly string[], now?: number): void
  /** 修剪：只留最近 MAX_NOTICE_ARRIVAL_KEYS 条（按到达时刻从新到旧）。 */
  prune(): void
  /** 只给测试/诊断：当前全量快照（cardKey → 到达时刻）。 */
  snapshot(): Record<string, number>
  /** 清空（只给测试）。 */
  reset(): void
}

/** 建一个到达时刻 store（storage 缺省 → 内存 Map；宿主 localStorage 抛错时也静默降级）。 */
export function createSecretaryNoticeArrivalStore(deps: {
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null
  maxKeys?: number
} = {}): SecretaryNoticeArrivalStore {
  const storage = deps.storage ?? null
  const maxKeys = Math.max(1, Number(deps.maxKeys ?? MAX_NOTICE_ARRIVAL_KEYS))
  const memory = new Map<string, number>()

  const load = (): void => {
    if (storage === null) return
    try {
      const raw = storage.getItem(NOTICE_ARRIVAL_STORAGE_KEY)
      if (raw === null || raw === '') return
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const ms = Number(value)
        if (key === '' || !Number.isFinite(ms) || ms <= 0) continue
        if (!memory.has(key)) memory.set(key, ms)
      }
    } catch { /* 坏数据当没有：宁可退到钟面兜底，也不许拿错时间提前收 */ }
  }
  const persist = (): void => {
    if (storage === null) return
    try {
      storage.setItem(NOTICE_ARRIVAL_STORAGE_KEY, JSON.stringify(Object.fromEntries(memory)))
    } catch { /* 写失败：本次会话仍按内存里的到达时刻算 */ }
  }
  load()

  const prune = (): void => {
    if (memory.size <= maxKeys) return
    const ordered = [...memory.entries()].sort((a, b) => a[1] - b[1])
    for (const [key] of ordered.slice(0, memory.size - maxKeys)) memory.delete(key)
  }

  return {
    at(cardKey) {
      const key = String(cardKey ?? '')
      if (key === '') return null
      const value = memory.get(key)
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
    },
    observe(cardKey, now = Date.now()) {
      const key = String(cardKey ?? '')
      if (key === '') return 0
      const existing = memory.get(key)
      if (typeof existing === 'number' && existing > 0) return existing
      memory.set(key, now)
      prune()
      persist()
      return now
    },
    observeAll(cardKeys, now = Date.now()) {
      let changed = false
      for (const raw of cardKeys) {
        const key = String(raw ?? '')
        if (key === '') continue
        if (memory.has(key)) continue
        memory.set(key, now)
        changed = true
      }
      if (changed) { prune(); persist() }
    },
    prune,
    snapshot() {
      return Object.fromEntries(memory)
    },
    reset() {
      memory.clear()
      persist()
    },
  }
}

/** 进程内单例（浏览器里带 localStorage；node 测试里只有内存）。 */
let noticeArrivalSingleton: SecretaryNoticeArrivalStore | null = null
export function noticeArrivalStore(): SecretaryNoticeArrivalStore {
  if (noticeArrivalSingleton !== null) return noticeArrivalSingleton
  const g: any = globalThis as any
  const storage = g.localStorage !== null && g.localStorage !== undefined ? g.localStorage : null
  noticeArrivalSingleton = createSecretaryNoticeArrivalStore({ storage })
  return noticeArrivalSingleton
}


/* ───────── 10. compact 提示两行文本（2026-11-23 第 3 项需求） ─────────
 *
 * 来源核实（宿主 app.asar，只读扫描取证）：
 *   - 宿主编排器 `src/client/conversation-nodes/command.ts`：带 `source.kind:"compact-checkpoint"` 的
 *     替换检查点 + `compaction/start|summary|end` 生命周期 → 汇成一个 `manual-compaction` 对话节点；
 *   - `src/client/chat/CompactionCommandCard.tsx` 渲染那一行，正文来自 i18n：
 *     `message.compaction.commandTitle = "compact"`、
 *     `message.compaction.completed = "已压缩 {items} 条历史记录（约 {tokens} tokens）"`；
 *   - 失败分支走 `GenericCommandCard` 的 outcome 文本：`Compaction could not produce a useful summary.`
 *   插件 CSS 早先只压 `kind="compaction"`，**漏了 `kind="manual-compaction"`**——补上；
 *   再兜一层：按下面这两条文字判据给宿直行打标记（CSS 一并压掉）。只作用于秘书页 body[data-dsh-secretary="1"]。
 */

/** 判据 ①：compact 那行摘要（中文与英文 i18n 两种写法都认）。 */
export const COMPACT_SUMMARY_HINT_RE = /compact[^\n]{0,40}(?:已压缩[^\n]{0,40}条历史记录|Compacted[^\n]{0,40}history items)/i
/** 判据 ②：compact 失败提示正文（宿主后端英文串）。 */
export const COMPACT_FAILURE_HINT_RE = /Compaction could not produce a useful summary/i
/** 打在宿主行上的标记（CSS 里有一条同款隐藏规则，测试直接验这个属性）。 */
export const COMPACT_HINT_ATTRIBUTE = 'data-dsh-scard-compact'

/** 这行文字是不是那两类 compact 提示。 */
export function isCompactHintText(text: unknown): boolean {
  const raw = String(text ?? '')
  return COMPACT_SUMMARY_HINT_RE.test(raw) || COMPACT_FAILURE_HINT_RE.test(raw)
}

/**
 * 扫描层标记：只给「宿主自己那些行」打 compact 标记，我们自己挂出来的卡（带 data-dsh-scard="card"）
 * 一律不碰——防止把卡片正文里恰好出现「已压缩 N 条历史记录」的字样误压掉。返回打标行数。
 */
export function tagSecretaryCompactHintRows(doc: Document): { kindRows: number; textRows: number } {
  let kindRows = 0
  let textRows = 0
  for (const row of doc.querySelectorAll('[data-chat-flow-kind]')) {
    if (row.querySelector('[data-dsh-scard="card"]') !== null) continue
    const kind = String(row.getAttribute('data-chat-flow-kind') ?? '')
    const compactKind = kind === 'compaction' || kind === 'manual-compaction'
    if (compactKind) {
      row.setAttribute(COMPACT_HINT_ATTRIBUTE, 'hint')
      kindRows += 1
      continue
    }
    if (isCompactHintText(row.textContent)) {
      row.setAttribute(COMPACT_HINT_ATTRIBUTE, 'hint')
      textRows += 1
    }
  }
  return { kindRows, textRows }
}

/** 清掉自己打过的标记（离开秘书页 / 测试复位用）。 */
export function clearSecretaryCompactHintRows(doc: Document): number {
  let cleared = 0
  for (const row of doc.querySelectorAll(`[data-chat-flow-kind][${COMPACT_HINT_ATTRIBUTE}]`)) {
    row.removeAttribute(COMPACT_HINT_ATTRIBUTE)
    cleared += 1
  }
  return cleared
}

/* ───────── 12. 最新一轮的过程行可见（2026-11-24 第 5 项需求） ─────────
 *
 * 用户原话：「个人秘书页，在用户发送一条消息之后，个人秘书自己执行任务的过程可以展示，
 * 不要被屏蔽了。只展示最新用户一条任务的执行过程，其他历史消息的执行过程都不要展示。」
 *
 * 实现口径（扫描层打标 + CSS 放行，判据全按 DOM 现状，不写死任何 turn 号）：
 *   ① 锚点：按文档顺序取**最后一条** `[data-chat-flow-kind]` 是 user / steering 的宿主行
 *      （插话那一类与真用户行是同一个用户消息视图，见 6127e8e 那批；两类都算「用户这一条」）；
 *   ② 范围：锚点之后（文档顺序）且 `data-chat-turn` 等于锚点那一轮（锚点没有轮次号时按「其后所有」兜底）
 *      的过程行：tool-call / context / model-retry / turn-error / turn-max-tokens，
 *      外加带 `data-chat-group-key` 的分组容器与带 `data-turn-process-member` 的分组成员；
 *      分组里 `data-chat-group-part="reasoning"` 的那种「已搜索代码，已读取文件」也放行；
 *      （2026-11-25 起 turn-process 不再放行：那行只在轮次关闭后才渲染，就是用户要隐藏的
 *      「已完成，用时 N 秒」完成行；进行态根本没有这行，放行名单动不到执行过程。）
 *   ③ 不标：`assistant-step` 且没有 reasoning 分组标记的行 —— 那是**回复正文**（现场 dump 实测行高
 *      1038px 的整段回答），卡片已经展示同一段文字，再露出来就是重复；manual-compaction 与回合尾部件
 *      （本回合记忆/技能）也不标，它们是上下文管理，不是任务执行；
 *   ④ 移动：每次扫描先把上一轮的标记全摘掉再重新打（幂等），新用户消息一来锚点后移，
 *      上一轮的过程行立刻回到 display:none；
 *   ⑤ 兜底：容器里挂着我们的卡（`[data-dsh-scard]`）一律不标，绝不把卡片连坐。
 *
 * 这个函数**刻意写成自包含**（只依赖 doc 与 options，不引用别的模块常量），
 * 视觉套件可以直接把它注入页面里跑真实逻辑（见 scripts/test-secretary-card-visual.mjs）。
 */
export const PROCESS_VISIBLE_ATTRIBUTE = 'data-dsh-process-visible'
/**
 * 放行的过程行 kind（不含 assistant-step：那一类要按 reasoning 分组标记单独判）。
 * 2026-11-25 用户原话：「个人秘书页，如果是已经完成了，这行提示就不要留着了，隐藏掉；
 * 如果是正常执行中的要保留执行过程。」—— turn-process 移出放行名单：
 * 那行「已完成，用时 N 秒 ⌄」是宿主 TurnProcessNodeView 的 kind="turn-process" 行，
 * 宿主只在轮次关闭（closed）后才渲染它（进行中 TurnProcessNodeView 返回 null，这行根本不存在），
 * 进行态的「深度求索中，用时 N 秒 ···」是另一条 [data-chat-running]（RunningStatus），不在本名单也不受影响。
 * 所以从名单去掉它 = 完成行回到 CSS 隐藏规则、进行态一个像素都不变。
 */
export const PROCESS_VISIBLE_KINDS: readonly string[] = ['tool-call', 'context', 'model-retry', 'turn-error', 'turn-max-tokens']

export interface LatestTurnProcessTagResult {
  /** 这一次打标的行数。 */
  marked: number
  /** 锚点那一轮的 turn 号（锚点没有轮次号时是空串）。 */
  turnNo: string
  /** 锚点那一行的 kind（user / steering；没有锚点时空串）。 */
  anchorKind: string
}

/**
 * 把「最新一条用户消息那一轮」的过程行打上 `data-dsh-process-visible="1"`，其余全部摘掉（幂等）。
 * 每次扫描调用一次即可；标记随最后一条用户行移动。
 */
export function tagLatestTurnProcessRows(
  doc: Document | { querySelectorAll(selector: string): ArrayLike<Element> },
  options?: { attribute?: string; kinds?: readonly string[] },
): LatestTurnProcessTagResult {
  const attribute = options?.attribute ?? PROCESS_VISIBLE_ATTRIBUTE
  const kinds = options?.kinds ?? PROCESS_VISIBLE_KINDS
  const anchorKinds = ['user', 'steering']
  const get = (el: any, name: string): string => String(el.getAttribute(name) ?? '')
  const empty: LatestTurnProcessTagResult = { marked: 0, turnNo: '', anchorKind: '' }
  if (doc === null || doc === undefined) return empty
  // ④ 先把上一轮的标记全摘掉：新消息一来，旧那一轮立刻回到隐藏
  for (const el of Array.from(doc.querySelectorAll(`[${attribute}]`)) as any[]) {
    try { el.removeAttribute(attribute) } catch { /* 已被宿主摘掉的节点：跳过 */ }
  }
  const list = Array.from(doc.querySelectorAll('[data-chat-flow-kind], [data-chat-group-key], [data-turn-process-member]')) as any[]
  // ① 锚点 = 文档顺序里最后一条 user / steering 行
  let anchorIndex = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (anchorKinds.includes(get(list[i], 'data-chat-flow-kind'))) { anchorIndex = i; break }
  }
  if (anchorIndex < 0) return empty
  const anchor = list[anchorIndex]
  const anchorKind = get(anchor, 'data-chat-flow-kind')
  const turnNo = get(anchor, 'data-chat-turn')
  let marked = 0
  for (let i = anchorIndex + 1; i < list.length; i += 1) {
    const el = list[i]
    const kind = get(el, 'data-chat-flow-kind')
    if (anchorKinds.includes(kind)) continue
    // ② 同轮：两边都有轮次号时必须相等；锚点没有轮次号时按「锚点之后」兜底
    const rowTurn = get(el, 'data-chat-turn')
    if (turnNo !== '' && rowTurn !== '' && rowTurn !== turnNo) continue
    // ⑤ 容器里挂着我们的卡就不动它
    if (typeof el.querySelector === 'function' && el.querySelector('[data-dsh-scard]') !== null) continue
    const groupPart = get(el, 'data-chat-group-part')
    const isProcessRow = kinds.includes(kind)
      || (kind === 'assistant-step' && groupPart === 'reasoning')
      || (kind === '' && (el.hasAttribute('data-chat-group-key') || el.hasAttribute('data-turn-process-member')))
    if (!isProcessRow) continue
    el.setAttribute(attribute, '1')
    marked += 1
  }
  return { marked, turnNo, anchorKind }
}

/** 清掉自己打过的「最新一轮过程行」标记（离开秘书页 / 测试复位用）。 */
export function clearLatestTurnProcessTags(
  doc: Document | { querySelectorAll(selector: string): ArrayLike<Element> },
  options?: { attribute?: string },
): number {
  const attribute = options?.attribute ?? PROCESS_VISIBLE_ATTRIBUTE
  let cleared = 0
  for (const el of Array.from(doc.querySelectorAll(`[${attribute}]`)) as any[]) {
    try { el.removeAttribute(attribute); cleared += 1 } catch { /* 忽略已摘掉的节点 */ }
  }
  return cleared
}

/* ───────── 11. 引用（2026-11-23 第 4 项需求）：下一条消息挂到这张卡上 ─────────
 *
 * 客户端口径（真值在宿主 `/api/assistant/secretary-quote` → dsh-assistant-secretary-quote.json，
 * localStorage 只是首屏缓存与降级兜底，和已读集合那一套一模一样）：
 *   - 卡片脚部时间左边那颗「引用」按钮 → setQuote(cardKey)；再点一次 = 取消；
 *   - 宿主那一侧由 src/assistant-secretary.ts 的引用注入段（order 1783）把这张卡的
 *     种类 / 轮次 / 正文摘录 / `[[session:…]]` 里的会话 id 喂给秘书模型，
 *     并在这条引用被真实用户消息吃掉之后（turn/end）清掉。
 */

/** 宿主侧引用路由（服务端 src/assistant-secretary.ts 注册同一字符串）。 */
export const ASSISTANT_SECRETARY_QUOTE_ROUTE = '/api/assistant/secretary-quote'
/** 本地缓存键前缀（真值仍在宿主，localStorage 只是宿主答不上时的降级缓存）。 */
export const QUOTE_STORAGE_PREFIX = 'dsh.assistant.secretary.quote:'
/** 引用基线（「引用登记那一刻页面上最末那条真实用户消息」）的本地缓存键前缀：刷新页面也认得出去过没有。 */
export const QUOTE_BASELINE_STORAGE_PREFIX = 'dsh.assistant.secretary.quote-baseline:'
/** 一条引用最多活多久（用户点了引用但一直没发消息时，别把它无限挂着）。 */
export const QUOTE_TTL_MS = 30 * 60 * 1000
/** 引用里正文摘录上限（只用于告诉模型「引用的是哪段话」，不是完整汇报口径）。 */
export const QUOTE_PREVIEW_MAX_CHARS = 600

/* ───────── 11.1 输入框那侧的「带引用」提示（2026-11-23 追加需求）─────────
 *
 * 需求原话：「我希望点击引用后在输入框有个提示，不然不知道是否有引用对话」。
 * 落点：src/client/pocket/orb/SecretaryQuoteChip.tsx，注册到宿主 `conversation.input.right`
 * （与托管那颗胶囊同一个槽位、同一套手感：8px 圆角、脚部那套 muted / accent 数值、同 hover）。
 * 三种收口口径（逐条对应用户要求）：
 *   - 没按引用 → 组件一个字都不渲染（`quoteChipParts(null)` → null，没有空壳）；
 *   - 消息发出去 → 扫描层 noteLatestUserCard 把引用收掉（只算真实用户行，通知行不算，口径同宿主「通知轮不吃引用」）；
 *   - TTL 30 分钟到期 → store 自己排一个到期定时器，到点本地收掉，并顺手请宿主也清（服务端本来就按 updatedAt 判 TTL）。
 * 服务端与本地两条路都认：hydrate GET 拿得到就用宿主那份 cardKey/轮次/摘录，404 就用 localStorage 那份。
 */

/** 引用提示里「带引用」那一句（输入框旁边一眼看到的就是它）。 */
export const QUOTE_CHIP_FLAG_TEXT = '带引用'
/** 取消入口的文案（那颗 × 的 aria/title）。 */
export const QUOTE_CHIP_CANCEL_TEXT = '取消引用'
/** 引用提示里那张卡正文开头截一小段（不是整段贴，上限 34 字）。 */
export const QUOTE_CHIP_PREVIEW_MAX_CHARS = 34
/** 卡片种类说法：与宿主注入段同一组标签（src/assistant-secretary.ts 的 QUOTE_KIND_LABELS）。 */
export const QUOTE_CHIP_KIND_LABELS: Record<string, string> = {
  assistant: '秘书回复卡',
  user: '用户消息卡',
  notice: '系统通知卡',
}

/** 引用基线：登记那一刻「页面上最末一条真实用户消息卡」的身份（key + 轮次）。 */
export interface QuoteUserCardRef {
  cardKey: string
  turnNo: string
}

/** 轮次文本 → 数字（拿不到回 null，判据退回「比 key」）。 */
export function quoteTurnNumber(turnNo: unknown): number | null {
  const raw = String(turnNo ?? '').trim()
  if (raw === '') return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : null
}

/**
 * 「那条消息是不是已经发出去了」判据（纯函数，测试逐条断言）。
 * 口径：基线是引用登记那一刻页面上最末那条真实用户消息；
 * 现在最末那条**换成了更新的轮次**才算发出去（轮次号可比就按轮次号比，
 * 比不了才退回比 key——同一轮被宿主重新投影换了 node key 也不许误收）。
 * 页面还没投影出用户行（newest 空）一律不收，不许凭空收掉用户的引用。
 */
export function quoteConsumedByUserRow(baseline: QuoteUserCardRef | null, newest: QuoteUserCardRef): boolean {
  const newestKey = normalizeCardKey(newest?.cardKey)
  if (newestKey === '') return false
  if (baseline === null) return false
  const baselineKey = normalizeCardKey(baseline.cardKey)
  if (baselineKey === '') return false
  const baselineTurn = quoteTurnNumber(baseline.turnNo)
  const newestTurn = quoteTurnNumber(newest.turnNo)
  if (baselineTurn !== null && newestTurn !== null) return newestTurn > baselineTurn
  return newestKey !== baselineKey
}

/** 页面上最末一条**真实**用户消息卡（kind=user；合成通知行一律不算）。 */
export function latestRealUserCardRef(rows: readonly SecretaryCardRow[]): QuoteUserCardRef {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (String(row?.kind ?? '') !== CARD_KIND_USER) continue
    return { cardKey: userCardSpeechKey(row.key, row.turnNo), turnNo: String(row.turnNo ?? '') }
  }
  return { cardKey: '', turnNo: '' }
}

/** 卡片 key 里能扒出轮次号就扒（宿主那种 `assistant:turn:12`、`user:13:input-message…`）。
  拿不到照实回空串，组件自己会说「轮次未知」，不许瞎猜。
*/
export function quoteTurnFromCardKey(cardKey: unknown): string {
  const key = String(cardKey ?? '').trim()
  if (key === '') return ''
  const named = key.match(/^(?:assistant|user|notice):turn:(\d{1,6})$/)
  if (named) return named[1]
  const bare = key.match(/^(?:user|notice):(\d{1,6}):/)
  if (bare) return bare[1]
  return ''
}

/** 引用提示只在固定秘书会话那条输入框显示（别的会话一个字都不出）。 */
export function quoteChipVisible(secretarySessionId: unknown, slotSessionId: unknown): boolean {
  const secretary = String(secretarySessionId ?? '')
  const slot = String(slotSessionId ?? '')
  return secretary !== '' && slot !== '' && secretary === slot
}

/** 摘要只截一小段：换行压成空格、超长加省略号。 */
export function quoteChipPreview(preview: unknown, maxChars: number = QUOTE_CHIP_PREVIEW_MAX_CHARS): string {
  const collapsed = String(preview ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed === '') return ''
  const limit = Math.max(1, Math.trunc(maxChars))
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`
}

export interface QuoteChipParts {
  /** 「带引用」那一句。 */
  flag: string
  /** 第 N 轮 / 轮次未知。 */
  turnLabel: string
  /** 这张卡是什么（秘书回复卡 / 用户消息卡 / 系统通知卡）。 */
  kindLabel: string
  /** 轮次 + 卡片种类（一行短语）。 */
  meta: string
  /** 该卡正文开头一小段。 */
  preview: string
  /** tooltip / aria 全文（手机上点不到 hover 也看得到）。 */
  label: string
}

/** 输入框提示的三段文案（纯函数）：没引用 → null（组件什么都不渲染）。 */
export function quoteChipParts(record: SecretaryQuoteRecord | null): QuoteChipParts | null {
  if (record === null) return null
  const kindLabel = QUOTE_CHIP_KIND_LABELS[record.kind] ?? '卡片'
  const turnNumber = quoteTurnNumber(record.turnNo) ?? quoteTurnNumber(quoteTurnFromCardKey(record.cardKey))
  const turnLabel = turnNumber !== null ? `第 ${turnNumber} 轮` : '轮次未知'
  const preview = quoteChipPreview(record.preview)
  const meta = `${turnLabel} · ${kindLabel}`
  const parts: QuoteChipParts = {
    flag: QUOTE_CHIP_FLAG_TEXT,
    turnLabel,
    kindLabel,
    meta,
    preview,
    label: preview === ''
      ? `本条消息带引用：接着${meta}说（发出去即失效，点取消就不带引用）`
      : `本条消息带引用：接着${meta}说，那张卡正文开头「${preview}」（发出去即失效，点取消就不带引用）`,
  }
  return parts
}

/** 还要不要排到期定时器：还活着的引用回剩余毫秒（下限 1ms、上限截到 setTimeout 安全值），没了/过期回 0。 */
export function quoteExpiryDelayMs(record: SecretaryQuoteRecord | null, now = Date.now(), ttlMs = QUOTE_TTL_MS): number {
  if (record === null) return 0
  const left = record.updatedAt + ttlMs - now
  if (!(left > 0)) return 0
  // 2^31-1 是 setTimeout 的安全上限（超过浏览器会立刻当成 0 触发）
  return Math.min(Math.max(1, Math.trunc(left)), 2147483647)
}

/** 引用里连附件一起记：只有文件信息（名字/种类/大小那类说明），不带图片本体（2026-11-25 第二次修法）。 */
export interface SecretaryQuoteAttachment {
  name: string
  /** 'image' | 'file'（与 UserCardAttachment.kind 同一组字面量）。 */
  kind: string
  meta: string
}

/** 引用正文全文上限：只属于引用链路（卡片展示预算 900/600/200 一字不动）。 */
export const QUOTE_BODY_MAX_CHARS = 20_000
/** 一条引用最多带多少个附件。 */
export const QUOTE_ATTACHMENT_MAX = 12
/** 附件名/附件说明上限。 */
export const QUOTE_ATTACHMENT_TEXT_MAX = 160

export interface SecretaryQuoteRecord {
  /** 卡片 key（沿用已读/朗读那套 cardKey 口径：assistant: / user: / notice: 前缀）。 */
  cardKey: string
  /** 卡片种类：assistant / user / notice。 */
  kind: string
  /** 该卡所属轮次（回复卡靠它定位）。 */
  turnNo: string
  /** 卡片正文摘录（输入框 chip 与定位用，最多 QUOTE_PREVIEW_MAX_CHARS）。 */
  preview: string
  /** 卡片正文全文（喂给模型，最多 QUOTE_BODY_MAX_CHARS；不截成 600）。 */
  body: string
  /** 卡片里带的附件（只有文件信息）。 */
  attachments: SecretaryQuoteAttachment[]
  /** 卡片带 `[[session:id|标题]]` 时被引用的那条会话。 */
  refSessionIds: string[]
  /** 本地写入时刻（epoch ms），客户端算 TTL 用。 */
  updatedAt: number
}

/** 引用里的会话 id 形状（与服务端 normalizeQuoteSessionIds 同一口径：只认宿主那种 id 形状）。 */
const QUOTE_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/

/** 归一引用里的会话 id 列表：坏值丢、按序去重、最多 8 条。 */
export function normalizeQuoteSessionIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const out: string[] = []
  for (const item of list) {
    const id = String(item ?? '').trim()
    if (id === '' || !QUOTE_SESSION_ID_RE.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= 8) break
  }
  return out
}

/** 归一引用附件：坏值丢、按序去重（name+kind）、截到上限（与服务端 normalizeQuoteAttachments 同一口径）。 */
export function normalizeQuoteAttachments(raw: unknown): SecretaryQuoteAttachment[] {
  const list = Array.isArray(raw) ? raw : []
  const out: SecretaryQuoteAttachment[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const source = item as Record<string, unknown>
    const name = String(source.name ?? '').trim().slice(0, QUOTE_ATTACHMENT_TEXT_MAX)
    if (name === '') continue
    const kind = String(source.kind ?? '').trim() === 'image' ? 'image' : 'file'
    const meta = String(source.meta ?? '').trim().slice(0, QUOTE_ATTACHMENT_TEXT_MAX)
    if (out.some((existing) => existing.name === name && existing.kind === kind)) continue
    out.push({ name, kind, meta })
    if (out.length >= QUOTE_ATTACHMENT_MAX) break
  }
  return out
}

/** 归一卡正文全文：默认全文照录；只有超上限才截断并显式标注（与服务端口径一致）。 */
export function normalizeQuoteBody(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (text.length <= QUOTE_BODY_MAX_CHARS) return text
  return `${text.slice(0, QUOTE_BODY_MAX_CHARS)}\n（卡正文超过 ${QUOTE_BODY_MAX_CHARS} 字，引用链路只保到这里；后面还有 ${text.length - QUOTE_BODY_MAX_CHARS} 字未注入）`
}

/** 归一宿主/缓存送来的引用记录；形状不对就整条丢掉（宁可不注入也不乱注入）。 */
export function normalizeQuoteRecord(raw: unknown, now = Date.now()): SecretaryQuoteRecord | null {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (source === null) return null
  const cardKey = normalizeCardKey(source.cardKey)
  const kind = String(source.kind ?? '').trim()
  if (cardKey === '' || (kind !== CARD_KIND_ASSISTANT && kind !== CARD_KIND_USER && kind !== CARD_KIND_NOTICE)) return null
  const previewRaw = String(source.preview ?? '')
  const preview = previewRaw.length > QUOTE_PREVIEW_MAX_CHARS ? `${previewRaw.slice(0, QUOTE_PREVIEW_MAX_CHARS - 1)}…` : previewRaw
  const updatedAtRaw = Number(source.updatedAt)
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : now
  return {
    cardKey,
    kind,
    turnNo: String(source.turnNo ?? '').trim(),
    preview,
    body: normalizeQuoteBody(source.body),
    attachments: normalizeQuoteAttachments(source.attachments),
    refSessionIds: normalizeQuoteSessionIds(source.refSessionIds),
    updatedAt,
  }
}

/** 这条引用还在不在（TTL 口径，纯算术）。 */
export function quoteAlive(record: SecretaryQuoteRecord | null, now = Date.now(), ttlMs = QUOTE_TTL_MS): boolean {
  if (record === null) return false
  return now - record.updatedAt <= ttlMs
}

export interface SecretaryQuoteDeps {
  /** 浏览器里是 window.fetch；单测里是假实现。缺 → 按「宿主答不上」降级。 */
  fetchImpl?: (url: string, init?: any) => Promise<any>
  /** 本地兜底缓存（宿主答不上时还能立刻知道引用着哪张卡）；缺 → 只用心跳集合。 */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null
  /** 引用还能活多久（单测验「到期自动清除」才注入短的；缺 → QUOTE_TTL_MS 三十分钟）。 */
  ttlMs?: number
}

export interface SecretaryQuoteStore {
  session(): string
  setSession(sessionId: string): void
  active(): SecretaryQuoteRecord | null
  isQuoted(cardKey: string): boolean
  /** 登记引用：立刻本地生效（按钮当场变成引用态），再写缓存 + 落宿主；宿主失败不阻塞。 */
  setQuote(record: { cardKey: string; kind: string; turnNo?: string; preview?: string; body?: string; attachments?: SecretaryQuoteAttachment[]; refSessionIds?: string[] }): boolean
  /** 取消引用（cardKey 不匹配当前引用时什么都不动）。用户主动按取消 → 服务端那份也一起清。 */
  clearQuote(cardKey?: string): boolean
  /**
   * 扫描层上报「页面上最末一条真实用户消息卡」（合成通知行不算，口径同宿主「通知轮不吃引用」）。
   * 返回 true = 这一看发现那条消息已经发出去了，引用该收（提示跟着消失）。
   */
  noteLatestUserCard(ref: QuoteUserCardRef): boolean
  /** 当前基线（引用登记那一刻的最末真实用户卡）：测试取证。 */
  baselineUserCard(): QuoteUserCardRef | null
  hydrate(): Promise<{ ok: boolean; hostOk: boolean; active: boolean }>
  subscribe(listener: () => void): () => void
  getVersion(): number
}

export function createSecretaryQuoteStore(deps: SecretaryQuoteDeps = {}): SecretaryQuoteStore {
  const listeners = new Set<() => void>()
  const storage = deps.storage ?? null
  const storageKey = QUOTE_STORAGE_PREFIX
  const ttlMs = Number.isFinite(deps.ttlMs) && Number(deps.ttlMs) > 0 ? Number(deps.ttlMs) : QUOTE_TTL_MS
  let session = ''
  let version = 0
  let active: SecretaryQuoteRecord | null = null
  let hostBroken = false
  let hydrateCall: Promise<{ ok: boolean; hostOk: boolean; active: boolean }> | null = null
  // 引用基线 + 最末真实用户卡（扫描层每次扫完报一次），加上 TTL 到期定时器
  let latestUser: QuoteUserCardRef | null = null
  let baseline: QuoteUserCardRef | null = null
  let expiryTimer: any = null

  const g = globalThis as any
  const emit = (): void => { for (const listener of [...listeners]) { try { listener() } catch { /* 单个订阅者出错不影响别的 */ } } }
  const bump = (): void => { version += 1; emit() }

  const readCache = (): SecretaryQuoteRecord | null => {
    if (storage === null || session === '') return null
    try { return normalizeQuoteRecord(JSON.parse(String(storage.getItem(`${storageKey}${session}`) ?? 'null'))) } catch { return null }
  }
  const writeCache = (record: SecretaryQuoteRecord | null): void => {
    if (storage === null || session === '') return
    try { storage.setItem(`${storageKey}${session}`, JSON.stringify(record)) } catch { /* 缓存写不进去不影响引用 */ }
  }
  const readBaselineCache = (): QuoteUserCardRef | null => {
    if (storage === null || session === '') return null
    try {
      const raw = JSON.parse(String(storage.getItem(`${QUOTE_BASELINE_STORAGE_PREFIX}${session}`) ?? 'null')) as any
      const cardKey = normalizeCardKey(raw?.cardKey)
      if (cardKey === '') return null
      return { cardKey, turnNo: String(raw?.turnNo ?? '') }
    } catch { return null }
  }
  const writeBaselineCache = (ref: QuoteUserCardRef | null): void => {
    if (storage === null || session === '') return
    try { storage.setItem(`${QUOTE_BASELINE_STORAGE_PREFIX}${session}`, JSON.stringify(ref ?? null)) } catch { /* 基线记不住不影响引用本身 */ }
  }

  const clearExpiryTimer = (): void => {
    if (expiryTimer === null) return
    try { g.clearTimeout?.(expiryTimer) } catch { /* 定时器已经没了 */ }
    expiryTimer = null
  }
  /** 到点自己收（要求 2：TTL 到期自动清除）：本地收掉 + 请宿主也清；引用本身按 updatedAt 已经判死。 */
  const scheduleExpiry = (record: SecretaryQuoteRecord | null): void => {
    clearExpiryTimer()
    if (record === null) return
    const delay = quoteExpiryDelayMs(record, Date.now(), ttlMs)
    // 挂上来那一刻就已经过期（delay 0）也照收：1ms 后立刻收干净，不许挂在 store 里等下一次 DOM 变化
    if (typeof g.setTimeout !== 'function') return
    expiryTimer = g.setTimeout(() => {
      expiryTimer = null
      if (active === null) return
      if (quoteAlive(active, Date.now(), ttlMs)) { scheduleExpiry(active); return }
      baseline = null
      writeBaselineCache(null)
      apply(null, true)
    }, delay > 0 ? delay : 1)
    // node 环境（单测）别把这个定时器算进事件循环，否则进程会一直挂着等三十分钟
    try { expiryTimer?.unref?.() } catch { /* 浏览器里没有 unref */ }
  }

  const apply = (record: SecretaryQuoteRecord | null, persistHost: boolean): void => {
    active = record
    writeCache(record)
    scheduleExpiry(record)
    bump()
    if (persistHost) void postQuote(record)
  }

  /**
   * 登记要落宿主：宿主那次 POST 是引用能不能生效的唯一真值，**不许静默丢**（2026-11-25 第二次修法的登记侧）：
   *   - 会话 id 还没到手（store 刚创建/页面刚刷新）→ 记成待发，setSession 一拿到 id 就补发；
   *   - 上一次 POST 失败（宿主重载/网络抖动）→ 不永久锁死，下一次登记照旧重试，成功即解除。
   */
  let pendingPost: { record: SecretaryQuoteRecord | null } | null = null
  const postQuote = (record: SecretaryQuoteRecord | null): Promise<void> => {
    const fetchImpl = deps.fetchImpl
    if (typeof fetchImpl !== 'function') return Promise.resolve()
    if (session === '') { pendingPost = { record }; return Promise.resolve() }
    pendingPost = null
    const body = record === null
      ? { sessionId: session, mark: 'clear' }
      : { sessionId: session, mark: 'quote', ...record }
    return fetchImpl(ASSISTANT_SECRETARY_QUOTE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(() => { hostBroken = false }, () => { hostBroken = true })
  }

  return {
    session(): string { return session },
    setSession(sessionId: string): void {
      const id = String(sessionId ?? '')
      if (id === session) return
      session = id
      active = readCache()
      baseline = readBaselineCache()
      scheduleExpiry(active)
      bump()
      // 会话 id 迟到的登记在这里补发一次（否则那颗引用永远只活在本地，宿主 prompt 里一个字都没有）
      if (pendingPost !== null) { const queued = pendingPost.record; pendingPost = null; void postQuote(queued) }
    },
    active(): SecretaryQuoteRecord | null { return quoteAlive(active, Date.now(), ttlMs) ? active : null },
    isQuoted(cardKey: string): boolean {
      const current = quoteAlive(active, Date.now(), ttlMs) ? active : null
      return current !== null && current.cardKey === normalizeCardKey(cardKey)
    },
    setQuote(record: { cardKey: string; kind: string; turnNo?: string; refSessionIds?: string[], preview?: string; body?: string; attachments?: SecretaryQuoteAttachment[] }): boolean {
      const next = normalizeQuoteRecord({
        cardKey: record.cardKey,
        kind: record.kind,
        turnNo: record.turnNo ?? '',
        preview: record.preview ?? '',
        body: record.body ?? '',
        attachments: record.attachments ?? [],
        refSessionIds: record.refSessionIds ?? [],
        updatedAt: Date.now(),
      })
      if (next === null) return false
      if (active !== null && active.cardKey === next.cardKey) return false
      // 基线 = 那一刻页面上最末那条真实用户消息；它变了就意味着用户已经发过消息了
      baseline = latestUser !== null && normalizeCardKey(latestUser.cardKey) !== '' ? { ...latestUser } : null
      writeBaselineCache(baseline)
      apply(next, true)
      return true
    },
    clearQuote(cardKey?: string): boolean {
      const key = normalizeCardKey(cardKey)
      if (active === null) return false
      if (key !== '' && active.cardKey !== key) return false
      baseline = null
      writeBaselineCache(null)
      apply(null, true)
      return true
    },
    noteLatestUserCard(ref: QuoteUserCardRef): boolean {
      const cardKey = normalizeCardKey(ref?.cardKey)
      latestUser = { cardKey, turnNo: String(ref?.turnNo ?? '') }
      if (active === null) return false
      if (!quoteAlive(active, Date.now(), ttlMs)) return false
      if (baseline === null) {
        // 基线还没定（刷新页面 / 引用登记时页面上还没有用户行）：这一次只立基线，不吃引用
        if (cardKey === '') return false
        baseline = { ...latestUser }
        writeBaselineCache(baseline)
        return false
      }
      if (!quoteConsumedByUserRow(baseline, latestUser)) return false
      // 那条消息已经发出去了：本地收掉（服务端由宿主自己在 turn/end 收，客户端不抢先 POST clear）
      baseline = null
      writeBaselineCache(null)
      apply(null, false)
      return true
    },
    baselineUserCard(): QuoteUserCardRef | null { return baseline },
    hydrate(): Promise<{ ok: boolean; hostOk: boolean; active: boolean }> {
      if (hydrateCall !== null) return hydrateCall
      hydrateCall = (async (): Promise<{ ok: boolean; hostOk: boolean; active: boolean }> => {
        const cached = readCache()
        if (cached !== null && active === null) { active = cached; baseline = readBaselineCache(); scheduleExpiry(cached); bump() }
        const fetchImpl = deps.fetchImpl
        if (hostBroken || session === '' || typeof fetchImpl !== 'function') {
          return { ok: true, hostOk: false, active: quoteAlive(active, Date.now(), ttlMs) }
        }
        try {
          const res = await fetchImpl(`${ASSISTANT_SECRETARY_QUOTE_ROUTE}?sessionId=${encodeURIComponent(session)}`, { cache: 'no-store' })
          if (res?.ok !== true) { hostBroken = true; return { ok: true, hostOk: false, active: quoteAlive(active, Date.now(), ttlMs) } }
          const payload = await res.json()
          if ((payload as any)?.ok !== true) { hostBroken = true; return { ok: true, hostOk: false, active: quoteAlive(active, Date.now(), ttlMs) } }
          const fromHost = normalizeQuoteRecord((payload as any)?.quote)
          active = fromHost
          writeCache(fromHost)
          if (fromHost === null) { baseline = null; writeBaselineCache(null) }
          scheduleExpiry(fromHost)
          bump()
          return { ok: true, hostOk: true, active: quoteAlive(fromHost, Date.now(), ttlMs) }
        } catch {
          hostBroken = true
          return { ok: true, hostOk: false, active: quoteAlive(active, Date.now(), ttlMs) }
        }
      })()
      return hydrateCall
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    getVersion(): number { return version },
  }
}

/** 卡片组件共用的**进程内引用 store**（懒创建）：真值在宿主，localStorage 只是首屏缓存与兜底。 */
let cardQuoteStore: SecretaryQuoteStore | null = null
export function secretaryQuoteStore(): SecretaryQuoteStore {
  if (cardQuoteStore !== null) return cardQuoteStore
  const g: any = globalThis as any
  const fetchImpl = typeof g.fetch === 'function' ? (url: string, init?: any) => g.fetch(url, init) : undefined
  let storage: SecretaryQuoteDeps['storage'] = null
  try { if (g.localStorage && typeof g.localStorage.getItem === 'function') storage = g.localStorage } catch { storage = null }
  cardQuoteStore = createSecretaryQuoteStore({ fetchImpl, storage })
  return cardQuoteStore
}

export const secretaryCardsTestSurface = {
  normalizeForSpeech,
  stripSessionRefs,
  parseSessionRefs,
  parseAttachRefs,
  stripAttachRefs,
  ATTACH_IMAGE_EXTENSIONS,
  attachExtensionOf,
  isAttachImage,
  attachTypeBadge,
  attachFileUrl,
  attachDownloadUrl,
  attachOpenViaDownload,
  formatFileSize,
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
  SECRETARY_USER_ROW_SELECTOR,
  SECRETARY_USER_FLOW_KINDS,
  USER_FLOW_KIND_USER,
  USER_FLOW_KIND_STEERING,
  collectSecretaryCardElements,
  collectUserCardRuns,
  userCardRunText,
  userCardAttachments,
  buildUserCardBody,
  USER_TEXT_RUN_SELECTOR,
  USER_ATTACHMENT_ROW_SELECTOR,
  USER_IMAGES_SLOT_SELECTOR,
  buildSecretaryPagerCards,
  foldClipFromBlocks,
  cardFoldStyle,
  NOTICE_CARD_TTL_MS,
  NOTICE_CLOCK_MINUTE_MS,
  NOTICE_ARRIVAL_STORAGE_KEY,
  MAX_NOTICE_ARRIVAL_KEYS,
  noticeExpiryFromClock,
  noticeExpiry,
  nearestNoticeExpiryMs,
  noticeCardExpired,
  createSecretaryNoticeArrivalStore,
  noticeArrivalStore,
  COMPACT_HINT_ATTRIBUTE,
  COMPACT_SUMMARY_HINT_RE,
  COMPACT_FAILURE_HINT_RE,
  isCompactHintText,
  tagSecretaryCompactHintRows,
  clearSecretaryCompactHintRows,
  PROCESS_VISIBLE_ATTRIBUTE,
  PROCESS_VISIBLE_KINDS,
  tagLatestTurnProcessRows,
  clearLatestTurnProcessTags,
  ASSISTANT_SECRETARY_QUOTE_ROUTE,
  QUOTE_STORAGE_PREFIX,
  QUOTE_BASELINE_STORAGE_PREFIX,
  QUOTE_TTL_MS,
  QUOTE_PREVIEW_MAX_CHARS,
  QUOTE_BODY_MAX_CHARS,
  QUOTE_ATTACHMENT_MAX,
  QUOTE_CHIP_FLAG_TEXT,
  QUOTE_CHIP_CANCEL_TEXT,
  QUOTE_CHIP_PREVIEW_MAX_CHARS,
  QUOTE_CHIP_KIND_LABELS,
  normalizeQuoteRecord,
  normalizeQuoteSessionIds,
  normalizeQuoteAttachments,
  normalizeQuoteBody,
  quoteAlive,
  quoteTurnNumber,
  quoteConsumedByUserRow,
  latestRealUserCardRef,
  quoteChipVisible,
  quoteChipPreview,
  quoteChipParts,
  quoteExpiryDelayMs,
    quoteTurnFromCardKey,
  createSecretaryQuoteStore,
  secretaryQuoteStore,
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
  HISTORY_FOLLOW_BOTTOM_PX,
  planHistoryScrollRestore,
  pickHistoryAnchorKey,
  captureHistoryScrollSnapshot,
  HISTORY_CARD_ROW_SELECTOR,
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
