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
  /** 观察面物理矩形；省略时按 0,0,截图宽,截图高（1:1）。 */
  bounds?: CuRect
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

/** 用工具回执的**物理落点**校验命中（post-execute 用；与记录里的 mode 无关）。 */
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
