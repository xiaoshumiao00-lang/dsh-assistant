/**
 * DSH WebServer 路由生命周期管理。
 *
 * webServer.register() 的返回值不是可选回调，而是注销函数。DSH 配置 HMR 会
 *  dispose 旧插件并立即 apply 新实例；漏掉任何一个注销函数，新实例就会因
 *  duplicate route 在 apply 中途失败。手机访问位于个人助手 apply 的后半段，
 *  因此表面症状是「主界面还在，但代理 / SSH / 手机设置全部消失」。
 *
 * 本包装做两件事：
 *  1. 收集本实例注册的全部路由，卸载时统一逆序注销；
 *  2. 兼容 ≤0.2.4 已经泄漏在 WebServer 里的旧路由：仅在 DSH 报 duplicate
 *     且能看到对应内部路由表时，替换同一个 kind + path；其它错误原样抛出。
 *     这些路径均为个人助手专用路径，不会用来抢占公共路由。
 */
export interface ManagedWebRoutes {
  webServer: any
  dispose: () => void
}

export function manageWebRoutes(server: any): ManagedWebRoutes {
  const disposers: Array<() => void> = []

  const register = (route: any): (() => void) => {
    let dispose: unknown
    try {
      dispose = server.register(route)
    } catch (err: any) {
      const duplicate = /duplicate\s+(?:exact|prefix)\s+route/i.test(String(err?.message ?? err))
      // DSH 的 private 是 TypeScript 修饰符，运行时仍是 exact / prefixes 两个 Map。
      // 仅用于接管本插件旧版本遗留的同一路由；若宿主实现不同则保持原失败，不猜。
      const table = route?.kind === 'exact' ? server?.exact : server?.prefixes
      if (!duplicate || !table || typeof table.has !== 'function' || typeof table.delete !== 'function' || !table.has(route?.path)) {
        throw err
      }
      table.delete(route.path)
      dispose = server.register(route)
    }
    if (typeof dispose === 'function') disposers.push(dispose)
    return typeof dispose === 'function' ? dispose : () => void 0
  }

  const webServer = new Proxy(server, {
    get(target, property) {
      if (property === 'register') return register
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return {
    webServer,
    dispose: () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch { /* 已注销，幂等清理 */ }
      }
    },
  }
}
