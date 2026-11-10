/**
 * 待决策来源：把**宿主 pendingInteraction**翻译成设备屏 5（待决策）需要的那几样东西。
 *
 * 为什么在这里读、不在 `src/client/sessionStatus.ts` 读：
 *   - `sessionStatus` / `pendingInteractions` 是**客户端** uiSession 的可观察量
 *     （浏览器里每行 `{ running, pendingInteraction, … }`），宿主进程里根本没有这份 Map；
 *   - 宿主这一侧 pendingInteraction 的**真正来源**是两道 waterfall：
 *     `approval/request`（工具/沙箱权限确认）与 `user-questions/request`
 *     （`ask_user_question` 的提问）。`src/tuoguan-autoanswer.ts` 也是挂在这两道上：
 *     托管开着它替人答首选项，托管关着 `next()` 原样放行给浏览器卡片。
 *
 * 本文件只做**纯逻辑**（不认设备、不认登记簿、不读写屏幕）：
 *   - 从请求对象里取**真实**的问题原文与选项（取不到才用固定文案，绝不编造正文）；
 *   - 把「选中第几项」翻译成宿主要的那份返回值（审批 outcome / 答案批次）；
 *   - 按仓库现有读法判断某个会话此刻是否托管（`dsh-tuoguan-state.json` + 会话链）。
 *
 * 答案真的送回会话：lane 在那两道 waterfall 里**先挂住请求**（不调 next），
 * 设备点选项/60 秒到点时直接把 answerOf(index) 当 waterfall 的返回值交回去——
 * 这就是宿主真正的 respond 路径（官方没有单独的 `approval.respond` RPC）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  FREE_TEXT_DEFAULT,
  sessionAncestry,
  tuoguanOnForChain,
  type AutoAnswerAgentLike,
  type TuoguanStateLike,
} from '../tuoguan-autoanswer.ts'

/** 取不到真实正文时的固定文案（**绝不编造问题**）。 */
export const PENDING_QUESTION_FALLBACK = '电脑端在等你确认'
/** 取不到真实选项时的单个固定选项。 */
export const PENDING_OPTION_FALLBACK = '继续'
/** 审批的两个选项（顺序＝屏上按钮顺序；首项＝默认项，与托管自动答同一个结果）。 */
export const APPROVAL_OPTIONS: readonly string[] = ['允许一次', '拒绝']
/** 与 {@link APPROVAL_OPTIONS} 一一对应的宿主审批结果（官方闭集）。 */
export const APPROVAL_OUTCOMES: readonly string[] = ['allowed-once', 'rejected']
/** 待决策倒计时（用户 2026-11-10：60 秒到点按默认项走）。 */
export const DECISION_TIMEOUT_MS = 60_000
/** 设备全掉线时多久改交给电脑端一次（毫秒）。 */
export const PENDING_OFFLINE_CHECK_MS = 2_000

/**
 * 待决策超时：`TIHU_DECISION_TIMEOUT_MS` 只给测试调小（夹在 10ms ～ 10min）。
 * 非数字 / 非正数一律回落到 60 秒（否则 setTimeout(0) 会立刻替人拍板）。
 */
export function tihuDecisionTimeoutMs(): number {
  const raw = Number(process.env.TIHU_DECISION_TIMEOUT_MS ?? DECISION_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DECISION_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(raw), 10), 10 * 60_000)
}

/** 屏上/登记簿里的一行问答。 */
export interface PendingDecision {
  /** 发起这道题（审批/提问）的会话。 */
  sessionId: string
  /** 来源：审批（工具/沙箱权限）或提问（ask_user_question）。 */
  kind: 'approval' | 'question'
  /** 问题原文（真实文案；取不到才是 {@link PENDING_QUESTION_FALLBACK}）。 */
  question: string
  /** 上下文一行（工具名 / 题目标题 / 被折叠的选项数）。 */
  detail?: string
  /** 选项（顺序与电脑端一致；设备最多摆两个）。 */
  options: string[]
  /** 默认项下标（到点按它走，也与托管自动答同一个规则）。 */
  defaultIndex: number
  /**
   * 选中第 index 项 → 交回宿主的返回值（审批 outcome / `{ answers }` 批次）。
   * 这是**真值**：lane 拿它当 waterfall 的返回值，会话因此恢复正常执行。
   */
  answerOf: (index: number) => unknown
}

/** 压一行屏上文字（去换行/多余空白，超长省略号）。 */
function clipLine(value: unknown, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

/** 请求属于哪条会话（agent.session.id / agent.session.header.id / 旧形状的 sessionId）。 */
export function sessionIdOfPendingRequest(request: any): string {
  const direct = request?.agent?.session?.id ?? request?.sessionId ?? request?.session?.id
  if (typeof direct === 'string' && direct !== '') return direct
  const header = request?.agent?.session?.header?.id
  return typeof header === 'string' ? header : ''
}

/** 本地化展示原因（`displayReason['zh-CN']` → `en`；没有就空串）。 */
function displayReasonOf(request: any): string {
  const value = request?.displayReason
  if (value === null || typeof value !== 'object') return ''
  for (const key of ['zh-CN', 'zh', 'en']) {
    const text = (value as Record<string, unknown>)[key]
    if (typeof text === 'string' && text.trim() !== '') return clipLine(text, 40)
  }
  return ''
}

/**
 * `approval/request` → 待决策。
 *
 * 真实可取的东西只有 `toolName` 与 `reason` / `displayReason`（审批请求没有选项列表）；
 * 两个选项按官方闭集固定成「允许一次 / 拒绝」，默认项＝允许一次（与托管自动答同一结果）。
 * @param request - 审批 waterfall 的请求对象。
 * @returns 待决策；没法定位会话时 null（调用方一律放行）。
 */
export function approvalDecisionOf(request: any): PendingDecision | null {
  const sessionId = sessionIdOfPendingRequest(request)
  if (sessionId === '') return null
  const toolName = typeof request?.toolName === 'string' ? clipLine(request.toolName, 24) : ''
  const reason = clipLine(request?.reason, 40) || displayReasonOf(request)
  const question = reason !== ''
    ? reason
    : toolName !== '' ? `允许使用 ${toolName}？` : PENDING_QUESTION_FALLBACK
  return {
    sessionId,
    kind: 'approval',
    question,
    ...(toolName === '' ? {} : { detail: toolName }),
    options: [...APPROVAL_OPTIONS],
    defaultIndex: 0,
    answerOf: (index) => {
      const at = Number.isFinite(index) ? Math.max(0, Math.min(Math.trunc(index), APPROVAL_OUTCOMES.length - 1)) : 0
      return APPROVAL_OUTCOMES[at]
    },
  }
}

/**
 * 一题一批的默认答案（每题首选项；没有选项就回自由文本）——与托管自动答同一条规则。
 * 只在「多题批」与「无选项」两种取不到单题正文的情况下用它，正文本身绝不编。
 */
function defaultAnswersOf(questions: readonly any[]): { answers: Array<{ id: string; selected: string[]; custom?: string }> } {
  return {
    answers: questions.map((question) => {
      const id = typeof question?.id === 'string' ? question.id : String(question?.id ?? '')
      const options = Array.isArray(question?.options) ? question.options : []
      const first = options[0]
      const label = typeof first?.label === 'string' ? first.label.trim() : ''
      if (label === '') return { id, selected: [], custom: FREE_TEXT_DEFAULT }
      return { id, selected: [label] }
    }),
  }
}

/**
 * `user-questions/request` → 待决策。
 *
 * 单题：问题原文、题目 detail/header、选项都用**请求里的真值**（设备最多摆两个，
 * 多出来的在 detail 里写「还有 N 个选项在电脑端」）。多题批：屏上只给一句固定文案 +
 * 一个「继续」，选中＝每题首选项（与托管自动答同一批答案）。
 * @param request - 提问 waterfall 的请求对象。
 * @returns 待决策；没有可答题目/定位不到会话时 null（调用方一律放行）。
 */
export function questionDecisionOf(request: any): PendingDecision | null {
  const sessionId = sessionIdOfPendingRequest(request)
  if (sessionId === '') return null
  const questions = Array.isArray(request?.questions) ? request.questions.filter((item: any) => item !== null && typeof item === 'object') : []
  if (questions.length === 0) return null
  if (questions.length > 1) {
    return {
      sessionId,
      kind: 'question',
      question: PENDING_QUESTION_FALLBACK,
      detail: `一次 ${questions.length} 个问题`,
      options: [PENDING_OPTION_FALLBACK],
      defaultIndex: 0,
      answerOf: () => defaultAnswersOf(questions),
    }
  }
  const item = questions[0]
  const id = typeof item?.id === 'string' ? item.id : ''
  const text = clipLine(item?.question, 40)
  // 官方契约要求答案按题 id 对回来；缺 id / 缺正文的题交回电脑端（绝不猜着答）。
  if (id === '' || text === '') return null
  const optionLabels: string[] = (Array.isArray(item?.options) ? item.options : [])
    .map((option: any) => (typeof option?.label === 'string' ? option.label.trim() : ''))
    .filter((label: string) => label !== '')
  const header = clipLine(item?.header, 16)
  const detailText = clipLine(item?.detail, 40)
  if (optionLabels.length === 0) {
    return {
      sessionId,
      kind: 'question',
      question: text,
      ...(header === '' && detailText === '' ? {} : { detail: detailText || header }),
      options: [PENDING_OPTION_FALLBACK],
      defaultIndex: 0,
      // 没有选项的题：用官方「其它」口径回一段自由文本（与托管同一条默认话术）。
      answerOf: () => ({ answers: [{ id, selected: [], custom: FREE_TEXT_DEFAULT }] }),
    }
  }
  const shown = optionLabels.slice(0, 2)
  const hidden = optionLabels.length - shown.length
  const detail = clipLine([header, hidden > 0 ? `还有 ${hidden} 个选项在电脑端` : ''].filter((part) => part !== '').join(' · '), 40)
  return {
    sessionId,
    kind: 'question',
    question: text,
    ...(detail === '' ? {} : { detail }),
    options: shown,
    defaultIndex: 0,
    answerOf: (index) => {
      const at = Number.isFinite(index) ? Math.max(0, Math.min(Math.trunc(index), shown.length - 1)) : 0
      return { answers: [{ id, selected: [shown[at] ?? shown[0]] }] }
    },
  }
}

/* ---------- 托管状态（沿用仓库现有读法：profile 下的 dsh-tuoguan-state.json） ---------- */

/** 可选服务取值：cordis 对未 inject 的服务直读会 throw。 */
function optionalService(ctx: any, id: string): any {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(id)
  } catch { /* 服务不存在 */ }
  return undefined
}

/**
 * 托管状态文件位置（与 `src/tuoguan-host.ts` 同一份真值）。
 *
 * 顺序：`TIHU_TUOGUAN_STATE`（测试/排查用）→ 宿主 `profileContext.dir` →
 * `$DSH_HOME`（缺省 `~/.dsh`）下先找 desktop profile、再找旧位置。
 */
export function tuoguanStateFileOf(ctx: any): string {
  const override = String(process.env.TIHU_TUOGUAN_STATE ?? '').trim()
  if (override !== '') return override
  const profile = optionalService(ctx, 'profileContext') as { dir?: unknown } | undefined
  if (profile && typeof profile.dir === 'string' && profile.dir !== '') return join(profile.dir, 'dsh-tuoguan-state.json')
  const home = optionalService(ctx, 'homePaths') as { home?: unknown } | undefined
  const base = home && typeof home.home === 'string' && home.home !== ''
    ? home.home
    : (String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'))
  const desktop = join(base, 'profiles', 'desktop', 'dsh-tuoguan-state.json')
  if (existsSync(desktop)) return desktop
  return join(base, 'dsh-tuoguan-state.json')
}

/** 只保留判定要用的三项；坏数据一律当「没关过」（defaultOn 缺省 true）。 */
export function normalizeTuoguanState(raw: unknown): TuoguanStateLike {
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const pick = (source: unknown): Record<string, boolean> => {
    const out: Record<string, boolean> = {}
    if (source === null || typeof source !== 'object') return out
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof key === 'string' && key !== '' && value === true) out[key] = true
    }
    return out
  }
  const off = pick(record.off)
  const on = pick(record.on)
  for (const key of Object.keys(off)) delete on[key]
  return { off, on, defaultOn: typeof record.defaultOn === 'boolean' ? record.defaultOn : true }
}

/** 同步读托管状态；文件不存在/JSON 损坏＝「谁都没关过」（托管 ON）。 */
export function readTuoguanStateAt(file: string): TuoguanStateLike {
  try {
    return normalizeTuoguanState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { off: {}, on: {}, defaultOn: true }
  }
}

/**
 * 这个会话此刻托管吗（读不到状态一律按**托管中**处理）。
 *
 * 为什么读不到要算托管：托管开着时 `tuoguan-autoanswer` 会替人答首选项，根本不该出现待决策；
 * 判不出来就往「不落待决策」倒，最坏是这道题照旧在电脑端答，而不是设备抢答。
 * @param sessionId - 发起审批/提问的会话。
 * @param ctx - 宿主插件上下文（取 profileContext / agents）。
 * @param agentOf - 按 id 取 Agent（缺省 `ctx.get('agents')`），用于子代理继承托管开关。
 * @returns 是否托管。
 */
export function tuoguanOnForSession(
  sessionId: string,
  ctx: any,
  agentOf?: (id: string) => AutoAnswerAgentLike | null | undefined,
): boolean {
  if (typeof sessionId !== 'string' || sessionId === '') return true
  try {
    const agents = optionalService(ctx, 'agents')
    const lookup = typeof agentOf === 'function'
      ? agentOf
      : (id: string): AutoAnswerAgentLike | null | undefined => {
        try { return agents?.get?.(id) ?? null } catch { return null }
      }
    const state = readTuoguanStateAt(tuoguanStateFileOf(ctx))
    return tuoguanOnForChain(state, sessionAncestry(sessionId, lookup))
  } catch {
    return true
  }
}
