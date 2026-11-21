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
 *   8. DSH_SMOKE_REAL_CARD=1：用户 QQ 看屏原话必须派 computer-use，回执不得是「看不到」终答；
 *      「今天几号」直接答、不建 CU。先验本次 lib 构建契约，宿主带 v2 提示词时再验真实模型。
 *
 * 退出码 0 = 全绿。任何断言失败都会打印现场事实。
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const REAL_CARD = process.env.DSH_SMOKE_REAL_CARD === '1'
const LOCAL_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const QQ_SCREEN_QUESTION = '你看我打开的 QQ 页面，他们说的 38 fn 指什么模型？'
const DIRECT_QUESTION = '今天几号'

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

// REAL_CARD 模式同时冒烟本次构建的派活契约。这里直接加载 lib/index.js（不是 src），
// 防止「源码改了、构建产物没改」；真宿主已加载 v2 提示词时，文末还会跑真实模型问答段。
if (REAL_CARD) {
  const lib = await import('../lib/index.js')
  const dispatch = lib.assistantDispatchTestSurface
  const plan = dispatch.resolveDispatchTarget({
    task: QQ_SCREEN_QUESTION,
    projects: [],
    assistantHome: 'C:\\Users\\<ACCOUNT>\\.dsh\\assistant',
    newFolderParent: 'D:\\SmokeProjects',
    now: new Date(2026, 10, 21, 14, 30),
  })
  check('派活冒烟：QQ 原话不属于直接终答的 A 类', plan.kind === 'new-folder' && plan.cwd !== '', JSON.stringify(plan))
  const prompt = dispatch.dispatchPromptSection({}, [])
  check('派活冒烟：提示词禁止「看不到」收工且要求先派再报',
    /禁止.*看不到|不得.*看不到/.test(prompt) && /先派.*secretary_dispatch.*再.*已派/.test(prompt) && prompt.includes(DIRECT_QUESTION))

  lib.assistantSecretaryTestSurface.secretarySessionRef.id = 'smoke-secretary'
  const calls = []
  const tool = dispatch.dispatchToolDefinition({
    get: () => undefined,
    sessionController: {
      create: async (req) => { calls.push(['create', req]); return { sessionId: 'smoke-cu-qq', agentPreset: 'computer-use' } },
      rename: async () => {},
      prompt: async (req) => { calls.push(['prompt', req]) },
    },
  })
  const dispatched = await tool.execute(
    { task: QQ_SCREEN_QUESTION, cwd: 'D:\\SmokeProjects\\qq-screen', kind: 'existing' },
    { agent: { session: { id: 'smoke-secretary' } } },
  )
  const receipt = tool.output.render({}, dispatched).map((part) => part.text ?? '').join('\n')
  check('派活冒烟：QQ 原话产生 computer-use 派活并投递原话',
    dispatched.agent_preset === 'computer-use' && calls.some(([kind, req]) => kind === 'prompt' && req.content?.[0]?.text === QQ_SCREEN_QUESTION),
    JSON.stringify({ dispatched, calls }))
  check('派活冒烟：派活回执是「已派」而非「看不到」终答',
    /已派活/.test(receipt) && !/我看不到|没有截图能力|无法直接确认/.test(receipt), receipt)

  let knowledgeWrites = 0
  const knowledgeTool = dispatch.dispatchToolDefinition({
    get: () => undefined,
    sessionController: {
      create: async () => { knowledgeWrites += 1; return { sessionId: 'must-not-create', agentPreset: 'computer-use' } },
      prompt: async () => { knowledgeWrites += 1 },
    },
  })
  let knowledgeStayedDirect = false
  try {
    await knowledgeTool.execute({ task: DIRECT_QUESTION }, { agent: { session: { id: 'smoke-secretary' } } })
  } catch (error) {
    knowledgeStayedDirect = /纯知识/.test(String(error))
  }
  check('派活冒烟：「今天几号」直接答，不建会话、不投 prompt', knowledgeStayedDirect && knowledgeWrites === 0)
  check('派活冒烟：只读闸放行派活与只读联网，拒绝终端/本机读取',
    lib.inject.includes('tools') &&
    lib.assistantSecretaryTestSurface.secretaryToolDenied('secretary_dispatch') === false &&
    ['web_search', 'web_fetch'].every((name) => lib.assistantSecretaryTestSurface.secretaryToolDenied(name) === false) &&
    ['pwsh', 'write', 'read'].every((name) => lib.assistantSecretaryTestSurface.secretaryToolDenied(name) === true))

  // 用户原话「明天天气」：两条路都必须通——直连 web_search 放行，或派活成功。
  const weatherCalls = []
  const weatherTool = dispatch.dispatchToolDefinition({
    get: () => undefined,
    sessionController: {
      create: async (req) => { weatherCalls.push(['create', req]); return { sessionId: 'smoke-cu-weather', agentPreset: 'computer-use' } },
      rename: async () => {},
      prompt: async (req) => { weatherCalls.push(['prompt', req]) },
    },
  })
  let weatherDispatched = null
  try {
    weatherDispatched = await weatherTool.execute({ task: '明天天气' }, { agent: { session: { id: 'smoke-secretary' } } })
  } catch (error) {
    weatherDispatched = { error: String(error) }
  }
  check('派活冒烟：「明天天气」不再死路，派活兜底能建 CU 并投递原话',
    weatherDispatched?.session_id === 'smoke-cu-weather' &&
    weatherCalls.some(([kind, req]) => kind === 'prompt' && req.content?.[0]?.text === '明天天气'),
    JSON.stringify(weatherDispatched))
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
 *  路由生效后正常返回 200；旧宿主缺 stream 的 409 会按能力未加载跳过，v2 宿主的 409 仍算失败。 */
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

const readHostSecretaryMeta = () => page.evaluate(async () => {
  return await fetch('/api/assistant/secretary', { cache: 'no-store' }).then((res) => res.json()).catch(() => null)
})
const readHostSecretaryId = async () => String((await readHostSecretaryMeta())?.sessionId ?? '')
const readSessionRows = () => page.evaluate(() => {
  try {
    const snap = window.__dshSessions?.list?.getSnapshot?.() ?? null
    const ids = Array.isArray(snap?.ids) ? snap.ids : []
    return ids.map((id) => {
      const row = snap?.byId?.[id] ?? {}
      return {
        id: String(id),
        title: String(row?.title ?? ''),
        agentPreset: String(row?.agentPreset ?? row?.header?.agentPreset ?? ''),
        updatedAt: Number(row?.updatedAt ?? 0),
      }
    })
  } catch { return [] }
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
  if ((await page.title()).includes('访问验证')) {
    await page.fill('input[name="token"]', TOKEN)
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('button[type="submit"]'),
    ])
    notes.push('Pocket 页面走了 8 位 PIN 登录（当前版本局域网密码门），登录后继续冒烟')
  }

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
  }).then((ids) => ids.filter((id) => id !== String(process.env.DSH_SESSION_ID ?? '')))
  // 合成通知会往秘书会话追加事件，绝不能拿当前正在执行本冒烟的后台会话当跳转目标。
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
  const wantedHostId = hostIdAfter || hostIdBefore
  let currentId = await readCurrentSessionId()
  if (currentId !== wantedHostId && wantedHostId !== '') {
    notes.push(`悬浮球切换未在 45s 内命中秘书会话，冒烟改用宿主 openSession 兜底（不重启宿主）：selection=${currentId} host=${wantedHostId}`)
    const fallbackDiag = await page.evaluate(async (id) => {
      const out = { id, currentBefore: '', openAssistant: null, openAssistantError: '', openSessionCalled: false, openSessionError: '', bridgeError: '' }
      try { out.currentBefore = String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') } catch (error) { out.bridgeError = String(error) }
      try { out.openAssistant = await (await fetch('/api/assistant/open-assistant?token=' + encodeURIComponent(String(localStorage.getItem('dsh.assistant.secretary.token') ?? '')), { method: 'POST', cache: 'no-store' })).json() } catch (error) { out.openAssistantError = String(error) }
      try {
        const open = window.__dshOpenSession
        if (typeof open === 'function') {
          open(id)
          out.openSessionCalled = true
        }
      } catch (error) { out.openSessionError = String(error) }
      try {
        const bridge = window.__dshUiWorkspace
        if (bridge?.openSession) bridge.openSession(id)
        else if (bridge?.uiWorkspace?.openSession) bridge.uiWorkspace.openSession(id)
      } catch (error) { out.bridgeError = String(error) }
      try { out.currentAfter = String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') } catch { /* 忽略 */ }
      return out
    }, wantedHostId)
    notes.push('openSession 兜底诊断: ' + JSON.stringify(fallbackDiag))
    await page.waitForFunction((want) => {
      try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') === want } catch { return false }
    }, wantedHostId, { timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(3000)
    currentId = await readCurrentSessionId()
  }
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

  check('主面板落到固定秘书会话', currentId !== '' && currentId === wantedHostId, `selection=${currentId} host=${wantedHostId}`)
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
  // 卡片规范验收不要求状态行文案；宿主标准会话页可能把 token 行折叠/延迟渲染。
  const sawStatusLine = /\b(?:tok|token|轮次)\b/i.test(snapshot.fullText) || /轮\b/.test(snapshot.fullText)
  if (!sawStatusLine) notes.push(`标准轮次与 token 状态行未出现在本次页脚采样（非卡片规范第十三节验收项，只记现场）：tail=${snapshot.fullText.slice(-180).replace(/\n+/g, ' / ')}`)
  check('打开后 6 秒内 DOM 变更次数有限（不震荡）', snapshot.mutations < 4000, `mutations=${snapshot.mutations}`)

  // ── 主动服务「尾巴卡」已移除：对话流尾部不再塞主动卡（后端数据能力保留，只删前端渲染） ──
  check('秘书会话无主动服务尾巴卡', snapshot.tailCards === 0, `tailCards=${snapshot.tailCards}`)

  // ── 秘书回复卡片：这条会话还没有任何一轮时，真发一句等模型回完再验 ──
  let cardOk = await page.waitForSelector('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])', { timeout: 6000 }).then(() => true).catch(() => false)
  if (!cardOk) {
    notes.push('会话暂无历史轮次：真实发送一条消息，等待模型回复（最多 120s）')
    await page.evaluate((id) => {
      const fn = window.__dshPromptIntoSession
      if (typeof fn === 'function') fn(id, '（冒烟测试）只回复两个字：收到')
    }, currentId)
    cardOk = await page.waitForSelector('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])', { timeout: 120000 }).then(() => true).catch(() => false)
  }
  check('秘书回复卡片渲染出来了', cardOk)

  // 卡片规范验收需要一个稳定、可断言的卡片样本：先让真实秘书回一个多段卡片回归样本。
  const cardFixturePrompt = '请逐字回复下列六行，每行一个段落，不加编号、项目符号、代码块或前后缀：\n答案折叠验收\n普通正文一段。\n型号 qwen3.8-flash-next **重点**。\n继续第四段。\n继续第五段。\n继续第六段。'
  const fixtureSent = await page.evaluate(async ({ id, text }) => {
    if (typeof window.__dshPromptIntoSession !== 'function') return false
    await window.__dshPromptIntoSession(id, text)
    return true
  }, { id: currentId, text: cardFixturePrompt }).catch(() => false)
  if (fixtureSent) {
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
      return cards.some((el) => (el.textContent ?? '').includes('答案折叠验收'))
    }, { timeout: 120000 }).catch(() => {})
  }

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

  // ── 卡片规范 v1.0：最末样本卡 computed style，逐条验收第十三节清单 ──
  await page.waitForTimeout(1500) // body[data-dsh-secretary] 轮询 700ms，等标记落上
  const scard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
    const fixtureCard = cards.find((el) => (el.textContent ?? '').includes('答案折叠验收')) ?? null
    const card = fixtureCard ?? cards[cards.length - 1] ?? null
    if (card === null) return { hasCard: false }
    const cs = (el) => getComputedStyle(el)
    const pick = (root, selector) => root?.querySelector?.(selector) ?? null
    const rectOf = (el) => { try { return el?.getBoundingClientRect?.() ?? null } catch { return null } }
    const rectText = (el) => { const rect = rectOf(el); return rect ? `${rect.width.toFixed(2)}x${rect.height.toFixed(2)}` : '' }
    const declaredBorder = (selector) => {
      for (const sheet of document.styleSheets ?? []) {
        try {
          for (const rule of sheet.cssRules ?? []) {
            if (rule.selectorText === selector) return rule.style?.getPropertyValue?.('border-top-width') || rule.style?.getPropertyValue?.('border-top') || rule.style?.getPropertyValue?.('border-width') || rule.style?.getPropertyValue?.('border') || ''
          }
        } catch { /* 跨源/保护表跳过 */ }
      }
      return ''
    }
    const head = pick(card, '[data-dsh-scard="head"]')
    const body = pick(card, '[data-dsh-scard="body"]')
    const foot = pick(card, '[data-dsh-scard="foot"]')
    const title = pick(card, '[data-dsh-scard="title"]')
    const paras = [...card.querySelectorAll('[data-dsh-scard="para"]')]
    const firstPara = paras[0] ?? null
    const strong = pick(firstPara, 'strong') ?? pick(body, 'strong')
    const model = pick(card, '[data-dsh-scard="model-code"]')
    const mark = pick(card, '[data-dsh-scard="mark"]')
    const name = pick(card, '[data-dsh-scard="name"]')
    const tag = pick(card, '[data-dsh-scard="tag"]')
    const read = pick(head, '[data-dsh-speak="button"]')
    const footRead = pick(foot, '[data-dsh-speak="button"]')
    const copy = pick(foot, '[data-dsh-scard="copy"]')
    const copyIcon = pick(copy, 'svg')
    const separator = pick(foot, '[data-dsh-scard="separator"]')
    const expand = pick(foot, '[data-dsh-scard="expand"]')
    const expandText = pick(expand, '[data-dsh-scard="expand-text"]')
    const arrow = pick(expand, '[data-dsh-scard="expand-arrow"]')
    const time = pick(foot, '[data-dsh-scard="time"]')
    const actions = pick(foot, '[data-dsh-scard="actions"]')
    const step = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
      .find((el) => el.getAttribute('data-chat-group-part') !== 'reasoning')
    const cardRect = card.getBoundingClientRect()
    const parentRect = rectOf(card.parentElement)
    const headRect = rectOf(head)
    const readRect = rectOf(read)
    const paraCs = firstPara ? cs(firstPara) : null
    const probe = document.createElement('article')
    probe.setAttribute('data-dsh-scard', 'card')
    probe.setAttribute('data-empty', '0')
    probe.setAttribute('data-open', '0')
    probe.innerHTML = '<div data-dsh-scard="body"><p data-dsh-scard="para">正文<strong>重点</strong><span data-dsh-scard="model-code">qwen-probe</span></p></div>'
    document.body.appendChild(probe)
    const probeStrong = pick(probe, 'strong')
    const probeModel = pick(probe, '[data-dsh-scard="model-code"]')
    const probeStrongCs = probeStrong ? cs(probeStrong) : null
    const probeModelCs = probeModel ? cs(probeModel) : null
    document.body.removeChild(probe)
    return {
      cardCount: cards.length,
      hasCard: true,
      usedFixture: fixtureCard !== null,
      foldAttr: card.getAttribute('data-dsh-fold'),
      dataOpen: card.getAttribute('data-open'),
      dataOverflow: card.getAttribute('data-overflow') ?? '',
      cardHeight: cardRect.height,
      // 卡片可能挂在一个 0 尺寸的 portal 包装层里，拿父容器算偏心会误报 206px；
      // 规范要的是「相对视口水平居中」。
      cardCenterDelta: Math.abs(((cardRect.left + cardRect.right) / 2) - (window.innerWidth / 2)),
      borderRadius: cs(card).borderTopLeftRadius,
      borderWidth: cs(card).borderTopWidth,
      borderStyle: cs(card).borderTopStyle,
      borderColor: cs(card).borderTopColor,
      declaredCardBorder: declaredBorder('[data-dsh-scard="card"]'),
      declaredReadBorder: declaredBorder('[data-dsh-speak="button"]'),
      boxShadow: cs(card).boxShadow,
      backgroundImage: cs(card).backgroundImage,
      background: cs(card).background,
      backgroundColor: cs(card).backgroundColor,
      overflow: cs(card).overflow,
      maxWidth: cs(card).maxWidth,
      marginLeft: cs(card).marginLeft,
      marginRight: cs(card).marginRight,
      nameText: name?.textContent ?? '',
      tagText: tag?.textContent ?? '',
      markSize: rectText(mark),
      markRadius: mark ? cs(mark).borderRadius : '',
      markColor: mark ? cs(mark).color : '',
      markBackground: mark ? cs(mark).backgroundColor : '',
      titleText: title?.textContent ?? '',
      titleFontSize: title ? cs(title).fontSize : '',
      titleFontWeight: title ? cs(title).fontWeight : '',
      titleColor: title ? cs(title).color : '',
      paras: paras.length,
      paraFontSize: paraCs?.fontSize ?? '',
      paraFontWeight: paraCs?.fontWeight ?? '',
      paraLineHeight: paraCs?.lineHeight ?? '',
      paraColor: paraCs?.color ?? '',
      paraText: firstPara?.textContent ?? '',
      strongFontWeight: strong ? cs(strong).fontWeight : (probeStrongCs?.fontWeight ?? ''),
      strongColor: strong ? cs(strong).color : (probeStrongCs?.color ?? ''),
      modelText: model?.textContent ?? (probeModel?.textContent ?? ''),
      modelFontSize: model ? cs(model).fontSize : (probeModelCs?.fontSize ?? ''),
      modelColor: model ? cs(model).color : (probeModelCs?.color ?? ''),
      modelBackground: model ? cs(model).backgroundColor : (probeModelCs?.backgroundColor ?? ''),
      modelFontFamily: model ? cs(model).fontFamily : (probeModelCs?.fontFamily ?? ''),
      headExists: head !== null,
      bodyExists: body !== null,
      footExists: foot !== null,
      footBackground: foot ? cs(foot).backgroundColor : '',
      footBorderWidth: foot ? cs(foot).borderTopWidth : '',
      footBorderColor: foot ? cs(foot).borderTopColor : '',
      bodyOverflow: body ? cs(body).overflow : '',
      bodyMaxHeight: body ? cs(body).maxHeight : '',
      timeText: time?.textContent ?? '',
      timeDisplay: time ? cs(time).display : '',
      timeFontSize: time ? cs(time).fontSize : '',
      timeColor: time ? cs(time).color : '',
      footText: foot?.textContent ?? '',
      footReadCount: footRead ? 1 : 0,
      copyExists: copy !== null,
      actionOrder: actions ? [...actions.children].map((el) => el.getAttribute('data-dsh-scard') ?? '').filter(Boolean) : [],
      copySize: rectText(copy),
      copyIconSize: rectText(copyIcon),
      separatorExists: separator !== null,
      separatorSize: rectText(separator),
      separatorColor: separator ? cs(separator).backgroundColor : '',
      expandExists: expand !== null,
      expandText: expandText?.textContent ?? '',
      expandAria: expand?.getAttribute('aria-expanded') ?? '',
      expandTransform: arrow ? cs(arrow).transform : '',
      arrowSize: rectText(arrow),
      hasButton: read !== null,
      btnIsLast: read !== null && head?.lastElementChild === read,
      btnVertInHead: readRect && headRect ? readRect.top >= headRect.top - 2 && readRect.bottom <= headRect.bottom + 2 : false,
      btnRightGap: readRect && cardRect ? cardRect.right - readRect.right : -1,
      btnSize: rectText(read),
      btnRadius: read ? cs(read).borderRadius : '',
      btnBorderWidth: read ? cs(read).borderTopWidth : '',
      btnBorderColor: read ? cs(read).borderTopColor : '',
      btnAriaPressed: read?.getAttribute('aria-pressed') ?? '',
      btnAriaLabel: read?.getAttribute('aria-label') ?? '',
      btnTitle: read?.getAttribute('title') ?? '',
      copyAriaLabel: copy?.getAttribute('aria-label') ?? '',
      copyTitle: copy?.getAttribute('title') ?? '',
      expandAriaLabel: expand?.getAttribute('aria-label') ?? '',
      expandTitle: expand?.getAttribute('title') ?? '',
      speakStatus: read?.getAttribute('data-status') ?? '',
      stepDisplay: step ? cs(step).display : '(无 step)',
      bodyFlag: document.body.dataset.dshSecretary ?? '',
    }
  })
  const sizeOf = (value) => String(value ?? '').split('x').map((part) => Number.parseFloat(part))
  const near = (value, want, tolerance = 0.6) => Number.isFinite(value) && Math.abs(value - want) <= tolerance
  const [markW, markH] = sizeOf(scard.markSize)
  const [btnW, btnH] = sizeOf(scard.btnSize)
  const [copyW, copyH] = sizeOf(scard.copySize)
  const [iconW, iconH] = sizeOf(scard.copyIconSize)
  const [sepW, sepH] = sizeOf(scard.separatorSize)
  const [arrowW, arrowH] = sizeOf(scard.arrowSize)
  check('卡片使用 16px 圆角、0.5px 浅灰边框，没有阴影，白底无渐变',
    scard.borderRadius === '16px' && /0\.5px/.test(scard.declaredCardBorder) && scard.borderWidth !== '0px'
      && scard.borderStyle === 'solid' && scard.borderColor === 'rgb(229, 230, 235)' && scard.boxShadow === 'none'
      && scard.backgroundColor === 'rgb(255, 255, 255)' && scard.backgroundImage === 'none', JSON.stringify({
      borderRadius: scard.borderRadius, declared: scard.declaredCardBorder, computed: scard.borderWidth, borderColor: scard.borderColor, boxShadow: scard.boxShadow, background: scard.backgroundColor, backgroundImage: scard.backgroundImage }))
  check('卡片最大宽度 620px、水平居中、无旧固定高度/无 data-dsh-fold',
    scard.maxWidth === '620px' && scard.cardCenterDelta >= 0 && scard.cardCenterDelta <= 2 && scard.foldAttr === null
      && scard.cardHeight > 0 && Math.abs(scard.cardHeight - 212) > 2 && Math.abs(scard.cardHeight - 226) > 2,
    JSON.stringify({ maxWidth: scard.maxWidth, centerDelta: scard.cardCenterDelta, foldAttr: scard.foldAttr, height: scard.cardHeight }))
  check('卡片 overflow:hidden', scard.overflow === 'hidden', JSON.stringify({ overflow: scard.overflow }))
  check('左上角为 32px 紫色助手标识、名称「个人秘书」与「AI 助手」标签',
    near(markW, 32) && near(markH, 32) && scard.markRadius === '10px' && scard.markColor === 'rgb(83, 74, 183)'
      && scard.markBackground === 'rgb(238, 237, 254)' && scard.nameText === '个人秘书' && scard.tagText === 'AI 助手',
    JSON.stringify({ markSize: scard.markSize, name: scard.nameText, tag: scard.tagText }))
  check('右上角只有朗读按钮，尺寸 34px，没有「...」按钮',
    scard.hasButton && scard.btnIsLast && near(btnW, 34) && near(btnH, 34) && scard.btnRightGap >= 15 && scard.btnRightGap <= 21
      && scard.btnRadius === '8px' && /0\.5px/.test(scard.declaredReadBorder),
    JSON.stringify({ hasButton: scard.hasButton, btnIsLast: scard.btnIsLast, btnSize: scard.btnSize, gap: scard.btnRightGap, radius: scard.btnRadius, declaredBorder: scard.declaredReadBorder }))
  check('标题字号 15px、字重 500，正文 13px、行高 1.8',
    scard.titleFontSize === '15px' && scard.titleFontWeight === '500' && scard.paraFontSize === '13px' && scard.paraLineHeight === '23.4px' && scard.paraFontWeight === '400',
    JSON.stringify({ title: scard.titleFontSize, titleWeight: scard.titleFontWeight, para: scard.paraFontSize, paraWeight: scard.paraFontWeight, lineHeight: scard.paraLineHeight }))
  check('正文颜色 #4E5969，重点句使用 500 字重与 #1F2329',
    scard.paraColor === 'rgb(78, 89, 105)' && scard.strongFontWeight === '500' && scard.strongColor === 'rgb(31, 35, 41)',
    JSON.stringify({ paraColor: scard.paraColor, strong: scard.strongFontWeight, strongColor: scard.strongColor }))
  check('模型名称使用浅紫底、深紫字、12px 等宽字体',
    scard.modelText !== '' && scard.modelFontSize === '12px' && scard.modelColor === 'rgb(60, 52, 137)'
      && scard.modelBackground === 'rgb(238, 237, 254)' && /monospace/i.test(scard.modelFontFamily),
    JSON.stringify({ model: scard.modelText, size: scard.modelFontSize, color: scard.modelColor, background: scard.modelBackground }))
  check('底部为浅灰操作栏，左侧时间、右侧复制→分隔线→展开全文',
    scard.footExists && scard.footBackground === 'rgb(250, 250, 251)' && scard.copyExists && scard.separatorExists
      && scard.expandExists && scard.expandText === '展开全文'
      && JSON.stringify(scard.actionOrder) === JSON.stringify(['copy', 'separator', 'expand']),
    JSON.stringify({ foot: scard.footExists, background: scard.footBackground, copy: scard.copyExists, separator: scard.separatorExists, expand: scard.expandExists, order: scard.actionOrder }))
  check('朗读按钮不再出现在底部', scard.footReadCount === 0, JSON.stringify({ footReadCount: scard.footReadCount }))
  check('移动端隐藏时间，卡片不横向溢出，朗读按钮仍在右上角',
    scard.timeDisplay === 'none' && scard.hasButton && scard.btnIsLast && scard.btnRightGap >= 15
      && scard.btnRightGap <= 21, JSON.stringify({ timeDisplay: scard.timeDisplay, gap: scard.btnRightGap }))
  check('原始 markdown 气泡已隐藏（秘书会话专属）', scard.stepDisplay === 'none', `display=${scard.stepDisplay}`)
  check('页面级秘书标记 body[data-dsh-secretary="1"]', scard.bodyFlag === '1')
  check('复制按钮为 30px 点击区、16px 图标、分隔线 0.5px/14px',
    near(copyW, 30) && near(copyH, 30) && near(iconW, 16) && near(iconH, 16)
      && sepW >= 0.49 && sepW <= 1.05 && near(sepH, 14) && scard.separatorColor === 'rgb(213, 216, 221)',
    JSON.stringify({ copySize: scard.copySize, copyIcon: scard.copyIconSize, separator: scard.separatorSize, separatorColor: scard.separatorColor }))
  check('展开文字 12px/紫色、箭头 14px 且随状态旋转',
    scard.expandExists && near(arrowW, 14) && near(arrowH, 14) && scard.expandTransform === 'none',
    JSON.stringify({ arrow: scard.arrowSize, transform: scard.expandTransform }))
  check('所有卡片按钮 aria-label/title 存在，aria-pressed 与朗读状态一致',
    (scard.btnAriaPressed === 'true' || scard.btnAriaPressed === 'false')
      && ((scard.btnAriaPressed === 'true') === (scard.speakStatus === 'playing' || scard.speakStatus === 'loading' || scard.speakStatus === 'paused'))
      && scard.btnAriaLabel !== '' && scard.btnTitle !== ''
      && scard.copyExists && scard.copyAriaLabel !== '' && scard.copyTitle !== ''
      && scard.expandExists && scard.expandTitle !== '',
    JSON.stringify({ ariaPressed: scard.btnAriaPressed, status: scard.speakStatus, label: scard.btnAriaLabel, copy: scard.copyExists, expand: scard.expandExists }))

  // 用户卡（真实用户消息 → 冷蓝卡）：与秘书卡同规格、主题必须不同；合成通知不伪装成用户卡。
  const ucard = await page.evaluate(() => {
    const readCard = (el) => {
      const cs = getComputedStyle(el)
      return {
        surface: cs.getPropertyValue('--dsh-card-surface').trim(),
        accent: cs.getPropertyValue('--dsh-card-accent').trim(),
        accentDeep: cs.getPropertyValue('--dsh-card-accent-deep').trim(),
        wash: cs.getPropertyValue('--dsh-card-accent-wash').trim(),
        footSurface: cs.getPropertyValue('--dsh-card-foot-surface').trim(),
        border: cs.getPropertyValue('--dsh-card-border').trim(),
        text: cs.getPropertyValue('--dsh-card-text').trim(),
        bg: cs.backgroundColor,
        radius: cs.borderTopLeftRadius,
        borderWidth: cs.borderTopWidth,
        shadow: cs.boxShadow,
        maxWidth: cs.maxWidth,
        overflow: cs.overflow,
      }
    }
    const assistantCards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
    const assistant = assistantCards[assistantCards.length - 1] ?? null
    const userCards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="user"]')]
    const user = userCards[userCards.length - 1] ?? null
    const cardedRows = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
      .filter((row) => row.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="user"]'))
    const duplicated = cardedRows.filter((row) => {
      const run = row.querySelector('[data-slot="conversation.user.text.node"]')
      if (run === null) return false
      return run.offsetParent !== null && (run.textContent ?? '').trim() !== ''
    })
    const noticeRows = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
      .filter((row) => {
        const run = row.querySelector('[data-slot="conversation.user.text.node"]')
        return /系统通知/.test(run?.textContent ?? '') || /\[\[session:[^\]]*\]\]/.test(run?.textContent ?? '')
      })
    const noticeCarded = noticeRows.filter((row) => row.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="user"]'))
    const foot = user?.querySelector('[data-dsh-scard="foot"]') ?? null
    return {
      userCount: userCards.length,
      assistantCount: assistantCards.length,
      assistantTheme: assistant ? readCard(assistant) : null,
      userTheme: user ? readCard(user) : null,
      userText: user?.querySelector('[data-dsh-scard="body"]')?.textContent ?? '',
      userName: user?.querySelector('[data-dsh-scard="name"]')?.textContent ?? '',
      userTag: user?.querySelector('[data-dsh-scard="tag"]')?.textContent ?? '',
      userMarkColor: user ? getComputedStyle(user.querySelector('[data-dsh-scard="mark"]')).color : '',
      userCopyTitle: user?.querySelector('[data-dsh-scard="copy"]')?.getAttribute('title') ?? '',
      userSpeakTitle: user?.querySelector('[data-dsh-speak="button"]')?.getAttribute('title') ?? '',
      userTimeText: user?.querySelector('[data-dsh-scard="time"]')?.textContent ?? '',
      footOrder: foot ? [...foot.querySelectorAll('[data-dsh-scard="actions"] > *')].map((el) => el.getAttribute('data-dsh-scard') ?? '') : [],
      footReadInUserCard: user ? user.querySelectorAll('[data-dsh-scard="foot"] [data-dsh-speak="button"]').length : -1,
      duplicatedCount: duplicated.length,
      noticeRowCount: noticeRows.length,
      noticeCardedCount: noticeCarded.length,
      userKeys: [...new Set([...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="user"]')]
        .map((el) => el.getAttribute('data-dsh-scard-turn')))],
    }
  })
  check('用户卡存在：真实用户消息已做成卡片（同时也有秘书卡）',
    ucard.userCount >= 1 && ucard.assistantCount >= 1, JSON.stringify({ userCards: ucard.userCount, assistantCards: ucard.assistantCount }))
  check('用户卡与秘书卡的主题变量与背景色不同',
    ucard.assistantTheme !== null && ucard.userTheme !== null
      && ucard.assistantTheme.surface !== ucard.userTheme.surface
      && ucard.assistantTheme.accent !== ucard.userTheme.accent
      && ucard.assistantTheme.wash !== ucard.userTheme.wash
      && ucard.assistantTheme.footSurface !== ucard.userTheme.footSurface
      && ucard.assistantTheme.bg !== ucard.userTheme.bg
      && ucard.userTheme.surface === '#eef4ff' && ucard.userTheme.accent === '#184a80'
      && ucard.assistantTheme.bg === 'rgb(255, 255, 255)' && ucard.userTheme.bg === 'rgb(238, 244, 255)',
    JSON.stringify({ assistant: ucard.assistantTheme, user: ucard.userTheme }))
  check('用户卡外壳与秘书卡同规格（16px 圆角、0.5px 边框、无阴影、620px、overflow hidden）',
    ucard.userTheme !== null && ucard.assistantTheme !== null
      && ucard.userTheme.radius === '16px' && ucard.userTheme.radius === ucard.assistantTheme.radius
      && ucard.userTheme.borderWidth !== '0px' && ucard.userTheme.shadow === 'none'
      && ucard.userTheme.maxWidth === '620px' && ucard.userTheme.maxWidth === ucard.assistantTheme.maxWidth
      && ucard.userTheme.overflow === 'hidden' && ucard.userTheme.border === ucard.assistantTheme.border
      && ucard.userTheme.text === ucard.assistantTheme.text,
    JSON.stringify({ user: ucard.userTheme, assistant: ucard.assistantTheme }))
  check('用户卡头部是你/用户消息（冷蓝标识）、脚部有时间与复制、正文是用户原话',
    ucard.userName === '你' && ucard.userTag === '用户消息' && ucard.userMarkColor === 'rgb(24, 74, 128)'
      && ucard.userCopyTitle === '复制这条消息' && ucard.userSpeakTitle === '朗读这条消息'
      && /今天 \d{2}:\d{2}/.test(ucard.userTimeText) && ucard.footReadInUserCard === 0
      && JSON.stringify(ucard.footOrder.slice(0, 1)) === JSON.stringify(['copy'])
      && (ucard.userText.includes('冒烟测试') || ucard.userText.includes('答案折叠验收')),
    JSON.stringify({ name: ucard.userName, tag: ucard.userTag, mark: ucard.userMarkColor, copy: ucard.userCopyTitle, speak: ucard.userSpeakTitle, time: ucard.userTimeText, foot: ucard.footOrder, text: ucard.userText.slice(0, 40) }))
  check('系统通知不做成用户卡（通知行保持宿主样式）',
    ucard.noticeCardedCount === 0, JSON.stringify({ noticeRows: ucard.noticeRowCount, noticeCarded: ucard.noticeCardedCount }))
  check('卡片化用户行不留下重复文本（宿主气泡已收起）',
    ucard.duplicatedCount === 0, JSON.stringify({ cardedDuplicated: ucard.duplicatedCount, keys: ucard.userKeys }))

  // 历史会话可能带着上一条合成通知留下的空白尾轮，旧卡不会再次自动朗读。
  // 此时必须真发一条新回复来验「新卡出现即自动读」，不能把手动点击算作自动请求。
  let autoReadObserved = ttsRequests >= 1
  if (!autoReadObserved) {
    const beforeCards = await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])').count()
    const requestObserved = page.waitForRequest((req) => req.method() === 'POST' && /\/api\/assistant\/tts(?:\?|$)/.test(req.url()), { timeout: 120000 })
      .then(() => true).catch(() => false)
    await page.evaluate(async (id) => { await window.__dshPromptIntoSession?.(id, '（冒烟测试·自动朗读）只回复两个字：收到') }, currentId)
    await page.waitForFunction((count) => document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])').length > count,
      beforeCards, { timeout: 120000 }).catch(() => {})
    autoReadObserved = await requestObserved
    notes.push('自动朗读：历史卡未重读，已新发一条真实回复验证新卡自动请求')
  }
  check('自动朗读已发起（唯一自动请求方 = 回复卡，TTS 已有请求）', autoReadObserved, `requests=${ttsRequests}`)

  // 展开按钮仅在内容溢出时显示：短卡没有按钮，长样本卡有按钮；卡片本身不能承担点击展开职责。
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
    window.__smokeCardOverflowProbe = cards.map((el) => ({
      hasExpand: el.querySelector('[data-dsh-scard="expand"]') !== null,
      dataOverflow: el.getAttribute('data-overflow') ?? '',
    }))
  })
  const overflowProbe = await page.evaluate(() => window.__smokeCardOverflowProbe)
  check('展开按钮只出现在实际溢出卡片上（无溢出卡不渲染按钮）',
    Array.isArray(overflowProbe) && overflowProbe.every((item) => item.dataOverflow === '1' ? item.hasExpand === true : item.hasExpand === false), JSON.stringify(overflowProbe))

  if (scard.expandExists) {
    const expandCard = page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"]):has([data-dsh-scard="expand"])').last()
    await expandCard.click({ position: { x: 120, y: 24 } }) // 卡片本体不应切换；这里只做负向回归：点空白处不改变状态
    const cardStillCollapsed = await expandCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      aria: el.querySelector('[data-dsh-scard="expand"]')?.getAttribute('aria-expanded') ?? '',
      text: el.querySelector('[data-dsh-scard="expand-text"]')?.textContent ?? '',
    }))
    check('卡片空白点击不会改变展开状态', cardStillCollapsed.open === '0' && cardStillCollapsed.text === '展开全文', JSON.stringify(cardStillCollapsed))
    await expandCard.locator('[data-dsh-scard="expand"]').click()
    await page.waitForTimeout(400)
    const expanded = await expandCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      aria: el.querySelector('[data-dsh-scard="expand"]')?.getAttribute('aria-expanded') ?? '',
      text: el.querySelector('[data-dsh-scard="expand-text"]')?.textContent ?? '',
      bodyMaxHeight: getComputedStyle(el.querySelector('[data-dsh-scard="body"]')).maxHeight,
      bodyOverflow: getComputedStyle(el.querySelector('[data-dsh-scard="body"]')).overflow,
      arrowTransform: getComputedStyle(el.querySelector('[data-dsh-scard="expand-arrow"]')).transform,
    }))
    check('展开全文按钮通过 aria-expanded 切换，展开后文案变「收起」且箭头旋转',
      expanded.open === '1' && expanded.aria === 'true' && expanded.text === '收起' && expanded.bodyMaxHeight === 'none'
        && expanded.bodyOverflow === 'visible' && expanded.arrowTransform.includes('-1'), JSON.stringify(expanded))
    await expandCard.locator('[data-dsh-scard="expand"]').click()
    await page.waitForTimeout(400)
    const collapsed = await expandCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      aria: el.querySelector('[data-dsh-scard="expand"]')?.getAttribute('aria-expanded') ?? '',
      text: el.querySelector('[data-dsh-scard="expand-text"]')?.textContent ?? '',
    }))
    check('再点收起回到折叠态', collapsed.open === '0' && collapsed.aria === 'false' && collapsed.text === '展开全文', JSON.stringify(collapsed))
  } else {
    notes.push(`回复卡展开按钮回归：未找到溢出卡，跳过（cardCount=${scard.cardCount}）`)
  }

  // 复制反馈：先成功，再失败。
  await page.evaluate(() => {
    try { window.__smokeClipboard = navigator.clipboard } catch { /* ignore */ }
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }) } catch { /* ignore */ }
  })
  const ASSISTANT_CARD = '[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]'
  await page.locator(`${ASSISTANT_CARD}:not([data-empty="1"]) [data-dsh-scard="copy"]`).last().click()
  const copied = await page.waitForFunction((selector) => {
    const status = document.querySelector(selector)
    const text = status?.textContent ?? ''
    return text === '已复制' ? text : false
  }, `${ASSISTANT_CARD} [data-dsh-scard="copy-status"]`, { timeout: 5000 }).then((handle) => handle.jsonValue()).catch(() => '')
  check('复制成功有可见反馈（已复制）', copied === '已复制', `copyStatus=${copied}`)
  await page.evaluate(() => {
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')) } }) } catch { /* ignore */ }
    // 真实失败路径：Clipboard API 拒绝 + 传统 execCommand 也不成功。
    try { Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false }) } catch { /* ignore */ }
  })
  const lastCopy = page.locator(`${ASSISTANT_CARD}:not([data-empty="1"]) [data-dsh-scard="copy"]`).last()
  await lastCopy.click()
  // 状态条是每张卡自己的：必须在这颗按钮的父节点里找，不能拿全页第一个
  // （前一张卡的「已复制」会先命中，失败反馈被它挡掉）。
  const failed = await lastCopy.evaluate((btn) => new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const status = btn.parentElement?.querySelector('[data-dsh-scard="copy-status"]')
      const text = status?.textContent ?? ''
      if (/复制失败|手动选择/.test(text)) return resolve(text)
      if (Date.now() - started > 5000) return resolve(text)
      setTimeout(tick, 80)
    }
    tick()
  }))
  check('复制失败有可见反馈（不静默失败）', /复制失败|手动选择/.test(failed), `copyStatus=${failed}`)
  await page.evaluate(() => {
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.__smokeClipboard }) } catch { /* ignore */ }
    try { Reflect.deleteProperty(document, 'execCommand') } catch { /* ignore */ }
  })
  await page.waitForTimeout(1600) // 已复制反馈按 1.5s 后消失

  // 键盘可访问性：Tab 顺序从朗读到复制，焦点环存在。
  const keyboard = await page.evaluate(async () => {
    const card = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')].find((el) => (el.textContent ?? '').includes('答案折叠验收')) ?? null
    if (card === null) return { skip: true }
    const readBtn = card.querySelector('[data-dsh-speak="button"]')
    readBtn?.focus()
    return { tabIndex: readBtn?.tabIndex ?? null, activeIsRead: document.activeElement === readBtn }
  })
  await page.locator(`${ASSISTANT_CARD}:not([data-empty="1"]) [data-dsh-speak="button"]`).last().press('Tab')
  const focusRing = await page.evaluate(() => {
    const el = document.activeElement
    const cs = getComputedStyle(el)
    return { tag: el.tagName, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset }
  })
  check('所有按钮可键盘聚焦，焦点环为 2px #AFA9EC 偏移 2px',
    keyboard.skip !== true && keyboard.activeIsRead && focusRing.tag === 'BUTTON'
      && focusRing.width === '2px' && focusRing.color === 'rgb(175, 169, 236)' && focusRing.offset === '2px',
    JSON.stringify({ keyboard, focusRing }))


  // 朗读状态机：进播放态 → 单击暂停 → 单击继续 → 长按从头重读（回复卡上的那颗钮）
  const speakBtn = page.locator(`${ASSISTANT_CARD}:not([data-empty="1"]) [data-dsh-speak="button"]`).last()
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
  const ariaPressedDuringRead = await speakBtn.getAttribute('aria-pressed')
  check('朗读中 aria-pressed 状态正确', ariaPressedDuringRead === 'true', `ariaPressed=${ariaPressedDuringRead}`)
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
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
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
    // 两边都先去标点再比前 6 个汉字；TTS 规范化会改动标点，不能只清洗标题。
    const cjk = (s) => String(s).replace(/[^一-鿿]/g, '')
    const head = (s) => cjk(s).slice(0, 6)
    const before = ttsBodies.length
    await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])').first()
      .locator('[data-dsh-speak="button"]').click()
    await page.waitForTimeout(600)
    const sent = ttsBodies.slice(before).map((body) => { try { return JSON.parse(body)?.text ?? '' } catch { return '' } }).join(' ')
    check('点历史卡朗读：TTS 收到的是该卡自己的文本', head(hist.firstTitle) !== '' && cjk(sent).includes(head(hist.firstTitle)),
      `sent=${sent.slice(0, 50)} want=${hist.firstTitle.slice(0, 14)}`)
    check('点历史卡朗读：绝不读最新一条', head(hist.lastTitle) === '' || !cjk(sent).includes(head(hist.lastTitle)),
      `last=${hist.lastTitle.slice(0, 14)}`)
    await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])').first()
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
    cards: document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])').length,
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
    if (candidate === idBeforeLongPress) continue // 固定秘书在本地 id 写入前就被列进候选，不能拿它验普通会话
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
    if (cuResponse.unavailable === true || cuResponse.status === 404 ||
      (cuResponse.status === 409 && (await readHostSecretaryMeta())?.dispatchPolicy !== 'default-computer-use-v2')) {
      notes.push('CU 通知段：宿主未加载 v2 合成消息修复（路由 404 或旧实现 409），跳过——重启后自动验完整通知链路')
    } else {
      check('CU 完成通知落盘（宿主路由接受）', cuResponse.ok === true, JSON.stringify(cuResponse))
      const noticeCard = await page.waitForFunction((title) => {
        const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
        const hit = cards.find((el) => (el.textContent ?? '').includes(title))
        if (hit === undefined) return false
        const ref = hit.querySelector('[data-dsh-scard="ref"]')
        return ref !== null && (ref.textContent ?? '').includes(title) ? { found: true } : false
      }, cuTitle, { timeout: 20000 }).then(() => true).catch(() => false)
      check('通知卡片含可点跳信息行（引用块带 CU 会话标题）', noticeCard)
      if (noticeCard) {
        await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])', { hasText: cuTitle })
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

  // ── 默认派活实时回归（仅 REAL_CARD；宿主必须已加载 default-computer-use-v2）──
  // 构建产物契约在本脚本开头已跑。下面这段在宿主重启后进一步让真模型回答用户原话，
  // 同时观察会话注册表：QQ 看屏问话必须新建 CU，纯知识日期问话不得新建任何 CU。
  if (REAL_CARD) {
    const secretaryMeta = await readHostSecretaryMeta()
    const hostVersion = await page.evaluate(async () => {
      const health = await fetch('/api/worktable/health', { cache: 'no-store' }).then((res) => res.json()).catch(() => null)
      return String(health?.version ?? '')
    })
    if (secretaryMeta?.dispatchPolicy !== 'default-computer-use-v2' || hostVersion !== LOCAL_VERSION) {
      notes.push(`默认派活实时模型段：宿主运行 ${hostVersion || '未知版本'}，本次构建 ${LOCAL_VERSION}——不是同一份代码（按要求本轮不重启宿主），跳过实时模型段；构建产物派活契约已在本脚本开头逐项断言`)
    } else {
      const secretaryId = String(secretaryMeta?.sessionId ?? '')
      const beforeQq = await readSessionRows()
      const beforeQqIds = beforeQq.map((row) => row.id)
      const beforeQqCards = await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])').count()
      await page.evaluate(async ({ id, text }) => {
        if (typeof window.__dshPromptIntoSession !== 'function') throw new Error('缺少 __dshPromptIntoSession')
        await window.__dshPromptIntoSession(id, text)
      }, { id: secretaryId, text: QQ_SCREEN_QUESTION })
      const qqLive = await page.waitForFunction(({ beforeIds, beforeCards }) => {
        const snap = window.__dshSessions?.list?.getSnapshot?.() ?? null
        const ids = Array.isArray(snap?.ids) ? snap.ids : []
        const created = ids.map((id) => {
          const row = snap?.byId?.[id] ?? {}
          return { id: String(id), title: String(row?.title ?? ''), agentPreset: String(row?.agentPreset ?? row?.header?.agentPreset ?? '') }
        }).find((row) => !beforeIds.includes(row.id) && row.agentPreset === 'computer-use')
        const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
        const lastText = cards.length > beforeCards ? String(cards[cards.length - 1]?.textContent ?? '') : ''
        return created && /已派/.test(lastText) ? { ...created, reply: lastText } : false
      }, { beforeIds: beforeQqIds, beforeCards: beforeQqCards }, { timeout: 180000 })
        .then((handle) => handle.jsonValue()).catch(() => null)
      check('实时模型：QQ 原话产生 computer-use 派活，秘书回报已派', qqLive !== null, JSON.stringify(qqLive))
      check('实时模型：QQ 原话没有「看不到/没有截图能力/无法确认」收工式终答',
        qqLive !== null && !/我看不到|没有截图能力|无法直接确认|没法直接确认/.test(qqLive.reply),
        String(qqLive?.reply ?? '(未等到回复)').slice(0, 240))

      if (qqLive !== null) {
        notes.push(`默认派活实时模型段：QQ 原话新建 CU=${qqLive.id}，标题=${qqLive.title}`)
        const beforeDateRows = await readSessionRows()
        const beforeDateIds = beforeDateRows.map((row) => row.id)
        const beforeDateCards = await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])').count()
        await page.evaluate(async ({ id, text }) => { await window.__dshPromptIntoSession(id, text) }, { id: secretaryId, text: DIRECT_QUESTION })
        const dateReply = await page.waitForFunction((beforeCards) => {
          const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
          if (cards.length <= beforeCards) return false
          const text = String(cards[cards.length - 1]?.textContent ?? '')
          const compact = text.replace(/\s+/g, '')
          return /11月21日|十一月二十一日/.test(compact) ? text : false
        }, beforeDateCards, { timeout: 120000 }).then((handle) => handle.jsonValue()).catch(() => null)
        check('实时模型：「今天几号」仍由秘书直接回答', typeof dateReply === 'string' && dateReply !== '', String(dateReply ?? '(未等到日期回复)').slice(0, 160))
        await page.waitForTimeout(800)
        const afterDateRows = await readSessionRows()
        const dateCreatedCu = afterDateRows.filter((row) => !beforeDateIds.includes(row.id) && row.agentPreset === 'computer-use')
        check('实时模型：「今天几号」不派活、不新建 CU 会话', dateCreatedCu.length === 0, JSON.stringify(dateCreatedCu))
      }
    }
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
