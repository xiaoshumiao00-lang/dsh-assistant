/**
 * 个人秘书「回复卡片」共享逻辑（纯函数 + 状态机，node 可单测，无 react / DOM 依赖）。
 *
 * 内容三块：
 *   1. 朗读文本规范化（normalizeForSpeech）：去 markdown 符号 / 列表符 / 代码块 /
 *      表情 / URL，把能念的都转成口语；秘书提示词已要求模型照此写，这里兜底。
 *   2. 会话引用标记（parseSessionRefs）：回复里引用某条会话时按
 *      `[[session:<sessionId>|<标题>]]` 书写（提示词里说明）。渲染成引用块、
 *      朗读时剔除；点引用块按会话 id 走宿主既有会话选择逻辑。
 *   3. 朗读状态机（reduceSpeech + createSpeechController）：
 *      idle → loading → playing ⇄ paused；restart/切换/播完/失败都收拢到唯一出口。
 *      默认每条卡片出现后自动朗读；单击暂停/继续；长按从头重读；换卡片停上一条。
 *      **只用宿主 /api/assistant/tts（微软 edge-tts），不用 speechSynthesis。**
 *   4. 卡片脚部时间（2026-11-21 改动）：只写时间（`9:08`），不再带「今天」字样。
 *   5. 折叠预算：折叠态正文最多 **3 行**（见 FOLD_BODY_LINE_BUDGET，三种卡共用一套）。
 *   6. 秘书页 user 角色行分类：真实用户输入 → 冷蓝用户卡；插件塞进来的合成通知 → 灰底通知卡
 *      （见 collectSecretaryCardRows / parseNoticeCardBody）。
 *   7. 已读卡集合（未读红点）：cardKey 沿用朗读 key（`assistant:` / `notice:` 前缀那套），
 *      真值落宿主 `/api/assistant/secretary-read` → dsh-assistant-secretary-read.json，
 *      localStorage 只是首屏缓存与降级兜底（见 createSecretaryReadStore）。
 */

/** ────────────────────────── 1. 朗读文本规范化 ────────────────────────── */

/** 需要念成中文读法的常用单位：紧贴数字的写法优先（\b 在「数字+字母」之间不成立）。 */
const UNIT_READINGS: Array<[RegExp, string]> = [
  [/℃/g, '摄氏度'],
  [/°C/gi, '摄氏度'],
  [/°F/gi, '华氏度'],
  [/(\d)km\/h/gi, '$1 公里每小时'],
  [/(\d)km\b/gi, '$1 公里'],
  [/(\d)mm\b/g, '$1 毫米'],
  [/(\d)cm\b/g, '$1 厘米'],
  [/(\d)m\b/g, '$1 米'],
  [/(\d)kg\b/gi, '$1 公斤'],
  [/(\d)g\b/g, '$1 克'],
  [/(\d)ml\b/gi, '$1 毫升'],
  [/(\d)l\b/gi, '$1 升'],
]

/** 数字区间「8–14」/「8-14」→「8 到 14」（edge-tts 读「到」最自然）。 */
function expandRanges(text: string): string {
  return text.replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 到 $2')
}

/** 去掉引用标记（朗读时不能念出来）。 */
export function stripSessionRefs(text: string): string {
  return String(text ?? '').replace(/\[\[session:[^\]|]*\|[^\]]*\]\]/g, '')
}

/** 把卡片正文整理成适合朗读的纯文本（纯函数，单测直接验）。 */
export function normalizeForSpeech(raw: string): string {
  let text = stripSessionRefs(String(raw ?? ''))
  // 代码块 / 行内代码：直接去掉围栏，保留内容
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`([^`]*)`/g, '$1')
  // markdown 标题 / 加粗 / 斜体 / 引用符 / 分隔线 / 链接
  text = text.replace(/^#{1,6}\s*/gm, '')
  text = text.replace(/(\*\*|__)([^*_]*)\1/g, '$2')
  text = text.replace(/(\*|\b_)([^*_]+)\1/g, '$2')
  text = text.replace(/^>\s?/gm, '')
  text = text.replace(/^-{3,}\s*$/gm, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 列表符号（- * 1. ①）整行去掉符号
  text = text.replace(/^\s*(?:[-*+]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])\s+/gm, '')
  // URL / 邮箱
  text = text.replace(/https?:\/\/\S+/gi, ' ')
  text = text.replace(/\S+@\S+\.\S+/g, ' ')
  // 表情（ BMP + 常见补充区 ）
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
  // 单位与区间
  for (const [pattern, reading] of UNIT_READINGS) text = text.replace(pattern, reading)
  text = expandRanges(text)
  // 数字与汉字之间补空格（「14摄氏度」→「14 摄氏度」），TTS 断字更自然
  text = text.replace(/(\d)([\u4e00-\u9fff])/g, '$1 $2')
  // 空白收拢
  return text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, ' ').replace(/\n/g, '，').trim()
}

/** ────────────────────────── 2. 会话引用标记 ────────────────────────── */

export interface SessionRef {
  sessionId: string
  title: string
}

/** 从正文里解析 `[[session:<id>|<标题>]]` 引用块（纯函数）。 */
export function parseSessionRefs(raw: string): SessionRef[] {
  const out: SessionRef[] = []
  const text = String(raw ?? '')
  const pattern = /\[\[session:([^\]|]*)\|([^\]]*)\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const sessionId = String(match[1] ?? '').trim()
    const title = String(match[2] ?? '').trim()
    if (sessionId !== '') out.push({ sessionId, title: title === '' ? sessionId : title })
  }
  return out
}

/** ────────────────────────── 3. 朗读状态机 ────────────────────────── */

export type SpeechStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'
export type SpeechEvent =
  | { type: 'play'; key: string }
  | { type: 'playing'; key: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'toggle'; key: string }
  | { type: 'restart'; key: string }
  | { type: 'ended' }
  | { type: 'stop' }
  | { type: 'error'; error: string }

export interface SpeechState {
  status: SpeechStatus
  /** 当前这条内容的 key（turn key / card id），暂停/继续靠它。 */
  key: string
  error: string
}

export const SPEECH_IDLE: SpeechState = { status: 'idle', key: '', error: '' }

/**
 * 纯状态机（单测直接驱动）：
 *   play：换 key = 停旧启新（loading）；同 key 忽略。
 *   toggle：playing→paused；paused→playing；idle/loading→loading 不动；error→重播（play）。
 *   restart：无论播到哪，都回到 loading（播放器层从头 seek）。
 *   ended / stop / error：回 idle（error 记原因）。
 */
export function reduceSpeech(state: SpeechState, event: SpeechEvent): SpeechState {
  switch (event.type) {
    case 'play': {
      if (state.key === event.key && (state.status === 'loading' || state.status === 'playing' || state.status === 'paused')) return state
      return { status: 'loading', key: event.key, error: '' }
    }
    case 'playing':
      return state.key === event.key && state.status === 'loading' ? { status: 'playing', key: event.key, error: '' } : state
    case 'pause':
      return state.status === 'playing' ? { status: 'paused', key: state.key, error: '' } : state
    case 'resume':
      return state.status === 'paused' ? { status: 'playing', key: state.key, error: '' } : state
    case 'toggle': {
      if (state.key === event.key && state.status === 'playing') return { status: 'paused', key: state.key, error: '' }
      if (state.key === event.key && state.status === 'paused') return { status: 'playing', key: state.key, error: '' }
      if (state.key === event.key && state.status === 'loading') return state
      if (state.key === event.key && state.status === 'error') return { status: 'loading', key: event.key, error: '' }
      return { status: 'loading', key: event.key, error: '' }
    }
    case 'restart':
      return { status: 'loading', key: event.key, error: '' }
    case 'ended':
    case 'stop':
      return SPEECH_IDLE
    case 'error':
      return { status: 'error', key: state.key, error: String(event.error ?? '朗读失败') }
    default:
      return state
  }
}

/** 播放器抽象：浏览器里是 HTMLAudioElement，单测里是假的。 */
export interface SpeechPlayer {
  play(): Promise<void>
  pause(): void
  resume(): void
  restart(): void
  stop(): void
  onEnded(cb: () => void): void
  /** 真正开始出声（seek/restart 后也会再触发）：loading → playing 靠它。 */
  onPlaying?(cb: () => void): void
}

export type SpeechPlayerFactory = (key: string, text: string) => SpeechPlayer

/**
 * 朗读控制器：状态机 + 单一活动播放器（换 key 先停旧的 = 「切卡片停上一条」）。
 * React 侧用 useSyncExternalStore 订阅；单测里直接驱动事件。
 */
export function createSpeechController(factory: SpeechPlayerFactory) {
  let state: SpeechState = SPEECH_IDLE
  let player: SpeechPlayer | null = null
  let currentText = ''
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of [...listeners]) { try { listener() } catch {} } }
  const setState = (next: SpeechState): void => {
    if (next.status === state.status && next.key === state.key && next.error === state.error) return
    state = next
    emit()
  }

  const start = (key: string): void => {
    player?.stop()
    player = null
    currentText = ''
    const text = pendingText
    if (text === '') { setState(SPEECH_IDLE); return }
    currentText = text
    const next = factory(key, text)
    player = next
    next.onEnded(() => { if (player === next) { player = null; setState(reduceSpeech(state, { type: 'ended' })) } })
    try {
      next.onPlaying?.(() => { if (player === next && state.key === key) setState({ status: 'playing', key, error: '' }) })
    } catch { /* 播放器不支持 onPlaying 时靠 play() 的 Promise 兜底 */ }
    next.play()
      .then(() => { if (player === next) setState(reduceSpeech(state, { type: 'playing', key })) })
      .catch((error: unknown) => {
        if (player === next) { player = null; setState(reduceSpeech(state, { type: 'error', error: String((error as Error)?.message ?? error) })) }
      })
  }

  let pendingText = ''

  const api = {
    getSnapshot(): SpeechState { return state },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** 请求朗读一条内容（key 换 = 停上一条从头读；同 key 的 toggle 语义见状态机）。 */
    request(key: string, text: string): void {
      pendingText = text
      const before = state
      const next = reduceSpeech(state, { type: 'play', key })
      setState(next)
      if (next.key !== before.key || next.status === 'loading') start(key)
    },
    /**
     * 单击：暂停/继续；空闲/报错/换 key 时用**调用方传入的文本**起播。
     * text 必须是按钮所属卡片自己的规范化朗读文本 —— 绝不允许回退到
     * pendingText（那是「最后一次 request」的文本 = 自动朗读的最新一轮，
     * 历史卡点击会错读成最新一条，2026-11-21 实测 bug）。
     */
    toggle(key: string, text: string): void {
      if (state.key !== key || state.status === 'idle' || state.status === 'error') { api.request(key, text); return }
      if (state.status === 'loading') return
      if (state.status === 'playing') { player?.pause(); setState(reduceSpeech(state, { type: 'pause' })) }
      else if (state.status === 'paused') { player?.resume(); setState(reduceSpeech(state, { type: 'resume' })) }
    },
    /** 长按：从头发起（player 层 ensure 0 再播）。 */
    restart(key: string, text: string): void {
      if (state.key === key && player !== null) {
        setState(reduceSpeech(state, { type: 'restart', key }))
        player.restart() // 出声后由 onPlaying 把 loading → playing
        return
      }
      api.request(key, text)
    },
    stop(): void { player?.stop(); player = null; setState(SPEECH_IDLE) },
  }
  return api
}

/** ────────────────────────── 4. 轮文本收集（DOM 侧，客户端用） ────────────────────────── */

/**
 * 收集「某一轮」的秘书回复正文：同一 data-chat-turn 下、非 reasoning 的 assistant-step 文本。
 * 返回原文（未做朗读规范化；卡片展示用原文，朗读走 normalizeForSpeech）。
 *
 * 宿主已把 markdown 渲染成 DOM：`**重点**` 在页面上是 `<strong>重点</strong>`，直接读
 * textContent 会把星号丢掉，卡片就永远还原不出重点句。这里按节点序列化，把 strong/b
 * 重新包成 `**…**`，交给卡片自己的行内渲染（2026-11-21 卡片规范冒烟实测）。
 */
function stepTextWithEmphasis(el: any): string {
  const nodes = el?.childNodes ?? null
  if (nodes === null || nodes.length === 0) return String(el?.textContent ?? '')
  let out = ''
  for (const node of nodes) {
    if (node?.nodeType === 3) {
      out += String(node.textContent ?? '')
    } else if (node?.nodeType === 1) {
      const tag = String(node.tagName ?? '').toLowerCase()
      const inner = stepTextWithEmphasis(node)
      if (tag === 'strong' || tag === 'b') out += `**${inner}**`
      else if (tag === 'br') out += '\n'
      else out += inner
    }
  }
  return out
}

export function collectTurnText(doc: Document, turn: string): string {
  const out: string[] = []
  const turnNo = String(turn ?? '').trim()
  if (turnNo === '') return ''
  for (const el of doc.querySelectorAll(`[data-chat-turn="${turnNo}"][data-chat-flow-kind="assistant-step"]`)) {
    if (el.getAttribute('data-chat-group-part') === 'reasoning') continue
    const text = stepTextWithEmphasis(el).trim()
    if (text !== '') out.push(text)
  }
  return out.join('\n').trim()
}

/** 当前 DOM 里最大的轮次号（= 最末一轮；自动朗读只读它）。 */
export function latestTurnNo(doc: Document): string {
  let max = -1
  let out = ''
  for (const el of doc.querySelectorAll('[data-chat-turn]')) {
    const value = Number(el.getAttribute('data-chat-turn'))
    if (Number.isFinite(value) && value > max) { max = value; out = String(value) }
  }
  return out
}

/**
 * 最近一条**有正文的回复卡**轮次。合成通知若异常留下空白尾轮，
 * 自动朗读仍应读最后一条真实回复，不能被最大的 data-chat-turn 永久挡住。
 */
export function latestReplyTurnNo(doc: Document): string {
  let max = -1
  let out = ''
  for (const el of doc.querySelectorAll('[data-dsh-scard="card"][data-dsh-scard-turn]')) {
    if (el.getAttribute('data-dsh-scard-kind') === CARD_KIND_USER) continue
    if (el.getAttribute('data-empty') === '1') continue
    const value = Number(el.getAttribute('data-dsh-scard-turn'))
    if (Number.isFinite(value) && value > max) { max = value; out = String(value) }
  }
  return out
}

/** ────────────────────────── 5. 卡片呈现纯函数（node 可单测） ────────────────────────── */

/**
 * 主动卡胶囊色调：按 badge / 标题里的类型词归类，同类卡配色一致。
 *   主动关心 → care（暖橙）｜任务完成 → done（蓝）｜主动探索 → explore（紫）
 *   征求授权 → auth（红）｜默认主动服务 → serve（绿）
 */
export type BadgeTone = 'serve' | 'care' | 'done' | 'explore' | 'auth'
export function badgeTone(badge: string, title: string = ''): BadgeTone {
  const text = `${String(badge ?? '')} ${String(title ?? '')}`
  if (/授权|批准|确认/.test(text)) return 'auth'
  if (/完成|搞定|办结|交付/.test(text)) return 'done'
  if (/探索|发现|调研|找找|搜索/.test(text)) return 'explore'
  if (/关心|提醒|注意|建议|注意身体|出行|天气/.test(text)) return 'care'
  return 'serve'
}

/** 要点行拆分：「天气：武汉明日…」→ { prefix: '天气：', rest: '武汉明日…' }。
 *  前缀必须以汉字开头、不含数字（「10:30」这类时间不会被拆成前缀）。 */
export function splitItemPrefix(text: string): { prefix: string; rest: string } {
  const raw = String(text ?? '').trim()
  const match = raw.match(/^([一-鿿][^：:，,\d]{0,7}[：:])([\s\S]*)$/)
  if (match === null) return { prefix: '', rest: raw }
  return { prefix: match[1], rest: match[2].trim() }
}

/** 要点行小图标：按关键词给emoji（天气/车次/地点/时间），默认小圆点。 */
export function itemIcon(text: string): string {
  const raw = String(text ?? '')
  if (/天气|温度|气温|雨|雪|晴|阴|风/.test(raw)) return '🌤'
  if (/车|高铁|火车|航班|飞机|站|行程|出发|到达/.test(raw)) return '🚄'
  if (/地点|地址|会场|实验室|家里|公司|武汉|孝感/.test(raw)) return '📍'
  if (/时间|点钟|会议|截止|提醒|日程|安排/.test(raw)) return '🕐'
  return '·'
}

/** 一句话摘要：取首行、截断加省略号（旧主动卡仍可用）。 */
export function summarize(text: string, max = 22): string {
  const line = String(text ?? '').split('\n').map((s) => s.trim()).find((s) => s !== '') ?? ''
  const clean = line.replace(/\s+/g, ' ')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

export type AnswerTokenKind = 'text' | 'strong' | 'model'
export interface AnswerToken {
  kind: AnswerTokenKind
  value: string
}

const MODEL_NAME_RE = /\b(?:qwen[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|deepseek[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|glm(?:[-_.][A-Za-z0-9]+)*|kimi[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|llama[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|mistral[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|phi[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|gpt[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|claude[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|gemini[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|grok[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*|IQ[1-9]_[A-Z][A-Z0-9]*|fp[1-9]\d*)\b/gi

/** 卡片正文解析：第一行做结论标题，其后按段落渲染；长首句退化为一句标题。 */
export function parseAnswerBody(text: string): { title: string; paragraphs: string[] } {
  const lines = String(text ?? '').split(/\n{2,}|\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return { title: '', paragraphs: [] }
  let [title, ...paragraphs] = lines
  if (title.length > 48) {
    const match = title.match(/^([\s\S]{1,48}?[。！？!?.])([\s\S]*)$/)
    if (match !== null) {
      title = match[1].trim()
      const rest = match[2].trim()
      if (rest !== '') paragraphs = [rest, ...paragraphs]
    }
  }
  return { title, paragraphs }
}

function splitStrongSegments(text: string): Array<{ kind: 'text' | 'strong'; value: string }> {
  const raw = String(text ?? '')
  const parts: Array<{ kind: 'text' | 'strong'; value: string }> = []
  const pattern = /\*\*([^*]+)\*\*/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) parts.push({ kind: 'text', value: raw.slice(cursor, match.index) })
    if (match[1] !== '') parts.push({ kind: 'strong', value: match[1] })
    cursor = match.index + match[0].length
  }
  if (cursor < raw.length) parts.push({ kind: 'text', value: raw.slice(cursor) })
  return parts
}

function splitModelTokens(text: string): AnswerToken[] {
  const raw = String(text ?? '')
  const tokens: AnswerToken[] = []
  const pattern = new RegExp(MODEL_NAME_RE.source, MODEL_NAME_RE.flags)
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) tokens.push({ kind: 'text', value: raw.slice(cursor, match.index) })
    tokens.push({ kind: 'model', value: match[0] })
    cursor = match.index + match[0].length
    if (match[0] === '') pattern.lastIndex += 1
  }
  if (cursor < raw.length) tokens.push({ kind: 'text', value: raw.slice(cursor) })
  return tokens
}

/** 行内渲染计划：重点句用 strong，模型名/量化版本用 model-code 标签。 */
export function answerInlineTokens(text: string): AnswerToken[] {
  return splitStrongSegments(text).flatMap((segment) => (
    segment.kind === 'strong' ? [{ kind: 'strong' as const, value: segment.value }] : splitModelTokens(segment.value)
  )).filter((token) => token.value !== '')
}

/** ISO/时间戳 → 卡片脚部时间（2026-11-21 用户改需求）：**只写时间**，不再带「今天」字样。
 *  当天 → `H:MM`（例 9:08，小时不补零、分钟补零）；昨天 → `昨天 H:MM`；更早 → `M月d日 H:MM`。
 *  解析不了回空串（脚部就不显示时间）。 */
export function formatClock(input: unknown, now: Date = new Date()): string {
  const raw = String(input ?? '').trim()
  if (raw === '') return ''
  const date = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const hm = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOf(now) - startOf(date)) / 86400000)
  if (dayDiff <= 0) return hm
  if (dayDiff === 1) return `昨天 ${hm}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
}

/** ─────────────── 6. 用户卡（秘书页真实用户消息）纯函数 ─────────────── */

/** 卡壳主题标识：秘书回复卡 kind=assistant（紫）、用户卡 kind=user（冷蓝）、通知卡 kind=notice（中性灰）。 */
export const CARD_KIND_ASSISTANT = 'assistant'
export const CARD_KIND_USER = 'user'
export const CARD_KIND_NOTICE = 'notice'

/**
 * 折叠态正文预算（2026-11-21 用户改需求）：三种卡共用，折叠态最多 **3 行正文**（不是 3 个内容块）。
 * 卡标题（17px）与要点行里的行内标签不占这 3 行的预算，正文按行高切，超出部分打省略标记。
 */
export const FOLD_BODY_LINE_BUDGET = 3
/** 卡片内正文块之间的距离（与 CSS 的 content gap 一致）。 */
export const FOLD_BLOCK_GAP = 10

/** 一个正文块在卡片正文里的位置（offsetTop）与高度（offsetHeight）——浏览器量的，纯函数只管算术。 */
export interface FoldBlockBox {
  /** title = 卡标题（17px，不占正文行数预算、永远露出）；para = 正文段落；ref = 会话引用 chip。 */
  kind: 'title' | 'para' | 'ref'
  top: number
  height: number
}

export interface FoldGeometryOut {
  /** 折叠态正文的 max-height（px）；不溢出就是 undefined（正文自然高度）。 */
  collapsedMaxHeight: number | undefined
  /** 正文是不是被 `budget` 行切掉了（决定「…」省略标记与「展开全文」入口）。 */
  overflow: boolean
  /** 折叠态实际露出的正文行数（<= budget）。 */
  bodyLines: number
  /** 切掉的行箱落点（px）；未溢出时 = 自然高度。 */
  clip: number
}

/**
 * 折叠几何（三种卡共用一套算术，浏览器只负责量块的位置，算法在这里）：
 *   - 卡标题不参与 3 行预算、永远露出；
 *   - 段落按行高累加，落点正好停在第 `budget` 行的行尾，绝不切出半行字；
 *   - 引用 chip 算一整块（不可切一半）；
 *   - 块与块之间的距离按 top 天然算进高度。
 */
export function foldClipFromBlocks(input: {
  blocks: readonly FoldBlockBox[]
  naturalHeight: number
  lineHeight: number
  budget?: number
}): FoldGeometryOut {
  const budget = Math.max(1, Number(input.budget ?? FOLD_BODY_LINE_BUDGET))
  const lineHeight = Number(input.lineHeight)
  const natural = Math.max(1, Math.round(Number(input.naturalHeight) || 1))
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return { collapsedMaxHeight: undefined, overflow: false, bodyLines: 0, clip: natural }
  }
  const bodyBlocks = input.blocks.filter((block) => block.kind !== 'title')
  if (bodyBlocks.length === 0) return { collapsedMaxHeight: undefined, overflow: false, bodyLines: 0, clip: natural }

  let running = 0
  let lastBottom = 0
  let clip: number | undefined
  for (const block of bodyBlocks) {
    const top = Math.max(0, Math.round(block.top))
    const height = Math.max(1, Math.round(block.height || lineHeight))
    const lines = block.kind === 'ref' ? 1 : Math.max(1, Math.round(height / lineHeight))
    const remaining = budget - running
    if (remaining <= 0) { clip = lastBottom; break }
    if (lines <= remaining) {
      running += lines
      lastBottom = top + height
      continue
    }
    clip = top + remaining * lineHeight
    running = budget
    break
  }
  if (clip === undefined) return { collapsedMaxHeight: undefined, overflow: false, bodyLines: running, clip: natural }
  const maxHeight = Math.max(1, Math.min(Math.round(clip), natural))
  const overflow = maxHeight < natural - 1
  return { collapsedMaxHeight: overflow ? maxHeight : undefined, overflow, bodyLines: running, clip: maxHeight }
}


/** 合成通知判据 ①：首行是「（系统通知，不是用户说的话）」（宽/半角括号、方括号写法都算）。 */
const NOTICE_HEAD_LINE_RE = /^\s*[（(【\[]?\s*系统通知/
/** 判据 ②：正文里带 `[[session:id|标题]]` 引用行（src/assistant-cu-watch.ts 注入格式）。 */
const NOTICE_SESSION_REF_LINE_RE = /(^|\n)\s*(最后单独一行原样输出：)?\s*\[\[session:[^\]]*\]\]/

/** 这条 user 角色正文是不是插件自己塞进来的合成通知（不该做成「用户卡」）。 */
export function isSyntheticNoticeUserText(raw: string): boolean {
  const text = String(raw ?? '')
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return false
  if (NOTICE_HEAD_LINE_RE.test(lines[0])) return true
  return lines.some((line) => NOTICE_SESSION_REF_LINE_RE.test(`\n${line}`))
}

/** 用户卡正文：显示用户原文（不做标题化、不改写、不删行），按空行分段。 */
export function parseUserCardBody(raw: string): string[] {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (text === '') return []
  return text.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== '')
}

/** 朗读 key：每张用户卡自己的 key（按卡的所属文本，不串卡）。 */
export function userCardSpeechKey(messageKey: string, turnNo = ''): string {
  const key = String(messageKey ?? '').trim()
  if (key !== '') return `user:${key}`
  const turn = String(turnNo ?? '').trim()
  return turn === '' ? '' : `user:turn:${turn}`
}

/** 通知卡朗读 key：`notice:` 前缀 + 宿主那条消息的稳定 key（同一张卡跨端一致）。 */
export function noticeCardSpeechKey(messageKey: string, turnNo = ''): string {
  const key = String(messageKey ?? '').trim()
  if (key !== '') return `notice:${key}`
  const turn = String(turnNo ?? '').trim()
  return turn === '' ? '' : `notice:turn:${turn}`
}

/** 秘书回复卡朗读 key（2026-11-21 加 `assistant:` 前缀：既是朗读 key，也是已读 cardKey）。 */
export function assistantCardSpeechKey(turnNo: string): string {
  const turn = String(turnNo ?? '').trim()
  return turn === '' ? '' : `assistant:turn:${turn}`
}

/** 通知卡正文：把「系统通知」合成行里的真实内容挑出来（第一行合成标记与「最后单独一行原样输出：」前缀不进卡片正文）。 */
export function stripNoticeSyntheticHead(raw: string): string {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (text === '') return ''
  const lines = text.split('\n')
  while (lines.length > 0 && NOTICE_HEAD_LINE_RE.test(lines[0])) lines.shift()
  const cleaned = lines.map((line) => line
    .replace(/^\s*最后单独一行原样输出[：:]\s*/, '')
    .trim())
  return cleaned.filter((line) => line !== '').join('\n')
}

/** 通知卡正文解析：与秘书回复卡同一套（首行做标题、其余段落），引用标记单独成 chip。 */
export function parseNoticeCardBody(raw: string): { title: string; paragraphs: string[] } {
  return parseAnswerBody(stripNoticeSyntheticHead(raw))
}

/** 底行时间：宿主操作行的时间文本 → 卡片脚部只写时间（去掉「今天」字样；已是「昨天 …」/「11月20日 …」原样用）。 */
export function formatUserCardClock(clockText: unknown): string {
  const raw = String(clockText ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return ''
  const stripped = raw.replace(/^今天\s+/, '')
  const match = stripped.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  return match === null ? stripped : stripped
}

export interface SecretaryUserRow {
  /** 卡片要挂进的那条宿主用户行（portal 容器）。 */
  element: Element
  /** 稳定 key（宿主的 data-chat-node-key / data-chat-flow-key，含消息 id）。 */
  key: string
  turnNo: string
  /** 用户原文（取自宿主纯文本 run）。 */
  text: string
  /** 宿主操作行上的时间文本（已按卡片规则格式化前）。 */
  clockText: string
}

/** 秘书页里那些「user 角色」行的分类：真实用户输入 → 冷蓝用户卡；插件塞进来的合成通知 → 灰底通知卡。 */
export type SecretaryCardKind = typeof CARD_KIND_USER | typeof CARD_KIND_NOTICE
export interface SecretaryCardRow extends SecretaryUserRow {
  kind: SecretaryCardKind
}

/**
 * 收集秘书页对话流里**所有 user 角色的行**并分类：
 *   - 只认宿主稳定语义标记 `[data-chat-flow-kind="user"]`；
 *   - 合成通知（系统通知 / `[[session:]]` 引用行）标成 notice（灰底通知卡，带可点引用 chip）；
 *   - 真实用户消息标成 user（冷蓝用户卡）；
 *   - 文本从 `[data-slot="conversation.user.text.node"]` 读，卡片自身挂在行上，不会把自己读回去。
 */
export function collectSecretaryCardRows(doc: Document): SecretaryCardRow[] {
  const out: SecretaryCardRow[] = []
  for (const row of doc.querySelectorAll('[data-chat-flow-kind="user"]')) {
    const key = row.getAttribute('data-chat-node-key') ?? row.getAttribute('data-chat-flow-key') ?? ''
    const turnNo = row.getAttribute('data-chat-turn') ?? ''
    const textEl = row.querySelector('[data-slot="conversation.user.text.node"]')
    const text = String(textEl?.textContent ?? '').trim()
    if (text === '') continue
    const clockEl = row.querySelector('[data-clock]')
    const kind: SecretaryCardKind = isSyntheticNoticeUserText(text) ? CARD_KIND_NOTICE : CARD_KIND_USER
    out.push({ element: row, key, turnNo, text, clockText: String(clockEl?.textContent ?? '').trim(), kind })
  }
  return out
}

/** 只取真实用户行（冷蓝用户卡用）；判据与 collectSecretaryCardRows 同一套，防止三条路径串味。 */
export function collectSecretaryUserRows(doc: Document): SecretaryUserRow[] {
  return collectSecretaryCardRows(doc).filter((row) => row.kind === CARD_KIND_USER)
}

/** ─────────────── 7. 已读卡集合（未读红点的持久化） ─────────────── */

/** 宿主侧「已读卡」路由（服务端 src/assistant-secretary.ts 注册同一字符串）。 */
export const ASSISTANT_SECRETARY_READ_ROUTE = '/api/assistant/secretary-read'
/** 本地缓存键前缀（真值仍在宿主，localStorage 只是宿主答不上时的降级缓存）。 */
export const READ_STORAGE_PREFIX = 'dsh.assistant.secretary.read:'
/** 每个会话最多记多少条已读 cardKey（去噪：写满就把最旧的一条丢掉）。 */
export const MAX_READ_KEYS = 400
const CARD_KEY_RE = /^[A-Za-z0-9:._#-]{1,200}$/

/** 归一一条 cardKey：只接受 key 形态，别的（空、超长、带空格）一律判坏。 */
export function normalizeCardKey(raw: unknown): string {
  const value = String(raw ?? '').trim()
  return CARD_KEY_RE.test(value) ? value : ''
}

/** 归一宿主/缓存送来的已读集合：坏值丢掉，按序去重，截到上限（保留最新的）。 */
export function normalizeReadKeys(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const out: string[] = []
  for (const item of list) {
    const key = normalizeCardKey(item)
    if (key === '' || out.includes(key)) continue
    out.push(key)
  }
  return out.length > MAX_READ_KEYS ? out.slice(out.length - MAX_READ_KEYS) : out
}

export interface SecretaryReadDeps {
  /** 浏览器里是 window.fetch；单测里是假实现。缺 → 按「宿主答不上」降级。 */
  fetchImpl?: (url: string, init?: any) => Promise<any>
  /** 本地兜底缓存（宿主答不上时还能立刻知道已读）；缺 → 只用心跳集合。 */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null
}

export interface SecretaryReadStore {
  session(): string
  setSession(sessionId: string): void
  isRead(cardKey: string): boolean
  /** 标记已读：立刻本地生效（红点当场消失），再写缓存 + 落宿主；宿主失败不阻塞。 */
  markRead(cardKey: string): boolean
  /** 取宿主已读集合（先宿主、再叠本地缓存）；宿主答不上时按本地缓存继续。 */
  hydrate(): Promise<{ ok: boolean; hostOk: boolean; count: number }>
  subscribe(listener: () => void): () => void
  /** useSyncExternalStore 的快照：一个版本号（卡片用它订阅，再问 isRead）。 */
  getVersion(): number
  keys(): string[]
}

export function createSecretaryReadStore(deps: SecretaryReadDeps = {}): SecretaryReadStore {
  const read = new Set<string>()
  const order: string[] = []
  const listeners = new Set<() => void>()
  const storageKey = READ_STORAGE_PREFIX
  let session = ''
  let version = 0
  let hydrateCall: Promise<{ ok: boolean; hostOk: boolean; count: number }> | null = null
  /** 宿主没答上过（404/网络失败）就别再反复打；本地缓存仍是权威兜底。 */
  let hostBroken = false

  const emit = (): void => { for (const listener of [...listeners]) { try { listener() } catch { /* 单个订阅者出错不影响别的 */ } } }
  const bump = (): void => { version += 1; emit() }
  const add = (cardKey: string): boolean => {
    const key = normalizeCardKey(cardKey)
    if (key === '' || read.has(key)) return false
    read.add(key)
    order.push(key)
    while (order.length > MAX_READ_KEYS) {
      const oldest = order.shift() ?? ''
      if (oldest !== '') read.delete(oldest)
    }
    return true
  }
  const addAll = (keys: readonly string[]): number => {
    let added = 0
    for (const key of keys) if (add(key)) added += 1
    if (added > 0) bump()
    return added
  }
  const storage = deps.storage ?? null
  const readCache = (): string[] => {
    if (storage === null || session === '') return []
    try { return normalizeReadKeys(JSON.parse(String(storage.getItem(`${storageKey}${session}`) ?? '[]')) as unknown) } catch { return [] }
  }
  const writeCache = (): void => {
    if (storage === null || session === '') return
    try { storage.setItem(`${storageKey}${session}`, JSON.stringify(order.slice(-MAX_READ_KEYS))) } catch { /* 缓存写不进去就靠集合内存 */ }
  }
  const postRead = (cardKey: string): void => {
    const fetchImpl = deps.fetchImpl
    if (hostBroken || typeof fetchImpl !== 'function' || session === '') return
    void Promise.resolve(fetchImpl(ASSISTANT_SECRETARY_READ_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session, cardKey, mark: 'read' }),
    })).then((res: any) => {
      if (res?.ok !== true) { hostBroken = true; return }
      return res.json?.().then((payload: any) => { if (payload?.ok !== true) hostBroken = true })
    }).catch(() => { hostBroken = true })
  }

  return {
    session: () => session,
    setSession(sessionId: string): void {
      const id = String(sessionId ?? '').trim()
      if (id === session) return
      session = id
      hydrateCall = null
      addAll(readCache())
    },
    isRead(cardKey: string): boolean {
      const key = normalizeCardKey(cardKey)
      return key !== '' && read.has(key)
    },
    markRead(cardKey: string): boolean {
      const key = normalizeCardKey(cardKey)
      if (key === '') return false
      if (read.has(key)) return true
      add(key)
      bump()
      writeCache()
      postRead(key)
      return true
    },
    hydrate(): Promise<{ ok: boolean; hostOk: boolean; count: number }> {
      if (hydrateCall !== null) return hydrateCall
      hydrateCall = (async (): Promise<{ ok: boolean; hostOk: boolean; count: number }> => {
        addAll(readCache())
        const fetchImpl = deps.fetchImpl
        if (hostBroken || session === '' || typeof fetchImpl !== 'function') {
          return { ok: true, hostOk: false, count: order.length }
        }
        try {
          const res = await fetchImpl(`${ASSISTANT_SECRETARY_READ_ROUTE}?sessionId=${encodeURIComponent(session)}`, { cache: 'no-store' })
          if (res?.ok !== true) { hostBroken = true; return { ok: true, hostOk: false, count: order.length } }
          const payload = await res.json()
          const hostKeys = normalizeReadKeys((payload as any)?.cards)
          if ((payload as any)?.ok !== true) { hostBroken = true; return { ok: true, hostOk: false, count: order.length } }
          addAll(hostKeys)
          writeCache()
          return { ok: true, hostOk: true, count: order.length }
        } catch {
          hostBroken = true
          return { ok: true, hostOk: false, count: order.length }
        }
      })()
      return hydrateCall
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    getVersion(): number { return version },
    keys(): string[] { return [...order] },
  }
}

/**
 * 卡片组件共用的**进程内已读 store**（懒创建）：真值在宿主 `/api/assistant/secretary-read`，
 * localStorage 只是首屏缓存与宿主答不上时的兜底；node 环境（没有 fetch/localStorage）不会去要。
 */
let cardReadStore: SecretaryReadStore | null = null
export function secretaryReadStore(): SecretaryReadStore {
  if (cardReadStore !== null) return cardReadStore
  const g: any = globalThis as any
  const fetchImpl = typeof g.fetch === 'function' ? (url: string, init?: any) => g.fetch(url, init) : undefined
  let storage: SecretaryReadDeps['storage'] = null
  try { if (g.localStorage && typeof g.localStorage.getItem === 'function') storage = g.localStorage } catch { storage = null }
  cardReadStore = createSecretaryReadStore({ fetchImpl, storage })
  return cardReadStore
}

/** 单测入口（node 直驱状态机与纯函数）。 */
export const secretaryCardsTestSurface = {
  normalizeForSpeech,
  stripSessionRefs,
  parseSessionRefs,
  reduceSpeech,
  createSpeechController,
  SPEECH_IDLE,
  latestTurnNo,
  latestReplyTurnNo,
  collectTurnText,
  badgeTone,
  splitItemPrefix,
  itemIcon,
  summarize,
  parseAnswerBody,
  answerInlineTokens,
  formatClock,
  CARD_KIND_ASSISTANT,
  CARD_KIND_USER,
  CARD_KIND_NOTICE,
  FOLD_BODY_LINE_BUDGET,
  FOLD_BLOCK_GAP,
  isSyntheticNoticeUserText,
  stripNoticeSyntheticHead,
  parseNoticeCardBody,
  parseUserCardBody,
  userCardSpeechKey,
  noticeCardSpeechKey,
  assistantCardSpeechKey,
  formatUserCardClock,
  collectSecretaryUserRows,
  collectSecretaryCardRows,
  foldClipFromBlocks,
  ASSISTANT_SECRETARY_READ_ROUTE,
  READ_STORAGE_PREFIX,
  MAX_READ_KEYS,
  normalizeCardKey,
  normalizeReadKeys,
  createSecretaryReadStore,
  secretaryReadStore,
}
