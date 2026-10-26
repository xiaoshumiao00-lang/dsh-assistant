/**
 * dsh-assistant 客户端入口：同一个客户端插件里装配两块能力。
 *
 *   1. 工作台（源自 dsh-worktable）：控制室、项目/会话、分栏工作区、模板流程；
 *   2. 手机访问（源自 dsh-pocket）：设置页、移动端抽屉适配、远程代理与悬浮球。
 *
 * 侧栏不再出现工作台区块；控制室一律从悬浮球进入（见 control-room.tsx）。
 * 原 pocket 的快捷输入页仍保留在抽屉底部入口里，功能不删。
 */
import { apply as worktableApply, inject as worktableInject } from './index'
import { apply as pocketApply } from './pocket/index.jsx'
import { makeOrbApi } from './pocket/orb/orb-api.ts'
import { setAssistantApi, nativeBallStore, controlRoomStore } from './orb-bridge.ts'
import { ControlRoomOverlay } from './control-room.tsx'
import { AssistantSettingsHub } from './assistant-settings.tsx'
import { apply as tuoguanApply } from './tuoguan.tsx'
import { POCKET_RPC_CHANNEL } from './pocket/api.js'
import { NS as POCKET_NS } from './pocket/pocket-locales.js'

export const name = 'dsh-assistant'

/** 并集：工作台 slots/locale/sessions/conversation/workspaces + pocket 的 connection/layout/sessionLogDownload。 */
export const inject = Array.from(new Set([
  ...(worktableInject as readonly string[]),
  'slots', 'connection', 'layout', 'locale', 'sessionLogDownload',
]))

export function apply(ctx: any): void {
  // 控制室/工作台共用一套宿主调用（模型目录、选模型、后台模型、带预设建会话）。
  // 必须等 remote.session / uiWorkspace 等 Remote 服务注入后再建 API——直接拿根 ctx
  // 会取不到 ctx.remote（未 inject 的命名空间），模型目录恒为空。
  try {
    ctx.inject(
      ['sessions', 'remote', 'remote.session', 'remote.commands', 'remote.skills', 'uiWorkspace'],
      (apiCtx: any) => {
        try { setAssistantApi(makeOrbApi(apiCtx)) } catch { setAssistantApi(null) }
      },
    )
  } catch { setAssistantApi(null) }

  // 控制室兜底：面板未就绪时给一个「打开侧栏」按钮（布局服务可选，取不到就静默）
  try {
    ;(window as any).__dshAssistantToggleSidebar = () => {
      try { ctx.layout?.toggleSidebar?.() } catch {}
    }
    // 桌面原生悬浮球点击时，主进程会执行这段 JS
    ;(window as any).__dshAssistantOpenControlRoom = () => controlRoomStore.setOpen(true)
  } catch {}

  // 是否存在 Electron 原生桌面球（有则隐藏网页内那颗）
  try {
    void fetch('/api/assistant/ball', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { nativeBallStore.set(d?.native === true) })
      .catch(() => {})
  } catch {}

  worktableApply(ctx)
  pocketApply(ctx)
  // 托管（原 dsh-tuoguan）：composer 右侧开关 + 提问/审批自动应答 + 跨端同步
  tuoguanApply(ctx)

  // 全屏控制室（悬浮球打开；z-index 高于分栏工作区与快捷输入页）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-assistant-control-room',
    order: 110,
  }, ControlRoomOverlay), 'dsh-assistant: control room overlay')

  // 设置页「个人助手」：手机访问（复用 pocket 设置页）+ Computer Use / 模型入口
  const pocketT = (() => { try { return ctx.locale.bind(POCKET_NS) } catch { return undefined } })()
  const rpcCall = (endpoint: string, payload: any, signal?: any) =>
    ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'assistant',
    order: 0.9,
    label: () => '个人助手',
    inject: () => ({ rpcCall, t: pocketT }),
  }, AssistantSettingsHub), 'dsh-assistant: settings hub')
}
