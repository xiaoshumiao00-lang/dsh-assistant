/** 多会话并发那三刀的纯函数回归：node scripts/test-mobile-scan-facts.mjs
 *  1) 目录桶索引 / 游离会话判定的「等价改写」：新旧两种算法逐条比对（含大小写、混合分隔符、
 *     尾部斜杠、相似前缀、子代理、无 cwd）
 *  2) 会话事实缓存：同一组判定输入不重算、任一输入变了立刻重算、分层节奏、说在跑就升热档
 *  3) 活动扫描取样节奏：settle 优先 + 最久没取的排前面 + 每轮名额不变（不改变判定口径）
 */
import assert from 'node:assert/strict'
import { folderKeyOf, normalizeFolderPath, sessionsUnderFolder, unownedSessionIds } from '../src/client/sessionFolder.ts'
import { sessionSnapshotIndexOf, invalidateSessionSnapshotIndex, sessionIdsUnderFolderOf } from '../src/client/sessionIndex.ts'
import {
  sessionFactSignatureOf,
  factTierOf,
  createSessionFactStore,
  FACT_TTL_HOT_MS,
  FACT_TTL_WARM_MS,
  FACT_TTL_COLD_MS,
} from '../src/client/sessionFactCache.ts'
import { shouldFetchTail, pickTailBatch, RUNNING_TAIL_TTL_MS, MAX_TAILS_PER_ROUND } from '../src/client/activitySweepPolicy.ts'

const cases = []

// ── 1) 目录桶索引与游离会话判定：改写前后逐条一致 ─────────────────────────
/** 旧写法：每条会话 × 每个目录做一次前缀比较（O(会话数 × 目录数)）。 */
function unownedSessionIdsNaive(ids, byId, folders, owned, archived) {
  const ownedSet = new Set(owned)
  const archivedSet = new Set(archived)
  const folderKeys = []
  for (const folder of folders ?? []) {
    const key = normalizeFolderPath(folder).toLowerCase()
    if (key) folderKeys.push(key)
  }
  const out = []
  for (const sid of ids ?? []) {
    const e = byId[sid]
    if (!e) continue
    if (e.parentId || e.origin === 'subagent') continue
    if (ownedSet.has(sid) || archivedSet.has(sid)) continue
    const cwd = normalizeFolderPath(e.cwd)
    if (!cwd) continue
    const key = cwd.toLowerCase()
    let ownedByFolder = false
    for (const base of folderKeys) {
      if (key === base || key.startsWith(base + '/')) { ownedByFolder = true; break }
    }
    if (ownedByFolder) continue
    out.push(sid)
  }
  return out
}

/** 旧写法：每个项目都扫一遍全部会话。 */
function sessionIdsUnderFolderNaive(snapshot, base) {
  const index = sessionSnapshotIndexOf(snapshot)
  const key = normalizeFolderPath(base).toLowerCase()
  if (!key) return []
  return index.folderRows.filter((row) => row.key === key || row.key.startsWith(key + '/')).map((row) => row.id)
}

const SAMPLE_CWDS = [
  'D:/proj/Alpha',
  'D:\\proj\\alpha\\sub',           // 反斜杠 + 大小写不同
  'D:/proj/AlphaBeta',             // 相似前缀（不能被 Alpha 吞掉）
  'D:/proj/Alpha/',                // 尾部斜杠
  '  D:/proj/Gamma  ',             // 首尾空白
  'D:/other/Deep/Dir',
  'D:/proj/AlphaBeta/Gamma/Inner',
  '',                              // 无 cwd
  null,                            // 缺字段
  'D:/中文目录/子一/子二',
  'D:/中文目录/子一/子二/更深处',
  'D:/p1', 'D:/P1/Child',         // 盘符后大小写
]

function makeSnapshot() {
  const byId = {}
  const ids = []
  let n = 0
  for (const cwd of SAMPLE_CWDS) {
    const sid = `s${String(++n).padStart(3, '0')}`
    ids.push(sid)
    const entry = { sessionId: sid }
    if (cwd !== null) entry.cwd = cwd
    byId[sid] = entry
  }
  // 子代理 / 有 parentId 的行：两种算法都必须排除
  byId['kid1'] = { sessionId: 'kid1', cwd: 'D:/proj/Alpha', parentId: 's001', origin: 'subagent' }
  byId['kid2'] = { sessionId: 'kid2', cwd: 'D:/proj/Alpha', origin: 'subagent' }
  byId['kid3'] = { sessionId: 'kid3', cwd: 'D:/proj/Alpha', parentId: 's001' }
  ids.push('kid1', 'kid2', 'kid3')
  return { ids, byId, subagentsByParent: { s001: [{ sessionId: 'kid1' }] } }
}

cases.push(['目录桶索引：逐目录问法与「扫全部会话」的旧写法逐条一致', () => {
  const snapshot = makeSnapshot()
  invalidateSessionSnapshotIndex()
  const index = sessionSnapshotIndexOf(snapshot)
  const bases = [
    'D:/proj/Alpha', 'D:\\proj\\ALPHA\\', 'D:/proj/AlphaBeta', 'D:/other', 'D:/nope',
    'D:/中文目录/子一', 'D:/p1', '', '   ', 'D:/proj',
  ]
  for (const base of bases) {
    assert.deepEqual(sessionIdsUnderFolderOf(index, base), sessionIdsUnderFolderNaive(snapshot, base), `基准 = ${JSON.stringify(base)}`)
  }
  // 桶索引本身不改动调用方的数组：改一次返回值不应影响下一次查询
  const first = sessionIdsUnderFolderOf(index, 'D:/proj/Alpha')
  first.push('污染')
  assert.deepEqual(sessionIdsUnderFolderOf(index, 'D:/proj/Alpha'), sessionIdsUnderFolderNaive(snapshot, 'D:/proj/Alpha'), '返回的桶不能被 mutate 影响')
}])

cases.push(['目录桶索引与宿主 sessionsUnderFolder 同口径', () => {
  const snapshot = makeSnapshot()
  invalidateSessionSnapshotIndex()
  const index = sessionSnapshotIndexOf(snapshot)
  for (const base of ['D:/proj/Alpha', 'D:/proj', 'D:/other/Deep', 'D:/nope']) {
    assert.deepEqual(
      sessionIdsUnderFolderOf(index, base),
      sessionsUnderFolder(snapshot.ids, snapshot.byId, base),
      `基准 = ${base}`,
    )
  }
}])

cases.push(['游离会话判定：祖先链查集合与旧「逐目录前缀比较」逐条一致', () => {
  const snapshot = makeSnapshot()
  const ids = snapshot.ids
  const byId = snapshot.byId
  const variants = [
    { folders: ['D:/proj/Alpha'], owned: [], archived: [] },
    { folders: ['D:\\proj\\alpha\\'], owned: ['s002'], archived: ['s006'] },
    { folders: ['D:/proj', 'D:/other'], owned: [], archived: [] },
    { folders: ['D:/中文目录/子一'], owned: [], archived: [] },
    { folders: [], owned: [], archived: [] },
    { folders: ['', '  ', 'D:/p1/'], owned: ['kid3'], archived: [] },
  ]
  for (const v of variants) {
    assert.deepEqual(
      unownedSessionIds(ids, byId, v.folders, v.owned, v.archived),
      unownedSessionIdsNaive(ids, byId, v.folders, v.owned, v.archived),
      `folders = ${JSON.stringify(v.folders)}`,
    )
  }
}])

cases.push(['目录规范化缓存：同一个字符串恒等于直接计算，不同字符串不串味', () => {
  const samples = [...SAMPLE_CWDS, 'D:/a/b', 'D:\\a\\b\\', 'D:/a/b/c', undefined, 0, 42, {}, 'D:/x//']
  for (let round = 0; round < 3; round += 1) {
    for (const raw of samples) {
      const direct = String(raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
      assert.equal(normalizeFolderPath(raw), direct, `第 ${round + 1} 轮 ${JSON.stringify(String(raw))}`)
      assert.equal(folderKeyOf(raw), direct.toLowerCase(), `小写键 ${JSON.stringify(String(raw))}`)
    }
  }
  assert.equal(folderKeyOf('D:/AA') === folderKeyOf('D:/aa'), true, '大小写不同的两个路径必须是同一个比对键')
  assert.equal(folderKeyOf('D:/AA/BB').startsWith(folderKeyOf('D:/AA') + '/'), true, '父子目录口径')
}])

// ── 2) 会话事实缓存 ────────────────────────────────────────────────────────
const FACTS_INPUT = {
  updatedAt: 1000, running: false, completed: true, blank: false,
  entryPending: false, awaitingDecision: false, errorMark: false,
  kidsCount: 0, kidsRunning: 0, kidsAwaiting: 0,
}

cases.push(['事实签名：任一输入变了签名就变，全同就相同', () => {
  const base = sessionFactSignatureOf(FACTS_INPUT)
  assert.equal(sessionFactSignatureOf(FACTS_INPUT), base)
  const changed = [
    'updatedAt', 'running', 'completed', 'blank', 'entryPending', 'awaitingDecision', 'errorMark',
    'kidsCount', 'kidsRunning', 'kidsAwaiting',
  ]
  for (const field of changed) {
    const next = { ...FACTS_INPUT }
    next[field] = field === 'updatedAt' ? 2000 : field === 'kidsCount' ? 3 : (next[field] === true ? false : true)
    assert.notEqual(sessionFactSignatureOf(next), base, `${field} 变化必须让签名失效`)
  }
}])

cases.push(['事实分层：在跑/等决策=热档，刚活动过=温档，冷会话=冷档', () => {
  const now = 1_000_000_000
  assert.deepEqual(factTierOf({ running: true, updatedAt: 0, now }), { tier: 'hot', ttlMs: FACT_TTL_HOT_MS })
  assert.equal(factTierOf({ awaiting: true, updatedAt: 0, now }).tier, 'hot')
  assert.equal(factTierOf({ kidsRunning: 2, updatedAt: 0, now }).tier, 'hot')
  assert.equal(factTierOf({ updatedAt: now - 30_000, now }).tier, 'hot', '一分钟内的活动也算热')
  assert.equal(factTierOf({ observedFinishedAt: now - 10_000, now }).tier, 'hot', '观察到的结束时间也算活动')
  assert.equal(factTierOf({ updatedAt: now - 300_000, now }).tier, 'warm', '1 到 10 分钟之间算温档')
  assert.deepEqual(factTierOf({ updatedAt: now - 3_600_000_000, now }), { tier: 'cold', ttlMs: FACT_TTL_COLD_MS })
  assert.equal(factTierOf({ updatedAt: 0, now }).tier, 'cold', '完全没有时间的会话归冷档')
  assert.equal(FACT_TTL_HOT_MS < FACT_TTL_WARM_MS && FACT_TTL_WARM_MS < FACT_TTL_COLD_MS, true)
}])

cases.push(['事实缓存：同签名不重算，签名变了立即重算，过期按节奏重算', () => {
  let clock = 10_000
  let computeCount = 0
  const store = createSessionFactStore({ now: () => clock })
  const compute = () => { computeCount += 1; return { n: computeCount } }
  const tier = { ttlMs: FACT_TTL_WARM_MS }
  assert.deepEqual(store.read('a', 'sig1', tier, compute), { n: 1 })
  assert.deepEqual(store.read('a', 'sig1', tier, compute), { n: 1 }, '同签名同窗口必须复用')
  assert.equal(store.stats().hits, 1)
  clock += 100
  assert.deepEqual(store.read('a', 'sig2', tier, compute), { n: 2 }, '判定输入变了要立刻重算')
  assert.deepEqual(store.read('a', 'sig2', tier, compute), { n: 2 })
  clock += FACT_TTL_WARM_MS
  assert.deepEqual(store.read('a', 'sig2', tier, compute), { n: 3 }, '窗口过期要按节奏重算')
  store.drop('a')
  assert.deepEqual(store.read('a', 'sig2', tier, compute), { n: 4 }, 'drop 后必须重算')
  assert.notEqual(store.read('b', 'sig1', tier, compute), store.read('a', 'sig1', tier, compute), '不同会话各自一条')
}])

cases.push(['事实缓存：说「在跑」的那条自动升热档（会话面兜底不会被拖到冷档）', () => {
  let clock = 10_000
  let n = 0
  const store = createSessionFactStore({ now: () => clock })
  const tier = { ttlMs: FACT_TTL_COLD_MS }
  const compute = () => { n += 1; return { running: true, n } }
  assert.deepEqual(store.read('a', 'sig', tier, compute), { running: true, n: 1 })
  clock += FACT_TTL_COLD_MS - 1
  assert.deepEqual(store.read('a', 'sig', tier, compute), { running: true, n: 1 }, '冷档窗口内仍复用')
  store.promote('a', FACT_TTL_HOT_MS)
  clock += FACT_TTL_HOT_MS
  assert.deepEqual(store.read('a', 'sig', tier, compute), { running: true, n: 2 }, '升档后按热档节奏再判一次')
  store.promote('missing', FACT_TTL_HOT_MS)
  assert.equal(store.stats().size, 1, 'promote 不会凭空造条目')
}])

// ── 3) 活动扫描取样节奏 ────────────────────────────────────────────────────
cases.push(['扫描节奏：在跑 2.5 s / 空闲 20 s 的口径没变', () => {
  const entry = { line: 'x', key: 'k1', running: true, at: 1000 }
  assert.equal(shouldFetchTail(entry, { running: true, key: 'k1', now: 1000 + RUNNING_TAIL_TTL_MS - 1 }), false)
  assert.equal(shouldFetchTail(entry, { running: true, key: 'k1', now: 1000 + RUNNING_TAIL_TTL_MS }), true)
  assert.equal(shouldFetchTail({ line: 'x', key: 'k1', running: true, at: 1000 }, { running: false, key: 'k1', now: 1999 }), true, '刚跑完那一轮必须允许立刻重取（settle 语义）')
  assert.equal(shouldFetchTail(undefined, { running: false, key: 'k1', now: 1 }), true)
}])

cases.push(['公平轮转：settle 仍优先，其余按「多久没被取样」轮转，名额不变', () => {
  const candidates = [
    { sid: 'a', settle: false, at: 100 },
    { sid: 'b', settle: false, at: 50 },
    { sid: 'c', settle: false, at: 500 },
    { sid: 'd', settle: false, at: 0 },
    { sid: 'e', settle: true, at: 900 },
  ]
  const batch = pickTailBatch(candidates, { max: 2 })
  assert.equal(batch.length, 2)
  assert.equal(batch[0].sid, 'e', 'settle 排第一')
  assert.equal(batch[1].sid, 'd', '从没取过的最先补')
  // 名额固定：多会话并发时每轮至多 MAX_TAILS_PER_ROUND 条
  const many = Array.from({ length: 30 }, (_, i) => ({ sid: 's' + i, settle: false, at: i }))
  assert.equal(pickTailBatch(many).length, MAX_TAILS_PER_ROUND)
  assert.equal(pickTailBatch(many)[0].sid, 's0', '取样年龄最小的排前面')
  assert.equal(many.length, 30, '候选数组不能被就地改动')
  assert.deepEqual(pickTailBatch([]), [])
  assert.equal(pickTailBatch(undefined, { max: 1 }).length, 0)
  // 同年龄按 sid 定序（每轮排法一致）
  const tied = [{ sid: 'b', at: 7 }, { sid: 'a', at: 7 }]
  assert.equal(pickTailBatch(tied, { max: 2 })[0].sid, 'a')
}])

let failed = 0
for (const item of cases) {
  try { await item[1](); console.log('  ok   ' + item[0]) } catch (err) { failed += 1; console.log('  FAIL ' + item[0] + '\n       ' + (err && err.message ? err.message : String(err))) }
}
console.log(failed === 0 ? 'PASS ' + String(cases.length) + '/' + String(cases.length) : 'FAIL ' + String(failed) + '/' + String(cases.length))
process.exit(failed === 0 ? 0 : 1)
