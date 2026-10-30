/**
 * 标准检查（不靠 eslint 的 lint）：查的是「能离线查的东西」，不是代码风格。
 *   1. 仓库源码里不许再出现本机个人化标识（测试与这份脚本自己除外——黑名单本来就得写出来）
 *   2. 不许再出现已退役的旧仓库名
 *   3. 两处版本号必须一致（package.json 与 dsh.plugin.json）
 *   4. 运行时自名必须一致（宿主入口与客户端入口都叫 dsh-assistant）
 *   5. scripts/*.mjs 里不许出现 TypeScript 注解（Node 直接跑 .mjs 会 SyntaxError）
 *   6. 宿主日志前缀不许再自称 dsh-worktable
 *
 * 用法：node scripts/lint-standards.mjs   （0 退出码 = 干净）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** 黑名单本身必须写出来，所以这些文件豁免「标识不得复现」这条 */
const SELF_EXEMPT = new Set(['scripts/lint-standards.mjs', 'scripts/test-release-consistency.mjs'])

const PERSONAL_MARKERS = ['陈潘', 'ChenPan', 'HBEU', '微信联系人', 'C:\\Users\\Administrator', '01_content']
const RETIRED_REPOS = ['Aisland-SJL', 'Paper-Workspace']

const problems = []

function walk(dir, base = '', visitFiles = false) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const full = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (name === 'node_modules' || name === 'lib' || name === '.git' || name.startsWith('.') && name !== '.github') continue
    let st = null
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, rel, visitFiles)
    else if (visitFiles && /\.(ts|tsx|js|mjs|cjs|json|md)$/.test(name)) files.push(rel)
  }
}

const files = []
walk(repoRoot, '', true)

function isTestFile(rel) { return rel.startsWith('scripts/') || /test[-./]/.test(rel) }

const scanned = files.filter((rel) => {
  const key = rel.replace(/^\.\//, '')
  if (SELF_EXEMPT.has(key)) return false
  if (isTestFile(key)) return false
  return true
})

for (const rel of scanned) {
  let text = ''
  try { text = readFileSync(join(repoRoot, rel), 'utf8') } catch { continue }
  for (const marker of PERSONAL_MARKERS) {
    if (text.includes(marker)) problems.push(`${rel}: 出现本机个人化标识「${marker}」`)
  }
  for (const retired of RETIRED_REPOS) {
    if (text.includes(retired)) problems.push(`${rel}: 出现已退役仓库名「${retired}」`)
  }
}

// 测试文件里的黑名单断言是必要的，但测试不许给自己留 TS 注解
for (const rel of files.filter((f) => f.endsWith('.mjs') && f.startsWith('scripts/'))) {
  const text = readFileSync(join(repoRoot, rel), 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (/^\s*(const|let)\s+[A-Za-z_$][\w$]*\s*:\s*(string|number|boolean|any|unknown)\b/.test(line)) {
      problems.push(`${rel}:${i + 1}: .mjs 里出现 TypeScript 注解（Node 直接跑会 SyntaxError）`)
    }
    if (/function [A-Za-z_$][\w$]*\([^)]*:\s*(string|number|any)\b/.test(line)) {
      problems.push(`${rel}:${i + 1}: .mjs 里出现带类型的函数签名`)
    }
  })
}

// 版本号一致性 + 运行时自名
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(repoRoot, 'dsh.plugin.json'), 'utf8'))
if (pkg.version !== manifest.version) {
  problems.push(`package.json 版本 ${pkg.version} 与 dsh.plugin.json 版本 ${manifest.version} 不一致`)
}
for (const [file, expected] of [['src/index.ts', "export const name = 'dsh-assistant'"], ['src/assistant.ts', "export const name = 'dsh-assistant'"], ['src/client/assistant.tsx', "export const name = 'dsh-assistant'"]]) {
  const text = readFileSync(join(repoRoot, file), 'utf8')
  if (!text.includes(expected)) problems.push(`${file}: 运行时自名没写成 ${expected}`)
}

// 宿主日志前缀
const hostSource = readFileSync(join(repoRoot, 'src/index.ts'), 'utf8')
if (/\[dsh-worktable\]/.test(hostSource)) {
  problems.push('src/index.ts: 宿主日志还自称 [dsh-worktable]（客户端 warn 前缀留着是故意的，见 README）')
}

if (problems.length === 0) {
  console.log(`lint-standards: 干净（扫了 ${scanned.length} 个源码文件 + ${files.filter((f) => f.endsWith('.mjs')).length} 个脚本）`)
  process.exit(0)
}
console.log(`lint-standards: 发现 ${problems.length} 个问题`)
for (const problem of problems) console.log('  - ' + problem)
process.exit(1)
