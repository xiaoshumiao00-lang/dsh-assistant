/**
 * dsh-tuoguan 客户端：托管模式开关 + 自动应答 + 跨端状态同步。
 *
 * 机制：
 *   1. 开关按钮注册到 `conversation.input.right`（composer 工具行右侧、
 *      模型选择器左边），点击切换当前 Session 的托管状态。
 *      状态默认「开」：只记录被显式关闭的 Session（语义反转），
 *      于是新开会话天然处于托管中。
 *   2. 托管开启时，`conversation.composer` 链以 priority -5 抢先选中
 *      pending question / approval（官方 question composer priority 0、
 *      approval panel priority 1），组件挂载即用默认项应答，
 *      不渲染任何卡片；OFF 时 selector 返回 null，正常 UI 流程不变。
 *   3. **跨端同步（手机 ↔ 电脑）**：真值存在 host（profile 下的 JSON 文件），
 *      客户端通过同源 `GET/POST /.dsh-tuoguan/state` 读写。
 *      点击 = 乐观更新 + POST；页面可见时每 2.5s 轮询，`revision` 变化才 setState，
 *      所以另一端几秒内就会跟随；切回前台时立刻补拉一次。
 *      `localStorage` 退化为离线兜底缓存（首次 GET 前先渲染缓存，避免闪烁），
 *      一切以 host 为准。host 路由不可用（旧 host 代码未重启等）时自动降级为
 *      仅本机生效，开关不会变成死按钮。
 *
 * 鸭子类型：官方 PendingQuestion / PendingApproval class 仅类型导出，
 * 运行时不可用 instanceof，故以 kind 字段判别：
 *   kind === 'question' | 'plan-review' → answer({ answers: [...] })
 *   kind === 'approval'                 → answer('allowed-once')
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

/* ---------- 常量 ---------- */

/**
 * 离线兜底缓存（存的是「被显式关闭」的 Session 集合，语义反转 → 默认开启）。
 * 真值在 host，这里只用于首帧渲染与 host 不可用时的降级模式。
 * v1 存的是开启白名单，语义相反，故换 key 不迁移。
 */
const LS_KEY = 'dsh-tuoguan.v2'
/** 离线兜底：被「显式开启」的 Session 集合（只在默认关闭时才需要记录，2026-10 新增）。 */
const LS_ON_KEY = 'dsh-tuoguan.on.v2'
/** 离线兜底：新会话默认托管状态（'1' 开 / '0' 关；缺省 = 开）。 */
const LS_DEFAULT_KEY = 'dsh-tuoguan.default.v2'

/** host 真值路由（同源相对路径；登录 cookie 自动带上）。 */
const STATE_ROUTE = '/.dsh-tuoguan/state'
/** 页面可见时的轮询间隔：另一端切换后 ≤3s 跟随。 */
const POLL_MS = 2500
/** host 路由不可用时的退避间隔（约 15s 重试一次，宿主重启后自动恢复）。 */
const DEGRADED_POLL_FACTOR = 6

interface PendingOption { label: string; description?: string }
interface PendingQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: PendingOption[]
  multiSelect?: boolean
  intent?: { kind: string; approve?: string }
}
interface PendingLike {
  kind: string
  key: string
  sessionId?: string
  questions?: PendingQuestionItem[]
  answer: (value: unknown) => Promise<void>
}

/** host 返回的状态形状。 */
interface RemoteState {
  off: Record<string, boolean>
  /** 显式开启（脱离默认关闭）的会话；老 host 不返回 → 视为空表。 */
  on: Record<string, boolean>
  /** 新会话默认托管状态；老 host 不返回 → 默认开启（老行为）。 */
  defaultOn: boolean
  revision: number
  updatedAt: string
}

/* ---------- 轻量 toast（不依赖宿主 UI 原语，自包含） ---------- */

let toastElement: HTMLElement | null = null
let toastHideTimer: ReturnType<typeof setTimeout> | null = null

function showToast(text: string): void {
  if (typeof document === 'undefined' || document.body === null || document.body === undefined) {
    console.warn(`[dsh-tuoguan] ${text}`)
    return
  }
  if (toastElement === null) {
    const element = document.createElement('div')
    element.setAttribute('data-tuoguan-toast', '')
    // 用 Record<string, string> 而不是 CSSProperties：zIndex 等字段在 CSSProperties 里是 number，
    // 这里整批按 CSS 文本赋值更直接。
    const style: Record<string, string> = {
      position: 'fixed',
      left: '50%',
      bottom: '96px',
      transform: 'translateX(-50%)',
      zIndex: '2147483000',
      padding: '8px 14px',
      borderRadius: '10px',
      background: 'rgba(20, 20, 20, 0.86)',
      color: '#fff',
      fontSize: '13px',
      lineHeight: '18px',
      maxWidth: '86vw',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 180ms ease',
    }
    Object.assign(element.style, style)
    document.body.appendChild(element)
    toastElement = element
  }
  toastElement.textContent = text
  const element = toastElement
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { element.style.opacity = '1' })
  } else {
    element.style.opacity = '1'
  }
  if (toastHideTimer !== null) clearTimeout(toastHideTimer)
  toastHideTimer = setTimeout(() => {
    toastHideTimer = null
    element.style.opacity = '0'
    toastHideTimer = setTimeout(() => {
      toastHideTimer = null
      element.remove()
      if (toastElement === element) toastElement = null
    }, 200)
  }, 2800)
}

function dismissToast(): void {
  if (toastHideTimer !== null) { clearTimeout(toastHideTimer); toastHideTimer = null }
  if (toastElement !== null) { toastElement.remove(); toastElement = null }
}

/* ---------- 托管状态存储（host 真值 + localStorage 兜底缓存） ---------- */

function loadMap(key: string): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof k === 'string' && k !== '' && typeof v === 'boolean' && v) out[k] = true
        }
        return out
      }
    }
  } catch { /* 忽略损坏的存储 */ }
  return {}
}

function loadOffCache(): Record<string, boolean> {
  return loadMap(LS_KEY)
}

function saveOffCache(off: Record<string, boolean>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(off))
  } catch { /* 存储不可写时仅在内存生效 */ }
}

function loadOnCache(): Record<string, boolean> {
  return loadMap(LS_ON_KEY)
}

function saveOnCache(on: Record<string, boolean>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_ON_KEY, JSON.stringify(on))
  } catch { /* 存储不可写时仅在内存生效 */ }
}

/** 新会话默认托管状态：缺省开（与老行为一致）。 */
function loadDefaultCache(): boolean {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(LS_DEFAULT_KEY) !== '0'
  } catch { /* 忽略 */ }
  return true
}

function saveDefaultCache(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_DEFAULT_KEY, on ? '1' : '0')
  } catch { /* 忽略 */ }
}

let offSessions: Record<string, boolean> = loadOffCache()
/** 显式开启（默认关闭时才需要）：与 offSessions 互斥。 */
let onSessions: Record<string, boolean> = loadOnCache()
/** 新会话默认托管状态（host 真值优先；首帧用本地缓存）。 */
let defaultOn: boolean = loadDefaultCache()
/** -1 = 尚未从 host 取到真值（此时渲染的是 localStorage 缓存）。 */
let revision = -1
/** false = host 路由不可用（旧 host 代码未重启 / 宿主无 webServer），已降级为仅本机。 */
let hostReachable = true
/** 降级提示只弹一次，避免每次轮询都打扰。 */
let degradeNoticeShown = false

const listeners = new Set<() => void>()

/**
 * 订阅快照：每次状态变化都换一个新对象（useSyncExternalStore 靠引用比较判断要不要重渲染，
 * 只改默认值而不换对象会让托管按钮停在旧状态）。
 */
let snapCache: { off: Record<string, boolean>; on: Record<string, boolean>; defaultOn: boolean } = {
  off: offSessions, on: onSessions, defaultOn,
}
const EMPTY_SNAPSHOT = { off: {}, on: {}, defaultOn: true }

function touch(): void {
  snapCache = { off: offSessions, on: onSessions, defaultOn }
}

function emit(): void {
  touch()
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function snapshot(): { off: Record<string, boolean>; on: Record<string, boolean>; defaultOn: boolean } {
  return snapCache
}

/**
 * 某个会话当前是否处于托管中：显式开/关优先，其余跟着「默认状态」走。
 * 默认状态 = 开时，没动过的会话都在托管中（工作台模板会话也走这条，行为不变）。
 */
function isOn(sessionId: string | undefined): boolean {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (offSessions[sessionId] === true) return false
  if (onSessions[sessionId] === true) return true
  return defaultOn
}

function normalizeRemote(raw: unknown): RemoteState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.revision !== 'number' || !Number.isFinite(record.revision)) return null
  const offSource = typeof record.off === 'object' && record.off !== null && !Array.isArray(record.off)
    ? record.off as Record<string, unknown>
    : {}
  const off: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(offSource)) {
    if (typeof key === 'string' && key !== '' && value === true) off[key] = true
  }
  const onSource = typeof record.on === 'object' && record.on !== null && !Array.isArray(record.on)
    ? record.on as Record<string, unknown>
    : {}
  const on: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(onSource)) {
    if (typeof key === 'string' && key !== '' && value === true) on[key] = true
  }
  for (const key of Object.keys(off)) delete on[key]
  // 老 host（未重启、还没有 defaultOn 字段）不覆盖本地的默认值，否则设置页会每 2.5s 被轮询回 ON。
  const nextDefaultOn = typeof record.defaultOn === 'boolean' ? record.defaultOn : defaultOn
  return {
    off,
    on,
    defaultOn: nextDefaultOn,
    revision: Math.floor(record.revision),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

/** 采纳 host 状态；revision 没变就不 emit，避免无谓重渲染。 */
function adoptRemote(raw: unknown): void {
  const state = normalizeRemote(raw)
  if (state === null) return
  if (state.revision === revision) return
  revision = state.revision
  offSessions = state.off
  onSessions = state.on
  defaultOn = state.defaultOn
  saveOffCache(state.off)
  saveOnCache(state.on)
  saveDefaultCache(state.defaultOn)
  emit()
}

function degrade(reason: string, notice: string): void {
  hostReachable = false
  console.warn(`[dsh-tuoguan] ${reason}`)
  if (!degradeNoticeShown) {
    degradeNoticeShown = true
    showToast(notice)
  }
}

/** host 路由缺失 / 登录门禁未通过：保留本机改动，只降级，不回滚。 */
const DEGRADE_MESSAGES: Record<number, { reason: string; notice: string } | undefined> = {
  404: {
    reason: `host 路由 ${STATE_ROUTE} 不可用（HTTP 404）`,
    notice: '⚠️ 托管状态无法同步到宿主（需重启一次 DSH 启用同步）\n本次切换仅本机生效',
  },
  405: {
    reason: `host 路由 ${STATE_ROUTE} 不接受该方法（HTTP 405）`,
    notice: '⚠️ 托管状态无法同步到宿主（需重启一次 DSH 启用同步）\n本次切换仅本机生效',
  },
  401: {
    reason: `host 拒绝了托管状态请求（HTTP 401，登录态未通过）`,
    notice: '⚠️ 宿主拒绝了托管状态接口，本次切换仅本机生效',
  },
  403: {
    reason: `host 拒绝了托管状态请求（HTTP 403）`,
    notice: '⚠️ 宿主拒绝了托管状态接口，本次切换仅本机生效',
  },
}

/** 拉取 host 真值。 */
async function pullState(): Promise<void> {
  try {
    const response = await fetch(STATE_ROUTE, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    const fallback = DEGRADE_MESSAGES[response.status]
    if (fallback !== undefined) {
      degrade(fallback.reason, fallback.notice)
      return
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    adoptRemote(await response.json())
    if (!hostReachable) {
      hostReachable = true
      degradeNoticeShown = false
      console.log('[dsh-tuoguan] host 状态同步已恢复')
    }
  } catch (error) {
    // 拉取失败只静默保留上次状态（网络抖动、宿主重启瞬间），不打扰用户。
    console.warn('[dsh-tuoguan] GET 托管状态失败：', error instanceof Error ? error.message : error)
  }
}

/**
 * 切换当前会话的托管状态：乐观更新 + POST 写 host。
 * 写失败（网络 / 5xx / 400）时回滚到点击前快照并 toast；
 * host 路由缺失（404/405）或登录门禁没过（401/403）时保留本地改动并进入降级模式，
 * 约 15s 后重试，宿主恢复后自动回到同步模式 —— 开关不会成为死按钮。
 */
function setSession(sessionId: string, on: boolean): void {
  const previousOff = offSessions
  const previousOn = onSessions
  const previousRevision = revision
  const offNext: Record<string, boolean> = { ...previousOff }
  const onNext: Record<string, boolean> = { ...previousOn }
  delete offNext[sessionId]
  delete onNext[sessionId]
  // 只记「与默认不同」的显式状态，和 host 端保持同一套语义
  if (on !== defaultOn) {
    if (on) onNext[sessionId] = true
    else offNext[sessionId] = true
  }
  offSessions = offNext
  onSessions = onNext
  saveOffCache(offNext)
  saveOnCache(onNext)
  emit()

  if (!hostReachable) return

  void (async () => {
    try {
      const response = await fetch(STATE_ROUTE, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, on }),
      })
      const fallback = DEGRADE_MESSAGES[response.status]
      if (fallback !== undefined) {
        degrade(fallback.reason, fallback.notice)
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      adoptRemote(await response.json())
    } catch (error) {
      offSessions = previousOff
      onSessions = previousOn
      revision = previousRevision
      saveOffCache(previousOff)
      saveOnCache(previousOn)
      emit()
      console.warn('[dsh-tuoguan] POST 托管状态失败：', error instanceof Error ? error.message : error)
      showToast('托管状态同步失败，已回滚')
    }
  })()
}

/**
 * 改「新会话默认托管状态」（个人助手 → 托管设置）：乐观更新 + POST { defaultOn }。
 * 只影响没有显式开/关记录过的会话；已有显式状态的会话保持原样。
 */
function setDefault(on: boolean): void {
  if (defaultOn === on) return
  const previous = defaultOn
  defaultOn = on
  saveDefaultCache(on)
  emit()

  if (!hostReachable) return

  void (async () => {
    try {
      const response = await fetch(STATE_ROUTE, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ defaultOn: on }),
      })
      const fallback = DEGRADE_MESSAGES[response.status]
      if (fallback !== undefined) {
        degrade(fallback.reason, fallback.notice)
        return
      }
      // 旧 host 还没接 { defaultOn } 这个 body（会回 400 invalid-session）：保留本机设置，
      // 提示重启一次 DSH 让 host 端生效，别把它当失败回滚掉。
      if (response.status === 400) {
        degrade(
          'host 尚未支持「托管默认状态」（HTTP 400）',
          '⚠️ 默认托管状态已在本机生效；重启一次 DSH 后才会同步到其它端',
        )
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      adoptRemote(await response.json())
    } catch (error) {
      defaultOn = previous
      saveDefaultCache(previous)
      emit()
      console.warn('[dsh-tuoguan] POST 托管默认状态失败：', error instanceof Error ? error.message : error)
      showToast('托管默认状态同步失败，已回滚')
    }
  })()
}

/* ---------- 设置页接口（个人助手 → 托管） ---------- */

/** 设置页用：新会话默认托管状态。 */
export function tuoguanDefaultOn(): boolean {
  return defaultOn
}

/** 设置页用：改新会话默认托管状态（写 host，跨端同步）。 */
export function setTuoguanDefault(on: boolean): void {
  setDefault(on)
}

/** 设置页用：订阅默认状态变化（组件内调用）。 */
export function useTuoguanDefaultOn(): boolean {
  useSyncExternalStore(subscribe, snapshot, () => EMPTY_SNAPSHOT)
  return defaultOn
}

/* ---------- 轮询：让另一端在几秒内跟随 ---------- */

let pollTimer: ReturnType<typeof setInterval> | null = null
let pollTicks = 0
const detachListeners: Array<() => void> = []

function pullNow(): void {
  pollTicks = 0
  void pullState()
}

function startSync(): void {
  if (pollTimer !== null) return
  void pullState()
  if (typeof setInterval === 'function') {
    pollTimer = setInterval(() => {
      // 页面不可见时暂停轮询（省电、省请求）。
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (!hostReachable) {
        if (pollTicks % DEGRADED_POLL_FACTOR !== 0) { pollTicks += 1; return }
      }
      pollTicks += 1
      void pullState()
    }, POLL_MS)
    detachListeners.push(() => {
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
    })
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const onVisibility = () => { if (document.visibilityState === 'visible') pullNow() }
    document.addEventListener('visibilitychange', onVisibility)
    detachListeners.push(() => { document.removeEventListener('visibilitychange', onVisibility) })
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onFocus = () => { pullNow() }
    window.addEventListener('focus', onFocus)
    detachListeners.push(() => { window.removeEventListener('focus', onFocus) })
    // 手机端切回 WebView / 桌面端切回标签时也会 focus；顺带把状态在页面重新可见时立刻对齐。
    window.addEventListener('pageshow', onFocus)
    detachListeners.push(() => { window.removeEventListener('pageshow', onFocus) })
  }
}

function stopSync(): void {
  for (const detach of detachListeners.splice(0).reverse()) {
    try { detach() } catch { /* 卸载竞态无需处理 */ }
  }
  dismissToast()
}

/**
 * 客户端插件可能被热重载重新求值：全局登记上一次的卸载函数，
 * 避免旧实例的轮询与监听继续跑（那会双份轮询、且写的是已失效的状态副本）。
 */
function takeOverPreviousInstance(): void {
  const scope = globalThis as typeof globalThis & { __dshTuoguanTeardown?: () => void }
  const previous = scope.__dshTuoguanTeardown
  if (typeof previous === 'function') {
    try { previous() } catch { /* 忽略 */ }
  }
  scope.__dshTuoguanTeardown = stopSync
}

function useTuoguan(sessionId: string | undefined): boolean {
  useSyncExternalStore(subscribe, snapshot, () => EMPTY_SNAPSHOT)
  return isOn(sessionId)
}

/* ---------- 默认应答计算 ---------- */

/** 无选项问题的默认自定义回答文本。 */
const FREE_TEXT_DEFAULT = 'auto-hosting：未提供人工输入，请按默认假设继续。'

/** 取一道题的默认选中项 label：plan-review 取 approve，其余取首选项。 */
function defaultLabel(item: PendingQuestionItem): string {
  if (item.intent?.kind === 'plan-review' && typeof item.intent.approve === 'string') {
    return item.intent.approve
  }
  const first = item.options?.[0]
  return first ? first.label : FREE_TEXT_DEFAULT
}

/** 对 pending question/plan-review 生成完整答案批次。 */
function defaultQuestionAnswer(questions: PendingQuestionItem[]): unknown {
  return {
    answers: questions.map(q => {
      const label = defaultLabel(q)
      // 无选项问题：用 custom 文本回答，selected 置空。
      if (q.options === undefined || q.options.length === 0) {
        return { id: q.id, selected: [], custom: label }
      }
      return { id: q.id, selected: [label] }
    }),
  }
}

/* ---------- 自动应答组件（chain takeover，渲染为空） ---------- */

/**
 * 托管模式下抢先应答 pending interaction。
 * 挂载即 settle，不渲染任何可见 UI（官方 composer 不会渲染，
 * 默认输入条经 overlay 模式保留在下层，用户仍可输入/停止）。
 */
function TuoguanAutoAnswer({ matched }: { matched: PendingLike }) {
  const settled = useRef(false)
  useEffect(() => {
    if (settled.current) return
    settled.current = true
    const p = matched
    try {
      if (p.kind === 'approval') {
        // 审批默认放行一次（官方 ApprovalPanel 的 primary 按钮）。
        void p.answer('allowed-once')
      } else if ((p.kind === 'question' || p.kind === 'plan-review') && Array.isArray(p.questions)) {
        // 提问/plan-review：plan-review 默认批准，其余默认首选项。
        void p.answer(defaultQuestionAnswer(p.questions))
      }
    } catch { /* pending 已被 settle 或形状不符时静默忽略，正常流程兜底 */ }
  }, [matched])
  return null
}

/** 链 selector：托管开启且当前 Session 有 pending 时接管。 */
function selectPending(owner: { sessionId?: string; pendingInteraction?: unknown }): PendingLike | null {
  if (!isOn(owner.sessionId)) return null
  const p = owner.pendingInteraction
  if (p === null || p === undefined || typeof p !== 'object') return null
  const kind = (p as { kind?: unknown }).kind
  if (kind === 'question' || kind === 'plan-review' || kind === 'approval') {
    return p as PendingLike
  }
  return null
}

/* ---------- 开关按钮（conversation.input.right） ---------- */

const chipBase: CSSProperties = {
  height: 28,
  padding: '0 10px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  lineHeight: '20px',
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flex: 'none',
}

const chipOn: CSSProperties = {
  background: 'var(--dsw-alias-state-business-primary)',
  color: '#fff',
}

const chipOnHover: CSSProperties = {
  // 悬停时保持蓝色（仅轻微加深做反馈）；不要切到 --dsw-alias-interactive-bg-hover-solid，
  // 那是浅色 hover 底，开启态下会变成白底。
  background: 'var(--dsw-alias-state-business-primary)',
  color: '#fff',
  filter: 'brightness(0.93)',
}

/**
 * 托管开关：点击切换当前 Session 的自托管状态（写 host，另一端几秒内跟随）。
 * sessionId 由 register 的 inject 工厂下发（slot 本身不把 sessionId 放进 props）。
 */
function TuoguanToggle({ sessionId, locked }: { sessionId?: string; locked?: boolean }) {
  const on = useTuoguan(sessionId)
  const [hover, setHover] = useState(false)
  if (sessionId === undefined) return null
  const base = on
    ? '托管模式已开启：提问与审批将自动按默认项应答，无需人工干预'
    : '托管模式未开启：与常规对话无差别'
  const label = hostReachable
    ? `${base}\n手机与电脑共用同一状态（宿主保存）`
    : `${base}\n⚠ 当前无法与宿主同步，仅本机生效（重启 DSH 后恢复）`
  return (
    <Tooltip
      label={label}
      side="top"
      delayMs={500}
    >
      <button
        type="button"
        aria-pressed={on}
        data-tuoguan-toggle=""
        data-tuoguan-sync={hostReachable ? 'on' : 'degraded'}
        style={{
          ...chipBase,
          ...(on ? (hover ? chipOnHover : chipOn) : {}),
        }}
        disabled={locked === true}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={() => { setSession(sessionId, !on) }}
      >
        {on ? '托管 ✓' : '托管'}
      </button>
    </Tooltip>
  )
}

/* ---------- 调试辅助（控制台里核对同步状态） ---------- */

function exposeDebug(): void {
  const scope = globalThis as typeof globalThis & {
    __dshTuoguan?: {
      revision: () => number
      off: () => Record<string, boolean>
      hostReachable: () => boolean
      route: string
      refresh: () => Promise<void>
    }
  }
  scope.__dshTuoguan = {
    revision: () => revision,
    off: () => ({ ...offSessions }),
    hostReachable: () => hostReachable,
    route: STATE_ROUTE,
    refresh: async () => { await pullState() },
  }
}

/* ---------- 插件入口 ---------- */

/** Cordis 客户端服务依赖：仅 slots（register 开关 + 链 takeover）。 */
export const inject = ['slots']

/** 客户端插件体。 */
export function apply(ctx: {
  slots: {
    inject: (slot: string, factory: () => unknown) => void
    register: (options: unknown, component: unknown) => unknown
  }
}): void {
  // 状态同步：启动即拉取真值，可见时轮询，切回前台立即补拉。
  takeOverPreviousInstance()
  exposeDebug()
  startSync()

  // 开关按钮：composer 工具行右侧、模型选择器左边。
  // inject 工厂是 session 作用域槽下发 sessionId 的唯一正路（owner 只传 {}）。
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    {
      name: 'conversation.input.right',
      id: 'tuoguan-toggle',
      order: 0,
      inject: (sessionId: string) => ({ sessionId }),
    },
    TuoguanToggle,
  ))

  // 自动应答 takeover：priority -5 抢在 question composer (0) / approval panel (1) 之前。
  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    {
      name: 'conversation.composer',
      priority: -5,
      select: selectPending,
    },
    TuoguanAutoAnswer,
  ))
}
