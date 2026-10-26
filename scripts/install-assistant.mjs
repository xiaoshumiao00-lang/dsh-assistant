// 把 dsh-assistant 装进 DSH Desktop 的 desktop profile：
//   - 在本仓库与 profile 的 node_modules 之间建 junction（Windows 目录联接，等价 link:）
//   - profile package.json：依赖加 dsh-assistant；bundles 里用 dsh-assistant 顶替
//     dsh-pocket 与 dsh-worktable（两个原插件的包仍留在磁盘，随时可回退）
//
// 用法：node scripts/install-assistant.mjs [profileName]
// 回退：把 package.json.bak-assistant-<时间戳> 复制回 package.json 再重启。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileName = process.argv[2] || 'desktop'
const profileDir = join(dshHome, 'profiles', profileName)
const pkgPath = join(profileDir, 'package.json')
const repo = process.cwd()

if (!existsSync(pkgPath)) {
  console.error(`找不到 profile：${pkgPath}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${pkgPath}.bak-assistant-${stamp}`
copyFileSync(pkgPath, backup)

pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-assistant'] = `link:${repo.replace(/\\/g, '/')}`

const bundles = pkg?.dsh?.profile?.bundles || []
const replaced = []
const next = []
for (const name of bundles) {
  if (name === 'dsh-worktable') {
    next.push('dsh-assistant')
    replaced.push(name)
  } else if (name === 'dsh-pocket') {
    replaced.push(name)
    // 位置示意：dsh-assistant 放在工作台原来的位置
  } else {
    next.push(name)
  }
}
if (!next.includes('dsh-assistant')) next.push('dsh-assistant')
pkg.dsh.profile.bundles = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

const link = join(profileDir, 'node_modules', 'dsh-assistant')
if (!existsSync(link)) {
  execFileSync('cmd', ['/c', 'mklink', '/J', link, repo], { stdio: 'inherit' })
}

console.log(`[install] profile: ${profileName}`)
console.log(`[install] backup : ${backup}`)
console.log(`[install] bundles: ${next.join(', ')}`)
console.log(`[install] replaced: ${replaced.join(', ')}`)
console.log('[install] 重启 DSH Desktop 后生效。')
