#!/usr/bin/env node
/**
 * 本机 SenseVoice 保活器（src/tihu/asr-keeper.ts）与它在鹈鹕 lane 里的接线单测。
 *
 * 钉住的事实（2026-11-15 用户定调：不靠计划任务，插件层每次启动自己把服务起起来）：
 *   1. 启动即保证：lane 一造出来就先探 `/health`；探测到活着 → 一次都不许拉
 *      （同一端口只能有一份 SenseVoice，重复拉会再多一份 1GB 量级的常驻模型）；
 *   2. 拉起必须**无窗口**：直接 spawn `venv-sherpa` 的 `pythonw.exe` 跑 `sensevoice_server.py`
 *      （GUI 子系统解释器不申请控制台 + `windowsHide` + stdin 断开、stdout/stderr 都追加进
 *      同一个 `sensevoice.log`、`> 20MB` 滚动到 `.1`）——
 *      2026-11-15 的回归点是「桌面上多了一扇黑色 CMD 窗」，所以这里连 `cmd.exe` 都不许出现；
 *   3. 连续拉不起来要退避 + 上限 + 冷却，且「还活着」时不许瞎拉；
 *   4. `stop()` 之后不许再探测、再拉起；
 *   5. ASR 腿失败只补探，绝不打断、也不搅乱正在跑的那条转写；
 *   6. 服务地址从 `sensevoice.config.json` 读（端口不许写死在插件代码里），
 *      源码里不许出现计划任务，也不许出现个人路径。
 *
 * 这套单测一律用注入的假探测/假拉起 + 临时目录，绝不碰本机真 SenseVoice（3098）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  TIHU_ASR_KEEPER_BACKOFF_MS,
  TIHU_ASR_KEEPER_COOLDOWN_MS,
  TIHU_ASR_KEEPER_HEARTBEAT_MS,
  TIHU_ASR_KEEPER_KICK_DEBOUNCE_MS,
  TIHU_ASR_KEEPER_MAX_FAILURES,
  TIHU_ASR_LOG_FILE,
  TIHU_ASR_LOG_MAX_BYTES,
  TIHU_ASR_SERVER_SCRIPT,
  TIHU_ASR_START_SCRIPT,
  buildTihuAsrLaunch,
  createTihuAsrKeeper,
  openTihuAsrLog,
  readTihuAsrServiceConfig,
  resolveTihuAsrPython,
  resolveTihuAsrRoot,
  tihuAsrRootCandidates,
} from '../src/tihu/asr-keeper.ts'
import { createTihuHttpHandler } from '../src/tihu/lane.ts'

const scratch = mkdtempSync(join(tmpdir(), 'tihu-asr-keeper-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lastBackoff = TIHU_ASR_KEEPER_BACKOFF_MS[TIHU_ASR_KEEPER_BACKOFF_MS.length - 1]
/** 「找不到服务目录」那条留痕的收集器（第 7 组用例用）。 */
const noRootNotes = []

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

/** 造一份「服务目录」：config + 服务脚本 + 那条 .cmd（只当存在性证据，测试绝不执行它）。 */
function makeAsrRoot(dir, config) {
  const asrDir = join(dir, 'asr-sensevoice')
  mkdirSync(asrDir, { recursive: true })
  writeFileSync(join(asrDir, 'sensevoice.config.json'), JSON.stringify(config), 'utf8')
  writeFileSync(join(asrDir, TIHU_ASR_SERVER_SCRIPT), '# 测试桩：只被当作「要跑的脚本」摆着，绝不执行\n', 'utf8')
  writeFileSync(join(asrDir, 'start-sensevoice.cmd'), '@echo off\r\nREM 测试桩：这条 .cmd 只被找到、不被执行\r\n', 'utf8')
  return asrDir
}

/**
 * 假服务 harness：探测返回 `state.alive`，拉起默认让服务「活过来」（`launchUp: false` 模拟拉不起来）。
 * 时钟与等待全部注入，所以退避/冷却在测试里可控，不会真等 15s/60s/300s。
 */
function makeHarness(options = {}) {
  const tag = options.tag ?? 'case'
  const dir = mkdtempSync(join(scratch, `${tag}-`))
  const root = options.root ?? makeAsrRoot(dir, { host: '127.0.0.1', port: options.port ?? 3198 })
  const notes = []
  const launches = []
  const clock = { t: 1_000_000 }
  const state = { alive: options.alive === true, probes: 0 }
  const keeper = createTihuAsrKeeper({
    root,
    ...(options.probeHealth === undefined
      ? { probeHealth: async () => { state.probes += 1; return state.alive } }
      : { probeHealth: options.probeHealth }),
    launch: (launchRoot, spec) => {
      launches.push({ root: launchRoot, spec })
      if (options.launchUp !== false) state.alive = true
    },
    waitMs: async () => { await sleep(0) },
    now: () => clock.t,
    upPollAttempts: options.upPollAttempts ?? 2,
    upPollIntervalMs: 0,
    kickDebounceMs: options.kickDebounceMs ?? 10,
    intervalMs: options.intervalMs ?? 60_000,
    note: (text) => { notes.push(text) },
    log: (line) => { notes.push(line) },
  })
  return { keeper, notes, launches, clock, state, root, dir }
}

// ── 1. 服务目录与地址：一律从仓库那份 config 读 ────────────────────────────
await test('服务目录按插件自身位置往上找（源码与打包产物两种路径都命中）', () => {
  const dir = mkdtempSync(join(scratch, 'root-'))
  const root = makeAsrRoot(dir, { host: '127.0.0.1', port: 3199 })
  // 打包产物在 lib/ → 往上两级命中仓库根
  assert.equal(resolveTihuAsrRoot({ startDir: join(dir, 'lib'), env: {} }), root)
  // 源码在 src/tihu/ → 往上两级也命中（源码那份 asr-keeper.ts 自己就在 src/tihu）
  const nested = mkdtempSync(join(scratch, 'nested-'))
  const nestedRoot = makeAsrRoot(nested, { host: '127.0.0.1', port: 3199 })
  mkdirSync(join(nestedRoot, 'src', 'tihu'), { recursive: true })
  assert.equal(resolveTihuAsrRoot({ startDir: join(nestedRoot, 'src', 'tihu'), env: {} }), nestedRoot)
  assert.deepEqual(
    tihuAsrRootCandidates(join(dir, 'lib'), undefined).slice(0, 2),
    [join(dir, 'lib', 'asr-sensevoice'), join(dir, 'asr-sensevoice')],
  )
  const empty = mkdtempSync(join(scratch, 'empty-'))
  assert.equal(resolveTihuAsrRoot({ startDir: empty, cwd: empty, env: {} }), undefined, '没有 config/也没有 .cmd 就该报没找到')
  const pointed = makeAsrRoot(join(empty, 'elsewhere'), { host: '127.0.0.1', port: 3199 })
  assert.equal(resolveTihuAsrRoot({ startDir: empty, cwd: empty, env: { TIHU_ASR_ROOT: pointed } }), pointed, 'TIHU_ASR_ROOT 指过去要能命中')
  assert.equal(resolveTihuAsrRoot({ startDir: empty, cwd: empty, env: { TIHU_ASR_ROOT: join(empty, 'nope') } }), undefined, 'TIHU_ASR_ROOT 指错不许当真的用')
  const noCmd = mkdtempSync(join(scratch, 'nocmd-'))
  mkdirSync(join(noCmd, 'asr-sensevoice'), { recursive: true })
  writeFileSync(join(noCmd, 'asr-sensevoice', 'sensevoice.config.json'), '{"host":"127.0.0.1","port":3198}', 'utf8')
  assert.equal(resolveTihuAsrRoot({ startDir: noCmd, cwd: noCmd, env: {} }), undefined, '只有 config 没有 .cmd 也不算服务目录')
})

await test('健康地址从 sensevoice.config.json 读（端口不许写死在插件代码里）', () => {
  const dir = mkdtempSync(join(scratch, 'cfg-'))
  const root = makeAsrRoot(dir, { host: '127.0.0.1', port: 3199 })
  const config = readTihuAsrServiceConfig(root)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 3199)
  assert.equal(config.healthUrl, 'http://127.0.0.1:3199/health')
  writeFileSync(join(root, 'sensevoice.config.json'), '{ "port": ', 'utf8')
  assert.equal(readTihuAsrServiceConfig(root), undefined, '半截 JSON 不许抛错，按读不到处理')
  writeFileSync(join(root, 'sensevoice.config.json'), '{"host":"127.0.0.1"}', 'utf8')
  assert.equal(readTihuAsrServiceConfig(root), undefined, '缺 port 就别说自己知道地址')
  writeFileSync(join(root, 'sensevoice.config.json'), '{"host":"127.0.0.1","port":0}', 'utf8')
  assert.equal(readTihuAsrServiceConfig(root), undefined, 'port 0 不算一个地址')
})

await test('本机真实安装：默认构造就指向仓库那份 asr-sensevoice，且构造本身不探测不拉起', () => {
  const root = resolveTihuAsrRoot()
  assert.ok(root !== undefined && root.endsWith('asr-sensevoice'), '本机这份安装要能自己找到服务目录')
  assert.equal(readTihuAsrServiceConfig(root).port, 3098, '端口必须照 config 里的 3098，不是插件代码里写死')
  const keeper = createTihuAsrKeeper({ note: () => {} })
  assert.equal(keeper.stats().healthUrl, 'http://127.0.0.1:3098/health')
  assert.equal(keeper.stats().launches, 0)
  assert.equal(keeper.stats().heartbeat, false, '构造不许自己起定时器')
  keeper.stop()
  const off = createTihuAsrKeeper({ disabled: true, note: () => {} })
  assert.equal(off.stats().disabled, true)
  assert.equal(off.stats().heartbeat, false)
  off.startHeartbeat()
  assert.equal(off.stats().heartbeat, false, '关掉之后连心跳都不许起')
  off.stop()
})

// ── 2. 拉起形状：无窗口（pythonw 跑 sensevoice_server.py），绝不起 cmd.exe ──────────
await test('拉起是无窗口的：pythonw 直接跑 sensevoice_server.py，只用注入的假 python', () => {
  const root = join(scratch, 'launch-case', 'asr-sensevoice')
  mkdirSync(root, { recursive: true })
  const fakePython = join(scratch, 'fake-pythonw.exe')
  writeFileSync(fakePython, 'stub', 'utf8')
  const spec = buildTihuAsrLaunch(root, { TIHU_ASR_PYTHON: fakePython })
  assert.ok(spec !== undefined, '有 python 就必须给出拉起规格')
  assert.equal(spec.command, fakePython)
  assert.deepEqual(spec.args, [join(root, TIHU_ASR_SERVER_SCRIPT)], '只跑服务脚本本体（不再绕 .cmd）')
  assert.equal(spec.options.cwd, root, 'cwd 必须是服务目录')
  assert.equal(spec.options.detached, true, 'detached 才不会被父进程退出带走')
  assert.equal(spec.options.windowsHide, true, '关键：不许建控制台窗口')
  assert.deepEqual(spec.options.stdio, ['ignore', 'log', 'log'], 'stdin 断开；stdout/stderr 都进日志文件（不是管道、不是控制台）')
  assert.equal(spec.options.logPath, join(root, TIHU_ASR_LOG_FILE), 'stdout 与 stderr 必须追加进同一个 sensevoice.log')
  assert.equal(spec.options.windowsVerbatimArguments, false, '直接甩 exe，引号交给 Node')
  const serialized = JSON.stringify(spec)
  assert.ok(!/cmd\.exe/i.test(serialized), '拉起不许再经过 cmd.exe（GUI 宿主起 cmd 就会多一扇黑窗）')
  assert.ok(!serialized.includes(TIHU_ASR_START_SCRIPT), '插件层不再执行那条给人工用的 .cmd')
  assert.ok(!/schtasks|Task Scheduler|Uninstall|cron|计划任务/.test(serialized), '这里不许出现计划任务')
  // 找不到 python：宁可返回 undefined 不拉，绝不回退到会开黑窗的老路子
  assert.equal(buildTihuAsrLaunch(root, { TIHU_ASR_PYTHON: '', DSH_HOME: join(scratch, 'no-such-home') }), undefined)
})

await test('本机这份安装：默认解析到 pythonw.exe，且 specs 指向仓库那份 sensevoice_server.py', () => {
  const python = resolveTihuAsrPython({})
  if (python === undefined) {
    console.log('  ..  本机没有 venv-sherpa，跳过 python 解析断言')
    return
  }
  if (process.platform === 'win32') {
    assert.equal(basename(python).toLowerCase(), 'pythonw.exe', 'Windows 上必须用 GUI 子系统的 pythonw（`python.exe` 实测仍会被分一台控制台）')
  }
  const root = resolveTihuAsrRoot()
  const spec = buildTihuAsrLaunch(root, {})
  assert.ok(spec !== undefined)
  assert.equal(spec.args[0], join(root, TIHU_ASR_SERVER_SCRIPT))
  assert.equal(spec.options.windowsHide, true)
})

// ── 2b. 日志：追加、20MB 滚动、`.1` 覆盖写 ─────────────────────────────────
await test('日志追加进同一个 sensevoice.log，超过 20MB 先滚成 .1 再接着追加', () => {
  assert.equal(TIHU_ASR_LOG_MAX_BYTES, 20 * 1024 * 1024, '滚动门槛还是 20MB')
  assert.equal(TIHU_ASR_LOG_FILE, 'sensevoice.log', '日志文件名不变（宿主/人都在看这份）')
  const dir = mkdtempSync(join(scratch, 'log-'))
  const root = join(dir, 'asr-sensevoice')
  mkdirSync(root, { recursive: true })
  const logPath = join(root, TIHU_ASR_LOG_FILE)

  const first = openTihuAsrLog(root)
  assert.equal(first.path, logPath, '日志固定落在服务目录里的 sensevoice.log')
  assert.equal(first.rotated, false, '第一次起没有旧文件，不滚')
  writeSync(first.fd, 'listening pid=1\n')
  // stdout 与 stderr 共用同一个 fd：关闭后再开一次必须是**追加**，不是截断
  const second = openTihuAsrLog(root)
  writeSync(second.fd, 'warmup ok\n')
  assert.ok(readFileSync(logPath, 'utf8').includes('listening pid=1'), '重新打开不许把上一份日志截断')
  assert.ok(readFileSync(logPath, 'utf8').includes('warmup ok'))

  // 门槛之后：先有旧 .1 也要被覆盖，旧日志挪成 .1，新日志从零开始
  const big = 'x'.repeat(64)
  writeFileSync(logPath, big, 'utf8')
  writeFileSync(`${logPath}.1`, '旧的那份 .1', 'utf8')
  const rolled = openTihuAsrLog(root, 32)
  assert.equal(rolled.rotated, true, '超过门槛要滚动')
  assert.equal(readFileSync(`${logPath}.1`, 'utf8'), big, '旧日志挪成 .1（且 .1 被覆盖，不留更早的内容）')
  assert.equal(statSync(logPath).size, 0, '滚动之后新日志从空开始，接着追加')
  writeSync(rolled.fd, 'after roll\n')
  assert.equal(readFileSync(logPath, 'utf8'), 'after roll\n')
  for (const handle of [first, second, rolled]) {
    try { writeSync(handle.fd, '') } catch { /* 已关 */ }
  }
})


// ── 3. 探测语义：真 HTTP 服务，走默认探测 ─────────────────────────────────
await test('默认探测真去 GET /health：活着就不拉第二份，日志也不刷屏', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, engine: 'sensevoice', resident: true, pid: 4242 }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dir = mkdtempSync(join(scratch, 'live-'))
  const root = makeAsrRoot(dir, { host: '127.0.0.1', port })
  const notes = []
  const launched = []
  const keeper = createTihuAsrKeeper({
    root,
    launch: (r, spec) => { launched.push({ r, spec }) },
    note: (text) => { notes.push(text) },
    waitMs: async () => { await sleep(0) },
  })
  assert.equal(await keeper.ensure('lane 启动'), true, '探测到活着要返回活着')
  assert.equal(keeper.stats().launches, 0, '活着的时候一次都不许拉')
  assert.equal(keeper.stats().healthUrl, `http://127.0.0.1:${port}/health`, '地址必须来自那份 config')
  assert.equal(keeper.stats().lastResult, 'healthy')
  assert.ok(notes.some((line) => line.includes('不再拉第二份')))
  assert.equal(await keeper.ensure('心跳'), true)
  assert.equal(await keeper.ensure('心跳'), true)
  assert.equal(notes.filter((line) => line.includes('health ok')).length, 1, '活着只落一行，别每 60s 刷一遍日志')
  assert.equal(launched.length, 0)
  server.close()
})

await test('服务真死了（端口没人听）→ 无窗口拉起一次就够', async () => {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  const harness = makeHarness({ tag: 'down', port, alive: false })
  const { keeper, notes, launches } = harness
  assert.equal(await keeper.ensure('lane 启动'), true)
  assert.equal(keeper.stats().launches, 1)
  assert.equal(keeper.stats().consecutiveFailures, 0, '起来了就要把失败计数清零')
  assert.equal(keeper.stats().lastResult, 'up')
  assert.equal(launches.length, 1)
  assert.equal(launches[0].root, harness.root)
  assert.equal(launches[0].spec.options.detached, true)
  assert.ok(notes.some((line) => line.includes('health down') && line.includes('无窗口拉起') && line.includes(TIHU_ASR_SERVER_SCRIPT)))
  assert.ok(notes.some((line) => line.includes('SenseVoice 起来了')))
  assert.equal(keeper.stats().nextAllowedAtMs, 0, '起来了不留退避')
  keeper.stop()
})

await test('服务还在但坏了（502）按没活着处理，也只补一次拉起', async () => {
  const server = createServer((req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dir = mkdtempSync(join(scratch, 'degraded-'))
  const root = makeAsrRoot(dir, { host: '127.0.0.1', port })
  const launched = []
  const keeper = createTihuAsrKeeper({
    root,
    launch: (r) => { launched.push(r) },
    note: () => {},
    waitMs: async () => { await sleep(0) },
    upPollAttempts: 2,
    upPollIntervalMs: 0,
  })
  assert.equal(await keeper.ensure('心跳'), false)
  assert.equal(keeper.stats().launches, 1)
  assert.equal(keeper.stats().consecutiveFailures, 1)
  assert.equal(keeper.stats().lastResult, 'down')
  assert.equal(launched.length, 1)
  server.close()
})

// ── 4. 退避 / 上限 / 冷却 ─────────────────────────────────────────────────
await test('连续拉不起来：退避阶梯、上限到点停手、冷却后恢复一次', async () => {
  const harness = makeHarness({ tag: 'backoff', alive: false, launchUp: false })
  const { keeper, notes, launches, clock } = harness
  assert.equal(await keeper.ensure('lane 启动'), false)
  assert.equal(keeper.stats().consecutiveFailures, 1)
  assert.equal(keeper.stats().nextAllowedAtMs, clock.t + TIHU_ASR_KEEPER_BACKOFF_MS[0], '第一次失败退 15s')
  assert.equal(await keeper.ensure('心跳'), false, '退避窗口内不许再拉')
  assert.equal(launches.length, 1, '退避期内一次都不拉')
  assert.equal(keeper.stats().lastResult, 'backoff')
  assert.ok(notes.some((line) => line.includes('退避中')))

  clock.t += TIHU_ASR_KEEPER_BACKOFF_MS[0]
  assert.equal(await keeper.ensure('心跳'), false)
  assert.equal(keeper.stats().consecutiveFailures, 2)
  assert.equal(keeper.stats().nextAllowedAtMs, clock.t + TIHU_ASR_KEEPER_BACKOFF_MS[1], '第二次失败退 60s')
  assert.equal(launches.length, 2)

  clock.t += TIHU_ASR_KEEPER_BACKOFF_MS[1]
  assert.equal(await keeper.ensure('心跳'), false)
  assert.equal(keeper.stats().consecutiveFailures, TIHU_ASR_KEEPER_MAX_FAILURES)
  assert.equal(launches.length, 3, '上限之内按阶梯拉了 3 轮')
  assert.ok(notes.some((line) => line.includes('停手')), '达到上限要落一行停手日志')
  assert.equal(keeper.stats().cooldownUntilMs, clock.t + TIHU_ASR_KEEPER_COOLDOWN_MS)
  assert.equal(keeper.stats().lastResult, 'down')

  clock.t += 1_000
  assert.equal(await keeper.ensure('心跳'), false)
  assert.equal(keeper.stats().lastResult, 'capped')
  assert.equal(launches.length, 3, '冷却没到点就绝对不再拉')
  assert.equal(notes.filter((line) => line.includes('停手')).length, 1, '停手日志只落一次，不刷屏')

  clock.t += TIHU_ASR_KEEPER_COOLDOWN_MS
  assert.equal(await keeper.ensure('心跳'), false)
  assert.equal(launches.length, 4, '冷却到点恢复尝试一轮')
  assert.equal(keeper.stats().consecutiveFailures, 1)
  assert.ok(notes.some((line) => line.includes('冷却到点')))
  keeper.stop()
})

await test('上限停手后一旦探测到活着，计数器清零且不许多拉', async () => {
  const harness = makeHarness({ tag: 'cap-recover', alive: false, launchUp: false })
  const { keeper, clock } = harness
  for (let i = 0; i < TIHU_ASR_KEEPER_MAX_FAILURES; i += 1) {
    clock.t += TIHU_ASR_KEEPER_BACKOFF_MS[i] ?? lastBackoff
    assert.equal(await keeper.ensure('心跳'), false)
  }
  assert.equal(keeper.stats().consecutiveFailures, TIHU_ASR_KEEPER_MAX_FAILURES)
  const before = keeper.stats()
  clock.t += TIHU_ASR_KEEPER_COOLDOWN_MS
  harness.state.alive = true
  assert.equal(await keeper.ensure('心跳'), true, '冷却到点后探测到活着要立刻恢复')
  assert.equal(keeper.stats().consecutiveFailures, 0)
  assert.equal(keeper.stats().nextAllowedAtMs, 0)
  assert.equal(keeper.stats().cooldownUntilMs, 0)
  assert.equal(keeper.stats().launches, before.launches, '恢复时一次都不许多拉')
  assert.equal(await keeper.ensure('心跳'), true)
  assert.equal(keeper.stats().launches, before.launches)
  keeper.stop()
})

// ── 5. 单飞 + 心跳 + 卸载 ────────────────────────────────────────────────
await test('并发 ensure 只算一次（心跳与启动撞在一起也不抢第二次）', async () => {
  const dir = mkdtempSync(join(scratch, 'single-'))
  const root = makeAsrRoot(dir, { host: '127.0.0.1', port: 3196 })
  let probes = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const launched = []
  const keeper = createTihuAsrKeeper({
    root,
    probeHealth: async () => { probes += 1; await gate; return false },
    launch: (r) => { launched.push(r) },
    note: () => {},
    waitMs: async () => { await sleep(0) },
    upPollAttempts: 1,
    upPollIntervalMs: 0,
  })
  const a = keeper.ensure('lane 启动')
  const b = keeper.ensure('心跳')
  release()
  assert.deepEqual(await Promise.all([a, b]), [false, false])
  assert.equal(probes, 2, '并发 ensure 只跑一趟：一次初始探测 + 一次就绪补探（不是一条心跳一趟）')
  assert.equal(keeper.stats().launches, 1)
  assert.equal(launched.length, 1)
})

await test('心跳真的会补探；stop() 之后不再探测、不再拉起', async () => {
  const harness = makeHarness({ tag: 'heartbeat', alive: true, intervalMs: 10 })
  const { keeper, launches } = harness
  assert.equal(TIHU_ASR_KEEPER_HEARTBEAT_MS, 60_000, '默认心跳 60s')
  assert.equal(TIHU_ASR_KEEPER_KICK_DEBOUNCE_MS, 3_000, '补探合并窗口 3s')
  assert.equal(keeper.stats().heartbeat, false)
  keeper.startHeartbeat()
  assert.equal(keeper.stats().heartbeat, true)
  keeper.startHeartbeat()
  await sleep(35)
  const seen = harness.state.probes
  assert.ok(seen >= 2, `心跳要在 35ms 内至少补探两次（实际 ${seen}）`)
  keeper.stop()
  assert.equal(keeper.stats().heartbeat, false)
  await sleep(40)
  assert.equal(harness.state.probes, seen, 'stop 之后不许再探')
  assert.equal(await keeper.ensure('心跳'), false, 'stopped 之后一切直接不做事')
  assert.equal(launches.length, 0, '活着的时候一次都不许拉')
})

// ── 6. ASR 腿失败补探：只补探，不搅乱请求 ────────────────────────────────
await test('ASR 腿失败 → 合并窗口内只补探一次（一次派单好几条腿不许按腿数重复拉）', async () => {
  const harness = makeHarness({ tag: 'kick', alive: false, launchUp: false, kickDebounceMs: 10 })
  const { keeper, launches } = harness
  keeper.kickAfterAsrFailure('sensevoice 腿')
  keeper.kickAfterAsrFailure('seg=whole 腿')
  keeper.kickAfterAsrFailure('host-sensevoice 腿')
  await sleep(15)
  assert.equal(await keeper.ensure('测试屏障'), false, '等那趟补探跑完（拉不起来）')
  assert.equal(keeper.stats().launches, 1, '三条腿只补探一次')
  assert.equal(launches.length, 1)
  assert.ok(harness.notes.some((line) => line.includes('asr 腿失败')), '补探要留下原因标签')
  assert.equal(keeper.stats().consecutiveFailures, 1)
  assert.equal(keeper.stats().nextAllowedAtMs, harness.clock.t + TIHU_ASR_KEEPER_BACKOFF_MS[0], '补探失败也照退避')
  keeper.stop()
  keeper.kickAfterAsrFailure('卸载之后的腿')
  await sleep(25)
  assert.equal(keeper.stats().launches, 1, 'stop 之后补探不许再拉起任何东西')
})

await test('/tihu/asr 失败会叫起补探钩子，但应答照常常出（不被打断）', async () => {
  process.env.TIHU_LANE_LOG = join(scratch, 'lane-test.log')
  const kicks = []
  const handler = createTihuHttpHandler({
    transcribe: async () => { await sleep(20); return { text: '今天天气不错', source: 'local', elapsedMs: 20 } },
    onAsrFailure: (reason) => { kicks.push(reason) },
  })
  const replies = []
  const handled = handler(
    { method: 'POST', url: '/tihu/asr', body: Buffer.from('fake-wav') },
    { writeHead: (code) => { replies.push({ code }) }, end: (text) => { replies.push({ text }) } },
  )
  assert.equal(handled, true, '/tihu/asr 要接住')
  await sleep(90)
  assert.equal(replies[0].code, 200)
  assert.equal(JSON.parse(replies[1].text).text, '今天天气不错', '正在跑的转写不许被保活器搅乱')
  assert.equal(kicks.length, 0, '成功不许补探')
  assert.equal(handler({ method: 'GET', url: '/tihu/nope', body: Buffer.from('x') }, { writeHead: () => {}, end: () => {} }), false, '别的路径不许接')

  const r2 = []
  createTihuHttpHandler({
    transcribe: async () => { throw new Error('本机语音转写不可用：宿主没有加载 speech 服务') },
    onAsrFailure: (reason) => { kicks.push(reason) },
  })(
    { method: 'POST', url: '/tihu/asr', body: Buffer.from('fake-wav') },
    { writeHead: (code) => { r2.push({ code }) }, end: (text) => { r2.push({ text }) } },
  )
  await sleep(40)
  assert.equal(r2[0].code, 200, '失败也照常回 200 带 error（与老行为一致）')
  assert.ok(JSON.parse(r2[1].text).error.includes('语音转写'))
  assert.deepEqual(kicks, ['本机语音转写不可用：宿主没有加载 speech 服务'], '失败要补探一次')
  assert.ok(readFileSync(process.env.TIHU_LANE_LOG, 'utf8').includes('asr failed'), '失败日志照要落 lane.log')
})

// ── 7. 接线与规矩：lane 里那几处钩子，以及「不靠计划任务」────────────────
await test('lane 启动路径接了保活器（探测 + 心跳 + 卸载停 + 腿失败补探）', () => {
  const lane = readFileSync(new URL('../src/tihu/lane.ts', import.meta.url), 'utf8')
  const keeperSource = readFileSync(new URL('../src/tihu/asr-keeper.ts', import.meta.url), 'utf8')
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  assert.ok(lane.includes('import { createTihuAsrKeeper'), 'lane 要 import 保活器')
  assert.ok(/const asrKeeper = createTihuAsrKeeper\(\{/.test(lane), 'lane 里要建出保活器')
  assert.ok(lane.includes("asrKeeper.ensure('lane 启动')"), 'lane 一造出来就先探再拉')
  assert.ok(!/await asrKeeper\.ensure/.test(lane), '启动探测不许 await（不许把插件加载卡在一次 ASR 服务上）')
  assert.ok(lane.includes('asrKeeper.startHeartbeat()'), '要挂心跳')
  assert.ok(lane.includes('asrKeeper.stop()'), '卸载要把手停掉')
  assert.ok(lane.includes('asrKeeper.kickAfterAsrFailure'), '设备转写腿失败要补探')
  assert.ok(lane.includes('options.onAsrFailure?.(reason)'), 'HTTP 腿失败也要补探')
  assert.ok(lane.includes('asrKeeper?: {'), 'TihuRuntimeOptions 要留注入开关（单测不许真拉服务）')
  assert.ok(keeperSource.includes('TIHU_ASR_ROOT'), '环境变量能指定服务目录')
  assert.ok(keeperSource.includes(TIHU_ASR_SERVER_SCRIPT), '拉起必须直接跑服务脚本本体')
  assert.ok(/detached: true/.test(keeperSource), '必须 detach 出去')
  assert.ok(/windowsHide: true/.test(keeperSource), '必须带 windowsHide（不许建控制台窗口）')
  assert.ok(/pythonw\.exe/.test(keeperSource), 'Windows 上必须优先 pythonw（GUI 子系统不申请控制台）')
  assert.ok(/stdio/.test(keeperSource) && /handle\.fd/.test(keeperSource), 'stdout/stderr 必须甩给日志文件 fd')
  assert.ok(/openTihuAsrLog/.test(keeperSource), '日志追加与 20MB 滚动在插件里等价重做')
  assert.ok(/child\.unref\(\)/.test(keeperSource), 'detached 出去的进程要 unref，插件卸载不等它')
  const codeOnly = (source) => source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  const code = `${codeOnly(keeperSource)}\n${codeOnly(lane)}`
  assert.ok(!/cmd\.exe/i.test(code), '插件层代码里不许再出现 cmd.exe（那是黑窗的根源；注释里讲历史是合法的）')
  assert.ok(!/schtasks|Task Scheduler|CreateScheduledTask|Uninstall|计划任务|\.ps1/.test(code), '代码里不许再挂计划任务（注释里提它被弃用是合法的）')
  assert.ok(!(keeperSource + lane).includes('C:\\Users\\'), '新代码里不许出现个人用户目录路径')
  assert.ok(pkg.includes('node scripts/test-tihu-asr-keeper.mjs'), '这套单测要进 npm test 那条链')
  assert.equal(TIHU_ASR_KEEPER_MAX_FAILURES, 3)
  assert.equal(TIHU_ASR_KEEPER_BACKOFF_MS.length, 3, '退避三档')
})

await test('注入假服务时整条保活器不会碰真 3098', async () => {
  const harness = makeHarness({ tag: 'inject', alive: true, port: 3193 })
  assert.equal(await harness.keeper.ensure('lane 启动'), true)
  assert.equal(harness.launches.length, 0, '注入活着 = 一次都不许拉')
  assert.notEqual(harness.keeper.stats().healthUrl, 'http://127.0.0.1:3098/health', '测试不许指向本机真服务')
  harness.keeper.stop()
  const norootDir = mkdtempSync(join(scratch, 'noroot-'))
  const noRoot = createTihuAsrKeeper({ startDir: norootDir, cwd: norootDir, env: {}, note: (t) => { noRootNotes.push(t) }, probeHealth: async () => true })
  assert.equal(noRoot.stats().root, undefined, '没有服务目录时 root 就是没有')
  assert.equal(noRoot.stats().healthUrl, '', '读不到 config 也不许编一个地址出来')
  assert.equal(await noRoot.ensure('lane 启动'), false, '找不到服务目录就直接不启用')
  assert.equal(noRoot.stats().lastResult, 'no-root')
  assert.ok(noRootNotes.some((line) => line.includes('找不到 asr-sensevoice 服务目录')))
  assert.equal(await noRoot.ensure('心跳'), false, '探测一次都不许做')
  noRoot.stop()
})

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${passed} tests passed（tihu asr-keeper + lane 接线）`)
