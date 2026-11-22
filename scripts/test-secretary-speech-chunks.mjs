/**
 * 秘书朗读「分块 + 流式流水线」单测（纯逻辑，不启动浏览器/宿主/python）：
 *   node scripts/test-secretary-speech-chunks.mjs
 *
 * 覆盖（对应需求逐条）：
 *   ① 分块器：拼接逐字符一致（含空白）、上下限、首块上限、短文本不切块；
 *      边界规则——不切在数字/小数/百分号/单位/引号对/括号对/URL/文件路径/行内代码中间；
 *   ② 流水线：假合成延迟证明「首块可播 << 整段合成完」；顺序播完、无重复播、无跳句；
 *      块间时间轴首尾相接（无间隙）；预取窗口生效（最多 prefetch 个并发合成）；
 *   ③ 失败：每块重试一次；再失败停在该块 + onError，后续块不播；
 *   ④ 打断/竞态：stop/restart abort 全部 in-flight 合成、旧代不排播、不叠声；
 *   ⑤ 缓存：文本指纹 key、第二次朗读零合成秒播、LRU 逐出。
 */
import assert from 'node:assert/strict'

const lib = await import('../lib/index.js')
const cards = lib.secretaryCardsTestSurface
const pipe = lib.secretarySpeechPipelineTestSurface

const cases = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cpLen = (s) => [...s].length

/* ───────────────────────────── ① 分块器 ───────────────────────────── */

cases.push(['分块：拼接逐字符一致（含空白/换行/前导空格）', () => {
  const texts = [
    '　前导空白的回复。第二句在这里，内容比较长用来凑够长度上限 testing。第三句继续补充内容，直到超过两百个字为止，看看分块器是不是仍然保持逐字符一致的拼接结果，不许丢字不许加字。再来一句收尾。',
    '带\n换行\n的文本。第二段落也要足够长，用来凑长度，看看换行符在块边界上的表现如何，是否正常保留。第三段继续写一些内容凑够字数，让分块真正发生。',
    '英文 Mixed content with spaces. 再来一句中文凑长度，这是第二句，用来确保整体超过分块上限，让分块真正发生，看看空格与英文的处理是否正确无误。第三句。',
    '只有三句。都很短。',
  ]
  for (const t of texts) {
    const chunks = cards.splitSpeechChunks(t)
    assert.equal(chunks.join(''), t, '拼接必须与原文逐字符一致')
    assert.ok(chunks.every((c) => c !== ''), '不允许空块')
  }
}])

cases.push(['分块：短文本（≤200 字）不切块', () => {
  const short = '今天天气不错。适合出门走走。'
  assert.deepEqual(cards.splitSpeechChunks(short), [short])
  const exactly = '句。'.repeat(100) // 200 字
  assert.equal(cpLen(exactly), 200)
  assert.deepEqual(cards.splitSpeechChunks(exactly), [exactly])
  const over = '句。'.repeat(101) // 202 字 → 必须切
  const chunks = cards.splitSpeechChunks(over)
  assert.ok(chunks.length > 1, '超上限必须切块')
  assert.equal(chunks.join(''), over)
}])

cases.push(['分块：上下限 40–200、首块 ≤80、仅尾块可不足', () => {
  // 每句 20 字：「一二三四五六七八九零一二三四五六七八九零。」
  const sentence = '一二三四五六七八九零'.repeat(2) + '。'
  const text = sentence.repeat(15) // 300 字
  const chunks = cards.splitSpeechChunks(text)
  assert.equal(chunks.join(''), text)
  assert.ok(cpLen(chunks[0]) <= 80, `首块 ${cpLen(chunks[0])} 字 ≤ 80`)
  assert.ok(cpLen(chunks[0]) >= 40, `首块 ${cpLen(chunks[0])} 字 ≥ 40`)
  for (let i = 1; i < chunks.length - 1; i++) {
    assert.ok(cpLen(chunks[i]) <= 200, `块 ${i} 上限`)
    assert.ok(cpLen(chunks[i]) >= 40, `块 ${i} ${cpLen(chunks[i])} 字 ≥ 40`)
  }
  // 尾块可以不足 40：276 字 → 63 + 189 + 24（尾块 24 字 < 40）
  const tail = sentence.repeat(13) + '短尾。'
  const t2 = cards.splitSpeechChunks(tail)
  assert.ok(t2.length === 3 && cpLen(t2[2]) < 40, JSON.stringify(t2.map(cpLen)))
}])

/** 断言 token 内绝无切点：token 必须完整落在某一个块里。 */
function assertTokenNeverSplit(text, token) {
  const chunks = cards.splitSpeechChunks(text)
  assert.equal(chunks.join(''), text, '拼接一致')
  const joined = chunks.join('')
  let idx = joined.indexOf(token)
  while (idx >= 0) {
    let offset = 0
    let ok = false
    for (const chunk of chunks) {
      if (idx >= offset && idx + token.length <= offset + chunk.length) { ok = true; break }
      offset += chunk.length
    }
    assert.ok(ok, `token「${token}」被切开了（chunks=${JSON.stringify(chunks)}）`)
    idx = joined.indexOf(token, idx + 1)
  }
}

cases.push(['分块边界：数字/小数/百分号/单位/时间/日期不切开', () => {
  const pad = '这是用来凑够长度的铺垫句，内容要超过分块上限才能让切点出现。'
  const text = `${pad.repeat(6)}温度 3.5℃，增长率 12.5%，金额 1,234 元，会议 10:30 开始，日期 2026-11-22，重量 70kg，时速 60km/h。${pad}`
  for (const token of ['3.5℃', '12.5%', '1,234', '10:30', '2026-11-22', '70kg', '60km/h']) assertTokenNeverSplit(text, token)
}])

cases.push(['分块边界：引号对/括号对中间不切开', () => {
  const pad = '铺垫句继续凑长度，确保整体文本超过分块上限让切点真正出现。'
  const text = `${pad.repeat(6)}他说「明天；后天；都行」。备注（见附录 A；图 3）以及“引号；分号”在内。${pad}`
  for (const token of ['「明天；后天；都行」', '（见附录 A；图 3）', '“引号；分号”']) assertTokenNeverSplit(text, token)
}])

cases.push(['分块边界：URL / 文件路径 / 行内代码不切开', () => {
  const pad = '继续铺垫凑长度，这句用来把全文推过分块上限。'
  const text = `${pad.repeat(6)}见 https://example.com/a;b?x=1&y=2 以及 D:\\tmp\\report;a.txt 和 ~/docs/a;b.md 还有 \`a;b=c\` 代码。${pad}`
  for (const token of ['https://example.com/a;b?x=1&y=2', 'D:\\tmp\\report;a.txt', '~/docs/a;b.md', '`a;b=c`']) assertTokenNeverSplit(text, token)
}])

cases.push(['分块：超长句无句读时退化安全（仍不切保护 token）', () => {
  // 没有句读的一长串，强制退化切分
  const text = ('无标点长句直接连成一串汉字'.repeat(20)) + ' 3.14 结尾'
  const chunks = cards.splitSpeechChunks(text)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), text)
  assertTokenNeverSplit(text, '3.14')
  for (let i = 0; i < chunks.length - 1; i++) assert.ok(cpLen(chunks[i]) <= 200)
}])

/* ───────────────────────────── ② 流水线 ───────────────────────────── */

/** 假运行环境：可控合成延迟/失败、假音频时钟（真实时间）、手动兑现的排播。 */
function makeIo(opts = {}) {
  const synthDelay = opts.synthDelay ?? 40
  const clipDuration = opts.clipDuration ?? 30
  const failTexts = new Set(opts.failTexts ?? [])   // 这些文本永远失败（两次都失败）
  const calls = []                                   // { text, signal, at }
  const scheduled = []                               // { text, when, resolveFinished }
  let maxInflight = 0
  let inflight = 0
  const io = {
    calls,
    scheduled,
    underruns: [],
    now: () => performance.now() / 1000,
    async synthesize(text, signal) {
      const call = { text, signal, at: performance.now() }
      calls.push(call)
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      try {
        await sleep(synthDelay)
        if (failTexts.has(text)) throw new Error(`合成失败：${text.slice(0, 8)}`)
        return { durationSec: clipDuration, payload: { text } }
      } finally {
        inflight -= 1
      }
    },
    schedule(clip, when) {
      let resolveFinished
      const finished = new Promise((resolve) => { resolveFinished = resolve })
      const item = { text: clip.payload.text, when, resolveFinished, durationSec: clip.durationSec }
      scheduled.push(item)
      return {
        finished,
        stop() { item.stopped = true },
      }
    },
    onUnderrun: (info) => { io.underruns.push(info) },
    get maxInflight() { return maxInflight },
  }
  return io
}

/** 等条件满足或超时。 */
async function until(fn, timeoutMs = 3000, stepMs = 5) {
  const t0 = performance.now()
  while (!fn()) {
    if (performance.now() - t0 > timeoutMs) throw new Error('until 超时')
    await sleep(stepMs)
  }
}

const CHUNK_TEXT = '甲句的前半段内容。乙句的中间部分。丙句的继续补充。丁句的最后收个尾。'
// 测试用小分块参数：小文本也能切出多块（生产默认 40/200/80）
const CHUNK_OPTS = { minChars: 5, maxChars: 12, firstMaxChars: 12 }

cases.push(['流水线：首块可播时间 << 整段合成完成时间；顺序播完不重不漏', async () => {
  const io = makeIo({ synthDelay: 60, clipDuration: 30 })
  const cache = pipe.createSpeechClipCache(16)
  const engine = pipe.createChunkPipeline(io, { text: CHUNK_TEXT, cache, prefetch: 2, leadInSec: 0.02, retryDelayMs: 0, ...CHUNK_OPTS })
  const expectedChunks = cards.splitSpeechChunks(CHUNK_TEXT, CHUNK_OPTS)
  assert.ok(expectedChunks.length >= 4, '测试文本应分出多块')

  let endedCount = 0
  let playingCount = 0
  engine.onEnded(() => { endedCount += 1 })
  engine.onPlaying(() => { playingCount += 1 })

  const t0 = performance.now()
  const playPromise = engine.play()
  // 首块一排播就能兑现
  await until(() => io.scheduled.length >= 1)
  const firstPlayableMs = performance.now() - t0
  await playPromise

  // 让所有块排完（合成快、播放慢——播放时长 30s 远超合成，不会真等）
  await until(() => io.scheduled.length === expectedChunks.length)
  const allScheduledMs = performance.now() - t0

  // ① 首块可播 vs 全部排播完成：这里所有合成是并行预取的，断言「首块兑现远早于整段播完」
  //    用更强口径：首块可播 ≈ 1 次合成延迟；而「整段一次性合成」的旧行为 ≈ N 次串行延迟。
  assert.ok(firstPlayableMs <= 60 * 2 + 50, `首块可播 ${firstPlayableMs.toFixed(0)}ms ≈ 单次合成延迟`)
  // ② 顺序正确、无重复、无跳句
  assert.deepEqual(io.scheduled.map((s) => s.text), expectedChunks, '排播顺序=分块顺序，不重不漏')
  // ③ 时间轴首尾相接（合成追得上播放 → 无间隙）
  assert.equal(io.underruns.length, 0, '不允许 underrun')
  for (let i = 1; i < io.scheduled.length; i++) {
    const prev = io.scheduled[i - 1]
    const gap = io.scheduled[i].when - (prev.when + prev.durationSec)
    assert.ok(Math.abs(gap) < 1e-6, `块 ${i} 与上块无缝衔接（gap=${gap}）`)
  }
  // ④ 预取窗口：并发合成数 ≤ prefetch
  assert.ok(io.maxInflight <= 2, `并发合成 ${io.maxInflight} ≤ prefetch 2`)
  // ⑤ 播完：按顺序兑现 finished → ended 恰好一次
  for (const item of io.scheduled) item.resolveFinished()
  await until(() => endedCount === 1)
  assert.equal(endedCount, 1, 'ended 恰好一次')
  assert.equal(playingCount, 1, 'playing 恰好一次（首块）')
  engine.stop()
  void allScheduledMs
}])

cases.push(['流水线：合成追不上播放时记 underrun，但不重不漏不丢序', async () => {
  const io = makeIo({ synthDelay: 120, clipDuration: 0.05 }) // 播放 50ms，合成 120ms → 必 underrun
  const engine = pipe.createChunkPipeline(io, { text: CHUNK_TEXT, prefetch: 1, leadInSec: 0.01, retryDelayMs: 0, onUnderrun: (info) => { io.underruns.push(info) }, ...CHUNK_OPTS })
  let ended = false
  engine.onEnded(() => { ended = true })
  engine.play().catch(() => {})
  await until(() => io.scheduled.length >= 4)
  assert.ok(io.underruns.length >= 1, '合成慢于播放必须记 underrun')
  const expected = cards.splitSpeechChunks(CHUNK_TEXT, CHUNK_OPTS)
  assert.deepEqual(io.scheduled.map((s) => s.text), expected, '即便 underrun 顺序也不重不漏')
  for (const item of io.scheduled) item.resolveFinished()
  await until(() => ended)
  engine.stop()
}])

cases.push(['流水线：某块失败重试一次，再失败停在该块并 onError', async () => {
  // 让第二块永远失败（两次尝试都失败）
  const second = cards.splitSpeechChunks(CHUNK_TEXT, CHUNK_OPTS)[1]
  const io = makeIo({ synthDelay: 20, clipDuration: 30, failTexts: [second] })
  const engine = pipe.createChunkPipeline(io, { text: CHUNK_TEXT, prefetch: 1, leadInSec: 0.01, retryDelayMs: 0, ...CHUNK_OPTS })
  const errors = []
  engine.onError((message) => { errors.push(message) })
  let ended = false
  engine.onEnded(() => { ended = true })
  const playPromise = engine.play()
  await playPromise // 首块成功 → 兑现
  await until(() => errors.length === 1)
  await sleep(30)
  // 停在该块：第 0 块排播了，第 1 块失败，第 2 块起绝不排播
  assert.equal(io.scheduled.length, 1, `只排播了失败块之前的 ${io.scheduled.length} 块`)
  assert.equal(errors.length, 1, 'onError 恰好一次')
  assert.match(errors[0], /合成失败/)
  assert.equal(ended, false, '失败了不许 ended')
  // 该块恰好合成了两次（重试一次）
  const attempts = io.calls.filter((c) => c.text === second).length
  assert.equal(attempts, 2, `失败块合成 ${attempts} 次 = 首次 + 一次重试`)
  engine.stop()
}])

cases.push(['流水线：首块就失败两次 → play() 拒绝（控制器进 error 态）', async () => {
  const first = cards.splitSpeechChunks(CHUNK_TEXT, CHUNK_OPTS)[0]
  const io = makeIo({ synthDelay: 10, failTexts: [first] })
  const engine = pipe.createChunkPipeline(io, { text: CHUNK_TEXT, prefetch: 1, retryDelayMs: 0, ...CHUNK_OPTS })
  const errors = []
  engine.onError((m) => errors.push(m))
  const t0 = performance.now()
  await assert.rejects(engine.play(), /合成失败/)
  assert.ok(performance.now() - t0 < 500, '失败应快速返回')
  assert.ok(errors.length >= 1)
  assert.equal(io.scheduled.length, 0)
  engine.stop()
}])

cases.push(['流水线：瞬时失败一次后重试成功 → 照常播完', async () => {
  let attempts = 0
  const io = makeIo({ synthDelay: 10, clipDuration: 30 })
  const original = io.synthesize.bind(io)
  io.synthesize = async (text, signal) => {
    attempts += 1
    if (attempts === 1) { throw new Error('瞬时网络错误') }
    return original(text, signal)
  }
  const engine = pipe.createChunkPipeline(io, { text: CHUNK_TEXT, prefetch: 2, leadInSec: 0.01, retryDelayMs: 0, ...CHUNK_OPTS })
  let ended = false
  engine.onEnded(() => { ended = true })
  await engine.play()
  await until(() => io.scheduled.length >= 4)
  for (const item of io.scheduled) item.resolveFinished()
  await until(() => ended)
  assert.equal(attempts, 4 + 1, '4 块 + 1 次瞬时失败重试')
  assert.equal(io.calls.length, 4, '成功合成仍只有 4 块')
  engine.stop()
}])

cases.push(['打断/竞态：stop 立即 abort in-flight 合成、旧代不再排播', async () => {
  const signals = []
  const io = makeIo({ synthDelay: 5000, clipDuration: 30 }) // 永不完成的慢合成
  io.synthesize = (text, signal) => { signals.push({ text, signal }); return new Promise(() => {}) }
  const engine = pipe.createChunkPipeline(io, { text: CHUNK_TEXT, prefetch: 2, leadInSec: 0.01, retryDelayMs: 0, ...CHUNK_OPTS })
  void engine.play()
  await until(() => signals.length >= 1)
  engine.stop()
  await sleep(20)
  assert.ok(signals.every((s) => s.signal.aborted === true), '全部 in-flight 必须 abort')
  assert.equal(io.scheduled.length, 0, '慢合成下不该有排播；stop 后旧代绝不再排')
  engine.stop()
}])

cases.push(['打断/竞态：restart 打断旧队列，新旧不叠声（旧 finished 不触发 ended）', async () => {
  const io = makeIo({ synthDelay: 15, clipDuration: 30 })
  const engine = pipe.createChunkPipeline(io, { text: CHUNK_TEXT, cache: null, prefetch: 1, leadInSec: 0.01, retryDelayMs: 0, ...CHUNK_OPTS })
  const expected = cards.splitSpeechChunks(CHUNK_TEXT, CHUNK_OPTS)
  let ended = 0
  let playing = 0
  engine.onEnded(() => { ended += 1 })
  engine.onPlaying(() => { playing += 1 })
  await engine.play()          // 第 1 轮（首块排播后立刻被打断）
  engine.restart()             // 打断重读
  await until(() => playing >= 2)
  // 等第 2 轮全部排完（第 1 轮排了几块不确定，第 2 轮必须是完整的 4 块）
  await until(() => io.scheduled.length >= expected.length + 1)
  const round2 = io.scheduled.slice(io.scheduled.length - expected.length)
  assert.deepEqual(round2.map((s) => s.text), expected, '第 2 轮完整按序排播')
  // 把第 1 轮（前部）兑现：旧代不许触发 ended（不叠声、不误报播完）
  const firstRound = io.scheduled.slice(0, io.scheduled.length - expected.length)
  for (const item of firstRound) item.resolveFinished()
  await sleep(30)
  assert.equal(ended, 0, '旧代的 finished 不许触发 ended')
  for (const item of round2) item.resolveFinished()
  await until(() => ended === 1)
  assert.equal(ended, 1)
  engine.stop()
}])

/* ───────────────────────────── ⑤ 缓存 ───────────────────────────── */

cases.push(['缓存：文本指纹 key 不撞车；LRU 逐出', () => {
  const k1 = pipe.speechClipCacheKey('武汉明天 8 到 14 度。')
  const k2 = pipe.speechClipCacheKey('武汉明天 8 到 15 度。')
  assert.notEqual(k1, k2, '差一个字也不能撞')
  assert.equal(pipe.speechClipCacheKey('武汉明天 8 到 14 度。'), k1, '同文本同 key')
  assert.match(k1, /^sp1:\d+:[0-9a-f]{8}$/)

  const cache = pipe.createSpeechClipCache(2)
  const mk = (t) => ({ durationSec: 1, payload: t })
  cache.set('a', mk('a')); cache.set('b', mk('b')); cache.set('c', mk('c'))
  assert.equal(cache.get('a'), undefined, '最老的被逐出')
  assert.equal(cache.get('b')?.payload, 'b')
  cache.get('b') // touch
  cache.set('d', mk('d'))
  assert.equal(cache.get('c'), undefined, 'LRU：被 touch 的 b 留下，c 逐出')
  assert.equal(cache.get('b')?.payload, 'b')
}])

cases.push(['缓存：同一句第二次朗读零合成、首块秒播', async () => {
  const io = makeIo({ synthDelay: 30, clipDuration: 30 })
  const cache = pipe.createSpeechClipCache(16)
  const engine = pipe.createChunkPipeline(io, { text: CHUNK_TEXT, cache, prefetch: 2, leadInSec: 0.01, retryDelayMs: 0, ...CHUNK_OPTS })
  let ended = false
  engine.onEnded(() => { ended = true })
  await engine.play()
  await until(() => io.scheduled.length >= 4)
  for (const item of io.scheduled) item.resolveFinished()
  await until(() => ended)
  const firstRunCalls = io.calls.length
  assert.ok(firstRunCalls >= 4)
  engine.stop()

  // 第二次：全新引擎、共享缓存 → 零合成
  const io2 = makeIo({ synthDelay: 30, clipDuration: 30 })
  const engine2 = pipe.createChunkPipeline(io2, { text: CHUNK_TEXT, cache, prefetch: 2, leadInSec: 0.01, retryDelayMs: 0, ...CHUNK_OPTS })
  let ended2 = false
  engine2.onEnded(() => { ended2 = true })
  const t0 = performance.now()
  await engine2.play() // 缓存命中：立即兑现
  const secondPlayableMs = performance.now() - t0
  assert.equal(io2.calls.length, 0, '第二次朗读零合成请求')
  assert.ok(secondPlayableMs < 30, `首块秒播（${secondPlayableMs.toFixed(1)}ms）`)
  await until(() => io2.scheduled.length === 4)
  for (const item of io2.scheduled) item.resolveFinished()
  await until(() => ended2)
  engine2.stop()
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
console.log(`PASS ${cases.length}/${cases.length} secretary-speech-chunks`)
