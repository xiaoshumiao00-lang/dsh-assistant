/**
 * 个人秘书「主动服务卡片」——卡片数据的宿主侧真值。
 *
 * 为什么要有宿主侧存储：
 *   标准会话页只负责把消息/扩展位渲染出来，卡片内容得有个可增删的地方。
 *   秘书（或宿主里的定时主动服务）往这里写一张卡，会话页的「本轮尾部」扩展位
 *   就会按同一套形状把它渲染成卡片——以后每条主动消息都是这个形状，不需要改前端。
 *
 * 卡的形状（与客户端展示层约定一致；2026-11-21 起末尾「尾巴卡」渲染已按用户要求移除，
 * 本模块只保留数据能力：卡组存储 + 路由 + proactive_card 工具 + 首次示例卡）：
 *   { id, title, summary?, items?: string[], details?, time?, badge? }
 *   sessionId 为空串 = 绑到「当前固定秘书会话」（id 换了也跟着走）。
 *
 * 路由：
 *   GET    /api/assistant/proactive?sessionId=…  → { ok, cards }
 *   POST   /api/assistant/proactive              → 追加一张卡（body = 卡）
 *   DELETE /api/assistant/proactive              → 清空（测试/重置）
 *
 * 首次启动会**种一张真实示例卡**（明日武汉出差），让用户在重启后打开秘书就能看到
 * 卡片长什么样；种子只写一次，用户/测试清掉后不会再自动回来。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { manageWebRoutes } from './web-routes'
import { secretarySessionRef } from './assistant-secretary'

export const ASSISTANT_PROACTIVE_ROUTE = '/api/assistant/proactive'
export const PROACTIVE_CARD_TOOL = 'proactive_card'
const STATE_FILENAME = 'dsh-assistant-proactive.json'
const MAX_CARDS = 40
const MAX_BODY_BYTES = 64 * 1024

/** 一张主动服务卡。 */
export interface ProactiveCardRecord {
  id: string
  /** 绑定的会话；空串 = 当前固定秘书会话。 */
  sessionId: string
  title: string
  summary: string
  items: string[]
  details: string
  time: string
  badge: string
  createdAt: string
  /** 引用的会话（可选）：卡片渲染成可点引用块，点击按会话 id 跳进对应会话。 */
  refSessionId?: string
  refTitle?: string
}

/** 示例卡（明日武汉出差）——交付时给用户看效果的那一张。 */
export function demoCard(now: Date = new Date()): ProactiveCardRecord {
  return {
    id: 'demo-wuhan-trip',
    sessionId: '',
    title: '主动关心 · 明日武汉出差',
    summary: '明天去武汉开会，行程、车次和天气都替你核过了。',
    items: [
      '天气：武汉明日 8–14℃，多云转小雨，带伞和薄外套',
      '车次：G1545 孝感东 08:12 → 汉口 08:49',
      '10:30 华工·结构实验室开会（材料已放进 notes/）',
      '建议 07:30 从家出发，留 40 分钟进站',
    ],
    details: [
      '一、天气',
      '武汉全天 8–14℃，多云转小雨，上午湿度高；会场空调偏冷，建议穿外套。',
      '',
      '二、行程',
      '· 07:30 出发 → 孝感东站（预留 40 分钟进站）',
      '· 08:12 G1545 孝感东 → 08:49 汉口',
      '· 09:20 汉口站打车去华工（约 40 分钟，预留堵车）',
      '· 10:30 结构实验室开会（带上打印版材料与 U 盘）',
      '',
      '三、备注',
      '回程票还没订；会议若提前结束，15:00 后有一班返程可选。',
    ].join('\n'),
    time: '今天 07:40',
    badge: '主动服务',
    createdAt: now.toISOString(),
  }
}

/** 防御式归一：坏字段一律回落成空串/空数组，绝不让客户端拿到半成品。 */
export function normalizeCard(raw: unknown, now: Date = new Date()): ProactiveCardRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const title = String(record.title ?? '').trim()
  if (title === '') return null
  const items = Array.isArray(record.items)
    ? record.items.map((entry) => String(entry ?? '').trim()).filter((entry) => entry !== '').slice(0, 12)
    : []
  return {
    id: String(record.id ?? '').trim() || `card-${randomUUID()}`,
    sessionId: String(record.sessionId ?? '').trim(),
    title: title.slice(0, 120),
    summary: String(record.summary ?? '').trim().slice(0, 400),
    items,
    details: String(record.details ?? '').trim().slice(0, 4000),
    time: String(record.time ?? '').trim().slice(0, 40) || `今天 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    badge: String(record.badge ?? '').trim().slice(0, 20) || '主动服务',
    createdAt: String(record.createdAt ?? '').trim() || now.toISOString(),
    refSessionId: String(record.refSessionId ?? '').trim().slice(0, 80) || undefined,
    refTitle: String(record.refTitle ?? '').trim().slice(0, 120) || undefined,
  }
}

/** 某会话该看到的卡：绑该会话的 + 绑「当前秘书会话」的。 */
export function cardsForSession(cards: ProactiveCardRecord[], sessionId: string, secretaryId: string): ProactiveCardRecord[] {
  const id = String(sessionId ?? '').trim()
  if (id === '') return []
  return cards.filter((card) => {
    const bound = card.sessionId
    if (bound === id) return true
    if (bound === '') return id === secretaryId
    return false
  })
}

function profileDir(ctx: any): string {
  try {
    const p = ctx?.get?.('profileContext')
    if (p && typeof p.dir === 'string' && p.dir) return p.dir
  } catch {}
  try {
    const h = ctx?.get?.('homePaths')
    if (h && typeof h.home === 'string' && h.home) return h.home
  } catch {}
  return process.env.DSH_HOME || process.cwd()
}

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    let size = 0
    req.on('data', (chunk: any) => {
      const text = String(chunk ?? '')
      size += Buffer.byteLength(text)
      if (size <= MAX_BODY_BYTES) raw += text
    })
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) { resolve({ __tooLarge: true }); return }
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/** 读卡组文件（不存在/坏了 → 空数组）。 */
export function readCardsFile(file: string): ProactiveCardRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed?.cards) ? parsed.cards : []
    const out: ProactiveCardRecord[] = []
    for (const row of list) {
      const card = normalizeCard(row)
      if (card !== null) out.push(card)
    }
    return out
  } catch {
    return []
  }
}

function writeCardsFile(file: string, cards: ProactiveCardRecord[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, cards: cards.slice(-MAX_CARDS) }, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 工具定义：让秘书（模型）自己把主动消息落成一张卡。 */
export function proactiveCardToolDefinition(): any {
  return {
    name: PROACTIVE_CARD_TOOL,
    description: [
      '把一条主动服务消息落成会话页里的一张卡片（只对个人秘书会话生效）。',
      '用户在会话里看不到你调用了工具，只看到卡片；卡片可以点开看 details。',
      '什么时候用：你想主动提醒/汇报/汇报进度，并且内容适合「标题 + 摘要 + 要点 + 详情」这种结构化形态时。',
      '什么时候别用：普通问答、代码、长文分析——直接写在回复里更合适。',
      'items 是要点（每条一行，最多 12 条）；details 是展开后的详情（可多行）。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '卡片标题，例如「主动关心 · 明日武汉出差」。必填。' },
        summary: { type: 'string', description: '卡片摘要（一两句）。' },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: '要点列表（每条一行）。',
        },
        details: { type: 'string', description: '点开「查看详情」后显示的正文（可多行）。' },
        time: { type: 'string', description: '卡片右下角时间，例如「今天 07:40」；省略则用当前时间。' },
        badge: { type: 'string', description: '左上角小标签，默认「主动服务」。' },
        ref_session_id: { type: 'string', description: '卡片引用的会话 id（可选）：渲染成可点引用块，点击跳进该会话。' },
        ref_title: { type: 'string', description: '引用会话的显示标题（可选，默认用 ref_session_id）。' },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          card_id: { type: 'string' },
        },
        required: ['ok', 'card_id'],
      },
      render: (_args: unknown, value: any): any[] => [{
        type: 'text',
        text: value?.ok === true ? `已发出一条主动服务卡片（${value?.card_id ?? ''}）。` : '卡片没有发出去。',
      }],
    },
    isConcurrencySafe: () => false,
    execute: async (args: any, exec: any): Promise<any> => {
      const caller = String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? '')
      if (secretarySessionRef.id === '' || caller !== secretarySessionRef.id) {
        throw new Error(`${PROACTIVE_CARD_TOOL} 只能在个人秘书会话里调用`)
      }
      const card = normalizeCard({
        ...args,
        sessionId: '',
        refSessionId: args?.ref_session_id,
        refTitle: args?.ref_title,
      })
      if (card === null) throw new Error('title 不能为空')
      appendCard(card)
      return { ok: true, card_id: card.id }
    },
  }
}

/**
 * 模块级卡组（一个宿主进程只有一份）。
 * 为什么不是每个 register 实例各存一份：proactive_card 工具是全局注册的，工具里拿不到
 * 某一次 register 的闭包；再加上热重载会再注册一次，实例各存一份会出现「工具写进旧实例、
 * 路由读的是新实例」—— 实测就是 POST 之后 GET 看不到（单测直接抓到）。这里统一成
 * 「磁盘文件 → 模块级数组 → 保存」三段式，重新注册时从磁盘重读，天然一致。
 */
let moduleFile = ''
let moduleCards: ProactiveCardRecord[] = []

/** 保存模块级卡组（写盘失败只告警）。 */
function saveModuleCards(): void {
  if (moduleFile === '') return
  try { writeCardsFile(moduleFile, moduleCards) } catch (error) {
    try { console.warn('[dsh-assistant] 主动卡片写入失败：', String((error as Error)?.message ?? error)) } catch {}
  }
}

/** 追加一张卡（同 id 覆盖），供路由与 proactive_card 工具共用。 */
export function appendCard(card: ProactiveCardRecord): void {
  moduleCards = [...moduleCards.filter((row) => row.id !== card.id), card].slice(-MAX_CARDS)
  saveModuleCards()
}

/** 当前卡组（只读快照）。 */
export function cardsSnapshot(): ProactiveCardRecord[] {
  return moduleCards
}

export function registerAssistantProactive(ctx: any): () => void {
  const server = ctx?.webServer
  if (!server || typeof server.register !== 'function') return () => void 0
  const routes = manageWebRoutes(server)
  const webServer = routes.webServer
  const file = join(profileDir(ctx), STATE_FILENAME)
  // 重新注册（热重载/测试）时从磁盘重读，模块级数组保持一致。
  moduleFile = file
  moduleCards = readCardsFile(file)

  // 首次启动种一张示例卡：用户重启后打开秘书就能看到卡片渲染效果。
  // 用一个独立的 marker 文件保证「只种一次」——用户删掉后不会每次启动又回来。
  const seededFile = `${file}.seeded`
  try {
    if (!existsSync(seededFile)) {
      if (!moduleCards.some((card) => card.id === 'demo-wuhan-trip')) appendCard(demoCard())
      writeFileSync(seededFile, new Date().toISOString(), 'utf8')
    }
  } catch { /* 种卡失败不影响路由 */ }

  const disposers: Array<() => void> = []
  try {
    const off = webServer.register({
      kind: 'exact',
      path: ASSISTANT_PROACTIVE_ROUTE,
      handler: async (req: any, res: any) => {
        const method = String(req.method ?? 'GET').toUpperCase()
        try {
          if (method === 'GET' || method === 'HEAD') {
            const url = new URL(String(req.url ?? ''), 'http://127.0.0.1')
            const sessionId = String(url.searchParams.get('sessionId') ?? '')
            const visible = cardsForSession(moduleCards, sessionId, secretarySessionRef.id)
            sendJson(res, 200, { ok: true, cards: visible, secretarySessionId: secretarySessionRef.id })
            return
          }
          if (method === 'POST' || method === 'PUT') {
            const body = await readJsonBody(req)
            if (body?.__tooLarge === true) { sendJson(res, 413, { ok: false, error: 'too-large' }); return }
            const card = normalizeCard(body)
            if (card === null) { sendJson(res, 400, { ok: false, error: 'invalid-card' }); return }
            appendCard(card)
            sendJson(res, 200, { ok: true, card })
            return
          }
          if (method === 'DELETE') {
            moduleCards = []
            saveModuleCards()
            sendJson(res, 200, { ok: true, cards: [] })
            return
          }
          res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, DELETE' })
          res.end()
        } catch (error) {
          sendJson(res, 500, { ok: false, error: 'internal', message: String((error as Error)?.message ?? error) })
        }
      },
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] 主动卡片路由注册失败：${String((error as Error)?.message ?? error)}`)
  }

  try {
    if (ctx?.tools && typeof ctx.tools.register === 'function') {
      const off = ctx.tools.register(proactiveCardToolDefinition())
      if (typeof off === 'function') disposers.push(off)
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-assistant] proactive_card 工具注册失败：${String((error as Error)?.message ?? error)}`)
  }

  return () => {
    // 卡组留在内存里：宿主卸载/热重载后重新注册会从磁盘重读，
    // 这里清空只会让「工具刚写的卡」在下一次 GET 前凭空消失（单测抓过）。
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
    try { routes.dispose() } catch {}
  }
}

/** 单测入口。 */
export const assistantProactiveTestSurface = {
  ASSISTANT_PROACTIVE_ROUTE,
  PROACTIVE_CARD_TOOL,
  normalizeCard,
  cardsForSession,
  readCardsFile,
  demoCard,
  appendCard,
  cardsSnapshot,
  proactiveCardToolDefinition,
  registerAssistantProactive,
  rmSync,
}
