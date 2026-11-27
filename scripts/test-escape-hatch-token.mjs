/**
 * 逃生开关一次性口令的语义回归（2026-11-28 手机访问安全整改第 4 项）：
 *   node scripts/test-escape-hatch-token.mjs
 *
 * 这一项的意义是「确认词不再是源码里的公开常量」，所以测试既要测随机性、落盘权限、一次性换新，
 * 也要反向核对：那个公开词不该再出现在源码 / 文案 / 构建产物里，当前口令也不该出现在构建产物里。
 * 为了不把这个公开词又写回仓库，下面用拼接构造它（测试文件里同样找不到那串字面量）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const assistant = await import('../lib/index.js')
const hatch = assistant.escapeHatchTestSurface
assert.ok(hatch && typeof hatch.ensureEscapeHatch === 'function', 'lib/index.js 没导出 escapeHatchTestSurface')
assert.ok(typeof assistant.escapeHatchStatus === 'function', 'lib/index.js 没导出 escapeHatchStatus')
assert.equal(assistant.ESCAPE_HATCH_FILENAME, 'escape-hatch.json', '口令文件名不认')

const tempHome = mkdtempSync(join(tmpdir(), 'escape-hatch-'))
const assistantDir = join(tempHome, '.dsh', 'assistant')
process.env.DSH_ASSISTANT_HOME = assistantDir
process.env.DSH_ASSISTANT_CONFIG = join(tempHome, 'config.json')
process.env.DSH_HOME = join(tempHome, '.dsh')

const publicWord = ['ALLOW', '-', 'ALL'].join('')
const hatchFile = () => hatch.escapeHatchFile()
const readHatch = () => readFileSync(hatchFile(), 'utf8')

const cases = []

cases.push(['助手目录不存在时也能生成口令并落盘', () => {
  assert.equal(existsSync(assistantDir), false, '这条用例要求目录还没被创建')
  const result = hatch.ensureEscapeHatch()
  assert.equal(result.ok, true, result.error)
  assert.equal(existsSync(assistantDir), true, '没建目录就写文件，等于口令没落盘')
  assert.equal(existsSync(hatchFile()), true)
  assert.equal(assistant.escapeHatchStatus().exists, true)
  assert.equal(assistant.escapeHatchStatus().file, hatchFile())
}])

cases.push(['口令是随机值：长度、字符集、两次生成互不相同', () => {
  const first = hatch.createEscapeHatchToken()
  const second = hatch.createEscapeHatchToken()
  assert.notEqual(first, second, '两次生成同一串等于还是公开常量')
  assert.equal(first.length, 24, '18 字节 base64url 应该是 24 位，实际长度是 ' + first.length)
  assert.match(first, /^[A-Za-z0-9_-]+$/, '字符集该是 base64url（不带 + / =，也不带反斜杠）')
  assert.ok(!first.includes(publicWord), '随机值里不该带那个公开词')
  const stored = hatch.ensureEscapeHatch()
  assert.equal(stored.ok, true)
  assert.equal(stored.record.token.length, 24)
  assert.match(stored.record.token, /^[A-Za-z0-9_-]+$/)
  assert.ok(stored.record.createdAt.length > 0 && stored.record.rotatedAt.length > 0, '生成时间与轮换时间都该有')
}])

cases.push(['口令文件权限走 0600（POSIX 硬断言；Windows 上如实说明 stat 模式不可靠）', () => {
  hatch.ensureEscapeHatch()
  const mode = statSync(hatchFile()).mode & 0o777
  if (process.platform === 'win32') {
    // Windows 的 NTFS ACL 不反映在 stat.mode 上（Node 一般给 0666）：
    // 真正拦住别人的是 ACL——文件由当前用户创建。这里只断「别出现谁都写的怪值」，不硬要 0600。
    assert.ok([0o600, 0o666, 0o644, 0o400, 0o444].includes(mode), 'Windows 上出现了意外的模式：' + mode.toString(8))
    return
  }
  assert.equal(mode, 0o600, 'POSIX 上该是 0600，实际 ' + mode.toString(8))
}])

cases.push(['比对走 timing-safe 口径：非字符串、空串、长度不符、错值一律不通过', () => {
  const current = hatch.ensureEscapeHatch()
  assert.equal(current.ok, true)
  const token = current.record.token
  assert.equal(hatch.verifyEscapeHatchConfirm(token), true, '正确口令不该通过不了')
  assert.equal(hatch.verifyEscapeHatchConfirm(token + 'x'), false, '多一位就不该通过')
  assert.equal(hatch.verifyEscapeHatchConfirm(token.slice(0, 4)), false, '截短就不该通过')
  assert.equal(hatch.verifyEscapeHatchConfirm(''), false)
  assert.equal(hatch.verifyEscapeHatchConfirm(undefined), false)
  assert.equal(hatch.verifyEscapeHatchConfirm(null), false)
  assert.equal(hatch.verifyEscapeHatchConfirm(token), true, '同一串该可重复比对（作废只发生在写成功之后）')
  assert.equal(hatch.verifyEscapeHatchConfirm({ toString: () => token }), false, '非字符串不该被蒙混成字符串')
  assert.equal(hatch.verifyEscapeHatchConfirm('x'.repeat(4096)), false, '过长的入参不该走比对')
}])

cases.push(['一次性：换新之后旧口令即刻作废', () => {
  const old = hatch.ensureEscapeHatch().record.token
  const rotated = hatch.rotateEscapeHatch()
  assert.equal(rotated.ok, true, rotated.error)
  assert.notEqual(rotated.record.token, old, '轮换没有真的换值')
  assert.equal(hatch.verifyEscapeHatchConfirm(old), false, '旧口令该即刻作废')
  assert.equal(hatch.verifyEscapeHatchConfirm(rotated.record.token), true, '新口令该能用')
  assert.ok(!readHatch().includes(old), '文件里还留着旧口令')
}])

cases.push(['口令文件坏掉时当场换新：不抛错、也不认坏值', () => {
  mkdirSync(assistantDir, { recursive: true })
  writeFileSync(hatchFile(), 'not json at all', 'utf8')
  const broken = hatch.ensureEscapeHatch()
  assert.equal(broken.ok, true, broken.error)
  assert.equal(hatch.verifyEscapeHatchConfirm(''), false)
  assert.equal(hatch.verifyEscapeHatchConfirm(broken.record.token), true, '换新之后该能用')
  writeFileSync(hatchFile(), JSON.stringify({ token: 'too-short' }), 'utf8')
  const short = hatch.ensureEscapeHatch()
  assert.equal(short.ok, true)
  assert.notEqual(short.record.token, 'too-short', '长度太小的存量值不该被采纳')
  assert.equal(hatch.verifyEscapeHatchConfirm('too-short'), false)
}])

cases.push(['那个公开确认词不再出现在源码与文案里（含设置页与 README）', () => {
  const files = [
    'src/assistant-config.ts',
    'src/assistant-escape-hatch.ts',
    'src/client/assistant-local-config.tsx',
    'src/client/assistant-config.ts',
    'src/client/locales.ts',
    'src/pocket-host/web-rpc.js',
    'README.md',
  ]
  for (const file of files) {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.ok(!text.includes(publicWord), file + ' 里还留着公开确认词')
  }
  const panel = readFileSync(new URL('../src/client/assistant-local-config.tsx', import.meta.url), 'utf8')
  assert.ok(/fetchEscapeHatchToken/.test(panel), '设置页没有走「取一次性口令」这条路径')
  assert.ok(/patch\.confirm = allowAllToken/.test(panel), '保存时没把取到的口令带上')
  assert.ok(!/setAllowAllText/.test(panel), '设置页还留着「手输确认词」那套旧流程')
}])

cases.push(['当前口令不出现在本机配置与客户端视图里（只有那条回环路由带本体）', () => {
  const token = hatch.ensureEscapeHatch().record.token
  const configText = existsSync(process.env.DSH_ASSISTANT_CONFIG) ? readFileSync(process.env.DSH_ASSISTANT_CONFIG, 'utf8') : ''
  assert.ok(!configText.includes(token), '口令不该写进本机配置文件')
  assert.ok(!JSON.stringify(assistant.assistantConfigTestSurface.assistantConfigClientView()).includes(token), '客户端视图带出了口令本体')
  assert.ok(!JSON.stringify(assistant.escapeHatchStatus()).includes(token), '状态摘要带出了口令本体（它只该给路径与长度）')
  assert.equal(assistant.escapeHatchStatus().tokenLength, token.length)
}])

cases.push(['构建产物里既没有公开词、也没有当前口令', () => {
  const token = hatch.ensureEscapeHatch().record.token
  for (const bundle of ['lib/index.js', 'lib/pocket.js', 'lib/client.js']) {
    const text = readFileSync(new URL('../' + bundle, import.meta.url), 'utf8')
    assert.ok(!text.includes(publicWord), bundle + ' 里还留着公开确认词')
    assert.ok(!text.includes(token), bundle + ' 里带出了当前口令本体')
  }
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
