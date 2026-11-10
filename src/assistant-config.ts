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
 *
 * 2026-11-05（P0-1）：新增 `POST /api/assistant/config`——白名单字段 + 类型校验 +
 * 原子写（tmp → rename）+ 写后清读缓存。设置页「个人助手 → 本机配置」走这条路由，
 * 换机的人不必再手写 JSON。字段名与语义保持不变，只**新增** updateSource /
 * updateCheckEnabled 两个字段（更新源可配置，默认不做更新检查）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { assistantHomeDir, syncPersonaSection } from './assistant-home.ts'
import { manageWebRoutes } from './web-routes.ts'
import { isTihuCloudVoice } from './tihu/cloud-voices.ts'

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

/* ─────────────────────────── 鹈鹕端（tihu） ───────────────────────────
 *
 * 2026-11-10 新增：设置 →「个人助手 → 鹈鹕端」只做三项——默认前台模型 / 默认后台模型 /
 * 默认云音色。字段放在 `tihu` 命名空间里（`tihu.model.foreground`、
 * `tihu.model.background`、`tihu.voice.edge`），落同一个 `config.json`，不另起文件、
 * 也不写 localStorage。
 *
 * 前台/后台在鹈鹕代码里的落点（lane.ts 只有这两条建会话路径）：
 *   - 前台 = 派单任务会话（`DISPATCH_PRESET` = computer-use，设备屏上跑的那条）；
 *   - 后台 = 指挥台会话（`TASK_PRESET` = standard，判项目/续聊，不占屏）。
 */

/** 一条模型选择（provider + model，可选推理档）。 */
export interface TihuModelConfig {
  provider: string
  model: string
  reasoningEffort?: string
}

/** `tihu` 段（读出来的完整形态；没配置时全是「跟随默认」）。 */
export interface TihuLocalConfig {
  model: {
    /** 默认前台模型：null = 跟随宿主默认（老行为）。 */
    foreground: TihuModelConfig | null
    /** 默认后台模型：null = 跟随宿主默认（老行为）。 */
    background: TihuModelConfig | null
  }
  voice: {
    /** 默认云音色（edge-tts 的 zh-CN-*Neural）；空串 = 跟随 TIHU_EDGE_VOICE / 云健。 */
    edge: string
  }
}

/** 一次写入的 `tihu` 子集（只带改过的子键；未出现的子键保持原值）。 */
export interface TihuConfigPatch {
  model?: {
    foreground?: TihuModelConfig | null
    background?: TihuModelConfig | null
  }
  voice?: {
    edge?: string
  }
}

/** 一份干净的 `tihu` 段（新对象，避免共享引用被就地改）。 */
export function emptyTihuConfig(): TihuLocalConfig {
  return { model: { foreground: null, background: null }, voice: { edge: '' } }
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
  /** 更新源仓库（`owner/repo`）；空 = 不做更新检查（默认）。换人安装时填自己的 fork。 */
  updateSource: string
  /** 是否允许前端检查 GitHub 更新（默认 false：别人的机器不该被作者的仓库牵着升级）。 */
  updateCheckEnabled: boolean
  /** 鹈鹕端（语音小屏）的默认模型与默认云音色。 */
  tihu: TihuLocalConfig
  /** 实际读到的文件路径（空 = 没有任何本机配置）。 */
  sourceFile: string
  /** 解析失败时的提示（不阻塞使用）。 */
  loadError: string
}

/** 下发给客户端的字段（不含宿主内部字段；设置页「本机配置」靠这些回显与编辑）。 */
export const CLIENT_CONFIG_FIELDS = [
  'newProjectParent',
  'newProjectParentSource',
  'skillRoot',
  'skillRootSource',
  'assistantHome',
  'asrTerms',
  'persona',
  'allowedRoots',
  'allowAllLocalPaths',
  'termEnvAllow',
  'updateSource',
  'updateCheckEnabled',
  'tihu',
  'configSource',
] as const

/** `POST /api/assistant/config` 接受的字段白名单（其余一律 400 unknown-field）。 */
export const WRITABLE_CONFIG_FIELDS = [
  'newProjectParent',
  'skillRoot',
  'asrTerms',
  'allowedRoots',
  'allowAllLocalPaths',
  'persona',
  'termEnvAllow',
  'updateSource',
  'updateCheckEnabled',
  'tihu',
] as const

export type WritableConfigField = (typeof WRITABLE_CONFIG_FIELDS)[number]

/** 一次写入的可写子集（只带用户真的改过的那几个键）。 */
export type AssistantConfigPatch = Partial<Pick<AssistantLocalConfig, Exclude<WritableConfigField, 'tihu'>>> & {
  /** 鹈鹕端：按子键合并，未出现的子键保持原值。 */
  tihu?: TihuConfigPatch
}

const EMPTY: AssistantLocalConfig = {
  newProjectParent: null,
  skillRoot: null,
  asrTerms: [],
  allowedRoots: [],
  allowAllLocalPaths: false,
  persona: null,
  termEnvAllow: [],
  updateSource: '',
  updateCheckEnabled: false,
  tihu: { model: { foreground: null, background: null }, voice: { edge: '' } },
  sourceFile: '',
  loadError: '',
}

/** 写入体积/条数上限（挡住误把整个项目塞进配置的调用）。 */
const MAX_BODY_BYTES = 256 * 1024
const MAX_PATH_CHARS = 4096
const MAX_ASR_TERMS = 500
const MAX_ROOTS = 200
const MAX_TERM_ENV = 100
const MAX_PERSONA_LINES = 200
const MAX_LINE_CHARS = 2000

/** 候选配置文件路径（按优先级，首个存在的即本机配置）。 */
export function assistantConfigCandidates(): string[] {
  const env = String(process.env.DSH_ASSISTANT_CONFIG ?? '').trim()
  // 显式覆盖是**权威**的：给了就只认它，不再回退到本机真实配置。
  // 否则「指定的文件不存在」时会悄悄读到用户家里的 config.json（2026-11-10 实测：
  // 设了晓晓的机器上，测试里「没配置就用云健」读到的是晓晓，默认值永远测不出来）。
  if (env) return [resolvePath(env.replace(/^~(?=$|[\\/])/, homedir()))]
  const out: string[] = []
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

/** 技能根目录：本机配置优先，否则 `<DSH_HOME>/skills`（**唯一**回落，客户端不再自己拼 `~`）。 */
export function resolveSkillRoot(cfg: AssistantLocalConfig = loadAssistantConfig()): { root: string; from: 'config' | 'dshHome' } {
  const configured = String(cfg.skillRoot ?? '').trim()
  if (configured) return { root: resolvePath(configured.replace(/^~(?=$|[\\/])/, homedir())), from: 'config' }
  return { root: join(dshHome(), 'skills'), from: 'dshHome' }
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

/** 一条模型选择：provider/model 必须都非空，否则视作「跟随默认」。 */
function normalizeTihuModel(raw: unknown): TihuModelConfig | null {
  if (!isPlainObject(raw)) return null
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return null
  const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * 读盘时的 `tihu` 段归一：任何形状错误都退成「跟随默认」，绝不因为一个坏字段让整份配置失效。
 * 云音色只认清单里的名字——本地 Kokoro（zf_/zm_/数字）即使手写进文件也当没配。
 */
function normalizeTihu(raw: unknown): TihuLocalConfig {
  const out = emptyTihuConfig()
  if (!isPlainObject(raw)) return out
  const model = isPlainObject(raw.model) ? raw.model : {}
  out.model.foreground = normalizeTihuModel(model.foreground)
  out.model.background = normalizeTihuModel(model.background)
  const voice = isPlainObject(raw.voice) ? raw.voice : {}
  const edge = typeof voice.edge === 'string' ? voice.edge.trim() : ''
  out.voice.edge = isTihuCloudVoice(edge) ? edge : ''
  return out
}

/** 写盘时的模型子键：允许 null（＝清成跟随默认）/ 合法对象；其它一律 undefined（400）。 */
function normalizeTihuModelForWrite(raw: unknown): TihuModelConfig | null | undefined {
  if (raw === null) return null
  if (!isPlainObject(raw)) return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return undefined
  if (provider.length > 200 || model.length > 200) return undefined
  if (/[\u0000-\u001f]/.test(provider) || /[\u0000-\u001f]/.test(model)) return undefined
  if (raw.reasoningEffort !== undefined && raw.reasoningEffort !== null && typeof raw.reasoningEffort !== 'string') return undefined
  const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
  if (effort.length > 64) return undefined
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * 写盘时的 `tihu` 段：只接受 `model.foreground/background` 与 `voice.edge`，其余子键一律拒
 * （拼错字段名不能静默丢改动）。空对象/没有可写子键 → undefined。
 */
function normalizeTihuForWrite(raw: unknown): TihuConfigPatch | undefined {
  if (!isPlainObject(raw)) return undefined
  const patch: TihuConfigPatch = {}
  for (const key of Object.keys(raw)) {
    if (key !== 'model' && key !== 'voice') return undefined
  }
  if ('model' in raw) {
    const model = raw.model
    if (!isPlainObject(model)) return undefined
    const next: NonNullable<TihuConfigPatch['model']> = {}
    for (const key of Object.keys(model)) {
      if (key !== 'foreground' && key !== 'background') return undefined
      const value = normalizeTihuModelForWrite(model[key])
      if (value === undefined) return undefined
      next[key as 'foreground' | 'background'] = value
    }
    patch.model = next
  }
  if ('voice' in raw) {
    const voice = raw.voice
    if (!isPlainObject(voice)) return undefined
    const next: NonNullable<TihuConfigPatch['voice']> = {}
    for (const key of Object.keys(voice)) {
      if (key !== 'edge') return undefined
      const rawEdge = voice.edge
      if (rawEdge !== null && rawEdge !== undefined && typeof rawEdge !== 'string') return undefined
      const text = typeof rawEdge === 'string' ? rawEdge.trim() : ''
      // 只允许云端音色；'' = 清掉配置（回到 TIHU_EDGE_VOICE / 云健）。
      if (text !== '' && !isTihuCloudVoice(text)) return undefined
      next.edge = text
    }
    patch.voice = next
  }
  if (Object.keys(patch).length === 0) return undefined
  return patch
}

/** 把一次 `tihu` 补丁合进已落盘的旧值：补丁里没出现的子键原样保留。 */
function mergeTihuPatch(base: unknown, patch: TihuConfigPatch): TihuLocalConfig {
  const current = normalizeTihu(base)
  const next: TihuLocalConfig = { model: { ...current.model }, voice: { ...current.voice } }
  if (patch.model !== undefined) {
    if ('foreground' in patch.model) next.model.foreground = patch.model.foreground ?? null
    if ('background' in patch.model) next.model.background = patch.model.background ?? null
  }
  if (patch.voice !== undefined && 'edge' in patch.voice) next.voice.edge = patch.voice.edge ?? ''
  return next
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
      updateSource: typeof parsed.updateSource === 'string' ? parsed.updateSource.trim() : '',
      updateCheckEnabled: parsed.updateCheckEnabled === true,
      tihu: normalizeTihu(parsed.tihu),
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
  const skill = resolveSkillRoot(cfg)
  const persona = cfg.persona
  return {
    ok: true,
    newProjectParent: resolved.parent,
    newProjectParentSource: resolved.from,
    skillRoot: skill.root,
    skillRootSource: skill.from,
    assistantHome: assistantHomeDir(),
    asrTerms: cfg.asrTerms,
    persona: persona ? { title: persona.title ?? '本机人设', lines: persona.lines ?? [] } : null,
    allowedRoots: cfg.allowedRoots,
    allowAllLocalPaths: cfg.allowAllLocalPaths,
    termEnvAllow: cfg.termEnvAllow,
    updateSource: cfg.updateSource,
    updateCheckEnabled: cfg.updateCheckEnabled,
    tihu: cfg.tihu,
    configSource: cfg.sourceFile,
    configError: cfg.loadError || undefined,
  }
}

/* ─────────────────────────── 写入面（P0-1） ─────────────────────────── */

export type ValidateResult =
  | { ok: true; patch: AssistantConfigPatch }
  | { ok: false; error: string; field?: string }

function bad(field: string, error: string): ValidateResult {
  return { ok: false, field, error }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 路径字段：允许 `~` 前缀；展开后必须是绝对路径；不允许控制字符。 */
function normalizePathField(value: unknown): string | null | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return null
  if (text.length > MAX_PATH_CHARS) return undefined
  if (/[\u0000-\u001f]/.test(text)) return undefined
  const expanded = text.replace(/^~(?=$|[\\/])/, homedir())
  return isAbsolute(expanded) ? text : undefined
}

/**
 * 校验一次写入请求（`POST /api/assistant/config` 的 body）。
 * 只接受 WRITABLE_CONFIG_FIELDS 里的键：未知键直接拒（避免拼错字段静默丢改动）。
 */
export function validateAssistantConfigPatch(raw: unknown): ValidateResult {
  if (!isPlainObject(raw)) return { ok: false, error: 'expected-object' }
  const target = isPlainObject(raw.config) ? (raw.config as Record<string, unknown>) : raw
  const patch: AssistantConfigPatch = {}
  for (const key of Object.keys(target)) {
    // config = 可选的包装层；confirm = 危险开关的确认口令（不属于配置字段，不落盘）
    if (key === 'config' || key === 'confirm') continue
    if (!(WRITABLE_CONFIG_FIELDS as readonly string[]).includes(key)) return bad(key, 'unknown-field')
  }

  if ('newProjectParent' in target) {
    const value = normalizePathField(target.newProjectParent)
    if (value === undefined) return bad('newProjectParent', 'expected-absolute-path')
    patch.newProjectParent = value
  }
  if ('skillRoot' in target) {
    const value = normalizePathField(target.skillRoot)
    if (value === undefined) return bad('skillRoot', 'expected-absolute-path')
    patch.skillRoot = value
  }
  if ('asrTerms' in target) {
    const raw_ = target.asrTerms
    if (!Array.isArray(raw_)) return bad('asrTerms', 'expected-array')
    if (raw_.length > MAX_ASR_TERMS) return bad('asrTerms', 'too-many')
    const terms: AsrTermRuleJson[] = []
    for (let i = 0; i < raw_.length; i++) {
      const item = raw_[i]
      if (!isPlainObject(item)) return bad('asrTerms', `item-${i}-expected-object`)
      const pattern = item.pattern
      const replace = item.replace
      if (typeof pattern !== 'string' || pattern === '' || pattern.length > 500) return bad('asrTerms', `item-${i}-bad-pattern`)
      if (typeof replace !== 'string' || replace === '' || replace.length > 500) return bad('asrTerms', `item-${i}-bad-replace`)
      const flags = item.flags
      if (flags !== undefined && (typeof flags !== 'string' || !/^[a-z]*$/.test(flags))) return bad('asrTerms', `item-${i}-bad-flags`)
      terms.push(flags ? { pattern, replace, flags } : { pattern, replace })
    }
    patch.asrTerms = terms
  }
  if ('allowedRoots' in target) {
    const raw_ = target.allowedRoots
    if (!Array.isArray(raw_)) return bad('allowedRoots', 'expected-array')
    if (raw_.length > MAX_ROOTS) return bad('allowedRoots', 'too-many')
    const roots: string[] = []
    for (let i = 0; i < raw_.length; i++) {
      const value = normalizePathField(raw_[i])
      if (value === undefined || value === null) return bad('allowedRoots', `item-${i}-expected-absolute-path`)
      roots.push(value)
    }
    patch.allowedRoots = roots
  }
  if ('allowAllLocalPaths' in target) {
    if (typeof target.allowAllLocalPaths !== 'boolean') return bad('allowAllLocalPaths', 'expected-boolean')
    patch.allowAllLocalPaths = target.allowAllLocalPaths
  }
  if ('persona' in target) {
    const raw_ = target.persona
    if (raw_ === null) patch.persona = null
    else {
      const persona = normalizePersonaForWrite(raw_)
      if (persona === undefined) return bad('persona', 'bad-persona')
      patch.persona = persona
    }
  }
  if ('termEnvAllow' in target) {
    const raw_ = target.termEnvAllow
    if (!Array.isArray(raw_)) return bad('termEnvAllow', 'expected-array')
    if (raw_.length > MAX_TERM_ENV) return bad('termEnvAllow', 'too-many')
    const names: string[] = []
    for (let i = 0; i < raw_.length; i++) {
      const value = raw_[i]
      if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())) return bad('termEnvAllow', `item-${i}-bad-name`)
      const name = value.trim().toUpperCase()
      if (!names.includes(name)) names.push(name)
    }
    patch.termEnvAllow = names
  }
  if ('updateSource' in target) {
    const raw_ = target.updateSource
    if (typeof raw_ !== 'string') return bad('updateSource', 'expected-string')
    const value = raw_.trim()
    if (value !== '' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return bad('updateSource', 'expected-owner-repo')
    patch.updateSource = value
  }
  if ('updateCheckEnabled' in target) {
    if (typeof target.updateCheckEnabled !== 'boolean') return bad('updateCheckEnabled', 'expected-boolean')
    patch.updateCheckEnabled = target.updateCheckEnabled
  }
  if ('tihu' in target) {
    const value = normalizeTihuForWrite(target.tihu)
    if (value === undefined) return bad('tihu', 'bad-tihu')
    patch.tihu = value
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing-to-change' }
  return { ok: true, patch }
}

function normalizePersonaForWrite(raw: unknown): AssistantPersonaJson | null | undefined {
  if (typeof raw === 'string') {
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length > MAX_PERSONA_LINES) return undefined
    if (lines.some((line) => line.length > MAX_LINE_CHARS)) return undefined
    return lines.length ? { lines } : null
  }
  if (!isPlainObject(raw)) return undefined
  const title = raw.title === undefined ? '' : raw.title
  if (typeof title !== 'string' || title.length > 200) return undefined
  const linesRaw = raw.lines === undefined ? [] : raw.lines
  if (!Array.isArray(linesRaw)) return undefined
  if (linesRaw.length > MAX_PERSONA_LINES) return undefined
  const lines: string[] = []
  for (const line of linesRaw) {
    if (typeof line !== 'string' || line.length > MAX_LINE_CHARS) return undefined
    const text = line.trim()
    if (text) lines.push(text)
  }
  if (!lines.length && !title.trim()) return null
  return { ...(title.trim() ? { title: title.trim() } : {}), ...(lines.length ? { lines } : {}) }
}

/** 本次写入应该落到哪个文件：已命中配置就改它，没有就建首选位置。 */
export function configWriteTarget(cfg: AssistantLocalConfig = loadAssistantConfig()): string {
  if (cfg.sourceFile) return cfg.sourceFile
  const env = String(process.env.DSH_ASSISTANT_CONFIG ?? '').trim()
  if (env) return resolvePath(env.replace(/^~(?=$|[\\/])/, homedir()))
  return join(assistantHomeDir(), 'config.json')
}

export type WriteResult =
  | { ok: true; file: string; config: AssistantLocalConfig }
  | { ok: false; error: string; field?: string }

/**
 * 原子写本机配置：读现有 JSON → 只覆盖 patch 里的键（其它键原样保留）→
 * 写 `<file>.<pid>.tmp`（0o600）→ rename 覆盖 → 清读缓存。
 * 写失败不动原文件（tmp 会被清掉），返回错误让路由回 500。
 */
export function writeAssistantConfig(patch: AssistantConfigPatch): WriteResult {
  if (!patch || Object.keys(patch).length === 0) return { ok: false, error: 'nothing-to-change' }
  const before = loadAssistantConfig()
  const file = configWriteTarget(before)
  let base: Record<string, unknown> = {}
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(stripBom(readFileSync(file, 'utf8')))
      if (!isPlainObject(parsed)) return { ok: false, error: 'config-not-object' }
      base = parsed
    }
  } catch (err) {
    // 文件存在但坏掉：不覆盖（用户可能正在手改），让错误显式暴露。
    return { ok: false, error: 'config-unreadable: ' + String((err as Error)?.message ?? err) }
  }

  const next: Record<string, unknown> = { ...base }
  for (const key of WRITABLE_CONFIG_FIELDS) {
    if (!(key in patch)) continue
    // tihu 按子键合并：设置页每次只发改过的那一项，不能把另外两项冲掉。
    if (key === 'tihu') {
      next.tihu = mergeTihuPatch(base.tihu, patch.tihu ?? {})
      continue
    }
    const value = (patch as Record<string, unknown>)[key]
    if (value === null || value === undefined) delete next[key]
    else next[key] = value
  }

  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* tmp 可能已不存在 */ }
    try { cache = null } catch { /* 忽略 */ }
    return { ok: false, error: 'write-failed: ' + String((err as Error)?.message ?? err) }
  }
  // 显式清缓存（别只靠 mtime：同毫秒写 + 粗粒度文件系统会让下一次读回旧值）
  cache = null
  return { ok: true, file, config: loadAssistantConfig(true) }
}

/* ─────────────────────────── 路由 ─────────────────────────── */

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  } catch { /* 客户端已断开 */ }
}

/** 读一个小 JSON body（限 256KB；超限/坏 JSON 都返回 null 由调用方回 400/413）。 */
async function readJsonBody(req: any): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status: number }> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) return { ok: false, error: 'too-large', status: 413 }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, error: 'read-failed', status: 400 }
  }
  if (size === 0) return { ok: false, error: 'empty-body', status: 400 }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, error: 'invalid-json', status: 400 }
  }
}

/**
 * 写成功后的即时生效动作（P0-5）：
 *   1) 重建目录 allowlist（path-guard 由 index.ts 提供 `assistantPathGuard` 服务）；
 *   2) 把新 persona 同步进 AGENTS.md 的托管段（不再是「只写一次」）。
 * 都失败不影响写入结果——写盘已经成功，副作用失败只打日志。
 */
function applyConfigSideEffects(ctx: any): void {
  try {
    const guard: any = ctx?.get?.('assistantPathGuard')
    if (guard && typeof guard.refresh === 'function') guard.refresh()
  } catch { /* 服务没提供（headless / 旧宿主）：下次重载生效 */ }
  try {
    if (typeof syncPersonaSection === 'function') syncPersonaSection()
  } catch (err) {
    try { ctx?.logger?.('dsh-assistant')?.warn?.('persona sync failed: %s', String(err)) } catch {}
  }
}

/**
 * 注册 `GET/POST /api/assistant/config`：
 *   GET  → 下发本机个人化配置的客户端子集；
 *   POST → 白名单字段 + 类型校验 + 原子写 + 写后清缓存 + 即时应用副作用。
 * 注意：早期版本这个 handler 不看 `req.method`，POST 也会 200 下发查询结果（静默丢改动），
 * 现在 GET/POST/405 三路分明。
 */
export function registerAssistantConfigRoutes(ctx: any): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  routes.webServer.register({
    kind: 'exact',
    path: '/api/assistant/config',
    handler: async (req: any, res: any) => {
      const method = String(req?.method ?? 'GET').toUpperCase()
      try {
        if (method === 'GET' || method === 'HEAD') {
          sendJson(res, 200, assistantConfigClientView())
          return
        }
        if (method === 'POST' || method === 'PUT') {
          const read = await readJsonBody(req)
          if (!read.ok) { sendJson(res, read.status, { ok: false, error: read.error }); return }
          const validated = validateAssistantConfigPatch(read.body)
          if (!validated.ok) {
            sendJson(res, 400, { ok: false, error: validated.error, ...(validated.field ? { field: validated.field } : {}) })
            return
          }
          // 逃生开关要求显式确认（与 memory-clear 的 DELETE-ALL 同一种做法）
          const body = read.body as Record<string, unknown>
          if (validated.patch.allowAllLocalPaths === true && body?.confirm !== 'ALLOW-ALL') {
            sendJson(res, 400, { ok: false, error: 'confirm-required', field: 'allowAllLocalPaths', hint: 'allowAllLocalPaths 需要 confirm:"ALLOW-ALL"' })
            return
          }
          const result = writeAssistantConfig(validated.patch)
          if (!result.ok) {
            sendJson(res, 500, { ok: false, error: result.error })
            return
          }
          applyConfigSideEffects(ctx)
          sendJson(res, 200, { ...assistantConfigClientView(), saved: Object.keys(validated.patch), file: result.file })
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST, PUT' })
        res.end()
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err as Error)?.message ?? err) })
      }
    },
  })
  return routes.dispose
}

/** 测试面：让 scripts/*.mjs 直接拿到解析/校验/写入函数（构建产物里也走这条出口）。 */
export const assistantConfigTestSurface = {
  assistantConfigCandidates,
  loadAssistantConfig,
  resolveNewProjectParent,
  resolveSkillRoot,
  assistantConfigClientView,
  resetAssistantConfigCacheForTests,
  platformDesktopDir,
  dshHome,
  configWriteTarget,
  validateAssistantConfigPatch,
  writeAssistantConfig,
  registerAssistantConfigRoutes,
  WRITABLE_CONFIG_FIELDS,
}
