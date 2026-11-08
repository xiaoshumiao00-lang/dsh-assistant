#!/usr/bin/env node
/**
 * Kokoro 本地引擎真机自测（走 tihu 模块自己的 TihuTts，不另起服务）。
 *
 *   node scripts/tihu-kokoro-e2e.mjs [--sid 35,58] [--threads 4]
 *
 * 打印：每段首块毫秒、整段合成耗时、段间空隙（>300ms 即不合格）、
 * 实例解析出的模型绝对路径（验证「仓库内模型开箱即用」）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TihuTts, kokoroModelPath, kokoroScriptPath } from '../src/tihu/tts.ts'
import { splitSpeechSegments } from '../src/tihu/reply.ts'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

process.env.TIHU_TTS_ENGINE = 'kokoro'
const threads = Number(opt('threads', '4'))
const sids = String(opt('sid', '35,58')).split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value))
const SENTENCE = '鹈鹕已把回答准备好，共四条，建议你先看第一条。'
const NUMERIC = '温度 25℃，服务地址 127.0.0.1:3081，占比 1/5。'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function writeWav(path, chunks) {
  const data = Buffer.concat(chunks)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(48000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

/** 逐段串行合成（与 lane 的本地串行一致），记录首块/时长，返回时间轴。 */
async function runSentence(tts, text, sid) {
  const segments = splitSpeechSegments(text)
  const timeline = []
  const pcm = []
  for (const segment of segments) {
    const started = Date.now()
    let firstAt = 0
    let bytes = 0
    const result = await tts.synthesize(segment.text, {
      voice: String(sid),
      onChunk: (chunk) => {
        if (firstAt === 0) firstAt = Date.now()
        bytes += chunk.data.length
        pcm.push(chunk.data)
      },
    })
    timeline.push({
      text: segment.text,
      firstChunkMs: result.firstChunkMs,
      audioMs: result.audioMs,
      totalMs: result.totalMs,
      bytes,
      startedAt: started,
      firstAt: firstAt === 0 ? started + result.totalMs : firstAt,
    })
  }
  return { timeline, pcm, segments }
}

const tts = new TihuTts({ log: (line) => console.log('[tts]', line), threads })
console.log('[e2e] model =', kokoroModelPath())
console.log('[e2e] server script =', kokoroScriptPath())
console.log('[e2e] backend =', tts.backend(), 'engine =', process.env.TIHU_TTS_ENGINE, 'threads =', threads)

const t0 = Date.now()
await tts.ensureServer()
console.log(`[e2e] sidecar ready in ${Date.now() - t0}ms (含模型加载)`)

const report = []
for (const sid of sids) {
  const { timeline, pcm } = await runSentence(tts, SENTENCE, sid)
  let playEnd = 0
  let maxGap = 0
  const gaps = []
  for (const item of timeline) {
    const startAt = Math.max(item.firstAt, playEnd)
    playEnd = startAt + item.audioMs
    const gap = item.firstAt - (playEnd - item.audioMs)
    gaps.push(gap)
  }
  for (let i = 1; i < timeline.length; i += 1) {
    const endPrev = Math.max(timeline[i - 1].firstAt, 0) + timeline[i - 1].audioMs
    const gap = timeline[i].firstAt - endPrev
    maxGap = Math.max(maxGap, gap)
  }
  const audioMs = timeline.reduce((sum, item) => sum + item.audioMs, 0)
  const synthMs = timeline.reduce((sum, item) => sum + item.totalMs, 0)
  console.log(`[sid ${sid}] segments=${timeline.length} audio=${audioMs}ms synth=${synthMs}ms RTF=${(synthMs / audioMs).toFixed(3)} maxGap=${maxGap}ms`)
  for (const [index, item] of timeline.entries()) {
    console.log(`  seg${index} first=${item.firstChunkMs}ms total=${item.totalMs}ms audio=${item.audioMs}ms chars=${[...item.text].length} 「${item.text}」`)
  }
  report.push({ sid, audioMs, synthMs, maxGap, segments: timeline })
  if (sid === sids[0]) writeWav(join(process.cwd(), '.tihu-preview', 'tts-samples-kokoro', '_e2e-sid.wav'), pcm)
}

// 数字句：确认词典能读（℃ / % 会被丢，宿主侧要自己归一化，这里只记录时长与文字）
const num = await runSentence(tts, NUMERIC, sids[0] ?? 35)
writeWav(join(process.cwd(), '.tihu-preview', 'tts-samples-kokoro', '_e2e-num.wav'), num.pcm)
console.log(`[num] segments=${num.timeline.length} audio=${num.timeline.reduce((s, i) => s + i.audioMs, 0)}ms text=「${NUMERIC}」`)

tts.dispose()
await sleep(300)
console.log('[e2e] done')
console.log(JSON.stringify({ model: kokoroModelPath(), report }, null, 1))
