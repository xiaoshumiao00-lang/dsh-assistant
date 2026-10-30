// 语音转写的"术语纠错"表。
//
// SenseVoice-small 是通用小模型，最容易写错的是**人名、校名/单位名、专业词**
// （同音字/近音字），这类错误模型自己修不了，但用一张确定的替换表可以修干净。
//
// 原则：只纠正"几乎不可能写对"的形近/音近写法，不做通用错别字猜测——
// 猜错比不猜更糟。
//
// 仓库里只留**通用**词表（专业 / 业务 / 产品名）。任何「只有本人才有意义」的词
// （人名、校院名、自家店名）都从本机配置文件读：
//   ~/.dsh/assistant/config.json → { "asrTerms": [{ "pattern": "示例人|示例人二", "replace": "示例规范名" }] }
// 宿主把它下发给页面（GET /api/assistant/config），页面缓存后调用 applyPersonalTerms()。
// 详见 README「本机个人化配置」。

type Rule = [pattern: RegExp, replacement: string]

/** 本机个人化词表（宿主下发）：正则源串 + 标志位。 */
export interface PersonalTerm {
  pattern: string
  replace: string
  flags?: string
}

const RULES: Rule[] = [
  // ── 专业术语（土木 / 结构 / AI） ──────────────────────────────────
  [/托扑优化|拓朴优化|拓扑优华|托普优化/g, '拓扑优化'],
  [/磷石膏|林石膏|临石膏|邻石膏|磷石高/g, '磷石膏'],
  [/混凝士|混泥土|混凝土/g, '混凝土'],
  [/超高性[能熊]混凝土/g, '超高性能混凝土'],
  [/钢结构|刚结构|钢构结/g, '钢结构'],
  [/屈曲模[态太]|屈曲摸态/g, '屈曲模态'],
  [/有限[元原]|有限园/g, '有限元'],
  [/神经网[络落]|神经网络/g, '神经网络'],
  [/数据[集级]|数据急/g, '数据集'],
  [/温度[场厂]|温度长/g, '温度场'],
  [/拱桥|供桥|公桥/g, '拱桥'],
  [/提篮拱|提蓝拱/g, '提篮拱'],
  [/揭榜挂帅|揭榜挂师/g, '揭榜挂帅'],
  [/投入产出比|投入产出率/g, '投入产出比'],
  [/工程造价|工程造价/g, '工程造价'],
  [/数字教材|数字交材/g, '数字教材'],
  [/毕业设计|毕业设[计记]/g, '毕业设计'],
  [/成图大赛|成图大塞/g, '成图大赛'],

  // ── 产品 / 工具名 ────────────────────────────────────────────────
  [/迪普西克|深度求索索|dee[pb]\s?seek/gi, 'DeepSeek'],
  [/悬浮球|悬浮求|玄浮球/g, '悬浮球'],
  [/dsh\s?pocket/gi, 'dsh-pocket'],
  [/微信支付|微信支[付服]/g, '微信支付'],
]

/** 人名 / 校院名 / 自家店名等本机词表：仓库默认**空**，本机配置文件里填。 */
let personalRules: Rule[] = []

/** 把本机词表编译成 RegExp（坏正则直接跳过，不整批失败）。 */
export function compilePersonalTerms(terms: PersonalTerm[]): Rule[] {
  const out: Rule[] = []
  for (const term of terms ?? []) {
    const pattern = String(term?.pattern ?? '')
    const replacement = String(term?.replace ?? '')
    if (!pattern || !replacement) continue
    try {
      out.push([new RegExp(pattern, term.flags && /^[a-z]*$/.test(term.flags) ? term.flags : 'g'), replacement])
    } catch { /* 本机配置文件里的正则写坏了：忽略这条，其它继续 */ }
  }
  return out
}

/** 页面拿到宿主下发的本机词表后调用（幂等，可以重复调用）。 */
export function applyPersonalTerms(terms: PersonalTerm[]): void {
  personalRules = compilePersonalTerms(terms)
}

/** 测试/展示用：当前生效的个人化词表数量。 */
export function personalTermCount(): number {
  return personalRules.length
}

/** 对一段转写文字做术语纠正（幂等，可重复调用）。本机词表在通用词表之后应用。 */
export function fixTerms(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  for (const [pattern, replacement] of personalRules) out = out.replace(pattern, replacement)
  return out
}

/** 去掉口述时带出来的语气词和多余空格（"嗯…""呃…"），只清头尾，句中不动。 */
export function cleanFillers(text: string): string {
  return text
    .replace(/^[嗯嗯\s、，,。．.]+/, '')
    .replace(/[嗯呃额]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
