/**
 * 个人秘书「固定会话失效 → 自动重建并可打开」的客户端链路测试（Node 里模拟浏览器环境）：
 *   node scripts/test-secretary-open-rebuild.mjs
 *
 * 这一条就是 2026-11-21 实测事故的回归测试：
 *   宿主 state 指向 session-33044545…（这条会话已从宿主的会话表里消失，宿主重启后不再注册），
 *   单击悬浮球 → openSession 撞 `sessions.retain: unknown session …` → 旧版重试 8 次后静默放弃
 *   → 用户看到「单击悬浮球什么都没发生」。
 * 现在必须：① 先打开再后台校验；② state 里的会话不在了就新建一条并把 state 指过去、并把页面切到新会话；
 *           ③ 实在建不出来/开不了也至少切到控制室并给出原因（toast），不允许无反应。
 *
 * 只做纯 Node 桩，不起浏览器：assistant-entry.ts 用到的全局（window/localStorage/fetch/document/setTimeout）都在这里造出来。
 */
import assert from 'node:assert/strict'

const DEAD = 'session-33044545-4737-4e86-960d-43f57b357dea'
const SECRETARY_ROUTE = '/api/assistant/secretary'
const HOME_ROUTE = '/api/assistant/home'
const TUOGUAN_ROUTE = '/.dsh-tuoguan/state'
const DIAG_ROUTE = '/api/assistant/open-diag'

// ---- 环境桩（必须在 import 客户端模块之前装好）---------------------------------
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: (key) => { store.delete(key) },
}

const windowState = { location: { search: '', hash: '' } }
globalThis.window = windowState

const madeElements = []
function makeElement() {
  const element = {
    style: {},
    children: [],
    id: '',
    textContent: '',
    appendChild: (child) => { element.children.push(child) },
    remove() { element.removed = true },
    setAttribute: () => undefined,
  }
  madeElements.push(element)
  return element
}
globalThis.document = {
  body: makeElement(),
  getElementById: () => null,
  createElement: () => makeElement(),
}

// 定时桩：延迟一律压到 0（退避序列本身由 test-secretary-open-recovery 断言），保持微任务优先，
// 这样 12s 的 withTimeout 不会抢在假 API 的 promise 之前落。
globalThis.setTimeout = ((fn, ms = 0) => realSetTimeout(fn, Math.min(Number(ms) || 0, 1)))
globalThis.clearTimeout = ((id) => realClearTimeout(id))

// ---- 宿主侧假状态 -------------------------------------------------------------
function makeHost() {
  const host = {
    secretaries: { id: DEAD, calls: [] },
    hostTable: new Set(['session-blank']), // 宿主的会话表：DEAD 不在里面 = 实测状态
    clientTable: new Set(), // 客户端会话列表投影：先什么都不给（模拟「列表还没下发」）
    tuoguanOff: {},
    diag: [],
    home: 'C:\\fake-home-for-assistant',
  }
  return host
}

let host = makeHost()

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

globalThis.fetch = async (rawUrl, init = {}) => {
  const url = String(rawUrl ?? '')
  const path = url.split('?')[0]
  const method = String(init?.method ?? 'GET').toUpperCase()
  host.secretaries.calls.push({ method, path, url })
  if (path === SECRETARY_ROUTE) {
    const wantsVerify = /[?&]verify=1(?:&|$)/.test(url)
    if (method === 'GET' || method === 'HEAD') {
      const payload = {
        ok: true,
        sessionId: host.secretaries.id || null,
        updatedAt: '2026-11-21T10:57:28.613Z',
        dispatchPolicy: 'default-computer-use-v2',
      }
      if (wantsVerify) payload.exists = host.secretaries.id !== '' && host.hostTable.has(host.secretaries.id)
      return jsonResponse(payload)
    }
    if (method === 'DELETE') {
      host.secretaries.id = ''
      return jsonResponse({ ok: true, sessionId: null })
    }
    if (method === 'POST' || method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}'))
      host.secretaries.id = String(body.sessionId ?? '')
      return jsonResponse({ ok: true, sessionId: host.secretaries.id })
    }
  }
  if (path === HOME_ROUTE) return jsonResponse({ ok: true, dir: host.home })
  if (path === TUOGUAN_ROUTE) {
    if (method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'))
      host.tuoguanOff[body.sessionId] = body.on !== true
      return jsonResponse({ ok: true })
    }
    return jsonResponse({ ok: true, off: host.tuoguanOff })
  }
  if (path === DIAG_ROUTE) {
    host.diag.push(JSON.parse(String(init.body ?? '{}')))
    return jsonResponse({ ok: true })
  }
  return jsonResponse({ ok: false, error: 'unknown-route' }, 404)
}

// ---- 客户端模块（桩装好之后才 import）----------------------------------------
const bridge = await import('../src/client/orb-bridge.ts')
const entry = await import('../src/client/assistant-entry.ts')

const { controlRoomStore, setAssistantApi } = bridge
const { openAssistant, lastAssistantOpen, resetSecretaryOpenGuardForTests } = entry

// ---- 假 OrbApi：完全照 client-session-controller 的真实语义 -------------------
function makeApi(options = {}) {
  const state = {
    current: 'session-blank',
    created: [],
    createCount: 0,
    pinned: [],
    renamed: [],
    readOnlyApplied: [],
  }
  const requireKnown = (id) => {
    // 客户端列表里没有这条 → 宿主 session-controller 就是这么报的
    if (!host.clientTable.has(id)) throw new Error(`sessions.retain: unknown session ${id}`)
  }
  const api = {
    currentSessionId: () => state.current,
    openSession: (id) => {
      requireKnown(id)
      state.current = id
    },
    focusSession: async (id) => {
      requireKnown(id)
      state.current = id
    },
    pinSession: async (id) => {
      requireKnown(id)
      state.pinned.push(id)
    },
    unarchiveSession: async (id) => { requireKnown(id) },
    renameSession: async (id) => { state.renamed.push(id) },
    selectModel: async () => undefined,
    sessionRow: () => null,
    permissionOf: (id) => (state.readOnlyApplied.includes(id) ? 'read-only' : 'null'),
    setReadOnly: async (id) => {
      state.readOnlyApplied.push(id)
      return { ok: true, current: 'read-only', applied: true }
    },
    confirmReadOnly: async () => ({ ok: true, current: 'read-only', applied: false }),
    createSession: async (cwd) => {
      if (options.createFails) throw new Error('host refused: 宿主不能建会话')
      state.createCount += 1
      const id = `session-new-${String(state.createCount)}`
      host.hostTable.add(id)
      host.clientTable.add(id)
      state.created.push({ cwd, id })
      return { sessionId: id }
    },
  }
  return { api, state }
}

function resetFixture() {
  host = makeHost()
  store.clear()
  madeElements.length = 0
  windowState.__dshAssistantOpenLog = []
  controlRoomStore.setOpen(false)
  resetSecretaryOpenGuardForTests()
}

function toastTexts() {
  return madeElements.map((element) => String(element.textContent ?? '')).filter((text) => text !== '')
}

function diagSteps() {
  return host.diag.map((entry) => String(entry.step ?? ''))
}

// ---- 断言 --------------------------------------------------------------------
const cases = []

cases.push(['state 指向已不存在的会话：自动重建一条、宿主 state 指过去、页面停在新会话', async () => {
  resetFixture()
  store.set('dsh.assistant.secretary.sessionId', DEAD)
  const { api, state } = makeApi()
  setAssistantApi(api)

  const opened = await openAssistant()
  const result = lastAssistantOpen()

  assert.equal(opened, true, 'openAssistant 应该 resolve true（页面已经停在新会话上）')
  assert.equal(state.createCount, 1, '必须新建一条秘书会话（旧版这里一条都不建）')
  assert.equal(state.created.length, 1)
  assert.ok(result !== null && result.sessionId !== DEAD, '结果必须落在新建的会话上')
  assert.equal(result.recovered, true, '结果必须标记为「重建出来的」')
  assert.equal(result.opened, true, '结果必须带上「开页成功」的观测')
  assert.equal(state.current, result.sessionId, '主面板必须停在重建出来的新会话上')
  assert.equal(host.secretaries.id, result.sessionId, '宿主 state 必须指到新的固定会话')
  assert.equal(store.get('dsh.assistant.secretary.sessionId'), result.sessionId, '本地缓存也要跟上')
  // 旧 state 里的死会话先被摘掉（DELETE），新会话再被写入（POST）
  const methods = host.secretaries.calls.map((call) => `${call.method} ${call.path}`)
  assert.ok(methods.includes(`DELETE ${SECRETARY_ROUTE}`), `必须先 DELETE 死 id，实际=${methods.join(' | ')}`)
  assert.ok(methods.includes(`POST ${SECRETARY_ROUTE}`), '重建后必须把新 id POST 回宿主')
  // 诊断必须落盘：点击意图、开页失败原因、重建过程都要有
  const steps = diagSteps()
  assert.ok(steps.includes('openSession-threw'), '开页失败必须落诊断')
  assert.ok(steps.includes('rebuild-start'), '必须落「重建」诊断')
  assert.ok(steps.includes('rebuild-created'), '必须落「新建成功」诊断')
  assert.ok(steps.includes('rebuild-ok'), '必须落「重建后开页成功」诊断')
  assert.ok(steps.some((step) => step === 'maintenance-verify'), '必须向宿主确认过会话存在性')
}])

cases.push(['同一条固定会话不会重复新建（第二次单击直接开成功）', async () => {
  resetFixture()
  const { api, state } = makeApi()
  setAssistantApi(api)
  const first = await openAssistant()
  const firstId = lastAssistantOpen()?.sessionId
  resetSecretaryOpenGuardForTests()
  const second = await openAssistant()
  assert.equal(first, true)
  assert.equal(second, true)
  assert.equal(lastAssistantOpen()?.sessionId, firstId, '第二次必须复用同一条固定会话')
  assert.equal(state.createCount, 1, '第二次不许再新建会话（防「个人秘疏长出第二条」）')
}])

cases.push(['宿主确认会话还在：绝不新建，多等一轮后兜底控制室（防重复会话的老病）', async () => {
  resetFixture()
  host.hostTable.add(DEAD) // 宿主说「还在」
  store.set('dsh.assistant.secretary.sessionId', DEAD)
  const { api, state } = makeApi() // 客户端列表投影还没下发 → openSession 一直撞 unknown session
  setAssistantApi(api)

  const opened = await openAssistant()
  assert.equal(opened, false, '页面确实开不了：不许当成功')
  assert.equal(state.createCount, 0, '宿主说「会话还在」时绝不新建')
  assert.equal(host.secretaries.id, DEAD, 'state 不许被动走（没确认到不成立就不改）')
  assert.equal(controlRoomStore.getSnapshot(), true, '至少切到控制室，不许点了没反应')
  const texts = toastTexts().join('\n')
  assert.ok(texts.includes('控制室'), '必须给用户看到兜底原因')
  assert.ok(diagSteps().includes('retry-exhausted'), '重试用完要落诊断')
  assert.ok(diagSteps().includes('fallback-console'), '兜底要落诊断')
}])

cases.push(['重建失败（建不出会话）也要切控制室并给出原因', async () => {
  resetFixture()
  store.set('dsh.assistant.secretary.sessionId', DEAD)
  const { api, state } = makeApi({ createFails: true })
  setAssistantApi(api)

  const opened = await openAssistant()
  assert.equal(opened, false)
  assert.equal(state.createCount, 0)
  assert.equal(controlRoomStore.getSnapshot(), true, '建不出会话时也要切到控制室')
  assert.ok(diagSteps().includes('create-session-failed'), '建会话失败要落诊断')
  const texts = toastTexts().join('\n')
  assert.ok(texts.includes('建秘书会话失败'), `toast 要带原因，实际=${texts}`)
}])

cases.push(['宿主 API 没就绪时不静默失败：切到控制室并落诊断', async () => {
  resetFixture()
  setAssistantApi(null)
  const opened = await openAssistant()
  assert.equal(opened, false)
  assert.equal(controlRoomStore.getSnapshot(), true)
  assert.ok(diagSteps().includes('fallback-console'))
}])

cases.push(['诊断链路把「点击意图」也写进宿主日志（host-click-intent 不在本测试里，走 POST）', async () => {
  resetFixture()
  const { api } = makeApi()
  setAssistantApi(api)
  entry.noteAssistantIntent('assistant', 'ball-click')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  assert.ok(host.diag.some((item) => item.step === 'ball-intent' && item.intent === 'assistant'))
  assert.equal(controlRoomStore.getSnapshot(), false, '只是诊断，不许顺带开控制室')
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}
if (failed > 0) {
  console.error(`FAIL ${failed}/${cases.length} secretary-open-rebuild`)
  process.exit(1)
}
console.log(`PASS ${cases.length}/${cases.length} secretary-open-rebuild`)
