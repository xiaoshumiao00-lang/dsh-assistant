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
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { manageWebRoutes } from './web-routes'

/** AGENTS.md 的版本标记：只在缺失时写；以后改内容靠这个标记判断要不要提示升级。 */
const AGENTS_MARKER = '<!-- dsh-assistant:assistant-home v1 -->'

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
  /** AGENTS.md 是否由本插件写入/已存在 */
  agentsFile: string
}

/** 助手家的路径（可用 DSH_ASSISTANT_HOME 覆盖，便于测试）。 */
export function assistantHomeDir(): string {
  const override = String(process.env.DSH_ASSISTANT_HOME ?? '').trim()
  return override !== '' ? override : join(homedir(), '.dsh', 'assistant')
}

/** 确保目录与 AGENTS.md 存在。已存在的 AGENTS.md 一律不动（用户可能手改过）。 */
export function ensureAssistantHome(): AssistantHome {
  const dir = assistantHomeDir()
  const journal = join(dir, 'journal')
  const notes = join(dir, 'notes')
  const agentsFile = join(dir, 'AGENTS.md')
  for (const path of [dir, journal, notes]) {
    try { mkdirSync(path, { recursive: true }) } catch { /* 权限问题不阻塞启动，路由会再报 */ }
  }
  try {
    if (!existsSync(agentsFile)) writeFileSync(agentsFile, AGENTS_MD, 'utf8')
  } catch { /* 只读盘：会话仍可跑，只是没有人设 */ }
  return { dir, journal, notes, agentsFile }
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

/**
 * 注册助手相关路由：
 *   GET /api/assistant/home   → { dir, agents, journal, notes }（客户端据此建会话）
 *   GET /api/assistant/memory → { user, memory, agents }（「你记得我什么」的原始文本）
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
        hasAgents: existsSync(current.agentsFile),
        marker: AGENTS_MARKER,
      })
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/assistant/memory',
    handler: (_req: any, res: any) => {
      const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
      sendJson(res, 200, {
        ok: true,
        dir: home.dir,
        user: readTextIfExists(join(dshHome, 'USER.md')),
        memory: readTextIfExists(join(dshHome, 'MEMORY.md')),
        agents: readTextIfExists(join(home.dir, 'AGENTS.md')),
      })
    },
  })

  return routes.dispose
}

/** 供单测使用：导出 AGENTS.md 模板（不含运行时拼接）。 */
export const ASSISTANT_AGENTS_TEMPLATE = AGENTS_MD
