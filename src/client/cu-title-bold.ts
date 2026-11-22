/**
 * 左侧面板「Computer Use 会话标题加粗」（2026-11-22 用户新需求）。
 *
 * 目标：DSH 左侧面板的会话列表里，凡 Computer Use 模式的会话，标题加粗；标准会话不动。
 * 纯客户端（lib/client.js）：不碰宿主文件、不新建宿主路由、不需要重启宿主，页面刷新即生效。
 *
 * ── 宿主 DOM 取证（只读，2026-11-22，从 app.asar 里 dsh/node_modules/@deepseek-ai/
 *    dsh-client-ui-workspace/lib/client.js 读出，未改任何宿主文件）──
 *    会话行（SessionRow）渲染形状：
 *      <div data-row-key={`session:${node.id}`}  class="…​_sessionRow …" role="treeitem"
 *           aria-selected=… >
 *        <span class="…​_slot">…</span>
 *        <span class="…​_title">标题</span>
 *        <span class="…​_time">…</span>
 *      </div>
 *    项目/分组行是 `data-row-key="workspace:<key>"`（同一属性、不同前缀），搜索结果行
 *    没有 data-row-key（只有 role="treeitem" + …_searchResultTitle）。
 *    → 稳定判据 = `data-row-key` 的 `session:` 前缀（会话 id 就在这把钥匙上），
 *      标题元素 = 行内 `[class*="_title"]`（CSS-module 前缀 `hIlkoa_` 会随宿主版本变，
 *      所以只认「小写 _title」这段局部名；`searchResultTitle`/`hoverTitle` 是大写 Title，
 *      区分大小属性的属性选择器不会误命中）。
 *    行内没有任何宿主自带的 preset/type 标记（宿主只把 preset 放在会话投影 `agentPreset`，
 *    列表快照里是 `byId[id].projectionValues.agentPreset`），所以「哪一行是 CU」只能由
 *    插件自己按 id 打标记 —— 打的是插件自己的属性，不改宿主类名、不写内联样式。
 *
 * ── CU 判据（与本插件既有口径同一套字段）──
 *    src/assistant-dispatch.ts 的 listSessionRows 读 `header.agentPreset / header.origin /
 *    header.delegationDepth`，分层 B 续接的谓词是
 *      row.agentPreset === 'computer-use' && row.origin !== 'subagent' && delegationDepth === 0
 *    （src/assistant-cu-watch.ts 的 shouldReportCompletion 同款）。
 *    storages/session_projcache 实测取值（2026-11-22 扫 3321 个投影缓存文件）：
 *      agentPreset = standard 2566 / computer-use 493 / cordis 28 / standard-slim-local 14 /
 *                    minimal 2 / 老会话 null 218，字段名与取值都与上面谓词一致。
 *    视觉区分只需要「是不是 Computer Use」这一件事，判据 = `agentPreset === 'computer-use'`；
 *    血缘（origin=subagent / delegationDepth>0）只用于派活续接与完成汇报的口径，不参与样式
 *    ——CU 会话后台 code_agent 派出来的是标准预设会话，本来就不该加粗。
 *
 * ── 数据来源与增量 ──
 *    页面侧复用插件已有通道 `ctx.sessions.list`（宿主给客户端的会话列表 store，
 *    侧栏本身也吃这份数据；orb-api.ts 已在用 `getSnapshot()` + `projectionValues`）：
 *      - 集合：snapshot.ids / byId[id].projectionValues.agentPreset；
 *      - 增补：snapshot.projectionsBySession[id].values（显式基线下发的那份）；
 *      - 列表分页/新会话：store 变化走 sessions.list.subscribe → 全量对齐已有行；
 *        宿主新插入的行（分页翻页、新会话、重排）走 MutationObserver 增量处理 addedNodes，
 *        并按 CU_RECONCILE_MS 合并、走 domGate（用户正在输入 / 抽屉动画时让路）。
 *    实测宿主 `/api/sessions` 需要页面认证（裸 Node GET 返回 401），且响应里没有我们
 *    依赖的投影形状，所以不引入 fetch，避免多一条会随宿主升级漂移的通道。
 */

import { domGate, createGatedThrottle } from './compositionGate.ts'

/** Computer Use 预设 id（与 src/assistant-dispatch.ts 的 CU_AGENT_PRESET、src/assistant-cu-watch.ts 的 CU_PRESET 同值）。 */
export const CU_AGENT_PRESET = 'computer-use'

/** 插件打在会话行上的标记（插件命名空间属性，不借宿主类名，宿主升级不碎）。 */
export const CU_ROW_ATTR = 'data-dsh-cu'

/** 注入的 <style> 标签标识（dataset.plugin）。 */
export const CU_STYLE_PLUGIN_KEY = 'dsh-assistant-cu-title'

/** 宿主会话行的稳定选择器：`data-row-key="session:<sessionId>"`。 */
export const SESSION_ROW_SELECTOR = '[data-row-key^="session:"]'
/** 会话 id 在行上的钥匙前缀（项目行是 `workspace:`，不是会话）。 */
export const SESSION_ROW_KEY_PREFIX = 'session:'
/** 行内标题元素选择器（宿主 CSS-module 局部名 `title`，小写）。 */
export const TITLE_SELECTOR = '[class*="_title"]'

/** MutationObserver / store 订阅的合并窗口（也用于让路重试）。 */
export const CU_RECONCILE_MS = 300
/** 闸门让路时的重试间隔。 */
const CU_SKIP_MS = 500
/** 连续让路上限：超过强跑一次，绝不让标记憋死。 */
const CU_MAX_SKIPS = 12
/** 单次增量批次的节点上限（宿主重渲染风暴时也别把内存吃满）。 */
const CU_BATCH_LIMIT = 400

/** 本插件客户端模块级单例键（HMR/重复 apply 时先拆旧的）。 */
export const CU_INSTALL_KEY = '__dshAssistantCuTitleBold'

/**
 * 注入的样式表：只加 font-weight，别的排版一律不碰。
 * 写成字面量（不用常量拼接）是为了构建产物里能直接 grep 到这条规则，
 * 门禁 test-cu-title-bold 的 C0「构建契约」靠它抓「源码改了、产物没改」。
 * 选择器权重 = 行上两个属性 + 标题一个属性（0,3,0），高于宿主
 * `.hIlkoa_sessionRow .hIlkoa_title`（0,2,0），与注入顺序无关。
 */
export const CU_TITLE_BOLD_CSS = '[data-dsh-cu="1"][data-row-key^="session:"] [class*="_title"]{font-weight:700}'

export function cuTitleBoldCss(): string {
  return [
    '/* dsh-assistant：左侧面板 Computer Use 会话标题加粗（只改 font-weight，其它排版不动） */',
    CU_TITLE_BOLD_CSS,
  ].join('\n')
}

/** 从 `data-row-key` 取会话 id；不是会话行（workspace: 前缀 / 空）返回空串。 */
export function sessionIdFromRowKey(key: unknown): string {
  const value = String(key ?? '').trim()
  if (value === '') return ''
  if (!value.startsWith(SESSION_ROW_KEY_PREFIX)) return ''
  const id = value.slice(SESSION_ROW_KEY_PREFIX.length).trim()
  // 项目行 key 形如 `workspace:<uuid>`；会话行不应再带冒号（会话 id 自身不含冒号）。
  if (id === '' || id.includes(':')) return ''
  return id
}

/**
 * 取一个会话行的 agent 预设：列表快照里投影可能出现在四个位置（实测形状）——
 *   1. row.projectionValues.agentPreset（projectList 拍平后的实际所在）
 *   2. row.projections.values.agentPreset
 *   3. row.agentPreset / row.header.agentPreset（宿主把 header 直接摊到行上时的形状）
 *   4. {val} / {value} 包装（投影块对象）
 * 都取不到 = 空串（按标准模式处理，不加粗）。
 */
export function presetOfSessionRow(row: any): string {
  if (row === null || row === undefined || typeof row !== 'object') return ''
  const candidates = [
    row.projectionValues?.agentPreset,
    row.projections?.values?.agentPreset,
    row.agentPreset,
    row.header?.agentPreset,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
    if (candidate !== null && typeof candidate === 'object') {
      const inner = (candidate as any).val ?? (candidate as any).value
      if (typeof inner === 'string' && inner !== '') return inner
    }
  }
  return ''
}

/**
 * 这条会话是不是 Computer Use 类型（视觉判据）。
 * 只看 preset：标准 / cordis / 空 → 不加粗；血缘不影响视觉（见文件头注释）。
 */
export function isComputerUseSessionRow(row: any): boolean {
  return presetOfSessionRow(row) === CU_AGENT_PRESET
}

/**
 * 会话列表快照 → Computer Use 会话 id 集合。
 * 兼容两种快照形状：`{ids, byId}`（宿主列表 store）与扁平数组；
 * 另外兜底读 `projectionsBySession[id].values`（显式基线下发的那份缓存）。
 */
export function cuSessionIdsOfSnapshot(snapshot: any): Set<string> {
  const ids = new Set<string>()
  if (snapshot === null || snapshot === undefined) return ids
  const entries: Array<[string, any]> = []
  if (Array.isArray(snapshot)) {
    for (const row of snapshot) {
      const id = String(row?.sessionId ?? row?.id ?? '').trim()
      if (id !== '') entries.push([id, row])
    }
  } else {
    const byId = snapshot.byId ?? {}
    const order = Array.isArray(snapshot.ids) && snapshot.ids.length > 0
      ? snapshot.ids
      : Object.keys(byId)
    for (const id of order) {
      const key = String(id ?? '').trim()
      if (key === '') continue
      const row = byId[key] ?? {}
      entries.push([key, row])
    }
    const shared = snapshot.projectionsBySession
    if (shared !== null && typeof shared === 'object') {
      for (const [id, block] of Object.entries(shared)) {
        const preset = (block as any)?.values?.agentPreset
        if (preset === CU_AGENT_PRESET && String(id ?? '').trim() !== '') ids.add(String(id))
      }
    }
  }
  // 行快照多数不带 origin/delegationDepth（那是 header 上的血缘字段，只用于派活口径），
  // 这里一律按 preset 判定哪条是 Computer Use。
  for (const [id, row] of entries) {
    if (isComputerUseSessionRow(row)) ids.add(id)
  }
  return ids
}

/** 会话行 DOM 工具：从 `document` 里拿全部会话行。 */
export function collectSessionRows(doc: any): any[] {
  const rows: any[] = []
  try {
    const found = doc?.querySelectorAll?.(SESSION_ROW_SELECTOR)
    if (!found) return rows
    for (const el of Array.from(found as ArrayLike<any>)) rows.push(el)
  } catch { /* 不是真 DOM（Node 单测里只跑纯函数） */ }
  return rows
}

/**
 * 按 CU 集合对齐一批行（增量入口：MutationObserver 只喂新增节点，也喂 store 变化后的全量行）。
 * @returns 本次真正改动标记的行数（已正确的不动，避免宿主白重排）。
 */
export function markRows(rows: any[], cuIds: Set<string>): number {
  let changed = 0
  for (const el of rows) {
    try {
      if (el === null || el === undefined || typeof el.getAttribute !== 'function') continue
      const sessionId = sessionIdFromRowKey(el.getAttribute('data-row-key'))
      if (sessionId === '') continue
      const want = cuIds.has(sessionId) ? '1' : ''
      const now = el.getAttribute(CU_ROW_ATTR) ?? ''
      if (now === want) continue
      if (want === '1') el.setAttribute(CU_ROW_ATTR, '1')
      else el.removeAttribute(CU_ROW_ATTR)
      changed += 1
    } catch { /* 单行出错不能让整批崩掉 */ }
  }
  return changed
}

/** 全页对齐（store 变化后用；只碰会话行）。 */
export function reconcileSessionRows(doc: any, cuIds: Set<string>): number {
  return markRows(collectSessionRows(doc), cuIds)
}

/** 注入样式标签，返回注销函数（已存在同一 plugin 标记的样式先拆掉，HMR 不叠加）。 */
export function injectCuTitleStyle(doc: any): () => void {
  if (doc === null || doc === undefined || typeof doc.createElement !== 'function') return () => {}
  const head = doc.head ?? doc.documentElement
  if (head === null || head === undefined || typeof head.appendChild !== 'function') return () => {}
  const tag = doc.createElement('style')
  try {
    tag.setAttribute('data-plugin', CU_STYLE_PLUGIN_KEY)
    tag.textContent = cuTitleBoldCss()
  } catch { /* 造不出样式标签就不装 */ }
  const stale = doc.querySelector?.(`style[data-plugin="${CU_STYLE_PLUGIN_KEY}"]`)
  if (stale && typeof stale.remove === 'function') stale.remove()
  head.appendChild(tag)
  return () => { try { tag.remove() } catch { /* 已被移除 */ } }
}

/**
 * 装「CU 标题加粗」：样式注入 + CU 集合订阅 + 行标记观察者。
 * 任何一步失败都只影响视觉区分，绝不抛错到客户端装配层。
 *
 * @param options.ctx - 客户端 ctx（需要 sessions.list）。
 * @param options.doc - 注入点（测试可传假 document）。
 * @param options.Observer - MutationObserver 构造器（测试注入）。
 * @param options.schedule / options.cancel - 定时器注入（测试可假时钟）。
 * @returns 注销函数。
 */
export function installCuTitleBold(options: {
  ctx?: any
  doc?: any
  Observer?: any
  schedule?: (fn: () => void, ms: number) => any
  cancel?: (handle: any) => void
}): () => void {
  const ctx = options.ctx ?? {}
  const doc = options.doc ?? (globalThis as any).document
  if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return () => {}
  const Observer = options.Observer ?? (globalThis as any).MutationObserver
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle: any) => clearTimeout(handle))

  const disposers: Array<() => void> = []

  // 1) 样式表（注入样式 + 行上打属性，不用逐条内联样式）
  try { disposers.push(injectCuTitleStyle(doc)) } catch { /* 样式挂不上只影响视觉 */ }

  // 2) CU 集合：复用插件已有的宿主会话列表 store（侧栏自己就吃这份数据）
  const list = ctx?.sessions?.list ?? null
  let cuIds = new Set<string>()
  const readIds = (): Set<string> => {
    try {
      if (list === null || typeof list.getSnapshot !== 'function') return cuIds
      const snap = list.getSnapshot()
      if (snap !== null && snap !== undefined) cuIds = cuSessionIdsOfSnapshot(snap)
    } catch { /* 快照读不到：保留上一次集合，别把标记清空 */ }
    return cuIds
  }

  // 3) 行标记：节流合并 + domGate 让路（用户在输入框打字 / 抽屉开合时不碰 DOM）
  let fullPass = false
  const pending = new Set<any>()
  const run = (): void => {
    if (pending.size === 0 && !fullPass) return
    const batch = fullPass ? collectSessionRows(doc) : Array.from(pending)
    pending.clear()
    fullPass = false
    markRows(batch, readIds())
  }
  const scheduleRun = createGatedThrottle({ run, gate: domGate, waitMs: CU_RECONCILE_MS, skipMs: CU_SKIP_MS, maxSkips: CU_MAX_SKIPS, schedule, cancel })

  // 3a) 列表变化（分页取回、新会话、preset 落定）→ 全量对齐已有行
  try {
    if (list !== null && typeof list.subscribe === 'function') {
      const dispose = list.subscribe(() => { fullPass = true; scheduleRun() })
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch { /* 老宿主列表不可订阅：只剩观察者 */ }

  // 3b) 宿主新插入的行（分页/新会话/重排）→ 只处理增量节点
  let observer: any = null
  if (typeof Observer === 'function') {
    observer = new Observer((mutations: any[]) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const target = mutation?.target
          if (target) pending.add(target)
          continue
        }
        if (mutation.type !== 'childList') continue
        for (const node of Array.from(mutation?.addedNodes ?? [])) {
          if (pending.size >= CU_BATCH_LIMIT) break
          if (node === null || node === undefined) continue
          if (node.nodeType === 1) {
            if (typeof node.matches === 'function' && node.matches(SESSION_ROW_SELECTOR)) pending.add(node)
            else if (typeof node.querySelector === 'function' && node.querySelector(SESSION_ROW_SELECTOR) !== null) {
              for (const row of Array.from(node.querySelectorAll(SESSION_ROW_SELECTOR))) pending.add(row)
            }
          } else if (node.nodeType === 3 && typeof node.parentElement?.closest === 'function') {
            const row = node.parentElement.closest(SESSION_ROW_SELECTOR)
            if (row) pending.add(row)
          }
        }
      }
      if (pending.size > 0) scheduleRun()
    })
    try {
      observer.observe(doc.body ?? doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-row-key'],
      })
      disposers.push(() => { try { observer.disconnect() } catch { /* 已断开 */ } })
    } catch { /* 观察者挂不上：只剩全量对齐 */ }
  }

  // 4) 首屏：先按当前快照全量对齐一次（异步订阅再补一次，覆盖投影还没落定的冷会话）
  fullPass = true
  scheduleRun()
  try {
    if (typeof schedule === 'function') {
      const later = schedule(() => { fullPass = true; scheduleRun() }, CU_RECONCILE_MS)
      disposers.push(() => { try { cancel(later) } catch { /* 已跑 */ } })
    }
  } catch { /* 没有定时器就用订阅那一轮 */ }

  return () => {
    // 先把自己打在行上的标记清干净（拆安装 = 页面回到宿主原生样子），再拆样式与观察者。
    try { markRows(collectSessionRows(doc), new Set<string>()) } catch { /* 行已经不在页面里了 */ }
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch { /* 幂等 */ }
    }
  }
}

/**
 * 客户端装配入口（assistant.tsx 调用）：同一个页面只留一份安装，
 * 重复 apply（配置 HMR）先拆旧的再装新的，不叠观察者、不叠样式。
 */
export function applyCuTitleBold(ctx: any, scope: any = globalThis, options: Record<string, any> = {}): () => void {
  const previous = scope?.[CU_INSTALL_KEY]
  if (typeof previous === 'function') {
    try { previous() } catch { /* 旧的已拆 */ }
  }
  let dispose = (): void => {}
  try {
    dispose = installCuTitleBold({ ctx, ...options })
  } catch {
    return () => {}
  }
  const teardown = (): void => {
    try { dispose() } catch { /* 幂等 */ }
    try { if (scope && scope[CU_INSTALL_KEY] === teardown) delete scope[CU_INSTALL_KEY] } catch { /* 非浏览器环境 */ }
  }
  try { if (scope) scope[CU_INSTALL_KEY] = teardown } catch { /* 非浏览器环境 */ }
  return teardown
}

/** 单测入口（scripts/test-cu-title-bold.mjs）。 */
export const cuTitleBoldTestSurface = {
  CU_AGENT_PRESET,
  CU_ROW_ATTR,
  CU_STYLE_PLUGIN_KEY,
  SESSION_ROW_SELECTOR,
  SESSION_ROW_KEY_PREFIX,
  TITLE_SELECTOR,
  CU_RECONCILE_MS,
  CU_INSTALL_KEY,
  CU_TITLE_BOLD_CSS,
  cuTitleBoldCss,
  sessionIdFromRowKey,
  presetOfSessionRow,
  isComputerUseSessionRow,
  cuSessionIdsOfSnapshot,
  collectSessionRows,
  markRows,
  reconcileSessionRows,
  injectCuTitleStyle,
  installCuTitleBold,
  applyCuTitleBold,
}
