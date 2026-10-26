/**
 * dsh-worktable 验收环调度器（论文写作模板 2.0 核心引擎）
 *
 * 角色分工：
 * - 工人会话（步骤子目录）：按 composeStepTask 的「分块交付与验收协议」逐块交付，覆写交付标记后停等。
 * - 验收员会话（每轮新建，cwd = 步骤子目录）：加载 stage-verifier，独立核验，写验收报告（末尾 VERDICT 行）。
 * - 本调度器（浏览器端）：探测「工人空闲 + 交付标记更新」→ 派验收；解析报告 VERDICT → PASS 派下一块 /
 *   FAIL 派修改（一轮验收：改完自动进下一块）；串行调度保证本地单槽位模型（llama.cpp parallel=1）无死锁。
 *
 * 串行执行门控（本地单槽位模型，llama.cpp parallel=1：同一时刻只允许一个会话运行）：
 *  - 工人会话仍在运行时**不派**验收员/裁判（等工人停，下个 tick 复查；长时间无进度则提醒用户疑似卡死）；
 *  - 验收员/裁判会话仍在运行时**不重派**（即便超过硬超时也只提醒；用户手动停掉该会话后自动重派）；
 *  - 面板「⏯ 继续本步」与「▶ 开始此步」同样受此门控：对向会话运行中时不唤醒/不重派。
 *
 * 状态持久化在 FlowRunState.verify[stepId]（localStorage），刷新页面后 tick() 自动恢复。
 */

import {
  BASELINE_FIGURES, BASELINE_PERSONAL, OVERLAY_FILE,
  deliveryMarkerName, doneMarkerName, reportName, stRoundOf,
  scoreReportName, bestName, isConvergeStep, effectiveConverge,
  type ConvergeConfig, type FlowRunState, type StepVerifyState, type TemplateBlockDef, type TemplateDef,
} from './templates'
/* ─────────────────────────── 报告解析 ─────────────────────────── */

/** 从验收报告文本解析判定（约定：末尾单独一行 "VERDICT: PASS" / "VERDICT: FAIL"）。
 *  容错：允许行首/行尾出现 Markdown 装饰（`**VERDICT: PASS**`、`- VERDICT: PASS`、`` `VERDICT: FAIL` ``）、
 *  列表符号、引用符号与全角冒号——模型常给结论行加粗，严格匹配会让整条验收环**永久卡在 verifying**
 *  （报告已就绪但解析不出判定，看门狗又只盯"报告未出"，于是既不推进也不重派）。 */
export function parseVerdict(reportText: string): 'PASS' | 'FAIL' | null {
  const text = String(reportText ?? '')
  const strict = /^\s*VERDICT\s*[:：]\s*(PASS|FAIL)\s*$/im.exec(text)
  if (strict) return strict[1].toUpperCase() === 'PASS' ? 'PASS' : 'FAIL'
  const loose = /^[\s>*_`#\-•]*VERDICT[\s*_`]*[:：][\s*_`]*(PASS|FAIL)[\s*_`.。;；]*$/im.exec(text)
  if (!loose) return null
  return loose[1].toUpperCase() === 'PASS' ? 'PASS' : 'FAIL'
}

/** 粗计 FAIL 条数（| 行第二列含 FAIL），仅用于面板展示 */
export function countFails(reportText: string): number {
  let n = 0
  for (const line of String(reportText ?? '').split('\n')) {
    if (/^\s*\|/.test(line) && /\|\s*FAIL\s*\|/.test(line)) n++
  }
  return n
}

/** 从裁判评分报告解析总分（约定：末尾单独一行 "SCORE: <总分>"，0-100 整数）。
 *  容错：允许行首/行尾 Markdown 装饰（`**SCORE: 87**`、`- SCORE: 87`、全角冒号）。
 *  解析失败返回 null（调度器据此按"裁判异常"重派，不卡死）。 */
export function parseScore(reportText: string): number | null {
  const text = String(reportText ?? '')
  const strict = /^\s*SCORE\s*[:：]\s*(\d{1,3})\s*$/im.exec(text)
  if (strict) {
    const n = Number(strict[1])
    if (n >= 0 && n <= 100) return n
  }
  const loose = /^[\s>*_`#\-•]*SCORE[\s*_`]*[:：][\s*_`]*(\d{1,3})[\s*_`.。;；]*$/im.exec(text)
  if (!loose) return null
  const n = Number(loose[1])
  return (n >= 0 && n <= 100) ? n : null
}

/** 从交付标记解析本轮产物文件清单（「## 本轮产物文件」小节，每行 "- <文件名>"，相对 cwd）。
 *  返回文件名数组（去重、去空）。清单为空 = 工人未按格式写（调度器回退用 listDir 兜底）。 */
export function parseMarkerFiles(markerText: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const lines = String(markerText ?? '').split('\n')
  let inSection = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^#{1,6}\s*本轮产物文件/.test(line)) { inSection = true; continue }
    if (inSection && /^#{1,6}\s/.test(line)) { inSection = false; continue } // 下一小节结束
    if (inSection) {
      const m = /^[-•]\s+([^\s（(]+)/.exec(line)
      if (m) {
        const f = m[1].trim().replace(/^\.\//, '')
        if (f && !f.startsWith('_') && !seen.has(f)) { seen.add(f); out.push(f) }
      }
    }
  }
  return out
}

/* ─────────────────────────── 会话标题命名规范 ───────────────────────────
 *   工人会话（步骤会话）：`NN 步名`                 如 `07 图精修`
 *   验收员会话（每轮新建）：`验收 NN步名·块名 R轮`   如 `验收 07图精修·逐图 R2`
 *   目的：会话列表里一眼分清「这一步是谁在干活」（工人 / 验收员）与轮次，且长度稳定不刷屏。 */

/** 验收员会话标题（简洁：角色 + 步号步名 + 块名 + 轮次） */
export function verifierTitle(stepLabel: string, blockTitle: string, round: number): string {
  const label = String(stepLabel ?? '').replace(/\s+/g, '')
  return `验收 ${label}·${blockTitle} R${round}`
}

/** 统一会话消息抬头：【<步号> <动作> <对象> 第N轮】——开消息一眼看清「第几步 · 在干什么 · 第几轮」。
 *  stepLabel 形如 `08 全文文字优化`（取前导数字为步号）；诊断等非步骤消息可直接传完整抬头。 */
export function msgHead(stepLabel: string, action: string, object?: string, round?: number): string {
  const raw = String(stepLabel ?? '').trim()
  const m = /^(\d{1,2})/.exec(raw)
  const no = m ? m[1].padStart(2, '0') : '--'
  const bits = [no, action]
  if (object) bits.push(object)
  if (typeof round === 'number' && round > 0) bits.push(`第${round}轮`)
  return `【${bits.join(' ')}】`
}

/** 轮次口径说明（贴在验收/改稿消息里，避免把「调度器第 N 轮」误读成「被拒 N 次」） */
const ROUND_NOTE = '流程口径：**每块只验收 1 轮**（一轮验收）——交付 → 自动派验收员 → PASS 进下一块 ／ FAIL 派改稿 → 工人改完**自动进入下一块交付**（本块不再复验）。消息里的「第 N 轮」= **本步累计**轮次（跨块不重置、只增不减），N 不等于失败次数。'

/* ─────────────────────────── 任务文本组装 ─────────────────────────── */

/** 验收员任务：独立核验，写报告，一句话回结论 */
export function composeVerifyTask(opts: {
  projectName: string
  stepLabel: string
  stepTitle: string
  block: TemplateBlockDef
  round: number
  /** 重复块的当前对象序号（= 已通过对象数 + 1），用于抬头显示"第 N 个对象" */
  objectNo?: number
  stepDir: string
}): string {
  const { projectName, stepLabel, stepTitle, block, round, objectNo, stepDir } = opts
  const report = reportName(block.id, round)
  const objLabel = block.repeatable && objectNo ? `${block.id}第${objectNo}个对象` : block.id
  const lines: string[] = []
  lines.push(msgHead(stepLabel, '验收', objLabel, round))
  lines.push(`项目：${projectName} · 步骤：第 ${stepTitle} · cwd：${stepDir}`)
  lines.push(ROUND_NOTE)
  lines.push('')
  lines.push('你是本步的**独立验收员**，与生产者无任何共享上下文。先加载技能 stage-verifier（/stage-verifier），严格按其规程执行：只验收、不改稿、每条判定必须有亲自核验的证据。')
  lines.push('')
  lines.push(`交付标记：${deliveryMarkerName(block.id)}（cwd 下，先读它拿到本轮产物文件清单）`)
  lines.push(`验收报告写入：${report}（固定格式见 stage-verifier 技能；末尾必须单独一行 "VERDICT: PASS" 或 "VERDICT: FAIL"）`)
  lines.push('')
  lines.push('验收依据（按优先级，冲突时取高优先级）：')
  lines.push(`1. **本步验收标准**（唯一权威来源）：cwd 下 \`_本步要求.md\` 的「本步验收标准」小节——逐条核验，不得遗漏、不得跳过、不得只挑几条；该文件与工人看到的是同一份，工人自纠与验收员核验口径完全一致。`)
  if (block.acceptance.length > 0) {
    lines.push(`   本块条目（另附）：`)
    block.acceptance.forEach((a, i) => lines.push(`   ${i + 1}. ${a}`))
  }
  lines.push(`2. 个人写作基准：${BASELINE_PERSONAL}（含 §9 技能强制规则红线）`)
  lines.push(`3. 项目叠加层：项目根 ${OVERLAY_FILE}（若存在）`)
  if (/图|表|figure/i.test(block.title + block.id)) lines.push(`4. 出版级图表验收清单：${BASELINE_FIGURES}`)
  lines.push('')
  lines.push('验收铁律（违反任一条 = 本轮验收无效）：')
  lines.push('0. **一轮验收——你的报告是本块唯一一次验收**：每块只验收 1 轮。若你判 FAIL，工人只有一次改稿机会，改完**直接进入下一块**、本块不再复验；你本轮没报出的问题不会有人再查，只会变成用户终审时的遗留问题。因此宁可清单长，不可漏项。术语/缩写/一致性类必须给「类别清单 + 出现次数 + 全部位置」再判定，只点名 1-2 处就判 PASS 是最常见的漏报原因。')
  lines.push('1. **一次穷举**：本轮必须列出当前存在的**全部**问题，不得分轮挤牙膏。同一清单项下的每一处实例都要逐处列全（例如"术语不统一"要列出每一处位置，不得只举 1-2 个例子当代表）；不允许"这轮先改这几条、下轮再说其它"——工人只按你本轮报告改一次。')
  lines.push('2. **判 PASS = 全篇无问题**：只有当你完整核验过该条目在全篇的每一处、确认无问题时才判 PASS；"抽查没发现"不能判 PASS。')
  lines.push('3. **必须通读**：本轮全部产物逐文件读完（长文分段读完，不抽样），并核验与其它章节、表格、摘要、结论的交叉一致性——正文里的公式符号缺失、缩写重开定义、体例不统一这类硬伤必须在本轮报出。')
  lines.push('4. **类别闭合**：术语/缩写/数据一致性/体例类条目，必须给出「类别清单 + 出现次数 + 全部位置」再下判定（如"全文 12 个缩写：CEBM×2、LOBO×2、CFD×1…"）——只点名 1-2 处就判 PASS，是最常见的漏报原因。')
  lines.push('5. **ADVISORY 从严**：凡是不改就会影响投稿质量的问题，一律列 FAIL，不得降级为 ADVISORY；ADVISORY 只能用于"改不改都达标"的纯偏好项，且同样要给修改指令、同样要一次列全。')
  lines.push('6. **给可执行指令**：每条 FAIL 写【位置】+【问题】+【改成什么样】，工人拿不到你的报告也能照着改；涉及数值/图片/本体不可在本步修改的，写清「登记即可」（判 PASS(附登记)），不要计 FAIL 卡住整步。')
  lines.push('7. **扫描对象限于交付物**：只扫 `_本步要求.md` 声明的产物文件；`08-修改清单.json` 的 find 字段、历史交付标记与旧验收报告含旧表述，不得作为"未改"证据。')
  lines.push('8. 只写报告文件，不修改任何交付物。')
  lines.push('')
  lines.push('报告末尾除 VERDICT 行外，另加一段「收敛看板」：本轮 FAIL 数（其中硬伤 x 条 / 偏好项 y 条）；本块只验收一轮，无需统计"上轮遗留 vs 本轮新发现"，但若同一步更早的块存在验收报告，可一并说明跨块口径是否一致。')
  lines.push('')
  lines.push(`报告写完后，只回复一句话结论（如「${report}：FAIL，5 项未过」），不要提问、不要等待确认。`)
  return lines.join('\n')
}

/** FAIL 后发给工人的修改指令 */
export function composeReviseTask(opts: { stepLabel: string; block: TemplateBlockDef; round: number; failCount: number }): string {
  const { stepLabel, block, round, failCount } = opts
  return [
    msgHead(stepLabel, '改稿', block.id, round) + `　本块验收 FAIL（${failCount} 项未过）`,
    '',
    ROUND_NOTE,
    '',
    `请先读验收报告：${reportName(block.id, round)}（逐条 FAIL 都有具体修改指令）。`,
    '请按修改指令逐条修改本块产物，改完覆写交付标记（列明本轮改动清单 + 逐条自核结果），然后立即停止等下一轮验收。',
    '',
    '三条硬性纪律（违反任一条都会导致验收反复失败）：',
    '① 【回归纪律】只改报告中点名的位置：上一轮已判 PASS 的内容一律不得重写、重排或"顺手优化"（改好一条、弄坏一条是本步最常见的卡轮原因）；确需改动已通过内容时，必须在交付标记里单独说明理由。',
    '② 【依据纪律】改稿前必须重读并按序对照三层要求与技能规程，不得凭印象改：验收标准（`_本步要求.md`：硬性要求 + 各块验收清单）→ L2 项目叠加层（项目根 ' + OVERLAY_FILE + '：写作语言等特殊要求）→ 本步任务卡列出的技能规程（如 aca-02-writing 的语言纪律、aca-08-polish 的门控项）。',
    '③ 【交付前核对】交付标记中必须逐条列出：本轮每条 FAIL 是否落地 + 上一轮已 PASS 的条目是否仍成立 + 验收标准与技能要求的对照结果（不列视为未交付）。',
    '若某条确实无法落实，请在交付标记中写明「做不到 + 原因 + 替代方案」，不得静默跳过、不得把未达标写成已完成。',
  ].join('\n')
}

/** PASS 后发给工人的"继续下一块"指令 */
export function composeNextBlockTask(stepLabel: string, block: TemplateBlockDef): string {
  return [
    msgHead(stepLabel, '下一块', block.id),
    '',
    `上一块已通过验收。继续交付本块：「${block.title}」。`,
    `交付物：${block.deliverable}`,
    '流程照旧：按 _本步要求.md 中该块的验收清单逐条自纠 → 覆写交付标记 → 停止等验收。',
  ].join('\n')
}

/** repeat 块 PASS 且未全部完成时的"继续下一个对象"指令 */
export function composeContinueRepeatTask(stepLabel: string, block: TemplateBlockDef, passedCount: number): string {
  return [
    msgHead(stepLabel, '继续', `${block.id}第${passedCount + 1}个对象`),
    '',
    `上一个对象（第 ${passedCount} 个）已通过验收。继续「${block.title}」的下一个对象：`,
    `覆写 ${deliveryMarkerName(block.id)}（写明本轮对象 + 产物清单 + 自核结果），然后停止等验收。`,
    `全部对象验收通过后，写 ${doneMarkerName(block.id)} 宣告本块完成。`,
  ].join('\n')
}

/** 全部通过（含 repeat 完成标记确认）后的收尾提示 */
export function composeFinishTask(stepLabel: string): string {
  return [
    msgHead(stepLabel, '收尾', '写本步摘要'),
    '',
    '本步全部交付块已通过独立验收。请写 _本步摘要.md（①本步结论/要点 ②关键数据/参数/术语 ③产出文件清单 ④遗留事项与给后续步骤的提示），然后输出一句话总结等用户在面板点「✓ 通过」。',
  ].join('\n')
}

/** 验收未通过时的改稿指令（一轮验收：每块只验收 1 轮，改完**自动进入下一块交付**，不再复验） */
export function composeFinalReviseTask(opts: { stepLabel: string; block: TemplateBlockDef; round: number; failCount: number }): string {
  const { stepLabel, block, round, failCount } = opts
  return [
    msgHead(stepLabel, '改稿', block.id, round),
    '',
    `本块第 ${round} 轮验收**未通过**（${failCount} 项）。按「一轮验收」协议（每块只验收 1 轮）：请按验收报告改完这一次，**改完覆写交付标记后系统自动进入下一块**（本块不再复验）。`,
    `请读 ${reportName(block.id, round)}，把其中每条 FAIL 与 ADVISORY 的修改指令**一次改完**；`,
    `改完覆写 ${deliveryMarkerName(block.id)}（列明本轮改动清单 + 逐条自核结果），然后**立即停止**——系统会自动推进到下一块；未过项会作为遗留问题记入报告与 _本步摘要.md，交用户在面板终审。`,
    '',
    '三条纪律照旧：',
    '① 【回归纪律】只改报告点名的位置，本轮已判 PASS 的内容不得重写、重排或"顺手优化"；',
    '② 【依据纪律】改稿前须重读验收标准（_本步要求.md 的硬性要求与验收清单）、L2（项目根 ' + OVERLAY_FILE + '）与本步技能规程，按它们改而不是凭印象改；',
    '③ 【交付前核对】交付标记中逐条列出：本轮指令是否全部落地 + 已 PASS 项是否仍成立 + 验收标准对照结果。',
    '',
    '⚠️ 本块没有第二次验收，所以请务必**自证**（交付标记里贴出证据，不要只写"已改"）：',
    '· 有对应工具的项（`D:\\dsh-worktable\\tools\\` 下 mdplan / verify_docx / redline_selfcheck / count_words / prose_lint）一律**贴出工具输出**；',
    '· 报告点名的每一处，给出「位置 ｜ 改前 ｜ 改后 ｜ 证据」对照行；',
    '· 明确列出**仍未落实**的项及原因（交用户终审），不得静默跳过、不得把未达标写成已完成。',
  ].join('\n')
}

/** 用户点「⏯ 继续本步」时发给工人的续跑指令（非正常中止后恢复：保留进度，不重做已完成部分） */
export function composeResumeTask(opts: { stepLabel: string; block: TemplateBlockDef; round: number; passedCount: number }): string {
  const { stepLabel, block, round, passedCount } = opts
  const objLabel = block.repeatable ? `${block.id}第${passedCount + 1}个对象` : block.id
  const L: string[] = []
  L.push(msgHead(stepLabel, '继续', objLabel, round))
  L.push('')
  L.push('上一次执行被中断（会话或服务异常），进度已保留。请接着完成本块，不要重做已完成的部分：')
  L.push(`1. 先读 ${deliveryMarkerName(block.id)}（若存在，看清上一轮交付到哪一步）与 _本步要求.md 中本块的验收清单；`)
  L.push('2. 产物已齐备则直接覆写交付标记；有缺项先补齐再覆写；')
  L.push(`3. 覆写 ${deliveryMarkerName(block.id)} 后【立即停止】等验收。`)
  if (block.repeatable) {
    L.push(`（重复块：本块已通过 ${passedCount} 个对象，接着做下一个对象；全部对象完成后写 ${doneMarkerName(block.id)}。）`)
  }
  return L.join('\n')
}

/* ─────────────────────────── 迭代收敛（工人+裁判双 Agent 收敛环）任务组装 ─────────────────────────── */

/** 迭代收敛：裁判评分任务（每轮新会话，独立上下文；按 _rubric.md 评分，写 _评分_R<N>.md，末行 SCORE 行）。 */
export function composeScoreTask(opts: {
  projectName: string
  stepLabel: string
  stepTitle: string
  block: TemplateBlockDef
  round: number
  stepDir: string
  bestScore?: number
  bestVersion?: number
}): string {
  const { projectName, stepLabel, stepTitle, block, round, stepDir, bestScore, bestVersion } = opts
  const report = scoreReportName(round)
  const L: string[] = []
  L.push(msgHead(stepLabel, '评分', block.id, round))
  L.push(`项目：${projectName} · 步骤：第 ${stepTitle} · cwd：${stepDir}`)
  L.push('')
  L.push('你是本步的**独立裁判**，与工人无任何共享上下文。先加载技能 score-referee（/score-referee），严格按其规程执行：只评分、不改稿、不替工人决定结论；每条扣分必须有亲自核验的证据。')
  L.push('')
  L.push('评分依据（按优先级，冲突时取高优先级）：')
  L.push(`1. **评分细则**：cwd 下 \`_rubric.md\`。若第 1 轮该文件不存在：你先定义评分细则（维度 + 权重 + 各分档标准）并写入该文件**冻结**，后续轮次一律遵循；若 _本步要求.md 或项目全局信息中已预定义评分维度，必须遵循并写入 _rubric.md。`)
  L.push(`2. **任务定义**：cwd 下 \`_本步要求.md\` 的「任务定义」小节 + 项目全局信息（项目根 _项目全局信息.md）。`)
  L.push(`3. **项目叠加层**：项目根 ${OVERLAY_FILE}（若存在）。`)
  L.push('')
  L.push(`待评产物：${deliveryMarkerName(block.id)}（cwd 下，先读它拿到本轮产物文件清单）中列出的产物文件（逐个读完，不抽样）。`)
  L.push(`评分报告写入：${stepDir}/${report}`)
  L.push('')
  L.push('评分报告格式（严格遵守）：')
  L.push('1. 开头一段：本轮总分 + 一句话总评。')
  L.push('2. JSON 分项（```json 代码块）：`{"total": <0-100整数>, "dimensions": [{"name": <维度名>, "weight": <0-1>, "score": <该维度0-100>, "deductions": ["<扣分理由+位置>"], "suggestions": ["<改进建议>"]}]}`。各维度 score×weight 之和四舍五入应等于 total。')
  L.push('3. 逐条扣分理由与改进建议（可执行、工人可直接照改）。')
  L.push(`4. **末行单独一行**："SCORE: <总分>"（0-100 整数）——调度器据此解析，缺此行 = 本轮评分无效。`)
  L.push('')
  L.push('评分铁律：')
  L.push('0. **独立核验**：只凭待评产物本身评分，不参考工人自述、不参考上一轮报告；每条扣分给「位置 + 问题 + 证据」。')
  L.push('1. **口径冻结**：_rubric.md 一旦写入，后续轮次不得更改维度/权重/分档标准；你本轮只评分，不改细则。')
  L.push('2. **一次穷举**：本轮必须列出当前全部扣分项，不得分轮挤牙膏。')
  L.push('3. **只写报告**：不修改任何产物文件。')
  L.push('')
  if (bestScore != null) L.push(`上下文：上一最佳 ${bestScore} 分（第 ${bestVersion} 轮）。你只评本轮，不与历史比较；采纳/回退由调度器机械判定。`)
  L.push('')
  L.push(`报告写完后，只回复一句话结论（如「${report}：SCORE 87」），不要提问、不要等待确认。`)
  return L.join('\n')
}

/** 迭代收敛：工人修订指令（评分后未收敛 → 按报告修订，覆写交付物 + 覆写标记 → 停止）。 */
export function composeConvergeReviseTask(opts: {
  stepLabel: string
  block: TemplateBlockDef
  round: number
  score: number
  adopted: boolean
  bestScore: number
  bestVersion: number
}): string {
  const { stepLabel, block, round, score, adopted, bestScore, bestVersion } = opts
  const L: string[] = []
  L.push(msgHead(stepLabel, '修订', block.id, round + 1))
  L.push('')
  L.push(`第 ${round} 轮评分 **${score} 分**；当前最佳 **${bestScore} 分**（第 ${bestVersion} 轮）。`)
  L.push(adopted
    ? `本轮**已采纳**（${score} > 上轮最佳），最佳版本更新为第 ${round} 轮。`
    : `本轮**未采纳**（${score} ≤ 上轮最佳），系统已**回退**到最佳版本（第 ${bestVersion} 轮）——你现在的产物 = 最佳版本，不是本轮被拒版本。`)
  L.push('')
  L.push(`请先读评分报告：${scoreReportName(round)}（JSON 分项 + 逐条扣分理由 + 改进建议）。`)
  L.push('请按改进建议逐条修订当前产物，然后：')
  L.push('1. 覆写交付物（cwd 内，规范名，不加版本后缀）；')
  L.push(`2. 覆写 ${deliveryMarkerName(block.id)}（必须含「## 本轮产物文件」小节，每行一个产物文件名）；`)
  L.push('3. 【立即停止】等裁判评分（不要自评）。')
  L.push('')
  L.push('两条纪律：')
  L.push('① 【回归纪律】只改进评分报告点名的扣分项；报告未点名的已达标内容不得重写、重排或"顺手优化"。')
  L.push('② 【交付前核对】交付标记中逐条列出：本轮每条扣分是否落地 + 上一轮已达标项是否仍成立（不列视为未交付）。')
  return L.join('\n')
}

/** 迭代收敛：收尾指令（收敛完成 → 工人核对最终产物 = 最佳版本，写 _本步摘要.md）。 */
export function composeConvergeFinishTask(opts: {
  stepLabel: string
  block: TemplateBlockDef
  bestScore: number
  bestVersion: number
  done: 'target' | 'maxrounds' | 'plateau'
  scores: { round: number; score: number; adopted: boolean }[]
}): string {
  const { stepLabel, block, bestScore, bestVersion, done, scores } = opts
  const L: string[] = []
  L.push(msgHead(stepLabel, '收尾', '写本步摘要'))
  L.push('')
  L.push(`迭代收敛已完成：最佳 **${bestScore} 分**（第 ${bestVersion} 轮），终止原因：${done === 'target' ? '达标' : done === 'maxrounds' ? '达轮次上限' : '连续无改进'}。`)
  L.push('分数轨迹：')
  scores.forEach((s) => L.push(`  第 ${s.round} 轮：${s.score} 分（${s.adopted ? '采纳' : '回退'}）`))
  L.push('')
  L.push('当前产物（cwd 内，规范名）= 最佳版本（调度器已确保）。请：')
  L.push('1. 核对最终产物文件齐全、命名规范；')
  L.push('2. 写 _本步摘要.md（①本步结论/要点 ②分数轨迹与终止原因 ③最终产物文件清单 ④遗留事项与给用户的提示）；')
  L.push('3. 输出一句话总结，等用户在面板点「✓ 通过」。')
  return L.join('\n')
}

/* ─────────────────────────── 初稿诊断定位 ─────────────────────────── */

/** 诊断任务：对项目根目录的初稿做 10 步体检，产出 _诊断报告.md（末尾 DIAG_START_STEP 行供插件解析） */
export function composeDiagnosisTask(opts: {
  projectName: string
  folder: string
  steps: { id: string; title: string; dir: string; deliverable: string; blockTitles: string[] }[]
  currentStart: number
}): string {
  const { projectName, folder, steps, currentStart } = opts
  const lines: string[] = []
  lines.push(`【诊断 初稿定位】${projectName}`)
  lines.push('')
  lines.push('用户把一篇论文初稿放进了项目根目录，要从中途进入「论文写作模板」流程。你的任务：给初稿做 10 步体检，定位它处于流程的哪一步，产出诊断报告。')
  lines.push('')
  lines.push('步骤：')
  lines.push(`1. 列出项目根目录（${folder}/，含子目录 _初稿/ 若存在）：找出初稿文件（.md/.docx/.pdf/.tex；docx 用工具提取文本）。若根目录有 _原稿.docx，它就是全文**排版格式基准**（第 8 步的定稿红标 docx 要以它为底稿原地修订），请在报告中注明其存在、页数与章节结构。`)
  lines.push('2. 通读初稿全文（长文分段读完，不要抽样）。')
  lines.push(`3. 按下表逐步对照，逐步判定【已具备 / 部分具备 / 缺失】并给证据（初稿文件/章节/行）：`)
  steps.forEach((s, i) => {
    lines.push(`   ${i + 1}. ${s.title}：${s.deliverable}${s.blockTitles.length ? `（分块：${s.blockTitles.join('、')}）` : ''}`)
  })
  lines.push('4. 写《_诊断报告.md》到项目根目录，结构：')
  lines.push('   - 总评一段（初稿整体处于什么状态、距投稿的差距在哪三类地方）；')
  lines.push('   - 10 步对照表（每步：判定 + 证据 + 缺什么）；')
  lines.push('   - 修订计划（从建议起始步起，每步要补齐/返工什么，按序排列）；')
  lines.push('   - 最后一行单独写：`DIAG_START_STEP: N`（N=建议起始步，1-10；= 第一个「部分具备/缺失」且有实际工作量的步；若初稿几乎完整则写 10）。')
  lines.push(`   当前项目起始步为第 ${currentStart} 步；若你的建议不同，以你的判断为准。`)
  lines.push('5. 报告写完后，只回复一句话总结（整体状态 + 建议从第几步进入），不要提问。')
  lines.push('')
  lines.push(`质量基线（判定"距投稿差距"的依据）：${BASELINE_PERSONAL}`)
  return lines.join('\n')
}

/* ─────────────────────────── 调度器 ─────────────────────────── */

export type VerifyDeps = {
  /** 全部带流程的 projectId 列表 */
  listFlowProjects: () => string[]
  getRun: (projectId: string) => FlowRunState | undefined
  getTemplate: (run: FlowRunState) => TemplateDef | undefined
  getFolder: (projectId: string) => string
  getProjectName: (projectId: string) => string
  getWorkerSid: (run: FlowRunState, stepId: string) => string | undefined
  /** 更新 FlowRunState.verify（持久化 + 触发面板刷新） */
  patchVerify: (projectId: string, stepId: string, patch: (cur: StepVerifyState | undefined) => StepVerifyState | undefined) => void
  isRunning: (sid: string | undefined) => boolean
  /** 向会话发消息（自动确保 preset/model）；失败返回 false */
  sendToSession: (sid: string, text: string) => Promise<boolean>
  /** 中断指定会话的当前运行轮（宿主 SessionFace.cancel；会话不存在/未在跑返回 false）。
   *  面板「⏹ 停止」用它停掉工人/验收员/裁判会话——配合 userStopped 标记杜绝"手动终止后又自动开新会话"。 */
  cancelSession: (sid: string) => Promise<boolean>
  /** 新建验收员会话（cwd = 步骤目录，不注册工作区，应用当前默认模型）。
   *  title = 会话标题（命名规范：`验收 NN步名·块名 R轮`），便于在会话列表里一眼识别 */
  createVerifierSession: (stepDir: string, title: string) => Promise<string | null>
  /** 步骤标签「NN 步名」（如 `07 图精修`），用于拼会话标题 */
  getStepLabel: (stepId: string) => string
  readFile: (abs: string) => Promise<string | null>
  writeFile: (abs: string, content: string) => Promise<boolean>
  /** 列目录下的文件名（可选）：用于从磁盘验收报告校正累计轮次，防"意外中止后状态回退重跑" */
  listDir?: (abs: string) => Promise<string[]>
  /** 目录内最近文件活动（可选）：返回步骤目录里最新的文件 mtime(ms)，取不到返回 0。
   *  工人看门狗据此「随进度自动判断」 stalled——工人还在写文件就不算无进展。 */
  latestActivity?: (abs: string) => Promise<number>
  /** 用户可见通知（面板 toast） */
  notify: (projectId: string, msg: string, kind: 'ok' | 'err' | 'info') => void
  /** 步骤全部通过后刷新项目全局信息 */
  onStepPassed: (projectId: string) => void
}

const MAX_VERIFY_ATTEMPTS = 3
/** 验收轮次上限（v0.3.17「一轮验收」）：**每块只验收 1 轮**，流程固定为
 *  交付 → 自动派验收员 → PASS 进下一块 ／ FAIL 派改稿 → 工人改完**自动进入下一块交付**（不再复验）。
 *  配套：① 验收员当轮报告必须「一次穷举」（漏项没有第二次机会）；
 *        ② 改稿指令要求工人贴工具输出 + 逐条「位置｜改前｜改后｜证据」对照 + 明列未落实项；
 *        ③ 未过项作为遗留问题记入验收报告与 _本步摘要.md，交用户终审。 */
const MAX_VERIFY_ROUNDS = 1
/** 验收员超时（ms）：报告未出且超过此时长 → 重派新验收员 */
const VERIFY_WATCHDOG_MS = 90_000
/** 验收员/裁判**硬超时**（ms）：报告迟迟未出超过此上限按异常处理——
 *  会话仍运行 → 只提醒用户、**不重派**（本地单槽位模型同一时刻只允许一个会话运行，重派即并行）；
 *  会话已停 → 重派。给足长稿阅读时间，故取 20 分钟。 */
const VERIFY_HARD_TIMEOUT_MS = 20 * 60_000
/** 「硬超时提醒」重复间隔（ms）：裁判仍运行期间，面板提醒每隔此时长发一次（防每 tick 刷屏）。 */
const VERIFY_HARD_STALL_NOTIFY_GAP_MS = 10 * 60_000
/** 工人「运行中无进度」提醒阈值（ms）：工人会话仍在运行（如覆写交付标记后还在生成收尾回复），
 *  且距最近进度信号（派发时间 / 步骤目录最近文件活动，取较新者）超过此值 → 提醒用户疑似卡死。
 *  注意：期间**不派裁判**——本地单槽位模型同一时刻只允许一个会话运行（串行执行门控）；
 *  用户在 DSH 会话列表手动停掉该会话后，下个 tick 自动派裁判。 */
const WORKER_RUNNING_STALL_MS = 30 * 60_000
/** 工人静默看门狗（ms）：工人会话已停，且距「最近进度信号」超过此时长 → 标记 stalled，
 *  面板显示「⏯ 继续本步」供用户一键续跑（不自动重派，避免打断真正的长任务）。
 *  进度信号 = max(任务派发时间, 步骤目录内最近文件改动时间)——有文件活动就自动续期，
 *  长任务只要还在写文件就永远不会被误标（随进度自动判断，而非固定时长一刀切）。 */
const WORKER_WATCHDOG_MS = 300_000
const TICK_MS = 3000
/** 单次 tick 卡死判定（ms）：正常 tick 几秒内结束；超过则说明某个宿主 API（发消息/建会话）挂起。
 *  若不强制解锁，`inTick` 会永远为 true → 调度器彻底停摆、后续"交付→自动验收"全部不再触发。 */
const TICK_STUCK_MS = 60_000

export class VerifyScheduler {
  private deps: VerifyDeps
  private timer: number | null = null
  private inTick = false
  /** 本轮 tick 的开始时间（配合 TICK_STUCK_MS 做挂起自愈） */
  private tickStartedAt = 0

  constructor(deps: VerifyDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.timer != null) return
    this.timer = window.setInterval(() => { void this.tick() }, TICK_MS)
  }

  stop(): void {
    if (this.timer != null) { window.clearInterval(this.timer); this.timer = null }
  }

  /** 初始化某步验收状态（startFlowStep 首次开工时调用）：从第 0 块第 1 轮开始 */
  static initState(): StepVerifyState {
    return { phase: 'working', blockIdx: 0, round: 1, stepRound: 1, passedCount: 0, startedAt: Date.now(), workerDispatchedAt: Date.now() }
  }

  async tick(): Promise<void> {
    if (this.inTick) {
      // 挂起自愈：上一轮 tick 超时未结束（宿主 API 卡住/网络抖动）→ 强制解锁，
      // 否则 inTick 永远为 true，整个验收环不再自动触发（交付后静默无反应）。
      if (this.tickStartedAt > 0 && Date.now() - this.tickStartedAt > TICK_STUCK_MS) {
        this.inTick = false
        this.tickStartedAt = 0
      } else {
        return
      }
    }
    this.inTick = true
    this.tickStartedAt = Date.now()
    try {
      for (const pid of this.deps.listFlowProjects()) {
        try { await this.tickProject(pid) } catch { /* 单项目异常不阻断其它项目 */ }
      }
    } finally {
      this.inTick = false
      this.tickStartedAt = 0
    }
  }

  private currentStepId(run: FlowRunState, tmpl: TemplateDef): { stepId: string; idx: number } | null {
    const startIndex = Math.min(Math.max(run.startIndex ?? 0, 0), Math.max(0, tmpl.steps.length - 1))
    for (let i = startIndex; i < tmpl.steps.length; i++) {
      if (!run.done.includes(tmpl.steps[i].id)) return { stepId: tmpl.steps[i].id, idx: i }
    }
    return null
  }

  /** 用磁盘上已有的验收报告校正「本步累计轮次」：取 `_验收_<块id>_R<N>.md` 的最大 N。
   *  轮次只增不减——即使 localStorage 里的状态因意外中止而滞后（甚至退回 1），
   *  也不会重跑已经验收过的轮次（这是"点继续本步却又从第 1 轮开始"的根治手段）。
   *  若最大 N 的报告已判定完毕（非 PENDING 占位），说明该轮已用完 → 本轮应为 N+1。 */
  private async syncRoundFromDisk(projectId: string, stepId: string, stepDir: string, block: TemplateBlockDef, st: StepVerifyState): Promise<StepVerifyState> {
    // 老状态缺 stepRound：先补写一次，之后一律用累计轮次
    if (typeof st.stepRound !== 'number') {
      const seeded = { ...st, stepRound: stRoundOf(st) }
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, stepRound: stRoundOf(cur) } : cur)
      st = seeded
    }
    if (!this.deps.listDir) return st
    let names: string[] = []
    try { names = await this.deps.listDir(stepDir) } catch { return st }
    const re = new RegExp(`^_验收_${block.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_R(\\d+)\\.md$`)
    let maxR = 0
    for (const n of names) {
      const m = re.exec(n)
      if (m) maxR = Math.max(maxR, Number(m[1]) || 0)
    }
    if (maxR <= 0) return st
    const text = await this.deps.readFile(`${stepDir}/${reportName(block.id, maxR)}`)
    const judged = !!text && !/^PENDING/.test(String(text).trim())
    const target = judged ? maxR + 1 : maxR
    if (target > stRoundOf(st)) {
      const fixed = { ...st, stepRound: target }
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, stepRound: target } : cur)
      return fixed
    }
    return st
  }

  private async tickProject(projectId: string): Promise<void> {
    const run = this.deps.getRun(projectId)
    if (!run) return
    const tmpl = this.deps.getTemplate(run)
    if (!tmpl) return
    const cur = this.currentStepId(run, tmpl)
    if (!cur) return
    const step = tmpl.steps[cur.idx]
    if (!step.blocks || step.blocks.length === 0) return // 无 blocks = 传统手动模式，不进验收环
    let st = run.verify?.[cur.stepId]
    // 全新开始（点了开始但还没写 verify 状态）：不代劳，等 startFlowStep 初始化
    if (!st) return
    // 步骤已通过：清理状态
    if (st.phase === 'step-passed' && run.done.includes(cur.stepId)) {
      this.deps.patchVerify(projectId, cur.stepId, () => undefined)
      return
    }
    // 用户手动停止（面板「⏹ 停止」）：调度器整体跳过本步——不派验收员/裁判、不重派、
    // 不报 stalled/硬超时提醒，直到用户点「⏯ 继续本步」或「▶ 开始此步」清除标记。
    if (st.userStopped) return
    const folder = this.deps.getFolder(projectId)
    if (!folder) return
    const stepDir = `${folder}/${step.dir}`
    const block = step.blocks[Math.min(st.blockIdx, step.blocks.length - 1)]

    const converge = isConvergeStep(step)
    if (st.phase === 'working') {
      if (converge) await this.tickConvergeWorking(projectId, cur.stepId, stepDir, step, block, st)
      else await this.tickWorking(projectId, cur.stepId, stepDir, step, block, st)
    } else if (st.phase === 'verifying') {
      if (converge) await this.tickConvergeVerifying(projectId, cur.stepId, stepDir, step, block, st)
      else await this.tickVerifying(projectId, cur.stepId, stepDir, step, block, st)
    }
    // paused / step-passed：等用户操作，不自动动作
  }

  /** working：交付标记有新内容 → 派验收员（无论工人会话是否还在运行——工人覆写标记后可能仍在生成回复）；
   *  工人久停无标记 → 标记 stalled 供用户一键续跑 */
  private async tickWorking(projectId: string, stepId: string, stepDir: string, step: TemplateDef['steps'][number], block: TemplateBlockDef, st: StepVerifyState): Promise<void> {
    const marker = await this.deps.readFile(`${stepDir}/${deliveryMarkerName(block.id)}`)
    // 标记非空即视为新交付：派任务给工人时已清空标记（见 tickVerifying），工人必须覆写才算交付
    if (marker && marker.trim()) {
      // 已达验收轮次上限：最后一次改稿交付后**强制收尾**，不再派验收员
      if (st.finalRevise) {
        await this.advanceAfterBlock(projectId, stepId, stepDir, step, block, st,
          { verdict: 'FAIL', failCount: st.lastVerdict?.failCount ?? 0 }, true)
        return
      }
      // 派验收前先与磁盘报告对齐轮次（意外中止后状态可能滞后，绝不回退重跑）
      st = await this.syncRoundFromDisk(projectId, stepId, stepDir, block, st)
      if (st.stalled) this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, stalled: false } : cur)
      const round = stRoundOf(st) // 本步累计轮次（跨块不重置）——报告名/会话标题/消息抬头统一用它
      const report = `${stepDir}/${reportName(block.id, round)}`
      await this.deps.writeFile(report, `PENDING 第 ${round} 轮验收报告（验收员生成中）`) // 占位防读到旧报告
      const verifyTask = composeVerifyTask({
        projectName: this.deps.getProjectName(projectId),
        stepLabel: this.deps.getStepLabel(stepId), stepTitle: step.title,
        stepDir, block, round, objectNo: st.passedCount + 1,
      })
      // 复用已创建但发送失败的验收员会话：不重开新会话，直接重发任务（与收敛环同款瞬时失败自愈）
      const prevVerifier = st.verifierSid
      if (prevVerifier && !this.deps.isRunning(prevVerifier)) {
        const okResend = await this.deps.sendToSession(prevVerifier, verifyTask)
        if (okResend) {
          this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
            ...cur, phase: 'verifying', verifierSid: prevVerifier,
            verifyDispatchedAt: Date.now(), verifyAttempts: 1,
          } : cur)
          return
        }
      }
      const sid = await this.deps.createVerifierSession(stepDir, verifierTitle(this.deps.getStepLabel(stepId), block.title, round))
      if (!sid) {
        this.dispatchFailRetry(projectId, stepId, step, st, `无法创建验收员会话（步骤「${step.title}」）`)
        return
      }
      const okSend = await this.deps.sendToSession(sid, verifyTask)
      if (!okSend) {
        // 会话已建好、只是任务没送进去：记住它，下个 tick 优先重发任务（不新建）；失败计数满才暂停
        this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, verifierSid: sid } : cur)
        this.dispatchFailRetry(projectId, stepId, step, st, `验收任务发送失败（步骤「${step.title}」）`)
        return
      }
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
        ...cur, phase: 'verifying', verifierSid: sid,
        verifyDispatchedAt: Date.now(), verifyAttempts: 1,
      } : cur)
      return
    }
    // 无交付标记：工人已停。可能正在思考（长任务），也可能异常中止 → 静默超时标记 stalled（不自动动作）。
    // 静默基准 = max(任务派发时间, 步骤目录最近文件改动)——工人写过文件就从文件活动起算（随进度自动判断）。
    const workerSid = st.workerSid ?? this.deps.getWorkerSid(this.deps.getRun(projectId)!, stepId)
    if (workerSid && !this.deps.isRunning(workerSid)) {
      let base = st.workerDispatchedAt ?? st.startedAt ?? 0
      if (this.deps.latestActivity) {
        const lastFileAt = await this.deps.latestActivity(stepDir).catch(() => 0)
        if (lastFileAt > 0) base = Math.max(base, lastFileAt)
      }
      const stalled = base > 0 && Date.now() - base > WORKER_WATCHDOG_MS
      if (stalled !== !!st.stalled) {
        this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, stalled } : cur)
        if (stalled) {
          const mins = Math.round(WORKER_WATCHDOG_MS / 60000)
          this.deps.notify(projectId, `⏸ 步骤「${step.title}」块「${block.title}」已静默 ${mins} 分钟（无文件活动、会话已停），疑似任务中止——面板点「⏯ 继续本步」可一键续跑（进度不丢）`, 'info')
        }
      }
    }
  }

  /** verifying 的看门狗：验收员空闲但报告迟迟未出（会话崩溃/网络丢）→ 重派新验收员；超 3 次暂停 */
  private async reverifyIfStale(projectId: string, stepId: string, stepDir: string, step: TemplateDef['steps'][number], block: TemplateBlockDef, st: StepVerifyState): Promise<void> {
    const attempts = st.verifyAttempts ?? 1
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'verifier-gone' } : cur)
      this.deps.notify(projectId, `⛔ 步骤「${step.title}」验收员 ${MAX_VERIFY_ATTEMPTS} 次均未交报告，已暂停——可在面板点「⏯ 继续本步」重派验收员`, 'err')
      return
    }
    const round = stRoundOf(st)
    const report = `${stepDir}/${reportName(block.id, round)}`
    await this.deps.writeFile(report, `PENDING 第 ${round} 轮验收报告（第 ${attempts + 1} 次重派）`)
    const sid = await this.deps.createVerifierSession(stepDir, verifierTitle(this.deps.getStepLabel(stepId), block.title, round))
    if (!sid) {
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'verifier-gone' } : cur)
      this.deps.notify(projectId, `⚠️ 无法重派验收员（步骤「${step.title}」），已暂停验收环`, 'err')
      return
    }
    const okSend = await this.deps.sendToSession(sid, composeVerifyTask({
      projectName: this.deps.getProjectName(projectId),
      stepLabel: this.deps.getStepLabel(stepId), stepTitle: step.title,
      stepDir, block, round, objectNo: st.passedCount + 1,
    }))
    if (!okSend) {
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'send-failed' } : cur)
      this.deps.notify(projectId, `⚠️ 验收任务重派发送失败（步骤「${step.title}」），已暂停验收环`, 'err')
      return
    }
    this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
      ...cur, verifierSid: sid, verifyDispatchedAt: Date.now(), verifyAttempts: (cur.verifyAttempts ?? 0) + 1,
    } : cur)
    this.deps.notify(projectId, `🔁 步骤「${step.title}」验收员超时未交报告，已重派（第 ${attempts + 1}/${MAX_VERIFY_ATTEMPTS} 次）`, 'info')
  }

  /** verifying：验收员空闲 + 报告就绪 → 解析 VERDICT → PASS 推进 / FAIL 打回 */
  private async tickVerifying(projectId: string, stepId: string, stepDir: string, step: TemplateDef['steps'][number], block: TemplateBlockDef, st: StepVerifyState): Promise<void> {
    // 硬超时优先于 isRunning：会话状态错乱时 isRunning 可能一直为真，导致验收环永久停摆
    const hardDispatchedAt = st.verifyDispatchedAt ?? 0
    if (hardDispatchedAt > 0 && Date.now() - hardDispatchedAt > VERIFY_HARD_TIMEOUT_MS) {
      this.deps.notify(projectId, `⏱ 步骤「${step.title}」验收员超过 ${Math.round(VERIFY_HARD_TIMEOUT_MS / 60000)} 分钟未交报告，已按异常重派`, 'err')
      await this.reverifyIfStale(projectId, stepId, stepDir, step, block, st)
      return
    }
    if (this.deps.isRunning(st.verifierSid)) return // 验收员还在工作
    const shownRound = stRoundOf(st) // 本步累计轮次（报告名/会话标题/消息抬头用）
    const reportText = await this.deps.readFile(`${stepDir}/${reportName(block.id, shownRound)}`)
    const reportReady = !!reportText && !/^PENDING/.test(reportText.trim())
    if (!reportReady) {
      // 看门狗：报告未出且距派发超时 → 重派（验收员会话可能崩溃）
      const dispatchedAt = st.verifyDispatchedAt ?? 0
      if (Date.now() - dispatchedAt > VERIFY_WATCHDOG_MS) {
        await this.reverifyIfStale(projectId, stepId, stepDir, step, block, st)
      }
      return
    }
    const verdict = parseVerdict(reportText!)
    if (!verdict) {
      // 报告已就绪但没有可识别的 VERDICT 行（验收员漏写/格式跑偏）：
      // 不能无限等下去——否则整个验收环永久卡在 verifying，工人交付后再无任何自动动作。
      // 超时后按"验收员异常"重派（新会话重写同一报告路径），最多 MAX_VERIFY_ATTEMPTS 次后暂停。
      const dispatchedAt = st.verifyDispatchedAt ?? 0
      if (dispatchedAt > 0 && Date.now() - dispatchedAt > VERIFY_WATCHDOG_MS * 2) {
        this.deps.notify(projectId, `⚠️ 步骤「${step.title}」验收报告缺少 VERDICT 判定行，已按异常重派验收员`, 'err')
        await this.reverifyIfStale(projectId, stepId, stepDir, step, block, st)
      }
      return
    }
    const failCount = countFails(reportText!)
    const run = this.deps.getRun(projectId)
    if (!run) return
    const workerSid = st.workerSid ?? this.deps.getWorkerSid(run, stepId)
    if (!workerSid) {
      this.deps.notify(projectId, `⚠️ 工人会话丢失（步骤「${step.title}」），验收环暂停：请在面板点「⏯ 继续本步」重开会话续跑`, 'err')
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'worker-gone', lastVerdict: { verdict, failCount, at: Date.now() } } : cur)
      return
    }

    if (verdict === 'FAIL') {
      // 一轮验收（v0.3.17）：FAIL → 派改稿 → 工人改完**自动进入下一块交付**（不再复验）。
      // 【顺序铁律】必须**先清空交付标记、再发指令**：若反过来，工人快速改完覆写标记后
      // 会被随后的清空操作抹掉，调度器从此看不到交付 → 既不验收也不推进（卡死根因）。
      if (st.round >= MAX_VERIFY_ROUNDS) {
        await this.deps.writeFile(`${stepDir}/${deliveryMarkerName(block.id)}`, '')
        const okSend = await this.deps.sendToSession(workerSid, composeFinalReviseTask({ stepLabel: this.deps.getStepLabel(stepId), block, round: shownRound, failCount }))
        this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
          ...cur, phase: 'working',
          round: cur.round + 1, stepRound: stRoundOf(cur) + 1, verifyAttempts: 0,
          // 仅当指令确实送达才置 finalRevise：发送失败仍置真会让后续交付被误判"已改完"而直接推进
          finalRevise: okSend,
          lastVerdict: { verdict, failCount, at: Date.now() }, verifierSid: undefined, stalled: false, workerDispatchedAt: Date.now(),
        } : cur)
        if (!okSend) {
          this.deps.notify(projectId, `⚠️ 改稿指令发送失败（步骤「${step.title}」）：请在该步会话里手动要求按 ${reportName(block.id, shownRound)} 改完`, 'err')
        } else {
          this.deps.notify(projectId, `🔁 步骤「${step.title}」块「${block.title}」验收未过（${failCount} 项）——已派改稿指令，工人改完**自动进入下一块**（不再复验）；未过项记入报告与本步摘要交你终审`, 'info')
        }
        return
      }
      // 兼容分支：仅当上限被临时调高（>1）时可达——派普通改稿，工人改完自动进入下一轮验收
      await this.deps.writeFile(`${stepDir}/${deliveryMarkerName(block.id)}`, '')
      const okSend = await this.deps.sendToSession(workerSid, composeReviseTask({ stepLabel: this.deps.getStepLabel(stepId), block, round: shownRound, failCount }))
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
        ...cur, phase: 'working',
        round: cur.round + 1, stepRound: stRoundOf(cur) + 1, verifyAttempts: 0,
        lastVerdict: { verdict, failCount, at: Date.now() }, verifierSid: undefined, workerDispatchedAt: Date.now(),
      } : cur)
      if (!okSend) this.deps.notify(projectId, `⚠️ 修改指令发送失败（步骤「${step.title}」）：请在该步会话里手动要求按 ${reportName(block.id, shownRound)} 修改`, 'err')
      else this.deps.notify(projectId, `🔁 步骤「${step.title}」块「${block.title}」第 ${shownRound} 轮 FAIL（${failCount} 项），已派回修改；改完自动进入第 ${shownRound + 1} 轮验收`, 'info')
      return
    }

    // ── PASS ──
    await this.advanceAfterBlock(projectId, stepId, stepDir, step, block, st, { verdict, failCount }, false)
  }

  /* ─────────────────────── 迭代收敛环（工人+裁判双 Agent） ─────────────────────── */

  /** 取最近一次投递失败的诊断（promptIntoSession 写入 window.__wtLastSendFail），附进通知文案便于定位宿主拒绝原因 */
  private lastSendDiag(): string {
    try {
      const f = (window as any).__wtLastSendFail
      if (f && typeof f.failures?.join === 'function' && Date.now() - Number(f.at) < 120_000) {
        return `　投递诊断：${String(f.failures.join(' | ')).slice(0, 300)}`
      }
    } catch {}
    return ''
  }

  /** 派发（创建验收员/裁判会话 + 发任务）失败的自动重试：
   *  新会话创建后宿主**异步注册** agent（会话面已可解析、prompt 准入却可能瞬时被拒），本地单槽位模型的
   *  槽位释放也常在工人停后滞后一两秒——这些多为**瞬时**失败；若持续失败则是确定性拒绝，通知里附带
   *  投递诊断（宿主返回的拒绝码）以便定位。旧逻辑一次失败即 phase='paused' 永久停摆
   *  （表现为「工人第 1 轮交付后裁判永远不启动」）。改为：保持当前 phase，下个 tick 自动重派；
   *  连续失败超过 MAX_VERIFY_ATTEMPTS 才暂停等用户（面板「⏯ 继续本步」可恢复）。 */
  private dispatchFailRetry(projectId: string, stepId: string, step: TemplateDef['steps'][number], st: StepVerifyState, what: string): void {
    const attempts = (st.verifyAttempts ?? 0) + 1
    const diag = this.lastSendDiag()
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'verifier-gone', verifyAttempts: attempts } : cur)
      this.deps.notify(projectId, `⛔ ${what}：连续 ${MAX_VERIFY_ATTEMPTS} 次失败，已暂停——排查后点面板「⏯ 继续本步」自动重派${diag}`, 'err')
      return
    }
    this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, verifyAttempts: attempts } : cur)
    this.deps.notify(projectId, `⚠️ ${what}：下个调度周期自动重派（第 ${attempts}/${MAX_VERIFY_ATTEMPTS - 1} 次重试）${diag}`, 'info')
  }

  /** 取本轮产物文件清单：优先交付标记「## 本轮产物文件」小节；为空则 listDir 兜底（非 _ 前缀文件）。 */
  private async convergeDeliverableFiles(stepDir: string, markerText: string | null): Promise<string[]> {
    const fromMarker = parseMarkerFiles(markerText ?? '')
    if (fromMarker.length > 0) return fromMarker
    if (!this.deps.listDir) return []
    let names: string[] = []
    try { names = await this.deps.listDir(stepDir) } catch { return [] }
    return names.filter((n) => !n.startsWith('_') && !n.includes('/') && !n.startsWith('.'))
  }

  /** 机械回退/采纳：按判定复制产物 ↔ _best-<名>（文本文件；逐文件 read/write）。
   *  adopt=true：产物 → _best-（本轮成为最佳）；adopt=false：_best- → 产物（回退到最佳）。 */
  private async convergeCopy(stepDir: string, files: string[], adopt: boolean): Promise<void> {
    for (const f of files) {
      try {
        if (adopt) {
          const content = await this.deps.readFile(`${stepDir}/${f}`)
          if (content != null) await this.deps.writeFile(`${stepDir}/${bestName(f)}`, content)
        } else {
          const content = await this.deps.readFile(`${stepDir}/${bestName(f)}`)
          if (content != null) await this.deps.writeFile(`${stepDir}/${f}`, content)
        }
      } catch { /* 单文件复制失败不阻断：最佳版本逻辑上已记录，面板轨迹仍准确 */ }
    }
  }

  /** 收敛 working：交付标记有新内容 → 派裁判评分（每轮新会话）；工人久停无标记 → 标记 stalled。
   *  【串行执行门控】本地单槽位模型（llama.cpp parallel=1）同一时刻只允许一个会话运行：
   *  工人会话仍在运行（覆写交付标记后可能还在生成收尾回复）时**等待其停**才派裁判，
   *  否则两个会话并行易卡死。 */
  private async tickConvergeWorking(projectId: string, stepId: string, stepDir: string, step: TemplateDef['steps'][number], block: TemplateBlockDef, st: StepVerifyState): Promise<void> {
    const marker = await this.deps.readFile(`${stepDir}/${deliveryMarkerName(block.id)}`)
    if (marker && marker.trim()) {
      // 【串行执行门控】工人仍在运行 → 本 tick 不派裁判，等工人停（下个 tick 复查）
      const workerSid = st.workerSid ?? this.deps.getWorkerSid(this.deps.getRun(projectId)!, stepId)
      if (workerSid && this.deps.isRunning(workerSid)) {
        // 安全阀：工人运行中却长时间无进度信号（派发时间/步骤目录最近文件活动取较新者）→ 疑似卡死，
        // 提醒用户手动停掉该会话（手动停后下个 tick 自动派裁判）；期间仍不派裁判，保持串行。
        let base = st.workerDispatchedAt ?? st.startedAt ?? 0
        if (this.deps.latestActivity) {
          const lastFileAt = await this.deps.latestActivity(stepDir).catch(() => 0)
          if (lastFileAt > 0) base = Math.max(base, lastFileAt)
        }
        const idle = base > 0 ? Date.now() - base : -1
        if (idle > WORKER_RUNNING_STALL_MS && !st.stalled) {
          this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, stalled: true } : cur)
          this.deps.notify(projectId, `⏸ 步骤「${step.title}」块「${block.title}」工人会话已运行超过 ${Math.round(WORKER_RUNNING_STALL_MS / 60000)} 分钟且无进度信号，疑似卡死：请在 DSH 会话列表手动停掉该会话（工人停后才会派裁判，避免并发会话卡死），再点「⏯ 继续本步」续跑。`, 'info')
        }
        return
      }
      if (st.stalled) this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, stalled: false } : cur)
      const round = stRoundOf(st)
      const scoreReport = `${stepDir}/${scoreReportName(round)}`
      await this.deps.writeFile(scoreReport, `PENDING 第 ${round} 轮评分报告（裁判生成中）`) // 占位防读到旧报告
      const scoreTask = composeScoreTask({
        projectName: this.deps.getProjectName(projectId),
        stepLabel: this.deps.getStepLabel(stepId), stepTitle: step.title,
        stepDir, block, round, bestScore: st.bestScore, bestVersion: st.bestVersion,
      })
      // 复用已创建但发送失败的裁判会话：不重开新会话，直接重发任务（空会话重发无副作用，避免孤儿会话堆积）
      const prevVerifier = st.verifierSid
      if (prevVerifier && !this.deps.isRunning(prevVerifier)) {
        const okResend = await this.deps.sendToSession(prevVerifier, scoreTask)
        if (okResend) {
          this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
            ...cur, phase: 'verifying', verifierSid: prevVerifier,
            verifyDispatchedAt: Date.now(), verifyAttempts: 1,
          } : cur)
          return
        }
      }
      const sid = await this.deps.createVerifierSession(stepDir, verifierTitle(this.deps.getStepLabel(stepId), block.title, round))
      if (!sid) {
        this.dispatchFailRetry(projectId, stepId, step, st, `无法创建裁判会话（步骤「${step.title}」）`)
        return
      }
      const okSend = await this.deps.sendToSession(sid, scoreTask)
      if (!okSend) {
        // 会话已建好、只是任务没送进去：记住它，下个 tick 优先重发任务（不新建）；失败计数满才暂停
        this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, verifierSid: sid } : cur)
        this.dispatchFailRetry(projectId, stepId, step, st, `评分任务发送失败（步骤「${step.title}」）`)
        return
      }
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
        ...cur, phase: 'verifying', verifierSid: sid,
        verifyDispatchedAt: Date.now(), verifyAttempts: 1,
      } : cur)
      return
    }
    // 无交付标记：工人已停 → 静默超时标记 stalled（不自动动作），供面板一键续跑
    const workerSid = st.workerSid ?? this.deps.getWorkerSid(this.deps.getRun(projectId)!, stepId)
    if (workerSid && !this.deps.isRunning(workerSid)) {
      let base = st.workerDispatchedAt ?? st.startedAt ?? 0
      if (this.deps.latestActivity) {
        const lastFileAt = await this.deps.latestActivity(stepDir).catch(() => 0)
        if (lastFileAt > 0) base = Math.max(base, lastFileAt)
      }
      const stalled = base > 0 && Date.now() - base > WORKER_WATCHDOG_MS
      if (stalled !== !!st.stalled) {
        this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, stalled } : cur)
        if (stalled) {
          const mins = Math.round(WORKER_WATCHDOG_MS / 60000)
          this.deps.notify(projectId, `⏸ 步骤「${step.title}」块「${block.title}」已静默 ${mins} 分钟（无文件活动、会话已停），疑似任务中止——面板点「⏯ 继续本步」可一键续跑（进度不丢）`, 'info')
        }
      }
    }
  }

  /** 收敛 verifying 看门狗：裁判空闲但评分报告迟迟未出 → 重派新裁判；超 3 次暂停。 */
  private async reverifyConvergeIfStale(projectId: string, stepId: string, stepDir: string, step: TemplateDef['steps'][number], block: TemplateBlockDef, st: StepVerifyState): Promise<void> {
    const attempts = st.verifyAttempts ?? 1
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'verifier-gone' } : cur)
      this.deps.notify(projectId, `⛔ 步骤「${step.title}」裁判 ${MAX_VERIFY_ATTEMPTS} 次均未交评分，已暂停——可在面板点「⏯ 继续本步」重派裁判`, 'err')
      return
    }
    const round = stRoundOf(st)
    const scoreReport = `${stepDir}/${scoreReportName(round)}`
    await this.deps.writeFile(scoreReport, `PENDING 第 ${round} 轮评分报告（第 ${attempts + 1} 次重派）`)
    const sid = await this.deps.createVerifierSession(stepDir, verifierTitle(this.deps.getStepLabel(stepId), block.title, round))
    if (!sid) {
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'verifier-gone' } : cur)
      this.deps.notify(projectId, `⚠️ 无法重派裁判（步骤「${step.title}」），已暂停收敛环`, 'err')
      return
    }
    const okSend = await this.deps.sendToSession(sid, composeScoreTask({
      projectName: this.deps.getProjectName(projectId),
      stepLabel: this.deps.getStepLabel(stepId), stepTitle: step.title,
      stepDir, block, round, bestScore: st.bestScore, bestVersion: st.bestVersion,
    }))
    if (!okSend) {
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'send-failed' } : cur)
      this.deps.notify(projectId, `⚠️ 评分任务重派发送失败（步骤「${step.title}」），已暂停收敛环`, 'err')
      return
    }
    this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
      ...cur, verifierSid: sid, verifyDispatchedAt: Date.now(), verifyAttempts: (cur.verifyAttempts ?? 0) + 1,
    } : cur)
    this.deps.notify(projectId, `🔁 步骤「${step.title}」裁判超时未交评分，已重派（第 ${attempts + 1}/${MAX_VERIFY_ATTEMPTS} 次）`, 'info')
  }

  /** 收敛 verifying：裁判空闲 + 评分报告就绪 → 解析 SCORE → 采纳/回退（机械复制）→ 终止判定 → 继续修订 / 收尾。
   *  【串行执行门控】本地单槽位模型同一时刻只允许一个会话运行：裁判仍运行时**不重派**
   *  （即便超过硬超时也只提醒用户；用户手动停掉该会话后，下个 tick 自动重派）。 */
  private async tickConvergeVerifying(projectId: string, stepId: string, stepDir: string, step: TemplateDef['steps'][number], block: TemplateBlockDef, st: StepVerifyState): Promise<void> {
    const baseCfg = block.converge
    if (!baseCfg) return
    // 硬超时优先于 isRunning：会话状态错乱时 isRunning 可能一直为真，导致收敛环永久停摆。
    // 【串行执行门控】裁判仍运行 → 只提醒、不重派（重派 = 两个裁判会话并行，本地模型易卡死）；
    // 裁判已停 → 按异常重派。
    const hardDispatchedAt = st.verifyDispatchedAt ?? 0
    if (hardDispatchedAt > 0 && Date.now() - hardDispatchedAt > VERIFY_HARD_TIMEOUT_MS) {
      if (this.deps.isRunning(st.verifierSid)) {
        const last = st.hardStallNotifiedAt ?? 0
        if (Date.now() - last > VERIFY_HARD_STALL_NOTIFY_GAP_MS) {
          this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, hardStallNotifiedAt: Date.now() } : cur)
          this.deps.notify(projectId, `⏱ 步骤「${step.title}」裁判超过 ${Math.round(VERIFY_HARD_TIMEOUT_MS / 60000)} 分钟未交评分且仍在运行：本地模型长任务属正常，**不重派**（同一时刻只允许一个会话运行，避免卡死）。若你怀疑卡死，请在 DSH 会话列表手动停掉该裁判会话，再点「⏯ 继续本步」。`, 'err')
        }
        return
      }
      this.deps.notify(projectId, `⏱ 步骤「${step.title}」裁判超过 ${Math.round(VERIFY_HARD_TIMEOUT_MS / 60000)} 分钟未交评分且会话已停，已按异常重派`, 'err')
      await this.reverifyConvergeIfStale(projectId, stepId, stepDir, step, block, st)
      return
    }
    if (this.deps.isRunning(st.verifierSid)) return // 裁判还在工作
    const round = stRoundOf(st)
    const scoreReport = `${stepDir}/${scoreReportName(round)}`
    const reportText = await this.deps.readFile(scoreReport)
    const reportReady = !!reportText && !/^PENDING/.test(reportText.trim())
    if (!reportReady) {
      const dispatchedAt = st.verifyDispatchedAt ?? 0
      if (dispatchedAt > 0 && Date.now() - dispatchedAt > VERIFY_WATCHDOG_MS) {
        await this.reverifyConvergeIfStale(projectId, stepId, stepDir, step, block, st)
      }
      return
    }
    const score = parseScore(reportText!)
    if (score == null) {
      // 报告已就绪但没有可识别的 SCORE 行（裁判漏写/格式跑偏）：超时后按"裁判异常"重派
      const dispatchedAt = st.verifyDispatchedAt ?? 0
      if (dispatchedAt > 0 && Date.now() - dispatchedAt > VERIFY_WATCHDOG_MS * 2) {
        this.deps.notify(projectId, `⚠️ 步骤「${step.title}」评分报告缺少 SCORE 判定行，已按异常重派裁判`, 'err')
        await this.reverifyConvergeIfStale(projectId, stepId, stepDir, step, block, st)
      }
      return
    }
    const run = this.deps.getRun(projectId)
    if (!run) return
    // 有效收敛参数 = 模板默认 + 本项目「⚙ 配置」覆盖（面板可改迭代次数/达标分/平台期）
    const cfg = effectiveConverge(step, run) ?? baseCfg
    const workerSid = st.workerSid ?? this.deps.getWorkerSid(run, stepId)
    if (!workerSid) {
      this.deps.notify(projectId, `⚠️ 工人会话丢失（步骤「${step.title}」），收敛环暂停：请在面板点「⏯ 继续本步」重开会话续跑`, 'err')
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'worker-gone', lastVerdict: { verdict: 'FAIL', failCount: 0, at: Date.now() } } : cur)
      return
    }

    // 采纳/回退判定 + 机械复制（产物 ↔ _best-）
    const prevBest = st.bestScore
    const adopted = prevBest == null || score > prevBest
    const files = await this.convergeDeliverableFiles(stepDir, await this.deps.readFile(`${stepDir}/${deliveryMarkerName(block.id)}`))
    await this.convergeCopy(stepDir, files, adopted)
    const newBestVersion = adopted ? round : (st.bestVersion ?? round)
    const newBestScore = adopted ? score : (st.bestScore ?? score)
    const newNoImprove = adopted ? 0 : (st.noImprove ?? 0) + 1
    const newScores = [...(st.scores ?? []), { round, score, adopted }]

    // 收敛终止判定
    let done: 'target' | 'maxrounds' | 'plateau' | null = null
    if (newBestScore >= cfg.target) done = 'target'
    else if (round >= cfg.maxRounds) done = 'maxrounds'
    else if (newNoImprove >= cfg.plateau) done = 'plateau'

    if (done) {
      // 收敛完成：最终产物 = 最佳版本（已就位）；让工人写 _本步摘要.md → 等用户终审
      await this.deps.writeFile(`${stepDir}/${deliveryMarkerName(block.id)}`, '')
      const okSend = await this.deps.sendToSession(workerSid, composeConvergeFinishTask({
        stepLabel: this.deps.getStepLabel(stepId), block,
        bestScore: newBestScore, bestVersion: newBestVersion, done, scores: newScores,
      }))
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
        ...cur, phase: 'step-passed',
        bestVersion: newBestVersion, bestScore: newBestScore, scores: newScores, noImprove: newNoImprove,
        convergeDone: done, lastVerdict: { verdict: 'PASS', failCount: 0, at: Date.now() },
        verifierSid: undefined, stalled: false,
      } : cur)
      this.deps.onStepPassed(projectId)
      const reasonText = done === 'target' ? `达标（≥${cfg.target}）` : done === 'maxrounds' ? `达轮次上限（${cfg.maxRounds}）` : `连续 ${cfg.plateau} 轮无改进`
      this.deps.notify(projectId, okSend
        ? `🎉 步骤「${step.title}」收敛完成（${reasonText}）：最佳 ${newBestScore} 分（第 ${newBestVersion} 轮）。已让工人写 _本步摘要.md，请在面板点「✓ 通过」终审`
        : `⚠️ 收敛完成但收尾指令发送失败：请在工人会话手动写 _本步摘要.md`, okSend ? 'ok' : 'err')
      return
    }

    // 未收敛：清标记 → 派修订指令 → 进入下一轮
    await this.deps.writeFile(`${stepDir}/${deliveryMarkerName(block.id)}`, '')
    const okSend = await this.deps.sendToSession(workerSid, composeConvergeReviseTask({
      stepLabel: this.deps.getStepLabel(stepId), block, round, score, adopted,
      bestScore: newBestScore, bestVersion: newBestVersion,
    }))
    this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
      ...cur, phase: 'working',
      round: cur.round + 1, stepRound: stRoundOf(cur) + 1, verifyAttempts: 0,
      bestVersion: newBestVersion, bestScore: newBestScore, scores: newScores, noImprove: newNoImprove,
      lastVerdict: { verdict: adopted ? 'PASS' : 'FAIL', failCount: 0, at: Date.now() },
      verifierSid: undefined, stalled: false, workerDispatchedAt: Date.now(),
    } : cur)
    if (!okSend) this.deps.notify(projectId, `⚠️ 修订指令发送失败（步骤「${step.title}」）：请在工人会话手动按 ${scoreReportName(round)} 修订`, 'err')
    else this.deps.notify(projectId, `🔁 步骤「${step.title}」第 ${round} 轮评分 ${score} 分（${adopted ? '采纳' : '回退'}），最佳 ${newBestScore} 分——已派修订指令，进入第 ${round + 1} 轮`, 'info')
  }

  /** 块完成后的推进（验收 PASS 与「达轮次上限强制收尾」共用）：
   *  repeatable 未完结 → 下一对象；还有下一块 → 下一块；否则整步收尾并等用户终审。
   *  forced=true = 验收未通过但已达轮次上限，通知文案不同（遗留问题见报告）。 */
  private async advanceAfterBlock(
    projectId: string, stepId: string, stepDir: string, step: TemplateDef['steps'][number],
    block: TemplateBlockDef, st: StepVerifyState,
    vd: { verdict: 'PASS' | 'FAIL'; failCount: number }, forced: boolean,
  ): Promise<void> {
    const run = this.deps.getRun(projectId)
    const workerSid = st.workerSid ?? (run ? this.deps.getWorkerSid(run, stepId) : undefined)
    const label = this.deps.getStepLabel(stepId)
    const blocks = step.blocks ?? []
    const passedCount = st.passedCount + 1
    const lastVerdict = { verdict: vd.verdict, failCount: vd.failCount, at: Date.now() }
    if (!workerSid) {
      this.deps.notify(projectId, `⚠️ 工人会话丢失（步骤「${step.title}」），已暂停：请在面板点「⏯ 继续本步」`, 'err')
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'paused', pauseReason: 'worker-gone', lastVerdict } : cur)
      return
    }
    const isRepeatDone = !!block.repeatable && !!(await this.deps.readFile(`${stepDir}/${doneMarkerName(block.id)}`))
    if (block.repeatable && !isRepeatDone) {
      // 【顺序铁律】先清标记再发指令，避免工人抢跑覆写后被清空抹掉（导致后续交付不被识别）
      await this.deps.writeFile(`${stepDir}/${deliveryMarkerName(block.id)}`, '')
      const okSend = await this.deps.sendToSession(workerSid, composeContinueRepeatTask(label, block, passedCount))
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
        ...cur, phase: 'working', passedCount, verifyAttempts: 0,
        round: cur.round + 1, stepRound: stRoundOf(cur) + 1, // 换对象：块内轮次与累计轮次都 +1
        finalRevise: false, // 换对象即重置"已派改稿"标记，否则新对象首轮交付会被误判已改完而直接推进
        lastVerdict, verifierSid: undefined, stalled: false, workerDispatchedAt: Date.now(),
      } : cur)
      if (okSend) this.deps.notify(projectId, `✅ 步骤「${step.title}」第 ${passedCount} 个对象通过验收，继续下一个`, 'ok')
      return
    }
    const nextIdx = st.blockIdx + 1
    if (nextIdx < blocks.length) {
      const next = blocks[nextIdx]
      // 【顺序铁律】两块标记都在发指令前清空（含下一块，防同名残留）
      await this.deps.writeFile(`${stepDir}/${deliveryMarkerName(block.id)}`, '') // 清空当前块标记防重复触发
      await this.deps.writeFile(`${stepDir}/${deliveryMarkerName(next.id)}`, '') // 清空下一块标记防同名残留
      const okSend = await this.deps.sendToSession(workerSid, composeNextBlockTask(label, next))
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
        ...cur, phase: 'working', blockIdx: nextIdx, passedCount: 0, verifyAttempts: 0,
        round: 1, // 块内轮次重置（一轮验收：每块只验收 1 轮）
        stepRound: stRoundOf(cur) + 1, // 累计轮次继续递增，绝不回退 → 面板/会话标题不会显示"回到第 1 轮"
        lastVerdict, verifierSid: undefined, stalled: false, finalRevise: false, workerDispatchedAt: Date.now(),
      } : cur)
      if (okSend) this.deps.notify(projectId, forced
        ? `🔁 步骤「${step.title}」块「${block.title}」验收未过但已按报告改完（遗留项见最新验收报告），开始下一块「${next.title}」`
        : `✅ 步骤「${step.title}」块「${block.title}」通过，开始下一块「${next.title}」`, forced ? 'info' : 'ok')
      return
    }
    // 全部块完成 → 等用户终审
    await this.deps.writeFile(`${stepDir}/${deliveryMarkerName(block.id)}`, '') // 清空当前块标记防重复触发
    await this.deps.sendToSession(workerSid, composeFinishTask(label))
    this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
      ...cur, phase: 'step-passed', passedCount, stalled: false, finalRevise: false,
      lastVerdict, verifierSid: undefined,
    } : cur)
    this.deps.onStepPassed(projectId)
    this.deps.notify(projectId, forced
      ? `🔁 步骤「${step.title}」验收未过但已按报告改完（本块不再复验）：请打开各块最新 _验收_*.md 查看遗留项并人工确认，无误后点「✓ 通过」（要返工可点「🔄 重置」）`
      : `🎉 步骤「${step.title}」全部块通过独立验收！请在面板点「✓ 通过」终审（验收报告与产出在本步骤目录）`, forced ? 'info' : 'ok')
  }

  /* ─────────────────────── 用户主动停止 / 恢复（面板「⏹ 停止」/「⏯ 继续本步」） ─────────────────────── */

  /** 手动停止（面板「⏹ 停止」）：
   *  - 先置 userStopped 标记（**先于** cancel：cancel 期间快照变化会触发 tick，先标记可防 tick 重派），
   *    调度器从此整体跳过本步——不再自动派验收员/裁判、不重派、不向已停会话重发任务；
   *  - 再中断在跑的工人/验收员/裁判会话（cancelSession）；
   *  - 进度（块/轮次/最佳版本/分数轨迹）全保留；「⏯ 继续本步」清除标记后按当前阶段续跑。 */
  async stopStep(projectId: string, stepId: string): Promise<string> {
    const run = this.deps.getRun(projectId)
    const tmpl = run ? this.deps.getTemplate(run) : undefined
    if (!run || !tmpl) return '⚠️ 项目状态丢失：请刷新页面后重试。'
    const step = tmpl.steps.find((s) => s.id === stepId)
    if (!step) return '⚠️ 找不到该步骤。'
    const st = run.verify?.[stepId]
    if (!st) return 'ℹ️ 本步尚未开工，无需停止。'
    if (st.userStopped) return 'ℹ️ 本步已处于停止状态：点「⏯ 继续本步」可恢复（进度不丢）。'
    this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, userStopped: true, stalled: false, hardStallNotifiedAt: undefined } : cur)
    const sids: string[] = []
    const workerSid = st.workerSid ?? this.deps.getWorkerSid(run, stepId)
    if (workerSid && this.deps.isRunning(workerSid)) sids.push(workerSid)
    if (st.verifierSid && this.deps.isRunning(st.verifierSid)) sids.push(st.verifierSid)
    let cancelled = 0
    for (const sid of sids) {
      try { if (await this.deps.cancelSession(sid)) cancelled++ } catch { /* 单会话中断失败不阻断停止流程 */ }
    }
    this.deps.notify(projectId, `⏹ 步骤「${step.title}」已手动停止${cancelled > 0 ? `（已中断 ${cancelled} 个在跑会话）` : ''}：调度器不再自动派验收/裁判，也不会再开新会话。点「⏯ 继续本步」可随时恢复（进度不丢）。`, 'info')
    return `⏹ 已停止步骤「${step.title}」：不再自动派单/开会话；点「⏯ 继续本步」恢复（进度不丢）。`
  }

  /** 一键继续：按当前阶段智能续跑，**不重置进度**（区别于 startFlowStep 首次开工）。
   *  - working（含 paused 恢复）：无交付 → 催工人接着做；有交付 → 恢复 working，验收员下个 tick 自动派发；
   *  - verifying：报告未出 → 重派验收员。
   *  返回面板反馈文案。 */
  async resumeStep(projectId: string, stepId: string): Promise<string> {
    const run = this.deps.getRun(projectId)
    const tmpl = run ? this.deps.getTemplate(run) : undefined
    if (!run || !tmpl) return '⚠️ 项目状态丢失：请刷新页面后重试。'
    const step = tmpl.steps.find((s) => s.id === stepId)
    if (!step) return '⚠️ 找不到该步骤。'
    const blocks = step.blocks ?? []
    if (blocks.length === 0) return 'ℹ️ 本步没有分块验收环，直接在步骤会话里继续即可。'
    let st = run.verify?.[stepId]
    if (!st) return 'ℹ️ 本步尚未开工：请先点「▶ 开始此步」。'
    // 手动停止后恢复：先清除停止标记（调度器随即恢复自动派单），再按当前阶段续跑
    if (st.userStopped) {
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, userStopped: false } : cur)
      st = { ...st, userStopped: false }
    }
    if (st.phase === 'step-passed') return 'ℹ️ 本步全部块已通过验收，点「✓ 通过」终审即可。'
    const folder = this.deps.getFolder(projectId)
    if (!folder) return '⚠️ 项目未设置文件夹。'
    const stepDir = `${folder}/${step.dir}`
    const block = blocks[Math.min(st.blockIdx, blocks.length - 1)]
    const workerSid = st.workerSid ?? this.deps.getWorkerSid(run, stepId)
    if (!workerSid) return '⚠️ 工人会话丢失：请在步骤目录重新开会话后点「▶ 开始此步」。'
    // 续跑前先与磁盘报告对齐轮次：意外中止（刷新/崩溃）后状态可能滞后，绝不能因此从第 1 轮重跑
    st = await this.syncRoundFromDisk(projectId, stepId, stepDir, block, st)
    const shownRound = stRoundOf(st) // 本步累计轮次（跨块不回退）
    const stepLabel = this.deps.getStepLabel(stepId)

    // ── 迭代收敛步：续跑逻辑同构，但报告是评分报告（_评分_R<N>.md），派的是裁判 ──
    // 【串行执行门控】本地单槽位模型同一时刻只允许一个会话运行：裁判会话仍在运行时，
    // 既不唤醒工人也不重派裁判（否则两个会话并行易卡死）；用户手动停掉该裁判会话后再点一次即可续跑。
    if (isConvergeStep(step)) {
      if (st.verifierSid && this.deps.isRunning(st.verifierSid)) {
        return 'ℹ️ 裁判会话仍在运行：本地模型同一时刻只允许一个会话运行，暂不唤醒工人/重派裁判。若裁判卡死，请先在 DSH 会话列表手动停掉该裁判会话，再点「⏯ 继续本步」。'
      }
      if (st.phase === 'working' || st.phase === 'paused') {
        const marker = await this.deps.readFile(`${stepDir}/${deliveryMarkerName(block.id)}`)
        if (marker && marker.trim()) {
          if (st.phase === 'paused') {
            this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'working', pauseReason: undefined, verifyAttempts: 0 } : cur)
          }
          return 'ℹ️ 已检测到本轮交付物：裁判正在派发中，无需操作（如 1 分钟不动可再点一次）。'
        }
        const okSend = await this.deps.sendToSession(workerSid, composeResumeTask({ stepLabel, block, round: shownRound, passedCount: st.passedCount }))
        this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'working', pauseReason: undefined, stalled: false, workerDispatchedAt: Date.now() } : cur)
        return okSend
          ? `✅ 已续跑：请工人接着完成本轮修订（第 ${shownRound} 轮，进度未重置）。交付后自动进入评分。`
          : '⚠️ 续跑指令发送失败：请在工人会话里手动说「继续完成当前轮修订，完成后覆写交付标记」。'
      }
      // verifying：评分报告已出就等判定；没出就重派裁判（上方串行门控已保证裁判不在运行）
      const scoreReport = `${stepDir}/${scoreReportName(shownRound)}`
      const reportText = await this.deps.readFile(scoreReport)
      const ready = !!reportText && !/^PENDING/.test(String(reportText).trim())
      if (ready) return 'ℹ️ 本轮评分报告已就绪，正在处理判定（无需操作，几秒后自动刷新）。'
      await this.deps.writeFile(scoreReport, `PENDING 第 ${shownRound} 轮评分报告（用户手动重派）`)
      const sid = await this.deps.createVerifierSession(stepDir, verifierTitle(stepLabel, block.title, shownRound))
      if (!sid) return '⚠️ 无法创建裁判会话：请检查模型服务后重试。'
      const okSend = await this.deps.sendToSession(sid, composeScoreTask({
        projectName: this.deps.getProjectName(projectId),
        stepLabel, stepTitle: step.title,
        stepDir, block, round: shownRound, bestScore: st.bestScore, bestVersion: st.bestVersion,
      }))
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
        ...cur, verifierSid: sid, verifyDispatchedAt: Date.now(), verifyAttempts: 1, stalled: false,
      } : cur)
      return okSend
        ? `✅ 已重派裁判评分本轮（第 ${shownRound} 轮）。`
        : '⚠️ 评分任务发送失败：请稍后重试。'
    }

    // ① working / paused：有交付就等验收（paused 的 verifier-gone / send-failed 恢复后，下个 tick 自动派验收员）；没有就催工人接着做
    if (st.phase === 'working' || st.phase === 'paused') {
      const marker = await this.deps.readFile(`${stepDir}/${deliveryMarkerName(block.id)}`)
      if (marker && marker.trim()) {
        if (st.phase === 'paused') {
          this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'working', pauseReason: undefined, verifyAttempts: 0 } : cur)
        }
        return 'ℹ️ 已检测到本块交付物：验收员正在派发中，无需操作（如 1 分钟不动可再点一次）。'
      }
      const okSend = await this.deps.sendToSession(workerSid, composeResumeTask({ stepLabel, block, round: shownRound, passedCount: st.passedCount }))
      this.deps.patchVerify(projectId, stepId, (cur) => cur ? { ...cur, phase: 'working', pauseReason: undefined, stalled: false, workerDispatchedAt: Date.now() } : cur)
      return okSend
        ? `✅ 已续跑：请工人接着完成块「${block.title}」（第 ${shownRound} 轮，进度未重置）。交付后自动进入验收。`
        : '⚠️ 续跑指令发送失败：请在工人会话里手动说「继续完成当前块，完成后覆写交付标记」。'
    }

    // ② verifying：报告已出就等判定；报告没出就重派验收员
    const reportText = await this.deps.readFile(`${stepDir}/${reportName(block.id, shownRound)}`)
    const ready = !!reportText && !/^PENDING/.test(String(reportText).trim())
    if (ready) return 'ℹ️ 本轮验收报告已就绪，正在处理判定（无需操作，几秒后自动刷新）。'
    await this.deps.writeFile(`${stepDir}/${reportName(block.id, shownRound)}`, `PENDING 第 ${shownRound} 轮验收报告（用户手动重派）`)
    const sid = await this.deps.createVerifierSession(stepDir, verifierTitle(stepLabel, block.title, shownRound))
    if (!sid) return '⚠️ 无法创建验收员会话：请检查模型服务后重试。'
    const okSend = await this.deps.sendToSession(sid, composeVerifyTask({
      projectName: this.deps.getProjectName(projectId),
      stepLabel, stepTitle: step.title,
      stepDir, block, round: shownRound, objectNo: st.passedCount + 1,
    }))
    this.deps.patchVerify(projectId, stepId, (cur) => cur ? {
      ...cur, verifierSid: sid, verifyDispatchedAt: Date.now(), verifyAttempts: 1, stalled: false,
    } : cur)
    return okSend
      ? `✅ 已重派验收员核验块「${block.title}」（第 ${shownRound} 轮）。`
      : '⚠️ 验收任务发送失败：请稍后重试。'
  }
}
