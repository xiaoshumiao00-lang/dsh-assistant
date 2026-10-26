// 悬浮球主页面（全屏）：会话历史 + 目标（新会话/会话）+ 输入区。
// 发送语义与桌面悬浮球一致：新会话 → 电脑上创建会话并执行；已有会话 → 追加指令。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { controlRoomStore, nativeBallStore } from '../../orb-bridge.ts'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react'
import { Composer } from './Composer.tsx'
import type { OrbChip, OrbVoiceBridge, SlashItem } from './Composer.tsx'
import { voiceBlocked } from './voice.ts'
import { PathBrowser } from './PathBrowser.tsx'
import { arm as armClickGuard } from './click-guard.ts'
import type { OrbApi, OrbCommand, OrbModel, OrbSessionRow, OrbSkill } from './orb-api.ts'
import type { OrbKey } from './locales.ts'
import { orbStore, clearLastModel, readLastBall, readLastCwd, readLastModel, readLastBackgroundModel, readLastPreset, readLastTargetId, writeLastBall, writeLastCwd, writeLastModel, writeLastBackgroundModel, writeLastPreset, writeLastTargetId } from './state.ts'
import { noteOpenSession, noteOrbSwallow } from './diag.ts'
import { isStandardPreset, presetKey, sessionModel, templateFromSession } from './session-plan.ts'
import type { BallPoint } from './state.ts'

type Target = { kind: 'new' } | { kind: 'session'; id: string }

/** 悬浮球新会话的默认预设（dsh-orb 的桌面 GUI 模式）。选过会话后改为沿用那条会话的模式。 */
const ORB_AGENT_PRESET = 'computer-use'

const isSlashCommand = (text: string): boolean => /^\/[a-z][a-z0-9_-]*(\s|$)/i.test(text.trim())

function fmtWhen(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ms).toLocaleDateString()
}

export interface OrbOverlayProps {
  api: OrbApi
  t: (key: OrbKey) => string
}

/** 开关门面：关闭时右下角悬浮球按钮（可拖动）+ 页面隐藏（不卸载，草稿保住）。 */
export function OrbOverlay({ api, t }: OrbOverlayProps) {
  const open = useSyncExternalStore(orbStore.subscribe, orbStore.getSnapshot)
  // 控制室打开时把球收起来（否则会浮在全屏控制室上面）
  const controlRoomOpen = useSyncExternalStore(controlRoomStore.subscribe, controlRoomStore.getSnapshot)
  // Electron 宿主有原生桌面球（可拖到 DSH 窗口外）时，隐藏网页内这颗，避免两个球。
  // 只在 Electron 渲染器里隐藏：手机浏览器与普通桌面浏览器仍需要页内球
  // （原生球在电脑上，点它只会打开电脑上的窗口）。
  const nativeBallFlag = useSyncExternalStore(nativeBallStore.subscribe, nativeBallStore.getSnapshot)
  const electronShell = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)
  const nativeBall = nativeBallFlag && electronShell
  // 惰性挂载：悬浮球页首次打开前不渲染（哪怕只是 display:none）——
  // 会话历史可能有数百行，常驻在手机 WebView 里会白占几 MB 内存与上万个 DOM 节点，
  // 正是「详情页一崩就整页 reload」时最不该存在的负担。打开过一次后保持挂载，
  // 草稿与滚动位置不丢。
  // 用 ref 而不是 useState+useEffect：后者要多跑一轮渲染，点开的那一下才出现页面，
  // 手机上正好落在「点了半天没反应」的观感上。
  const mountedRef = useRef(open)
  if (open) mountedRef.current = true
  return (
    <>
      {!open && !controlRoomOpen && !nativeBall && (
        <OrbBall
          label={t('open')}
          onOpen={() => {
            // 悬浮球 = 控制室入口（手机/电脑一致）。快捷输入页仍可从抽屉入口打开。
            controlRoomStore.setOpen(true)
          }}
        />
      )}
      {mountedRef.current && <OrbPage api={api} t={t} open={open} />}
    </>
  )
}

/** 球体直径与贴边留白（与 orb.css 保持一致）。 */
const BALL_SIZE = 52
const BALL_EDGE = 8
/** 判定为「拖拽」而非「点击」的位移阈值（px）。 */
const DRAG_THRESHOLD = 6

/** 把球位置夹在视口内（含安全边距）。 */
function clampBall(point: BallPoint): BallPoint {
  const w = typeof window === 'undefined' ? 375 : window.innerWidth
  const h = typeof window === 'undefined' ? 800 : window.innerHeight
  return {
    x: Math.min(Math.max(BALL_EDGE, point.x), Math.max(BALL_EDGE, w - BALL_SIZE - BALL_EDGE)),
    y: Math.min(Math.max(BALL_EDGE, point.y), Math.max(BALL_EDGE, h - BALL_SIZE - BALL_EDGE)),
  }
}

/** 默认位置：右下角（原固定位置）。 */
function defaultBall(): BallPoint {
  const w = typeof window === 'undefined' ? 375 : window.innerWidth
  const h = typeof window === 'undefined' ? 800 : window.innerHeight
  return clampBall({ x: w - BALL_SIZE - 14, y: h - BALL_SIZE - 84 })
}

/**
 * 可拖动悬浮球：按住拖到任意位置（松手记住位置），轻点打开悬浮球页。
 * Pointer Events + setPointerCapture，触屏/鼠标通用；拖动时不让页面滚动。
 */
function OrbBall({ label, onOpen }: { label: string; onOpen: () => void }) {
  const [pos, setPos] = useState<BallPoint>(() => {
    const saved = readLastBall()
    return saved === null ? defaultBall() : clampBall(saved)
  })
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  /** 拖动收尾后浏览器还会补一个 click：标记它，别当成「点开悬浮球」。 */
  const suppressClickRef = useRef(false)
  const posRef = useRef(pos)
  posRef.current = pos

  // 视口变化（旋屏 / 键盘弹出 / 地址栏收起）后仍保持在屏内。
  useEffect(() => {
    const onResize = (): void => setPos((current) => clampBall(current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: pos.x, oy: pos.y, moved: false }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    const dx = event.clientX - drag.sx
    const dy = event.clientY - drag.sy
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    setPos(clampBall({ x: drag.ox + dx, y: drag.oy + dy }))
  }

  /** 抬起与取消只负责收尾拖拽。**点开改由 click 承担**：
   * 原先在 pointerup 里打开并当场卸载球体，浏览器随后为这次按压合成 click 时
   * 命中测试用的是「已经换掉的界面」——一次点击被处理两遍（穿透到刚挂载的
   * 悬浮球页面，或还没画出来时穿透到电脑端界面上的按钮）。 */
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag === null) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* 指针已释放 → 忽略 */
    }
    if (!drag.moved) return
    suppressClickRef.current = true
    writeLastBall(posRef.current)
  }

  const onBallClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    // 乐观打开：同步翻状态，页面在这一轮渲染就挂出来，不等任何异步结果
    onOpen()
    armClickGuard({ x: rect.left, y: rect.top, w: rect.width, h: rect.height }, { onSwallow: noteOrbSwallow })
  }

  return (
    <button
      type="button"
      data-pocket-orb="ball"
      aria-label={label}
      title={label}
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onClick={onBallClick}
    >
      🔮
    </button>
  )
}

/** 会话历史首屏渲染条数：手机上一屏放不下十几行，先渲染这么多，
 * 其余用「显示更多」按需追加——避免几百行会话同时挂载把内存吃光。 */
const HISTORY_PAGE = 40

/** 左滑操作区宽度（三个按钮各 56px）。 */
const SWIPE_ACTIONS_WIDTH = 168
/** 滑动超过这个比例就展开。 */
const SWIPE_SNAP_RATIO = 0.35

/** 单行会话：左滑露出 置顶/重命名/归档 三个操作。 */
function SwipeableSessionRow({ row, selected, t, api, swiped, onSwipeOpen, onSwipeClose, onSelect, onView, onAction, onArchived, onRefresh }: {
  row: OrbSessionRow
  selected: boolean
  t: (key: OrbKey) => string
  api: OrbApi
  swiped: boolean
  onSwipeOpen: () => void
  onSwipeClose: () => void
  onSelect: () => void
  onView: () => void
  onAction: (msg: string) => void
  onArchived: () => void
  onRefresh: () => void
}) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const [busy, setBusy] = useState(false)
  const startRef = useRef({ x: 0, y: 0, offset: 0 })
  const horizRef = useRef<boolean | null>(null)
  /** 实时偏移：touchmove/touchend 同帧时 state 可能还没提交，用 ref 保证判定用最新值。 */
  const offsetRef = useRef(0)
  /** 刚滑过：抑制紧随其后的 click，避免「滑开→click→立刻关回」。 */
  const suppressClickRef = useRef(false)

  // 另一行被打开时收起本行
  useEffect(() => {
    if (!dragging) {
      const next = swiped ? -SWIPE_ACTIONS_WIDTH : 0
      offsetRef.current = next
      setOffset(next)
    }
  }, [swiped, dragging])

  const onTouchStart = (e: ReactTouchEvent) => {
    if (renaming) return
    const touch = e.touches[0]
    startRef.current = { x: touch.clientX, y: touch.clientY, offset: offsetRef.current }
    horizRef.current = null
    suppressClickRef.current = false
  }

  const onTouchMove = (e: ReactTouchEvent) => {
    if (renaming) return
    const touch = e.touches[0]
    const dx = touch.clientX - startRef.current.x
    const dy = touch.clientY - startRef.current.y
    if (horizRef.current === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      horizRef.current = Math.abs(dx) > Math.abs(dy)
      if (!horizRef.current) return
    }
    if (!horizRef.current) return
    // 不调用 e.preventDefault()：React 的 touchmove 是 passive 监听，调了无效且会告警；
    // 横向手势由 CSS touch-action: pan-y 交给 JS 处理，纵向滚动仍归浏览器。
    const next = Math.max(-SWIPE_ACTIONS_WIDTH, Math.min(0, startRef.current.offset + dx))
    offsetRef.current = next
    setDragging(true)
    setOffset(next)
  }

  const onTouchEnd = () => {
    if (renaming || !dragging) return
    setDragging(false)
    // 这次是滑动（非轻点）：抑制紧随其后的 click，避免滑开/收起后又被 click 反转。
    suppressClickRef.current = true
    window.setTimeout(() => { suppressClickRef.current = false }, 350)
    if (offsetRef.current < -SWIPE_ACTIONS_WIDTH * SWIPE_SNAP_RATIO) {
      offsetRef.current = -SWIPE_ACTIONS_WIDTH
      setOffset(-SWIPE_ACTIONS_WIDTH)
      onSwipeOpen()
    } else {
      offsetRef.current = 0
      setOffset(0)
      onSwipeClose()
    }
  }

  const closeSwipe = (): void => { offsetRef.current = 0; setOffset(0); onSwipeClose() }

  const doPin = async (): Promise<void> => {
    setBusy(true)
    try {
      if (row.pinned) await api.unpinSession(row.sessionId)
      else await api.pinSession(row.sessionId)
      onRefresh()
      onAction(row.pinned ? t('unpinned') : t('pinned'))
    } catch (err) {
      onAction(`${t('actionFailed')}：${err instanceof Error ? err.message : String(err)}`)
    } finally { setBusy(false); closeSwipe() }
  }

  const doArchive = async (): Promise<void> => {
    // 运行中的会话归档会被宿主拒绝（workspace/session-active）；先提示停止，
    // 不静默 stopActivity——那会把用户正在跑的活杀掉。
    if (row.running) {
      onAction(t('archiveRunning'))
      closeSwipe()
      return
    }
    setBusy(true)
    try {
      await api.archiveSession(row.sessionId)
      onArchived()
      onRefresh()
      onAction(t('archived'))
    } catch (err) {
      onAction(`${t('actionFailed')}：${err instanceof Error ? err.message : String(err)}`)
    } finally { setBusy(false); closeSwipe() }
  }

  const startRename = (): void => {
    setRenameText(row.title || '')
    setRenaming(true)
    // 先收起滑动：输入框在行内容里，行还平移着的话左边会被裁掉。
    offsetRef.current = 0
    setOffset(0)
    onSwipeClose()
  }

  const confirmRename = async (): Promise<void> => {
    const title = renameText.trim()
    if (!title) return
    setBusy(true)
    try {
      await api.renameSession(row.sessionId, title)
      onRefresh()
      onAction(t('renamed'))
      setRenaming(false)
    } catch (err) {
      onAction(`${t('actionFailed')}：${err instanceof Error ? err.message : String(err)}`)
    } finally { setBusy(false); closeSwipe() }
  }

  const cancelRename = (): void => { setRenaming(false); closeSwipe() }

  return (
    <div data-pocket-orb="swipe-row">
      {/* 左滑露出的操作按钮（在行内容底下） */}
      <div data-pocket-orb="swipe-actions">
        <button type="button" data-pocket-orb="swipe-btn" data-action="pin" disabled={busy}
          onClick={(e) => { e.stopPropagation(); void doPin() }}>
          {row.pinned ? `📌 ${t('unpin')}` : `📌 ${t('pin')}`}
        </button>
        <button type="button" data-pocket-orb="swipe-btn" data-action="rename" disabled={busy}
          onClick={(e) => { e.stopPropagation(); startRename() }}>
          ✏️ {t('rename')}
        </button>
        <button type="button" data-pocket-orb="swipe-btn" data-action="archive" disabled={busy}
          onClick={(e) => { e.stopPropagation(); void doArchive() }}>
          📦 {t('archive')}
        </button>
      </div>

      {/* 行内容（可左滑） */}
      <div
        role="button"
        tabIndex={0}
        data-pocket-orb="history-row"
        data-current={selected ? '1' : '0'}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform .2s ease-out',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClick={() => {
          if (suppressClickRef.current) return
          if (swiped) { closeSwipe(); return }
          if (renaming) return
          onSelect()
        }}
      >
        {renaming ? (
          <div data-pocket-orb="rename-form" onClick={(e) => e.stopPropagation()}>
            <input
              data-pocket-orb="rename-input"
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirmRename(); if (e.key === 'Escape') cancelRename() }}
              placeholder={t('renamePlaceholder')}
              autoFocus
              disabled={busy}
            />
            <button type="button" data-pocket-orb="rename-ok" onClick={() => void confirmRename()} disabled={busy || !renameText.trim()}>✓</button>
            <button type="button" data-pocket-orb="rename-cancel" onClick={cancelRename} disabled={busy}>✕</button>
          </div>
        ) : (
          <>
            <span data-pocket-orb="dot" data-running={row.running ? '1' : '0'} />
            <span data-pocket-orb="history-main">
              <span data-pocket-orb="history-name">
                {row.pinned && '📌 '}
                {row.title || t('noTitle')}
              </span>
              <span data-pocket-orb="history-sub">
                {[row.cwd, fmtWhen(row.updatedAt), row.running ? t('running') : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span data-pocket-orb="preset-badge" data-mode={row.agentPreset === 'computer-use' ? 'computer-use' : 'standard'} title={row.agentPreset || 'standard'}>
              {row.agentPreset === 'computer-use' ? `🖱️ ${t('presetGui')}` : `💬 ${t('presetStandard')}`}
            </span>
            {selected && (
              <button type="button" data-pocket-orb="target-btn" data-primary="1"
                onClick={(e) => { e.stopPropagation(); onView() }}>
                {t('viewSession')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function OrbPage({ api, t, open }: OrbOverlayProps & { open: boolean }) {
  // 目标会话持久化（localStorage）：HMR 重载/断连重连导致整页重挂载时恢复用户最后选中的
  // 会话，否则每次重挂载选中行都跳回「新会话」，视觉上在两个状态间来回切。
  const [target, setTargetState] = useState<Target>(() => {
    const id = readLastTargetId()
    return id !== null ? { kind: 'session', id } : { kind: 'new' }
  })
  /** 当前目标的会话 id（ref 版）：列表刷新、过滤「当前那条空白会话」、
   * 复用判定都要读它，但不必因此重建订阅。 */
  const targetIdRef = useRef<string | null>(target.kind === 'session' ? target.id : null)
  const setTarget = (next: Target): void => {
    setTargetState(next)
    writeLastTargetId(next.kind === 'session' ? next.id : null)
    targetIdRef.current = next.kind === 'session' ? next.id : null
    // 换目标 = 「当前这条空白会话」的例外也随之改变，列表立即按新目标重算
    setHistory(api.listSessions(targetIdRef.current))
  }
  const [cwd, setCwd] = useState(() => readLastCwd())
  // 「新建会话」的模式（Agent 预设 id；空串 = 主机默认/标准模式）。
  // 默认沿用悬浮球原有的 GUI 模式；用户选中过某条会话后，新建就跟随那条会话的模式。
  const [preset, setPresetState] = useState<string>(() => {
    const stored = readLastPreset()
    return stored === null ? ORB_AGENT_PRESET : stored
  })
  const setPreset = (next: string): void => {
    const normalized = presetKey(next)
    setPresetState(normalized)
    writeLastPreset(normalized)
  }
  const [desktop, setDesktop] = useState('')
  const [text, setText] = useState('')
  const [chips, setChips] = useState<OrbChip[]>([])
  const [sending, setSending] = useState(false)
  // 首屏交空列表：点开悬浮球的那一轮渲染只挂「壳」（标题栏 + 目标条 + 输入区），
  // 会话历史在提交后的 effect 里补——点开即见，而不是「点了半天才出来」。
  const [history, setHistory] = useState<OrbSessionRow[]>([])
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE)
  const [swipedId, setSwipedId] = useState<string | null>(null)
  const [commands, setCommands] = useState<OrbCommand[]>([])
  const [skills, setSkills] = useState<OrbSkill[]>([])
  const [models, setModels] = useState<OrbModel[]>([])
  const [modelSel, setModelSel] = useState<{ provider: string; model: string; name: string } | null>(() => readLastModel())
  const [bgModelSel, setBgModelSel] = useState<{ provider: string; model: string; name: string } | null>(() => readLastBackgroundModel())
  /** modelSel 的同步镜像：选模型 → 立即落会话时需要最新值，不能等一次渲染。 */
  const modelSelRef = useRef(modelSel)
  modelSelRef.current = modelSel
  /** 用户是否「刚亲手选了模型」：决定发送时要不要把它强加到目标会话。
   * 选中已有会话时改动目标不清空胶囊的显示，但也不该把旧的草稿模型硬塞给那条会话。 */
  const modelDirtyRef = useRef(false)
  /** 已经落到哪个会话上（sessionId|provider/model）：避免每条消息都重复写 model/selection。 */
  const appliedModelRef = useRef<string | null>(null)
  const [browser, setBrowser] = useState<null | 'dir' | 'file'>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  // 语音输入：Host 端是否挂载了 speech Remote（官方 voice-input bundle 已启用）+ 浏览器是否允许录音。
  // 上限秒数取 Host 的 catalog——不同机器配置的上限不同，写死会被 Host 拒收。
  const [voiceMaxSeconds, setVoiceMaxSeconds] = useState(60)
  // speech Remote 由 Host 侧插件在客户端启动时挂载，可能与悬浮球挂载先后不定；
  // 每次打开悬浮球重新探测一次，避免「插件晚挂载 → 麦克风永远不出现」。
  const [speechReady, setSpeechReady] = useState(() => api.speechAvailable())
  const voiceBlockedReason = useMemo(() => voiceBlocked(), [])
  const voice = useMemo<OrbVoiceBridge>(() => ({
    available: speechReady,
    blocked: voiceBlockedReason,
    maxSeconds: voiceMaxSeconds,
    transcribe: (audioBase64: string) => api.transcribe(audioBase64),
  }), [api, speechReady, voiceBlockedReason, voiceMaxSeconds])
  useEffect(() => {
    if (!open) return
    setSpeechReady(api.speechAvailable())
  }, [open, api])
  useEffect(() => {
    if (!speechReady) return
    let alive = true
    void api.speechMaxSeconds().then(
      (seconds) => { if (alive) setVoiceMaxSeconds(seconds) },
      () => undefined,
    )
    return () => { alive = false }
  }, [speechReady, api])

  const toast = (message: string): void => {
    setToastMsg(message)
    window.setTimeout(() => setToastMsg((cur) => (cur === message ? null : cur)), 3200)
  }

  /** 把胶囊上的模型落到指定会话。
   * 失败不再静默吞掉——「选了 A 却跑 B」正是静默失败造成的；调用方据此决定是否继续发送。 */
  const applyModelToSession = async (sessionId: string): Promise<boolean> => {
    const selection = modelSelRef.current
    if (selection === null) return true
    try {
      await api.selectModel(sessionId, { provider: selection.provider, model: selection.model })
      appliedModelRef.current = `${sessionId}|${selection.provider}/${selection.model}`
      modelDirtyRef.current = false
      return true
    } catch (err) {
      appliedModelRef.current = null
      toast(`${t('modelFailed')}：${(err as Error)?.message ?? String(err)}`)
      return false
    }
  }

  /** 发送前确认「胶囊上的模型 == 这条消息要用的模型」。
   * 已经落到同一会话同一模型就不重复写；否则补一次，失败就不发（绝不带着旧模型偷偷跑）。 */
  const ensureModelApplied = async (sessionId: string): Promise<boolean> => {
    const selection = modelSelRef.current
    if (selection === null) return true
    const key = `${sessionId}|${selection.provider}/${selection.model}`
    if (appliedModelRef.current === key) return true
    return applyModelToSession(sessionId)
  }

  // 会话历史实时同步（电脑端的操作也反映进来）。
  // 节流：宿主每次投影更新都会推一版快照，手机上即便只是重渲染几十行也很贵，
  // 合并成 250ms 一次，列表看起来仍然是实时的。
  useEffect(() => {
    let timer: number | null = null
    const flush = (): void => {
      timer = null
      setHistory(api.listSessions(targetIdRef.current))
    }
    const schedule = (): void => {
      if (timer !== null) return
      timer = window.setTimeout(flush, 250)
    }
    const stopSessions = api.subscribeSessions(schedule)
    const stopWorkspaces = api.subscribeWorkspaces(schedule)
    // 第一版列表在挂载提交之后补（见 history 初始值）
    flush()
    return () => {
      stopSessions()
      stopWorkspaces()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [api])

  // 关闭悬浮球时把分页收回首屏：下次打开仍从 40 条开始，内存不随使用时长增长。
  useEffect(() => {
    if (!open) setHistoryLimit(HISTORY_PAGE)
  }, [open])

  // 系统真实桌面目录（支持重定向，如 D:\陈潘HBEU\Desktop）：
  // 新会话默认项目目录 + 路径浏览器（目录/电脑文件）默认起点。已有选择时不覆盖。
  useEffect(() => {
    let live = true
    void api.listFs('').then((listing) => {
      if (!live || !listing?.desktop) return
      setDesktop(listing.desktop)
      setCwd((cur) => (cur === '' ? listing.desktop : cur))
    }).catch(() => { /* 拿不到就维持现状（空 = 主机默认） */ })
    return () => {
      live = false
    }
  }, [api])

  // / 菜单数据：命令（commands/execute 执行）+ 技能（发给 agent 执行）。
  // 技能发现是异步的（文件系统扫描/缓存），早取的快照可能不完整；
  // 因此不仅目标变化时拉，**每次打开 / 菜单也会重拉**（见 onTextChange）。
  const loadSlashData = async (sessionId: string): Promise<void> => {
    const [nextCommands, nextSkills] = await Promise.all([
      api.commandList(sessionId),
      api.skillList(sessionId),
    ])
    setCommands(nextCommands)
    setSkills(nextSkills)
  }

  useEffect(() => {
    if (target.kind !== 'session') {
      setCommands([])
      setSkills([])
      return
    }
    let live = true
    void Promise.all([api.commandList(target.id), api.skillList(target.id)]).then(([nextCommands, nextSkills]) => {
      if (!live) return
      setCommands(nextCommands)
      setSkills(nextSkills)
    })
    return () => {
      live = false
    }
  }, [api, target])

  // 模型目录：整页生命周期拉一次（与桌面模型选择同一目录）。
  // 同时回读主机的后台任务模型设置（dsh-orb /.dsh-orb/settings），
  // 校正本地 label 缓存——桌面设置页改过后手机端刷新即同步。
  useEffect(() => {
    let live = true
    void api.modelCatalog().then(async (catalog) => {
      if (!live) return
      setModels(catalog.models)
      const nameOf = (provider: string, model: string): string =>
        catalog.models.find((m) => m.provider === provider && m.model === model)?.name ?? model
      // 上次选的模型可能已经从主机配置里删掉（例如 strata 换了量化档）。
      // 继续拿死 id 发消息会失败或回退到别的模型，看起来就是「选了 A 却跑 B」——
      // 目录可用时校验一次，失效就清掉、如实提示。
      const current = modelSelRef.current
      if (current !== null && catalog.models.length > 0 &&
        !catalog.models.some((m) => m.provider === current.provider && m.model === current.model)) {
        modelSelRef.current = null
        modelDirtyRef.current = false
        appliedModelRef.current = null
        setModelSel(null)
        clearLastModel()
        toast(`${t('modelMissing')}：${current.name}`)
      }
      const hostBg = await api.backgroundModel().catch(() => null)
      if (!live || !hostBg) return
      const next = { provider: hostBg.provider, model: hostBg.model, name: nameOf(hostBg.provider, hostBg.model) }
      setBgModelSel(next)
      writeLastBackgroundModel(next)
    }).catch(() => { /* 目录不可用 → 模型行显示默认文案 */ })
    return () => {
      live = false
    }
  }, [api])

  const currentRow = useMemo(() => {
    if (target.kind !== 'session') return null
    // 首屏列表还没刷出来、或目标是一条被隐藏的空白会话时，直接按 id 取行
    return history.find((r) => r.sessionId === target.id) ?? api.sessionRow(target.id)
  }, [api, history, target])

  /** 把一条会话的项目地址与模式带进「新建会话」草稿：
   * 用户先选中 GUI 会话再点新建时，新会话必须落在同一目录、跑同一模式。 */
  const applySessionTemplate = (row: OrbSessionRow | null): void => {
    if (row === null) return
    const template = templateFromSession(row)
    if (template.cwd) {
      setCwd(template.cwd)
      writeLastCwd(template.cwd)
    }
    setPreset(template.agentPreset)
  }

  /** 头部「＋ 新建会话」：以当前选中会话为模板（目录 + 模式）开始一条新会话，
   * 而不是沿用别处残留的目录与默认 GUI 模式。 */
  const startNewSession = (): void => {
    applySessionTemplate(currentRow)
    setTarget({ kind: 'new' })
  }

  /** 选中已有会话时，把模型胶囊校正成这条会话**实际**在用的模型。
   * 胶囊显示什么，发送时就必须是什么；不能让它停留在上一条会话的草稿上。 */
  const syncModelFromSession = (row: OrbSessionRow): void => {
    const actual = sessionModel(row)
    if (actual === null) return
    const name = models.find((m) => m.provider === actual.provider && m.model === actual.model)?.name ?? actual.model
    const selection = { provider: actual.provider, model: actual.model, name }
    setModelSel(selection)
    modelSelRef.current = selection
    writeLastModel(selection)
    appliedModelRef.current = `${row.sessionId}|${actual.provider}/${actual.model}`
    modelDirtyRef.current = false
  }

  /** / 弹层条目：命令在前、技能在后。技能不带描述（占行，桌面弹层也只展示名字）。 */
  const slashItems = useMemo<SlashItem[]>(() => [
    ...commands.map((c) => ({ name: c.name, description: c.description, kind: 'command' as const })),
    ...skills.map((s) => ({ name: s.name, description: '', kind: 'skill' as const })),
  ], [commands, skills])

  /** 发送时才落实目标会话（懒创建）。规则都在 api.createSession 里：
   * 同目录已有**同模式**的空白会话 → 复用；没有 → 创建，且同目录同模式的并发创建共用一个在途请求。
   * 「点开悬浮球」「换目录」「选模型」「输入 /」都不再触发任何创建。
   * 新建沿用的是「当前草稿」的目录与模式——选中过会话时就是那条会话的目录与模式
   * （见 applySessionTemplate）；没选过时才用默认的 Computer Use 预设。
   * 预设创建失败回退时显式提示，绝不静默降级成普通模式。 */
  const ensureSession = async (): Promise<string> => {
    if (target.kind === 'session') return target.id
    const wantedPreset = presetKey(preset)
    // 标准模式不显式传预设 id（主机默认就是它），其余模式原样传给创建接口。
    const { sessionId, appliedPreset, reused } = await api.createSession(cwd, isStandardPreset(wantedPreset) ? undefined : wantedPreset)
    setTarget({ kind: 'session', id: sessionId })
    writeLastCwd(cwd)
    // 标准模式没有「回退」一说；只有明确选了 GUI 等预设却没生效才提示。
    if (!isStandardPreset(wantedPreset) && !reused && presetKey(appliedPreset) !== wantedPreset) toast(t('presetFallback'))
    // 模型不在这里落：发送前由 ensureModelApplied 统一确认（见 onSend），
    // 失败也绝不静默降级成别的模型继续跑。
    return sessionId
  }

  /** / 菜单：命令与技能目录都要一个会话 id 才能拉。新会话模式下**不为此创建会话**——
   * 用同目录已有的空白会话当探针；没有就等发送时再拉（onSend 里有 commandList 兜底）。
   * 此前这里每次输 / 都会先落一条空白会话。 */
  const onTextChange = (value: string): void => {
    setText(value)
    // 每次进入 / 模式都刷新一遍菜单数据：技能目录是异步发现的，
    // 只靠首次快照可能拿到不完整的列表。
    const enteringSlash = value.startsWith('/') && !text.startsWith('/')
    if (!enteringSlash) return
    if (target.kind === 'session') {
      void loadSlashData(target.id).catch(() => { /* 失败保留旧数据 */ })
      return
    }
    const probe = api.reusableBlank(cwd, null, preset)
    if (probe === null) return
    void loadSlashData(probe).catch(() => { /* 发送时统一报错 */ })
  }

  const onPickSlash = (item: SlashItem): void => {
    setText(`/${item.name} `)
  }

  /** 选择模型：有目标会话就直接作用于它；新会话模式只记住这次选择，
   * 等发送落实会话那一刻自动套用（onSend 的 ensureModelApplied）——选模型不该顺手建会话。 */
  const onPickModel = async (model: OrbModel): Promise<void> => {
    const selection = { provider: model.provider, model: model.model, name: model.name }
    setModelSel(selection)
    modelSelRef.current = selection
    writeLastModel(selection)
    modelDirtyRef.current = true
    appliedModelRef.current = null
    let running = false
    if (target.kind === 'session') {
      running = history.some((row) => row.sessionId === target.id && row.running)
      const ok = await applyModelToSession(target.id)
      if (!ok) return
    }
    // 正在跑的一轮不会中途换模型——如实说明「下一轮生效」，别让人以为立刻换了。
    toast(`${t('modelSet')}：${model.name}${running ? ` · ${t('nextTurn')}` : ''}`)
  }

  /** 选择后台任务模型：写主机 dsh-orb 设置（新建 code_agent 会话生效）+ 本地缓存 label。
   * 与前台模型不同——不碰任何会话，无需先落会话。旧版 dsh-orb 无此路由时明确提示。 */
  const onPickBackgroundModel = async (model: OrbModel): Promise<void> => {
    try {
      await api.selectBackgroundModel({ provider: model.provider, model: model.model })
      const next = { provider: model.provider, model: model.model, name: model.name }
      setBgModelSel(next)
      writeLastBackgroundModel(next)
      toast(`${t('backgroundModelSet')}：${model.name} · ${t('backgroundModelHint')}`)
    } catch (err) {
      toast(`${t('backgroundModelFailed')}：${err?.message ?? String(err)}`)
    }
  }

  /** 发送。override 用于语音：转写结果直接发出，不等 state 回流。 */
  const sendWith = async (override?: string): Promise<void> => {
    if (sending) return
    const draft = (override ?? text).trim()
    const body = [draft, ...chips.map((c) => (c.kind === 'pc-file' ? `[file: ${c.path}]` : null))]
      .filter((line): line is string => line !== null && line !== '')
    const images = chips.filter((c): c is Extract<OrbChip, { kind: 'image' }> => c.kind === 'image')
    const phoneFiles = chips.filter((c): c is Extract<OrbChip, { kind: 'phone-file' }> => c.kind === 'phone-file')
    if (body.length === 0 && images.length === 0 && phoneFiles.length === 0) {
      toast(t('needText'))
      return
    }
    setSending(true)
    try {
      // 新会话必须用胶囊上的模型；已有会话只在用户刚选过模型时才改它，
      // 避免把上一次留在胶囊里的草稿硬塞给一条本来用别的模型的会话。
      const created = target.kind === 'new'
      const sessionId = await ensureSession()
      if (created || modelDirtyRef.current) {
        const applied = await ensureModelApplied(sessionId)
        // 落不到会话上就不发：否则又会出现「选了 A 却用 B 跑」。
        if (!applied) return
      }

      // 手机文件落盘到电脑（桌面悬浮球「无路径文件落盘后引用」同款）。
      const fileLines: string[] = []
      for (const chip of phoneFiles) {
        const saved = await api.saveUpload(chip.name, chip.data)
        fileLines.push(`[file: ${saved.path}]`)
      }

      const textBody = [...body, ...fileLines].join('\n')
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: any; data: string; name?: string }> = []
      if (textBody !== '') content.push({ type: 'text', text: textBody })
      for (const img of images) content.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name })

      // 路由与桌面输入框的 matchEnter 决策表一致：
      //   / 行命中宿主命令 → commands/execute（目标/压缩等）；
      //   其余（含 /技能名 → prompt，由 agent 调 skill 工具执行）→ session/prompt。
      let commandNames = new Set(commands.map((c) => c.name))
      if (commandNames.size === 0) {
        commandNames = new Set((await api.commandList(sessionId)).map((c) => c.name))
      }
      const firstToken = textBody.trim().split(/\s/, 1)[0] ?? ''
      const typedName = firstToken.startsWith('/') ? firstToken.slice(1) : ''
      const isHostCommand = typedName !== '' && commandNames.has(typedName)

      if (textBody !== '' && isSlashCommand(textBody) && isHostCommand) {
        // 宿主命令：与桌面输入框同一执行路径。图片随命令走 submittedAttachments。
        const result = await api.commandExecute(
          sessionId,
          textBody.trim(),
          images.map((img) => ({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name })),
        )
        if (result.kind === 'error') toast(`${t('cmdFailed')}${result.text ? `：${result.text}` : ''}`)
        else toast(t('sent'))
      } else {
        // 会话正在执行 → 插话（steer），指令立即并入当前这一轮；
        // 会话空闲 → 正常排队（queue），效果等同直接开新的一轮。
        const runningNow = history.some((row) => row.sessionId === sessionId && row.running)
        await api.prompt(sessionId, content as any, runningNow ? 'steer' : 'queue')
        toast(runningNow ? t('steered') : t('sent'))
      }
      setText('')
      setChips([])
      // 目标会话从「空白」变成「有内容」：立刻让它回到历史列表
      // （宿主投影更新也会推过来，这里不等那一下）
      setHistory(api.listSessions(sessionId))
    } catch (err) {
      toast(`${t('sendFailed')}：${err?.message ?? String(err)}`)
    } finally {
      setSending(false)
    }
  }

  /** 输入框发送按钮：用当前草稿。 */
  const onSend = (): Promise<void> => sendWith()

  return (
    <div data-pocket-orb="page" style={open ? undefined : { display: 'none' }}>
      <div data-pocket-orb="header">
        <div data-pocket-orb="title">{t('title')}</div>
        <button type="button" data-pocket-orb="header-btn" onClick={startNewSession}>
          ＋ {t('newSession')}
        </button>
        <button type="button" data-pocket-orb="header-btn" onClick={() => orbStore.setOpen(false, 'header-close')}>
          {t('close')}
        </button>
      </div>

      <div data-pocket-orb="body">
        {/* 目标条 */}
        {target.kind === 'new' ? (
          <div data-pocket-orb="target">
            <span data-pocket-orb="target-path">
              {t('pickDirShort')}：{cwd || t('defaultDir')}
              {' · '}
              {isStandardPreset(preset) ? `💬 ${t('presetStandard')}` : preset === 'computer-use' ? `🖱️ ${t('presetGui')}` : preset}
            </span>
            <button type="button" data-pocket-orb="target-btn" data-primary="1" onClick={() => setBrowser('dir')}>
              {t('browse')}
            </button>
          </div>
        ) : (
          <div data-pocket-orb="target">
            <span data-pocket-orb="target-path">
              {currentRow?.title || t('noTitle')}
              {currentRow?.agentPreset ? ` · ${currentRow.agentPreset}` : ''}
              {currentRow?.cwd ? ` · ${currentRow.cwd}` : ''}
            </span>
          </div>
        )}

        {/* 会话历史 */}
        <div data-pocket-orb="history-title">{t('history')}</div>
        {history.length === 0 && <div data-pocket-orb="history-empty">{t('historyEmpty')}</div>}
        {history.slice(0, historyLimit).map((row) => {
          const selected = target.kind === 'session' && target.id === row.sessionId
          return (
            <SwipeableSessionRow
              key={row.sessionId}
              row={row}
              selected={selected}
              t={t}
              api={api}
              swiped={swipedId === row.sessionId}
              onSwipeOpen={() => setSwipedId(row.sessionId)}
              onSwipeClose={() => setSwipedId((cur) => (cur === row.sessionId ? null : cur))}
              onSelect={() => {
                setTarget({ kind: 'session', id: row.sessionId })
                // 选中即把该会话的目录与模式记成「新建会话」模板
                applySessionTemplate(row)
                // 模型胶囊跟随这条会话的真实模型；没选过模型就不硬塞草稿模型
                syncModelFromSession(row)
                modelDirtyRef.current = false
              }}
              onView={() => {
                noteOpenSession(row.sessionId)
                api.openSession(row.sessionId)
                orbStore.setOpen(false, 'view-session')
              }}
              onAction={(msg) => toast(msg)}
              onArchived={() => {
                // 归档的正好是当前选中会话 → 目标条退回「新会话」，避免指向已隐藏的会话。
                if (target.kind === 'session' && target.id === row.sessionId) setTarget({ kind: 'new' })
              }}
              onRefresh={() => setHistory(api.listSessions(targetIdRef.current))}
            />
          )
        })}
        {/* 分页：其余会话按需追加（一次 40 条），避免几百行同时挂载 */}
        {history.length > historyLimit && (
          <button
            type="button"
            data-pocket-orb="history-more"
            onClick={() => setHistoryLimit((cur) => cur + HISTORY_PAGE)}
          >
            {`显示更多（还有 ${history.length - historyLimit} 条）`}
          </button>
        )}
      </div>

      {/* 输入区 */}
      <div data-pocket-orb="menu-anchor">
        <Composer
          value={text}
          onChange={onTextChange}
          chips={chips}
          onAddChips={(added) => setChips((cur) => [...cur, ...added])}
          onRemoveChip={(index) => setChips((cur) => cur.filter((_, i) => i !== index))}
          onSend={() => void onSend()}
          onSendText={(voiceText) => void sendWith(voiceText)}
          sending={sending}
          slashItems={slashItems}
          onPickSlash={onPickSlash}
          models={models}
          modelLabel={modelSel?.name ?? t('model')}
          onPickModel={(model) => void onPickModel(model)}
          backgroundModelLabel={bgModelSel?.name ?? t('backgroundModel')}
          onPickBackgroundModel={(model) => void onPickBackgroundModel(model)}
          onOpenPcFiles={() => setBrowser('file')}
          voice={voice}
          toast={toast}
          t={t}
        />
      </div>

      {/* 电脑路径浏览器 */}
      {browser !== null && (
        <PathBrowser
          mode={browser}
          api={api}
          startPath={desktop || cwd || ''}
          t={t}
          onPick={(entry) => {
            setChips((cur) => [...cur, { kind: 'pc-file', name: entry.name, path: entry.path }])
            setBrowser(null)
          }}
          onPickDir={(path) => {
            setCwd(path)
            writeLastCwd(path)
            setBrowser(null)
          }}
          onClose={() => setBrowser(null)}
        />
      )}

      {toastMsg !== null && <div data-pocket-orb="toast">{toastMsg}</div>}
    </div>
  )
}
