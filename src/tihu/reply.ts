/**
 * 回复正文阅读（reply 模式）的分句 / 窗口计算（纯函数）。
 *
 * 屏幕 320×240：正文 16px、行高 20、每行约 18 字（304 宽）/14 字（240 宽）、
 * 回答屏可视 7 行（约 126 / 98 字每屏），末行下面固定留一行安全高度。
 * 滚动按**句子**跳：当前朗读句保持在可视区中部；LVGL 固件照这份逻辑实现。
 */
import { CONTENT_WIDTH_PX, REPLY_LAYOUT, SCREEN_SPEC, fitLine, measureTextPx, wrapTextPx } from './screen-spec.ts'

export interface ReplySentence {
  index: number
  /** 在整段回复里的起始字符（Unicode 码点下标）。 */
  start: number
  /** 结束字符（不含）。 */
  end: number
  text: string
}

/** 句子结束标点（保留在句子里）。 */
const SENTENCE_END = /[。！？；!?;]/

/**
 * 把整段回复切成句子；下标按 Unicode 码点计数，句与句**首尾相接无空隙**。
 * 没有标点的超长段按 `maxSentenceChars` 硬切（保证每句能进一屏并可高亮）。
 */
export function splitReplySentences(text: string, maxSentenceChars = 120): ReplySentence[] {
  const chars = [...String(text ?? '')]
  const out: ReplySentence[] = []
  let start = 0
  let index = 0
  let cursor = 0
  while (cursor < chars.length) {
    const atBreak = SENTENCE_END.test(chars[cursor]) || chars[cursor] === '\n'
    const tooLong = cursor - start + 1 >= maxSentenceChars
    if (!atBreak && !tooLong) {
      cursor += 1
      continue
    }
    let end = cursor + 1
    // 把紧跟的句末标点/换行一起收进本句（连续标点也只收一次）。
    while (end < chars.length && (SENTENCE_END.test(chars[end]) || chars[end] === '\n')) end += 1
    const slice = chars.slice(start, end).join('').trim()
    if (slice !== '') {
      out.push({ index, start, end, text: slice })
      index += 1
    }
    start = end
    cursor = end
  }
  if (start < chars.length) {
    const slice = chars.slice(start).join('').trim()
    if (slice !== '') out.push({ index, start, end: chars.length, text: slice })
  }
  return out
}

/** 以当前句为中心取窗口（±radius 句），避免长回复每帧全量下发。 */
export function replyWindow(sentences: ReplySentence[], currentIndex: number, radius = 2): ReplySentence[] {
  if (sentences.length === 0) return []
  const index = Math.max(0, Math.min(sentences.length - 1, Number.isFinite(currentIndex) ? currentIndex : 0))
  const start = Math.max(0, index - radius)
  const end = Math.min(sentences.length, index + radius + 1)
  return sentences.slice(start, end)
}

export interface SpeechSegment {
  index: number
  text: string
  start: number
  end: number
  /** 该语音片段属于哪一句正文（用于高亮）。 */
  sentenceIndex: number
}

/** 分句标点（语音切段用，逗号也切，保证第一包尽早发出）。 */
const SPEECH_BREAK = /[，,、：:；;。！？!?\n]/

/**
 * 把回复切成**语音片段**：先按句，再把长句按逗号/顿号切成 ≤maxChars 的小段。
 * 这样长句不必等整句合成完才发首包；片段下标仍映射回原句（高亮按句）。
 *
 * 2026-11-08 用户拍板（治「念半句就断」）：`maxChars` 默认 **32 → 80**，同时
 * **首段单独压到 `firstChars`（默认 20）**——首句最快开口，后面的段可以大一些，
 * 避免 32 字切法把一句完整播报拆成三四个碎片（碎片之间要等合成，听着就是断）。
 */
export function splitSpeechSegments(text: string, maxChars = 80, firstChars = 20): SpeechSegment[] {
  const chars = [...String(text ?? '')]
  const sentences = splitReplySentences(text)
  const out: SpeechSegment[] = []
  let index = 0
  let cursor = 0
  let sentenceIndex = 0
  while (cursor < chars.length && sentenceIndex < sentences.length) {
    // 跳过句间空白
    while (cursor < chars.length && /\s/.test(chars[cursor])) cursor += 1
    if (cursor >= chars.length) break
    while (sentenceIndex < sentences.length && sentences[sentenceIndex].end <= cursor) sentenceIndex += 1
    if (sentenceIndex >= sentences.length) break
    // 首段更短：先让第一句最快发声；之后按 maxChars 切。
    const cap = index === 0 ? Math.max(1, Math.min(maxChars, firstChars)) : maxChars
    let end = cursor
    let lastBreak = -1
    const limit = Math.min(chars.length, sentences[sentenceIndex].end)
    while (end < limit) {
      const char = chars[end]
      if (SPEECH_BREAK.test(char)) { lastBreak = end + 1; break }
      if (end - cursor + 1 >= cap) { lastBreak = end + 1; break }
      end += 1
    }
    if (lastBreak < 0) lastBreak = limit
    let segmentEnd = Math.min(lastBreak, limit)
    while (segmentEnd > cursor && /\s/.test(chars[segmentEnd - 1])) segmentEnd -= 1
    const segmentText = chars.slice(cursor, segmentEnd).join('').trim()
    if (segmentText !== '') {
      while (sentenceIndex < sentences.length && sentences[sentenceIndex].end <= cursor) sentenceIndex += 1
      out.push({ index, text: segmentText, start: cursor, end: segmentEnd, sentenceIndex })
      index += 1
    }
    cursor = Math.max(lastBreak, cursor + 1)
  }
  return out
}

export interface ReplyLine {
  text: string
  /** 该行属于哪一句（用于高亮）。 */
  sentenceIndex: number
}

/** 把窗口内的句子按像素宽度折行（不切断行尾，超出即换行）。 */
export function wrapReplyLines(sentences: ReplySentence[], widthPx = CONTENT_WIDTH_PX, fontPx = SCREEN_SPEC.bodyFontPx): ReplyLine[] {
  const lines: ReplyLine[] = []
  for (const sentence of sentences) {
    for (const text of wrapTextPx(sentence.text, widthPx, fontPx)) {
      lines.push({ text, sentenceIndex: sentence.index })
    }
  }
  return lines
}

/**
 * 计算最终显示窗口：当前句尽量居中，首尾不越界，最多 `visibleLines` 行。
 * 行按像素宽度折行，不会切半个字。
 */
export function replyViewport(
  sentences: ReplySentence[],
  currentIndex: number,
  visibleLines: number = REPLY_LAYOUT.visibleLines,
  widthPx = CONTENT_WIDTH_PX,
): { lines: ReplyLine[]; startLine: number; currentLine: number } {
  const window = replyWindow(sentences, currentIndex)
  const lines = wrapReplyLines(window, widthPx)
  return fitViewport(lines, currentIndex, visibleLines)
}

/** 从完整行列表里截出可视窗口（当前句居中，边界收拢）。 */
export function fitViewport(
  lines: ReplyLine[],
  currentIndex: number,
  visibleLines: number = SCREEN_SPEC.replyVisibleLines,
): { lines: ReplyLine[]; startLine: number; currentLine: number } {
  if (lines.length === 0) return { lines: [], startLine: 0, currentLine: 0 }
  const currentLine = Math.max(0, lines.findIndex((line) => line.sentenceIndex === currentIndex))
  if (lines.length <= visibleLines) return { lines: lines.slice(), startLine: 0, currentLine }
  const half = Math.floor(visibleLines / 2)
  let start = currentLine - half
  start = Math.max(0, Math.min(start, lines.length - visibleLines))
  const slice = lines.slice(start, start + visibleLines)
  return { lines: slice, startLine: start, currentLine: Math.max(0, currentLine - start) }
}

/**
 * 回答屏真正下发的可视窗口（宿主 lane 与单测共用）：
 *   - 按 {@link REPLY_LAYOUT.visibleLines}（7 行）切窗口，`offset` 夹在 [0, maxOffset]；
 *   - 窗口高度 = 7×20 = 140，末行下方固定留 30px（≥ 一整行 20px 安全高度），
 *     气泡轨 / 进度条 / 顶行都进不了这一块；
 *   - 最后一行如果比当前可用宽还宽（旧帧从 304 切到 240 的极端情况），末尾用省略号收住，
 *     绝不让它溢出到右侧气泡轨或底部按钮行。
 */
export function replyVisibleWindow(
  lines: ReplyLine[],
  offset: number,
  options: { widthPx?: number; visibleLines?: number } = {},
): { lines: ReplyLine[]; offset: number; maxOffset: number; truncated: boolean } {
  const widthPx = options.widthPx ?? CONTENT_WIDTH_PX
  const visibleLines = Math.max(1, options.visibleLines ?? REPLY_LAYOUT.visibleLines)
  const maxOffset = Math.max(0, lines.length - visibleLines)
  const start = Math.max(0, Math.min(Math.round(Number.isFinite(offset) ? offset : 0), maxOffset))
  const shown = lines.slice(start, start + visibleLines).map((line) => ({ ...line }))
  let truncated = false
  if (shown.length > 0) {
    const last = shown[shown.length - 1]
    if (measureTextPx(last.text, SCREEN_SPEC.bodyFontPx) > widthPx) {
      last.text = fitLine(last.text, widthPx, SCREEN_SPEC.bodyFontPx)
      truncated = true
    }
  }
  return { lines: shown, offset: start, maxOffset, truncated }
}
