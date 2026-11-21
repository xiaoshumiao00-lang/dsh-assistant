/**
 * 主动服务卡片宿主半部单测（不启动 DSH）：
 *   node scripts/test-assistant-proactive.mjs
 *
 * 覆盖：
 *   - 卡片归一（缺字段/脏字段都不炸，title 必填）；
 *   - 会话过滤：绑本会话的 + 绑「当前固定秘书会话」（sessionId=''）的才可见；
 *   - 路由：GET 回卡组、POST 追加、DELETE 清空、超大 body 拒绝；
 *   - 首次启动种一张示例卡（明日武汉出差），只种一次；
 *   - proactive_card 工具定义与「只在秘书会话里可调用」。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const lib = await import('../lib/index.js')
const surface = lib.assistantProactiveTestSurface
const secretarySessionRef = lib.assistantSecretaryTestSurface.secretarySessionRef

function fakeServer() {
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
function fakeReq(method, body, url = surface.ASSISTANT_PROACTIVE_ROUTE) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = url
  return req
}
function fakeRes() {
  const out = { status: 0, body: '' }
  out.writeHead = (status) => { out.status = status }
  out.end = (payload) => { out.body = String(payload ?? '') }
  return out
}
async function call(server, method, body, url) {
  const route = server.exact.get(surface.ASSISTANT_PROACTIVE_ROUTE)
  assert.ok(route, 'proactive route registered')
  const res = fakeRes()
  await route.handler(fakeReq(method, body, url), res)
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) }
}

const cases = []

cases.push(['卡片归一：脏数据不炸、title 必填', () => {
  assert.equal(surface.normalizeCard(null), null)
  assert.equal(surface.normalizeCard({ summary: '没有标题' }), null)
  const card = surface.normalizeCard({ title: ' 主动关心 ', items: ['a', '', 3], extra: 1 })
  assert.equal(card.title, '主动关心')
  assert.deepEqual(card.items, ['a', '3'])
  assert.equal(card.badge, '主动服务')
  assert.match(card.time, /^今天 \d\d:\d\d$/)
  assert.equal(card.sessionId, '')
}])

cases.push(['示例卡内容符合交付要求', () => {
  const card = surface.demoCard(new Date('2026-11-20T07:40:00+08:00'))
  assert.equal(card.title, '主动关心 · 明日武汉出差')
  const all = [card.summary, ...card.items, card.details].join('\n')
  assert.match(all, /8–14℃/)
  assert.match(all, /多云转小雨/)
  assert.match(all, /G1545/)
  assert.match(all, /孝感东 08:12/)
  assert.match(all, /汉口 08:49/)
  assert.match(all, /10:30 华工·结构实验室开会/)
  assert.match(all, /07:30 出发/)
  assert.equal(card.time, '今天 07:40')
  assert.ok(card.details.length > 50)
}])

cases.push(['会话过滤：只给绑定会话与当前秘书会话', () => {
  const cards = [
    surface.normalizeCard({ id: 'a', title: 'A', sessionId: 'sec-1' }),
    surface.normalizeCard({ id: 'b', title: 'B', sessionId: '' }),
    surface.normalizeCard({ id: 'c', title: 'C', sessionId: 'other' }),
  ]
  const forSecretary = surface.cardsForSession(cards, 'sec-1', 'sec-1').map((c) => c.id)
  assert.deepEqual(forSecretary.sort(), ['a', 'b'])
  const forOther = surface.cardsForSession(cards, 'other', 'sec-1').map((c) => c.id)
  assert.deepEqual(forOther.sort(), ['c'])
  assert.deepEqual(surface.cardsForSession(cards, '', 'sec-1'), [])
}])

const root = mkdtempSync(join(tmpdir(), 'assistant-proactive-'))
const server = fakeServer()
const ctx = {
  webServer: server,
  get: (name) => (name === 'profileContext' ? { dir: root } : undefined),
  logger: { warn: () => {} },
}
const dispose = surface.registerAssistantProactive(ctx)

cases.push(['首次启动种一张示例卡（只种一次）', async () => {
  const file = join(root, 'dsh-assistant-proactive.json')
  assert.ok(existsSync(file), '卡片文件已写入')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(state.cards.length, 1)
  assert.equal(state.cards[0].title, '主动关心 · 明日武汉出差')
  assert.ok(existsSync(`${file}.seeded`), '种卡 marker 已写')
  // 重新注册一次（模拟重启）：不会再种第二张
  const again = surface.registerAssistantProactive(ctx)
  const state2 = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(state2.cards.length, 1)
  again()
}])

cases.push(['路由：GET 只回秘书会话可见的卡', async () => {
  secretarySessionRef.id = 'sec-1'
  const res = await call(server, 'GET', undefined, `${surface.ASSISTANT_PROACTIVE_ROUTE}?sessionId=sec-1`)
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.cards.length, 1)
  assert.equal(res.json.cards[0].title, '主动关心 · 明日武汉出差')
  const other = await call(server, 'GET', undefined, `${surface.ASSISTANT_PROACTIVE_ROUTE}?sessionId=someone-else`)
  assert.deepEqual(other.json.cards, [])
}])

cases.push(['路由：POST 追加一张卡后立刻可见', async () => {
  const body = JSON.stringify({ title: '主动关心 · 论文进度', summary: '第5章改完了', items: ['已改 3 表'], details: '详情', time: '今天 09:00' })
  const res = await call(server, 'POST', body)
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.card.title, '主动关心 · 论文进度')
  const list = await call(server, 'GET', undefined, `${surface.ASSISTANT_PROACTIVE_ROUTE}?sessionId=sec-1`)
  assert.equal(list.json.cards.length, 2)
  assert.equal(list.json.cards[1].title, '主动关心 · 论文进度')
}])

cases.push(['路由：坏 body / 超大 body 被拒', async () => {
  const bad = await call(server, 'POST', '{"title":""}')
  assert.equal(bad.status, 400)
  const huge = await call(server, 'POST', `{"title":"${'x'.repeat(70 * 1024)}"}`)
  assert.equal(huge.status, 413)
}])

cases.push(['工具：只在秘书会话里可调用', async () => {
  const tool = surface.proactiveCardToolDefinition()
  assert.equal(tool.name, 'proactive_card')
  await assert.rejects(
    () => tool.execute({ title: 'x' }, { agent: { session: { id: 'someone-else' } } }),
    /只能在个人秘书会话里调用/,
  )
  secretarySessionRef.id = 'sec-1'
  const ok = await tool.execute({ title: '主动关心 · 测试', summary: 's' }, { agent: { session: { id: 'sec-1' } } })
  assert.equal(ok.ok, true)
  assert.ok(ok.card_id)
  const list = await call(server, 'GET', undefined, `${surface.ASSISTANT_PROACTIVE_ROUTE}?sessionId=sec-1`)
  assert.ok(list.json.cards.some((card) => card.title === '主动关心 · 测试'))
}])

cases.push(['路由：DELETE 清空', async () => {
  const res = await call(server, 'DELETE')
  assert.equal(res.status, 200)
  const list = await call(server, 'GET', undefined, `${surface.ASSISTANT_PROACTIVE_ROUTE}?sessionId=sec-1`)
  assert.deepEqual(list.json.cards, [])
}])

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
try { dispose() } catch {}
try { rmSync(root, { recursive: true, force: true }) } catch {}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} assistant-proactive`)
