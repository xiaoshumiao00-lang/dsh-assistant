/**
 * dsh-assistant 卸载脚本（P0-7）。
 *
 * 默认（不带 --purge）= 「解除安装」，不动任何用户数据：
 *   1. 删掉 profile 里的 junction（<DSH_HOME>/profiles/<profile>/node_modules/dsh-assistant）
 *      —— 只删联接本身，仓库目录内容一概不碰。
 *   2. 还原 profile package.json：优先用安装时留下的备份
 *      package.json.bak-assistant-<时间戳>（取最近的一个）；
 *      没有备份时只剥掉本插件自己加的依赖与 bundles 项，并告诉你该手动补回谁。
 *
 * --purge = 「连数据一起清」：删 <profile>/dsh-assistant-ball/、助手家目录 ~/.dsh/assistant/
 * （含 config.json、AGENTS.md、journal/、notes/、outputs/、archive/）、
 * 状态文件 dsh-assistant-state.json、托管状态 dsh-tuoguan-state.json、
 * 桌面球日志 dsh-assistant-focus.log。删前先把每个要删的东西挪进
 * <DSH_HOME>/uninstall-backup-<时间戳>/，所以 purge 之后还能翻回来。
 *
 * 浏览器侧的数据这个脚本碰不到（它是宿主进程），--purge 时打印一份清单与粘贴即用的 DevTools 片段：
 *   IndexedDB: dsh-worktable（控制室照片库）
 *   localStorage: dsh.assistant.*  dsh.worktable.*  dsh-assistant.*  dsh-tuoguan.*  dsh-pocket.*
 *   明确不碰：dsh.sessions.current（宿主的，不是本插件的）
 *
 * 用法：
 *   node scripts/uninstall-assistant.mjs [profileName] [--purge] [--yes] [--dry-run] [--keep-links]
 * 卸载后必须重启 DSH Desktop 才算「真的卸掉了」。
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, renameSync, rmSync, writeFileSync, readlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const purge = flags.has('--purge')
const dryRun = flags.has('--dry-run')
const assumeYes = flags.has('--yes') || process.env.DSH_ASSISTANT_UNINSTALL_YES === '1'
const keepLinks = flags.has('--keep-links')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileName = positional[0] || 'desktop'
const profileDir = join(dshHome, 'profiles', profileName)
const pkgPath = join(profileDir, 'package.json')
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const linkPath = join(profileDir, 'node_modules', 'dsh-assistant')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

/** 浏览器侧数据清单（脚本删不掉，只给你名单 + 可粘贴的片段） */
const BROWSER_PREFIXES = ['dsh.assistant.', 'dsh.worktable.', 'dsh-assistant.', 'dsh-tuoguan.', 'dsh-pocket.']
const BROWSER_INDEXEDDB = ['dsh-worktable']
const NEVER_TOUCH = ['dsh.sessions.current', 'dsh-layout', 'dsh-mobile-nav']

const plan = []
const log = (line) => plan.push(line)

function newestBackup() {
  try {
    const candidates = readdirSync(profileDir)
      .filter((name) => name.startsWith('package.json.bak-assistant-'))
      .map((name) => ({ name, mtime: statSync(join(profileDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return candidates[0] ?? null
  } catch { return null }
}

/** 是不是「指向别处」的 reparse point（junction / symlink）——只有这种才该摘掉。
 *  readlinkSync 能读到目标就是 reparse point；普通目录抛 EINVAL / ENOENT。 */
function reparseTarget(path) {
  try {
    const target = readlinkSync(path)
    const text = Buffer.isBuffer(target) ? target.toString('utf8') : String(target ?? '')
    return text.length > 0 ? text : null
  } catch { return null }
}

function removeJunction(path, label) {
  if (!existsSync(path)) { log(`  跳过（不存在）：${label}`); return }
  const target = reparseTarget(path)
  if (!target) {
    log(`  跳过：${label} 不是 junction/符号链接（里面有真实文件？），不动 ${path}`)
    return
  }
  log(`  ${label} 指向：${target}`)
  if (dryRun) { log(`  会摘：${label} ${path}`); return }
  if (process.platform === 'win32') {
    // rmdir 只摘掉联接本身，不会顺着联接删仓库内容
    try {
      execFileSync('cmd', ['/c', 'rmdir', path], { stdio: 'pipe' })
      log(`  已解除 junction：${label}`)
      return
    } catch (err) { log(`  junction 解除失败（手动删也行）：${label} —— ${String(err?.stderr ?? err).trim()}`) }
    return
  }
  try { rmSync(path, { recursive: false, force: true }); log(`  已删：${label}`) } catch (err) { log(`  删失败：${label} —— ${err?.message ?? err}`) }
}

function moveToBackup(path, backupDir, label) {
  if (!existsSync(path)) { log(`  跳过（不存在）：${label}`); return }
  const target = join(backupDir, label)
  if (dryRun) { log(`  会挪走：${label}`); return }
  try {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(path, target)
    log(`  已挪进备份：${label} → ${target}`)
  } catch (err) { log(`  挪动失败：${label} —— ${err?.message ?? err}`) }
}

function confirm(message) {
  if (assumeYes || dryRun) return true
  process.stdout.write(message + ' [y/N] ')
  const answer = String(readFileSync(0, 'utf8') ?? '').trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

// ---------- 1) junction ----------
log(`[uninstall] profile: ${profileName}`)
log(`[uninstall] 仓库: ${repo}（本脚本不删仓库目录）`)
if (!keepLinks) removeJunction(linkPath, 'junction dsh-assistant')

// ---------- 2) profile package.json ----------
const backup = newestBackup()
if (existsSync(pkgPath)) {
  if (backup) {
    log(`[uninstall] 还原 profile package.json ← ${backup.name}`)
    if (!dryRun) {
      try {
        const current = readFileSync(pkgPath, 'utf8')
        writeFileSync(`${pkgPath}.before-restore-${stamp}`, current, 'utf8')
        renameSync(join(profileDir, backup.name), pkgPath)
        log('  已还原（当前版本先存了一份 package.json.before-restore-*）')
      } catch (err) { log(`  还原失败：${err?.message ?? err}`) }
    }
  } else {
    log('[uninstall] 没有安装时的 package.json 备份：只剥本插件自己加的项，不猜原来的 bundles')
    if (!dryRun) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        const before = JSON.stringify(pkg, null, 2)
        let changed = false
        if (pkg?.dependencies?.['dsh-assistant']) { delete pkg.dependencies['dsh-assistant']; changed = true }
        const bundles = pkg?.dsh?.profile?.bundles
        if (Array.isArray(bundles) && bundles.includes('dsh-assistant')) {
          pkg.dsh.profile.bundles = bundles.filter((n) => n !== 'dsh-assistant')
          changed = true
        }
        if (changed) {
          writeFileSync(`${pkgPath}.before-uninstall-${stamp}`, before, 'utf8')
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
          log('  已剥掉 dsh-assistant（改动前的 package.json 存成 .before-uninstall-*）')
        } else {
          log('  package.json 里没有本插件的依赖/bundles 项，无需改动')
        }
      } catch (err) { log(`  package.json 处理失败：${err?.message ?? err}`) }
    }
    log('  手动补回原插件：在 bundles 与 dependencies 里把 dsh-worktable / dsh-pocket / dsh-tuoguan 加回来（安装脚本换掉的）')
  }
} else {
  log(`[uninstall] 找不到 profile：${pkgPath}（跳过 package.json）`)
}

// ---------- 3) --purge：用户数据 ----------
if (purge) {
  log('')
  log('[uninstall] --purge：要把助手数据挪进备份目录再删')
  if (!dryRun && !confirm('确认删除本机助手数据（~/.dsh/assistant 与状态文件）？')) {
    log('  未确认：数据一律保留，只完成了 junction 与 package.json 的解除')
  } else {
    const backupDir = join(dshHome, `uninstall-backup-${stamp}`)
    if (!dryRun) mkdirSync(backupDir, { recursive: true })
    const targets = [
      [join(profileDir, 'dsh-assistant-ball'), 'profile_dsh-assistant-ball'],
      [join(dshHome, 'assistant'), 'assistant 家目录'],
      [join(profileDir, 'dsh-assistant-state.json'), 'profile_dsh-assistant-state.json'],
      [join(dshHome, 'dsh-assistant-state.json'), 'dsh-assistant-state.json'],
      [join(profileDir, 'dsh-tuoguan-state.json'), 'profile_dsh-tuoguan-state.json'],
      [join(dshHome, 'dsh-tuoguan-state.json'), 'dsh-tuoguan-state.json'],
      [join(dshHome, 'dsh-assistant-focus.log'), 'dsh-assistant-focus.log'],
      [join(dshHome, 'dsh-assistant-config.json'), 'dsh-assistant-config.json（兼容旧位置）'],
      [join(dshHome, 'assistant', 'config.json'), 'assistant_config.json'],
    ]
    for (const [path, label] of targets) moveToBackup(path, backupDir, label.replace(/[\\/]/g, '_'))
    if (!dryRun) log(`  备份目录：${backupDir}`)
    log('  明确没碰：~/.dsh/sessions（会话本体）、~/.mnemon（宿主热记忆真值）、其它插件的目录')
  }
}

// ---------- 4) 浏览器侧清单（永远打印，脚本删不到） ----------
log('')
log('[uninstall] 浏览器侧的数据要自己在 DSH 页面控制台清（本脚本不假装能删）：')
log(`  IndexedDB: ${BROWSER_INDEXEDDB.join(', ')}（控制室照片库）`)
log(`  localStorage 前缀: ${BROWSER_PREFIXES.join(' ')}`)
log(`  不要清（宿主的，不是本插件的）: ${NEVER_TOUCH.join(' ')}`)
const snippet = [
  'for (const k of Object.keys(localStorage))',
  `  if (${JSON.stringify(BROWSER_PREFIXES)}.some((p) => k.startsWith(p))) localStorage.removeItem(k)`,
  `indexedDB.deleteDatabase(${JSON.stringify(BROWSER_INDEXEDDB[0])})`,
].join('\n')
log('  可粘贴片段：')
for (const line of snippet.split('\n')) log('    ' + line)

log('')
log(dryRun ? '[uninstall] --dry-run：上面只是计划，什么都没动' : '[uninstall] 完成。要真正生效请重启 DSH Desktop。')
process.stdout.write(plan.join('\n') + '\n')
