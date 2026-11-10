/**
 * 客户端侧的本机个人化配置缓存（读走宿主 `GET /api/assistant/config`，
 * 写走 `POST /api/assistant/config`——2026-11-05 起写入链路才真的存在）。
 *
 * 为什么要有这一层：仓库里不再有 `D:\...\Desktop\...`、`C:\Users\<用户名>\...` 这类
 * 「只有本机才成立」的常量。真正可用的值来自本地配置文件
 * （`~/.dsh/assistant/config.json`，不入库），宿主读出来下发，页面缓存一份：
 *   - 首屏同步要用（新建项目默认目录、模板里的技能文件路径），所以缓存也写 localStorage，
 *     下次页面加载在请求宿主之前就先有值（离线/旧宿主时也不会变成空）。
 *   - 手机与电脑各自缓存自己的那份：值来自同一台宿主，内容相同。
 *
 * 关键约定：**技能根的回落只由宿主决定**（`<DSH_HOME>/skills`）。客户端不再自己拼
 * `~/.dsh/skills`（那是个没展开的路径，交给 agent 就读不到）；宿主没答过时一律空串，
 * 由调用方退让。
 */
import { joinPath } from './pathutil.ts'

const CONFIG_KEY = 'dsh.assistant.config.v1'
/** 未从宿主拿到配置时的技能根：空串 = 未知（不再伪造 `~/.dsh/skills`）。 */
export const DEFAULT_SKILL_ROOT = ''

export interface AsrTermRule {
  pattern: string
  replace: string
  flags?: string
}

/** 一条模型选择（鹈鹕端默认前台/后台模型用）。 */
export interface AssistantModelChoice {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 鹈鹕端（语音小屏）的三项：默认前台模型 / 默认后台模型 / 默认云音色。 */
export interface AssistantTihuConfig {
  model: {
    /** null = 跟随宿主默认模型（老行为）。 */
    foreground: AssistantModelChoice | null
    background: AssistantModelChoice | null
  }
  voice: {
    /** 云端音色 id（edge-tts 的 zh-CN-*Neural）；'' = 跟随 TIHU_EDGE_VOICE / 云健。 */
    edge: string
  }
}

export interface AssistantClientConfig {
  newProjectParent: string
  newProjectParentSource: 'config' | 'desktop' | 'assistant'
  skillRoot: string
  skillRootSource: 'config' | 'dshHome'
  assistantHome: string
  asrTerms: AsrTermRule[]
  persona: { title: string; lines: string[] } | null
  /** 目录边界（allowlist）追加根 */
  allowedRoots: string[]
  /** 逃生开关：true = 不做目录边界检查 */
  allowAllLocalPaths: boolean
  /** 终端环境变量名追加项 */
  termEnvAllow: string[]
  /** 更新源（`owner/repo`，空 = 不检查更新） */
  updateSource: string
  /** 是否允许检查 GitHub 更新（默认 false） */
  updateCheckEnabled: boolean
  /** 鹈鹕端默认模型与默认云音色（没配置时全走老默认值） */
  tihu: AssistantTihuConfig
  /** 当前实际生效的配置文件路径（空 = 没有任何本机配置） */
  configSource: string
}

function readStorage(): AssistantClientConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalize(parsed)
  } catch { return null }
}

function writeStorage(value: AssistantClientConfig | null): void {
  try {
    if (value) localStorage.setItem(CONFIG_KEY, JSON.stringify(value))
    else localStorage.removeItem(CONFIG_KEY)
  } catch { /* 隐私模式 / 配额满：不阻塞 */ }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => asString(item).trim()).filter(Boolean)
}

function normalize(raw: any): AssistantClientConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const terms = Array.isArray(raw.asrTerms)
    ? raw.asrTerms.filter((rule: any) => rule && typeof rule.pattern === 'string' && typeof rule.replace === 'string')
        .map((rule: AsrTermRule) => ({
          pattern: rule.pattern,
          replace: rule.replace,
          ...(typeof rule.flags === 'string' && rule.flags ? { flags: rule.flags } : {}),
        }))
    : []
  const persona = raw.persona && typeof raw.persona === 'object' && Array.isArray(raw.persona.lines)
    ? { title: asString(raw.persona.title, '本机人设'), lines: raw.persona.lines.map((line: unknown) => String(line ?? '')) }
    : null
  return {
    newProjectParent: asString(raw.newProjectParent).trim(),
    newProjectParentSource: raw.newProjectParentSource === 'config' || raw.newProjectParentSource === 'assistant'
      ? raw.newProjectParentSource
      : 'desktop',
    skillRoot: asString(raw.skillRoot).trim(),
    skillRootSource: raw.skillRootSource === 'config' ? 'config' : 'dshHome',
    assistantHome: asString(raw.assistantHome).trim(),
    asrTerms: terms,
    persona,
    allowedRoots: asStringList(raw.allowedRoots),
    allowAllLocalPaths: raw.allowAllLocalPaths === true,
    termEnvAllow: asStringList(raw.termEnvAllow),
    updateSource: asString(raw.updateSource).trim(),
    updateCheckEnabled: raw.updateCheckEnabled === true,
    tihu: normalizeTihu(raw.tihu),
    configSource: asString(raw.configSource).trim(),
  }
}

/** 一条模型选择的归一（provider/model 都非空才算配了）。 */
function normalizeModelChoice(raw: any): AssistantModelChoice | null {
  if (!raw || typeof raw !== 'object') return null
  const provider = asString(raw.provider).trim()
  const model = asString(raw.model).trim()
  if (!provider || !model) return null
  const effort = asString(raw.reasoningEffort).trim()
  return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
}

/** 鹈鹕端配置的归一：缺字段就退成「跟随默认」，绝不因为坏值让整份配置读不出来。 */
function normalizeTihu(raw: any): AssistantTihuConfig {
  const model = raw && typeof raw === 'object' && raw.model && typeof raw.model === 'object' ? raw.model : {}
  const voice = raw && typeof raw === 'object' && raw.voice && typeof raw.voice === 'object' ? raw.voice : {}
  return {
    model: {
      foreground: normalizeModelChoice(model.foreground),
      background: normalizeModelChoice(model.background),
    },
    voice: { edge: asString(voice.edge).trim() },
  }
}

let cached: AssistantClientConfig | null = null
let inflight: Promise<AssistantClientConfig | null> | null = null

function readCached(): AssistantClientConfig | null {
  if (cached === null) cached = readStorage()
  return cached
}

/** 同步读缓存（宿主还没答过时返回 null；调用方决定退让还是用通用回落）。 */
export function assistantConfigSync(): AssistantClientConfig | null {
  return readCached()
}

/** 测试钩子：直接塞一份配置（不必真的起宿主）。 */
export function primeAssistantConfig(value: unknown): void {
  cached = normalize(value)
  writeStorage(cached)
}

/** 向宿主要一次配置（缓存 + 并发去重；失败不缓存，下一次再试）。 */
export function loadAssistantConfig(fetchImpl: typeof fetch = fetch): Promise<AssistantClientConfig | null> {
  const have = readCached()
  if (have) return Promise.resolve(have)
  if (inflight !== null) return inflight
  inflight = fetchImpl('/api/assistant/config', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: any) => {
      const value = normalize(body)
      if (value) {
        cached = value
        writeStorage(value)
      }
      return value
    })
    .catch(() => null)
    .finally(() => { inflight = null })
  return inflight
}

/** 强制重读（面板里保存了新的本机配置以后刷新缓存）。 */
export function reloadAssistantConfig(fetchImpl?: typeof fetch): Promise<AssistantClientConfig | null> {
  cached = null
  writeStorage(null)
  return loadAssistantConfig(fetchImpl)
}

/* ─────────────── 写入（P0-1：设置页保存后回读） ─────────────── */

export interface SaveConfigResult {
  ok: boolean
  error?: string
  field?: string
  /** 保存后台实际写到的文件（宿主回报） */
  file?: string
  config?: AssistantClientConfig | null
}

/**
 * 把改动写回宿主（只发改过的字段；未知字段会被宿主 400 拒）。
 * 成功后**强制回读**：别让本机 localStorage 里那份旧缓存把新值盖回去。
 */
export async function saveAssistantConfig(
  patch: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<SaveConfigResult> {
  try {
    const response = await fetchImpl('/api/assistant/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(patch),
    })
    const body: any = await response.json().catch(() => null)
    if (!response.ok || !body || body.ok === false) {
      return { ok: false, error: asString(body?.error) || `HTTP ${response.status}`, field: asString(body?.field) || undefined }
    }
    const config = normalize(body)
    if (config) {
      cached = config
      writeStorage(config)
    } else {
      await reloadAssistantConfig(fetchImpl)
    }
    return { ok: true, file: asString(body.file) || config?.configSource || '', config: cached }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 新建项目默认父目录（未解析到就是空串，调用方按空处理）。 */
export function newProjectParentSync(): string {
  return readCached()?.newProjectParent ?? ''
}

/** 技能根目录：宿主下发什么就是什么；没答过时为空串（不再自己拼 `~`）。 */
export function skillRootSync(): string {
  return readCached()?.skillRoot ?? ''
}

/** 技能根目录的来源（用于设置页显示「当前实际生效值」的出处）。 */
export function skillRootSourceSync(): 'config' | 'dshHome' {
  return readCached()?.skillRootSource ?? 'dshHome'
}

/** 技能里的一个文件（`paper-10step/references/01-个人写作基准.md` → 绝对路径）。
 *  分隔符按 root 的风格走（Windows 根 → 反斜杠），避免模板提示词里出现混合分隔符。
 *  没有技能根时返回相对路径本身（调用方/提示词会看到"未配置"而不是一个假路径）。 */
export function skillFileOf(rel: string): string {
  const root = skillRootSync()
  const normalized = String(rel).replace(/[\\/]+/g, '/')
  if (!root) return normalized
  const sep = root.includes('\\') ? '\\' : '/'
  return joinPath(root, normalized.replace(/\//g, sep))
}

/** 助手家目录（未解析到时空串）。 */
export function assistantHomeSync(): string {
  return readCached()?.assistantHome ?? ''
}

/** 本机个人化 ASR 词表（没有就是空数组）。 */
export function asrTermsSync(): AsrTermRule[] {
  return readCached()?.asrTerms ?? []
}

/** 目录边界追加根（没有就是空数组）。 */
export function allowedRootsSync(): string[] {
  return readCached()?.allowedRoots ?? []
}

/** 全盘放行开关（默认 false）。 */
export function allowAllLocalPathsSync(): boolean {
  return readCached()?.allowAllLocalPaths === true
}

/** 更新源与更新检查开关（默认关闭）。 */
export function updateSettingsSync(): { source: string; enabled: boolean } {
  const cfg = readCached()
  return { source: cfg?.updateSource ?? '', enabled: cfg?.updateCheckEnabled === true }
}

/** 鹈鹕端默认模型与默认云音色（宿主还没答过时给「跟随默认」的空形态）。 */
export function tihuConfigSync(): AssistantTihuConfig {
  return readCached()?.tihu ?? {
    model: { foreground: null, background: null },
    voice: { edge: '' },
  }
}

/** 当前生效的配置文件路径（空 = 没有任何本机配置，全部走通用默认）。 */
export function configSourceSync(): string {
  return readCached()?.configSource ?? ''
}

/** 词典与 UI 用的显示串：未解析时给「（未配置）」而不是空串。 */
export function newProjectParentLabel(): string {
  const value = newProjectParentSync()
  return value || '（未配置：在设置里打开「本机默认项目文件夹」）'
}

export const ASSISTANT_CONFIG_KEY = CONFIG_KEY
