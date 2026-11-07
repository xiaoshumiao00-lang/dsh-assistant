/**
 * 回复正文阅读（reply 模式）的分句 / 窗口计算（纯函数）。
 *
 * 屏幕 320×240：正文 16px、行高 20、每行 18 字、可视 10 行（≈180 字/屏）。
 * 滚动按**句子**跳：当前朗读句保持在可视区中部；LVGL 固件照这份逻辑实现。
 */
import { SCREEN_SPEC } from './screen-spec.ts'

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

export interface ReplyLine {
  text: string
  /** 该行属于哪一句（用于高亮）。 */
  sentenceIndex: number
}

/** 把窗口内的句子按每行 `charsPerLine` 折行（不切断行尾，超出即换行）。 */
export function wrapReplyLines(sentences: ReplySentence[], charsPerLine = SCREEN_SPEC.bodyCharsPerLine): ReplyLine[] {
  const lines: ReplyLine[] = []
  for (const sentence of sentences) {
    const chars = [...sentence.text]
    if (chars.length === 0) continue
    for (let offset = 0; offset < chars.length; offset += charsPerLine) {
      lines.push({ text: chars.slice(offset, offset + charsPerLine).join(''), sentenceIndex: sentence.index })
    }
  }
  return lines
}

/**
 * 计算最终显示窗口：当前句尽量居中，首尾不越界，最多 `visibleLines` 行。
 * 返回的行都 ≤ charsPerLine，不会出现半行被切。
 */
export function replyViewport(
  sentences: ReplySentence[],
  currentIndex: number,
  visibleLines = SCREEN_SPEC.replyVisibleLines,
  charsPerLine = SCREEN_SPEC.bodyCharsPerLine,
): { lines: ReplyLine[]; startLine: number; currentLine: number } {
  const window = replyWindow(sentences, currentIndex)
  const lines = wrapReplyLines(window, charsPerLine)
  return fitViewport(lines, currentIndex, visibleLines)
}

/** 从完整行列表里截出可视窗口（当前句居中，边界收拢）。 */
export function fitViewport(
  lines: ReplyLine[],
  currentIndex: number,
  visibleLines = SCREEN_SPEC.replyVisibleLines,
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
