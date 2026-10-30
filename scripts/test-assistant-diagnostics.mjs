/** 诊断包脱敏与导出（P1-A）：node scripts/test-assistant-diagnostics.mjs */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const tempHome = mkdtempSync(join(tmpdir(), 'assistant-diag-'))
process.env.DSH_HOME = join(tempHome, '.dsh')
process.env.DSH_ASSISTANT_HOME = join(tempHome, '.dsh', 'assistant')
process.env.DSH_ASSISTANT_CONFIG = join(tempHome, 'config.json')

const assistant = await import('../lib/index.js')
const { redactText, renderDiagnosticsBundle, writeDiagnosticsBundle, assistantDiagnosticsTestSurface, registerAssistantDiagnostics } = assistant

// 造一点「本机像是被人家的目录」的数据：日志、状态、pocket 流水、个人配置
const personalDir = join(tempHome, 'MyPrivateProjects', '论文草稿')
mkdirSync(personalDir, { recursive: true })
writeFileSync(process.env.DSH_ASSISTANT_CONFIG, JSON.stringify({
  newProjectParent: personalDir,
  skillRoot: join(tempHome, '.dsh', 'skills'),
  allowedRoots: [personalDir],
  asrTerms: [{ pattern: '某某昵称', replace: '某某规范名' }],
}), 'utf8')

mkdirSync(join(process.env.DSH_HOME, 'dsh-pocket'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'dsh-pocket', 'diagnostic.jsonl'), [
  JSON.stringify({ kind: 'lan-pair', at: '2026-10-30T10:00:00Z', code: 'auth', msg: 'ok' }),
  JSON.stringify({ kind: 'lan-pair', at: '2026-10-30T10:01:00Z', code: 'auth', msg: 'pin 12345678 wrong' }),
  JSON.stringify({ kind: 'tunnel-start', at: '2026-10-30T10:02:00Z', msg: `token=deadbeefdeadbeefdeadbeefdeadbeef keyPath=${personalDir}\\id_ed25519` }),
  '{ 坏行',
].join('\n') + '\n', 'utf8')

mkdirSync(join(process.env.DSH_HOME, 'profiles', 'desktop', 'dsh-assistant-ball'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'dsh-assistant-focus.log'), `focus start cwd=${personalDir}\nsecond line\n`, 'utf8')
writeFileSync(join(process.env.DSH_HOME, 'profiles', 'desktop', 'dsh-assistant-ball', 'helper.log'), `helper 已退出 1，工作目录 ${personalDir}\n`, 'utf8')
writeFileSync(join(process.env.DSH_HOME, 'profiles', 'desktop', 'dsh-assistant-state.json'), JSON.stringify({
  revision: 12, updatedAt: '2026-10-30T09:00:00Z', projects: { folders: { a: personalDir }, bindings: { a: 's1' }, layouts: { b: 1 }, removed: { c: 1 } },
}), 'utf8')
writeFileSync(join(process.env.DSH_HOME, 'dsh-pocket', 'settings.json'), JSON.stringify({ lanEnabled: false, tunnelToken: 'SECRET_TOKEN_123', pin: '12345678' }), 'utf8')

const cases = []

cases.push(['redactText 把家目录 / 私人目录 / 秘密值都换成标记，并报告替换数', () => {
  const input = [
    `目录 ${personalDir} 在这里`,
    `主目录 ${homedir()} 也在这里`,
    'pin: 12345678',
    'token=abcdefghijklmnop1234567890',
    'Authorization: Bearer abcDEF123xyz==',
    'C:\\Users\\SomeOne\\Desktop\\x.md',
    '/home/someone/notes.md',
  ].join('\n')
  const out = redactText(input)
  assert.ok(out.replaced >= 6, `替换数太少了：${out.replaced}`)
  assert.ok(!out.text.includes(personalDir), '私人目录还在')
  assert.ok(!out.text.includes(homedir()), '家目录还在')
  assert.ok(!/12345678/.test(out.text), 'PIN 值还在')
  assert.ok(!/abcdefghijklmnop/.test(out.text), 'token 值还在')
  assert.ok(!/Bearer abcDEF/.test(out.text), 'Bearer 值还在')
  assert.ok(!/C:\\Users\\SomeOne/.test(out.text), '盘符路径没脱敏')
  assert.ok(!/\/home\/someone/.test(out.text), 'posix 家目录路径没脱敏')
  assert.ok(out.text.includes('<PATH>') || out.text.includes('<ROOT>'), '没看到脱敏标记')
}])

cases.push(['诊断包能拼出来，且里面找不到任何本机绝对路径与秘密', () => {
  const { text, replaced } = renderDiagnosticsBundle({ get: () => undefined })
  assert.ok(text.length > 200, '包是空的')
  assert.ok(replaced > 0, '一点没脱敏就出厂了')
  const bundle = JSON.parse(text)
  assert.ok(bundle.versions.package.startsWith('dsh-assistant@'), '没带插件版本')
  assert.ok(Array.isArray(bundle.notCollected) && bundle.notCollected.length >= 3, '没交代哪些东西故意不导')
  assert.ok(bundle.focusLog.exists === true, '聚焦日志没读到')
  assert.ok(bundle.pocketDiagnostic.total >= 4, 'pocket 诊断流水没读到')
  assert.ok(bundle.stateFiles.assistant.exists === true, '状态文件没读到')
  assert.ok(bundle.stateFiles.assistant.summary.revision === 12, '状态概要没带上 revision')
  assert.ok(Array.isArray(bundle.localConfig.allowedRoots), 'allowlist 没进包')
  // 整包里扫一遍：不许出现本机绝对路径、秘密值、私人目录名
  const banned = [personalDir, homedir(), 'SECRET_TOKEN_123', 'id_ed25519', '论文草稿', '12345678']
  for (const needle of banned) assert.ok(!text.includes(needle), `包里还有未脱敏内容：${needle}`)
  assert.ok(!/[A-Za-z]:[\\/]{1,2}(?:Users|Program|tmp)/.test(text), '包里还留着盘符绝对路径')
  assert.ok(!text.includes(join(process.env.DSH_ASSISTANT_CONFIG)), '配置文件路径直接出现在包里')
}])

cases.push(['导出落盘到 outputs/，文件本身也是脱敏过的，权限模式尽力 0600', () => {
  const result = writeDiagnosticsBundle({ get: () => undefined })
  assert.ok(existsSync(result.savedPath), `没写出文件：${result.savedPath}`)
  assert.ok(result.savedPath.startsWith(join(process.env.DSH_ASSISTANT_HOME, 'outputs')), '没落在 outputs/ 里')
  assert.ok(result.bytes > 200, '文件太小')
  const fileText = readFileSync(result.savedPath, 'utf8')
  assert.ok(!fileText.includes(personalDir), '文件里还留着私人目录')
  assert.ok(!fileText.includes('SECRET_TOKEN_123'), '文件里还留着隧道 Token')
  assert.ok(JSON.parse(fileText).assistantHome.usage, '文件里没带助手目录用量')
  if (process.platform !== 'win32') {
    const mode = statSync(result.savedPath).mode & 0o777
    assert.ok(mode === 0o600, `非 Windows 上该是 0600，实际 ${mode.toString(8)}`)
  }
}])

cases.push(['路由注册：GET /api/assistant/diagnostics 与 POST /export，非 POST 一律 405', async () => {
  const registered = []
  const fakeServer = {
    register: (spec) => { registered.push(spec); return { dispose: () => {} } },
    dispose: () => {},
  }
  const dispose = registerAssistantDiagnostics({ webServer: fakeServer })
  const paths = registered.map((r) => r.path)
  assert.ok(paths.includes('/api/assistant/diagnostics'), '没注册 GET 路由')
  assert.ok(paths.includes('/api/assistant/diagnostics/export'), '没注册 export 路由')
  const getRoute = registered.find((r) => r.path === '/api/assistant/diagnostics')
  const postRoute = registered.find((r) => r.path === '/api/assistant/diagnostics/export')
  const makeRes = () => {
    const res = { status: 0, body: '' }
    res.writeHead = (status) => { res.status = status }
    res.end = (body) => { if (body) res.body = body }
    return res
  }
  const resGet = makeRes()
  await getRoute.handler({ method: 'GET' }, resGet)
  assert.equal(resGet.status, 200)
  const payload = JSON.parse(resGet.body)
  assert.ok(payload.ok === true && payload.redactedReplacements > 0, 'GET 没返回脱敏计数')
  assert.ok(!resGet.body.includes(personalDir), 'GET 响应里还有私人目录')
  const resBad = makeRes()
  await getRoute.handler({ method: 'POST' }, resBad)
  assert.equal(resBad.status, 405, 'GET 路由该只认 GET')
  const resPost = makeRes()
  await postRoute.handler({ method: 'POST' }, resPost)
  assert.equal(resPost.status, 200)
  const saved = JSON.parse(resPost.body)
  assert.ok(saved.savedPath && saved.bytes > 0, 'export 没回路径与字节数')
  assert.equal(typeof dispose, 'function', '没返回 dispose')
  dispose()
}])

cases.push(['设置页「个人助手」真有三个按钮（诊断包 / 档案导出 / 档案导入），文案说得是真的事', () => {
  const client = readFileSync(new URL('../src/client/assistant-settings.tsx', import.meta.url), 'utf8')
  assert.ok(client.includes('/api/assistant/diagnostics/export'), '客户端没有调诊断包导出路由')
  assert.ok(client.includes('导出诊断包'), '按钮文案没接上')
  assert.ok(client.includes('导出助手档案') && client.includes('导入助手档案'), '档案按钮没接上')
  assert.ok(/旧宿主没有这条路由[\s\S]{0,40}重启 DSH Desktop/.test(client) || client.includes('需要重启 DSH Desktop'), 'UI 没提醒「宿主改动要重启 DSH Desktop」')
  assert.ok(client.includes('可复制的相对路径'), 'UI 没给可复制的相对路径')
  assert.ok(client.includes('体积'), 'UI 没报体积')
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(built.includes('/api/assistant/diagnostics/export'), '产物里的客户端没带诊断包路由')
  assert.ok(built.includes('/api/assistant/archive/import'), '产物里的客户端没带档案导入路由')
}])

cases.push(['测试面存在且带了脱敏规则数量', () => {
  assert.equal(typeof assistantDiagnosticsTestSurface.redactText, 'function')
  assert.ok(assistantDiagnosticsTestSurface.secretPatterns >= 3, '脱敏规则太少')
  assert.equal(assistantDiagnosticsTestSurface.maskConstant, '«已脱敏»')
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : err))
  }
}
rmSync(tempHome, { recursive: true, force: true })
delete process.env.DSH_HOME
delete process.env.DSH_ASSISTANT_HOME
delete process.env.DSH_ASSISTANT_CONFIG
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
