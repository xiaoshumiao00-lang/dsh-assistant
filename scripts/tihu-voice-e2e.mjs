#!/usr/bin/env node
/**
 * 鹈鹕（tihu）真实语音端到端自测：WAV → audio.frame → 转写 → 注入 → 屏幕帧。
 *
 *   node scripts/tihu-voice-e2e.mjs --wav <16k单声道wav> --token <PIN> \
 *        [--host 127.0.0.1:3081] [--session <会话id>] [--timeout 90000]
 *
 * 说明：
 *   - 直接连 /tihu/lane（和页面同一条链路），token 走 query（2026-11-06 起的正式路径）；
 *   - 必须指定 `--session`：会话 id 是「手机/桌面上当前打开的那个」，脚本无法代读
 *     （localStorage 只在同一 origin 下可见）；
 *   - 打印：转写文本、各段耗时、收到的每一个下行帧。不发任何东西到别的会话。
 */
import { readFileSync } from 'node:fs'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import http from 'node:http'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const wavPath = opt('wav')
const token = opt('token', process.env.TIHU_TOKEN ?? '')
const hostPort = opt('host', '127.0.0.1:3081')
const session = opt('session', '')
const timeoutMs = Number(opt('timeout', '90000'))
if (!wavPath) {
  console.error('用法: node scripts/tihu-voice-e2e.mjs --wav <16k单声道wav> --token <PIN> [--host 127.0.0.1:3081] --session <会话id>')
  process.exit(2)
}
const [host, portRaw] = hostPort.split(':')
const port = Number(portRaw ?? 80)

/* ---------- WAV 校验（16k / 单声道 / 16bit，lane 只认这一种） ---------- */
const wav = readFileSync(wavPath)
if (wav.subarray(0, 4).toString('ascii') !== 'RIFF') { console.error('不是 RIFF/WAVE 文件'); process.exit(2) }
const channels = wav.readUInt16LE(22)
const sampleRate = wav.readUInt32LE(24)
const bits = wav.readUInt16LE(34)
const durationMs = Math.round(((wav.length - 44) / (sampleRate * channels * (bits / 8))) * 1000)
if (channels !== 1 || sampleRate !== 16000 || bits !== 16) {
  console.error(`需要 16k/单声道/16bit，实际 ${sampleRate}Hz/${channels}ch/${bits}bit`)
  process.exit(2)
}
const audioBase64 = wav.toString('base64')
console.log(`[wav] ${wavPath}`)
console.log(`[wav] ${durationMs} ms, base64 ${audioBase64.length} 字符`)

/* ---------- 极简 WS 客户端 ---------- */
function encodeClientFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  let header
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length])
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2) }
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

const key = randomBytes(16).toString('base64')
const path = `/tihu/lane${token ? `?token=${encodeURIComponent(token)}` : ''}`
const startedAt = Date.now()
const t = () => `${String(Date.now() - startedAt).padStart(5)}ms`

const req = http.request({
  host, port, path, method: 'GET',
  headers: {
    Host: `${host}:${port}`,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
  },
})

let seq = 0
const send = (socket, type, payload) => {
  seq += 1
  socket.write(encodeClientFrame(JSON.stringify({
    v: '0', type, id: `e2e-${randomUUID().slice(0, 8)}-${seq}`, seq, ts: Date.now(), payload,
  })))
}

let transcript = ''
let transcriptAt = 0
let injectAt = 0
const seen = []

const finish = (socket, code = 0) => {
  try { socket.destroy() } catch { /* 忽略 */ }
  console.log('\n--- 结果 ---')
  console.log(`转写文本: ${transcript || '（没有收到 transcript）'}`)
  if (transcriptAt && injectAt) console.log(`转写耗时: ${transcriptAt - startedAt} ms；注入+回屏: ${injectAt - transcriptAt} ms；端到端: ${injectAt - startedAt} ms`)
  else if (transcriptAt) console.log(`转写耗时: ${transcriptAt - startedAt} ms`)
  console.log(`收到帧: ${seen.map((s) => `${s.type}@${s.at}ms`).join(' → ') || '（无）'}`)
  process.exit(code)
}

req.on('upgrade', (res, socket) => {
  const expect = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  console.log(`[ws] 101 ${res.statusCode === 101 ? 'OK' : res.statusCode} accept=${res.headers['sec-websocket-accept'] === expect ? 'match' : 'MISMATCH'}`)
  let buf = Buffer.alloc(0)
  const timer = setTimeout(() => { console.error(`[ws] ${timeoutMs}ms 内没等到 transcript`); finish(socket, 1) }, timeoutMs)

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (buf.length < off + len) return
      const payload = buf.subarray(off, off + len)
      buf = buf.subarray(off + len)
      if (opcode === 0x1) {
        let message
        try { message = JSON.parse(payload.toString('utf8')) } catch { continue }
        const type = String(message.type ?? '?')
        seen.push({ type, at: Date.now() - startedAt })
        if (type === 'screen.frame' && message.payload?.stage === '聆听') {
          // 已开始转写：这一刻起算
          return
        }
        if (type === 'transcript') {
          transcript = String(message.payload?.text ?? '')
          transcriptAt = Date.now()
          console.log(`[${t()}] transcript: ${transcript}`)
          // 等注入回屏（screen.frame 思考）再收尾
          setTimeout(() => finish(socket, 0), 5000)
        }
        if (type === 'event.progress') console.log(`[${t()}] progress[${message.payload?.stage ?? ''}] ${message.payload?.text ?? ''}`)
        if (type === 'event.alert') console.log(`[${t()}] ALERT level=${message.payload?.level} ${message.payload?.text ?? ''}`)
        if (type === 'screen.frame') {
          console.log(`[${t()}] screen[${message.payload?.stage ?? ''}] ${message.payload?.title ?? ''}`)
          if (message.payload?.stage === '思考' && message.payload?.title === '模型处理中') {
            injectAt = Date.now()
            setTimeout(() => finish(socket, 0), 1200)
          }
        }
      } else if (opcode === 0x8) {
        console.error('[ws] 服务端关闭了连接')
        clearTimeout(timer)
        finish(socket, 1)
      }
    }
  })
  socket.on('error', (error) => { console.error('[ws] 连接错误', error.message); finish(socket, 1) })

  send(socket, 'hello', {
    clientId: `e2e-${randomUUID().slice(0, 8)}`,
    clientVersion: 'e2e-1',
    protocol: '0',
    capabilities: { screen: true, microphone: false },
    deviceName: 'e2e 脚本',
    ...(session ? { sessionId: session } : {}),
  })
  console.log(`[${t()}] hello（session=${session || '未指定'}）`)
  setTimeout(() => {
    console.log(`[${t()}] 发送 audio.frame`)
    send(socket, 'audio.frame', { format: 'wav', sampleRate: 16000, channels: 1, bits: 16, audioBase64, durationMs })
  }, 400)
})

req.on('response', (res) => {
  let body = ''
  res.on('data', (c) => { body += c })
  res.on('end', () => {
    console.error(`[ws] 握手失败：HTTP ${res.statusCode} ${body.slice(0, 120)}`)
    console.error('     401 = token 不对；403 = 局域网访问关闭；404 = 代理没接 /tihu/lane')
    process.exit(1)
  })
})
req.on('error', (error) => { console.error('[ws] 连接失败', error.code ?? error.message); process.exit(1) })
req.end()
