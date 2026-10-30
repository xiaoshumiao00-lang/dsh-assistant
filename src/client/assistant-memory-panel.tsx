/**
 * 「它记下了什么」面板（P0-2）。
 *
 * 读：GET /api/assistant/memory（USER.md / MEMORY.md 条目 + 能不能删）、GET /api/assistant/home（家目录体积与文件清单）
 * 写回：POST /api/assistant/memory-entry-delete / memory-clear —— 这两条改的是宿主进程负责的记忆文件，
 *       **必须重启 DSH Desktop 才生效**，面板上写清楚，不偷偷刷新。
 *
 * 为什么插件自己不做「实时刷新记忆」：记忆快照在 DSH 的 dsh-mnemon 插件里，删完它自己那份
 * 内存副本还留着，下一次写入会把投影文件又写回去。所以这里只报告 restartRequired。
 */
import { useCallback, useEffect, useState } from 'react'
import { copyTextToClipboard } from './clipboard.ts'
import { downloadText } from './download.ts'

type MemoryEntry = {
  content: string
  index: number
  importance?: string
  created_at?: string
  updated_at?: string
  branches?: string[]
}

type MemoryTarget = {
  target: 'user' | 'memory'
  projection: string
  text: string
  entries: MemoryEntry[]
  bytes: number
}

type MemoryView = {
  ok: boolean
  dir: string
  store: string
  writable: boolean
  totalEntries: number
  targets: MemoryTarget[]
  note?: string
  error?: string
  /** AGENTS.md 正文（人在这个目录里的固定人设） */
  agents?: string
}

type HomeView = {
  ok: boolean
  dir: string
  usage: {
    totalBytes: number
    journalBytes: number
    journalFiles: number
    notesBytes: number
    notesFiles: number
    outputsBytes: number
    outputsFiles: number
    archiveBytes: number
    archiveFiles: number
    limits: {
      outputsRetentionDays: number
      journalArchiveAfterDays: number
      journalMaxFiles: number
      noteTotalBytesLimit: number
      archiveSoftBytesLimit: number
    }
    capsReached: { journalOverMax: boolean; notesOverBytes: boolean; archiveOverSoft: boolean }
  }
  files: Record<string, { name: string; bytes: number; mtimeMs: number }[]>
}

const card: Record<string, any> = {
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
  borderRadius: 12, padding: '12px 14px', marginBottom: 10,
}
const rowStyle: Record<string, any> = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }
const title: Record<string, any> = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' }
const desc: Record<string, any> = { fontSize: 12, lineHeight: 1.5, margin: '3px 0 0', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' }
const errText: Record<string, any> = { fontSize: 12, lineHeight: 1.5, margin: '6px 0 0', color: 'var(--dsw-alias-state-danger, #e5484d)' }
const okText: Record<string, any> = { fontSize: 12, lineHeight: 1.5, margin: '6px 0 0', color: 'var(--dsw-alias-state-success-primary, #2e9e6b)' }
const btn: Record<string, any> = {
  border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, #fff)',
  color: 'inherit', font: 'inherit', fontSize: 12, padding: '5px 9px', cursor: 'pointer',
}
const entryBox: Record<string, any> = {
  border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))', borderRadius: 10,
  padding: '8px 10px', margin: '8px 0 0', fontSize: 12, lineHeight: 1.55,
  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
const entryHead: Record<string, any> = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }

function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 浏览器里下载一个文本文件（导出 .md / AGENTS.md）：见 src/client/download.ts */

export function AssistantMemoryPanel(): JSX.Element {
  const [memory, setMemory] = useState<MemoryView | null>(null)
  const [home, setHome] = useState<HomeView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  /** 删除是「先问一句」：按一次标记，再按一次才发请求 */
  const [pendingDelete, setPendingDelete] = useState<string>('')
  const [pendingClear, setPendingClear] = useState<string>('')

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setFailure('')
    try {
      const [memoryRes, homeRes] = await Promise.all([
        fetch('/api/assistant/memory', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`memory ${r.status}`)))),
        fetch('/api/assistant/home', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`home ${r.status}`)))),
      ])
      setMemory(memoryRes as MemoryView)
      setHome(homeRes as HomeView)
    } catch (err: any) {
        setLoadError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const post = useCallback(async (path: string, body: unknown): Promise<void> => {
    setBusy(true)
    setFailure('')
    setMessage('')
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) {
        setFailure(`${data?.error ?? res.status}：没删掉，什么都没动（真源与投影都留在原位）。`)
        return
      }
      const removed = Number(data?.storeRemoved ?? 0)
      const backups = Array.isArray(data?.backups) ? data.backups.length : 0
      setMessage(`已删掉 ${removed} 条${backups ? `，删之前备份了 ${backups} 个文件` : ''}。`
        + `${data?.restartRequired ? ' 重启 DSH Desktop 才看得到效果（宿主进程内的记忆快照不会自己失效）。' : ''}`)
      await load()
    } catch (err: any) {
      setFailure(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [load])

  const usage = home?.usage
  const targets = memory?.targets ?? []

  return (
    <div>
      <div style={card}>
        <div style={rowStyle}>
          <div>
            <div style={title}>🧠 它记下了什么</div>
            <p style={desc}>
              USER.md = 他是谁、偏好、雷区。MEMORY.md = 项目与环境的硬事实。
              下面按条目列出来，可以删某一条，也可以整侧清空；每次写回都会先备份。
            </p>
          </div>
          <button type="button" style={btn} onClick={() => { void load() }} disabled={busy}>{busy ? '读取中…' : '刷新'}</button>
        </div>
        {loadError ? <p style={errText}>读不到记忆面板数据：{loadError}（旧宿主没提供这些路由，重启 DSH Desktop 后才会出现。）</p> : null}
        {memory && !memory.writable ? <p style={errText}>{memory.note}</p> : null}
        {failure ? <p style={errText}>{failure}</p> : null}
        {message ? <p style={okText}>{message}</p> : null}
      </div>

      {targets.map((target) => {
        const label = target.target === 'user' ? 'USER.md（他是谁）' : 'MEMORY.md（硬事实）'
        return (
          <div style={card} key={target.target}>
            <div style={rowStyle}>
              <div>
                <div style={title}>{label}</div>
                <p style={desc}>{target.entries.length} 条 · {bytes(target.bytes)} · {target.projection}</p>
              </div>
              <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
                <button type="button" style={btn} onClick={() => { void copyTextToClipboard(target.text) }}>复制</button>
                <button type="button" style={btn} onClick={() => downloadText(target.target === 'user' ? 'USER.md' : 'MEMORY.md', target.text)}>导出 .md</button>
                <button
                  type="button"
                  style={{ ...btn, ...(pendingClear === target.target ? { borderColor: 'var(--dsw-alias-state-danger, #e5484d)', color: 'var(--dsw-alias-state-danger, #e5484d)' } : {}) }}
                  disabled={busy || !memory?.writable}
                  onClick={() => {
                    if (pendingClear !== target.target) { setPendingClear(target.target); return }
                    setPendingClear('')
                    void post('/api/assistant/memory-clear', { target: target.target, confirm: 'DELETE-ALL' })
                  }}
                >
                  {pendingClear === target.target ? '再点一次确认清空' : '清空这一侧'}
                </button>
              </span>
            </div>
            {target.entries.length === 0 ? (
              <p style={desc}>这一侧还没有条目。</p>
            ) : (
              target.entries.map((entry) => (
                <div style={entryBox} key={`${target.target}-${entry.index}`}>
                  <div style={entryHead}>
                    <span style={desc}>
                      {entry.importance ? `[${entry.importance}]` : ''}
                      {entry.branches?.length ? ` 分支：${entry.branches.join(', ')}` : ''}
                      {entry.updated_at ? ` 改于 ${entry.updated_at.slice(0, 10)}` : ''}
                    </span>
                    <button
                      type="button"
                      style={{ ...btn, ...(pendingDelete === `${target.target}-${entry.index}` ? { borderColor: 'var(--dsw-alias-state-danger, #e5484d)', color: 'var(--dsw-alias-state-danger, #e5484d)' } : {}) }}
                      disabled={busy || !memory?.writable}
                      onClick={() => {
                        const key = `${target.target}-${entry.index}`
                        if (pendingDelete !== key) { setPendingDelete(key); return }
                        setPendingDelete('')
                        void post('/api/assistant/memory-entry-delete', { target: target.target, content: entry.content, mode: 'exact' })
                      }}
                    >
                      {pendingDelete === `${target.target}-${entry.index}` ? '再点一次确认删除' : '删除'}
                    </button>
                  </div>
                  <div>{entry.content}</div>
                </div>
              ))
            )}
          </div>
        )
      })}

      <div style={card}>
        <div style={rowStyle}>
          <div>
            <div style={title}>📁 助手目录</div>
            <p style={desc}>{home?.dir ?? '（读不到）'}</p>
          </div>
          <button type="button" style={btn} onClick={() => downloadText('AGENTS.md', memory?.agents ?? '')}>导出 AGENTS.md</button>
        </div>
        {usage ? (
          <>
            <p style={desc}>
              journal/ {usage.journalFiles} 份 · {bytes(usage.journalBytes)}（超 {usage.limits.journalArchiveAfterDays} 天的自动搬进 archive/）<br />
              notes/ {usage.notesFiles} 份 · {bytes(usage.notesBytes)}（上限 {bytes(usage.limits.noteTotalBytesLimit)}）<br />
              outputs/ {usage.outputsFiles} 份 · {bytes(usage.outputsBytes)}（超 {usage.limits.outputsRetentionDays} 天自动删）<br />
              archive/ {usage.archiveFiles} 份 · {bytes(usage.archiveBytes)}（插件只搬不删）
            </p>
            {usage.capsReached.journalOverMax || usage.capsReached.notesOverBytes || usage.capsReached.archiveOverSoft ? (
              <p style={errText}>
                容量到了：
                {usage.capsReached.journalOverMax ? ` journal 超过 ${usage.limits.journalMaxFiles} 份；` : ''}
                {usage.capsReached.notesOverBytes ? ' notes 超过总体积上限；' : ''}
                {usage.capsReached.archiveOverSoft ? ` archive 已 ${bytes(usage.archiveBytes)}，插件不再自动搬，得你自己清。` : ''}
              </p>
            ) : null}
          </>
        ) : null}
        <p style={desc}>
          journal/notes 的容量策略（v0.2.11）：超出即**归档**——搬进 archive/ 而不是删掉；
          只有 outputs/（杂物间）会自动删。
        </p>
      </div>
    </div>
  )
}
