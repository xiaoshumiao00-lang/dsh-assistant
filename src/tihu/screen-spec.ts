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
 * 棋盘一行的版式（2026-11-15 用户要求：标题按**实际折出来的行数**给足高度 ——
 * 行高 = 上下内边距 + 标题行数 × 20 + 副行 16；标题只有一行时正好 48px（`boardRowHeightPx`）。
 * 折行口径与宿主下发的是同一份，见文件末尾「棋盘标题折行」。
 *
 * 物理尺寸（近似）：2.4 英寸对角线，屏宽 61 mm × 高 45.7 mm；实际尺寸模式按
 * `61mm / (320px @96dpi)` 换算缩放，浏览器 DPI/缩放下可能有 1–2px 误差。
 */
/**
 * 棋盘一行的版式常量（与 page.ts 的 CSS 同一份数字，宿主折行/页面卡高都从这里取）。
 * 改任何一处都要同时改 page.ts 的 `.board-*` CSS，以及这里 —— 两边不许各写一套。
 */
/** 标题字号（`.board-row1` font-size:15px，加粗）。 */
export const BOARD_TITLE_FONT_PX = 15
/** 一行标题的块高（15px 加粗 → 行高 20px）。 */
export const BOARD_TITLE_LINE_HEIGHT_PX = 20
/** 副行字号（`.board-row2` 12px）。 */
export const BOARD_SUB_FONT_PX = 12
/** 副行（`.board-row2` 12px）的块高。 */
export const BOARD_SUB_LINE_HEIGHT_PX = 16
/** 卡片上下内边距（`.board-item` padding:6px 0）。 */
export const BOARD_ROW_PADDING_PX = 6
/** 一行卡片的最小高度：6+6 内边距 + 20 一行标题 + 16 副行 = 48（= SCREEN_SPEC.boardRowHeightPx）。 */
export const BOARD_ROW_MIN_HEIGHT_PX = BOARD_ROW_PADDING_PX * 2 + BOARD_TITLE_LINE_HEIGHT_PX + BOARD_SUB_LINE_HEIGHT_PX
/** 行内 flex gap（胶囊 ↔ 标题 ↔ 微条）。 */
export const BOARD_ROW_GAP_PX = 6
/** 状态胶囊字号（`.board-capsule` 11px）。 */
export const BOARD_CAPSULE_FONT_PX = 11
/** 胶囊左右内边距各 5px。 */
export const BOARD_CAPSULE_H_PADDING_PX = 5
/** 胶囊边框宽（1px，四边各一份）。 */
export const BOARD_CAPSULE_BORDER_PX = 1
/** 胶囊字距（letter-spacing:.5px，每个字后面一份）。 */
export const BOARD_CAPSULE_LETTER_SPACING_PX = 0.5
/** 微条：一根 2px 宽、间隙 2px、离标题 2px，最多 8 根。 */
export const BOARD_MICRO_BAR_PX = 2
export const BOARD_MICRO_GAP_PX = 2
export const BOARD_MICRO_MARGIN_PX = 2
export const BOARD_MICRO_MAX_BARS = 8
/**
 * 一行标题最多折到第几行（2026-11-15 用户要求：宁可卡片变高、一屏少显示几行，
 * 也不许出现「半截断尾」的标题；超过这几行才在最后一行末尾补省略号，完整标题留在该卡可取）。
 */
export const BOARD_MAX_TITLE_LINES = 3

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
  /** 棋盘可视区一次看得见几行（与 task-ledger.ts 的 BOARD_VIEWPORT_ROWS 同步）。后面的行在同一列里往上滑出来，不切页。 */
  boardRows: 4,
  /** 棋盘一行**最小**高度（上下 6px 内边距 + 20px 一行标题 + 16px 副行）；标题折出多行时卡高跟着长，标题永远整行可见。 */
  boardRowHeightPx: BOARD_ROW_MIN_HEIGHT_PX,
  /** 棋盘版式常量（页面只消费这里，不另写数字）：与 page.ts 的 `.board-*` CSS 同一份。 */
  boardTitleFontPx: BOARD_TITLE_FONT_PX,
  boardTitleLineHeightPx: BOARD_TITLE_LINE_HEIGHT_PX,
  boardSubFontPx: BOARD_SUB_FONT_PX,
  boardSubLineHeightPx: BOARD_SUB_LINE_HEIGHT_PX,
  boardRowPaddingPx: BOARD_ROW_PADDING_PX,
  boardRowMinHeightPx: BOARD_ROW_MIN_HEIGHT_PX,
  boardRowGapPx: BOARD_ROW_GAP_PX,
  boardCapsuleFontPx: BOARD_CAPSULE_FONT_PX,
  boardCapsuleHPaddingPx: BOARD_CAPSULE_H_PADDING_PX,
  boardCapsuleBorderPx: BOARD_CAPSULE_BORDER_PX,
  boardCapsuleLetterSpacingPx: BOARD_CAPSULE_LETTER_SPACING_PX,
  boardMicroBarPx: BOARD_MICRO_BAR_PX,
  boardMicroGapPx: BOARD_MICRO_GAP_PX,
  boardMicroMarginPx: BOARD_MICRO_MARGIN_PX,
  boardMicroMaxBars: BOARD_MICRO_MAX_BARS,
  boardMaxTitleLines: BOARD_MAX_TITLE_LINES,
} as const

/**
 * 完成页大标题字号（2026-11-10 用户要求：参考图那一行太大，减 2 号）。
 * 20px 仍单行：`doneFrame` 按 20px×加粗系数裁到 304px，CSS 再兜一层省略号，绝不换行。
 */
export const DONE_TITLE_FONT_PX = 20
/** 完成页大标题行高（字号 20 → 行高 22，与块高一致，上下不飘）。 */
export const DONE_TITLE_LINE_HEIGHT_PX = 22
/** 大标题块高＝行高（22）：块高小于行高就会把字形裁掉半截。 */
const DONE_TITLE_HEIGHT_PX = DONE_TITLE_LINE_HEIGHT_PX

/**
 * 完成屏垂直预算（320×240，四边 8px）——**按钮贴底、正文贴顶**（2026-11-10 用户实机要求第二版）：
 *
 *   内容高 222 = 240 − 2×1 边框 − 2×8 内边距
 *   顶栏 14 + 内缝 2 + 大标题 22 + 内缝 2 + 正文区 145
 *   + #screen 列间隙 4 + 三键 30 + 底边 margin 3 = 222
 *
 * 正文区不再是固定的 7×20：它吃掉标题与按钮之间的**全部剩余高度**（145），
 * 行数的算法也从这里走：`visibleLines = 正文区高 ÷ 行高`（145 ÷ 20 = 7）。
 * 这 7 行是 **320×240 这块屏的预算下限、不是上限**：屏幕被放大/拉长（手机把显示屏撑满可用区）时，
 * 页面按正文区**真实可视高度**再算一次行数，尽量多塞行，剩下的行靠手指往上滑连续看（2026-11-15）。
 * 三键固定贴在屏幕底部，键底边离屏幕**外沿** 12px（3px margin + 8px 内边距 + 1px 边框）；
 * 行少时空出来的黑底留在正文与按钮之间，而不是按钮下面。
 */
const DONE_STAGE_HEIGHT_PX = 14
const DONE_COLUMN_GAP_PX = 2
const DONE_SCREEN_GAP_PX = 4
const DONE_ACTION_BAR_HEIGHT_PX = 30
const DONE_ACTION_MARGIN_BOTTOM_PX = 3
const DONE_LINE_HEIGHT_PX = 20
/** 正文字号（与 `task-screens.ts` 折行用的 DONE_BODY_FONT_PX 同一份）。 */
const DONE_BODY_FONT_PX = 15
/** 每行正文左右各留的内边距（`.done-line` 的 padding:0 8px）；正文净宽 = 304 − 2×8。 */
const DONE_LINE_TEXT_PADDING_PX = 8
/** 内容高（与下面 `SCREEN_BORDER_PX` 同一份：1px 边框四边各吃掉 1px）。 */
const DONE_CONTENT_HEIGHT_PX = SCREEN_SPEC.heightPx - SCREEN_SPEC.paddingPx * 2 - 2
/** 正文区高度 = 内容高 −（顶栏 + 缝 + 标题 + 缝 + 列间隙 + 三键 + 底边 margin）。 */
const DONE_BODY_HEIGHT_PX = DONE_CONTENT_HEIGHT_PX
  - DONE_STAGE_HEIGHT_PX - DONE_COLUMN_GAP_PX * 2 - DONE_TITLE_HEIGHT_PX
  - DONE_SCREEN_GAP_PX - DONE_ACTION_BAR_HEIGHT_PX - DONE_ACTION_MARGIN_BOTTOM_PX
/** 这块屏的正文预算行数：145 ÷ 20 = 7（下限，真实高度能塞更多就更多）。 */
const DONE_VISIBLE_LINES = Math.floor(DONE_BODY_HEIGHT_PX / DONE_LINE_HEIGHT_PX)

export const DONE_LAYOUT = {
  stageHeightPx: DONE_STAGE_HEIGHT_PX,
  titleHeightPx: DONE_TITLE_HEIGHT_PX,
  titleFontPx: DONE_TITLE_FONT_PX,
  titleLineHeightPx: DONE_TITLE_LINE_HEIGHT_PX,
  /** 字号 15px、行高 20px，正文区 145px ÷ 20px = 7 整行（下限；页面按真实剩余高度还会往多里算）。 */
  visibleLines: DONE_VISIBLE_LINES,
  lineHeightPx: DONE_LINE_HEIGHT_PX,
  /** 正文字号（`.done-line` 的 font-size；宿主折行也用这个数）。 */
  bodyFontPx: DONE_BODY_FONT_PX,
  /** 每行正文左右各留的内边距（`.done-line` 的 padding:0 8px）。 */
  textPaddingPx: DONE_LINE_TEXT_PADDING_PX,
  /** 正文区（标题下沿 → 动作条上沿）的剩余高度。 */
  bodyHeightPx: DONE_BODY_HEIGHT_PX,
  actionBarHeightPx: DONE_ACTION_BAR_HEIGHT_PX,
  /** done-view 内部（顶栏↔标题、标题↔正文）的缝。 */
  columnGapPx: DONE_COLUMN_GAP_PX,
  /** #screen 本身的列间隙（正文区↔动作条）。 */
  screenGapPx: DONE_SCREEN_GAP_PX,
  /** 动作条底边到屏幕外沿的留白（用户要求 12px）。 */
  bottomInsetPx: 12,
  /** 动作条 margin-bottom = 12 − 8 内边距 − 1 边框。 */
  actionBarMarginBottomPx: DONE_ACTION_MARGIN_BOTTOM_PX,
  /** 14 + 2 + 22 + 2 + 145 + 4 + 30 + 3 = 222。 */
  usedHeightPx: DONE_STAGE_HEIGHT_PX + DONE_COLUMN_GAP_PX * 2 + DONE_TITLE_HEIGHT_PX
    + DONE_BODY_HEIGHT_PX + DONE_SCREEN_GAP_PX + DONE_ACTION_BAR_HEIGHT_PX + DONE_ACTION_MARGIN_BOTTOM_PX,
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

/* ───────────── 棋盘标题折行与卡高（2026-11-15）─────────────
 * 首页棋盘每行的标题高度按**实际折出来的行数**给足：宿主把标题按屏上那一行的真实可用宽
 * 折成几段，页面就渲染几段、并把卡片撑到那么高（一屏因此少显示几行）。
 * 用户硬要求：不许出现「半截断尾」的标题；确实折到上限还放不下时，只在最后一行末尾补省略号，
 * 完整标题仍留在这张卡的可获取处（卡片 `title` / `aria-label`），页面侧不靠 CSS 二次裁字。
 */

/** 状态胶囊实际占的宽度：文字宽 + 每字一份字距 + 左右内边距 + 四边边框。 */
export function boardCapsuleWidthPx(capsule: string): number {
  const chars = [...String(capsule ?? '')]
  return measureTextPx(chars.join(''), BOARD_CAPSULE_FONT_PX)
    + chars.length * BOARD_CAPSULE_LETTER_SPACING_PX
    + (BOARD_CAPSULE_H_PADDING_PX + BOARD_CAPSULE_BORDER_PX) * 2
}

/** 微条占的宽度：n 根 2px 条 + (n−1) 个 2px 间隙 + 离标题 2px。 */
export function boardMicroWidthPx(bars: number): number {
  const count = Math.max(0, Math.min(BOARD_MICRO_MAX_BARS, Math.trunc(Number(bars) || 0)))
  if (count === 0) return 0
  return count * BOARD_MICRO_BAR_PX + (count - 1) * BOARD_MICRO_GAP_PX + BOARD_MICRO_MARGIN_PX
}

/**
 * 标题那一行的可用宽：行宽 − 胶囊 − 那一行的 flex 间隙 − 微条（右侧那枚状态图形在副行，不吃这行的宽）。
 * `.board-row1` 是 flex，间隙在胶囊↔标题、标题↔微条之间各有一份；没有微条就只有一份间隙。
 * `wrapTextPx` 里还另扣一份 `TEXT_WRAP_SAFETY_PX` 安全边距，所以折出来的行一定不会被浏览器再裁。
 */
export function boardTitleWidthPx(capsule: string, microBars: number = 0): number {
  const bars = Math.max(0, Math.min(BOARD_MICRO_MAX_BARS, Math.trunc(Number(microBars) || 0)))
  const gaps = BOARD_ROW_GAP_PX * (bars > 0 ? 2 : 1)
  return Math.max(1, CONTENT_WIDTH_PX - boardCapsuleWidthPx(capsule) - gaps - boardMicroWidthPx(bars))
}

/** 一行卡片的高度：上下内边距 + 标题行数 × 行高 + 副行（不少于 `BOARD_ROW_MIN_HEIGHT_PX`）。 */
export function boardRowHeightForLines(titleLines: number): number {
  const lines = Math.max(1, Math.min(BOARD_MAX_TITLE_LINES, Math.trunc(Number(titleLines) || 1)))
  return Math.max(BOARD_ROW_MIN_HEIGHT_PX,
    BOARD_ROW_PADDING_PX * 2 + lines * BOARD_TITLE_LINE_HEIGHT_PX + BOARD_SUB_LINE_HEIGHT_PX)
}

/** 折好的标题：段数（屏上就是这么多行）、是否截断过、该卡该多高。 */
export interface BoardTitleWrap {
  /** 屏上要渲染的行（页面逐行渲染，不再二次折行）。 */
  lines: string[]
  /** true = 内容比这几行更多，最后一行带省略号；完整标题要留在卡片的 title/aria-label。 */
  truncated: boolean
  /** 这一行卡片该占的高度。 */
  rowHeightPx: number
}

/**
 * 按像素宽度把棋盘标题折成屏上那几行（15px × 加粗系数、宽度按同一行里的胶囊/微条算净）。
 * 最多 `BOARD_MAX_TITLE_LINES` 行：超出就在最后一行末尾补省略号（绝不切半个字）。
 */
export function boardTitleLinesOf(title: unknown, options: { capsule: string; microBars?: number }): BoardTitleWrap {
  const fontPx = BOARD_TITLE_FONT_PX * TITLE_BOLD_FACTOR
  const width = boardTitleWidthPx(options.capsule, options.microBars ?? 0)
  const all = wrapTextPx(title, width, fontPx)
  if (all.length === 0) {
    return { lines: [], truncated: false, rowHeightPx: boardRowHeightForLines(1) }
  }
  if (all.length <= BOARD_MAX_TITLE_LINES) {
    return { lines: all, truncated: false, rowHeightPx: boardRowHeightForLines(all.length) }
  }
  const head = all.slice(0, BOARD_MAX_TITLE_LINES - 1)
  const tail = fitLine(all.slice(BOARD_MAX_TITLE_LINES - 1).join(''), width, fontPx)
  const lines = [...head, tail]
  return { lines, truncated: true, rowHeightPx: boardRowHeightForLines(lines.length) }
}

/** 最坏情况的标题可用宽（胶囊最宽 + 微条满格都算上）：页面没有宿主折好的行时兜底折行用。 */
export const BOARD_TITLE_WIDTH_MIN_PX = boardTitleWidthPx('排队中', BOARD_MICRO_MAX_BARS)

/** 注入给页面脚本的棋盘版式（页面只消费这里，不另写数值）。 */
export const BOARD_LAYOUT = {
  titleFontPx: BOARD_TITLE_FONT_PX,
  /** 标题加粗宽度系数：与 `clipScreenTitle` 用同一份（宿主折行、页面兜底都按它算）。 */
  titleBoldFactor: TITLE_BOLD_FACTOR,
  titleLineHeightPx: BOARD_TITLE_LINE_HEIGHT_PX,
  subFontPx: BOARD_SUB_FONT_PX,
  subLineHeightPx: BOARD_SUB_LINE_HEIGHT_PX,
  rowPaddingPx: BOARD_ROW_PADDING_PX,
  rowMinHeightPx: BOARD_ROW_MIN_HEIGHT_PX,
  rowGapPx: BOARD_ROW_GAP_PX,
  capsuleFontPx: BOARD_CAPSULE_FONT_PX,
  /** 最宽那枚胶囊（3 个汉字）占的宽度。 */
  capsuleWidthMaxPx: boardCapsuleWidthPx('排队中'),
  microBarPx: BOARD_MICRO_BAR_PX,
  microGapPx: BOARD_MICRO_GAP_PX,
  microMaxBars: BOARD_MICRO_MAX_BARS,
  /** 微条满格占的宽度。 */
  microWidthMaxPx: boardMicroWidthPx(BOARD_MICRO_MAX_BARS),
  /** 折行时扣掉的安全边距（`wrapTextPx` 内部也扣它）。 */
  textSafetyPx: TEXT_WRAP_SAFETY_PX,
  maxTitleLines: BOARD_MAX_TITLE_LINES,
  titleWidthMinPx: BOARD_TITLE_WIDTH_MIN_PX,
} as const
