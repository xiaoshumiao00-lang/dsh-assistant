/**
 * 本机个人化配置（**不入库**）：把「只有这一台机器才正确的值」从仓库常量里搬出来。
 *
 * 仓库里只保留通用默认（null / 平台 Desktop / 助手目录），个人目录、人名词表、
 * 目录 allowlist 追加项全部落在这个本地 JSON 里：
 *
 *   ~/.dsh/assistant/config.json            （首选，助手家目录下的配置文件）
 *   <DSH_HOME>/dsh-assistant-config.json     （兼容旧位置）
 *   $DSH_ASSISTANT_CONFIG                    （显式覆盖，测试与换机都用它）
 *
 * 客户端与宿主共用同一份：宿主把它读出来，`GET /api/assistant/config` 下发一个
 * 「客户端子集」（见 CLIENT_CONFIG_FIELDS），页面缓存到 localStorage。
 * 所以改本机默认值只需要改这个 JSON 文件，不用改代码、不用重新构建。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { assistantHomeDir } from './assistant-home.ts'
import { manageWebRoutes } from './web-routes.ts'

/** 一条语音转写术语规则（JSON 里没有 RegExp，只有源串）。 */
export interface AsrTermRuleJson {
  pattern: string
  replace: string
  /** 正则标志位，默认 "g"（大小写不敏感请写 "gi"） */
  flags?: string
}

/** 助手 AGENTS.md 的本机人设注入段（缺失时只留「热记忆已注入」的通用说法）。 */
export interface AssistantPersonaJson {
  /** 小节标题（默认「本机人设」） */
  title?: string
  /** 逐行文本，原样写进 AGENTS.md 的受控小节里 */
  lines?: string[]
}

/** 本地配置文件形态（全部字段可选）。 */
export interface AssistantLocalConfig {
  /** 新建项目的默认父目录；未配置时宿主按「平台 Desktop → 助手目录」回落。 */
  newProjectParent: string | null
  /** 技能根目录（paper-10step 等技能文件的前缀）；未配置时按 <DSH_HOME>/skills。 */
  skillRoot: string | null
  /** 个人化 ASR 词表（人名 / 校院名 / 业务名）；仓库默认留空。 */
  asrTerms: AsrTermRuleJson[]
  /** 目录 allowlist 的追加项（P0-5 的 /api/worktable/* 根边界）。 */
  allowedRoots: string[]
  /** 逃生开关：true 时 /api/worktable/* 不做目录边界检查（默认 false）。 */
  allowAllLocalPaths: boolean
  /** AGENTS.md 的本机人设注入段。 */
  persona: AssistantPersonaJson | null
  /** 终端最小环境变量名追加项。 */
  termEnvAllow: string[]
  /** 实际读到的文件路径（空 = 没有任何本机配置）。 */
  sourceFile: string
  /** 解析失败时的提示（不阻塞使用）。 */
  loadError: string
}

/** 下发给客户端的字段（不给宿主内部路径与 allowlist，减少对外暴露的面）。 */
export const CLIENT_CONFIG_FIELDS = [
  'newProjectParent',
  'newProjectParentSource',
  'skillRoot',
  'assistantHome',
  'asrTerms',
  'persona',
] as const

const EMPTY: AssistantLocalConfig = {
  newProjectParent: null,
  skillRoot: null,
  asrTerms: [],
  allowedRoots: [],
  allowAllLocalPaths: false,
  persona: null,
  termEnvAllow: [],
  sourceFile: '',
  loadError: '',
}

/** 候选配置文件路径（按优先级，首个存在的即本机配置）。 */
export function assistantConfigCandidates(): string[] {
  const out: string[] = []
  const env = String(process.env.DSH_ASSISTANT_CONFIG ?? '').trim()
  if (env) out.push(resolvePath(env.replace(/^~(?=$|[\\/])/, homedir())))
  out.push(join(assistantHomeDir(), 'config.json'))
  const home = dshHome()
  out.push(join(home, 'dsh-assistant-config.json'))
  out.push(join(home, 'assistant', 'dsh-assistant-config.json'))
  return out
}

/** DSH 数据根目录（DSH_HOME 优先，否则 ~/.dsh）——与官方 resolveDshHome 同规则。 */
export function dshHome(): string {
  const env = process.env.DSH_HOME
  const value = env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh')
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolvePath(homedir(), value.slice(2))
  return resolvePath(value)
}

/** 平台 Desktop 目录（Windows 上可能是重定向后的目录）；不存在时返回 null。 */
export function platformDesktopDir(): string | null {
  const names = ['Desktop', '桌面']
  for (const name of names) {
    for (const base of [homedir(), process.env.USERPROFILE ?? '', process.env.OneDrive ?? '']) {
      if (!base) continue
      const candidate = join(base, name)
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) return resolvePath(candidate)
      } catch { /* 不可读就当没有 */ }
    }
  }
  return null
}

/** 新建项目默认父目录的解析结果：`from` 用来在 UI 里说清「这个值是从哪来的」。 */
export interface ResolvedNewProjectParent {
  parent: string
  from: 'config' | 'desktop' | 'assistant'
}

/**
 * 未配置时的回落：平台 Desktop → 助手目录下的 `projects/`。
 * 助手目录本身只放记忆资产（AGENTS.md/journal/notes/outputs），所以回落再套一层 projects/。
 */
export function resolveNewProjectParent(cfg: AssistantLocalConfig = loadAssistantConfig()): ResolvedNewProjectParent {
  const configured = String(cfg.newProjectParent ?? '').trim()
  if (configured) return { parent: resolvePath(configured.replace(/^~(?=$|[\\/])/, homedir())), from: 'config' }
  const desktop = platformDesktopDir()
  if (desktop) return { parent: desktop, from: 'desktop' }
  return { parent: join(assistantHomeDir(), 'projects'), from: 'assistant' }
}

function normalizeRules(raw: unknown): AsrTermRuleJson[] {
  if (!Array.isArray(raw)) return []
  const out: AsrTermRuleJson[] = []
  for (const item of raw) {
    // 允许简写：["示例昵称|示例昵称写错", "示例规范名"]
    if (Array.isArray(item) && item.length >= 2) {
      const pattern = String(item[0] ?? '')
      const replace = String(item[1] ?? '')
      if (pattern && replace) out.push({ pattern, replace })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const pattern = String(record.pattern ?? '')
    const replace = String(record.replace ?? '')
    if (!pattern || !replace) continue
    const flags = typeof record.flags === 'string' ? record.flags : undefined
    out.push(flags ? { pattern, replace, flags } : { pattern, replace })
  }
  return out
}

function normalizeRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const text = String(item ?? '').trim()
    if (!text) continue
    out.push(resolvePath(text.replace(/^~(?=$|[\\/])/, homedir())))
  }
  return out
}

function normalizePersona(raw: unknown): AssistantPersonaJson | null {
  if (typeof raw === 'string') {
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return lines.length ? { lines } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const lines = Array.isArray(record.lines)
    ? record.lines.map((line) => String(line ?? '')).filter((line) => line.trim() !== '')
    : []
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  if (!lines.length && !title) return null
  return { ...(title ? { title } : {}), ...(lines.length ? { lines } : {}) }
}

/** 剥掉 UTF-8 BOM：外部工具改写配置文件时会带上 BOM，JSON.parse 会因此抛错。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/** 配置文件缓存（按 mtime 失效）。测试改文件后无需重启进程。 */
let cache: { file: string; mtimeMs: number; value: AssistantLocalConfig } | null = null

/** 读本地配置（没有文件 / 解析失败都返回通用默认，不阻塞助手）。 */
export function loadAssistantConfig(force = false): AssistantLocalConfig {
  const candidates = assistantConfigCandidates()
  const file = candidates.find((path) => {
    try { return existsSync(path) && statSync(path).isFile() } catch { return false }
  }) ?? ''
  if (!file) {
    cache = null
    return { ...EMPTY }
  }
  let mtimeMs = 0
  try { mtimeMs = statSync(file).mtimeMs } catch { /* 读不到 mtime 就每次重读 */ }
  if (!force && cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.value
  let value: AssistantLocalConfig = { ...EMPTY, sourceFile: file }
  try {
    const raw = JSON.parse(stripBom(readFileSync(file, 'utf8'))) as Record<string, unknown>
    const parsed = raw && typeof raw === 'object' ? raw : {}
    const newProjectParent = typeof parsed.newProjectParent === 'string' ? parsed.newProjectParent.trim() : ''
    const skillRoot = typeof parsed.skillRoot === 'string' ? parsed.skillRoot.trim() : ''
    value = {
      newProjectParent: newProjectParent || null,
      skillRoot: skillRoot || null,
      asrTerms: normalizeRules(parsed.asrTerms),
      allowedRoots: normalizeRoots(parsed.allowedRoots ?? parsed.extraRoots),
      allowAllLocalPaths: parsed.allowAllLocalPaths === true,
      persona: normalizePersona(parsed.persona ?? parsed.personaLines),
      termEnvAllow: Array.isArray(parsed.termEnvAllow)
        ? parsed.termEnvAllow.map((name) => String(name ?? '').trim()).filter(Boolean)
        : [],
      sourceFile: file,
      loadError: '',
    }
  } catch (err) {
    value = { ...EMPTY, sourceFile: file, loadError: String((err as Error)?.message ?? err) }
  }
  cache = { file, mtimeMs, value }
  return value
}

/** 测试钩子：强制下一次读取重新解析（改过配置文件后调用）。 */
export function resetAssistantConfigCacheForTests(): void {
  cache = null
}

/** 客户端要用的配置子集（宿主 → 页面）。 */
export function assistantConfigClientView(): Record<string, unknown> {
  const cfg = loadAssistantConfig()
  const resolved = resolveNewProjectParent(cfg)
  const persona = cfg.persona
  return {
    ok: true,
    newProjectParent: resolved.parent,
    newProjectParentSource: resolved.from,
    skillRoot: cfg.skillRoot || join(dshHome(), 'skills'),
    assistantHome: assistantHomeDir(),
    asrTerms: cfg.asrTerms,
    persona: persona ? { title: persona.title ?? '本机人设', lines: persona.lines ?? [] } : null,
    configError: cfg.loadError || undefined,
  }
}

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  } catch { /* 客户端已断开 */ }
}

/**
 * 注册 `GET /api/assistant/config`：下发本机个人化配置的客户端子集。
 * 需要重启 DSH Desktop 才生效（宿主路由）。
 */
export function registerAssistantConfigRoutes(ctx: any): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  routes.webServer.register({
    kind: 'exact',
    path: '/api/assistant/config',
    handler: (req: any, res: any) => {
      try {
        sendJson(res, 200, assistantConfigClientView())
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err as Error)?.message ?? err) })
      }
    },
  })
  return routes.dispose
}

/** 测试面：让 scripts/*.mjs 直接拿到解析函数（构建产物里也走这条出口）。 */
export const assistantConfigTestSurface = {
  assistantConfigCandidates,
  loadAssistantConfig,
  resolveNewProjectParent,
  assistantConfigClientView,
  resetAssistantConfigCacheForTests,
  platformDesktopDir,
  dshHome,
}
