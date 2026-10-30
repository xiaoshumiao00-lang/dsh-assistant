// 悬浮球 ⇄ 控制室的桥（模块级外部 store，不依赖任何宿主 store）。
// 悬浮球点击不再打开 pocket 的快捷输入页，而是把控制室全屏浮层打开；
// 控制室里的卡片/会话/新建动作都由工作台侧处理，这里只负责开关与「哪块 UI 该收起来」。
import type { OrbApi } from './pocket/orb/orb-api.ts'

let open = false
const listeners = new Set<() => void>()

export const controlRoomStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): boolean {
    return open
  },
  setOpen(next: boolean): void {
    if (open === next) return
    open = next
    for (const listener of [...listeners]) listener()
  },
}

/** 「先离开当前项目分栏工作区」的出口：由工作台在 apply 时登记。
 *  私人助手是**单一会话布局**，打开前必须收起项目分栏（否则会顶在项目流程窗格旁边，
 *  看起来像「项目还在左右分屏」）。用回调注册而不是直接 import 分栏引擎，避免模块环。 */
let workspaceExit: (() => void) | null = null
export function setWorkspaceExit(fn: (() => void) | null): void {
  workspaceExit = fn
}
export function exitWorkspace(): void {
  try { workspaceExit?.() } catch {}
}

/** 工作台侧要用的宿主 API（模型目录/选模型/后台模型/建会话带预设）。
 *  由 assistant 客户端入口在 apply 时创建一次；控制室与工作台共用。 */
let assistantApi: OrbApi | null = null
export function setAssistantApi(api: OrbApi | null): void {
  assistantApi = api
}
export function getAssistantApi(): OrbApi | null {
  return assistantApi
}

/** 是否存在 Electron 原生桌面球（窗口外那颗）。桌面端界面内球仍常驻，两颗球功能相同；
 *  这个标记保留给设置页/诊断显示原生球状态，不再用于隐藏界面内球。 */
let nativeBall = false
const nativeListeners = new Set<() => void>()
export const nativeBallStore = {
  subscribe(listener: () => void): () => void {
    nativeListeners.add(listener)
    return () => {
      nativeListeners.delete(listener)
    }
  },
  getSnapshot(): boolean {
    return nativeBall
  },
  set(next: boolean): void {
    if (nativeBall === next) return
    nativeBall = next
    for (const listener of [...nativeListeners]) listener()
  },
}

/** 新建会话记住的模型（标准 / Computer Use 分开存，互不覆盖）。 */
export type ModelPref = { provider: string; model: string; name: string }
type ModelKind = 'standard' | 'cu'
const MODEL_PREF_KEY: Record<ModelKind, string> = {
  standard: 'dsh-assistant.model.standard.v1',
  cu: 'dsh-assistant.model.cu.v1',
}
export function readModelPref(kind: ModelKind): ModelPref | null {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY[kind])
    if (!raw) return null
    const p = JSON.parse(raw)
    if (p && typeof p.provider === 'string' && typeof p.model === 'string') {
      return { provider: p.provider, model: p.model, name: String(p.name ?? p.model) }
    }
  } catch {}
  return null
}
export function writeModelPref(kind: ModelKind, pref: ModelPref | null): void {
  try {
    if (pref) localStorage.setItem(MODEL_PREF_KEY[kind], JSON.stringify(pref))
    else localStorage.removeItem(MODEL_PREF_KEY[kind])
  } catch {}
}

/** 后台模型（dsh-orb 全局设置）的上次选择缓存。 */
const BG_PREF_KEY = 'dsh-assistant.model.background.v1'
export function readBgPref(): ModelPref | null {
  try {
    const raw = localStorage.getItem(BG_PREF_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (p && typeof p.provider === 'string' && typeof p.model === 'string') {
      return { provider: p.provider, model: p.model, name: String(p.name ?? p.model) }
    }
  } catch {}
  return null
}
export function writeBgPref(pref: ModelPref | null): void {
  try {
    if (pref) localStorage.setItem(BG_PREF_KEY, JSON.stringify(pref))
    else localStorage.removeItem(BG_PREF_KEY)
  } catch {}
}

/* ---------- 悬浮球外观（启用 / 头像）：本插件自己的偏好，不依赖任何外部插件 ---------- */

const BALL_ENABLED_KEY = 'dsh-assistant.ball.enabled.v1'
const BALL_AVATAR_KEY = 'dsh-assistant.ball.avatar.v1'

export type BallConfig = { enabled: boolean; avatar: string }

function readBallConfig(): BallConfig {
  let enabled = true
  let avatar = ''
  try { enabled = localStorage.getItem(BALL_ENABLED_KEY) !== '0' } catch {}
  try { avatar = localStorage.getItem(BALL_AVATAR_KEY) ?? '' } catch {}
  return { enabled, avatar }
}

let ballConfig: BallConfig = readBallConfig()
const ballConfigListeners = new Set<() => void>()

/** 悬浮球外观（设置页改、页内球实时跟随）：enabled = 是否显示悬浮球；avatar = data URL（空 = 默认 🔮）。
 *  enabled/avatar 会同时写宿主（桌面原生球按它启停、换头像），所以设置立刻生效。 */
export const ballConfigStore = {
  subscribe(listener: () => void): () => void {
    ballConfigListeners.add(listener)
    return () => { ballConfigListeners.delete(listener) }
  },
  getSnapshot(): BallConfig {
    return ballConfig
  },
  /** 只采纳（如宿主启动时读回的存档），不回写宿主。 */
  adopt(patch: Partial<BallConfig>): void {
    applyLocal(patch)
  },
  set(patch: Partial<BallConfig>): void {
    applyLocal(patch)
    try {
      if (patch.enabled !== undefined) {
        void fetch('/api/assistant/ball', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: patch.enabled }),
        }).then((r) => r.json()).then((d) => {
          // 桌面球停了就立刻让页内球接上（否则要等下一次启动才更新）
          if (d && typeof d.native === 'boolean') nativeBallStore.set(d.native)
        }).catch(() => {})
      }
      if (patch.avatar !== undefined) {
        void fetch('/api/assistant/ball-avatar', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dataUrl: patch.avatar }),
        }).catch(() => {})
      }
    } catch { /* 宿主不可达：本地仍然生效（页内球跟随） */ }
  },
}

function applyLocal(patch: Partial<BallConfig>): void {
  const next = { ...ballConfig, ...patch }
  // 宿主每 15 秒回读同一状态时不再制造新快照；set() 的远端同步仍照常执行。
  if (next.enabled === ballConfig.enabled && next.avatar === ballConfig.avatar) return
  ballConfig = next
  try {
    if (patch.enabled !== undefined) localStorage.setItem(BALL_ENABLED_KEY, patch.enabled ? '1' : '0')
    if (patch.avatar !== undefined) {
      if (patch.avatar) localStorage.setItem(BALL_AVATAR_KEY, patch.avatar)
      else localStorage.removeItem(BALL_AVATAR_KEY)
    }
  } catch { /* 存储不可写时仅本次生效 */ }
  for (const listener of [...ballConfigListeners]) { try { listener() } catch {} }
}
