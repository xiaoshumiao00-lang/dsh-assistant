/** 热重载路由生命周期回归：旧路由接管、正常注销、连续 HMR 不重复。 */
import assert from 'node:assert/strict'
import { manageWebRoutes } from '../src/web-routes.ts'

function fakeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  return {
    exact,
    prefixes,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => { table.delete(route.path) }
    },
  }
}

const server = fakeWebServer()
const oldHandler = () => 'old'
// 模拟 ≤0.2.4：旧实例 register 后把注销函数丢了，路由仍留在宿主。
server.exact.set('/api/assistant/legacy', { kind: 'exact', path: '/api/assistant/legacy', handler: oldHandler })

const first = manageWebRoutes(server)
const newHandler = () => 'new'
first.webServer.register({ kind: 'exact', path: '/api/assistant/legacy', handler: newHandler })
assert.equal(server.exact.get('/api/assistant/legacy').handler, newHandler, '应接管旧版本泄漏的同名路由')
first.webServer.register({ kind: 'prefix', path: '/dsh-pocket', handler: () => 'pocket' })
assert.equal(server.prefixes.has('/dsh-pocket'), true)
first.dispose()
assert.equal(server.exact.has('/api/assistant/legacy'), false, '卸载必须注销 exact 路由')
assert.equal(server.prefixes.has('/dsh-pocket'), false, '卸载必须注销 prefix 路由')
first.dispose() // 幂等

// 连续三次模拟配置 HMR：每轮 apply → dispose → apply 都不能出现 duplicate。
for (let generation = 1; generation <= 3; generation++) {
  const current = manageWebRoutes(server)
  current.webServer.register({ kind: 'exact', path: '/api/worktable/health', handler: () => generation })
  current.webServer.register({ kind: 'prefix', path: '/api/assistant/state', handler: () => generation })
  assert.equal(server.exact.get('/api/worktable/health').handler(), generation)
  current.dispose()
  assert.equal(server.exact.size, 0)
  assert.equal(server.prefixes.size, 0)
}

console.log('web-routes: legacy takeover + lifecycle + 3 HMR generations OK')
