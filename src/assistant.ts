/**
 * dsh-assistant 服务端入口：把既有能力装进同一个插件包。
 *
 *   1. 工作台（源自 dsh-worktable）：/api/worktable/* 文件与站点路由、原生皮肤模板；
 *   2. 手机访问（源自 dsh-pocket）：局域网/公网代理、二维码、SSH 固定隧道、文件 RPC；
 *   3. 托管（源自 dsh-tuoguan）：/.dsh-tuoguan/state 跨端托管开关（提问/审批自动应答）。
 *
 * 各半部彼此独立（路由前缀不同、数据目录不同），这里只负责按顺序 apply 与卸载。
 * 不修改原插件的任何代码：它们仍可单独安装/使用。
 */
import * as worktable from './index'
import * as pocket from './pocket-host/index.js'
import * as tuoguan from './tuoguan-host'
import { registerAssistantState } from './assistant-store'
import { startDesktopBall, ballProfileDir } from './desktop-ball'
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

/** 并集：工作台要 webServer/sessions，手机访问要 connection/webServer，托管要 webServer。 */
export const inject = ['webServer', 'sessions', 'connection']

export function apply(ctx: any, config: any = {}): () => void {
  const disposers: Array<() => void> = []

  // ── 工作台半部 ──
  try {
    const dispose = (worktable as any).apply?.(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('worktable half failed: %s', String(err)) } catch {}
    throw err
  }

  // ── 手机访问半部 ──
  try {
    const dispose = (pocket as any).apply?.(ctx, config, {})
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('pocket half failed: %s', String(err)) } catch {}
    throw err
  }

  // ── 托管半部（状态路由；宿主重启后手机/电脑共用同一份） ──
  try {
    const dispose = (tuoguan as any).apply?.(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('tuoguan half failed: %s', String(err)) } catch {}
  }

  // ── 跨端状态半部（项目 / 控制室视图） ──
  try { registerAssistantState(ctx) } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('state store failed: %s', String(err)) } catch {}
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
  let pendingOpenConsole = false
  type ClickWaiter = { res: any; timer: ReturnType<typeof setTimeout> | null; done: boolean }
  const clickWaiters = new Set<ClickWaiter>()
  const sendClick = (res: any, open: boolean): void => {
    if (res?.destroyed || res?.writableEnded) return
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ open, longPoll: true }))
  }
  const finishClickWaiter = (waiter: ClickWaiter, open: boolean, respond = true): void => {
    if (waiter.done) return
    waiter.done = true
    if (waiter.timer) clearTimeout(waiter.timer)
    clickWaiters.delete(waiter)
    if (respond) { try { sendClick(waiter.res, open) } catch {} }
  }
  const takeOpenClick = (): boolean => {
    let open = ballHandle ? ballHandle.takeClick() === true : false
    if (pendingOpenConsole) { pendingOpenConsole = false; open = true }
    return open
  }
  const wakeClickWaiters = (): void => {
    // 一次点击只交给一个页面，保持旧接口的「取走」语义；其余页面继续等待。
    for (const waiter of [...clickWaiters]) {
      if (takeOpenClick()) finishClickWaiter(waiter, true)
    }
  }
  disposers.push(() => { for (const waiter of [...clickWaiters]) finishClickWaiter(waiter, false) })

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
  // 外部打开控制室的一次性信号（不依赖悬浮球/桌面小窗）：
  //   POST（或 GET）http://127.0.0.1:<web端口>/api/assistant/open-console
  // 置位后由页面下一次轮询 /api/assistant/ball-click 取走并打开控制室。
  // 用途：桌面球点不开/没有球（网页、CLI）时，用一条 curl 即可打开，便于验收与排障。
  try {
    ctx.webServer?.register?.({
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
        const payload = JSON.stringify({ native: nativeBall, enabled: ballState.enabled, hasAvatar: !!ballState.avatar })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(payload)
      },
    })
    // 悬浮球头像：data URL 存到 profile（球体窗口重启后立刻用新头像）
    ctx.webServer?.register?.({
      kind: 'exact',
      path: '/api/assistant/ball-avatar',
      handler: (req: any, res: any) => {
        if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
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
    ctx.webServer?.register?.({
      kind: 'exact',
      path: '/api/assistant/open-console',
      handler: (_req: any, res: any) => {
        pendingOpenConsole = true
        wakeClickWaiters()
        const payload = JSON.stringify({ ok: true, opened: true })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(payload)
      },
    })
    // 新建会话聚焦诊断：客户端把 {opened, inList, openState, settled, resyncs, dom…} POST 过来，
    // 这里追加到 ~/.dsh/dsh-assistant-focus.log。用来自查「切过去白屏」这种只能看渲染状态的问题，
    // 不需要用户打开 DevTools。只写诊断，不读任何会话内容。
    ctx.webServer?.register?.({
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
    ctx.webServer?.register?.({
      kind: 'exact',
      path: '/api/assistant/ball-click',
      handler: (req: any, res: any) => {
        if (takeOpenClick()) { sendClick(res, true); return }
        const wantsWait = /[?&]wait=1(?:&|$)/.test(String(req.url ?? ''))
        if (!wantsWait) { sendClick(res, false); return }
        const waiter: ClickWaiter = { res, timer: null, done: false }
        // 15 秒空响应一次，兼容代理/浏览器超时；客户端收到后立即发起下一次等待。
        waiter.timer = setTimeout(() => finishClickWaiter(waiter, false), 15000)
        clickWaiters.add(waiter)
        req.on('close', () => finishClickWaiter(waiter, false, false))
      },
    })
  } catch {}

  void applyBall()
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}
