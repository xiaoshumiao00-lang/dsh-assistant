/**
 * 逃生开关（`allowAllLocalPaths`）的**一次性口令**（2026-11-28 手机访问安全整改第 4 项）。
 *
 * 以前的做法是把一个固定字面量写进源码：`confirm !== '<公开常量>'`。
 * 那等于「口令就是代码里的一个词」：任何读过仓库、README、CHANGELOG、构建产物的人
 * 都能直接把这台电脑的目录边界关掉，「要显式确认」这道门槛也就只剩形式。
 *
 * 现在的做法（口径写死在这里）：
 *   1. 口令在运行时生成：`crypto.randomBytes(18)` → base64url（24 个字符，URL 安全，无 `+/=`）；
 *   2. 存在本机数据目录里，**不在源码里、不在构建产物里、不在仓库里**：
 *      `~/.dsh/assistant/escape-hatch.json`（0o600，原子 tmp → rename，同 config.json 的写法）；
 *   3. 只在**本机回环**的设置页面打印出来给用户复制
 *      （`GET /api/assistant/escape-hatch`；非回环来源一律 403，且不回吐口令本体）；
 *   4. 一次性：每次用它成功关掉边界后，立刻换新的（旧口令即刻作废）；
 *   5. 比对用 `timingSafeEqual`（定长缓冲，防止按字符长度/时间侧信道猜口令）。
 *
 * 仍然存在的边界：这道门槛依赖「本机回环」这个判定，判定的真值来自 Host 头与 pocket 代理写的
 * 来源标记（见 assistant-config.ts 的 `requestLoopback` 与 pocket-host/proxy.mjs）。
 * 能把这台电脑上某个进程的 HTTP 请求变成「本机请求」的人，本来就已经是这台电脑上的管理员了。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { assistantHomeDir } from './assistant-home.ts'

/** 口令文件的文件名（与 config.json 同一个目录，同一种权限）。 */
export const ESCAPE_HATCH_FILENAME = 'escape-hatch.json'

/** 存下来的形状：口令本体 + 生成时间 + 最后一次换的时间（时间只用于人类查看，不参与判定）。 */
export interface EscapeHatchRecord {
  token: string
  createdAt: string
  rotatedAt: string
}

type HatchResult = { ok: true; record: EscapeHatchRecord } | { ok: false; error: string }

/** 口令文件的绝对路径（助手家目录）。 */
export function escapeHatchFile(): string {
  return join(assistantHomeDir(), ESCAPE_HATCH_FILENAME)
}

/** 生成一次性随机口令：18 字节随机数 → 24 字符 base64url。每次都是新值，不与任何常量相关。 */
export function createEscapeHatchToken(): string {
  return randomBytes(18).toString('base64url')
}

function parseRecord(raw: string): EscapeHatchRecord | null {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<EscapeHatchRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.token !== 'string' || parsed.token.length < 16) return null
    return { token: parsed.token, createdAt: String(parsed.createdAt ?? ''), rotatedAt: String(parsed.rotatedAt ?? '') }
  } catch {
    return null
  }
}

/** 原子写（与本机配置同一个做法）：先写临时名，再 rename；POSIX 上显式 chmod 600。 */
function writeRecord(record: EscapeHatchRecord): HatchResult {
  const file = escapeHatchFile()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') {
      try {
        chmodSync(tmp, 0o600)
      } catch { /* 有些文件系统（网络盘）不认 chmod：mode 已经在新建时给了 */ }
    }
    renameSync(tmp, file)
    return { ok: true, record }
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* tmp 可能已不存在 */ }
    return { ok: false, error: 'hatch-write-failed: ' + String((err as Error)?.message ?? err) }
  }
}

/** 生成一份新口令并落盘（旧的直接作废）。设置页打印出来的就是这个新值。 */
export function rotateEscapeHatch(): HatchResult {
  const now = new Date().toISOString()
  return writeRecord({ token: createEscapeHatchToken(), createdAt: now, rotatedAt: now })
}

/** 读出口令文件；没有就当场生成一份并落盘（首次使用不需要额外步骤）。 */
export function ensureEscapeHatch(): HatchResult {
  const file = escapeHatchFile()
  let text = ''
  try {
    if (existsSync(file)) text = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, error: 'hatch-unreadable: ' + String((err as Error)?.message ?? err) }
  }
  if (text) {
    const record = parseRecord(text)
    if (record) return { ok: true, record }
    // 文件内容不认（长度不对 / 坏 JSON）：换一份新的，别把坏值一直挂着
  }
  return rotateEscapeHatch()
}

/** 当前口令本体（只有本机回环的调用方该拿它；其它一律不回吐）。 */
export function currentEscapeHatchToken(): string {
  const result = ensureEscapeHatch()
  return result.ok ? result.record.token : ''
}

/**
 * 确认口令是否有效（timing-safe）。
 * 不匹配返回 false；不生成新口令（避免「猜错了就顺手换掉」这种把用户界面搞乱的行为——
 * 换新口令只发生在**成功关闭边界**之后，见 `rotateEscapeHatchAfterUse`）。
 */
export function verifyEscapeHatchConfirm(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const candidate = Buffer.from(value, 'utf8')
  if (candidate.length === 0 || candidate.length > 256) return false
  const result = ensureEscapeHatch()
  if (!result.ok) return false
  const expected = Buffer.from(result.record.token, 'utf8')
  if (expected.length === 0) return false
  // 长度不同也要走完定长比较：先归一到同一长度再比，避免按长度分流出差异
  if (candidate.length !== expected.length) {
    const pad = Buffer.alloc(expected.length)
    timingSafeEqual(pad, expected)
    return false
  }
  try {
    return timingSafeEqual(candidate, expected)
  } catch {
    return false
  }
}

/** 用成功了就换新的（一次性：旧口令即刻作废）。 */
export function rotateEscapeHatchAfterUse(): HatchResult {
  return rotateEscapeHatch()
}

/** 状态摘要（给设置页与诊断用，**不带口令本体**）。 */
export function escapeHatchStatus(): { file: string; exists: boolean; tokenLength: number } {
  const file = escapeHatchFile()
  let exists = false
  try { exists = existsSync(file) } catch { /* 读不到就当没有 */ }
  const record = exists ? parseRecordSafe(file) : null
  return { file, exists: Boolean(record), tokenLength: record?.token.length ?? 0 }
}

function parseRecordSafe(file: string): EscapeHatchRecord | null {
  try {
    return parseRecord(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 测试面：scripts/*.mjs 直接拿这些函数，不必猜路径。 */
export const escapeHatchTestSurface = {
  escapeHatchFile,
  escapeHatchStatus,
  ensureEscapeHatch,
  rotateEscapeHatch,
  createEscapeHatchToken,
  verifyEscapeHatchConfirm,
}
