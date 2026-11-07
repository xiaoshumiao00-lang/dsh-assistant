// WebSocket permessage-deflate middleware for dsh-pocket (RFC 7692).
//
// Why: opening a long session pushes the whole opening snapshot through
// /api/remote.mux as JSON text frames (measured: 13.5MB / 2801 events) and the
// public relay server's egress is capped at ~2.7Mbps, so 13.5MB takes ~38s.
// dsh web itself never negotiates the extension (no sec-websocket-extensions in
// its 101), so the proxy negotiates it on the browser side and re-frames.
//
// Design:
//   - Only enabled when the client actually offers permessage-deflate.
//   - Context takeover on BOTH sides (no *_no_context_takeover params), window
//     bits 15 on both sides, so the negotiated parameters match the codec state.
//   - Every message is terminated with Z_SYNC_FLUSH and the trailing
//     `00 00 ff ff` is stripped (RFC 7692 7.2.1). Never BFINAL: a BFINAL stream
//     cannot be resumed, which breaks context takeover and strict receivers.
//   - Data messages are reassembled across fragments before compressing; control
//     frames are forwarded immediately and never sit inside a compressed message.
//   - Any codec/parse error destroys both sockets (the client reconnects). The
//     proxy additionally counts consecutive failures and, after too many, stops
//     offering the extension for a cooldown so a broken codec degrades to plain
//     passthrough instead of locking the phone out.

import {
  createDeflateRaw,
  createInflateRaw,
  constants as zlibConstants,
} from 'node:zlib';
import { createDownlinkScheduler } from './downlink-lanes.mjs';

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const MIN_COMPRESS_BYTES = 128;

/** Incremental WebSocket frame parser. Callback gets {fin, rsv1, opcode, payload} (unmasked). */
export class WsFrameParser {
  constructor(onFrame, onError) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onError = onError ?? (() => {});
    /**
     * 分片消息重组（RFC 6455 §5.4）：Chrome 会把大消息（实测 ~128KB 以上）拆成
     * FIN=0 的起始帧 + 若干 continuation 帧。旧实现只认 opcode=1 的单帧，于是
     * 鹈鹕页面上传 WAV（约 240KB）时第一片被判成坏 JSON 静默丢弃，页面永远等不到
     * transcript（2026-11-07 实测根因）。
     */
    this.fragmentOpcode = 0;
    this.fragmentRsv1 = false;
    this.fragmentPayloads = [];
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const b0 = b[0];
      const b1 = b[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv1 = (b0 & 0x40) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6);
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (len > MAX_MESSAGE_BYTES) {
        this.onError(new Error(`ws frame too large: ${len}`));
        return;
      }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);
      // ── 分片重组 ──
      if (opcode === 0x0) { // continuation
        if (this.fragmentOpcode === 0) continue; // 没有起始帧：丢弃
        this.fragmentPayloads.push(payload);
        const total = this.fragmentPayloads.reduce((sum, item) => sum + item.length, 0);
        if (total > MAX_MESSAGE_BYTES) {
          this.fragmentOpcode = 0;
          this.fragmentPayloads = [];
          this.onError(new Error(`ws fragmented message too large: ${total}`));
          continue;
        }
        if (!fin) continue;
        const whole = Buffer.concat(this.fragmentPayloads);
        const firstOpcode = this.fragmentOpcode;
        const firstRsv1 = this.fragmentRsv1;
        this.fragmentOpcode = 0;
        this.fragmentRsv1 = false;
        this.fragmentPayloads = [];
        this.onFrame({ fin: true, rsv1: firstRsv1, opcode: firstOpcode, payload: whole });
        continue;
      }
      if (!fin && (opcode === 0x1 || opcode === 0x2)) {
        this.fragmentOpcode = opcode;
        this.fragmentRsv1 = rsv1;
        this.fragmentPayloads = [payload];
        continue;
      }
      this.onFrame({ fin, rsv1, opcode, payload });
    }
  }
}

/** Serialize one frame. clientMask=true emits a masked (client -> server) frame. */
export function encodeFrame({ fin = true, rsv1 = false, opcode = 1, payload = Buffer.alloc(0), clientMask = false }) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = (fin ? 0x80 : 0x00) | (rsv1 ? 0x40 : 0x00) | (opcode & 0x0f);
  if (!clientMask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Serialized compressor: one zlib DeflateRaw per connection, Z_SYNC_FLUSH per message. */
class DeflateQueue {
  constructor(onError) {
    this.chunks = [];
    this.queue = [];
    this.busy = false;
    this.failed = false;
    this.onError = onError;
    this.stream = createDeflateRaw({ level: 6, windowBits: 15, memLevel: 8 });
    this.stream.on('data', (c) => this.chunks.push(c));
    this.stream.on('error', (e) => this._fail(e));
  }

  _fail(err) {
    if (this.failed) return;
    this.failed = true;
    this.onError(err);
  }

  push(payload, opts, cb) {
    if (this.failed) return;
    this.queue.push({ payload, cb, raw: opts?.raw === true });
    this._next();
  }

  _next() {
    if (this.busy || this.failed) return;
    // 不压缩的消息也要按顺序从这里过（同步吐完，不碰 zlib 状态）
    while (this.queue.length && this.queue[0].raw) {
      const item = this.queue.shift();
      item.cb(item.payload);
      if (this.failed) return;
    }
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    this.chunks = [];
    this.stream.write(item.payload);
    this.stream.flush(zlibConstants.Z_SYNC_FLUSH, () => {
      if (this.failed) return;
      let out = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [];
      if (out.length >= 4 && out.subarray(out.length - 4).equals(TAIL)) out = out.subarray(0, out.length - 4);
      this.busy = false;
      item.cb(out);
      this._next();
    });
  }

  close() {
    try { this.stream.close(); } catch { /* ignore */ }
  }
}

/** Serialized inflater: one zlib InflateRaw per connection (context takeover). */
class InflateQueue {
  constructor(onError) {
    this.chunks = [];
    this.queue = [];
    this.busy = false;
    this.failed = false;
    this.onError = onError;
    this.stream = createInflateRaw({ windowBits: 15 });
    this.stream.on('data', (c) => this.chunks.push(c));
    this.stream.on('error', (e) => this._fail(e));
  }

  _fail(err) {
    if (this.failed) return;
    this.failed = true;
    this.onError(err);
  }

  push(payload, opts, cb) {
    if (this.failed) return;
    this.queue.push({ payload, cb, raw: opts?.raw === true });
    this._next();
  }

  _next() {
    if (this.busy || this.failed) return;
    while (this.queue.length && this.queue[0].raw) {
      const item = this.queue.shift();
      item.cb(item.payload);
      if (this.failed) return;
    }
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    this.chunks = [];
    // RFC 7692 7.2.2: the receiver appends the stripped 00 00 ff ff before inflating.
    this.stream.write(Buffer.concat([item.payload, TAIL]));
    this.stream.flush(zlibConstants.Z_SYNC_FLUSH, () => {
      if (this.failed) return;
      const out = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [];
      this.busy = false;
      item.cb(out);
      this._next();
    });
  }

  close() {
    try { this.stream.close(); } catch { /* ignore */ }
  }
}

/**
 * Inspect the browser's Sec-WebSocket-Extensions offer.
 * @returns {string|null} value to echo in the 101 response, or null to stay plain
 */
export function negotiatePermessageDeflate(headerValue) {
  const offer = String(headerValue ?? '');
  if (offer === '') return null;
  for (const part of offer.split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    if (name.toLowerCase() !== 'permessage-deflate') continue;
    // Only accept the plain form: 15-bit window and context takeover on both
    // sides, which is exactly what DeflateQueue/InflateQueue keep.
    const unsupported = params.find((p) => {
      const k = p.split('=')[0].trim().toLowerCase();
      return k !== 'client_max_window_bits';
    });
    if (unsupported) continue;
    // Echo the bare extension: no params == context takeover + windowBits 15.
    return 'permessage-deflate';
  }
  return null;
}

/**
 * Wire the deflate layer between the browser socket and the upstream socket.
 * The 101 response (including our extension header) must already be written.
 * @returns {{close: () => void, stats: () => object}}
 */
export function attachWsDeflate({ client, upstream, onError = null, onFailure = null }) {
  const stats = { downIn: 0, downOut: 0, upIn: 0, upOut: 0, messages: 0, failures: 0 };
  let closed = false;

  const fail = (err) => {
    if (closed) return;
    closed = true;
    stats.failures += 1;
    try { onError?.(err); } catch { /* ignore */ }
    try { onFailure?.(); } catch { /* ignore */ }
    try { client.destroy(); } catch { /* ignore */ }
    try { upstream.destroy(); } catch { /* ignore */ }
  };

  const deflate = new DeflateQueue(fail);
  const inflate = new InflateQueue(fail);

  // P0-1：下行分道调度（high = 交互/状态小帧，low = 快照/批量大帧），带 drain 背压与合并。
  // 编码（deflate / 不压缩回退）仍由同一个 DeflateQueue 串行做，保证 zlib 上下文顺序正确。
  const downlink = createDownlinkScheduler({
    encode: (text, op) => new Promise((resolve, reject) => {
      if (text.length < MIN_COMPRESS_BYTES) {
        stats.downOut += text.length;
        resolve({ frame: encodeFrame({ fin: true, opcode: op, payload: text }), raw: true });
        return;
      }
      deflate.push(text, {}, (packed) => {
        if (closed) { reject(new Error('ws-deflate: closed')); return; }
        let out = packed;
        let rsv1 = true;
        if (packed.length >= text.length) { out = text; rsv1 = false; }
        stats.downOut += out.length;
        resolve({ frame: encodeFrame({ fin: true, rsv1, opcode: op, payload: out }) });
      });
    }),
    write: (frame) => {
      try {
        return client.write(frame);
      } catch (error) {
        fail(error);
        return true;
      }
    },
  });
  client.on('drain', () => { downlink.resume(); });

  // ---- upstream -> browser ----
  // 所有数据帧都走 deflate 队列（即使不压缩）：压缩是异步的，若小消息直接写 socket
  // 就会插到还在排队的压缩消息前面，mux 的 item 顺序被打乱。顺序必须严格保持。
  let downParts = [];
  let downOpcode = 1;
  let downSize = 0;
  const downParser = new WsFrameParser((frame) => {
    if (closed) return;
    const { fin, opcode, payload } = frame;
    if (opcode >= 0x8) {
      try { client.write(encodeFrame({ fin: true, opcode, payload })); } catch (e) { fail(e); }
      return;
    }
    downOpcode = opcode === 0 ? downOpcode : opcode;
    downParts.push(payload);
    downSize += payload.length;
    if (!fin) {
      if (downSize > MAX_QUEUED_BYTES) fail(new Error('ws-deflate: upstream message too large'));
      return;
    }
    const whole = downParts.length === 1 ? downParts[0] : Buffer.concat(downParts);
    downParts = [];
    downSize = 0;
    stats.downIn += whole.length;
    stats.messages += 1;
    const op = downOpcode;
    // 全部走下道调度器：顺序由它按「同流保序 + 小帧可越过异流大帧」维护。
    downlink.push(whole, op);
  }, fail);

  // ---- browser -> upstream ----
  // 同样全部走 inflate 队列以保住顺序。压缩消息的分片在这里先拼齐（只有最后一片
  // 才补 00 00 ff ff 交给 inflater），否则分片边界会被当成消息边界。
  let upParts = [];
  let upOpcode = 1;
  let upCompressed = false;
  const upParser = new WsFrameParser((frame) => {
    if (closed) return;
    const { fin, rsv1, opcode, payload } = frame;
    if (opcode >= 0x8) {
      try { upstream.write(encodeFrame({ fin: true, opcode, payload, clientMask: true })); } catch (e) { fail(e); }
      return;
    }
    upOpcode = opcode === 0 ? upOpcode : opcode;
    if (opcode !== 0) { upParts = []; upCompressed = false; }
    if (rsv1) upCompressed = true;
    upParts.push(payload);
    if (!fin) {
      if (upParts.reduce((n, b) => n + b.length, 0) > MAX_QUEUED_BYTES) fail(new Error('ws-deflate: client message too large'));
      return;
    }
    const whole = upParts.length === 1 ? upParts[0] : Buffer.concat(upParts);
    upParts = [];
    const op = upOpcode;
    const writePlain = () => {
      if (closed) return;
      stats.upIn += whole.length;
      try { upstream.write(encodeFrame({ fin: true, opcode: op, payload: whole, clientMask: true })); } catch (e) { fail(e); }
    };
    if (!upCompressed) {
      inflate.push(whole, { raw: true }, writePlain);
      return;
    }
    inflate.push(whole, {}, (out) => {
      if (closed) return;
      stats.upIn += out.length;
      try { upstream.write(encodeFrame({ fin: true, opcode: op, payload: out, clientMask: true })); } catch (e) { fail(e); }
    });
  }, fail);

  const onClientData = (chunk) => upParser.push(chunk);
  const onUpstreamData = (chunk) => downParser.push(chunk);
  client.on('data', onClientData);
  upstream.on('data', onUpstreamData);

  return {
    close() {
      closed = true;
      client.off('data', onClientData);
      upstream.off('data', onUpstreamData);
      try { downlink.close(); } catch { /* ignore */ }
      deflate.close();
      inflate.close();
    },
    stats: () => ({ ...stats, queue: downlink.snapshot() }),
  };
}
