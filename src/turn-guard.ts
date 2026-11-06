/**
 * turn-guard（防空转补步）：从独立插件 dsh-turn-guard 并入本包，开关收在「设置 → 个人助手 → 托管」。
 *
 * 为什么需要它：`dsh-agent-loop` 没有 turn 预算——某一步的助手消息里没有结构化
 * tool-call，这一轮就以 completed 收尾。本地 4bit 模型在长上下文里偶尔会把工具调用
 * 写成纯文本（`<tool_call>` / `<parameter>` 之类的片段），于是任务停在半路。
 *
 * 做法：监听 `agent/turn-stopping`（turn 即将结束、循环 break 之前），判定最后一条
 * assistant 消息：
 *   1. 有结构化 tool-call → 不动；
 *   2. 文本里有一行**以**调用标记开头（行内/围栏代码里的标记先剔除）→ 补一步；
 *   3. 只有 reasoning、正文为空（`steerEmptyText`）→ 补一步；
 *   4. 正常正文收尾 → 不动。
 * 补的方式：`agent.send(纠正消息, 'next-step', false)`——inbox.nextStep 非空，循环
 * 不再 break，带着这条纠正指令再走一步。
 *
 * 配额口径（2026-11-06 修）：`maxPerTurn` = **同一个 turn 内**最多补几次（默认 3）。
 * `[turn-guard]` 注入按它所属的 turn 计数（归到最后一次 `turn/start` 的 turn 号），
 * 跨 turn、跨自然日自动重置。旧口径是「按整条会话累计」——被定时任务每天复用的会话
 * 一旦补满 3 次就永久静音（2026-11-06 定时任务 turn 41 就是这么没被续跑的）。
 * 每次 `turn-stopping` 决策都写一行 verdict 日志（带 ISO 时间戳）：
 *   `verdict turn=N steer=true|false branch=判据名 injected=已补/上限 dayInjected=当日已补`
 * 所以「被上限拦下」「被预设跳过」这类不动作的判定也能在日志里看见。
 *
 * 开关：真值落在 `<profile 目录>/dsh-assistant-turn-guard.json`，客户端通过同源
 * `GET/POST /.dsh-assistant/turn-guard` 读写（与托管状态同一种跨端同步方式）。
 * 宿主每个 turn 收尾都重新读一次状态（按 mtime 缓存），所以页面上的开关
 * **点完立即生效**，不需要重启。
 *
 * 另外还挂着「历史闸」（`agent/pre-step` 的 prepend 分支）：任何即将写入会话日志的
 * user/message 缺 id 时就地补 uuid。缺 id 的消息会让整条会话在下次读回时被判为
 * corrupt，这是 2026-11-02 写坏 5 条会话的根因，原插件的那道闸原样保留。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dshHome } from './assistant-config.ts'
import { manageWebRoutes } from './web-routes.ts'

export const name = 'dsh-assistant-turn-guard'

/** 版本号进日志：宿主热重载后从 load 行就能看出跑的是不是新代码。
 *  1.1.0 = 注入配额改按 turn 计数 + 每次决策写 verdict 日志（2026-11-06）。 */
export const VERSION = '1.1.0'

/** 纠错消息前缀：既用于统计次数，也便于人工在日志里识别。 */
export const MARK = '[turn-guard]'

const PREFIX = '/.dsh-assistant/turn-guard'
const STATE_FILENAME = 'dsh-assistant-turn-guard.json'
const LOG_FILENAME = 'dsh-assistant-turn-guard.log'
/** POST body 上限：就是几个配置字段，64KB 绰绰有余。 */
const MAX_BODY_BYTES = 64 * 1024
/** 预设名 / 列表长度上限，防止把垃圾写进状态文件。 */
const MAX_PRESET_LENGTH = 64
const MAX_PRESETS = 16

/** 模型把工具调用写成正文时常见的残留标记。 */
const LEAK = /<tool_call>|<\/tool_call>|<parameter|<function|<\/function>|<input_text>/i

/** 一行开头就是调用标记：模型自己写出来的调用，而不是正文里提到的格式。 */
const LEAK_AT_LINE_START = /^(<tool_call>|<\/tool_call>|<function[=\s]|<\/function>|<parameter[=\s>]|<input_text>)/i

const MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])

/* ---------- 判定与消息构造（与原插件逐行等价，导出给单测） ---------- */

/**
 * 这段正文里是否真有一段「被写进的调用」。
 *
 * 先去掉围栏代码块和行内代码：解释性回复里引用格式（例如「模型会写成 `<tool_call>…`」）
 * 不算泄漏——2026-11-04 08:33 就因此误判过一次。去掉空行后按行看，只有整行以调用
 * 标记开头，才像模型自己写出来的调用。
 */
export function looksLikeCall(text: unknown): boolean {
  const bare = String(text ?? '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  return bare.split('\n').some((line) => LEAK_AT_LINE_START.test(line.trim()))
}

/**
 * 造一条规范的用户消息（id 由 randomUUID 给出）。
 * 会话日志对 user/message 的要求见文件头「历史闸」一节。
 */
export function buildUserMessage(text: string, options: { kind?: string; form?: string } = {}): any {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: options.kind ?? 'user', ...(options.form === undefined ? {} : { form: options.form }) },
  }
}

/** 校验「可识别消息」是否成立；不成立就抛错（在写日志之前失败，比写坏整条历史好）。 */
export function assertIdentifiedMessage(message: any, subject = 'message'): true {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError(`${subject} is not a message object`)
  }
  const { id, role, source, content } = message
  if (typeof id !== 'string' || id === '') throw new TypeError(`${subject} lacks an identified message: missing id`)
  if (typeof role !== 'string' || !MESSAGE_ROLES.has(role)) throw new TypeError(`${subject} has an invalid role`)
  if (source === null || typeof source !== 'object' || typeof source.kind !== 'string' || source.kind === '') {
    throw new TypeError(`${subject} lacks a source kind`)
  }
  if (!Array.isArray(content)) throw new TypeError(`${subject} content must be an array`)
  return true
}

/** 把一条不合格的消息修成合格消息；修不动（缺 content）就判为丢弃。 */
export function repairIdentifiedMessage(message: any): any | undefined {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const sourceOk = message.source !== null && typeof message.source === 'object'
    && typeof message.source.kind === 'string' && message.source.kind !== ''
  if (!Array.isArray(message.content)) return undefined
  const patched = Object.isExtensible(message) ? message : { ...message }
  if (typeof patched.id !== 'string' || patched.id === '') patched.id = randomUUID()
  if (patched.role !== 'user') patched.role = 'user'
  if (!sourceOk) patched.source = { kind: 'user' }
  return patched
}

/**
 * 写日志前最后一道闸：确保即将进入 `user/message` 事件的每条消息都有 id。
 * 别的插件（或以后新增的注入路径）漏掉 id 时补上并留一行诊断。
 */
export function guardMessagesForHistory(messages: readonly any[], log: (line: string) => void = () => {}): any[] {
  const out: any[] = []
  for (const message of messages ?? []) {
    if (typeof message?.id === 'string' && message.id !== '') { out.push(message); continue }
    const repaired = repairIdentifiedMessage(message)
    if (repaired === undefined) {
      log(`dropped invalid message (no usable content) role=${String(message?.role ?? '?')}`)
      continue
    }
    log(`stamped missing id (role=${String(repaired.role)}, source=${String(repaired.source?.kind)})`)
    out.push(repaired)
  }
  return out
}

/**
 * 在 `agent/pre-step` 的 waterfall 上兜住所有即将落盘的 user/message。
 * `prepend` = 跑在其它 pre-step 插件之后、落盘之前。
 */
export function installHistoryGuard(ctx: any, log: (line: string) => void, isEnabled: () => boolean): () => void {
  if (typeof ctx?.on !== 'function') return () => void 0
  const off = ctx.on('agent/pre-step', async (_payload: any, next: any) => {
    const decision = await next()
    if (!isEnabled()) return decision
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    const guarded = guardMessagesForHistory(decision.messages, (line) => log(`pre-step: ${line}`))
    if (guarded.length === decision.messages.length) return decision
    return { ...decision, messages: guarded }
  }, { prepend: true })
  return typeof off === 'function' ? off : () => void 0
}

function eventsOf(session: any): any[] {
  return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
}

/** 最后一条 assistant 消息事件。 */
export function lastAssistantEvent(session: any): any | undefined {
  const events = eventsOf(session)
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'assistant/message') return events[i]
  }
  return undefined
}

/** 判定结果：`steer` 为真表示这一轮需要补一步；`branch` 是本次走到的判据分支名。 */
export interface TurnGuardVerdict {
  steer: boolean
  reason?: 'leak' | 'empty'
  /** 判据分支名（进日志，便于核对这一轮被哪条判据拦下） */
  branch: 'no-assistant' | 'cap' | 'toolcall' | 'text-ok' | 'leak' | 'empty' | 'fallthrough'
  hasToolCall?: boolean
  text?: string
  /** 当前 turn 已补过几次（配额口径：按 turn 计数，跨 turn / 跨天自动重置） */
  injected?: number
  /** 当前 turn 的上限（= maxPerTurn） */
  injectedMax?: number
  /** 同一自然日累计补过几次（只进日志，不参与判定） */
  dayInjected?: number
  /** 本次判定归属的 turn 号 */
  turn?: number
}

/** `[turn-guard]` 注入按 turn / 按日的归口结果。 */
export interface GuardInjectionCounts {
  byTurn: Map<number, number>
  byDay: Map<string, number>
  /** 归不到任何 turn 的注入（没有 turn/start 的旧会话或测试夹具） */
  unscoped: number
  total: number
}

/** 事件时间戳（毫秒）：`snapshotEvents()` 把 time 挂在事件本体，兼容 data.time。 */
function eventTimeMs(event: any): number {
  const raw = typeof event?.time === 'number' ? event.time : typeof event?.data?.time === 'number' ? event.data.time : void 0
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/** 宿主本地日期（Asia/Shanghai）YYYY-MM-DD，用于「按天」的日志计数。 */
function dayKeyOf(event: any): string {
  const ms = eventTimeMs(event)
  if (ms === 0) return ''
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 这条事件是不是 guard 自己注入的纠正消息？ */
function isGuardInjectionEvent(event: any): boolean {
  if (event?.type !== 'user/message') return false
  const content = event?.data?.content ?? []
  return content.some((b: any) => b?.type === 'text' && String(b?.text ?? '').startsWith(MARK))
}

/**
 * 把历史里的 `[turn-guard]` 注入按 turn 归口。
 *
 * guard 是在 `agent/turn-stopping`（turn 收尾、循环 break 之前）注入的，所以这条
 * user/message 一定落在「本次 turn/start 之后、下一次 turn/start 之前」⇒ 归属那个 turn。
 * 会话里没有 turn/start（旧会话 / 单测夹具）时退回最近一条 assistant 消息的 turn 号；
 * 两者都拿不到就计入 `unscoped`——它不会把任何 turn 判满，也就不会再永久静音。
 */
export function countGuardInjections(events: readonly any[]): GuardInjectionCounts {
  const byTurn = new Map<number, number>()
  const byDay = new Map<string, number>()
  let unscoped = 0
  let total = 0
  let currentTurn: number | undefined
  let currentDay: string | undefined
  for (const event of events ?? []) {
    if (event?.type === 'turn/start') {
      const turn = event?.data?.turn
      if (typeof turn === 'number' && Number.isFinite(turn)) currentTurn = turn
      currentDay = dayKeyOf(event) || currentDay
      continue
    }
    if (event?.type === 'assistant/message') {
      const turn = event?.data?.turn
      if (currentTurn === undefined && typeof turn === 'number' && Number.isFinite(turn)) currentTurn = turn
      const day = dayKeyOf(event)
      if (day) currentDay = day
      continue
    }
    if (!isGuardInjectionEvent(event)) continue
    total += 1
    if (currentTurn === undefined) unscoped += 1
    else byTurn.set(currentTurn, (byTurn.get(currentTurn) ?? 0) + 1)
    const day = dayKeyOf(event) || currentDay
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  return { byTurn, byDay, unscoped, total }
}

/**
 * 判断这一轮是否需要补一步纠正。
 * @param session - 会话（读 `snapshotEvents()`）
 * @param config - `{ maxPerTurn, steerEmptyText }`
 * @param turn - 当前 turn 号（`agent/turn-stopping` 的 payload.turn）。给了且会话里有 turn 边界
 *               就按 turn 计数；否则退回旧的「整条会话累计」口径（不会把判据改形）。
 */
export function judge(
  session: any,
  config: { maxPerTurn?: number; steerEmptyText?: boolean } = {},
  turn?: number,
): TurnGuardVerdict {
  const maxPerTurn = Number.isFinite(config.maxPerTurn) ? Math.max(0, Math.floor(config.maxPerTurn as number)) : 3
  const steerEmptyText = config.steerEmptyText !== false
  const events = eventsOf(session)
  const last = lastAssistantEvent(session)
  if (last === undefined) {
    return { steer: false, branch: 'no-assistant', injected: 0, injectedMax: maxPerTurn, dayInjected: 0, turn }
  }

  const blocks = last.data?.message?.content ?? []
  const hasToolCall = blocks.some((b: any) => b?.type === 'tool-call')
  const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b?.text ?? '').join('\n').trim()
  const hasReasoning = blocks.some((b: any) => b?.type === 'reasoning')

  const counts = countGuardInjections(events)
  const perTurn = typeof turn === 'number' && counts.byTurn.size > 0
  const injected = perTurn ? (counts.byTurn.get(turn as number) ?? 0) : counts.total
  const injectedMax = maxPerTurn
  const dayInjected = counts.byDay.get(dayKeyOf(last)) ?? 0
  const tail = { hasToolCall, text, injected, injectedMax, dayInjected, turn } as const

  if (injected >= maxPerTurn) return { steer: false, branch: 'cap', ...tail }
  if (hasToolCall) return { steer: false, branch: 'toolcall', hasToolCall: true, ...tail }
  if (text !== '' && !LEAK.test(text)) return { steer: false, branch: 'text-ok', ...tail }
  if (looksLikeCall(text)) return { steer: true, reason: 'leak', branch: 'leak', ...tail }
  if (steerEmptyText && text === '' && hasReasoning) return { steer: true, reason: 'empty', branch: 'empty', ...tail }
  return { steer: false, branch: 'fallthrough', ...tail }
}

/** 生成纠正消息正文（附上最后一条工具错误，提醒完整参数）。 */
export function correctiveText(reason: 'leak' | 'empty', detail = ''): string {
  const tail = detail ? `\n\n上一步工具返回的错误：${detail}` : ''
  if (reason === 'leak') {
    return `${MARK} 你上一条消息把工具调用写成了正文（只输出了 <tool_call>/</function> 之类的片段），没有形成可执行的工具调用，这一步等于空转。
请立刻重新发出真正的工具调用继续上一步操作：只给工具名和完整参数，不要用文字描述、不要留空的 <tool_call>、不要省略必需字段（click/scroll/input_text 需要 screen_index；click/drag/scroll 需要 position）。${tail}`
  }
  return `${MARK} 你上一条消息只有思考，没有正文也没有工具调用，这一步等于空转。
请立刻用真正的工具调用继续任务（只给工具名和完整参数）；如果任务确实已经完成，再给一句结论。${tail}`
}

/** 最后一条工具错误（如 INVALID_ARGS 的缺失字段），供纠正消息引用。 */
export function lastToolError(session: any): string {
  const events = eventsOf(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'tool/result') continue
    const error = event?.data?.error
    const text = (event?.data?.message?.content ?? []).find((b: any) => b?.type === 'text')?.text ?? ''
    if (error || /^Error:/.test(String(text))) return `${error?.code ?? ''} ${String(text).slice(0, 200)}`.trim()
    return ''
  }
  return ''
}

/** 会话当前的 agent 预设（优先投影，退回 header）。 */
export function presetOf(ctx: any, session: any): string | undefined {
  try {
    const projections = ctx?.get?.('sessionProjections') ?? ctx?.sessionProjections
    const live = projections?.stateOf?.(session, 'agentPreset')
    if (typeof live === 'string' && live !== '') return live
  } catch { /* 退回 header */ }
  const header = session?.header?.agentPreset
  return typeof header === 'string' && header !== '' ? header : undefined
}

/* ---------- 状态文件（profile 目录；跨端共用） ---------- */

export interface TurnGuardState {
  /** 总开关：false = 完全不干预（连历史闸也不跑）。 */
  enabled: boolean
  /** 只在哪些 agent 预设生效；`['*']` = 所有模式。 */
  presets: string[]
  /** 同一会话最多补几次。 */
  maxPerTurn: number
  /** 只有思考、没有说话是否也补。 */
  steerEmptyText: boolean
  /** 单调递增的写版本号；客户端据此判断要不要重新渲染。 */
  revision: number
  /** 最近一次写入时间（ISO 8601）。 */
  updatedAt: string
}

/** 默认状态：沿用原插件的运行参数（所有预设、补 3 次、空思考也补）。 */
export function defaultState(): TurnGuardState {
  return { enabled: true, presets: ['*'], maxPerTurn: 3, steerEmptyText: true, revision: 0, updatedAt: '' }
}

/** 把任意来源的对象规整成合法状态；坏数据一律当默认值（默认开启，与并入前行为一致）。 */
export function normalizeState(raw: unknown): TurnGuardState {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const fallback = defaultState()
  const presets: string[] = []
  if (Array.isArray(record.presets)) {
    for (const item of record.presets) {
      const text = String(item ?? '').trim()
      if (text && text.length <= MAX_PRESET_LENGTH && !presets.includes(text) && presets.length < MAX_PRESETS) presets.push(text)
    }
  }
  const maxPerTurnRaw = record.maxPerTurn
  const maxPerTurn = typeof maxPerTurnRaw === 'number' && Number.isFinite(maxPerTurnRaw)
    ? Math.min(20, Math.max(0, Math.floor(maxPerTurnRaw)))
    : fallback.maxPerTurn
  const revision = typeof record.revision === 'number' && Number.isFinite(record.revision) && record.revision >= 0
    ? Math.floor(record.revision)
    : 0
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    presets: presets.length > 0 ? presets : fallback.presets,
    maxPerTurn,
    steerEmptyText: typeof record.steerEmptyText === 'boolean' ? record.steerEmptyText : fallback.steerEmptyText,
    revision,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/** 读状态（按 mtime 缓存，关开关后下一轮立刻看到新值，不必重启）。 */
function readStateSync(file: string): TurnGuardState {
  let mtimeMs = 0
  try { mtimeMs = statSync(file).mtimeMs } catch { /* 文件不存在 */ }
  if (cache !== null && cache.file === file && cache.mtimeMs === mtimeMs) return cache.state
  let state: TurnGuardState
  try {
    state = normalizeState(JSON.parse(stripBom(readFileSync(file, 'utf8'))))
  } catch {
    // 文件不存在 / JSON 损坏：等价于「还从没动过开关」= 默认开启。
    state = defaultState()
  }
  cache = { file, mtimeMs, state }
  return state
}

/** 最近一次读到的状态（mtime 未变时复用）。 */
let cache: { file: string; mtimeMs: number; state: TurnGuardState } | null = null

/** tmp + rename 原子替换：读者永远只会看到完整文件。 */
function writeStateSync(file: string, state: TurnGuardState): void {
  const payload = `${JSON.stringify(state, void 0, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temporary, payload, 'utf8')
  renameSync(temporary, file)
}

/**
 * 状态存储。所有读写排进同一条 Promise 队列：手机与电脑同时点也不会交错写坏文件。
 */
export class TurnGuardStore {
  readonly file: string
  private chain: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  private enqueue<T>(task: () => T): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => void 0, () => void 0)
    return run
  }

  /** 同步读：turn 收尾时要立刻拿到开关，不能等 Promise。 */
  readSync(): TurnGuardState {
    return readStateSync(this.file)
  }

  read(): Promise<TurnGuardState> {
    return this.enqueue(() => readStateSync(this.file))
  }

  /** 改开关 / 参数；值没变时不写盘、不涨 revision。 */
  patch(change: Partial<Pick<TurnGuardState, 'enabled' | 'presets' | 'maxPerTurn' | 'steerEmptyText'>>): Promise<TurnGuardState> {
    return this.enqueue(() => {
      const current = readStateSync(this.file)
      const next: TurnGuardState = {
        enabled: typeof change.enabled === 'boolean' ? change.enabled : current.enabled,
        presets: Array.isArray(change.presets) ? change.presets.slice(0, MAX_PRESETS).map((item) => String(item).slice(0, MAX_PRESET_LENGTH)).filter(Boolean) : current.presets,
        maxPerTurn: typeof change.maxPerTurn === 'number' && Number.isFinite(change.maxPerTurn)
          ? Math.min(20, Math.max(0, Math.floor(change.maxPerTurn)))
          : current.maxPerTurn,
        steerEmptyText: typeof change.steerEmptyText === 'boolean' ? change.steerEmptyText : current.steerEmptyText,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }
      const same = next.enabled === current.enabled
        && next.maxPerTurn === current.maxPerTurn
        && next.steerEmptyText === current.steerEmptyText
        && next.presets.join('\u0000') === current.presets.join('\u0000')
      if (same) return current
      writeStateSync(this.file, next)
      return next
    })
  }
}

/* ---------- profile 目录解析 ---------- */

function optionalService(ctx: any, id: string): unknown {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(id)
  } catch { /* 服务不存在 */ }
  return undefined
}

/** 当前 profile 目录（宿主 desktop / `dsh web` 都提供 profileContext.dir）；绝不硬编码绝对路径。 */
function profileDirectory(ctx: any): string {
  const profile = optionalService(ctx, 'profileContext') as { dir?: unknown } | undefined
  if (profile && typeof profile.dir === 'string' && profile.dir !== '') return profile.dir
  const homePaths = optionalService(ctx, 'homePaths') as { home?: unknown } | undefined
  if (homePaths && typeof homePaths.home === 'string' && homePaths.home !== '') return homePaths.home
  return process.cwd()
}

/* ---------- HTTP ---------- */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > limit) {
        reject(Object.assign(new Error('too-large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, MAX_BODY_BYTES)
  if (bytes.length === 0) return {}
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

async function handleRequest(store: TurnGuardStore, logFile: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== PREFIX) {
    sendJson(res, 404, { error: 'not-found' })
    return
  }
  const method = req.method ?? 'GET'
  try {
    if (method === 'OPTIONS') {
      res.writeHead(204, { allow: 'GET, POST, OPTIONS' })
      res.end()
      return
    }
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, ...(await store.read()), logFile, version: VERSION })
      return
    }
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const change: Partial<Pick<TurnGuardState, 'enabled' | 'presets' | 'maxPerTurn' | 'steerEmptyText'>> = {}
      if (typeof body.enabled === 'boolean') change.enabled = body.enabled
      if (typeof body.maxPerTurn === 'number') change.maxPerTurn = body.maxPerTurn
      if (typeof body.steerEmptyText === 'boolean') change.steerEmptyText = body.steerEmptyText
      if (Array.isArray(body.presets)) change.presets = body.presets.map((item) => String(item ?? ''))
      if (Object.keys(change).length === 0) {
        sendJson(res, 400, { error: 'nothing-to-change' })
        return
      }
      const next = await store.patch(change)
      sendJson(res, 200, { ok: true, ...next, logFile, version: VERSION })
      return
    }
    res.writeHead(405, { allow: 'GET, POST, OPTIONS' })
    res.end()
  } catch (error) {
    const status = (error as { status?: unknown })?.status
    if (status === 413) { sendJson(res, 413, { error: 'too-large' }); return }
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: String((error as Error)?.message ?? error) })
    else res.end()
  }
}

/* ---------- 插件体 ---------- */

/**
 * 挂上 turn-stopping 判定与 pre-step 历史闸；两者都按当前开关实时判断，
 * 所以设置页一点开关，下一轮就按新状态跑（无需重载插件）。
 *
 * 每次决策（含「开关关闭 / 预设不在名单 / 配额已满」这些不动作的判定）都写一行
 * verdict 日志：`verdict turn=N steer=… branch=… injected=已补/上限 dayInjected=… maxPerTurn=…`。
 */
export function installTurnGuard(ctx: any, options: { readState: () => TurnGuardState; log: (line: string) => void }): () => void {
  const disposers: Array<() => void> = []
  if (typeof ctx?.on !== 'function') {
    options.log('宿主没有事件总线（ctx.on 不可用），turn-guard 未启用')
    return () => void 0
  }
  const isEnabled = (): boolean => options.readState().enabled === true

  const offHistory = installHistoryGuard(ctx, options.log, isEnabled)
  disposers.push(offHistory)

  try {
    const off = ctx.on('agent/turn-stopping', (payload: any) => {
      try {
        const state = options.readState()
        const turnLabel = typeof payload?.turn === 'number' ? String(payload.turn) : '?'
        const quota = `maxPerTurn=${state.maxPerTurn}`
        if (state.enabled !== true) {
          options.log(`verdict turn=${turnLabel} steer=false branch=disabled injected=0/${state.maxPerTurn} ${quota}`)
          return
        }
        const agent = payload?.agent
        const session = agent?.session
        if (agent === undefined || session === undefined) {
          options.log(`verdict turn=${turnLabel} steer=false branch=no-agent ${quota}`)
          return
        }
        const anyPreset = state.presets.includes('*')
        if (!anyPreset) {
          const preset = presetOf(ctx, session)
          if (preset === undefined || !state.presets.includes(preset)) {
            options.log(`verdict turn=${turnLabel} steer=false branch=preset-skip preset=${String(preset ?? '?')} allowed=[${state.presets.join(',')}] ${quota}`)
            return
          }
        }
        const turn = typeof payload?.turn === 'number' ? payload.turn : void 0
        const verdict = judge(session, state, turn)
        const injected = verdict.injected ?? 0
        const injectedMax = verdict.injectedMax ?? state.maxPerTurn
        options.log(`verdict turn=${turnLabel} steer=${verdict.steer ? 'true' : 'false'} branch=${verdict.branch} `
          + `injected=${injected}/${injectedMax} dayInjected=${verdict.dayInjected ?? 0} scoped=${turn === undefined ? 'session' : 'turn'} ${quota}`
          + ` text=${JSON.stringify(String(verdict.text ?? '').slice(0, 40))}`)
        if (!verdict.steer) return
        const message = buildUserMessage(correctiveText(verdict.reason as 'leak' | 'empty', lastToolError(session)), {
          kind: 'user',
          form: 'turn-guard',
        })
        // 走唯一的构造入口：id 一定有，形状一定校验过（不合格直接抛，绝不写坏日志）。
        assertIdentifiedMessage(message, 'turn-guard corrective message')
        agent.send(message, 'next-step', false)
        options.log(`steer turn=${turnLabel} reason=${verdict.reason} branch=${verdict.branch} injected=${injected + 1}/${injectedMax} text=${JSON.stringify(String(verdict.text ?? '').slice(0, 40))}`)
      } catch (error) {
        options.log(`steer failed: ${(error as Error)?.stack ?? String(error)}`)
      }
    })
    if (typeof off === 'function') disposers.push(off)
    options.log('已挂上 agent/turn-stopping 判定（pre-step 历史闸同挂；开关按状态文件实时判断）')
  } catch (error) {
    options.log(`turn-stopping 挂不上：${String((error as Error)?.message ?? error)}`)
  }

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch { /* 卸载竞态无需处理 */ }
    }
  }
}

/**
 * 注册状态路由 + 挂上 turn-guard。开关真值在 `<profile>/dsh-assistant-turn-guard.json`，
 * 客户端（设置页「个人助手 → 托管」）通过同源 GET/POST 读写。
 */
export function apply(ctx: any): () => void {
  const directory = profileDirectory(ctx)
  const store = new TurnGuardStore(join(directory, STATE_FILENAME))
  const logFile = join(dshHome(), LOG_FILENAME)
  const log = (line: string): void => {
    try {
      const bullet = `dsh-assistant: ${line}`
      console.warn(bullet)
      appendFileSync(logFile, `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`, 'utf8')
    } catch { /* 诊断写不出去也不该让插件启动失败 */ }
  }
  const initial = store.readSync()
  log(`load: v${VERSION} enabled=${initial.enabled} presets=[${initial.presets.join(', ')}] maxPerTurn=${initial.maxPerTurn} steerEmptyText=${initial.steerEmptyText}`)

  const disposers: Array<() => void> = []
  try {
    const routes = manageWebRoutes(ctx.webServer)
    routes.webServer.register({
      kind: 'exact',
      path: PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void handleRequest(store, logFile, req, res)
      },
    })
    disposers.push(routes.dispose)
    log(`已挂载 turn-guard 路由 GET/POST ${PREFIX}（状态文件 ${store.file}）`)
  } catch (error) {
    log(`turn-guard 路由挂载失败（开关仍按状态文件生效）：${String((error as Error)?.message ?? error)}`)
  }

  disposers.push(installTurnGuard(ctx, { readState: () => store.readSync(), log }))
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch { /* 卸载竞态无需处理 */ }
    }
  }
}

/** 测试面：scripts/test-turn-guard.mjs 直接拿判定与状态函数。 */
export const turnGuardTestSurface = {
  looksLikeCall,
  judge,
  countGuardInjections,
  correctiveText,
  lastToolError,
  buildUserMessage,
  guardMessagesForHistory,
  normalizeState,
  defaultState,
  Mark: MARK,
  Version: VERSION,
}

export default apply
