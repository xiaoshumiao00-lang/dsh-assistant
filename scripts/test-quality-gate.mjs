/** 质量门本身回归（P0-8）：node scripts/test-quality-gate.mjs */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = (path) => new URL('../' + path, import.meta.url)
const ciPath = join(process.cwd(), '.github', 'workflows', 'ci.yml')

const cases = []

cases.push(['CI workflow 存在且跑 build + check + test + lint（两个 OS 矩阵）', () => {
  assert.ok(existsSync(ciPath), '.github/workflows/ci.yml 不存在')
  const ci = readFileSync(ciPath, 'utf8')
  for (const step of ['npm run build', 'npm run check', 'npm test', 'npm run lint']) {
    assert.ok(ci.includes(step), `CI 里没有 ${step}`)
  }
  assert.ok(/ubuntu-latest/.test(ci) && /windows-latest/.test(ci), 'CI 矩阵没覆盖 ubuntu 与 windows')
  assert.ok(/node-version/.test(ci) && /22/.test(ci), 'CI 没钉 Node 22')
  assert.ok(ci.includes('npm install'), 'CI 没装依赖就想跑')
}])

cases.push(['CI 里的 typecheck 是 continue-on-error（因为它本机过不了），不许偷偷去掉', () => {
  const ci = readFileSync(ciPath, 'utf8')
  assert.ok(ci.includes('npm run typecheck'), 'CI 里没记录 typecheck 这条欠账')
  assert.ok(/continue-on-error:\s*true/.test(ci), 'typecheck 该留在 CI 里但不阻塞（诚实标记）')
  const pkg = JSON.parse(readFileSync(repo('package.json'), 'utf8'))
  assert.ok(!pkg.scripts.test.includes('typecheck'), 'typecheck 不该混进 npm test（它现在是已知失败项）')
}])

cases.push(['package.json 有 lint 与 typecheck 脚本，且脚本文件真的存在', () => {
  const pkg = JSON.parse(readFileSync(repo('package.json'), 'utf8'))
  assert.ok(pkg.scripts.lint, '没有 lint 脚本')
  assert.ok(pkg.scripts.typecheck, '没有 typecheck 脚本')
  for (const script of [pkg.scripts.lint, pkg.scripts.typecheck]) {
    const target = script.split(/\s+/)[1]
    assert.ok(existsSync(join(process.cwd(), target.replace(/\//g, '\\'))), `脚本指向的文件不存在：${target}`)
  }
}])

cases.push(['package.json 有 lint 与 typecheck 脚本，且指的文件真的存在（文档与实现必须一致）', () => {
  const pkg = JSON.parse(readFileSync(repo('package.json'), 'utf8'))
  assert.equal(pkg.scripts.lint, 'node scripts/lint-standards.mjs', 'lint 脚本没指对文件')
  assert.equal(pkg.scripts.typecheck, 'node scripts/typecheck.mjs', 'typecheck 脚本没指对文件')
  for (const script of [pkg.scripts.lint, pkg.scripts.typecheck]) {
    const target = script.split(/\s+/)[1]
    assert.ok(existsSync(join(process.cwd(), target.replace(/\//g, '\\'))), `脚本指向的文件不存在：${target}`)
  }
  const readme = readFileSync(repo('README.md'), 'utf8')
  assert.ok(readme.includes('npm run lint') && readme.includes('npm run typecheck'), 'README 还在宣传 npm run lint / typecheck 却没有对应脚本')
}])

cases.push(['CI 跑 build/check/test/lint 四步，typecheck 只允许当非阻塞步骤', () => {
  const ci = readFileSync(ciPath, 'utf8')
  const lintStep = ci.split('name: lint').slice(-1)[0].split('name:')[0]
  assert.ok(!/continue-on-error/.test(lintStep), 'lint 是必需步骤，不许 continue-on-error 蒙混')
  assert.ok(ci.includes('npm run lint'), 'CI 没跑 lint')
  assert.ok(ci.includes('npm run typecheck'), 'CI 里没记录 typecheck 这条欠账')
}])

cases.push(['typecheck 不许「假装通过」：跑不起来 / 编译器没跑成都要非零退出', () => {
  const text = readFileSync(repo('scripts/typecheck.mjs'), 'utf8')
  assert.ok(text.includes('spawnFailed'), '没有区分「编译器启动失败」与「0 错误」')
  assert.ok(/process\.exit\(2\)/.test(text), '跑不起来时该退出码 2（不是 0）')
  assert.ok(!/console\.log\('typecheck: 通过'\s*\)/.test(text), '不许无条件打印通过')
  assert.ok(text.includes('0 个 TS 错误'), '真通过时要打印真实错误数')
  assert.ok(existsSync(join(process.cwd(), 'tsconfig.json')), '有 typecheck 脚本却没有 tsconfig.json')
}])

cases.push(['lint 查的是查得动的东西，且个人化残留与旧仓库名不许复现（宿主侧）', () => {
  const text = readFileSync(repo('scripts/lint-standards.mjs'), 'utf8')
  for (const marker of ['陈潘', '微信联系人', 'HBEU', 'Aisland-SJL', 'Paper-Workspace']) {
    assert.ok(text.includes(marker), `lint 的黑名单里没有 ${marker}`)
  }
  assert.ok(text.includes('dsh-worktable'), 'lint 没查宿主日志自名')
  const index = readFileSync(repo('src/index.ts'), 'utf8')
  assert.ok(!/\[dsh-worktable\]/.test(index), '宿主日志还自称 [dsh-worktable]')
  const client = readFileSync(repo('src/client/index.tsx'), 'utf8')
  // 客户端旧前缀是【故意留的】（照片库 / 卡片视图存在这些键里），lint 不许把它们判成问题
  assert.ok(/\[dsh-worktable\]/.test(client), '客户端旧前缀不见了（那是本机数据的键名，不该动）')
  assert.ok(text.includes('SELF_EXEMPT'), 'lint 没有豁免名单（黑名单本身写在脚本里会被自己判违规）')
  assert.ok(text.includes('isTestFile'), 'lint 没豁免测试文件（测试断言里必须写黑名单字符串）')
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
