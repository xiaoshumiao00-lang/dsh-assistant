/**
 * v4 会话日志（session.v4.jsonl.zstd）的**事务化改写**工具。
 *
 * 背景（2026-11-21 事故）：插件以前自己拼 turn/start → step/start → assistant/message →
 * step/end → turn/end 五连写往秘书会话里塞"合成轮"，turn 号按"日志里最大 turn + 1"算。
 * 但宿主的 turn 号来自 AgentLoop 的**内存计数器**（`phase.turn + 1`，见
 * packages/core/agent-loop/src/agent.ts），它完全不知道日志里被塞进来的外来轮。
 * 于是插件写 turn 7、宿主下一轮也开 turn 7，v4 恢复器在 `relationships.ts` 里
 * 要求 `turn/start` 必须等于 `nextTurn`，重复即抛
 * `SessionFormatError: turn/start does not open the expected turn` —— 整个会话打不开。
 *
 * 结论：
 *   1. **运行时绝不再写 turn/step 事件**（CU 完成汇报改走宿主官方 prompt 通道，
 *      见 assistant-cu-watch.ts 的 notifySecretary）；
 *   2. 只有"抢救已经坏掉的日志"这类离线维护动作才会落盘，而且必须：
 *      写入前用**宿主同一套解析器** dry-run 校验 → 原子写 → 写入后再回读校验 →
 *      任何一步失败立即回滚到备份。绝不静默写非法事件。
 *
 * 解析器来源（fail closed）：
 *   - 环境变量 DSH_HOST_PARSER 指定 @deepseek-ai/dsh-session-format-v3-to-v4 的 lib/index.js；
 *   - 否则用本机已知的宿主源码检出位置；
 *   - 事件词表（KNOWN_SESSION_EVENT_TYPES）默认取同仓库的 packages/core/session，
 *     可用 DSH_HOST_SESSION_MODULE 覆盖。
 *   找不到解析器就**拒绝写入**，不做"自写简化校验"兜底。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 宿主同一套解析器（已经装好事件词表）。 */
export interface HostLogParser {
  /** 解析器模块位置（报告/日志用）。 */
  source: string
  /** 事件词表模块位置。 */
  vocabulary: string
  /** 用宿主解析器校验一段完整日志文本；不合法直接抛错（失败即拒绝写入）。 */
  assertAccepted: (text: string) => void
}

/** 解压（支持多帧 zstd；宿主写盘是按帧追加的）。 */
export function decompressLogBytes(data: Uint8Array | Buffer): string {
  const zlib2 = zlib as any
  if (typeof zlib2.zstdDecompressSync !== 'function') throw new Error('zstdDecompressSync not available')
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const first = buffer.indexOf(ZSTD_MAGIC)
  if (first === -1) {
    if (buffer.length === 0) return ''
    return Buffer.from(zlib2.zstdDecompressSync(buffer)).toString('utf8')
  }
  const chunks: string[] = []
  for (let cursor = first; cursor < buffer.length; ) {
    const next = buffer.indexOf(ZSTD_MAGIC, cursor + ZSTD_MAGIC.length)
    const end = next === -1 ? buffer.length : next
    chunks.push(Buffer.from(zlib2.zstdDecompressSync(buffer.subarray(cursor, end))).toString('utf8'))
    cursor = end
  }
  return chunks.join('')
}

/** 压缩成单帧 zstd（宿主多帧读取器接受单帧）。 */
export function compressLogText(text: string): Buffer {
  const zlib2 = zlib as any
  if (typeof zlib2.zstdCompressSync !== 'function') throw new Error('zstdCompressSync not available')
  return Buffer.from(zlib2.zstdCompressSync(Buffer.from(String(text ?? ''), 'utf8')))
}

/** 把日志文本解析成宿主 artifact 形状（header 去掉物理行里的 type 字段）。 */
export function parseLogText(text: string): { header: Record<string, unknown>; inheritedEventCount: number; events: any[] } {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new Error('日志是空的')
  let rawHeader: any
  try {
    rawHeader = JSON.parse(lines[0])
  } catch {
    throw new Error('首行不是 JSON（不是 v4 日志）')
  }
  if (rawHeader === null || typeof rawHeader !== 'object' || rawHeader.type !== 'session' || rawHeader.version !== 4) {
    throw new Error('首行不是 v4 session 头')
  }
  const { type: _type, ...header } = rawHeader
  const events: any[] = []
  for (let index = 1; index < lines.length; index += 1) {
    let event: any
    try {
      event = JSON.parse(lines[index])
    } catch {
      throw new Error(`第 ${index} 行不是 JSON`)
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new Error(`第 ${index} 行不是事件对象`)
    if (event.seq !== index - 1) throw new Error(`第 ${index} 行 seq 不是密的（seq=${String(event.seq)}，期望 ${index - 1}）`)
    events.push(event)
  }
  return { header, inheritedEventCount: 0, events }
}

/** 本机可能存在的宿主解析器位置（前者优先）。 */
export function defaultHostParserPaths(): string[] {
  const out: string[] = []
  const explicit = String(process.env.DSH_HOST_PARSER ?? '').trim()
  if (explicit !== '') out.push(explicit)
  out.push('D:\\deepseek-harness\\packages\\session\\session-format-v3-to-v4\\lib\\index.js')
  out.push('D:\\DSH Desktop\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-session-format-v3-to-v4\\lib\\index.js')
  return out
}

/** 由解析器位置推出事件词表位置（可用 DSH_HOST_SESSION_MODULE 覆盖）。 */
function vocabularyCandidates(parserPath: string): string[] {
  const out: string[] = []
  const explicit = String(process.env.DSH_HOST_SESSION_MODULE ?? '').trim()
  if (explicit !== '') out.push(explicit)
  const normalized = resolvePath(parserPath)
  out.push(join(dirname(dirname(dirname(normalized))), 'core', 'session', 'lib', 'index.js'))
  out.push('D:\\deepseek-harness\\packages\\core\\session\\lib\\index.js')
  out.push('D:\\DSH Desktop\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-session\\lib\\index.js')
  return out
}

function requireModule(path: string): any {
  const loader = createRequire(import.meta.url)
  return loader(path)
}

/** 加载宿主真实解析器；加载不到就抛（fail closed，调用方必须放弃写入）。 */
export function loadHostLogParser(explicitPath = ''): HostLogParser {
  const requested = String(explicitPath ?? '').trim()
  // 显式指定的路径就是唯一候选：写错名字要立刻报错，不许悄悄换成别的解析器。
  const candidates = requested !== '' ? [requested] : defaultHostParserPaths()
  const problems: string[] = []
  let parserModule: any
  let parserPath = ''
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) { problems.push(`${candidate}（不存在）`); continue }
      const module = requireModule(candidate)
      if (typeof module?.restoreReleasedV4Artifact !== 'function') {
        problems.push(`${candidate}（没有 restoreReleasedV4Artifact）`)
        continue
      }
      parserModule = module
      parserPath = candidate
      break
    } catch (error: unknown) {
      problems.push(`${candidate}（${String((error as Error)?.message ?? error)}）`)
    }
  }
  if (parserModule === undefined) {
    throw new Error(`宿主真实解析器不可用，已拒绝写入会话日志：${problems.join('；') || '没有任何候选路径'}`)
  }
  let known: ReadonlySet<string> | undefined
  let vocabPath = ''
  for (const candidate of vocabularyCandidates(parserPath)) {
    try {
      if (!existsSync(candidate)) continue
      const module = requireModule(candidate)
      if (module?.KNOWN_SESSION_EVENT_TYPES instanceof Set) {
        known = module.KNOWN_SESSION_EVENT_TYPES as ReadonlySet<string>
        vocabPath = candidate
        break
      }
    } catch { /* 换下一个候选 */ }
  }
  if (known === undefined) {
    throw new Error(`拿到宿主解析器但读不到 KNOWN_SESSION_EVENT_TYPES（${parserPath}），已拒绝写入会话日志`)
  }
  const vocabulary = known
  return {
    source: parserPath,
    vocabulary: vocabPath,
    assertAccepted(text: string): void {
      const artifact = parseLogText(text)
      parserModule.restoreReleasedV4Artifact(artifact, vocabulary)
    },
  }
}

export interface SessionLogRewriteOptions {
  /** 目标文件（session.v4.jsonl.zstd 的绝对路径）。 */
  file: string
  /** 文本 → 文本 的修复函数。 */
  transform: (text: string) => string
  /** 宿主真实解析器（必须来自 loadHostLogParser）。 */
  parser: HostLogParser
  /** 备份路径；默认同目录 `<file>.bak-<时间戳>`。 */
  backupPath?: string
  /** 只校验不落盘。 */
  dryRun?: boolean
}

export interface SessionLogRewriteReport {
  ok: boolean
  dryRun: boolean
  file: string
  backupPath: string
  beforeEvents: number
  afterEvents: number
  beforeBytes: number
  afterBytes: number
  restored: boolean
}

function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 事务化改写：宿主解析器 dry-run → 备份 → 原子写 → 回读再校验 → 失败回滚。
 * 任一步失败都会抛错；写入后的失败会先把备份还原回去再抛，绝不留下半截轮。
 */
export function rewriteSessionLogFileSync(options: SessionLogRewriteOptions): SessionLogRewriteReport {
  const file = String(options.file ?? '')
  if (file === '') throw new Error('rewriteSessionLogFileSync: 缺少 file')
  if (typeof options.transform !== 'function') throw new Error('rewriteSessionLogFileSync: 缺少 transform')
  if (options.parser === null || typeof options.parser?.assertAccepted !== 'function') {
    throw new Error('rewriteSessionLogFileSync: 缺少宿主解析器（必须 fail closed）')
  }
  const parser = options.parser
  const dryRun = options.dryRun === true
  const original = readFileSync(file)
  const beforeText = decompressLogBytes(original)
  const beforeEvents = parseLogText(beforeText).events.length

  const candidate = String(options.transform(beforeText))
  // ① 写入前：宿主同一套解析器 dry-run。不合法 → 直接抛，文件一个字节都没动。
  parser.assertAccepted(candidate)
  const afterEvents = parseLogText(candidate).events.length
  const backupPath = String(options.backupPath ?? '').trim() || `${file}.bak-${stamp()}`
  const report: SessionLogRewriteReport = {
    ok: true,
    dryRun,
    file,
    backupPath: dryRun ? '' : backupPath,
    beforeEvents,
    afterEvents,
    beforeBytes: original.length,
    afterBytes: 0,
    restored: false,
  }
  if (dryRun) {
    report.afterBytes = original.length
    return report
  }

  const compressed = compressLogText(candidate)
  if (decompressLogBytes(compressed) !== candidate) {
    throw new Error('压缩回环不一致，已放弃写入（原文件未改动）')
  }

  // ② 备份（备份失败就不写）。
  mkdirSync(dirname(file), { recursive: true })
  copyFileSync(file, backupPath)
  if (!readFileSync(backupPath).equals(original)) {
    throw new Error(`备份校验失败（${backupPath}），已放弃写入`)
  }

  const restore = (): boolean => {
    try {
      copyFileSync(backupPath, file)
      const restored = readFileSync(file)
      if (!restored.equals(original)) return false
      report.restored = true
      return true
    } catch {
      return false
    }
  }

  // ③ 原子写。
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, compressed)
    renameSync(tmp, file)
  } catch (error: unknown) {
    rmSync(tmp, { force: true })
    const restored = restore()
    throw new Error(`写入失败（${String((error as Error)?.message ?? error)}）；回滚${restored ? '成功' : '失败，请手工用备份还原'}`)
  }
  report.afterBytes = readFileSync(file).length

  // ④ 写入后回读，再用宿主解析器校验一遍。
  try {
    parser.assertAccepted(decompressLogBytes(readFileSync(file)))
  } catch (error: unknown) {
    rmSync(tmp, { force: true })
    const restored = restore()
    throw new Error(`写入后回读校验失败（${String((error as Error)?.message ?? error)}）；回滚${restored ? '成功' : '失败，请手工用备份还原'}`)
  }
  return report
}

/** 只校验一个文件，不写。 */
export function assertSessionLogFileAccepted(file: string, parser: HostLogParser): { events: number; bytes: number } {
  const bytes = readFileSync(file)
  const text = decompressLogBytes(bytes)
  parser.assertAccepted(text)
  return { events: parseLogText(text).events.length, bytes: bytes.length }
}
