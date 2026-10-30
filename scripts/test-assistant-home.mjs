// 私人助手「家」目录与路由的组装测试：
//   - apply 前就有 AGENTS.md / journal / notes / outputs / archive（会话一建就有人设，产物有地方放）；
//   - GET /api/assistant/home 返回真实目录、体积、文件清单、容量上限；
//   - GET /api/assistant/memory 从 mnemon 运行时目录读回 USER/MEMORY，并给出条目数组；
//   - 老 AGENTS.md（v1 或用户手改）只追加缺的规矩小节，不整份覆盖；
//   - tidy：outputs/ 过期删；journal/notes 溢出**只归档不删**；
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

assert.deepEqual(
  routes.map((r) => r.path),
  [
    '/api/assistant/home',
    '/api/assistant/memory',
    '/api/assistant/memory-entry-delete',
    '/api/assistant/memory-clear',
    '/api/assistant/tidy',
  ],
  '注册五条助手路由（记忆写回的两条是 POST）',
)
assert.ok(existsSync(join(home, 'AGENTS.md')), 'AGENTS.md 已写入')
for (const subdir of ['journal', 'notes', 'outputs', 'archive']) {
  assert.ok(existsSync(join(home, subdir)), `${subdir}/ 已建`)
}
const agents = readFileSync(join(home, 'AGENTS.md'), 'utf8')
assert.ok(agents.includes('私人助手'), '人设文案存在')
assert.ok(agents.includes('建项目卡片'), '建卡判据写进人设')
assert.ok(agents.includes('收工'), '收工蒸馏规则写进人设')
assert.ok(agents.includes('家目录规矩'), '家目录规矩写进人设')
assert.ok(agents.includes('归档规矩'), '归档规矩写进人设')
// 仓库模板不写死本机人名：模板里出现的「主人」称谓不能变成具体姓名
assert.ok(!/陈|潘某|Administrator/.test(agents), 'AGENTS.md 模板里没有本机个人化内容')

const call = async (path, method = 'GET', body) => {
  const route = routes.find((r) => r.path === path)
  const out = { status: 0, body: '' }
  const req = { method, url: path }
  if (body !== undefined) {
    // 假请求：注册 'data' 时立刻把 body 推一段，注册 'end' 时收尾（路由的 readJsonBody 就这么用）
    const payload = Buffer.from(JSON.stringify(body))
    req.on = (event, cb) => {
      if (event === 'data') cb(payload)
      else if (event === 'end') cb()
    }
  }
  await route.handler(req, {
    writeHead: (status) => { out.status = status },
    end: (text) => { out.body = text },
  })
  return { status: out.status, json: JSON.parse(out.body || '{}') }
}

const homeRes = await call('/api/assistant/home')
assert.equal(homeRes.status, 200)
assert.equal(homeRes.json.dir, home, 'home 路由返回助手目录')
assert.equal(homeRes.json.hasAgents, true)
assert.ok(homeRes.json.usage.limits.journalMaxFiles > 0, '容量上限报告出来')
assert.ok('capsReached' in homeRes.json.usage, '有没有到上限也报告')
assert.ok(Array.isArray(homeRes.json.files.journal), '文件清单（journal）是数组')

// 记忆从 mnemon 运行时目录读（真值位置）
writeFileSync(join(runtime, 'USER.md'), '用户档案内容', 'utf8')
writeFileSync(join(runtime, 'MEMORY.md'), '记忆内容A\n§\n记忆内容B', 'utf8')
const memRes = await call('/api/assistant/memory')
assert.equal(memRes.status, 200)
assert.equal(memRes.json.user, '用户档案内容')
assert.equal(memRes.json.memory, '记忆内容A\n§\n记忆内容B')
const memoryTarget = memRes.json.targets.find((t) => t.target === 'memory')
assert.equal(memoryTarget.entries.length, 2, 'MEMORY.md 被拆成两条条目')
assert.equal(memoryTarget.entries[1].content, '记忆内容B')
// 没有 memories.json（这个测试的 runtime 目录里只有投影）→ 写回不可用，但必须说清楚
assert.equal(memoryTarget ? memRes.json.writable : true, false)
assert.ok(memRes.json.note.includes('memories.json'), '读不到真源时给出原因')
const deleteRes = await call('/api/assistant/memory-entry-delete', 'POST', { target: 'memory', content: '记忆内容A' })
assert.equal(deleteRes.status, 409)
assert.equal(deleteRes.json.ok, false)
assert.equal(deleteRes.json.error, 'store-unavailable')

// 真源存在时：删除要备份 + 改真源 + 改投影
writeFileSync(join(runtime, 'memories.json'), JSON.stringify({
  version: 1,
  entries: [
    { content: '记忆内容A', target: 'memory', importance: 'normal' },
    { content: '记忆内容B', target: 'memory', importance: 'critical' },
    { content: '用户档案内容', target: 'user', importance: 'critical' },
  ],
}), 'utf8')
const del = await call('/api/assistant/memory-entry-delete', 'POST', { target: 'memory', content: '记忆内容A', mode: 'exact' })
assert.equal(del.status, 200)
assert.equal(del.json.ok, true)
assert.equal(del.json.storeRemoved, 1)
assert.equal(del.json.projectionRemoved, 1)
assert.equal(del.json.restartRequired, true, '写回要重启 DSH 才生效')
assert.ok(del.json.backups.length >= 1, '删之前先备份')
const storeAfter = JSON.parse(readFileSync(join(runtime, 'memories.json'), 'utf8'))
assert.equal(storeAfter.entries.length, 2, '真源里只少一条')
assert.equal(readFileSync(join(runtime, 'MEMORY.md'), 'utf8').trim(), '记忆内容B', '投影同步')
assert.ok(readFileSync(join(runtime, 'USER.md'), 'utf8').includes('用户档案内容'), 'user 侧不许动')

// 清空一侧要先显式确认，否则拒绝
const unconfirmed = await call('/api/assistant/memory-clear', 'POST', { target: 'memory' })
assert.equal(unconfirmed.status, 400)
assert.equal(unconfirmed.json.error, 'need-confirmation')
const cleared = await call('/api/assistant/memory-clear', 'POST', { target: 'memory', confirm: 'DELETE-ALL' })
assert.equal(cleared.json.ok, true)
assert.equal(cleared.json.storeRemoved, 1, 'memory 侧只剩一条（前一步已删一条）')
assert.equal(readFileSync(join(runtime, 'MEMORY.md'), 'utf8'), '', 'memory 侧清空')
assert.ok(readFileSync(join(runtime, 'USER.md'), 'utf8').includes('用户档案内容'), 'user 侧仍然保留')

// tidy：outputs 里 30 天前的删掉，昨天的留着；journal 里的老日志**搬进 archive，不删**
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
assert.equal(tidyRes.json.removed, 1, 'outputs 只删过期的那一个')
assert.equal(existsSync(oldFile), false, '过期文件已删')
assert.equal(existsSync(newFile), true, '未过期文件保留')
assert.equal(existsSync(journalFile), false, 'journal 老文件已从 journal/ 搬走')
assert.equal(tidyRes.json.rotation.journalArchived, 1, 'journal 归档一条')
const archived = join(home, 'archive', 'journal', '2020', '2020-01-01.md')
assert.ok(existsSync(archived), '老日志在 archive/ 里还在')
assert.equal(readFileSync(archived, 'utf8'), '老日志', '归档内容一字不少')
const getTidy = await call('/api/assistant/tidy')
assert.equal(getTidy.status, 200)
assert.ok(getTidy.json.usage.totalBytes >= 0, 'GET 只报告不删')
assert.ok(getTidy.json.usage.archiveBytes > 0, '归档体积报告出来')

// 用户手改过 AGENTS.md：再初始化一次不能覆盖
writeFileSync(join(home, 'AGENTS.md'), '我自己的规矩', 'utf8')
const second = registerAssistantHome({ webServer: { register: () => {} } })
assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '我自己的规矩', '不覆盖手改内容')
second()

// 老 v1 文件缺「家目录规矩」时只追加那一节，不动原有正文
writeFileSync(join(home, 'AGENTS.md'), '<!-- dsh-assistant:assistant-home v1 -->\n# 旧人设\n自己的话')
const third = registerAssistantHome({ webServer: { register: () => {} } })
const migrated = readFileSync(join(home, 'AGENTS.md'), 'utf8')
assert.ok(migrated.startsWith('<!-- dsh-assistant:assistant-home v1 -->\n# 旧人设\n自己的话'), '原有正文不变')
assert.ok(migrated.includes('<!-- dsh-assistant:home-rules v2 -->'), '追加了家目录规矩')
assert.ok(migrated.includes('<!-- dsh-assistant:home-rules v3 -->'), '追加了归档规矩')
third()

dispose()
rmSync(home, { recursive: true, force: true })
console.log('ok test-assistant-home: 41 assertions')
