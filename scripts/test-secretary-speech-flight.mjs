/**
 * 秘书朗读「同一时刻最多只有一条在出声」的硬约束回归（node，纯逻辑，不启动浏览器/宿主）。
 *   node scripts/test-secretary-speech-flight.mjs
 *
 * 需求原话（2026-11-25）：「个人秘书会话页面在朗读回答时，有时候会同时朗读多个回答。
 * 我希望每次只能够朗读一个回答。当有新朗读时，旧朗读立刻停止。」
 * 硬保证：任何时刻最多一条在出声；新朗读起播的同一瞬间旧的全部停止，**含已排播但还没响的块**。
 *
 * 覆盖：
 *   ① 复现叠声：两条播放侧（两个控制器 = 两份实例的等价物）交错 request，
 *      旧的一条已经排了两块（一块在响、一块排在 2 秒后还没响），新朗读起播后必须只剩新的在响；
 *   ② 同 key + status=loading 再 request 不许第二次 start（会把已排好的首块整段丢掉从头重排）；
 *   ③ 全局令牌表只存一份：两次取到同一个对象（模拟模块被再次求值），begin() 使旧令牌失效；
 *   ④ stop() 掐掉「已 start(when) 但还没响」的块：之后推进时钟不再有任何声音；
 *   ⑤ in-flight 合成在旧代回来后不许排播（过期即丢）。
 *
 * 假运行环境按 Chromium 实测语义记账（scripts/../ 探针见 docs 报告）：
 *   stop() 在 when 之前调用 → 该块永不出声；在 [when, when+dur) 之间调用 → 只在调用前有声。
 */
import assert from 'node:assert/strict'

const lib = await import('../lib/index.js')
const cards = lib.secretaryCardsTestSurface
const pipe = lib.secretarySpeechPipelineTestSurface
/** 旧构建（改动前）没有这块导出：用到它的用例会给出「先 node build.mjs」的明确失败。 */
const flightSurface = lib.secretarySpeechFlightTestSurface

const CHUNK_OPTS = { minChars: 5, maxChars: 12, firstMaxChars: 12 }
const TEXT_A = '甲句的前半段内容。乙句的中间部分。丙句的继续补充。丁句的最后收个尾。'
const TEXT_B = '戊句换成另一段回答。己句继续往下说。庚句再接一句。辛句收尾。'

const cases = []
const pump = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve)) }

function requireFlightSurface() {
  if (flightSurface === undefined) throw new Error('lib/index.js 里没有 secretarySpeechFlightTestSurface：先 node build.mjs（旧构建没有全局飞行令牌表）')
  return flightSurface
}

/**
 * 假世界：虚拟音频时钟 + 合成队列 + 排播台账。
 * 一个 world 里可以有多个 io（= 多个播放侧实例/多条流水线），共用同一个时钟与台账，
 * 这样「两条同时出声」才能被算出来。
 */
function makeWorld() {
  const clock = { t: 100 }
  const sources = []   // { tag, when, dur, stopAt }
  const synths = []    // { tag, text, signal, settle }
  const mkIo = (tag) => ({
    now: () => clock.t,
    synthesize(text, signal) {
      return new Promise((resolve, reject) => {
        const settle = (ok) => {
          if (ok) resolve({ durationSec: 2, payload: { text, tag } })
          else reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        synths.push({ tag, text, signal, settle, done: false })
        signal.addEventListener('abort', () => settle(false))
      })
    },
    schedule(clip, when) {
      const src = { tag: clip.payload.tag, when, dur: clip.durationSec, stopAt: Infinity }
      sources.push(src)
      let done
      const finished = new Promise((resolve) => { done = resolve })
      return { finished, stop() { if (src.stopAt === Infinity) src.stopAt = clock.t; done() } }
    },
    suspend() { },
    resume() { },
    wait: () => Promise.resolve(),
  })
  /** 推进虚拟时钟（不推进真实时间，流水线的 await 靠 pump 推进）。 */
  const advance = async (to) => { clock.t = to; await pump() }
  /** 兑现 pending 个合成（可按 tag 只兑现某一条播放侧），模拟网络返回。 */
  const flushSynth = async (count = 1, tag = undefined) => {
    let left = count
    for (const item of [...synths]) {
      if (left <= 0) break
      if (item.done) continue
      if (tag !== undefined && item.tag !== tag) continue
      item.done = true
      item.settle(!item.signal.aborted)
      left -= 1
      await pump()
    }
  }
  /** 有声区间（stop 生效的语义见文件头）。 */
  const audible = (tag) => sources
    .filter((s) => tag === undefined || s.tag === tag)
    .map((s) => ({ tag: s.tag, from: s.when, to: Math.min(s.when + s.dur, s.stopAt) }))
    .filter((s) => s.to > s.from + 1e-9)
    .sort((a, b) => a.from - b.from)
  const overlaps = () => {
    const spans = audible()
    const bad = []
    for (let i = 1; i < spans.length; i++) if (spans[i].from < spans[i - 1].to - 1e-9) bad.push([spans[i - 1], spans[i]])
    return bad
  }
  /** 此刻（虚拟时钟 t）正在出声的段。 */
  const soundingAtNow = (tag) => audible(tag).filter((s) => s.from <= clock.t + 1e-9 && s.to > clock.t + 1e-9)
  return { clock, sources, synths, mkIo, advance, flushSynth, audible, overlaps, soundingAtNow }
}

/** 与 secretary-speech.ts 的 playerFactory 同构（换成假 io，并可打 tag 区分实例）。 */
function makeFactory(world, tag) {
  return (_key, text) => {
    const engine = pipe.createChunkPipeline(world.mkIo(tag), {
      text, prefetch: 2, leadInSec: 0.03, retryDelayMs: 0, ...CHUNK_OPTS,
    })
    return {
      play: () => engine.play(),
      pause: () => engine.pause(),
      resume: () => engine.resume(),
      restart: () => engine.restart(),
      stop: () => engine.stop(),
      onEnded: (cb) => engine.onEnded(cb),
      onPlaying: (cb) => engine.onPlaying(cb),
      onError: (cb) => engine.onError(cb),
    }
  }
}

/* ───────── ① 复现叠声：旧朗读有「在响的块」+「已排播未响的块」，新朗读起播后不许叠 ───────── */

cases.push(['叠声复现：新朗读起播瞬间，旧朗读（含已排播未响的块）必须全停', async () => {
  const world = makeWorld()
  // 两份播放侧：模块被再次求值 / 第二个控制器时就是这个形态（各有自己的控制器与流水线）
  const instanceA = cards.createSpeechController(makeFactory(world, 'A'))
  const instanceB = cards.createSpeechController(makeFactory(world, 'B'))

  // A 起播第 1 条：第 1 块排播（100.03 起响 2s），第 2 块排在 102.03（还没响）
  instanceA.request('assistant:turn:1', TEXT_A)
  await pump()
  await world.flushSynth(1, 'A')                // 第 0 块合成好 → 排播
  await world.advance(100.5)
  await world.flushSynth(1, 'A')                // 第 1 块合成好 → 也排上时间轴（未响）
  await world.advance(101)
  const beforeB = world.sources.length
  assert.ok(beforeB >= 2, `A 应已排播 ≥2 块（实际 ${beforeB}）`)
  assert.equal(world.soundingAtNow('A').length, 1, '此刻 A 只有第 1 块在响')
  const unplayedA = world.sources.filter((s) => s.tag === 'A' && s.when > 101)
  assert.ok(unplayedA.length >= 1, 'A 必须有一块「已排播但还没响」')

  // 新朗读起播
  instanceB.request('assistant:turn:2', TEXT_B)
  await pump()
  await world.flushSynth(1, 'B')
  await world.advance(101.2)

  // 硬保证 1：任何时刻最多一条在出声
  const bad = world.overlaps()
  assert.deepEqual(bad, [], `同一时刻出现两条在响：${JSON.stringify(bad)}`)
  // 硬保证 2：A 排上去的每一块都被 stop（含还没响的那块）
  const aliveA = world.sources.filter((s) => s.tag === 'A' && s.stopAt === Infinity)
  assert.equal(aliveA.length, 0, `A 还有 ${aliveA.length} 块没被 stop：${JSON.stringify(aliveA)}`)
  assert.equal(world.soundingAtNow('A').length, 0, 'A 不允许再有任何一段出声')
  // 硬保证 3：新朗读真的开始响
  await world.flushSynth(2)
  await world.advance(101.5)
  assert.ok(world.audible('B').length >= 1, 'B 必须已经起播')
}])

/* ───────── ② 同 key + loading 再 request 不许第二次 start ───────── */

cases.push(['同 key 仍在 loading：第二次 request 不许再 start（一次朗读只起播一次）', async () => {
  const started = []
  const controller = cards.createSpeechController((key, text) => {
    started.push([key, text])
    return {
      play: () => new Promise(() => { /* 永远停在 loading，模拟首块合成慢 */ }),
      pause: () => { }, resume: () => { }, restart: () => { }, stop: () => { }, onEnded: () => { },
    }
  })
  controller.request('assistant:turn:1', '同一条内容')
  await pump()
  controller.request('assistant:turn:1', '同一条内容')
  controller.request('assistant:turn:1', '同一条内容')
  await pump()
  assert.equal(started.length, 1, `同 key loading 重入被 start 了 ${started.length} 次，应为 1 次`)
}])

/* ───────── ③ 全局令牌表只存一份（跨模块实例共享的关键） ───────── */

cases.push(['全局令牌表：同一 realm 只有一个，begin() 让旧令牌立刻失效', () => {
  const { speechFlightBus, createSpeechFlightBus, SPEECH_FLIGHT_KEY, SPEECH_FLIGHT_VERSION } = requireFlightSurface()
  const fakeRealm = {}
  const first = speechFlightBus(fakeRealm)
  const second = speechFlightBus(fakeRealm)     // 模拟「模块被再次求值后重新取表」
  assert.equal(first, second, '同一 realm 两次取到的必须是同一张表')
  assert.equal(fakeRealm[SPEECH_FLIGHT_KEY], first, '表必须挂在全局对象上')
  assert.equal(first.version, SPEECH_FLIGHT_VERSION)

  const token1 = first.begin()
  const token2 = first.begin()
  assert.notEqual(token1, token2)
  assert.equal(first.isCurrent(token1), false, '旧令牌必须立刻失效')
  assert.equal(first.isCurrent(token2), true)

  // 旧代登记的取消器在新一代 begin() 时同步执行；过期后再登记会当场掐掉
  const bus = createSpeechFlightBus()
  const calls = []
  const t1 = bus.begin()
  bus.register(() => calls.push('a'), t1)
  bus.begin()
  assert.deepEqual(calls, ['a'], '旧代取消器必须在新一代 begin() 时同步执行')
  const t3 = bus.current()
  bus.begin()
  bus.register(() => calls.push('late'), t3)
  assert.deepEqual(calls, ['a', 'late'], '过期令牌登记 = 当场掐掉，不许留在时间轴上')
}])

/* ───────── ④ stop() 掐掉「已排播但还没响」的块 ───────── */

cases.push(['stop()：已 start(when) 但还没响的块必须被 stop，之后推进时钟一声不响', async () => {
  const world = makeWorld()
  const engine = pipe.createChunkPipeline(world.mkIo('S'), { text: TEXT_A, prefetch: 2, leadInSec: 0.03, retryDelayMs: 0, ...CHUNK_OPTS })
  const firstPlayable = engine.play()
  await world.flushSynth(1)
  await firstPlayable
  await world.advance(100.2)
  await world.flushSynth(1)
  await world.advance(100.4)
  assert.ok(world.sources.length >= 2, `应已排播 ≥2 块（实际 ${world.sources.length}）`)
  const notYetAudible = world.sources.filter((s) => s.when > world.clock.t)
  assert.ok(notYetAudible.length >= 1, '必须存在「已排播但还没响」的块')
  const stopAtClock = world.clock.t
  engine.stop()
  await pump()
  assert.equal(world.sources.filter((s) => s.stopAt === Infinity).length, 0, 'stop() 后不许留着未停的源')
  await world.advance(120)                      // 时钟走到所有块本该播完的时刻
  const startedAfterStop = world.audible().filter((s) => s.from >= stopAtClock - 1e-9)
  assert.deepEqual(startedAfterStop, [], `stop() 之后还有 ${startedAfterStop.length} 段起播：${JSON.stringify(startedAfterStop)}`)
  assert.equal(world.soundingAtNow().length, 0, 'stop() 之后现在不该有任何声音')
}])

/* ───────── ⑤ in-flight 合成在旧代回来后不许排播 ───────── */

cases.push(['过期即丢：旧代 in-flight 合成回来时，令牌已换 → 不许再排播', async () => {
  const world = makeWorld()
  const dead = pipe.createChunkPipeline(world.mkIo('old'), { text: TEXT_A, prefetch: 2, leadInSec: 0.03, retryDelayMs: 0, ...CHUNK_OPTS })
  void dead.play()
  await pump()
  const oldScheduledBefore = world.sources.filter((s) => s.tag === 'old').length
  // 另一条流水线起播（新一代令牌）——旧代此刻还在等合成
  const live = pipe.createChunkPipeline(world.mkIo('new'), { text: TEXT_B, prefetch: 2, leadInSec: 0.03, retryDelayMs: 0, ...CHUNK_OPTS })
  void live.play()
  await pump()
  await world.flushSynth(6)                      // 旧代的合成此刻才回来
  await world.advance(110)
  assert.equal(world.sources.filter((s) => s.tag === 'old').length, oldScheduledBefore, '旧代不许在换代后再排播任何一块')
  const bad = world.overlaps()
  assert.deepEqual(bad, [], `同一时刻出现两条在响：${JSON.stringify(bad)}`)
}])

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed > 0) process.exit(1)
console.log(`PASS ${cases.length}/${cases.length} secretary-speech-flight`)
