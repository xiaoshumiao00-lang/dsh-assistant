/**
 * 指挥台派单协议（2026-11-10 重构：纯文本，不依赖工具挂载）。
 *
 * 事故背景：实机上指挥会话没有挂载 tihu 的 dispatch 工具，指挥台收到判断请求后
 * 干脆自己把活做了（1 分 34 秒），既没派单也没出排队卡。现在指挥台**只回一行
 * JSON 结论**，由 lane 本地解析并执行派单——指挥会话不需要任何额外工具。
 *
 * 这一层只做「文本 → 结论」的纯解析，不碰宿主服务，方便单测：
 *
 *   {"project":"青年基金申请书","session":"append|new","append_to":"<sessionId 或空>"}
 *
 * 容忍：
 *   - ```json / ``` 代码块包裹；
 *   - 前后多余说明文字（在整段里扫配对的花括号对象）；
 *   - 中文引号 “ ”、全角冒号：、全角逗号，、全角花括号；
 *   - 裸键名（{project:"x"}）、尾逗号；
 *   - session 用中文写（接着/续/新建/新）；
 *   - append_to 的几种常见别名（appendTo / sessionId / session_id）。
 *
 * 解析不出**可用结论**时返回 undefined：调用方据此退回「按 routeQuick / 最佳卡」
 * 规则，并落 lane.log（绝不把排队卡停在「等指挥台判断」）。
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

/**
 * 指挥台提示词尾巴：只回一行 JSON，不做正文、不解释、不调工具。
 * `hints` 是「最近的项目会话（短号 + 标题）」，让 append/append_to 有据可依。
 */
export function commanderReplyTail(hints: readonly string[] = []): string {
  return [
    '【指挥会话 · 铁律】你只判断「这件事该派给哪个项目」，不做正文、不解释、不调用任何工具。',
    `**只输出一行 JSON**，格式：${COMMANDER_REPLY_SHAPE}`,
    '· session 只能写 "append" 或 "new" 这两个词（不要照抄示例里的 "append|new"）。',
    '· 项目名用项目卡名；没有合适的项目就写「个人助手」。',
    '· 接着某条已有会话做 → "append"，append_to 写那条会话的短号；确实是一件新事 → "new"，append_to 留空。',
    '· 除这一行 JSON 外不要输出任何字符：不要代码块围栏、不要解释、不要前后缀。',
    ...(hints.length === 0 ? [] : ['最近的项目会话（短号 标题）：', ...hints]),
  ].join('\n')
}
