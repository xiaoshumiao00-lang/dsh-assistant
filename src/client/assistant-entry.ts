/**
 * 个人秘书入口：打开**唯一一条固定会话**，不再每次新建。
 *
 * 三条入口共用这一个动作（长按悬浮球 / 桌面全局热键 / 控制室「个人秘书」卡）。
 * 固定会话 id 的宿主真值在 `/api/assistant/secretary`；localStorage 只做首屏缓存。
 *
 * 2026-11-20 实测反馈：长按要等好几秒才出秘书页。根因是打开流程把
 * 「校验固定会话 → 恢复归档 → 重命名 → 置顶 → 选模型 → 持久化 → 关托管 → 切只读（再串行轮询确认）→
 * 打开页面」全部串起来，任何一步慢（尤其是只读确认的 20×75ms 轮询）都挡在页面出现之前。
 *
 * 现在的顺序：
 *   1. **同步开页**：只用本地缓存（sessionId / 家目录 / 上次已知的只读与托管状态）渲染骨架屏，
 *      0 个网络请求；
 *   2. **后台并行维护**：校验 / 建会话 / 恢复归档 / 重命名 / 置顶 / 持久化 / 关托管 / 切只读
 *      各自独立发出（不再互相等待），结果到了再增量 update 页面；
 *   3. 任何一步失败都只记进 `lastAssistantOpen().warning`（诊断用）或后台重试，
 *      **绝不阻塞页面打开**，也**不在页面上挂黄字横幅**；真发消息时再拦。
 *
 * 安全边界：
 *   - 会话切到 read-only（权限预设“仅可查看”）；
 *   - 显式把会话托管关掉（托管会把审批自动答成 allowed-once，能绕过一次性升权）；
 *   - 宿主侧 assistant-secretary 工具闸拒绝 write/edit/shell/Computer Use/子代理/派单工具；
 *   - 页面上的派活创建独立会话，绝不走子代理（子代理会继承父会话的只读档）。
 */
import { getAssistantApi, readModelPref, exitWorkspace } from './orb-bridge'
import { secretaryStore } from './pocket/orb/state.ts'
import type { OrbApi } from './pocket/orb/orb-api.ts'

export const SECRETARY_TITLE = '个人秘书'
/** 标准模式（空 preset id）：秘书只靠只读权限和工具闸约束，不加载 Computer Use。 */
export const ASSISTANT_AGENT_PRESET = ''
const CACHE_KEY = 'dsh.assistant.secretary.sessionId'
const HOME_KEY = 'dsh.assistant.home'
const LEGACY_SESSION_KEY = 'dsh.assistant.sessionId'
const SECRETARY_ROUTE = '/api/assistant/secretary'
const TUOGUAN_ROUTE = '/.dsh-tuoguan/state'

/** 页面打开时拿到的秘书信息。readOnly / tuoguanOff 是"当前确认到的事实"，不是承诺。 */
export interface AssistantOpenResult {
  sessionId: string
  cwd: string
  readOnly: boolean
  tuoguanOff: boolean
  persisted: boolean
  warning: string
}

/** 发送前闸门结果：ok=false 时页面必须阻止发送并提示原因。 */
export interface AssistantSendGate {
  ok: boolean
  readOnly: boolean
  tuoguanOff: boolean
  reason: string
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

/** 已缓存的固定会话 id（没有则空串）。只给卡片/首屏做同步提示，真值仍以宿主为准。 */
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

function isPhoneViewport(): boolean {
  try { return window.matchMedia('(max-width: 640px), (pointer: coarse)').matches } catch { return false }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let lastOpen: AssistantOpenResult | null = null
/** 最近一次成功打开的秘书信息（诊断/测试用）。 */
export function lastAssistantOpen(): AssistantOpenResult | null {
  return lastOpen
}

/** 后台维护在途（重复长按不再叠第二条维护链）。 */
let maintenance: Promise<AssistantOpenResult | null> | null = null

function storeOpenFromCache(sessionId: string, cwd: string): void {
  // 上一版页面（同一次会话里）确认过的状态可以先用，避免骨架屏闪一下"未确认"。
  const previous = secretaryStore.getSnapshot()
  secretaryStore.open({
    sessionId,
    cwd,
    readOnly: previous.sessionId === sessionId ? previous.readOnly : false,
    tuoguanOff: previous.sessionId === sessionId ? previous.tuoguanOff : false,
    persisted: sessionId !== '',
    warning: '',
    phase: 'cache',
  })
}

/**
 * 打开或复用固定秘书会话。
 *
 * **同步语义**：手机端在第一次 await 之前就已经把秘书页挂上（缓存渲染），
 * 之后的校验全部在后台跑；调用方（长按/热键）不必等网络。
 *
 * @param opts.surface - auto（手机走页面、桌面走宿主） / page（强制页面） / host（强制宿主会话）。
 * @returns 是否已经把秘书送到用户面前（缓存也算送到）。
 */
export function openAssistant(opts: { surface?: 'auto' | 'page' | 'host' } = {}): Promise<boolean> {
  const api = getAssistantApi()
  if (!api) return Promise.resolve(false)
  try { exitWorkspace() } catch { /* 收项目分栏失败不影响打开 */ }

  const cachedId = peekSecretarySessionId()
  const cachedHome = peekAssistantHome()
  const wantedPage = opts.surface === 'page' || (opts.surface !== 'host' && isPhoneViewport())

  if (wantedPage) {
    // ① 先开页：0 请求、0 await
    storeOpenFromCache(cachedId, cachedHome)
  }

  // ② 后台维护：单链、并行；结果到了增量写回 store
  if (maintenance === null) {
    maintenance = ensureSecretary(api, { wantedPage, cachedId, cachedHome })
      .catch((error) => {
        console.warn('[dsh-assistant] 个人秘书后台维护失败：', error)
        return null
      })
      .finally(() => { maintenance = null })
  }
  return Promise.resolve(true)
}

/** 后台维护：校验 / 建会话 / 置顶 / 只读 / 关托管 / 持久化。任一步失败都不阻塞页面。 */
async function ensureSecretary(
  api: OrbApi,
  opts: { wantedPage: boolean; cachedId: string; cachedHome: string },
): Promise<AssistantOpenResult | null> {
  // ① 宿主真值与家目录并行取（两个独立 GET）
  const [stored, home] = await Promise.all([fetchStoredSecretaryId(), assistantHomeDir()])
  const cwd = home || opts.cachedHome
  let sessionId = stored || opts.cachedId

  // ② 列表未就绪时给一个有限等待（在后台，页面早已显示）；就绪后再判存
  if (sessionId !== '' && !api.sessionExists(sessionId)) {
    for (let i = 0; i < 12 && !api.sessionListReady(); i += 1) await sleep(100)
  }
  const listAuthoritative = api.sessionListReady()
  const exists = sessionId !== '' && api.sessionExists(sessionId)

  let created = false
  // 列表已就绪、且里面确实没有这条会话（被删/被换）→ 才重建。
  // 列表还没到就绪就先用手上的 id 打开：宁可这一次发送时报「会话不存在」，
  // 也不能在后台多建出一条秘书会话（会长出两条固定会话，谁都不对）。
  if (sessionId === '' || (listAuthoritative && !exists)) {
    if (cwd === '') {
      // 家目录都拿不到：页面留在骨架屏，不发消息也不乱建会话
      secretaryStore.update({ warning: '助手家目录不可用（/api/assistant/home）', phase: 'ready' })
      return null
    }
    try {
      const result = await api.createSession(cwd, undefined, { reuseBlank: false })
      sessionId = result.sessionId
      created = true
      writeKey(CACHE_KEY, sessionId)
      secretaryStore.update({ sessionId, cwd })
    } catch (error) {
      console.warn('[dsh-assistant] 创建个人秘书会话失败：', error)
      secretaryStore.update({ warning: '无法创建个人秘书会话', phase: 'ready' })
      return null
    }
  }

  // ③ 固定会话恢复：这四件事互不依赖 → 并行发出（以前是串行 await）
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

  const [pinned, persisted, tuoguanOff, readOnlyResult] = await Promise.all([
    pinTask,
    persistedTask,
    tuoguanTask,
    readOnlyTask,
  ])

  let readOnly = readOnlyResult.ok
  const warnings: string[] = []
  if (!persisted) warnings.push('固定会话 ID 未能写入宿主（重启后可能重新选一条）')
  if (!pinned) warnings.push('会话置顶失败')
  if (!readOnly) warnings.push(`只读权限未确认（当前：${readOnlyResult.current ?? '未知'}）`)
  if (!tuoguanOff) warnings.push('托管未确认关闭')

  const result: AssistantOpenResult = {
    sessionId,
    cwd,
    readOnly,
    tuoguanOff,
    persisted,
    warning: warnings.join('；'),
  }
  lastOpen = result

  if (opts.wantedPage) {
    secretaryStore.update({
      sessionId,
      cwd,
      readOnly,
      tuoguanOff,
      persisted,
      warning: result.warning,
      phase: 'ready',
    })
  } else {
    secretaryStore.close()
    secretaryStore.update({
      sessionId,
      cwd,
      readOnly,
      tuoguanOff,
      persisted,
      warning: result.warning,
      phase: 'ready',
    })
    const focused = await api.focusSession(sessionId)
    if (!focused.opened) {
      try { api.openSession(sessionId) } catch {}
    }
  }

  // ④ 只读还没确认 → 后台退避重读（不挡任何交互）；页面不挂横幅，只在真发消息时拦
  if (!readOnly) {
    void api.confirmReadOnly(sessionId).then((confirmed) => {
      if (!confirmed.ok) return
      readOnly = true
      if (lastOpen !== null && lastOpen.sessionId === sessionId) lastOpen = { ...lastOpen, readOnly: true, warning: '' }
      secretaryStore.update({ readOnly: true })
    })
  }
  return result
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
 * 发送前闸门：确认"只读 + 托管关闭"。
 * 页面不显示任何"未确认"横幅；只有用户真的按了发送、而这里拿不到确认时才阻止并提示。
 * @param sessionId - 固定秘书会话 id。
 * @returns ok=false 时带上人话原因。
 */
export async function ensureSecretaryGate(sessionId: string): Promise<AssistantSendGate> {
  const api = getAssistantApi()
  const id = String(sessionId ?? '').trim()
  if (!api || id === '') {
    return { ok: false, readOnly: false, tuoguanOff: false, reason: '秘书会话还没就绪，稍等一下再发' }
  }
  // 两件事并行确认（都不依赖对方）
  const [readOnlyResult, tuoguanOff] = await Promise.all([
    api.permissionOf(id) === 'read-only'
      ? Promise.resolve({ ok: true, current: 'read-only', applied: false })
      : api.setReadOnly(id),
    ensureTuoguanOff(id),
  ])
  const readOnly = readOnlyResult.ok
  secretaryStore.update({ readOnly, tuoguanOff })
  if (!readOnly) {
    return {
      ok: false,
      readOnly,
      tuoguanOff,
      reason: '只读权限还没确认，先把这条消息拦下来了（后台会继续重试；确认后可直接再发）',
    }
  }
  if (!tuoguanOff) {
    return {
      ok: false,
      readOnly,
      tuoguanOff,
      reason: '托管没关掉，这时候发消息可能被自动审批绕过只读，先拦下来了',
    }
  }
  return { ok: true, readOnly, tuoguanOff, reason: '' }
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
