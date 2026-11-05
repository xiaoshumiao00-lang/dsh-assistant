/**
 * turn-guard 开关的客户端状态（设置页「个人助手 → 托管」里的那个开关）。
 *
 * 真值在宿主：`GET/POST /.dsh-assistant/turn-guard`（与托管状态同一种跨端同步方式）。
 * localStorage 只做首帧缓存，避免打开设置页先闪一下默认值；一切以宿主为准。
 * 页面可见时 2.5s 轮询一次，手机与电脑的开关几秒内互相跟随。
 *
 * 开关本身是宿主侧判定的：客户端只负责把布尔值送过去（见 src/turn-guard.ts）。
 */
import { useEffect, useSyncExternalStore } from 'react'

const STATE_ROUTE = '/.dsh-assistant/turn-guard'
/** 首帧缓存：'0' = 关；缺省 = 开（并入前的行为就是一直开着）。 */
const LS_KEY = 'dsh-assistant.turn-guard.v1'
const POLL_MS = 2500
/** host 路由不可用时的退避倍数（约 15s 再试一次，宿主重启后自动恢复）。 */
const DEGRADED_POLL_FACTOR = 6

export interface TurnGuardSnapshot {
  /** 开关当前状态（宿主真值；宿主不可达时是最后一次已知值）。 */
  enabled: boolean
  /** false = 宿主路由不可用，改动只在本机（重启 DSH Desktop 后恢复）。 */
  reachable: boolean
}

function loadCache(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(LS_KEY) !== '0'
  } catch { return true }
}

function saveCache(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, on ? '1' : '0')
  } catch { /* 存储不可写时只在内存生效 */ }
}

let enabled = loadCache()
let reachable = true
/** -1 = 还没从宿主取到过真值。 */
let revision = -1
let snap: TurnGuardSnapshot = { enabled, reachable }
const listeners = new Set<() => void>()
const SERVER_SNAPSHOT: TurnGuardSnapshot = { enabled: true, reachable: true }

function touch(): void { snap = { enabled, reachable } }

function emit(): void {
  touch()
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function snapshot(): TurnGuardSnapshot { return snap }

function adoptRemote(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const record = raw as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') return
  const nextRevision = typeof record.revision === 'number' && Number.isFinite(record.revision) ? Math.floor(record.revision) : -1
  if (nextRevision === revision && record.enabled === enabled) return
  revision = nextRevision
  enabled = record.enabled
  saveCache(enabled)
  emit()
}

/** 404/405/401/403：旧宿主没有这条路由 / 登录门禁没过 —— 降级但不回滚用户的改动。 */
const DEGRADE_STATUS = new Set([401, 403, 404, 405])

/** 拉取宿主真值：single-flight + 8 秒超时，避免慢请求堆积。 */
let pullPromise: Promise<void> | null = null
function pullState(): Promise<void> {
  if (pullPromise !== null) return pullPromise
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  const run = (async (): Promise<void> => {
    try {
      const response = await fetch(STATE_ROUTE, {
        method: 'GET',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (DEGRADE_STATUS.has(response.status)) {
        if (reachable) { reachable = false; emit() }
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      adoptRemote(await response.json())
      if (!reachable) { reachable = true; emit() }
    } catch (error) {
      console.warn('[dsh-assistant] GET turn-guard 状态失败：', error instanceof Error ? error.message : error)
    }
  })()
  pullPromise = run
  void run.finally(() => {
    clearTimeout(timeout)
    if (pullPromise === run) pullPromise = null
  })
  return run
}

/**
 * 切换开关：乐观更新 + POST 写宿主。
 * 写失败（网络 / 5xx / 400）时回滚到点击前的值并提示；
 * 宿主路由缺失（404/405）或登录门禁没过（401/403）时保留本地改动并进入降级模式。
 */
export function setTurnGuardEnabled(next: boolean): void {
  if (enabled === next) return
  const previous = enabled
  enabled = next
  saveCache(next)
  emit()

  void (async () => {
    try {
      const response = await fetch(STATE_ROUTE, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (DEGRADE_STATUS.has(response.status)) {
        reachable = false
        emit()
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      adoptRemote(await response.json())
    } catch (error) {
      enabled = previous
      saveCache(previous)
      emit()
      console.warn('[dsh-assistant] POST turn-guard 开关失败：', error instanceof Error ? error.message : error)
    }
  })()
}

/** 立即补拉一次（页面重新可见 / 从设置页返回时用）。 */
export function refreshTurnGuard(): Promise<void> {
  return pullState()
}

/* ---------- 轮询：只在有组件挂载时跑，关掉设置页就停 ---------- */

let pollTimer: ReturnType<typeof setInterval> | null = null
let mounts = 0
let pollTicks = 0
const detachListeners: Array<() => void> = []

function startSync(): void {
  mounts += 1
  if (pollTimer !== null) return
  void pullState()
  if (typeof setInterval === 'function') {
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (!reachable) {
        if (pollTicks % DEGRADED_POLL_FACTOR !== 0) { pollTicks += 1; return }
      }
      pollTicks += 1
      void pullState()
    }, POLL_MS)
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const onVisibility = (): void => { if (document.visibilityState === 'visible') { pollTicks = 0; void pullState() } }
    document.addEventListener('visibilitychange', onVisibility)
    detachListeners.push(() => document.removeEventListener('visibilitychange', onVisibility))
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onFocus = (): void => { pollTicks = 0; void pullState() }
    window.addEventListener('focus', onFocus)
    window.addEventListener('pageshow', onFocus)
    detachListeners.push(() => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pageshow', onFocus)
    })
  }
}

function stopSync(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
  for (const detach of detachListeners.splice(0).reverse()) {
    try { detach() } catch { /* 卸载竞态无需处理 */ }
  }
}

/**
 * 设置页用：订阅开关状态。
 * 挂载即开始同步，卸载后（没有别的消费者时）停止轮询。
 */
export function useTurnGuardState(): TurnGuardSnapshot {
  const state = useSyncExternalStore(subscribe, snapshot, () => SERVER_SNAPSHOT)
  useEffect(() => {
    startSync()
    return () => {
      mounts -= 1
      if (mounts <= 0) { mounts = 0; stopSync() }
    }
  }, [])
  return state
}
