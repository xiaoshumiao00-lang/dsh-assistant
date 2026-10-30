/** 助手档案导出 / 导入（P1-B）：node scripts/test-assistant-archive.mjs */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempHome = mkdtempSync(join(tmpdir(), 'assistant-archive-'))
process.env.DSH_HOME = join(tempHome, '.dsh')
process.env.DSH_ASSISTANT_HOME = join(tempHome, '.dsh', 'assistant')
process.env.DSH_ASSISTANT_CONFIG = join(tempHome, '.dsh', 'assistant', 'config.json')
process.env.MNEMON_DATA_DIR = join(tempHome, 'mnemon', 'runtime')

const assistant = await import('../lib/index.js')
const { collectArchive, writeArchiveBundle, importArchiveBundle, registerAssistantArchive, ARCHIVE_FORMAT, assistantArchiveTestSurface } = assistant

// 先立一份可预测的档案内容（导入测试按这份来判重/冲突）
mkdirSync(join(process.env.DSH_ASSISTANT_HOME, 'journal'), { recursive: true })
mkdirSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', 'sub'), { recursive: true })
mkdirSync(join(process.env.DSH_ASSISTANT_HOME, 'archive', 'journal', '2020'), { recursive: true })
mkdirSync(join(process.env.DSH_ASSISTANT_HOME, 'exports'), { recursive: true })
mkdirSync(process.env.MNEMON_DATA_DIR, { recursive: true })
mkdirSync(join(process.env.DSH_HOME, 'profiles', 'desktop'), { recursive: true })
writeFileSync(join(process.env.DSH_ASSISTANT_HOME, 'AGENTS.md'), '# 人设\n现有内容\n', 'utf8')
writeFileSync(join(process.env.DSH_ASSISTANT_HOME, 'config.json'), JSON.stringify({ newProjectParent: 'X:\\Some\\Parent' }), 'utf8')
writeFileSync(join(process.env.DSH_ASSISTANT_HOME, 'journal', '2026-01-01.md'), '# 收工\n第一轮\n', 'utf8')
writeFileSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', 'architecture.md'), '# 档案\n旧的\n', 'utf8')
writeFileSync(join(process.env.DSH_ASSISTANT_HOME, 'archive', 'journal', '2020', '2020-01-01.md'), '# 归档\n', 'utf8')
writeFileSync(join(process.env.MNEMON_DATA_DIR, 'USER.md'), '他是谁\n', 'utf8')
writeFileSync(join(process.env.MNEMON_DATA_DIR, 'MEMORY.md'), '硬事实\n', 'utf8')
writeFileSync(join(process.env.DSH_HOME, 'profiles', 'desktop', 'dsh-assistant-state.json'), JSON.stringify({
  revision: 7,
  projects: { layouts: { 'wt-assistant': 1 }, folders: { p1: 'X:\\Some\\Parent\\p1' }, removed: { p2: { at: '2026-01-01' } }, flows: { p1: { templateId: 'paper-10step' } } },
}), 'utf8')

const cases = []

cases.push(['导出清单：区域齐全、带体积与校验和、JSON 能 parse', () => {
  const { bundle, items, totals } = collectArchive()
  const parsed = JSON.parse(bundle)
  assert.equal(parsed.format, ARCHIVE_FORMAT)
  assert.ok(Array.isArray(parsed.items) && parsed.items.length >= 7, '包里的条目太少：' + parsed.items.length)
  const areas = new Set(parsed.items.map((item) => item.area))
  for (const area of ['agents', 'journal', 'notes', 'archive', 'memory', 'config', 'state']) {
    assert.ok(areas.has(area), `包里缺 ${area} 这一区`)
  }
  assert.ok(typeof parsed.checksum === 'string' && parsed.checksum.length === 64, '没带校验和')
  assert.ok(totals.bytes > 0, '没带体积')
  assert.ok(parsed.items.every((item) => item.sha256.length === 64), '条目校验和缺失')
  assert.ok(parsed.items.some((item) => item.relPath === 'AGENTS.md'), 'AGENTS.md 没带进来')
  assert.ok(parsed.items.some((item) => item.relPath === 'USER.md' && item.area === 'memory'), 'USER.md 没带进来')
  assert.ok(parsed.items.some((item) => item.area === 'state'), '状态文件没带进来')
  assert.equal(typeof assistantArchiveTestSurface.checksumOf(items), 'string')
}])

cases.push(['客户端按钮真接上了（导出/导入都在设置「个人助手」页里，且说的是真话）', () => {
  const client = readFileSync(new URL('../src/client/assistant-settings.tsx', import.meta.url), 'utf8')
  assert.ok(client.includes('/api/assistant/archive/export'), '客户端没有导出按钮的路由调用')
  assert.ok(client.includes('/api/assistant/archive/import'), '客户端没有导入的路由调用')
  assert.ok(client.includes('导出助手档案') && client.includes('导入助手档案'), '按钮文案没接上')
  assert.ok(client.includes('knownPresets'), '导入没带本机已知的预设名单（缺预设就会静默了）')
  assert.ok(client.includes('冲突另存'), 'UI 没报告冲突另存')
  assert.ok(client.includes('删除墓碑'), 'UI 没报告墓碑这件事')
}])

cases.push(['导出落盘写在 exports/（不在 outputs 的 14 天自动清范围里）', () => {
  const result = writeArchiveBundle()
  assert.ok(result.savedPath.includes(join('assistant', 'exports')), '没落在 exports/：' + result.savedPath)
  assert.ok(existsSync(result.savedPath), '文件没写出来')
  assert.ok(result.bytes > 500, '文件太小')
  const parsed = JSON.parse(readFileSync(result.savedPath, 'utf8'))
  assert.equal(parsed.format, ARCHIVE_FORMAT)
  assert.equal(parsed.items.length, result.items)
  const leftovers = readdirSync(join(process.env.DSH_ASSISTANT_HOME, 'outputs'))
  assert.ok(!leftovers.some((name) => name.startsWith('archive-')), '档案包不该落进 outputs/（会被 14 天清理删掉）')
}])

cases.push(['导入：新文件写进去、一模一样的判重跳过、内容不同【不覆盖】而是另存', () => {
  const bundle = JSON.parse(JSON.stringify({
    format: ARCHIVE_FORMAT,
    items: [
      { area: 'notes', relPath: 'architecture.md', content: '# 档案\n旧的\n' },
      { area: 'notes', relPath: 'brand-new.md', content: '# 新档案\n内容\n' },
      { area: 'journal', relPath: '2026-01-01.md', content: '# 收工\n第一轮\n' },
      { area: 'journal', relPath: '2026-02-02.md', content: '# 收工\n新的日志\n' },
    ],
  }))
  bundle.checksum = assistantArchiveTestSurface.checksumOf(bundle.items)
  const report = importArchiveBundle(bundle, ['chat', 'paper-10step'])
  assert.equal(report.ok, true, '导入失败了：' + report.error)
  const written = report.written.map((item) => `${item.area}/${item.relPath}`)
  assert.ok(written.includes('notes/brand-new.md'), '新文件没写进去')
  assert.ok(written.includes('journal/2026-02-02.md'), '新日志没写进去')
  const skipped = report.skipped.map((item) => `${item.area}/${item.relPath}:${item.why}`)
  assert.ok(skipped.some((line) => line.includes('notes/architecture.md')), '一样的那份没被判重跳过')
  assert.ok(skipped.some((line) => line.includes('journal/2026-01-01.md')), 'journal 里的同名同内容那份没判重')
  assert.ok(existsSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', 'brand-new.md')), '磁盘上没有 brand-new.md')
  assert.equal(readFileSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', 'architecture.md'), 'utf8'), '# 档案\n旧的\n', '原有内容被覆盖了')

  // 冲突：内容不同 → 另存 .imported-*，原文件一字不动
  const conflict = { format: ARCHIVE_FORMAT, items: [{ area: 'notes', relPath: 'architecture.md', content: '# 档案\n别人那边的新内容\n' }] }
  conflict.checksum = assistantArchiveTestSurface.checksumOf(conflict.items)
  const second = importArchiveBundle(conflict, [])
  assert.equal(second.ok, true)
  assert.equal(second.keptBoth.length, 1, '冲突没走「保留两份」这条路')
  const altName = second.keptBoth[0].wroteAs
  assert.ok(/\.imported-\d{14}\.md$/.test(altName), '另存的文件名不该带 .imported-<时间戳>：' + altName)
  assert.ok(existsSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', altName)), '另存的文件没落盘')
  assert.equal(readFileSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', 'architecture.md'), 'utf8'), '# 档案\n旧的\n', '冲突导入把原文件改了（不许）')
  assert.ok(second.backupDir && existsSync(second.backupDir), '导入前没备份')
  const backups = readdirSync(second.backupDir)
  assert.ok(backups.includes('AGENTS.md'), '备份里没有 AGENTS.md')
  assert.ok(backups.some((name) => name.startsWith('notes_')), '备份里没有 notes 现状')
  assert.ok(backups.some((name) => name.startsWith('journal_')), '备份里没有 journal 现状')
}])

cases.push(['校验和被改过就整包拒绝，不落一个文件', () => {
  const before = existsSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', 'tampered.md'))
  const bad = { format: ARCHIVE_FORMAT, items: [{ area: 'notes', relPath: 'tampered.md', content: '内容' }], checksum: 'f'.repeat(64) }
  const report = importArchiveBundle(bad, [])
  assert.equal(report.ok, false)
  assert.ok(/校验和/.test(report.error ?? ''), '拒绝原因没提校验和：' + report.error)
  assert.equal(before, existsSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', 'tampered.md')), '被拒的包居然写了文件')
  const wrongFormat = importArchiveBundle({ format: 'something-else', items: [] }, [])
  assert.equal(wrongFormat.ok, false, 'format 不对也放行了')
}])

cases.push(['删除墓碑不写回：state 区域一律拒收并报告数量', () => {
  const bundle = JSON.parse(JSON.stringify({ format: ARCHIVE_FORMAT, items: [{ area: 'state', relPath: 'dsh-assistant-state.json', content: JSON.stringify({ revision: 99, projects: { removed: { p2: { at: 'x' } } } }) }] }))
  bundle.checksum = assistantArchiveTestSurface.checksumOf(bundle.items)
  const report = importArchiveBundle(bundle, [])
  assert.equal(report.ok, true)
  assert.ok(report.tombstonesIgnored >= 1, '没报告墓碑被拒收')
  assert.ok(report.skipped.some((item) => item.area === 'state'), 'state 区域没进拒收名单')
  const stateFile = readFileSync(join(process.env.DSH_HOME, 'profiles', 'desktop', 'dsh-assistant-state.json'), 'utf8')
  assert.ok(stateFile.includes('"revision":7') || stateFile.includes('"revision": 7'), '状态文件被导入改了（不许）')
}])

cases.push(['预设本机没有要明确提示，不静默', () => {
  const bundle = {
    format: ARCHIVE_FORMAT,
    items: [{ area: 'state', relPath: 'dsh-assistant-state.json', content: JSON.stringify({ projects: { flows: { p1: { templateId: 'paper-10step' } }, layouts: { x: { preset: 'acme-flow' } } } }) }],
  }
  bundle.checksum = assistantArchiveTestSurface.checksumOf(bundle.items)
  const report = importArchiveBundle(bundle, ['chat', 'blank'])
  assert.equal(report.ok, true)
  assert.deepEqual(report.missingPresets, ['acme-flow', 'paper-10step'], '缺失预设没报出来：' + JSON.stringify(report.missingPresets))
  const known = importArchiveBundle(bundle, ['chat', 'blank', 'paper-10step', 'acme-flow'])
  assert.deepEqual(known.missingPresets, [], '本机已有的预设被误报成缺失')
}])

cases.push(['包里的相对路径不许跳出助手家目录', () => {
  const bundle = { format: ARCHIVE_FORMAT, items: [{ area: 'notes', relPath: '../evil.md', content: '越界内容' }] }
  bundle.checksum = assistantArchiveTestSurface.checksumOf(bundle.items)
  const report = importArchiveBundle(bundle, [])
  assert.equal(report.ok, true)
  assert.ok(report.skipped.some((item) => /越界/.test(item.why)), '没拒收越界路径')
  assert.equal(existsSync(join(process.env.DSH_ASSISTANT_HOME, 'evil.md')), false, '越界文件被写出去了')
  const absolute = importArchiveBundle({ format: ARCHIVE_FORMAT, items: [{ area: 'notes', relPath: join(tempHome, 'abs.md'), content: 'x' }] }, [])
  assert.ok(absolute.skipped.length >= 1, '绝对路径条目没被拒')
}])

cases.push(['dryRun 只报告不落盘、不改现状', () => {
  const bundle = { format: ARCHIVE_FORMAT, items: [{ area: 'notes', relPath: 'dryrun-only.md', content: '不该落盘' }] }
  bundle.checksum = assistantArchiveTestSurface.checksumOf(bundle.items)
  const report = importArchiveBundle(bundle, [], true)
  assert.equal(report.ok, true)
  assert.equal(report.dryRun, true)
  assert.equal(existsSync(join(process.env.DSH_ASSISTANT_HOME, 'notes', 'dryrun-only.md')), false, 'dryRun 不该落盘')
  assert.ok(report.written.length >= 1, 'dryRun 没报告要写什么')
  assert.equal(report.backupDir, undefined, 'dryRun 不该建备份目录')
}])

cases.push(['路由注册齐三条，非 POST 一律 405，import 的坏 body 有明确错误码', async () => {
  const registered = []
  const dispose = registerAssistantArchive({ webServer: { register: (spec) => { registered.push(spec); return { dispose: () => {} } }, dispose: () => {} } })
  const paths = registered.map((r) => r.path)
  assert.deepEqual(paths, ['/api/assistant/archive', '/api/assistant/archive/export', '/api/assistant/archive/import'])
  const makeRes = () => { const res = { status: 0, body: '' }; res.writeHead = (status) => { res.status = status }; res.end = (body) => { if (body) res.body = body }; return res }
  const makeReq = (method, bodyText) => {
    const req = { method }
    if (bodyText !== undefined) {
      req[Symbol.asyncIterator] = async function* () { yield Buffer.from(bodyText) }
    }
    return req
  }
  const miniBundle = JSON.stringify({ format: ARCHIVE_FORMAT, items: [{ area: 'notes', relPath: 'mini.md', content: '迷你内容' }] })
  const byMethod = registered.map((r) => ({ r, method: r.path.endsWith('export') || r.path.endsWith('import') ? 'POST' : 'GET' }))
  for (const { r, method } of byMethod) {
    const res = makeRes()
    const body = method === 'POST' ? (r.path.endsWith('export') ? '' : miniBundle) : undefined
    await r.handler(method === 'GET' ? { method } : makeReq(method, body), res)
    assert.equal(res.status, 200, `${r.path} ${method} 没通：${res.body}`)
    const wrong = makeRes()
    await r.handler(makeReq(method === 'GET' ? 'POST' : 'GET', method === 'GET' ? undefined : ''), wrong)
    assert.equal(wrong.status, 405, `${r.path} 没挡住错误的方法`)
  }
  const importRoute = registered.find((r) => r.path === '/api/assistant/archive/import')
  const fakeReq = { method: 'POST', [Symbol.asyncIterator]: async function* () { yield Buffer.from('{ 坏 JSON') } }
  const resBad = makeRes()
  await importRoute.handler(fakeReq, resBad)
  assert.equal(resBad.status, 400)
  assert.ok(/JSON/.test(resBad.body), '坏 body 没给明确说明：' + resBad.body)
  const bigItems = Array.from({ length: 3 }, (_, index) => ({ area: 'notes', relPath: `big-${index}.md`, content: 'x'.repeat(20 * 1024 * 1024) }))
  const tooBig = { method: 'POST', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ format: ARCHIVE_FORMAT, items: bigItems })) } }
  const resBig = makeRes()
  await importRoute.handler(tooBig, resBig)
  assert.ok(resBig.status === 413 || resBig.status === 400, `超限该给 413 或 400，实际 ${resBig.status}`)
  assert.ok(resBig.status !== 200, '超限的包居然大摇大摆进口了')
  dispose()
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
delete process.env.MNEMON_DATA_DIR
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
