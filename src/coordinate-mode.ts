/**
 * Computer Use 坐标模式设置（从 dsh-orb 移入个人助手）。
 *
 * 背景：内嵌的 computer-use 工具默认用「千分比坐标」——模型按截图的 0–1000 比例给
 * 点击位置（x=500 是画面中线）。模型若按像素理解位置，就会点偏；关掉后改用截图
 * 原始像素坐标，点击一般更准。
 *
 * 真值放在 profile 目录的 millifraction-coordinates.json（沿用 dsh-orb 的文件名，
 * 老配置自动继承）。宿主对外提供两样东西：
 *   - cordis 服务 `assistantCoordinateMode`：{ currentMode() → 'millifraction' | 'pixel' }
 *     （内嵌 computer-use 在新建会话时读它盖坐标模式戳）；
 *   - HTTP GET/POST /api/assistant/coordinate-mode：设置页读写（手机端经同一代理同源可用）。
 *
 * 只影响之后新建的 Computer Use 会话：坐标模式在会话创建时写进会话记录，已开会话
 * 保持不变，避免同一段对话里历史坐标与当前坐标系打架（与 dsh-orb 口径一致）。
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { manageWebRoutes } from './web-routes.ts'

export const COORDINATE_MODE_ROUTE = '/api/assistant/coordinate-mode'

/** 与 dsh-orb 同名文件：用户已有的设置直接继承，不需要重新选一次。 */
const SETTINGS_FILE = 'millifraction-coordinates.json'

export type CoordinateMode = 'millifraction' | 'pixel'

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

/** 缺省关掉千分比：含 Windows 在内全部平台走截图原始像素（2026-11-25 起）。 */
function defaultMillifraction(): boolean {
  return false
}

function readMillifraction(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed.enabled === 'boolean') return parsed.enabled
  } catch { /* 没有配置文件 → 用平台缺省 */ }
  return defaultMillifraction()
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

/** 只读一个小 JSON body；设置页只会发 { enabled: boolean }。 */
async function readBody(req: any, limit = 8 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += b.length
    if (size > limit) return null
    chunks.push(b)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 给宿主 `system-prompt/assemble` 的载荷补上 `tools`。
 *
 * 2026-11-28 根因（新建 Computer Use 会话首轮必挂
 * `Cannot read properties of undefined (reading 'map')`）：
 * 内嵌 computer-use 的像素模式钩子 `system-prompt/assemble`
 * （vendor/computer-use/index.js:1224-1232）读 `nextAssembly.tools` 再
 * `tools.map(rewritePixelTool)`（同文件 :329），但本宿主 dsh-system-prompt 的瀑布载荷
 * `PromptPresentation` 只带 sections / contexts / variables（见
 * dsh/docs/subsystems/system-prompt.md：tool declarations remain provider-owned），
 * `tools` 由 `assemble()` 在瀑布返回之后才挂上去。
 * 于是：
 *   - 进程内新建的空白 CU 会话 → `agent/created` 时盖成 pixel 戳 → 钩子走 `tools.map` → undefined.map；
 *   - 从磁盘恢复的老会话 → 日志里已有 `session/end-seed`，vendor 的 `stampCoordinateMode`
 *     直接早退、不盖戳 → `coordinateModeOf` 回落 millifraction → 钩子早退 → 不炸。
 * 这正是「新建的 CU 会话跑回合必失败、旧会话照常」的分界。
 *
 * vendor 不许改，所以在自己的注册点把缺的字段补上：本插件的 apply 早于任何 agent 的预设
 * 插件实例化，因此这个监听器排在 vendor 之外层（cordis waterfall 按注册顺序最外层先跑），
 * 载荷对象沿瀑布按同一性传递（dsh-working-directory 也是就地改 contexts），内层读得到。
 * @param ctx - dsh-assistant 宿主上下文。
 * @param disposers - 插件卸载时要一起摘掉的清理函数。
 */
function installAssembleToolsPayload(ctx: any, disposers: Array<() => void>): void {
  if (typeof ctx?.on !== 'function') return
  const hook = async (assembly: any, context: any, next: () => Promise<any>): Promise<any> => {
    if (assembly && typeof assembly === 'object' && assembly.tools === undefined) {
      let tools: unknown[] = []
      try {
        const registry = (typeof ctx?.get === 'function' ? ctx.get('tools') : undefined) ?? ctx?.tools
        const schemas = registry?.schemas?.(context?.scope, context?.toolSet)
        if (Array.isArray(schemas)) tools = schemas
      } catch { /* 注册表读不到就给空数组：像素模式只要求 tools 可迭代 */ }
      try { assembly.tools = tools } catch { /* 载荷只读就交给内层，别在这里炸 */ }
    }
    return next()
  }
  try {
    const off = ctx.on('system-prompt/assemble', hook)
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('assemble tools payload patch failed: %s', String(err)) } catch {}
  }
}

/**
 * 注册坐标模式设置：服务 + HTTP 路由。返回卸载函数（cordis 服务与路由随插件卸载）。
 * @param ctx - dsh-assistant 宿主上下文（需要 webServer 才能挂路由）。
 */
export function registerCoordinateMode(ctx: any): () => void {
  const file = join(profileDir(ctx), SETTINGS_FILE)
  let enabled = readMillifraction(file)

  const currentMode = (): CoordinateMode => (enabled ? 'millifraction' : 'pixel')

  const setEnabled = async (next: boolean): Promise<void> => {
    const previous = enabled
    enabled = next
    try {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ enabled: next }, null, 2) + '\n', 'utf8')
      await rename(tmp, file)
    } catch (err) {
      enabled = previous
      try { ctx.logger?.('dsh-assistant')?.error?.('save coordinate mode failed: %s', String(err)) } catch {}
      throw err
    }
  }

  const service = {
    currentMode,
    millifractionEnabled: (): boolean => enabled,
    setMillifractionEnabled: setEnabled,
  }

  const disposers: Array<() => void> = []
  // 先补宿主 assemble 载荷缺的 `tools`（内嵌 computer-use 的像素模式钩子要求它存在）。
  installAssembleToolsPayload(ctx, disposers)
  const routes = manageWebRoutes(ctx.webServer)
  disposers.push(routes.dispose)
  // 服务名专用，避免和 dsh-orb 的 orbCoordinateMode 撞名；内嵌 computer-use 优先读它。
  try {
    if (ctx?.get?.('assistantCoordinateMode') === undefined && typeof ctx?.provide === 'function') {
      const dispose = ctx.provide('assistantCoordinateMode', service)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('provide assistantCoordinateMode failed: %s', String(err)) } catch {}
  }

  try {
    routes.webServer.register({
      kind: 'exact',
      path: COORDINATE_MODE_ROUTE,
      handler: async (req: any, res: any) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        try {
          if (method === 'GET' || method === 'HEAD') {
            sendJson(res, 200, {
              ok: true,
              enabled,
              mode: currentMode(),
              defaultEnabled: defaultMillifraction(),
            })
            return
          }
          if (method === 'POST' || method === 'PUT') {
            const body = await readBody(req)
            if (!body || typeof body.enabled !== 'boolean') {
              sendJson(res, 400, { ok: false, error: 'invalid-enabled' })
              return
            }
            await setEnabled(body.enabled)
            sendJson(res, 200, {
              ok: true,
              enabled,
              mode: currentMode(),
              defaultEnabled: defaultMillifraction(),
            })
            return
          }
          res.writeHead(405, { allow: 'GET, HEAD, POST, PUT' })
          res.end()
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) })
        }
      },
    })
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('register coordinate mode route failed: %s', String(err)) } catch {}
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}
