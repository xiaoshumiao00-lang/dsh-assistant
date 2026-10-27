/**
 * 单测：Computer Use 坐标模式设置（src/coordinate-mode.ts）。
 *   node scripts/test-coordinate-mode.mjs
 *
 * 固定这几条边界：
 *   - 没有配置文件时按平台缺省（Windows 千分比、其它像素），与 dsh-orb 一致；
 *   - 已有 millifraction-coordinates.json 时直接继承老设置；
 *   - POST 写盘后服务 currentMode() 立刻变，GET 读回同一值；
 *   - 非布尔 body 拒绝；卸载函数摘掉服务。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { registerCoordinateMode, COORDINATE_MODE_ROUTE } from '../src/coordinate-mode.ts'

function makeCtx(dir) {
  const routes = new Map()
  const services = new Map()
  const errors = []
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir }
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    webServer: {
      register(route) { routes.set(route.path, route) },
    },
    logger: () => ({ error: (...args) => errors.push(args.join(' ')) }),
  }
  return { ctx, routes, services, errors }
}

async function call(handler, method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = COORDINATE_MODE_ROUTE
  let status = 0
  let raw = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { raw += chunk ?? '' },
  }
  await handler(req, res)
  return { status, body: raw ? JSON.parse(raw) : null }
}

const platformDefault = process.platform === 'win32'
const cases = []

cases.push(['无配置文件 → 平台缺省 + GET 读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    assert.ok(services.has('assistantCoordinateMode'), '应提供 assistantCoordinateMode 服务')
    const service = services.get('assistantCoordinateMode')
    assert.equal(service.currentMode(), platformDefault ? 'millifraction' : 'pixel')

    const route = routes.get(COORDINATE_MODE_ROUTE)
    assert.ok(route, '应注册坐标模式路由')
    const got = await call(route.handler, 'GET')
    assert.equal(got.status, 200)
    assert.equal(got.body.ok, true)
    assert.equal(got.body.enabled, platformDefault)
    assert.equal(got.body.mode, platformDefault ? 'millifraction' : 'pixel')
    dispose()
    assert.equal(services.has('assistantCoordinateMode'), false, '卸载后服务应移除')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['POST false → 写盘、服务变 pixel、GET 读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    const route = routes.get(COORDINATE_MODE_ROUTE)
    const service = services.get('assistantCoordinateMode')

    const posted = await call(route.handler, 'POST', { enabled: false })
    assert.equal(posted.status, 200)
    assert.equal(posted.body.enabled, false)
    assert.equal(posted.body.mode, 'pixel')
    assert.equal(service.currentMode(), 'pixel')

    const file = join(dir, 'millifraction-coordinates.json')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabled: false })

    const got = await call(route.handler, 'GET')
    assert.equal(got.body.enabled, false)
    assert.equal(got.body.mode, 'pixel')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['已有配置文件 → 继承（不覆盖用户老选择）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    writeFileSync(join(dir, 'millifraction-coordinates.json'), JSON.stringify({ enabled: false }), 'utf8')
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    assert.equal(services.get('assistantCoordinateMode').currentMode(), 'pixel')
    const got = await call(routes.get(COORDINATE_MODE_ROUTE).handler, 'GET')
    assert.equal(got.body.enabled, false)
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['非法 body → 400，且不改设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    const route = routes.get(COORDINATE_MODE_ROUTE)
    const before = services.get('assistantCoordinateMode').currentMode()

    const bad = await call(route.handler, 'POST', { enabled: 'no' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)
    assert.equal(services.get('assistantCoordinateMode').currentMode(), before)
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['服务 setter 与路由共用同一状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  try {
    const { ctx, routes, services } = makeCtx(dir)
    const dispose = registerCoordinateMode(ctx)
    const service = services.get('assistantCoordinateMode')
    await service.setMillifractionEnabled(false)
    assert.equal(service.currentMode(), 'pixel')
    const got = await call(routes.get(COORDINATE_MODE_ROUTE).handler, 'GET')
    assert.equal(got.body.enabled, false)
    await service.setMillifractionEnabled(true)
    assert.equal(service.currentMode(), 'millifraction')
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}])

cases.push(['内嵌 computer-use 优先读个人助手服务（防止同步 vendor 时丢改动）', async () => {
  const vendor = readFileSync(new URL('../vendor/computer-use/index.js', import.meta.url), 'utf8')
  assert.match(
    vendor,
    /ctx\.get\("assistantCoordinateMode"\) \?\? ctx\.get\("orbCoordinateMode"\)/,
    'stampCoordinateMode 应优先读 assistantCoordinateMode，再回退 dsh-orb 的 orbCoordinateMode',
  )
}])

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`ok - ${name}`)
  } catch (err) {
    failed += 1
    console.error(`fail - ${name}`)
    console.error(err)
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${cases.length} 失败`)
  process.exit(1)
}
console.log(`\n${cases.length}/${cases.length} 通过`)
