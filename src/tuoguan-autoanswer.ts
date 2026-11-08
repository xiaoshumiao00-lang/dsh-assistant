/**
 * 托管 · 决策自动应答（宿主端）。
 *
 * 为什么要有这一层：托管最早的自动应答长在客户端（`src/client/tuoguan.tsx` 的
 * `conversation.composer` 链，priority -5）。那条链只在**会话被打开、composer 真的渲染出来**
 * 时才会挂载，于是请求虽然进了浏览器，却挂在一个没人渲染的 pending 上：
 * 控制室只看列表、手机没连、电脑开着别的会话时，提问 / 审批就一直等，
 * 表现就是「托管明明开着，还得把会话点进去才自动通过」。
 *
 * 现在把这一步搬到宿主：宿主直接监听 `approval/request` 与 `user-questions/request`
 * 两道 waterfall，托管开着就现场给出默认答案——
 *   - 审批（含沙箱升级、工具权限）：`allowed-once`（与卡片上的主按钮同一个结果）；
 *   - plan-review：选 `intent.approve` 指定的那个选项；
 *   - 其余提问：选首选项；没有选项就回一段自由文本。
 * 用 `prepend: true` 注册，抢在 `@deepseek-ai/dsh-api-remotes` 把请求转发给浏览器之前作答，
 * 所以浏览器连不连、那个会话开不开，都不影响结果。
 *
 * 关掉托管（会话级开关或「新会话默认开启托管」）时一句 `next()` 原样放行，
 * 官方审批卡 / 提问卡照旧由客户端渲染——插件绝不替用户决定「托管之外」的事。
 *
 * 子代理的审批跟着父会话的开关走（见 {@link sessionAncestry}）：托管是按对话开的，
 * 一个被关掉托管的对话，它派出去的子代理也不该在背后自动放行。
 */

/** 无选项问题的默认自由文本回答（与客户端旧实现同一句，历史记录还能对上）。 */
export const FREE_TEXT_DEFAULT = 'auto-hosting：未提供人工输入，请按默认假设继续。'

/** 审批自动放行的结果：与官方 ApprovalPanel 的 primary 按钮一致。 */
export const APPROVAL_OUTCOME = 'allowed-once'

/** 托管状态文件里与「是否托管」有关的那几个字段（与自动续写共用同一套语义）。 */
export interface TuoguanStateLike {
  /** 被显式关闭的会话。 */
  off?: Record<string, boolean>
  /** 被显式开启的会话。 */
  on?: Record<string, boolean>
  /** 新会话默认状态；缺省 true（老行为「没关过就是托管中」）。 */
  defaultOn?: boolean
}

/** 一道题的选项（只读 label）。 */
export interface AutoAnswerQuestionOption {
  readonly label?: unknown
}

/** 一道待答的题（宿主侧只关心 id / 选项 / plan-review 意图）。 */
export interface AutoAnswerQuestion {
  readonly id?: unknown
  readonly options?: readonly AutoAnswerQuestionOption[] | null
  readonly intent?: { readonly kind?: unknown; readonly approve?: unknown } | null
}

/** 会话头里与「子代理继承」有关的那几项。 */
export interface AutoAnswerHeaderLike {
  readonly origin?: unknown
  readonly parentSession?: unknown
  readonly delegationDepth?: unknown
}

/** 请求里带的 Agent 面（只读 session）。 */
export interface AutoAnswerAgentLike {
  readonly session?: {
    readonly id?: unknown
    readonly header?: AutoAnswerHeaderLike | null
  } | null
}

/** 两道 waterfall 请求的共同形状（审批只看 agent / toolName，提问再看 questions）。 */
export interface AutoAnswerRequestLike {
  readonly agent?: AutoAnswerAgentLike | null
  readonly toolName?: unknown
  readonly questions?: readonly AutoAnswerQuestion[] | null
}

/* ---------- 状态判定 ---------- */

function hasTrue(map: Record<string, boolean> | undefined, key: string): boolean {
  if (typeof map !== 'object' || map === null) return false
  return (map as Record<string, unknown>)[key] === true
}

/**
 * 顺着会话链判定托管状态：**离自己最近的显式设置优先**，都没有才用默认值。
 * @param state - 宿主托管状态。
 * @param chain - 会话 id 链，自己在前、父 / 根在后（见 {@link sessionAncestry}）。
 * @returns 该会话此刻是否处于托管中。
 */
export function tuoguanOnForChain(
  state: TuoguanStateLike | null | undefined,
  chain: readonly string[],
): boolean {
  for (const sessionId of chain) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (hasTrue(state?.off, sessionId)) return false
    if (hasTrue(state?.on, sessionId)) return true
  }
  return state?.defaultOn !== false
}

/**
 * 会话链：自己 → 父 → 根。只沿**委托会话**往上走（`origin: 'subagent'` 或
 * `delegationDepth > 0`）；普通 fork（深度 0、带 parentSession）不继承，
 * 免得「从 A 复制出来的 B」莫名其妙跟着 A 的开关走。
 * @param sessionId - 请求所在的会话。
 * @param agentOf - 按 id 取活着的 Agent（拿不到就停）。
 * @returns 会话 id 链，第一个永远是自己。
 */
export function sessionAncestry(
  sessionId: string,
  agentOf: (id: string) => AutoAnswerAgentLike | null | undefined,
): string[] {
  const chain = [sessionId]
  let current = sessionId
  for (let depth = 0; depth < 16; depth += 1) {
    const header = safeHeader(agentOf, current)
    if (header === null) break
    const delegated = header.origin === 'subagent'
      || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
    if (!delegated) break
    const parent = header.parentSession
    if (typeof parent !== 'string' || parent === '' || parent === current) break
    chain.push(parent)
    current = parent
  }
  return chain
}

function safeHeader(
  agentOf: (id: string) => AutoAnswerAgentLike | null | undefined,
  sessionId: string,
): AutoAnswerHeaderLike | null {
  try {
    const header = agentOf(sessionId)?.session?.header
    return typeof header === 'object' && header !== null ? header : null
  } catch {
    return null
  }
}

/* ---------- 默认答案 ---------- */

/** 请求所属的 sessionId；拿不到就返回空串（调用方一律放行给人工）。 */
export function sessionIdOf(request: AutoAnswerRequestLike | null | undefined): string {
  const id = request?.agent?.session?.id
  return typeof id === 'string' ? id : ''
}

/**
 * 一道题的默认选中项：plan-review 取 `intent.approve`，其余取首选项；
 * 没有选项就回自由文本（与客户端旧的 `FREE_TEXT_DEFAULT` 同一句）。
 * @param question - 一道待答题。
 * @returns 选中项的 label，或自由文本。
 */
export function defaultAnswerLabel(question: AutoAnswerQuestion | null | undefined): string {
  const intent = question?.intent
  if (intent?.kind === 'plan-review' && typeof intent.approve === 'string' && intent.approve !== '') {
    return intent.approve
  }
  const first = question?.options?.[0]
  const label = first?.label
  return typeof label === 'string' && label !== '' ? label : FREE_TEXT_DEFAULT
}

/**
 * 一整批默认答案（`ask_user_question` 的返回形状）。
 * @param questions - 请求里的全部题目。
 * @returns `{ answers: [{ id, selected, custom? }] }`。
 */
export function defaultAnswerBatch(
  questions: readonly AutoAnswerQuestion[],
): { answers: Array<{ id: string; selected: string[]; custom?: string }> } {
  return {
    answers: questions.map((question) => {
      const id = typeof question?.id === 'string' ? question.id : String(question?.id ?? '')
      const label = defaultAnswerLabel(question)
      const options = question?.options
      // 没有选项：用 custom 文本回答，selected 留空（与官方提问面板的「其它」一致）。
      if (!Array.isArray(options) || options.length === 0) return { id, selected: [], custom: label }
      return { id, selected: [label] }
    }),
  }
}

/* ---------- 控制器（纯逻辑，依赖可注入） ---------- */

/** 自动应答的依赖。 */
export interface AutoAnswerDeps {
  /** 读托管状态真值（宿主那份 JSON）。 */
  readState: () => TuoguanStateLike | null | undefined | Promise<TuoguanStateLike | null | undefined>
  /** 会话链（子代理继承用）；缺省只判自己。 */
  ancestryOf?: (sessionId: string) => readonly string[]
  /** 日志。 */
  log?: (message: string) => void
}

/** 自动应答控制器（宿主只有一个实例）。 */
export interface AutoAnswerController {
  /** 某会话此刻是否处于托管中（读不到状态一律按「不托管」处理，绝不猜着放行）。 */
  isOnFor(sessionId: string): Promise<boolean>
  /** `approval/request`：托管开 → `allowed-once`；关 → `next()`。 */
  answerApproval(request: AutoAnswerRequestLike | null | undefined, next: () => Promise<unknown>): Promise<unknown>
  /** `user-questions/request`：托管开 → 默认答案批次；关 → `next()`。 */
  answerQuestion(request: AutoAnswerRequestLike | null | undefined, next: () => Promise<unknown>): Promise<unknown>
}

/**
 * 建一个自动应答控制器。
 * @param deps - 读状态、会话链、日志。
 * @returns 控制器；宿主侧由 {@link installAutoAnswer} 挂上两道 waterfall。
 */
export function createAutoAnswer(deps: AutoAnswerDeps): AutoAnswerController {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const ancestryOf = typeof deps.ancestryOf === 'function'
    ? deps.ancestryOf
    : (sessionId: string) => [sessionId]
  // 只读门控与自动应答共用同一份判定（见 createTuoguanGate）：
  // 显式 off > 显式 on > 默认值；读不到状态 / 拿不到会话链 → 不托管。
  const gated = createTuoguanGate({ readState: deps.readState, ancestryOf, log })

  async function isOnFor(sessionId: string): Promise<boolean> {
    return gated(sessionId)
  }

  return {
    isOnFor,
    async answerApproval(request, next) {
      const sessionId = sessionIdOf(request)
      if (sessionId === '') return next()
      if (!(await isOnFor(sessionId))) return next()
      const toolName = typeof request?.toolName === 'string' && request.toolName !== ''
        ? request.toolName
        : 'unknown'
      log(`托管自动应答：${sessionId} 审批 ${toolName} → ${APPROVAL_OUTCOME}`)
      return APPROVAL_OUTCOME
    },
    async answerQuestion(request, next) {
      const sessionId = sessionIdOf(request)
      if (sessionId === '') return next()
      const questions = Array.isArray(request?.questions) ? request.questions : []
      if (questions.length === 0) return next()
      // 缺 id 的题没法按官方契约作答（答案批次必须一题一条、id 对得上），交回人工。
      if (questions.some((question) => typeof question?.id !== 'string' || question.id === '')) return next()
      if (!(await isOnFor(sessionId))) return next()
      const batch = defaultAnswerBatch(questions)
      const labels = batch.answers.map((answer) => (answer.custom ?? answer.selected[0] ?? '')).join(' / ')
      log(`托管自动应答：${sessionId} 提问 ${questions.length} 题 → ${labels}`)
      return batch
    },
  }
}

/** 只读门控的依赖（与自动应答共用同一套读状态 + 会话链）。 */
export interface TuoguanGateDeps {
  /** 读托管状态真值（宿主那份 JSON）。 */
  readState: AutoAnswerDeps['readState']
  /** 会话链（子代理继承用）；缺省只判自己。 */
  ancestryOf?: (sessionId: string) => readonly string[]
  /** 日志。 */
  log?: (message: string) => void
}

/**
 * 只读门控：`(sessionId, parentSessionId?) => Promise<boolean>`，判定与自动应答完全同源
 * （{@link tuoguanOnForChain} + {@link sessionAncestry}）。
 *
 * 后台 Code 会话由 CU 会话派出去，但它在会话头里没有 parentSession（不是子代理），
 * 所以允许调用方额外传一个「派出它的会话」：它接在会话链最后，仍服从
 * 「离自己最近的显式设置优先」——CU 会话被显式关掉时，后台会话也跟着闭嘴。
 *
 * 读不到状态、拿不到会话链、id 不合法 → false（按不托管处理，绝不猜着放行）。
 * @param deps - 读状态、会话链、日志。
 * @returns 门控函数。
 */
export function createTuoguanGate(
  deps: TuoguanGateDeps,
): (sessionId: string, parentSessionId?: string) => Promise<boolean> {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const ancestryOf = typeof deps.ancestryOf === 'function'
    ? deps.ancestryOf
    : (sessionId: string) => [sessionId]
  const chainOf = (sessionId: string): string[] => {
    try {
      const chain = ancestryOf(sessionId)
      return Array.isArray(chain) && chain.length > 0 ? chain : [sessionId]
    } catch {
      return [sessionId]
    }
  }
  return async function isOnFor(sessionId: string, parentSessionId?: string): Promise<boolean> {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    try {
      const state = await deps.readState()
      const chain = chainOf(sessionId)
      // 后台 Code 会话的「派出者」不是会话头里的父会话，这里显式接到链尾（含它自己的祖先）。
      if (typeof parentSessionId === 'string' && parentSessionId !== '' && !chain.includes(parentSessionId)) {
        for (const id of chainOf(parentSessionId)) if (!chain.includes(id)) chain.push(id)
      }
      return tuoguanOnForChain(state, chain)
    } catch (error: unknown) {
      log(`托管门控读不到托管状态（按不托管处理）：${renderThrown(error)}`)
      return false
    }
  }
}

function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ---------- 安装到宿主 ---------- */

/** 安装参数。 */
export interface InstallAutoAnswerOptions {
  /** 读托管状态真值。 */
  readState: AutoAnswerDeps['readState']
  /** 日志。 */
  log?: (message: string) => void
  /** 按 id 取 Agent（不传就自己 `ctx.get('agents')`）。 */
  agentOf?: (sessionId: string) => AutoAnswerAgentLike | null | undefined
}

/**
 * 把决策自动应答挂到宿主的两道 waterfall 上。
 *
 * 两个监听都用 `{ prepend: true }`：`approval/request` 与 `user-questions/request`
 * 同时被 `@deepseek-ai/dsh-api-remotes` 转发给浏览器。不抢先，请求就会挂在
 * 「浏览器收到了但没人渲染那张卡」的空等上——这正是本次要修的问题。
 *
 * @param ctx - 宿主插件上下文（要能 `on`，可选 `get('agents')`）。
 * @param options - 读状态 + 日志 + 取 Agent 的方式。
 * @returns 卸载函数（摘干净两个监听）。
 */
export function installAutoAnswer(ctx: unknown, options: InstallAutoAnswerOptions): () => void {
  const scope = ctx as {
    on?: (name: string, listener: (...args: any[]) => any, opts?: { prepend?: boolean }) => unknown
    get?: (name: string) => any
  } | null | undefined
  const log = typeof options.log === 'function'
    ? options.log
    : (message: string) => { console.warn(`[dsh-assistant] ${message}`) }
  const disposers: Array<() => void> = []
  if (scope === null || scope === undefined || typeof scope.on !== 'function') {
    log('宿主没有事件总线，托管决策自动应答未启用')
    return () => void 0
  }
  const agentOf = typeof options.agentOf === 'function'
    ? options.agentOf
    : (sessionId: string): AutoAnswerAgentLike | null | undefined => {
      try {
        const agents = typeof scope.get === 'function' ? scope.get('agents') : undefined
        return agents?.get?.(sessionId) ?? null
      } catch {
        return null
      }
    }
  const controller = createAutoAnswer({
    readState: options.readState,
    log,
    ancestryOf: (sessionId) => sessionAncestry(sessionId, agentOf),
  })

  const wire = (event: string, handler: (request: any, next: () => Promise<unknown>) => Promise<unknown>): void => {
    try {
      const off = scope.on!(event, function (this: unknown, request: unknown, next: () => Promise<unknown>) {
        return handler(request as AutoAnswerRequestLike, next)
      }, { prepend: true })
      if (typeof off === 'function') disposers.push(off as () => void)
      else log(`托管决策自动应答挂不上 ${event}（宿主没给卸载函数）`)
    } catch (error: unknown) {
      log(`托管决策自动应答挂不上 ${event}：${renderThrown(error)}`)
    }
  }

  wire('approval/request', (request, next) => controller.answerApproval(request, next))
  wire('user-questions/request', (request, next) => controller.answerQuestion(request, next))
  if (disposers.length > 0) {
    log('托管决策自动应答已启用：审批 → allowed-once，提问 / plan-review → 默认项（宿主直接作答，不需要打开那个会话）')
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch { /* 卸载竞态无需处理 */ }
    }
  }
}
