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
import { installComposerMenuToggle } from './composerMenu'
import { openAssistant, assistantUrlIntent } from './assistant-entry.ts'
import { loadAssistantConfig } from './assistant-config.ts'
import { applyPersonalTerms } from './pocket/orb/asr-terms.ts'
import { shouldAutoShow, showFirstRunGuide } from './firstRunGuide.ts'

export const name = 'dsh-assistant'

/** 并集：工作台 slots/locale/sessions/conversation/workspaces + pocket 的 connection/layout/sessionLogDownload。 */
export const inject = Array.from(new Set([
  ...(worktableInject as readonly string[]),
  'slots', 'connection', 'layout', 'locale', 'sessionLogDownload',
]))

export function apply(ctx: any): void {
  // 本机个人化配置（默认项目父目录 / 技能根 / 人名词表）：仓库里不写死任何本机值。
  // 拿到宿主下发的配置后缓存起来，并把本机词表交给语音转写。
  try {
    void loadAssistantConfig()
      .then((config) => { if (config?.asrTerms?.length) applyPersonalTerms(config.asrTerms) })
      .catch(() => { /* 旧宿主没有这条路由：用缓存或通用回落 */ })
  } catch { /* 非浏览器环境 */ }

  // 输入框「＋」菜单：再次点加号关闭（宿主原生只在点外部时关）。
  try {
    const dispose = installComposerMenuToggle()
    ctx.effect(() => dispose, 'dsh-assistant: composer menu toggle')
  } catch { /* 非浏览器环境或旧宿主无输入框时忽略 */ }

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
    // 私人助手入口（长按悬浮球 / 全局热键 / 控制室顶栏都落到这里）
    ;(window as any).__dshAssistantOpen = () => {
      controlRoomStore.setOpen(false)
      void openAssistant()
    }
  } catch {}

  // 悬浮球状态同步：宿主是「启用/头像」的真值（桌面球在宿主那边启停与换头像）。
  // - 桌面端界面内球与窗口外原生球并存（两颗都打开控制室）；native 只用于状态同步/诊断；
  // - 本地有头像而宿主还没收到（老版本 / 宿主重启丢了 avatar.txt）时补传一次，
  //   之后只要宿主 already hasAvatar 就不再重复 POST（否则每次都会重启球窗口）。
  try {
    // 宿主头像只在本次页面生命周期拉一次：界面内球与窗口外原生球共用同一个头像
    let hostAvatarWanted = true
    let ballSyncBusy = false
    const syncBallState = (): void => {
      if (ballSyncBusy) return
      ballSyncBusy = true
      const ctrl = new AbortController()
      const timeout = window.setTimeout(() => ctrl.abort(), 8000)
      void fetch('/api/assistant/ball', { cache: 'no-store', signal: ctrl.signal })
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
          } else if (!local.avatar && d?.hasAvatar === true && hostAvatarWanted) {
            // 本机还没存头像、宿主已有（例如在手机上设过）：拉回来，两颗球显示同一张图
            hostAvatarWanted = false
            void fetch('/api/assistant/ball-avatar', { cache: 'no-store' })
              .then((r) => r.json())
              .then((a) => {
                const avatar = typeof a?.avatar === 'string' ? a.avatar : ''
                if (avatar.startsWith('data:image/')) ballConfigStore.adopt({ avatar })
                else hostAvatarWanted = true
              })
              .catch(() => { hostAvatarWanted = true })
          }
        })
        .catch(() => {})
        .finally(() => {
          window.clearTimeout(timeout)
          ballSyncBusy = false
        })
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

  // 原生球点击 / 外部指令：宿主长轮询，点击发生即响应（不再固定等待 1.2s）。
  // 老宿主没有 longPoll 标记时自动退回低频轮询；HMR/重复 apply 仍全局只留一个循环。
  const BALL_POLL_KEY = '__dshAssistantBallPoll'
  try {
    const prev = (window as any)[BALL_POLL_KEY]
    if (typeof prev === 'function') { try { prev() } catch {} }
    else if (typeof prev === 'number' && prev > 0) { try { window.clearInterval(prev) } catch {} }
    let stopped = false
    let controller: AbortController | null = null
    let retryTimer: number | null = null
    let retryResolve: (() => void) | null = null
    const delay = (ms: number): Promise<void> => new Promise((resolve) => {
      retryResolve = resolve
      retryTimer = window.setTimeout(() => { retryTimer = null; retryResolve = null; resolve() }, ms)
    })
    const run = async (): Promise<void> => {
      while (!stopped) {
        let needsDelay = false
        try {
          controller = new AbortController()
          const r = await fetch('/api/assistant/ball-click?wait=1', { cache: 'no-store', signal: controller.signal })
          const d = await r.json()
          if (stopped) break
          if (d?.open === true) {
            // 宿主会在响应里带上这次唤起的意图：控制室 / 私人助手
            if (String(d?.intent ?? 'console') === 'assistant') {
              controlRoomStore.setOpen(false)
              void openAssistant()
            } else {
              controlRoomStore.setOpen(true)
            }
          }
          needsDelay = d?.longPoll !== true
        } catch {
          needsDelay = true
        } finally {
          controller = null
        }
        // 老宿主会立即返回，必须节流；新宿主只有出错/兼容回退才等待。
        if (!stopped && needsDelay) await delay(1200)
      }
    }
    const stop = (): void => {
      if (stopped) return
      stopped = true
      try { controller?.abort() } catch {}
      if (retryTimer != null) { window.clearTimeout(retryTimer); retryTimer = null }
      retryResolve?.()
      retryResolve = null
      if ((window as any)[BALL_POLL_KEY] === stop) (window as any)[BALL_POLL_KEY] = 0
    }
    ;(window as any)[BALL_POLL_KEY] = stop
    void run()
    try { if (typeof ctx.effect === 'function') ctx.effect(() => stop, 'dsh-assistant: ball click wait') } catch {}
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
    // 私人助手直达：…/?assistant=chat 或 …/#assistant
    if (assistantUrlIntent()) void openAssistant()
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

  // 一次性首启引导（P0-6）：只有第一次用这个插件会弹一次（状态 'never'）。
  // 看完 / 后一跳 / 关掉都写进 localStorage，以后不再自动弹；设置页里能重看。
  try {
    if (typeof document === 'undefined') return
    if (!shouldAutoShow()) return
    // 晚 1.2 秒：别把用户正在点的东西（控制室 / 球）盖在脚下
    const timer = setTimeout(() => {
      try { showFirstRunGuide({ auto: true }) } catch { /* 引导失败不影响助手 */ }
    }, 1200)
    timer.unref?.()
  } catch { /* 非浏览器环境 */ }
}
