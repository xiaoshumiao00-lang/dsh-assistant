// 手机端个人秘书页：固定一条只读会话。
// 输入区**不再自制**：直接复用 pocket 页面已有的 Composer（同一个 ＋ 附件菜单、模型选择、
// 语音、发送键），底部状态行也只用宿主投影里的真实统计（轮次 · tok/s · 总 token · 缓存命中 · 上下文占用）。
// 派活不再有模式开关/目录行：发出去的活由 secretary-dispatch 规则自动判断落到哪个目录。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { OrbApi, OrbModel, OrbSessionStats } from './orb-api.ts'
import type { OrbKey } from './locales.ts'
import { Composer } from './Composer.tsx'
import type { OrbChip, OrbVoiceBridge, SlashItem } from './Composer.tsx'
import { PathBrowser } from './PathBrowser.tsx'
import { readLastBackgroundModel, secretaryStore } from './state.ts'
import { voiceBlocked } from './voice.ts'
import { ensureSecretaryGate, peekAssistantHome } from '../../assistant-entry.ts'
import { decideDispatchTarget, projectsFromSessions } from '../../secretary-dispatch.ts'

type View = 'chat' | 'trace'

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
      trace.push({ seq, type, time: clockOf(event?.time), text: traceText(event) })
    }
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

/** 数字缩写：1234 → 1.2k，1234567 → 1.2M（与官方统计口径同一档）。 */
function shortNumber(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`
  return `${Math.round(value / 100_000) / 10}M`
}

/** 底部状态行的文案：只显示真实已知的指标，未知就整段不出现（不写“未知”）。 */
function statsLine(stats: OrbSessionStats | null): string {
  if (stats === null) return ''
  const parts: string[] = []
  if (stats.turns !== null && stats.steps !== null) parts.push(`${stats.turns} 轮 ${stats.steps} 步`)
  else if (stats.turns !== null) parts.push(`${stats.turns} 轮`)
  if (stats.tokPerSec !== null && stats.tokPerSec > 0) parts.push(`${stats.tokPerSec.toFixed(1)} tok/s`)
  if (stats.totalTokens !== null) parts.push(`总 ${shortNumber(stats.totalTokens)} tok`)
  if (stats.cacheHitPercent !== null) parts.push(`缓存命中 ${stats.cacheHitPercent}%`)
  if (stats.contextPercent !== null) parts.push(`上下文占用 ${stats.contextPercent}%`)
  return parts.join(' · ')
}

/** 统计快照浅比较：数值没变就不换引用，避免每 2s 让整页重渲染一次。 */
function sameStats(a: OrbSessionStats | null, b: OrbSessionStats | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.turns === b.turns
    && a.steps === b.steps
    && a.tokPerSec === b.tokPerSec
    && a.totalTokens === b.totalTokens
    && a.cacheHitPercent === b.cacheHitPercent
    && a.contextPercent === b.contextPercent
}

export function SecretaryOverlay({ api, t }: { api: OrbApi; t: (key: OrbKey) => string }) {
  const state = useSyncExternalStore(secretaryStore.subscribe, secretaryStore.getSnapshot)
  const [view, setView] = useState<View>('chat')
  const [cards, setCards] = useState<SecretaryCard[]>([])
  const [trace, setTrace] = useState<TraceRow[]>([])
  const [turns, setTurns] = useState(0)
  const [steps, setSteps] = useState(0)
  const [stats, setStats] = useState<OrbSessionStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [chips, setChips] = useState<OrbChip[]>([])
  const [sending, setSending] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState('')
  const [models, setModels] = useState<OrbModel[]>([])
  const [modelSel, setModelSel] = useState<{ provider: string; model: string; name: string } | null>(null)
  const [bgModelLabel, setBgModelLabel] = useState('')
  const [commands, setCommands] = useState<{ name: string; description: string }[]>([])
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [speechReady, setSpeechReady] = useState(false)
  const [voiceMaxSeconds, setVoiceMaxSeconds] = useState(60)
  const [browser, setBrowser] = useState<null | 'file'>(null)
  const toastTimer = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  const sessionId = state.sessionId

  const showToast = useCallback((text: string): void => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { toastTimer.current = null; setToast('') }, 3200)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
  }, [])

  /** 会话尾部 → 卡片/轨迹 + 真实统计（统计取宿主投影，不从事件里估）。 */
  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId) return
    setLoading(true)
    try {
      const tail = await api.sessionTail(sessionId, 40, { stream: false })
      const parsed = parseEvents(tail?.events)
      setCards(parsed.cards)
      setTrace(parsed.trace)
      setTurns(parsed.turns)
      setSteps(parsed.steps)
      setStats(api.sessionStats(sessionId))
      setError('')
    } catch (err) {
      setError(`读取秘书会话失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [api, sessionId])

  useEffect(() => {
    if (!state.open || !sessionId) return
    let timer: number | null = null
    const schedule = (): void => {
      if (timer !== null) return
      timer = window.setTimeout(() => { timer = null; void refresh() }, 220)
    }
    void refresh()
    const offSessions = api.subscribeSessions(schedule)
    // 统计行单独按 2s 刷新：它读的是投影快照，很便宜；引用不变就不触发重渲染。
    const statsTimer = window.setInterval(() => {
      const next = api.sessionStats(sessionId)
      setStats((cur) => (sameStats(cur, next) ? cur : next))
    }, 2000)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      offSessions()
      window.clearInterval(statsTimer)
    }
  }, [api, refresh, state.open, sessionId])

  // 模型目录 / 命令 / 技能：进页面各拉一次（同一份宿主目录，和桌面模型选择一致）。
  useEffect(() => {
    if (!state.open) return
    let live = true
    void api.modelCatalog().then((catalog) => {
      if (!live) return
      setModels(catalog.models)
      const row = sessionId ? api.sessionRow(sessionId) : null
      const sel = row?.modelSelection?.next ?? row?.modelSelection?.lastUsed ?? null
      if (sel !== null) {
        const name = catalog.models.find((m) => m.provider === sel.provider && m.model === sel.model)?.name ?? sel.model
        setModelSel({ provider: sel.provider, model: sel.model, name })
      } else if (catalog.models.length > 0) {
        const fallback = catalog.models.find((m) => m.provider === catalog.default?.provider && m.model === catalog.default?.model)
        if (fallback) setModelSel({ provider: fallback.provider, model: fallback.model, name: fallback.name })
      }
    }).catch(() => { /* 目录不可用 → 胶囊显示默认文案 */ })
    setBgModelLabel(readLastBackgroundModel()?.name ?? '')
    setSpeechReady(api.speechAvailable())
    return () => { live = false }
  }, [api, sessionId, state.open])

  useEffect(() => {
    if (!state.open || !sessionId) return
    let live = true
    void api.commandList(sessionId).then((list) => { if (live) setCommands(list.map((c) => ({ name: c.name, description: c.description }))) }).catch(() => {})
    void api.skillList(sessionId).then((list) => { if (live) setSkills(list.map((s) => ({ name: s.name, description: s.description }))) }).catch(() => {})
    return () => { live = false }
  }, [api, sessionId, state.open])

  useEffect(() => {
    if (!speechReady) return
    let alive = true
    void api.speechMaxSeconds().then(
      (seconds) => { if (alive) setVoiceMaxSeconds(seconds) },
      () => undefined,
    )
    return () => { alive = false }
  }, [api, speechReady])

  useEffect(() => {
    setExpanded(new Set())
    setDraft('')
    setChips([])
    setView('chat')
    setError('')
  }, [sessionId])

  useEffect(() => {
    if (!stickToBottom.current) return
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [cards.length, state.open, view])

  const running = Boolean(sessionId && api.sessionRow(sessionId)?.running)

  const voiceBlockedReason = useMemo(() => voiceBlocked(), [])
  const voice = useMemo<OrbVoiceBridge>(() => ({
    available: speechReady,
    blocked: voiceBlockedReason,
    maxSeconds: voiceMaxSeconds,
    transcribe: (audioBase64: string) => api.transcribe(audioBase64),
  }), [api, speechReady, voiceBlockedReason, voiceMaxSeconds])

  const slashItems = useMemo<SlashItem[]>(() => [
    ...commands.map((c) => ({ name: c.name, description: c.description, kind: 'command' as const })),
    ...skills.map((s) => ({ name: s.name, description: '', kind: 'skill' as const })),
  ], [commands, skills])

  const toggleCard = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openDetail = (): void => {
    if (!sessionId) return
    secretaryStore.close()
    void api.focusSession(sessionId)
  }

  /** 派活用的人项目录候选：会话列表按目录归并（排除助手目录本身）。 */
  const dispatchProjects = useCallback(() => {
    const rows = api.listSessions()
    const home = (state.cwd || peekAssistantHome()).trim()
    return projectsFromSessions(rows.map((row) => ({
      cwd: row.cwd,
      title: row.title,
      updatedAt: row.updatedAt,
    })), home ? [home] : [])
  }, [api, state.cwd])

  /**
   * 发送：先过只读/托管闸（只有真发消息时才拦），再按规则判断是"聊天"还是"派活"。
   * 派活的目录由 secretary-dispatch 的三条规则自动选，不再有模式按钮和目录行。
   */
  const send = async (textOverride?: string): Promise<void> => {
    const text = String(textOverride ?? draft).trim()
    if (text === '') return
    if (!sessionId) {
      showToast('秘书会话还没就绪，稍等一下再发')
      return
    }
    setSending(true)
    try {
      // 附件消息一律发给秘书本人（附件是给它看的上下文，不派活）
      const decision = chips.length === 0
        ? decideDispatchTarget({
          text,
          projects: dispatchProjects(),
          assistantHome: state.cwd || peekAssistantHome(),
        })
        : { kind: 'chat' as const, cwd: '', reason: '' }

      if (decision.kind !== 'chat') {
        const created = await api.dispatchTask({
          text,
          cwd: decision.cwd,
          title: `派活：${titleAndBody(text).title.replace(/^[#*\s]+/, '').slice(0, 28)}`,
          createFolder: decision.kind === 'new-folder',
        })
        setDraft('')
        showToast(`已自动派活 → ${leafName(created.cwd)}（${decision.reason}）`)
        return
      }

      const gate = await ensureSecretaryGate(sessionId)
      if (!gate.ok) {
        showToast(gate.reason)
        return
      }
      await api.prompt(sessionId, [{ type: 'text', text }], running ? 'steer' : 'queue')
      setDraft('')
      setChips([])
      showToast(running ? '已插话，并入当前这一轮' : '已发给个人秘书')
      window.setTimeout(() => { void refresh() }, 260)
    } catch (err) {
      showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSending(false)
    }
  }

  const onPickModel = async (model: OrbModel): Promise<void> => {
    setModelSel({ provider: model.provider, model: model.model, name: model.name })
    if (!sessionId) return
    try {
      await api.selectModel(sessionId, { provider: model.provider, model: model.model })
    } catch (err) {
      showToast(`模型切换失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onPickBackgroundModel = async (model: OrbModel): Promise<void> => {
    setBgModelLabel(model.name)
    try {
      await api.selectBackgroundModel({ provider: model.provider, model: model.model })
      showToast(`后台任务模型：${model.name}`)
    } catch (err) {
      showToast(`后台任务模型设置失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!state.open) return null

  const line = statsLine(stats)
  const permissionLabel = sessionId ? api.permissionLabel(sessionId) : ''
  const skeleton = !sessionId || (loading && cards.length === 0)

  return (
    <div data-pocket-secretary="page">
      <div data-pocket-secretary="header">
        <button type="button" data-pocket-secretary="back" aria-label="关闭个人秘书" onClick={() => secretaryStore.close()}>‹</button>
        <div data-pocket-secretary="title">个人秘书</div>
        <span data-pocket-secretary="folder" title={state.cwd || '个人助手工作目录'}>
          📁 {leafName(state.cwd) || 'assistant'}
        </span>
        <span data-pocket-secretary="header-spacer" />
        {permissionLabel !== '' && <span data-pocket-secretary="header-pill" data-tone="calm">{permissionLabel}</span>}
        <span data-pocket-secretary="header-pill" data-tone={state.tuoguanOff ? 'calm' : 'busy'}>
          {state.tuoguanOff ? '托管关' : '托管开'}
        </span>
        <span data-pocket-secretary="header-state">{running ? '整理中' : '在线'}</span>
      </div>

      <div data-pocket-secretary="tabs" role="tablist" aria-label="个人秘书视图">
        <button type="button" role="tab" data-pocket-secretary="tab" data-active={view === 'chat' ? '1' : '0'} aria-selected={view === 'chat'} onClick={() => setView('chat')}>对话</button>
        <button type="button" role="tab" data-pocket-secretary="tab" data-active={view === 'trace' ? '1' : '0'} aria-selected={view === 'trace'} onClick={() => setView('trace')}>轨迹</button>
      </div>

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
          {skeleton && <div data-pocket-secretary="skeleton" aria-hidden><i /><i /><i /></div>}
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

      {/* 输入区：直接复用 pocket 页面已有的 Composer（＋ 附件菜单 / 模型 / 语音 / 发送）。 */}
      <div data-pocket-secretary="composer">
        <Composer
          value={draft}
          onChange={setDraft}
          chips={chips}
          onAddChips={(added) => setChips((cur) => [...cur, ...added])}
          onRemoveChip={(index) => setChips((cur) => cur.filter((_, i) => i !== index))}
          onSend={() => { void send() }}
          onSendText={(text) => { void send(text) }}
          sending={sending}
          slashItems={slashItems}
          onPickSlash={(item) => setDraft(`/${item.name} `)}
          models={models}
          modelLabel={modelSel?.name ?? t('model')}
          onPickModel={(model) => { void onPickModel(model) }}
          backgroundModelLabel={bgModelLabel || t('backgroundModel')}
          onPickBackgroundModel={(model) => { void onPickBackgroundModel(model) }}
          onOpenPcFiles={() => setBrowser('file')}
          voice={voice}
          toast={showToast}
          t={t}
          disabled={!sessionId}
        />
      </div>

      {/* 底部状态行：宿主投影里的真实统计（轮次 · tok/s · 总 token · 缓存命中 · 上下文占用）。 */}
      <div data-pocket-secretary="statusbar" data-state={line === '' ? 'empty' : 'ready'}>
        {line !== '' ? line : (turns > 0 ? `${turns} 轮 ${steps} 步` : '还没有统计')}
      </div>

      {toast !== '' && <div data-pocket-secretary="toast">{toast}</div>}

      {browser !== null && (
        <PathBrowser
          mode="file"
          api={api}
          startPath={state.cwd || ''}
          t={t}
          onPick={(entry) => {
            setChips((cur) => [...cur, { kind: 'pc-file', name: entry.name, path: entry.path }])
            setBrowser(null)
          }}
          onPickDir={() => {}}
          onClose={() => setBrowser(null)}
        />
      )}
    </div>
  )
}
