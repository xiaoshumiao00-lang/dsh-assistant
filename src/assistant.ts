/**
 * dsh-assistant 服务端入口：把两块既有能力装进同一个插件包。
 *
 *   1. 工作台（源自 dsh-worktable）：/api/worktable/* 文件与站点路由、原生皮肤模板；
 *   2. 手机访问（源自 dsh-pocket）：局域网/公网代理、二维码、SSH 固定隧道、文件 RPC。
 *
 * 两个宿主半部彼此独立（路由前缀不同、数据目录不同），这里只负责按顺序 apply 与卸载。
 * 不修改两个原插件的任何代码：它们仍可单独安装/使用。
 */
import * as worktable from './index'
import * as pocket from './pocket-host/index.js'

export const name = 'dsh-assistant'

/** 并集：工作台要 webServer/sessions，手机访问要 connection/webServer。 */
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

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}
