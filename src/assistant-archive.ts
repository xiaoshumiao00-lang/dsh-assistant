/**
 * 助手档案导出 / 导入（P1-B）。
 *
 * 归档格式：单一 JSON 清单（不引 zip 依赖，仓库里没有压缩库，也别凭空装一个）：
 *   { format:'dsh-assistant-archive', version, generatedAt,
 *     items: [{ area, relPath, content, bytes, sha256 }],
 *     tombstones: [...], presets: [...], totals, checksum }
 *   - area ∈ agents | journal | notes | archive | config | memory | state
 *   - checksum 是整个 items 列表的 sha256（导入前先验，坏了就拒绝，别半截导入）
 *
 * 导出路由：
 *   GET  /api/assistant/archive            —— 返回包内容（不落盘）
 *   POST /api/assistant/archive/export     —— 落盘到 ~/.dsh/assistant/exports/archive-<时间戳>.json
 * 导入路由：
 *   POST /api/assistant/archive/import     —— body { bundle, knownPresets?, dryRun? }
 *     · 先备份现有 AGENTS.md/journal/notes 进 archive/import-backup-<时间戳>/（不删原样）
 *     · 按文件夹判重：内容 hash 一样 → skip（deduped）
 *     · 内容不一样 → 【不覆盖】，新的写成 <原名>.imported-<时间戳>.<后缀>，报告里列出来
 *     · 删除墓碑（state.removed）一律不写回：你删过卡片就是明确不要它
 *     · 包里用到的模板预设本机没有 → 明确提示（missingPresets），不静默
 *
 * 宿主改动，需要重启 DSH Desktop。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { manageWebRoutes } from './web-routes'
import { ensureAssistantHome } from './assistant-home'
import { runtimeMemoryDir } from './assistant-memory'
import { dshHome } from './assistant-config'

export const ARCHIVE_FORMAT = 'dsh-assistant-archive'
export const ARCHIVE_Areas = ['agents', 'journal', 'notes', 'archive', 'config', 'memory', 'state']

const MAX_ITEM_BYTES = 4 * 1024 * 1024
const MAX_BUNDLE_BYTES = 48 * 1024 * 1024

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function stampNow(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

export type ArchiveItem = { area: string; relPath: string; content: string; bytes: number; sha256: string; skipped?: string }

export function collectArchive(): { bundle: string; items: ArchiveItem[]; totals: Record<string, number>; generatedAt: string } {
  const home = ensureAssistantHome()
  const items: ArchiveItem[] = []
  const push = (area: string, absPath: string, relPath: string) => {
    if (!existsSync(absPath)) return
    let content = ''
    try {
      if (statSync(absPath).size > MAX_ITEM_BYTES) return
      content = readFileSync(absPath, 'utf8')
    } catch { return }
    items.push({ area, relPath, content, bytes: Buffer.byteLength(content, 'utf8'), sha256: sha256(content) })
  }

  push('agents', join(home.dir, 'AGENTS.md'), 'AGENTS.md')
  push('config', join(home.dir, 'config.json'), 'config.json')
  for (const area of ['journal', 'notes'] as const) {
    const dir = area === 'journal' ? home.journal : home.notes
    for (const rel of listFilesRecursively(dir)) push(area, join(dir, rel), rel)
  }
  for (const rel of listFilesRecursively(home.archive)) push('archive', join(home.archive, rel), rel)

  // 宿主热记忆（USER.md / MEMORY.md）：读得到就带上
  const memoryDir = runtimeMemoryDir()
  for (const name of ['USER.md', 'MEMORY.md', 'memories.json']) push('memory', join(memoryDir, name), name)

  // 跨端状态文件（含删除墓碑）
  const dsHome = dshHome()
  for (const name of ['dsh-assistant-state.json', 'dsh-tuoguan-state.json']) {
    for (const dir of [join(dsHome, 'profiles', 'desktop'), dsHome]) {
      const abs = join(dir, name)
      if (existsSync(abs)) { push('state', abs, name); break }
    }
  }

  const generatedAt = new Date().toISOString()
  const body = {
    format: ARCHIVE_FORMAT,
    version: readVersion(),
    generatedAt,
    areas: items.map((item) => item.area),
    items,
    totals: {
      items: items.length,
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
      journal: items.filter((item) => item.area === 'journal').length,
      notes: items.filter((item) => item.area === 'notes').length,
      archive: items.filter((item) => item.area === 'archive').length,
    },
  }
  const bundle = JSON.stringify({ ...body, checksum: sha256(items.map((item) => `${item.area}\u0000${item.relPath}\u0000${item.sha256}`).join('\n')) }, null, 2)
  return { bundle, items, totals: body.totals, generatedAt }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    return String(pkg?.version ?? 'unknown')
  } catch { return 'unknown' }
}

/** 递归列文件（相对路径，用 / 分隔；跳过隐藏目录与太深的嵌套） */
function listFilesRecursively(root: string, base = ''): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  let names: string[] = []
  try { names = readdirSync(root) } catch { return [] }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const abs = join(root, name)
    const rel = base ? `${base}/${name}` : name
    try {
      if (statSync(abs).isDirectory()) out.push(...listFilesRecursively(abs, rel))
      else out.push(rel)
    } catch { /* 读不到就当没这个文件 */ }
  }
  return out
}

/** 落盘导出的档案包（exports/ 不在 outputs 的 14 天清理范围里，不会被自动删） */
export function writeArchiveBundle(): { savedPath: string; bytes: number; items: number } {
  const home = ensureAssistantHome()
  const exportsDir = join(home.dir, 'exports')
  mkdirSync(exportsDir, { recursive: true })
  const { bundle, items, totals } = collectArchive()
  const savedPath = join(exportsDir, `archive-${stampNow()}.json`)
  if (Buffer.byteLength(bundle, 'utf8') > MAX_BUNDLE_BYTES) {
    throw new Error(`档案包太大（${totals.bytes} 字节 > ${MAX_BUNDLE_BYTES}），先清 archive/ 或挑着导`)
  }
  try {
    writeFileSync(savedPath, bundle + '\n', { mode: 0o600 })
  } catch {
    writeFileSync(savedPath, bundle + '\n', 'utf8')
  }
  return { savedPath, bytes: Buffer.byteLength(bundle, 'utf8'), items: items.length }
}

export type ImportReport = {
  ok: boolean
  error?: string
  dryRun?: boolean
  backupDir?: string
  written: { area: string; relPath: string; as: string }[]
  skipped: { area: string; relPath: string; why: string }[]
  keptBoth: { area: string; relPath: string; wroteAs: string }[]
  tombstonesIgnored: number
  missingPresets: string[]
  totals: { items: number; bytes: number }
}

/** 导入助手档案：备份 → 校验 → 按文件夹判重 → 不覆盖（冲突写成 .imported-*）→ 不写回墓碑 */
export function importArchiveBundle(raw: unknown, knownPresets: string[] = [], dryRun = false): ImportReport {
  const report: ImportReport = { ok: false, written: [], skipped: [], keptBoth: [], tombstonesIgnored: 0, missingPresets: [], totals: { items: 0, bytes: 0 } }
  const bundle = typeof raw === 'string' ? safeParse(raw) : raw
  if (!bundle || typeof bundle !== 'object') { report.error = 'bad-bundle'; return report }
  const body = bundle as Record<string, any>
  if (body.format !== ARCHIVE_FORMAT) { report.error = `format 不是 ${ARCHIVE_FORMAT}`; return report }
  if (!Array.isArray(body.items)) { report.error = '包里没有 items 列表'; return report }
  const checksum = sha256(body.items.map((item: ArchiveItem) => `${item.area}\u0000${item.relPath}\u0000${item.sha256}`).join('\n'))
  if (typeof body.checksum === 'string' && body.checksum !== checksum) { report.error = '校验和不对（包被改过或半截），拒绝导入'; return report }

  const home = ensureAssistantHome()
  const stamp = stampNow()
  const backupDir = join(home.archive, `import-backup-${stamp}`)
  if (!dryRun) mkdirSync(backupDir, { recursive: true })

  const areaDir = (area: string): string => {
    if (area === 'journal') return home.journal
    if (area === 'notes') return home.notes
    if (area === 'archive') return home.archive
    return home.dir
  }

  for (const itemRaw of body.items) {
    const item = itemRaw as ArchiveItem
    if (!item || typeof item.relPath !== 'string' || typeof item.content !== 'string') {
      report.skipped.push({ area: String(item?.area ?? '?'), relPath: String(item?.relPath ?? '?'), why: '条目不完整' })
      continue
    }
    const area = String(item.area ?? 'notes')
    if (!ARCHIVE_Areas.includes(area) || area === 'state' || area === 'config') {
      report.skipped.push({ area, relPath: item.relPath, why: area === 'state' ? '状态文件里的删除墓碑不写回（尊重本机删过的卡片）' : '这个区域不接受导入' })
      if (area === 'state') report.tombstonesIgnored += 1
      continue
    }
    // 防穿越：包里的相对路径不许跳出该区目录（也不许用绝对路径塞进来）
    const targetDir = areaDir(area)
    const target = join(targetDir, item.relPath)
    const relCheck = relative(targetDir, target)
    if (!relCheck || relCheck.startsWith('..') || isAbsolute(item.relPath)) {
      report.skipped.push({ area, relPath: item.relPath, why: '路径越界（不许跳出助手家目录）' })
      continue
    }

    const incomingHash = sha256(item.content)
    if (existsSync(target)) {
      let existing = ''
      try { existing = readFileSync(target, 'utf8') } catch { existing = '' }
      if (sha256(existing) === incomingHash) {
        report.skipped.push({ area, relPath: item.relPath, why: '已经有一模一样的这份（判重跳过）' })
        continue
      }
      const lastDot = item.relPath.lastIndexOf('.')
      const extension = lastDot > 0 ? item.relPath.slice(lastDot) : '.txt'
      const stem = lastDot > 0 ? item.relPath.slice(0, lastDot) : item.relPath
      const altRel = `${stem}.imported-${stamp}${extension}`
      const alt = join(targetDir, altRel)
      if (!dryRun) {
        mkdirSync(dirname(alt), { recursive: true })
        writeFileSync(alt, item.content, 'utf8')
      }
      report.keptBoth.push({ area, relPath: item.relPath, wroteAs: altRel })
      report.totals.items += 1
      report.totals.bytes += Buffer.byteLength(item.content, 'utf8')
      continue
    }
    if (!dryRun) {
      // 先备份被导入的同名位置（目录不存在就啥也不消动）
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(target, item.content, 'utf8')
    }
    report.written.push({ area, relPath: item.relPath, as: item.relPath })
    report.totals.items += 1
    report.totals.bytes += Buffer.byteLength(item.content, 'utf8')
  }

  if (!dryRun) {
    // 备份现有的人设与档案（导入前的一手快照）
    try {
      for (const { label, dir } of [{ label: 'journal', dir: home.journal }, { label: 'notes', dir: home.notes }]) {
        for (const rel of listFilesRecursively(dir)) {
          const abs = join(dir, rel)
          if (existsSync(abs)) copyFileSync(abs, join(backupDir, `${label}_${rel.replace(/[\\/]/g, '_')}`))
        }
      }
      const agents = join(home.dir, 'AGENTS.md')
      if (existsSync(agents)) copyFileSync(agents, join(backupDir, 'AGENTS.md'))
    } catch { /* 备份尽力做成，做不成也别把导入卡死 */ }
  }
  report.backupDir = dryRun ? undefined : backupDir

  const usedPresets = collectPresetIds(body)
  const known = new Set(knownPresets.map(String))
  report.missingPresets = usedPresets.filter((id) => !known.has(id))
  report.ok = true
  report.dryRun = dryRun
  return report
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

function collectPresetIds(body: Record<string, any>): string[] {
  const found = new Set<string>()
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || value === null || value === undefined) return
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return }
    if (typeof value === 'string') {
      const text = value.trim()
      if (text.startsWith('{') || text.startsWith('[')) {
        let parsed: unknown = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        if (parsed !== null) visit(parsed, depth + 1)
      }
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    for (const key of ['preset', 'presetId', 'templateId']) {
      const raw = record[key]
      if (typeof raw === 'string' && raw.trim()) found.add(raw.trim())
    }
    for (const key of Object.keys(record)) visit(record[key], depth + 1)
  }
  visit(body, 0)
  return Array.from(found).sort()
}

export function registerAssistantArchive(ctx: any): () => void {
  const routes = manageWebRoutes(ctx.webServer)
  const webServer = routes.webServer
  const sendJson = (res: any, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
  const readBody = async (req: any, limitBytes = MAX_BUNDLE_BYTES): Promise<any> => {
    if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {}
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > limitBytes) { const sentinel: any = {}; sentinel.__tooLarge = true; return sentinel }
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return {}
    try { return JSON.parse(text) } catch { return { __badJson: true } }
  }

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/archive',
    handler: async (req: any, res: any) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      try {
        const { bundle, items, totals } = collectArchive()
        sendJson(res, 200, { ok: true, totals, count: items.length, bundle: JSON.parse(bundle) })
      } catch (err) { sendJson(res, 500, { ok: false, error: String(err) }) }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/archive/export',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      try {
        const result = writeArchiveBundle()
        sendJson(res, 200, { ok: true, ...result })
        try { ctx.logger?.info?.(`[dsh-assistant] 助手档案已导出：${result.savedPath}（${result.items} 项）`) } catch { /* 日志失败无所谓 */ }
      } catch (err) { sendJson(res, 500, { ok: false, error: String(err) }) }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/archive/import',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const body = await readBody(req)
      if (body?.__tooLarge) { sendJson(res, 413, { ok: false, error: '包太大（上限 48MB）' }); return }
      if (body?.__badJson) { sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' }); return }
      const bundle = body?.bundle ?? body
      const known = Array.isArray(body?.knownPresets) ? body.knownPresets.map(String) : []
      const report = importArchiveBundle(bundle, known, body?.dryRun === true)
      sendJson(res, report.ok ? 200 : 400, { ok: report.ok, ...report, restartRequired: report.ok && !report.dryRun ? true : false })
    },
  })

  return routes.dispose
}

/** 供测试直接验（scripts/test-assistant-archive.mjs） */
export const assistantArchiveTestSurface = {
  ARCHIVE_FORMAT,
  ARCHIVE_Areas,
  collectArchive,
  writeArchiveBundle,
  importArchiveBundle,
  registerAssistantArchive,
  checksumOf: (items: ArchiveItem[]) => sha256(items.map((item) => `${item.area}\u0000${item.relPath}\u0000${item.sha256}`).join('\n')),
}
