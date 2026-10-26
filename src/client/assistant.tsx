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
import { setAssistantApi, nativeBallStore, controlRoomStore, ballConfigStore } from './orb-bridge.ts'
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

  // 悬浮球状态同步：宿主是「启用/头像」的真值（桌面球在宿主那边启停与换头像）。
  // - native=true 时页面内那颗球隐藏，避免出现两个球；
  // - 本地有头像而宿主还没收到（老版本 / 宿主重启丢了 avatar.txt）时补传一次，
  //   之后只要宿主 already hasAvatar 就不再重复 POST（否则每次都会重启球窗口）。
  try {
    const syncBallState = (): void => {
      void fetch('/api/assistant/ball', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          nativeBallStore.set(d?.native === true)
          if (typeof d?.enabled === 'boolean') ballConfigStore.adopt({ enabled: d.enabled })
          const local = ballConfigStore.getSnapshot()
          if (local.avatar && d?.hasAvatar !== true) {
            void fetch('/api/assistant/ball-avatar', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dataUrl: local.avatar }),
            }).catch(() => {})
          }
        })
        .catch(() => {})
    }
    syncBallState()
    // 桌面球是异步启动的：刚开页时可能还没起来，补两次 + 低频轮询兜底
    const timers: number[] = [
      window.setTimeout(syncBallState, 3000),
      window.setInterval(syncBallState, 15000),
    ]
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => { for (const t of timers) { try { window.clearTimeout(t); window.clearInterval(t) } catch {} } }, 'dsh-assistant: ball state sync')
      }
    } catch {}
  } catch {}

  // 原生球点击 / 外部指令 → 宿主 pending → 这里轮询后打开控制室（1.2s 内响应）。
  //
  // 轮询必须「全局只有一个」并且随插件 disposal 一起清掉：
  // 客户端 bundle 被 HMR/重新 apply 时会再执行一遍 apply()，而 window.setInterval 不在
  // ctx.effect 里就永远不会被清 → 旧实例的定时器活着，继续 fetch /api/assistant/ball-click
  // 把点击「吃掉」，并 setOpen 到**已经卸载**的 controlRoomStore 上。
  // 表现为：球点了没反应、控制室永远不出现（每次重建 lib/client.js 后必现）。
  // 所以：新实例先清掉手上一个句柄，再把自己登记进去；dispose 时清自己。
  //
  // 不再用 nativeBallStore 做前置条件：该接口同时承担「外部 open-console 指令」，
  // 没有桌面球的网页/CLI 环境也要能被打开（本机 1.2s 一次 GET，开销可忽略）。
  const BALL_POLL_KEY = '__dshAssistantBallPoll'
  try {
    const prev = (window as any)[BALL_POLL_KEY]
    if (typeof prev === 'number' && prev > 0) { try { window.clearInterval(prev) } catch {} }
    const timer = window.setInterval(() => {
      void fetch('/api/assistant/ball-click', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => { if (d?.open === true) controlRoomStore.setOpen(true) })
        .catch(() => {})
    }, 1200)
    ;(window as any)[BALL_POLL_KEY] = timer
    const stop = (): void => {
      try { window.clearInterval(timer) } catch {}
      if ((window as any)[BALL_POLL_KEY] === timer) (window as any)[BALL_POLL_KEY] = 0
    }
    try { if (typeof ctx.effect === 'function') ctx.effect(() => stop, 'dsh-assistant: ball click poll') } catch {}
  } catch {}

  // URL 直达：…/?assistant=console 或 …/#console 打开控制室（重开窗口/外部打开时用；
  // 主窗没有地址栏，平时仍以悬浮球或 open-console 路由为准）。
  try {
    const search = String(window.location?.search ?? '')
    const hash = String(window.location?.hash ?? '')
    if (/[?&]assistant=console(?:&|$)/.test(search) || hash === '#console') {
      // 等控制室宿主（无头工作台）挂载后 consoleEnvReady() 才为真；ControlRoomOverlay 内部会自动重试，
      // 这里只负责把开关置真。
      controlRoomStore.setOpen(true)
    }
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
