#!/usr/bin/env node
/**
 * Computer Use 坐标解析器（命令行）。
 *
 * 输入：截图实际像素尺寸 + 目标元素在截图上的起止像素（bbox；UIA 元素边界换算成截图坐标后同样适用）
 *      + **观察面在屏幕上的矩形**（`--bounds x,y,w,h` 或 `--bounds auto`）。
 * 输出：目标中心物理像素、bbox、0–1000 归一化分数（x/y 各带算式）、按 harness 映射规则预测的
 *       物理落点，以及可选的校验（分数换算回来落在 bbox 外时直接报 miss、偏差像素、建议分数）。
 * 同时把一份记录写到系统临时目录 dsh-cu-coordinate-records/<id>.json，供插件侧 pre-execute 校验。
 *
 * 为什么 `--bounds` 是必填（2026-11-28 运行期实测）：
 *   截图是**窗口内坐标**（原点 0,0），工具回执的 `Pointer landed at [x, y]` 是**屏幕绝对坐标**。
 *   不给窗口矩形就只能假定原点 0,0，任何不在屏幕左上角的窗口都会得到永久 miss（实测假警报 210 px）。
 *   所以缺 `--bounds` 直接报 `missing-bounds` 退出，绝不静默按 0,0 算。
 *
 * 用法（不带参数会打印帮助）：
 *   node scripts/cu-coordinate-resolver.mjs --shot 1920x1032 --bbox 346,888,471,917 \
 *     --bounds auto --target "Publish release" --tool click --mode millifraction [--position 146,873]
 *
 * 参数：
 *   --shot WxH            截图实际像素尺寸（必填）
 *   --bbox x1,y1,x2,y2    目标元素在截图上的起止像素（必填）
 *   --bounds x,y,w,h|auto 观察面在屏幕上的矩形（必填）；auto = 现场量前台窗口（koffi → user32）
 *   --mode millifraction|pixel  会话坐标口径（缺省 millifraction）
 *   --position x,y        要校验的坐标（可选；按 mode 解释）
 *   --target <文本>       目标标签（只进记录文件，不进日志）
 *   --tool <名>           工具名（缺省 click）
 *   --session <id>        会话 id（可选；防跨会话复用）
 *   --screen <n>          屏幕索引（缺省 0）
 *   --state-dir <目录>    记录目录（缺省系统临时目录）
 *   --no-write            只解析，不写记录
 *   --json                只打印 JSON（缺省也打印 JSON，保留这个开关便于脚本拼命令）
 *   --help                打印本帮助
 *
 * 退出码：0 = 解析成功（check 可能是 miss，miss 也是成功解析）；1 = 参数/输入错误
 *        （错误码写在 stderr：missing-bounds / auto-bounds-unavailable / auto-bounds-mismatch / ...）。
 */
import { createRequire } from 'node:module'
import {
  boundsFromWindowProbe,
  defaultCoordinateRecordDir,
  resolveCoordinates,
  writeCoordinateRecord,
} from '../src/cu-coordinate.ts'

function fail(message) {
  process.stderr.write(`cu-coordinate-resolver: ${message}\n`)
  process.exit(1)
}

function readValue(argv, index, name) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} 缺参数值`)
  return value
}

function parsePair(text, name, separator) {
  const parts = String(text).split(separator).map((part) => Number(part.trim()))
  if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) {
    fail(`${name} 需要两个数字（如 ${separator === 'x' ? '1920x1032' : '346,888'}）`)
  }
  return parts
}

function parseQuad(text, name) {
  const parts = String(text).split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    fail(`${name} 需要四个数字（如 346,888,471,917）`)
  }
  return parts
}

/* ---------- --bounds auto：koffi → user32 / dwmapi 现场量前台窗口 ---------- */

function loadKoffi() {
  try {
    return createRequire(import.meta.url)('koffi')
  } catch {
    return null
  }
}

const RECT_BUFFER_BYTES = 16
const DWMWA_EXTENDED_FRAME_BOUNDS = 9

function readRectInt32(buffer) {
  return {
    x: buffer.readInt32LE(0),
    y: buffer.readInt32LE(4),
    width: buffer.readInt32LE(8) - buffer.readInt32LE(0),
    height: buffer.readInt32LE(12) - buffer.readInt32LE(4),
  }
}

/**
 * 量前台窗口在屏幕上的矩形。
 * 优先 DWM 的 extended frame bounds（与抓屏用的可见区逐像素一致，不含不可见边框）；
 * 退回 GetWindowRect（含不可见边框，交给 boundsFromWindowProbe 的 inset 分支推算原点）。
 * 进程 DPI 感知级别决定坐标是否需要按 DPI 缩放：unaware 时 Win32 返回虚拟化坐标。
 * 取不到就抛 auto-bounds-unavailable，**绝不**静默退回 0,0。
 */
function foregroundWindowProbe() {
  if (process.platform !== 'win32') {
    throw new TypeError('auto-bounds-unavailable: 只有 Windows 能现场量前台窗口，请用 --bounds x,y,w,h')
  }
  const koffi = loadKoffi()
  if (!koffi) throw new TypeError('auto-bounds-unavailable: 加载不到 koffi 原生模块，请用 --bounds x,y,w,h')
  let user32
  try {
    user32 = koffi.load('user32.dll')
  } catch {
    throw new TypeError('auto-bounds-unavailable: user32.dll 加载失败，请用 --bounds x,y,w,h')
  }
  const getForeground = user32.func('void * __stdcall GetForegroundWindow()')
  const hwnd = getForeground()
  if (!hwnd) throw new TypeError('auto-bounds-unavailable: 取不到前台窗口（锁屏或无焦点窗口），请用 --bounds x,y,w,h')

  let rect = null
  let frameSource = 'window-rect'
  try {
    const dwmapi = koffi.load('dwmapi.dll')
    const dwmRect = dwmapi.func('int __stdcall DwmGetWindowAttribute(void *hwnd, uint32 attribute, _Out_ uint8_t *value, uint32 size)')
    const extended = Buffer.alloc(RECT_BUFFER_BYTES)
    if (dwmRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, extended, RECT_BUFFER_BYTES) === 0) {
      const frame = readRectInt32(extended)
      if (frame.width > 0 && frame.height > 0) {
        rect = frame
        frameSource = 'dwm-extended-frame'
      }
    }
  } catch {
    rect = null
  }
  if (!rect) {
    const getWindowRect = user32.func('int __stdcall GetWindowRect(void *hwnd, _Out_ uint8_t *rect)')
    const raw = Buffer.alloc(RECT_BUFFER_BYTES)
    if (getWindowRect(hwnd, raw) === 0) {
      throw new TypeError('auto-bounds-unavailable: GetWindowRect 失败（窗口已关闭？），请用 --bounds x,y,w,h')
    }
    rect = readRectInt32(raw)
    frameSource = 'window-rect'
  }

  // DPI：unaware 进程拿到的是虚拟化坐标，要按系统 DPI 放大才是物理像素。
  let dpi = 96
  let coordScale = 1
  let awareness = 1
  try {
    const getDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(void *hwnd)')
    const value = Number(getDpiForWindow(hwnd))
    if (Number.isFinite(value) && value > 0) dpi = value
  } catch { /* 老系统没有 GetDpiForWindow：按 96 处理 */ }
  try {
    const threadContext = user32.func('void * __stdcall GetThreadDpiAwarenessContext()')
    const awarenessOf = user32.func('int __stdcall GetAwarenessFromDpiAwarenessContext(void *context)')
    awareness = Number(awarenessOf(threadContext()))
  } catch { /* 老系统没有 DPI 感知查询：按已感知处理（不做缩放） */ }
  if (awareness === 0) {
    let systemDpi = dpi
    try {
      const getDpiForSystem = user32.func('uint32 __stdcall GetDpiForSystem()')
      const value = Number(getDpiForSystem())
      if (Number.isFinite(value) && value > 0) systemDpi = value
    } catch { /* 用窗口 DPI 兜底 */ }
    coordScale = systemDpi / 96
  }
  return { rect, dpi, coordScale, frameSource }
}

function usage() {
  return [
    'usage: node scripts/cu-coordinate-resolver.mjs --shot WxH --bbox x1,y1,x2,y2 --bounds x,y,w,h|auto [options]',
    '  --bounds x,y,w,h|auto  REQUIRED observation rect on screen; auto = measure the foreground window now',
    '  --mode millifraction|pixel   session coordinate contract (default millifraction)',
    '  --position x,y       position to validate (interpreted by --mode)',
    '  --target <text>      target label (record only; never logged)',
    '  --tool <name>        click (default) / drag / input_text / long_press',
    '  --session <id>       session id (optional; prevents cross-session reuse)',
    '  --screen <n>         screen index (default 0)',
    '  --state-dir <dir>    record directory (default system temp)',
    '  --no-write           resolve only, do not write a record',
    '  --help               print this help',
    '',
    'exit codes: 0 = resolved (check may be miss); 1 = input error, code on stderr',
    '(missing-bounds / auto-bounds-unavailable / auto-bounds-mismatch)',
  ].join('\n')
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`)
  process.exit(0)
}

let shot
let bbox
let bounds
let boundsArgSeen = false
let mode = 'millifraction'
let position
let target = ''
let tool = 'click'
let sessionId = ''
let screenIndex = 0
let stateDir = defaultCoordinateRecordDir()
let write = true

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  switch (arg) {
    case '--shot': {
      const [width, height] = parsePair(readValue(argv, index, arg), arg, 'x')
      shot = { width, height }
      index += 1
      break
    }
    case '--bbox': {
      const [x1, y1, x2, y2] = parseQuad(readValue(argv, index, arg), arg)
      bbox = { x1, y1, x2, y2 }
      index += 1
      break
    }
    case '--bounds': {
      const value = readValue(argv, index, arg)
      boundsArgSeen = true
      if (value === 'auto') {
        bounds = 'auto'
      } else {
        const [x, y, width, height] = parseQuad(value, arg)
        bounds = { x, y, width, height }
      }
      index += 1
      break
    }
    case '--mode': {
      const value = readValue(argv, index, arg)
      if (value !== 'millifraction' && value !== 'pixel') fail('--mode 只能是 millifraction 或 pixel')
      mode = value
      index += 1
      break
    }
    case '--position': {
      position = parsePair(readValue(argv, index, arg), arg, ',')
      index += 1
      break
    }
    case '--target': {
      target = readValue(argv, index, arg)
      index += 1
      break
    }
    case '--tool': {
      tool = readValue(argv, index, arg)
      index += 1
      break
    }
    case '--session': {
      sessionId = readValue(argv, index, arg)
      index += 1
      break
    }
    case '--screen': {
      const value = Number(readValue(argv, index, arg))
      if (!Number.isInteger(value) || value < 0) fail('--screen 需要非负整数')
      screenIndex = value
      index += 1
      break
    }
    case '--state-dir': {
      stateDir = readValue(argv, index, arg)
      index += 1
      break
    }
    case '--no-write': {
      write = false
      break
    }
    case '--json': {
      break
    }
    default: {
      fail(`未知参数 ${arg}（--help 看用法）`)
    }
  }
}

if (!shot) fail('缺 --shot WxH')
if (!bbox) fail('缺 --bbox x1,y1,x2,y2')
if (!boundsArgSeen) {
  fail('missing-bounds: 截图是窗口内坐标（原点 0,0）、落点是屏幕绝对坐标，必须给窗口在屏幕上的矩形：'
    + '--bounds x,y,w,h 或 --bounds auto（现场量前台窗口）')
}

let boundsSource = 'explicit'
let boundsNotes = []
let windowProbe = null
if (bounds === 'auto') {
  let probe
  try {
    probe = foregroundWindowProbe()
  } catch (error) {
    fail(String(error?.message ?? error))
  }
  let autoBounds
  try {
    autoBounds = boundsFromWindowProbe(shot, probe)
  } catch (error) {
    fail(String(error?.message ?? error))
  }
  bounds = autoBounds.bounds
  boundsSource = 'auto'
  boundsNotes = autoBounds.boundsNotes
  windowProbe = {
    frameSource: probe.frameSource,
    dpi: probe.dpi,
    coordScale: probe.coordScale,
    rect: probe.rect,
    captureScale: autoBounds.captureScale,
  }
}

let record
try {
  record = resolveCoordinates({
    screenshot: shot,
    bbox,
    bounds,
    boundsSource,
    boundsNotes,
    mode,
    position,
    target,
    tool,
    sessionId,
    screenIndex,
  })
} catch (error) {
  fail(String(error?.message ?? error))
}

if (write) {
  try {
    writeCoordinateRecord(record, stateDir)
  } catch (error) {
    fail(`记录写盘失败：${String(error?.message ?? error)}`)
  }
}

const output = {
  ok: true,
  recordId: record.id,
  target: record.target,
  tool: record.tool,
  mode: record.mode,
  screenshot: record.screenshot,
  bounds: record.bounds,
  boundsSource: record.boundsSource,
  origin: record.origin,
  boundsNotes: record.boundsNotes,
  ...(windowProbe === null ? {} : { windowProbe }),
  bbox: record.bbox,
  center: record.center,
  fractions: record.fractions,
  formulas: record.formulas,
  suggestedFractions: record.suggestedFractions,
  suggestedPixels: record.suggestedPixels,
  predicted: record.predicted,
  predictedRounded: record.predictedRounded,
  check: record.check,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
