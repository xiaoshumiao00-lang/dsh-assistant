// 底部悬浮面板避让扫描（工作台区块停靠在侧栏时，把自己抬到 dsh-usage 这类贴底 fixed 面板上方）。
//
// 为什么要拆：原来这条避让靠「每 2 秒 document.querySelectorAll('body *') + 每个节点
// getBoundingClientRect() + 命中者再 getComputedStyle()」实现。一条会话页面有上万个节点时，
// 这一发就是几十毫秒的主线程长任务，每 2 秒插一次，正好落在打字 / 滚动 / 流式渲染的缝里——
// 用户看到的「每隔一会儿卡一下」就是它。
//
// 本模块把同一件事改成：
// ① 分片扫描：每帧只量固定数量的节点，长任务被切成若干段短任务（浏览器能在段间正常渲染）；
// ② 自适应轮询：稳定态（没找到面板、用户没在动）退到低频兜底，活跃态（找到面板 / 正在交互 / 有 style 变更）保持高频；
// ③ 变更驱动补扫：只监听 style 属性变化（被拖动的贴底面板改的就是 style），文本流式更新不产生记录；
// ④ 判定顺序与几何公式一字不改（measureOverlap 是纯函数，回归测试直接对着原实现核语义）。
//
// 全程只读：不改 DOM、不写样式。

/** 活跃态轮询间隔（与原实现一致：2 秒）。 */
export const OVERLAY_FAST_MS = 2000
/** 稳定态兜底轮询间隔：没有面板、也没有交互时用来接住「CSS 自己动了」这类无变更记录的情况。 */
export const OVERLAY_IDLE_MS = 10000
/** 用户交互（点/拖/换窗口大小）后保持活跃态的时间窗。 */
export const OVERLAY_INTERACTION_MS = 6000
/** 每帧最多量的节点数：400 个 rect 约 1–3ms，切完这段浏览器就能继续处理输入。 */
export const OVERLAY_CHUNK = 400
/** 有 style 变更记录时（正在被拖动的面板）多久补扫一次：比 2 秒轮询更跟手，且有上限。 */
export const OVERLAY_STYLE_KICK_MS = 700

/** 一次扫描要用的几何上下文（与原来 measureBottomOverlay 里的局部变量一一对应）。 */
export interface OverlayScanContext {
  selfLeft: number
  selfRight: number
  /** 原实现里叫 naturalBottom：本区块按当前 bottomInset 的自然落点。 */
  naturalBottom: number
  /** 只考虑贴近视口底部这一段的面板（原实现 = window.innerHeight - 300）。 */
  regionTop: number
}

/** 候选元素的几何矩形（只取原实现用到的字段）。 */
export interface OverlayRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

/** 候选元素的样式字段（原实现只在几何过滤通过后才算样式）。 */
export interface OverlayStyle {
  position: string
  visibility: string
  opacity: number
}

const OVERLAP_TOLERANCE = 8
/** 与原来一致：最多抬 340px。 */
export const OVERLAY_MAX_RAISE = 340
/** 与原来一致：变化不到 2px 不重设，避免每轮都 setState。 */
export const OVERLAY_EPSILON = 2

/** 几何门槛（只读 rect，不读样式）：原实现里排在 getComputedStyle 之前的那几条。 */
export function geometryPass(rect: OverlayRect, ctx: OverlayScanContext): boolean {
  const r = rect
  if (r.width < 40 || r.height < 16) return false
  if (r.top < ctx.regionTop) return false
  if (r.left > 80) return false
  const loX = ctx.selfLeft - 8
  const hiX = ctx.selfRight + 8
  if (r.right < loX || r.left > hiX) return false
  if (r.top >= ctx.naturalBottom + 4) return false
  return true
}

/** 样式门槛：原实现里 fixed / 可见 / 不透明那几条。 */
export function stylePass(style: OverlayStyle): boolean {
  if (style.position !== 'fixed') return false
  if (style.visibility === 'hidden' || style.opacity === 0) return false
  return true
}

/**
 * 单个候选要不要算进避让、算出来该抬多少（0 = 不管）。
 * 判定顺序与原实现逐条对齐：尺寸 → 区域顶 → 左列范围 → fixed → 可见 → 落点之下 → 重叠阈值 → 上限。
 */
export function measureOverlap(
  rect: OverlayRect,
  style: OverlayStyle,
  ctx: OverlayScanContext,
): number {
  const r = rect
  if (!geometryPass(r, ctx)) return 0
  if (!stylePass(style)) return 0
  const overlap = Math.min(r.bottom, ctx.naturalBottom + 400) - r.top
  if (overlap <= OVERLAP_TOLERANCE) return 0
  return Math.max(0, Math.min(ctx.naturalBottom - r.top + 8, OVERLAY_MAX_RAISE))
}

/** 整批候选的最大抬升（纯函数：给分片扫描当累加器用）。 */
export function maxOverlap(items: { rect: OverlayRect; style: OverlayStyle }[], ctx: OverlayScanContext): number {
  let needed = 0
  for (const item of items) needed = Math.max(needed, measureOverlap(item.rect, item.style, ctx))
  return needed
}

/** setState 门槛：变化不到 OVERLAY_EPSILON 像素就别动（与原实现一致）。 */
export function shouldApplyInset(prev: number, next: number): boolean {
  return Math.abs(prev - next) >= OVERLAY_EPSILON
}

export interface BottomOverlayOptions {
  /** 候选元素列表（调用方给：默认 document.querySelectorAll('body *')，不必先转成数组） */
  candidates: () => any[] | ArrayLike<any> | null
  /** 插件自己的区块（拿不到 / 宽度不足 10 时不扫，与原实现一致）。 */
  root: () => any
  /** 当前 inset（scan 开始时读一次，整段扫描都用这个值，与原实现同语义）。 */
  inset: () => number
  /** 新的最大抬升；调用方负责 setState（并沿用 shouldApplyInset 的门槛）。 */
  applyInset: (needed: number) => void
  /** 这一轮该不该跳过（让路闸门 / 不可见 / 悬浮态）。 */
  blocked?: () => boolean
  /** 是否悬浮态：悬浮态不避让（与原实现 isFloat 一致）。 */
  floating?: () => boolean
  doc?: any
  win?: any
  fastMs?: number
  idleMs?: number
  interactionMs?: number
  chunk?: number
  scheduleFrame?: (fn: () => void) => any
  cancelFrame?: (handle: any) => void
  setTimeoutFn?: (fn: () => void, ms: number) => any
  clearTimeoutFn?: (handle: any) => void
  now?: () => number
  /** 挂不挂 style 变更观察者（测试可关掉）。 */
  observeStyle?: boolean
  Observer?: any
}

export interface BottomOverlayScanner {
  /** 立刻重测（布局刚变过、开关停靠态、外部显式要求）。 */
  kick: () => void
  /** 用户动了一下（点击 / 拖动 / 窗口大小变化）：这段时间保持高频轮询。 */
  reportInteraction: () => void
  /** 跑一整段分片扫描（测试直接调它，不必等定时器）。 */
  scanOnce: () => void
  /** 本轮扫描是不是「活跃」：找到面板 = 活跃（决定下一轮的间隔）。 */
  isActive: () => boolean
  dispose: () => void
}

/**
 * 造一个避让扫描器。定时器只有一个（自适应间隔），扫描按帧分片。
 */
export function createBottomOverlayScanner(options: BottomOverlayOptions): BottomOverlayScanner {
  const doc = options.doc ?? (globalThis as any).document
  const win = options.win ?? (globalThis as any).window
  const fastMs = options.fastMs ?? OVERLAY_FAST_MS
  const idleMs = options.idleMs ?? OVERLAY_IDLE_MS
  const interactionMs = options.interactionMs ?? OVERLAY_INTERACTION_MS
  const chunk = options.chunk ?? OVERLAY_CHUNK
  const now = options.now ?? ((): number => (typeof Date !== 'undefined' ? Date.now() : 0))
  const scheduleFrame = options.scheduleFrame
    ?? ((fn: () => void) => (typeof win?.requestAnimationFrame === 'function' ? win.requestAnimationFrame(fn) : null))
  const cancelFrame = options.cancelFrame ?? ((handle: any) => { try { if (handle != null && typeof win?.cancelAnimationFrame === 'function') win.cancelAnimationFrame(handle) } catch { /* 忽略 */ } })
  const setTimeoutFn = options.setTimeoutFn ?? ((fn: () => void, ms: number) => win.setTimeout(fn, ms))
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle: any) => { try { if (handle != null) win.clearTimeout(handle) } catch { /* 忽略 */ } })
  const blocked = options.blocked ?? (() => false)
  const floating = options.floating ?? (() => false)

  let disposed = false
  /** 正在进行的分片扫描状态；null = 没在扫。 */
  let run: { nodes: ArrayLike<any>; index: number; needed: number; ctx: OverlayScanContext } | null = null
  let frameHandle: any = null
  let timerHandle: any = null
  let armed = false
  let lastNeeded = 0
  let lastInteractionAt = 0
  let lastScanAt = 0
  let styleDirty = false

  const rectOf = (el: any): OverlayRect => {
    const r = typeof el?.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
    if (!r) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const styleOf = (el: any): OverlayStyle => {
    const cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(el) : null
    if (!cs) return { position: 'static', visibility: 'visible', opacity: 1 }
    const rawOpacity = cs.opacity
    const opacity = typeof rawOpacity === 'string' ? Number(rawOpacity) : 1
    return {
      position: String(cs.position ?? 'static'),
      visibility: String(cs.visibility ?? 'visible'),
      opacity: Number.isFinite(opacity) ? opacity : 1,
    }
  }

  const armIn = (ms: number): void => {
    if (disposed) return
    if (timerHandle != null) { clearTimeoutFn(timerHandle); timerHandle = null }
    armed = true
    timerHandle = setTimeoutFn(() => {
      timerHandle = null
      armed = false
      scanOnce()
    }, ms)
  }

  const armNext = (): void => {
    if (disposed || armed) return
    const active = lastNeeded > 0 || styleDirty || now() - lastInteractionAt < interactionMs
    armIn(active ? fastMs : idleMs)
  }

  /** 一整段扫描：量完一批就交还帧，剩下的下一帧接着量。 */
  const scanOnce = (): void => {
    if (disposed) return
    if (blocked() || floating() || doc?.visibilityState === 'hidden') { armNext(); return }
    const root = options.root()
    if (!root) { armNext(); return }
    const self = rectOf(root)
    // 原实现：区块宽度不足 10（被 CSS 藏了）不测
    if (self.width < 10) { armNext(); return }
    const insetValue = options.inset()
    const ctx: OverlayScanContext = {
      selfLeft: self.left,
      selfRight: self.right,
      naturalBottom: self.bottom + insetValue,
      regionTop: (typeof win?.innerHeight === 'number' ? win.innerHeight : 0) - 300,
    }
    let nodes: ArrayLike<any> = []
    try {
      // 不预先 Array.from：querySelectorAll 给的 NodeList 直接按下标遍历，省掉一次上万元素的数组分配
      const list = options.candidates()
      nodes = (list ?? []) as ArrayLike<any>
    } catch {
      armNext()
      return
    }
    styleDirty = false
    lastScanAt = now()
    // 上一段扫描没跑完就重来：先掐掉它挂在帧里的续跑，避免同一段被两条链并行量（重复活）
    if (frameHandle != null) { cancelFrame(frameHandle); frameHandle = null }
    run = { nodes, index: 0, needed: 0, ctx }
    step()
  }

  const step = (): void => {
    frameHandle = null
    if (disposed) { run = null; return }
    const state = run
    if (state === null) return
    // 中途有人显式要求重测 / 正在让路：丢掉这半段，别继续量已作废的节点
    if (blocked() || floating() || doc?.visibilityState === 'hidden') { run = null; armNext(); return }
    const until = Math.min(state.nodes.length, state.index + chunk)
    for (; state.index < until; state.index++) {
      const el = state.nodes[state.index]
      if (el === null || el === undefined) continue
      // 分片扫描期间被移除的节点已经不在文档里：它不该再影响落点，与原实现「同一瞬间快照」等价地跳过
      if (el.isConnected === false) continue
      const rect = rectOf(el)
      // 先过几何门槛（只读 rect），通过了才读样式——与原实现「先过滤再 getComputedStyle」同成本口径
      if (!geometryPass(rect, state.ctx)) continue
      const needed = measureOverlap(rect, styleOf(el), state.ctx)
      if (needed > state.needed) state.needed = needed
    }
    if (state.index < state.nodes.length) {
      frameHandle = scheduleFrame(step)
      if (frameHandle == null) {
        // 没有 rAF（隐藏页 / 测试环境）：直接收口，别让扫描悬在半截
        finish(state)
      }
      return
    }
    finish(state)
  }

  const finish = (state: { needed: number }): void => {
    run = null
    lastNeeded = state.needed
    try { options.applyInset(state.needed) } catch { /* 避让失败不影响原状态 */ }
    armNext()
  }

  // style 变更观察者：只盯 style 属性（被拖动的贴底面板改的就是它）。
  // childList 一律不观察——聊天流式渲染会灌进整页记录，那正是要避开的。
  let observer: any = null
  if (options.observeStyle !== false) {
    const Observer = options.Observer ?? (globalThis as any).MutationObserver
    const body = doc?.body ?? null
    if (typeof Observer === 'function' && body) {
      try {
        observer = new Observer(() => {
          styleDirty = true
          // 已经在扫的这一段让它扫完再说：补扫定时器只在「没有扫描在飞」时挂，
          // 免得流式 / 拖动期间的 style 变更把同一段扫描反复重启（那才是真正的浪费）
          if (run !== null || timerHandle != null) return
          const since = now() - lastScanAt
          armIn(since >= OVERLAY_STYLE_KICK_MS ? 0 : OVERLAY_STYLE_KICK_MS - since)
        })
        observer.observe(body, { attributes: true, attributeFilter: ['style'], subtree: true })
      } catch {
        observer = null
      }
    }
  }

  // 窗口大小变化：所有落点都会变，立刻重测
  const onResize = (): void => {
    lastInteractionAt = now()
    kick()
  }
  try { win?.addEventListener?.('resize', onResize) } catch { /* 没有 resize 也不影响 */ }

  const kick = (): void => {
    if (disposed) return
    if (timerHandle != null) { clearTimeoutFn(timerHandle); timerHandle = null; armed = false }
    if (frameHandle != null) { cancelFrame(frameHandle); frameHandle = null }
    run = null
    scanOnce()
  }

  armNext()

  return {
    kick,
    reportInteraction(): void { lastInteractionAt = now() },
    scanOnce,
    isActive(): boolean { return lastNeeded > 0 },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (timerHandle != null) { clearTimeoutFn(timerHandle); timerHandle = null }
      if (frameHandle != null) { cancelFrame(frameHandle); frameHandle = null }
      run = null
      try { observer?.disconnect?.() } catch { /* 忽略 */ }
      observer = null
      try { win?.removeEventListener?.('resize', onResize) } catch { /* 忽略 */ }
    },
  }
}
