// 私人助手「家」目录与路由的组装测试：
//   - apply 前就有 AGENTS.md / journal / notes / outputs（会话一建就有人设，产物有地方放）；
//   - /api/assistant/home 返回真实目录与体积；/api/assistant/memory 从 mnemon 运行时目录读回 USER/MEMORY；
//   - 老 AGENTS.md（v1 或用户手改）只追加「家目录规矩」，不整份覆盖；
//   - tidy 只清 outputs/ 里过期的文件，journal/notes 一概不碰；
//   - 重复初始化不覆盖用户手改内容。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'assistant-home-'))
const runtime = join(home, '_mnemon-runtime')
mkdirSync(runtime, { recursive: true })
process.env.DSH_ASSISTANT_HOME = home
process.env.DSH_HOME = home
process.env.MNEMON_DATA_DIR = runtime

const { registerAssistantHome } = await import('../lib/index.js')

const routes = []
const dispose = registerAssistantHome({ webServer: { register: (route) => routes.push(route) } })

assert.deepEqual(routes.map((r) => r.path), ['/api/assistant/home', '/api/assistant/memory', '/api/assistant/tidy'], '注册三条路由')
assert.ok(existsSync(join(home, 'AGENTS.md')), 'AGENTS.md 已写入')
assert.ok(existsSync(join(home, 'journal')), 'journal 目录已建')
assert.ok(existsSync(join(home, 'notes')), 'notes 目录已建')
assert.ok(existsSync(join(home, 'outputs')), 'outputs 目录已建')
const agents = readFileSync(join(home, 'AGENTS.md'), 'utf8')
assert.ok(agents.includes('私人助手'), '人设文案存在')
assert.ok(agents.includes('建项目卡片'), '建卡判据写进人设')
assert.ok(agents.includes('收工'), '收工蒸馏规则写进人设')
assert.ok(agents.includes('家目录规矩'), '家目录规矩写进人设')

const call = async (path, method = 'GET') => {
  const route = routes.find((r) => r.path === path)
  const out = { status: 0, body: '' }
  await route.handler({ method, url: path }, {
    writeHead: (status) => { out.status = status },
    end: (body) => { out.body = body },
  })
  return { status: out.status, json: JSON.parse(out.body) }
}

const homeRes = await call('/api/assistant/home')
assert.equal(homeRes.status, 200)
assert.equal(homeRes.json.dir, home, 'home 路由返回助手目录')
assert.equal(homeRes.json.hasAgents, true)

// 记忆从 mnemon 运行时目录读（真值位置）
writeFileSync(join(runtime, 'USER.md'), '用户档案内容', 'utf8')
writeFileSync(join(runtime, 'MEMORY.md'), '记忆内容', 'utf8')
const memRes = await call('/api/assistant/memory')
assert.equal(memRes.status, 200)
assert.equal(memRes.json.user, '用户档案内容')
assert.equal(memRes.json.memory, '记忆内容')

// tidy：outputs 里 30 天前的删掉，昨天的留着；journal/notes 里再老也不动
const oldFile = join(home, 'outputs', 'old-script.py')
const newFile = join(home, 'outputs', 'yesterday.txt')
const journalFile = join(home, 'journal', '2020-01-01.md')
writeFileSync(oldFile, 'x'.repeat(100), 'utf8')
writeFileSync(newFile, 'keep me', 'utf8')
writeFileSync(journalFile, '老日志', 'utf8')
const now = Date.now()
const thirtyDays = now - 30 * 24 * 60 * 60 * 1000
const oneDay = now - 24 * 60 * 60 * 1000
utimesSync(oldFile, new Date(thirtyDays), new Date(thirtyDays))
utimesSync(newFile, new Date(oneDay), new Date(oneDay))
utimesSync(journalFile, new Date(thirtyDays), new Date(thirtyDays))

const tidyRes = await call('/api/assistant/tidy', 'POST')
assert.equal(tidyRes.status, 200)
assert.equal(tidyRes.json.removed, 1, '只删过期的那一个')
assert.equal(existsSync(oldFile), false, '过期文件已删')
assert.equal(existsSync(newFile), true, '未过期文件保留')
assert.equal(existsSync(journalFile), true, 'journal 不被清理')
const getTidy = await call('/api/assistant/tidy')
assert.equal(getTidy.status, 200)
assert.ok(getTidy.json.usage.totalBytes >= 0, 'GET 只报告不删')

// 用户手改过 AGENTS.md：再初始化一次不能覆盖
writeFileSync(join(home, 'AGENTS.md'), '我自己的规矩', 'utf8')
const second = registerAssistantHome({ webServer: { register: () => {} } })
assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '我自己的规矩', '不覆盖手改内容')
second()

// 老 v1 文件缺「家目录规矩」时只追加那一节，不动原有正文
writeFileSync(join(home, 'AGENTS.md'), '<!-- dsh-assistant:assistant-home v1 -->\n# 旧人设\n自己的话', 'utf8')
const third = registerAssistantHome({ webServer: { register: () => {} } })
const migrated = readFileSync(join(home, 'AGENTS.md'), 'utf8')
assert.ok(migrated.startsWith('<!-- dsh-assistant:assistant-home v1 -->\n# 旧人设\n自己的话'), '原有正文不变')
assert.ok(migrated.includes('<!-- dsh-assistant:home-rules v2 -->'), '追加了家目录规矩')
third()

dispose()
rmSync(home, { recursive: true, force: true })
console.log('ok test-assistant-home: 18 assertions')
