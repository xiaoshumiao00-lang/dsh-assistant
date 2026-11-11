#!/usr/bin/env node
/**
 * 鹈鹕设备发现响应器单测（`src/pocket-host/tihu-discovery.mjs`）。
 *
 * 钉住四件事：
 *   1. 只认 `TIHU_DISCOVER?`（尾随换行/空白容忍，其它一律忽略）；
 *   2. 回包格式 `TIHU_HOST <ip> <port> <token>` 与固件解析一致（两端不能各写一套格式）；
 *   3. 多网卡时选「和请求同一子网」的 IP（虚拟网卡/169.254 不能当宿主）；
 *   4. 真起停路径：bind 3082、收到广播就单播回源地址、stop 会 close，用假 UDP socket 断言。
 */
import assert from 'node:assert/strict'

import {
  TIHU_DISCOVER_PORT,
  TIHU_DISCOVER_QUERY,
  TIHU_LANE_PORT,
  createTihuDiscoveryResponder,
  formatTihuDiscoverReply,
  handleTihuDiscoverPacket,
  isTihuDiscoverQuery,
  parseTihuDiscoverReply,
  pickSameSubnetIp,
} from '../src/pocket-host/tihu-discovery.mjs'

const LAN_NICS = [
  { interface: '以太网', address: '10.113.136.60', netmask: '255.255.255.0', internal: false },
  { interface: 'vEthernet (Default Switch)', address: '172.30.16.1', netmask: '255.255.240.0', internal: false },
  { interface: '蓝牙网络连接', address: '169.254.253.4', netmask: '255.255.0.0', internal: false },
  { interface: 'Loopback', address: '127.0.0.1', netmask: '255.0.0.0', internal: true },
]

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

/** 假 UDP socket：只记 bind/send/close，message 由测试手动 emit。 */
function stubSocket() {
  const handlers = new Map()
  const sent = []
  const calls = { bind: [], closed: 0 }
  return {
    on(event, handler) { handlers.set(event, handler); return this },
    bind(options) { calls.bind.push(options) },
    send(message, port, address) { sent.push({ message, port, address }) },
    close() { calls.closed += 1 },
    emit(event, ...args) { handlers.get(event)?.(...args) },
    sent,
    calls,
  }
}

test('只认 TIHU_DISCOVER? 这一句（容忍尾随换行/空白）', () => {
  assert.equal(TIHU_DISCOVER_QUERY, 'TIHU_DISCOVER?')
  assert.equal(isTihuDiscoverQuery(Buffer.from('TIHU_DISCOVER?')), true)
  assert.equal(isTihuDiscoverQuery(Buffer.from('TIHU_DISCOVER?\r\n')), true)
  assert.equal(isTihuDiscoverQuery(Buffer.from('  TIHU_DISCOVER?  ')), true)
  assert.equal(isTihuDiscoverQuery('TIHU_DISCOVER?'), true)
  assert.equal(isTihuDiscoverQuery(Buffer.from('TIHU_DISCOVER')), false)
  assert.equal(isTihuDiscoverQuery(Buffer.from('tihu_discover?')), false)
  assert.equal(isTihuDiscoverQuery(Buffer.alloc(0)), false)
  assert.equal(isTihuDiscoverQuery(null), false)
})

test('回包格式与解析：TIHU_HOST <ip> <port> <token>', () => {
  const reply = formatTihuDiscoverReply({ ip: '10.113.136.60', port: 3081, token: '96528673' })
  assert.equal(reply, 'TIHU_HOST 10.113.136.60 3081 96528673')
  assert.deepEqual(parseTihuDiscoverReply(reply), { ip: '10.113.136.60', port: 3081, token: '96528673' })
  // 空令牌也要能解析（固件会退回 config.h 的 TIHU_TOKEN）
  assert.deepEqual(parseTihuDiscoverReply('TIHU_HOST 192.168.1.23 3081 '), { ip: '192.168.1.23', port: 3081, token: '' })
  // 端口缺失/非法 → 退回默认 3081；IP 不合法 → 判无效
  assert.deepEqual(parseTihuDiscoverReply('TIHU_HOST 192.168.1.23'), { ip: '192.168.1.23', port: TIHU_LANE_PORT, token: '' })
  assert.equal(parseTihuDiscoverReply('TIHU_HOST 999.1.1.1 3081 x'), null)
  assert.equal(parseTihuDiscoverReply('HELLO 1.2.3.4 3081 x'), null)
  assert.equal(parseTihuDiscoverReply(''), null)
})

test('多网卡优先回「和请求同一子网」的 IP', () => {
  assert.equal(pickSameSubnetIp(LAN_NICS, '10.113.136.111'), '10.113.136.60')
  assert.equal(pickSameSubnetIp(LAN_NICS, '172.30.16.7'), '172.30.16.1')
  // 请求来自陌生网段：退回第一块可用网卡，且绝不选回环/169.254
  assert.equal(pickSameSubnetIp(LAN_NICS, '192.168.1.9'), '10.113.136.60')
  assert.equal(pickSameSubnetIp(LAN_NICS, '169.254.1.2'), '169.254.253.4')
  assert.equal(pickSameSubnetIp([], '10.0.0.1'), undefined)
  assert.equal(pickSameSubnetIp([LAN_NICS[3]], '10.0.0.1'), undefined)
})

test('handleTihuDiscoverPacket：发现请求回源地址，别的包一律不理', () => {
  const hit = handleTihuDiscoverPacket({
    data: Buffer.from('TIHU_DISCOVER?'),
    rinfo: { address: '10.113.136.111', port: 50123 },
    getToken: () => '96528673',
    getLanePort: () => 3081,
    addresses: LAN_NICS,
  })
  assert.deepEqual(hit, {
    reply: 'TIHU_HOST 10.113.136.60 3081 96528673',
    address: '10.113.136.111',
    port: 50123,
    localIp: '10.113.136.60',
  })
  const ignored = handleTihuDiscoverPacket({
    data: Buffer.from('hello'),
    rinfo: { address: '10.113.136.111', port: 50123 },
    getToken: () => '96528673',
    addresses: LAN_NICS,
  })
  assert.equal(ignored, null)
  // 一块可用网卡都没有：宁可不回（设备会回退 NVS 上次地址）
  assert.equal(handleTihuDiscoverPacket({
    data: Buffer.from('TIHU_DISCOVER?'),
    rinfo: { address: '10.113.136.111', port: 50123 },
    addresses: [],
  }), null)
})

test('响应器起停（stub UDP）：bind 3082 → 广播到来就回包 → stop 关 socket', () => {
  const fake = stubSocket()
  const lines = []
  const responder = createTihuDiscoveryResponder({
    socketFactory: () => fake,
    getToken: () => '96528673',
    getLanePort: () => 3081,
    getAddresses: () => LAN_NICS,
    log: (line) => lines.push(line),
  })
  assert.equal(responder.start(), true)
  assert.deepEqual(fake.calls.bind, [{ port: TIHU_DISCOVER_PORT, address: '0.0.0.0', exclusive: true }])
  // 重复 start 不再 bind
  assert.equal(responder.start(), false)
  assert.equal(fake.calls.bind.length, 1)

  fake.emit('message', Buffer.from('TIHU_DISCOVER?\n'), { address: '10.113.136.111', port: 4096 })
  assert.equal(fake.sent.length, 1)
  assert.deepEqual(fake.sent[0], {
    message: 'TIHU_HOST 10.113.136.60 3081 96528673',
    port: 4096,
    address: '10.113.136.111',
  })
  assert.equal(responder.lastReply.localIp, '10.113.136.60')

  fake.emit('message', Buffer.from('not-a-query'), { address: '10.113.136.111', port: 4097 })
  assert.equal(fake.sent.length, 1)
  assert.ok(lines.some((line) => line.includes('忽略')))

  responder.stop()
  assert.equal(fake.calls.closed, 1)
  // 关掉后再来消息也不该再回包
  fake.emit('message', Buffer.from('TIHU_DISCOVER?'), { address: '10.113.136.111', port: 4098 })
  assert.equal(fake.sent.length, 1)
})

console.log(`\n[tihu-discovery] ${passed} 组断言全部通过`)
