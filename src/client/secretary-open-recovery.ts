/**
 * 「固定秘书会话打不开」时的判定与恢复决策（纯函数，node 里可直接单测）。
 *
 * 2026-11-21 实测根因：宿主重启后主面板 `openSession(固定会话 id)` 抛
 * `sessions.retain: unknown session <id>`——固定会话已经不在宿主的会话表里
 * （它的日志被插件离线修复过，zstd 帧格式与宿主自己写的不一样，宿主读不出表头），
 * 客户端退避重拉 8 次仍打不开，于是「单击悬浮球没反应」，也没有任何提示。
 *
 * 这里的规则保证两件事：
 *   1. 宿主明确说「这条会话存在」时 **绝不新建**（否则又会长出第二条个人秘书，
 *      这是 2026-11-20 那次的根因，见 assistant-entry.ts 的注释）；
 *   2. 只有「宿主明确说不存在」或「客户端拿到 unknown session 且宿主问不出结果」时才
 *      重建一次；重建也失败就落到控制室，并把原因交给用户——不再静默失败。
 */

/** 第一遍重拉/重开的上限（约 20s：500ms→3s 退避）。 */
export const OPEN_RETRY_LIMIT = 8
/** 宿主说「会话存在」但页面没切过去时，允许再多等一轮的上限（约 60s，列表分页/冷启动）。 */
export const OPEN_RETRY_EXTRA_LIMIT = 20

/** 退避序列：第 0 次等 500ms，之后 1.5 倍递增，上限 3000ms。 */
export function openRetryWaitMs(attempt: number): number {
  const wait = Math.round(500 * Math.pow(1.5, Math.max(0, attempt)))
  return Math.min(wait, 3000)
}

/** 明确「这条会话在宿主里已经不存在」的错误文本特征。 */
const DEAD_SESSION_MARKERS = [
  'unknown session',
  'session not found',
  'no such session',
  'cannot open session',
  'does not open',
]

/** 打开动作抛出来的错误是不是「会话不存在」那一类。 */
export function isDeadSessionError(error: unknown): boolean {
  const text = String(error ?? '').toLowerCase()
  if (text === '') return false
  return DEAD_SESSION_MARKERS.some((marker) => text.includes(marker))
}

export interface RecoveryInput {
  /** 主面板当前是不是已经停在目标会话上。 */
  opened: boolean
  /** 打开动作抛过错，而且报错是 unknown session 那一类。 */
  deadSignal: boolean
  /** 宿主权威回答：固定会话在不在宿主的会话表里（null = 问不出结果：老宿主/查询失败）。 */
  exists: boolean | null
  /** 是否已经用过「多等一轮」（防循环）。 */
  usedExtraRetry: boolean
  /** 是否已经重建过一次（防无限新建会话）。 */
  alreadyRebuilt: boolean
  /** 助手家目录是否可用（重建新会话需要它）。 */
  homeUsable: boolean
}

export type RecoveryPlan =
  /** 已经打开好了，什么都不用做。 */
  | { kind: 'none'; reason: string }
  /** 再多等一轮重拉列表/重开（只用于「会话在、但页面没切过去」）。 */
  | { kind: 'retry-extra'; reason: string }
  /** 丢掉这条固定会话、新建一条并把宿主 state 指过去。 */
  | { kind: 'rebuild'; reason: string }
  /** 兜底：开控制室，并把 reason 交给用户看。 */
  | { kind: 'console'; reason: string }

/**
 * 恢复决策表。每条分支都有确定的输入条件，单测逐条断言。
 */
export function planRecovery(input: RecoveryInput): RecoveryPlan {
  if (input.opened) return { kind: 'none', reason: '' }

  // ① 宿主确认会话在表里：只多等一轮，绝不新建（新建会越用越多出几条个人秘书）
  if (input.exists === true) {
    if (!input.usedExtraRetry) return { kind: 'retry-extra', reason: '宿主确认固定秘书会话存在，主面板还没切过去' }
    return { kind: 'console', reason: '固定秘书会话存在，但主面板一直打不开（已切到控制室）' }
  }

  // ② 宿主确认会话不在表里：这就是「state 指向已不存在会话」的主分支
  if (input.exists === false) {
    if (input.alreadyRebuilt) return { kind: 'console', reason: '重建的新秘书会话仍然打不开（已切到控制室）' }
    if (!input.homeUsable) return { kind: 'console', reason: '固定秘书会话已从宿主消失，助手家目录不可用，无法重建' }
    return { kind: 'rebuild', reason: '固定秘书会话已不在宿主的会话表里' }
  }

  // ③ 问不出结果（老宿主没有 exists 字段 / 宿主清单查询失败）：
  //    只有客户端明确报了 unknown session 才重建，其它情况先多等一轮
  if (input.deadSignal) {
    if (input.alreadyRebuilt) return { kind: 'console', reason: '重建后的秘书会话仍打不开（已切到控制室）' }
    if (!input.homeUsable) return { kind: 'console', reason: '秘书会话报不存在且助手家目录不可用，无法重建' }
    return { kind: 'rebuild', reason: '主面板报会话不存在（unknown session）' }
  }
  if (!input.usedExtraRetry) return { kind: 'retry-extra', reason: '主面板未切过去，宿主未确认会话状态，再等一轮' }
  return { kind: 'console', reason: '秘书会话打不开（已切到控制室）' }
}
