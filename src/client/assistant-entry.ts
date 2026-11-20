/**
 * 个人秘书入口：打开**唯一一条固定会话**，不再每次新建。
 *
 * 三条入口共用这一个动作（长按悬浮球 / 桌面全局热键 / 控制室「个人秘书」卡）。
 * 固定会话 id 的宿主真值在 `/api/assistant/secretary`；localStorage 只做首屏缓存。
 *
 * 安全边界：
 *   - 会话切到 read-only（权限预设“仅可查看”）；
 *   - 显式把会话托管关掉（托管会把审批自动答成 allowed-once，能绕过一次性升权）；
 *   - 宿主侧 assistant-secretary 工具闸拒绝 write/edit/shell/Computer Use/子代理/派单工具；
 *   - 页面上的「派活」创建独立会话，绝不走子代理（子代理会继承父会话的只读档）。
 */
import { getAssistantApi, readModelPref, exitWorkspace } from './orb-bridge'
import { secretaryStore } from './pocket/orb/state.ts'
import type { OrbApi } from './pocket/orb/orb-api.ts'

export const SECRETARY_TITLE = '个人秘书'
/** 标准模式（空 preset id）：秘书只靠只读权限和工具闸约束，不加载 Computer Use。 */
export const ASSISTANT_AGENT_PRESET = ''
const CACHE_KEY = 'dsh.assistant.secretary.sessionId'
const LEGACY_SESSION_KEY = 'dsh.assistant.sessionId'
const SECRETARY_ROUTE = '/api/assistant/secretary'
const TUOGUAN_ROUTE = '/.dsh-tuoguan/state'

export interface AssistantOpenResult {
  sessionId: string
  cwd: string
  readOnly: boolean
  tuoguanOff: boolean
  persisted: boolean
  warning: string
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

let homeInflight: Promise<string> | null = null

/** 助手家目录：先读缓存，没有就向宿主要一次（失败返回空串，调用方决定退让）。 */
export async function assistantHomeDir(): Promise<string> {
  const cached = readKey('dsh.assistant.home')
  if (cached) return cached
  if (homeInflight !== null) return homeInflight
  homeInflight = fetch('/api/assistant/home', { cache: 'no-store' })
    .then((response) => response.json())
    .then((body: any) => {
      const dir = String(body?.dir ?? '').trim()
      if (dir) writeKey('dsh.assistant.home', dir)
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

let opening: Promise<AssistantOpenResult | null> | null = null
let lastOpen: AssistantOpenResult | null = null

/** 最近一次成功打开的秘书信息（诊断/测试用）。 */
export function lastAssistantOpen(): AssistantOpenResult | null {
  return lastOpen
}

/**
 * 打开或复用固定秘书会话。
 * @param opts.surface - auto（手机走页面、桌面走宿主） / page（强制页面） / host（强制宿主会话）。
 * @returns 是否已经把秘书送到用户面前。
 */
export async function openAssistant(opts: { surface?: 'auto' | 'page' | 'host' } = {}): Promise<boolean> {
  if (opening !== null) {
    const pending = await opening
    return pending !== null
  }
  const run = (async (): Promise<AssistantOpenResult | null> => {
    const api = getAssistantApi()
    if (!api) return null
    exitWorkspace()
    const home = await assistantHomeDir()
    if (!home) return null

    const wantedPage = opts.surface === 'page' || (opts.surface !== 'host' && isPhoneViewport())
    const stored = await fetchStoredSecretaryId()
    let sessionId = ''

    if (stored) {
      // 列表还没到 ready 时不要急着判“会话不存在”，否则会在宿主冷启动时多建一条。
      if (!api.sessionExists(stored)) {
        for (let i = 0; i < 20 && !api.sessionListReady(); i += 1) await sleep(100)
      }
      if (api.sessionExists(stored)) sessionId = stored
    }

    const previousId = sessionId || stored || readKey(LEGACY_SESSION_KEY)
    const previousRow = previousId ? api.sessionRow(previousId) : null
    const remembered = previousRow ? sessionModelOf(previousRow) : null
    const fallback = readModelPref('standard')

    let created = false
    if (sessionId === '') {
      try {
        const result = await api.createSession(home, undefined, { reuseBlank: false })
        sessionId = result.sessionId
        created = true
      } catch (error) {
        console.warn('[dsh-assistant] 创建个人秘书会话失败：', error)
        return null
      }
    }

    // 固定会话恢复：归档的会话先拉回列表，再置顶。失败不伪装成功。
    try { await api.unarchiveSession(sessionId) } catch { /* 本来就没归档 */ }
    try { await api.renameSession(sessionId, SECRETARY_TITLE) } catch { /* 标题不是功能依赖 */ }
    let pinned = true
    try { await api.pinSession(sessionId) } catch { pinned = false }

    // 新会话才继承上次模型；已有固定会话不覆盖用户当前模型。
    if (created) {
      const wanted = remembered ?? fallback
      if (wanted) {
        try {
          await api.selectModel(sessionId, { provider: wanted.provider, model: wanted.model })
        } catch { /* 模型失效时保留宿主默认 */ }
      }
    }

    const persisted = await persistSecretaryId(sessionId)
    const tuoguanOff = await ensureTuoguanOff(sessionId)
    const readOnlyResult = await api.setReadOnly(sessionId)
    const readOnly = readOnlyResult.ok
    const warnings: string[] = []
    if (!persisted) warnings.push('固定会话 ID 未能写入宿主（重启后可能重新选一条）')
    if (!pinned) warnings.push('会话置顶失败')
    if (!readOnly) warnings.push(`只读权限未确认（当前：${readOnlyResult.current ?? '未知'}）`)
    if (!tuoguanOff) warnings.push('托管未确认关闭，发送已禁用')

    const result: AssistantOpenResult = {
      sessionId,
      cwd: home,
      readOnly,
      tuoguanOff,
      persisted,
      warning: warnings.join('；'),
    }
    lastOpen = result

    if (wantedPage) {
      secretaryStore.open({
        sessionId: result.sessionId,
        cwd: result.cwd,
        readOnly: result.readOnly,
        tuoguanOff: result.tuoguanOff,
        persisted: result.persisted,
        warning: result.warning,
      })
    } else {
      secretaryStore.close()
      secretaryStore.update({
        sessionId: result.sessionId,
        cwd: result.cwd,
        readOnly: result.readOnly,
        tuoguanOff: result.tuoguanOff,
        persisted: result.persisted,
        warning: result.warning,
      })
      const focused = await api.focusSession(sessionId)
      if (!focused.opened) {
        try { api.openSession(sessionId) } catch {}
      }
    }
    return result
  })()

  opening = run
  try {
    const result = await run
    return result !== null
  } catch (error) {
    console.warn('[dsh-assistant] 打开个人秘书失败：', error)
    return false
  } finally {
    opening = null
  }
}

function sessionModelOf(row: ReturnType<OrbApi['sessionRow']>): { provider: string; model: string } | null {
  const selection = row?.modelSelection?.next ?? row?.modelSelection?.lastUsed ?? null
  return selection === null ? null : { provider: selection.provider, model: selection.model }
}

/** URL 直达：…/?assistant=chat 打开个人秘书（重开窗口/外部唤起时用）。 */
export function assistantUrlIntent(): boolean {
  try {
    const search = String(window.location?.search ?? '')
    const hash = String(window.location?.hash ?? '')
    return /[?&]assistant=chat(?:&|$)/.test(search) || hash === '#assistant'
  } catch { return false }
}
