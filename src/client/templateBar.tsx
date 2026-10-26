/**
 * 控制室「模板库」：面板最上一行展示所有模板的小图标（左上起、横排、排满换行）。
 * 点击模板打开详情浮层：查看完整信息并配置关键参数
 * （默认布局预设；每步技能/补充说明——保存即写入模板，后续新建项目均为最新配置）。
 * 纯本地数据（templates.ts + localStorage），不依赖宿主桥。
 */
import { useEffect, useState } from 'react'
import {
  BUILTIN_TEMPLATES, LAYOUT_PRESETS, cachedSkillOptions, loadSkillOptions,
  templateById, saveTemplateLayout, saveTemplateStepOverride, clearTemplateStepOverride,
  type SkillOption, type TemplateStepDef,
} from './templates'

/** 顶部小图标条（控制室最上方） */
export function TemplateBar() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const bump = () => setTick((t) => t + 1)
  void tick
  const tmpls = BUILTIN_TEMPLATES.map((t) => templateById(t.id)).filter((t): t is NonNullable<typeof t> => !!t)
  if (tmpls.length === 0) return null
  return (
    <div className="dsh-wt_tplBar">
      <span className="dsh-wt_tplBarLabel" title="固定流程模板库：点击查看详情并配置">模板库</span>
      {tmpls.map((t) => (
        <button key={t.id} type="button" className="dsh-wt_tplChip" title={t.description}
          onClick={() => setOpenId(t.id)}>
          <span className="dsh-wt_tplChipIcon" aria-hidden>{t.icon}</span>
          <span className="dsh-wt_tplChipName">{t.name}</span>
        </button>
      ))}
      {openId && <TemplateDetail templateId={openId} onClose={() => setOpenId(null)} onSaved={bump} />}
    </div>
  )
}

/** 模板详情 + 关键参数配置浮层 */
function TemplateDetail(props: { templateId: string; onClose: () => void; onSaved: () => void }) {
  const tmpl = templateById(props.templateId)
  const [expanded, setExpanded] = useState<string | null>(null) // 正在配置的步骤 id
  const [skillDraft, setSkillDraft] = useState('')
  const [instDraft, setInstDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  /** 技能候选：宿主实时扫描的本机技能目录（全局 + 项目），模板配置面板与流程面板同源 */
  const [skills, setSkills] = useState<SkillOption[]>(cachedSkillOptions)

  useEffect(() => {
    let alive = true
    void loadSkillOptions().then((list) => { if (alive) setSkills(list) }).catch(() => {})
    return () => { alive = false }
  }, [])

  if (!tmpl) return null

  const flash = (text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(null), 4000)
  }

  const openStep = (s: TemplateStepDef) => {
    if (expanded === s.id) { setExpanded(null); return }
    setExpanded(s.id)
    setSkillDraft(s.skill ?? '')
    setInstDraft(s.instruction ?? '')
  }

  const saveStep = (s: TemplateStepDef) => {
    saveTemplateStepOverride(tmpl.id, s.id, {
      // 空串 = 显式清空（该步回到「不指定技能/无补充说明」），不可转 undefined（会被合并逻辑当作“保留旧值”）
      skill: skillDraft.trim(),
      instruction: instDraft.trim(),
    })
    setExpanded(null)
    props.onSaved()
    flash('✅ 已保存并写入模板：之后新建项目均用此配置')
  }

  const resetStep = (s: TemplateStepDef) => {
    clearTemplateStepOverride(tmpl.id, s.id)
    setExpanded(null)
    props.onSaved()
    flash('↩ 已恢复本步模板默认配置')
  }

  return (
    <div className="dsh-wt_tplMask" onClick={props.onClose}>
      <div className="dsh-wt_tplDetail" onClick={(e) => e.stopPropagation()}>
        <div className="dsh-wt_tplDetailHead">
          <span className="dsh-wt_tplDetailIcon" aria-hidden>{tmpl.icon}</span>
          <div className="dsh-wt_tplDetailTitles">
            <span className="dsh-wt_tplDetailName">{tmpl.name}</span>
            <span className="dsh-wt_tplDetailDesc">{tmpl.description}</span>
          </div>
          <button type="button" className="dsh-wt_tplClose" title="关闭" onClick={props.onClose}>✕</button>
        </div>

        <div className="dsh-wt_tplDetailBody">
          <div className="dsh-wt_tplRow">
            <label>默认布局（新建项目时预选，仍可改）</label>
            <select className="dsh-wt_tplSel" value={tmpl.layoutPreset}
              onChange={(e) => { saveTemplateLayout(tmpl.id, e.target.value); props.onSaved(); flash('✅ 模板默认布局已保存') }}>
              {LAYOUT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div className="dsh-wt_tplSectionTitle">{tmpl.steps.length} 步固定流程 · 点步骤配置技能与说明</div>
          <div className="dsh-wt_tplStepList">
            {tmpl.steps.map((s, i) => (
              <div key={s.id} className={'dsh-wt_tplStep' + (expanded === s.id ? ' dsh-wt_tplStepOpen' : '')}>
                <button type="button" className="dsh-wt_tplStepRow" onClick={() => openStep(s)} title="点击配置本步">
                  <span className="dsh-wt_tplStepNo">{i + 1}</span>
                  <span className="dsh-wt_tplStepIcon" aria-hidden>{s.icon}</span>
                  <span className="dsh-wt_tplStepTitle">{s.title}</span>
                  <span className="dsh-wt_tplStepDir">{s.dir}/</span>
                  {(s.skill || s.instruction) && <span className="dsh-wt_tplStepCustom" title="已自定义配置">已配置</span>}
                  <span className="dsh-wt_tplStepCaret" aria-hidden>{expanded === s.id ? '▾' : '▸'}</span>
                </button>
                {expanded === s.id && (
                  <div className="dsh-wt_tplStepEdit">
                    <div className="dsh-wt_tplStepDeliver">交付：{s.deliverable}</div>
                    <div className="dsh-wt_tplField">
                      <label>技能（可手输或从列表选；候选来自本机技能目录——全局 ~/.dsh/skills 等，改技能目录后刷新页面即生效。空 = 不指定。执行时以 /技能名 自动加载该技能）</label>
                      <input list="dsh-wt_tplSkillList" value={skillDraft}
                        onChange={(e) => setSkillDraft(e.target.value)} />
                      <datalist id="dsh-wt_tplSkillList">{skills.map((x) => <option key={x.name} value={x.name} label={x.description ? x.description.slice(0, 60) : undefined} />)}</datalist>
                    </div>
                    <div className="dsh-wt_tplField">
                      <label>补充说明（硬性要求：会置顶逐条列出并要求 AI 逐条自检）</label>
                      <textarea rows={3} placeholder="给该步 AI 的硬性要求，一行一条（可空）" value={instDraft} onChange={(e) => setInstDraft(e.target.value)} />
                    </div>
                    <div className="dsh-wt_tplEditBtns">
                      <button type="button" className="dsh-wt_tplBtn dsh-wt_tplBtnSave" onClick={() => saveStep(s)}>保存</button>
                      <button type="button" className="dsh-wt_tplBtn" onClick={() => resetStep(s)} title="清除本步自定义，恢复模板出厂默认">恢复默认</button>
                      <button type="button" className="dsh-wt_tplBtn" onClick={() => setExpanded(null)}>取消</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {toast && <div className="dsh-wt_tplToast" role="status">{toast}</div>}
      </div>
    </div>
  )
}
