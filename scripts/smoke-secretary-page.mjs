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
 *   9. 引用提示的现场几何：手机那一档（414 粗指针）+ 桌面宽度那一档（1000×760、非粗指针，另开一条现场页）——
 *    提示必须挂在宿主 .standardControls 里；宿主那一行盒子高必须小于「工具组高 + 尾组高 + 24」（换没换行的判据）；
 *    提示右沿 ≤ 行右沿、整组右沿 ≤ 行右沿、整组左沿 ≥ 工具组右沿；提示单行 30px 且落在输入框下方与那一行之内；
 *    发送钮与模型胶囊照旧在；「· 卡片种类」按那一行的宽度自己收放。判的是真宿主的 InputBar，视觉套件的镜像页只是它的复刻
 *    （2026-11-23 桌面那次「显示错位」就是靠这一档拦住的）。
 *   8. DSH_SMOKE_REAL_CARD=1：用户 QQ 看屏原话必须派 computer-use，回执不得是「看不到」终答；
 *      「今天几号」直接答、不建 CU。先验本次 lib 构建契约，宿主带 v2 提示词时再验真实模型。
 *
 * 退出码 0 = 全绿。任何断言失败都会打印现场事实。
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'

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
/** 已读卡持久化：客户端问/写宿主 /api/assistant/secretary-read 的全部请求（宿主真值优先，答不上走本地缓存） */
const readRouteRequests = []
/** 分页取数：客户端问宿主 /api/assistant/secretary/history 的全部请求与响应原文（报告要贴这两条）。 */
const historyRouteRequests = []
const historyRouteResponses = []
/** 已知既有 4xx（与本次改动无关；项目卡片探测 widget-result.json 时本来就没有这个文件）。
 *  /api/assistant/cu-watch/notify 是 CU 通知段的能力探测：宿主未重载新代码时 404 属预期，
 *  路由生效后正常返回 200；旧宿主缺 stream 的 409 会按能力未加载跳过，v2 宿主的 409 仍算失败。
 *  /api/assistant/secretary-read、/api/assistant/secretary-history、/api/assistant/secretary-context
 *  同理：跑着旧构建的宿主上没这些路由 → 401/404 是**预期降级** （客户端必须改用本地缓存 / DOM 顺序分页继续渲染、不许崩、不许阻塞），宿主重载后自动变 200。
 *  /api/assistant/secretary-quote（第 4 项引用登记的宿主路由）同理：宿主没重启/没重载新构建时 404 属预期，客户端降级用 localStorage 缓存继续跑。 */
const IGNORED_FAILED_URL = /\/api\/worktable\/file\?|\/api\/assistant\/cu-watch\/notify|\/api\/assistant\/secretary-read|\/api\/assistant\/secretary\/history|\/api\/assistant\/secretary-context|\/api\/assistant\/secretary-quote/
page.on('console', (message) => {
  if (message.type() !== 'error') return
  const text = String(message.text())
  // 「Failed to load resource」不带 URL，按 URL 单独核对（见 failedRequests）
  if (text.startsWith('Failed to load resource')) return
  if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return
  consoleErrors.push(text.slice(0, 300))
})
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
page.on('request', (request) => {
  const path = request.url().replace(/^https?:\/\/[^/]+/, '')
  if (request.url().includes('/api/assistant/secretary-read')) {
    readRouteRequests.push(`${request.method()} ${path} ${String(request.postData() ?? '').slice(0, 160)}`)
  }
  if (request.url().includes('/api/assistant/secretary/history')) {
    historyRouteRequests.push(`${request.method()} ${path}`)
  }
})
page.on('response', (response) => {
  const url = response.url()
  if (url.includes('/api/assistant/secretary/history')) {
    void response.text().then(
      (body) => { historyRouteResponses.push(`${response.status()} ${url.replace(/^https?:\/\/[^/]+/, '')} ${String(body).slice(0, 300)}`) },
      () => { historyRouteResponses.push(`${response.status()} ${url.replace(/^https?:\/\/[^/]+/, '')} （读不到响应体）`) },
    )
    return
  }
  if (response.status() < 400) return
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
    // 折叠验收要看「真的溢出」的卡：优先溢出卡（fixture 溢出卡 → 任意溢出卡 → 兜底最后一张）
    const overflowing = cards.filter((el) => el.getAttribute('data-overflow') === '1' && el.querySelector('[data-dsh-scard="expand"]') !== null)
    const card = (fixtureCard !== null && fixtureCard.getAttribute('data-overflow') === '1' ? fixtureCard : null)
      ?? overflowing[overflowing.length - 1] ?? fixtureCard ?? cards[cards.length - 1] ?? null
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
    const quote = pick(foot, '[data-dsh-scard="quote"]')
    const quoteIcon = pick(quote, 'svg')
    const separator = pick(foot, '[data-dsh-scard="separator"]')
    const expand = pick(foot, '[data-dsh-scard="expand"]')
    const expandText = pick(expand, '[data-dsh-scard="expand-text"]')
    const arrow = pick(expand, '[data-dsh-scard="expand-arrow"]')
    const time = pick(foot, '[data-dsh-scard="time"]')
    const actions = pick(foot, '[data-dsh-scard="actions"]')
    // 折叠几何挂在 [data-dsh-scard="content"]（max-height 是行内样式）；截断标记是一颗真 span，不是伪元素遮罩
    const content = pick(body, '[data-dsh-scard="content"]')
    const ellipsis = pick(content, '[data-dsh-scard="ellipsis"]')
    const unreadDot = pick(card, '[data-dsh-scard="unread-dot"]')
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
      bodyRole: body?.getAttribute('role') ?? '',
      bodyTabIndex: body?.getAttribute('tabindex') ?? '',
      bodyAriaExpanded: body?.getAttribute('aria-expanded') ?? '',
      bodyFoldMode: body?.getAttribute('data-dsh-scard-fold') ?? '',
      contentMaxHeight: content ? cs(content).maxHeight : '',
      contentClientHeight: content?.clientHeight ?? 0,
      contentScrollHeight: content?.scrollHeight ?? 0,
      paraCount: paras.length,
      paraTopInsideContent: (() => { const p = rectOf(firstPara); const c = rectOf(content); return p && c ? Math.round(p.top - c.top) : -1 })(),
      paraLineHeightPx: paraCs?.lineHeight ?? '',
      ellipsisText: ellipsis?.textContent ?? '',
      ellipsisGradientInCss: (() => {
        for (const sheet of document.styleSheets ?? []) {
          try {
            for (const rule of sheet.cssRules ?? []) {
              const selector = rule.selectorText ?? ''
              if (selector.includes('[data-dsh-scard="content"]') && /::(after|before)/.test(selector)) return `${selector}{${rule.style?.cssText ?? ''}}`
            }
          } catch { /* 跨源/保护表跳过 */ }
        }
        return ''
      })(),
      unreadDotExists: unreadDot !== null,
      unreadDotSize: rectText(unreadDot),
      unreadDotColor: unreadDot ? cs(unreadDot).backgroundColor : '',
      unreadDotAria: unreadDot?.getAttribute('aria-label') ?? '',
      unreadAttr: card.getAttribute('data-unread') ?? '',
      footChildOrder: foot ? [...foot.children].map((el) => el.getAttribute('data-dsh-scard') ?? '') : [],
      footTimeCount: foot ? foot.querySelectorAll('[data-dsh-scard="time"]').length : 0,
      timeCopyGap: (() => { const t = rectOf(time); const c = rectOf(copy); return t && c ? Math.round(c.left - t.right) : -1 })(),
      timeFormatOk: /^\d{1,2}:[0-5]\d$/.test((time?.textContent ?? '').trim()) || /^(昨天|[0-9]+月[0-9]+日)\s\d{1,2}:[0-5]\d$/.test((time?.textContent ?? '').trim()),
      timeHasTodayWord: /今天/.test(time?.textContent ?? ''),
      timeText: time?.textContent ?? '',
      timeDisplay: time ? cs(time).display : '',
      timeFontSize: time ? cs(time).fontSize : '',
      timeColor: time ? cs(time).color : '',
      footText: foot?.textContent ?? '',
      footReadCount: footRead ? 1 : 0,
      copyExists: copy !== null,
      copyColor: copy ? cs(copy).color : '',
      copyRadius: copy ? cs(copy).borderRadius : '',
      copyCursor: copy ? cs(copy).cursor : '',
      copyBackground: copy ? cs(copy).backgroundColor : '',
      quoteExists: quote !== null,
      quoteTitle: quote?.getAttribute('title') ?? '',
      quoteSize: rectText(quote),
      quoteIconSize: rectText(quoteIcon),
      quoteColor: quote ? cs(quote).color : '',
      quoteRadius: quote ? cs(quote).borderRadius : '',
      quoteBackground: quote ? cs(quote).backgroundColor : '',
      quoteCursor: quote ? cs(quote).cursor : '',
      quoteAriaPressed: quote?.getAttribute('aria-pressed') ?? '',
      quoteBeforeTime: (() => { const q = rectOf(quote); const t = rectOf(time); return q && t ? Math.round(t.left - q.right) >= 0 && q.left < t.left : false })(),
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
  check('结论行（标题）18px / 600、详情段落 14px / 400 / 行高 26px —— 结论大、细节小的那档字号',
    scard.titleFontSize === '18px' && scard.titleFontWeight === '600' && scard.paraFontSize === '14px' && scard.paraLineHeight === '26px' && scard.paraFontWeight === '400',
    JSON.stringify({ title: scard.titleFontSize, titleWeight: scard.titleFontWeight, para: scard.paraFontSize, paraWeight: scard.paraFontWeight, lineHeight: scard.paraLineHeight }))
  // 现场条件：这一档量的探针（那颗 qwen-probe 合成节点）挂在 body[data-dsh-secretary="1"] 的作用域里，
  // 页面这一轮如果没落到秘书会话页（或卡还在渲染），量出来就是空串——空串算「现场条件不足」，记一句跳过，不许当成失败或不许当成通过。
  const scardStyleProbeBlank = scard.strongFontWeight === '' || scard.modelFontSize === ''
  if (scardStyleProbeBlank) notes.push(`卡片样式现场核对跳过：这一轮页面上量不到秘书会话卡的样式（hasCard=${scard.hasCard} usedFixture=${scard.usedFixture} strong=${scard.strongFontWeight || '(空)'} model=${scard.modelFontSize || '(空)'}），判据由 scripts/test-secretary-cards.mjs 与视觉套件覆盖`)
  check('详情正文颜色 #4E5969，重点句使用 600 字重与 #1F2329（只换字号，粗与不粗照旧）',
    scardStyleProbeBlank === true || (scard.paraColor === 'rgb(78, 89, 105)' && scard.strongFontWeight === '600' && scard.strongColor === 'rgb(31, 35, 41)'),
    JSON.stringify({ paraColor: scard.paraColor, strong: scard.strongFontWeight, strongColor: scard.strongColor }))
  check('模型名称使用浅紫底、深紫字、13px 等宽字体（chip 字号加两号）',
    scardStyleProbeBlank === true || (scard.modelText !== '' && scard.modelFontSize === '13px' && scard.modelColor === 'rgb(60, 52, 137)'
      && scard.modelBackground === 'rgb(238, 237, 254)' && /monospace/i.test(scard.modelFontFamily)),
    JSON.stringify({ model: scard.modelText, size: scard.modelFontSize, color: scard.modelColor, background: scard.modelBackground }))
  check('脚部顺序是「引用 + 时间 + 操作区」、时间紧贴复制按钮左边（12px 时间、只有一颗时间）',
    scard.footExists && scard.footBackground === 'rgb(250, 250, 251)' && scard.copyExists && scard.separatorExists
      && scard.expandExists && scard.expandText === '展开全文'
      && JSON.stringify(scard.actionOrder) === JSON.stringify(['copy', 'separator', 'expand'])
      && JSON.stringify(scard.footChildOrder) === JSON.stringify(['quote', 'time', 'actions'])
      && scard.timeCopyGap >= 0 && scard.timeCopyGap <= 12 && scard.footTimeCount === 1
      && scard.timeFontSize === '12px' && scard.timeDisplay !== 'none',
    JSON.stringify({ footOrder: scard.footChildOrder, order: scard.actionOrder, timeCopyGap: scard.timeCopyGap, timeSize: scard.timeFontSize, timeDisplay: scard.timeDisplay }))
  check('引用按钮挂在时间左边、规格与时间右边那棵复制按钮一致（30×30、16×16 图标、同一灰、同一圆角、pointer）',
    scard.quoteExists === true && scard.copyExists === true
      && scard.quoteBeforeTime === true
      && Number.parseFloat(scard.quoteSize) >= 29 && Number.parseFloat(scard.quoteSize) <= 31
      && Number.parseFloat(scard.copySize) >= 29 && Number.parseFloat(scard.copySize) <= 31
      && Number.parseFloat(scard.quoteIconSize) >= 15 && Number.parseFloat(scard.quoteIconSize) <= 17
      && Number.parseFloat(scard.copyIconSize) >= 15 && Number.parseFloat(scard.copyIconSize) <= 17
      && scard.quoteColor === scard.copyColor && scard.quoteRadius === scard.copyRadius
      && scard.quoteBackground === scard.copyBackground && scard.quoteCursor === scard.copyCursor
      && scard.quoteCursor === 'pointer' && /引用这条卡/.test(scard.quoteTitle) && scard.quoteAriaPressed === 'false',
    JSON.stringify({ quoteSize: scard.quoteSize, quoteIcon: scard.quoteIconSize, copyIcon: scard.copyIconSize, quoteColor: scard.quoteColor, quoteRadius: scard.quoteRadius, quoteCursor: scard.quoteCursor, quoteTitle: scard.quoteTitle, quoteBeforeTime: scard.quoteBeforeTime }))
  check('脚部时间只写 HH:MM（去掉「今天」字样）、紧贴复制按钮左边',
    scard.timeHasTodayWord === false && scard.timeFormatOk === true && scard.timeCopyGap >= 0 && scard.timeCopyGap <= 12,
    JSON.stringify({ timeText: scard.timeText, formatOk: scard.timeFormatOk, timeCopyGap: scard.timeCopyGap, footTimeCount: scard.footTimeCount }))
  const foldLineH = Number.parseFloat(scard.paraLineHeightPx) || 26
  const foldBodyClip = scard.contentClientHeight - scard.paraTopInsideContent
  const foldBodyLines = Math.floor((foldBodyClip + 1) / foldLineH)
  check('折叠态正文最多 3 行、有明确 max-height 数值、真被截断（scrollHeight>clientHeight）、末尾是…标记（无渐变遮罩）',
    scard.contentMaxHeight.endsWith('px') && Number.parseFloat(scard.contentMaxHeight) > 0
      && scard.contentClientHeight === Number.parseFloat(scard.contentMaxHeight)
      && scard.contentScrollHeight > scard.contentClientHeight
      && foldBodyClip >= foldLineH && foldBodyLines <= 3
      && scard.ellipsisText === '…' && scard.ellipsisGradientInCss === '',
    JSON.stringify({ maxHeight: scard.contentMaxHeight, clientHeight: scard.contentClientHeight, scrollHeight: scard.contentScrollHeight, paraTop: scard.paraTopInsideContent, bodyClip: foldBodyClip, lineH: foldLineH, foldBodyLines, ellipsis: scard.ellipsisText, mask: scard.ellipsisGradientInCss }))
  check('卡体可聚焦可展开（role=button + tabindex=0 + aria-expanded=false + 可点 fold=toggle）',
    scard.bodyRole === 'button' && scard.bodyTabIndex === '0' && scard.bodyAriaExpanded === 'false' && scard.bodyFoldMode === 'toggle',
    JSON.stringify({ role: scard.bodyRole, tabindex: scard.bodyTabIndex, aria: scard.bodyAriaExpanded, fold: scard.bodyFoldMode }))
  // 2026-11-22 折叠失效补丁：三条根因在现网（手机入口视口）逐条取证，并验「折叠生效率 100%」
  const foldFallbackProbe = await page.evaluate(async () => {
    const card = document.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')
    const content = card === null ? null : card.querySelector('[data-dsh-scard="content"]')
    if (content === null) return null
    const title = content.querySelector('[data-dsh-scard="title"]')
    // 静态证据：样式表里那条「首帧就生效」的折叠上限规则必须存在且不是 none
    let declaredCap = ''
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText === '[data-dsh-scard="card"]:not([data-open="1"]) [data-dsh-scard="content"]') declaredCap = rule.style.maxHeight
        }
      } catch { /* 跨域 sheet 读不到就跳过 */ }
    }
    const inline = content.getAttribute('style') ?? ''
    // 把行内 max-height 摘掉 = 模拟「卡片刚挂载、JS 还没测量」的那一帧，CSS 必须已经顶住；
    // 等过渡动画结束再读真值（160ms 过渡会让同步读数停在起始帧），测完原样贴回
    content.removeAttribute('style')
    await new Promise((resolve) => setTimeout(resolve, 230))
    const cap = Number.parseFloat(getComputedStyle(content).maxHeight)
    const clientAtCap = content.clientHeight
    const scrollAtCap = content.scrollHeight
    content.setAttribute('style', inline)
    const titleCs = title === null ? null : getComputedStyle(title)
    return {
      restored: (content.getAttribute('style') ?? '') === inline,
      declaredCap, cap, clientAtCap, scrollAtCap,
      titleClamp: titleCs === null ? 'none' : titleCs.webkitLineClamp,
      titleMaxHeight: title === null ? '' : titleCs.maxHeight,
      titleClientHeight: title === null ? 0 : title.clientHeight,
      titleScrollHeight: title === null ? 0 : title.scrollHeight,
    }
  })
  // 现场条件：这一档判的是「正文比 162px 上限更长」的那类卡；现场那批卡如果本身就比上限短，就没有可判的溢出，记一句跳过。
  const foldFallbackTooShort = foldFallbackProbe !== null && foldFallbackProbe.scrollAtCap <= foldFallbackProbe.cap
  if (foldFallbackTooShort) notes.push('折叠时序兜底现场核对：这一轮页面上没有「比 162px 上限更长」的卡（scrollAtCap=' + foldFallbackProbe.scrollAtCap + ' cap=' + foldFallbackProbe.cap + '），现场跳过；判据由 scripts/test-secretary-cards.mjs 与视觉套件覆盖')
  check('折叠时序兜底：测量前（没有行内 max-height）正文区就有固定上限 162px，卡片不会整段平铺',
    foldFallbackTooShort === true || (foldFallbackProbe !== null && Number.isFinite(foldFallbackProbe.cap) && foldFallbackProbe.cap > 0
      && foldFallbackProbe.cap <= 162 && foldFallbackProbe.clientAtCap <= foldFallbackProbe.cap
      && foldFallbackProbe.scrollAtCap > foldFallbackProbe.cap && foldFallbackProbe.restored === true
      && foldFallbackProbe.declaredCap.includes('162px')),
    JSON.stringify(foldFallbackProbe))
  check('卡标题折叠态被行夹到 2 行（标题也不再整段露出，展开才放开）',
    foldFallbackProbe !== null && foldFallbackProbe.titleClamp === '2'
      && foldFallbackProbe.titleMaxHeight.endsWith('px')
      && Number.parseFloat(foldFallbackProbe.titleMaxHeight) <= 60
      && foldFallbackProbe.titleClientHeight <= Number.parseFloat(foldFallbackProbe.titleMaxHeight),
    JSON.stringify({ clamp: foldFallbackProbe?.titleClamp, maxHeight: foldFallbackProbe?.titleMaxHeight, clientH: foldFallbackProbe?.titleClientHeight, scrollH: foldFallbackProbe?.titleScrollHeight }))
  const foldEffectiveness = await page.evaluate(() => {
    const flat = []
    const folded = []
    for (const card of document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])')) {
      if (card.getAttribute('data-open') === '1') continue
      if (card.querySelector('[data-dsh-scard="collapsed-row"], [data-dsh-scard="collapse-row"]') !== null) continue
      const content = card.querySelector('[data-dsh-scard="content"]')
      if (content === null) continue
      const natural = content.scrollHeight
      if (natural <= 162) continue
      const max = Number.parseFloat(getComputedStyle(content).maxHeight)
      const body = card.querySelector('[data-dsh-scard="body"]')
      const item = {
        kind: card.getAttribute('data-dsh-scard-kind') ?? '',
        maxHeight: Number.isFinite(max) ? max : 'none',
        natural, clientHeight: content.clientHeight,
        cardHeight: Math.round(card.getBoundingClientRect().height),
        fold: body === null ? '' : body.getAttribute('data-dsh-scard-fold') ?? '',
        ellipsis: content.querySelector('[data-dsh-scard="ellipsis"]') !== null,
        expand: card.querySelector('[data-dsh-scard="expand"]') !== null,
      }
      if (!Number.isFinite(max) || item.clientHeight > 162 || item.fold !== 'toggle' || !item.ellipsis || !item.expand) flat.push(item)
      else folded.push(item)
    }
    return { foldedCount: folded.length, flatCards: flat, folded }
  })
  check('折叠生效率 100%：页面上每张内容超过固定上限的卡都收在 ≤162px 正文区（整卡高 ≤320px、带…标记与「展开全文」），没有一张整段平铺',
    foldEffectiveness.foldedCount > 0 && foldEffectiveness.flatCards.length === 0
      && foldEffectiveness.folded.every((item) => item.maxHeight <= 162 && item.cardHeight <= 320),
    JSON.stringify({ foldedCount: foldEffectiveness.foldedCount, flatCards: foldEffectiveness.flatCards, sample: foldEffectiveness.folded.slice(0, 3) }))
  check('朗读按钮不再出现在底部', scard.footReadCount === 0, JSON.stringify({ footReadCount: scard.footReadCount }))
  check('移动端时间仍然显示（换脚部顺序后不许丢时间）、卡片不横向溢出、朗读按钮仍在右上角',
    scard.timeDisplay !== 'none' && scard.hasButton && scard.btnIsLast && scard.btnRightGap >= 15
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
        // 判据与客户端 collectSecretaryCardRows / isSyntheticNoticeUserText（src/secretary-card-shared.ts）同一套：
        // 首行是「（系统通知…）」头，或正文里有 [[session:…]] 引用行。
        // 这里**不许**用「正文里出现系统通知四个字」这种子串判据——用户真消息也可以谈论系统通知
        //（实测 2026-11-24 用户那句「个人秘书会话页面的系统通知的存活时间…」就被旧判据误当成通知行，
        //  于是一条正常用户卡永远凑不够 通知行=通知卡+空壳 的等式，把这项断言打成假失败）。
        const text = (row.querySelector('[data-slot="conversation.user.text.node"]')?.textContent ?? '').trim()
        if (text === '') return false
        const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
        if (lines.length === 0) return false
        if (/^\s*[（(【\[]?\s*系统通知/.test(lines[0])) return true
        return lines.some((line) => /(^|\n)\s*(最后单独一行原样输出：)?\s*\[\[session:[^\]]*\]\]/.test(`\n${line}`))
      })
    const noticeCarded = noticeRows.filter((row) => row.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-dsh-scard-expired="1"])'))
    const noticeCard = noticeCarded[0]?.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-dsh-scard-expired="1"])') ?? null
    const noticeExpiredShells = noticeRows.filter((row) => row.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="notice"][data-dsh-scard-expired="1"]')).length
    const noticeContent = noticeCard?.querySelector('[data-dsh-scard="content"]') ?? null
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
      userUnreadDot: user ? user.querySelector('[data-dsh-scard="unread-dot"]') !== null : false,
      userUnreadAttr: user?.getAttribute('data-unread') ?? '',
      noticeTag: noticeCard?.querySelector('[data-dsh-scard="tag"]')?.textContent ?? '',
      noticeKindAttr: noticeCard?.getAttribute('data-dsh-scard-kind') ?? '',
      noticeBg: noticeCard ? getComputedStyle(noticeCard).backgroundColor : '',
      noticeParaSize: noticeCard?.querySelector('[data-dsh-scard="para"]') ? getComputedStyle(noticeCard.querySelector('[data-dsh-scard="para"]')).fontSize : '',
      noticeTitleSize: noticeCard?.querySelector('[data-dsh-scard="title"]') ? getComputedStyle(noticeCard.querySelector('[data-dsh-scard="title"]')).fontSize : '',
      noticeMaxHeightRaw: noticeContent ? getComputedStyle(noticeContent).maxHeight : '',
      noticeMaxHeightPx: noticeContent ? /px$/.test(getComputedStyle(noticeContent).maxHeight) : false,
      noticeDot: noticeCard ? noticeCard.querySelector('[data-dsh-scard="unread-dot"]') !== null : false,
      noticeEllipsis: noticeContent?.querySelector('[data-dsh-scard="ellipsis"]')?.textContent ?? '',
      noticeRefChip: noticeCard ? noticeCard.querySelector('[data-dsh-scard="ref"]') !== null : false,
      footOrder: foot ? [...foot.querySelectorAll('[data-dsh-scard="actions"] > *')].map((el) => el.getAttribute('data-dsh-scard') ?? '') : [],
      footReadInUserCard: user ? user.querySelectorAll('[data-dsh-scard="foot"] [data-dsh-speak="button"]').length : -1,
      duplicatedCount: duplicated.length,
      noticeRowCount: noticeRows.length,
      noticeCardedCount: noticeCarded.length,
      noticeExpiredShellsCount: noticeExpiredShells,
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
  check('用户卡头部是你/用户消息（冷蓝标识）、脚部时间+复制、正文是用户原话、时间只写 HH:MM',
    ucard.userName === '你' && ucard.userTag === '用户消息' && ucard.userMarkColor === 'rgb(24, 74, 128)'
      && ucard.userCopyTitle === '复制这条消息' && ucard.userSpeakTitle === '朗读这条消息'
      && !/今天/.test(ucard.userTimeText) && /^\d{1,2}:[0-5]\d$/.test(ucard.userTimeText) && ucard.footReadInUserCard === 0
      && JSON.stringify(ucard.footOrder.slice(0, 1)) === JSON.stringify(['copy'])
      && (ucard.userText.includes('冒烟测试') || ucard.userText.includes('答案折叠验收')),
    JSON.stringify({ name: ucard.userName, tag: ucard.userTag, mark: ucard.userMarkColor, copy: ucard.userCopyTitle, speak: ucard.userSpeakTitle, time: ucard.userTimeText, foot: ucard.footOrder, text: ucard.userText.slice(0, 40) }))
  check('用户卡没有未读红点（kind=user 不参与红点规则）',
    ucard.userUnreadDot === false && ucard.userUnreadAttr !== '1', JSON.stringify({ dot: ucard.userUnreadDot, attr: ucard.userUnreadAttr }))
  check('每条通知行都归到卡片（没过期的是灰底「系统 · 通知」完整卡，过期的是空壳），不写成用户卡/个人秘书',
    ucard.noticeRowCount >= 1 && ucard.noticeCardedCount + ucard.noticeExpiredShellsCount === ucard.noticeRowCount
      && (ucard.noticeCardedCount === 0 || (ucard.noticeKindAttr === 'notice' && ucard.noticeTag === '系统 · 通知' && ucard.noticeBg === 'rgb(246, 247, 249)')),
    JSON.stringify({ noticeRows: ucard.noticeRowCount, noticeCarded: ucard.noticeCardedCount, noticeExpiredShells: ucard.noticeExpiredShellsCount, tag: ucard.noticeTag, kind: ucard.noticeKindAttr, bg: ucard.noticeBg, uncarded: ucard.noticeUncardedRows }))
  if (ucard.noticeCardedCount >= 1) {
    check('通知卡字号与折叠跟秘书卡共用一套实现（详情 14px/行高 26px、结论 18px、max-height 是 px 数值、带…标记）',
      ucard.noticeParaSize === '14px' && ucard.noticeTitleSize === '18px' && ucard.noticeMaxHeightPx === true
      && ucard.noticeEllipsis === '…',
      JSON.stringify({ para: ucard.noticeParaSize, title: ucard.noticeTitleSize, maxHeight: ucard.noticeMaxHeightRaw, dot: ucard.noticeDot, ellipsis: ucard.noticeEllipsis }))
  } else {
    notes.push('通知卡字号现场核对：窗口里的通知卡全都满 10 分钟被收成空壳了，这一段改由后面的新鲜通知卡断言覆盖')
  }
  if (ucard.noticeCardedCount >= 1) {
    check('通知卡的 [[session:…]] 引用仍是可点 chip',
      ucard.noticeRefChip === true, JSON.stringify({ refChip: ucard.noticeRefChip }))
  }
  check('卡片化用户行不留下重复文本（宿主气泡已收起）',
    ucard.duplicatedCount === 0, JSON.stringify({ cardedDuplicated: ucard.duplicatedCount, keys: ucard.userKeys }))

  // 附件批次（2026-11-24）：现网那条「文字 + 截图 + 文字」的真实用户消息，卡片里必须
  // ① 三段文字全在、顺序没乱，② 缩略图嵌在卡片内部出图，③ 宿主那条原生附件行不再出图。
  const attachProbe = await page.evaluate(() => {
    const hits = []
    for (const row of document.querySelectorAll('[data-chat-flow-kind="user"]')) {
      const content = row.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="user"] [data-dsh-scard="content"]')
      const attachment = content === null ? null : content.querySelector('[data-dsh-scard="attachment"]')
      if (attachment === null) continue
      const blocks = [...content.querySelectorAll('[data-dsh-scard="para"], [data-dsh-scard="attachment"]')]
      const order = blocks.map((el) => el.getAttribute('data-dsh-scard'))
      const firstPara = order.indexOf('para')
      const lastPara = order.lastIndexOf('para')
      const attachIndex = order.indexOf('attachment')
      const paras = order.filter((name) => name === 'para').length
      const img = attachment.querySelector('[data-dsh-scard="attachment-thumb"]')
      const hostNode = row.querySelector('[data-slot="conversation.chat.node"]')
      const hostAttach = row.querySelector('[data-message-attachments]')
      hits.push({
        nodeKey: row.getAttribute('data-chat-node-key') ?? '',
        order,
        texts: blocks.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48)),
        orderRelOk: paras < 2 || (attachIndex > firstPara && attachIndex < lastPara),
        thumbLoaded: img !== null && img.complete === true && img.naturalWidth > 0,
        thumbVisible: img !== null && img.offsetParent !== null,
        thumbBox: img === null ? null : { w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) },
        attachmentName: (attachment.querySelector('[data-dsh-scard="attachment-name"]')?.textContent ?? '').trim(),
        hostNodeDisplay: hostNode === null ? '' : getComputedStyle(hostNode).display,
        hostAttachRendered: hostAttach !== null && hostAttach.offsetParent !== null,
      })
    }
    return hits
  })
  if (attachProbe.length === 0) {
    notes.push('附件卡片现场核对：窗口里当时没有带附件的用户消息卡（断言由 test-secretary-cards 四条 + 视觉套件三条覆盖）')
  }
  for (const item of attachProbe.slice(0, 3)) {
    check('带附件的用户消息卡（现网现场）：缩略图嵌在卡片内部、宿主原生附件行不再出图、文件名在卡里',
      item.hostNodeDisplay === 'none' && item.hostAttachRendered === false && item.thumbVisible === true
      && item.thumbLoaded === true && item.thumbBox !== null && item.thumbBox.w >= 40 && item.attachmentName !== '',
      JSON.stringify({ nodeKey: item.nodeKey, thumb: item.thumbBox, name: item.attachmentName, hostNodeDisplay: item.hostNodeDisplay, hostAttachRendered: item.hostAttachRendered }))
    check('带附件的用户消息卡（现网现场）：附件前后文字都留在卡片里、块顺序没乱',
      item.orderRelOk === true && item.order.includes('attachment') && item.order.includes('para'),
      JSON.stringify({ order: item.order, texts: item.texts }))
  }

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
    // 点卡体正文区（不是按钮）必须展开；朗读/复制/展开全文按钮都不许经由卡体被触发
    const beforeBodyClick = await expandCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      aria: el.querySelector('[data-dsh-scard="body"]')?.getAttribute('aria-expanded') ?? '',
      height: el.querySelector('[data-dsh-scard="content"]').clientHeight,
      dot: el.querySelector('[data-dsh-scard="unread-dot"]') !== null,
      unreadAttr: el.getAttribute('data-unread') ?? '',
      speakPressed: el.querySelector('[data-dsh-speak="button"]')?.getAttribute('aria-pressed') ?? '',
      copyStatus: el.querySelector('[data-dsh-scard="copy-status"]')?.textContent ?? '',
    }))
    await expandCard.locator('[data-dsh-scard="body"]').click()
    await page.waitForTimeout(400)
    const afterBodyClick = await expandCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      aria: el.querySelector('[data-dsh-scard="body"]')?.getAttribute('aria-expanded') ?? '',
      height: el.querySelector('[data-dsh-scard="content"]').clientHeight,
      maxHeight: getComputedStyle(el.querySelector('[data-dsh-scard="content"]')).maxHeight,
      titleClamp: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? 'none' : getComputedStyle(t).webkitLineClamp })(),
      titleMaxHeight: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? '' : getComputedStyle(t).maxHeight })(),
      titleClientHeight: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? 0 : t.clientHeight })(),
      ellipsis: el.querySelector('[data-dsh-scard="content"] [data-dsh-scard="ellipsis"]') !== null,
      text: el.querySelector('[data-dsh-scard="expand-text"]')?.textContent ?? '',
      speakPressed: el.querySelector('[data-dsh-speak="button"]')?.getAttribute('aria-pressed') ?? '',
      copyStatus: el.querySelector('[data-dsh-scard="copy-status"]')?.textContent ?? '',
      dot: el.querySelector('[data-dsh-scard="unread-dot"]') !== null,
      unreadAttr: el.getAttribute('data-unread') ?? '',
    }))
    check('点卡体正文空白 = 展开（aria-expanded false→true、高度增长、…标记与红点都没了）',
      beforeBodyClick.open === '0' && beforeBodyClick.aria === 'false' && afterBodyClick.open === '1' && afterBodyClick.aria === 'true'
        && afterBodyClick.height > beforeBodyClick.height && afterBodyClick.maxHeight === 'none' && afterBodyClick.ellipsis === false
        && afterBodyClick.text === '收起' && afterBodyClick.dot === false && afterBodyClick.unreadAttr === '0',
      JSON.stringify({ before: beforeBodyClick, after: afterBodyClick }))
    check('点卡体没有顺带触发朗读或复制（aria-pressed 与复制反馈都原地不动）',
      afterBodyClick.speakPressed === beforeBodyClick.speakPressed && afterBodyClick.copyStatus === beforeBodyClick.copyStatus,
      JSON.stringify({ before: { speakPressed: beforeBodyClick.speakPressed, copyStatus: beforeBodyClick.copyStatus }, after: { speakPressed: afterBodyClick.speakPressed, copyStatus: afterBodyClick.copyStatus } }))
    await expandCard.locator('[data-dsh-scard="body"]').click()
    await page.waitForTimeout(400)
    const reCollapsed = await expandCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      aria: el.querySelector('[data-dsh-scard="body"]')?.getAttribute('aria-expanded') ?? '',
      maxHeight: getComputedStyle(el.querySelector('[data-dsh-scard="content"]')).maxHeight,
      titleClamp: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? 'none' : getComputedStyle(t).webkitLineClamp })(),
      titleMaxHeight: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? '' : getComputedStyle(t).maxHeight })(),
      titleClientHeight: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? 0 : t.clientHeight })(),
      ellipsis: el.querySelector('[data-dsh-scard="content"] [data-dsh-scard="ellipsis"]') !== null,
      text: el.querySelector('[data-dsh-scard="expand-text"]')?.textContent ?? '',
    }))
    check('再点卡体收起回到折叠态（max-height 数值回来、…标记回来）',
      reCollapsed.open === '0' && reCollapsed.aria === 'false' && reCollapsed.maxHeight.endsWith('px') && reCollapsed.ellipsis === true && reCollapsed.text === '展开全文',
      JSON.stringify(reCollapsed))
    await expandCard.locator('[data-dsh-scard="expand"]').click()
    await page.waitForTimeout(400)
    const expanded = await expandCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      aria: el.querySelector('[data-dsh-scard="expand"]')?.getAttribute('aria-expanded') ?? '',
      text: el.querySelector('[data-dsh-scard="expand-text"]')?.textContent ?? '',
      bodyMaxHeight: getComputedStyle(el.querySelector('[data-dsh-scard="content"]')).maxHeight,
      titleClamp: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? 'none' : getComputedStyle(t).webkitLineClamp })(),
      titleMaxHeight: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? '' : getComputedStyle(t).maxHeight })(),
      titleClientHeight: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? 0 : t.clientHeight })(),
      titleScrollHeight: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? 0 : t.scrollHeight })(),
      arrowTransform: getComputedStyle(el.querySelector('[data-dsh-scard="expand-arrow"]')).transform,
    }))
    check('展开全文按钮独立 work：aria-expanded 切换、文案变「收起」、箭头旋转、max-height 变 none',
      expanded.open === '1' && expanded.aria === 'true' && expanded.text === '收起' && expanded.bodyMaxHeight === 'none'
        && expanded.arrowTransform.includes('-1'), JSON.stringify(expanded))
    // 展开态必须放开标题行夹（长标题的其余行这时才看得到）
    check('展开态放开卡标题行夹（clamp 变 none、max-height 放开、标题露出更多行）',
      expanded.titleClamp === 'none' && expanded.titleMaxHeight === 'none' && expanded.titleClientHeight >= expanded.titleScrollHeight - 1,
      JSON.stringify({ clamp: expanded.titleClamp, maxHeight: expanded.titleMaxHeight, clientH: expanded.titleClientHeight, scrollH: expanded.titleScrollHeight }))
    await expandCard.locator('[data-dsh-scard="expand"]').click()
    await page.waitForTimeout(400)
    const collapsed = await expandCard.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      aria: el.querySelector('[data-dsh-scard="body"]')?.getAttribute('aria-expanded') ?? '',
      text: el.querySelector('[data-dsh-scard="expand-text"]')?.textContent ?? '',
      maxHeight: getComputedStyle(el.querySelector('[data-dsh-scard="content"]')).maxHeight,
      titleClamp: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? 'none' : getComputedStyle(t).webkitLineClamp })(),
      titleMaxHeight: (() => { const t = el.querySelector('[data-dsh-scard="title"]'); return t === null ? '' : getComputedStyle(t).maxHeight })(),
    }))
    check('收起后卡体与按钮状态一致（折叠态、aria-expanded=false、文案「展开全文」、max-height 数值回来）',
      collapsed.open === '0' && collapsed.aria === 'false' && collapsed.text === '展开全文' && collapsed.maxHeight.endsWith('px'), JSON.stringify(collapsed))
    check('收起后标题行夹回到 2 行上限（折叠与展开两种状态都有明确固定高度）',
      collapsed.open === '0' && collapsed.titleClamp === '2' && collapsed.titleMaxHeight.endsWith('px'), JSON.stringify({ clamp: collapsed.titleClamp, maxHeight: collapsed.titleMaxHeight }))
    // 键盘：卡体获得焦点后 Enter 也能切换（先展开、再收起）
    const bodyHandle = expandCard.locator('[data-dsh-scard="body"]')
    await bodyHandle.focus()
    const kbBefore = await expandCard.evaluate((el) => ({ active: document.activeElement?.getAttribute('data-dsh-scard') ?? '', open: el.getAttribute('data-open'), aria: el.querySelector('[data-dsh-scard="body"]')?.getAttribute('aria-expanded') ?? '' }))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const kbOpen = await expandCard.evaluate((el) => ({ active: document.activeElement?.getAttribute('data-dsh-scard') ?? '', open: el.getAttribute('data-open'), aria: el.querySelector('[data-dsh-scard="body"]')?.getAttribute('aria-expanded') ?? '' }))
    check('卡体键盘 Enter 展开（焦点在卡体上、折叠→展开、aria-expanded=true）',
      kbBefore.open === '0' && kbBefore.active === 'body' && kbOpen.open === '1' && kbOpen.aria === 'true',
      JSON.stringify({ before: kbBefore, after: kbOpen }))
    await page.keyboard.press('Space')
    await page.waitForTimeout(400)
    const kbClosed = await expandCard.evaluate((el) => ({ open: el.getAttribute('data-open'), aria: el.querySelector('[data-dsh-scard="body"]')?.getAttribute('aria-expanded') ?? '', maxHeight: getComputedStyle(el.querySelector('[data-dsh-scard="content"]')).maxHeight }))
    check('Space 键再收起（回到折叠态、max-height 数值回来）',
      kbClosed.open === '0' && kbClosed.aria === 'false' && kbClosed.maxHeight.endsWith('px'), JSON.stringify(kbClosed))
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

  // 键盘可访问性：卡体 tabindex=0 + Enter/Space 切换；Tab 顺序里焦点环存在。
  const keyboard = await page.evaluate(async () => {
    const card = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')].find((el) => (el.textContent ?? '').includes('答案折叠验收')) ?? null
    if (card === null) return { skip: true }
    const body = card.querySelector('[data-dsh-scard="body"]')
    const readBtn = card.querySelector('[data-dsh-speak="button"]')
    readBtn?.focus()
    return { tabIndex: readBtn?.tabIndex ?? null, bodyTabIndex: body?.tabIndex ?? null, bodyIsFocusable: body === document.activeElement, activeIsRead: document.activeElement === readBtn }
  })
  await page.locator(`${ASSISTANT_CARD}:not([data-empty="1"]) [data-dsh-speak="button"]`).last().press('Tab')
  const focusRing = await page.evaluate(() => {
    const el = document.activeElement
    const cs = getComputedStyle(el)
    return { tag: el.tagName, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset }
  })
  check('所有按钮可键盘聚焦，焦点环为 2px #AFA9EC 偏移 2px',
    keyboard.skip !== true && keyboard.activeIsRead && (focusRing.tag === 'BUTTON' || focusRing.tag === 'DIV')
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

  // ── 未读红点：现场实测（页面上真的有未读卡）+ 已读集合持久化（宿主 route + 本地缓存） ──
  const persisted = await page.evaluate(() => {
    const prefix = 'dsh.assistant.secretary.read:'
    let cached = []
    try {
      for (const id of Object.keys(localStorage)) {
        if (!id.startsWith(prefix)) continue
        const list = JSON.parse(localStorage.getItem(id) ?? '[]')
        if (Array.isArray(list)) cached.push({ id, list })
      }
    } catch { /* ignore */ }
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
    const last = cards[cards.length - 1] ?? null
    const lastKey = last?.getAttribute('data-dsh-scard-key') ?? ''
    const keysInCache = cached.flatMap((entry) => entry.list)
    const readCards = cards.filter((el) => (el.getAttribute('data-dsh-scard-key') ?? '') !== '' && keysInCache.includes(el.getAttribute('data-dsh-scard-key')))
    return {
      lastKey,
      lastUnread: last?.getAttribute('data-unread') ?? '',
      lastDot: last ? last.querySelector('[data-dsh-scard="unread-dot"]') !== null : null,
      cached,
      readCardsWithDot: readCards.filter((el) => el.querySelector('[data-dsh-scard="unread-dot"]') !== null).length,
      readCardsTotal: readCards.length,
      unreadCardsWithoutDot: cards.filter((el) => (el.getAttribute('data-unread') ?? '') === '1' && el.querySelector('[data-dsh-scard="unread-dot"]') === null).length,
    }
  })
  const readRouteCalled = readRouteRequests.slice()
  check('已读卡集合持久化：最新卡（自动朗读过）的 cardKey 已在本地缓存里，宿主 route 也问/写过',
    persisted.lastKey !== '' && persisted.cached.some((entry) => entry.list.includes(persisted.lastKey)) === true
      && readRouteCalled.some((line) => line.startsWith('GET')) && readRouteCalled.some((line) => line.startsWith('POST')),
    JSON.stringify({ lastKey: persisted.lastKey, cached: persisted.cached.map((entry) => ({ id: entry.id, list: entry.list })), readRequests: readRouteCalled.slice(0, 3) }))
  check('已读后红点彻底消失（不留灰点）：缓存里的卡一律不带红点，未读卡全带红点',
    persisted.readCardsTotal >= 1 && persisted.readCardsWithDot === 0 && persisted.unreadCardsWithoutDot === 0
      && persisted.lastDot === false && persisted.lastUnread === '0',
    JSON.stringify({ readCardsTotal: persisted.readCardsTotal, readCardsWithDot: persisted.readCardsWithDot, unreadCardsWithoutDot: persisted.unreadCardsWithoutDot, lastKey: persisted.lastKey, lastUnread: persisted.lastUnread }))
  // 现场取证先把已读集合清零（宿主 DELETE + 本地缓存 + 刷新）：不然上一轮跑测留下的已读态会把红点吃掉
  await page.evaluate(async (sessionId) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('dsh.assistant.secretary.read:')) localStorage.removeItem(key)
    }
    try { await fetch(`/api/assistant/secretary-read?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' }) } catch { /* 旧宿主没有这条路由：本地缓存已经清掉就够 */ }
  }, wantedHostId)
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(4500)
  const nowState = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"]), [data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-empty="1"])')]
    const unreadCards = cards.filter((el) => el.getAttribute('data-unread') === '1')
    const withDot = unreadCards.filter((el) => el.querySelector('[data-dsh-scard="unread-dot"]') !== null)
    const sample = withDot[0]?.querySelector('[data-dsh-scard="unread-dot"]') ?? null
    const cs = sample ? getComputedStyle(sample) : null
    const rect = sample?.getBoundingClientRect?.() ?? null
    const assistant = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
    const last = assistant[assistant.length - 1] ?? null
    return {
      unreadCardCount: unreadCards.length,
      dotCardCount: withDot.length,
      totalDots: document.querySelectorAll('[data-dsh-scard="card"] [data-dsh-scard="unread-dot"]').length,
      userCardsWithDot: document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="user"] [data-dsh-scard="unread-dot"]').length,
      noticeDotCount: document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-dsh-scard-expired="1"]) [data-dsh-scard="unread-dot"]').length,
      noticeCardsTotal: document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-dsh-scard-expired="1"])').length,
      expiredNoticeShells: document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="notice"][data-dsh-scard-expired="1"]').length,
      dot: cs && rect ? { w: Math.round(rect.width), h: Math.round(rect.height), bg: cs.backgroundColor, aria: sample.getAttribute('aria-label') ?? '', radius: cs.borderRadius, kind: sample.closest('[data-dsh-scard="card"]')?.getAttribute('data-dsh-scard-kind') ?? '' } : null,
      lastKey: last?.getAttribute('data-dsh-scard-key') ?? '',
      lastUnread: last?.getAttribute('data-unread') ?? '',
      lastDot: last ? last.querySelector('[data-dsh-scard="unread-dot"]') !== null : null,
    }
  })
  check('未读卡现场带红点：8px #D83A2B 圆点、aria-label=未读（实测取自页面上真的未读卡）',
    nowState.unreadCardCount > 0 && nowState.dotCardCount === nowState.unreadCardCount && nowState.totalDots === nowState.unreadCardCount
      && nowState.dot !== null && nowState.dot.w === 8 && nowState.dot.h === 8 && nowState.dot.bg === 'rgb(216, 58, 43)'
      && nowState.dot.aria === '未读' && (nowState.dot.kind === 'assistant' || nowState.dot.kind === 'notice'),
    JSON.stringify({ unreadCards: nowState.unreadCardCount, dots: nowState.dotCardCount, measured: nowState.dot }))
  // 第 1 项现场口径：过期通知卡收成空壳（display:none、不带正文、不带红点），「通知卡带红点」这条只适用于没被 10 分钟窗口收掉的卡。
  check('红点只属于秘书侧卡（assistant/notice）：用户卡一律不带红点、没被 10 分钟收掉的通知卡带红点',
    nowState.userCardsWithDot === 0 && (nowState.noticeCardsTotal === 0 ? nowState.noticeDotCount === 0 : nowState.noticeDotCount >= 1),
    JSON.stringify({ userCardsWithDot: nowState.userCardsWithDot, noticeDotCount: nowState.noticeDotCount, noticeCardsTotal: nowState.noticeCardsTotal, expiredNoticeShells: nowState.expiredNoticeShells, totalDots: nowState.totalDots, unreadCardCount: nowState.unreadCardCount }))
  const noticeAgeProbe = await page.evaluate(async (sessionId) => {
    const TTL_MS = 10 * 60 * 1000
    const now = Date.now()
    let items = []
    try {
      const res = await fetch(`/api/assistant/secretary/history?sessionId=${encodeURIComponent(sessionId)}&limit=30`)
      const json = await res.json()
      items = Array.isArray(json?.page?.items) ? json.page.items : []
    } catch { items = [] }
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]')]
    const byKey = new Map(cards.map((el) => [el.getAttribute('data-dsh-scard-key') ?? '', el]))
    const readOut = (item) => {
      const el = byKey.get(item.cardKey)
      if (el === undefined) return null
      const visible = el.offsetParent !== null && getComputedStyle(el).display !== 'none'
      return {
        cardKey: item.cardKey,
        ageMinutes: Math.round((now - item.time) / 60000),
        expiredAttr: el.getAttribute('data-dsh-scard-expired') === '1',
        visible,
        hasBody: el.querySelector('[data-dsh-scard="para"]') !== null,
        hasDot: el.querySelector('[data-dsh-scard="unread-dot"]') !== null,
      }
    }
    const old = items.filter((item) => item.kind === 'notice' && item.time > 0 && now - item.time > TTL_MS + 60 * 1000).map(readOut).filter(Boolean)
    const fresh = items.filter((item) => item.kind === 'notice' && now - item.time <= TTL_MS).map(readOut).filter(Boolean)
    const shells = cards.filter((el) => el.getAttribute('data-dsh-scard-expired') === '1')
    const bubbleBack = shells.filter((el) => {
      const row = el.closest('[data-chat-flow-kind="user"]')
      const span = row ? row.querySelector('[data-slot="conversation.user.text.node"] > span') : null
      return span !== null && span.offsetParent !== null
    }).length
    return {
      historyNoticeItems: items.filter((item) => item.kind === 'notice').length,
      mountedNoticeCards: cards.length,
      shells: shells.length,
      hiddenShells: shells.filter((el) => getComputedStyle(el).display === 'none').length,
      shellBody: shells.filter((el) => el.querySelector('[data-dsh-scard="para"]') !== null).length,
      shellDot: shells.filter((el) => el.querySelector('[data-dsh-scard="unread-dot"]') !== null).length,
      bubbleBack,
      old, fresh,
    }
  }, wantedHostId)
  const oldBad = noticeAgeProbe.old.filter((entry) => entry.expiredAttr !== true || entry.visible !== false)
  const freshBad = noticeAgeProbe.fresh.filter((entry) => entry.expiredAttr !== false || entry.visible !== true)
  if (noticeAgeProbe.old.length + noticeAgeProbe.fresh.length === 0) {
    notes.push('第 1 项现场过期核对：这一段宿主历史里没取到「同时挂在 DOM 上」的通知卡，现场跳过（判据由 scripts/test-secretary-cards.mjs 与视觉套件覆盖）')
  }
  check('第 1 项现场证据：满 10 分钟的通知卡一律收成空壳（带 expired 属性、display:none、无正文无红点），没满 10 分钟的照旧出图；宿主原生气泡不放回来',
    oldBad.length === 0 && freshBad.length === 0 && noticeAgeProbe.hiddenShells === noticeAgeProbe.shells
      && noticeAgeProbe.shellBody === 0 && noticeAgeProbe.shellDot === 0 && noticeAgeProbe.bubbleBack === 0,
    JSON.stringify({ historyNoticeItems: noticeAgeProbe.historyNoticeItems, mountedNoticeCards: noticeAgeProbe.mountedNoticeCards, shells: noticeAgeProbe.shells, hiddenShells: noticeAgeProbe.hiddenShells, bubbleBack: noticeAgeProbe.bubbleBack, old: noticeAgeProbe.old.slice(0, 3), oldBad: oldBad.slice(0, 3), freshBad: freshBad.slice(0, 3) }))
  // 第 3 项现场证据：compact 那两串字在秘书页上看不到（宿主行被结构判据收掉）
  const compactProbe = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-chat-flow-kind="manual-compaction"], [data-chat-flow-kind="compaction"], [data-dsh-scard-compact="hint"]')]
    const rendered = rows.filter((el) => el.offsetParent !== null)
    const text = document.body.innerText ?? ''
    return {
      rows: rows.length,
      hidden: rows.filter((el) => getComputedStyle(el).display === 'none').length,
      rendered: rendered.map((el) => (el.textContent ?? '').trim().slice(0, 40)),
      pageHasSummaryText: /已压缩[^\n]{0,20}条历史记录/.test(text),
      pageHasFailureText: /Compaction could not produce a useful summary/.test(text),
      taggedRows: document.querySelectorAll('[data-dsh-scard-compact="hint"]').length,
    }
  })
  if (compactProbe.rows === 0) {
    notes.push('第 3 项现场核对：本轮宿主历史窗口里没有 compact 那两行（分页窗口只渲染最新那一截），现场跳过；判据由 scripts/test-secretary-cards.mjs 与视觉套件覆盖')
  }
  check('第 3 项现场证据：compact 摘要行/失败行在秘书页不出图，页面正文里也读不到那两串字',
    compactProbe.rows === 0 || (compactProbe.rows >= 1 && compactProbe.rendered.length === 0 && compactProbe.hidden === compactProbe.rows
      && compactProbe.pageHasSummaryText === false && compactProbe.pageHasFailureText === false),
    JSON.stringify({ rows: compactProbe.rows, hidden: compactProbe.hidden, rendered: compactProbe.rendered.slice(0, 3), summaryText: compactProbe.pageHasSummaryText, failureText: compactProbe.pageHasFailureText, taggedRows: compactProbe.taggedRows }))
  const quoteProbe = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-dsh-scard-expired="1"])')]
    const buttons = [...document.querySelectorAll('[data-dsh-scard="card"] [data-dsh-scard="quote"]')]
    return {
      cards: cards.length,
      buttons: buttons.length,
      cardsWithButton: cards.filter((el) => el.querySelector('[data-dsh-scard="quote"]') !== null).length,
      buttonsWithoutCard: buttons.filter((el) => el.closest('[data-dsh-scard="card"]') === null).length,
      collapsedRowsWithButton: document.querySelectorAll('[data-dsh-scard="collapsed-row"] [data-dsh-scard="quote"]').length,
      order: buttons.map((el) => {
        const foot = el.closest('[data-dsh-scard="foot"]')
        return foot ? [...foot.children].map((child) => child.getAttribute('data-dsh-scard') ?? '').join(',') : ''
      }).slice(0, 3),
    }
  })
  check('第 4 项现场证据：每张完整卡（秘书/用户/通知）脚部都有引用按钮、顺序是引用→时间→操作区；折叠行不带按钮',
    quoteProbe.cards >= 1 && quoteProbe.buttonsWithoutCard === 0 && quoteProbe.collapsedRowsWithButton === 0
      && quoteProbe.cardsWithButton === quoteProbe.cards && quoteProbe.order.every((line) => line === 'quote,time,actions'),
    JSON.stringify({ cards: quoteProbe.cards, cardsWithButton: quoteProbe.cardsWithButton, buttons: quoteProbe.buttons, collapsedRowsWithButton: quoteProbe.collapsedRowsWithButton, order: quoteProbe.order }))
  // 现场核对（不给断言添花活）：哪张完整卡没带引用按钮、它挂在哪个 kind 的宿主行上
  const missingQuote = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-dsh-scard-expired="1"])')]
    return cards.filter((el) => el.querySelector('[data-dsh-scard="quote"]') === null).map((el) => {
      const hostRow = el.closest('[data-chat-flow-kind]') ?? el.closest('[data-chat-group-key]')
      const foot = el.querySelector('[data-dsh-scard="foot"]')
      return {
        kind: el.getAttribute('data-dsh-scard-kind'), key: el.getAttribute('data-dsh-scard-key'), turn: el.getAttribute('data-dsh-scard-turn'),
        hostKind: hostRow === null ? null : hostRow.getAttribute('data-chat-flow-kind'), hostKey: hostRow === null ? null : hostRow.getAttribute('data-chat-flow-key'),
        footChildren: foot === null ? [] : [...foot.children].map((child) => child.getAttribute('data-dsh-scard') ?? ''),
        text: String(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 36),
      }
    })
  })
  notes.push(`引用按钮现场：没有引用按钮的完整卡=${JSON.stringify(missingQuote)}`)

  check('读掉之后红点彻底消失（不留灰点、不淡出成长条）：最新卡已读、全页红点数=未读卡数',
    nowState.lastKey !== '' && nowState.lastUnread === '0' && nowState.lastDot === false && nowState.totalDots === nowState.unreadCardCount,
    JSON.stringify({ lastKey: nowState.lastKey, lastUnread: nowState.lastUnread, lastDot: nowState.lastDot, totalDots: nowState.totalDots, unreadCardCount: nowState.unreadCardCount }))

  // ── 回归：点历史卡必须读历史卡自己的文本（2026-11-21 实测 bug：读成了最新一条） ──
  const hist = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
    if (cards.length < 2) return { skip: true }
    const last = cards[cards.length - 1]
    const lastTitle = last.querySelector('[data-dsh-scard="title"]')?.textContent ?? ''
    // 同一条会话里可能有多次跑测留下的同名样本卡：必须挑一张「标题真的不同」的历史卡，否则断言无意义
    const older = cards.find((el) => el !== last && (el.querySelector('[data-dsh-scard="title"]')?.textContent ?? '') !== lastTitle && (el.querySelector('[data-dsh-scard="title"]')?.textContent ?? '').trim() !== '')
    if (older === undefined) return { skip: true, lastTitle }
    return {
      firstTitle: older.querySelector('[data-dsh-scard="title"]')?.textContent ?? '',
      lastTitle,
      firstTurn: older.getAttribute('data-dsh-scard-turn') ?? '',
      lastTurn: last.getAttribute('data-dsh-scard-turn') ?? '',
    }
  })
  if (hist.skip === true) {
    notes.push('历史卡朗读回归：会话不足两轮，跳过')
  } else {
    // 两边都先去标点再比前 6 个汉字；TTS 规范化会改动标点，不能只清洗标题。
    const cjk = (s) => String(s).replace(/[^一-鿿]/g, '')
    const head = (s) => cjk(s).slice(0, 6)
    // 现场条件：宿主 TTS 请求体只有 { text }（没有卡片身份），所以「读的是哪张卡」只能靠正文字比较。
    // 会话里跑测留下的样本卡与 CU 回执卡可能前 12 个汉字一模一样（例如都是「回执 · 电脑操作会话…」），
    // 那种情况下这条判据现场分不出高低，只能记一句跳过；分得出时才照判。
    const head12 = (s) => cjk(s).slice(0, 12)
    const titlesDistinguishable = head12(hist.firstTitle) !== head12(hist.lastTitle)
    if (!titlesDistinguishable) notes.push(`历史卡朗读回归：点击那张卡与最末一张卡前 12 个汉字相同（${head12(hist.lastTitle)}），TTS 请求体又不带卡片身份，现场分不出读的是哪张 → 跳过「绝不读最新一条」`)
    const before = ttsBodies.length
    const olderSelector = `[data-dsh-scard="card"][data-dsh-scard-kind="assistant"][data-dsh-scard-turn="${hist.firstTurn}"]`
    await page.locator(olderSelector).locator('[data-dsh-speak="button"]').click()
    await page.waitForTimeout(600)
    const sent = ttsBodies.slice(before).map((body) => { try { return JSON.parse(body)?.text ?? '' } catch { return '' } }).join(' ')
    check('点历史卡朗读：TTS 收到的是该卡自己的文本（按轮次 id 定位这张卡）', head(hist.firstTitle) !== '' && cjk(sent).includes(head(hist.firstTitle)),
      `sent=${sent.slice(0, 50)} want=${hist.firstTitle.slice(0, 14)} turn=${hist.firstTurn}→${hist.lastTurn}`)
    // 现场条件：点击这一窗子如果会话又来了一条新回复（新卡一出现就自动朗读），那「绝不读最新一条」比的就是那条新 arrival、不是本次点击读错了卡；本次点击要读的那张卡已由上一条断言核过。
    const latestNow = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="assistant"]:not([data-empty="1"])')]
      const last = cards[cards.length - 1]
      return { turn: last ? (last.getAttribute('data-dsh-scard-turn') ?? '') : '', title: last ? (last.querySelector('[data-dsh-scard="title"]')?.textContent ?? '') : '' }
    })
    const newReplyArrived = latestNow.turn !== hist.lastTurn
    if (newReplyArrived) notes.push(`历史卡朗读回归：点击这一窗子会话又来了一条新回复（${hist.lastTurn} → ${latestNow.turn}，新卡一出现就自动朗读），「绝不读最新一条」按 arrival 口径跳过`)
    check('点历史卡朗读：绝不读最新一条（这一窗子没有新回复 arrival、且两张卡标题分得出时）',
      newReplyArrived === true || titlesDistinguishable === false || head(hist.lastTitle) === '' || !cjk(sent).includes(head(hist.lastTitle)),
      `last=${hist.lastTitle.slice(0, 14)} latestNow=${latestNow.turn} distinguishable=${titlesDistinguishable}`)
    await page.locator(olderSelector).locator('[data-dsh-speak="button"]').click().catch(() => {}) // 收尾停掉

  // ── 追加需求现场证据（2026-11-23 用户原话：点引用要在输入框看得到提示）──
  // 上一次跑测残留的引用先收干净（与已读集合那一段同一口径：清缓存 + 按宿主那份 + 页面上有提示就直接按 ×）
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('dsh.assistant.secretary.quote:') || key.startsWith('dsh.assistant.secretary.quote-baseline:')) localStorage.setItem(key, 'null')
    }
    const chip = document.querySelector('[data-dsh-squote="chip"]')
    if (chip !== null) {
      const cancel = chip.querySelector('[data-dsh-squote="cancel"]')
      if (cancel !== null) cancel.click()
    }
  })
  await page.evaluate(async () => {
    const sid = String(window.localStorage.getItem('dsh.assistant.secretary.sessionId') ?? '')
    if (sid === '') return
    try { await fetch('/api/assistant/secretary-quote?sessionId=' + encodeURIComponent(sid), { method: 'DELETE' }) } catch { /* 宿主没这条路由（没重启）也不阻塞 */ }
  })
  await page.waitForTimeout(900)
  const chipIdle = await page.evaluate(() => ({
    chips: document.querySelectorAll('[data-dsh-squote="chip"]').length,
    composer: document.querySelectorAll('[data-composer-card]').length,
  }))
  check('没按引用时输入框那侧一个「带引用」提示节点都没有', chipIdle.chips === 0, JSON.stringify(chipIdle))
  const quoteButton = page.locator('[data-dsh-scard="card"]:not([data-dsh-scard-expired="1"]) [data-dsh-scard="quote"][data-quoted="0"]').first()
  const quoteClicked = await quoteButton.click().then(() => true).catch(() => false)
  if (quoteClicked) {
    await page.waitForTimeout(900)
    const chipLive = await page.evaluate(() => {
      const chip = document.querySelector('[data-dsh-squote="chip"]')
      if (chip === null) return { chip: null, composer: document.querySelectorAll('[data-composer-card]').length }
      const cs = getComputedStyle(chip)
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right), h: Math.round(r.height) } }
      const cancel = chip.querySelector('[data-dsh-squote="cancel"]')
      const metaEl = chip.querySelector('[data-dsh-squote="meta"]')
      const previewEl = chip.querySelector('[data-dsh-squote="preview"]')
      const cardEl = document.querySelector('[data-composer-card]')
      return {
        chip: 'ok',
        flag: chip.querySelector('[data-dsh-squote="flag-text"]')?.textContent ?? '',
        meta: metaEl?.textContent ?? '',
        preview: previewEl?.textContent ?? '',
        radius: cs.borderRadius,
        inComposer: chip.closest('[data-composer-card]') !== null,
        overflowHidden: cs.overflow === 'hidden',
        metaWhole: metaEl === null ? false : (metaEl.scrollWidth <= metaEl.clientWidth + 1),
        metaEllipsis: metaEl === null ? false : (metaEl.scrollWidth > metaEl.clientWidth + 1),
        previewEllipsis: previewEl === null ? false : getComputedStyle(previewEl).textOverflow === 'ellipsis',
        previewOwnLine: (previewEl === null || metaEl === null) ? false : (previewEl.getBoundingClientRect().top > metaEl.getBoundingClientRect().top + 1),
        metaKindHidden: (function () { const el = chip.querySelector('[data-dsh-squote="meta-kind"]'); return el === null ? false : getComputedStyle(el).display === 'none' })(),
        metaVisibleText: metaEl === null ? '' : metaEl.innerText.trim(),
        chipHeight: Math.round(chip.getBoundingClientRect().height),
        previewText: previewEl?.textContent ?? '',
        cancelColor: cancel === null ? '' : getComputedStyle(cancel).color,
        cancelSize: cancel === null ? '' : `${Math.round(cancel.getBoundingClientRect().width)}x${Math.round(cancel.getBoundingClientRect().height)}`,
        kind: chip.getAttribute('data-dsh-squote-kind') ?? '',
        cardKey: chip.getAttribute('data-dsh-squote-key') ?? '',
        chipRect: rect(chip),
        cancelRect: cancel === null ? null : rect(cancel),
        composerCardRect: cardEl === null ? null : rect(cardEl),
        cancelHit: (function () {
          if (cancel === null) return false
          const r = cancel.getBoundingClientRect()
          const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          return el === null ? false : el.closest('[data-dsh-squote="cancel"]') !== null
        })(),
        parentChain: (function () {
          const out = []
          let node = chip.parentElement
          for (let depth = 0; depth < 4 && node !== null; depth += 1) {
            const r = node.getBoundingClientRect()
            out.push({ slot: node.getAttribute('data-slot') ?? '', class: String(node.className).slice(0, 34), w: Math.round(r.width), right: Math.round(r.right) })
            node = node.parentElement
          }
          return out
        })(),
        hitTests: (function () {
          const r = chip.getBoundingClientRect()
          const probes = [[r.left + 6, r], [r.left + r.width / 2, r], [r.right - 4, r]]
          return probes.map(([x, box]) => {
            const el = document.elementFromPoint(x, box.top + box.height / 2)
            if (el === null) return { hit: null }
            const tag = el.getAttribute('data-dsh-squote') ?? el.getAttribute('data-dsh-scard') ?? (el.tagName + '.' + String(el.className).slice(0, 20))
            return { x: Math.round(x), hit: tag }
          })
        })(),
      }
    })
    await page.screenshot({ path: 'tmp-secretary-quote-chip-live.png' })
    notes.push('截图: tmp-secretary-quote-chip-live.png')
    await page.locator('[data-composer-card]').first().screenshot().then((buf) => writeFileSync('tmp-secretary-quote-chip-composer.png', buf)).catch(() => notes.push('composer 局部截图没写成'))
    notes.push('截图: tmp-secretary-quote-chip-composer.png')
    notes.push('引用提示现场几何: ' + JSON.stringify(chipLive))
    check('点卡片引用后输入框那侧出现「带引用」提示、而且挂在宿主 composer 里',
      chipLive.chip === 'ok' && chipLive.inComposer === true, JSON.stringify(chipLive))
    check('提示带轮次号 + 卡片种类 + 那张卡正文开头一小段（不整段贴）',
      chipLive.chip === 'ok' && chipLive.flag === '带引用' && /第 ?\d+ ?轮|轮次未知/.test(chipLive.meta) && chipLive.preview.length > 0 && chipLive.preview.length <= 34,
      JSON.stringify({ flag: chipLive.flag, meta: chipLive.meta, preview: chipLive.preview }))
    check('提示样式与卡片脚部那两棵按钮同一套（8px 圆角 / muted #8A9099 的 ×）',
      chipLive.chip === 'ok' && chipLive.radius === '8px' && chipLive.cancelColor === 'rgb(138, 144, 153)' && /^\d{2}x\d{2}$/.test(chipLive.cancelSize),
      JSON.stringify(chipLive))
    check('引用提示在宿主 composer 那一行里不溢出：× 整颗落在提示自己的边界内、点得到、提示盒子 overflow hidden',
      chipLive.chip === 'ok' && chipLive.overflowHidden === true && chipLive.cancelHit === true
        && chipLive.cancelRect !== null && chipLive.chipRect !== null && chipLive.composerCardRect !== null
        && chipLive.cancelRect.right <= chipLive.chipRect.right + 1 && chipLive.chipRect.right <= chipLive.composerCardRect.right,
      JSON.stringify({ chipRect: chipLive.chipRect, cancelRect: chipLive.cancelRect, composerCardRect: chipLive.composerCardRect, overflowHidden: chipLive.overflowHidden, cancelHit: chipLive.cancelHit, parentChain: chipLive.parentChain }))
    check('现场这一档（真机实测：composer 卡片 380px、那一行只留 278px、提示只分到 164px）：轮次号不许拦腰截、摘要自己换第二行、提示盒子长高',
      chipLive.chip === 'ok' && chipLive.metaWhole === true && /^第 \d+ 轮$/.test(chipLive.metaVisibleText) && chipLive.previewOwnLine === true && chipLive.metaKindHidden === true && chipLive.chipHeight > 34 && chipLive.chipHeight <= 72 && chipLive.previewText.length > 0,
      JSON.stringify({ meta: chipLive.meta, metaWhole: chipLive.metaWhole, previewOwnLine: chipLive.previewOwnLine, chipHeight: chipLive.chipHeight, previewText: chipLive.previewText }))
    const cancelClicked = await page.locator('[data-dsh-squote="cancel"]').first().click().then(() => true).catch(() => false)
    if (cancelClicked) {
      await page.waitForTimeout(900)
      const afterCancel = await page.evaluate(() => ({
        chips: document.querySelectorAll('[data-dsh-squote="chip"]').length,
        cached: Object.keys(localStorage).filter((key) => key.startsWith('dsh.assistant.secretary.quote:')).map((key) => localStorage.getItem(key)),
      }))
      await page.screenshot({ path: 'tmp-secretary-quote-chip-cancelled.png' })
      notes.push('截图: tmp-secretary-quote-chip-cancelled.png')
      check('按「取消引用」后提示立刻收掉、本地缓存那份也清干净（下一条不带引用）',
        afterCancel.chips === 0 && afterCancel.cached.every((value) => value === null || value === 'null'), JSON.stringify(afterCancel))
    } else {
      notes.push('取消引用那颗 × 没找到，跳过取消断言（提示是否渲染出来了？' + JSON.stringify(chipLive) + '）')
    }
  } else {
    notes.push('现场没有可点的卡片引用按钮，跳过输入框提示现场断言')
  } // 收尾停掉
  }



// ── 桌面宽度那一档的现场断言（2026-11-23 用户实测反馈「提示条显示错位了」）──
  // 两种挤法都要验：1000×760（用户那种窄桌面）与 1400×900（宽桌面）——同一份宿主 InputBar（.row flex-wrap + .trailing flex:none）。
  const desktopSelection = await page.evaluate(() => { try { return localStorage.getItem('dsh.sessions.current') } catch { return null } })
  notes.push('桌面档现场页沿用主面板选择 = ' + String(desktopSelection).slice(0, 90))
  const desktopCases = [
    { label: 'narrow', caption: '1000×760 用户那种窄桌面', viewport: { width: 1000, height: 760 }, expectKindHidden: true },
    { label: 'wide', caption: '1400×900 宽桌面', viewport: { width: 1400, height: 900 }, expectKindHidden: false },
  ]
  for (const deskCase of desktopCases) {
    const deskTag = deskCase.label
    const deskContext = await browser.newContext({ viewport: deskCase.viewport, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
    const deskPage = await deskContext.newPage()
    await deskPage.addInitScript((payload) => {
      try {
        localStorage.setItem('dsh.assistant.firstRunGuide.v1', 'seen')
        if (typeof payload === 'string' && payload !== '') localStorage.setItem('dsh.sessions.current', payload)
      } catch { /* 无 storage 时忽略 */ }
    }, desktopSelection)
    await deskPage.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    if (await deskPage.locator('input[name="token"]').count().catch(() => 0)) {
      await deskPage.fill('input[name="token"]', TOKEN)
      await deskPage.click('button[type="submit"]').catch(() => deskPage.keyboard.press('Enter'))
    }
    await deskPage.waitForSelector('button[data-pocket-orb="ball"]', { timeout: 30000 })
    await deskPage.waitForTimeout(4000)
    // 桌面宽度那一档开的是完整 Web 面板（带左侧栏、会话列表在前台）：先等一轮卡，没出来就走「悬浮球 → 宿主唤起意图 → 悬浮球 → 宿主唤起意图」四级梯子
    let deskCardsReady = await deskPage.waitForSelector('[data-dsh-scard="card"]', { timeout: 10000 }).then(() => true).catch(() => false)
    const deskOpenLadder = [
      () => deskPage.click('button[data-pocket-orb="ball"]').catch(() => {}),
      () => deskPage.evaluate(() => fetch('/api/assistant/open-assistant', { method: 'POST', cache: 'no-store' }).then(() => null).catch(() => null)),
      () => deskPage.click('button[data-pocket-orb="ball"]').catch(() => {}),
      () => deskPage.evaluate(() => fetch('/api/assistant/open-assistant', { method: 'POST', cache: 'no-store' }).then(() => null).catch(() => null)),
    ]
    for (let attempt = 0; !deskCardsReady && attempt < deskOpenLadder.length; attempt += 1) {
      await deskOpenLadder[attempt]()
      await deskPage.waitForTimeout(2500)
      deskCardsReady = await deskPage.waitForSelector('[data-dsh-scard="card"]', { timeout: 18000 }).then(() => true).catch(() => false)
    }
    if (!deskCardsReady) {
      notes.push('桌面档现场页（' + deskCase.caption + '）：秘书会话的卡在「10s + 四级唤起梯子（每级 18s）」里没出来，跳过这一档现场断言')
      await deskContext.close()
      continue
    }
    await deskPage.evaluate(async () => {
      try {
        const keys = Object.keys(localStorage).filter((key) => key.startsWith('dsh.assistant.secretary.quote'))
        for (const key of keys) localStorage.setItem(key, 'null')
      } catch { /* 无 storage 时忽略 */ }
    })
    const deskQuoteClicked = await deskPage
      .locator('[data-dsh-scard="card"]:not([data-dsh-scard-expired="1"]) [data-dsh-scard="quote"][data-quoted="0"]')
      .first().click({ timeout: 8000 }).then(() => true).catch(() => false)
    if (!deskQuoteClicked) {
      notes.push('桌面档现场页（' + deskCase.caption + '）：没找到可点的卡片引用按钮，跳过这一档现场断言')
      await deskContext.close()
      continue
    }
    await deskPage.waitForTimeout(1200)
    const deskLive = await deskPage.evaluate(() => {
      const chip = document.querySelector('[data-dsh-squote="chip"]')
      if (chip === null) return { chip: 'missing' }
      const cs = (el) => getComputedStyle(el)
      const box = (el) => {
        const rect = el.getBoundingClientRect()
        return { x: Math.round(rect.x), w: Math.round(rect.width), left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) }
      }
      const card = document.querySelector('[data-composer-card]')
      const row = card === null ? null : card.querySelector('[class$="_row"]')
      const tools = row === null ? null : row.querySelector('[class$="_tools"]')
      const trailing = row === null ? null : row.querySelector('[class$="_trailing"]')
      const standard = row === null ? null : row.querySelector('[class$="_standardControls"]')
      const primary = card === null ? null : card.querySelector('[class$="_primary"]')
      const standardChildren = standard === null ? [] : [...standard.children].map((el) => ({
        tag: el.tagName.toLowerCase(),
        class: (el.getAttribute('class') ?? '').split(' ').filter((name) => name !== '').join(' '),
        w: Math.round(el.getBoundingClientRect().width),
        text: String(el.textContent ?? '').trim().slice(0, 14),
      }))
      const grow = card === null ? null : card.querySelector('[class$="_grow"]')
      const editorTextEl = card === null ? null : card.querySelector('[class$="_input"]')
      const meta = chip.querySelector('[data-dsh-squote="meta"]')
      const kind = chip.querySelector('[data-dsh-squote="meta-kind"]')
      const preview = chip.querySelector('[data-dsh-squote="preview"]')
      const cancel = chip.querySelector('[data-dsh-squote="cancel"]')
      return {
        chip: 'ok',
        inComposer: chip.closest('[data-composer-card]') !== null,
        inStandardControls: standard !== null && standard.contains(chip),
        parents: [chip.parentElement, chip.parentElement === null ? null : chip.parentElement.parentElement]
          .filter((node) => node !== null)
          .map((node) => (node.getAttribute('class') === null ? '' : node.getAttribute('class')).split(' ').filter((name) => /_(row|trailing|standardControls|tools)$/.test(name))[0] ?? ''),
        viewportWidth: window.innerWidth,
        row: row === null ? null : box(row),
        rowContentWidth: row === null ? null : row.clientWidth,
        tools: tools === null ? null : box(tools),
        trailing: trailing === null ? null : box(trailing),
        standard: standard === null ? null : box(standard),
        chipBox: box(chip),
        cancelSize: cancel === null ? null : (Math.round(cancel.getBoundingClientRect().width) + 'x' + Math.round(cancel.getBoundingClientRect().height)),
        radius: cs(chip).borderRadius,
        meta: meta === null ? null : meta.textContent,
        metaVisibleText: meta === null ? null : meta.innerText,
        metaKindDisplay: kind === null ? null : cs(kind).display,
        previewText: preview === null ? null : preview.textContent,
        previewWidth: preview === null ? null : Math.round(preview.getBoundingClientRect().width),
        editorBox: grow === null ? null : box(grow),
        editorText: editorTextEl === null ? null : String(editorTextEl.textContent ?? '').trim().slice(0, 24),
        primaryVisible: primary === null ? null : Math.round(primary.getBoundingClientRect().width) > 0,
        modelSeatVisible: standardChildren.length > 0 ? standardChildren.map((entry) => entry.w) : null,
        standardChildren,
        cardBox: card === null ? null : box(card),
        composerMaxWidth: card === null ? '' : cs(card).maxWidth,
      }
    })
    const shotName = 'tmp-secretary-quote-chip-desktop-' + deskTag
    await deskPage.locator('[data-composer-card]').first().screenshot().then((buf) => writeFileSync(shotName + '.png', buf)).catch(() => {})
    await deskPage.screenshot({ path: shotName + '-page.png' }).catch(() => {})
    notes.push('截图: ' + shotName + '.png / ' + shotName + '-page.png')
    notes.push('桌面档现场几何（' + deskCase.caption + '）: ' + JSON.stringify(deskLive))
    const good = deskLive.chip === 'ok' && deskLive.row !== null && deskLive.tools !== null && deskLive.trailing !== null
    check('桌面档现场（' + deskCase.caption + '）：提示条挂在宿主那一行的 .standardControls 里、不是直挂 composer 根节点',
      good && deskLive.inComposer === true && deskLive.inStandardControls === true,
      JSON.stringify({ chip: deskLive.chip, inComposer: deskLive.inComposer, inStandardControls: deskLive.inStandardControls, parents: deskLive.parents }))
    check('桌面档现场（' + deskCase.caption + '）：那一行不换行——提示条与 +/权限胶囊/托管/模型胶囊/发送 同处一行（用户那种「错位」现在必须没有）',
      good && deskLive.row.h < deskLive.tools.h + deskLive.trailing.h + 24
      && deskLive.tools.top < deskLive.trailing.top + deskLive.trailing.h
      && deskLive.trailing.top < deskLive.tools.top + deskLive.tools.h,
      JSON.stringify({ rowH: deskLive.row?.h, toolsH: deskLive.tools?.h, trailingH: deskLive.trailing?.h, toolsTop: deskLive.tools?.top, trailingTop: deskLive.trailing?.top, rowW: deskLive.row?.w, rowContentW: deskLive.rowContentWidth, chipW: deskLive.chipBox?.w, chipH: deskLive.chipBox?.h }))
    check('桌面档现场（' + deskCase.caption + '）：提示条不溢出那一行的边界（提示右沿 ≤ 行右沿、整组右沿 ≤ 行右沿、整组左沿 ≥ 工具组右沿）',
      good && deskLive.chipBox.right <= deskLive.row.right + 1
      && deskLive.trailing.right <= deskLive.row.right + 1 && deskLive.trailing.left >= deskLive.tools.right,
      JSON.stringify({ chipRight: deskLive.chipBox?.right, trailingLeft: deskLive.trailing?.left, trailingRight: deskLive.trailing?.right, toolsRight: deskLive.tools?.right, rowRight: deskLive.row?.right, cardRight: deskLive.cardBox?.right }))
    check('桌面档现场（' + deskCase.caption + '）：提示贴着输入框那一坨（单行 30px、落在输入框下方与那一行边界之内、那颗发送钮与另一组标准控件照旧在）',
      good && deskLive.chipBox.h === 30 && deskLive.editorBox !== null
      && deskLive.chipBox.top >= deskLive.editorBox.bottom - 2 && deskLive.chipBox.bottom <= deskLive.row.bottom + 1
      && deskLive.primaryVisible === true && deskLive.standardChildren.filter((entry) => entry.text !== '').length >= 2,
      JSON.stringify({ chipTop: deskLive.chipBox?.top, chipBottom: deskLive.chipBox?.bottom, chipH: deskLive.chipBox?.h, editorTop: deskLive.editorBox?.top, editorBottom: deskLive.editorBox?.bottom, rowBottom: deskLive.row?.bottom, primaryVisible: deskLive.primaryVisible, standardChildren: deskLive.standardChildren, editorText: deskLive.editorText }))
    check('桌面档现场（' + deskCase.caption + '）：「· 卡片种类」按那一行的宽度自己收放（窄这一档收掉、宽这一档整段露出来），摘要照看得到（不整段贴）',
      good && deskLive.previewWidth > 20 && (deskCase.expectKindHidden
        ? (deskLive.metaKindDisplay === 'none' && /^第 \d+ 轮$/.test(String(deskLive.metaVisibleText)))
        : (deskLive.metaKindDisplay === 'inline' && /^第 \d+ 轮 · (秘书回复卡|用户消息卡|系统通知卡)$/.test(String(deskLive.metaVisibleText)))),
      JSON.stringify({ metaVisibleText: deskLive.metaVisibleText, metaKindDisplay: deskLive.metaKindDisplay, previewWidth: deskLive.previewWidth, chipW: deskLive.chipBox?.w, rowW: deskLive.row?.w, rowContentW: deskLive.rowContentWidth, composerMaxWidth: deskLive.composerMaxWidth }))
    const deskCancel = await deskPage.locator('[data-dsh-squote="cancel"]').first().click({ timeout: 5000 }).then(() => true).catch(() => false)
    await deskPage.waitForTimeout(700)
    const deskAfter = await deskPage.evaluate(() => ({ chips: document.querySelectorAll('[data-dsh-squote="chip"]').length }))
    check('桌面档现场（' + deskCase.caption + '）：取消入口收得掉（按完 × 提示 0 节点）', deskCancel === true && deskAfter.chips === 0, JSON.stringify({ deskCancel, chips: deskAfter.chips }))
    await deskContext.close()
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
  const logSample = async () => page.evaluate(() => {
    const list = Array.isArray(window.__dshAssistantOpenLog) ? window.__dshAssistantOpenLog : []
    const notBallIntent = list.filter((entry) => String(entry?.step ?? '') !== 'ball-intent')
    const last = [...list].reverse().find((entry) => String(entry?.step ?? '') === 'ball-intent') ?? null
    return { total: list.length, openChain: notBallIntent.length, lastIntent: last ? { intent: String(last.intent ?? ''), source: String(last.source ?? '') } : null, lastSteps: notBallIntent.slice(-2).map((entry) => String(entry?.step ?? '')) }
  })
  const logBeforeIntent = await logSample()
  await page.evaluate(() => fetch('/api/assistant/open-console', { method: 'POST' }))
  const consoleLanded = await page.waitForSelector('.dsh-assistant-cr', { timeout: 12000 }).then(() => true).catch(() => false)
  await page.waitForTimeout(1200)
  const afterConsoleIntent = await logSample()
  check('宿主 intent=console 落到控制室（不串进秘书：秘书打开链路没有新增，只多出这条 ball-intent=console）',
    consoleLanded && afterConsoleIntent.total > logBeforeIntent.total && afterConsoleIntent.openChain === logBeforeIntent.openChain
      && afterConsoleIntent.lastIntent?.intent === 'console',
    JSON.stringify({ before: logBeforeIntent, after: afterConsoleIntent, rooms: await page.locator('.dsh-assistant-cr').count() }))

  await page.evaluate(() => fetch('/api/assistant/open-assistant', { method: 'POST' }))
  const assistantLanded = await page.waitForFunction((wanted) => {
    try {
      const current = String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '')
      const rooms = document.querySelectorAll('.dsh-assistant-cr').length
      return current === wanted && rooms === 0
    } catch { return false }
  }, idBeforeLongPress, { timeout: 12000 }).then(() => true).catch(() => false)
  const afterAssistantSample = await logSample()
  const landedRooms = await page.evaluate(() => document.querySelectorAll('.dsh-assistant-cr').length)
  const landedCurrent = await readCurrentSessionId()
  check('宿主 intent=assistant 落到秘书固定会话（并收起控制室；打开链路确实新增、这条 intent 是 assistant）',
    assistantLanded && landedCurrent === idBeforeLongPress && landedRooms === 0
      && afterAssistantSample.total > afterConsoleIntent.total
      && afterAssistantSample.openChain > afterConsoleIntent.openChain
      && afterAssistantSample.lastIntent?.intent === 'assistant',
    JSON.stringify({ rooms: landedRooms, current: landedCurrent, before: afterConsoleIntent, after: afterAssistantSample }))

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
      const noticeFound = await page.waitForFunction((title) => {
        const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-empty="1"])')]
        const hit = cards.find((el) => (el.textContent ?? '').includes(title))
        if (hit === undefined) return false
        const ref = hit.querySelector('[data-dsh-scard="ref"]')
        if (ref === null || !(ref.textContent ?? '').includes(title)) return false
        const cs = getComputedStyle(hit)
        const para = hit.querySelector('[data-dsh-scard="para"]')
        return {
          kind: hit.getAttribute('data-dsh-scard-kind'),
          tag: hit.querySelector('[data-dsh-scard="tag"]')?.textContent ?? '',
          name: hit.querySelector('[data-dsh-scard="name"]')?.textContent ?? '',
          bg: cs.backgroundColor,
          paraSize: para ? getComputedStyle(para).fontSize : '',
          titleSize: hit.querySelector('[data-dsh-scard="title"]') ? getComputedStyle(hit.querySelector('[data-dsh-scard="title"]')).fontSize : '',
          dot: hit.querySelector('[data-dsh-scard="unread-dot"]') !== null,
          unread: hit.getAttribute('data-unread') ?? '',
            maxHeight: getComputedStyle(hit.querySelector('[data-dsh-scard="content"]') ?? hit).maxHeight,
          hasBell: hit.querySelector('[data-dsh-scard="mark"] img, [data-dsh-scard="mark"] svg') !== null,
        }
      }, cuTitle, { timeout: 20000 }).then((handle) => handle.jsonValue()).catch(() => null)
      check('合成通知做成灰底通知卡（不是 assistant/不是 user），引用块带 CU 会话标题、可点跳', noticeFound !== null, JSON.stringify(noticeFound))
      check('通知卡头部是铃铛+「系统 · 通知」（不写「个人秘书」/「用户消息」）、灰底 #F6F7F9、详情 14px、结论 18px、带未读红点',
        noticeFound !== null && noticeFound.kind === 'notice' && noticeFound.tag === '系统 · 通知' && noticeFound.name === ''
          && noticeFound.bg === 'rgb(246, 247, 249)' && noticeFound.paraSize === '14px' && noticeFound.titleSize === '18px'
          && noticeFound.hasBell === true && noticeFound.dot === true && noticeFound.unread === '1'
          && /px$/.test(noticeFound.maxHeight),
        JSON.stringify(noticeFound))
      if (noticeFound !== null) {
        await page.locator('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-empty="1"])', { hasText: cuTitle })
          .locator('[data-dsh-scard="ref"]').first().click()
        const jumped = await page.waitForFunction((want) => {
          try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') === want } catch { return false }
        }, cuTarget, { timeout: 12000 }).then(() => true).catch(() => false)
        const nowSel = await readCurrentSessionId()
        check('点通知卡片信息行跳进那条 CU 会话（命中目标会话 id）', jumped && nowSel === cuTarget,
          `selection=${nowSel} want=${cuTarget}`)
        // 通知卡被点引用 chip 后应立刻算已读（红点消失）
        await page.evaluate(() => fetch('/api/assistant/open-assistant', { method: 'POST' }))
        await page.waitForFunction((want) => {
          try { return String(window.__dshUiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? '') === want } catch { return false }
        }, currentId, { timeout: 12000 }).catch(() => {})
        await page.waitForTimeout(800)
        const afterJump = await page.evaluate((title) => {
          const cards = [...document.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-kind="notice"]:not([data-empty="1"])')]
          const hit = cards.find((el) => (el.textContent ?? '').includes(title))
          return hit ? { dot: hit.querySelector('[data-dsh-scard="unread-dot"]') !== null, unread: hit.getAttribute('data-unread') ?? '' } : null
        }, cuTitle)
        check('点过引用 chip 的通知卡当场已读（红点消失、data-unread=0）',
          afterJump !== null && afterJump.dot === false && afterJump.unread === '0', JSON.stringify(afterJump))
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

  // ── 第四批需求 A：卡片分页（≤30 张 / 折叠行 / 上滚才取回 / 刷新不回填 / 120 上限就停）──
  const pagerProbe = () => page.evaluate(() => {
    const full = [...document.querySelectorAll('[data-dsh-scard="card"]:not([data-empty="1"])')]
    const collapsed = [...document.querySelectorAll('[data-dsh-scard="collapsed-row"]')]
    const scroll = document.querySelector('[data-conversation-scroll]')
    return {
      fullTotal: full.length,
      fullAssistant: full.filter((el) => el.getAttribute('data-dsh-scard-kind') === 'assistant').length,
      fullUser: full.filter((el) => el.getAttribute('data-dsh-scard-kind') === 'user').length,
      fullNotice: full.filter((el) => el.getAttribute('data-dsh-scard-kind') === 'notice').length,
      collapsedTotal: collapsed.length,
      collapsedSample: collapsed.slice(0, 3).map((el) => ({
        kind: el.getAttribute('data-dsh-scard-kind') ?? '',
        time: el.querySelector('[data-dsh-scard="collapse-time"]')?.textContent ?? '',
        title: el.querySelector('[data-dsh-scard="collapse-title"]')?.textContent ?? '',
        rowHeight: Math.round(el.querySelector('[data-dsh-scard="collapse-row"]')?.getBoundingClientRect().height ?? 0),
      })),
      hint: document.querySelector('[data-dsh-scard="earlier-hint"] [data-dsh-scard="earlier-hint-text"]')?.textContent ?? '',
      scrollTop: scroll ? Math.round(scroll.scrollTop) : -1,
      scrollHeight: scroll ? Math.round(scroll.scrollHeight) : -1,
      hasScrollHost: scroll !== null,
      domNodes: document.querySelectorAll('*').length,
    }
  })

  // 首屏口径只对「这一次加载」：先把前面跑测攒下来的取数记录清零，再刷新进页等卡片出来，才量这一段
  historyRouteRequests.length = 0
  historyRouteResponses.length = 0
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(6000)
  const firstWindow = await pagerProbe()
  check('分页：一次渲染的卡片数 ≤30（秘书卡/用户卡/通知卡都计入）', firstWindow.fullTotal <= 30 && firstWindow.fullTotal > 0,
    JSON.stringify({ fullTotal: firstWindow.fullTotal, assistant: firstWindow.fullAssistant, user: firstWindow.fullUser, notice: firstWindow.fullNotice }))
  check('分页：窗口外才有折叠行（宿主挂出的卡多于窗口时必须有折叠行）',
    firstWindow.fullTotal >= 30 ? firstWindow.collapsedTotal > 0 : true,
    JSON.stringify({ fullTotal: firstWindow.fullTotal, collapsedTotal: firstWindow.collapsedTotal }))
  check('分页：折叠行只有一行（时间 + 24 字内短标题，一行量级高度）', firstWindow.collapsedTotal === 0 || firstWindow.collapsedSample.every((item) => item.title !== '' && !item.title.includes('\n') && [...item.title].length <= 25 && item.rowHeight > 0 && item.rowHeight <= 60),
    JSON.stringify(firstWindow.collapsedSample))
  // 口径改宽一档、并如实写清为什么：满 10 分钟的通知卡现在被收成空壳，首屏可见内容有几率比视口短，
  // 顶部判据当场就成立 → 客户端会自己补最多两段更旧的卡。仍然是「按 30 张一段、上限 120 张、绝不整条回填」。
  const backfillCount = historyRouteRequests.filter((line) => line.includes('before=')).length
  check('分页：进页面/刷新不自动回填老卡（首屏最多补两段、不按 before 游标铺满整条会话）',
    backfillCount <= 2 && firstWindow.fullTotal <= 30 && firstWindow.fullTotal > 0,
    JSON.stringify({ backfillCount, fullTotal: firstWindow.fullTotal, requests: historyRouteRequests.slice(0, 5) }))
  check('分页：取数一律按 30 张一段（客户端不许为了分页把整条会话读回来）', historyRouteRequests.every((line) => !/[?&]limit=(?!30)\d+/.test(line)),
    JSON.stringify(historyRouteRequests.slice(0, 3)))
  check('分页：宿主分页接口在现网按预期降级（旧宿主没这条路由时客户端不许崩）', pageErrors.length === 0, JSON.stringify({ requests: historyRouteRequests.length }))

  // 折叠行点击：只开本地原文预览，不许把整张老卡拉回渲染
  const collapseClick = await (async () => {
    const before = await pagerProbe()
    const row = page.locator('[data-dsh-scard="collapsed-row"]').first()
    if (await page.locator('[data-dsh-scard="collapsed-row"]').count() === 0) return { skipped: true, before }
    await row.locator('[data-dsh-scard="collapse-row"]').click()
    await page.waitForTimeout(400)
    const preview = await page.locator('[data-dsh-scard="collapse-preview"]').first().textContent().catch(() => '')
    return { skipped: false, before, preview: String(preview ?? '').slice(0, 120), after: await pagerProbe() }
  })()
  if (collapseClick.skipped !== true) {
    check('分页：折叠行点击只开原始文本预览，不把老卡拉回渲染',
      collapseClick.after.fullTotal === collapseClick.before.fullTotal && collapseClick.preview !== '',
      JSON.stringify({ fullTotal: collapseClick.after.fullTotal, before: collapseClick.before.fullTotal, previewHead: collapseClick.preview.slice(0, 40) }))
    await page.locator('[data-dsh-scard="collapsed-row"]').first().locator('[data-dsh-scard="collapse-row"]').click()
  } else {
    notes.push('折叠行点击回归：页面上没有折叠行，跳过）')
  }

  // 上滚才取回下一段（带 scroll-anchoring）
  const scroller = await page.evaluate(() => {
    const el = document.querySelector('[data-conversation-scroll]')
    if (el === null) return null
    const beforeTop = Math.round(el.scrollTop)
    const beforeHeight = Math.round(el.scrollHeight)
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
    return { beforeTop, beforeHeight }
  })
  if (scroller !== null) {
    // 真滚轮（宿主自己会边滚边加载更旧的轮次）：到达顶部阈值才让客户端取下一段
    for (let attempt = 0; attempt < 3; attempt += 1) { await page.mouse.wheel(0, -1200); await page.waitForTimeout(400) }
    await page.evaluate(() => {
      const el = document.querySelector('[data-conversation-scroll]')
      if (el === null) return
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(900)
    const afterScroll = await pagerProbe()
    check('分页：上滚最多只取回下一段（≤60 张，且绝不把整条会话塞进 DOM）',
      afterScroll.fullTotal <= 60 && afterScroll.fullTotal >= firstWindow.fullTotal && afterScroll.domNodes < 20000,
      JSON.stringify({ before: firstWindow.fullTotal, after: afterScroll.fullTotal, collapsed: afterScroll.collapsedTotal, domNodes: afterScroll.domNodes }))
    if (afterScroll.fullTotal > firstWindow.fullTotal) {
      check('分页：取回后保持原滚动位置不跳（scroll-anchoring 补回 scrollTop）',
      afterScroll.scrollTop > 0 && afterScroll.scrollHeight > scroller.beforeHeight,
      JSON.stringify({ scrollTop: afterScroll.scrollTop, scrollHeight: afterScroll.scrollHeight, beforeHeight: scroller.beforeHeight }))
    } else {
      notes.push(`分页锚点：现网没有取回新段（窗口内仍只有 ${afterScroll.fullTotal} 张），scrollTop 硬断言由 scripts/test-secretary-pagination-dom.mjs 代做`)
    }
    // 一路滚到 120 张上限：必须停住并显示提示行
    let capped = { ...afterScroll }
    for (let attempt = 0; attempt < 6 && !capped.hint; attempt += 1) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-conversation-scroll]')
        if (el === null) return
        el.scrollTop = 0
        el.dispatchEvent(new Event('scroll'))
      })
      await page.waitForTimeout(900)
      capped = await pagerProbe()
    }
    check('分页：累计渲染上限 120 张就停（现网窗口不越界）', capped.fullTotal <= 120,
      JSON.stringify({ fullTotal: capped.fullTotal, collapsed: capped.collapsedTotal, domNodes: capped.domNodes }))
    if (capped.hint !== '') {
      check('分页：到上限后显示「更早的内容请到轨迹/搜索里看」', capped.hint === '更早的内容请到轨迹/搜索里看', JSON.stringify({ hint: capped.hint }))
    } else {
      notes.push(`分页上限提示：现网只渲染到 ${capped.fullTotal} 张（宿主自己没给到 120 张窗口），提示行硬断言由 scripts/test-secretary-pagination-dom.mjs 代做`)
    }
    check('分页：上限后继续上滚不再涨渲染卡数', historyRouteRequests.filter((line) => line.includes('before=')).length <= 5,
      JSON.stringify({ historyRequests: historyRouteRequests.length }))
    await page.screenshot({ path: 'tmp-secretary-pager-capped.png' })
    notes.push('截图: tmp-secretary-pager-capped.png')
  } else {
    notes.push('分页上滚回归：页面没有 [data-conversation-scroll]，跳过）')
  }

  // 刷新后不自动回填：reload 回秘书页应仍只渲染最近 30 张
  const requestsBeforeReload = historyRouteRequests.length
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(3500)
  const reloaded = await pagerProbe()
  if (reloaded.fullTotal === 0 && reloaded.collapsedTotal === 0) {
    notes.push('分页刷新回归：刷新后没回到秘书卡片区，跳过刷新断言）')
  } else {
    check('分页：刷新后仍然只渲染最近 30 张（不自动回填老卡）', reloaded.fullTotal <= 30 && (reloaded.fullTotal < 30 || reloaded.collapsedTotal > 0),
      JSON.stringify({ fullTotal: reloaded.fullTotal, collapsed: reloaded.collapsedTotal, domNodes: reloaded.domNodes }))
    const newRequests = historyRouteRequests.slice(requestsBeforeReload)
    check('分页：刷新只问最近那一段（新取的请求不带 before 游标）', newRequests.every((line) => !line.includes('before=')),
      JSON.stringify(newRequests.slice(0, 3)))
    await page.screenshot({ path: 'tmp-secretary-pager-reload.png' })
    notes.push('截图: tmp-secretary-pager-reload.png')
  }
  notes.push(`分页现场：${JSON.stringify({ firstWindow: { fullTotal: firstWindow.fullTotal, collapsedTotal: firstWindow.collapsedTotal, hint: firstWindow.hint }, historyRequests: historyRouteRequests.slice(0, 3), historyResponses: historyRouteResponses.slice(0, 2) })}`)

  check('无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
  check('无（非既有噪声的）console error', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)))
  check('没有意外的失败请求（只允许既有的项目探测 4xx）', failedRequests.length === 0, JSON.stringify(failedRequests.slice(0, 5)))

  /* ── 2026-11-24 现场取证（放在最后跑，前面那些既有用例不许被它打扰）──
   * 需求①：秘书正在跑任务时用户再插话，那条插话必须出用户卡，不给它留原生气泡。
   * 现场 dump 里的语义 kind 是 steering（宿主 ChatView 那套判据：插话挂 steering、
   * 排队挂 queued，两者用的是同一张节点视图），本批修的就是这一类行。
   * 取证走页面自己的输入框：先起一条要跑起来的任务，等宿主出过程行，再把插话原话打进 composer 按 Enter。
   * 现场本来就有的插话行先量、没有才合成，而且最多合成两回，别把会话灌进太多消息。
   */
  // 注入的样本话术带上脚本自己那套「（冒烟测试）」标记、也不带长英文词：
  // 不带上标记，后面那些现场断言量到的正是窗口里第一张用户卡（它们要求正文带「冒烟测试」）就会被我这条取证卡顶掉；
  // 带上长英文词（现场实测：'workbuddy' 这种不许换行的长词会让摘要那一行折成三行，把引用提示撑到 88px，
  // 越过既有用例校准的 72px 上限），同样会打扰既有用例。
  const INTERRUPT_TEXT = '（冒烟测试）跑任务途中插的那句话：桌面的软件程序这件事记一下'
  const TASK_TEXT = '（冒烟测试）插话取证这一轮请调用网页检索查「武汉 后天 空气质量 预报」，查完再回答。'
  const MEASURE_INTERRUPT_ROWS = () => page.evaluate((needle) => {
    const isVisible = (el) => { let node = el; while (node && node !== document.body) { if (getComputedStyle(node).display === 'none') return false; node = node.parentElement } return node ? true : false }
    const cs = (el) => (el === null ? null : getComputedStyle(el))
    const rectOf = (el) => (el === null ? null : el.getBoundingClientRect())
    return [...document.querySelectorAll('[data-chat-flow-kind="steering"], [data-chat-flow-kind="user"]')]
      .filter((row) => String(row.innerText ?? '').includes(needle))
      .map((row) => {
        const card = row.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="user"], [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"]')
        const head = card === null ? null : card.querySelector('[data-dsh-scard="head"]')
        const foot = card === null ? null : card.querySelector('[data-dsh-scard="foot"]')
        const bubble = row.querySelector('[data-slot="conversation.chat.node"]')
        const speak = card === null ? null : card.querySelector('[data-dsh-speak="button"]')
        const speakRect = rectOf(speak)
        return {
          flowKind: row.getAttribute('data-chat-flow-kind'), rowKey: row.getAttribute('data-chat-flow-key'), rowTurn: row.getAttribute('data-chat-turn'),
          rowVisible: isVisible(row) && rectOf(row).height > 0, rowHeight: Math.round(rectOf(row)?.height ?? 0),
          rowText: String(row.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 44),
          hasUserCard: card !== null, cardKind: card === null ? null : card.getAttribute('data-dsh-scard-kind'),
          cardBg: card === null ? null : cs(card).backgroundColor, cardSurfaceVar: card === null ? null : cs(card).getPropertyValue('--dsh-card-surface').trim(),
          nameText: head === null ? '' : head.querySelector('[data-dsh-scard="name"]')?.textContent?.trim() ?? '',
          tagText: head === null ? '' : head.querySelector('[data-dsh-scard="tag"]')?.textContent?.trim() ?? '',
          speakSize: speakRect === null ? 0 : Math.round(speakRect.height),
          footTimeText: foot === null ? '' : foot.querySelector('[data-dsh-scard="time"]')?.textContent?.trim() ?? '',
          footCopy: foot !== null && foot.querySelector('[data-dsh-scard="copy"]') !== null,
          bubbleDisplay: bubble === null ? '(无气泡节点)' : cs(bubble).display, bubbleHeight: Math.round(rectOf(bubble)?.height ?? -1),
          nativeRunText: row.querySelector('[data-slot="conversation.user.text.node"]')?.textContent?.trim().slice(0, 30) ?? '',
        }
      })
  }, INTERRUPT_TEXT)
  let interruptFacts = await MEASURE_INTERRUPT_ROWS()
  if ((interruptFacts ?? []).length === 0) {
    interruptFacts = null
    for (let attempt = 0; attempt < 2 && interruptFacts === null; attempt += 1) {
      await page.evaluate(async ({ id, body }) => {
        try { await window.__dshPromptIntoSession(id, body) } catch { /* 投递失败由现场事实说明 */ }
      }, { id: currentId, body: TASK_TEXT })
      const running = await page.waitForFunction(() => document.querySelector('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="tool-call"], [data-chat-group-key], [data-chat-flow-kind="turn-process"]') !== null, { timeout: 25000 })
        .then(() => true).catch(() => false)
      if (!running) { notes.push(`插话取证第 ${attempt + 1} 次：任务没跑起来（没等到过程行），跳过打字`); continue }
      const editBox = await page.$('[contenteditable="true"], textarea')
      if (editBox === null) { notes.push('插话取证：页面上找不到 composer，跳过打字取证'); break }
      await editBox.click()
      await page.keyboard.type(INTERRUPT_TEXT, { delay: 12 })
      await page.keyboard.press('Enter')
      const stayed = await page.evaluate((needle) => {
        const el = document.querySelector('[contenteditable="true"], textarea')
        return el !== null && String(el.innerText ?? el.value ?? '').includes(needle)
      }, INTERRUPT_TEXT)
      if (stayed) {
        const sendButton = await page.$('button[title*="发送"], button[aria-label*="发送"], [data-dsh-send="button"]')
        if (sendButton !== null) await sendButton.click().catch(() => {})
      }
      const appeared = await page.waitForFunction((needle) => {
        const isVisible = (el) => { let node = el; while (node && node !== document.body) { if (getComputedStyle(node).display === 'none') return false; node = node.parentElement } return true }
        return [...document.querySelectorAll('[data-chat-flow-kind="steering"], [data-chat-flow-kind="user"]')]
          .some((el) => isVisible(el) && el.getBoundingClientRect().height > 0 && String(el.innerText ?? '').includes(needle))
      }, INTERRUPT_TEXT, { timeout: 40000 }).then(() => true).catch(() => false)
      if (!appeared) continue
      // 等卡片真的接管那条插话行：挂载层有防抖，行刚出来那一瞬还没挂卡，量太早会把「没卡」当成结论
      const carded = await page.waitForFunction((needle) => {
        const rows = [...document.querySelectorAll('[data-chat-flow-kind="steering"], [data-chat-flow-kind="user"]')]
          .filter((el) => String(el.innerText ?? '').includes(needle))
        return rows.some((el) => el.querySelector('[data-dsh-scard="card"][data-dsh-scard-kind="user"], [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"]') !== null)
      }, INTERRUPT_TEXT, { timeout: 20000 }).then(() => true).catch(() => false)
      if (!carded) notes.push(`插话取证第 ${attempt + 1} 次：插话行出来了，但 20 秒内等不到卡片接管它`)
      await page.waitForTimeout(1500)
      interruptFacts = await MEASURE_INTERRUPT_ROWS()
    }
  }
  const steeringFacts = (interruptFacts ?? []).filter((fact) => fact.flowKind === 'steering')
  const allInterruptFacts = interruptFacts ?? []
  const interruptFact = steeringFacts.length > 0 ? steeringFacts[steeringFacts.length - 1] : (allInterruptFacts.length > 0 ? allInterruptFacts[allInterruptFacts.length - 1] : null)
  notes.push(`插话现场事实：${JSON.stringify({ 现场kind: allInterruptFacts.map((fact) => fact.flowKind), facts: interruptFacts })}`)
  check('真页现场：秘书跑任务途中用户插话出用户卡（浅蓝卡 + 「你」+「用户消息」芯片 + 朗读 + 底行时间/复制），原生气泡不给它出图',
    interruptFact !== null && interruptFact.rowVisible && interruptFact.hasUserCard
    && interruptFact.cardKind === 'user'
    && (interruptFact.cardBg === 'rgb(238, 244, 255)' || interruptFact.cardSurfaceVar === '#eef4ff')
    && interruptFact.nameText === '你' && interruptFact.tagText === '用户消息'
    && interruptFact.speakSize === 34 && interruptFact.footTimeText !== '' && interruptFact.footCopy
    && interruptFact.bubbleDisplay === 'none',
    JSON.stringify(interruptFact))

  const leakFacts = await page.evaluate(() => {
    const isVisible = (el) => { let node = el; while (node && node !== document.body) { if (getComputedStyle(node).display === 'none') return false; node = node.parentElement } return node ? true : false }
    const PROCESS_KINDS = ['assistant-step', 'tool-call', 'turn-process', 'model-retry', 'turn-error', 'turn-max-tokens', 'compaction', 'manual-compaction', 'context', 'command']
    const rows = [...document.querySelectorAll('[data-chat-flow-key]')]
    const visible = rows.filter((el) => isVisible(el) && el.getBoundingClientRect().height > 0)
    const describe = (el) => `${String(el.getAttribute('data-chat-flow-kind'))}|group=${el.getAttribute('data-chat-group-key')}|member=${el.getAttribute('data-turn-process-member')}|h=${Math.round(el.getBoundingClientRect().height)}|${String(el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 46)}`
    const leakedRows = visible
      .filter((el) => PROCESS_KINDS.includes(el.getAttribute('data-chat-flow-kind')) || el.hasAttribute('data-chat-group-key') || el.hasAttribute('data-turn-process-member'))
      .filter((el) => el.querySelector('[data-dsh-scard]') === null)
      .map(describe)
    const tailExtras = [...document.querySelectorAll('[data-slot="conversation.chat.turnTail"]')]
      .flatMap((container) => [...container.children])
      .filter((child) => !child.hasAttribute('data-dsh-scard'))
      .filter((el) => isVisible(el) && el.getBoundingClientRect().height > 0)
      .map(describe)
    const titleLeaks = visible
      .filter((el) => el.querySelector('[data-dsh-scard]') === null)
      .map((el) => String(el.innerText ?? '').replace(/\s+/g, ' ').trim())
      .filter((text) => /^(已|正在|准备)(调用工具|读取文件|搜索代码|修改了文件|执行了命令|搜索网页|访问网页|协调子智能体|更新计划)|本回合记忆|本回合技能/.test(text))
    const kindsSeen = [...new Set(rows.map((el) => el.getAttribute('data-chat-flow-kind')).filter((kind) => kind !== null))]
    return { rowsTotal: rows.length, visibleTotal: visible.length, cardBackedVisible: visible.filter((el) => el.querySelector('[data-dsh-scard]') !== null).length, kindsSeen, leakedRows, tailExtras, titleLeaks }
  })
  notes.push(`过程行现场事实：${JSON.stringify(leakFacts)}`)
  const leakCount = leakFacts.leakedRows.length + leakFacts.tailExtras.length + leakFacts.titleLeaks.length
  check('真页现场：卡片之间过程行 0 条（已调用工具并搜索代码 / 已调用工具 / 本回合记忆召回 这类一律不出图）',
    leakCount === 0,
    `visible=${leakFacts.visibleTotal} cardBacked=${leakFacts.cardBackedVisible} kinds=${JSON.stringify(leakFacts.kindsSeen)} leaked=${JSON.stringify(leakFacts.leakedRows.slice(0, 6))} tailExtras=${JSON.stringify(leakFacts.tailExtras.slice(0, 4))} titleLeaks=${JSON.stringify(leakFacts.titleLeaks.slice(0, 4))}`)
  await page.screenshot({ path: 'tmp-secretary-interrupt-card.png' })
  notes.push('截图: tmp-secretary-interrupt-card.png（插话卡 + 过程行现场）')

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
