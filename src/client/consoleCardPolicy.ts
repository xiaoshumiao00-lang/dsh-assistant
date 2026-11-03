// 控制室卡片的「重渲染判据」与首屏挂载策略（纯函数，便于回归）。
//
// 背景（2026-11-02 第三轮）：控制室的卡片刷新由宿主投影驱动，多任务运行时
// 每 150 ms 就 bump 一次 cardsRevision；原来的实现是 `cards.map(...)` 直接写在
// DshSplitPage 的渲染里 —— 一次 bump 把**每张卡**的整棵子树重建一遍
// （卡里有 3 个 SVG、渐变/阴影、预览行、操作按钮）。卡片数量 = 项目数，
// 手机上这一步就是「自动排版慢半拍」的主因之一。
//
// 这里给两件事：① 比「这张卡有没有变」的纯判据（供 memo 用）；② 首屏先挂多少张。

/** 首屏先挂多少张卡（其余在空闲帧补齐；不改变可见集合，只是错峰）。 */
export const CONSOLE_FIRST_MOUNT = 12

/**
 * 两张卡片的数据是否等价（等价 = 不必重渲染）。
 * 只比渲染真正用到的字段；顺序/引用变化不算变化。
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
export function sameConsoleCard(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.id === b.id
    && a.name === b.name
    && a.icon === b.icon
    && a.status === b.status
    && a.count === b.count
    && a.preview === b.preview
    && a.live === b.live
    && a.glow === b.glow
    && a.bound === b.bound
    && a.temp === b.temp
    && a.self === b.self
    && a.canNewSession === b.canNewSession
    && a.runtimeMs === b.runtimeMs
}

/**
 * 一次 bump 里有多少张卡需要重渲染（等价于「剩下的都被 memo 挡住」）。
 * 仅用于回归/度量，不参与运行时逻辑。
 * @param {Array<Record<string, any>>} prev
 * @param {Array<Record<string, any>>} next
 */
export function countCardsNeedingRender(prev, next) {
  const byId = new Map()
  for (const card of prev || []) byId.set(card?.id, card)
  let changed = 0
  for (const card of next || []) {
    if (!sameConsoleCard(byId.get(card?.id), card)) changed += 1
  }
  return changed
}
