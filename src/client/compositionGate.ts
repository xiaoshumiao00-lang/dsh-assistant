/**
 * 组合输入 / 抽屉动画闸门（模块级单例，控制室 + 手机布局共用同一份）。
 *
 * 为什么需要它：手机上一条长会话详情实测约 2 万 DOM 节点，插件在页面上挂着好几个
 * `document.body` 级 MutationObserver，加上控制室 1.2s 的活动扫描、3s 跨端状态轮询。
 * 用户在输入框里打字（尤其是系统语音输入法：微信键盘/讯飞的**实时**转写）时，这些
 * 工作照常在跑，其中任何一次改写输入框 subtree 的 DOM（Lexical 的重建、把节点搬进
 * 统计行、往链接旁边插「复制」按钮）都会让 Android/WebView 的 IME 组合被打断 ——
 * 现象就是「说几个词语音就自己停了」。同一条理由也解释抽屉开合时那一下卡顿：
 * 0.28s 的 transform 动画期间，主线程被扫描/补丁抢帧。
 *
 * 判据（都只影响插件自己的活，宿主该渲染照渲染）：
 * - `compositionstart` 到 `compositionend`（外加 COMPOSITION_GRACE_MS 的收尾窗，
 *   引擎常在组合结束后才补发最后一个 keydown）；
 * - 显式 `pause(ms)`：抽屉开合动画这类交互窗口。
 * - 兜底：超过 LONG_COMPOSITION_MS 仍没等到 compositionend（引擎没发、或语音一直
 * 不结束）就自动放行，插件不会永久锁死。
 *
 * 纯函数 + 注入 clock，node 单测不需要 DOM（scripts/test-composition-gate.mjs）。
 */

/** 组合结束后的「仍在打字」收尾窗：等引擎迟到的 keydown / 最后一批 mutation。 */
export const COMPOSITION_GRACE_MS = 140
/** 一次交互窗口（抽屉开合等）默认暂停时长，覆盖 0.28s 过渡 + 宿主重排。 */
export const INTERACTION_PAUSE_MS = 360
/** 组合最长生命周期：超过就认为引擎没发 compositionend，放行插件的补丁器。 */
export const LONG_COMPOSITION_MS = 120000

export interface CompositionGate {
  /** 主动暂停 ms 毫秒（取「已有窗口」与「新窗口」的较大值，不缩短当前窗口）。 */
  pause(ms?: number): void
  /** 当前是否该让路（正在组合，或仍在暂停窗口内）。 */
  isPaused(): boolean
  /** 只问「正在组合」这条（补丁器想区分「用户在输入」时用它）。 */
  isComposing(): boolean
  /** 让路时不执行：`run` 只在没在暂停窗口里才跑，返回 undefined 表示这次跳过。 */
  tryRun<T>(run: () => T): T | undefined
  /** 组合开始（compositionstart）。 */
  beginComposition(): void
  /** 组合结束（compositionend）：进入收尾窗。 */
  endComposition(): void
  /** 测试用：把内部状态清零。 */
  reset(): void
}

/**
 * 建一个闸门。
 * @param clock - 注入的时钟（测试可用假时钟）。
 */
export function createGate(clock: () => number = () => Date.now()): CompositionGate {
  let until = 0
  let composing = false
  let composingSince = 0

  const pause = (ms: number = INTERACTION_PAUSE_MS): void => {
    const to = clock() + (Number.isFinite(ms) ? ms : INTERACTION_PAUSE_MS)
    if (to > until) until = to
  }

  const isPaused = (): boolean => {
    const now = clock()
    if (composing) {
      if (now - composingSince < LONG_COMPOSITION_MS) return true
      // 引擎没发 compositionend / 语音长时间不结束：放行，别让插件自己卡死
      composing = false
    }
    return now < until
  }

  return {
    pause,
    isPaused,
    isComposing: () => composing,
    tryRun<T>(run: () => T): T | undefined {
      if (isPaused()) return undefined
      return run()
    },
    beginComposition() {
      composing = true
      composingSince = clock()
    },
    endComposition() {
      if (!composing) return
      composing = false
      pause(COMPOSITION_GRACE_MS)
    },
    reset() {
      until = 0
      composing = false
      composingSince = 0
    },
  }
}

/** 客户端全局闸门：assistant.tsx 装监听，其它模块 import 这一份。 */
export const domGate = createGate()

/** 一次组合的样本：时长 + 输入框最终文本长度 + 相对开始时的增量 + 归类。 */
export interface CompositionSample {
  ms: number
  chars: number
  delta: number
  kind: VoiceSampleKind
}

/**
 * 归类：长语音真写进去了 / 写进去但很短 / 说了很久一个字没出 / 短组合没出字 /
 * 上一段还没等到 compositionend 就来了新的一段（= 被中止）。
 */
export type VoiceSampleKind = 'long-typed' | 'typed' | 'silent-long' | 'silent-short' | 'interrupted'

/** 多长算「长段语音」：实时转写正常说话是持续输出的，3 秒起算。 */
export const VOICE_LONG_MS = 3000
/** 超过这个时长还不进字，就不是「只打了一个字」，而是识别挂了 / 被中止。 */
export const VOICE_SILENT_MS = 2500

/**
 * 语音样本的本地汇总（纯计数，不发网络）：诊断流水里要的是「说了几段、进去多少字、
 * 有几段是被中止的」，不是一个字发一条 beacon。
 * bump() 返回 true = 该发一份汇总了（可疑中止立刻发；其余每 20 段合并发一次）。
 */
export interface VoiceTally {
  n: number
  typed: number
  longTyped: number
  silentLong: number
  silentShort: number
  interrupted: number
  chars: number
  maxMs: number
}

export const VOICE_TALLY_BATCH = 20

export function createVoiceTally(): {
  bump: (sample: CompositionSample) => boolean
  snapshot: () => VoiceTally
  reset: () => void
} {
  let tally: VoiceTally = {
    n: 0, typed: 0, longTyped: 0, silentLong: 0, silentShort: 0, interrupted: 0, chars: 0, maxMs: 0,
  }
  const count: Record<VoiceSampleKind, keyof VoiceTally> = {
    typed: 'typed',
    'long-typed': 'longTyped',
    'silent-long': 'silentLong',
    'silent-short': 'silentShort',
    interrupted: 'interrupted',
  }
  return {
    bump(sample: CompositionSample): boolean {
      tally.n += 1
      tally.chars += Math.max(0, sample.delta)
      if (sample.ms > tally.maxMs) tally.maxMs = sample.ms
      const key = count[sample.kind]
      if (key !== undefined) tally[key] = (tally[key] as number) + 1
      // 可疑中止（上一段没等到 compositionend / 说了很久一个字都没进）立刻发；
      // 正常打字别把网络打成每敲一下一发。
      if (sample.kind === 'interrupted' || sample.kind === 'silent-long') return true
      return tally.n >= VOICE_TALLY_BATCH
    },
    snapshot(): VoiceTally {
      return { ...tally }
    },
    reset(): void {
      tally = { n: 0, typed: 0, longTyped: 0, silentLong: 0, silentShort: 0, interrupted: 0, chars: 0, maxMs: 0 }
    },
  }
}

/** 纯归类（单测直接判）。 */
export function classifyCompositionSample(ms: number, delta: number): Exclude<VoiceSampleKind, 'interrupted'> {
  if (delta > 0) return ms >= VOICE_LONG_MS ? 'long-typed' : 'typed'
  return ms >= VOICE_SILENT_MS ? 'silent-long' : 'silent-short'
}

/** 输入框当前文本的长度：探针只读这一条，绝不写任何 DOM。 */
export function composerTextLength(doc: any, selector: string = '[data-composer-card]'): number {
  if (doc === null || doc === undefined || typeof doc.querySelector !== 'function') return 0
  try {
    const el = doc.querySelector(selector)
    if (el === null || el === undefined) return 0
    return String(el.textContent ?? '').length
  } catch {
    return 0
  }
}

/**
 * 语音探针：只在意 compositionstart / compositionend 这两个边界，全程只读不写 DOM
 * ——「插件写输入框那一棵树」才是要打断语音的那件事，探针不许干那件。
 * 它把「说几个词就自己停」变成可查的数字：组合时长、进没进字、有没有被中止。
 */
/** 探针样本往哪儿报：手机布局把它接进诊断流水；桌面布局不设 = 一个样本也不读 DOM。 */
let voiceReporter: ((sample: CompositionSample) => void) | null = null

/** 注册 / 撤下语音样本的接收方（传 null 撤下）。 */
export function setVoiceReporter(reporter: ((sample: CompositionSample) => void) | null): void {
  voiceReporter = typeof reporter === 'function' ? reporter : null
}

/** 有没有人接着样本：没人接的时候探针一律不读 DOM（省掉每次组合的两整页扫描）。 */
export function hasVoiceReporter(): boolean {
  return voiceReporter !== null
}

function forwardVoiceSample(sample: CompositionSample): void {
  const reporter = voiceReporter
  if (reporter === null) return
  try {
    reporter(sample)
  } catch {
    /* 打点绝不影响输入 */
  }
}

export function createVoiceProbe(options: {
  doc?: any
  onSample?: (sample: CompositionSample) => void
  clock?: () => number
  reader?: (doc: any) => number
}): { onStart: () => void; onEnd: () => void; dispose: () => void } {
  const doc = options.doc ?? (globalThis as any).document
  const clock = options.clock ?? (() => Date.now())
  const read = options.reader ?? ((target: any) => composerTextLength(target))
  const explicit = options.onSample
  const sink = explicit ?? forwardVoiceSample
  /** 有没有人接样本：没人接就不读 DOM（省掉每次组合一遍的整页扫描）。 */
  const interested = (): boolean => explicit !== undefined || hasVoiceReporter()
  let startedAt: number | null = null
  let charsAtStart = 0

  const take = (interrupted: boolean): void => {
    if (startedAt === null) return
    const at = startedAt
    startedAt = null
    if (!interested()) return
    const ms = clock() - at
    const chars = read(doc)
    const delta = chars - charsAtStart
    const kind: VoiceSampleKind = interrupted
      ? 'interrupted'
      : classifyCompositionSample(ms, delta)
    try {
      sink({ ms: Math.round(ms), chars, delta, kind })
    } catch {
      /* 打点绝不影响输入 */
    }
  }

  return {
    onStart() {
      // 上一段没等到 compositionend 就又来一段：那段就是被中止的（微信键盘实时转写的典型现象）
      if (startedAt !== null) take(true)
      startedAt = clock()
      charsAtStart = interested() ? read(doc) : 0
    },
    onEnd() {
      take(false)
    },
    dispose() {
      startedAt = null
      charsAtStart = 0
    },
  }
}

/**
 * 把组合事件接到闸门上。
 * @param gate - 闸门（默认模块单例）。
 * @param doc - 注入的 document（测试用）。
 * @param options - 语音探针（onSample 只读不写：把「说几个词就自己停」变成数字）。
 * @returns 卸载函数。
 */
export function installCompositionGate(
  gate: CompositionGate = domGate,
  doc: any = (globalThis as any).document,
  options: { onSample?: (sample: CompositionSample) => void } = {},
): () => void {
  if (gate === null || gate === undefined) return () => {}
  if (doc === null || doc === undefined || typeof doc.addEventListener !== 'function') return () => {}
  const probe = createVoiceProbe({ doc, onSample: options.onSample })
  const start = (): void => {
    gate.beginComposition()
    probe.onStart()
  }
  const end = (): void => {
    gate.endComposition()
    probe.onEnd()
  }
  try {
    doc.addEventListener('compositionstart', start, true)
    doc.addEventListener('compositionend', end, true)
  } catch {
    return () => {}
  }
  return () => {
    try {
      doc.removeEventListener('compositionstart', start, true)
      doc.removeEventListener('compositionend', end, true)
    } catch {
      /* 卸不掉也不影响后续 */
    }
    probe.dispose()
    gate.reset()
  }
}

/**
 * 闸门化的节流跑法：到点了但正在让路 → 不跑也不丢，过 skipMs 再来一次。
 *
 * @param options.run - 真正要跑的扫描。
 * @param options.gate - 闸门（可空：空=不暂停，纯节流）。
 * @param options.waitMs - 正常节流间隔。
 * @param options.skipMs - 让路时的重试间隔。
 * @param options.maxSkips - 连续让路次数上限（上限后强跑一次，别把状态憋死）。
 */
export function createGatedThrottle(options: {
  run: () => void
  gate?: CompositionGate | null
  waitMs?: number
  skipMs?: number
  maxSkips?: number
  schedule?: (fn: () => void, ms: number) => any
  cancel?: (handle: any) => void
}): () => void {
  const waitMs = options.waitMs ?? 300
  const skipMs = options.skipMs ?? 400
  const maxSkips = options.maxSkips ?? 12
  const gate = options.gate ?? null
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle: any) => clearTimeout(handle))
  let handle: any = null
  let last = 0
  let skips = 0
  const tick = (): void => {
    handle = null
    const gate_ = gate
    if (gate_ !== null && gate_.isPaused() && skips < maxSkips) {
      skips += 1
      handle = schedule(tick, skipMs)
      return
    }
    skips = 0
    last = Date.now()
    try {
      options.run()
    } catch {
      /* 补丁器抛错不能让闸门反过来打断页面 */
    }
  }
  return () => {
    if (handle !== null) return
    const now = Date.now()
    const delay = Math.max(0, Math.min(waitMs, last + waitMs - now))
    handle = schedule(tick, delay)
  }
}

/**
 * 「只在输入框外面动 DOM」判据：补丁器一律不碰 composer subtree。
 * 输入框（宿主 Lexical contenteditable）内的节点被插件改写 = 语音/拼音输入被打断。
 * @param node - 任意节点（Text / Element）。
 * @param selector - 输入框根属性（默认宿主的稳定 hook）。
 */
export function insideComposer(node: any, selector: string = '[data-composer-card]'): boolean {
  if (node === null || node === undefined) return false
  const closest = typeof node.closest === 'function'
    ? node.closest.bind(node)
    : (node.parentElement && typeof node.parentElement.closest === 'function'
      ? (s: string) => node.parentElement.closest(s)
      : null)
  if (closest === null) return false
  try {
    return closest(selector) !== null
  } catch {
    return false
  }
}
