/**
 * 个人秘书入口：打开**唯一一条固定会话**——直接在主面板里打开，外观 100% 是 pocket
 * 现成的会话页（等同从会话列表点进去），不再有任何自制外壳。
 *
 * 2026-11-20 第二次实测反馈：
 *   - 上一版做了一整套自定义秘书页（自造顶栏 / 卡片瀑布 / 自制输入框 / 只读·托管状态条），
 *     用户要的是「长按球进去看到的就是普通会话页，除会话内容外没有额外 UI」。所以这一版
 *     把 SecretaryOverlay 整个删掉，打开动作退化成一句 `openSession(sessionId)`。
 *   - 那一版中间显示区还在「个人秘书已就位」和三条灰骨架条之间反复闪。根因是它自己写了一套
 *     三态渲染：`skeleton = !sessionId || (loading && cards.length === 0)`，而 `loading` 在
 *     每次 refresh（订阅推送 220ms 防抖 + 2s 统计轮询）都会先 true 再 false，于是
 *     「有内容 → loading 又 true（cards 被清空或还是空）→ 骨架 → 内容」来回切。
 *     删掉那套渲染后不可能再闪；这一版另外在主面板这一侧补了三道稳定态守卫（见下），
 *     保证「重复长按 / 后台维护完成」都不会把已经渲染的页面重置回去。
 *
 * 稳定态守卫（闪烁不再复发的机制保证）：
 *   1. **不再是三态渲染**：主面板由宿主渲染，插件只调用一次 openSession；这里没有任何
 *      「加载中/空/有内容」互斥状态可以互相覆盖。
 *   2. **同一条会话只开一次**（`shownSessionId`）：已经在这条会话上时，重复长按/热键
 *      只做幂等 `focus`，不再重复 openSession（重复 open 会让主面板重新装载 = 闪一下）。
 *   3. **后台维护只写快照、不碰页面**：只读/托管/置顶/改名/持久化都在后台跑，结果只进
 *      `lastOpen`，失败也不回退页面、不弹横幅。
 *
 * 安全边界（由宿主强制，不靠页面）：
 *   - 会话切到 read-only（权限预设“仅可查看”）；
 *   - 显式把会话托管关掉（托管会把审批自动答成 allowed-once，可绕过一次性升权）；
 *   - 宿主侧 assistant-secretary 工具闸拒绝 write/edit/shell/Computer Use/子代理；
 *   - 派活由秘书模型调 secretary_dispatch 建独立会话（绝不走子代理）。
 *
 * 2026-11-21 第三次实测修正（单击悬浮球仍打不开个人秘书的根因）：
 *   - 打开目标**一律以宿主 /api/assistant/secretary 的 sessionId 为准**（先取真值再开页）；
 *     localStorage 缓存（dsh.assistant.secretary.sessionId）只作乐观显示与首屏骨架，
 *     只在宿主答不上来（老宿主/网络失败）时降级试用一次。
 *   - retain 报 `unknown session` = 这条 id 已不在宿主会话表里：ensureShown 立即弃用（dead 分支），
 *     绝不退避重试满 8 次（实测坏 id 被连开 8 次、白烧 ~13 秒）。
 *   - 重建（createSession）后必须「主面板真的切过去 + 宿主会话表里确认存在」才写宿主 state；
 *     确认不了就不写（写了下次点还是白点），直接切控制室 + 显示原因。
 *   - 多客户端去抖：重建前先重读宿主 state，别的客户端刚重建过就直接采纳；
 *     同一条死 id 的重建在途去重；宿主 state 已是目标 id 时客户端跳过重复 POST，
 *     宿主侧同一 id 也跳过写盘（host-state-skip-unchanged）。
 *   - 落地断言：打开后当前会话 id 必须等于秘书会话 id（open-landed-assert），
 *     不等 → 切控制室 + 显示原因。整条链路还有 45s 看门狗兜底，绝不无反应。
 */
import { controlRoomStore, exitWorkspace, getAssistantApi, readModelPref } from './orb-bridge.ts'
import { orbStore } from './pocket/orb/state.ts'
import { createPanelOpenGuard, type PanelOpenGuard } from './secretary-open-guard.ts'
import {
  SECRETARY_SESSIONS_ROUTE,
  SWITCH_PANEL_LIMIT,
  SWITCH_QUERY_MAX,
  switchRowsFromResponse,
  type SecretarySwitchBindResult,
  type SecretarySwitchCandidates,
} from './secretary-session-switch.ts'
import {
  isDeadSessionError,
  OPEN_RETRY_EXTRA_LIMIT,
  OPEN_RETRY_LIMIT,
  openRetryWaitMs,
  planRecovery,
} from './secretary-open-recovery.ts'
import { showToast } from './toast.ts'
import type { OrbApi } from './pocket/orb/orb-api.ts'

export const SECRETARY_TITLE = '个人秘书'
/** 标准模式（空 preset id）：秘书只靠只读权限和工具闸约束，不加载 Computer Use。 */
export const ASSISTANT_AGENT_PRESET = ''
const CACHE_KEY = 'dsh.assistant.secretary.sessionId'
const HOME_KEY = 'dsh.assistant.home'
const LEGACY_SESSION_KEY = 'dsh.assistant.sessionId'
const SECRETARY_ROUTE = '/api/assistant/secretary'
/** 宿主权威版查询：固定会话到底还在不在宿主的会话表里（老宿主没这字段 → 客户端按「问不出」处理）。 */
const SECRETARY_VERIFY_ROUTE = `${SECRETARY_ROUTE}?verify=1`
/** 打开链路的落盘诊断：点击意图 / 解析到的 sessionId / 打开结果 / 失败原因（宿主替用户写进日志）。 */
const OPEN_DIAG_ROUTE = '/api/assistant/open-diag'
const TUOGUAN_ROUTE = '/.dsh-tuoguan/state'

/** 打开链路总时限：超时还没落地就必须切控制室 + 显示原因（单击绝不允许无反应）。 */
const OPEN_CHAIN_TIMEOUT_MS = 45_000
/** 向宿主要「固定会话真值」的上限：拿不到就降级（本地缓存只允许试一次、坏 id 立即弃用）。 */
const HOST_ID_TIMEOUT_MS = 3_000
/** 同一条死 id 的「重建并写 state」在途去重窗口：多客户端/重复点击不会各造一条新秘书会话。 */
const REBUILD_DEBOUNCE_MS = 60_000

/** 宿主真值快照：真值 = id；hostAnswered=false 表示宿主没答上（老宿主/网络失败），只能降级。 */
interface HostSecretarySnapshot {
  id: string
  hostAnswered: boolean
}

/** 一次打开的结果。readOnly / tuoguanOff 是“当前确认到的事实”，不是承诺。 */
export interface AssistantOpenResult {
  sessionId: string
  cwd: string
  readOnly: boolean
  tuoguanOff: boolean
  persisted: boolean
  warning: string
  /** 这条会话是「固定 id 已失效 → 新建并把宿主 state 指过去」重建出来的。 */
  recovered?: boolean
  /** 开页动作本身有没有把主面板切到这条会话上（「先打开再后台校验」的观测点）。 */
  opened?: boolean
}

function readKey(key: string): string {
  try { return String(localStorage.getItem(key) ?? '') } catch { return '' }
}

function writeKey(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch { /* 隐私模式/配额满：不阻塞打开 */ }
}

/** 已缓存的固定会话 id（没有则空串）。真值仍以宿主为准。 */
export function readAssistantSessionId(): string {
  return readKey(CACHE_KEY)
}

/** 同 readAssistantSessionId 的语义化别名。 */
export function peekSecretarySessionId(): string {
  return readKey(CACHE_KEY)
}

/** 已缓存的助手家目录（首屏直接用，避免等一次 HTTP）。 */
export function peekAssistantHome(): string {
  return readKey(HOME_KEY)
}

let homeInflight: Promise<string> | null = null

/** 助手家目录：先读缓存，没有就向宿主要一次（失败返回空串，调用方决定退让）。 */
export async function assistantHomeDir(): Promise<string> {
  const cached = readKey(HOME_KEY)
  if (cached) return cached
  if (homeInflight !== null) return homeInflight
  homeInflight = fetch('/api/assistant/home', { cache: 'no-store' })
    .then((response) => response.json())
    .then((body: any) => {
      const dir = String(body?.dir ?? '').trim()
      if (dir) writeKey(HOME_KEY, dir)
      return dir
    })
    .catch(() => '')
    .finally(() => { homeInflight = null })
  return homeInflight
}

/**
 * 向宿主确认「这条 id 还在不在宿主的会话表里」：true/false；老宿主没这字段或查不出 → null。
 * 新宿主支持 `?verify=1&sessionId=<候选 id>`：直接问候选 id（不用先把 state 写过去）。
 * 老宿主只认 state 里当前挂着的 id：回退成「state 当前 id 等于我要问的 id 才作答」。
 */
async function verifySecretaryOnHost(sessionId: string): Promise<boolean | null> {
  const id = String(sessionId ?? '').trim()
  if (id === '') return null
  try {
    const response = await fetch(`${SECRETARY_VERIFY_ROUTE}&sessionId=${encodeURIComponent(id)}&_=${Date.now()}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
    // 新宿主：queried 回显被问的那条 id，exists 就是它的真值
    if (typeof body?.queried === 'string') {
      if (body.queried !== id) return null
      return typeof body?.exists === 'boolean' ? body.exists : null
    }
    // 老宿主：只对「state 当前挂着的 id」作答
    const hostId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (hostId === '') return false
    if (hostId !== id) {
      // 宿主已经指向别处（别的页面先重建过，或这条 id 早就不在 state 里）：本轮不猜，按宿主真值走
      noteOpenDiag({ step: 'maintenance-verify-mismatch', mine: id, host: hostId })
      return null
    }
    return typeof body?.exists === 'boolean' ? body.exists : null
  } catch {
    return null
  }
}

/**
 * 读宿主里的固定会话真值（带超时；**绝不回退本地缓存决定打开目标**）。
 * 宿主答上（哪怕答「没有固定会话」）→ hostAnswered=true，调用方按权威值走；
 * 宿主没答上（老宿主没这路由 / 网络失败 / 超时）→ hostAnswered=false，调用方才可降级用本地缓存，
 * 而且降级目标只允许试一次：retain 报 unknown 立即弃用。
 */
function readHostSecretaryId(timeoutMs = HOST_ID_TIMEOUT_MS): Promise<HostSecretarySnapshot> {
  const task = fetch(SECRETARY_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) return { id: '', hostAnswered: false }
      const body = await response.json().catch(() => null)
      const id = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (id !== '') writeKey(CACHE_KEY, id)
      return { id, hostAnswered: true }
    })
    .catch(() => ({ id: '', hostAnswered: false }))
  return withTimeout(task, timeoutMs, { id: '', hostAnswered: false })
}

/** 写宿主真值；失败仍保留本地缓存（旧宿主未重启时至少本次可用），并如实返回 false。 */
async function persistSecretaryId(sessionId: string): Promise<boolean> {
  writeKey(CACHE_KEY, sessionId)
  try {
    const response = await fetch(SECRETARY_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** 向宿主要「可绑定会话」候选（宿主答不上就回 null，调用方自己降级用本地快照）。 */
export async function fetchSecretarySwitchCandidates(query = ''): Promise<SecretarySwitchCandidates | null> {
  const keyword = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, SWITCH_QUERY_MAX)
  const url = `${SECRETARY_SESSIONS_ROUTE}?limit=${String(SWITCH_PANEL_LIMIT)}${keyword !== '' ? `&q=${encodeURIComponent(keyword)}` : ''}&_=${String(Date.now())}`
  try {
    const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
    if (body === null || typeof body !== 'object' || body.ok !== true) return null
    const current = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    return {
      current,
      rows: switchRowsFromResponse(body, current),
      source: typeof body.source === 'string' ? body.source : '',
      truncated: body.truncated === true,
    }
  } catch {
    return null
  }
}

/**
 * 把个人秘书绑定换成另一条会话（控制室卡片「更换会话」按钮）。
 * 顺序是硬规矩：① 只问严格路由（后端认 id + 写盘 + 回读）；② 宿主真值回读必须是这条才更新本地缓存；
 * ③ 任何一环失败都不动本地缓存，免得下次进秘书直接点进一条坏会话（MEMORY 实测事故就是这个形状）。
 */
export async function bindSecretarySession(sessionIdRaw: string): Promise<SecretarySwitchBindResult> {
  const sessionId = String(sessionIdRaw ?? '').trim()
  if (sessionId === '') return { ok: false, sessionId: peekSecretarySessionId(), reason: '没选会话' }
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) {
    noteOpenDiag({ step: 'switch-bind-reject', sessionId, reason: 'invalid-session-id' })
    return { ok: false, sessionId: peekSecretarySessionId(), reason: '会话 id 不合法' }
  }
  try {
    const response = await fetch(SECRETARY_SESSIONS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body === null || typeof body !== 'object' || body.ok !== true) {
      const errorText = typeof body?.error === 'string' ? body.error : `HTTP ${String(response.status)}`
      const message = typeof body?.message === 'string' && body.message !== '' ? `${errorText}（${body.message}）` : errorText
      const keep = typeof body?.sessionId === 'string' ? body.sessionId.trim() : peekSecretarySessionId()
      noteOpenDiag({ step: 'switch-bind-fail', sessionId, reason: errorText })
      return { ok: false, sessionId: keep, reason: message }
    }
    const hostId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (hostId === '') return { ok: false, sessionId: peekSecretarySessionId(), reason: '宿主没回会话 id' }
    // 回读校验：拿宿主 GET 的真值再认一次（写盘与内存 ref 都变了但文件读回来不是，等于没换成）
    const truth = await readHostSecretaryId()
    if (truth.id !== hostId) {
      noteOpenDiag({ step: 'switch-read-back-mismatch', mine: hostId, host: truth.id })
      return {
        ok: false,
        sessionId: truth.id !== '' ? truth.id : peekSecretarySessionId(),
        reason: truth.id !== '' ? `宿主回读成了另一条（${truth.id}）` : '宿主回读不出这条会话',
      }
    }
    writeKey(CACHE_KEY, hostId)
    noteOpenDiag({ step: 'switch-bind-ok', sessionId: hostId, unchanged: body.unchanged === true })
    return { ok: true, sessionId: hostId, reason: '', unchanged: body.unchanged === true }
  } catch (error: any) {
    noteOpenDiag({ step: 'switch-bind-throw', sessionId, reason: String(error?.message ?? error) })
    return { ok: false, sessionId: peekSecretarySessionId(), reason: String(error?.message ?? error) }
  }
}

/** 显式关闭某会话的托管，并回读宿主确认；读到 off[id] 才算成功。 */
async function ensureTuoguanOff(sessionId: string): Promise<boolean> {
  try {
    const post = await fetch(TUOGUAN_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sessionId, on: false }),
    })
    if (!post.ok) return false
    const get = await fetch(TUOGUAN_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
    if (!get.ok) return false
    const state: any = await get.json().catch(() => null)
    return state?.off?.[sessionId] === true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 后台维护单个步骤的上限：超时按失败处理（只影响 warning，不影响开页）。 */
const MAINTENANCE_TIMEOUT_MS = 12_000

/** 给一个可能永远不 settle 的宿主调用加超时（超时返回 fallback）。 */
function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    task.catch(() => fallback),
    sleep(ms).then(() => fallback),
  ])
}

let lastOpen: AssistantOpenResult | null = null
/** 最近一次成功打开的秘书信息（诊断/测试用）。 */
export function lastAssistantOpen(): AssistantOpenResult | null {
  return lastOpen
}

/** 后台维护在途（重复长按不再叠第二条维护链）。 */
let maintenance: Promise<AssistantOpenResult | null> | null = null

/**
 * 主面板当前已经切过去的秘书会话。
 * **稳定态守卫 ②**：同一条会话重复打开时只做幂等 focus，不再重复 openSession——
 * 重复 open 会让宿主重新装载会话面（滚动位置、临时 UI 状态全丢 = 闪一下）。
 * 判定逻辑抽到 secretary-open-guard.ts，可单测。
 */
const panelGuard: PanelOpenGuard = createPanelOpenGuard()

/** 仅测试用：清空「已经打开过哪条」的记忆与重建在途标记。 */
export function resetSecretaryOpenGuardForTests(): void {
  panelGuard.reset()
  lastOpen = null
  maintenance = null
  rebuildInflightId = ''
}

/** 诊断：把每次打开动作的结论留在页面上（window.__dshAssistantOpenLog），出问题不用开 DevTools。 */
function noteOpenDiag(entry: Record<string, unknown>): void {
  try {
    const holder = window as any
    const list = Array.isArray(holder.__dshAssistantOpenLog) ? holder.__dshAssistantOpenLog : []
    list.push({ at: Date.now(), ...entry })
    holder.__dshAssistantOpenLog = list.slice(-40)
  } catch { /* 诊断失败不影响打开 */ }
}

/** 值得落盘到宿主日志的那几步（日常开页不落，免得把日志刷屏）。 */
const PERSISTED_DIAG_STEPS = new Set([
  'openAssistant-enter',
  'ball-intent',
  'openSession-threw',
  'openSession-dropped-dead-id',
  'open-target-host',
  'open-target-cache-fallback',
  'cache-realigned',
  'maintenance-ids',
  'maintenance-verify',
  'maintenance-verify-mismatch',
  'retry-exhausted',
  'rebuild-start',
  'rebuild-created',
  'rebuild-ok',
  'rebuild-failed',
  'rebuild-debounced-adopted',
  'rebuild-unconfirmed',
  'rebuild-inflight-skip',
  'persist-skip-unchanged',
  'open-landed-assert',
  'fallback-console',
  'create-session-failed',
  'maintenance-threw',
])

/** 同一条诊断既留在页面上（DevTools 不用开），也 POST 给宿主落盘（刷新页面/换窗口后还在）。 */
function reportOpenDiag(entry: Record<string, unknown>): void {
  noteOpenDiag(entry)
  const step = String(entry?.step ?? '')
  if (!PERSISTED_DIAG_STEPS.has(step) || typeof fetch !== 'function') return
  try {
    void fetch(OPEN_DIAG_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ at: new Date().toISOString(), ...entry }),
    }).catch(() => { /* 老宿主没这条路由 / 页面已关闭：不影响打开 */ })
  } catch { /* 诊断失败不影响打开 */ }
}

/** 点击意图落盘诊断（页面 poll 环与热键入口都用它：'ball-intent' 也在 PERSISTED 名单里）。 */
export function noteAssistantIntent(intent: string, source: string): void {
  reportOpenDiag({ step: 'ball-intent', intent, source })
}

/** 一次「切主面板」的观测结果：opened = 主面板真的停在目标会话上。dead = retain 明确报「这条会话不存在」。 */
interface OpenAttempt {
  opened: boolean
  attempts: number
  lastError: string
  target: string
  /** openSession 抛出的错误属于「unknown session」一类（= 这条 id 已经在宿主会话表里没了）。 */
  dead?: boolean
}

function currentIs(api: OrbApi, id: string): boolean {
  try { return String(api.currentSessionId() ?? '') === id } catch { return false }
}

/**
 * 打开/复用固定秘书会话，并**直接在主面板打开这条会话**（等同从会话列表点进去）。
 * 不抛错：开页成没成、重试几次、最后什么错，全部如实返回给恢复决策（上一版这里直接丢掉失败）。
 */
/**
 * 2026-11-21 实测修正：**retain 报 unknown session 必须先问宿主再决定弃不弃用**。
 * 两种完全不同的「unknown session」：
 *   - 宿主会话表里也没这条（exists=false）→ 真死 id：立即弃用（绝不退避重试满 8 次，
 *     实测坏 id 被连开 8 次、白烧 ~13 秒、页面一动不动）；
 *   - 宿主说「在」（exists=true）→ 客户端列表还没下发完的冷启动：保留原有退避重试。
 * 问不出（老宿主/网络失败）→ 按真死处理（降级目标本来就不该被信任）。
 */
async function probeDeadId(id: string): Promise<boolean | null> {
  return verifySecretaryOnHost(id)
}

function showSession(
  api: OrbApi,
  sessionId: string,
  limit = OPEN_RETRY_LIMIT,
  deadProbe?: (id: string) => Promise<boolean | null>,
): Promise<OpenAttempt> {
  const id = String(sessionId ?? '').trim()
  if (id === '') return Promise.resolve({ opened: false, attempts: 0, lastError: '没有固定会话 id', target: '' })
  const action = panelGuard.decide(id)
  noteOpenDiag({ step: 'showSession', id, action, current: api.currentSessionId() })
  let firstError = ''
  if (action === 'open') {
    // 同步切主面板：0 请求，立刻就是标准会话页
    try {
      api.openSession(id)
      noteOpenDiag({ step: 'openSession-called', id, current: api.currentSessionId() })
    } catch (error) {
      firstError = String(error)
      reportOpenDiag({ step: 'openSession-threw', id, error: firstError })
    }
  }
  // 幂等聚焦（只在「当前不是这条会话」时才真的动）：刚建的会话可能还差一拍才进列表
  return ensureShown(api, id, firstError, limit, deadProbe)
}

/**
 * 「真的切过去了」确认：主面板当前会话不是目标时，退避重试开页+聚焦。
 * 冷启动第一次进秘书时，固定会话可能还没进客户端会话列表（列表有两千多行、分页下发），
 * 一次 openSession 会撞 unknown session；这里补一次重拉+重试，用完还不行就**如实返回结果**
 * （上一版是「重试 8 次然后静默放弃」= 单击悬浮球没有任何反应、也没有任何提示）。
 *
 * 2026-11-21 实测修正：**retain 报 unknown session = 这条 id 已经不在宿主的会话表里**，
 * 对这样的坏 id 绝不允许再退避重试 8 次（实测白白烧 ~13 秒、期间页面一动不动）。
 * 第一次撞死就立即弃用（dead=true），交给恢复决策去换宿主 state 的 id 或重建。
 */
async function ensureShown(
  api: OrbApi,
  sessionId: string,
  firstError = '',
  limit = OPEN_RETRY_LIMIT,
  deadProbe?: (id: string) => Promise<boolean | null>,
): Promise<OpenAttempt> {
  const target = String(sessionId ?? '').trim()
  if (target === '') return { opened: false, attempts: 0, lastError: firstError, target: '', dead: firstError !== '' && isDeadSessionError(firstError) }
  const maxAttempts = Math.max(1, Math.floor(limit))
  let wait = 500
  let lastError = firstError
  // 入口那次同步 openSession 撞过 unknown session：先问宿主——真死立即弃用；宿主说「在」就是
  // 列表没下发完的冷启动，继续走下面的退避重试。
  if (lastError !== '' && isDeadSessionError(lastError)) {
    const exists = deadProbe === undefined ? null : await deadProbe(target)
    if (exists !== true) {
      reportOpenDiag({ step: 'openSession-dropped-dead-id', id: target, error: lastError, attempts: 0, exists })
      return { opened: false, attempts: 0, lastError, target, dead: true }
    }
    noteOpenDiag({ step: 'dead-but-host-says-exists', id: target })
  }
  // 冷启动时宿主还在恢复「上次打开的会话」，而且客户端会话列表可能还没把固定会话下发下来
  // （实测两千多行、分页）——此时 openSession 会撞 unknown session。所以退避重试到 ~20s，
  // 每次重试都让宿主重拉一次列表，确保最终停在固定秘书会话上（而不是空白会话）。
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (currentIs(api, target)) {
      if (attempt > 0) noteOpenDiag({ step: 'retry-ok', attempt, id: target })
      return { opened: true, attempts: attempt + 1, lastError, target }
    }
    try {
      api.openSession(target)
      noteOpenDiag({ step: 'retry-open', attempt, id: target, current: api.currentSessionId() })
      await api.focusSession(target)
    } catch (error) {
      lastError = String(error)
      noteOpenDiag({ step: 'retry-threw', attempt, id: target, error: lastError })
      if (isDeadSessionError(lastError)) {
        // 重试过程中又撞 unknown session：先问宿主再决定——真死立即弃用（不许重试满 8 次），
        // 宿主说「在」就是冷启动列表没下发完，继续退避。
        const exists = deadProbe === undefined ? null : await deadProbe(target)
        if (exists !== true) {
          reportOpenDiag({ step: 'openSession-dropped-dead-id', id: target, error: lastError, attempts: attempt + 1, exists })
          return { opened: false, attempts: attempt + 1, lastError, target, dead: true }
        }
        noteOpenDiag({ step: 'dead-but-host-says-exists', id: target, attempt: attempt + 1 })
      }
    }
    if (currentIs(api, target)) {
      noteOpenDiag({ step: 'retry-ok', attempt, id: target })
      return { opened: true, attempts: attempt + 1, lastError, target }
    }
    await sleep(wait)
    wait = openRetryWaitMs(attempt)
  }
  reportOpenDiag({ step: 'retry-exhausted', id: target, attempts: maxAttempts, error: lastError })
  return { opened: false, attempts: maxAttempts, lastError, target }
}

/**
 * 打开或复用固定秘书会话。
 *
 * 2026-11-21 根因修正：打开目标**一律以宿主 /api/assistant/secretary 的 sessionId 为准**
 * （先向宿主取真值再开页）。localStorage 缓存只作乐观显示与首屏骨架，不得决定打开哪个会话——
 * 实测客户端用 localStorage 里的死 id（已从宿主会话表消失）连开 8 次、每次 retain 都抛
 * `sessions.retain: unknown session`，白白烧 ~13 秒、页面一动不动，而宿主 state 里正确的
 * id 反而从未被打开。retain 报 unknown 立即弃用该 id（ensureShown 的 dead 分支），
 * 由恢复决策换宿主 state 的 id 或重建。
 *
 * @param opts.surface - 兼容旧调用方（现在三条入口都落到同一个标准会话页，参数不再区分）。
 * @returns 是否已经把秘书会话送到用户面前。
 */
export function openAssistant(opts: { surface?: 'auto' | 'page' | 'host' } = {}): Promise<boolean> {
  reportOpenDiag({ step: 'openAssistant-enter', hasApi: Boolean(getAssistantApi()), cached: peekSecretarySessionId() })
  const api = getAssistantApi()
  if (!api) return openFallbackConsole('宿主会话 API 还没就绪（插件没拿到 sessions/uiWorkspace）', '').then(() => false)
  try { exitWorkspace() } catch { /* 收项目分栏失败不影响打开 */ }
  try { orbStore.setOpen(false, 'assistant-open') } catch { /* 悬浮球页没开 */ }
  void opts

  const cachedId = peekSecretarySessionId()
  const cachedHome = peekAssistantHome()

  const chain = startMaintenance(api, cachedId, cachedHome)
  if (!openChainWatchdogEnabled) return chain.then((result) => result !== null)
  // 看门狗：整条链路超时还没落地 → 必须切控制室 + 显示原因（单击绝不允许无反应）。
  // 用标志位而不是 clearTimeout 取消：测试桩会把 setTimeout 压到 1ms，取消不可靠。
  let chainSettled = false
  const chainResult = chain.then((result) => { chainSettled = true; return result !== null })
  const watchdog = sleep(OPEN_CHAIN_TIMEOUT_MS).then(() => {
    if (chainSettled) return chainResult
    return openFallbackConsole(`打开个人秘书超时（${Math.round(OPEN_CHAIN_TIMEOUT_MS / 1000)} 秒没落地）`, cachedId).then(() => false)
  })
  return Promise.race([chainResult, watchdog])
}

/** 看门狗开关（默认开）：Node 回归测试把 setTimeout 压到 1ms，必须禁用看门狗保持确定性。 */
let openChainWatchdogEnabled = true
export function setOpenChainWatchdogForTests(enabled: boolean): void {
  openChainWatchdogEnabled = enabled
}

/** 一次重建最多走一次「丢掉死 id、新建一条」，绝不让这条链路无限造会话。 */
const MAX_RECOVERY_ROUNDS = 1

/** 「重建并写 state」在途去重：同一条死 id 同一时刻只允许一个客户端真的建会话。 */
let rebuildInflightId = ''

/** 单链后台维护：校验 / 建会话 / 置顶 / 只读 / 关托管 / 持久化 /（固定会话已失效时）重建。 */
function startMaintenance(
  api: OrbApi,
  cachedId: string,
  cachedHome: string,
): Promise<AssistantOpenResult | null> {
  if (maintenance !== null) return maintenance
  maintenance = ensureSecretary(api, { cachedId, cachedHome })
    .catch(async (error) => {
      console.warn('[dsh-assistant] 个人秘书后台维护失败：', error)
      reportOpenDiag({ step: 'maintenance-threw', error: String(error) })
      return openFallbackConsole(`后台维护出错：${String(error)}`, cachedId)
    })
    .finally(() => { maintenance = null })
  return maintenance
}

/** 后台维护：校验 / 建会话 / 置顶 / 只读 / 关托管 / 持久化 /（固定会话失效时）重建。任一步失败都不阻塞页面。 */
async function ensureSecretary(
  api: OrbApi,
  opts: { cachedId: string; cachedHome: string; recovered?: boolean; snapshot?: HostSecretarySnapshot },
  recoveryRound = 0,
): Promise<AssistantOpenResult | null> {
  // ① 宿主真值（带超时的权威读取）与家目录并行取；打开目标一律以宿主真值为准
  reportOpenDiag({ step: 'maintenance-start', recoveryRound })
  const [snapshot, home] = await Promise.all([opts.snapshot ?? readHostSecretaryId(), assistantHomeDir()])
  reportOpenDiag({ step: 'maintenance-ids', stored: snapshot.id, home, hostAnswered: snapshot.hostAnswered, recoveryRound })
  const cwd = home || opts.cachedHome

  // 打开目标决策：宿主答上 → 用宿主的；宿主没答上（老宿主/网络失败）→ 才降级用本地缓存，
  // 且缓存目标只允许试一次（retain 报 unknown 由 ensureShown 立即弃用，绝不重试满 8 次）。
  let sessionId = snapshot.hostAnswered ? snapshot.id : ''
  if (sessionId === '' && !snapshot.hostAnswered && opts.cachedId !== '') {
    sessionId = opts.cachedId
    reportOpenDiag({ step: 'open-target-cache-fallback', id: sessionId, recoveryRound })
  } else if (sessionId !== '' && opts.cachedId !== '' && sessionId !== opts.cachedId) {
    reportOpenDiag({ step: 'cache-realigned', cached: opts.cachedId, host: sessionId, recoveryRound })
  } else if (sessionId !== '') {
    reportOpenDiag({ step: 'open-target-host', id: sessionId, recoveryRound })
  }

  // ② 只信任宿主 id：**绝不因为「列表里一时看不到」就新建**。
  //    实测根因（2026-11-20 第二次）：会话列表有 2700+ 行且分页，固定会话不一定马上出现在
  //    列表投影里；上一版用 `列表已就绪 && 不存在 → 新建`，于是每次冷启动都造出一条新的
  //    「个人秘书」，固定会话越用越多（这次实测就长出 db03 / d7cb 三条）。
  //    现在只有「宿主没有 id、本地也没有 id」时才建会话（真正的首次），
  //    以及 ⑤ 里确认「宿主已经没有这条固定会话」时才重建一次（重建时 opts.recovered = true）。
  let created = false
  let createdAttempt: OpenAttempt | null = null
  if (sessionId === '') {
    if (cwd === '') {
      reportOpenDiag({ step: 'create-session-failed', reason: '助手家目录不可用（/api/assistant/home）', recoveryRound })
      console.warn('[dsh-assistant] 助手家目录不可用（/api/assistant/home）')
      return openFallbackConsole('助手家目录不可用，建不出秘书会话', '')
    }
    try {
      const result = await api.createSession(cwd, undefined, { reuseBlank: false })
      sessionId = result.sessionId
      created = true
      reportOpenDiag({ step: 'rebuild-created', recovered: opts.recovered === true, recoveryRound })
      writeKey(CACHE_KEY, sessionId)
    } catch (error) {
      reportOpenDiag({ step: 'create-session-failed', error: String(error), recoveryRound })
      console.warn('[dsh-assistant] 创建个人秘书会话失败：', error)
      return openFallbackConsole(`建秘书会话失败：${String(error)}`, '')
    }
    // 创建后必须 retain 成功 + 宿主会话表里确认存在，才允许把 state 写过去；
    // 确认不了就不写 state（写了下次点还是白点），直接切控制室 + 说明原因。
    createdAttempt = await showSession(api, sessionId, OPEN_RETRY_LIMIT, probeDeadId)
    const confirmed = await confirmCreatedSecretary(sessionId, createdAttempt)
    if (!confirmed.ok) {
      reportOpenDiag({ step: 'rebuild-unconfirmed', id: sessionId, reason: confirmed.reason, recoveryRound })
      return openFallbackConsole(`新建的秘书会话确认失败（${confirmed.reason}），没写入固定会话`, sessionId)
    }
  }

  // 开页放在「恢复归档 / 置顶 / 只读」之后：被归档的会话在归档状态下打不开，
  // 反过来先开页会白撞一次 unknown session。

  // ③ 固定会话恢复：这四件事互不依赖 → 并行发出
  const pinTask = api.pinSession(sessionId).then(() => true, () => false)
  // 宿主 state 里已经是这条 id 就不重复写（去抖：多客户端 / 重复点击不会互相覆盖同一文件）
  const skipPersist = !created && snapshot.hostAnswered && snapshot.id === sessionId
  if (skipPersist) reportOpenDiag({ step: 'persist-skip-unchanged', id: sessionId, recoveryRound })
  const persistedTask = skipPersist ? Promise.resolve(true) : persistSecretaryId(sessionId)
  const tuoguanTask = ensureTuoguanOff(sessionId)
  const readOnlyTask = api.setReadOnly(sessionId)
  // 恢复归档 / 重命名 / （新建时）继承模型：只为体验，失败无所谓，独立跑
  void api.unarchiveSession(sessionId).catch(() => {})
  void api.renameSession(sessionId, SECRETARY_TITLE).catch(() => {})
  if (created) {
    const remembered = sessionModelOfSafe(api, sessionId) ?? readModelPref('standard')
    if (remembered) {
      void api.selectModel(sessionId, { provider: remembered.provider, model: remembered.model }).catch(() => {})
    }
  }

  // 先把四个任务**发出去**（互不依赖，已在上面并行创建），然后立刻开页：
  // 开页绝不等待网络。实测教训：首次进入（本地无缓存 id）时，如果等 Promise.all 再开页，
  // 任何一个慢/挂住的宿主调用（实测 setReadOnly 的 /permission 命令链）都会让「长按没反应」。
  // 新建分支在确认 retain 时已经开过一次页（createdAttempt），这里直接复用那次观测。
  const openTask = createdAttempt ?? showSession(api, sessionId, OPEN_RETRY_LIMIT, probeDeadId)

  const [pinned, persisted, tuoguanOff, readOnlyResult] = await Promise.all([
    withTimeout(pinTask, MAINTENANCE_TIMEOUT_MS, false),
    withTimeout(persistedTask, MAINTENANCE_TIMEOUT_MS, false),
    withTimeout(tuoguanTask, MAINTENANCE_TIMEOUT_MS, false),
    withTimeout(readOnlyTask, MAINTENANCE_TIMEOUT_MS, { ok: false, current: null, applied: false }),
  ])

  let attempt = await openTask

  const readOnly = readOnlyResult.ok
  const warnings: string[] = []
  if (!persisted) warnings.push('固定会话 ID 未能写入宿主（重启后可能重新选一条）')
  if (!pinned) warnings.push('会话置顶失败')
  if (!readOnly) warnings.push(`只读权限未确认（当前：${readOnlyResult.current ?? '未知'}）`)
  if (!tuoguanOff) warnings.push('托管未确认关闭')

  // ⑤ 开页不成立时必须在后台校验、并给出**用户看得见的结果**：向宿主确认这条固定会话还在不在，
  //    不在 → 丢掉它、新建一条并把宿主 state 指过去；还不行 → 切控制室并说明原因。
  //    上一版到这一步就静默结束（单击悬浮球「没反应」）。
  if (!attempt.opened) {
    const holder = { attempt }
    const handled = await recoverSecretary(api, opts, recoveryRound, holder, cwd)
    attempt = holder.attempt
    if (handled !== null) return handled
  }

  const result: AssistantOpenResult = {
    sessionId,
    cwd,
    readOnly,
    tuoguanOff,
    persisted,
    warning: warnings.join('；'),
    recovered: opts.recovered === true,
    opened: attempt.opened,
  }
  lastOpen = result

  // ④ 只读还没确认 → 后台退避重读（不挡任何交互）；页面上不挂任何横幅
  if (!readOnly) {
    void api.confirmReadOnly(sessionId).then((confirmed) => {
      if (!confirmed.ok) return
      if (lastOpen !== null && lastOpen.sessionId === sessionId) lastOpen = { ...lastOpen, readOnly: true, warning: '' }
    })
  }

  // 落地断言：打开后当前会话 id 必须等于秘书会话 id。不等（面板被别的东西顶走/没切过去）
  // → 切控制室 + 显示原因。这是「单击必须落地」的硬门，绝不允许无反应。
  const currentNow = String(api.currentSessionId?.() ?? '')
  const landed = currentNow === sessionId
  reportOpenDiag({ step: 'open-landed-assert', sessionId, landed, current: currentNow, recoveryRound })
  if (!landed) {
    return openFallbackConsole(`主面板没有停在秘书会话上（当前：${currentNow || '未知'}）`, sessionId)
  }
  return result
}

/**
 * 新建的秘书会话「retain 得住」确认：
 *   1. 主面板真的切到了这条会话（showSession 的观测）；
 *   2. 向宿主确认这条 id 在宿主会话表里（exists !== false；老宿主问不出 = null 也算过——
 *      本地已能打开就是决定性证据，绝不因为老宿主答不上来就拒绝写 state）。
 * 两条都过才允许调用方把 state 写过去。
 */
async function confirmCreatedSecretary(
  sessionId: string,
  attempt: OpenAttempt,
): Promise<{ ok: boolean; reason: string }> {
  if (!attempt.opened) {
    return { ok: false, reason: attempt.lastError !== '' ? `新会话开不了页：${attempt.lastError}` : '新会话没能切到主面板' }
  }
  const exists = await verifySecretaryOnHost(sessionId)
  if (exists === false) return { ok: false, reason: '宿主会话表里查不到这条新会话（retain 不住）' }
  return { ok: true, reason: '' }
}

/**
 * 「开页没成功」的后台恢复：多等一轮 → 重建一次 → 都不行就切控制室并说明原因。
 * 决策表在 secretary-open-recovery.ts（纯函数、可单测），这里只负责按决策执行。
 */
async function recoverSecretary(
  api: OrbApi,
  opts: { cachedId: string; cachedHome: string; recovered?: boolean },
  recoveryRound: number,
  holder: { attempt: OpenAttempt },
  cwd: string,
): Promise<AssistantOpenResult | null> {
  let usedExtraRetry = false
  for (;;) {
    const attempt = holder.attempt
    const sessionId = attempt.target
    if (attempt.opened && currentIs(api, sessionId)) return null
    const exists = await verifySecretaryOnHost(sessionId)
    reportOpenDiag({
      step: 'maintenance-verify',
      sessionId,
      exists,
      attempts: attempt.attempts,
      error: attempt.lastError,
      recoveryRound,
    })
    const plan = planRecovery({
      opened: currentIs(api, sessionId),
      deadSignal: holder.attempt.dead === true || isDeadSessionError(holder.attempt.lastError),
      exists,
      usedExtraRetry,
      alreadyRebuilt: recoveryRound >= MAX_RECOVERY_ROUNDS,
      homeUsable: (cwd || opts.cachedHome) !== '',
    })
    if (plan.kind === 'retry-extra') {
      usedExtraRetry = true
      holder.attempt = await ensureShown(api, sessionId, attempt.lastError, OPEN_RETRY_EXTRA_LIMIT, probeDeadId)
      continue
    }
    if (plan.kind === 'rebuild') {
      reportOpenDiag({ step: 'rebuild-start', sessionId, reason: plan.reason, recoveryRound })
      // 多客户端去抖：重建前先重读宿主 state——别的客户端可能刚重建过并写好了 state；
      // 是的话直接采纳宿主指的那条新 id，绝不在同一时刻各造一条新秘书会话。
      const fresh = await readHostSecretaryId()
      if (fresh.hostAnswered && fresh.id !== '' && fresh.id !== sessionId) {
        reportOpenDiag({ step: 'rebuild-debounced-adopted', deadId: sessionId, adopted: fresh.id, recoveryRound })
        const adopted = await ensureSecretary(
          api,
          { cachedId: fresh.id, cachedHome: cwd || opts.cachedHome, snapshot: fresh },
          recoveryRound + 1,
        )
        if (adopted !== null) return adopted
        return openFallbackConsole('宿主已指向新秘书会话但仍打不开（已切到控制室）', sessionId)
      }
      // 同一条死 id 的重建在途去重：同一点击/本客户端重复触发不重复建会话。
      // 撞见在途重建就稍等再采纳宿主的新 id（而不是直接切控制室——那一次重建大概率能落地）。
      if (rebuildInflightId !== '') {
        reportOpenDiag({ step: 'rebuild-inflight-skip', sessionId, inflight: rebuildInflightId, recoveryRound })
        await sleep(REBUILD_DEBOUNCE_MS / 30)
        const after = await readHostSecretaryId()
        if (after.hostAnswered && after.id !== '' && after.id !== sessionId) {
          const adopted = await ensureSecretary(
            api,
            { cachedId: after.id, cachedHome: cwd || opts.cachedHome, snapshot: after },
            recoveryRound + 1,
          )
          if (adopted !== null) return adopted
        }
        return openFallbackConsole('另一条秘书会话正在重建中，请稍后再试（已切到控制室）', sessionId)
      }
      rebuildInflightId = sessionId
      try {
        // 先把这条死会话从宿主 state 里摘掉；下一轮 ① 读不到 id → ② 新建一条并把 state 指过去
        try {
          await fetch(SECRETARY_ROUTE, { method: 'DELETE', headers: { accept: 'application/json' } })
        } catch { /* 老宿主没这条路由：下面照样按「没有 id」新建 */ }
        const rebuilt = await ensureSecretary(
          api,
          { cachedId: '', cachedHome: cwd || opts.cachedHome, recovered: true },
          recoveryRound + 1,
        )
        if (rebuilt !== null) {
          reportOpenDiag({ step: 'rebuild-ok', sessionId: rebuilt.sessionId, from: sessionId })
          return rebuilt
        }
      } finally {
        rebuildInflightId = ''
      }
      reportOpenDiag({ step: 'rebuild-failed', sessionId, from: sessionId, reason: '重建后仍打不开' })
      return openFallbackConsole('重建了新秘书会话但还是打不开（已切到控制室）', sessionId)
    }
    return openFallbackConsole(plan.reason, sessionId)
  }
}

/** 兜底：主面板至少切到控制室，并把「为什么进不去」说给用户，绝不再「点了没反应」。 */
function openFallbackConsole(reason: string, sessionId: string): Promise<AssistantOpenResult | null> {
  reportOpenDiag({ step: 'fallback-console', sessionId, reason })
  try { controlRoomStore.setOpen(true) } catch { /* 控制室开不了就算了 */ }
  try { showToast(`个人秘书进不去：${reason}\n已切到控制室` ) } catch { /* toast 失败不影响打开 */ }
  return Promise.resolve(null)
}

/** 会话模型读取（API 形状变了也不让打开流程抛错）。 */
function sessionModelOfSafe(api: OrbApi, sessionId: string): { provider: string; model: string } | null {
  try {
    const row = api.sessionRow(sessionId)
    const selection = row?.modelSelection?.next ?? row?.modelSelection?.lastUsed ?? null
    return selection === null ? null : { provider: selection.provider, model: selection.model }
  } catch {
    return null
  }
}

/**
 * 发送前的只读/托管确认（宿主侧仍会重申；这里只做一次显式补偿）。
 * 标准会话页的发送按钮由宿主直接处理，插件不再自己拦消息；
 * 保留这个函数给「打开后立刻发第一条」的场景做一次确认读取。
 * @param sessionId - 固定秘书会话 id。
 * @returns 当前只读 / 托管关闭是否已确认。
 */
export async function ensureSecretaryGate(sessionId: string): Promise<{ ok: boolean; readOnly: boolean; tuoguanOff: boolean; reason: string }> {
  const api = getAssistantApi()
  const id = String(sessionId ?? '').trim()
  if (!api || id === '') return { ok: false, readOnly: false, tuoguanOff: false, reason: '秘书会话还没就绪' }
  const [readOnlyResult, tuoguanOff] = await Promise.all([
    api.permissionOf(id) === 'read-only'
      ? Promise.resolve({ ok: true, current: 'read-only', applied: false })
      : api.setReadOnly(id),
    ensureTuoguanOff(id),
  ])
  return {
    ok: readOnlyResult.ok && tuoguanOff,
    readOnly: readOnlyResult.ok,
    tuoguanOff,
    reason: readOnlyResult.ok ? (tuoguanOff ? '' : '托管没关掉') : '只读权限还没确认',
  }
}

/** URL 直达：…/?assistant=chat 打开个人秘书（重开窗口/外部唤起时用）。 */
export function assistantUrlIntent(): boolean {
  try {
    const search = String(window.location?.search ?? '')
    const hash = String(window.location?.hash ?? '')
    return /[?&]assistant=chat(?:&|$)/.test(search) || hash === '#assistant'
  } catch { return false }
}

/** 旧版一起打开过的普通助手会话 id（仅兼容读取，不参与打开流程）。 */
export function legacyAssistantSessionId(): string {
  return readKey(LEGACY_SESSION_KEY)
}
