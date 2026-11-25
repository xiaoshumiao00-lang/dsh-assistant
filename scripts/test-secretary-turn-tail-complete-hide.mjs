/**
 * 完成行隐藏回归（2026-11-25 用户原话：「个人秘书页，如果是已经完成了，这行提示就不要留着了，
 * 隐藏掉；如果是正常执行中的要保留执行过程。」）：
 *   node scripts/test-secretary-turn-tail-complete-hide.mjs
 *
 * 取证结论（真页只读探针 + 宿主源码，详见 secretary-completed-line-20261125.md）：
 *   - 红框那行「已完成，用时 N 秒 ⌄」是**宿主** TurnProcessNodeView 渲染的 kind="turn-process" 行
 *     （div[data-chat-flow-kind="turn-process"] > button[data-turn-process]），只在轮次关闭后才存在；
 *   - 进行态的「深度求索中，用时 N 秒 ···」是另一条 [data-chat-running]（RunningStatus），插件从不碰它；
 *   - 这行此前可见，是因为打标器 tagLatestTurnProcessRows 把最新轮的 turn-process 也打了
 *     data-dsh-process-visible="1" 放行。修复 = 移出放行名单 + CSS 兜底规则压回。
 *
 * 本脚本用离线假 DOM（按真页 dump 形状搭）+ 真 bundle 里抽出来的 CSS + 真打标器实现，
 * 在真 Chromium 里断言：
 *   ① 完成卡片：turn-process 行 hidden（不打标、display:none），卡片脚部「展开全文/复制/时间」照旧可见；
 *   ② 执行中：最新轮 process 行（tool-call/context）仍放行可见，[data-chat-running] 进行态提示不被藏；
 *   ③ 作用域：没有 body[data-dsh-secretary="1"] 时同一行照常可见（别会话一个字不动）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BUNDLE = join(ROOT, 'lib', 'client.js')

const lib = await import('../lib/index.js')
const surface = lib.secretaryCardsTestSurface
if (typeof surface.tagLatestTurnProcessRows !== 'function') throw new Error('lib/index.js 里没有 tagLatestTurnProcessRows，先跑 node build.mjs')

// 从本次构建的 lib/client.js 里抽出真实的秘书卡片 CSS（与视觉套件同一套抽法）
const source = readFileSync(BUNDLE, 'utf8')
const marker = 'body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"]'
const at = source.indexOf(marker)
if (at < 0) throw new Error('lib/client.js 里找不到卡片 CSS 标记，先跑 node build.mjs')
const cssStart = source.lastIndexOf('`', at)
const cssEnd = source.indexOf('`', at)
if (cssStart < 0 || cssEnd <= cssStart) throw new Error('提取卡片 CSS 失败')
const cardCss = source.slice(cssStart + 1, cssEnd)
if (!cardCss.includes('[data-dsh-scard="card"]')) throw new Error('提取到的 CSS 不含卡片规则')

const cases = []
const push = (name, fn) => cases.push([name, fn])

/* ── 静态断言：修复本体必须落在 bundle 里 ── */

push('放行名单：PROCESS_VISIBLE_KINDS 不再含 turn-process（完成行不再被打标放行）', () => {
  assert.equal(surface.PROCESS_VISIBLE_KINDS.includes('turn-process'), false,
    `放行名单里还有 turn-process：${JSON.stringify(surface.PROCESS_VISIBLE_KINDS)}`)
  for (const kind of ['tool-call', 'context', 'model-retry', 'turn-error', 'turn-max-tokens']) {
    assert.equal(surface.PROCESS_VISIBLE_KINDS.includes(kind), true, `进行态过程行 ${kind} 必须仍在放行名单里`)
  }
})

push('CSS 兜底：bundle 里有「完成行即使带旧标记也压回」的专门规则，且带秘书页作用域、不用位置选择器', () => {
  const rule = 'body[data-dsh-secretary="1"] [data-chat-flow-kind="turn-process"][data-dsh-process-visible="1"]'
  const at2 = cardCss.indexOf(rule)
  assert.ok(at2 >= 0, 'lib/client.js 的卡片 CSS 里找不到 turn-process 完成行兜底规则')
  const block = cardCss.slice(at2, cardCss.indexOf('}', at2) + 1)
  assert.ok(/display:\s*none\s*!important/.test(block), `兜底规则必须是 display:none !important：${block}`)
  assert.ok(!/:first-child|:nth-child/.test(block), '小屏/卡片选择器纪律：绝不用 :first-child / :nth-child')
})

/* ── 离线假 DOM（按 2026-11-25 真页只读探针 dump 的形状搭） ── */

const pageShell = (secretary, bodyInner) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${cardCss}</style></head>
<body${secretary ? ' data-dsh-secretary="1"' : ''}>
<div class="V4vHZW_column" data-chat-flow>${bodyInner}</div>
</body></html>`

/** 完成态那一轮：用户行 → turn-process 完成行（已完成，用时 40秒 ⌄）→ 回合尾秘书卡（脚部带时间/复制/展开全文）。 */
const COMPLETED_TURN = `
  <div class="V4vHZW_flowItem" data-chat-flow-kind="turn-process" data-chat-turn="19" data-probe="history-turn-process">
    <div data-slot="conversation.chat.node" style="display: contents;">
      <button type="button" class="hE4tRW_root" data-turn-process="19" data-turn-process-messages="0" data-turn-process-tool-calls="1" data-turn-process-subagents="0" aria-expanded="false">
        <span class="hE4tRW_label">已完成，用时 31秒</span>
        <svg class="hE4tRW_chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
  </div>
  <div class="V4vHZW_flowItem" data-chat-flow-kind="user" data-chat-turn="20" data-probe="user-row-20">
    <div data-slot="conversation.chat.node"><div class="host-bubble">帮我把房态页改一下</div></div>
  </div>
  <div class="V4vHZW_flowItem" data-chat-flow-kind="turn-process" data-chat-turn="20" data-probe="completed-turn-process">
    <div data-slot="conversation.chat.node" style="display: contents;">
      <button type="button" class="hE4tRW_root" data-turn-process="20" data-turn-process-messages="0" data-turn-process-tool-calls="2" data-turn-process-subagents="0" aria-expanded="false">
        <span class="hE4tRW_label">已完成，用时 40秒</span>
        <svg class="hE4tRW_chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
  </div>
  <div class="V4vHZW_flowItem" data-chat-flow-kind="turn-tail" data-chat-turn="20" data-probe="tail-row-20">
    <div data-slot="conversation.chat.turnTail" style="display: contents;">
      <article data-dsh-scard="card" data-dsh-scard-kind="assistant" data-dsh-scard-key="assistant:turn:20" data-dsh-scard-turn="20" data-open="0" data-probe="assistant-card-20">
        <div data-dsh-scard="head"><div data-dsh-scard="identity"><span data-dsh-scard="name">个人秘书</span></div></div>
        <div data-dsh-scard="body"><div data-dsh-scard="content"><p data-dsh-scard="title">✅ 房态页改完了</p><p data-dsh-scard="para">改动 +172 −60，渲染测试全过。</p></div></div>
        <div data-dsh-scard="foot">
          <span data-dsh-scard="time" data-probe="card-time">9:28</span>
          <span data-dsh-scard="actions">
            <button type="button" data-dsh-scard="quote" data-quoted="0" title="引用" aria-label="引用">❝</button>
            <button type="button" data-dsh-scard="copy" title="复制" aria-label="复制" data-probe="card-copy">⧉</button>
          </span>
          <span data-dsh-scard="separator"></span>
          <button type="button" data-dsh-scard="expand" aria-expanded="false" title="展开全文" data-probe="card-expand"><span data-dsh-scard="expand-text">展开全文</span></button>
        </div>
      </article>
    </div>
  </div>`

/** 执行中那一轮：用户行 → tool-call/context 过程行 → 空 turn-process 座（宿主进行中渲染 null）→ [data-chat-running] 进行态提示。 */
const RUNNING_TURN = `
  <div class="V4vHZW_flowItem" data-chat-flow-kind="user" data-chat-turn="21" data-probe="user-row-21">
    <div data-slot="conversation.chat.node"><div class="host-bubble">再帮我把测试也跑了</div></div>
  </div>
  <div class="V4vHZW_flowItem" data-chat-flow-kind="tool-call" data-chat-turn="21" data-turn-process-member="true" data-probe="running-tool-1">
    <div data-slot="conversation.chat.node"><div class="host-tool-row"><span>工具调用</span><span>读取 package.json</span></div></div>
  </div>
  <div class="V4vHZW_flowItem" data-chat-flow-kind="context" data-chat-turn="21" data-turn-process-member="true" data-probe="running-context-1">
    <div data-slot="conversation.chat.node"><div class="host-context-row"><span>跨会话召回</span><span>3</span></div></div>
  </div>
  <div class="V4vHZW_flowItem" data-chat-flow-kind="turn-process" data-chat-turn="21" data-probe="running-turn-process-seat"></div>
  <div class="an3WzG_running" data-chat-running data-probe="running-status">
    <span class="an3WzG_runningDivider" aria-hidden="true"></span>
    <span class="an3WzG_runningContent"><span>深度求索中，用时 12秒 ···</span></span>
  </div>`

/** 页面内评估助手：渲染可见性（沿祖先查 display:none + 自身有高度）。 */
const EVAL_HELPERS = `
  const cs = (el) => (el === null ? 'missing' : getComputedStyle(el).display)
  const rendered = (el) => {
    if (el === null) return false
    let node = el
    while (node && node !== document.body) {
      if (getComputedStyle(node).display === 'none') return false
      node = node.parentElement
    }
    return el.getBoundingClientRect().height > 0
  }
  const pick = (probe) => document.querySelector('[data-probe="' + probe + '"]')
  const marked = (el) => el !== null && el.getAttribute('data-dsh-process-visible') === '1'
  const describe = (el) => (el === null ? null : { marked: marked(el), display: cs(el), visible: rendered(el), text: String(el.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40) })
`

const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const runTagger = () => page.evaluate(({ src, attribute, kinds }) => {
    const fn = eval(`(${src})`)
    return fn(document, { attribute, kinds })
  }, { src: String(surface.tagLatestTurnProcessRows), attribute: surface.PROCESS_VISIBLE_ATTRIBUTE, kinds: [...surface.PROCESS_VISIBLE_KINDS] })

  /* ① 完成态：完成行 hidden，卡片脚部一个不少 */
  await page.setContent(pageShell(true, COMPLETED_TURN), { waitUntil: 'load' })
  const tagA = await runTagger()
  const stateA = await page.evaluate(`(() => { ${EVAL_HELPERS}
    return {
      completed: describe(pick('completed-turn-process')),
      completedBtn: describe(pick('completed-turn-process').querySelector('[data-turn-process]')),
      history: describe(pick('history-turn-process')),
      card: describe(pick('assistant-card-20')),
      time: describe(pick('card-time')),
      copy: describe(pick('card-copy')),
      expand: describe(pick('card-expand')),
      expandText: String(pick('card-expand').innerText ?? '').trim(),
      rowInsideCard: pick('completed-turn-process').closest('[data-dsh-scard]') !== null,
      cardInsideRow: pick('completed-turn-process').querySelector('[data-dsh-scard]') !== null,
    } })()`)
  push('完成态①：「已完成，用时 40秒」完成行不渲染（不打标、display:none、整行不可见）', () => {
    assert.equal(stateA.completed.marked, false, `完成行不许打标：${JSON.stringify(stateA.completed)}`)
    assert.equal(stateA.completed.display, 'none', `完成行 display 必须是 none：${JSON.stringify(stateA.completed)}`)
    assert.equal(stateA.completed.visible, false)
    assert.equal(stateA.completedBtn.visible, false, '完成行里那颗「已完成，用时 40秒 ⌄」按钮也不许出图')
    assert.equal(stateA.history.visible === false || stateA.history.display === 'none', true, '历史轮完成行照旧隐藏')
  })
  push('完成态②：完成行是卡片外的独立兄弟行，卡片脚部「展开全文/复制/引用/时间 9:28」一个都不许连带', () => {
    assert.equal(stateA.rowInsideCard, false, '完成行不许长在卡片容器里（它是独立兄弟行）')
    assert.equal(stateA.cardInsideRow, false, '完成行里也不许挂卡')
    assert.equal(stateA.card.visible, true, '秘书卡本体必须可见')
    assert.equal(stateA.time.visible, true, '脚部时间 9:28 必须可见')
    assert.equal(stateA.copy.visible, true, '复制按钮必须可见')
    assert.equal(stateA.expand.visible, true, '「展开全文」必须可见')
    assert.ok(stateA.expandText.includes('展开全文'), `展开全文文案不许变：${stateA.expandText}`)
  })

  /* ② 执行中：最新轮 process 行与进行态提示都必须保留 */
  await page.setContent(pageShell(true, RUNNING_TURN), { waitUntil: 'load' })
  const tagB = await runTagger()
  const stateB = await page.evaluate(`(() => { ${EVAL_HELPERS}
    return {
      tool: describe(pick('running-tool-1')),
      context: describe(pick('running-context-1')),
      seat: describe(pick('running-turn-process-seat')),
      seatChildCount: pick('running-turn-process-seat').childElementCount,
      running: describe(pick('running-status')),
    } })()`)
  push('执行中①：最新用户轮的过程行（tool-call/context）照旧打标放行、真实可见', () => {
    assert.equal(tagB.turnNo, '21', `锚点必须落在最新用户轮：${JSON.stringify(tagB)}`)
    assert.equal(stateB.tool.marked, true, `tool-call 必须打标：${JSON.stringify(stateB.tool)}`)
    assert.notEqual(stateB.tool.display, 'none')
    assert.equal(stateB.tool.visible, true, '执行中的工具行必须出图')
    assert.equal(stateB.context.marked, true)
    assert.equal(stateB.context.visible, true, '执行中的上下文行必须出图')
  })
  push('执行中②：「深度求索中，用时 12秒 ···」进行态提示不许被藏；进行中没有「已完成」完成行', () => {
    assert.equal(stateB.running.display !== 'none' && stateB.running.visible, true,
      `进行态提示必须可见：${JSON.stringify(stateB.running)}`)
    assert.equal(stateB.seatChildCount, 0, '宿主进行中只渲染空 turn-process 座（TurnProcessNodeView 返回 null），fixture 与真页一致')
    assert.equal(stateB.seat.marked, false, '空座也不许打标')
    assert.equal(stateB.seat.visible, false, '空座没有内容，不出图')
  })

  /* ③ 作用域：不是秘书页时，同一行宿主原样显示（别会话一个字不动） */
  await page.setContent(pageShell(false, COMPLETED_TURN), { waitUntil: 'load' })
  await runTagger()
  const stateC = await page.evaluate(`(() => { ${EVAL_HELPERS}
    return { completed: describe(pick('completed-turn-process')) } })()`)
  push('作用域：没有 body[data-dsh-secretary="1"] 时完成行照常可见（改动只作用域秘书页）', () => {
    assert.notEqual(stateC.completed.display, 'none', `非秘书页不许隐藏：${JSON.stringify(stateC.completed)}`)
    assert.equal(stateC.completed.visible, true)
  })

  console.log(`tagger 完成态轮次: ${JSON.stringify(tagA)}；执行中轮次: ${JSON.stringify(tagB)}`)
} finally {
  await browser.close().catch(() => {})
}

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed > 0) {
  console.error(`SECRETARY TURN-TAIL COMPLETE-HIDE FAIL ${failed}`)
  process.exit(1)
}
console.log(`PASS ${cases.length}/${cases.length} secretary-turn-tail-complete-hide`)
