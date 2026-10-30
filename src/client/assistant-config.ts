/**
 * 客户端侧的本机个人化配置缓存（读 / 写回都走宿主 `/api/assistant/config`）。
 *
 * 为什么要有这一层：仓库里不再有 `D:\...\Desktop\...`、`C:\Users\<用户名>\...` 这类
 * 「只有本机才成立」的常量。真正可用的值来自本地配置文件
 * （`~/.dsh/assistant/config.json`，不入库），宿主读出来下发，页面缓存一份：
 *   - 首屏同步要用（新建项目默认目录、模板里的技能文件路径），所以缓存也写 localStorage，
 *     下次页面加载在请求宿主之前就先有值（离线/旧宿主时也不会变成空）。
 *   - 手机与电脑各自缓存自己的那份：值来自同一台宿主，内容相同。
 */
import { joinPath } from './pathutil.ts'

const CONFIG_KEY = 'dsh.assistant.config.v1'
/** 技能根目录的通用回落（无用户名、跨平台可读）。 */
export const DEFAULT_SKILL_ROOT = '~/.dsh/skills'

export interface AsrTermRule {
  pattern: string
  replace: string
  flags?: string
}

export interface AssistantClientConfig {
  newProjectParent: string
  newProjectParentSource: 'config' | 'desktop' | 'assistant'
  skillRoot: string
  assistantHome: string
  asrTerms: AsrTermRule[]
  persona: { title: string; lines: string[] } | null
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
    skillRoot: asString(raw.skillRoot).trim() || DEFAULT_SKILL_ROOT,
    assistantHome: asString(raw.assistantHome).trim(),
    asrTerms: terms,
    persona,
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

/** 新建项目默认父目录（未解析到就是空串，调用方按空处理）。 */
export function newProjectParentSync(): string {
  return readCached()?.newProjectParent ?? ''
}

/** 技能根目录：本机配置优先，否则通用回落 `~/.dsh/skills`。 */
export function skillRootSync(): string {
  return readCached()?.skillRoot || DEFAULT_SKILL_ROOT
}

/** 技能里的一个文件（`paper-10step/references/01-个人写作基准.md` → 绝对路径或 ~ 形式）。
 *  分隔符按 root 的风格走（Windows 根 → 反斜杠），避免模板提示词里出现混合分隔符。 */
export function skillFileOf(rel: string): string {
  const root = skillRootSync()
  const sep = root.includes('\\') ? '\\' : '/'
  return joinPath(root, String(rel).replace(/[\\/]+/g, sep))
}

/** 助手家目录（未解析到时空串）。 */
export function assistantHomeSync(): string {
  return readCached()?.assistantHome ?? ''
}

/** 本机个人化 ASR 词表（没有就是空数组）。 */
export function asrTermsSync(): AsrTermRule[] {
  return readCached()?.asrTerms ?? []
}

/** 词典与 UI 用的显示串：未解析时给「（未配置）」而不是空串。 */
export function newProjectParentLabel(): string {
  const value = newProjectParentSync()
  return value || '（未配置：在设置里打开「本机默认项目文件夹」）'
}

export const ASSISTANT_CONFIG_KEY = CONFIG_KEY
