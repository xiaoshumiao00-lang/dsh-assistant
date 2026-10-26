/**
 * 新建会话后的「聚焦」动作（B 修复）：把界面切到刚建的会话，并让侧栏会话列表刷新出它。
 *
 * 为什么需要单独一层（实测根因）：
 *   1) 宿主 0.2 的 `uiWorkspace.openSession(id)` 内部走 `sessions.retain(id)`，而 retain 在
 *      `resolveTarget` 里对「既不在 resident sessions、也不在列表 summaries」的 id 直接抛
 *      `sessions.retain: unknown session <id>`。会话刚建出来时客户端列表行是同步占位行、
 *      宿主摘要晚一拍才到；这一拍里调 openSession 就会抛错，旧代码吞成 console.warn，
 *      于是「会话建成功、界面没跟过去」（用户看到的第一次「点了没反应」）。
 *   2) 切过去之后还有第二种白屏：会话历史流卡在 `openState === 'loading'`。管理台主区的
 *      渲染条件是（摘自 dsh-client-ui-conversation）：
 *        settling = shellPhase==='blank' && openState==='loading' && summaryBlank!==true
 *        hero     = shellPhase==='blank' && (openState==='open' || summaryBlank===true)
 *      而 CSS `.root[data-phase=settling] .composerSeat{visibility:hidden}` —— settling 时
 *      **输入框、欢迎页、会话头（hideChrome）全部不渲染**，主区就是纯白。空白会话没有历史
 *      可读，loading 持续超过 1s 只能是流卡住，所以这里用 `session.resync()` 重建历史流把它
 *      拽出 loading（见 settleBlankHistory）。
 *
 * 另外：不依赖任何单一版本的内部字段（校验当前会话用 uiWorkspace.selection / mainReference，
 * 取不到就算成功），所有等待都有上限，绝不会把调用方挂死。
 *
 * 纯函数式、零依赖、可注入时钟 —— node 单测见 scripts/test-session-focus.mjs。
 */

/** 宿主桥（只列本模块用到的部分；其余字段原样透传不读） */
export interface FocusBridge {
  /** ctx.sessions（客户端会话服务：refresh / retainAgentScope / open / binding） */
  sessions?: any
  /** ctx.sessions.list（会话列表快照：byId / ids / current） */
  list?: any
  /** ctx.get('uiWorkspace')（0.2 当前会话选择器：openSession / selection） */
  uiWorkspace?: any
}

export interface FocusDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 宿主已确认切到新会话时立即通知；历史流修复继续在后台等待，不挡住界面切换。 */
  onOpened?: (result: FocusResult) => void
}

export interface FocusResult {
  sessionId: string
  /** 是否已把界面切到该会话 */
  opened: boolean
  /** 该会话是否已出现在宿主会话列表快照里（= 侧栏能列出它） */
  inList: boolean
  /** 是否为了让它入列而重拉过宿主列表 */
  refreshed: boolean
  /** 实际尝试打开的次数 */
  attempts: number
  /** 校验到的「当前会话」（取不到校验手段时为空串） */
  current: string
  /** 会话历史流状态：cold / loading / open / error / ''（取不到） */
  openState: string
  /** 是否已脱离 loading（UI 能渲染 hero 或对话区）。非空白会话在加载大历史属正常，按 true 处理 */
  settled: boolean
  /** 该会话是否为「空白会话」（零消息）——只有空白会话的 loading 才判定为卡死 */
  blank: boolean
  /** 为把卡住的空白会话拉出 loading 而做的 resync 次数 */
  resyncs: number
  /** 失败原因（便于诊断，不面向用户） */
  reason?: string
}

/** 新建会话后等它进列表的上限：占位行是同步的，但真实摘要/广播可能晚到 */
export const WAIT_IN_LIST_MS = 1500
/** 重拉列表后再等它入列的上限 */
export const WAIT_AFTER_REFRESH_MS = 2500
/** 单次打开后等界面状态落定的时间 */
export const WAIT_OPEN_MS = 700
/** 打开尝试次数（第一次正撞「摘要还没到」，后两次是确定性的补救） */
export const OPEN_ATTEMPTS = 3
/** 空白会话的 history 流允许的 loading 时长：超过就认定卡住（空白会话没有历史可读，
 *  健康情况是几十毫秒完成 open；700ms 只是给网络/RPC 排队留余量） */
export const WAIT_BLANK_LOADING_MS = 700
/** 每次 resync 后等流重建的时间 */
export const WAIT_RESYNC_MS = 1200
/** 最多 resync 两次（再多就是宿主侧问题，不再折腾） */
export const MAX_RESYNCS = 2
/** 轮询间隔（够细：总等待时间内能重试十几次） */
const POLL_MS = 120

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => { setTimeout(res, ms) })

/** 聚焦与常驻看门狗共用同一把 resync 锁，避免同一空白会话被并发重建历史流。 */
const blankResyncs = new Map<string, Promise<void>>()
async function resyncBlankShared(sessionId: string, session: any): Promise<void> {
  let task = blankResyncs.get(sessionId)
  if (!task) {
    task = (async () => { await session?.resync?.() })()
    blankResyncs.set(sessionId, task)
    void task.finally(() => { if (blankResyncs.get(sessionId) === task) blankResyncs.delete(sessionId) }).catch(() => {})
  }
  await task
}

/**
 * 打开并校验「当前会话」是否已切到 sessionId。
 * @returns 已切换 / 无校验手段（视为成功）/ 失败
 */
function verifyCurrent(uiWorkspace: any, sessionId: string): { known: boolean; ok: boolean; current: string } {
  try {
    const sel = uiWorkspace?.selection?.getSnapshot?.()
    const cur = String(sel?.sessionId ?? uiWorkspace?.mainReference?.sessionId ?? '')
    if (!cur) return { known: false, ok: false, current: '' }
    return { known: true, ok: cur === sessionId, current: cur }
  } catch {
    return { known: false, ok: false, current: '' }
  }
}

/** 会话面的历史流状态与「空白会话」判定（取不到返回 null，调用方不猜） */
function faceStateOf(bridge: FocusBridge | null, sessionId: string): { session: any; openState: string; blank: boolean } | null {
  try {
    const session = bridge?.sessions?.binding?.(sessionId)?.session
    if (!session) return null
    const snap = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null
    if (!snap) return null
    const row = (() => { try { return bridge?.list?.getSnapshot?.()?.byId?.[sessionId] ?? null } catch { return null } })()
    const blank = snap.blank === true || row?.blank === true
    return { session, openState: String(snap.openState ?? ''), blank }
  } catch {
    return null
  }
}

/** 读会话面的历史流状态（诊断 / 看门狗用；取不到返回 null） */
export function sessionFaceState(bridge: FocusBridge | null, sessionId: string): { openState: string; blank: boolean } | null {
  const st = faceStateOf(bridge, sessionId)
  return st ? { openState: st.openState, blank: st.blank } : null
}

/** 空白会话 + 历史流卡在 loading → 重建一次历史流。返回是否动了手。
 *  用于「已经卡住、用户直接从侧栏点开」的会话自愈（新建流程之外的兜底）。 */
export async function healBlankSessionIfStuck(bridge: FocusBridge | null, sessionId: string): Promise<boolean> {
  const st = faceStateOf(bridge, sessionId)
  if (!st || st.openState !== 'loading' || !st.blank) return false
  try {
    await resyncBlankShared(sessionId, st.session)
  } catch { return false }
  return true
}

/**
 * 把卡在 loading 的「空白会话」历史流拉出来（白屏根因兜底）。
 * 只有空白会话才动手：非空白会话可能是真在加载大历史，resync 反而添乱。
 * 判定依据：空白会话没有历史事件可读，正常应在毫秒级完成 open；持续 loading =
 * 流没吐 opening snapshot（UI 就会停在 settling：输入框被 CSS 隐藏 → 纯白）。
 */
async function settleBlankHistory(
  bridge: FocusBridge | null,
  sessionId: string,
  result: FocusResult,
  waitUntil: (pred: () => boolean, budgetMs: number) => Promise<boolean>,
): Promise<void> {
  const first = faceStateOf(bridge, sessionId)
  if (!first) { result.openState = ''; result.settled = true; return }
  result.blank = first.blank
  // 非空白会话可能真的在加载长历史：不判定、不干预
  if (!first.blank) { result.openState = first.openState; result.settled = true; return }
  if (first.openState !== 'loading') { result.openState = first.openState; result.settled = true; return }
  // 先观察一个小窗口：真的只是慢一拍就别乱动
  const leftLoading = await waitUntil(() => {
    const s = faceStateOf(bridge, sessionId)
    return !s || s.openState !== 'loading'
  }, WAIT_BLANK_LOADING_MS)
  if (leftLoading) {
    const s = faceStateOf(bridge, sessionId)
    result.openState = s?.openState ?? ''
    result.settled = true
    return
  }
  for (let i = 0; i < MAX_RESYNCS; i++) {
    const cur = faceStateOf(bridge, sessionId)
    if (!cur || cur.openState !== 'loading' || !cur.blank) break
    try {
      await resyncBlankShared(sessionId, cur.session)
    } catch { /* resync 不存在/失败：下一轮再看 */ }
    result.resyncs++
    const ok = await waitUntil(() => {
      const s = faceStateOf(bridge, sessionId)
      return !s || s.openState !== 'loading'
    }, WAIT_RESYNC_MS)
    if (ok) break
  }
  const fin = faceStateOf(bridge, sessionId)
  result.openState = fin?.openState ?? ''
  result.settled = !fin || fin.openState !== 'loading'
}

/**
 * 新建会话成功后的聚焦流程。
 * @param bridge - 宿主会话桥
 * @param sessionId - 刚创建的会话 id
 * @param deps - 时钟注入（单测用）
 * @returns 诊断结果；调用方按 opened/inList/settled 决定是否提示降级
 */
export async function focusSessionInHost(bridge: FocusBridge | null, sessionId: string, deps: FocusDeps = {}): Promise<FocusResult> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? (() => Date.now())
  const result: FocusResult = {
    sessionId, opened: false, inList: false, refreshed: false, attempts: 0, current: '',
    openState: '', settled: true, blank: false, resyncs: 0,
  }
  if (!sessionId) { result.reason = 'no-session-id'; return result }

  const snapshot = (): any => { try { return bridge?.list?.getSnapshot?.() ?? null } catch { return null } }
  const inList = (): boolean => { try { return !!(snapshot()?.byId?.[sessionId]) } catch { return false } }
  const listCurrent = (): string => { try { return String(snapshot()?.current ?? '') } catch { return '' } }
  // 未在 UI 打开过的会话没有 materialized scope：显式 retain 一次，让 binding/history 可用
  try { bridge?.sessions?.retainAgentScope?.(sessionId) } catch {}

  const waitUntil = async (pred: () => boolean, budgetMs: number): Promise<boolean> => {
    const end = now() + budgetMs
    while (now() < end) {
      if (pred()) return true
      await sleep(POLL_MS)
    }
    return pred()
  }

  // 1) 等它进列表（占位行通常同步就有；没有说明摘要/广播落后）
  if (!(await waitUntil(inList, WAIT_IN_LIST_MS))) {
    // 2) 重拉宿主会话列表基线：既是「让它进列表」的手段，也顺带刷新侧栏数据源
    try {
      const job = bridge?.sessions?.refresh?.()
      if (job && typeof job.then === 'function') await job
      result.refreshed = true
    } catch { /* 宿主没有 refresh：照常继续，后面靠 openSession 兜 */ }
    await waitUntil(inList, WAIT_AFTER_REFRESH_MS)
  }
  result.inList = inList()

  // 3) 反复尝试打开，直到校验到「当前会话 = 新会话」
  const uiWorkspace = bridge?.uiWorkspace ?? null
  /** 打开一次：'ok' = 宿主接受；'threw' = 有入口但这次被拒（典型：unknown session）；'none' = 没有入口 */
  const openOnce = (): 'ok' | 'threw' | 'none' => {
    let sawApi = false
    if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
      sawApi = true
      try { uiWorkspace.openSession(sessionId); return 'ok' } catch { /* 落到重试 / sessions.open */ }
    }
    const s = bridge?.sessions
    if (s && typeof s.open === 'function') {
      sawApi = true
      try { s.open(sessionId); return 'ok' } catch {}
    }
    return sawApi ? 'threw' : 'none'
  }

  let openable = false
  for (let i = 1; i <= OPEN_ATTEMPTS; i++) {
    result.attempts = i
    const r = openOnce()
    if (r === 'none') break
    openable = true
    if (r === 'threw') { await sleep(160); continue }
    // 校验手段探测：uiWorkspace.selection / mainReference（宿主 0.2），退化为列表快照的 current。
    // 两处都取不到（其它宿主版本）→ 宿主已接受 openSession，等一拍按成功处理。
    const probe = verifyCurrent(uiWorkspace, sessionId)
    if (!probe.known && !listCurrent()) {
      await sleep(POLL_MS)
      result.opened = true
      break
    }
    const settled = await waitUntil(() => {
      const v = verifyCurrent(uiWorkspace, sessionId)
      if (v.known) return v.ok
      return listCurrent() === sessionId
    }, WAIT_OPEN_MS)
    if (settled) { result.opened = true; break }
    // 没切过去：可能是会话刚可见但打开被宿主内部拒了一次，降一小拍再试
    await sleep(160)
  }

  const v = verifyCurrent(uiWorkspace, sessionId)
  result.current = v.current || listCurrent()
  if (!result.opened) {
    if (!openable) result.reason = 'no-open-session-api'
    else if (!result.inList) result.reason = 'not-in-host-list'
    else result.reason = 'open-not-confirmed'
  }

  // 4) 宿主已确认切换就先让调用方露出会话；空白历史流的检查与修复随后继续。
  if (result.opened) {
    try { deps.onOpened?.(result) } catch { /* 界面回调不影响聚焦诊断 */ }
    await settleBlankHistory(bridge, sessionId, result, waitUntil)
  }

  return result
}
