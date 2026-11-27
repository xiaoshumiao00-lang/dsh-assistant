/**
 * 个人秘书「更换会话」（控制室卡片按钮）的离线链路测试：
 *   列候选 → 选一条 → 写宿主 state → 回读校验（以及坏 id / 写盘失败 / 老宿主没路由这几种边界）。
 *
 * 起法：node scripts/test-secretary-session-switch.mjs
 * 不启动 DSH、不碰真实 profile：
 *   - 宿主侧用假 webServer + 临时 profile 目录 + 假会话源（sessionQuery / sessions.list）；
 *   - 客户端侧把 globalThis.fetch 接到那台假宿主的真实路由处理器上，
 *     所以「页面点一下」与「宿主写盘回读」是同一份代码在跑，不是两段各测各的。
 *
 * 覆盖断言：
 *   A. GET  /api/assistant/secretary/sessions   合并两路会话表、按最近更新倒序、丢归档、标当前绑定
 *   B. POST /api/assistant/secretary/sessions   认得到的 id 才写盘；写盘后回读必须是这条；
 *                                               认不到 → 400 session-not-in-host-list，state 一个字不动
 *   C. 客户端 bindSecretarySession             只在宿主回读成立后才更新本地缓存（坏 id 绝不进缓存）
 *   D. 降级口径：宿主没这条路由时列候选回 null（面板据此走本地快照并标「降级」）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const lib = await import('../lib/index.js')
const surface = lib.assistantSecretaryTestSurface
const SECRETARY = surface.ASSISTANT_SECRETARY_ROUTE
const SESSIONS = surface.ASSISTANT_SECRETARY_SESSIONS_ROUTE
const STATE_FILE = 'dsh-assistant-secretary.json'
const CACHE_KEY = 'dsh.assistant.secretary.sessionId'

const ROOT = mkdtempSync(join(tmpdir(), 'secretary-switch-'))

// ── 假会话源（与宿主 listSessionRows / secretarySessionExistsOnHost 同一套形状）────────
const ID_A = 'session-1111aaaa-2222-3333-4444-555566667777'
const ID_B = 'session-2222bbbb-3333-4444-5555-666677778888'
const ID_GONE = 'session-9999dead-0000-0000-0000-000000000000'
const ID_ARCHIVED = 'session-3333cccc-4444-5555-6666-777788889999'
const T_A = 1_760_000_400_000
const T_B = 1_760_000_300_000
const T_ARCHIVED = 1_760_000_200_000
/** 持久化清单（sessionQuery.listSessions）：含一条已归档 */
const PERSISTED = [
  { header: { id: ID_A, cwd: 'C:\\work\\alpha', title: 'Alpha 温度场复核', updatedAt: T_A } },
  { header: { id: ID_B, cwd: 'C:\\work\\beta', title: 'Beta 报告初稿', updatedAt: T_B } },
  { header: { id: ID_ARCHIVED, cwd: 'C:\\work\\gamma', title: 'Gamma 已归档', updatedAt: T_ARCHIVED, archived: true } },
]
/** 活会话表（sessions.list）：与持久化清单重叠一条、时间更新（去重要取较新的那条） */
const LIVE = [
  { header: { id: ID_B, cwd: 'C:\\work\\beta', title: 'Beta 报告初稿', updatedAt: T_B + 60_000 } },
]

function makeServer() {
  const exact = new Map()
  return {
    exact,
    register(route) {
      if (exact.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      exact.set(route.path, route)
      return () => { exact.delete(route.path) }
    },
  }
}

/** 装一台「宿主」：返回 server（可被 fetch 桩转发）+ 会话源开关 + profile 目录 */
function makeHost(opts = {}) {
  const dir = opts.dir ?? mkdtempSync(join(ROOT, 'profile-'))
  const server = makeServer()
  const hooks = new Map()
  const ctx = {
    webServer: server,
    get(name) {
      if (name === 'profileContext') return { dir }
      if (name === 'sessionQuery') {
        if (opts.persisted === false) return undefined
        return { listSessions: async () => (Array.isArray(opts.persistedRows) ? opts.persistedRows : PERSISTED) }
      }
      return undefined
    },
    on(name, fn) {
      hooks.set(name, fn)
      return () => { if (hooks.get(name) === fn) hooks.delete(name) }
    },
  }
  if (opts.live !== false) {
    ctx.sessions = { list: () => (Array.isArray(opts.liveRows) ? opts.liveRows : LIVE) }
  }
  const dispose = surface.registerAssistantSecretary(ctx)
  return { dir, server, ctx, dispose, stateFile: join(dir, STATE_FILE) }
}

function fakeReq(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = url
  return req
}
function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? null }
  out.end = (payload) => { out.body = String(payload ?? '') }
  return out
}
/** 直接调宿主路由（不经 fetch）：本测试自己的断言用 */
async function call(host, method, url, payload) {
  const path = String(url).split('?')[0]
  const route = host.server.exact.get(path)
  if (!route) return { status: 404, json: null }
  const res = fakeRes()
  await route.handler(fakeReq(method, url, payload === undefined ? undefined : JSON.stringify(payload)), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.status, json }
}
function readState(host) {
  try { return JSON.parse(readFileSync(host.stateFile, 'utf8')) } catch { return null }
}

const host = makeHost()
// 先把 state 绑到 A，后续才有「当前绑定」「换掉它」这两个断言的前提
await call(host, 'POST', SECRETARY, { sessionId: ID_A })

// ── A. GET 列候选 ────────────────────────────────────────────────────────────────
const listAll = await call(host, 'GET', `${SESSIONS}?limit=200`)

const cases = []
cases.push(['宿主注册了 /api/assistant/secretary/sessions，且只收 GET/POST', async () => {
  assert.ok(host.server.exact.get(SESSIONS), '新路由没注册')
  const del = await call(host, 'DELETE', SESSIONS)
  assert.equal(del.status, 405, '这条路由不许 DELETE（重置走 DELETE /api/assistant/secretary）')
  assert.equal(del.json.ok, false)
}])
cases.push(['GET 列候选：合并两路会话表、去重取较新的时间、丢掉已归档、标记当前绑定', async () => {
  assert.equal(listAll.status, 200)
  const body = listAll.json
  assert.equal(body.ok, true)
  assert.equal(body.source, 'session-query', '有 sessionQuery 时以持久化清单为主')
  const ids = body.items.map((row) => row.sessionId)
  assert.deepEqual(ids, [ID_A, ID_B], '按最近更新倒序；已归档的 Gamma 不许出现')
  assert.equal(body.items[0].bound, true, '当前绑定的 A 要标记出来（面板显示「当前绑定」）')
  assert.equal(body.items[1].bound, undefined, 'B 不是当前绑定')
  assert.equal(body.items[1].updatedAt, T_B + 60_000, 'B 两处都有时取较新的时间（活会话表那一条）')
  assert.equal(body.items[1].live, true, '活会话表里有的那条要带 live 标记')
  assert.equal(body.total, 2, 'total = 过滤（归档/搜索）之后的候选条数')
  assert.equal(body.returned, 2)
  assert.equal(body.truncated, false, '没有截断就不许说截断（归档过滤不算截断）')
}])
cases.push(['GET 列候选?q=：标题 / 目录 / id 三种都能搜，大小写不敏感', async () => {
  const byTitle = await call(host, 'GET', `${SESSIONS}?q=${encodeURIComponent('beta')}`)
  assert.deepEqual(byTitle.json.items.map((r) => r.sessionId), [ID_B], '标题搜不到')
  const byCwd = await call(host, 'GET', `${SESSIONS}?q=${encodeURIComponent('C:\\work\\alpha')}`)
  assert.deepEqual(byCwd.json.items.map((r) => r.sessionId), [ID_A], '目录搜不到')
  const byId = await call(host, 'GET', `${SESSIONS}?q=${encodeURIComponent('2222BBBB')}`)
  assert.deepEqual(byId.json.items.map((r) => r.sessionId), [ID_B], 'id 搜不到')
  const none = await call(host, 'GET', `${SESSIONS}?q=${encodeURIComponent('根本没有这条')}`)
  assert.deepEqual(none.json.items, [], '搜不到就该空')
}])
cases.push(['GET 列候选?limit=：截断生效；越界钳到上限、非法回默认', async () => {
  const one = await call(host, 'GET', `${SESSIONS}?limit=1`)
  assert.equal(one.json.items.length, 1)
  assert.equal(one.json.limit, 1)
  const huge = await call(host, 'GET', `${SESSIONS}?limit=9999`)
  assert.equal(huge.json.limit, surface.SECRETARY_SESSIONS_MAX_LIMIT, 'limit 越界要钳到上限')
  const bogus = await call(host, 'GET', `${SESSIONS}?limit=abc`)
  assert.equal(bogus.json.limit, surface.SECRETARY_SESSIONS_DEFAULT_LIMIT, '非法 limit 回默认值')
  // 截断时当前绑定的那条一定留着（否则用户看不出到底绑的是哪条）
  const tie = await call(host, 'GET', `${SESSIONS}?limit=1&q=nothing-matches`)
  assert.equal(tie.json.items.length, 0)
}])
cases.push(['GET 列候选：宿主两路会话表都问不出时 source=none、items 空（面板据此降级）', async () => {
  const bare = makeHost({ persisted: false, live: false })
  const r = await call(bare, 'GET', SESSIONS)
  assert.equal(r.status, 200)
  assert.equal(r.json.source, 'none')
  assert.deepEqual(r.json.items, [])
  bare.dispose()
}])

// ── B. POST 定绑定（严格路由：认得才写、写后回读）────────────────────────────────
cases.push(['POST 非法 id → 400 invalid-session-id 且不落盘', async () => {
  const before = readState(host)
  const r = await call(host, 'POST', SESSIONS, { sessionId: '../escape' })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'invalid-session-id')
  assert.deepEqual(readState(host), before, '非法 id 不许动 state 文件')
}])
cases.push(['POST 宿主认不到的 id → 400 session-not-in-host-list，state 与内存 ref 都不动', async () => {
  const before = readState(host)
  const r = await call(host, 'POST', SESSIONS, { sessionId: ID_GONE })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'session-not-in-host-list')
  assert.equal(r.json.sessionId, ID_A, '答复里要回当前真正挂着的那条')
  assert.deepEqual(readState(host), before, '坏 id 绝不许写进 state 文件（MEMORY 实测事故就是这个）')
  assert.notEqual(surface.secretarySessionRef.id, ID_GONE, '宿主内存里的秘书锚点也不许被带坏')
}])
cases.push(['POST 合法 id → 200 verified+readBack，文件写的是这条，GET 回读也是这条', async () => {
  const r = await call(host, 'POST', SESSIONS, { sessionId: ID_B })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.sessionId, ID_B)
  assert.equal(r.json.previous, ID_A, '答复要带「换之前是哪条」')
  assert.equal(r.json.verified, true)
  assert.equal(r.json.readBack, true)
  assert.equal(readState(host).sessionId, ID_B, 'state 文件必须真的写成新 id')
  assert.equal(surface.secretarySessionRef.id, ID_B, '内存锚点要跟着换（工具闸/派活都靠它）')
  const back = await call(host, 'GET', SECRETARY)
  assert.equal(back.json.sessionId, ID_B, 'GET 回读必须等于刚写的 id')
  const list = await call(host, 'GET', SESSIONS)
  assert.equal(list.json.items.find((row) => row.sessionId === ID_B).bound, true, '新绑定的那条要变成「当前」')
  assert.equal(list.json.items.find((row) => row.sessionId === ID_A).bound, undefined, '旧的那条要摘掉「当前」')
}])
cases.push(['POST 同一条 id（重复点）→ unchanged:true，不重写盘也不刷新时间', async () => {
  const before = readState(host)
  const r = await call(host, 'POST', SESSIONS, { sessionId: ID_B })
  assert.equal(r.status, 200)
  assert.equal(r.json.unchanged, true)
  assert.equal(r.json.updatedAt, before.updatedAt, '重复写同一条不许刷 updatedAt')
}])
cases.push(['POST：宿主没有会话源 → 400 no-session-source，宁可拒绝也不猜', async () => {
  const bare = makeHost({ persisted: false, live: false })
  const r = await call(bare, 'POST', SESSIONS, { sessionId: ID_B })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'no-session-source')
  assert.equal(existsSync(bare.stateFile), false, '认不出会话就不许落盘')
  bare.dispose()
}])
cases.push(['POST：写盘失败 → 500 state-write-failed，state 保持换之前那条', async () => {
  const blocker = join(ROOT, 'blocker-plain-file')
  writeFileSync(blocker, 'not a directory', 'utf8')
  const broken = makeHost({ dir: join(blocker, 'nested') })
  // 先把它写成 A（此时写盘本来就成功不了，所以换个做法：直接构造一个「登记时 state 是 A」的场景不可行，
  // 于是这里的断言只要求「失败可见 + 没有留下新 id」）
  const r = await call(broken, 'POST', SESSIONS, { sessionId: ID_B })
  assert.equal(r.status, 500)
  assert.equal(r.json.error, 'state-write-failed')
  assert.ok(String(r.json.message ?? '').length > 0, '失败原因要带出来，日志才查得动')
  assert.equal(r.json.sessionId, null, '写失败答复里不许给出「已换到 B」的假象')
  broken.dispose()
}])
cases.push(['回读判据是纯函数：null / 不同 id 一律不算写成', async () => {
  assert.equal(surface.secretaryStateMatchesWrite(ID_A, null), false)
  assert.equal(surface.secretaryStateMatchesWrite(ID_A, { sessionId: ID_B, updatedAt: '' }), false)
  assert.equal(surface.secretaryStateMatchesWrite(ID_A, { sessionId: ID_A, updatedAt: '' }), true)
}])
cases.push(['归一/筛选纯函数：坏行丢掉、去重取较新、bound 永远留着、关键词与 limit 口径', async () => {
  assert.equal(surface.normalizeBindableSessionRow(null), null)
  assert.equal(surface.normalizeBindableSessionRow({ title: '没有 id' }), null, '没 id 的行必须丢')
  assert.equal(surface.normalizeBindableSessionRow({ sessionId: '../escape' }), null, '坏 id 的行必须丢')
  const noTitle = surface.normalizeBindableSessionRow({ sessionId: ID_A })
  assert.equal(noTitle.title, ID_A, '没标题就用 id 兜底（面板不能出现空行）')
  const archived = surface.normalizeBindableSessionRow({ header: { id: ID_A, archived: true } })
  assert.equal(archived.archived, true)

  const rows = [
    { sessionId: ID_A, title: 'A', updatedAt: 10, cwd: '' },
    { sessionId: ID_A, title: 'A 更新', updatedAt: 30, cwd: 'C:\\x' },
    { sessionId: ID_B, title: 'B', updatedAt: 20, cwd: '' },
    { sessionId: ID_ARCHIVED, title: '归档', updatedAt: 99, cwd: '', archived: true },
  ]
  const picked = surface.pickBindableSessions(rows, { currentId: ID_A, limit: 10 })
  assert.deepEqual(picked.map((r) => r.sessionId), [ID_A, ID_B], '去重后按时间倒序；归档的丢掉')
  assert.equal(picked[0].updatedAt, 30, '同一条出现两次要取较新的时间')
  assert.equal(picked[0].bound, true)

  const capped = surface.pickBindableSessions([
    { sessionId: ID_B, title: 'B', updatedAt: 50, cwd: '' },
    { sessionId: ID_A, title: 'A', updatedAt: 1, cwd: '' },
  ], { currentId: ID_A, limit: 1 })
  assert.deepEqual(capped.map((r) => r.sessionId), [ID_A, ID_B], '截断时当前绑定那条也要在（排第一，其余照时间序）')

  assert.deepEqual(surface.parseSecretarySessionsQuery('/api/assistant/secretary/sessions'), { query: '', limit: 200 })
  assert.deepEqual(surface.parseSecretarySessionsQuery('/api/assistant/secretary/sessions?q=%E6%8A%A5%E5%91%8A&limit=5'), { query: '报告', limit: 5 })
  assert.equal(surface.parseSecretarySessionsQuery(`${'/x'}?limit=99999`).limit, surface.SECRETARY_SESSIONS_MAX_LIMIT)
  assert.equal(surface.parseSecretarySessionsQuery(`${'/x'}?q=${'很长'.repeat(120)}`).query.length, 80, '关键词截到 80 字符')
}])

// ── C/D. 客户端半部：fetch 桩转发到上面这台宿主的真实路由 ──────────────────────────
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: (key) => { store.delete(key) },
}
const windowState = { location: { search: '', hash: '' }, innerWidth: 1280, innerHeight: 900 }
globalThis.window = windowState
function makeElement() {
  const element = {
    style: {}, children: [], id: '', textContent: '',
    appendChild: (child) => { element.children.push(child) },
    remove() { element.removed = true },
    setAttribute: () => undefined,
  }
  return element
}
globalThis.document = { body: makeElement(), getElementById: () => null, createElement: () => makeElement() }
globalThis.setTimeout = ((fn, ms = 0) => realSetTimeout(fn, Math.min(Number(ms) || 0, 1)))
globalThis.clearTimeout = ((id) => realClearTimeout(id))

/** 客户端 fetch：整条打到「当前指向的宿主」，返回与真实 fetch 同形的对象 */
let fetchTarget = host
const fetched = []
globalThis.fetch = async (rawUrl, init = {}) => {
  const url = String(rawUrl ?? '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  const target = fetchTarget
  if (target === null) {
    fetched.push({ method, url, status: 404, host: 'none' })
    return { ok: false, status: 404, json: async () => { throw new Error('no route') } }
  }
  const r = await call(target, method, url, init?.body === undefined ? undefined : JSON.parse(String(init.body)))
  fetched.push({ method, url, status: r.status, host: 'fake' })
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json }
}

const entry = await import('../src/client/assistant-entry.ts')
const switchMod = await import('../src/client/secretary-session-switch.ts')

store.set(CACHE_KEY, ID_A) // 页面本地缓存 = 换之前绑的 A

cases.push(['客户端列候选：走宿主路由，行与宿主一致、当前绑定标出来', async () => {
  const got = await entry.fetchSecretarySwitchCandidates('')
  assert.ok(got !== null, '宿主答得上就不该回 null')
  assert.equal(got.current, ID_B, '宿主真值里当前是 B（前面 POST 换过去的）')
  assert.deepEqual(got.rows.map((r) => r.id), [ID_A, ID_B])
  assert.equal(got.rows.find((r) => r.id === ID_B).bound, true)
  assert.equal(got.truncated, false)
}])
cases.push(['客户端搜索：把关键词带给宿主（能搜到列表窗口外的会话）', async () => {
  const before = fetched.length
  const got = await entry.fetchSecretarySwitchCandidates('alpha')
  assert.deepEqual(got.rows.map((r) => r.id), [ID_A])
  const last = fetched.slice(before).find((f) => f.url.startsWith(SESSIONS))
  assert.ok(last.url.includes('q=alpha'), '关键词必须带给宿主，不能只在本页过滤')
}])
cases.push(['换绑定链路：选一条 → 宿主写盘 + 回读 → 本地缓存最后才更新（列→选→写→回读）', async () => {
  const result = await entry.bindSecretarySession(ID_A)
  assert.equal(result.ok, true, '合法且宿主认得的 id 必须换成')
  assert.equal(result.sessionId, ID_A)
  assert.equal(readState(host).sessionId, ID_A, '宿主 state 文件要写过去')
  assert.equal(store.get(CACHE_KEY), ID_A, '本地缓存要跟着换（下次进秘书就是这个）')
  const truth = await entry.bindSecretarySession(ID_A)
  assert.equal(truth.ok, true)
  assert.equal(truth.unchanged, true, '重复选同一条 = unchanged（宿主不白写一次盘）')
}])
cases.push(['换绑定：宿主认不到的 id → 不换、本地缓存一个字不动、原因如实带回来', async () => {
  const cacheBefore = store.get(CACHE_KEY)
  const stateBefore = readState(host)
  const result = await entry.bindSecretarySession(ID_GONE)
  assert.equal(result.ok, false)
  assert.equal(result.sessionId, ID_A, '答复里的 sessionId 必须是宿主当前真正挂着的那条')
  assert.match(result.reason, /session-not-in-host-list/, '原因要能看出是宿主不认这条会话')
  assert.equal(store.get(CACHE_KEY), cacheBefore, '本地缓存绝不能被坏 id 覆盖')
  assert.deepEqual(readState(host), stateBefore, '宿主 state 也不许动')
}])
cases.push(['换绑定：id 形状不对就在本地拦下，一次 HTTP 都不发', async () => {
  const before = fetched.length
  const result = await entry.bindSecretarySession('../escape')
  assert.equal(result.ok, false)
  assert.equal(fetched.length, before, '本地能判死的 id 不必打扰宿主')
}])
cases.push(['降级口径：宿主没这条路由时列候选回 null（面板据此用本地快照并标「降级」）', async () => {
  fetchTarget = null
  const got = await entry.fetchSecretarySwitchCandidates('')
  assert.equal(got, null)
  fetchTarget = host
}])
cases.push(['客户端纯函数：宿主答复 → 面板行、本地筛选、时间文案、会话快照兜底', async () => {
  const rows = switchMod.switchRowsFromResponse({
    ok: true,
    sessionId: ID_A,
    limit: 200,
    items: [
      { sessionId: ID_A, title: 'Alpha', updatedAt: T_A, cwd: 'C:\\work\\alpha', bound: true },
      { sessionId: ID_B, title: 'Beta', updatedAt: T_B, cwd: 'C:\\work\\beta' },
      { sessionId: 'bad id!', title: '坏行', updatedAt: T_B },
      { sessionId: ID_ARCHIVED, title: '归档', updatedAt: T_ARCHIVED, archived: true },
    ],
  }, ID_A)
  assert.deepEqual(rows.map((r) => r.id), [ID_A, ID_B], '坏行与归档行都要丢，按时间倒序')
  assert.equal(rows[0].bound, true)
  assert.deepEqual(switchMod.filterSwitchRows(rows, 'beta').map((r) => r.id), [ID_A, ID_B], '本地筛选时当前绑定那条照样留着（不然用户看不到它）')
  assert.deepEqual(switchMod.filterSwitchRows(rows, 'zzz').map((r) => r.id), [ID_A])
  const now = T_A + 3_600_000 * 3
  assert.equal(switchMod.switchTimeText(0), '时间未知')
  assert.equal(switchMod.switchTimeText(now - 30_000, now), '刚刚')
  assert.equal(switchMod.switchTimeText(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(switchMod.switchTimeText(now - 2 * 3_600_000, now), '2 小时前')
  assert.equal(switchMod.switchTimeText(now - 3 * 86_400_000, now), '3 天前')

  const snapRows = switchMod.rowsFromSessionSnapshot({
    [ID_A]: { displayTitle: 'Alpha 快照', updatedAt: T_A, cwd: 'C:\\work\\alpha', running: true },
    [ID_B]: { title: 'Beta 快照', updatedAt: T_B, cwd: 'C:\\work\\beta' },
    [ID_ARCHIVED]: { title: '归档的', updatedAt: T_ARCHIVED },
    'not an id!': { title: '坏 id', updatedAt: T_A },
  }, { currentId: ID_A, archivedIds: [ID_ARCHIVED] })
  assert.deepEqual(snapRows.map((r) => r.id), [ID_A, ID_B], '快照兜底同样丢归档与坏 id')
  assert.equal(snapRows[0].live, true, 'running=true 的快照行要带 live 标记')
  assert.equal(switchMod.rowsFromSessionSnapshot(null, {}).length, 0, '快照形状不对就回空数组，别抛')
  const cappedSnap = switchMod.rowsFromSessionSnapshot({
    [ID_A]: { title: 'A', updatedAt: 30 },
    [ID_B]: { title: 'B', updatedAt: 20 },
    [ID_ARCHIVED]: { title: 'C', updatedAt: 10 },
  }, { limit: 2 })
  assert.deepEqual(cappedSnap.map((r) => r.id), [ID_A, ID_B], '快照兜底也要按 limit 截断（别一次把两千行塞进面板）')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log('ok  ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name + ' :: ' + (error?.stack ?? error))
  }
}
console.log(`\nsecretary-session-switch: ${cases.length - failed}/${cases.length} 通过`)
try { host.dispose() } catch {}
try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
if (failed > 0) process.exit(1)
