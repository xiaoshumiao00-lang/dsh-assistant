import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { parentPathOf } from './pathutil'
import { cachedJsonRead, cachedJsonWrite } from './localStore'
import { filterWorkingCards } from './consoleFilter'
import { sortSessionsByActivity } from './sessionRank'
import { domGate, createGatedThrottle } from './compositionGate'
import { observeExternalSplit } from './splitObserver'
import { ANNOUNCE_BODY, ANNOUNCE_HEAD } from './changelog'
import { LOCAL_VERSION, UPGRADE_AI, checkUpdate, getAutoCheck, readCache, setAutoCheck as storeAutoCheck, setSkipVersion, type UpdateInfo, type UpdateStatus } from './updateCheck'
import { Terminal } from 'xterm'
import { FlowPane } from './flow'
import { TemplateBar } from './templateBar'
import type { FlowEnv } from './templates'
import { getAssistantApi, readModelPref, readBgPref, writeModelPref, writeBgPref } from './orb-bridge'
import type { OrbModel } from './pocket/orb/orb-api'

import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import hljsTypescript from 'highlight.js/lib/languages/typescript'
import hljsJavascript from 'highlight.js/lib/languages/javascript'
import hljsCss from 'highlight.js/lib/languages/css'
import hljsJson from 'highlight.js/lib/languages/json'

let hljsReady = false
function ensureHljsReady(): void {
  if (hljsReady) return
  hljs.registerLanguage('typescript', hljsTypescript)
  hljs.registerLanguage('javascript', hljsJavascript)
  hljs.registerLanguage('css', hljsCss)
  hljs.registerLanguage('json', hljsJson)
  hljsReady = true
}

/**
 * dsh-worktable 乐高式工作区 M1：通用分栏引擎（PRD §13）。
 * 布局模型：标题栏 + 顶部通栏行(可选) + 主行内容窗 + 聊天窗（官方会话视图区整体，
 * 贴右或贴左，由 chatSide 决定；marginLeft/marginRight + marginTop 组合挤法）。
 * 内容三态：null（未指派 → 6 选 1 选择器）/ iframe / builtin（浏览器/资源管理器/SCM/任务/终端）。
 * 窗位调整：标题栏拖拽换位（同行或跨行）；工具栏 ⇄ 切换聊天窗左右。
 * 会话切换重新锚定不关闭；宽度按 layoutId 持久化 dsh.worktable.split.v2；
 * 内容与 chatSide 的变更经 onSpecMutated 回调交给工作台持久化（布局条目）。
 */

export type BuiltinType = 'browser' | 'anim' | 'explorer' | 'scm' | 'tasks' | 'terminal' | 'custom' | 'console' | 'flow'

export type SplitContent =
  | { kind: 'iframe'; url: string; title?: string }
  | { kind: 'builtin'; type: BuiltinType; url?: string }
  | { kind: 'file'; path: string }

/** 一个内容标签页 */
export type PaneTab = { id: string; title: string; content: SplitContent }

export type SplitPane = {
  id: string
  title: string
  min: number
  /** 向后兼容：单内容声明（打开时归一化为一个标签页） */
  content?: SplitContent | null
  /** 标签页模型：内容标签列表（空 = 未指派，显示 6 选 1 选择器） */
  tabs?: PaneTab[]
  /** 激活的标签下标 */
  active?: number
  /** 头部折叠：true = 隐藏窗格标题与标签栏（内容占满；随 spec 持久化） */
  collapsed?: boolean
}

export type LayoutSpec = {
  id: string
  title: string
  top: SplitPane[] | null
  main: SplitPane[]
  /** 左列整高内容窗（可选；存在时右侧列 = top 行 + 底部聊天，chatSide 固定 right） */
  left?: SplitPane | null
  leftWidth?: { default: number; min: number; max: number }
  chatWidth: { default: number; min: number; max: number }
  /** 聊天窗宽度占可用宽比例（0~1；如 0.5 = 内容/聊天左右等分）。
   *  设置后：未手动拖聊天分隔线前，聊天宽 = 可用宽 × 占比（随窗口缩放保持等分）；
   *  手动拖动后转为固定像素宽度。 */
  chatWidthRatio?: number
  topHeight?: { default: number; min: number; max: number }
  /** 聊天窗贴边位置：'right'（右列/右下，默认）| 'left'（左列/左下） */
  chatSide?: 'left' | 'right'
  /** 布局条目图标（emoji；工作台侧栏展示，点击可换） */
  icon?: string
  /** 聊天窗通高（整列）：为 true 时聊天占整条右/左列，内容区（含 top 行）全部排在其另一侧 */
  chatFullHeight?: boolean
  /** 顶行首次打开时高度占可用高度比例（0~1；0.5 = 上下等分）；拖动后由存档值覆盖 */
  topHeightRatio?: number
  /** 全屏布局：不显示对话列（内容占满可用宽，chatW 视为 0）。
   *  标题栏 💬 可临时拉出对话列（不落盘，重开仍是全屏）。 */
  chatHidden?: boolean
  /** 会话全屏：不显示内容列（内容窗保留在 spec 里但不渲染，切到其它布局时标签不丢），
   *  官方会话视图占满可用宽——「全屏看到的就是会话本身」。 */
  chatOnly?: boolean
}

type Geom = { left: number; top: number; right: number; bottom: number }

type PaneRow = 'left' | 'top' | 'main'

type SplitState = {
  active: boolean
  spec: LayoutSpec | null
  geom: Geom | null
  chatW: number
  /** true = 用户手动拖过聊天分隔线（固定像素）；false = 占比模式，宽度随可用宽比例走 */
  chatWManual: boolean
  /** 全屏布局下临时拉出对话列（仅内存态，不持久化） */
  chatPeek: boolean
  topH: number
  leftW: number
  paneWs: number[]
  topWs: number[]
  leftWs: number[]
  root: HTMLElement | null
  header: HTMLElement | null
  viewArea: HTMLElement | null
  savedMarginLeft: string
  savedMarginRight: string
  savedMarginTop: string
  /** 打开前会话根上 --dsh-chat-user-width 的内联值（关闭时原样恢复；0.1.1 上该变量闲置无害） */
  savedWidthVar: string
  observer: ResizeObserver | null
  fallback: MutationObserver | null
  yieldObserver: MutationObserver | null
  /** 拖分隔线时合并落盘用的定时器 id（null = 没有待写的值） */
  persistTimer: number | null
  lastMarginLeft: string
  lastMarginRight: string
  lastMarginTop: string
  onSpecMutated: ((spec: LayoutSpec) => void) | null
  listeners: Set<() => void>
  open(spec: LayoutSpec): boolean
  close(): void
  syncAnchor(): void
  refreshGeom(): void
  applyMargin(): void
  setChatW(w: number): void
  setTopH(h: number): void
  setLeftW(w: number): void
  setPaneW(i: number, w: number): void
  setTopW(i: number, w: number): void
  setPaneContent(row: PaneRow, i: number, content: SplitContent | null): void
  openTab(row: PaneRow, i: number, content: SplitContent): void
  /** 锁定窗格：清空原有标签，把内容作为该窗唯一的固定标签（挂载产物的「锁死」语义） */
  lockPane(row: PaneRow, i: number, content: SplitContent): void
  closeTab(row: PaneRow, i: number, tabId: string): void
  setActiveTab(row: PaneRow, i: number, tabId: string): void
  toggleCollapsed(row: PaneRow, i: number): void
  moveTab(fromRow: PaneRow, fromI: number, tabId: string, toRow: PaneRow, toI: number): void
  swapPanes(aRow: PaneRow, aI: number, bRow: PaneRow, bI: number): void
  setChatSide(side: 'left' | 'right'): void
  /** 全屏布局：显示/隐藏对话列（仅内存态） */
  toggleChatPeek(): void
  persist(): void
  /** 拖分隔线期间的落盘合并：值先进内存，松手 / 页面收尾再写一次 localStorage */
  schedulePersist(): void
  flushPersist(): void
  subscribe(fn: () => void): () => void
  notify(): void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const GAP = 1           // 窗格之间真实布局间隙：1px（分隔细线即间隙，底色贴线）
const DIVIDER = 4       // 分隔条热区宽度：透明覆盖层，细线画在热区中间与两侧内容贴齐
const BAR_H = 26
const PERSIST_KEY = 'dsh.worktable.split.v2'

/** 内置内容窗图标 */
const BUILTIN_ICONS: Record<BuiltinType, string> = {
  browser: '🌐',
  anim: '🎬',
  explorer: '📁',
  scm: '🔀',
  tasks: '✅',
  terminal: '▸_',
  custom: '✨',
  console: '🖥️',
  flow: '📋',
}

const BUILTIN_LABEL_KEYS: Record<BuiltinType, string> = {
  browser: 'pane.browser',
  anim: 'pane.anim',
  explorer: 'pane.explorer',
  scm: 'pane.scm',
  tasks: 'pane.tasks',
  terminal: 'pane.terminal',
  custom: 'pane.custom',
  console: 'pane.console',
  flow: 'pane.flow',
}

function tabTitleOf(content: SplitContent): string {
  if (content.kind === 'builtin') return T(BUILTIN_LABEL_KEYS[content.type])
  if (content.kind === 'file') return basenameOf(content.path)
  if (content.kind === 'iframe' && content.title) return content.title
  try {
    const u = new URL(content.url)
    return u.hostname || content.url
  } catch {
    return content.url
  }
}

/** 取路径最后一段作为标签标题 */
function basenameOf(p: string): string {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || String(p)
}

/** 内容同一性（openTab 去重：同窗内同内容只保留一个标签，再次打开切过去） */
function sameContent(a: SplitContent, b: SplitContent): boolean {
  if (a.kind === 'iframe' && b.kind === 'iframe') return a.url === b.url
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.type === b.type
  return false
}

/** 分栏 UI 文案提供者（由工作台注入 locale t） */
let uiT: ((key: string, params?: Record<string, string>) => string) | null = null
export function setSplitT(fn: ((key: string, params?: Record<string, string>) => string) | null) {
  uiT = fn
}
const T = (key: string, params?: Record<string, string>): string => (uiT ? uiT(key, params) : key)

/** 工作区环境（由工作台注入：当前会话作用域与后台任务列表） */
export type SplitScope = { sessionId: string; cwd: string }
export type SplitJob = {
  id: string
  kind: string
  label: string
  status: string
  detail?: string
  startedAt: number
  finishedAt?: number
}
/** 控制室「临时运行卡片」的保留 id（不写入项目状态；数据由 index.tsx 从宿主会话快照实时组装） */
export const RUNNING_CARD_ID = 'wt-running'

/** 控制室卡片数据（index.tsx 组装；纯读镜像，零轮询零 Token） */
export type ConsoleCardData = {
  id: string
  name: string
  icon: string
  /** 状态色：busy(进行中·绿) / need(等待决策·黄) / error(异常终止·红) / done(已完成·青) / idle */
  status: 'idle' | 'busy' | 'need' | 'done' | 'error'
  /** 正在运行时的本轮已用毫秒；非运行态 null */
  runtimeMs: number | null
  /** 子代理数量 */
  kids: number
  /** 最近一条消息预览（单行文本，可能为空） */
  preview: string
  /** 该预览来自「正在运行」的会话：卡片中间按实时进度持续刷新（流式），显示光标提示 */
  live?: boolean
  /** 是否绑定对话 */
  bound: boolean
  /** 项目已配置文件夹：卡片可「新建会话」（在该文件夹下新开对话并绑定） */
  canNewSession: boolean
  /** 是否为「工作台」自己（卡片点击无操作） */
  self: boolean
  /** 完成/待决且未被确认：卡片发对应色光（点击确认后熄灭） */
  glow: boolean
  /** 临时卡片「正在运行」收纳的会话数（只在临时卡片上有值） */
  count?: number
  /** 临时卡片：不属于任何项目文件夹的会话集合（点开 / 新建 / 会话列表走专门逻辑） */
  temp?: boolean
}

/** 项目目录下的一个会话（控制室卡片「会话列表」浮层用；数据由 index.tsx 从宿主会话快照组装） */
export type ProjectSessionItem = {
  id: string
  /** 会话标题（displayTitle / title；从未发过消息的会话可能只是 id） */
  title: string
  /** 相对项目目录的位置：'' = 就在项目根目录；否则为步骤/子目录名（如 `09-英文翻译`） */
  rel: string
  /** 是否为宿主当前会话 */
  current: boolean
  /** 是否正在运行 */
  running: boolean
  /** 正在等你回答（黄点优先于蓝点；与卡片状态灯同一口径） */
  awaiting?: boolean
  /** 空白会话（还没有消息） */
  blank: boolean
  /** 最近更新毫秒时间戳（未知为 0） */
  updatedAt: number
  /** 已置顶（宿主工作区 pinnedSessionIds） */
  pinned?: boolean
  /** 已归档（工作区归档 = 从列表移除、磁盘日志保留；可恢复） */
  archived?: boolean
  /** 已结束（临时卡片专用：运行结束、一直保留到手动「收工」） */
  finished?: boolean
}

/** 新建会话选项：标准模式 = 宿主默认预设；computer-use = dsh-orb 的电脑操作预设。 */
export type NewSessionOptions = {
  mode: 'standard' | 'computer-use'
  /** 前台模型（该会话后续消息使用的模型） */
  front?: { provider: string; model: string; name?: string } | null
  /** 后台模型（dsh-orb 设置里的后台 Agent 模型，全局生效） */
  background?: { provider: string; model: string; name?: string } | null
}

/** 新建会话面板里可选的模型（与 OrbModel 同形，但 name 可缺省）。 */
type NewSessModel = { provider: string; model: string; name?: string }

/** 模型选择键（provider + model；select 的 value 用）。 */
const newSessModelKey = (m: { provider: string; model: string } | null | undefined): string =>
  m ? m.provider + '\u0000' + m.model : ''

/** 两个模型选择是否指向同一模型。 */
const sameNewSessModel = (a: NewSessModel | null | undefined, b: NewSessModel | null | undefined): boolean =>
  !!a && !!b && a.provider === b.provider && a.model === b.model

/** 从模型目录里挑一个**具体**模型：按 preferences 顺序取第一个仍存在的；
 *  都不存在时用目录默认，再不行用第一个。目录为空（还没加载 / 不可用）时保留第一个非空偏好。
 *  面板因此永远不会出现「默认」空选项：要么是上次用过的模型，要么是目录里真实存在的模型。 */
function pickNewSessModel(
  models: OrbModel[],
  preferences: (NewSessModel | null | undefined)[] = [],
  fallback?: { provider: string; model: string } | null,
): NewSessModel | null {
  const available = models.filter((m) => m && m.provider && m.model)
  if (available.length === 0) {
    for (const pref of preferences) {
      if (pref && pref.provider && pref.model) return { ...pref }
    }
    return null
  }
  for (const pref of preferences) {
    if (!pref) continue
    const hit = available.find((m) => m.provider === pref.provider && m.model === pref.model)
    if (hit) return { provider: hit.provider, model: hit.model, name: hit.name }
  }
  if (fallback && fallback.provider && fallback.model) {
    const hit = available.find((m) => m.provider === fallback.provider && m.model === fallback.model)
    if (hit) return { provider: hit.provider, model: hit.model, name: hit.name }
  }
  const first = available[0]
  return { provider: first.provider, model: first.model, name: first.name }
}

type SplitEnv = {
  getScope: () => SplitScope | null
  getJobs: () => SplitJob[]
  getSubagents: () => any[]
  /** 自定义窗口：项目列表 + 会话列表 + 当前项目 + 新建会话 / 发送到已有会话 */
  custom?: {
    getProjects: () => { id: string; name: string }[]
    currentProjectId: () => string | null
    getSessions: () => Promise<{ groups: { title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]; current: string }>
    submit: (projectId: string, projectName: string, requirement: string) => Promise<void>
    sendToSession: (sessionId: string, projectName: string, requirement: string) => Promise<void>
  }
  /** 控制室：卡片数据订阅 + 打开项目 / 跳绑定对话 + 主题 */
  console?: {
    subscribe: (fn: () => void) => () => void
    getCards: () => ConsoleCardData[]
    onOpen: (id: string) => void
    onJump: (id: string) => void
    /** 打开图标选择器：唯一入口 = 控制室下方工具条「项目管理」里每行的「更换图标」按钮
     *  （卡片图标只是标识，不再当按钮）。below=true → 选择器贴按钮下方弹出，不挡住操作列。 */
    onPickIcon?: (id: string, anchor: HTMLElement, opts?: { below?: boolean }) => void
    /** 卡片「＋」：在项目文件夹下新开对话（cwd = 项目文件夹）→ 绑定到该项目 → 切过去 */
    onNewSession?: (id: string) => void | Promise<boolean | void>
    /** 卡片「会话列表」：该项目目录下的全部会话（含模板各步骤子目录），按最近更新倒序 */
    getProjectSessions?: (id: string) => ProjectSessionItem[]
    /** 从列表进入某个会话（历史保留，可继续对话） */
    onOpenSession?: (sessionId: string) => void
    /** 删除某条会话（宿主归档：从各列表移除，磁盘日志保留；运行中的会话不入列删除） */
    onDeleteSession?: (sessionId: string) => void
    /** 临时卡片「正在运行」：把已结束的会话从卡片移除（不删除会话） */
    onDismissTransient?: (sessionIds: string[]) => void
    /** 重命名某条会话（宿主按 id 解析会话实例改名，无需打开会话） */
    onRenameSession?: (sessionId: string, title: string) => void
    /** 分叉某条会话：宿主在同目录建子会话并返回其 id（失败返回 null；切换由调用方负责） */
    onForkSession?: (sessionId: string) => Promise<string | null> | string | null
    /** 置顶 / 取消置顶（宿主工作区） */
    onPinSession?: (sessionId: string, pinned: boolean) => void
    /** 归档 / 恢复（宿主工作区：归档 = 从列表移除，磁盘日志保留） */
    onArchiveSession?: (sessionId: string, archived: boolean) => void
    /** 卡片「＋」新建会话：可指定标准 / computer-use 模式与前台、后台模型。
     *  返回 false（或 resolve 成 false）= 未建成：面板留在原处让用户重试；true/undefined = 关面板 */
    onCreateSession?: (id: string, opts: NewSessionOptions) => void | Promise<boolean | void>
    /** 项目管理：全部项目（含已隐藏） */
    getManageProjects?: () => { id: string; name: string; icon: string; hidden: boolean }[]
    /** 重命名项目（写 nameOverrides；空名 = 恢复默认名） */
    onRenameProject?: (id: string, name: string) => void
    /** 隐藏 / 恢复项目（只影响控制室显示） */
    onHideProject?: (id: string, hidden: boolean) => void
    /** 拖动排序：把 dragId 插到 targetId 之前（before=true）或之后 */
    onReorderProject?: (dragId: string, targetId: string, before: boolean) => void
    /** 删除项目条目（不删磁盘文件夹/会话） */
    onDeleteProject?: (id: string) => void
    /** 点发光卡片：确认（熄灭光）再打开 */
    onAck: (id: string) => void
    /** 冷会话消息预热（打开控制室时拉最近消息） */
    refreshPreviews: () => void
    /** 创建卡片：打开「添加项目」流程（同侧栏 ＋） */
    onAdd: () => void
    getTheme: () => 'dark' | 'light' | 'system'
    setTheme: (th: 'dark' | 'light' | 'system') => void
    getCols: () => number
    setCols: (n: number) => void
    getShape: () => 'square' | 'circle'
    setShape: (s: 'square' | 'circle') => void
    getBg: () => 'plain' | 'glow' | 'photo'
    setBg: (m: 'plain' | 'glow' | 'photo') => void
    getPhotoLib: () => Promise<{ list: { id: string; kind: 'photo' | 'video'; url: string }[]; activeId: string | null }>
    addPhoto: (blob: Blob) => Promise<{ id: string; kind: 'photo' | 'video'; url: string }>
    setPhotoId: (id: string) => void
    getPhotoHsl: (id: string) => { h: number; s: number; l: number }
    setPhotoHsl: (id: string, v: { h: number; s: number; l: number }) => void
    removePhoto: (id: string) => Promise<void>
    reorderPhotos: (ids: string[]) => Promise<void>
    getPhotoGrid: () => boolean
    setPhotoGrid: (v: boolean) => void
    getGridOpacity: () => number
    setGridOpacity: (v: number) => void
    getCardBlur: () => number
    setCardBlur: (v: number) => void
    getPlainBlur: () => number
    setPlainBlur: (v: number) => void
    getGlowBlur: () => number
    setGlowBlur: (v: number) => void
    getPlainGrid: () => number
    setPlainGrid: (v: number) => void
    getGlowGrid: () => number
    setGlowGrid: (v: number) => void
    getGlowSpeed: () => number
    setGlowSpeed: (v: number) => void
    getPlainHsl: () => { h: number; s: number; l: number }
    setPlainHsl: (v: { h: number; s: number; l: number }) => void
    getGlowHsl: () => { h: number; s: number; l: number }
    setGlowHsl: (v: { h: number; s: number; l: number }) => void
    getPhotoHsl: () => { h: number; s: number; l: number }
    setPhotoHsl: (v: { h: number; s: number; l: number }) => void
  }
  /** 模板流程窗格（flow）：数据订阅 + 步骤动作（index.tsx 注入） */
  flow?: FlowEnv
}
let splitEnv: SplitEnv | null = null
const splitEnvListeners = new Set<() => void>()
export function setSplitEnv(env: SplitEnv | null) {
  splitEnv = env
  for (const listener of [...splitEnvListeners]) { try { listener() } catch {} }
}
export function subscribeSplitEnv(listener: () => void): () => void {
  splitEnvListeners.add(listener)
  return () => { splitEnvListeners.delete(listener) }
}
/** 控制室面板是否已拿到工作台环境（侧栏工作台区块挂载后会注入）。
 *  悬浮球控制室用它做兜底：极端情况下侧栏被完全卸载，面板会提示而不是空白。 */
export function consoleEnvReady(): boolean {
  return !!(splitEnv && splitEnv.console)
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** 拖拽换位暂存 */
let dragPane: { row: PaneRow; index: number } | null = null
/** 标签拖拽暂存（跨窗移动） */
let dragTab: { row: PaneRow; index: number; tabId: string } | null = null
/** 标签拖放目标（吸附高亮；模块级，PaneBody 与窗容器共用） */
let dropTarget: { row: PaneRow; index: number } | null = null
let dropTargetListeners: Set<() => void> = new Set()
function setDropTarget(t: { row: PaneRow; index: number } | null) {
  if (dropTarget === t) return
  dropTarget = t
  for (const fn of dropTargetListeners) fn()
}

/** ——「指哪打哪」标注引擎：按钮 → 蓝色冒泡光标 → 点击弹输入框 → ✓ 打包进对话框（不发送） —— */
type AnnotState = {
  on: boolean
  started: boolean
  drawing: boolean
  px: number
  py: number
  bx0: number
  by0: number
  bx1: number
  by1: number
  ex: number
  ey: number
  draft: string
  resp: string
  stat: string
}
let annotState: AnnotState = { on: false, started: false, drawing: false, px: 0, py: 0, bx0: 0, by0: 0, bx1: 0, by1: 0, ex: 0, ey: 0, draft: '', resp: '', stat: '' }
const annotListeners = new Set<() => void>()
function setAnnot(patch: Partial<AnnotState>) {
  annotState = { ...annotState, ...patch }
  for (const fn of annotListeners) fn()
}
function subscribeAnnot(fn: () => void) { annotListeners.add(fn); return () => { annotListeners.delete(fn) } }

/** 进入瞄准模式（resp = 窗口编号等上下文，由调用方拼好） */
function startAnnot(resp: string) {
  document.body.classList.add('dsh-wt-annotating')
  setAnnot({ on: true, started: false, drawing: false, resp, stat: '', draft: '' })
}
function cancelAnnot() {
  document.body.classList.remove('dsh-wt-annotating')
  setAnnot({ on: false, started: false, drawing: false })
}

/** 窗口身份（约定：左栏 → 顶行 → 主行，从 1 起；附窗格标题与内容类型/URL，让接收方无需猜"这是哪个界面"） */
function windowLabelOf(row: PaneRow, index: number): string {
  const spec = splitStore.spec
  if (!spec) return '窗口?'
  let num = spec.left ? 2 : 1
  if (row === 'left') num = 1
  else if (row === 'top') num = num + index
  else { num += (spec.top?.length ?? 0) + index }
  let label = '窗口' + num
  const pane = row === 'left' ? spec.left : row === 'top' ? spec.top?.[index] : spec.main?.[index]
  const title = pane?.title
  if (title) label += '「' + title + '」'
  const tab = pane?.tabs?.[pane.active ?? 0]
  const c = tab?.content
  if (c) {
    try {
      if (c.kind === 'iframe' && c.url) label += '（网页 ' + new URL(c.url).hostname + '）'
      else if (c.kind === 'builtin') {
        label += '（内置·' + c.type
        try { if (c.url) label += ' ' + new URL(c.url).hostname } catch {}
        label += '）'
      }
      else if (c.kind === 'file') label += '（文件）'
    } catch {}
  }
  return label
}

/** 被点元素上下文（标签 + 类名 + 文字） */
function ctxOf(t: EventTarget | null): string {
  const el = t instanceof Element ? t : null
  if (!el || el === document.documentElement || el === document.body) return ''
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).join('.')
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  let out = '<' + tag + (cls ? ' .' + cls : '') + '>'
  if (text) out += '「' + text + '」'
  try { const cs = getComputedStyle(el); out += '（字号 ' + cs.fontSize + '）' } catch {}
  return out
}

/** 框选 payload v3.1：主目标 = 框中心点【光标下的字符】所在的 Text 节点（caretPositionFromPoint，
 *  标签即使不是独立元素也能取到真正的词/段）；样式取该 Text 节点的父元素（真实渲染值）；
 *  整行 = 最近的高度≤44px 祖先的内容（供「这行字是什么」类问题）；候选 = 相交的独立短文本。 */
function boxPayload(x0: number, y0: number, x1: number, y1: number): { primary: { text: string; fontSize: string; lineHeight: string; color: string } | null; line: string; candidates: string[]; limited: boolean; src: string } {
  const L = Math.min(x0, x1)
  const T = Math.min(y0, y1)
  const R = Math.max(x0, x1)
  const B = Math.max(y0, y1)
  const cx = (L + R) / 2
  const cy = (T + B) / 2
  let primary: { text: string; fontSize: string; lineHeight: string; color: string } | null = null
  let line = ''
  let candidates: string[] = []
  let limited = false
  let src = ''
  // 在某 document 内取字（rect = 该 doc 视口在顶层页面的偏移）
  const readDoc = (doc: Document, ox: number, oy: number): boolean => {
    let ok = false
    let textParent: HTMLElement | null = null
    try {
      const pd = doc as any
      const px = cx - ox
      const py = cy - oy
      let pos: any = null
      try { if (pd.caretPositionFromPoint) pos = pd.caretPositionFromPoint(px, py) } catch {}
      if (!pos) { try { if (pd.caretRangeFromPoint) pos = pd.caretRangeFromPoint(px, py) } catch {} }
      const textNode: Node | null = pos ? (pos.offsetNode ?? pos.startContainer ?? null) : null
      if (textNode) {
        const parent = textNode.parentElement
        if (parent) {
          textParent = parent
          const text = (textNode.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
          if (text) {
            const cs = getComputedStyle(parent)
            primary = { text, fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color }
            ok = true
          }
        }
      }
    } catch {}
    // 整行
    if (textParent) {
      try {
        let el: HTMLElement | null = textParent
        while (el && el !== doc.body) {
          const r = el.getBoundingClientRect()
          if (r.height >= 8 && r.height <= 44 && r.width > 0) {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
            if (t) { line = t.slice(0, 120); break }
          }
          el = el.parentElement
        }
      } catch {}
    }
    // 候选
    const seen = new Set<string>()
    if (primary) seen.add(primary.text)
    const cs: string[] = []
    try {
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
        const tag = el.tagName.toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'path' || tag === 'br' || tag === 'template' || tag === 'iframe') continue
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        if (rect.right + ox < L || rect.left + ox > R || rect.bottom + oy < T || rect.top + oy > B) continue
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
        if (text.length < 1 || text.length > 30) continue
        if (seen.has(text)) continue
        seen.add(text)
        cs.push(text)
        if (cs.length >= 4) break
      }
    } catch {}
    if (ok || cs.length > 0) candidates = cs
    return ok
  }
  // 1) 顶层文档
  readDoc(document, 0, 0)
  // 2) 顶层取不到 → 中心点所在 iframe 下钻（同源可读；跨域标记受限于 src）
  if (!primary) {
    try {
      for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))) {
        try {
          const r = iframe.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue
          src = iframe.getAttribute('src') ?? ''
          let inner: Document | null = null
          try { inner = iframe.contentDocument } catch { inner = null }
          if (inner) readDoc(inner, r.left, r.top)
          else limited = true
          break
        } catch { continue }
      }
    } catch {}
  }
  return { primary, line, candidates, limited, src }
}

/** 更新方法：唯一的更新源在 updateCheck.ts（UPGRADE_CMD / UPGRADE_AI 从那里导入）。
 *  这里曾自己写死过一条指向退役仓库、profile 也不对的升级命令，已删。 */

async function copyTextSafe(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true } } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

/** 注入宿主对话框输入框（不发送）；失败返回 false */
function fillHostInput(text: string): boolean {
  try {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[data-phase]')
      ?? Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).pop()
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    // 连续标注：已有内容不顶掉，换行追加（用户可以同一对话连续标注多处）
    const next = ta.value && ta.value.trim() ? ta.value + '\n\n' + text : text
    if (setter) setter.call(ta, next)
    else ta.value = next
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    try {
      ta.focus()
      ta.dispatchEvent(new Event('change', { bubbles: true }))
      ta.setSelectionRange(ta.value.length, ta.value.length)
    } catch {}
    return true
  } catch {
    return false
  }
}

/** ✓ 确认：打包并注入，不发送 */
function confirmAnnot() {
  const s = annotState
  const text = '📌 标注-' + s.resp + '\n' + (s.stat || '') + '\n要求：' + (s.draft.trim() || '（未填写）')
    + '\n【工作台标注·已定位，直接作答，无需再问；仅当确实无法从标注定位时才问一次。数据缺失或标注标注读取受限时，如实说明无法确定，禁止编造数值；可建议提供截图或使用视觉模型会话】'
  const ok = fillHostInput(text)
  if (!ok) {
    try {
      navigator.clipboard?.writeText(text).catch(() => { try { window.prompt('标注已生成，请手动复制：', text) } catch {} })
    } catch {
      try { window.prompt('标注已生成，请手动复制：', text) } catch {}
    }
  }
  cancelAnnot()
}

/** 标注浮层：瞄准气泡 + 输入编辑器（每个工作区渲染一次；fixed 定位） */
function AnnotationOverlay() {
  const [, setTick] = useState(0)
  useEffect(() => subscribeAnnot(() => setTick((t) => t + 1)), [])
  const s = annotState
  useEffect(() => {
    if (!s.on || s.started) return
    let sx = 0
    let sy = 0
    let dragging = false
    const isUi = (e: MouseEvent) => e.target instanceof Element && e.target.closest('.dsh-wt_annotUi') != null
    const onMove = (e: MouseEvent) => {
      if (!annotState.on || annotState.started) return
      if (annotState.drawing) setAnnot({ bx1: e.clientX, by1: e.clientY, px: e.clientX, py: e.clientY })
      else setAnnot({ px: e.clientX, py: e.clientY })
    }
    const onDown = (e: MouseEvent) => {
      if (!annotState.on || annotState.started || isUi(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      sx = e.clientX
      sy = e.clientY
      dragging = true
      setAnnot({ drawing: true, bx0: sx, by0: sy, bx1: sx, by1: sy })
    }
    const onUp = (e: MouseEvent) => {
      if (!annotState.on || annotState.started || !dragging) return
      e.preventDefault()
      e.stopImmediatePropagation()
      dragging = false
      const w = Math.abs(e.clientX - sx)
      const h = Math.abs(e.clientY - sy)
      const paneEl = (e.target instanceof Element ? e.target.closest('.dsh-wt_pane') : null) as HTMLElement | null
      let stat = ''
      if (Math.max(w, h) >= 8) {
        // 框选：中心/宽高 + 窗口内百分比 + 框内可见文字聚合
        const L = Math.min(sx, e.clientX)
        const T = Math.min(sy, e.clientY)
        const R = Math.max(sx, e.clientX)
        const B = Math.max(sy, e.clientY)
        stat = '框选屏幕 (' + Math.round(L) + ',' + Math.round(T) + ') → (' + Math.round(R) + ',' + Math.round(B) + ') 宽高 (' + Math.round(w) + '×' + Math.round(h) + 'px)'
        if (paneEl) {
          const pr = paneEl.getBoundingClientRect()
          const rx1 = (((L - pr.left) / Math.max(1, pr.width)) * 100).toFixed(1)
          const ry1 = (((T - pr.top) / Math.max(1, pr.height)) * 100).toFixed(1)
          const rx2 = (((R - pr.left) / Math.max(1, pr.width)) * 100).toFixed(1)
          const ry2 = (((B - pr.top) / Math.max(1, pr.height)) * 100).toFixed(1)
          stat += '，窗口内 (' + rx1 + '%,' + ry1 + '%)→(' + rx2 + '%,' + ry2 + '%)'
        }
        const hit = boxPayload(L, T, R, B)
        if (hit.primary) stat += '，主目标：' + hit.primary.text + '（字号 ' + hit.primary.fontSize + '，行高 ' + hit.primary.lineHeight + '）'
        if (hit.line) stat += '；整行：' + hit.line
        if (hit.limited) stat += '；读取受限：跨域页面内容不可见（浏览器安全限制），窗口身份见上（' + (hit.src ? hit.src : '无URL') + '）'
        if (hit.candidates.length > 0) stat += '；候选：' + hit.candidates.map((t, i) => '[' + (i + 1) + ']' + t).join(' ')
      } else {
        stat = '屏幕坐标 (' + Math.round(e.clientX) + ', ' + Math.round(e.clientY) + ')'
        if (paneEl) {
          const r = paneEl.getBoundingClientRect()
          const rx = (((e.clientX - r.left) / Math.max(1, r.width)) * 100).toFixed(1)
          const ry = (((e.clientY - r.top) / Math.max(1, r.height)) * 100).toFixed(1)
          stat += '，窗口内 (' + rx + '%, ' + ry + '%)'
        }
        const ctx = ctxOf(e.target)
        if (ctx) stat += '，元素 ' + ctx
      }
      document.body.classList.remove('dsh-wt-annotating')
      const ex = Math.max(8, Math.min(e.clientX + 10, window.innerWidth - 288))
      const ey = Math.max(8, Math.min(e.clientY + 14, window.innerHeight - 148))
      setAnnot({ started: true, drawing: false, ex, ey, stat })
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelAnnot() }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.on, s.started])
  // 首次进入标注：右侧气泡提示「拖动也可框选」，仅显示一次
  const [hintOnce] = useState<boolean>(() => { try { return localStorage.getItem('dsh.worktable.annotHint.v1') !== '1' } catch { return false } })
  const [hintVisible, setHintVisible] = useState(false)
  useEffect(() => {
    if (!s.on || !hintOnce) return
    setHintVisible(true)
    try { localStorage.setItem('dsh.worktable.annotHint.v1', '1') } catch {}
    const t = window.setTimeout(() => setHintVisible(false), 4200)
    return () => window.clearTimeout(t)
  }, [s.on, hintOnce])
  if (!s.on) return null
  {hintVisible && (
    <div className="dsh-wt_annotUi dsh-wt_annotHint">{T('annot.hint')}</div>
  )}
  if (s.drawing) {
    const L = Math.min(s.bx0, s.bx1)
    const T = Math.min(s.by0, s.by1)
    const R = Math.max(s.bx0, s.bx1)
    const B = Math.max(s.by0, s.by1)
    return <div className="dsh-wt_annotUi dsh-wt_annotSel" style={{ left: L, top: T, width: R - L, height: B - T }} />
  }
  if (!s.started) {
    return (
      <div className="dsh-wt_annotUi dsh-wt_annotBubble" style={{ left: s.px, top: s.py }} aria-hidden>
        <svg width="12" height="12" viewBox="0 0 16 16"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>
      </div>
    )
  }
  return (
    <div className="dsh-wt_annotUi dsh-wt_annotEditor" style={{ left: s.ex, top: s.ey }}>
      <textarea
        className="dsh-wt_annotInput"
        autoFocus
        value={s.draft}
        placeholder={T('annot.placeholder')}
        onChange={(e) => setAnnot({ draft: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmAnnot() }
          if (e.key === 'Escape') cancelAnnot()
        }}
      />
      <div className="dsh-wt_annotBtns">
        <button type="button" className="dsh-wt_annotOk" title={T('annot.ok')} aria-label={T('annot.ok')} onClick={confirmAnnot}>✓</button>
        <button type="button" className="dsh-wt_annotNo" title={T('annot.cancel')} aria-label={T('annot.cancel')} onClick={cancelAnnot}>✕</button>
      </div>
    </div>
  )
}

/** 找到会话根容器：data-phase 元素中排除输入框、取含子元素者。
 * DSH 0.1.1-rc.2 与 0.1.2-rc.1 的会话阶段一致：active（有消息）/ hero（无会话或空会话）/ settling（过渡）。
 * 优先 active，其次 hero（空会话/无会话时也能打开分栏），settling 兜底（锚定后由观察器修正）。 */
function findConversationRoot(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-phase]'))
  const ok = (el: HTMLElement) => el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT'
    && el.children.length >= 1 && !/input/i.test(String(el.className))
  const rank = (el: HTMLElement) => (el.dataset.phase === 'active' ? 0 : el.dataset.phase === 'hero' ? 1 : 2)
  let best: HTMLElement | null = null
  let bestRank = Infinity
  for (const el of candidates) {
    if (!ok(el)) continue
    const r = rank(el)
    if (r < bestRank) { bestRank = r; best = el }
  }
  return best
}

/** 从首个槽位元素里解析「可见头部」：
 * - 0.1.1：children[0] 就是 <header> 本身（可见时自身有高度）。
 * - 0.1.2：children[0] 是零高的槽位包装（display:contents 式），真实头部渲染在其内部——
 *   此时向内找第一个可见后代（文档序 = 头部自身，先于其子元素）。
 * - 空会话（headerHidden，整棵子树 display:none）：找不到任何可见元素 → null（顶部 = 根顶部）。 */
function visibleHeaderIn(first: HTMLElement): HTMLElement | null {
  if (first.getBoundingClientRect().height > 0) return first
  for (const el of Array.from(first.querySelectorAll<HTMLElement>('*'))) {
    const r = el.getBoundingClientRect()
    if (r.height > 0 && r.width > 0) return el
  }
  return null
}

/** 从会话根解析分栏锚点（兼容 0.1.1 与 0.1.2 两种 DOM 结构）：
 * - 0.1.1 与 0.1.2 会话打开：root.children = [头部(或头部包装), 内容滚动区]（0.1.2 多一层 body 包装，不影响取 children[1]）。
 * - 0.1.2 无会话：root.children = [body]（无头部元素）。
 * - 空会话（blank）：头部带 headerHidden 样式（高度为 0），按「无头部」处理（顶部 = 根顶部）。
 * header 仅当存在第二个子元素且能解析出可见头部时生效；viewArea = 第二个子元素，只有一个时 = 第一个。 */
function resolveAnchor(root: HTMLElement): { header: HTMLElement | null; viewArea: HTMLElement } {
  const first = root.children[0] as HTMLElement | undefined
  const second = root.children[1] as HTMLElement | undefined
  const header = !!second && !!first ? visibleHeaderIn(first) : null
  return { header, viewArea: second ?? first! }
}

/** 存档表（layoutId → 尺寸）读缓存：开布局 / 落盘都要读这一张表，内容没变不再重复 parse */
function readPersistedMap(): Record<string, any> {
  return cachedJsonRead(PERSIST_KEY, (raw) => {
    if (!raw) return {}
    const p = JSON.parse(raw)
    return p && typeof p === 'object' ? p as Record<string, any> : {}
  })
}

function loadSaved(layoutId: string): { chatW: number; chatWManual: boolean; topH: number; leftW: number; paneWs: number[]; topWs: number[]; leftWs: number[] } | null {
  try {
    const s = readPersistedMap()[layoutId]
    if (!s || typeof s !== 'object') return null
    return {
      chatW: Number.isFinite(s.chatW) ? s.chatW : -1,
      chatWManual: typeof s.chatWManual === 'boolean' ? s.chatWManual : false,
      topH: Number.isFinite(s.topH) ? s.topH : -1,
      leftW: Number.isFinite(s.leftW) ? s.leftW : -1,
      paneWs: Array.isArray(s.paneWs) ? s.paneWs : [],
      topWs: Array.isArray(s.topWs) ? s.topWs : [],
      leftWs: Array.isArray(s.leftWs) ? s.leftWs : [],
    }
  } catch {
    return null
  }
}

function persistSaved(layoutId: string, s: { chatW: number; chatWManual: boolean; topH: number; leftW: number; paneWs: number[]; topWs: number[]; leftWs: number[] }) {
  try {
    // 缓存跟上刚写的内容：紧接着读不用重新 parse
    const all = readPersistedMap()
    all[layoutId] = s
    cachedJsonWrite(PERSIST_KEY, all)
  } catch {}
}

/** 共享互斥协议：其他接入本协议的分栏引擎声明占用时，本引擎让位（同一时刻仅一个分栏工作区） */
window.addEventListener('dsh:split-claim', ((e: any) => {
  const id = e?.detail?.id
  if (splitStore.active && id && id !== splitStore.spec?.id) splitStore.close()
}) as EventListener)

export const splitStore: SplitState = {
  active: false,
  spec: null,
  geom: null,
  chatW: 320,
  chatWManual: true,
  chatPeek: false,
  topH: 200,
  leftW: 260,
  paneWs: [],
  topWs: [],
  leftWs: [],
  root: null,
  header: null,
  viewArea: null,
  savedMarginLeft: '',
  savedMarginRight: '',
  savedMarginTop: '',
  savedWidthVar: '',
  observer: null,
  fallback: null,
  yieldObserver: null,
  persistTimer: null,
  lastMarginLeft: '',
  lastMarginRight: '',
  lastMarginTop: '',
  onSpecMutated: null,
  listeners: new Set(),

  open(spec) {
    if (this.active) {
      // 反选：同一布局再点 = 关闭；不同布局 = 替换（先关旧的）
      if (this.spec?.id === spec.id) {
        this.close()
        return true
      }
      this.close()
    }
    // 跨插件互操作桥：自带分栏实现的入驻插件（未接入共享引擎）打开时，运行时点击其关闭按钮让位
    try {
      const taClose = document.querySelector<HTMLElement>('.ta_splitClose')
      taClose?.click()
    } catch {}
    // 声明占用：接入共享协议的其他引擎收到后让位
    try {
      window.dispatchEvent(new CustomEvent('dsh:split-claim', { detail: { id: spec.id } }))
    } catch {}
    const root = findConversationRoot()
    if (!root) return false
    const { header, viewArea } = resolveAnchor(root)
    this.spec = { ...spec, chatSide: spec.chatSide === 'left' ? 'left' : 'right' }
    // 向后兼容归一化：单内容声明 → 一个标签页
    const normalize = (p: SplitPane): SplitPane => {
      if (p.tabs && p.tabs.length > 0) return p
      if (p.content) {
        return { ...p, content: null, tabs: [{ id: 't1', title: tabTitleOf(p.content), content: p.content }], active: 0 }
      }
      return { ...p, content: null, tabs: [], active: 0 }
    }
    if (spec.top) this.spec.top = spec.top.map(normalize)
    if (spec.left) this.spec.left = normalize(spec.left)
    this.spec.main = (spec.main ?? []).map(normalize)
    const main = this.spec.main ?? []
    const top = spec.top ?? []
    const left = spec.left ?? null
    const saved = loadSaved(spec.id)
    const hasChatW = !!saved && saved.chatW >= 0
    const hasTopH = !!saved && saved.topH >= 0
    const hasLeftW = !!saved && saved.leftW >= 0
    const hasPaneWs = !!saved && saved.paneWs.length === main.length
    const hasTopWs = !!saved && saved.topWs.length === top.length
    const hasLeftWs = !!saved && saved.leftWs.length === (left ? 1 : 0)
    this.chatW = hasChatW ? saved!.chatW : spec.chatWidth.default
    // 占比模式（chatWidthRatio）：未手动拖过聊天分隔线 = 跟随可用宽比例；拖过/无占比声明 = 固定像素
    this.chatWManual = spec.chatWidthRatio ? (saved?.chatWManual ?? false) : true
    this.chatPeek = false // 全屏布局：每次打开都从「不显示对话列」开始
    this.topH = hasTopH ? saved!.topH : (spec.topHeight?.default ?? 200)
    this.leftW = hasLeftW ? saved!.leftW : (spec.leftWidth?.default ?? 260)
    this.paneWs = hasPaneWs ? [...saved!.paneWs] : main.map((p) => p.min)
    this.topWs = hasTopWs ? [...saved!.topWs] : top.map((p) => p.min)
    this.leftWs = hasLeftWs ? [...saved!.leftWs] : (left ? [left.min] : [])
    this.root = root
    this.header = header
    this.viewArea = viewArea
    this.savedWidthVar = root.style.getPropertyValue('--dsh-chat-user-width')
    this.savedMarginLeft = viewArea.style.marginLeft
    this.savedMarginRight = viewArea.style.marginRight
    this.savedMarginTop = viewArea.style.marginTop
    this.refreshGeom()
    // 存档 sanitize：chatW 等尺寸按本布局规格钳制（防老版本/脏存值越界，如 1067 > max 600）
    if (this.geom) {
      const minContent = main.reduce((a: number, p: SplitPane) => a + p.min, 0) + Math.max(0, main.length - 1) * GAP
      const hi = Math.max(spec.chatWidth.min, (this.geom.right - this.geom.left) - minContent)
      this.chatW = clamp(Math.round(this.chatW), spec.chatWidth.min, hi)
    }
    // 均衡默认：无存档尺寸时按当前可用空间比例分配，
    // 不再出现“其余窗全部贴 min、最后一个吃掉全部余量”的悬殊观感。
    const g0 = this.geom
    if (g0) {
      const colW0 = g0.right - g0.left
      const rowH0 = g0.bottom - g0.top
      if (!hasChatW) {
        const hi = Math.max(spec.chatWidth.min, colW0 - 60)
        // 有占比声明（如左右布局 0.5 = 左右等分）按占比取宽，否则回退 30%
        this.chatW = clamp(Math.round(colW0 * (spec.chatWidthRatio ?? 0.3)), spec.chatWidth.min, hi)
      }
      if (left && !hasLeftW) {
        const lo = spec.leftWidth?.min ?? 160
        this.leftW = clamp(Math.round(colW0 * 0.38), lo, Math.max(lo, colW0 - 260))
      }
      if (top.length > 0 && !hasTopH) {
        const lo = spec.topHeight?.min ?? 80
        const ratio = spec.topHeightRatio ?? 0.35
        this.topH = clamp(Math.round((rowH0 - BAR_H) * ratio), lo, Math.max(lo, rowH0 - BAR_H - 80))
      }
      if (!hasPaneWs) {
        const contentW = Math.max(0, colW0 - (spec.chatHidden === true || spec.chatOnly === true ? 0 : this.chatW))
        const avail = Math.max(main.length * 120, contentW - Math.max(0, main.length - 1) * GAP)
        const share = Math.round(avail / main.length)
        this.paneWs = main.map((p) => Math.max(p.min, share))
      }
      if (!hasTopWs) {
        // chatFull 时顶行只占内容侧（扣除聊天列宽）
        const chatW0 = spec.chatFullHeight === true ? this.chatW : 0
        const rowW = Math.max(0, colW0 - chatW0 - (left ? this.leftW : 0))
        const avail = Math.max(top.length * 120, rowW - Math.max(0, top.length - 1) * GAP)
        const share = Math.round(avail / top.length)
        this.topWs = top.map((p) => Math.max(p.min, share))
      }
      if (left && !hasLeftWs) this.leftWs = [Math.max(left.min, this.leftW)]
    }
    this.applyMargin()
    this.observer = new ResizeObserver(() => {
      const r = this.root
      if (!(r && r.isConnected)) { this.syncAnchor(); return }
      const anchor = resolveAnchor(r)
      if (anchor.header !== this.header || anchor.viewArea !== this.viewArea) { this.syncAnchor(); return }
      this.refreshGeom()
      this.applyMargin()
      this.notify()
    })
    this.observer.observe(root)
    // 兜底：会话根被替换/子结构变化（如 hero→active 头部出现）时 RO 可能不再回调，
    // 用 body 级 MutationObserver 驱动重锚定；锚点未变时静默（避免流式消息期间高频刷新）
    // 2026-10-31：这一路的 resolveAnchor 是「会话根子树里找锚点」扫描，手机长会话下
    // 用户一边打字一边语音转写就是一批批扫描。合并 300ms 一次，组合 / 抽屉开合时让路。
    const fallbackRun = createGatedThrottle({
      run: () => {
        const r = this.root
        if (!(r && r.isConnected)) { this.syncAnchor(); return }
        const anchor = resolveAnchor(r)
        if (anchor.header !== this.header || anchor.viewArea !== this.viewArea) this.syncAnchor()
      },
      gate: domGate,
      waitMs: 300,
    })
    this.fallback = new MutationObserver(fallbackRun)
    this.fallback.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] })
    // 让位观察器：会话视图区 margin 被外部改写（其他未接入协议的分栏引擎接管）时关闭自身
    this.yieldObserver = new MutationObserver(() => {
      if (!this.active || !this.viewArea) return
      if (this.viewArea.style.marginLeft !== this.lastMarginLeft
        || this.viewArea.style.marginRight !== this.lastMarginRight
        || this.viewArea.style.marginTop !== this.lastMarginTop) {
        this.close()
      }
    })
    this.yieldObserver.observe(viewArea, { attributes: true, attributeFilter: ['style'] })
    this.active = true
    // 外来分栏浮层只会在本工作区打开时需要互斥；空闲/首屏不观察 body 全子树。
    stopExternalSplitObserver?.()
    stopExternalSplitObserver = observeExternalSplit(() => { if (splitStore.active) splitStore.close() })
    this.notify()
    return true
  },

  /** 会话根失效（切换会话 / hero↔active 结构变化）时重新锚定：左侧内容保持不关闭；无会话根才关闭 */
  syncAnchor() {
    if (!this.active) return
    const next = findConversationRoot()
    if (!next) {
      this.close()
      return
    }
    const ph = next.dataset.phase
    if (ph !== 'active' && ph !== 'hero') return // settling 等过渡态：保持等待（phase 变化会再次触发）
    const anchor = resolveAnchor(next)
    if (next === this.root && anchor.header === this.header && anchor.viewArea === this.viewArea) {
      // 同锚点：头部可能由隐藏变可见（hero→active），刷新几何与挤位
      this.refreshGeom()
      this.applyMargin()
      this.notify()
      return
    }
    const viewArea = anchor.viewArea
    const oldRoot = this.root
    const oldViewArea = this.viewArea
    // 恢复旧锚点（若仍连接），锚定到新会话根
    if (oldViewArea && oldViewArea.isConnected && oldViewArea !== viewArea) {
      oldViewArea.style.marginLeft = this.savedMarginLeft
      oldViewArea.style.marginRight = this.savedMarginRight
      oldViewArea.style.marginTop = this.savedMarginTop
    }
    if (oldRoot && oldRoot.isConnected && oldRoot !== next) {
      if (this.savedWidthVar) oldRoot.style.setProperty('--dsh-chat-user-width', this.savedWidthVar)
      else oldRoot.style.removeProperty('--dsh-chat-user-width')
    }
    this.root = next
    this.header = anchor.header
    this.viewArea = viewArea
    // 仅锚点元素真正更换时才记录「打开前」原值——同元素重锚（hero→active 头部出现）
    // 必须保留最初存档，否则关闭时会把已应用的 margin/变量误还原成「新原值」
    if (oldRoot !== next) {
      this.savedWidthVar = next.style.getPropertyValue('--dsh-chat-user-width')
    }
    if (oldViewArea !== viewArea) {
      this.savedMarginLeft = viewArea.style.marginLeft
      this.savedMarginRight = viewArea.style.marginRight
      this.savedMarginTop = viewArea.style.marginTop
    }
    this.observer?.disconnect()
    this.observer.observe(next)
    this.refreshGeom()
    this.applyMargin()
    this.notify()
  },

  refreshGeom() {
    const root = this.root
    if (!root) return
    const rr = root.getBoundingClientRect()
    const hr = this.header ? this.header.getBoundingClientRect() : null
    // 头部隐藏（blank 会话）或无头部（0.1.2 无会话）时以根顶部为分栏上沿
    const top = hr && hr.height > 0 ? hr.bottom : rr.top
    this.geom = { left: rr.left, top, right: rr.right, bottom: rr.bottom }
  },

  applyMargin() {
    const viewArea = this.viewArea
    const g = this.geom
    const spec = this.spec
    if (!viewArea || !g || !spec) return
    const colW = g.right - g.left
    const rowH = g.bottom - g.top
    // 会话全屏：内容列宽 0（内容窗整体隐藏），官方会话视图占满整宽，只让出标题栏高度
    if (spec.chatOnly === true) {
      if (this.root && this.root.isConnected) {
        this.root.style.setProperty('--dsh-chat-user-width', Math.round(colW) + 'px')
      }
      this.lastMarginLeft = ''
      this.lastMarginRight = ''
      this.lastMarginTop = BAR_H + 'px'
      viewArea.style.marginLeft = ''
      viewArea.style.marginRight = ''
      viewArea.style.marginTop = this.lastMarginTop
      return
    }
    const hasLeft = !!spec.left
    const hasTop = !!(spec.top && spec.top.length > 0)
    // 占比模式：未手动拖动时聊天宽 = 可用宽 × 占比，窗口缩放仍保持等分（如左右布局恒定 1/2）
    if (!this.chatWManual && spec.chatWidthRatio) this.chatW = Math.round(colW * spec.chatWidthRatio)
    // 全屏布局：对话列收成 0 宽（内容满宽）；💬 拉出时才按存档宽度显示
    const hiddenChat = spec.chatHidden === true && !this.chatPeek
    const chatW = hiddenChat ? 0 : clamp(this.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60))
    // 会话内容宽 clamp(680px, …, 920px) 不随挤出的聊天列收缩 → 显式钉到挤出的列宽
    // （close/重锚定时原样恢复；0.1.1 上该 CSS 变量闲置，设置无害）
    if (this.root && this.root.isConnected) {
      this.root.style.setProperty('--dsh-chat-user-width', Math.round(chatW) + 'px')
    }
    const topH = hasTop
      ? clamp(this.topH, spec.topHeight?.min ?? 80, Math.max(spec.topHeight?.min ?? 80, rowH - BAR_H - 80))
      : 0
    const leftW = hasLeft
      ? clamp(this.leftW, spec.leftWidth?.min ?? 160, Math.max(spec.leftWidth?.min ?? 160, colW - 260))
      : 0
    const chatFull = spec.chatFullHeight === true
    const gap = Math.max(0, colW - chatW) + 'px'
    const mt = (BAR_H + (hasTop && !chatFull ? topH : 0)) + 'px'
    const chatLeft = !hasLeft && spec.chatSide === 'left'
    this.lastMarginLeft = hasLeft ? leftW + 'px' : (chatLeft ? '' : gap)
    this.lastMarginRight = hasLeft ? '' : (chatLeft ? gap : '')
    this.lastMarginTop = mt
    viewArea.style.marginLeft = this.lastMarginLeft
    viewArea.style.marginRight = this.lastMarginRight
    viewArea.style.marginTop = mt
  },

  setChatW(w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    if (spec.chatHidden === true && !this.chatPeek) return // 全屏布局未拉出对话列：不可拖
    if (spec.chatOnly === true) return // 会话全屏：没有内容列可拖
    this.chatWManual = true // 手动拖动：退出占比模式，转固定像素
    const colW = g.right - g.left
    const main = spec.main ?? []
    const minContent = main.reduce((a, p) => a + p.min, 0) + Math.max(0, main.length - 1) * GAP
    const hi = Math.max(spec.chatWidth.min, colW - minContent)
    this.chatW = clamp(Math.round(w), spec.chatWidth.min, hi)
    this.applyMargin()
    this.schedulePersist()
    this.notify()
  },

  setTopH(h) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const rowH = g.bottom - g.top
    const lo = spec.topHeight?.min ?? 80
    const hi = Math.max(lo, rowH - BAR_H - 80)
    this.topH = clamp(Math.round(h), lo, hi)
    this.applyMargin()
    this.schedulePersist()
    this.notify()
  },

  setLeftW(w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec || !spec.left) return
    const colW = g.right - g.left
    const lo = spec.leftWidth?.min ?? 160
    const hi = Math.max(lo, colW - 260)
    this.leftW = clamp(Math.round(w), lo, hi)
    this.applyMargin()
    this.schedulePersist()
    this.notify()
  },

  setPaneW(i, w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const main = spec.main ?? []
    if (i < 0 || i >= main.length) return
    const colW = g.right - g.left
    const chatW = clamp(this.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60))
    const contentW = Math.max(0, colW - chatW)
    const othersMin = main.reduce((a, p, k) => a + (k === i ? 0 : p.min), 0)
    const lo = main[i].min
    const hi = Math.max(lo, contentW - othersMin - Math.max(0, main.length - 1) * GAP)
    const next = this.paneWs.slice()
    next[i] = clamp(Math.round(w), lo, hi)
    this.paneWs = next
    this.schedulePersist()
    this.notify()
  },

  setTopW(i, w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const top = spec.top ?? []
    if (i < 0 || i >= top.length) return
    const colW = g.right - g.left
    const othersMin = top.reduce((a, p, k) => a + (k === i ? 0 : p.min), 0)
    const lo = top[i].min
    const hi = Math.max(lo, colW - othersMin - Math.max(0, top.length - 1) * GAP)
    const next = this.topWs.slice()
    next[i] = clamp(Math.round(w), lo, hi)
    this.topWs = next
    this.schedulePersist()
    this.notify()
  },

  setPaneContent(row, i, content) {
    if (content) this.openTab(row, i, content)
  },

  lockPane(row, i, content) {
    const spec = this.spec
    if (!spec) return
    const tab: PaneTab = { id: 't' + Date.now().toString(36), title: tabTitleOf(content), content, active: 0 }
    const mutate = (pane: SplitPane): SplitPane => ({ ...pane, content: null, tabs: [tab], active: 0 })
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  /** 更新指定标签页的内容（浏览器/动画窗地址栏回车时回写），并持久化到布局条目 */
  setTabContent(row, index, tabId, content) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = (pane.tabs ?? []).map((t) => (t.id === tabId ? { ...t, content, title: tabTitleOf(content) } : t))
      return { ...pane, tabs }
    }
    if (row === 'left') {
      if (spec.left && index === 0) this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (top[index]) { top[index] = mutate(top[index]); this.spec = { ...spec, top } }
    } else {
      const main = [...spec.main]
      if (main[index]) { main[index] = mutate(main[index]); this.spec = { ...spec, main } }
    }
    this.onSpecMutated?.(this.spec)
    this.notify()
  },

  openTab(row, i, content) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = [...(pane.tabs ?? [])]
      // 去重：同内容已有标签 → 直接激活
      const existing = tabs.findIndex((t) => sameContent(t.content, content))
      if (existing >= 0) return { ...pane, content: null, tabs, active: existing }
      const tab: PaneTab = { id: 't' + Date.now().toString(36), title: tabTitleOf(content), content }
      tabs.push(tab)
      return { ...pane, content: null, tabs, active: tabs.length - 1 }
    }
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  closeTab(row, i, tabId) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = (pane.tabs ?? []).filter((t) => t.id !== tabId)
      return { ...pane, tabs, active: 0 }
    }
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  moveTab(fromRow, fromI, tabId, toRow, toI) {
    const spec = this.spec
    if (!spec) return
    if (fromRow === toRow && fromI === toI) return
    const top = [...(spec.top ?? [])]
    const main = [...spec.main]
    const left = spec.left ? { ...spec.left } : null
    const arrOf = (row: PaneRow): SplitPane[] => (row === 'left' ? (left ? [left] : []) : row === 'top' ? top : main)
    const fromArr = arrOf(fromRow)
    const toArr = arrOf(toRow)
    const fromPane = fromArr[fromI]
    const toPane = toArr[toI]
    if (!fromPane || !toPane) return
    const tab = (fromPane.tabs ?? []).find((t) => t.id === tabId)
    if (!tab) return
    const fromTabs = (fromPane.tabs ?? []).filter((t) => t.id !== tabId)
    const toTabs = [...(toPane.tabs ?? []), tab]
    const setPane = (row: PaneRow, i: number, pane: SplitPane) => {
      if (row === 'left') spec.left = pane
      else if (row === 'top') top[i] = pane
      else main[i] = pane
    }
    setPane(fromRow, fromI, { ...fromPane, tabs: fromTabs, active: 0 })
    setPane(toRow, toI, { ...toPane, tabs: toTabs, active: toTabs.length - 1 })
    this.spec = { ...spec, left: left ?? null, top: top.length > 0 ? top : null, main }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  setActiveTab(row, i, tabId) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => {
      const idx = (pane.tabs ?? []).findIndex((t) => t.id === tabId)
      if (idx < 0) return pane
      return { ...pane, active: idx }
    }
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  toggleCollapsed(row, i) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => ({ ...pane, collapsed: !pane.collapsed })
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  swapPanes(aRow, aI, bRow, bI) {
    const spec = this.spec
    if (!spec) return
    const top = [...(spec.top ?? [])]
    const main = [...spec.main]
    const left = spec.left ? { ...spec.left } : null
    const arrOf = (row: PaneRow): SplitPane[] => (row === 'left' ? (left ? [left] : []) : row === 'top' ? top : main)
    const setOf = (row: PaneRow, i: number, pane: SplitPane) => {
      if (row === 'left') spec.left = pane
      else if (row === 'top') top[i] = pane
      else main[i] = pane
    }
    const a = arrOf(aRow)[aI]
    const b = arrOf(bRow)[bI]
    if (!a || !b) return
    setOf(aRow, aI, b)
    setOf(bRow, bI, a)
    const wsOf = (row: PaneRow): number[] => (row === 'left' ? this.leftWs : row === 'top' ? this.topWs : this.paneWs)
    const setWs = (row: PaneRow, i: number, v: number) => {
      if (row === 'left') { const n = this.leftWs.slice(); n[i] = v; this.leftWs = n }
      else if (row === 'top') { const n = this.topWs.slice(); n[i] = v; this.topWs = n }
      else { const n = this.paneWs.slice(); n[i] = v; this.paneWs = n }
    }
    const aW = wsOf(aRow)[aI]
    const bW = wsOf(bRow)[bI]
    setWs(aRow, aI, bW)
    setWs(bRow, bI, aW)
    this.spec = { ...spec, left: left ?? null, top: top.length > 0 ? top : null, main }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  setChatSide(side) {
    const spec = this.spec
    if (!spec) return
    if (spec.left) return // 左列布局：聊天固定右下
    this.spec = { ...spec, chatSide: side }
    this.onSpecMutated?.(this.spec)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  /** 全屏布局：标题栏 💬 临时拉出/收回对话列（只改内存，不写存档 —— 重开仍是全屏） */
  toggleChatPeek() {
    const spec = this.spec
    if (!spec || spec.chatHidden !== true) return
    this.chatPeek = !this.chatPeek
    this.applyMargin()
    this.notify()
  },

  persist() {
    if (!this.spec) return
    persistSaved(this.spec.id, { chatW: this.chatW, chatWManual: this.chatWManual, topH: this.topH, leftW: this.leftW, paneWs: this.paneWs, topWs: this.topWs, leftWs: this.leftWs })
  },

  /** 拖分隔线时不逐事件落盘（读整张表 + parse + stringify + 写，每帧一次），改成合并写 */
  schedulePersist() {
    if (this.persistTimer != null) return
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null
      this.persist()
    }, 180)
  },

  /** 立即补写（松手 / 页面收尾用） */
  flushPersist() {
    if (this.persistTimer == null) return
    window.clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.persist()
  },

  close() {
    // 拖到一半就关窗 / 换布局：先把没写完的存档补上（spec 即将置空，persist 会跳过）
    this.flushPersist()
    if (this.root && this.root.isConnected) {
      if (this.savedWidthVar) this.root.style.setProperty('--dsh-chat-user-width', this.savedWidthVar)
      else this.root.style.removeProperty('--dsh-chat-user-width')
    }
    if (this.viewArea) {
      this.viewArea.style.marginLeft = this.savedMarginLeft
      this.viewArea.style.marginRight = this.savedMarginRight
      this.viewArea.style.marginTop = this.savedMarginTop
    }
    this.observer?.disconnect()
    this.observer = null
    this.fallback?.disconnect()
    this.fallback = null
    this.yieldObserver?.disconnect()
    this.yieldObserver = null
    stopExternalSplitObserver?.()
    stopExternalSplitObserver = null
    this.root = null
    this.header = null
    this.viewArea = null
    this.savedWidthVar = ''
    this.geom = null
    this.spec = null
    this.chatPeek = false
    this.active = false
    this.notify()
  },

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },

  notify() {
    for (const fn of this.listeners) fn()
  },
}

/** 外来分栏互斥观察器按 splitStore 生命周期安装；分栏未开启时零 body 观察器。 */
let stopExternalSplitObserver: (() => void) | null = null

/** 分配各窗宽度（最后一个拿余量） */
function allocate(panes: SplitPane[], ws: number[], total: number) {
  const out: { pane: SplitPane; left: number; width: number }[] = []
  const gapTotal = Math.max(0, panes.length - 1) * GAP
  const avail = Math.max(0, total - gapTotal)
  let x = 0
  panes.forEach((p, i) => {
    const w = i === panes.length - 1 ? Math.max(0, avail - x) : ws[i]
    out.push({ pane: p, left: x, width: w })
    x += w + GAP
  })
  return out
}

/** 通用分隔线拖拽（chat/top/pane/topPane） */
function makeDividerHandler(kind: 'left' | 'chat' | 'top' | 'pane' | 'topPane', index?: number) {
  return (e: any) => {
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    try { target.setPointerCapture(e.pointerId) } catch {}
    // 分隔线拖拽：原来每个指针事件都跑一遍「换算宽 → 写 margin → 落盘 → 通知整棵工作区重渲染」。
    // 同一帧里来多个指针事件（高频指针 + 高刷屏更明显）就会做几倍的工作，拖起来掉帧。
    // 合并成「每帧一次」：宽度照最新指针位置算，最后一帧补一次落点，松手再补写存档。
    let pending: { x: number; y: number } | null = null
    let frame: number | null = null
    const apply = (x: number, y: number) => {
      const g = splitStore.geom
      if (!g) return
      if (kind === 'left') {
        splitStore.setLeftW(x - g.left)
      } else if (kind === 'chat') {
        splitStore.setChatW(g.right - x)
      } else if (kind === 'top') {
        splitStore.setTopH(y - g.top - BAR_H)
      } else if (kind === 'pane' && index != null) {
        const prefix = splitStore.paneWs.slice(0, index).reduce((a, b) => a + b, 0) + index * GAP
        splitStore.setPaneW(index, x - (g.left + prefix))
      } else if (kind === 'topPane' && index != null) {
        const prefix = splitStore.topWs.slice(0, index).reduce((a, b) => a + b, 0) + index * GAP
        splitStore.setTopW(index, x - (g.left + prefix))
      }
    }
    const onMove = (ev: PointerEvent) => {
      pending = { x: ev.clientX, y: ev.clientY }
      if (frame != null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        const p = pending
        pending = null
        if (p) apply(p.x, p.y)
      })
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      if (frame != null) {
        window.cancelAnimationFrame(frame)
        frame = null
        // 松手时最后一帧没跑过：补上，落点不丢
        const p = pending
        pending = null
        if (p) apply(p.x, p.y)
      }
      splitStore.flushPersist()
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }
}

/** 浏览器内置窗：地址栏 + 前往；刷新统一在标签栏最左（重挂载 iframe，跨域也可靠） */
function BrowserPane(props: { row: PaneRow; index: number; tabId: string; content: SplitContent; reloadKey: number }) {
  const initial = props.content?.url || 'https://example.com'
  const [url, setUrl] = useState(initial)
  const [src, setSrc] = useState(initial)
  const go = () => {
    const u = url.trim()
    const ok = /^(\/|https?:\/\/)/i.test(u) ? u : 'about:blank'
    setSrc(ok)
    if (ok !== 'about:blank') {
      // 地址回写：刷新/重开布局时保持当前网址
      splitStore.setTabContent(props.row, props.index, props.tabId, { kind: 'builtin', type: 'browser', url: ok })
    }
  }
  return (
    <>
      <div className="dsh-wt_browserBar">
        <input
          className="dsh-wt_browserInput"
          value={url}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
        />
        <button type="button" className="dsh-wt_browserGo" onClick={go}>↗</button>
      </div>
      <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={src} title="browser" />
    </>
  )
}

/** iframe 内容标签（网页/站点产物）：刷新统一在标签栏最左（重挂载整页刷新，跨域可靠） */
function IframePane(props: { url: string; title?: string; reloadKey: number }) {
  return <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={props.url} title={props.title ?? ''} />
}

/** 动画播放窗：iframe 壳 + 地址栏（站内自带项目/场景列表、播放、画幅切换、导出等全部控件） */
function AnimPane(props: { row: PaneRow; index: number; tabId: string; content: SplitContent; reloadKey: number }) {
  const initial = props.content?.url || ''
  const [url, setUrl] = useState(initial)
  const [src, setSrc] = useState(initial || 'about:blank')
  const go = () => {
    const u = url.trim()
    const ok = /^(\/|https?:\/\/)/i.test(u) ? u : 'about:blank'
    setSrc(ok)
    if (ok !== 'about:blank') {
      splitStore.setTabContent(props.row, props.index, props.tabId, { kind: 'builtin', type: 'anim', url: ok })
    }
  }
  return (
    <>
      <div className="dsh-wt_browserBar">
        <input
          className="dsh-wt_browserInput"
          value={url}
          placeholder={T('pane.animUrlPh')}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
        />
        <button type="button" className="dsh-wt_browserGo" onClick={go}>↗</button>
      </div>
      <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={src} title="anim" />
    </>
  )
}

/** 主题图标（描边风格）：dark=月 / light=日 / system=电脑；主按钮与下拉共用 */
function ThemeIcon({ mode, size }: { mode: 'dark' | 'light' | 'system'; size?: number }) {
  const s = size ?? 18
  if (mode === 'dark') return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><path d="M14 8.53A6 6 0 1 1 7.47 2 4.67 4.67 0 0 0 14 8.53z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" /></svg>
  if (mode === 'light') return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="0.9" /><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>
  return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><rect x="2" y="3.2" width="12" height="8.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="0.9" /><path d="M5.4 14.4h5.2M8 12v2.4" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>
}

/** 两行滑杆图标（设置入口）：2 条轨道 + 2 个旋钮，描边风格 */
function SliderIcon({ size }: { size?: number }) {
  const s = size ?? 14
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 5.6h11M2.5 10.4h11" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="10.4" cy="5.6" r="1.8" fill="currentColor" />
      <circle cx="5.8" cy="10.4" r="1.8" fill="currentColor" />
    </svg>
  )
}

/** HSL 数值普通输入框：始终为常规边框输入框，输入提交时自动钳制到 0..max */
function HslValInput(props: { value: number; max: number; min?: number; onCommit: (n: number) => void }) {
  const lo = props.min ?? 0
  const [draft, setDraft] = useState(String(props.value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setDraft(String(props.value)) }, [props.value, focused])
  const commit = () => {
    let n = parseInt(draft, 10)
    if (!Number.isFinite(n)) n = props.value
    n = Math.min(Math.max(n, lo), props.max)
    props.onCommit(n)
  }
  return (
    <input
      className="dsh-wt_hslInput"
      type="number"
      min={lo}
      max={props.max}
      value={focused ? draft : String(props.value)}
      onFocus={() => { setFocused(true); setDraft(String(props.value)) }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') { setDraft(String(props.value)); (e.target as HTMLInputElement).blur() }
      }}
    />
  )
}

/** 纯色背景默认值（与主题关联）：深色 = 原深蓝黑 #0a0d13；浅色 = 白 #eef1f5；网格线由 --wt-grid 主题变量自动切换 */
const PLAIN_HSL_DARK = { h: -140, s: 31, l: 6 }
const PLAIN_HSL_LIGHT = { h: -146, s: 26, l: 95 }

/** 循环视频背景：首尾帧交叉渐变——双轨重叠过渡（尾帧淡出→头帧淡入），消除循环「卡一下」。
 *  两轨共用同一源；备用轨仅在交接窗口播放，其余时间暂停（解码负担仅 ~1.2s/循环）。 */
function ConsoleVideo(props: { src: string; style?: CSSProperties }) {
  const aRef = useRef<HTMLVideoElement | null>(null)
  const bRef = useRef<HTMLVideoElement | null>(null)
  const roleRef = useRef<'a' | 'b'>('a')
  const firedRef = useRef(false)
  useEffect(() => {
    const role = () => (roleRef.current === 'a' ? aRef.current : bRef.current)
    const spare = () => (roleRef.current === 'a' ? bRef.current : aRef.current)
    firedRef.current = false
    let raf = 0
    let stopped = false
    const onEnded = () => {
      const m = role()
      const s = spare()
      if (!m || !s) return
      // 主轨播完：备用轨已成为新主轨（淡入完成）；旧主轨复位为备用轨
      roleRef.current = roleRef.current === 'a' ? 'b' : 'a'
      firedRef.current = false
      try {
        m.currentTime = 0
        m.pause()
        m.style.opacity = '0'
        m.getAnimations().forEach((an) => an.cancel())
      } catch {}
      try {
        const nm = role()
        if (nm) nm.style.opacity = '1'
      } catch {}
    }
    const tick = () => {
      if (stopped) return
      const m = role()
      const s = spare()
      if (m && s && !m.paused && m.readyState >= 2 && !firedRef.current) {
        const d = m.duration
        if (Number.isFinite(d) && d > 0) {
          const fade = Math.min(2.0, Math.max(1.2, d * 0.18))
          if (m.currentTime >= Math.max(0, d - fade)) {
            firedRef.current = true
            try {
              try { s.currentTime = 0 } catch {}
              const startFade = () => {
                try {
                  try { m.getAnimations().forEach((an) => an.cancel()) } catch {}
                  try { s.getAnimations().forEach((an) => an.cancel()) } catch {}
                  s.play().catch(() => {})
                  s.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade * 1000, easing: 'linear', fill: 'forwards' })
                  m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade * 1000, easing: 'linear', fill: 'forwards' })
                } catch {}
              }
              if (s.readyState >= 2) startFade()
              else s.addEventListener('canplay', startFade, { once: true })
            } catch {}
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    aRef.current?.addEventListener('ended', onEnded)
    bRef.current?.addEventListener('ended', onEnded)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      aRef.current?.removeEventListener('ended', onEnded)
      bRef.current?.removeEventListener('ended', onEnded)
    }
  }, [])
  return (
    <>
      <video ref={aRef} className="dsh-wt_consoleMedia" src={props.src} muted autoPlay playsInline style={props.style} />
      <video ref={bRef} className="dsh-wt_consoleMedia" src={props.src} muted playsInline style={{ ...props.style, opacity: 0 }} />
    </>
  )
}

/** 运行秒表独立刷新：只重渲染这一小段文本，不让整个控制室每秒重建全部卡片。 */
function ConsoleRuntime({ value }: { value: number }) {
  const [elapsed, setElapsed] = useState(value)
  useEffect(() => {
    setElapsed(value)
    const mountedAt = Date.now()
    const iv = window.setInterval(() => {
      if (document.visibilityState === 'visible') setElapsed(value + Date.now() - mountedAt)
    }, 1000)
    return () => window.clearInterval(iv)
  }, [value])
  const seconds = Math.max(0, Math.floor(elapsed / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const text = h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0')
  return <span className="dsh-wt_consoleRuntime">{text}</span>
}

/** 控制室面板：项目卡片网格（每行 3 张、超出换行）；数据由工作台组装推送（纯读镜像）。
 *  主题：dark/light 直接生效；system = 跟随宿主 html 的 color-scheme（DSH 深色/白色/跟随系统都会反映到它） */
export function ConsolePane() {
  const [cardsRevision, setCardsRevision] = useState(0)
  const [cols, setColsState] = useState<number>(() => splitEnv?.console?.getCols?.() ?? 0)
  const [autoCols, setAutoCols] = useState(3)
  const [shape, setShapeState] = useState<'square' | 'circle'>(() => splitEnv?.console?.getShape?.() ?? 'square')
  const [bg, setBgState] = useState<'plain' | 'glow' | 'photo'>(() => splitEnv?.console?.getBg?.() ?? 'glow')
  const [bgPhoto, setBgPhoto] = useState<string>('')
  const [photoId, setPhotoIdLocal] = useState<string>('')
  const [photoList, setPhotoList] = useState<{ id: string; kind: 'photo' | 'video'; url: string }[]>([])
  const [bgVideo, setBgVideo] = useState<string>('')
  const [photoGrid, setPhotoGridState] = useState<boolean>(() => splitEnv?.console?.getPhotoGrid?.() ?? true)
  const [gridOpacity, setGridOpacityState] = useState<number>(() => splitEnv?.console?.getGridOpacity?.() ?? 8)
  const [cardBlur, setCardBlurState] = useState<number>(() => splitEnv?.console?.getCardBlur?.() ?? 8)
  const [plainBlur, setPlainBlurState] = useState<number>(() => splitEnv?.console?.getPlainBlur?.() ?? 0)
  const [glowBlur, setGlowBlurState] = useState<number>(() => splitEnv?.console?.getGlowBlur?.() ?? 8)
  const [plainGrid, setPlainGridState] = useState<number>(() => splitEnv?.console?.getPlainGrid?.() ?? 5)
  const [glowGrid, setGlowGridState] = useState<number>(() => splitEnv?.console?.getGlowGrid?.() ?? 8)
  const [glowSpeed, setGlowSpeedState] = useState<number>(() => splitEnv?.console?.getGlowSpeed?.() ?? 50)
  const [annOpen, setAnnOpen] = useState(false)
  /** 卡片「会话列表」浮层：该项目目录下的会话 + 锚点坐标（点某一项即进入该会话，历史保留可继续） */
  const [sessPop, setSessPop] = useState<{ name: string; x: number; y: number; items: ProjectSessionItem[]; transient?: boolean } | null>(null)
  /** 会话列表是否显示已归档项 */
  const [sessShowArchived, setSessShowArchived] = useState(false)
  /** 新建会话面板：项目 id/名称 + 模式 + 前台/后台模型 */
  const [newSessFor, setNewSessFor] = useState<{ id: string; name: string } | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  /** 只看进行中：底部工具条漏斗按钮一键切换，藏掉空闲 / 已完成的项目卡片（不写存档，重开控制室回到全部） */
  const [onlyWorking, setOnlyWorking] = useState(false)
  /** 项目管理：拖动排序（pointer 事件，鼠标/触屏通用）。targetId/before = 落点提示（目标行上/下边缘高亮）。 */
  const [manageDrag, setManageDrag] = useState<{ id: string; targetId: string; before: boolean } | null>(null)
  const manageDragIdRef = useRef<string | null>(null)
  const manageDropRef = useRef<{ targetId: string; before: boolean } | null>(null)
  const manageListRef = useRef<HTMLDivElement | null>(null)
  /** 按住行首「⋮⋮」开始拖：只捕获指针、记下被拖行，落点由 pointermove 现算 */
  const beginManageDrag = (e: any, id: string): void => {
    e.preventDefault(); e.stopPropagation()
    manageDragIdRef.current = id
    manageDropRef.current = null
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    setManageDrag({ id, targetId: id, before: true })
  }
  /** 拖动中：按指针 Y 找最近的行（在行中点之上=插到它前面，之下=插到它后面） */
  const moveManageDrag = (e: any): void => {
    const dragId = manageDragIdRef.current
    const container = manageListRef.current
    if (!dragId || !container) return
    e.preventDefault()
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-pid]'))
    let targetId = ''
    let before = false
    for (const el of rows) {
      const pid = el.dataset.pid ?? ''
      if (!pid || pid === dragId) continue
      const r = el.getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) { targetId = pid; before = true; break }
      targetId = pid; before = false
    }
    if (!targetId) return
    // 落点没变就不 setState：拖动时每次 pointermove 都重渲染整个控制室面板（卡片会重算预览），很吃性能
    const prev = manageDropRef.current
    if (prev && prev.targetId === targetId && prev.before === before) return
    manageDropRef.current = { targetId, before }
    setManageDrag({ id: dragId, targetId, before })
  }
  /** 松手：把被拖行插到落点（同一行 = 不动）；排序写回 projects.order */
  const endManageDrag = (): void => {
    const dragId = manageDragIdRef.current
    const drop = manageDropRef.current
    manageDragIdRef.current = null
    manageDropRef.current = null
    setManageDrag(null)
    if (!dragId || !drop || drop.targetId === dragId) return
    splitEnv?.console?.onReorderProject?.(dragId, drop.targetId, drop.before)
  }
  /** 项目管理：正在改名的行 id（输入框非受控，提交时读 DOM 值；Esc = 放弃） */
  const [renameId, setRenameId] = useState<string | null>(null)
  const renameCancelRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  /** 开始改名：清掉上一次的放弃标记 */
  const beginRename = (id: string): void => {
    renameCancelRef.current = false
    setRenameId(id)
  }
  /** 结束改名（blur / Enter）：空名 = 清掉覆盖、恢复默认名 */
  const endRename = (): void => {
    const id = renameId
    const canceled = renameCancelRef.current
    renameCancelRef.current = false
    const value = (renameInputRef.current?.value ?? '').trim()
    setRenameId(null)
    if (!id || canceled) return
    splitEnv?.console?.onRenameProject?.(id, value)
  }
  const [newSessMode, setNewSessMode] = useState<'standard' | 'computer-use'>('standard')
  const [newSessModels, setNewSessModels] = useState<OrbModel[]>([])
  const [newSessModelsLoading, setNewSessModelsLoading] = useState(false)
  const [newSessFront, setNewSessFront] = useState<{ provider: string; model: string; name?: string } | null>(null)
  const [newSessBg, setNewSessBg] = useState<{ provider: string; model: string; name?: string } | null>(null)
  const [newSessBusy, setNewSessBusy] = useState(false)
  const newSessRequestRef = useRef(0)
  const newSessModelsRef = useRef<OrbModel[]>([])
  const newSessBgRequestRef = useRef<Promise<unknown> | null>(null)
  /** 当前模式镜像：异步目录回调里用最新模式，避免切模式后被旧模式的选择覆盖。 */
  const newSessModeRef = useRef<'standard' | 'computer-use'>('standard')
  newSessModeRef.current = newSessMode
  /** 宿主模型目录的默认模型（没有上次选择时用它，不再给「默认」空选项）。 */
  const newSessCatalogDefaultRef = useRef<{ provider: string; model: string } | null>(null)
  /** 用户是否手动改过后台模型：改过之后异步加载的后台设置不再覆盖。 */
  const newSessBgTouchedRef = useRef(false)
  /** 当前宿主会话正在用的模型——用户「上一次选择的模型」的最准来源。 */
  const currentSessionModel = (): NewSessModel | null => {
    const api = getAssistantApi()
    const sid = splitEnv?.getScope?.()?.sessionId ?? ''
    if (!api || !sid) return null
    try {
      const row = api.sessionRow(sid)
      const sel = row?.modelSelection?.next ?? row?.modelSelection?.lastUsed
      if (sel?.provider && sel.model) return { provider: sel.provider, model: sel.model, name: sel.model }
    } catch {}
    return null
  }
  /** 上次在这个面板里给某种模式选的模型（标准 / 电脑操作分开存）。 */
  const modelPrefOf = (mode: 'standard' | 'computer-use'): NewSessModel | null =>
    readModelPref(mode === 'computer-use' ? 'cu' : 'standard')
  /** 前台模型偏好顺序：
   *  普通对话 = 当前会话正在用的 → 面板上次选的 → 目录默认 → 目录第一个；
   *  电脑操作 = 设置页/面板上次选的 CU 前台模型 → 当前会话 → 目录默认 → 目录第一个
   *  （设置页的「前台模型（Computer Use 会话）」是显式配置，不应被当前会话覆盖）。 */
  const frontPreferences = (mode: 'standard' | 'computer-use'): (NewSessModel | null)[] =>
    mode === 'computer-use'
      ? [modelPrefOf(mode), currentSessionModel()]
      : [currentSessionModel(), modelPrefOf(mode)]
  /** 行内重命名：正在编辑的会话 id 与输入草稿 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [updStatus, setUpdStatus] = useState<UpdateStatus>(() => readCache().status)
  const [updInfo, setUpdInfo] = useState<UpdateInfo | null>(() => readCache().info)
  const [autoCheckOn, setAutoCheckOn] = useState<boolean>(() => getAutoCheck())
  const updBusyRef = useRef(false)
  const photoUrlRef = useRef<string>('')
  const photoUrlsRef = useRef<Set<string>>(new Set())
  const trackPhotoUrl = (url: string): void => { if (url) photoUrlsRef.current.add(url) }
  const releasePhotoUrl = (url: string): void => {
    if (!url || !photoUrlsRef.current.delete(url)) return
    try { URL.revokeObjectURL(url) } catch {}
  }
  const releaseAllPhotoUrls = (): void => {
    for (const url of photoUrlsRef.current) { try { URL.revokeObjectURL(url) } catch {} }
    photoUrlsRef.current.clear()
  }
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [bgEdit, setBgEdit] = useState<'plain' | 'glow' | 'photo' | null>(null)
  const [plainHsl, setPlainHslState] = useState<{ h: number; s: number; l: number }>(() => {
    const saved = splitEnv?.console?.getPlainHsl?.()
    if (saved) return saved
    return splitEnv?.console?.getTheme?.() === 'light' ? { ...PLAIN_HSL_LIGHT } : { ...PLAIN_HSL_DARK }
  })
  const [glowHsl, setGlowHslState] = useState<{ h: number; s: number; l: number }>(() => splitEnv?.console?.getGlowHsl?.() ?? { h: 0, s: 100, l: 100 })
  const [photoHsl, setPhotoHslState] = useState<{ h: number; s: number; l: number }>({ h: 0, s: 100, l: 100 })
  const gridRef = useRef<HTMLDivElement | null>(null)
  const firstRectsRef = useRef<Map<string, { x: number; y: number }> | null>(null)
  const onCols = (n: number) => {
    const grid = gridRef.current
    if (grid) {
      const rects = new Map<string, { x: number; y: number }>()
      grid.querySelectorAll('.dsh-wt_consoleCard').forEach((el) => {
        const key = (el as HTMLElement).dataset.flip ?? ''
        const r = el.getBoundingClientRect()
        rects.set(key, { x: r.left, y: r.top })
      })
      firstRectsRef.current = rects
    }
    setColsState(n)
    splitEnv?.console?.setCols?.(n)
  }
  /** 自适应列数：cols = 0（自动）时按容器宽度算每行能放几张（手机 1-2 张、电脑 3-5 张）。
   *  手动选 1-5 仍优先；换列动画只在手动切换时播（onCols 记录首帧位置）。 */
  const effectiveCols = cols === 0 ? autoCols : cols
  useEffect(() => {
    if (cols !== 0) return
    const el = gridRef.current
    if (!el) return
    const calc = () => {
      const width = el.clientWidth || el.getBoundingClientRect().width || 0
      if (width <= 0) return
      // 用实际 gap（窄屏媒体查询会把 64px 压到 20px）与 150px 最小卡宽推导列数
      let gap = 64
      try { gap = parseFloat(getComputedStyle(el).columnGap || '') || 64 } catch {}
      const n = Math.max(1, Math.min(5, Math.floor((width + gap) / (150 + gap))))
      setAutoCols((prev) => (prev === n ? prev : n))
    }
    calc()
    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(calc)
      ro.observe(el)
    } catch {}
    window.addEventListener('resize', calc)
    return () => {
      try { ro?.disconnect() } catch {}
      window.removeEventListener('resize', calc)
    }
  }, [cols])
  const onShape = (s: 'square' | 'circle') => {
    setShapeState(s)
    splitEnv?.console?.setShape?.(s)
  }
  /** 后台模型独立加载，绝不卡住前台目录或标准模式。 */
  const loadNewSessionBackground = (requestId: number): void => {
    const api = getAssistantApi()
    if (!api?.backgroundModel) return
    const task = api.backgroundModel()
    newSessBgRequestRef.current = task
    void task.then((bg) => {
      if (!bg || newSessRequestRef.current !== requestId || newSessBgRequestRef.current !== task) return
      // 用户已经手动选过后台模型：异步结果不再覆盖
      if (newSessBgTouchedRef.current) return
      const next = pickNewSessModel(newSessModelsRef.current, [
        { provider: bg.provider, model: bg.model, name: bg.model },
      ], newSessCatalogDefaultRef.current)
      if (next) setNewSessBg(next)
    }).catch(() => {})
  }
  /** 加载完整模型目录：先读官方模型选择器已经缓存的全局 catalog（最可靠），
   *  再试直接 Remote；都拿不到就短重试。移动端页面刚启动时 Remote 可能还没注入，
   *  只试一次会让下拉里只剩当前会话那一个模型。 */
  const loadNewSessionCatalog = (requestId: number): void => {
    void (async () => {
      const apply = (models: OrbModel[], def: { provider: string; model: string } | null): boolean => {
        if (newSessRequestRef.current !== requestId) return true
        if (models.length === 0) return false
        newSessModelsRef.current = models
        if (def) newSessCatalogDefaultRef.current = def
        setNewSessModels(models)
        setNewSessFront((prev) => pickNewSessModel(
          models,
          [prev, ...frontPreferences(newSessModeRef.current)],
          def ?? newSessCatalogDefaultRef.current,
        ))
        setNewSessModelsLoading(false)
        return true
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        if (newSessRequestRef.current !== requestId) return
        const api = getAssistantApi()
        if (api) {
          // 1) 官方模型选择器的共享目录（通常已由官方输入框加载，移动端最可靠）
          try {
            const official = api.officialModelCatalog?.(splitEnv?.getScope?.()?.sessionId ?? '')
            if (official && apply(official.models, official.default)) return
          } catch { /* 官方目录不可用时继续走 Remote */ }
          // 2) 直接 Remote + 官方/HTTP 兜底（api.modelCatalog 内部已处理超时）
          try {
            const cat = await api.modelCatalog()
            const models = (cat?.models ?? []).filter((m) => m && m.provider && m.model)
            const def = cat?.default && cat.default.provider && cat.default.model ? cat.default : null
            if (apply(models, def)) return
          } catch { /* 网络/宿主暂不可用 */ }
          // 官方目录可能还在首次加载：稍等再读一次，避免刚打开面板时只剩一个模型
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (newSessRequestRef.current !== requestId) return
          try {
            const official = api.officialModelCatalog?.(splitEnv?.getScope?.()?.sessionId ?? '')
            if (official && apply(official.models, official.default)) return
          } catch { /* 仍不可用：交给重试按钮 */ }
          // API 已就绪但目录仍为空：不再空转，直接给「重试」入口
          break
        }
        // api 还没注入（移动端刚打开页面）：等它出现
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      if (newSessRequestRef.current === requestId) setNewSessModelsLoading(false)
    })()
  }
  /** 打开面板立即显示缓存目录，同时后台刷新；catalog 与后台模型互不阻塞。 */
  const openNewSessionPanel = (c: ConsoleCardData, mode: 'standard' | 'computer-use' = 'standard') => {
    const requestId = ++newSessRequestRef.current
    setNewSessFor({ id: c.id, name: c.name })
    setNewSessMode(mode)
    newSessBgTouchedRef.current = false
    const cached = newSessModelsRef.current
    setNewSessFront(pickNewSessModel(cached, frontPreferences(mode), newSessCatalogDefaultRef.current))
    setNewSessBg(pickNewSessModel(cached, [readBgPref()], newSessCatalogDefaultRef.current))
    setNewSessBusy(false)
    setNewSessModels(cached)
    setNewSessModelsLoading(cached.length === 0)
    if (mode === 'computer-use') loadNewSessionBackground(requestId)
    loadNewSessionCatalog(requestId)
  }
  /** 模型目录仍为空时的手动重试（移动端 Remote 刚就绪时很好用） */
  const reloadNewSessionModels = (): void => {
    if (!newSessFor) return
    setNewSessModelsLoading(true)
    loadNewSessionCatalog(newSessRequestRef.current)
  }
  // 模型目录刷新 / 切换模式后，保证前台选择始终是目录里的具体模型（不出现空值）
  useEffect(() => {
    if (!newSessFor) return
    setNewSessFront((prev) => {
      if (prev && newSessModels.some((m) => sameNewSessModel(m, prev))) return prev
      const next = pickNewSessModel(
        newSessModels,
        [prev, ...frontPreferences(newSessMode)],
        newSessCatalogDefaultRef.current,
      )
      return next && !sameNewSessModel(next, prev) ? next : prev
    })
  }, [newSessFor, newSessModels, newSessMode])
  // 电脑操作模式的后台模型同样补成具体模型；异步设置先到也以它为初值
  useEffect(() => {
    if (!newSessFor || newSessMode !== 'computer-use') return
    setNewSessBg((prev) => {
      if (prev && newSessModels.some((m) => sameNewSessModel(m, prev))) return prev
      const next = pickNewSessModel(newSessModels, [prev, readBgPref()], newSessCatalogDefaultRef.current)
      return next && !sameNewSessModel(next, prev) ? next : prev
    })
  }, [newSessFor, newSessMode, newSessModels])
  /** 提交「新建会话」：标准模式也可选前台模型；computer-use 另带后台模型。
   *  建会话是异步的（注册工作区 + 建会话 + 切到新会话约 1s），面板必须留到有结果：
   *  成功才关、失败留在原处并复位按钮——否则「点了创建会话，界面没动」看起来像没反应。 */
  const submitNewSession = () => {
    if (!newSessFor || newSessBusy) return
    const target = newSessFor
    setNewSessBusy(true)
    // 面板里没有「默认」空选项：即使目录还没加载完，也带上当前会话/上次选择的模型
    const front = newSessFront ?? pickNewSessModel(
      newSessModels,
      frontPreferences(newSessMode),
      newSessCatalogDefaultRef.current,
    )
    const background = newSessMode === 'computer-use'
      ? (newSessBg ?? pickNewSessModel(newSessModels, [readBgPref()], newSessCatalogDefaultRef.current))
      : null
    if (front) writeModelPref(newSessMode === 'computer-use' ? 'cu' : 'standard', { provider: front.provider, model: front.model, name: front.name ?? front.model })
    if (background) writeBgPref({ provider: background.provider, model: background.model, name: background.name ?? background.model })
    const opts = {
      mode: newSessMode,
      front,
      background,
    }
    const close = () => setNewSessFor((cur) => (cur && cur.id === target.id ? null : cur))
    try {
      const r = splitEnv?.console?.onCreateSession?.(target.id, opts)
      if (r && typeof (r as Promise<boolean | void>).then === 'function') {
        ;(r as Promise<boolean | void>)
          .then((ok) => { if (ok !== false) close() })
          .catch(() => {})
          .finally(() => setNewSessBusy(false))
      } else {
        close()
        setNewSessBusy(false)
      }
    } catch { setNewSessBusy(false) }
  }
  /** 选择本地图片文件并入库 */
  const pickPhotoFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*,video/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      onFilePhoto(file)
    }
    input.click()
  }
  /** 新增媒体（照片/视频）：原始 Blob 存 IndexedDB（零压缩），显示用对象 URL；自动设为当前 */
  const onFilePhoto = async (file: Blob) => {
    let id = ''
    let url = ''
    let kind: 'photo' | 'video' = file.type && file.type.indexOf('video/') === 0 ? 'video' : 'photo'
    const rec = await (splitEnv?.console?.addPhoto?.(file) ?? Promise.resolve(null)).catch(() => null)
    if (rec) { id = rec.id; url = rec.url; kind = rec.kind } else {
      url = URL.createObjectURL(file)
    }
    trackPhotoUrl(url)
    photoUrlRef.current = url
    setPhotoIdLocal(id)
    if (id) setPhotoList((prev) => [{ id, kind, url }, ...prev])
    if (kind === 'video') { setBgPhoto(''); setBgVideo(url) } else { setBgVideo(''); setBgPhoto(url) }
    setBgState('photo')
    splitEnv?.console?.setBg?.('photo')
  }
  /** 删除一条媒体：当前使用的那条被删 → 切到最新一条；删光 → 回到流光背景 */
  const removePhotoById = async (p: { id: string; kind: 'photo' | 'video'; url: string }) => {
    try { await splitEnv?.console?.removePhoto?.(p.id) } catch {}
    releasePhotoUrl(p.url)
    const nextList = photoList.filter((x) => x.id !== p.id)
    setPhotoList(nextList)
    if (photoId === p.id) {
      const next = nextList[0] ?? null
      if (next) {
        setPhotoIdLocal(next.id)
        splitEnv?.console?.setPhotoId?.(next.id)
        photoUrlRef.current = next.url
        setBgVideo(next.kind === 'video' ? next.url : '')
        setBgPhoto(next.kind === 'video' ? '' : next.url)
        setBgState('photo')
        splitEnv?.console?.setBg?.('photo')
      } else {
        setPhotoIdLocal('')
        photoUrlRef.current = ''
        setBgPhoto('')
        setBgVideo('')
        setBgState('glow')
        splitEnv?.console?.setBg?.('glow')
      }
    }
  }
  const togglePhotoGrid = () => {
    const next = !photoGrid
    setPhotoGridState(next)
    splitEnv?.console?.setPhotoGrid?.(next)
  }
  const onGridOpacity = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 30)
    setGridOpacityState(v)
    splitEnv?.console?.setGridOpacity?.(v)
  }
  const onCardBlur = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 20)
    setCardBlurState(v)
    splitEnv?.console?.setCardBlur?.(v)
  }
  const onModeBlur = (kind: 'plain' | 'glow' | 'photo', n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 20)
    if (kind === 'plain') { setPlainBlurState(v); splitEnv?.console?.setPlainBlur?.(v) }
    else if (kind === 'glow') { setGlowBlurState(v); splitEnv?.console?.setGlowBlur?.(v) }
    else { setCardBlurState(v); splitEnv?.console?.setCardBlur?.(v) }
  }
  const onModeGrid = (kind: 'plain' | 'glow', n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 30)
    if (kind === 'plain') { setPlainGridState(v); splitEnv?.console?.setPlainGrid?.(v) }
    else { setGlowGridState(v); splitEnv?.console?.setGlowGrid?.(v) }
  }
  const onGlowSpeed = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 100)
    setGlowSpeedState(v)
    splitEnv?.console?.setGlowSpeed?.(v)
  }
  const runUpdateCheck = async (force: boolean) => {
    if (updBusyRef.current) return
    updBusyRef.current = true
    setUpdStatus('checking')
    try {
      const r = await checkUpdate(force)
      setUpdStatus(r.status)
      setUpdInfo(r.info)
    } finally {
      updBusyRef.current = false
    }
  }
  const [updCopied, setUpdCopied] = useState(false)
  const onCopyUpgrade = async () => {
    const ok = await copyTextSafe(UPGRADE_AI)
    if (ok) { setUpdCopied(true); window.setTimeout(() => setUpdCopied(false), 2200) }
  }
  const onSkipVersion = () => {
    if (updInfo) { setSkipVersion(updInfo.latest); setUpdInfo(null); setUpdStatus('uptodate') }
  }
  const onAutoCheckToggle = () => {
    const next = !autoCheckOn
    setAutoCheckOn(next)
    storeAutoCheck(next)
    if (next) void runUpdateCheck(false)
  }
  /** 抓手拖拽排序：按住抓手上下移动 → 行实时重排，松手持久化 */
  const dragRowRef = useRef<string | null>(null)
  const dragFlipRef = useRef<Map<string, { x: number; y: number }> | null>(null)
  const lastTargetRef = useRef<number>(-1)
  const [dragRowId, setDragRowId] = useState<string | null>(null)
  // FLIP：落位提交后，其他行从旧位置平滑让位（260ms 缓出）
  useLayoutEffect(() => {
    const first = dragFlipRef.current
    if (!first) return
    dragFlipRef.current = null
    document.querySelectorAll<HTMLElement>('.dsh-wt_photoRow').forEach((el) => {
      const key = el.dataset.rid ?? ''
      const f = first.get(key)
      if (!f) return
      const r = el.getBoundingClientRect()
      const dx = f.x - r.left
      const dy = f.y - r.top
      if (dx || dy) el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.25,.6,.3,1)' })
    })
  }, [photoList])
  const onHandleDown = (id: string, e: { button: number; preventDefault: () => void; stopPropagation: () => void }) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRowRef.current = id
    lastTargetRef.current = photoList.findIndex((x) => x.id === id)
    setDragRowId(id)
    const onMove = (ev: PointerEvent) => {
      if (dragRowRef.current !== id) return
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.dsh-wt_photoRow'))
      if (rows.length === 0) return
      // 槽位制：按固定行高算最近槽位；边界 ±0.12 行高为死区，未决定性越过前不切换
      const first = rows[0].getBoundingClientRect()
      const h = first.height
      const rel = (ev.clientY - first.top) / h
      let t = Math.max(0, Math.min(rows.length - 1, Math.floor(rel + 0.5)))
      const frac = rel - Math.floor(rel)
      if (Math.abs(frac - 0.5) < 0.12) t = lastTargetRef.current
      if (t === lastTargetRef.current) return
      const from = photoList.findIndex((x) => x.id === id)
      if (from < 0) return
      const rects = new Map<string, { x: number; y: number }>()
      rows.forEach((el) => { const k = el.dataset.rid ?? ''; const r = el.getBoundingClientRect(); rects.set(k, { x: r.left, y: r.top }) })
      const next = [...photoList]
      const moved = next.splice(from, 1)[0]
      const to = Math.max(0, Math.min(t, next.length))
      next.splice(to, 0, moved)
      dragFlipRef.current = rects
      setPhotoList(next)
      lastTargetRef.current = t
    }
    const onUp = () => {
      dragRowRef.current = null
      setDragRowId(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const ids = photoList.map((x) => x.id)
      void splitEnv?.console?.reorderPhotos?.(ids).catch(() => {})
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  /** 在媒体库中选中某条 */
  const selectPhoto = (p: { id: string; kind: 'photo' | 'video'; url: string }) => {
    setPhotoIdLocal(p.id)
    splitEnv?.console?.setPhotoId?.(p.id)
    photoUrlRef.current = p.url
    if (p.kind === 'video') { setBgPhoto(''); setBgVideo(p.url) } else { setBgVideo(''); setBgPhoto(p.url) }
    setBgState('photo')
    splitEnv?.console?.setBg?.('photo')
  }
  const onBg = (m: 'plain' | 'glow' | 'photo') => {
    if (m === 'photo') {
      // 直接切换到当前媒体；没有媒体时才进入二级菜单引导上传
      if (photoList.length === 0) { setBgEdit('photo'); return }
      setBgState('photo')
      splitEnv?.console?.setBg?.('photo')
      return
    }
    setBgState(m)
    splitEnv?.console?.setBg?.(m)
  }
  const editHsl = (kind: 'plain' | 'glow' | 'photo', patch: Partial<{ h: number; s: number; l: number }>) => {
    if (kind === 'plain') {
      const next = { ...plainHsl, ...patch }
      setPlainHslState(next)
      splitEnv?.console?.setPlainHsl?.(next)
    } else if (kind === 'glow') {
      const next = { ...glowHsl, ...patch }
      setGlowHslState(next)
      splitEnv?.console?.setGlowHsl?.(next)
    } else {
      const next = { ...photoHsl, ...patch }
      setPhotoHslState(next)
      if (photoId) splitEnv?.console?.setPhotoHsl?.(photoId, next)
    }
  }
  const resetHsl = (kind: 'plain' | 'glow' | 'photo') => {
    // 恢复初始：连同贴片模糊(B)/网格不透明度(T)一起复位（纯色 B=0，流光/自定义 B=8）
    const blurDef = kind === 'plain' ? 0 : 8
    if (kind === 'plain') {
      setPlainBlurState(blurDef); splitEnv?.console?.setPlainBlur?.(blurDef)
      setPlainGridState(5); splitEnv?.console?.setPlainGrid?.(5)
    } else if (kind === 'glow') {
      setGlowBlurState(blurDef); splitEnv?.console?.setGlowBlur?.(blurDef)
      setGlowGridState(8); splitEnv?.console?.setGlowGrid?.(8)
      setGlowSpeedState(50); splitEnv?.console?.setGlowSpeed?.(50)
    } else {
      setCardBlurState(blurDef); splitEnv?.console?.setCardBlur?.(blurDef)
      setGridOpacityState(8); splitEnv?.console?.setGridOpacity?.(8)
    }
    if (kind === 'plain') {
      const def = resolvedTheme === 'light' ? { ...PLAIN_HSL_LIGHT } : { ...PLAIN_HSL_DARK }
      setPlainHslState(def)
      splitEnv?.console?.setPlainHsl?.(def)
    } else if (kind === 'glow') {
      setGlowHslState({ h: 0, s: 100, l: 100 })
      splitEnv?.console?.setGlowHsl?.({ h: 0, s: 100, l: 100 })
    } else {
      setPhotoHslState({ h: 0, s: 100, l: 100 })
      if (photoId) splitEnv?.console?.setPhotoHsl?.(photoId, { h: 0, s: 100, l: 100 })
      // 照片网格线开关一并复位为默认「开」
      setPhotoGridState(true); splitEnv?.console?.setPhotoGrid?.(true)
    }
  }
  useLayoutEffect(() => {
    const first = firstRectsRef.current
    if (!first) return
    const grid = gridRef.current
    if (!grid) return
    grid.querySelectorAll('.dsh-wt_consoleCard').forEach((el) => {
      const key = (el as HTMLElement).dataset.flip ?? ''
      const f = first.get(key)
      if (!f) return
      const r = el.getBoundingClientRect()
      const dx = f.x - r.left
      const dy = f.y - r.top
      if (dx || dy) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.22,.61,.36,1)' })
      }
    })
    firstRectsRef.current = null
  }, [cols])
  const [themeMode, setThemeMode] = useState<'dark' | 'light' | 'system'>(() => splitEnv?.console?.getTheme?.() ?? 'system')
  const [sysDark, setSysDark] = useState(() => {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return true }
  })
  useEffect(() => {
    const env = splitEnv?.console
    if (!env) return
    // 流式会话可能在一个事件循环里连续推多次；按动画帧合并，只重绘最新状态。
    // 数据读取仍由 getCards 在渲染时完成，不丢弃状态，也不改变卡片刷新语义。
    let frame: number | null = null
    const flush = () => {
      frame = null
      setCardsRevision((v) => v + 1)
    }
    const bump = () => {
      setThemeMode(env.getTheme?.() ?? 'system')
      if (frame != null) return
      frame = window.requestAnimationFrame(flush)
    }
    const un = env.subscribe(bump)
    bump()
    return () => {
      un()
      if (frame != null) window.cancelAnimationFrame(frame)
    }
  }, [])
  // 跟随系统：监听 OS 深浅切换（仅 themeMode==='system' 时影响渲染）
  useEffect(() => {
    let mq: MediaQueryList | null = null
    try { mq = window.matchMedia('(prefers-color-scheme: dark)') } catch {}
    if (!mq) return
    const f = (e: any) => setSysDark(!!e?.matches)
    try { mq.addEventListener('change', f) } catch { try { (mq as any).addListener(f) } catch {} }
    return () => { try { mq.removeEventListener('change', f) } catch { try { (mq as any).removeListener(f) } catch {} } }
  }, [])
  // 打开控制室 = 预热所有绑定会话的最近消息（冷会话走宿主 history 只读通道）
  useEffect(() => {
    splitEnv?.console?.refreshPreviews?.()
  }, [])
  // 自动检查更新（节流一天；手动按钮始终 force）
  useEffect(() => { if (getAutoCheck()) void runUpdateCheck(false) }, [])
  // 背景照片库：IndexedDB 异步加载记录 → 对象 URL；无记录则空
  useEffect(() => {
    let alive = true
    splitEnv?.console?.getPhotoLib?.().then((lib) => {
      // 异步返回时面板已关闭：这一批 URL 从未被使用，也要立即释放。
      if (!alive) { for (const item of lib.list) { try { URL.revokeObjectURL(item.url) } catch {} } return }
      for (const item of lib.list) trackPhotoUrl(item.url)
      setPhotoList(lib.list)
      const active = lib.list.find((p) => p.id === lib.activeId) ?? lib.list[0] ?? null
      if (active) {
        setPhotoIdLocal(active.id)
        photoUrlRef.current = active.url
        setBgVideo(active.kind === 'video' ? active.url : '')
        setBgPhoto(active.kind === 'video' ? '' : active.url)
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  // 当前照片切换 → 载入该照片记住的 HSL 调节值
  useEffect(() => {
    if (!photoId) return
    setPhotoHslState(splitEnv?.console?.getPhotoHsl?.(photoId) ?? { h: 0, s: 100, l: 100 })
  }, [photoId])
  // 面板卸载时释放本次媒体库创建的全部对象 URL（不只当前背景那一张）。
  useEffect(() => () => releaseAllPhotoUrls(), [])
  const env = splitEnv?.console
  // 输入重命名、拖动排序、调节背景等本地 UI 更新不重扫会话事件；
  // 只有控制台数据通知（cardsRevision）才重新组装卡片。
  const cards = useMemo(() => env ? env.getCards() : [], [env, cardsRevision])
  /** 网格实际渲染的卡片：开启「只看进行中」时只留绿/黄/红，其余照常。 */
  const shownCards = useMemo(() => filterWorkingCards(cards, onlyWorking), [cards, onlyWorking])
  const resolvedTheme: 'dark' | 'light' = (() => {
    if (themeMode !== 'system') return themeMode
    try {
      const cs = getComputedStyle(document.documentElement).colorScheme || ''
      if (cs.includes('dark') && !cs.includes('light')) return 'dark'
      if (cs.includes('light') && !cs.includes('dark')) return 'light'
    } catch {}
    return sysDark ? 'dark' : 'light'
  })()
  const setTheme = (th: 'dark' | 'light' | 'system') => { setThemeMode(th); env?.setTheme?.(th) }
  // 主题联动：切换主题时，若纯色还是另一主题的默认值 → 自动跟随新主题默认；自定义过则保持
  const prevPlainThemeRef = useRef<'dark' | 'light' | null>(null)
  useEffect(() => {
    const prev = prevPlainThemeRef.current
    prevPlainThemeRef.current = resolvedTheme
    if (!prev || prev === resolvedTheme) return
    const isDarkDef = plainHsl.h === PLAIN_HSL_DARK.h && plainHsl.s === PLAIN_HSL_DARK.s && plainHsl.l === PLAIN_HSL_DARK.l
    const isLightDef = plainHsl.h === PLAIN_HSL_LIGHT.h && plainHsl.s === PLAIN_HSL_LIGHT.s && plainHsl.l === PLAIN_HSL_LIGHT.l
    const next = resolvedTheme === 'light' && isDarkDef ? { ...PLAIN_HSL_LIGHT }
      : resolvedTheme === 'dark' && isLightDef ? { ...PLAIN_HSL_DARK } : null
    if (next) {
      setPlainHslState(next)
      splitEnv?.console?.setPlainHsl?.(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme])
  /** 打开卡片「会话列表」浮层：取该项目目录下的全部会话（含模板各步骤子目录与已归档项），定位到按钮正下方 */
  const openSessionList = (anchor: HTMLElement, c: ConsoleCardData) => {
    const items = splitEnv?.console?.getProjectSessions?.(c.id) ?? []
    const r = anchor.getBoundingClientRect()
    const w = 360
    const x = Math.max(8, Math.min(Math.round(r.left), Math.max(8, window.innerWidth - w - 8)))
    const y = Math.min(Math.round(r.bottom + 6), Math.max(8, window.innerHeight - 140))
    setSessPop({ name: c.name, x, y, items, transient: c.temp === true })
    setSessShowArchived(false)
    setEditingId(null)
  }
  /** 临时卡片「收工」：只移除已结束的会话（运行中的继续留着），会话本身不删除 */
  const dismissTransientFinished = () => {
    if (!sessPop?.transient) return
    const pop = sessPop
    const ids = pop.items.filter((i) => i.finished).map((i) => i.id)
    if (ids.length === 0) return
    splitEnv?.console?.onDismissTransient?.(ids)
    const rest = pop.items.filter((i) => !i.finished)
    if (rest.length === 0) setSessPop(null)
    else setSessPop({ ...pop, items: rest })
  }
  /** 行内重命名：进入编辑（草稿=现标题，全选） */
  const startSessRename = (e: ReactMouseEvent, s: ProjectSessionItem) => {
    e.stopPropagation()
    setEditingId(s.id)
    setEditDraft(s.title)
  }
  /** 提交重命名：Enter/失焦提交（空白或与原标题相同则放弃），Esc 取消 */
  const commitSessRename = (s: ProjectSessionItem) => {
    if (editingId !== s.id) return
    setEditingId(null)
    const title = editDraft.trim()
    if (!title || title === s.title) return
    setSessPop((prev) => prev ? { ...prev, items: prev.items.map((i) => i.id === s.id ? { ...i, title } : i) } : prev)
    splitEnv?.console?.onRenameSession?.(s.id, title)
  }
  /** 分叉：宿主在同目录建子会话（标题自动 +1），成功后关掉浮层并切到子会话 */
  const onSessForkClick = (e: ReactMouseEvent, s: ProjectSessionItem) => {
    e.stopPropagation()
    setSessPop(null)
    setEditingId(null)
    const openChild = (child: string | null) => { if (child) splitEnv?.console?.onOpenSession?.(child) }
    try {
      const r = splitEnv?.console?.onForkSession?.(s.id)
      if (r && typeof (r as Promise<string | null>).then === 'function') (r as Promise<string | null>).then(openChild, () => {})
      else openChild(typeof r === 'string' ? r : null)
    } catch {}
  }
  /** 置顶 / 取消置顶：先就地更新浮层行，再交给宿主工作区（失败由宿主回推） */
  const toggleSessPin = (e: ReactMouseEvent, s: ProjectSessionItem) => {
    e.stopPropagation()
    setSessPop((prev) => prev ? {
      ...prev,
      items: sortSessionsByActivity(prev.items.map((i) => i.id === s.id ? { ...i, pinned: !i.pinned } : i)),
    } : prev)
    splitEnv?.console?.onPinSession?.(s.id, !s.pinned)
  }
  /** 归档 / 恢复：归档 = 从列表移除（磁盘日志保留）；运行中的会话不允许归档 */
  const toggleSessArchive = (e: ReactMouseEvent, s: ProjectSessionItem) => {
    e.stopPropagation()
    if (!s.archived && s.running) return
    setSessPop((prev) => prev ? {
      ...prev,
      items: prev.items.map((i) => i.id === s.id ? { ...i, archived: !i.archived } : i),
    } : prev)
    splitEnv?.console?.onArchiveSession?.(s.id, !s.archived)
  }
  // 会话列表浮层：Esc 关闭（行内编辑中则由输入框自行处理取消，不关掉浮层）
  useEffect(() => {
    if (!sessPop) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && editingId == null) { setSessPop(null) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sessPop, editingId])
  const statusLabel: Record<string, string> = { idle: T('console.idle'), busy: T('console.busy'), need: T('console.need'), done: T('console.done'), error: T('console.error') }
  // select 的显示值：始终给一个具体模型（与提交时的回退顺序一致），不再出现「默认」空项
  const newSessFrontShown = newSessFor
    ? (newSessFront ?? pickNewSessModel(newSessModels, frontPreferences(newSessMode), newSessCatalogDefaultRef.current))
    : null
  const newSessBgShown = newSessFor
    ? (newSessBg ?? pickNewSessModel(newSessModels, [readBgPref()], newSessCatalogDefaultRef.current))
    : null
  const themeOpts: { mode: 'dark' | 'light' | 'system'; key: string }[] = [
    { mode: 'dark', key: 'console.themeDark' },
    { mode: 'light', key: 'console.themeLight' },
    { mode: 'system', key: 'console.themeSystem' },
  ]
  return (
    <div className="dsh-wt_console" data-wt-theme={resolvedTheme} data-wt-shape={shape} data-wt-bg={bg} data-wt-grid={bg === 'photo' && !photoGrid ? 'off' : 'on'} style={{ ...(bg === 'plain' ? { ['--wt-bg' as any]: 'hsl(' + plainHsl.h + ', ' + plainHsl.s + '%, ' + plainHsl.l + '%)', ['--wt-gridPlain' as any]: 'rgba(255,255,255,' + (plainGrid / 100) + ')', ['--wt-gridPlainLight' as any]: 'rgba(27,31,36,' + (plainGrid / 100) + ')' } : {}), ...(bg === 'glow' ? { ['--wt-gridGlow' as any]: 'rgba(255,255,255,' + (glowGrid / 100) + ')', ['--wt-gridGlowLight' as any]: 'rgba(27,31,36,' + (glowGrid / 100) + ')', ['--wt-glowScale' as any]: glowSpeed === 0 ? '100000000' : String(50 / glowSpeed) } : {}), ...(bg === 'photo' ? { ['--wt-gridPhoto' as any]: 'rgba(255,255,255,' + (gridOpacity / 100) + ')' } : {}), ['--wt-cardBlur' as any]: (bg === 'plain' ? plainBlur : bg === 'glow' ? glowBlur : cardBlur) + 'px' }}>
      <span className="dsh-wt_consoleBg" aria-hidden style={bg === 'glow' && (glowHsl.h !== 0 || glowHsl.s !== 100 || glowHsl.l !== 100) ? { filter: 'hue-rotate(' + glowHsl.h + 'deg) saturate(' + glowHsl.s + '%) brightness(' + glowHsl.l + '%)' } : undefined}>
        {bg === 'photo' && (bgVideo
          ? <ConsoleVideo src={bgVideo} style={photoHsl.h !== 0 || photoHsl.s !== 100 || photoHsl.l !== 100 ? { filter: 'hue-rotate(' + photoHsl.h + 'deg) saturate(' + photoHsl.s + '%) brightness(' + photoHsl.l + '%)' } : undefined} />
          : bgPhoto ? <img className="dsh-wt_consoleMedia" src={bgPhoto} alt="" style={photoHsl.h !== 0 || photoHsl.s !== 100 || photoHsl.l !== 100 ? { filter: 'hue-rotate(' + photoHsl.h + 'deg) saturate(' + photoHsl.s + '%) brightness(' + photoHsl.l + '%)' } : undefined} /> : null)}
        {bg === 'glow' && (<><i className="dsh-wt_blob dsh-wt_blob1" /><i className="dsh-wt_blob dsh-wt_blob2" /><i className="dsh-wt_blob dsh-wt_blob3" /><i className="dsh-wt_blob dsh-wt_blob4" /></>)}</span>
      {openMenu !== null && <div className="dsh-wt_dropMask" onClick={() => setOpenMenu(null)} />}
      <div className="dsh-wt_consoleScroll">
        <TemplateBar />
        {annOpen ? (
          <div className="dsh-wt_announceCtr">
          <div className="dsh-wt_announce">
            <div className="dsh-wt_announceHead">
              <span className="dsh-wt_announceVer">{T('annot.curVer')} v{LOCAL_VERSION}</span>
              <button type="button" className="dsh-wt_announceBtn" disabled={updStatus === 'checking'} onClick={() => runUpdateCheck(true)}>{updStatus === 'checking' ? T('annot.checking') : T('annot.checkNow')}</button>
              <span className="dsh-wt_announceAuto">{T('annot.autoCheck')}</span>
              <button type="button" className={'dsh-wt_switch' + (autoCheckOn ? ' dsh-wt_switchOn' : '')} aria-pressed={autoCheckOn} aria-label={T('annot.autoCheck')} onClick={onAutoCheckToggle}><span className="dsh-wt_switchKnob" /></button>
            </div>
            {updInfo && (
              <div className="dsh-wt_announceUpdate">
                <span className="dsh-wt_announceNewVer">{T('annot.newVer')} v{updInfo.latest}</span>
                <button type="button" className={'dsh-wt_announceUpg' + (updCopied ? ' dsh-wt_announceUpgOk' : '')} onClick={onCopyUpgrade}>{updCopied ? T('annot.copied') : T('annot.copyUpgrade')}</button>
                <button type="button" className="dsh-wt_announceSkip dsh-wt_announceSkipGo" onClick={() => { try { window.open(updInfo.url, '_blank') } catch {} }}>{T('annot.gotoRelease')}</button>
                <button type="button" className="dsh-wt_announceSkip" onClick={onSkipVersion}>{T('annot.skipVer')}</button>
                <div className="dsh-wt_announceHow">{T('annot.howUpdate')}</div>
              </div>
            )}
            {updStatus === 'failed' && <div className="dsh-wt_announceStatus">{T('annot.checkFail')}</div>}
            {updStatus === 'uptodate' && !updInfo && <div className="dsh-wt_announceStatus">{T('annot.latest')}</div>}
            {ANNOUNCE_BODY
              ? <div className="dsh-wt_announceBody">{`${ANNOUNCE_HEAD}\n${ANNOUNCE_BODY}`}</div>
              : <div className="dsh-wt_announceBody">{`更新公告 · v${LOCAL_VERSION}\n（本包没有随版本发布的公告正文；见 GitHub Releases 页面。）`}</div>}
          </div>
          </div>
        ) : (
        <div ref={gridRef} className="dsh-wt_consoleGrid" style={{ ['--wt-cols' as any]: effectiveCols, ...(cols === 0 ? { maxWidth: '100%' } : {}) }}>
        {shownCards.map((c) => (
          <div
            key={c.id}
            data-flip={c.id}
            role={c.self ? undefined : 'button'}
            tabIndex={c.self ? -1 : 0}
            className={'dsh-wt_consoleCard' + (c.self ? ' dsh-wt_consoleCardSelf' : '')
              + (c.temp ? ' dsh-wt_consoleCard-temp' : '')
              + (c.status === 'busy' ? ' dsh-wt_consoleCard-busy' : '')
              + (c.status === 'error' ? ' dsh-wt_consoleCard-error' : '')
              + (c.glow && c.status === 'done' ? ' dsh-wt_consoleCard-glowDone' : '')
              + (c.glow && c.status === 'need' ? ' dsh-wt_consoleCard-glowNeed' : '')}
            title={c.temp ? T('console.tempCardTip') + ' · ' + c.name : c.name}
            onClick={() => {
              if (c.self || !env) return
              if (c.glow) env.onAck?.(c.id) // 点发光卡片：先确认熄光，再进入
              env.onOpen(c.id)
            }}
          >
            <div className="dsh-wt_consoleCardHead">
              {/* 图标只是标识，不再是按钮：换图标统一走「控制室下方工具条 → 项目管理 → 更换图标」 */}
              <span className="dsh-wt_consoleIcon" aria-hidden>{c.icon}</span>
              <span className="dsh-wt_consoleName">{c.name}</span>
              {c.count != null && c.count > 0 && (
                <span className="dsh-wt_consoleCount" title={T('console.tempCountTip', { n: String(c.count) })}>{c.count}</span>
              )}
            </div>
            <div className="dsh-wt_consoleDivider" aria-hidden />
            <div className="dsh-wt_consoleStatusRow">
              <span className={'dsh-wt_consoleStatus dsh-wt_consoleStatus-' + c.status}>{statusLabel[c.status]}</span>
              {c.runtimeMs != null && <ConsoleRuntime value={c.runtimeMs} />}
            </div>
            {(c.status === 'busy' || c.status === 'error' || (c.glow && c.status === 'need')) && <span className="dsh-wt_consoleSweep" aria-hidden />}
            <div className={'dsh-wt_consolePreview' + (c.preview ? '' : ' dsh-wt_consolePreviewNone') + (c.live ? ' dsh-wt_consolePreviewLive' : '')} title={c.preview}>
              {c.preview || (c.bound ? T('console.noPreview') : T('console.unboundShort'))}
              {c.live && c.preview ? <span className="dsh-wt_consoleCaret" aria-hidden>▍</span> : null}
            </div>
            {/* 卡片底部操作行：两个醒目的一键新建（对话 / 电脑操作），下面「会话列表」 */}
            <div className="dsh-wt_consoleCardOps">
              {c.canNewSession && (
                <>
                  <button
                    type="button"
                    className="dsh-wt_consoleOpBtn dsh-wt_consoleOpBtnNew"
                    title={T('console.newStandardTip')}
                    aria-label={T('console.newStandard')}
                    onClick={(e) => { e.stopPropagation(); if (splitEnv?.console?.onCreateSession) openNewSessionPanel(c, 'standard'); else env?.onNewSession?.(c.id) }}
                  >
                    <span className="dsh-wt_consoleOpMain">
                      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                        <circle cx="8" cy="8" r="7" fill="currentColor" opacity=".16" />
                        <path d="M8 4.5v7M4.5 8h7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                      </svg>
                      <span>{T('console.newShort')}</span>
                    </span>
                    <span className="dsh-wt_consoleOpSub">{T('console.newStandardShort')}</span>
                  </button>
                  <button
                    type="button"
                    className="dsh-wt_consoleOpBtn dsh-wt_consoleOpBtnNew dsh-wt_consoleOpBtnCu"
                    title={T('console.newComputerUseTip')}
                    aria-label={T('console.newComputerUse')}
                    onClick={(e) => { e.stopPropagation(); if (splitEnv?.console?.onCreateSession) openNewSessionPanel(c, 'computer-use'); else env?.onNewSession?.(c.id) }}
                  >
                    <span className="dsh-wt_consoleOpMain">
                      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                        <circle cx="8" cy="8" r="7" fill="currentColor" opacity=".16" />
                        <path d="M8 4.5v7M4.5 8h7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                      </svg>
                      <span>{T('console.newShort')}</span>
                    </span>
                    <span className="dsh-wt_consoleOpSub">{T('console.newComputerUseShort')}</span>
                  </button>
                </>
              )}
              <button
                type="button"
                className="dsh-wt_consoleOpBtn dsh-wt_consoleOpBtnFull"
                title={T('console.sessionsTip')}
                aria-label={T('console.sessions')}
                onClick={(e) => { e.stopPropagation(); openSessionList(e.currentTarget as HTMLElement, c) }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                  <path d="M5.6 4.3h7.1M5.6 8h7.1M5.6 11.7h7.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <circle cx="3.1" cy="4.3" r="0.95" fill="currentColor" />
                  <circle cx="3.1" cy="8" r="0.95" fill="currentColor" />
                  <circle cx="3.1" cy="11.7" r="0.95" fill="currentColor" />
                </svg>
                <span>{T('console.sessions')}</span>
              </button>
            </div>
          </div>
        ))}
        {/* 创建卡片：永远最后一位；点击 = 侧栏工作台「添加项目」同款流程 */}
        <div
          role="button"
          tabIndex={0}
          className="dsh-wt_consoleCard dsh-wt_consoleAdd"
          title={T('console.addProject')}
          onClick={() => env?.onAdd?.()}
        >
          <span className="dsh-wt_consoleAddPlus" aria-hidden>＋</span>
          <span className="dsh-wt_consoleAddLabel">{T('console.addProject')}</span>
        </div>
        {shownCards.length === 0 && (
          <div className="dsh-wt_consoleEmpty">
            {onlyWorking && cards.length > 0 ? T('console.onlyWorkingEmpty') : T('console.empty')}
          </div>
        )}
        </div>
        )}

      {/* 卡片「会话列表」浮层：点某一项即进入该会话（历史保留，可继续对话）；行内可置顶/重命名/分叉/归档 */}
      {sessPop && (
        <>
          <div className="dsh-wt_sessMask" onClick={() => { setSessPop(null); setEditingId(null) }} />
          <div className="dsh-wt_sessPop" style={{ left: sessPop.x, top: sessPop.y }} role="dialog" aria-label={sessPop.transient ? T('console.transientTitle') : T('console.sessionsTitle')}>
            <div className="dsh-wt_sessHead">
              <span className="dsh-wt_sessTitle">{sessPop.transient ? T('console.transientTitle') : T('console.sessionsTitle')}</span>
              <span className="dsh-wt_sessProj" title={sessPop.name}>{sessPop.name}</span>
              {sessPop.transient && sessPop.items.some((i) => i.finished) && (
                <button type="button" className="dsh-wt_sessDone" onClick={dismissTransientFinished} title={T('console.dismissFinishedTip')}>
                  {T('console.dismissFinished')}
                </button>
              )}
              <span className="dsh-wt_sessCount">{sessPop.items.filter((i) => sessShowArchived || !i.archived).length}</span>
            </div>
            {sessPop.items.filter((i) => sessShowArchived || !i.archived).length === 0 ? (
              <div className="dsh-wt_sessEmpty">{sessPop.transient ? T('console.transientEmpty') : T('console.sessionsEmpty')}</div>
            ) : (
              <div className="dsh-wt_sessList">
                {sessPop.items.filter((i) => sessShowArchived || !i.archived).map((s) => (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    className={'dsh-wt_sessItem' + (s.current ? ' dsh-wt_sessItemCur' : '') + (s.archived ? ' dsh-wt_sessItemArchived' : '')}
                    title={s.title}
                    data-editing={editingId === s.id || undefined}
                    onClick={() => {
                      // 只打开会话；不移出卡片——结束后一直保留到手动「收工」
                      setSessPop(null)
                      splitEnv?.console?.onOpenSession?.(s.id)
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && editingId == null) {
                        e.preventDefault()
                        setSessPop(null)
                        splitEnv?.console?.onOpenSession?.(s.id)
                      }
                    }}
                  >
                    {s.pinned && (
                      <span className="dsh-wt_sessPin" title={T('console.pin')} aria-hidden>
                        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden><path d="M9.7 1.6 14.4 6.3l-1.6 1.6-1-.4-2.8 2.8.3 2.2-1.2 1.2-3-3L1.7 14l-.6-.6 3.3-3.4-3-3 1.2-1.2 2.2.3L7.6 3.3l-.4-1z" fill="currentColor" /></svg>
                      </span>
                    )}
                    <span className={'dsh-wt_sessDot' + (s.awaiting ? ' dsh-wt_sessDotNeed' : (s.running ? ' dsh-wt_sessDotRun' : ''))} aria-hidden />
                    {editingId === s.id ? (
                      <input
                        className="dsh-wt_sessRenameInput"
                        value={editDraft}
                        placeholder={T('console.sessionRenamePh')}
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitSessRename(s) }
                          else if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null) }
                        }}
                        onBlur={() => commitSessRename(s)}
                      />
                    ) : (
                      <span className="dsh-wt_sessName">{s.title || T('console.untitled')}</span>
                    )}
                    {s.archived && <span className="dsh-wt_sessTag">{T('console.archivedTag')}</span>}
                    {s.awaiting && !s.archived && !s.running && <span className="dsh-wt_sessTag">{T('console.needTag')}</span>}
                    {s.finished && !s.archived && <span className="dsh-wt_sessTag dsh-wt_sessFinishedTag">{T('console.finishedTag')}</span>}
                    {!s.archived && <span className="dsh-wt_sessRel">{s.rel || T('console.sessionRoot')}</span>}
                    {editingId == null && (
                      <span className="dsh-wt_sessOps" onClick={(e) => e.stopPropagation()}>
                        {!s.archived && (
                          <button
                            type="button"
                            className={'dsh-wt_sessOp' + (s.pinned ? ' dsh-wt_sessOpOn' : '')}
                            title={s.pinned ? T('console.unpin') : T('console.pin')}
                            aria-label={s.pinned ? T('console.unpin') : T('console.pin')}
                            onClick={(e) => toggleSessPin(e, s)}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M9.7 1.6 14.4 6.3l-1.6 1.6-1-.4-2.8 2.8.3 2.2-1.2 1.2-3-3L1.7 14l-.6-.6 3.3-3.4-3-3 1.2-1.2 2.2.3L7.6 3.3l-.4-1z" fill={s.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /></svg>
                          </button>
                        )}
                        {!s.archived && (
                          <button
                            type="button"
                            className="dsh-wt_sessOp"
                            title={T('console.sessionRenameTip')}
                            aria-label={T('console.sessionRename')}
                            onClick={(e) => startSessRename(e, s)}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                              <path d="M9.9 3.6l2.5 2.5M3.4 13.1l.8-2.7L10.6 4a1.75 1.75 0 0 1 2.5 2.5L6.7 12.9l-2.7.8z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        )}
                        {!s.archived && (
                          <button
                            type="button"
                            className="dsh-wt_sessOp"
                            title={T('console.sessionForkTip')}
                            aria-label={T('console.sessionFork')}
                            onClick={(e) => onSessForkClick(e, s)}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                              <circle cx="4" cy="8" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
                              <circle cx="12" cy="3.6" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
                              <circle cx="12" cy="12.4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
                              <path d="M5.5 7.2C7.1 5.8 8.4 5 10.3 4.3M5.5 8.8C7.1 10.2 8.4 11 10.3 11.7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                            </svg>
                          </button>
                        )}
                        <button
                          type="button"
                          className={'dsh-wt_sessOp dsh-wt_sessArchive' + (s.archived ? ' dsh-wt_sessOpOn' : '')}
                          title={s.archived ? T('console.unarchiveTip') : (s.running ? T('console.archiveTip') : T('console.archiveTip'))}
                          aria-label={s.archived ? T('console.unarchive') : T('console.archive')}
                          disabled={!s.archived && s.running}
                          onClick={(e) => toggleSessArchive(e, s)}
                        >
                          {s.archived ? (
                            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M2.6 5.9 8 2.2l5.4 3.7M3.9 5.9v6.6h8.2V5.9M8 12.5V6.9M5.9 8.9 8 6.8l2.1 2.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M2.4 3.2h11.2v2.3H2.4zM3.4 5.5v7.3h9.2V5.5M6.3 8.6h3.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          )}
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {sessPop.items.some((i) => i.archived) && (
              <button type="button" className="dsh-wt_sessMore" onClick={() => setSessShowArchived((v) => !v)}>
                {sessShowArchived ? T('console.hideArchived') : T('console.showArchived')} ({sessPop.items.filter((i) => i.archived).length})
              </button>
            )}
            {sessPop.transient && (
              <div className="dsh-wt_sessHint">{T('console.transientHint')}</div>
            )}
          </div>
        </>
      )}
      </div>
      <div className="dsh-wt_consoleDockWrap">
        <div className="dsh-wt_consoleDock">
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'theme' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.themeLabel')} aria-label={T('console.themeLabel')} onClick={() => setOpenMenu(openMenu === 'theme' ? null : 'theme')}><ThemeIcon mode={themeMode} /></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'bg' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.bgLabel')} aria-label={T('console.bgLabel')} onClick={() => { setOpenMenu(openMenu === 'bg' ? null : 'bg'); setBgEdit(null) }}><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="0.9" /><circle cx="5.9" cy="6.7" r="1.05" fill="none" stroke="currentColor" strokeWidth="0.8" /><path d="M3.4 11.4l3-3 2.3 2.3 1.9-1.9 3 2.6" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'cols' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.colsLabel')} aria-label={T('console.colsLabel')} onClick={() => setOpenMenu(openMenu === 'cols' ? null : 'cols')}><svg width="20" height="20" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /><rect x="6.65" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /><rect x="11.1" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg></button>
          {/* 一键隐藏未工作的项目卡片：亮起 = 只看进行中（绿/黄/红），再点一下显示全部 */}
          <button
            type="button"
            className={'dsh-wt_dockBtn' + (onlyWorking ? ' dsh-wt_dockFilterOn' : '')}
            title={onlyWorking ? T('console.onlyWorkingOnTip') : T('console.onlyWorkingOffTip')}
            aria-label={T('console.onlyWorking')}
            aria-pressed={onlyWorking}
            onClick={() => { setOpenMenu(null); setOnlyWorking((v) => !v) }}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
              <path d="M1.6 8Q4.4 3.9 8 3.9T14.4 8Q11.6 12.1 8 12.1T1.6 8Z" fill="currentColor" fillOpacity={onlyWorking ? 0.16 : 0} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <circle cx="8" cy="8" r="2.15" fill="currentColor" fillOpacity={onlyWorking ? 0.9 : 0} stroke="currentColor" strokeWidth="1.2" />
            </svg>
            {onlyWorking && shownCards.length > 0 && <span className="dsh-wt_dockCount" aria-hidden>{shownCards.length}</span>}
          </button>
          <button type="button" className={'dsh-wt_dockBtn' + (manageOpen ? ' dsh-wt_dockBtnOn' : '')} title={T('console.manage')} aria-label={T('console.manage')} onClick={() => { setOpenMenu(null); setManageOpen((v) => !v) }}>
            <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><path d="M3 4.6h10M3 8h10M3 11.4h6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="12.4" cy="11.4" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.1" /></svg>
          </button>
        </div>
        {openMenu === 'theme' && (
          <div className="dsh-wt_drop">
            {themeOpts.map((o) => (
              <button key={o.mode} type="button" className={'dsh-wt_dropItem' + (themeMode === o.mode ? ' dsh-wt_dropItemOn' : '')} onClick={() => setTheme(o.mode)}><ThemeIcon mode={o.mode} size={13} />{T(o.key)}</button>
            ))}
          </div>
        )}
        {openMenu === 'bg' && (
          bgEdit === null ? (
            <div className="dsh-wt_drop">
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'plain' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('plain')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgPlain')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('plain')}><SliderIcon /></button>
              </div>
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'glow' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('glow')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><path d="M2.4 5.6c2-1.5 3.9-1.5 5.6 0 1.9 1.6 3.6 1.6 5.6 0M2.4 10.4c2-1.5 3.9-1.5 5.6 0 1.9 1.6 3.6 1.6 5.6 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>{T('console.bgGlow')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('glow')}><SliderIcon /></button>
              </div>
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'photo' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('photo')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="5.8" cy="6.6" r="1.1" fill="currentColor" /><path d="M3.2 11.2l2.8-2.8 2.2 2.2 1.8-1.8 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgCustom')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('photo')}><SliderIcon /></button>
              </div>
            </div>
          ) : (
            <div className={'dsh-wt_drop' + (bgEdit === 'photo' ? ' dsh-wt_dropWide' : '')}>
              <div className="dsh-wt_hslHead">
                <button type="button" className="dsh-wt_hslBack" title={T('console.bgEditBack')} aria-label={T('console.bgEditBack')} onClick={() => setBgEdit(null)}><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M10.2 3.2 5.4 8l4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                <span className="dsh-wt_hslTitle">{bgEdit === 'plain' ? T('console.bgEditPlain') : bgEdit === 'glow' ? T('console.bgEditGlow') : T('console.bgEditPhoto')}</span>
              </div>
              {bgEdit === 'photo' && (
                <>
                  <div className="dsh-wt_dropRow">
                    <button type="button" className="dsh-wt_dropItem" onClick={pickPhotoFile}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="5.8" cy="6.6" r="1.1" fill="currentColor" /><path d="M3.2 11.2l2.8-2.8 2.2 2.2 1.8-1.8 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgPhoto')}</button>
                    <div className="dsh-wt_gridHalf">
                      <span className="dsh-wt_gridLabel">{T('console.bgGridLabel')}</span>
                      <button type="button" className={'dsh-wt_switch' + (photoGrid ? ' dsh-wt_switchOn' : '')} aria-pressed={photoGrid} aria-label={T('console.bgGridLabel')} onClick={togglePhotoGrid}><span className="dsh-wt_switchKnob" /></button>
                    </div>
                  </div>
                  {photoList.length > 0 ? (
                    photoList.slice(0, 4).map((p) => (
                      <div key={p.id} data-rid={p.id} className={'dsh-wt_dropRow dsh-wt_photoRow' + (photoId === p.id ? ' dsh-wt_photoRowOn' : '')} onClick={() => selectPhoto(p)}>
                        <span className="dsh-wt_thumbWrap">
                          {p.kind === 'video'
                            ? <video className="dsh-wt_photoThumb" src={p.url} muted playsInline preload="metadata" />
                            : <img className="dsh-wt_photoThumb" src={p.url} alt="" />}
                          <span className="dsh-wt_thumbBadge" aria-hidden>{p.kind === 'video'
                            ? <svg width="8" height="8" viewBox="0 0 16 16"><path d="M4.5 3.8l8 4.2-8 4.2z" fill="currentColor" /></svg>
                            : <svg width="8" height="8" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M3.4 11l2.6-2.6 2.1 2.1 1.7-1.7 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}</span>
                        </span>
                        <span className="dsh-wt_photoName">{photoId === p.id ? T('console.bgPhotoCurrent') : T('console.bgPhotoUse')}</span>
                        <button type="button" className={'dsh-wt_dragHandle' + (dragRowId === p.id ? ' dsh-wt_dragHandleOn' : '')} title={T('console.bgMediaDrag')} aria-label={T('console.bgMediaDrag')} onPointerDown={(e) => onHandleDown(p.id, e)}><svg width="10" height="12" viewBox="0 0 10 12" aria-hidden><circle cx="2.5" cy="2" r="1.1" fill="currentColor" /><circle cx="7.5" cy="2" r="1.1" fill="currentColor" /><circle cx="2.5" cy="6" r="1.1" fill="currentColor" /><circle cx="7.5" cy="6" r="1.1" fill="currentColor" /><circle cx="2.5" cy="10" r="1.1" fill="currentColor" /><circle cx="7.5" cy="10" r="1.1" fill="currentColor" /></svg></button>
                        <button type="button" className="dsh-wt_dropTrash" title={T('console.bgPhotoDelete')} aria-label={T('console.bgPhotoDelete')} onClick={(e) => { e.stopPropagation(); removePhotoById(p) }}><svg width="11" height="11" viewBox="0 0 16 16" aria-hidden><path d="M2.5 4.2h11M6.5 4.2V2.9c0-.6.4-1 .9-1h1.2c.5 0 .9.4.9 1v1.3M4.2 4.2l.5 8.1c0 .7.5 1.2 1.2 1.2h4.2c.7 0 1.2-.5 1.2-1.2l.5-8.1" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg></button>
                      </div>
                    ))
                  ) : (
                    <div className="dsh-wt_photoEmpty">{T('console.bgPhotoNone')}</div>
                  )}
                  <div className="dsh-wt_hslDivider" />
                </>
              )}
              {(() => {
                const v = bgEdit === 'plain' ? plainHsl : bgEdit === 'glow' ? glowHsl : photoHsl
                const sMax = bgEdit === 'plain' ? 100 : 200
                const lMax = bgEdit === 'plain' ? 100 : 200
                return (<>
                  {bgEdit === 'glow' && (
                    <div className="dsh-wt_hslRow" data-tip={T('console.bgTipSpeed')}><span className="dsh-wt_hslLabel">S</span><input className="dsh-wt_hslSlider" type="range" min={0} max={100} step={5} value={glowSpeed} onChange={(e) => onGlowSpeed(Number(e.target.value))} /><HslValInput value={glowSpeed} min={0} max={100} onCommit={onGlowSpeed} /></div>
                  )}
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipB')}><span className="dsh-wt_hslLabel">B</span><input className="dsh-wt_hslSlider" type="range" min={0} max={20} step={1} value={bgEdit === 'plain' ? plainBlur : bgEdit === 'glow' ? glowBlur : cardBlur} onChange={(e) => onModeBlur(bgEdit, Number(e.target.value))} /><HslValInput value={bgEdit === 'plain' ? plainBlur : bgEdit === 'glow' ? glowBlur : cardBlur} min={0} max={20} onCommit={(n) => onModeBlur(bgEdit, n)} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipT')}><span className="dsh-wt_hslLabel">T</span><input className="dsh-wt_hslSlider" type="range" min={0} max={30} step={1} value={bgEdit === 'plain' ? plainGrid : bgEdit === 'glow' ? glowGrid : gridOpacity} onChange={(e) => bgEdit === 'photo' ? onGridOpacity(Number(e.target.value)) : onModeGrid(bgEdit, Number(e.target.value))} /><HslValInput value={bgEdit === 'plain' ? plainGrid : bgEdit === 'glow' ? glowGrid : gridOpacity} min={0} max={30} onCommit={(n) => bgEdit === 'photo' ? onGridOpacity(n) : onModeGrid(bgEdit, n)} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipH')}><span className="dsh-wt_hslLabel">H</span><input className="dsh-wt_hslSlider" type="range" min={-180} max={180} step={1} value={v.h} onChange={(e) => editHsl(bgEdit, { h: Number(e.target.value) })} /><HslValInput value={v.h} min={-180} max={180} onCommit={(n) => editHsl(bgEdit, { h: n })} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipS')}><span className="dsh-wt_hslLabel">S</span><input className="dsh-wt_hslSlider" type="range" min={0} max={sMax} step={1} value={v.s} onChange={(e) => editHsl(bgEdit, { s: Number(e.target.value) })} /><HslValInput value={v.s} max={sMax} onCommit={(n) => editHsl(bgEdit, { s: n })} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipL')}><span className="dsh-wt_hslLabel">L</span><input className="dsh-wt_hslSlider" type="range" min={0} max={lMax} step={1} value={v.l} onChange={(e) => editHsl(bgEdit, { l: Number(e.target.value) })} /><HslValInput value={v.l} max={lMax} onCommit={(n) => editHsl(bgEdit, { l: n })} /></div>
                  <button type="button" className="dsh-wt_hslReset" onClick={() => resetHsl(bgEdit)}>{T('console.bgEditReset')}</button>
                </>)
              })()}
            </div>
          )
        )}
        {openMenu === 'cols' && (
          <div className="dsh-wt_drop">
            <button type="button" className={'dsh-wt_dropItem' + (cols === 0 ? ' dsh-wt_dropItemOn' : '')} onClick={() => onCols(0)}>
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="3.4" width="2.4" height="9.2" rx="0.7" fill="none" stroke="currentColor" strokeWidth="0.9" /><rect x="6.8" y="3.4" width="2.4" height="9.2" rx="0.7" fill="none" stroke="currentColor" strokeWidth="0.9" /><rect x="11.4" y="3.4" width="2.4" height="9.2" rx="0.7" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg>
              {T('console.colsAuto')}
            </button>
            {cols > 0 && (
              <div className="dsh-wt_hbar">
                <span className="dsh-wt_hbarFill" style={{ width: (8 + (cols - 1) * 21) + '%' }} />
                {[1, 2, 3, 4, 5].map((v) => (
                  <button key={v} type="button" className="dsh-wt_hbarLine" style={{ left: (8 + (v - 1) * 21) + '%' }} aria-label={String(v)} title={String(v)} onClick={() => onCols(v)}></button>
                ))}
                <span className="dsh-wt_hbarKnob" style={{ left: (8 + (cols - 1) * 21) + '%' }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 项目管理：隐藏 / 恢复 / 删除（只删控制室条目，不删文件夹与会话） */}
      {manageOpen && (
        <div className="dsh-wt_newSessMask" onClick={() => setManageOpen(false)}>
          <div className="dsh-wt_newSess" role="region" aria-label={T('console.manage')} onClick={(e) => e.stopPropagation()}>
            <div className="dsh-wt_newSessHead">
              <span className="dsh-wt_newSessTitle">{T('console.manage')}</span>
              <span className="dsh-wt_newSessProj">{T('console.manageHint')}</span>
            </div>
            <div className="dsh-wt_manageList" ref={manageListRef}>
              {(() => {
                const list = splitEnv?.console?.getManageProjects?.() ?? []
                if (list.length === 0) return <div className="dsh-wt_modelHint">{T('console.manageEmpty')}</div>
                return list.map((p) => (
                  <div
                    key={p.id}
                    data-pid={p.id}
                    className={'dsh-wt_manageRow' + (p.hidden ? ' dsh-wt_manageRowHidden' : '')
                      + (manageDrag && manageDrag.id === p.id ? ' dsh-wt_manageRowDragging' : '')
                      + (manageDrag && manageDrag.id !== p.id && manageDrag.targetId === p.id
                        ? (manageDrag.before ? ' dsh-wt_manageRowDropBefore' : ' dsh-wt_manageRowDropAfter')
                        : '')}
                  >
                    <span
                      className="dsh-wt_manageGrip"
                      title={T('console.dragSort')}
                      aria-label={T('console.dragSort')}
                      role="button"
                      tabIndex={0}
                      onPointerDown={(e) => beginManageDrag(e, p.id)}
                      onPointerMove={moveManageDrag}
                      onPointerUp={endManageDrag}
                      onPointerCancel={endManageDrag}
                    >⋮⋮</span>
                    <span className="dsh-wt_manageIcon" aria-hidden>{p.icon}</span>
                    {renameId === p.id ? (
                      <input
                        ref={renameInputRef}
                        className="dsh-wt_manageInput"
                        defaultValue={p.name}
                        placeholder={T('console.renamePh')}
                        aria-label={T('console.rename')}
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onBlur={endRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                          else if (e.key === 'Escape') { e.preventDefault(); renameCancelRef.current = true; e.currentTarget.blur() }
                        }}
                      />
                    ) : (
                      <span
                        className="dsh-wt_manageName"
                        title={T('console.renameTip')}
                        onDoubleClick={() => beginRename(p.id)}
                      >{p.name}</span>
                    )}
                    {p.hidden && <span className="dsh-wt_sessTag">{T('console.hiddenTag')}</span>}
                    <div className="dsh-wt_manageOps">
                      <button
                        type="button"
                        className="dsh-wt_manageBtn dsh-wt_manageIconPick"
                        title={T('console.changeIcon')}
                        aria-label={T('console.changeIcon')}
                        onClick={(e) => {
                          e.stopPropagation()
                          splitEnv?.console?.onPickIcon?.(p.id, e.currentTarget as HTMLElement, { below: true })
                        }}
                      >🎨 {T('console.changeIconShort')}</button>
                      <button
                        type="button"
                        className="dsh-wt_manageBtn"
                        title={T('console.renameTip')}
                        aria-label={T('console.rename')}
                        onClick={() => beginRename(p.id)}
                      >{T('console.rename')}</button>
                      <button type="button" className="dsh-wt_manageBtn" onClick={() => splitEnv?.console?.onHideProject?.(p.id, !p.hidden)}>
                        {p.hidden ? T('console.show') : T('console.hide')}
                      </button>
                      <button type="button" className="dsh-wt_manageBtn dsh-wt_manageDel" onClick={() => splitEnv?.console?.onDeleteProject?.(p.id)}>
                        {T('console.deleteProject')}
                      </button>
                    </div>
                  </div>
                ))
              })()}
            </div>
            <div className="dsh-wt_newSessOps">
              <button type="button" className="dsh-wt_btnPrimary" onClick={() => setManageOpen(false)}>{T('console.manageClose')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 新建会话面板：普通对话 / 电脑操作（后者可选前台与后台模型） */}
      {newSessFor && (
        <div className="dsh-wt_newSessMask" onClick={() => setNewSessFor(null)}>
          <div className="dsh-wt_newSess" role="region" aria-label={T('console.newSessionTitle')} onClick={(e) => e.stopPropagation()}>
            <div className="dsh-wt_newSessHead">
              <span className="dsh-wt_newSessTitle">{T('console.newSessionTitle')}</span>
              <span className="dsh-wt_newSessProj" title={newSessFor.name}>{newSessFor.name}</span>
            </div>
            <div className="dsh-wt_modeRow">
              <button type="button" className={'dsh-wt_modeBtn' + (newSessMode === 'standard' ? ' dsh-wt_modeBtnOn' : '')} onClick={() => {
                setNewSessMode('standard')
                setNewSessFront(pickNewSessModel(newSessModelsRef.current, frontPreferences('standard'), newSessCatalogDefaultRef.current))
              }}>{T('console.modeStandard')}</button>
              <button type="button" className={'dsh-wt_modeBtn' + (newSessMode === 'computer-use' ? ' dsh-wt_modeBtnOn' : '')} onClick={() => {
                setNewSessMode('computer-use')
                newSessBgTouchedRef.current = false
                setNewSessFront(pickNewSessModel(newSessModelsRef.current, frontPreferences('computer-use'), newSessCatalogDefaultRef.current))
                setNewSessBg(pickNewSessModel(newSessModelsRef.current, [readBgPref()], newSessCatalogDefaultRef.current))
                loadNewSessionBackground(newSessRequestRef.current)
              }}>{T('console.modeComputerUse')}</button>
            </div>
            <div className="dsh-wt_modeTip">{newSessMode === 'computer-use' ? T('console.modeComputerUseTip') : T('console.modeStandardTip')}</div>
            <label className="dsh-wt_modelRow">
              <span className="dsh-wt_modelLabel">{T('console.frontModel')}</span>
              <select
                className="dsh-wt_modelSelect"
                disabled={newSessModelsLoading && newSessModels.length === 0}
                value={newSessModelKey(newSessFrontShown)}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) { setNewSessFront(null); return }
                  const [provider, model] = v.split('\u0000')
                  const hit = newSessModels.find((m) => m.provider === provider && m.model === model)
                  const next = { provider, model, name: hit?.name ?? model }
                  setNewSessFront(next)
                  writeModelPref(newSessMode === 'computer-use' ? 'cu' : 'standard', next)
                }}
              >
                {newSessFrontShown && !newSessModels.some((m) => sameNewSessModel(m, newSessFrontShown)) && (
                  <option value={newSessModelKey(newSessFrontShown)}>{newSessFrontShown.name ?? newSessFrontShown.model}</option>
                )}
                {!newSessFrontShown && newSessModels.length === 0 && (
                  <option value="" disabled>{newSessModelsLoading ? T('console.modelLoading') : T('console.modelUnavailable')}</option>
                )}
                {newSessModels.map((m) => (
                  <option key={m.provider + '\u0000' + m.model} value={m.provider + '\u0000' + m.model}>{m.groupName} · {m.name}</option>
                ))}
              </select>
            </label>
            {newSessMode === 'computer-use' && (
              <label className="dsh-wt_modelRow">
                <span className="dsh-wt_modelLabel">{T('console.backgroundModel')}</span>
                <select
                  className="dsh-wt_modelSelect"
                  disabled={newSessModelsLoading && newSessModels.length === 0}
                  value={newSessModelKey(newSessBgShown)}
                  onChange={(e) => {
                    const v = e.target.value
                    if (!v) { setNewSessBg(null); return }
                    const [provider, model] = v.split('\u0000')
                    const hit = newSessModels.find((m) => m.provider === provider && m.model === model)
                    const next = { provider, model, name: hit?.name ?? model }
                    newSessBgTouchedRef.current = true
                    setNewSessBg(next)
                    writeBgPref(next)
                  }}
                >
                  {newSessBgShown && !newSessModels.some((m) => sameNewSessModel(m, newSessBgShown)) && (
                    <option value={newSessModelKey(newSessBgShown)}>{newSessBgShown.name ?? newSessBgShown.model}</option>
                  )}
                  {!newSessBgShown && newSessModels.length === 0 && (
                    <option value="" disabled>{newSessModelsLoading ? T('console.modelLoading') : T('console.modelUnavailable')}</option>
                  )}
                  {newSessModels.map((m) => (
                    <option key={m.provider + '\u0000' + m.model} value={m.provider + '\u0000' + m.model}>{m.groupName} · {m.name}</option>
                  ))}
                </select>
              </label>
            )}
            {newSessModelsLoading && <div className="dsh-wt_modelHint">{T('console.modelLoading')}</div>}
            {!newSessModelsLoading && newSessModels.length === 0 && (
              <div className="dsh-wt_modelHint">
                {T('console.modelUnavailable')}
                <button type="button" className="dsh-wt_modelRetry" onClick={reloadNewSessionModels}>{T('console.modelRetry')}</button>
              </div>
            )}
            <div className="dsh-wt_newSessOps">
              <button type="button" className="dsh-wt_btnGhost" disabled={newSessBusy} onClick={() => setNewSessFor(null)}>{T('console.cancel')}</button>
              <button type="button" className="dsh-wt_btnPrimary" disabled={newSessBusy} onClick={submitNewSession}>{newSessBusy ? T('console.creatingSession') : T('console.createSession')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 文件夹图标（重绘 SVG，与 better-sidebar 同款风格） */
function FolderIcon() {
  return (
    <svg className="dsh-wt_treeIcon" width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M1.75 3.25A1.75 1.75 0 0 1 3.5 1.5h2.63a1.75 1.75 0 0 1 1.34.66l.62.79a1.75 1.75 0 0 0 1.34.66H12.5a1.75 1.75 0 0 1 1.75 1.75v7.39A1.75 1.75 0 0 1 12.5 14.5h-9a1.75 1.75 0 0 1-1.75-1.75V3.25Z" fill="var(--dsw-alias-state-accent-primary,#4f8ef7)" opacity="0.9" />
      <path d="M1.75 5.75h12.5v7a1.75 1.75 0 0 1-1.75 1.75h-9a1.75 1.75 0 0 1-1.75-1.75v-7Z" fill="var(--dsw-alias-state-accent-primary,#4f8ef7)" opacity="0.4" />
    </svg>
  )
}

/** 文件图标（重绘 SVG） */
function FileIcon() {
  return (
    <svg className="dsh-wt_treeIcon" width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M4 1.5h5.25a1 1 0 0 1 .71.29l3.25 3.25a1 1 0 0 1 .29.71V13.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" fill="var(--dsw-alias-fill-l1,rgba(255,255,255,.06))" stroke="var(--dsw-alias-label-secondary,#9aa4b2)" strokeWidth="1.1" />
      <path d="M9.25 1.5V4.75h3.25" fill="none" stroke="var(--dsw-alias-label-secondary,#9aa4b2)" strokeWidth="1.1" />
    </svg>
  )
}

/** 资源管理器窗：树形展开（懒加载子目录；刷新/上一级均可用；.html 点击开浏览器标签） */
function ExplorerPane(props: { row: PaneRow; index: number }) {
  const cacheRef = useRef<Record<string, any[]>>({})
  const expandedRef = useRef<Set<string>>(new Set())
  const [rootPath, setRootPath] = useState('')
  const [error, setError] = useState('')
  const [, setTick] = useState(0)
  const rerender = () => setTick((t) => t + 1)

  const fetchDir = useCallback(async (path: string, force = false) => {
    if (!force && cacheRef.current[path]) return { path, entries: cacheRef.current[path] }
    try {
      const d = await postJson('/api/worktable/fs', {
        path,
        sessionId: splitEnv?.getScope()?.sessionId ?? '',
        cwd: splitEnv?.getScope()?.cwd ?? '',
      })
      const entries: any[] = d.entries ?? []
      cacheRef.current[d.path] = entries
      setError(d.error ? String(d.error) : '')
      return { path: d.path, entries }
    } catch (e) {
      setError(String(e))
      return { path, entries: [] }
    } finally {
      rerender()
    }
  }, [])

  const initRoot = useCallback(async () => {
    const r = await fetchDir(splitEnv?.getScope()?.cwd ?? '')
    setRootPath(r.path)
    rerender()
  }, [fetchDir])

  useEffect(() => { initRoot() }, [initRoot])

  const toggle = (path: string) => {
    if (expandedRef.current.has(path)) expandedRef.current.delete(path)
    else { expandedRef.current.add(path); fetchDir(path) }
    rerender()
  }

  const refresh = () => {
    cacheRef.current = {}
    expandedRef.current.clear()
    setError('')
    initRoot()
  }

  const goUp = () => {
    if (!rootPath) return
    const parent = parentPathOf(rootPath)
    if (parent === rootPath) return
    cacheRef.current = {}
    expandedRef.current.clear()
    setError('')
    fetchDir(parent).then((r) => { setRootPath(r.path); rerender() })
  }

  const renderLevel = (path: string, depth: number): any[] => {
    const entries = cacheRef.current[path]
    if (!entries) return []
    const nodes: any[] = []
    for (const e of entries) {
      const isOpen = expandedRef.current.has(e.path)
      nodes.push(
        <div key={e.path}>
          <button
            type="button"
            className="dsh-wt_treeRow"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              if (e.isDir) { toggle(e.path); return }
              if (/\.html?$/i.test(e.name)) {
                // 目录级静态托管：相对引用（./assets/...）在所在目录下解析，页面可完整渲染
                const dir = parentPathOf(e.path)
                splitStore.openTab(props.row, props.index, {
                  kind: 'iframe',
                  url: '/api/worktable/site/' + encodeURIComponent(dir) + '/' + encodeURIComponent(e.name),
                  title: e.name,
                })
              } else if (/\.(md|markdown|mdown|txt|log|tsx|ts|jsx|js|css|json|pdf|png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(e.name)) {
                splitStore.openTab(props.row, props.index, { kind: 'file', path: e.path })
              } else {
                setError(T('pane.openLater'))
              }
            }}
          >
            <span className={'dsh-wt_treeArrow' + (e.isDir && isOpen ? ' dsh-wt_treeArrowOpen' : '')} aria-hidden>{e.isDir ? '▸' : ''}</span>
            {e.isDir ? <FolderIcon /> : <FileIcon />}
            <span className="dsh-wt_treeName">{e.name}</span>
          </button>
          {e.isDir && isOpen && renderLevel(e.path, depth + 1)}
        </div>,
      )
    }
    return nodes
  }

  return (
    <>
      <div className="dsh-wt_subBar">
        <button type="button" className="dsh-wt_subBtn" title="上一级" onClick={goUp}>⬆</button>
        <button type="button" className="dsh-wt_subBtn" title="刷新" onClick={refresh}>↻</button>
        <span className="dsh-wt_subPath">{rootPath || '…'}</span>
      </div>
      <div className="dsh-wt_subList">
        {error && <div className="dsh-wt_subEmpty">{error}</div>}
        {!error && cacheRef.current[rootPath]?.length === 0 && <div className="dsh-wt_subEmpty">—</div>}
        {renderLevel(rootPath, 0)}
      </div>
    </>
  )
}

/** 源代码管理窗（服务端 /api/worktable/git） */
function GitPane() {
  const [snap, setSnap] = useState<{ isRepo: boolean; branch?: string; entries: any[] } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    postJson('/api/worktable/git', {
      sessionId: splitEnv?.getScope()?.sessionId ?? '',
      cwd: splitEnv?.getScope()?.cwd ?? '',
    })
      .then(setSnap)
      .catch((e) => setError(String(e)))
  }, [])
  useEffect(() => { load() }, [load])
  return (
    <>
      <div className="dsh-wt_subBar">
        <button type="button" className="dsh-wt_subBtn" title="刷新" onClick={load}>↻</button>
        <span className="dsh-wt_subPath">{snap?.isRepo ? ('⎇ ' + snap.branch) : ''}</span>
      </div>
      <div className="dsh-wt_subList">
        {error && <div className="dsh-wt_subEmpty">{error}</div>}
        {!error && snap && !snap.isRepo && <div className="dsh-wt_subEmpty">{T('pane.gitNotRepo')}</div>}
        {!error && snap?.isRepo && snap.entries.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.gitClean')}</div>}
        {!error && snap?.isRepo && snap.entries.map((e, i) => (
          <div key={i} className="dsh-wt_subRow dsh-wt_subRowStatic">
            <span className={'dsh-wt_gitXY dsh-wt_gitXY' + (e.xy.includes('A') || e.xy.includes('M') ? 'Mod' : 'New')}>{e.xy.trim()}</span>
            <span className="dsh-wt_subName">{e.path}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/** 任务管理窗：后台任务 + 子代理（Agent 情况；2s 刷新） */
function JobsPane() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 2 秒一次强制重渲染：输入框组合中 / 抽屉开合中先让路（下一轮照旧补上）。
      if (domGate.isPaused()) return
      setTick((t) => t + 1)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [])
  const jobs = splitEnv?.getJobs?.() ?? []
  const subagents = splitEnv?.getSubagents?.() ?? []
  return (
    <div className="dsh-wt_subList">
      <div className="dsh-wt_subSection">{T('pane.jobsTitle')}</div>
      {jobs.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.jobsEmpty')}</div>}
      {jobs.map((j) => (
        <div key={j.id} className="dsh-wt_subRow dsh-wt_subRowStatic">
          <span className={'dsh-wt_jobDot dsh-wt_jobDot-' + j.status} aria-hidden>●</span>
          <span className="dsh-wt_subName">{j.label}</span>
          <span className="dsh-wt_subTag">{j.kind}</span>
        </div>
      ))}
      <div className="dsh-wt_subSection">{T('pane.subagents')}</div>
      {subagents.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.subagentsEmpty')}</div>}
      {subagents.map((s: any, i: number) => (
        <div key={s?.id ?? i} className="dsh-wt_subRow dsh-wt_subRowStatic" style={{ paddingLeft: 8 + (s?.depth ?? 0) * 12 }}>
          <span className={'dsh-wt_jobDot dsh-wt_jobDot-' + (s?.status ?? 'stopping')} aria-hidden>●</span>
          <span className="dsh-wt_subName">{s?.label ?? s?.title ?? s?.name ?? '—'}</span>
          {s?.status && <span className="dsh-wt_subTag">{s.status}</span>}
        </div>
      ))}
    </div>
  )
}

/** 终端窗（WS /api/worktable/term + node-pty） */
function TerminalPane() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let term: any = null
    let ws: WebSocket | null = null
    let disposed = false
    try {
      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, Menlo, monospace',
        fontSize: 12,
        convertEol: true,
        theme: { background: '#010409' },
      })
    } catch {
      setFailed(T('pane.termFail'))
      return
    }
    term.open(el)
    // 强制自动换行（DECAWM on）：超长行在窗口宽度处换行，不被截断
    try { term.write('\x1b[?7h') } catch {}
    const focusTerm = () => { try { term.focus() } catch {} }
    focusTerm()
    el.addEventListener('pointerdown', focusTerm)
    const scope = splitEnv?.getScope?.()
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = proto + '//' + location.host + '/api/worktable/term?sessionId=' + encodeURIComponent(scope?.sessionId ?? '') + '&cwd=' + encodeURIComponent(scope?.cwd ?? '') + '&cols=80&rows=24'
    try {
      ws = new WebSocket(url)
    } catch {
      term.dispose()
      setFailed(T('pane.termFail'))
      return
    }
    ws.onopen = () => { focusTerm(); try { term.write('\x1b[?7h') } catch {} }
    ws.onmessage = (ev) => { try { term.write(String(ev.data)) } catch {} }
    ws.onclose = () => { if (!disposed) { try { term.write('\r\n[连接已关闭]') } catch {} } }
    ws.onerror = () => { if (!disposed) setFailed(T('pane.termFail')) }
    term.onData((d: string) => { if (ws && ws.readyState === 1) ws.send(d) })
    const ro = new ResizeObserver(() => {
      if (typeof term.fit === 'function') {
        try { term.fit() } catch {}
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    ro.observe(el)
    return () => {
      disposed = true
      ro.disconnect()
      try { ws?.close() } catch {}
      try { term.dispose() } catch {}
    }
  }, [])
  if (failed) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{failed}</span></div>
  }
  return <div ref={hostRef} className="dsh-wt_termHost" />
}

let mdRenderer: MarkdownIt | null = null
function markdownHtml(text: string): string {
  // Markdown 只在首次预览 .md 时初始化，DSH 首屏不构造 renderer。
  if (!mdRenderer) mdRenderer = new MarkdownIt({ linkify: true })
  return mdRenderer.render(text)
}

const IMAGE_EXTS = /[.](png|jpe?g|gif|webp|svg|bmp|ico)$/i
const MD_EXTS = /[.](md|markdown|mdown)$/i

/** 本地文件预览：PDF 走原生 iframe（Chrome 内置阅读器）、图片居中、MD 渲染、其余纯文本 */
function FileViewer(props: { path: string }) {
  const ext = (props.path.split('.').pop() || '').toLowerCase()
  const fileUrl = '/api/worktable/file?path=' + encodeURIComponent(props.path)
  if (ext === 'pdf') {
    return <iframe className="dsh-wt_paneFrame" src={fileUrl} title={basenameOf(props.path)} />
  }
  if (IMAGE_EXTS.test('.' + ext)) {
    return (
      <div className="dsh-wt_imgView">
        <img src={fileUrl} alt={basenameOf(props.path)} />
      </div>
    )
  }
  return <TextViewer path={props.path} fileUrl={fileUrl} isMd={MD_EXTS.test('.' + ext)} />
}

/** 代码文件语言映射（预览语法着色） */
const CODE_LANGS: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', css: 'css', json: 'json' }
const CODE_EXTS = /[.](tsx|ts|jsx|js|css|json)$/i

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function codeHtml(text: string, ext: string): string {
  const lang = CODE_LANGS[ext] ?? ''
  if (lang) {
    try {
      ensureHljsReady()
      return hljs.highlight(text, { language: lang }).value
    } catch { return escapeHtml(text) }
  }
  return escapeHtml(text)
}

/** 文本预览（fetch 原文 → MD 渲染 / 代码高亮 / <pre> 等宽展示）；全部文本类型支持编辑/预览切换并可保存回磁盘 */
function TextViewer(props: { path: string; fileUrl: string; isMd: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveFail, setSaveFail] = useState(false)
  useEffect(() => {
    let dead = false
    setText(null)
    setError('')
    fetch(props.fileUrl)
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.text()
      })
      .then((t) => { if (!dead) setText(t) })
      .catch((e) => { if (!dead) setError(String(e)) })
    return () => { dead = true }
  }, [props.fileUrl])
  const enterEdit = () => { setDraft(text ?? ''); setSaveFail(false); setMode('edit') }
  const save = async () => {
    setSaving(true)
    setSaveFail(false)
    try {
      const r = await fetch('/api/worktable/write', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: props.path, content: draft }),
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      setText(draft)
      setMode('preview')
    } catch {
      setSaveFail(true)
    } finally {
      setSaving(false)
    }
  }
  if (error) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{T('file.fail')}：{error}</span></div>
  }
  if (text == null) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{T('file.loading')}</span></div>
  }
  const ext = (props.path.split('.').pop() || '').toLowerCase()
  const isCode = CODE_EXTS.test('.' + ext)
  return (
    <>
      <div className="dsh-wt_mdBar">
        <button type="button" className={'dsh-wt_mdBtn' + (mode === 'preview' ? ' dsh-wt_mdBtnOn' : '')} onClick={() => setMode('preview')}>{T('file.preview')}</button>
        <button type="button" className={'dsh-wt_mdBtn' + (mode === 'edit' ? ' dsh-wt_mdBtnOn' : '')} onClick={enterEdit}>{T('file.edit')}</button>
        {mode === 'edit' && (
          <button type="button" className="dsh-wt_mdSave" disabled={saving} onClick={save}>{saving ? '…' : T('file.save')}</button>
        )}
        {saveFail && <span className="dsh-wt_mdMsg">{T('file.saveFail')}</span>}
      </div>
      {mode === 'edit'
        ? <textarea className="dsh-wt_mdEdit" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
        : props.isMd
          ? (
            <div className="dsh-wt_fileView">
              <div
                className="dsh-wt_md"
                dangerouslySetInnerHTML={{ __html: markdownHtml(text) }}
                onClick={(e: any) => {
                  const a = e.target && e.target.closest ? (e.target.closest('a') as HTMLAnchorElement | null) : null
                  if (!a) return
                  e.preventDefault()
                  const href = a.getAttribute('href') || ''
                  if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener')
                }}
              />
            </div>
          )
          : isCode
            ? (
              <div className="dsh-wt_fileView">
                <pre className="dsh-wt_code"><code dangerouslySetInnerHTML={{ __html: codeHtml(text, ext) }} /></pre>
              </div>
            )
            : <div className="dsh-wt_fileView"><pre className="dsh-wt_txt">{text}</pre></div>}
    </>
  )
}

/** 自制下拉列表（原生 select 无法美化）：文件夹分组标题 + 1px 细分隔线 + 选项列表 */
function SelectPop(props: {
  value: string | null
  groups: { title: string; items: { id: string; label: string; isCurrent?: boolean }[] }[]
  placeholder?: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const flat = props.groups.flatMap((g) => g.items)
  const selected = flat.find((i) => i.id === props.value)
  return (
    <div className="dsh-wt_select">
      <button type="button" className="dsh-wt_selectBtn" onClick={() => setOpen((v) => !v)}>
        <span className={'dsh-wt_selectVal' + (selected ? '' : ' dsh-wt_selectPh')}>{selected?.label ?? props.placeholder ?? ''}</span>
        <span className="dsh-wt_selectCaret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="dsh-wt_selectList">
          {props.groups.map((g, gi) => (
            <Fragment key={g.title || 'g' + gi}>
              {g.title && (
                <>
                  <div className="dsh-wt_selectDivider" />
                  <div className="dsh-wt_selectGroup">📁 {g.title}</div>
                </>
              )}
              {g.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={'dsh-wt_selectItem' + (it.id === props.value ? ' dsh-wt_selectItemOn' : '')}
                  onClick={() => { props.onChange(it.id); setOpen(false) }}
                >
                  <span className="dsh-wt_selectItemTitle">{it.label}</span>
                  {it.isCurrent && <span className="dsh-wt_selectCurrent">{T('custom.sessionCurrent')}</span>}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

/** 自定义窗口：居中对话框。两种模式：新建专属会话 / 发送到已有会话（默认当前会话）。 */
function CustomPane(props: { paneTitle?: string }) {
  const paneTitle = props.paneTitle ?? ''
  try { (window as any).__dshLastCustomPaneTitle = paneTitle } catch {}
  const custom = splitEnv?.custom
  const [requirement, setRequirement] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string }[]>(() => custom?.getProjects?.() ?? [])
  const [mode, setMode] = useState<'new' | 'existing'>('existing')
  const [sessionGroups, setSessionGroups] = useState<{ title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  // 分组（宿主工作区）三态：未分组 / 现有组 / 新建组
  const [wsGroups, setWsGroups] = useState<{ id: string; title: string; path: string }[]>([])
  const [groupMode, setGroupMode] = useState<'none' | 'existing' | 'new'>('none')
  const [groupId, setGroupId] = useState<string | null>(null)
  const [newGroupParent, setNewGroupParent] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [fail, setFail] = useState('')
  const [bindNote, setBindNote] = useState<'auto' | 'kept' | 'none'>('none')
  // 默认项目 = 当前工作区所属项目；默认会话 = 当前会话；默认分组 = 当前会话所在工作区
  useEffect(() => {
    const list = custom?.getProjects?.() ?? []
    setProjects(list)
    const cur = custom?.currentProjectId?.() ?? null
    setProjectId(cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null))
    setWsGroups((custom?.getWorkspaces?.() ?? []).map((w) => ({ id: w.id, title: w.title, path: w.path })))
    custom?.getSessions?.().then((res) => {
      setSessionGroups(res.groups)
      const flat = res.groups.flatMap((g) => g.sessions)
      setSessionId(flat.find((s) => s.isCurrent)?.id ?? flat[0]?.id ?? null)
      const curId = flat.find((s) => s.isCurrent)?.id
      const home = curId ? (custom?.getWorkspaces?.() ?? []).find((w) => (w.sessionIds ?? []).includes(curId)) : null
      if (home) { setGroupMode('existing'); setGroupId(home.id) }
    }).catch(() => { setSessionGroups([]) })
  }, [custom])
  const submit = async () => {
    const text = requirement.trim()
    if (!text || !projectId || !custom) return
    setBusy(true)
    setFail('')
    try {
      const proj = projects.find((p) => p.id === projectId)
      const pname = proj?.name ?? projectId
      if (mode === 'new') {
        let group: any = { kind: 'none' }
        if (groupMode === 'existing' && groupId) group = { kind: 'existing', workspaceId: groupId }
        else if (groupMode === 'new') {
          if (!newGroupParent.trim() || !newGroupName.trim()) { setFail(T('custom.groupNeedPath')); return }
          group = { kind: 'new', parent: newGroupParent.trim(), name: newGroupName.trim() }
        }
        const sid = await custom.submit(projectId, pname, text, group, paneTitle)
        setBindNote((custom.autoBind?.(sid) ?? 'none') as any)
      } else {
        if (!sessionId) return
        await custom.sendToSession(sessionId, projectId, pname, text, paneTitle)
        setBindNote((custom.autoBind?.(sessionId) ?? 'none') as any)
      }
      setDone(true)
    } catch (e) {
      setFail(String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!custom) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{T('pane.wip')}</span></div>
  }
  if (done) {
    return (
      <div className="dsh-wt_customBox">
        <span className="dsh-wt_customDone" aria-hidden>✅</span>
        <p className="dsh-wt_customDoneText">{mode === 'new' ? T('custom.done') : T('custom.sent')}</p>
        <p className="dsh-wt_customDoneHint">{T('custom.doneHint')}</p>
        {bindNote !== 'none' && (
          <p className="dsh-wt_customDoneBind">{bindNote === 'auto' ? T('custom.autoBound') : T('custom.keptBinding')}</p>
        )}
      </div>
    )
  }
  return (
    <div className="dsh-wt_customBox">
      <div className="dsh-wt_customCard">
        <span className="dsh-wt_customTitle">✨ {T('custom.title')}</span>
        <div className="dsh-wt_customModes">
          <button type="button" className={'dsh-wt_customModeBtn' + (mode === 'existing' ? ' dsh-wt_customModeBtnOn' : '')} onClick={() => setMode('existing')}>{T('custom.modeSend')}</button>
          <button type="button" className={'dsh-wt_customModeBtn' + (mode === 'new' ? ' dsh-wt_customModeBtnOn' : '')} onClick={() => setMode('new')}>{T('custom.modeNew')}</button>
        </div>
        <p className="dsh-wt_customHint">{mode === 'new' ? T('custom.hint') : T('custom.hintSend')}</p>
        <textarea
          className="dsh-wt_customInput"
          autoFocus
          placeholder={T('custom.placeholder')}
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
        />
        {mode === 'existing' && (
          <div className="dsh-wt_customRow">
            <span className="dsh-wt_customLabel">{T('custom.session')}</span>
            <SelectPop
              value={sessionId}
              groups={sessionGroups.map((g) => ({
                title: g.title,
                items: g.sessions.map((s) => ({ id: s.id, label: s.title, isCurrent: s.isCurrent })),
              }))}
              placeholder={T('custom.session')}
              onChange={setSessionId}
            />
          </div>
        )}
        <div className="dsh-wt_customRow">
          <span className="dsh-wt_customLabel">{T('custom.project')}</span>
          <SelectPop
            value={projectId}
            groups={[{ title: '', items: projects.map((p) => ({ id: p.id, label: p.name })) }]}
            placeholder={T('custom.project')}
            onChange={setProjectId}
          />
        </div>
        {mode === 'new' && (
          <div className="dsh-wt_customRow">
            <span className="dsh-wt_customLabel">{T('custom.group')}</span>
            <SelectPop
              value={groupMode === 'none' ? '__none' : groupMode === 'new' ? '__new' : groupId}
              groups={[{
                title: '',
                items: [
                  { id: '__none', label: T('custom.groupNone') },
                  ...wsGroups.map((w) => ({ id: w.id, label: w.title })),
                  { id: '__new', label: T('custom.groupNew') },
                ],
              }]}
              placeholder={T('custom.group')}
              onChange={(id) => {
                if (id === '__none') setGroupMode('none')
                else if (id === '__new') setGroupMode('new')
                else { setGroupMode('existing'); setGroupId(id) }
              }}
            />
          </div>
        )}
        {mode === 'new' && groupMode === 'new' && (
          <>
            <div className="dsh-wt_customRow">
              <span className="dsh-wt_customLabel">{T('custom.groupNewParent')}</span>
              <input
                className="dsh-wt_customPathInput"
                placeholder={T('custom.groupNewParentPh')}
                value={newGroupParent}
                onChange={(e) => setNewGroupParent(e.target.value)}
              />
            </div>
            <div className="dsh-wt_customRow">
              <span className="dsh-wt_customLabel">{T('custom.groupNewName')}</span>
              <input
                className="dsh-wt_customPathInput"
                placeholder={T('custom.groupNewNamePh')}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
            </div>
          </>
        )}
        <button
          type="button"
          className="dsh-wt_customSend"
          disabled={busy || !requirement.trim() || !projectId || (mode === 'existing' && !sessionId) || (mode === 'new' && groupMode === 'new' && (!newGroupParent.trim() || !newGroupName.trim()))}
          onClick={submit}
        >{busy ? '…' : (mode === 'new' ? T('custom.send') : T('custom.sendToSession'))}</button>
        {fail && <p className="dsh-wt_customFail">{T('custom.fail')}：{fail}</p>}
      </div>
    </div>
  )
}

/** 单个标签页的内容渲染 */
function PaneTabBody(props: { tab: PaneTab; row: PaneRow; index: number; paneTitle?: string; reloadKey: number }) {
  const content = props.tab.content
  if (content.kind === 'iframe') {
    return <IframePane url={content.url} title={content.title ?? props.tab.title} reloadKey={props.reloadKey} />
  }
  if (content.kind === 'file') {
    return <FileViewer path={content.path} />
  }
  if (content.type === 'browser') return <BrowserPane row={props.row} index={props.index} tabId={props.tab.id} content={content} reloadKey={props.reloadKey} />
  if (content.type === 'anim') return <AnimPane row={props.row} index={props.index} tabId={props.tab.id} content={content} reloadKey={props.reloadKey} />
  if (content.type === 'console') return <ConsolePane />
  if (content.type === 'flow') return <FlowPane projectId={content.url ?? ''} />
  if (content.type === 'explorer') return <ExplorerPane row={props.row} index={props.index} />
  if (content.type === 'scm') return <GitPane />
  if (content.type === 'tasks') return <JobsPane />
  if (content.type === 'terminal') return <TerminalPane />
  if (content.type === 'custom') return <CustomPane paneTitle={props.paneTitle ?? ''} />
  return (
    <div className="dsh-wt_paneWip">
      <span className="dsh-wt_paneWipIcon" aria-hidden>{BUILTIN_ICONS[content.type]}</span>
      <span className="dsh-wt_paneWipText">{T('pane.wip')}</span>
    </div>
  )
}

/** 需要标签栏刷新按钮的内容类型：网页类（iframe / 浏览器 / 动画）统一在标签最左放 ↻ */
function refreshableTab(t: PaneTab): boolean {
  const c = t.content
  return c.kind === 'iframe' || (c.kind === 'builtin' && (c.type === 'browser' || c.type === 'anim'))
}

/** 窗内容：标签页模型（无标签 = 6 选 1 选择器；标签可切换/关闭，关完回到选择器）
 *  网页类标签最左侧固定一个 ↻ 刷新按钮（标签名之前），点击重挂载该标签内容。 */
function PaneBody(props: { pane: SplitPane; row: PaneRow; index: number }) {
  const { pane, row, index } = props
  const tabs = pane.tabs ?? []
  const active = Math.min(pane.active ?? 0, Math.max(0, tabs.length - 1))
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({})
  if (tabs.length === 0) {
    return <PanePicker row={row} index={index} />
  }
  const refreshTab = (t: PaneTab) => {
    setReloadKeys((m) => ({ ...m, [t.id]: (m[t.id] ?? 0) + 1 }))
    splitStore.setActiveTab(row, index, t.id)
  }
  // 唯一标签是控制室或模板流程 → 整个标签栏不渲染（不可关、不可换，标签栏无信息价值；去掉顶部多余标题）
  const singleConsole = tabs.length === 1 && tabs[0].content?.kind === 'builtin' && (tabs[0].content.type === 'console' || tabs[0].content.type === 'flow')
  return (
    <>
      {!singleConsole && !pane.collapsed && (
      <div className="dsh-wt_tabBar">
        {tabs.map((t, i) => {
          // 控制室/模板流程标签不可关闭：关掉后窗格变选择器，用户回不来（不可逆操作）
          const locked = t.content?.kind === 'builtin' && (t.content.type === 'console' || t.content.type === 'flow')
          return (
          <span
            key={t.id}
            className={'dsh-wt_tab' + (i === active ? ' dsh-wt_tabOn' : '')}
            title={t.title}
            draggable={!locked}
            onDragStart={(e: any) => { dragTab = { row, index, tabId: t.id }; try { e.dataTransfer.effectAllowed = 'move' } catch {} }}
            onDragEnd={() => { dragTab = null; setDropTarget(null) }}
            onClick={() => splitStore.setActiveTab(row, index, t.id)}
          >
            {refreshableTab(t) && (
              <button
                type="button"
                className="dsh-wt_tabRefresh"
                title={T('pane.refresh')}
                aria-label={T('pane.refresh')}
                onClick={(e) => { e.stopPropagation(); refreshTab(t) }}
              >↻</button>
            )}
            <span className="dsh-wt_tabTitle">{t.title}</span>
            {!locked && (
              <button
                type="button"
                className="dsh-wt_tabClose"
                title={T('pane.closeTab')}
                onClick={(e) => { e.stopPropagation(); splitStore.closeTab(row, index, t.id) }}
              >✕</button>
            )}
          </span>
          )
        })}
      </div>
      )}
      <PaneTabBody tab={tabs[active]} row={row} index={index} paneTitle={pane.title} reloadKey={reloadKeys[tabs[active].id] ?? 0} />
    </>
  )
}

/** 未指派内容：4 选 1 选择器。按钮固定大小、整体居中；
 * 按窗位宽高比自适应排列：宽窗横排 4 连 / 方窗 2×2 / 竖窗竖排。 */
function PanePicker(props: { row: PaneRow; index: number }) {
  const [mode, setMode] = useState<'row' | 'grid' | 'col'>('grid')
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      const aspect = h > 0 ? w / h : 1
      setMode(aspect > 1.4 ? 'row' : aspect > 0.72 ? 'grid' : 'col')
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const pick = (content: SplitContent) => splitStore.openTab(props.row, props.index, content)
  return (
    <div ref={hostRef} className={'dsh-wt_panePicker dsh-wt_panePicker-' + mode}>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'browser' })}>
        <span aria-hidden>🌐</span>{T('pane.browser')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'anim' })}>
        <span aria-hidden>🎬</span>{T('pane.anim')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'explorer' })}>
        <span aria-hidden>📁</span>{T('pane.explorer')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'terminal' })}>
        <span aria-hidden>▸_</span>{T('pane.terminal')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'custom' })}>
        <span aria-hidden>✨</span>{T('pane.custom')}
      </button>
    </div>
  )
}

type PoolItem = { spec: LayoutSpec; chatW: number; chatPeek: boolean; topH: number; leftW: number; paneWs: number[]; topWs: number[] }

/** 单个工作区渲染层（geom 为 null 时用 0 几何渲染，外层 display:none 保活，保留网页/MD 滚动/激活标签等状态） */
function WorkspaceLayer(props: { spec: LayoutSpec; geom: Geom | null; chatW: number; chatPeek: boolean; topH: number; leftW: number; paneWs: number[]; topWs: number[] }) {
  const g = props.geom ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const spec = props.spec
  const top = spec.top ?? []
  const chatOnly = spec.chatOnly === true
  const main = chatOnly ? [] : (spec.main ?? [])
  const hasLeft = !!spec.left
  const hasTop = top.length > 0
  const chatLeft = !hasLeft && spec.chatSide === 'left'
  const colW = g.right - g.left
  const rowH = g.bottom - g.top
  // 全屏布局：对话列 0 宽（内容满宽）；点标题栏 💬 临时拉出
  const chatHidden = spec.chatHidden === true && !props.chatPeek
  const chatW = chatOnly ? 0 : (chatHidden ? 0 : clamp(props.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60)))
  const topH = hasTop
    ? clamp(props.topH, spec.topHeight?.min ?? 80, Math.max(spec.topHeight?.min ?? 80, rowH - BAR_H - 80))
    : 0
  const leftW = hasLeft
    ? clamp(props.leftW, spec.leftWidth?.min ?? 160, Math.max(spec.leftWidth?.min ?? 160, colW - 260))
    : 0
  const chatFull = spec.chatFullHeight === true
  const contentW = Math.max(0, colW - chatW)
  const contentX = hasLeft ? g.left + leftW : (chatLeft ? g.left + chatW : g.left)
  const topRowX = hasLeft ? g.left + leftW : contentX
  const topRowW = hasLeft ? Math.max(0, colW - leftW) : (chatFull ? contentW : colW)

  const topItems = allocate(top, props.topWs, topRowW)
  const mainItems = allocate(main, props.paneWs, contentW)
  const leftItem = spec.left ? { pane: spec.left, left: 0, width: leftW } : null

  const barTop = g.top
  const bodyTop = barTop + BAR_H + topH
  const paneBottom = g.bottom
  const mainH = paneBottom - bodyTop
  const topY = barTop + BAR_H

  const renderPane = (it: { pane: SplitPane; left: number; width: number }, row: PaneRow, index: number, x: number, y: number, h: number) => {
    const singleConsole = (it.pane.tabs ?? []).length === 1 && it.pane.tabs![0].content?.kind === 'builtin' && (it.pane.tabs![0].content.type === 'console' || it.pane.tabs![0].content.type === 'flow')
    return (
    <div
      key={it.pane.id}
      className="dsh-wt_pane"
      data-drop-hover={dropTarget && dropTarget.row === row && dropTarget.index === index ? 'true' : undefined}
      style={{ position: 'fixed', left: x + it.left, top: y, width: it.width, height: h, zIndex: 68 }}
      onDragOver={(e: any) => {
        if (!dragTab) return
        e.preventDefault()
        setDropTarget({ row, index })
      }}
      onDragLeave={(e: any) => {
        if (e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) setDropTarget(null)
      }}
      onDrop={(e: any) => {
        e.preventDefault()
        const s = dragTab
        dragTab = null
        setDropTarget(null)
        if (s && (s.row !== row || s.index !== index)) {
          splitStore.moveTab(s.row, s.index, s.tabId, row, index)
        }
      }}
    >
      {!it.pane.collapsed && (
      <div
        className="dsh-wt_paneBar"
        title={T('split.dragSwap')}
        draggable
        onDragStart={(e: any) => { dragPane = { row, index }; try { e.dataTransfer.effectAllowed = 'move' } catch {} }}
        onDragOver={(e: any) => e.preventDefault()}
        onDrop={(e: any) => {
          e.preventDefault()
          const s = dragPane
          if (s && (s.row !== row || s.index !== index)) splitStore.swapPanes(s.row, s.index, row, index)
          dragPane = null
        }}
        onDragEnd={() => { dragPane = null }}
      >
        <span className="dsh-wt_paneTitle">{it.pane.title}</span>
      </div>
      )}
      <PaneBody pane={it.pane} row={row} index={index} />
      {!singleConsole && (
        <>
        <button
          type="button"
          className="dsh-wt_annotBtn"
          title={T('annot.label')}
          aria-label={T('annot.label')}
          onClick={() => startAnnot(windowLabelOf(row, index))}
        >
          <svg viewBox="0 0 16 16" aria-hidden><path d="M2 5.6c0-1.2 1-2.2 2.2-2.2h7.6c1.2 0 2.2 1 2.2 2.2v3.6c0 1.2-1 2.2-2.2 2.2H7.5L5 13.6l.3-2.4H4.2c-1.2 0-2.2-1-2.2-2.2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        </button>
        <button
          type="button"
          className={'dsh-wt_collapseBtn' + (it.pane.collapsed ? ' dsh-wt_collapseBtnCollapsed' : '')}
          title={it.pane.collapsed ? T('pane.expand') : T('pane.collapse')}
          aria-label={it.pane.collapsed ? T('pane.expand') : T('pane.collapse')}
          onClick={() => splitStore.toggleCollapsed(row, index)}
        >
          {it.pane.collapsed ? (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </button>
        </>
      )}
    </div>
    )
  }

  return (
    <>
      {/* 标题栏 */}
      <div className="dsh-wt_splitBar" style={{ position: 'fixed', left: g.left, top: barTop, width: hasLeft || chatFull ? contentW : (hasTop ? colW : contentW), zIndex: 70 }}>
        {spec.id !== 'wt-console' && <span className="dsh-wt_splitTitle">{spec.title}</span>}
        {!hasLeft && !chatHidden && !chatOnly && (
          <button
            type="button"
            className="dsh-wt_splitFlip"
            title={T('split.flip')}
            onClick={() => splitStore.setChatSide(chatLeft ? 'right' : 'left')}
          >⇄</button>
        )}
        {spec.chatHidden === true && (
          <button
            type="button"
            className={'dsh-wt_splitFlip' + (!chatHidden ? ' dsh-wt_splitFlipOn' : '')}
            title={chatHidden ? '显示对话列' : '隐藏对话列（回到全屏）'}
            aria-pressed={!chatHidden}
            onClick={() => splitStore.toggleChatPeek()}
          >💬</button>
        )}
        <button type="button" className="dsh-wt_splitClose" aria-label="退出分栏（Esc）" onClick={() => splitStore.close()}>✕</button>
      </div>
      {/* 左列整高内容窗 */}
      {leftItem && renderPane(leftItem, 'left', 0, g.left, barTop + BAR_H, g.bottom - barTop - BAR_H)}
      {/* 顶部通栏行（左列布局时为右侧列顶行） */}
      {hasTop && topItems.map((it, i) => renderPane(it, 'top', i, topRowX, topY, topH))}
      {/* 主行内容窗 */}
      {mainItems.map((it, i) => renderPane(it, 'main', i, contentX, bodyTop, mainH))}
      {/* 顶部/主行水平分隔线 */}
      {hasTop && (
        <div
          className="dsh-wt_splitDivider dsh-wt_splitDividerH"
          role="separator"
          title="拖动调整上下分区"
          style={{ position: 'fixed', left: topRowX, top: bodyTop - DIVIDER / 2, width: topRowW, height: DIVIDER, zIndex: 72 }}
          onPointerDown={makeDividerHandler('top')}
        />
      )}
      {/* 顶部行内垂直分隔线 */}
      {hasTop && topItems.slice(0, -1).map((it, i) => (
        <div
          key={'tv' + it.pane.id}
          className="dsh-wt_splitDivider"
          role="separator"
          title="拖动调整宽度"
          style={{ position: 'fixed', left: topRowX + it.left + it.width - DIVIDER / 2, top: topY, width: DIVIDER, height: topH, zIndex: 72 }}
          onPointerDown={makeDividerHandler('topPane', i)}
        />
      ))}
      {/* 主行内容窗垂直分隔线 */}
      {mainItems.slice(0, -1).map((it, i) => (
        <div
          key={'v' + it.pane.id}
          className="dsh-wt_splitDivider"
          role="separator"
          title="拖动调整宽度"
          style={{ position: 'fixed', left: contentX + it.left + it.width - DIVIDER / 2, top: bodyTop, width: DIVIDER, height: mainH, zIndex: 72 }}
          onPointerDown={makeDividerHandler('pane', i)}
        />
      ))}
      {/* 聊天分隔线（左列布局 = 左/右列边界；其余 = 内容与聊天之间；全屏布局无对话列时不画） */}
      {!chatHidden && !chatOnly && (
      <div
        className="dsh-wt_splitDivider"
        role="separator"
        title={hasLeft ? '拖动调整左右列宽' : '拖动调整聊天宽度'}
        style={{
          position: 'fixed',
          left: (hasLeft ? g.left + leftW : (chatLeft ? g.left + chatW : g.right - chatW)) - DIVIDER / 2,
          top: hasLeft || chatFull ? barTop + BAR_H : bodyTop,
          width: DIVIDER,
          height: hasLeft || chatFull ? g.bottom - barTop - BAR_H : mainH,
          zIndex: 72,
        }}
        onPointerDown={makeDividerHandler(hasLeft ? 'left' : 'chat')}
      />
      )}
      <AnnotationOverlay />
    </>
  )
}

/** 分栏工作区浮层（shell.overlay 座位；订阅 splitStore 快照渲染）。
 * 切换项目时旧工作区不销毁：全部挂载在池中、仅当前可见（display:none 保活），
 * 网页子页面/滚动位置、MD 滚动位置、激活标签等在切回时原样保留。 */
function SplitWorkspace() {
  const [snap, setSnap] = useState({
    active: splitStore.active,
    spec: splitStore.spec,
    geom: splitStore.geom,
    chatW: splitStore.chatW,
    chatPeek: splitStore.chatPeek,
    topH: splitStore.topH,
    leftW: splitStore.leftW,
    paneWs: [...splitStore.paneWs],
    topWs: [...splitStore.topWs],
  })
  const poolRef = useRef<Map<string, PoolItem>>(new Map())
  const [, setPoolTick] = useState(0)

  useEffect(() => splitStore.subscribe(() => {
    const spec = splitStore.spec
    if (splitStore.active && spec) {
      poolRef.current.set(spec.id, {
        spec,
        chatW: splitStore.chatW,
        chatPeek: splitStore.chatPeek,
        topH: splitStore.topH,
        leftW: splitStore.leftW,
        paneWs: [...splitStore.paneWs],
        topWs: [...splitStore.topWs],
      })
      // 保活池上限 6 个（LRU：删最老的），避免长时间使用内存膨胀
      while (poolRef.current.size > 6) {
        const first = poolRef.current.keys().next().value
        if (first != null) poolRef.current.delete(first)
      }
    }
    setSnap({
      active: splitStore.active,
      spec: splitStore.spec,
      geom: splitStore.geom,
      chatW: splitStore.chatW,
      chatPeek: splitStore.chatPeek,
      topH: splitStore.topH,
      leftW: splitStore.leftW,
      paneWs: [...splitStore.paneWs],
      topWs: [...splitStore.topWs],
    })
    setPoolTick((t) => t + 1)
  }), [])

  useEffect(() => {
    if (!snap.active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') splitStore.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snap.active])

  // 标签拖放高亮 → 重渲染
  const [, setDropTick] = useState(0)
  useEffect(() => {
    const fn = () => setDropTick((t) => t + 1)
    dropTargetListeners.add(fn)
    return () => { dropTargetListeners.delete(fn) }
  }, [])

  const activeId = snap.active && snap.spec ? snap.spec.id : null
  const entries = Array.from(poolRef.current.entries())
  if (entries.length === 0) return null
  return (
    <>
      {entries.map(([id, item]) => {
        const isActive = id === activeId
        return (
          <div key={id} style={isActive ? undefined : { visibility: 'hidden' as const }}>
            <WorkspaceLayer
              spec={item.spec}
              geom={isActive ? snap.geom : null}
              chatW={isActive ? snap.chatW : item.chatW}
              chatPeek={isActive ? snap.chatPeek : item.chatPeek}
              topH={isActive ? snap.topH : item.topH}
              leftW={isActive ? snap.leftW : item.leftW}
              paneWs={isActive ? snap.paneWs : item.paneWs}
              topWs={isActive ? snap.topWs : item.topWs}
            />
          </div>
        )
      })}
    </>
  )
}

/** 调试出口（自动化验证用；必须在 store 定义之后） */
try { (window as any).__dshWorktable = { splitStore } } catch {}

export { SplitWorkspace }
