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
import { startDesktopBall } from './desktop-ball'

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
  let nativeBall = false
  let ballHandle: any = null
  void startDesktopBall(ctx)
    .then((handle) => {
      if (!handle) return
      ballHandle = handle
      nativeBall = true
      disposers.push(() => { try { handle.dispose() } catch {} })
      try { ctx.logger?.('dsh-assistant')?.info?.('desktop ball started') } catch {}
    })
    .catch((err) => {
      try { ctx.logger?.('dsh-assistant')?.error?.('desktop ball failed: %s', String(err)) } catch {}
    })
  try {
    ctx.webServer?.register?.({
      kind: 'exact',
      path: '/api/assistant/ball',
      handler: (_req: any, res: any) => {
        const payload = JSON.stringify({ native: nativeBall })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(payload)
      },
    })
    ctx.webServer?.register?.({
      kind: 'exact',
      path: '/api/assistant/ball-click',
      handler: (_req: any, res: any) => {
        const open = ballHandle ? ballHandle.takeClick() === true : false
        const payload = JSON.stringify({ open })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(payload)
      },
    })
  } catch {}

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}
