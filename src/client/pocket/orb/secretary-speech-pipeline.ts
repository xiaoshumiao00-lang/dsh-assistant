/**
 * 秘书朗读分块流水线（纯逻辑，无 DOM / fetch / Audio 依赖，node 可直接单测）。
 *
 * 分工：
 *   - secretary-cards.ts 的 splitSpeechChunks 负责把文本切成块（拼接逐字符一致）；
 *   - 这里负责「边合成边播」的调度：第 1 块一合成就排播，第 N 块播放的同时
 *     第 N+1…N+prefetch 块已在合成（预取窗口），按块顺序在同一音频时间轴上
 *     首尾相接排播（Web Audio 侧是样本级连续，块间无间隙、不重不漏）；
 *   - 合成失败重试一次，再失败就停在该块并回调 onError（控制器转 error 态，
 *     按钮显示「朗读失败（原因）」，不换引擎、不整段重来）；
 *   - 换文本 / 停止 / 重读 = 代数 +1：in-flight 合成请求全部 abort（AbortController），
 *     已排播的音频全部 stop，旧代回调一律作废（不会和新文本叠声）；
 *   - **跨实例硬约束（secretary-speech-flight.ts）**：真正决定「有没有声音」的是共享
 *     AudioContext 时间轴上已经 start(when) 的源，而代数只在**本条流水线**内有效。
 *     所以起播时还要在全局 flight 令牌表上 `begin()`（同步掐掉所有旧代登记的源，含已排播
 *     未响的块），排播每一块之前再校验令牌是否仍是当下最新 —— 过期即丢。于是哪怕页面上
 *     存在第二条流水线 / 第二份模块实例（各持一个 AudioContext），任何时刻最多只有一条在响；
 *   - 块音频按「文本指纹」缓存（speechClipCacheKey），同一句第二次朗读零合成秒播。
 *
 * 浏览器适配（fetch + AudioContext）在 secretary-speech.ts；本文件不 import 它。
 */
import { splitSpeechChunks, type SpeechChunkOptions } from './secretary-cards.ts'
import { speechFlightBus, type SpeechFlightBus } from './secretary-speech-flight.ts'

/** 一块合成好的音频。payload 对引擎不透明（浏览器里是 AudioBuffer，单测里是假对象）。 */
export interface SpeechSynthClip {
  /** 音频时长（秒），排播时间轴靠它首尾相接。 */
  durationSec: number
  payload: unknown
}

/** 一次排播：stop() 取消（不触发 finished），finished 在播完时兑现。 */
export interface SpeechPlayback {
  stop(): void
  finished: Promise<void>
}

/** 运行环境注入：浏览器给 AudioContext 实现，单测给假时钟/假合成/假排播。 */
export interface SpeechPipelineIo {
  /** 音频时间轴当前时刻（秒）。AudioContext.currentTime：suspend 时冻结。 */
  now(): number
  /** 合成一块（带 abort；实现必须把 signal 传给 fetch）。 */
  synthesize(text: string, signal: AbortSignal): Promise<SpeechSynthClip>
  /** 把一块音频排在 whenSec 时刻播（音频时间轴）。 */
  schedule(clip: SpeechSynthClip, whenSec: number): SpeechPlayback
  /** 暂停/继续音频时间轴（AudioContext.suspend/resume）。 */
  suspend?(): void
  resume?(): void
  /** 重试前的等待（毫秒）。缺省 = 立即重试。 */
  wait?(ms: number): Promise<void>
}

/** 块音频缓存（LRU）。跨播放器实例共享才有「第二次秒播」的意义。 */
export interface SpeechClipCache {
  get(key: string): SpeechSynthClip | undefined
  set(key: string, clip: SpeechSynthClip): void
}

/** 文本指纹：FNV-1a 32bit + 长度。不用会撞车的裸 key。 */
export function speechClipCacheKey(text: string): string {
  const s = String(text)
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `sp1:${s.length}:${hash.toString(16).padStart(8, '0')}`
}

/** 进程内块音频缓存（默认 64 块，LRU 逐出）。 */
export function createSpeechClipCache(limit = 64): SpeechClipCache {
  const map = new Map<string, SpeechSynthClip>()
  const capped = Math.max(1, limit)
  return {
    get(key) {
      const clip = map.get(key)
      if (clip !== undefined) { map.delete(key); map.set(key, clip) } // LRU touch
      return clip
    },
    set(key, clip) {
      if (map.has(key)) map.delete(key)
      map.set(key, clip)
      while (map.size > capped) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
  }
}

export interface ChunkPipelineStats {
  /** 已排播的块数。 */
  scheduled: number
  /** 合成追不上播放、被迫推迟排播的次数（理想恒为 0；>0 说明网络/合成超预算）。 */
  underruns: number
}

export interface ChunkPipelineOptions extends SpeechChunkOptions {
  /** 预取窗口（块数）：第 N 块播放时，N+1…N+prefetch 已在合成。默认 2。 */
  prefetch?: number
  /** 排播提前量（秒）：首块排在 now+leadIn，给音频线程留调度余量。默认 0.03。 */
  leadInSec?: number
  /** 每块失败后的重试间隔（毫秒）；0 = 立即重试。默认 250。 */
  retryDelayMs?: number
  /** 块音频缓存（跨实例共享）。 */
  cache?: SpeechClipCache
  /**
   * 全局 flight 令牌表（跨流水线/跨模块实例共享，默认取 globalThis 上那一份）。
   * 单测要隔离世界时注入自己的。
   */
  flight?: SpeechFlightBus
  /** 合成追不上播放时回调（index=受影响块；lateSec=比理想时间轴晚多少秒）。 */
  onUnderrun?: (info: { index: number; lateSec: number }) => void
}

export interface ChunkPipeline {
  /** 起播：promise 在「第一块已排播」时兑现；第一块重试后仍失败则拒绝。 */
  play(): Promise<void>
  pause(): void
  resume(): void
  /** 从头重读（清掉当前队列与排播，缓存命中则零合成）。 */
  restart(): void
  /** 停：abort 全部 in-flight 合成、清队列、停掉已排播音频。 */
  stop(): void
  onEnded(cb: () => void): void
  onPlaying(cb: () => void): void
  onError(cb: (message: string) => void): void
  stats(): ChunkPipelineStats
}

const abortError = (): Error => {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/**
 * 分块流水线。一条流水线绑定一段文本（= 播放器工厂每个 (key, text) 建一条）。
 * 代数（generation）保证任何旧代的合成回调/排播回调都不会泄漏到新一次朗读。
 */
export function createChunkPipeline(io: SpeechPipelineIo, options: ChunkPipelineOptions & { text: string }): ChunkPipeline {
  const text = String(options.text ?? '')
  const prefetch = Math.max(1, options.prefetch ?? 2)
  const leadInSec = options.leadInSec ?? 0.03
  const retryDelayMs = options.retryDelayMs ?? 250
  const cache = options.cache ?? undefined
  /** 全局唯一 flight 令牌表：默认就是 globalThis 上那一份（跨模块实例共享）。 */
  const flight: SpeechFlightBus = options.flight ?? speechFlightBus()

  let generation = 0
  let endedCb: (() => void) | null = null
  let playingCb: (() => void) | null = null
  let errorCb: ((message: string) => void) | null = null
  const stats: ChunkPipelineStats = { scheduled: 0, underruns: 0 }

  interface RunState {
    gen: number
    /** 本次播放的全局 flight 令牌（跨实例）；过期即丢。 */
    token: number
    aborts: AbortController[]
    playbacks: SpeechPlayback[]
    /** 已登记到令牌表的「掐掉这一块」函数；注销用。 */
    unregisters: Array<() => void>
    results: Array<Promise<SpeechSynthClip> | undefined>
    requestIndex: number
  }
  let current: RunState | null = null

  /** 合成一块：缓存命中直接返回；否则合成，失败重试一次（abort/换代立即中止）。 */
  async function synthOne(chunk: string, signal: AbortSignal, gen: number): Promise<SpeechSynthClip> {
    const key = speechClipCacheKey(chunk)
    const hit = cache?.get(key)
    if (hit !== undefined) return hit
    let lastError: unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted || gen !== generation) throw abortError()
      try {
        const clip = await io.synthesize(chunk, signal)
        if (signal.aborted || gen !== generation) throw abortError()
        cache?.set(key, clip)
        return clip
      } catch (error) {
        if (signal.aborted || gen !== generation || (error as Error | undefined)?.name === 'AbortError') throw abortError()
        lastError = error
        if (attempt === 0 && retryDelayMs > 0 && typeof io.wait === 'function') {
          try { await io.wait(retryDelayMs) } catch { /* 等待被打断就继续判代数 */ }
          if (signal.aborted || gen !== generation) throw abortError()
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('TTS 合成失败')
  }

  function swallow(state: RunState): void {
    for (const off of state.unregisters) { try { off() } catch { /* 注销失败不许阻断停机 */ } }
    state.unregisters.length = 0
    for (const ac of state.aborts) { try { ac.abort() } catch { /* 重复 abort 无害 */ } }
    for (const pb of state.playbacks) { try { pb.stop() } catch { /* stop 已播完的源会抛，忽略 */ } }
    for (const p of state.results) { p?.catch(() => { /* in-flight 拒绝全部吞掉 */ }) }
  }

  /**
   * 这一代还能不能往时间轴上排东西：本流水线的代数仍是最新（stop/restart 没发生）
   * **且**全局 flight 令牌仍是最新（没有别处起播）。两条缺一条就可能把旧朗读的块排上去。
   */
  const alive = (state: RunState): boolean => state.gen === generation && flight.isCurrent(state.token)

  async function run(state: RunState, chunks: string[], firstResolve: () => void, firstReject: (error: Error) => void): Promise<void> {
    let scheduleEnd = 0
    let firstScheduled = false
    let lastPlayback: SpeechPlayback | null = null
    const requestOne = (index: number): void => {
      const ac = new AbortController()
      state.aborts.push(ac)
      const p = synthOne(chunks[index], ac.signal, state.gen)
      p.catch(() => { /* 保底：未被 await 的 in-flight 拒绝不炸全局 */ })
      state.results[index] = p
      state.requestIndex = index + 1
    }
    try {
      for (let index = 0; index < chunks.length; index++) {
        // 预取窗口：保持 requestIndex 领先播放位 index 最多 prefetch 块
        while (state.requestIndex < chunks.length && state.requestIndex - index < prefetch) requestOne(state.requestIndex)
        const clip = await state.results[index]!
        if (!alive(state)) return
        const startAt = Math.max(io.now() + leadInSec, scheduleEnd)
        if (firstScheduled && startAt > scheduleEnd + 0.005) {
          stats.underruns += 1
          try { options.onUnderrun?.({ index, lateSec: startAt - scheduleEnd }) } catch { /* 统计回调不许炸 */ }
        }
        // 合成回来再判一次令牌：等合成这段时间里别处可能已经起播（旧代现在排上去就是叠声）
        if (!alive(state)) return
        const playback = io.schedule(clip, startAt)
        // 立刻把「怎么掐掉这一块」登记进全局令牌表：任何新一代 begin() 都能掐掉它；
        // 令牌已过期时 register 会当场把它掐掉并拒绝登记，所以过期即丢、不留漏网的声音
        state.unregisters.push(flight.register(() => { try { playback.stop() } catch { /* 已停过 */ } }, state.token))
        playback.finished.catch(() => { /* stop() 后 finished 不兑现；兜底防未处理拒绝 */ })
        state.playbacks.push(playback)
        scheduleEnd = startAt + Math.max(0, clip.durationSec)
        stats.scheduled += 1
        if (!firstScheduled) {
          firstScheduled = true
          firstResolve()
          try { playingCb?.() } catch { /* 状态回调不许炸 */ }
        }
        lastPlayback = playback
      }
      if (lastPlayback !== null) {
        void lastPlayback.finished.then(() => {
          if (alive(state)) { try { endedCb?.() } catch { /* ignore */ } }
        })
      } else {
        try { endedCb?.() } catch { /* ignore */ }
      }
    } catch (error) {
      if (state.gen !== generation) return // 被 stop/restart 打断：静默退出，不报错
      const message = String((error as Error | undefined)?.message ?? error ?? 'TTS 合成失败')
      swallow(state)
      try { errorCb?.(message) } catch { /* ignore */ }
      if (!firstScheduled) firstReject(error instanceof Error ? error : new Error(message))
    }
  }

  const play = (): Promise<void> => {
    generation += 1
    const gen = generation
    if (current !== null) swallow(current)
    // 起播的同一瞬间吊销上一代全局令牌：旧朗读的源（含已排播未响的块、别的流水线/别的
    // 模块实例排上去的块）在这一行里全部同步 stop —— 先掐后播，任何时刻最多一条在出声
    const token = flight.begin()
    const state: RunState = { gen, token, aborts: [], playbacks: [], unregisters: [], results: [], requestIndex: 0 }
    current = state
    try { io.resume?.() } catch { /* 解锁音频失败不阻断（自动朗读场景无手势） */ }
    const chunks = splitSpeechChunks(text, options)
    return new Promise<void>((resolve, reject) => {
      void run(state, chunks, resolve, reject).catch(() => { /* run 内部已兜底 */ })
    })
  }

  return {
    play,
    pause(): void { try { io.suspend?.() } catch { /* ignore */ } },
    resume(): void { try { io.resume?.() } catch { /* ignore */ } },
    restart(): void { void play() },
    stop(): void {
      generation += 1
      if (current !== null) {
        const state = current
        swallow(state)
        current = null
        // 双重保底：令牌表上这一代还挂着的取消器（含别处替它登记的）也一并吊销
        flight.cancel(state.token)
      }
      // current === null = 这条流水线从没起播（play() 才会 begin）或已经停过：
      // 它名下没有排在时间轴上的源，这里**不做**全局吊销，免得误停别的流水线正在播的朗读。
    },
    onEnded(cb: () => void): void { endedCb = cb },
    onPlaying(cb: () => void): void { playingCb = cb },
    onError(cb: (message: string) => void): void { errorCb = cb },
    stats(): ChunkPipelineStats { return { ...stats } },
  }
}

/** 单测入口。 */
export const secretarySpeechPipelineTestSurface = {
  createChunkPipeline,
  createSpeechClipCache,
  speechClipCacheKey,
}
