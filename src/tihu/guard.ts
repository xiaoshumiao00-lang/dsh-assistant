/**
 * 鹈鹕（tihu）三道闸的最小版：写前快照 / 审计 / 危险动作确认。
 *
 * 三件事都必须发生在**宿主侧**而不是页面里——页面可以被关掉、可以被伪造，
 * 只有宿主里的 `tools/pre-execute` 拦得住真正要落盘的那一次调用：
 *
 *   1. 写前快照：任何 write / edit / delete 的目标，在动手之前先复制到
 *      `<工作区>/.tihu/snapshots/<时间戳>/<相对路径>`。删掉/改坏能捞回来。
 *   2. 审计：每次动手往 `<工作区>/.tihu/audit.jsonl` 追加一行（时间 / 来源=tihu /
 *      动作 / 目标 / 决策 / diff 摘要）。JSONL 便于 grep，也便于以后接日志分析。
 *   3. 危险动作**不弹设备**：删除、覆盖已有文件、执行命令、对外发送只写审计，
 *      授权交给电脑端（宿主 approval/request；托管开着时由托管自动应答）。
 *      设备屏永不显示命令行与授权请求（2026-11-09 用户实机反馈）。
 *
 * 本文件不依赖 cordis / WebSocket，纯函数 + 文件系统，`scripts/test-tihu-guard.mjs`
 * 可以直接 import 来跑。
 */
import { appendFileSync, existsSync, mkdirSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

/** 工作区内的状态目录（固定 .tihu）。 */
export const TIHU_DIR = '.tihu'
/** 快照子目录。 */
export const SNAPSHOTS_DIR = 'snapshots'
/** 审计文件名。 */
export const AUDIT_FILE = 'audit.jsonl'

/* ---------- 动作分类 ---------- */

/** 工具调用被怎么归类：决定要不要快照、要不要确认。 */
export type TihuActionKind = 'write' | 'edit' | 'delete' | 'shell' | 'send' | 'other'

export interface TihuActionClass {
  kind: TihuActionKind
  /** 会不会动文件（需要快照 + 审计）。 */
  touchesFiles: boolean
  /** 是不是危险动作（需要设备确认）。 */
  dangerous: boolean
  /** 给屏上显示的中文动作名。 */
  label: string
}

/** 工具名 → 动作分类。只按名字判定，P1 再按参数细化（比如 rm -rf）。 */
const TOOL_PATTERNS: Array<{ re: RegExp; kind: TihuActionKind; label: string }> = [
  { re: /^(write|write_file|create_file|create)$/i, kind: 'write', label: '写文件' },
  { re: /^(edit|edit_file|multi_edit|apply_patch|str_replace|str_replace_editor|replace)$/i, kind: 'edit', label: '改文件' },
  { re: /^(delete|delete_file|remove|rm|move|rename|unlink)$/i, kind: 'delete', label: '删除/移动' },
  { re: /^(shell|bash|sh|pwsh|powershell|cmd|terminal|exec|execute|run|run_command|run_code)$/i, kind: 'shell', label: '执行命令' },
  { re: /^(send|send_email|email|mail|upload|post|publish|notify)$/i, kind: 'send', label: '对外发送' },
]

/* ---------- 只读命令识别（2026-11-06 P0 修复） ---------- */

/**
 * **危险 token**：命令里只要出现一个，就直接判危险（保守优先）。
 *
 * 为什么用「黑名单 + 白名单动词」两层：
 *   - 只看命令名字（旧实现）会把 `pwsh Get-ChildItem` 也算危险——DSH 的 shell
 *     只有一个工具名 `pwsh`，按名字判定等于「所有命令都危险」，用户被语音注入后
 *     连只读查看都要设备确认，设备不在线就 60 秒超时失败（P0 事故）；
 *   - 只按首动词白名单又太松（`curl -o x`、`Get-ChildItem | Out-File` 都能写盘），
 *     所以任何写/删/发送/提权的 token 出现即否决。
 *
 * 宁可误判危险，不可漏判：白名单只放「确实不落盘、不对外发送」的动词。
 */
const DANGEROUS_TOKENS = new RegExp(
  [
    // 写 / 删 / 移动 / 改名（只用不含糊的全名 + 无歧义的别名；
    // 像 md/ri/ni 这种两字母别名会和 `.md` 文件名、路径撞车，不收）
    String.raw`\b(rm|rmdir|del|erase|unlink|Remove-Item|Move-Item|mv|move|Rename-Item|ren|rename)\b`,
    String.raw`\b(New-Item|mkdir|Set-Content|Add-Content|Clear-Content|Out-File|Tee-Object|tee|Copy-Item|xcopy|robocopy)\b`,
    // 重定向（含 PowerShell 的 *>）
    String.raw`(^|[^|])\s?>>?\s*[^\s|]`,
    String.raw`\*\s?>>?`,
    // 进程 / 系统状态
    String.raw`\b(Stop-Process|Start-Process|taskkill|kill|shutdown|restart|Format-Volume|Format-Disk|reg\s+(add|delete|import)|schtasks|Set-Service|Stop-Service|Start-Service)\b`,
    // 提权 / 执行任意代码
    String.raw`\b(sudo|runas|chmod|chown|Invoke-Expression|iex|Start-Job|npx)\b`,
    // 包管理（会落盘、会联网）
    String.raw`\b(pip|conda|apt|apt-get|yum|dnf|brew|winget|choco|Install-Module|Install-Package|Uninstall-)\b`,
    // 对外发送 / 下载落盘
    String.raw`\b(git\s+(push|commit|reset|clean|checkout|switch|merge|rebase|stash|apply|rm|mv|tag\s+-d|init|clone))\b`,
    String.raw`\b(npm\s+(i|install|uninstall|publish|ci|update)|pnpm\s+(add|install|remove|publish|update)|yarn\s+(add|install|publish))\b`,
    String.raw`\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*?(\s-o\s|\s-O\s|--output|\s-d\s|--data|\s-F\s|--form|-Method\s+(POST|PUT|DELETE|PATCH)|-X\s*(POST|PUT|DELETE|PATCH)|\s-T\s|--upload-file)`,
    String.raw`\b(scp|sftp|ssh|rsync|ftp|telnet)\b`,
  ].join('|'),
  'i',
)

/** 只读动词白名单（取命令段首 token，去路径与扩展名后比对）。 */
const READ_ONLY_VERBS = new Set([
  'ls', 'dir', 'get-childitem', 'gci', 'pwd', 'get-location', 'cd', 'chdir', 'pushd', 'popd',
  'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'more', 'less', 'bat',
  'grep', 'rg', 'select-string', 'sls', 'findstr', 'find',
  'wc', 'sort', 'uniq', 'diff', 'cmp', 'tree', 'stat', 'du', 'df',
  'echo', 'write-output', 'write-host', 'format-table', 'format-list', 'ft', 'fl',
  'select-object', 'select', 'where-object', 'where', 'foreach-object', 'measure-object', 'measure',
  'convertfrom-json', 'convertto-json', 'out-string', 'get-help', 'help', 'man',
  'test-path', 'get-item', 'get-itemproperty', 'get-filehash', 'resolve-path', 'split-path', 'join-path',
  'git', 'node', 'npm', 'pnpm', 'python', 'py', 'jq',
  'where', 'which', 'get-command', 'gcm', 'whoami', 'hostname', 'ver', 'uname',
  'get-process', 'ps', 'get-service', 'get-date', 'get-childitem', 'ipconfig', 'systeminfo', 'nslookup', 'ping',
  'curl', 'wget', 'get-netstat', 'netstat', 'net', 'ls-files',
])

/** `git` 只读子命令（其余一律危险）。 */
const GIT_READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame',
  'describe', 'shortlog', 'reflog', 'config', 'tag', 'stash', 'help', 'version', 'whatchanged',
])

/** 去掉路径前缀与 .exe/.cmd/.ps1 扩展名，得到动词。 */
function verbOf(token: string): string {
  const cleaned = String(token ?? '').replace(/^["']|["']$/g, '')
  const base = cleaned.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase()
}

/** 单个命令段是否只读。 */
function isReadOnlySegment(segment: string): boolean {
  // 去掉环境变量赋值前缀：FOO=bar npm ls
  let text = segment.trim()
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(text)) text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
  if (text === '') return true
  const tokens = text.split(/\s+/)
  const verb = verbOf(tokens[0])
  if (!READ_ONLY_VERBS.has(verb)) return false
  // git / npm / node / python 这几个能改状态的，进一步看子命令或参数
  if (verb === 'git') {
    const sub = String(tokens[1] ?? '').toLowerCase()
    if (sub === '') return true
    if (!GIT_READ_ONLY.has(sub)) return false
    // git config 只有读（--get / --list）算只读
    if (sub === 'config') return tokens.some((t) => /^(--get|--get-all|--list|-l)$/i.test(t))
    // git tag -d / git branch -D 会改
    if (sub === 'tag' || sub === 'branch') return !tokens.some((t) => /^-(d|D|m|M|f|u)$/.test(t))
    return true
  }
  if (verb === 'npm' || verb === 'pnpm') {
    // `npm run build` 会执行项目脚本（任意代码），不算只读；`npm ls / view` 才放行。
    const sub = String(tokens[1] ?? '').toLowerCase()
    return ['ls', 'list', 'view', 'v', '--version', '-v', 'why', 'root', 'bin'].includes(sub)
  }
  if (verb === 'node' || verb === 'python' || verb === 'py') {
    // -e / -c / 直接跟脚本 = 执行任意代码
    if (tokens.some((t) => /^(-e|-c|--eval|--exec)$/i.test(t))) return false
    return tokens.length === 2 && /^(-v|--version|-V)$/i.test(tokens[1])
  }
  if (verb === 'curl' || verb === 'wget') {
    // 只读探测：不能带 -o/-O/-d/--data/-F/-T/-X POST（上面 token 已拦，这里再兜一层）
    return !tokens.some((t) => /^(-o|-O|-d|-F|-T|-X|--output|--data|--form|--upload-file|--request)$/i.test(t))
  }
  return true
}

/**
 * 一条 shell 命令是否**只读**（不落盘、不删、不对外发送、不改状态）。
 *
 * 保守策略：任何不确定 → false（判危险，交给人确认）。
 */
export function isReadOnlyCommand(command: string): boolean {
  const text = String(command ?? '').trim()
  if (text === '') return false
  if (DANGEROUS_TOKENS.test(text)) return false
  const segments = text.split(/;|&&|\|\||\||\r?\n/).map((s) => s.trim()).filter((s) => s !== '')
  if (segments.length === 0) return false
  return segments.every(isReadOnlySegment)
}

/**
 * 分类一个工具调用。
 *
 * 危险判定（2026-11-06 P0 修复后的口径，写死在注释里便于以后核对）：
 *   - delete / send：一律危险；
 *   - shell：**看命令本身**——只读命令（ls/dir/Get-ChildItem/grep/git status|diff|log/
 *     只读 curl/探测）放行；写、删、提权、发请求、跑脚本一律危险。
 *     命令拿不到（参数结构变了）→ 仍然危险（fail closed）。
 *   - write / edit：目标文件**已存在**才算「覆盖」，才危险（新建文件只快照）；
 *   - 其它工具：不碰文件、不拦。
 */
export function classifyTool(name: string, targetExists?: boolean, command?: string): TihuActionClass {
  const raw = String(name ?? '')
  for (const pattern of TOOL_PATTERNS) {
    if (!pattern.re.test(raw)) continue
    const touchesFiles = pattern.kind === 'write' || pattern.kind === 'edit' || pattern.kind === 'delete'
    const dangerous = pattern.kind === 'delete' || pattern.kind === 'send'
      || (pattern.kind === 'shell' && !isReadOnlyCommand(String(command ?? '')))
      || ((pattern.kind === 'write' || pattern.kind === 'edit') && targetExists === true)
    return { kind: pattern.kind, touchesFiles, dangerous, label: pattern.label }
  }
  return { kind: 'other', touchesFiles: false, dangerous: false, label: '其它' }
}

/** 从工具参数里挑出文件路径（不同工具用 path / file_path / filePath）。 */
export function targetPathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** 从 shell 类参数里取命令原文（只用于确认弹窗与审计，不执行）。 */
export function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script', 'code', 'input']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return String(value).slice(0, 500)
  }
  return undefined
}

/* ---------- 路径与工作区 ---------- */

/**
 * 把目标路径规整成「工作区内相对路径」。越界（绝对路径跑到工作区外、
 * `../` 跑出去）返回 null——快照绝不能把工作区外的文件复制进来。
 */
export function relativeInsideRoot(root: string, target: string): string | null {
  if (typeof root !== 'string' || root === '' || typeof target !== 'string' || target === '') return null
  const absolute = isAbsolute(target) ? target : resolvePath(root, target)
  const rel = relative(resolvePath(root), resolvePath(absolute))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** 工作区里的 `.tihu` 目录（不存在就建）。 */
export function tihuDirOf(workspace: string): string {
  const dir = join(workspace, TIHU_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ---------- 写前快照 ---------- */

export interface SnapshotResult {
  /** 是否真的复制了（目标不存在时 false，但仍会建目录）。 */
  copied: boolean
  /** 快照根目录（.tihu/snapshots/<ts>）。 */
  snapshotRoot: string
  /** 这份文件的快照路径（目标不存在时为 undefined）。 */
  snapshotPath?: string
  /** 目标在工作区内的相对路径。 */
  relativePath?: string
  /** 目标原本是否存在（用于判断「覆盖」）。 */
  existed: boolean
  /** 原文件字节数。 */
  size?: number
  /** 失败原因（越界 / 读不到）。 */
  reason?: string
}

/**
 * 写前快照：把 `target` 复制到 `<workspace>/.tihu/snapshots/<ts>/<相对路径>`。
 *
 * @param workspace - 会话工作区根目录
 * @param target - 工具要写的文件（相对或绝对）
 * @param stamp - 时间戳目录名（默认 `YYYYMMDD-HHmmss-SSS`，测试里可传入固定值）
 */
export function takeSnapshot(workspace: string, target: string, stamp?: string): SnapshotResult {
  const snapshotRoot = join(tihuDirOf(workspace), SNAPSHOTS_DIR, stamp ?? timestampSlug())
  const rel = relativeInsideRoot(workspace, target)
  if (rel === null) {
    return { copied: false, snapshotRoot, existed: false, reason: 'outside-workspace' }
  }
  const source = join(workspace, rel)
  if (!existsSync(source)) {
    return { copied: false, snapshotRoot, relativePath: rel, existed: false, reason: 'not-found' }
  }
  try {
    const info = statSync(source)
    if (!info.isFile()) {
      return { copied: false, snapshotRoot, relativePath: rel, existed: true, reason: 'not-a-file' }
    }
    const destination = join(snapshotRoot, rel)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    return { copied: true, snapshotRoot, snapshotPath: destination, relativePath: rel, existed: true, size: info.size }
  } catch (error) {
    return { copied: false, snapshotRoot, relativePath: rel, existed: true, reason: (error as Error)?.message ?? String(error) }
  }
}

/** 时间戳目录名：本地时间，`YYYYMMDD-HHmmss-SSS`（可排序、无冒号，Windows 安全）。 */
export function timestampSlug(date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`
}

/* ---------- 审计 ---------- */

export interface AuditEntry {
  /** ISO 时间。 */
  ts: string
  /** 来源恒为 tihu。 */
  source: 'tihu'
  /** 会话 id（便于按会话 grep）。 */
  sessionId?: string
  /** 动作种类。 */
  action: TihuActionKind
  /** 工具名。 */
  tool: string
  /** 目标（相对路径或命令原文）。 */
  target?: string
  /** 快照目录。 */
  snapshot?: string
  /** 决策：allow / confirm-allow / confirm-deny / timeout / offline。 */
  decision: string
  /** 结果：executed / failed / skipped。 */
  result?: string
  /** diff 摘要（行数）。 */
  diff?: { added: number; removed: number }
  /** 备注。 */
  note?: string
}

/** 追加一行审计。写失败不抛（审计失败不能反过来阻断用户动作），但会返回 false。 */
export function appendAudit(workspace: string, entry: AuditEntry): boolean {
  try {
    const file = join(tihuDirOf(workspace), AUDIT_FILE)
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    return true
  } catch { return false }
}

/** 读回审计（测试用；坏行跳过）。 */
export function readAudit(workspace: string): AuditEntry[] {
  const file = join(tihuDirOf(workspace), AUDIT_FILE)
  if (!existsSync(file)) return []
  const out: AuditEntry[] = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as AuditEntry) } catch { /* 坏行跳过 */ }
  }
  return out
}

/* ---------- diff 摘要 ---------- */

export interface DiffSummary {
  /** 新增行数。 */
  added: number
  /** 删除行数。 */
  removed: number
  /** 一行摘要（给屏上显示）。 */
  summary: string
}

/**
 * 行级 diff 摘要。只求「+N / -M 行」与首处变更，不追求完整 diff——
 * 屏只有 320×240，完整 diff 由宿主的 diff 视图负责。
 *
 * 超过 4000 行退化成长度比较，避免长文件把这一步拖慢。
 */
export function diffSummary(before: string, after: string): DiffSummary {
  // 统一换行，并去掉末尾那一个换行——否则 "a\n".split 会多出一个空行，
  // 把「改了 1 行」报成 +2/-1，屏上数字就对不上了。
  const normalize = (value: string) => String(value ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '')
  const a = normalize(before).split('\n')
  const b = normalize(after).split('\n')
  if (a.length > 4000 || b.length > 4000) {
    const delta = b.length - a.length
    return { added: delta > 0 ? delta : 0, removed: delta < 0 ? -delta : 0, summary: delta === 0 ? '内容有变化（超长文件，未做逐行 diff）' : `行数 ${delta > 0 ? '+' : ''}${delta}` }
  }
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const removed = a.length - prefix - suffix
  const added = b.length - prefix - suffix
  if (removed === 0 && added === 0) return { added: 0, removed: 0, summary: '内容未变化' }
  const parts: string[] = []
  if (added > 0) parts.push(`+${added} 行`)
  if (removed > 0) parts.push(`-${removed} 行`)
  return { added, removed, summary: parts.join(' ') }
}

/** 读文件文本（不存在/读不到给 ''，用于快照后 diff）。 */
export function readTextOrEmpty(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : '' } catch { return '' }
}

/* ---------- 测试辅助 ---------- */

/** 直接写一份测试用文件（保证父目录存在）。 */
export function writeTestFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

export const tihuGuardTestSurface = {
  classifyTool,
  isReadOnlyCommand,
  targetPathOf,
  commandOf,
  relativeInsideRoot,
  takeSnapshot,
  appendAudit,
  readAudit,
  diffSummary,
  timestampSlug,
}
