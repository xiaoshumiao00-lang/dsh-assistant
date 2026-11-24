/**
 * 手机端「设置 → 个人助手」现场验收（真页面 + 真宿主，playwright + 本机 Chrome）。
 *
 * 为什么要有这一层：离线 CSS 契约测试只能证明「规则写对了」，证明不了宿主真实
 * 对话框 DOM 上量出来的宽度/命中。2026-11-25 用户报「手机端设置，个人助手设置页
 * 一片空白」，就是先在本机 Chrome 上把 panel/nav/options/卡片逐层量出来才定位到
 * 「设置页的整块手机样式全都没生效」（DSH 0.2.2 把 tab 列表从标题行里搬出去了，
 * 旧的 `:has(> :first-child > :last-child > button)` 门控永远为假）。
 *
 * 用法：
 *   node scripts/test-mobile-settings-live.mjs
 *   DSH_POCKET_URL=http://127.0.0.1:3081 DSH_POCKET_TOKEN=… node scripts/test-mobile-settings-live.mjs
 *   PW=430 PH=900 node scripts/test-mobile-settings-live.mjs
 *
 * 退出码 0 = 全绿；任何断言失败都会把现场数字打出来。
 * 需要宿主在跑（pocket 端口 3081 或 DSH_POCKET_URL）；宿主没起时打印 SKIP 并以 0 退出，
 * 所以它不进 npm test 的离线链，只在发布前手工跑一次。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(join(process.cwd(), 'package.json'))
const { chromium } = require('playwright')

const BASE = process.env.DSH_POCKET_URL || 'http://127.0.0.1:3081'
const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const W = Number(process.env.PW || 390)
const H = Number(process.env.PH || 844)

function readToken() {
  if (process.env.DSH_POCKET_TOKEN) return process.env.DSH_POCKET_TOKEN
  const file = /\/\/(127\.0\.0\.1|localhost)\b/.test(BASE) ? 'token-lan' : 'token'
  try { return readFileSync(join(homedir(), '.dsh', 'dsh-pocket', file), 'utf8').trim() } catch { return '' }
}
const TOKEN = readToken()

const failures = []
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (ok) console.log(`PASS ${name}${detail ? `  — ${detail}` : ''}`)
  else { failures.push(name); console.error(`FAIL ${name}${detail ? `  — ${detail}` : ''}`) }
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME })
const context = await browser.newContext({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))
await page.addInitScript(() => { try { localStorage.setItem('dsh.assistant.firstRunGuide.v1', 'seen') } catch { /* 无 storage */ } })

try {
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
} catch (error) {
  console.log(`SKIP 宿主不可达（${BASE}）：${String(error).slice(0, 120)}`)
  await browser.close()
  process.exit(0)
}
await page.waitForTimeout(1200)
if (await page.locator('input[name="token"]').count()) {
  await page.fill('input[name="token"]', TOKEN)
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('button[type="submit"]')])
}
await page.waitForTimeout(2500)
// 手机壳是挂载后才打 marker 的（mobile-apply 在 boot 之后跑），慢机器 / 首次冷启动会晚几秒
for (let i = 0; i < 20 && await page.locator('[data-mobile-nav="frame"]').count() === 0; i += 1) await page.waitForTimeout(500)
if (await page.locator('[data-mobile-nav="frame"]').count() === 0) {
  console.log('SKIP 页面没进手机壳（data-mobile-nav="frame" 不存在）——先确认视口 < 1024 或手机布局已生效')
  await browser.close()
  process.exit(0)
}

/** 打开「抽屉 → 账号菜单 → 设置」。 */
const openSettings = async () => {
  await page.locator('[data-mobile-nav="toggle"]').first().click({ timeout: 8000 })
  await page.waitForTimeout(700)
  await page.evaluate(() => {
    const acct = document.querySelector('[aria-label="账号菜单"]')
    if (acct) acct.click()
  })
  await page.waitForTimeout(600)
  const clicked = await page.evaluate(() => {
    const item = [...document.querySelectorAll('body > [role="menu"] *')].find((el) => (el.textContent || '').trim() === '设置')
    if (!item) return false
    item.closest('button, [role="menuitem"]')?.click?.() ?? item.click()
    return true
  })
  if (!clicked) throw new Error('账号菜单里没找到「设置」')
  await page.waitForTimeout(1200)
}
await openSettings()

/** 设置面板 = 带 _navList 子节点的 aria-modal；抽屉根节点也有 aria-modal，必须排除。 */
const selectors = {
  panel: '[aria-modal="true"]:is([data-shortcut-modal="settings"], :has(> [class$="_navList"]))',
}

const geometry = async () => page.evaluate((sel) => {
  const rect = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), display: s.display, visibility: s.visibility, opacity: s.opacity, pointerEvents: s.pointerEvents, zIndex: s.zIndex, overflowX: s.overflowX, overflowY: s.overflowY, position: s.position, borderRadius: s.borderRadius, maxHeight: s.maxHeight, height: s.height } }
  const panel = document.querySelector(sel)
  if (!panel) return { panel: null }
  const navList = panel.querySelector('[class$="_navList"]')
  const tabs = navList ? [...navList.querySelectorAll('button, [role="tab"]')].map((el) => ({ label: (el.textContent || '').trim().slice(0, 20), ...rect(el) })) : []
  const options = panel.querySelector('[class$="_options"]')
  // 「手机访问」卡片头部那一行：插件自己打 data-dsh-pocket-card="hero"（client/pocket/index.jsx）；
  // 旧构建没有标记时退到「内容区里含『开发者：』的 flex 行」——修复前后量的是同一块。
  const card = options && (options.querySelector('[data-dsh-pocket-card="hero"]')
    || [...options.querySelectorAll('div')].find((el) => (el.textContent || '').includes('开发者：') && getComputedStyle(el).display === 'flex'))
  const intro = card && (card.querySelector('[data-part="intro"]') || card.firstElementChild)
  const credit = card && (card.querySelector('[data-part="credit"]') || card.lastElementChild)
  const panelRect = panel.getBoundingClientRect()
  const hit = options ? (() => {
    const b = options.getBoundingClientRect()
    const x = Math.round(b.x + b.width / 2)
    const y = Math.round(b.y + Math.min(120, b.height / 2))
    const el = document.elementFromPoint(x, y)
    return { x, y, inside: el !== null && panel.contains(el), hit: el ? `${el.tagName}.${String(el.className).slice(0, 40)}` : null }
  })() : null
  const chainHidden = []
  for (let cur = panel; cur; cur = cur.parentElement) {
    const s = getComputedStyle(cur)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) chainHidden.push(`${cur.tagName}.${String(cur.className).slice(0, 30)}`)
  }
  return {
    panel: rect(panel), panelScrollW: panel.scrollWidth, panelScrollH: panel.scrollHeight,
    navList: navList ? rect(navList) : null,
    tabs, options: options ? { ...rect(options), scrollWidth: options.scrollWidth, clientWidth: options.clientWidth } : null,
    card: card ? { ...rect(card), scrollWidth: card.scrollWidth, clientWidth: card.clientWidth } : null,
    intro: intro ? rect(intro) : null, credit: credit ? rect(credit) : null,
    hit, chainHidden, viewport: { w: window.innerWidth, h: window.innerHeight }, panelRight: +panelRect.right.toFixed(1), panelLeft: +panelRect.left.toFixed(1),
  }
}, selectors.panel)

const before = await geometry()
check('设置面板存在（aria-modal + _navList）', before.panel !== null, before.panel ? `pos=${before.panel.position} ${before.panel.w}×${before.panel.h}` : '节点不存在')
if (before.panel) {
  check('面板宽度非 0', before.panel.w > 0, `${before.panel.w}px`)
  check('面板不超出视口', before.panel.w <= before.viewport.w && before.panel.x >= 0, `panel x=${before.panel.x} w=${before.panel.w} vw=${before.viewport.w}`)
  check('面板未被隐藏（自身 + 祖先链）', before.chainHidden.length === 0 && before.panel.display !== 'none' && before.panel.visibility !== 'hidden' && Number(before.panel.opacity) > 0,
    `display=${before.panel.display} visibility=${before.panel.visibility} opacity=${before.panel.opacity} hiddenChain=${JSON.stringify(before.chainHidden)}`)
  check('面板高度收在视口内（≤ vh-12）', before.panel.h <= before.viewport.h - 12, `h=${before.panel.h} vh=${before.viewport.h}`)
  check('tab 列表不是横向滚动条（换行排布）', before.navList !== null && before.navList.overflowX !== 'auto',
    before.navList ? `overflowX=${before.navList.overflowX} w=${before.navList.w}` : '缺 _navList')
}

// 点「个人助手」（tab 可能在横向滚动区外，用 JS 直接点到标签上）
const tabClicked = await page.evaluate(() => {
  const panel = document.querySelector('[aria-modal="true"]:is([data-shortcut-modal="settings"], :has(> [class$="_navList"]))')
  if (!panel) return false
  const tab = [...panel.querySelectorAll('button, [role="tab"]')].find((el) => (el.textContent || '').includes('个人助手'))
  if (!tab) return false
  tab.scrollIntoView({ block: 'nearest', inline: 'center' })
  tab.click()
  return true
})
await page.waitForTimeout(1200)
check('能点到「个人助手」标签', tabClicked, tabClicked ? '' : '找不到标签')

const after = await geometry()
if (after.panel) {
  const outside = after.tabs.filter((t) => t.x < after.panelLeft - 0.5 || t.x + t.w > after.panelRight + 0.5)
  check('所有设置标签都在面板内（不被裁掉）', after.tabs.length > 0 && outside.length === 0,
    `tabs=${after.tabs.length} outside=${JSON.stringify(outside.map((t) => `${t.label}(${t.x}+${t.w})`))}`)
  check('内容区宽度非 0 且无横向溢出', after.options !== null && after.options.w > 0 && after.options.scrollWidth <= after.options.clientWidth + 1,
    after.options ? `w=${after.options.w} scrollWidth=${after.options.scrollWidth} clientWidth=${after.options.clientWidth}` : '缺 _options')
  check('「手机访问」卡片在面板内且无横向溢出', after.card !== null && after.card.scrollWidth <= after.card.clientWidth + 1,
    after.card ? `card w=${after.card.w} scrollWidth=${after.card.scrollWidth} clientWidth=${after.card.clientWidth} credit=${after.credit ? `${after.credit.w}×${after.credit.h}` : 'n/a'}` : '卡片不存在（个人助手页未渲染）')
  // 卡片左列（标题+说明）必须拿到可读宽度：旧布局里右列 nowrap 把它压到 4-6 个字一行
  check('卡片标题/说明列宽度 ≥ 120px（不被右列挤成竖排）', after.intro !== null && after.intro.w >= 120,
    after.intro ? `intro w=${after.intro.w} credit w=${after.credit ? after.credit.w : 'n/a'}` : '卡片左列不存在')
  check('内容区中心点击命中面板内部（没被遮罩/抽屉盖住）', after.hit !== null && after.hit.inside === true,
    after.hit ? `${after.hit.x},${after.hit.y} → ${after.hit.hit}` : '无法命中')
  check('页脚/文案真的渲染出文字', after.options !== null && after.options.h > 40, after.options ? `options h=${after.options.h}` : '')
}
check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

console.log(JSON.stringify({ viewport: after.viewport || before.viewport, panel: after.panel || before.panel, options: after.options, card: after.card, tabs: (after.tabs || []).length }, null, 1))
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} ${checks.filter((c) => c.ok).length}/${checks.length} mobile-settings-live${failures.length ? ` — ${failures.join('; ')}` : ''}`)
await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
