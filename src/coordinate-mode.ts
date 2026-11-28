/**
 * Computer Use 坐标模式设置（从 dsh-orb 移入个人助手）。
 *
 * 背景：内嵌的 computer-use 工具默认用「千分比坐标」——模型按截图的 0–1000 比例给
 * 点击位置（x=500 是画面中线）。模型若按像素理解位置，就会点偏；关掉后改用截图
 * 原始像素坐标，点击一般更准。
 *
 * 真值放在 profile 目录的 millifraction-coordinates.json（沿用 dsh-orb 的文件名，
 * 老配置自动继承）。宿主对外提供两样东西：
 *   - cordis 服务 `assistantCoordinateMode`：{ currentMode() → 'millifraction' | 'pixel' }
 *     （内嵌 computer-use 在新建会话时读它盖坐标模式戳）；
 *   - HTTP GET/POST /api/assistant/coordinate-mode：设置页读写（手机端经同一代理同源可用）。
 *
 * 只影响之后新建的 Computer Use 会话：坐标模式在会话创建时写进会话记录，已开会话
 * 保持不变，避免同一段对话里历史坐标与当前坐标系打架（与 dsh-orb 口径一致）。
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { manageWebRoutes } from './web-routes.ts'

export const COORDINATE_MODE_ROUTE = '/api/assistant/coordinate-mode'

/** 与 dsh-orb 同名文件：用户已有的设置直接继承，不需要重新选一次。 */
const SETTINGS_FILE = 'millifraction-coordinates.json'

export type CoordinateMode = 'millifraction' | 'pixel'

function profileDir(ctx: any): string {
  try {
    const p = ctx?.get?.('profileContext')
    if (p && typeof p.dir === 'string' && p.dir) return p.dir
  } catch {}
  try {
    const h = ctx?.get?.('homePaths')
    if (h && typeof h.home === 'string' && h.home) return h.home
  } catch {}
  return process.env.DSH_HOME || process.cwd()
}

/** 缺省关掉千分比：含 Windows 在内全部平台走截图原始像素（2026-11-25 起）。 */
function defaultMillifraction(): boolean {
  return false
}

function readMillifraction(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed.enabled === 'boolean') return parsed.enabled
  } catch { /* 没有配置文件 → 用平台缺省 */ }
  return defaultMillifraction()
}

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 只读一个小 JSON body；设置页只会发 { enabled: boolean }。 */
async function readBody(req: any, limit = 8 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += b.length
    if (size > limit) return null
    chunks.push(b)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Computer Use 会话的 agent 预设 id（与 src/assistant-cu-watch.ts / src/assistant-dispatch.ts 同一口径）。 */
const CU_AGENT_PRESET = 'computer-use'

/**
 * 注入段的宿主内唯一名字。宿主 SystemPrompt.section 要求全局唯一（重名会抛），
 * 瀑布兜底靠这个名字认「这段已经在载荷里了」，避免两处重复注入。
 */
const CU_POLICY_SECTION_NAME = 'assistant:computer-use-coordinate-policy'

/**
 * 段位次序：紧跟内嵌 computer-use 自己的策略段（order 1750，
 * vendor/computer-use/index.js:1043 → :1219-1223），所以这段规则在模型读到的文本里
 * 排在「Coordinates: …」那句之后；1770/1775/1780/1785/1790 是秘书会话自己的段，不占用 1760。
 */
export const CU_POLICY_SECTION_ORDER = 1760

/** 内嵌 computer-use 在会话日志里盖坐标模式戳的事件名（canonical 与迁移别名都认）。 */
const COORDINATE_MODE_EVENT_TYPES = ['computer-use/coordinate-mode', 'plugin:computer-use/coordinate-mode']

/**
 * DSH 数据根（`<DSH_HOME>`）：本机 profile 目录就是 `<DSH_HOME>/profiles/<名字>`，
 * 所以先认目录里的 `.dsh` 段、再认 `profiles` 段往回退一级；都认不出时按 `<DSH_HOME>/cu-click`
 * 的默认位置把 `.dsh` 补上。刻意不新引 `process` / `node:os`：本文件已有 profileDir()
 * 的同一条回落链（profile 目录 → homePaths → DSH_HOME → cwd），够用了。
 */
function dshRootOf(dir: string): string {
  const parts = String(dir).split(/[\\/]+/).filter((part) => part !== '')
  const dshAt = parts.lastIndexOf('.dsh')
  if (dshAt > 0) return join(...parts.slice(0, dshAt + 1))
  const profilesAt = parts.lastIndexOf('profiles')
  if (profilesAt > 0) return join(...parts.slice(0, profilesAt))
  return join(dir, '.dsh')
}

/** 本机量坐标脚本的绝对路径（仓库里不许写死账户名，按宿主给的 profile 目录派生）。 */
export function cuMeasureScriptPath(ctx?: any): string {
  return join(dshRootOf(profileDir(ctx)), 'cu-click', 'measure.ps1')
}

/** 全帧扫描器（scan_frame.ps1）的绝对路径：与 measure.ps1 同目录，同属本机 CU 资产。 */
export function cuScanFrameScriptPath(ctx?: any): string {
  return join(dshRootOf(profileDir(ctx)), 'cu-click', 'scan_frame.ps1')
}

/**
 * 目标表（坐标缓存）包装器的绝对路径：target_table.py，套在 scan_frame.ps1 外面。
 *
 * 它补 scan_frame.ps1 缺的两样能力——给 cluster 附稳定名字标签、算粗粒度结构指纹——并把
 * 名字 → 中心物理像素落盘。和 measure.ps1 一样是本机 CU 资产（不进仓库、不进 npm 包），
 * 所以路径按宿主给的 profile 目录派生，命令行写死账户名是禁止的。
 */
export function cuTargetTableScriptPath(ctx?: any): string {
  return join(dshRootOf(profileDir(ctx)), 'cu-click', 'target_table.py')
}

/** 目标表落盘目录：`<DSH_HOME>/cu-click/target-table/<指纹>.json`（指纹 = 帧尺寸 + 结构哈希 + 坐标空间）。 */
export function cuTargetTableDir(ctx?: any): string {
  return join(dshRootOf(profileDir(ctx)), 'cu-click', 'target-table')
}

/** 一键关掉整套目标表的开关（默认开启）：`DSH_CU_TARGET_TABLE=0/false/off/no` 即关。 */
export const CU_TARGET_TABLE_ENV = 'DSH_CU_TARGET_TABLE'
/** 开关缺省值：默认开启（关掉只需设环境变量，不改代码）。 */
export const CU_TARGET_TABLE_DEFAULT_ENABLED = true
/** 兜底单次封顶（毫秒）：表不存在/未命中只补扫 1 次，不等待、不循环。 */
export const CU_TARGET_TABLE_FALLBACK_BUDGET_MS = 200
/** 同一目标最多重试次数，再换定位方式（与 G6 同一口径）。 */
export const CU_TARGET_TABLE_MAX_RETRY = 1
/** 结构指纹量化网格（px）：cluster 中心与尺寸量化后排序，±2 px 抖动落在同一格。 */
export const CU_TARGET_TABLE_STRUCT_GRID_PX = 8
/** 结构指纹允许的像素抖动：只作口径登记，算法上靠 CU_TARGET_TABLE_STRUCT_GRID_PX 吸收。 */
export const CU_TARGET_TABLE_JITTER_PX = 2
/** 预览 1792×963 → 帧 1920×1032 的换算常数（≈1.0714 / 1.0717）：全仓只此一处，别处不许另算一套。 */
export const CU_TARGET_TABLE_PREVIEW_SCALE = Object.freeze({ x: 1920 / 1792, y: 1032 / 963 })
/** 做完就作废旧表的动作清单（G2 的「重排」与 G22/G24 的失效条件共用这一份）。 */
export const CU_TARGET_TABLE_INVALIDATING_ACTIONS: readonly string[] = Object.freeze([
  'scroll', 'dialog', 'navigate', 'tab-switch', 'window-move', 'window-resize', 'dpi-change',
])

/**
 * 目标表机制是否开启。默认开；`DSH_CU_TARGET_TABLE=0/false/no/off/disable/disabled` 关。
 * @param env - 环境变量表（测试可注入；默认 process.env）。
 * @returns 是否启用目标表。
 */
export function targetTableEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env?.[CU_TARGET_TABLE_ENV]
  if (raw === undefined || raw === null || String(raw).trim() === '') return CU_TARGET_TABLE_DEFAULT_ENABLED
  return !/^(0|false|no|off|disable|disabled)$/i.test(String(raw).trim())
}

/**
 * 一条坐标门：条件（可机械求值的谓词）+ 命中后必须做的动作。
 *
 * 门表就是策略正文的唯一来源（正文由本表渲染，回归按表断言），这样「门」是数据而不是
 * 散文：加门必须补一条谓词，删门会直接掉出正文，正文与门表不会悄悄漂移。谓词只用
 * ∈ / ∉ / ≠ / ≥ / = 与显式集合，模型与回归都能按字面判定。
 */
export type CuCoordinateGate = {
  /** 门号，正文与回归都按它认门（G1…G12、G14…G24；G13 是空号，见下表注释）。 */
  id: string
  /** 门名（正文方括号里的第二段）。 */
  axis: string
  /** 判定条件：成立即命中，不准写成「尽量/建议」。 */
  when: string
  /** 命中后的动作：祈使句，做完才算合规。 */
  then: string
}

/**
 * 坐标门表（2026-11-28 机制化 / 2026-11-29 追加 G16…G20 / 2026-11-29 追加 G21…G24 目标表）。
 * 顺序即正文顺序：帧 / 重排 / 阶梯 / 锚点 / 合并 / 预算 / 黑名单 / 偏移 / 语义 / 参数 / 等待 / 存储 /
 * 测量独立性 / 出口优先 / 弹层枚举 / 落盘核验 / 剪贴板优先 / 变灰必解状态 / 输入落点确认 /
 * 目标表命中 / 结构变即作废 / 兜底单次 / 失效条件。
 *
 * G13 是空号：新增的门按用户给定编号写成 G14/G15、G16…G20 与 G21…G24，不回填 G13，避免正文里的门号
 * 与会话记录、报告里的门号指的不是同一道门。
 *
 * 全部判据都只用「值 ∈ 集合 / 相等 / 不等 / 次数」这种机械关系，没有一条依赖主观判断；
 * 其中 G1 的 frame=、G5 的 MERGE-SPAN、G10 的参数拒收、G14 的 REGION-ECHO、G16 的按行簇、
 * G20 的 caret、G21…G24 的 table_hit/struct/coordinate_space 都由 measure.ps1 / target_table.py /
 * 工具回执在同一次输出里给出现成读数（不额外加测、不加轮次）。
 * G14 的数值门槛固定 60 px：region 任一边 ≥ 60 px 才判 REGION-ECHO（拒中心），两边都 < 60 px 的同形
 * 回显豁免（脚本打 SPAN-EQUAL tight-region (<60px): center=ACCEPT，中心与分数照旧用）。这道门槛与
 * measure_core.py / measure.ps1 / measure_legacy.ps1 里的 ECHO_MIN_SPAN_PX=60 同源，脚本不许把它做成
 * 命令行参数，门文本与脚本两边也不许各算一套；豁免只免同形这一判据，MERGE-SPAN 与簇中心照旧独立生效。
 * 门只留机械判据与出口，「脚本会打印什么补救文字」这类说明门表与脚本 usage 各说一遍即可，正文不重复。
 * G21…G24 的数字口径与常量同源：0.03s/0.17s 是 scan_frame 同帧/冷扫实测，0.2s =
 * CU_TARGET_TABLE_FALLBACK_BUDGET_MS，1.0714/1.0717 = CU_TARGET_TABLE_PREVIEW_SCALE（1920/1792、1032/963）。
 * G1…G12 逐字冻结在回归 scripts/test-coordinate-mode.mjs 的 FROZEN_GATE_LINES 里：
 * 加门只准往后追加，改旧门必须同时改冻结表并在提交说明里写清。
 */
export const CU_COORDINATE_GATES: readonly CuCoordinateGate[] = Object.freeze([
  {
    id: 'G1',
    axis: '帧',
    when: '坐标动作（click/drag/input_text/long_press）不带 frame=，或 frame≠当前 frontmost 帧，或同一 frame 内该坐标未命中≥1',
    then: '该坐标作废，同帧重测一次后再点，禁止复用旧帧坐标',
  },
  {
    id: 'G2',
    axis: '重排',
    when: '上一动作∈{改筛选,排序,滚动,开窗,换标签,展开,折叠,窗口移动,resize}',
    then: '旧坐标全部作废并重测；纯输入/纯热键/纯读不算重排，本帧坐标继续用',
  },
  {
    id: 'G3',
    axis: '阶梯',
    when: '目标∈{有加速键/Tab/Enter 路径, 有原生输入框/地址栏/名称字段/type-to-select/原生搜索, 有大 hit 原生控件}',
    then: '按该级优先做；坐标是小目标最后一级，坐标不禁用',
  },
  {
    id: 'G4',
    axis: '锚点',
    when: '目标∈容器（行/列/面板带）',
    then: '先按 y 带定位，再在带内定 x 跨度，禁止直接量整块容器',
  },
  {
    id: 'G5',
    axis: '合并',
    when: '量测输出=MERGE-SPAN REJECT，或 TOTAL bbox 覆盖候选簇≥2',
    then: '拒绝取 center 值，改用同次输出的簇中心，或 -Split <int> 取指定簇、收窄 -X0/-X1/-Y0/-Y1 拆区',
  },
  {
    id: 'G6',
    axis: '预算',
    when: '同一目标跨帧未命中=2',
    then: '换定位方式（G3 上一级或键盘路径），禁止第 3 次同坐标',
  },
  {
    id: 'G7',
    axis: '黑名单',
    when: '候选∈{harness caret 读数, hover 预览卡片, 浮层气泡, 放大镜/图标浮层}',
    then: '不进入坐标候选',
  },
  {
    id: 'G8',
    axis: '偏移',
    when: '回执=物理像素，要换算回截图坐标',
    then: '按 <frontmost_app> 查窗口偏移表；无表项一律不减（全局减是反效果）',
  },
  {
    id: 'G9',
    axis: '语义',
    when: '导航型动作后，观察包 <frontmost_app>/<frontmost_window>/<frontmost_folder> ≠ 期望实体名',
    then: '换帧重算，禁止继续在本帧下结论',
  },
  {
    id: 'G10',
    axis: '参数',
    when: 'count∉{1,2}，或 scroll_level∉1..10，或缺 screen_index/position，或正文含工具标签片段',
    then: '拒收并立即报出字段名',
  },
  {
    id: 'G11',
    axis: '等待',
    when: '默认不等待；仅当最新帧∈{loader/spinner/进度条/尚未出现的控件} 且目标=本次要继续操作对象',
    then: '仅 wait 1s，最多连开 3 次（上限 3s）；long_wait∈{10,30,60,120} 全禁；bash sleep/pwsh 等待全禁；回执截图=最新帧，换帧重取，不加 screenshot',
  },
  {
    id: 'G12',
    axis: '存储',
    when: '动作=判断界面状态',
    then: '只读界面；app 私有存储（书签 JSON/设置文件/注册表）不作 UI 真值',
  },
  {
    id: 'G14',
    axis: '测量独立性',
    when: '本次测量输出的 TOTAL bbox 的 x 跨度 = region 的 x 跨度 且 y 跨度 = region 的 y 跨度（同形回显），且 region 宽或高任一边 ≥ 60 px',
    then: '禁止取该中心：收窄 -X0/-X1/-Y0/-Y1 或加 -Split <int> 重测一次，只用元素/簇 bbox 定中心，比对 region 不算命中；静态 chrome∈{标题栏,菜单文字,地址栏,标签} 不测；只在该行出现时重测一次，不逐目标预检；region 两边都 < 60 px（手工窄区）时 span 相等不判 REGION-ECHO，打 SPAN-EQUAL tight-region (<60px): center=ACCEPT 就照常用该中心与分数；只豁免同形回显这一判据，MERGE-SPAN（簇间隙 ≥ -MergeGap）与簇中心照旧独立生效',
  },
  {
    id: 'G15',
    axis: '出口优先',
    when: '任务∈{读内容：网页/回答/文档/表格/日志/终端输出, 发送类动作：发送/确认/地址栏/重命名} 且该应用存在原生出口∈{复制钮,导出,下载,剪贴板,已有文件,命令读取}',
    then: '先用原生出口取内容，取不到才逐屏滚动 OCR；发送类动作先走键盘等效∈{Enter,Ctrl+Enter,Tab,加速键,原生输入框}，再退到点控件；出口不存在时照旧走坐标，GUI 不禁用',
  },
  {
    id: 'G16',
    axis: '弹层枚举',
    when: '帧∈{右键菜单,下拉,对话框,tooltip 浮层}',
    then: '同一次 -Split 按行列出簇、按该簇中心点击；禁止用上一行 y 推算下一行坐标；命中失败按 G6 换路',
  },
  {
    id: 'G17',
    axis: '落盘核验',
    when: '刚做过∈{下载,导出,另存,打印成文件}',
    then: '立刻 1 条 Get-ChildItem 查目标目录最新文件 mtime 与字节数；无新文件=该 UI 出口失效，改走剪贴板；禁止再点同一图标',
  },
  {
    id: 'G18',
    axis: '剪贴板优先',
    when: '任务∈{交付位图,取出位图}',
    then: '先走应用内「复制为图像/复制为PNG」＋剪贴板落盘＋自动去边框；截图裁剪只作最后兜底（剪贴板给确定尺寸，不受截图分辨率上限约束）',
  },
  {
    id: 'G19',
    axis: '变灰必解状态',
    when: '原生命令/菜单项∈{变灰,不可用}',
    then: '先解 gating∈{锁定,未选中,分组,图层隐藏,只读,模态窗未关}，再回同菜单同行重试；禁止判定该功能不存在',
  },
  {
    id: 'G20',
    axis: '输入落点确认',
    when: 'input_text 焦点点击∈{画布,文本编辑器,表格,文档区}',
    then: '先量该字段 bbox 且回执帧见 caret；无 caret=撤销一次（Ctrl+Z）并复验对象状态；禁止把 URL/正文打进编辑区',
  },
  {
    id: 'G21',
    axis: '目标表命中',
    when: '当前帧结构指纹 = 表内 structural_hash，且 coordinate_space = 表内 coordinate_space，且目标名字 ∈ 表内 elements',
    then: '按表内该名字的 center 物理像素直接点，零测量、零等待、零新增调用，一击命中后本帧不再补扫',
  },
  {
    id: 'G22',
    axis: '结构变即作废',
    when: '帧尺寸 ≠ 表内帧尺寸，或结构指纹 ≠ 表内 structural_hash，或上一动作 ∈ {滚动,弹窗开关,跳页,换标签,窗口移动,窗口缩放}',
    then: '整份旧表作废并重扫 1 次，新表建好前禁止用旧坐标点',
  },
  {
    id: 'G23',
    axis: '兜底单次',
    when: '表文件不存在，或 hit --name 命中 = 0（未命中）',
    then: '同帧就地补扫 1 次（同帧约 0.03s、冷扫约 0.17s），扫到即点；扫不到报「定位不到」继续走，不等待、不循环、单次封顶 0.2s，同一目标最多重试 1 次再按 G6 换路；scan 失败放行（按原坐标点并告警）',
  },
  {
    id: 'G24',
    axis: '失效条件',
    when: '帧 ∈ {滚动后,弹窗开关,跳页,切换标签,窗口移动,窗口缩放,DPI 变化,coordinate_space 变化（1792×963 预览 vs 1920×1032 帧）}',
    then: '旧表立即作废并重扫 1 次；换算常数保留 1920/1792≈1.0714、1032/963≈1.0717，预览坐标必乘回 1920×1032 帧坐标后再点',
  },
])

/**
 * 门表渲染成的一行正文；回归按这个格式逐条解析（条件/动作两段都必须在）。
 * @param gate - 门表里的一项。
 * @returns `[G1 帧] 条件：… → 动作：…`。
 */
export function cuCoordinateGateLine(gate: CuCoordinateGate): string {
  return `[${gate.id} ${gate.axis}] 条件：${gate.when} → 动作：${gate.then}`
}

/**
 * 「目标表 + 先量后点 + 坐标门」规则正文（发给 CU 模型的原文）。
 *
 * 正文顺序：门表 → 目标表协议（扫 1 次 / 查表零测量 / 失效 / 兜底 / 换算）→ 量测协议（表不可用时）
 * → 算式 → 落点核对。门表是数据，协议只保留脚本参数与算式这类必须逐字给模型的东西。
 *
 * 2026-11-29 修掉的历史缺口：旧正文只写 measure.ps1、一个字都没提 scan_frame.ps1，于是 CU 会话据此
 * 退回「逐目标目测」，全帧扫描器等于没用上。现在扫/查/失效/兜底四步逐条写在正文里。
 * @param measurePath - 本机量坐标脚本绝对路径（默认按 DSH_HOME 派生）。
 * @param scanPath - 全帧扫描器绝对路径（scan_frame.ps1）。
 * @param tableScript - 目标表包装器绝对路径（target_table.py）。
 * @param targetTable - 目标表机制是否开启（默认读 DSH_CU_TARGET_TABLE，缺省开）。
 * @param tableDir - 目标表落盘目录。
 * @returns 规则文本；非空串，长度上限由回归断言看着。
 */
export function computerUseCoordinatePolicyText(
  measurePath = cuMeasureScriptPath(),
  scanPath = cuScanFrameScriptPath(),
  tableScript = cuTargetTableScriptPath(),
  targetTable = targetTableEnabled(),
  tableDir = cuTargetTableDir(),
): string {
  const tableLines = targetTable
    ? [
        `0. 目标表（坐标缓存，默认开；${CU_TARGET_TABLE_ENV}=0 一键关掉，回退第 6 步逐目标量测）：`,
        `1. 扫（进新页面/结构变/表未命中才扫，1 次扫全帧）：跑 python ${tableScript} scan --shot <本帧路径> --action <scroll|dialog|navigate|tab-switch|window-move|window-resize|dpi-change>；输出带名字的元素行（name/role/center）与 table=<json>，表落在 ${tableDir}。扫描器是 ${scanPath}，必须显式传 -Shot <当前帧>，禁止省略（省略会静默取最新附件，取错帧）。`,
        '2. 查（结构没变就零测量）：按元素名字取表内 center 物理像素直接点，零测量、零等待、零新增调用，一击命中；补查单个元素跑同一脚本 hit --name <名字>。',
        '3. 作废（结构一变旧表立刻废）：滚动、弹窗开关、跳页、切标签、窗口移动缩放、DPI 变之后重跑第 1 步（带 --action）；结构没变表继续用，变了自动重建，绝不用旧坐标。',
        '4. 兜底（单次封顶 0.2s）：表不存在或未命中就地补扫 1 次（同帧约 0.03s、冷扫约 0.17s），扫到即点；扫不到报「定位不到」继续走，不等待、不循环，同一目标最多重试 1 次再按 G6 换路；scan 失败放行（按原坐标点并告警）。',
        '5. 换算（预览必乘回帧）：1792×963 预览 vs 1920×1032 帧，乘 1920/1792≈1.0714、1032/963≈1.0717；coordinate_space 与当前帧不等即作废。',
      ]
    : [
        `0. 目标表已关闭（${CU_TARGET_TABLE_ENV}=0）：不扫 scan_frame、不查表、不落盘，全部按下面第 6 步逐目标量测；G21…G24 停用。`,
      ]
  return [
    'CU 坐标门（条件成立即照 → 做，不是建议）：',
    ...CU_COORDINATE_GATES.map(cuCoordinateGateLine),
    '',
    '先量后点（查表优先；每帧最多 1 次扫描/量测，不加轮次）：',
    ...tableLines,
    `6. 量：跑 ${measurePath} -Shot <path>（省略=自动取最新观察帧） -X0 <int> -X1 <int> -Y0 <int> -Y1 <int> -Mode dark|blue|yellow|gray -Split <int> -MinPixels <int>；一次量多区用 -Regions "<x0,x1,y0,y1>;…"（同帧同一次调用，共用同一 -Mode 与阈值）；读 frame= / TOTAL bbox / center=(x,y) fraction=[x,y]；打印的 image: WxH 必须等于本帧 attached_size；不要再复制截图。`,
    '7. 算：包围盒 → center=((x1+x2)/2,(y1+y2)/2)；分数 = 中心像素 ÷ 截图宽或高 × 1000（像素会话直接传中心像素）。',
    '8. 点：正文先写 frame=<量测打印值>，再发坐标动作。',
    '9. 核：click 回执 Pointer landed at [x, y] physical pixels 必须落进包围盒；drag / long_press / input_text 没这句就按回执截图重新量包围盒；chrome 帧不减（1920×1032 同帧），harness 窗口帧减 x319 / y106。',
  ].join('\n')
}

/** 会话日志里有没有内嵌 computer-use 盖过的坐标模式戳（有 ⇒ 这条会话是 CU）。 */
function hasCoordinateModeStamp(session: any): boolean {
  try {
    const events = session?.snapshotEvents?.()
    if (!Array.isArray(events)) return false
    return events.some((event: any) => COORDINATE_MODE_EVENT_TYPES.includes(String(event?.type ?? '')))
  } catch {
    return false
  }
}

/**
 * 当前是不是一条 Computer Use 会话。
 *
 * 判据 = 会话 agent 预设 === 'computer-use'，读法与 src/assistant-cu-watch.ts:616-634 的
 * sessionPresetOf 同一套（宿主投影优先，header 兜底），所以新建会话（预设刚被宿主写下）
 * 和续接会话（预设早已在 header / 投影里）都认得；再加一条兜底：内嵌 computer-use 只给
 * CU 会话盖坐标模式戳（vendor/computer-use/index.js:379-405），日志里有戳也算 CU。
 * 标准会话（standard / standard-slim-local / 空预设）在这里一律判假，一段字都不多。
 * @param ctx - dsh-assistant 宿主上下文。
 * @param session - 这次装配所属的会话（context.agent.session）。
 * @returns 是否 CU 会话。
 */
export function isComputerUseSessionOf(ctx: any, session: any): boolean {
  for (const value of [
    (() => { try { return ctx?.get?.('sessionProjections')?.cachedSnapshot?.(session)?.values?.agentPreset } catch { return undefined } })(),
    (() => { try { return ctx?.get?.('sessionProjections')?.stateOf?.(session, 'agentPreset') } catch { return undefined } })(),
    (() => { try { return ctx?.get?.('sessionProjectionCache')?.cachedSnapshot?.(session?.header ?? session)?.values?.agentPreset } catch { return undefined } })(),
    session?.header?.agentPreset,
  ]) {
    if (typeof value === 'string' && value !== '') return value === CU_AGENT_PRESET
  }
  return hasCoordinateModeStamp(session)
}

/**
 * 把「先量后点」硬规则挂到 CU 会话的系统提示上（插件侧唯一的合法通道：
 * 宿主 SystemPrompt.section，见 @deepseek-ai/dsh-system-prompt 的 PromptSection 定义——
 * `text` 可以是每次装配现算的函数，装配前宿主就把它解析成 AssembledSection）。
 *
 * 覆盖新建与续接两条路：段位文本是**每次装配**现算的（不是会话创建时一次性拼死的），
 * 判据用会话预设，所以下面这两类会话都会带上这段规则。
 *
 * 兜底一层：宿主全局段注册拿不到 systemPrompt 服务时（插件 entry 的 inject 没声明它），
 * 靠瀑布监听器就地往装配载荷的 sections 里补同一条段——同一个名字，认到已经在就不重复加。
 * @param ctx - dsh-assistant 宿主上下文。
 * @param disposers - 插件卸载时要一起摘掉的清理函数。
 */
function installComputerUseCoordinatePolicy(ctx: any, disposers: Array<() => void>): void {
  // 脚本/目录路径按宿主真实 profile 目录派生一次（每次装配重算没必要，路径是机器静态事实）。
  const pathOf = (derive: (ctx?: any) => string): string => {
    try {
      return derive(ctx)
    } catch {
      return ''
    }
  }
  const measurePath = pathOf(cuMeasureScriptPath)
  const scanPath = pathOf(cuScanFrameScriptPath)
  const tableScript = pathOf(cuTargetTableScriptPath)
  const tableDir = pathOf(cuTargetTableDir)
  // 开关每次装配现读环境变量：设 DSH_CU_TARGET_TABLE=0 后下一轮就停用，不用重启宿主。
  const policyText = (): string => computerUseCoordinatePolicyText(
    measurePath || undefined,
    scanPath || undefined,
    tableScript || undefined,
    targetTableEnabled(),
    tableDir || undefined,
  )
  if (typeof ctx?.on === 'function') {
    const hook = async (assembly: any, context: any, next: () => Promise<any>): Promise<any> => {
      const inner = await next()
      try {
        if (!isComputerUseSessionOf(ctx, context?.agent?.session)) return inner
        const sections = Array.isArray(inner?.sections) ? inner.sections : []
        if (sections.some((section: any) => section?.name === CU_POLICY_SECTION_NAME)) return inner
        const appended = {
          name: CU_POLICY_SECTION_NAME,
          text: policyText(),
          interpolate: false,
        }
        return { ...inner, sections: [...sections, appended] }
      } catch {
        return inner
      }
    }
    try {
      const off = ctx.on('system-prompt/assemble', hook)
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      try { ctx.logger?.('dsh-assistant')?.error?.('cu coordinate policy waterfall failed: %s', String(err)) } catch {}
    }
  }

  let systemPrompt: any
  try {
    systemPrompt = (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined) ?? ctx?.systemPrompt
  } catch {
    systemPrompt = undefined
  }
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
  try {
    const off = systemPrompt.section({
      name: CU_POLICY_SECTION_NAME,
      order: CU_POLICY_SECTION_ORDER,
      text: (context: any) => (
        isComputerUseSessionOf(ctx, context?.agent?.session)
          ? policyText()
          : ''
      ),
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('cu coordinate policy section failed: %s', String(err)) } catch {}
  }
}

/**
 * 给宿主 `system-prompt/assemble` 的载荷补上 `tools`。
 *
 * 2026-11-28 根因（新建 Computer Use 会话首轮必挂
 * `Cannot read properties of undefined (reading 'map')`）：
 * 内嵌 computer-use 的像素模式钩子 `system-prompt/assemble`
 * （vendor/computer-use/index.js:1224-1232）读 `nextAssembly.tools` 再
 * `tools.map(rewritePixelTool)`（同文件 :329），但本宿主 dsh-system-prompt 的瀑布载荷
 * `PromptPresentation` 只带 sections / contexts / variables（见
 * dsh/docs/subsystems/system-prompt.md：tool declarations remain provider-owned），
 * `tools` 由 `assemble()` 在瀑布返回之后才挂上去。
 * 于是：
 *   - 进程内新建的空白 CU 会话 → `agent/created` 时盖成 pixel 戳 → 钩子走 `tools.map` → undefined.map；
 *   - 从磁盘恢复的老会话 → 日志里已有 `session/end-seed`，vendor 的 `stampCoordinateMode`
 *     直接早退、不盖戳 → `coordinateModeOf` 回落 millifraction → 钩子早退 → 不炸。
 * 这正是「新建的 CU 会话跑回合必失败、旧会话照常」的分界。
 *
 * vendor 不许改，所以在自己的注册点把缺的字段补上：本插件的 apply 早于任何 agent 的预设
 * 插件实例化，因此这个监听器排在 vendor 之外层（cordis waterfall 按注册顺序最外层先跑），
 * 载荷对象沿瀑布按同一性传递（dsh-working-directory 也是就地改 contexts），内层读得到。
 * @param ctx - dsh-assistant 宿主上下文。
 * @param disposers - 插件卸载时要一起摘掉的清理函数。
 */
function installAssembleToolsPayload(ctx: any, disposers: Array<() => void>): void {
  if (typeof ctx?.on !== 'function') return
  const hook = async (assembly: any, context: any, next: () => Promise<any>): Promise<any> => {
    if (assembly && typeof assembly === 'object' && assembly.tools === undefined) {
      let tools: unknown[] = []
      try {
        const registry = (typeof ctx?.get === 'function' ? ctx.get('tools') : undefined) ?? ctx?.tools
        const schemas = registry?.schemas?.(context?.scope, context?.toolSet)
        if (Array.isArray(schemas)) tools = schemas
      } catch { /* 注册表读不到就给空数组：像素模式只要求 tools 可迭代 */ }
      try { assembly.tools = tools } catch { /* 载荷只读就交给内层，别在这里炸 */ }
    }
    return next()
  }
  try {
    const off = ctx.on('system-prompt/assemble', hook)
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('assemble tools payload patch failed: %s', String(err)) } catch {}
  }
}

/**
 * 注册坐标模式设置：服务 + HTTP 路由。返回卸载函数（cordis 服务与路由随插件卸载）。
 * @param ctx - dsh-assistant 宿主上下文（需要 webServer 才能挂路由）。
 */
export function registerCoordinateMode(ctx: any): () => void {
  const file = join(profileDir(ctx), SETTINGS_FILE)
  let enabled = readMillifraction(file)

  const currentMode = (): CoordinateMode => (enabled ? 'millifraction' : 'pixel')

  const setEnabled = async (next: boolean): Promise<void> => {
    const previous = enabled
    enabled = next
    try {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ enabled: next }, null, 2) + '\n', 'utf8')
      await rename(tmp, file)
    } catch (err) {
      enabled = previous
      try { ctx.logger?.('dsh-assistant')?.error?.('save coordinate mode failed: %s', String(err)) } catch {}
      throw err
    }
  }

  const service = {
    currentMode,
    millifractionEnabled: (): boolean => enabled,
    setMillifractionEnabled: setEnabled,
  }

  const disposers: Array<() => void> = []
  // 先补宿主 assemble 载荷缺的 `tools`（内嵌 computer-use 的像素模式钩子要求它存在）。
  installAssembleToolsPayload(ctx, disposers)
  // 「先量后点」硬规则：只往 Computer Use 会话的系统提示注入（新建与续接都覆盖）。
  installComputerUseCoordinatePolicy(ctx, disposers)
  const routes = manageWebRoutes(ctx.webServer)
  disposers.push(routes.dispose)
  // 服务名专用，避免和 dsh-orb 的 orbCoordinateMode 撞名；内嵌 computer-use 优先读它。
  try {
    if (ctx?.get?.('assistantCoordinateMode') === undefined && typeof ctx?.provide === 'function') {
      const dispose = ctx.provide('assistantCoordinateMode', service)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('provide assistantCoordinateMode failed: %s', String(err)) } catch {}
  }

  try {
    routes.webServer.register({
      kind: 'exact',
      path: COORDINATE_MODE_ROUTE,
      handler: async (req: any, res: any) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        try {
          if (method === 'GET' || method === 'HEAD') {
            sendJson(res, 200, {
              ok: true,
              enabled,
              mode: currentMode(),
              defaultEnabled: defaultMillifraction(),
            })
            return
          }
          if (method === 'POST' || method === 'PUT') {
            const body = await readBody(req)
            if (!body || typeof body.enabled !== 'boolean') {
              sendJson(res, 400, { ok: false, error: 'invalid-enabled' })
              return
            }
            await setEnabled(body.enabled)
            sendJson(res, 200, {
              ok: true,
              enabled,
              mode: currentMode(),
              defaultEnabled: defaultMillifraction(),
            })
            return
          }
          res.writeHead(405, { allow: 'GET, HEAD, POST, PUT' })
          res.end()
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) })
        }
      },
    })
  } catch (err) {
    try { ctx.logger?.('dsh-assistant')?.error?.('register coordinate mode route failed: %s', String(err)) } catch {}
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}
