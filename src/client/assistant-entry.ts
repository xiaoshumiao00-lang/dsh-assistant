/**
 * 私人助手的入口：每次打开**新开一条会话**，不再复用上一条。
 *
 * 为什么不是「一个常驻会话」：会话越长，上下文越大、越慢越贵，而且一旦 compaction 掉细节，
 * 助手反而忘事。真正让它「记得你」的是记忆（USER.md / MEMORY.md / assistant AGENTS.md / journal），
 * 不是那条会话的上下文。所以：
 *   - 每次进入 = 助手家目录里开一条**新会话**（同目录同模式的空白会话会被复用，不堆空白）；
 *   - 默认走 computer-use 模式（能看屏幕、点界面），不可用时退回标准模式；
 *   - 模型沿用**上一次这条会话实际在用的模型**，没有记录时退回本机上次选过的模型。
 *
 * 三条入口共用这一个动作（长按悬浮球 / 桌面全局热键 / 控制室顶栏按钮）。
 */
import { getAssistantApi, readModelPref } from './orb-bridge'
import { sessionModel } from './pocket/orb/session-plan.ts'

/** 上次打开的助手会话 id（只用于记住模型，不再复用它开新会话）。 */
const SESSION_KEY = 'dsh.assistant.sessionId'
/** 助手家目录缓存（宿主路由每次都会确保目录存在）。 */
const HOME_KEY = 'dsh.assistant.home'
/** 默认模式：桌面 GUI（dsh-orb 注册的 computer-use 预设）。 */
const ASSISTANT_PRESET = 'computer-use'

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
 * 打开私人助手（每次新会话）。
 * @param opts.forceNew - 连「同目录同模式的空白会话复用」也不要，强制建一条全新的。
 * @returns 是否已经把主界面切过去。
 */
export async function openAssistant(opts: { forceNew?: boolean } = {}): Promise<boolean> {
  if (opening !== null) return opening
  const run = (async (): Promise<boolean> => {
    const api = getAssistantApi()
    if (!api) return false
    const home = await assistantHomeDir()
    if (!home) return false

    // 1) 先从上一条助手会话读出「上一次实际用的模型」——比本地偏好更准：
    //    用户可能直接在对话页的模型胶囊里换过，那个选择只落在会话上。
    const previousId = readKey(SESSION_KEY)
    const previousRow = previousId ? api.sessionRow(previousId) : null
    const remembered = previousRow !== null ? sessionModel(previousRow) : null
    const fallback = readModelPref('cu') ?? readModelPref('standard')
    const wanted = remembered ?? fallback

    // 2) 新会话：默认 computer-use；预设不存在（dsh-orb 被停用）时退回标准模式。
    let created: { sessionId: string; appliedPreset: string | null; reused: boolean }
    try {
      created = await api.createSession(home, ASSISTANT_PRESET, { reuseBlank: opts.forceNew !== true })
    } catch {
      created = await api.createSession(home, undefined, { reuseBlank: opts.forceNew !== true })
    }
    writeKey(SESSION_KEY, created.sessionId)

    // 3) 把上次的模型落到新会话上：失败不阻塞打开（会话仍能用默认模型）。
    if (wanted) {
      try {
        await api.selectModel(created.sessionId, { provider: wanted.provider, model: wanted.model })
      } catch { /* 模型已下线/宿主拒绝：保持会话默认 */ }
    }

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

/** 助手会话默认预设（诊断/测试用）。 */
export const ASSISTANT_AGENT_PRESET = ASSISTANT_PRESET
