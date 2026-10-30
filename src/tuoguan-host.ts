/**
 * dsh-tuoguan host 端入口：托管状态的**唯一真值源** + HTTP 路由。
 *
 * 为什么要 host 端：手机浏览器和电脑浏览器各有各的 localStorage，
 * 状态只存在客户端时两端永远不可能同步（这就是之前那个 bug 的根因）。
 * 现在真值落在 profile 目录下的一个 JSON 文件里，两端都通过同源 HTTP 读写它。
 *
 * 路由（做法照抄 dsh-orb / dsh-worktable：注册在宿主 web 端口的前缀路由上，
 * 浏览器用相对路径 fetch，同源 + 既有登录 cookie 即可，无需额外鉴权字段）：
 *
 *   GET  /.dsh-tuoguan/state
 *        → { off: { "<sessionId>": true }, on: { "<sessionId>": true }, defaultOn: boolean,
 *            revision: <递增整数>, updatedAt: <ISO> }
 *   POST /.dsh-tuoguan/state   body: { sessionId: string, on: boolean }
 *        → 写入后返回同一结构；参数非法返回 400
 *   POST /.dsh-tuoguan/state   body: { defaultOn: boolean }
 *        → 只改「新会话默认托管状态」（个人助手 → 托管设置），返回同一结构
 *
 * 语义：没被显式动过的会话用 `defaultOn`（缺省 true = 老行为「没关过就托管 ON」）；
 * 显式开/关只记与默认值不同的会话（`on` / `off` 两张表），所以默认值改动后
 * 老会话里没显式动过的会跟着变。
 *
 * 持久化文件：`<profile 目录>/dsh-tuoguan-state.json`
 *   profile 目录通过宿主 `profileContext.dir` 解析（不硬编码路径），
 *   取不到时退到 `homePaths.home`，再退到 `process.cwd()`。
 *   例如 desktop profile 下为
 *   `<用户目录>/.dsh/profiles/desktop/dsh-tuoguan-state.json`。
 *
 * 并发：所有读写走同一个 Promise 队列串行化，落盘用 tmp + rename 原子替换，
 *   两个客户端同时点也不会写坏文件。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'dsh-assistant-tuoguan'

/**
 * 宿主服务依赖。`webServer` 是硬依赖（没有它就没有同步能力）；
 * 鉴权用的 `connection` 走 `ctx.get` 可选查找，避免在某些 profile 下
 * 把整个插件卡成 pending（cordis 对未 inject 的服务直读属性会 throw）。
 */
export const inject: string[] = ['webServer']

/* ---------- 常量 ---------- */

const PREFIX = '/.dsh-tuoguan'
const STATE_ROUTE = `${PREFIX}/state`
const STATE_FILENAME = 'dsh-tuoguan-state.json'
/** POST body 上限：托管状态就是几个 sessionId，64KB 绰绰有余。 */
const MAX_BODY_BYTES = 64 * 1024
/** sessionId 长度上限，防止把垃圾写进状态文件。 */
const MAX_SESSION_ID_LENGTH = 256

/* ---------- 类型 ---------- */

interface TuoguanState {
  /** 被「显式关过」的 sessionId 集合（与默认状态相反时才记录）。 */
  off: Record<string, boolean>
  /** 被「显式开过」的 sessionId 集合（与默认状态相反时才记录；老状态文件没有这一项）。 */
  on: Record<string, boolean>
  /** 新会话的默认托管状态（缺省 true = 老行为：没关过就是托管中）。 */
  defaultOn: boolean
  /** 单调递增的写版本号；客户端据此判断要不要重新 setState。 */
  revision: number
  /** 最近一次写入时间（ISO 8601）。 */
  updatedAt: string
}

interface WebServerLike {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): (() => void) | void
}

interface ConnectionLike {
  admit?: (req: IncomingMessage) => unknown
  isAuthenticated?: (req: IncomingMessage) => boolean
}

/* ---------- 可选服务与 profile 目录解析 ---------- */

/** cordis 对未 inject 的服务直读属性会 throw，所以可选服务一律 ctx.get + 兜底。 */
function optionalService(ctx: any, id: string): unknown {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(id)
  } catch { /* 服务不存在 */ }
  return undefined
}

/**
 * 当前 profile 目录（宿主 desktop / `dsh web` 都提供 `profileContext.dir`）。
 * 解析不到时依次退到 `homePaths.home` 与 `process.cwd()`，绝不硬编码绝对路径。
 */
function profileDirectory(ctx: any): string {
  const profile = optionalService(ctx, 'profileContext') as { dir?: unknown } | undefined
  if (profile && typeof profile.dir === 'string' && profile.dir !== '') return profile.dir
  const homePaths = optionalService(ctx, 'homePaths') as { home?: unknown } | undefined
  if (homePaths && typeof homePaths.home === 'string' && homePaths.home !== '') return homePaths.home
  return process.cwd()
}

/* ---------- 状态读写（串行 + 原子落盘） ---------- */

/** 把任意来源的对象规整成合法状态；坏数据一律当作空状态（默认全 ON）。 */
function normalizeState(raw: unknown): TuoguanState {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const offSource = typeof record.off === 'object' && record.off !== null && !Array.isArray(record.off)
    ? record.off as Record<string, unknown>
    : {}
  const off: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(offSource)) {
    if (typeof key === 'string' && key !== '' && key.length <= MAX_SESSION_ID_LENGTH && value === true) {
      off[key] = true
    }
  }
  const revision = typeof record.revision === 'number' && Number.isFinite(record.revision) && record.revision >= 0
    ? Math.floor(record.revision)
    : 0
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : ''
  // 新增字段（2026-10）：显式「开」集合 + 默认状态。老文件没有这两项 → on 为空、默认 ON，
  // 语义与之前完全一致（没关过 = 托管中）。
  const onSource = typeof record.on === 'object' && record.on !== null && !Array.isArray(record.on)
    ? record.on as Record<string, unknown>
    : {}
  const on: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(onSource)) {
    if (typeof key === 'string' && key !== '' && key.length <= MAX_SESSION_ID_LENGTH && value === true) {
      on[key] = true
    }
  }
  const defaultOn = typeof record.defaultOn === 'boolean' ? record.defaultOn : true
  // 同一会话不可能既显式开又显式关：两边都出现时以「关」为准（旧数据只有 off）。
  for (const key of Object.keys(off)) delete on[key]
  return { off, on, defaultOn, revision, updatedAt }
}

function readStateSync(file: string): TuoguanState {
  try {
    return normalizeState(JSON.parse(readFileSync(file, 'utf8')))
  } catch { /* 文件不存在 / JSON 损坏：等价于「谁都没关过」= 全部 ON */
    return { off: {}, on: {}, defaultOn: true, revision: 0, updatedAt: '' }
  }
}

/** tmp + rename 原子替换：读者永远只会看到完整文件（写法与 dsh-orb 一致）。 */
function writeStateSync(file: string, state: TuoguanState): void {
  const payload = `${JSON.stringify(state, void 0, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temporary, payload, 'utf8')
  renameSync(temporary, file)
}

/**
 * 状态存储。`chain` 把每一次读或写排进同一条队列：
 * 两个客户端同时点时不会交错读改写，也不会并发写同一个文件。
 */
class TuoguanStore {
  readonly file: string
  private chain: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  /** 串行执行一个（同步）任务，返回它的结果；前面的任务失败也继续跑。 */
  private enqueue<T>(task: () => T): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => void 0, () => void 0)
    return run
  }

  read(): Promise<TuoguanState> {
    return this.enqueue(() => readStateSync(this.file))
  }

  /** 某会话的当前有效状态：显式记录优先，否则用默认值。 */
  private effective(state: TuoguanState, sessionId: string): boolean {
    if (state.off[sessionId] === true) return false
    if (state.on[sessionId] === true) return true
    return state.defaultOn
  }

  /**
   * 切换某个会话的托管开关。
   * 值没变时不写盘、不涨 revision —— 避免两端反复轮询/重放同一状态造成写放大。
   * 只把「与默认状态不同」的会话记成显式状态，状态文件不会随会话数无限膨胀。
   */
  setSession(sessionId: string, on: boolean): Promise<TuoguanState> {
    return this.enqueue(() => {
      const current = readStateSync(this.file)
      if (this.effective(current, sessionId) === on) return current
      const off: Record<string, boolean> = { ...current.off }
      const onMap: Record<string, boolean> = { ...current.on }
      delete off[sessionId]
      delete onMap[sessionId]
      if (on !== current.defaultOn) {
        if (on) onMap[sessionId] = true
        else off[sessionId] = true
      }
      const next: TuoguanState = {
        off,
        on: onMap,
        defaultOn: current.defaultOn,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }
      writeStateSync(this.file, next)
      return next
    })
  }

  /** 改「新会话默认托管状态」；值没变就不写盘。 */
  setDefault(defaultOn: boolean): Promise<TuoguanState> {
    return this.enqueue(() => {
      const current = readStateSync(this.file)
      if (current.defaultOn === defaultOn) return current
      const next: TuoguanState = {
        ...current,
        defaultOn,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }
      writeStateSync(this.file, next)
      return next
    })
  }
}

/* ---------- HTTP 细节 ---------- */

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

/**
 * 登录门禁：与 dsh-orb 同一套逻辑。宿主没有 `connection` 服务时不额外拦截
 * （宿主自己的 web 端口本就带登录门禁，同源页面请求自带 cookie）。
 */
function rejectionStatus(ctx: any, req: IncomingMessage): number | undefined {
  const connection = optionalService(ctx, 'connection') as ConnectionLike | undefined
  if (connection === undefined || connection === null) return void 0
  try {
    if (typeof connection.admit === 'function') {
      const admitted = connection.admit(req) as { rejection?: unknown } | undefined
      if (admitted && typeof admitted === 'object' && typeof admitted.rejection === 'number') {
        return admitted.rejection
      }
      return void 0
    }
    if (typeof connection.isAuthenticated === 'function') {
      return connection.isAuthenticated(req) ? void 0 : 401
    }
  } catch { /* 门禁探测失败时放行，绝不同步失败把开关变成死按钮 */ }
  return void 0
}

/* ---------- 路由 ---------- */

async function handleRequest(ctx: any, store: TuoguanStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const rejection = rejectionStatus(ctx, req)
  if (rejection !== void 0) {
    res.writeHead(rejection)
    res.end()
    return
  }
  const method = req.method ?? 'GET'
  try {
    if (method === 'OPTIONS') {
      // 同源场景不会有预检；真收到时只回 204，不放宽 CORS。
      res.writeHead(204, { allow: 'GET, POST, OPTIONS' })
      res.end()
      return
    }
    if (path === STATE_ROUTE && method === 'GET') {
      sendJson(res, 200, await store.read())
      return
    }
    if (path === STATE_ROUTE && method === 'POST') {
      const body = await readJsonBody(req)
      // 只改默认状态：{ defaultOn: boolean }（个人助手设置页的「托管默认状态」开关）
      if (typeof body.defaultOn === 'boolean') {
        sendJson(res, 200, await store.setDefault(body.defaultOn))
        return
      }
      const sessionId = body.sessionId
      const on = body.on
      if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > MAX_SESSION_ID_LENGTH) {
        sendJson(res, 400, { error: 'invalid-session' })
        return
      }
      if (typeof on !== 'boolean') {
        sendJson(res, 400, { error: 'invalid-on' })
        return
      }
      sendJson(res, 200, await store.setSession(sessionId, on))
      return
    }
    if (path === STATE_ROUTE) {
      res.writeHead(405, { allow: 'GET, POST, OPTIONS' })
      res.end()
      return
    }
    sendJson(res, 404, { error: 'not-found' })
  } catch (error) {
    const status = (error as { status?: unknown })?.status
    if (status === 413) {
      sendJson(res, 413, { error: 'too-large' })
      return
    }
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: String((error as Error)?.message ?? error) })
    else res.end()
  }
}

/** 挂载 `/.dsh-tuoguan`，返回卸载函数。 */
function registerTuoguanRoutes(ctx: any, store: TuoguanStore): () => void {
  let webServer = optionalService(ctx, 'webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    try { webServer = ctx?.webServer as WebServerLike | undefined } catch { webServer = undefined }
  }
  if (!webServer || typeof webServer.register !== 'function') {
    console.error('dsh-assistant: 宿主 webServer 不可用，托管状态无法跨端同步（仅本机 localStorage 生效）')
    return () => void 0
  }
  const dispose = webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => handleRequest(ctx, store, req, res),
  })
  return typeof dispose === 'function' ? dispose : () => void 0
}

/* ---------- 插件体 ---------- */

/**
 * 注册托管状态路由。宿主在 desktop / web profile 下都提供 `webServer`；
 * 拿不到时降级为纯客户端插件（旧行为），不抛错、不阻塞其它插件。
 */
export function apply(ctx: any): void {
  const directory = profileDirectory(ctx)
  const store = new TuoguanStore(join(directory, STATE_FILENAME))
  console.error(`dsh-assistant: 托管状态文件 ${store.file}`)
  const effect = typeof ctx?.effect === 'function' ? ctx.effect : void 0
  if (effect === void 0) {
    registerTuoguanRoutes(ctx, store)
    return
  }
  effect(() => {
    const detach = registerTuoguanRoutes(ctx, store)
    console.error(`dsh-assistant: 已挂载托管路由 GET/POST ${STATE_ROUTE}`)
    return () => { detach() }
  })
}
