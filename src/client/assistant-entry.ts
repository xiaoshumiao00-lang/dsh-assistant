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
 */
import { controlRoomStore, exitWorkspace, getAssistantApi, readModelPref } from './orb-bridge.ts'
import { orbStore } from './pocket/orb/state.ts'
import { createPanelOpenGuard, type PanelOpenGuard } from './secretary-open-guard.ts'
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

/** 向宿主确认「这条固定会话还在不在宿主的会话表里」：true/false；老宿主没这字段或查不出 → null。 */
async function verifySecretaryOnHost(sessionId: string): Promise<boolean | null> {
  const id = String(sessionId ?? '').trim()
  if (id === '') return null
  try {
    const response = await fetch(SECRETARY_VERIFY_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
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

/** 宿主里的唯一 id；路由存在但返回 null 时清掉本地旧缓存。 */
async function fetchStoredSecretaryId(): Promise<string> {
  try {
    const response = await fetch(SECRETARY_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
    if (!response.ok) return readKey(CACHE_KEY)
    const body = await response.json().catch(() => null)
    const id = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (id) {
      writeKey(CACHE_KEY, id)
      return id
    }
    writeKey(CACHE_KEY, '')
    return ''
  } catch {
    return readKey(CACHE_KEY)
  }
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

/** 仅测试用：清空「已经打开过哪条」的记忆。 */
export function resetSecretaryOpenGuardForTests(): void {
  panelGuard.reset()
  lastOpen = null
  maintenance = null
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
  'maintenance-ids',
  'maintenance-verify',
  'maintenance-verify-mismatch',
  'retry-exhausted',
  'rebuild-start',
  'rebuild-created',
  'rebuild-ok',
  'rebuild-failed',
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

/** 一次「切主面板」的观测结果：opened = 主面板真的停在目标会话上。 */
interface OpenAttempt {
  opened: boolean
  attempts: number
  lastError: string
  target: string
}

function currentIs(api: OrbApi, id: string): boolean {
  try { return String(api.currentSessionId() ?? '') === id } catch { return false }
}

/**
 * 打开/复用固定秘书会话，并**直接在主面板打开这条会话**（等同从会话列表点进去）。
 * 不抛错：开页成没成、重试几次、最后什么错，全部如实返回给恢复决策（上一版这里直接丢掉失败）。
 */
function showSession(api: OrbApi, sessionId: string, limit = OPEN_RETRY_LIMIT): Promise<OpenAttempt> {
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
  return ensureShown(api, id, firstError, limit)
}

/**
 * 「真的切过去了」确认：主面板当前会话不是目标时，退避重试开页+聚焦（最多 8 次，约 20s）。
 * 冷启动第一次进秘书时，固定会话可能还没进客户端会话列表（列表有两千多行、分页下发），
 * 一次 openSession 会撞 unknown session；这里补一次重拉+重试，用完还不行就**如实返回结果**
 * （上一版是「重试 8 次然后静默放弃」= 单击悬浮球没有任何反应、也没有任何提示）。
 */
async function ensureShown(
  api: OrbApi,
  sessionId: string,
  firstError = '',
  limit = OPEN_RETRY_LIMIT,
): Promise<OpenAttempt> {
  const target = String(sessionId ?? '').trim()
  if (target === '') return { opened: false, attempts: 0, lastError: firstError, target: '' }
  const maxAttempts = Math.max(1, Math.floor(limit))
  let wait = 500
  let lastError = firstError
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
 * @param opts.surface - 兼容旧调用方（现在三条入口都落到同一个标准会话页，参数不再区分）。
 * @returns 是否已经把秘书会话送到用户面前。
 */
export function openAssistant(opts: { surface?: 'auto' | 'page' | 'host' } = {}): Promise<boolean> {
  reportOpenDiag({ step: 'openAssistant-enter', hasApi: Boolean(getAssistantApi()) })
  const api = getAssistantApi()
  if (!api) return openFallbackConsole('宿主会话 API 还没就绪（插件没拿到 sessions/uiWorkspace）', '').then(() => false)
  try { exitWorkspace() } catch { /* 收项目分栏失败不影响打开 */ }
  try { orbStore.setOpen(false, 'assistant-open') } catch { /* 悬浮球页没开 */ }
  void opts

  const cachedId = peekSecretarySessionId()
  const cachedHome = peekAssistantHome()

  if (cachedId !== '') {
    // ① 有缓存 id：先打开（0 请求 = 立刻就是标准会话页），后台校验/维护并行跑。
    //    开页失败不再被丢掉：这次开页的观测结果交给后台维护，由它决定重建还是兜底控制室。
    const attempt = showSession(api, cachedId)
    return startMaintenance(api, cachedId, cachedHome, attempt).then((result) => result !== null)
  }

  // ② 本地没有缓存 id（首次/换机/清过缓存）：先向宿主确认已有的固定会话，确实没有才建。
  //    期间主面板保持原样，不渲染任何自制骨架屏 —— 这是「骨架屏闪烁」从根上不可能再出现的原因。
  return startMaintenance(api, '', cachedHome).then((result) => result !== null)
}

/** 一次重建最多走一次「丢掉死 id、新建一条」，绝不让这条链路无限造会话。 */
const MAX_RECOVERY_ROUNDS = 1

/** 单链后台维护：校验 / 建会话 / 置顶 / 只读 / 关托管 / 持久化 /（固定会话已失效时）重建。 */
function startMaintenance(
  api: OrbApi,
  cachedId: string,
  cachedHome: string,
  attempt?: Promise<OpenAttempt>,
): Promise<AssistantOpenResult | null> {
  if (maintenance !== null) return maintenance
  maintenance = ensureSecretary(api, { cachedId, cachedHome, attempt })
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
  opts: { cachedId: string; cachedHome: string; attempt?: Promise<OpenAttempt>; recovered?: boolean },
  recoveryRound = 0,
): Promise<AssistantOpenResult | null> {
  // ① 宿主真值与家目录并行取（两个独立 GET）
  reportOpenDiag({ step: 'maintenance-start', recoveryRound })
  const [stored, home] = await Promise.all([fetchStoredSecretaryId(), assistantHomeDir()])
  reportOpenDiag({ step: 'maintenance-ids', stored, home, recoveryRound })
  const cwd = home || opts.cachedHome
  let sessionId = stored || opts.cachedId

  // ② 只信任宿主 id：**绝不因为「列表里一时看不到」就新建**。
  //    实测根因（2026-11-20 第二次）：会话列表有 2700+ 行且分页，固定会话不一定马上出现在
  //    列表投影里；上一版用 `列表已就绪 && 不存在 → 新建`，于是每次冷启动都造出一条新的
  //    「个人秘书」，固定会话越用越多（这次实测就长出 db03 / d7cb 三条）。
  //    现在只有「宿主没有 id、本地也没有 id」时才建会话（真正的首次），
  //    以及 ⑤ 里确认「宿主已经没有这条固定会话」时才重建一次（重建时 opts.recovered = true）。
  let created = false
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
  }

  // 开页放在「恢复归档 / 置顶 / 只读」之后：被归档的会话在归档状态下打不开，
  // 反过来先开页会白撞一次 unknown session。

  // ③ 固定会话恢复：这四件事互不依赖 → 并行发出
  const pinTask = api.pinSession(sessionId).then(() => true, () => false)
  const persistedTask = persistSecretaryId(sessionId)
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
  const openTask = showSession(api, sessionId)
  // 入口那次「先打开」的观测结果在这里一起等到：两条并行跑，哪次成功算哪次
  const earlier = opts.attempt ? await opts.attempt : null

  const [pinned, persisted, tuoguanOff, readOnlyResult] = await Promise.all([
    withTimeout(pinTask, MAINTENANCE_TIMEOUT_MS, false),
    withTimeout(persistedTask, MAINTENANCE_TIMEOUT_MS, false),
    withTimeout(tuoguanTask, MAINTENANCE_TIMEOUT_MS, false),
    withTimeout(readOnlyTask, MAINTENANCE_TIMEOUT_MS, { ok: false, current: null, applied: false }),
  ])

  let attempt = await openTask
  if (!attempt.opened && earlier !== null && earlier.opened) attempt = earlier

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
  if (attempt.opened) return result
  // 到底没打开成：必须给用户一个可见的结果（切控制室 + 说明原因），不许静默失败
  return openFallbackConsole(
    attempt.lastError !== '' ? `开页没成功：${attempt.lastError}` : '开页没成功（原因未知）',
    sessionId,
  )
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
      deadSignal: isDeadSessionError(holder.attempt.lastError),
      exists,
      usedExtraRetry,
      alreadyRebuilt: recoveryRound >= MAX_RECOVERY_ROUNDS,
      homeUsable: (cwd || opts.cachedHome) !== '',
    })
    if (plan.kind === 'retry-extra') {
      usedExtraRetry = true
      holder.attempt = await ensureShown(api, sessionId, attempt.lastError, OPEN_RETRY_EXTRA_LIMIT)
      continue
    }
    if (plan.kind === 'rebuild') {
      reportOpenDiag({ step: 'rebuild-start', sessionId, reason: plan.reason, recoveryRound })
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
