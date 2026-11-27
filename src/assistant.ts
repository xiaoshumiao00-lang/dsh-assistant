/**
 * dsh-assistant 服务端入口：把既有能力装进同一个插件包。
 *
 *   1. 工作台（源自 dsh-worktable）：/api/worktable/* 文件与站点路由、原生皮肤模板；
 *   2. 手机访问：独立入口 src/pocket.ts，避免工作台热重载造成断线与重登；
 *   3. 托管（源自 dsh-tuoguan）：/.dsh-tuoguan/state 跨端托管开关（提问/审批自动应答）。
 *
 * 各半部彼此独立（路由前缀不同、数据目录不同），这里只负责按顺序 apply 与卸载。
 * 不修改原插件的任何代码：它们仍可单独安装/使用。
 */
import * as worktable from './index'
import * as tuoguan from './tuoguan-host'
import * as turnGuard from './turn-guard'
import { registerAssistantState } from './assistant-store'
import { registerCoordinateMode } from './coordinate-mode'
import { CONSOLE_SEA01_ROUTE, serveConsoleSea01 } from './consoleAsset'
import { startDesktopBall, ballProfileDir, BALL_GESTURE_INTENT } from './desktop-ball'
import { nativeFocusAvailability } from './desktop-focus'
import { manageWebRoutes } from './web-routes'
import { registerAssistantHome } from './assistant-home'
import { registerAssistantConfigRoutes } from './assistant-config'
import { registerAssistantDiagnostics } from './assistant-diagnostics'
import { registerAssistantArchive } from './assistant-archive'
import { registerAssistantSecretary } from './assistant-secretary'
import { registerAssistantSecretaryHistory, ASSISTANT_SECRETARY_HISTORY_ROUTE } from './assistant-secretary-history'
import { registerAssistantSecretaryContext, ASSISTANT_SECRETARY_CONTEXT_ROUTE } from './assistant-secretary-context'
import { registerAssistantDispatch } from './assistant-dispatch'
import { registerAssistantCuWatch } from './assistant-cu-watch'
import { registerAssistantProactive } from './assistant-proactive'
import { registerAssistantTts } from './assistant-tts'
import { assistantConfigTestSurface } from './assistant-config'
import { appendOpenDiag, registerAssistantOpenDiagRoute } from './assistant-open-diag'
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPathNode } from 'node:path'

/** 新建会话聚焦诊断日志（/api/assistant/focus-diag 追加写入；超过 512KB 自动清空） */
const FOCUS_DIAG_LOG = joinPathNode(homedir(), '.dsh', 'dsh-assistant-focus.log')

function appendFocusDiag(raw: string): void {
  const text = String(raw ?? '').slice(0, 8000)
  if (!text) return
  try { if (statSync(FOCUS_DIAG_LOG).size > 512 * 1024) writeFileSync(FOCUS_DIAG_LOG, '') } catch { /* 文件不存在，正常 */ }
  appendFileSync(FOCUS_DIAG_LOG, text.replace(/\s+/g, ' ') + '\n', 'utf8')
}

export const name = 'dsh-assistant'

/** 供测试直接验证路由：仅导出注册函数，不改变插件行为。 */
export { registerAssistantHome } from './assistant-home'
export { appendOpenDiag, readOpenDiagTail, handleOpenDiag, registerAssistantOpenDiagRoute, OPEN_DIAG_PATH } from './assistant-open-diag'
export { assistantConfigTestSurface } from './assistant-config'
export { assistantMemoryTestSurface } from './assistant-memory'
export { registerAssistantDiagnostics, assistantDiagnosticsTestSurface, redactText, renderDiagnosticsBundle, writeDiagnosticsBundle } from './assistant-diagnostics'
export { registerAssistantArchive, assistantArchiveTestSurface, collectArchive, writeArchiveBundle, importArchiveBundle, ARCHIVE_FORMAT } from './assistant-archive'
export { assistantSecretaryTestSurface } from './assistant-secretary'
export { assistantSecretaryHistoryTestSurface } from './assistant-secretary-history'
export { assistantSecretaryContextTestSurface } from './assistant-secretary-context'
import { secretCardSharedTestSurface as cardSharedSurface } from './secretary-card-shared'
export { cardSharedSurface as secretCardSharedTestSurface }
export { assistantDispatchTestSurface } from './assistant-dispatch'
export { assistantCuWatchTestSurface } from './assistant-cu-watch'
/** v4 会话日志事务化改写：宿主真实解析器 dry-run + 写入后回读 + 失败回滚 */
export {
  loadHostLogParser,
  rewriteSessionLogFileSync,
  assertSessionLogFileAccepted,
  parseLogText,
  decompressLogBytes,
  compressLogText,
  assertHostReadableArtifact,
  scanHostZstdFrames,
  defaultSessionLogBackupPath,
  defaultHostParserPaths,
} from './session-log-guard'
export { assistantProactiveTestSurface } from './assistant-proactive'
/** 桌面球手势 → 意图的映射与生成出来的 helper 代码（供 scripts/test-desktop-ball-gestures.mjs） */
export { desktopBallTestSurface } from './desktop-ball'
/** 秘书卡片 TTS：路由 / 探测 / 音色解析（供 scripts/test-assistant-tts.mjs） */
export { assistantTtsTestSurface } from './assistant-tts'
/** 秘书朗读状态机 / 文本规范化 / 引用解析（纯函数，node 可单测） */
export { secretaryCardsTestSurface } from './client/pocket/orb/secretary-cards.ts'
/** 秘书朗读分块流水线（纯逻辑：预取/排队/abort/重试/缓存，node 可单测） */
export { secretarySpeechPipelineTestSurface } from './client/pocket/orb/secretary-speech-pipeline.ts'
/** 本地文件路由的 content-disposition 口径（inline/attachment + RFC 5987 中文名，node 可单测） */
export { fileDispositionTestSurface } from './file-disposition'
/** 本地文件路由本体：100MB 上限 + 流式发送（供 scripts/test-local-file-route.mjs 离线直接喂假 req/res） */
export { localFileRouteTestSurface, LOCAL_FILE_MAX_BYTES } from './index'
/** 秘书朗读播放侧全局 flight 令牌表（「同一时刻最多一条在出声」的硬约束，node 可单测） */
export { secretarySpeechFlightTestSurface } from './client/pocket/orb/secretary-speech-flight.ts'
/** 目录 allowlist 与终端环境变量（供 scripts/test-path-guard.mjs 直接验） */
export { expandHome, defaultAllowedRoots, createPathGuard, minimalTermEnv, isDirectory } from './path-guard'
/** turn-guard 的判定与状态函数（供 scripts/test-turn-guard.mjs 直接验） */
export { turnGuardTestSurface } from './turn-guard'

/**
 * 工作台要 webServer/sessions，托管与设置路由要 webServer；手机访问由独立入口注入 connection。
 * `tools` 必须显式声明：Cordis 里未 inject 的服务在服务尚未挂载时读取会抛
 * "cannot get property tools without inject"，秘书派活工具就会整块注册不上
 * （2026-11-21「明天天气」实测：工具清单 50 个里没有 secretary_dispatch 的根因）。
 */
export const inject = ['webServer', 'sessions', 'tools']

export function apply(ctx: any, config: any = {}): () => void {
  const disposers: Array<() => void> = []
  const routes = manageWebRoutes(ctx.webServer)
  const webServer = routes.webServer
  disposers.push(routes.dispose)

  /** 单个半部注册失败不能连累后面的半部（尤其是秘书派活工具）。 */
  const registerPiece = (label: string, fn: () => any): void => {
    try {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) {
      try { ctx.logger?.('dsh-assistant')?.error?.(`${label} failed: %s`, String(err)) } catch {}
    }
  }

  // ── 工作台半部 ──
  try {
    const dispose = (worktable as any).apply?.(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('worktable half failed: %s', String(err)) } catch {}
    throw err
  }

  // ── 托管半部（状态路由；宿主重启后手机/电脑共用同一份） ──
  try {
    const dispose = (tuoguan as any).apply?.(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('tuoguan half failed: %s', String(err)) } catch {}
  }

  // ── turn-guard 半部（防空转补步；开关在设置页「个人助手 → 托管」） ──
  // 原独立插件 dsh-turn-guard 并入本包：判定逻辑、历史闸、跨端开关路由都在 src/turn-guard.ts。
  try {
    const dispose = (turnGuard as any).apply?.(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('turn-guard half failed: %s', String(err)) } catch {}
  }

  // ── 跨端状态半部（项目 / 控制室视图） ──
  try {
    const dispose = registerAssistantState(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('state store failed: %s', String(err)) } catch {}
  }

  // ── Computer Use 坐标模式（千分比 0–1000 / 截图像素；设置页可切换） ──
  // 内嵌 computer-use 在新会话创建时读 assistantCoordinateMode 服务，决定点击坐标系。
  try {
    const dispose = registerCoordinateMode(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('coordinate mode failed: %s', String(err)) } catch {}
  }

  // ── 桌面原生悬浮球（独立 Electron 小窗；网页/CLI 自动回退页内球） ──
  // 启用状态与头像由「个人助手 → Computer Use」驱动，存到 profile 下的
  // dsh-assistant-ball/state.json 与 avatar.txt，宿主启动时按存档恢复。
  let nativeBall = false
  let ballHandle: any = null
  const ballDir = (() => { try { return ballProfileDir(ctx) } catch { return '' } })()
  const ballStateFile = ballDir ? joinPathNode(ballDir, 'state.json') : ''
  const ballAvatarFile = ballDir ? joinPathNode(ballDir, 'avatar.txt') : ''

  // 点击事件用长轮询推给页面：有等待者时立刻响应，没有时仍保留一次性 pending。
  // 与旧的 1.2s 定时轮询相比，点击延迟不再取决于下一次轮询何时发生。
  // intent 区分这次唤起要开哪块：'assistant' = 个人秘书固定会话（单击球 / Ctrl+Alt+A），
  // 'console' = 控制室（长按球）。手势 → 意图的唯一真值在 desktop-ball.ts 的 BALL_GESTURE_INTENT。
  type Intent = 'console' | 'assistant'
  let pendingOpen: Intent | null = null
  type ClickWaiter = { res: any; timer: ReturnType<typeof setTimeout> | null; done: boolean }
  const clickWaiters = new Set<ClickWaiter>()
  const sendClick = (res: any, intent: Intent | null): void => {
    if (res?.destroyed || res?.writableEnded) return
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ open: intent !== null, intent: intent ?? 'console', longPoll: true }))
  }
  const finishClickWaiter = (waiter: ClickWaiter, intent: Intent | null, respond = true): void => {
    if (waiter.done) return
    waiter.done = true
    if (waiter.timer) clearTimeout(waiter.timer)
    clickWaiters.delete(waiter)
    if (respond) { try { sendClick(waiter.res, intent) } catch {} }
  }
  const takeOpenClick = (): Intent | null => {
    const native = ballHandle ? ballHandle.takeClick() : null
    if (pendingOpen !== null) {
      const intent = pendingOpen
      pendingOpen = null
      return intent
    }
    return native === 'assistant' ? 'assistant' : native === 'console' ? 'console' : null
  }
  const wakeClickWaiters = (): void => {
    if (clickWaiters.size === 0) return
    const intent = takeOpenClick()
    if (intent === null) return
    // 诊断：桌面球/热键把意图交给页面时先在这里留痕（单击=assistant，长按=console）
    appendOpenDiag({ step: 'host-click-intent', intent, waiters: clickWaiters.size, source: 'desktop-ball' })
    // 点击要广播给所有正在等待的页面。页面重载/插件 HMR 可能短暂留下旧等待者；
    // 旧逻辑只交给第一个等待者，旧连接把点击“取走”后，真正可见的页面就收不到，
    // 表现为“偶尔点了悬浮球却停在会话详情”。
    for (const waiter of [...clickWaiters]) finishClickWaiter(waiter, intent)
  }
  disposers.push(() => { for (const waiter of [...clickWaiters]) finishClickWaiter(waiter, null) })

  const readBallState = (): { enabled: boolean; avatar: string } => {
    let enabled = true
    let avatar = ''
    try {
      const parsed = JSON.parse(readFileSync(ballStateFile, 'utf8'))
      if (parsed && typeof parsed.enabled === 'boolean') enabled = parsed.enabled
    } catch { /* 没有存档 → 默认启用 */ }
    try { avatar = readFileSync(ballAvatarFile, 'utf8') } catch { /* 没有自定义头像 */ }
    return { enabled, avatar }
  }
  const ballState = readBallState()
  const saveBallState = (): void => {
    try {
      if (ballStateFile) {
        mkdirSync(ballDir, { recursive: true })
        writeFileSync(ballStateFile, JSON.stringify({ enabled: ballState.enabled }), 'utf8')
      }
      if (ballAvatarFile) {
        if (ballState.avatar) writeFileSync(ballAvatarFile, ballState.avatar, 'utf8')
        else rmSync(ballAvatarFile, { force: true })
      }
    } catch (err) {
      try { ctx.logger?.('dsh-assistant')?.error?.('save ball state failed: %s', String(err)) } catch {}
    }
  }
  /** 按当前 enabled / avatar 让桌面球就位：关 → 停；开 → （重）启动以应用头像。 */
  const applyBall = async (): Promise<void> => {
    if (ballHandle) {
      try { ballHandle.dispose() } catch {}
      ballHandle = null
      nativeBall = false
    }
    if (!ballState.enabled) return
    try {
      const handle = await startDesktopBall(ctx, { avatar: ballState.avatar })
      if (!handle) return
      ballHandle = handle
      nativeBall = true
      const offClick = handle.onClick?.(wakeClickWaiters)
      disposers.push(() => { try { offClick?.(); handle.dispose() } catch {} })
      try { ctx.logger?.('dsh-assistant')?.info?.('desktop ball started') } catch {}
    } catch (err) {
      try { ctx.logger?.('dsh-assistant')?.error?.('desktop ball failed: %s', String(err)) } catch {}
    }
  }
  /** 读一个小小的 JSON body（头像 data URL 可能到 1MB 量级）。 */
  const readSmallJson = (req: any, limit = 2 * 1024 * 1024): Promise<any> => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk: any) => { if (raw.length < limit) raw += String(chunk) })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
  // ── 个人秘书链路：必须在其它路由之前单独注册、各自 try ──
  // 2026-11-21 实测 bug：这些半部原来塞在下面的大 try 里，任何一处路由异常都会把
  // 「秘书固定会话 + secretary_dispatch 工具 + 主动卡片」一起跳过；同时插件 inject
  // 没声明 tools，ctx.tools 取不到时派活工具又会被静默忽略。
  // 固定秘书会话：宿主侧唯一 sessionId + 只读工具闸（web_search/web_fetch 放行）
  registerPiece('assistant secretary', () => registerAssistantSecretary(ctx))
  // 第四批需求 A：秘书页卡片分页（宿主只读分页接口，只回一页，绝不全量下发）
  registerPiece('assistant secretary history', () => registerAssistantSecretaryHistory(ctx))
  // 第四批需求 B：模型上下文滚动摘要（最近 8 轮原文 + 摘要，落 ~/.dsh/assistant/dsh-assistant-secretary-context.json）
  registerPiece('assistant secretary context', () => registerAssistantSecretaryContext(ctx))
  // 派活分层 A/B/C：secretary_dispatch 工具 + 分层提示词
  registerPiece('assistant dispatch', () => registerAssistantDispatch(ctx))
  // CU 会话完成 → 秘书会话收可点跳的卡片消息
  registerPiece('assistant cu watch', () => registerAssistantCuWatch(ctx))
  // 主动服务卡片：卡组存储 + 路由 + proactive_card 工具
  registerPiece('assistant proactive', () => registerAssistantProactive(ctx))
  // 秘书卡片朗读：POST /api/assistant/tts
  registerPiece('assistant tts', () => registerAssistantTts(ctx))

  // 外部打开控制室的一次性信号（不依赖悬浮球/桌面小窗）：
  //   POST（或 GET）http://127.0.0.1:<web端口>/api/assistant/open-console
  // 置位后由页面下一次轮询 /api/assistant/ball-click 取走并打开控制室。
  // 用途：桌面球点不开/没有球（网页、CLI）时，用一条 curl 即可打开，便于验收与排障。
  try {
    webServer.register({
      kind: 'exact',
      path: '/api/assistant/ball',
      handler: (req: any, res: any) => {
        const method = String(req.method ?? 'GET').toUpperCase()
        if (method === 'POST') {
          void readSmallJson(req).then((body) => {
            if (typeof body?.enabled === 'boolean') ballState.enabled = body.enabled
            saveBallState()
            void applyBall()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, native: nativeBall, enabled: ballState.enabled }))
          })
          return
        }
        // gestures：桌面球当前的手势映射（单击 → 个人秘书 / 长按 → 控制室 / 热键 → 个人秘书）。
        // 页面冒烟与设置页都读这一份，避免「代码改了、说明没改」。
        const gestures = {
          shortPress: BALL_GESTURE_INTENT['short-press'],
          longPress: BALL_GESTURE_INTENT['long-press'],
          hotkey: BALL_GESTURE_INTENT.hotkey,
        }
        const payload = JSON.stringify({ native: nativeBall, enabled: ballState.enabled, hasAvatar: !!ballState.avatar, gestures })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(payload)
      },
    })
    // 悬浮球头像：data URL 存到 profile（球体窗口重启后立刻用新头像）
    webServer.register({
      kind: 'exact',
      path: '/api/assistant/ball-avatar',
      handler: (req: any, res: any) => {
        const method = String(req.method ?? 'GET').toUpperCase()
        // GET：界面内悬浮球启动时拉一次宿主头像，保证窗口内/窗口外两颗球长得一样
        if (method === 'GET') {
          const payload = JSON.stringify({ avatar: ballState.avatar })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(payload)
          return
        }
        if (method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        void readSmallJson(req).then((body) => {
          const dataUrl = typeof body?.dataUrl === 'string' ? body.dataUrl : ''
          if (dataUrl && !dataUrl.startsWith('data:image/')) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'invalid-image' }))
            return
          }
          ballState.avatar = dataUrl.slice(0, 1_500_000)
          saveBallState()
          void applyBall()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, hasAvatar: !!ballState.avatar }))
        })
      },
    })
    // 控制室预置背景按需下载：不占首屏 client bundle；仅首次初始化空媒体库时请求。
    webServer.register({
      kind: 'exact',
      path: CONSOLE_SEA01_ROUTE,
      handler: (req: any, res: any) => { void serveConsoleSea01(req, res) },
    })
    // 模型目录的 HTTP 兜底：移动端页面经公网代理时，客户端 Remote 偶发调用不到
    // session/modelCatalog，新建会话面板就只剩当前模型。这里直接在 Host 侧读同一份目录，
    // 客户端用同源 fetch 就能列出全部模型。
    webServer.register({
      kind: 'exact',
      path: '/api/assistant/models',
      handler: (_req: any, res: any) => {
        void (async () => {
          try {
            const controller: any = ctx.get?.('sessionController') ?? ctx.sessionController
            const catalog = await controller?.modelCatalog?.()
            if (!catalog) throw new Error('model catalog unavailable')
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, catalog }))
          } catch (err) {
            try {
              res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: String((err as any)?.message ?? err) }))
            } catch { /* 客户端已断开 */ }
          }
        })()
      },
    })
    // 打开控制室（外部唤起，不依赖悬浮球）
    webServer.register({
      kind: 'exact',
      path: '/api/assistant/open-console',
      handler: (_req: any, res: any) => {
        appendOpenDiag({ step: 'host-open-request', intent: 'console', source: 'open-console' })
        pendingOpen = 'console'
        wakeClickWaiters()
        const payload = JSON.stringify({ ok: true, opened: true })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(payload)
      },
    })
    // 打开私人助手（桌面全局热键 Ctrl+Alt+A 走这里；页面不在前台时也能唤起）
    webServer.register({
      kind: 'exact',
      path: '/api/assistant/open-assistant',
      handler: (_req: any, res: any) => {
        appendOpenDiag({ step: 'host-open-request', intent: 'assistant', source: 'open-assistant' })
        pendingOpen = 'assistant'
        wakeClickWaiters()
        const payload = JSON.stringify({ ok: true, opened: true, intent: 'assistant' })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(payload)
      },
    })
    // 新建会话聚焦诊断：客户端把 {opened, inList, openState, settled, resyncs, dom…} POST 过来，
    // 这里追加到 ~/.dsh/dsh-assistant-focus.log。用来自查「切过去白屏」这种只能看渲染状态的问题，
    // 不需要用户打开 DevTools。只写诊断，不读任何会话内容。
    webServer.register({
      kind: 'exact',
      path: '/api/assistant/focus-diag',
      handler: (req: any, res: any) => {
        let raw = ''
        try {
          req.on('data', (chunk: any) => { if (raw.length < 8000) raw += String(chunk) })
          req.on('end', () => {
            try { appendFocusDiag(raw) } catch { /* 写盘失败不影响响应 */ }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true }))
          })
          req.on('error', () => {
            try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false })) } catch {}
          })
        } catch {
          try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false })) } catch {}
        }
      },
    })
    // 个人秘书打开链路诊断：页面 POST 落盘，GET 读回（~/.dsh/dsh-assistant-open.log）
    registerAssistantOpenDiagRoute(webServer)
    webServer.register({
      kind: 'exact',
      path: '/api/assistant/ball-click',
      handler: (req: any, res: any) => {
        const pending = takeOpenClick()
        if (pending !== null) {
          // 诊断：页面从宿主取走了一次唤起意图（原生球的点击也可能在这里被取走）
          appendOpenDiag({ step: 'host-click-pull', intent: pending, source: 'ball-click' })
          sendClick(res, pending)
          return
        }
        const wantsWait = /[?&]wait=1(?:&|$)/.test(String(req.url ?? ''))
        if (!wantsWait) { sendClick(res, null); return }
        const waiter: ClickWaiter = { res, timer: null, done: false }
        // 15 秒空响应一次，兼容代理/浏览器超时；客户端收到后立即发起下一次等待。
        waiter.timer = setTimeout(() => finishClickWaiter(waiter, null), 15000)
        clickWaiters.add(waiter)
        req.on('close', () => finishClickWaiter(waiter, null, false))
      },
    })
    // 能力自检（P0-7）：koffi / 前台窗口聚焦是否可用。不可用时只是这一项不工作，
    // 插件其余功能照常；设置页「本机配置」把它显示出来。
    webServer.register({
      kind: 'exact',
      path: '/api/assistant/capabilities',
      handler: (_req: any, res: any) => {
        let nativeFocus: { available: boolean; reason: string } = { available: false, reason: 'unknown' }
        try { nativeFocus = nativeFocusAvailability() } catch { /* 探测失败按不可用报 */ }
        const payload = JSON.stringify({
          ok: true,
          platform: process.platform,
          nativeFocus,
          desktopBall: nativeBall,
          electron: Boolean(process.versions.electron),
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(payload)
      },
    })
    // 私人助手的家：固定目录 + AGENTS.md 人设 + journal / notes（会话据此创建）
    disposers.push(registerAssistantHome(ctx))
    // 本机个人化配置（默认项目父目录 / 技能根 / 人名词表 / 人设注入）
    disposers.push(registerAssistantConfigRoutes(ctx))
    // 一键导出诊断包（P1-A）：脱敏后落 ~/.dsh/assistant/outputs/
    disposers.push(registerAssistantDiagnostics(ctx))
    // 助手档案导出 / 导入（P1-B）：单一 JSON 清单，导入前先备份、按文件夹判重、不覆盖墓碑
    disposers.push(registerAssistantArchive(ctx))
    // 个人秘书 / 派活 / 主动卡片 / 朗读在 apply 顶部单独注册（不随这段大 try 一起被跳过）
  } catch {}

  void applyBall()
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}
