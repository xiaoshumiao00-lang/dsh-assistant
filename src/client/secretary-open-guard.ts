/**
 * 个人秘书「打开动作」的稳定态守卫（纯函数，无 DOM / 无网络 / 无 react，node 可单测）。
 *
 * 亲历的两次问题都出在这里：
 *   1. 2026-11-20 第一版秘书页把「缓存态 / 骨架屏 / 已就位」做成三态互斥渲染，后台维护
 *      每跑一轮就把 `loading` 置回 true，于是中间显示区在「个人秘书已就位」和三条灰骨架条
 *      之间反复闪。根因不是慢，是**同一块区域被两种状态轮流覆盖**。
 *   2. 重复长按会重复 openSession：宿主会把会话面重新装载一次（等于整页重刷一下），
 *      看起来就是「点两下闪两下」。
 *
 * 这一版把这两件事都收敛成可断言的纯函数：
 *   - `createPanelOpenGuard()`：同一条会话只允许真正 open 一次，之后只做幂等 focus；
 *   - `skeletonAllowed()`：骨架屏在整条流程里最多允许出现一次，且只在「本地没有任何
 *     可渲染内容、又还没尝试过」时；标准会话页流程里根本没有骨架屏，这个守卫保证
 *     就算以后有人再加一条自绘分支，也不会退化成轮流覆盖；
 *   - `stableChange()`：只有内容真的变了才认为「需要落一次状态」（幂等），
 *     把「远端刷新 → setState → 重渲染」的震荡挡在源头。
 */

/** 一次打开请求该做什么：真正切过去，还是只做幂等聚焦。 */
export type OpenAction = 'open' | 'focus'

export interface PanelOpenGuard {
  /**
   * 决定这次该 open 还是只 focus。
   * @param sessionId - 目标固定会话 id。
   * @returns 第一次（或换了会话）返回 'open'，重复打开同一条返回 'focus'。
   */
  decide(sessionId: string): OpenAction
  /** 当前守卫记住的会话 id（诊断/测试用）。 */
  shown(): string
  /** 清空记忆（测试/换账号）。 */
  reset(): void
}

/** 创建打开守卫：同一条会话只 open 一次。 */
export function createPanelOpenGuard(): PanelOpenGuard {
  let shown = ''
  return {
    decide(sessionId: string): OpenAction {
      const id = String(sessionId ?? '').trim()
      if (id === '') return 'focus'
      if (shown === id) return 'focus'
      shown = id
      return 'open'
    },
    shown(): string {
      return shown
    },
    reset(): void {
      shown = ''
    },
  }
}

/**
 * 骨架屏是否允许出现。
 * 规则：整条打开流程里最多一次，且必须同时满足「本地没有可渲染内容」+「还没渲染过」
 * +「还没尝试过」。任何一次失败/重试都不会让它重新出现（避免「内容 ⇄ 骨架」来回切）。
 */
export function skeletonAllowed(state: {
  /** 本地是否有缓存内容可以直接渲染（会话 id / 上次统计）。 */
  hadCache: boolean
  /** 已经尝试过打开几次。 */
  attempts: number
  /** 是否已经渲染过至少一次真实内容。 */
  renderedOnce: boolean
}): boolean {
  if (state.renderedOnce) return false
  if (state.hadCache) return false
  return state.attempts <= 0
}

/**
 * 幂等状态落盘：内容没变就返回 null（调用方据此跳过 setState，避免无意义重渲染）。
 * @param previous - 当前状态。
 * @param next - 新状态。
 * @param equal - 内容相等判断。
 * @returns 需要落的新状态，或 null（= 不用动）。
 */
export function stableChange<T>(previous: T, next: T, equal: (a: T, b: T) => boolean): T | null {
  if (equal(previous, next)) return null
  return next
}
