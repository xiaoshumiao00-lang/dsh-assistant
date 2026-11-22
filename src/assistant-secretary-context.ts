/**
 * 秘书会话「模型上下文滚动摘要」的宿主侧实现（第四批需求 B）。
 *
 * 实测口径（先取证再动手，2026-11-21）：
 * 现役秘书会话 session-83bca3e3…（只读，没换 id、没分片、没重拼日志）实测：
 *   事件行 695 / 最大 seq 693 / turn/end 51 条 / user 消息 86 条（其中 26 条是插件塞的合成通知）
   / assistant 消息 64 条 / 正文总词数 5965 / 每轮均值 117 词 / 中位 67 词 / 最大单轮 942 词
 *   最近 6 轮 498 词、7 轮 543、8 轮 580、9 轮 631、10 轮 668
 *   单次请求实测 usage：inputTokens 239、cacheReadTokens 58368、totalTokens 58693（contextWindow 1048576）
 *   宿主自动压缩（compaction-basic：auto=true、thresholdRatio=0.8、retainRatio=0.16）这条会话触发过 0 次。
 * 结论：最近原文轮数取 **8**（CONTEXT_RECENT_ROUNDS）—— 注入预算 1200 词按均值够 10 轮，
 * 但实测最大单轮 942 词，两个大轮就会把预算挤爆；8 轮（实测 580 词）留 620 词给滚动摘要段，
 * 9/10 轮只比 8 轮多约 8%/15% 的覆盖，边际收益不抵风险。词数口径 = countWords()（词数，不是 token）。
 *
 * 合法上下文通道（取证结果，2026-11-21；2026-11-22 用户定案后更新）：
 *   - `agent/pre-step` 只能「拒绝这一步」或替换**即将进入这一步的 messages**（宿主 api-catalog 原文），
 *     插件不能拿它删掉已经在日志里的旧轮；`agent/request` 明写「this waterfall cannot mutate messages」；
 *     `llm/stream` 送来的 request 是 deep-frozen（改它就抛）。
 *   - 真正的裁剪只有宿主 compaction。宿主 dsh-compaction-basic 已在 dsh-base 装配（默认
 *     thresholdRatio=.8 / retainRatio=.16 / auto=true，1M 窗口 ⇒ 阈值 ≈83.9 万 token，实测 8.4 万，
 *     所以从来没触发过）。它的服务缝是 `ctx.compaction.compactNow(agent, signal, sourceCommandId)`：
 *     只在**指定会话**的 idle agent 上做一次原生压缩——往日志追加 compaction/start、compaction/summary、
 *     一条带 surfaceOp=replace 的 user/message 检查点、compaction/end（全部走宿主自己的 append 通道，
 *     只追加、不改写旧帧，绝不离线重拼 zstd）。Session.deriveMessages() 只投影 surface 节点，
 *     被 replace  shadow 掉的旧轮从此不进模型请求；原始事件仍在日志里，秘书页卡片/已读/分页/朗读
 *     全部不受影响（卡片取数读原始事件，不走 deriveMessages）。
 *   - 2026-11-22 起插件在滚动摘要的同触发点（每 12 轮 / 10000 词）对固定秘书会话调用 compactNow，
 *     把「注入摘要段」升级成「注入摘要段 + 宿主真的把旧轮挤出模型上下文」。模型每轮看到的变成：
 *     系统段（含最近 8 轮原文 + 滚动摘要）+ 宿主检查点 + 最近一轮，旧轮原文不再出现在消息列表里。
 *   - 插件能往模型送字的合法通道只有 ctx.systemPrompt.section（现成用法见 assistant-secretary.ts）。
 *
 * 摘要落盘：~/.dsh/assistant/dsh-assistant-secretary-context.json（插件自己的 JSON，走 tmp+rename 序列化），
 * 绝不写会话日志、绝不自己拼 turn 事件、绝不用 agent 之外的写日志通道。
 * 触发：比上次摘要多满 12 轮（turn/end 计数）或累计新增词数 ≥ 10000（词数口径）。
 * 生成失败/超时：降级成「只带最近 N 轮原文」继续跑，并在诊断日志记一条（appendOpenDiag）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { manageWebRoutes } from './web-routes'
import { appendOpenDiag } from './assistant-open-diag'
import { assistantHomeDir } from './assistant-home'
import { secretarySessionRef } from './assistant-secretary'
import {
  CONTEXT_RECENT_ROUNDS,
  CONTEXT_ROUND_LOG_MAX,
  CONTEXT_ROUND_TRIGGER,
  CONTEXT_WORD_TRIGGER,
  CONTEXT_SUMMARY_TIMEOUT_MS,
  countWords,
  isProgressLine,
  isSyntheticNoticeUserText,
  rollingSummaryText,
  selectRecentRounds,
  stripNoticeSyntheticHead,
  summarizeRoundText,
} from './secretary-card-shared'

export const ASSISTANT_SECRETARY_CONTEXT_ROUTE = '/api/assistant/secretary-context'
export const CONTEXT_STATE_FILENAME = 'dsh-assistant-secretary-context.json'
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
const MAX_ROUNDS_IN_MEMORY = 400

/**
 * 宿主压缩（旧轮挤出模型上下文）触发纪律：
 *   - 只在滚动摘要的同触发点（每 12 轮 / 10000 词，见 contextSummaryTriggered）要求一次挤出；
 *   - 总会话轮数低于 EVICT_MIN_TURNS 不要求（历史太短挤了也没意义，compactNow 自己也会判 null）；
 *     这是单调的下限（>=），不是窗口：轮数持续增长，迟早越过门槛，不存在永远达不到的死锁——
 *     触发线 12 时只是挤出比摘要晚一个边界（新会话轮 13 摘要被门槛挡住、轮 25 摘要时才挤）；
 *   - compactNow 要求 idle agent：busy 时在每次 agent/status=idle 重试，连撞 EVICT_MAX_BUSY_RETRIES
 *     次就放下次触发点再来；其它错误（摘要 LLM 调用失败等）记下 lastError 直接放下次。
 * 全部错误就地吞掉写诊断，绝不往宿主事件链上抛。
 */
export const EVICT_MIN_TURNS = 16
export const EVICT_MAX_BUSY_RETRIES = 3
export const EVICT_SOURCE_ID = 'assistant-secretary-context-v1'

/** 一次宿主压缩的结果记录（落盘，供验收/诊断读回）。 */
export interface ContextEviction {
  at: string
  count: number
  shadowedTokens: number
  busyRetries: number
  lastError: string
}

export function emptyContextEviction(): ContextEviction {
  return { at: '', count: 0, shadowedTokens: 0, busyRetries: 0, lastError: '' }
}

/** 一轮（turn）的明细：已完成任务 / 结论 / 待办，都是压过的小段。 */
export interface ContextRound {
  turn: number
  seqFrom: number
  seqTo: number
  task: string
  conclusion: string
  todos: string[]
  /** 本轮原文词数（词数口径） */ words: number
  /** 本轮原文（最近 N 轮注入模型时要用；只有窗口内的轮留正文，更旧的轮只留摘要段） */
  text?: string
  at: number
}

export interface ContextState {
  version: 1
  sessionId: string
  updatedAt: string
  summaryAt: string
  summary: string
  totalTurns: number
  totalWords: number
  rounds: ContextRound[]
  degraded: boolean
  degradedReason: string
  /** 送进模型的原文轮数（实测口径，验收断言靠它） */
  recentRounds: number
  /** 摘要生成失败/总次数（诊断用） */
  degradeCount: number
  /** 上次摘要压到哪一轮（轮数口径的基准，修 off-by-30 的关键） */
  summaryThroughTurn: number
  /** 上次摘要时累计到的词数（词数口径的基准：新增词数够 10000 才再压一次） */
  summaryThroughWords: number
  /** 宿主压缩（旧轮挤出模型上下文）的记录；从没挤过就是空记录 */
  eviction: ContextEviction
}

export function emptyContextState(sessionId = ''): ContextState {
  return {
    version: 1,
    sessionId,
    updatedAt: '',
    summaryAt: '',
    summary: '',
    totalTurns: 0,
    totalWords: 0,
    rounds: [],
    degraded: false,
    degradedReason: '',
    recentRounds: 0,
    degradeCount: 0,
    summaryThroughTurn: 0,
    summaryThroughWords: 0,
    eviction: emptyContextEviction(),
  }
}

const TEXT_CAP = 3000

function capText(value: unknown): string {
  const codePoints = Array.from(String(value ?? ''))
  if (codePoints.length <= TEXT_CAP) return codePoints.join('')
  return codePoints.slice(0, TEXT_CAP).join('')
}

/**
 * 事件里的正文块 → 纯文本。宿主两种消息形状都要认（2026-11-22 现网实测定案）：
 *   - user/message：content 直接在 data.content 上，且**没有 data.turn**；
 *   - assistant/message：content 在 data.message.content 上，data.turn 在。
 * 与秘书页卡片同一套取法（secretary-card-shared.ts 的 eventText）。
 */
function textOfEvent(event: any): string {
  const content = event?.data?.content ?? event?.data?.message?.content ?? event?.data?.data?.content
  if (!Array.isArray(content)) return ''
  return content.filter((block: any) => block?.type === 'text').map((block: any) => String(block?.text ?? '')).join('\n').trim()
}

/** 归一磁盘上的摘要文件：坏值一律丢掉，绝不因为文件坏过一次就把会话搞坏。 */
export function normalizeContextState(raw: unknown, sessionId = ''): ContextState {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {}
  const roundsRaw = Array.isArray(source.rounds) ? source.rounds : []
  const rounds: ContextRound[] = []
  for (const item of roundsRaw) {
    const turn = Number(item?.turn)
    if (!Number.isFinite(turn) || turn <= 0) continue
    rounds.push({
      turn: Math.floor(turn),
      seqFrom: Number(item?.seqFrom) || 0,
      seqTo: Number(item?.seqTo) || 0,
      task: String(item?.task ?? '').slice(0, 400),
      conclusion: String(item?.conclusion ?? '').slice(0, 400),
      todos: (Array.isArray(item?.todos) ? item.todos : []).map((todo: unknown) => String(todo ?? '').slice(0, 120)).filter((todo: string) => todo !== '').slice(0, 6),
      words: Number(item?.words) || 0,
      text: typeof item?.text === 'string' ? capText(item.text) : undefined,
      at: Number(item?.at) || 0,
    })
  }
  rounds.sort((left, right) => left.turn - right.turn)
  while (rounds.length > CONTEXT_ROUND_LOG_MAX) rounds.shift()
  const totalTurns = Number.isFinite(Number(source.totalTurns)) ? Math.max(0, Math.floor(Number(source.totalTurns))) : rounds.length
  const persistedWords = Number.isFinite(Number(source.totalWords)) ? Math.max(0, Math.floor(Number(source.totalWords))) : rounds.reduce((sum, round) => sum + round.words, 0)
  const storedSession = String(source.sessionId ?? '').trim()
  return {
    version: 1,
    sessionId: SESSION_ID_RE.test(storedSession) ? storedSession : String(sessionId ?? ''),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    summaryAt: typeof source.summaryAt === 'string' ? source.summaryAt : '',
    summary: typeof source.summary === 'string' ? capText(source.summary) : '',
    totalTurns,
    totalWords: persistedWords,
    rounds,
    degraded: source.degraded === true,
    degradedReason: typeof source.degradedReason === 'string' ? source.degradedReason.slice(0, 240) : '',
    recentRounds: Number.isFinite(Number(source.recentRounds)) ? Math.max(0, Math.floor(Number(source.recentRounds))) : 0,
    degradeCount: Number.isFinite(Number(source.degradeCount)) ? Math.max(0, Math.floor(Number(source.degradeCount))) : 0,
    summaryThroughTurn: Number.isFinite(Number(source.summaryThroughTurn)) ? Math.max(0, Math.floor(Number(source.summaryThroughTurn))) : 0,
    summaryThroughWords: Number.isFinite(Number(source.summaryThroughWords)) ? Math.max(0, Math.floor(Number(source.summaryThroughWords))) : 0,
    eviction: normalizeContextEviction(source.eviction),
  }
}

/** 挤出记录归一：缺字段/坏值一律回空记录（老版本摘要文件没有这段，必须向后兼容）。 */
export function normalizeContextEviction(raw: unknown): ContextEviction {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {}
  return {
    at: typeof source.at === 'string' ? source.at : '',
    count: Number.isFinite(Number(source.count)) ? Math.max(0, Math.floor(Number(source.count))) : 0,
    shadowedTokens: Number.isFinite(Number(source.shadowedTokens)) ? Math.max(0, Math.floor(Number(source.shadowedTokens))) : 0,
    busyRetries: Number.isFinite(Number(source.busyRetries)) ? Math.max(0, Math.floor(Number(source.busyRetries))) : 0,
    lastError: typeof source.lastError === 'string' ? source.lastError.slice(0, 240) : '',
  }
}

/** 触发判据（口径只有词数，不是 token）：比上次摘要多满 12 轮，或比上次摘要新增满 10000 词。 */
export function contextSummaryTriggered(state: ContextState, options: { skipRoundTrigger?: boolean } = {}): boolean {
  const turns = Math.max(0, Number(state.totalTurns) || 0)
  const words = Math.max(0, Number(state.totalWords) || 0)
  const baseTurn = Math.max(0, Number(state.summaryThroughTurn) || 0)
  const baseWords = Math.max(0, Number(state.summaryThroughWords) || 0)
  const roundHit = options.skipRoundTrigger !== true && turns - baseTurn >= CONTEXT_ROUND_TRIGGER
  const wordHit = words - baseWords >= CONTEXT_WORD_TRIGGER
  // 第一条摘要在轮 1 就起头（会话刚开时还没有摘要段可用）
  const firstSummary = state.summary === '' && turns > 0 && baseTurn === 0
  return roundHit || wordHit || firstSummary
}

/** 一轮原文 → 本轮明细（压成一小段：已完成任务、结论、待办）。中间汇报/取证过程行丢掉。 */
export function roundFromText(turn: number, texts: readonly string[], seqFrom: number, seqTo: number): ContextRound {
  const kept = texts.map((text) => String(text ?? '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !isProgressLine(line))
    .join('\n'))
  const joined = kept.filter((text) => text !== '').join('\n').trim()
  const summary = summarizeRoundText(joined)
  return {
    turn,
    seqFrom,
    seqTo,
    task: summary.task,
    conclusion: summary.conclusion,
    todos: summary.todos,
    words: countWords(joined),
    text: capText(joined),
    at: Date.now(),
  }
}

/**
 * 把已完成轮次压成一小段。宿主这里用**本地确定性压缩**（不花模型额度、不阻塞会话）：
 * 任何一步失败（包括超时）都会抛出去，调用方负责降级。
 */
export function buildSummaryText(rounds: readonly ContextRound[]): Promise<string> {
  const work = async (): Promise<string> => {
    const entries = rounds.slice(-CONTEXT_ROUND_LOG_MAX).map((round) => ({
      turn: round.turn,
      task: round.task,
      conclusion: round.conclusion,
      todos: round.todos,
    }))
    const text = rollingSummaryText(entries)
    const meaningful = entries.some((entry) => entry.task !== '' || entry.conclusion !== '' || entry.todos.length > 0)
    if (text === '' || !meaningful) throw new Error('empty summary')
    return text
  }
  return withTimeout(work(), CONTEXT_SUMMARY_TIMEOUT_MS)
}

/** 超时包装：摘要生成不许把会话挂住。 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const budget = Math.max(100, Number(ms) || CONTEXT_SUMMARY_TIMEOUT_MS)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`summary timeout ${String(budget)}ms`)), budget)
    promise.then((value) => { clearTimeout(timer); resolve(value) }, (error: unknown) => { clearTimeout(timer); reject(error) })
  })
}

/**
 * 模型可见注入文本：最近 N 轮原文（N 实测定在 CONTEXT_RECENT_ROUNDS=8）+ 一条滚动摘要。
 * 降级时只带最近 N 轮原文，绝不为空、绝不阻塞。
 */
export function contextSectionText(state: ContextState): string {
  const recent = selectRecentRounds(state.rounds.filter((round) => typeof round.text === 'string' && round.text !== ''), CONTEXT_RECENT_ROUNDS)
  const lines: string[] = [
    `# 个人秘书上下文（插件滚动摘要，最近 ${String(recent.length)} 轮原文 + 摘要）`,
    '下面这段是本插件按「最近原文轮数 + 滚动摘要」口径注入的，不是模型的自我承诺。',
  ]
  if (state.summary !== '') {
    lines.push('', '【已压进上下文的历史摘要】', state.summary)
  } else {
    lines.push('', '【历史摘要】（还没有摘要，只带最近这些轮原文）')
  }
  if (recent.length > 0) {
    lines.push('', '【最近轮次原文】')
    for (const round of recent) {
      lines.push(`第 ${String(round.turn)} 轮（${String(round.words)} 词）：`, capText(round.text ?? ''))
    }
  }
  if (state.degraded) {
    lines.push('', `【降级】${state.degradedReason || '摘要生成失败'}：这一轮只带最近 ${String(recent.length)} 轮原文继续跑。`)
  }
  return `${lines.join('\n')}\n`
}

export interface ContextDeps {
  /** 测试用：固定家目录（DSH_ASSISTANT_HOME 之外的 override） */
  homeDir?: string
  file?: string
  /** 测试用：假宿主压缩服务（生产走 ctx.get('compaction')，宿主 dsh-compaction-basic） */
  compaction?: { compactNow: (agent: any, signal: any, sourceCommandId?: string) => Promise<any> }
}

export function contextStateFile(deps: ContextDeps = {}): string {
  return deps.file ?? join(deps.homeDir ?? assistantHomeDir(), CONTEXT_STATE_FILENAME)
}

function readStateFile(file: string, sessionId: string): ContextState {
  try {
    if (!existsSync(file)) return emptyContextState(sessionId)
    return normalizeContextState(JSON.parse(readFileSync(file, 'utf8')), sessionId)
  } catch {
    return emptyContextState(sessionId)
  }
}

function writeStateFile(file: string, state: ContextState): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state), 'utf8')
  renameSync(tmp, file)
}

/** 一轮结束就增量更新：算总轮数/词数，够触发条件就重算摘要并落盘。 */
export async function applyTurnEnd(state: ContextState, round: ContextRound, file: string, sessionId: string): Promise<{ state: ContextState; updated: boolean; summaryUpdated: boolean }> {
  const next: ContextState = { ...state, sessionId: sessionId || state.sessionId }
  next.totalTurns = Math.max(Number(state.totalTurns) || 0, round.turn)
  next.totalWords = (Number(state.totalWords) || 0) + round.words
  const rounds = [...state.rounds, round]
  while (rounds.length > CONTEXT_ROUND_LOG_MAX) rounds.shift()
  next.rounds = rounds
  next.recentRounds = selectRecentRounds(rounds.filter((item) => typeof item.text === 'string' && item.text !== ''), CONTEXT_RECENT_ROUNDS).length
  const triggered = contextSummaryTriggered(next)
  if (!triggered) {
    next.updatedAt = new Date().toISOString()
    writeStateFile(file, next)
    return { state: next, updated: false, summaryUpdated: false }
  }
  let summaryUpdated = false
  try {
    next.summary = await buildSummaryText(next.rounds)
    next.summaryAt = new Date().toISOString()
    next.degraded = false
    next.degradedReason = ''
    // 口径基准往前推：下一段 12 轮 / 10000 词从这里重新算
    next.summaryThroughTurn = next.totalTurns
    next.summaryThroughWords = next.totalWords
    summaryUpdated = true
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    next.degraded = true
    next.degradedReason = message.slice(0, 240)
    next.degradeCount = (Number(state.degradeCount) || 0) + 1
    appendOpenDiag({ step: 'secretary-context-degraded', sessionId, turn: round.turn, error: message.slice(0, 200), recentRounds: next.recentRounds })
  }
  next.updatedAt = new Date().toISOString()
  writeStateFile(file, next)
  return { state: next, updated: true, summaryUpdated }
}

/** 一轮里出现过的正文（user 真实消息 + assistant 回复；合成通知与中间汇报行不进原文）。 */
export function roundTextsOfEvents(events: readonly any[]): { assistant: string[]; user: string[] } {
  const assistant: string[] = []
  const user: string[] = []
  for (const event of events) {
    const type = String(event?.type ?? '')
    const text = textOfEvent(event)
    if (text === '') continue
    if (type === 'assistant/message') {
      assistant.push(text)
    } else if (type === 'user/message') {
      if (isSyntheticNoticeUserText(text)) continue
      if (isProgressLine(text.split('\n')[0] ?? '')) continue
      user.push(text)
    } else if (type === 'developer/message' || type === 'system/message') {
      continue
    }
  }
  return { assistant, user }
}

export interface SecretaryContextHandle {
  state(): ContextState
  file: string
  /** 测试/探针：直接喂一条 turn/end（走同一套增量更新） */
  noteTurnEnd(sessionId: string, events: readonly any[], turn: number, seqFrom: number, seqTo: number): Promise<boolean>
  reset(): void
  dispose(): void
}

/**
 * 装秘书上下文滚动摘要：只读事件流、只写自己的 JSON、只往模型送一段注入文本。
 */
export function registerAssistantSecretaryContext(ctx: any, deps: ContextDeps = {}): () => void {
  const file = contextStateFile(deps)
  let sessionId = secretarySessionRef.id
  let state = readStateFile(file, sessionId)
  let chain: Promise<unknown> = Promise.resolve()
  const off: Array<() => void> = []

  const buckets = new Map<number, { texts: string[]; seqFrom: number; seqTo: number }>()

  // ── 宿主压缩（旧轮挤出模型上下文），2026-11-22 用户定案 ──
  // 只对固定秘书会话、只在滚动摘要的同触发点要求一次；由 ctx.compaction.compactNow 执行，
  // 宿主自己往日志追加 compaction/* 事件（只追加不改写），插件绝不自己碰会话日志。
  let secretaryAgent: any = undefined
  let pendingEvict = false
  let evicting = false

  /**
   * 取宿主压缩服务。可见性顺序（2026-11-22 现网实测定案）：
   *   1. deps.compaction（单测注入）；
   *   2. 插件自己 ctx 的 compaction 属性 / ctx.get —— cordis 服务按分支提供，
   *      dsh-compaction-basic 装在 dsh-base 分支，对 profile 插件**不可见**（实测 undefined）；
   *   3. 秘书 agent 自己的 ctx（agent.ctx 是它所属分支的上下文，dsh-agent 原文就是
   *      "calling through agent.ctx scopes EFFECTs"）——同分支的服务在那里可见。
   */
  const compactionService = (agent?: any): any => {
    if (deps.compaction && typeof deps.compaction.compactNow === 'function') return deps.compaction
    const candidates = [ctx, agent?.ctx]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        const direct = candidate.compaction
        if (direct && typeof direct.compactNow === 'function') return direct
      } catch { /* 分支上下文访问失败就试下一个 */ }
      try {
        const service = typeof candidate.get === 'function' ? candidate.get('compaction') : undefined
        if (service && typeof service.compactNow === 'function') return service
      } catch { /* 部分上下文对未注册服务会抛错而不是返回 undefined */ }
    }
    return undefined
  }

  const runEviction = async (): Promise<void> => {
    if (evicting || !pendingEvict) return
    // 只认固定秘书会话；会话 id 没绑定时绝不乱挤别的会话
    if (sessionId === '' || sessionId !== secretarySessionRef.id) return
    const compaction = compactionService(secretaryAgent)
    if (compaction === undefined) {
      pendingEvict = false
      state = { ...state, eviction: { ...state.eviction, lastError: 'no compaction service' } }
      try { writeStateFile(file, state) } catch { /* 下一轮再试 */ }
      return
    }
    if (secretaryAgent === undefined) return // 还没见过 idle 的秘书 agent，等 agent/status 再试
    evicting = true
    try {
      const controller = new AbortController()
      const result = await compaction.compactNow(secretaryAgent, controller.signal, EVICT_SOURCE_ID)
      state = {
        ...state,
        eviction: {
          at: new Date().toISOString(),
          count: state.eviction.count + 1,
          shadowedTokens: Math.max(0, Math.floor(Number(result?.shadowedTokenCount) || 0)),
          busyRetries: 0,
          lastError: '',
        },
      }
      pendingEvict = false
      try { writeStateFile(file, state) } catch { /* 下一轮再试 */ }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const busy = (error as any)?.name === 'ManualCompactionError' && (error as any)?.code === 'busy'
      const busyRetries = busy ? state.eviction.busyRetries + 1 : state.eviction.busyRetries
      state = { ...state, eviction: { ...state.eviction, busyRetries, lastError: message.slice(0, 240) } }
      // busy 放到下次 idle/触发点再试；连撞上限或其它错误就放下个触发点
      if (!busy || busyRetries >= EVICT_MAX_BUSY_RETRIES) pendingEvict = false
      appendOpenDiag({ step: 'secretary-context-evict-failed', sessionId, error: message.slice(0, 200), busy })
      try { writeStateFile(file, state) } catch { /* 下一轮再试 */ }
    } finally {
      evicting = false
    }
  }

  const enqueueEviction = (): void => {
    const task = async (): Promise<void> => { await runEviction() }
    chain = chain.then(task, task)
  }

  // 捕获固定秘书会话的 agent（compactNow 需要 idle agent；busy 时也靠 idle 事件重试）
  try {
    off.push(ctx.on?.('agent/status', (payload: any) => {
      const agent = payload?.agent
      const status = String(payload?.status ?? '')
      const agentSessionId = String(agent?.session?.id ?? '')
      if (agentSessionId === '' || agentSessionId !== sessionId) return
      if (status !== 'idle') return
      secretaryAgent = agent
      if (pendingEvict && !evicting) enqueueEviction()
    }) ?? (() => void 0))
  } catch { /* 宿主没给 agent/status：挤出不启用，注入摘要照旧 */ }

  const bump = (): void => {
    const task = async (): Promise<void> => {
      try { writeStateFile(file, state) } catch { /* 写不进去就下一轮再试，绝不阻塞会话 */ }
    }
    chain = chain.then(task, task)
  }

  try {
    // 宿主 user/message 事件没有 data.turn（2026-11-22 现网实测定案）：这类消息归到
    // 最近一个 turn/start 打开的桶；assistant/message 的 data.turn 在（但正文在 data.message.content）。
    let currentTurn = 0
    off.push(ctx.on?.('session/event', async (session: any, event: any) => {
      const id = String(session?.id ?? session?.sessionId ?? '')
      if (id !== '' && sessionId !== '' && id !== sessionId) return
      const type = String(event?.type ?? '')
      const turn = Number(event?.data?.turn ?? event?.turn)
      if (type === 'turn/start') {
        if (!Number.isFinite(turn) || turn <= 0) return
        currentTurn = Math.floor(turn)
        buckets.set(currentTurn, { texts: [], seqFrom: Number(event?.seq ?? 0), seqTo: Number(event?.seq ?? 0) })
        return
      }
      if (type === 'assistant/message' || type === 'user/message') {
        const bucketTurn = Number.isFinite(turn) && turn > 0 ? Math.floor(turn) : currentTurn
        if (bucketTurn <= 0) return
        const bucket = buckets.get(bucketTurn) ?? { texts: [], seqFrom: Number(event?.seq ?? 0), seqTo: Number(event?.seq ?? 0) }
        const text = textOfEvent(event)
        // 合成通知（CU 完成汇报这类）与宿主自己塞的行都不算「用户原文」，不进轮原文窗口
        if (text !== '' && !(type === 'user/message' && isSyntheticNoticeUserText(text))) bucket.texts.push(text)
        bucket.seqTo = Math.max(bucket.seqTo, Number(event?.seq ?? 0))
        buckets.set(bucketTurn, bucket)
        return
      }
      if (type !== 'turn/end') return
      if (!Number.isFinite(turn) || turn <= 0) return
      const key = Math.floor(turn)
      const bucket = buckets.get(key) ?? { texts: [], seqFrom: Number(event?.seq ?? 0), seqTo: Number(event?.seq ?? 0) }
      buckets.delete(key)
      if (id !== '') sessionId = id
      const round = roundFromText(key, bucket.texts, bucket.seqFrom, bucket.seqTo)
      const run = async (): Promise<void> => {
        const applied = await applyTurnEnd(state, round, file, sessionId)
        state = applied.state
        // 滚动摘要刚压过一次（每 12 轮 / 10000 词）且历史够长：同触发点要求宿主把旧轮挤出模型上下文
        if (applied.summaryUpdated && state.totalTurns >= EVICT_MIN_TURNS && sessionId !== '' && sessionId === secretarySessionRef.id) {
          pendingEvict = true
          enqueueEviction()
        }
      }
      chain = chain.then(run, run)
      void chain.then(() => { bump() }, () => { bump() })
    }) ?? (() => void 0))
  } catch { /* 宿主没给 session/event */ }

  // 注入段：与朗读规范段（1780）同一套通道，只是排在它前面
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      off.push(systemPrompt.section({
        name: 'assistant:secretary-context',
        order: 1770,
        text: (context: any) => {
          const id = String(context?.agent?.session?.id ?? '')
          if (id === '' || (sessionId !== '' && id !== sessionId)) return ''
          return contextSectionText(state)
        },
      }))
    }
  } catch { /* 宿主没给 systemPrompt.section：注入失败不影响会话继续跑 */ }

  // 状态接口（只读 + 重置；测试用）
  try {
    const routes = manageWebRoutes(ctx.webServer)
    routes.webServer.register({
      kind: 'exact',
      path: ASSISTANT_SECRETARY_CONTEXT_ROUTE,
      handler: async (req: any, res: any) => {
        const method = String(req.method ?? 'GET').toUpperCase()
        const url = String(req.url ?? '')
        if (method === 'DELETE') {
          const run = async (): Promise<void> => {
            try { if (existsSync(file)) rmSync(file, { force: true }) } catch { /* 已经没了 */ }
            state = emptyContextState(sessionId)
          }
          chain = chain.then(run, run)
          await chain
          try { res.writeHead?.(200, { 'content-type': 'application/json; charset=utf-8' }); res.end?.(JSON.stringify({ ok: true, reset: true, file })) } catch { /* 断开 */ }
          return
        }
        const payload = {
          ok: true,
          file,
          sessionId,
          updatedAt: state.updatedAt,
          summaryAt: state.summaryAt,
          summary: state.summary,
          totalTurns: state.totalTurns,
          totalWords: state.totalWords,
          totalRounds: state.rounds.length,
          rounds: state.rounds.map((round) => ({ turn: round.turn, words: round.words, task: round.task, conclusion: round.conclusion, todos: round.todos })),
          recentRounds: state.recentRounds,
          recentRoundTurns: selectRecentRounds(state.rounds.filter((round) => typeof round.text === 'string' && round.text !== ''), CONTEXT_RECENT_ROUNDS).map((round) => round.turn),
          degraded: state.degraded,
          degradedReason: state.degradedReason,
          degradeCount: state.degradeCount,
          summaryThroughTurn: state.summaryThroughTurn,
          summaryThroughWords: state.summaryThroughWords,
          eviction: state.eviction,
          injectedChars: contextSectionText(state).length,
          triggers: { roundTrigger: CONTEXT_ROUND_TRIGGER, wordTrigger: CONTEXT_WORD_TRIGGER, recentRounds: CONTEXT_RECENT_ROUNDS },
          askedSession: (() => {
            const match = url.match(/(?:^|&)session(?:Id)?=([^&]*)/)
            return match === null ? '' : decodeURIComponent(match[1] ?? '')
          })(),
        }
        try { res.writeHead?.(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end?.(JSON.stringify(payload)) } catch { /* 断开 */ }
      },
    })
    off.push(() => { try { routes.dispose() } catch { /* 已注销 */ } })
  } catch { /* 宿主没给 webServer：状态接口没挂上，注入段照常工作 */ }

  return () => {
    for (const dispose of off.splice(0).reverse()) {
      try { dispose?.() } catch { /* 幂等 */ }
    }
  }
}

/** 单测/探针用的纯函数面（不依赖真宿主）。 */
export const assistantSecretaryContextTestSurface = {
  emptyContextState,
  emptyContextEviction,
  normalizeContextEviction,
  normalizeContextState,
  contextSummaryTriggered,
  roundFromText,
  roundTextsOfEvents,
  buildSummaryText,
  withTimeout,
  contextSectionText,
  applyTurnEnd,
  contextStateFile,
  readStateFile: (file: string, sessionId = '') => readStateFile(file, sessionId),
  writeStateFile,
  CONTEXT_STATE_FILENAME,
  ASSISTANT_SECRETARY_CONTEXT_ROUTE,
  EVICT_MIN_TURNS,
  EVICT_MAX_BUSY_RETRIES,
  EVICT_SOURCE_ID,
  registerAssistantSecretaryContext,
}
