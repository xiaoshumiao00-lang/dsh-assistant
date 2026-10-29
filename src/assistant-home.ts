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
 *
 * 为什么要有 outputs 与自动清理：
 *   - **会话记录不在这里**：DSH 把每个会话的日志存在 `~/.dsh/sessions/<编码目录>/`，
 *     项目文件夹只承接「写出来的文件」，所以不会因为聊得多而膨胀；
 *   - 但助手确实会写文件，都落在 cwd（= 这个目录）。家目录因此必须分成
 *     「记忆资产（AGENTS.md / journal / notes）」与「杂物（outputs）」，后者按保留期清掉，
 *     否则一年下来就是一堆一次性脚本和截图；
 *   - 要长期保留的产物应该走「建卡」：那才是产物该待的地方（项目文件夹里，看得见、能交付）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import { manageWebRoutes } from './web-routes'

/** AGENTS.md 的版本标记：只在缺失时写；以后改内容靠这个标记判断要不要提示升级。 */
const AGENTS_MARKER = '<!-- dsh-assistant:assistant-home v1 -->'
/** 追加段落标记：老文件已存在时不整份重写，只把这节补在后面（一次）。 */
const HOME_RULES_MARKER = '<!-- dsh-assistant:home-rules v2 -->'
/** outputs/ 的保留天数。 */
export const OUTPUTS_RETENTION_DAYS = 14
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

const AGENTS_MD = `${AGENTS_MARKER}
# 私人助手（陈潘）

你是陈潘的私人助手：不是任务启动器，也不是通用客服。你住在这个目录里，
长期记得他做过什么、怎么做事、要什么标准。

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
  /** AGENTS.md 是否由本插件写入/已存在 */
  agentsFile: string
}

/** 助手家的路径（可用 DSH_ASSISTANT_HOME 覆盖，便于测试）。 */
export function assistantHomeDir(): string {
  const override = String(process.env.DSH_ASSISTANT_HOME ?? '').trim()
  return override !== '' ? override : join(homedir(), '.dsh', 'assistant')
}

/** 确保目录与 AGENTS.md 存在。已存在的 AGENTS.md 一律不动（用户可能手改过），
 *  只补一次缺少的「家目录规矩」小节。 */
export function ensureAssistantHome(): AssistantHome {
  const dir = assistantHomeDir()
  const journal = join(dir, 'journal')
  const notes = join(dir, 'notes')
  const outputs = join(dir, 'outputs')
  const agentsFile = join(dir, 'AGENTS.md')
  for (const path of [dir, journal, notes, outputs]) {
    try { mkdirSync(path, { recursive: true }) } catch { /* 权限问题不阻塞启动，路由会再报 */ }
  }
  try {
    if (!existsSync(agentsFile)) writeFileSync(agentsFile, AGENTS_MD, 'utf8')
    // 新装 / 老 v1 文件都补齐「家目录规矩」：只在缺这一节时追加，绝不整份覆盖。
    const current = readFileSync(agentsFile, 'utf8')
    if (current.includes(AGENTS_MARKER) && !current.includes(HOME_RULES_MARKER)) {
      writeFileSync(agentsFile, current.replace(/\s*$/, '\n\n') + HOME_RULES_MD, 'utf8')
    }
  } catch { /* 只读盘：会话仍可跑，只是没有人设 */ }
  return { dir, journal, notes, agentsFile, outputs }
}

/** 目录体积（只统计自家四个区，不递归乱扫）。 */
export interface AssistantHomeUsage {
  totalBytes: number
  totalFiles: number
  journalBytes: number
  notesBytes: number
  outputsBytes: number
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
  let agents = 0
  try { agents = statSync(join(dir, 'AGENTS.md')).size } catch { /* 没有也行 */ }
  return {
    totalBytes: agents + journal.bytes + notes.bytes + outputs.bytes,
    totalFiles: journal.files + notes.files + outputs.files,
    journalBytes: journal.bytes,
    notesBytes: notes.bytes,
    outputsBytes: outputs.bytes,
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

/** mnemon 运行时记忆目录（USER.md / MEMORY.md 投影所在）：支持 MNEMON_DATA_DIR 覆盖。 */
export function runtimeMemoryDir(): string {
  const override = String(process.env.MNEMON_DATA_DIR ?? '').trim()
  if (override !== '') return override.replace(/^~(?=$|[\\/])/, homedir())
  return join(homedir(), '.mnemon', 'runtime')
}

/**
 * 注册助手相关路由：
 *   GET  /api/assistant/home   → 目录 / 各子目录 / 体积
 *   GET  /api/assistant/memory → { user, memory, agents }（「你记得我什么」的原始文本）
 *   GET  /api/assistant/tidy   → 体积报告（不删）
 *   POST /api/assistant/tidy   → 清 outputs/ 过期文件，返回清理结果
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
        hasAgents: existsSync(current.agentsFile),
        marker: AGENTS_MARKER,
        usage: assistantHomeUsage(),
        retentionDays: OUTPUTS_RETENTION_DAYS,
      })
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/memory',
    handler: (_req: any, res: any) => {
      // 真值在 mnemon 的运行时目录（~/.mnemon/runtime）；老版本/没装 mnemon 时退回 $DSH_HOME。
      const runtime = runtimeMemoryDir()
      const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
      const pick = (name: string): string =>
        readTextIfExists(join(runtime, name)) || readTextIfExists(join(dshHome, name))
      sendJson(res, 200, {
        ok: true,
        dir: home.dir,
        user: pick('USER.md'),
        memory: pick('MEMORY.md'),
        agents: readTextIfExists(join(home.dir, 'AGENTS.md')),
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
      sendJson(res, 200, {
        ok: true,
        removed: report.removed,
        freedBytes: report.freedBytes,
        usage: assistantHomeUsage(),
        retentionDays: OUTPUTS_RETENTION_DAYS,
      })
    },
  })

  // 自动清理：启动 30 秒后跑一次，之后每 6 小时一次。只动 outputs/，不碰记忆资产。
  // unref：不让这个定时器拖住宿主/测试进程退出。
  let timer: ReturnType<typeof setInterval> | null = null
  let firstRun: ReturnType<typeof setTimeout> | null = null
  try {
    const runTidy = (): void => {
      try {
        const report = tidyAssistantHome()
        if (report.removed > 0) {
          try { ctx?.logger?.('dsh-assistant')?.info?.(`assistant outputs tidied: ${report.removed} files, ${report.freedBytes} bytes`) } catch {}
        }
      } catch { /* 清理失败不影响助手使用 */ }
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
