/**
 * 秘书会话「加载更早后跳到新批次顶部」的真实 DOM 复现 + 连续性验收（2026-11-27 第二轮）：
 *   node scripts/test-secretary-history-scroll-continuity-dom.mjs
 *
 * 与离线数值模型（test-secretary-history-scroll-anchor.mjs）不同，本测试在**真 Chromium**里跑：
 * 原生 scroll anchoring（overflow-anchor 默认 auto）生效、卡片翻页是**真元素替换**（模拟 React
 * unmount+remount）、异步高度变化（图片/折叠展开）跨帧到达——这些是数值模型没有、而手机实测
 * 会跳的三类机理。滚动补偿用的就是 src 里的真函数（captureHistoryScrollSnapshot /
 * planHistoryScrollRestore / pickHistoryAnchorKey），经 esbuild 打包注入页面，口径不复制第二遍。
 *
 * 每个场景断言：加载前后「锚点行视口偏移」逐像素不变（±1px），且加载后 600ms 内任何时刻
 * 锚点偏移都不漂移（连续性，不许先跳后回）。
 */
import { build } from 'esbuild'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ── 真函数打包（src → IIFE → 注入页面）── */
const entry = `
import {
  captureHistoryScrollSnapshot,
  planHistoryScrollRestore,
  pickHistoryAnchorKey,
  startHistoryScrollGuard,
  HISTORY_CARD_ROW_SELECTOR,
  HISTORY_FOLLOW_BOTTOM_PX,
  SCROLL_TOP_THRESHOLD_PX,
} from '../src/client/pocket/orb/secretary-cards.ts'
window.__st = {
  captureHistoryScrollSnapshot,
  planHistoryScrollRestore,
  pickHistoryAnchorKey,
  startHistoryScrollGuard,
  HISTORY_CARD_ROW_SELECTOR,
  HISTORY_FOLLOW_BOTTOM_PX,
  SCROLL_TOP_THRESHOLD_PX,
}
`
writeFileSync(join(ROOT, '.tmp', 'scroll-continuity-entry.ts'), entry)
await build({
  entryPoints: [join(ROOT, '.tmp', 'scroll-continuity-entry.ts')],
  outfile: join(ROOT, '.tmp', 'scroll-continuity-bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  logLevel: 'silent',
})
const bundle = readFileSync(join(ROOT, '.tmp', 'scroll-continuity-bundle.js'), 'utf8')

/* ── 真 CSS（与 pagination-dom 同一来源：本次构建的 lib/client.js）── */
const bundleSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const marker = 'body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"]'
const at = bundleSource.indexOf(marker)
if (at < 0) throw new Error('lib/client.js 里找不到卡片 CSS 标记，先跑 node build.mjs')
const cssStart = bundleSource.lastIndexOf('`', at)
const cssEnd = bundleSource.indexOf('`', at)
const cardCss = bundleSource.slice(cssStart + 1, cssEnd)

const failures = []
function check(name, ok, detail = '') {
  if (ok) { console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); return }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
const context = await browser.newContext({ viewport: { width: 420, height: 700 } })
const page = await context.newPage()
page.on('pageerror', (error) => console.error('PAGE ERROR:', error.message))

/**
 * 页面骨架（忠实宿主结构）：
 *   [data-conversation-scroll]（滚动口，overflow-anchor 默认 auto）
 *     > .column[data-chat-flow]
 *       > .older[data-chat-history]（宿主历史控件）
 *       > .flowItem[data-chat-paging-anchor] × N（每个里面 portal 一张卡：折叠行或完整卡）
 * 卡片用真 CSS；完整卡 600px 量级、折叠行一行。window.__mk 提供翻卡/ prepend / 图片生长等原语。
 */
function pageHtml(collapsedCount, fullCount) {
  // 注意：不能挂 data-chat-flow-kind="assistant-step"——真 CSS 把那一类整行 display:none（秘书回复卡
  // 住在 turnTail 槽，不是 assistant-step 行）。这里只保留宿主分页锚点属性，卡片自身提供高度。
  const rows = []
  for (let i = 0; i < collapsedCount; i += 1) {
    rows.push(`<div class="flowItem" data-chat-paging-anchor data-chat-turn="${i}">${collapsedCard(`k${i}`, i)}</div>`)
  }
  for (let i = collapsedCount; i < collapsedCount + fullCount; i += 1) {
    rows.push(`<div class="flowItem" data-chat-paging-anchor data-chat-turn="${i}">${fullCard(`k${i}`, i)}</div>`)
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${cardCss}</style><style>
    html, body { margin: 0; padding: 0; }
    [data-conversation-scroll] { height: 700px; overflow-y: auto; }
    .column { display: flex; flex-direction: column; max-width: 420px; margin: 0 auto; }
    .older { display: flex; justify-content: center; align-items: center; min-height: 40px; }
    .flowItem { min-width: 0; }
  </style></head><body data-dsh-secretary="1">
  <div data-conversation-scroll><div class="column" data-chat-flow>
    <div class="older" data-chat-history><button type="button">加载更早</button></div>
    ${rows.join('\n')}
  </div></div>
  </body></html>`
}

function collapsedCard(key, i) {
  return `<div data-dsh-scard="collapsed-row" data-dsh-scard-kind="assistant" data-dsh-scard-turn="${i}" data-dsh-scard-key="${key}" data-dsh-scard-open="false">
  <button type="button" data-dsh-scard="collapse-row" aria-expanded="false">
    <span data-dsh-scard="collapse-time">22:51</span>
    <span data-dsh-scard="collapse-title">更早的回复 ${i}</span>
    <span data-dsh-scard="collapse-caret">▾</span>
  </button>
</div>`
}

function fullCard(key, i) {
  return `<article data-dsh-scard="card" data-dsh-scard-kind="assistant" data-dsh-scard-turn="${i}" data-dsh-scard-key="${key}" data-empty="0" data-open="0" data-unread="0">
  <div data-dsh-scard="body"><div data-dsh-scard="content"><p data-dsh-scard="para">回复 ${i} 的正文第一段。</p><p data-dsh-scard="para">第二段。</p><p data-dsh-scard="para">第三段。</p></div></div>
  <div data-dsh-scard="foot"><span data-dsh-scard="time">22:51</span></div>
</article>`
}

/** 注入页面原语：settleScrollHeight（照抄组件）、expandOlderWithAnchor（照抄组件滚动处理）、翻卡/prepend/图片生长。 */
async function installHelpers() {
  await page.addScriptTag({ content: bundle })
  await page.evaluate(() => {
    const st = window.__st
    const scroller = () => document.querySelector('[data-conversation-scroll]')
    const flow = () => document.querySelector('[data-chat-flow]')

    // 照抄 SecretaryUserCard.tsx:335-350 settleScrollHeight
    function settleScrollHeight(el) {
      return new Promise((resolve) => {
        let attempts = 0
        let previous = -1
        let stable = 0
        const step = () => {
          const current = el.scrollHeight
          stable = current === previous ? stable + 1 : 0
          previous = current
          attempts += 1
          if ((stable >= 2 && attempts >= 3) || attempts >= 16) { resolve(); return }
          window.requestAnimationFrame(step)
        }
        window.requestAnimationFrame(step)
      })
    }

    // 照抄 SecretaryUserCard.tsx expandOlder 的滚动处理（doExpand = pager.expandOlder 的 DOM 效果）
    let activeGuardStop = null
    async function expandOlderWithAnchor(doExpand) {
      const el = scroller()
      const before = st.captureHistoryScrollSnapshot(el)
      // 与组件同一判据：加载前贴底 → 一次性 plan 钉地板；在读历史 → 守护循环连续守，plan 不写
      const wasAtBottom = Math.max(0, before.scrollHeight - before.clientHeight) - before.scrollTop < st.HISTORY_FOLLOW_BOTTOM_PX
      const guardActive = !wasAtBottom && before.anchorKey !== null && before.anchorOffset !== null
      let userGestured = false
      const noteGesture = () => { userGestured = true }
      const gestureEvents = ['touchstart', 'touchmove', 'wheel', 'pointerdown', 'keydown']
      const gestureOptions = { passive: true, capture: true }
      for (const type of gestureEvents) el.addEventListener(type, noteGesture, gestureOptions)
      const clearGestureWatch = () => { for (const type of gestureEvents) el.removeEventListener(type, noteGesture, gestureOptions) }
      // 守护循环（照抄组件实现）：从加载前就起，容忍锚点行短暂消失，守锚点行的内容坐标（只补增长）
      if (activeGuardStop !== null) { activeGuardStop(); activeGuardStop = null }
      if (guardActive) {
        const stopGuard = st.startHistoryScrollGuard({
          scroller: el,
          anchorKey: before.anchorKey,
          expectOffset: before.anchorOffset,
          startScrollTop: before.scrollTop,
          maxMs: 1200,
        })
        activeGuardStop = () => { stopGuard() }
      }
      await Promise.resolve(doExpand())
      await settleScrollHeight(el)
      const after = st.captureHistoryScrollSnapshot(el, before.anchorKey)
      const plan = st.planHistoryScrollRestore(before, after, { userGestured })
      let applied = null
      if (!guardActive && plan.scrollTop !== null && Math.abs(plan.scrollTop - el.scrollTop) > 0.5) {
        el.scrollTop = plan.scrollTop
        applied = plan.scrollTop
      }
      clearGestureWatch()
      return { before, after, plan, applied, guardActive }
    }

    // 翻卡：把 rank 最高的 count 张折叠行**替换成**完整卡（模拟 React unmount 折叠行 + mount 完整卡）
    function flipNewestCollapsed(count) {
      const collapsed = [...document.querySelectorAll('[data-dsh-scard="collapsed-row"]')]
      const targets = collapsed.slice(Math.max(0, collapsed.length - count))
      for (const row of targets) {
        const key = row.getAttribute('data-dsh-scard-key')
        const turn = row.getAttribute('data-dsh-scard-turn')
        const article = document.createElement('article')
        article.setAttribute('data-dsh-scard', 'card')
        article.setAttribute('data-dsh-scard-kind', 'assistant')
        article.setAttribute('data-dsh-scard-turn', turn)
        article.setAttribute('data-dsh-scard-key', key)
        article.setAttribute('data-empty', '0')
        article.innerHTML = '<div data-dsh-scard="body"><div data-dsh-scard="content"><p data-dsh-scard="para">翻上来的完整卡。</p><p data-dsh-scard="para">第二段。</p><p data-dsh-scard="para">第三段。</p></div></div><div data-dsh-scard="foot"><span data-dsh-scard="time">22:51</span></div>'
        row.replaceWith(article)
      }
      return targets.length
    }

    // 宿主 prepend：在 .older 之后插入 count 个 flowItem（先 0 高度壳，再由 renderCollapsedInto 补卡）
    function hostPrepend(count, withCards) {
      const flowEl = flow()
      const older = flowEl.querySelector('.older')
      const anchorRow = flowEl.querySelector('[data-chat-paging-anchor]:not(:empty)')
      const anchorTopBefore = anchorRow ? anchorRow.getBoundingClientRect().top - scroller().getBoundingClientRect().top : null
      const anchorKeyBefore = anchorRow ? anchorRow.querySelector('[data-dsh-scard-key]')?.getAttribute('data-dsh-scard-key') : null
      const items = []
      for (let i = 0; i < count; i += 1) {
        const item = document.createElement('div')
        item.className = 'flowItem'
        item.setAttribute('data-chat-paging-anchor', '')
        item.setAttribute('data-host-prepended', '1')
        item.style.height = withCards ? '' : '0px'
        items.push(item)
      }
      for (const item of items.reverse()) flowEl.insertBefore(item, older.nextSibling)
      // 宿主 finishHistoryPrepend：把旧首行钉回原来的屏幕偏移
      if (anchorRow && anchorTopBefore !== null) {
        const nowTop = anchorRow.getBoundingClientRect().top - scroller().getBoundingClientRect().top
        scroller().scrollTop += nowTop - anchorTopBefore
      }
      return { count, anchorKeyBefore }
    }

    // 插件扫描后给宿主 prepend 的 0 高度壳渲染折叠行（0→40px 生长）
    function renderCollapsedIntoPrepended() {
      const shells = [...document.querySelectorAll('.flowItem[data-host-prepended="1"]')]
      let n = 0
      for (const shell of shells) {
        if (shell.querySelector('[data-dsh-scard]') !== null) continue
        shell.style.height = ''
        const idx = 1000 + n
        shell.innerHTML = `<div data-dsh-scard="collapsed-row" data-dsh-scard-kind="assistant" data-dsh-scard-turn="${idx}" data-dsh-scard-key="p${idx}" data-dsh-scard-open="false"><button type="button" data-dsh-scard="collapse-row" aria-expanded="false"><span data-dsh-scard="collapse-time">22:51</span><span data-dsh-scard="collapse-title">宿主 prepend 的卡 ${n}</span><span data-dsh-scard="collapse-caret">▾</span></button></div>`
        n += 1
      }
      return n
    }

    // 异步图片生长：给 key 对应的完整卡插入一张 heightPx 的图（模拟图片加载撑高）
    function growCardByKey(key, heightPx) {
      const card = document.querySelector(`[data-dsh-scard-key="${key}"]`)
      if (card === null) return false
      const img = document.createElement('div')
      img.setAttribute('data-test-image', '1')
      img.style.height = `${heightPx}px`
      img.style.background = '#cde'
      const content = card.querySelector('[data-dsh-scard="content"]') ?? card
      content.appendChild(img)
      return true
    }

    // 轨迹记录：每帧记 scrollTop / scrollHeight / 锚点偏移（存 window.__tracks，跨 evaluate 按 id 取）
    window.__tracks = {}
    function startTrajectory(anchorKey, id) {
      const el = scroller()
      const track = { frames: [], stop: false, anchorKey }
      window.__tracks[id] = track
      const record = () => {
        if (track.stop) return
        const snap = st.captureHistoryScrollSnapshot(el, anchorKey)
        track.frames.push({ t: Math.round(performance.now()), scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, anchorOffset: snap.anchorOffset === null ? null : Math.round(snap.anchorOffset * 10) / 10 })
        requestAnimationFrame(record)
      }
      requestAnimationFrame(record)
      return id
    }
    function stopTrajectory(id) {
      const track = window.__tracks[id]
      if (track) track.stop = true
      return track ? track.frames : []
    }

    window.__mk = { settleScrollHeight, expandOlderWithAnchor, flipNewestCollapsed, hostPrepend, renderCollapsedIntoPrepended, growCardByKey, startTrajectory, stopTrajectory, scroller }
  })
}

/** 量「锚点行当前视口偏移」。 */
async function anchorOffset(anchorKey) {
  return page.evaluate((key) => {
    const st = window.__st
    const el = document.querySelector('[data-conversation-scroll]')
    const snap = st.captureHistoryScrollSnapshot(el, key)
    return { anchorKey: snap.anchorKey, anchorOffset: snap.anchorOffset, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
  }, anchorKey)
}

async function pickAnchor() {
  return page.evaluate(() => {
    const st = window.__st
    const el = document.querySelector('[data-conversation-scroll]')
    return st.captureHistoryScrollSnapshot(el).anchorKey
  })
}

/** 轨迹里锚点偏移的最大漂移（相对第一帧）。 */
function maxDrift(frames) {
  const valid = frames.filter((f) => f.anchorOffset !== null)
  if (valid.length === 0) return { drift: null, min: null, max: null }
  const base = valid[0].anchorOffset
  let min = base
  let max = base
  for (const f of valid) { min = Math.min(min, f.anchorOffset); max = Math.max(max, f.anchorOffset) }
  return { drift: Math.max(Math.abs(max - base), Math.abs(min - base)), min, max, base }
}

/* ════════ 场景 ════════ */
let trackSeq = 0
async function scenario(name, collapsed, full, scrollTop, run, options = {}) {
  const nativeAnchor = options.nativeAnchor !== false
  await page.setContent(pageHtml(collapsed, full))
  await installHelpers()
  if (!nativeAnchor) {
    // 手机触摸/惯性滑动期间原生 scroll anchoring 被抑制：用 overflow-anchor:none 模拟，
    // 此时插件补偿是唯一防线（手机实测跳的正是这条路）。
    await page.addStyleTag({ content: '[data-conversation-scroll] { overflow-anchor: none !important; }' })
  }
  await page.evaluate((top) => { document.querySelector('[data-conversation-scroll]').scrollTop = top }, scrollTop)
  await page.waitForTimeout(50)
  const anchor = await pickAnchor()
  const before = await anchorOffset(anchor)
  const trackId = `t${(trackSeq += 1)}`
  await page.evaluate(({ key, id }) => window.__mk.startTrajectory(key, id), { key: anchor, id: trackId })
  const result = await run(anchor)
  // 加载后再观察 600ms（异步高度变化窗口）
  await page.waitForTimeout(600)
  const frames = await page.evaluate((id) => window.__mk.stopTrajectory(id), trackId)
  const after = await anchorOffset(anchor)
  const offsetDrift = before.anchorOffset !== null && after.anchorOffset !== null ? Math.abs(after.anchorOffset - before.anchorOffset) : null
  return { anchor, before, after, offsetDrift, result, drift: maxDrift(frames), frames }
}

/** 轨迹摘要：最大漂移 + 起止帧，便于贴原始输出。 */
function driftDetail(drift, before, after) {
  return `轨迹漂移=${drift.drift === null ? 'null' : `${drift.drift}px（min ${drift.min} / max ${drift.max} / base ${drift.base}）`} 端点偏移 ${before.anchorOffset}→${after.anchorOffset}`
}

/* 场景①：多屏历史、用户停在折叠区中部、翻卡增长在锚点下方 → 必须一动不动 */
for (const nativeAnchor of [true, false]) {
  const { anchor, before, after, offsetDrift, result, drift } = await scenario('flip-below', 90, 30, 200, async () => {
    return page.evaluate(async () => {
      const out = await window.__mk.expandOlderWithAnchor(async () => { window.__mk.flipNewestCollapsed(30) })
      return { reason: out.plan.reason, delta: out.plan.delta, wrote: out.applied, guard: out.guardActive }
    })
  }, { nativeAnchor })
  check(`场景①${nativeAnchor ? '（原生锚定开）' : '（原生锚定关=手机滑动态）'} 翻卡在锚点下方：锚点偏移逐像素不变`, offsetDrift !== null && offsetDrift <= 1 && (drift.drift === null || drift.drift <= 1),
    `锚点 ${anchor} ${driftDetail(drift, before, after)} plan=${JSON.stringify(result)}`)
}

/* 场景②：翻卡跨过锚点（锚点行自己被翻成完整卡，增长在上方）→ 必须保持 */
for (const nativeAnchor of [true, false]) {
  const { anchor, before, after, offsetDrift, result, drift } = await scenario('flip-crossing', 40, 30, 200, async () => {
    return page.evaluate(async () => {
      const out = await window.__mk.expandOlderWithAnchor(async () => { window.__mk.flipNewestCollapsed(40) })
      return { reason: out.plan.reason, delta: out.plan.delta, wrote: out.applied, guard: out.guardActive }
    })
  }, { nativeAnchor })
  check(`场景②${nativeAnchor ? '（原生锚定开）' : '（原生锚定关）'} 翻卡跨过锚点（锚点行被翻、上方增长）：锚点偏移逐像素不变`, offsetDrift !== null && offsetDrift <= 1 && (drift.drift === null || drift.drift <= 1),
    `锚点 ${anchor} ${driftDetail(drift, before, after)} plan=${JSON.stringify(result)}`)
}

/* 场景③：宿主 prepend（原子补偿）后插件异步给新行渲染折叠卡（0→35 生长在锚点上方）→ 必须保持 */
for (const nativeAnchor of [true, false]) {
  const { anchor, before, after, offsetDrift, result, drift } = await scenario('host-prepend-async-cards', 90, 30, 200, async () => {
    return page.evaluate(async () => {
      window.__mk.hostPrepend(30, false) // 宿主 prepend 30 行（0 高度壳）+ 原子补偿
      const out = await window.__mk.expandOlderWithAnchor(async () => { window.__mk.flipNewestCollapsed(30) })
      await new Promise((r) => setTimeout(r, 130)) // 插件扫描去抖后给 prepend 壳渲染折叠卡 → 锚点上方生长
      window.__mk.renderCollapsedIntoPrepended()
      return { reason: out.plan.reason, delta: out.plan.delta, wrote: out.applied, guard: out.guardActive }
    })
  }, { nativeAnchor })
  check(`场景③${nativeAnchor ? '（原生锚定开）' : '（原生锚定关）'} 宿主 prepend + 插件异步渲染新卡（锚点上方生长）：锚点偏移逐像素不变`, offsetDrift !== null && offsetDrift <= 1 && (drift.drift === null || drift.drift <= 1),
    `锚点 ${anchor} ${driftDetail(drift, before, after)} plan=${JSON.stringify(result)}`)
}

/* 场景④：加载完成后异步图片在锚点上方撑高（图片/折叠展开晚到）→ 必须守住到高度稳定 */
for (const nativeAnchor of [true, false]) {
  const { anchor, before, after, offsetDrift, result, drift } = await scenario('async-image-above', 40, 30, 200, async (anchorKey) => {
    return page.evaluate(async (key) => {
      const out = await window.__mk.expandOlderWithAnchor(async () => { window.__mk.flipNewestCollapsed(40) })
      await new Promise((r) => setTimeout(r, 120)) // plan 已应用后，锚点上方一张刚翻上来的卡图片晚到撑高 300px
      const cards = [...document.querySelectorAll('[data-dsh-scard="card"]')]
      const anchorEl = document.querySelector(`[data-dsh-scard-key="${key}"]`)
      const above = anchorEl === null ? [] : cards.filter((c) => c.compareDocumentPosition(anchorEl) & Node.DOCUMENT_POSITION_PRECEDING)
      const target = above[above.length - 1]
      if (target) window.__mk.growCardByKey(target.getAttribute('data-dsh-scard-key'), 300)
      return { reason: out.plan.reason, delta: out.plan.delta, wrote: out.applied, guard: out.guardActive, grewAbove: target?.getAttribute('data-dsh-scard-key') ?? null }
    }, anchorKey)
  }, { nativeAnchor })
  check(`场景④${nativeAnchor ? '（原生锚定开）' : '（原生锚定关）'} 加载后锚点上方图片晚到撑高 300px：锚点偏移逐像素不变（守住）`, offsetDrift !== null && offsetDrift <= 1 && (drift.drift === null || drift.drift <= 1),
    `锚点 ${anchor} ${driftDetail(drift, before, after)} plan=${JSON.stringify(result)}`)
}

/* 场景⑤：连续加载两次 → 每次都保持（原生锚定关） */
{
  await page.setContent(pageHtml(90, 30))
  await installHelpers()
  await page.addStyleTag({ content: '[data-conversation-scroll] { overflow-anchor: none !important; }' })
  await page.evaluate(() => { document.querySelector('[data-conversation-scroll]').scrollTop = 200 })
  await page.waitForTimeout(50)
  const anchor = await pickAnchor()
  const before = await anchorOffset(anchor)
  const r1 = await page.evaluate(async () => {
    const out = await window.__mk.expandOlderWithAnchor(async () => { window.__mk.flipNewestCollapsed(30) })
    return { reason: out.plan.reason, wrote: out.applied, guard: out.guardActive }
  })
  await page.waitForTimeout(200)
  const mid = await anchorOffset(anchor)
  const r2 = await page.evaluate(async () => {
    const out = await window.__mk.expandOlderWithAnchor(async () => { window.__mk.flipNewestCollapsed(30) })
    return { reason: out.plan.reason, wrote: out.applied, guard: out.guardActive }
  })
  await page.waitForTimeout(600)
  const after = await anchorOffset(anchor)
  const drift1 = before.anchorOffset !== null && mid.anchorOffset !== null ? Math.abs(mid.anchorOffset - before.anchorOffset) : null
  const drift2 = before.anchorOffset !== null && after.anchorOffset !== null ? Math.abs(after.anchorOffset - before.anchorOffset) : null
  check('场景⑤（原生锚定关）连续加载两次：每次锚点偏移都逐像素不变', drift1 !== null && drift1 <= 1 && drift2 !== null && drift2 <= 1,
    `锚点 ${anchor} 偏移 ${before.anchorOffset}→${mid.anchorOffset}→${after.anchorOffset}（漂移 ${drift1}/${drift2}px）r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`)
}

/* 场景⑥：锚点行加载后不可见（被宿主重画抹掉）→ keep 不写滚动、绝不跳到某一行（原生锚定关） */
{
  await page.setContent(pageHtml(90, 30))
  await installHelpers()
  await page.addStyleTag({ content: '[data-conversation-scroll] { overflow-anchor: none !important; }' })
  await page.evaluate(() => { document.querySelector('[data-conversation-scroll]').scrollTop = 200 })
  await page.waitForTimeout(50)
  const before = await page.evaluate(() => {
    const el = document.querySelector('[data-conversation-scroll]')
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
  })
  const res = await page.evaluate(async () => {
    const el = document.querySelector('[data-conversation-scroll]')
    const st = window.__st
    const beforeSnap = st.captureHistoryScrollSnapshot(el)
    const out = await window.__mk.expandOlderWithAnchor(async () => {
      window.__mk.flipNewestCollapsed(30)
      const anchorEl = document.querySelector(`[data-dsh-scard-key="${beforeSnap.anchorKey}"]`)
      if (anchorEl) anchorEl.closest('.flowItem')?.remove() // 宿主整棵重画：锚点行被抹掉
    })
    return { reason: out.plan.reason, wrote: out.applied, guard: out.guardActive, beforeAnchor: beforeSnap.anchorKey }
  })
  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-conversation-scroll]')
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
  })
  // 锚点丢失 → keep：插件一个像素都不写；scrollTop 留在原地（不跳到批次顶部 ≈0，也不跳到任何一行）
  check('场景⑥（原生锚定关）锚点行被抹掉 → keep 不写滚动（不跳到任何一行）', res.reason === 'keep' && res.wrote === null && Math.abs(after.scrollTop - before.scrollTop) <= 40,
    `scrollTop ${before.scrollTop}→${after.scrollTop} reason=${res.reason} wrote=${res.wrote}`)
}

/* 场景⑦：加载在飞期间用户自己的惯性滑动（touchend 后没有手势事件）→ 守护循环绝不能把用户
 * 自己的滑动也钉死（那会变成「加载时滑动卡住」）。用户滑动分量必须原样保留，只补内容增长。*/
{
  await page.setContent(pageHtml(90, 30))
  await installHelpers()
  await page.addStyleTag({ content: '[data-conversation-scroll] { overflow-anchor: none !important; }' })
  await page.evaluate(() => { document.querySelector('[data-conversation-scroll]').scrollTop = 400 })
  await page.waitForTimeout(50)
  const anchor = await pickAnchor()
  const before = await anchorOffset(anchor)
  const res = await page.evaluate(async () => {
    const el = document.querySelector('[data-conversation-scroll]')
    const startTop = el.scrollTop
    const out = await window.__mk.expandOlderWithAnchor(async () => {
      // 惯性滑动：8 帧、每帧上滚 20px（160px），不派发任何手势事件
      for (let i = 0; i < 8; i += 1) {
        el.scrollTop -= 20
        await new Promise((r) => requestAnimationFrame(r))
      }
      window.__mk.flipNewestCollapsed(30) // 翻卡增长在锚点下方（与用户滑动叠加）
      // 用户滑完之后又来一批锚点上方的异步增长（宿主 prepend 壳 + 插件补卡）
      window.__mk.hostPrepend(20, false)
      await new Promise((r) => setTimeout(r, 130))
      window.__mk.renderCollapsedIntoPrepended()
    })
    const grown = el.scrollHeight
    return { startTop, endTop: el.scrollTop, grown, reason: out.plan.reason, applied: out.applied, guardActive: out.guardActive }
  })
  await page.waitForTimeout(600)
  const after = await anchorOffset(anchor)
  // 唯一判据 = 锚点行的屏幕位置。用户自己上滚 160px 必须保留（锚点随之下移 160px），
  // 锚点上方的异步增长必须被补掉（不额外下移）→ 最终偏移应恰为 before+160。
  // 若守护钉死用户：偏移停在 −10；若增长没补：偏移约 850。两者都会让这条失败。
  const expected = before.anchorOffset === null ? null : before.anchorOffset + 160
  const anchorOk = after.anchorOffset !== null && expected !== null && Math.abs(after.anchorOffset - expected) <= 8
  check('场景⑦ 加载期间惯性滑动 + 锚点上方异步增长：用户滑动原样保留、增长被补（不钉死也不跳）', anchorOk,
    `锚点偏移 ${before.anchorOffset}→${after.anchorOffset}（期望 ${expected}）scrollTop ${res.startTop}→${res.endTop}（scrollHeight ${res.grown}）plan=${JSON.stringify(res)}`)
}

await browser.close()

if (failures.length > 0) {
  console.error(`\nFAIL ${failures.length} 项 secretary-history-scroll-continuity-dom`)
  process.exit(1)
}
console.log('\nPASS 秘书历史滚动连续性 DOM 验收全部通过')
