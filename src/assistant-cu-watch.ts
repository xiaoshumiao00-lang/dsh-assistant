/**
 * 个人秘书「管理 Computer Use 会话」第一层：CU 会话完成 → 秘书会话收一张可点跳的卡片消息。
 *
 * 三个前提（2026-11-21 在宿主源码与本仓库实测确认）：
 *   1. CU 模式判定 = 会话 agent 预设 === 'computer-use'。读宿主**投影** `agentPreset`
 *      （sessionProjections / sessionProjectionCache 的 cachedSnapshot().values.agentPreset，
 *      由 agent-preset/selected 事件维护，比 header 新），读不到再回退 `session.header.agentPreset`。
 *      标准模式（standard / standard-slim-local / 空）一律不监听、不汇报。
 *   2. 完成事件 = 宿主 `session/event` 的 `turn/end`，且 `data.reason.kind === 'completed'`
 *      （max-tokens / aborted / error / interrupted / blocked 都不算完成）。与托管自动续写
 *      （src/tuoguan-autocontinue.ts）共用同一条真值事件流。
 *   3. 完成内容 = 同一 turn 的 `assistant/message` 事件里 message.content 的 text 块；
 *      本模块在事件流上顺手收集，不另开历史读取通道。
 *
 * 卡片消息 = 往秘书固定会话追加一条**合成完成轮**（turn/start → step/start →
 * assistant/message → step/end → turn/end completed，与宿主 agent 落盘的事件序列同形）。
 * 秘书页的回复卡片（SecretaryReplyCard）据此渲染：正文是简洁口语摘要，末尾
 * `[[session:<cuSessionId>|<标题>]]` 渲染成可点引用块（左竖线 + 淡底），点击按会话 id
 * 跳进那条 CU 会话详情；卡片同时被自动朗读，所以正文按朗读友好规范写。
 *
 * 纪律：
 *   - 只听 CU 模式会话；标准会话（包括 CU 后台 code_agent 派出的标准会话）不汇报；
 *   - 子代理会话（origin=subagent / delegationDepth>0）不汇报；秘书会话自身不汇报；
 *   - 同一 (sessionId, turn) 只报一次（内存去重；重启后只监听新事件，不会重报旧轮）。
 */
import { randomUUID } from 'node:crypto'
import { manageWebRoutes } from './web-routes'
import { secretarySessionRef } from './assistant-secretary'

export const CU_PRESET = 'computer-use'
export const CU_NOTIFY_ROUTE = '/api/assistant/cu-watch/notify'

/* ---------- 纯函数（单测直接断言） ---------- */

/** 会话当前 agent 预设：投影值优先，header 兜底；都拿不到 = ''（按标准模式处理）。 */
export function presetOfSource(projected: unknown, header: unknown): string {
  if (typeof projected === 'string' && projected !== '') return projected
  if (typeof header === 'string' && header !== '') return header
  return ''
}

/** 一条会话完成事件该不该汇报给秘书（任何一条不满足都不报）。 */
export function shouldReportCompletion(input: {
  preset: string
  reasonKind: string
  origin?: unknown
  delegationDepth?: unknown
  isSecretary?: boolean
}): boolean {
  if (input.preset !== CU_PRESET) return false // 标准会话一律不汇报
  if (input.reasonKind !== 'completed') return false
  if (input.isSecretary === true) return false
  if (input.origin === 'subagent') return false
  if (typeof input.delegationDepth === 'number' && input.delegationDepth > 0) return false
  return true
}

/** 通知正文：简洁口语 + 末尾会话引用标记（渲染成可点跳引用块，朗读时剔除）。 */
export function buildCompletionNotice(input: { sessionId: string; title: string; summary: string }): string {
  const title = String(input.title ?? '').trim() || '电脑上的任务'
  const summary = String(input.summary ?? '').trim()
  const head = `电脑操作会话「${title}」这一轮跑完了。`
  const body = summary !== '' ? summary : '具体结果那条会话里有，点下面引用就能过去看。'
  return `${head}${body}\n[[session:${input.sessionId}|${title}]]`
}

/** 摘要取最后一条回复的首句，截断到 120 字（朗读友好）。 */
export function summarizeCompletion(text: string): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  const first = clean.split(/(?<=[。！？!?])\s*/)[0] ?? clean
  return first.length > 120 ? `${first.slice(0, 120)}…` : first
}

/** 秘书会话现有事件里最大的 turn 号（没有 = 0）。 */
export function nextTurnOf(events: readonly any[]): number {
  let max = 0
  for (const event of events ?? []) {
    const turn = Number(event?.data?.turn)
    if (Number.isFinite(turn) && turn > max) max = turn
  }
  return max + 1
}

/* ---------- 事件控制器（收集文本 + 完成触发，依赖全注入） ---------- */

export interface CuWatchDeps {
  /** 该会话当前的 agent 预设（投影优先，header 兜底）。 */
  presetOf: (session: any) => string
  /** 汇报出口：把完成内容发到秘书固定会话。 */
  notify: (payload: { sessionId: string; title: string; summary: string }) => void | Promise<void>
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
            if (text !== '') parts.push(text.slice(0, 600))
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
        const byTurn = texts.get(sessionId)
        const collected = Number.isFinite(turn) ? (byTurn?.get(turn) ?? []) : []
        if (Number.isFinite(turn) && byTurn !== undefined) byTurn.delete(turn)
        const preset = deps.presetOf(session)
        if (!shouldReportCompletion({
          preset,
          reasonKind: String(data?.reason?.kind ?? ''),
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
        const payload = {
          sessionId,
          title: titleOf(session),
          summary: summarizeCompletion(lastText),
        }
        Promise.resolve(deps.notify(payload)).catch((error: unknown) => {
          log(`CU 完成通知发送失败（${sessionId} turn ${turn}）：${String((error as Error)?.message ?? error)}`)
        })
      } catch (error: unknown) {
        log(`CU 完成监听处理事件失败：${String((error as Error)?.message ?? error)}`)
      }
    },
    handleSessionDisposed(session: any): void {
      const sessionId = String(session?.id ?? '')
      if (sessionId !== '') texts.delete(sessionId)
    },
  }
}

/* ---------- 通知落盘：往秘书会话追加一条合成完成轮 ---------- */

/**
 * 往秘书固定会话追加一条「助手主动汇报」的完成轮。五个 append 在同一拍内同步做完，
 * turn 号取现有最大 turn + 1（snapshotEvents 读一次，不与模型运行并发交错——JS 单线程，
 * agent 自己的 append 发生在别的拍上）。
 *
 * @returns true = 五个事件都写进去了；false = 会话不可用 / 写入失败（调用方记日志）。
 */
export function postSecretaryNotice(session: any, notice: { sessionId: string; title: string; summary: string }): boolean {
  if (session === null || session === undefined) return false
  if (typeof session.append !== 'function' || typeof session.snapshotEvents !== 'function') return false
  const turn = nextTurnOf(session.snapshotEvents())
  const step = 1
  const text = buildCompletionNotice(notice)
  const message = {
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'dsh-assistant', model: 'cu-watch' },
  }
  try {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step })
    session.append('assistant/message', { turn, step, message, stream: [] })
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
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

/** 取秘书会话的 Session 对象（活会话 store → agent 注册表兜底）。 */
export function secretarySessionOf(ctx: any): any {
  const id = secretarySessionRef.id
  if (id === '') return null
  try {
    const sessions = optionalService(ctx, 'sessions') ?? ctx?.sessions
    const live = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
    if (live !== undefined && live !== null) return live
  } catch { /* 继续试 agent */ }
  try {
    const agents = optionalService(ctx, 'agents')
    const agent = agents?.get?.(id)
    if (agent?.session !== undefined && agent.session !== null) return agent.session
  } catch { /* 没有就是 null */ }
  return null
}

/** 发送一条通知（路由与事件监听共用）。返回是否落盘成功。 */
export function notifySecretary(ctx: any, notice: { sessionId: string; title: string; summary: string }, log: (line: string) => void): boolean {
  if (secretarySessionRef.id === '') {
    log('CU 完成通知：秘书固定会话还没就绪，这条先不发')
    return false
  }
  const session = secretarySessionOf(ctx)
  const ok = postSecretaryNotice(session, notice)
  log(ok
    ? `CU 完成通知已发到秘书会话：${notice.sessionId}「${notice.title}」`
    : `CU 完成通知落盘失败：秘书会话对象不可用或 append 失败（${notice.sessionId}）`)
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
          if (sessionId === '') { sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return }
          const ok = notifySecretary(ctx, { sessionId, title, summary }, log)
          sendJson(res, ok ? 200 : 409, { ok, sessionId })
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
  shouldReportCompletion,
  buildCompletionNotice,
  summarizeCompletion,
  nextTurnOf,
  createCuWatch,
  postSecretaryNotice,
  sessionPresetOf,
  secretarySessionOf,
  notifySecretary,
  registerAssistantCuWatch,
}
