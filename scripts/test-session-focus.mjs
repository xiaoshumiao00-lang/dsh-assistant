/**
 * 单测/自查：新建会话后的聚焦流程（src/client/sessionFocus.ts）。
 *
 * 直接用 node 跑（Node ≥ 22.18 默认支持 TS 类型剥离）：
 *   node scripts/test-session-focus.mjs
 *
 * 覆盖六种宿主行为，全部注入虚拟时钟（不真等 4 秒）：
 *   1. 正常：会话已在列表，openSession 立即生效；
 *   2. 迟到：占位行缺失，refresh() 后才入列（验证 refreshed 与二次等待）；
 *   3. 竞争：openSession 前两次抛 unknown session（实测根因），第三次成功；
 *   4. 无效：openSession 不抛也不切（selection 不变），必须如实报 opened=false；
 *   5. 无校验字段的旧宿主：接受即算成功；
 *   6. 没有 uiWorkspace：退化到 sessions.open。
 */
import assert from 'node:assert/strict'
import { focusSessionInHost } from '../src/client/sessionFocus.ts'

/** 虚拟时钟：sleep 推进 now，不真等待 */
function clock() {
  let t = 1_000_000
  return {
    now: () => t,
    sleep: async (ms) => { t += ms },
  }
}

function listOf(ids) {
  const byId = {}
  for (const id of ids) byId[id] = { id, running: false, updatedAt: 1 }
  return { ids: [...ids], byId, current: '' }
}

const cases = []

// 1. 正常：已在列表，openSession 一次生效
cases.push(['已在列表 → 一次打开成功', async () => {
  const c = clock()
  const list = listOf(['new'])
  const selection = {
    current: '',
    getSnapshot() { return { sessionId: this.current } },
    set(v) { this.current = v },
  }
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {}, refreshCalls: 0, refresh() { this.refreshCalls++ } },
    uiWorkspace: { openSession(id) { selection.set(id) }, selection },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(r.opened, true)
  assert.equal(r.inList, true)
  assert.equal(r.refreshed, false)
  assert.equal(r.attempts, 1)
  assert.equal(selection.current, 'new')
  assert.equal(bridge.sessions.refreshCalls, 0)
}])

// 2. 迟到：列表里没有，refresh() 之后才出现
cases.push(['列表迟到 → 自动重拉后打开', async () => {
  const c = clock()
  const list = listOf([])
  let refreshed = 0
  const selection = { current: '', getSnapshot() { return { sessionId: this.current } }, set(v) { this.current = v } }
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {}, refresh() { refreshed++; list.ids.push('new'); list.byId.new = { id: 'new' } } },
    uiWorkspace: { openSession(id) { selection.set(id) }, selection },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(r.refreshed, true)
  assert.equal(refreshed, 1)
  assert.equal(r.inList, true)
  assert.equal(r.opened, true)
}])

// 3. 竞争：前两次 retain 抛 unknown session，第三次成功（实测踩到的形状）
cases.push(['openSession 前两次抛错 → 第三次成功', async () => {
  const c = clock()
  const list = listOf(['new'])
  const selection = { current: 'old', getSnapshot() { return { sessionId: this.current } }, set(v) { this.current = v } }
  let calls = 0
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {} },
    uiWorkspace: {
      openSession(id) {
        calls++
        if (calls < 3) throw new Error('sessions.retain: unknown session ' + id)
        selection.set(id)
      },
      selection,
    },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(calls, 3)
  assert.equal(r.attempts, 3)
  assert.equal(r.opened, true)
  assert.equal(selection.current, 'new')
}])

// 4. 无效：openSession 不抛也不切 → 必须如实报失败（不能假装成功）
cases.push(['openSession 空转 → 如实报失败', async () => {
  const c = clock()
  const list = listOf(['new'])
  const selection = { current: 'old', getSnapshot() { return { sessionId: this.current } }, set(v) { this.current = v } }
  let calls = 0
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {} },
    uiWorkspace: { openSession() { calls++ }, selection },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(calls, 3)
  assert.equal(r.opened, false)
  assert.equal(r.inList, true)
  assert.equal(r.reason, 'open-not-confirmed')
  assert.equal(r.current, 'old')
}])

// 5. 旧宿主：既没有 selection 也没有 list.current → 接受即成功
cases.push(['无校验字段 → 接受即成功', async () => {
  const c = clock()
  let opened = ''
  const bridge = {
    list: { getSnapshot: () => ({ ids: ['new'], byId: { new: { id: 'new' } } }) },
    sessions: { retainAgentScope() {} },
    uiWorkspace: { openSession(id) { opened = id } },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(opened, 'new')
  assert.equal(r.opened, true)
  assert.equal(r.attempts, 1)
}])

// 6. 没有 uiWorkspace（0.1.x）→ 退化为 sessions.open
cases.push(['无 uiWorkspace → 退化 sessions.open', async () => {
  const c = clock()
  let opened = ''
  const bridge = {
    list: { getSnapshot: () => ({ ids: ['new'], byId: { new: { id: 'new' } }, current: '' }) },
    sessions: { retainAgentScope() {}, open(id) { opened = id } },
    uiWorkspace: null,
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(opened, 'new')
  assert.equal(r.opened, true)
}])

// 7. 空 id：直接返回，不做任何宿主调用
cases.push(['空会话 id → 直接返回', async () => {
  const c = clock()
  const r = await focusSessionInHost({}, '', c)
  assert.equal(r.opened, false)
  assert.equal(r.reason, 'no-session-id')
}])

// 8. 白屏根因兜底：空白会话 history 流卡在 loading → resync 一次后变 open
cases.push(['空白会话卡 loading → resync 后 settled', async () => {
  const c = clock()
  const list = listOf(['new'])
  list.byId.new.blank = true
  const selection = { current: '', getSnapshot() { return { sessionId: this.current } }, set(v) { this.current = v } }
  let state = 'loading'
  let resyncs = 0
  const session = {
    getSnapshot: () => ({ openState: state, blank: true }),
    resync: async () => { resyncs++; state = 'open' },
  }
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {}, binding: (id) => (id === 'new' ? { session } : undefined) },
    uiWorkspace: { openSession(id) { selection.set(id) }, selection },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(r.opened, true)
  assert.equal(r.resyncs, 1)
  assert.equal(resyncs, 1)
  assert.equal(r.openState, 'open')
  assert.equal(r.settled, true)
}])

// 9. 非空白会话卡 loading（可能真在加载大历史）→ 不许乱 resync，也不算「没落定」
cases.push(['非空白会话 loading → 不 resync、settled=true', async () => {
  const c = clock()
  const list = listOf(['new'])
  list.byId.new.blank = false
  const selection = { current: '', getSnapshot() { return { sessionId: this.current } }, set(v) { this.current = v } }
  let resyncs = 0
  const session = {
    getSnapshot: () => ({ openState: 'loading', blank: false }),
    resync: async () => { resyncs++ },
  }
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {}, binding: () => ({ session }) },
    uiWorkspace: { openSession(id) { selection.set(id) }, selection },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(r.opened, true)
  assert.equal(resyncs, 0)
  assert.equal(r.resyncs, 0)
  assert.equal(r.openState, 'loading')
  assert.equal(r.blank, false)
  assert.equal(r.settled, true)
}])

// 10. 历史流已经 open → 不做任何多余动作
cases.push(['已 open 的会话 → 不 resync', async () => {
  const c = clock()
  const list = listOf(['new'])
  list.byId.new.blank = true
  const selection = { current: '', getSnapshot() { return { sessionId: this.current } }, set(v) { this.current = v } }
  let resyncs = 0
  const session = { getSnapshot: () => ({ openState: 'open', blank: true }), resync: async () => { resyncs++ } }
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {}, binding: () => ({ session }) },
    uiWorkspace: { openSession(id) { selection.set(id) }, selection },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(r.resyncs, 0)
  assert.equal(resyncs, 0)
  assert.equal(r.openState, 'open')
  assert.equal(r.settled, true)
}])

// 11. 空白会话 loading 怎么 resync 都不好 → 最多 2 次，如实报 settled=false
cases.push(['resync 也救不回来 → 上限 2 次、settled=false', async () => {
  const c = clock()
  const list = listOf(['new'])
  list.byId.new.blank = true
  const selection = { current: '', getSnapshot() { return { sessionId: this.current } }, set(v) { this.current = v } }
  let resyncs = 0
  const session = { getSnapshot: () => ({ openState: 'loading', blank: true }), resync: async () => { resyncs++ } }
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {}, binding: () => ({ session }) },
    uiWorkspace: { openSession(id) { selection.set(id) }, selection },
  }
  const r = await focusSessionInHost(bridge, 'new', c)
  assert.equal(resyncs, 2)
  assert.equal(r.settled, false)
  assert.equal(r.openState, 'loading')
}])

// 12. 性能回归：onOpened 必须先于空白历史修复触发，界面不用等 resync 才切换
cases.push(['打开确认先回调 → 历史修复不阻塞界面切换', async () => {
  const c = clock()
  const list = listOf(['new-fast'])
  list.byId['new-fast'].blank = true
  const selection = { current: '', getSnapshot() { return { sessionId: this.current } }, set(v) { this.current = v } }
  let state = 'loading'
  let resyncs = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const session = {
    getSnapshot: () => ({ openState: state, blank: true }),
    resync: async () => { resyncs++; await gate; state = 'open' },
  }
  const bridge = {
    list: { getSnapshot: () => list },
    sessions: { retainAgentScope() {}, binding: () => ({ session }) },
    uiWorkspace: { openSession(id) { selection.set(id) }, selection },
  }
  let openedCalls = 0
  const pending = focusSessionInHost(bridge, 'new-fast', { ...c, onOpened: () => { openedCalls++ } })
  for (let i = 0; i < 30 && resyncs === 0; i++) await Promise.resolve()
  assert.equal(openedCalls, 1)
  assert.equal(resyncs, 1)
  let completed = false
  void pending.then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  release()
  const r = await pending
  assert.equal(r.opened, true)
  assert.equal(r.settled, true)
  assert.equal(r.openState, 'open')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL ' + name + '\n       ' + String(err && err.message || err))
  }
}
console.log('')
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAILED ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
