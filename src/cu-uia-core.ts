/**
 * Computer Use 控件树通道的核心逻辑（纯函数，无 IO、无宿主依赖）。
 *
 * 口径（2026-11-27 定稿，docs/ComputerUse-优化-只增不减-改动清单-20261127.md）：
 *   视觉路线是唯一决策者——模型自己看图标坐标；控件树只做三件事：
 *     ① 前置候选清单（给模型一份「这页能点什么 + 在哪」的紧凑文本）；
 *     ② 编号框锚点（Set-of-Mark 的编号 ↔ 控件 id 一一对应，只画在观察帧副本上）；
 *     ③ 点击后的事后校验（只比对「落点是否在该控件 rect 内」）。
 *   五条硬约束（只增不减，违反即关通道）：
 *     a. 读不出（自绘 / canvas / 小程序 / 图片）→ 整帧退回纯视觉，编号框通道不启动，零额外开销；
 *     b. 按页面缓存复用，UI 变了才重跑，不每帧重解析；总步数只降不升；
 *     c. 校验只比对，不替模型决定点哪里；比对不中判「UI 已变」并清缓存；
 *     d. 禁 rollout / Best-of-N（它必然更慢）；
 *     e. 落地前同一任务新旧各跑一遍，步数或耗时变多就关掉通道（见 scripts/bench-cu-uia-core.mjs）。
 *
 * 本文件**不接线**任何现成管线：vendor/computer-use 的观察环（截图 → 模型）不在本插件里，
 * 按「不许改 vendor」的口径，接线点只能在插件侧（详见清单文档 §2、§3）。这里先把可测的部分钉死。
 */

/**
 * 探针预算：**每页一次**（结果进页面缓存，见 createPageCache），超了就整帧退回纯视觉（不重试）。
 *
 * 2026-11-27 本机实测：PowerShell 5.1 调起 UIAutomationClient 冷启动 ~190ms，
 * 一次枚举（Chrome 窗口、深度 ≤12、节点 ≤400）290–520ms。所以预算按「每页」给，
 * 按帧给会把所有页面都判死（那等于通道永远不启动），也与「只增不减」的目标相反：
 * 每帧的真实开销是 0.13–12.9µs（见 scripts/bench-cu-uia-core.mjs），探针只在换页时付一次。
 */
export const UIA_PROBE_BUDGET_MS = 1500
/** 少于这么多「可点控件」就认为树读不出（自绘 / canvas / 图片页的典型结果）。 */
export const UIA_MIN_CONTROLS = 3
/** 控件 rect 合计覆盖不到观察面这么大比例 → 认为树是空的（一堆 0 尺寸节点）。 */
export const UIA_MIN_COVERAGE = 0.01
/** 编号框最小边长：小于它画不出可读编号（也点不准）。 */
export const UIA_MARK_MIN_EDGE = 8
/** 一帧最多画多少个编号（多了反而干扰视觉辨认）。 */
export const UIA_MARK_MAX = 40
/** 候选清单文本上限（字符）：超了就按阅读顺序截断，绝不塞满上下文（每帧都进 prefill，宁短勿长）。 */
export const UIA_HINT_MAX_CHARS = 800
/** 候选清单最多列多少条（编号框可以画 40 个，文本只列前 20 条，省 token）。 */
export const UIA_HINT_MAX_ITEMS = 20
/** 页面缓存默认 TTL：30s 内同一页重复出现不重探。 */
export const UIA_PAGE_TTL_MS = 30_000
/** 缓存最多留几页。 */
export const UIA_PAGE_CACHE_MAX = 8
/** 事后校验的 rect 容差：短边 10%，最少 4px。 */
export const UIA_VERIFY_PADDING_RATIO = 0.1
export const UIA_VERIFY_PADDING_MIN_PX = 4
/** 动作记忆最多留多少条「页面 + 控件 → 坐标」。 */
export const UIA_ACTION_MEMORY_MAX = 200

/**
 * 可点角色的白名单（UIA ControlType 去掉 `ControlType.` 前缀后的名字）。
 * 2026-11-27 真机实测：不筛角色的话，Chrome 窗口前 40 个候选全是 Tab/Group/Pane，
 * 页面自己的按钮（如「更多操作」）根本挤不进清单——候选清单必须只留能点的东西。
 */
export const UIA_ACTIONABLE_ROLES = [
  'Button',
  'SplitButton',
  'Edit',
  'ComboBox',
  'CheckBox',
  'RadioButton',
  'Link',
  'Hyperlink',
  'MenuItem',
  'MenuBar',
  'ListItem',
  'TabItem',
  'TreeItem',
  'Slider',
  'Spinner',
]

export type UiaRect = { x: number; y: number; w: number; h: number }
export type UiaPoint = { x: number; y: number }

export type UiaControl = {
  name: string
  role: string
  rect: UiaRect
  enabled?: boolean
  automationId?: string
  /** 带编号之后才有：编号 = 该控件在本帧候选清单里的序号（1 起） */
  id?: number
}

export type UiaWindow = { title: string; className: string; rect: UiaRect }

/** 探针原始结果（读不出也要如实带回原因与耗时，方便判「不启动」）。 */
export type UiaProbeOutcome = {
  ok: boolean
  window: UiaWindow | null
  controls: UiaControl[]
  ms: number
  error?: string
}

export type ChannelDecision = {
  enabled: boolean
  /** ok / no-window / few-controls / too-slow / low-coverage / error */
  reason: 'ok' | 'no-window' | 'few-controls' | 'too-slow' | 'low-coverage' | 'error'
}

export function rectArea(rect: UiaRect | null | undefined): number {
  if (rect === null || rect === undefined) return 0
  const w = Number(rect.w)
  const h = Number(rect.h)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0
  return w * h
}

/** 控件 rect 合计覆盖（同一控件只算一次；用于「树是不是空的」判定）。 */
export function coverageOfControls(controls: readonly UiaControl[], windowRect: UiaRect | null | undefined): number {
  const total = rectArea(windowRect)
  if (total <= 0) return 0
  let sum = 0
  for (const control of controls ?? []) {
    const area = rectArea(control?.rect)
    if (area > 0) sum += Math.min(area, total)
  }
  return sum / total
}

/**
 * 第 ①③ 条硬约束的开关判定：**读不出 / 太慢 / 覆盖太少 → 不启动**（整帧退回纯视觉，零开销）。
 * 这里只做判断，不做任何 IO；调用方拿到 `enabled === false` 就必须整段跳过候选清单与编号框。
 */
export function decideControlChannel(outcome: UiaProbeOutcome | null | undefined, opts: {
  budgetMs?: number
  minControls?: number
  minCoverage?: number
} = {}): ChannelDecision {
  if (outcome === null || outcome === undefined) return { enabled: false, reason: 'no-window' }
  if (outcome.error !== undefined && outcome.error !== '') return { enabled: false, reason: 'error' }
  if (!outcome.ok) return { enabled: false, reason: 'error' }
  if (outcome.window === null) return { enabled: false, reason: 'no-window' }
  const budgetMs = Number(opts.budgetMs ?? UIA_PROBE_BUDGET_MS)
  const ms = Number(outcome.ms)
  if (!Number.isFinite(ms) || ms > budgetMs) return { enabled: false, reason: 'too-slow' }
  const controls = Array.isArray(outcome.controls) ? outcome.controls : []
  const usable = controls.filter((control) => rectArea(control?.rect) >= UIA_MARK_MIN_EDGE * UIA_MARK_MIN_EDGE)
  const minControls = Number(opts.minControls ?? UIA_MIN_CONTROLS)
  if (usable.length < minControls) return { enabled: false, reason: 'few-controls' }
  const minCoverage = Number(opts.minCoverage ?? UIA_MIN_COVERAGE)
  if (coverageOfControls(usable, outcome.window.rect) < minCoverage) return { enabled: false, reason: 'low-coverage' }
  return { enabled: true, reason: 'ok' }
}

/** 页面缓存键：进程名之外的四要素（窗口类名 / 标题 / 观察面矩形）。同页 → 同键。 */
export function pageCacheKey(win: UiaWindow | null | undefined): string {
  if (win === null || win === undefined) return ''
  const rect = win.rect
  const w = Math.max(0, Math.round(Number(rect?.w) || 0))
  const h = Math.max(0, Math.round(Number(rect?.h) || 0))
  return [String(win.className ?? ''), String(win.title ?? ''), w + 'x' + h].join('|')
}

/** 控件身份（跨帧稳定）：角色 + 名字 + AutomationId（没有 Id 就靠前两个）。 */
export function controlKeyOf(control: UiaControl | null | undefined): string {
  if (control === null || control === undefined) return ''
  const name = String(control.name ?? '').replace(/\s+/g, ' ').trim()
  const role = String(control.role ?? '').trim()
  const automationId = String(control.automationId ?? '').trim()
  if (name === '' && role === '' && automationId === '') return ''
  return automationId !== '' ? role + '#' + automationId : role + '|' + name
}

/**
 * 第 ② 条硬约束：页面缓存。同一页（键相同）在 TTL 内复用，不重解析；
 * `probe()` 只在 miss 时才真正跑探针——命中时开销是一次 Map 查询。
 */
export function createPageCache(opts: { ttlMs?: number; maxPages?: number; now?: () => number } = {}) {
  const ttlMs = Number(opts.ttlMs ?? UIA_PAGE_TTL_MS)
  const maxPages = Math.max(1, Number(opts.maxPages ?? UIA_PAGE_CACHE_MAX))
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const entries = new Map<string, { controls: UiaControl[]; at: number }>()
  let hits = 0
  let misses = 0
  let probes = 0
  const evict = () => {
    while (entries.size > maxPages) {
      const oldest = entries.keys().next()
      if (oldest.done === true) return
      entries.delete(oldest.value)
    }
  }
  return {
    get(key: string): UiaControl[] | null {
      const entry = entries.get(key)
      if (entry === undefined) { misses += 1; return null }
      if (now() - entry.at > ttlMs) { entries.delete(key); misses += 1; return null }
      hits += 1
      return entry.controls
    },
    set(key: string, controls: readonly UiaControl[]): void {
      if (key === '') return
      entries.set(key, { controls: Array.from(controls ?? []), at: now() })
      evict()
    },
    invalidate(key: string): void {
      entries.delete(key)
    },
    /** 只在 miss 时才调 probe：命中一次查询，漏掉才解析一次。 */
    async resolve(key: string, probe: () => Promise<UiaControl[]>): Promise<{ controls: UiaControl[]; probed: boolean }> {
      const cached = this.get(key)
      if (cached !== null) return { controls: cached, probed: false }
      probes += 1
      const controls = await probe()
      this.set(key, controls)
      return { controls, probed: true }
    },
    stats() {
      return { hits, misses, probes, size: entries.size }
    },
  }
}

/**
 * 第 ②③ 条：把探针结果收敛成「可画编号、可点」的控件（去噪 + 排序 + 截断）。
 * 规则：只留 enabled、边长 ≥ UIA_MARK_MIN_EDGE、面积小于观察面 90%（排除整页容器）、
 * 有名字或可识别角色；按阅读顺序（先 y 后 x）排，超过 UIA_MARK_MAX 截断。
 */
export function filterMarkableControls(controls: readonly UiaControl[], windowRect: UiaRect | null | undefined): UiaControl[] {
  const total = rectArea(windowRect)
  const usable: UiaControl[] = []
  const actionable = new Set(UIA_ACTIONABLE_ROLES)
  const isActionable = (role: string): boolean => actionable.has(String(role ?? '').trim())
  let keptActionable = false
  for (const control of controls ?? []) {
    if (control === null || control === undefined) continue
    if (control.enabled === false) continue
    const rect = control.rect
    const area = rectArea(rect)
    if (rect === null || rect === undefined) continue
    if (Math.round(Number(rect.w)) < UIA_MARK_MIN_EDGE || Math.round(Number(rect.h)) < UIA_MARK_MIN_EDGE) continue
    if (total > 0 && area > total * 0.9) continue
    if (String(control.name ?? '').trim() === '' && String(control.role ?? '').trim() === '') continue
    if (isActionable(control.role)) keptActionable = true
    usable.push(control)
  }
  // 第一轮只留可点角色；一个可点角色都没有（自绘 / 画布页）时退回「有名字的都算候选」，
  // 由 decideControlChannel 的 few-controls 规则决定要不要整帧退回纯视觉。
  const filtered = keptActionable ? usable.filter((control) => isActionable(control.role)) : usable
  filtered.sort((a, b) => (Math.round(a.rect.y) - Math.round(b.rect.y)) || (Math.round(a.rect.x) - Math.round(b.rect.x)))
  return filtered.slice(0, UIA_MARK_MAX)
}

export type UiaMark = { no: number; control: UiaControl; rect: UiaRect }

/**
 * 第 ② 步的编号框锚点：给每个可点控件分配一个从 1 开始的编号。
 * 返回空数组 = 这一帧不画编号（调用方必须原样返回原帧，零开销）。
 */
export function planMarks(controls: readonly UiaControl[], windowRect: UiaRect | null | undefined): UiaMark[] {
  const usable = filterMarkableControls(controls, windowRect)
  return usable.map((control, index) => {
    const no = index + 1
    const rect = { x: Math.round(control.rect.x), y: Math.round(control.rect.y), w: Math.round(control.rect.w), h: Math.round(control.rect.h) }
    return { no, control: { ...control, id: no }, rect }
  })
}

/** 坐标换算：窗口内相对坐标 → 屏幕绝对坐标（与 vendor/computer-use 的观察面 rect 同一基准）。 */
export function absolutePoint(win: UiaWindow | null | undefined, local: UiaPoint): UiaPoint | null {
  if (win === null || win === undefined) return null
  const x = Number(local?.x)
  const y = Number(local?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round(Number(win.rect.x) + x), y: Math.round(Number(win.rect.y) + y) }
}

/**
 * ② 的前置候选清单（喂给模型的紧凑文本）：控制字符数上限，空候选返回 ''（零开销）。
 * 格式刻意短：#编号 角色 "名字" @ (x,y,w,h) —— 坐标是绝对屏幕像素，
 * 模型仍自己决定点哪里（这里只提供候选与位置）。
 */
export function buildControlHintBlock(marks: readonly UiaMark[], opts: { maxChars?: number; maxItems?: number } = {}): string {
  const list = Array.from(marks ?? [])
  if (list.length === 0) return ''
  const maxChars = Number(opts.maxChars ?? UIA_HINT_MAX_CHARS)
  const maxItems = Math.max(1, Number(opts.maxItems ?? UIA_HINT_MAX_ITEMS))
  const lines: string[] = []
  let used = 0
  for (const mark of list.slice(0, maxItems)) {
    const name = String(mark.control?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    const role = String(mark.control?.role ?? '').trim()
    const rect = mark.rect
    const line = '#' + mark.no + ' ' + role + (name === '' ? '' : ' "' + name + '"') + ' @ (' + rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h + ')'
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

/**
 * 第 ③ 条：事后校验——只回答「这次点到的位置是不是落在那条控件的 rect 里」。
 * 绝不返回新坐标、绝不重发点击：miss 的唯一后果是调用方清缓存（判 UI 已变）。
 */
export function verifyClick(rect: UiaRect | null | undefined, clicked: UiaPoint | null | undefined, opts: { paddingRatio?: number; paddingMinPx?: number } = {}): 'hit' | 'miss' | 'unknown' {
  if (rect === null || rect === undefined) return 'unknown'
  if (clicked === null || clicked === undefined) return 'unknown'
  const w = Number(rect.w)
  const h = Number(rect.h)
  const x = Number(clicked.x)
  const y = Number(clicked.y)
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(x) || !Number.isFinite(y)) return 'unknown'
  if (w <= 0 || h <= 0) return 'unknown'
  const ratio = Number(opts.paddingRatio ?? UIA_VERIFY_PADDING_RATIO)
  const minPad = Number(opts.paddingMinPx ?? UIA_VERIFY_PADDING_MIN_PX)
  const pad = Math.max(minPad, Math.min(w, h) * ratio)
  const left = Number(rect.x) - pad
  const top = Number(rect.y) - pad
  const right = Number(rect.x) + w + pad
  const bottom = Number(rect.y) + h + pad
  return x >= left && x <= right && y >= top && y <= bottom ? 'hit' : 'miss'
}

export type ActionMemoryHit = { point: UiaPoint; controlKey: string }

/**
 * 第 ④ 条（坐标复用 / 动作记忆）：成功点击的「页面 + 控件 → 坐标」存下来，
 * 同类页面先复用；落空（verifyClick = miss）就 forget 该页面，退回重新看图算坐标。
 * 记忆只是**预案**：模型给的坐标永远优先于记忆（见 pickPoint）。
 */
export function createActionMemory(opts: { max?: number } = {}) {
  const max = Math.max(1, Number(opts.max ?? UIA_ACTION_MEMORY_MAX))
  const byPage = new Map<string, Map<string, UiaPoint>>()
  const touch = (pageKey: string): Map<string, UiaPoint> => {
    let page = byPage.get(pageKey)
    if (page === undefined) { page = new Map(); byPage.set(pageKey, page) }
    return page
  }
  return {
    remember(pageKey: string, control: UiaControl | string, point: UiaPoint): void {
      const key = typeof control === 'string' ? control : controlKeyOf(control)
      if (pageKey === '' || key === '') return
      const page = touch(pageKey)
      page.delete(key)
      page.set(key, { x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) })
      while (page.size > max) {
        const oldest = page.keys().next()
        if (oldest.done === true) break
        page.delete(oldest.value)
      }
    },
    recall(pageKey: string, control: UiaControl | string): ActionMemoryHit | null {
      const key = typeof control === 'string' ? control : controlKeyOf(control)
      const page = byPage.get(pageKey)
      if (page === undefined || key === '') return null
      const point = page.get(key)
      return point === undefined ? null : { point: { x: point.x, y: point.y }, controlKey: key }
    },
    forget(pageKey: string): void {
      byPage.delete(pageKey)
    },
    size(): number {
      let total = 0
      for (const page of byPage.values()) total += page.size
      return total
    },
  }
}

/**
 * 一次点击的最终坐标：模型给了就用模型的（视觉永远优先），没给才用记忆；
 * 记忆只在「同一页面 + 同一控件」命中时给出预案，绝不改写模型给的坐标。
 */
export function pickPoint(modelPoint: UiaPoint | null | undefined, memory: ActionMemoryHit | null): { point: UiaPoint | null; source: 'model' | 'memory' | 'none' } {
  const x = Number(modelPoint?.x)
  const y = Number(modelPoint?.y)
  if (Number.isFinite(x) && Number.isFinite(y)) return { point: { x: Math.round(x), y: Math.round(y) }, source: 'model' }
  if (memory !== null && memory !== undefined) return { point: { ...memory.point }, source: 'memory' }
  return { point: null, source: 'none' }
}
