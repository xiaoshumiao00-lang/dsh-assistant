import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { css } from './styles'
import { NS, zh, en, type WorktableKey } from './locales'
import { isAbs, joinPath, parentPathOf, basenameOf } from './pathutil'
import { splitStore, SplitWorkspace, setSplitT, setSplitEnv, RUNNING_CARD_ID, type LayoutSpec, type SplitPane, type ConsoleCardData, type ProjectSessionItem, type NewSessionOptions } from './split'
import { splitOpenIntent } from './splitEntry'
import { sessionLeavesProject } from './projectExit'
import { BUILTIN_TEMPLATES, freshFlowRun, templateById, saveTemplateStepOverride, composeStepTask, composeStepSpec, effectiveSkill, effectiveInstruction, effectiveConverge, stepBriefOf, isStepBriefConfirmed, migrateFlowRun, OVERLAY_FILE, REPORT_PREFIX, l1ChecklistPath, parseL1Checklist, isConvergeStep, type FlowRunState, type FlowStepOverride, type FlowStepView, type FlowView, type TemplateDef, type TemplateStepDef } from './templates'
import { VerifyScheduler, composeDiagnosisTask } from './verifyLoop'
import { defaultProjectFolder, defaultProjectName, isAutoProjectFolder, projectFolderBrowseStart } from './newProjectDefault'
import { ProjectFolderSheet } from './projectFolderSheet'
import { showToast } from './toast.ts'
import type { FsBrowserApi } from './pocket/orb/PathBrowser.tsx'
import { NS as ORB_NS, zh as ORB_ZH, type OrbKey } from './pocket/orb/locales.ts'
import { POCKET_ENDPOINTS, POCKET_RPC_CHANNEL } from './pocket/api.js'
import { ICON_CHOICES, resolveProjectIcon, pickUnusedIcon } from './projectIcons'
import { focusSessionInHost, sessionFaceState, healBlankSessionIfStuck, type FocusResult } from './sessionFocus'
import { sessionsUnderFolder, normalizeFolderPath, unownedSessionIds, transientVisibility } from './sessionFolder'
import { assistantHomeDir } from './assistant-entry'
import { ASSISTANT_PROJECT_ID, ASSISTANT_CARD_NAME, ASSISTANT_CARD_ICON, shouldAddAssistantCard, withAssistantCard } from './assistant-card'
import { hasPendingInteraction, sessionStatusSourceOf, pendingInteractionSignature } from './sessionStatus'
import { sessionSnapshotIndexOf, invalidateSessionSnapshotIndex } from './sessionIndex'
import { pickActiveSession, sortSessionsByActivity, sessionTierOf, progressOrderOf, type RankableSessionRow } from './sessionRank'
import { domGate } from './compositionGate'
import { createBottomOverlayScanner, shouldApplyInset } from './bottomOverlay'
import { cachedJsonRead, cachedJsonWrite } from './localStore'
import { createFaceSnapshotCache } from './faceSnapshotCache'

/** 项目叠加层（L2）可选项：写作语言 */
const PAPER_LANG_OPTIONS = ['中文写作后翻译英文', '直接写英文', '仅中文投稿']
import { photoStore, kindOf } from './photoStore'
import { DEFAULT_BG_SVG } from './defaultBg'
import { loadWaveBgBlob } from './waveBg'
import { controlRoomStore, getAssistantApi, writeModelPref, writeBgPref, setWorkspaceExit } from './orb-bridge'
/**
 * dsh-worktable 客户端（v2）：侧边栏底部「工作台」区块。
 * 结构：分隔线 → [≡ 手柄][工作台][搜索/视图选项/添加+] → 项目卡片区（子座位）。
 * v2 新增（PRD §10 定案）：
 *   - 卡片规范 v2 渐进上报协议：owner props 下发 order/hidden/nameOverrides，
 *     卡片可选上报 reportMeta/reportUsed；v1 卡片零改动兼容（按注册序排在最前）。
 *   - 视图选项只留「排序：手动/最近」（分类已按用户定案取消）。
 *   - 「管理项目…」编辑模式：改名/隐藏/排序（拖拽 + ↑↓），全存 localStorage。
 *   - 「+」：接入指引 + 本地快捷方式（名称/图标/链接，点击新标签打开）。
 *   - 完整 zh/en 词典接入 dsh-client-locale（NS 'worktable'）。
 * 持久化：dsh.worktable.view.v1（视图）+ dsh.worktable.projects.v1（项目元状态）。
 */

type OrderBy = 'manual' | 'recent'
type DockMode = 'footer' | 'float'

// ── 更新检查：仓库、版本、升级指令、缓存全部来自 updateCheck（P0-4：唯一的更新源）──
import {
  LOCAL_VERSION, UPDATE_REPO, UPGRADE_CMD, UPGRADE_AI, checkUpdate,
  getAutoCheck, setAutoCheck, setSkipVersion, readCache, type UpdateInfo,
} from './updateCheck'
// 更新提示图标（手绘 SVG，避免 emoji 跨平台渲染差异）
const ICON_SYNC = (
  <svg viewBox="0 0 16 16" aria-hidden>
    <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M1.5 8a6.5 6.5 0 0 1 11.1-4.6L14.5 5" />
    <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M14.5 1.5V5h-3.5" />
    <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M14.5 8a6.5 6.5 0 0 1-11.1 4.6L1.5 11" />
    <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M1.5 14.5V11h3.5" />
  </svg>
)
const ICON_SPARK = (
  <svg viewBox="0 0 16 16" aria-hidden>
    <path d="M8 1.6l1.5 3.9 3.9 1.5-3.9 1.5L8 12.4 6.5 8.5 2.6 7l3.9-1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M12.6 11.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="currentColor" />
  </svg>
)
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fallthrough */ }
  return false
}

type ViewState = {
  query: string
  searchOpen: boolean
  orderBy: OrderBy
  dock: DockMode
  floatTop: number | null
  /** 控制室面板主题：dark/light/system（system = 跟随宿主 color-scheme，即 DSH 深色/白色/跟随系统设置） */
  consoleTheme?: 'dark' | 'light' | 'system'
  /** 控制室每行显示项目数（1-5，默认 3）*/
  consoleCols?: number
  /** 控制室卡片形状：square/circle（默认 square）*/
  consoleShape?: 'square' | 'circle'
  /** 控制室背景：plain/glow/photo（默认 glow）*/
  consoleBg?: 'plain' | 'glow' | 'photo'
  /** 纯色背景 HSL（默认对应 #0a0d13 = 220/31/6）*/
  consoleBgPlainHsl?: { h: number; s: number; l: number }
  /** 流光背景 HSL（hue-rotate/saturate/brightness；默认无调整 = 0/100/100）*/
  consoleBgGlowHsl?: { h: number; s: number; l: number }
  /** 当前选中的背景照片 id（photoRecords 中的一条记录）*/
  consoleBgPhotoId?: string
  /** 各背景照片的 HSL 滤镜记录（id → {h,s,l}；默认无调整 = 0/100/100）*/
  consoleBgPhotoHsls?: Record<string, { h: number; s: number; l: number }>
  /** 照片背景上的网格线开关（默认开）*/
  consoleBgPhotoGrid?: boolean
  /** 照片背景网格线透明度 %（0-30，默认 8）*/
  consoleBgGridOpacity?: number
  /** 项目卡片贴片模糊 px（0-20，默认 0）——照片/自定义背景的记忆 */
  consoleCardBlur?: number
  /** 按背景记忆：纯色/流光的贴片模糊 px（0-20，默认 0）*/
  consoleBgPlainBlur?: number
  consoleBgGlowBlur?: number
  /** 按背景记忆：纯色/流光的网格线不透明度 %（0-30，默认 5 / 8）*/
  consoleBgPlainGrid?: number
  consoleBgGlowGrid?: number
  /** 流光移动速度（0-100，默认 50 = 原速×1；0 = 完全不动；100 = 2× 快）*/
  consoleGlowSpeed?: number
}

/** 卡片上报的项目元信息（协议 v2）。 */
export type ProjectMeta = { id: string; name: string; icon?: string }
/** 本地快捷方式（仅存 localStorage）。 */
export type Shortcut = { id: string; name: string; icon: string; href: string }

type ProjectsState = {
  /** 手动排序的 id 序列（新注册 id 未出现在其中时追加在尾部）。 */
  order: string[]
  /** id → 最近使用时间戳（毫秒），来源：卡片点击时 reportUsed。 */
  lastUsed: Record<string, number>
  /** 被隐藏的项目 id 集。 */
  hidden: string[]
  /** 显示名覆盖（编辑模式改名；空值删除覆盖）。 */
  nameOverrides: Record<string, string>
  /** 图标覆盖（点图标换 emoji；含入驻插件项目 id → emoji）。 */
  iconOverrides: Record<string, string>
  /** 已从工作台删除的入驻项目 id（真删除：恢复默认不复活；在「已删除的项目」里可重新添加）。 */
  removed: string[]
  /** 入驻项目的视图覆盖（id → LayoutSpec）：变更视图后按此打开，替换项目自声明的布局。 */
  views: Record<string, LayoutSpec>
  /** 本地快捷方式条目。 */
  shortcuts: Shortcut[]
  /** 用户自建的布局条目（「+」新建工作区保存的 LayoutSpec）。 */
  layouts: LayoutSpec[]
  /** 项目 → 绑定会话：打开该项目时右侧对话窗自动切换到这个会话（空/缺 = 不换）。 */
  bindings: Record<string, string>
  /** 项目 → 工作文件夹（绝对路径）：该项目所有产出文件都放这里；新建项目时强制填写。 */
  folders: Record<string, string>
  /** 模板流程运行状态（模板实例 layoutId → run；模板项目专属） */
  flows?: Record<string, FlowRunState>
  /** 项目 → 项目概况（用户填写的论文/项目全局信息 markdown；写入 _项目全局信息.md 并同步进各步 _本步要求.md） */
  briefs?: Record<string, string>
}

const PERSIST_KEY = 'dsh.worktable.view.v1'
const PROJECTS_KEY = 'dsh.worktable.projects.v1'
const MIN_TOP = 56
const SNAP_PX = 32
/** 插件市场外链（GitHub 仓库，已核实可访问；PRD 提及的 dshfind.com 未验证，不用死链）。 */
const MARKET_URL = 'https://github.com/hikariming/dshfind'
/** 已报到卡片的 CSS order 偏移：未上报（order=0）的 v1 卡片永远排在已上报卡片之前。 */
const ORDER_OFFSET = 1000
/** 非引擎项目埋点冷却（毫秒）：同 id 两次计使用的最小间隔 */
const LEGACY_BUMP_COOLDOWN = 15000
/** 落点判定余量：松手时指针越出有效落点区（超出底部/顶部/侧边）即视为「无有效落点」。 */
const OVER_BOTTOM_PX = 24
const OVER_TOP_PX = 24
const OVER_SIDE_PX = 80

/** 拓扑预设（聊天窗恒贴右，PRD §13.2 硬约束）：会话全屏/左右/三栏/左二右一/井字/左品右聊/左1大下3小/全屏内容窗
 *  chat = 会话全屏：不显示内容窗，官方会话视图占满整宽——新建项目的默认布局（全屏看到的就是会话本身）。
 *  full = 全屏内容窗（单窗格、不分栏、无对话列，标题栏 💬 可临时拉出对话）：模板项目的流程面板要它，
 *         需要整页内容时也可手动选；按惯例新预设追加，故排在末尾。 */
const PRESET_DEFS = [
  { id: 'chat', leftCount: 0, topCount: 0, contentCount: 1, chatFull: false, chatOnly: true },
  { id: '2h', leftCount: 0, topCount: 0, contentCount: 1, chatFull: false, chatRatio: 0.5 },
  { id: '3h', leftCount: 0, topCount: 0, contentCount: 2, chatFull: false },
  { id: 'l2', leftCount: 0, topCount: 1, contentCount: 1, chatFull: true },
  { id: 'grid', leftCount: 0, topCount: 2, contentCount: 1, chatFull: false },
  { id: 't3', leftCount: 0, topCount: 1, contentCount: 2, chatFull: true },
  { id: 'l13', leftCount: 0, topCount: 1, contentCount: 3, chatFull: true, topHeightDefault: 420, topHeightRatio: 0.55 },
  { id: 'g4', leftCount: 0, topCount: 2, contentCount: 2, chatFull: true, topHeightRatio: 0.5 },
  { id: 'l23', leftCount: 0, topCount: 2, contentCount: 3, chatFull: true, topHeightRatio: 0.5 },
  { id: 'full', leftCount: 0, topCount: 0, contentCount: 1, chatFull: false, chatHidden: true },
] as const

/** 新建项目的默认布局预设：会话全屏（整块就是会话本身；内容窗藏在后面，切到别的视图时标签不丢） */
const DEFAULT_PRESET_ID = 'chat'

/** 侧栏图标备选集（emoji）：布局/快捷方式/入驻项目的图标，点击可换。
 *  与新建项目的随机图标共用同一套集合（src/client/projectIcons.ts），只有一处真源。 */
const EMOJI_SET: readonly string[] = ICON_CHOICES

/** 官方工作区头部按钮图标（自 DSH Web GUI 工作区面板取样，fill=currentColor 跟随主题） */
const ICON_SEARCH = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z" fill="currentColor" />
    <path d="M16.000417 15.041079L15.044449 16.000433L11.530434 12.473588L12.486298 11.514234L16.000417 15.041079Z" fill="currentColor" />
  </svg>
)
const ICON_VIEW_OPTIONS = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path transform="translate(1.292 1.3)" d="M10.3232 9.18164C11.2868 9.18164 12.0985 9.82833 12.3506 10.7109L13.415 10.7109L13.415 11.8711L12.3496 11.8711C12.0971 12.7532 11.2864 13.3994 10.3232 13.3994C9.36031 13.3992 8.55012 12.7531 8.29785 11.8711L0 11.8711L0 10.7109L8.29688 10.7109C8.54876 9.82845 9.35988 9.18186 10.3232 9.18164ZM10.3232 10.3418C9.7999 10.3421 9.37534 10.7667 9.375 11.29C9.375 11.8137 9.79969 12.239 10.3232 12.2393C10.847 12.2393 11.2725 11.8138 11.2725 11.29C11.2721 10.7666 10.8468 10.3418 10.3232 10.3418ZM12.4326 11.291C12.4326 11.3549 12.4284 11.418 12.4229 11.4805C12.4287 11.4181 12.4326 11.355 12.4326 11.291ZM8.21484 11.2832C8.21484 11.2856 8.21484 11.2886 8.21484 11.291L8.21484 11.29C8.21484 11.2878 8.21484 11.2855 8.21484 11.2832ZM3.08301 4.59082C4.04605 4.59095 4.85696 5.23717 5.10938 6.11914L13.415 6.11914L13.415 7.2793L5.11035 7.2793C4.85833 8.16202 4.04648 8.80846 3.08301 8.80859C2.11972 8.80843 1.30963 8.16179 1.05762 7.2793L0 7.2793L0 6.11914L1.05762 6.11914C1.30994 5.23728 2.12006 4.59098 3.08301 4.59082ZM3.08301 5.75098C2.55962 5.75117 2.13512 6.17587 2.13477 6.69922C2.13477 7.22287 2.5594 7.64824 3.08301 7.64844C3.60665 7.64828 4.03223 7.2229 4.03223 6.69922C4.03187 6.17585 3.60643 5.75113 3.08301 5.75098ZM5.19238 6.69922C5.19238 6.763 5.18816 6.82633 5.18262 6.88867C5.18846 6.82629 5.19238 6.76313 5.19238 6.69922C5.19236 6.63495 5.18853 6.57152 5.18262 6.50879C5.18826 6.57154 5.19236 6.635 5.19238 6.69922ZM0.982422 6.52344C0.977382 6.58136 0.97463 6.63999 0.974609 6.69922C0.974609 6.75775 0.977496 6.81579 0.982422 6.87305C0.977758 6.81579 0.974609 6.75767 0.974609 6.69922C0.974628 6.64 0.977618 6.58142 0.982422 6.52344ZM10.3232 0C11.2869 0 12.0986 0.646596 12.3506 1.5293L13.415 1.5293L13.415 2.68945L12.3496 2.68945C12.363 2.64266 12.3754 2.59488 12.3857 2.54688C12.1838 3.50118 11.3376 4.21777 10.3232 4.21777C9.36037 4.21756 8.55018 3.57139 8.29785 2.68945L0 2.68945L0 1.5293L8.29688 1.5293C8.5487 0.646717 9.35981 0.00021854 10.3232 0ZM10.3232 1.16016C9.79984 1.16042 9.37524 1.58499 9.375 2.1084C9.375 2.63201 9.79969 3.05735 10.3232 3.05762C10.847 3.05762 11.2725 2.63217 11.2725 2.1084C11.2722 1.58483 10.8469 1.16016 10.3232 1.16016ZM12.4229 2.29883C12.4287 2.23641 12.4326 2.17331 12.4326 2.10938C12.4326 2.17327 12.4284 2.23638 12.4229 2.29883ZM8.21484 2.10938L8.21484 2.1084L8.21484 2.10938ZM8.22266 1.93359C8.21785 1.98897 8.21506 2.04499 8.21484 2.10156C8.21503 2.04501 8.2181 1.98902 8.22266 1.93359ZM8.22266 11.1162C8.2179 11.1713 8.21507 11.227 8.21484 11.2832C8.21504 11.227 8.21814 11.1713 8.22266 11.1162Z" fill="currentColor" />
  </svg>
)
const ICON_ADD = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path transform="translate(9.52 2.52)" d="M3.55246 0L3.55246 2.44252L6 2.44252L6 3.55748L3.55246 3.55748L3.55246 6L2.43834 6L2.43834 3.55748L0 3.55748L0 2.44252L2.43834 2.44252L2.43834 0L3.55246 0Z" fill="currentColor" />
    <path transform="translate(0.3496 2.35)" d="M4.76367 0C5.36861 1.80598e-05 5.93113 0.310294 6.25488 0.821289L6.78027 1.64941C6.79685 1.67558 6.81791 1.69775 6.83887 1.71973C6.72186 2.15521 6.65702 2.61192 6.65137 3.08301C6.25601 2.96045 5.90909 2.70478 5.68164 2.3457L5.15723 1.5166C5.07183 1.38189 4.92318 1.3008 4.76367 1.30078L2.32422 1.30078C1.7589 1.30078 1.30078 1.7589 1.30078 2.32422L1.30078 10.1338C1.30078 10.6991 1.7589 11.1572 2.32422 11.1572L11.9766 11.1572C12.5419 11.1572 13 10.6991 13 10.1338L13 8.58398C13.4545 8.5135 13.8903 8.38748 14.3008 8.21289L14.3008 10.1338C14.3008 11.4171 13.2598 12.458 11.9766 12.458L2.32422 12.458C1.04093 12.458 0 11.4171 0 10.1338L0 2.32422C0 1.04093 1.04093 0 2.32422 0L4.76367 0Z" fill="currentColor" />
  </svg>
)

function buildLayout(presetId: string, name: string): LayoutSpec {
  const def = PRESET_DEFS.find((d) => d.id === presetId) ?? PRESET_DEFS[0]
  const mk = (i: number): SplitPane => ({
    id: 'p' + (i + 1),
    title: '窗口' + (i + 1),
    min: 200,
    content: null,
  })
  const left = def.leftCount > 0 ? mk(0) : null
  const top = Array.from({ length: def.topCount }, (_, i) => mk(def.leftCount + i))
  const main = Array.from({ length: def.contentCount }, (_, i) => mk(def.leftCount + def.topCount + i))
  return {
    id: 'layout-' + Date.now().toString(36),
    title: name,
    left: left ?? null,
    top: top.length > 0 ? top : null,
    main,
    leftWidth: { default: 260, min: 160, max: 480 },
    chatWidth: { default: 360, min: 240, max: 600 },
    chatWidthRatio: (def as any).chatRatio,
    topHeight: { default: (def as any).topHeightDefault ?? 200, min: 120, max: 480 },
    topHeightRatio: (def as any).topHeightRatio ?? 0.35,
    chatSide: 'right',
    chatFullHeight: def.chatFull === true,
    chatHidden: (def as any).chatHidden === true,
    chatOnly: (def as any).chatOnly === true,
  }
}

/** 布局缩略图（迷你窗格示意；聊天窗蓝色 💬） */
function presetThumb(defId: string) {
  const cell = (chat: boolean, key: string) => (
    <span key={key} className={'dsh-wt_thumbCell' + (chat ? ' dsh-wt_thumbChat' : '')}>{chat ? '💬' : ''}</span>
  )
  if (defId === 'chat') {
    // 会话全屏：整块就是对话（💬 占满）
    return <span className="dsh-wt_thumb"><span className="dsh-wt_thumbRow">{cell(true, 'a')}</span></span>
  }
  if (defId === 'full') {
    // 全屏内容窗：单个窗格占满（无对话列）
    return <span className="dsh-wt_thumb"><span className="dsh-wt_thumbRow">{cell(false, 'a')}</span></span>
  }
  if (defId === '2h') {
    return <span className="dsh-wt_thumb"><span className="dsh-wt_thumbRow">{cell(false, 'a')}{cell(true, 'b')}</span></span>
  }
  if (defId === '3h') {
    return <span className="dsh-wt_thumb"><span className="dsh-wt_thumbRow">{cell(false, 'a')}{cell(false, 'b')}{cell(true, 'c')}</span></span>
  }
  if (defId === 'g4') {
    // 田字格：左侧 2×2 均分，右侧对话整列（5 视窗）
    return (
      <span className="dsh-wt_thumb dsh-wt_thumbCols">
        <span className="dsh-wt_thumbCol">
          <span className="dsh-wt_thumbRow">{cell(false, 'a')}{cell(false, 'b')}</span>
          <span className="dsh-wt_thumbRow">{cell(false, 'c')}{cell(false, 'd')}</span>
        </span>
        <span className="dsh-wt_thumbCol">{cell(true, 'e')}</span>
      </span>
    )
  }
  if (defId === 'l23') {
    // 上 2 下 3：左侧上排 2 窗 + 下排 3 窗，右侧对话整列（6 视窗）
    return (
      <span className="dsh-wt_thumb dsh-wt_thumbCols">
        <span className="dsh-wt_thumbCol">
          <span className="dsh-wt_thumbRow">{cell(false, 'a')}{cell(false, 'b')}</span>
          <span className="dsh-wt_thumbRow">{cell(false, 'c')}{cell(false, 'd')}{cell(false, 'e')}</span>
        </span>
        <span className="dsh-wt_thumbCol">{cell(true, 'f')}</span>
      </span>
    )
  }
  if (defId === 'l13') {
    // 左列上 1 大 + 下 3 小；右列对话整列（5 视窗）
    return (
      <span className="dsh-wt_thumb dsh-wt_thumbCols">
        <span className="dsh-wt_thumbCol">
          <span className="dsh-wt_thumbRow">{cell(false, 'a')}</span>
          <span className="dsh-wt_thumbRow">{cell(false, 'b')}{cell(false, 'c')}{cell(false, 'd')}</span>
        </span>
        <span className="dsh-wt_thumbCol">{cell(true, 'e')}</span>
      </span>
    )
  }
  if (defId === 'grid') {
    return (
      <span className="dsh-wt_thumb">
        <span className="dsh-wt_thumbRow">{cell(false, 'a')}{cell(false, 'b')}</span>
        <span className="dsh-wt_thumbRow">{cell(false, 'c')}{cell(true, 'd')}</span>
      </span>
    )
  }
  if (defId === 'l2') {
    // 左二右一：左侧上下两个内容窗，右侧整列对话（💬）
    return (
      <span className="dsh-wt_thumb dsh-wt_thumbCols">
        <span className="dsh-wt_thumbCol">
          <span className="dsh-wt_thumbRow">{cell(false, 'a')}</span>
          <span className="dsh-wt_thumbRow">{cell(false, 'b')}</span>
        </span>
        <span className="dsh-wt_thumbCol">{cell(true, 'c')}</span>
      </span>
    )
  }
  return (
    <span className="dsh-wt_thumb dsh-wt_thumbCols">
      <span className="dsh-wt_thumbCol">
        <span className="dsh-wt_thumbRow">{cell(false, 'a')}</span>
        <span className="dsh-wt_thumbRow">{cell(false, 'b')}{cell(false, 'c')}</span>
      </span>
      <span className="dsh-wt_thumbCol">{cell(true, 'd')}</span>
    </span>
  )
}

const DEFAULT_VIEW: ViewState = {
  query: '',
  searchOpen: false,
  orderBy: 'manual',
  dock: 'footer',
  floatTop: null,
}

const DEFAULT_PROJECTS: ProjectsState = {
  order: [],
  lastUsed: {},
  hidden: [],
  nameOverrides: {},
  iconOverrides: {},
  removed: [],
  views: {},
  shortcuts: [],
  layouts: [],
  bindings: {},
  folders: {},
  flows: {},
  briefs: {},
}

/** HSL 归一化：色相映射到 -180..180（0 = 中性/中间），饱和/明度只接受 0..200 数值；非法返回 undefined */
function normHsl(v: any): { h: number; s: number; l: number } | undefined {
  if (!v || typeof v.h !== 'number' || typeof v.s !== 'number' || typeof v.l !== 'number') return undefined
  const h = ((Math.round(v.h) % 360) + 360) % 360
  return {
    h: h > 180 ? h - 360 : h,
    s: Math.min(Math.max(Math.round(v.s), 0), 200),
    l: Math.min(Math.max(Math.round(v.l), 0), 200),
  }
}

// ── 控制室列数：按设备独立（电脑 5 列 / 手机 2 列互不影响）──
// 列数是设备本地偏好，不参与跨端同步；view.consoleCols 只作为旧存档迁移来源。
const IS_MOBILE_DEVICE = typeof navigator !== 'undefined'
  && /Android|iPhone|iPod|iPad|Mobile|Windows Phone/i.test(navigator.userAgent)
const CONSOLE_COLS_KEY = 'dsh-assistant.consoleCols.' + (IS_MOBILE_DEVICE ? 'mobile' : 'desktop')
function readConsoleColsLocal(): number | null {
  try {
    const raw = localStorage.getItem(CONSOLE_COLS_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n) : null
  } catch { return null }
}
function writeConsoleColsLocal(n: number): void {
  try { localStorage.setItem(CONSOLE_COLS_KEY, String(Math.max(0, Math.min(5, Math.round(n))))) } catch {}
}
/** 跨端同步的视图：剔除只属于本机的列数 */
function viewForSync(v: any): any {
  const out = { ...(v ?? {}) }
  delete out.consoleCols
  return out
}

/** 同步状态签名：内容等价就不再推（采纳另一端的改动后原样推回去 = 两端互推死循环） */
function stateSigOf(projects: any, view: any): string {
  try { return JSON.stringify([projects, view]) } catch { return '' }
}

function loadView(): ViewState {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return { ...DEFAULT_VIEW }
    const p = JSON.parse(raw)
    // 显式挑字段：旧版遗留的 groupBy 等未知字段直接忽略。
    // 一次性迁移：v2 起默认「手动」排序（最近排序点击即置顶、体验差），旧存「最近」回落为「手动」；
    // 之后用户手动选择「最近」会写入 sortMigratedV2 标记并被尊重。
    const orderBy = p.sortMigratedV2 === true
      ? (p.orderBy === 'recent' ? 'recent' : 'manual')
      : 'manual'
    return {
      query: typeof p.query === 'string' ? p.query : '',
      searchOpen: p.searchOpen === true,
      orderBy,
      dock: p.dock === 'float' ? 'float' : 'footer',
      floatTop: typeof p.floatTop === 'number' ? p.floatTop : null,
      consoleTheme: p.consoleTheme === 'dark' || p.consoleTheme === 'light' || p.consoleTheme === 'system' ? p.consoleTheme : 'system',
      consoleCols: typeof p.consoleCols === 'number' && p.consoleCols >= 0 && p.consoleCols <= 5 ? Math.round(p.consoleCols) : 0,
      consoleShape: p.consoleShape === 'circle' ? 'circle' : 'square',
      consoleBg: p.consoleBg === 'plain' || p.consoleBg === 'photo' ? p.consoleBg : 'glow',
      consoleBgPlainHsl: normHsl(p.consoleBgPlainHsl),
      consoleBgGlowHsl: normHsl(p.consoleBgGlowHsl),
      consoleBgPhotoId: typeof p.consoleBgPhotoId === 'string' && p.consoleBgPhotoId ? p.consoleBgPhotoId : undefined,
      consoleBgPhotoGrid: p.consoleBgPhotoGrid !== false,
      consoleBgGridOpacity: typeof p.consoleBgGridOpacity === 'number' && p.consoleBgGridOpacity >= 0 && p.consoleBgGridOpacity <= 30 ? Math.round(p.consoleBgGridOpacity) : undefined,
      consoleCardBlur: typeof p.consoleCardBlur === 'number' && p.consoleCardBlur >= 0 && p.consoleCardBlur <= 20 ? Math.round(p.consoleCardBlur) : undefined,
      consoleBgPlainBlur: typeof p.consoleBgPlainBlur === 'number' && p.consoleBgPlainBlur >= 0 && p.consoleBgPlainBlur <= 20 ? Math.round(p.consoleBgPlainBlur) : undefined,
      consoleBgGlowBlur: typeof p.consoleBgGlowBlur === 'number' && p.consoleBgGlowBlur >= 0 && p.consoleBgGlowBlur <= 20 ? Math.round(p.consoleBgGlowBlur) : undefined,
      consoleBgPlainGrid: typeof p.consoleBgPlainGrid === 'number' && p.consoleBgPlainGrid >= 0 && p.consoleBgPlainGrid <= 30 ? Math.round(p.consoleBgPlainGrid) : undefined,
      consoleBgGlowGrid: typeof p.consoleBgGlowGrid === 'number' && p.consoleBgGlowGrid >= 0 && p.consoleBgGlowGrid <= 30 ? Math.round(p.consoleBgGlowGrid) : undefined,
      consoleGlowSpeed: typeof p.consoleGlowSpeed === 'number' && p.consoleGlowSpeed >= 0 && p.consoleGlowSpeed <= 100 ? Math.round(p.consoleGlowSpeed) : undefined,
      consoleBgPhotoHsls: (() => {
        const src = p.consoleBgPhotoHsls
        if (!src || typeof src !== 'object') return undefined
        const out: Record<string, { h: number; s: number; l: number }> = {}
        for (const k of Object.keys(src)) {
          const v = normHsl((src as any)[k])
          if (v) out[k] = v
        }
        return Object.keys(out).length > 0 ? out : undefined
      })(),
    }
  } catch {
    return { ...DEFAULT_VIEW }
  }
}

function loadProjects(): ProjectsState {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY)
    if (!raw) return { ...DEFAULT_PROJECTS }
    const p = JSON.parse(raw)
    // 模板改版迁移：老实例的步骤 id / 起始步索引归一到当前模板（如 6「核心章节成稿」
    // +7「非核心章节成稿」合并为 6「初稿撰写」），避免老项目进度显示错位。
    let migrated = false
    const flows: Record<string, FlowRunState> = p.flows && typeof p.flows === 'object'
      ? Object.fromEntries(Object.entries(p.flows as Record<string, any>)
          .filter(([, r]) => r && typeof r.templateId === 'string' && Array.isArray(r.done))
          .map(([id, r]) => {
            const run = r as FlowRunState
            const next = migrateFlowRun(run)
            if (next !== run) migrated = true
            return [id, next]
          }))
      : {}
    const next: ProjectsState = {
      order: Array.isArray(p.order) ? p.order.filter((x: unknown): x is string => typeof x === 'string') : [],
      lastUsed: p.lastUsed && typeof p.lastUsed === 'object' ? p.lastUsed : {},
      hidden: Array.isArray(p.hidden) ? p.hidden.filter((x: unknown): x is string => typeof x === 'string') : [],
      nameOverrides: p.nameOverrides && typeof p.nameOverrides === 'object' ? p.nameOverrides : {},
      iconOverrides: p.iconOverrides && typeof p.iconOverrides === 'object' ? p.iconOverrides : {},
      removed: Array.isArray(p.removed) ? p.removed.filter((x: unknown): x is string => typeof x === 'string') : [],
      views: p.views && typeof p.views === 'object' ? p.views : {},
      shortcuts: Array.isArray(p.shortcuts)
        ? p.shortcuts.filter((s: any) => s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.href === 'string')
        : [],
      layouts: Array.isArray(p.layouts)
        ? p.layouts
            .filter((l: any) => l && typeof l.id === 'string' && typeof l.title === 'string' && Array.isArray(l.main))
            .map((l: any) => {
              // 左右布局（2h 拓扑：无左列/顶行、单内容窗、聊天不通高）旧存档补 chatWidthRatio：
              // 内容与聊天左右等分（与本版本起的新预设行为一致）；用户拖过聊天分隔线后仍按存档像素宽。
              if (!l.chatWidthRatio && !l.left && !(l.top && l.top.length) && l.main.length === 1 && l.chatFullHeight !== true) {
                migrated = true
                return { ...l, chatWidthRatio: 0.5 }
              }
              return l
            })
        : [],
      bindings: p.bindings && typeof p.bindings === 'object' ? p.bindings : {},
      folders: p.folders && typeof p.folders === 'object' ? p.folders : {},
      flows,
      briefs: p.briefs && typeof p.briefs === 'object' ? p.briefs : {},
    }
    // 墓碑过滤：删过的项目 id 永不复活——旧浏览器缓存、另一端的旧副本里常常还留着它，
    // 只靠「layouts 里没有」判断的话，任一端一同步就把它们并回来（这就是删不掉的真因）。
    next.layouts = next.layouts.filter((l) => !next.removed.includes(l.id))
    next.order = next.order.filter((id) => !next.removed.includes(id))
    next.hidden = next.hidden.filter((id) => !next.removed.includes(id))
    // 迁移一经发生即落盘：避免每次加载都重复换算（起始步索引的换算是非幂等的）
    if (migrated) {
      try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(next)) } catch {}
    }
    return next
  } catch {
    return { ...DEFAULT_PROJECTS }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** 合并「宿主状态」与「本机 localStorage」：
 *  - 项目清单以宿主为准（`/api/assistant/state` 是真值，一端删掉另一端才不会复生）；
 *  - removed（墓碑）取并集：任一端删过的 id 永远不再出现；
 *  - 绑定/文件夹/进度/改名：宿主优先，本机独有字段兜底补上（老数据不丢）；
 *  - 快捷方式取并集（纯本地条目）。
 *  早期版本对 layouts 取并集，后果：手机缓存里还留着已删项目时，一打开就把它们写回宿主，
 *  表现就是「删了很多次还是全部都出现」。现在改为宿主优先 + 墓碑。 */
function mergeProjects(server: any, local: any): any {
  const s = server && typeof server === 'object' ? server : {}
  const l = local && typeof local === 'object' ? local : {}
  const uniq = (a: any, b: any): string[] => Array.from(new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter((x) => typeof x === 'string')))
  const removed = uniq(s.removed, l.removed)
  // 宿主还没存过项目（首装/清空）时才用本机清单兜底；正常情况下一律以宿主为准
  const base = Array.isArray(s.layouts) && s.layouts.length > 0
    ? s.layouts
    : (Array.isArray(l.layouts) ? l.layouts : [])
  const layoutList: any[] = []
  const seen = new Set<string>()
  for (const x of base) {
    if (!x || typeof x.id !== 'string' || seen.has(x.id) || removed.includes(x.id)) continue
    seen.add(x.id)
    layoutList.push(x)
  }
  const ids = new Set(layoutList.map((x) => x.id))
  const order: string[] = []
  for (const id of [...(Array.isArray(s.order) ? s.order : []), ...(Array.isArray(l.order) ? l.order : [])]) {
    if (typeof id === 'string' && ids.has(id) && !order.includes(id)) order.push(id)
  }
  const mergeMap = (a: any, b: any): Record<string, any> => ({ ...(b && typeof b === 'object' ? b : {}), ...(a && typeof a === 'object' ? a : {}) })
  const shortcuts: any[] = []
  const scSeen = new Set<string>()
  for (const arr of [Array.isArray(s.shortcuts) ? s.shortcuts : [], Array.isArray(l.shortcuts) ? l.shortcuts : []]) {
    for (const x of arr) if (x && typeof x.id === 'string' && !scSeen.has(x.id)) { scSeen.add(x.id); shortcuts.push(x) }
  }
  return {
    order,
    lastUsed: mergeMap(s.lastUsed, l.lastUsed),
    hidden: uniq(s.hidden, l.hidden).filter((id) => !removed.includes(id)),
    nameOverrides: mergeMap(s.nameOverrides, l.nameOverrides),
    iconOverrides: mergeMap(s.iconOverrides, l.iconOverrides),
    removed,
    views: mergeMap(s.views, l.views),
    shortcuts,
    layouts: layoutList,
    bindings: mergeMap(s.bindings, l.bindings),
    folders: mergeMap(s.folders, l.folders),
    flows: mergeMap(s.flows, l.flows),
    briefs: mergeMap(s.briefs, l.briefs),
  }
}

/** 把状态推给宿主：带 baseRevision 做乐观并发。
 *  宿主 revision 比 base 新 = 另一端已经改过，返回 { conflict, state }，由调用方改成采纳宿主状态，
 *  不再用本机的旧清单盖掉它（另一端刚删完项目被旧页面盖回去，就是这么发生的）。 */
async function putRemoteState(projects: any, view: any, baseRevision: number): Promise<{ ok: boolean; conflict: boolean; state: any }> {
  const r = await fetch('/api/assistant/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projects, view, baseRevision }),
  })
  const d = await r.json().catch(() => null)
  if (r.status === 409) return { ok: false, conflict: true, state: d?.state ?? null }
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return { ok: true, conflict: false, state: d?.state ?? null }
}

type FloatRect = { top: number }

/** 从组件挂载点向上找 sidebar 容器：className 含 SidebarRoot/sidebar，或标签 aside/nav，到 body 为止。 */
function findSidebar(start: HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = start
  while (el && el !== document.body) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'aside' || tag === 'nav') return el
    if (typeof el.className === 'string' && /SidebarRoot|sidebar/i.test(el.className)) return el
    el = el.parentElement
  }
  return null
}

/** 子座位注册 id 序列（模块级 store；apply 里订阅 slots 变化写入）。 */
const registryStore: { ids: string[]; listeners: Set<() => void> } = { ids: [], listeners: new Set() }

/** 自定义窗口 → 宿主会话桥（apply 时注入；不可用时 CustomPane 降级提示）
 *  pendingInteractions：旧版宿主状态源（新版通过 clientCtx.get('uiSession').sessionStatus 读取） */
let sessionBridge: { sessions: any; conversation: any; list: any; workspaces: any; uiWorkspace: any; pendingInteractions: any } | null = null
/** 客户端根 ctx（apply 时保存；用于运行时探测 0.1.2 的 remote.directoryPicker 等新服务，不硬写 inject） */
let clientCtx: any = null
/** 悬浮球（pocketOrb）词典绑定：项目文件夹选择器复用的是悬浮球的路径浏览器，文案跟它走 */
let orbT: ((key: string, params?: Record<string, string>) => string) | null = null

/** 宿主 API 客户端（apply 时从 connection 服务取；agentPresets/sessions 用于修复新会话继承失效模型的 bug） */
let hostApi: { agentPresets?: any; sessions?: any } | null = null

/** 新会话显式应用「部署默认预设」：宿主新会话座位同款逻辑（api.agentPresets.select，仅对 blank 会话生效）。
 *  修复：用户删掉默认模型后，新建会话继承到失效预设，prompt 报 model-unavailable 导致窗口建不出来。 */
async function ensureSessionPreset(sessionId: string): Promise<void> {
  const api = hostApi?.agentPresets
  if (!api || typeof api.list !== 'function' || typeof api.select !== 'function') return
  try {
    const listRes = await api.list({})
    const presets = listRes?.result?.ok ? listRes?.result?.value?.presets : null
    if (!Array.isArray(presets) || presets.length === 0) return
    // 部署默认优先，若其本身也失效（如引用了被删的 provider），逐个尝试其余预设直到成功
    const ordered = [...presets]
    const defIdx = ordered.findIndex((p: any) => p?.isDefault)
    if (defIdx > 0) ordered.unshift(ordered.splice(defIdx, 1)[0])
    for (const preset of ordered) {
      const pid = preset?.id
      if (!pid) continue
      try {
        const selRes = await api.select({ sessionId, agentPreset: pid })
        if (selRes?.result?.ok) {
          try { sessionBridge?.sessions?.noteAgentPreset?.(sessionId, pid) } catch {}
          return
        }
        try { if (typeof console !== 'undefined' && console.warn) console.warn('[worktable] preset select failed:', pid, selRes?.result?.error?.message ?? '') } catch {}
      } catch (err) {
        try { if (typeof console !== 'undefined' && console.warn) console.warn('[worktable] preset select threw:', pid, String(err)) } catch {}
      }
    }
  } catch { /* 修复失败不阻断主流程，错误仍按原路径提示 */ }
}

/** 按「用户既有选择」在可用目录里找最贴近的模型（不擅自选）：
 *  1) id 完全一致；2) id/名称含基准模型的家族词（pro/max/mini/flash…）；3) 目录首个。 */
function pickInheritedModel(groups: any[], baseModel: string | undefined): { provider: string; model: string } | null {
  if (!Array.isArray(groups) || groups.length === 0) return null
  const flat: { provider: string; model: string; name: string }[] = []
  for (const g of groups) {
    if (!g?.id || !Array.isArray(g.models)) continue
    for (const m of g.models) if (m?.id) flat.push({ provider: g.id, model: m.id, name: String(m.name ?? '') })
  }
  if (flat.length === 0) return null
  const base = String(baseModel ?? '').toLowerCase()
  if (base) {
    const exact = flat.find((f) => f.model.toLowerCase() === base)
    if (exact) return { provider: exact.provider, model: exact.model }
    const tokens = base.split(/[-_.]/).filter((t) => t && (/^(pro|max|mini|flash|lite|ultra|plus|sonnet|opus|haiku|turbo)$/i.test(t) || t.length >= 4))
    for (const tok of tokens) {
      const hit = flat.find((f) => f.model.toLowerCase().includes(tok) || f.name.toLowerCase().includes(tok))
      if (hit) return { provider: hit.provider, model: hit.model }
    }
  }
  return { provider: flat[0].provider, model: flat[0].model }
}

/** 新会话模型选择修复（真正的根因修复）：当前选择指向已删 provider（routable=false）时，
 *  不擅自选模型——① 优先继承用户当前会话正在用的模型；② 兜底按失效选择里的模型家族词
 *  找同款；③ 最后才目录首个。session.selectModel 同时把新选择存为默认，顺带修复后续新会话。 */
async function ensureSessionModel(sessionId: string): Promise<void> {
  const api = hostApi?.sessions
  if (!api || typeof api.models !== 'function' || typeof api.selectModel !== 'function') return
  try {
    const mRes = await api.models({ sessionId })
    if (!mRes?.result?.ok) return
    const val = mRes.result.value
    const groups = val?.groups
    let target: { provider: string; model: string } | null = null
    let effort: string | undefined
    // ① 无条件继承用户当前会话的选择（用户正在用哪个模型，新会话就用哪个）
    try {
      const cur = currentSessionId()
      if (cur && cur !== sessionId) {
        const cRes = await api.models({ sessionId: cur })
        if (cRes?.result?.ok) {
          const cval = cRes.result.value
          if (cval?.routable === true && cval?.current?.provider && cval?.current?.model) {
            const same = val?.current?.provider === cval.current.provider && val?.current?.model === cval.current.model
            if (!same) {
              target = { provider: cval.current.provider, model: cval.current.model }
              effort = typeof cval.current.reasoningEffort === 'string' ? cval.current.reasoningEffort : undefined
            }
          }
        }
      }
    } catch {}
    // ② 无当前会话且新会话选择不可用 → 最近会话众数（用户习惯）
    if (!target && val?.routable !== true) {
      try {
        const snap = sessionBridge?.list?.getSnapshot?.()
        const byId: Record<string, any> = snap?.byId ?? {}
        const ids: string[] = (snap?.ids ?? []).filter((x: string) => x !== sessionId)
        const scored: { key: string; provider: string; model: string; effort?: string; count: number }[] = []
        await Promise.all(ids.slice(0, 6).map(async (sid) => {
          const row = byId[sid]
          if (row?.blank === true) return
          try {
            const r2 = await api.models({ sessionId: sid })
            if (!r2?.result?.ok) return
            const cv = r2.result.value
            if (cv?.routable !== true || !cv?.current?.provider || !cv?.current?.model) return
            const key = cv.current.provider + '|' + cv.current.model
            const found = scored.find((s) => s.key === key)
            if (found) found.count++
            else scored.push({ key, provider: cv.current.provider, model: cv.current.model, effort: typeof cv.current.reasoningEffort === 'string' ? cv.current.reasoningEffort : undefined, count: 1 })
          } catch {}
        }))
        scored.sort((a, b) => b.count - a.count)
        if (scored[0]) {
          target = { provider: scored[0].provider, model: scored[0].model }
          effort = scored[0].effort
        }
      } catch {}
    }
    // ③/④ 兜底（仅当新会话选择不可用）：家族词 → 目录首个
    if (!target && val?.routable !== true) target = pickInheritedModel(groups, val?.current?.model)
    if (!target) return
    await api.selectModel({ sessionId, provider: target.provider, model: target.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) })
  } catch { /* 修复失败不阻断主流程，错误仍按原路径提示 */ }
}

/** 控制室（工作台自己）项目：固定 id、固定排项目列表第一位、不可删除 */
const CONSOLE_ID = 'wt-console'
const CONSOLE_ICON = '🖥️'

/** 私人助手卡片：助手目录（~/.dsh/assistant）在控制室里的一张**普通项目卡**——
 *  和别的卡一样有状态灯 / 实时进度 / 会话列表 / ＋新建；不塞进「正在运行」临时卡片。
 *  id 固定：删除后写进 removed 墓碑，跨端同步，且不再自动重建。见 assistant-card.ts。 */

/** 临时项目卡片「正在运行」：收纳不属于任何项目文件夹的会话（不写入项目状态，随会话出现/消失）。
 *  名称按用户指定使用「正在运行」。 */
const RUNNING_CARD_NAME = '正在运行'
const RUNNING_CARD_ICON = '⚡'
/** 已结束会话在临时卡片上**一直保留到手动「收工」**。
 *  下面两个窗口不是保留期，只是没有观察到「跑 → 停」时，用提示词时间判断是否首次收纳的兜底窗口。 */
const TRANSIENT_DONE_FALLBACK_MS = 30 * 60 * 1000
const TRANSIENT_ERROR_FALLBACK_MS = 12 * 60 * 60 * 1000
const TRANSIENT_DISMISS_KEY = 'dsh.assistant.transientDismissed.v1'

/** 临时卡片的一行（getConsoleCards 每次从宿主会话快照实时组装） */
type TransientRow = {
  id: string
  title: string
  cwd: string
  updatedAt: number
  /** 正在运行（含子代理在跑） */
  running: boolean
  /** 停在等用户决策 */
  awaiting: boolean
  /** 已完成（宿主 completed 位 / 会话面兜底） */
  done: boolean
  /** 异常终止（会话面 lastAgentError，沿用项目卡片的持久化标记） */
  error: boolean
  /** 已结束且不在运行/待决（一直保留到手动「收工」） */
  finished: boolean
}

/** 控制室布局是否健全：主窗格首格存在 console 类型标签（旧版关标签的坏存档没有它） */
function specHasConsoleTab(spec: LayoutSpec | undefined): boolean {
  return !!spec?.main?.[0]?.tabs?.some((t) => t.content?.kind === 'builtin' && t.content.type === 'console')
}

/** 控制室默认布局：单一锁死大窗格（项目卡片网格）+ 右侧对话 */
function buildConsoleSpec(t: (key: string) => string): LayoutSpec {
  return {
    id: CONSOLE_ID,
    title: t('console.name'),
    icon: CONSOLE_ICON,
    top: null,
    main: [{
      id: 'console',
      title: '控制室',
      min: 240,
      tabs: [{ id: 'c1', title: '控制室', content: { kind: 'builtin', type: 'console' } }],
      active: 0,
    }],
    chatWidth: { default: 340, min: 280, max: 600 },
    topHeight: { default: 200, min: 120, max: 480 },
    chatSide: 'right',
  }
}

/** 控制室面板刷新总线（项目/会话快照变化时推送，ConsolePane 订阅重渲染） */
const consoleListeners = new Set<() => void>()
const notifyConsole = () => consoleListeners.forEach((l) => { try { l() } catch {} })
/** 模板流程窗格订阅（flow Listeners）：projects 变化时 notifyFlow 通知面板刷新 */
const flowListeners = new Set<() => void>()
const notifyFlow = () => flowListeners.forEach((l) => { try { l() } catch {} })

/**
 * 「一批宿主通知只做一次」的合并闸门。
 * 生产里有多个 WorktableSection 实例（侧栏工作台 + headless 数据宿主 + 分栏浮层）同时订阅同一份
 * 宿主快照：原来每个实例的监听各自都会 notifyConsole/notifyFlow + 扫一遍游离会话生命周期 +
 * 排一次冷预览清扫 + 催一遍验收环 —— 一次宿主事件 = 实例数的 3–4 倍重复活。
 * 宿主通知的回调是同步跑的，所以用微任务把同一批并成一次（微任务比动画帧更早，卡片仍在同一帧里刷新）。
 * 显式的 notifyConsole() 调用点（改动完了要立刻见到）一律保持同步，不动这条。
 */
let notifyBusQueued = false
const queueNotifyBus = (): void => {
  if (notifyBusQueued) return
  notifyBusQueued = true
  queueMicrotask(() => {
    notifyBusQueued = false
    notifyConsole()
    notifyFlow()
  })
}
/**
 * 同一批通知里的共享扫描按「任务名」合并：多个工作台实例订阅的是同一份宿主快照，
 * 原来每个实例都各扫一遍（生命周期全表扫 / 冷预览清扫）。同名任务一批只跑一次，
 * 不同名任务互不影响（谁也不被谁吃掉）。
 */
const sharedTaskPending = new Set<string>()
const sharedTaskQueue: Array<{ key: string; run: () => void }> = []
let sharedTaskFlushArmed = false
const queueSharedTask = (key: string, run: () => void): void => {
  if (sharedTaskPending.has(key)) return
  sharedTaskPending.add(key)
  sharedTaskQueue.push({ key, run })
  if (sharedTaskFlushArmed) return
  sharedTaskFlushArmed = true
  queueMicrotask(() => {
    sharedTaskFlushArmed = false
    const batch = sharedTaskQueue.splice(0, sharedTaskQueue.length)
    sharedTaskPending.clear()
    for (const task of batch) { try { task.run() } catch { /* 共享扫描炸了不能把通知链带崩 */ } }
  })
}

/** 宿主工作区列表（分组选择数据源；读 ctx.workspaces 快照） */
function listWorkspaces(): { id: string; title: string; path: string }[] {
  try {
    const snap = sessionBridge?.workspaces?.list?.getSnapshot?.()
    const items = snap?.items ?? []
    return items.map((w: any) => ({
      id: w.workspaceId ?? w.id,
      title: w.title ?? '',
      path: w.path ?? '',
    }))
  } catch { return [] }
}

/** 预览文本清洗：去掉围栏代码块（```…```，含 dsh-ui 等）与行内代码，压缩空白；
 *  代码为主的片段会被滤空 → 调用方回退到更早的消息。只清洗显示用副本，不改原文。 */
function cleanPreviewText(raw: string): string {
  let s = String(raw ?? '')
  s = s.replace(/```[a-zA-Z0-9_+-]*[\s\S]*?```/g, ' ')
  s = s.replace(/```[a-zA-Z0-9_+-]*[\s\S]*$/g, ' ')
  s = s.replace(/`[^`\n]{1,200}`/g, ' ')
  s = s.replace(/```/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/** 冷会话最近消息缓存与预热：宿主 history 只读通道（face.history 为运行期内建方法，非公开接口，
 *  只读侦察确认可用；拉取是带宽成本不是 Token 成本，模型不参与）。 */
const previewCache = new Map<string, string>()
const previewKeyCache = new Map<string, string>()
const previewFetching = new Set<string>()
let previewSweepBusy = false
let previewTimer: number | null = null

/** 从 history 事件流尾部提取最近一条成品消息文本（优先 text 块；清洗代码后仍太短则回退更早消息） */
async function coldPreviewOf(face: any): Promise<string> {
  if (!face || typeof face.history !== 'function') return ''
  const r1 = await face.history({ maxMessages: 6 })
  const evs = historyEventsOf(r1)
  if (evs.length === 0) return ''
  const textOf = (blocks: any): string => {
    let fallback = ''
    if (!Array.isArray(blocks)) return ''
    for (const b of blocks) {
      const s = typeof b?.text === 'string' ? b.text.trim() : ''
      if (!s) continue
      if (b?.type === 'text') return s
      if (!fallback) fallback = s
    }
    return fallback
  }
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i]
    if (!ev) continue
    const d = ev.data ?? {}
    let raw = ''
    if (ev.type === 'user/message') raw = textOf(d.content ?? d.blocks)
    else if (ev.type === 'assistant/message') { const m = d.message ?? d; raw = textOf(m.content ?? m.blocks) }
    if (!raw) continue
    const clean = cleanPreviewText(raw)
    if (clean.length >= 8) return clean.slice(0, 220)
  }
  return ''
}

/** 预热所有已绑定会话的最近消息（逐个只读拉取；已在拉/已拉过未完成的跳过，失败静默回退内存路径） */
async function sweepPreviews() {
  if (previewSweepBusy) return
  previewSweepBusy = true
  let changed = false
  try {
    const sids = Array.from(new Set([
      ...Object.values(projectBindingsRef.current),
      ...transientTrackedIdsRef.current,
    ].filter((x): x is string => typeof x === 'string' && !!x)))
    for (const sid of sids) {
      const row = sessionsSnapshotStore.snapshot?.byId?.[sid]
      const key = activityKeyOf(sid) + ':' + String(!!row?.running) + ':' + String(!!row?.completed)
      // 同一会话同一运行阶段只预热一次；开新轮/跑完仍会重新读取最终文本。
      if (previewKeyCache.get(sid) === key || previewFetching.has(sid)) continue
      previewFetching.add(sid)
      try {
        const face = sessionBridge?.sessions?.binding?.(sid)?.session
        const txt = await coldPreviewOf(face)
        previewKeyCache.set(sid, key)
        if (previewCache.get(sid) !== txt) { previewCache.set(sid, txt); changed = true }
      } catch {} finally { previewFetching.delete(sid) }
    }
  } finally {
    previewSweepBusy = false
    if (changed) notifyConsole()
  }
}

/** 防抖调度：控制室开着且会话快照变化时刷新预览（合并 6s 内的连续变化） */
function schedulePreviewSweep() {
  if (previewTimer != null) return
  previewTimer = window.setTimeout(() => { previewTimer = null; sweepPreviews() }, 6000)
}

/** 从会话快照节点里提取最近一条文本（纯读内存镜像，零 Token；代码清洗后无则 ''） */
function lastTextOf(sid: string): string {
  try {
    const face = sessionFaceSnapshotOf(sid)
    const nodes: any[] = face?.nodes ?? []
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      const blocks = Array.isArray(n?.blocks) ? n.blocks : (Array.isArray(n?.content) ? n.content : [])
      let raw = ''
      for (const b of blocks) {
        const s = typeof b?.text === 'string' ? b.text.trim() : ''
        if (!s) continue
        if (b?.type === 'text') { raw = s; break }
        if (!raw) raw = s
      }
      if (!raw) continue
      const clean = cleanPreviewText(raw)
      if (clean.length >= 8) return clean.slice(0, 220)
    }
  } catch {}
  return ''
}

// ── 控制室卡片「最新进度」：优先显示最后一条工具调用（运行命令 / 读取 / 编辑…），
//    没有工具调用时退回落款文本。卡片每秒重渲染，所以运行中的会话会持续刷新（流式）。 ──
const TOOL_LABEL: Record<string, string> = {
  bash: '运行命令', pwsh: '运行命令', shell: '运行命令',
  read: '读取', write: '写入', edit: '编辑', patch: '编辑',
  grep: '搜索', glob: '查找', search: '搜索',
  web_search: '搜索网页', web_fetch: '抓取网页',
  subagent: '子代理', task: '子任务', workflow: '运行工作流',
  inspectPlugins: '检查插件', queryRuntime: '查询运行时',
}
const TOOL_ARG_KEYS: Record<string, string[]> = {
  bash: ['description', 'command'], pwsh: ['description', 'command'], shell: ['description', 'command'],
  read: ['path', 'file_path', 'url'], write: ['path', 'file_path'], edit: ['path', 'file_path'], patch: ['path', 'file_path'],
  grep: ['pattern', 'query'], glob: ['pattern', 'query'], search: ['query', 'pattern'],
  web_search: ['query'], web_fetch: ['url'],
}

function firstLineOf(text: string): string {
  const s = String(text ?? '')
  const i = s.indexOf('\n')
  return (i < 0 ? s : s.slice(0, i)).trim()
}

/** 从 argsRaw 里取最有信息量的一行（description / command / path / query…）
 *  流式工具调用只有**半截 JSON**（参数还没生成完），解析失败时按字段名抠出已到达的部分，
 *  否则卡片上会出现 `{"path":"src/cli…` 这种原始碎片。 */
/** 流式工具调用只有半截 JSON：按这些字段名抠出已到达的部分（正则一次编译，不是每键重新编译） */
const TOOL_ARG_FALLBACK_KEYS = [ 'description', 'path', 'file_path', 'command', 'pattern', 'query', 'url' ]
const TOOL_ARG_FALLBACK_RES = TOOL_ARG_FALLBACK_KEYS.map((key) => new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`, 's'))

function summarizeToolArgs(name: string, argsRaw: string): string {
  const raw = String(argsRaw ?? '').trim()
  if (!raw) return ''
  let args: any = null
  try { args = JSON.parse(raw) } catch {
    for (let i = 0; i < TOOL_ARG_FALLBACK_RES.length; i++) {
      const m = raw.match(TOOL_ARG_FALLBACK_RES[i])
      if (m?.[1]) {
        let value = m[1]
        try { value = JSON.parse(`"${value}"`) } catch { /* 半截转义按原文 */ }
        const clean = cleanPreviewText(firstLineOf(value)).slice(0, 120)
        if (clean) return clean
      }
    }
    return ''
  }
  if (!args || typeof args !== 'object') return ''
  const keys = TOOL_ARG_KEYS[name] ?? []
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return cleanPreviewText(firstLineOf(v)).slice(0, 120)
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) return cleanPreviewText(firstLineOf(v)).slice(0, 120)
  }
  return ''
}

/** 一个 tool-call 节点/块 → 「运行命令 · xxx」；不是工具调用返回 '' */
function toolLineOf(input: any): string {
  if (!input || typeof input !== 'object') return ''
  const root = input.kind === 'tool-call' ? (input.data?.root ?? input.data ?? input) : input
  if (!root || typeof root !== 'object') return ''
  const isTool = input.kind === 'tool-call' || input.type === 'tool-call'
    || root.kind === 'tool-call' || root.type === 'tool-call' || !!root.call || typeof root.argsRaw === 'string'
    || typeof root.arguments === 'string'
  if (!isTool) return ''
  const name = String(root.call?.name ?? root.name ?? input.toolName ?? input.data?.toolName ?? input.data?.name ?? '').trim()
  // 会话事件里的工具块用 arguments（JSON 字符串）；节点投影里可能是 call.argsRaw / args / argsRaw
  const argsRaw = typeof root.call?.argsRaw === 'string'
    ? root.call.argsRaw
    : typeof root.call?.arguments === 'string'
      ? root.call.arguments
      : typeof root.argsRaw === 'string'
        ? root.argsRaw
        : typeof root.arguments === 'string'
          ? root.arguments
          : typeof root.args === 'string' ? root.args : ''
  const summary = summarizeToolArgs(name, argsRaw)
  const label = TOOL_LABEL[name] ?? (name ? '工具调用' : '')
  if (!label) return ''
  return summary ? `${label} · ${summary}` : label
}

/** 会话快照里一个节点的内容块：assistant-step 节点把块放在 data.blocks（兼容 data.message.content / 平铺 blocks、content） */
function blocksOf(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  for (const candidate of [
    node.data?.blocks,
    node.data?.message?.content,
    node.data?.content,
    node.blocks,
    node.message?.content,
    node.content,
  ]) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

/** 取最后一行非空文本（思考块流式输出时，最新的一行就是「此刻在想什么」） */
function lastLineOf(text: string): string {
  const lines = String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

/** 一个内容块 → 卡片进度行：工具调用 > 思考 > 正文；不是可展示内容返回 '' */
function blockLineOf(block: any): string {
  const tool = toolLineOf(block)
  if (tool) return tool
  const text = typeof block?.text === 'string' ? block.text.trim() : ''
  if (!text) return ''
  const kind = String(block?.kind ?? block?.type ?? '')
  // 思考块与聊天面板同文案（「思考 · …」），取第一行 = 这一块思考在讲什么
  if (kind === 'reasoning' || kind === 'thinking') {
    const clean = cleanPreviewText(firstLineOf(text))
    return clean.length >= 2 ? ('思考 · ' + clean.slice(0, 200)) : ''
  }
  const clean = cleanPreviewText(firstLineOf(text))
  return clean.length >= 2 ? clean.slice(0, 220) : ''
}

/** 取会话面。同步渲染默认只读已有 binding，绝不能为了画卡片把冷 Agent 拉起；
 *  只有异步、运行中的历史兜底才显式允许 retain。 */
function sessionFaceOf(sid: string, allowRetain = false): any | null {
  try {
    const sessions = sessionBridge?.sessions as any
    const direct = sessions?.binding?.(sid)?.session
    if (direct || !allowRetain) return direct ?? null
    if (typeof sessions?.retainAgentScope === 'function') {
      try { sessions.retainAgentScope(sid) } catch {}
      return sessions?.binding?.(sid)?.session ?? null
    }
  } catch {}
  return null
}

/** 卡片中间显示的「最新一条进度」：正在流式的这一轮（partial）优先，其次最后一条已落定节点；
 *  每块按「工具调用 > 思考 > 正文」取，保持与聊天面板一致（思考显示成「思考 · …」）。 */
function latestActivityOf(sid: string): string {
  // 0) 会话事件窗口（最准：与聊天面板同一份数据，正在逐字输出的那一轮也在里面）
  try {
    const fromEntries = activityFromSessionEntries(sessionEntriesOf(sid))
    if (fromEntries) return fromEntries
  } catch {}
  try {
    const face = sessionFaceOf(sid)?.getSnapshot?.()
    if (!face) return ''
    // 1) 流式中的这一轮：思考/正文还没进 nodes，只有 partial 里有
    const partialBlocks = Array.isArray(face.partial?.blocks) ? face.partial.blocks : []
    for (let j = partialBlocks.length - 1; j >= 0; j--) {
      const line = blockLineOf(partialBlocks[j])
      if (line) return line
    }
    // 2) 已落定的节点：从最后一条往前找
    const rawNodes = face.nodes
    const nodes: any[] = Array.isArray(rawNodes)
      ? rawNodes
      : rawNodes && typeof rawNodes.values === 'function' ? Array.from(rawNodes.values()) : []
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      const direct = toolLineOf(n)
      if (direct) return direct
      const blocks = blocksOf(n)
      for (let j = blocks.length - 1; j >= 0; j--) {
        const line = blockLineOf(blocks[j])
        if (line) return line
      }
    }
  } catch {}
  return ''
}

/** 控制室卡片「最新进度」缓存：会话 id → { 行, 版本, 是否运行中 }。
 *  数据来自宿主会话日志（follow 只读、零 Token、不激活 Agent）。
 *  缓存**按日志版本**（会话快照的 updatedAt）而不是按时间失效：同一份日志在任何一台设备上
 *  都只有同一个版本，手机与电脑因此取到同一行；版本过了没重抓就不显示旧行（宁缺不旧）。 */
type ActivityEntry = { line: string; key: string; running: boolean }
const activityCache = new Map<string, ActivityEntry>()
/** 进度抓取是否在途（1.2s 轮询的并发闸门，避免 RPC 叠加） */
let activitySweepBusy = false

/** 会话「轮次版本」：宿主列表里的 updatedAt 只在新提示词时前进（= 开新一轮）。
 *  它变过 = 卡片这一行可能过期；手机与电脑看到的是同一个宿主值，所以两端判断一致。
 *  运行/结束的切换由旁边的 running 位单独判（宿主 running 位比 updatedAt 更灵敏）。 */
function activityKeyOf(sid: string): string {
  try {
    const e: any = sessionsSnapshotStore.snapshot?.byId?.[sid]
    return String(Number(e?.updatedAt) || 0)
  } catch { return '0' }
}

function toolLineFromEvent(name: string, argsRaw: string): string {
  const label = TOOL_LABEL[name] ?? (name ? '工具调用' : '')
  if (!label) return ''
  const summary = summarizeToolArgs(name, argsRaw)
  return summary ? `${label} · ${summary}` : label
}

/** 把 face.history() 的返回值拉平成事件数组：各版本分别返回
 *  { result: { value: { events } } } / { value: { records } } / { events } / 直接数组……
 *  旧代码只认第一种，一旦形状不符就永远取不到活动，卡片只能显示「正在执行…」。
 *  这里按「events / records / items 数组」做一次浅层 BFS，形状怎么变都能拿到。 */
function historyEventsOf(result: any): any[] {
  const flatten = (list: any[]): any[] => {
    const out: any[] = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      if (Array.isArray(entry.events)) out.push(...entry.events)
      else if (entry.event && typeof entry.event === 'object') out.push(entry.event)
      else out.push(entry)
    }
    return out
  }
  const seen = new Set<any>()
  let level: any[] = [result]
  for (let depth = 0; depth < 4 && level.length > 0; depth++) {
    const next: any[] = []
    for (const node of level) {
      if (!node || typeof node !== 'object' || seen.has(node)) continue
      seen.add(node)
      for (const key of ['events', 'records', 'items']) {
        const value = (node as any)[key]
        if (Array.isArray(value)) return flatten(value)
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') next.push(value)
      }
    }
    level = next
  }
  return []
}

/** 从事件列表（倒序找）提取最新一条进度：工具调用 > 思考 > 正文。 */
function activityFromEvents(evs: any[]): string {
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i]
    const type = String(ev?.type ?? '')
    if (type === 'tool/call' || type === 'tool-call') {
      const d = ev.data ?? ev
      const line = toolLineFromEvent(String(d.name ?? d.toolName ?? ''), String(d.arguments ?? d.argsRaw ?? ''))
      if (line) return line
    }
    if (type === 'assistant/message') {
      // 先按「块」取（含 reasoning → 「思考 · …」），取不到再退回纯 text 拼接
      const blocks = Array.isArray(ev?.data?.blocks) ? ev.data.blocks
        : Array.isArray(ev?.data?.message?.content) ? ev.data.message.content
          : Array.isArray(ev?.data?.content) ? ev.data.content : []
      for (let j = blocks.length - 1; j >= 0; j--) {
        const line = blockLineOf(blocks[j])
        if (line) return line
      }
      const content = ev?.data?.message?.content ?? []
      const text = (Array.isArray(content) ? content : []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ')
      const clean = cleanPreviewText(text)
      if (clean.length >= 6) return clean.slice(0, 220)
    }
    // 其它带块的事件（assistant/reasoning、assistant/step …）也照块取
    const eventBlocks = Array.isArray(ev?.data?.blocks) ? ev.data.blocks : []
    for (let j = eventBlocks.length - 1; j >= 0; j--) {
      const line = blockLineOf(eventBlocks[j])
      if (line) return line
    }
    if (type === 'user/message') break
  }
  return ''
}

/** 流式块累加器：按 chunk.index 汇聚 text / reasoning / tool-call 三类块。
 *  宿主的紧凑记录、聊天面板的 live chunk 都是同一套 chunk，必须用同一套还原逻辑。 */
type StreamBlockStore = { order: number[]; byIndex: Map<number, any> }
function createStreamBlockStore(): StreamBlockStore {
  return { order: [], byIndex: new Map() }
}
function streamBlockSlot(store: StreamBlockStore, index: number, type: string): any {
  const key = Number.isFinite(index) ? index : store.order.length
  let block = store.byIndex.get(key)
  if (!block) {
    block = { type, index: key, text: '', arguments: '', name: '', id: '' }
    store.byIndex.set(key, block)
    store.order.push(key)
  }
  return block
}
/** 一条原始 StreamChunk（text-delta / reasoning-delta / tool-call-delta）→ 累加进块 */
function applyStreamChunk(store: StreamBlockStore, chunk: any): void {
  if (!chunk || typeof chunk !== 'object') return
  const index = Number(chunk.index ?? 0)
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    const block = streamBlockSlot(store, index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
    if (typeof chunk.text === 'string') block.text += chunk.text
    return
  }
  if (chunk.type === 'tool-call-delta') {
    const block = streamBlockSlot(store, index, 'tool-call')
    if (typeof chunk.id === 'string' && chunk.id) block.id = chunk.id
    if (typeof chunk.name === 'string' && chunk.name) block.name = chunk.name
    if (typeof chunk.argumentsDelta === 'string') block.arguments += chunk.argumentsDelta
  }
}
/** 累加器里最后一条可展示内容（工具调用 > 思考 > 正文） */
function lastLineFromStreamStore(store: StreamBlockStore): string {
  for (let i = store.order.length - 1; i >= 0; i--) {
    const block = store.byIndex.get(store.order[i])
    const line = blockLineOf(block)
    if (line) return line
  }
  return ''
}

/** 把宿主的「紧凑 chunk 记录」还原成内容块（与 dsh-llm 的 expandAssistantStream 同语义）：
 *  记录形状：text-chunks / reasoning-chunks / tool-call-chunks（批量）+ chunk（单条 delta）。
 *  流式中的这一轮只有这个形状，聊天面板也是从它还原的——卡片要显示同一条内容必须走同一套。 */
function blocksFromCompactStream(records: any[]): any[] {
  const store = createStreamBlockStore()
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const type = String((record as any).type ?? '')
    if (type === 'text-chunks' || type === 'reasoning-chunks') {
      const block = streamBlockSlot(store, Number((record as any).index ?? 0), type === 'text-chunks' ? 'text' : 'reasoning')
      if (Array.isArray((record as any).texts)) block.text += (record as any).texts.join('')
      continue
    }
    if (type === 'tool-call-chunks') {
      const block = streamBlockSlot(store, Number((record as any).index ?? 0), 'tool-call')
      if (typeof (record as any).id === 'string' && (record as any).id) block.id = (record as any).id
      if (typeof (record as any).name === 'string' && (record as any).name) block.name = (record as any).name
      if (Array.isArray((record as any).args)) block.arguments += (record as any).args.join('')
      continue
    }
    if (type === 'chunk') applyStreamChunk(store, (record as any).chunk)
  }
  return store.order.map((key) => store.byIndex.get(key)).filter(Boolean)
}

/** 已打开会话的本地事件窗口（与聊天面板同一份数据，含当前轮次的 live chunk）。
 *  binding.getSnapshot() 只有状态位、没有内容；内容在 Session 的 eventSource 里。 */
function sessionEntriesOf(sid: string): any[] {
  try {
    const rec: any = (sessionBridge?.sessions as any)?.binding?.(sid)
    const session: any = rec?.session ?? rec?.binding ?? rec
    const snap = session?.eventSource?.getSnapshot?.() ?? session?.events?.getSnapshot?.()
    const entries = snap?.entries
    if (Array.isArray(entries)) return entries
  } catch {}
  return []
}

/** 事件窗口 → 最新一条进度：从前往后扫，后出现的工具调用 / 消息 / live chunk 覆盖前一条。
 *  live chunk（assistant/live-chunk）就是聊天面板里正在逐字输出的那一轮，控制室要显示同一句。 */
function activityFromSessionEntries(entries: any[]): string {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  // 最近一次用户消息 / 新轮次会清空此前的进度，因此旧轮次不可能影响最终结果。
  // 先倒序定位边界，只还原当前轮次，避免流式期间反复重放整段历史。
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const ev: any = (entries[i] as any)?.event ?? entries[i]
    const type = String(ev?.type ?? '')
    if (type === 'user/message' || type === 'turn/start') { start = i + 1; break }
  }
  let lastLine = ''
  let store = createStreamBlockStore()
  let attempt = ''
  for (let i = start; i < entries.length; i++) {
    const entry = entries[i]
    const ev: any = (entry as any)?.event ?? entry
    if (!ev || typeof ev !== 'object') continue
    const type = String(ev.type ?? '')
    if (type === 'user/message' || type === 'turn/start') {
      lastLine = ''
      store = createStreamBlockStore()
      attempt = ''
      continue
    }
    if (type === 'tool/call') {
      const line = toolLineFromEvent(String(ev.data?.name ?? ev.data?.toolName ?? ''), String(ev.data?.arguments ?? ev.data?.argsRaw ?? ''))
      if (line) lastLine = line
      continue
    }
    if (type === 'assistant/message') {
      const blocks = blocksOf(ev)
      for (let i = blocks.length - 1; i >= 0; i--) {
        const line = blockLineOf(blocks[i])
        if (line) { lastLine = line; break }
      }
      continue
    }
    if (type === 'assistant/live-chunk') {
      const attemptId = String(ev.data?.attemptId ?? '')
      if (attemptId !== attempt) { attempt = attemptId; store = createStreamBlockStore() }
      applyStreamChunk(store, ev.data?.chunk)
      const line = lastLineFromStreamStore(store)
      if (line) lastLine = line
    }
  }
  return lastLine
}

/** 宿主 assistantStream（正在流式输出的那一轮）→ 一行进度。
 *  优先读 `activeAttempt.stream`（紧凑记录），其次兼容已经展开的 blocks/content。 */
function streamLineOf(stream: any): string {
  if (!stream) return ''
  if (typeof stream === 'string') {
    const clean = cleanPreviewText(stream)
    return clean.length >= 2 ? clean.slice(0, 220) : ''
  }
  const compact = stream?.activeAttempt?.stream
  if (Array.isArray(compact)) {
    const blocks = blocksFromCompactStream(compact)
    for (let i = blocks.length - 1; i >= 0; i--) {
      const line = blockLineOf(blocks[i])
      if (line) return line
    }
  }
  const blocks = Array.isArray(stream?.blocks) ? stream.blocks
    : Array.isArray(stream?.content) ? stream.content
      : Array.isArray(stream?.message?.content) ? stream.message.content : []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const line = blockLineOf(blocks[i])
    if (line) return line
  }
  for (const text of [stream?.text, stream?.thinking, stream?.reasoning]) {
    if (typeof text === 'string') {
      const clean = cleanPreviewText(text)
      if (clean.length >= 2) return ('思考 · ' + firstLineOf(clean)).slice(0, 220)
    }
  }
  return ''
}

/** assistantStream 里这一轮是否已经落定：attempt 起点之后已有同 turn/step 的 assistant 消息。
 *  流快照与 durable 日志由两条通道发出，偶尔流还停在上一轮（工具调用）而日志已经有最终答复；
 *  这时必须以日志为准，否则卡片会永久停在「工具调用 · …」。 */
function streamSettledInEvents(events: any[], attempt: any): boolean {
  if (!attempt) return false
  const after = Number(attempt.startedAfterSeq)
  if (!Number.isFinite(after)) return false
  const turn = Number(attempt.turn)
  const step = Number(attempt.step)
  for (const ev of events) {
    const seq = Number(ev?.seq)
    if (!Number.isFinite(seq) || seq <= after) continue
    if (ev?.type !== 'assistant/message' && ev?.type !== 'assistant/attempt') continue
    if (Number(ev?.data?.turn) === turn && Number(ev?.data?.step) === step) return true
  }
  return false
}

/** 从会话尾部提取最新一条进度（优先正在流式的这一轮，其次最后一条工具调用/文本）。
 *  数据源走宿主 follow 开场快照（任意会话可读、带 assistantStream）；取不到再退回会话面。
 *  tailOnly：只读日志，不碰会话面（空闲卡片用；sessionFaceOf 会 retain 作用域，
 *  对一堆冷会话逐个调用等于把 Agent 拉起来）。 */
async function fetchLatestActivity(sid: string, opts: { tailOnly?: boolean } = {}): Promise<string> {
  try {
    const api: any = getAssistantApi()
    if (api && typeof api.sessionTail === 'function') {
      const tail = await api.sessionTail(sid)
      if (tail) {
        const events: any[] = Array.isArray(tail.events) ? tail.events : []
        const attempt = tail.stream?.activeAttempt
        const live = !!attempt && !streamSettledInEvents(events, attempt)
        if (live) {
          const streamed = streamLineOf(tail.stream)
          if (streamed) return streamed
        }
        const fromTail = activityFromEvents(events)
        if (fromTail) return fromTail
        // 日志这一页没有可展示内容（例如只截到工具结果）时，再退回流式这一轮
        const streamed = streamLineOf(tail.stream)
        if (streamed) return streamed
      }
    }
  } catch { /* 宿主 follow 不可用 → 走会话面 */ }
  if (opts.tailOnly) return ''
  try {
    const face = sessionFaceOf(sid, true)
    if (!face || typeof face.history !== 'function') return ''
    const r = await face.history({ maxMessages: 10 })
    return activityFromEvents(historyEventsOf(r))
  } catch {}
  return ''
}

/** 会话分组列表（模块级，供自定义窗会话选择与对话绑定弹窗共用） */
async function fetchSessionGroups(): Promise<{ groups: { title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]; current: string }> {
  try {
    const snap = sessionBridge?.list?.getSnapshot?.()
    const byId = snap?.byId ?? {}
    const current = currentSessionId(snap?.current ?? '')
    // 子代理会话（后台产生的，用户面板看不到）排除
    const subKids = new Set<string>()
    try {
      const map = snap?.subagentsByParent ?? {}
      for (const k of Object.keys(map)) {
        const v = map[k]
        const arr = Array.isArray(v) ? v : (v?.entries ?? v?.items ?? [])
        if (Array.isArray(arr)) arr.forEach((c: any) => {
          const cid = c?.sessionId ?? c?.id
          if (typeof cid === 'string') subKids.add(cid)
        })
      }
    } catch {}
    const titleOf = (sid: string) => byId[sid]?.title ?? byId[sid]?.displayTitle ?? sid
    const mk = (sid: string) => ({ id: sid, title: titleOf(sid), isCurrent: sid === current })
    // 工作区分组：服务端读宿主 workspace.json（含 archived 排除），按用户面板结构分组；
    // 不属于任何工作区的会话收进「未分组」组（绑定弹窗/发送到会话都要能看到它们）
    try {
      const r = await fetch('/api/worktable/workspaces')
      const d = await r.json()
      const order: string[] = Array.isArray(d?.global?.workspaceIds) ? d.global.workspaceIds : []
      const archived: string[] = Array.isArray(d?.global?.archivedSessionIds) ? d.global.archivedSessionIds : []
      const table = d?.tables?.workspaces ?? {}
      const accounted = new Set<string>()
      const groups = order
        .map((wid: string) => {
          const sessIds = ((table[wid]?.sessionIds ?? []) as string[])
          sessIds.forEach((sid) => accounted.add(sid))
          return {
            title: (table[wid]?.title ?? wid) as string,
            sessions: sessIds
              .filter((sid) => !archived.includes(sid) && !subKids.has(sid))
              .map(mk),
          }
        })
        .filter((g) => g.sessions.length > 0)
      const allIds: string[] = Array.isArray(snap?.ids) ? snap.ids : []
      const ungrouped = allIds.filter((sid) => !accounted.has(sid) && !archived.includes(sid) && !subKids.has(sid))
      const withUngrouped = ungrouped.length > 0
        ? [{ title: '未分组', sessions: ungrouped.map(mk) }, ...groups]
        : groups
      if (withUngrouped.length > 0) return { groups: withUngrouped, current }
    } catch {}
    // 回退：平铺（排除子代理）
    const ids: string[] = Array.isArray(snap?.ids) ? snap.ids : []
    return { groups: [{ title: '', sessions: ids.filter((x) => !subKids.has(x)).map(mk) }], current }
  } catch { return { groups: [], current: '' } }
}

/** hover 气泡：挂在 document.body 的独立元素（不受侧栏堆叠上下文限制，可向右伸出显示） */
let bindTipEl: HTMLDivElement | null = null
function showBindTip(btn: HTMLElement) {
  const tip = btn.getAttribute('data-tip')
  if (!tip) return
  if (!bindTipEl) {
    bindTipEl = document.createElement('div')
    bindTipEl.className = 'dsh-wt_bindTip'
    document.body.appendChild(bindTipEl)
  }
  bindTipEl.textContent = tip
  const r = btn.getBoundingClientRect()
  bindTipEl.style.left = (r.right + 8) + 'px'
  bindTipEl.style.top = (r.top + r.height / 2) + 'px'
  bindTipEl.style.display = 'block'
  // 右侧放不下时翻到左侧（一般不会：侧栏 ~288px + 气泡 ~200px 远小于视口宽）
  const tw = bindTipEl.offsetWidth
  const x = r.right + 8 + tw > window.innerWidth - 8 ? Math.max(8, r.left - 8 - tw) : r.right + 8
  bindTipEl.style.left = x + 'px'
}
function hideBindTip() {
  if (bindTipEl) bindTipEl.style.display = 'none'
}

/** 把文本送入指定会话：宿主同款寻址（binding(id).session.prompt / sendSession(会话面)），
 *  插件是根级上下文，无作用域的 conversation.send 会报 requires a session scope，不可用。
 *  【投递失败诊断】每条失败路径的原因都记入 failures，最终抛错带上全部原因，并写到
 *  window.__wtLastSendFail 供调度器通知展示——根治「发送失败但不知道宿主拒绝原因」。 */
async function promptIntoSession(sessionId: string, text: string): Promise<void> {
  const b = sessionBridge
  if (!b) throw new Error('bridge unavailable')
  const sessions = b.sessions as any
  const failures: string[] = []
  const diag = (msg: string) => {
    failures.push(msg)
    try { (window as any).__wtLastSendFail = { sessionId, at: Date.now(), failures: [...failures] } } catch {}
  }
  const listHasSid = () => { try { return !!sessionsSnapshotStore.snapshot?.byId?.[sessionId] } catch { return false } }
  // 新会话入列可能异步：最多等 2s 直到 binding 可解析；
  // 新建而未打开过的会话没有 materialized scope（binding 恒 undefined）——循环内显式 retain 兜底
  let session: any = null
  let retained = false
  for (let i = 0; i < 10; i++) {
    try { session = sessions?.binding?.(sessionId)?.session ?? null } catch { session = null }
    if (session) break
    if (!retained) retained = retainSessionScope(sessionId)
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!session) diag(`binding 不可解析（2s 超时；列表快照 hasSid=${listHasSid()}）`)
  else {
    // binding 可解析 ≠ 会话已入列 / agent 已注册：再等最多 5s 让会话出现在列表快照里再投递，
    // 否则宿主 prompt 准入会确定性拒绝（表现为裁判/验收员「永远不启动」的根因之一）
    for (let i = 0; i < 25 && !listHasSid(); i++) {
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!listHasSid()) diag('会话未入列快照（5s 超时）')
    // 1) 宿主包装（正确签名：会话面 + 空图片 + queue 投递）
    if (typeof b.conversation?.sendSession === 'function') {
      try {
        // 注意：sendSession ** resolve 不代表送达 **——宿主准入拒绝（如会话 agent 尚未注册、模型槽位未就绪）
        // 时返回 { kind: 'error' } 而非抛错。旧代码不检查结果，导致调度器误判「任务已发出」，
        // 裁判/验收员会话空转、收敛环保 verifying 卡死。这里显式识别失败并落入直连重试。
        const sent = await b.conversation.sendSession(session, text, [], 'queue')
        if (!sent || sent.kind !== 'error') return
        diag(`sendSession rejected: ${sent?.error?.code ?? sent?.error?.message ?? JSON.stringify(sent)}`)
      } catch (e) { diag(`sendSession threw: ${String(e)}`) }
    } else diag('conversation.sendSession 不可用')
    // 2) 直连会话面 prompt（宿主 sendSession 内部同款路径）
    if (typeof session.prompt === 'function') {
      const result = await session.prompt([{ type: 'text', text }], 'queue')
      if (result && result.ok) return
      if (result && !result.ok) diag('session.prompt: ' + (result.error?.code ?? 'rejected') + (result.error?.message ? ': ' + result.error.message : ''))
      else diag('session.prompt: 无返回')
    } else diag('session.prompt 不可用')
  }
  // 3) 备用：作用域上下文里取 conversation 服务再发
  try {
    const scoped = sessions?.scope?.(sessionId)
    const conv = scoped?.get?.('conversation')
    if (conv && typeof conv.send === 'function') { await conv.send(text); return }
    diag('scoped conversation.send 不可用')
  } catch (e) { diag(`scoped send threw: ${String(e)}`) }
  throw new Error('no send path (' + failures.join(' | ') + ')')
}

/** 新建会话的分组选择：未分组 / 加入现有分组 / 新建一个分组（父目录 + 名称） */
export type NewSessionGroup = { kind: 'none' } | { kind: 'existing'; workspaceId: string } | { kind: 'new'; parent: string; name: string }

/** 插件知识包：附在窗口任务提示词里，让接收方跳过对插件源码的重新侦察，直接干活 */
const KNOWLEDGE_PACK = [
  '【插件知识包·请直接采用，不要重新侦察插件源码】',
  '- dsh-assistant（工作台）是 DeepSeek Harness 的自建插件：控制室 + 项目应用 + 手机访问 + 私人助手；不了解的细节可直接向用户提问。',
  '- 窗口（内容窗）模型：每个窗 = 一个标签页；未指派时显示选择器（浏览器/动画/资源管理器/终端/✨自定义）；',
  '  窗内容还可放 iframe 网页与文件预览（.md/.txt/.tsx/.css/.html 等）。',
  '- 窗口可装载的形式：HTML 单文件（交互 UI，放项目文件夹后在资源管理器点击渲染）、网页 URL、',
  '  文件预览（.md/.txt/.tsx/.css/.html/图片/.mp4 等）；产出形式按任务类型选，不要一律 HTML。',
  '- 产出 HTML 必须用工作台原生皮肤：在页面 <head> 加 <link rel="stylesheet" href="/api/worktable/template/dshell.css">，',
  '  组件类参考 /api/worktable/template/dshell.html（卡片/按钮/状态徽标/标签页/列表/统计/进度/表格等），',
  '  界面即可与 DSH 原生风格一致；自造样式控制在最小范围。',
  '- 服务端能力：/api/worktable/fs（列目录）、/api/worktable/write（写文件）、/api/worktable/mkdir（建目录）、',
  '  /api/worktable/git（git 状态）、/api/worktable/site（静态托管）。',
  '- 改完插件在插件仓库根目录（本机安装是指向源码仓库的 junction）执行 npm run build；纯客户端改动刷新页面即生效，宿主改动需要重启 DSH。',
  '- 所有产出文件一律放进本任务标注的项目文件夹，保持用户目录干净。',
  '- 标注协议：收到「📌 标注-窗口N …（坐标/元素/框内文字…）…」= 工作台标注（窗口编号约定：左栏→顶行→主行，从 1 起）。',
  '  处理：标注已标明框选区域与「最可能目标」时直接作答、不要二次询问（仅当确实无法从标注定位时才问一次）；能查看截图或打开窗口则先核实再回答。',
].join('\n')

/** 组装窗口任务提示词（新建/发送两模式共用；导出到 window 供自测校验） */
function buildWindowTaskText(projectId: string, projectName: string, windowLabel: string, requirement: string, folder: string | null, mode: 'new' | 'send'): string {
  const win = windowLabel || '一个内容窗'
  const folderLine = folder
    ? '项目文件夹：' + folder + '（本项目所有产出文件一律放进这个文件夹；不要写到别的默认位置）。'
    : '本项目暂未设置专属文件夹：产出文件先向用户确认存放位置，不要随便写。'
  const lines = [
    '【工作台自定义窗口任务】',
    '以下内容由 dsh-assistant（工作台）插件' + (mode === 'new' ? '自动发送' : '发送') + '：用户想把「' + projectName + '」项目中的「' + win + '」窗口打造成他想要的内容。',
    '1. dsh-assistant 是本插件的当前名字（工作台能力源自已合并的 dsh-worktable；官方文档没有它的说明，不了解之处可直接向用户提问）。',
    '2. 用户需求：' + requirement,
    '3. ' + folderLine,
    '4. 产出形式请按任务类型选择（不要一律用 HTML）：',
    '   - 交互小工具 / 看板 / 表单 / 图表（如计算器、互动按钮、数据看板）→ 单文件 HTML，放进项目文件夹；',
    '   - 文档 / 演示（PPT、报告、表格）→ 生成真实文件（.pptx / .md / .xlsx）放进项目文件夹，用户用本机软件打开编辑；',
    '   - 视频 / 动画 → 生成 .mp4 / .gif（或 Lottie JSON）文件放进项目文件夹；',
    '   - 工作台已有内置窗能力（资源管理器 / 终端 / 浏览器 / 动画站）→ 不要重复造轮子，直接建议用户改用内置窗。',
    '5. 完成内容后，用一两句话告知用户挂载结果（不要提问、不要等待用户确认）：例如「已完成并自动挂到「' + win + '」窗口，想调整直接说，我改完会自动更新」。该窗口位于「' + projectName + '」项目内，如需要也可协助该项目后续的其他自定义工作。',
    '6. 完成后写入「产物清单」文件：在项目文件夹里创建 widget-result.json。挂载单个窗口时写单对象 {\"window\":\"' + win + '\",\"path\":\"产物相对路径\",\"kind\":\"html\"}；一次挂载多个窗口（如窗口1 + 窗口2）时写 JSON 数组，每个元素为上述单对象（可引用多个产物文件）。kind 可选 html（本地页面，path 相对项目文件夹）/ url（外部链接，path 为完整 URL）/ file（其他文件，path 相对项目文件夹）。写完这个文件，工作台会自动把产物挂载进清单对应的各个窗口并锁定保存，用户无需手动操作；用户下次打开工作台时各窗口直接显示产物，不会丢失或重置。',
    KNOWLEDGE_PACK,
  ]
  return lines.join('\n')
}

/** 设置会话标题（模块级；宿主 rename 经 binding 按 id 解析实例，无需打开会话）。
 *  新建会话后 binding 可能尚未就绪 → 带小重试；失败静默（标题只是辅助识别信息，不阻断流程）。 */
async function setSessionTitle(sid: string, title: string): Promise<void> {
  if (!sid || !title) return
  for (let i = 0; i < 3; i++) {
    try {
      const session = sessionBridge?.sessions?.binding?.(sid)?.session
      if (session && typeof session.rename === 'function') {
        const r = await session.rename(title)
        if (!r || r.ok !== false) return
      }
    } catch { /* 下一轮重试 */ }
    await new Promise((res) => window.setTimeout(res, 250))
  }
}

/** 显式保留（retain）会话 scope：新建而未在 UI 打开过的会话**没有 materialized scope**——
 *  宿主 sessions.create() 只把会话写进列表快照，binding(sid)/scope(sid) 取会话面必须经过
 *  retainScope（宿主 UI 打开会话时才发生）。不 retain 就投递任务 = binding 恒 undefined →
 *  任务永远送不进去（裁判/验收员「会话建了却永远不启动」的确定性根因）。
 *  保留引用不 dispose（等价于「有人旁观该会话」），页面生命周期内有效。 */
function retainSessionScope(sid: string): boolean {
  try {
    const sessions = sessionBridge?.sessions as any
    if (sid && typeof sessions?.retainAgentScope === 'function') { sessions.retainAgentScope(sid); return true }
  } catch {}
  return false
}

/** 用户可见的失败提示：控制室/分栏里没有全局 toast 组件，而「点了 ＋ 却什么都没发生」
 *  是最难自查的静默失败——创建会话失败时至少用 alert 说清楚（先 console.warn 留证据）。 */
function reportUserError(text: string): void {
  try { console.warn('[dsh-assistant] ' + text) } catch {}
  try { (window as any).alert?.(text) } catch {}
}

/** 在指定目录注册（或取回）宿主工作区，返回工作区 id；失败 / 宿主没有该能力返回 null。
 *
 *  形状兼容（这是「新建会话默认工作区不对」的根因所在）：
 *  宿主 0.2 的 ctx.workspaces.create 直接返回 **Remote 信封** `{ ok, value: { workspace, created } }`
 *  （见 @deepseek-ai/dsh-api-workspace-controller 的 WorkspaceFeed.create → this.remote.create），
 *  早先的实现却按「顶层 workspaceId」读，于是一律拿到 null。
 *
 *  为什么必须注册：宿主 SessionCommandController.create 只有在带 workspaceId 时才会
 *  `workspace.attachSession(sessionId)`；退化成 {cwd} 建会话时，会话只有 cwd、没有工作区归属
 *  （会话列表里落在「未分组」，右侧工作区也不是该项目文件夹），用户还得手动重选工作文件夹。 */
async function workspaceIdAtFolder(folder: string): Promise<string | null> {
  const ws = sessionBridge?.workspaces as any
  if (!ws || typeof ws.create !== 'function') return null
  const res = await ws.create({ path: folder })
  if (res && typeof res === 'object' && res.ok === false) return null // 宿主拒绝（目录不存在等）
  const unwrapped = res && typeof res === 'object' && 'value' in res ? (res as any).value : res
  const view = unwrapped && typeof unwrapped === 'object' && 'workspace' in unwrapped ? unwrapped.workspace : unwrapped
  const id = view?.workspaceId ?? view?.id ?? null
  return typeof id === 'string' && id ? id : null
}

/** 在指定目录注册工作区并建会话：优先 workspace.create({path})（前端工作区可见、不用手动选地址），
 *  失败回退 sessions.create({cwd})。返回会话 id 或 null。可选 title = 会话标题（命名规范见 templates.ts）。
 *  注意：模板项目自动开会话必须走这条路径——仅 {cwd} 建会话时宿主工作区面板为空，会提示「选择一个工作区开始」。 */
async function createSessionAtFolder(folder: string, title?: string): Promise<string | null> {
  const b = sessionBridge
  if (!b || typeof b.sessions?.create !== 'function') return null
  try {
    let workspaceId: string | null = null
    try { workspaceId = await workspaceIdAtFolder(folder) } catch { /* 工作区注册失败：回退 cwd 建会话 */ }
    const createOpts: any = workspaceId ? { workspaceId } : { cwd: folder }
    const sid = await b.sessions.create(createOpts)
    if (sid && title) void setSessionTitle(sid, title)
    return sid
  } catch {
    return null
  }
}

/** 本地目录单层列表（服务端 /api/worktable/fs；失败返回 null） */
async function wtListDir(abs: string): Promise<{ name: string; path: string; isDir: boolean }[] | null> {
  try {
    const r = await fetch('/api/worktable/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: abs }) })
    const d = await r.json().catch(() => null)
    return Array.isArray(d?.entries) ? d.entries : null
  } catch {
    return null
  }
}

/** 「选择位置」的目录列表：与「会话输入框 → 电脑文件」附件走同一条 pocket RPC（fs.list），
 *  直接拿到盘符、面包屑、系统桌面目录与条目元数据——不再走只有单层条目的 /api/worktable/fs。 */
let folderFsApi: FsBrowserApi | null = null
function hostFolderFsApi(): FsBrowserApi {
  if (folderFsApi) return folderFsApi
  folderFsApi = {
    async listFs(path, opts) {
      const conn = (() => {
        try { return (clientCtx?.connection ?? clientCtx?.get?.('connection')) || null } catch { return null }
      })()
      const rpc = conn && conn.rpc && typeof conn.rpc.call === 'function' ? conn.rpc : null
      if (!rpc) throw new Error('当前环境不支持浏览电脑目录')
      const res = await rpc.call(POCKET_RPC_CHANNEL, POCKET_ENDPOINTS.fsList, {
        path,
        includeFiles: opts?.includeFiles === true,
        cwd: opts?.cwd,
      })
      if (res && res.ok === true) return res.value
      throw new Error(res?.error?.message ?? 'fs.list 失败')
    },
  }
  return folderFsApi
}

/** 本地文本文件读取（/api/worktable/file；失败返回 null） */
async function wtReadText(abs: string): Promise<string | null> {
  try {
    const r = await fetch('/api/worktable/file?path=' + encodeURIComponent(abs), { cache: 'no-store' })
    if (!r.ok) return null
    return await r.text()
  } catch {
    return null
  }
}

/** 自定义窗口任务：新建一个专属会话（可选指定分组/项目文件夹），注入窗口身份 + 知识包，并打开该会话 */
export async function createCustomSession(projectId: string, projectName: string, requirement: string, group?: NewSessionGroup, windowLabel = '', folder: string | null = null): Promise<string> {
  const b = sessionBridge
  if (!b || typeof b.sessions?.create !== 'function') throw new Error('sessions unavailable')
  const text = buildWindowTaskText(projectId, projectName, windowLabel, requirement, folder, 'new')
  // 分组解析：existing → 直接带 workspaceId 建会话；new → 先建目录并注册为工作区
  let workspaceId: string | null = null
  const g = group ?? { kind: 'none' as const }
  if (g.kind === 'existing') {
    workspaceId = g.workspaceId
  } else if (g.kind === 'new') {
    const ws = b.workspaces as any
    if (!ws || typeof ws.create !== 'function') throw new Error('workspaces unavailable')
    const parent = g.parent.replace(/[\\/]+$/, '')
    const name = g.name.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
    if (!parent || !name) throw new Error('invalid group path')
    const full = joinPath(parent, name)
    try { await ws.createDirectory?.(parent, name) } catch { /* 宿主 browse 能力本机为 native 时不可用 */ }
    try {
      // 兜底：插件服务端 mkdir（父目录必须已存在，避免误建深层目录）
      const r = await fetch('/api/worktable/mkdir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: full }) })
      const d = await r.json()
      if (!r.ok || !d?.ok) throw new Error(d?.error ?? 'mkdir failed')
    } catch { /* 目录建不出来的错误最终由 workspace.create 暴露 */ }
    // 注意：ws.create 返回的是 remote 信封，必须经 workspaceIdAtFolder 解包（顶层 workspaceId 恒为 undefined）
    workspaceId = await workspaceIdAtFolder(full)
    if (!workspaceId) throw new Error('workspace create failed')
  }
  // 会话工作目录优先级：显式分组（workspaceId）> 项目文件夹（cwd）> 默认
  let createOpts: any = {}
  if (workspaceId) createOpts = { workspaceId }
  else if (folder) createOpts = { cwd: folder }
  const sessionId = await b.sessions.create(createOpts)
  await ensureSessionPreset(sessionId) // 新会话应用部署默认预设
  await ensureSessionModel(sessionId) // 修复继承失效 provider（selectModel 同步存默认，顺带修复后续新会话）
  markPluginSessionOpen(sessionId) // 插件发起的切换：不触发「切会话关项目」联动
  openSessionInHost(sessionId) // 切到新会话（0.2 = uiWorkspace.openSession）
  await promptIntoSession(sessionId, text)
  return sessionId
}

/** 把自定义需求直接发到用户选定的已有会话（默认当前会话），带窗口身份 + 知识包 */
export async function sendCustomToSession(sessionId: string, projectId: string, projectName: string, requirement: string, windowLabel = '', folder: string | null = null): Promise<void> {
  const b = sessionBridge
  if (!b) throw new Error('bridge unavailable')
  const text = buildWindowTaskText(projectId, projectName, windowLabel, requirement, folder, 'send')
  markPluginSessionOpen(sessionId) // 插件发起的切换：不触发「切会话关项目」联动
  openSessionInHost(sessionId) // 切到新会话（0.2 = uiWorkspace.openSession）
  await promptIntoSession(sessionId, text)
}

// ── 项目 × 对话联动（模块级）──
/** 打开项目前所处的会话（关项目时回切）；attached = 该项目绑定的会话（无绑定 = 打开前会话） */
const projectAttachRef: { sessionId: string | null; attached: string | null } = { sessionId: null, attached: null }
/** 因「切换会话」而自动关项目时置位，跳过回切 */
const suppressRestoreRef: { current: boolean } = { current: false }
/** 项目绑定表的最新快照（组件每渲染同步，供模块级联动逻辑读取） */
const projectBindingsRef: { current: Record<string, string> } = { current: {} }
/** 插件自己发起的会话切换（新建/发送/回切）：联动逻辑不得因此自动关项目 */
const projectEnsureBusyRef: { current: Record<string, Promise<string | null>> } = { current: {} }
const pluginOpenedSessionsRef: { current: Set<string> } = { current: new Set<string>() }
function markPluginSessionOpen(sessionId: string) {
  if (sessionId) {
    const s = pluginOpenedSessionsRef.current
    if (s.size > 50) s.clear()
    s.add(sessionId)
  }
}

/** 手机端分栏（dsh-pocket 抽屉布局）判定：只用于「关项目时是否回切打开前的会话」这一条。
 *  判据优先取 pocket 写在 body 上的生效布局标记（'mobile' = 抽屉布局，含宽屏手机被强制成抽屉）；
 *  没有标记（pocket 未加载 / 老 bundle）时按官方窄屏线 1024 兜底。桌面 DSH 窗口（≥1024 且无标记）不受影响。 */
function isPocketPhoneLayout(): boolean {
  try {
    const v = globalThis.document?.body?.getAttribute?.('data-dsh-pocket-layout')
    if (v === 'mobile') return true
    if (v === 'desktop') return false
  } catch { /* 读不到标记就往下走视口判断 */ }
  try {
    const w = Number(globalThis.window?.innerWidth)
    return Number.isFinite(w) && w > 0 && w < 1024
  } catch { return false }
}

/** 宿主「切换当前会话」入口（跨版本适配，v0.3.28）。
 *  DSH 0.2 起当前会话选择迁到 ui-workspace 服务（ctx.uiWorkspace.openSession，内部写
 *  dsh.sessions.current + 挂主视图），**ctx.sessions.open 已被移除**——旧写法在 0.2 上是
 *  `undefined?.()` 静默空转：会话建得出来、绑得上，但界面永远不切过去（=「点了新建会话
 *  不弹窗」）。0.1.x 没有 uiWorkspace，仍走 sessions.open。两路都不可用时告警并返回 false，
 *  调用方照常继续，不阻断主流程。 */
function openSessionInHost(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  let uw: any = sessionBridge?.uiWorkspace ?? null
  // 宿主客户端 ctx 是「声明式注入门禁」代理：未在 inject 里声明过的服务用 ctx.<name> 直读会抛错，
  // 只有 ctx.get(name) 是免声明的可选查找——uiWorkspace 必须走 get，且整段包 try。
  if (!uw) { try { uw = clientCtx?.get?.('uiWorkspace') ?? null } catch { uw = null } }
  if (uw && typeof uw.openSession === 'function') {
    try { uw.openSession(sessionId); return true } catch (err) { console.warn('[dsh-worktable] uiWorkspace.openSession 失败：', err) }
  }
  const s = sessionBridge?.sessions
  if (s && typeof s.open === 'function') {
    try { s.open(sessionId); return true } catch (err) { console.warn('[dsh-worktable] sessions.open 失败：', err) }
  }
  console.warn('[dsh-worktable] 宿主未提供会话切换入口（uiWorkspace.openSession / sessions.open 均不可用）')
  return false
}
/** 新建会话后的「聚焦」：等它进宿主会话列表 → 必要时重拉列表 → 重试打开 → 校验当前会话
 *  → 空白会话的历史流若卡在 loading 就重建它（否则主区停在 settling = 纯白）。
 *
 *  结果写 window.__dshAssistantLastFocus（完整诊断）并 POST 到 /api/assistant/focus-diag 落盘，
 *  出问题时不用开 DevTools 也能拿到状态。 */
async function focusNewSession(sessionId: string, onOpened?: (result: FocusResult) => void): Promise<FocusResult> {
  const r = await focusSessionInHost(sessionBridge, sessionId, { onOpened })
  const diag = { ...r, at: Date.now(), dom: focusDomProbe() }
  try { (window as any).__dshAssistantLastFocus = diag } catch {}
  if (!r.opened || !r.settled) console.warn('[dsh-assistant] 新会话聚焦未完全就绪：', JSON.stringify(diag))
  void postFocusDiag(diag)
  return r
}

/** 主区渲染状态的最小探针（只读 DOM 属性，不碰会话内容） */
function focusDomProbe(): Record<string, unknown> {
  try {
    const root = document.querySelector('[data-phase]')
    const content = document.querySelector('[data-conversation-content]')
    const composer = document.querySelector('[data-conversation-region="composer"]')
    return {
      phase: root?.getAttribute('data-phase') ?? '',
      contentPhase: content?.getAttribute('data-content-phase') ?? '',
      session: content?.getAttribute('data-conversation-session') ?? '',
      hasComposer: !!composer,
      composerVisible: composer ? composer.getBoundingClientRect().height > 0 : false,
      text: String(content?.textContent ?? '').trim().slice(0, 80),
    }
  } catch { return {} }
}

/** 把聚焦诊断追加到宿主日志（宿主不可用时静默） */
async function postFocusDiag(diag: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/assistant/focus-diag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diag, at: new Date().toISOString() }),
    })
  } catch { /* 诊断失败不影响主流程 */ }
}

/** 空白会话白屏自愈看门狗：不是插件新建、而是用户从侧栏点开一条「历史流卡在 loading」的
 *  空白会话时，UI 同样会停在 settling（纯白）。这里每 2s 看一次当前会话：空白 + loading
 *  持续 2.5s 就 resync 一次（同一会话最多 3 次）。没卡住时只读一个快照，开销可忽略。 */
const blankStuckSince = new Map<string, { since: number; tries: number }>()

async function healStuckCurrentSession(): Promise<void> {
  const b = sessionBridge
  if (!b) return
  let cur = ''
  try { cur = String(b.uiWorkspace?.selection?.getSnapshot?.()?.sessionId ?? b.list?.getSnapshot?.()?.current ?? '') } catch { return }
  if (!cur) return
  const st = sessionFaceState(b, cur)
  if (!st || !st.blank || st.openState !== 'loading') { blankStuckSince.delete(cur); return }
  const rec = blankStuckSince.get(cur)
  const now = Date.now()
  if (!rec) { blankStuckSince.set(cur, { since: now, tries: 0 }); return }
  if (now - rec.since < 2500 || rec.tries >= 3) return
  rec.since = now
  rec.tries += 1
  const healed = await healBlankSessionIfStuck(b, cur)
  if (healed) console.warn('[dsh-assistant] 空白会话历史流卡住，已重建（第 ' + rec.tries + ' 次）：' + cur)
  void postFocusDiag({ kind: 'watchdog-resync', sessionId: cur, healed, openState: st.openState, tries: rec.tries, dom: focusDomProbe(), at: Date.now() })
}
/** 新建会话的「预设 + 模型」补齐（部署默认预设 / 继承用户当前模型）。
 *
 *  时机很重要：必须在会话被 UI **打开之后**再跑。这两个 RPC 会让宿主在建会话与主区挂载
 *  之间重启一次该会话的 Agent，客户端的 history 流于是可能永远停在 `loading`；而 UI 的
 *  ConversationRoot 在这种状态下的 data-phase = settling
 *  （`shellPhase==='blank' && openState==='loading' && summaryBlank!==true`），
 *  CSS 把 composerSeat 设成 visibility:hidden，会话头 hideChrome —— 主区就是一片纯白，
 *  只剩左上角的侧栏折叠图标。这就是「新建会话跳过去白屏」的根因之一。
 *  宿主原生的「新建会话」也是先挂载会话、再让用户选模型，顺序一致。 */
async function applyNewSessionDefaults(sessionId: string): Promise<void> {
  if (!sessionId) return
  try { await ensureSessionPreset(sessionId) } catch {}
  try { await ensureSessionModel(sessionId) } catch {}
}

/** 新建会话失败提示的统一文案（工作文件夹缺失/不可写是最常见原因） */
function newSessionFailedText(folder: string): string {
  return '新建会话失败：没能在这个项目的文件夹下创建会话。' + (folder ? '\n工作文件夹：' + folder : '') + '\n请确认该文件夹存在且可写，然后重试。'
}

let lastSessionScopeId = ''

/** 当前会话 id（跨宿主版本适配）。
 *
 *  DSH 0.2 起「当前会话」的选择在 ui-workspace 服务里（`uiWorkspace.openSession` 写
 *  `selection = { sessionId }`，主视图 retain 它）；`sessions.list` 快照
 *  （{ ids, byId, phase, projectionsBySession }）**已经不再带 current 字段**。
 *  旧代码一律读 `snap.current`，在 0.2 上恒为空串 —— 于是：
 *    ① 项目 × 对话联动（切到项目外的会话 → 自动收起项目）从未触发；
 *    ② 会话列表的「当前」高亮永远是空；
 *    ③ 关项目时「回切打开前的会话」拿不到 prev。
 *  本函数按「选择快照 → sessions.current（绑定源）→ 旧宿主 list.current」依次兜底。 */
function currentSessionId(fallback = ''): string {
  try {
    const uw = sessionBridge?.uiWorkspace ?? (() => { try { return clientCtx?.get?.('uiWorkspace') ?? null } catch { return null } })()
    const sid = String(uw?.selection?.getSnapshot?.()?.sessionId ?? uw?.mainReference?.sessionId ?? '')
    if (sid) return sid
  } catch {}
  try {
    const binding = sessionBridge?.sessions?.current?.getSnapshot?.()
    const sid = String(binding?.sessionId ?? binding?.key ?? '')
    if (sid) return sid
  } catch {}
  try {
    const sid = String(sessionBridge?.list?.getSnapshot?.()?.current ?? '')
    if (sid) return sid
  } catch {}
  // 最后兜底：ui-workspace 的选择快照持久化在 localStorage（dsh.sessions.current），
  // 宿主服务还没注入时也能读到「最后打开的那条会话」。
  try {
    const raw = localStorage.getItem('dsh.sessions.current')
    const sid = raw ? String(JSON.parse(raw)?.sessionId ?? '') : ''
    if (sid) return sid
  } catch {}
  return String(fallback ?? '')
}

/** 会话作用域快照（模块级；apply 里订阅 ctx.sessions.list 写入，组件与引擎只读） */
const sessionScopeStore: {
  snapshot: { sessionId: string; cwd: string; jobs: any[]; subagents: any[] } | null
} = { snapshot: null }

/** 完整会话快照（模块级）：项目卡片的任务完成/待决提醒镜像数据源 */
const sessionsSnapshotStore: { snapshot: any | null; listeners: Set<() => void> } = { snapshot: null, listeners: new Set() }
/** 验收环用户通知（面板 toast 数据源；调度器写入，buildFlowView 透传，FlowPane 展示） */
const verifyNotifyStore: { current: { projectId: string; msg: string; kind: 'ok' | 'err' | 'info'; at: number } | null } = { current: null }

/** 取某个会话的工作目录（宿主会话快照的 cwd；会话未加载或取不到时返回 ''）。
 *  用途：内置项目（控制室）没有「项目文件夹」，新建对话时沿用它自己当前对话的目录。 */
function cwdOfSession(sid: string | null | undefined): string {
  if (!sid) return ''
  try {
    const v = sessionsSnapshotStore.snapshot?.byId?.[sid]?.cwd
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** 某个目录（项目文件夹）下的全部会话 id：含各步骤子目录，排除子代理会话。
 *  与卡片「会话列表」同一判定口径（Windows 路径大小写不敏感）；判定本体在
 *  sessionFolder.ts（纯函数，可单测）。卡片的状态灯与中间进度都按「项目关联会话全集」算，
 *  所以不限定必须是绑定会话。 */
function sessionIdsUnderFolder(base: string): string[] {
  try {
    const snap = sessionBridge?.list?.getSnapshot?.()
    const byId: Record<string, any> = snap?.byId ?? {}
    const ids: string[] = Array.isArray(snap?.ids) ? snap.ids : Object.keys(byId)
    return sessionsUnderFolder(ids, byId, base)
  } catch { /* 快照不可用：返回空，状态退回绑定会话口径 */ }
  return []
}

/** 提醒确认（ack）持久化：会话 id → 已确认的状态（'done' | 'need'） */
const NOTIFY_ACK_KEY = 'dsh.worktable.notifyAck.v1'
function loadNotifyAck(): Record<string, string> {
  // 读缓存：控制室每刷一次卡片都读它，内容没变就不再 parse（省下的正是打字 / 滚动那段主线程）
  return cachedJsonRead(NOTIFY_ACK_KEY, (raw) => {
    const p = raw ? JSON.parse(raw) : {}
    return p && typeof p === 'object' ? p : {}
  })
}
function saveNotifyAck(sid: string, state: string) {
  try {
    const ack = loadNotifyAck()
    ack[sid] = state
    cachedJsonWrite(NOTIFY_ACK_KEY, ack)
  } catch {}
}
/** 异常终止标记：会话 id 集合（宿主会话面 lastAgentError 出现后记录；
 *  用户点开项目确认、或该会话开始新一轮运行时清除）。控制室卡片据此显示红色「异常终止」。 */
const AGENT_ERR_KEY = 'dsh.assistant.agentError.v1'
function loadAgentErrors(): Record<string, string> {
  return cachedJsonRead(AGENT_ERR_KEY, (raw) => {
    const p = JSON.parse(raw ?? '{}')
    return p && typeof p === 'object' ? p : {}
  })
}
function saveAgentErrors(map: Record<string, string>) {
  cachedJsonWrite(AGENT_ERR_KEY, map)
}
function clearAgentErrors(ids: string[]) {
  if (ids.length === 0) return
  const map = loadAgentErrors()
  let dirty = false
  for (const id of ids) if (map[id]) { delete map[id]; dirty = true }
  if (dirty) saveAgentErrors(map)
}

/** 临时卡片不重复收纳的目录：**有卡片存在**的项目文件夹 + 无文件夹项目的绑定会话目录。
 *  后者与项目卡片 relatedSidsOf 的目录基准同源（项目没有文件夹时，卡片按绑定会话的 cwd 看会话），
 *  避免同一批会话既出现在项目卡片上、又出现在临时卡片上。
 *  已删除（removed）或没有卡片（不在 layouts / 注册表）的残留项目不算：它们已经没有任何卡片能看到这些会话。 */
function projectOwnedFolders(state: { projects: ProjectsState; aliveRegisteredIds: string[] }): string[] {
  const pr = state.projects
  const removed = new Set(pr.removed ?? [])
  const known = new Set<string>([CONSOLE_ID, ...state.aliveRegisteredIds, ...pr.layouts.map((l) => l.id)])
  const out = new Set<string>()
  for (const [pid, folder] of Object.entries(pr.folders)) {
    if (removed.has(pid) || !known.has(pid)) continue
    if (typeof folder === 'string' && folder) out.add(folder)
  }
  for (const [pid, sid] of Object.entries(pr.bindings)) {
    if (removed.has(pid) || !known.has(pid)) continue
    if (pr.folders[pid]) continue
    const cwd = cwdOfSession(sid)
    if (cwd) out.add(cwd)
  }
  return [...out]
}

/** 临时卡片「收工」记录：会话 id → 收工时间戳。
 *  与结束时间比较：收工只压住这一轮；同一会话下一轮结束时结束时间更晚，卡片会重新出现。
 *  收工只是把这一轮结果从临时卡片移除，不删会话、不影响侧栏。 */
function loadTransientDismissed(): Record<string, number> {
  return cachedJsonRead(TRANSIENT_DISMISS_KEY, (raw) => {
    const p = JSON.parse(raw ?? '{}')
    if (!p || typeof p !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [sid, at] of Object.entries<any>(p)) {
      const n = Number(at)
      if (typeof sid === 'string' && sid && Number.isFinite(n) && n > 0) out[sid] = n
    }
    return out
  })
}
function saveTransientDismissed(map: Record<string, number>) {
  try {
    // 只留最近 7 天：收工时已同时删除结束时刻，旧收工记录被清掉也不会让卡片复活
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const pruned: Record<string, number> = {}
    for (const [sid, at] of Object.entries(map)) if (at >= cutoff) pruned[sid] = at
    cachedJsonWrite(TRANSIENT_DISMISS_KEY, pruned)
  } catch {}
}
/** 临时卡片上「跑 → 停」的结束时刻（会话 id → ms）。
 *  不能用宿主 updatedAt：它只在新提示词时前进（= 开新一轮），长任务跑完后会被误判成「很久前就结束了」。
 *  这里由全局生命周期跟踪器在观察到一次 running=true → false 时记下当时时间，并持久化，
 *  这样控制室关着、甚至宿主重启后，仍能识别出「这是卡片收纳过、已结束的会话」。
 *  不按时间清理：卡片要一直保留到用户手动收工。 */
const TRANSIENT_FINISH_KEY = 'dsh.assistant.transientFinished.v1'
function loadTransientFinished(): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const p = JSON.parse(localStorage.getItem(TRANSIENT_FINISH_KEY) ?? '{}')
    if (p && typeof p === 'object') {
      for (const [sid, at] of Object.entries<any>(p)) {
        const n = Number(at)
        if (typeof sid === 'string' && sid && Number.isFinite(n) && n > 0) out.set(sid, n)
      }
    }
  } catch {}
  return out
}
const transientLifecycle = {
  /** 上一份快照里的运行态（首次见到某会话 = 建立基线，不伪造「刚结束」） */
  prevRunning: new Map<string, boolean>(),
  /** 已观察到的结束时刻；同一会话开始新一轮时删除，用户收工时也删除 */
  finishedAt: loadTransientFinished(),
}
let transientFinishDirty = false
function saveTransientFinished(): void {
  if (!transientFinishDirty) return
  transientFinishDirty = false
  try {
    const obj: Record<string, number> = {}
    for (const [sid, at] of transientLifecycle.finishedAt) obj[sid] = at
    localStorage.setItem(TRANSIENT_FINISH_KEY, JSON.stringify(obj))
  } catch {}
}
/** 临时卡片当前会话 id（供 1.2s 进度抓取与冷预览复用；getConsoleCards 每次刷新） */
const transientTrackedIdsRef: { current: string[] } = { current: [] }
/** 自动挂载：已消费过完成事件的会话集（一次完成只挂载一次） */
const mountConsumedRef: { current: Set<string> } = { current: new Set<string>() }
/** 待挂载（项目未打开时暂存）：projectId → 挂载内容；刷新后从 localStorage 恢复 */
const pendingMountRef: { current: Record<string, any> } = { current: (() => {
  try { return JSON.parse(localStorage.getItem('dsh.worktable.pendingMount.v1') ?? '{}') ?? {} } catch { return {} }
})() }
/** 已挂载指纹：projectId → widget-result.json 原文。自愈扫挂据此去重：
 *  同清单不重复锁定（不覆盖用户后续对窗口的手动调整），清单变化才重新挂载。 */
const mountedWidgetRef: { current: Record<string, string> } = { current: (() => {
  try { return JSON.parse(localStorage.getItem('dsh.worktable.mountedWidget.v1') ?? '{}') ?? {} } catch { return {} }
})() }
function recordMountedWidget(projectId: string, raw: string) {
  if (!projectId || !raw) return
  mountedWidgetRef.current[projectId] = raw
  try { localStorage.setItem('dsh.worktable.mountedWidget.v1', JSON.stringify(mountedWidgetRef.current)) } catch {}
}

/** 「窗口N」→ 窗格位置（左栏 → 顶行 → 主行 编号规则，与 AGENTS.md 窗口编号一致） */
function windowLabelToPane(spec: any, label: string): { row: 'left' | 'top' | 'main'; index: number } | null {
  const m = /^窗口(\d+)$/.exec(String(label ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n < 1) return null
  let idx = n - 1
  if (spec?.left) {
    if (idx === 0) return { row: 'left', index: 0 }
    idx -= 1
  }
  const top = spec?.top ?? []
  if (idx < top.length) return { row: 'top', index: idx }
  idx -= top.length
  const main = spec?.main ?? []
  if (idx < main.length) return { row: 'main', index: idx }
  return null
}

/** 窗格是否存在于布局 spec（lockPane 对不存在的窗格会静默放弃；据此决定是否记录挂载指纹） */
function paneExists(spec: any, row: 'left' | 'top' | 'main', index: number): boolean {
  if (!spec) return false
  if (row === 'left') return !!spec.left && index === 0
  if (row === 'top') return !!spec.top && !!spec.top[index]
  return !!spec.main && !!spec.main[index]
}

/** 产物清单 → 窗口内容（html=目录级托管 iframe / url=外链 iframe / file=文件预览） */
function buildMountContent(folder: string, d: any): any {
  const p = String(d?.path ?? '').trim()
  if (!p) return null
  if (d?.kind === 'url') return { kind: 'iframe', url: p, title: p }
  const full = isAbs(p) ? p : joinPath(folder, p)
  if (d?.kind === 'file') return { kind: 'file', path: full }
  const dir = parentPathOf(full)
  const name = basenameOf(full)
  return { kind: 'iframe', url: '/api/worktable/site/' + encodeURIComponent(dir) + '/' + encodeURIComponent(name), title: name }
}

/** 每会话最近一次观察到的「需要判断」布尔值：状态转移时清除旧 ack（新一轮待决重新点亮） */
const notifyStateSeenRef: { current: Record<string, boolean> } = { current: {} }
/** 每会话最近观察到的「已完成」布尔值：新一次完成时清除旧 done ack（控制室绿光重新点亮） */
const doneSeenRef: { current: Record<string, boolean> } = { current: {} }
/** 已为某「项目::步骤会话」触发的自动全局刷新（一次完成只刷新一次，避免每个快照都重扫） */
const flowRefreshSeenRef: { current: Record<string, boolean> } = { current: {} }
/** 清除某会话的 ack 记录（状态转移时调用，保证新问题不会被旧确认压住） */
function clearNotifyAck(sid: string) {
  try {
    const all = loadNotifyAck()
    if (all[sid]) {
      delete all[sid]
      cachedJsonWrite(NOTIFY_ACK_KEY, all)
    }
  } catch {}
}

/** 宿主会话状态登记（uiSession.sessionStatus：Map 会话→{ running, pendingInteraction, … }）。
 *  会话列表(byId)与 face 快照都不带待提问状态，必须订阅这个可观察量；
 *  旧版 pendingInteractions 只存待决项，sessionStatusSourceOf 会一并兼容。 */
const pendingInteractionsStore: { map: ReadonlyMap<string, any> | null; listeners: Set<() => void>; source: (() => void) | null } = {
  map: null, listeners: new Set(), source: null,
}
let pendingInteractionIdsSig: string | null = null
function findPendingInteractions(): any {
  try {
    const direct = sessionStatusSourceOf(sessionBridge?.sessions)
    if (direct) return direct
    const b = sessionBridge?.pendingInteractions
    if (b && typeof b.getSnapshot === 'function' && typeof b.subscribe === 'function') return b
    const fromConversation = sessionStatusSourceOf(sessionBridge?.conversation)
    if (fromConversation) return fromConversation
    for (const key of ['uiSession', 'sessions', 'session']) {
      try {
        const svc = clientCtx?.get?.(key)
        const source = sessionStatusSourceOf(svc)
        if (source) return source
      } catch {}
    }
  } catch {}
  return null
}
function refreshPendingInteractions(): void {
  try {
    const source = findPendingInteractions()
    const m = source?.getSnapshot?.()
    pendingInteractionsStore.map = m instanceof Map ? (m as ReadonlyMap<string, any>) : null
  } catch { pendingInteractionsStore.map = null }
  // sessionStatus 也包含 running 等高频字段；只有「待决会话集合」变化才重绘。
  // map 已先行更新，卡片下次因其它快照刷新时仍读取最新真值。
  const sig = pendingInteractionSignature(pendingInteractionsStore.map)
  if (sig === pendingInteractionIdsSig) return
  pendingInteractionIdsSig = sig
  pendingInteractionsStore.listeners.forEach((l) => { try { l() } catch {} })
}
/** 订阅宿主登记（幂等；无该服务时保留会话面 pending 的兜底通道）。 */
function wirePendingInteractionsSource(): void {
  if (pendingInteractionsStore.source) return
  try {
    const source = findPendingInteractions()
    if (!source) return
    pendingInteractionsStore.source = source.subscribe(() => refreshPendingInteractions())
    refreshPendingInteractions()
  } catch {}
}
/** 该会话是否正等待用户决策（提问/审批等 pendingInteraction 非空即视为待决）。 */
function sessionAwaitingDecision(sid: string | undefined): boolean {
  return hasPendingInteraction(pendingInteractionsStore.map, sid)
}

/** 会话状态 → 提醒类型：待决(黄) 优先于 完成(绿)——等待用户判断时 pendingInteraction 与
 *  running 会同时为真，原生 UI 以黄点优先，镜像必须一致 */
function sessionNotifyState(entry: any): 'done' | 'need' | null {
  if (!entry) return null
  if (entry.pendingInteraction != null) return 'need'
  if (entry.completed === true) return 'done'
  return null
}

/** 会话面是否存在未结束的轮次（turnTimings 中有 startTime 且无 endTime；宿主 running 之外的兜底） */
function faceHasOpenTurn(face: any): boolean {
  try {
    const timings = face?.turnTimings
    if (timings instanceof Map) {
      for (const t of Array.from(timings.values())) {
        if (t && typeof t.startTime === 'number' && t.endTime == null) return true
      }
    } else if (timings && typeof timings === 'object') {
      for (const k of Object.keys(timings)) {
        const t = (timings as any)[k]
        if (t && typeof t.startTime === 'number' && t.endTime == null) return true
      }
    }
  } catch {}
  return false
}

/** 某会话是否正在工作：宿主 running 标记 / 其子代理 running / 会话面存在未结束轮次（已完成的不算）。
 *  kidsOf 由调用方注入（取子代理 id 集合）。 */
function sessionRunningNow(sid: string | undefined, byId: Record<string, any>, kidsOf: (s: string) => Set<string>): boolean {
  if (!sid) return false
  const e = byId[sid]
  if (e?.running === true) return true
  for (const cid of kidsOf(sid)) {
    const ce = byId[cid]
    if (ce?.running === true) return true
  }
  try {
    const face = sessionFaceSnapshotOf(sid)
    if (face && face.completed !== true && faceHasOpenTurn(face)) return true
  } catch {}
  return false
}

/** 会话面快照（只读，取不到返回 null）；卡片与「会话列表 / 进入判定」共用同一条通道。
 *  带 100ms 的极短 TTL：卡片组装 / 提醒表 / 待决表 / 临时卡片各自都要读同一会话的会话面，
 *  一次宿主通知就是三四遍 sessions.binding(sid).session.getSnapshot()（宿主侧要投影整棵会话状态），
 *  再乘上同时挂着的工作台实例（侧栏工作台 + headless 数据宿主 + 分栏浮层）。
 *  待决 / 在跑 的真正变化都由宿主订阅推出来（pendingInteractionsStore 与 sessions.list 通知），
 *  这层缓存不会把那一挡压住。 */
const faceSnapshots = createFaceSnapshotCache({
  read: (sid: string): any => sessionBridge?.sessions?.binding?.(sid)?.session?.getSnapshot?.() ?? null,
})
function sessionFaceSnapshotOf(sid: string | undefined): any {
  return sid ? faceSnapshots.get(sid) : null
}

/** 卡片口径的「此刻在跑」：宿主已 completed 且 running 位没亮的一律不算（避免残留的未结束轮次把会话糊成在跑） */
function sessionRunningFlag(sid: string | undefined, byId: Record<string, any>, kidsOf: (s: string) => Set<string>): boolean {
  if (!sid) return false
  const e = byId[sid]
  if (e?.completed === true && e?.running !== true) return false
  return sessionRunningNow(sid, byId, kidsOf)
}

/** 卡片口径的「等你回答」：pendingInteraction / 会话面 pending / 任一子代理待决。
 *  与 running 同时为真是常态（原生 UI 以黄点优先），所以判定必须排在 running 之前。 */
function sessionAwaitingFlag(
  sid: string | undefined,
  byId: Record<string, any>,
  kidsOf: (s: string) => Set<string>,
  faceOf: (sid: string) => any,
): boolean {
  if (!sid) return false
  if (sessionAwaitingDecision(sid) || sessionNotifyState(byId[sid]) === 'need') return true
  for (const cid of kidsOf(sid)) {
    if (sessionAwaitingDecision(cid) || (byId[cid] && sessionNotifyState(byId[cid]) === 'need')) return true
  }
  const face = faceOf(sid)
  return Array.isArray(face?.pending) && face.pending.length > 0
}

function syncSessionScope(list: any) {
  try {
    const snap = list.getSnapshot()
    const current: string = currentSessionId(snap?.current ?? '')
    const entry = snap?.byId?.[current] ?? snap?.items?.find((it: any) => it.sessionId === current) ?? null ?? null
    const cat = snap?.subagentsByParent?.[current]
    let subagents: any[] = []
    if (Array.isArray(cat)) subagents = cat
    else if (cat && Array.isArray(cat.entries)) subagents = cat.entries
    else if (cat && Array.isArray(cat.items)) subagents = cat.items
    else if (cat && Array.isArray(cat.children)) subagents = cat.children
    sessionScopeStore.snapshot = {
      sessionId: current,
      cwd: entry?.cwd ?? '',
      jobs: (snap?.jobsBySession?.[current] ?? []) as any[],
      subagents,
    }
    // 完整快照 + 通知监听（项目卡片提醒镜像）
    try {
      sessionsSnapshotStore.snapshot = snap
      // 每次宿主通知重建一次共享索引；随后卡片、生命周期与侧栏提醒共同复用。
      invalidateSessionSnapshotIndex()
      sessionsSnapshotStore.listeners.forEach((l) => { try { l() } catch {} })
    } catch {}
    // 项目×对话联动：项目打开期间切到「项目之外」的会话 → 自动收起项目（保留用户新选的会话）。
    // 判定按项目文件夹（见 projectExit.ts）：模板项目内部各步会话互切不算离开，
    // 长按悬浮球打开的私人助手（cwd = ~/.dsh/assistant）则一定离开。
    try {
      if (current !== lastSessionScopeId) {
        lastSessionScopeId = current
        if (current && splitStore.active && splitStore.spec) {
          const pid = splitStore.spec.id
          // 插件自身发起的切换（新建/发送到会话/模板步骤）不关项目——用户要继续在项目里跟新对话沟通
          const pluginSwitch = pluginOpenedSessionsRef.current.has(current)
          pluginOpenedSessionsRef.current.delete(current)
          if (!pluginSwitch) {
            const pr = projectsRef.current?.projects ?? null
            const isConsole = pid === CONSOLE_ID
            const leaves = sessionLeavesProject({
              sessionId: current,
              attached: projectAttachRef.attached,
              bound: isConsole ? null : (pr?.bindings?.[pid] ?? null),
              folder: isConsole ? '' : (pr?.folders?.[pid] ?? ''),
              cwd: cwdOfSession(current),
              isConsole,
            })
            if (leaves) {
              suppressRestoreRef.current = true
              splitStore.close()
            }
          }
        }
      }
    } catch { /* 联动失败不影响主流程 */ }
  } catch {
    sessionScopeStore.snapshot = { sessionId: '', cwd: '', jobs: [], subagents: [] }
  }
}

/** 显示/隐藏切换图标：睁眼/闭眼同族 SVG（对称设计，符合可见性规范） */
function EyeIcon(props: { closed: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      {props.closed ? (
        <>
          <path d="M1.8 8s2.6-3.1 6.2-3.1S14.2 8 14.2 8s-2.6 3.1-6.2 3.1S1.8 8 1.8 8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M3.6 8h8.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M1.8 8s2.6-3.1 6.2-3.1S14.2 8 14.2 8s-2.6 3.1-6.2 3.1S1.8 8 1.8 8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <circle cx="8" cy="8" r="1.7" fill="currentColor" />
        </>
      )}
    </svg>
  )
}

/** 管理面板改名输入：本地草稿，blur/Enter 才提交（清空时不会立刻弹回原名） */
function RenameInput(props: { initial: string; placeholder: string; onCommit: (v: string) => void }) {
  const [val, setVal] = useState(props.initial)
  useEffect(() => { setVal(props.initial) }, [props.initial])
  const commit = () => {
    const v = val
    props.onCommit(v)
    // 清空提交 = 删除覆盖：回显原名（与文件改名一致）
    if (!v.trim()) setVal(props.initial)
  }
  return (
    <input
      className="dsh-wt_manageInput"
      value={val}
      placeholder={props.placeholder}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() } }}
    />
  )
}

function WorktableSection(props: any) {
  // headless：作为 shell.overlay 常驻的「数据/弹窗宿主」——不渲染侧栏工作台区块，
  // 只保留 splitEnv 注入与添加项目等弹窗（控制室通过悬浮球进入，侧栏不再出现工作台）。
  const headless = props.headless === true
  const wide = headless ? true : props.wide !== false
  const renderProjectSlot = typeof props.renderSlot === 'function' ? props.renderSlot : null
  /** locale 座席 t；宿主未安装 locale 服务时回退 zh 词典（保持独立可用）。 */
  const t = (key: WorktableKey, params?: Record<string, string>): string => {
    if (typeof props.t === 'function') {
      try {
        return props.t(key, params)
      } catch {
        /* 回退 zh */
      }
    }
    let s: string = zh[key] ?? key
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace('{' + k + '}', v)
    return s
  }
  /** 项目文件夹浏览器的文案：优先悬浮球词典（与「电脑文件」附件选择器完全同词），缺失回退 zh */
  const orbText = (key: OrbKey): string => {
    if (!orbT) {
      // 悬浮球词典是在另一个 ctx.inject 回调里注册的：首次打开时才绑定，拿不到就回退 zh
      try {
        const bound = clientCtx?.locale?.bind?.(ORB_NS)
        if (typeof bound === 'function') orbT = bound
      } catch { /* 无 locale 服务 */ }
    }
    try {
      const text = orbT?.(key)
      // 词典还没注册时宿主会把 key 原样返回：别把 pickDir 这种键名显示给用户
      if (typeof text === 'string' && text !== '' && text !== key) return text
    } catch { /* 回退 zh */ }
    return (ORB_ZH as Record<string, string>)[key] ?? String(key)
  }

  const [view, setView] = useState<ViewState>(loadView)
  const [notifyTick, setNotifyTick] = useState(0)
  const [projects, setProjects] = useState<ProjectsState>(loadProjects)
  const [metas, setMetas] = useState<Record<string, ProjectMeta>>({})
  const [registeredIds, setRegisteredIds] = useState<string[]>(() => [...registryStore.ids])
  const [addOpen, setAddOpen] = useState(false)
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false)
  // 更新检查：徽标 / 更新卡 / 版本行共用；节流、重试、缓存都在 updateCheck（这里只留 UI 状态）
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateCheckOn, setUpdateCheckOn] = useState<boolean>(() => getAutoCheck())
  const [updateCopied, setUpdateCopied] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'uptodate' | 'failed'>(() => readCache().status)
  const updateCheckingRef = useRef(false)
  const updateAliveRef = useRef(true)
  useEffect(() => () => { updateAliveRef.current = false }, [])
  const checkUpdates = useCallback(async (force = false) => {
    if (updateCheckingRef.current) return // 防重入：并发点击只保留一个 in-flight
    updateCheckingRef.current = true
    setUpdateStatus('checking')
    try {
      const result = await checkUpdate(force) // 一天一次节流、8s×3 重试、跳过版本都在 updateCheck 里
      if (!updateAliveRef.current) return // 组件已卸载：不再更新状态
      setUpdateStatus(result.status)
      setUpdateInfo(result.info)
    } finally {
      updateCheckingRef.current = false
    }
  }, [])
  // headless 的更新 UI 不在首屏：保留原节流/重试语义，仅延后 2 秒让开首屏资源。
  useEffect(() => {
    if (!updateCheckOn) return
    if (!headless) { void checkUpdates(); return }
    const timer = window.setTimeout(() => { void checkUpdates() }, 2000)
    return () => window.clearTimeout(timer)
  }, [headless, updateCheckOn, checkUpdates])
  const copyUpgradeAi = async () => {
    const ok = await copyText(UPGRADE_AI)
    if (ok) { setUpdateCopied(true); setTimeout(() => setUpdateCopied(false), 2200) }
  }
  const skipUpdate = () => {
    if (updateInfo) {
      setSkipVersion(updateInfo.latest)
      setUpdateInfo(null)
    }
  }
  const toggleUpdateCheck = () => {
    setUpdateCheckOn((v) => {
      setAutoCheck(!v)
      return !v
    })
  }
  const [wsPreset, setWsPreset] = useState<string>(DEFAULT_PRESET_ID)
  const [wsName, setWsName] = useState('')
  /** 新建项目弹窗：所选模板 id（'' = 无模板；选模板则按模板流程实例化） */
  const [wsTemplate, setWsTemplate] = useState<string>('')
  /** 新建模板项目：起始步骤（0-based 下标；缺省 0 = 从头开始，之前步骤无需完成） */
  const [wsStartStep, setWsStartStep] = useState(0)
  /** 新建模板项目：L2 项目叠加层要素（写作语言）→ 生成 _项目验收叠加.md（仅论文写作模板用） */
  const [wsLang, setWsLang] = useState(PAPER_LANG_OPTIONS[0])
  /** 新建弹窗：所选模板 + 是否「迭代收敛」模板。收敛模板不显示论文专属字段（写作语言）
   *  与「从第几步开始」（单步无意义）。 */
  const wsTmplCur = wsTemplate ? templateById(wsTemplate) : undefined
  const wsIsConverge = !!wsTmplCur && wsTmplCur.steps.some((s) => isConvergeStep(s))
  const wsSingleStep = !!wsTmplCur && wsTmplCur.steps.length <= 1
  // 新建项目强制工作文件夹：经「选择位置…」弹窗选定（系统资源管理器式选择窗）
  const [wsFolderParent, setWsFolderParent] = useState('')
  const [wsFolderError, setWsFolderError] = useState(false)
  /** 文件夹选择器状态：busy=等待系统选择器；err=按入口分开的失败原因（用户取消不报错）；manual=手工输入展开目标 */
  const [pickBusy, setPickBusy] = useState(false)
  const [pickErr, setPickErr] = useState<{ add: string; bind: string }>({ add: '', bind: '' })
  const [manualPathFor, setManualPathFor] = useState<'add' | 'bind' | null>(null)
  const [manualPathText, setManualPathText] = useState('')
  /** 手机/窄屏的「浏览电脑文件夹」抽屉（与「电脑文件」附件同一个 PathBrowser，不触发电脑端系统选择器） */
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseStart, setBrowseStart] = useState('')
  const browseApplyRef = useRef<((p: string) => void) | null>(null)
  /** 文件夹选择在途锁 + 请求序号（useRef：跨渲染稳定；弹窗关闭/切换目标/手工确认时自增使旧请求失效） */
  const pickSeqRef = useRef(0)
  const pickBusyRef = useRef(false)
  /** 组件卸载后不再应用旧选择结果 */
  const mountedRef = useRef(true)
  /** 新建项目保存中（防连点：双击「创建项目」会建出两个同目录项目 + 两条会话） */
  const savingLayoutRef = useRef(false)
  useEffect(() => () => { mountedRef.current = false }, [])
  /** 新建项目弹窗：未选文件夹时默认 = 本机默认项目父目录（配置文件里的 newProjectParent）下以当前时间戳（YYYYMMDDHHmm）命名的子文件夹
   *  （打开弹窗时计算，弹窗显示的路径即将要创建的路径；保存成功后 wsFolderParent 清空，下次打开生成新时间戳）。
   *  「选择位置…」与「手动输入」保留，随时可改；父目录不存在时 mkdir 报错，用户可改选其它位置。
   *  regenerate=true（每次打开弹窗）= 上次自动生成的时间戳已经作废（弹窗没保存就关了），
   *  必须重新生成：否则再建项目会沿用同一个旧目录，两个项目叠在同一个文件夹里。手动选的路径不动。 */
  const prefillDefaultFolder = (regenerate = false) => {
    if (!regenerate && wsFolderParent) return
    void defaultProjectFolder().then((p) => {
      if (!mountedRef.current) return
      if (regenerate) setWsFolderParent((cur) => (cur && !isAutoProjectFolder(cur) ? cur : p))
      else if (!wsFolderParent) setWsFolderParent(p)
    })
  }
  /** 图标选择器：kind + 目标 id + 弹窗锚点坐标（fixed 定位） */
  const [iconPick, setIconPick] = useState<{ kind: 'layout' | 'shortcut' | 'project'; id: string; x: number; y: number } | null>(null)
  /** 对话绑定弹窗：项目 id + 锚点坐标；bindGroups = 打开时抓取的会话分组；
   *  bindListOpen = 右侧对话列表弹层（点「绑定对话」行弹出） */
  const [bindPick, setBindPick] = useState<{ id: string; x: number; y: number } | null>(null)
  const [bindGroups, setBindGroups] = useState<{ title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]>([])
  const [bindListOpen, setBindListOpen] = useState(false)
  /** 控制室强制绑定弹窗：未绑定点开「工作台」时弹出（左加入现有对话 / 右新建对话） */
  const [consoleBind, setConsoleBind] = useState<{ x: number; y: number } | null>(null)
  const [consoleGroups, setConsoleGroups] = useState<{ title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]>([])
  const [consoleMode, setConsoleMode] = useState<'none' | 'existing' | 'new'>('none')
  const [consoleWsId, setConsoleWsId] = useState('')
  const [consoleParent, setConsoleParent] = useState('')
  const [consoleName, setConsoleName] = useState('')
  const [consoleErr, setConsoleErr] = useState(false)
  const [consoleBusy, setConsoleBusy] = useState(false)

  /** 自定义布局弹窗（预设网格末尾的 ＋ 磁贴）：描述 → 复制提示词到剪贴板 */
  const [customOpen, setCustomOpen] = useState(false)
  const [customLayoutText, setCustomLayoutText] = useState('')
  const [copiedToast, setCopiedToast] = useState<'ok' | 'fail' | null>(null)
  const copyToastTimerRef = useRef<number | null>(null)
  /** 删除二次确认：kind + 目标 id + 显示名 */
  const [requestDelete, setRequestDelete] = useState<{ kind: 'layout' | 'shortcut' | 'project'; id: string; name: string } | null>(null)
  /** 变更视图：正在挑选新拓扑的布局 id */
  const [viewPickFor, setViewPickFor] = useState<string | null>(null)
  const [float, setFloat] = useState<FloatRect | null>(() =>
    view.dock === 'float' && view.floatTop != null ? { top: view.floatTop } : null,
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startY: number; startX: number; startRect: DOMRect; dragging: boolean; prevFloat: FloatRect | null } | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const [railRect, setRailRect] = useState<{ left: number; width: number } | null>(null)
  const [bottomInset, setBottomInset] = useState(0)
  const bottomInsetRef = useRef(0)
  const [floatGeo, setFloatGeo] = useState<{ left: number; width: number | null } | null>(null)
  const [sidebarRight, setSidebarRight] = useState<number | null>(null)
  const [activeSplitId, setActiveSplitId] = useState<string | null>(() =>
    splitStore.active && splitStore.spec ? splitStore.spec.id : null,
  )
  /** 供分栏引擎读取的最新项目快照（setSplitEnv 闭包取最新值用） */
  const projectsRef = useRef<{ projects: ProjectsState; metas: Record<string, ProjectMeta>; aliveRegisteredIds: string[] }>(
    { projects, metas, aliveRegisteredIds: registeredIds },
  )
  /** 控制室动作引用（每渲染同步，供 env 闭包读取） */
  const actionsRef = useRef<{ openSplit: (spec: LayoutSpec, opts?: { enter?: boolean }) => void; openConsole: (explicitBound?: string | null) => void } | null>(null)
  /** 提醒确认动作引用（每渲染同步；env 闭包用） */
  const ackRef = useRef<((projectId: string) => void) | null>(null)
  /** 临时卡片「正在运行」的最新镜像（getConsoleCards 刷新；会话列表 / 点开 / 新建会话复用） */
  const transientRowsRef = useRef<TransientRow[]>([])
  /** 视图状态最新快照（供 env 闭包读取控制室主题） */
  const viewRef = useRef(view)
  viewRef.current = view

  // ── 跨端同步（项目 + 控制室视图）：宿主 /api/assistant/state 为真值 ──
  // 手机与电脑各有自己的 localStorage，只靠本地存储永远不同步；这里首次拉取宿主状态，
  // 之后本地改动去抖推送、每 3 秒轮询另一端的改动。推送带 baseRevision，旧副本不会盖掉新状态；
  // 推/收按状态签名去重，避免「A 采纳 B 的状态后又把它推回去」的两端互推死循环。
  const syncReadyRef = useRef(false)
  const syncTimerRef = useRef<number | null>(null)
  const syncRevRef = useRef(0)
  const syncSigRef = useRef('')
  const syncPollBusyRef = useRef(false)
  /** 首次同步已完成（宿主状态已采纳）：私人助手卡片的建卡要等这个，否则会被采纳覆盖吃掉。 */
  const [syncReady, setSyncReady] = useState(false)
  /** 助手目录（宿主 /api/assistant/home）。 */
  const [assistantHome, setAssistantHome] = useState('')
  /** 私人助手卡片建卡尝试次数：被踩掉后允许补几次，不无限重试。 */
  const assistantCardTriesRef = useRef(0)
  /** 建卡失败的可见提示（P0-6）：只报一次，不每次重试都刷屏。 */
  const cardNoticeShownRef = useRef(false)
  const warnCardOnce = (reason: string): void => {
    try { console.warn('[dsh-assistant] 助手建卡失败：', reason) } catch { /* 没有 console */ }
    if (cardNoticeShownRef.current) return
    cardNoticeShownRef.current = true
    try { showToast('⚠️ 私人助手建卡失败：' + reason, 8000) } catch { /* 非浏览器环境 */ }
  }

  /** 采纳宿主状态（另一端的改动 / 冲突时的真值）：写本地并重载界面；签名同步记下，下一轮不再回声推送 */
  const adoptRemoteState = (st: any): void => {
    if (!st || !st.projects) return
    syncRevRef.current = Number(st.revision) || 0
    try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(st.projects)) } catch {}
    if (st.view) { try { localStorage.setItem(PERSIST_KEY, JSON.stringify(st.view)) } catch {} }
    const nextProjects = loadProjects()
    const nextView = st.view ? loadView() : viewRef.current
    setProjects(nextProjects)
    if (st.view) setView(nextView)
    syncSigRef.current = stateSigOf(nextProjects, viewForSync(nextView))
  }

  /** 推送时撞上 revision 冲突（另一端刚改过）：宿主状态 + 本机墓碑合并后再推一次。
   *  墓碑保证「刚删的项目」不会因为这次冲突又活过来；再次冲突就放弃本机这份改动，直接采纳宿主。 */
  const reconcileConflict = (st: any): void => {
    if (!st || !st.projects) return
    const merged = mergeProjects(st.projects, projectsRef.current.projects)
    adoptRemoteState({ ...st, projects: merged })
    void (async () => {
      try {
        const vw = viewForSync(st.view ?? viewRef.current)
        const res = await putRemoteState(merged, vw, Number(st.revision) || 0)
        if (res.conflict) adoptRemoteState(res.state)
        else {
          syncRevRef.current = Number(res.state?.revision) || 0
          syncSigRef.current = stateSigOf(loadProjects(), vw)
        }
      } catch { /* 下次改动再推 */ }
    })()
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/assistant/state', { cache: 'no-store' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const d = await r.json()
        const st = d?.state
        if (st && st.projects) {
          // 清单以宿主为准（并集会把另一端的旧副本并回来，已删项目就永远删不掉），墓碑取并集
          const merged = mergeProjects(st.projects, projectsRef.current.projects)
          if (!alive) return
          adoptRemoteState({ ...st, projects: merged })
          const vw = viewForSync(st.view ?? viewRef.current)
          const res = await putRemoteState(merged, vw, Number(st.revision) || 0)
          if (res.conflict) { if (alive) reconcileConflict(res.state) }
          else {
            syncRevRef.current = Number(res.state?.revision) || 0
            syncSigRef.current = stateSigOf(loadProjects(), vw)
          }
        } else {
          // 宿主为空：把本机数据推上去
          const pr = projectsRef.current.projects
          const vw = viewForSync(viewRef.current)
          const res = await putRemoteState(pr, vw, 0)
          if (res.conflict) { if (alive) reconcileConflict(res.state) }
          else {
            syncRevRef.current = Number(res.state?.revision) || 0
            syncSigRef.current = stateSigOf(pr, vw)
          }
        }
      } catch { /* 宿主不可用：退回纯本地模式 */ }
      if (alive) syncReadyRef.current = true
      if (alive) setSyncReady(true)
    })()
    return () => { alive = false }
  }, [])

  // 控制室打开时扫卡片进度：每 1.2 秒一批，数据只来自宿主会话日志（follow 只读、零 Token、不激活 Agent）。
  // 抓取范围：绑定会话 / 模板步骤会话（**空闲也要跟一次**：一轮结束后卡片必须从「工具调用 · …」
  // 换成那句最终答复）+ 项目文件夹下正在跑的会话。
  // 重抓时机：运行中（每轮跟）、刚跑完（settle 优先）、还没抓过、开了新一轮（updatedAt 前进）。
  // 行缓存带「轮次版本」：版本或运行态对不上就不拿旧行充数——手机上显示最终答复、电脑上却停在
  // 上一轮工具调用的那种两端不一致，根因就是旧实现把这份缓存当成了永久有效。
  useEffect(() => {
    const iv = window.setInterval(() => {
      try {
        // 用户在输入框里打字 / 语音实时转写，或抽屉正在开合：这一整轮先让路。
        // 1.2s 一轮的日志抓取（follow 读整段历史 + 计算预览文本）在手机上就是
        // 和 0.28s 的动画、和正在进行的 IME 组合抢主线程的那件事。
        if (domGate.isPaused()) return
        if (!controlRoomStore.getSnapshot() || document.visibilityState !== 'visible') return
        const pr = projectsRef.current.projects
        const snapById = sessionsSnapshotStore.snapshot?.byId ?? {}
        // 与卡片状态灯同一套「在跑」判定：快照 running 位 或 会话面还有未结束的轮次
        const running = (sid: string): boolean => sessionRunningNow(sid, snapById, () => new Set())
        const tracked = new Set<string>()
        for (const sid of Object.values(pr.bindings)) if (sid) tracked.add(sid)
        for (const run of Object.values(pr.flows ?? {})) {
          for (const sid of Object.values(run?.stepSessions ?? {})) {
            if (typeof sid === 'string' && sid) tracked.add(sid)
          }
        }
        // 项目文件夹下正在跑的会话（用户可能从「会话列表」进去跑，绑定会话是空闲的那条）
        const projectIds = new Set<string>([...Object.keys(pr.bindings), ...pr.layouts.map((l) => l.id)])
        for (const pid of projectIds) {
          const base = pr.folders[pid] || cwdOfSession(pr.bindings[pid])
          if (!base) continue
          for (const s of sessionIdsUnderFolder(base)) if (running(s)) tracked.add(s)
        }
        // 临时卡片「正在运行」的游离会话：运行中跟流式进度，刚结束抓最终答复；
        // 与项目卡片共用同一套缓存（按日志版本 + 运行态去重，不会每个 tick 重复抓）。
        for (const sid of transientTrackedIdsRef.current) tracked.add(sid)
        // 只挑「需要重抓」的：正在跑（每轮都要跟，流式）/ 没抓过 / 日志又长了一截 / 刚跑完
        const pending: { sid: string; key: string; wasRunning: boolean; settle: boolean }[] = []
        for (const sid of tracked) {
          const entry = activityCache.get(sid)
          const isRunning = running(sid)
          const key = activityKeyOf(sid)
          if (isRunning || !entry || entry.key !== key || entry.running !== isRunning) {
            // 刚跑完的那张卡优先：用户正等着看这一轮的最终答复
            pending.push({ sid, key, wasRunning: isRunning, settle: !isRunning && !!entry?.running })
          }
        }
        if (pending.length === 0) return
        pending.sort((a, b) => Number(b.settle) - Number(a.settle))
        // 一轮没跑完不叠下一轮（RPC 慢时 setInterval 会追上来，叠加会打满宿主）
        if (activitySweepBusy) return
        activitySweepBusy = true
        void (async () => {
          let changed = false
          try {
            // 每轮最多补 6 条：控制室首次打开时卡片可能全都没有缓存，分几轮补，避免瞬间打满宿主
            for (const item of pending.slice(0, 6)) {
              if (!controlRoomStore.getSnapshot() || document.visibilityState !== 'visible') break
              // 空闲会话只读日志（follow 不激活 Agent）；运行中的才允许退回会话面
              const line = await fetchLatestActivity(item.sid, { tailOnly: !item.wasRunning })
              const prev = activityCache.get(item.sid)
              // 刚跑完却什么都没抓到（日志读失败/这一轮没有可展示内容）→ 宁可清空走「最近成品消息」，
              // 也不能把上一轮的工具调用当作最终答复留在卡片上。
              const settleFailed = !!prev?.running && !item.wasRunning && !line
              const next: ActivityEntry = {
                line: settleFailed ? '' : (line || prev?.line || ''),
                key: item.key,
                running: item.wasRunning,
              }
              if (!prev || prev.line !== next.line || prev.key !== next.key || prev.running !== next.running) {
                activityCache.set(item.sid, next)
                changed = true
              }
            }
          } finally { activitySweepBusy = false }
          if (changed) notifyConsole()
        })()
      } catch {}
    }, 1200)
    return () => window.clearInterval(iv)
  }, [])

  // 本地改动 → 去抖推送（内容与上次同步等价就不推，避免采纳后回声）
  useEffect(() => {
    if (!syncReadyRef.current) return
    if (stateSigOf(projects, viewForSync(view)) === syncSigRef.current) return
    if (syncTimerRef.current != null) window.clearTimeout(syncTimerRef.current)
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null
      void (async () => {
        try {
          const pr = projectsRef.current.projects
          const vw = viewForSync(viewRef.current)
          const res = await putRemoteState(pr, vw, syncRevRef.current)
          if (res.conflict) reconcileConflict(res.state)
          else {
            syncRevRef.current = Number(res.state?.revision) || 0
            syncSigRef.current = stateSigOf(pr, vw)
          }
        } catch { /* 离线：本地仍生效，下次改动再推 */ }
      })()
    }, 800)
    return () => {
      if (syncTimerRef.current != null) { window.clearTimeout(syncTimerRef.current); syncTimerRef.current = null }
    }
  }, [projects, view])

  // 轮询另一端的改动（页面可见时）
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (domGate.isPaused()) return
      if (!syncReadyRef.current || document.visibilityState !== 'visible') return
      if (syncTimerRef.current != null || syncPollBusyRef.current) return
      syncPollBusyRef.current = true
      void (async () => {
        const ctrl = new AbortController()
        const timeout = window.setTimeout(() => ctrl.abort(), 8000)
        try {
          const r = await fetch('/api/assistant/state?sinceRevision=' + encodeURIComponent(String(syncRevRef.current)), { cache: 'no-store', signal: ctrl.signal })
          if (r.status === 204) return
          const d = await r.json()
          const st = d?.state
          if (!st || !st.projects) return
          const rev = Number(st.revision) || 0
          if (rev === syncRevRef.current) return
          adoptRemoteState(st)
        } catch {}
        finally {
          window.clearTimeout(timeout)
          syncPollBusyRef.current = false
        }
      })()
    }, 3000)
    return () => window.clearInterval(iv)
  }, [])

  /** 模板流程项目「当前应切入的步骤」（点卡片进入 / 新建会话目录 / 会话列表共用同一判定）：
   *  ① 当前待做步（有效区间内第一个未通过）**已开过专属会话** → 就是它（进度最新那一步优先）；
   *  ② 否则取最近一次「开始/通过」的步骤（例如第 9 步刚做完、第 10 步还没开始 → 仍是第 9 步）；
   *  ③ 都没有（全新项目尚未开始任何步骤）→ 首个待做步；全部通过 → 最后一步。
   *  非模板项目返回 null。 */
  const templateFlowStepOf = (pid: string): { step: TemplateStep; run: FlowRunState } | null => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[pid]
    if (!run) return null
    const tmpl = templateById(run.templateId)
    if (!tmpl || !Array.isArray(tmpl.steps) || tmpl.steps.length === 0) return null
    const startIndex = Math.min(Math.max(run.startIndex ?? 0, 0), Math.max(0, tmpl.steps.length - 1))
    const doneSet = new Set(run.done ?? [])
    const cur = tmpl.steps.find((s, i) => i >= startIndex && !doneSet.has(s.id))
    const orderKey = (s: { id: string }): number => {
      const k1 = (run as any).lastStartedAt?.[s.id]
      const k2 = (run as any).doneAt?.[s.id]
      if (k1 != null && k2 != null) return Math.max(k1, k2)
      return k1 ?? k2 ?? -Infinity
    }
    const recent = tmpl.steps
      .filter((s, i) => i >= startIndex && orderKey(s) > -Infinity)
      .sort((a, b) => orderKey(b) - orderKey(a))[0]
    const step = (cur && run.stepSessions?.[cur.id]) ? cur : (recent ?? cur ?? tmpl.steps[tmpl.steps.length - 1])
    return step ? { step, run } : null
  }

  /** 模板项目「最新阶段」的步骤子目录：与 preferredSessionOf 同源判定，保证
   *  新建对话落在「打开该项目时切到的那一步」目录里；非模板项目或没有根目录时返回 ''。 */
  const latestStepDirOf = (pid: string): string => {
    const root = projectsRef.current.projects.folders[pid]
    const parsed = templateFlowStepOf(pid)
    if (!root || !parsed) return ''
    return joinPath(root, parsed.step.dir)
  }

  /** 某个项目目录下的全部会话（含模板各步骤子目录）。排序与「点卡片进入哪条会话」同一套判定
   *  （置顶 > 等你回答 > 正在跑 > 异常 > 空闲按最近更新倒序），所以浮层第一行就是点卡片会进的那条。
   *  数据源：宿主会话快照 ctx.sessions.list 的 byId[sid]（cwd / displayTitle / running / updatedAt）——
   *  纯客户端只读镜像，零 Token、无需新路由。目录基准取项目文件夹（模板项目取根，从而覆盖各步骤子目录）；
   *  内置控制室没有项目文件夹，则用它自己对话所在的目录。子代理会话不列出。 */
  const projectSessionsOf = (pid: string): ProjectSessionItem[] => {
    const pr = projectsRef.current.projects
    // 置顶/归档状态：宿主工作区集合（归档的会话默认不进列表，由浮层「显示已归档」开关控制）
    let archived: Set<string> = new Set()
    let pinned: Set<string> = new Set()
    try {
      const wsnap = sessionBridge?.workspaces?.list?.getSnapshot?.()
      if (Array.isArray(wsnap?.archivedSessionIds)) archived = new Set(wsnap.archivedSessionIds.map(String))
      if (Array.isArray(wsnap?.pinnedSessionIds)) pinned = new Set(wsnap.pinnedSessionIds.map(String))
    } catch {}
    // 临时卡片：没有项目文件夹，列表直接取 getConsoleCards 刚算好的游离会话镜像
    if (pid === RUNNING_CARD_ID) {
      const snap = sessionBridge?.list?.getSnapshot?.()
      const current = currentSessionId(snap?.current ?? '')
      const out = transientRowsRef.current.map((r) => ({
        id: r.id,
        title: r.title,
        rel: normalizeFolderPath(r.cwd),
        current: r.id === current,
        running: r.running,
        awaiting: r.awaiting,
        blank: false,
        updatedAt: r.updatedAt,
        pinned: pinned.has(r.id),
        archived: false,
        finished: r.finished,
      }))
      return sortSessionsByActivity(out)
    }
    const base = pr.folders[pid] || cwdOfSession(pr.bindings[pid]) || ''
    if (!base) return []
    const snap = sessionBridge?.list?.getSnapshot?.()
    const byId: Record<string, any> = snap?.byId ?? {}
    const ids: string[] = Array.isArray(snap?.ids) ? snap.ids : Object.keys(byId)
    const current: string = currentSessionId(snap?.current ?? '')
    const index = sessionSnapshotIndexOf(snap)
    const noKids: Set<string> = new Set()
    const kidsOf = (sid: string): Set<string> => index.kidsByParent.get(sid) ?? noKids
    // 会话面 pending 兜底（旧宿主没有 pendingInteraction 登记时唯一的通道）：同一列表内只探一次
    const faceCache = new Map<string, any>()
    const faceOf = (sid: string): any => {
      if (!faceCache.has(sid)) faceCache.set(sid, sessionFaceSnapshotOf(sid))
      return faceCache.get(sid) ?? null
    }
    const norm = (p: unknown) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const baseN = norm(base)
    if (!baseN) return []
    // Windows 路径大小写不敏感（盘符 D: / d: 混用很常见）：比对键统一小写，
    // 但 rel 仍用原串切片（大小写不同 => 长度相同，切片安全）。
    const baseKey = baseN.toLowerCase()
    const out: ProjectSessionItem[] = []
    for (const sid of ids) {
      const e = byId[sid]
      if (!e) continue
      if (e.parentId || e.origin === 'subagent') continue
      const cwd = norm(e.cwd)
      if (!cwd) continue
      const key = cwd.toLowerCase()
      if (key !== baseKey && !key.startsWith(baseKey + '/')) continue
      const isArchived = archived.has(sid)
      // 活跃度判定与卡片同一口径：等你回答（黄）> 正在跑（蓝）> 其余。归档会话不可能在跑，跳过探测。
      const flags = isArchived ? { awaiting: false, running: false } : {
        awaiting: sessionAwaitingFlag(sid, byId, kidsOf, faceOf),
        running: sessionRunningFlag(sid, byId, kidsOf),
      }
      out.push({
        id: sid,
        title: (typeof e.displayTitle === 'string' && e.displayTitle) || (typeof e.title === 'string' && e.title) || '',
        rel: key === baseKey ? '' : cwd.slice(baseN.length + 1),
        current: sid === current,
        running: flags.running,
        awaiting: flags.awaiting,
        blank: e.blank === true,
        updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
        pinned: pinned.has(sid),
        archived: isArchived,
      })
    }
    return sortSessionsByActivity(out)
  }

  /** 全局（不要求控制室打开）跟踪游离会话的「跑 → 停」：
   *  首次见到只建立基线；观察到 running 变 false 时记结束时间；新一轮开始删除旧结束时间。
   *  数据持久化，宿主重启后仍能按真实结束时间为临时卡片保留结果。 */
  const trackTransientLifecycles = (): void => {
    const snap = sessionsSnapshotStore.snapshot
    if (!snap) return
    const byId: Record<string, any> = snap.byId ?? {}
    const ids: string[] = Array.isArray(snap.ids) ? snap.ids : Object.keys(byId)
    const pr = projectsRef.current.projects
    const owned = new Set<string>()
    const removed = new Set(pr.removed ?? [])
    const known = new Set<string>([CONSOLE_ID, ...projectsRef.current.aliveRegisteredIds, ...pr.layouts.map((l) => l.id)])
    for (const [pid, sid] of Object.entries(pr.bindings)) {
      if (removed.has(pid) || !known.has(pid)) continue
      if (typeof sid === 'string' && sid) owned.add(sid)
    }
    for (const [pid, run] of Object.entries(pr.flows ?? {})) {
      if (removed.has(pid) || !known.has(pid)) continue
      for (const sid of Object.values(run?.stepSessions ?? {})) if (typeof sid === 'string' && sid) owned.add(sid)
    }
    let archived = new Set<string>()
    try {
      const wsnap = sessionBridge?.workspaces?.list?.getSnapshot?.()
      if (Array.isArray(wsnap?.archivedSessionIds)) archived = new Set(wsnap.archivedSessionIds.map(String))
    } catch {}
    const folders = projectOwnedFolders(projectsRef.current)
    const roots = unownedSessionIds(ids, byId, folders, owned, archived)
    const present = new Set(roots)
    // 与卡片同一个「在跑」口径：根会话在跑 / 子代理在跑 / 会话面还有未结束轮次
    const { kidsByParent } = sessionSnapshotIndexOf(snap)
    const noKids = new Set<string>()
    const kidsOf = (sid: string): Set<string> => kidsByParent.get(sid) ?? noKids
    const now = Date.now()
    for (const sid of roots) {
      // 与卡片同一口径：宿主明确 completed 且不在 running 时，残留的未结束轮次不算「还在跑」
      const running = sessionRunningFlag(sid, byId, kidsOf)
      // 停在「等用户决策」不算结束：否则等很久后再回答并秒完成，卡片会因旧结束时间过期而看不到结果
      const awaiting = sessionAwaitingDecision(sid)
      const active = running || awaiting
      const prev = transientLifecycle.prevRunning.get(sid)
      if (active) {
        transientLifecycle.prevRunning.set(sid, true)
        if (transientLifecycle.finishedAt.delete(sid)) transientFinishDirty = true
      } else {
        if (prev === true) {
          transientLifecycle.finishedAt.set(sid, now)
          transientFinishDirty = true
        }
        transientLifecycle.prevRunning.set(sid, false)
      }
    }
    for (const sid of transientLifecycle.prevRunning.keys()) {
      if (!present.has(sid)) transientLifecycle.prevRunning.delete(sid)
    }
    // 已被项目卡片 / 归档收编的会话不再属于临时卡片：清掉旧结束记录，避免以后解除绑定时在卡片里“复活”
    for (const sid of transientLifecycle.finishedAt.keys()) {
      if (!present.has(sid) && byId[sid]) {
        transientLifecycle.finishedAt.delete(sid)
        transientFinishDirty = true
      }
    }
    saveTransientFinished()
  }

  /** 临时卡片「＋」新建会话的目录：优先正在跑的那条游离会话所在目录，
   *  否则当前会话目录（同目录续开）；都取不到时交给宿主默认目录。 */
  const transientFolder = (): string => {
    const rows = transientRowsRef.current
    const pool = rows.filter((r) => r.running || r.awaiting)
    const sorted = [...(pool.length > 0 ? pool : rows)].sort((a, b) => b.updatedAt - a.updatedAt)
    return sorted[0]?.cwd || sessionScopeStore.snapshot?.cwd || ''
  }

  /** 临时卡片「收工」：把已结束的会话从卡片移除并清掉其异常标记；运行中/待决的一律不动。
   *  这是临时卡片唯一的移除方式（不再按时间自动消失）。 */
  const dismissTransient = (ids: string[]): void => {
    const rows = transientRowsRef.current
    const finished = new Set(rows.filter((r) => r.finished).map((r) => r.id))
    const target = ids.filter((sid) => finished.has(sid))
    if (target.length === 0) return
    const now = Date.now()
    const map = loadTransientDismissed()
    for (const sid of target) map[sid] = now
    saveTransientDismissed(map)
    // 删掉结束时刻：即使 7 天后 dismissed 记录被清理，也不会因为旧的结束时刻再次出现
    for (const sid of target) if (transientLifecycle.finishedAt.delete(sid)) transientFinishDirty = true
    saveTransientFinished()
    clearAgentErrors(target)
    transientRowsRef.current = rows.filter((r) => !target.includes(r.id))
    notifyConsole()
  }

  /** 临时卡片点开/点发光：确认本轮完成/待决（只熄光，不移除；移除走「收工」）。 */
  const ackTransientCard = (): void => {
    for (const r of transientRowsRef.current) {
      if (r.awaiting) saveNotifyAck(r.id, 'need')
      else if (r.done) saveNotifyAck(r.id, 'done')
    }
    clearAgentErrors(transientRowsRef.current.filter((r) => r.error).map((r) => r.id))
  }

  /** 从「会话列表」进入某个会话：宿主照常加载它的历史，可直接继续对话；不改项目绑定（只切会话） */
  const openProjectSession = (sid: string): void => {
    if (!sid) return
    controlRoomStore.setOpen(false)
    markPluginSessionOpen(sid) // 插件发起的切换：不触发「切会话关项目」联动
    openSessionInHost(sid)
    notifyConsole()
  }

  /** 删除「会话列表」里的某条会话：走宿主 workspace 归档——从各列表（含宿主侧边栏）移除，
   *  磁盘日志保留（宿主没有真删接口，归档即宿主语义的删除）。失败仅告警，浮层项已由调用方先行移除。 */
  const deleteProjectSession = (sid: string): void => {
    if (!sid) return
    const done = () => notifyConsole()
    try {
      const r = sessionBridge?.workspaces?.archiveSession?.(sid)
      if (r && typeof (r as Promise<void>).then === 'function') {
        ;(r as Promise<void>).then(done, (err: unknown) => { console.warn('[dsh-worktable] 会话删除(归档)失败：', err); done() })
      } else done()
    } catch (err) { console.warn('[dsh-worktable] 会话删除(归档)失败：', err); done() }
  }

  /** 重命名某条会话：宿主 rename 是 per-session 动词，经 binding 按 id 解析实例（无需打开会话）。
   *  成功后宿主会推送 title 投影，会话列表自动刷新。 */
  const renameProjectSession = (sid: string, title: string): void => {
    if (!sid || !title) return
    const done = () => notifyConsole()
    ;(async () => {
      try {
        const session = sessionBridge?.sessions?.binding?.(sid)?.session
        if (!session || typeof session.rename !== 'function') { console.warn('[dsh-worktable] 会话重命名：无法解析会话实例', sid); return }
        const result = await session.rename(title)
        if (result && result.ok === false) console.warn('[dsh-worktable] 会话重命名失败：', result.error)
      } catch (err) { console.warn('[dsh-worktable] 会话重命名失败：', err) }
    })().finally(done)
  }

  /** 分叉某条会话：宿主在同 cwd 建子会话（durable 标题自动 +1，如「标题 (1)」），返回子会话 id；失败返回 null。
   *  子会话与源会话同目录，会出现在同一项目的「会话列表」里。 */
  const forkProjectSession = async (sid: string): Promise<string | null> => {
    if (!sid) return null
    try {
      const child = await sessionBridge?.sessions?.fork?.({ sessionId: sid, increaseTitle: true })
      if (typeof child === 'string' && child) { notifyConsole(); return child }
      console.warn('[dsh-worktable] 会话分叉未返回子会话 id')
    } catch (err) { console.warn('[dsh-worktable] 会话分叉失败：', err) }
    notifyConsole()
    return null
  }

  /** 卡片「＋ 新建会话」的目标目录（按优先级）：
   *  ① 模板项目「最新阶段」的步骤子目录（与流程面板/打开项目切到的步骤一致，不落在项目根目录）；
   *  ② 项目自己的文件夹 projects.folders[pid]（普通项目恒有，保证与建项目时选定的目录一致）；
   *  ③ 该项目当前绑定对话的工作目录（控制室这类**内置项目没有项目文件夹**，沿用它自己的对话目录）；
   *  ④ 当前会话的工作目录（兜底）。
   *  返回 '' = 都取不到，此时创建会话交给宿主默认目录（控制室卡片仍要保证「＋」可用）。 */
  const newSessionFolderOf = (pid: string): string => {
    // 临时卡片没有项目文件夹：在「正在跑的那条游离会话」目录续开；会让新任务继续落在这张卡片里
    if (pid === RUNNING_CARD_ID) return transientFolder()
    const pr = projectsRef.current.projects
    const stepDir = latestStepDirOf(pid)
    if (stepDir) return stepDir
    return pr.folders[pid] || cwdOfSession(pr.bindings[pid]) || sessionScopeStore.snapshot?.cwd || ''
  }

  /** 控制室卡片的展示顺序（不含内置控制室卡片）：projects.order 里存过序的在前，
   *  其余按「入驻项目 → 布局项目」的注册序补在后面。卡片网格 / 项目管理面板 / 排序共用这一份。 */
  const projectDisplayOrder = (): string[] => {
    const pr = projectsRef.current
    const ids = [...pr.aliveRegisteredIds, ...pr.projects.layouts.map((l) => l.id)].filter((id) => id !== CONSOLE_ID && id !== RUNNING_CARD_ID)
    const known = new Set(ids)
    const stored = pr.projects.order.filter((id) => known.has(id))
    return [...stored, ...ids.filter((id) => !stored.includes(id))]
  }

  /** 拖动排序：把 dragId 插到 targetId 之前（before=true）或之后。
   *  只调整控制室卡片顺序（写 projects.order，随状态同步到手机端）。 */
  const reorderProject = (dragId: string, targetId: string, before: boolean): void => {
    if (!dragId || !targetId || dragId === targetId) return
    const list = projectDisplayOrder()
    const from = list.indexOf(dragId)
    if (from < 0) return
    const next = [...list]
    next.splice(from, 1)
    let to = next.indexOf(targetId)
    if (to < 0) return
    if (!before) to += 1
    next.splice(to, 0, dragId)
    persistProjects((prev) => ({ ...prev, order: next }))
    notifyConsole()
  }

  /** 控制室卡片数据组装（env 闭包调用；只读镜像：状态/时长/子代理/预览全部来自宿主内存快照，零轮询零 Token） */
  const getConsoleCards = (): ConsoleCardData[] => {
    const pr = projectsRef.current
    const snap = sessionsSnapshotStore.snapshot
    const byId: Record<string, any> = snap?.byId ?? {}
    const jobsMap: Record<string, any[]> = snap?.jobsBySession ?? {}
    const now = Date.now()
    // 同一张网格里项目卡片、临时卡片会共享会话；本轮组装内复用判定与进度，
    // 避免同一会话被重复扫描事件窗口 / 会话面。缓存不跨快照，语义保持实时。
    const runningMemo = new Map<string, boolean>()
    const awaitingMemo = new Map<string, boolean>()
    const activityMemo = new Map<string, string>()
    // 父子 / 目录索引按宿主快照共享：卡片、临时会话生命周期和侧栏提醒只构建一次。
    const { kidsByParent, folderRows, snapshotIds } = sessionSnapshotIndexOf(snap)
    const noKids = new Set<string>()
    const kidsSetOf = (sid: string): Set<string> => kidsByParent.get(sid) ?? noKids
    // 各项目从自己缓存的目录结果取会话，不重复过滤整张快照。
    const folderCache = new Map<string, string[]>()
    const sessionIdsForFolder = (base: string): string[] => {
      const normalized = normalizeFolderPath(base)
      if (!normalized) return []
      const cached = folderCache.get(normalized)
      if (cached) return cached
      const key = normalized.toLowerCase()
      const out = folderRows.filter((row) => row.key === key || row.key.startsWith(key + '/')).map((row) => row.id)
      folderCache.set(normalized, out)
      return out
    }
    // 项目关联会话：绑定会话 + 模板步骤会话（去重；绑定会话恒在首位，need/done/ack 只看它）
    const sidsOf = (pid: string): string[] => {
      const out: string[] = []
      const b = pr.projects.bindings[pid]
      if (b) out.push(b)
      const fr = pr.projects.flows?.[pid]
      if (fr?.stepSessions) {
        for (const sid of Object.values<any>(fr.stepSessions)) {
          if (typeof sid === 'string' && !out.includes(sid)) out.push(sid)
        }
      }
      return out
    }
    // 异常终止（红）：会话面 lastAgentError；新一次运行开始 / 用户点开项目确认时清除
    const errs = loadAgentErrors()
    let errsDirty = false
    const faceCache = new Map<string, any>()
    const faceOf = (sid: string): any => {
      if (faceCache.has(sid)) return faceCache.get(sid)
      const face = sessionFaceSnapshotOf(sid)
      faceCache.set(sid, face)
      return face
    }
    const noteAgentError = (sid: string, running: boolean): boolean => {
      const face = faceOf(sid)
      if (!face) return errs[sid] === '1'
      if (running) {
        if (errs[sid]) { delete errs[sid]; errsDirty = true }
        return false
      }
      if (typeof face.lastAgentError === 'string' && face.lastAgentError.trim() !== '') {
        if (!errs[sid]) { errs[sid] = '1'; errsDirty = true }
        return true
      }
      return errs[sid] === '1'
    }
    // 项目「关联会话」全集（状态灯 / 中间进度 / 运行时长共用）：
    //   绑定会话 + 模板步骤会话 + **项目文件夹下的全部会话**。
    //   需求（2026-10-26）：只要有会话正在运行，卡片就必须亮状态（绿=跑、黄=等决策），
    //   不能只看绑定会话——用户从「会话列表」进去跑任务时，绑定会话可能是空闲的那条。
    const relatedCache = new Map<string, string[]>()
    const relatedSidsOf = (pid: string): string[] => {
      const hit = relatedCache.get(pid)
      if (hit) return hit
      const out = sidsOf(pid)
      const base = pr.projects.folders[pid] || cwdOfSession(out[0])
      if (base) for (const s of sessionIdsForFolder(base)) if (!out.includes(s)) out.push(s)
      relatedCache.set(pid, out)
      return out
    }
    /** 是否在等用户决策（黄）：pendingInteraction / 待决登记 / 会话面 pending / 子代理待决 */
    const awaitingOf = (sid: string): boolean => {
      if (!sid) return false
      const cached = awaitingMemo.get(sid)
      if (cached !== undefined) return cached
      const result = sessionAwaitingFlag(sid, byId, kidsSetOf, faceOf)
      awaitingMemo.set(sid, result)
      return result
    }
    /** 关联会话的子代理总数（去重） */
    const kidsOfAll = (sids: string[]): number => {
      const all = new Set<string>()
      for (const s of sids) for (const c of kidsSetOf(s)) all.add(c)
      return all.size
    }
    /** 「此刻在跑」：宿主 running 位为准；已完成且宿主没在跑的不算（避免残留未结束轮次把卡片骗成绿色） */
    const isRunning = (sid: string): boolean => {
      const cached = runningMemo.get(sid)
      if (cached !== undefined) return cached
      const e = byId[sid]
      const result = e?.completed === true && e?.running !== true
        ? false
        : sessionRunningNow(sid, byId, kidsSetOf)
      runningMemo.set(sid, result)
      return result
    }
    // 三态判定（同卡片提醒逻辑，但不过滤 ack——监控室永远显示事实状态）
    // 优先级：黄（待决策）> 红（异常终止）> 绿（有会话在跑）> 青（绑定会话已完成）> 空闲
    const statusOf = (pid: string): ConsoleCardData['status'] => {
      const sids = relatedSidsOf(pid)
      const bound = pr.projects.bindings[pid]
      // 黄：任意关联会话在等用户决策（含模板步骤会话 / 子代理）
      for (const s of sids) if (awaitingOf(s)) return 'need'
      // 异常终止（红）：会话面 lastAgentError；新一次运行开始 / 用户点开项目确认时清除
      for (const s of sids) noteAgentError(s, isRunning(s))
      if (bound) {
        if (isRunning(bound)) {
          for (const cid of kidsSetOf(bound)) noteAgentError(cid, true)
        } else if (noteAgentError(bound, false)) return 'error'
        for (const cid of kidsSetOf(bound)) {
          if (!byId[cid]?.running && noteAgentError(cid, false)) return 'error'
        }
      }
      // 绿：任意关联会话在跑（含子代理与未结束轮次）——必须排在「已完成」之前，
      // 否则「一条跑完、另一条还在跑」的项目会被显示成已完成（用户看到的假绿/假青）
      if (sids.some((s) => isRunning(s))) return 'busy'
      if (bound) {
        if (byId[bound]?.completed === true) return 'done'
        // 会话面兜底：宿主快照可能滞后或缺少完成字段
        try {
          const face = faceOf(bound)
          if (face && face.completed === true) return 'done'
        } catch {}
      }
      return 'idle'
    }
    // 运行时长：工作中会话的后台任务最早 startedAt 起算；无任务时读会话面 turnTimings 未结束轮次
    const runningStartOf = (sid: string): number | null => {
      let start: number | null = null
      const jobs = jobsMap[sid] ?? []
      for (const j of jobs) {
        if (j?.status === 'running' && typeof j.startedAt === 'number' && (start == null || j.startedAt < start)) start = j.startedAt
      }
      if (start != null) return start
      try {
        const face = sessionFaceSnapshotOf(sid)
        const timings = face?.turnTimings
        if (timings instanceof Map) {
          for (const t of Array.from(timings.values()).reverse()) {
            if (t && typeof t.startTime === 'number' && t.endTime == null) { start = t.startTime; break }
          }
        } else if (timings && typeof timings === 'object') {
          for (const k of Object.keys(timings).reverse()) {
            const t = (timings as any)[k]
            if (t && typeof t.startTime === 'number' && t.endTime == null) { start = t.startTime; break }
          }
        }
      } catch {}
      return start
    }
    const runtimeOfPid = (pid: string): number | null => {
      const sids = relatedSidsOf(pid)
      if (!sids.some((s) => isRunning(s))) return null
      let start: number | null = null
      for (const sid of sids) {
        if (!isRunning(sid)) continue
        const s = runningStartOf(sid)
        if (s != null && (start == null || s < start)) start = s
      }
      return start != null ? Math.max(0, now - start) : null
    }
    const ackMap = loadNotifyAck()
    /** 按给定会话顺序取「最新一条进度」：本端事件窗口 → 宿主日志行（版本匹配）→ 最近一条消息。
     *  项目卡片与临时卡片共用，避免两套判定漂移；顺序由 progressOrderOf 按会话优先级给出。 */
    const activityTextOf = (order: string[]): string => {
      for (const s of order) {
        // 1) 本端打开过的会话：本地事件窗口与聊天详情同源（含逐字输出的 live chunk），最新也最准
        let live = activityMemo.get(s)
        if (live === undefined) {
          live = latestActivityOf(s)
          activityMemo.set(s, live)
        }
        if (live) return live
        // 2) 从宿主日志抓来的那行：只有版本与当前会话一致才用。
        //    版本落后 = 有一轮新内容还没抓，宁可先不显示，也不能把上一轮的工具调用当成「最新」。
        const isRun = isRunning(s)
        const entry = activityCache.get(s)
        // 缓存只在这两种情况下可信：行还是这一轮的；或是此刻仍在跑（流式行本来就一直在变）
        if (entry && entry.line && entry.key === activityKeyOf(s) && (!entry.running || isRun)) return entry.line
        // 3) 最近一条消息（冷会话预热；也可能是这一轮之前的答复——按优先级轮到它时该显示它）
        const preview = previewCache.get(s)
        if (preview) return preview
      }
      return ''
    }
    const make = (id: string, name: string, icon: string, self: boolean): ConsoleCardData => {
      const sid = pr.projects.bindings[id]
      // 模板项目的任务跑在「步骤会话」里，绑定会话可能为空：预览取正在跑/最近一步的步骤会话
      const stepSids = pr.projects.flows?.[id]?.stepSessions
        ? Object.values(pr.projects.flows[id].stepSessions).filter((x): x is string => typeof x === 'string' && !!x)
        : []
      const related = relatedSidsOf(id)
      // 子代理（后台跑的 subagent）也是「这个项目在干活」的一部分：它们的实时进度才是用户想看到的，
      // 父会话在等子代理时自己是空闲的（节点停在一条 subagent 工具调用上）。
      const kidIds: string[] = []
      for (const s of related) {
        for (const c of kidsSetOf(s)) if (!related.includes(c) && !kidIds.includes(c)) kidIds.push(c)
      }
      const candidates = [...related, ...kidIds]
      // 正在跑的会话（可能不止一条）：按最近更新时间排，最新动的那条优先显示
      const running = related.filter((s) => isRunning(s))
      const runningLive = running.length > 0
      // 按活跃度把这条项目的关联会话排好序（待决策 > 正在跑 > 异常 > 空闲，同档取最近更新）：
      // 卡片中间那块进度就按这个优先级依次找，**第一条拿得到内容的**就是显示的那条。
      // 原来这里为「排序」和「挑进入的那条」各建一份对象数组、各排一次；同输入同结果 → 共用一次。
      const rows = related.map((s) => ({
        id: s,
        updatedAt: Number(byId[s]?.updatedAt ?? 0) || 0,
        running: isRunning(s),
        awaiting: awaitingOf(s),
      }))
      const rankedRelated = sortSessionsByActivity(rows).map((r) => r.id)
      // 卡片点开时进入的那一条 = 「待决策 > 正在跑」里最活动的一条，与 preferredSessionOf 的①同一判定
      //（只按 related 判定、不含 kids：点卡片永远不会进子代理会话）。
      const enteredPick = pickActiveSession(rows, currentSessionId())?.id ?? null
      const enteredActive = enteredPick !== null && (isRunning(enteredPick) || awaitingOf(enteredPick))
      const status = statusOf(id)
      // 进度文本 = 优先级最高那条会话的**最新消息**（拿不到就往下一条优先级会话走，
      // 一条都拿不到才显示「正在执行…」）。绝不用某条低优先级旧会话的内容冒充高优先级那条。
      const order = progressOrderOf({
        enteredPick,
        kidsOf: (s) => kidsSetOf(s),
        bound: sid ?? null,
        steps: stepSids,
        candidates: [...rankedRelated, ...kidIds],
      })
      const activityText = activityTextOf(order)
      const previewText = activityText || ((enteredActive || runningLive || status === 'busy' || status === 'need') ? (t('console.liveRunning') || '正在执行…') : '')
      // 发光 = 完成/待决且本轮未被确认；点卡片确认后熄灭
      const glow = !!sid && ((status === 'done' && ackMap[sid] !== 'done') || (status === 'need' && ackMap[sid] !== 'need'))
      return {
        id, name, icon,
        status,
        runtimeMs: runtimeOfPid(id),
        kids: kidsOfAll(related),
        preview: previewText,
        // 流式标记：中间那块进度来自「点开的那条会话」或正在跑的会话，随活动缓存持续刷新
        live: enteredActive || runningLive,
        bound: !!sid,
        // 内置项目（控制室）恒提供「＋」：它没有项目文件夹，目录由 newSessionFolderOf 逐级回退解析
        canNewSession: self || !!newSessionFolderOf(id),
        self,
        glow,
      }
    }
    // ── 临时卡片「正在运行」：不属于任何项目文件夹 / 绑定 / 模板步骤的会话 ──
    // 出现：只要有游离会话在跑 / 等决策 → 常驻。
    // 结束：一直保留在卡片上，直到用户手动「收工」；不再按时间自动消失。
    //       会话本身仍完整保留在侧栏，不删除任何记录。
    transientRowsRef.current = []
    transientTrackedIdsRef.current = []
    const transientRows: TransientRow[] = []
    try {
      const owned = new Set<string>()
      const removed = new Set(pr.projects.removed ?? [])
      const known = new Set<string>([CONSOLE_ID, ...pr.aliveRegisteredIds, ...pr.projects.layouts.map((l) => l.id)])
      for (const [pid, sid] of Object.entries(pr.projects.bindings)) {
        if (removed.has(pid) || !known.has(pid)) continue
        if (typeof sid === 'string' && sid) owned.add(sid)
      }
      for (const [pid, run] of Object.entries(pr.projects.flows ?? {})) {
        if (removed.has(pid) || !known.has(pid)) continue
        for (const sid of Object.values(run?.stepSessions ?? {})) if (typeof sid === 'string' && sid) owned.add(sid)
      }
      let archived = new Set<string>()
      try {
        const wsnap = sessionBridge?.workspaces?.list?.getSnapshot?.()
        if (Array.isArray(wsnap?.archivedSessionIds)) archived = new Set(wsnap.archivedSessionIds.map(String))
      } catch {}
      const folders = projectOwnedFolders(pr)
      const roots = unownedSessionIds(snapshotIds, byId, folders, owned, archived)
      const dismissed = loadTransientDismissed()
      for (const sid of roots) {
        const entry = byId[sid]
        if (!entry) continue
        const running = isRunning(sid)
        const awaiting = awaitingOf(sid)
        const updatedAt = Number(entry.updatedAt) || 0
        let done = entry.completed === true
        if (!done) {
          try { done = faceOf(sid)?.completed === true } catch {}
        }
        const error = noteAgentError(sid, running)
        // 可见性（收工 / 空白会话 / 结束收纳）统一由纯函数判定，便于单测与两端一致
        const vis = transientVisibility({
          running,
          awaiting,
          done,
          error,
          blank: entry.blank === true,
          updatedAt,
          observedFinishedAt: transientLifecycle.finishedAt.get(sid) ?? 0,
          dismissedAt: Number(dismissed[sid]) || 0,
          now,
          doneFallbackMs: TRANSIENT_DONE_FALLBACK_MS,
          errorFallbackMs: TRANSIENT_ERROR_FALLBACK_MS,
        })
        if (!vis.show) continue
        transientRows.push({
          id: sid,
          title: (typeof entry.displayTitle === 'string' && entry.displayTitle)
            || (typeof entry.title === 'string' && entry.title) || '',
          cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
          updatedAt,
          running,
          awaiting,
          done,
          error,
          finished: vis.finished,
        })
      }
    } catch { /* 临时卡片计算失败不影响已创建项目的卡片 */ }
    const ranked = sortSessionsByActivity(transientRows)
    transientRowsRef.current = ranked
    transientTrackedIdsRef.current = ranked.map((r) => r.id)
    let transientCard: ConsoleCardData | null = null
    if (ranked.length > 0) {
      // 卡片点开时进入的那一条 = 待决策 / 正在跑里最活动的一条（与浮层列表第一行同一判定）
      const pick = pickActiveSession(ranked) ?? ranked[0]
      // 优先级最高那条的最新消息先显示；那条没有内容才往下一条优先级会话找
      //（ranked 本身已按活跃度排好序），一条都没有才落到「正在执行…」。
      const order = progressOrderOf({
        enteredPick: pick === undefined ? null : pick.id,
        kidsOf: (s) => kidsSetOf(s),
        candidates: ranked.map((r) => r.id),
      })
      const text = activityTextOf(order)
      const anyNeed = ranked.some((r) => r.awaiting)
      const anyBusy = ranked.some((r) => r.running)
      const anyError = ranked.some((r) => r.error)
      const anyDone = ranked.some((r) => r.done)
      const status: ConsoleCardData['status'] = anyNeed ? 'need' : anyBusy ? 'busy' : anyError ? 'error' : anyDone ? 'done' : 'idle'
      let start: number | null = null
      for (const r of ranked) {
        if (!r.running) continue
        const s = runningStartOf(r.id)
        if (s != null && (start == null || s < start)) start = s
      }
      const glow = (status === 'need' && ranked.some((r) => r.awaiting && ackMap[r.id] !== 'need'))
        || (status === 'done' && ranked.some((r) => r.done && ackMap[r.id] !== 'done'))
      transientCard = {
        id: RUNNING_CARD_ID,
        name: RUNNING_CARD_NAME,
        icon: RUNNING_CARD_ICON,
        status,
        runtimeMs: start != null ? Math.max(0, now - start) : null,
        kids: kidsOfAll(ranked.map((r) => r.id)),
        preview: text || ((anyBusy || anyNeed) ? (t('console.liveRunning') || '正在执行…') : ''),
        live: anyBusy,
        bound: true,
        canNewSession: true,
        self: false,
        glow,
        count: transientRows.length,
        temp: true,
      }
    }
    const cards: ConsoleCardData[] = []
    cards.push(make(CONSOLE_ID, t('console.name'), CONSOLE_ICON, true))
    if (transientCard) cards.push(transientCard)
    const ordered = projectDisplayOrder()
    const layoutById = new Map(pr.projects.layouts.map((layout) => [layout.id, layout]))
    for (const id of ordered) {
      if (pr.projects.hidden.includes(id)) continue
      const meta = pr.metas[id]
      const layout = layoutById.get(id)
      if (!meta && !layout) continue
      const name = pr.projects.nameOverrides[id] ?? meta?.name ?? layout?.title ?? id
      // 图标单一真源：手动/新建时写入的 iconOverrides > 入驻项目自带 > 布局自带 > 按 id 派生固定图标
      const icon = resolveProjectIcon(id, pr.projects.iconOverrides[id], meta?.icon, layout?.icon)
      cards.push(make(id, name, icon, false))
    }
    if (errsDirty) saveAgentErrors(errs)
    return cards
  }

  /** 打开「添加项目」面板（侧栏 ＋ 与控制室创建卡共用）：未选文件夹时默认 = 本机默认项目父目录下的当前时间戳子文件夹
   *  （每次打开重新生成：上次没保存就关掉的自动目录已经过时，见 prefillDefaultFolder） */
  const openAddPanel = () => {
    setAddOpen(true)
    setViewOptionsOpen(false)
    prefillDefaultFolder(true)
    // 默认布局 = 全屏（未套模板时每次打开都回到默认；模板会把预设改成它自己的拓扑）
    if (!wsTemplate) setWsPreset(DEFAULT_PRESET_ID)
  }

  // 会话作用域（当前会话 + 工作目录）与后台任务：注入分栏引擎环境
  // 注意：不走 props.useSessions hook（其宿主包装在部分版本会触发 useSyncExternalStore
  // 崩溃），改为 apply 里订阅 ctx.sessions.list 后写入模块级 store，此处直接读取。
  useEffect(() => {
    const env = {
      getScope: () => {
        const s = sessionScopeStore.snapshot
        return s ? { sessionId: s.sessionId, cwd: s.cwd } : null
      },
      getJobs: () => sessionScopeStore.snapshot?.jobs ?? [],
      getSubagents: () => sessionScopeStore.snapshot?.subagents ?? [],
      custom: {
        getProjects: () => {
          const p = projectsRef.current
          return [
            ...p.aliveRegisteredIds.map((id) => ({ id, name: p.projects.nameOverrides[id] ?? p.metas[id]?.name ?? id })),
            ...p.projects.layouts.map((l) => ({ id: l.id, name: p.projects.nameOverrides[l.id] ?? l.title })),
          ]
        },
        currentProjectId: () => (splitStore.active && splitStore.spec ? splitStore.spec.id : null),
        getSessions: () => fetchSessionGroups(),
        getProjectFolder: (id: string) => projectsRef.current.projects.folders[id] ?? null,
        sendToSession: (sessionId, projectId, projectName, requirement, windowLabel) => sendCustomToSession(sessionId, projectId, projectName, requirement, windowLabel, projectsRef.current.projects.folders[projectId] ?? null),
        submit: (projectId, projectName, requirement, group, windowLabel) => createCustomSession(projectId, projectName, requirement, group, windowLabel, projectsRef.current.projects.folders[projectId] ?? null),
        // 分组（宿主工作区）数据源：读 ctx.workspaces 快照，供新建对话选分组
        getWorkspaces: () => {
          try {
            const snap = sessionBridge?.workspaces?.list?.getSnapshot?.()
            const items = snap?.items ?? []
            return items.map((w: any) => ({
              id: w.workspaceId ?? w.id,
              title: w.title ?? '',
              path: w.path ?? '',
              sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
            }))
          } catch { return [] }
        },
        createWorkspace: (path: string) => sessionBridge?.workspaces?.create?.({ path }),
        createWorkspaceDir: (parent: string, name: string) => sessionBridge?.workspaces?.createDirectory?.(parent, name),
        // 自动绑定规则：当前项目未绑定 → 绑定到刚新建/发送的会话；已绑定 → 不改（返回 'kept'）
        autoBind: (sessionId: string): 'auto' | 'kept' | 'none' => {
          const pid = splitStore.active && splitStore.spec ? splitStore.spec.id : null
          if (!pid || typeof sessionId !== 'string' || !sessionId) return 'none'
          const already = projectsRef.current.projects.bindings[pid]
          if (already) return 'kept'
          persistProjects((prev) => (prev.bindings[pid] ? prev : { ...prev, bindings: { ...prev.bindings, [pid]: sessionId } }))
          return 'auto'
        },
      },
      // 控制室：卡片数据订阅 + 打开项目 / 跳绑定对话
      console: {
        subscribe: (fn) => { consoleListeners.add(fn); return () => { consoleListeners.delete(fn) } },
        getCards: () => getConsoleCards(),
        getTheme: () => viewRef.current.consoleTheme ?? 'system',
        setTheme: (th: 'dark' | 'light' | 'system') => persistView({ consoleTheme: th }),
        getCols: () => {
          const local = readConsoleColsLocal()
          if (local !== null) return local
          const legacy = viewRef.current.consoleCols
          if (typeof legacy === 'number') { writeConsoleColsLocal(legacy); return legacy }
          return 0
        },
        setCols: (n: number) => { writeConsoleColsLocal(n) },
        getShape: () => viewRef.current.consoleShape ?? 'square',
        setShape: (s: 'square' | 'circle') => persistView({ consoleShape: s }),
        getBg: () => viewRef.current.consoleBg ?? 'glow',
        setBg: (m: 'plain' | 'glow' | 'photo') => persistView({ consoleBg: m }),
        getPhotoLib: async () => {
          let records = await photoStore.list().catch(() => [])
          // 首次使用：媒体库为空且未预置过 → 注入默认背景示例图（极小 SVG，可删）
          if (records.length === 0 && localStorage.getItem('dsh.worktable.defaultBgSeeded.v1') !== '1') {
            try {
              // 先取回独立 JPEG 资源，再按原顺序写入两条默认记录；网络失败不产生半份预置。
              const waveBlob = await loadWaveBgBlob()
              await photoStore.add(new Blob([DEFAULT_BG_SVG], { type: 'image/svg+xml' }))
              await photoStore.add(waveBlob)
              localStorage.setItem('dsh.worktable.defaultBgSeeded.v1', '1')
              records = await photoStore.list().catch(() => [])
            } catch {}
          }
          const stored = viewRef.current.consoleBgPhotoId ?? null
          const activeId = stored && records.some((r) => r.id === stored) ? stored : null
          return {
            list: records.map((r) => ({ id: r.id, kind: r.kind, url: URL.createObjectURL(r.blob) })),
            activeId,
          }
        },
        addPhoto: async (blob: Blob) => {
          const id = await photoStore.add(blob)
          persistView({ consoleBgPhotoId: id })
          try { localStorage.removeItem('dsh.worktable.consoleBgPhoto.v1') } catch {}
          return { id, kind: kindOf(blob), url: URL.createObjectURL(blob) }
        },
        setPhotoId: (id: string) => persistView({ consoleBgPhotoId: id }),
        removePhoto: async (id: string) => { await photoStore.remove(id) },
        reorderPhotos: async (ids: string[]) => { await photoStore.reorder(ids) },
        getPhotoGrid: () => viewRef.current.consoleBgPhotoGrid !== false,
        setPhotoGrid: (v: boolean) => persistView({ consoleBgPhotoGrid: v }),
        getGridOpacity: () => viewRef.current.consoleBgGridOpacity ?? 8,
        setGridOpacity: (v: number) => persistView({ consoleBgGridOpacity: v }),
        getCardBlur: () => viewRef.current.consoleCardBlur ?? 8,
        setCardBlur: (v: number) => persistView({ consoleCardBlur: v }),
        getPlainBlur: () => viewRef.current.consoleBgPlainBlur ?? 0,
        setPlainBlur: (v: number) => persistView({ consoleBgPlainBlur: v }),
        getGlowBlur: () => viewRef.current.consoleBgGlowBlur ?? 8,
        setGlowBlur: (v: number) => persistView({ consoleBgGlowBlur: v }),
        getPlainGrid: () => viewRef.current.consoleBgPlainGrid ?? 5,
        setPlainGrid: (v: number) => persistView({ consoleBgPlainGrid: v }),
        getGlowGrid: () => viewRef.current.consoleBgGlowGrid ?? 8,
        setGlowGrid: (v: number) => persistView({ consoleBgGlowGrid: v }),
        getGlowSpeed: () => viewRef.current.consoleGlowSpeed ?? 50,
        setGlowSpeed: (v: number) => persistView({ consoleGlowSpeed: v }),
        getPlainHsl: () => viewRef.current.consoleBgPlainHsl ?? { h: -140, s: 31, l: 6 },
        setPlainHsl: (v: { h: number; s: number; l: number }) => persistView({ consoleBgPlainHsl: { ...v } }),
        getGlowHsl: () => viewRef.current.consoleBgGlowHsl ?? { h: 0, s: 100, l: 100 },
        setGlowHsl: (v: { h: number; s: number; l: number }) => persistView({ consoleBgGlowHsl: { ...v } }),
        getPhotoHsl: (id: string) => viewRef.current.consoleBgPhotoHsls?.[id] ?? { h: 0, s: 100, l: 100 },
        setPhotoHsl: (id: string, v: { h: number; s: number; l: number }) => persistView({ consoleBgPhotoHsls: { ...(viewRef.current.consoleBgPhotoHsls ?? {}), [id]: { ...v } } }),
        onAck: (id) => {
          if (id === RUNNING_CARD_ID) {
            ackTransientCard()
            setNotifyTick((t) => t + 1)
            notifyConsole()
            return
          }
          ackRef.current?.(id); setNotifyTick((t) => t + 1); notifyConsole()
        },
        refreshPreviews: () => {
          if (previewTimer != null) { window.clearTimeout(previewTimer); previewTimer = null }
          sweepPreviews()
        },
        onAdd: () => { openAddPanel() },
        onOpen: (id) => {
          if (id === CONSOLE_ID) return
          if (id === RUNNING_CARD_ID) {
            const rows = transientRowsRef.current
            if (rows.length === 0) { controlRoomStore.setOpen(false); return }
            const pick = rows[0]
            // 只打开最近一条；不自动收工——结束后一直保留，直到用户手动点「收工」
            controlRoomStore.setOpen(false)
            if (pick) {
              markPluginSessionOpen(pick.id)
              openSessionInHost(pick.id)
            }
            return
          }
          controlRoomStore.setOpen(false)
          const pr = projectsRef.current.projects
          const layout = pr.layouts.find((l) => l.id === id)
          const view = pr.views[id]
          if (view || layout) {
            // 控制室卡片 = 进入项目：即使该项目的分栏已经开着（多半被控制室遮住），也保持打开
            actionsRef.current?.openSplit((view ?? layout) as LayoutSpec, { enter: true })
          } else if (pr.flows?.[id]) {
            // 模板流程项目但缺 layout 记录：仍进入 split 工作区并切到模板最新步骤会话
            // （openSplit 内部无论 layout 是否存在都会用 preferredSessionOf 判定模板步骤会话）
            actionsRef.current?.openSplit({ id, title: (pr.nameOverrides[id] ?? id), icon: pr.metas?.[id]?.icon ?? '🧱', top: null, main: [], chatWidth: { default: 340, min: 280, max: 600 } } as LayoutSpec, { enter: true })
          } else {
            // 入驻项目无视图覆盖：切到该项目「进行中」的会话（没有才退到最近更新 / 绑定对话）
            const target = preferredSessionOf(id)
            if (target) {
              markPluginSessionOpen(target)
              openSessionInHost(target)
            }
          }
        },
        onJump: (id) => {
          const sid = projectsRef.current.projects.bindings[id]
          if (!sid) return
          controlRoomStore.setOpen(false)
          markPluginSessionOpen(sid) // 插件发起的切换：不触发「切会话关项目」联动
          openSessionInHost(sid)
        },
        onNewSession: (id) => openNewProjectSession(id),
        // 图标选择器：控制室「项目管理」面板的「更换图标」按钮传入锚点元素（below：贴按钮下方，不挡操作列）
        onPickIcon: (id, anchor, opts) => { try { openIconPick('project', id, anchor, opts) } catch {} },
        onCreateSession: (id, opts) => createProjectSession(id, opts),
        onPinSession: (sid, pinned) => pinProjectSession(sid, pinned),
        onArchiveSession: (sid, archived) => archiveProjectSession(sid, archived),
        getManageProjects: () => manageProjectsOf(),
        onRenameProject: (id, name) => renameProject(id, name),
        onHideProject: (id, hidden) => hideProject(id, hidden),
        onReorderProject: (dragId, targetId, before) => reorderProject(dragId, targetId, before),
        onDeleteProject: (id) => deleteProject(id),
        getProjectSessions: (id) => projectSessionsOf(id),
        onOpenSession: (sid) => openProjectSession(sid),
        onDeleteSession: (sid) => deleteProjectSession(sid),
        onDismissTransient: (ids) => dismissTransient(ids),
        onRenameSession: (sid, title) => renameProjectSession(sid, title),
        onForkSession: (sid) => forkProjectSession(sid),
      },
      // 模板流程：FlowPane（split.tsx 内）数据与动作桥
      flow: {
        subscribe: (fn) => { flowListeners.add(fn); return () => { flowListeners.delete(fn) } },
        getView: (projectId) => buildFlowView(projectId),
        start: (projectId, stepId) => startFlowStep(projectId, stepId),
        markDone: (projectId, stepId) => markFlowStepDone(projectId, stepId),
        undo: (projectId, stepId) => markFlowUndo(projectId, stepId),
        setOverride: (projectId, stepId, o) => setFlowStepOverride(projectId, stepId, o),
        setBrief: (projectId, text) => saveProjectBrief(projectId, text),
        setStepBrief: (projectId, stepId, text) => saveStepBrief(projectId, stepId, text),
        startDiagnosis: (projectId) => startDiagnosisFlow(projectId),
        applyDiagnosis: (projectId) => applyDiagnosisResult(projectId),
        setStartStep: (projectId, stepId) => setFlowStartStep(projectId, stepId),
        resetStep: (projectId, stepId) => resetFlowStep(projectId, stepId),
        resume: (projectId, stepId) => resumeFlowStep(projectId, stepId),
        stop: (projectId, stepId) => stopFlowStep(projectId, stepId),
        openLatestReport: (projectId, stepId) => openLatestVerifyReport(projectId, stepId),
      },
    }
    setSplitEnv(env)
    try { (window as any).__dshCustomEnv = env } catch {}
    return () => { setSplitEnv(null); try { (window as any).__dshCustomEnv = null } catch {} }
  }, [])
  const floatRef = useRef<FloatRect | null>(null)

  const persistView = (patch: Partial<ViewState>) => {
    setView((prev) => {
      const next = { ...prev, ...patch }
      try { localStorage.setItem(PERSIST_KEY, JSON.stringify({ ...next, sortMigratedV2: true })) } catch {}
      return next
    })
  }

  const persistProjects = (patch: Partial<ProjectsState> | ((prev: ProjectsState) => ProjectsState)) => {
    setProjects((prev) => {
      const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }
      try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  // 自愈：启动时若控制室存档是坏布局（旧版关掉控制室标签造成窗格退化成选择器），立即重建默认面板
  useEffect(() => {
    const saved = projects.views[CONSOLE_ID]
    if (!specHasConsoleTab(saved)) {
      const spec = buildConsoleSpec((k) => t(k as WorktableKey))
      persistProjects((prev) => ({ ...prev, views: { ...prev.views, [CONSOLE_ID]: spec } }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.views[CONSOLE_ID]])

  // 子座位注册变化 → 刷新 id 序列
  useEffect(() => {
    const sync = () => setRegisteredIds([...registryStore.ids])
    registryStore.listeners.add(sync)
    return () => { registryStore.listeners.delete(sync) }
  }, [])

  // 分栏引擎激活态 → activeSplitId（卡片据此显示选中效果）；关闭项目 → 回切打开前的会话
  useEffect(() => splitStore.subscribe(() => {
    setActiveSplitId(splitStore.active && splitStore.spec ? splitStore.spec.id : null)
    if (!splitStore.active) {
      // 手机端（dsh-pocket 抽屉布局）：标题栏 ✕ = 只收起分栏，停在当前会话（退回它的单栏视图），
      // 不回切「打开项目之前的那条会话」——否则一退出就从论文项目跳到个人助手最新会话。
      // 桌面布局保持原行为（进项目前在 A、退出分栏回到 A）；「切会话自动关项目」联动仍走 suppressRestoreRef 跳过回切。
      if (!suppressRestoreRef.current && !isPocketPhoneLayout()) {
        const prev = projectAttachRef.sessionId
        if (prev) openSessionInHost(prev)
      }
      projectAttachRef.sessionId = null
      projectAttachRef.attached = null
    }
    suppressRestoreRef.current = false
  }), [])

  // 引擎内 spec 变更（窗内容/聊天位置/窗位互换）→ 回写持久化：
  // 布局项目写 layouts 条目；入驻项目（视图覆盖工作区）写 views[id]。每个项目都保持上一次的样子。
  useEffect(() => {
    splitStore.onSpecMutated = (spec) => {
      persistProjects((prev) => {
        if (prev.layouts.some((l) => l.id === spec.id)) {
          return { ...prev, layouts: prev.layouts.map((l) => (l.id === spec.id ? spec : l)) }
        }
        return { ...prev, views: { ...prev.views, [spec.id]: spec } }
      })
    }
    return () => { splitStore.onSpecMutated = null }
  }, [])

  // 分栏引擎 UI 文案（窗选择器等）
  useEffect(() => {
    setSplitT((k, p) => t(k as WorktableKey, p as Record<string, string> | undefined))
    return () => setSplitT(null)
  }, [t])

  // 侧边栏折叠/展开：保持原停靠位置（不再回弹 footer）；折叠态由项目图标框承载。
  // 折叠且浮动时：等折叠动画结束（320/750ms 双次重测，取收敛后的几何）再以 fixed 定位
  // 图标框到拖前高度——避免在过渡帧上测得展开态宽度导致图标框偏离窄栏中心。
  const measureRailRect = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width > 0) {
      setRailRect((prev) => (prev && Math.abs(prev.left - r.left) < 1 && Math.abs(prev.width - r.width) < 1 ? prev : { left: r.left, width: r.width }))
    }
  }, [])

  useLayoutEffect(() => {
    if (!wide) {
      const t1 = window.setTimeout(measureRailRect, 320)
      const t2 = window.setTimeout(measureRailRect, 750)
      return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
    }
  }, [wide, measureRailRect])

  // ── 悬浮窗宽度/水平定位：与 sidebar 几何联动（ResizeObserver 实时跟随，无轮询） ──
  // dockWidth = sidebar 宽 − paddingLeft − paddingRight − 40（每边内缩 20）
  // left = sidebar 左边缘视口坐标 + paddingLeft + 20
  // 降级：找不到 sidebar 或宽度 ≤0 → left 固定 14px，宽度不设内联（交 CSS min/max 处理）
  const measureFloatGeo = useCallback(() => {
    const sidebar = findSidebar(rootRef.current)
    if (!sidebar) {
      setFloatGeo({ left: 14, width: null })
      return
    }
    const rect = sidebar.getBoundingClientRect()
    const cs = getComputedStyle(sidebar)
    const padLeft = parseFloat(cs.paddingLeft) || 0
    const padRight = parseFloat(cs.paddingRight) || 0
    const margin = 20
    const width = rect.width - padLeft - padRight - margin * 2
    setSidebarRight(Math.round(rect.right))
    if (width > 0) {
      setFloatGeo({ left: Math.round(rect.left + padLeft + margin), width: Math.round(width) })
    } else {
      setFloatGeo({ left: 14, width: null })
    }
  }, [])

  useLayoutEffect(() => {
    measureFloatGeo()
    const sidebar = findSidebar(rootRef.current)
    if (!sidebar) return
    const ro = new ResizeObserver(() => measureFloatGeo())
    ro.observe(sidebar)
    return () => ro.disconnect()
  }, [measureFloatGeo])

  // 窗口尺寸变化 → 回弹默认停靠（浮动的列宽已失效）
  useEffect(() => {
    const onResize = () => {
      setFloat(null); persistView({ dock: 'footer' })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ── 协议 v2 回调（引用稳定，避免卡片 reportMeta effect 循环）──
  const reportMeta = useCallback((meta: ProjectMeta) => {
    if (!meta || typeof meta.id !== 'string' || !meta.id) return
    setMetas((prev) => {
      const cur = prev[meta.id]
      if (cur && cur.name === meta.name && cur.icon === meta.icon) return prev
      return { ...prev, [meta.id]: { id: meta.id, name: typeof meta.name === 'string' ? meta.name : meta.id, icon: meta.icon } }
    })
  }, [])

  const engineIdsRef = useRef<Set<string>>(new Set())
  const lastLegacyBumpRef = useRef<Record<string, number>>({})

  /** 使用埋点：仅「工作区真正打开」计一次使用；点击关闭/重复点击不计（避免每次点击置顶） */
  const reportUsed = useCallback((id: string) => {
    if (typeof id !== 'string' || !id) return
    const now = Date.now()
    const bump = () => {
      persistProjects((prev) => {
        if (prev.lastUsed[id] === now) return prev
        return { ...prev, lastUsed: { ...prev.lastUsed, [id]: now } }
      })
    }
    const engineOpen = splitStore.active && splitStore.spec?.id === id
    const knownEngine = engineIdsRef.current.has(id)
    if (engineOpen) {
      bump() // 引擎项目：本次点击打开了工作区 → 计一次使用
    } else if (knownEngine) {
      // 引擎项目：本次是关闭/重复点击 → 不计
      return
    } else {
      // 非引擎项目（自带分栏实现等）：冷却去重（打开计一次；快速开关/关闭点击不重复计）
      if (now - (lastLegacyBumpRef.current[id] ?? 0) > LEGACY_BUMP_COOLDOWN) {
        lastLegacyBumpRef.current[id] = now
        bump()
      }
    }
  }, [])

/** 绑定会话显示名（同步读会话快照；找不到回退 id）——供按钮 hover 气泡使用 */
function boundSessionTitle(sid: string): string {
  try {
    const snap = sessionBridge?.list?.getSnapshot?.()
    const e = snap?.byId?.[sid]
    if (e) return e.displayTitle ?? e.title ?? sid
  } catch {}
  return sid
}

/** 绑定会话信息：文件夹（工作区）+ 会话标题（供绑定弹窗状态行展示） */
function bindInfoOf(groups: { title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[], sid: string): { folder: string; title: string } {
  for (const g of groups) {
    const s = g.sessions.find((x) => x.id === sid)
    if (s) return { folder: g.title || '未分组', title: s.title }
  }
  return { folder: '', title: sid }
}

/** 自定义布局提示词模板（复制到剪贴板，可发给任意 dsh 会话让 agent 实现）。
 *  零泄漏硬约束：禁止写入用户的个人工作区分组名/项目名/私人路径——本提示词会被发给别人的 DSH。 */
function buildCustomLayoutPrompt(req: string): string {
  return [
    '【为 dsh-assistant（工作台）插件增加一个新的布局预设】',
    '',
    '背景：dsh-assistant 是 DeepSeek Harness 的自建插件（控制室 + 工作台项目 + 手机访问 + 私人助手；不了解的细节可直接向用户提问）。',
    '侧边栏「工作台」区块管理项目，每个项目打开后是一个平铺工作区（若干内容窗 + 右侧对话窗）。',
    '布局预设定义在插件仓库的 src/client/index.tsx 的 PRESET_DEFS 数组，选择器缩略图在 presetThumb() 函数。',
    '',
    '任务：按下方「用户需求」新增一个布局预设。',
    '',
    '规则（必须遵守）：',
    '1. 新预设追加到 PRESET_DEFS 数组末尾；预设选择器按数组顺序显示，末尾的「＋」自定义磁贴永远是最后一个，新预设自动出现在它前面。',
    '2. 预设字段：id（kebab-case 唯一）；leftCount = 左侧整列内容窗数（0/1）；topCount = 顶部通栏行窗数；contentCount = 主行窗数；chatFull = 对话窗是否通高整列（true/false）；可选 topHeightDefault = 顶行固定默认高（px）；可选 topHeightRatio = 首次打开时顶行高度占可用高度比例（0~1，0.5 = 上下等分；缺省 0.35）。',
    '3. 硬约束：对话窗恒在右侧（chatSide 固定 right）；聊天 ⇄ 翻转贴左由引擎自带，不要改。',
    '4. 想要「上下等大」的网格就用 topHeightRatio: 0.5；每行内的窗格宽度由引擎按可用宽度自动均分，无需配置。',
    '5. 窗格最小宽 200、聊天窗最小宽 240，引擎有钳制，无需配置。',
    '6. 在 presetThumb(defId) 里为新 id 增加一个缩略图分支（用 dsh-wt_thumb / dsh-wt_thumbCol / dsh-wt_thumbRow / cell()；聊天窗用 cell(true) 的蓝色 💬 格）。',
    '7. 现有预设的顺序与内容不要改动：2h / 3h / l2 / grid / t3 / l13 / g4 / l23。',
    '8. 改完插件在插件仓库根目录执行 npm run build 重新打包；纯客户端改动刷新页面即生效，宿主改动要重启 DSH。',
    '9. 需求若超出以上字段的表达能力（例如三行、嵌套分栏），按现有引擎模型做最接近的实现，并在回复里说明取舍。',
    '',
    '用户需求：',
    req,
  ].join('\n')
}

  /** 点卡片时的候选会话：项目目录（含模板步骤子目录）下的会话 + 显式记账的绑定/步骤会话，
   *  去重、剔除已归档（点进去一条被归档的旧对话没有意义）。 */
  const candidateSessionRowsOf = (pid: string): ProjectSessionItem[] => {
    const pr = projectsRef.current.projects
    const rows = projectSessionsOf(pid).filter((s) => !s.archived)
    const seen = new Set(rows.map((r) => r.id))
    const extra: string[] = []
    const bound = pr.bindings[pid]
    if (bound && !seen.has(bound)) extra.push(bound)
    for (const sid of Object.values<any>(pr.flows?.[pid]?.stepSessions ?? {})) {
      if (typeof sid === 'string' && sid && !seen.has(sid)) extra.push(sid)
    }
    if (extra.length === 0) return rows
    const snap = sessionBridge?.list?.getSnapshot?.()
    const byId: Record<string, any> = snap?.byId ?? {}
    const index = sessionSnapshotIndexOf(snap)
    const noKids: Set<string> = new Set()
    const kidsOf = (sid: string): Set<string> => index.kidsByParent.get(sid) ?? noKids
    for (const sid of extra) {
      const e = byId[sid]
      if (!e) continue
      rows.push({
        id: sid,
        title: (typeof e.displayTitle === 'string' && e.displayTitle) || (typeof e.title === 'string' && e.title) || '',
        rel: '',
        current: sid === currentSessionId(),
        running: sessionRunningFlag(sid, byId, kidsOf),
        awaiting: sessionAwaitingFlag(sid, byId, kidsOf, sessionFaceSnapshotOf),
        blank: e.blank === true,
        updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
        pinned: false,
        archived: false,
      })
      seen.add(sid)
    }
    return rows
  }

  /** 打开项目应切入的对话：
   *  ① 进行中的会话优先（等你回答的黄档 > 正在跑的蓝档；同档内取最近有活动的那条，
   *    当前会话本身就在这档里则保持不动——点卡片不该把用户正在看的会话踢走）；
   *  ② 没有进行中的会话：模板流程项目按「最新步骤」判定；
   *  ③ 再兜底：该项目目录下「最近更新」的会话（与「会话列表」第一行同一套排序）；
   *  ④ 都没有 = 退回绑定会话；再没有 = null（调用方会新建一条空白会话）。 */
  const preferredSessionOf = (pid: string): string | null => {
    const pr = projectsRef.current.projects
    const candidates = candidateSessionRowsOf(pid)
    const active = pickActiveSession(candidates, currentSessionId())
    if (active) return active.id
    // 模板判定只依赖 flow run，不依赖 layout 记录是否存在（布局卡可能缺失/迁移，但模板会话切换必须可靠）
    const parsed = templateFlowStepOf(pid)
    const stepSid = parsed ? parsed.run.stepSessions?.[parsed.step.id] : null
    if (stepSid) return stepSid
    const latest = sortSessionsByActivity(candidates)[0]
    if (latest) return latest.id
    return pr.bindings[pid] ?? null
  }

  /** 在指定文件夹为项目建一个「项目对话」（空白会话）并绑定：cwd/工作区 = 该文件夹。
   *  在途去重：同项目并发调用只建一个；失败返回 null（不绑定）。
   *
   *  `defaults:false` = 先别跑预设/模型 RPC（见 applyNewSessionDefaults 的注释：这些 RPC 会把
   *  会话 Agent 在建会话与「打开」之间重启一次，UI 的历史流会卡在 loading → 主区纯白）。
   *  需要立刻把界面切过去的调用方一律传 false，等切过去之后再补。 */
  const createBoundSession = async (pid: string, folder: string, options: { defaults?: boolean } = {}): Promise<string | null> => {
    if (projectEnsureBusyRef.current[pid]) return projectEnsureBusyRef.current[pid]
    const task = (async (): Promise<string | null> => {
      let sid: string | null = null
      // folder 为空（内置项目且各处都解析不到目录）：不指定目录建会话，交给宿主默认，保证「＋」始终可用
      try { sid = folder ? await createSessionAtFolder(folder) : await sessionBridge!.sessions.create({}) } catch { return null }
      if (!sid) return null
      if (options.defaults !== false) await applyNewSessionDefaults(sid)
      // 临时卡片「正在运行」是虚拟项目：新会话不绑定到任何真实项目，否则日后会被当成项目会话
      if (pid !== RUNNING_CARD_ID) {
        persistProjects((prev) => ({ ...prev, bindings: { ...prev.bindings, [pid]: sid } }))
      }
      return sid
    })()
    projectEnsureBusyRef.current[pid] = task
    try {
      return await task
    } finally {
      delete projectEnsureBusyRef.current[pid]
    }
  }

  /** 控制室卡片「＋ 新建会话」：在**该项目对应的目录**下新开一个空白对话——
   *  普通项目 = 该项目自己的文件夹（与建项目时选定的目录一致）；控制室这类内置项目没有项目文件夹，
   *  沿用它当前对话的工作目录（同目录续开）。绑定到该项目（卡片的状态与预览随之跟踪新会话）并自动切过去。 */
  const openNewProjectSession = async (pid: string): Promise<boolean> => {
    const folder = newSessionFolderOf(pid)
    // 目标可能是模板项目里尚未「开始此步」的步骤子目录：先幂等建目录，否则宿主工作区注册会失败
    if (folder) { try { await apiMkdir(folder) } catch {} }
    // defaults:false —— 预设/模型 RPC 推迟到会话挂载之后（见 applyNewSessionDefaults 注释）
    const sid = await createBoundSession(pid, folder, { defaults: false })
    if (!sid) {
      reportUserError(newSessionFailedText(folder))
      return false
    }
    // 顺序很重要：先把新会话设为当前并让它进列表，再关控制室——否则弹窗一关、
    // 界面还停在旧会话，看起来就是「点了没反应」。
    markPluginSessionOpen(sid) // 插件发起的切换：不触发「切会话关项目」联动
    const focus = await focusNewSession(sid, () => {
      // 宿主已接受切换就立刻露出会话；空白历史修复与诊断继续后台完成。
      controlRoomStore.setOpen(false)
      notifyConsole()
    })
    if (!focus.opened || !focus.settled) {
      if (!focus.opened) openSessionInHost(sid)
      try { await sessionBridge?.sessions?.refresh?.() } catch {}
    }
    controlRoomStore.setOpen(false)
    notifyConsole()
    void applyNewSessionDefaults(sid)
    return true
  }

  /** 控制室卡片「＋ 新建会话」带模式：标准模式（宿主默认预设）/ computer-use（dsh-orb 电脑操作预设）。
   *  computer-use 支持选前台模型（该会话后续消息用）与后台模型（dsh-orb 后台 Agent，全局）。
   *  入口：控制室「新建」按钮弹出的小面板（split.tsx NewSessionDialog）。
   *  返回值 = 是否建成：调用方据此决定「关闭弹窗」还是「留在弹窗让用户重试」。 */
  const createProjectSession = async (pid: string, opts: NewSessionOptions): Promise<boolean> => {
    const folder = newSessionFolderOf(pid)
    if (folder) { try { await apiMkdir(folder) } catch {} }
    const api = getAssistantApi()
    let sid: string | null = null
    // 只做「建会话」这一件事：预设/模型 RPC 一律推到会话挂载之后再补（见 applyNewSessionDefaults）。
    // 后台模型是全局设置，先写不影响新会话的历史流。
    if (opts.mode === 'computer-use' && api) {
      try {
        const res = await api.createSession(folder, 'computer-use', { reuseBlank: false })
        sid = res.sessionId
        if (res.appliedPreset === null) {
          try { console.warn('[dsh-assistant] computer-use 预设不可用，已回退标准模式') } catch {}
        }
      } catch (err) {
        console.warn('[dsh-assistant] 新建 computer-use 会话失败：', err)
        // 预设不存在时**明确告知并停下**：静默建一条标准会话，用户进详情才发现是标准模式。
        reportUserError('Computer Use 预设不可用：当前宿主里没有名为「computer-use」的 Agent 预设（它由 dsh-orb 之类的插件注册）。请启用对应插件，或改用「普通对话」新建。')
        return false
      }
      if (sid && opts.background) {
        // 全局后台模型与新会话导航无关：后台写入，不拖住打开会话。
        void (async () => {
          try {
            await api.selectBackgroundModel(opts.background!)
            writeBgPref({ provider: opts.background!.provider, model: opts.background!.model, name: opts.background!.name ?? opts.background!.model })
          } catch (err) { console.warn('[dsh-assistant] 后台模型写入失败：', err) }
        })()
      }
    } else {
      try { sid = folder ? await createSessionAtFolder(folder) : await sessionBridge!.sessions.create({}) } catch { sid = null }
    }
    if (!sid) {
      reportUserError(newSessionFailedText(folder))
      return false
    }
    // 临时卡片不写入项目绑定：它只是「没在任何项目文件夹里」的会话集合，绑定会把新会话藏出卡片
    if (pid !== RUNNING_CARD_ID) {
      persistProjects((prev) => ({ ...prev, bindings: { ...prev.bindings, [pid]: sid as string } }))
    }
    // ① 先把新会话设为当前（并让它进宿主列表）；② 再关控制室；③ 通知控制室/卡片刷新。
    markPluginSessionOpen(sid)
    const focus = await focusNewSession(sid, () => {
      // 宿主已接受切换就立刻露出会话；空白历史修复与诊断继续后台完成。
      controlRoomStore.setOpen(false)
      notifyConsole()
    })
    if (!focus.opened || !focus.settled) {
      // 兜底：再切一次 + 重拉列表（侧栏立刻能看到它）；仍然 loading 的话把它的历史流重建一次。
      if (!focus.opened) openSessionInHost(sid)
      try { await sessionBridge?.sessions?.refresh?.() } catch {}
    }
    controlRoomStore.setOpen(false)
    notifyConsole()
    // 会话已经挂到主区：这时再补预设/前台模型（后台不阻塞关闭控制室）
    void (async () => {
      if (opts.front && api) {
        try {
          await api.selectModel(sid as string, opts.front)
          writeModelPref(opts.mode === 'computer-use' ? 'cu' : 'standard', { provider: opts.front.provider, model: opts.front.model, name: opts.front.name ?? opts.front.model })
          return
        } catch (err) { console.warn('[dsh-assistant] 新会话选模型失败：', err) }
      }
      if (opts.mode !== 'computer-use') await applyNewSessionDefaults(sid as string)
    })()
    return true
  }

  /** 会话置顶/取消置顶（宿主工作区；失败仅告警） */
  const pinProjectSession = (sid: string, pinned: boolean): void => {
    if (!sid) return
    const api = getAssistantApi()
    const ws = sessionBridge?.workspaces as any
    const run = pinned
      ? (api?.pinSession(sid) ?? ws?.pinSession?.(sid))
      : (api?.unpinSession(sid) ?? ws?.unpinSession?.(sid))
    Promise.resolve(run).catch((err) => console.warn('[dsh-assistant] 置顶失败：', err)).finally(() => notifyConsole())
  }

  /** 会话归档/恢复（宿主工作区：归档 = 从列表移除，磁盘日志保留） */
  const archiveProjectSession = (sid: string, archived: boolean): void => {
    if (!sid) return
    const api = getAssistantApi()
    const ws = sessionBridge?.workspaces as any
    const run = archived
      ? (api?.archiveSession(sid) ?? ws?.archiveSession?.(sid))
      : (api?.unarchiveSession(sid) ?? ws?.unarchiveSession?.(sid))
    Promise.resolve(run).catch((err) => console.warn('[dsh-assistant] 归档失败：', err)).finally(() => notifyConsole())
  }

  /** 项目管理：控制室里的项目清单（含已隐藏），供「项目管理」面板使用 */
  /** 项目管理面板的项目列表：顺序与控制室卡片完全一致（上移/下移即时反映到网格）。 */
  const manageProjectsOf = (): { id: string; name: string; icon: string; hidden: boolean }[] => {
    const pr = projectsRef.current
    const items = new Map<string, { id: string; name: string; icon: string; hidden: boolean }>()
    for (const l of pr.projects.layouts) {
      if (!l || typeof l.id !== 'string' || l.id === CONSOLE_ID || items.has(l.id)) continue
      items.set(l.id, {
        id: l.id,
        name: pr.projects.nameOverrides[l.id] ?? l.title ?? l.id,
        // 图标单一真源：项目管理面板里显示的必须是「卡片真正在用的图标」（手动覆盖 > 入驻 > 布局 > 派生）
        icon: resolveProjectIcon(l.id, pr.projects.iconOverrides[l.id], pr.metas[l.id]?.icon, l.icon),
        hidden: pr.projects.hidden.includes(l.id),
      })
    }
    for (const id of pr.aliveRegisteredIds) {
      if (id === CONSOLE_ID || items.has(id)) continue
      items.set(id, {
        id,
        name: pr.projects.nameOverrides[id] ?? pr.metas[id]?.name ?? id,
        icon: resolveProjectIcon(id, pr.projects.iconOverrides[id], pr.metas[id]?.icon, pr.projects.layouts.find((l) => l.id === id)?.icon),
        hidden: pr.projects.hidden.includes(id),
      })
    }
    return projectDisplayOrder().map((id) => items.get(id)).filter((x): x is { id: string; name: string; icon: string; hidden: boolean } => !!x)
  }

  /** 隐藏 / 恢复项目（只影响控制室显示，不动文件夹与会话） */
  const hideProject = (pid: string, hidden: boolean): void => {
    persistProjects((prev) => ({
      ...prev,
      hidden: hidden ? Array.from(new Set([...prev.hidden, pid])) : prev.hidden.filter((x) => x !== pid),
    }))
    notifyConsole()
  }

  /** 删除项目条目（不删磁盘文件夹/会话；模板进度、绑定、文件夹映射一并清掉），带确认 */
  const deleteProject = (pid: string): void => {
    const pr = projectsRef.current.projects
    const layout = pr.layouts.find((l) => l.id === pid)
    const name = pr.nameOverrides[pid] ?? layout?.title ?? pid
    let ok = true
    try { ok = window.confirm(`删除项目「${name}」？\n只删除控制室里的项目条目，磁盘文件夹与会话记录不会删除。`) } catch {}
    if (!ok) return
    persistProjects((prev) => {
      const next: any = { ...prev }
      next.layouts = prev.layouts.filter((l) => l.id !== pid)
      next.order = prev.order.filter((x) => x !== pid)
      next.hidden = prev.hidden.filter((x) => x !== pid)
      // 墓碑：删过的 id 记下来随状态同步，另一端的旧副本再并回来也复活不了
      next.removed = prev.removed.includes(pid) ? prev.removed : [...prev.removed, pid]
      next.views = { ...prev.views }; delete next.views[pid]
      next.nameOverrides = { ...prev.nameOverrides }; delete next.nameOverrides[pid]
      next.iconOverrides = { ...prev.iconOverrides }; delete next.iconOverrides[pid]
      next.bindings = { ...prev.bindings }; delete next.bindings[pid]
      next.folders = { ...prev.folders }; delete next.folders[pid]
      next.flows = { ...(prev.flows ?? {}) }; delete next.flows[pid]
      next.briefs = { ...(prev.briefs ?? {}) }; delete next.briefs[pid]
      return next
    })
    if (splitStore.active && splitStore.spec?.id === pid) { try { splitStore.close() } catch {} }
    notifyConsole()
  }

  /** 私人助手卡片自愈：助手目录必须出现在控制室里，且是一张普通项目卡。
   *  - 首次（或用户清了状态）自动创建：布局=会话全屏、图标 🤖、排第一；
   *  - 已存在（按文件夹比对，不按 id）就不再建，避免与用户手工添加的项目重复；
   *  - 用户删过（removed 墓碑）不重建：删卡片是他的明确选择。
   *
   * 为什么不是「挂载时跑一次」：首次同步是**宿主状态覆盖本地**（adoptRemoteState），
   * 挂载那一下建的卡会被这次覆盖吃掉，之后再也不重建——这正是 v0.2.7 第一版
   * 在真机上「卡片一直不出现」的原因。现在等 syncReady 之后再加，并且按
   * layouts/removed 变化重试（最多 6 次），保证被采纳覆盖后还能补回来。 */
  useEffect(() => {
    if (typeof window === 'undefined') return
    let alive = true
    void assistantHomeDir()
      .then((home) => { if (alive && home) setAssistantHome(home) })
      .catch((err) => {
        // P0-6：不再静默 —— 建卡为什么没成，至少要让用户看见（一次，不刷屏）
        warnCardOnce('助手目录不可用，助手卡片没有建起来：' + String(err?.message ?? err))
      })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!syncReady || !assistantHome) return
    if (!shouldAddAssistantCard(projects as any, assistantHome)) return
    if (assistantCardTriesRef.current >= 6) {
      warnCardOnce('助手卡片一直建不起来（试过 6 次，宿主状态每次把它吃掉）。设置 → 个人助手 里有解释。')
      return
    }
    assistantCardTriesRef.current += 1
    const layout = buildLayout(DEFAULT_PRESET_ID, ASSISTANT_CARD_NAME)
    layout.id = ASSISTANT_PROJECT_ID
    layout.icon = ASSISTANT_CARD_ICON
    try {
      persistProjects((prev) => withAssistantCard(prev as any, assistantHome, layout) as any)
    } catch (err: any) {
      warnCardOnce('写项目状态失败，助手卡片没建成：' + String(err?.message ?? err))
      return
    }
    notifyConsole()
    // projects.layouts.length / removed.length：被宿主状态覆盖（卡片被吃）或另一端点删除时重新评估
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncReady, assistantHome, projects.layouts.length, projects.removed.length])

  /** 为「还没有专属会话」的项目自动补一个项目对话：空白会话、工作目录 = 项目文件夹
   * （与用户建项目时选择的文件夹一致），建好即绑定到该项目。
   * 仅当：项目配置了文件夹、当前无绑定会话、模板流程也未开过任何步骤会话时执行；失败静默返回 null。 */
  const ensureProjectSession = async (pid: string): Promise<string | null> => {
    const pr = projectsRef.current.projects
    if (pr.bindings[pid]) return pr.bindings[pid]
    const run = pr.flows?.[pid]
    if (run && run.stepSessions && Object.keys(run.stepSessions).length > 0) return null
    const folder = pr.folders[pid]
    if (!folder) return null
    return createBoundSession(pid, folder)
  }

  /** 分栏工作区入口（M1 引擎）：项目卡片调用 openSplit(spec) 打开声明式布局；
   * 若该 id 存在视图覆盖（用户在设置里变更过视图），用覆盖布局替换打开。
   * 若项目有归属会话（模板流程 = 最新步骤会话 / 其它 = 绑定会话），打开后右侧对话窗自动切过去。
   *
   *  `enter: true` = 「进入项目」语义（控制室卡片用）：同一项目已经开着时保持打开，
   *  不再走 splitStore 的反选关闭——控制室是覆盖层，工作区明明开着却被它挡住看不见，
   *  此时点卡片若反选关闭，用户看到的就是布局消失、只剩普通会话界面。 */
  const openSplit = useCallback(async (spec: LayoutSpec, opts: { enter?: boolean } = {}) => {
    engineIdsRef.current.add(spec.id)
    const intent = splitOpenIntent(splitStore.active ? splitStore.spec?.id ?? null : null, spec.id, opts.enter === true)
    const alreadyOpen = intent !== 'open'
    let opened = intent === 'keep' ? true : splitStore.open(projects.views[spec.id] ?? spec)
    // 会话视图还没挂载时（刚新建会话 / 正在切会话的 settling 过渡态）findConversationRoot 取不到根，
    // splitStore.open 会静默返回 false：用户点了项目卡却停在普通会话界面。等根容器出现后补开一次。
    if (!opened && !alreadyOpen) {
      for (let i = 0; i < 10 && !opened; i++) {
        await new Promise<void>((resolve) => { window.setTimeout(resolve, 80) })
        if (splitStore.active) { opened = splitStore.spec?.id === spec.id; break }
        opened = splitStore.open(projects.views[spec.id] ?? spec)
      }
    }
    // 说明：splitStore.open 在同一项目重复点击时是「反选关闭」（返回 true 但 active 变 false）。
    // 我们要的是「点击项目卡 = 进入项目」，因此只有真正处于打开态才做会话切换；
    // 切到哪条由 preferredSessionOf 定：进行中的会话（等你回答 > 正在跑）优先，其次模板最新步骤，
    // 最后才是该项目最近更新的会话。
    if (opened && splitStore.active && splitStore.spec?.id === spec.id) {
      // 记录打开前会话（关项目时回切）与该项目「归属会话」（切到别的会话 = 自动关项目）
      let prev: string | null = null
      try { prev = currentSessionId() || null } catch {}
      projectAttachRef.sessionId = prev
      let target = preferredSessionOf(spec.id)
      let entered = target
      // 还没有任何专属会话的新项目：自动新建空白会话并绑定（工作目录 = 项目文件夹），
      // 不再回退到「打开项目前的那个会话」（否则进入的会话文件夹与项目不符）
      if (!target && spec.id !== CONSOLE_ID) {
        target = await ensureProjectSession(spec.id)
        entered = target
      }
      target = target ?? prev
      projectAttachRef.attached = target
      if (target && target !== prev) {
        markPluginSessionOpen(target) // 插件发起的切换：不触发「切会话关项目」联动
        openSessionInHost(target)
      }
      // 熄光只跟着「实际进入的那条会话」走（回退到 prev 的那条不属于本项目，不该被顺带确认）
      ackProjectNotify(spec.id, entered)
      // 补挂：此前项目未打开时暂存的产物（entries = 多窗口挂载列表），现在自动挂进各目标窗格；
      // 全部落位成功记录指纹（供自愈扫挂去重）
      const pending = pendingMountRef.current[spec.id]
      if (pending) {
        try {
          const entries = Array.isArray(pending.entries)
            ? pending.entries
            : (pending.content ? [{ content: pending.content, row: pending.row, index: pending.index ?? 0 }] : [])
          let allOk = entries.length > 0
          for (const e of entries) {
            splitStore.lockPane(e.row, e.index ?? 0, e.content)
            if (!paneExists(splitStore.spec, e.row, e.index ?? 0)) allOk = false
          }
          if (allOk && pending.fingerprint) recordMountedWidget(spec.id, pending.fingerprint)
        } catch {}
        delete pendingMountRef.current[spec.id]
        try { localStorage.setItem('dsh.worktable.pendingMount.v1', JSON.stringify(pendingMountRef.current)) } catch {}
      }
    } else if (opened) {
      // 布局卡缺失的兜底分支：同样按 preferredSessionOf（进行中会话优先）切会话
      const target = preferredSessionOf(spec.id)
      if (target) {
        markPluginSessionOpen(target)
        openSessionInHost(target)
        ackProjectNotify(spec.id, target)
      }
    }
  }, [projects.views])

  /** 打开「工作台」控制室：已绑定 → 打开并切换绑定对话；explicitBound 供强制绑定流程传入刚绑定的会话 */
  const openConsole = useCallback((explicitBound?: string | null) => {
    const saved = projects.views[CONSOLE_ID]
    // 自愈：坏存档（旧版关掉控制室标签导致窗格退化成选择器）→ 重建默认面板并写回
    const broken = !specHasConsoleTab(saved)
    const spec = broken ? buildConsoleSpec((k) => t(k as WorktableKey)) : (saved as LayoutSpec)
    if (broken) persistProjects((prev) => ({ ...prev, views: { ...prev.views, [CONSOLE_ID]: spec } }))
    engineIdsRef.current.add(CONSOLE_ID)
    splitStore.open(spec)
    if (splitStore.active && splitStore.spec?.id === CONSOLE_ID) {
      let prev: string | null = null
      try { prev = currentSessionId() || null } catch {}
      projectAttachRef.sessionId = prev
      const bound = explicitBound !== undefined ? explicitBound : projectsRef.current.projects.bindings[CONSOLE_ID]
      projectAttachRef.attached = bound ?? prev
      if (bound) openSessionInHost(bound)
      ackProjectNotify(CONSOLE_ID)
      try { notifyConsole() } catch {}
      // 打开即预热所有绑定会话的最近消息（冷会话走 history 只读通道）
      try { sweepPreviews() } catch {}
    }
  }, [projects.views, t])

  /** 控制室卡片点击：已绑定 → 打开控制室；未绑定 → 强制绑定弹窗 */
  const clickConsoleCard = (anchor: HTMLElement) => {
    if (projectsRef.current.projects.bindings[CONSOLE_ID]) { openConsole(); return }
    const r = anchor.getBoundingClientRect()
    setConsoleBind({
      x: clamp(Math.round(r.right + 8), 8, window.innerWidth - 640),
      y: clamp(Math.round(r.top), 8, window.innerHeight - 460),
    })
    setConsoleGroups([])
    fetchSessionGroups().then((res) => setConsoleGroups(res.groups)).catch(() => setConsoleGroups([]))
  }

  /** 强制绑定：加入现有对话（绑定后直接打开控制室） */
  const bindConsoleExisting = (sid: string) => {
    persistProjects((prev) => ({ ...prev, bindings: { ...prev.bindings, [CONSOLE_ID]: sid } }))
    setConsoleBind(null)
    openConsole(sid)
  }

  /** 强制绑定：新建空会话并绑定（分组同自定义窗：无 / 现有 / 新建） */
  const bindConsoleNew = async () => {
    const b = sessionBridge
    if (!b || typeof b.sessions?.create !== 'function') { setConsoleErr(true); return }
    if (consoleMode === 'new' && (!consoleParent.trim() || !consoleName.trim())) { setConsoleErr(true); return }
    setConsoleBusy(true); setConsoleErr(false)
    try {
      let workspaceId: string | null = null
      if (consoleMode === 'existing' && consoleWsId) workspaceId = consoleWsId
      else if (consoleMode === 'new') {
        const ws = b.workspaces as any
        const parent = consoleParent.replace(/[\\/]+$/, '')
        const name = consoleName.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
        const full = joinPath(parent, name)
        try { await ws?.createDirectory?.(parent, name) } catch {}
        try {
          const r = await fetch('/api/worktable/mkdir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: full }) })
          const d = await r.json()
          if (!r.ok || !d?.ok) throw new Error(d?.error ?? 'mkdir failed')
        } catch { /* 目录建不出的错误最终由 workspace.create 暴露 */ }
        const view = await ws.create({ path: full })
        workspaceId = view?.workspaceId ?? view?.id ?? null
        if (!workspaceId) throw new Error('workspace create failed')
      }
      const folder = projectsRef.current.projects.folders[CONSOLE_ID] ?? null
      let createOpts: any = {}
      if (workspaceId) createOpts = { workspaceId }
      else if (folder) createOpts = { cwd: folder }
      const sessionId = await b.sessions.create(createOpts)
      await ensureSessionPreset(sessionId) // 管理对话同样应用部署默认预设
      await ensureSessionModel(sessionId) // 管理对话同样修复失效 provider
      markPluginSessionOpen(sessionId)
      persistProjects((prev) => ({ ...prev, bindings: { ...prev.bindings, [CONSOLE_ID]: sessionId } }))
      setConsoleBind(null)
      openConsole(sessionId)
    } catch { setConsoleErr(true) } finally { setConsoleBusy(false) }
  }

  actionsRef.current = { openSplit, openConsole }

  /** 打开对话绑定弹窗：抓取会话分组 + 锚点定位 */
  const openBindPick = useCallback((id: string, anchor: HTMLElement) => {
    invalidatePickState() // 切换目标：失效在途选择请求、清空旧错误与手工输入
    const r = anchor.getBoundingClientRect()
    const x = clamp(Math.round(r.right + 8), 8, window.innerWidth - 300)
    const y = clamp(Math.round(r.top), 8, window.innerHeight - 420)
    setBindPick({ id, x, y })
    setBindListOpen(false)
    setBindGroups([])
    fetchSessionGroups().then((res) => setBindGroups(res.groups)).catch(() => setBindGroups([]))
  }, [])

  /** 手机/窄屏：用与「会话输入框 → 电脑文件」同一套路径浏览器选项目文件夹（不触发电脑端系统弹窗）。
   *  startAt 不存在（默认文件夹是待创建的时间戳目录）时由 PathBrowser 自动退到最近的可读上级。 */
  const openFolderBrowser = (startAt: string, apply: (p: string) => void) => {
    browseApplyRef.current = apply
    setBrowseStart(String(startAt ?? '').trim())
    setBrowseOpen(true)
  }
  const closeFolderBrowser = () => {
    setBrowseOpen(false)
    setBrowseStart('')
    browseApplyRef.current = null
  }
  /** 当前设备是否适合用「浏览电脑文件夹」代替系统选择器（手机 / 窄屏 / 粗指针） */
  const useInAppFolderBrowser = (): boolean => {
    try {
      if (typeof window === 'undefined') return false
      if (window.innerWidth < 1024) return true
      return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    } catch { return false }
  }

  /** 弹出系统文件夹选择窗（宿主 pickDirectory）；选中后回调。
   *  - useRef 在途锁 + 请求序号：真实防重入；手工确认/新请求会使旧请求失效，旧弹窗返回后丢弃
   *  - 返回 null = 用户取消：不报错
   *  - 抛异常 = 显示真实错误信息，不再静默吞掉
   *  - 宿主能力三级探测（运行时，不硬写 inject）：
   *      ① 0.1.1-rc.2：ctx.workspaces.pickDirectory() → string | null
   *      ② 0.1.2-rc.1：ctx remote.directoryPicker.pick() → { ok, value, error }（value 即路径或 null）
   *      ③ 0.1.2 新能力不可用 → 提示改用「手动输入」 */
  const pickFolder = async (target: 'add' | 'bind', apply: (p: string) => void, startAt = '') => {
    if (pickBusyRef.current) return
    // 手机/窄屏：不触发电脑端的系统文件夹对话框，改为在手机上浏览电脑目录（同一套 PathBrowser）。
    // 默认项目文件夹是「待创建」的时间戳目录，不存在 → 从它的父目录开始浏览，避免一进来就报错。
    if (useInAppFolderBrowser()) {
      openFolderBrowser(projectFolderBrowseStart(startAt || wsFolderParent), apply)
      return
    }
    // 解析本次选择器调用路径
    const ws = sessionBridge?.workspaces as any
    const legacy = ws && typeof ws.pickDirectory === 'function'
      ? () => ws.pickDirectory()
      : null
    let remotePicker: (() => Promise<any>) | null = null
    try {
      const rp = clientCtx?.get?.('remote.directoryPicker')
      if (rp && typeof rp.pick === 'function') remotePicker = () => rp.pick()
    } catch {}
    if (!remotePicker) {
      try {
        const dp = (clientCtx as any)?.directoryPicker
        if (dp && typeof dp.pick === 'function') remotePicker = () => dp.pick()
      } catch {}
    }
    if (!legacy && !remotePicker) {
      setPickErr((prev) => ({ ...prev, [target]: t('add.folderPickerUnavailable') }))
      return
    }
    pickBusyRef.current = true
    setPickBusy(true)
    setPickErr((prev) => ({ ...prev, [target]: '' }))
    const seq = ++pickSeqRef.current
    try {
      let p: string | null = null
      if (legacy) {
        p = await legacy()
      } else {
        const r = await remotePicker!()
        if (r && typeof r === 'object' && 'ok' in r) {
          if (!r.ok) throw new Error(r?.error?.message ?? 'directory picker failed')
          const v = r.value
          p = typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.path === 'string' ? v.path : null)
        } else {
          p = typeof r === 'string' ? r : null
        }
      }
      if (seq !== pickSeqRef.current) return // 已被手工确认/新请求/弹窗关闭失效：丢弃旧弹窗结果
      if (!mountedRef.current) return // 组件已卸载：不再应用
      if (p && typeof p === 'string') apply(p)
      // p 为 null：用户取消，静默
    } catch (e: any) {
      if (seq !== pickSeqRef.current) return
      if (!mountedRef.current) return // 组件已卸载：不再更新状态
      const msg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e ?? '')
      setPickErr((prev) => ({ ...prev, [target]: t('add.folderPickFail', { msg: msg || 'unknown' }) }))
    } finally {
      if (seq === pickSeqRef.current && mountedRef.current) {
        pickBusyRef.current = false
        setPickBusy(false)
      }
    }
  }

  /** 使在途选择请求失效并清空选择器 UI 状态（弹窗关闭/切换目标时调用） */
  const invalidatePickState = () => {
    pickSeqRef.current++
    pickBusyRef.current = false
    setPickBusy(false)
    setManualPathFor(null)
    setManualPathText('')
    setPickErr({ add: '', bind: '' })
    // 手机端的目录抽屉属于「选择位置」这个动作：目标弹窗关了就不能留一个孤立的抽屉
    closeFolderBrowser()
  }

  /** 手工输入绝对路径（选择器不可用/失败的降级入口）：必须通过 isAbs，并失效在途系统选择请求 */
  const applyManualPath = (target: 'add' | 'bind') => {
    const p = manualPathText.trim()
    if (!p) { setPickErr((prev) => ({ ...prev, [target]: t('add.folderManualEmpty') })); return }
    if (!isAbs(p)) { setPickErr((prev) => ({ ...prev, [target]: t('add.folderManualAbs') })); return }
    pickSeqRef.current++ // 使在途系统选择请求失效（旧弹窗返回后丢弃）
    pickBusyRef.current = false
    setPickBusy(false)
    if (target === 'add') { setWsFolderParent(p); setWsFolderError(false) }
    else if (bindPick) { persistProjects((prev) => ({ ...prev, folders: { ...prev.folders, [bindPick.id]: p } })) }
    setManualPathFor(null)
    setManualPathText('')
    setPickErr((prev) => ({ ...prev, [target]: '' }))
  }

  /** 绑定弹窗「更改」：弹窗选择文件夹，直接作为项目文件夹（从项目当前文件夹开始浏览） */
  const changeBindFolder = () => {
    if (!bindPick || pickBusyRef.current) return
    const current = projects.folders[bindPick.id] || ''
    pickFolder('bind', (p) => {
      persistProjects((prev) => ({ ...prev, folders: { ...prev.folders, [bindPick.id]: p } }))
    }, current)
  }

  /** 绑定 / 解绑会话（弹窗保持打开，绑定结果即时显示在「绑定对话」框里） */
  const setProjectBinding = (id: string, sessionId: string | null) => {
    persistProjects((prev) => {
      const next = { ...prev.bindings }
      if (sessionId) next[id] = sessionId
      else delete next[id]
      return { ...prev, bindings: next }
    })
    setBindListOpen(false)
  }

  /** 复制自定义布局提示词到剪贴板（失败则全选输入框手动复制） */
  const copyCustomLayout = async () => {
    const text = customLayoutText.trim()
    if (!text) { setCopiedToast('fail'); return }
    const prompt = buildCustomLayoutPrompt(text)
    try { (window as any).__dshLastPrompt = prompt } catch {}
    let ok = false
    try { await navigator.clipboard.writeText(prompt); ok = true } catch {}
    if (!ok) {
      // 降级：临时隐藏 textarea 选中提示词全文后 execCommand('copy')
      try {
        const tmp = document.createElement('textarea')
        tmp.value = prompt
        tmp.style.position = 'fixed'
        tmp.style.opacity = '0'
        document.body.appendChild(tmp)
        tmp.focus()
        tmp.select()
        ok = document.execCommand('copy')
        tmp.remove()
      } catch {}
    }
    setCopiedToast(ok ? 'ok' : 'fail')
    if (copyToastTimerRef.current != null) window.clearTimeout(copyToastTimerRef.current)
    copyToastTimerRef.current = window.setTimeout(() => setCopiedToast(null), 6000)
  }

  // 会话快照变化 → 重渲染（驱动项目卡片的完成/待决提醒镜像 + 控制室面板 + 流程窗格工作态 + 预览防抖刷新）
  useEffect(() => {
    const l = () => {
      setNotifyTick((t) => t + 1)
      // 面板失效与共享扫描合并成「每批一次」：多个工作台实例订阅的是同一份快照，原来各做一遍
      queueNotifyBus()
      queueSharedTask('lifecycle', () => {
        // 临时卡片「正在运行」的生命周期：即使控制室没开也要记录「跑 → 停」的真实结束时间
        trackTransientLifecycles()
      })
      queueSharedTask('preview', () => {
        if (splitStore.active && splitStore.spec?.id === CONSOLE_ID) schedulePreviewSweep()
      })
    }
    sessionsSnapshotStore.listeners.add(l)
    // 宿主「待用户决策」登记变化（问题出现/被回答常不伴随会话列表变动，必须单独订阅）
    const bump = () => {
      setNotifyTick((t) => t + 1)
      queueNotifyBus()
      // 待决出现/被回答也会改变「是否算结束」，同步更新生命周期
      queueSharedTask('lifecycle', () => { trackTransientLifecycles() })
    }
    pendingInteractionsStore.listeners.add(bump)
    refreshPendingInteractions() // 初始拉取一次当前登记（wire 之外再兜底）
    // 初次挂载：用当前快照建立游离会话基线（不把历史会话伪造成「刚结束」）
    try { trackTransientLifecycles() } catch {}
    return () => {
      sessionsSnapshotStore.listeners.delete(l)
      pendingInteractionsStore.listeners.delete(bump)
    }
  }, [])

  // 项目表变化 → 控制室卡片刷新（打开中的面板即时更新）
  useEffect(() => {
    queueNotifyBus()
    queueSharedTask('lifecycle', () => { trackTransientLifecycles() })
  }, [projects])

  // 入驻项目的名称/图标与注册集合也是卡片数据源；本地 UI 重绘不再兼任失效信号。
  useEffect(() => { notifyConsole() }, [metas, registeredIds])

  /** 执行产物清单挂载：项目开着 → 锁定各「窗口N」；未开 → 待挂载（打开项目时补挂）。
   *  清单支持单窗口对象（旧格式）与多窗口 JSON 数组（新格式，每元素 {window,path,kind}）。
   *  rawManifest 传入时免二次读取（自愈扫挂先读原文做指纹去重）。全部落位成功后记录挂载指纹。 */
  const applyWidgetManifest = useCallback(async (projectId: string, rawManifest: string | null): Promise<void> => {
    const folder = projectsRef.current.projects.folders[projectId]
    if (!folder) return
    try {
      let raw = rawManifest
      if (raw == null) {
        const r = await fetch('/api/worktable/file?path=' + encodeURIComponent(joinPath(folder, 'widget-result.json')), { cache: 'no-store' })
        if (!r.ok) return
        raw = (await r.text()).trim()
      }
      if (!raw) return
      let d: any = null
      try { d = JSON.parse(raw) } catch {}
      if (!d) return
      const items = Array.isArray(d) ? d : [d]
      const open = splitStore.active && splitStore.spec?.id === projectId
      const saved = open ? splitStore.spec : (projectsRef.current.projects.views[projectId] ?? projectsRef.current.projects.layouts.find((l) => l.id === projectId))
      // 逐项解析目标窗格；同窗格冲突时保留先出现者（防止把两个窗口压进同一个窗格互相覆盖）
      const targets: { row: 'left' | 'top' | 'main'; index: number; content: any }[] = []
      for (const it of items) {
        if (!it) continue
        const content = buildMountContent(folder, it)
        if (!content) continue
        const pane = windowLabelToPane(saved, it.window)
        const row = pane?.row ?? 'main'
        const index = pane?.index ?? 0
        if (targets.some((t) => t.row === row && t.index === index)) continue
        targets.push({ row, index, content })
      }
      if (!targets.length) return
      if (open) {
        // 项目开着：逐窗锁定；全部落位成功才记录指纹（有失败则留待下次自愈重试）
        let allOk = true
        for (const t of targets) {
          splitStore.lockPane(t.row, t.index, t.content)
          if (!paneExists(splitStore.spec, t.row, t.index)) allOk = false
        }
        if (allOk) recordMountedWidget(projectId, raw)
      } else {
        // 项目没开：按项目已保存的 spec 解析目标窗格，暂存，打开项目时锁死补挂
        pendingMountRef.current[projectId] = { entries: targets, fingerprint: raw }
        try { localStorage.setItem('dsh.worktable.pendingMount.v1', JSON.stringify(pendingMountRef.current)) } catch {}
      }
    } catch { /* 无清单文件 = 不挂载 */ }
  }, [])

  /** 自动挂载：绑定会话完成 → 读项目文件夹 widget-result.json → 产物自动挂进对应窗口 */
  const tryAutoMount = useCallback(async (projectId: string, sid: string) => {
    void sid
    await applyWidgetManifest(projectId, null)
  }, [applyWidgetManifest])

  // 完成事件 → 尝试自动挂载（一次完成只消费一次）
  useEffect(() => {
    const byId = sessionsSnapshotStore.snapshot?.byId ?? {}
    for (const [pid, sid] of Object.entries(projects.bindings)) {
      const e = byId[sid]
      if (!e) continue
      if (e.completed === true) {
        // 新一次完成 → 清除旧 done ack，控制室绿光重新点亮（即使旧完成已被确认过）
        if (doneSeenRef.current[sid] !== true) clearNotifyAck(sid)
        doneSeenRef.current[sid] = true
        if (!mountConsumedRef.current.has(sid)) {
          mountConsumedRef.current.add(sid)
          tryAutoMount(pid, sid)
        }
      } else {
        doneSeenRef.current[sid] = false
        mountConsumedRef.current.delete(sid)
      }
    }
  }, [notifyTick, projects.bindings, tryAutoMount])

  // 模板步骤会话完成（AI 已写产出与 _本步摘要.md）→ 自动把最新全貌写回该项目各步骤文档（一次完成只刷一次）
  useEffect(() => {
    const byId = sessionsSnapshotStore.snapshot?.byId ?? {}
    for (const [pid, run] of Object.entries(projects.flows ?? {})) {
      const sids: string[] = run?.stepSessions ? Object.values(run.stepSessions) : []
      for (const sid of sids) {
        const e = byId[sid]
        if (!e || e.completed !== true) continue
        const key = pid + '::' + sid
        if (flowRefreshSeenRef.current[key]) continue
        flowRefreshSeenRef.current[key] = true
        // 重新生成 _项目全局信息.md + 已建各步骤的 _本步要求.md（其「项目全貌」段随之更新）
        window.setTimeout(() => {
          try { refreshProjectInfo(pid) } catch {}
          try {
            const run2 = projectsRef.current.projects.flows?.[pid]
            const folder = projectsRef.current.projects.folders?.[pid]
            if (!run2 || !folder) return
            const tmpl2 = templateById(run2.templateId)
            if (!tmpl2) return
            void (async () => {
              try {
                const globalText = await buildProjectInfoText(pid, true)
                for (const s of tmpl2.steps) {
                  const sid2 = run2.stepSessions?.[s.id]
                  if (!sid2) continue
                  const stepDir = joinPath(folder, s.dir)
                  const index = tmpl2.steps.indexOf(s) + 1
                  const taskText = composeStepSpec({
                    projectName: projectsRef.current.projects.nameOverrides[pid] ?? (projectsRef.current.projects.layouts.find((l) => l.id === pid)?.title ?? pid),
                    templateName: tmpl2.name,
                    folder,
                    index,
                    total: tmpl2.steps.length,
                    step: s,
                    skill: effectiveSkill(s, run2),
                    instruction: effectiveInstruction(s, run2),
                    converge: effectiveConverge(s, run2),
                    stepBrief: stepBriefOf(s, run2),
                  })
                  const embed = globalText.replace(/^#[^\n]*\n/, '').replace(/^> [^\n]*\n/, '').trim()
                  const fileText = taskText + '\n'
                    + (embed ? '\n---\n\n## 项目全貌（自动写入 · 随进度更新，含各步核心信息与文件结构）\n\n' + embed + '\n' : '')
                  await apiWrite(joinPath(stepDir, '_本步要求.md'), fileText)
                }
              } catch { /* 单次刷新失败不影响 */ }
            })()
          } catch {}
        }, 400)
      }
    }
  }, [notifyTick, projects.flows])

  // 自愈扫挂：插件加载 / 项目文件夹变化时，扫描每个项目的 widget-result.json 并落位
  // （「完成事件」通道的兜底：事件丢失、绑定错位、完成时页面未加载等场景下仍能自动挂载；
  //   按清单原文指纹去重——同清单不重复锁定，用户后续手动改窗口内容不会被覆盖）。
  useEffect(() => {
    let cancelled = false
    const folders = projects.folders ?? {}
    ;(async () => {
      for (const pid of Object.keys(folders)) {
        if (cancelled) return
        const folder = folders[pid]
        if (!folder) continue
        try {
          const r = await fetch('/api/worktable/file?path=' + encodeURIComponent(joinPath(folder, 'widget-result.json')), { cache: 'no-store' })
          if (!r.ok) continue
          const raw = (await r.text()).trim()
          if (!raw) continue
          if (mountedWidgetRef.current[pid] === raw) continue
          await applyWidgetManifest(pid, raw)
        } catch { /* 单项目失败不影响其余 */ }
      }
    })()
    return () => { cancelled = true }
  }, [projects.folders, applyWidgetManifest])

  /** 当前快照的子代理索引：与控制室卡片、临时会话生命周期共享同一构建结果。 */
  const sessionKidsIndex = useMemo(
    () => sessionSnapshotIndexOf(sessionsSnapshotStore.snapshot).kidsByParent,
    [notifyTick],
  )
  const emptyKids = useMemo(() => new Set<string>(), [])
  const collectKids = useCallback((sid: string): Set<string> => sessionKidsIndex.get(sid) ?? emptyKids, [sessionKidsIndex, emptyKids])

  /** 项目 → 提醒态：绑定会话（含其子代理）待决(黄) > 完成(绿) > 工作中(蓝)；
   *  状态转移自动清除旧 ack——原生 UI 每个新问题都会重新亮黄，镜像不得被旧确认压住。
   *  工作中不限于绑定会话：模板流程各步会话（未绑定）工作时也点亮对应项目的 busy。 */
  const bindNotifyMap: Record<string, 'done' | 'need' | 'busy'> = useMemo(() => {
    const map: Record<string, 'done' | 'need' | 'busy'> = {}
    const byId = sessionsSnapshotStore.snapshot?.byId ?? {}
    const ack = loadNotifyAck()
    const seen = notifyStateSeenRef.current
    const pr = projectsRef.current
    // 项目关联会话：绑定会话 + 模板步骤会话（去重；绑定会话在首位）
    const sidsOf = (pid: string): string[] => {
      const out: string[] = []
      const b = pr.projects.bindings[pid]
      if (b) out.push(b)
      const fr = pr.projects.flows?.[pid]
      if (fr?.stepSessions) {
        for (const sid of Object.values<any>(fr.stepSessions)) {
          if (typeof sid === 'string' && !out.includes(sid)) out.push(sid)
        }
      }
      return out
    }
    for (const [pid, sid] of Object.entries(projects.bindings)) {
      const e = byId[sid]
      if (!e) continue
      // 是否需要判断：宿主待决登记 / 自身列表字段 / 子代理 / 会话面兜底，多通道聚合
      let needNow = sessionAwaitingDecision(sid) || sessionNotifyState(e) === 'need'
      if (!needNow) {
        for (const cid of collectKids(sid)) {
          const ce = byId[cid]
          if (sessionAwaitingDecision(cid) || (ce && sessionNotifyState(ce) === 'need')) { needNow = true; break }
        }
      }
      if (!needNow) {
        try {
          const face = sessionFaceSnapshotOf(sid)
          if (Array.isArray(face?.pending) && face.pending.length > 0) needNow = true
        } catch {}
      }
      // 状态转移 → 清除旧 ack（新一轮待决重新点亮）
      if (needNow !== seen[sid]) {
        if (seen[sid] !== undefined) clearNotifyAck(sid)
        seen[sid] = needNow
      }
      if (needNow) { if (ack[sid] !== 'need') map[pid] = 'need'; continue }
      if (sessionNotifyState(e) === 'done' && ack[sid] !== 'done') { map[pid] = 'done'; continue }
      if (sessionRunningNow(sid, byId, collectKids)) map[pid] = 'busy'
    }
    // 补充：未绑定（或绑定无提醒）但项目其它会话正在工作 → 圆点/行也亮 busy
    for (const pid of [CONSOLE_ID, ...projects.layouts.map((l) => l.id)]) {
      if (map[pid]) continue
      if (sidsOf(pid).some((sid) => sessionRunningNow(sid, byId, collectKids))) map[pid] = 'busy'
    }
    return map
  }, [projects.bindings, projects.layouts, projects.flows, notifyTick, collectKids])

  /** 原始「待决策」布尔（不随 ack 消失，是真值状态）：绑定会话或任一关联会话
   *  （模板各步会话 / 其子代理）正停在「询问用户决策」环节 → 图标亮黄警示 + 「待决策」标签。
   *  ack 只负责熄灭提醒光晕；只要对话还在等你决定，标签与黄色动态就一直显示。 */
  const needNowMap: Record<string, boolean> = useMemo(() => {
    const res: Record<string, boolean> = {}
    const byId = sessionsSnapshotStore.snapshot?.byId ?? {}
    const pr = projectsRef.current
    const sidsOf = (pid: string): string[] => {
      const out: string[] = []
      const b = pr.projects.bindings[pid]
      if (b) out.push(b)
      const fr = pr.projects.flows?.[pid]
      if (fr?.stepSessions) {
        for (const sid of Object.values<any>(fr.stepSessions)) {
          if (typeof sid === 'string' && !out.includes(sid)) out.push(sid)
        }
      }
      return out
    }
    const needOfSession = (sid: string): boolean => {
      const e = byId[sid]
      if (sessionAwaitingDecision(sid) || sessionNotifyState(e) === 'need') return true
      for (const cid of collectKids(sid)) {
        const ce = byId[cid]
        if (sessionAwaitingDecision(cid) || (ce && sessionNotifyState(ce) === 'need')) return true
      }
      try {
        const face = sessionFaceSnapshotOf(sid)
        if (Array.isArray(face?.pending) && face.pending.length > 0) return true
      } catch {}
      return false
    }
    const pids = [CONSOLE_ID, ...Object.keys(pr.projects.bindings), ...pr.projects.layouts.map((l) => l.id)]
    for (const pid of pids) {
      if (sidsOf(pid).some((sid) => needOfSession(sid))) res[pid] = true
    }
    return res
  }, [projects.bindings, projects.layouts, projects.flows, notifyTick, collectKids])

  /** 卡片 DOM 桥读这两张表的最新值（观察器常驻，不再因它们变化而拆建） */
  const notifyMapsRef: { current: { bind: Record<string, 'done' | 'need' | 'busy'>; need: Record<string, boolean> } } = { current: { bind: {}, need: {} } }
  notifyMapsRef.current = { bind: bindNotifyMap, need: needNowMap }

  /** 确认一条会话的提醒：清异常标记 + 已看待决/完成就熄光（绑定会话与实际进入的会话共用同一份逻辑） */
  const ackSessionNotify = (sid: string): void => {
    const byId = sessionsSnapshotStore.snapshot?.byId ?? {}
    // 点开项目 = 已看到异常 → 清掉红色标记（下个 tick 卡片恢复常态）
    clearAgentErrors([sid, ...Array.from(collectKids(sid))])
    let needNow = sessionAwaitingDecision(sid) || sessionNotifyState(byId[sid]) === 'need'
    for (const cid of collectKids(sid)) {
      if (sessionAwaitingDecision(cid) || sessionNotifyState(byId[cid]) === 'need') { needNow = true; saveNotifyAck(cid, 'need') }
    }
    if (!needNow) {
      const face = sessionFaceSnapshotOf(sid)
      if (Array.isArray(face?.pending) && face.pending.length > 0) needNow = true
    }
    if (needNow) saveNotifyAck(sid, 'need')
    else {
      const st = sessionNotifyState(byId[sid])
      if (st === 'done') saveNotifyAck(sid, 'done')
    }
  }

  /** 点开项目 = 确认提醒：ack 绑定会话（含子代理）的待决/完成状态；
   *  卡片现在会进「正在跑 / 等你回答」的那条会话，那条也要一起 ack，否则它的光晕熄不掉。 */
  const ackProjectNotify = (projectId: string, entered?: string | null) => {
    const pr = projectsRef.current.projects
    const bound = pr.bindings[projectId]
    if (bound) ackSessionNotify(bound)
    if (entered && entered !== bound) ackSessionNotify(entered)
  }
  ackRef.current = ackProjectNotify

  // ── 有效排序 ──
  // 手动：持久化 order（过滤已卸载 id）→ 新注册 id 与布局 id 追加尾部；
  // 最近：有 lastUsed 的按时间降序在前，其余按手动序在后。
  const layoutIds = useMemo(() => projects.layouts.map((l) => l.id), [projects.layouts])
  const aliveRegisteredIds = useMemo(
    () => registeredIds.filter((id) => !projects.removed.includes(id)),
    [registeredIds, projects.removed],
  )
  projectsRef.current = { projects, metas, aliveRegisteredIds }
  projectBindingsRef.current = projects.bindings
  const allIds = useMemo(() => [...aliveRegisteredIds, ...layoutIds], [aliveRegisteredIds, layoutIds])
  const effectiveOrder = useMemo(() => {
    const known = new Set(allIds)
    const stored = projects.order.filter((id) => known.has(id))
    const rest = allIds.filter((id) => !stored.includes(id))
    let list = [...stored, ...rest]
    if (view.orderBy === 'recent') {
      const hot = list.filter((id) => projects.lastUsed[id] != null)
      const cold = list.filter((id) => projects.lastUsed[id] == null)
      hot.sort((a, b) => (projects.lastUsed[b] ?? 0) - (projects.lastUsed[a] ?? 0))
      list = [...hot, ...cold]
    }
    return list
  }, [allIds, projects.order, projects.lastUsed, view.orderBy])

  const ownerProps = {
    query: view.query.trim(),
    wide,
    managing: viewOptionsOpen,
    order: effectiveOrder,
    hidden: [...projects.hidden, ...projects.removed],
    nameOverrides: projects.nameOverrides,
    iconOverrides: projects.iconOverrides,
    reportMeta,
    reportUsed,
    openSplit,
    activeSplitId,
  }

  // ── 拖动（≡ 手柄，与 v1 相同）──
  const onHandlePointerDown = (e: any) => {
    const root = rootRef.current
    if (!root) return
    const startRect = root.getBoundingClientRect()
    dragRef.current = { startY: e.clientY, startX: e.clientX, startRect, dragging: false, prevFloat: float }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
    invalidatePickState()
    setViewOptionsOpen(false); setAddOpen(false)
  }

  const onHandlePointerMove = (e: any) => {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.startY
    if (!d.dragging && Math.abs(dy) < 6) return
    d.dragging = true
    // 浮动上限按区块实际高度计算：停靠位紧邻其下方，向上拖即可自然落位
    const maxTop = Math.max(MIN_TOP, window.innerHeight - d.startRect.height - 12)
    setFloat({ top: clamp(d.startRect.top + dy, MIN_TOP, maxTop) })
  }

  const onHandlePointerUp = (e: any) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || !d.dragging) return
    // 落点判定：以「松手瞬间指针位置」判断是否有有效落点（快速甩出范围 = 无落点）
    const maxTop = Math.max(MIN_TOP, window.innerHeight - d.startRect.height - 12)
    const rawTop = d.startRect.top + (e.clientY - d.startY)
    const outOfRange =
      rawTop > maxTop + OVER_BOTTOM_PX ||
      rawTop < MIN_TOP - OVER_TOP_PX ||
      e.clientX < d.startRect.left - OVER_SIDE_PX ||
      e.clientX > d.startRect.right + OVER_SIDE_PX
    if (outOfRange) {
      // 无有效落点：回归拖前位置（不持久化任何变化）
      setFloat(d.prevFloat)
      return
    }
    setFloat((cur) => {
      if (!cur) return null
      if (Math.abs(cur.top - d.startRect.top) < SNAP_PX) {
        persistView({ dock: 'footer', floatTop: null })
        return null
      }
      persistView({ dock: 'float', floatTop: cur.top })
      return cur
    })
  }

  const resetDock = () => {
    setFloat(null); persistView({ dock: 'footer', floatTop: null })
  }

  // Esc 关闭搜索
  const onSearchKeyDown = (e: any) => {
    if (e.key === 'Escape') {
      persistView({ searchOpen: false, query: '' })
    }
  }

  // ── 编辑模式动作（排序只用左缘 ≡ 抓手拖拽，无 ↑↓ 按钮） ──
  const moveTo = (id: string, targetId: string) => {
    if (id === targetId) return
    const list = [...effectiveOrder]
    const from = list.indexOf(id)
    const to = list.indexOf(targetId)
    if (from < 0 || to < 0) return
    list.splice(from, 1)
    list.splice(to, 0, id)
    persistProjects({ order: list })
  }

  const toggleHidden = (id: string) => {
    persistProjects((prev) => {
      const hidden = prev.hidden.includes(id)
        ? prev.hidden.filter((x) => x !== id)
        : [...prev.hidden, id]
      return { ...prev, hidden }
    })
  }

  const renameProject = (id: string, name: string) => {
    const trimmed = name.trim()
    persistProjects((prev) => {
      const current = prev.nameOverrides[id]
      // 名字没变就不写：避免每次打开/收起改名框都触发一次控制室重渲染
      if ((current ?? '') === trimmed) return prev
      const next = { ...prev.nameOverrides }
      if (trimmed) next[id] = trimmed
      else delete next[id]
      return { ...prev, nameOverrides: next }
    })
  }



  // ── 快捷方式（表单已移除，仅保留存量条目的删除能力） ──
  const removeShortcut = (id: string) => {
    persistProjects((prev) => ({ ...prev, shortcuts: prev.shortcuts.filter((s) => s.id !== id) }))
  }

  // ── 模板流程（flow）helper：面板数据组装与步骤动作（供 env.flow 桥调用） ──
  /** 组装某模板实例的流程视图（FlowPane 读）；非模板项目返回 null */
  const buildFlowView = (projectId: string): FlowView | null => {
    const pr = projectsRef.current.projects
    const layout = pr.layouts.find((l) => l.id === projectId)
    const run = pr.flows?.[projectId]
    if (!layout || !run) return null
    const tmpl = templateById(run.templateId)
    if (!tmpl) return null
    const startIndex = Math.min(Math.max(run.startIndex ?? 0, 0), Math.max(0, tmpl.steps.length - 1))
    const doneSet = new Set(run.done)
    const steps: FlowStepView[] = tmpl.steps.map((s, i) => {
      if (i < startIndex) {
        return { ...s, status: 'skipped', skill: effectiveSkill(s, run), instruction: effectiveInstruction(s, run), converge: effectiveConverge(s, run), briefConfirmed: isStepBriefConfirmed(s, run), briefSaved: run.stepBriefs?.[s.id] }
      }
      const isDone = doneSet.has(s.id)
      const isCurrent = !isDone && (i === startIndex || doneSet.has(tmpl.steps[i - 1].id))
      return {
        ...s,
        status: isDone ? 'done' : isCurrent ? 'current' : 'locked',
        skill: effectiveSkill(s, run),
        instruction: effectiveInstruction(s, run),
        converge: effectiveConverge(s, run),
        briefConfirmed: isStepBriefConfirmed(s, run),
        briefSaved: run.stepBriefs?.[s.id],
        doneAt: run.doneAt?.[s.id],
      }
    })
    const inRange = tmpl.steps.filter((_, i) => i >= startIndex)
    const doneCount = inRange.reduce((n, s) => (doneSet.has(s.id) ? n + 1 : n), 0)
    const curIdx = steps.findIndex((s) => s.status === 'current')
    const curStepId = curIdx >= 0 ? tmpl.steps[curIdx].id : null
    // 当前步验收环状态（面板徽标；无 blocks 的步骤为 null）
    if (curStepId != null) {
      const v = run.verify?.[curStepId]
      const curView = steps[curIdx]
      if (curView) curView.verify = v ?? null
    }
    // 验收环通知（仅本项目；at 变化时 FlowPane 弹 toast）
    const vn = verifyNotifyStore.current
    const alert = vn && vn.projectId === projectId ? { msg: vn.msg, kind: vn.kind, at: vn.at } : null
    // 当前步专属会话是否正在工作（AI 交付中；FlowPane 据此把「开始此步」置灰防误点）
    const curSid = curStepId != null ? run.stepSessions?.[curStepId] : null
    const curBusy = !!curSid && sessionRunningNow(curSid, sessionsSnapshotStore.snapshot?.byId ?? {}, collectKids)
    return {
      projectId,
      projectName: pr.nameOverrides[projectId] ?? layout.title,
      templateId: tmpl.id,
      templateName: tmpl.name,
      templateIcon: tmpl.icon,
      folder: pr.folders[projectId] ?? '',
      bound: !!pr.bindings[projectId],
      brief: (pr.briefs ?? {})[projectId] ?? '',
      sessionReady: curStepId !== null && !!run.stepSessions?.[curStepId],
      currentBusy: curBusy,
      startIndex,
      total: tmpl.steps.length,
      doneCount,
      currentIndex: curIdx < 0 ? tmpl.steps.length : curIdx,
      allDone: doneCount >= inRange.length,
      alert,
      steps,
    }
  }

  /** 更新某模板实例的 flows 运行状态（写 localStorage + 触发面板刷新） */
  const patchFlowRun = (projectId: string, patch: (cur: FlowRunState) => FlowRunState) => {
    persistProjects((prev) => {
      const flows = prev.flows ?? {}
      const cur = flows[projectId]
      if (!cur) return prev
      return { ...prev, flows: { ...flows, [projectId]: patch(cur) } }
    })
  }

  /** 保存项目概况（论文/项目全局信息 markdown）：写入 projects.briefs → 重写项目根 _项目全局信息.md → 刷新面板。
   *  之后每次「开始此步」都会把全局信息全文带进该步 _本步要求.md。（可选补充信息；论文模板的开工门控看每步「📝 初始信息」） */
  const saveProjectBrief = (projectId: string, text: string) => {
    const cleaned = String(text ?? '').trim()
    persistProjects((prev) => {
      const briefs = { ...(prev.briefs ?? {}) }
      if (cleaned) briefs[projectId] = cleaned
      else delete briefs[projectId]
      return { ...prev, briefs }
    })
    refreshProjectInfo(projectId)
  }

  /** 保存某步「初始信息」（用户在面板「📝 初始信息」确认的本步针对性提示词；存本项目 FlowRunState.stepBriefs）。
   *  保存即确认——之后点「▶ 开始此步」门控放行，内容注入任务卡「本步初始信息」小节发进工人会话。 */
  const saveStepBrief = (projectId: string, stepId: string, text: string) => {
    persistProjects((prev) => {
      const flows = prev.flows ?? {}
      const cur = flows[projectId]
      if (!cur) return prev
      return {
        ...prev,
        flows: {
          ...flows,
          [projectId]: { ...cur, stepBriefs: { ...(cur.stepBriefs ?? {}), [stepId]: String(text ?? '') } },
        },
      }
    })
  }

  /** API 封装：mkdir（幂等）/ 写文件 */
  const apiMkdir = async (path: string): Promise<boolean> => {
    try {
      const r = await fetch('/api/worktable/mkdir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
      return r.ok
    } catch { return false }
  }
  const apiWrite = async (path: string, content: string): Promise<boolean> => {
    try {
      const r = await fetch('/api/worktable/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content }) })
      return r.ok
    } catch { return false }
  }

  /** 生成「项目全局信息」md 文本（项目根 <folder>/_项目全局信息.md；每个步骤会话开工前先读）。
   *  内容 = 用户概况 + 模板/进度 + 目录约定 + 自动盘点（随进度实时扫描项目文件夹：每步真实产出文件
   *  与各步「_本步摘要.md」核心信息），方便任何一步都能掌握项目全貌。 */
  const buildProjectInfoText = async (projectId: string, summaryOnly = false): Promise<string> => {
    const pr = projectsRef.current.projects
    const layout = pr.layouts.find((l) => l.id === projectId)
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    if (!layout || !run || !tmpl) return ''
    const folder = pr.folders[projectId] ?? ''
    const projectName = pr.nameOverrides[projectId] ?? layout.title
    const startIndex = run.startIndex ?? 0
    const doneSet = new Set(run.done)
    /** 内联到各步 _本步要求.md 时（summaryOnly）只嵌摘要前 800 字，控制提示词长度；
     *  完整摘要始终在项目根 _项目全局信息.md 与本步 _本步摘要.md，需要时自行读取。 */
    const digestLimit = summaryOnly ? 800 : 6000
    const lines: string[] = []
    lines.push(`# ${projectName} · 项目全局信息`)
    lines.push('')
    lines.push('> 本文件由 dsh-worktable「模板流程」在项目文件夹自动生成并随进度更新。任何步骤会话开工前请先阅读本文件，了解论文/项目概况、文件夹结构与流程进度。')
    lines.push('')
    // 用户填写的项目概况（论文写作全局信息 / 迭代收敛的任务定义）——全文内联在最前，方便各步骤与 AI 快速掌握
    const isConv = tmpl.steps.some((s) => (s.blocks ?? []).some((b) => b.converge))
    const briefTitle = isConv ? '任务定义（用户填写）' : '论文写作全局信息（用户填写）'
    const briefRaw = ((pr.briefs ?? {})[projectId] ?? '').trim()
    if (briefRaw) {
      lines.push(`## ${briefTitle} · 各步骤开工前必读`)
      lines.push('')
      lines.push(briefRaw)
      lines.push('')
    } else {
      lines.push(`## ${briefTitle}（尚未填写）`)
      lines.push('')
      lines.push(isConv
        ? '> 提示：本文件目前只有框架信息，**没有任务正文**——即任务尚未定义（元数据里该字段叫 projects.briefs）。请在流程面板点「📝 任务定义」填写（要做什么 / 产出什么 / 输入素材 / 硬约束；如需固定评分标准再补一节「## 评分细则」）。未填写时点「开始此步」会被拦住，不会空跑。'
        : '> 提示：本文件目前只有框架信息，没有论文主题/方法/数据等全局内容。本项目概况为**可选补充**——每步开工的必需信息在流程面板各步的「📝 初始信息」里确认（已按各步任务预填默认提示词）。想填全局信息（题目、研究问题、方法路线、数据与算例、创新点、目标期刊与篇幅语言要求、写作偏好/约束等）可点面板「📝 项目概况」，会随进度自动写入每个步骤 _本步要求.md 的「项目全貌」段落。')
      lines.push('> 填写保存后，会随进度自动写入每个步骤 _本步要求.md 的「项目全貌」段落，任意一步开工即可看到。')
      lines.push('')
    }
    lines.push('## 项目与模板')
    lines.push('')
    lines.push(`- 项目名称：${projectName}`)
    lines.push(`- 模板：${tmpl.name}（id: ${tmpl.id}）`)
    lines.push(`- 项目文件夹：${folder}`)
    lines.push(`- 起始步骤：第 ${Math.min(startIndex + 1, tmpl.steps.length)}/${tmpl.steps.length} 步起（此前步骤无需完成）`)
    lines.push('')
    lines.push('## 流程进度')
    lines.push('')
    const doneTitles = tmpl.steps.filter((s, i) => i >= startIndex && doneSet.has(s.id)).map((s) => `${s.icon} ${s.title}`)
    const inRangeCount = tmpl.steps.length - Math.min(startIndex, tmpl.steps.length)
    lines.push(`- 已通过（有效区间 ${doneTitles.length}/${inRangeCount}）：${doneTitles.length ? doneTitles.join('、') : '（无）'}`)
    const cur = tmpl.steps.find((s, i) => i >= startIndex && !doneSet.has(s.id))
    lines.push(`- 当前待做：${cur ? `${cur.icon} ${cur.title}（第 ${tmpl.steps.indexOf(cur) + 1}/${tmpl.steps.length} 步）` : '全部完成 🎉'}`)
    lines.push('')
    lines.push('## 文件夹结构（步骤目录 = 对应步骤会话的工作目录）')
    lines.push('')
    lines.push(`- ${folder}/`)
    tmpl.steps.forEach((s, i) => {
      const tag = i < startIndex ? '（跳过）' : doneSet.has(s.id) ? '（已通过）' : '（待做）'
      lines.push(`  - ${s.dir}/  ${s.icon} ${s.title} ${tag}`)
    })
    lines.push('- _项目全局信息.md（本文件）')
    lines.push('')
    lines.push('## 协作约定（写给项目 AI；硬性要求）')
    lines.push('')
    lines.push('1. 每个步骤会话的工作目录（cwd）是其对应步骤子目录；本步骤全部产物必须写入该子目录，禁止写到 cwd 以外或其它步骤目录。')
    lines.push('2. 若当前步骤子目录内有「_本步要求.md」，开工前必须先读并逐条遵守（内含用户硬性要求，优先级高于一般约定）。')
    lines.push('3. 需要上下文时可读取本项目文件夹内其它文件（含其它步骤产物与本文件），但不要修改其它步骤的文件。')
    lines.push('4. 完成步骤后，在回复开头给出硬性要求核验结果与产出文件名清单（相对 cwd 路径），便于人工确认。')
    lines.push('')
    // ── 自动盘点（随进度实时更新）：项目根 + 每步目录的真实文件结构 + 各步 _本步摘要.md 核心信息 ──
    lines.push('## 文件与产出（自动盘点）')
    lines.push('')
    lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}。以下为项目文件夹当前实际内容，随各步交付自动更新；每步子目录内的「_本步摘要.md」是本步 AI 交付时写入的核心信息，全局自动汇总，方便任意一步了解全貌。`)
    lines.push('')
    const rootEntries = await wtListDir(folder)
    if (rootEntries) {
      const rootDirs = rootEntries.filter((e) => e.isDir)
      const rootFiles = rootEntries.filter((e) => !e.isDir && !e.name.startsWith('_'))
      lines.push(`### 项目根 ${folder.replace(/[\\/]+$/, '')}/`)
      lines.push('')
      lines.push(`- 步骤目录：${rootDirs.length ? rootDirs.map((d) => d.name).join('、') : '（暂无）'}`)
      lines.push(`- 根级文件：${rootFiles.length ? rootFiles.map((f) => f.name).join('、') : '（暂无）'}`)
      lines.push('')
    }
    for (const [si, s] of tmpl.steps.entries()) {
      const tag = si < startIndex ? '（跳过）' : doneSet.has(s.id) ? '（已通过）' : s.id === cur?.id ? '（当前）' : '（待做）'
      const sub = joinPath(folder, s.dir)
      lines.push(`### ${si + 1}. ${s.icon} ${s.title} ${tag}`)
      lines.push('')
      lines.push(`- 目录：${s.dir}/`)
      const entries = await wtListDir(sub)
      if (!entries) {
        lines.push('- 产出文件：暂无（目录未创建或无权限）')
        lines.push('')
        continue
      }
      const subDirs = entries.filter((e) => e.isDir)
      const files = entries.filter((e) => !e.isDir && !e.name.startsWith('_'))
      const names = [...subDirs.map((d) => d.name + '/'), ...files.map((f) => f.name)]
      if (names.length === 0) {
        lines.push('- 产出文件：暂无产出')
      } else {
        const shown = names.slice(0, 80)
        lines.push(`- 产出文件（${names.length}）：${shown.join('、')}${names.length > shown.length ? ' …等' : ''}`)
      }
      const digest = await wtReadText(joinPath(sub, '_本步摘要.md'))
      if (digest && digest.trim()) {
        const body = digest.trim()
        lines.push('- 本步核心信息（_本步摘要.md）：')
        const q = body.slice(0, digestLimit).split('\n').map((l) => (l.trim() ? '> ' + l : '>')).join('\n')
        lines.push(q)
        if (body.length > digestLimit) {
          lines.push(summaryOnly
            ? `> …（此处只嵌前 ${digestLimit} 字；完整摘要见项目根 _项目全局信息.md 或本步目录 _本步摘要.md）`
            : '> …（摘要过长，已截断）')
        }
      } else {
        lines.push('- 本步核心信息：暂无（该步 AI 交付时应写入 _本步摘要.md，随后全局信息自动汇总）')
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  /** 更新项目根 _项目全局信息.md（尽力而为；内部延迟一拍，等 projectsRef 同步到最新再自动盘点生成） */
  const refreshProjectInfo = (projectId: string): void => {
    window.setTimeout(() => {
      void (async () => {
        try {
          const folder = projectsRef.current.projects.folders[projectId]
          if (!folder) return
          const text = await buildProjectInfoText(projectId)
          if (!text) return
          void apiWrite(joinPath(folder, '_项目全局信息.md'), text)
        } catch { /* 生成失败不阻断 */ }
      })()
    }, 150)
  }

  /** 为某步骤在「步骤子目录」开会话（目录已由 startFlowStep 确保存在；已建则复用）。返回会话 id 或 null */
  const ensureStepSession = async (projectId: string, stepId: string): Promise<string | null> => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    if (!run || !tmpl) return null
    if (run.stepSessions?.[stepId]) return run.stepSessions[stepId]
    const folder = pr.folders[projectId] ?? ''
    const step = tmpl.steps.find((s) => s.id === stepId)
    if (!step || !folder) return null
    const stepDir = joinPath(folder, step.dir)
    if (!(await apiMkdir(stepDir))) return null
    // 会话标题命名规范：工人会话 = 「NN 步名」（如 07 图精修），与步骤目录同序，列表一眼可辨
    const stepNo = String(tmpl.steps.findIndex((s) => s.id === stepId) + 1).padStart(2, '0')
    const sessionId = await createSessionAtFolder(stepDir, `${stepNo} ${step.title}`)
    if (!sessionId) return null
    await ensureSessionPreset(sessionId)
    await ensureSessionModel(sessionId)
    patchFlowRun(projectId, (cur) => ({
      ...cur,
      stepSessions: { ...(cur.stepSessions ?? {}), [stepId]: sessionId },
    }))
    return sessionId
  }

  /** 开始步骤：到该步才创建步骤子目录 → 刷新项目全局信息 md → 把本步任务/硬性要求落盘到
   *  步骤子目录 _本步要求.md → 在子目录开（复用）专属会话并切过去。不填输入框、不自动发送，
   *  由用户在会话里自行发出开始指令。返回面板反馈文案 */
  const startFlowStep = async (projectId: string, stepId: string): Promise<string> => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const layout = pr.layouts.find((l) => l.id === projectId)
    const tmpl = run ? templateById(run.templateId) : undefined
    if (!run || !tmpl || !layout) return '⚠️ 该项目不是有效的模板项目。'
    const startIndex = run.startIndex ?? 0
    const idx = tmpl.steps.findIndex((s) => s.id === stepId)
    if (idx < 0) return '⚠️ 找不到该步骤。'
    if (idx < startIndex) return 'ℹ️ 该步骤在起始步之前，无需执行。'
    if (run.done.includes(stepId)) return 'ℹ️ 该步骤已通过。'
    if (idx > startIndex && !run.done.includes(tmpl.steps[idx - 1].id)) return '🔒 前序步骤未通过，无法开始此步。'
    const folder = pr.folders[projectId] ?? ''
    const step = tmpl.steps[idx]
    const stepDir = joinPath(folder, step.dir)
    // 0) 开工门控：初始信息为空则不开工（否则工人只拿到模板默认提示词、没有任何项目背景，必然空跑）。
    //    迭代收敛项目 = 全局「📝 任务定义」（projects.briefs，单步通用任务）；论文写作模板 = **每步各自的**
    //    「📝 初始信息」（FlowRunState.stepBriefs，针对性提示词，用户须逐步确认/修改并保存）。
    //    两种门控都只拦「首次开工」（本步尚无验收环进度），已有进度的不拦——「⏯ 继续本步」照常可用。
    if (!run.verify?.[stepId]) {
      if (isConvergeStep(step)) {
        const brief = String((pr.briefs ?? {})[projectId] ?? '').trim()
        if (!brief) {
          return '⚠️ 迭代收敛项目尚未定义任务，已阻止开工：请先在流程面板点「📝 任务定义」填写【任务正文】（做什么 / 产出什么 / 硬约束）；如需固定评分标准，再补一节「## 评分细则」（维度 + 权重 + 各分档标准）。保存后再点「▶ 开始此步」。'
        }
      } else if (!isStepBriefConfirmed(step, run)) {
        return '⚠️ 本步尚未确认「初始信息」，已阻止开工：请点本步的「📝 初始信息」按钮——默认提示词已按本步任务针对性预填（【】中为待你替换的内容），改成你的实际情况后保存（不改也可直接保存），再点「▶ 开始此步」。'
      }
    }
    // 0b) 串行执行门控（本地单槽位模型，llama.cpp parallel=1：同一时刻只允许一个会话运行）：
    //     本收敛步的裁判会话仍在运行时，不给工人发新任务（否则两个会话并行易卡死）。
    if (isConvergeStep(step)) {
      const vsid = run.verify?.[stepId]?.verifierSid
      if (vsid && sessionRunningNow(vsid, sessionsSnapshotStore.snapshot?.byId ?? {}, collectKids)) {
        return '⚠️ 裁判会话仍在运行：本地模型同一时刻只允许一个会话运行，暂不给工人发新任务。请等裁判结束（若卡死，先在 DSH 会话列表手动停掉该裁判会话），再点「▶ 开始此步」。'
      }
    }
    // 1) 到该步才创建步骤子目录（本步所有产出都放这里）
    if (!(await apiMkdir(stepDir))) return '⚠️ 无法创建步骤目录：' + stepDir
    // 1b) 兜底：老项目缺 L2 叠加层时补写默认 _项目验收叠加.md（工人与验收员协议要求必读）。
    //     迭代收敛步不写论文版叠加层（写作语言对它无意义，任务与标准写在面板「📝 任务定义」里）。
    if (!isConvergeStep(step)) {
      try {
        const overlayPath = joinPath(folder, OVERLAY_FILE)
        if (!(await wtReadText(overlayPath))) {
          await apiWrite(overlayPath, [
            '# 项目验收叠加层（L2）', '',
            '> 自动补写的默认版本；请把写作语言等信息填准（见项目根此文件）。冲突时优先级：本文件 > 个人写作基准 > 02-十步验收标准。',
            '- 写作语言：中文写作后翻译英文', '',
            '## 本项目的特殊验收要求', '', '（可手工增删）', '',
          ].join('\n'))
        }
      } catch { /* 叠加层兜底失败不阻断 */ }
    }
    patchFlowRun(projectId, (cur) => ({ ...cur, lastStartedAt: { ...(cur.lastStartedAt ?? {}), [stepId]: Date.now() } }))
    // 2) 自动盘点生成「项目全貌」文本（含用户概况 + 进度 + 实时文件结构与各步摘要核心信息），
    //    供嵌入每步 _本步要求.md（并写一份镜像到项目根，供快速查看）
    let globalInfoText = ''
    // summaryOnly=true：嵌入 _本步要求.md 的「项目全貌」只保留摘要前 800 字，避免提示词膨胀
    try { globalInfoText = await buildProjectInfoText(projectId, true) } catch { globalInfoText = '' }
    if (globalInfoText) {
      try { await apiWrite(joinPath(folder, '_项目全局信息.md'), globalInfoText) } catch {}
    }
    // 2b) 组装 _本步要求.md（自包含全文：任务卡 + 本步验收标准 + 前置步骤盘点 + 项目全貌）。
    //     分工：会话消息只发精简任务卡（composeStepTask），长清单只在此文件，AI 需要细节时自行读取。
    //     验收标准从 02-十步验收标准.md 实时读取，用户手动修改后立即生效。
    const backfill = await buildPriorStepsBackfill(folder, tmpl, idx)
    let l1Entries: string[] | undefined
    try {
      const l1Content = await wtReadText(l1ChecklistPath())
      if (l1Content) {
        const l1Map = parseL1Checklist(l1Content)
        l1Entries = l1Map.get(stepId)
      }
    } catch {}
    try {
      const taskText = composeStepSpec({
        projectName: pr.nameOverrides[projectId] ?? layout.title,
        templateName: tmpl.name,
        folder,
        index: idx + 1,
        total: tmpl.steps.length,
        step,
        skill: effectiveSkill(step, run),
        instruction: effectiveInstruction(step, run),
        converge: effectiveConverge(step, run),
        l1Entries,
        stepBrief: stepBriefOf(step, run),
      }) + backfill
      const embed = (globalInfoText || '').replace(/^#[^\n]*\n/, '').replace(/^> [^\n]*\n/, '').trim()
      const fileText = taskText + '\n'
        + (embed ? '\n---\n\n## 项目全貌（自动写入 · 随进度更新：论文概况 / 进度 / 各步核心信息与文件结构）\n\n' + embed + '\n' : '')
      await apiWrite(joinPath(stepDir, '_本步要求.md'), fileText)
    } catch {}
    // 3) 步骤专属会话：cwd = 步骤子目录（到该步才建；已建则复用）
    const sid = await ensureStepSession(projectId, stepId)
    if (!sid) return '⚠️ 无法在本步子目录开会话（宿主不可用）。可手动在右侧新建会话并把工作目录设为：' + stepDir
    // 3b) 验收环状态：首次开工才初始化；已有进度则**保留块/轮次**（仅刷新工人会话与派发时间），
    //     避免「重开此步 = 从第 1 块重跑」丢进度。需要清零时用面板「🔄 重置本步」。
    const hasBlocks = !!step.blocks && step.blocks.length > 0
    const prevVerify = run.verify?.[stepId]
    // 只要已有验收环状态就**一律保留进度**（含 step-passed：已全部通过、等终审的步不该被"开始此步"清零）。
    // 需要从第 1 块重跑时，用户显式点面板「🔄 重置本步」——避免"意外中止后点开始/继续 → 轮次被打回第 1 轮"。
    const hasProgress = !!prevVerify
    if (hasBlocks) {
      patchFlowRun(projectId, (cur) => ({
        ...cur,
        verify: {
          ...(cur.verify ?? {}),
          [stepId]: hasProgress
            ? {
                ...prevVerify!, workerSid: sid, stalled: false, workerDispatchedAt: Date.now(),
                // 「▶ 开始此步」= 显式恢复：清掉手动停止标记（否则调度器会继续整体跳过本步）
                userStopped: false,
                // 老状态补写累计轮次，保证后续显示/报告名不回退
                stepRound: prevVerify!.stepRound ?? prevVerify!.round,
                // 重新开工 = 给本块一次新的验收机会：清掉"最后改稿已派"标记，
                // 否则工人这次干完活会被直接强制收尾、没有任何验收（表现为"交付后无反应"）。
                // 轮次不重置（继续递增），所以不会退化成无限循环。
                ...(prevVerify!.finalRevise ? { finalRevise: false, phase: 'working' as const } : {}),
              }
            : { ...VerifyScheduler.initState(), workerSid: sid },
        },
      }))
    }
    // 4) 切到该步专属会话，并把任务自动发送进去（2.0 全自动：任务+验收协议+质量基线见 _本步要求.md，已一并注入会话）
    try {
      markPluginSessionOpen(sid) // 插件发起的切换：不触发「切会话关项目」联动
      openSessionInHost(sid)
      let sent = false
      try {
        const taskText = composeStepTask({
          projectName: pr.nameOverrides[projectId] ?? layout.title,
          templateName: tmpl.name, folder,
          index: idx + 1, total: tmpl.steps.length, step,
          skill: effectiveSkill(step, run), instruction: effectiveInstruction(step, run),
          converge: effectiveConverge(step, run),
          stepBrief: stepBriefOf(step, run),
        }) + backfill
        await promptIntoSession(sid, taskText)
        sent = true
      } catch { sent = false }
      if (hasBlocks) {
        const isConverge = isConvergeStep(step)
        const cfg = effectiveConverge(step, run)
        const progressNote = hasProgress
          ? `ℹ️ 检测到本步已有进度（${isConverge ? `累计第 ${prevVerify!.stepRound ?? prevVerify!.round} 轮 · 最佳 ${prevVerify!.bestScore ?? '—'} 分` : `第 ${(prevVerify!.blockIdx ?? 0) + 1} 块 · 累计第 ${prevVerify!.stepRound ?? prevVerify!.round} 轮`}${prevVerify!.phase === 'step-passed' ? ' · 已收敛待终审' : ''}），已保留未重置；如要从头重跑请点「🔄 重置本步」。`
          : ''
        return progressNote + `✅ 已开工（${isConverge ? '迭代收敛模式' : '自动验收模式'}）：步骤目录「${step.dir}/」已就绪，任务已自动发入本步专属会话。` + (sent
          ? (isConverge
            ? `工人产出→每轮由独立裁判（新会话）按 _rubric.md JSON 评分，仅当新分>旧分才采纳、否则回退保留最佳版本；循环至达标(≥${cfg?.target ?? 93})／达轮次上限(${cfg?.maxRounds ?? 8})／连续${cfg?.plateau ?? 2}轮无改进。收敛后你在面板点「✓ 通过」终审即可。可旁观工人与裁判会话。`
            : '工人按「分块交付与验收协议」逐块交付；每轮由独立验收员（stage-verifier）核验，PASS 自动推进、FAIL 自动打回（连续 3 轮暂停等你介入）；全部通过后你在面板点「✓ 通过」终审即可。可旁观工人与验收员会话。')
          : '⚠️ 任务自动发送失败：请在该会话里手动说「请阅读 _本步要求.md，然后执行本步」。')
      }
      return `✅ 已就绪：步骤目录「${step.dir}/」已创建，已打开并切换到该步专属会话。` + `本步任务与硬性要求、以及自动更新的项目全貌（进度/核心信息/文件结构）都已写入该目录 _本步要求.md；在会话里发出开始指令即可，例如：「请阅读 _本步要求.md，然后执行本步」。`
    } catch (e) {
      return '⚠️ 准备会话失败：' + String(e)
    }
  }

  /** 重置本步验收环：清零块/轮次进度从第 1 块第 1 轮重跑（面板「🔄 重置本步」）。
   *  不删除任何产物文件——工人会按验收清单重新自纠后交付。 */
  const resetFlowStep = (projectId: string, stepId: string): string => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    if (!run || !tmpl) return '⚠️ 该项目不是有效的模板项目。'
    const step = tmpl.steps.find((s) => s.id === stepId)
    if (!step) return '⚠️ 找不到该步骤。'
    if (!step.blocks || step.blocks.length === 0) return 'ℹ️ 本步没有分块验收环，无需重置。'
    const sid = run.stepSessions?.[stepId]
    patchFlowRun(projectId, (cur) => ({
      ...cur,
      verify: { ...(cur.verify ?? {}), [stepId]: { ...VerifyScheduler.initState(), workerSid: sid } },
    }))
    return '🔄 已重置本步验收环：从第 1 块第 1 轮重跑（产物文件未删除，工人会重新自纠后交付）。'
  }

  /** 一键继续本步（面板「⏯ 继续本步」/暂停方案卡「继续本步」）：委托验收环调度器按当前阶段续跑，不重置进度 */
  const resumeFlowStep = async (projectId: string, stepId: string): Promise<string> => {
    const s = verifySchedulerRef.current
    if (!s) return '⚠️ 验收环调度器未就绪：请刷新页面后重试。'
    try {
      return await s.resumeStep(projectId, stepId)
    } catch (e) {
      return '⚠️ 继续失败：' + String(e)
    }
  }

  /** 手动停止本步（面板「⏹ 停止」）：中断在跑会话 + 调度器停派，杜绝"手动终止会话后又自动开新会话"；进度保留 */
  const stopFlowStep = async (projectId: string, stepId: string): Promise<string> => {
    const s = verifySchedulerRef.current
    if (!s) return '⚠️ 验收环调度器未就绪：请刷新页面后重试。'
    try {
      return await s.stopStep(projectId, stepId)
    } catch (e) {
      return '⚠️ 停止失败：' + String(e)
    }
  }

  /** 撤销通过：把该步及之后所有步骤退回未通过（顺序约束下用于修改后重走） */
  const markFlowUndo = (projectId: string, stepId: string) => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    if (!run || !tmpl) return
    if (!run.done.includes(stepId)) return
    const idx = tmpl.steps.findIndex((s) => s.id === stepId)
    if (idx < 0) return
    const removeSet = new Set(tmpl.steps.slice(idx).map((s) => s.id))
    patchFlowRun(projectId, (cur) => {
      const done = cur.done.filter((id) => !removeSet.has(id))
      const doneAt = { ...(cur.doneAt ?? {}) }
      const lastStartedAt = { ...(cur.lastStartedAt ?? {}) }
      const verify = { ...(cur.verify ?? {}) }
      for (const id of removeSet) { delete doneAt[id]; delete lastStartedAt[id]; delete verify[id] }
      return {
        ...cur,
        done,
        doneAt: Object.keys(doneAt).length > 0 ? doneAt : undefined,
        lastStartedAt: Object.keys(lastStartedAt).length > 0 ? lastStartedAt : undefined,
        verify: Object.keys(verify).length > 0 ? verify : undefined,
      }
    })
    refreshProjectInfo(projectId)
  }

  /** 用户确认通过（绿标）；顺序校验：仅当前步可标记 */
  const markFlowStepDone = (projectId: string, stepId: string) => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    if (!run || !tmpl) return
    const idx = tmpl.steps.findIndex((s) => s.id === stepId)
    if (idx < 0 || run.done.includes(stepId)) return
    const startIndex = run.startIndex ?? 0
    if (idx < startIndex) return
    if (idx > startIndex && !run.done.includes(tmpl.steps[idx - 1].id)) return
    patchFlowRun(projectId, (cur) => {
      const verify = { ...(cur.verify ?? {}) }
      delete verify[stepId]
      return {
        ...cur,
        done: [...cur.done, stepId],
        doneAt: { ...(cur.doneAt ?? {}), [stepId]: Date.now() },
        verify: Object.keys(verify).length > 0 ? verify : undefined,
      }
    })
    refreshProjectInfo(projectId)
  }

  /** 保存某步技能/说明覆盖：写当前项目 + 写回模板（后续用该模板新建的项目即为最新配置） */
  const setFlowStepOverride = (projectId: string, stepId: string, o: FlowStepOverride) => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    if (tmpl) saveTemplateStepOverride(tmpl.id, stepId, o)
    patchFlowRun(projectId, (cur) => {
      const prev = cur.overrides?.[stepId] ?? {}
      const next: FlowStepOverride = { ...prev }
      if (o.skill !== undefined) next.skill = o.skill
      if (o.instruction !== undefined) next.instruction = o.instruction
      // 收敛参数（迭代次数/达标分/平台期）：逐字段合并，未给的字段沿用旧值
      if (o.converge !== undefined) next.converge = { ...(prev.converge ?? {}), ...o.converge }
      return { ...cur, overrides: { ...(cur.overrides ?? {}), [stepId]: next } }
    })
  }

  /** 初稿诊断定位：初稿放项目根目录后，把体检任务发入项目根会话（绑定会话，无则建），产出 _诊断报告.md */
  const startDiagnosisFlow = async (projectId: string): Promise<string> => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    const folder = pr.folders[projectId] ?? ''
    if (!run || !tmpl) return '⚠️ 该项目不是有效的模板项目。'
    if (!folder) return '⚠️ 该项目未设置文件夹。'
    let sid = pr.bindings[projectId]
    let created = false
    if (!sid) {
      sid = (await createSessionAtFolder(folder)) ?? undefined
      created = !!sid
    }
    if (!sid) return '⚠️ 无法创建诊断会话（宿主不可用）。'
    if (created) {
      persistProjects((prev) => ({ ...prev, bindings: { ...(prev.bindings ?? {}), [projectId]: sid } }))
    }
    try {
      const layout = pr.layouts.find((l) => l.id === projectId)
      const text = composeDiagnosisTask({
        projectName: pr.nameOverrides[projectId] ?? layout?.title ?? projectId,
        folder,
        steps: tmpl.steps.map((s) => ({ id: s.id, title: `${s.icon} ${s.title}`, dir: s.dir, deliverable: s.deliverable, blockTitles: s.blocks?.map((b) => b.title) ?? [] })),
        currentStart: (run.startIndex ?? 0) + 1,
      })
      await ensureSessionPreset(sid)
      await ensureSessionModel(sid)
      await promptIntoSession(sid, text)
    } catch (e) {
      return '⚠️ 诊断任务发送失败：' + String(e)
    }
    markPluginSessionOpen(sid)
    openSessionInHost(sid)
    return '✅ 诊断已开工：请确保初稿文件（md/docx/pdf/tex）已在项目根目录（或 _初稿/ 子目录）。AI 正在通读并对 10 步逐项体检，产出《_诊断报告.md》与建议起始步；完成后点「📌 应用诊断起始步」一键切入。'
  }

  /** 手动指定起始步（与诊断定位等效的人工入口）：把 startIndex 设到该步，其前步骤标记为跳过。
   *  该步及之后步骤的旧验收状态清零（跳步后重跑）；已通过的步骤若在目标步之前则保留绿标。 */
  const setFlowStartStep = (projectId: string, stepId: string): Promise<string> => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    if (!run || !tmpl) return Promise.resolve('⚠️ 该项目不是有效的模板项目。')
    const idx = tmpl.steps.findIndex((s) => s.id === stepId)
    if (idx < 0) return Promise.resolve('⚠️ 找不到该步骤。')
    if ((run.startIndex ?? 0) === idx) return Promise.resolve('ℹ️ 该步骤已是起始步，直接点「▶ 开始此步」即可。')
    const stepTitle = tmpl.steps[idx].title
    patchFlowRun(projectId, (cur) => {
      const verify = { ...(cur.verify ?? {}) }
      for (let i = idx; i < tmpl.steps.length; i++) delete verify[tmpl.steps[i].id]
      return { ...cur, startIndex: idx, verify: Object.keys(verify).length > 0 ? verify : undefined }
    })
    refreshProjectInfo(projectId)
    return Promise.resolve(`✅ 已指定起始步 = 第 ${idx + 1} 步「${stepTitle}」：其前 ${idx} 步标记为跳过（不影响任何文件）。点「▶ 开始此步」即从该步进入自动验收环；前置步骤的交付物盘点会自动写进本步要求。`)
  }

  /** 起始步之前各步的交付物盘点（跳步开工时让 AI 掌握缺什么）：扫描每步目录的「下划线交付下划线」「下划线完成下划线」标记文件与产物文件数 */
  const buildPriorStepsBackfill = async (folder: string, tmpl: TemplateDef, idx: number): Promise<string> => {
    if (idx <= 0) return ''
    const lines: string[] = []
    for (let i = 0; i < idx; i++) {
      const st = tmpl.steps[i]
      const dir = joinPath(folder, st.dir)
      let entries: any[] = []
      try {
        const r = await fetch('/api/worktable/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }) })
        const d = await r.json().catch(() => null)
        if (Array.isArray(d?.entries)) entries = d.entries.filter((e: any) => e && typeof e.name === 'string')
      } catch { /* 目录不存在等：按无产出处理 */ }
      if (entries.length === 0) {
        lines.push(`- 第 ${i + 1} 步「${st.title}」：目录未创建或无文件（视为该步无产出）`)
        continue
      }
      const markers = entries.filter((e: any) => !e.isDir && /^_(交付|完成)_/.test(e.name)).map((e: any) => e.name)
      const files = entries.filter((e: any) => !e.isDir && !e.name.startsWith('_')).length
      lines.push(`- 第 ${i + 1} 步「${st.title}」：交付标记 ${markers.length > 0 ? markers.join('、') : '无'}；产物文件 ${files} 个`)
    }
    return ['', '═══ 前置步骤交付物盘点（本步之前各步的实际产出；被跳过 ≠ 有产出，缺失的需在本步补齐或从项目根初稿引用）═══', ...lines, ''].join('\n')
  }

  /** 应用诊断结果：解析 _诊断报告.md 末尾的 DIAG_START_STEP: N，把起始步设为第 N 步（其前步骤跳过） */
  const applyDiagnosisResult = async (projectId: string): Promise<string> => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    const folder = pr.folders[projectId] ?? ''
    if (!run || !tmpl) return '⚠️ 该项目不是有效的模板项目。'
    const report = await wtReadText(`${folder}/_诊断报告.md`)
    if (!report) return '⚠️ 未找到《_诊断报告.md》：请先点「🩺 初稿诊断定位」跑完诊断。'
    const m = /DIAG_START_STEP\s*[:：]\s*(\d+)/.exec(report)
    if (!m) return '⚠️ 报告里没有 DIAG_START_STEP 行：诊断可能未完成，请在诊断会话里确认。'
    const n = Math.min(Math.max(Number(m[1]) || 1, 1), tmpl.steps.length)
    const stepTitle = tmpl.steps[n - 1].title
    patchFlowRun(projectId, (cur) => {
      // 起始步后退时清理其后的验收状态（旧进度失效）
      const verify = { ...(cur.verify ?? {}) }
      for (const s of tmpl.steps) {
        const i = tmpl.steps.indexOf(s)
        if (i >= n - 1) delete verify[s.id]
      }
      return { ...cur, startIndex: n - 1, verify: Object.keys(verify).length > 0 ? verify : undefined }
    })
    refreshProjectInfo(projectId)
    return `✅ 已应用诊断结果：起始步 = 第 ${n} 步「${stepTitle}」，其前步骤跳过。点「▶ 开始此步」即从该步进入自动验收环。`
  }

  /** 打开当前步最新验收报告所在文件夹（并提示文件名） */
  const openLatestVerifyReport = async (projectId: string, stepId: string): Promise<string> => {
    const pr = projectsRef.current.projects
    const run = pr.flows?.[projectId]
    const tmpl = run ? templateById(run.templateId) : undefined
    const folder = pr.folders[projectId] ?? ''
    const step = tmpl?.steps.find((s) => s.id === stepId)
    if (!step || !folder) return '⚠️ 找不到该步骤或项目未设置文件夹。'
    const stepDir = `${folder}/${step.dir}`
    try {
      const r = await fetch('/api/worktable/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: stepDir }) })
      const d = await r.json().catch(() => null)
      const names: string[] = (Array.isArray(d?.entries) ? d.entries : [])
        .filter((e: any) => e && !e.isDir && typeof e.name === 'string' && e.name.startsWith(REPORT_PREFIX))
        .map((e: any) => e.name)
        .sort((a: string, b: string) => {
          const ra = Number(/_R(\d+)\.md$/.exec(a)?.[1] ?? 0)
          const rb = Number(/_R(\d+)\.md$/.exec(b)?.[1] ?? 0)
          return ra - rb
        })
      if (names.length === 0) return 'ℹ️ 该步骤还没有验收报告（验收员完成第一轮后生成）。'
      const latest = names[names.length - 1]
      await fetch('/api/worktable/open-folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: stepDir }) })
      return `📋 最新验收报告：${latest}（已打开所在文件夹；R 数字越大轮次越新）`
    } catch (e) {
      return '⚠️ 打开失败：' + String(e)
    }
  }

  /** 验收环调度器实例（供面板「⏯ 继续本步」/暂停方案卡直接调用） */
  const verifySchedulerRef = useRef<VerifyScheduler | null>(null)

  /** 验收环调度器（2.0 核心）：串行驱动 工人→验收员 循环；本地单槽位模型下无死锁。
   *  随快照更新即时 tick + 3s 兜底轮询；状态持久化在 FlowRunState.verify，刷新页面自动恢复。 */
  useEffect(() => {
    const scheduler = new VerifyScheduler({
      listFlowProjects: () => {
        try { return Object.keys(projectsRef.current.projects.flows ?? {}) } catch { return [] }
      },
      getRun: (pid) => projectsRef.current.projects.flows?.[pid],
      getTemplate: (run) => templateById(run.templateId),
      getFolder: (pid) => projectsRef.current.projects.folders[pid] ?? '',
      getProjectName: (pid) => {
        const pr = projectsRef.current.projects
        const layout = pr.layouts.find((l) => l.id === pid)
        return pr.nameOverrides[pid] ?? layout?.title ?? pid
      },
      getWorkerSid: (run, stepId) => run.stepSessions?.[stepId],
      patchVerify: (pid, stepId, patch) => {
        patchFlowRun(pid, (cur) => {
          const v = { ...(cur.verify ?? {}) }
          const nv = patch(v[stepId])
          if (nv === undefined) delete v[stepId]
          else v[stepId] = nv
          return { ...cur, verify: Object.keys(v).length > 0 ? v : undefined }
        })
      },
      isRunning: (sid) => sessionRunningNow(sid, sessionsSnapshotStore.snapshot?.byId ?? {}, collectKids),
      sendToSession: async (sid, text) => {
        try {
          await ensureSessionPreset(sid)
          await ensureSessionModel(sid)
          await promptIntoSession(sid, text)
          return true
        } catch (e) {
          try { console.warn('[worktable] sendToSession failed:', sid, e) } catch {}
          return false
        }
      },
      /** 中断指定会话的当前运行轮（宿主会话面 cancel；会话不存在/未在跑返回 false） */
      cancelSession: async (sid) => {
        try {
          const sess = sessionBridge?.sessions?.binding?.(sid)?.session
          if (!sess || typeof sess.cancel !== 'function') return false
          const r = await sess.cancel()
          return !!(r && (r as any).ok)
        } catch { return false }
      },
      /** 步骤标签「NN 步名」（会话标题用；同一 stepId 在所有模板中标签一致） */
      getStepLabel: (stepId) => {
        for (const t of BUILTIN_TEMPLATES) {
          const i = t.steps.findIndex((s) => s.id === stepId)
          if (i >= 0) return `${String(i + 1).padStart(2, '0')} ${t.steps[i].title}`
        }
        return stepId
      },
      createVerifierSession: async (stepDir, title) => {
        const b = sessionBridge
        if (!b || typeof b.sessions?.create !== 'function') return null
        try {
          // 验收员会话故意不注册工作区（临时会话，不进工作区面板），标题按规范设置
          const sid = await b.sessions.create({ cwd: stepDir })
          if (!sid) return null
          retainSessionScope(sid) // 关键：不 retain 则 binding 恒 undefined，任务永远送不进去
          await ensureSessionPreset(sid)
          await ensureSessionModel(sid)
          void setSessionTitle(sid, title)
          return sid
        } catch { return null }
      },
      readFile: (abs) => wtReadText(abs),
      writeFile: (abs, content) => apiWrite(abs, content),
      /** 列目录（用于从磁盘验收报告校正累计轮次，防意外中止后轮次回退重跑） */
      listDir: async (abs) => {
        try {
          const r = await fetch('/api/worktable/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: abs }) })
          const d = await r.json().catch(() => null)
          return (Array.isArray(d?.entries) ? d.entries : [])
            .filter((e: any) => e && !e.isDir && typeof e.name === 'string')
            .map((e: any) => e.name as string)
        } catch { return [] }
      },
      /** 步骤目录最近文件活动（工人看门狗「随进度自动判断」 stalled 用：返回最新文件 mtime(ms)，取不到返回 0） */
      latestActivity: async (abs) => {
        try {
          const r = await fetch('/api/worktable/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: abs }) })
          const d = await r.json().catch(() => null)
          let m = 0
          for (const e of (Array.isArray(d?.entries) ? d.entries : [])) {
            if (e && !e.isDir && typeof e.mtimeMs === 'number' && e.mtimeMs > m) m = e.mtimeMs
          }
          return m
        } catch { return 0 }
      },
      notify: (pid, msg, kind) => {
        verifyNotifyStore.current = { projectId: pid, msg, kind, at: Date.now() }
        notifyFlow()
      },
      onStepPassed: (pid) => refreshProjectInfo(pid),
    })
    // 验收环：每个实例的调度器都订阅这条（tick 内部本来就有 single-flight + 60s 卡死自愈）
    const unsubSnap = sessionsSnapshotStore.listeners.add(() => { void scheduler.tick() })
    scheduler.start()
    verifySchedulerRef.current = scheduler
    return () => {
      scheduler.stop()
      sessionsSnapshotStore.listeners.delete(unsubSnap)
      if (verifySchedulerRef.current === scheduler) verifySchedulerRef.current = null
    }
  }, [])

  // ── 布局（新建工作区） ── 强制项目文件夹：经「选择位置…」/默认预填选定；路径即为项目文件夹。
  // 名称可选：未填写时默认 = 项目文件夹名（默认文件夹 = 当前时间戳，与文件夹名一致）
  const saveLayout = async () => {
    // 防连点：一次点击只建一个项目 + 一条项目对话（此前双击会建出两个同目录项目）
    if (savingLayoutRef.current) return
    const folderPath = wsFolderParent.trim()
    if (!folderPath) { setWsFolderError(true); return }
    if (!isAbs(folderPath)) { setWsFolderError(true); return }
    savingLayoutRef.current = true
    const name = wsName.trim() || defaultProjectName(folderPath)
    try {
      // 兜底建目录；HTTP 非 2xx 视为失败，不能继续保存（路径可能无效）
      const r = await fetch('/api/worktable/mkdir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }) })
      if (!r.ok) {
        setWsFolderError(true); setPickErr((prev) => ({ ...prev, add: t('add.folderCreateFail') }))
        savingLayoutRef.current = false
        return
      }
    } catch {
      setWsFolderError(true); setPickErr((prev) => ({ ...prev, add: t('add.folderCreateFail') }))
      savingLayoutRef.current = false
      return
    }
    const tmpl = wsTemplate ? templateById(wsTemplate) : null
    // 模板项目：流程面板必须可见——默认预设「会话全屏」不含可见内容窗，改走「全屏内容窗」形态
    const layout = buildLayout(tmpl && wsPreset === DEFAULT_PRESET_ID ? 'full' : wsPreset, name)
    // 新项目图标：从内置集合里随机取一个「现有项目还没用过」的（不同项目尽量不撞），
    // 并写进 iconOverrides（随控制室存档同步到手机端）。模板项目不再统一用 📃 之类的模板图标
    // ——那正是「每新建一个项目图标都长一样」的来源；模板身份由流程面板体现。
    const usedIcons = projects.layouts.map((l) => resolveProjectIcon(l.id, projects.iconOverrides[l.id], metas[l.id]?.icon, l.icon))
    layout.icon = pickUnusedIcon(usedIcons)
    if (tmpl) {
      // 模板实例：主内容窗（窗口1）预置为「流程」窗格（content.url = 项目 id）
      if (layout.main.length > 0) layout.main[0].content = { kind: 'builtin', type: 'flow', url: layout.id }
      // L2 项目叠加层：写作语言 → 项目根 _项目验收叠加.md（工人与验收员必读）
      // 迭代收敛模板不适用论文专属叠加层（任务与标准写在面板「📝 任务定义」→ 项目全局信息），故跳过不写。
      if (!tmpl.steps.some((s) => isConvergeStep(s))) {
        const overlayText = [
          '# 项目验收叠加层（L2）',
          '',
          '> 建项目时配置；本步及后续所有步骤的工人与验收员必须遵守。冲突时优先级：本文件 > 个人写作基准 > 02-十步验收标准。',
          `- 写作语言：${wsLang}`,
          '',
          '## 本项目的特殊验收要求',
          '',
          '（可手工增删，例如期刊的摘要词数上限、图表尺寸、引用格式等硬性要求）',
          '',
        ].join('\n')
        try { await apiWrite(`${folderPath}/${OVERLAY_FILE}`, overlayText) } catch { /* 叠加层写入失败不阻断建项目 */ }
      }
    }
    persistProjects((prev) => ({
      ...prev,
      layouts: [...prev.layouts, layout],
      folders: { ...prev.folders, [layout.id]: folderPath },
      // 随机图标一并落到 iconOverrides：老代码路径/选择器都以它为「显式设置」，且它随存档同步
      iconOverrides: { ...prev.iconOverrides, [layout.id]: layout.icon as string },
      ...(tmpl ? { flows: { ...(prev.flows ?? {}), [layout.id]: freshFlowRun(tmpl.id, wsStartStep) } } : {}),
    }))
    invalidatePickState() // 保存成功：失效在途选择请求（防止旧选择器稍后返回写回已重置的表单）
    setWsName(''); setWsFolderParent(''); setWsFolderError(false); setWsTemplate(''); setWsStartStep(0)
    setWsPreset(DEFAULT_PRESET_ID)
    setWsLang(PAPER_LANG_OPTIONS[0])
    setAddOpen(false)
    // 新建即自动进入「项目对话」：空白会话 + 工作目录 = 刚选择的项目文件夹（模板项目同样适用；
    // 之后在流程里点「开始此步」才会另建步骤子目录会话）
    const sid = await createBoundSession(layout.id, folderPath)
    savingLayoutRef.current = false
    openSplit(layout)
    if (sid) {
      markPluginSessionOpen(sid)
      openSessionInHost(sid)
    }
    reportUsed(layout.id)
    // 模板项目：先生成初始「项目全局信息」md（步骤会话按进度在各步子目录创建）
    if (tmpl) {
      window.setTimeout(() => { try { refreshProjectInfo(layout.id) } catch {} }, 900)
    }
  }

  const removeLayout = (id: string) => {
    persistProjects((prev) => {
      const flows = { ...(prev.flows ?? {}) }
      if (flows[id]) delete flows[id]
      const next: ProjectsState = {
        ...prev,
        layouts: prev.layouts.filter((l) => l.id !== id),
        // 墓碑 + 清排序/隐藏：删掉的项目在另一端、在旧缓存里都不能再冒出来
        removed: prev.removed.includes(id) ? prev.removed : [...prev.removed, id],
        order: prev.order.filter((x) => x !== id),
        hidden: prev.hidden.filter((x) => x !== id),
      }
      if (Object.keys(flows).length === 0) { if (next.flows) delete next.flows } else next.flows = flows
      if (next.folders[id]) { next.folders = { ...next.folders }; delete next.folders[id] }
      if (next.bindings[id]) { next.bindings = { ...next.bindings }; delete next.bindings[id] }
      if (next.briefs?.[id]) { next.briefs = { ...next.briefs }; delete next.briefs[id] }
      return next
    })
  }

  // ── 变更视图：所有项目通用。布局项目 = 重建其布局条目；入驻项目 = 建立/更新视图覆盖。
  // 现有窗内容（标签）按序迁入新拓扑，不丢失。 ──
  const applyLayoutChange = (id: string, presetId: string) => {
    const layout = projects.layouts.find((l) => l.id === id)
    const meta = metas[id]
    const current = layout ?? projects.views[id]
    const sources = current
      ? [...(current.top ?? []), ...current.main]
          .map((pp) => (pp.tabs ?? []).filter((tb) => !(tb.content?.kind === 'builtin' && tb.content.type === 'flow')))
          .filter((tabs) => tabs.length > 0)
      : []
    const next = buildLayout(presetId, layout ? layout.title : (meta?.name ?? id))
    next.id = id
    next.icon = layout ? layout.icon : (projects.iconOverrides[id] ?? meta?.icon)
    const targets = [...(next.left ? [next.left] : []), ...(next.top ?? []), ...next.main]
    let si = 0
    for (const pane of targets) {
      if (si < sources.length) {
        pane.tabs = sources[si]
        pane.active = 0
        pane.content = null
        si++
      }
    }
    const overflow = sources.slice(si).flat()
    if (overflow.length > 0 && targets.length > 0) {
      const last = targets[targets.length - 1]
      last.tabs = [...(last.tabs ?? []), ...overflow]
      last.active = 0
    }
    // 模板项目：流程窗格固定挂主内容第一窗（迁移已排除 flow 标签，这里强制置回）
    const flowRun = projects.flows?.[id]
    if (flowRun && next.main.length > 0) {
      const tmpl = templateById(flowRun.templateId)
      next.main[0].tabs = [{ id: 'flow-' + id, title: tmpl?.name ?? '流程', content: { kind: 'builtin', type: 'flow', url: id } }]
      next.main[0].active = 0
      next.main[0].content = null
    }
    persistProjects((prev) => layout
      ? { ...prev, layouts: prev.layouts.map((l) => (l.id === id ? next : l)) }
      : { ...prev, views: { ...prev.views, [id]: next } })
    // 该视图当前打开时：关旧开新，工作区即时变为新视图
    const wasOpen = splitStore.active && splitStore.spec?.id === id
    if (wasOpen) {
      splitStore.close()
      openSplit(next)
    }
    setViewPickFor(null)
  }

  /** 布局当前拓扑对应的预设 id（用于视图选择器高亮） */
  const presetOf = (l: LayoutSpec): string => {
    const leftCount = l.left ? 1 : 0
    const topCount = (l.top ?? []).length
    const contentCount = l.main.length
    const chatFull = l.chatFullHeight === true
    const chatHidden = l.chatHidden === true
    const chatOnly = l.chatOnly === true
    const def = PRESET_DEFS.find((d) =>
      d.leftCount === leftCount && d.topCount === topCount && d.contentCount === contentCount
      && d.chatFull === chatFull && ((d as any).chatHidden === true) === chatHidden
      && ((d as any).chatOnly === true) === chatOnly,
    )
    return def ? def.id : '2h'
  }

  // ── 删除（全部走二次确认；项目彻底移出工作台：对话与项目文件均保留，仅清理本地关联状态） ──
  // 「工作台」控制室项目不可删除（界面不提供入口，这里兜底拒绝）
  const removeProject = (id: string) => {
    if (id === CONSOLE_ID) return
    persistProjects((prev) => {
      const next = {
        ...prev,
        removed: prev.removed.includes(id) ? prev.removed : [...prev.removed, id],
        // 布局条目也一起清掉：只记墓碑不删 layouts 的话，控制室/项目管理里照样会把这一条列出来
        layouts: prev.layouts.filter((l) => l.id !== id),
        hidden: prev.hidden.filter((x) => x !== id),
        order: prev.order.filter((x) => x !== id),
      }
      if (next.bindings[id]) { next.bindings = { ...next.bindings }; delete next.bindings[id] }
      if (next.folders[id]) { next.folders = { ...next.folders }; delete next.folders[id] }
      if (next.views[id]) { next.views = { ...next.views }; delete next.views[id] }
      if (next.briefs?.[id]) { next.briefs = { ...next.briefs }; delete next.briefs[id] }
      return next
    })
  }
  const askDelete = (kind: 'layout' | 'shortcut' | 'project', id: string, name: string) => {
    setRequestDelete({ kind, id, name })
  }
  const doDelete = () => {
    const r = requestDelete
    if (!r) return
    if (r.kind === 'layout') removeLayout(r.id)
    else if (r.kind === 'shortcut') removeShortcut(r.id)
    else removeProject(r.id)
    setRequestDelete(null)
  }

  // ── 图标选择器（布局 / 快捷方式 / 项目的「更换图标」按钮） ──
  // anchor：DOM 锚点元素（按钮 / 事件 currentTarget）
  // 位置按视口钳制：手机窄屏（320-430px）下弹窗不会被顶出屏幕。
  // below = 贴在锚点**下方**并右对齐（项目管理行用：选择器不压住同一行的操作按钮）。
  const openIconPick = (kind: 'layout' | 'shortcut' | 'project', id: string, anchor: HTMLElement, opts: { below?: boolean } = {}) => {
    const r = anchor.getBoundingClientRect()
    const vw = Math.max(1, window.innerWidth)
    const vh = Math.max(1, window.innerHeight)
    const w = Math.min(268, Math.max(180, vw - 24))
    const h = Math.min(360, Math.max(200, vh - 24))
    let x: number
    let y: number
    if (opts.below) {
      x = Math.min(Math.max(12, r.right - w), Math.max(12, vw - w - 12))
      y = r.bottom + 6
      if (y + h > vh - 12) y = Math.max(12, r.top - h - 6)
    } else {
      x = r.right + 8
      if (x + w > vw - 12) x = r.left - w - 8
      if (x < 12) x = Math.max(12, Math.min(vw - w - 12, r.left + r.width / 2 - w / 2))
      y = r.top - 4
      if (y + h > vh - 12) y = vh - h - 12
      if (y < 12) y = 12
    }
    setIconPick({ kind, id, x: Math.round(x), y: Math.round(y) })
  }
  const setLayoutIcon = (id: string, icon: string) => {
    persistProjects((prev) => ({
      ...prev,
      layouts: prev.layouts.map((l) => (l.id === id ? { ...l, icon } : l)),
    }))
  }
  const setShortcutIcon = (id: string, icon: string) => {
    persistProjects((prev) => ({
      ...prev,
      shortcuts: prev.shortcuts.map((s) => (s.id === id ? { ...s, icon } : s)),
    }))
  }
  const setProjectIcon = (id: string, icon: string) => {
    persistProjects((prev) => ({ ...prev, iconOverrides: { ...prev.iconOverrides, [id]: icon } }))
    // 立即通知控制室重渲染：项目管理面板那一行与卡片图标都读同一份 iconOverrides，
    // 不通知的话选完要等下一次 refresh 才变（跨端同步本来就跟着 persistProjects 走）
    notifyConsole()
  }

  // 绑定按钮 hover 气泡只服务可见的非 headless 侧栏卡片。
  // 生产 headless 不安装 document mouseover/mouseout/scroll/click 空监听。
  useEffect(() => {
    if (headless) return
    const over = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const btn = target && target.closest ? (target.closest('.dsh-wt_bindBtn') as HTMLElement | null) : null
      if (btn) showBindTip(btn)
    }
    const out = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest && target.closest('.dsh-wt_bindBtn')) hideBindTip()
    }
    const hide = () => hideBindTip()
    document.addEventListener('mouseover', over, true)
    document.addEventListener('mouseout', out, true)
    document.addEventListener('scroll', hide, true)
    document.addEventListener('click', hide, true)
    return () => {
      document.removeEventListener('mouseover', over, true)
      document.removeEventListener('mouseout', out, true)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('click', hide, true)
      if (bindTipEl) { bindTipEl.remove(); bindTipEl = null }
    }
  }, [headless])

  // ── 入驻项目卡片通用 DOM 桥（不写死任何项目名/类名） ──
  // 卡片按子座位注册顺序渲染，与 aliveRegisteredIds 一一对应：
  // 1) 位置映射：给每张卡片标 data-wt-id，图标覆盖写到卡片第一个子元素（通用结构约定）；
  // 2) 委托点击（捕获阶段）：卡片图标 → 图标选择器；有视图覆盖的项目 → 用引擎打开该视图。
  useEffect(() => {
    // 无头宿主只提供数据与弹窗，侧栏卡片被 CSS 隐藏；不监听聊天 DOM。
    if (headless) return
    const box = rootRef.current?.querySelector<HTMLElement>('.dsh-wt_projects') ?? null
    if (!box) return
    const sync = () => {
      // 提醒态从 ref 读最新值（原来这两个 map 在 effect deps 里：每次通知都拆掉观察器重挂 + 全量重扫，
      // 观察器是这张卡唯一的驱动源，拆建有「漏一帧」的风险，也多花一份全树扫描）
      const bindNotifyMap = notifyMapsRef.current.bind
      const needNowMap = notifyMapsRef.current.need
      // 子座位把所有卡片包在一个无类容器里：直接取卡片按钮（DOM 序 = 注册序），排除自渲染的布局卡
      const cards = Array.from(box.querySelectorAll<HTMLElement>('button:not(.dsh-wt_layout)'))
      cards.forEach((el, i) => {
        const id = aliveRegisteredIds[i]
        if (id) {
          el.setAttribute('data-wt-id', id)
          // 工作中发光（行级 busy 视觉；与圆点 busy 一致，随快照事件即时更新）
          el.setAttribute('data-wt-busy', bindNotifyMap[id] === 'busy' ? 'true' : 'false')
          // 待决策（黄色警示）：绑定/关联会话停在「询问用户决策」就点亮，不受 ack 影响（ack 只熄光晕）
          el.setAttribute('data-wt-need', needNowMap[id] ? 'true' : 'false')
          // 对话绑定按钮：追加为最后一个子元素（不破坏 children[0] 图标约定），中间偏右
          let bindBtn = el.querySelector<HTMLElement>('.dsh-wt_bindBtn')
          if (!bindBtn) {
            bindBtn = document.createElement('span')
            bindBtn.className = 'dsh-wt_bindBtn'
            bindBtn.setAttribute('role', 'button')
            const circles = document.createElement('span')
            circles.className = 'dsh-wt_bindCircles'
            circles.setAttribute('aria-hidden', 'true')
            bindBtn.appendChild(circles)
            el.appendChild(bindBtn)
            const cs = getComputedStyle(el)
            if (cs.position === 'static') el.style.position = 'relative'
          }
          bindBtn.setAttribute('data-wt-bind', id)
          const bound = projects.bindings[id]
          // 圆点颜色跟状态真值：待决策 → 黄（含已 ack 但尚未答复的情形，避免退回 busy 蓝）
          bindBtn.setAttribute('data-bound', needNowMap[id] ? 'need' : (bindNotifyMap[id] ?? (bound ? 'true' : 'false')))
          // 入驻卡自带箭头（文本 ›）：加统一对齐类，视觉居中（字面框偏下补偿 1px）
          const kids = Array.from(el.children)
          const arrow = kids.find((k: any) => k.tagName === 'SPAN' && String((k as HTMLElement).textContent ?? '').trim() === '›')
          if (arrow) (arrow as HTMLElement).classList.add('dsh-wt_resArrow')
          // 「待决策」文字标签：插入到箭头前（右端、圆点内侧），状态离开自动移除
          let needTag = el.querySelector<HTMLElement>('.dsh-wt_needTag')
          if (needNowMap[id]) {
            if (!needTag) {
              needTag = document.createElement('span')
              needTag.className = 'dsh-wt_needTag'
              needTag.textContent = '待决策'
            }
            if (needTag.parentElement !== el) el.insertBefore(needTag, ((arrow as HTMLElement | null) ?? bindBtn) as Node)
          } else if (needTag) {
            needTag.remove()
          }
          const tip = (bound
            ? t('bind.tipBound', { name: boundSessionTitle(bound) })
            : t('bind.tipUnbound')) + (needNowMap[id] ? t('bind.tipNeed') : bindNotifyMap[id] === 'busy' ? t('bind.tipBusy') : bindNotifyMap[id] === 'done' ? t('bind.tipDone') : bindNotifyMap[id] === 'need' ? t('bind.tipNeed') : '')
          bindBtn.setAttribute('data-tip', tip)
          bindBtn.setAttribute('aria-label', tip)
          const icon = el.children[0] as HTMLElement | null
          if (icon) {
            const ovr = projects.iconOverrides[id]
            if (ovr) icon.setAttribute('data-wt-icon', ovr)
            else icon.removeAttribute('data-wt-icon')
          }
          // 选中态统一由工作台判定：
          // - 有视图覆盖的项目：点击恒由工作台接管 → 高亮完全跟随 activeSplitId（关闭即熄灭）；
          // - 无视图覆盖：引擎打开时点亮；引擎开着别的时熄灭；引擎空闲时保留卡片自带状态
          //   （兼容自带分栏实现的插件）。
          if (projects.views[id]) {
            el.setAttribute('data-on', activeSplitId === id ? 'true' : 'false')
          } else if (activeSplitId === id) {
            el.setAttribute('data-on', 'true')
          } else if (activeSplitId != null) {
            el.setAttribute('data-on', 'false')
          }
        } else {
          el.removeAttribute('data-wt-id')
          el.removeAttribute('data-wt-busy')
          el.removeAttribute('data-wt-need')
          el.querySelectorAll<HTMLElement>('.dsh-wt_needTag').forEach((tag) => tag.remove())
        }
      })
    }
    sync()
    // 只观察项目容器；聊天流式更新不再触发整页 childList 回调与卡片扫描。
    const mo = new MutationObserver(sync)
    mo.observe(box, { childList: true, subtree: true })
    // 状态灯 / 待决策标签变了就跟着控制室那一趟走：同一帧只排一次，观察器不再每轮拆建
    let bridgeFrame: number | null = null
    const onInvalidate = () => {
      if (bridgeFrame != null) return
      bridgeFrame = window.requestAnimationFrame(() => { bridgeFrame = null; sync() })
    }
    consoleListeners.add(onInvalidate)
    return () => {
      consoleListeners.delete(onInvalidate)
      if (bridgeFrame != null) { window.cancelAnimationFrame(bridgeFrame); bridgeFrame = null }
      mo.disconnect()
    }
  }, [headless, wide, aliveRegisteredIds, projects.iconOverrides, projects.views, activeSplitId, projects.bindings])

  useEffect(() => {
    if (headless) return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const card = target && target.closest
        ? (target.closest('.dsh-wt_projects [data-wt-id]') as HTMLElement | null)
        : null
      if (!card) return
      const pid = card.getAttribute('data-wt-id')
      if (!pid) return
      // 绑定按钮点击 → 打开对话绑定弹窗（阻止卡片自身打开项目）
      const bindBtn = (target && target.closest ? target.closest('.dsh-wt_bindBtn') : null) as HTMLElement | null
      if (bindBtn) {
        e.stopPropagation()
        e.preventDefault()
        openBindPick(pid, bindBtn)
        return
      }
      // 图标不再是按钮（换图标统一走「控制室 → 项目管理 → 更换图标」）：
      // 点图标不再拦事件，按普通卡片点击处理（打开项目/切绑定会话）。
      // 有视图覆盖 → 用引擎打开该视图（替换卡片自带行为）
      const view = projects.views[pid]
      if (view) {
        e.stopPropagation()
        e.preventDefault()
        openSplit(view)
        reportUsed(pid)
        return
      }
      // 无视图覆盖：项目自带打开行为照旧，仅当绑定了会话时切换右侧对话窗
      const bound = projectsRef.current.projects.bindings[pid]
      if (bound) openSessionInHost(bound)
      ackProjectNotify(pid)
    }
    document.addEventListener('click', onDocClick, true)
    return () => document.removeEventListener('click', onDocClick, true)
  }, [headless, projects.views, openSplit, reportUsed, openBindPick])

  const query = view.query.trim()
  const queryLower = query.toLowerCase()
  const visibleShortcuts = projects.shortcuts.filter((s) =>
    !queryLower || (s.name + ' ' + s.href).toLowerCase().includes(queryLower),
  )
  const visibleLayouts = projects.layouts.filter((l) => {
    if (projects.hidden.includes(l.id)) return false
    if (!queryLower) return true
    const paneTitles = [...(l.top ?? []), ...l.main].map((p) => p.title).join(' ')
    return (l.title + ' ' + paneTitles).toLowerCase().includes(queryLower)
  })

  const isFloat = float != null
  const floatStyle = isFloat
    ? {
        position: 'fixed' as const,
        top: float.top,
        left: floatGeo?.left ?? 14,
        ...(floatGeo?.width != null ? { width: floatGeo.width } : {}),
        zIndex: 70,
      }
    : undefined

  useEffect(() => { bottomInsetRef.current = bottomInset }, [bottomInset])
  useEffect(() => { floatRef.current = float }, [float])

  // ── 底部悬浮面板避让 ──
  // 停靠态下检测「侧边栏列内、贴近底部、且与区块自然位置重叠」的 fixed 面板
  // （如 dsh-usage 的余额 dock），把区块整体抬到面板上方，双方互不遮挡、都可调整位置。
  // 判定公式原样搬进 bottomOverlay.ts.measureOverlap（几何 → fixed → 可见 → 落点 → 重叠 → 上限），
  // 区别只在跑法：一次量完整页 → 每帧量 400 个（主线程不再有几十毫秒的长任务）；
  // 稳定态退到低频兜底、有 style 变更（面板被拖动）立刻补扫、隐藏页不扫。
  const overlayScannerRef = useRef<ReturnType<typeof createBottomOverlayScanner> | null>(null)
  useEffect(() => {
    if (headless) return
    const scanner = createBottomOverlayScanner({
      candidates: () => document.querySelectorAll<HTMLElement>('body *'),
      root: () => rootRef.current,
      inset: () => bottomInsetRef.current,
      applyInset: (needed) => setBottomInset((prev) => (shouldApplyInset(prev, needed) ? needed : prev)),
      blocked: () => domGate.isPaused(),
      floating: () => floatRef.current != null,
    })
    overlayScannerRef.current = scanner
    scanner.kick()
    return () => { overlayScannerRef.current = null; scanner.dispose() }
  }, [headless])

  // 停靠/折叠变化时立即重测（悬浮态不避让，与原实现一致）
  useEffect(() => {
    if (headless) return
    const scanner = overlayScannerRef.current
    if (scanner && !isFloat) scanner.kick()
  }, [headless, isFloat, wide])

  const dockedStyle = !isFloat && bottomInset > 0 ? { marginBottom: bottomInset } : undefined

  // + 弹窗：向右弹出、锚定 sidebar 右边缘与工作台区块顶部（视口内钳制）
  const sectionTop = headless ? 0 : (rootRef.current?.getBoundingClientRect().top ?? 100)
  const popLeft = sidebarRight != null
    ? Math.min(sidebarRight + 8, Math.max(16, window.innerWidth - 344))
    : 16
  const popTop = clamp(sectionTop, MIN_TOP, Math.max(MIN_TOP, window.innerHeight - 540))

  // 设置弹窗底部防溢出：弹窗底与视口底保持 POP_BOTTOM_MARGIN；触底后以底为基准向上生长
  const POP_BOTTOM_MARGIN = 12
  const settingsRef = useRef<HTMLDivElement | null>(null)
  const [settingsTop, setSettingsTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const recalc = () => {
      if (!viewOptionsOpen || !settingsRef.current) return
      const h = settingsRef.current.offsetHeight
      const rawTop = Math.max(MIN_TOP, sectionTop)
      const maxTop = Math.max(MIN_TOP, window.innerHeight - h - POP_BOTTOM_MARGIN)
      setSettingsTop(Math.min(rawTop, maxTop))
    }
    recalc()
    window.addEventListener('resize', recalc)
    return () => window.removeEventListener('resize', recalc)
  }, [viewOptionsOpen, updateInfo, sectionTop])

  /** 收起态点击项目图标：视图覆盖/布局 → openSplit；模板流程项目（缺 layout）也进 openSplit 切最新步骤会话 */
  const openRailProject = (id: string) => {
    const pr = projectsRef.current.projects
    const layout = pr.layouts.find((l) => l.id === id)
    const view = pr.views[id]
    if (view || layout) openSplit((view ?? layout) as LayoutSpec)
    else if (pr.flows?.[id]) {
      openSplit({ id, title: (pr.nameOverrides[id] ?? id), icon: pr.metas?.[id]?.icon ?? '🧱', top: null, main: [], chatWidth: { default: 340, min: 280, max: 600 } } as LayoutSpec)
    } else {
      const bound = pr.bindings[id]
      if (bound) openSessionInHost(bound)
    }
  }

  if (!wide) {
    // 收起态 = 等行高的正方形圆角按钮，中间只留 emoji；点击 = 进入对应项目
    const railItems: { icon: string; name: string; onClick: (e: any) => void; pid?: string }[] = [
      { icon: CONSOLE_ICON, name: t('console.name'), onClick: (e) => clickConsoleCard(e.currentTarget as HTMLElement), pid: CONSOLE_ID },
      ...aliveRegisteredIds.map((id) => ({
        icon: projects.iconOverrides[id] ?? metas[id]?.icon ?? '📦',
        name: projects.nameOverrides[id] ?? metas[id]?.name ?? id,
        onClick: () => openRailProject(id),
        pid: id,
      })),
      ...projects.shortcuts.map((s) => ({
        icon: s.icon,
        name: s.name,
        onClick: () => { try { window.open(s.href, '_blank', 'noopener') } catch {} },
      })),
      ...projects.layouts.map((l) => ({
        icon: l.icon ?? '🧱',
        name: projects.nameOverrides[l.id] ?? l.title,
        onClick: () => openSplit(l),
        pid: l.id,
      })),
    ]
    // 浮动态：fixed 定位到拖前高度（左/宽取折叠列实测几何）；停靠态：文档流原位
    const railStyle = isFloat && railRect
      ? { position: 'fixed' as const, top: float.top, left: railRect.left, width: railRect.width, zIndex: 70 }
      : bottomInset > 0 ? { marginBottom: bottomInset } : undefined
    return (
      <div ref={rootRef} className="dsh-wt_section dsh-wt_rail" style={railStyle} data-headless={headless ? 'true' : undefined}>
        <div className="dsh-wt_divider" />
        <div className="dsh-wt_railBox">
          {railItems.length > 0
            ? railItems.map((it, i) => (
                <button key={i} type="button"
                  className={'dsh-wt_railBtn'
                    + (it.pid && needNowMap[it.pid] ? ' dsh-wt_railBtnNeed'
                      : it.pid && bindNotifyMap[it.pid] === 'busy' ? ' dsh-wt_railBtnBusy' : '')}
                  title={it.name + (it.pid && needNowMap[it.pid] ? ' · 待决策' : '')}
                  aria-label={it.name + (it.pid && needNowMap[it.pid] ? ' · 待决策' : '')}
                  onClick={it.onClick}>
                  <span aria-hidden>{it.icon}</span>
                </button>
              ))
            : <span className="dsh-wt_railIcon">≡</span>}
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className={'dsh-wt_section' + (isFloat ? ' dsh-wt_float' : '')} style={isFloat ? floatStyle : dockedStyle} data-headless={headless ? 'true' : undefined}>
      <div className="dsh-wt_divider" />
      <div className="dsh-wt_header">
        <button
          type="button"
          className="dsh-wt_handle"
          data-float={isFloat ? 'true' : 'false'}
          title={t('handle.title')}
          aria-label={t('handle.aria')}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          onDoubleClick={resetDock}
        >≡</button>
        <span
          className="dsh-wt_title"
          title={t('handle.title')}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          onDoubleClick={resetDock}
        >{t('title')}</span>
        {updateInfo && (
          <button
            type="button"
            className="dsh-wt_updateBadge"
            title={t('update.badgeTitle') + ' · v' + updateInfo.latest}
            aria-label={t('update.badgeTitle')}
            onClick={() => setViewOptionsOpen(true)}
          >{ICON_SYNC}</button>
        )}
        <div className="dsh-wt_actions">
          <button
            type="button"
            className="dsh-wt_iconBtn"
            aria-label={t('menu.search')}
            title={t('menu.search')}
            onClick={() => persistView({ searchOpen: !view.searchOpen, query: view.searchOpen ? '' : view.query })}
          >{ICON_SEARCH}</button>
          <button
            type="button"
            className="dsh-wt_iconBtn"
            aria-label={t('menu.viewOptions')}
            title={t('menu.viewOptions')}
            onClick={() => { invalidatePickState(); setViewOptionsOpen((v) => !v); setAddOpen(false) }}
          >{ICON_VIEW_OPTIONS}</button>
          <button
            type="button"
            className="dsh-wt_iconBtn"
            aria-label={t('menu.add')}
            title={t('menu.add')}
            onClick={() => {
              invalidatePickState()
              setAddOpen((v) => !v); setViewOptionsOpen(false)
              // 未选文件夹时默认 = 本机默认项目父目录下的当前时间戳子文件夹（仅空时预填）
              prefillDefaultFolder()
            }}
          >{ICON_ADD}</button>
        </div>
      </div>

      {view.searchOpen && (
        <div className="dsh-wt_search">
          <input
            autoFocus
            type="text"
            placeholder={t('search.placeholder')}
            value={view.query}
            onChange={(e) => persistView({ query: e.target.value })}
            onKeyDown={onSearchKeyDown}
          />
          <button type="button" className="dsh-wt_searchClear" aria-label={t('search.close')}
            onClick={() => persistView({ searchOpen: false, query: '' })}>✕</button>
        </div>
      )}

      {/* 选择项目文件夹：与「会话输入框 → 电脑文件」同一个 PathBrowser（跨盘 / 面包屑 / 桌面 / 当前目录确认） */}
      {browseOpen && (
        <ProjectFolderSheet
          startPath={browseStart}
          api={hostFolderFsApi()}
          t={orbText}
          onPick={(picked) => {
            const apply = browseApplyRef.current
            closeFolderBrowser()
            if (apply) apply(picked)
          }}
          onClose={closeFolderBrowser}
        />
      )}

      {addOpen && <div className="dsh-wt_popBackdrop" onClick={() => { invalidatePickState(); setAddOpen(false) }} />}
      {addOpen && (
        <div className="dsh-wt_menu dsh-wt_add dsh-wt_pop" style={headless
          ? { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 360, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 32px)', overflow: 'auto', zIndex: 80 }
          : { position: 'fixed', left: popLeft, top: popTop, width: 360, zIndex: 80 }}>
          <span className="dsh-wt_menuLabel">模板（可选）</span>
          <div className="dsh-wt_tmpls">
            <button type="button" className="dsh-wt_tmpl" data-on={wsTemplate === '' ? 'true' : 'false'}
              onClick={() => setWsTemplate('')} title="普通工作区：不套用固定流程">
              <span className="dsh-wt_tmplIcon" aria-hidden>🧱</span>
              <span className="dsh-wt_tmplName">空白</span>
            </button>
            {BUILTIN_TEMPLATES.map((tmpl) => (
              <button key={tmpl.id} type="button" className="dsh-wt_tmpl" data-on={wsTemplate === tmpl.id ? 'true' : 'false'}
                onClick={() => {
                  const on = wsTemplate !== tmpl.id
                  setWsTemplate(on ? tmpl.id : '')
                  if (on) setWsPreset(tmpl.layoutPreset)
                }}
                title={tmpl.description}>
                <span className="dsh-wt_tmplIcon" aria-hidden>{tmpl.icon}</span>
                <span className="dsh-wt_tmplName">{tmpl.name}</span>
              </button>
            ))}
          </div>
          {wsTemplate && templateById(wsTemplate) && (
            <div className="dsh-wt_tmplDesc">
              <span className="dsh-wt_tmplDescLine">📋 {templateById(wsTemplate)!.description}</span>
              {!wsSingleStep && (
                <span className="dsh-wt_tmplDescLine dsh-wt_tmplStartRow">
                  <label htmlFor="dsh-wt_wsStart">从第几步开始（前面步骤无需完成）：</label>
                  <select id="dsh-wt_wsStart" className="dsh-wt_tmplStartSel"
                    value={Math.min(wsStartStep + 1, wsTmplCur!.steps.length)}
                    onChange={(e) => setWsStartStep(Math.max(0, Number(e.target.value) - 1))}>
                    {wsTmplCur!.steps.map((s, i) => (
                      <option key={s.id} value={i + 1}>{i + 1}. {s.icon} {s.title}</option>
                    ))}
                  </select>
                </span>
              )}
              {!wsIsConverge && (
                <span className="dsh-wt_tmplDescLine dsh-wt_tmplStartRow" title="生成项目根 _项目验收叠加.md：验收员与工人必读（L2 层，优先级高于通用标准）">
                  <label htmlFor="dsh-wt_wsLang">写作语言：</label>
                  <select id="dsh-wt_wsLang" className="dsh-wt_tmplStartSel" value={wsLang} onChange={(e) => setWsLang(e.target.value)}>
                    {PAPER_LANG_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </span>
              )}
            </div>
          )}
          <span className="dsh-wt_menuLabel">{t('add.chooseLayout')}</span>
          <div className="dsh-wt_presets">
            {PRESET_DEFS.map((def) => (
              <button
                key={def.id}
                type="button"
                className="dsh-wt_preset"
                data-on={wsPreset === def.id ? 'true' : 'false'}
                title={def.id === 'chat' ? t('add.presetChat') : def.id === 'full' ? t('add.presetFull') : undefined}
                onClick={() => setWsPreset(def.id)}
              >
                {presetThumb(def.id)}
              </button>
            ))}
            <button type="button" className="dsh-wt_preset dsh-wt_presetAdd" title={t('customLayout.addTitle')}
              onClick={() => { invalidatePickState(); setAddOpen(false); setCustomOpen(true) }}>
              <span className="dsh-wt_presetAddIcon" aria-hidden>＋</span>
              <span className="dsh-wt_presetAddText">{t('customLayout.add')}</span>
            </button>
          </div>
          <div className="dsh-wt_addForm">
            <input type="text" placeholder={t('add.projectNamePh')} value={wsName}
              onChange={(e) => setWsName(e.target.value)} />
            <div className="dsh-wt_addFolderRow">
              <span className="dsh-wt_customLabel">{t('add.folderParent')}</span>
              <span className={'dsh-wt_addFolderPath' + (wsFolderParent ? '' : ' dsh-wt_addFolderPathNone')} title={wsFolderParent || ''}>
                {wsFolderParent || t('add.folderNone')}
              </span>
              <button type="button" className="dsh-wt_bindFolderChange" disabled={pickBusy}
                onClick={() => pickFolder('add', (p) => { setWsFolderParent(p); setWsFolderError(false) })}>
                {pickBusy ? t('add.folderPicking') : t('add.folderPick')}
              </button>
              <button type="button" className="dsh-wt_bindFolderChange" title={t('add.folderManual')}
                onClick={() => { setManualPathFor(manualPathFor === 'add' ? null : 'add'); setPickErr((prev) => ({ ...prev, add: '' })) }}>{t('add.folderManual')}</button>
            </div>
            {pickBusy && <p className="dsh-wt_folderPickHint">{t('add.folderPickerHint')}</p>}
            {manualPathFor === 'add' && (
              <div className="dsh-wt_addFolderRow">
                <input type="text" className="dsh-wt_manualPathInput" placeholder={t('add.folderManualPh')} value={manualPathText}
                  onChange={(e) => setManualPathText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyManualPath('add') }} />
                <button type="button" className="dsh-wt_bindFolderChange" onClick={() => applyManualPath('add')}>{t('add.folderManualOk')}</button>
              </div>
            )}
            {pickErr.add && <p className="dsh-wt_addError">{pickErr.add}</p>}
            <button type="button" className="dsh-wt_addBtn" onClick={saveLayout}>{t('add.layoutSave')}</button>
          </div>
          {wsFolderError && <p className="dsh-wt_addError">{t('add.folderRequired')}</p>}
        </div>
      )}

      {iconPick && (
        <>
          <div className="dsh-wt_popBackdrop" onClick={() => setIconPick(null)} />
          <div className="dsh-wt_iconPop" style={{ left: iconPick.x, top: iconPick.y }}>
            <div className="dsh-wt_iconPopTitle">{t('icons.title')}</div>
            <div className="dsh-wt_iconGrid">
              {EMOJI_SET.map((em) => {
                const cur = iconPick.kind === 'layout'
                  ? (projects.layouts.find((l) => l.id === iconPick.id)?.icon ?? '🧱')
                  : iconPick.kind === 'shortcut'
                    ? (projects.shortcuts.find((s) => s.id === iconPick.id)?.icon ?? '🔗')
                    : resolveProjectIcon(iconPick.id, projects.iconOverrides[iconPick.id], metas[iconPick.id]?.icon, projects.layouts.find((l) => l.id === iconPick.id)?.icon)
                return (
                  <button
                    key={em}
                    type="button"
                    className="dsh-wt_iconCell"
                    data-on={cur === em ? 'true' : 'false'}
                    onClick={() => {
                      if (iconPick.kind === 'layout') setLayoutIcon(iconPick.id, em)
                      else if (iconPick.kind === 'shortcut') setShortcutIcon(iconPick.id, em)
                      else setProjectIcon(iconPick.id, em)
                      setIconPick(null)
                    }}
                  >{em}</button>
                )
              })}
            </div>
          </div>
        </>
      )}

      {viewOptionsOpen && <div className="dsh-wt_popBackdrop" onClick={() => setViewOptionsOpen(false)} />}
      {viewOptionsOpen && (
        <div ref={settingsRef} className="dsh-wt_manage dsh-wt_pop dsh-wt_settings" style={{ position: 'fixed', left: popLeft, top: settingsTop ?? popTop, width: 280, zIndex: 80 }}>
          <button
            type="button"
            className="dsh-wt_settingsClose"
            aria-label={t('manage.done')}
            title={t('manage.done')}
            onClick={() => setViewOptionsOpen(false)}
          >✕</button>
          {updateInfo && (
            <div className="dsh-wt_updateCard">
              <div className="dsh-wt_updateHead"><span className="dsh-wt_updateDot" />{t('update.available')} · v{updateInfo.latest}</div>
              <div className="dsh-wt_updateVers">{t('update.current')} v{LOCAL_VERSION} → v{updateInfo.latest}</div>
              {updateInfo.notes && <div className="dsh-wt_updateNotes">{updateInfo.notes}</div>}
              <div className="dsh-wt_updateCmd">{UPGRADE_CMD}</div>
              <div className="dsh-wt_updateBtns">
                <button type="button" className="dsh-wt_updateBtn dsh-wt_updateBtnCopy" onClick={() => void copyUpgradeAi()}>
                  {updateCopied ? '✓ ' + t('update.copied') : <>{ICON_SPARK} {t('update.copyAi')}</>}
                </button>
                <button type="button" className="dsh-wt_updateBtn" onClick={skipUpdate}>{t('update.skip')}</button>
                <button type="button" className="dsh-wt_updateBtn" onClick={() => { try { window.open('https://github.com/' + UPDATE_REPO + '/releases/latest', '_blank') } catch { /* 浏览器弹窗被拦：用户自己开 */ } }}>Releases 页</button>
              </div>
              <div className="dsh-wt_updateHint">{t('update.upgradeHint')}</div>
            </div>
          )}
          <div className="dsh-wt_manageHead">
            <span className="dsh-wt_manageTitle">{t('sort.label')}</span>
          </div>
          <div className="dsh-wt_sortRow">
            <button type="button" className="dsh-wt_sortBtn" data-on={view.orderBy === 'manual'}
              onClick={() => persistView({ orderBy: 'manual' })}>{t('sort.manual')}</button>
            <button type="button" className="dsh-wt_sortBtn" data-on={view.orderBy === 'recent'}
              onClick={() => persistView({ orderBy: 'recent' })}>{t('sort.recent')}</button>
          </div>
          <div className="dsh-wt_menuSep" />
          <div className="dsh-wt_manageHead">
            <span className="dsh-wt_manageTitle">{t('manage.title')}</span>
          </div>
          {effectiveOrder.map((id) => {
            const meta = metas[id]
            const layout = projects.layouts.find((l) => l.id === id)
            const display = projects.nameOverrides[id] ?? layout?.title ?? meta?.name ?? id
            const isHidden = projects.hidden.includes(id)
            return (
              <div
                key={id}
                className={'dsh-wt_manageRow' + (isHidden ? ' dsh-wt_manageRowOff' : '')}
                draggable
                onDragStart={(e: any) => { dragIdRef.current = id; try { e.dataTransfer.effectAllowed = 'move' } catch {} }}
                onDragOver={(e: any) => {
                  e.preventDefault()
                  const dragId = dragIdRef.current
                  if (dragId && dragId !== id) moveTo(dragId, id)
                }}
                onDrop={(e: any) => e.preventDefault()}
                onDragEnd={() => { dragIdRef.current = null }}
              >
                <span className="dsh-wt_manageGrip" aria-hidden>≡</span>
                {layout
                  ? <span
                      className="dsh-wt_manageIcon dsh-wt_iconPick"
                      role="button"
                      tabIndex={0}
                      title={t('icons.change')}
                      onClick={(e) => { e.stopPropagation(); openIconPick('layout', id, e.currentTarget as HTMLElement) }}
                    >{layout.icon ?? '🧱'}</span>
                  : <span
                      className="dsh-wt_manageIcon dsh-wt_iconPick"
                      role="button"
                      tabIndex={0}
                      title={t('icons.change')}
                      onClick={(e) => { e.stopPropagation(); openIconPick('project', id, e.currentTarget as HTMLElement) }}
                    >{projects.iconOverrides[id] ?? meta?.icon ?? '📦'}</span>}
                <RenameInput initial={display} placeholder={t('manage.renamePh')} onCommit={(v) => renameProject(id, v)} />
                <button type="button" className="dsh-wt_manageBtn" title={isHidden ? t('manage.show') : t('manage.hide')} onClick={() => toggleHidden(id)}>
                  <EyeIcon closed={isHidden} />
                </button>
                <button type="button" className="dsh-wt_manageBtn" title={t('manage.changeView')} onClick={() => setViewPickFor(id)}>🧩</button>
                <button
                  type="button"
                  className="dsh-wt_manageBtn"
                  title={layout ? t('manage.deleteLayout') : t('manage.deleteProject')}
                  onClick={() => askDelete(layout ? 'layout' : 'project', id, display)}
                >✕</button>
              </div>
            )
          })}
          {projects.shortcuts.map((s) => (
            <div key={s.id} className="dsh-wt_manageRow dsh-wt_manageRowSc">
              <span className="dsh-wt_manageGrip" aria-hidden>🔗</span>
              <span
                className="dsh-wt_manageIcon dsh-wt_iconPick"
                role="button"
                tabIndex={0}
                title={t('icons.change')}
                onClick={(e) => { e.stopPropagation(); openIconPick('shortcut', s.id, e.currentTarget as HTMLElement) }}
              >{s.icon}</span>
              <span className="dsh-wt_manageScName">{s.name}</span>
              <button type="button" className="dsh-wt_manageBtn" title={t('manage.deleteShortcut')} onClick={() => askDelete('shortcut', s.id, s.name)}>✕</button>
            </div>
          ))}
          <div className="dsh-wt_versionRow">
            <span>
              v{LOCAL_VERSION}
              {updateStatus === 'uptodate' && !updateInfo ? ' · ' + t('update.upToDate') : ''}
              {updateStatus === 'failed' && !updateInfo ? ' · ' + t('update.checkFail') : ''}
            </span>
            <span className="dsh-wt_versionActions">
              <button type="button" className="dsh-wt_updateBtn" disabled={updateStatus === 'checking'} onClick={() => void checkUpdates(true)}>
                {updateStatus === 'checking' ? t('update.checking') : t('update.checkNow')}
              </button>
              <span className="dsh-wt_updateToggle" onClick={toggleUpdateCheck}>
                <span>{t('update.autoCheck')}</span>
                <span className="dsh-wt_updateSwitch" data-off={updateCheckOn ? undefined : 'true'} />
              </span>
            </span>
          </div>
        </div>
      )}

      {viewPickFor && <div className="dsh-wt_popBackdrop" style={{ zIndex: 81 }} onClick={() => setViewPickFor(null)} />}
      {viewPickFor && (
        <div className="dsh-wt_menu dsh-wt_pop" style={{ position: 'fixed', left: popLeft, top: popTop, width: 320, zIndex: 82 }}>
          <span className="dsh-wt_menuLabel">{t('viewPick.title')}</span>
          <div className="dsh-wt_presets">
            {PRESET_DEFS.map((def) => {
              const cur = projects.layouts.find((l) => l.id === viewPickFor) ?? projects.views[viewPickFor]
              return (
                <button
                  key={def.id}
                  type="button"
                  className="dsh-wt_preset"
                  data-on={cur && presetOf(cur) === def.id ? 'true' : 'false'}
                  onClick={() => applyLayoutChange(viewPickFor, def.id)}
                >
                  {presetThumb(def.id)}
                </button>
              )
            })}
            <button type="button" className="dsh-wt_preset dsh-wt_presetAdd" title={t('customLayout.addTitle')}
              onClick={() => { setViewPickFor(null); setCustomOpen(true) }}>
              <span className="dsh-wt_presetAddIcon" aria-hidden>＋</span>
              <span className="dsh-wt_presetAddText">{t('customLayout.add')}</span>
            </button>
          </div>
        </div>
      )}

      {bindPick && <div className="dsh-wt_popBackdrop" style={{ zIndex: 83 }} onClick={() => { invalidatePickState(); setBindPick(null); setBindListOpen(false) }} />}
      {bindPick && (
        <div className="dsh-wt_menu dsh-wt_pop dsh-wt_bindPop" style={{ position: 'fixed', left: bindPick.x, top: bindPick.y, width: 280, zIndex: 84 }}>
          {/* 项目文件夹框（格式基准）：第一行 emoji+标题，第二行路径；可随时更改 */}
          <div className="dsh-wt_bindFolderBox">
            <div className="dsh-wt_bindFolderRow">
              <span className="dsh-wt_bindFolderLabel">📁 {t('bind.folder')}</span>
              <button type="button" className="dsh-wt_bindFolderChange" disabled={pickBusy} onClick={changeBindFolder}>
                {pickBusy ? t('add.folderPicking') : t('bind.folderChange') + ' ↻'}
              </button>
              <button type="button" className="dsh-wt_bindFolderChange" title={t('add.folderManual')}
                onClick={() => { setManualPathFor(manualPathFor === 'bind' ? null : 'bind'); setPickErr((prev) => ({ ...prev, bind: '' })) }}>{t('add.folderManual')}</button>
            </div>
            {pickBusy && <p className="dsh-wt_folderPickHint">{t('add.folderPickerHint')}</p>}
            <div className={'dsh-wt_bindFolderPath' + (projects.folders[bindPick.id] ? '' : ' dsh-wt_bindFolderPathNone')} title={projects.folders[bindPick.id] ?? ''}>
              {projects.folders[bindPick.id] ?? t('bind.folderNone')}
            </div>
            {manualPathFor === 'bind' && (
              <div className="dsh-wt_addFolderRow">
                <input type="text" className="dsh-wt_manualPathInput" placeholder={t('add.folderManualPh')} value={manualPathText}
                  onChange={(e) => setManualPathText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyManualPath('bind') }} />
                <button type="button" className="dsh-wt_bindFolderChange" onClick={() => applyManualPath('bind')}>{t('add.folderManualOk')}</button>
              </div>
            )}
            {pickErr.bind && <p className="dsh-wt_addError">{pickErr.bind}</p>}
          </div>
          {/* 绑定对话框（与项目文件夹同格式）：第一行 💬+标题（最右解绑）；第二行 分组 | 对话名（点击右侧弹列表，再点反选收起）；框内下方：说明 */}
          <div className="dsh-wt_bindFolderBox">
            <div className="dsh-wt_bindFolderRow">
              <span className="dsh-wt_bindFolderLabel">💬 {t('bind.title')}</span>
              {projects.bindings[bindPick.id] && (
                <button type="button" className="dsh-wt_bindUnbind" onClick={() => setProjectBinding(bindPick.id, null)}>{t('bind.unbind')} ✕</button>
              )}
            </div>
            {(() => {
              const sid = projects.bindings[bindPick.id]
              if (!sid) {
                return (
                  <button type="button" className="dsh-wt_bindConvRow dsh-wt_bindConvRowNone" title={t('bind.tipUnbound')} onClick={() => setBindListOpen((v) => !v)}>
                    <span className="dsh-wt_bindNoneText">{t('bind.unbound')} · {t('bind.clickPick')}</span>
                  </button>
                )
              }
              const info = bindInfoOf(bindGroups, sid)
              return (
                <button type="button" className="dsh-wt_bindConvRow" title={t('bind.tipBound', { name: info.title })} onClick={() => setBindListOpen((v) => !v)}>
                  <span className="dsh-wt_bindFolder" title={info.folder}>📂 {info.folder}</span>
                  <span className="dsh-wt_bindSep" aria-hidden>|</span>
                  <span className="dsh-wt_bindConvName" title={info.title}>{info.title}</span>
                  <span className="dsh-wt_bindConvChevron" aria-hidden>▾</span>
                </button>
              )
            })()}
            <p className="dsh-wt_bindHint">{t('bind.hint')}</p>
          </div>
        </div>
      )}
      {/* 对话列表弹层：点「绑定对话」行弹出（优先右侧，放不下翻到左侧）；选中即绑定并收起 */}
      {bindPick && bindListOpen && (() => {
        // 主弹窗实际渲染宽 = 280 + 菜单内边距/边框（约 292），右侧列表按 300 偏移避免重叠
        const rightFits = bindPick.x + 300 + 260 <= window.innerWidth - 8
        const listLeft = rightFits ? bindPick.x + 300 : Math.max(8, bindPick.x - 268)
        return (
        <div className="dsh-wt_menu dsh-wt_pop dsh-wt_bindListPop" style={{ position: 'fixed', left: listLeft, top: clamp(bindPick.y, 8, window.innerHeight - 348), width: 260, zIndex: 86 }}>
          <div className="dsh-wt_selectList dsh-wt_bindList">
            {bindGroups.map((g, gi) => (
              <Fragment key={g.title || 'g' + gi}>
                {g.title && (
                  <>
                    <div className="dsh-wt_selectDivider" />
                    <div className="dsh-wt_selectGroup">📁 {g.title}</div>
                  </>
                )}
                {g.sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={'dsh-wt_selectItem' + (projects.bindings[bindPick.id] === s.id ? ' dsh-wt_selectItemOn' : '')}
                    onClick={() => { setProjectBinding(bindPick.id, s.id); setBindListOpen(false) }}
                  >
                    <span className="dsh-wt_selectItemTitle">{s.title}</span>
                    {s.isCurrent && <span className="dsh-wt_selectCurrent">{t('custom.sessionCurrent')}</span>}
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
        )
      })()}

      {/* 控制室强制绑定弹窗：左「加入现有对话」+ 右「新建对话」，选定/建成后自动打开控制室 */}
      {consoleBind && <div className="dsh-wt_popBackdrop" style={{ zIndex: 85 }} onClick={() => setConsoleBind(null)} />}
      {consoleBind && (
        <div className="dsh-wt_menu dsh-wt_pop dsh-wt_consoleBindPop" style={{ position: 'fixed', left: consoleBind.x, top: consoleBind.y, width: 560, zIndex: 86 }}>
          <div className="dsh-wt_consoleBindCols">
            <div className="dsh-wt_consoleBindCol">
              <span className="dsh-wt_consoleBindLabel">➕ {t('console.joinExisting')}</span>
              <div className="dsh-wt_selectList dsh-wt_consoleBindList">
                {consoleGroups.map((g, gi) => (
                  <Fragment key={g.title || 'g' + gi}>
                    {g.title && (
                      <>
                        <div className="dsh-wt_selectDivider" />
                        <div className="dsh-wt_selectGroup">📁 {g.title}</div>
                      </>
                    )}
                    {g.sessions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={'dsh-wt_selectItem' + (projects.bindings[CONSOLE_ID] === s.id ? ' dsh-wt_selectItemOn' : '')}
                        onClick={() => bindConsoleExisting(s.id)}
                      >
                        <span className="dsh-wt_selectItemTitle">{s.title}</span>
                        {s.isCurrent && <span className="dsh-wt_selectCurrent">{t('custom.sessionCurrent')}</span>}
                      </button>
                    ))}
                  </Fragment>
                ))}
                {consoleGroups.length === 0 && <div className="dsh-wt_consoleBindEmpty">{t('console.noSessions')}</div>}
              </div>
            </div>
            <div className="dsh-wt_consoleBindCol dsh-wt_consoleBindColNew">
              <span className="dsh-wt_consoleBindLabel">✨ {t('console.newConv')}</span>
              <select className="dsh-wt_consoleSelect" value={consoleMode} onChange={(e) => setConsoleMode(e.target.value as 'none' | 'existing' | 'new')}>
                <option value="none">{t('console.groupNone')}</option>
                <option value="existing">{t('console.groupExisting')}</option>
                <option value="new">{t('console.groupNew')}</option>
              </select>
              {consoleMode === 'existing' && (
                <select className="dsh-wt_consoleSelect" value={consoleWsId} onChange={(e) => setConsoleWsId(e.target.value)}>
                  {listWorkspaces().map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
                </select>
              )}
              {consoleMode === 'new' && (
                <>
                  <input className="dsh-wt_consoleInput" placeholder={t('console.newParentPh')} value={consoleParent} onChange={(e) => setConsoleParent(e.target.value)} />
                  <input className="dsh-wt_consoleInput" placeholder={t('console.newNamePh')} value={consoleName} onChange={(e) => setConsoleName(e.target.value)} />
                </>
              )}
              {consoleErr && <p className="dsh-wt_consoleErr">{t('console.bindFail')}</p>}
              <button type="button" className="dsh-wt_consoleCreateBtn" disabled={consoleBusy} onClick={bindConsoleNew}>
                {consoleBusy ? '…' : t('console.createBind')}
              </button>
            </div>
          </div>
        </div>
      )}

      {customOpen && <div className="dsh-wt_popBackdrop" style={{ zIndex: 83 }} onClick={() => setCustomOpen(false)} />}
      {customOpen && (
        <div className="dsh-wt_menu dsh-wt_pop" style={{ position: 'fixed', left: popLeft, top: popTop, width: 340, zIndex: 84 }}>
          <span className="dsh-wt_menuLabel">✨ {t('customLayout.title')}</span>
          <textarea
            className="dsh-wt_customLayoutInput"
            autoFocus
            rows={6}
            placeholder={t('customLayout.placeholder')}
            value={customLayoutText}
            onChange={(e) => setCustomLayoutText(e.target.value)}
          />
          <button type="button" className="dsh-wt_customLayoutBtn" onClick={copyCustomLayout}>{t('customLayout.copy')}</button>
          {copiedToast && (
            <p className={'dsh-wt_customLayoutToast' + (copiedToast === 'fail' ? ' dsh-wt_customLayoutToastFail' : '')}>
              {copiedToast === 'ok' ? '✅ ' + t('customLayout.copied') : '⚠️ ' + t('customLayout.copyFail')}
            </p>
          )}
        </div>
      )}

      {requestDelete && <div className="dsh-wt_confirmBackdrop" onClick={() => setRequestDelete(null)} />}
      {requestDelete && (
        <div className="dsh-wt_confirm" role="alertdialog">
          <div className="dsh-wt_confirmTitle">⚠️ {t('confirm.title')}</div>
          <div className="dsh-wt_confirmBody">
            {requestDelete.kind === 'layout'
              ? t('confirm.layoutBody', { name: requestDelete.name })
              : requestDelete.kind === 'shortcut'
                ? t('confirm.shortcutBody', { name: requestDelete.name })
                : t('confirm.projectBody', { name: requestDelete.name })}
          </div>
          <div className="dsh-wt_confirmActions">
            <button type="button" className="dsh-wt_confirmCancel" onClick={() => setRequestDelete(null)}>{t('confirm.cancel')}</button>
            <button type="button" className="dsh-wt_confirmDelete" onClick={doDelete}>{t('confirm.delete')}</button>
          </div>
        </div>
      )}

      <div className="dsh-wt_projects" data-managing={viewOptionsOpen ? 'true' : undefined}>
        {/* 「工作台」控制室项目：固定首位、不可删除；未绑定点开 = 强制绑定弹窗 */}
        <button
          type="button"
          className="dsh-wt_layout dsh-wt_consoleEntry"
          data-on={activeSplitId === CONSOLE_ID ? 'true' : 'false'}
          data-wt-busy={bindNotifyMap[CONSOLE_ID] === 'busy' ? 'true' : 'false'}
          data-wt-need={needNowMap[CONSOLE_ID] ? 'true' : 'false'}
          style={{ order: 0, position: 'relative' }}
          title={t('console.name') + (needNowMap[CONSOLE_ID] ? ' · 待决策' : '')}
          onClick={(e) => clickConsoleCard(e.currentTarget as HTMLElement)}
        >
          <span className="dsh-wt_layoutIcon">{CONSOLE_ICON}</span>
          <span className="dsh-wt_layoutText">
            <span className="dsh-wt_layoutName">{t('console.name')}</span>
          </span>
          {needNowMap[CONSOLE_ID] && <span className="dsh-wt_needTag">待决策</span>}
          <span
            className={'dsh-wt_bindBtn'}
            role="button"
            tabIndex={0}
            data-bound={needNowMap[CONSOLE_ID] ? 'need' : (bindNotifyMap[CONSOLE_ID] ?? (projects.bindings[CONSOLE_ID] ? 'true' : 'false'))}
            data-tip={(projects.bindings[CONSOLE_ID]
              ? t('bind.tipBound', { name: boundSessionTitle(projects.bindings[CONSOLE_ID]) })
              : t('bind.tipUnbound')) + (needNowMap[CONSOLE_ID] ? t('bind.tipNeed') : bindNotifyMap[CONSOLE_ID] === 'busy' ? t('bind.tipBusy') : '')}
            aria-label={projects.bindings[CONSOLE_ID]
              ? t('bind.tipBound', { name: boundSessionTitle(projects.bindings[CONSOLE_ID]) })
              : t('bind.tipUnbound')}
            onClick={(e) => { e.stopPropagation(); openBindPick(CONSOLE_ID, e.currentTarget as HTMLElement) }}
          ><span className="dsh-wt_bindCircles" aria-hidden /></span>
          <span className="dsh-wt_layoutArrow" aria-hidden>›</span>
        </button>
        {renderProjectSlot
          ? renderProjectSlot('sidebar.worktable.project', ownerProps)
          : <div className="dsh-wt_empty">{t('empty')}</div>}
        {visibleLayouts.map((l) => (
          <button
            key={l.id}
            type="button"
            className="dsh-wt_layout"
            data-on={activeSplitId === l.id ? 'true' : 'false'}
            data-wt-busy={bindNotifyMap[l.id] === 'busy' ? 'true' : 'false'}
            data-wt-need={needNowMap[l.id] ? 'true' : 'false'}
            style={{ order: effectiveOrder.indexOf(l.id) + 1000, position: 'relative' }}
            title={(projects.nameOverrides[l.id] ?? l.title) + (needNowMap[l.id] ? ' · 待决策' : '')}
            onClick={() => { openSplit(l); reportUsed(l.id) }}
          >
            <span
              className="dsh-wt_layoutIcon dsh-wt_iconPick"
              role="button"
              tabIndex={0}
              title={t('icons.change')}
              onClick={(e) => { e.stopPropagation(); openIconPick('layout', l.id, e.currentTarget as HTMLElement) }}
            >{l.icon ?? '🧱'}</span>
            <span className="dsh-wt_layoutText">
              <span className="dsh-wt_layoutName">{projects.nameOverrides[l.id] ?? l.title}</span>
            </span>
            {needNowMap[l.id] && <span className="dsh-wt_needTag">待决策</span>}
            <span
              className={'dsh-wt_bindBtn'}
              role="button"
              tabIndex={0}
              data-bound={needNowMap[l.id] ? 'need' : (bindNotifyMap[l.id] ?? (projects.bindings[l.id] ? 'true' : 'false'))}
              data-tip={(projects.bindings[l.id]
                ? t('bind.tipBound', { name: boundSessionTitle(projects.bindings[l.id]) })
                : t('bind.tipUnbound')) + (needNowMap[l.id] ? t('bind.tipNeed') : bindNotifyMap[l.id] === 'busy' ? t('bind.tipBusy') : bindNotifyMap[l.id] === 'done' ? t('bind.tipDone') : bindNotifyMap[l.id] === 'need' ? t('bind.tipNeed') : '')}
              aria-label={projects.bindings[l.id] ? t('bind.tipBound', { name: boundSessionTitle(projects.bindings[l.id]) }) : t('bind.tipUnbound')}
              onClick={(e) => { e.stopPropagation(); openBindPick(l.id, e.currentTarget as HTMLElement) }}
            ><span className="dsh-wt_bindCircles" aria-hidden /></span>
            <span className="dsh-wt_layoutArrow" aria-hidden>›</span>
          </button>
        ))}
      </div>

      {visibleShortcuts.length > 0 && (
        <div className="dsh-wt_shortcuts">
          {visibleShortcuts.map((s) => (
            <a
              key={s.id}
              className="dsh-wt_shortcut"
              href={s.href}
              target="_blank"
              rel="noreferrer noopener"
              title={s.href}
            >
              <span
                className="dsh-wt_shortcutIcon dsh-wt_iconPick"
                role="button"
                tabIndex={0}
                title={t('icons.change')}
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); openIconPick('shortcut', s.id, e.currentTarget as HTMLElement) }}
              >{s.icon}</span>
              <span className="dsh-wt_shortcutName">{s.name}</span>
              <span className="dsh-wt_shortcutBadge">{t('shortcut.badge')}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

export const inject = ['slots', 'locale', 'sessions', 'conversation', 'workspaces']

export function apply(ctx: any) {
  // 自定义窗口 → 宿主会话桥：保存 sessions/conversation/list 服务引用（模块级）
  sessionBridge = {
    sessions: ctx.sessions ?? null,
    conversation: ctx.conversation ?? null,
    list: ctx.sessions?.list ?? null,
    workspaces: ctx.workspaces ?? null,
    // 0.2 起「当前会话」选择由 ui-workspace 服务持有（openSession）；0.1.x 取不到 = null。
    // 必须用 ctx.get 可选查找：ctx.uiWorkspace 直读会被注入门禁代理拒绝（未声明即抛错）。
    uiWorkspace: (() => { try { return ctx.get?.('uiWorkspace') ?? null } catch { return null } })(),
    pendingInteractions: ctx.sessions?.pendingInteractions ?? null,
  }
  clientCtx = ctx
  try { hostApi = ctx.get?.('connection')?.api ?? null } catch { hostApi = null }
  try { (window as any).__dshHostApi = hostApi } catch {}
  // 订阅宿主「待用户决策」登记（缺服务则静默；探测钩子供调试）
  try {
    wirePendingInteractionsSource()
    ;(window as any).__dshPendingSource = findPendingInteractions()
  } catch {}
  try {
    (window as any).__dshOpenSession = (id: string) => openSessionInHost(id); (window as any).__dshSessions = ctx.sessions; (window as any).__dshPromptIntoSession = (id: string, text: string) => promptIntoSession(id, text); (window as any).__dshWorkspaces = ctx.workspaces; (window as any).__dshBuildWindowTaskText = buildWindowTaskText; (window as any).__dshSyncSessionScope = () => syncSessionScope(sessionBridge?.list) } catch {}
  // 宿主工作区归档集合变化（会话被删除/归档、外部侧边栏操作）→ 刷新控制室卡片与「会话列表」浮层数据源
  try {
    const wl = ctx.workspaces?.list
    if (wl && typeof wl.subscribe === 'function') {
      const disposeWl = wl.subscribe(() => notifyConsole())
      ctx.effect(() => disposeWl, 'dsh-worktable: workspace archive watch')
    }
  } catch {}


  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-dsh-plugin', 'dsh-worktable')
    style.textContent = css
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-worktable: styles')

  // 空白会话白屏自愈：每 2s 看一次当前会话，卡在 loading 的空白会话重建一次历史流。
  // （新建会话的聚焦流程自己也兜这个，这里覆盖「用户从侧栏点开一条早已卡住的会话」。）
  ctx.effect(() => {
    const timer = window.setInterval(() => {
      if (domGate.isPaused()) return // 组合 / 开合窗口内不抢这一轮的 RPC 与重渲染
      void healStuckCurrentSession()
    }, 2000)
    return () => { try { window.clearInterval(timer) } catch {} }
  }, 'dsh-assistant: blank session open watchdog')

  // 绑定按钮 hover 委托已迁入非 headless WorktableSection；生产首屏不挂空监听。

  // locale 词典（宿主 locale 服务缺席时由 t 的回退分支兜底）
  ctx.effect(() => {
    if (ctx.locale?.register) return ctx.locale.register(NS, { zh, en })
  }, 'dsh-worktable: dictionaries')

  // 子座位注册 id 序列跟踪（供排序/编辑模式使用）
  const syncIds = () => {
    const entries = ctx.slots.entries('sidebar.worktable.project')
    const ids: string[] = []
    for (const entry of entries) {
      const id = entry?.options?.id
      if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id)
    }
    registryStore.ids = ids
    for (const fn of registryStore.listeners) fn()
  }
  const disposeSubscribe = ctx.slots.subscribe('sidebar.worktable.project', syncIds)
  syncIds()
  ctx.effect(() => disposeSubscribe, 'dsh-worktable: project registry watch')

  // 会话作用域（当前会话 cwd 与后台任务）→ 功能窗数据源
  const sessionsList = ctx.sessions?.list
  if (sessionsList && typeof sessionsList.getSnapshot === 'function') {
    syncSessionScope(sessionsList)
    const disposeScope = sessionsList.subscribe(() => syncSessionScope(sessionsList))
    ctx.effect(() => disposeScope, 'dsh-worktable: session scope watch')
    // 0.2 的「当前会话」在 ui-workspace 的选择快照里，切会话不一定伴随列表快照变化：
    // 单独订阅一次，项目 × 对话联动与会话作用域才不会漏拍。
    try {
      ctx.inject(['uiWorkspace'], (apiCtx: any) => {
        const uw = apiCtx?.uiWorkspace ?? (() => { try { return apiCtx?.get?.('uiWorkspace') ?? null } catch { return null } })()
        const sel = uw?.selection
        if (!sel || typeof sel.subscribe !== 'function') return
        const disposeSel = sel.subscribe(() => { if (sessionsList) syncSessionScope(sessionsList) })
        ctx.effect(() => () => { try { disposeSel() } catch {} }, 'dsh-worktable: session selection watch')
      })
    } catch {}
  }

  // 「离开项目工作区」出口（私人助手等入口打开前调用）：分栏收起 + 不把会话回切到项目里。
  ctx.effect(() => {
    setWorkspaceExit(() => {
      if (!splitStore.active) return
      suppressRestoreRef.current = true
      try { splitStore.close() } catch {}
    })
    return () => setWorkspaceExit(null)
  }, 'dsh-assistant: leave project workspace')

  // 分栏工作区浮层（M1 通用引擎，shell.overlay 座位）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-worktable-split',
    order: 100,
  }, SplitWorkspace), 'dsh-worktable: split workspace overlay')

  // 控制室的数据/弹窗宿主：常驻但「无头」——不在侧栏渲染工作台区块，
  // 只负责 splitEnv 注入与添加项目/图标/绑定等弹窗。控制室一律从悬浮球进入。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-assistant-headless-worktable',
    order: 90,
    inject: () => ({ headless: true }),
  }, WorktableSection), 'dsh-assistant: headless worktable host')
}

export { WorktableSection }
