/**
 * Computer Use 坐标硬门：pre-execute 拒绝「没有解析记录 / 分数落在 bbox 外」的点击，
 * post-execute 把工具回执的 `Pointer landed at [x, y]` 与记录 bbox 比对，命中/未命中
 * 写进 turn-guard 日志（沿用 sanitizeTurnGuardLine 掩码与 MAX_LOG_BYTES 轮转）。
 *
 * vendor/computer-use 一行未改：工具 schema 本来就没有 coordinate_record 字段，但宿主
 * 的 `defineTool` 参数对象默认允许附加属性，所以模型可以多带一个 `coordinate_record`。
 * 记录由 scripts/cu-coordinate-resolver.mjs 产出（同一份纯逻辑在 src/cu-coordinate.ts）。
 *
 * 日志只落标识与数字：tool / code / session / screen / bbox / landed / deviationPx /
 * streak / textChars，不落目标文本（没有 excerpt），也不落本机绝对路径。
 */

// @ts-ignore -- 仓库没有 @types/node（见 scripts/typecheck.mjs 的已知缺口）
import { fileURLToPath } from 'node:url'
// @ts-ignore
import { join } from 'node:path'
import { dshHome } from './assistant-config.ts'
import { appendTurnGuardLog, sanitizeTurnGuardLine } from './turn-guard.ts'
import {
  CLICK_TOOLS,
  COORDINATE_RECORD_TTL_MS,
  checkLandedPhysical,
  defaultCoordinateRecordDir,
  isCoordinateRecordId,
  readCoordinateRecord,
  validateCoordinateRecord,
  validatePositionForRecord,
} from './cu-coordinate.ts'
import type {
  CuCoordinateMode,
  CuCoordinateRecord,
  CuPositionCheck,
} from './cu-coordinate.ts'

/** deny 码：缺记录。 */
export const DENY_MISSING_RECORD = 'missing-coordinate-record'
/** deny 码：分数换算回来落在 bbox 外。 */
export const DENY_OUT_OF_BOUNDS = 'coordinate-out-of-bounds'
/** deny 码：记录过期（默认 10 分钟）。 */
export const DENY_RECORD_STALE = 'coordinate-record-stale'
/** deny 码：记录坏/跨会话/坐标口径不一致。 */
export const DENY_RECORD_INVALID = 'coordinate-record-invalid'
/** deny 码：同一目标已连续 2 次 miss，坐标点击停用。 */
export const DENY_TARGET_BLOCKED = 'coordinate-target-blocked'

const CLICK_TOOL_SET = new Set<string>(CLICK_TOOLS)

export interface CuCoordinateGateOptions {
  /** 记录目录；默认系统临时目录下的 dsh-cu-coordinate-records。 */
  stateDir?: string
  /** turn-guard 日志文件；默认 <DSH_HOME>/dsh-assistant-turn-guard.log。 */
  logFile?: string
  /** 日志出口（测试注入）；默认 appendTurnGuardLog(logFile, line)。 */
  log?: (line: string) => void
  /** 当前时间（测试注入）。 */
  now?: () => number
  /** 记录有效期（测试注入）。 */
  ttlMs?: number
  /** 解析器绝对路径（写进拒绝提示）；默认从本模块位置推出仓库 scripts/。 */
  resolverPath?: string
}

interface PendingRecord {
  record: CuCoordinateRecord
  tool: string
  screenIndex: number
  sessionId: string
}

export interface CuCoordinateGate {
  /** pre-execute 处理器：允许时返回 next()，拒绝时返回 { kind: 'deny', reason, info }。 */
  preExecute: (exec: any, next: () => Promise<any>) => Promise<any>
  /** post-execute 处理器：命中返回 next()，未命中返回 { kind: 'block', feedback }。 */
  postExecute: (exec: any, result: any, next: () => Promise<any>) => Promise<any>
  /** 本门写日志用的函数（已做 sanitize；测试可直接调）。 */
  log: (line: string) => void
  /** 解析器路径。 */
  resolverPath: string
  /** 清空内存里的 pending/连续 miss（测试用）。 */
  reset: () => void
}

function clickPoints(tool: string, args: any): Array<{ key: string; position: number[] | null }> {
  const read = (value: unknown): number[] | null => {
    if (!Array.isArray(value) || value.length !== 2) return null
    const [x, y] = value
    return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
      ? [x, y]
      : null
  }
  if (tool === 'drag') {
    return [
      { key: 'start', position: read(args?.start_position) },
      { key: 'end', position: read(args?.end_position) },
    ]
  }
  return [{ key: 'position', position: read(args?.position) }]
}

/** 会话是否 Computer Use：预设名优先，坐标模式事件兜底。 */
export function isComputerUseSession(session: any): boolean {
  if (String(session?.header?.agentPreset ?? '') === 'computer-use') return true
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  return Array.isArray(events) && events.some((event: any) => {
    const type = String(event?.type ?? '')
    return type === 'computer-use/coordinate-mode' || type === 'plugin:computer-use/coordinate-mode'
  })
}

/** 会话当前坐标口径：坐标模式事件优先；没有就按 harness 缺省 millifraction。 */
export function sessionCoordinateMode(session: any): CuCoordinateMode {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      const type = String(event?.type ?? '')
      if (type !== 'computer-use/coordinate-mode' && type !== 'plugin:computer-use/coordinate-mode') continue
      if (event?.data?.mode === 'pixel' || event?.data?.mode === 'millifraction') return event.data.mode
    }
  }
  return 'millifraction'
}

function positionText(position: number[]): string {
  return `${String(position[0])},${String(position[1])}`
}

function bboxText(record: CuCoordinateRecord): string {
  const { x1, y1, x2, y2 } = record.bbox
  return `${String(x1)},${String(y1)},${String(x2)},${String(y2)}`
}

function suggestedText(record: CuCoordinateRecord): string {
  const fractions = record.suggestedFractions
  return `${String(fractions.x)},${String(fractions.y)}`
}

function missingReason(tool: string, mode: CuCoordinateMode, resolverPath: string): string {
  const modeHint = mode === 'pixel' ? 'pixel' : 'millifraction'
  return `坐标硬门拒绝了 ${tool}：这次调用没有带 coordinate_record，按规则不许点击。`
    + `先跑解析器：node "${resolverPath}" --shot <截图宽>x<截图高> --bbox <x1,y1,x2,y2> --target "<目标>" --tool ${tool} --mode ${modeHint}；`
    + `再把输出里的 record.id 作为 coordinate_record 传入，position 用 suggestedFractions（0–1000）或 suggestedPixels（像素，按回执里的坐标口径选）。`
    + `截图尺寸与 bbox 从最新截图读，不许目测分数。`
}

function outOfBoundsReason(tool: string, check: CuPositionCheck, record: CuCoordinateRecord, position: number[]): string {
  const suggestion = record.suggestedFractions
  return `坐标硬门拒绝了 ${tool}：position [${positionText(position)}] 按记录换算落到物理 (${String(check.landed.x)},${String(check.landed.y)})，`
    + `不在目标 bbox (${bboxText(record)}) 内，偏差 ${String(check.deviationPx)} px。`
    + `建议改用分数 [${String(suggestion.x)}, ${String(suggestion.y)}]（预计落点 [${String(record.predictedRounded.x)},${String(record.predictedRounded.y)}]）。`
    + `重算后再点；同一目标连续 2 次 miss 就改用地址栏导航 URL / 键盘 Tab-Enter / 读页面文本链接，不许无限重试。`
}

function invalidReason(code: string, message: string, tool: string, resolverPath: string): string {
  return `坐标硬门拒绝了 ${tool}：${code}（${message}）。重跑解析器 node "${resolverPath}" ... 生成新记录后再点；不许凭目测分数重试。`
}

function missFeedback(check: CuPositionCheck, record: CuCoordinateRecord): string {
  return `未命中：工具回执落点 (${String(check.landed.x)},${String(check.landed.y)}) 不在目标 bbox (${bboxText(record)}) 内，偏差 ${String(check.deviationPx)} px。`
    + `修正建议：分数 [${String(record.suggestedFractions.x)}, ${String(record.suggestedFractions.y)}]，预计落点 [${String(record.predictedRounded.x)},${String(record.predictedRounded.y)}]。`
    + `先按最新截图重算 bbox，再点一次。`
}

function secondMissFeedback(check: CuPositionCheck, record: CuCoordinateRecord, streak: number): string {
  return `同一目标已连续 ${String(streak)} 次未命中（本次落点 (${String(check.landed.x)},${String(check.landed.y)})，偏差 ${String(check.deviationPx)} px）。`
    + `停止坐标点击，不许继续蒙点：改用地址栏直接导航 URL、键盘 Tab-Enter、或读页面文本链接来操作。`
}

function blockedReason(tool: string, record: CuCoordinateRecord): string {
  return `坐标硬门拒绝了 ${tool}：同一目标 bbox (${bboxText(record)}) 已连续 2 次未命中，坐标点击对这框已停用。`
    + `改用地址栏直接导航 URL、键盘 Tab-Enter、或读页面文本链接；如果目标位置真的变了，重新框定 bbox（框变了才算新目标）后再跑解析器生成新记录。`
}

function readLanded(result: any): { x: number; y: number } | null {
  const value = result?.value
  const landed = value?.landed
  if (Array.isArray(landed) && landed.length === 2
    && typeof landed[0] === 'number' && Number.isFinite(landed[0])
    && typeof landed[1] === 'number' && Number.isFinite(landed[1])) {
    return { x: landed[0], y: landed[1] }
  }
  // 兜底：模型回执行文本里带「Pointer landed at [x, y] physical pixels」。
  const blocks = Array.isArray(result?.content) ? result.content : []
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    const match = /Pointer landed at \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] physical pixels/.exec(String(block.text ?? ''))
    if (match) return { x: Number(match[1]), y: Number(match[2]) }
  }
  return null
}

/**
 * 造一个坐标硬门（不挂宿主，便于单测直接调 preExecute / postExecute）。
 */
export function createCuCoordinateGate(options: CuCoordinateGateOptions = {}): CuCoordinateGate {
  const stateDir = String(options.stateDir ?? '').trim() || defaultCoordinateRecordDir()
  const logFile = String(options.logFile ?? '').trim() || join(dshHome(), 'dsh-assistant-turn-guard.log')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : COORDINATE_RECORD_TTL_MS
  const resolverPath = String(options.resolverPath ?? '').trim() || defaultResolverPath()
  const sink = typeof options.log === 'function' ? options.log : (line: string) => { appendTurnGuardLog(logFile, line) }
  // 无论日志出口是文件还是测试注入，都先过同一把掩码：路径与多行在进 sink 前就被处理。
  const log = (line: string) => { sink(sanitizeTurnGuardLine(line)) }
  const pending = new WeakMap<object, PendingRecord>()
  const streaks = new Map<string, number>()

  const deny = (tool: string, code: string, reason: string, extra: string): any => {
    log(`cu-coord deny tool=${tool} code=${code} ${extra} textChars=0`)
    return { kind: 'deny', reason, info: { name: 'CuCoordinateGateError', code } }
  }

  const preExecute = async (exec: any, next: () => Promise<any>): Promise<any> => {
    const tool = String(exec?.name ?? '')
    if (!CLICK_TOOL_SET.has(tool)) return next()
    const session = exec?.agent?.session
    if (!isComputerUseSession(session)) return next()
    const args = exec?.arguments ?? {}
    const sessionId = String(session?.id ?? '')
    const screenIndex = Number.isInteger(args?.screen_index) ? Number(args.screen_index) : 0
    try {
      const mode = sessionCoordinateMode(session)
      const points = clickPoints(tool, args)
      const primary = points.find((point) => point.key !== 'end') ?? points[0]
      if (!primary || primary.position === null) return next()
      const recordArg = typeof args?.coordinate_record === 'string' ? args.coordinate_record.trim() : ''
      if (recordArg === '') {
        return deny(tool, DENY_MISSING_RECORD, missingReason(tool, mode, resolverPath), `session=${sessionId} screen=${String(screenIndex)}`)
      }
      if (!isCoordinateRecordId(recordArg)) {
        return deny(tool, DENY_RECORD_INVALID, invalidReason(DENY_RECORD_INVALID, 'coordinate_record 不是 8–32 位十六进制 id', tool, resolverPath), `session=${sessionId} screen=${String(screenIndex)}`)
      }
      const record = readCoordinateRecord(recordArg, stateDir)
      if (record === null) {
        return deny(
          tool,
          DENY_RECORD_INVALID,
          invalidReason(DENY_RECORD_INVALID, `记录 ${recordArg} 不存在或内容坏了`, tool, resolverPath),
          `session=${sessionId} screen=${String(screenIndex)} record=${recordArg}`,
        )
      }
      const valid = validateCoordinateRecord(record, { sessionId, mode, now: now(), ttlMs })
      if (!valid.ok) {
        return deny(tool, valid.code, invalidReason(valid.code, valid.message, tool, resolverPath), `session=${sessionId} screen=${String(screenIndex)} record=${recordArg}`)
      }
      const checked = record as CuCoordinateRecord
      const streakKey = `${sessionId}|${bboxText(checked)}`
      if ((streaks.get(streakKey) ?? 0) >= 2) {
        return deny(
          tool,
          DENY_TARGET_BLOCKED,
          blockedReason(tool, checked),
          `session=${sessionId} screen=${String(screenIndex)} bbox=${bboxText(checked)} streak=${String(streaks.get(streakKey))} record=${recordArg}`,
        )
      }
      const check = validatePositionForRecord(checked, primary.position)
      if (!check.hit) {
        return deny(
          tool,
          DENY_OUT_OF_BOUNDS,
          outOfBoundsReason(tool, check, checked, primary.position),
          `session=${sessionId} screen=${String(screenIndex)} position=${positionText(primary.position)} landed=${String(check.landed.x)},${String(check.landed.y)} bbox=${bboxText(checked)} deviationPx=${String(check.deviationPx)} suggest=${suggestedText(checked)} record=${recordArg}`,
        )
      }
      // drag 的终点可选第二条记录；没给就不拦（起点记录已经覆盖这次手势的主目标）。
      if (tool === 'drag') {
        const endPoint = points.find((point) => point.key === 'end')
        const endRecordArg = typeof args?.coordinate_record_end === 'string' ? args.coordinate_record_end.trim() : ''
        if (endPoint?.position && endRecordArg !== '') {
          const endRecord = readCoordinateRecord(endRecordArg, stateDir)
          const endValid = validateCoordinateRecord(endRecord, { sessionId, mode, now: now(), ttlMs })
          if (!endValid.ok || !endRecord) {
            return deny(tool, endValid.code, invalidReason(endValid.code, endValid.message, tool, resolverPath), `session=${sessionId} screen=${String(screenIndex)} record=${endRecordArg}`)
          }
          const endCheck = validatePositionForRecord(endRecord, endPoint.position)
          if (!endCheck.hit) {
            return deny(tool, DENY_OUT_OF_BOUNDS, outOfBoundsReason(tool, endCheck, endRecord, endPoint.position), `session=${sessionId} screen=${String(screenIndex)} position=${positionText(endPoint.position)} landed=${String(endCheck.landed.x)},${String(endCheck.landed.y)} bbox=${bboxText(endRecord)} deviationPx=${String(endCheck.deviationPx)} suggest=${suggestedText(endRecord)} record=${endRecordArg}`)
          }
        }
      }
      pending.set(exec as object, { record: checked, tool, screenIndex, sessionId })
      log(`cu-coord allow tool=${tool} session=${sessionId} screen=${String(screenIndex)} record=${recordArg} bbox=${bboxText(checked)} position=${positionText(primary.position)} deviationPx=0 textChars=0`)
      return next()
    } catch (error) {
      return deny(
        tool,
        DENY_RECORD_INVALID,
        `坐标硬门内部校验失败（${String((error as Error)?.message ?? error)}）：这一下先不点，重跑解析器生成新记录后再试。`,
        `session=${sessionId} screen=${String(screenIndex)}`,
      )
    }
  }

  const postExecute = async (exec: any, result: any, next: () => Promise<any>): Promise<any> => {
    const pendingRecord = pending.get(exec as object)
    if (!pendingRecord) return next()
    pending.delete(exec as object)
    const tool = String(exec?.name ?? pendingRecord.tool)
    // 只有 click 的回执带「Pointer landed at [x, y]」；其它工具清掉 pending 后原样放行。
    if (tool !== 'click') return next()
    try {
      if (result?.isError === true) return next()
      const landed = readLanded(result)
      if (!landed) {
        log(`cu-coord landed-missing tool=click session=${pendingRecord.sessionId} screen=${String(pendingRecord.screenIndex)} record=${pendingRecord.record.id} textChars=0`)
        return next()
      }
      const record = pendingRecord.record
      const check = checkLandedPhysical(record, landed)
      const streakKey = `${pendingRecord.sessionId}|${bboxText(record)}`
      const landedText = `${String(landed.x)},${String(landed.y)}`
      if (check.hit) {
        streaks.delete(streakKey)
        log(`cu-coord hit tool=click session=${pendingRecord.sessionId} screen=${String(pendingRecord.screenIndex)} landed=${landedText} bbox=${bboxText(record)} center=${String(record.center.x)},${String(record.center.y)} deviationPx=0 streak=0 record=${record.id} textChars=0`)
        return next()
      }
      const streak = (streaks.get(streakKey) ?? 0) + 1
      streaks.set(streakKey, streak)
      if (streaks.size > 500) streaks.clear()
      const advice = streak >= 2 ? ' advice=non-coordinate' : ''
      log(`cu-coord miss tool=click session=${pendingRecord.sessionId} screen=${String(pendingRecord.screenIndex)} landed=${landedText} bbox=${bboxText(record)} deviationPx=${String(check.deviationPx)} streak=${String(streak)} record=${record.id}${advice} textChars=0`)
      const text = streak >= 2 ? secondMissFeedback(check, record, streak) : missFeedback(check, record)
      return { kind: 'block', feedback: [{ type: 'text', text }] }
    } catch (error) {
      log(`cu-coord post-failed kind=${String((error as Error)?.name ?? 'unknown')} message=${String((error as Error)?.message ?? '')} textChars=0`)
      return next()
    }
  }

  return {
    preExecute,
    postExecute,
    log,
    resolverPath,
    reset: () => { streaks.clear() },
  }
}

/** 解析器默认位置：从本模块（构建后 lib/index.js）向上一级找 scripts/。 */
export function defaultResolverPath(): string {
  try {
    return fileURLToPath(new URL('../scripts/cu-coordinate-resolver.mjs', import.meta.url))
  } catch {
    return 'scripts/cu-coordinate-resolver.mjs'
  }
}

/** CU 会话里每步都可见的硬门提示（非 CU 会话返回空串）。 */
export function coordinateGatePrompt(resolverPath: string): string {
  return `【点击前坐标硬门（必须执行）】本会话的 click / drag / input_text / long_press 没有坐标记录会被直接拒绝。每次点击前：`
    + `1) 从最新截图读出目标元素的起止像素 x1,y1,x2,y2 和截图尺寸 WxH，不许目测分数；`
    + `2) 运行 node "${resolverPath}" --shot WxH --bbox x1,y1,x2,y2 --target "<目标>" --tool click --mode <会话坐标口径>（截图被缩放时加 --bounds x,y,w,h：观察面窗口矩形）；`
    + `3) 把输出 record.id 作为 coordinate_record 传入，position 用 suggestedFractions（0–1000）或 suggestedPixels（像素，按回执里的坐标口径选）；`
    + `4) 回执 Pointer landed at [x,y] 必须落在 bbox 内；同一目标连续 2 次未命中就停手，改用地址栏导航 URL / 键盘 Tab-Enter / 读页面文本链接，不许继续蒙点。`
}

const COORDINATE_RECORD_DESCRIPTION = 'Required before this click: the record.id printed by scripts/cu-coordinate-resolver.mjs. The call is rejected without a valid record.'
const COORDINATE_RECORD_END_DESCRIPTION = 'Optional second record id for the drag end position (start uses coordinate_record).'

/**
 * 在 system-prompt/assemble 的最终结果上给点击类工具补一个 coordinate_record 参数。
 * 只加字段，不动 vendor 的 schema 语义：模型能看见这个参数，严格按 schema 校验的 provider 也不会吞掉它。
 */
export function withCoordinateRecordFields(assembly: any): any {
  if (!assembly || !Array.isArray(assembly.tools)) return assembly
  let changed = false
  const tools = assembly.tools.map((tool: any) => {
    const toolName = String(tool?.name ?? '')
    if (!CLICK_TOOL_SET.has(toolName)) return tool
    const parameters = tool?.parameters && typeof tool.parameters === 'object' ? structuredClone(tool.parameters) : null
    if (!parameters || typeof parameters !== 'object') return tool
    const properties = (parameters as any).properties
    if (!properties || typeof properties !== 'object') return tool
    let toolChanged = false
    if ((properties as any).coordinate_record === undefined) {
      ;(properties as any).coordinate_record = { type: 'string', description: COORDINATE_RECORD_DESCRIPTION }
      toolChanged = true
    }
    if (toolName === 'drag' && (properties as any).coordinate_record_end === undefined) {
      ;(properties as any).coordinate_record_end = { type: 'string', description: COORDINATE_RECORD_END_DESCRIPTION }
      toolChanged = true
    }
    if (!toolChanged) return tool
    changed = true
    return { ...tool, parameters }
  })
  return changed ? { ...assembly, tools } : assembly
}

/**
 * 挂上坐标硬门：pre-execute、post-execute 与 CU 会话提示词段。
 * 返回卸载函数；任何一处挂不上都不影响其它半部（registerPiece 自带 try/catch）。
 */
export function installCuCoordinateGate(ctx: any, options: CuCoordinateGateOptions = {}): () => void {
  const gate = createCuCoordinateGate(options)
  const disposers: Array<() => void> = []
  if (typeof ctx?.on === 'function') {
    try {
      const off = ctx.on('tools/pre-execute', gate.preExecute)
      if (typeof off === 'function') disposers.push(off)
    } catch { /* 老宿主没有 pre-execute 钩子：工具内部校验仍然拦得住 */ }
    try {
      const off = ctx.on('tools/post-execute', gate.postExecute)
      if (typeof off === 'function') disposers.push(off)
    } catch { /* 老宿主没有 post-execute 钩子：命中日志少一段，硬门仍生效 */ }
    try {
      const off = ctx.on('system-prompt/assemble', async (_assembly: any, _context: any, next: () => Promise<any>) => {
        const assembly = await next()
        return withCoordinateRecordFields(assembly)
      })
      if (typeof off === 'function') disposers.push(off)
    } catch { /* 没有 system-prompt/assemble：参数不在 schema 里，提示词仍让模型带 coordinate_record */ }
  }
  try {
    const systemPrompt = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      const off = systemPrompt.section({
        name: 'assistant:cu-coordinate-gate',
        order: 1795,
        text: (context: any) => (isComputerUseSession(context?.agent?.session) ? coordinateGatePrompt(gate.resolverPath) : ''),
      })
      if (typeof off === 'function') disposers.push(off)
    }
  } catch { /* 没有 systemPrompt 服务：提示少一段，硬门仍生效 */ }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch { /* 卸载竞态无需处理 */ }
    }
  }
}
