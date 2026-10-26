/**
 * dsh-assistant 跨端状态（项目 + 控制室视图）：
 *   GET  /api/assistant/state  → { state: { projects, view, revision, updatedAt } | null }
 *   PUT  /api/assistant/state  body { projects, view } → 写入后返回同一结构
 *
 * 为什么放宿主：手机与电脑的 localStorage 各自独立，项目/文件夹/绑定只存客户端时
 * 两端永远不会同步。真值落在 profile 目录下的 JSON 文件里，两端同源读写。
 * 会话本身在宿主，不需要同步。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const STATE_ROUTE = '/api/assistant/state'
const STATE_FILENAME = 'dsh-assistant-state.json'
const MAX_BODY_BYTES = 4 * 1024 * 1024

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

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += b.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('too-large'), { status: 413 })
    chunks.push(b)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

type Stored = { projects: any; view: any; revision: number; updatedAt: string }

function normalize(raw: any): Stored | null {
  if (!raw || typeof raw !== 'object') return null
  if (!raw.projects || typeof raw.projects !== 'object') return null
  return {
    projects: raw.projects,
    view: raw.view && typeof raw.view === 'object' ? raw.view : null,
    revision: Number.isFinite(raw.revision) ? Math.max(0, Math.floor(raw.revision)) : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

export function registerAssistantState(ctx: any): void {
  const webServer = ctx?.webServer
  if (!webServer || typeof webServer.register !== 'function') return
  const file = join(profileDir(ctx), STATE_FILENAME)
  let cached: Stored | null = null
  let loaded = false
  let chain: Promise<unknown> = Promise.resolve()

  const readState = async (): Promise<Stored | null> => {
    if (loaded) return cached
    try {
      cached = normalize(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      cached = null
    }
    loaded = true
    return cached
  }

  /** 写状态：带 baseRevision 时做乐观并发控制——宿主 revision 已比 base 新，说明另一端改过，
   *  返回 { conflict } 让调用方改成采纳宿主状态，而不是用旧副本盖掉另一端的删除/排序。 */
  const writeState = (projects: any, view: any, baseRevision: number | null): Promise<Stored | { conflict: Stored }> => {
    const task = async (): Promise<Stored | { conflict: Stored }> => {
      const prev = await readState()
      if (prev && baseRevision != null && Number.isFinite(baseRevision) && prev.revision > baseRevision) {
        return { conflict: prev }
      }
      const next: Stored = {
        projects,
        view,
        revision: (prev?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      }
      const payload = JSON.stringify(next)
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, file)
      cached = next
      loaded = true
      return next
    }
    const run = chain.then(task, task)
    chain = run.then(() => void 0, () => void 0)
    return run
  }

  webServer.register({
    kind: 'prefix',
    path: STATE_ROUTE,
    handler: async (req: any, res: any) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (path !== STATE_ROUTE) { sendJson(res, 404, { error: 'not-found' }); return }
      try {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const state = await readState()
          const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
          const rawSince = params.get('sinceRevision')
          const since = rawSince === null ? Number.NaN : Number(rawSince)
          if (state && Number.isFinite(since) && state.revision === since) {
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
            return
          }
          sendJson(res, 200, { ok: true, state })
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = await readJsonBody(req)
          if (!body.projects || typeof body.projects !== 'object' || Array.isArray(body.projects)) {
            sendJson(res, 400, { error: 'invalid-projects' })
            return
          }
          const base = typeof body.baseRevision === 'number' ? body.baseRevision : null
          const out = await writeState(body.projects, body.view ?? null, base)
          if (out && typeof out === 'object' && 'conflict' in out) {
            sendJson(res, 409, { ok: false, conflict: true, state: (out as { conflict: Stored }).conflict })
            return
          }
          sendJson(res, 200, { ok: true, state: out })
          return
        }
        res.writeHead(405, { allow: 'GET, PUT, POST' })
        res.end()
      } catch (err: any) {
        if (err?.status === 413) { sendJson(res, 413, { error: 'too-large' }); return }
        sendJson(res, 500, { error: 'internal', message: String(err?.message ?? err) })
      }
    },
  })
}
