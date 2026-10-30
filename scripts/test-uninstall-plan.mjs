/** 卸载脚本的计划与副作用回归（P0-7）：node scripts/test-uninstall-plan.mjs */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const script = join(process.cwd(), 'scripts', 'uninstall-assistant.mjs')

const cases = []

function buildFake() {
  const root = mkdtempSync(join(tmpdir(), 'assistant-uninstall-'))
  const profile = join(root, 'profiles', 'desktop')
  const source = join(root, 'src-package', 'dsh-assistant')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  mkdirSync(join(source, 'lib'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-assistant', version: '0.0.0-test' }), 'utf8')
  writeFileSync(join(source, 'lib', 'index.js'), '// 仓库内容（卸载绝不该碰）\n', 'utf8')
  // junction：Windows 用 mklink /J（不需要管理员），其它平台 symlink
  const link = join(profile, 'node_modules', 'dsh-assistant')
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', link, source], { stdio: 'pipe' })
  else symlinkSync(source, link, 'dir')
  // profile package.json：现在的（被安装改过）与备份（安装前）
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'profile', dependencies: { 'dsh-assistant': `link:${source.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles: ['dsh-assistant', 'dsh-mnemon'] } },
  }, null, 2), 'utf8')
  const backup = join(profile, 'package.json.bak-assistant-20260101000000')
  writeFileSync(backup, JSON.stringify({
    name: 'profile', dependencies: { 'dsh-worktable': 'link:x', 'dsh-pocket': 'link:y' },
    dsh: { profile: { bundles: ['dsh-worktable', 'dsh-pocket', 'dsh-mnemon'] } },
  }, null, 2), 'utf8')
  // 助手数据
  mkdirSync(join(root, 'assistant', 'journal'), { recursive: true })
  mkdirSync(join(root, 'assistant', 'notes'), { recursive: true })
  writeFileSync(join(root, 'assistant', 'AGENTS.md'), '# 人设\n', 'utf8')
  writeFileSync(join(root, 'assistant', 'config.json'), JSON.stringify({ newProjectParent: 'X:\\Somewhere' }), 'utf8')
  writeFileSync(join(root, 'assistant', 'journal', '2026-01-01.md'), '# 日志\n', 'utf8')
  writeFileSync(join(root, 'dsh-assistant-focus.log'), 'focus log\n', 'utf8')
  writeFileSync(join(profile, 'dsh-assistant-state.json'), JSON.stringify({ revision: 3 }), 'utf8')
  writeFileSync(join(root, 'dsh-tuoguan-state.json'), JSON.stringify({ on: {} }), 'utf8')
  mkdirSync(join(profile, 'dsh-assistant-ball'), { recursive: true })
  writeFileSync(join(profile, 'dsh-assistant-ball', 'main.js'), '// helper\n', 'utf8')
  // 宿主数据：卸载绝不该碰
  mkdirSync(join(root, 'sessions', 'abc'), { recursive: true })
  writeFileSync(join(root, 'sessions', 'abc', 'log.jsonl'), '{"line":"会话本体"}\n', 'utf8')
  return { root, profile, source, link, backup }
}

function runScript(args, env) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: env.root ?? env }, stdio: 'pipe' }).toString()
}

let fake = buildFake()

cases.push(['--dry-run 什么都没动（junction 与文件都还在）', () => {
  const output = runScript(['--purge', '--dry-run'], { root: fake.root })
  assert.ok(existsSync(fake.link), '--dry-run 不该摘 junction')
  assert.ok(existsSync(join(fake.root, 'assistant', 'AGENTS.md')), '--dry-run 不该删助手数据')
  assert.ok(output.includes('会摘'), '计划里没写 junction 要摘')
  assert.ok(output.includes('会挪走'), '计划里没写数据要挪走')
  assert.ok(output.includes('dsh-worktable'), '没打印 IndexedDB 名字')
  assert.ok(output.includes('dsh.assistant.'), '没打印 localStorage 键清单')
  assert.ok(!output.includes('dsh.sessions.current)') || output.includes('不要清'), '没说明哪些键不该清')
  assert.ok(/不要清[^\n]*dsh\.sessions\.current/.test(output), '宿主键没被排除在清理清单外')
}])

cases.push(['默认卸载：摘 junction + 从备份还原 package.json，不删任何数据', () => {
  const output = runScript([], { root: fake.root })
  assert.ok(output.includes('已解除 junction'), 'junction 没摘掉')
  assert.ok(!existsSync(fake.link), 'junction 还在')
  assert.ok(existsSync(join(fake.source, 'lib', 'index.js')), '顺着 junction 把仓库内容删了')
  const restored = JSON.parse(readFileSync(join(fake.profile, 'package.json'), 'utf8'))
  assert.deepEqual(restored.dsh.profile.bundles, ['dsh-worktable', 'dsh-pocket', 'dsh-mnemon'], 'bundles 没还原成安装前的样子')
  assert.ok(restored.dependencies['dsh-worktable'], '依赖没还原')
  assert.ok(!restored.dependencies['dsh-assistant'], '还原后还留着 dsh-assistant 依赖')
  assert.ok(existsSync(join(fake.root, 'assistant', 'AGENTS.md')), '默认卸载不该删助手数据')
  assert.ok(existsSync(join(fake.profile, 'dsh-assistant-state.json')), '默认卸载不该删状态文件')
  assert.ok(!/未确认/.test(output), '默认路径不该问确认')
}])

cases.push(['--purge 把数据挪进备份目录（删掉还能翻回来），并绝不碰 sessions', () => {
  const output = runScript(['--purge', '--yes'], { root: fake.root })
  const backups = output.match(/uninstall-backup-\d{14}/)
  assert.ok(backups, '没报告备份目录')
  const backupDir = join(fake.root, backups[0])
  assert.ok(existsSync(backupDir), '备份目录没建出来')
  assert.ok(!existsSync(join(fake.root, 'assistant')), '助手家目录还在（该挪走）')
  assert.ok(!existsSync(join(fake.profile, 'dsh-assistant-state.json')), '状态文件还在')
  assert.ok(!existsSync(join(fake.root, 'dsh-assistant-focus.log')), '焦点日志还在')
  assert.ok(!existsSync(join(fake.profile, 'dsh-assistant-ball')), '桌面球目录还在')
  const backupEntries = readdirSync(backupDir)
  assert.ok(backupEntries.some((name) => name.startsWith('assistant')), '助手目录没进备份：' + backupEntries.join(', '))
  assert.ok(backupEntries.some((name) => name.includes('state.json')), '状态文件没进备份：' + backupEntries.join(', '))
  assert.ok(backupEntries.some((name) => name.includes('focus.log')), '焦点日志没进备份')
  // 宿主的会话本体与配置一律保留
  assert.ok(existsSync(join(fake.root, 'sessions', 'abc', 'log.jsonl')), 'sessions 被删了（不许）')
  assert.ok(output.includes('明确没碰'), '没说明哪些东西故意不碰')
  assert.ok(output.includes('重启 DSH Desktop'), '没提醒要重启')
}])

cases.push(['没有备份时不猜 bundles：只剥本插件自己加的项并告诉你该补回谁', () => {
  const other = buildFake()
  rmSync(join(other.backup), { force: true })
  const output = runScript([], { root: other.root })
  const left = JSON.parse(readFileSync(join(other.profile, 'package.json'), 'utf8'))
  assert.ok(!left.dependencies['dsh-assistant'], '依赖没剥掉')
  assert.ok(!left.dsh.profile.bundles.includes('dsh-assistant'), 'bundles 没剥掉')
  assert.ok(left.dsh.profile.bundles.includes('dsh-mnemon'), '把别人的 bundles 也动了')
  assert.ok(output.includes('没有安装时的 package.json 备份'), '没承认找不到备份')
  assert.ok(output.includes('dsh-worktable'), '没提示该手动补回谁')
  assert.ok(existsSync(join(other.profile, 'package.json.before-uninstall-20260101000000')) || /before-uninstall/.test(output), '改动前没留副本')
  rmSync(other.root, { recursive: true, force: true })
}])

cases.push(['不是 junction 的真实目录一律不摘（避免误删用户拷进去的东西）', () => {
  const third = buildFake()
  rmSync(join(third.link), { recursive: true, force: true })
  mkdirSync(join(third.link, 'whatever'), { recursive: true })
  writeFileSync(join(third.link, 'whatever', 'keep.txt'), '用户自己放的文件', 'utf8')
  const output = runScript([], { root: third.root })
  assert.ok(/不是 junction/.test(output), '没报告「不是 junction 所以不碰」')
  assert.ok(existsSync(join(third.link, 'whatever', 'keep.txt')), '真实目录里的文件被删了（不许）')
  rmSync(third.root, { recursive: true, force: true })
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
rmSync(fake.root, { recursive: true, force: true })
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
