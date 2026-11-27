/**
 * 秘书会话「加载更早消息跳回最新」根因修复的离线单测（假 DOM / 数值模型，不起浏览器）：
 *   node scripts/test-secretary-history-scroll-anchor.mjs
 *
 * 背景（2026-11-27 用户手机实测）：秘书会话页上滚翻历史，先出「正在加载」（宿主历史控件），
 * 更早消息渲染完后视图被拽回最新消息位置。根因：旧的滚动补偿公式
 *   scrollTop = beforeTop + (afterScrollHeight − beforeScrollHeight)   （scrollAnchorTopPatch）
 * 假设加载期间所有高度增长都在阅读位置上方；实际上 expandOlder 把折叠行翻成完整卡的位置
 * （窗口边界）在阅读位置**下方**，整体补偿把视图往下拽几千 px，落点距底 < 25px 时宿主
 * follow 采样还会把 followingTail 重新置真，之后每次增长都钉回底部。
 *
 * 本测试分两段：
 *   段一（旧逻辑 FAIL 证明）：用数值模型复现旧公式把视图拽走的事实（这段断言「旧公式确实会跳」）。
 *   段二（新逻辑验收）：planHistoryScrollRestore / pickHistoryAnchorKey / captureHistoryScrollSnapshot
 *     四种场景——底部附近→跟随最新、中途上滚→位置保持、连续加载→每次补偿正确、加载失败→不跳；
 *     外加「正在加载提示插删不动锚点」「等待期间用户上滚不被拽回」两条。
 */
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = await import('../lib/index.js')
const cards = lib.secretaryCardsTestSurface

const failures = []
function check(name, ok, detail = '') {
  if (ok) { console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); return }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ───────── 数值模型：滚动口 = 头部控件（「正在加载」）+ 卡行序列 ─────────
 * 卡行两种高度：折叠行 40px、完整卡 600px；headHeight 是卡行区上方的一切
 * （宿主历史控件 / 上限提示行），它的插删与变高也必须保持锚点不动。
 */
const COLLAPSED = 40
const FULL = 600

function makeModel({ collapsed = 0, full = 0, headHeight = 40, scrollTop = 0, clientHeight = 700 } = {}) {
  const rows = []
  for (let i = 0; i < collapsed; i += 1) rows.push({ key: `collapsed-${i}`, height: COLLAPSED })
  for (let i = 0; i < full; i += 1) rows.push({ key: `full-${i}`, height: FULL })
  return { rows, headHeight, scrollTop, clientHeight }
}

function modelScrollHeight(model) {
  return model.headHeight + model.rows.reduce((sum, row) => sum + row.height, 0)
}

/** 卡行矩形（滚动口坐标系，scrollerTop = 0）：与 captureHistoryScrollSnapshot 同一套算法。 */
function modelRects(model) {
  let cursor = model.headHeight - model.scrollTop
  return model.rows.map((row) => {
    const top = cursor
    cursor += row.height
    return { key: row.key, top, bottom: top + row.height, height: row.height }
  })
}

/** 段一（旧逻辑证明）跑在修复前的 lib 上，新函数可能还不存在：本地兜底一份同口径 pick。 */
function pickAnchorKeyLocal(rects, scrollerTop) {
  for (const row of rects) {
    if (row.height > 0 && row.bottom > scrollerTop + 1) return row.key
  }
  return null
}

function snapshotOf(model, anchorKey = null) {
  const rects = modelRects(model)
  const pick = typeof cards.pickHistoryAnchorKey === 'function' ? cards.pickHistoryAnchorKey : pickAnchorKeyLocal
  const key = anchorKey ?? pick(rects, 0)
  const anchor = key === null ? null : rects.find((row) => row.key === key) ?? null
  return {
    scrollTop: model.scrollTop,
    scrollHeight: modelScrollHeight(model),
    clientHeight: model.clientHeight,
    anchorKey: key,
    anchorOffset: anchor === null ? null : anchor.top,
  }
}

/** 窗口边界处把 count 张最「新」的折叠行翻成完整卡（expandOlder 的真实几何：增长在边界处）。 */
function flipNewestCollapsed(model, count) {
  const collapsedRows = model.rows.filter((row) => row.key.startsWith('collapsed-'))
  const targets = collapsedRows.slice(collapsedRows.length - count)
  for (const row of targets) row.height = FULL
  return targets.length
}

/** 应用一份滚动计划（模拟 el.scrollTop = plan.scrollTop，带浏览器 clamp）。 */
function applyPlan(model, plan) {
  if (plan.scrollTop === null) return
  const floor = Math.max(0, modelScrollHeight(model) - model.clientHeight)
  model.scrollTop = Math.max(0, Math.min(floor, plan.scrollTop))
}

/** 旧生产公式（2026-11-27 前的 SecretaryUserCard.tsx:494-499）：beforeTop + scrollAnchorTopPatch(差值)。 */
function oldPlan(before, after) {
  const delta = cards.scrollAnchorTopPatch(before.scrollHeight, after.scrollHeight)
  return { scrollTop: delta > 0 ? before.scrollTop + delta : null, reason: 'old-delta', delta }
}

/* ───────── 段一：旧逻辑 FAIL 证明（数值复现「跳回最新」） ───────── */
{
  // 90 张折叠行（旧的）+ 30 张完整卡（窗口），用户上滚到 scrollTop=200 翻历史
  const model = makeModel({ collapsed: 90, full: 30, scrollTop: 200 })
  const before = snapshotOf(model)
  flipNewestCollapsed(model, 30) // expandOlder：窗口 30→60，边界处 30 张折叠行翻成完整卡
  const after = snapshotOf(model, before.anchorKey)
  const plan = oldPlan(before, after)
  applyPlan(model, plan)
  const anchored = snapshotOf(model, before.anchorKey)
  const drift = anchored.anchorOffset - before.anchorOffset
  check('段一·旧公式确实把视图拽走（根因复现）',
    plan.scrollTop !== null && plan.scrollTop - before.scrollTop > 10000 && drift < -10000,
    `旧公式 scrollTop ${before.scrollTop}→${plan.scrollTop}（+${plan.scrollTop - before.scrollTop}px），` +
    `锚点行屏幕偏移 ${Math.round(before.anchorOffset)}→${Math.round(anchored.anchorOffset)}（漂移 ${Math.round(drift)}px）`)
  check('段一·短列表（整页 ≈ 一屏）旧公式落点距底 < 25px → 宿主 follow 采样钉回最新（机理成立）',
    (() => {
      // 3 折叠 + 1 完整 + 头 40：scrollHeight=760、floor=60；用户 scrollTop=50（触发线内、距底 10px）
      const short = makeModel({ collapsed: 3, full: 1, headHeight: 40, scrollTop: 50 })
      const b = snapshotOf(short)
      flipNewestCollapsed(short, 3) // +1680px
      const a = snapshotOf(short, b.anchorKey)
      applyPlan(short, oldPlan(b, a))
      const floor = modelScrollHeight(short) - short.clientHeight
      return floor - short.scrollTop < 25
    })(),
    '短列表旧公式落点距底 < 25px → 宿主 nearBottom 采样通过 → followingTail 复真 → 之后钉在最新')
}

/* ───────── 段二：新逻辑验收（lib 里必须有这三个新函数） ───────── */
const planHistoryScrollRestore = cards.planHistoryScrollRestore
const pickHistoryAnchorKey = cards.pickHistoryAnchorKey
const captureHistoryScrollSnapshot = cards.captureHistoryScrollSnapshot
if (typeof planHistoryScrollRestore !== 'function' || typeof pickHistoryAnchorKey !== 'function' || typeof captureHistoryScrollSnapshot !== 'function') {
  check('新锚点逻辑已构建进 lib（planHistoryScrollRestore / pickHistoryAnchorKey / captureHistoryScrollSnapshot）', false,
    'lib/index.js 里找不到新函数——先改源码再跑 node build.mjs')
  console.error(`\nFAIL ${failures.length} 项 secretary-history-scroll-anchor`)
  process.exit(1)
}

check('阈值口径：距底 < 80px 才算「本来就在底部附近」', cards.HISTORY_FOLLOW_BOTTOM_PX === 80, `HISTORY_FOLLOW_BOTTOM_PX=${cards.HISTORY_FOLLOW_BOTTOM_PX}`)

/* 场景 ①：底部附近 → 跟随最新 */
{
  const model = makeModel({ collapsed: 5, full: 30, scrollTop: 0 })
  model.scrollTop = modelScrollHeight(model) - model.clientHeight - 30 // 距底 30px < 80
  const before = snapshotOf(model)
  flipNewestCollapsed(model, 5)
  const after = snapshotOf(model, before.anchorKey)
  const plan = planHistoryScrollRestore(before, after)
  const afterFloor = modelScrollHeight(model) - model.clientHeight
  check('场景① 底部附近（距底 30px）→ 跟随最新钉到底', plan.reason === 'follow-tail' && plan.scrollTop === afterFloor,
    JSON.stringify({ reason: plan.reason, scrollTop: plan.scrollTop, afterFloor }))
}

/* 场景 ②：中途上滚 → 位置保持（增长在锚点下方，一像素都不写） */
{
  const model = makeModel({ collapsed: 90, full: 30, scrollTop: 200 })
  const before = snapshotOf(model)
  flipNewestCollapsed(model, 30)
  const after = snapshotOf(model, before.anchorKey)
  const plan = planHistoryScrollRestore(before, after)
  applyPlan(model, plan)
  const anchored = snapshotOf(model, before.anchorKey)
  check('场景② 中途上滚、增长在锚点下方 → 不写滚动（keep）', plan.reason === 'keep' && plan.scrollTop === null,
    JSON.stringify({ reason: plan.reason, scrollTop: plan.scrollTop, delta: plan.delta }))
  check('场景② 锚点行屏幕偏移一动不动（±1px）', Math.abs(anchored.anchorOffset - before.anchorOffset) <= 1,
    `偏移 ${Math.round(before.anchorOffset)}→${Math.round(anchored.anchorOffset)}`)
}

/* 场景 ②b：「正在加载」提示变高 + 宿主 prepend（增长在锚点上方）→ 精确补偿，锚点不动 */
{
  const model = makeModel({ collapsed: 90, full: 30, scrollTop: 200 })
  const before = snapshotOf(model)
  model.headHeight += 40 // 宿主历史控件切到「正在加载」变高 40px
  for (let i = 0; i < 10; i += 1) model.rows.unshift({ key: `prepended-${i}`, height: COLLAPSED }) // 宿主 prepend 10 行
  const after = snapshotOf(model, before.anchorKey)
  const plan = planHistoryScrollRestore(before, after)
  applyPlan(model, plan)
  const anchored = snapshotOf(model, before.anchorKey)
  check('场景②b 提示变高 + prepend 共 440px 在锚点上方 → 补偿 440px', plan.reason === 'anchor' && plan.scrollTop === after.scrollTop + 440,
    JSON.stringify({ reason: plan.reason, scrollTop: plan.scrollTop, expected: after.scrollTop + 440 }))
  check('场景②b 补偿后锚点行屏幕偏移不变（±1px）', Math.abs(anchored.anchorOffset - before.anchorOffset) <= 1,
    `偏移 ${Math.round(before.anchorOffset)}→${Math.round(anchored.anchorOffset)}`)
}

/* 场景 ②c：宿主 prepend 已被宿主自己补偿（屏幕偏移没变）→ 不重复补偿（keep） */
{
  const model = makeModel({ collapsed: 90, full: 30, scrollTop: 200 })
  const before = snapshotOf(model)
  model.headHeight += 40
  for (let i = 0; i < 10; i += 1) model.rows.unshift({ key: `prepended-${i}`, height: COLLAPSED })
  model.scrollTop += 440 // 宿主 finishHistoryPrepend / overflow-anchor 已把锚点屏幕位置保持住
  const after = snapshotOf(model, before.anchorKey)
  const plan = planHistoryScrollRestore(before, after)
  check('场景②c 宿主已补偿的 prepend（无手势）→ keep，一个像素都不再补', plan.reason === 'keep' && plan.scrollTop === null,
    JSON.stringify({ reason: plan.reason, scrollTop: plan.scrollTop, delta: plan.delta }))
}

/* 场景 ③：连续触底加载 3 次 → 每次都补偿正确 */
{
  const model = makeModel({ collapsed: 90, full: 30, scrollTop: 200 })
  let anchorKey = snapshotOf(model).anchorKey
  let allStable = true
  const details = []
  for (let round = 1; round <= 3; round += 1) {
    const before = snapshotOf(model, anchorKey)
    flipNewestCollapsed(model, 30) // 边界逐轮上移：第 3 轮翻到锚点行所在区（增长跨过锚点）
    const after = snapshotOf(model, anchorKey)
    const plan = planHistoryScrollRestore(before, after)
    applyPlan(model, plan)
    const anchored = snapshotOf(model, anchorKey)
    const drift = Math.abs(anchored.anchorOffset - before.anchorOffset)
    details.push(`第${round}轮 reason=${plan.reason} 补偿=${plan.scrollTop === null ? 0 : plan.scrollTop - after.scrollTop}px 漂移=${drift.toFixed(1)}px`)
    if (drift > 1) allStable = false
    if (model.scrollTop < 0 || model.scrollTop > modelScrollHeight(model) - model.clientHeight + 1) allStable = false
  }
  check('场景③ 连续 3 次触底加载，每次锚点偏移都保持（±1px）', allStable, details.join('；'))
}

/* 场景 ④：加载失败 → 不跳（DOM 没变 / 锚点行没了，都一个像素不写） */
{
  const model = makeModel({ collapsed: 90, full: 30, scrollTop: 200 })
  const before = snapshotOf(model)
  const afterSame = snapshotOf(model, before.anchorKey) // 失败：什么变化都没有
  const planSame = planHistoryScrollRestore(before, afterSame)
  check('场景④a 加载失败（DOM 零变化）→ keep 不写滚动', planSame.reason === 'keep' && planSame.scrollTop === null,
    JSON.stringify({ reason: planSame.reason, scrollTop: planSame.scrollTop }))
  const afterLost = { ...afterSame, anchorKey: null, anchorOffset: null } // 宿主整棵重画，锚点行没了
  const planLost = planHistoryScrollRestore(before, afterLost)
  check('场景④b 锚点行丢失 → keep 不写滚动（瞎补比不补更糟）', planLost.reason === 'keep' && planLost.scrollTop === null,
    JSON.stringify({ reason: planLost.reason, scrollTop: planLost.scrollTop }))
  const short = makeModel({ collapsed: 3, full: 1, scrollTop: 0 })
  short.scrollTop = modelScrollHeight(short) - short.clientHeight - 30 // 距底 30px
  const b3 = snapshotOf(short)
  const plan3 = planHistoryScrollRestore(b3, snapshotOf(short, b3.anchorKey)) // 失败：零增长
  check('场景④c 贴底但零增长（失败/空页）→ keep，不把用户再往地板上拽', plan3.reason === 'keep' && plan3.scrollTop === null,
    JSON.stringify({ reason: plan3.reason, scrollTop: plan3.scrollTop }))
}

/* 场景 ⑤：等待期间用户自己滚动（有手势）→ 不被拽回（用户滚动分量天然抵消） */
{
  const model = makeModel({ collapsed: 90, full: 30, scrollTop: 700 })
  const before = snapshotOf(model)
  model.scrollTop = 200 // 等待期间用户向上滚了 500px（无增长）
  const after = snapshotOf(model, before.anchorKey)
  const plan = planHistoryScrollRestore(before, after, { userGestured: true })
  check('场景⑤a 等待期间用户上滚 500px、无增长 → 不拽回（keep）', plan.scrollTop === null,
    JSON.stringify({ reason: plan.reason, scrollTop: plan.scrollTop, delta: plan.delta }))
  const model2 = makeModel({ collapsed: 90, full: 30, scrollTop: 700 })
  const before2 = snapshotOf(model2)
  model2.headHeight += 3000 // 锚点上方长了 3000px
  model2.scrollTop = 200    // 同时用户向上滚 500px
  const after2 = snapshotOf(model2, before2.anchorKey)
  const plan2 = planHistoryScrollRestore(before2, after2, { userGestured: true })
  check('场景⑤b 用户上滚 500px + 上方增长 3000px → 只补偿增长（200+3000）', plan2.scrollTop === 3200,
    JSON.stringify({ scrollTop: plan2.scrollTop, expected: 3200, delta: plan2.delta }))
}

/* 场景 ⑥：锚点行挑选（pickHistoryAnchorKey）与 DOM 快照（captureHistoryScrollSnapshot，假 DOM） */
{
  const rows = [
    { key: 'a', top: -300, bottom: -260, height: 40 },  // 已滚过
    { key: 'b', top: -40, bottom: 0, height: 40 },      // 底部贴着滚动口顶（不越线）
    { key: 'c', top: 0, bottom: 0, height: 0 },         // 零高度（还没长出来）
    { key: 'd', top: 10, bottom: 50, height: 40 },      // ← 第一个可见
    { key: 'e', top: 50, bottom: 90, height: 40 },
  ]
  check('场景⑥a 锚点 = 第一个底部越过滚动口顶部的非零卡行', pickHistoryAnchorKey(rows, 0) === 'd',
    `picked=${pickHistoryAnchorKey(rows, 0)}`)
  check('场景⑥b 一行都不剩 → null', pickHistoryAnchorKey(rows.slice(0, 3), 0) === null, '')

  // 假 DOM：滚动口视口顶部在 100，卡行矩形用同一视口坐标系（与生产 getBoundingClientRect 一致）
  const fakeRowRects = [
    { key: 'a', top: -200, bottom: -160, height: 40 },
    { key: 'b', top: 60, bottom: 100, height: 40 },   // 底部贴着滚动口顶（不越线）
    { key: 'c', top: 110, bottom: 110, height: 0 },   // 零高度
    { key: 'd', top: 110, bottom: 150, height: 40 },  // ← 第一个可见
    { key: 'e', top: 150, bottom: 190, height: 40 },
  ]
  const fakeRows = fakeRowRects.map((row) => ({
    getAttribute: (name) => (name === 'data-dsh-scard-key' ? row.key : null),
    getBoundingClientRect: () => ({ top: row.top, bottom: row.bottom, height: row.height }),
  }))
  const fakeScroller = {
    scrollTop: 200, scrollHeight: 5000, clientHeight: 700,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => fakeRows,
  }
  const snap = captureHistoryScrollSnapshot(fakeScroller)
  check('场景⑥c 假 DOM 快照：字段齐、锚点按矩形挑出', snap.scrollTop === 200 && snap.scrollHeight === 5000
    && snap.clientHeight === 700 && snap.anchorKey === 'd' && snap.anchorOffset === 10,
    JSON.stringify(snap))
  const snapByKey = captureHistoryScrollSnapshot(fakeScroller, 'e')
  check('场景⑥d 按 key 找回同一行（翻卡后锚点不丢）', snapByKey.anchorKey === 'e' && snapByKey.anchorOffset === 50,
    JSON.stringify(snapByKey))
  const snapGone = captureHistoryScrollSnapshot(fakeScroller, 'ghost')
  check('场景⑥e 按 key 找不到 → anchorOffset=null（计划层 keep）', snapGone.anchorKey === 'ghost' && snapGone.anchorOffset === null,
    JSON.stringify(snapGone))
}

if (failures.length > 0) {
  console.error(`\nFAIL ${failures.length} 项 secretary-history-scroll-anchor`)
  process.exit(1)
}
console.log('\nPASS 秘书历史滚动锚点离线单测全部通过')
