/**
 * 鹈鹕任务台账落盘（跨重启记住完成历史）。
 *
 * 为什么单独一个文件：`task-ledger.ts` 是纯逻辑（不读文件、不认识 TihuDevice），
 * 单测可以拨表；文件 IO、路径、防抖全部收在这里，登记簿只通过 `onChange` 说一句「该存了」。
 *
 * 路径（与 lane.log / preroll 同一个目录）：
 *   `$TIHU_TASK_LEDGER_FILE` → `$DSH_HOME/tihu/task-ledger.json` → `~/.dsh/tihu/task-ledger.json`
 *
 * 写法（沿用仓库现有状态文件）：
 *   `<file>.<pid>.tmp`（0600）→ `rename` 原子替换。读者永远只会看到完整文件，
 *   进程被杀也不会留下半截 JSON。读不出来（缺文件 / 半截 / 旧版本）一律当没有——
 *   宁可丢一次历史，也不把脏状态带进棋盘。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LEDGER_SNAPSHOT_VERSION, type LedgerSnapshot } from './task-ledger.ts'

/** 文件名（放 `~/.dsh/tihu/` 下）。 */
export const TIHU_LEDGER_FILENAME = 'task-ledger.json'

/** 落盘路径：环境变量（单测/排查）→ `$DSH_HOME/tihu` → `~/.dsh/tihu`。 */
export function tihuLedgerPath(): string {
  const override = String(process.env.TIHU_TASK_LEDGER_FILE ?? '').trim()
  if (override !== '') return override
  const dshHome = String(process.env.DSH_HOME ?? '').trim()
  return join(dshHome !== '' ? dshHome : join(homedir(), '.dsh'), 'tihu', TIHU_LEDGER_FILENAME)
}

/**
 * 解析落盘文本：只认当前版本 ＋ 非空任务数组。
 * 任何异常都返回 undefined（调用方按「没有历史」处理），绝不 throw 到启动路径。
 */
export function parseLedgerSnapshot(text: unknown): LedgerSnapshot | undefined {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const value = parsed as Record<string, unknown>
  if (Number(value.v) !== LEDGER_SNAPSHOT_VERSION) return undefined
  if (!Array.isArray(value.tasks)) return undefined
  const savedAt = Number(value.savedAt)
  return {
    v: LEDGER_SNAPSHOT_VERSION,
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0,
    tasks: value.tasks as LedgerSnapshot['tasks'],
  }
}

/** 读落盘快照：缺文件 / 坏文件都返回 undefined（不抛错）。 */
export function readLedgerSnapshot(file = tihuLedgerPath()): LedgerSnapshot | undefined {
  try {
    return parseLedgerSnapshot(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 原子写：tmp + rename。失败只返回 false（绝不把异常抛给棋盘/事件处理）。
 * 目录不存在就建（`~/.dsh/tihu/` 通常已由 lane.log 建好）。
 */
export function writeLedgerSnapshot(snapshot: LedgerSnapshot, file = tihuLedgerPath()): boolean {
  const temporary = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
    return true
  } catch {
    try {
      unlinkSync(temporary)
    } catch { /* 临时文件可能根本没建出来 */ }
    return false
  }
}

export interface TaskLedgerStoreOptions {
  /** 落盘路径（缺省 {@link tihuLedgerPath}）。 */
  file?: string
  /** 写盘那一刻才取快照（保证写的是最新状态）。 */
  snapshot: () => LedgerSnapshot
  /** 防抖窗口（毫秒）：一串连续状态变化只写一次盘。 */
  delayMs?: number
  /** 失败/坏文件的通知口（lane 接到自己的日志）。 */
  onError?: (message: string) => void
}

/**
 * 台账的落盘口：状态变化 → `schedule()` 防抖 → `flush()` 原子写。
 *
 * 三条纪律：
 *   - 写失败只记一条日志，不影响登记簿与屏；
 *   - 读出来的坏文件直接忽略（下次写盘会整体替换）；
 *   - `flush()` 同步完成：卸载 / 进程退出时调用，防抖没到点也不丢。
 */
export class TaskLedgerStore {
  private readonly file: string
  private readonly snapshot: () => LedgerSnapshot
  private readonly delayMs: number
  private readonly onError?: (message: string) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 上次写盘是否成功（诊断/测试用）。 */
  private lastWriteOk = true

  constructor(options: TaskLedgerStoreOptions) {
    this.file = options.file ?? tihuLedgerPath()
    this.snapshot = options.snapshot
    this.delayMs = Math.max(0, Math.trunc(options.delayMs ?? 250))
    this.onError = options.onError
  }

  path(): string {
    return this.file
  }

  lastWriteSucceeded(): boolean {
    return this.lastWriteOk
  }

  /**
   * 读历史：文件不存在 → undefined；存在但读不懂 → 记一条日志后 undefined。
   * 注意不在读的时候删除坏文件：留着给人排查，下一次正常写盘会覆盖它。
   */
  load(): LedgerSnapshot | undefined {
    let text = ''
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return undefined
    }
    if (text.trim() === '') return undefined
    const snapshot = parseLedgerSnapshot(text)
    if (snapshot === undefined) {
      this.onError?.(`tihu ledger unreadable, ignored: ${this.file}`)
      return undefined
    }
    return snapshot
  }

  /** 状态变了：合并成一次写盘（定时器 unref，不拖住宿主退出）。 */
  schedule(): void {
    if (this.timer !== undefined) return
    const timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.delayMs) as unknown as { unref?: () => void }
    timer.unref?.()
    this.timer = timer as unknown as ReturnType<typeof setTimeout>
  }

  /** 立刻写一次（同步）；返回是否成功。 */
  flush(): boolean {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    let snapshot: LedgerSnapshot
    try {
      snapshot = this.snapshot()
    } catch (error) {
      this.lastWriteOk = false
      this.onError?.(`tihu ledger snapshot failed: ${(error as Error)?.message ?? String(error)}`)
      return false
    }
    this.lastWriteOk = writeLedgerSnapshot(snapshot, this.file)
    if (!this.lastWriteOk) this.onError?.(`tihu ledger write failed: ${this.file}`)
    return this.lastWriteOk
  }

  /** 卸载：清定时器 + 最后写一次（任务状态不能因为卸载丢最后几条）。 */
  dispose(): void {
    this.flush()
  }
}
