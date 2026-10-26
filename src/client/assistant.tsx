/**
 * dsh-assistant 客户端入口：同一个客户端插件里装配两块能力。
 *
 *   1. 工作台（源自 dsh-worktable）：侧栏项目、分栏工作区、控制室、模板流程；
 *   2. 手机访问（源自 dsh-pocket）：设置页「手机访问」、移动端抽屉适配、悬浮球。
 *
 * 悬浮球点击后不再打开 pocket 的快捷页，而是直接打开控制室（见 control-room.tsx）。
 * 原 pocket 的快捷页仍保留在抽屉底部入口里，功能不删。
 */
import { apply as worktableApply, inject as worktableInject } from './index'
import { apply as pocketApply } from './pocket/index.jsx'
import { makeOrbApi } from './pocket/orb/orb-api.ts'
import { setAssistantApi } from './orb-bridge.ts'
import { ControlRoomOverlay } from './control-room.tsx'

export const name = 'dsh-assistant'

/** 并集：工作台 slots/locale/sessions/conversation/workspaces + pocket 的 connection/layout/sessionLogDownload。 */
export const inject = Array.from(new Set([
  ...(worktableInject as readonly string[]),
  'slots', 'connection', 'layout', 'locale', 'sessionLogDownload',
]))

export function apply(ctx: any): void {
  // 控制室/工作台共用一套宿主调用（模型目录、选模型、后台模型、带预设建会话）
  try { setAssistantApi(makeOrbApi(ctx)) } catch { setAssistantApi(null) }

  // 控制室兜底：面板未就绪时给一个「打开侧栏」按钮（布局服务可选，取不到就静默）
  try {
    ;(window as any).__dshAssistantToggleSidebar = () => {
      try { ctx.layout?.toggleSidebar?.() } catch {}
    }
  } catch {}

  worktableApply(ctx)
  pocketApply(ctx)

  // 全屏控制室（悬浮球打开；z-index 高于分栏工作区与快捷输入页）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-assistant-control-room',
    order: 110,
  }, ControlRoomOverlay), 'dsh-assistant: control room overlay')
}
