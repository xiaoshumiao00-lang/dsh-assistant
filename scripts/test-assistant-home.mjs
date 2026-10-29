// 私人助手「家」目录与路由的组装测试：
//   - apply 前就有 AGENTS.md / journal / notes（会话一建就有人设）；
//   - /api/assistant/home 返回真实目录，/api/assistant/memory 读回 USER.md / MEMORY.md；
//   - 重复初始化不覆盖用户手改过的 AGENTS.md。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'assistant-home-'))
process.env.DSH_ASSISTANT_HOME = home
process.env.DSH_HOME = home

const { registerAssistantHome } = await import('../lib/index.js')

const routes = []
const dispose = registerAssistantHome({ webServer: { register: (route) => routes.push(route) } })

assert.deepEqual(routes.map((r) => r.path), ['/api/assistant/home', '/api/assistant/memory'], '注册两条路由')
assert.ok(existsSync(join(home, 'AGENTS.md')), 'AGENTS.md 已写入')
assert.ok(existsSync(join(home, 'journal')), 'journal 目录已建')
assert.ok(existsSync(join(home, 'notes')), 'notes 目录已建')
const agents = readFileSync(join(home, 'AGENTS.md'), 'utf8')
assert.ok(agents.includes('私人助手'), '人设文案存在')
assert.ok(agents.includes('建项目卡片'), '建卡判据写进人设')
assert.ok(agents.includes('收工'), '收工蒸馏规则写进人设')

const call = async (path) => {
  const route = routes.find((r) => r.path === path)
  const out = { status: 0, body: '' }
  await route.handler({ method: 'GET', url: path }, {
    writeHead: (status) => { out.status = status },
    end: (body) => { out.body = body },
  })
  return { status: out.status, json: JSON.parse(out.body) }
}

const homeRes = await call('/api/assistant/home')
assert.equal(homeRes.status, 200)
assert.equal(homeRes.json.dir, home, 'home 路由返回助手目录')
assert.equal(homeRes.json.hasAgents, true)

writeFileSync(join(home, 'USER.md'), '用户档案内容', 'utf8')
writeFileSync(join(home, 'MEMORY.md'), '记忆内容', 'utf8')
const memRes = await call('/api/assistant/memory')
assert.equal(memRes.status, 200)
assert.equal(memRes.json.user, '用户档案内容')
assert.equal(memRes.json.memory, '记忆内容')

// 用户手改过 AGENTS.md：再初始化一次不能覆盖
writeFileSync(join(home, 'AGENTS.md'), '我自己的规矩', 'utf8')
const second = registerAssistantHome({ webServer: { register: () => {} } })
assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '我自己的规矩', '不覆盖手改内容')
second()

dispose()
rmSync(home, { recursive: true, force: true })
console.log('ok test-assistant-home: 4 assertions')
