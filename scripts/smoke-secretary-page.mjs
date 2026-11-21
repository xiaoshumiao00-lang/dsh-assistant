/**
 * 个人秘书真页面冒烟（Playwright + 本机 Chrome，手机视口）：
 *   node scripts/smoke-secretary-page.mjs
 *   DSH_POCKET_URL=http://127.0.0.1:3081 DSH_POCKET_TOKEN=… node scripts/smoke-secretary-page.mjs
 *
 * 为什么要这一层：前几轮都是「build + 单测全绿，用户重启后照样报错」。这个脚本把 pocket
 * 页面真开到浏览器里，用真实指针手势长按悬浮球 600ms，然后检查：
 *   1. 加载与交互期没有未捕获异常；console error 只剩已知的宿主既有噪声（见 IGNORED_CONSOLE）；
 *   2. 长按后**主面板真的切到固定秘书会话**（__dshUiWorkspace.selection = 宿主记录的 sessionId），
 *      且页面是标准会话页：没有自制外壳（data-pocket-secretary）、没有骨架条、没有旧空态文案；
 *   3. 重复长按复用同一条固定会话（宿主 id 与 localStorage 都不变、页面没被重载）；
 *   4. 中间显示区不震荡：打开后 6s 内 DOM 变更次数有上限，且采样不到骨架/空态；
 *   5. 主动服务卡片：拦截 /api/assistant/proactive 返回示例卡 → 卡片必须渲染、可展开；
 *      会话还没有任何一轮时，用插件自己的 __dshPromptIntoSession 真发一句、等模型回完再验
 *      （这同时验证「真发一条消息能收到回复」这条端到端链路）。
 *
 * 退出码 0 = 全绿。任何断言失败都会打印现场事实。
 */
import { chromium } from 'playwright'

const BASE = process.env.DSH_POCKET_URL || 'http://127.0.0.1:3081'
const TOKEN = process.env.DSH_POCKET_TOKEN || '96528673'
const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/** 宿主既有噪声（与本次改动无关，实测在未改代码的页面上同样出现）。 */
const IGNORED_CONSOLE = [
  /worktable\/file/, // 项目卡片探测 widget-result.json：404/403 是项目里本来就没有这个文件
  /deepseek-account.*account read failed/, // 余额读取失败（未登录平台账号）
]

const DEMO_CARD = {
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
  details: '一、天气\n武汉全天 8–14℃，多云转小雨。\n\n二、行程\n· 08:12 G1545 孝感东 → 08:49 汉口\n· 10:30 华工结构实验室开会',
  time: '今天 07:40',
  badge: '主动服务',
}

const failures = []
const notes = []
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
    return true
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME })
const context = await browser.newContext({
  viewport: { width: 414, height: 896 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
})
const page = await context.newPage()

// 首次使用引导会在悬浮球上方盖一层 mask（data-dsh-assistant-guide），真实用户点过一次就没了；
// 冒烟里直接标成已看过，否则长按落在 mask 上、测的就不是悬浮球了。
await page.addInitScript(() => {
  try { localStorage.setItem('dsh.assistant.firstRunGuide.v1', 'seen') } catch { /* 无 storage 时忽略 */ }
})

const consoleErrors = []
const pageErrors = []
const failedRequests = []
/** 已知的宿主既有 4xx（与本次改动无关；项目卡片探测 widget-result.json 时本来就没有这个文件）。 */
const IGNORED_FAILED_URL = /\/api\/worktable\/file\?/
page.on('console', (message) => {
  if (message.type() !== 'error') return
  const text = String(message.text())
  // 「Failed to load resource」不带 URL，按 URL 单独核对（见 failedRequests）
  if (text.startsWith('Failed to load resource')) return
  if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return
  consoleErrors.push(text.slice(0, 300))
})
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
page.on('response', (response) => {
  if (response.status() < 400) return
  const url = response.url()
  if (IGNORED_FAILED_URL.test(url)) return
  failedRequests.push(`${response.status()} ${url.slice(0, 200)}`)
})

// 主动服务卡片：默认拦下宿主路由返回示例卡（宿主侧代码要重启才进内存，客户端渲染这一层随时能验）。
// DSH_SMOKE_REAL_CARD=1 时不拦，直接验宿主真实卡组（宿主已经带 /api/assistant/proactive 时用）。
const REAL_CARD = process.env.DSH_SMOKE_REAL_CARD === '1'
if (!REAL_CARD) {
  await page.route('**/api/assistant/proactive**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, cards: [DEMO_CARD] }),
  }))
}

const readHostSecretaryId = () => page.evaluate(async () => {
  const body = await fetch('/api/assistant/secretary', { cache: 'no-store' }).then((res) => res.json()).catch(() => null)
  return String(body?.sessionId ?? '')
})
const readCurrentSessionId = () => page.evaluate(() => {
  try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') } catch { return '' }
})
const longPressBall = async () => {
  const ball = await page.$('button[data-pocket-orb="ball"]')
  if (!ball) return false
  const box = await ball.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(750)
  await page.mouse.up()
  return true
}

try {
  const response = await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  check('页面加载', (response?.status() ?? 0) === 200, `status=${response?.status()}`)

  await page.waitForSelector('button[data-pocket-orb="ball"]', { timeout: 30000 })
  // 等宿主自己把「上次打开的会话」恢复完（冷启动时页面会先把主面板切到一条空白会话），
  // 这样长按测的是用户真实场景（页面已经稳定后再按），而不是抢在启动竞态里。
  await page.waitForTimeout(9000)

  const bundle = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name)
    const hit = urls.find((url) => url.includes('dsh-assistant/client.js'))
    if (!hit) return { found: false, hasProactive: false, hasTurnDedup: false }
    const text = await fetch(hit, { cache: 'no-store' }).then((res) => res.text())
    return {
      found: true,
      hasProactive: text.includes('dsh-proactive'),
      hasTurnDedup: text.includes('dsh-proactive-turn'),
      length: text.length,
    }
  })
  check('宿主下发的客户端 bundle 是本次构建', bundle.found && bundle.hasProactive && bundle.hasTurnDedup, JSON.stringify(bundle))

  const hostIdBefore = await readHostSecretaryId()
  notes.push(`宿主固定会话 id（长按前）= ${hostIdBefore || '(空)'}`)

  // ── 观察窗口：DOM 变更计数 + 每 100ms 文本采样 ──
  await page.evaluate(() => {
    window.__smokeStamp = String(Date.now())
    window.__smokeMutations = 0
    window.__smokeObserver = new MutationObserver((records) => { window.__smokeMutations += records.length })
    window.__smokeObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    window.__smokeTexts = []
    window.__smokeSampler = setInterval(() => {
      try { window.__smokeTexts.push((document.body.innerText || '').slice(0, 500)) } catch { /* 忽略 */ }
    }, 100)
  })

  check('长按悬浮球', await longPressBall())

  // 等主面板切到固定秘书会话：selection.sessionId == 宿主 id
  const hostIdNow = await readHostSecretaryId()
  const switched = await page.waitForFunction((wanted) => {
    try {
      const current = String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '')
      const local = String(localStorage.getItem('dsh.assistant.secretary.sessionId') || '')
      const target = wanted || local
      return current !== '' && target !== '' && current === target ? { current, local } : false
    } catch { return false }
  }, hostIdBefore || '', { timeout: 45000 }).then((handle) => handle.jsonValue()).catch(() => null)
  await page.waitForTimeout(4000)

  const hostIdAfter = await readHostSecretaryId()
  const currentId = await readCurrentSessionId()
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    mutations: window.__smokeMutations,
    customShell: document.querySelectorAll('[data-pocket-secretary]').length,
    skeleton: document.querySelectorAll('[data-pocket-secretary="skeleton"], [data-dsh-proactive="skeleton"]').length,
    composer: !!document.querySelector('[contenteditable="true"], textarea'),
    cards: document.querySelectorAll('[data-dsh-proactive="card"]').length,
    texts: window.__smokeTexts || [],
    // 采样只留前 500 字（卡片在上半屏时看不到底部状态行），这里单独取一次完整文本
    fullText: (document.body.innerText || '').slice(-3000),
  }))
  notes.push(`切换结果: ${JSON.stringify(switched)}；宿主 id（长按后）= ${hostIdAfter}；selection = ${currentId}`)

  check('长按 600ms 后主面板切到固定秘书会话', currentId !== '' && currentId === (hostIdAfter || ''), `selection=${currentId} host=${hostIdAfter}`)
  check('没有新建会话（宿主 id 没被换掉）', hostIdBefore === '' || hostIdAfter === hostIdBefore, `${hostIdBefore} → ${hostIdAfter}`)
  check('没有自制秘书外壳（data-pocket-secretary）', snapshot.customShell === 0, `count=${snapshot.customShell}`)
  check('没有骨架条', snapshot.skeleton === 0, `count=${snapshot.skeleton}`)
  check('会话页有输入框（标准 composer）', snapshot.composer === true)
  const sawOldEmpty = snapshot.texts.some((text) => text.includes('个人秘书已就位'))
  check('不再出现「个人秘书已就位」空态', !sawOldEmpty)
  const sawOldSections = snapshot.texts.some((text) => /主动服务\s*\n.*条动态/.test(text))
  check('不再出现旧卡片瀑布的分区标题', !sawOldSections)
  // 验收：页面上不许出现「只读权限未确认」横幅（只读拦截发生在宿主侧，页面不挂黄字）
  const sawReadOnlyBanner = snapshot.texts.some((text) => text.includes('只读权限未确认'))
  check('没有「只读权限未确认」横幅', !sawReadOnlyBanner)
  // 验收：底部必须是标准会话页的轮次 / token 状态行
  const sawStatusLine = /\btok\b/i.test(snapshot.fullText) && /轮/.test(snapshot.fullText)
  check('底部有标准轮次与 token 状态行', sawStatusLine, `tail=${snapshot.fullText.slice(-160).replace(/\n+/g, ' / ')}`)
  check('打开后 6 秒内 DOM 变更次数有限（不震荡）', snapshot.mutations < 4000, `mutations=${snapshot.mutations}`)

  // ── 主动服务卡片 ──
  let cardOk = await page.waitForSelector('[data-dsh-proactive="card"]', { timeout: 6000 }).then(() => true).catch(() => false)
  if (!cardOk) {
    // 这条会话还没有任何一轮 → 真发一句（插件自己的调试入口），等模型回完再验卡片。
    notes.push('会话暂无历史轮次：真实发送一条消息，等待模型回复（最多 120s）')
    await page.evaluate((id) => {
      const fn = window.__dshPromptIntoSession
      if (typeof fn === 'function') fn(id, '（冒烟测试）只回复两个字：收到')
    }, currentId)
    cardOk = await page.waitForSelector('[data-dsh-proactive="card"]', { timeout: 120000 }).then(() => true).catch(() => false)
  }
  check('主动服务卡片渲染出来了', cardOk)
  if (cardOk) {
    const cardText = await page.$eval('[data-dsh-proactive="card"]', (el) => el.textContent || '')
    check('卡片标题正确', cardText.includes('主动关心 · 明日武汉出差'), cardText.slice(0, 60))
    await page.click('[data-dsh-proactive="toggle"]')
    await page.waitForTimeout(400)
    const expanded = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-proactive="card"]')
      const details = document.querySelector('[data-dsh-proactive="details"]')
      return { open: card?.getAttribute('data-open') === '1', details: (details?.textContent || '').includes('G1545') }
    })
    check('卡片可点开查看详情', expanded.open && expanded.details, JSON.stringify(expanded))
    // 卡片是会话级常驻信息：turnTail 每轮都会渲染一次，必须只在最末一轮出现（不能每轮一张）
    const single = await page.waitForFunction(
      () => document.querySelectorAll('[data-dsh-proactive="wrap"]').length === 1
        && document.querySelectorAll('[data-dsh-proactive="card"]').length === 1,
      undefined,
      { timeout: 6000 },
    ).then(() => true).catch(() => false)
    const groups = await page.evaluate(() => ({
      wraps: document.querySelectorAll('[data-dsh-proactive="wrap"]').length,
      cards: document.querySelectorAll('[data-dsh-proactive="card"]').length,
    }))
    check('主动服务卡只在最末一轮出现一次（不重复）', single, JSON.stringify(groups))
  }

  // ── 第二次长按：复用同一条会话、页面不重载 ──
  const beforeSecond = await page.evaluate(() => ({
    stamp: window.__smokeStamp,
    local: String(localStorage.getItem('dsh.assistant.secretary.sessionId') || ''),
  }))
  const pressed = await longPressBall()
  if (pressed) await page.waitForTimeout(3500)
  const afterSecond = await page.evaluate(async () => ({
    stamp: window.__smokeStamp,
    local: String(localStorage.getItem('dsh.assistant.secretary.sessionId') || ''),
    host: String((await fetch('/api/assistant/secretary', { cache: 'no-store' }).then((res) => res.json()).catch(() => null))?.sessionId ?? ''),
    current: (() => { try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') } catch { return '' } })(),
  }))
  check('重复长按没有重载页面', afterSecond.stamp === beforeSecond.stamp, `${beforeSecond.stamp} → ${afterSecond.stamp}`)
  check('重复进入仍是同一条固定会话',
    afterSecond.local === beforeSecond.local && afterSecond.host === beforeSecond.local && afterSecond.current === afterSecond.host,
    JSON.stringify({ before: beforeSecond.local, after: afterSecond.local, host: afterSecond.host, current: afterSecond.current }))

  // ── 30 秒存活 ──
  await page.waitForTimeout(12000)
  const alive = await page.evaluate(() => ({
    title: document.title,
    cards: document.querySelectorAll('[data-dsh-proactive="card"]').length,
    shell: document.querySelectorAll('[data-pocket-secretary]').length,
  }))
  check('页面 30s 内没崩', alive.title.includes('DeepSeek Harness') || alive.title.includes('个人秘书'), `title=${alive.title}`)
  check('30s 后卡片仍在（没有闪没）', !cardOk || alive.cards >= 1, `cards=${alive.cards}`)
  check('30s 后仍无自制外壳', alive.shell === 0)

  check('无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
  check('无（非既有噪声的）console error', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)))
  check('没有意外的失败请求（只允许既有的项目探测 4xx）', failedRequests.length === 0, JSON.stringify(failedRequests.slice(0, 5)))

  await page.evaluate(() => {
    try {
      clearInterval(window.__smokeSampler)
      window.__smokeObserver?.disconnect()
    } catch { /* 忽略 */ }
  })
  await page.screenshot({ path: 'tmp-secretary-smoke.png' })
  notes.push('截图: tmp-secretary-smoke.png')
} catch (error) {
  failures.push(`冒烟脚本异常：${String(error)}`)
  console.error(error)
} finally {
  await browser.close()
}

if (notes.length > 0) console.log('\n--- 现场事实 ---\n' + notes.join('\n'))
if (failures.length > 0) {
  console.error(`\nSMOKE FAIL ${failures.length} 项`)
  process.exit(1)
}
console.log('\nSMOKE PASS 全部通过')
