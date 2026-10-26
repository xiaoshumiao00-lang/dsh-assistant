// 「同一次点击不被处理两次」的护栏。
//
// 现象：手指/鼠标抬起时悬浮球立刻被卸载，浏览器随后为这次按压合成 click，
// 命中测试用的是**抬起之后**的界面——此刻悬浮球页面刚挂载出来（或还没画出来时
// 是电脑端界面上那个按钮），于是「点开悬浮球」这一次点击顺手又点到了别的控件：
// 页面刚出现就跳到会话详情（看起来像点了没反应/延迟），严重时还顺手新建了一条会话。
//
// 护栏做法：点开的那一刻记下球的位置，只吞掉「同一个落点、且此后没有新的按下」
// 的 click。任何一次新的 pointerdown 都视为用户的下一次操作，立刻解除护栏，
// 所以正常连点、快速点发送都不会被误吞。

export interface GuardRect {
  x: number
  y: number
  w: number
  h: number
}

const DEFAULT_PAD = 20
const DEFAULT_WINDOW_MS = 450

interface GuardState {
  rect: GuardRect | null
  pad: number
  windowMs: number
  deadline: number
  swallowed: number
  armed: boolean
  onSwallow?: (total: number) => void
}

const state: GuardState = {
  rect: null,
  pad: DEFAULT_PAD,
  windowMs: DEFAULT_WINDOW_MS,
  deadline: 0,
  swallowed: 0,
  armed: false,
}

/** 落点是否落在护栏区域（球的位置 + 容差）。 */
export function inGuardRect(rect: GuardRect, x: number, y: number, pad = DEFAULT_PAD): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return x >= rect.x - pad && x <= rect.x + rect.w + pad && y >= rect.y - pad && y <= rect.y + rect.h + pad
}

/** 该 click 是否应当被吞掉（纯判定，供单测与护栏共用）。
 * @param now - 事件时间（ms）
 * @param sincePointerDown - 护栏武装之后是否又发生过新的按下（有 = 用户的新操作，不吞）
 */
export function shouldSwallow(
  rect: GuardRect | null,
  x: number,
  y: number,
  now: number,
  deadline: number,
  hasNewPointerDown: boolean,
  pad = DEFAULT_PAD,
): boolean {
  if (rect === null) return false
  if (hasNewPointerDown) return false
  if (now > deadline) return false
  return inGuardRect(rect, x, y, pad)
}

type AnyWindow = any

let win: AnyWindow | null = null
let timer: any = null

function onClickCapture(event: any): void {
  if (!state.armed || state.rect === null) return
  const now = Date.now()
  if (shouldSwallow(state.rect, event?.clientX, event?.clientY, now, state.deadline, false, state.pad)) {
    state.swallowed += 1
    try {
      event.stopPropagation()
      event.preventDefault?.()
    } catch {
      /* 老 WebView 没有 preventDefault → 已挡住冒泡即达目的 */
    }
    try {
      state.onSwallow?.(state.swallowed)
    } catch {
      /* 诊断上报失败不能影响拦截 */
    }
    return
  }
  if (now > state.deadline) disarm()
}

/** 新的按下 = 用户的下一次操作，护栏立刻失效。 */
function onPointerDownCapture(): void {
  if (state.armed) disarm()
}

export function arm(
  rect: GuardRect,
  opts: { pad?: number; windowMs?: number; onSwallow?: (total: number) => void } = {},
): void {
  win = win ?? (typeof window === 'undefined' ? null : window)
  if (win === null) return
  state.rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  state.pad = opts.pad ?? DEFAULT_PAD
  state.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  state.onSwallow = opts.onSwallow
  state.deadline = Date.now() + state.windowMs
  state.armed = true
  try {
    win.addEventListener?.('click', onClickCapture, true)
    win.addEventListener?.('pointerdown', onPointerDownCapture, true)
    win.addEventListener?.('touchstart', onPointerDownCapture, true)
  } catch {
    /* 注册失败 → 保持无护栏，功能不受影响 */
  }
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(disarm, state.windowMs + 120)
}

export function disarm(): void {
  state.armed = false
  state.rect = null
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (win !== null) {
    try {
      win.removeEventListener?.('click', onClickCapture, true)
      win.removeEventListener?.('pointerdown', onPointerDownCapture, true)
      win.removeEventListener?.('touchstart', onPointerDownCapture, true)
    } catch {
      /* 忽略 */
    }
  }
}

/** 被吞掉的穿透点击次数（诊断用）。 */
export function swallowStats(): { armed: boolean; swallowed: number } {
  return { armed: state.armed, swallowed: state.swallowed }
}
