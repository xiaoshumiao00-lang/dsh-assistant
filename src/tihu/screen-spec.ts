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
  /** 正文最多行数。 */
  maxBodyLines: 3,
  /** 标题字号（加粗）。 */
  titleFontPx: 18,
  /** 标题最大字符数。 */
  titleChars: 28,
  /** stage 小字字号。 */
  stageFontPx: 12,
  /** stage 最大字符数。 */
  stageChars: 10,
  /** reply 模式：可视正文行数（16px/20px 行高）。 */
  replyVisibleLines: 10,
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

/** 按 Unicode 码点截断，超长补省略号；不会切出半个字。 */
export function clipScreenText(value: unknown, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

/** 标题：最多 28 字，一行。 */
export function clipScreenTitle(value: unknown): string {
  return clipScreenText(value, SCREEN_SPEC.titleChars)
}

/** stage：最多 10 字。 */
export function clipScreenStage(value: unknown): string {
  return clipScreenText(value, SCREEN_SPEC.stageChars)
}

/**
 * 正文：只保留前 `maxLines`（默认 3）条非空行，每行截到 18 字。
 * 多出来的进事件区，不塞进屏幕。
 */
export function fitScreenLines(
  lines: readonly unknown[],
  maxLines: number = SCREEN_SPEC.maxBodyLines,
  maxChars: number = SCREEN_SPEC.bodyCharsPerLine,
): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (out.length >= maxLines) break
    const clipped = clipScreenText(line, maxChars)
    if (clipped !== '') out.push(clipped)
  }
  return out
}
