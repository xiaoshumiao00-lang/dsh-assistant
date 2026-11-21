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
 */
export function collectTurnText(doc: Document, turn: string): string {
  const out: string[] = []
  const turnNo = String(turn ?? '').trim()
  if (turnNo === '') return ''
  for (const el of doc.querySelectorAll(`[data-chat-turn="${turnNo}"][data-chat-flow-kind="assistant-step"]`)) {
    if (el.getAttribute('data-chat-group-part') === 'reasoning') continue
    const text = (el.textContent ?? '').trim()
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

/** 一句话摘要：取首行、截断加省略号（标题行用）。 */
export function summarize(text: string, max = 22): string {
  const line = String(text ?? '').split('\n').map((s) => s.trim()).find((s) => s !== '') ?? ''
  const clean = line.replace(/\s+/g, ' ')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** ISO/时间戳 → 「今天 HH:MM」/「昨天 HH:MM」/「M月d日 HH:MM」；解析不了回空串。 */
export function formatClock(input: unknown, now: Date = new Date()): string {
  const raw = String(input ?? '').trim()
  if (raw === '') return ''
  const date = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOf(now) - startOf(date)) / 86400000)
  if (dayDiff <= 0) return `今天 ${hm}`
  if (dayDiff === 1) return `昨天 ${hm}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
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
  badgeTone,
  splitItemPrefix,
  itemIcon,
  summarize,
  formatClock,
}
