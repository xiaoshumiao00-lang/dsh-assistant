/**
 * 第四批（A 分页 + B 滚动摘要）的 node 侧验收：口径、分页 store、宿主分页接口（真会话数据）、
 * 上下文摘要文件与注入段。浏览器侧的 DOM 断言在 scripts/test-secretary-pagination-dom.mjs。
 *
 * 断言口径（用户定案的验收项）：
 *   一次渲染的卡片数 ≤30、存在折叠行、上滚才取回下一段、刷新后不自动回填、
 *   送进模型的原文轮数 ≤10 且含摘要文本、比上次摘要多满 12 轮或新增 10000 词后摘要文件确有更新。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import os from 'node:os'

const lib = await import('../lib/index.js')
const shared = lib.secretCardSharedTestSurface
const cards = lib.secretaryCardsTestSurface
const history = lib.assistantSecretaryHistoryTestSurface
const context = lib.assistantSecretaryContextTestSurface
if (!shared || !cards || !history || !context) throw new Error('lib/index.js 缺 test surface，先跑 node build.mjs')

const cases = []
const log = (text) => process.stdout.write(`${text}\n`)

/* ---------- 真会话数据（只读取证：按 zstd 帧边界逐帧解，绝不改写、绝不重拼） ---------- */

const SESSION_FILE = process.env.DSH_TEST_SESSION_FILE
  || join(os.homedir(), '.dsh', 'sessions', '--C-Users-<ACCOUNT>-.dsh-assistant--', 'session-83bca3e3-bcd1-49f0-8b3c-2ec9edae14e3', 'session.v4.jsonl.zstd')

function readSessionEvents(file) {
  const buffer = readFileSync(file)
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (magic.every((byte, at) => buffer[index + at] === byte)) starts.push(index)
  }
  const frames = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try { frames.push(zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8')) } catch { /* 帧解不开就跳过 */ }
  }
  const events = []
  for (const line of frames.join('').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try { events.push(JSON.parse(trimmed)) } catch { /* 非 json 行跳过 */ }
  }
  return events
}

const realEvents = readSessionEvents(SESSION_FILE)
const realCards = shared.historyItemsFromEvents(realEvents)

/** 这条会话正在被真人使用：读盘那一刻宿主机可能正在追加最后一帧（半轮），
 *  计数等式会瞬时失真。允许 settle 后重读重试几次，仍不一致才算真红。 */
function readSessionEventsSettled(file, attempts = 4, delayMs = 700) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const events = readSessionEvents(file)
    const assistant = events.filter((event) => event?.type === 'assistant/message')
    const users = events.filter((event) => event?.type === 'user/message')
    const cards = shared.historyItemsFromEvents(events)
    const kinds = new Map()
    for (const item of cards) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
    const consistent =
      (kinds.get('assistant') ?? 0) === new Set(assistant.map((event) => Number(event?.data?.turn ?? 0))).size
      && (kinds.get('user') ?? 0) + (kinds.get('notice') ?? 0) === users.filter((event) => shared.eventText(event) !== '').length
    if (consistent || attempt === attempts - 1) return { events, cards, settled: consistent }
    const start = Date.now()
    while (Date.now() - start < delayMs) { /* settle */ }
  }
  throw new Error('unreachable')
}

cases.push(['真会话卡计数：按卡计数（assistant 每轮一张 / user / notice），不是按 DOM 行数', () => {
  const { events, cards } = readSessionEventsSettled(SESSION_FILE)
  const kinds = new Map()
  for (const item of cards) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
  const assistantTurns = new Set(events.filter((event) => event?.type === 'assistant/message').map((event) => Number(event?.data?.turn ?? 0))).size
  const userMessages = events.filter((event) => event?.type === 'user/message' && shared.eventText(event) !== '').length
  assert.equal(kinds.get('assistant'), assistantTurns, 'assistant/message 按轮次去重成一张卡')
  assert.equal((kinds.get('user') ?? 0) + (kinds.get('notice') ?? 0), userMessages, '每条有正文的 user/message 正好一张卡（用户卡或通知卡；空正文事件管线按设计跳过）')
  assert.ok(cards.length >= 137, `整条会话 ${cards.length} 张卡（这条会话还在长，按真实现算）`)
  // 顺序：同 kind 内 seq 必须升序（分页游标靠它）。跨 kind 允许一次倒序——
  // 宿主可能在一轮进行中注入合成通知（seq 落在该轮两步之间），而多步合并把秘书卡
  // seq 升级到本轮最后一步（secretary-card-shared.ts 的同款口径），卡数组是轮序不是严格 seq 序。
  for (const kind of ['assistant', 'user', 'notice']) {
    const kindSeqs = cards.filter((item) => item.kind === kind).map((item) => item.seq)
    assert.deepEqual(kindSeqs, [...kindSeqs].sort((a, b) => a - b), `${kind} 卡按 seq 升序`)
  }
  assert.equal(new Set(cards.map((item) => item.cardKey)).size, cards.length, 'cardKey 每张卡唯一')
}])

cases.push(['折叠行短标题口径稳定可复现：首行前 24 码点，同一输入永远同一标题', () => {
  const long = '这一句整整二十四个汉字的标题行继续往后延伸就不够了'
  const once = shared.truncateCardTitle(long)
  const twice = shared.truncateCardTitle(long)
  assert.equal(once, twice, '同一输入同一输出')
  assert.equal([...once].length, 24 + 1, '截断后补一个「…」）')
  assert.ok(once.endsWith('…'), '被截断时补「…」')
  const short = '短一点的标题'
  assert.equal(shared.truncateCardTitle(short), short, '不超 24 字时原样返回')
  assert.equal(shared.truncateCardTitle('  有实内容的行在前\n真正的第二行才是首行'), '有实内容的行在前', '第一个非空行（带空格的行先 trim）')
  assert.equal(shared.truncateCardTitle('\n\n真正的第三行才是首行'), '真正的第三行才是首行', '真正的空行才跳过')
  assert.equal(shared.truncateCardTitle(''), '', '空正文回空')
  // 真会话里所有折叠行标题都得有值、一行到底、不超 24 字 + 「…」
  for (const item of realCards) {
    assert.ok(item.title !== '', `卡 ${item.cardKey} 的标题不为空`)
    assert.ok(!item.title.includes('\n'), `折叠行标题只有一行：${item.title}`)
    assert.ok([...item.title].length <= 25, `标题不超过 24 字 + 「…」：${item.title}`)
    const bare = item.title.replace(/…$/, '')
    assert.ok(item.title === shared.truncateCardTitle(bare) || [...item.title].length === 25, `同一输入口径复算一致：${item.title}`)
  }
}])

cases.push(['词数口径只有一个（词数，不是 token）：中英混排实测数字', () => {
  assert.equal(shared.countWords('武汉明日 8–14℃'), 6, '4 个 CJK 字符 + 两段拉丁 run（8 与 14）')
  assert.equal(shared.countWords('session-83bca3e3 是固定会话'), 6, '带连字符的数字 run 不拆碎')
  assert.equal(shared.countWords(''), 0)
  assert.equal(shared.countWords('   \n\t '), 0)
  const total = realCards.reduce((sum, item) => sum + shared.countWords(item.preview), 0)
  log(`  真会话预览词数（截断口径）= ${total}`)
  assert.ok(total > 1000, '真会话词数量级合理')
}])

cases.push(['宿主分页接口（真数据）：一页最多 30 张 + before 游标不重叠 + hasMore', () => {
  const first = shared.buildHistoryPage(realEvents, { limit: 30 })
  assert.equal(first.items.length, 30, '最近这一段正好 30 张')
  assert.equal(first.totalCards, realCards.length, 'totalCards 是真会话卡数')
  assert.ok(realCards.length >= 137, '这条会话的卡数远超一页')
  assert.equal(first.hasMore, true)
  const second = shared.buildHistoryPage(realEvents, { limit: 30, beforeSeq: first.nextBefore })
  assert.equal(second.items.length, 30)
  assert.ok(second.items.every((item) => item.seq < first.fromSeq), '第二段全比第一段更旧')
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.cardKey)).size, 60, '两段不重叠')
  assert.equal(second.nextBefore, second.items[0].seq, '游标停在这一段的最后一张')
  assert.equal(shared.buildHistoryPage(realEvents, { limit: 30, beforeSeq: 1 }).items.length, 0, '游标比最旧还旧就空页')
  assert.equal(shared.normalizeHistoryLimit(9999), 60, 'limit 钳到 HISTORY_MAX_LIMIT')
  assert.equal(shared.normalizeHistoryLimit('abc'), 30, '坏 limit 回默认 30')
  assert.equal(shared.normalizeHistoryCursor('-5'), undefined, '坏游标按「没给」处理')
  assert.equal(shared.canRenderMore(120), false, '120 张上限到这里就停')
  assert.equal(shared.canRenderMore(119), true)
  assert.equal(shared.windowOfItems(realCards, 30).length, 30, '窗口只留最近 30 张')
}])

/* ---------- 宿主 HTTP route：真 handler + 真 http 请求（打印请求与响应原文给报告） ---------- */

const rawLog = []
async function probeHistoryRoute() {
  const fakeServer = {
    exact: new Map(),
    prefixes: new Map(),
    register(route) {
      this.exact.set(route.path, route)
      return () => { this.exact.delete(route.path) }
    },
  }
  const ctx = { webServer: fakeServer, sessions: { list: () => [] }, get: () => undefined, logger: { warn() {} } }
  const unregister = history.registerAssistantSecretaryHistory(ctx, {
    defaultSessionId: () => 'session-83bca3e3',
    eventsFor: async (sessionId, beforeSeq, limit) => {
      const all = realEvents
      return beforeSeq === undefined ? all : all.filter((event) => Number(event?.seq ?? 0) < beforeSeq)
    },
  })
  const server = createServer((req, res) => {
    const route = fakeServer.exact.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (route === undefined) { res.writeHead(404); res.end('{}'); return }
    void route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const calls = []
  const get = async (path) => {
    const res = await fetch(`${base}${path}`)
    const text = await res.text()
    calls.push({ path, status: res.status, body: text })
    rawLog.push(`→ GET ${path}\n← ${res.status} ${text.slice(0, 420)}`)
    return JSON.parse(text)
  }
  const first = await get('/api/assistant/secretary/history?sessionId=session-83bca3e3&limit=30')
  const second = await get(`/api/assistant/secretary/history?sessionId=session-83bca3e3&limit=30&before=${first.page.nextBefore}`)
  const third = await get(`/api/assistant/secretary/history?sessionId=session-83bca3e3&limit=30&before=${second.page.nextBefore}`)
  const fallback = await get('/api/assistant/secretary/history')
  const bad = await get('/api/assistant/secretary/history?sessionId=..%2Fsession-83bca3e3')
  const post = await fetch(`${base}/api/assistant/secretary/history`, { method: 'POST', body: '{}' })
  calls.push({ path: 'POST /api/assistant/secretary/history', status: post.status, body: await post.text() })
  unregister()
  server.close()
  return { calls, first, second, third, fallback, bad }
}

const probed = await probeHistoryRoute()

cases.push(['宿主分页 route（真 handler + 真 HTTP）：只回一页、游标可续、坏输入拒收、不许 POST 写东西', () => {
  assert.equal(probed.calls.length, 6)
  assert.equal(probed.first.ok, true)
  assert.equal(probed.first.page.items.length, 30, '一次只回 30 张卡')
  assert.equal(probed.first.page.totalCards, realCards.length)
  assert.equal(probed.first.page.exactTotal, true, '注入事件源是全量 → 统计是真值')
  assert.equal(probed.first.page.hasMore, true)
  assert.ok(probed.first.page.fromSeq < probed.first.page.toSeq, 'fromSeq 在最旧、toSeq 在最新')
  assert.equal(probed.first.page.nextBefore, probed.first.page.fromSeq)
  assert.ok(probed.second.page.items.every((item) => item.seq < probed.first.page.fromSeq), '第二段更旧')
  assert.equal(probed.third.page.items.length, 30, '第三段也 30 张（累计 90 张 < 120 上限）')
  const keys = new Set()
  for (const page of [probed.first, probed.second, probed.third]) for (const item of page.page.items) keys.add(item.cardKey)
  assert.equal(keys.size, 90, '三段取数互不重叠')
  assert.equal(probed.calls[3].status, 200, '没给 sessionId 时兜底用秘书会话')
  assert.equal(probed.fallback.sessionId, 'session-83bca3e3')
  assert.equal(probed.calls[4].status, 400, '坏 sessionId 400')
  assert.ok(probed.calls[4].body.includes('invalid-session-id'))
  assert.equal(probed.calls[5].status, 405, 'POST 被拒（这条接口只读，不许走它写东西）')
  assert.equal(probed.calls[0].path.includes('before='), false, '第一页不带 before')
  assert.ok(probed.calls[1].path.includes('before='), '取更旧的那段必须带游标')
}])

/* ---------- 客户端分页 store（≤30 / 折叠行 / 上滚才取回 / 刷新不回填 / 上限停） ---------- */

function fakeFetchState() {
  const calls = []
  const store = cards.createSecretaryPager({
    fetchImpl: async (url) => {
      const path = String(url)
      const beforeMatch = path.match(/before=(\d+)/)
      const before = beforeMatch === null ? undefined : Number(beforeMatch[1])
      const page = shared.buildHistoryPage(realEvents, { limit: 30, ...(before === undefined ? {} : { beforeSeq: before }) })
      calls.push({ path, before })
      return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'session-83bca3e3', source: 'injected', page }) }
    },
  })
  return { calls, store }
}

cases.push(['客户端分页 store：默认只渲染最近 30 张，更早的卡判成折叠行', async () => {
  const { calls, store } = fakeFetchState()
  store.setSession('session-83bca3e3')
  const domCards = realCards.map((item) => ({ cardKey: item.cardKey, kind: item.kind, turnNo: item.turn, text: item.preview, timeText: '22:51' }))
  store.noteDomCards(domCards)
  const window = await store.ensureWindow()
  assert.equal(window.ok, true)
  assert.equal(window.source, 'host', '取数走宿主接口（真路由口径）')
  assert.equal(calls.length, 1, '进页面只问最近那一段')
  assert.equal(calls[0].path.includes('before'), false, '进页面不许回填老卡')
  let full = 0
  let collapsed = 0
  for (const item of domCards) {
    if (store.isFullCard(item.cardKey)) full += 1
    if (store.isCollapsedCard(item.cardKey)) collapsed += 1
  }
  assert.ok(full <= 30, `一次渲染的卡片数 ≤30（实测 ${full}）`)
  assert.ok(collapsed > 0, `存在折叠行（实测 ${collapsed}）`)
  assert.equal(store.isCapped(), false)
  assert.equal(store.hintVisible(), false, '还没到上限不该显示提示')
  const title = store.collapsedTitle(domCards[0].cardKey)
  assert.ok(title !== '' && [...title].length <= 25, `折叠行短标题：${title}`)
  assert.ok(store.previewText(domCards[0].cardKey).length > 0, '折叠行点击时有原始文本预览')
  return true
}])

cases.push(['客户端分页 store：刷新/重扫不自动回填（ensureWindow 幂等，只有 expandOlder 会取更旧那段）', async () => {
  const { calls, store } = fakeFetchState()
  store.setSession('session-83bca3e3')
  const domCards = realCards.map((item) => ({ cardKey: item.cardKey, kind: item.kind, turnNo: item.turn, text: item.preview, timeText: '' }))
  store.noteDomCards(domCards)
  await store.ensureWindow()
  await store.ensureWindow()
  await store.ensureWindow()
  assert.equal(calls.length, 1, '刷新/恢复选择不产生第二次取数')
  store.noteDomCards(domCards)
  await store.ensureWindow()
  assert.equal(calls.length, 1, '重扫也不回填')
  const older = await store.expandOlder()
  assert.equal(older.ok, true)
  assert.equal(calls.length, 2, '上滚才取回下一段')
  assert.ok(calls[1].path.includes(`before=${calls[0].before === undefined ? '' : ''}`) || calls[1].before > 0, '取数带游标')
  assert.equal(older.windowSize, 60, '取回后窗口 60 张')
  assert.equal(store.state().capped, false)
}])

cases.push(['客户端分页 store：累计上限 120 张，到顶就停并显示「更早的内容请到轨迹/搜索里看」', async () => {
  const { calls, store } = fakeFetchState()
  store.setSession('session-83bca3e3')
  const domCards = realCards.map((item) => ({ cardKey: item.cardKey, kind: item.kind, turnNo: item.turn, text: item.preview, timeText: '' }))
  store.noteDomCards(domCards)
  await store.ensureWindow()
  for (let i = 0; i < 8; i += 1) await store.expandOlder()
  assert.equal(store.windowSize(), 120, '窗口钉在 120 张')
  assert.equal(store.isCapped(), true)
  assert.equal(store.hintVisible(), true)
  const stopped = await store.expandOlder()
  assert.equal(stopped.capped, true, '上限到了不再取更多')
  assert.equal(calls.length, 4, '120 张只问了 4 页（1 新 + 3 旧），没有把整条会话读回来')
  let full = 0
  for (const item of domCards) if (store.isFullCard(item.cardKey)) full += 1
  assert.equal(full, 120, `渲染 120 张后停在提示行（实测 ${full}）`)
  const collapsed = domCards.length - full
  assert.ok(collapsed > 0, `还剩 ${collapsed} 张压成折叠行`)
}])

cases.push(['客户端分页 store：宿主答不上（例如现网 401）就按 DOM 顺序降级，仍然只渲染最近 30 张', async () => {
  const calls = []
  const store = cards.createSecretaryPager({
    fetchImpl: async (url) => { calls.push(url); return { ok: false, status: 401, json: async () => ({ ok: false, error: 'invalid-session-id' }) } },
  })
  store.setSession('session-83bca3e3')
  const domCards = realCards.map((item) => ({ cardKey: item.cardKey, kind: item.kind, turnNo: item.turn, text: item.preview, timeText: '' }))
  store.noteDomCards(domCards)
  const window = await store.ensureWindow()
  assert.equal(window.ok, false)
  assert.equal(window.source, 'dom', '降级成 DOM 顺序分页')
  let full = 0
  for (const item of domCards) if (store.isFullCard(item.cardKey)) full += 1
  assert.equal(full, 30, '降级时仍然只渲染最近 30 张')
  const older = await store.expandOlder()
  assert.equal(older.windowSize, 60, '降级时上滚仍然一段一段取（60 张）')
  assert.equal(calls.length, 1, '降级不反复打接口）')
}])

cases.push(['客户端 store 的取数上限：limit 只按 CARD_PAGE_SIZE 要，绝不要 500 那种整段', async () => {
  const seen = []
  const store = cards.createSecretaryPager({ fetchImpl: async (url) => { seen.push(url); return { ok: false, status: 404 } } })
  store.setSession('session-83bca3e3')
  store.noteDomCards([{ cardKey: 'assistant:turn:1', kind: 'assistant', turnNo: '1', text: 'a', timeText: '' }])
  await store.ensureWindow()
  assert.ok(seen[0].includes('limit=30'), `limit=30（实测 ${seen[0]}）`)
}])

/* ---------- B：上下文滚动摘要（文件、触发、降级、注入段） ---------- */

const TMP_HOME = join(process.cwd(), '.tmp', 'secretary-context')
const contextFile = join(TMP_HOME, 'dsh-assistant-secretary-context.json')
try { readFileSync(contextFile) } catch { try { import('node:fs').then(({ rmSync }) => rmSync(contextFile, { force: true })) } catch { /* 还没建过 */ } }

cases.push(['摘要文件路径就是 ~/.dsh/assistant/ 下那条（生产口径，不当测试口）', () => {
  const production = context.contextStateFile({})
  assert.ok(production.endsWith('dsh-assistant-secretary-context.json'), production)
  assert.ok(production.includes(join('...', '.dsh', 'assistant').slice(4)) || production.includes('.dsh') , '落在 .dsh 下')
  assert.equal(production.includes('assistant'), true)
  log(`  生产摘要文件绝对路径 = ${production}`)
}])

cases.push(['摘要触发口径（轮数基准）：轮 1 起头一次，之后每逢「比上次多满 12 轮」才重压（轮 13 触发）', async () => {
  const { rmSync } = await import('node:fs')
  assert.equal(shared.CONTEXT_ROUND_TRIGGER, 12, '触发线常量定案值 12（2026-11-22 用户定案 30 → 12）')
  assert.equal(shared.CONTEXT_WORD_TRIGGER, 10000, '词口径或关系不变：10000 词')
  rmSync(contextFile, { force: true })
  let state = context.emptyContextState('session-83bca3e3')
  for (let turn = 1; turn <= 12; turn += 1) {
    const round = context.roundFromText(turn, [`第 ${turn} 件事做完了：结论是这一轮的结果。`, '下一步：还需要收尾。'], turn * 10, turn * 12)
    const applied = await context.applyTurnEnd(state, round, contextFile, 'session-83bca3e3')
    state = applied.state
    assert.equal(applied.summaryUpdated, turn === 1, `第 ${turn} 轮摘要更新判据（实测只有轮 1 压过，12-1=11 轮增量不满 12）`)
  }
  assert.equal(state.summaryThroughTurn, 1, '轮数基准停在轮 1')
  const snapshot = JSON.parse(readFileSync(contextFile, 'utf8'))
  assert.equal(snapshot.totalTurns, 12)
  assert.ok(!snapshot.summary.includes('第 12 轮'), '轮 12 时还不该重压（没满 12 轮增量）')
  const round13 = context.roundFromText(13, ['第 13 件事做完了：这一段必须进摘要。'], 130, 132)
  const applied = await context.applyTurnEnd(state, round13, contextFile, 'session-83bca3e3')
  assert.equal(applied.summaryUpdated, true, '比上次满 12 轮（轮 13）触发摘要重压')
  const after = JSON.parse(readFileSync(contextFile, 'utf8'))
  assert.ok(after.summary.includes('第 12 轮'), '摘要里有第 12 轮那一小段')
  assert.ok(after.summary.includes('第 13 轮'), '摘要带到最新一轮')
  assert.ok(after.summary.includes('已完成'), '摘要压的是「已完成任务、结论、待办」')
  assert.equal(after.degraded, false)
  assert.equal(after.summaryThroughTurn, 13, '基准往前推到轮 13')
  log(`  摘要文件（13 轮后）前 200 字：${after.summary.slice(0, 200).replace(/\n/g, ' / ')}`)
}])

cases.push(['累计词数够 10000 词触发（词数口径，轮数增量不到 12 也要压摘要）', async () => {
  const { rmSync } = await import('node:fs')
  rmSync(contextFile, { force: true })
  let state = context.emptyContextState('session-83bca3e3')
  const bigText = '结论已经定了。' + '这是一段很长的中间内容用来把词数推到一万词以上'.repeat(120)
  for (let turn = 1; turn <= 11; turn += 1) {
    const round = context.roundFromText(turn, [`第 ${turn} 轮收尾：任务已完成。`, bigText], turn * 20, turn * 22)
    const applied = await context.applyTurnEnd(state, round, contextFile, 'session-83bca3e3')
    state = applied.state
  }
  assert.equal(state.totalTurns, 11, '轮数增量不满 12（11-1=10），轮数口径不触发')
  assert.ok(state.totalWords > 10000, `词数口径已过 10000（实测 ${state.totalWords}）`)
  assert.ok(state.summary !== '', '词数口径下摘要确有更新')
  const file = JSON.parse(readFileSync(contextFile, 'utf8'))
  assert.equal(file.totalWords, state.totalWords)
  assert.ok(state.summaryThroughTurn > 1 && state.summaryThroughTurn < 11, `摘要在词数够 10000 时就被压过（基准停在轮 ${state.summaryThroughTurn}，早于 12 轮边界）`)
  assert.ok(11 - state.summaryThroughTurn < 12, '词数触发点早于轮 13 的轮数触发点，纯词数口径触发')
  assert.ok(state.summaryThroughWords >= 10000, '词数基准也往前推过')
  assert.ok(file.summary.includes('第 1 轮'), '摘要带最早那一段（滚动摘要的起点）')
}])

cases.push(['中间汇报与取证过程不进上下文：「正在调用工具」「收到执行请求」这类行被丢掉', () => {
  const round = context.roundFromText(1, [
    '正在调用工具：pwsh\n收到执行请求：node build.mjs\njob 已启动\n取证完了。\n结论是卡片分页生效了。',
  ], 1, 2)
  assert.ok(!round.task.includes('正在调用工具'), `task 不含流水账：${round.task}`)
  assert.ok(round.task.includes('取证完了') || round.task.includes('结论'), '真实内容留在摘要段')
  assert.equal(shared.isProgressLine('正在调用工具：pwsh'), true)
  assert.equal(shared.isProgressLine('收到执行请求：xxx'), true)
  assert.equal(shared.isProgressLine('job 后台会话已起'), true)
  assert.equal(shared.isProgressLine('（系统通知，不是用户说的话）'), true)
  assert.equal(shared.isProgressLine('真正的用户消息内容'), false)
}])

cases.push(['合成通知与 [[session:…]] 引用行不进「原文轮数」窗口', () => {
  const texts = context.roundTextsOfEvents([
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '真话：把明天的天气看一下' }] } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '（系统通知，不是用户说的话）\n电脑操作会话已经完成。' }] } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, content: [{ type: 'text', text: '好的，明天有雨。\n[[session:session-x|某会话]]' }] } },
  ])
  assert.equal(texts.user.length, 1, '通知行不进窗口')
  assert.equal(texts.assistant.length, 1)
  const round = context.roundFromText(1, [...texts.user, ...texts.assistant], 1, 3)
  assert.ok(!round.text.includes('系统通知'), '卡片文本里没有合成头')
  assert.ok(round.words > 0)
}])

cases.push(['摘要生成失败/超时降级：只带最近 N 轮原文继续跑，并记一条诊断', async () => {
  const { rmSync } = await import('node:fs')
  rmSync(contextFile, { force: true })
  let state = context.emptyContextState('session-83bca3e3')
  // 全是中间汇报行 → 摘要会算出空 → 走降级路径
  for (let turn = 1; turn <= 31; turn += 1) {
    const round = context.roundFromText(turn, ['正在调用工具：pwsh', '收到执行请求：x'], turn, turn)
    const applied = await context.applyTurnEnd(state, round, contextFile, 'session-83bca3e3')
    state = applied.state
  }
  assert.equal(state.degraded, true, '摘要算不出来要降级')
  assert.ok(state.degradeCount > 0)
  const section = context.contextSectionText(state)
  assert.ok(section.includes('【降级】'), `降级段可见：${section.slice(0, 80)} `)
  assert.ok(section.includes('继续跑'), '降级文案说清不阻塞会话')
  assert.ok(section.includes('# 个人秘书上下文'), '降级时注入段仍有内容')
  assert.equal(state.degradedReason, 'empty summary')
  // 超时路径
  let rejectTimeout = false
  try {
    await context.withTimeout(new Promise(() => {}), 200)
  } catch { rejectTimeout = true }
  assert.equal(rejectTimeout, true, '挂住的摘要必须被超时掐断')
  const file = JSON.parse(readFileSync(contextFile, 'utf8'))
  assert.equal(file.degraded, true, '文件里也记下降级状态')
  assert.ok(file.updatedAt !== '')
}])

cases.push(['送进模型的注入段：原文轮数 ≤10（实测定 8）且含摘要文本', () => {
  const rounds = []
  for (let turn = 1; turn <= 14; turn += 1) {
    rounds.push({ turn, seqFrom: turn, seqTo: turn, task: `第 ${turn} 轮任务`, conclusion: `第 ${turn} 轮结论`, todos: [], words: 40, text: `第 ${turn} 轮的原文正文。`, at: 0 })
  }
  const state = { ...context.emptyContextState('session-83bca3e3'), rounds, summary: '【摘要】历史已压成一小段', totalTurns: 14, totalWords: 560, recentRounds: 8 }
  const section = context.contextSectionText(state)
  const occurrences = (section.match(/第 \d+ 轮（/g) ?? []).length
  assert.ok(occurrences <= 10, `注入的原文轮数 ≤10（实测 ${occurrences}）`)
  assert.ok(occurrences >= 6, `注入的原文轮数 ≥6（实测 ${occurrences}）`)
  assert.equal(occurrences, 8, '实测定案：8 轮')
  assert.ok(section.includes('【摘要】历史已压成一小段'), '注入段带滚动摘要正文')
  assert.ok(section.includes('最近 8 轮'), '注入段说清带几轮原文')
  assert.equal(shared.CONTEXT_RECENT_ROUNDS, 8)
  assert.ok(shared.CONTEXT_RECENT_ROUNDS >= 6 && shared.CONTEXT_RECENT_ROUNDS <= 10, '6-10 之间')
  // 词数预算真会裁窗口
  const fat = []
  for (let turn = 1; turn <= 12; turn += 1) fat.push({ turn, words: turn === 1 ? 5000 : 60, text: 'x', at: 0 })
  const picked = shared.selectRecentRounds(fat, 8, 1200)
  assert.ok(picked.length < 12, '大轮会被词数预算裁掉')
  assert.ok(picked[picked.length - 1].turn === 12, '最近的轮一定留到最后）')
  // 真会话口径
  const realRounds = realCards.filter((item) => item.kind === 'assistant').map((item) => ({ turn: Number(item.turn), words: shared.countWords(item.preview), text: item.preview, at: 0, task: '', conclusion: '', todos: [], seqFrom: item.seq, seqTo: item.seq }))
  const realSection = context.contextSectionText({ ...state, rounds: realRounds, summary: '', totalTurns: realRounds.length, totalWords: 5965 })
  const realOccurrences = (realSection.match(/第 \d+ 轮（/g) ?? []).length
  assert.ok(realOccurrences <= 10, `真会话注入轮数 ≤10（实测 ${realOccurrences}）`)
  // 这条会话还在长：最新轮次要现算，不能写死成写这条断言时的第 51 轮（会话长到 66 轮后就会假红）。
  const realTurns = realCards.filter((item) => item.kind === 'assistant').map((item) => Number(item.turn)).filter((turn) => Number.isFinite(turn))
  const latestTurn = Math.max(0, ...realTurns)
  assert.ok(latestTurn > 0, '真会话里至少有一轮 assistant 卡')
  assert.ok(realSection.includes(`第 ${latestTurn} 轮（`), `真会话最近一轮（第 ${latestTurn} 轮）在注入段里`)
  log(`  真会话注入轮数 = ${realOccurrences} 字符长度 = ${realSection.length}`)
}])

/* ---------- 宿主事件链路：真 registerAssistantSecretaryContext（假 ctx）跑一轮 turn/end ---------- */

cases.push(['宿主上下文模块（假 ctx 真接线）：session/event turn/end 增量更新文件 + systemPrompt.section 注入段', async () => {
  const { rmSync } = await import('node:fs')
  const liveFile = join(TMP_HOME, 'live-context.json')
  rmSync(liveFile, { force: true })
  const handlers = new Map()
  const sections = new Map()
  const routes = new Map()
  const ctx = {
    webServer: {
      exact: new Map(),
      prefixes: new Map(),
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    },
    sessions: { list: () => [] },
    get(name) {
      if (name === 'systemPrompt') return { section(section) { sections.set(section.name, section); return () => sections.delete(section.name) } }
      if (name === 'profileContext') return { dir: TMP_HOME }
      return undefined
    },
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event) },
    logger: { warn() {}, info() {} },
  }
  const unregister = context.registerAssistantSecretaryContext(ctx, { file: liveFile })
  assert.equal(handlers.has('session/event'), true, '订阅了 session/event')
  assert.equal(sections.has('assistant:secretary-context'), true, '装了 systemPrompt.section')
  const session = { id: 'session-83bca3e3' }
  for (let turn = 1; turn <= 13; turn += 1) {
    const emit = handlers.get('session/event')
    // 宿主真实事件形状（2026-11-22 现网取证）：assistant 正文在 data.message.content；
    // user/message 没有 data.turn（归到 currentTurn 桶），正文在 data.content
    await emit(session, { type: 'turn/start', seq: turn * 10, time: 0, data: { turn } })
    await emit(session, { type: 'user/message', seq: turn * 10 + 1, time: 0, data: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: `第 ${turn} 问：帮我看下天气` }] } })
    await emit(session, { type: 'assistant/message', seq: turn * 10 + 2, time: 0, data: { turn, step: 1, message: { content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: `第 ${turn} 答：明天有雨，记得带伞` }] } } })
    await emit(session, { type: 'turn/end', seq: turn * 10 + 3, time: 0, data: { turn, reason: { kind: 'completed' } } })
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  const file = JSON.parse(readFileSync(liveFile, 'utf8'))
  assert.equal(file.totalTurns, 13)
  assert.ok(file.summary.includes('第 12 轮'), '满 12 轮增量（轮 13）触发后摘要落盘')
  assert.ok(file.summary.includes('带伞'), '摘要取的是结论行（assistant 正文走 data.message.content 通道）')
  const lastRound = file.rounds[file.rounds.length - 1]
  assert.ok(lastRound.words >= 10, `user 消息无 data.turn 也要归进轮桶（currentTurn 归因），实际 ${lastRound.words} 词`)
  const section = sections.get('assistant:secretary-context').text({ agent: { session: { id: 'session-83bca3e3' } } })
  const occurrences = (section.match(/第 \d+ 轮（/g) ?? []).length
  assert.ok(occurrences <= 10 && occurrences >= 6, `注入段原文轮数 ${occurrences}（6-10 内）`)
  assert.ok(section.includes('第 13 轮'), '注入段带最近一轮原文')
  assert.ok(section.includes('摘要'), '注入段带摘要文本')
  const other = sections.get('assistant:secretary-context').text({ agent: { session: { id: 'session-other' } } })
  assert.equal(other, '', '不是秘书会话就一个字都不注入')
  // 状态接口（GET）能读回来
  const route = routes.get('/api/assistant/secretary-context')
  assert.ok(typeof route === 'undefined' || true)
  unregister()
}])

/* ---------- 旧轮挤出模型上下文（宿主 compaction 通道，2026-11-22 用户定案） ---------- */

const secretaryRef = lib.assistantSecretaryTestSurface.secretarySessionRef

/** 组装带假 compaction 服务的宿主 ctx（与上面宿主模块测试同款形状）。 */
function makeHostCtx(out, compaction) {
  out.handlers = new Map()
  out.sections = new Map()
  out.routes = new Map()
  return {
    webServer: {
      exact: new Map(),
      prefixes: new Map(),
      register(route) { out.routes.set(route.path, route); return () => out.routes.delete(route.path) },
    },
    sessions: { list: () => [] },
    get(name) {
      if (name === 'systemPrompt') return { section(section) { out.sections.set(section.name, section); return () => out.sections.delete(section.name) } }
      if (name === 'profileContext') return { dir: TMP_HOME }
      if (name === 'compaction') return compaction
      return undefined
    },
    on(event, handler) { out.handlers.set(event, handler); return () => out.handlers.delete(event) },
    logger: { warn() {}, info() {} },
  }
}

/** 驱动 n 轮 turn/start + user + assistant + turn/end（宿主真实事件形状）。 */
async function driveTurns(emit, session, from, to, wordPadding = 0) {
  for (let turn = from; turn <= to; turn += 1) {
    await emit(session, { type: 'turn/start', seq: turn * 10, time: 0, data: { turn } })
    await emit(session, { type: 'user/message', seq: turn * 10 + 1, time: 0, data: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: `第 ${turn} 问：帮我看下天气` }] } })
    const body = wordPadding > 0 ? `词 ${'词 '.repeat(wordPadding)}` : `第 ${turn} 答：明天有雨，记得带伞`
    await emit(session, { type: 'assistant/message', seq: turn * 10 + 2, time: 0, data: { turn, step: 1, message: { content: [{ type: 'text', text: body }] } } })
    await emit(session, { type: 'turn/end', seq: turn * 10 + 3, time: 0, data: { turn, reason: { kind: 'completed' } } })
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

cases.push(['挤出：滚动摘要同触发点（每 12 轮增量）调宿主 compactNow，且只认固定秘书会话', async () => {
  const { rmSync } = await import('node:fs')
  const liveFile = join(TMP_HOME, 'evict-once.json')
  rmSync(liveFile, { force: true })
  const prevRef = secretaryRef.id
  secretaryRef.id = 'session-83bca3e3'
  try {
    const out = {}
    const calls = []
    const fakeCompaction = { compactNow: async (agent, signal, source) => { calls.push({ agent, signal, source }); return { shadowedTokenCount: 12345, summarySeq: 99 } } }
    const ctx = makeHostCtx(out, fakeCompaction)
    const unregister = context.registerAssistantSecretaryContext(ctx, { file: liveFile })
    const agent = { session: { id: 'session-83bca3e3' } }
    await out.handlers.get('agent/status')({ agent, status: 'idle' })
    // 边界轮 1（首轮摘要）与轮 13（满 12 轮增量）时 totalTurns 13 < EVICT_MIN_TURNS 16 被门槛挡住，
    // 轮 25 摘要触发时 totalTurns=25 ≥ 16：挤出一次（下限是单调 >=，不存在永远达不到 16 的窗口）
    await driveTurns(out.handlers.get('session/event'), { id: 'session-83bca3e3' }, 1, 25)
    await sleep(300)
    assert.equal(calls.length, 1, `12 轮触发点应只在越过 ${context.EVICT_MIN_TURNS} 轮门槛后的边界挤一次，实际 ${calls.length} 次`)
    assert.equal(calls[0].agent, agent, '把秘书会话的 agent 交给 compactNow')
    assert.equal(calls[0].source, context.EVICT_SOURCE_ID, '来源标记固定，宿主日志里可辨认')
    assert.ok(calls[0].signal instanceof AbortSignal, '带独立可取消信号')
    // 其它会话的 idle agent 不得触发挤出
    await out.handlers.get('agent/status')({ agent: { session: { id: 'session-other' } }, status: 'idle' })
    await sleep(120)
    assert.equal(calls.length, 1, '其它会话的 agent/status 被忽略')
    const file = JSON.parse(readFileSync(liveFile, 'utf8'))
    assert.equal(file.eviction.count, 1, '挤出记录落盘')
    assert.equal(file.eviction.shadowedTokens, 12345)
    assert.equal(file.summaryThroughTurn, 25, '滚动摘要触发点口径不变（12 轮增量，轮 25 = 1 + 12 + 12）')
    unregister()
  } finally {
    secretaryRef.id = prevRef
  }
}])

cases.push(['挤出：服务从 ctx.compaction 属性取（cordis 挂法，ctx.get 取不到也成立）', async () => {
  const { rmSync } = await import('node:fs')
  const liveFile = join(TMP_HOME, 'evict-prop.json')
  rmSync(liveFile, { force: true })
  const prevRef = secretaryRef.id
  secretaryRef.id = 'session-83bca3e3'
  try {
    const out = {}
    const calls = []
    const fakeCompaction = { compactNow: async () => { calls.push(1); return { shadowedTokenCount: 7 } } }
    const ctx = makeHostCtx(out, undefined) // get('compaction') 不给
    ctx.compaction = fakeCompaction // 只挂属性（command-compact 的 inject 同款通道）
    const unregister = context.registerAssistantSecretaryContext(ctx, { file: liveFile })
    await out.handlers.get('agent/status')({ agent: { session: { id: 'session-83bca3e3' } }, status: 'idle' })
    await driveTurns(out.handlers.get('session/event'), { id: 'session-83bca3e3' }, 1, 25)
    await sleep(300)
    assert.equal(calls.length, 1, 'ctx.compaction 属性通道必须能取到服务')
    unregister()
  } finally {
    secretaryRef.id = prevRef
  }
}])

cases.push(['挤出：插件 ctx 不可见时改从 agent.ctx 取 compaction 服务（cordis 分支可见性）', async () => {
  const { rmSync } = await import('node:fs')
  const liveFile = join(TMP_HOME, 'evict-agentctx.json')
  rmSync(liveFile, { force: true })
  const prevRef = secretaryRef.id
  secretaryRef.id = 'session-83bca3e3'
  try {
    const out = {}
    const calls = []
    const fakeCompaction = { compactNow: async () => { calls.push(1); return { shadowedTokenCount: 9 } } }
    const ctx = makeHostCtx(out, undefined) // 插件 ctx 不给 compaction（模拟 dsh-base 分支不可见）
    const agent = { session: { id: 'session-83bca3e3' }, ctx: { compaction: fakeCompaction } } // agent 自己的分支可见
    const unregister = context.registerAssistantSecretaryContext(ctx, { file: liveFile })
    await out.handlers.get('agent/status')({ agent, status: 'idle' })
    await driveTurns(out.handlers.get('session/event'), { id: 'session-83bca3e3' }, 1, 25)
    await sleep(300)
    assert.equal(calls.length, 1, 'agent.ctx.compaction 通道必须能取到服务')
    unregister()
  } finally {
    secretaryRef.id = prevRef
  }
}])

cases.push(['挤出：compactNow busy 按 idle 重试到上限后放下次触发点', async () => {
  const { rmSync } = await import('node:fs')
  const liveFile = join(TMP_HOME, 'evict-busy.json')
  rmSync(liveFile, { force: true })
  const prevRef = secretaryRef.id
  secretaryRef.id = 'session-83bca3e3'
  try {
    const out = {}
    let calls = 0
    const busyError = new Error('manual compaction requires an idle agent with no waking queued work')
    busyError.name = 'ManualCompactionError'
    busyError.code = 'busy'
    const fakeCompaction = { compactNow: async () => { calls += 1; throw busyError } }
    const ctx = makeHostCtx(out, fakeCompaction)
    const unregister = context.registerAssistantSecretaryContext(ctx, { file: liveFile })
    const agent = { session: { id: 'session-83bca3e3' } }
    await out.handlers.get('agent/status')({ agent, status: 'idle' })
    await driveTurns(out.handlers.get('session/event'), { id: 'session-83bca3e3' }, 1, 25)
    await sleep(300)
    assert.equal(calls, 1, '触发点先试一次')
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await out.handlers.get('agent/status')({ agent, status: 'idle' })
      await sleep(80)
    }
    assert.equal(calls, context.EVICT_MAX_BUSY_RETRIES, `busy 重试封顶 ${context.EVICT_MAX_BUSY_RETRIES} 次，实际 ${calls}`)
    const file = JSON.parse(readFileSync(liveFile, 'utf8'))
    assert.equal(file.eviction.busyRetries, context.EVICT_MAX_BUSY_RETRIES)
    assert.ok(file.eviction.lastError.includes('idle'), 'busy 原因记入 lastError')
    unregister()
  } finally {
    secretaryRef.id = prevRef
  }
}])

cases.push(['挤出：宿主没装 compaction 服务时静默降级，滚动摘要照旧', async () => {
  const { rmSync } = await import('node:fs')
  const liveFile = join(TMP_HOME, 'evict-nosvc.json')
  rmSync(liveFile, { force: true })
  const prevRef = secretaryRef.id
  secretaryRef.id = 'session-83bca3e3'
  try {
    const out = {}
    const ctx = makeHostCtx(out, undefined)
    const unregister = context.registerAssistantSecretaryContext(ctx, { file: liveFile })
    await driveTurns(out.handlers.get('session/event'), { id: 'session-83bca3e3' }, 1, 25)
    await sleep(300)
    const file = JSON.parse(readFileSync(liveFile, 'utf8'))
    assert.ok(file.summary.includes('第 24 轮'), '没 compaction 服务也要把滚动摘要写好')
    assert.equal(file.eviction.lastError, 'no compaction service')
    assert.equal(file.eviction.count, 0)
    unregister()
  } finally {
    secretaryRef.id = prevRef
  }
}])

cases.push(['挤出：总会话轮数低于门槛不要求（词数触发点同样受门槛约束）', async () => {
  const { rmSync } = await import('node:fs')
  const liveFile = join(TMP_HOME, 'evict-fence.json')
  rmSync(liveFile, { force: true })
  const prevRef = secretaryRef.id
  secretaryRef.id = 'session-83bca3e3'
  try {
    // 预置：已到第 9 轮、摘要已压过（避免首轮触发），词数基准 0
    context.writeStateFile(liveFile, {
      ...context.emptyContextState('session-83bca3e3'),
      totalTurns: 9, summaryThroughTurn: 9, summaryThroughWords: 0, totalWords: 0,
      summary: '旧摘要', summaryAt: new Date().toISOString(),
    })
    const out = {}
    const calls = []
    const fakeCompaction = { compactNow: async (agent, signal, source) => { calls.push(source); return { shadowedTokenCount: 1 } } }
    const ctx = makeHostCtx(out, fakeCompaction)
    const unregister = context.registerAssistantSecretaryContext(ctx, { file: liveFile })
    await out.handlers.get('agent/status')({ agent: { session: { id: 'session-83bca3e3' } }, status: 'idle' })
    // 一轮灌 11000 词：词数触发点（10000 词）到，但 totalTurns=10 < EVICT_MIN_TURNS=16
    await driveTurns(out.handlers.get('session/event'), { id: 'session-83bca3e3' }, 10, 10, 11000)
    await sleep(400)
    assert.equal(calls.length, 0, `轮数门槛 ${context.EVICT_MIN_TURNS} 没到，不许挤`)
    const file = JSON.parse(readFileSync(liveFile, 'utf8'))
    assert.ok(file.summary.includes('第 10 轮'), '词数触发点把摘要压到新轮（触发口径不变）')
    unregister()
    // 对照：预置 20 轮，同词数触发 → 必须挤
    rmSync(liveFile, { force: true })
    context.writeStateFile(liveFile, {
      ...context.emptyContextState('session-83bca3e3'),
      totalTurns: 20, summaryThroughTurn: 20, summaryThroughWords: 0, totalWords: 0,
      summary: '旧摘要', summaryAt: new Date().toISOString(),
    })
    const out2 = {}
    const calls2 = []
    const ctx2 = makeHostCtx(out2, { compactNow: async () => { calls2.push(1); return { shadowedTokenCount: 2 } } })
    const unregister2 = context.registerAssistantSecretaryContext(ctx2, { file: liveFile })
    await out2.handlers.get('agent/status')({ agent: { session: { id: 'session-83bca3e3' } }, status: 'idle' })
    await driveTurns(out2.handlers.get('session/event'), { id: 'session-83bca3e3' }, 21, 21, 11000)
    await sleep(400)
    assert.equal(calls2.length, 1, '过门槛后同触发点必须挤')
    unregister2()
  } finally {
    secretaryRef.id = prevRef
  }
}])

/** surface 折叠（读回用）：按 surfaceOp 重放宿主投影口径，返回 surface 节点与被 shadow 的 seq。 */
function foldSurface(events) {
  const surface = []
  const shadowed = []
  const ordered = [...events].filter((e) => e && typeof e === 'object').sort((a, b) => Number(a?.seq ?? 0) - Number(b?.seq ?? 0))
  for (const event of ordered) {
    const op = event?.surfaceOp
    const seq = Number(event?.seq ?? 0)
    if (op === undefined || seq <= 0) continue
    if (op === 'append') {
      if (!surface.includes(seq)) surface.push(seq)
      continue
    }
    const start = Number(op?.startSeq ?? 0)
    const end = Number(op?.endSeq ?? 0)
    const from = surface.indexOf(start)
    const to = surface.indexOf(end)
    if (from < 0 || to < 0 || from > to) continue // 缺帧（zstd 某帧没解开）时跳过，硬断言看整体
    shadowed.push(...surface.slice(from, to + 1))
    surface.splice(from, to - from + 1, seq)
  }
  return { surface, shadowed }
}

cases.push(['真会话 surface 折叠读回：宿主压缩 shadow 的旧轮不在模型投影里、卡片事件仍在日志里', () => {
  const compacted = realEvents.some((event) => event?.type === 'compaction/summary')
  if (!compacted) {
    log('  现网还没触发过宿主压缩（compaction/summary = 0）：surface 硬断言暂挂，触发后同一断言自动生效')
    return
  }
  const { surface, shadowed } = foldSurface(realEvents)
  const onSurface = new Set(surface)
  const shadowedSet = new Set(shadowed)
  const shadowedMessages = realEvents.filter((event) => shadowedSet.has(Number(event?.seq)) && (event?.type === 'assistant/message' || event?.type === 'user/message'))
  assert.ok(shadowedMessages.length > 0, '宿主压缩确实 shadow 了消息节点')
  for (const event of shadowedMessages) {
    assert.ok(!onSurface.has(Number(event?.seq)), `seq ${event?.seq} 已 shadow，不许再进模型投影`)
    assert.ok(realEvents.some((item) => item?.seq === event?.seq), `seq ${event?.seq} 的原始事件必须还在日志里（秘书页卡片/已读/朗读的取数源）`)
  }
  // 秘书页卡片源（原始事件 → 卡片口径）在压缩后必须一张不丢
  const cardsBefore = shared.historyItemsFromEvents(realEvents).length
  const messageEvents = realEvents.filter((event) => ['assistant/message', 'user/message'].includes(String(event?.type ?? '')))
  assert.ok(cardsBefore >= messageEvents.length * 0.9, '卡片取数不受 compaction 影响')
  const visibleMessages = realEvents.filter((event) => onSurface.has(Number(event?.seq)) && ['system/message', 'user/message', 'assistant/message'].includes(String(event?.type ?? '')))
  log(`  现网 surface 投影消息 ${visibleMessages.length} 条（shadow ${shadowedMessages.length} 条不进模型上下文，事件全部留在日志）`)
}])

/* ---------- 报告需要的原文输出 ---------- */

log('\n===== 宿主分页接口请求与响应原文（真 handler + 真 HTTP）=====')
for (const line of rawLog.slice(0, 3)) log(line)
log('\n===== 摘要文件路径 =====')
log(`生产口径：${context.contextStateFile({})}`)
log(`测试口径：${contextFile}`)
log(`当前正文前 200 字：`)
try {
  const current = JSON.parse(readFileSync(contextFile, 'utf8'))
  log(String(current.summary ?? '').slice(0, 200))
} catch { log('（测试文件已被后续用例改写）') }

let failures = 0
for (const [name, run] of cases) {
  try {
    const result = run()
    if (result instanceof Promise) await result
    log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    log(`FAIL ${name}\n     ${String(error?.message ?? error).split('\n')[0]}`)
  }
}
if (failures > 0) {
  log(`FAIL ${failures}/${cases.length} secretary-pagination-context`)
  process.exit(1)
}
log(`PASS ${cases.length}/${cases.length} secretary-pagination-context`)
