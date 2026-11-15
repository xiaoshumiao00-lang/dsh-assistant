/**
 * 鹈鹕语音「结束词自动收尾」的判定核心（用户 2026-11-13 需求）。
 *
 * 背景：录音结束以前只有两种方式 —— 再点一下录音按钮，或到 3 分钟上限；
 * 本机 ASR（whisper.cpp）是一次性整段转写，没有流式接口。所以「说完就发」只能靠
 * 设备在录音期间定时把**尾部一小段**送去转写（分段），由宿主判定末尾有没有结束词；
 * 判定永远在宿主做（配置、白名单、剥词都只有一份），设备只负责按结论停录。
 *
 * 规则（与用户口径逐条对应）：
 *   1. 去标点空格后必须位于转写**结尾**；结尾词后不许再有别的字（句中出现不算）；
 *   2. 强词（完毕/发送/over/...）默认启用；弱词（好了/行了/搞定/可以了）只在
 *      **整段最末尾且独立成句**（前面是标点或开头）才算，且可整体关闭；
 *   3. 重复（就这样就这样）只剥**一次**尾部；剥完只剩结束词 → 判误触（不发送）；
 *   4. 否定（不结束/没完毕）不算；英文词要词边界（moreover / undone / resend it 不算）。
 *
 * 纯函数、无 IO：lane 与测试共用同一份；公网 relay 是另一份等价实现（那边不跑插件）。
 */

/** 强结束词：默认就启用（尾部匹配）。 */
export const TIHU_END_WORDS: readonly string[] = [
  '完毕', '结束', '结束吧', '就这样', '就这样吧', '就这些', '发送', '提交', '收工', '确认发送',
  'over', 'done', 'send it',
]

/** 弱结束词：默认只在整段最末尾且独立成句时才算（可整体关闭）。 */
export const TIHU_END_WORDS_WEAK: readonly string[] = ['好了', '行了', '搞定', '可以了']

/** 分段默认粒度：每 1.2 秒探一次尾部。 */
export const TIHU_END_WORD_SEGMENT_MS = 1200
/** 每次探针带上的尾部音频长度（默认 3.2 秒，覆盖一句话的收尾）。 */
export const TIHU_END_WORD_TAIL_MS = 3200

/** 结束词判定的生效配置（全部解析完、可直接用）。 */
export interface TihuEndWordConfig {
  /** 总开关（config `tihu.voice.endWordAutoSend`，默认开）。关了就不探针、不剥词。 */
  enabled: boolean
  /** 强结束词（已归一、去重、按长度降序）。 */
  words: string[]
  /** 弱结束词（同上）。 */
  weakWords: string[]
  /** 弱词开关（config `tihu.voice.endWordWeakEnabled`，默认开）。 */
  weakEnabled: boolean
  /** 分段粒度（毫秒，config `tihu.voice.segmentMs`）。 */
  segmentMs: number
  /** 探针尾部窗口（毫秒，config `tihu.voice.segmentTailMs`）。 */
  segmentTailMs: number
}

/** config.json 里 `tihu.voice` 允许出现的结束词相关键（都可不写，缺失=默认）。 */
export interface TihuEndWordConfigInput {
  endWords?: unknown
  endWordsWeak?: unknown
  endWordWeakEnabled?: unknown
  endWordAutoSend?: unknown
  segmentMs?: unknown
  segmentTailMs?: unknown
}

/** 一次尾部判定结果。 */
export interface TihuEndWordMatch {
  /** 末尾命中结束词。 */
  matched: boolean
  /** 命中的词（原文写法）。 */
  word: string
  /** 命中弱词。 */
  weak: boolean
  /**
   * 整段只有结束词（含「就这样就这样」这种重复、以及「完毕。完毕」）：
   * 属于误触，**不发送**，由调用方回显提示。
   */
  onlyWord: boolean
  /** 尾部重复出现（只剥一次；剥完的内容仍在 `text` 里）。 */
  repeated: boolean
  /** 剥掉**一次**尾部结束词后的正文（`matched=false` 时是原文）。 */
  text: string
  /** 原文（未裁剪）。 */
  raw: string
}

/** 标点/空白：判定与剥词都跳过它们（「去标点空格」）。 */
const END_WORD_NOISE = /[\s\p{P}]/u
/** 弱词「独立成句」：结束词前面必须是句读或开头（不能是「我好了」的「我」）。 */
const END_WORD_SENTENCE_BREAK = /[，。！？、；：,.!?;:…\n]/u
/** 否定词：`不结束` / `没完毕` 不是在收尾。 */
const END_WORD_NEGATION = /[不没别未勿甭]/u

/** 去掉空白与标点、转小写，仅用于比对（不用于回写）。 */
export function normalizeEndWordText(text: unknown): string {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}]+/gu, '')
}

/** 把配置里的词表归一：去空白、去重、按长度降序（长的优先匹配）。 */
function normalizeWordList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const word = item.replace(/\s+/g, ' ').trim()
    if (word === '') continue
    const key = normalizeEndWordText(word)
    if (key === '' || seen.has(key)) continue
    if ([...word].length > 24) continue
    seen.add(key)
    out.push(word)
    if (out.length >= 40) break
  }
  return out.sort((a, b) => normalizeEndWordText(b).length - normalizeEndWordText(a).length)
}

function normalizeWordsOr(raw: unknown, fallback: readonly string[]): string[] {
  const list = normalizeWordList(raw)
  return list.length > 0 ? list : normalizeWordList([...fallback])
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

/**
 * 解析 config 的 `tihu.voice`（或空）→ 生效配置。
 *
 * 缺失/形状错误一律退回默认（开箱可用），只有显式 `false` 才关闭开关。
 */
export function resolveTihuEndWordConfig(input?: TihuEndWordConfigInput | null): TihuEndWordConfig {
  const voice = (input ?? {}) as TihuEndWordConfigInput
  return {
    enabled: voice.endWordAutoSend !== false,
    words: normalizeWordsOr(voice.endWords, TIHU_END_WORDS),
    weakWords: normalizeWordsOr(voice.endWordsWeak, TIHU_END_WORDS_WEAK),
    weakEnabled: voice.endWordWeakEnabled !== false,
    segmentMs: clampInt(voice.segmentMs, 400, 5000, TIHU_END_WORD_SEGMENT_MS),
    segmentTailMs: clampInt(voice.segmentTailMs, 1200, 8000, TIHU_END_WORD_TAIL_MS),
  }
}

/** 默认配置（测试/无 config 时的开箱默认）。 */
export function defaultTihuEndWordConfig(): TihuEndWordConfig {
  return resolveTihuEndWordConfig(null)
}

/** 归一后的词在原文里的起始下标（跳过标点空格反向对齐）；对不上返回 -1。 */
function suffixStartInRaw(raw: string, normalizedWord: string): number {
  const need = [...normalizedWord]
  let k = need.length - 1
  let i = raw.length - 1
  while (i >= 0 && k >= 0) {
    const ch = raw.charAt(i)
    if (END_WORD_NOISE.test(ch)) {
      i -= 1
      continue
    }
    if (ch.toLowerCase() === need[k]) {
      k -= 1
      i -= 1
      continue
    }
    return -1
  }
  return k < 0 ? i + 1 : -1
}

/** 这段归一文本是不是「只由结束词拼成」（用于重复词/连说多个词的误触判断）。 */
function isOnlyEndWords(normalized: string, config: TihuEndWordConfig): boolean {
  const words = [...config.words, ...(config.weakEnabled ? config.weakWords : [])]
    .map((word) => normalizeEndWordText(word))
    .filter((word) => word !== '')
    .sort((a, b) => b.length - a.length)
  let rest = normalized
  while (rest !== '') {
    const hit = words.find((word) => rest.startsWith(word))
    if (hit === undefined) return false
    rest = rest.slice(hit.length)
  }
  return true
}

function noMatch(raw: string): TihuEndWordMatch {
  return { matched: false, word: '', weak: false, onlyWord: false, repeated: false, text: raw, raw }
}

/**
 * 判定一段转写文本的**结尾**有没有结束词，并给出剥掉一次后的正文。
 *
 * 纯函数，不改入参；`config` 不传就用默认词表（开箱可用）。
 */
export function matchTihuEndWord(text: unknown, config: TihuEndWordConfig = defaultTihuEndWordConfig()): TihuEndWordMatch {
  const raw = String(text ?? '').trim()
  if (!config.enabled || raw === '') return noMatch(raw)
  const normalized = normalizeEndWordText(raw)
  if (normalized === '') return noMatch(raw)
  const candidates = [
    ...config.words.map((word) => ({ word, weak: false })),
    ...(config.weakEnabled ? config.weakWords.map((word) => ({ word, weak: true })) : []),
  ]
    .map((candidate) => ({ ...candidate, norm: normalizeEndWordText(candidate.word) }))
    .filter((candidate) => candidate.norm !== '')
    .sort((a, b) => b.norm.length - a.norm.length)
  for (const candidate of candidates) {
    if (!normalized.endsWith(candidate.norm)) continue
    const at = normalized.length - candidate.norm.length
    const start = suffixStartInRaw(raw, candidate.norm)
    if (start < 0) continue
    // 英文词边界：moreover 不能命中 over，undone 不能命中 done；但「all done」的
    // 空格是词边界（归一化把空格去掉了，所以这里按**原文**前一个字符判）。
    if (/^[a-z0-9]/i.test(candidate.norm) && start > 0 && /[a-z0-9]/i.test(raw.charAt(start - 1))) continue
    // 否定：不结束 / 没完毕 不算收尾。
    if (at > 0 && END_WORD_NEGATION.test(normalized.charAt(at - 1))) continue
    if (candidate.weak) {
      // 弱词必须独立成句：前面是标点或整段开头（「我好了」不算）。
      const before = raw.slice(0, start).replace(/\s+$/u, '')
      const prev = before === '' ? '' : before.charAt(before.length - 1)
      if (prev !== '' && !END_WORD_SENTENCE_BREAK.test(prev)) continue
    }
    const rest = raw.slice(0, start).replace(/[\s\p{P}]+$/u, '')
    const restNorm = normalizeEndWordText(rest)
    const onlyWord = restNorm === '' || isOnlyEndWords(restNorm, config)
    const repeated = restNorm !== '' && restNorm.endsWith(candidate.norm)
    return { matched: true, word: candidate.word, weak: candidate.weak, onlyWord, repeated, text: rest, raw }
  }
  return noMatch(raw)
}

/**
 * 设备探针（`/tihu/asr?probe=1`）的响应形状。
 *
 * 设备只认这几个字段：`enabled` 关掉就停止探针；`segmentMs/segmentTailMs` 用宿主配置；
 * `endWord.text` 是剥过一次结束词后的正文（命中的那一次由设备直接发送）。
 */
export interface TihuEndWordProbeReply {
  probe: true
  enabled: boolean
  segmentMs: number
  segmentTailMs: number
  endWord: {
    matched: boolean
    word: string
    weak: boolean
    onlyWord: boolean
    repeated: boolean
    text: string
  }
}

/** 把一次判定包成探针响应（`text` 不塞进去，避免设备误用整段转写）。 */
export function endWordProbeReply(config: TihuEndWordConfig, match: TihuEndWordMatch): TihuEndWordProbeReply {
  return {
    probe: true,
    enabled: config.enabled,
    segmentMs: config.segmentMs,
    segmentTailMs: config.segmentTailMs,
    endWord: {
      matched: match.matched,
      word: match.word,
      weak: match.weak,
      onlyWord: match.onlyWord,
      repeated: match.repeated,
      text: match.text,
    },
  }
}
