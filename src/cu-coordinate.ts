/**
 * Computer Use 坐标解析与记录（纯逻辑，不 import 宿主模块）。
 *
 * 背景（2026-11-28 实测）：同一会话连续 3 次点「Publish release」都落在按钮左边框外，
 * 原因不是映射错，而是**分数靠目测估**。这条模块把「目标元素 bbox → 0–1000 分数 →
 * 预测物理落点」的换算写成可执行代码，并产出可被 pre-execute 校验的解析记录。
 *
 * 映射口径（与 vendor/computer-use 的 mapNormalizedToGlobal 一致，vendor 零改动）：
 *   物理 x = bounds.x + (分数 x / 1000) × bounds.width，落点取 Math.round
 *   像素模式：分数 x = 截图像素 x / 截图宽 × 1000，再走同一公式
 *
 * 坐标空间（2026-11-28 运行期实测的第二处缺陷）：
 *   截图是**窗口内坐标**（原点 0,0），工具回执的 `Pointer landed at [x, y]` 是**屏幕绝对坐标**。
 *   所以 `bounds`（观察面在屏幕上的矩形）不是可选项：缺了它，预测落点会少加窗口原点，
 *   任何不在屏幕左上角的窗口都会得到永久 miss。`bounds` 的原点来源记在记录里
 *   （`boundsSource: explicit | auto | inferred`），`inferred` 表示按 0,0 推断、门必须拒绝。
 *
 * 这个文件里没有本机账户、私有档案根、个人姓名等任何字面量；记录目录默认在系统临时目录。
 */

// @ts-ignore -- 仓库没有 @types/node（见 scripts/typecheck.mjs 的已知缺口）
import { randomBytes } from 'node:crypto'
// @ts-ignore
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
// @ts-ignore
import { tmpdir } from 'node:os'
// @ts-ignore
import { join } from 'node:path'

declare const process: any

/** 记录格式版本：字段变了就加 1，旧记录会被判为 invalid。 */
export const COORDINATE_RECORD_VERSION = 1
/** 一条解析记录最多用 10 分钟；窗口搬动/页面刷新后旧 bbox 不再可信。 */
export const COORDINATE_RECORD_TTL_MS = 10 * 60 * 1000
/** 默认记录目录名（系统临时目录下；不含任何私人路径）。 */
export const COORDINATE_RECORD_DIR_NAME = 'dsh-cu-coordinate-records'
/** 分数空间固定 0–1000（与工具 schema 一致）。 */
export const COORDINATE_SPACE = 1000
/** 需要坐标记录的点击类工具。 */
export const CLICK_TOOLS = ['click', 'drag', 'input_text', 'long_press'] as const

export type CuCoordinateMode = 'millifraction' | 'pixel'

export interface CuImageSize {
  width: number
  height: number
}

/** 观察面物理矩形（窗口 rect；截图未缩放时与截图同尺寸）。 */
export interface CuRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 观察面原点的来源：
 *   explicit = 命令行给了 `--bounds x,y,w,h`；
 *   auto     = 现场量前台窗口（`--bounds auto`）；
 *   inferred = 没给，按 0,0 推断 —— 这种记录不能用，pre-execute 必须拒绝。
 */
export type CuBoundsSource = 'explicit' | 'auto' | 'inferred'

/** 目标元素在截图上的起止像素（含边界）。 */
export interface CuBbox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface CuPoint {
  x: number
  y: number
}

export interface CuPositionCheck {
  /** 传入的坐标是否落在 bbox 内。 */
  hit: boolean
  /** 换算后的物理落点（未取整）。 */
  physical: CuPoint
  /** 换算后的物理落点（Math.round，与工具回执同口径）。 */
  landed: CuPoint
  /** 越界时到 bbox 最近边的欧氏距离（像素）；命中为 0。 */
  deviationPx: number
  /** 修正建议：目标中心对应的分数与像素。 */
  suggestion: {
    fractions: CuPoint
    pixels: CuPoint
  }
  /** 人读的判定说明。 */
  reason: string
}

export interface CuResolveOptions {
  /** 截图实际像素尺寸。 */
  screenshot: CuImageSize
  /** 目标元素在图上的起止像素。 */
  bbox: CuBbox
  /** 观察面物理矩形；省略时按 0,0,截图宽,截图高 推断（记录会标 inferred，门拒绝）。 */
  bounds?: CuRect
  /** bounds 原点来源；给了 bounds 时缺省 explicit，没给 bounds 一律记 inferred。 */
  boundsSource?: CuBoundsSource
  /** auto 模式的推算说明（可选；只进记录与输出）。 */
  boundsNotes?: string[]
  /** 会话坐标口径；省略 = millifraction（harness 缺省）。 */
  mode?: CuCoordinateMode
  /** 可选：要校验的坐标（按 mode 解释）。 */
  position?: number[]
  /** 可选：目标标签（只进记录文件，不进日志）。 */
  target?: string
  /** 可选：工具名（click / drag / input_text / long_press）。 */
  tool?: string
  /** 可选：会话 id（只进记录文件，用于防跨会话复用）。 */
  sessionId?: string
  /** 可选：屏幕索引。 */
  screenIndex?: number
  /** 可选：固定记录 id（测试用）；缺省随机 8 位十六进制。 */
  id?: string
  /** 可选：当前时间（测试用）。 */
  now?: number
}

export interface CuCoordinateRecord {
  v: number
  id: string
  createdAt: string
  createdAtMs: number
  sessionId: string
  tool: string
  screenIndex: number
  target: string
  screenshot: CuImageSize
  bounds: CuRect
  /** bounds 原点怎么来的；inferred 表示按 0,0 推断，门不许用。 */
  boundsSource: CuBoundsSource
  /** 本次用的观察面原点（= bounds 左上角；单独落一份，日志与排障都读它）。 */
  origin: CuPoint
  /** auto 模式的推算说明（人读；explicit/inferred 为空数组）。 */
  boundsNotes: string[]
  mode: CuCoordinateMode
  bbox: CuBbox
  center: CuPoint
  fractions: CuPoint
  formulas: {
    x: string
    y: string
    predictedX: string
    predictedY: string
  }
  suggestedFractions: CuPoint
  suggestedPixels: CuPoint
  predicted: CuPoint
  predictedRounded: CuPoint
  check: CuPositionCheck | null
}

export interface CuRecordValidation {
  ok: boolean
  code: string
  message: string
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function requireImageSize(value: unknown): CuImageSize {
  const image = value as CuImageSize | undefined
  if (!image || !isFiniteNumber(image.width) || !isFiniteNumber(image.height)
    || image.width <= 0 || image.height <= 0) {
    throw new TypeError('screenshot must be { width, height } with positive finite numbers')
  }
  return { width: image.width, height: image.height }
}

function requireRect(value: unknown, image: CuImageSize): CuRect {
  if (value === undefined) return { x: 0, y: 0, width: image.width, height: image.height }
  const rect = value as CuRect
  if (!rect || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y)
    || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)
    || rect.width <= 0 || rect.height <= 0) {
    throw new TypeError('bounds must be { x, y, width, height } with positive finite width/height')
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function requireBbox(value: unknown, image: CuImageSize): CuBbox {
  const raw = value as CuBbox | undefined
  if (!raw || !isFiniteNumber(raw.x1) || !isFiniteNumber(raw.y1)
    || !isFiniteNumber(raw.x2) || !isFiniteNumber(raw.y2)) {
    throw new TypeError('bbox must be { x1, y1, x2, y2 } with finite numbers')
  }
  let x1 = Math.min(raw.x1, raw.x2)
  let y1 = Math.min(raw.y1, raw.y2)
  let x2 = Math.max(raw.x1, raw.x2)
  let y2 = Math.max(raw.y1, raw.y2)
  // 截图边缘外的 bbox 裁回图内；完全在图外则报错（别把无意义的框算成目标）。
  x1 = Math.max(0, Math.min(image.width, x1))
  y1 = Math.max(0, Math.min(image.height, y1))
  x2 = Math.max(0, Math.min(image.width, x2))
  y2 = Math.max(0, Math.min(image.height, y2))
  if (x2 <= x1 || y2 <= y1) {
    throw new TypeError('bbox must have positive width and height after clipping to the screenshot')
  }
  return { x1, y1, x2, y2 }
}

/** 截图像素 → 分数（0–1000）。 */
export function fractionFromPixel(pixel: number, extent: number): number {
  return (pixel / extent) * COORDINATE_SPACE
}

/** 分数（0–1000）→ 物理像素（未取整，与 mapNormalizedToGlobal 同口径）。 */
export function pixelFromFraction(fraction: number, start: number, extent: number): number {
  return start + (fraction / COORDINATE_SPACE) * extent
}

/** 截图像素 → 观察面物理像素（pixel 模式的 harness 映射）。 */
export function screenshotPixelToPhysical(point: CuPoint, screenshot: CuImageSize, bounds: CuRect): CuPoint {
  return {
    x: bounds.x + (point.x / screenshot.width) * bounds.width,
    y: bounds.y + (point.y / screenshot.height) * bounds.height,
  }
}

export function bboxCenter(bbox: CuBbox): CuPoint {
  return { x: (bbox.x1 + bbox.x2) / 2, y: (bbox.y1 + bbox.y2) / 2 }
}

export function bboxWidth(bbox: CuBbox): number {
  return bbox.x2 - bbox.x1
}

export function bboxHeight(bbox: CuBbox): number {
  return bbox.y2 - bbox.y1
}

/** 点是否落在 bbox 内（含边界）。 */
export function bboxContains(bbox: CuBbox, x: number, y: number): boolean {
  return x >= bbox.x1 && x <= bbox.x2 && y >= bbox.y1 && y <= bbox.y2
}

/** 点到 bbox 的欧氏距离；命中为 0。 */
export function distanceToBbox(bbox: CuBbox, x: number, y: number): number {
  const dx = x < bbox.x1 ? bbox.x1 - x : x > bbox.x2 ? x - bbox.x2 : 0
  const dy = y < bbox.y1 ? bbox.y1 - y : y > bbox.y2 ? y - bbox.y2 : 0
  return Math.hypot(dx, dy)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function formatNumber(value: number): string {
  return String(round4(value))
}

/** 把坐标按 mode 换算成物理像素并判定是否命中。 */
export function checkPosition(
  position: number[],
  mode: CuCoordinateMode,
  screenshot: CuImageSize,
  bounds: CuRect,
  bbox: CuBbox,
): CuPositionCheck {
  if (!Array.isArray(position) || position.length !== 2
    || !isFiniteNumber(position[0]) || !isFiniteNumber(position[1])) {
    throw new TypeError('position must be [x, y] with two finite numbers')
  }
  const [rawX, rawY] = position
  const physical = mode === 'millifraction'
    ? { x: pixelFromFraction(rawX, bounds.x, bounds.width), y: pixelFromFraction(rawY, bounds.y, bounds.height) }
    : screenshotPixelToPhysical({ x: rawX, y: rawY }, screenshot, bounds)
  // bbox 是截图像素；物理 bbox 用同一条映射换算后再比，截图被缩放时也成立。
  const physicalBbox: CuBbox = {
    x1: screenshotPixelToPhysical({ x: bbox.x1, y: bbox.y1 }, screenshot, bounds).x,
    y1: screenshotPixelToPhysical({ x: bbox.x1, y: bbox.y1 }, screenshot, bounds).y,
    x2: screenshotPixelToPhysical({ x: bbox.x2, y: bbox.y2 }, screenshot, bounds).x,
    y2: screenshotPixelToPhysical({ x: bbox.x2, y: bbox.y2 }, screenshot, bounds).y,
  }
  const hit = bboxContains(physicalBbox, physical.x, physical.y)
  const landed = { x: Math.round(physical.x), y: Math.round(physical.y) }
  const center = bboxCenter(bbox)
  const suggestionFractions = {
    x: fractionFromPixel(center.x, screenshot.width),
    y: fractionFromPixel(center.y, screenshot.height),
  }
  const suggestionPixels = { x: Math.round(center.x), y: Math.round(center.y) }
  // 偏差按**工具回执的整数落点**算（与 Pointer landed at [x, y] 同口径），
  // 这样 280.32 不会被报成 65.68，而是回执里的 280 → 66 px。
  const deviationPx = hit ? 0 : distanceToBbox(physicalBbox, landed.x, landed.y)
  return {
    hit,
    physical,
    landed,
    deviationPx: round2(deviationPx),
    suggestion: { fractions: suggestionFractions, pixels: suggestionPixels },
    reason: hit ? 'inside-bbox' : 'outside-bbox',
  }
}

/**
 * 解析一份坐标：输出中心像素、bbox、分数算式、harness 预测落点与可选校验。
 * 纯函数；不读盘、不写盘。
 */
export function resolveCoordinates(options: CuResolveOptions): CuCoordinateRecord {
  const screenshot = requireImageSize(options?.screenshot)
  const bounds = requireRect(options?.bounds, screenshot)
  const boundsSource: CuBoundsSource = options?.bounds === undefined
    ? 'inferred'
    : options?.boundsSource === 'auto' ? 'auto' : 'explicit'
  const boundsNotes = Array.isArray(options?.boundsNotes)
    ? options.boundsNotes.map((note) => String(note))
    : []
  const bbox = requireBbox(options?.bbox, screenshot)
  const mode: CuCoordinateMode = options?.mode === 'pixel' ? 'pixel' : 'millifraction'
  const center = bboxCenter(bbox)
  const fractionX = fractionFromPixel(center.x, screenshot.width)
  const fractionY = fractionFromPixel(center.y, screenshot.height)
  const predictedX = pixelFromFraction(fractionX, bounds.x, bounds.width)
  const predictedY = pixelFromFraction(fractionY, bounds.y, bounds.height)
  const predictedRounded = { x: Math.round(predictedX), y: Math.round(predictedY) }
  const now = isFiniteNumber(options?.now) ? options.now : Date.now()
  const id = typeof options?.id === 'string' && /^[a-f0-9]{8,32}$/.test(options.id)
    ? options.id
    : randomBytes(4).toString('hex')
  const check = options?.position === undefined
    ? null
    : checkPosition(options.position, mode, screenshot, bounds, bbox)
  return {
    v: COORDINATE_RECORD_VERSION,
    id,
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    sessionId: String(options?.sessionId ?? ''),
    tool: String(options?.tool ?? 'click'),
    screenIndex: Number.isInteger(options?.screenIndex) ? Number(options?.screenIndex) : 0,
    target: String(options?.target ?? ''),
    screenshot,
    bounds,
    boundsSource,
    origin: { x: bounds.x, y: bounds.y },
    boundsNotes,
    mode,
    bbox,
    center,
    fractions: { x: fractionX, y: fractionY },
    formulas: {
      x: `${formatNumber(center.x)} / ${formatNumber(screenshot.width)} × 1000 = ${formatNumber(fractionX)}`,
      y: `${formatNumber(center.y)} / ${formatNumber(screenshot.height)} × 1000 = ${formatNumber(fractionY)}`,
      predictedX: `${formatNumber(bounds.x)} + (${formatNumber(fractionX)} / 1000) × ${formatNumber(bounds.width)} = ${formatNumber(predictedX)}`,
      predictedY: `${formatNumber(bounds.y)} + (${formatNumber(fractionY)} / 1000) × ${formatNumber(bounds.height)} = ${formatNumber(predictedY)}`,
    },
    suggestedFractions: { x: round2(fractionX), y: round2(fractionY) },
    suggestedPixels: { x: Math.round(center.x), y: Math.round(center.y) },
    predicted: { x: predictedX, y: predictedY },
    predictedRounded,
    check,
  }
}

/** 默认记录目录：系统临时目录，不含任何账户/档案路径。 */
export function defaultCoordinateRecordDir(): string {
  return join(tmpdir(), COORDINATE_RECORD_DIR_NAME)
}

/** 记录 id 只接受 8–32 位小写十六进制（防路径穿越）。 */
export function isCoordinateRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8,32}$/.test(value)
}

/** 把记录写成 `<stateDir>/<id>.json`；返回文件路径（失败直接抛，调用方决定是否吞）。 */
export function writeCoordinateRecord(record: CuCoordinateRecord, stateDir = defaultCoordinateRecordDir()): string {
  if (!record || !isCoordinateRecordId(record.id)) throw new TypeError('record.id must be 8-32 lowercase hex characters')
  const dir = String(stateDir ?? '').trim() || defaultCoordinateRecordDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${record.id}.json`)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return file
}

/** 读一条记录；不存在/坏 JSON/结构不对都返回 null（不抛）。 */
export function readCoordinateRecord(id: unknown, stateDir = defaultCoordinateRecordDir()): CuCoordinateRecord | null {
  if (!isCoordinateRecordId(id)) return null
  const dir = String(stateDir ?? '').trim() || defaultCoordinateRecordDir()
  const file = join(dir, `${id}.json`)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || parsed.v !== COORDINATE_RECORD_VERSION) return null
    if (!isCoordinateRecordId(parsed.id) || parsed.id !== id) return null
    if (!parsed.screenshot || !parsed.bounds || !parsed.bbox) return null
    if (parsed.mode !== 'millifraction' && parsed.mode !== 'pixel') return null
    return parsed as CuCoordinateRecord
  } catch {
    return null
  }
}

/** 记录本身是否还能用于这次调用（版本/会话/时效/模式）。 */
export function validateCoordinateRecord(
  record: CuCoordinateRecord | null | undefined,
  expected: { sessionId?: string; mode?: CuCoordinateMode; now?: number; ttlMs?: number } = {},
): CuRecordValidation {
  if (!record) {
    return { ok: false, code: 'missing-coordinate-record', message: '找不到这条坐标记录（文件不存在或内容坏了）' }
  }
  if (record.v !== COORDINATE_RECORD_VERSION) {
    return { ok: false, code: 'coordinate-record-invalid', message: `记录版本 ${String(record.v)} 不是 ${String(COORDINATE_RECORD_VERSION)}` }
  }
  const expectedSession = String(expected.sessionId ?? '')
  if (expectedSession !== '' && record.sessionId !== '' && record.sessionId !== expectedSession) {
    return { ok: false, code: 'coordinate-record-invalid', message: '记录属于另一个会话，不能跨会话复用' }
  }
  const expectedMode = expected.mode
  if (expectedMode !== undefined && record.mode !== expectedMode) {
    return {
      ok: false,
      code: 'coordinate-record-invalid',
      message: `记录是 ${record.mode} 坐标，本会话是 ${expectedMode}；重跑解析器加 --mode ${expectedMode}`,
    }
  }
  const now = isFiniteNumber(expected.now) ? expected.now : Date.now()
  const ttl = isFiniteNumber(expected.ttlMs) ? expected.ttlMs : COORDINATE_RECORD_TTL_MS
  if (now - record.createdAtMs > ttl) {
    return { ok: false, code: 'coordinate-record-stale', message: `记录已过期（超过 ${Math.round(ttl / 60000)} 分钟），目标位置可能已变` }
  }
  return { ok: true, code: 'ok', message: '' }
}

/** 拿这条记录校验一个实际坐标（按记录里的 mode 解释）。 */
export function validatePositionForRecord(
  record: CuCoordinateRecord,
  position: number[],
): CuPositionCheck {
  return checkPosition(position, record.mode, record.screenshot, record.bounds, record.bbox)
}

/* ---------------- 观察面原点：可信判定、auto 模式、回执侧对齐 ---------------- */

/** 记录里的 bounds 原点是否可信：显式给过（explicit）或现场量过（auto）才算。 */
export function boundsOriginKnown(record: CuCoordinateRecord | null | undefined): boolean {
  if (!record) return false
  return record.boundsSource === 'explicit' || record.boundsSource === 'auto'
}

/** pre-execute 用：原点不可信的记录直接拒绝（码固定 coordinate-bounds-unknown）。 */
export function validateCoordinateBounds(record: CuCoordinateRecord | null | undefined): CuRecordValidation {
  if (!record) {
    return { ok: false, code: 'coordinate-bounds-unknown', message: '没有记录，拿不到观察面原点' }
  }
  if (boundsOriginKnown(record)) return { ok: true, code: 'ok', message: '' }
  const { bounds } = record
  const rect = `${formatNumber(bounds.x)},${formatNumber(bounds.y)},${formatNumber(bounds.width)},${formatNumber(bounds.height)}`
  return {
    ok: false,
    code: 'coordinate-bounds-unknown',
    message: `记录里的观察面矩形 ${rect} 是按 0,0 推断的（没标 explicit/auto）；截图是窗口内坐标、落点是屏幕绝对坐标`,
  }
}

/** koffi 侧量到的窗口事实（命令行填；测试注入桩）。 */
export interface CuWindowProbe {
  /** 窗口矩形；可能是 DPI 虚拟化坐标。 */
  rect: CuRect
  /** 窗口 DPI（96 = 100%）。 */
  dpi?: number
  /** 物理像素 / 矩形像素；缺省 1。 */
  coordScale?: number
  /** 矩形来源：dwm-extended-frame | window-rect。 */
  frameSource?: string
}

/** auto 模式的产出：观察面矩形 + 推算说明。 */
export interface CuAutoBounds {
  bounds: CuRect
  origin: CuPoint
  boundsSource: 'auto'
  /** 物理像素 / 截图像素；截图被缩放时 > 1。 */
  captureScale: number
  /** 推算说明（人读，进输出与记录）。 */
  boundsNotes: string[]
  frameSource: string
}

/** 窗口矩形最多能比截图大多少（不可见边框预算，物理像素；Win10/11 单边 7 起）。 */
const AUTO_BORDER_BUDGET_PX = 32
/** 宽高比容差：截图与窗口矩形的比例差超过这个值就不当成同一个面。 */
const AUTO_ASPECT_TOLERANCE = 0.03

function rectText(rect: CuRect): string {
  return `${formatNumber(rect.x)},${formatNumber(rect.y)},${formatNumber(rect.width)},${formatNumber(rect.height)}`
}

function roundRect(rect: CuRect): CuRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/**
 * 把现场量到的窗口矩形换算成「截图对应的观察面矩形」。
 *
 * 能对上的三种情形（tol 像素容差，默认 2）：
 *   1. exact：窗口矩形与截图同尺寸（DPI 100% 且未被缩放）；
 *   2. inset：窗口矩形比截图大一点点（不超过 32 px 的边框预算，例如 GetWindowRect 含不可见边框）——
 *      按截图宽高比推算可见区原点：左右各让一半余量，竖直余量全放底部
 *      （标题栏在窗口矩形顶部，可见区从 top 开始）；
 *   3. scaled：窗口矩形是截图的等比放大（抓屏长边上限把截图缩小了），比例 ≈ 物理/截图。
 * 先判 inset 再判 scaled：边框预算只有 32 px，而真实抓屏缩放不会只缩 0.5%（判反了最多差几像素）。
 * 三种都不是 → 抛 `auto-bounds-mismatch`，让调用方用 --bounds x,y,w,h 显式给矩形；
 * 绝不静默退回 0,0。
 */
export function boundsFromWindowProbe(
  screenshot: CuImageSize,
  probe: CuWindowProbe | null | undefined,
  tolerancePx = 2,
): CuAutoBounds {
  const shot = requireImageSize(screenshot)
  const raw = probe?.rect
  if (!raw || !isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)
    || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)
    || raw.width <= 0 || raw.height <= 0) {
    throw new TypeError('auto-bounds-unavailable: 前台窗口矩形无效（取不到窗口或窗口已最小化），请用 --bounds x,y,w,h 显式给')
  }
  const coordScale = isFiniteNumber(probe?.coordScale) && probe.coordScale > 0 ? probe.coordScale : 1
  const frameSource = String(probe?.frameSource ?? 'window-rect')
  const notes: string[] = []
  if (coordScale !== 1) {
    notes.push(`DPI 缩放 ${formatNumber(coordScale)}：窗口矩形 ${rectText(raw)} 按比例换成物理像素`)
  }
  const physical = roundRect({
    x: raw.x * coordScale,
    y: raw.y * coordScale,
    width: raw.width * coordScale,
    height: raw.height * coordScale,
  })
  const tol = Number.isFinite(tolerancePx) && tolerancePx > 0 ? tolerancePx : 2
  const deltaWidth = physical.width - shot.width
  const deltaHeight = physical.height - shot.height

  if (Math.abs(deltaWidth) <= tol && Math.abs(deltaHeight) <= tol) {
    notes.push(`窗口矩形 ${physical.width}x${physical.height} 与截图 ${shot.width}x${shot.height} 同尺寸，原点直接取窗口左上角`)
    return { bounds: physical, origin: { x: physical.x, y: physical.y }, boundsSource: 'auto', captureScale: 1, boundsNotes: notes, frameSource }
  }

  if (deltaWidth >= 0 && deltaHeight >= 0
    && deltaWidth <= AUTO_BORDER_BUDGET_PX && deltaHeight <= AUTO_BORDER_BUDGET_PX) {
    const left = Math.round(deltaWidth / 2)
    const origin = { x: physical.x + left, y: physical.y }
    const bounds: CuRect = { x: origin.x, y: origin.y, width: shot.width, height: shot.height }
    notes.push(`窗口矩形比截图大 ${deltaWidth}x${deltaHeight}（不可见边框）：可见区原点按"左右各半、竖直余量全在底部"推算为 ${origin.x},${origin.y}；截图按 1:1 对待`)
    return { bounds, origin, boundsSource: 'auto', captureScale: 1, boundsNotes: notes, frameSource }
  }

  const scaleX = physical.width / shot.width
  const scaleY = physical.height / shot.height
  const uniform = Math.abs(scaleX - scaleY) <= Math.max(AUTO_ASPECT_TOLERANCE, AUTO_ASPECT_TOLERANCE * Math.max(scaleX, scaleY))
  if (scaleX >= 1 - 1e-6 && scaleY >= 1 - 1e-6 && uniform) {
    const captureScale = round4((scaleX + scaleY) / 2)
    notes.push(`截图被缩放 ${formatNumber(captureScale)} 倍：物理 ${physical.width}x${physical.height} ÷ 截图 ${shot.width}x${shot.height}`)
    return { bounds: physical, origin: { x: physical.x, y: physical.y }, boundsSource: 'auto', captureScale, boundsNotes: notes, frameSource }
  }

  throw new TypeError(
    `auto-bounds-mismatch: 窗口矩形 ${physical.width}x${physical.height} 与截图 ${shot.width}x${shot.height} 对不上`
    + `（差 ${deltaWidth}x${deltaHeight}，既超出 ${String(AUTO_BORDER_BUDGET_PX)} px 边框预算、也不是等比缩放）；请用 --bounds x,y,w,h 显式给观察面在屏幕上的矩形`,
  )
}

/** 从工具回执的 value 里读观察面矩形：observation.bounds/windowRect 优先，其次顶层与 screens[]。 */
export function observationRectFromValue(value: any, screenIndex = 0): CuRect | null {
  if (!value || typeof value !== 'object') return null
  const pick = (holder: any): CuRect | null => {
    const fromBounds = requireRectOrNull(holder?.bounds)
    if (fromBounds) return fromBounds
    return requireRectOrNull(holder?.windowRect)
  }
  const screens = Array.isArray(value.screens) ? value.screens : []
  const screen = screens.find((item: any) => Number(item?.screenIndex) === screenIndex) ?? screens[0]
  return pick(value.observation) ?? pick(value) ?? pick(screen)
}

/** 从工具回执的 value 里读观察面尺寸（logicalWidth/logicalHeight）：没有完整矩形时用它核对窗口有没有变。 */
export function observationSizeFromValue(value: any, screenIndex = 0): CuImageSize | null {
  if (!value || typeof value !== 'object') return null
  const screens = Array.isArray(value.screens) ? value.screens : []
  const screen = screens.find((item: any) => Number(item?.screenIndex) === screenIndex) ?? screens[0]
  const width = screen?.logicalWidth
  const height = screen?.logicalHeight
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

function requireRectOrNull(value: any): CuRect | null {
  if (!value || typeof value !== 'object') return null
  const { x, y, width, height } = value
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/** 回执侧的观察面：完整矩形可缺省，尺寸可缺省。 */
export interface CuObservationSurface {
  rect?: CuRect | null
  size?: CuImageSize | null
}

/** 回执落点的判定结果：真 miss 与「坐标空间对不上」必须分开。 */
export interface CuLandedCheck {
  hit: boolean
  /** 坐标空间不一致（不是「点歪了」）：不计 miss streak、不触发硬停。 */
  spaceMismatch: boolean
  /** 换回截图坐标后的落点。 */
  shot: CuPoint
  /** 回执原样落点（取整）。 */
  landed: CuPoint
  /** 物理像素偏差（截图被缩放时按比例折算）。 */
  deviationPx: number
  /** 本次用的原点矩形。 */
  originRect: CuRect
  /** 原点来源：observation = 本条回执里的观察面；record = 记录里的 bounds。 */
  originSource: 'observation' | 'record'
  /** 判定说明：inside-bbox / outside-bbox / outside-surface / surface-resized / origin-unknown。 */
  reason: string
}

/**
 * post-execute 用：把**屏幕绝对**落点换回**截图坐标**，再比 bbox。
 *
 * 原点优先取本条回执里的观察面（截图对应的窗口在屏幕上的位置），拿不到才退回记录里的 bounds；
 * 记录原点又是推断的（inferred）→ 直接判 `origin-unknown`；
 * 换算后落在截图外（超宽/为负）→ `outside-surface`；观察面尺寸与记录差超过 2% → `surface-resized`。
 * 这三种都算「坐标空间不一致」，不是真 miss。
 */
export function checkLandedAgainstRecord(
  record: CuCoordinateRecord,
  landed: CuPoint,
  observation: CuObservationSurface = {},
): CuLandedCheck {
  const shot = record.screenshot
  const observationRect = requireRectOrNull(observation?.rect)
  const originSource: 'observation' | 'record' = observationRect ? 'observation' : 'record'
  const originRect: CuRect = observationRect ?? record.bounds
  const landedRounded = { x: Math.round(landed.x), y: Math.round(landed.y) }
  const shotPoint = {
    x: ((landed.x - originRect.x) / originRect.width) * shot.width,
    y: ((landed.y - originRect.y) / originRect.height) * shot.height,
  }
  const note: Omit<CuLandedCheck, 'hit' | 'spaceMismatch' | 'deviationPx' | 'reason'> = {
    shot: shotPoint,
    landed: landedRounded,
    originRect,
    originSource,
  }
  if (originSource === 'record' && !boundsOriginKnown(record)) {
    return { ...note, hit: false, spaceMismatch: true, deviationPx: 0, reason: 'origin-unknown' }
  }
  const size = observation?.size
  if (originSource === 'observation' && size
    && (Math.abs(size.width - record.bounds.width) / record.bounds.width > 0.02
      || Math.abs(size.height - record.bounds.height) / record.bounds.height > 0.02)) {
    return { ...note, hit: false, spaceMismatch: true, deviationPx: 0, reason: 'surface-resized' }
  }
  const outside = !Number.isFinite(shotPoint.x) || !Number.isFinite(shotPoint.y)
    || shotPoint.x < 0 || shotPoint.x > shot.width
    || shotPoint.y < 0 || shotPoint.y > shot.height
  if (outside) {
    return { ...note, hit: false, spaceMismatch: true, deviationPx: 0, reason: 'outside-surface' }
  }
  const hit = bboxContains(record.bbox, shotPoint.x, shotPoint.y)
  const physicalPerShot = originRect.width / shot.width
  const deviationPx = hit ? 0 : round2(distanceToBbox(record.bbox, shotPoint.x, shotPoint.y) * physicalPerShot)
  return { ...note, hit, spaceMismatch: false, deviationPx, reason: hit ? 'inside-bbox' : 'outside-bbox' }
}

/** 用工具回执的**物理落点**校验命中（旧口径：直接比记录 bounds 下的物理 bbox；门已改用 {@link checkLandedAgainstRecord}）。 */
export function checkLandedPhysical(
  record: CuCoordinateRecord,
  landed: CuPoint,
): CuPositionCheck {
  const topLeft = screenshotPixelToPhysical({ x: record.bbox.x1, y: record.bbox.y1 }, record.screenshot, record.bounds)
  const bottomRight = screenshotPixelToPhysical({ x: record.bbox.x2, y: record.bbox.y2 }, record.screenshot, record.bounds)
  const physicalBbox: CuBbox = { x1: topLeft.x, y1: topLeft.y, x2: bottomRight.x, y2: bottomRight.y }
  const hit = bboxContains(physicalBbox, landed.x, landed.y)
  const center = bboxCenter(record.bbox)
  return {
    hit,
    physical: landed,
    landed: { x: Math.round(landed.x), y: Math.round(landed.y) },
    deviationPx: hit ? 0 : round2(distanceToBbox(physicalBbox, landed.x, landed.y)),
    suggestion: {
      fractions: {
        x: fractionFromPixel(center.x, record.screenshot.width),
        y: fractionFromPixel(center.y, record.screenshot.height),
      },
      pixels: { x: Math.round(center.x), y: Math.round(center.y) },
    },
    reason: hit ? 'inside-bbox' : 'outside-bbox',
  }
}
