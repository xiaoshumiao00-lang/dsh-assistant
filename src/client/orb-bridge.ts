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

/** 工作台侧要用的宿主 API（模型目录/选模型/后台模型/建会话带预设）。
 *  由 assistant 客户端入口在 apply 时创建一次；控制室与工作台共用。 */
let assistantApi: OrbApi | null = null
export function setAssistantApi(api: OrbApi | null): void {
  assistantApi = api
}
export function getAssistantApi(): OrbApi | null {
  return assistantApi
}

/** 是否存在 Electron 原生桌面球（存在时网页内那颗球隐藏，避免两个球）。 */
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
