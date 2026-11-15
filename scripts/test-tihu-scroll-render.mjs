#!/usr/bin/env node
/**
 * 鹈鹕首页棋盘＝一列连续滚动的行（2026-11-15 由分页改过来的核账）。
 *
 *   node scripts/test-tihu-scroll-render.mjs
 *
 * 三件事钉死（同源读源码 + 真 chromium 把页面跑起来数行数）：
 *   1) 页面上再无翻页控件、再无页码文字：上一页 / 下一页 / 第 X 页 / 共 N 页 / 第几行至第几行；
 *   2) 整列一次排完（未归档卡上限 LEDGER_MAX_TASKS=60，页面不夹行、不重排），纵向滚动区自己滚：
 *      滑到某行后宿主重发帧不许把人顶回第一行；宿主说滚到第几行 / 最上 / 最下，页面真的滚，
 *      并且每一条都回 device.ack（滚不成也照实回 ok:false + 原因）；
 *   3) 协议两侧这条都在（上游 device.ack、下游 board.scroll），旧的「翻页」下行与工具没有残留死分支。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

import {
  TIHU_DOWNSTREAM_TYPES,
  TIHU_PROTOCOL_VERSION,
  TIHU_UPSTREAM_TYPES,
} from '../src/tihu/protocol.ts'
import { BOARD_VIEWPORT_ROWS, LEDGER_MAX_TASKS, boardOf } from '../src/tihu/task-ledger.ts'
import {
  BOARD_MAX_TITLE_LINES,
  SCREEN_SPEC,
  boardRowHeightForLines,
  boardTitleLinesOf,
} from '../src/tihu/screen-spec.ts'
import { tihuPageHtml } from '../src/tihu/page.ts'

const sourceOf = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const PAGE_TS = sourceOf('../src/tihu/page.ts')
const LANE_TS = sourceOf('../src/tihu/lane.ts')
const CONTROL_TS = sourceOf('../src/tihu/control.ts')
const DISPATCH_TS = sourceOf('../src/tihu/dispatch-protocol.ts')
const LEDGER_TS = sourceOf('../src/tihu/task-ledger.ts')
const PROTOCOL_TS = sourceOf('../src/tihu/protocol.ts')

/** 只从页面模板里抠出那段浏览器脚本（页面上的东西以这段为准，宿主侧的文字不看这段）。 */
const PAGE_SCRIPT = (PAGE_TS.match(/<script>([\s\S]*?)<\/script>/) ?? [''])[1]
const RENDER_BOARD = PAGE_SCRIPT.slice(PAGE_SCRIPT.indexOf('function renderBoard('), PAGE_SCRIPT.indexOf('function boardStatusEl('))
const BOARD_SCROLL_CASE = PAGE_SCRIPT.slice(PAGE_SCRIPT.indexOf("case 'board.scroll'"), PAGE_SCRIPT.indexOf("case 'playback.control'"))

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`)
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`)
  }
}

/* ---------- 1. 页面上没有翻页控件、没有页码文字 ---------- */

test('页面脚本里没有翻页控件、没有页码文字（上一页 / 下一页 / 第 X 页 / 共 N 页 / 第几行至第几行）', () => {
  for (const token of ['上一页', '下一页', '往前面走', '往后面走', 'boardPrev', 'boardNext', 'boardPager',
    'boardPageInfo', 'pageBadge', 'board.page', 'tihu_board_page', 'extra.page', 'pageInfo']) {
    assert.equal(PAGE_SCRIPT.includes(token), false, `页面上不该再有「${token}」这一类翻页痕迹`)
  }
  assert.equal(/renderBoardPager|buildBoardPager|pagerEl|pageLabel|pageWrap|boardPageInfo/.test(PAGE_SCRIPT), false, '翻页那一层没有残留函数/变量')
  assert.equal(/第 \d+ 页|共 \d+ 页|至第| 页\/共/.test(PAGE_SCRIPT), false, '屏上不许出现页码文字')
})

test('lane 侧也没有页码文字（回执 / 指挥台提示都按「这一列几行」说话）', () => {
  for (const token of ["'上一页'", "'下一页'", 'extra.page', 'boardPage', 'tihu_board_page', 'TIHU_BOARD_PAGE_ROWS']) {
    assert.equal(LANE_TS.includes(token), false, `lane 里不该再有「${token}」`)
  }
  assert.equal(/第 \$\{[^}]*\} 页|至第|页\/共/.test(LANE_TS), false, 'lane 的文案里没有页码')
  assert.ok(LANE_TS.includes('这一列只有'), '行号超出这一列要有明确的报错文案（不钳到某一页）')
  assert.ok(LANE_TS.includes('没有页码'), '指挥台提示要说清「没有页码」')
  assert.ok(LANE_TS.includes('连续滚动'), '指挥台提示要说清这一列是连续滚动')
  assert.ok(LANE_TS.includes('行号从 1'), '指挥台提示要给出行号口径（1 起）')
  assert.ok(LANE_TS.includes('屏上第一行就是 1'), '指挥台提示要说清屏上第一行就是第 1 行')
})

test('协议与工具表：board.scroll 在名单里，旧的 board.page / tihu_board_page 一个都不留', () => {
  assert.equal(TIHU_DOWNSTREAM_TYPES.includes('board.scroll'), true, 'board.scroll 已登记进下游名单（字段只增不删）')
  assert.equal(TIHU_UPSTREAM_TYPES.includes('device.ack'), true, 'device.ack 还在上游名单（滚完要回回执）')
  assert.equal(TIHU_DOWNSTREAM_TYPES.includes('board.page'), false, '旧的 board.page 下行已取消（不留没目标的那一支）')
  assert.ok(PROTOCOL_TS.includes('export interface BoardScrollPayload'), 'payload 类型有 BoardScrollPayload')
  assert.ok(PROTOCOL_TS.includes('row?: number'), 'board.scroll 带行号（1 起）')
  assert.ok(PROTOCOL_TS.includes("to?: 'top' | 'bottom'"), 'board.scroll 带顶／底')
  const boardPayload = PROTOCOL_TS.slice(PROTOCOL_TS.indexOf('export interface TaskBoardPayload'), PROTOCOL_TS.indexOf('export interface TaskListPayload'))
  assert.equal(boardPayload.includes('page'), false, '棋盘 payload 里没有 page 这一项')
  assert.equal(DISPATCH_TS.includes('tihu_board_page'), false, '工具表里没有翻页那条工具')
  assert.ok(DISPATCH_TS.includes('tihu_board_scroll'), '工具表里有 tihu_board_scroll')
  assert.ok(CONTROL_TS.includes('boardScroll'), '控制面有 boardScroll 这条命令')
  assert.equal(CONTROL_TS.includes('boardPage'), false, '控制面没有翻页这条命令')
})

/* ---------- 2. 棋盘那一列是纵向滚动区，整列一次排完 ---------- */

test('棋盘列表区是纵向滚动区：#screen 整屏不滚，只有 .board-list 滚', () => {
  const listRule = PAGE_TS.slice(PAGE_TS.indexOf('#screen .board-list {'))
  assert.ok(listRule.startsWith('#screen .board-list {'), '棋盘列表区有自己这一层样式')
  assert.ok(listRule.slice(0, 300).includes('overflow-y:auto'), '.board-list 必须纵向可滚（手指往上滑就看后面的行）')
  assert.ok(listRule.slice(0, 300).includes('overflow-x:hidden'), '横向不许滚（屏宽固定）')
  const screenRule = PAGE_TS.slice(PAGE_TS.indexOf('#screen {'), PAGE_TS.indexOf('#screen.board-mode'))
  assert.ok(screenRule.includes('overflow:hidden'), '整屏不滚：只有那一列滚（320×240 屏预算是固定的）')
  assert.ok(PAGE_SCRIPT.includes("list.className = 'board-list'"), '整列行都排进这一个滚动层')
  assert.ok(PAGE_TS.includes('#screen .board-list::-webkit-scrollbar'), '给这一列一条细滚动条（别拿原生 17px 粗条压屏）')
})

test('renderBoard 一次把整列排完：不夹行、不重排、重画保住此刻的滚动位置', () => {
  assert.ok(RENDER_BOARD.includes("for (var i = 0; i < rows.length; i += 1)"), '按 rows 全部行建行（没有「每页几行」的切法）')
  assert.equal(RENDER_BOARD.includes('.slice('), false, 'renderBoard 里不许再切一刀（切了就是把行夹进页里）')
  assert.equal(/rows\.(sort|reverse)/.test(RENDER_BOARD), false, '页面不许自己重排（行号与宿主、屏上是同一份）')
  assert.ok(RENDER_BOARD.includes('var keepScroll'), '重画前先把这一列此刻的滚动位置读出来')
  assert.ok(RENDER_BOARD.includes('list.scrollTop = Math.min(keepScroll'), '重画完要放回去（否则滑到的行被顶回第一行）')
})

test('宿主侧整列一次下发（未归档卡 60 张上限、没有页可切）', () => {
  const boardOfRegion = LEDGER_TS.slice(LEDGER_TS.indexOf('export function boardOf('), LEDGER_TS.indexOf('/**', LEDGER_TS.indexOf('export function boardOf(') + 30))
  assert.ok(boardOfRegion.includes('rows,'), 'boardOf 把整列都交出去（页面自己滚）')
  assert.equal(boardOfRegion.includes('page:'), false, 'boardOf 不夹页码字段')
  assert.ok(LEDGER_MAX_TASKS === 60, '未归档卡上限就是 60（60 行都能滚到）')
  assert.ok(BOARD_VIEWPORT_ROWS === 4, '可视区看得见约 4 行只是口径，不是行数上限')
  assert.equal(LANE_TS.includes('TIHU_BOARD_PAGE_ROWS'), false, '旧的「每页行预算」常量已删')
  const board = boardOf(Array.from({ length: 6 }, (_, index) => ({
    taskId: `t${index + 1}`, projectId: 'p', projectName: '测试', title: `第 ${index + 1} 件事`,
    state: 'queued', step: 0, stepTotal: 0, sessionIds: [], createdAt: 1000 + index, updatedAt: 1000 + index, usedMs: 0,
  })), 2000)
  assert.equal(board.rows.length, 6, '6 张卡全在这一列里：' + JSON.stringify(board.rows.map((row) => row.taskId)))
  assert.equal(board.total, 6, 'total 就是这一列的行数')
  assert.equal(board.page, undefined, '棋盘里没有 page 这一项')
})

test('页面认这条下行（board.scroll），而且只在棋盘那一列上生效', () => {
  assert.ok(BOARD_SCROLL_CASE.includes("case 'board.scroll'"), "handle 里有 board.scroll 这一支")
  assert.ok(BOARD_SCROLL_CASE.includes("state.screenMode === 'board'"), '停在别的屏时这一支没有目标（不假装滚成）')
  assert.ok(BOARD_SCROLL_CASE.includes("move.to === 'top'"), '支持滚到最上面')
  assert.ok(BOARD_SCROLL_CASE.includes("move.to === 'bottom'"), '支持滚到最下面')
  assert.ok(BOARD_SCROLL_CASE.includes('scrollIntoView'), '按行号滚（滚到哪一行哪一行进可视区）')
  assert.ok(BOARD_SCROLL_CASE.includes('ackDown(payload'), '每一条都回 device.ack（宿主不等回执就当没办成）')
  assert.ok(BOARD_SCROLL_CASE.includes('ok: false'), '滚不成要照实回 ok:false + 原因')
  assert.ok(PAGE_SCRIPT.includes("'棋盘' + (boardTotal > 0 ? '（' + boardTotal + ' 行，往上滑看后面的行）' : '')"),
    '回执里的屏名说清这一列怎么往下看（不带页码）')
})

/* ---------- 4. 2026-11-15：棋盘标题完整可见（逐行渲染、卡片按行数长高） ---------- */

test('棋盘标题完整可见：宿主按实际宽度逐行折好下发，全文在 title/aria-label 可获取，超上限才带省略号', () => {
  const longTitle = '这是一条长到在屏上折得出好几行的任务标题，每一行都必须完整显示、绝不半截断尾'
  // 台账 → 棋盘帧：逐行折好随卡下发（字段只增不删，标题字段仍是原文）
  const board = boardOf([{
    taskId: 't1', projectId: 'p', projectName: '测试', title: longTitle,
    state: 'queued', step: 0, stepTotal: 0, sessionIds: [], createdAt: 1000, updatedAt: 1000, usedMs: 0,
  }], 2000)
  const firstRow = board.rows[0]
  const wrap = boardTitleLinesOf(longTitle, { capsule: firstRow.capsule, microBars: firstRow.micro ? firstRow.micro.length : 0 })
  assert.ok(wrap.lines.length >= 2, '长标题按屏上真实可用宽折成多行：' + JSON.stringify(wrap.lines))
  assert.equal(wrap.truncated, false, '这个长度远没触顶，不该截断')
  assert.equal(wrap.lines.join(''), longTitle, '折行只丢空白不切字：逐行拼回去＝原文一字不少')
  assert.equal(wrap.rowHeightPx, boardRowHeightForLines(wrap.lines.length), '卡片高度跟标题行数走')
  assert.ok(wrap.rowHeightPx > SCREEN_SPEC.boardRowMinHeightPx, '多行标题的卡片比单行卡片高（宁可一屏少看几行）')
  // 真超上限才允许省略号，且最后一行必须以省略号收尾（绝不以半截汉字收尾）
  const huge = '超'.repeat(120)
  const capped = boardTitleLinesOf(huge, { capsule: '排队中', microBars: 3 })
  assert.equal(capped.lines.length, BOARD_MAX_TITLE_LINES, '屏上最多排到预算上限那么多行')
  assert.equal(capped.truncated, true, '真超了才标 truncated')
  assert.ok(capped.lines[capped.lines.length - 1].endsWith('…'),
    '最后一行省略号收尾，不能以半截汉字结尾：' + capped.lines[capped.lines.length - 1])
  assert.equal(firstRow.title, longTitle, '标题字段仍是会话原文（2026-11-13 定案不变）')
  assert.deepEqual(firstRow.titleLines, wrap.lines, '卡上带折好的逐行文本，页面不二次折行')
  assert.equal(firstRow.rowHeightPx, wrap.rowHeightPx, '卡上带这一张卡的高度')
  assert.equal(firstRow.titleTruncated, undefined, '没截断就不带这个标记')
  // 页面侧：逐行渲染 + 全文可获取 + 内联高度压过壳
  assert.ok(PAGE_TS.includes('board-title-line'), '页面逐行渲染标题（一行一个块）')
  assert.ok(RENDER_BOARD.includes("item.setAttribute('title', titleText)"), '完整标题在卡片 title 属性上')
  assert.ok(RENDER_BOARD.includes("title.setAttribute('aria-label', titleText)"), '完整标题也在 aria-label 上')
  assert.ok(RENDER_BOARD.includes("setProperty('min-height'"), '卡片高度走内联 !important（压过壳的 48px 一刀切）')
  assert.ok(RENDER_BOARD.includes('boardTitleLinesFor(row)'), '页面按卡上带的逐行文本渲染')
})

/* ---------- 3. 真浏览器核账：行数、滚动、回执闭环 ---------- */

await testAsync('真 chromium：整列一次排完 + 纵向连续滚动 + board.scroll 回执闭环', async () => {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    return
  }
  const html = tihuPageHtml({ lanePath: '/tihu/lane', protocol: TIHU_PROTOCOL_VERSION })
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  let browser
  try {
    browser = await chromium.launch()
  } catch {
    server.close()
    return
  }
  const rows = Array.from({ length: 9 }, (_, index) => ({
    taskId: 't' + (index + 1),
    title: '第' + (index + 1) + '行任务',
    state: 'queued',
    capsule: '排队中',
    sub: '测试 · 排队中',
    ring: { percent: 0, tone: 'empty' },
    micro: [1, 2, 3],
  }))
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 320 } })
    // 假 lane WebSocket：上行都收到 window.__tihuSent，测试也从这条真的 onmessage 路上喂帧进来。
    await page.addInitScript(() => {
      window.__tihuSent = []
      window.WebSocket = function FakeLaneSocket(url) {
        this.url = url
        this.readyState = 1
        this.binaryType = 'arraybuffer'
        this.addEventListener = () => {}
        this.send = (text) => { window.__tihuSent.push(JSON.parse(text)) }
        this.close = () => { this.readyState = 3 }
        window.__tihuFeed = (frame) => { this.onmessage && this.onmessage({ data: JSON.stringify(frame) }) }
      }
    })
    await page.goto('http://127.0.0.1:' + port + '/tihu?token=tst', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof window.__tihuFeed === 'function', { timeout: 8000 })

    const out = await page.evaluate((rows) => {
      const feed = (type, payload) => window.__tihuFeed({ v: '0', type, payload, seq: 1, ts: Date.now() })
      const acks = () => window.__tihuSent.filter((msg) => msg.type === 'device.ack')
      const list = () => document.querySelector('#homeBody .board-list')
      const items = () => [...document.querySelectorAll('#homeBody .board-item')]
      const snap = () => {
        const el = list()
        return {
          count: items().length,
          order: items().map((item) => item.getAttribute('data-task')),
          titles: items().map((item) => (item.querySelector('.board-title') || {}).textContent),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: getComputedStyle(el).overflowY,
          scrollTop: el.scrollTop,
          text: (document.getElementById('homeBody') || {}).textContent || '',
        }
      }
      const ackOf = (opId) => acks().find((msg) => msg.payload && msg.payload.opId === opId)?.payload
      feed('task.list', { board: { rows, total: rows.length, empty: false, counts: { running: 0, awaiting: 0, queued: rows.length, done: 0 } } })
      const first = snap()
      list().scrollTop = 190
      const slid = snap()
      // 宿主按时钟重发同一帧（时长弧要跟着跑）：不许把人滑到的行顶回头部
      feed('task.list', { board: { rows, total: rows.length, empty: false, counts: { running: 0, awaiting: 0, queued: rows.length, done: 0 } } })
      const afterRerender = snap()
      feed('board.scroll', { opId: 'op-row-8', row: 8 })
      const atRow8 = snap()
      feed('board.scroll', { opId: 'op-top', to: 'top' })
      const atTop = snap()
      feed('board.scroll', { opId: 'op-bottom', to: 'bottom' })
      const atBottom = snap()
      feed('board.scroll', { opId: 'op-shape', to: 'middle' })
      feed('task.list', { board: { rows: [], total: 0, empty: true, counts: { running: 0, awaiting: 0, queued: 0, done: 0 } } })
      feed('board.scroll', { opId: 'op-empty', row: 3 })
      feed('screen.frame', { stage: '进度', title: '在跑的任务', bullets: ['第 1 步'], tone: 'busy' })
      feed('board.scroll', { opId: 'op-offboard', row: 2 })
      feed('board.scroll', { noOpIdShape: true })
      return {
        first, slid, afterRerender, atRow8, atTop, atBottom,
        row8: ackOf('op-row-8'), top: ackOf('op-top'), bottom: ackOf('op-bottom'),
        shape: ackOf('op-shape'), empty: ackOf('op-empty'), offboard: ackOf('op-offboard'),
        noOpId: acks().some((msg) => msg.payload && msg.payload.opId === 'noOpId'),
        pagerIds: ['boardPager', 'boardPrev', 'boardNext', 'boardPageInfo'].filter((id) => !!document.getElementById(id)),
      }
    }, rows)

    // 行数：9 行全渲染出来、顺序就是 boardOf 的顺序（没有夹进某一页）
    assert.equal(out.first.count, 9, '整列一次排完：' + JSON.stringify(out.first.order))
    assert.deepEqual(out.first.order, rows.map((row) => row.taskId), '屏上第几行＝boardOf 的第几行（没有夹行）')
    assert.deepEqual(out.first.titles, rows.map((row) => row.title), '行的文字按顺序落屏（页面没有自己重排）')
    assert.deepEqual(out.pagerIds, [], '旧的翻页控件 id 一个都不在页面上')
    assert.equal(out.first.text.includes('上一页') || out.first.text.includes('下一页'), false, '屏上没有页码文字')

    // 真的能滚：内容高 > 可视高（9 行 ×48px > 可视区那 4 行）
    assert.equal(out.first.overflowY, 'auto', '.board-list 是纵向滚动区')
    assert.ok(out.first.scrollHeight > out.first.clientHeight,
      `内容比可视区高才叫连续滚动：${out.first.scrollHeight} > ${out.first.clientHeight}`)
    assert.ok(out.slid.scrollTop > 0, '手指往上滑真的动了：' + out.slid.scrollTop)

    // 重画保住滚动位置
    assert.ok(out.afterRerender.scrollTop > 0, '宿主重发帧不许把人滑到的行顶回第一行：' + out.afterRerender.scrollTop)

    // 宿主说滚到第 8 行 / 最上面 / 最下面 → 页面真的动了，而且每条都回 device.ack
    assert.ok(out.atRow8.scrollTop > 0, '滚到第 8 行真的动了：' + out.atRow8.scrollTop)
    assert.equal(out.atTop.scrollTop, 0, '滚到最上面＝scrollTop 0')
    assert.ok(out.atBottom.scrollTop > 0, '滚到最下面真的到底了：' + out.atBottom.scrollTop)
    for (const [label, ack] of [['第 8 行', out.row8], ['最上面', out.top], ['最下面', out.bottom]]) {
      assert.ok(ack, `滚到${label}要有 device.ack`)
      assert.equal(ack.ok, true, `滚到${label}要回 ok:true：` + JSON.stringify(ack))
      assert.ok(String(ack.stage).includes('往上滑'), '屏名要说清这一列怎么往下看：' + ack.stage)
      assert.equal(String(ack.stage).includes('页'), false, '屏名里没有「页」这一说：' + ack.stage)
    }

    // 滚不成 / 没目标 / 空棋盘：都照实回话，宿主不假装成功
    assert.ok(out.shape, '形状不认也要回回执')
    assert.equal(out.shape.ok, false, '形状不认要回 ok:false：' + JSON.stringify(out.shape))
    assert.ok(String(out.shape.reason).includes('没有可滚的行'), '要说清为什么没滚成：' + out.shape.reason)
    assert.ok(out.offboard, '停在别的屏时这条下行没有目标 → 要回执')
    assert.equal(out.offboard.ok, false, '停在别的屏要回 ok:false：' + JSON.stringify(out.offboard))
    assert.ok(String(out.offboard.reason).includes('不在棋盘'), '原因要说清：' + out.offboard.reason)
    assert.ok(out.empty, '空棋盘也要回回执')
    assert.equal(out.empty.ok, true, '空棋盘滚过去当空滚（不报错也不装成滚到别处）：' + JSON.stringify(out.empty))
    assert.equal(out.noOpId, false, '没有 opId 的下行不回回执（旧的翻页指令没有 opId 这一说）')
  } finally {
    await browser.close()
    server.close()
  }
})

await testAsync('真 chromium：棋盘标题逐行完整显示 + 完成页按真实剩余高度取行数、可连续滚动、高亮行自动进可视区', async () => {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    return
  }
  const html = tihuPageHtml({ lanePath: '/tihu/lane', protocol: TIHU_PROTOCOL_VERSION })
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  let browser
  try {
    browser = await chromium.launch()
  } catch {
    server.close()
    return
  }
  const longTitle = '长标题测试：每一行都要完整显示在卡片上，行数多卡片就长高'
  const wrap = boardTitleLinesOf(longTitle, { capsule: '排队中', microBars: 0 })
  const boardRow = {
    taskId: 't1', title: longTitle, state: 'queued', capsule: '排队中',
    sub: '测试 · 排队中', ring: { percent: 0, tone: 'empty' }, micro: [1, 2, 3],
    titleLines: wrap.lines, rowHeightPx: wrap.rowHeightPx,
  }
  const doneLines = Array.from({ length: 20 }, (_, index) => '第 ' + (index + 1) + ' 行正文，一行没落全排在这一列里。')
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 320 } })
    await page.addInitScript(() => {
      window.__tihuSent = []
      window.WebSocket = function FakeLaneSocket(url) {
        this.url = url
        this.readyState = 1
        this.binaryType = 'arraybuffer'
        this.addEventListener = () => {}
        this.send = (text) => { window.__tihuSent.push(JSON.parse(text)) }
        this.close = () => { this.readyState = 3 }
        window.__tihuFeed = (frame) => { this.onmessage && this.onmessage({ data: JSON.stringify(frame) }) }
      }
    })
    await page.goto('http://127.0.0.1:' + port + '/tihu?token=tst', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof window.__tihuFeed === 'function', { timeout: 8000 })

    const out = await page.evaluate((input) => {
      const feed = (type, payload) => window.__tihuFeed({ v: '0', type, payload, seq: 1, ts: Date.now() })
      feed('task.list', { board: { rows: [input.boardRow], total: 1, empty: false, counts: { running: 0, awaiting: 0, queued: 1, done: 0 } } })
      const item = document.querySelector('#homeBody .board-item')
      const titleEl = item.querySelector('.board-title')
      const board = {
        lineCount: titleEl.querySelectorAll('.board-title-line').length,
        text: titleEl.textContent,
        titleAttr: item.getAttribute('title'),
        aria: titleEl.getAttribute('aria-label'),
        height: item.getBoundingClientRect().height,
      }
      const doneFrame = (current) => ({
        stage: '完成', title: '完成页行数测试',
        done: { lines: input.doneLines, current },
        actions: [
          { id: 'stop', label: '停止' },
          { id: 'replay', label: '重读' },
          { id: 'taskBoard', label: '主页' },
        ],
        tone: 'ok', mode: 'status',
      })
      feed('screen.frame', doneFrame(0))
      const body = document.getElementById('doneBody')
      const stat = () => {
        const lineEls = [...body.querySelectorAll('.done-line')]
        const lineH = lineEls.length > 0 ? lineEls[0].getBoundingClientRect().height : 0
        const cur = body.querySelector('.done-line.cur')
        const scrollTop = body.scrollTop
        const clientHeight = body.clientHeight
        return {
          count: lineEls.length,
          overflowY: getComputedStyle(body).overflowY,
          scrollHeight: body.scrollHeight,
          clientHeight,
          visibleRows: lineH > 0 ? Math.floor(clientHeight / lineH) : 0,
          scrollTop,
          curInView: cur ? (cur.offsetTop >= scrollTop - 1 && cur.offsetTop + cur.offsetHeight <= scrollTop + clientHeight + 1) : false,
        }
      }
      const first = stat()
      body.scrollTop = 120
      const slid = stat()
      feed('screen.frame', doneFrame(0)) // 同一帧重发：不许把人滑到的位置顶回第一行
      const afterSame = stat()
      feed('screen.frame', doneFrame(19)) // 高亮跳到最后一行：必须自动滚进可视区
      const atLast = stat()
      return { board, first, slid, afterSame, atLast }
    }, { boardRow, doneLines })

    // 棋盘：标题逐行完整显示
    assert.ok(out.board.lineCount >= 2, '长标题逐行渲染：' + out.board.lineCount + ' 行')
    assert.equal(out.board.text, longTitle, '逐行拼回去＝原文，没有半截断尾')
    assert.equal(out.board.titleAttr, longTitle, '完整标题在卡片 title 属性上')
    assert.equal(out.board.aria, longTitle, '完整标题在 aria-label 上')
    assert.ok(out.board.height >= boardRow.rowHeightPx,
      `卡片按行数长高：${out.board.height} >= ${boardRow.rowHeightPx}`)

    // 完成页：整列一次排完 + 纵向连续滚动
    assert.equal(out.first.count, 20, '正文一行没落全排在这一列里（不是只画 7 行）')
    assert.equal(out.first.overflowY, 'auto', '.done-body 是纵向滚动区')
    assert.ok(out.first.scrollHeight > out.first.clientHeight, '内容比可视区高＝滑得动')
    assert.ok(out.first.visibleRows >= 7, `可视行数按真实剩余高度算：${out.first.visibleRows} 行（320×240 预算下限 7 行）`)
    assert.equal(out.first.curInView, true, '开屏高亮行在可视区内')

    // 手指上滑 → 宿主重发同一帧：位置保住
    assert.ok(out.slid.scrollTop > 0, '手指上滑真的动了')
    assert.ok(out.afterSame.scrollTop > 0, '同一帧重发不许把人顶回第一行：' + out.afterSame.scrollTop)

    // 高亮换到最后一行：自动滚进可视区
    assert.notEqual(out.atLast.scrollTop, out.slid.scrollTop, '高亮换行时这一列跟着动')
    assert.equal(out.atLast.curInView, true, '高亮所在行自动滚进可视区：' + JSON.stringify(out.atLast))
  } finally {
    await browser.close()
    server.close()
  }
})

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failed}（tihu 棋盘连续滚动）`)
if (failed > 0) process.exit(1)
process.exit(0)
