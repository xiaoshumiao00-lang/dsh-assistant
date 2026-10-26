// 悬浮球页级状态：开关（drawer 按钮 ⇄ 全屏页共用）+ 上次项目目录的持久化。
// 纯模块级外部 store（useSyncExternalStore 订阅），不依赖任何宿主 store。
import { noteOrb } from './diag.ts'

let open = false
const listeners = new Set<() => void>()

export const orbStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): boolean {
    return open
  },
  setOpen(next: boolean, source = 'unknown'): void {
    if (open === next) return
    open = next
    // 诊断：记录每次开关的来源与调用栈（client/orb/diag.ts）。只读，不影响流程。
    noteOrb(next, source)
    for (const listener of [...listeners]) listener()
  },
}

const CWD_KEY = 'dsh-pocket.orb.cwd'

/** 读上次使用的项目目录（空字符串 = 未设置，由调用方兜底 HOME）。 */
export function readLastCwd(): string {
  try {
    return localStorage.getItem(CWD_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 记住本次使用的项目目录。 */
export function writeLastCwd(cwd: string): void {
  try {
    if (cwd) localStorage.setItem(CWD_KEY, cwd)
  } catch {
    /* 隐私模式/无 storage → 静默 */
  }
}

const PRESET_KEY = 'dsh-pocket.orb.preset'

/** 读上次「新建会话」的模式（Agent 预设 id；空串 = 主机默认/标准模式）。
 * 与 cwd 一起持久化：悬浮球重挂载后，新建会话仍沿用上次选中会话的模式。 */
export function readLastPreset(): string | null {
  try {
    return localStorage.getItem(PRESET_KEY)
  } catch {
    return null
  }
}

/** 记住「新建会话」的模式（空串 = 标准模式，也要记下来，别退回默认预设）。 */
export function writeLastPreset(preset: string): void {
  try {
    localStorage.setItem(PRESET_KEY, String(preset ?? '').trim())
  } catch {
    /* 隐私模式/无 storage → 静默 */
  }
}

const MODEL_KEY = 'dsh-pocket.orb.model'

/** 上次选中的模型（null = 未选过，用主机默认）。 */
export interface StoredModel {
  provider: string
  model: string
  name: string
}

export function readLastModel(): StoredModel | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
      return { provider: parsed.provider, model: parsed.model, name: String(parsed.name ?? parsed.model) }
    }
    return null
  } catch {
    return null
  }
}

export function writeLastModel(selection: StoredModel): void {
  try {
    localStorage.setItem(MODEL_KEY, JSON.stringify(selection))
  } catch {
    /* 隐私模式/无 storage → 静默 */
  }
}

/** 清除上次选中的模型（模型已从目录里消失时用，避免把死 id 发给会话）。 */
export function clearLastModel(): void {
  try {
    localStorage.removeItem(MODEL_KEY)
  } catch {
    /* 静默 */
  }
}

const BACKGROUND_MODEL_KEY = 'dsh-pocket.orb.backgroundModel'

/** 上次选中的后台任务模型（label 展示缓存；真正的生效配置写在主机 dsh-orb 设置里，
 * 打开页面时会用 GET /.dsh-orb/settings 回读校正这里）。 */
export function readLastBackgroundModel(): StoredModel | null {
  try {
    const raw = localStorage.getItem(BACKGROUND_MODEL_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
      return { provider: parsed.provider, model: parsed.model, name: String(parsed.name ?? parsed.model) }
    }
    return null
  } catch {
    return null
  }
}

export function writeLastBackgroundModel(selection: StoredModel): void {
  try {
    localStorage.setItem(BACKGROUND_MODEL_KEY, JSON.stringify(selection))
  } catch {
    /* 隐私模式/无 storage → 静默 */
  }
}

const TARGET_KEY = 'dsh-pocket.orb.target'

/** 上次选中的目标会话 id（null = 新会话模式/没选过）。
 * 悬浮球页在 HMR 重载、断连重连、宿主重建客户端图时会整体重挂载，
 * 组件内 state 归零会让「当前选中会话」跳回新会话模式——这里持久化选择，
 * 重挂载后恢复用户最后选中的那条会话，消除选中行来回跳动。 */
export function readLastTargetId(): string | null {
  try {
    const raw = localStorage.getItem(TARGET_KEY)
    return raw && raw !== '' ? raw : null
  } catch {
    return null
  }
}

export function writeLastTargetId(id: string | null): void {
  try {
    if (id) localStorage.setItem(TARGET_KEY, id)
    else localStorage.removeItem(TARGET_KEY)
  } catch {
    /* 隐私模式/无 storage → 静默 */
  }
}

const BALL_KEY = 'dsh-pocket.orb.ball'

/** 悬浮球位置（视口坐标，单位 px）。 */
export interface BallPoint {
  x: number
  y: number
}

/** 上次拖到的位置（null = 未拖过，用默认右下角）。 */
export function readLastBall(): BallPoint | null {
  try {
    const raw = localStorage.getItem(BALL_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return { x: Number(parsed.x), y: Number(parsed.y) }
    }
    return null
  } catch {
    return null
  }
}

export function writeLastBall(point: BallPoint): void {
  try {
    localStorage.setItem(BALL_KEY, JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) }))
  } catch {
    /* 静默 */
  }
}
