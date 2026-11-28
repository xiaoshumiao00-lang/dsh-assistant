/**
 * personal-context-lib.mjs — 「个人化标识」的派生器，供仓库体检脚本使用。
 *
 * 设计要点（本轮清洗纪律）：
 *   - 这个文件里没有任何字面个人标识；标识一律从本机环境与仓库受保护构件派生。
 *   - 派生类别：本机账户名与其路径形态、私有档案根目录（中文姓名 + 机构缩写）、
 *     安卓包标识段（姓名拼音形态，来自 android/ 的清单与签名主体）。
 *   - 无法从本机派生的三类别（档案子目录标记、联系人名标签、已退役仓库名）来自仓库外
 *     的本机 override 文件；文件缺失时这三类不参与扫描，并在体检输出里点名说明。
 *   - 断言强度不变：测试仍逐条比对，只是标识来源从「写死的字面量」换成「派生值」。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CJK = '[\\u4e00-\\u9fff]'
const OVERRIDE_FILE = process.env.DSH_GUARD_MARKERS_FILE || join('D:\\', 'dsh-assistant-local', 'guard-markers.json')

function readText(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** 本机账户名 + 家目录路径形态 */
export function accountName() {
  const fromEnv = process.env.USERNAME || ''
  if (fromEnv) return fromEnv
  const parts = (process.env.USERPROFILE || homedir()).split(/[\\/]+/)
  return parts.filter(Boolean).pop() || ''
}

export function accountPath() {
  return process.env.USERPROFILE || homedir() || ''
}

export function homeDir() {
  return homedir() || accountPath()
}

/** 助手家目录（运行时真值，测试不许再写死本机用户名） */
export function dshRoot() {
  return join(homeDir(), '.dsh')
}

export function assistantHome() {
  return join(homeDir(), '.dsh', 'assistant')
}

export function dshPath(...segments) {
  return join(homeDir(), '.dsh', ...segments)
}

/** 会话目录名：家路径按分隔符摊平的形态 */
export function sanitizedSessionDir(cwd = assistantHome()) {
  return '--' + String(cwd).replace(/[\\/:]+/g, '-') + '--'
}
export function accountMarkers() {
  const user = accountName()
  const profile = accountPath()
  const home = homeDir()
  const out = new Set()
  if (user) {
    out.add(user)
    out.add(user.toLowerCase())
  }
  for (const base of new Set([profile, home])) {
    if (!base) continue
    for (const form of [base, base.replace(/\\/g, '/'), base.replace(/^\w/, (c) => c.toUpperCase()), base.replace(/^\w/, (c) => c.toLowerCase())]) {
      out.add(form)
      out.add(form.replace(/\\/g, '/'))
    }
  }
  return [...out].filter((x) => x && x.length > 1)
}

/** 私有档案根：从盘面上「中文姓名 + 机构缩写」形态的目录派生，不写死字面量 */
export function archiveRootCandidates() {
  const rx = new RegExp('^' + CJK + '{2}[A-Z]{3,6}$')
  const drives = new Set(['D:\\', 'C:\\', process.env.SystemDrive ? process.env.SystemDrive + '\\' : '', homeDir().slice(0, 2) + '\\'])
  const found = []
  for (const drive of drives) {
    if (!drive) continue
    let entries = []
    try { entries = readdirSync(drive) } catch { continue }
    for (const name of entries) {
      if (rx.test(name)) found.push(drive + name)
    }
  }
  const override = loadOverride()
  for (const extra of override.archiveRoots || []) found.push(extra)
  return [...new Set(found)]
}

export function archiveRoot() {
  const list = archiveRootCandidates()
  return list[0] || join('D:\\', 'ArchiveFixture')
}

/** 档案根拆出的中文姓名与机构缩写（供标识扫描用） */
export function archiveRootParts() {
  const rx = new RegExp('^(' + CJK + '{2})([A-Z]{3,6})$')
  const parts = new Set()
  for (const root of archiveRootCandidates()) {
    const name = root.split(/[\\/]+/).pop() || ''
    const m = rx.exec(name)
    if (m) { parts.add(m[1]); parts.add(m[2]); parts.add(m[2].toLowerCase()); parts.add(m[1] + m[2]) }
  }
  return [...parts]
}

/** 安卓包标识段（姓名拼音形态）——从受保护的构件读取，不参与清洗 */
export function androidPackageSegment() {
  const manifest = readText(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'))
  const m = manifest.match(/package="com\.([a-z]+)\.assistant"/)
  if (m) return m[1]
  const build = readText(join(ROOT, 'android', 'build.ps1'))
  const d = build.match(/-dname\s+'CN=([A-Za-z]+),/)
  if (d) return d[1].toLowerCase()
  return 'app'
}

export function androidPackageId() {
  return 'com.' + androidPackageSegment() + '.assistant'
}

export function nameForms() {
  const segment = androidPackageSegment()
  const out = new Set()
  if (segment && segment !== 'app') {
    out.add(segment)
    out.add(segment.charAt(0).toUpperCase() + segment.slice(1))
    out.add(segment.toUpperCase())
    out.add(segment.toLowerCase())
  }
  const build = readText(join(ROOT, 'android', 'build.ps1'))
  for (const m of build.matchAll(/-dname\s+'CN=([A-Za-z]+)/g)) {
    const value = m[1]
    out.add(value)
    out.add(value.toLowerCase())
    out.add(value.toUpperCase())
  }
  return [...out]
}

function loadOverride() {
  const text = readText(OVERRIDE_FILE)
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

/** override 里带出来的非派生类别（联系人名标签 / 档案子目录标记 / 退役仓库名） */
export function overrideMarkers() {
  const data = loadOverride()
  const out = new Set()
  for (const key of ['contactMarkers', 'archiveMarkers', 'retiredMarkers']) {
    for (const value of data[key] || []) out.add(value)
  }
  return [...out]
}

export function overrideMissing() {
  return !readText(OVERRIDE_FILE)
}

/** 体检用的完整标识集合：派生类别 + override 类别 */
export function personalMarkers() {
  const out = new Set()
  for (const value of accountMarkers()) out.add(value)
  for (const value of nameForms()) out.add(value)
  for (const value of archiveRootParts()) out.add(value)
  for (const value of overrideMarkers()) out.add(value)
  for (const root of archiveRootCandidates()) out.add(root)
  for (const value of (loadOverride().pathMarkers || [])) out.add(value)
  return [...out].filter((x) => typeof x === 'string' && x.length > 1)
}

export const overridePath = OVERRIDE_FILE

/** 逐类别出口（与第 1 轮登记的 6 类标识口径一一对应，全部派生） */
export function nameCjkMarkers() {
  return archiveRootParts().filter((x) => new RegExp('^' + CJK + '{2}$').test(x))
}
export function abbrevMarkers() {
  return archiveRootParts().filter((x) => /^[A-Z]{3,6}$/.test(x))
}
export function accountPathMarkers() {
  const profile = accountPath()
  return [profile, profile.replace(/\\/g, '/')]
}
export function contactMarkers() {
  return [...(loadOverride().contactMarkers || [])]
}
export function archiveTokenMarkers() {
  return [...(loadOverride().archiveMarkers || [])]
}
export function retiredMarkers() {
  return [...(loadOverride().retiredMarkers || [])]
}
export function lintMarkerClasses() {
  return {
    personal: [...new Set([...nameCjkMarkers(), ...nameForms(), ...abbrevMarkers(), ...contactMarkers(), ...accountPathMarkers(), ...archiveTokenMarkers(), ...archiveRootParts()])],
    retired: retiredMarkers(),
  }
}

/** 受保护的形态（安卓包标识、签名证书主体）不参与「个人化标识」判定：它们是应用 ID 与证书 DN，公开且功能性 */
export function protectedFormPatterns() {
  const seg = androidPackageSegment()
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const forms = [
    `com.${seg}.assistant`,
    `com/${seg}/assistant`,
    `com\\${seg}\\assistant`,
    `app/${seg}/assistant`,
    `${seg}/assistant`,
    `${seg}\\assistant`,
    `com.${seg}`,
  ].map(esc)
  return [new RegExp('(' + forms.join('|') + ')', 'gi'),
          /CN=[A-Za-z][A-Za-z]*(?:,\s*[A-Z]{2}=[A-Za-z]+){0,5}/g]
}

export function neutralizeProtectedForms(text) {
  let out = String(text)
  for (const rx of protectedFormPatterns()) out = out.replace(rx, '<PROTECTED-FORM>')
  return out
}
