/** pocket 首启默认与旧安装兼容（P0-5）：node scripts/test-pocket-first-run.mjs */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'pocket-settings-'))
process.env.DSH_HOME = home
const settings = await import('../src/pocket-host/settings.mjs')

const settingsFile = () => join(home, 'dsh-pocket', 'settings.json')
const readText = () => (existsSync(settingsFile()) ? readFileSync(settingsFile(), 'utf8') : '')

const cases = []

cases.push(['全新安装：没有 settings.json 时局域网访问默认关闭', () => {
  assert.equal(existsSync(settingsFile()), false, '测试起点不该已有文件')
  assert.equal(settings.lanEnabled(), false, '新装不该默认开局域网')
  assert.equal(settings.lanAuthEnabled(), true, '新装的局域网默认要密码')
}])

cases.push(['首启落盘把默认值写明确（之后不再靠猜）', () => {
  const written = settings.ensureFirstRunSettings()
  assert.ok(written, '该写出默认文件')
  const body = JSON.parse(readText())
  assert.equal(body.lanEnabled, false)
  assert.equal(body.lanAuthEnabled, true)
  assert.equal(settings.lanEnabled(), false)
  // 再叫一次不该重写文件
  const before = readText()
  assert.equal(settings.ensureFirstRunSettings(), null, '已有文件就不该再动')
  assert.equal(readText(), before, '已有文件内容必须一字不变')
}])

cases.push(['旧安装（文件存在但缺键）保持老语义：局域网开启', () => {
  writeFileSync(settingsFile(), JSON.stringify({ publicPinCustom: true }), 'utf8')
  assert.equal(settings.lanEnabled(), true, '升级不该把用户正在用的局域网访问突然关掉')
  assert.equal(settings.ensureFirstRunSettings(), null)
  assert.deepEqual(JSON.parse(readText()), { publicPinCustom: true }, '旧文件内容不该被改写')
}])

cases.push(['明确的 true / false 照原值办，损坏文件按旧安装处理', () => {
  writeFileSync(settingsFile(), JSON.stringify({ lanEnabled: true, lanAuthEnabled: false }), 'utf8')
  assert.equal(settings.lanEnabled(), true)
  assert.equal(settings.lanAuthEnabled(), false, '用户明确关过密码开关就该是关')
  writeFileSync(settingsFile(), '{ this is not json', 'utf8')
  assert.equal(settings.lanEnabled(), true, '损坏文件按旧安装（不因损坏突然收紧或放开）')
  writeFileSync(settingsFile(), JSON.stringify({ lanEnabled: false }), 'utf8')
  assert.equal(settings.lanEnabled(), false)
  assert.equal(settings.setLanEnabled(true), true)
  assert.equal(JSON.parse(readText()).lanEnabled, true)
  assert.equal(settings.setLanEnabled(false), false)
  assert.equal(settings.lanEnabled(), false)
}])

cases.push(['设置文件权限是 0600（里面存着 PIN 与隧道 Token）', () => {
  rmSync(settingsFile(), { force: true })
  settings.ensureFirstRunSettings()
  settings.setPinCustom?.('lan', true)
  // 权限断言跨平台太脆（Windows ACL 不同）：至少确认文件写在 dsh-pocket 下、且没漏到仓库里
  assert.ok(settingsFile().includes(join('dsh-pocket', 'settings.json')))
  assert.ok(!settingsFile().includes(process.cwd()), '设置文件不该落在插件仓库目录里')
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
rmSync(home, { recursive: true, force: true })
delete process.env.DSH_HOME
console.log(failed === 0 ? `PASS ${cases.length}/${cases.length}` : `FAIL ${failed}/${cases.length}`)
process.exit(failed === 0 ? 0 : 1)
