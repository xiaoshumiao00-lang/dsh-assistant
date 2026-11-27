/**
 * SSH 主机键校验回归（2026-11-28 手机访问安全整改 第 1 项）：
 *   node scripts/test-ssh-tunnel-args.mjs
 *
 * 验的是 src/pocket-host/ssh-tunnel.mjs 的两处 ssh 参数组（buildSshArgs / buildRemoteCmdArgs）：
 *   1. 不许再出现 `StrictHostKeyChecking=no`（旧行为＝允许中间人）；默认必须是 accept-new；
 *   2. UserKnownHostsFile 必须是**留存得下来**的真文件（旧的写 NUL///dev/null 等于没有校验），
 *    默认落在 pocket 的 profile 目录 <DSH_HOME>/dsh-pocket/known_hosts（旧写法写 NUL 或 /dev/null
 *    等于没有校验）；
 *   3. 覆写余地必须真的存在：cfg 字段与 DSH_POCKET_* 环境变量都能改出来。
 * 这份测试与被改的行为同时提交（断言跟着行为走，不是删测试凑绿）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tunnel = await import('../src/pocket-host/ssh-tunnel.mjs')
const {
  buildSshArgs,
  buildRemoteCmdArgs,
  normalizeSshTunnelConfig,
  knownHostsPath,
  SSH_HOST_KEY_CHECKING_DEFAULT,
} = tunnel

const tempHome = mkdtempSync(join(tmpdir(), 'ssh-tunnel-args-'))
const baseCfg = {
  enabled: true,
  host: 'vps.example.com',
  port: 22,
  user: 'tunnel-user',
  remotePort: 7080,
  keyPath: join(tempHome, 'id_ed25519'),
  localPort: 0,
  hostKeyChecking: '',
  knownHostsPath: '',
}
const cfg = normalizeSshTunnelConfig(baseCfg)

const cases = []

cases.push(['两处参数组都不许再出现 StrictHostKeyChecking=no（默认必须是 accept-new）', () => {
  assert.equal(SSH_HOST_KEY_CHECKING_DEFAULT, 'accept-new')
  for (const [label, args] of [['buildSshArgs', buildSshArgs(cfg, 3081)], ['buildRemoteCmdArgs', buildRemoteCmdArgs(cfg)]]) {
    const joined = args.join(' ')
    assert.ok(!joined.includes('StrictHostKeyChecking=no'), `${label} 里还有 StrictHostKeyChecking=no`)
    assert.ok(args.includes('StrictHostKeyChecking=accept-new'), `${label} 没有 accept-new：${joined}`)
    assert.ok(!joined.includes('-o no'), `${label} 出现了裸 no`)
  }
}])

cases.push(['known_hosts 必须是留存得下来的真路径（不是 NUL///dev/null）', () => {
  process.env.DSH_HOME = join(tempHome, '.dsh')
  try {
    const expected = join(process.env.DSH_HOME, 'dsh-pocket', 'known_hosts')
    assert.equal(knownHostsPath(cfg), expected)
    for (const args of [buildSshArgs(cfg, 3081), buildRemoteCmdArgs(cfg)]) {
      const flag = args.find((a) => String(a).startsWith('UserKnownHostsFile='))
      assert.ok(flag, '没有 UserKnownHostsFile 参数')
      const value = flag.slice('UserKnownHostsFile='.length)
      assert.equal(value, expected)
      assert.notEqual(value, 'NUL')
      assert.notEqual(value, '/dev/null')
      assert.ok(String(value).includes('known_hosts'), `known_hosts 路径不对：${value}`)
    }
  } finally {
    delete process.env.DSH_HOME
  }
}])

cases.push(['cfg 字段可覆写（settings.json 里写 knownHostsPath / hostKeyChecking 说了算）', () => {
  const custom = normalizeSshTunnelConfig({
    ...baseCfg,
    knownHostsPath: join(tempHome, 'my-known-hosts'),
    hostKeyChecking: 'yes',
  })
  assert.equal(custom.knownHostsPath, join(tempHome, 'my-known-hosts'))
  assert.equal(custom.hostKeyChecking, 'yes')
  assert.equal(knownHostsPath(custom), join(tempHome, 'my-known-hosts'))
  for (const args of [buildSshArgs(custom, 3081), buildRemoteCmdArgs(custom)]) {
    assert.ok(args.includes('UserKnownHostsFile=' + join(tempHome, 'my-known-hosts')), 'cfg 覆写没进参数')
    assert.ok(args.includes('StrictHostKeyChecking=yes'), 'cfg 覆写没进参数')
  }
}])

cases.push(['环境变量覆写优先于 cfg（DSH_POCKET_SSH_KNOWN_HOSTS / DSH_POCKET_SSH_HOST_KEY_CHECKING）', () => {
  process.env.DSH_POCKET_SSH_KNOWN_HOSTS = join(tempHome, 'env-known-hosts')
  process.env.DSH_POCKET_SSH_HOST_KEY_CHECKING = 'yes'
  try {
    const merged = { ...cfg }
    assert.equal(knownHostsPath(merged), join(tempHome, 'env-known-hosts'))
    const args = buildSshArgs(merged, 3081)
    assert.ok(args.includes('UserKnownHostsFile=' + join(tempHome, 'env-known-hosts')))
    assert.ok(args.includes('StrictHostKeyChecking=yes'))
  } finally {
    delete process.env.DSH_POCKET_SSH_KNOWN_HOSTS
    delete process.env.DSH_POCKET_SSH_HOST_KEY_CHECKING
  }
}])

cases.push(['显式降级（hostKeyChecking:"no"）仍然改得出来，坏值一律回默认 accept-new', () => {
  const downgraded = normalizeSshTunnelConfig({ ...baseCfg, hostKeyChecking: 'no' })
  assert.equal(downgraded.hostKeyChecking, 'no')
  assert.ok(buildRemoteCmdArgs(downgraded).includes('StrictHostKeyChecking=no'), '降级余地应当真的存在（给人自愿承担风险的出口）')
  const bogus = normalizeSshTunnelConfig({ ...baseCfg, hostKeyChecking: 'whatever' })
  assert.equal(bogus.hostKeyChecking, '', '坏值该归空（= 未配置）')
  assert.ok(buildSshArgs(bogus, 3081).includes('StrictHostKeyChecking=accept-new'), '坏值没有回落到安全默认')
  const camel = normalizeSshTunnelConfig({ ...baseCfg, hostKeyChecking: 'AcceptNew' })
  assert.equal(camel.hostKeyChecking, 'accept-new')
}])

cases.push(['归一化必须带上这两项字段（旧 settings.json 缺字段也照样安全）', () => {
  const legacy = normalizeSshTunnelConfig({ host: 'a.example.com', user: 'u', keyPath: 'k' })
  assert.equal(legacy.hostKeyChecking, '')
  assert.equal(legacy.knownHostsPath, '')
  assert.ok(buildSshArgs(legacy, 3081).some((a) => String(a).startsWith('UserKnownHostsFile=')))
  assert.deepEqual(Object.keys(normalizeSshTunnelConfig({})), Object.keys(legacy))
}])

cases.push(['源码里不许再出现旧的「no + 空 known_hosts」写法', () => {
  const here = new URL('../src/pocket-host/ssh-tunnel.mjs', import.meta.url)
  const src = readFileSync(here, 'utf8')
  assert.ok(!src.includes('StrictHostKeyChecking=no'), 'ssh-tunnel.mjs 里还留着 StrictHostKeyChecking=no')
  assert.ok(!src.includes('knownHostsNull'), 'ssh-tunnel.mjs 里还留着 knownHostsNull()')
  assert.ok(!/UserKnownHostsFile=[^\n]*(dev\/null|NUL)/.test(src), 'ssh-tunnel.mjs 里还往 NUL//dev/null 写主机键')
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
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
