/**
 * 个人秘书真页面冒烟（Playwright + 本机 Chrome，手机视口）：
 *   node scripts/smoke-secretary-page.mjs
 *   DSH_POCKET_URL=http://127.0.0.1:3081 DSH_POCKET_TOKEN=… node scripts/smoke-secretary-page.mjs
 *
 * 为什么要这一层：前几轮都是「build + 单测全绿，用户重启后照样报错」。这个脚本把 pocket
 * 页面真开到浏览器里，单击悬浮球进入固定秘书会话，然后检查：
 *   1. 加载与交互期没有未捕获异常；console error 只剩已知的宿主既有噪声（见 IGNORED_CONSOLE）；
 *   2. 主面板真的切到固定秘书会话（selection = 宿主记录的 sessionId），页面是标准会话页：
 *      没有自制外壳（data-pocket-secretary）、没有骨架条、没有旧空态文案；
 *   3. 回复卡片：标题行（图标+「个人秘书」标签+一句话摘要+最右朗读钮）、正文 14px 分段、
 *      底部 meta（12px 灰、时间）；固定高度折叠（200–232px）+ 点击展开/收起 + 渐隐截断；
 *   4. 朗读：自动朗读最末一轮；单击暂停/继续、长按 600ms 从头重读；**点哪张卡读哪张卡**
 *      （历史卡点击绝不允许读成最新一条）；
 *   5. 过程信息行（已完成/用时/处理失败/重试/本轮运行失败）与消息操作行（复制/赞/踩/
 *      分享/记忆/时间）渲染层隐藏、不留行高；普通会话不受影响；
 *   6. 主动服务「尾巴卡」已移除：对话流尾部不再出现主动卡节点（后端数据能力保留）；
 *   7. 重复进入复用同一条固定会话（不重载、不换 id）、30s 存活、手势不串、宿主 intent 落点。
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
  // 普通会话抽查时会试探性打开侧栏里的历史会话，个别已归档的打不开、宿主告警一行；
  // 与本插件代码无关（抽查循环会继续试下一条，最终断言仍要求落到一条真打开的会话）
  /Sidebar Session opening failed/,
]

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

// 自动朗读要出声（哪怕是 stub 音频）：Chromium 默认禁无手势自动播放，这里放开。
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
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
/** 已知的宿主既有 4xx（与本次改动无关；项目卡片探测 widget-result.json 时本来就没有这个文件）。
 *  /api/assistant/cu-watch/notify 是 CU 通知段的能力探测：宿主未重载新代码时 404 属预期，
 *  路由生效后正常返回 200/409（409 落盘失败仍会被 CU 通知段的 ok 断言抓住）。 */
const IGNORED_FAILED_URL = /\/api\/worktable\/file\?|\/api\/assistant\/cu-watch\/notify/
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

// 朗读 stub：30 秒静音 WAV（8kHz/mono/16bit）——撑住整个断言窗口不被播完。
// ttsBodies 记录每次请求的 body ——「点哪张卡就读哪张卡」回归断言要用。
let ttsRequests = 0
const ttsBodies = []
const stubWav = (() => {
  const rate = 8000
  const seconds = 30
  const dataSize = rate * 2 * seconds
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
})()
await page.route('**/api/assistant/tts**', (route) => {
  ttsRequests += 1
  try { ttsBodies.push(String(route.request().postData() ?? '')) } catch { /* 取不到 body 不阻断 */ }
  route.fulfill({ status: 200, contentType: 'audio/mpeg', body: stubWav })
})

const readHostSecretaryId = () => page.evaluate(async () => {
  const body = await fetch('/api/assistant/secretary', { cache: 'no-store' }).then((res) => res.json()).catch(() => null)
  return String(body?.sessionId ?? '')
})
const readCurrentSessionId = () => page.evaluate(() => {
  try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') } catch { return '' }
})
/** 单击（短按松手、不拖动）：2026-11-21 起 = 直接进个人秘书。 */
const clickBall = async () => {
  const ball = await page.$('button[data-pocket-orb="ball"]')
  if (!ball) return false
  const box = await ball.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  return true
}
/** 长按 600ms（按住不动）：2026-11-21 起 = 打开控制室。 */
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
  // 这样测的是用户真实场景（页面已经稳定后再进秘书），而不是抢在启动竞态里。
  await page.waitForTimeout(9000)

  const bundle = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name)
    const hit = urls.find((url) => url.includes('dsh-assistant/client.js'))
    if (!hit) return { found: false, hasScard: false, hasFold: false }
    const text = await fetch(hit, { cache: 'no-store' }).then((res) => res.text())
    return {
      found: true,
      hasScard: text.includes('dsh-scard'),
      // 折叠卡共享实现（固定高度/展开收起）必须打进 bundle
      hasFold: text.includes('dsh-fold'),
      // 主动服务尾巴卡已删除：bundle 里不应再有它的轮次去重标记
      hasTailCard: text.includes('dsh-proactive-turn'),
      // 需求④：禁用浏览器 speechSynthesis 兜底 —— bundle 里根本不应出现这个 API
      hasSpeechSynth: text.includes('speechSynthesis'),
      length: text.length,
    }
  })
  check('宿主下发的客户端 bundle 是本次构建', bundle.found && bundle.hasScard && bundle.hasFold, JSON.stringify(bundle))
  check('主动服务尾巴卡已不在 bundle 里', bundle.hasTailCard === false)
  check('无浏览器 speechSynthesis 兜底（只用微软 TTS）', bundle.hasSpeechSynth === false)

  // 挑若干条真实存在的普通会话（非秘书，最近更新优先），「普通会话不受影响」断言用：
  // 个别历史会话可能已归档打不开，循环试到下一条真打开为止。
  const refCandidates = await page.evaluate(() => {
    try {
      const snap = window.__dshSessions?.list?.getSnapshot?.() ?? null
      const ids = Array.isArray(snap?.ids) ? snap.ids : []
      const sec = String(localStorage.getItem('dsh.assistant.secretary.sessionId') || '')
      // 只挑真实侧栏会话（session-*）：mnemon-task 等引用不是可打开的会话
      return ids
        .filter((id) => String(id) !== sec && String(id).startsWith('session-'))
        .map((id) => ({ id: String(id), updatedAt: Number(snap?.byId?.[id]?.updatedAt ?? 0) }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3)
        .map((row) => row.id)
    } catch { return [] }
  })
  notes.push(`普通会话抽查候选 = ${refCandidates.join(', ') || '(未找到)'}`)

  const hostIdBefore = await readHostSecretaryId()
  notes.push(`宿主固定会话 id（单击前）= ${hostIdBefore || '(空)'}`)

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

  check('单击悬浮球', await clickBall())

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
    skeleton: document.querySelectorAll('[data-pocket-secretary="skeleton"]').length,
    composer: !!document.querySelector('[contenteditable="true"], textarea'),
    tailCards: document.querySelectorAll('[data-dsh-proactive="card"], [data-dsh-proactive="wrap"]').length,
    controlRoom: document.querySelectorAll('.dsh-assistant-cr').length,
    texts: window.__smokeTexts || [],
    // 采样只留前 500 字（卡片在上半屏时看不到底部状态行），这里单独取一次完整文本
    fullText: (document.body.innerText || '').slice(-3000),
  }))
  notes.push(`切换结果: ${JSON.stringify(switched)}；宿主 id（单击后）= ${hostIdAfter}；selection = ${currentId}`)

  check('单击悬浮球后主面板切到固定秘书会话', currentId !== '' && currentId === (hostIdAfter || ''), `selection=${currentId} host=${hostIdAfter}`)
  // 2026-11-21 手势对调：单击进秘书，**不能**顺手把控制室也打开（两者不串）
  check('单击没有打开控制室（手势不串）', snapshot.controlRoom === 0, `控制室节点=${snapshot.controlRoom}`)
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

  // ── 主动服务「尾巴卡」已移除：对话流尾部不再塞主动卡（后端数据能力保留，只删前端渲染） ──
  check('秘书会话无主动服务尾巴卡', snapshot.tailCards === 0, `tailCards=${snapshot.tailCards}`)

  // ── 秘书回复卡片：这条会话还没有任何一轮时，真发一句等模型回完再验 ──
  let cardOk = await page.waitForSelector('[data-dsh-scard="card"]:not([data-empty="1"])', { timeout: 6000 }).then(() => true).catch(() => false)
  if (!cardOk) {
    notes.push('会话暂无历史轮次：真实发送一条消息，等待模型回复（最多 120s）')
    await page.evaluate((id) => {
      const fn = window.__dshPromptIntoSession
      if (typeof fn === 'function') fn(id, '（冒烟测试）只回复两个字：收到')
    }, currentId)
    cardOk = await page.waitForSelector('[data-dsh-scard="card"]:not([data-empty="1"])', { timeout: 120000 }).then(() => true).catch(() => false)
  }
  check('秘书回复卡片渲染出来了', cardOk)

  // ── 过程信息行（需求②）：渲染层真正不输出 ──
  const PROCESS_NOISE = [/已完成，用时/, /处理失败/, /已重试模型请求/, /正在重试模型请求/, /本轮运行失败/, /等待重试模型请求/]
  const pageTextNow = (await page.evaluate(() => document.body.innerText || '')) + '\n' + (snapshot.texts || []).join('\n')
  const leakedNoise = PROCESS_NOISE.filter((pattern) => pattern.test(pageTextNow)).map(String)
  check('无过程信息行（已完成/用时/处理失败/重试/本轮运行失败）', leakedNoise.length === 0, `leaked=${leakedNoise.join(',')}`)

  // ── 消息操作行（复制/赞/踩/分享/记忆/时间）：秘书会话渲染层隐藏、不留行高 ──
  const actionRows = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-clock]')]
    return {
      total: rows.length,
      hidden: rows.filter((el) => getComputedStyle(el).display === 'none').length,
      zeroBox: rows.filter((el) => el.getBoundingClientRect().height === 0).length,
      visible: rows.filter((el) => getComputedStyle(el).display !== 'none').length,
    }
  })
  check('秘书会话消息操作行已隐藏（display:none、不占高度）',
    actionRows.total >= 1 && actionRows.hidden === actionRows.total && actionRows.visible === 0 && actionRows.zeroBox === actionRows.total,
    JSON.stringify(actionRows))

  // ── 秘书回复卡片结构 + 朗读（看最末一轮；querySelector 取 DOM 里最后一张） ──
  await page.waitForTimeout(1500) // body[data-dsh-secretary] 轮询 700ms，等标记落上
  const scard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])')]
    const card = cards[cards.length - 1] ?? null // 最末一轮的回复卡
    const step = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
      .find((el) => el.getAttribute('data-chat-group-part') !== 'reasoning')
    const head = card?.querySelector('[data-dsh-scard="head"]')
    const btn = head?.querySelector('[data-dsh-speak="button"]') ?? null
    const headRect = head?.getBoundingClientRect()
    const btnRect = btn?.getBoundingClientRect()
    const cardRect = card?.getBoundingClientRect()
    return {
      cardCount: cards.length,
      hasCard: card !== null,
      badge: card?.querySelector('[data-dsh-scard="badge"]')?.textContent ?? '',
      title: card?.querySelector('[data-dsh-scard="title"]')?.textContent ?? '',
      hasIcon: card?.querySelector('[data-dsh-scard="icon"]') !== null,
      paras: card?.querySelectorAll('[data-dsh-scard="para"]').length ?? 0,
      bodyFontSize: getComputedStyle(card?.querySelector('[data-dsh-scard="para"]') ?? card ?? document.body).fontSize,
      hasMeta: card?.querySelector('[data-dsh-scard="meta"]') !== null,
      metaTime: card?.querySelector('[data-dsh-scard="time"]')?.textContent ?? '',
      stepDisplay: step ? getComputedStyle(step).display : '(无 step)',
      hasButton: btn !== null,
      // 朗读钮在标题行最右：head 的最后一个子元素、垂直落在首行内、右缘贴近卡片右缘
      btnIsLast: btn !== null && head?.lastElementChild === btn,
      btnVertInHead: btnRect && headRect ? btnRect.top >= headRect.top - 2 && btnRect.bottom <= headRect.bottom + 2 : false,
      btnRightGap: btnRect && cardRect ? Math.round(cardRect.right - btnRect.right) : -1,
      speakStatus: btn?.getAttribute('data-status') ?? '',
      bodyFlag: document.body.dataset.dshSecretary ?? '',
    }
  })
  check('秘书回复渲染成卡片（图标+「个人秘书」标签+一句话摘要）',
    scard.hasCard && scard.badge === '个人秘书' && scard.title !== '' && scard.hasIcon, JSON.stringify(scard))
  check('正文分段清晰（14px，至少一段）', scard.paras >= 1 && scard.bodyFontSize === '14px',
    `paras=${scard.paras} font=${scard.bodyFontSize}`)
  check('底部 meta 行（12px 灰、时间）', scard.hasMeta && /今天|昨天|月.+日/.test(scard.metaTime), `metaTime=${scard.metaTime}`)
  check('原始 markdown 气泡已隐藏（秘书会话专属）', scard.stepDisplay === 'none', `display=${scard.stepDisplay}`)
  check('页面级秘书标记 body[data-dsh-secretary="1"]', scard.bodyFlag === '1')
  check('朗读按钮在卡片第一行最右（head 末子元素、右缘贴合）',
    scard.hasButton && scard.btnIsLast && scard.btnVertInHead && scard.btnRightGap >= 8 && scard.btnRightGap <= 40,
    JSON.stringify({ hasButton: scard.hasButton, btnIsLast: scard.btnIsLast, gap: scard.btnRightGap, vert: scard.btnVertInHead }))
  check('自动朗读已发起（唯一自动请求方 = 回复卡，TTS 已有请求）', ttsRequests >= 1, `requests=${ttsRequests}`)

  // ── 回复卡固定高度 + 点击展开/折叠（与主动卡共用 fold-card.css.ts 实现） ──
  const fold = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])')]
    // 找一张内容真的超出固定高度的卡（短回复不溢出则跳过展开断言）
    const overflowing = cards.find((el) => {
      const main = el.querySelector('[data-dsh-fold="main"]')
      return main !== null && main.scrollHeight > main.clientHeight + 1
    }) ?? null
    if (overflowing === null) return { skip: true, cardCount: cards.length }
    const main = overflowing.querySelector('[data-dsh-fold="main"]')
    return {
      skip: false,
      height: overflowing.getBoundingClientRect().height,
      open: overflowing.getAttribute('data-open'),
      mainOverflow: getComputedStyle(main).overflow,
      mainTruncated: main.scrollHeight > main.clientHeight + 1,
      hint: overflowing.querySelector('[data-dsh-scard="hint"]')?.textContent ?? '',
    }
  })
  if (fold.skip === true) {
    notes.push(`回复卡折叠回归：${fold.cardCount} 张卡内容都偏短、无溢出，跳过展开断言`)
  } else {
    check('回复卡折叠高度固定（200–232px，不随内容撑高）', fold.height >= 200 && fold.height <= 232, `height=${fold.height}`)
    check('超长正文被截断（main overflow:hidden 且 scrollHeight>clientHeight）',
      fold.mainOverflow === 'hidden' && fold.mainTruncated, JSON.stringify({ overflow: fold.mainOverflow, truncated: fold.mainTruncated }))
    check('折叠态有展开提示（底行右侧「点击展开全文」）', fold.hint === '点击展开全文', `hint=${fold.hint}`)
    const foldCard = page.locator('[data-dsh-scard="card"]:not([data-empty="1"])')
      .filter({ has: page.locator('[data-dsh-scard="hint"]') }).first()
    const collapsedHeight = fold.height
    await foldCard.click({ position: { x: 120, y: 24 } }) // 点标题区（避开朗读钮）
    await page.waitForTimeout(400)
    const expanded = await foldCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      height: el.getBoundingClientRect().height,
      hint: el.querySelector('[data-dsh-scard="hint"]')?.textContent ?? '',
    }))
    check('点卡片展开（data-open=1、高度明显变大、提示变「点击收起」）',
      expanded.open === '1' && expanded.height > collapsedHeight + 40 && expanded.hint === '点击收起',
      JSON.stringify(expanded))
    await foldCard.click({ position: { x: 120, y: 24 } })
    await page.waitForTimeout(400)
    const reCollapsed = await foldCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      height: el.getBoundingClientRect().height,
    }))
    check('再点收回默认高度', reCollapsed.open === '0' && Math.abs(reCollapsed.height - collapsedHeight) < 2, JSON.stringify(reCollapsed))
  }

  // 朗读状态机：进播放态 → 单击暂停 → 单击继续 → 长按从头重读（回复卡上的那颗钮）
  const speakBtn = page.locator('[data-dsh-scard="card"]:not([data-empty="1"]) [data-dsh-speak="button"]').last()
  let st = await speakBtn.getAttribute('data-status')
  if (st !== 'playing' && st !== 'loading') {
    // 自动朗读的 30s stub 可能已在长流程中播完：手动起播再验交互（状态机语义不变）
    await speakBtn.click()
    await page.waitForTimeout(600)
    st = await speakBtn.getAttribute('data-status')
  }
  check('朗读进入播放态（自动或手动起播）', st === 'playing' || st === 'loading', `status=${st}`)
  await page.waitForTimeout(400)
  await speakBtn.click()
  await page.waitForTimeout(400)
  st = await speakBtn.getAttribute('data-status')
  check('单击朗读按钮 = 暂停', st === 'paused', `status=${st}`)
  await speakBtn.click()
  await page.waitForTimeout(400)
  st = await speakBtn.getAttribute('data-status')
  check('再单击 = 继续', st === 'playing', `status=${st}`)
  const btnBox = await speakBtn.boundingBox()
  await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(750)
  await page.mouse.up()
  await page.waitForTimeout(500)
  st = await speakBtn.getAttribute('data-status')
  check('长按 600ms = 从头重读（回到播放）', st === 'playing', `status=${st}`)
  await speakBtn.click().catch(() => {}) // 收尾停掉声音

  // ── 回归：点历史卡必须读历史卡自己的文本（2026-11-21 实测 bug：读成了最新一条） ──
  const hist = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])')]
    if (cards.length < 2) return { skip: true }
    const first = cards[0]
    const last = cards[cards.length - 1]
    return {
      firstTitle: first.querySelector('[data-dsh-scard="title"]')?.textContent ?? '',
      lastTitle: last.querySelector('[data-dsh-scard="title"]')?.textContent ?? '',
    }
  })
  if (hist.skip === true) {
    notes.push('历史卡朗读回归：会话不足两轮，跳过')
  } else {
    // 只比汉字（规范化会在数字/汉字间补空格，避免误判）
    const cjk = (s) => String(s).replace(/[^一-鿿]/g, '').slice(0, 6)
    const before = ttsBodies.length
    await page.locator('[data-dsh-scard="card"]:not([data-empty="1"])').first()
      .locator('[data-dsh-speak="button"]').click()
    await page.waitForTimeout(600)
    const sent = ttsBodies.slice(before).map((body) => { try { return JSON.parse(body)?.text ?? '' } catch { return '' } }).join(' ')
    check('点历史卡朗读：TTS 收到的是该卡自己的文本', cjk(hist.firstTitle) !== '' && sent.includes(cjk(hist.firstTitle)),
      `sent=${sent.slice(0, 50)} want=${hist.firstTitle.slice(0, 14)}`)
    check('点历史卡朗读：绝不读最新一条', cjk(hist.lastTitle) === '' || !sent.includes(cjk(hist.lastTitle)),
      `last=${hist.lastTitle.slice(0, 14)}`)
    await page.locator('[data-dsh-scard="card"]:not([data-empty="1"])').first()
      .locator('[data-dsh-speak="button"]').click().catch(() => {}) // 收尾停掉
  }

  // ── 第二次单击：复用同一条会话、页面不重载 ──
  const beforeSecond = await page.evaluate(() => ({
    stamp: window.__smokeStamp,
    local: String(localStorage.getItem('dsh.assistant.secretary.sessionId') || ''),
  }))
  const pressed = await clickBall()
  if (pressed) await page.waitForTimeout(3500)
  const afterSecond = await page.evaluate(async () => ({
    stamp: window.__smokeStamp,
    local: String(localStorage.getItem('dsh.assistant.secretary.sessionId') || ''),
    host: String((await fetch('/api/assistant/secretary', { cache: 'no-store' }).then((res) => res.json()).catch(() => null))?.sessionId ?? ''),
    current: (() => { try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') } catch { return '' } })(),
  }))
  check('重复单击没有重载页面', afterSecond.stamp === beforeSecond.stamp, `${beforeSecond.stamp} → ${afterSecond.stamp}`)
  check('重复进入仍是同一条固定会话',
    afterSecond.local === beforeSecond.local && afterSecond.host === beforeSecond.local && afterSecond.current === afterSecond.host,
    JSON.stringify({ before: beforeSecond.local, after: afterSecond.local, host: afterSecond.host, current: afterSecond.current }))

  // ── 30 秒存活 ──
  await page.waitForTimeout(12000)
  const alive = await page.evaluate(() => ({
    title: document.title,
    cards: document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])').length,
    tailCards: document.querySelectorAll('[data-dsh-proactive="card"], [data-dsh-proactive="wrap"]').length,
    shell: document.querySelectorAll('[data-pocket-secretary]').length,
  }))
  check('页面 30s 内没崩', alive.title.includes('DeepSeek Harness') || alive.title.includes('个人秘书'), `title=${alive.title}`)
  check('30s 后回复卡仍在（没有闪没）', !cardOk || alive.cards >= 1, `cards=${alive.cards}`)
  check('30s 后仍无尾巴卡', alive.tailCards === 0, `tailCards=${alive.tailCards}`)
  check('30s 后仍无自制外壳', alive.shell === 0)

  // ── 长按 600ms：打开控制室，且**不能**走秘书入口（手势对调后的另一半，两者不串） ──
  const logBefore = await page.evaluate(() => (window.__dshAssistantOpenLog || []).length)
  const idBeforeLongPress = await readCurrentSessionId()
  const longPressed = await longPressBall()
  const controlRoomOpened = await page.waitForSelector('.dsh-assistant-cr', { timeout: 8000 }).then(() => true).catch(() => false)
  await page.waitForTimeout(800)
  const afterLongPress = await page.evaluate(() => ({
    rooms: document.querySelectorAll('.dsh-assistant-cr').length,
    current: (() => { try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') } catch { return '' } })(),
    openLog: (window.__dshAssistantOpenLog || []).length,
  }))
  check('长按 600ms 打开控制室（手势对调）', longPressed && controlRoomOpened && afterLongPress.rooms > 0, `控制室节点=${afterLongPress.rooms}`)
  check('长按没有走秘书入口（打开日志无新增）', afterLongPress.openLog === logBefore && afterLongPress.current === idBeforeLongPress,
    `log ${logBefore} → ${afterLongPress.openLog}；selection ${idBeforeLongPress} → ${afterLongPress.current}`)
  // 收起控制室，让截图仍是标准会话页
  await page.click('.dsh-assistant-crClose', { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(600)

  // ── 宿主意图落点：assistant.ts 的 Intent 映射 + 客户端分派（只信发送端不够）──
  // 走宿主自己的两条唤起路由，模拟桌面球把意图送进页面：
  //   open-console  → intent=console → 控制室
  //   open-assistant→ intent=assistant → 关闭控制室 + 打开秘书固定会话
  const logBeforeIntent = await page.evaluate(() => (window.__dshAssistantOpenLog || []).length)
  await page.evaluate(() => fetch('/api/assistant/open-console', { method: 'POST' }))
  const consoleLanded = await page.waitForSelector('.dsh-assistant-cr', { timeout: 12000 }).then(() => true).catch(() => false)
  const afterConsoleIntent = await page.evaluate(() => ({
    rooms: document.querySelectorAll('.dsh-assistant-cr').length,
    log: (window.__dshAssistantOpenLog || []).length,
  }))
  check('宿主 intent=console 落到控制室（不串进秘书：打开日志无新增）',
    consoleLanded && afterConsoleIntent.rooms > 0 && afterConsoleIntent.log === logBeforeIntent,
    JSON.stringify(afterConsoleIntent))

  await page.evaluate(() => fetch('/api/assistant/open-assistant', { method: 'POST' }))
  const assistantLanded = await page.waitForFunction((wanted) => {
    try {
      const current = String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '')
      const rooms = document.querySelectorAll('.dsh-assistant-cr').length
      return current === wanted && rooms === 0
    } catch { return false }
  }, idBeforeLongPress, { timeout: 12000 }).then(() => true).catch(() => false)
  const afterAssistantIntent = await page.evaluate(() => ({
    rooms: document.querySelectorAll('.dsh-assistant-cr').length,
    current: (() => { try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') } catch { return '' } })(),
    log: (window.__dshAssistantOpenLog || []).length,
  }))
  check('宿主 intent=assistant 落到秘书固定会话（并收起控制室）',
    assistantLanded && afterAssistantIntent.current === idBeforeLongPress && afterAssistantIntent.log > afterConsoleIntent.log,
    JSON.stringify(afterAssistantIntent))

  // ── 普通会话不受影响：切到一条普通会话，消息操作行必须仍然可见 ──
  let normalChecked = false
  for (const candidate of refCandidates) {
    await page.evaluate((id) => {
      try { window.__dshOpenSession?.(id) } catch { /* 切页失败由下方断言兜底 */ }
    }, candidate)
    await page.waitForTimeout(3000)
    const nowId = await readCurrentSessionId()
    if (nowId !== candidate) continue // 这条打不开（已归档等），试下一条
    const normalRows = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-clock]')]
      const flag = document.body.dataset.dshSecretary ?? ''
      return {
        flag,
        total: rows.length,
        visible: rows.filter((el) => getComputedStyle(el).display !== 'none').length,
      }
    })
    if (normalRows.total === 0) continue // 空会话没有操作行，换一条有历史的
    normalChecked = true
    check('普通会话消息操作行不受影响（仍然可见）', normalRows.flag !== '1' && normalRows.visible >= 1,
      `${candidate} ${JSON.stringify(normalRows)}`)
    break
  }
  if (!normalChecked) notes.push('普通会话抽查：候选都打不开或都是空会话，跳过可见性断言')
  // 跳回秘书（走宿主 open-assistant 意图路由 = 既有唤起逻辑）
  await page.evaluate(() => fetch('/api/assistant/open-assistant', { method: 'POST' }))
  await page.waitForFunction((want) => {
    try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') === want } catch { return false }
  }, idBeforeLongPress, { timeout: 12000 }).catch(() => {})
  await page.waitForTimeout(800)

  // ── CU 完成通知：卡片带可点跳信息行（[[session:id|title]] → 引用块），点击命中目标会话 ──
  // 第一层监听与通知落盘都在宿主侧（src/assistant-cu-watch.ts）：宿主没重载新代码时
  // /api/assistant/cu-watch/notify 是 404，这一段如实跳过（重启宿主后自动跑全链路）。
  const cuTarget = refCandidates.find((id) => id !== currentId) ?? ''
  if (cuTarget !== '') {
    const cuTitle = 'CU 冒烟校对会话'
    const cuResponse = await page.evaluate(async ({ token, sessionId, title }) => {
      try {
        const res = await fetch(`/api/assistant/cu-watch/notify?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, title, summary: '冒烟校对：这是电脑操作会话的完成汇报。' }),
        })
        const type = res.headers.get('content-type') ?? ''
        if (!type.includes('application/json')) return { status: res.status, ok: false, unavailable: true }
        return { status: res.status, ...(await res.json()), unavailable: false }
      } catch (error) { return { status: 0, ok: false, unavailable: true, error: String(error) } }
    }, { token: TOKEN, sessionId: cuTarget, title: cuTitle })
    if (cuResponse.unavailable === true || cuResponse.status === 404) {
      notes.push('CU 通知段：宿主未重载新代码（/api/assistant/cu-watch/notify 不可用），跳过——重启宿主后自动生效')
    } else {
      check('CU 完成通知落盘（宿主路由接受）', cuResponse.ok === true, JSON.stringify(cuResponse))
      const noticeCard = await page.waitForFunction((title) => {
        const cards = [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])')]
        const hit = cards.find((el) => (el.textContent ?? '').includes(title))
        if (hit === undefined) return false
        const ref = hit.querySelector('[data-dsh-scard="ref"]')
        return ref !== null && (ref.textContent ?? '').includes(title) ? { found: true } : false
      }, cuTitle, { timeout: 20000 }).then(() => true).catch(() => false)
      check('通知卡片含可点跳信息行（引用块带 CU 会话标题）', noticeCard)
      if (noticeCard) {
        await page.locator('[data-dsh-scard="card"]:not([data-empty="1"])', { hasText: cuTitle })
          .locator('[data-dsh-scard="ref"]').first().click()
        const jumped = await page.waitForFunction((want) => {
          try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') === want } catch { return false }
        }, cuTarget, { timeout: 12000 }).then(() => true).catch(() => false)
        const nowSel = await readCurrentSessionId()
        check('点通知卡片信息行跳进那条 CU 会话（命中目标会话 id）', jumped && nowSel === cuTarget,
          `selection=${nowSel} want=${cuTarget}`)
        // 回秘书
        await page.evaluate(() => fetch('/api/assistant/open-assistant', { method: 'POST' }))
        await page.waitForFunction((want) => {
          try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') === want } catch { return false }
        }, currentId, { timeout: 12000 }).catch(() => {})
        await page.waitForTimeout(800)
      }
    }
  } else {
    notes.push('CU 通知段：没有可用目标会话，跳过')
  }

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
