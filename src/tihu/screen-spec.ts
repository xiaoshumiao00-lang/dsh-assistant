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
  /** 统计行（第四行）字号：比正文小 2 号。 */
  statsFontPx: 14,
  /** 统计行行高。 */
  statsLineHeightPx: 18,
  /** 标题字号（加粗）。 */
  titleFontPx: 18,
  /** 标题最大字符数。 */
  titleChars: 28,
  /** stage 小字字号。 */
  stageFontPx: 12,
  /** stage 最大字符数。 */
  stageChars: 10,
  /** reply 模式：可视正文行数（16px/20px 行高；正文区固定预留一行安全高度后 7 行，见 REPLY_LAYOUT）。 */
  replyVisibleLines: 7,
  /** 棋盘一次显示几行（BOARD_PAGE_SIZE 必须同步；4 行 ×48px 才放得下两行字且不裁切）。 */
  boardRows: 4,
  /** 棋盘一行高度（20px 标题行 + 16px 副行 + 上下各 6px 内边距）。 */
  boardRowHeightPx: 48,
} as const

/**
 * 完成屏垂直预算（320×240，四边 8px）：
 *
 *   内容高 222 = 240 − 2×1 边框 − 2×8 内边距
 *   顶行 14 + 间隙 4 + 大标题 22 + 间隙 4 + 正文 7×20=140 + 间隙 4 + 按钮行 32 = 220
 *   → 余 2px，三键（停止/重读/主页）稳稳放得下，正文 7 行不被裁。
 */
export const DONE_LAYOUT = {
  stageHeightPx: 14,
  titleHeightPx: 22,
  visibleLines: 7,
  lineHeightPx: 20,
  bodyHeightPx: 140,
  actionBarHeightPx: 32,
  columnGapPx: 4,
  /** 14 + 4 + 22 + 4 + 140 + 4 + 32 = 220（≤ 222）。 */
  usedHeightPx: 220,
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
 * 回答屏垂直预算（全部取自页面 CSS 的定量常量，改任何一处都要同步这里）：
 *
 *   内容高 224 = 240 − 8×2 内边距
 *   − 顶行 14（12px / 行高 14，「回答中 · x/y · 已绑定：xxx」）
 *   − 列间隙 4×2（顶行↔正文、正文↔按钮行）
 *   − 底部按钮行 32（按钮 min-height 28 + padding-top 4）
 *   = 正文区 170
 *
 * **固定预留一行安全高度 20px**：末行下面这一整行不许被回答气泡（右侧 64px 轨）、
 * 进度条（reply-mode 已收掉）或顶行占用。
 *   → 每屏 7 行 × 20 = 140，末行下方实留 30px（20 安全行 + 10 取整余量）。
 *   → 240 宽有轨时：正文 240 + 气泡轨 64 = 304 ≤ 内容宽，横向也不压字。
 *
 * 注：页面 `#screen` 还有 1px 边框（box-sizing:border-box），实际内核内容高是 222，
 * 正文区实得 168；7 行 140 仍留 28px（≥ 一整行 20px），所以两种口径都过。
 */
const REPLY_STAGE_HEIGHT_PX = 14
const REPLY_ACTION_BAR_HEIGHT_PX = 32
const REPLY_COLUMN_GAP_PX = 4
const REPLY_CONTENT_HEIGHT_PX = SCREEN_SPEC.heightPx - SCREEN_SPEC.paddingPx * 2
const REPLY_BODY_HEIGHT_PX = REPLY_CONTENT_HEIGHT_PX - REPLY_STAGE_HEIGHT_PX - REPLY_ACTION_BAR_HEIGHT_PX - REPLY_COLUMN_GAP_PX * 2
const REPLY_LINE_HEIGHT_PX = SCREEN_SPEC.bodyLineHeightPx
const REPLY_SAFE_LINE_PX = SCREEN_SPEC.bodyLineHeightPx
const REPLY_VISIBLE_LINES = Math.floor((REPLY_BODY_HEIGHT_PX - REPLY_SAFE_LINE_PX) / REPLY_LINE_HEIGHT_PX)

export const REPLY_LAYOUT = {
  contentHeightPx: REPLY_CONTENT_HEIGHT_PX,
  stageHeightPx: REPLY_STAGE_HEIGHT_PX,
  actionBarHeightPx: REPLY_ACTION_BAR_HEIGHT_PX,
  columnGapPx: REPLY_COLUMN_GAP_PX,
  bodyHeightPx: REPLY_BODY_HEIGHT_PX,
  lineHeightPx: REPLY_LINE_HEIGHT_PX,
  safeLinePx: REPLY_SAFE_LINE_PX,
  visibleLines: REPLY_VISIBLE_LINES,
  usedHeightPx: REPLY_VISIBLE_LINES * REPLY_LINE_HEIGHT_PX,
  bottomFreePx: REPLY_BODY_HEIGHT_PX - REPLY_VISIBLE_LINES * REPLY_LINE_HEIGHT_PX,
  /** 有气泡轨时的正文宽（240）与轨宽（64）：两者相加不得超过内容宽。 */
  railBodyWidthPx: PENDING_RAIL_WIDTH_PX,
  railWidthPx: 64,
  /** 无轨正文宽（304）。 */
  plainBodyWidthPx: CONTENT_WIDTH_PX,
} as const

/** 卡片边框在 box-sizing:border-box 下再吃掉的高度：实际渲染正文区更小。 */
export const SCREEN_BORDER_PX = 1

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
