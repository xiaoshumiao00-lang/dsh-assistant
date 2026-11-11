/**
 * 指挥台路由协议（2026-11-11 改：语义路由，不做词表匹配）。
 *
 * 指挥台是**唯一有权决定「这句话是干活还是指挥这块屏」**的那一层。它回一句结论，
 * 三种形状：
 *
 *   派单：   {"project":"青年基金申请书","session":"append|new","append_to":"<sessionId 或空>"}
 *   控制：   {"intent":"control","tool":"tihu_replay"}                ← 用户这句话是冲屏说的
 *   澄清：   {"intent":"clarify","ask":"这句是要我干活，还是只管屏？"} ← 两可时才允许
 *
 * 控制形状里那个 `tool` **必须是一个真实存在的 tihu_* 工具名**（调用方按工具注册表校验，
 * 这张名单是「工具名」名单，不是「用户说法」词表：说法→意图由模型按意思判，不在代码里匹配）。
 * 模型如果已经自己调了工具，lane 就不再补调、也绝不派单（一句话只允许一条路由）。
 *
 * 事故背景（2026-11-10）：实机上指挥会话曾经没有挂载 dispatch 工具，指挥台收到判断请求后
 * 干脆自己把活做了（1 分 34 秒）。所以派单结论仍然走纯文本 JSON，lane 本地解析执行——
 * 纯文本这条不能丢，工具调用只是它上面的另一条出口。
 *
 * 这一层只做「文本 → 结论」的纯解析，不碰宿主服务，方便单测。容忍：
 *   - ```json / ``` 代码块包裹；
 *   - 前后多余说明文字（在整段里扫配对的花括号对象）；
 *   - 中文引号 “ ”、全角冒号：、全角逗号，、全角花括号；
 *   - 裸键名（{project:"x"}）、尾逗号；
 *   - session 用中文写（接着/续/新建/新）；
 *   - append_to 的几种常见别名（appendTo / sessionId / session_id）。
 *
 * 解析不出**任何可用结论**时返回 undefined：调用方自己决定怎么办（绝不猜着派单）。
 */

/** 指挥台那一行结论里 `session` 的两种取值。 */
export type CommanderSessionMode = 'append' | 'new'

/** 指挥台回复解析出来的派单结论。 */
export interface CommanderReply {
  /** 项目卡名（空串＝没说清，由调用方落个人助手）。 */
  project: string
  /** append＝续到已有会话；new＝在该项目下新建 CU 会话。 */
  session: CommanderSessionMode
  /** `session=append` 时要续的会话 id / 短号（new 时为空串）。 */
  appendTo: string
}

/** 一行结论的字段提示（提示词与文档共用，避免两处写歪）。 */
export const COMMANDER_REPLY_SHAPE = '{"project":"项目名","session":"append|new","append_to":"会话 id 或空"}'

/** 控制结论那一行的字段提示：`tool` 必须写真实工具名。 */
export const COMMANDER_CONTROL_SHAPE = '{"intent":"control","tool":"tihu_stop_speaking"}'

/** 澄清结论那一行的字段提示：只有两可时才允许。 */
export const COMMANDER_CLARIFY_SHAPE = '{"intent":"clarify","ask":"要问用户的那一句话"}'

/**
 * 「设备控制优先」那一节（指挥台首条指令的一部分）。
 *
 * 它给的是**判断口径**，不是匹配表：例子列满只是为了让模型明白「说法五花八门」，
 * 明确写了「这些只是例子，不是词表」，代码里没有任何按字面命中说法的地方。
 */
export const DEVICE_CONTROL_PRIORITY_SECTION = [
  '【设备控制优先】先判这句话是不是用户在**指挥这块设备屏本身**：正在朗读的内容、正在看的页面、正在等他选的选项、这次语音会话、这块屏该看哪条。',
  '· **下面这些只是例子，不是词表**：按意思判，绝不按字面匹配。说法可以是任何样子——',
  '  停 / 别念了 / 安静点 / 先停一下 / 别读了 → `tihu_stop_speaking`；慢一点 / 先停在那儿别动 / 等会儿再说 → `tihu_pause_speaking`；接着说 / 继续念 / 念完它 → `tihu_resume_speaking`；',
  '  再来一遍 / 重念 / 从头念 / 刚才那句再说一次 / 第 3 段重读 → `tihu_replay`；回主界面 / 退出去 / 返回 / 别占着这张屏 / 给我看回去 → `tihu_go_home`；',
  '  翻页 / 下一页 / 上一页 / 往前翻 / 翻到第 2 页 → `tihu_board_page`；看第几张卡 / 打开那条任务 / 看最近做完的那条 → `tihu_open_task`；',
  '  跟着这条 / 我就要看这条 / 盯住它跑 → `tihu_follow_task`；结束这次语音 / 关掉语音 / 别在听了 / 收工 → `tihu_end_voice_session`；我说话呢 / 醒醒 / 在听吗 → `tihu_wake`；',
  '  答应 / 选第二个 / 就这个 / 那个不行 → `tihu_answer_decision`；随便 / 按默认来 / 你决定 / 驳回 → `tihu_dismiss_decision`；现在什么情况 / 在干嘛 / 念到哪了 / 屏上这条跑到哪了 → `tihu_status`；',
  '  有几个设备 / 哪几块屏在线 → `tihu_list_devices`；声音换个男的 / 语速慢点 / 开免按住 → `tihu_device_settings`。',
  '· 判成控制意图 → **直接调用那个 tihu_* 工具**（工具名照实写，别自己编）。调了工具就不要再输出派单 JSON：这句话已经办了，再派单就是办两遍。',
  '· 判成要干活（写文档、跑代码、查资料、改文件、做图、审稿、做交付物…）→ 才回派单 JSON。派单绝不用于「让这块屏怎么显示」这件事。',
  '· 两种解释都说得通、说不准 → 只回 `{"intent":"clarify","ask":"…"}`，屏上问用户一次；**绝不猜着派单**。',
].join('\n')

/** 代码块围栏：```json / ```JSON / ```。 */
const FENCE = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g

/** 把中文标点 / 裸键名 / 尾逗号修成 JSON.parse 吃得下的形状。 */
function jsonish(text: string): string {
  return String(text ?? '')
    .replace(/[\u201c\u201d\u2018\u2019\uff02]/g, '"')
    .replace(/[：]/g, ':')
    .replace(/[，]/g, ',')
    .replace(/｛/g, '{')
    .replace(/｝/g, '}')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,\s*([}\]])/g, '$1')
}

/**
 * 扫出文本里所有配对的花括号对象（跳过字符串里的括号）。
 * 前后带说明的回复就靠它把中间那一行 JSON 抠出来。
 */
function balancedObjects(text: string): string[] {
  const source = String(text ?? '')
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let quote = ''
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === '\'' || char === '\u201c') {
      inString = true
      quote = char === '\u201c' ? '\u201d' : char
      continue
    }
    if (char === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        out.push(source.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/** 从一段文本里按「整段 → 代码块 → 配对对象」的顺序取候选。 */
function candidatesOf(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const text = raw.trim()
  if (text === '') return []
  const out: string[] = [text]
  for (const match of text.matchAll(FENCE)) {
    const body = String(match[1] ?? '').trim()
    if (body !== '') out.push(body)
  }
  for (const source of [...out]) out.push(...balancedObjects(source))
  return out
}

function stringOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function modeOf(value: unknown): CommanderSessionMode | undefined {
  const text = stringOf(value).toLowerCase()
  if (text === '') return undefined
  if (/^(?:append|continue|existing|old|same|续|接着|继续|原会话|原有会话|旧会话)$/.test(text)) return 'append'
  if (/^(?:new|create|fresh|新建|新|新会话|新任务|另起|另开)$/.test(text)) return 'new'
  return undefined
}

/** 把解析出来的对象归一成结论；缺字段 / 不可用 → undefined。 */
function conclusionOf(value: unknown): CommanderReply | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const hasSession = record.session !== undefined || record.mode !== undefined || record.action !== undefined
  const hasAppend = record.append_to !== undefined || record.appendTo !== undefined
    || record.sessionId !== undefined || record.session_id !== undefined || record.target_session !== undefined
  const hasProject = record.project !== undefined || record.target !== undefined || record.card !== undefined
  // 不是「派单结论」形状的 JSON（代码片段 / 统计数字）一律不当结论。
  if (!hasSession && !hasAppend && !hasProject) return undefined
  const project = stringOf(record.project ?? record.target ?? record.card)
  const appendTo = stringOf(record.append_to ?? record.appendTo ?? record.sessionId
    ?? record.session_id ?? record.target_session)
  let session = modeOf(record.session ?? record.mode ?? record.action)
  if (session === undefined) session = appendTo !== '' ? 'append' : 'new'
  if (session === 'append' && appendTo === '') {
    // 说「接着」却没给 append_to：这条结论不可用，交回调用方兜底。
    return undefined
  }
  if (session === 'new') return { project, session: 'new', appendTo: '' }
  return { project, session: 'append', appendTo }
}

/**
 * 解析指挥台回复。成功返回结论；没有可用结论返回 undefined。
 *
 * 注意：只认「派单结论」形状的对象——回复里若夹了别的 JSON（比如一段配置），
 * 不会被误当成结论。
 */
export function parseCommanderReply(raw: unknown): CommanderReply | undefined {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return conclusionOf(raw)
  for (const candidate of candidatesOf(raw)) {
    const direct = tryParse(candidate)
    if (direct !== undefined) {
      const conclusion = conclusionOf(direct)
      if (conclusion !== undefined) return conclusion
      continue
    }
    const repaired = tryParse(jsonish(candidate))
    if (repaired === undefined) continue
    const conclusion = conclusionOf(repaired)
    if (conclusion !== undefined) return conclusion
  }
  // 中文引号把整个对象包起来时，balancedObjects 可能因为引号状态错位而抠不出：
  // 最后再兜底把全文修一遍、直接试一次。
  const whole = tryParse(jsonish(String(raw ?? '')))
  return whole === undefined ? undefined : conclusionOf(whole)
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/* ============================================================
 * 语义路由结论（2026-11-11）：三种形状 → 三种结论
 *
 * 这里没有任何「用户说法」词表：`tool` 那一格必须是工具注册表里真实存在的名字，
 * 「说法 → 意图」的判断整个交给指挥台（模型）。
 * ============================================================ */

/** 指挥台一句话的结论种类。 */
export type CommanderDecision =
  /** 判成「这句话是冲这块屏说的」：带真实工具名，lane 执行它（模型没自己调就补调）。 */
  | { kind: 'control'; tool: string; args: Record<string, unknown> }
  /** 判成控制意图，但那个工具名不存在的：认它，绝不派单。 */
  | { kind: 'control-unknown'; said: string }
  /** 两可：屏上问用户一次，绝不猜着派单。 */
  | { kind: 'clarify'; question: string }
  /** 判成要干活：按派单结论执行。 */
  | { kind: 'dispatch'; dispatch: CommanderReply }

/** 结论方向那一格的措辞（`intent`/`kind`/`type`/`action`；只判方向，不判用户说法）。 */
type IntentDirection = 'control' | 'clarify' | 'dispatch'
const INTENTION_KEYS: readonly IntentDirection[] = ['control', 'clarify', 'dispatch']
const INTENTION_WORDS: Record<IntentDirection, readonly RegExp[]> = {
  control: [/^control$|^screen$|^device$|^ui$|^playback$|^panel$/, /^(?:控制|这块屏|屏上|界面|播放|语音)$/],
  clarify: [/^clarify$|^unclear$|^ambiguous$|^ask$|^question$|要问/, /^(?:说不准|两可|歧义)$/],
  dispatch: [/^dispatch$|^work$|^job$|^task$|^new-task$|^派单$|^干活$|^新任务$/, /^(?:派单结论|干活)$/],
}

function intentWordOf(value: unknown): IntentDirection | undefined {
  const text = stringOf(value).toLowerCase().replace(/[\s_·、，。]/g, '')
  if (text === '') return undefined
  for (const key of INTENTION_KEYS) {
    if (INTENTION_WORDS[key].some((pattern) => pattern.test(text))) return key
  }
  return undefined
}

/** 挑出工具名：模型把它写在哪个键都行，但必须是注册表里真实存在的名字。 */
function toolNameOf(record: Record<string, unknown>, allowed: readonly string[]): { name: string; said: string } | undefined {
  for (const key of ['tool', 'tihu_tool', 'toolName', 'control', 'call', 'api'] as const) {
    const value = stringOf(record[key])
    if (value === '') continue
    const hit = allowed.find((name) => name.toLowerCase() === value.toLowerCase())
    if (hit !== undefined) return { name: hit, said: value }
  }
  return undefined
}

/** 判成控制却没有真实工具名：把模型写的那个词留下来只进日志，不按它匹配任何东西。 */
function toollessSaidOf(record: Record<string, unknown>): string {
  for (const key of ['tool', 'tihu_tool', 'control', 'action', 'intent'] as const) {
    const value = stringOf(record[key])
    if (value !== '') return value
  }
  return '(没写工具名)'
}

/** 结论里如果带了工具参数就认它（arguments/args/params/parameters）。 */
function toolArgsOf(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['arguments', 'args', 'params', 'parameters'] as const) {
    const value = record[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, unknown>) }
  }
  return {}
}

function clarifyTextOf(record: Record<string, unknown>): string {
  for (const key of ['ask', 'clarify', 'question', 'need_clarify', 'unclear'] as const) {
    const value = stringOf(record[key])
    if (value !== '' && value !== 'true') return value
  }
  return ''
}

/** 把一个已解析的对象归成语义结论；认不出方向返回 undefined。 */
function decisionOf(value: unknown, allowed: readonly string[]): CommanderDecision | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const tool = toolNameOf(record, allowed)
  if (tool !== undefined) return { kind: 'control', tool: nameIn(allowed, tool.name), args: toolArgsOf(record) }
  const intent = intentWordOf(record.intent ?? record.kind ?? record.type ?? record.action)
  const question = clarifyTextOf(record)
  if (intent === 'clarify' || question !== '') return { kind: 'clarify', question }
  if (intent === 'control') return { kind: 'control-unknown', said: toollessSaidOf(record) }
  const dispatch = conclusionOf(record)
  if (dispatch !== undefined) return { kind: 'dispatch', dispatch }
  return undefined
}

/** 挑工具名时已经忽略过大小说法，这里再按注册表的确切拼写还回去。 */
function nameIn(allowed: readonly string[], lowerName: string): string {
  return allowed.find((name) => name.toLowerCase() === lowerName.toLowerCase()) ?? lowerName
}

/**
 * 解析指挥台回复成语义结论。成功返回结论；认不出方向返回 undefined。
 *
 * @param raw 指挥台这一轮的文字
 * @param allowed 工具注册表里真实存在的工具名（校验模型点名的工具，不是说法词表）
 */
export function parseCommanderDecision(raw: unknown, allowed: readonly string[]): CommanderDecision | undefined {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return decisionOf(raw, allowed)
  for (const candidate of candidatesOf(raw)) {
    const direct = tryParse(candidate)
    if (direct !== undefined) {
      const decision = decisionOf(direct, allowed)
      if (decision !== undefined) return decision
      continue
    }
    const repaired = tryParse(jsonish(candidate))
    if (repaired === undefined) continue
    const decision = decisionOf(repaired, allowed)
    if (decision !== undefined) return decision
  }
  const whole = tryParse(jsonish(String(raw ?? '')))
  return whole === undefined ? undefined : decisionOf(whole, allowed)
}

/**
 * 指挥台提示词尾巴：先判「这句话是不是在指挥这块屏」，判成活儿才只回一行派单 JSON。
 * `hints` 是「最近的项目会话（短号 + 标题）」，让 append/append_to 有据可依。
 */
export function commanderReplyTail(hints: readonly string[] = []): string {
  return [
    DEVICE_CONTROL_PRIORITY_SECTION,
    '【结论只有一行】三种形状各回一条，不许混着回，也不许多解释一个字：',
    `· 判成在指挥这块屏 → 直接调那个 tihu_* 工具；只会回文本就回 ${COMMANDER_CONTROL_SHAPE} 这一行（lane 照着它补调）。`,
    `· 判成两可、说不准 → 只回 ${COMMANDER_CLARIFY_SHAPE} 这一行，屏上问用户一次。`,
    '· 判成要干活 → 按下面那行派单 JSON 回：',
    `格式：${COMMANDER_REPLY_SHAPE}`,
    '· session 只能写 "append" 或 "new" 这两个词（不要照抄示例里的 "append|new"）。',
    '· 项目名用项目卡名；没有合适的项目就写「个人助手」。',
    '· 接着某条已有会话做 → "append"，append_to 写那条会话的短号；确实是一件新事 → "new"，append_to 留空。',
    '· 派单那一行之外不要输出任何字符：不要代码块围栏、不要解释、不要前后缀。',
    '· 你只判断「这句话往哪儿派 / 是不是在指挥屏」，不干活、不做正文、不解释自己怎么判的。',
    ...(hints.length === 0 ? [] : ['最近的项目会话（短号 标题）：', ...hints]),
  ].join('\n')
}
