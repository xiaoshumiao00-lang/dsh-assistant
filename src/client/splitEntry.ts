/**
 * 项目卡点击 → 分栏工作区开合意图（纯函数，便于回归测试）。
 *
 * 分栏引擎在同一项目被再次 open 时是「反选关闭」。这在侧栏/栏位卡片上是合理交互
 * （工作区就在眼前，再点一下收起）；但从控制室（全屏覆盖层）点项目卡是「进入项目」：
 * 工作区很可能已经开着、只是被覆盖层挡住，此时反选关闭会让用户以为项目打不开
 * （布局消失、只剩普通会话界面）。
 */
export type SplitOpenIntent = 'open' | 'keep' | 'toggle'

export function splitOpenIntent(
  activeId: string | null | undefined,
  targetId: string,
  enter: boolean,
): SplitOpenIntent {
  if (!activeId || activeId !== targetId) return 'open'
  return enter ? 'keep' : 'toggle'
}
