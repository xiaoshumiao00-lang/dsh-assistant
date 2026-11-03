/**
 * 手机端汉堡钮命中区（2026-11-03 "三条横线点几次都进不去"）：
 * 纯判定函数必须满足三件事 ——
 *   1) 按钮 28px 时代的外沿（图标四周那圈"看得见但点不到"的地方）现在算命中；
 *   2) 不能抢下面「对话 / 轨迹」标签条的点击（下沿只外扩 2px）；
 *   3) 滑动 / 长按 / 落点在区外一律不算"点了一下"。
 */
import assert from 'node:assert/strict'
import {
  classifyToggleTap,
  isInToggleZone,
  toggleHitZone,
} from '../src/client/pocket/mobile/swipe.mjs'

// 手机上真实的按钮矩形：40×44 的布局里落在 left 4 / top 4，44×44。
const TOGGLE_RECT = { left: 4, top: 4, width: 44, height: 44 }

// --- 命中区形状 ---------------------------------------------------------------
const zone = toggleHitZone(TOGGLE_RECT)
assert.deepEqual(zone, { x0: 0, x1: 54, y0: 0, y1: 50 }, '命中区 = 按钮外扩，且裁掉屏幕外')

assert.equal(toggleHitZone(null), null, '拿不到矩形就没有命中区')
assert.equal(toggleHitZone({ left: 0, top: 0, width: 0, height: 0 }), null, '按钮 display:none（0 宽）时不生效')
assert.equal(toggleHitZone({}), null, '缺字段的矩形按无效处理')

const atOrigin = toggleHitZone({ left: 0, top: 0, width: 44, height: 44 })
assert.deepEqual(atOrigin, { x0: 0, x1: 50, y0: 0, y1: 46 }, '贴边时不能出现负坐标')

// --- 点在区内 -----------------------------------------------------------------
const ICON_CENTER = { x: 26, y: 26 }
assert.equal(isInToggleZone(ICON_CENTER, zone), true, '图标中心当然算')

// 旧版本按钮只有 8..36 × 12..40：这几个落点以前是"看得见、点不到"的死角。
const FORMER_DEAD_SPOTS = [
  { x: 42, y: 24, note: '图标右侧 6px（旧按钮盒外）' },
  { x: 20, y: 44, note: '图标正下方 8px（旧按钮盒外）' },
  { x: 2, y: 10, note: '贴着屏幕左上角' },
  { x: 48, y: 46, note: '右下角外沿' },
]
for (const spot of FORMER_DEAD_SPOTS) {
  assert.equal(isInToggleZone(spot, zone), true, `应当算命中：${spot.note}`)
}

// --- 不抢下面的标签条 / 右侧标题 ------------------------------------------------
assert.equal(isInToggleZone({ x: 26, y: 58 }, zone), false, '「对话 / 轨迹」标签条（y≈58）不能被汉堡钮抢走')
assert.equal(isInToggleZone({ x: 70, y: 26 }, zone), false, '标题区不参与命中')
assert.equal(isInToggleZone({ x: -3, y: 26 }, zone), false, '屏幕外左侧不算')
assert.equal(isInToggleZone({ x: 26, y: -2 }, zone), false, '屏幕外上方不算')
assert.equal(isInToggleZone({ x: Number.NaN, y: 26 }, zone), false, '坐标无效不算')
assert.equal(isInToggleZone({ x: 26, y: 26 }, null), false, '没有命中区不算')

// --- 一次"点一下"的判定 --------------------------------------------------------
const tap = (startX, startY, endX = startX, endY = startY, extra = {}) => classifyToggleTap({
  startX,
  startY,
  endX,
  endY,
  zone,
  ...extra,
})

assert.equal(tap(26, 26), true, '正对图标点一下')
assert.equal(tap(26, 26, 28, 30), true, '手指抖 3px 仍算点击')
assert.equal(tap(40, 30), true, '落在旧按钮外的死角也算（这正是这次要修的）')
assert.equal(tap(26, 26, 27, 60), false, '往下滑 34px 是滚动，不是点击')
assert.equal(tap(26, 26, 120, 27), false, '右滑 94px 是边缘手势，不是点击')
assert.equal(tap(26, 26, 26, 26, { elapsedMs: 1500 }), false, '长按 1.5s 不算点击')
assert.equal(tap(26, 26, 26, 26, { elapsedMs: 120 }), true, '正常按下 120ms 抬起')
assert.equal(tap(80, 26), false, '起手点在标题区就不该被汉堡钮接管')
assert.equal(tap(26, 60), false, '起手点在标签条就不该被接管')
assert.equal(tap(26, 26, 60, 26), false, '抬起时已经出了命中区也不算')
assert.equal(tap(26, 26, 26, 26, { maxMs: 100 }), true, 'maxMs 可注入（测试/调参用）')

// 命中区内起手、抬起时大幅位移：不抢滚动（上滑看历史消息）。
assert.equal(tap(26, 40, 26, 10), false, '纵向位移 30px 是滚动，不是点击')

console.log('ok test-mobile-toggle-zone')
