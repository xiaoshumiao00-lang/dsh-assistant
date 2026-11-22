/**
 * 个人秘书固定会话的宿主侧锚点。
 *
 * 只做两件事：
 *   1. 把唯一的秘书 sessionId 持久化到 profile（浏览器 localStorage 会随缓存丢失，
 *      手机/电脑也不能共享，所以真值必须在宿主）；
 *   2. 给秘书会话装一道工具闸：只读权限仍然带着 shell / 写文件 / Computer Use /
 *      子代理这些工具，子代理还会继承父会话的只读档，所以秘书会话在工具入口
 *      deny 自己执行任务的能力；`secretary_dispatch` 必须显式放行，由它创建或续接
 *      独立的 Computer Use 会话。只读限制写文件/终端，绝不能把建会话与派活一起禁掉。
 *
 * 路由：
 *   GET    /api/assistant/secretary            → { ok, sessionId, updatedAt }
 *   GET    /api/assistant/secretary?verify=1   → 加 { exists }：这条固定会话还在不在宿主会话表
 *   GET    /api/assistant/secretary?verify=1&sessionId=<id>
 *                                            → 问**指定候选 id**（用于「新建出来的会话到底 retain 得住吗」，
 *                                              答 `<id>` 的真值，不用先把 state 写过去；回 `queried`）
 *   POST   /api/assistant/secretary  body { sessionId } → 覆盖；同一个 id 不再写盘（去抖，防多客户端互相覆盖）
 *   DELETE /api/assistant/secretary  → 清空（测试/重置用）
 *
 * 已读卡集合（未读红点，2026-11-21 第三批需求）另落 dsh-assistant-secretary-read.json：
 *   GET    /api/assistant/secretary-read?sessionId=<id>            → { ok, sessionId, cards, count }
 *   POST   /api/assistant/secretary-read  { sessionId, cardKey, mark:'read' } → { ok, cardKey, read, count }
 *   DELETE /api/assistant/secretary-read?sessionId=<id>            → 清空该会话的已读集合
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { manageWebRoutes } from './web-routes'
import { appendOpenDiag } from './assistant-open-diag'

export const ASSISTANT_SECRETARY_ROUTE = '/api/assistant/secretary'
export const SECRETARY_DISPATCH_POLICY = 'default-computer-use-v2'
const STATE_FILENAME = 'dsh-assistant-secretary.json'
const MAX_BODY_BYTES = 4096
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/

/** `?verify=1`：客户端问「这条固定会话还在不在宿主的会话表里」；会话表两千多行，答案缓存 30s。 */
const EXISTENCE_TTL_MS = 30_000
let existenceCache: { id: string; value: boolean; at: number } | null = null

/**
 * 从请求 URL 里取「要问的那条 id」与「要不要 verify」。
 * 只认 `verify=1` 与 `sessionId=<session id>`；没有 sessionId 就问 state 里当前挂着的那条。
 */
export function parseSecretaryRequestQuery(rawUrl: string): { wantsVerify: boolean; requestedId: string } {
  const url = String(rawUrl ?? '')
  const queryIndex = url.indexOf('?')
  const query = queryIndex === -1 ? '' : url.slice(queryIndex + 1)
  const wantsVerify = /(?:^|&)verify=1(?:&|$)/.test(query)
  const match = query.match(/(?:^|&)session(?:Id)?=([^&]*)/)
  const raw = match === null ? '' : decodeURIComponent(match[1])
  const trimmed = raw.trim()
  return { wantsVerify, requestedId: SESSION_ID_RE.test(trimmed) ? trimmed : '' }
}

/**
 * 宿主权威版：这条 sessionId 还在不在宿主的会话表里。
 *   true  = 在（内存活会话或持久化清单里找到了）
 *   false = 不在（问到过结果，没有）
 *   null  = 问不出结果（宿主既没给 sessions.list 也没给 sessionQuery）——调用方必须按「不新建」处理
 */
async function secretarySessionExistsOnHost(ctx: any, sessionId: string): Promise<boolean | null> {
  const id = String(sessionId ?? '').trim()
  if (id === '') return false
  const now = Date.now()
  if (existenceCache && existenceCache.id === id && now - existenceCache.at < EXISTENCE_TTL_MS) return existenceCache.value
  let asked = false
  try {
    const live = Array.isArray(ctx?.sessions?.list?.()) ? ctx.sessions.list() : null
    if (live !== null) {
      asked = true
      if (live.some((session: any) => String(session?.header?.id ?? session?.id ?? '') === id)) {
        existenceCache = { id, value: true, at: Date.now() }
        return true
      }
    }
  } catch { /* 没有 sessions.list：只剩持久化清单那条 */ }
  try {
    const query = ctx?.get?.('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      const list = await query.listSessions(undefined)
      asked = true
      const found = Array.isArray(list)
        ? list.some((record: any) => String(record?.header?.id ?? record?.sessionId ?? '') === id)
        : false
      existenceCache = { id, value: found, at: Date.now() }
      return found
    }
  } catch { /* 问不出结果 */ }
  if (!asked) return null
  existenceCache = { id, value: false, at: Date.now() }
  return false
}

export interface SecretaryState {
  sessionId: string
  updatedAt: string
}

/**
 * 当前固定秘书会话 id 的**进程内共享引用**（只读消费方：派活工具 / 主动卡片 / 提示词段）。
 * 真值仍在 dsh-assistant-secretary.json；这里只是让同进程的其它半部不用各自去读盘。
 */
export const secretarySessionRef: { id: string } = { id: '' }

function profileDir(ctx: any): string {
  try {
    const p = ctx?.get?.('profileContext')
    if (p && typeof p.dir === 'string' && p.dir) return p.dir
  } catch {}
  try {
    const h = ctx?.get?.('homePaths')
    if (h && typeof h.home === 'string' && h.home) return h.home
  } catch {}
  return process.env.DSH_HOME || process.cwd()
}

/** 防御式归一：只接受 session id 形态，坏文件按“没有固定会话”处理。 */
export function normalizeSecretaryState(raw: unknown): SecretaryState | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  if (!SESSION_ID_RE.test(sessionId)) return null
  return {
    sessionId,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

/**
 * 只读闸的硬放行项：建/续独立 CU 会话不属于在秘书会话里写文件或跑终端。
 * 单列并优先判断，防止以后收紧白名单时又把派活能力一起 deny。
 */
const SECRETARY_DELEGATION_TOOLS = new Set([
  'secretary_dispatch',
])

/**
 * 「系统通知回合」的消息 id 登记表。
 *
 * CU 完成汇报不再拼日志事件，而是把一条 user 消息交给宿主官方 prompt 通道
 * （`agent.followup`），由宿主自己开轮、自己编号、自己落盘（见 assistant-cu-watch.ts）。
 * 代价是这一轮真的会跑模型，所以必须钉死两件事：
 *   1. 这一轮的工具全部禁用——否则模型可能又去派活，派活 → CU 完成 → 通知 → 再派活，
 *      形成没有出口的回路；
 *   2. 只有这一轮禁用，用户正常发起的回合完全不受影响。
 */
const NOTICE_MESSAGE_IDS = new Set<string>()
const NOTICE_ID_LIMIT = 400

/** 登记一条"系统通知"消息 id（CU 完成汇报专用）。 */
export function registerNoticeMessageId(id: string): void {
  const value = String(id ?? '').trim()
  if (value === '') return
  NOTICE_MESSAGE_IDS.add(value)
  if (NOTICE_MESSAGE_IDS.size > NOTICE_ID_LIMIT) {
    const oldest = NOTICE_MESSAGE_IDS.values().next().value
    if (typeof oldest === 'string') NOTICE_MESSAGE_IDS.delete(oldest)
  }
}

/** 这条消息是不是宿主正在处理的那条系统通知。 */
export function isNoticeMessageId(id: unknown): boolean {
  const value = typeof id === 'string' ? id.trim() : ''
  return value !== '' && NOTICE_MESSAGE_IDS.has(value)
}

/** 单测用：清空登记表。 */
export function clearNoticeMessageIds(): void {
  NOTICE_MESSAGE_IDS.clear()
}

/**
 * 秘书会话的其它只读/汇总工具白名单；未知执行工具默认拒绝。
 *
 * 只读限制的对象是「会改本机或动屏幕」的动作：写文件、终端、直接 Computer Use、派子代理。
 * 只读查询（web_search / web_fetch）不在此列——「明天天气」这类轻量问题必须能由秘书
 * 自己联网查完，否则会退化成「查不了 → 也没法派活」的死路（2026-11-21 用户实测）。
 * read/grep/read_image 仍不在这里：读本机文件按分层规则应由 CU 会话执行。
 * 会话/记忆摘要仍可按前缀放行。
 */
const SECRETARY_ALLOWED_TOOLS = new Set([
  'ask_user_question', 'present', 'skill',
  'todo_write', 'get_goal',
  'list_agents', 'job_list', 'job_output',
  'proactive_card',
  'web_search', 'web_fetch',
])

export function secretaryToolDenied(toolName: string): boolean {
  const name = String(toolName ?? '').trim().toLowerCase()
  if (name === '') return false
  if (SECRETARY_DELEGATION_TOOLS.has(name)) return false
  if (SECRETARY_ALLOWED_TOOLS.has(name)) return false
  // 宿主以后新增的 web 读工具（如 web_extract）同样是只读查询，按前缀放行。
  if (name.startsWith('web_')) return false
  // 会话查询是只读历史工具，未来装上时直接放行；mnemon_* 是记忆读写，不是任务执行。
  if (name.startsWith('session_')) return false
  if (name.startsWith('mnemon_')) return false
  return true
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

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    let size = 0
    req.on('data', (chunk: any) => {
      const text = String(chunk ?? '')
      size += Buffer.byteLength(text)
      if (size <= MAX_BODY_BYTES) raw += text
    })
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) { resolve({ __tooLarge: true }); return }
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function readFileState(file: string): SecretaryState | null {
  try {
    return normalizeSecretaryState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** ── 已读卡集合（未读红点的宿主真值）───────────────────────────────
 *  只落 profile 文件，不写会话日志、不拼 turn 事件：
 *  GET  /api/assistant/secretary-read?sessionId=<id>            → { ok, sessionId, cards, count }
 *  POST /api/assistant/secretary-read  { sessionId, cardKey, mark:'read' } → { ok, sessionId, cardKey, read, count }
 *  DELETE /api/assistant/secretary-read?sessionId=<id>          → 清空那条会话的已读集合（测试/重置）
 */
export const ASSISTANT_SECRETARY_READ_ROUTE = '/api/assistant/secretary-read'
const READ_STATE_FILENAME = 'dsh-assistant-secretary-read.json'
/** 每个会话最多记这么多 cardKey（超过就把最旧的一批丢掉，防文件无限长）。 */
export const READ_MAX_KEYS = 400
const READ_CARD_KEY_RE = /^[A-Za-z0-9:._#-]{1,200}$/

export function normalizeReadCardKey(raw: unknown): string {
  const value = String(raw ?? '').trim()
  return READ_CARD_KEY_RE.test(value) ? value : ''
}

/** 归一一个会话的 cardKey 列表：坏值丢掉、按序去重、截到上限（保留最新的）。 */
export function normalizeReadCardKeys(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const out: string[] = []
  for (const item of list) {
    const key = normalizeReadCardKey(item)
    if (key === '' || out.includes(key)) continue
    out.push(key)
  }
  return out.length > READ_MAX_KEYS ? out.slice(out.length - READ_MAX_KEYS) : out
}

/** 归一「sessionId → cardKey 列表」的存储：坏 sessionId 丢掉、坏 key 丢掉、每会话截到上限。 */
export function normalizeSecretaryReadState(raw: unknown): Record<string, string[]> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: Record<string, string[]> = {}
  for (const [sessionId, value] of Object.entries(source)) {
    if (!SESSION_ID_RE.test(String(sessionId ?? ''))) continue
    const keys = normalizeReadCardKeys(value)
    if (keys.length > 0) out[sessionId] = keys
  }
  return out
}

/** 往已读集合里加一条 cardKey（幂等、按插入顺序、超出上限丢最旧）。返回该会话现在的已读条数。 */
export function addReadCardKey(state: Record<string, string[]>, sessionId: string, cardKey: string): number {
  const key = normalizeReadCardKey(cardKey)
  if (key === '') return 0
  const list = Array.isArray(state[sessionId]) ? state[sessionId] : []
  if (!list.includes(key)) {
    list.push(key)
    while (list.length > READ_MAX_KEYS) list.shift()
  }
  state[sessionId] = list
  return list.length
}

export function registerAssistantSecretary(ctx: any): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  const webServer = routes.webServer
  const file = join(profileDir(ctx), STATE_FILENAME)
  let state: SecretaryState | null = readFileState(file)
  let activeSessionId = state?.sessionId ?? ''
  secretarySessionRef.id = activeSessionId
  let chain: Promise<unknown> = Promise.resolve()

  const writeState = (sessionId: string): Promise<SecretaryState> => {
    const task = async (): Promise<SecretaryState> => {
      const next: SecretaryState = { sessionId, updatedAt: new Date().toISOString() }
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next), 'utf8')
      renameSync(tmp, file)
      state = next
      activeSessionId = next.sessionId
      secretarySessionRef.id = next.sessionId
      return next
    }
    const run = chain.then(task, task)
    chain = run.then(() => void 0, () => void 0)
    return run
  }

  const clearState = (): Promise<void> => {
    const task = async (): Promise<void> => {
      try { if (existsSync(file)) rmSync(file, { force: true }) } catch {}
      state = null
      activeSessionId = ''
      secretarySessionRef.id = ''
    }
    const run = chain.then(task, task)
    chain = run.then(() => void 0, () => void 0)
    return run
  }

  webServer.register({
    kind: 'exact',
    path: ASSISTANT_SECRETARY_ROUTE,
    handler: async (req: any, res: any) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      const current = state?.sessionId ?? ''
      try {
        if (method === 'GET' || method === 'HEAD') {
          const query = parseSecretaryRequestQuery(String(req.url ?? ''))
          // 显式问某条候选 id（客户端「新建出来的会话 retain 得住吗」预确认，不写 state 就问）；
          // 没带 sessionId 才问 state 里当前挂着的那条
          const askedId = query.requestedId !== '' ? query.requestedId : current
          const exists = query.wantsVerify
            ? (askedId === '' ? false : await secretarySessionExistsOnHost(ctx, askedId))
            : undefined
          if (query.wantsVerify && exists !== true) {
            appendOpenDiag({ step: 'host-secretary-verify', sessionId: askedId, exists })
          }
          sendJson(res, 200, {
            ok: true,
            sessionId: current || null,
            updatedAt: state?.updatedAt ?? '',
            dispatchPolicy: SECRETARY_DISPATCH_POLICY,
            ...(query.wantsVerify
              ? { exists, ...(query.requestedId !== '' ? { queried: query.requestedId } : {}) }
              : {}),
          })
          return
        }
        if (method === 'POST' || method === 'PUT') {
          const body = await readJsonBody(req)
          if (body?.__tooLarge === true) { sendJson(res, 413, { ok: false, error: 'too-large' }); return }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!SESSION_ID_RE.test(sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid-session-id' })
            return
          }
          // 去抖：宿主 state 里已经是这条 id 就不重写盘、不重刷 updatedAt——
          // 多客户端 / 重复点击反复 POST 同一个 id 不会互相覆盖、也不会刷日志。
          if (sessionId === current && state !== null) {
            appendOpenDiag({ step: 'host-state-skip-unchanged', sessionId })
            sendJson(res, 200, { ok: true, sessionId, updatedAt: state.updatedAt, unchanged: true })
            return
          }
          const next = await writeState(sessionId)
          appendOpenDiag({ step: 'host-state-write', sessionId, previous: current })
          sendJson(res, 200, { ok: true, sessionId: next.sessionId, updatedAt: next.updatedAt })
          return
        }
        if (method === 'DELETE') {
          appendOpenDiag({ step: 'host-state-clear', sessionId: current })
          await clearState()
          sendJson(res, 200, { ok: true, sessionId: null, updatedAt: '' })
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, DELETE' })
        res.end()
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) })
      }
    },
  })

  // ── 已读卡集合（未读红点的宿主真值）───────────────────────────────
  // 落 dsh-assistant-secretary-read.json（按 sessionId 存已读 cardKey 集合）：
  // 不写会话日志、不拼 turn 事件，纯文件读写，写盘走同一条 chain 防并发覆盖。
  const readStateFile = join(profileDir(ctx), READ_STATE_FILENAME)
  const readState: Record<string, string[]> = (() => {
    try {
      return normalizeSecretaryReadState(JSON.parse(readFileSync(readStateFile, 'utf8')))
    } catch {
      return {}
    }
  })()
  let readUpdatedAt = ''

  const persistReadState = (): Promise<void> => {
    const task = async (): Promise<void> => {
      mkdirSync(dirname(readStateFile), { recursive: true })
      const tmp = `${readStateFile}.${process.pid}.tmp`
      const payload = { version: 1, updatedAt: new Date().toISOString(), bySession: readState }
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, readStateFile)
      readUpdatedAt = payload.updatedAt
    }
    const run = chain.then(task, task)
    chain = run.then(() => void 0, () => void 0)
    return run
  }

  webServer.register({
    kind: 'exact',
    path: ASSISTANT_SECRETARY_READ_ROUTE,
    handler: async (req: any, res: any) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      try {
        if (method === 'POST' || method === 'PUT') {
          const body = await readJsonBody(req)
          if (body?.__tooLarge === true) { sendJson(res, 413, { ok: false, error: 'too-large' }); return }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          const cardKey = normalizeReadCardKey(body?.cardKey)
          const mark = typeof body?.mark === 'string' ? body.mark.trim() : ''
          if (!SESSION_ID_RE.test(sessionId)) { sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return }
          if (cardKey === '') { sendJson(res, 400, { ok: false, error: 'invalid-card-key' }); return }
          if (mark !== 'read') { sendJson(res, 400, { ok: false, error: 'invalid-mark' }); return }
          const already = (readState[sessionId] ?? []).includes(cardKey)
          const count = addReadCardKey(readState, sessionId, cardKey)
          if (!already) await persistReadState()
          sendJson(res, 200, { ok: true, sessionId, cardKey, read: true, unchanged: already, count, updatedAt: readUpdatedAt })
          return
        }
        const query = parseSecretaryRequestQuery(String(req.url ?? ''))
        const askedId = query.requestedId !== '' ? query.requestedId : (state?.sessionId ?? '')
        if (askedId === '' || !SESSION_ID_RE.test(askedId)) {
          sendJson(res, 400, { ok: false, error: 'invalid-session-id' })
          return
        }
        if (method === 'GET' || method === 'HEAD') {
          const cards = readState[askedId] ?? []
          sendJson(res, 200, { ok: true, sessionId: askedId, cards, count: cards.length, updatedAt: readUpdatedAt })
          return
        }
        if (method === 'DELETE') {
          const had = Array.isArray(readState[askedId])
          delete readState[askedId]
          if (had) await persistReadState()
          sendJson(res, 200, { ok: true, sessionId: askedId, cards: [], count: 0, cleared: had })
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, DELETE' })
        res.end()
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) })
      }
    },
  })

  // 「系统通知回合」标记：由 agent/pre-step 里声明的那批消息判定，turn/end 或下一批真实
  // 用户消息到达时清掉；10 分钟兜底过期，绝不让一次异常把秘书的工具永久锁死。
  let noticeTurn = false
  let noticeTurnAt = 0
  const NOTICE_TURN_TTL_MS = 10 * 60 * 1000
  const noticeTurnActive = (): boolean => {
    if (!noticeTurn) return false
    if (Date.now() - noticeTurnAt > NOTICE_TURN_TTL_MS) { noticeTurn = false; return false }
    return true
  }
  let offNoticeReset: (() => void) | undefined
  try {
    const off = ctx.on?.('session/event', (session: any, event: any) => {
      if (String(session?.id ?? '') !== activeSessionId) return
      if (String(event?.type ?? '') === 'turn/end') { noticeTurn = false; noticeTurnAt = 0 }
    })
    if (typeof off === 'function') offNoticeReset = off
  } catch {
    offNoticeReset = undefined
  }

  // 只拦秘书会话。其它会话/子代理完全不受影响。
  let offToolGate: (() => void) | undefined
  try {
    offToolGate = ctx.on?.('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
      if (activeSessionId === '') return next()
      const caller = String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? '')
      if (caller !== activeSessionId) return next()
      const tool = String(exec?.name ?? '')
      // 系统通知回合：工具全禁。这一轮只允许把结果念给用户，不允许再派活/再查/再写。
      if (noticeTurnActive()) {
        return {
          kind: 'deny',
          reason: '这一轮是插件自动送来的「电脑操作会话完成」系统通知，不是用户的要求：工具已全部禁用。请把那条 Computer Use 会话的结果完整汇报给用户（原样转述，文件名、路径、数字、提交号、判据、结论都不许省略，不许为简短而删），不要调用任何工具。',
        }
      }
      if (!secretaryToolDenied(tool)) return next()
      return {
        kind: 'deny',
        reason: `个人秘书只读闸已拒绝 ${tool || '未知工具'}（写文件/终端/直接操作屏幕/派子代理不能在秘书会话执行；只读联网查询 web_search、web_fetch 是放行的）。这不是收工理由：必须立即调用 secretary_dispatch，已有项目用 kind=existing + cwd，没有项目用 kind=new-folder；派活成功后再回报已派 Computer Use 会话处理。`,
      }
    })
  } catch {
    offToolGate = undefined
  }

  // 「发送时的权限闸」：标准会话页的发送由宿主处理，插件不能像以前那样在组件里拦消息，
  // 所以在**每一轮开始前**（agent/pre-step）确认这条会话真的还在只读档：
  //   - 读得到策略且确实 read-only → 放行；
  //   - 读得到策略但不是 read-only → 拦下这一轮，并给出人话原因（= 权限确认失败才阻止）；
  //   - 宿主没有 sandboxPolicy 服务（找不到判据）→ 放行并告警一次，绝不因为探测失败把秘书锁死。
  let offStepGate: (() => void) | undefined
  let warnedNoPolicy = false
  try {
    offStepGate = ctx.on?.('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
      if (activeSessionId === '') return next()
      const session = payload?.agent?.session ?? payload?.session ?? null
      const sessionId = String(session?.id ?? '')
      if (sessionId !== activeSessionId) return next()
      // 这一批被 claim 的消息里有没有系统通知：有 → 本轮工具全禁；有真实用户消息 → 解除。
      const claimed = Array.isArray(payload?.messages) ? payload.messages : []
      if (claimed.length > 0) {
        const notice = claimed.some((message: any) => isNoticeMessageId(message?.id))
        noticeTurn = notice
        noticeTurnAt = notice ? Date.now() : 0
      }
      let mode = ''
      try {
        const policy = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
        const resolved = policy && typeof policy.resolve === 'function' ? policy.resolve({ session }) : null
        mode = String(resolved?.mode ?? '')
      } catch {
        mode = ''
      }
      if (mode === '') {
        if (!warnedNoPolicy) {
          warnedNoPolicy = true
          ctx?.logger?.warn?.('[dsh-assistant] 读不到 sandboxPolicy：秘书会话的只读确认这一轮跳过（不会因此锁死）')
        }
        return next()
      }
      if (mode === 'read-only' || mode === 'readonly') return next()
      return {
        kind: 'deny',
        reason: `个人秘书会话没在只读档（当前 ${mode}），这条消息先拦下了。后台会继续把它切回「仅可查看」，确认后再发即可。`,
      }
    })
  } catch {
    offStepGate = undefined
  }

  // 朗读友好输出规范（2026-11-21）：秘书每条回复都会渲染成卡片并被微软 TTS 朗读，
  // 所以单独加一段表达约束。只对本会话生效，其它会话一个字都不多。
  let offSpeechStyle: (() => void) | undefined
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      offSpeechStyle = systemPrompt.section({
        name: 'assistant:secretary-speech-style',
        order: 1780, // 派活规则段（1790）之前：先定表达，再谈派活
        text: (context: any) => {
          const sessionId = String(context?.agent?.session?.id ?? '')
          if (sessionId === '' || sessionId !== activeSessionId) return ''
          return SECRETARY_SPEECH_STYLE_TEXT
        },
      })
    }
  } catch {
    offSpeechStyle = undefined
  }

  // 语音输入提示（2026-11-22 用户新需求）：用户多用语音转文字，常带同音字/断句问题。
  // 单独一段，order 1785 紧贴派活分层段（1790）之前，不并入朗读规范、不改派活规则原文。
  let offVoiceInput: (() => void) | undefined
  try {
    const systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      offVoiceInput = systemPrompt.section({
        name: 'assistant:secretary-voice-input',
        order: 1785,
        text: (context: any) => {
          const sessionId = String(context?.agent?.session?.id ?? '')
          if (sessionId === '' || sessionId !== activeSessionId) return ''
          return SECRETARY_VOICE_INPUT_TEXT
        },
      })
    }
  } catch {
    offVoiceInput = undefined
  }

  return () => {
    try { offToolGate?.() } catch {}
    try { offNoticeReset?.() } catch {}
    try { offStepGate?.() } catch {}
    try { if (typeof offSpeechStyle === 'function') offSpeechStyle() } catch {}
    try { if (typeof offVoiceInput === 'function') offVoiceInput() } catch {}
    try { routes.dispose() } catch {}
  }
}

/**
 * 秘书会话「语音输入」提示段（系统提示段落正文，最多三行）。
 * 语义：内部纠同音、不改写原话、不因错别字失败/反问、歧义影响执行才最短确认；
 * 派活 task 照抄原话、用户卡与附件一律原文、改读要在正文说明。
 * 位置：紧接在派活分层段（1790）之前，由 1785 号段落挂载。
 */
export const SECRETARY_VOICE_INPUT_TEXT = [
  '# 语音输入（个人秘书）',
  '一、本页输入多是用户语音转文字：可能带同音字或相近音的错别字、断句不当、缺标点。按语义理解，同音纠正在你内部完成；不许悄悄改写用户原话，不许因一个错别字判任务失败或反问；只有歧义确实影响执行时，才用最短一句确认。',
  '二、派活时 secretary_dispatch 的 task 字段照抄用户原话，可在其后加括号注明「语音输入，可能有同音字误」，但不得替换关键词；秘书页用户卡（冷蓝那张）与附件内容一律显示原文、不显示纠正版本，附件一律不改写；若你在回复里改读了某个词，必须在正文说清改了哪个词。',
].join('\n')

/**
 * 秘书会话「卡片 + 朗读」输出规范（系统提示段落正文）。
 * 数字/单位念读规则按用户原话：8–14℃ → 「8 到 14 摄氏度」。
 */
export const SECRETARY_SPEECH_STYLE_TEXT = [
  '# 输出与朗读（个人秘书）',
  '你的每条回复都会：① 在会话页渲染成一张卡片；② 由微软 TTS 自动朗读。请严格遵守：',
  '一、口语化短句，先给结论；只用正常中文标点；不要用 markdown 符号、表格、列表符号、表情符号、代码块。',
  '二、数字和单位要念得出来：温度写「8 到 14 摄氏度」这样的说法，时间写「八点十二分」，距离写「三公里」，重量写「两公斤」；英文缩写尽量换成读得出的中文说法，必须保留时照原文写（如车次 G1545）。',
  '三、引用某条会话时用 [[session:会话id|会话标题]] 一行一个（会话 id 从上下文里取），卡片会把它渲染成可点击的引用块。',
].join('\n')

/* ---------- v4 日志修复（纯函数，不依赖宿主实例） ---------- */

type LogEventRecord = Record<string, any>

const REFERENCE_ARRAY_KEYS = new Set(['sourceEventSeqs', 'messageSeqs'])
const REFERENCE_SCALAR_KEYS = new Set(['sourceEventSeq', 'headerSeq'])
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

interface SecretaryLogRepairResult {
  lines: string[]
  droppedOldSeqs: number[]
  staleReferences: number
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseLogEventLine(line: string): LogEventRecord | null {
  const raw = String(line ?? '')
  if (raw.trim() === '') return null
  try {
    const event = JSON.parse(raw) as unknown
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return null
    return event as LogEventRecord
  } catch {
    return null
  }
}

function rewriteEventReferences(event: LogEventRecord, oldToNew: Map<number, number>): { staleReferences: number } {
  let staleReferences = 0
  const seen = new WeakSet<object>()

  const rewriteArray = (value: unknown[], key: string): unknown[] => {
    const out: unknown[] = []
    for (const item of value) {
      if (REFERENCE_ARRAY_KEYS.has(key) && typeof item === 'number' && Number.isFinite(item)) {
        const mapped = oldToNew.get(item)
        if (mapped === undefined) { staleReferences += 1; continue }
        out.push(mapped)
      } else {
        out.push(visit(item, key))
      }
    }
    if (REFERENCE_ARRAY_KEYS.has(key)) {
      const numbers = out.filter((item): item is number => typeof item === 'number')
      return Array.from(new Set(numbers)).sort((a, b) => a - b)
    }
    return out
  }

  const visit = (value: unknown, parentKey = ''): unknown => {
    if (Array.isArray(value)) return rewriteArray(value, parentKey)
    if (value === null || typeof value !== 'object' || seen.has(value)) return value
    seen.add(value)
    const record = value as LogEventRecord
    for (const key of Object.keys(record)) {
      if (REFERENCE_ARRAY_KEYS.has(key) && Array.isArray(record[key])) {
        record[key] = rewriteArray(record[key] as unknown[], key)
      } else if (REFERENCE_SCALAR_KEYS.has(key) && typeof record[key] === 'number') {
        const mapped = oldToNew.get(record[key])
        if (mapped === undefined) staleReferences += 1
        else record[key] = mapped
      } else {
        record[key] = visit(record[key], key)
      }
    }
    return record
  }

  visit(event, '')
  return { staleReferences }
}

/** 修复半截合成轮留下的坏状态：跳过不合法的轮/步开合事件，保留合法真实轮，并重编号与重映射引用。 */
export function repairSecretaryLogLines(input: readonly string[]): SecretaryLogRepairResult {
  const lines = Array.from(input ?? [], (line) => String(line ?? ''))
  const header = lines[0] ?? ''
  const kept: LogEventRecord[] = []
  const droppedOldSeqs: number[] = []
  const oldToNew = new Map<number, number>()
  let staleReferences = 0
  let openTurn = 0
  let openStep = 0
  let nextTurn = 1
  let nextStep = 1

  for (const raw of lines.slice(1)) {
    const event = parseLogEventLine(raw)
    if (event === null) {
      const seq = Number(event?.seq)
      if (Number.isFinite(seq)) droppedOldSeqs.push(seq)
      continue
    }

    const data = (event.data ?? {}) as LogEventRecord
    const type = String(event.type ?? '')
    const turn = Number(data.turn)
    const step = Number(data.step)
    let keep = true

    if (type === 'turn/start') {
      if (openTurn !== 0 || !isPositiveNumber(turn) || turn !== nextTurn) keep = false
      else {
        openTurn = turn
        openStep = 0
        nextStep = 1
      }
    } else if (type === 'step/start') {
      if (openTurn === 0 || openStep !== 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || step !== nextStep) keep = false
      else openStep = step
    } else if (type === 'step/end') {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || openStep !== step) keep = false
      else {
        openStep = 0
        nextStep = step + 1
      }
    } else if (type === 'turn/end') {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || openStep !== 0) keep = false
      else {
        openTurn = 0
        nextTurn = turn + 1
        nextStep = 1
      }
    } else if (type === 'assistant/message' || type === 'assistant/attempt' || type === 'tool/call' || type === 'tool/result') {
      if (openTurn === 0 || !isPositiveNumber(turn) || turn !== openTurn || !isPositiveNumber(step) || step !== openStep) keep = false
    } else if (isPositiveNumber(turn) && turn !== openTurn) {
      keep = false
    }

    if (!keep) {
      const oldSeq = Number(event.seq)
      if (Number.isFinite(oldSeq)) droppedOldSeqs.push(oldSeq)
      continue
    }

    const oldSeq = Number(event.seq)
    const newSeq = kept.length
    if (Number.isFinite(oldSeq)) oldToNew.set(oldSeq, newSeq)
    kept.push(event)
  }

  const serialized = kept.map((event, index) => {
    staleReferences += rewriteEventReferences(event, oldToNew).staleReferences
    event.seq = index
    return JSON.stringify(event)
  })

  return { lines: [header, ...serialized], droppedOldSeqs, staleReferences }
}

export function repairSecretaryLogText(text: string): string {
  const raw = String(text ?? '')
  const result = repairSecretaryLogLines(raw.split(/\r?\n/))
  return `${result.lines.join('\n')}\n`
}

export function compressSessionLogText(text: string): Buffer {
  const zlib2 = zlib as any
  if (typeof zlib2.zstdCompressSync !== 'function') throw new Error('zstdCompressSync not available')
  return Buffer.from(zlib2.zstdCompressSync(Buffer.from(String(text ?? ''), 'utf8')))
}

export function decompressSessionLogBytes(data: Uint8Array | Buffer): string {
  const zlib2 = zlib as any
  if (typeof zlib2.zstdDecompressSync !== 'function') throw new Error('zstdDecompressSync not available')
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const first = buffer.indexOf(ZSTD_MAGIC)
  if (first === -1) {
    if (buffer.length === 0) return ''
    return Buffer.from(zlib2.zstdDecompressSync(buffer)).toString('utf8')
  }
  const chunks: string[] = []
  for (let cursor = first; cursor < buffer.length; ) {
    const next = buffer.indexOf(ZSTD_MAGIC, cursor + ZSTD_MAGIC.length)
    const end = next === -1 ? buffer.length : next
    chunks.push(Buffer.from(zlib2.zstdDecompressSync(buffer.subarray(cursor, end))).toString('utf8'))
    cursor = end
  }
  return chunks.join('')
}

/** 单测入口：不启动宿主也能验路由、归一与工具闸。 */
export const assistantSecretaryTestSurface = {
  ASSISTANT_SECRETARY_ROUTE,
  ASSISTANT_SECRETARY_READ_ROUTE,
  READ_MAX_KEYS,
  normalizeReadCardKey,
  normalizeReadCardKeys,
  normalizeSecretaryReadState,
  addReadCardKey,
  SECRETARY_DISPATCH_POLICY,
  normalizeSecretaryState,
  secretaryToolDenied,
  registerAssistantSecretary,
  secretarySessionRef,
  registerNoticeMessageId,
  isNoticeMessageId,
  clearNoticeMessageIds,
  SECRETARY_SPEECH_STYLE_TEXT,
  SECRETARY_VOICE_INPUT_TEXT,
  repairSecretaryLogLines,
  repairSecretaryLogText,
  compressSessionLogText,
  decompressSessionLogBytes,
  parseSecretaryRequestQuery,
}
