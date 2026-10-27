/**
 * 控制室「只看进行中」筛选（纯函数，便于单测）。
 *
 * 口径：正在工作的项目卡片 = 绿（进行中）/ 黄（等待决策）/ 红（异常终止）。
 * 空闲与已完成（包括刚完成、还没点开确认的那张）都不算在工作者——它们正是要一键藏起来的噪声。
 * 内置「控制室」卡片、临时「正在运行」卡片与普通项目卡片一视同仁：状态不满足就一起藏。
 */

export type ConsoleCardWorkStatus = 'idle' | 'busy' | 'need' | 'done' | 'error'

/** 算「在工作」的状态集合：绿 / 黄 / 红。 */
const WORKING_STATUSES: ReadonlySet<ConsoleCardWorkStatus> = new Set(['busy', 'need', 'error'])

/** 这张卡片是否算「正在工作」。 */
export function isWorkingCard(card: { status: ConsoleCardWorkStatus }): boolean {
  return WORKING_STATUSES.has(card.status)
}

/** 筛选卡片：onlyWorking = false 时原样返回同一引用（避免无谓重渲染）。 */
export function filterWorkingCards<T extends { status: ConsoleCardWorkStatus }>(
  cards: readonly T[],
  onlyWorking: boolean,
): readonly T[] {
  return onlyWorking ? cards.filter(isWorkingCard) : cards
}
