/** 发版一致性回归（P0-4）：版本源只有一处、公告由 CHANGELOG.md 生成、更新源不再有多个仓库名。
 *  node scripts/test-release-consistency.mjs */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

const pkg = JSON.parse(read('package.json'))
const manifest = JSON.parse(read('dsh.plugin.json'))
const changelog = read('CHANGELOG.md')
const build = read('build.mjs')
const updateCheck = read('src/client/updateCheck.ts')
const changelogModule = read('src/client/changelog.ts')

const cases = []

cases.push(['package.json 与 dsh.plugin.json 版本号一致（build.mjs 也会硬挡这一条）', () => {
  assert.equal(manifest.version, pkg.version, `manifest ${manifest.version} != package ${pkg.version}`)
  assert.equal(manifest.name, pkg.name)
  assert.equal(manifest.entry.name, pkg.name)
}])

cases.push(['CHANGELOG.md 里有当前版本那一节（公告正文的唯一来源）', () => {
  assert.ok(new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog), `缺少 ## [${pkg.version}]`)
  // 那一节里必须有非空正文
  const start = changelog.search(new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\]`, 'm'))
  const section = changelog.slice(start).split(/^## /m)[1] ?? ''
  assert.ok(section.trim().length > 20, '当前版本这一节是空的')
}])

cases.push(['build.mjs 把公告注入客户端 bundle（并在缺节时硬失败）', () => {
  assert.ok(build.includes('extractAnnouncement'), 'build.mjs 里没有公告抽取函数')
  assert.ok(/__WT_ANNOUNCE__:\s*JSON\.stringify\(announcement\)/.test(build), 'client define 里没有公告')
  assert.ok(build.includes('CHANGELOG.md'), 'build.mjs 没有引用 CHANGELOG.md')
  assert.ok(/CHANGELOG\.md 里没有 "## \[\$\{pkg\.version\}\]"/.test(build), '缺当前版本这一节时没有硬失败')
}])

cases.push(['changelog.ts 不再手写版本与公告正文', () => {
  assert.ok(changelogModule.includes('declare const __WT_ANNOUNCE__'), '公告没有从构建注入读')
  assert.ok(!/^export const CHANGELOG_VERSION = 'v/m.test(changelogModule), '还有手写版本常量')
  assert.ok(!/^\s*export const ANNOUNCE_BODY = '`/m.test(changelogModule), '公告正文还被打死在源码里')
  // 旧的手写公告段落不该再出现
  assert.ok(!changelogModule.includes('更新公告 · v0.2.5'), '旧版本的手写公告还在')
}])

cases.push(['更新源只有一个仓库：旧的两个退役仓库名不再出现在 src/ 与 README', async () => {
  const files = ['src/client/updateCheck.ts', 'src/client/split.tsx', 'src/client/index.tsx', 'src/client/changelog.ts', 'README.md']
  for (const file of files) {
    const text = read(file)
    assert.ok(!text.includes('Aisland-SJL'), `${file} 里还有 Aisland-SJL/dsh-worktable 更新源`)
    assert.ok(!text.includes('Paper-Workspace'), `${file} 里还有 Paper-Workspace 更新源`)
  }
  assert.equal(updateCheck.match(/xiaoshumiao00-lang\/dsh-assistant/g)?.length, 1, 'updateCheck.ts 里更新源应当只出现一次')
  assert.ok(updateCheck.includes("export const UPDATE_REPO = 'xiaoshumiao00-lang/dsh-assistant'"), '没有单一 UPDATE_REPO 常量')
  assert.ok(updateCheck.includes('export const UPGRADE_CMD') && updateCheck.includes('export const UPGRADE_AI'), '升级指令没有集中出口')
  assert.ok(!/const UPGRADE_CMD = 'dsh plugin/.test(read('src/client/split.tsx')), 'split.tsx 还在自己写升级命令')
}])

cases.push(['运行时插件自名与包名一致（工作台半部不再自称 dsh-worktable）', () => {
  const indexHost = read('src/index.ts')
  assert.ok(/export const name = 'dsh-assistant'/.test(indexHost), 'src/index.ts 的自名还是旧的')
  assert.ok(indexHost.includes('plugin: name'), 'health 路由没有用统一自名')
  const entry = read('src/assistant.ts')
  assert.ok(/export const name = 'dsh-assistant'/.test(entry), '入口自名不对')
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
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
