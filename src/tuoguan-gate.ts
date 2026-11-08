/**
 * 托管门控（跨 bundle 的注入点）。
 *
 * 为什么要它：后台 Code 会话的「无人值守自动应答」长在
 * `vendor/computer-use/code-agent.js`，与宿主主插件（`src/tuoguan-host.ts`）是两个
 * 独立的 esbuild 产物，模块级变量不共享；而托管状态的真值只有宿主的 TuoguanStore
 * （`dsh-tuoguan-state.json`）一份，vendor 侧绝不能自己再读一遍文件——那就是第二个
 * 真值源，早晚两边对不上。
 *
 * 做法：宿主在 apply 时把「这个会话此刻是否托管」注册到 globalThis
 * （`Symbol.for` 保证同一进程内两个 bundle 拿到同一个键），vendor 只来问一句。
 * 没人注册 / 注册方抛错 / 会话 id 不合法 → 一律 false，也就是按「不托管」处理：
 * 放行给宿主与用户的正常流程，绝不猜着放行。
 */

/** globalThis 上的门控键（Symbol.for 保证两个 bundle 拿到同一个 symbol）。 */
export const TUOGUAN_GATE_KEY: symbol = Symbol.for('dsh-assistant.tuoguan-gate')

/** 门控签名：会话 id，外加可选的「派出它的会话」（后台 Code 会话靠它继承开关）。 */
export type TuoguanGate = (sessionId: string, parentSessionId?: string) => Promise<boolean>

/**
 * 安装门控，返回卸载函数（还原上一份门控，热重载时不会留下孤儿）。
 * @param isOnFor - 门控函数；不是函数就当没装（返回空卸载器）。
 * @returns 卸载函数。
 */
export function installTuoguanGate(isOnFor: TuoguanGate): () => void {
  if (typeof isOnFor !== 'function') return () => {}
  const holder = globalThis as unknown as Record<symbol, unknown>
  const previous = holder[TUOGUAN_GATE_KEY]
  holder[TUOGUAN_GATE_KEY] = isOnFor
  return () => {
    if (holder[TUOGUAN_GATE_KEY] !== isOnFor) return
    if (previous === undefined) delete holder[TUOGUAN_GATE_KEY]
    else holder[TUOGUAN_GATE_KEY] = previous
  }
}

/**
 * 问一句「这个会话此刻托管吗」。没装门控、门控抛错、id 不合法都当不托管。
 * @param sessionId - 发起审批 / 提问的会话。
 * @param parentSessionId - 派出它的会话（后台 Code 会话传 CU 会话 id）。
 * @returns 是否托管。
 */
export async function tuoguanGateOn(sessionId: string, parentSessionId?: string): Promise<boolean> {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const gate = (globalThis as unknown as Record<symbol, unknown>)[TUOGUAN_GATE_KEY]
  if (typeof gate !== 'function') return false
  try {
    const on = await (gate as TuoguanGate)(sessionId, parentSessionId)
    return on === true
  } catch {
    return false
  }
}
