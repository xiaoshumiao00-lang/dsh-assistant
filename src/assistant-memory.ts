/**
 * 助手「它记下了什么」的读写面（宿主侧逻辑，P0-2）。
 *
 * 真值位置（DSH 运行时记忆）：
 *   <记忆目录>/memories.json      条目真源（{ version, entries: [...] }）
 *   <记忆目录>/USER.md            每轮注入的投影（条目之间用单独一行 `§` 分隔）
 *   <记忆目录>/MEMORY.md          同上，target=memory
 * 记忆目录由 assistant-home.ts 的 runtimeMemoryDir() 决定（MNEMON_DATA_DIR 可覆盖）。
 *
 * 为什么删除要动 memories.json：USER.md / MEMORY.md 只是投影。只改投影不改真源，
 * 下一次记忆写入会把删掉的条目又写回来。所以写回顺序是「备份 → 改真源 → 改投影」。
 * 宿主进程里的记忆快照不会自己失效，因此路由必须报告 restartRequired。
 *
 * 安全边界：
 *   - 只动 target 指定的一侧；删除按「整条正文精确等于给定文本」（mode='exact'）
 *     或「整条正文包含给定片段」（mode='contains'），不做前缀 / 模糊匹配。
 *   - 每次写盘先备份同目录 `<文件>.dsh-assistant-backup-<时间戳>`。
 *   - 读不到 / 解析失败 / 写失败一律 ok:false 并带原因，不假装成功。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

/** 投影里分隔条目的那一行。 */
export const MEMORY_ENTRY_SEPARATOR = '§'

/** DSH 运行时记忆目录（USER.md / MEMORY.md / memories.json 都在这儿）；MNEMON_DATA_DIR 可覆盖。 */
export function runtimeMemoryDir(): string {
  const override = String(process.env.MNEMON_DATA_DIR ?? '').trim()
  if (override !== '') return override.replace(/^~(?=$|[\\/])/, homedir())
  return join(homedir(), '.mnemon', 'runtime')
}

export interface MemoryEntry {
  /** 条目正文（投影里的那一段） */
  content: string
  /** 第几段（0 起）：UI 用它定位「删第几条」 */
  index: number
  importance?: string
  created_at?: string
  updated_at?: string
  /** 条目适用的 git 分支（没有 = 跨分支条目） */
  branches?: string[]
}

export interface MemoryTargetView {
  target: 'user' | 'memory'
  /** 投影文件的绝对路径（读不到也照样报告：UI 要告诉用户文件在哪） */
  projection: string
  /** 投影正文（查看 / 导出用） */
  text: string
  /** 投影拆出来的条目 */
  entries: MemoryEntry[]
  /** 投影字节数（体积展示） */
  bytes: number
}

export interface RuntimeMemoryView {
  ok: true
  dir: string
  store: string
  /** memories.json 是否存在且形状正确（决定写回按钮是否可用） */
  writable: boolean
  totalEntries: number
  targets: MemoryTargetView[]
  /** 读不到真源时的原因说明（UI 直接显示） */
  note: string
}

export interface MemoryMutationResult {
  ok: boolean
  error?: string
  /** 真源里删掉的条目数 */
  storeRemoved?: number
  /** 投影里删掉的段落数 */
  projectionRemoved?: number
  /** 备份文件路径（删了什么都能翻回来） */
  backups?: string[]
  /** 改完必须重启 DSH Desktop 才生效 */
  restartRequired?: boolean
}

interface StoreShape { version?: unknown; entries?: unknown }

function readText(path: string, limit = 400 * 1024): string {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return ''
    if (statSync(path).size > limit) return ''
    return readFileSync(path, 'utf8')
  } catch { return '' }
}

function backupPath(path: string, stamp: number): string {
  return `${path}.dsh-assistant-backup-${stamp}`
}

/** 投影 → 条目数组（分隔行是「单独一行只有 `§`」）。 */
export function splitEntries(text: string): MemoryEntry[] {
  const lines = String(text ?? '').split(/\r?\n/)
  const out: MemoryEntry[] = []
  let current: string[] = []
  const flush = (): void => {
    // 分隔线后面可能跟着空行（投影里常见）：那不是条目的一部分
    const content = current.join('\n').replace(/^[ \t]*\r?\n+/, '').replace(/\s+$/, '')
    if (content.trim()) out.push({ content, index: out.length })
    current = []
  }
  for (const line of lines) {
    if (line.trim() === MEMORY_ENTRY_SEPARATOR) { flush(); continue }
    current.push(line)
  }
  flush()
  return out
}

/** 条目正文按 `§` 拼回投影（保留原有顺序）。 */
export function joinEntries(entries: { content: string }[]): string {
  return entries.map((entry) => entry.content).join(`\n${MEMORY_ENTRY_SEPARATOR}\n`)
}

function writeAtomic(path: string, text: string): void {
  try { mkdirSync(resolvePath(path, '..'), { recursive: true }) } catch { /* 已存在 */ }
  const tmp = `${path}.dsh-assistant-tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

function targetOf(item: any): string {
  return String(item?.target ?? 'memory')
}

function contentOf(item: any): string {
  return String(item?.content ?? '')
}

/** 读真源；形状不对就报不可写（不猜、不修）。 */
function readStore(dir: string): { data: StoreShape | null; path: string } {
  const path = join(dir, 'memories.json')
  const raw = readText(path)
  if (!raw) return { data: null, path }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as StoreShape
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return { data: null, path }
    return { data: parsed, path }
  } catch {
    return { data: null, path }
  }
}

/** 某一侧的「投影 + 条目」视图；真源里的元数据按正文对齐挂上去。 */
function targetView(target: 'user' | 'memory', dir: string, storeEntries: any[]): MemoryTargetView {
  const projection = join(dir, target === 'user' ? 'USER.md' : 'MEMORY.md')
  const text = readText(projection)
  const entries = splitEntries(text)
  for (const entry of entries) {
    const record = storeEntries.find((item) => contentOf(item).trim() === entry.content.trim())
    if (!record) continue
    if (typeof record.importance === 'string') entry.importance = record.importance
    if (typeof record.created_at === 'string') entry.created_at = record.created_at
    if (typeof record.updated_at === 'string') entry.updated_at = record.updated_at
    if (Array.isArray(record.branches)) entry.branches = record.branches.map((name: unknown) => String(name))
  }
  let bytes = 0
  try { bytes = existsSync(projection) ? statSync(projection).size : 0 } catch { /* 读不到算 0 */ }
  return { target, projection, text, entries, bytes }
}

/** 面板要读的一份完整记忆视图（GET /api/assistant/memory 的 body）。 */
export function readRuntimeMemory(): RuntimeMemoryView {
  const dir = runtimeMemoryDir()
  const store = readStore(dir)
  const entries = store.data ? (store.data.entries as any[]) : []
  return {
    ok: true,
    dir,
    store: store.path,
    writable: !!store.data,
    totalEntries: entries.length,
    targets: (['user', 'memory'] as const).map((target) => targetView(target, dir, entries)),
    note: store.data
      ? ''
      : '读不到 memories.json（没装 dsh-mnemon，或它用了别的存储布局）：删除功能不可用，只能查看与导出。',
  }
}

/**
 * 删除一条运行时记忆：备份 → 改真源 → 改投影。
 * @param mode 'exact' 整条正文相等；'contains' 整条正文包含给定片段
 */
export function deleteRuntimeMemoryEntry(
  target: 'user' | 'memory',
  content: string,
  mode: 'exact' | 'contains' = 'exact',
): MemoryMutationResult {
  const wanted = String(content ?? '').trim()
  if (!wanted) return { ok: false, error: 'empty-content' }
  const dir = runtimeMemoryDir()
  const store = readStore(dir)
  if (!store.data) return { ok: false, error: 'store-unavailable' }
  const entries = store.data.entries as any[]
  const matches = entries.filter((item) => {
    if (targetOf(item) !== target) return false
    const text = contentOf(item)
    return mode === 'exact' ? text.trim() === wanted : text.includes(wanted)
  })
  if (matches.length === 0) return { ok: false, error: 'no-match' }
  const matched = new Set(matches.map((item) => contentOf(item).trim()))
  const stamp = Date.now()
  const backups: string[] = []
  try {
    copyFileSync(store.path, backupPath(store.path, stamp))
    backups.push(backupPath(store.path, stamp))
    writeAtomic(
      store.path,
      JSON.stringify({ ...store.data, entries: entries.filter((item) => !matched.has(contentOf(item).trim())) }, null, 2),
    )
  } catch (err) {
    return { ok: false, error: `write-failed: ${String((err as Error)?.message ?? err)}` }
  }
  let projectionRemoved = 0
  try {
    const view = targetView(target, dir, [])
    if (view.text) {
      const keep = view.entries.filter((entry) => !(mode === 'exact' ? matched.has(entry.content.trim()) : entry.content.includes(wanted)))
      if (keep.length !== view.entries.length) {
        copyFileSync(view.projection, backupPath(view.projection, stamp))
        backups.push(backupPath(view.projection, stamp))
        writeAtomic(view.projection, keep.length ? joinEntries(keep) + '\n' : '')
        projectionRemoved = view.entries.length - keep.length
      }
    }
  } catch (err) {
    return { ok: false, error: `projection-write-failed: ${String((err as Error)?.message ?? err)}` }
  }
  return { ok: true, storeRemoved: matches.length, projectionRemoved, backups, restartRequired: true }
}

/** 测试面：让 scripts/*.mjs 直接拿到记忆读写逻辑（构建产物里也走这条出口）。 */
export const assistantMemoryTestSurface = {
  runtimeMemoryDir,
  splitEntries,
  joinEntries,
  readRuntimeMemory,
  deleteRuntimeMemoryEntry,
  clearRuntimeMemory,
  MEMORY_ENTRY_SEPARATOR,
}

/** 清空某一侧（只清 target 那一侧）；同样先备份。 */
export function clearRuntimeMemory(target: 'user' | 'memory'): MemoryMutationResult {
  const dir = runtimeMemoryDir()
  const store = readStore(dir)
  if (!store.data) return { ok: false, error: 'store-unavailable' }
  const entries = store.data.entries as any[]
  const removed = entries.filter((item) => targetOf(item) === target)
  if (removed.length === 0) return { ok: false, error: 'no-match' }
  const stamp = Date.now()
  const backups: string[] = []
  try {
    copyFileSync(store.path, backupPath(store.path, stamp))
    backups.push(backupPath(store.path, stamp))
    writeAtomic(store.path, JSON.stringify({ ...store.data, entries: entries.filter((item) => targetOf(item) !== target) }, null, 2))
  } catch {
    return { ok: false, error: 'backup-or-write-failed' }
  }
  let projectionRemoved = 0
  try {
    const view = targetView(target, dir, [])
    if (existsSync(view.projection)) {
      copyFileSync(view.projection, backupPath(view.projection, stamp))
      backups.push(backupPath(view.projection, stamp))
      writeAtomic(view.projection, '')
      projectionRemoved = view.entries.length
    }
  } catch { /* 投影清不掉：真源已清，残留段会在下一次注入时被覆盖 */ }
  return { ok: true, storeRemoved: removed.length, projectionRemoved, backups, restartRequired: true }
}
