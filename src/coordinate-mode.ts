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

/** Computer Use 会话的 agent 预设 id（与 src/assistant-cu-watch.ts / src/assistant-dispatch.ts 同一口径）。 */
const CU_AGENT_PRESET = 'computer-use'

/**
 * 注入段的宿主内唯一名字。宿主 SystemPrompt.section 要求全局唯一（重名会抛），
 * 瀑布兜底靠这个名字认「这段已经在载荷里了」，避免两处重复注入。
 */
const CU_POLICY_SECTION_NAME = 'assistant:computer-use-coordinate-policy'

/**
 * 段位次序：紧跟内嵌 computer-use 自己的策略段（order 1750，
 * vendor/computer-use/index.js:1043 → :1219-1223），所以这段规则在模型读到的文本里
 * 排在「Coordinates: …」那句之后；1770/1775/1780/1785/1790 是秘书会话自己的段，不占用 1760。
 */
export const CU_POLICY_SECTION_ORDER = 1760

/** 内嵌 computer-use 在会话日志里盖坐标模式戳的事件名（canonical 与迁移别名都认）。 */
const COORDINATE_MODE_EVENT_TYPES = ['computer-use/coordinate-mode', 'plugin:computer-use/coordinate-mode']

/**
 * DSH 数据根（`<DSH_HOME>`）：本机 profile 目录就是 `<DSH_HOME>/profiles/<名字>`，
 * 所以先认目录里的 `.dsh` 段、再认 `profiles` 段往回退一级；都认不出时按 `<DSH_HOME>/cu-click`
 * 的默认位置把 `.dsh` 补上。刻意不新引 `process` / `node:os`：本文件已有 profileDir()
 * 的同一条回落链（profile 目录 → homePaths → DSH_HOME → cwd），够用了。
 */
function dshRootOf(dir: string): string {
  const parts = String(dir).split(/[\\/]+/).filter((part) => part !== '')
  const dshAt = parts.lastIndexOf('.dsh')
  if (dshAt > 0) return join(...parts.slice(0, dshAt + 1))
  const profilesAt = parts.lastIndexOf('profiles')
  if (profilesAt > 0) return join(...parts.slice(0, profilesAt))
  return join(dir, '.dsh')
}

/** 本机量坐标脚本的绝对路径（仓库里不许写死账户名，按宿主给的 profile 目录派生）。 */
export function cuMeasureScriptPath(ctx?: any): string {
  return join(dshRootOf(profileDir(ctx)), 'cu-click', 'measure.ps1')
}

/**
 * 「先量后点」硬规则正文（发给 CU 模型的原文）。
 * @param measurePath - 本机量坐标脚本绝对路径（默认按 DSH_HOME 派生）。
 * @returns 规则文本；非空串，长度上限由回归断言看着。
 */
export function computerUseCoordinatePolicyText(measurePath = cuMeasureScriptPath()): string {
  return [
    'CU 坐标硬规则（动手前必照做）：',
    '1. 先量后点。click / drag / input_text / long_press 之前先在当前截图量出目标像素包围盒 x1,y1,x2,y2，中心=((x1+x2)/2,(y1+y2)/2)；不许目测估点。',
    '2. 写出算式：正文必须打出算式。千分比会话分数 = 中心像素 ÷ 截图宽或高 × 1000（x÷宽、y÷高）；像素会话直接传中心像素。',
    '3. 尺寸只认这次：宽高读当前观察面 attached_size 的实际像素，不许沿用上一轮或屏幕尺寸。',
    '4. 核对落点：click 回执 Pointer landed at [x, y] physical pixels 要落进第 1 步包围盒，没中就地重算再打，不许重复同一组坐标（drag / long_press / input_text 没这句就按这次截图重新量包围盒）。',
    '5. 同一目标连续 2 次未命中即停用坐标：改地址栏导航 URL、键盘 Tab/Enter/Space 或读页面文本链接，不许第 3 次盲点。',
    `6. 量坐标优先脚本：跑 ${measurePath} -Shot <截图> -X0 -X1 -Y0 -Y1 -Mode dark|blue|yellow|gray -Split -MinPixels，读它打印的 TOTAL bbox 与 center=(x,y) fraction=[x,y]；脚本跑不动才目测扫描，算式照写。`,
  ].join('\n')
}

/** 会话日志里有没有内嵌 computer-use 盖过的坐标模式戳（有 ⇒ 这条会话是 CU）。 */
function hasCoordinateModeStamp(session: any): boolean {
  try {
    const events = session?.snapshotEvents?.()
    if (!Array.isArray(events)) return false
    return events.some((event: any) => COORDINATE_MODE_EVENT_TYPES.includes(String(event?.type ?? '')))
  } catch {
    return false
  }
}

/**
 * 当前是不是一条 Computer Use 会话。
 *
 * 判据 = 会话 agent 预设 === 'computer-use'，读法与 src/assistant-cu-watch.ts:616-634 的
 * sessionPresetOf 同一套（宿主投影优先，header 兜底），所以新建会话（预设刚被宿主写下）
 * 和续接会话（预设早已在 header / 投影里）都认得；再加一条兜底：内嵌 computer-use 只给
 * CU 会话盖坐标模式戳（vendor/computer-use/index.js:379-405），日志里有戳也算 CU。
 * 标准会话（standard / standard-slim-local / 空预设）在这里一律判假，一段字都不多。
 * @param ctx - dsh-assistant 宿主上下文。
 * @param session - 这次装配所属的会话（context.agent.session）。
 * @returns 是否 CU 会话。
 */
export function isComputerUseSessionOf(ctx: any, session: any): boolean {
  for (const value of [
    (() => { try { return ctx?.get?.('sessionProjections')?.cachedSnapshot?.(session)?.values?.agentPreset } catch { return undefined } })(),
    (() => { try { return ctx?.get?.('sessionProjections')?.stateOf?.(session, 'agentPreset') } catch { return undefined } })(),
    (() => { try { return ctx?.get?.('sessionProjectionCache')?.cachedSnapshot?.(session?.header ?? session)?.values?.agentPreset } catch { return undefined } })(),
    session?.header?.agentPreset,
  ]) {
    if (typeof value === 'string' && value !== '') return value === CU_AGENT_PRESET
  }
  return hasCoordinateModeStamp(session)
}

/**
 * 把「先量后点」硬规则挂到 CU 会话的系统提示上（插件侧唯一的合法通道：
 * 宿主 SystemPrompt.section，见 @deepseek-ai/dsh-system-prompt 的 PromptSection 定义——
 * `text` 可以是每次装配现算的函数，装配前宿主就把它解析成 AssembledSection）。
 *
 * 覆盖新建与续接两条路：段位文本是**每次装配**现算的（不是会话创建时一次性拼死的），
 * 判据用会话预设，所以下面这两类会话都会带上这段规则。
 *
 * 兜底一层：宿主全局段注册拿不到 systemPrompt 服务时（插件 entry 的 inject 没声明它），
 * 靠瀑布监听器就地往装配载荷的 sections 里补同一条段——同一个名字，认到已经在就不重复加。
 * @param ctx - dsh-assistant 宿主上下文。
 * @param disposers - 插件卸载时要一起摘掉的清理函数。
 */
function installComputerUseCoordinatePolicy(ctx: any, disposers: Array<() => void>): void {
  // 量坐标脚本路径按宿主真实 profile 目录派生一次（每次装配重算没必要，路径是机器静态事实）。
  let measurePath = ''
  try {
    measurePath = cuMeasureScriptPath(ctx)
  } catch {
    measurePath = ''
  }
  if (typeof ctx?.on === 'function') {
    const hook = async (assembly: any, context: any, next: () => Promise<any>): Promise<any> => {
      const inner = await next()
      try {
        if (!isComputerUseSessionOf(ctx, context?.agent?.session)) return inner
        const sections = Array.isArray(inner?.sections) ? inner.sections : []
        if (sections.some((section: any) => section?.name === CU_POLICY_SECTION_NAME)) return inner
        const appended = {
          name: CU_POLICY_SECTION_NAME,
          text: computerUseCoordinatePolicyText(measurePath || undefined),
          interpolate: false,
        }
        return { ...inner, sections: [...sections, appended] }
      } catch {
        return inner
      }
    }
    try {
      const off = ctx.on('system-prompt/assemble', hook)
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      try { ctx.logger?.('dsh-assistant')?.error?.('cu coordinate policy waterfall failed: %s', String(err)) } catch {}
    }
  }

  let systemPrompt: any
  try {
    systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
  } catch {
    systemPrompt = undefined
  }
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
  try {
    const off = systemPrompt.section({
      name: CU_POLICY_SECTION_NAME,
      order: CU_POLICY_SECTION_ORDER,
      text: (context: any) => (
        isComputerUseSessionOf(ctx, context?.agent?.session)
          ? computerUseCoordinatePolicyText(measurePath || undefined)
          : ''
      ),
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('cu coordinate policy section failed: %s', String(err)) } catch {}
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
  // 「先量后点」硬规则：只往 Computer Use 会话的系统提示注入（新建与续接都覆盖）。
  installComputerUseCoordinatePolicy(ctx, disposers)
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
