/**
 * 个人秘书「派活目录」自动判断（纯函数，无 react / 无网络，可 node 单测）。
 *
 * 规则（2026-11-21 用户实测修正）：
 *   1. 纯知识性、无需动手的随口问题 / 闲聊 → `chat`：秘书直接答。
 *   2. 其余任务与既有项目相关，或旧任务延续 → `existing`：续接/新建该项目下的 CU 会话。
 *   3. 其余任务没有既有项目 → `new-folder`：新建专项文件夹 + CU 会话。
 *      看屏幕、操作应用、读本机文件、上网查证，以及裁图/翻译/润色等动手活，一律不留在秘书页。
 *      `assistant` 仅为兼容旧持久化数据保留，新决策不再返回。
 *
 * 为什么是"规则"而不是"模型判断"：目录选错会让工作落到错误文件夹、事后很难搬；
 * 这里把判定写成可断言的分支，谁改都能先跑 scripts/test-secretary-dispatch.mjs 看行为。
 */
import { basenameOf, joinPath } from './pathutil.ts'

/** 一个可派活的既有项目（来自控制室项目卡 / 会话列表的 cwd 归并）。 */
export interface DispatchProject {
  /** 项目工作目录（绝对路径）。 */
  dir: string
  /** 展示名（项目卡名 / 文件夹名 / 会话标题）。 */
  name?: string
  /** 最近活动时间（ms）；0/省略 = 不知道。 */
  lastUsedAt?: number
  /** 该项目下最近的会话标题（用于"旧任务延续"判定）。 */
  titles?: string[]
}

export interface DispatchInput {
  text: string
  projects?: DispatchProject[]
  /** 个人助手目录；不再直接接杂活，只在未配置新项目父目录时用于推导其父目录。 */
  assistantHome: string
  /** 新建专项文件夹的父目录；空串时退回 assistantHome 的父目录。 */
  newFolderParent?: string
  /** 该父目录下已存在的名字（避免新建重名）。 */
  existingFolders?: string[]
  /** 当前时间（测试注入）。 */
  now?: Date
}

export type DispatchKind = 'chat' | 'existing' | 'new-folder' | 'assistant'

export interface DispatchDecision {
  kind: DispatchKind
  /** 目标目录；`chat` 时为空串（消息发给固定秘书会话，不派活）。 */
  cwd: string
  /** 一句话理由（页面 toast / 排查用）。 */
  reason: string
  /** `existing` 命中的项目名。 */
  projectName?: string
  /** `new-folder` 要新建的目录名（不是路径）。 */
  folderName?: string
  /** 复杂度的命中断言（调试/单测用）。 */
  signals?: string[]
}

/** 任务意图：出现这些词才可能派活；纯问句（怎么/为什么/呢/吗）优先按聊天处理。 */
const TASK_VERBS = [
  '帮我', '帮忙', '请帮', '给我', '替我', '把', '将', '做', '写', '改', '修', '补', '建', '搭', '跑', '算',
  '画', '查', '找', '整理', '生成', '翻译', '优化', '重构', '部署', '安装', '配置', '导出', '导入', '转换',
  '合并', '拆分', '测试', '清理', '统计', '对比', '下载', '上传', '扫描', '校对', '润色', '排版', '实现',
  '开发', '编写', '做个', '做一个', '来一份', '出一份', '弄一个', '搞一个', '写个', '建个', '加一个',
  'increase', 'add', 'write', 'fix', 'build', 'run', 'make', 'implement', 'refactor', 'deploy', 'create',
]

/** 纯聊天/问句的收尾词：命中且没有强动作词时按聊天处理。 */
const CHAT_TAILS = ['吗', '呢', '吧', '么', '怎么样', '为什么', '是什么', '有没有', '能不能', '可以吗', '?', '？']

/** 多步骤信号。 */
const MULTI_STEP = ['然后', '接着', '再', '最后', '首先', '其次', '第一步', '第二步', '步骤', '→', '先', '之后']
/** 跨文件信号。 */
const CROSS_FILE = [
  '所有文件', '每个文件', '全部文件', '批量', '逐个', '逐页', '逐条', '全文', '整个目录', '各章', '每一章',
  '所有章节', '多个文件', '跨文件', '统一改', '全部改', '每个页面', '整个工程', '整个项目', '全站',
]
/** 建工程信号。 */
const BUILD_PROJECT = [
  '新建项目', '创建项目', '建个工程', '搭个', '开发一个', '实现一个', '写一套', '做一个网站', '写个脚本',
  '自动化', '工程', '项目', '小程序', '插件', '系统', 'pipeline', '工作流', '脚手架', '从零',
]
/** 旧任务延续信号（与项目名/会话标题一起出现时命中）。 */
const CONTINUATION = ['继续', '接着', '上次', '上一次', '刚才', '之前那个', '之前那', '那个', '再改', '还要', '别忘了', '接着说', '后来']

/** 归一：小写、去掉空白与常见标点，便于包含匹配。 */
function norm(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？"'“”‘’（）()\[\]{}<>《》\-—_/\\|~`@#$%^&*+=.,!?;:]+/g, '')
}

/** 用到的信号列表（便于单测断言"为什么判成复杂"）。 */
export function dispatchSignals(text: string): string[] {
  const raw = String(text ?? '')
  const hits: string[] = []
  const steps = MULTI_STEP.filter((word) => raw.includes(word))
  if (steps.length >= 2) hits.push('multi-step')
  if (CROSS_FILE.some((word) => raw.includes(word))) hits.push('cross-file')
  if (BUILD_PROJECT.some((word) => raw.includes(word))) hits.push('build-project')
  // 编号清单（1. 2. / ①②）也算多步骤
  if (/(^|\n)\s*(?:\d+[.、)]|[①②③④⑤])/m.test(raw)) hits.push('numbered-list')
  return hits
}

/**
 * 这句话是否依赖秘书会话之外的能力。命中时，即使是问句也必须先派 CU，
 * 不能被「吗/呢/是什么」等聊天收尾词吞掉。
 */
export function requiresComputerUse(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (raw === '') return false
  const lower = raw.toLowerCase()
  // 当前屏幕 / 已打开的页面或应用：典型的「你看我打开的 QQ 页面……」。
  if (/(看|查看|识别|读取|操作|点击|截图|截屏).{0,18}(屏幕|页面|窗口|桌面|qq|微信|浏览器|应用|软件)/i.test(raw)) return true
  if (/(我|你|当前|现在|这个|那个|已|已经).{0,12}(打开|开着|显示|切到).{0,18}(屏幕|页面|窗口|桌面|qq|微信|浏览器|应用|软件)/i.test(raw)) return true
  if (/(打开|启动|切换|点击|输入|发送|操作).{0,16}(qq|微信|chrome|edge|浏览器|应用|软件|窗口)/i.test(raw)) return true
  // 本机文件 / 明确路径。
  if (/(本机|本地|电脑里|桌面上|磁盘)/i.test(raw) && /(文件|文件夹|目录|文档|截图|图片|word|excel|ppt|pdf|读|看|找|打开)/i.test(raw)) return true
  if (/(读|打开|查看|查找|检查|修改|整理|分析|总结|转换|导出|上传|下载).{0,18}(文件|文件夹|目录|文档|word|excel|ppt|pdf)/i.test(raw)) return true
  if (/(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:[\w.-]+\/)+[\w.-]+)/.test(raw)) return true
  // 必须联网才能查证 / 获取的当前信息。
  if (/(上网|联网|网上|网页|网站|搜索一下|搜一下|在线查|查证|核验|核实|官方来源|最新资料)/i.test(raw)) return true
  if (/(最新|实时|今天|明天|现在|当前).{0,12}(天气|新闻|汇率|股价|价格|航班|车次|动态)/i.test(raw)) return true
  // 常见 GUI 名称即使夹在英文大小写混合输入里也能识别。
  if (/\b(computer use|screenshot|screen|desktop)\b/i.test(lower) && /(看|查看|打开|操作|截图|什么|哪)/i.test(raw)) return true
  return false
}

/** 是否表达了"要我去做点什么"的意图。 */
export function hasTaskIntent(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (raw === '') return false
  if (requiresComputerUse(raw)) return true
  const hasVerb = TASK_VERBS.some((word) => raw.toLowerCase().includes(word))
  if (!hasVerb) return false
  const tailQuestion = CHAT_TAILS.some((word) => raw.endsWith(word))
  // 没有外部能力线索、也没有明确改写/执行动作的尾问句，才按纯知识随口问处理；
  // read/web 已在只读闸中禁用，不能再以「秘书自己查」为由留在本会话。
  if (tailQuestion && !dispatchSignals(raw).length && !/(把|将).{0,20}(改|写|做|建|跑|生成)/.test(raw)) return false
  return true
}

/**
 * 复杂度：多步骤 / 跨文件 / 建工程 任一命中即算复杂（用户口径把这三条并列成「复杂」）。
 * 复杂度只用于解释与诊断信号，不再决定要不要派活：简单动手活同样走 C 新建专项文件夹。
 */
export function complexityOf(text: string): { level: 'simple' | 'complex'; signals: string[] } {
  const signals = dispatchSignals(text)
  return { level: signals.length > 0 ? 'complex' : 'simple', signals }
}

/**
 * 从原话里取一个能当文件夹名的短语：
 *   1. 半角/全角标点、分隔符一律换成 `-`（Windows 不允许 `\ / : * ? " < > |`）；
 *   2. 按 `-` 分段后整段累加，超过 20 字就停（不会把最后一个词截成半截）。
 * 取不到 ≥2 字时退回时间戳，保证永远有个合法名字。
 */
export function slugFolderName(text: string, now: Date = new Date()): string {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|\r\n\t\u3000]+/g, '-')
    .replace(/[，。、；：！？“”‘’（）【】《》〈〉·…—～]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const tokens = cleaned.split('-').filter(Boolean)
    // 开头的虚词/序号（"帮我"、"1"）不进目录名
    .filter((token, index) => index > 0 || !/^(?:帮我|帮忙|请|给我|替我|\d+[.、)]?)$/.test(token))
  const parts: string[] = []
  let length = 0
  for (const token of tokens) {
    const next = length === 0 ? token.length : length + 1 + token.length
    if (next > 20) break
    parts.push(token)
    length = next
  }
  const head = parts.join('-')
  return head.length >= 2 ? head : stampOf(now)
}

/** YYYYMMDDHHmm。 */
export function stampOf(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`
}

/** 生成不与 existing 重名的目录名（时间戳 / 撞名追加 -2、-3…）。 */
export function uniqueFolderName(base: string, existing: string[] = []): string {
  const taken = new Set(existing.map((name) => norm(name)))
  let name = base
  let n = 2
  while (taken.has(norm(name))) {
    name = `${base}-${n}`
    n += 1
  }
  return name
}

/** 从文本里认出的绝对路径（Windows 盘符 / UNC / POSIX 绝对）。 */
export function absolutePathsIn(text: string): string[] {
  const out: string[] = []
  const re = /(?:[A-Za-z]:[\\/][^\s"'，。；、）)]*|\\\\[^\s"'，。；、）)]+|\/(?:[\w.-]+\/)+[\w.-]+)/g
  const matches = String(text ?? '').match(re) ?? []
  for (const match of matches) {
    const trimmed = match.replace(/[\\/]+$/, '')
    if (trimmed !== '') out.push(trimmed)
    if (out.length >= 4) break
  }
  return out
}

function sameOrInside(dir: string, target: string): boolean {
  const a = norm(dir)
  const b = norm(target)
  if (a === '' || b === '') return false
  return b === a || b.startsWith(a)
}

/**
 * 命中的既有项目：显式路径 > 项目名 > 目录名 > 会话标题（都要求 ≥2 个归一字符，
 * 避免 "hpg" 这种短名把无关句子全判成相关）。
 * @param text - 用户原话。
 * @param projects - 候选项目（按 lastUsedAt 降序更稳，这里不依赖顺序）。
 * @returns 命中的项目与信号。
 */
export function matchProject(
  text: string,
  projects: DispatchProject[] = [],
): { project: DispatchProject; signal: string } | null {
  const raw = String(text ?? '')
  const body = norm(raw)
  if (body === '') return null

  // 1) 原话里直接写了路径
  for (const path of absolutePathsIn(raw)) {
    for (const project of projects) {
      if (project.dir && sameOrInside(project.dir, path)) return { project, signal: 'path' }
    }
  }

  // 2) 项目名 / 目录名出现在原话里（取最长命中，避免 "博士" 命中 "博士论文" 之类的短名）
  let best: { project: DispatchProject; signal: string; weight: number } | null = null
  for (const project of projects) {
    const name = norm(project.name ?? '')
    if (name.length >= 2 && body.includes(name)) {
      best = pick(best, { project, signal: 'name', weight: name.length * 2 })
    }
    const base = norm(basenameOf(project.dir))
    if (base.length >= 2 && base !== name && body.includes(base)) {
      best = pick(best, { project, signal: 'dir-name', weight: base.length })
    }
  }
  if (best !== null) return { project: best.project, signal: best.signal }

  // 3) 旧任务延续：延续词 + 会话标题片段
  if (CONTINUATION.some((word) => raw.includes(word))) {
    for (const project of projects) {
      for (const title of project.titles ?? []) {
        const key = norm(title)
        if (key.length >= 4 && body.includes(key)) return { project, signal: 'continuation-title' }
      }
    }
  }
  return null
}

function pick<T extends { weight: number }>(current: T | null, next: T): T {
  return current === null || next.weight > current.weight ? next : current
}

/**
 * 派活目录决策（纯函数）。
 * @param input - 原话 + 候选项目 + 助手目录 + 新项目父目录。
 * @returns 目标类别与目录；`chat` 表示不派活。
 */
export function decideDispatchTarget(input: DispatchInput): DispatchDecision {
  const text = String(input.text ?? '').trim()
  const projects = input.projects ?? []
  const assistantHome = String(input.assistantHome ?? '').trim()

  if (!hasTaskIntent(text)) {
    return { kind: 'chat', cwd: '', reason: '不像要派出去的活，交给秘书本人回答' }
  }

  const matched = matchProject(text, projects)
  if (matched !== null) {
    return {
      kind: 'existing',
      cwd: matched.project.dir,
      projectName: matched.project.name ?? basenameOf(matched.project.dir),
      reason: `与既有项目「${matched.project.name ?? basenameOf(matched.project.dir)}」相关（${matched.signal}）`,
    }
  }

  const complexity = complexityOf(text)
  const fallbackParent = String(input.newFolderParent ?? '').trim()
  const parent = fallbackParent || (assistantHome ? dirnameOf(assistantHome) : '')
  if (parent !== '') {
    const folderName = uniqueFolderName(slugFolderName(text, input.now), input.existingFolders)
    const signals = [...complexity.signals]
    if (requiresComputerUse(text)) signals.push('requires-computer-use')
    return {
      kind: 'new-folder',
      cwd: joinPath(parent, folderName),
      folderName,
      signals,
      reason: complexity.level === 'complex'
        ? `不相关的新活，且复杂（${complexity.signals.join('、')}）→ 新建专项文件夹 + Computer Use`
        : '没有对应项目文件夹的动手任务 → 新建专项文件夹 + Computer Use',
    }
  }

  // 目录配置不可用时才留在秘书会话；这不是「纯知识问题」分类结果。
  return { kind: 'chat', cwd: '', reason: '没有可用的派活目录，无法创建 Computer Use 会话' }
}

/** 取父目录（不引 node:path，客户端也能用）。 */
export function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (idx < 0) return ''
  if (idx === 0) return p[0]!
  if (idx === 2 && /^[A-Za-z]:[\\/]/.test(p)) return p.slice(0, 3)
  return p.slice(0, idx)
}

/** 会话列表行（只取这里需要的字段，避免把 orb-api 的类型拖进纯模块）。 */
export interface SessionRowLike {
  cwd?: string
  title?: string
  updatedAt?: number
  sessionId?: string
}

/**
 * 把会话列表归并成"候选项目"：同目录只留一条，名字取目录名，
 * 标题收集该目录下最近的几条会话（给"旧任务延续"判定用）。
 * 助手目录自己也要算一条（名字叫「个人助手」），但它的命中优先给 assistantHome 规则用——
 * 这里照样保留，因为用户可能明确说"去个人助手目录里改那个笔记"。
 * @param rows - 会话行（按 updatedAt 降序更准，函数不依赖顺序）。
 * @param excludeDirs - 不参与项目匹配的目录（一般是个人助手目录）。
 * @returns 候选项目（按最近活动降序）。
 */
export function projectsFromSessions(
  rows: SessionRowLike[] = [],
  excludeDirs: string[] = [],
): DispatchProject[] {
  const excluded = new Set(excludeDirs.map((dir) => norm(dir)).filter(Boolean))
  const byDir = new Map<string, DispatchProject>()
  for (const row of rows) {
    const dir = String(row?.cwd ?? '').trim()
    if (dir === '') continue
    const key = norm(dir)
    if (key === '' || excluded.has(key)) continue
    const title = String(row?.title ?? '').trim()
    const at = Number(row?.updatedAt ?? 0) || 0
    const current = byDir.get(key)
    if (current === undefined) {
      byDir.set(key, {
        dir,
        name: basenameOf(dir),
        lastUsedAt: at,
        titles: title !== '' ? [title] : [],
      })
      continue
    }
    current.lastUsedAt = Math.max(current.lastUsedAt ?? 0, at)
    if (title !== '' && !(current.titles ?? []).includes(title) && (current.titles ?? []).length < 8) {
      current.titles = [...(current.titles ?? []), title]
    }
  }
  return [...byDir.values()].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
}
