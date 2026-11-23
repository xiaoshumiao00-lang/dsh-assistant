/**
 * 个人秘书「管理 Computer Use 会话」第一层：CU 会话完成 → 秘书会话收一张可点跳的卡片消息。
 *
 * 三个前提（2026-11-21 在宿主源码与本仓库实测确认）：
 *   1. CU 模式判定 = 会话 agent 预设 === 'computer-use'。读宿主**投影** `agentPreset`
 *      （sessionProjections / sessionProjectionCache 的 cachedSnapshot().values.agentPreset，
 *      由 agent-preset/selected 事件维护，比 header 新），读不到再回退 `session.header.agentPreset`。
 *      标准模式（standard / standard-slim-local / 空）一律不监听、不汇报。
 *   2. 轮次结束事件 = 宿主 `session/event` 的 `turn/end`：`data.reason.kind === 'completed'`
 *      算完成，`error` / `aborted` / `interrupted` / `blocked` 算**失败轮**。2026-11-23 用户定案：
 *      失败轮同样要出通知卡（带 reason.kind、错误码、错误原文），不许把失败静默成「已派活」；
 *      `max-tokens` 归托管自动续写（src/tuoguan-autocontinue.ts）管，既不算完成也不算失败。
 *      完成与失败都走宿主这一条真值事件流。
 *   3. 完成内容 = 同一 turn 的 `assistant/message` 事件里 message.content 的 text 块；
 *      本模块在事件流上顺手收集，不另开历史读取通道。失败轮常常什么文本都没有（模型解析
 *      失败前一个 step 都不开），这时卡片带的是错误原文，不是「它没有留下文字结果」。
 *
 * 卡片消息 = 把一条说明「CU 会话完成了」的系统通知**交给宿主官方 prompt 通道**
 * （`agent.followup`），由宿主自己开轮、自己编号、自己落盘；插件不再拼任何 turn/step
 * 事件（旧写法会把 turn 号写成宿主的重复轮，直接把会话日志写坏，详见 postSecretaryNotice）。
 * 秘书页的回复卡片（SecretaryReplyCard）据此渲染：正文是把 CU 会话结果**完整转述**给用户的
 * 汇报（2026-11-22 定案：不再要求压成短句），模型按通知里的要求把 `[[session:<cuSessionId>|<标题>]]`
 * 原样留在末尾，渲染成可点引用块（左竖线 + 淡底），点击按会话 id 跳进那条 CU 会话详情；
 * 卡片同时被自动朗读。
 *
 * 纪律：
 *   - 只听 CU 模式会话；标准会话（包括 CU 后台 code_agent 派出的标准会话）不汇报；
 *   - 子代理会话（origin=subagent / delegationDepth>0）不汇报；秘书会话自身不汇报；
 *   - 同一 (sessionId, turn) 只报一次（内存去重；重启后只监听新事件，不会重报旧轮）；
 *   - 通知回合的工具由 assistant-secretary.ts 全禁，避免「通知 → 再派活 → 再通知」的回路。
 */
import { randomUUID } from 'node:crypto'
import { manageWebRoutes } from './web-routes'
import { registerNoticeMessageId, secretarySessionRef } from './assistant-secretary'

export const CU_PRESET = 'computer-use'
export const CU_NOTIFY_ROUTE = '/api/assistant/cu-watch/notify'

/* ---------- 纯函数（单测直接断言） ---------- */

/** 会话当前 agent 预设：投影值优先，header 兜底；都拿不到 = ''（按标准模式处理）。 */
export function presetOfSource(projected: unknown, header: unknown): string {
  if (typeof projected === 'string' && projected !== '') return projected
  if (typeof header === 'string' && header !== '') return header
  return ''
}

/** CU 会话这一轮的两种结果（2026-11-23 用户定案：失败轮不许静默）。 */
export type CuTurnOutcome = 'completed' | 'failed'

/**
 * reason.kind → 该轮结果。completed 算完成；error / aborted / interrupted / blocked 算失败轮；
 * max-tokens（以及任何未知 kind）不汇报，归托管自动续写那套管。
 */
export function classifyCuTurn(reasonKind: unknown): CuTurnOutcome | null {
  const kind = String(reasonKind ?? '')
  if (kind === 'completed') return 'completed'
  if (kind === 'error' || kind === 'aborted' || kind === 'interrupted' || kind === 'blocked') return 'failed'
  return null
}

/** 失败轮的错误原文（reason.error.message / .code），读不到就空串，绝不编。 */
export function failureOfTurnEnd(data: any): { kind: string; message: string; code: string } {
  const reason = data?.reason ?? {}
  const error = reason?.error ?? {}
  return {
    kind: String(reason?.kind ?? ''),
    message: String(error?.message ?? '').trim(),
    code: String(error?.code ?? '').trim(),
  }
}

/** 一条会话轮次结束事件该不该汇报给秘书（完成与失败都汇报；任何一条不满足都不报）。 */
export function shouldReportTurn(input: {
  preset: string
  reasonKind: unknown
  origin?: unknown
  delegationDepth?: unknown
  isSecretary?: boolean
}): boolean {
  if (input.preset !== CU_PRESET) return false // 标准会话一律不汇报
  if (classifyCuTurn(input.reasonKind) === null) return false
  if (input.isSecretary === true) return false
  if (input.origin === 'subagent') return false
  if (typeof input.delegationDepth === 'number' && input.delegationDepth > 0) return false
  return true
}

/* ---------- 通知投递：走宿主官方 prompt 通道，插件不再自己写任何日志事件 ---------- */

/**
 * 失败轮的后缀：`（原因 error；错误码 UNKNOWN_MODEL；错误原文「…」）`。
 * 只拼宿主事件里真有的字段，一个都读不到就返回空串——绝不编造。
 */
export function formatCuFailureLine(failure?: { kind: string; message: string; code: string }): string {
  const bits: string[] = []
  const kind = String(failure?.kind ?? '').trim()
  const code = String(failure?.code ?? '').trim()
  const message = String(failure?.message ?? '').trim()
  if (kind !== '') bits.push(`原因 ${kind}`)
  if (code !== '') bits.push(`错误码 ${code}`)
  if (message !== '') bits.push(`错误原文「${message}」`)
  return bits.length === 0 ? '' : `（${bits.join('；')}）`
}

/**
 * 汇报消息正文。**这是发给秘书模型的一条系统通知**（角色是 user，宿主的 prompt 通道
 * 只接受这个角色），所以开头必须自我说明，结尾必须把会话引用原样留给卡片渲染。
 *
 * 2026-11-22 用户定案：去掉「一两句口语汇报」的长度限制——秘书要把 Computer Use 会话
 * 返回的消息**完整、原样**展示出来，不许为精简丢掉文件名、路径、数字、提交号、判据、结论。
 * 2026-11-23 用户定案：失败轮（error / aborted / interrupted / blocked）走同一条通知、同一套
 * 卡片规格，但措辞必须是「这一轮失败了」并带上 reason.kind、错误码与错误原文；
 * 秘书向用户汇报时不许把它说成已派活／已完成／已落地。
 * 「这一回合工具已全部禁用，不要尝试派活或查询」这句照留：它不是长度限制，是防止
 * 「通知 → 再派活 → 再通知」回路的闸（assistant-secretary.ts 的 tools/pre-execute 那一层
 * 同时把这一轮的工具全禁，措辞与硬闸必须一致，否则模型会去调工具想"核实"）。
 * 卡片解析依赖两处：首行以「系统通知」开头（NOTICE_HEAD_LINE_RE）与末尾
 * `最后单独一行原样输出：[[session:id|title]]`（NOTICE_SESSION_REF_LINE_RE）——都不动。
 */
export function buildCompletionNotice(input: {
  sessionId: string
  title: string
  summary: string
  outcome?: CuTurnOutcome
  failure?: { kind: string; message: string; code: string }
}): string {
  const title = String(input.title ?? '').trim() || '电脑上的任务'
  const summary = String(input.summary ?? '').trim()
  const failed = input.outcome === 'failed'
  const failureLine = formatCuFailureLine(input.failure)
  return [
    '（系统通知，不是用户说的话）',
    failed
      ? `电脑操作会话「${title}」这一轮失败了${failureLine}。`
      : `电脑操作会话「${title}」这一轮已经完成。`,
    summary !== ''
      ? `它最后一段返回原文（完整照录）：${summary}`
      : (failed ? '它这一轮没有留下文字结果。' : '它没有留下文字结果。'),
    failed
      ? '向用户汇报时必须照实说是「这一轮失败／派活失败」，不许说成已完成、已落地、已派活：把上面那条错误码与错误原文完整转述（引号、路径、模型名、错误码都不许省），并告诉用户可以改派——换一条新建的 Computer Use 会话（派活失败后插件会自动改新建并如实写进回执），或换个项目目录再派一次。'
      : '向用户汇报时把上面这条结果完整展示出来：原样转述，不许精简、不许合并或删细节，文件名、路径、命令、数字、版本号、提交号、判据、结论都必须保留；原文被截断（末尾带 …）就照实说明，不许自己补写。',
    '这一回合工具已全部禁用，不要尝试派活或查询。',
    `最后单独一行原样输出：[[session:${input.sessionId}|${title}]]`,
  ].join('\n')
}

/** 一条交给宿主 prompt 通道的 user 消息（形状与宿主 createUserMessage 一致）。 */
export function buildNoticeMessage(input: {
  sessionId: string
  title: string
  summary: string
  outcome?: CuTurnOutcome
  failure?: { kind: string; message: string; code: string }
}): {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user' }
} {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: buildCompletionNotice(input) }],
    source: { kind: 'user' },
  }
}

/**
 * CU 结果的唯一长度口径（事件流收集与通知正文都用它）：整段能带全就全带，
 * 只有超出 900 字的那部分才截尾、末尾留「…」，由通知正文里的「照实说明截断」交给模型。
 * 取 900 是因为现网 CU 会话的完成汇报正文普遍在几百到一千字量级，600 会切开长报告；
 * 900 也与卡片历史预览上限 HISTORY_PREVIEW_MAX_CHARS 同口径，卡片折叠负责剩下的观感。
 */
export const CU_NOTICE_RESULT_MAX_CHARS = 900

/**
 * CU 会话完成内容：最后一段返回文本**整段照录**（换行保留，空白折叠）。
 * 旧口径是「只取首句、截到 120 字」——那是给「一两句口语汇报」配套的，
 * 2026-11-22 用户定案撤掉精简口径：通知要带得下全文，秘书才谈得上完整转述。
 */
export function summarizeCompletion(text: string): string {
  const clean = String(text ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (clean === '') return ''
  if (clean.length <= CU_NOTICE_RESULT_MAX_CHARS) return clean
  return `${clean.slice(0, CU_NOTICE_RESULT_MAX_CHARS)}…`
}

/* ---------- 事件控制器（收集文本 + 完成/失败触发，依赖全注入） ---------- */

/** 一条 CU 轮次结果的汇报内容（完成与失败共用同一形状）。 */
export interface CuNoticePayload {
  sessionId: string
  title: string
  summary: string
  outcome: CuTurnOutcome
  failure?: { kind: string; message: string; code: string }
}

export interface CuWatchDeps {
  /** 该会话当前的 agent 预设（投影优先，header 兜底）。 */
  presetOf: (session: any) => string
  /** 汇报出口：把完成／失败内容发到秘书固定会话。 */
  notify: (payload: CuNoticePayload) => void | Promise<void>
  /** 会话标题（投影 title / header.title）。 */
  titleOf?: (session: any) => string
  /** 当前秘书会话 id（自身不汇报）。 */
  secretaryId?: () => string
  log?: (line: string) => void
}

export function createCuWatch(deps: CuWatchDeps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const titleOf = typeof deps.titleOf === 'function'
    ? deps.titleOf
    : (session: any): string => String(session?.header?.title ?? '')
  /** (sessionId) → turn → 收集到的文本（只在 CU 会话上收集） */
  const texts = new Map<string, Map<number, string[]>>()
  /** 已汇报的 (sessionId:turn)，同一轮只报一次 */
  const reported = new Set<string>()

  const isSecretary = (sessionId: string): boolean => {
    try { return sessionId !== '' && sessionId === (deps.secretaryId?.() ?? '') } catch { return false }
  }

  return {
    /** 测试/诊断：某会话某轮已收集的文本段数。 */
    collectedOf(sessionId: string, turn: number): number {
      return texts.get(sessionId)?.get(turn)?.length ?? 0
    },
    reportedOf(sessionId: string, turn: number): boolean {
      return reported.has(`${sessionId}:${turn}`)
    },
    handleSessionEvent(session: any, event: any): void {
      try {
        const sessionId = String(session?.id ?? '')
        if (sessionId === '') return
        const type = String(event?.type ?? '')
        if (type === 'assistant/message') {
          const preset = deps.presetOf(session)
          if (preset !== CU_PRESET) return // 标准会话连文本都不收集
          if (isSecretary(sessionId)) return
          if (session?.header?.origin === 'subagent') return
          const turn = Number(event?.data?.turn)
          if (!Number.isFinite(turn) || turn < 1) return
          const content = Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
          const parts: string[] = []
          for (const block of content) {
            if (block?.type !== 'text') continue
            const text = String(block?.text ?? '').trim()
            // 与通知里带的上限同一口径：收集多宽就带多宽，不再分两套长度
            if (text !== '') parts.push(text.slice(0, CU_NOTICE_RESULT_MAX_CHARS))
          }
          if (parts.length === 0) return
          let byTurn = texts.get(sessionId)
          if (byTurn === undefined) { byTurn = new Map(); texts.set(sessionId, byTurn) }
          // 只留最近 4 轮：长跑宿主不攒内存
          if (byTurn.size > 4) {
            const oldest = byTurn.keys().next().value
            if (typeof oldest === 'number') byTurn.delete(oldest)
          }
          const list = byTurn.get(turn) ?? []
          byTurn.set(turn, [...list, ...parts].slice(-4))
          if (texts.size > 40) {
            const oldest = texts.keys().next().value
            if (typeof oldest === 'string') texts.delete(oldest)
          }
          return
        }
        if (type !== 'turn/end') return
        const data = event?.data ?? {}
        const turn = Number(data?.turn)
        const outcome = classifyCuTurn(data?.reason?.kind)
        const failure = outcome === 'failed' ? failureOfTurnEnd(data) : undefined
        const byTurn = texts.get(sessionId)
        const collected = Number.isFinite(turn) ? (byTurn?.get(turn) ?? []) : []
        if (Number.isFinite(turn) && byTurn !== undefined) byTurn.delete(turn)
        const preset = deps.presetOf(session)
        if (!shouldReportTurn({
          preset,
          reasonKind: data?.reason?.kind,
          origin: session?.header?.origin,
          delegationDepth: session?.header?.delegationDepth,
          isSecretary: isSecretary(sessionId),
        })) return
        if (!Number.isFinite(turn) || turn < 1) return
        const dedupKey = `${sessionId}:${turn}`
        if (reported.has(dedupKey)) return
        reported.add(dedupKey)
        if (reported.size > 200) {
          const oldest = reported.values().next().value
          if (typeof oldest === 'string') reported.delete(oldest)
        }
        const lastText = collected[collected.length - 1] ?? ''
        const payload: CuNoticePayload = {
          sessionId,
          title: titleOf(session),
          summary: summarizeCompletion(lastText),
          outcome: outcome ?? 'completed',
          ...(failure !== undefined ? { failure } : {}),
        }
        if (outcome === 'failed') {
          log(`CU 失败轮汇报：${sessionId} turn ${turn} ${formatCuFailureLine(failure) || '（宿主没带错误原文）'}`)
        }
        Promise.resolve(deps.notify(payload)).catch((error: unknown) => {
          log(`CU ${outcome === 'failed' ? '失败' : '完成'}通知发送失败（${sessionId} turn ${turn}）：${String((error as Error)?.message ?? error)}`)
        })
      } catch (error: unknown) {
        log(`CU 完成/失败监听处理事件失败：${String((error as Error)?.message ?? error)}`)
      }
    },
    handleSessionDisposed(session: any): void {
      const sessionId = String(session?.id ?? '')
      if (sessionId !== '') texts.delete(sessionId)
    },
  }
}

/* ---------- 通知投递：宿主官方 prompt 通道（agent.followup） ---------- */

/**
 * 以前这里写的是「往秘书会话追加一条合成完成轮」：自己拼
 * turn/start → step/start → assistant/message → step/end → turn/end，turn 号取
 * 日志里最大 turn + 1。**这条路已经彻底删掉**，原因是它必然写坏日志：
 *
 *   宿主的 turn 号来自 AgentLoop 的内存计数器（agent.ts: `const turn = phase.turn + 1`），
 *   它不读日志、也不知道插件塞进去的外来轮。插件先写 turn 7，宿主下一轮照样开 turn 7，
 *   v4 恢复器要求 turn/start == nextTurn，重复立即抛
 *   `SessionFormatError: turn/start does not open the expected turn`，整个会话打不开。
 *   （2026-11-21 实测：session-33044545 的 seq 103/127/149 三处正是这种重复轮。）
 *
 * 现在的做法：只构造一条 user 消息，交给宿主自己的 prompt 通道
 * `agent.followup(message)` —— 入队、开轮、编号、写 user/step/assistant/turn 事件全由宿主完成，
 * 插件一个事件都不写。宿主负责落在合法位置上，插件再也没有写坏日志的能力。
 *
 * @returns true = 宿主已接受这条消息（不代表模型已经答完）；false = 秘书会话没有活的 agent。
 */
export function postSecretaryNotice(agent: any, notice: CuNoticePayload): boolean {
  if (agent === null || agent === undefined) return false
  if (typeof agent.followup !== 'function') return false
  const message = buildNoticeMessage(notice)
  try {
    registerNoticeMessageId(message.id)
    agent.followup(message)
    return true
  } catch {
    return false
  }
}

/* ---------- 宿主装配 ---------- */

function optionalService(ctx: any, id: string): any {
  try { return typeof ctx?.get === 'function' ? ctx.get(id) : undefined } catch { return undefined }
}

/** 会话当前预设：投影（sessionProjections → sessionProjectionCache）优先，header 兜底。 */
export function sessionPresetOf(ctx: any, session: any): string {
  try {
    const projections = optionalService(ctx, 'sessionProjections')
    if (projections && typeof projections.cachedSnapshot === 'function') {
      const block = projections.cachedSnapshot(session)
      const value = block?.values?.agentPreset
      if (typeof value === 'string' && value !== '') return value
    }
  } catch { /* 投影不可用：继续试缓存 */ }
  try {
    const cache = optionalService(ctx, 'sessionProjectionCache')
    if (cache && typeof cache.cachedSnapshot === 'function') {
      const block = cache.cachedSnapshot(session?.header ?? session)
      const value = block?.values?.agentPreset
      if (typeof value === 'string' && value !== '') return value
    }
  } catch { /* 同上 */ }
  return presetOfSource('', session?.header?.agentPreset)
}

/** 会话标题：投影 title → header.title → '未命名任务'。 */
function sessionTitleOf(ctx: any, session: any): string {
  try {
    const projections = optionalService(ctx, 'sessionProjections')
    const block = projections?.cachedSnapshot?.(session)
    const value = block?.values?.title
    if (typeof value === 'string' && value !== '') return value
    if (value !== null && typeof value === 'object' && typeof value.title === 'string') return value.title
  } catch { /* 忽略 */ }
  const header = String(session?.header?.title ?? '').trim()
  return header !== '' ? header : '未命名任务'
}

/**
 * 取秘书会话的 **Agent**（不是 Session）：通知只走 `agent.followup()` 这一条官方通道，
 * 它自带 inbox 落盘 + 唤醒驱动 + 宿主自己编号开轮。拿不到活 agent 就不发，
 * 绝不再退回"自己往日志里写事件"的老路。
 */
export function secretaryAgentOf(ctx: any): any {
  const id = secretarySessionRef.id
  if (id === '') return null
  try {
    const agents = optionalService(ctx, 'agents')
    const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined
    if (agent !== undefined && agent !== null && typeof agent.followup === 'function') return agent
  } catch { /* 没有就是 null */ }
  return null
}

/** 取秘书会话的 Session 对象（诊断/只读用途）。 */
export function secretarySessionOf(ctx: any): any {
  const agent = secretaryAgentOf(ctx)
  if (agent?.session !== undefined && agent.session !== null) return agent.session
  const id = secretarySessionRef.id
  if (id === '') return null
  try {
    const sessions = optionalService(ctx, 'sessions') ?? ctx?.sessions
    const live = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
    if (live !== undefined && live !== null) return live
  } catch { /* 没有就是 null */ }
  return null
}

/** 发送一条完成／失败通知（路由与事件监听共用）。返回宿主是否已接受这条消息。 */
export function notifySecretary(ctx: any, notice: CuNoticePayload, log: (line: string) => void): boolean {
  if (secretarySessionRef.id === '') {
    log('CU 汇报：秘书固定会话还没就绪，这条先不发')
    return false
  }
  const agent = secretaryAgentOf(ctx)
  const ok = postSecretaryNotice(agent, notice)
  const head = notice.outcome === 'failed' ? 'CU 失败轮汇报' : 'CU 完成汇报'
  log(ok
    ? `${head}已交给宿主 prompt 通道（agent.followup）：${notice.sessionId}「${notice.title}」${formatCuFailureLine(notice.failure)}`
    : `${head}没发出去：秘书会话没有活的 agent（宿主未提供 agent.followup），已跳过而不是自己写日志（${notice.sessionId}）`)
  return ok
}

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 注册：session/event 监听 + 手动/测试触发路由。 */
export function registerAssistantCuWatch(ctx: any): () => void {
  const log = (line: string): void => { try { ctx?.logger?.info?.(`[dsh-assistant] ${line}`) } catch {} }
  const watch = createCuWatch({
    presetOf: (session) => sessionPresetOf(ctx, session),
    titleOf: (session) => sessionTitleOf(ctx, session),
    secretaryId: () => secretarySessionRef.id,
    notify: (payload) => { notifySecretary(ctx, payload, log) },
    log,
  })
  const disposers: Array<() => void> = []
  try {
    const off = ctx?.on?.('session/event', (session: any, event: any) => watch.handleSessionEvent(session, event))
    if (typeof off === 'function') disposers.push(off)
  } catch { /* 老宿主没有事件总线：监听不启用，路由仍可用 */ }
  try {
    const off = ctx?.on?.('session/disposed', (session: any) => watch.handleSessionDisposed(session))
    if (typeof off === 'function') disposers.push(off)
  } catch { /* 可选 */ }

  // 手动/冒烟触发口：与事件监听走同一个 notifySecretary，方便「不重启宿主就验证渲染与跳转」之外的
  // 全链路联调（宿主重载后此路由才存在，冒烟按 404 自动跳过）。
  try {
    const server = ctx?.webServer
    if (server && typeof server.register === 'function') {
      const routes = manageWebRoutes(server)
      routes.webServer.register({
        kind: 'exact',
        path: CU_NOTIFY_ROUTE,
        handler: async (req: any, res: any) => {
          if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          let raw = ''
          for await (const chunk of req) {
            raw += String(chunk ?? '')
            if (raw.length > 16384) { sendJson(res, 413, { ok: false, error: 'too-large' }); return }
          }
          let body: any = null
          try { body = JSON.parse(raw || '{}') } catch { body = null }
          const sessionId = String(body?.sessionId ?? '').trim()
          const title = String(body?.title ?? '').trim()
          const summary = String(body?.summary ?? '').trim()
          // 手动触发口也认失败轮：outcome='failed' 或 reasonKind 是 error/aborted/… 都算失败卡
          const outcome: CuTurnOutcome = String(body?.outcome ?? '') === 'failed' || classifyCuTurn(body?.reasonKind) === 'failed'
            ? 'failed'
            : 'completed'
          const failure = outcome === 'failed'
            ? {
                kind: String(body?.reasonKind ?? body?.failure?.kind ?? 'error'),
                message: String(body?.failure?.message ?? body?.error ?? ''),
                code: String(body?.failure?.code ?? body?.code ?? ''),
              }
            : undefined
          if (sessionId === '') { sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return }
          const ok = notifySecretary(ctx, {
            sessionId,
            title,
            summary,
            outcome,
            ...(failure !== undefined ? { failure } : {}),
          }, log)
          sendJson(res, ok ? 200 : 409, { ok, sessionId, outcome })
        },
      })
      disposers.push(() => { try { routes.dispose() } catch {} })
    }
  } catch { /* 路由挂不上只影响手动触发 */ }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}

/** 单测入口。 */
export const assistantCuWatchTestSurface = {
  CU_PRESET,
  CU_NOTIFY_ROUTE,
  presetOfSource,
  classifyCuTurn,
  shouldReportTurn,
  failureOfTurnEnd,
  formatCuFailureLine,
  buildCompletionNotice,
  buildNoticeMessage,
  CU_NOTICE_RESULT_MAX_CHARS,
  summarizeCompletion,
  createCuWatch,
  postSecretaryNotice,
  sessionPresetOf,
  secretaryAgentOf,
  secretarySessionOf,
  notifySecretary,
  registerAssistantCuWatch,
}
