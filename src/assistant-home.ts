/**
 * 私人助手的「家」：一个固定工作目录 + 一份 AGENTS.md。
 *
 * 为什么用目录而不是新造一套人设系统：
 *   - DSH 的 agent-instructions 会把工作目录（及子目录）里的 AGENTS.md 注入到会话上下文，
 *     也就是说「人设 + 规矩」跟着目录走，换模型、换预设、手机电脑都一样生效；
 *   - 助手会话固定落在这个目录，历史、记忆、日志都在一处，不散落在各个项目卡片里；
 *   - 不依赖 agent preset（preset 只在 bundle 里声明，插件改不动用户的组合）。
 *
 * 目录结构：
 *   ~/.dsh/assistant/
 *     AGENTS.md          人设与规矩（只在缺失时写入，不覆盖用户手改）
 *     journal/YYYY-MM-DD.md  每天「干了什么 / 结论 / 待办」（收工时追加）
 *     notes/             长期档案（跨项目知识，按主题一份）
 *     outputs/YYYY-MM-DD/ 杂物间：临时产物（脚本、导出、截图、中间结果），14 天后自动清
 *     archive/           归档区：journal 超期 / notes 超字节上限的旧文件搬到这里（插件绝不删）
 *
 * 容量策略（v0.2.11 起，P0-3）：
 *   - outputs/  → 超过保留期（14 天）直接删（本来就是「杂物」）；
 *   - journal/  → 日期超过 JOURNAL_ARCHIVE_AFTER_DAYS 天、或文件数超过 JOURNAL_MAX_FILES 份的，
 *                 整份搬进 archive/journal/<年>/；
 *   - notes/    → 总字节超过 NOTE_TOTAL_BYTES_LIMIT 时，最旧的整份搬进 archive/notes/；
 *   - 插件对 journal/notes **永远不删**，只搬；archive/ 自己超过软上限时只在面板上提示，不动。
 *
 * 为什么要有 outputs 与自动清理：
 *   - **会话记录不在这里**：DSH 把每个会话的日志存在 `~/.dsh/sessions/<编码目录>/`，
 *     项目文件夹只承接「写出来的文件」，所以不会因为聊得多而膨胀；
 *   - 但助手确实会写文件，都落在 cwd（= 这个目录）。家目录因此必须分成
 *     「记忆资产（AGENTS.md / journal / notes）」与「杂物（outputs）」，后者按保留期清掉，
 *     否则一年下来就是一堆一次性脚本和截图；
 *   - 要长期保留的产物应该走「建卡」：那才是产物该待的地方（项目文件夹里，看得见、能交付）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import { manageWebRoutes } from './web-routes.ts'
import { loadAssistantConfig } from './assistant-config.ts'
import { clearRuntimeMemory, deleteRuntimeMemoryEntry, readRuntimeMemory } from './assistant-memory.ts'

/** AGENTS.md 的版本标记：只在缺失时写；以后改内容靠这个标记判断要不要提示升级。 */
const AGENTS_MARKER = '<!-- dsh-assistant:assistant-home v1 -->'
/** 追加段落标记：老文件已存在时不整份重写，只把这节补在后面（一次）。 */
const HOME_RULES_MARKER = '<!-- dsh-assistant:home-rules v2 -->'
/** 本机人设段落（由 assistant-config 注入，可整段删除；删掉后插件不会再往里塞） */
const PERSONA_BEGIN = '<!-- dsh-assistant:persona v1 begin -->'
const PERSONA_END = '<!-- dsh-assistant:persona v1 end -->'
/** outputs/ 的保留天数。 */
export const OUTPUTS_RETENTION_DAYS = 14
/** journal/ 文件超过这么多天就整份搬进 archive/（不删）。 */
export const JOURNAL_ARCHIVE_AFTER_DAYS = 90
/** journal/ 最多留这么多份文件。 */
export const JOURNAL_MAX_FILES = 180
/** notes/ 的总字节上限：超了按最旧的整份搬进 archive/notes/。 */
export const NOTE_TOTAL_BYTES_LIMIT = 8 * 1024 * 1024
/** archive/ 的软上限：只报告「该自己清一清了」，插件不删。 */
export const ARCHIVE_SOFT_BYTES_LIMIT = 32 * 1024 * 1024
/** 自动清理间隔。 */
const TIDY_INTERVAL_MS = 6 * 60 * 60 * 1000

/** v0.2.9 追加的「家目录别堆产物」规矩。老 AGENTS.md 不重写，只在缺这一节时追加。 */
const HOME_RULES_MD = `${HOME_RULES_MARKER}
## 家目录规矩（产物别堆在这里）
这里是「住的地方」，不是「干活的桌子」：
- 长期文件只放三样：\`AGENTS.md\`、\`journal/\`（按天日志）、\`notes/\`（长期档案）。
- 临时产物（脚本、截图、导出、中间结果）一律写到 \`outputs/YYYY-MM-DD/\`，或直接写系统临时目录；
  \`outputs/\` 里超过 ${OUTPUTS_RETENTION_DAYS} 天的东西会被插件自动清掉，别把要留的东西放这。
- 要长期保留、要交付、要多轮迭代的产物 → 建项目卡片，产物落在那个项目的文件夹里。
- 写文件前先问自己一句：这文件三天后还有用吗？没用 → outputs；有用 → 建卡。
`;

/** v0.2.11 追加的归档规矩：老文件缺这一节时追加一次（不重写整份）。 */
const ARCHIVE_RULES_MARKER = '<!-- dsh-assistant:home-rules v3 -->'
const ARCHIVE_RULES_MD = `${ARCHIVE_RULES_MARKER}
## 归档规矩（journal / notes 有容量上限）
- \`journal/\` 只留最近 ${JOURNAL_ARCHIVE_AFTER_DAYS} 天的日志；更早的按年整份搬进 \`archive/journal/<年>/\`。
- \`notes/\` 总体积上限 ${Math.round(NOTE_TOTAL_BYTES_LIMIT / 1024 / 1024)}MB；超了就按最旧的整份搬进 \`archive/notes/\`。
- 搬走的东西插件**不会删**，都在 \`archive/\` 里看得见；要真的删得自己在面板上动手。
- \`outputs/\` 才会被自动删（超过 ${OUTPUTS_RETENTION_DAYS} 天）。
`;

const AGENTS_MD = `${AGENTS_MARKER}
# 私人助手

你是这个助手目录主人的私人助手：不是任务启动器，也不是通用客服。你住在这个目录里，
长期记得主人做过什么、怎么做事、要什么标准。

## 开口前先看记忆
1. 热记忆每轮已经注入：\`USER.md\` = 他是谁、偏好、雷区；\`MEMORY.md\` = 项目与环境的硬事实。
   按它们办事，已经记下的不要重复问。
2. 需要更早的细节：用 \`mnemon_recall\` 查记忆、\`mnemon_document_search\` 查项目档案。
   要翻某次旧会话的原文，就问他要或让他打开那条会话——不要凭空猜。
3. 不确定的事实不要编。不确定时只问一个问题，不要连问一串。

## 直接做，还是建项目卡片
默认**直接做**：一句话能答、一次工具调用能完成、不需要多轮产出物、不跨天的事。
建议**建卡**的情形：要产出文件/代码/论文级交付物、要多轮迭代、要后台跑很久、要并行推进、
要给别人看进度。
- 建卡时说明理由，并给出项目名 + 目录建议，等他在控制室点「添加项目」再开工
  （第二步会做成你直接建卡，现在先别自己糊一个目录）。
- 判断不了就问一句，不要默默把小事做成大工程，也不要把大活硬塞进一句话的对话里。

## 记忆怎么写（这是「越用越懂他」的全部）
- **收工**（他说「收工 / 今天到这 / 总结一下」）：把这一轮做了什么、结论、待办，
  一行一条追加到 \`journal/YYYY-MM-DD.md\`；新出现的稳定事实写进 \`MEMORY.md\`
  （同一件事用 replace 覆盖旧条目，不要新旧并存、不要堆重复）。
- **他纠正你**（「不对 / 不是这样 / 记住」）：立刻改记忆，并回一句「已改：从 X 改成 Y」。
  旧结论要删掉或标废弃。
- 只记能长期复用的事实、偏好、决策、结论。不记寒暄、临时进度、一次性的中间结果。
- 他问「你记得我什么」：分条列出 \`USER.md\` 与 \`MEMORY.md\` 的要点，并标出最近改动的几条。

## 语气
- 中文，直接简洁；首句带状态图标：✅ 完成 / ⚠️ 注意 / ❗ 风险 / 🚧 进行中 / 💡 建议。
- 非必要少贴代码块、长路径、大段报告；要完整表格与规格时（论文、图表、Word/Excel）按学术交付做。
- 报错先查根因再给方案；异常先定位再动手。

## 边界
- 删除、覆盖、对外发送、花钱、提交到远端之前先问他。
- 不把私人信息写进对外文档；不在他没要求时擅自改项目里的文件。
- 权限按需：日常读写足够，不要随手开最高权限。
`

export interface AssistantHome {
  dir: string
  journal: string
  notes: string
  /** 杂物间：临时产物放这里，按保留期自动清 */
  outputs: string
  /** 归档区：journal / notes 超出容量策略时搬到这里（插件永不删） */
  archive: string
  /** AGENTS.md 是否由本插件写入/已存在 */
  agentsFile: string
}

/** 助手家的路径（可用 DSH_ASSISTANT_HOME 覆盖，便于测试）。 */
export function assistantHomeDir(): string {
  const override = String(process.env.DSH_ASSISTANT_HOME ?? '').trim()
  return override !== '' ? override : join(homedir(), '.dsh', 'assistant')
}

/** 本机人设（配置文件里的 persona.title / persona.lines）渲染成一段托管文本；没有配置就返回空串。 */
function personaBlockFromConfig(): string {
  let persona: { title?: string; lines?: string[] } | null = null
  try { persona = loadAssistantConfig().persona } catch { return '' }
  const title = String(persona?.title ?? '').trim()
  const lines = (persona?.lines ?? []).map((line) => String(line ?? '').trim()).filter(Boolean)
  if (!title && lines.length === 0) return ''
  const body = lines.length > 0 ? lines.map((line) => `- ${line}`).join('\n') : '- （配置文件里 persona.lines 为空）'
  return [
    '',
    PERSONA_BEGIN,
    '## 本机人设（来自 ~/.dsh/assistant/config.json，插件托管这段）',
    title,
    body,
    '（USER.md / MEMORY.md 是每轮自动注入的热记忆；这段只给 AGENTS.md 一个固定的自我介绍。）',
    PERSONA_END,
    '',
  ].filter((line) => line !== '').join('\n')
}

/** 确保目录与 AGENTS.md 存在。已存在的 AGENTS.md 一律不动（用户可能手改过），
 *  只补一次缺少的「家目录规矩」小节，以及（本机配置有人设时）托管的人设段落。 */
export function ensureAssistantHome(): AssistantHome {
  const dir = assistantHomeDir()
  const journal = join(dir, 'journal')
  const notes = join(dir, 'notes')
  const outputs = join(dir, 'outputs')
  const archive = join(dir, 'archive')
  const agentsFile = join(dir, 'AGENTS.md')
  for (const path of [dir, journal, notes, outputs, archive]) {
    try { mkdirSync(path, { recursive: true }) } catch { /* 权限问题不阻塞启动，路由会再报 */ }
  }
  try {
    const persona = personaBlockFromConfig()
    if (!existsSync(agentsFile)) {
      // 新写：通用模板 + 家目录规矩 + 归档规矩 +（本机配置有人设时）托管人设段
      writeFileSync(agentsFile, AGENTS_MD + HOME_RULES_MD + ARCHIVE_RULES_MD + persona, 'utf8')
    } else {
      let current = readFileSync(agentsFile, 'utf8')
      let changed = false
      // 新装 / 老 v1 文件都补齐「家目录规矩」：只在缺这一节时追加，绝不整份覆盖。
      if (current.includes(AGENTS_MARKER) && !current.includes(HOME_RULES_MARKER)) {
        current = current.replace(/\s*$/, '\n\n') + HOME_RULES_MD
        changed = true
      }
      // v0.2.11 的归档规矩：同样只追加一次
      if (current.includes(AGENTS_MARKER) && !current.includes(ARCHIVE_RULES_MARKER)) {
        current = current.replace(/\s*$/, '\n\n') + ARCHIVE_RULES_MD
        changed = true
      }
      // 托管人设：只在文件里有本插件写的通用模板时插入（用户手写的 AGENTS.md 不动）。
      if (persona && !current.includes(PERSONA_BEGIN) && current.includes('你是这个助手目录主人的私人助手')) {
        current = current.replace(/\s*$/, '\n\n') + persona
        changed = true
      }
      if (changed) writeFileSync(agentsFile, current, 'utf8')
    }
  } catch { /* 只读盘：会话仍可跑，只是没有人设 */ }
  return { dir, journal, notes, agentsFile, outputs, archive }
}

/** 目录体积（只统计自家四个区，不递归乱扫）。 */
export interface AssistantHomeUsage {
  totalBytes: number
  totalFiles: number
  journalBytes: number
  notesBytes: number
  outputsBytes: number
  /** journal/notes/outputs/archive 里各有多少文件（条数）——「用了多少」在面板上要说清 */
  journalFiles: number
  notesFiles: number
  outputsFiles: number
  archiveFiles: number
  archiveBytes: number
  /** 容量策略（P0-3）：这些上限是什么、有没有到 */
  limits: {
    outputsRetentionDays: number
    journalArchiveAfterDays: number
    journalMaxFiles: number
    noteTotalBytesLimit: number
    archiveSoftBytesLimit: number
  }
  capsReached: {
    journalOverMax: boolean
    notesOverBytes: boolean
    archiveOverSoft: boolean
  }
}

function dirUsage(root: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) {
        const nested = dirUsage(path)
        bytes += nested.bytes
        files += nested.files
      } else if (entry.isFile()) {
        try { bytes += statSync(path).size; files += 1 } catch { /* 竞态删除 */ }
      }
    }
  } catch { /* 目录不存在/无权限 */ }
  return { bytes, files }
}

export function assistantHomeUsage(): AssistantHomeUsage {
  const dir = assistantHomeDir()
  const journal = dirUsage(join(dir, 'journal'))
  const notes = dirUsage(join(dir, 'notes'))
  const outputs = dirUsage(join(dir, 'outputs'))
  const archive = dirUsage(join(dir, 'archive'))
  let agents = 0
  try { agents = statSync(join(dir, 'AGENTS.md')).size } catch { /* 没有也行 */ }
  return {
    totalBytes: agents + journal.bytes + notes.bytes + outputs.bytes + archive.bytes,
    totalFiles: journal.files + notes.files + outputs.files + archive.files,
    journalBytes: journal.bytes,
    notesBytes: notes.bytes,
    outputsBytes: outputs.bytes,
    journalFiles: journal.files,
    notesFiles: notes.files,
    outputsFiles: outputs.files,
    archiveFiles: archive.files,
    archiveBytes: archive.bytes,
    limits: {
      outputsRetentionDays: OUTPUTS_RETENTION_DAYS,
      journalArchiveAfterDays: JOURNAL_ARCHIVE_AFTER_DAYS,
      journalMaxFiles: JOURNAL_MAX_FILES,
      noteTotalBytesLimit: NOTE_TOTAL_BYTES_LIMIT,
      archiveSoftBytesLimit: ARCHIVE_SOFT_BYTES_LIMIT,
    },
    capsReached: {
      journalOverMax: journal.files > JOURNAL_MAX_FILES,
      notesOverBytes: notes.bytes > NOTE_TOTAL_BYTES_LIMIT,
      archiveOverSoft: archive.bytes > ARCHIVE_SOFT_BYTES_LIMIT,
    },
  }
}

/** 清理结果：只清 outputs/ 里过期的文件，删完顺手收掉空目录。 */
export interface TidyReport {
  removed: number
  freedBytes: number
  /** 清理后 outputs/ 的占用 */
  outputsBytes: number
}

/**
 * 清理 outputs/ 里超过保留期的文件。
 * 安全边界：只动 `outputs/` 下的普通文件；`journal/`、`notes/`、`AGENTS.md` 一概不碰；
 * 解析后的真实路径必须仍在 outputs 根内（不跟随符号链接出去的路径）。
 */
export function tidyAssistantHome(now = Date.now(), retentionDays = OUTPUTS_RETENTION_DAYS): TidyReport {
  const root = resolvePath(join(assistantHomeDir(), 'outputs'))
  const cutoff = now - Math.max(0, retentionDays) * 24 * 60 * 60 * 1000
  let removed = 0
  let freedBytes = 0

  const sweep = (dir: string): boolean => {
    let empty = true
    let entries: any[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const real = resolvePath(path)
      if (real !== root && !real.startsWith(root + sep)) continue
      if (entry.isDirectory()) {
        const childEmpty = sweep(real)
        if (childEmpty) { try { rmdirSync(real); } catch { empty = false } }
        else empty = false
        continue
      }
      if (!entry.isFile()) continue
      empty = false
      try {
        const info = statSync(real)
        if (info.mtimeMs >= cutoff) continue
        unlinkSync(real)
        removed += 1
        freedBytes += info.size
      } catch { /* 删不掉（占用/权限）就留着，下次再说 */ }
    }
    return empty
  }

  // 根目录本身不删；先看看是否为空，避免扫不存在的目录
  try { if (!statSync(root).isDirectory()) return { removed: 0, freedBytes: 0, outputsBytes: 0 } } catch {
    return { removed: 0, freedBytes: 0, outputsBytes: 0 }
  }
  sweep(root)
  return { removed, freedBytes, outputsBytes: dirUsage(root).bytes }
}

/**
 * journal / notes 的容量策略（P0-3）：**归档，不删除**。
 *
 * journal/：
 *   - 文件名 `YYYY-MM-DD.md` 的日期早于 JOURNAL_ARCHIVE_AFTER_DAYS → 移到 archive/journal/<年>/；
 *   - 文件数超过 JOURNAL_MAX_FILES → 最旧的也移到 archive/journal/。
 * notes/：
 *   - 总字节超过 NOTE_TOTAL_BYTES → 最旧的整份移到 archive/notes/（单份体积只报告、不动，
 *     因为拆文件/截内容会改到用户内容，插件不该那么做）。
 *
 * 归档目录 archive/ 永远不删东西；超过 ARCHIVE_SOFT_BYTES_LIMIT 只报告「该自己清一清了」。
 */
export interface RotationReport {
  journalArchived: number
  notesArchived: number
  movedBytes: number
  /** 归档目录已接近上限：UI 该提示用户自己清（插件不删） */
  archiveSoftLimitReached: boolean
  archiveBytes: number
}

function listFiles(dir: string, depth = 4): { name: string; path: string; size: number; mtimeMs: number }[] {
  const out: { name: string; path: string; size: number; mtimeMs: number }[] = []
  const walk = (current: string, level: number): void => {
    if (level > depth) return
    let entries: any[]
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) { walk(path, level + 1); continue }
      if (!entry.isFile()) continue
      try {
        const info = statSync(path)
        out.push({ name: entry.name, path, size: info.size, mtimeMs: info.mtimeMs })
      } catch { /* 竞态删除 */ }
    }
  }
  walk(dir, 1)
  return out
}

/** 把文件挪进归档目录（同盘 rename；跨盘失败就 copy+删原件）。绝不跟随符号链接出助手目录。 */
function moveToArchive(file: { path: string; name: string }, archiveRoot: string, homeRoot: string, sub: string[]): boolean {
  const real = resolvePath(file.path)
  if (!real.startsWith(homeRoot + sep)) return false
  const targetDir = join(archiveRoot, ...sub)
  try { mkdirSync(targetDir, { recursive: true }) } catch { return false }
  const target = join(targetDir, file.name)
  if (existsSync(target)) return false
  try {
    renameSync(real, target)
    return true
  } catch { /* 跨盘：换 copy */ }
  try {
    copyFileSync(real, target)
    unlinkSync(real)
    return true
  } catch { return false }
}

export function rotateAssistantHome(now = Date.now()): RotationReport {
  const dir = assistantHomeDir()
  const journalDir = join(dir, 'journal')
  const notesDir = join(dir, 'notes')
  const archiveDir = join(dir, 'archive')
  const report: RotationReport = {
    journalArchived: 0,
    notesArchived: 0,
    movedBytes: 0,
    archiveSoftLimitReached: false,
    archiveBytes: 0,
  }
  const dayMs = 24 * 60 * 60 * 1000

  // ── journal：按日期归档超期的，再按条数归档最旧的 ──
  const journalFiles = listFiles(journalDir)
  const dated = journalFiles
    .map((file) => ({ file, date: file.name.match(/^(\d{4})-(\d{2})-(\d{2})/)?.[0] ?? '' }))
    .filter((item) => item.date !== '')
  const cutoff = now - JOURNAL_ARCHIVE_AFTER_DAYS * dayMs
  for (const item of dated) {
    const stamp = Date.parse(`${item.date}T23:59:59`)
    if (!Number.isFinite(stamp) || stamp >= cutoff) continue
    const year = item.date.slice(0, 4)
    if (moveToArchive(item.file, archiveDir, dir, ['journal', year])) {
      report.journalArchived += 1
      report.movedBytes += item.file.size
    }
  }
  const remaining = listFiles(journalDir)
  if (remaining.length > JOURNAL_MAX_FILES) {
    const overflow = remaining.sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, remaining.length - JOURNAL_MAX_FILES)
    for (const file of overflow) {
      if (moveToArchive(file, archiveDir, dir, ['journal', 'overflow'])) {
        report.journalArchived += 1
        report.movedBytes += file.size
      }
    }
  }

  // ── notes：总字节超上限时把最旧的整份挪进归档 ──
  let notesBytes = listFiles(notesDir).reduce((sum, file) => sum + file.size, 0)
  if (notesBytes > NOTE_TOTAL_BYTES_LIMIT) {
    const oldest = listFiles(notesDir).sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of oldest) {
      if (notesBytes <= NOTE_TOTAL_BYTES_LIMIT) break
      if (moveToArchive(file, archiveDir, dir, ['notes'])) {
        report.notesArchived += 1
        report.movedBytes += file.size
        notesBytes -= file.size
      }
    }
  }

  const archive = dirUsage(archiveDir)
  report.archiveBytes = archive.bytes
  report.archiveSoftLimitReached = archive.bytes > ARCHIVE_SOFT_BYTES_LIMIT
  return report
}

/** 家目录里的文件清单（journal / notes / outputs / archive 各区，带体积与修改时间）：面板显示「有哪些」。 */
export interface AssistantFileItem {
  name: string
  path: string
  bytes: number
  mtimeMs: number
  /** 相对助手目录的子目录（'journal' | 'notes' | 'outputs' | 'archive'） */
  area: string
}

export function assistantHomeFiles(limitPerArea = 200): Record<string, AssistantFileItem[]> {
  const dir = assistantHomeDir()
  const out: Record<string, AssistantFileItem[]> = {}
  for (const area of ['journal', 'notes', 'outputs', 'archive']) {
    const files = listFiles(join(dir, area))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limitPerArea)
      .map((file) => ({ name: file.name, path: file.path, bytes: file.size, mtimeMs: file.mtimeMs, area }))
    out[area] = files
  }
  return out
}

function readTextIfExists(path: string, limit = 200 * 1024): string {
  try {
    if (!existsSync(path)) return ''
    if (statSync(path).size > limit) return ''
    return readFileSync(path, 'utf8')
  } catch { return '' }
}

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  } catch { /* 客户端已断开 */ }
}

function readJsonBody(req: any, limitBytes: number): Promise<any> {
  return new Promise((resolve) => {
    let size = 0
    let raw = ''
    let tooLarge = false
    req.on('data', (chunk: any) => {
      size += Buffer.byteLength(chunk)
      if (size > limitBytes) { tooLarge = true; return }
      if (!tooLarge) raw += String(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return resolve({ __tooLarge: true })
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 注册助手相关路由：
 *   GET  /api/assistant/home              → 目录 / 各区 / 体积 / 文件清单 / 容量上限
 *   GET  /api/assistant/memory            → USER.md / MEMORY.md 正文 + 条目数组 + 能不能删
 *   GET  /api/assistant/tidy              → 体积报告（不删）
 *   POST /api/assistant/tidy              → 清 outputs/ 过期 + 归档 journal/notes 溢出
 *   POST /api/assistant/memory-entry-delete { target, content, mode? }
 *   POST /api/assistant/memory-clear        { target, confirm: 'DELETE-ALL' }
 * 写回的两条改的是宿主进程负责的记忆文件：要在页面上看到变化，需要重启 DSH Desktop。
 */
export function registerAssistantHome(ctx: any): () => void {
  // 目录与 AGENTS.md 与路由无关：没有 webServer 也要先把「家」建好，会话才有人设。
  const home = ensureAssistantHome()
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  const webServer = routes.webServer

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/home',
    handler: (_req: any, res: any) => {
      const current = ensureAssistantHome()
      sendJson(res, 200, {
        ok: true,
        dir: current.dir,
        journal: current.journal,
        notes: current.notes,
        outputs: current.outputs,
        archive: current.archive,
        hasAgents: existsSync(current.agentsFile),
        marker: AGENTS_MARKER,
        usage: assistantHomeUsage(),
        files: assistantHomeFiles(),
        retentionDays: OUTPUTS_RETENTION_DAYS,
      })
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/memory',
    handler: (_req: any, res: any) => {
      // 真源在 mnemon 的运行时目录；面板要的是「条目 + 正文 + 能不能删」
      const view = readRuntimeMemory()
      const runtime = view.dir
      const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
      const pick = (name: string): string =>
          // 老版本 / 没装 mnemon：退回 $DSH_HOME 里的那份投影
        readTextIfExists(join(runtime, name)) || readTextIfExists(join(dshHome, name))
      const user = view.targets.find((target) => target.target === 'user')
      const memory = view.targets.find((target) => target.target === 'memory')
      sendJson(res, 200, {
        ...view,
        dir: home.dir,
        memoryDir: runtime,
        user: user?.text ?? pick('USER.md'),
        memory: memory?.text ?? pick('MEMORY.md'),
        agents: readTextIfExists(join(home.dir, 'AGENTS.md')),
      })
    },
  })

  // 写回（P0-2）：删除一条 / 清空一侧。备份 → 真源 → 投影；必须重启 DSH 才生效。
  webServer.register({
    kind: 'exact',
    path: '/api/assistant/memory-entry-delete',
    handler: (req: any, res: any) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return }
      void readJsonBody(req, 128 * 1024).then((body) => {
        if (body?.__tooLarge) { sendJson(res, 413, { ok: false, error: 'body-too-large' }); return }
        const target = body?.target === 'user' || body?.target === 'memory' ? body.target : null
        const content = String(body?.content ?? '')
        if (!target) { sendJson(res, 400, { ok: false, error: 'need-target' }); return }
        if (!content.trim()) { sendJson(res, 400, { ok: false, error: 'need-content' }); return }
        const mode = body?.mode === 'contains' ? 'contains' : 'exact'
        const result = deleteRuntimeMemoryEntry(target as 'user' | 'memory', content, mode)
        sendJson(res, result.ok ? 200 : 409, { ...result, restartRequired: true })
      })
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/memory-clear',
    handler: (req: any, res: any) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return }
      void readJsonBody(req, 128 * 1024).then((body) => {
        if (body?.__tooLarge) { sendJson(res, 413, { ok: false, error: 'body-too-large' }); return }
        const target = body?.target === 'user' || body?.target === 'memory' ? body.target : null
        if (!target) { sendJson(res, 400, { ok: false, error: 'need-target' }); return }
        // 清空必须显式确认：UI 得先问一句再发 confirm:'DELETE-ALL'
        if (String(body?.confirm ?? '') !== 'DELETE-ALL') { sendJson(res, 400, { ok: false, error: 'need-confirmation' }); return }
        const result = clearRuntimeMemory(target as 'user' | 'memory')
        sendJson(res, result.ok ? 200 : 409, { ...result, restartRequired: true })
      })
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/tidy',
    handler: (req: any, res: any) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method !== 'POST') {
        sendJson(res, 200, { ok: true, usage: assistantHomeUsage(), retentionDays: OUTPUTS_RETENTION_DAYS })
        return
      }
      const report = tidyAssistantHome()
      const rotation = rotateAssistantHome()
      sendJson(res, 200, {
        ok: true,
        removed: report.removed,
        freedBytes: report.freedBytes,
        rotation,
        usage: assistantHomeUsage(),
        retentionDays: OUTPUTS_RETENTION_DAYS,
      })
    },
  })

  // 自动整理：启动 30 秒后跑一次，之后每 6 小时一次。
  //   - outputs/ 里超过保留期的文件删掉（杂物间）
  //   - journal / notes 超出容量策略的搬进 archive/（归档，绝不删）
  // unref：不让这个定时器拖住宿主/测试进程退出。
  let timer: ReturnType<typeof setInterval> | null = null
  let firstRun: ReturnType<typeof setTimeout> | null = null
  try {
    const runTidy = (): void => {
      try {
        const report = tidyAssistantHome()
        const rotation = rotateAssistantHome()
        if (report.removed > 0) {
          try { ctx?.logger?.('dsh-assistant')?.info?.(`assistant outputs tidied: ${report.removed} files, ${report.freedBytes} bytes`) } catch {}
        }
        if (rotation.journalArchived + rotation.notesArchived > 0) {
          try {
            ctx?.logger?.('dsh-assistant')?.info?.(`assistant journal/notes archived: ${rotation.journalArchived} + ${rotation.notesArchived} files, ${rotation.movedBytes} bytes`)
          } catch {}
        }
        if (rotation.archiveSoftLimitReached) {
          try { ctx?.logger?.('dsh-assistant')?.warn?.(`assistant archive 超过 ${ARCHIVE_SOFT_BYTES_LIMIT} 字节软上限：插件不再自动搬，请自己清 archive/`) } catch {}
        }
      } catch { /* 整理失败不影响助手使用 */ }
    }
    firstRun = setTimeout(runTidy, 30_000)
    firstRun.unref?.()
    timer = setInterval(runTidy, TIDY_INTERVAL_MS)
    timer.unref?.()
  } catch { /* 拿不到定时器就只留手动清理 */ }

  return () => {
    try { if (firstRun) clearTimeout(firstRun) } catch {}
    try { if (timer) clearInterval(timer) } catch {}
    try { routes.dispose() } catch {}
  }
}

/** 供单测使用：导出 AGENTS.md 模板（不含运行时拼接）。 */
export const ASSISTANT_AGENTS_TEMPLATE = AGENTS_MD
