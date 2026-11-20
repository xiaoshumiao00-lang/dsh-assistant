/**
 * 个人秘书固定会话的宿主侧锚点。
 *
 * 只做两件事：
 *   1. 把唯一的秘书 sessionId 持久化到 profile（浏览器 localStorage 会随缓存丢失，
 *      手机/电脑也不能共享，所以真值必须在宿主）；
 *   2. 给秘书会话装一道工具闸：只读权限仍然带着 shell / 写文件 / Computer Use /
 *      子代理这些工具，子代理还会继承父会话的只读档，所以秘书会话在工具入口
 *      直接 deny 所有“替主人干活”的能力。派活由客户端页面创建独立会话完成。
 *
 * 路由：
 *   GET    /api/assistant/secretary  → { ok, sessionId, updatedAt }
 *   POST   /api/assistant/secretary  body { sessionId } → 覆盖
 *   DELETE /api/assistant/secretary  → 清空（测试/重置用）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { manageWebRoutes } from './web-routes'

export const ASSISTANT_SECRETARY_ROUTE = '/api/assistant/secretary'
const STATE_FILENAME = 'dsh-assistant-secretary.json'
const MAX_BODY_BYTES = 4096
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/

export interface SecretaryState {
  sessionId: string
  updatedAt: string
}

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
 * 秘书会话的工具白名单。秘书只做理解、汇总和页面上的独立派活；
 * 任何未知工具（包括第三方 MCP、未来新增的执行工具）默认拒绝，避免用黑名单追不上新工具。
 */
const SECRETARY_ALLOWED_TOOLS = new Set([
  'read', 'grep', 'glob', 'read_image',
  'web_search', 'web_fetch',
  'ask_user_question', 'present', 'skill',
  'todo_write', 'get_goal',
  'list_agents', 'job_list', 'job_output',
])

export function secretaryToolDenied(toolName: string): boolean {
  const name = String(toolName ?? '').trim().toLowerCase()
  if (name === '') return false
  if (SECRETARY_ALLOWED_TOOLS.has(name)) return false
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

export function registerAssistantSecretary(ctx: any): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  const webServer = routes.webServer
  const file = join(profileDir(ctx), STATE_FILENAME)
  let state: SecretaryState | null = readFileState(file)
  let activeSessionId = state?.sessionId ?? ''
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
      try {
        if (method === 'GET' || method === 'HEAD') {
          sendJson(res, 200, {
            ok: true,
            sessionId: state?.sessionId ?? null,
            updatedAt: state?.updatedAt ?? '',
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
          const next = await writeState(sessionId)
          sendJson(res, 200, { ok: true, sessionId: next.sessionId, updatedAt: next.updatedAt })
          return
        }
        if (method === 'DELETE') {
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

  // 只拦秘书会话。其它会话/子代理完全不受影响。
  let offToolGate: (() => void) | undefined
  try {
    offToolGate = ctx.on?.('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
      if (activeSessionId === '') return next()
      const caller = String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? '')
      if (caller !== activeSessionId) return next()
      const tool = String(exec?.name ?? '')
      if (!secretaryToolDenied(tool)) return next()
      return {
        kind: 'deny',
        reason: `个人秘书是只读会话，不执行任务、不派子代理（已拒绝 ${tool || '未知工具'}）。请在个人秘书页面用「派活」创建独立会话。`,
      }
    })
  } catch {
    offToolGate = undefined
  }

  return () => {
    try { offToolGate?.() } catch {}
    try { routes.dispose() } catch {}
  }
}

/** 单测入口：不启动宿主也能验路由、归一与工具闸。 */
export const assistantSecretaryTestSurface = {
  ASSISTANT_SECRETARY_ROUTE,
  normalizeSecretaryState,
  secretaryToolDenied,
  registerAssistantSecretary,
}
