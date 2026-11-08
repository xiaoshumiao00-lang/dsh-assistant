/**
 * 鹈鹕（tihu）真机屏幕规格：ESP32-S3-BOX-3B 的 2.4″ 320×240 触摸屏。
 *
 * **这是唯一事实来源**：页面按这些常量渲染；P1 的 LVGL 固件也照同一组数值写。
 * 不要把这些数字散落在 CSS / 页面脚本 / lane 里。
 *
 * 版式（320×240，四边 8px 内边距）：
 *   stage   12px 一行（小字）
 *   title   18px 加粗，**1 行**，最多 28 字，超出省略号
 *   body    16px / 行高 20px，**最多 3 行**，每行约 18 字（= (320-16)/16.8）
 *   其余内容进事件区，屏幕 `overflow: hidden`，绝不出现半行或滚动条。
 *
 * 物理尺寸（近似）：2.4 英寸对角线，屏宽 61 mm × 高 45.7 mm；实际尺寸模式按
 * `61mm / (320px @96dpi)` 换算缩放，浏览器 DPI/缩放下可能有 1–2px 误差。
 */
export const SCREEN_SPEC = {
  /** 屏宽（设备像素 = CSS px，1:1）。 */
  widthPx: 320,
  /** 屏高。 */
  heightPx: 240,
  /** 四边内边距。 */
  paddingPx: 8,
  /** 中文正文字号。 */
  bodyFontPx: 16,
  /** 正文行高。 */
  bodyLineHeightPx: 20,
  /** 正文每行字符数（约 18 个汉字）。 */
  bodyCharsPerLine: 18,
  /** 正文最多行数（内容区 224px，16px/20px 行高）。 */
  maxBodyLines: 4,
  /** 标题字号（加粗）。 */
  titleFontPx: 18,
  /** 标题最大字符数。 */
  titleChars: 28,
  /** stage 小字字号。 */
  stageFontPx: 12,
  /** stage 最大字符数。 */
  stageChars: 10,
  /** reply 模式：可视正文行数（16px/20px 行高）。 */
  replyVisibleLines: 9,
} as const

/** 物理规格（近似值，仅用于「实际尺寸」显示）。 */
export const SCREEN_PHYSICAL = {
  diagonalInches: 2.4,
  widthMm: 61,
  heightMm: 45.7,
  /** 96 CSS px / 25.4 mm。 */
  pxPerMm: 96 / 25.4,
} as const

/** 实际尺寸模式下 320px 应显示的 CSS px 缩放（≈0.7205）。 */
export const ACTUAL_SIZE_SCALE = (SCREEN_PHYSICAL.widthMm * SCREEN_PHYSICAL.pxPerMm) / SCREEN_SPEC.widthPx

/** 内容区宽度（320 − 2×8）。 */
export const CONTENT_WIDTH_PX = SCREEN_SPEC.widthPx - SCREEN_SPEC.paddingPx * 2

/** 折行安全边距（像素）：真实字体渲染比 CJK=1em 估算略宽，贴着容器宽折行会被浏览器裁成省略号。 */
export const TEXT_WRAP_SAFETY_PX = 4

/**
 * 待读气泡轨占位后正文可用宽度：页面 `#screen.rail-on .title, ul { width:240px }`，
 * 宿主排版必须用同一个值，否则状态屏三、四行会被 CSS 二次裁掉（2026-11-07 审计 P1-6）。
 */
export const PENDING_RAIL_WIDTH_PX = 240

/**
 * 标题加粗系数：18px/700 的实测渲染比常规宽约 6%，用常规宽估算会贴着 304px 被裁。
 */
export const TITLE_BOLD_FACTOR = 1.06

/** 单个码点的近似宽度（em）：CJK/全角 1.0，ASCII 0.47。 */
export function charWidthEm(char: string): number {
  const code = char.codePointAt(0) ?? 0
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  if (wide) return 1
  // ASCII 按类别估宽：原来一律 0.47em，实测大写/数字/下划线明显更宽，
  // 会把「刚好 304px」的行挤成两行、把第四行统计顶出屏幕。
  if (char === ' ') return 0.26
  if (char >= '0' && char <= '9') return 0.56
  if (char >= 'A' && char <= 'Z') return 0.62
  if (char >= 'a' && char <= 'z') return 0.5
  if ('.,:;!|\'`()[]{}/\\-'.includes(char)) return 0.32
  if (char === '_' || char === '@' || char === '%' || char === '&' || char === '#') return 0.56
  return 0.5
}

/** 估算文本像素宽度。 */
export function measureTextPx(text: string, fontPx: number): number {
  let width = 0
  for (const char of String(text ?? '')) width += charWidthEm(char) * fontPx
  return width
}

/**
 * 按像素宽度截断（超宽才省略，省略号贴右边缘）；不会切半个字。
 */
export function fitLine(value: unknown, maxWidthPx: number = CONTENT_WIDTH_PX, fontPx: number = SCREEN_SPEC.bodyFontPx): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  if (measureTextPx(text, fontPx) <= maxWidthPx) return text
  const chars = [...text]
  const ellipsisWidth = measureTextPx('…', fontPx)
  let width = 0
  let out = ''
  for (const char of chars) {
    const next = width + charWidthEm(char) * fontPx
    if (next + ellipsisWidth > maxWidthPx) break
    out += char
    width = next
  }
  return out === '' ? '…' : `${out}…`
}

/** 按像素宽度折行（保留所有内容，不省略）；返回每行文本。 */
export function wrapTextPx(value: unknown, maxWidthPx: number = CONTENT_WIDTH_PX, fontPx: number = SCREEN_SPEC.bodyFontPx): string[] {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return []
    // 留安全边距：行宽严格小于容器可视宽度，避免行尾最后一个字被裁成省略号。
  const limit = Math.max(1, maxWidthPx - TEXT_WRAP_SAFETY_PX)
const lines: string[] = []
  let current = ''
  let width = 0
  for (const char of [...text]) {
    const charWidth = charWidthEm(char) * fontPx
    if (current !== '' && width + charWidth > limit) {
      lines.push(current.trimEnd())
      current = ''
      width = 0
    }
    current += char
    width += charWidth
  }
  if (current !== '') lines.push(current.trimEnd())
  return lines
}

/** 按 Unicode 码点截断（事件区等非屏幕文本用）。 */
export function clipScreenText(value: unknown, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

/** 标题：一行，按像素宽度省略（标题是 18px 加粗，实际比同字号常规宽约 6%，必须按加粗宽算）。 */
export function clipScreenTitle(value: unknown): string {
  return fitLine(value, CONTENT_WIDTH_PX, SCREEN_SPEC.titleFontPx * TITLE_BOLD_FACTOR)
}

/** stage：一行，按像素宽度省略。 */
export function clipScreenStage(value: unknown): string {
  return fitLine(value, CONTENT_WIDTH_PX, SCREEN_SPEC.stageFontPx)
}

/**
 * 正文：按像素宽度折行，最多 `maxLines` 行；超出部分丢弃（不是按字数截断）。
 */
export function fitScreenLines(
  lines: readonly unknown[],
  maxLines: number = SCREEN_SPEC.maxBodyLines,
): string[] {
  const out: string[] = []
  for (const line of lines) {
    for (const wrapped of wrapTextPx(line, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)) {
      if (out.length >= maxLines) return out
      out.push(wrapped)
    }
  }
  return out
}
