// 手机端轻量诊断信标 + 跨 reload 存活的启动账本。
//
// 为什么需要它：会话详情反复跳页时，控制台在手机上取不到；sessionStorage
// 又会在 WebView 进程被杀时清空——上一版 boot-guard 正是因此失效。这里把
// 启动次数与关键事件写进 localStorage（进程被杀也留着），并批量 POST 到
// 宿主的 /.dsh-pocket/diag（lib/diagnostics.mjs 落盘到 profile），电脑上能
// 直接读文件判定「整页 reload」还是「面板/连接状态抖动」。
//
// 开销：每次启动一条 beacon；标题变化、悬浮球开关、点「查看执行」各一条；
// 布局探针每次加载一条（+ 跨过 1023 断点时补一条，见文件末尾）。
// localStorage 只存最近 12 次启动（约 1 KB），不存事件流水。

const BOOT_KEY = 'dsh-pocket.boot.v3'
const DEVICE_KEY = 'dsh-pocket.diag.device'
const WINDOW_MS = 60_000
const LOOP_THRESHOLD = 3

export interface BootInfo {
  /** 60 秒窗口内的启动次数（含本次）。 */
  count: number
  /** 判定为 reload 循环（同一会话 60 秒内第 3 次启动）。 */
  loop: boolean
  /** 本次启动时 localStorage 里记录的会话 id（空 = 首页/新会话）。 */
  sel: string
  /** 本机诊断 id（随机，跨 reload 不变）。 */
  device: string
}

interface BootEntry {
  t: number
  sel: string
  title: string
}

interface Ledger {
  device: string
  boots: BootEntry[]
  loop: boolean
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readSelection(): string {
  try {
    const raw = storage()?.getItem('dsh.sessions.current')
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
  } catch {
    return ''
  }
}

/** 立刻把主面板选择改成空对象：下一次 reload 的 restoreSelection 不会再回到该会话。 */
export function scrubSelection(): void {
  try {
    storage()?.setItem('dsh.sessions.current', '{}')
  } catch {
    /* 隐私模式 / 存储不可用 */
  }
}

function navigationType(): string {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return entry?.type ?? ''
  } catch {
    return ''
  }
}

function newDeviceId(): string {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }
}

function readLedger(): Ledger {
  const fallback: Ledger = { device: '', boots: [], loop: false }
  try {
    const raw = storage()?.getItem(BOOT_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Ledger>
    const boots = Array.isArray(parsed.boots)
      ? parsed.boots.filter((b): b is BootEntry => !!b && Number.isFinite(b.t))
      : []
    return {
      device: typeof parsed.device === 'string' && parsed.device ? parsed.device : '',
      boots: boots.slice(-12),
      loop: parsed.loop === true,
    }
  } catch {
    return fallback
  }
}

function writeLedger(ledger: Ledger): void {
  try {
    storage()?.setItem(BOOT_KEY, JSON.stringify(ledger))
  } catch {
    /* 静默 */
  }
}

let bootInfo: BootInfo | null = null

/**
 * 记录一次启动并判定是否陷入 reload 循环。
 * 判定条件：同一个非空 selection 在 60 秒内已经启动过 2 次（本次是第 3 次）。
 * 只认 selection，不认标题——标题格式随版本变化，selection 才是宿主恢复页面的依据。
 */
export function earlyBootCheck(now = Date.now()): BootInfo {
  const ledger = readLedger()
  if (!ledger.device) ledger.device = newDeviceId()
  const sel = readSelection()
  const recent = ledger.boots.filter((b) => now - b.t <= WINDOW_MS)
  const same = recent.filter((b) => b.sel !== '' && b.sel === sel).length
  const loop = sel !== '' && recent.length >= LOOP_THRESHOLD - 1 && same >= LOOP_THRESHOLD - 1
  if (loop) {
    // 先擦掉持久化选择，再记录本次启动——下一次 reload 不会再自动恢复该会话。
    scrubSelection()
    ledger.loop = true
  }
  const entry: BootEntry = {
    t: now,
    sel,
    title: String((globalThis as any).document?.title ?? '').slice(0, 120),
  }
  ledger.boots = [...recent, entry].slice(-12)
  writeLedger(ledger)
  bootInfo = { count: recent.length + 1, loop, sel, device: ledger.device }
  return bootInfo
}

/** 当前启动的判定结果（installDiag 之前调用会先做一次检测）。 */
export function getBootInfo(): BootInfo {
  return bootInfo ?? earlyBootCheck()
}

/** 循环解除后清掉 loop 标记，避免下一次正常刷新继续清主面板。 */
export function clearBootLoop(): void {
  const ledger = readLedger()
  if (!ledger.loop) return
  ledger.loop = false
  writeLedger(ledger)
}

function stackBrief(): string {
  try {
    const lines = String(new Error().stack ?? '').split('\n').slice(2, 6)
    return lines.map((line) => line.trim().replace(/^at\s+/, '')).join(' | ').slice(0, 500)
  } catch {
    return ''
  }
}

function post(payload: Record<string, unknown>): void {
  const url = '/.dsh-pocket/diag'
  let body: string
  try {
    body = JSON.stringify({
      ev: payload.ev,
      at: Date.now(),
      // 信封时间戳：探针会把 at 让位给时机标签（'pre' / 'post1' / 'post2'），
      // 所以每条事件都另带一个数值 ts，判读时靠它排时间线（原始 jsonl 按写入顺序 append）。
      ts: Date.now(),
      boot: bootInfo?.count ?? 0,
      loop: bootInfo?.loop ?? false,
      sel: bootInfo?.sel ?? '',
      device: bootInfo?.device ?? '',
      title: String((globalThis as any).document?.title ?? '').slice(0, 160),
      href: String((globalThis as any).location?.href ?? '').slice(0, 240),
      nav: navigationType(),
      ua: String((globalThis as any).navigator?.userAgent ?? '').slice(0, 240),
      ...payload,
    })
  } catch {
    return
  }
  if (body.length > 12_000) return
  try {
    const beacon = (globalThis as any).navigator?.sendBeacon
    if (typeof beacon === 'function') {
      beacon.call((globalThis as any).navigator, url, new Blob([body], { type: 'application/json' }))
      return
    }
  } catch {
    /* sendBeacon 不可用 → fetch */
  }
  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* 静默 */
  }
}

// ---- 手机布局探针（P0：远程取证用）--------------------------------------
//
// 为什么需要：手机上看不到 console，而「抽屉到底有没有挂上」取决于一串启动期条件：
// localStorage 里残留的 dsh-pocket.layout='desktop' → mobileApply 直接 early return
// → MOBILE_CSS 不注入、抽屉/backdrop/FAB 全不挂 → 官方侧栏退化成常驻 48px 图标 rail，
// 会话详情被挤窄。而 lib/proxy.mjs 的登录 302 会吞掉 URL 上的 ?dsh-layout（实测
// /?token=…&dsh-layout=auto → 回跳 /?dsh-pocket-auth=1 → href 只剩根路径），
// 所以"让人在地址上加参数"这条路取证不可靠，只能让客户端自己上报现场。
//
// 体积纪律：lib/diagnostics.mjs 一行一条 JSON、1 MB 轮转、readDiagnosticTail(200)
// 只读最近 200 行 —— 字段名一律取短，探针部分限 1.3 KB（post() 的公共字段
// title/href/ua 再占 ~700 B，整条 beacon 控制在 2 KB 内），不塞会话标题全文/消息内容。

const PROBE_FRAME_SELECTOR = '[data-shell-overlay]'
const PROBE_CSS_SELECTOR = 'style[data-plugin-css="@dsh-external/dsh-mobile-nav/mobile.css"]'
/** 与 client/mobile/layout-mode.mjs 的 NARROW_MEDIA 同一条线（官方 SIDEBAR_AUTO_COLLAPSE）。 */
const PROBE_NARROW_MEDIA = '(max-width: 1023px)'
const PROBE_MAX_WAIT_MS = 4000
const PROBE_POLL_MS = 200
const PROBE_DEBOUNCE_MS = 500
const PROBE_MAX_BYTES = 1100
const PROBE_VALUE_BYTES = 40
/** 只列 dsh 前缀的 key；布局三兄弟给值，主面板选择只报有无（不外泄会话 id）。 */
const PROBE_LAYOUT_KEYS = ['dsh-pocket.layout', 'dsh-pocket.layout.user', 'dsh-pocket.drawer']
const PROBE_MAX_OTHER_KEYS = 10

function shortText(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max)
}

/** AppFrame = shell overlay 层的父元素（与 client/mobile/drawer-state.mjs 同一判据）。 */
function probeFrame(doc: any): any | null {
  try {
    const overlay = doc?.querySelector?.(PROBE_FRAME_SELECTOR)
    return overlay?.parentElement ?? null
  } catch {
    return null
  }
}

/** 抽屉召唤入口计数：toggle=会话头汉堡，fab=浮动按钮，bk=backdrop，acts=抽屉页脚三钮。 */
function probeSlots(doc: any): Record<string, number> {
  const out: Record<string, number> = {}
  const pairs: [string, string][] = [
    ['tog', '[data-mobile-nav="toggle"]'],
    ['fab', '[data-mobile-nav="fab"]'],
    ['bk', '[data-mobile-nav="backdrop"]'],
    ['acts', '[data-mobile-nav="drawer-actions"]'],
  ]
  for (const [key, selector] of pairs) {
    try {
      out[key] = doc?.querySelectorAll?.(selector)?.length ?? 0
    } catch {
      out[key] = -1
    }
  }
  return out
}

/**
 * localStorage 里 dsh 前缀的 key：三个布局 key 直接给值（截 40 字），
 * dsh.sessions.current 只报有无，其它 key 只列名字（最多 10 个）——
 * 手机上两个 WebView（微信 XWEB / 小米浏览器）各有独立 localStorage，
 * 这条能一眼看出"这台设备上到底存了什么"。
 */
function probeStorage(win: any): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const ls = win?.localStorage
    if (!ls) return out
    const keys: string[] = []
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i)
      if (typeof key === 'string' && key.startsWith('dsh')) keys.push(key)
    }
    for (const key of PROBE_LAYOUT_KEYS) {
      // 三个布局 key **一律**出现：'unset' 和存了空值不是一回事，
      // auto-heal 之后就是 unset，判"残留值有没有被清掉"要看这个差别。
      out[key] = keys.indexOf(key) < 0 ? 'unset' : shortText(ls.getItem(key), PROBE_VALUE_BYTES)
    }
    if (keys.indexOf('dsh.sessions.current') >= 0) {
      out['dsh.sessions.current'] = ls.getItem('dsh.sessions.current') ? 'set' : 'empty'
    }
    const rest = keys.filter((key) => out[key] === undefined)
    for (let i = 0; i < rest.length && i < PROBE_MAX_OTHER_KEYS; i += 1) {
      out[`k${i}`] = shortText(rest[i], PROBE_VALUE_BYTES)
    }
    if (rest.length > PROBE_MAX_OTHER_KEYS) out['+'] = `+${rest.length - PROBE_MAX_OTHER_KEYS}`
  } catch {
    /* 隐私模式 / 禁用 storage → 空对象，本身就是证据 */
  }
  return out
}

/**
 * 宿主 shell.overlay 层里到底有谁（本次取证的核心）。
 * n = `[data-shell-overlay] > *` 的计数；who = 前 3 个子元素的
 * `TAG.class前24字[data-set 键前4个]`，用 '|' 连。
 * 判据：n=0，或 who 里没有我们的 pocket-heal-toast / mobile-nav-* / orb 节点，
 * 就说明"宿主没把插件的 slot 贡献渲染出来"，而不是我们没注册。
 */
function probeOverlayLayer(doc: any): { n: number; who: string } {
  let list: any = null
  try {
    list = doc?.querySelectorAll?.(`${PROBE_FRAME_SELECTOR} > *`) ?? null
  } catch {
    list = null
  }
  const n = Number(list?.length ?? 0)
  const parts: string[] = []
  for (let i = 0; i < n && i < 3; i += 1) {
    let el: any = null
    try {
      el = typeof list?.item === 'function' ? list.item(i) : list?.[i]
    } catch {
      el = null
    }
    if (!el) continue
    let keys: string[] = []
    try {
      keys = Object.keys(el.dataset ?? {}).slice(0, 4)
    } catch {
      /* dataset 读不到（SVG / 代理差异）→ 只留 tag.class */
    }
    parts.push(`${shortText(el.tagName, 12)}.${shortText(el.className, 24)}[${keys.join(',')}]`)
  }
  return { n, who: parts.join('|') }
}

/**
 * 手机布局阶段打点（本轮取证的核心）。
 * 宿主对插件 apply() 有 try/catch：mobileApply 中途抛异常会被**静默吞掉**
 * （诊断里连 PAGEERROR 都不会有），表现就是"前面的注册成功、后面的全没挂上"。
 * 所以每段边界主动发一条 beacon，异常也在原地 catch 住再发一条。
 * stage 序列：'attrs'（body 属性写完）→ 'slots'（全部 slot 注册完）
 * → 'effects'（全部 ctx.effect 登记完）→ 'done'（mobileApply 正常返回）。
 * 缺哪一段，就是死在哪一段。
 */
export function reportMobileStage(stage: string, extra: Record<string, unknown> = {}): void {
  try {
    post({ ev: 'mobile-stage', stage: shortText(stage, 48), ...extra })
  } catch {
    /* 诊断不能反过来打断启动 */
  }
}

/** 某一段抛异常：name / msg / stack 前 200 字（短字段纪律见文件顶部）。 */
export function reportMobileError(stage: string, error: unknown): void {
  try {
    const e = error as any
    post({
      ev: 'mobile-stage-error',
      stage: shortText(stage, 48),
      msg: shortText(e === null || e === undefined ? String(e) : String(e?.message ?? e ?? ''), 160),
      stack: shortText(String(e?.stack ?? ''), 200),
    })
  } catch {
    /* 同上 */
  }
}

/**
 * 采集一次布局现场（纯读，不改任何状态）。doc / win 可注入，便于单测。
 */
export function collectLayoutProbe(doc: any = (globalThis as any).document, win: any = (globalThis as any).window): Record<string, unknown> {
  const frame = probeFrame(doc)
  const first = frame?.firstElementChild ?? null
  let frameCss: any = null
  let firstCss: any = null
  try {
    if (frame) frameCss = win?.getComputedStyle?.(frame) ?? null
    if (first) firstCss = win?.getComputedStyle?.(first) ?? null
  } catch {
    /* jsdom/老 WebView 差异 → 留空 */
  }
  let rect: any = null
  try {
    rect = first?.getBoundingClientRect?.() ?? null
  } catch {
    /* 忽略 */
  }
  let mq = false
  try {
    mq = win?.matchMedia?.(PROBE_NARROW_MEDIA)?.matches === true
  } catch {
    /* 忽略 */
  }
  const rectLeft = Number(rect?.left)
  const rectWidth = Number(rect?.width)
  return {
    w: Number(win?.innerWidth) || 0,
    h: Number(win?.innerHeight) || 0,
    dpr: Number(win?.devicePixelRatio) || 0,
    mq,
    // MOBILE_CSS 有没有注入 = mobileApply 有没有走完（'desktop' 分支会 early return）
    css: !!doc?.querySelector?.(PROBE_CSS_SELECTOR),
    // body 上的生效布局 + 来源（'url'|'storage'|'auto-media'|'auto-healed'）
    ly: shortText(doc?.body?.getAttribute?.('data-dsh-pocket-layout'), 8),
    src: shortText(doc?.body?.getAttribute?.('data-dsh-pocket-layout-src'), 12),
    // AppFrame 在不在 + 我们打的 marker + 官方 collapsed + 自持抽屉 marker
    frame: !!frame,
    marker: shortText(frame?.getAttribute?.('data-mobile-nav'), 12),
    collapsed: frame?.hasAttribute?.('data-sidebar-collapsed') === true,
    drawer: shortText(frame?.getAttribute?.('data-dshp-drawer'), 8),
    grid: shortText(frameCss?.gridTemplateColumns, 60),
    // 关键：侧栏列到底在不在流里（离屏 transform / absolute 脱流都会在这里露馅）
    fc: {
      tag: shortText(first?.tagName, 14),
      cls: shortText(first?.className, 30),
      left: Number.isFinite(rectLeft) ? Math.round(rectLeft) : -99999,
      w: Number.isFinite(rectWidth) ? Math.round(rectWidth) : -99999,
      pos: shortText(firstCss?.position, 12),
      tf: shortText(firstCss?.transform, 40),
    },
    slots: probeSlots(doc),
    // shell.overlay 层里有谁 + 我们的短暂提示在不在里面（slot 是否真的被宿主渲染）
    ov: probeOverlayLayer(doc),
    toast: (() => {
      try {
        return doc?.querySelectorAll?.('[data-dshp-heal-toast]')?.length ?? 0
      } catch {
        return -1
      }
    })(),
    ls: probeStorage(win),
  }
}

/**
 * 组装探针 payload，并把体积压进上限（超了先扔 ls，再扔 slots，核心字段必须留）。
 * @param doc - 文档对象（注入便于单测）。
 * @param win - window 对象（注入便于单测）。
 * @param at - 采样时机：'pre' = mobileApply 之前/同期的挂载前基线（不可信，只做对照），
 *   'post1' / 'post2' = mobileApply 发完 stage:'done' 之后 1.2s / 3.2s 的复检（判抽屉挂没挂只认这两条）。
 */
export function buildLayoutProbe(doc: any, win: any, at: string = 'pre'): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ev: 'layout-probe',
    at: shortText(at, 6),
    ...collectLayoutProbe(doc, win),
  }
  const fits = (): boolean => {
    try {
      return JSON.stringify(payload).length <= PROBE_MAX_BYTES
    } catch {
      return false
    }
  }
  if (!fits()) delete payload.ls
  if (!fits()) delete payload.slots
  // fc（rail 的 left/width/position/transform）与 ov（[data-shell-overlay] 的子元素计数 +
  // 前 3 个子元素身份，含 dataset 键名 who）是判抽屉/rail 的核心，**永远不删**。
  return payload
}

/** post 复检的延迟：+1200ms（抽屉 CSS 过渡 0.28s 早已走完）与 +3200ms（宿主懒渲染兜底）。 */
export const PROBE_POST_DELAYS_MS: number[] = [1200, 3200]

/** 每次加载最多 3 条探针：1 条 pre 基线 + 2 条 post 复检（限速 120/min 不是瓶颈，纪律在客户端）。 */
const PROBE_MAX_SENDS = 3
/** 基线只发一次：跨过 1023 断点的转屏补发让位给 post 复检（转屏后想看现场就刷新页面）。 */
const PROBE_MAX_PRE_SENDS = 1

let probePreSends = 0
let probePostSends = 0
let probePostScheduledForOrigin = -1

/**
 * 统一的探针出口：带时机标签 + 每加载预算。
 * @returns 是否真的发出去了（预算用尽返回 false，调用方不必知道）。
 */
function sendLayoutProbeAt(at: string, doc: any, win: any): boolean {
  if (probePreSends + probePostSends >= PROBE_MAX_SENDS) return false
  if (at === 'pre') {
    if (probePreSends >= PROBE_MAX_PRE_SENDS) return false
    probePreSends += 1
  } else {
    probePostSends += 1
  }
  try {
    post(buildLayoutProbe(doc, win, at))
  } catch {
    /* 探针坏了不能影响业务 */
  }
  return true
}

/**
 * mobileApply 走完（stage:'done' 已发）之后排两次复检探针。
 * 为什么必须补这一发（14:58 那轮实测）：installLayoutProbe 在 installDiag 里装，比
 * mobileApply 还早；它等 AppFrame 一挂上就发，于是拿到的是 css=false / marker='' /
 * slots 全 0 / ov.n=1 的**挂载前**现场 —— 与同一秒的 mobile-stage 四段全通自相矛盾。
 * 所以：pre 只当基线，判抽屉到底挂没挂只看 at:'post1' / at:'post2'。
 * 只在抽屉分支调用（电脑布局没必要发），且每次加载只排一次。
 * @param doc - 文档对象（默认 globalThis.document）。
 * @param win - window 对象（默认 globalThis.window）。
 */
export function schedulePostMobileProbes(
  doc: any = (globalThis as any).document,
  win: any = (globalThis as any).window,
): void {
  if (!doc || !win || typeof win.setTimeout !== 'function') return
  const origin = Number(win?.performance?.timeOrigin ?? 0)
  const key = origin !== 0 ? origin : -1
  if (probePostScheduledForOrigin === key) return
  probePostScheduledForOrigin = key
  PROBE_POST_DELAYS_MS.forEach((delay: number, index: number): void => {
    const at = index === 0 ? 'post1' : 'post2'
    try {
      win.setTimeout(() => sendLayoutProbeAt(at, doc, win), delay)
    } catch {
      /* setTimeout 不可用：少一条复检，不影响业务 */
    }
  })
}

let probeInstalledForOrigin = -1

/**
 * 布局探针：等 AppFrame 挂上再发一次基线（最多 4s 超时也发一次，frame=false 本身就是证据），
 * 之后只在宽度跨过 1023 那条线时补发一次（防抖 500ms）。不轮询、不常驻。
 * 基线的时机标签是 'pre'：它可能发在 mobileApply 之前，判据不可信，只作对照。
 */
export function installLayoutProbe(doc: any = (globalThis as any).document, win: any = (globalThis as any).window): void {
  if (!doc || !win || typeof win.setTimeout !== 'function') return
  const origin = Number(win?.performance?.timeOrigin ?? 0)
  if (origin !== 0 && probeInstalledForOrigin === origin) return
  if (origin !== 0) probeInstalledForOrigin = origin
  // 新一轮加载：清空探针预算（每次加载最多 3 条 = 1 pre + 2 post）。
  probePreSends = 0
  probePostSends = 0

  const send = (): void => {
    sendLayoutProbeAt('pre', doc, win)
  }
  let waited = 0
  const tick = (): void => {
    if (probeFrame(doc) !== null) {
      send()
      return
    }
    waited += PROBE_POLL_MS
    if (waited >= PROBE_MAX_WAIT_MS) {
      // 4s 还没挂上：照样发，字段里 frame=false / css=false 就是"mobile 那套根本没跑"的证据
      send()
      return
    }
    win.setTimeout(tick, PROBE_POLL_MS)
  }
  tick()

  try {
    const query = win?.matchMedia?.(PROBE_NARROW_MEDIA)
    if (!query || typeof query.addEventListener !== 'function') return
    let timer: any = null
    query.addEventListener('change', () => {
      if (timer !== null) win.clearTimeout(timer)
      timer = win.setTimeout(send, PROBE_DEBOUNCE_MS)
    })
  } catch {
    /* 老 WebView 没有 addEventListener(matchMedia) → 首帧数据已够判 */
  }
}

let installedForOrigin = -1

/**
 * 安装诊断：只做一次性启动记录 + 轻量事件监听，不改变任何业务状态。
 * @param _ctx - 客户端上下文（保留参数，便于以后读取 services）。
 */
export function installDiag(_ctx?: any): void {
  const origin = Number((globalThis as any).performance?.timeOrigin ?? 0)
  if (origin !== 0 && installedForOrigin === origin) return
  if (origin !== 0) installedForOrigin = origin

  const info = getBootInfo()
  post({ ev: 'boot', count: info.count })
  post({ ev: 'diag-ready' })
  // 布局探针（P0 取证）：等 AppFrame 挂上发一次，跨 1023 断点再补一次。
  // 独立 try/catch —— 探针挂了什么诊断事件都不能少。
  try {
    installLayoutProbe()
  } catch {
    /* 忽略 */
  }

  // 标题变化（详情 ↔ 列表的最直接信号）：原来是「前 10 秒每 1s、之后每 5s 读一次 document.title」
  // 而且永不自停 —— 手机布局把标题钉成产品名后这条几乎全是空读。
  // 现在直接观察 <title> 本体：标题真变了才报；观察不上（没有 title 元素 / 老 WebView）才退回慢速采样。
  let lastTitle = String((globalThis as any).document?.title ?? '')
  let titleTimer: number | null = null
  let titleObserver: MutationObserver | null = null
  const sampleTitle = (): void => {
    const next = String((globalThis as any).document?.title ?? '')
    if (next === lastTitle) return
    lastTitle = next
    post({ ev: 'title', value: next.slice(0, 160) })
  }
  const titleEl = (globalThis as any).document?.querySelector?.('title') ?? null
  if (titleEl !== null && typeof (globalThis as any).MutationObserver === 'function') {
    try {
      titleObserver = new (globalThis as any).MutationObserver(() => { sampleTitle() }) as MutationObserver
      titleObserver.observe(titleEl, { childList: true, subtree: true, characterData: true })
    } catch {
      titleObserver = null
    }
  }
  if (titleObserver === null) {
    const start = Date.now()
    const tick = (): void => {
      sampleTitle()
      const elapsed = Date.now() - start
      const delay = elapsed < 10_000 ? 1000 : 5000
      titleTimer = (globalThis as any).setTimeout(tick, delay)
    }
    titleTimer = (globalThis as any).setTimeout(tick, 600)
  }

  const onHide = (): void => post({ ev: 'pagehide', visibility: String((globalThis as any).document?.visibilityState ?? '') })
  const onShow = (): void => post({ ev: 'pageshow', visibility: String((globalThis as any).document?.visibilityState ?? '') })
  try {
    (globalThis as any).addEventListener?.('pagehide', onHide)
    (globalThis as any).addEventListener?.('pageshow', onShow)
    ;(globalThis as any).document?.addEventListener?.('visibilitychange', () => {
      post({ ev: 'visibility', value: String((globalThis as any).document?.visibilityState ?? '') })
    })
    ;(globalThis as any).addEventListener?.('error', (event: any) => {
      post({ ev: 'js-error', message: String(event?.message ?? '').slice(0, 300) })
    })
    ;(globalThis as any).addEventListener?.('unhandledrejection', (event: any) => {
      post({ ev: 'js-rejection', message: String(event?.reason?.message ?? event?.reason ?? '').slice(0, 300) })
    })
  } catch {
    /* 忽略 */
  }

  // 页面卸载时停掉计时器与观察器（不影响业务）。
  try {
    (globalThis as any).addEventListener?.('pagehide', () => {
      if (titleTimer !== null) (globalThis as any).clearTimeout(titleTimer)
      try { titleObserver?.disconnect() } catch { /* 忽略 */ }
    })
  } catch {
    /* 忽略 */
  }
}

/** 悬浮球面板开/关：带调用来源与调用栈，用来判定「是不是有东西把面板重新打开」。 */export function noteOrb(open: boolean, source: string): void {
  post({ ev: 'orb', open, source, stack: stackBrief() })
}

/** 用户点「查看执行」。 */
export function noteOpenSession(sessionId: string): void {
  post({ ev: 'open-session', sessionId })
}

/** 悬浮球「点开」后被护栏吞掉的穿透点击（累计次数）：
 * 有这个信标就说明「同一次点击被处理两遍」确实发生了、并且被拦下。 */
export function noteOrbSwallow(total: number): void {
  post({ ev: 'orb-swallow', count: total })
}
