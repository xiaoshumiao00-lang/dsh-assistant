/** 手机 opening follow 的代理侧数值截窗：node scripts/test-mobile-uplink-history.mjs */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { attachWsDeflate, encodeFrame, WsFrameParser } from '../src/pocket-host/ws-deflate.mjs'
import { capMobileSessionFollowMessage, MOBILE_OPENING_HISTORY_MESSAGES } from '../src/pocket-host/mobile-uplink-history.mjs'

const follow = () => JSON.stringify({
  type: 'open', streamId: 'stream-A', endpoint: 'session/follow',
  payload: { args: { request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: true, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } } } },
})

// 1. 只改 opening follow 的窗口数值，stream / endpoint / address / 其它参数完全不变。
{
  const original = follow()
  const result = capMobileSessionFollowMessage(original)
  assert.equal(result.changed, true)
  assert.equal(MOBILE_OPENING_HISTORY_MESSAGES, 20)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.payload.args.request.maxMessages, 20)
  assert.equal(parsed.payload.args.request.turnWindow.minMessages, 20, 'minMessages 必须同步缩小，避免 min>max 导致无快照')
  assert.equal(parsed.payload.args.request.turnWindow.minTurns, 2)
  assert.equal(parsed.streamId, 'stream-A')
  assert.equal(parsed.endpoint, 'session/follow')
  assert.deepEqual(parsed.payload.args.request.address, { kind: 'session', sessionId: 's1' })
  assert.equal(JSON.parse(original).payload.args.request.maxMessages, 500)
}

// 2. session/page 是向上翻旧历史，绝不能截。
{
  const page = JSON.stringify({ type: 'call', streamId: 'older', endpoint: 'session/page', payload: { args: { request: { maxMessages: 500 } } } })
  assert.deepEqual(capMobileSessionFollowMessage(page), { text: page, changed: false })
}

// 3. 小窗口、下行 snapshot、普通 item、坏 JSON 与非文本一律原样。
{
  const small = follow().replace('"maxMessages":500', '"maxMessages":20').replace('"minMessages":50', '"minMessages":20')
  assert.equal(capMobileSessionFollowMessage(small).changed, false)
  for (const text of [
    JSON.stringify({ type: 'item', streamId: 'A', value: { type: 'snapshot', records: [], maxMessages: 500 } }),
    JSON.stringify({ type: 'open', endpoint: 'other/follow', payload: { args: { request: { maxMessages: 500 } } } }),
    '{bad json',
  ]) assert.deepEqual(capMobileSessionFollowMessage(text), { text, changed: false })
  assert.equal(capMobileSessionFollowMessage(Buffer.from('binary')).changed, false)
}

// 4. 真实 WebSocket 帧过内存中间件：明文不伪造 RSV1，上行到 upstream 前确实变成 20。
{
  class FakeSocket extends EventEmitter {
    writes = []
    write(frame) { this.writes.push(frame); return true }
    destroy() {}
  }
  const client = new FakeSocket()
  const upstream = new FakeSocket()
  const middleware = attachWsDeflate({ client, upstream, compress: false, onUplinkText: capMobileSessionFollowMessage })
  client.emit('data', encodeFrame({ fin: true, opcode: 1, payload: Buffer.from(follow()), clientMask: true }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const received = []
  const parser = new WsFrameParser((frame) => received.push(frame), (error) => { throw error })
  for (const frame of upstream.writes) parser.push(frame)
  assert.equal(received.length, 1)
  assert.equal(received[0].rsv1, false)
  const parsed = JSON.parse(received[0].payload.toString('utf8'))
  assert.equal(parsed.payload.args.request.maxMessages, 20)
  assert.equal(parsed.streamId, 'stream-A')
  assert.equal(middleware.stats().upTransformed, 1)
  middleware.close()
}

// 5. 接线：压缩与明文都走同一解析边界，仅 remote.mux 开启；下行调度器不改。
{
  const ws = readFileSync(new URL('../src/pocket-host/ws-deflate.mjs', import.meta.url), 'utf8')
  assert.match(ws, /onUplinkText/)
  assert.match(ws, /compress = true/)
  assert.match(ws, /!compress \|\| text\.length < MIN_COMPRESS_BYTES/)
  const proxy = readFileSync(new URL('../src/pocket-host/proxy.mjs', import.meta.url), 'utf8')
  assert.match(proxy, /capMobileSessionFollowMessage/)
  assert.match(proxy, /wsPath === '\/api\/remote\.mux'/)
  const lanes = readFileSync(new URL('../src/pocket-host/downlink-lanes.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(lanes, /capMobileSessionFollowMessage/)
}

console.log('mobile-uplink-history: 5/5 通过')
