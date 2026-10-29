/**
 * 私人助手的入口：把主界面切到「助手常驻会话」，而不是开一张项目卡片。
 *
 * 三条入口共用这一个动作（长按悬浮球 / 桌面全局热键 / 控制室顶栏按钮）：
 *   1. 助手会话固定落在助手家目录（宿主 /api/assistant/home 给出，目录里有 AGENTS.md 人设）；
 *   2. 优先续上一次那条助手会话（localStorage 记 id），不每条消息新建；
 *   3. 会话还没进宿主列表时走 sessionFocus 的重试链路，避免「点了没反应」。
 *
 * 为什么不做专门的聊天 UI：DSH 自己的会话面板就是最好的聊天界面（工具卡片、
 * 附件、语音、中断都在），助手只是「固定在某个目录的一条会话」。
 */
import { getAssistantApi } from './orb-bridge'

/** 上次打开的助手会话 id。 */
const SESSION_KEY = 'dsh.assistant.sessionId'
/** 助手家目录缓存（宿主路由每次都会确保目录存在）。 */
const HOME_KEY = 'dsh.assistant.home'

function readKey(key: string): string {
  try { return String(localStorage.getItem(key) ?? '') } catch { return '' }
}

function writeKey(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch { /* 隐私模式/配额满：不阻塞打开 */ }
}

/** 已记住的助手会话 id（没有则空串）。 */
export function readAssistantSessionId(): string {
  return readKey(SESSION_KEY)
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

let opening: Promise<boolean> | null = null

/**
 * 打开私人助手。
 * @param opts.forceNew - 忽略上次的会话，在助手目录里开一条新的。
 * @returns 是否已经把主界面切过去。
 */
export async function openAssistant(opts: { forceNew?: boolean } = {}): Promise<boolean> {
  if (opening !== null) return opening
  const run = (async (): Promise<boolean> => {
    const api = getAssistantApi()
    if (!api) return false
    const saved = readKey(SESSION_KEY)
    if (!opts.forceNew && saved && api.sessionRow(saved) !== null) {
      const focused = await api.focusSession(saved)
      if (focused.opened) return true
    }
    const home = await assistantHomeDir()
    if (!home) return false
    // 同目录同模式已有空白会话时 createSession 会复用，不会每次留一串空白会话。
    const created = await api.createSession(home)
    writeKey(SESSION_KEY, created.sessionId)
    const focused = await api.focusSession(created.sessionId)
    return focused.opened
  })()
  opening = run.finally(() => { opening = null })
  return opening
}

/** URL 直达：…/?assistant=chat 打开私人助手（重开窗口/外部唤起时用）。 */
export function assistantUrlIntent(): boolean {
  try {
    const search = String(window.location?.search ?? '')
    const hash = String(window.location?.hash ?? '')
    return /[?&]assistant=chat(?:&|$)/.test(search) || hash === '#assistant'
  } catch { return false }
}
