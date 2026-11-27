/**
 * 编号框图像合成器（Set-of-Mark）：在**观察帧的 PNG 副本**上画编号框，原帧一个字节都不动。
 *
 * 为什么自己写编解码：插件侧不能引第三方原生依赖（宿主没给 sharp），而观察帧就是标准 PNG。
 * 只支持「8 位、非隔行、颜色类型 0/2/3/4/6」——这是截图工具产出的那一类；遇到不支持的形状
 * 一律抛 `OverlayUnsupportedError`，调用方按保底 ① 退回原帧（不画、不改、零开销）。
 *
 * 口径：编号图只是**给模型看的锚点**。坐标仍由模型自己看图给（`pickPoint` 永远优先模型坐标），
 * UIA 的 bounds 只用于画框和事后比对，绝不替模型决定点哪里。
 */
import zlib from 'node:zlib'

export type OverlayRect = { x: number; y: number; w: number; h: number }
export type OverlayMark = { no: number; rect: OverlayRect }
export type OverlayImage = { width: number; height: number; rgba: Buffer }

export class OverlayUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OverlayUnsupportedError'
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 解码 8 位非隔行 PNG（颜色类型 0 灰度 / 2 真彩 / 3 索引 / 4 灰度+α / 6 真彩+α）→ RGBA。
 * 不支持的一律抛错（调用方退回原帧）。
 */
export function decodePng(buffer: Buffer): OverlayImage {
  if (!isPng(buffer)) throw new OverlayUnsupportedError('not a png')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | null = null
  let alphaTable: Buffer | null = null
  const idat: Buffer[] = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const data = buffer.subarray(dataStart, Math.min(dataStart + length, buffer.length))
    offset = dataStart + length + 4 // 跳过 CRC
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      alphaTable = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
  }
  if (width <= 0 || height <= 0) throw new OverlayUnsupportedError('png has no size')
  if (bitDepth !== 8) throw new OverlayUnsupportedError('png bit depth ' + bitDepth + ' unsupported')
  if (interlace !== 0) throw new OverlayUnsupportedError('interlaced png unsupported')
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (channels === 0) throw new OverlayUnsupportedError('png color type ' + colorType + ' unsupported')
  if (colorType === 3 && palette === null) throw new OverlayUnsupportedError('indexed png without palette')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new OverlayUnsupportedError('png data truncated')
  const out = Buffer.alloc(width * height * 4)
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    raw.copy(current, 0, cursor, cursor + stride)
    cursor += stride
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? current[i - channels] : 0
      const up = previous[i]
      const upLeft = i >= channels ? previous[i - channels] : 0
      let value = current[i]
      if (filter === 1) value = (value + left) & 0xff
      else if (filter === 2) value = (value + up) & 0xff
      else if (filter === 3) value = (value + ((left + up) >> 1)) & 0xff
      else if (filter === 4) value = (value + paeth(left, up, upLeft)) & 0xff
      else if (filter !== 0) throw new OverlayUnsupportedError('png filter ' + filter + ' unsupported')
      current[i] = value
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels
      const dst = (y * width + x) * 4
      if (colorType === 6) {
        out[dst] = current[src]; out[dst + 1] = current[src + 1]; out[dst + 2] = current[src + 2]; out[dst + 3] = current[src + 3]
      } else if (colorType === 2) {
        out[dst] = current[src]; out[dst + 1] = current[src + 1]; out[dst + 2] = current[src + 2]; out[dst + 3] = 255
      } else if (colorType === 0) {
        out[dst] = current[src]; out[dst + 1] = current[src]; out[dst + 2] = current[src]; out[dst + 3] = 255
      } else if (colorType === 4) {
        out[dst] = current[src]; out[dst + 1] = current[src]; out[dst + 2] = current[src]; out[dst + 3] = current[src + 1]
      } else if (colorType === 3 && palette !== null) {
        const index = current[src]
        const p = index * 3
        out[dst] = palette[p] ?? 0; out[dst + 1] = palette[p + 1] ?? 0; out[dst + 2] = palette[p + 2] ?? 0
        out[dst + 3] = alphaTable !== null && index < alphaTable.length ? alphaTable[index] : 255
      }
    }
    current.copy(previous)
  }
  return { width, height, rgba: out }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** 编码 8 位 RGBA PNG（每行 filter 0，够快也够稳；截图尺寸下一帧几毫秒）。 */
export function encodePngRgba(image: OverlayImage): Buffer {
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0
    image.rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(image.width, 0)
  ihdr.writeUInt32BE(image.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 3×5 点阵数字（够 2 倍放大后仍清晰；编号只用到 0-9）。 */
const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
}

type Rgba = [number, number, number, number]

function setPixel(image: OverlayImage, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  const index = (y * image.width + x) * 4
  image.rgba[index] = color[0]
  image.rgba[index + 1] = color[1]
  image.rgba[index + 2] = color[2]
  image.rgba[index + 3] = color[3]
}

function fillRect(image: OverlayImage, x: number, y: number, w: number, h: number, color: Rgba): void {
  for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) setPixel(image, x + dx, y + dy, color)
}

function strokeRect(image: OverlayImage, x: number, y: number, w: number, h: number, color: Rgba, thickness = 2): void {
  for (let t = 0; t < thickness; t += 1) {
    fillRect(image, x + t, y + t, Math.max(0, w - t * 2), 1, color)
    fillRect(image, x + t, y + h - 1 - t, Math.max(0, w - t * 2), 1, color)
    fillRect(image, x + t, y + t, 1, Math.max(0, h - t * 2), color)
    fillRect(image, x + w - 1 - t, y + t, 1, Math.max(0, h - t * 2), color)
  }
}

function drawNumber(image: OverlayImage, text: string, x: number, y: number, scale: number): void {
  const chipW = (text.length * 4 - 1) * scale + 4
  const chipH = 5 * scale + 4
  fillRect(image, x, y, chipW, chipH, [18, 18, 22, 235])       // 数字底片（深色，任何背景上都看得清）
  strokeRect(image, x, y, chipW, chipH, [255, 43, 214, 255], 1)
  let cursor = x + 2
  for (const ch of text) {
    const glyph = DIGITS[ch]
    if (glyph === undefined) continue
    for (let gy = 0; gy < 5; gy += 1) {
      for (let gx = 0; gx < 3; gx += 1) {
        if (glyph[gy][gx] === '1') fillRect(image, cursor + gx * scale, y + 2 + gy * scale, scale, scale, [255, 255, 255, 255])
      }
    }
    cursor += 4 * scale
  }
}

export type OverlayDrawResult = { image: OverlayImage; drawn: number }

/**
 * 在图像上画编号框（框 + 编号底片）。坐标按 `scale` 从「窗口绝对坐标」换算到图像像素：
 * `local = (abs - windowOrigin) * scale`，与 vendor 的观察面 rect 同一基准。
 * 越界/过小的框直接跳过（画了也看不清），返回实际画了几个。
 */
export function drawMarks(
  image: OverlayImage,
  marks: readonly OverlayMark[],
  opts: { windowOrigin?: { x: number; y: number }; scale?: number; minEdgePx?: number; color?: Rgba } = {},
): OverlayDrawResult {
  const scale = Number(opts.scale ?? 1)
  const originX = Number(opts.windowOrigin?.x ?? 0)
  const originY = Number(opts.windowOrigin?.y ?? 0)
  const minEdge = Math.max(2, Number(opts.minEdgePx ?? 6))
  const border: Rgba = opts.color ?? [255, 43, 214, 255]
  let drawn = 0
  for (const mark of marks ?? []) {
    const rect = mark?.rect
    if (rect === null || rect === undefined) continue
    const x = Math.round((Number(rect.x) - originX) * scale)
    const y = Math.round((Number(rect.y) - originY) * scale)
    const w = Math.round(Number(rect.w) * scale)
    const h = Math.round(Number(rect.h) * scale)
    if (w < minEdge || h < minEdge) continue
    if (x >= image.width || y >= image.height || x + w <= 0 || y + h <= 0) continue
    const clippedX = Math.max(0, Math.min(image.width - 1, x))
    const clippedY = Math.max(0, Math.min(image.height - 1, y))
    const clippedW = Math.min(image.width - clippedX, Math.max(1, w - (clippedX - x)))
    const clippedH = Math.min(image.height - clippedY, Math.max(1, h - (clippedY - y)))
    strokeRect(image, clippedX, clippedY, clippedW, clippedH, border, 2)
    const labelY = clippedY + 2
    const labelX = clippedX + 2
    drawNumber(image, String(mark.no), labelX, labelY, 2)
    drawn += 1
  }
  return { image, drawn }
}

/** 一帧图 → 带编号的新 PNG（原 buffer 不动）。drawn=0 时调用方必须继续用原帧。 */
export function overlayPng(
  png: Buffer,
  marks: readonly OverlayMark[],
  opts: { windowOrigin?: { x: number; y: number }; scale?: number; minEdgePx?: number } = {},
): { png: Buffer; drawn: number; width: number; height: number } {
  const decoded = decodePng(png)
  const { drawn } = drawMarks(decoded, marks, opts)
  if (drawn === 0) return { png, drawn: 0, width: decoded.width, height: decoded.height }
  return { png: encodePngRgba(decoded), drawn, width: decoded.width, height: decoded.height }
}
