// dsh-assistant 手机服务的跨 HMR 运行实例。
//
// Cordis dispose/apply 是插件代码与配置生命周期，不等于用户想关闭手机访问。
// 同一份 pocket 代码被重载时复用现有 proxy / SSH；只有代码哈希变化才替换。
// 插件被真正禁用后延迟回收，DSH 进程退出时仍同步清理子进程。

const GLOBAL_KEY = Symbol.for('dsh-assistant.pocket.runtime.v1')

function disposeService(service) {
  try { void Promise.resolve(service?.dispose?.()).catch(() => {}) } catch { /* 已停止 */ }
}

export function acquirePocketRuntime(revision, factory, { graceMs = 15_000 } = {}) {
  const previous = globalThis[GLOBAL_KEY]
  if (previous && previous.revision === revision) {
    if (previous.disposeTimer) clearTimeout(previous.disposeTimer)
    previous.disposeTimer = null
    previous.users++
    return previous
  }

  if (previous) {
    if (previous.disposeTimer) clearTimeout(previous.disposeTimer)
    process.removeListener('exit', previous.onExit)
    disposeService(previous.service)
  }

  const runtime = {
    revision,
    service: factory(),
    users: 1,
    graceMs,
    disposeTimer: null,
    onExit: null,
  }
  runtime.onExit = () => disposeService(runtime.service)
  process.once('exit', runtime.onExit)
  globalThis[GLOBAL_KEY] = runtime
  return runtime
}

export function releasePocketRuntime(runtime) {
  const current = globalThis[GLOBAL_KEY]
  if (!current || current !== runtime) return
  current.users = Math.max(0, current.users - 1)
  if (current.users > 0) return
  if (current.disposeTimer) clearTimeout(current.disposeTimer)
  current.disposeTimer = setTimeout(() => {
    if (globalThis[GLOBAL_KEY] !== current || current.users > 0) return
    process.removeListener('exit', current.onExit)
    delete globalThis[GLOBAL_KEY]
    disposeService(current.service)
  }, current.graceMs)
  current.disposeTimer.unref?.()
}
