/**
 * 唯一的更新源与升级指令（P0-4 闭环；P0-3 改为可配置）。
 *
 * 2026-11-05（P0-3）：更新源不再写死作者的 GitHub 仓库。别人的机器装了这个插件，
 * 不该被作者的仓库牵着升级（点一下就把自己的安装换成作者的构建）。现在的规则：
 *   - 真值来自本机配置：`updateSource`（owner/repo）+ `updateCheckEnabled`（默认 false）；
 *   - 两项都没配 → `checkUpdate()` 直接返回 'disabled'，**不发任何网络请求**；
 *   - 升级命令也按本机配置拼，未配置时给出"先去设置里填"的提示而不是一个错仓库。
 * 设置位置：设置 → 个人助手 → 本机配置 → 更新检查。
 */
declare const __WT_VERSION__: string
export const LOCAL_VERSION = typeof __WT_VERSION__ === 'undefined' ? 'dev' : __WT_VERSION__

import { updateSettingsSync } from './assistant-config.ts'

/** 插件安装名 / 发布 tgz 文件名（与 package.json、dsh.plugin.json 同名）。 */
export const PLUGIN_NAME = 'dsh-assistant'

/** 本机的更新源仓库（`owner/repo`）；没有配置时返回空串 = 不做更新检查。 */
export function updateRepo(): string {
  return updateSettingsSync().source
}

/** 本机是否允许检查更新（默认 false）。 */
export function updateCheckAllowed(): boolean {
  return updateSettingsSync().enabled && updateRepo() !== ''
}

/** 发布包地址（本机配置的仓库）；未配置时返回空串。 */
export function latestTgzUrl(): string {
  const repo = updateRepo()
  return repo ? `https://github.com/${repo}/releases/latest/download/${PLUGIN_NAME}.tgz` : ''
}

/** Releases 页面地址；未配置时返回空串（调用方据此隐藏入口）。 */
export function updateRepoUrl(): string {
  const repo = updateRepo()
  return repo ? `https://github.com/${repo}/releases/latest` : ''
}

/** 当前页面的宿主 profile：dsh-assistant 装在 desktop（DSH Desktop），网页构建装在 web。
 *  认不出来就用 desktop —— 这是本插件的主 profile。 */
export function detectProfile(): 'web' | 'desktop' {
  try {
    const marker = String((globalThis as any).__DSH_PROFILE__ ?? '').trim().toLowerCase()
    if (marker === 'web' || marker === 'desktop') return marker
  } catch { /* 没有全局标记 */ }
  try {
    const path = String(globalThis.location?.pathname ?? '')
    const match = path.match(/\/profiles\/(web|desktop)(?:\/|$)/)
    if (match) return match[1] as 'web' | 'desktop'
  } catch { /* 非浏览器环境 */ }
  return 'desktop'
}

/** 升级指令：插件不自更新，升级由用户或其 Agent 执行 + 重启。
 *  没配更新源时返回一句去哪配的提示（而不是指向别人的仓库）。 */
export function upgradeCommand(profile: string = detectProfile()): string {
  const url = latestTgzUrl()
  if (!url) return '（未配置更新源：设置 → 个人助手 → 本机配置 → 更新检查，填你自己的 owner/repo）'
  return `dsh plugin --profile ${profile} add "${url}"`
}

export function upgradeAiPrompt(profile: string = detectProfile()): string {
  const cmd = upgradeCommand(profile)
  if (!latestTgzUrl()) return cmd
  return `帮我升级 ${PLUGIN_NAME}：执行 ${cmd}，完成后提醒我重启 DSH 并刷新页面`
}

export type UpdateStatus = 'idle' | 'checking' | 'uptodate' | 'failed' | 'disabled'

export type UpdateInfo = { latest: string; notes: string; url: string }

const K_UPDATE_CHECK = 'dsh.worktable.updateCheck.v1'
const K_LAST_CHECK = 'dsh.worktable.lastUpdateCheck.v1'
const K_SKIP = 'dsh.worktable.skipVersion.v1'
const K_CACHE = 'dsh.worktable.updateCache.v1'

export function cmpVer(a: string, b: string): number {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export function getSkipVersion(): string {
  try { return localStorage.getItem(K_SKIP) ?? '' } catch { return '' }
}
export function setSkipVersion(v: string) {
  try { localStorage.setItem(K_SKIP, v) } catch {}
}
export function getAutoCheck(): boolean {
  try { return localStorage.getItem(K_UPDATE_CHECK) !== '0' } catch { return true }
}
export function setAutoCheck(on: boolean) {
  try { localStorage.setItem(K_UPDATE_CHECK, on ? '1' : '0') } catch {}
}
export function readCache(): { status: UpdateStatus; info: UpdateInfo | null } {
  try {
    const raw = localStorage.getItem(K_CACHE)
    if (raw) {
      const c = JSON.parse(raw)
      if (c && typeof c.status === 'string') {
        return { status: c.status === 'checking' ? 'idle' : c.status, info: c.info ?? null }
      }
    }
  } catch {}
  return { status: 'idle', info: null }
}
export function writeCache(status: UpdateStatus, info: UpdateInfo | null) {
  try { localStorage.setItem(K_CACHE, JSON.stringify({ status, info })) } catch {}
}

/**
 * 检查更新：本机没开更新检查 / 没配更新源 → 'disabled'（不联网）；
 * 否则节流一天一次（force 绕过）、8s 超时 × 3 重试。
 */
export async function checkUpdate(force = false): Promise<{ status: UpdateStatus; info: UpdateInfo | null }> {
  if (!updateCheckAllowed()) {
    writeCache('disabled', null)
    return { status: 'disabled', info: null }
  }
  const repo = updateRepo()
  const last = Number(localStorage.getItem(K_LAST_CHECK) ?? '0')
  if (!force && Date.now() - last < 24 * 3600 * 1000) return readCache()
  try { localStorage.setItem(K_LAST_CHECK, String(Date.now())) } catch {}
  let d: { tag_name?: string; body?: string; html_url?: string } | null = null
  for (let attempt = 0; attempt < 3 && !d; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const r = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: ctrl.signal })
      if (r.ok) d = (await r.json()) as { tag_name?: string; body?: string; html_url?: string }
      else if (r.status === 403 || r.status === 404) break
    } catch { /* 网络抖动/超时：下一轮重试 */ }
    finally { clearTimeout(timer) }
  }
  if (!d) { writeCache('failed', null); return { status: 'failed', info: null } }
  const tag = (d.tag_name ?? '').replace(/^v/, '')
  if (!tag || cmpVer(tag, LOCAL_VERSION) <= 0) { writeCache('uptodate', null); return { status: 'uptodate', info: null } }
  if (getSkipVersion() === tag) { writeCache('uptodate', null); return { status: 'uptodate', info: null } }
  const info: UpdateInfo = { latest: tag, notes: (d.body ?? '').slice(0, 800), url: d.html_url ?? '' }
  writeCache('uptodate', info)
  return { status: 'uptodate', info }
}
