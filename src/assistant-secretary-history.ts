/**
 * 秘书页卡片分页的宿主侧只读接口（第四批需求 A）。
 *
 * 路线：GET /api/assistant/secretary/history
 *   ?sessionId=<id>            缺省用宿主 state 里那条秘书会话（session-83bca3e3…，不换 id）
 *   &limit=30                  一页多少张卡（钳到 1..HISTORY_MAX_LIMIT，客户端不许要更多）
 *   &before=<seq>              只要比这个 seq 更旧的那一段；缺省 = 最近的那一段
 * 响应：{ ok, sessionId, source, page: { items, hasMore, fromSeq, toSeq, nextBefore, totalCards, exactTotal, totalWords } }
 *
 * 三条硬要求：
 *   1. 只读。不写会话日志、不拼 turn 事件、不 activate 任何 agent —— 冷会话用宿主自己的
 *      `sessionController.page()`（cold-safe，`throughSeq:-1` = 日志末尾游标，`beforeSeq` = 更旧游标），
 *      活会话退到 `snapshotEvents()`。绝不把整条会话读回来（一次只回一页）。
 *   2. 口径在 src/secretary-card-shared.ts（卡片分类 / 24 字短标题 / 词数 / 卡计数）与客户端共用。
 *   3. 客户端答不上时自己降级（见 client 侧 pager store），宿主坏了自己会做 DOM 兜底，两边都算分页成功。
 */
import { manageWebRoutes } from './web-routes'
import { appendOpenDiag } from './assistant-open-diag'
import { secretarySessionRef } from './assistant-secretary'
import {
  CARD_PAGE_SIZE,
  HISTORY_MAX_LIMIT,
  buildHistoryPage,
  normalizeHistoryCursor,
  normalizeHistoryLimit,
} from './secretary-card-shared'

export const ASSISTANT_SECRETARY_HISTORY_ROUTE = '/api/assistant/secretary/history'

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
/** 一页最多取多少条宿主消息（卡片≈消息，多取一点是为了 turn 里多步回复去重后还够 30 张）。 */
const PAGE_MESSAGE_WINDOW = 240
/** 冷读超时：问不出就别挂着，客户端自己会按 DOM 顺序降级。 */
const PAGE_TIMEOUT_MS = 6_000

export interface HistoryQuery {
  sessionId: string
  limit: number
  beforeSeq: number | undefined
}

/** 解析 query：只认 sessionId / limit / before，别的参数一律忽略。 */
export function parseHistoryQuery(rawUrl: string, defaultSessionId: string): HistoryQuery {
  const url = String(rawUrl ?? '')
  const queryIndex = url.indexOf('?')
  const query = queryIndex === -1 ? '' : url.slice(queryIndex + 1)
  const sessionMatch = query.match(/(?:^|&)session(?:Id)?=([^&]*)/)
  const rawSession = sessionMatch === null ? '' : decodeURIComponent(sessionMatch[1] ?? '')
  const trimmed = rawSession.trim()
  const limitMatch = query.match(/(?:^|&)limit=([^&]*)/)
  const beforeMatch = query.match(/(?:^|&(?:before|cursor|beforeSeq))=([^&]*)/)
  return {
    // 没给 sessionId 才兜底用秘书会话；给了但形态不对的原样交出去，让 handler 判 400（坏请求不能当好数据）
    sessionId: trimmed === '' ? String(defaultSessionId ?? '') : trimmed,
    limit: normalizeHistoryLimit(limitMatch?.[1]),
    beforeSeq: normalizeHistoryCursor(beforeMatch?.[1]),
  }
}

/** 把宿主 `page()` 送回的记录（可能是 {type:'event',event:{...}} 或裸事件）归一成事件数组。 */
export function unwrapPageRecords(records: unknown): any[] {
  const list = Array.isArray(records) ? records : []
  const out: any[] = []
  for (const record of list) {
    const event = record && typeof record === 'object' ? (record as any).event ?? record : record
    if (event && typeof event === 'object' && typeof event.type === 'string') out.push(event)
  }
  return out
}

function optionalService(ctx: any, name: string): any {
  try {
    const direct = ctx?.[name]
    if (direct !== undefined && direct !== null) return direct
    if (typeof ctx?.get === 'function') return ctx.get(name)
  } catch { /* 宿主没装这个服务 */ }
  return undefined
}

export interface PageFetchResult {
  events: any[]
  hasMore: boolean
  source: string
  error?: string
}

/**
 * 取「比 beforeSeq 更旧的至多一页」的两条路：
 *   A. 冷/活都行：sessionController.page() —— 宿主公开的只读分页（不激活 agent）。
 *   B. 活会话快照：ctx.sessions.list() 里找到那条，读 snapshotEvents()（同步、已在内存）。
 */
export async function fetchHistoryEvents(
  ctx: any,
  sessionId: string,
  beforeSeq: number | undefined,
  limit: number,
): Promise<PageFetchResult> {
  const controller = optionalService(ctx, 'sessionController')
  if (controller !== undefined && typeof controller.page === 'function') {
    const abort = new AbortController()
    const timeout = setTimeout(() => { try { abort.abort() } catch { /* 忽略 */ } }, PAGE_TIMEOUT_MS)
    try {
      const page = await controller.page({
        address: { kind: 'session', sessionId },
        throughSeq: -1,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: Math.min(PAGE_MESSAGE_WINDOW, Math.max(limit * 4, CARD_PAGE_SIZE)),
      }, abort.signal)
      const records = unwrapPageRecords((page as any)?.records)
      const hasMore = (page as any)?.hasMore === true
      return { events: records, hasMore, source: 'controller-page' }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      appendOpenDiag({ step: 'host-secretary-history-page-failed', sessionId, error: message.slice(0, 200) })
      // 不直接失败：往下走活会话那条路
    } finally {
      clearTimeout(timeout)
    }
  }
  let listed: any[] = []
  try {
    listed = Array.isArray(ctx?.sessions?.list?.()) ? ctx.sessions.list() : []
  } catch { listed = [] }
  const live = listed.find((session: any) => String(session?.header?.id ?? session?.id ?? '') === sessionId)
  const snapshot = typeof live?.snapshotEvents === 'function' ? live.snapshotEvents() : undefined
  if (Array.isArray(snapshot)) {
    const filtered = beforeSeq === undefined ? snapshot : snapshot.filter((event: any) => Number(event?.seq ?? 0) < beforeSeq)
    const window = filtered.slice(Math.max(0, filtered.length - PAGE_MESSAGE_WINDOW))
    return { events: window, hasMore: filtered.length > window.length, source: 'live-snapshot' }
  }
  return { events: [], hasMore: false, source: 'unavailable', error: 'no history source on host' }
}

export interface HistoryRouteDeps {
  /** 测试/探针注入的事件源（真会话语义：返回**按 seq 升序的一段事件**，路由只裁一页）。 */
  eventsFor?: (sessionId: string, beforeSeq: number | undefined, limit: number) => Promise<any[]>
  /** 宿主 state 里那条秘书会话 id（客户端不传 sessionId 时用它）。 */
  defaultSessionId?: () => string
}

/**
 * 注册秘书历史分页 route。返回 unregister（与 assistant-secretary 同一套 manageWebRoutes 形状）。
 */
export function registerAssistantSecretaryHistory(ctx: any, deps: HistoryRouteDeps = {}): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  const webServer = routes.webServer

  const handle = async (req: any, res: any): Promise<void> => {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const defaultId = typeof deps.defaultSessionId === 'function' ? deps.defaultSessionId() : secretarySessionRef.id
    const query = parseHistoryQuery(String(req.url ?? ''), defaultId)
    if (!SESSION_ID_RE.test(query.sessionId) || query.sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'invalid-session-id' })
      return
    }
    try {
      const fetched = typeof deps.eventsFor === 'function'
        ? { events: await deps.eventsFor(query.sessionId, query.beforeSeq, query.limit), hasMore: true, source: 'injected' }
        : await fetchHistoryEvents(ctx, query.sessionId, query.beforeSeq, query.limit)
      const page = buildHistoryPage(fetched.events, { limit: query.limit, beforeSeq: query.beforeSeq })
      const trimmedMore = page.items.length >= query.limit && fetched.events.length > page.items.length
      sendJson(res, 200, {
        ok: true,
        sessionId: query.sessionId,
        source: fetched.source,
        ...(fetched.error === undefined ? {} : { warning: fetched.error }),
        page: {
          items: page.items,
          hasMore: page.hasMore || fetched.hasMore || trimmedMore,
          fromSeq: page.fromSeq,
          toSeq: page.toSeq,
          nextBefore: page.nextBefore,
          totalCards: page.totalCards,
          // 事件源只给了「一段」时，totalCards 只代表这一段（客户端不许把它当全量）
          exactTotal: fetched.source === 'injected' || fetched.source === 'live-snapshot' || fetched.hasMore === false,
          totalWords: page.totalWords,
          fetchedEvents: fetched.events.length,
        },
      })
      appendOpenDiag({
        step: 'host-secretary-history',
        sessionId: query.sessionId,
        source: fetched.source,
        before: query.beforeSeq ?? null,
        limit: query.limit,
        cards: page.items.length,
        events: fetched.events.length,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      appendOpenDiag({ step: 'host-secretary-history-error', sessionId: query.sessionId, error: message.slice(0, 200) })
      sendJson(res, 500, { ok: false, error: 'history-read-failed' })
    }
  }

  webServer.register({ kind: 'exact', path: ASSISTANT_SECRETARY_HISTORY_ROUTE, handler: handle })
  return () => { routes.dispose() }
}

function sendJson(res: any, status: number, payload: unknown): void {
  try {
    res.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end?.(JSON.stringify(payload))
  } catch { /* 客户端已断开 */ }
}

/** 单测/探针用的纯函数面（不依赖真宿主）。 */
export const assistantSecretaryHistoryTestSurface = {
  ASSISTANT_SECRETARY_HISTORY_ROUTE,
  parseHistoryQuery,
  unwrapPageRecords,
  fetchHistoryEvents,
  registerAssistantSecretaryHistory,
}
