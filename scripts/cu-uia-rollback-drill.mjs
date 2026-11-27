/**
 * 一键回退演练（真跑，不是纸上口径）：
 *   node scripts/cu-uia-rollback-drill.mjs
 *   node scripts/cu-uia-rollback-drill.mjs --baseline ebf16ae   # 换基线（默认就是本轮改动前的 HEAD）
 *
 * 验三件事：
 *   ① 与基线相比**只有新增文件**（现有文件零改动）→ 删掉新增文件就等于回到改动前；
 *   ② 关通道后现有 CU 测试全绿（capture-scale / observation-surface / bridge / code-agent-notice / title-bold）
 *      ＋本通道自己的单测（test-cu-uia-core）；
 *   ③ 打印可照抄的回退命令（三选一：git revert / git checkout / 删新增文件 + 关开关）。
 *
 * 退出码：0 = 三条全过；1 = 有一条不过（打印是哪条）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const baselineArg = (() => {
  const index = argv.indexOf('--baseline')
  return index === -1 ? '' : String(argv[index + 1] ?? '')
})()

/** 本轮改动前的 HEAD（= 清单 commit aef60f0 的父提交）。 */
export const DEFAULT_BASELINE = 'ebf16ae'

const CU_TESTS = [
  'test-cu-capture-scale.mjs',
  'test-cu-observation-surface.mjs',
  'test-cu-bridge.mjs',
  'test-cu-code-agent-notice.mjs',
  'test-cu-title-bold.mjs',
  'test-cu-uia-core.mjs',
]

function git(args) {
  // core.quotepath=false：中文路径原样打印，回退命令才能照抄
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { encoding: 'utf8' }).trim()
}

let failed = 0
const baseline = baselineArg === '' ? DEFAULT_BASELINE : baselineArg
console.log('== ① 与基线比对（只许新增文件）==')
console.log(`  基线 commit：${baseline}（${git(['log', '-1', '--pretty=%s', baseline])}）`)
const status = git(['diff', '--name-status', baseline, 'HEAD']).split('\n').filter(Boolean)
const added = []
const touched = []
for (const line of status) {
  const [kind, ...rest] = line.split('\t')
  const path = rest.join('\t')
  if (kind === 'A') added.push(path)
  else touched.push(`${kind} ${path}`)
}
console.log(`  新增文件 ${added.length} 个：`)
for (const path of added) console.log(`    A ${path}`)
if (touched.length === 0) {
  console.log('  现有文件改动：0 个（零改动 → 删掉上面这些新增文件即回到基线行为）')
} else {
  failed += 1
  console.log(`  现有文件被改：${touched.length} 个 ✗`)
  for (const line of touched) console.log(`    ${line}`)
}

console.log('\n== ② 关通道后跑现有 CU 测试 ==')
for (const name of CU_TESTS) {
  const file = `scripts/${name}`
  if (!existsSync(file)) { failed += 1; console.log(`  ${name}: 缺文件 ✗`); continue }
  try {
    execFileSync(process.execPath, [file], { stdio: 'pipe', env: { ...process.env, DSH_CU_UIA: '0' } })
    console.log(`  ${name}: PASS（DSH_CU_UIA=0）`)
  } catch (error) {
    failed += 1
    const out = String(error?.stdout ?? '') + String(error?.stderr ?? '')
    console.log(`  ${name}: FAIL ✗`)
    console.log(out.split('\n').slice(-6).map((line) => '    ' + line).join('\n'))
  }
}

console.log('\n== ③ 回退命令（三选一，任一条都能回到改动前）==')
console.log(`  1) 保留历史、反向提交：git revert --no-edit $(git rev-list --reverse ${baseline}..HEAD | tr '\\n' ' ')`)
console.log(`  2) 直接丢弃本轮改动： git checkout ${baseline} -- .   （或 git reset --hard ${baseline}）`)
console.log('  3) 只删新增文件 + 关开关：')
for (const path of added) console.log(`       rm "${path}"`)
console.log('       echo \'{"enabled": false}\' > <profile>/dsh-assistant-cu-uia.json   # 或 DSH_CU_UIA=0')
console.log('  关开关（默认就是关）：设置页 CU 面板「控件树通道」= 关；或环境变量 DSH_CU_UIA=0')

console.log(failed === 0 ? '\nRESULT: PASS（基线可回退：只有新增文件 + 关通道后 CU 测试全绿）' : `\nRESULT: FAIL（${failed} 项不过）`)
if (failed > 0) process.exit(1)
