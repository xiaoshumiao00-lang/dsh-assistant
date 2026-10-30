/**
 * 一键导出诊断包（P1-A）。
 *
 * 收的是「看得出错在哪」的东西，不收「能让人上机」的东西：
 *   - 版本号（包 / 插件清单 / 宿主 DSH 版本）
 *   - 新建会话聚焦日志尾部（$DSH_HOME/dsh-assistant-focus.log）
 *   - 桌面原生球 helper 日志尾部（<profile>/dsh-assistant-ball/helper.log）
 *   - 手机访问诊断流水摘要（$DSH_HOME/dsh-pocket/diagnostic.jsonl：只留计数与最近几条的关键字段）
 *   - 状态文件概要（dsh-assistant-state.json 的 revision/updatedAt/项数，不倒内容）
 *   - 助手目录用量（含归档上限是否到顶）
 *   - 目录 allowlist 的根列表（脱敏后）
 *
 * 脱敏规则（写盘前一律过一遍，见 redactText）：
 *   - 已知绝对根（用户主目录、DSH_HOME、profile 目录、技能根、默认项目父目录、临时目录）→ 换成 `<HOME>` / `<DSH>` / `<PROFILE>` 之类标记；
 *   - 残留的盘符路径（`X:\...` / `/Users/...` / `/home/...`）→ `<PATH>`；
 *   - PIN / token / cookie / key 的值 → `«已脱敏»`；
 *   - 报告脱敏替换了多少处，方便你判断这份包能不能直接发出去。
 *
 * 落盘位置：`~/.dsh/assistant/outputs/diagnostics-<时间戳>.json`（0o600 尽力）。
 * 路由：
 *   GET  /api/assistant/diagnostics          —— 直接返回包内容（不落盘）
 *   POST /api/assistant/diagnostics/export   —— 落盘，返回 savedPath + 字节数 + 脱敏计数
 * 宿主改动，需要重启 DSH Desktop 才生效。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createRequire } from 'node:module'
import { manageWebRoutes } from './web-routes'
import { assistantHomeDir, assistantHomeUsage, ensureAssistantHome } from './assistant-home'
import { dshHome, loadAssistantConfig, platformDesktopDir, resolveNewProjectParent } from './assistant-config'
import { defaultAllowedRoots } from './path-guard'

const MASK = '«已脱敏»'

/** 已知绝对根 → 标记。顺序重要：先长后短（profile 在 DSH_HOME 之内，必须先替 profile）。 */
function knownRoots(): { marker: string; path: string }[] {
  const home = homedir()
  const dsHome = dshHome()
  const out: { marker: string; path: string }[] = []
  const push = (marker: string, path: string) => {
    const clean = String(path ?? '').trim()
    if (!clean) return
    if (out.some((item) => item.path.toLowerCase() === clean.toLowerCase())) return
    out.push({ marker, path: clean })
  }
  push('<PROFILE>', join(dsHome, 'profiles', 'desktop'))
  push('<DSH>', dsHome)
  push('<ASSISTANT>', assistantHomeDir())
  push('<DESKTOP>', platformDesktopDir())
  push('<HOME>', home)
  push('<TMP>', tmpdir())
  try {
    const config = loadAssistantConfig()
    push('<SKILLS>', config.skillRoot ? resolveNewProjectParent(config).parent : '')
    push('<SKILLROOT>', config.skillRoot ?? '')
    for (const root of config.allowedRoots) push('<ROOT>', root)
  } catch { /* 配置读不到就用默认值 */ }
  return out.sort((a, b) => b.path.length - a.path.length)
}

const SECRET_PATTERNS: RegExp[] = [
  // key=value / "key": value 形态的秘密字段
  /(["']?(?:pin|token|cookie|authorization|secret|password|apikey|api_key|accessKey|accessToken|tunnelToken)["']?\s*[:=]\s*)["']?[^\s,"'&}]{1,200}/gi,
  // 「pin 12345678」「密码 12345678」这种空格形态（日志里最常见的写法）
  /\b(pin|passcode|密码|口令)\s+[A-Za-z0-9]{4,}/gi,
  // Bearer 与裸 32+ 位十六进制
  /\bBearer\s+[A-Za-z0-9._\-+/=]{6,}/gi,
  /\b[0-9a-f]{32,}\b/gi,
]

/** 只在 JSON 字符串【内部】_mask_ 6–8 位数字串（PIN 长这样的东西）；
 *  数字字段（8388608 的容量上限、revision）一律不动，不然包会变 invalid。 */

/** 文本脱敏：已知根 → 标记；残留盘符路径 → <PATH>；秘密字段 → «已脱敏»。返回文本 + 计数。 */
export function redactText(input: string, roots = knownRoots()): { text: string; replaced: number } {
  let text = String(input ?? '')
  let replaced = 0
  for (const root of roots) {
    const escaped = root.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped + '(?=[\\\\/]|$|[\\s"\'，。：])', 'gi')
    text = text.replace(pattern, () => { replaced += 1; return root.marker })
  }
  text = text.replace(/(?:[A-Za-z]:[\\/])[^\s"',，。；;)}\]]{1,200}/g, () => { replaced += 1; return '<PATH>' })
  text = text.replace(/(?:\/Users|\/home)\/[^\s"',，。；;)}\]]{1,200}/g, () => { replaced += 1; return '<PATH>' })
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match: string) => {
      replaced += 1
      const keepShape = /^["']?[A-Za-z_]+["']?\s*[:=]\s*/.exec(match)
      return keepShape ? keepShape[0] + MASK : MASK
    })
  }
  // 字符串里的 6–8 位数字（PIN 形态）单独过一遍：只替 JSON 字符串内部，不动数字字段
  text = text.replace(/"((?:[^"\\]|\\.)*)"/g, (match: string, inner: string) => {
    if (!/\b\d{6,8}\b/.test(inner)) return match
    replaced += 1
    return '"' + inner.replace(/\b\d{6,8}\b/g, MASK) + '"'
  })
  return { text, replaced }
}

function tailLines(path: string, maxLines = 120, maxBytes = 256 * 1024): { path: string; exists: boolean; lines: string[]; truncated: boolean } {
  if (!existsSync(path)) return { path, exists: false, lines: [], truncated: false }
  let raw = ''
  try {
    const size = statSync(path).size
    raw = readFileSync(path, 'utf8')
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '')
    const truncated = size > maxBytes || lines.length > maxLines
    return { path, exists: true, lines: lines.slice(-maxLines), truncated }
  } catch {
    return { path, exists: true, lines: [], truncated: true }
  }
}

function jsonSummary(path: string): { path: string; exists: boolean; summary: Record<string, unknown> } {
  if (!existsSync(path)) return { path, exists: false, summary: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {}
    const summary: Record<string, unknown> = {}
    for (const key of ['revision', 'updatedAt', 'savedAt', 'version']) {
      if (record[key] !== undefined) summary[key] = record[key]
    }
    for (const key of ['projects', 'layouts', 'folders', 'bindings', 'removed', 'flows', 'on', 'off']) {
      const value = record[key]
      if (Array.isArray(value)) summary[`${key}Count`] = value.length
      else if (value && typeof value === 'object') summary[`${key}Count`] = Object.keys(value).length
    }
    return { path, exists: true, summary }
  } catch (err) {
    return { path, exists: true, summary: { parseError: String(err) } }
  }
}

/** 手机访问诊断流水（jsonl）：只留计数 + 最近几条的关键字段名，不倒 payload。 */
function pocketDiagSummary(path: string, maxKeep = 12): { path: string; exists: boolean; total: number; byKind: Record<string, number>; recent: Record<string, unknown>[] } {
  const empty = { path, exists: false, total: 0, byKind: {}, recent: [] }
  if (!existsSync(path)) return empty
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '')
    const byKind: Record<string, number> = {}
    for (const line of lines) {
      let kind = 'unknown'
      try { kind = String(JSON.parse(line)?.kind ?? JSON.parse(line)?.event ?? 'unknown') } catch { /* 行坏了就记 unknown */ }
      byKind[kind] = (byKind[kind] ?? 0) + 1
    }
    const recent = lines.slice(-maxKeep).map((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const keep: Record<string, unknown> = {}
        for (const key of ['kind', 'event', 'at', 'ts', 'code', 'status', 'msg']) {
          if (entry[key] !== undefined) keep[key] = typeof entry[key] === 'string' ? String(entry[key]).slice(0, 160) : entry[key]
        }
        return keep
      } catch { return { unparsed: true } }
    })
    return { path, exists: true, total: lines.length, byKind, recent }
  } catch { return { ...empty, exists: true } }
}

function versions(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { name?: string; version?: string }
    out.package = `${pkg.name}@${pkg.version}`
  } catch { out.package = 'unknown' }
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'dsh.plugin.json'), 'utf8'))
    out.manifest = `${manifest?.name}@${manifest?.version}`
  } catch { out.manifest = 'unknown' }
  out.node = process.version
  out.platform = `${process.platform} ${process.release?.lskVersion ?? ''}`.trim()
  try { out.dshVersion = process.env.DSH_VERSION ?? process.env.DSH_CLIENT_VERSION ?? 'unknown' } catch { out.dshVersion = 'unknown' }
  return out
}

/** 组装诊断包（未脱敏的内部结构；导出前一律过 redact）。 */
export function collectDiagnostics(ctx?: any): Record<string, unknown> {
  const home = ensureAssistantHome()
  const dsHome = dshHome()
  const profileDir = (() => {
    try { const p = ctx?.get?.('profileContext'); if (p && typeof p.dir === 'string' && p.dir) return p.dir } catch { /* 没有 profileContext 服务就用默认 */ }
    return join(dsHome, 'profiles', 'desktop')
  })()
  const config = loadAssistantConfig()
  const bundle: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    versions: versions(),
    assistantHome: { dir: home.dir, usage: assistantHomeUsage() },
    focusLog: tailLines(join(dsHome, 'dsh-assistant-focus.log')),
    ballHelperLog: tailLines(join(profileDir, 'dsh-assistant-ball', 'helper.log')),
    pocketDiagnostic: pocketDiagSummary(join(dsHome, 'dsh-pocket', 'diagnostic.jsonl')),
    stateFiles: {
      assistant: jsonSummary(join(profileDir, 'dsh-assistant-state.json')),
      tuoguan: jsonSummary(join(profileDir, 'dsh-tuoguan-state.json')),
    },
    localConfig: {
      sourceFile: config.sourceFile ? '<CONFIG>' : '',
      hasPersona: !!config.persona,
      asrTermCount: config.asrTerms.length,
      allowedRoots: defaultAllowedRoots(config),
      allowAllLocalPaths: config.allowAllLocalPaths === true,
      loadError: config.loadError || '',
    },
    // 不导出的东西列在这里：让看的人知道「这里故意不给」
    notCollected: ['dsh-pocket/settings.json（PIN / 隧道 Token / cloudflared 路径）', '会话内容与日志本体', 'config.json 里的个人目录与词表原文'],
    pidOfBall: (() => { try { return statSync(join(profileDir, 'dsh-assistant-ball', 'helper.pid')).size } catch { return 0 } })(),
  }
  return bundle
}

/** 序列化成 JSON 文本并脱敏。 */
export function renderDiagnosticsBundle(ctx?: any): { text: string; replaced: number } {
  const raw = JSON.stringify(collectDiagnostics(ctx), null, 2)
  // 配置文件路径本身也替掉（里面存着个人目录）
  const withConfigMasked = raw.replace(/"sourceFile":\s*"[^"]*"/g, `"sourceFile": "<CONFIG>"`)
  const redacted = redactText(withConfigMasked)
  return { text: redacted.text.replace(/<ASSISTANT>/g, '<ASSISTANT>'), replaced: redacted.replaced }
}

/** 落盘：写进 outputs/，返回真实路径（给用户复制用，不是包内容）。 */
export function writeDiagnosticsBundle(ctx?: any): { savedPath: string; bytes: number; replaced: number; generatedAt: string } {
  const home = ensureAssistantHome()
  const { text, replaced } = renderDiagnosticsBundle(ctx)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const savedPath = join(home.outputs, `diagnostics-${stamp}.json`)
  try {
    writeFileSync(savedPath, text + '\n', { mode: 0o600 })
  } catch {
    writeFileSync(savedPath, text + '\n', 'utf8')
  }
  return { savedPath, bytes: Buffer.byteLength(text, 'utf8'), replaced, generatedAt: new Date().toISOString() }
}

export function registerAssistantDiagnostics(ctx: any): () => void {
  const routes = manageWebRoutes(ctx.webServer)
  const webServer = routes.webServer

  const sendJson = (res: any, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/diagnostics',
    handler: async (req: any, res: any) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      try {
        const { text, replaced } = renderDiagnosticsBundle(ctx)
        sendJson(res, 200, { ok: true, redactedReplacements: replaced, bundle: JSON.parse(text) })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) })
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/diagnostics/export',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      try {
        const result = writeDiagnosticsBundle(ctx)
        // savedPath 是本地给你复制的，不在包内容里
        sendJson(res, 200, { ok: true, ...result, outputsDir: ensureAssistantHome().outputs })
        try { ctx.logger?.info?.(`[dsh-assistant] 诊断包已导出：${result.savedPath}（脱敏替换 ${result.replaced} 处）`) } catch { /* 日志写不进也无所谓 */ }
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) })
      }
    },
  })

  return routes.dispose
}

/** 供测试直接验（scripts/test-assistant-diagnostics.mjs） */
export const assistantDiagnosticsTestSurface = {
  redactText,
  collectDiagnostics,
  renderDiagnosticsBundle,
  writeDiagnosticsBundle,
  registerAssistantDiagnostics,
  maskConstant: MASK,
  secretPatterns: SECRET_PATTERNS.length,
}
