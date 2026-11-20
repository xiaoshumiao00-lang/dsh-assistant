// 手机端个人秘书页：固定一条只读会话；对话/轨迹、主动服务卡片、消息/独立派活。
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { OrbApi } from './orb-api.ts'
import type { OrbKey } from './locales.ts'
import { PathBrowser } from './PathBrowser.tsx'
import { secretaryStore } from './state.ts'

type View = 'chat' | 'trace'
type ComposerMode = 'message' | 'dispatch'

interface SecretaryCard {
  id: string
  role: 'assistant' | 'user'
  title: string
  body: string
  time: string
  seq: number
}

interface TraceRow {
  seq: number
  type: string
  time: string
  text: string
}

interface Parsed {
  cards: SecretaryCard[]
  trace: TraceRow[]
  turns: number
  steps: number
}

function eventTime(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? n * 1000 : n
}

function clockOf(value: unknown): string {
  const ms = eventTime(value)
  if (!ms) return ''
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block: any) => block?.type === 'text' ? String(block?.text ?? '') : '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function messageText(event: any): string {
  const data = event?.data ?? {}
  if (event?.type === 'user/message') return textBlocks(data?.content)
  if (event?.type === 'assistant/message') return textBlocks(data?.message?.content ?? data?.content)
  return ''
}

function titleAndBody(text: string): { title: string; body: string } {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (clean === '') return { title: '更新', body: '' }
  const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length > 1 && lines[0]!.length <= 34) {
    return { title: lines[0]!, body: clean.slice(clean.indexOf(lines[0]!) + lines[0]!.length).trim() }
  }
  return { title: '主动更新', body: clean }
}

function shortJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    if (!text) return ''
    return text.length > 180 ? `${text.slice(0, 180)}…` : text
  } catch {
    return ''
  }
}

function traceText(event: any): string {
  const text = messageText(event)
  if (text !== '') return text.replace(/\s+/g, ' ').slice(0, 180)
  const data = event?.data
  if (data && typeof data === 'object') {
    const name = String((data as any).name ?? (data as any).toolName ?? '')
    if (name) return name
    const command = String((data as any).command ?? '')
    if (command) return command.slice(0, 180)
  }
  return shortJson(data)
}

function parseEvents(raw: unknown): Parsed {
  const events: any[] = Array.isArray(raw) ? raw : []
  const cards: SecretaryCard[] = []
  const trace: TraceRow[] = []
  const turns = new Set<string>()
  const steps = new Set<string>()
  for (const event of events) {
    const type = String(event?.type ?? '')
    const seq = Number(event?.seq ?? 0)
    const data = event?.data ?? {}
    if (type === 'turn/start') turns.add(String(data?.turn ?? seq))
    if (type === 'step/start') steps.add(`${String(data?.turn ?? '')}:${String(data?.step ?? seq)}`)
    if (type !== '') {
      trace.push({
        seq,
        type,
        time: clockOf(event?.time),
        text: traceText(event),
      })
    }
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const text = messageText(event)
    if (text === '') continue
    const parts = titleAndBody(text)
    cards.push({
      id: `${type}:${seq}`,
      role: type === 'user/message' ? 'user' : 'assistant',
      title: type === 'user/message' ? '' : parts.title,
      body: type === 'user/message' ? text : parts.body,
      time: clockOf(event?.time),
      seq,
    })
  }
  return { cards, trace, turns: turns.size, steps: steps.size }
}

function leafName(path: string): string {
  const clean = String(path ?? '').replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() ?? clean
}

export function SecretaryOverlay({ api, t }: { api: OrbApi; t: (key: OrbKey) => string }) {
  const state = useSyncExternalStore(secretaryStore.subscribe, secretaryStore.getSnapshot)
  const [view, setView] = useState<View>('chat')
  const [cards, setCards] = useState<SecretaryCard[]>([])
  const [trace, setTrace] = useState<TraceRow[]>([])
  const [turns, setTurns] = useState(0)
  const [steps, setSteps] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState<ComposerMode>('message')
  const [dispatchCwd, setDispatchCwd] = useState('')
  const [dirOpen, setDirOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  const showToast = useCallback((text: string): void => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { toastTimer.current = null; setToast('') }, 2800)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
  }, [])

  useEffect(() => {
    if (state.open && state.cwd) setDispatchCwd((current) => current || state.cwd)
  }, [state.open, state.cwd])

  const refresh = useCallback(async (): Promise<void> => {
    const sessionId = state.sessionId
    if (!sessionId) return
    setLoading(true)
    try {
      const tail = await api.sessionTail(sessionId, 40, { stream: true })
      const parsed = parseEvents(tail?.events)
      setCards(parsed.cards)
      setTrace(parsed.trace)
      setTurns(parsed.turns)
      setSteps(parsed.steps)
      setError('')
    } catch (err) {
      setError(`读取秘书会话失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [api, state.sessionId])

  useEffect(() => {
    if (!state.open || !state.sessionId) return
    let timer: number | null = null
    const schedule = (): void => {
      if (timer !== null) return
      timer = window.setTimeout(() => { timer = null; void refresh() }, 220)
    }
    void refresh()
    const offSessions = api.subscribeSessions(schedule)
    const interval = window.setInterval(() => { void refresh() }, 4000)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      offSessions()
      window.clearInterval(interval)
    }
  }, [api, refresh, state.open, state.sessionId])

  useEffect(() => {
    setExpanded(new Set())
    setDraft('')
    setMode('message')
    setView('chat')
    setError('')
  }, [state.sessionId])

  useEffect(() => {
    if (!stickToBottom.current) return
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [cards.length, state.open, view])

  const running = Boolean(state.sessionId && api.sessionRow(state.sessionId)?.running)
  const ready = Boolean(state.sessionId && state.readOnly && state.tuoguanOff)
  const canSend = state.sessionId !== '' && (mode === 'dispatch' || ready) && !sending

  const toggleCard = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openDetail = (): void => {
    const id = state.sessionId
    if (!id) return
    secretaryStore.close()
    void api.focusSession(id)
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || !canSend) return
    const sessionId = state.sessionId
    if (!sessionId) return
    setSending(true)
    try {
      if (mode === 'message') {
        const nowRunning = api.sessionRow(sessionId)?.running === true
        await api.prompt(sessionId, [{ type: 'text', text }], nowRunning ? 'steer' : 'queue')
        setDraft('')
        showToast(nowRunning ? '已插话，并入当前这一轮' : '已发给个人秘书')
        window.setTimeout(() => { void refresh() }, 260)
      } else {
        const cwd = dispatchCwd.trim() || state.cwd
        if (cwd === '') throw new Error('没有可用的派活目录')
        const created = await api.createSession(cwd, undefined, { reuseBlank: false })
        const titleLine = titleAndBody(text).title.replace(/^[#*\s]+/, '')
        try { await api.renameSession(created.sessionId, `派活：${titleLine.slice(0, 32)}`) } catch {}
        await api.prompt(created.sessionId, [{ type: 'text', text }], 'queue')
        setDraft('')
        const short = created.sessionId.replace(/^session-/, '').slice(0, 8)
        showToast(`已派给独立会话 ${short}（不是子代理）`)
      }
    } catch (err) {
      showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if ((event.nativeEvent as any)?.isComposing === true) return
    event.preventDefault()
    void send()
  }

  if (!state.open) return null
  const warning = state.warning || (!ready ? '只读或托管状态未确认，消息发送已禁用。' : '')

  return (
    <div data-pocket-secretary="page">
      <div data-pocket-secretary="header">
        <button type="button" data-pocket-secretary="back" aria-label="关闭个人秘书" onClick={() => secretaryStore.close()}>‹</button>
        <div data-pocket-secretary="title">个人秘书</div>
        <span data-pocket-secretary="folder" title={state.cwd || '个人助手工作目录'}>
          📁 {leafName(state.cwd) || 'assistant'}
        </span>
        <span data-pocket-secretary="header-spacer" />
        <span data-pocket-secretary="header-state">{running ? '整理中' : '在线'}</span>
      </div>

      <div data-pocket-secretary="tabs" role="tablist" aria-label="个人秘书视图">
        <button type="button" role="tab" data-pocket-secretary="tab" data-active={view === 'chat' ? '1' : '0'} aria-selected={view === 'chat'} onClick={() => setView('chat')}>对话</button>
        <button type="button" role="tab" data-pocket-secretary="tab" data-active={view === 'trace' ? '1' : '0'} aria-selected={view === 'trace'} onClick={() => setView('trace')}>轨迹</button>
      </div>

      {warning !== '' && <div data-pocket-secretary="warning">⚠ {warning}</div>}

      {view === 'chat' ? (
        <div
          data-pocket-secretary="scroll"
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current
            if (!el) return
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          <div data-pocket-secretary="section-head">
            <span data-pocket-secretary="section-title">主动服务</span>
            <span>{cards.length} 条动态</span>
          </div>
          {loading && cards.length === 0 && <div data-pocket-secretary="loading">正在读取固定会话…</div>}
          {!loading && cards.length === 0 && (
            <div data-pocket-secretary="empty">
              <strong>个人秘书已就位</strong>
              只读固定会话 · 长按悬浮球随时回来
            </div>
          )}
          {error !== '' && cards.length === 0 && <div data-pocket-secretary="empty">{error}</div>}
          {cards.map((card) => {
            const opened = expanded.has(card.id)
            const isAssistant = card.role === 'assistant'
            return (
              <article
                key={card.id}
                data-pocket-secretary="card"
                data-role={card.role}
                role="button"
                tabIndex={0}
                onClick={() => toggleCard(card.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleCard(card.id) }
                }}
              >
                <div data-pocket-secretary="card-head">
                  <span data-pocket-secretary="dot" aria-hidden />
                  <span data-pocket-secretary="who">{isAssistant ? '主动秘书' : '你'}</span>
                  <span data-pocket-secretary="card-title">{card.title}</span>
                </div>
                <div data-pocket-secretary="body" data-clamped={opened ? '0' : '1'}>{card.body}</div>
                <div data-pocket-secretary="card-foot">
                  <span data-pocket-secretary="card-time">{card.time}</span>
                  {isAssistant ? (
                    <button
                      type="button"
                      data-pocket-secretary="card-action"
                      onClick={(event) => { event.stopPropagation(); openDetail() }}
                    >
                      查看详情
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-pocket-secretary="card-action"
                      data-quiet="1"
                      onClick={(event) => { event.stopPropagation(); toggleCard(card.id) }}
                    >
                      {opened ? '收起' : '展开'}
                    </button>
                  )}
                </div>
              </article>
            )
          })}
          <div ref={bottomRef} />
        </div>
      ) : (
        <div data-pocket-secretary="scroll">
          <div data-pocket-secretary="section-head">
            <span data-pocket-secretary="section-title">运行轨迹</span>
            <span>{trace.length} 个事件</span>
          </div>
          {trace.length === 0 ? (
            <div data-pocket-secretary="empty"><strong>还没有轨迹</strong>发一句话给秘书后，这里会显示事件流</div>
          ) : (
            <div data-pocket-secretary="trace">
              {trace.map((row) => (
                <div key={`${row.seq}:${row.type}`} data-pocket-secretary="trace-row">
                  <div data-pocket-secretary="trace-meta">
                    #{row.seq}
                    <span data-pocket-secretary="trace-type" title={row.type}>{row.type}</span>
                    {row.time}
                  </div>
                  <div data-pocket-secretary="trace-text">{row.text || '—'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div data-pocket-secretary="composer">
        {mode === 'dispatch' && (
          <div data-pocket-secretary="dispatch-row">
            <span>派到独立会话：</span>
            <span data-pocket-secretary="dispatch-path" title={dispatchCwd}>{dispatchCwd || '未选择目录'}</span>
            <button type="button" data-pocket-secretary="mini-btn" onClick={() => setDirOpen(true)}>改目录</button>
          </div>
        )}
        <div data-pocket-secretary="modes" role="group" aria-label="发送模式">
          <button
            type="button"
            data-pocket-secretary="mode"
            data-active={mode === 'message' ? '1' : '0'}
            aria-pressed={mode === 'message'}
            onClick={() => setMode('message')}
          >发消息</button>
          <button
            type="button"
            data-pocket-secretary="mode"
            data-active={mode === 'dispatch' ? '1' : '0'}
            aria-pressed={mode === 'dispatch'}
            onClick={() => setMode('dispatch')}
          >派活</button>
        </div>
        <div data-pocket-secretary="input-row">
          <textarea
            data-pocket-secretary="input"
            rows={1}
            value={draft}
            placeholder={mode === 'dispatch' ? '把任务派给独立会话…' : '发消息或创建任务，/ 调用指令，@ 文件'}
            onChange={(event) => {
              setDraft(event.target.value)
              const el = event.target
              el.style.height = 'auto'
              el.style.height = `${Math.min(112, el.scrollHeight)}px`
            }}
            onKeyDown={onKeyDown}
          />
          <button type="button" data-pocket-secretary="send" aria-label="发送" disabled={!canSend || draft.trim() === ''} onClick={() => { void send() }}>↑</button>
        </div>
      </div>

      <div data-pocket-secretary="statusbar">
        <span data-pocket-secretary={state.readOnly ? 'status-good' : 'status-warn'}>{state.readOnly ? '只读' : '只读未确认'}</span>
        <span data-pocket-secretary={state.tuoguanOff ? 'status-good' : 'status-warn'}>{state.tuoguanOff ? '托管关闭' : '托管未确认'}</span>
        <span>{turns} 轮 {steps} 步</span>
        <span>最近 40 条</span>
      </div>


      {toast !== '' && <div data-pocket-secretary="toast">{toast}</div>}

      {dirOpen && (
        <PathBrowser
          mode="dir"
          api={api}
          startPath={dispatchCwd || state.cwd}
          t={t}
          onPick={() => {}}
          onPickDir={(path) => { setDispatchCwd(path); setDirOpen(false) }}
          onClose={() => setDirOpen(false)}
        />
      )}
    </div>
  )
}
