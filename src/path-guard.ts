/**
 * 目录边界（P0-5）：工作台的内容窗数据路由（列目录 / 读写文件 / git 状态 / 静态托管 /
 * 打开文件夹 / 技能清单）之前对任何可写路径都照单全收——手机访问（局域网或 SSH 隧道）
 * 能把插件的这几条路由当「本机文件浏览器」用，越界读别的用户目录、写系统路径都可行。
 * 这里把入参路径收进一份 allowlist，越界一律 403。
 *
 * 默认根（本机行为不变，只是把范围讲清楚）：
 *   - 助手目录            ~/.dsh/assistant
 *   - DSH 数据根目录       $DSH_HOME（默认 ~/.dsh）
 *   - 平台 Desktop 目录    （Windows 上常是重定向后的桌面）
 *   - 新建项目的默认父目录  本机配置里的 newProjectParent（未配置即回落目标）
 *   - 技能根目录           本机配置里的 skillRoot（未配置即 <DSH_HOME>/skills）
 *   - 系统临时目录 / 插件仓库 cwd
 *   - 用户主目录本身       （插件与宿主跑在同一用户下，浏览器能看到自己家目录不算越界）
 *   - 本机配置 allowedRoots 追加的根（例如某个独立盘的项目分组）
 * 逃生开关：本机配置 `allowAllLocalPaths: true` 时不做边界检查（默认 false）。
 *
 * 2026-11-05（P0-5）：allowlist 不再是「apply 时的一次性快照」——`check()` 每次请求都
 * 重新读一次本机配置（loadAssistantConfig 按 mtime 缓存，代价是一次 stat），所以设置页
 * 保存 allowedRoots / allowAllLocalPaths 之后**立即生效**，不必重载插件或重启。
 */
import { homedir, tmpdir } from 'node:os'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { assistantHomeDir } from './assistant-home.ts'
import { dshHome, loadAssistantConfig, platformDesktopDir, resolveNewProjectParent, type AssistantLocalConfig } from './assistant-config.ts'

export interface PathCheckResult {
  ok: boolean
  /** 越界时的说明（进 403 的响应与日志，便于排查是哪个根没配） */
  reason: string
  /** 归一化后的目标绝对路径 */
  target: string
}

export interface PathGuard {
  roots: string[]
  /** 全局放行（本机配置 allowAllLocalPaths: true） */
  open: boolean
  /** 强制重读本机配置（写入配置后调用；read 时机与 check 一致） */
  refresh(): void
  check(rawPath: string): PathCheckResult
}

/** `~` / `~\` / `~/` 展开为用户主目录。 */
export function expandHome(raw: string): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (value === '~') return homedir()
  if (value === '~\\' || value === '~/') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolvePath(homedir(), value.slice(2))
  return value
}

/** 比较用的归一化：统一分隔符、去掉尾部分隔符、Windows 上不区分大小写。 */
function comparable(raw: string): string {
  let value = String(raw).replace(/[\\/]+/g, '/')
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  if (process.platform === 'win32') value = value.toLowerCase()
  return value
}

/** 符号链接 / junction 是否落回允许根（真实路径也算候选）。 */
function realCandidates(abs: string): string[] {
  const out: string[] = [abs]
  try {
    const real = realpathSync(abs)
    if (real && real !== abs) out.push(real)
  } catch { /* 目标不存在时 realpath 抛错：用原路径判断即可 */ }
  return out
}

/** 允许根列表（去重、去掉不存在且明显是占位的项）。 */
export function defaultAllowedRoots(config: AssistantLocalConfig = loadAssistantConfig()): string[] {
  const roots: string[] = []
  const push = (raw: string | null | undefined): void => {
    const value = String(raw ?? '').trim()
    if (!value) return
    roots.push(resolvePath(expandHome(value)))
  }
  push(assistantHomeDir())
  push(dirname(assistantHomeDir())) // ~/.dsh
  push(dshHome())
  push(platformDesktopDir())
  push(resolveNewProjectParent(config).parent)
  push(config.skillRoot)
  push(tmpdir())
  push(process.cwd())
  push(homedir())
  for (const extra of config.allowedRoots) push(extra)
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    const key = comparable(root)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/**
 * 目录 allowlist 的执行体。
 * @param config 省略时按磁盘/环境解析；调用方传入时视为「固定配置」（测试用，不再自动重读）。
 */
export function createPathGuard(config?: AssistantLocalConfig): PathGuard {
  const pinned = config !== undefined
  let state: AssistantLocalConfig = config ?? loadAssistantConfig(true)

  const sync = (force: boolean): void => {
    if (pinned && !force) return
    try { state = loadAssistantConfig(force) } catch { /* 读失败就沿用上一份 */ }
  }

  return {
    get roots(): string[] { return defaultAllowedRoots(state) },
    get open(): boolean { return state.allowAllLocalPaths === true },
    refresh(): void { sync(true) },
    check(rawPath: string): PathCheckResult {
      // 每次请求同步一次配置：设置页改完 allowedRoots / allowAllLocalPaths 立即生效（P0-5）。
      sync(false)
      const raw = String(rawPath ?? '').trim()
      if (!raw) return { ok: false, reason: 'empty-path', target: '' }
      const abs = resolvePath(expandHome(raw))
      if (state.allowAllLocalPaths === true) return { ok: true, reason: 'allow-all', target: abs }
      const roots = defaultAllowedRoots(state)
      const candidates = realCandidates(abs)
      // 允许根本身、根内文件、以及「被某个允许根包含」的符号链接目标
      for (const candidate of candidates) {
        const value = comparable(candidate)
        for (const root of roots) {
          const base = comparable(root)
          if (!base) continue
          if (value === base || value.startsWith(base + '/')) return { ok: true, reason: '', target: abs }
        }
      }
      // 越界：把差哪个根写进日志，用户加一条 allowedRoots 就能放行
      return { ok: false, reason: `outside-allowlist: ${abs}`, target: abs }
    },
  }
}

/** 是否存在且是可读目录（越界检查之后顺手把不存在的路径当拒绝处理）。 */
export function isDirectory(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** 终端最小环境变量（P0-5）：不再整包 process.env 交给 shell。
 *  默认白名单只放 shell 与 Windows 必需项，其余一律不传；本机配置 termEnvAllow 追加变量名。 */
const TERM_ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'windir',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'HOMDRIVE', 'HOMEPATH',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'LANG', 'LC_ALL', 'TERM',
  'SHELL', 'NODE_VERSION', 'COLUMNS', 'PYTHONPATH',
]

export function minimalTermEnv(config: AssistantLocalConfig = loadAssistantConfig(), extraNames: string[] = []): Record<string, string> {
  const allow = new Set<string>([...TERM_ENV_ALLOW, ...config.termEnvAllow, ...extraNames].map((name) => String(name).trim().toUpperCase()).filter(Boolean))
  const out: Record<string, string> = {}
  for (const name of allow) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return out
}
