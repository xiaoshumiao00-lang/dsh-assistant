/**
 * dsh-worktable 模板引擎 —— 数据层（MVP）
 *
 * 模板 = 完成一项固定工作的固定流程定义（纯数据，不包含执行逻辑）。
 * - 内置模板为常量（BUILTIN_TEMPLATES）；后续「模板库」可编辑/导入/导出，执行逻辑不变。
 * - 移植友好：模板是数据不是代码；新增模板不改任何接线文件。
 */
import { skillFileOf } from './assistant-config.ts'

export type TemplateStepDef = {
  /** 步骤 id（语义稳定，勿与序号混淆） */
  id: string
  /** 步骤名（中文，UI 展示） */
  title: string
  /** 步骤小图标（emoji） */
  icon: string
  /** 归档子目录名（相对项目文件夹；产物都写这里，如 '01-选题调研'） */
  dir: string
  /** 交付物说明（中文；执行消息正文） */
  deliverable: string
  /** 建议技能（DSH 已装技能名；可空。运行时用户可在面板覆盖） */
  skill?: string
  /** 补充说明（可空；运行时用户可在面板覆盖） */
  instruction?: string
  /** 本步「初始信息」默认提示词（针对性预填：开工前用户必须按本项目确认/修改并保存，
   *  保存稿存于 FlowRunState.stepBriefs；未确认时「开始此步」被拦住）。收敛步不用（走「📝 任务定义」）。 */
  briefDefault?: string
  /** 步内分块：逐块交付、逐块独立验收；空/缺省 = 整步一次交付（无验收环） */
  blocks?: TemplateBlockDef[]
}

/** 步内分块定义：交付→独立验收→修改 的最小循环单元 */
export type TemplateBlockDef = {
  /** 块 id（用于交付标记文件名，勿含空格/斜杠） */
  id: string
  /** 块名（中文展示） */
  title: string
  /** 本块交付物说明 */
  deliverable: string
  /** 本块固定产物文件名（命名规范：<步号>-<语义>.<ext>；`<...>` 为占位符、`*` 为通配）。
   *  用途：任务卡 / 流程总览 / 验收员三方共用同一份文件名约定，杜绝 AI 自创文件名。 */
  files?: string[]
  /** 本块专属技能（可空；与步骤级技能一起加载）。例：定稿 docx 块 = docx-redline */
  skill?: string
  /** 本块需要加载的**多个**技能（与 skill 合并去重）。例：定稿 docx 块 = ['mathtype']（公式改动） */
  skills?: string[]
  /** 通用验收清单（L1 层）：逐条可判定 PASS/FAIL，跨题目适用 */
  acceptance: string[]
  /** true = 重复块（如逐图/逐章）：同一验收清单对多轮交付逐轮验收，直到工人写 _完成_<id>.md */
  repeatable?: boolean
  /** true = 本块**免验收**：工人覆写交付标记后直接进入下一块，不派验收员（2026-10-28 用户要求整模板免验收） */
  noVerify?: boolean
  /** 迭代收敛配置：存在时本块走「工人+裁判」双 Agent 收敛环（而非一轮验收）。
   *  工人产出 → 裁判独立上下文 JSON 评分 → 仅当新分>旧分才采纳，否则回退保留最佳版本 →
   *  循环至达标 / 达轮次上限 / 连续 plateau 轮无改进。 */
  converge?: ConvergeConfig
}

/** 迭代收敛参数（纯数据；目标分数可在面板覆盖，运行时可改） */
export type ConvergeConfig = {
  /** 达标分数（总分 >= target 即收敛）；默认 93 */
  target: number
  /** 最大收敛轮次（硬上限；到顶强制收尾，取当前最佳版本） */
  maxRounds: number
  /** 连续无改进轮数达到此值即判定平台期收敛（回退到最佳版本收尾） */
  plateau: number
}

/** 质量基线文件（工人共用度量衡；L2 项目叠加层见项目根 _项目验收叠加.md）
 *  2026-10-28：dsh-worktable 已退役，基线改由独立技能 paper-10step 提供（以后只维护那份）。
 *  2026-10-30（商业化 P0-1）：技能文件路径改成运行时解析——仓库里不再有
 *  `C:\Users\<用户名>\.dsh\skills\...` 这类本机绝对路径。根目录来自本机配置
 *  （`~/.dsh/assistant/config.json` → skillRoot），没有配置时用通用回落 `~/.dsh/skills`。 */
export const PAPER_SKILL = 'paper-10step'
export const OVERLAY_FILE = '_项目验收叠加.md'

/** 技能根 + 相对路径 → 本机可读路径（Windows 与 POSIX 分隔符按根目录风格走）。 */
export function paperPath(...parts: string[]): string {
  return skillFileOf([PAPER_SKILL, ...parts].join('/'))
}

export function baselinePersonalPath(): string {
  return paperPath('references', '01-个人写作基准.md')
}
export function baselineFiguresPath(): string {
  return paperPath('references', '03-出版级图表自纠清单.md')
}
export function l1ChecklistPath(): string {
  return paperPath('references', '02-十步自纠清单.md')
}
/** 技能 scripts/ 目录（mdplan / verify_docx / redline_selfcheck / count_words / prose_lint） */
export function paperScriptsDir(): string {
  return paperPath('scripts')
}

/** 解析 02-十步验收标准.md，返回每个步骤的条目数组（key = 步骤 id，如 'polish'）。
 *  文件格式：## 第 N 步 · 步骤标题 ... 之后连续的 - [ ] 条目直到下一个 ## 或文件结束。
 *  支持 **块 xN** 小节标题（同一步骤内分块），解析时把块标题也保留在条目前缀中。
 *  步骤 id 通过标题匹配（如「全文文字优化」→ polish）。 */
export function parseL1Checklist(content: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const lines = content.split(/\r?\n/)
  let curKey: string | null = null
  let curBlock: string | null = null
  const titleToId = (title: string): string | null => {
    const t = title.toLowerCase()
    if (t.includes('选题')) return 'topic'
    if (t.includes('文献') || t.includes('研究')) return 'research'
    if (t.includes('创新') || t.includes('定位')) return 'innovation'
    if (t.includes('框架') || t.includes('大纲')) return 'framework'
    if (t.includes('数据') || t.includes('计算')) return 'data'
    if (t.includes('初稿') || t.includes('撰写')) return 'draft'
    if (t.includes('图') || t.includes('figure')) return 'figures'
    if (t.includes('文字优化') || t.includes('polish')) return 'polish'
    if (t.includes('翻译')) return 'translate'
    if (t.includes('投稿') || t.includes('format')) return 'submit'
    return null
  }
  for (const line of lines) {
    const h = line.match(/^##\s+第\s*\d+\s+步\s*[·•]\s*(.+)/)
    if (h) { curKey = titleToId(h[1].trim()); curBlock = null; continue }
    if (line.startsWith('## ')) { curKey = null; curBlock = null; continue }
    // 块标题：**块 xN ...** 或 **块 xN（...）**
    const b = line.match(/^\*\*块\s+([^\*]+)\*\*/)
    if (b) { curBlock = b[1].trim(); continue }
    if (curKey && line.startsWith('- [')) {
      const text = line.replace(/^-\s*\[[ xX]?\]\s*/, '').trim()
      if (text) {
        if (!map.has(curKey)) map.set(curKey, [])
        const prefix = curBlock ? `【${curBlock}】` : ''
        map.get(curKey)!.push(prefix + text)
      }
    }
  }
  return map
}

/* ── 过程文件命名规范（下划线开头 = 插件与验收协议用，不属于交付物；人找产物时忽略即得干净目录）──
 *   _本步要求.md            本步任务卡 + 验收清单 + 项目全貌（开工必读）
 *   _本步摘要.md            本步核心信息（工人交付完成时写，供后续步骤与项目全貌汇总）
 *   _交付_<块id>.md         交付标记（工人覆写 → 调度器据此派验收）
 *   _完成_<块id>.md         完成标记（重复块：全部对象通过后工人写）
 *   _验收_<块id>_R<轮>.md   验收报告（验收员写，末行 VERDICT: PASS/FAIL；R = 本步**累计**轮次，跨块不重置）
 * 产物文件命名规范：<步号>-<语义>.<ext>（步号=步骤目录前缀两位数字，如 02-创新点.md、06-结论.md；
 * 重复块加对象标识：07-Fig03-收敛曲线.png）。块定义里的 files 字段为唯一权威来源。 */
/** 交付标记文件名（工人覆写；调度器据它触发验收） */
export const deliveryMarkerName = (blockId: string) => `_交付_${blockId}.md`
/** 完成标记文件名（repeatable 块全部交付后工人写入） */
export const doneMarkerName = (blockId: string) => `_完成_${blockId}.md`
/** 验收报告文件名（验收员写入；末尾必须有 VERDICT: PASS / FAIL 行供调度器解析） */
export const reportName = (blockId: string, round: number) => `_验收_${blockId}_R${round}.md`
/** 取「本步累计验收轮次」（跨块不重置）：新状态用 stepRound，老状态回退到块内 round。
 *  会话标题 / 消息抬头 / 报告文件名 / 面板显示统一用它，保证轮次单调递增、不会"回到第 1 轮"。 */
export const stRoundOf = (st: { round: number; stepRound?: number } | undefined | null): number =>
  st ? Math.max(1, st.stepRound ?? st.round) : 1
/** 验收报告文件名前缀（面板扫描最新报告用） */
export const REPORT_PREFIX = '_验收_'
/* ── 迭代收敛（工人+裁判双 Agent 收敛环）过程文件命名 ──
 *   _评分_R<轮>.md        裁判评分报告（JSON 分项 + 末行 "SCORE: <总分>" 供调度器解析）
 *   _rubric.md            评分细则（第 1 轮裁判定义并冻结；后续轮次遵循；用户可在任务文档预定义）
 *   _best-<产物名>        最佳版本产物副本（调度器机械回退：采纳时 产物→_best-，回退时 _best-→产物）
 * 产物文件直接写在步骤目录（规范名）；收敛环要求产物为**文本文件**（.md/.py/.txt/.csv/.json 等），
 * 二进制产物（docx/png）不支持调度器机械复制，请用论文写作模板。 */
/** 迭代收敛：评分报告文件名（裁判写入；末尾必须有 "SCORE: <总分>" 行供调度器解析） */
export const scoreReportName = (round: number) => `_评分_R${round}.md`
/** 迭代收敛：评分报告文件名前缀（面板扫描最新评分用） */
export const SCORE_PREFIX = '_评分_'
/** 迭代收敛：评分细则文件名（第 1 轮裁判定义并冻结；后续轮次遵循） */
export const RUBRIC_FILE = '_rubric.md'
/** 迭代收敛：最佳版本产物前缀（`_best-<产物名>`；调度器机械回退用） */
export const bestName = (deliverableName: string) => `_best-${deliverableName}`
/** 命名规范说明（任务卡与流程总览共用；占位符与通配的唯一解释处） */
export const NAMING_RULE_NOTE = '文件名约定：`<...>` 为占位符（按实际对象替换），`*` 为通配（按实际格式补全，如 .py/.m/.R）。产物一律「步号-语义」开头，禁止自创文件名或加版本后缀（v2/final/新 等）。'

export type TemplateDef = {
  id: string
  name: string
  icon: string
  description: string
  /** 实例化时预选的布局预设 id（仍可改） */
  layoutPreset: string
  steps: TemplateStepDef[]
}

/* ─────────────────────────── 内建论文写作模板（2.0：内嵌验收环） ───────────────────────────
 * 文件命名规范（全模板统一，面板「📖 流程总览」可见；改名前请先看这里）：
 * - 过程文件（插件与验收协议用，不属于交付物）：`_` 开头，如 _本步要求.md / _本步摘要.md /
 *   _交付_<块id>.md / _完成_<块id>.md / _验收_<块id>_R<轮>.md。人找产物时忽略 `_` 开头的文件即可。
 * - 产物文件（AI 交付物）：`<步号>-<语义>.<ext>`，步号 = 步骤目录前缀两位数字（01~10），
 *   如 02-创新点.md / 06-结论.md。复制到任何地方都能看出属于哪一步。
 * - 重复块产物（逐图/逐章）：`<步号>-<对象标识>-<语义>.<ext>`，如 07-Fig03-收敛曲线.png。
 * - files 字段中的 `<...>` 为占位符（按实际对象替换），`*` 为通配（按实际格式补全，如 .py/.m/.R）。
 */

export const PAPER_TEMPLATE: TemplateDef = {
  id: 'paper',
  name: '论文写作模板',
  icon: '🎓',
  description: '十步固定流程（选题调研→投稿）：每步自动「交付→验收→打回修改」，全部通过才需你终审。',
  layoutPreset: '2h',
  steps: [
    {
      id: 'topic',
      title: '选题调研',
      icon: '📚',
      dir: '01-选题调研',
      deliverable: '产物：01-选题说明.md（题目、研究问题、意义与价值、2-3 个备选及取舍、期刊定位）。',
      skill: 'aca-01-research',
      instruction: '先明确研究对象与方法可行性，再定题目；文献必须真实可查（经 aca-10 核实），禁止编造。',
      briefDefault: '我的研究方向：【填写，如：基于 dPINN 的桥梁结构损伤识别】。\n工程背景与痛点：【这个方向解决什么实际问题，一句话】。\n意向方法/技术路线：【如：深度物理信息神经网络 + 模态数据】。\n可用数据/算例条件：【有什么数据、能跑什么算例】。\n文献范围：近【5】年【SCI/中文核心】，关键词【列 3-5 个】；需规避或已做烂的方向：【…】。\n目标期刊定位：【期刊名或档次】。\n请基于此评估 2-3 个候选题（创新性、可行性、数据支撑逐项打分），给出取舍建议与最终推荐题目。',
      blocks: [
        {
          id: '选题说明',
          title: '选题说明',
          deliverable: '产物：01-选题说明.md',
          files: ['01-选题说明.md'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'framework',
      title: '论文框架与创新点',
      icon: '🧭',
      dir: '02-框架与创新点',
      deliverable: '产物：02-论文框架.md、02-创新点.md（章节结构、每章要点、创新点清单）。',
      skill: 'aca-02-writing',
      instruction: '框架需落到可写的粒度；创新点要具体可验证，避免空话。',
      briefDefault: '已定题目（来自第 1 步 01-选题说明.md，可改填）：【…】。\n论文类型：【研究论文/综述/案例】；拟投稿期刊：【…】；篇幅预期：【正文约 N 字/词】。\n章节框架偏好：【如 IMRaD / 期刊惯用结构】；必须包含的章节或内容：【…】。\n创新点初步想法：【列 2-3 条，哪怕不成熟】。\n图表数量预期：图【N】张、表【N】个；有没有必须先定的统一编号体系：【…】。',
      blocks: [
        {
          id: '论文框架',
          title: '论文框架',
          deliverable: '产物：02-论文框架.md',
          files: ['02-论文框架.md'],
          acceptance: [],
        },
        {
          id: '创新点',
          title: '创新点',
          deliverable: '产物：02-创新点.md',
          files: ['02-创新点.md'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'data',
      title: '基础数据准备',
      icon: '🗄️',
      dir: '03-基础数据',
      deliverable: '产物：03-数据说明.md、03-清洗脚本.*，原始数据与清洗后数据分目录存放。',
      instruction: '注明每个字段含义与单位，保证后续步骤可复现。',
      briefDefault: '原始数据/资料位置：【项目根或本目录，写明文件/文件夹名】。\n数据来源与采集方式：【如：ERA5 再分析 / 试验实测 / 仿真输出】。\n关键字段/变量含义与单位：【逐个列出】。\n已知数据质量问题（缺失、异常、口径不一致）：【…】。\n清洗要求：【去重、插值、单位统一、异常值规则…】。\n后续计算要用的软件与环境：【如 Python 3.11 + PyTorch，本地或集群路径】。',
      blocks: [
        {
          id: '数据说明',
          title: '数据说明',
          deliverable: '产物：03-数据说明.md（每个文件/字段的含义、单位、来源、采集方式）',
          files: ['03-数据说明.md'],
          acceptance: [],
        },
        {
          id: '清洗脚本',
          title: '清洗脚本',
          deliverable: '产物：03-清洗脚本.*（+ 运行说明），可一键复现清洗后数据',
          files: ['03-清洗脚本.*'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'expected',
      title: '预期结果清单',
      icon: '🎯',
      dir: '04-预期结果清单',
      deliverable: '产物：04-预期结果清单.md（后续将产出哪些图、表）。此产物即第 5 步计算结果的验收标准。',
      instruction: '图表编号与最终论文图表编号保持一致，方便核心章节直接引用。',
      briefDefault: '计算/实验将产出的核心结果：【逐个列出，如：温度场预测 RMSE 对比曲线、参数敏感性分析】。\n图表数量预期：图【N】张、表【N】个。\n必须出现的对比/消融/验证：【如：与实测对比、与 XGBoost 基线对比、消融实验】。\n图表编号体系：【Fig.1… / 图1…】；编号与论文章节的对应偏好：【…】。\n目标期刊图表风格：【如：出版级矢量图、相似相近色、colorbar 左图例右】。',
      blocks: [
        {
          id: '预期结果清单',
          title: '预期结果清单',
          deliverable: '产物：04-预期结果清单.md',
          files: ['04-预期结果清单.md'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'compute',
      title: '计算结果',
      icon: '⚙️',
      dir: '05-计算结果',
      deliverable: '产物：05-结果图/、05-结果表.md、05-计算说明.md（核心图表 + 数据文件 + 计算过程说明）。',
      instruction: '结果文件与生成脚本放本目录；图表能与预期结果清单逐项对上。',
      briefDefault: '计算方法/模型：【如：CEBM 二维瞬态温度场模型 + XGBoost 降尺度】。\n软件与版本：【如：Python 3.11 + PyTorch 2.x + MATLAB R2024】；运行环境：【本地/集群，路径与资源配置】。\n关键参数设置：【网格、时间步、超参数、随机种子…逐个列出】。\n算例/工况清单：【如：郑万梅溪河 340m 提篮拱，只用跨中三室箱梁截面】。\n结果精度/验证指标目标：【如：RMSE < 1.5 ℃】；对比基线：【…】。\n可复现要求：【全部脚本 + 数据随结果一并归档，注明运行顺序】。',
      blocks: [
        {
          id: '结果图',
          title: '结果图',
          deliverable: '产物：05-结果图/05-Fig<NN>-<简称>.png + 同名数据 .csv',
          files: ['05-结果图/05-Fig<NN>-<简称>.png', '05-结果图/05-Fig<NN>-<简称>.csv'],
          acceptance: [],
        },
        {
          id: '结果表',
          title: '结果表',
          deliverable: '产物：05-结果表.md（全部结果表 + 对应数据文件）',
          files: ['05-结果表.md'],
          acceptance: [],
        },
        {
          id: '计算说明',
          title: '计算说明',
          deliverable: '产物：05-计算说明.md + 计算脚本（归档于 05-计算脚本/）',
          files: ['05-计算说明.md', '05-计算脚本/'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'draft',
      title: '初稿撰写',
      icon: '📝',
      dir: '06-初稿撰写',
      deliverable: '按第 2 步《02-论文框架.md》的实际章节逐章撰写：06-摘要.md + 06-Ch<NN>-<章名>.md（一章一个文件，不套固定章节）。',
      skill: 'aca-02-writing',
      instruction: '章节与顺序一律以第 2 步《02-论文框架.md》为准（框架有几章就写几个文件，不套「摘要/引言/方法/结果/结论」的固定章节）：一章一个 06-Ch<NN>-<章名>.md，章号与章名照抄框架；摘要单独 06-摘要.md。以第 5 步计算结果和第 4 步预期结果清单为基础撰写；写引言章时加载 /aca-03-introduction；全文遵守《个人写作基准》的语言与数字纪律；图表引用第 4 步统一编号。',
      briefDefault: '论文语言：【中文/英文】；目标期刊与篇幅：【期刊名，正文约 N 字/词】。\n写作体例与引用格式：【如：序号制 [N] / APA；目标期刊《作者指南》链接或文件】。\n各章特殊要求——引言：【研究背景侧重、必须交代的工程背景】；方法：【公式推导深度、符号约定】；结果与讨论：【突出哪些对比、讨论深度】；结论：【条数与写法偏好】。\n摘要字数与结构要求：【如：200-250 词，Background-Method-Result-Conclusion】。\n关键术语与符号约定：【列出必用术语表/符号表】。\n必须引用或禁止引用的文献：【…】。',
      blocks: [
        {
          id: '摘要',
          title: '摘要',
          deliverable: '产物：06-摘要.md（摘要 + 关键词）',
          files: ['06-摘要.md'],
          acceptance: [],
        },
        {
          id: '章节',
          title: '按框架逐章',
          deliverable: '产物：06-Ch<NN>-<章名>.md（章名与顺序以第 2 步 02-论文框架.md 为准，一章一个文件）',
          files: ['06-Ch<NN>-<章名>.md'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'figures',
      title: '逐图精修',
      icon: '🖼️',
      dir: '07-图精修',
      deliverable: '产物：07-Fig<NN>-<简称>.png（论文全部图精修完成，一次交付一次验收）。',
      skill: 'aca-04-visual',
      instruction: '可自己逐张修改，但【全部图改完才交付一次】：写完再把全部图一次性交出来（覆写 _交付_逐图精修.md）。本块按「全部图」整体验收，跨图一致性由验收员一次性核验，不做逐张循环。',
      briefDefault: '需精修的图清单：【Fig.1~Fig.N，逐个写清内容与原文件位置（第 5/6 步目录）】。\n绘图工具：【如：SciFigure 出版级规范 / matplotlib / Origin】。\n出版级硬性要求：【字体字号、线宽、配色（如相似相近色）、子图布局、inset、colorbar/图例位置…】。\n每张图的修改重点：【Fig.1 改…；Fig.2 改…】。\n输出格式与分辨率：【如：600 dpi PNG + PDF/EPS 矢量】。',
      blocks: [
        {
          id: '逐图精修',
          title: '逐图精修（逐张修改，一次交付）',
          deliverable: '产物：07-Fig<NN>-<简称>.png（全部图，精修最终版；中间版放 07-中间版/）',
          files: ['07-Fig<NN>-<简称>.png'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'polish',
      title: '全文文字优化',
      icon: '✍️',
      dir: '08-文字优化',
      deliverable: '产物：08-Ch<NN>-<章名>.md（全文各章优化稿）+ 08-定稿-红标.docx（在你的 Word 原稿上只改文字：排版格式一字不动、改动处红色）。',
      skill: 'aca-08-polish',
      instruction: '可自己逐章改写，但【全部章改完才交付一次】：覆写 _交付_全文优化.md 时把全部章节一起交出来。本块按「全文」整体验收——跨章一致性（术语、数字口径、图表编号）本来就是本步的职责，由验收员一次性核验。定稿 docx 一律以项目根的 Word 原稿为格式基准做原地修订（禁止重新排版生成），排版格式一字不改，改动字词红色、被替换或删除的原文保留原位并标红色删除线。'
        + '\n【本步无人值守·零打断（用户硬性要求）】第 8 步全程不许向用户提问、不许请求用户补充信息、不许等用户确认，从开工到收尾自己跑完。'
        + '\n① 禁止任何形式的询问或停顿：不得使用提问/确认类交互，不得在会话里写「请提供…」「请确认…」「你希望…吗」「是否要我…」，不得以「等你答复」为由停下（停下 = 本步失败）。'
        + '\n② 配置全部自动推断：论文类型、学科、目标期刊、引用格式、写作语言、字数上限等，一律按序读项目根《_项目验收叠加.md》→ 本目录《_本步要求.md》（内含项目全貌）→ 项目根《期刊画像》→ 既有正文的既有体例；全部读不到时才用最保守默认（完全沿用稿件原文的既有体例，不新增任何体例），并在交付标记里写明「取值 + 依据文件 + 缺失项」。'
        + '\n③ 本步只做语言与一致性优化，凡涉及取舍一律按保守规则自动裁决，不抛给用户：数字/术语/编号冲突时以「有数据来源的那一处」「与第 5 步数据文件一致的那一处」为准，其余处向它对齐；两处都无据可依时保留原样只统一行文，不做数值改动；口径无法判定时不改数值、只改表述，并记入「待用户终审」清单。'
        + '\n④ 一切自主决定（术语定名、图表编号对齐、体例统一、遗留项）只记入交付标记的「自动裁决记录」与「待用户终审」小节，随本步摘要一次性交用户终审，绝不在过程中打断。'
        + '\n⑤ 必需文件缺失时也不提问：定稿底稿缺失按「定稿docx 块」的降级规则处理，其余缺项记入遗留项并继续下一块；只有产物完全不存在才算未交付。',
      briefDefault: '优化范围与侧重点：【如：语言学术化、逻辑衔接、术语统一、前后一致性、摘要与正文数据核对】。\n必须保持不动的内容：【数据、结论、公式编号、图表编号、引用编号…】。\n字数要求：【压缩到 N 字以内 / 不限】。\n术语统一表：【如：温度场=thermal field；损伤识别=damage identification】。\n个人写作偏好与红线：【如：避免长句堆砌、数值必须带不确定度、括号只用于缩写】。\n定稿 Word 原稿位置：【项目根文件名，或说明以何者为格式基准】。',
      blocks: [
        {
          id: '全文优化',
          title: '全文优化（逐章改写，一次交付）',
          deliverable: '产物：08-Ch<NN>-<章名>.md（全部章节的优化后全文，逐章一个文件）',
          files: ['08-Ch<NN>-<章名>.md'],
          skills: ['aca-02-writing'],
          acceptance: [],
        },
        {
          id: '定稿docx',
          title: '定稿 docx（原格式 + 改动标红 + 清稿）',
          deliverable: '产物：08-定稿-红标.docx（红标留痕版）+ 08-定稿-清稿.docx（去掉红色标记的最终版）+ 08-修改清单.json',
          files: ['08-定稿-红标.docx', '08-定稿-清稿.docx', '08-修改清单.json'],
          skill: 'docx-redline',
          skills: ['mathtype'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'translate',
      title: '翻译',
      icon: '🌐',
      dir: '09-英文翻译',
      deliverable: '产物：09-英译-定稿.docx（唯一交付物：以中文原稿为底稿做英译替换，保留原排版；公式/图表/表格结构不变，正文段落替换为规范英文学术译文）。',
      skill: 'aca-02-writing',
      instruction: '按目标期刊风格（见项目根 _项目验收叠加.md 与《期刊画像》）；专业术语查证统一；图表标题与注释同步英文化。'
        + '\n【本步铁律·排版零改动】以项目根 Word 原稿（`_原稿.docx` → 项目根唯一 .docx → 项目根 `_初稿/` 内唯一 .docx → 08 目录最新版 docx）为格式基准做**原地英译替换**：段落样式、字体字号、行距缩进、对齐、编号、表格、图片、公式(OMML)、页眉页脚、页码、题注格式**一字不动**；只允许替换正文段落的文字内容为英文译文，**禁止用 pandoc 等重新生成 docx**（会丢格式）。'
        + '\n【唯一交付物】只交付 `09-英译-定稿.docx` 一份（清稿，不标红——翻译是全文重写，标红无意义）。'
        + '\n【本步无人值守·零打断】与第 8 步同口径：全程不问用户，底稿自己找，术语/句式取舍自动裁决并记入交付标记的「自动裁决记录」与「待用户终审」。',
      briefDefault: '目标语言与期刊：【如：英语（Engineering Structures）】。\n术语英译约定：【如：温度场=thermal field；降尺度=downscaling；列出必译术语表】。\n句式与风格：【英式/美式拼写；主动/被动语态偏好；时态约定（方法过去时、结论现在时）】。\n图表标题与注释：【同步英文化；题注格式按期刊要求】。\n保持不译的内容：【公式、符号、专有名词、标准编号…】。\n中文定稿位置：【第 8 步 08-定稿-清稿.docx 或项目根文件】。',
      blocks: [
        {
          id: '英译定稿',
          title: '英译定稿 docx（原格式 + 唯一交付物）',
          deliverable: '产物：09-英译-定稿.docx（以中文原稿为底稿做英译替换，保留原排版）',
          files: ['09-英译-定稿.docx'],
          skill: 'docx-redline',
          skills: ['mathtype'],
          acceptance: [],
        },
      ],
    },
    {
      id: 'submit',
      title: '投稿',
      icon: '📮',
      dir: '10-投稿',
      deliverable: '产物：10-manuscript.docx、10-Figures/、10-声明.md、10-投稿清单.md、10-CoverLetter.md。',
      skill: 'aca-09-format',
      instruction: '核对投稿系统要求（格式/文件命名/作者信息）；cover letter 突出创新点与适合性。',
      briefDefault: '目标期刊/会议全称与投稿系统：【如：Engineering Structures（Editorial Manager）】。\n稿件类型与限制：【研究论文/短文；字数、图表数、参考文献数上限】。\n作者信息与单位署名：【姓名、单位、通讯作者、ORCID】。\n基金项目与编号：【如：国家自然科学基金 No. XXXXX】。\n声明类要求：【利益冲突、数据可用性、AI 使用披露（按期刊政策）】。\nCover letter 侧重点：【突出哪 2-3 个创新点、推荐/回避审稿人】。\n需准备的附加材料：【 Highlights / Graphical Abstract / 补充材料…】。',
      blocks: [
        {
          id: '稿件包',
          title: '稿件包',
          deliverable: '产物：10-manuscript.docx + 10-Figures/Fig<NN>.* + 10-声明.md',
          files: ['10-manuscript.docx', '10-Figures/Fig<NN>.*', '10-声明.md'],
          acceptance: [],
        },
        {
          id: '投稿清单',
          title: '投稿清单',
          deliverable: '产物：10-投稿清单.md、10-CoverLetter.md',
          files: ['10-投稿清单.md', '10-CoverLetter.md'],
          acceptance: [],
        },
      ],
    },
  ],
}

/* 【2026-10-28 用户硬性要求】论文写作模板**全流程免验收**：
 * 所有块置 noVerify —— 工人覆写交付标记即完成，调度器直接进入下一块，不创建验收员会话；
 * 末块交付后进「待终审」，由用户点「✓ 通过」。自纠清单仍写进 _本步要求.md 作为交付前自查依据。
 * 想恢复某一步的验收：把该步 id 加进 KEEP_VERIFY_STEPS（留空 = 全部免验收）。 */
const KEEP_VERIFY_STEPS = new Set<string>([])
for (const s of PAPER_TEMPLATE.steps) {
  if (KEEP_VERIFY_STEPS.has(s.id)) continue
  for (const b of s.blocks ?? []) b.noVerify = true
}

/* ─────────────────────────── 内建迭代收敛模板（工人+裁判双 Agent 收敛环） ───────────────────────────
 * 与论文写作模板并列的通用任务模板：单一「任务执行」步，内嵌「工人产出→裁判独立 JSON 评分→
 * 采纳/回退→循环」收敛环。任务定义来自项目全局信息（_项目全局信息.md）+ 用户硬性要求（instruction）；
 * 评分细则若用户未预定义，由裁判第 1 轮定义并冻结（_rubric.md）。
 * 产物须为文本文件（调度器机械回退按文本复制）；收敛参数 target/maxRounds/plateau 可在面板覆盖。 */
export const ITERCONVERGE_TEMPLATE: TemplateDef = {
  id: 'iterconverge',
  name: '迭代收敛',
  icon: '🔄',
  description: '工人产出→裁判独立评分→仅当新分更高才采纳、否则回退，循环迭代直至达标或达上限。',
  layoutPreset: '2h',
  steps: [
    {
      id: 'task',
      title: '任务执行',
      icon: '🎯',
      dir: '01-任务',
      deliverable: '产物：按任务定义产出的交付物（文本文件，规范命名，写入 01-任务/）。',
      instruction: '任务与标准在流程面板「📝 任务定义」里填写（未填写时不会开工）：正文写清「做什么/产出什么/约束」；如需预定义评分标准，再写一节「## 评分细则」（维度 + 权重 + 各分档标准）——裁判第 1 轮会遵循并冻结为 _rubric.md，未写则由裁判第 1 轮自行定义。',
      blocks: [
        {
          id: 'main',
          title: '迭代收敛',
          deliverable: '产物：按任务定义产出的交付物（文本文件）。每轮覆写交付物 + 覆写交付标记 _交付_main.md。',
          files: [],
          acceptance: [],
          converge: { target: 93, maxRounds: 8, plateau: 2 },
        },
      ],
    },
  ],
}

export const BUILTIN_TEMPLATES: TemplateDef[] = [PAPER_TEMPLATE, ITERCONVERGE_TEMPLATE]

/* ─────────────────────────── 流程运行状态（挂在项目上） ─────────────────────────── */

/** 迭代收敛参数覆盖（面板「⚙ 配置」可改；仅覆盖给定字段，其余沿用模板默认） */
export type ConvergeOverride = { target?: number; maxRounds?: number; plateau?: number }

/** 单步运行时用户覆盖（覆盖模板默认的技能/补充说明/收敛参数） */
export type FlowStepOverride = { skill?: string; instruction?: string; converge?: ConvergeOverride }

/** 一次模板实例（= 一个布局项目）的流程运行状态 */
export type FlowRunState = {
  templateId: string
  createdAt: number
  /** 已通过（绿标）步骤 id 集合；顺序推进：current = 有效区间内第一个不在 done 的 */
  done: string[]
  /** 每步最近一次「开始」时间戳（提示用） */
  lastStartedAt?: Record<string, number>
  /** 每步最近一次「通过」时间戳 */
  doneAt?: Record<string, number>
  /** 单步配置覆盖（项目级，优先于模板级；配置改动会同时写回模板） */
  overrides?: Record<string, FlowStepOverride>
  /** 有效起始步（0-based 步骤下标；缺省 0 = 从头开始）。之前的步骤视为跳过，无需完成 */
  startIndex?: number
  /** 每步专属会话 id（stepId → sessionId）：开始某步时在「步骤子目录」开会话并记录于此 */
  stepSessions?: Record<string, string>
  /** 每步验收环运行状态（stepId → 状态）：由 VerifyScheduler 读写；无 blocks 的步骤不进验收环 */
  verify?: Record<string, StepVerifyState>
  /** 每步「初始信息」用户确认稿（stepId → markdown）：undefined = 尚未确认（「开始此步」被拦）；
   *  空串/纯空白 = 用户显式清空（同样被拦）。非收敛步开工前必须确认各自的本步初始信息。 */
  stepBriefs?: Record<string, string>
  /** 该实例已套用的模板修订号（缺省 = 1）。模板结构变化时由 migrateFlowRun 升到 TEMPLATE_REV，
   *  保证「按索引换算」类迁移（起始步）只做一次。 */
  tplRev?: number
}

/** 单步验收环状态机（插件调度器驱动；持久化在 FlowRunState 里，刷新页面可恢复） */
export type StepVerifyState = {
  /** working=工人交付中/修改中；verifying=验收员核验中；paused=异常暂停（验收员失联/发送失败/工人会话丢失）等用户恢复；step-passed=全部块通过等用户终审 */
  phase: 'working' | 'verifying' | 'paused' | 'step-passed'
  /** 当前块下标（steps[].blocks 内） */
  blockIdx: number
  /** 当前块内已验收轮数（1-based；**每块独立计数**，用于「每块只验收 1 轮」上限判定） */
  round: number
  /** 本步累计验收轮次（1-based；**跨块不重置、只增不减**）：用于会话标题、消息抬头、报告文件名与面板显示，
   *  避免「第 2 块从头数」被误读成"进度回退/重新开始"。缺省时回退到 round（老状态兼容）。 */
  stepRound?: number
  /** 工人会话 id（快照丢失时兜底） */
  workerSid?: string
  /** 本轮验收员会话 id（每轮新建，防"被说服"） */
  verifierSid?: string
  /** repeatable 块已通过轮数（逐图/逐章计数） */
  passedCount: number
  /** 本轮验收任务派发时间（watchdog：验收员超时未交报告 → 重派，最多 3 次） */
  verifyDispatchedAt?: number
  /** 验收员重派次数（含首次派发） */
  verifyAttempts?: number
  /** 最近判定摘要（面板展示） */
  lastVerdict?: { verdict: 'PASS' | 'FAIL'; failCount: number; at: number }
  /** 开始验收时间 */
  startedAt?: number
  /** 最近一次向工人派发任务的时间（工人静默看门狗基准之一） */
  workerDispatchedAt?: number
  /** 工人会话已停且长时间无文件活动 → 疑似非正常中止（面板显示「⏯ 一键继续」） */
  stalled?: boolean
  /** 「硬超时提醒」（裁判/验收员仍运行且超硬超时）最近一次发出时间：防每 tick 重复刷屏 */
  hardStallNotifiedAt?: number
  /** 暂停原因（面板方案卡文案） */
  pauseReason?: 'verifier-gone' | 'worker-gone' | 'send-failed'
  /** 本块验收 FAIL、【改稿】指令**已成功送达**：工人覆写交付标记后**自动进入下一块**（本块不再复验）。
   *  仅在指令确实送出时置真——发送失败仍置真会让工人之后的交付被误判"已改完"而草率跳过本块。 */
  finalRevise?: boolean
  /* ── 迭代收敛环字段（仅 block.converge 存在时启用） ── */
  /** 当前最佳版本轮次（被采纳的最高分版本；第 1 轮为基线，恒采纳） */
  bestVersion?: number
  /** 当前最佳总分（bestVersion 对应分数） */
  bestScore?: number
  /** 分数轨迹：每轮 {round, score, adopted}（面板轨迹展示 + 审计） */
  scores?: { round: number; score: number; adopted: boolean }[]
  /** 连续「新分 ≤ 旧分」轮数（达到 converge.plateau 即平台期收敛） */
  noImprove?: number
  /** 收敛终止原因（step-passed 时记录：target=达标 / maxrounds=达轮次上限 / plateau=平台期） */
  convergeDone?: 'target' | 'maxrounds' | 'plateau'
  /** 用户手动停止（面板「⏹ 停止」）：调度器 tick 遇到本标记即**整体跳过**本步——
   *  不再自动派验收员/裁判、不重派、不报 stalled/硬超时提醒；在跑的工人/裁判会话已被中断。
   *  「⏯ 继续本步」（或重点「▶ 开始此步」）清除该标记后按当前阶段恢复调度。块/轮次/最佳版本进度全保留。 */
  userStopped?: boolean
}

/** 当前模板修订号：模板结构变化时 +1（3 = 每步内嵌「分块交付+独立验收」验收环；2 = 6+7 合并为 6「初稿撰写」） */
export const TEMPLATE_REV = 3

/** 模板改版后的历史步骤 id 别名（旧 id → 当前 id）。
 *  仅供读取老项目运行状态时归一，不改写模板定义。 */
export const STEP_ID_ALIASES: Record<string, string> = {
  'core-chapters': 'draft',
  'other-chapters': 'draft',
}

/** 把历史步骤 id 归一到当前模板 id（不在别名表中的 id 原样返回） */
export function canonicalStepId(id: string): string {
  return STEP_ID_ALIASES[id] ?? id
}

/** 取值：优先当前 id，其次合并前的历史 id（用于模板级覆盖的兼容读取） */
function aliasPick<T>(map: Record<string, T> | undefined, stepId: string): T | undefined {
  if (!map) return undefined
  if (map[stepId] !== undefined) return map[stepId]
  for (const [oldId, cur] of Object.entries(STEP_ID_ALIASES)) {
    if (cur === stepId && map[oldId] !== undefined) return map[oldId]
  }
  return undefined
}

/** 起始步索引在新旧模板间的换算表（v1 的 11 步 → v2 的 10 步：6+7 合并为 6） */
const LEGACY_START_INDEX_MAP = [0, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9]

/** 老实例运行状态迁移：历史步骤 id 归一到当前模板（幂等），并在首次迁移时换算起始步索引。
 *  返回同一对象 = 无需写回；返回新对象 = 调用方应持久化。 */
export function migrateFlowRun(run: FlowRunState): FlowRunState {
  const rev = typeof run.tplRev === 'number' ? run.tplRev : 1
  const mapKeys = <T>(src: Record<string, T> | undefined): { value: Record<string, T> | undefined; changed: boolean } => {
    if (!src) return { value: src, changed: false }
    let changed = false
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(src)) {
      const nk = canonicalStepId(k)
      if (nk !== k) changed = true
      if (!(nk in out)) out[nk] = v
    }
    return { value: changed ? out : src, changed }
  }

  const done: string[] = []
  for (const id of run.done) {
    const c = canonicalStepId(id)
    if (!done.includes(c)) done.push(c)
  }
  const doneChanged = done.length !== run.done.length || done.some((v, i) => v !== run.done[i])
  const doneAt = mapKeys(run.doneAt)
  const lastStartedAt = mapKeys(run.lastStartedAt)
  const overrides = mapKeys(run.overrides)
  const stepBriefs = mapKeys(run.stepBriefs)
  const needIndexMap = rev < TEMPLATE_REV && typeof run.startIndex === 'number'
  const startIndex = needIndexMap ? (LEGACY_START_INDEX_MAP[run.startIndex as number] ?? run.startIndex) : run.startIndex
  const revChanged = rev < TEMPLATE_REV
  if (!doneChanged && !doneAt.changed && !lastStartedAt.changed && !overrides.changed && !stepBriefs.changed && !needIndexMap && !revChanged) return run
  return {
    ...run,
    done,
    ...(startIndex !== run.startIndex ? { startIndex } : {}),
    ...(doneAt.changed ? { doneAt: doneAt.value } : {}),
    ...(lastStartedAt.changed ? { lastStartedAt: lastStartedAt.value } : {}),
    ...(overrides.changed ? { overrides: overrides.value } : {}),
    ...(stepBriefs.changed ? { stepBriefs: stepBriefs.value } : {}),
    tplRev: TEMPLATE_REV,
  }
}

/** 步骤面板视图（模板定义 + 运行状态合并，供 FlowPane 渲染） */
export type FlowStepView = TemplateStepDef & {
  /** done：已绿标；current：当前可执行（有效区间第一个未通过）；locked：前序未完成不可执行；
   *  skipped：在起始步之前，无需完成 */
  status: 'done' | 'current' | 'locked' | 'skipped'
  /** 生效技能（run.override ?? 模板默认 ?? ''） */
  skill: string
  /** 生效补充说明 */
  instruction: string
  /** 生效收敛参数（仅收敛步有；= 模板默认叠加本项目「⚙ 配置」覆盖）。面板据此显示/编辑。 */
  converge?: ConvergeConfig
  /** 通过时间戳（仅 done 步有） */
  doneAt?: number
  /** 验收环状态（仅 current 步可能有；无 blocks 的步骤为 null） */
  verify?: StepVerifyState | null
  /** 本步「初始信息」是否已确认（用户在「📝 初始信息」里保存过且非空白）。
   *  未确认时「▶ 开始此步」会被拦住（首次开工；已有验收环进度不拦）。 */
  briefConfirmed: boolean
  /** 已保存的「初始信息」原文（未保存过 = undefined；「📝 初始信息」编辑框预填 = briefSaved ?? briefDefault） */
  briefSaved?: string
}

/** 流程整体视图 */
export type FlowView = {
  projectId: string
  projectName: string
  templateId: string
  templateName: string
  templateIcon: string
  folder: string
  /** 项目已有绑定会话（兼容信息） */
  bound: boolean
  /** 项目概况（用户填写的论文/项目全局信息 markdown；空 = 未填写） */
  brief: string
  /** 当前可执行步是否已建专属会话（步骤子目录会话） */
  sessionReady: boolean
  /** 当前可执行步的专属会话是否正在工作（AI 交付中；用于把「开始此步」置灰防误点） */
  currentBusy: boolean
  /** 有效起始步下标（0-based） */
  startIndex: number
  /** 步骤数 */
  total: number
  /** 已通过数（仅统计有效区间） */
  doneCount: number
  /** 当前可执行步骤下标（有效区间内；全部通过 = total） */
  currentIndex: number
  allDone: boolean
  /** 验收环最新通知（FlowPane 弹出 toast；at 去重） */
  alert?: { msg: string; kind: 'ok' | 'err' | 'info'; at: number } | null
  steps: FlowStepView[]
}

/* ─────────────────────────── 工具函数 ─────────────────────────── */

/** 模板级配置覆盖（templateId → stepId → 覆盖；写入 localStorage，随插件本地长期保存） */
type TemplateOverrideStore = Record<string, Record<string, FlowStepOverride>>
const TPL_OVERRIDES_KEY = 'dsh.worktable.templateOverrides.v1'

function readTemplateOverrides(): TemplateOverrideStore {
  try {
    const raw = localStorage.getItem(TPL_OVERRIDES_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw)
    return p && typeof p === 'object' ? (p as TemplateOverrideStore) : {}
  } catch {
    return {}
  }
}

/** 把某步配置（技能/说明）保存到模板级：下次用该模板新建的项目即为最新配置（逐字段合并）。
 *  语义：字段传 '' = 显式清空该字段（回到「不指定」）；字段不传（undefined）= 保留旧值。 */
export function saveTemplateStepOverride(templateId: string, stepId: string, o: FlowStepOverride): void {
  try {
    const all = readTemplateOverrides()
    const cur = (all[templateId] ?? {})[stepId] ?? {}
    const merged: FlowStepOverride = {}
    if (o.skill !== undefined) merged.skill = o.skill
    else if (cur.skill !== undefined) merged.skill = cur.skill
    if (o.instruction !== undefined) merged.instruction = o.instruction
    else if (cur.instruction !== undefined) merged.instruction = cur.instruction
    // 收敛参数：逐字段合并（undefined = 保留旧值；面板保存时会带全三个字段，等于整体替换）
    if (o.converge !== undefined) {
      const conv: ConvergeOverride = { ...(cur.converge ?? {}) }
      for (const k of ['target', 'maxRounds', 'plateau'] as const) {
        const v = o.converge[k]
        if (v === undefined) continue
        if (Number.isFinite(v)) conv[k] = Math.round(v as number)
        else delete conv[k]
      }
      if (Object.keys(conv).length > 0) merged.converge = conv
    } else if (cur.converge !== undefined) {
      merged.converge = cur.converge
    }
    all[templateId] = { ...(all[templateId] ?? {}), [stepId]: merged }
    localStorage.setItem(TPL_OVERRIDES_KEY, JSON.stringify(all))
  } catch {
    /* localStorage 不可用：仅本项目覆盖仍生效 */
  }
}

/** 模板级元配置（当前仅默认布局预设） */
type TemplateMetaStore = Record<string, { layoutPreset?: string }>
const TPL_META_KEY = 'dsh.worktable.templateMeta.v1'
function readTemplateMeta(): TemplateMetaStore {
  try {
    const raw = localStorage.getItem(TPL_META_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw)
    return p && typeof p === 'object' ? (p as TemplateMetaStore) : {}
  } catch {
    return {}
  }
}

/** 可选布局预设（创建弹窗与模板配置共用显示名） */
export const LAYOUT_PRESETS: { id: string; name: string }[] = [
  { id: '2h', name: '2 栏：窗口1 + 右侧对话' },
  { id: '3h', name: '3 栏：双内容窗 + 对话' },
  { id: 'l2', name: '上 1 下 1 + 对话（通高）' },
  { id: 'grid', name: '上 2 下 1 + 对话' },
  { id: 't3', name: '上 1 下 2 + 对话（通高）' },
  { id: 'l13', name: '上 1 大下 3 小 + 对话' },
  { id: 'g4', name: '2×2 网格 + 对话（通高）' },
  { id: 'l23', name: '上 2 下 3 + 对话（通高）' },
]

/** 保存模板默认布局预设 */
export function saveTemplateLayout(templateId: string, layoutPreset: string): void {
  try {
    const all = readTemplateMeta()
    all[templateId] = { ...(all[templateId] ?? {}), layoutPreset }
    localStorage.setItem(TPL_META_KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}

/** 清除某步的模板级配置覆盖（恢复模板出厂默认技能/说明） */
export function clearTemplateStepOverride(templateId: string, stepId: string): void {
  try {
    const all = readTemplateOverrides()
    const t = all[templateId]
    if (!t) return
    const next = { ...t }
    delete next[stepId]
    if (Object.keys(next).length === 0) delete all[templateId]
    else all[templateId] = next
    localStorage.setItem(TPL_OVERRIDES_KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}

/** 取模板定义（合并模板级配置覆盖：默认布局/步骤技能与说明以覆盖为准） */
export function templateById(id: string): TemplateDef | undefined {
  const def = BUILTIN_TEMPLATES.find((t) => t.id === id)
  if (!def) return undefined
  const meta = readTemplateMeta()[id]
  const ov = readTemplateOverrides()[id]
  const layoutPreset = meta?.layoutPreset ?? def.layoutPreset
  const stepOv = (sid: string) => ov?.[sid] ?? aliasPick(ov, sid)
  const hasStepOv = !!ov && def.steps.some((s) => stepOv(s.id))
  if (!hasStepOv && layoutPreset === def.layoutPreset) return def
  return {
    ...def,
    layoutPreset,
    steps: hasStepOv
      ? def.steps.map((s) => {
          const o = stepOv(s.id)
          if (!o) return s
          return { ...s, skill: o.skill ?? s.skill, instruction: o.instruction ?? s.instruction }
        })
      : def.steps,
  }
}

export function freshFlowRun(templateId: string, startIndex = 0): FlowRunState {
  return { templateId, createdAt: Date.now(), done: [], startIndex: Math.max(0, Math.floor(startIndex) || 0), tplRev: TEMPLATE_REV }
}

/** 有效区间：该步是否在起始步之后（含）；< startIndex 的步骤跳过不参与 */
export function stepInRange(run: FlowRunState | undefined, idx: number): boolean {
  return idx >= (run?.startIndex ?? 0)
}

export function effectiveSkill(step: TemplateStepDef, run: FlowRunState | undefined): string {
  return run?.overrides?.[step.id]?.skill ?? step.skill ?? ''
}

export function effectiveInstruction(step: TemplateStepDef, run: FlowRunState | undefined): string {
  return run?.overrides?.[step.id]?.instruction ?? step.instruction ?? ''
}

/** 本步「初始信息」生效稿：用户在面板「📝 初始信息」保存的内容优先；未保存过则回退模板针对性默认
 *  （面板编辑预填与任务卡展示用）。开工门控看的是「是否已保存确认」（isStepBriefConfirmed），不是本函数。 */
export function stepBriefOf(step: TemplateStepDef, run: FlowRunState | undefined): string {
  const v = run?.stepBriefs?.[step.id]
  return v !== undefined ? v : (step.briefDefault ?? '')
}

/** 本步「初始信息」是否已确认：保存过且去空白后非空。未确认 = 首次开工被拦。 */
export function isStepBriefConfirmed(step: TemplateStepDef, run: FlowRunState | undefined): boolean {
  const v = run?.stepBriefs?.[step.id]
  return v !== undefined && v.trim().length > 0
}

/** 有效收敛参数：模板默认（块级 converge）叠加本项目「⚙ 配置」的覆盖值（逐字段合并；越界自动夹紧）。
 *  说明：达标分夹到 0-100，最大轮次与平台期夹到 1-99（防止 0 轮/0 次造成空转或死循环）。 */
export function effectiveConverge(step: TemplateStepDef, run: FlowRunState | undefined): ConvergeConfig | undefined {
  const base = convergeCfgOf(step)
  if (!base) return undefined
  const ov = run?.overrides?.[step.id]?.converge
  if (!ov) return base
  const clamp = (v: number | undefined, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback
  return {
    target: clamp(ov.target, base.target, 0, 100),
    maxRounds: clamp(ov.maxRounds, base.maxRounds, 1, 99),
    plateau: clamp(ov.plateau, base.plateau, 1, 99),
  }
}

/* ─────────────────────────── 技能候选（本机技能目录） ─────────────────────────── */

/**
 * 技能下拉的数据来源是**宿主实时扫描的技能目录**（全局 ~/.dsh/skills、~/.agents/skills，
 * 以及当前项目的 .dsh/skills、.agents/skills），而不再是插件里写死的技能名清单——
 * 这样在全局技能目录里新装/新增的技能会立刻出现在每个步骤的「技能」下拉里。
 */
export type SkillOption = {
  /** 技能名（= 目录名或 SKILL.md frontmatter 的 name；执行时以 /技能名 自动加载） */
  name: string
  /** 技能描述（下拉提示用，可空） */
  description?: string
  /** 来源（user-dsh / user-agents / project-dsh / project-agents / bundled 等，仅展示） */
  source?: string
}

const SKILLS_ENDPOINT = '/api/worktable/skills'

/** 宿主技能接口不可用（旧宿主 / 路由未就绪）时的兜底候选：仅保证下拉非空，可手输任意技能名 */
export const SKILL_OPTIONS = [
  'paper-workbench',
  'academic-pipeline',
  'github-up',
] as const

function fallbackSkillOptions(): SkillOption[] {
  return SKILL_OPTIONS.map((name) => ({ name, source: 'fallback' }))
}

let skillOptionsCache: SkillOption[] | null = null
let skillOptionsInflight: Promise<SkillOption[]> | null = null

/** 拉取宿主技能清单（进程内缓存，多个窗格/面板共用一次请求）。
 *  force=true 强制重新扫描（技能目录刚变动时用）。任何失败都退化为兜底候选，绝不抛错。 */
export async function loadSkillOptions(force = false): Promise<SkillOption[]> {
  if (force) { skillOptionsCache = null; skillOptionsInflight = null }
  if (skillOptionsCache) return skillOptionsCache
  if (!skillOptionsInflight) {
    skillOptionsInflight = (async (): Promise<SkillOption[]> => {
      let out: SkillOption[] = []
      try {
        const r = await fetch(SKILLS_ENDPOINT, { headers: { accept: 'application/json' } })
        if (r.ok) {
          const d: any = await r.json()
          if (Array.isArray(d?.skills)) {
            out = d.skills
              .filter((s: any) => s && typeof s.name === 'string' && s.name.trim() !== '')
              .map((s: any) => ({
                name: String(s.name).trim(),
                description: typeof s.description === 'string' && s.description.trim() ? s.description.trim() : undefined,
                source: typeof s.source === 'string' && s.source ? s.source : undefined,
              }))
          }
        }
      } catch {
        /* 接口不可用：走兜底候选 */
      }
      const list = out.length > 0 ? out : fallbackSkillOptions()
      skillOptionsCache = list
      skillOptionsInflight = null
      return list
    })()
  }
  return skillOptionsInflight
}

/** 已缓存的技能候选（未加载过则为空数组；供首帧渲染用，避免闪空） */
export function cachedSkillOptions(): SkillOption[] {
  return skillOptionsCache ?? []
}

/** FlowPane 通过宿主注入的桥接口（index.tsx 在 setSplitEnv 时实现；类型引用无运行时依赖） */
export type FlowEnv = {
  subscribe: (fn: () => void) => () => void
  getView: (projectId: string) => FlowView | null
  /** 开始步骤：创建/确保「步骤子目录」→ 刷新项目全局信息 md → 在子目录开会话（复用已有）→
   *  切到该会话并把任务说明填入输入框（不自动发送，由用户手动开始）。返回反馈文案 */
  start: (projectId: string, stepId: string) => Promise<string>
  /** 用户确认通过（绿标） */
  markDone: (projectId: string, stepId: string) => void
  /** 撤销通过：把该步及其后所有步骤退回未通过（用于修改后重走） */
  undo: (projectId: string, stepId: string) => void
  /** 保存该步技能/说明覆盖（同时写回模板，后续新建项目即为最新配置） */
  setOverride: (projectId: string, stepId: string, o: FlowStepOverride) => void
  /** 保存项目概况（论文/项目全局信息 markdown；写入 _项目全局信息.md 并同步进后续 _本步要求.md） */
  setBrief: (projectId: string, text: string) => void
  /** 保存某步「初始信息」（用户在「📝 初始信息」确认/修改的本步针对性提示词；存本项目，随步骤开工注入任务卡） */
  setStepBrief: (projectId: string, stepId: string, text: string) => void
  /** 初稿诊断定位：把初稿放项目根目录后发诊断任务，产出 _诊断报告.md + DIAG_START_STEP 行 */
  startDiagnosis: (projectId: string) => Promise<string>
  /** 应用诊断结果：读 _诊断报告.md 的 DIAG_START_STEP，把起始步设为该步（其前步骤跳过） */
  applyDiagnosis: (projectId: string) => Promise<string>
  /** 手动指定起始步：把流程起始步设到该步（其前步骤标记为跳过；该步成为当前步），与诊断定位等效但由用户直接指定 */
  setStartStep: (projectId: string, stepId: string) => Promise<string>
  /** 重置本步验收环：清零块/轮次进度从第 1 块第 1 轮重跑（不删除产物文件） */
  resetStep: (projectId: string, stepId: string) => string
  /** 一键继续本步（非正常中止后恢复）：按当前阶段智能续跑（催工人交付 / 重派验收员），不重置进度 */
  resume: (projectId: string, stepId: string) => Promise<string>
  /** 手动停止本步（任务进行中面板「⏹ 停止」）：立即中断在跑的工人/验收员/裁判会话，
   *  调度器不再自动派单（杜绝"手动终止会话后又自动开新会话"）；进度保留，resume 可随时恢复 */
  stop: (projectId: string, stepId: string) => Promise<string>
  /** 打开当前步最新验收报告所在文件夹并告知文件名 */
  openLatestReport: (projectId: string, stepId: string) => Promise<string>
}
/** 图/表类产出判定（决定是否附「出版级图表验收清单」基线）：工人工人与验收员共用同一判据 */
export function needsFigureBaseline(
  step: { id: string; title: string },
  block?: { id: string; title: string },
): boolean {
  const t = `${step.id} ${step.title}${block ? ` ${block.id} ${block.title}` : ''}`
  return /图|表|figure|visual|chart/i.test(t)
}

/** 迭代收敛：判定某步是否走「工人+裁判」收敛环（任一块带 converge 配置）。 */
export const isConvergeStep = (step: TemplateStepDef): boolean =>
  (step.blocks ?? []).some((b) => !!b.converge)

/** 迭代收敛：取本步收敛参数（取首个带 converge 的块）。 */
export function convergeCfgOf(step: TemplateStepDef): ConvergeConfig | undefined {
  return (step.blocks ?? []).find((b) => !!b.converge)?.converge
}

/** 迭代收敛：工人第 1 轮任务卡（纯函数；开工时自动发送进工人会话，供单测）。
 *  与论文模板的分工：本卡只讲「收敛环怎么跑 + 第 1 轮做什么」；完整协议在 _本步要求.md。 */
export function composeConvergeTask(opts: {
  projectName: string
  templateName: string
  folder: string
  index: number
  total: number
  step: TemplateStepDef
  skill: string
  instruction: string
  /** 有效收敛参数（含面板「⚙ 配置」覆盖）；不传则用模板默认 */
  converge?: ConvergeConfig
}): string {
  const { projectName, index, total, step, folder, instruction } = opts
  const stepDir = `${folder}/${step.dir}`
  const cfg = opts.converge ?? convergeCfgOf(step)
  const L: string[] = []
  L.push(`【${String(index).padStart(2, '0')} 开工 ${step.title}】${projectName}（第 ${index}/${total} 步）`)
  L.push(`工作目录（cwd）：${step.dir}/`)
  L.push('')
  L.push(`任务：${step.deliverable}`)
  L.push('')
  L.push('迭代收敛协议（工人+裁判双 Agent，串行；完整协议见 _本步要求.md）：')
  L.push('1. 你（工人）产出 v1 → 覆写交付物 + 覆写交付标记 _交付_main.md → 【立即停止】等裁判评分（不要自评、不要等回复）。')
  L.push('2. 每轮产物直接写入 cwd（' + step.dir + '/），文件名规范「步号-语义」，不加 v2/final/新 等版本后缀。')
  L.push('3. 独立裁判（每轮新会话，不与你共享上下文）按 _rubric.md 评分，写 _评分_R<N>.md（末行 "SCORE: <总分>"，0-100 整数）。')
  L.push('4. 系统机械判定：新分 > 旧分 → 采纳（最佳版本=本轮）；否则回退（最佳版本保留，你的本轮产物被回退）。')
  L.push(`5. 循环至收敛：达标(≥${cfg?.target ?? 93}) ／ 达轮次上限(${cfg?.maxRounds ?? 8}) ／ 连续 ${cfg?.plateau ?? 2} 轮无改进。`)
  L.push('6. 收敛后系统让你把最佳版本写为最终产物并写 _本步摘要.md，然后等用户终审。')
  L.push('')
  L.push('第 1 轮（v1）要求：')
  L.push('1. 任务输入：_本步要求.md 的「任务定义」小节 + 文件末尾「项目全貌」里的任务正文（= 用户在面板「📝 任务定义」填写的内容）。')
  L.push('2. 产出 v1：按任务定义写入 cwd，文件名规范。')
  L.push('3. 覆写 _交付_main.md，必须含「## 本轮产物文件」小节（每行一个产物文件名，以「- 」开头，相对 cwd）+「## 本轮说明」+「## 逐条自核」。')
  L.push('4. 【立即停止】等裁判评分。')
  const reqs = String(instruction ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  if (reqs.length > 0) {
    L.push('')
    L.push('用户硬性要求（逐条执行，不得省略、不得打折）：')
    reqs.forEach((r, i) => L.push(`  ${i + 1}. ${r}`))
  }
  L.push('')
  L.push('开工前必读（按序读完再动手）：')
  L.push(`1. ${stepDir}/_本步要求.md —— 完整收敛协议 + 任务定义 + 评分细则（若已冻结）`)
  L.push(`2. ${folder}/_项目全局信息.md —— 项目全貌 / 任务定义`)
  L.push(`3. （本步无 L2 论文叠加层：任务与标准一律以「任务定义」为准，不要去找 ${OVERLAY_FILE}）`)
  return L.join('\n')
}

/** 迭代收敛：_本步要求.md 正文（自包含：任务卡 + 任务定义 + 评分细则 + 收敛协议）。
 *  与 composeStepSpec 的分工：收敛步走本函数（不引用 02-十步验收标准.md 的 L1 清单）。 */
export function composeConvergeSpec(opts: {
  projectName: string
  templateName: string
  folder: string
  index: number
  total: number
  step: TemplateStepDef
  skill: string
  instruction: string
  /** 有效收敛参数（含面板「⚙ 配置」覆盖）；不传则用模板默认 */
  converge?: ConvergeConfig
}): string {
  const { projectName, index, total, step, folder, instruction } = opts
  const cfg = opts.converge ?? convergeCfgOf(step)
  const stepDir = `${folder}/${step.dir}`
  const L: string[] = []
  L.push(`# 第 ${index}/${total} 步 · ${step.title}（${projectName}）`)
  L.push('')
  L.push(composeConvergeTask(opts))
  L.push('')
  L.push('## 任务定义')
  L.push(`任务正文 = 用户在流程面板「📝 任务定义」里填写的内容（已自动内联在本文件末尾的「项目全貌」小节；同一内容也存于 ${folder}/_项目全局信息.md）。下方「用户硬性要求」为补充。`)
  L.push('**若「项目全貌」里只有框架信息、没有任务正文**（= 用户尚未填写任务定义）：立即停止，**不得自行编造任务**——在交付标记里写明「任务未定义，等待用户填写」，等用户在面板点「📝 任务定义」补全后再开工。')
  const reqs = String(instruction ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  if (reqs.length > 0) {
    L.push('用户硬性要求：')
    reqs.forEach((r, i) => L.push(`${i + 1}. ${r}`))
  }
  L.push('')
  L.push('## 评分细则（裁判评分依据）')
  L.push('- 若「项目全貌」（来自用户的「📝 任务定义」）或下方「用户硬性要求」中已写明「评分细则」（维度 + 权重 + 各分档标准），裁判第 1 轮**必须遵循**并写入 _rubric.md 冻结。')
  L.push('- 若未预定义：裁判第 1 轮自行定义评分细则（维度 + 权重 + 各分档标准），写入 _rubric.md 并冻结；后续轮次一律遵循该文件，不得更改口径。')
  L.push(`- 评分报告写入 ${stepDir}/_评分_R<N>.md：含 JSON 分项（各维度得分、扣分理由、改进建议）+ 末行单独一行 "SCORE: <总分>"（0-100 整数）。`)
  L.push('')
  L.push('## 迭代收敛协议（工人 / 裁判 / 调度器三方共用）')
  L.push('1. 工人：产出/修订产物 → 覆写交付物（cwd 内，规范名）→ 覆写 _交付_main.md（含「## 本轮产物文件」小节）→ 停止。')
  L.push('2. 裁判：按 _rubric.md 独立评分 → 写 _评分_R<N>.md（JSON 分项 + 末行 "SCORE: <总分>"）。')
  L.push('3. 调度器：新分 > 旧分 → 采纳（机械复制 产物 → _best-<名>）；否则回退（机械复制 _best-<名> → 产物，保留最佳版本）。')
  L.push(`4. 收敛判定：达标(≥${cfg?.target ?? 93}) ／ 达轮次上限(${cfg?.maxRounds ?? 8}) ／ 连续 ${cfg?.plateau ?? 2} 轮无改进。收敛后工人把最佳版本写为最终产物 + 写 _本步摘要.md → 用户终审。`)
  L.push('5. 产物须为文本文件（.md/.py/.txt/.csv/.json 等）；调度器按文本机械复制，二进制产物不支持。')
  L.push('6. 串行执行纪律（本地单槽位模型）：同一时刻只允许一个会话运行——工人停后才派裁判，裁判停后才唤醒工人。调度器自动强制执行（工人未停不派裁判；裁判未停不重派、不唤醒工人），你无需管理。')
  return L.join('\n')
}

/** 组装「开始/继续某步」的会话任务卡（纯函数；自动发送进工人会话，供单测）。
 *  刻意极简（≈35 行）：各块验收清单与项目全貌只写入同目录 _本步要求.md，消息里点名要求先读，
 *  避免开工瞬间灌入数千字导致模型注意力被稀释。自包含完整版见 composeStepSpec。 */
export function composeStepTask(opts: {
  projectName: string
  templateName: string
  folder: string
  index: number
  total: number
  step: TemplateStepDef
  skill: string
  instruction: string
  /** 有效收敛参数（仅收敛步用；含面板「⚙ 配置」覆盖） */
  converge?: ConvergeConfig
  /** 本步「初始信息」用户确认稿（面板「📝 初始信息」保存的内容）：注入任务卡最前，工人逐条落实 */
  stepBrief?: string
}): string {
  if (isConvergeStep(opts.step)) return composeConvergeTask(opts)
  const { projectName, index, total, step, skill, instruction, folder } = opts
  const stepDir = `${folder}/${step.dir}`
  const L: string[] = []
  L.push(`【${String(index).padStart(2, '0')} 开工 ${step.title}】${projectName}（第 ${index}/${total} 步）`)
  L.push(`工作目录（cwd）：${step.dir}/`)
  L.push('')
  L.push(`任务：${step.deliverable}`)
  const briefLines = String(opts.stepBrief ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  if (briefLines.length > 0) {
    L.push('')
    L.push('本步初始信息（用户在面板「📝 初始信息」给定并确认——逐条落实；与本卡其它内容冲突时以此为准）：')
    briefLines.forEach((b) => L.push(`  ${b}`))
  }
  const files = (step.blocks ?? []).flatMap((b) => b.files ?? [])
  if (files.length > 0) {
    L.push('')
    L.push(`本步产物文件名（严格使用）：${files.join('、')}`)
    L.push(NAMING_RULE_NOTE)
  }
  // 技能：步骤级 + 各块级，逐个单独成行（宿主靠独立成行的 /技能名 注入技能说明）
  const skillList: { name: string; note: string }[] = []
  const addSkill = (raw: string | undefined, note: string) => {
    const n = String(raw ?? '').replace(/^\s*\/\s*/, '').trim()
    if (!n) return
    const hit = skillList.find((s) => s.name === n)
    if (hit) { if (!hit.note.includes(note)) hit.note += '、' + note }
    else skillList.push({ name: n, note })
  }
  addSkill(skill, '本步全程')
  for (const b of step.blocks ?? []) {
    addSkill(b.skill, `块「${b.title}」`)
    for (const s of b.skills ?? []) addSkill(s, `块「${b.title}」`)
  }
  if (skillList.length > 0) {
    L.push('')
    L.push('指定技能（必须加载并按其说明执行）：')
    for (const s of skillList) L.push(`/${s.name}`)
    if (skillList.length > 1) L.push(`分工：${skillList.map((s) => `/${s.name} → ${s.note}`).join('；')}`)
  }
  const reqs = String(instruction ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (reqs.length > 0) {
    L.push('')
    L.push('用户硬性要求（逐条执行，不得省略、不得打折）：')
    reqs.forEach((r, i) => L.push(`  ${i + 1}. ${r}`))
  }
  L.push('')
  L.push('交付纪律：')
  L.push(`1. 全部产物只写入 cwd（${step.dir}/）；其它步骤目录与项目根只读，禁止修改；`)
  L.push('2. 文件名严格按上表；不加 v2/final/新 等版本后缀，不自创名字；')
  L.push('3. 交付时给出产物文件清单 + 逐条自核结果（只写"已完成"不给清单 = 未交付）。')
  L.push('4. 自核须与实测一致：凡本步有对应工具（`tools/` 下）的项，一律**贴出工具输出**再下结论；自报数字与实测不符、或自述"未改数据"而实测有改动，按未交付处理。')
  const blocks = step.blocks ?? []
  if (blocks.length > 0) {
    const freeBlocks = blocks.filter((b) => b.noVerify)
    L.push('')
    L.push(freeBlocks.length === blocks.length
      ? `分块交付协议（本步 ${blocks.length} 块，**全部免验收**：交付即完成，不派验收员）：`
      : `分块交付协议（本步 ${blocks.length} 块，${freeBlocks.length} 块免验收）：`)
    blocks.forEach((b, i) => L.push(`  ${i + 1}. ${b.title}${b.noVerify ? '（免验收：交付即完成）' : ''}${b.repeatable ? '（重复块：每轮交付一个对象）' : ''}${b.skill ? `　技能 /${String(b.skill).replace(/^\s*\//, '')}` : ''}`))
    L.push('  ① 按 _本步要求.md 中该块条目逐条自纠后交付（免验收块同样要自纠到位，只是不再有人复核）；')
    L.push('  ② 覆写交付标记 _交付_<块id>.md（内容 = 本轮对象 + 产物清单 + 逐条自核结果）；')
    L.push('  ③ 【免验收】覆写交付标记后系统**自动进入下一块**，不停等、不需要等任何"通过"结果；')
    L.push('  ④ 全部块交付完毕 → 写 _本步摘要.md（结论要点 / 关键数据 / 产物清单 / 遗留事项），然后等用户终审。')
  }
  L.push('')
  L.push('开工前必读（按序读完再动手）：')
  L.push(`1. ${stepDir}/_本步要求.md —— 本步完整要求 + 各块验收清单（来自 02-十步验收标准.md，实时读取）+ 项目全貌`)
  L.push(`2. ${baselinePersonalPath()} —— 质量基线（含第 9 节「技能强制规则红线汇总」：结构逻辑 / 语言红线 / 公式与符号 / 引用与文献 / 处理边界 / 13 项质量门控）`)
  let n = 3
  if (needsFigureBaseline(step)) { L.push(`${n}. ${baselineFiguresPath()}`); n++ }
  L.push(`${n}. ${folder}/${OVERLAY_FILE}（L2 项目叠加层，若存在：写作语言等特殊要求）`)
  L.push('')
  L.push('随本步可用的成品工具（第 8 步用；其它步按需）：')
  L.push(`- \`${paperPath('scripts', 'mdplan.py')}\` —— 由「原稿 × 章稿 md」机械生成 \`08-修改清单.json\`，内置 5 项审计（运算符删除 / 数学相邻空格 / 唯一命中 / find 非空 / 模拟执行）。**禁止凭记忆或凭上下文摘要转录改动**（必漏整段重写）`)
  L.push(`- \`${paperPath('scripts', 'fixup.py')}\` —— 引擎做不到的事：符号 OMML 化（pandoc 就地插入）、公式内符号改写、同串多格手工红标；\`--emit-manual\` 自动产出重放差异声明`)
  L.push(`- \`${paperPath('scripts', 'verify_docx.py')}\` —— 交付前 9 项核验（指纹 / 段落属性全等 / 标红正确 / 域与修订 / 重放预算 / 清稿=章稿 / 标点前空格 / 数值改动登记 / 敏感单元）`)
  L.push(`- \`${paperPath('scripts', 'redline_selfcheck.py')}\`、\`count_words.py\`、\`prose_lint.py\` —— 红标自检、字数主口径、行文可疑句定位`)
  L.push(`（技能目录来自本机配置，运行时解析：\`${paperScriptsDir()}\`）`)
  L.push('')
  L.push('开工第一步 —— 三级标准对照体检（每个块开工前必做，不得跳过、不得直接开改）：')
  L.push('  ① 拿验收标准（02-十步验收标准.md）+ L2 项目叠加层 + 质量基线（含第 9 节红线）+ 本步技能规程，逐条比对本块现有产物（或待优化的原始稿件）：每条给出「达标 / 不达标」；')
  L.push('  ② 不达标项写成清单：每条 = 位置（文件:行或段号）+ 问题 + 改成什么样（可直接照改，不依赖你的记忆）；')
  L.push('  ③ 体检必须**一次做全**——宁可清单长，不可边改边发现（漏掉的条目会变成后续的验收轮次，这正是反复打回的主因）；')
  L.push('  ④ 体检表写入交付标记（_交付_<块id>.md），据此一次改完；交付前逐条回勾，确认不达标项已清零、原本达标的内容未被破坏。')
  return L.join('\n')
}

/** 组装 _本步要求.md 的正文（自包含：任务卡 + 各块验收清单）。
 *  与 composeStepTask 的分工：消息只发任务卡；文件收全文，AI 需要细节时自行读取。
 *  index.tsx 会在其后追写「前置步骤交付物盘点」与「项目全貌」。
 *  l1Entries = 从 02-十步验收标准.md 解析出的本步条目，实时读取。 */
export function composeStepSpec(opts: {
  projectName: string
  templateName: string
  folder: string
  index: number
  total: number
  step: TemplateStepDef
  skill: string
  instruction: string
  l1Entries?: string[]
  /** 有效收敛参数（仅收敛步用；含面板「⚙ 配置」覆盖） */
  converge?: ConvergeConfig
  /** 本步「初始信息」用户确认稿（注入任务卡「本步初始信息」小节） */
  stepBrief?: string
}): string {
  if (isConvergeStep(opts.step)) return composeConvergeSpec(opts)
  const { projectName, index, total, step, l1Entries } = opts
  const L: string[] = []
  L.push(`# 第 ${index}/${total} 步 · ${step.title}（${projectName}）`)
  L.push('')
  L.push(composeStepTask(opts))
  const blocks = step.blocks ?? []
  if (blocks.length > 0) {
    L.push('')
    L.push((blocks).every((b) => b.noVerify)
      ? '## 本步自纠清单（来自 02-十步自纠清单.md，实时读取；本步免验收——没有验收员，须在交付时逐条给出自核结果）'
      : '## 本步验收标准（来自 02-十步验收标准.md，实时读取；验收员逐条核验，你必须逐条自纠）')
    if (l1Entries && l1Entries.length > 0) {
      l1Entries.forEach((e, i) => L.push(`${i + 1}. ${e}`))
    }
    blocks.forEach((b, i) => {
      L.push('')
      L.push(`### 块 ${i + 1} · ${b.title}${b.noVerify ? '（免验收：交付即完成）' : ''}${b.repeatable ? '（重复块：逐对象验收）' : ''}`)
      if (b.skill) L.push(`本块技能：/${String(b.skill).replace(/^\s*\//, '')}`)
      if (b.files && b.files.length > 0) L.push(`产物文件：${b.files.join('、')}`)
      L.push(b.noVerify
        ? '本块免验收：不派验收员，覆写交付标记后自动进入下一块；上方条目是你交付前逐条自纠的依据，须给出自核结果。'
        : '验收标准：见上方「本步验收标准（来自 02-十步验收标准.md，实时读取）」中对应块条目。')
    })
  }
  return L.join('\n')
}
