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
