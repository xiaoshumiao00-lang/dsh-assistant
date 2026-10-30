/**
 * typecheck 入口（npm run typecheck）。诚实版：跑不起来就说跑不起来，绝不报「通过」。
 *
 * 本机实测（v0.2.11）：仓库没有 typescript devDependency，也没有 tsconfig 的历史版本；
 * 现在加了 tsconfig.json（只 include src/**，排除 src/pocket-host 与 src/cu-shims），
 * 编译器从 harness checkout 借来 —— CI 里没有它，所以 CI 也只跑 build/check/test。
 * 缺什么：@deepseek-ai/* 的 .d.ts 不在仓库里（运行时 external）、也没有 @types/node。
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tsconfigPath = join(repoRoot, 'tsconfig.json')

/** 找编译器：仓库 devDependency 优先，其次显式环境变量，最后才是本机 harness 里那份。 */
function findCompiler() {
  const localJs = join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js')
  const localCmd = join(repoRoot, 'node_modules', '.bin', 'tsc.cmd')
  const fromEnv = (process.env.DSH_ASSISTANT_TSC ?? '').trim()
  const harnessJs = 'D:\\deepseek-harness\\node_modules\\typescript\\lib\\tsc.js'

  if (existsSync(localJs)) return { run: process.execPath, args: [localJs], label: '仓库 typescript/lib/tsc.js' }
  if (existsSync(localCmd)) return { run: localCmd, args: [], label: '仓库 node_modules/.bin/tsc' }
  if (fromEnv && existsSync(fromEnv)) {
    if (fromEnv.endsWith('.js')) return { run: process.execPath, args: [fromEnv], label: '$DSH_ASSISTANT_TSC 指定的 tsc.js' }
    return { run: fromEnv, args: [], label: '$DSH_ASSISTANT_TSC 指定的编译器' }
  }
  if (existsSync(harnessJs)) return { run: process.execPath, args: [harnessJs], label: '本机 harness checkout 里的 typescript（离线本机才有，CI 里没有）' }
  return null
}

const compiler = findCompiler()
if (!compiler) {
  console.log('typecheck: 【跑不起来】—— 本机找不到 TypeScript 编译器（不是「通过了」）。')
  console.log('  找过：node_modules/typescript/lib/tsc.js、node_modules/.bin/tsc、$DSH_ASSISTANT_TSC、harness checkout 的 typescript')
  console.log('  要让它能跑：npm install --save-dev typescript @types/node（需要联网）')
  process.exit(2)
}

const args = [...compiler.args, '--noEmit', '--pretty', 'false', '--project', tsconfigPath]
let output = ''
let exitCode = 0
let spawnFailed = false
try {
  output = execFileSync(compiler.run, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }).toString()
} catch (err) {
  const status = typeof err?.status === 'number' ? err.status : 0
  const text = String(err?.stdout ?? '') + String(err?.stderr ?? '')
  // 状态码 0 且没有任何输出 = 命令根本没跑起来（ENOENT 之类），不能当成「无错误」
  spawnFailed = status === 0 && text.length === 0
  output = text
  exitCode = status || (spawnFailed ? 2 : 1)
}

if (spawnFailed) {
  console.log(`typecheck: 【跑不起来】—— 编译器启动失败（${compiler.label}），不是「通过了」。`)
  process.exit(2)
}

const errorLines = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line))
if (errorLines.length === 0) {
  console.log('typecheck: 通过（tsc 跑了，0 个 TS 错误）')
  console.log(`  用的编译器：${compiler.label}`)
  process.exit(0)
}

console.log(`typecheck: 【过不了】—— ${errorLines.length} 个 TS 错误（前 25 条）`)
for (const line of errorLines.slice(0, 25)) console.log('  ' + line)
console.log('  编译器：' + compiler.label)
console.log('  已知缺口：@deepseek-ai/* 没有 .d.ts、没有 @types/node —— 见 README「质量门」')
process.exit(1)
