/**
 * 秘书朗读「播放侧 flight 令牌」——把「同一时刻最多只有一条在出声」变成**全局硬约束**。
 *
 * 为什么需要它：
 *   朗读的唯一性原来只由模块内的三样东西保证——`secretarySpeech` 单例、控制器的私有
 *   `player`、每条流水线自己的 `generation`。它们都活在**一个模块实例里**，管不到
 *   「不是我创建的、但已经 start(when) 排在共享 AudioContext 时间轴上的
 *   AudioBufferSourceNode」。只要播放侧出现第二份（模块被再次求值 / 第二套控制器），
 *   两套 generation 各管一半、彼此零可见，旧的已排播块就没人停 → 两条同时出声。
 *   Chromium 侧 stop() 对「已排播还没响」的源是有效的（离线渲染实测：不 stop 峰值 0.5000，
 *   stop 后 0.0000），所以漏声不是 stop 不灵，而是**没有人去 stop**。
 *
 * 语义（本文件是唯一权威）：
 *   - 一次朗读起播 = `begin()`：同步执行上一代登记的全部取消器（含已排播未响的块），
 *     然后返回新的令牌；旧令牌立刻失效。
 *   - 排播任何一块之前先 `isCurrent(token)`：过期即丢，调度器不许把它排上时间轴。
 *   - 每块排播后 `register(stopFn, token)`：把「怎么掐掉这一块」登记进令牌表，
 *     于是**任何**新一代 begin() 都能掐掉它，哪怕它属于另一条流水线 / 另一份模块实例。
 *   - 令牌表挂在 `globalThis` 上（浏览器里就是 window），同一 realm 内所有模块求值
 *     共享同一份 —— 这正是「第二份播放侧也能被掐掉」的关键。
 *
 * 纯逻辑、无 DOM / 无 Audio 依赖，node 可直接单测。
 */

/** 全局令牌表在 globalThis 上的键名（跨模块实例共享的唯一入口）。 */
export const SPEECH_FLIGHT_KEY = '__dshSecretarySpeechFlight'
/** 令牌表结构版本：版本不匹配时先吊销旧的、再装新的（不许两个不兼容的表并存）。 */
export const SPEECH_FLIGHT_VERSION = 2

export interface SpeechFlightBus {
  readonly version: number
  /**
   * 起一代新 flight：**同步**执行所有旧代登记的取消器（已排播未响的块在这一瞬间被掐掉），
   * 返回新令牌。
   */
  begin(): number
  /** 当下令牌。 */
  current(): number
  /** 令牌是否仍是当下最新（排播前的准入判据）。 */
  isCurrent(token: number): boolean
  /** 吊销某一代（不是当下代也无害；重复吊销无害）。 */
  cancel(token: number): void
  /** 吊销所有代（页面级停止 / 版本切换用）。 */
  cancelAll(): void
  /**
   * 把一个取消器登记到 `token` 那一代；返回注销函数。
   * 令牌已过期（或已被吊销）时不登记，**立刻同步执行一次取消器**并返回空注销函数，
   * 保证「过期即丢」不会留下一条漏网的声音。
   */
  register(cancel: () => void, token: number): () => void
}

/** 造一份新的令牌表（单测直接用它，不碰 globalThis）。 */
export function createSpeechFlightBus(): SpeechFlightBus {
  let current = 0
  const flights = new Map<number, Set<() => void>>()

  const runAll = (set: Set<() => void>): void => {
    // 取消器可能反过来注销自己/登记新的：先取快照，逐个吞异常（一个失败不许影响其它源停机）
    for (const cancel of [...set]) { try { cancel() } catch { /* 停机失败不阻断后续停机 */ } }
  }

  const bus: SpeechFlightBus = {
    version: SPEECH_FLIGHT_VERSION,
    begin(): number {
      for (const [token, set] of [...flights]) {
        if (token <= current) runAll(set)
      }
      flights.clear()
      current += 1
      flights.set(current, new Set())
      return current
    },
    current(): number { return current },
    isCurrent(token: number): boolean { return token === current },
    cancel(token: number): void {
      const set = flights.get(token)
      if (set === undefined) return
      flights.delete(token)
      runAll(set)
    },
    cancelAll(): void {
      for (const set of [...flights.values()]) runAll(set)
      flights.clear()
    },
    register(cancel: () => void, token: number): () => void {
      const set = flights.get(token)
      if (set === undefined || token !== current) {
        try { cancel() } catch { /* 过期即丢：丢的时候的异常同样吞掉 */ }
        return () => { /* 已丢，无需注销 */ }
      }
      // 包一层：同一个取消器重复登记/注销都只生效一次，且不许把其它取消器带下水
      let live = true
      const wrapped = (): void => {
        if (!live) return
        live = false
        try { cancel() } catch { /* 见上 */ }
      }
      set.add(wrapped)
      return () => { live = false; set.delete(wrapped) }
    },
  }
  return bus
}

/**
 * 取当前 realm 的令牌表：`globalThis`（浏览器 = window）上**只存一份**，
 * 所以同一个页面里模块被再次求值时，第二份代码拿到的仍是第一份的令牌表 ——
 * 新一代 begin() 照样能掐掉第一份排上去的块。
 */
export function speechFlightBus(root: unknown = globalThis): SpeechFlightBus {
  const host = root as Record<string | symbol, unknown> | null | undefined
  const existing = host?.[SPEECH_FLIGHT_KEY] as SpeechFlightBus | undefined
  if (existing !== undefined && existing !== null && existing.version === SPEECH_FLIGHT_VERSION
    && typeof existing.begin === 'function' && typeof existing.register === 'function') {
    return existing
  }
  // 旧版本（结构不兼容）：能吊销就先把它的声音吊销，再装新表，绝不让两套表并存
  try { existing?.cancelAll?.() } catch { /* 旧表坏了也不能阻断装新表 */ }
  const bus = createSpeechFlightBus()
  try { (host as Record<string, unknown>)[SPEECH_FLIGHT_KEY] = bus } catch { /* 只读 root（极端环境）就退回本实例表 */ }
  return bus
}

/** 单测入口。 */
export const secretarySpeechFlightTestSurface = {
  SPEECH_FLIGHT_KEY,
  SPEECH_FLIGHT_VERSION,
  createSpeechFlightBus,
  speechFlightBus,
}
