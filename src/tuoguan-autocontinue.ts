/**
 * 托管 · 输出截断自动续写（宿主端）。
 *
 * 触发条件与聊天里那条提示**完全同源**：模型单次输出撞到输出 token 上限时，宿主用
 * `turn/end { reason: { kind: 'max-tokens' } }` 结束本轮，界面才显示
 * 「已达到输出 token 上限 / 回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出」。
 * 托管本来就是「无人值守」，这一步也该由插件自己走完：自动往该会话补一条「继续」。
 *
 * 为什么放宿主、不放客户端 composer：
 *   1. 托管的语义是「没人看着页面也照跑」——手机断线 / 页面关掉 / 只有一个后台窗口时，
 *      客户端实现就什么都不会发生；
 *   2. 页面可能同时开着好几个（电脑 + 手机 + 分栏），客户端实现会变成「谁开着谁发一条」，
 *      同一次截断被补发多遍；
 *   3. 宿主 `session/event` 是唯一的真值事件流，判定与那条提示同一个事件，不会错位。
 *
 * 发出去的是一条普通用户消息（source.kind = 'user'），所以聊天里就和一个「继续」气泡
 * 一模一样——用户看到的就是「插件替我发了继续」，不会多出一种谁也看不懂的消息类型。
 *
 * 判定链（任何一条不满足就不发）：
 *   1. `turn/end` 的 reason.kind 是 `max-tokens`；
 *   2. 该会话此刻处于托管中（宿主托管状态文件：显式关 → 否；显式开 → 是；否则跟默认值）；
 *   3. 子代理会话不续写：父会话已经按 max-tokens 收过它的结果，再让它单独多跑一轮没人收；
 *   4. 等本轮真正收尾后（`agent.whenIdle()`）仍是空闲、且 next-turn 收件箱为空——
 *      已经有人或别的插件排了活，就让那条先跑，不插队；
 *   5. 距截断不超过 `freshnessMs`（默认 90 秒）：等这么久说明中间已经有别的事接管了；
 *   6. 连续自动续写没到上限（默认 8 次）。正常结束（completed / aborted / error …）或
 *      真人发过话就清零；到上限就停手，把「继续」留给人来决定。
 *
 * 同一轮（sessionId + turn）只补一次；会话被销毁时清掉它的计数，长跑的宿主不会攒着不放。
 */

import { randomUUID } from 'node:crypto'

/** 补发的那句话：与提示里建议的一字不差。 */
export const CONTINUE_TEXT = '继续'

/** 连续自动续写上限：到顶就停手，等真人确认。 */
export const DEFAULT_MAX_CONSECUTIVE = 8

/** 截断后多久内补发还有意义。 */
export const DEFAULT_FRESHNESS_MS = 90_000

/** 托管状态文件里与「是否托管」有关的那几个字段。 */
export interface TuoguanStateLike {
  /** 被显式关闭的会话。 */
  off?: Record<string, boolean>
  /** 被显式开启的会话。 */
  on?: Record<string, boolean>
  /** 新会话默认状态；缺省 true（老行为「没关过就是托管中」）。 */
  defaultOn?: boolean
}

/** 自动续写要用到的 Agent 面（只取实际会用到的成员，方便测试注入）。 */
export interface AutoContinueAgent {
  readonly status?: string
  readonly inbox?: { readonly nextTurn?: readonly unknown[] }
  followup?: (message: unknown) => void
  whenIdle?: () => Promise<void>
}

/** 会话面：只读 id 与 header（子代理判定要用 header.origin / delegationDepth）。 */
export interface AutoContinueSession {
  readonly id?: unknown
  readonly header?: { readonly origin?: unknown; readonly delegationDepth?: unknown } | null
}

/** 自动续写的依赖（全部可注入，便于离线单测）。 */
export interface AutoContinueDeps {
  /** 读托管状态真值（宿主那份 JSON）。 */
  readState: () => TuoguanStateLike | Promise<TuoguanStateLike>
  /** 取该会话的 Agent；取不到 = 会话不在跑 / 已销毁。 */
  agentOf: (sessionId: string) => AutoContinueAgent | null | undefined
  /** 造一条「继续」用户消息；默认与官方 createUserMessage 同形（uuid + 深冻结）。 */
  createMessage?: (text: string) => unknown
  /** 等会话空闲；默认等真实 Agent 的 whenIdle，超时返回 false。 */
  waitIdle?: (agent: AutoContinueAgent, timeoutMs: number) => Promise<boolean>
  /** 日志（宿主 console / logger 由调用方决定）。 */
  log?: (message: string) => void
  /** 时钟（测试注入）。 */
  now?: () => number
  /** 连续续写上限。 */
  maxConsecutive?: number
  /** 截断后多久内补发仍有效。 */
  freshnessMs?: number
}

/** 判定某个会话此刻是否处于托管中：显式关 > 显式开 > 默认值。 */
export function tuoguanStateIsOn(state: TuoguanStateLike | null | undefined, sessionId: string): boolean {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (hasTrue(state?.off, sessionId)) return false
  if (hasTrue(state?.on, sessionId)) return true
  return state?.defaultOn !== false
}

function hasTrue(map: Record<string, boolean> | undefined, key: string): boolean {
  if (typeof map !== 'object' || map === null) return false
  return (map as Record<string, unknown>)[key] === true
}

/** 是否子代理会话：父会话已按 max-tokens 收过它的结果，再单独续写没人接收。 */
export function isSubagentSession(session: AutoContinueSession | null | undefined): boolean {
  const header = session?.header
  if (typeof header !== 'object' || header === null) return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/** 与官方 createUserMessage 同形：新 uuid + 深冻结（收件箱把它原样留着，别让谁改）。 */
export function createContinueMessage(text: string): unknown {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** 默认的「等空闲」：跟真实 Agent 的 whenIdle，超时就放弃（不重试，避免久等后补发到别的任务上）。 */
function waitIdleWithin(agent: AutoContinueAgent, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => { finish(false) }, Math.max(1000, timeoutMs))
    // 定时器不该把 Node 进程多留一会儿（宿主退出时）。
    if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref()
    }
    if (typeof agent.whenIdle !== 'function') {
      finish(agent.status === 'idle')
      return
    }
    try {
      Promise.resolve(agent.whenIdle()).then(() => { finish(true) }, () => { finish(false) })
    } catch {
      finish(false)
    }
  })
}

function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 自动续写的控制器（宿主只有一个实例）。 */
export interface AutoContinueController {
  /** 处理一条 `session/event`；非 turn/end 与非 max-tokens 只用来清零计数。 */
  handleSessionEvent(session: AutoContinueSession | null | undefined, event: unknown): void
  /** 会话销毁：清掉它的计数，长跑宿主不攒内存。 */
  handleSessionDisposed(session: AutoContinueSession | null | undefined): void
  /** 某会话当前连续续写次数（调试 / 测试）。 */
  streakOf(sessionId: string): number
  /** 某会话最后一轮已处理的 turn（同一轮不重复补发）。 */
  handledTurnOf(sessionId: string): number | undefined
  /** 等所有在飞的「等空闲 → 补发」收尾（测试用）。 */
  settled(): Promise<void>
  /** 连续续写上限。 */
  readonly maxConsecutive: number
}

/**
 * 建一个自动续写控制器（纯逻辑 + 注入依赖；宿主侧由 {@link installAutoContinue} 挂上）。
 * @param deps - 读状态、取 Agent、造消息、等空闲、日志、时钟与上限。
 * @returns 控制器；调用方把 `session/event` 转给它即可。
 */
export function createAutoContinue(deps: AutoContinueDeps): AutoContinueController {
  const maxConsecutive = normalizeLimit(deps.maxConsecutive, DEFAULT_MAX_CONSECUTIVE)
  const freshnessMs = typeof deps.freshnessMs === 'number' && deps.freshnessMs > 0 ? deps.freshnessMs : DEFAULT_FRESHNESS_MS
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const create = typeof deps.createMessage === 'function' ? deps.createMessage : createContinueMessage
  const waitIdle = typeof deps.waitIdle === 'function' ? deps.waitIdle : waitIdleWithin

  /** sessionId → 连续自动续写次数 */
  const streaks = new Map<string, number>()
  /** sessionId → 已处理过的最后一轮 turn（同一轮只补一次） */
  const handled = new Map<string, number>()
  /** 自己补发出去的消息 id（用来把「插件发的继续」和「真人说的话」分开） */
  const autoIds = new Set<string>()
  /** 在飞的补发任务 */
  const inflight = new Set<Promise<void>>()

  function track(run: Promise<void>): void {
    const task = run.then(() => undefined, () => undefined).finally(() => { inflight.delete(task) })
    inflight.add(task)
  }

  function schedule(sessionId: string, turn: number, truncatedAt: number): void {
    track((async (): Promise<void> => {
      // 先看状态：关着就不用等空闲了。
      if (!(await readOn(sessionId))) return
      const agent = deps.agentOf(sessionId)
      if (agent === null || agent === undefined || typeof agent.followup !== 'function') return
      if (!(await waitIdle(agent, freshnessMs))) return
      // 等完再核对一遍：会话可能重建、状态可能被关掉、可能已经有人排了活。
      if (deps.agentOf(sessionId) !== agent) return
      if (now() - truncatedAt > freshnessMs) return
      if (agent.status !== 'idle') return
      if (pendingTurns(agent) > 0) return
      if ((streaks.get(sessionId) ?? 0) >= maxConsecutive) return
      if (!(await readOn(sessionId))) return
      if (pendingTurns(agent) > 0) return
      const message = create(CONTINUE_TEXT)
      agent.followup(message)
      const id = (message as { id?: unknown } | null)?.id
      if (typeof id === 'string' && id !== '') {
        autoIds.add(id)
        // 只要够分辨「最近几条是不是自己发的」，不必无限攒。
        if (autoIds.size > 64) {
          const oldest = autoIds.values().next().value
          if (typeof oldest === 'string') autoIds.delete(oldest)
        }
      }
      const count = (streaks.get(sessionId) ?? 0) + 1
      streaks.set(sessionId, count)
      log(`托管自动续写：${sessionId} 第 ${count}/${maxConsecutive} 次补发「${CONTINUE_TEXT}」（turn ${turn} 输出被截断）`)
    })().catch((error: unknown) => {
      log(`托管自动续写失败（${sessionId}）：${renderThrown(error)}`)
    }))
  }

  async function readOn(sessionId: string): Promise<boolean> {
    try {
      const state = await deps.readState()
      return tuoguanStateIsOn(state, sessionId)
    } catch (error: unknown) {
      log(`托管自动续写读不到托管状态（按不续写处理）：${renderThrown(error)}`)
      return false
    }
  }

  function pendingTurns(agent: AutoContinueAgent): number {
    const list = agent.inbox?.nextTurn
    return Array.isArray(list) ? list.length : 0
  }

  return {
    maxConsecutive,
    handleSessionEvent(session, event) {
      try {
        const sessionId = typeof session?.id === 'string' ? session.id : String(session?.id ?? '')
        if (sessionId === '') return
        const type = (event as { type?: unknown } | null)?.type
        // 真人发话（不是自己补发的那条）→ 重新给满额度。
        if (type === 'user/message') {
          const id = (event as { data?: { id?: unknown } } | null)?.data?.id
          if (typeof id === 'string' && autoIds.has(id)) return
          streaks.delete(sessionId)
          return
        }
        if (type !== 'turn/end') return
        const data = (event as { data?: { turn?: unknown; reason?: { kind?: unknown } } } | null)?.data
        const reason = data?.reason?.kind
        if (reason !== 'max-tokens') {
          // 正常收尾 / 中断 / 报错：这一串截断结束了，下次数重新开始。
          streaks.delete(sessionId)
          return
        }
        const turn = typeof data?.turn === 'number' && Number.isFinite(data.turn) ? data.turn : -1
        if (handled.get(sessionId) === turn) return
        handled.set(sessionId, turn)
        if (isSubagentSession(session)) return
        if ((streaks.get(sessionId) ?? 0) >= maxConsecutive) {
          log(`托管自动续写：${sessionId} 连续 ${maxConsecutive} 次输出截断，已停止自动补发（等你确认）`)
          return
        }
        schedule(sessionId, turn, now())
      } catch (error: unknown) {
        log(`托管自动续写处理事件失败：${renderThrown(error)}`)
      }
    },
    handleSessionDisposed(session) {
      const sessionId = typeof session?.id === 'string' ? session.id : String(session?.id ?? '')
      if (sessionId === '') return
      streaks.delete(sessionId)
      handled.delete(sessionId)
    },
    streakOf(sessionId) {
      return streaks.get(sessionId) ?? 0
    },
    handledTurnOf(sessionId) {
      return handled.get(sessionId)
    },
    async settled() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const limit = Math.floor(value)
  return limit >= 1 ? limit : fallback
}

/**
 * 把自动续写挂到宿主上：订阅 `session/event`（以及 `session/disposed`），
 * 托管开着时替用户把「继续」补上。
 * @param ctx - 宿主插件上下文（要能 `on` 与 `get('agents')`）。
 * @param options - 读托管状态真值 + 日志 + 上限。
 * @returns 卸载函数。
 */
export function installAutoContinue(
  ctx: unknown,
  options: {
    readState: () => TuoguanStateLike | Promise<TuoguanStateLike>
    log?: (message: string) => void
    maxConsecutive?: number
    freshnessMs?: number
  },
): () => void {
  const scope = ctx as {
    on?: (name: string, listener: (...args: any[]) => void) => unknown
    get?: (name: string) => any
  } | null | undefined
  const log = typeof options.log === 'function'
    ? options.log
    : (message: string) => { console.warn(`[dsh-assistant] ${message}`) }
  const disposers: Array<() => void> = []
  if (scope === null || scope === undefined || typeof scope.on !== 'function') {
    log('宿主没有事件总线，托管自动续写未启用')
    return () => void 0
  }
  const controller = createAutoContinue({
    readState: options.readState,
    maxConsecutive: options.maxConsecutive,
    freshnessMs: options.freshnessMs,
    log,
    agentOf: (sessionId) => {
      try {
        const agents = typeof scope.get === 'function' ? scope.get('agents') : undefined
        return agents?.get?.(sessionId) ?? null
      } catch {
        return null
      }
    },
  })
  let wired = false
  try {
    const off = scope.on('session/event', (session: unknown, event: unknown) => {
      controller.handleSessionEvent(session as AutoContinueSession, event)
    })
    if (typeof off === 'function') {
      disposers.push(off as () => void)
      wired = true
    }
  } catch (error: unknown) {
    log(`托管自动续写挂不上 session/event：${renderThrown(error)}`)
  }
  try {
    const off = scope.on('session/disposed', (session: unknown) => {
      controller.handleSessionDisposed(session as AutoContinueSession)
    })
    if (typeof off === 'function') disposers.push(off as () => void)
  } catch { /* 老宿主没有这个事件不影响主流程 */ }
  if (wired) log(`托管自动续写已启用：输出被截断（max-tokens）时自动补发「${CONTINUE_TEXT}」，连续上限 ${controller.maxConsecutive} 次`)
  else log('托管自动续写未启用：session/event 没挂上')
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch { /* 卸载竞态无需处理 */ }
    }
  }
}
