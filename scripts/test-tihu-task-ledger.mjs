#!/usr/bin/env node
/**
 * 任务登记簿（Task Ledger）与任务屏（task-screens）单测。
 *
 * 这两块是「统一指挥会话」的事实源与投影层，全部是纯函数／可注入时钟，
 * 所以能在这里把边界条件钉死：
 *   - 状态机只允许设计里那几条边（完成的东西不会被一条迟到事件拉回执行中）；
 *   - 棋盘排序：待决策 → 执行中（含子代理在跑）→ 其余按时间，一条任务一张卡；
 *   - 时长环满圈 30 分钟、完成后满环、排队空环；
 *   - 播报 P0 插队、P1 八秒合并、P3 永不播；
 *   - 派单快路径：点名卡 / 追加 / 日常 / 歧义追问，各走一条。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ANNOUNCE_SINGLE_DELAY_MS,
  ANNOUNCE_WINDOW_MS,
  BOARD_PAGE_SIZE,
  DONE_KEEP_MS,
  LEDGER_RESTORE_MAX,
  LEDGER_SNAPSHOT_VERSION,
  RESTORED_INTERRUPTED_LINE,
  RING_FULL_MS,
  TaskLedger,
  TaskNotifyBus,
  boardOf,
  boardTitleOf,
  capsuleOf,
  chineseIndex,
  countsOf,
  firstFolderOf,
  formatUsedMs,
  journalLineOf,
  ledgerSnapshotOf,
  looksSimpleTask,
  longestCommonRun,
  mergeAnnouncements,
  parseScreenCommand,
  plainSummaryOf,
  restoreLedgerTasks,
  ringOf,
  routeQuick,
  isFinishedState,
  isPinnedBoardTask,
  bestCardMatchOf,
  continuityAffinityOf,
  continuityCueScore,
  continuityOf,
  continuityScoreOf,
  continuityTimeScore,
  isConfidentProjectRoute,
  previousSessionFollowUpOf,
  projectMatchConfidenceOf,
  scoreCardAlias,
  stripWakeWord,
  subLineOf,
  taskTitleOf,
} from '../src/tihu/task-ledger.ts'
import {
  TaskLedgerStore,
  parseLedgerSnapshot,
  readLedgerSnapshot,
  writeLedgerSnapshot,
} from '../src/tihu/task-store.ts'
import {
  DONE_BODY_FONT_PX,
  DONE_BODY_TEXT_WIDTH_PX,
  DONE_NO_REPLY_TEXT,
  DONE_PATH_MAX_CHARS,
  RECEIPT_SECONDS,
  abbreviatePath,
  askWhichFrame,
  boardFrame,
  detailFrame,
  doneAnnouncementOf,
  doneFrame,
  doneLineRangesOf,
  doneLinesOf,
  doneSpeechSegmentsOf,
  DONE_SPEECH_MAX_CHARS,
  folderBase,
  noticeFrame,
  prepareDoneText,
  receiptFrame,
  stripMarkdownMarks,
} from '../src/tihu/task-screens.ts'
import { DONE_TITLE_FONT_PX, CONTENT_WIDTH_PX, fitScreenLines, measureTextPx, SCREEN_SPEC } from '../src/tihu/screen-spec.ts'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

/* ---------- 登记簿：状态机 ---------- */

test('新任务是排队态：没有步数、没有会话、不编用时', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '把青年基金第 3 段改写', projectId: 'p1', projectName: '青年基金申请书', now: 1000 })
  assert.equal(task.taskId, 't1')
  assert.equal(task.state, 'queued')
  assert.equal(task.step, 0)
  assert.deepEqual(task.sessionIds, [])
  assert.equal(subLineOf(task, task.projectName), '青年基金申请书 · 排队中')
  assert.equal(ringOf(task, 1000).tone, 'empty')
  assert.equal(capsuleOf(task.state), '排队中')
})

test('等指挥台判断：排队卡副行标等待；判出结果 adopt 同一 taskId 转正（不新建第二张）', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '把这两个方向拿个主意', projectId: 'wt-assistant', projectName: '个人助手', waitingCommander: true, now: 1000 })
  assert.equal(task.state, 'queued')
  assert.equal(subLineOf(task), '个人助手 · 等指挥台判断')
  const row = boardOf(ledger.list(), 1000).rows[0]
  assert.equal(row.capsule, '排队中')
  assert.equal(row.sub, '个人助手 · 等指挥台判断')
  assert.deepEqual(countsOf(ledger.list()), { running: 0, awaiting: 0, queued: 1, done: 0 })
  // 判出结果：同一张卡转成正式任务（项目/文件夹改掉，taskId 不变）。
  ledger.adopt(task.taskId, { title: '把这两个方向拿个主意', projectId: 'card-fund', projectName: '青年基金申请书', folder: 'D:/fund', now: 2000 })
  assert.equal(task.taskId, 't1', 'taskId 必须保持')
  assert.equal(task.waitingCommander, undefined)
  assert.equal(task.projectName, '青年基金申请书')
  assert.equal(subLineOf(task), '青年基金申请书 · 排队中')
  ledger.attachSession(task.taskId, 'session-x', 3000)
  assert.equal(ledger.list().filter((item) => item.state !== 'archived').length, 1, '只有一张卡')
})

test('自动归档不早于 3 天（用户要求静置超过 3 天才允许）', () => {
  assert.ok(DONE_KEEP_MS >= 3 * 24 * 60 * 60 * 1000, `DONE_KEEP_MS=${DONE_KEEP_MS}`)
})

test('七态登记簿：排队→派单→执行中→待决策→完成→已播报→归档', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '七态', projectId: 'p', projectName: 'P', now: 1000 })
  assert.equal(task.state, 'queued')
  ledger.attachSession(task.taskId, 's7', 1100)
  assert.equal(task.state, 'dispatched')
  ledger.markRunning(task.taskId, 1200)
  assert.equal(task.state, 'running')
  ledger.ask(task.taskId, { question: '删？', options: ['确认删除', '先留着'], defaultIndex: 0, timeoutMs: 60_000, now: 1300 })
  assert.equal(task.state, 'awaiting')
  ledger.answer(task.taskId, '设备点选', 1400)
  assert.equal(task.state, 'running')
  ledger.complete(task.taskId, { resultLine: '好了', now: 1500 })
  assert.equal(task.state, 'done')
  ledger.markSpoken(task.taskId, 1600)
  assert.equal(task.state, 'announced')
  assert.equal(capsuleOf('announced'), '完成', '屏上胶囊仍写完成；已播报是登记簿态')
  ledger.archive(task.taskId, 1700)
  assert.equal(task.state, 'archived')
})

test('绑上会话＝派单态；turn/start 才进执行中；attachSession 不重复加同一条会话', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: 'x', projectId: 'p1', projectName: 'P', now: 1000 })
  ledger.attachSession(task.taskId, 'session-aaaa', 1100)
  ledger.attachSession(task.taskId, 'session-aaaa', 1200)
  assert.equal(task.state, 'dispatched')
  assert.equal(capsuleOf(task.state), '排队中')
  ledger.markRunning(task.taskId, 1300)
  assert.equal(task.state, 'running')
  assert.deepEqual(task.sessionIds, ['session-aaaa'])
  assert.equal(ledger.ofSession('session-aaaa')?.taskId, 't1')
})

test('同一会话挂着已完成的旧卡＋新一句话的新卡：ofSession 归到新卡，旧卡留在棋盘上', () => {
  const ledger = new TaskLedger()
  const old = ledger.add({ title: '再读一下后两行', projectId: 'p1', projectName: '个人助手', now: 1000 })
  ledger.attachSession(old.taskId, 'session-493ebb6f', 1100)
  ledger.markRunning(old.taskId, 1200)
  ledger.complete(old.taskId, { resultLine: '读完了', now: 1300 })
  ledger.markSpoken(old.taskId, 1400)
  assert.equal(old.state, 'announced')
  // 新一句话落到同一条会话：另起一张卡（旧卡不动）。
  const fresh = ledger.add({ title: '帮我把 README 的前两行读出来', projectId: 'p1', projectName: '个人助手', now: 1500, sessionIds: ['session-493ebb6f'] })
  ledger.attachSession(fresh.taskId, 'session-493ebb6f', 1500)
  assert.equal(ledger.ofSession('session-493ebb6f')?.taskId, 't2', '事件归一必须拿最近动过的那张卡（新卡）')
  assert.equal(ledger.get('t1').state, 'announced', '旧卡状态一字不动')
  assert.equal(ledger.get('t1').title, '再读一下后两行', '旧卡标题一字不动')
  const board = boardOf(ledger.list(), 1)
  assert.equal(board.rows.length, 2, '两张卡都在棋盘上（旧卡不摘）')
  assert.deepEqual(board.counts, { running: 0, awaiting: 0, queued: 1, done: 1 }, '新卡排队中、旧卡仍算完成')
  ledger.markRunning(fresh.taskId, 1600)
  assert.deepEqual(boardOf(ledger.list(), 1).counts, { running: 1, awaiting: 0, queued: 0, done: 1 }, '投进去之后新卡执行中')
})

test('reopenForAppend 会把完成卡拉回执行中（所以 lane 只允许对还在跑的卡调它——见 test-tihu-protocol 承接回归）', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '旧话', projectId: 'p1', projectName: 'P', now: 1000 })
  ledger.attachSession(task.taskId, 'session-a', 1100)
  ledger.markRunning(task.taskId, 1200)
  ledger.complete(task.taskId, { resultLine: '好了', now: 1300 })
  // 登记簿本身不判「该不该复用」——复用条件由 lane 的 closedPrevious 判断（见协议回归）。
  // 这里钉住 reopenForAppend 的行为：它确实会把完成卡改回 running（所以 lane 只允许对还在跑的卡调它）。
  ledger.reopenForAppend(task.taskId, 1400)
  assert.equal(task.state, 'running')
  assert.equal(task.finishedAt, undefined, '回到执行中：完成时刻要清掉')
})

test('步数只增不减（乱序到达的 tool/call 不能把第 7 步改回第 2 步）', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: 'x', projectId: 'p1', projectName: 'P' })
  ledger.attachSession(task.taskId, 'session-step')
  ledger.markRunning(task.taskId)
  ledger.noteStep(task.taskId, 3)
  ledger.noteStep(task.taskId, 1)
  ledger.noteStep(task.taskId, 7)
  assert.equal(task.step, 7)
  assert.equal(subLineOf(task, '青年基金申请书'), '青年基金申请书 · 第 7 步')
})

test('棋盘标题只留「状态 + 会话名」，项目名只留在副行', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '个人助手 今天几号', projectId: 'p1', projectName: '个人助手' })
  ledger.attachSession(task.taskId, 'session-title')
  ledger.markRunning(task.taskId)
  const row = boardOf(ledger.list(), 1).rows[0]
  assert.equal(row.title, '今天几号')
  assert.ok(row.sub.includes('个人助手'), '项目名要留在副行')
  // 项目名是更长卡名的前缀时不能误删（青年基金 vs 青年基金申请书）。
  const longer = ledger.add({ title: '青年基金申请书 改写第 3 段', projectId: 'p2', projectName: '青年基金' })
  assert.equal(boardTitleOf(longer), '青年基金申请书 改写第 3 段')
})

test('待决策＝托管没开：带问题、选项、默认项、截止时刻', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: 'x', projectId: 'p1', projectName: 'P', now: 1000 })
  ledger.attachSession(task.taskId, 'session-b', 1000)
  ledger.ask(task.taskId, { question: '删掉 3 个旧结果文件？', options: ['确认删除', '先留着，别删'], defaultIndex: 1, timeoutMs: 60_000, now: 2000 })
  assert.equal(task.state, 'awaiting')
  assert.equal(task.question, '删掉 3 个旧结果文件？')
  assert.equal(task.options.length, 2)
  assert.equal(task.defaultIndex, 1)
  assert.equal(task.decisionDeadline, 62_000)
  assert.equal(capsuleOf(task.state), '待决策')
  // 待决策行不显示时长环，给琥珀问号徽标
  const row = boardOf(ledger.list(), 3000).rows[0]
  assert.equal(row.badge, 'ask')
  assert.equal(row.ring.tone, 'empty')
})

test('回答了（人点/口头/60 秒到点走默认）回到执行中并记下谁拍的板', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: 'x', projectId: 'p1', projectName: 'P' })
  ledger.attachSession(task.taskId, 'session-c')
  ledger.ask(task.taskId, { question: 'q', options: ['a', 'b'], defaultIndex: 0, timeoutMs: 60_000 })
  ledger.answer(task.taskId, '设备 60 秒超时 · 默认项')
  assert.equal(task.state, 'running')
  assert.equal(task.answeredBy, '设备 60 秒超时 · 默认项')
  assert.equal(task.question, undefined)
  assert.equal(task.options, undefined)
})

test('完成写一行结果；完成后不会被迟到的「开始跑」拉回去', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: 'x', projectId: 'p1', projectName: 'P', now: 1000 })
  ledger.attachSession(task.taskId, 'session-d', 1000)
  ledger.complete(task.taskId, { resultLine: '第 3 段改写完成', now: 5000 })
  assert.equal(task.state, 'done')
  assert.equal(task.resultLine, '第 3 段改写完成')
  assert.equal(task.finishedAt, 5000)
  ledger.markRunning(task.taskId, 6000)
  assert.equal(task.state, 'done', '完成是终态，迟到事件不能倒回去')
  assert.deepEqual(ringOf(task, 9000), { percent: 1, tone: 'done' })
})

/* ---------- 棋盘投影 ---------- */

test('棋盘排序：待决策 → 所有执行中 → 其余按时间；同项目有待决策时整个项目优先', () => {
  const ledger = new TaskLedger()
  // 故意让「等你的」时间最旧：它仍然排第一。
  const asking = ledger.add({ title: '等你的', projectId: 'p1', projectName: 'A', now: 500 })
  const running = ledger.add({ title: '跑着的', projectId: 'p2', projectName: 'B', now: 1000 })
  const done = ledger.add({ title: '完成的', projectId: 'p3', projectName: 'C', now: 5000 })
  const queued = ledger.add({ title: '排队的', projectId: 'p4', projectName: 'D', now: 2000 })
  ledger.complete(done.taskId, { resultLine: '好了', now: 5000 })
  ledger.attachSession(running.taskId, 'session-r')
  ledger.markRunning(running.taskId, 1000)
  ledger.attachSession(asking.taskId, 'session-a')
  ledger.ask(asking.taskId, { question: 'q', options: ['a', 'b'], defaultIndex: 0, timeoutMs: 60_000, now: 600 })
  assert.deepEqual(
    boardOf(ledger.list(), 10_000).rows.map((row) => row.taskId),
    [asking.taskId, running.taskId, done.taskId, queued.taskId],
    '待决策最前；执行中第二；其余按时间倒序（完成比排队新）',
  )

  // 项目优先：A 项目里有一条在等你，同项目的另一条执行中要排到别的项目的执行中前面。
  const project = new TaskLedger()
  const askB = project.add({ title: 'B 等你', projectId: 'pb', projectName: 'B', now: 900 })
  const runA = project.add({ title: 'A 在跑（旧）', projectId: 'pa', projectName: 'A', now: 100 })
  const runB = project.add({ title: 'B 在跑（新）', projectId: 'pb', projectName: 'B', now: 800 })
  project.attachSession(askB.taskId, 's-ask-b')
  project.attachSession(runA.taskId, 's-run-a')
  project.attachSession(runB.taskId, 's-run-b')
  project.markRunning(runA.taskId, 100)
  project.markRunning(runB.taskId, 800)
  project.ask(askB.taskId, { question: 'q', options: ['a'], defaultIndex: 0, timeoutMs: 60_000, now: 900 })
  assert.deepEqual(
    boardOf(project.list(), 10_000).rows.map((row) => row.taskId),
    [askB.taskId, runB.taskId, runA.taskId],
    '同项目（B）有待决策 → 整个 B 项目的任务优先；A 的执行中排在后面',
  )
})

test('一条任务一张卡：同项目同状态不再折叠成「+N 条」', () => {
  const ledger = new TaskLedger()
  const a1 = ledger.add({ title: 'A1', projectId: 'pa', projectName: 'A', now: 1000 })
  const a2 = ledger.add({ title: 'A2', projectId: 'pa', projectName: 'A', now: 2000 })
  const b1 = ledger.add({ title: 'B1', projectId: 'pb', projectName: 'B', now: 3000 })
  for (const task of [a1, a2, b1]) ledger.attachSession(task.taskId, `s-${task.taskId}`)
  const board = boardOf(ledger.list(), 10)
  assert.equal(board.rows.length, 3, '三条任务就是三张卡')
  assert.deepEqual(new Set(board.rows.map((row) => row.taskId)), new Set([a1.taskId, a2.taskId, b1.taskId]))
  for (const row of board.rows) assert.equal('merged' in row, false, '不再出现 +N 条合并字段')
})

test('子代理还在跑：任务保持执行中并带子任务计数；全部结束才允许完成', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '主会话', projectId: 'p', projectName: 'P', now: 1000 })
  ledger.attachSession(task.taskId, 's-main')
  ledger.markRunning(task.taskId, 1000)
  ledger.holdForChildren(task.taskId, { childRunning: 2, resultLine: '主回合结论', now: 2000 })
  assert.equal(task.state, 'running', '子任务在跑 ⇒ 不算完成')
  assert.equal(isFinishedState(task.state), false)
  const row = boardOf(ledger.list(), 3000).rows[0]
  assert.equal(row.subagents, 2, '棋盘行带子任务数（页面画蓝色呼吸点）')
  assert.equal(row.blink, true, '子任务在跑 ⇒ blink=true')
  assert.equal(row.capsule, '执行中')
  assert.equal(row.state, 'running')

  ledger.setChildRunning(task.taskId, 0, 4000)
  ledger.complete(task.taskId, { resultLine: '主回合结论', now: 4500 })
  const doneRow = boardOf(ledger.list(), 5000).rows[0]
  assert.equal(doneRow.state, 'done')
  assert.equal(doneRow.subagents, undefined, '子任务清零后不再画呼吸点')
  assert.equal(doneRow.blink, undefined, '子任务清零后 blink 消失（绿色实心圆）')
  assert.equal(task.holdingForChildren, undefined)
})

test('顶行四段计数：等你/在跑/排队/完成都在（空盘四段归零）', () => {
  const ledger = new TaskLedger()
  const a = ledger.add({ title: 'a', projectId: '1', projectName: '1' })
  const b = ledger.add({ title: 'b', projectId: '2', projectName: '2' })
  const c = ledger.add({ title: 'c', projectId: '3', projectName: '3' })
  const d = ledger.add({ title: 'd', projectId: '4', projectName: '4' })
  ledger.attachSession(a.taskId, 'sa')
  ledger.markRunning(a.taskId)
  ledger.attachSession(b.taskId, 'sb')
  ledger.ask(b.taskId, { question: 'q', options: ['x', 'y'], defaultIndex: 0, timeoutMs: 60_000 })
  ledger.complete(d.taskId, { resultLine: 'ok' })
  assert.deepEqual(countsOf(ledger.list()), { running: 1, awaiting: 1, queued: 1, done: 1 })
  assert.equal(ledger.list().length, 4)
})

test('没有任务 = 同一版式的空态（empty=true，不是另一屏）', () => {
  const ledger = new TaskLedger()
  const board = boardOf(ledger.list(), 1)
  assert.equal(board.empty, true)
  assert.deepEqual(board.rows, [])
  assert.deepEqual(board.counts, { running: 0, awaiting: 0, queued: 0, done: 0 })
  assert.deepEqual(board.page, { index: 0, total: 1 })
  const frame = boardFrame(board)
  assert.equal(frame.mode, 'home')
  assert.equal(frame.board.empty, true)
  assert.equal(frame.tone, 'idle')
})

test(`棋盘每页 ${BOARD_PAGE_SIZE} 行，页码越界自动夹住`, () => {
  const ledger = new TaskLedger()
  for (let i = 0; i < 7; i += 1) ledger.add({ title: `task-${i}`, projectId: `p${i}`, projectName: `P${i}` })
  assert.equal(boardOf(ledger.list(), 1, 0).rows.length, BOARD_PAGE_SIZE)
  assert.equal(boardOf(ledger.list(), 1, 0).page.total, 2)
  assert.equal(boardOf(ledger.list(), 1, 2).page.index, 1, '越界夹到最后一页')
  assert.equal(boardOf(ledger.list(), 1, 2).rows.length, 3)
})

test('时长环：满圈 30 分钟，超过继续满圈但转琥珀；排队空环', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: 'x', projectId: 'p', projectName: 'P', now: 0 })
  ledger.attachSession(task.taskId, 's', 0)
  ledger.markRunning(task.taskId, 0)
  assert.deepEqual(ringOf(task, 0), { percent: 0, tone: 'normal' })
  assert.equal(ringOf(task, RING_FULL_MS / 2).percent, 0.5)
  const late = ringOf(task, RING_FULL_MS * 2)
  assert.equal(late.percent, 1)
  assert.equal(late.tone, 'warn')
})

test('内存上限：超了先归档最老的完成态，会话不删', () => {
  const ledger = new TaskLedger()
  const first = ledger.add({ title: 'old', projectId: 'p', projectName: 'P', now: 0 })
  ledger.attachSession(first.taskId, 'session-keep', 0)
  ledger.complete(first.taskId, { resultLine: 'ok', now: 1 })
  // 手动把它挪到很久以前，触发 DONE_KEEP_MS 归档
  first.finishedAt = 0
  ledger.prune(DONE_KEEP_MS + 10)
  assert.equal(first.state, 'archived')
  assert.deepEqual(first.sessionIds, ['session-keep'], '归档不动会话')
})

test('自动归档也要落 journal 一行（不能悄悄丢）', () => {
  const lines = []
  const ledger = new TaskLedger((line) => lines.push(line))
  const task = ledger.add({ title: '老任务', projectId: 'p', projectName: 'P', now: 0 })
  ledger.complete(task.taskId, { resultLine: '做完了', now: 1 })
  task.finishedAt = 0
  ledger.prune(DONE_KEEP_MS + 10)
  assert.equal(lines.length, 1, '自动归档要写一行')
  assert.ok(lines[0].includes('[t1] 老任务'))
  assert.equal(ledger.archive(task.taskId), undefined, '再手动归档不许写第二行')
  assert.equal(lines.length, 1)
})

/* ---------- 归档 / journal ---------- */

test('归档只写一行 journal、只写一次；任务移出棋盘', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '改写第 3 段', projectId: 'p1', projectName: '青年基金申请书', now: 0 })
  ledger.attachSession(task.taskId, 'session-98bb83cb-ffff', 0)
  ledger.complete(task.taskId, { resultLine: '第 3 段改写完成', now: 83_000 })
  const line = ledger.archive(task.taskId)
  assert.ok(line !== undefined && line.includes('[t1] 改写第 3 段'))
  assert.ok(line.includes('青年基金申请书'))
  assert.ok(line.includes('98bb83cb'))
  assert.ok(line.includes('1m23s'), `要写用时：${line}`)
  assert.ok(line.includes('第 3 段改写完成'))
  assert.equal(ledger.archive(task.taskId), undefined, '不重复写')
  assert.equal(boardOf(ledger.list(), 100).rows.length, 0)
})

test('journal 行带上「谁拍的板」', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: 'x', projectId: 'p', projectName: 'P', now: 0 })
  ledger.attachSession(task.taskId, 's', 0)
  ledger.ask(task.taskId, { question: 'q', options: ['a', 'b'], defaultIndex: 0, timeoutMs: 60_000 })
  ledger.answer(task.taskId, '设备点选')
  ledger.complete(task.taskId, { resultLine: 'ok', now: 1000 })
  assert.ok(journalLineOf(task, 1000).includes('设备点选'))
})

test('用时格式：秒 / 分秒 / 时分', () => {
  assert.equal(formatUsedMs(0), '0s')
  assert.equal(formatUsedMs(45_000), '45s')
  assert.equal(formatUsedMs(83_000), '1m23s')
  assert.equal(formatUsedMs(3_900_000), '1h05m')
})

/* ---------- 播报总线 ---------- */

test('P3 进度永远不播', () => {
  const bus = new TaskNotifyBus()
  bus.push(3, 't1', '第 7 步', 0)
  assert.equal(bus.pending(), 0)
  assert.equal(bus.take(0), undefined)
})

test('只有一条：过了单条延迟立刻念', () => {
  const bus = new TaskNotifyBus()
  bus.push(1, 't1', '基金稿改完', 0)
  assert.equal(bus.take(0), undefined, '刚到就念会把同一秒的其它完成拆散')
  const got = bus.take(ANNOUNCE_SINGLE_DELAY_MS)
  assert.deepEqual(got, { level: 1, taskIds: ['t1'], text: '基金稿改完' })
  assert.equal(bus.pending(), 0)
})

test('多条：八秒窗口内压成一句只念一次', () => {
  const bus = new TaskNotifyBus()
  bus.push(1, 't1', '基金稿改完', 0)
  bus.push(1, 't2', '磷石膏出图', 1000)
  assert.equal(bus.take(4000), undefined, '窗口没到不乱念')
  const got = bus.take(ANNOUNCE_WINDOW_MS)
  assert.ok(got !== undefined)
  assert.deepEqual(got.taskIds, ['t1', 't2'])
  assert.equal(got.text, '两件事完了：基金稿改完、磷石膏出图')
  assert.equal(bus.pending(), 0)
})

test('P0 插队：不等窗口，立即念', () => {
  const bus = new TaskNotifyBus()
  bus.push(1, 't1', '基金稿改完', 0)
  bus.push(0, 't2', '要你确认删除', 10)
  const got = bus.take(20)
  assert.deepEqual(got, { level: 0, taskIds: ['t2'], text: '要你确认删除' })
  assert.equal(bus.pending(), 1, 'P1 还留在队里')
})

test('合并措辞：一到三件事，超过三件说「等」', () => {
  assert.equal(mergeAnnouncements([]), '')
  assert.equal(mergeAnnouncements([{ text: 'A', level: 1 }]), 'A')
  assert.equal(mergeAnnouncements([{ text: 'A', level: 1 }, { text: 'B', level: 1 }]), '两件事完了：A、B')
  assert.equal(mergeAnnouncements([{ text: 'A', level: 1 }, { text: 'B', level: 1 }, { text: 'C', level: 1 }]), '三件事完了：A、B、C')
  assert.equal(
    mergeAnnouncements([{ text: 'A', level: 1 }, { text: 'B', level: 1 }, { text: 'C', level: 1 }, { text: 'D', level: 1 }]),
    '4 件事完了：A、B、C等',
  )
  assert.equal(mergeAnnouncements([{ text: 'A', level: 2 }, { text: 'B', level: 2 }]), 'A；B', '里程碑不套「几件事完了」')
})

test('nextAt：给调用方挂定时器用，不用轮询', () => {
  const bus = new TaskNotifyBus()
  assert.equal(bus.nextAt(), undefined)
  bus.push(1, 't1', 'A', 1000)
  assert.equal(bus.nextAt(), 1000 + ANNOUNCE_SINGLE_DELAY_MS)
  bus.push(1, 't2', 'B', 1200)
  assert.equal(bus.nextAt(), 1000 + ANNOUNCE_WINDOW_MS)
})

/* ---------- 派单路由 ---------- */

const CARDS = [
  { id: 'c-fund', name: '青年基金申请书', folder: 'D:/proj/青年基金2027' },
  { id: 'c-lin', name: '磷石膏SCI', folder: 'D:/proj/lin-shigao' },
  { id: 'wt-assistant', name: '个人助手', folder: 'C:/Users/chen/.dsh/assistant' },
]

test('点名项目卡 → 派给它（整名命中优先于片段命中）', () => {
  const route = routeQuick({ text: '把青年基金申请书第 3 段再改一遍，要有数据支撑', cards: CARDS, tasks: [] })
  assert.equal(route.kind, 'card')
  assert.equal(route.card.id, 'c-fund')
})

test('同一项目「接着」说 → 追加到已有任务，不新建', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '改写第 3 段', projectId: 'c-fund', projectName: '青年基金申请书' })
  ledger.attachSession(task.taskId, 's1')
  const route = routeQuick({ text: '接着把参考文献也补一下，要最新的三篇', cards: CARDS, tasks: ledger.list() })
  assert.equal(route.kind, 'append')
  assert.equal(route.task.taskId, task.taskId)
})

test('日常小事 → 个人助手（与长按悬浮球同一个文件夹）', () => {
  assert.equal(routeQuick({ text: '现在几点了', cards: CARDS, tasks: [] }).kind, 'daily')
  assert.equal(routeQuick({ text: '帮我查一下明天武汉天气', cards: CARDS, tasks: [] }).kind, 'daily')
  assert.equal(looksSimpleTask('这篇论文的摘要润色一下'), false, '要产出东西的不算日常')
})

test('两个卡名都点到 → 追问（屏 7），绝不猜', () => {
  const route = routeQuick({ text: '把青年基金申请书和磷石膏SCI都整理一下投出去', cards: CARDS, tasks: [] })
  assert.equal(route.kind, 'ambiguous')
  assert.equal(route.candidates.length, 2)
})

test('什么都不像 → 快路径放弃，交给慢路径', () => {
  const route = routeQuick({ text: '这个事儿你看着办，弄完告诉我', cards: CARDS, tasks: [] })
  assert.equal(route.kind, 'none')
})

test('超时兜底：取最佳匹配卡（片段也算），一张都不像/两张同分则不猜', () => {
  assert.equal(bestCardMatchOf('基金那边再改改', CARDS)?.id, 'c-fund', '片段命中也要取出来')
  assert.equal(bestCardMatchOf('把今天要做的三件事整理成清单', CARDS), undefined, '没有任何卡片相似 → 不猜')
  const tied = [
    { id: 'c-a', name: '青椒', folder: '' },
    { id: 'c-b', name: '辣椒', folder: '' },
  ]
  assert.equal(bestCardMatchOf('青椒和辣椒都要买', tied), undefined, '两张卡同分就不猜（宁可说没听清）')
})

test('别名打分：整名 > 片段；公共片段按字长给分', () => {
  assert.ok(scoreCardAlias('青年基金申请书', CARDS[0]).score >= 100)
  assert.ok(scoreCardAlias('基金那边', CARDS[0]).score > 0)
  assert.equal(scoreCardAlias('完全无关的一句话', CARDS[1]).score, 0)
  assert.equal(longestCommonRun('青年基金', '青年基金申请书'), 4)
})

test('整名优先：点名 dsh-assistant 不被 assistant 文件夹误判成歧义', () => {
  const cards = [
    { id: 'c-dsh', name: 'dsh-assistant', folder: 'D:/dsh-assistant' },
    { id: 'wt-assistant', name: '个人助手', folder: 'C:/Users/chen/.dsh/assistant' },
    { id: 'c-hpg', name: 'HPG', folder: 'D:/hpg' },
  ]
  assert.equal(scoreCardAlias('dsh-assistant', cards[0]).via, 'name')
  assert.equal(scoreCardAlias('dsh-assistant', cards[1]).via, 'folder')
  const route = routeQuick({ text: 'dsh-assistant 用 pwsh 删掉临时文件', cards, tasks: [] })
  assert.equal(route.kind, 'card')
  assert.equal(route.card.id, 'c-dsh')
})

test('两个整名 → 屏 7 候选保留 HPG，不被个人助手挤掉', () => {
  const cards = [
    { id: 'c-dsh', name: 'dsh-assistant', folder: 'D:/dsh-assistant' },
    { id: 'wt-assistant', name: '个人助手', folder: 'C:/Users/chen/.dsh/assistant' },
    { id: 'c-hpg', name: 'HPG', folder: 'D:/hpg' },
  ]
  const route = routeQuick({ text: 'dsh-assistant 和 HPG 都看一下', cards, tasks: [] })
  assert.equal(route.kind, 'ambiguous')
  assert.deepEqual(route.candidates.map((card) => card.id), ['c-dsh', 'c-hpg'])
})

test('文件夹兜底按顺序取第一个非空', () => {
  assert.equal(firstFolderOf([undefined, '', 'D:/a']), 'D:/a')
  assert.equal(firstFolderOf([undefined, '']), undefined)
})

/* ---------- 会话衔接（派单第二步：接着旧会话还是新建） ---------- */

/** 造一条 CU 会话候选；`minutesAgo` 默认 5 分钟前动过。 */
function cuSession(sessionId, title, options = {}) {
  const { minutesAgo = 5, summary } = options
  return {
    sessionId,
    title,
    ...(summary === undefined ? {} : { summary }),
    updatedAt: Date.now() - minutesAgo * 60_000,
  }
}

const CONTEXT_NOW = Date.now()

test('会话衔接：没有指代词、只靠内容重合也判为追加（指代词不是开关）', () => {
  const text = '引言第三段压缩到八百字，数据核对一遍'
  const sessions = [cuSession('s-fund', '青年基金申请书引言第三段压缩与数据核对')]
  const decision = continuityOf({ text, sessions, now: CONTEXT_NOW, projectHints: ['青年基金申请书'] })
  assert.equal(continuityCueScore(text), 0, '这句话里没有任何指代/续写词')
  assert.equal(decision.kind, 'append')
  assert.equal(decision.sessionId, 's-fund')
  assert.ok(decision.confidence >= 0.54, `内容够像就该直接续：${decision.confidence}`)
})

test('会话衔接：指代词本身不构成追加（内容无关时最多到灰区）', () => {
  const sessions = [cuSession('s-fund', '青年基金申请书引言第三段压缩')]
  const unrelated = continuityOf({ text: '青年基金申请书预算表按新模板重算', sessions, now: CONTEXT_NOW, projectHints: ['青年基金申请书'] })
  assert.equal(unrelated.kind, 'new', '同一个项目但不是同一件事 → 新建')
  const pronounOnly = continuityOf({ text: '接着把青年基金申请书那个再改一下', sessions, now: CONTEXT_NOW, projectHints: ['青年基金申请书'] })
  assert.notEqual(pronounOnly.kind, 'append', '光说「接着那个」不能硬塞给旧会话')
  assert.equal(pronounOnly.kind, 'gray', '指代只能把结论推到灰区，交给下一步判')
})

test('会话衔接：完全不相关直接新建；没有 CU 会话也新建', () => {
  const weather = [cuSession('s-weather', '武汉天气查询')]
  assert.equal(continuityOf({ text: '帮我订个明天的会议室', sessions: weather, now: CONTEXT_NOW, projectHints: ['个人助手'] }).kind, 'new')
  assert.equal(continuityOf({ text: '随便说点什么', sessions: [], now: CONTEXT_NOW }).kind, 'new')
  assert.equal(continuityOf({ text: '', sessions: weather, now: CONTEXT_NOW }).kind, 'new')
})

test('会话衔接：两个候选分太近不猜（灰区），旧的会话时间分自然下降', () => {
  const sessions = [
    cuSession('s-a', '青年基金申请书引言第三段压缩', { minutesAgo: 3 }),
    cuSession('s-b', '青年基金申请书引言第三段压缩', { minutesAgo: 4 }),
  ]
  const decision = continuityOf({ text: '青年基金申请书引言第三段压缩到八百字', sessions, now: CONTEXT_NOW, projectHints: ['青年基金申请书'] })
  assert.equal(decision.kind, 'gray')
  assert.ok(decision.sessionId !== undefined, '灰区也要带最像的那条（澄清屏要显示它的名字）')
  assert.ok(continuityTimeScore(CONTEXT_NOW - 60_000, CONTEXT_NOW) > continuityTimeScore(CONTEXT_NOW - 3 * 86_400_000, CONTEXT_NOW))
  assert.ok(continuityAffinityOf('引言第三段压缩', '青年基金申请书引言第三段压缩') > 0.5)
  assert.equal(continuityAffinityOf('帮我订会议室', '青年基金申请书引言修改'), 0)
})

/* ---------- 2026-11-10 实机：承接优先于项目命中（跨项目也接） ---------- */

test('上一条派单会话：README 的两句续读都过线（不靠指代词），明显矛盾才新建', () => {
  const previous = cuSession('s-readme', '帮我把 README 的前两行读出来', { minutesAgo: 1 })
  const next = previousSessionFollowUpOf({ text: '再读一下后两行', previous, now: CONTEXT_NOW })
  assert.ok(next !== undefined)
  assert.equal(next.follow, true, '「再读一下后两行」明显接着上一条 README：' + JSON.stringify(next))
  assert.equal(next.sessionId, 's-readme')
  assert.ok(next.confidence >= 0.3 && next.confidence < 0.54, '分数在「上一条」线之上、同项目 append 线之下：' + next.confidence)

  const third = previousSessionFollowUpOf({ text: '这次只读最后一行', previous, now: CONTEXT_NOW })
  assert.equal(third?.follow, true, '第三句仍接着同一条：' + JSON.stringify(third))

  const unrelated = previousSessionFollowUpOf({ text: '把论文图表重画', previous, now: CONTEXT_NOW })
  assert.equal(unrelated?.follow, false, '上一句在读 README、这句要重画图表 → 语义明显矛盾，新建：' + JSON.stringify(unrelated))
  assert.equal(previousSessionFollowUpOf({ text: '帮我订个明天的会议室', previous, now: CONTEXT_NOW })?.follow, false)

  assert.equal(previousSessionFollowUpOf({ text: '再读一下后两行', previous: undefined, now: CONTEXT_NOW }), undefined, '没有上一条就没什么可接')
  assert.equal(previousSessionFollowUpOf({ text: '', previous, now: CONTEXT_NOW }), undefined)
})

test('上一条派单会话：项目名先剔掉，不会因为「同一个项目」就算同一件事', () => {
  const previous = cuSession('s-fund', '青年基金申请书引言第三段压缩', { minutesAgo: 1 })
  const sameProject = previousSessionFollowUpOf({ text: '青年基金申请书预算表按新模板重算', previous, now: CONTEXT_NOW, projectHints: ['青年基金申请书'] })
  assert.equal(sameProject?.follow, false, '同项目另一件事不该被吸进上一条会话：' + JSON.stringify(sameProject))
})

test('低置信项目命中：只是 fragment / 置信 <0.3 不许单独定落点', () => {
  const cards = [
    { id: 'c-gypsum', name: '磷石膏SCI' },
    { id: 'c-fund', name: '青年基金申请书' },
  ]
  // 2 字片段「石膏」→ 20 分 → 置信 0.2：只是线索。
  const weak = routeQuick({ text: '把石膏板的吸水率试验数据整理一下', cards, tasks: [] })
  assert.equal(weak.kind, 'card')
  assert.equal(weak.via, 'fragment')
  assert.ok(weak.confidence < 0.3, `2 字片段置信必须 <0.3：${weak.confidence}`)
  assert.equal(isConfidentProjectRoute(weak), false)
  // 4 字片段（0.4）照样不算数：fragment 一律不许单独定项目。
  const longer = routeQuick({ text: '青年基金预算表按新模板重算', cards, tasks: [] })
  assert.equal(longer.kind, 'card')
  assert.equal(longer.via, 'fragment')
  assert.ok(longer.confidence >= 0.3, `4 字片段置信 0.4：${longer.confidence}`)
  assert.equal(isConfidentProjectRoute(longer), false)
  // 整名点名才是确定命中。
  const strong = routeQuick({ text: '把磷石膏SCI的吸水率试验数据整理一下', cards, tasks: [] })
  assert.equal(strong.kind, 'card')
  assert.equal(strong.via, 'name')
  assert.equal(strong.confidence, 1)
  assert.equal(isConfidentProjectRoute(strong), true)
  assert.equal(projectMatchConfidenceOf(20, 'fragment'), 0.2)
  assert.equal(projectMatchConfidenceOf(30, 'fragment'), 0.3)
  assert.equal(projectMatchConfidenceOf(120, 'name'), 1)
})

/* ---------- 口头命令 ---------- */

test('口头命令：回棋盘 / 看任务 / 停止 / 撤单 / 确认 / 拒绝', () => {
  assert.deepEqual(parseScreenCommand('回棋盘'), { kind: 'board' })
  assert.deepEqual(parseScreenCommand('主页'), { kind: 'board' })
  assert.deepEqual(parseScreenCommand('停止'), { kind: 'stop' })
  assert.deepEqual(parseScreenCommand('撤单'), { kind: 'cancel' })
  assert.deepEqual(parseScreenCommand('确认'), { kind: 'confirm', approved: true })
  assert.deepEqual(parseScreenCommand('先留着'), { kind: 'confirm', approved: false })
  assert.deepEqual(parseScreenCommand('看第 2 条'), { kind: 'open', index: 2 })
  assert.deepEqual(parseScreenCommand('第二条'), { kind: 'pick', index: 2 })
})

test('任务句里带「确认」不算命令（否则会把任务吞掉）', () => {
  assert.equal(parseScreenCommand('确认一下这个基金的预算表有没有算错'), undefined)
  assert.equal(parseScreenCommand('把取消掉的三个文件恢复回来'), undefined)
})

test('带唤醒词的口头命令：先剥「你好，鹈鹕」再判命令', () => {
  assert.equal(stripWakeWord('你好，鹈鹕'), '')
  assert.equal(stripWakeWord('你好鹈鹕'), '')
  assert.equal(stripWakeWord('你好，鹈鹕，帮我查一下明天的课'), '帮我查一下明天的课')
  assert.equal(stripWakeWord('回棋盘'), '回棋盘')
  assert.equal(stripWakeWord('鹈鹕能吃吗'), '能吃吗')
  assert.deepEqual(parseScreenCommand('你好，鹈鹕回棋盘'), { kind: 'board' })
  assert.deepEqual(parseScreenCommand('你好鹈鹕，回棋盘'), { kind: 'board' })
  assert.deepEqual(parseScreenCommand('嗨鹈鹕看第 2 条'), { kind: 'open', index: 2 })
  assert.deepEqual(parseScreenCommand('鹈鹕停止'), { kind: 'stop' })
  // 正文里的「鹈鹕」不是唤醒词：剥不出命令就按原文当任务。
  assert.equal(parseScreenCommand('鹈鹕是什么'), undefined)
})

test('中文序号', () => {
  assert.equal(chineseIndex('一'), 1)
  assert.equal(chineseIndex('第3条'), 3)
  assert.equal(chineseIndex('九个'), 9)
  assert.equal(chineseIndex('春眠不觉晓'), undefined)
})

/* ---------- 屏版式 ---------- */

test('标题规范化：去标点、超长省略、空句给占位', () => {
  assert.equal(taskTitleOf('  改写第 3 段。 '), '改写第 3 段')
  assert.equal(taskTitleOf(''), '这条任务')
  assert.equal([...taskTitleOf('一二三四五六七八九十一二三四五六七八九十')].length, 18)
})

test(`正文不超过 ${SCREEN_SPEC.maxBodyLines} 行、每行不超屏宽（fitScreenLines 兜底）`, () => {
  const frame = receiptFrame({ taskId: 't1', projectName: '青年基金申请书', folder: 'D:/proj/青年基金2027', queueAhead: 2, etaText: '1 分钟' })
  assert.ok(frame.bullets.length <= SCREEN_SPEC.maxBodyLines)
  for (const line of frame.bullets) assert.ok(fitScreenLines([line], 1).length === 1, `这一行放得下：${line}`)
})

test('派单回执（屏 2）：三拍圆点 + 文件夹 + 倒计时 + 两个键', () => {
  const frame = receiptFrame({ taskId: 't2', projectName: '青年基金申请书', folder: 'D:/proj/青年基金2027', queueAhead: 2, etaText: '1 分钟' })
  assert.equal(frame.stage, '派单')
  assert.equal(frame.title, '已派给 青年基金申请书')
  assert.deepEqual(frame.steps.map((step) => step.label), ['已入队', '排队 2 个', '开始跑'])
  assert.deepEqual(frame.steps.map((step) => step.state), ['done', 'active', 'pending'])
  assert.ok(frame.bullets.some((line) => line.includes('青年基金2027')), '要看得清落在哪个文件夹')
  assert.equal(frame.bullets.filter((line) => line.includes('青年基金申请书')).length, 0, '标题说过了，正文不再重复项目名')
  assert.equal(frame.countdown.seconds, RECEIPT_SECONDS)
  assert.deepEqual(frame.actions.map((item) => item.label), ['看任务', '撤单'])
  assert.equal(frame.taskId, 't2')
})

test('派单回执：没有排队时第三拍是「开始跑」', () => {
  const frame = receiptFrame({ taskId: 't3', projectName: 'A', folder: undefined, queueAhead: 0 })
  assert.deepEqual(frame.steps.map((step) => step.state), ['done', 'done', 'active'])
  assert.ok(frame.bullets.includes('马上开始跑'))
})

test('任务详情（屏 4）：大标题是任务名，正文只留最新状态 + 步数/已用 + 统计', () => {
  const frame = detailFrame({
    taskId: 't4',
    title: '改写第 3 段',
    liveLine: '工具调用 · click · {"position":{"x":40,"y":60}}',
    step: 7,
    elapsedMs: 83_000,
    statsLine: '82 tok/s · 12.3k tok · 上下文 41%',
  })
  assert.equal(frame.stage, '进度')
  assert.equal(frame.title, '改写第 3 段')
  assert.equal(frame.bullets.length, 3, '最新状态 / 步数用时 / 统计：' + JSON.stringify(frame.bullets))
  assert.ok(frame.bullets[0].startsWith('工具调用 · click · {"position"'), '最新状态原样保留：' + frame.bullets[0])
  assert.equal(frame.bullets[1], '第 7 步 · 已用 1m23s')
  assert.ok(frame.bullets[2].includes('82 tok/s'))
  assert.equal(frame.statsTail, 1)
  assert.deepEqual(frame.actions.map((item) => item.label), ['停止', '主页'])
})

test('任务详情（屏 4）：回合结束后改「第 N 步 · 已结束」，不再显示会增长的「已用」', () => {
  const frame = detailFrame({
    taskId: 't4c',
    title: 'ESP32 语音助手起点版',
    liveLine: '',
    step: 20,
    elapsedMs: 208_000,
    statsLine: '156 tok/s · 12.3k tok · 上下文 41%',
    ended: true,
  })
  assert.equal(frame.stage, '进度')
  assert.equal(frame.bullets[1], '第 20 步 · 已结束')
  assert.equal(frame.bullets.join(' ').includes('已用'), false, '已结束的进度页不许再显示「已用」')
  assert.ok(frame.bullets[0].includes('已结束'), '最新状态行也标结束：' + frame.bullets[0])
  assert.equal(frame.tone, 'ok')
})

test('任务详情：超长任务名一行省略（不折行挤掉正文）', () => {
  const frame = detailFrame({
    taskId: 't4b',
    title: 'ESP32语音助手“起点版”项目启动'.repeat(2),
    liveLine: '思考 · 想一下',
    step: 1,
    elapsedMs: 1000,
    statsLine: '',
  })
  assert.ok(measureTextPx(frame.title, SCREEN_SPEC.titleFontPx) <= CONTENT_WIDTH_PX, '标题按像素不超 304：' + frame.title)
  assert.ok(frame.title.endsWith('…'), '超长要省略')
})


test('完成页（屏 6）：大标题＝任务名，正文 7 行，另有 N 条进顶栏', () => {
  const single = doneFrame({ taskId: 't6', title: '今天几号', resultLine: '现在十七点三十一分', replyText: '现在十七点三十一分。', others: 0 })
  assert.equal(single.stage, '完成')
  assert.equal(single.title, '今天几号', '大标题必须是任务名，不是回答第一句')
  assert.deepEqual(single.actions.map((item) => item.label), ['停止', '重读', '主页'])
  assert.ok(Array.isArray(single.done.lines) && single.done.lines.length > 0, '正文行要随帧下发')
  assert.equal(single.more, undefined)
  const multi = doneFrame({ taskId: 't7', title: '设备联调', resultLine: '联调通过', replyText: '联调通过。', others: 2 })
  assert.deepEqual(multi.more, { count: 2, text: '另有 2 条' })
  assert.ok(multi.actions.some((item) => item.id === 'taskBoard'))
})

test('完成页正文：行首状态勾（✅/✓）要剥掉，只留整行青底黑字', () => {  const frame = doneFrame({
    taskId: 't8',
    title: '现在几点了',
    resultLine: '✅ 现在是 2026 年 11 月 10 日上午 9 点 31 分',
    replyText: '✅ 现在是 2026 年 11 月 10 日（星期一）上午 9 点 31 分。',
  })
  assert.ok(frame.done.lines.length > 0)
  assert.equal(frame.done.lines[0].startsWith('✅'), false, '青底行前面不许留勾：' + frame.done.lines[0])
  assert.equal(frame.done.lines[0].startsWith('现在是'), true, '正文从「现在是」开始：' + frame.done.lines[0])
  assert.equal(frame.done.lines.some((line) => /^[\s✅✓✔☑]/.test(line)), false, '每一行行首都不带勾')
  // 结果行（完成屏隐藏的 bullets）也一起剥，避免换屏时又冒出来。
  assert.equal(frame.bullets[0].startsWith('✅'), false)

  // 只剥行首：正文中间的勾（清单/表格）原样保留。
  const inline = doneFrame({ taskId: 't9', title: '清单', resultLine: '三项都通过 ✓', replyText: '三项都通过 ✓ 并已归档。' })
  assert.ok(inline.done.lines[0].includes('✓'), '正文中间的勾不动：' + inline.done.lines[0])
})

/* ---------- 2026-11-10：完成页正文/朗读的长路径缩写与 markdown 清理 ----------
 *
 * 实机现象：一条回复里的 Windows 长路径被原样折成 3 行塞进正文，朗读也整条念出来。
 * 规则：长路径只留「盘符/首段 + … + 文件名」，文件名本身还超长就只留（并折中）文件名；
 * 结果一律 ≤ 40 字符。正文和 TTS 共用 prepareDoneText，所以只需在这里钉死。
 */

const REAL_LONG_PATH = 'D:\\陈潘HBEU\\Desktop\\04：财务报销相关\\2026年11月参加武汉学术会议\\ICACHE2026_GNN_dPINN_ppt169_20261108\\exports\\ICACHE2026_GNN_dPINN_20261108_191807_native_charts_tables.pptx'

test('长路径缩写：盘符 + … + 文件名，结果不超过 40 字符', () => {
  const path = 'D:\\陈潘HBEU\\Desktop\\04：财务报销相关\\2026年11月参加武汉学术会议\\exports\\native_charts_tables.pptx'
  const short = abbreviatePath(path)
  assert.equal(short, 'D:\\…\\native_charts_tables.pptx', '只留盘符/首段 + 省略号 + 文件名：' + short)
  assert.ok([...short].length <= DONE_PATH_MAX_CHARS, '缩写后不超过 40 字符：' + [...short].length)
  assert.equal(short.includes('陈潘HBEU'), false, '中间目录不许留下来')
  // 短路径不动：看起来已经很短，再折反而更难读。
  assert.equal(abbreviatePath('D:\\dsh-assistant\\a.pptx'), 'D:\\dsh-assistant\\a.pptx', '短路径原样返回')
})

test('长路径缩写：文件名本身还超长时只留文件名（折中），仍守住 40 字符', () => {
  const short = abbreviatePath(REAL_LONG_PATH)
  assert.ok([...short].length <= DONE_PATH_MAX_CHARS, '仍超 40 字符：' + [...short].length + ' ' + short)
  assert.equal(short.includes('D:'), false, '文件名已经够长时不再带盘符：' + short)
  assert.equal(short.includes('陈潘HBEU'), false, '中间目录不许留下来')
  assert.ok(short.startsWith('ICACHE2026_GNN'), '保留可辨认的文件名前缀：' + short)
  assert.ok(short.endsWith('.pptx'), '扩展名优先保住：' + short)
  assert.ok(short.includes('…'), '折掉的中间用省略号：' + short)
  // 40 字符只是硬上限；15px 正文一行放不下时还要再收，否则实机仍会把 .pptx 折到下一行。
  assert.ok(measureTextPx(short, DONE_BODY_FONT_PX) <= DONE_BODY_TEXT_WIDTH_PX, '缩写后要能一行放下：' + short)
  // 已经缩写过的文本再跑一遍不变（prepareDoneText 会被正文/TTS 各调一次）。
  assert.equal(abbreviatePath(short), short, '缩写必须幂等')
  assert.equal(prepareDoneText(prepareDoneText(REAL_LONG_PATH)), prepareDoneText(REAL_LONG_PATH), '整份文本幂等')
})

test('长路径缩写：正斜杠 / UNC 各自保留自己的分隔符', () => {
  const slash = abbreviatePath('D:/proj/very/deep/folder/with/many/segments/native_charts_tables.pptx')
  assert.ok(slash.startsWith('D:/…/'), '正斜杠路径用 /：' + slash)
  assert.ok(slash.endsWith('native_charts_tables.pptx'))
  const unc = abbreviatePath('\\\\server\\share\\very\\deep\\folder\\with\\many\\segments\\native_charts_tables.pptx')
  assert.ok(unc.startsWith('\\\\server\\…\\'), 'UNC 保留 //server：' + unc)
})

test('完成页正文清掉 markdown 记号：**、`、#、- 列表符', () => {
  const raw = '## 结论\n- **报告**已导出：`D:\\proj\\out\\结果.pptx`\n- 第二项\n---\n> 引用一句'
  const clean = prepareDoneText(raw)
  assert.equal(clean.includes('**'), false, '粗体星号要清掉：' + clean)
  assert.equal(clean.includes('`'), false, '反引号要清掉：' + clean)
  assert.equal(clean.includes('#'), false, '标题 # 要清掉：' + clean)
  assert.equal(/^\s*[-*+]\s+/m.test(clean), false, '列表符要清掉：' + clean)
  assert.ok(clean.includes('结论'), '标题文字保留：' + clean)
  assert.ok(clean.includes('报告已导出'), '粗体文字保留：' + clean)
  assert.ok(clean.includes('结果.pptx'), '代码段里的文件名保留：' + clean)
  assert.equal(clean.includes('---'), false, '分隔线整行清掉：' + clean)
  assert.equal(clean.includes('>'), false, '引用符清掉：' + clean)
  // 只清行首标记：正文中间的 # 与 - 不能动（比如版本号/负号）。
  assert.equal(stripMarkdownMarks('温差 -0.12 ℃，Issue #42'), '温差 -0.12 ℃，Issue #42', '行中符号不动')
})

test('完成页帧：长路径在正文里已被缩写，行/区间/朗读仍是同一份文本', () => {
  const folderPath = 'D:\\陈潘HBEU\\Desktop\\04：财务报销相关\\2026年11月参加武汉学术会议\\exports\\native_charts_tables.pptx'
  const reply = '**已导出**：' + REAL_LONG_PATH + '。\n已同步到 ' + folderPath + '。\n请查收。'
  const frame = doneFrame({ taskId: 't9b', title: '导出 PPT', resultLine: '已导出', replyText: reply })
  const body = prepareDoneText(reply)
  assert.equal(body.includes('陈潘HBEU'), false, '正文里不该再出现完整路径')
  assert.equal(body.includes('**'), false, '正文里不该再出现 markdown')
  const joined = frame.done.lines.join('')
  assert.equal(joined.includes('陈潘HBEU'), false, '折行后也不许漏出长路径：' + joined)
  assert.equal(frame.done.ranges.length, frame.done.lines.length, '区间与行一一对应')
  const chars = [...body]
  for (const [start, end] of frame.done.ranges) assert.ok(end <= chars.length, '区间不得越界')
  // 缩写后的路径 token 本身不超过 40 字符（折行可能把它拆到两行，所以按整份文本量）。
  const tokens = body.match(/[A-Za-z]:[^\s，。；！？、）]*/g) ?? []
  assert.ok(tokens.length > 0, '正文里应还剩缩写后的路径')
  for (const token of tokens) assert.ok([...token].length <= DONE_PATH_MAX_CHARS, '路径 token 超长：' + token)
  // 文件名本身超长的那条只剩文件名开头，不能再带盘符/中间目录。
  assert.ok(body.includes('ICACHE2026_GNN'), '长文件名保留可辨认前缀：' + body)
  assert.ok(body.includes('D:\\…\\native_charts_tables.pptx'), '文件名短的路径保留盘符：' + body)
})

test('完成页大标题：20px 加粗仍单行省略，不换行不溢出', () => {
  const longTitle = '这个任务标题长得离谱以至于一行根本放不下必须省略号收住才行再长一点'
  const frame = doneFrame({ taskId: 't10', title: longTitle, resultLine: '好了', replyText: '好了。' })
  assert.ok(frame.title.endsWith('…'), '超长标题要省略：' + frame.title)
  assert.ok(measureTextPx(frame.title, DONE_TITLE_FONT_PX * 1.06) <= CONTENT_WIDTH_PX, '标题宽度不超 304：' + frame.title)
  assert.equal(frame.title.includes('\n'), false, '标题永远一行')
})

test('完成页：两行正文也放得下（行数按实际下发，不补空行）', () => {
  const frame = doneFrame({ taskId: 't11', title: '今天几号', resultLine: '十一月十日', replyText: '今天是十一月十日。明天是十一日。' })
  assert.ok(frame.done.lines.length >= 1)
  const lineHeight = 20
  assert.ok(frame.done.lines.length * lineHeight <= 7 * lineHeight, '正文行数不超 7 行窗口')
})

/* ---------- 2026-11-10：完成页高亮严格跟随真实播放（字符区间桥） ---------- */

test('完成页行字符区间：与行一一对应、单调、能按区间还原出整段正文', () => {
  const text = prepareDoneText('✅ 现在是 2026 年 11 月 10 日（星期一）上午 9 点 31 分。'
    + '温度场结果已收敛，跨中腹板温差 1.1 ℃，比目标 1.5 ℃ 还好。')
  const lines = doneLinesOf(text)
  const ranges = doneLineRangesOf(text)
  assert.equal(ranges.length, lines.length, '区间数必须等于行数：' + JSON.stringify(ranges))
  const chars = [...text]
  let cursor = 0
  for (let i = 0; i < ranges.length; i += 1) {
    const [start, end] = ranges[i]
    assert.ok(Number.isInteger(start) && Number.isInteger(end) && end > start, `第 ${i} 行区间非法：${start}-${end}`)
    assert.ok(start >= cursor, `第 ${i} 行区间必须单调（不重叠、不倒序）`)
    cursor = end
    const sliced = chars.slice(start, end).join('')
    const line = [...lines[i]].join('')
    // 折行只在空白处丢字符，所以切片去掉空白后必须等于该行
    assert.equal(sliced.replace(/\s+/g, ''), line.replace(/\s+/g, ''), `第 ${i} 行切片对不上正文：${sliced} vs ${line}`)
  }
})

test('完成页行字符区间：换行/首尾空白/行首勾都不影响（区间基于同一份朗读文本）', () => {
  const raw = '  \r\n✅ 第一句结束。\r\n第二句来了。\r\n  '
  const text = prepareDoneText(raw)
  assert.equal(text.startsWith('✅'), false, '准备阶段就去掉行首勾')
  assert.equal(text, '第一句结束。\n第二句来了。', '规范化后没有首尾空白与 CRLF：' + JSON.stringify(text))
  const ranges = doneLineRangesOf(raw)
  assert.ok(ranges.length >= 2, '两句话至少两行：' + JSON.stringify(ranges))
  const chars = [...prepareDoneText(raw)]
  for (const [start, end] of ranges) assert.ok(end <= chars.length, '区间不得越界')
})

test('完成页帧带 ranges：和 lines 一一对应，可直接驱动高亮', () => {
  const body = '现在是 2026 年 11 月 10 日上午 9 点 31 分。温度场结果已经收敛，跨中腹板温差 1.1 ℃。'
  const frame = doneFrame({ taskId: 't12', title: '现在几点了', resultLine: '九点半', replyText: body })
  const lines = frame.done.lines
  const ranges = frame.done.ranges
  assert.ok(Array.isArray(ranges), '完成帧必须带行字符区间')
  assert.equal(ranges.length, lines.length, '区间与行一一对应')
  const chars = [...prepareDoneText(body)]
  for (let i = 0; i < lines.length; i += 1) {
    const [start, end] = ranges[i]
    assert.ok(end - start >= [...lines[i]].length - 1, `第 ${i} 行区间太短：${end - start}`)
    assert.ok(start >= 0 && end <= chars.length, `第 ${i} 行区间越界`)
  }
  // 回退到一句话结果时，行和区间同样来自那一句（页面对不上时只是不切换，不会错行）。
  const fallbackFrame = doneFrame({ taskId: 't13', title: 'x', resultLine: '只有一句话', bullets: [] })
  assert.ok(fallbackFrame.done.lines.length > 0)
  if (fallbackFrame.done.ranges !== undefined) {
    assert.equal(fallbackFrame.done.ranges.length, fallbackFrame.done.lines.length, '回退正文的区间也要对齐')
  }
})

test('完成页：取不到回复时显示「（没有文字回复）」，绝不用任务标题冒充正文', () => {
  const title = '基于GNN与PINN的拓扑优化汇报PPT'
  const frame = doneFrame({ taskId: 't13b', title, resultLine: '', replyText: '' })
  assert.deepEqual(frame.done.lines, [DONE_NO_REPLY_TEXT], '没有回复就明说，不能拿标题凑')
  assert.ok(frame.title.startsWith('基于GNN'), '大标题仍是任务名：' + frame.title)
  assert.equal(frame.done.lines.some((line) => line.includes('GNN')), false, '正文里不许出现标题内容')
  const ranges = frame.done.ranges
  assert.ok(Array.isArray(ranges) && ranges.length === 1, '占位正文也要有可朗读的字符区间')
  assert.deepEqual(ranges[0], [0, [...DONE_NO_REPLY_TEXT].length], '区间覆盖整句占位文字')
})

test('歧义追问（屏 7）：两个候选 + 「都不是」，序号用数字', () => {
  const frame = askWhichFrame({ candidates: [{ projectName: '青年基金申请书', doing: '在改第 3 段' }, { projectName: '磷石膏SCI', doing: '在出图' }] })
  assert.equal(frame.stage, '追问')
  assert.equal(frame.title, '这句话派给谁？')
  assert.deepEqual(frame.bullets, ['1 青年基金申请书 · 在改第 3 段', '2 磷石膏SCI · 在出图'])
  assert.deepEqual(frame.actions.map((item) => item.label), ['1', '2', '都不是'])
})

test('完成播报的一句话：用任务标题，不念会话 id', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: '把磷石膏那组图重画', projectId: 'p', projectName: '磷石膏SCI' })
  ledger.complete(task.taskId, { resultLine: '三张图已更新' })
  assert.equal(doneAnnouncementOf(task), '把磷石膏那组图重画——三张图已更新')
  // 播报也不能整条念长路径：和完成页共用同一套清理。
  const withPath = ledger.add({ title: '导出 PPT', projectId: 'p', projectName: 'PPT' })
  ledger.complete(withPath.taskId, { resultLine: '已导出到 ' + REAL_LONG_PATH })
  const line = doneAnnouncementOf(withPath)
  assert.equal(line.includes('陈潘HBEU'), false, '播报里不许出现完整路径：' + line)
  assert.ok(line.includes('ICACHE2026_GNN'), '缩写后的文件名还在：' + line)
})

test('提示屏与文件夹取值', () => {
  const frame = noticeFrame({ stage: '撤单', title: '已撤掉：改写第 3 段', lines: ['还没开始跑，直接拿掉了'] })
  assert.equal(frame.mode, 'status')
  assert.equal(frame.title, '已撤掉：改写第 3 段')
  assert.equal(folderBase('D:\\proj\\青年基金2027\\'), '青年基金2027')
  assert.equal(folderBase(undefined), '')
})

test('所有任务屏的共同契约：不新增必填字段、按钮 id 不重复、超长标题被省略', () => {
  const frames = [
    receiptFrame({ taskId: 't', projectName: '一个非常非常非常长的项目名字用来测试标题省略', folder: 'D:/x', queueAhead: 1 }),
    detailFrame({ taskId: 't', title: '一个非常非常非常长的任务名用来测试标题省略行为', liveLine: '思考 · 核对', step: 1, elapsedMs: 0, statsLine: '上下文 3%' }),
    doneFrame({ taskId: 't', title: '一个非常非常非常长的任务标题用来测试标题省略行为是否正确', resultLine: '结果行', replyText: '结果行', others: 3 }),
    askWhichFrame({ candidates: [] }),
  ]
  for (const frame of frames) {
    assert.equal(typeof frame.stage, 'string')
    assert.equal(typeof frame.title, 'string')
    assert.ok(Array.isArray(frame.bullets))
    assert.ok(frame.bullets.length <= SCREEN_SPEC.maxBodyLines)
    const ids = (frame.actions ?? []).map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, '按钮 id 不能重复')
    // 18px 加粗标题：按像素量宽必须落在 304 以内（clipScreenTitle 保证）
    assert.ok(frame.title.length <= SCREEN_SPEC.titleChars * 2, `标题不该无限长：${frame.title}`)
  }
})

/* ---------- 2026-11-09 新增：电脑端（DSH 主 GUI）会话 → 外部任务（source='pc'） ----------
 *
 * 需求：电脑端新建/运行的会话也要同步到鹈鹕屏，两端状态一致。登记簿这一侧要保证：
 *   - 外部任务有自己的 source 与 p 前缀短号，不占派单的 t 序号；
 *   - 副行写「电脑端 · 项目名」（状态已经在胶囊里，不重复写「已完成」）；
 *   - 状态可以从 done 回到 running（电脑端随时会再说一句），轮询不变时不抖 updatedAt；
 *   - 「接着/继续」永远追加不到外部任务上（外部任务是只读镜像，不能投 prompt）；
 *   - 完成摘要只留纯文本（去 markdown、去长路径）。
 */

test('电脑端外部任务：source=pc / p 前缀短号 / 副行「电脑端 · 项目名」', () => {
  const ledger = new TaskLedger()
  // 用同一个时间基准：prune 会按「静置 3 天」归档电脑端任务，假时钟跨 3 天会把这条测试弄假。
  const now = Date.now()
  const task = ledger.add({
    title: '把第三节的结果补上',
    projectId: 'pc:session-1',
    projectName: '论文',
    sessionIds: ['session-1'],
    source: 'pc',
    state: 'running',
    startedAt: now - 1000,
    now,
  })
  assert.equal(task.taskId, 'p1')
  assert.equal(task.source, 'pc')
  assert.equal(task.state, 'running')
  assert.equal(task.startedAt, now - 1000)
  assert.deepEqual(task.sessionIds, ['session-1'])
  assert.equal(subLineOf(task), '电脑端 · 论文', '副行＝电脑端＋项目名，状态不重复写')
  task.state = 'done'
  assert.equal(subLineOf(task), '电脑端 · 论文')
  // 两套短号各走各的：p1 不会把鹈鹕派单的 t1 顶成 t2。
  const dispatch = ledger.add({ title: '派单的', projectId: 'p', projectName: 'P', now: now + 10 })
  assert.equal(dispatch.taskId, 't1')
  assert.equal(dispatch.source, 'tihu', '缺省仍是鹈鹕派单（老流程不受影响）')
  const second = ledger.add({ title: '第二条外部', projectId: 'pc:session-2', projectName: '', source: 'pc', now: now + 20 })
  assert.equal(second.taskId, 'p2')
  assert.equal(subLineOf(second), '电脑端', '没有项目名时就直接「电脑端」')
})

test('电脑端外部任务计入四段计数；棋盘胶囊与鹈鹕任务同一套四词', () => {
  const ledger = new TaskLedger()
  ledger.add({ title: '跑着的', projectId: 'pc:a', projectName: 'A', sessionIds: ['a'], source: 'pc', state: 'running' })
  ledger.add({ title: '排队的', projectId: 'pc:b', projectName: 'B', sessionIds: ['b'], source: 'pc', state: 'queued' })
  ledger.add({ title: '完成的', projectId: 'pc:c', projectName: 'C', sessionIds: ['c'], source: 'pc', state: 'done' })
  assert.deepEqual(countsOf(ledger.list()), { running: 1, awaiting: 0, queued: 1, done: 1 })
  const board = boardOf(ledger.list(), 10)
  assert.equal(board.total, 3)
  assert.deepEqual(board.rows.map((row) => row.capsule), ['执行中', '排队中', '完成'])
  assert.deepEqual(board.rows.map((row) => row.sub), ['电脑端 · A', '电脑端 · B', '电脑端 · C'])
})

test('syncExternal：done→running 可复活；状态没变就不动 updatedAt（轮询不抖棋盘）', () => {
  const ledger = new TaskLedger()
  const task = ledger.add({ title: 'a', projectId: 'pc:a', projectName: 'A', sessionIds: ['a'], source: 'pc', state: 'running', startedAt: 1000, now: 2000 })
  assert.equal(ledger.syncExternal(task.taskId, { state: 'done', summary: '做完了', at: 5000 }), true)
  assert.equal(task.state, 'done')
  assert.equal(task.finishedAt, 5000)
  assert.equal(task.resultLine, '做完了')
  assert.equal(ledger.syncExternal(task.taskId, { state: 'done', at: 9000 }), false, '同一状态不算棋盘变化')
  assert.equal(task.updatedAt, 5000, '每 10 秒轮询一次不能把卡片重新顶到最前')
  assert.equal(ledger.syncExternal(task.taskId, { state: 'running', summary: '又有新进展', at: 12_000, startedAt: 11_000 }), true)
  assert.equal(task.state, 'running')
  assert.equal(task.finishedAt, undefined)
  assert.equal(task.startedAt, 11_000, '新一轮的活动重新起算时长环')
  assert.equal(task.resultLine, '又有新进展')
  // 标题/项目变了也算棋盘变化，标题仍按 taskTitleOf 截断
  assert.equal(ledger.syncExternal(task.taskId, { title: '很长的标题'.repeat(12), projectName: 'B', state: 'running', at: 13_000 }), true)
  assert.ok([...task.title].length <= 18, '标题必须截断：' + task.title)
  assert.equal(subLineOf(task), '电脑端 · B')
})

test('外部任务绝不被「接着/继续」追加（只读镜像，不能往电脑端会话投 prompt）', () => {
  const ledger = new TaskLedger()
  const external = ledger.add({ title: '外部那条', projectId: 'pc:a', projectName: 'A', sessionIds: ['a'], source: 'pc', state: 'running' })
  const route = routeQuick({ text: '接着把图也改一下', cards: [], tasks: ledger.list() })
  assert.notEqual(route.kind, 'append')
  assert.notEqual(route.kind === 'append' ? route.task.taskId : '', external.taskId)
  // 鹈鹕自己的任务照旧可以追加
  const own = ledger.add({ title: '派单那条', projectId: 'p', projectName: 'P' })
  ledger.attachSession(own.taskId, 'own-session')
  ledger.markRunning(own.taskId)
  assert.equal(routeQuick({ text: '接着改', cards: [], tasks: ledger.list() }).kind, 'append')
})

test('电脑端外部任务：超过 3 天没活动按同一归档窗口自动下屏（prune）', () => {
  const ledger = new TaskLedger()
  const stale = ledger.add({ title: '老会话', projectId: 'pc:old', projectName: 'A', sessionIds: ['old'], source: 'pc', state: 'running', now: 1000 })
  const fresh = ledger.add({ title: '新会话', projectId: 'pc:new', projectName: 'B', sessionIds: ['new'], source: 'pc', state: 'running', now: DONE_KEEP_MS + 5000 })
  const dispatch = ledger.add({ title: '派单的', projectId: 'p', projectName: 'P', now: DONE_KEEP_MS + 5000 })
  ledger.prune(DONE_KEEP_MS + 6000)
  assert.equal(stale.state, 'archived', '超过 3 天没活动的电脑端任务要下屏')
  assert.equal(fresh.state, 'running', '窗口内的任务不动')
  assert.equal(dispatch.state, 'queued', '还在排队的鹈鹕派单任务不受这条规则影响')
  assert.equal(boardOf(ledger.list(), DONE_KEEP_MS + 6000).rows.length, 2)
  assert.equal(DONE_KEEP_MS, 3 * 24 * 60 * 60_000, '窗口与完成态归档是同一个常量')
})

test('plainSummaryOf：去 markdown / 去长路径 / 只取第一句 / 超长省略', () => {
  assert.equal(plainSummaryOf('## 结论\n**已经改好了**，温度场收敛。第二句不要。'), '结论 已经改好了，温度场收敛')
  assert.equal(plainSummaryOf('结果在 D:\\dsh-assistant\\src\\tihu\\lane.ts 里'), '结果在 里')
  assert.equal(plainSummaryOf('脚本 /home/user/projects/tihu/render.py 跑完了'), '脚本 跑完了')
  assert.equal(plainSummaryOf('- 第一条\n- 第二条'), '第一条 第二条')
  assert.equal(plainSummaryOf('`npm run build` 通过了'), 'npm run build 通过了')
  assert.equal(plainSummaryOf('一二三四五六七八九十', 5), '一二三四…')
  assert.equal(plainSummaryOf(''), '')
  assert.equal(plainSummaryOf('```\ncode only\n```'), '')
})

test('完成页朗读分段：首段只一行、后续合并整行且不超上限，段界与 done.ranges 完全对齐', () => {
  const body = prepareDoneText('第一句比较短。第二句也不长。第三句稍微长一点，但是仍然没有超过八十字的上限。第四句继续凑一点字数。第五句收尾。')
  const ranges = doneLineRangesOf(body)
  const chars = [...body]
  const segments = doneSpeechSegmentsOf(body)
  assert.ok(segments.length >= 2, '要分成多段（不能一段念到底，首包等太久）')
  assert.equal(segments[0].firstLine, 0)
  assert.equal(segments[0].lastLine, 0, '首段只装第一行（尽快开口）')
  for (const segment of segments) {
    assert.equal(segment.start, ranges[segment.firstLine][0], '段起点＝那一行的起点')
    assert.equal(segment.end, ranges[segment.lastLine][1], '段终点＝那一行的终点')
    assert.ok(segment.lastLine >= segment.firstLine, '段的行范围必须有效')
    assert.equal(segment.text, chars.slice(segment.start, segment.end).join(''), '段文本＝同一坐标系里的码点切片')
  }
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].start >= segments[i - 1].end, '段与段不重叠')
    assert.equal(segments[i].firstLine, segments[i - 1].lastLine + 1, '行是连续的，不跳行')
  }
  assert.equal(segments[segments.length - 1].end, chars.length, '最后一段念到正文末尾（不是第一句就停）')
  for (const segment of segments.slice(1)) {
    assert.ok(segment.end - segment.start <= DONE_SPEECH_MAX_CHARS, '合并上限：' + (segment.end - segment.start))
  }
  assert.deepEqual(segments.map((segment) => segment.index), segments.map((_, index) => index), '段序号从 0 连续')
  assert.deepEqual(doneSpeechSegmentsOf(''), [], '没有正文就没有段（不合成空串）')
})

test('棋盘排序按状态而不是来源；一条一张卡；每页 4 条、页码夹在范围内', () => {
  const ledger = new TaskLedger()
  const external = ledger.add({ title: '电脑端那条', projectId: 'pc:s', projectName: 'A', sessionIds: ['s'], source: 'pc', state: 'running', now: 5000 })
  const mine = ledger.add({ title: '派单那条', projectId: 'p', projectName: 'P', now: 1000 })
  ledger.attachSession(mine.taskId, 's-mine')
  const board = boardOf(ledger.list(), 5000)
  assert.equal(board.rows[0].taskId, external.taskId, '执行中的排前面（来源不再抢前排）')
  assert.equal(board.rows[1].taskId, mine.taskId, '还没开跑的派单任务排在执行中之后')
  assert.equal(isPinnedBoardTask(mine), true)
  assert.equal(isPinnedBoardTask(external), false, '电脑端镜像是只读卡')

  const many = new TaskLedger()
  for (let i = 1; i <= 6; i += 1) many.add({ title: `任务${i}`, projectId: `proj-${i}`, projectName: `P${i}`, now: 1000 + i })
  const page0 = boardOf(many.list(), 9000, 0)
  assert.equal(page0.page.total, 2, '6 条 → 2 页')
  assert.equal(page0.page.index, 0)
  assert.equal(page0.rows.length, BOARD_PAGE_SIZE, '每页 4 条')
  const page1 = boardOf(many.list(), 9000, 1)
  assert.equal(page1.page.index, 1)
  assert.equal(page1.rows.length, 2, '第 2 页剩 2 条')
  assert.equal(new Set([...page0.rows, ...page1.rows].map((row) => row.taskId)).size, 6, '两页不重不漏')
  assert.equal(boardOf(many.list(), 9000, 9).page.index, 1, '页码越界夹到最后一张页')
  assert.equal(boardOf(many.list(), 9000, -3).page.index, 0, '负数夹到第 1 页')
  assert.equal(boardOf([], 9000).page.total, 1, '空盘也算 1 页（翻页条不出现）')
})

/* ---------- 台账落盘（2026-11-10：跨重启记住完成历史） ---------- */

const ledgerDir = mkdtempSync(join(tmpdir(), 'dsh-tihu-ledger-test-'))
const DAY = 24 * 60 * 60_000

test('台账落盘 → 重启读盘：完成卡、完成计数、分页都对得上', () => {
  const now = 1_800_000_000_000
  const file = join(ledgerDir, 'roundtrip.json')
  const ledger = new TaskLedger()
  const first = ledger.add({ title: '写基金预算表', projectId: 'fund', projectName: '青年基金', now: now - 600_000 })
  ledger.complete(first.taskId, { resultLine: '预算表已生成', now: now - 300_000 })
  const second = ledger.add({ title: '整理桥梁温度场', projectId: 'bridge', projectName: '温度场', now: now - 900_000 })
  ledger.complete(second.taskId, { resultLine: '温度场图已出', now: now - 500_000 })

  const store = new TaskLedgerStore({ file, snapshot: () => ledgerSnapshotOf(ledger.list(), now), delayMs: 0, onError: () => {} })
  assert.equal(store.flush(), true, '写盘要成功')
  assert.ok(existsSync(file))
  assert.deepEqual(readdirSync(ledgerDir).filter((name) => name.endsWith('.tmp')), [], '原子写不许留 .tmp')

  const snapshot = readLedgerSnapshot(file)
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.v, LEDGER_SNAPSHOT_VERSION)
  assert.equal(snapshot.tasks.length, 2)

  // 模拟进程重启：新登记簿 + 读盘恢复。
  const reborn = new TaskLedger()
  const restored = reborn.restore(snapshot.tasks, now)
  assert.equal(restored.restored, 2)
  assert.equal(restored.dropped, 0)
  assert.equal(restored.ended, 0, '正常完成的不要标成中断')
  const board = boardOf(reborn.list(), now)
  assert.deepEqual(board.counts, { running: 0, awaiting: 0, queued: 0, done: 2 })
  assert.equal(board.total, 2)
  assert.equal(board.page.total, 1, '分页按恢复出来的条数算')
  assert.deepEqual(board.rows.map((row) => row.capsule), ['完成', '完成'])
  assert.ok(board.rows.some((row) => row.taskId === first.taskId), '恢复的完成卡要上棋盘')
  const restoredFirst = reborn.get(first.taskId)
  assert.equal(restoredFirst.resultLine, '预算表已生成')
  assert.equal(restoredFirst.finishedAt, now - 300_000)
  assert.ok(restoredFirst.spokenAt !== undefined, '恢复的历史不许再播报')

  const next = reborn.add({ title: '重启后新派的一条', projectId: 'fund', projectName: '青年基金', now })
  assert.equal(next.taskId, 't3', '短号按恢复出来的最大号继续，不许撞号')
})

test('重启时 running / queued / awaiting 一律按已结束处理（屏上不再算在跑）', () => {
  const now = 1_800_000_000_000
  const ledger = new TaskLedger()
  const running = ledger.add({ title: '跑一半的那条', projectId: 'p', projectName: 'P', now: now - 600_000 })
  ledger.markRunning(running.taskId, now - 500_000)
  ledger.add({ title: '还排队的', projectId: 'p', projectName: 'P', now: now - 400_000 })
  const awaiting = ledger.add({ title: '等你拍板的', projectId: 'p', projectName: 'P', now: now - 300_000 })
  ledger.ask(awaiting.taskId, { question: '删不删？', options: ['删', '留'], timeoutMs: 60_000, now: now - 200_000 })

  const snapshot = ledgerSnapshotOf(ledger.list(), now)
  assert.equal(snapshot.tasks.find((task) => task.taskId === running.taskId).state, 'running', '落盘时保留真实状态')

  const reborn = new TaskLedger()
  const restored = reborn.restore(snapshot.tasks, now)
  assert.equal(restored.ended, 3, '三条都按结束处理')
  for (const task of reborn.list()) {
    assert.equal(task.state, 'done')
    assert.equal(task.resultLine, RESTORED_INTERRUPTED_LINE)
    assert.equal(task.question, undefined, '待决策不许跨重启复活')
    assert.equal(task.options, undefined)
    assert.ok(task.finishedAt !== undefined)
  }
  const board = boardOf(reborn.list(), now)
  assert.deepEqual(board.counts, { running: 0, awaiting: 0, queued: 0, done: 3 }, '四段计数里没有在跑/待决策/排队')
  assert.ok(board.rows.every((row) => row.state === 'done' && row.capsule === '完成'))
})

test('恢复窗口：超 3 天丢弃，完成历史最多 60 条（按时间淘汰）', () => {
  const now = 1_800_000_000_000
  const records = []
  for (let i = 1; i <= 70; i += 1) {
    const at = now - (70 - i) * 60_000
    records.push({
      taskId: `t${i}`, source: 'tihu', title: `任务${i}`, projectId: 'p', projectName: 'P', preset: 'standard',
      state: 'done', startedAt: at - 1000, updatedAt: at, finishedAt: at, resultLine: '做完了', sessionIds: [],
    })
  }
  records.push({
    taskId: 't99', source: 'tihu', title: '四天前', projectId: 'p', projectName: 'P', preset: 'standard',
    state: 'done', startedAt: now - 4 * DAY, updatedAt: now - 4 * DAY, finishedAt: now - 4 * DAY, sessionIds: [],
  })
  const restored = restoreLedgerTasks(records, now)
  assert.equal(restored.restored, LEDGER_RESTORE_MAX, '最多保留 60 条')
  assert.equal(restored.restored, 60)
  assert.equal(restored.dropped, 11, '老 1 条 + 超出上限 10 条')
  assert.equal(restored.tasks.some((task) => task.taskId === 't99'), false, '超过 3 天的不要')
  assert.equal(restored.tasks[0].taskId, 't70', '最近的排最前')
  assert.equal(restored.tasks[59].taskId, 't11', '被淘汰的是 60 条之外最老的那些')

  // 边界：正好 3 天留下，多 1 毫秒丢掉。
  const edge = restoreLedgerTasks([
    { taskId: 't1', title: '正好三天', projectId: 'p', projectName: 'P', state: 'done', startedAt: now - DONE_KEEP_MS, updatedAt: now - DONE_KEEP_MS, finishedAt: now - DONE_KEEP_MS, sessionIds: [] },
    { taskId: 't2', title: '多一毫秒', projectId: 'p', projectName: 'P', state: 'done', startedAt: now - DONE_KEEP_MS - 1, updatedAt: now - DONE_KEEP_MS - 1, finishedAt: now - DONE_KEEP_MS - 1, sessionIds: [] },
  ], now)
  assert.equal(edge.restored, 1)
  assert.equal(edge.tasks[0].taskId, 't1')
})

test('坏文件 / 旧版本一律当没有；落盘记录不含正文大段文本', () => {
  const now = 1_800_000_000_000
  const corrupt = join(ledgerDir, 'corrupt.json')
  writeFileSync(corrupt, '{"v":1,"tasks":[', 'utf8')
  assert.equal(readLedgerSnapshot(corrupt), undefined, '半截 JSON 不许抛错、按没有处理')
  writeFileSync(corrupt, JSON.stringify({ v: LEDGER_SNAPSHOT_VERSION + 1, savedAt: now, tasks: [] }), 'utf8')
  assert.equal(parseLedgerSnapshot(readFileSync(corrupt, 'utf8')), undefined, '版本不对就整份不要')
  assert.equal(parseLedgerSnapshot(''), undefined)
  assert.equal(parseLedgerSnapshot('null'), undefined)

  const ledger = new TaskLedger()
  const task = ledger.add({ title: '正文检查', projectId: 'p', projectName: 'P', sessionIds: ['session-abc'], now })
  ledger.complete(task.taskId, { resultLine: '一句话结果', now })
  ledger.get(task.taskId).doneText = '这是一大段正文。'.repeat(500)
  ledger.get(task.taskId).summary = '摘要一行'
  const snapshot = ledgerSnapshotOf(ledger.list(), now)
  const record = snapshot.tasks[0]
  assert.equal('doneText' in record, false, '正文绝不落盘')
  assert.equal(record.resultLine, '一句话结果')
  assert.equal(record.summary, '摘要一行')
  assert.deepEqual(record.sessionIds, ['session-abc'])
  assert.ok(JSON.stringify(snapshot).length < 1200, '记录要克制：一条不到 1KB')

  const file = join(ledgerDir, 'shape.json')
  assert.equal(writeLedgerSnapshot(snapshot, file), true)
  assert.equal(readFileSync(file, 'utf8').includes('这是一大段正文'), false)
})

test('状态一变就通知落盘（onChange → schedule → flush：完成状态真的写进文件）', () => {
  const file = join(ledgerDir, 'wired.json')
  let ledger
  const store = new TaskLedgerStore({ file, delayMs: 0, snapshot: () => ledgerSnapshotOf(ledger.list()), onError: () => {} })
  ledger = new TaskLedger(undefined, { onChange: () => store.schedule() })
  const task = ledger.add({ title: '接线检查', projectId: 'p', projectName: 'P' })
  ledger.complete(task.taskId, { resultLine: '接上了' })
  assert.equal(store.flush(), true)
  const snapshot = readLedgerSnapshot(file)
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.tasks[0].state, 'done')
  assert.equal(snapshot.tasks[0].resultLine, '接上了')
})

rmSync(ledgerDir, { recursive: true, force: true })

console.log(`\n${passed} tests passed（task-ledger + task-screens）`)
