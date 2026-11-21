/**
 * 卡片分页（第四批需求 A）的浏览器 DOM 验收：
 *   node scripts/test-secretary-pagination-dom.mjs
 *
 * 这一层把**真实现**接进页面：分页 store、折叠行短标题/预览、锚点补偿、上限提示，全部从本次构建的
 * lib/index.js / lib/client.js 里取（口径不复制第二遍），真数据是真会话事件（只读取、不改写）。
 * 断言：一次渲染卡数 ≤30、存在折叠行、折叠行只有一行、点击只开预览不拉回老卡、
 * 上滚才取回下一段（判据 shouldExpandOnScroll）、取回后位置不跳、上限 120 后停并显示提示行、
 * DOM 节点总量不炸（手机 WebView 崩溃判据）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const lib = await import('../lib/index.js')
const shared = lib.secretCardSharedTestSurface
const cards = lib.secretaryCardsTestSurface
const realEventsSource = process.env.DSH_TEST_SESSION_FILE
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
    try { frames.push(zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8')) } catch { /* 解不开就跳过 */ }
  }
  const events = []
  for (const line of frames.join('').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try { events.push(JSON.parse(trimmed)) } catch { /* 非 json 行跳过 */ }
  }
  return events
}

const realEvents = readSessionEvents(realEventsSource)
const realCards = shared.historyItemsFromEvents(realEvents)

// 真 CSS（本次构建的客户端 bundle 里那份），页面只负责接线
const bundleSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const marker = 'body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"]'
const at = bundleSource.indexOf(marker)
if (at < 0) throw new Error('lib/client.js 里找不到卡片 CSS 标记，先跑 node build.mjs')
const cssStart = bundleSource.lastIndexOf('`', at)
const cssEnd = bundleSource.indexOf('`', at)
const cardCss = bundleSource.slice(cssStart + 1, cssEnd)
if (!cardCss.includes('[data-dsh-scard="collapsed-row"]')) throw new Error('CSS 里没有折叠行规则）')

const clock = '22:51'

function collapsedRowMarkup(item) {
  const title = titleOf(item)
  return `<div data-dsh-scard="collapsed-row" data-dsh-scard-kind="${item.kind}" data-dsh-scard-turn="${item.turn}" data-dsh-scard-key="${item.cardKey}" data-dsh-scard-open="false">
  <button type="button" data-dsh-scard="collapse-row" aria-expanded="false">
    <span data-dsh-scard="collapse-time">${clock}</span>
    <span data-dsh-scard="collapse-title">${escapeText(title)}</span>
    <span data-dsh-scard="collapse-caret">▾</span>
  </button>
</div>`
}

function titleOf(item) {
  const value = item.title !== '' ? item.title : shared.truncateCardTitle(item.preview)
  return value
}

function fullCardMarkup(item) {
  const body = shared.truncatePreview(item.preview)
  const lines = body.split('\n').filter((line) => line.trim() !== '').slice(0, 3)
  const paragraphs = lines.map((line) => `<p data-dsh-scard="para">${escapeText(line)}</p>`).join('\n')
  return `<article data-dsh-scard="card" data-dsh-scard-kind="${item.kind}" data-dsh-scard-turn="${item.turn}" data-dsh-scard-key="${item.cardKey}" data-empty="0" data-open="0" data-unread="0">
  <div data-dsh-scard="body"><div data-dsh-scard="content">${paragraphs}</div></div>
  <div data-dsh-scard="foot"><span data-dsh-scard="time">${clock}</span></div>
</article>`
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function pageHtml(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>secretary pagination</title><style>${cardCss}</style></head><body data-dsh-secretary="1"><div data-conversation-scroll style="height:600px;overflow-y:auto"><div data-chat-flow>${inner}</div></div></body></html>`
}

const failures = []
function check(name, ok, detail = '') {
  if (ok) { console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); return }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

/* 分页 store：真实现 + 真数据（取数走同一套口径，宿主接口模拟成真会话的分页） */
const historyCalls = []
const store = cards.createSecretaryPager({
  fetchImpl: async (url) => {
    const path = String(url)
    historyCalls.push(path)
    const match = path.match(/before=(\d+)/)
    const page = shared.buildHistoryPage(realEvents, { limit: 30, ...(match === null ? {} : { beforeSeq: Number(match[1]) }) })
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'session-83bca3e3', source: 'injected', page }) }
  },
})
store.setSession('session-83bca3e3')
const domCards = realCards.map((item) => ({ cardKey: item.cardKey, kind: item.kind, turnNo: item.turn, text: item.preview, timeText: clock }))
store.noteDomCards(domCards)
const windowed = await store.ensureWindow()
check('分页 store：取数走宿主接口口径（不是把整条会话读回来）', windowed.ok === true && windowed.source === 'host', JSON.stringify({ source: windowed.source, calls: historyCalls.length }))
check('分页 store：判据 shouldExpandOnScroll 只认「滚到顶部」', (() => {
  const base = { threshold: shared.SCROLL_TOP_THRESHOLD_PX, hasMore: true, capped: false, loading: false, alreadyExpanding: false }
  return shared.shouldExpandOnScroll({ ...base, scrollTop: 0 }) === true
    && shared.shouldExpandOnScroll({ ...base, scrollTop: shared.SCROLL_TOP_THRESHOLD_PX }) === true
    && shared.shouldExpandOnScroll({ ...base, scrollTop: shared.SCROLL_TOP_THRESHOLD_PX + 1 }) === false
    && shared.shouldExpandOnScroll({ ...base, scrollTop: 0, hasMore: false }) === false
    && shared.shouldExpandOnScroll({ ...base, scrollTop: 0, capped: true }) === false
    && shared.shouldExpandOnScroll({ ...base, scrollTop: 0, loading: true }) === false
    && shared.shouldExpandOnScroll({ ...base, scrollTop: 0, alreadyExpanding: true }) === false
})(), 'scrollTop>阈值 / hasMore=false / capped / loading / 正在扩段 都不取第二段')

const renderOnce = () => {
  const inner = realCards.map((item) => (store.isCollapsedCard(item.cardKey) ? collapsedRowMarkup(item) : fullCardMarkup(item))).join('\n')
  const hint = store.hintVisible() ? `<div data-dsh-scard="earlier-hint"><span data-dsh-scard="earlier-hint-text">${shared.EARLIER_HINT_TEXT}</span></div>` : ''
  return pageHtml(hint + inner)
}

const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
const page = await context.newPage()
await page.setContent(pageHtml(collapsedRowMarkup(realCards[0])))

await page.setContent(renderOnce())
const first = await page.evaluate(() => {
  const full = [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])')]
  const collapsed = [...document.querySelectorAll('[data-dsh-scard="collapsed-row"]')]
  const row = collapsed[0]?.querySelector('[data-dsh-scard="collapse-row"]')
  const cs = row ? getComputedStyle(row) : null
  const title = collapsed[0]?.querySelector('[data-dsh-scard="collapse-title"]')
  const time = collapsed[0]?.querySelector('[data-dsh-scard="collapse-time"]')
  return {
    fullTotal: full.length,
    collapsedTotal: collapsed.length,
    total: full.length + collapsed.length,
    rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
    titleSize: title ? getComputedStyle(title).fontSize : '',
    timeSize: time ? getComputedStyle(time).fontSize : '',
    titleText: title?.textContent ?? '',
    whiteSpace: cs?.whiteSpace ?? '',
    domNodes: document.querySelectorAll('*').length,
    cardHeights: full.slice(0, 3).map((el) => Math.round(el.getBoundingClientRect().height)),
    collapsedHeights: collapsed.slice(0, 3).map((el) => Math.round(el.getBoundingClientRect().height)),
  }
})
check(`一次渲染的卡片数 ≤30（真会话 ${realCards.length} 张卡）`, first.fullTotal <= 30 && first.fullTotal > 0, JSON.stringify(first))
check('存在折叠行（更早的卡压成一行）', first.collapsedTotal === realCards.length - 30, JSON.stringify({ collapsedTotal: first.collapsedTotal, expected: realCards.length - 30 }))
check('折叠行只有一行（高度一行量级、时间+短标题）', first.rowHeight > 0 && first.rowHeight <= 60, JSON.stringify({ rowHeight: first.rowHeight, collapsedHeights: first.collapsedHeights, titleText: first.titleText }))
check('折叠行短标题口径（首行前 24 码点）且一行到底', first.titleText !== '' && !first.titleText.includes('\n') && [...first.titleText].length <= 25 && first.whiteSpace === 'normal', JSON.stringify({ titleText: first.titleText, size: first.titleSize, timeSize: first.timeSize }))

/* 折叠行点击：只开本地预览，绝不把整张老卡拉回渲染 */
await page.evaluate((previewText) => {
  const row = document.querySelector('[data-dsh-scard="collapsed-row"]')
  const button = row.querySelector('[data-dsh-scard="collapse-row"]')
  button.addEventListener('click', () => {
    const open = row.getAttribute('data-dsh-scard-open') === 'open'
    row.setAttribute('data-dsh-scard-open', open ? 'false' : 'open')
    if (open) { const stale = row.querySelector('[data-dsh-scard="collapse-preview"]'); if (stale !== null) stale.remove(); return }
    const preview = document.createElement('div')
    preview.setAttribute('data-dsh-scard', 'collapse-preview')
    preview.textContent = previewText
    row.appendChild(preview)
  })
}, shared.truncatePreview(realCards[0].preview).slice(0, 400))
await page.locator('[data-dsh-scard="collapsed-row"] [data-dsh-scard="collapse-row"]').first().click()
const clicked = await page.evaluate(() => {
  const preview = document.querySelector('[data-dsh-scard="collapse-preview"]')
  return {
    previewExists: preview !== null,
    previewHeight: preview ? Math.round(preview.getBoundingClientRect().height) : 0,
    previewText: preview ? String(preview.textContent ?? '').slice(0, 40) : '',
    fullTotal: document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])').length,
    collapsedTotal: document.querySelectorAll('[data-dsh-scard="collapsed-row"]').length,
  }
})
check('折叠行点击开原始文本预览（不拉回整张老卡）', clicked.previewExists && clicked.fullTotal === first.fullTotal && clicked.collapsedTotal === first.collapsedTotal && clicked.previewText !== '', JSON.stringify(clicked))
check('折叠行点击后窗口与 store 一致（store 没有因点击变宽）', store.state().windowSize === 30, JSON.stringify(store.state()))

/* 上滚才取回下一段 + scroll-anchoring 位置不跳 */
const beforeScroll = await page.evaluate(() => {
  const el = document.querySelector('[data-conversation-scroll]')
  el.scrollTop = 0
  const sentinel = document.querySelectorAll('[data-dsh-scard="card"]')[0]
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, sentinelTop: sentinel ? sentinel.getBoundingClientRect().top : -1 }
})
const expanded = await store.expandOlder()
check('上滚才取回下一段：窗口从 30 涨到 60（不一次取全）', expanded.windowSize === 60 && store.state().expandedBatches === 1, JSON.stringify({ windowSize: expanded.windowSize, batches: store.state().expandedBatches }))
await page.setContent(renderOnce())
const afterScroll = await page.evaluate(() => {
  const el = document.querySelector('[data-conversation-scroll]')
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
})
const delta = cards.scrollAnchorTopPatch(beforeScroll.scrollHeight, afterScroll.scrollHeight)
await page.evaluate((value) => { document.querySelector('[data-conversation-scroll]').scrollTop = value }, beforeScroll.scrollTop + delta)
const anchored = await page.evaluate(() => {
  const el = document.querySelector('[data-conversation-scroll]')
  const sentinel = document.querySelectorAll('[data-dsh-scard="card"]')[30]
  return { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, sentinelTop: sentinel ? Math.round(sentinel.getBoundingClientRect().top) : -1, fullTotal: el.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])').length, collapsedTotal: el.querySelectorAll('[data-dsh-scard="collapsed-row"]').length }
})
check('取回后保持原滚动位置不跳（补回 scrollTop）', delta > 0 && anchored.scrollTop >= delta, JSON.stringify({ delta, beforeScroll, anchored }))
check('取回后窗口内仍是 60 张完整卡、更旧的继续折叠', anchored.fullTotal === 60 && anchored.collapsedTotal === realCards.length - 60, JSON.stringify({ fullTotal: anchored.fullTotal, collapsedTotal: anchored.collapsedTotal }))
check('刷新/重扫不自动回填（store 只问最近那一次）', historyCalls.length === 2 && !historyCalls[0].includes('before=') && historyCalls[1].includes('before='), JSON.stringify(historyCalls))

/* 上限 120：继续滚就停，并把「更早的内容请到轨迹/搜索里看」钉在渲染区最前 */
await page.setContent(renderOnce())
for (let attempt = 0; attempt < 4; attempt += 1) await store.expandOlder()
const cappedState = store.state()
const cappedRender = await (async () => { await page.setContent(renderOnce()); return page.evaluate(() => ({ fullTotal: document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])').length, collapsedTotal: document.querySelectorAll('[data-dsh-scard="collapsed-row"]').length, hint: document.querySelector('[data-dsh-scard="earlier-hint-text"]')?.textContent ?? '', hintSize: document.querySelector('[data-dsh-scard="earlier-hint-text"]') ? getComputedStyle(document.querySelector('[data-dsh-scard="earlier-hint-text"]')).fontSize : '', domNodes: document.querySelectorAll('*').length })) })()
check('累计渲染上限 120 张就停（capped 判据）', cappedState.capped === true && cappedState.windowSize === 120, JSON.stringify({ windowSize: cappedState.windowSize, capped: cappedState.capped, batches: cappedState.expandedBatches }))
check('到上限后显示「更早的内容请到轨迹/搜索里看」', cappedRender.hint === shared.EARLIER_HINT_TEXT && cappedRender.fullTotal === 120, JSON.stringify({ hint: cappedRender.hint, fullTotal: cappedRender.fullTotal, collapsed: cappedRender.collapsedTotal, hintSize: cappedRender.hintSize }))
const stopped = await store.expandOlder()
check('到上限后继续上滚也不再取数', stopped.capped === true && historyCalls.length <= 5, JSON.stringify({ calls: historyCalls.length, batches: store.state().expandedBatches }))
check('绝不把整条会话塞进 DOM（节点总量守卫）', cappedRender.domNodes > 0 && cappedRender.domNodes < 20000, JSON.stringify({ domNodes: cappedRender.domNodes, cards: cappedRender.fullTotal + cappedRender.collapsedTotal }))
await page.screenshot({ path: join(ROOT, 'tmp-secretary-pager-dom.png') })

await browser.close()

console.log(`\n取数请求：\n${historyCalls.map((line) => `  ${line}`).join('\n')}`)
if (failures.length > 0) {
  console.error(`\nFAIL ${failures.length} 项 pagination-dom`)
  process.exit(1)
}
console.log('\nPASS 卡片分页 DOM 验收全部通过（tmp-secretary-pager-dom.png）')
