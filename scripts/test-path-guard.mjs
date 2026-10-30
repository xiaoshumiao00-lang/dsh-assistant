/** 目录 allowlist 与终端环境变量回归（P0-5）：node scripts/test-path-guard.mjs */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const assistant = await import('../lib/index.js')
const { expandHome, defaultAllowedRoots, createPathGuard, minimalTermEnv } = assistant

const tempHome = mkdtempSync(join(tmpdir(), 'assistant-guard-'))
const nested = join(tempHome, '.dsh', 'assistant')
mkdirSync(nested, { recursive: true })
const configFile = join(tempHome, 'config.json')
process.env.DSH_ASSISTANT_CONFIG = configFile
process.env.DSH_ASSISTANT_HOME = nested
process.env.DSH_HOME = join(tempHome, '.dsh')

const forbidden = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc'

const cases = []

cases.push(['~ 与 ~/ 展开成用户主目录，其它路径原样返回', () => {
  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('~/.dsh'), join(homedir(), '.dsh'))
  assert.equal(expandHome('~\\dsh'), join(homedir(), 'dsh'))
  assert.equal(expandHome('D:\\x'), 'D:\\x')
  assert.equal(expandHome(''), '')
}])

cases.push(['默认允许根包含助手目录、DSH 数据根、主目录、临时目录与仓库 cwd', () => {
  const roots = defaultAllowedRoots()
  const has = (candidate) => roots.some((root) => root === candidate || roots.includes(candidate))
  assert.ok(roots.includes(nested), '助手目录没进允许根')
  assert.ok(has(join(tempHome, '.dsh')), 'DSH 数据根没进允许根')
  assert.ok(roots.includes(homedir()), '用户主目录没进允许根（浏览器看自己的家目录不算越界）')
  assert.ok(roots.includes(tmpdir()), '系统临时目录没进允许根')
  assert.ok(roots.includes(process.cwd()), '插件仓库 cwd 没进允许根')
  // 允许根去重：同一个根不出现两次
  const seen = new Set()
  for (const root of roots) {
    const key = root.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '')
    assert.ok(!seen.has(key), `重复的允许根：${root}`)
    seen.add(key)
  }
}])

cases.push(['本机配置 allowedRoots 追加的根被采纳（带 ~ 展开）', () => {
  const extra = join(tempHome, 'projects')
  mkdirSync(extra, { recursive: true })
  writeFileSync(configFile, JSON.stringify({ allowedRoots: [extra, '~/outside-config-root'] }), 'utf8')
  const guard = createPathGuard()
  assert.ok(guard.roots.includes(extra), '配置文件里的根没进允许根')
  assert.equal(guard.check(extra).ok, true)
  assert.equal(guard.check(join(extra, 'A', 'B.md')).ok, true, '允许根内的深层路径要放行')
  assert.equal(guard.check(join(homedir(), 'outside-config-root')).ok, true, '~ 展开后写进配置文件也要生效')
}])

cases.push(['空路径与越界路径一律拒绝，且给出差哪个根的说明', () => {
  const guard = createPathGuard()
  assert.equal(guard.check('').ok, false)
  assert.equal(guard.check('').reason, 'empty-path')
  const denied = guard.check(forbidden)
  assert.equal(denied.ok, false, `${forbidden} 不该在允许根以内`)
  assert.ok(denied.reason.startsWith('outside-allowlist:'), '拒绝原因要带上实际路径：' + denied.reason)
  assert.ok(denied.target.length > 0, '要报告解析后的绝对路径')
  // 越界的深层路径同样挡掉（不是靠字符串前缀蒙对）
  assert.equal(guard.check(join(forbidden, 'drivers', 'etc')).ok, false)
}])

cases.push(['Windows 大小写与尾部分隔符不影响判定', () => {
  const guard = createPathGuard()
  const base = join(tempHome, '.dsh')
  const ok = guard.check(base)
  assert.equal(ok.ok, true)
  if (process.platform === 'win32') {
    assert.equal(guard.check(base.toLowerCase()).ok, true, '小写路径应与原路径等价')
    assert.equal(guard.check(base.toUpperCase()).ok, true, '大写路径应与原路径等价')
    assert.equal(guard.check(base + '\\').ok, true, '尾部分隔符不该影响判定')
    assert.equal(guard.check(base.replace(/\\/g, '/') + '/assistant').ok, true, '混用分隔符要归一')
  } else {
    assert.equal(guard.check(base).ok, true)
  }
}])

cases.push(['allowAllLocalPaths: true 是显式逃生开关（默认 false）', () => {
  writeFileSync(configFile, JSON.stringify({ allowAllLocalPaths: true }), 'utf8')
  const open = createPathGuard()
  assert.equal(open.open, true)
  assert.equal(open.check(forbidden).ok, true, '开关打开了就不该挡')
  writeFileSync(configFile, JSON.stringify({ allowAllLocalPaths: 'yes' }), 'utf8')
  const wrong = createPathGuard()
  assert.equal(wrong.open, false, '非 true 的值不认（不能靠字符串 truthy 蒙混）')
  assert.equal(wrong.check(forbidden).ok, false)
}])

cases.push(['终端 env 是白名单而不是整包 process.env', () => {
  process.env.DSH_ASSISTANT_TEST_SECRET = '不该出现在终端里'
  process.env.WX_APPID_SECRET_LIKE = '不该出现在终端里'
  try {
    const env = minimalTermEnv()
    assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0, 'PATH 必须传给 shell')
    assert.equal(env.DSH_ASSISTANT_TEST_SECRET, undefined, '未在白名单里的环境变量不该进终端')
    assert.equal(env.WX_APPID_SECRET_LIKE, undefined, '个人密钥类变量不该进终端')
    assert.ok(Object.keys(env).length < 25, `白名单不该扩得过大：${Object.keys(env).length}`)
    writeFileSync(configFile, JSON.stringify({ termEnvAllow: ['DSH_ASSISTANT_TEST_SECRET'] }), 'utf8')
    const withExtra = minimalTermEnv()
    assert.equal(withExtra.DSH_ASSISTANT_TEST_SECRET, '不该出现在终端里', '配置文件追加项应生效（大小写不敏感）')
  } finally {
    delete process.env.DSH_ASSISTANT_TEST_SECRET
    delete process.env.WX_APPID_SECRET_LIKE
  }
}])

cases.push(['src/index.ts 里每条数据路由都过了 allowlist（静态核对，别漏路由）', () => {
  const text = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  for (const route of ['file', 'fs', 'write', 'mkdir', 'git', 'open-folder', 'site', 'skills']) {
    const pattern = new RegExp(`denyOutside\\(res, [A-Za-z_]+, '${route}'\\)`)
    assert.ok(pattern.test(text), `路由 ${route} 没有过 allowlist`)
  }
  assert.ok(text.includes('env: minimalTermEnv()'), '终端还在整包 process.env')
  assert.ok(!text.includes('env: process.env'), '终端 env 仍是整包 process.env')
  assert.ok(text.includes('guard.check(cwd)'), '终端 cwd 没有过 allowlist')
  assert.ok(/createPathGuard\(\)/.test(text), 'apply 里没有构建 allowlist')
  assert.ok(text.includes('outside-allowlist'), '403 响应体里没有说明错误码')
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
delete process.env.DSH_ASSISTANT_CONFIG
delete process.env.DSH_ASSISTANT_HOME
delete process.env.DSH_HOME
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
