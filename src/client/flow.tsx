/**
 * dsh-worktable「模板流程」窗格（FlowPane，MVP）
 *
 * 模板项目打开时其主内容窗渲染本组件：展示固定流程步骤条。
 * - 每步一个小图标；skipped（起始步之前）无需完成；locked 前序未通过；current 当前可执行；done 绿标。
 * - 「▶ 开始此步」：创建该步子目录（到该步才出现）→ 把任务/硬性要求落盘为该目录 _本步要求.md → 在子目录开会话（复用已建）并切过去（不填输入框、不自动发送，由你在会话里发出开始指令）。
 * - 「✓ 通过」：用户确认 AI 已交付后绿标解锁下一步；「↩ 撤回」可退回重走。
 * - 「⚙」：配置该步技能/补充说明（自动保存到模板，后续新建项目即最新）。
 * 数据与动作经宿主注入的 flow 桥（window.__dshCustomEnv.flow，index.tsx 实现）。
 */
import { useEffect, useRef, useState } from 'react'
import { cachedSkillOptions, loadSkillOptions, type FlowEnv, type FlowStepOverride, type FlowStepView, type FlowView, type SkillOption } from './templates'

function flowEnv(): FlowEnv | undefined {
  try {
    const e = (window as any).__dshCustomEnv
    return e && typeof e === 'object' ? (e.flow as FlowEnv | undefined) : undefined
  } catch {
    return undefined
  }
}

export function FlowPane(props: { projectId: string }) {
  const { projectId } = props
  const [view, setView] = useState<FlowView | null>(null)
  const [fb, setFb] = useState<{ text: string; kind: 'ok' | 'err' | 'info' } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [editFor, setEditFor] = useState<string | null>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [instDraft, setInstDraft] = useState('')
  /** ⚙ 配置：迭代收敛参数草稿（仅收敛步显示；字符串保存以便输入框可清空重填） */
  const [convRounds, setConvRounds] = useState('8')
  const [convTarget, setConvTarget] = useState('93')
  const [convPlateau, setConvPlateau] = useState('2')
  const [briefOpen, setBriefOpen] = useState(false)
  const [briefDraft, setBriefDraft] = useState('')
  /** 「📝 初始信息」按步编辑：briefEditFor = 正在编辑的步骤 id；briefDraft2 = 该步草稿 */
  const [briefEditFor, setBriefEditFor] = useState<string | null>(null)
  const [briefDraft2, setBriefDraft2] = useState('')
  /** 各步验收清单折叠态（默认收起） */
  const [accOpen, setAccOpen] = useState<Record<string, boolean>>({})
  /** 流程总览展开态（一屏看清 10 步 × 各块 × 产物文件名 × 验收条数） */
  const [overviewOpen, setOverviewOpen] = useState(false)
  /** 已弹通知的 at（view.alert.at 变化才弹，避免重复） */
  const [alertShownAt, setAlertShownAt] = useState(0)
  /** 技能候选：来自宿主实时扫描的本机技能目录（全局 + 项目），不是插件里写死的清单 */
  const [skills, setSkills] = useState<SkillOption[]>(cachedSkillOptions)
  const fbTimer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    void loadSkillOptions().then((list) => { if (alive) setSkills(list) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const flash = (text: string, kind: 'ok' | 'err' | 'info' = text.startsWith('✅') ? 'ok' : text.startsWith('⚠️') ? 'err' : 'info') => {
    setFb({ text, kind })
    if (fbTimer.current) window.clearTimeout(fbTimer.current)
    fbTimer.current = window.setTimeout(() => setFb(null), 7000)
  }

  useEffect(() => {
    const env = flowEnv()
    if (!env) return
    const refresh = () => {
      try {
        const v = env.getView(projectId)
        setView(v)
      } catch {
        /* ignore */
      }
    }
    refresh()
    return env.subscribe(refresh)
  }, [projectId])

  useEffect(
    () => () => {
      if (fbTimer.current) window.clearTimeout(fbTimer.current)
    },
    [],
  )

  /** 验收环通知（调度器写入 view.alert；at 变化时弹一次 toast） */
  useEffect(() => {
    const a = view?.alert
    if (a && a.at > alertShownAt) {
      setAlertShownAt(a.at)
      flash(a.msg, a.kind)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.alert?.at])

  if (!view) {
    return (
      <div className="dsh-wt_flow dsh-wt_flowEmpty">
        <span aria-hidden>📋</span>
        <p>该窗格需要绑定一个「模板项目」的流程。请从模板创建项目（新建时选择模板），或把本窗格切换到模板项目的视图。</p>
      </div>
    )
  }

  const env = flowEnv()
  const inRangeTotal = view.total - view.startIndex
  const pct = inRangeTotal > 0 ? Math.round((view.doneCount / inRangeTotal) * 100) : 100

  const doStart = async (st: FlowStepView) => {
    // 不置灰：点击始终有效 = 准备/进入（或回到）该步专属会话；busyId 仅防止并发重入
    if (!env || busyId) return
    setBusyId(st.id)
    try {
      const text = await env.start(projectId, st.id)
      flash(text)
    } catch (e) {
      flash('⚠️ 准备失败：' + String(e))
    } finally {
      setBusyId(null)
    }
  }

  const openEdit = (st: FlowStepView) => {
    setEditFor(st.id)
    setBriefEditFor(null)
    setSkillDraft(st.skill)
    setInstDraft(st.instruction)
    // 收敛步：把当前生效值填进草稿（模板默认叠加本项目覆盖后的结果）
    setConvRounds(String(st.converge?.maxRounds ?? 8))
    setConvTarget(String(st.converge?.target ?? 93))
    setConvPlateau(String(st.converge?.plateau ?? 2))
  }

  /** 打开某步「📝 初始信息」编辑：预填 = 已保存稿 ?? 模板针对性默认（【】中为待用户替换的占位内容） */
  const openBriefEdit = (st: FlowStepView) => {
    setBriefEditFor(st.id)
    setEditFor(null)
    setBriefDraft2(st.briefSaved ?? st.briefDefault ?? '')
  }

  /** 一键打开某步对应子目录（系统资源管理器）：目录不存在则先自动创建（空目录），再调服务端打开 */
  const openDir = async (st: FlowStepView) => {
    if (opening) return
    const folder = view.folder
    if (!folder) { flash('⚠️ 该项目未设置文件夹，无法打开目录'); return }
    const dir = folder.replace(/[\\/]+$/, '') + '/' + st.dir
    setOpening(st.id)
    try {
      try {
        await fetch('/api/worktable/mkdir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }) })
      } catch { /* 已存在或父目录缺失都继续尝试打开 */ }
      const r = await fetch('/api/worktable/open-folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }) })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok) flash('📂 已在系统资源管理器中打开：' + st.dir + '/')
      else flash('⚠️ 打开失败：' + String(d?.error ?? r.status))
    } catch (e) {
      flash('⚠️ 打开失败：' + String(e))
    } finally {
      setOpening(null)
    }
  }

  const saveEdit = (st: FlowStepView) => {
    const o: FlowStepOverride = {
      // 空串 = 显式清空（该步回到「不指定技能」），不可再转 undefined（undefined 会被合并逻辑当作“保留旧值”）
      skill: skillDraft.trim(),
      instruction: instDraft.trim(),
    }
    // 收敛步：把三个参数一并保存（越界夹紧；输入非法则回退到当前生效值，避免存进 NaN）
    if (st.converge) {
      const num = (raw: string, lo: number, hi: number, fallback: number) => {
        const n = Math.round(Number(raw))
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
      }
      o.converge = {
        maxRounds: num(convRounds, 1, 99, st.converge.maxRounds),
        target: num(convTarget, 0, 100, st.converge.target),
        plateau: num(convPlateau, 1, 99, st.converge.plateau),
      }
    }
    env?.setOverride(projectId, st.id, o)
    setEditFor(null)
    flash(st.converge
      ? `✅ 配置已保存（最多 ${o.converge!.maxRounds} 轮 · 收敛分数 ${o.converge!.target} 分 · 平台期 ${o.converge!.plateau} 轮），并已同步到模板`
      : '✅ 配置已保存，并已同步到模板（之后用此模板新建的项目都是最新配置）')
  }

  const toggleBrief = () => {
    if (!briefOpen) setBriefDraft(view.brief)
    setBriefOpen((v) => !v)
  }

  /** 迭代收敛项目（任一步任一块带 converge 配置）：任务定义/评分标准由用户在此填写，文案随之切换 */
  const isConvergeProject = view.steps.some((s) => (s.blocks ?? []).some((b) => b.converge))

  const saveBrief = () => {
    env?.setBrief(projectId, briefDraft)
    flash(isConvergeProject
      ? '✅ 任务定义已保存：开工时写入本步 _本步要求.md 的「项目全貌」；若写了「## 评分细则」，裁判第 1 轮会遵循并冻结为 _rubric.md'
      : '✅ 项目概况已保存：之后每次「开始此步」或步骤完成时，会自动写入每个步骤 _本步要求.md 的「项目全貌」（随进度更新）')
  }

  const curStep = view.steps.find((s) => s.status === 'current') ?? null

  return (
    <div className="dsh-wt_flow">
      <div className="dsh-wt_flowHead">
        <div className="dsh-wt_flowTitleRow">
          <span className="dsh-wt_flowIcon" aria-hidden>{view.templateIcon}</span>
          <div className="dsh-wt_flowTitles">
            <span className="dsh-wt_flowName">{view.projectName}</span>
            <span className="dsh-wt_flowTemplate">{view.templateName}{view.startIndex > 0 ? ` · 自第 ${view.startIndex + 1} 步起` : ''}</span>
          </div>
          <span className="dsh-wt_flowPct" title={`有效区间 ${view.doneCount}/${inRangeTotal} 步已通过`}>{pct}%</span>
        </div>
        <div className="dsh-wt_flowProgress"><span style={{ width: pct + '%' }} /></div>
        <div className="dsh-wt_flowMeta">
          <span className="dsh-wt_flowDir" title={view.folder}>📁 {view.folder}</span>
          <span className={'dsh-wt_flowStepSessionTag ' + (view.sessionReady ? 'dsh-wt_flowSessionOn' : 'dsh-wt_flowSessionOff')}>
            {view.allDone ? '全部完成' : view.sessionReady ? '当前步专属会话已就绪' : '当前步会话未建：点「开始此步」自动创建'}
          </span>
          <button type="button" className="dsh-wt_flowBriefToggle"
            title={isConvergeProject
              ? '填写/查看本项目的任务定义与评分标准（未填写时「开始此步」会被拦住；内容随进度写入 _本步要求.md 的「项目全貌」）'
              : '填写/查看论文写作全局信息（可选补充，不填不影响开工——每步开工的必需信息在各步「📝 初始信息」里确认；内容随进度写入每个步骤 _本步要求.md 的「项目全貌」）'}
            onClick={toggleBrief}>{briefOpen ? '收起 ▲' : (isConvergeProject ? '📝 任务定义' : '📝 项目概况') + (view.brief ? ' ✓' : isConvergeProject ? ' ⚠️未填' : '')}</button>
          {!isConvergeProject && (
            <>
              <button type="button" className="dsh-wt_flowBriefToggle" title="把初稿文件（md/docx/pdf/tex）放进项目根目录后点此：AI 对 10 步逐项体检，产出《_诊断报告.md》与建议起始步"
                onClick={async () => { if (!env) return; flash(await env.startDiagnosis(projectId)) }}>🩺 初稿诊断定位</button>
              <button type="button" className="dsh-wt_flowBriefToggle" title="读取《_诊断报告.md》的建议起始步（DIAG_START_STEP），把流程起始步设到那里：中途接管初稿"
                onClick={async () => { if (!env) return; flash(await env.applyDiagnosis(projectId)) }}>📌 应用诊断起始步</button>
            </>
          )}
          <button type="button" className="dsh-wt_flowBriefToggle" title={`一屏看清全部 ${view.steps.length} 步：每步各块的固定产物文件名与验收条数（命名规范唯一权威来源）`}
            onClick={() => setOverviewOpen((v) => !v)}>📖 流程总览{overviewOpen ? ' ▲' : ''}</button>
        </div>
        {overviewOpen && (
          <div className="dsh-wt_flowOv">
            <div className="dsh-wt_flowOvHead">
              <b>{view.templateName}</b> · {view.steps.length} 步 / {view.steps.reduce((n, s) => n + (s.blocks?.length ?? 0), 0)} 块 ·{' '}
              <span className="dsh-wt_flowOvLegend">过程文件（<code>_</code> 开头）不属于交付物，找产物时忽略即得干净目录</span>
            </div>
            {view.steps.map((s, i) => {
              const stTag = s.status === 'done' ? '✅' : s.status === 'current' ? '▶' : s.status === 'skipped' ? '–' : '🔒'
              return (
                <div key={s.id} className="dsh-wt_flowOvStep">
                  <div className="dsh-wt_flowOvStepHead">
                    <span className="dsh-wt_flowOvNo">{stTag} {i + 1}</span>
                    <span className="dsh-wt_flowOvTitle">{s.icon} {s.title}</span>
                    <code className="dsh-wt_flowOvDir">{s.dir}/</code>
                  </div>
                  {(s.blocks ?? []).map((b) => (
                    <div key={b.id} className="dsh-wt_flowOvBlock">
                      <span className="dsh-wt_flowOvBlockName">{b.title}{b.repeatable ? '（逐对象）' : ''}</span>
                      <span className="dsh-wt_flowOvFiles">{(b.files ?? []).map((f) => <code key={f}>{f}</code>)}</span>
                      <span className="dsh-wt_flowOvMeta">{b.converge
                        ? <>收敛：达标 ≥ <code>{b.converge.target}</code> ／ 上限 <code>{b.converge.maxRounds}</code> 轮 ／ 平台期 <code>{b.converge.plateau}</code> 轮无改进 · 标记 <code>_交付_{b.id}.md</code></>
                        : <>验收标准见 <code>02-十步验收标准.md</code> · 标记 <code>_交付_{b.id}.md</code></>}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
        {briefOpen && (
          <div className="dsh-wt_flowBrief">
            <div className="dsh-wt_flowBriefLabel">{isConvergeProject
              ? '任务定义（Markdown）——必填：任务正文（做什么/产出什么/约束）+ 可选评分细则。未填写时点「▶ 开始此步」会被拦住，避免空任务空跑'
              : '项目概况（Markdown，可选）——全局补充信息：填了会随进度自动写入每个步骤 _本步要求.md 的「项目全貌」。开工必需的是各步自己的「📝 初始信息」，不是本项'}</div>
            <textarea value={briefDraft} rows={10} spellCheck={false}
              placeholder={isConvergeProject
                ? '【必填】任务正文（越具体越好）：\n- 要做什么（任务目标）\n- 要产出什么（产物文件名 + 格式，如 01-报告.md / 01-脚本.py）\n- 输入与素材（文件放哪、用什么数据）\n- 硬约束（技术栈/字数/必须包含或禁止的内容/验收关注点）\n\n【可选】评分细则（写了则裁判第 1 轮必须遵循并冻结为 _rubric.md；不写则由裁判第 1 轮自行定义）：\n## 评分细则\n- 维度A（权重 0.4）：90-100=…；75-89=…；60-74=…；<60=…\n- 维度B（权重 0.3）：…\n（各维度权重之和 = 1）'
                : '可自由增删（均为可选）：\n- 论文题目（可暂定）\n- 研究问题与目标\n- 方法与技术路线\n- 数据 / 算例 / 实验\n- 预期创新点\n- 目标期刊、篇幅与语言要求\n- 关键术语与符号约定\n- 需全局遵守的写作偏好与红线'}
              onChange={(e) => setBriefDraft(e.target.value)} />
            <div className="dsh-wt_flowBriefBtns">
              <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpPrimary" onClick={saveBrief}>{isConvergeProject ? '保存任务定义' : '保存概况'}</button>
              <button type="button" className="dsh-wt_flowOp" onClick={toggleBrief}>取消</button>
            </div>
          </div>
        )}
        {view.allDone && <div className="dsh-wt_flowAllDone">🎉 模板流程全部完成！交付物在各步骤子目录（见 <b>{view.folder}</b>）；每步目录里的 <b>_本步要求.md</b> 都带有最新的项目全貌（进度 / 各步核心信息与文件结构），可随时打开查看。</div>}
        {!view.allDone && curStep && (
          <div className="dsh-wt_flowHint">
            当前步骤：<b>{curStep.icon} {curStep.title}</b>。{curStep.blocks && curStep.blocks.length > 0
              ? (curStep.blocks.some((b) => b.converge)
                ? <>先点「<b>📝 任务定义</b>」写清<b>要做什么 / 产出什么</b>（未填不会开工）→ 再点「▶ 开始此步」→ <b>迭代收敛模式</b>：任务自动发入本步专属会话，工人产出 → 每轮由独立裁判（新会话）按 _rubric.md JSON 评分，仅当新分高于旧分才采纳、否则回退保留最佳版本；循环至达标／达轮次上限／连续无改进。收敛后你只需点「✓ 通过」终审。中途异常可点「⏯ 继续本步」一键续跑（进度不丢）。</>
                : <>先点本步「<b>📝 初始信息</b>」确认/修改针对性提示词（默认已按本步任务预填，<b>未确认不会开工</b>）→ 再点「▶ 开始此步」→ <b>自动模式</b>：任务自动发入本步专属会话，工人按「分块交付与验收协议」逐块交付；每轮由独立验收员会话（stage-verifier）自动核验——PASS 自动推进、FAIL 自动打回（连续 3 轮暂停并给出可执行方案）；全部块通过后你只需点「✓ 通过」终审。中途任务异常中止可点「⏯ 继续本步」一键续跑（进度不丢）。</>)
              : <>点「▶ 开始此步」→ 创建子目录 <b>{curStep.dir}/</b> 并把任务/硬性要求写入该目录 <b>_本步要求.md</b>，然后自动切到该步专属会话。在会话里发出开始指令（例如「先读 _本步要求.md，然后执行本步」）即开工。AI 交付后点「✓ 通过」解锁下一步。</>}
          </div>
        )}
      </div>

      <div className="dsh-wt_flowList">
        {view.steps.map((st, i) => {
          const isCur = st.status === 'current'
          const isDone = st.status === 'done'
          const isSkipped = st.status === 'skipped'
          const locked = st.status === 'locked'
          return (
            <div key={st.id} className={'dsh-wt_flowStep dsh-wt_flowStep-' + st.status} data-step={st.id}>
              <div className="dsh-wt_flowStepMark" aria-hidden>
                {isDone ? <span className="dsh-wt_flowStepDoneMark">✓</span> : isSkipped ? <span className="dsh-wt_flowStepSkipMark">–</span> : <span className="dsh-wt_flowStepNo">{i + 1}</span>}
              </div>
              <div className="dsh-wt_flowStepBody">
                <div className="dsh-wt_flowStepTitleRow">
                  <span className="dsh-wt_flowStepIcon" aria-hidden>{st.icon}</span>
                  <span className="dsh-wt_flowStepTitle">{st.title}</span>
                  <span className="dsh-wt_flowStepDir" title="交付物归档目录">{st.dir}/</span>
                  {isDone && <span className="dsh-wt_flowStepBadge">已通过</span>}
                  {isCur && <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgeCur">进行中</span>}
                  {isSkipped && <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgeSkip">跳过（起始步之前）</span>}
                  {locked && <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgeLock">🔒 前序未完成</span>}
                  {isCur && st.verify && st.verify.stalled && st.verify.phase === 'working' && !st.verify.userStopped && (
                    <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgePause" title="工人会话已停止且长时间无交付：任务可能非正常中止（点「⏯ 继续本步」一键续跑，进度不丢）">⏸ 疑似中止 · 可一键继续</span>
                  )}
                  {isCur && st.verify && st.verify.userStopped && (
                    <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgePause" title="已手动停止：在跑的工人/验收员/裁判会话已被中断，调度器不再自动派单、不再开新会话；点「⏯ 继续本步」恢复（进度不丢）">⏹ 已手动停止 · 点「继续本步」恢复</span>
                  )}
                  {isCur && st.verify && st.verify.phase === 'working' && st.verify.finalRevise && !st.verify.userStopped && (
                    <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgeWork" title="本块验收未过（一轮验收：每块只验收 1 轮）：已派改稿指令，工人改完覆写标记后自动进入下一块（本块不再复验；未过项见最新验收报告与本步摘要）">🔁 改稿中 · 改完自动进下一块</span>
                  )}
                  {isCur && st.verify && st.verify.phase === 'working' && !st.verify.stalled && !st.verify.finalRevise && !st.verify.userStopped && (
                    <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgeWork" title="工人交付中；交付后自动派验收员">🔨 工人交付中</span>
                  )}
                  {isCur && st.verify && st.verify.phase === 'verifying' && !st.verify.userStopped && (
                    (st.blocks ?? []).some((b) => b.converge)
                      ? <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgeVerify" title="独立裁判（新会话）正在按 _rubric.md 评分">⚖ 裁判评分中（第 {st.verify.stepRound ?? st.verify.round} 轮）</span>
                      : <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgeVerify" title="独立验收员（stage-verifier）正在逐条核验">🔍 验收员核验中（第 {st.verify.stepRound ?? st.verify.round} 轮）</span>
                  )}
                  {isCur && st.verify && st.verify.phase === 'paused' && (
                    <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgePause" title="验收环已暂停（验收员失联 / 任务发送失败 / 工人会话丢失）：可点「⏯ 继续本步」尝试恢复，或打开报告 / 重置本步">⛔ 验收暂停 · 待你介入</span>
                  )}
                  {isCur && st.verify && st.verify.phase === 'step-passed' && (
                    <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgePassAll" title="全部块已通过独立验收：请检查产物后点「✓ 通过」终审">🎉 全部块通过 · 待终审</span>
                  )}
                  {!isConvergeProject && isCur && !st.briefConfirmed && (
                    <span className="dsh-wt_flowStepBadge dsh-wt_flowStepBadgeLock" title="本步「初始信息」尚未确认：点本步「📝 初始信息」把默认提示词改成你的实际情况并保存，否则「开始此步」会被拦住">📝 初始信息待确认</span>
                  )}
                </div>
                <div className="dsh-wt_flowStepDeliver">{st.deliverable}</div>
                {(() => {
                  const files = (st.blocks ?? []).flatMap((b) => b.files ?? [])
                  if (files.length === 0) return null
                  return (
                    <div className="dsh-wt_flowStepFiles" title="本步产物文件名（命名规范：步号-语义；`<...>` 占位符、`*` 通配）">
                      {files.map((f) => <code key={f}>{f}</code>)}
                    </div>
                  )
                })()}
                {isCur && st.verify?.lastVerdict && (
                  <div className="dsh-wt_flowStepConf" title="独立验收员/裁判最近一轮判定">
                    <span className="dsh-wt_flowStepInst">
                      {st.verify.lastVerdict.verdict === 'PASS' ? '✅' : '❌'} 第 {Math.max(1, (st.verify.stepRound ?? st.verify.round) - (st.verify.phase === 'working' ? 1 : 0))} 轮判定：
                      {st.verify.lastVerdict.verdict}{st.verify.lastVerdict.failCount > 0 ? `（${st.verify.lastVerdict.failCount} 项未过）` : ''}
                    </span>
                  </div>
                )}
                {isCur && st.verify && (st.blocks ?? []).some((b) => b.converge) && (
                  <div className="dsh-wt_flowStepConf" title="迭代收敛：分数轨迹（✓=采纳 新分>旧分；↩=回退 保留最佳版本）。参数可在「⚙ 配置」里改">
                    <span className="dsh-wt_flowStepInst">
                      📈 收敛：最佳 <b>{st.verify.bestScore ?? '—'}</b> 分
                      {st.verify.bestVersion ? `（第 ${st.verify.bestVersion} 轮）` : ''}
                      {st.converge && <> · 上限 <b>{st.converge.maxRounds}</b> 轮 · 收敛分数 <b>{st.converge.target}</b> 分</>}
                      {st.verify.scores && st.verify.scores.length > 0 && (
                        <> · 轨迹：{st.verify.scores.map((s) => `${s.round}轮 ${s.score}分${s.adopted ? '✓' : '↩'}`).join(' · ')}</>
                      )}
                      {st.verify.convergeDone && <> · 终止：{st.verify.convergeDone === 'target' ? '达标' : st.verify.convergeDone === 'maxrounds' ? '达轮次上限' : '连续无改进'}</>}
                    </span>
                  </div>
                )}
                {isCur && st.verify?.phase === 'paused' && (
                  <div className="dsh-wt_flowPauseCard">
                    <div className="dsh-wt_flowPauseHead">⛔ 验收暂停（进度已保留，不会重跑）</div>
                    <div className="dsh-wt_flowPauseBody">
                      {st.verify.pauseReason === 'verifier-gone' ? '验收员多次未交报告（模型服务或会话异常）。'
                      : st.verify.pauseReason === 'worker-gone' ? '工人会话丢失。'
                      : st.verify.pauseReason === 'send-failed' ? '任务发送失败（宿主或模型服务异常）。'
                      : '验收环已暂停。'}
                      恢复续跑 / 查看报告 / 从头重跑请用右侧按钮「⏯ 继续本步」「📋 验收报告」「🔄 重置」。
                    </div>
                    <div className="dsh-wt_flowPauseTip">
                      也可人工介入：在工人会话里按报告逐条修改，改完覆写交付标记，验收环会自动续跑。
                    </div>
                  </div>
                )}
                {(st.skill || st.instruction) && (
                  <div className="dsh-wt_flowStepConf">
                    {st.skill && <span className="dsh-wt_flowStepSkill">⚙ 技能：{st.skill}</span>}
                    {st.instruction && <span className="dsh-wt_flowStepInst">💡 {st.instruction}</span>}
                  </div>
                )}
                {st.blocks && st.blocks.length > 0 && (
                  <div className="dsh-wt_flowStepBlocks">
                    <button type="button" className="dsh-wt_flowAccToggle"
                      title="展开查看本步分块与通用验收清单（L1 标准，验收员逐条核验）"
                      onClick={() => setAccOpen((o) => ({ ...o, [st.id]: !o[st.id] }))}>
                      {accOpen[st.id] ? '▾' : '▸'} 分块交付 · {st.blocks.length} 块{st.blocks.some((b) => b.repeatable) ? '（含逐图/逐章重复块）' : ''}
                      {isCur && st.verify ? ` · 当前：${st.blocks[Math.min(st.verify.blockIdx, st.blocks.length - 1)]?.title ?? ''}${st.verify.passedCount > 0 ? `（已通过 ${st.verify.passedCount} 个对象）` : ''}` : ''}
                    </button>
                    {accOpen[st.id] && (
                      <div className="dsh-wt_flowAccBody">
                        {st.blocks.map((b, bi) => {
                          const curB = isCur && st.verify && st.verify.blockIdx === bi
                          return (
                            <div key={b.id} className="dsh-wt_flowBlock">
                              <div className="dsh-wt_flowBlockTitle">
                                {curB && st.verify ? (st.verify.phase === 'step-passed' ? '✅ ' : st.verify.phase === 'paused' ? '⛔ ' : '▶ ') : `${bi + 1}. `}
                                {b.title}{b.repeatable ? '（重复块：逐对象验收）' : ''}
                              </div>
                              <div className="dsh-wt_flowBlockDeliv">{b.deliverable}</div>
                              {b.acceptance.length > 0 ? (
                                <ul className="dsh-wt_flowAccList">
                                  {b.acceptance.map((a, ai) => <li key={ai}>{a}</li>)}
                                </ul>
                              ) : (
                                <div className="dsh-wt_flowBlockDeliv" title="验收标准已改为文件驱动：唯一来源是 D:\dsh-worktable\论文写作模板\02-十步验收标准.md，改动立即生效（无需重新构建）。开工时该步全部条目会自动写入本步 _本步要求.md。">
                                  验收标准见《02-十步验收标准.md》对应步骤（实时读取，修改立即生效）——开工后完整条目在 <code>_本步要求.md</code> 的「本步验收标准」小节。
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="dsh-wt_flowStepOps">
                <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpenDir" disabled={opening !== null}
                  title="在系统资源管理器中打开本步子目录（不存在则自动创建空目录）"
                  onClick={() => openDir(st)}>{opening === st.id ? '⏳ 打开中…' : '📂 打开文件夹'}</button>
                {!isSkipped && !isConvergeProject && !editFor && (
                  <button type="button" className={'dsh-wt_flowOp' + (st.briefConfirmed ? '' : ' dsh-wt_flowOpWarn')}
                    title="本步「初始信息」：开工前必须确认的针对性提示词（默认已按本步任务预填，把【】占位内容改成你的实际情况后保存；未确认时「开始此步」会被拦住）"
                    onClick={() => openBriefEdit(st)}>📝 初始信息{st.briefConfirmed ? ' ✓' : ' ⚠️待确认'}</button>
                )}
                {isCur && !editFor && (
                  <>
                    <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpPrimary"
                      title={view.sessionReady
                        ? '点击后自动进入本步专属会话（任务已自动发送；可重复点，任务会重发）'
                        : '创建该步子目录 → 把任务/硬性要求写入 _本步要求.md → 在子目录开会话并自动发送任务（自动验收模式）'}
                      onClick={() => doStart(st)}>▶ 开始此步</button>
                    <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpDone" title="AI 已在本步子目录交付产物后，点此确认通过（绿标解锁下一步）"
                      onClick={() => { env?.markDone(projectId, st.id); flash('✅ 已通过：「' + st.title + '」') }}>✓ 通过</button>
                    {st.verify && st.verify.phase !== 'step-passed' && (
                      (st.verify.phase === 'working' || st.verify.phase === 'verifying') && !st.verify.userStopped
                        ? <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpStop"
                            title="手动停止本步：立即中断在跑的工人/验收员/裁判会话，调度器不再自动派单、不再开新会话（进度保留；恢复点「⏯ 继续本步」）"
                            onClick={async () => { if (!env) return; flash(await env.stop(projectId, st.id)) }}>⏹ 停止</button>
                        : <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpResume"
                            title={st.verify.userStopped
                              ? '本步已被手动停止：点此恢复，调度器按当前进度继续自动派单（块/轮次/最佳版本不丢）'
                              : '按当前进度续跑：依阶段自动催工人交付、或重派验收员（不重置进度）'}
                            onClick={async () => { if (!env) return; flash(await env.resume(projectId, st.id)) }}>⏯ 继续本步</button>
                    )}
                    <button type="button" className="dsh-wt_flowOp" title={st.converge ? '配置本步技能、补充说明与迭代收敛参数（最大迭代轮次／收敛分数／平台期；自动保存到模板）' : '配置本步技能与补充说明（自动保存到模板）'} onClick={() => openEdit(st)}>⚙ 配置</button>
                    {st.verify && (
                      <>
                        <button type="button" className="dsh-wt_flowOp" title="打开本步骤目录并提示最新一轮验收报告文件名（_验收_<块id>_R<轮>.md，R 越大越新）"
                          onClick={async () => { if (!env) return; flash(await env.openLatestReport(projectId, st.id)) }}>📋 验收报告</button>
                        <button type="button" className="dsh-wt_flowOp" title="清零块/轮次进度，从第 1 块第 1 轮重跑本步（产物文件不删除）"
                          onClick={() => { flash(env?.resetStep(projectId, st.id) ?? '', 'info') }}>🔄 重置</button>
                      </>
                    )}
                  </>
                )}
                {isDone && (
                  <>
                    {st.doneAt && <span className="dsh-wt_flowStepTime">通过 {new Date(st.doneAt).toLocaleString()}</span>}
                    <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpUndo" title="撤回本步通过（该步及其后步骤退回未通过，可修改后重走）"
                      onClick={() => { env?.undo(projectId, st.id); flash('↩ 已撤回：「' + st.title + '」及其后续步骤', 'info') }}>↩ 撤回</button>
                    <button type="button" className="dsh-wt_flowOp" title={st.converge ? '配置本步技能、补充说明与迭代收敛参数（最大迭代轮次／收敛分数／平台期；自动保存到模板）' : '配置本步技能与补充说明（自动保存到模板）'} onClick={() => openEdit(st)}>⚙ 配置</button>
                  </>
                )}
                {isSkipped && <span className="dsh-wt_flowStepSkipHint">无需完成</span>}
                {(isSkipped || locked) && (
                  <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpStartHere"
                    title="把流程起始步直接设为本步：其前步骤标记为跳过（不影响任何文件），本步成为当前步；前置步骤已有交付物会自动盘点进本步要求"
                    onClick={async () => {
                      if (!env) return
                      const text = await env.setStartStep(projectId, st.id)
                      flash(text)
                    }}>🎯 从此步开始</button>
                )}
              </div>

              {editFor === st.id && (
                <div className="dsh-wt_flowEdit">
                  <div className="dsh-wt_flowEditRow">
                    <label>技能（可更换，也可清空；候选来自本机技能目录——全局 ~/.dsh/skills 等，改技能目录后刷新页面即生效。保存后同步到模板。非空时执行会以 /技能名 标记自动加载该技能说明）</label>
                    <input list="dsh-wt_skillList" value={skillDraft} placeholder="可手输任意技能名，或从列表选；留空 = 本步不指定技能"
                      onChange={(e) => setSkillDraft(e.target.value)} />
                    <datalist id="dsh-wt_skillList">{skills.map((s) => <option key={s.name} value={s.name} label={s.description ? s.description.slice(0, 60) : undefined} />)}</datalist>
                  </div>
                  <div className="dsh-wt_flowEditRow">
                    <label>补充说明（硬性要求：会置顶逐条列出并要求 AI 逐条自检，未满足视为未交付）</label>
                    <textarea value={instDraft} rows={3} placeholder="给该步 AI 的硬性要求，一行一条（可空）"
                      onChange={(e) => setInstDraft(e.target.value)} />
                  </div>
                  {st.converge && (
                    <div className="dsh-wt_flowEditRow">
                      <label>迭代收敛参数（本步专用，随本项目保存并同步到模板）——「最大迭代轮次」= 工人最多改几版；「收敛分数」达到即提前收敛；平台期连续无改进也停</label>
                      <div className="dsh-wt_convRow">
                        <span className="dsh-wt_convItem">
                          <label htmlFor={'dsh-wt_convR_' + st.id}>最大迭代轮次</label>
                          <input id={'dsh-wt_convR_' + st.id} type="number" min={1} max={99} step={1}
                            value={convRounds} onChange={(e) => setConvRounds(e.target.value)} />
                        </span>
                        <span className="dsh-wt_convItem">
                          <label htmlFor={'dsh-wt_convT_' + st.id}>收敛分数（达标分，0-100）</label>
                          <input id={'dsh-wt_convT_' + st.id} type="number" min={0} max={100} step={1}
                            value={convTarget} onChange={(e) => setConvTarget(e.target.value)} />
                        </span>
                        <span className="dsh-wt_convItem">
                          <label htmlFor={'dsh-wt_convP_' + st.id}>平台期（连续 N 轮无改进即停）</label>
                          <input id={'dsh-wt_convP_' + st.id} type="number" min={1} max={99} step={1}
                            value={convPlateau} onChange={(e) => setConvPlateau(e.target.value)} />
                        </span>
                      </div>
                      <div className="dsh-wt_convHint">
                        当前生效：最多 <b>{st.converge.maxRounds}</b> 轮 · 收敛分数 <b>{st.converge.target}</b> 分 · 连续 <b>{st.converge.plateau}</b> 轮无改进即停（裁判每轮按 _rubric.md 打总分，<b>新分高于旧分才采纳</b>，否则回退保留最佳版本）。
                        保存后<b>立即生效</b>（下一个调度周期按新参数判定；已跑过的轮次与最佳版本保留）。轮次与平台期范围 1-99，收敛分数 0-100。
                      </div>
                    </div>
                  )}
                  <div className="dsh-wt_flowEditBtns">
                    <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpPrimary" onClick={() => saveEdit(st)}>保存</button>
                    <button type="button" className="dsh-wt_flowOp" onClick={() => setEditFor(null)}>取消</button>
                  </div>
                </div>
              )}

              {briefEditFor === st.id && (
                <div className="dsh-wt_flowEdit">
                  <div className="dsh-wt_flowEditRow">
                    <label>初始信息（本步开工提示词——必填：已按本步任务针对性预填，把【】占位内容改成你的实际情况；不改也可直接保存。内容会在开工时作为「本步初始信息」逐条注入工人会话任务卡，与本步其它要求冲突时以此为准）</label>
                    <textarea value={briefDraft2} rows={9} spellCheck={false}
                      placeholder={st.briefDefault ?? '给本步 AI 的针对性输入：你的数据/算例/参数/要求…'}
                      onChange={(e) => setBriefDraft2(e.target.value)} />
                  </div>
                  <div className="dsh-wt_flowEditBtns">
                    <button type="button" className="dsh-wt_flowOp dsh-wt_flowOpPrimary" onClick={() => {
                      if (!env) return
                      env.setStepBrief(projectId, st.id, briefDraft2)
                      setBriefEditFor(null)
                      flash(briefDraft2.trim()
                        ? `✅ 「${st.title}」初始信息已保存并确认：现在可以点「▶ 开始此步」。`
                        : `⚠️ 「${st.title}」初始信息已保存为空：开工会被拦住，请补填后再开始。`)
                    }}>保存并确认</button>
                    <button type="button" className="dsh-wt_flowOp" title="把草稿恢复为模板默认提示词（未保存，需再点保存）"
                      onClick={() => setBriefDraft2(st.briefDefault ?? '')}>恢复默认</button>
                    <button type="button" className="dsh-wt_flowOp" onClick={() => setBriefEditFor(null)}>取消</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {fb && <div className={'dsh-wt_flowToast dsh-wt_flowToast-' + fb.kind} role="status">{fb.text}</div>}
    </div>
  )
}
