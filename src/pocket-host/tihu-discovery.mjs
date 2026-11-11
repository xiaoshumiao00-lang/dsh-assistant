/**
 * 鹈鹕（tihu）设备发现响应器：UDP 3082 上回答设备广播的 `TIHU_DISCOVER?`。
 *
 * 为什么要它：ESP32 换了 Wi-Fi/换了地方，宿主 IP 就变了；设备开机先广播找电脑，
 * 拿到地址再去连 WebSocket，就不用在 config.h 里写死 IP。
 *
 * 报文（纯文本一行，双方都按空格切，不做 JSON）：
 *   设备 → 广播 255.255.255.255:3082   `TIHU_DISCOVER?`
 *   宿主 → 单播回源地址            `TIHU_HOST <ip> <port> <token>`
 *
 * 局域网多网卡时回「和请求同一子网」的那个 IP（有线的 10.x 和虚拟网卡的 172.x 经常同时存在），
 * 没有同子网的就退回第一块可用网卡。
 */
import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'

/** 设备广播的目标端口（固定，固件里也是 3082）。 */
export const TIHU_DISCOVER_PORT = 3082

/** 设备喊的那句话（固件 tihu_discover.c 同值）。 */
export const TIHU_DISCOVER_QUERY = 'TIHU_DISCOVER?'

/** 鹈鹕 lane 的端口（pocket 代理，WebSocket 路径 /tihu/lane）。 */
export const TIHU_LANE_PORT = 3081

/** 解析点分 IPv4；不合法返回 null。 */
export function parseIpv4(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return null
  const parts = match.slice(1).map((part) => Number(part))
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null
}

/** 四段 → 32 位无符号整数（子网比较用）。 */
function ipv4ToUint(parts) {
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

/** 本机所有非回环 IPv4 网卡（含 netmask，供「同子网优先」判断）。 */
export function listLanIpv4(interfaces = networkInterfaces()) {
  const out = []
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (entry?.family !== 'IPv4' && entry?.family !== 4) continue
      if (!parseIpv4(entry.address)) continue
      out.push({
        interface: name,
        address: entry.address,
        netmask: entry.netmask,
        internal: entry.internal === true,
      })
    }
  }
  return out
}

/** 169.254.x（DHCP 失败时的自动地址）不能当宿主地址。 */
function isLinkLocal(address) {
  return String(address ?? '').startsWith('169.254.')
}

/**
 * 选一个回给设备的本机 IPv4：优先和请求方同一子网，其次第一块可用网卡。
 *
 * @param candidates - listLanIpv4() 的形状（[{address, netmask, internal, interface}]）
 * @param requesterIp - 请求方的源地址（`rinfo.address`）
 * @returns 选中的 IPv4；一块可用网卡都没有时返回 undefined
 */
export function pickSameSubnetIp(candidates, requesterIp) {
  const usable = (candidates ?? []).filter((item) => item && !item.internal && parseIpv4(item.address))
  if (usable.length === 0) return undefined
  const requester = parseIpv4(requesterIp)
  if (requester) {
    const requesterUint = ipv4ToUint(requester)
    const matched = usable.filter((item) => {
      const ip = parseIpv4(item.address)
      const mask = parseIpv4(item.netmask) ?? [255, 255, 255, 0]
      const maskUint = ipv4ToUint(mask)
      return (ipv4ToUint(ip) & maskUint) === (requesterUint & maskUint)
    })
    if (matched.length > 0) {
      const preferred = matched.find((item) => !isLinkLocal(item.address))
      return (preferred ?? matched[0]).address
    }
  }
  const preferred = usable.find((item) => !isLinkLocal(item.address))
  return (preferred ?? usable[0]).address
}

/** 组装回包：`TIHU_HOST <ip> <port> <token>`。 */
export function formatTihuDiscoverReply({ ip, port, token }) {
  return `TIHU_HOST ${String(ip)} ${Number(port) || TIHU_LANE_PORT} ${String(token ?? '')}`
}

/**
 * 解析回包（固件侧同格式；这里也拿来给单测断言，避免两端格式漂移）。
 * @returns {{ip: string, port: number, token: string} | null}
 */
export function parseTihuDiscoverReply(text) {
  const value = String(text ?? '').trim()
  if (!value.startsWith('TIHU_HOST')) return null
  const rest = value.slice('TIHU_HOST'.length).trim()
  if (rest === '') return null
  const [ip, portText, ...tokenParts] = rest.split(/\s+/)
  if (!parseIpv4(ip)) return null
  const port = Number(portText)
  return {
    ip,
    port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : TIHU_LANE_PORT,
    token: tokenParts.join(' '),
  }
}

/** 收到的字节是不是 `TIHU_DISCOVER?`（允许尾随换行/空白）。 */
export function isTihuDiscoverQuery(data) {
  const text = typeof data === 'string'
    ? data
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : ''
  return text.trim() === TIHU_DISCOVER_QUERY
}

/**
 * 处理一个 UDP 包（纯函数，单测直接喂 Buffer + rinfo）。
 *
 * @param options.data - 收到的字节
 * @param options.rinfo - dgram 的 `{ address, port }`
 * @param options.getToken - () => 局域网 PIN
 * @param options.getLanePort - () => 端口（默认 3081）
 * @param options.addresses - 本机网卡列表（默认 listLanIpv4()）
 * @returns {{ reply: string, address: string, port: number, localIp: string } | null}
 *          不是发现请求、或本机没有可用 IPv4 时返回 null
 */
export function handleTihuDiscoverPacket({
  data,
  rinfo,
  getToken = () => '',
  getLanePort = () => TIHU_LANE_PORT,
  addresses = listLanIpv4(),
} = {}) {
  if (!isTihuDiscoverQuery(data)) return null
  const localIp = pickSameSubnetIp(addresses, rinfo?.address)
  if (!localIp) return null
  const port = Number(getLanePort()) || TIHU_LANE_PORT
  const token = String(getToken() ?? '')
  return {
    reply: formatTihuDiscoverReply({ ip: localIp, port, token }),
    address: String(rinfo?.address ?? ''),
    port: Number(rinfo?.port) || 0,
    localIp,
  }
}

/**
 * 起一个常驻 UDP 响应器（插件生命周期里 start/stop）。
 *
 * @param options.port - 监听端口，默认 3082
 * @param options.getToken - () => 局域网 PIN（每次回包实时取，改密码立即生效）
 * @param options.getLanePort - () => 端口，默认 3081
 * @param options.getAddresses - () => 网卡列表（测试可注入）
 * @param options.log - (line) => void，写 lane.log（`note=tihu-discover`）
 * @param options.socketFactory - () => dgram socket（单测注入假 socket）
 */
export function createTihuDiscoveryResponder({
  port = TIHU_DISCOVER_PORT,
  getToken = () => '',
  getLanePort = () => TIHU_LANE_PORT,
  getAddresses = () => listLanIpv4(),
  log = () => {},
  socketFactory = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }),
} = {}) {
  let socket = null
  let closed = false
  let lastReply = null

  const handleMessage = (data, rinfo) => {
    const result = handleTihuDiscoverPacket({
      data,
      rinfo,
      getToken,
      getLanePort,
      addresses: getAddresses(),
    })
    if (!result) {
      log(`忽略一个非发现报文（来自 ${rinfo?.address ?? '?'}:${rinfo?.port ?? 0}，${data?.length ?? 0} 字节）`)
      return null
    }
    try {
      socket?.send(result.reply, result.port, result.address)
    } catch (error) {
      log(`回包发送失败（${result.address}:${result.port}）：${error?.message ?? error}`)
      return null
    }
    log(`收到发现请求 ${rinfo?.address ?? '?'}:${rinfo?.port ?? 0} → 回 ${result.reply}`)
    return result
  }

  return {
    port,
    get socket() { return socket },
    /** 最近一条已回包的记录（诊断/测试断言用）。 */
    get lastReply() { return lastReply },
    start() {
      if (socket || closed) return false
      socket = socketFactory()
      socket.on('error', (error) => {
        log(`UDP ${port} 出错：${error?.message ?? error}`)
        try { socket?.close() } catch { /* 已关闭 */ }
        socket = null
      })
      socket.on('message', (data, rinfo) => {
        lastReply = handleMessage(data, rinfo) ?? lastReply
      })
      try {
        socket.bind({ port, address: '0.0.0.0', exclusive: true })
      } catch (error) {
        log(`UDP ${port} 绑定失败：${error?.message ?? error}`)
        socket = null
        return false
      }
      return true
    },
    stop() {
      closed = true
      if (!socket) return
      try { socket.close() } catch { /* 已关闭 */ }
      socket = null
    },
  }
}
