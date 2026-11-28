#!/usr/bin/env node
/**
 * Computer Use 坐标解析器（命令行）。
 *
 * 输入：截图实际像素尺寸 + 目标元素在截图上的起止像素（bbox；UIA 元素边界换算成截图坐标后同样适用）。
 * 输出：目标中心物理像素、bbox、0–1000 归一化分数（x/y 各带算式）、按 harness 映射规则预测的
 *       物理落点，以及可选的校验（分数换算回来落在 bbox 外时直接报 miss、偏差像素、建议分数）。
 * 同时把一份记录写到系统临时目录 dsh-cu-coordinate-records/<id>.json，供插件侧 pre-execute 校验。
 *
 * 用法（不带参数会打印帮助）：
 *   node scripts/cu-coordinate-resolver.mjs --shot 1920x1032 --bbox 346,888,471,917 \
 *     --target "Publish release" --tool click --mode millifraction [--position 146,873]
 *
 * 参数：
 *   --shot WxH            截图实际像素尺寸（必填）
 *   --bbox x1,y1,x2,y2    目标元素在截图上的起止像素（必填）
 *   --bounds x,y,w,h      观察面物理矩形（可选；缺省 0,0,截图宽,截图高）
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
 * 退出码：0 = 解析成功（check 可能是 miss，miss 也是成功解析）；1 = 参数/输入错误。
 */
import { resolveCoordinates, writeCoordinateRecord, defaultCoordinateRecordDir } from '../src/cu-coordinate.ts'

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

function usage() {
  return [
    'usage: node scripts/cu-coordinate-resolver.mjs --shot WxH --bbox x1,y1,x2,y2 [options]',
    '  --bounds x,y,w,h     observation surface rect (default 0,0,W,H)',
    '  --mode millifraction|pixel   session coordinate contract (default millifraction)',
    '  --position x,y       position to validate (interpreted by --mode)',
    '  --target <text>      target label (record only; never logged)',
    '  --tool <name>        click (default) / drag / input_text / long_press',
    '  --session <id>       session id (optional; prevents cross-session reuse)',
    '  --screen <n>         screen index (default 0)',
    '  --state-dir <dir>    record directory (default system temp)',
    '  --no-write           resolve only, do not write a record',
    '  --help               print this help',
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
      const [x, y, width, height] = parseQuad(readValue(argv, index, arg), arg)
      bounds = { x, y, width, height }
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

let record
try {
  record = resolveCoordinates({ screenshot: shot, bbox, bounds, mode, position, target, tool, sessionId, screenIndex })
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
