// src/pocket-host/index.js
import { fileURLToPath } from "node:url";
import { spawn as spawn5 } from "node:child_process";
import { readFileSync as readFileSync5, mkdirSync as mkdirSync5, writeFileSync as writeFileSync3 } from "node:fs";
import { writeFile as writeFile3, readFile as readFile3, mkdir as mkdir4, rm as rm3 } from "node:fs/promises";
import { join as join9, dirname as dirname7 } from "node:path";
import { homedir as homedir5 } from "node:os";
import { randomBytes as randomBytes2, randomInt, createHash as createHash4 } from "node:crypto";

// src/pocket-host/service.mjs
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { readFileSync as readFileSync2 } from "node:fs";
import { execFile as execFile2 } from "node:child_process";
import { mkdir as mkdir2, readFile, rm as rm2, writeFile } from "node:fs/promises";
import { join as join3, dirname as dirname3 } from "node:path";

// src/pocket-host/proxy.mjs
import { createServer } from "node:http";
import { request as httpRequest2 } from "node:http";
import { createGzip, createBrotliCompress, constants as zlibConstants3 } from "node:zlib";
import { createHash as createHash2, timingSafeEqual } from "node:crypto";

// src/pocket-host/diagnostics.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var MAX_BYTES = 1024 * 1024;
var MAX_TAIL = 200;
function diagnosticPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-pocket", "diagnostic.jsonl");
}
function rotate(file) {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size <= MAX_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
  }
}
function appendDiagnostic(record) {
  try {
    const file = diagnosticPath();
    mkdirSync(dirname(file), { recursive: true });
    rotate(file);
    appendFileSync(file, `${JSON.stringify({ ...record, at: record?.at ?? Date.now() })}
`, "utf8");
  } catch {
  }
}
function readDiagnosticTail(limit = MAX_TAIL) {
  try {
    const file = diagnosticPath();
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter(Boolean).slice(-Math.max(1, Math.min(limit, 1e3)));
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  }
}
function diagnosticSummary({ minutes = 30, limit = 120 } = {}) {
  const since = Date.now() - Math.max(1, minutes) * 6e4;
  const entries = readDiagnosticTail(2e3).filter((entry) => Number(entry?.at) >= since);
  const counts = {};
  for (const entry of entries) {
    const key = String(entry?.ev ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const pages = entries.filter((entry) => entry?.ev === "page");
  const wsOpen = entries.filter((entry) => entry?.ev === "ws-open");
  const wsClose = entries.filter((entry) => entry?.ev === "ws-close");
  return {
    path: diagnosticPath(),
    minutes,
    entries: entries.length,
    counts,
    pages: pages.slice(-50),
    wsOpen: wsOpen.slice(-50),
    wsClose: wsClose.slice(-50),
    tail: entries.slice(-limit)
  };
}

// src/pocket-host/ws-deflate.mjs
import {
  createDeflateRaw,
  createInflateRaw,
  constants as zlibConstants
} from "node:zlib";

// src/pocket-host/downlink-lanes.mjs
var DEFAULT_HIGH_LANE_BYTES = 2048;
var DEFAULT_HIGH_WATER_BYTES = 15e5;
var DEFAULT_MAX_QUEUED_BYTES = 12e6;
var DEFAULT_MAX_LOW_LANE_WAIT_MS = 4e3;
var DEFAULT_DEEP_QUEUE_BYTES = 15e5;
var DEFAULT_LOW_LANE_WINDOW_MS = 1e3;
var DEFAULT_LOW_LANE_WINDOW_BYTES = 256 * 1024;
var TYPE_RE = /"type":"(item|end|error|init|open|ack|event)"/;
var STREAM_RE = /"streamId":"([A-Za-z0-9_.:-]{1,64})"|"streamId":([0-9]{1,20})/;
var PROJECTION_RE = /"type":"item".*?"value":\{"type":"projection","sessionId":"([^"]{1,80})","key":"([^"]{1,64})"/;
function classifyDownlinkMessage(text) {
  const buf = typeof text === "string" ? null : text;
  const bytes = buf ? buf.length : Buffer.byteLength(text, "utf8");
  const head = buf ? buf.subarray(0, 512).toString("utf8") : String(text).slice(0, 512);
  const type = TYPE_RE.exec(head);
  const kind = type ? type[1] : "unknown";
  const stream = STREAM_RE.exec(head);
  const streamId = stream ? stream[1] ?? stream[2] : null;
  const proj = kind === "item" ? PROJECTION_RE.exec(head) : null;
  const coalesceKey = proj ? `p:${streamId ?? "?"}:${proj[1]}:${proj[2]}` : null;
  const lane = bytes <= DEFAULT_HIGH_LANE_BYTES ? "high" : "low";
  return { lane, streamId, coalesceKey, bytes, kind };
}
function createDownlinkScheduler({ encode, write, now = () => Date.now(), limits = {}, onOverflow = null }) {
  const highBytes = limits.highBytes ?? DEFAULT_HIGH_LANE_BYTES;
  const highWaterBytes = limits.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
  const maxQueuedBytes = limits.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const allowBypass = limits.allowBypass !== false;
  const maxLowLaneWaitMs = Number(limits.maxLowLaneWaitMs ?? DEFAULT_MAX_LOW_LANE_WAIT_MS);
  const agingGate = maxLowLaneWaitMs > 0;
  const paceWhenDeep = limits.paceWhenDeep !== false;
  const deepQueueBytes = Number(limits.deepQueueBytes ?? DEFAULT_DEEP_QUEUE_BYTES);
  const lowLaneWindowMs = Number(limits.lowLaneWindowMs ?? DEFAULT_LOW_LANE_WINDOW_MS);
  const lowLaneWindowBytes = Number(limits.lowLaneWindowBytes ?? DEFAULT_LOW_LANE_WINDOW_BYTES);
  let pending = [];
  let seq = 0;
  let queuedBytes = 0;
  let draining = false;
  let closed = false;
  let blockedSince = 0;
  let blockedMs = 0;
  let windowStart = 0;
  let windowBytes = 0;
  let wakeTimer = null;
  const stats = {
    enqueued: 0,
    sent: 0,
    bytesIn: 0,
    bytesOut: 0,
    reordered: 0,
    coalesced: 0,
    dropped: 0,
    peakQueuedBytes: 0,
    queuedBytes: 0,
    blockedMs: 0,
    maxFrameBytes: 0,
    overflowEvents: 0,
    highFrames: 0,
    lowFrames: 0,
    agedLow: 0,
    pacedEvents: 0
  };
  function snapshot() {
    stats.queuedBytes = queuedBytes;
    stats.blockedMs = blockedMs + (blockedSince ? now() - blockedSince : 0);
    return { ...stats };
  }
  let drainScheduled = false;
  function scheduleDrain() {
    if (drainScheduled || draining || closed) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      void drainLoop();
    });
  }
  function streamBlockedFor(item) {
    if (item.meta.streamId === null) return true;
    for (const other of pending) {
      if (other === item) break;
      if (other.meta.streamId === null) return true;
      if (other.meta.streamId === item.meta.streamId) return true;
    }
    return false;
  }
  function rollWindow(clock) {
    if (clock - windowStart >= lowLaneWindowMs) {
      windowStart = clock;
      windowBytes = 0;
    }
  }
  function scheduleWindowWake() {
    if (wakeTimer !== null || closed) return;
    const wait = Math.max(1, lowLaneWindowMs - (now() - windowStart));
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      scheduleDrain();
    }, wait);
    if (typeof wakeTimer.unref === "function") wakeTimer.unref();
  }
  function pick() {
    if (pending.length === 0) return null;
    if (!allowBypass) return pending.shift();
    const clock = now();
    rollWindow(clock);
    const head = pending[0];
    if (agingGate && head.meta.lane === "low" && clock - head.at >= maxLowLaneWaitMs) {
      pending.shift();
      stats.agedLow += 1;
      return head;
    }
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      if (item.meta.lane !== "high") continue;
      if (streamBlockedFor(item)) continue;
      pending.splice(i, 1);
      if (i > 0) stats.reordered += 1;
      return item;
    }
    if (paceWhenDeep && head.meta.lane === "low" && queuedBytes > deepQueueBytes && windowBytes > 0 && windowBytes + head.meta.bytes > lowLaneWindowBytes) {
      stats.pacedEvents += 1;
      scheduleWindowWake();
      return null;
    }
    return pending.shift();
  }
  async function drainLoop() {
    if (draining || closed) return;
    draining = true;
    try {
      for (; ; ) {
        if (closed) return;
        const item = pick();
        if (!item) return;
        queuedBytes -= item.meta.bytes;
        let encoded;
        try {
          encoded = await encode(item.text, item.opcode);
        } catch (error) {
          stats.dropped += 1;
          onOverflow?.({ reason: "encode-failed", error: String(error?.message ?? error), ...snapshot() });
          continue;
        }
        if (closed) return;
        if (item.meta.bytes > stats.maxFrameBytes) stats.maxFrameBytes = item.meta.bytes;
        stats.bytesOut += encoded.frame.length;
        if (item.meta.lane === "low") windowBytes += item.meta.bytes;
        const accepted = write(encoded.frame);
        stats.sent += 1;
        if (!accepted) {
          blockedSince = now();
          await new Promise((resolve) => {
            const onDrain = () => {
              drainResolve = null;
              resolve();
            };
            drainResolve = onDrain;
          });
          if (blockedSince) {
            blockedMs += now() - blockedSince;
            blockedSince = 0;
          }
        }
      }
    } finally {
      draining = false;
    }
  }
  let drainResolve = null;
  return {
    /** 收一条下行明文消息。 */
    push(text, opcode = 1) {
      if (closed) return;
      const buf = typeof text === "string" ? Buffer.from(text, "utf8") : text;
      const meta = classifyDownlinkMessage(buf);
      meta.lane = meta.bytes <= highBytes ? "high" : "low";
      stats.enqueued += 1;
      stats.bytesIn += meta.bytes;
      if (meta.lane === "high") stats.highFrames += 1;
      else stats.lowFrames += 1;
      const item = { text: buf, opcode, meta, seq: ++seq, at: now() };
      if (meta.coalesceKey) {
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          if (pending[i].meta.coalesceKey === meta.coalesceKey) {
            queuedBytes -= pending[i].meta.bytes;
            pending[i] = { ...item, at: Math.min(pending[i].at, item.at) };
            queuedBytes += meta.bytes;
            stats.coalesced += 1;
            stats.queuedBytes = queuedBytes;
            peak();
            scheduleDrain();
            return;
          }
        }
      }
      if (queuedBytes + meta.bytes > maxQueuedBytes && meta.lane === "low") {
        stats.overflowEvents += 1;
        onOverflow?.({ reason: "queue-overflow", ...snapshot() });
      }
      pending.push(item);
      queuedBytes += meta.bytes;
      stats.queuedBytes = queuedBytes;
      peak();
      scheduleDrain();
    },
    /** socket 'drain' → 继续。 */
    resume() {
      const resolve = drainResolve;
      drainResolve = null;
      resolve?.();
    },
    paused() {
      return drainResolve !== null;
    },
    /** 关掉调度器：清空队列与定时器（被预算挡下的帧不该留一个悬着的唤醒定时器）。 */
    close() {
      closed = true;
      pending = [];
      queuedBytes = 0;
      windowBytes = 0;
      if (wakeTimer !== null) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
    },
    snapshot
  };
  function peak() {
    if (queuedBytes > stats.peakQueuedBytes) stats.peakQueuedBytes = queuedBytes;
  }
}

// src/pocket-host/ws-deflate.mjs
var TAIL = Buffer.from([0, 0, 255, 255]);
var MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
var MAX_QUEUED_BYTES = 32 * 1024 * 1024;
var MIN_COMPRESS_BYTES = 128;
var WsFrameParser = class {
  constructor(onFrame, onError) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onError = onError ?? (() => {
    });
    this.fragmentOpcode = 0;
    this.fragmentRsv1 = false;
    this.fragmentPayloads = [];
  }
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (; ; ) {
      const b = this.buf;
      if (b.length < 2) return;
      const b0 = b[0];
      const b1 = b[1];
      const fin = (b0 & 128) !== 0;
      const rsv1 = (b0 & 64) !== 0;
      const opcode = b0 & 15;
      const masked = (b1 & 128) !== 0;
      let len = b1 & 127;
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
      if (opcode === 0) {
        if (this.fragmentOpcode === 0) continue;
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
      if (!fin && (opcode === 1 || opcode === 2)) {
        this.fragmentOpcode = opcode;
        this.fragmentRsv1 = rsv1;
        this.fragmentPayloads = [payload];
        continue;
      }
      this.onFrame({ fin, rsv1, opcode, payload });
    }
  }
};
function encodeFrame({ fin = true, rsv1 = false, opcode = 1, payload = Buffer.alloc(0), clientMask = false }) {
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
  header[0] = (fin ? 128 : 0) | (rsv1 ? 64 : 0) | opcode & 15;
  if (!clientMask) return Buffer.concat([header, payload]);
  header[1] |= 128;
  const mask = Buffer.from([17, 34, 51, 68]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
var DeflateQueue = class {
  constructor(onError) {
    this.chunks = [];
    this.queue = [];
    this.busy = false;
    this.failed = false;
    this.onError = onError;
    this.stream = createDeflateRaw({ level: 6, windowBits: 15, memLevel: 8 });
    this.stream.on("data", (c) => this.chunks.push(c));
    this.stream.on("error", (e) => this._fail(e));
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
      const item2 = this.queue.shift();
      item2.cb(item2.payload);
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
    try {
      this.stream.close();
    } catch {
    }
  }
};
var InflateQueue = class {
  constructor(onError) {
    this.chunks = [];
    this.queue = [];
    this.busy = false;
    this.failed = false;
    this.onError = onError;
    this.stream = createInflateRaw({ windowBits: 15 });
    this.stream.on("data", (c) => this.chunks.push(c));
    this.stream.on("error", (e) => this._fail(e));
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
      const item2 = this.queue.shift();
      item2.cb(item2.payload);
      if (this.failed) return;
    }
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    this.chunks = [];
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
    try {
      this.stream.close();
    } catch {
    }
  }
};
function negotiatePermessageDeflate(headerValue) {
  const offer = String(headerValue ?? "");
  if (offer === "") return null;
  for (const part of offer.split(",")) {
    const [name2, ...params] = part.split(";").map((s) => s.trim());
    if (name2.toLowerCase() !== "permessage-deflate") continue;
    const unsupported = params.find((p) => {
      const k = p.split("=")[0].trim().toLowerCase();
      return k !== "client_max_window_bits";
    });
    if (unsupported) continue;
    return "permessage-deflate";
  }
  return null;
}
function attachWsDeflate({ client, upstream, onError = null, onFailure = null }) {
  const stats = { downIn: 0, downOut: 0, upIn: 0, upOut: 0, messages: 0, failures: 0 };
  let closed = false;
  const fail2 = (err) => {
    if (closed) return;
    closed = true;
    stats.failures += 1;
    try {
      onError?.(err);
    } catch {
    }
    try {
      onFailure?.();
    } catch {
    }
    try {
      client.destroy();
    } catch {
    }
    try {
      upstream.destroy();
    } catch {
    }
  };
  const deflate = new DeflateQueue(fail2);
  const inflate = new InflateQueue(fail2);
  const downlink = createDownlinkScheduler({
    encode: (text, op) => new Promise((resolve, reject) => {
      if (text.length < MIN_COMPRESS_BYTES) {
        stats.downOut += text.length;
        resolve({ frame: encodeFrame({ fin: true, opcode: op, payload: text }), raw: true });
        return;
      }
      deflate.push(text, {}, (packed) => {
        if (closed) {
          reject(new Error("ws-deflate: closed"));
          return;
        }
        let out = packed;
        let rsv1 = true;
        if (packed.length >= text.length) {
          out = text;
          rsv1 = false;
        }
        stats.downOut += out.length;
        resolve({ frame: encodeFrame({ fin: true, rsv1, opcode: op, payload: out }) });
      });
    }),
    write: (frame) => {
      try {
        return client.write(frame);
      } catch (error) {
        fail2(error);
        return true;
      }
    }
  });
  client.on("drain", () => {
    downlink.resume();
  });
  let downParts = [];
  let downOpcode = 1;
  let downSize = 0;
  const downParser = new WsFrameParser((frame) => {
    if (closed) return;
    const { fin, opcode, payload } = frame;
    if (opcode >= 8) {
      try {
        client.write(encodeFrame({ fin: true, opcode, payload }));
      } catch (e) {
        fail2(e);
      }
      return;
    }
    downOpcode = opcode === 0 ? downOpcode : opcode;
    downParts.push(payload);
    downSize += payload.length;
    if (!fin) {
      if (downSize > MAX_QUEUED_BYTES) fail2(new Error("ws-deflate: upstream message too large"));
      return;
    }
    const whole = downParts.length === 1 ? downParts[0] : Buffer.concat(downParts);
    downParts = [];
    downSize = 0;
    stats.downIn += whole.length;
    stats.messages += 1;
    const op = downOpcode;
    downlink.push(whole, op);
  }, fail2);
  let upParts = [];
  let upOpcode = 1;
  let upCompressed = false;
  const upParser = new WsFrameParser((frame) => {
    if (closed) return;
    const { fin, rsv1, opcode, payload } = frame;
    if (opcode >= 8) {
      try {
        upstream.write(encodeFrame({ fin: true, opcode, payload, clientMask: true }));
      } catch (e) {
        fail2(e);
      }
      return;
    }
    upOpcode = opcode === 0 ? upOpcode : opcode;
    if (opcode !== 0) {
      upParts = [];
      upCompressed = false;
    }
    if (rsv1) upCompressed = true;
    upParts.push(payload);
    if (!fin) {
      if (upParts.reduce((n, b) => n + b.length, 0) > MAX_QUEUED_BYTES) fail2(new Error("ws-deflate: client message too large"));
      return;
    }
    const whole = upParts.length === 1 ? upParts[0] : Buffer.concat(upParts);
    upParts = [];
    const op = upOpcode;
    const writePlain = () => {
      if (closed) return;
      stats.upIn += whole.length;
      try {
        upstream.write(encodeFrame({ fin: true, opcode: op, payload: whole, clientMask: true }));
      } catch (e) {
        fail2(e);
      }
    };
    if (!upCompressed) {
      inflate.push(whole, { raw: true }, writePlain);
      return;
    }
    inflate.push(whole, {}, (out) => {
      if (closed) return;
      stats.upIn += out.length;
      try {
        upstream.write(encodeFrame({ fin: true, opcode: op, payload: out, clientMask: true }));
      } catch (e) {
        fail2(e);
      }
    });
  }, fail2);
  const onClientData = (chunk) => upParser.push(chunk);
  const onUpstreamData = (chunk) => downParser.push(chunk);
  client.on("data", onClientData);
  upstream.on("data", onUpstreamData);
  return {
    close() {
      closed = true;
      client.off("data", onClientData);
      upstream.off("data", onUpstreamData);
      try {
        downlink.close();
      } catch {
      }
      deflate.close();
      inflate.close();
    },
    stats: () => ({ ...stats, queue: downlink.snapshot() })
  };
}

// src/pocket-host/mobile-boot.mjs
var MOBILE_OMITTABLE_MODULES = Object.freeze([
  "@deepseek-ai/dsh-client-ui-open-in-app",
  "@deepseek-ai/dsh-client-ui-directory-picker-native",
  "@deepseek-ai/dsh-client-product-analytics",
  "@deepseek-ai/dsh-client-hmr"
]);
var BOOT_SCRIPT_RE = /<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/;
var MODULE_BATCH_WEIGHT = {
  "dsh-assistant": 663932,
  "@deepseek-ai/dsh-api-remotes": 146543,
  "@deepseek-ai/dsh-client-ui-conversation": 239869,
  "@deepseek-ai/dsh-client-ui-plugin-manager": 258e3,
  "@deepseek-ai/dsh-client-ui-chat": 189809,
  "@deepseek-ai/dsh-cordis-client-runner": 78041,
  "@deepseek-ai/dsh-client-ui-trajectory": 11640,
  "@deepseek-ai/dsh-client-ui-sidebar-documentpreview": 18e3,
  "@deepseek-ai/dsh-client-ui-workspace": 26078,
  "@deepseek-ai/dsh-client-ui-tool": 13706,
  "@deepseek-ai/dsh-client-ui-sidebar-right": 12154,
  "@deepseek-ai/dsh-api-session-controller": 51123,
  "@deepseek-ai/dsh-client-ui-input-trigger": 64775,
  "@deepseek-ai/dsh-client-ui-cordis": 54310,
  "@deepseek-ai/dsh-client-ui-skill": 26078,
  "@deepseek-ai/dsh-client-shortcuts": 32780,
  "@deepseek-ai/dsh-client-ui-shortcuts": 20580
};
var moduleWeight = (id) => MODULE_BATCH_WEIGHT[id] ?? 1e4;
var MOBILE_BATCH_COUNT = 3;
function optimizeMobileBoot(html, { omittable = MOBILE_OMITTABLE_MODULES, createBatch = null } = {}) {
  const match = BOOT_SCRIPT_RE.exec(String(html));
  if (!match) return { html: String(html), omitted: [], changed: false };
  let graph;
  try {
    graph = JSON.parse(match[1]);
  } catch {
    return { html: String(html), omitted: [], changed: false };
  }
  if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) {
    return { html: String(html), omitted: [], changed: false };
  }
  const present = new Set(graph.entries.map((row) => row.id));
  const omitted = new Set([...omittable].filter((id) => present.has(id)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of graph.entries) {
      if (omitted.has(row.id)) continue;
      for (const dependency of [...row.external ?? [], ...row.inject ?? []]) {
        const id = dependency.endsWith("/client") ? dependency.slice(0, -"/client".length) : dependency;
        if (omitted.delete(id)) changed = true;
      }
    }
  }
  if (omitted.size === 0) return { html: String(html), omitted: [], changed: false };
  graph.entries = graph.entries.filter((row) => !omitted.has(row.id));
  const bootstrapIds = new Set(graph.batches.filter((batch) => batch.phase === "bootstrap").flatMap((batch) => batch.entries ?? []));
  const applicationEntries = graph.entries.filter((row) => !bootstrapIds.has(row.id));
  let applicationBatches;
  if (typeof createBatch === "function") {
    const chunks = Array.from({ length: MOBILE_BATCH_COUNT }, () => ({ rows: [], weight: 0 }));
    const order = new Map(applicationEntries.map((row, index) => [row.id, index]));
    const sorted = [...applicationEntries].sort((a, b) => moduleWeight(b.id) - moduleWeight(a.id));
    for (const row of sorted) {
      const target = chunks.reduce((best, current) => current.weight < best.weight ? current : best, chunks[0]);
      target.rows.push(row);
      target.weight += moduleWeight(row.id);
    }
    applicationBatches = chunks.filter((chunk) => chunk.rows.length > 0).map((chunk, index) => {
      const rows = chunk.rows.sort((a, b) => order.get(a.id) - order.get(b.id));
      return {
        phase: "application",
        entries: rows.map((row) => row.id),
        url: createBatch(rows, index),
        rev: `${graph.rev}.${index}`
      };
    });
  } else {
    applicationBatches = applicationEntries.map((row) => ({
      phase: "application",
      entries: [row.id],
      url: row.url,
      rev: row.rev
    }));
  }
  graph.batches = [
    ...graph.batches.filter((batch) => batch.phase === "bootstrap"),
    ...applicationBatches
  ];
  const escapeAttr = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const preloads = graph.batches.filter((batch) => batch.phase === "application").map((batch) => `<link rel="preload" as="script" href="${escapeAttr(batch.url)}">`).join("");
  const dropOldPreloads = (text) => text.replace(/<link\b[^>]*\brel="preload"[^>]*>/gi, (tag) => {
    const href = /\bhref="([^"]+)"/i.exec(tag)?.[1];
    return href?.includes("plugins/??") ? "" : tag;
  });
  const out = dropOldPreloads(String(html).slice(0, match.index)) + preloads + `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph).replaceAll("<", "\\u003c")}</script>` + dropOldPreloads(String(html).slice(match.index + match[0].length));
  return { html: out, omitted: [...omitted], changed: true };
}

// src/pocket-host/mobile-batch.mjs
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { gzip, brotliCompress, constants as zlibConstants2 } from "node:zlib";
var PREFIX = "/dsh-pocket-mobile-batch/";
var SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/;
var MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
function gzipAsync(body) {
  return new Promise((resolve, reject) => gzip(body, { level: 6 }, (err, out) => err ? reject(err) : resolve(out)));
}
function brotliAsync(body) {
  return new Promise((resolve, reject) => brotliCompress(body, {
    params: { [zlibConstants2.BROTLI_PARAM_QUALITY]: 6 }
  }, (err, out) => err ? reject(err) : resolve(out)));
}
function createMobileBatchStore({ upstream, rewriteHeaders, log = null }) {
  const definitions = /* @__PURE__ */ new Map();
  const register = (entries) => {
    const signature = JSON.stringify(entries.map((row) => [row.id, row.url, row.rev]));
    const key = createHash("sha256").update(signature).digest("hex").slice(0, 24);
    if (!definitions.has(key)) {
      definitions.set(key, { entries: entries.map((row) => ({ id: row.id, url: row.url, rev: row.rev })) });
      while (definitions.size > 8) definitions.delete(definitions.keys().next().value);
    }
    return `dsh-pocket-mobile-batch/${key}.js`;
  };
  const fetchEntry = (req, entry) => new Promise((resolve, reject) => {
    if (!String(entry.url).startsWith("plugins/??")) {
      reject(new Error(`invalid module url for ${entry.id}`));
      return;
    }
    const headers = rewriteHeaders({ ...req.headers, accept: "application/javascript", "accept-encoding": "identity" }, upstream);
    const call = httpRequest({ host: upstream.host, port: upstream.port, method: "GET", path: `/${entry.url}`, headers, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else call.destroy(new Error(`module too large: ${entry.id}`));
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`${entry.id}: HTTP ${res.statusCode}`));
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8").replace(SOURCE_MAP_TRAILER, "");
        resolve(Buffer.from(text, "utf8"));
      });
      res.on("error", reject);
    });
    call.setTimeout(15e3, () => call.destroy(new Error(`module timeout: ${entry.id}`)));
    call.on("error", reject);
    call.end();
  });
  const build = (req, definition) => {
    if (!definition.promise) {
      definition.promise = (async () => {
        const parts = await Promise.all(definition.entries.map((entry) => fetchEntry(req, entry)));
        const identity = Buffer.concat(parts.map((part) => Buffer.concat([part, Buffer.from("\n")])));
        const [gz, br] = await Promise.all([gzipAsync(identity), brotliAsync(identity)]);
        return { identity, gzip: gz, br };
      })().catch((err) => {
        definition.promise = null;
        throw err;
      });
    }
    return definition.promise;
  };
  const handle = (req, res) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "/", "http://pocket.invalid").pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith(PREFIX)) return false;
    const key = pathname.slice(PREFIX.length).replace(/\.js$/, "");
    const definition = definitions.get(key);
    if (!definition) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("mobile batch not found");
      return true;
    }
    void build(req, definition).then((bodies) => {
      const acceptEncoding = String(req.headers["accept-encoding"] ?? "");
      const encoding = /\bbr\b/.test(acceptEncoding) ? "br" : /\bgzip\b/.test(acceptEncoding) ? "gzip" : "identity";
      const body = bodies[encoding];
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-length": String(body.length),
        "content-encoding": encoding,
        "cache-control": "private, max-age=31536000, immutable",
        "x-dsh-pocket-mobile-batch": String(definition.entries.length),
        ...encoding === "identity" ? {} : { vary: "Accept-Encoding" }
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    }).catch((err) => {
      log?.(`dsh-pocket: mobile batch failed: ${err?.message ?? err}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(`mobile batch failed: ${err?.message ?? err}`);
    });
    return true;
  };
  return { register, handle };
}

// src/pocket-host/proxy.mjs
var DEFAULT_UPSTREAM = { host: "127.0.0.1", port: 3080 };
var RANDOM_UUID_POLYFILL = `<script data-dsh-pocket-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();
!function(){try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(signals){var controller=new AbortController();var list=Array.from(signals||[]);var done=false;var handlers=list.map(function(signal){return function(){abort(signal);};});function cleanup(){for(var i=0;i<list.length;i++){try{list[i].removeEventListener('abort',handlers[i]);}catch(e){}}}function abort(signal){if(done)return;done=true;cleanup();try{controller.abort(signal.reason);}catch(e){controller.abort();}}for(var j=0;j<list.length;j++){var sig=list[j];if(sig.aborted){abort(sig);break;}sig.addEventListener('abort',handlers[j],{once:true});}return controller.signal;};}}catch(e){}}();
/* \u6CE8\uFF1A\u66FE\u7528\u300C\u5168\u5C40 let location + Proxy\u300D\u4F2A\u88C5 location.hostname \u4FEE DSH isLoopback \u5224\u5B9A
\uFF08issue #58\uFF1A\u5C40\u57DF\u7F51\u8BBF\u95EE\u6A21\u578B\u8BBE\u7F6E\u9875\u62A5 settings unavailable\uFF09\u2014\u2014\u4F46 let location \u5168\u5C40
\u8BCD\u6CD5\u7ED1\u5B9A\u4F1A\u8BA9\u4EFB\u4F55\u6070\u597D\u9876\u5C42\u58F0\u660E location \u7684\u811A\u672C\uFF08DSH \u63D2\u4EF6\u7ECF\u5178 script\uFF09SyntaxError \u5D29\u6E83\uFF0C
\u5BFC\u81F4\u4F1A\u8BDD\u5217\u8868\u4E0D\u663E\u793A\uFF08\u5B9E\u6D4B PAGEERROR: Identifier 'location' has already been declared\uFF09\u3002
\u5DF2\u56DE\u9000\uFF1B\u8BE5\u95EE\u9898\u5C5E DSH \u5BA2\u6237\u7AEF\u9650\u5236\uFF08location.hostname \u662F unforgeable \u5C5E\u6027\uFF09\u65E0\u6CD5\u5B89\u5168\u7ED5\u8FC7\u3002*/</script>`;
var TRANSPORT_API_CLIENT_SHIM = `<script data-dsh-pocket-transport-shim="1">!function(){try{var K='__DSH_TRANSPORT__',cur=globalThis[K];function patch(t){try{if(t&&typeof t==='object'&&typeof t.createApiClient!=='function'){try{Object.defineProperty(t,'createApiClient',{value:function(){return null;},writable:true,configurable:true});}catch(e){try{t.createApiClient=function(){return null;};}catch(e2){}}}}catch(e){}return t;}if(cur)patch(cur);Object.defineProperty(globalThis,K,{configurable:true,enumerable:true,get:function(){return cur;},set:function(t){cur=patch(t);}});}catch(e){}}();</script>`;
var INJECT_MARK = 'data-dsh-pocket-polyfill="1"';
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers["content-encoding"] ?? ""));
}
var HASHED_ASSET_RE = /\/(?:assets|static)\/[^/?#]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf)$/;
function staticCacheHeaders(reqUrl, headers) {
  if (!headers || typeof headers !== "object") return headers;
  if (headers["cache-control"]) return headers;
  const pathOnly = String(reqUrl ?? "").split(/[?#]/)[0];
  if (!HASHED_ASSET_RE.test(pathOnly)) return headers;
  return { ...headers, "cache-control": "public, max-age=31536000, immutable" };
}
var WS_DEFLATE_BREAKER_THRESHOLD = 2;
var WS_DEFLATE_COOLDOWN_MS = 10 * 60 * 1e3;
var wsDeflateBreaker = { failures: 0, until: 0 };
function wsDeflateAllowed() {
  return Date.now() >= wsDeflateBreaker.until;
}
function noteWsDeflateFailure() {
  wsDeflateBreaker.failures += 1;
  if (wsDeflateBreaker.failures >= WS_DEFLATE_BREAKER_THRESHOLD) {
    wsDeflateBreaker.failures = 0;
    wsDeflateBreaker.until = Date.now() + WS_DEFLATE_COOLDOWN_MS;
  }
}
var DEFAULT_INJECT = RANDOM_UUID_POLYFILL + TRANSPORT_API_CLIENT_SHIM;
function advancedNoticeScript() {
  return `<script data-dsh-pocket-advanced-notice="1">!function(){try{var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px';d.textContent='DSH \u684C\u9762\u7AEF\u5904\u4E8E advanced \u6A21\u5F0F\uFF0C\u624B\u673A\u8BBF\u95EE\u6682\u4E0D\u652F\u6301\u3002\u8BF7\u5728\u684C\u9762\u7AEF\u8BBE\u7F6E\u4E2D\u5207\u56DE compatibility \u6A21\u5F0F\u540E\u91CD\u542F\u3002| DSH Desktop is in advanced mode \u2014 phone access is not supported yet. Switch back to compatibility in the desktop app and restart.';document.documentElement.appendChild(d);}catch(e){}}();</script>`;
}
var TOKEN_COOKIE = "dsh_pocket_token";
var COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
function cookieFor(token, sessionKey) {
  if (!sessionKey) return token;
  return createHash2("sha256").update(`${token}:${sessionKey}`).digest("hex");
}
var DEFAULT_RATE_LIMIT = {
  windowMs: 6e4,
  // 失败计数滑动窗口
  maxFailures: 5,
  // 窗口内失败阈值 → 触发单 IP 锁
  lockMs: 6e4,
  // 单 IP 锁定时长
  globalMaxFailures: 50,
  // 全局失败阈值（同窗口）→ 触发全局锁
  globalLockMs: 3e4
  // 全局锁定时长
};
function createRateLimiter(cfg = {}) {
  const c = { ...DEFAULT_RATE_LIMIT, ...cfg };
  const failCounts = /* @__PURE__ */ new Map();
  const ipLocks = /* @__PURE__ */ new Map();
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };
  return {
    /** 该 IP 当前是否被锁；返回 { locked, retryAfter }。 */
    status(ip) {
      const now = Date.now();
      if (global.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1e3) };
      const until = ipLocks.get(ip) ?? 0;
      if (until > now) return { locked: true, retryAfter: Math.ceil((until - now) / 1e3) };
      return { locked: false, retryAfter: 0 };
    },
    /** 记一次失败：维护滑动窗口计数，达阈值触发单 IP / 全局锁。 */
    record(ip) {
      const now = Date.now();
      let rec = failCounts.get(ip);
      if (!rec || now - rec.windowStart > c.windowMs) rec = { count: 0, windowStart: now };
      rec.count++;
      failCounts.set(ip, rec);
      if (now - global.windowStart > c.windowMs) {
        global.count = 0;
        global.windowStart = now;
      }
      global.count++;
      if (rec.count >= c.maxFailures) ipLocks.set(ip, now + c.lockMs);
      if (global.count >= c.globalMaxFailures) global.lockedUntil = now + c.globalLockMs;
      if (failCounts.size > 2e3) {
        for (const [k, v] of failCounts) {
          if (now - v.windowStart > c.windowMs) failCounts.delete(k);
        }
      }
    },
    /** 成功登录：清空该 IP 计数与锁。 */
    clear(ip) {
      failCounts.delete(ip);
      ipLocks.delete(ip);
    }
  };
}
function clientIp(req) {
  const addr = String(req.socket?.remoteAddress ?? "");
  if (classifySource(addr) === "loopback") {
    const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
    if (cf) return cf;
  }
  return addr || "unknown";
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
function carryAttr(carry) {
  const text = String(carry ?? "");
  if (!text) return "";
  return `?${text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}`;
}
function loginPageHtml(error, isPublic, retryAfter = 0, carry = "") {
  const where = isPublic ? "\u6B64\u516C\u7F51\u5730\u5740" : "\u6B64\u5C40\u57DF\u7F51\u5730\u5740";
  const whereEn = isPublic ? "This public address" : "This LAN address";
  const errMsg = error === "locked" ? `\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7 ${retryAfter} \u79D2\u540E\u518D\u8BD5 | Too many attempts \u2014 try again in ${retryAfter}s` : error ? "\u5BC6\u7801\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5 | Wrong PIN, try again" : "";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket \xB7 \u8BBF\u95EE\u9A8C\u8BC1</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:320px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 4px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:18px;letter-spacing:6px;text-align:center;border:1px solid #d1d5db;border-radius:8px;outline:none;margin-bottom:12px}
input:focus{border-color:#4f6ef7}
button{width:100%;padding:10px;font-size:15px;background:#4f6ef7;color:#fff;border:none;border-radius:8px;cursor:pointer}
.err{color:#dc2626;font-size:12px;margin-bottom:10px;min-height:16px}
</style></head><body><div class="card">
<h1>\u{1F510} DSH Pocket</h1>
<p>${where}\u53D7\u8BBF\u95EE\u5BC6\u7801\u4FDD\u62A4\uFF0C\u8BF7\u8F93\u5165 8 \u4F4D\u5BC6\u7801\uFF08\u82F1\u6587\u5B57\u6BCD\u6216\u6570\u5B57\uFF09 | ${whereEn} is password-protected \u2014 enter the 8-character PIN (letters/digits)</p>
<div class="err">${errMsg}</div>
<form method="post" action="/pocket-login${carryAttr(carry)}">
<input name="token" type="password" maxlength="8" autocomplete="one-time-code" autofocus required>
<button type="submit">\u8FDB\u5165 | Enter</button>
</form>
</div></body></html>`;
}
function classifyHost(host) {
  let name2 = String(host ?? "").trim().toLowerCase();
  if (name2.startsWith("[")) {
    const end = name2.indexOf("]");
    if (end >= 0) name2 = name2.slice(1, end);
  } else {
    name2 = name2.replace(/:\d+$/, "");
  }
  if (name2 === "localhost" || name2 === "0.0.0.0" || name2 === "::1" || /^127\./.test(name2)) return "loopback";
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(name2)) return "lan";
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(name2) && name2.includes(":")) return "lan";
  if (name2 === "" || name2.includes(":")) return "loopback";
  if (name2.endsWith(".local") || !name2.includes(".")) return "lan";
  return "public";
}
function isProtectedHost(host, isProtected) {
  return isProtected ? isProtected(host) : classifyHost(host) === "public";
}
var HOST_CLASS_RANK = { loopback: 0, lan: 1, public: 2 };
function classifySource(addr) {
  let a = String(addr ?? "").trim().toLowerCase();
  if (!a) return null;
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1" || /^127\./.test(a)) return "loopback";
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(a)) return "lan";
  if (/^169\.254\./.test(a)) return "lan";
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(a)) return "lan";
  return "public";
}
function policyHost(req, host) {
  const actual = classifySource(req?.socket?.remoteAddress);
  if (!actual) return host;
  const claimed = classifyHost(host);
  if (HOST_CLASS_RANK[actual] <= HOST_CLASS_RANK[claimed]) return host;
  let addr = String(req.socket.remoteAddress);
  if (addr.toLowerCase().startsWith("::ffff:")) addr = addr.slice(7);
  return addr;
}
function isLoopbackHost(host) {
  let name2 = String(host ?? "").trim().toLowerCase();
  if (name2.startsWith("[")) {
    const end = name2.indexOf("]");
    if (end >= 0) name2 = name2.slice(1, end);
  } else {
    name2 = name2.replace(/:\d+$/, "");
  }
  return name2 === "localhost" || name2 === "127.0.0.1" || name2 === "::1" || name2 === "0.0.0.0";
}
function lanDisabledPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket \xB7 \u5C40\u57DF\u7F51\u8BBF\u95EE\u5DF2\u5173\u95ED</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:360px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0;line-height:1.6}
</style></head><body><div class="card">
<h1>\u{1F512} DSH Pocket</h1>
<p>\u5C40\u57DF\u7F51\u8BBF\u95EE\u5DF2\u5173\u95ED\uFF0C\u626B\u7801/\u94FE\u63A5\u5747\u4E0D\u53EF\u7528\u3002<br>\u8BF7\u5728\u7535\u8111\u4E0A\u91CD\u65B0\u5F00\u542F\u540E\u518D\u8BD5\u3002<br><br>LAN access is disabled \u2014 the QR code and link are unavailable.<br>Re-enable it on the computer to continue.</p>
</div></body></html>`;
}
function desktopAccessBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket \xB7 \u684C\u9762\u7AEF\u672A\u5F00\u542F\u6D4F\u89C8\u5668\u8BBF\u95EE</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:392px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.6}
code{background:#f3f4f6;padding:2px 6px;border-radius:6px;font-size:12px;color:#374151}
.step{text-align:left;background:#f9fafb;border:1px solid #eef2f7;border-radius:10px;padding:12px 14px;margin-top:8px;font-size:12px;color:#4b5563;line-height:1.8}
</style></head><body><div class="card">
<h1>\u{1F5A5}\uFE0F DSH Pocket</h1>
<p>\u4F60\u5DF2\u901A\u8FC7\u8BBF\u95EE\u5BC6\u7801\uFF0C\u4F46\u9875\u9762\u4ECD\u88AB\u62E6\u622A\u3002<br>\u56E0\u4E3A\u672C\u673A DSH Desktop \u672A\u5F00\u542F\u300C\u6D4F\u89C8\u5668\u8BBF\u95EE\u300D\uFF0C\u684C\u9762\u95E8\u7981\u62D2\u7EDD\u4E86\u666E\u901A\u6D4F\u89C8\u5668\uFF08\u542B\u624B\u673A\uFF09\u7684\u9875\u9762\u8BF7\u6C42\u3002</p>
<div class="step">
<strong>\u89E3\u51B3\u65B9\u6CD5\uFF08\u4EFB\u9009\u5176\u4E00\uFF09\uFF1A</strong><br>
1. DSH Desktop \u2192 \u8BBE\u7F6E \u2192 \u7A97\u53E3 / \u6A21\u5F0F \u2192 \u5F00\u542F\u300C\u6D4F\u89C8\u5668\u8BBF\u95EE\u300D\uFF08\u81EA\u52A8\u5207\u5230 compatibility \u6A21\u5F0F\uFF09\u2192 <strong>\u91CD\u542F DSH Desktop</strong>\u3002<br>
2. \u6216\u5728\u914D\u7F6E\u6587\u4EF6\u4E2D\u8BBE\u7F6E\uFF1A<br>
<code>dsh-desktop: { mode: compatibility, openBrowser: true }</code><br>
\u7136\u540E\u91CD\u542F DSH Desktop\uFF0C\u518D\u5237\u65B0\u672C\u9875\u3002
</div>
<p style="margin-top:14px">\u6CE8\u610F\uFF1A\u8BBF\u95EE\u5BC6\u7801\u767B\u5F55\u6210\u529F \u2260 \u5DF2\u83B7\u5F97\u684C\u9762 Web \u8BBF\u95EE\u6388\u6743\u3002\u95E8\u7981\u7531 DSH Desktop \u63A7\u5236\uFF0Cpocket \u65E0\u6CD5\u4EE3\u4E3A\u7ED5\u8FC7\u3002</p>
<p style="color:#9ca3af">The host DSH Desktop has "browser access" disabled. Enable it (Settings \u2192 window/mode \u2192 browser access \u2192 restart), or set <code>dsh-desktop.mode: compatibility, openBrowser: true</code>, then refresh.</p>
</div></body></html>`;
}
function isHtmlRequest(req) {
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("text/html")) return true;
  const url = String(req.url ?? "");
  let pathname = url;
  try {
    pathname = new URL(url || "/", "http://dsh.invalid").pathname;
  } catch {
  }
  return pathname === "/" || /\.html?$/i.test(pathname);
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
function hasQueryToken(req) {
  try {
    return new URL(req.url ?? "/", "http://x").searchParams.get("token") != null;
  } catch {
    return false;
  }
}
function authCheck(req, tokens, sessionKey) {
  const list = (Array.isArray(tokens) ? tokens : tokens ? [tokens] : []).filter(Boolean);
  if (list.length === 0) return { ok: true, rawQueryToken: null };
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies[TOKEN_COOKIE];
  if (cookieTok) {
    for (const token of list) {
      if (safeEqual(cookieTok, cookieFor(token, sessionKey))) return { ok: true, rawQueryToken: null };
    }
  }
  const qTok = new URL(req.url ?? "/", "http://x").searchParams.get("token");
  if (qTok) {
    for (const token of list) {
      if (safeEqual(qTok, token)) return { ok: true, rawQueryToken: qTok };
    }
  }
  return { ok: false, rawQueryToken: null };
}
function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
  if (!rawToken || !sessionKey) return;
  const expected = cookieFor(rawToken, sessionKey);
  if (!expected) return;
  const existing = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
  if (existing && safeEqual(existing, expected)) return;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function(statusCode, headers) {
    const h = { ...headers ?? {} };
    const cookie = `${TOKEN_COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
    const prev = h["set-cookie"];
    if (Array.isArray(prev)) h["set-cookie"] = [...prev, cookie];
    else if (typeof prev === "string") h["set-cookie"] = [prev, cookie];
    else h["set-cookie"] = cookie;
    return origWriteHead(statusCode, h);
  };
}
function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "origin" || lk === "referer" || lk === "sec-fetch-site") continue;
    out[lk] = v;
  }
  out.host = authority;
  out.origin = `http://${authority}`;
  const referer = headers.referer ?? headers.Referer;
  if (referer) {
    try {
      const ref = new URL(referer);
      ref.protocol = "http:";
      ref.host = authority;
      out.referer = ref.toString();
    } catch {
      out.referer = `http://${authority}/`;
    }
  }
  out["sec-fetch-site"] = "same-origin";
  return out;
}
var DSH_AUTH_COOKIE = "dsh-auth-";
function stripDesktopMarkers(reqUrl) {
  let u;
  try {
    u = new URL(reqUrl ?? "/", "http://dsh.invalid");
  } catch {
    return reqUrl;
  }
  const doomed = [...u.searchParams.keys()].filter((k) => k.startsWith("dsh-desktop-"));
  if (doomed.length === 0) return reqUrl;
  for (const key of doomed) u.searchParams.delete(key);
  return `${u.pathname}${u.search}`;
}
function upstreamPathWithLaunchToken(reqUrl, method, cookieHeader, launchToken) {
  if (method !== "GET") return reqUrl;
  let u;
  try {
    u = new URL(reqUrl ?? "/", "http://dsh.invalid");
  } catch {
    return reqUrl;
  }
  if (u.pathname !== "/") return reqUrl;
  const force = u.searchParams.has("dsh-pocket-auth");
  if (!force && String(cookieHeader ?? "").includes(DSH_AUTH_COOKIE)) return reqUrl;
  if (!launchToken) return reqUrl;
  u.searchParams.set("token", launchToken);
  return `${u.pathname}${u.search}`;
}
var DEFAULT_HANDSHAKE_LIMIT = 3;
var HANDSHAKE_WINDOW_MS = 6e4;
var HANDSHAKE_RETRY_PARAM = "dsh-pocket-retry";
function stripQueryParam(reqUrl, name2) {
  let u;
  try {
    u = new URL(reqUrl ?? "/", "http://dsh.invalid");
  } catch {
    return reqUrl;
  }
  if (!u.searchParams.has(name2)) return reqUrl;
  u.searchParams.delete(name2);
  return `${u.pathname}${u.search}`;
}
var LOGIN_DROP_PARAMS = ["token", "dsh-pocket-auth", "dsh-pocket-retry"];
var LOGIN_CARRY_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
var LOGIN_CARRY_SENSITIVE_RE = /(token|password|passwd|secret|cookie|authorization|apikey|api_key)/i;
var LOGIN_CARRY_MAX_PARAMS = 8;
var LOGIN_CARRY_VALUE_MAX = 120;
function carryKeyAllowed(key) {
  const name2 = String(key ?? "");
  if (!LOGIN_CARRY_KEY_RE.test(name2)) return false;
  const lower = name2.toLowerCase();
  if (LOGIN_DROP_PARAMS.includes(lower)) return false;
  if (lower.startsWith("dsh-desktop-")) return false;
  if (LOGIN_CARRY_SENSITIVE_RE.test(lower)) return false;
  return true;
}
function carryParams(rawUrl, into) {
  if (!rawUrl) return;
  let u;
  try {
    u = new URL(String(rawUrl), "http://dsh.invalid");
  } catch {
    return;
  }
  for (const [key, value] of u.searchParams) {
    if (!carryKeyAllowed(key)) continue;
    if (into.has(key)) continue;
    if (into.size >= LOGIN_CARRY_MAX_PARAMS) break;
    into.append(key, String(value).slice(0, LOGIN_CARRY_VALUE_MAX));
  }
}
function loginCarryQuery(reqUrl) {
  const sp = new URLSearchParams();
  carryParams(reqUrl, sp);
  return sp.toString();
}
function postLoginRedirectLocation(postUrl, referer = "") {
  const sp = new URLSearchParams();
  carryParams(postUrl, sp);
  carryParams(referer, sp);
  sp.set("dsh-pocket-auth", "1");
  const qs = sp.toString();
  return qs ? `/?${qs}` : "/?dsh-pocket-auth=1";
}
function createHandshakeTracker({ max = DEFAULT_HANDSHAKE_LIMIT, windowMs = HANDSHAKE_WINDOW_MS } = {}) {
  const hits = /* @__PURE__ */ new Map();
  return {
    /** 记一次握手注入，返回窗口内的累计次数。 */
    record(ip, now = Date.now()) {
      const rec = hits.get(ip);
      if (!rec || now - rec.start > windowMs) {
        hits.set(ip, { count: 1, start: now });
        return 1;
      }
      rec.count += 1;
      return rec.count;
    },
    /** 握手成功（拿到会话 cookie 的请求）→ 清零。 */
    clear(ip) {
      hits.delete(ip);
    },
    /** 该 IP 是否已达重试上限。 */
    exhausted(ip) {
      const rec = hits.get(ip);
      return !!rec && rec.count >= max;
    },
    /** 清理过期条目，防长期运行内存膨胀。 */
    prune(now = Date.now()) {
      for (const [ip, rec] of hits) {
        if (now - rec.start > windowMs) hits.delete(ip);
      }
    }
  };
}
function handshakePageHtml(carry = "") {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=/${carryAttr(carry)}">
<title>DSH Pocket \xB7 \u6B63\u5728\u8FDB\u5165 | opening\u2026</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
p{font-size:13px;color:#6b7280;margin:0}
</style></head><body><p>\u6B63\u5728\u8FDB\u5165\u2026 | opening\u2026</p></body></html>`;
}
function handshakeBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket \xB7 \u65E0\u6CD5\u5B8C\u6210\u767B\u5F55\u63E1\u624B</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 22px;max-width:380px;width:calc(100% - 40px)}
h1{font-size:15px;margin:0 0 10px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 10px;line-height:1.7}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
a{color:#4f6ef7}
</style></head><body><div class="card">
<h1>\u{1F501} \u65E0\u6CD5\u5B8C\u6210\u767B\u5F55\u63E1\u624B</h1>
<p>\u6D4F\u89C8\u5668\u6CA1\u6709\u4FDD\u5B58 DSH \u4E0B\u53D1\u7684\u4F1A\u8BDD cookie\uFF0C\u4EE3\u7406\u53CD\u590D\u91CD\u8BD5\u540E\u4ECD\u672A\u6210\u529F\uFF0C\u56E0\u6B64\u505C\u5728\u8FD9\u91CC\u800C\u4E0D\u662F\u65E0\u9650\u8DF3\u8F6C\u3002</p>
<p><strong>Safari\uFF08iOS/macOS\uFF09</strong> \u5728 <code>http://</code> \u7EAF IP \u5730\u5740\u4E0A\u4E0D\u4F1A\u4FDD\u5B58\u8FD9\u7C7B cookie\uFF0C\u5C40\u57DF\u7F51\u5165\u53E3\u56E0\u6B64\u8FDB\u4E0D\u53BB\u3002</p>
<p>\u53EF\u4EE5\u8BD5\u8BD5\uFF1A<br>
\u2460 \u6362 Chromium \u7CFB\u6D4F\u89C8\u5668\uFF08Chrome / Edge\uFF09\u6253\u5F00\u5C40\u57DF\u7F51\u5730\u5740\uFF1B<br>
\u2461 \u6539\u7528<strong>\u516C\u7F51\u5165\u53E3</strong>\uFF08\u8BBE\u7F6E\u9875\u5F00\u542F\u516C\u7F51\u8BBF\u95EE\uFF0C\u62FF\u5230 <code>https://\u2026trycloudflare.com</code> \u5730\u5740\uFF09\u2014\u2014HTTPS \u57DF\u540D\u4E0A Safari \u6B63\u5E38\u3002</p>
<p style="margin-top:14px"><a href="/?${HANDSHAKE_RETRY_PARAM}=1" style="display:inline-block;padding:8px 14px;background:#4f6ef7;color:#fff;border-radius:8px;text-decoration:none;font-size:13px">\u91CD\u8BD5\u4E00\u6B21 | Retry</a></p>
<p style="color:#9ca3af;font-size:12px">Browser did not keep the session cookie, so the login handshake could not complete (issue #91). Safari over plain <code>http://</code> + IP is the known case \u2014 try Chrome, or use the public HTTPS entry.</p>
</div></body></html>`;
}
var WS_PING_FRAME = Buffer.from([137, 0]);
function attachWebSocketHeartbeat(socket, { intervalMs = 3e4, missLimit = 2 } = {}, onDead = null) {
  let misses = 0;
  let stopped = false;
  const onInbound = () => {
    misses = 0;
  };
  const timer = setInterval(() => {
    if (stopped) return;
    misses += 1;
    if (misses >= missLimit) {
      try {
        onDead?.("heartbeat-miss");
      } catch {
      }
      socket.destroy();
      return;
    }
    if (!socket.destroyed) {
      try {
        socket.write(WS_PING_FRAME);
      } catch {
      }
    }
  }, intervalMs);
  timer.unref?.();
  socket.on("data", onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off("data", onInbound);
    socket.off("close", cleanup);
    socket.off("error", cleanup);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}
var DIAG_PATH = "/.dsh-pocket/diag";
var DIAG_BODY_MAX = 16 * 1024;
var DIAG_HITS = /* @__PURE__ */ new Map();
function diagRateLimited(ip) {
  const now = Date.now();
  const entry = DIAG_HITS.get(ip) ?? { start: now, count: 0 };
  if (now - entry.start > 6e4) {
    entry.start = now;
    entry.count = 0;
  }
  entry.count += 1;
  DIAG_HITS.set(ip, entry);
  if (DIAG_HITS.size > 500) {
    for (const [key, value] of DIAG_HITS) {
      if (now - value.start > 12e4) DIAG_HITS.delete(key);
    }
  }
  return entry.count > 120;
}
function isLoopbackRequest(req) {
  const address = String(req?.socket?.remoteAddress ?? "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function readDiagBody(req) {
  return new Promise((resolve) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > DIAG_BODY_MAX) {
        tooLarge = true;
        body = "";
      }
    });
    req.on("end", () => resolve(tooLarge ? null : body));
    req.on("error", () => resolve(null));
  });
}
function createPocketProxy({ port = 3081, host = "0.0.0.0", upstream = DEFAULT_UPSTREAM, log = null, injectHtml = DEFAULT_INJECT, auth = null, rateLimit = null, heartbeat = {}, lanAccessEnabled = () => true, launchToken = () => "", handshakeLimit, tihu = null } = {}) {
  const limiter = auth ? createRateLimiter(rateLimit ?? {}) : null;
  const wsDeflateEnabled = process.env.DSH_POCKET_WS_DEFLATE !== "0";
  const decideWsDeflate = (headerValue) => wsDeflateEnabled && wsDeflateAllowed() ? negotiatePermessageDeflate(headerValue) : null;
  const wsDeflate = attachWsDeflate;
  const handshake = createHandshakeTracker(
    typeof handshakeLimit === "number" ? { max: handshakeLimit } : {}
  );
  const mobileBatches = createMobileBatchStore({ upstream, rewriteHeaders: loopbackAuthority, log });
  const server = createServer((req, res) => {
    let urlPath = "";
    try {
      urlPath = new URL(req.url ?? "/", "http://diag.invalid").pathname;
    } catch {
      urlPath = "";
    }
    if (urlPath === DIAG_PATH) {
      if (req.method === "POST") {
        const ip = clientIp(req);
        if (diagRateLimited(ip)) {
          res.writeHead(429, { "content-type": "application/json", "cache-control": "no-store" });
          res.end('{"error":"too-many-events"}');
          return;
        }
        void readDiagBody(req).then((body) => {
          if (body === null) {
            res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
            res.end('{"error":"too-large"}');
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          if (parsed === null || typeof parsed !== "object") {
            res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
            res.end('{"error":"invalid-json"}');
            return;
          }
          const { ev, ...rest } = parsed;
          appendDiagnostic({
            ev: "client",
            name: String(ev ?? "event").slice(0, 48),
            ip,
            ua: String(req.headers["user-agent"] ?? "").slice(0, 220),
            ...rest
          });
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
        });
        return;
      }
      if (req.method === "GET") {
        if (!isLoopbackRequest(req)) {
          res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          res.end('{"error":"loopback-only"}');
          return;
        }
        const summary = diagnosticSummary({ minutes: 30, limit: 120 });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(summary));
        return;
      }
      res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
      res.end('{"error":"method-not-allowed"}');
      return;
    }
    if (req.method === "GET" && (urlPath === "/" || /\.html?$/i.test(urlPath))) {
      const ua = String(req.headers["user-agent"] ?? "").slice(0, 220);
      if (!ua.includes("dsh-pocket-tunnel-probe")) {
        appendDiagnostic({
          ev: "page",
          host: policyHost(req, String(req.headers.host ?? "")),
          ip: clientIp(req),
          path: String(req.url ?? "").slice(0, 240),
          ref: String(req.headers.referer ?? "").slice(0, 200),
          ua
        });
      }
    }
    const host2 = policyHost(req, String(req.headers.host ?? ""));
    const isPublic = classifyHost(host2) === "public";
    if (!isPublic && !isLoopbackHost(host2) && !lanAccessEnabled()) {
      if (isHtmlRequest(req)) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(lanDisabledPageHtml());
      } else {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"error":"lan-disabled"}');
      }
      return;
    }
    if (auth) {
      const protectedHost = isProtectedHost(host2, auth.isProtected);
      const token = protectedHost ? auth.getToken?.(host2) ?? null : null;
      const altTokens = protectedHost && token && typeof auth.getAltTokens === "function" ? auth.getAltTokens(host2) ?? [] : [];
      const sessionKey = auth.sessionKey ?? null;
      const acceptedTokens = token ? [token, ...altTokens] : [];
      if (protectedHost && token) {
        const ip = clientIp(req);
        if (req.method === "POST" && req.url?.startsWith("/pocket-login")) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          if (rl.locked) {
            res.writeHead(429, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "retry-after": String(rl.retryAfter)
            });
            res.end(loginPageHtml("locked", isPublic, rl.retryAfter, loginCarryQuery(req.url)));
            return;
          }
          let body = "";
          req.on("data", (c) => {
            body += c;
            if (body.length > 1024) req.destroy();
          });
          req.on("end", () => {
            const submitted = String(new URLSearchParams(body).get("token") ?? "");
            const matched = acceptedTokens.find((candidate) => safeEqual(submitted, candidate));
            if (matched !== void 0) {
              limiter?.clear(ip);
              res.writeHead(302, {
                // 带上 dsh-pocket-auth=1：登录成功后强制重做一次浏览器会话握手，
                // 换掉可能已过期/被撤销的 dsh web 会话 cookie（issue #77）。
                // 同时保住用户原 URL 上除 token 之外的 query（本次 B 项）：
                // 原先写死 '/?dsh-pocket-auth=1' 会把 ?dsh-layout=auto 之类吞掉。
                location: postLoginRedirectLocation(req.url, req.headers.referer ?? ""),
                "set-cookie": `${TOKEN_COOKIE}=${cookieFor(matched, sessionKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
                "cache-control": "no-store"
              });
              res.end();
            } else {
              limiter?.record(ip);
              log?.(`dsh-pocket: login failed from ${ip} | \u767B\u5F55\u5931\u8D25 IP: ${ip}`);
              res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
              res.end(loginPageHtml(true, isPublic, 0, loginCarryQuery(req.url)));
            }
          });
          return;
        }
        const isGuess = hasQueryToken(req);
        if (isGuess) {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
          if (rl.locked) {
            if (isHtmlRequest(req)) {
              res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
              res.end(loginPageHtml("locked", isPublic, rl.retryAfter));
            } else {
              res.writeHead(429, {
                "content-type": "application/json",
                "cache-control": "no-store",
                "retry-after": String(rl.retryAfter)
              });
              res.end('{"error":"too-many-attempts"}');
            }
            return;
          }
        }
        const authResult = authCheck(req, acceptedTokens, sessionKey);
        if (!authResult.ok) {
          if (isGuess) {
            limiter?.record(ip);
            log?.(`dsh-pocket: bad ?token= from ${ip} | URL \u5BC6\u7801\u9519\u8BEF IP: ${ip}`);
          }
          if (isHtmlRequest(req)) {
            const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(loginPageHtml(rl.locked ? "locked" : false, isPublic, rl.retryAfter, loginCarryQuery(req.url)));
          } else {
            res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
            res.end('{"error":"unauthorized"}');
          }
          return;
        }
        if (authResult.rawQueryToken) {
          limiter?.clear(ip);
          maybeSeedAuthCookie(req, res, authResult.rawQueryToken, sessionKey);
        }
      }
    }
    if (tihu && (urlPath === "/tihu" || urlPath === "/tihu/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
        res.end("method not allowed");
        return;
      }
      const page = Buffer.from(tihu.page(), "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(page.length),
        "cache-control": "no-store",
        "x-dsh-tihu": "p0"
      });
      res.end(req.method === "HEAD" ? void 0 : page);
      return;
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    if (isHtmlRequest(req)) headers["accept-encoding"] = "identity";
    const launchTok = (typeof launchToken === "function" ? launchToken() : "") || "";
    const handshakeIp = clientIp(req);
    let cleanPath = stripDesktopMarkers(req.url);
    if (cleanPath.includes(HANDSHAKE_RETRY_PARAM)) {
      handshake.clear(handshakeIp);
      cleanPath = stripQueryParam(cleanPath, HANDSHAKE_RETRY_PARAM);
    }
    const handshakeOver = launchTok !== "" && handshake.exhausted(handshakeIp);
    const upstreamPath = handshakeOver ? cleanPath : upstreamPathWithLaunchToken(cleanPath, req.method, req.headers.cookie, launchTok);
    const didInjectToken = upstreamPath !== cleanPath;
    if (didInjectToken) {
      handshake.record(handshakeIp);
      handshake.prune();
    }
    if (!didInjectToken && String(req.headers.cookie ?? "").includes(DSH_AUTH_COOKIE)) {
      handshake.clear(handshakeIp);
    }
    if (handshakeOver && isHtmlRequest(req)) {
      res.writeHead(503, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-dsh-pocket-handshake": "blocked"
      });
      res.end(handshakeBlockedPageHtml());
      return;
    }
    if (mobileBatches.handle(req, res)) return;
    const proxyReq = httpRequest2(
      { host: upstream.host, port: upstream.port, method: req.method, path: upstreamPath, headers, agent: false },
      (proxyRes) => {
        log?.(`${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers["content-type"] ?? "");
        if (didInjectToken && proxyRes.statusCode === 303 && isHtmlRequest(req)) {
          const out = { ...proxyRes.headers };
          delete out["content-length"];
          delete out["transfer-encoding"];
          delete out.location;
          const page = Buffer.from(handshakePageHtml(loginCarryQuery(req.url)), "utf8");
          out["content-type"] = "text/html; charset=utf-8";
          out["content-length"] = String(page.length);
          out["cache-control"] = "no-store";
          out["x-dsh-pocket-handshake"] = "transition";
          proxyRes.resume();
          res.writeHead(200, out);
          res.end(page);
          return;
        }
        if (proxyRes.statusCode === 403 && contentType.includes("text/plain")) {
          const navReq = isHtmlRequest(req);
          const gateChunks = [];
          let gateOverflow = false;
          const passRaw403 = () => {
            if (res.headersSent) return;
            res.writeHead(403, { ...proxyRes.headers });
            if (gateChunks.length) res.write(Buffer.concat(gateChunks));
            proxyRes.pipe(res);
          };
          proxyRes.on("data", (c) => {
            if (gateOverflow) return;
            gateChunks.push(c);
            if (Buffer.concat(gateChunks).length > 65536) {
              gateOverflow = true;
              gateChunks.length = 0;
              passRaw403();
            }
          });
          proxyRes.on("end", () => {
            if (gateOverflow || res.headersSent) return;
            const body = Buffer.concat(gateChunks).toString("utf8").trim();
            if (navReq && body === "forbidden") {
              res.writeHead(403, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "x-dsh-pocket-gate": "desktop-browser-access"
              });
              res.end(desktopAccessBlockedPageHtml());
            } else {
              res.writeHead(403, { ...proxyRes.headers });
              res.end(Buffer.concat(gateChunks));
            }
          });
          proxyRes.on("error", () => res.destroy());
          return;
        }
        if (injectHtml && contentType.includes("text/html") && !isCompressed(proxyRes.headers)) {
          const chunks = [];
          proxyRes.on("data", (c) => chunks.push(c));
          proxyRes.on("end", () => {
            let html = Buffer.concat(chunks).toString("utf8");
            let mobileBootLean = false;
            const ua = String(req.headers["user-agent"] ?? "");
            const fullPlugins = new URL(req.url ?? "/", "http://pocket.invalid").searchParams.get("dsh-full-plugins") === "1";
            if (/(?:Android|iPhone|iPad|HarmonyOS|Mobile)/i.test(ua) && !fullPlugins) {
              const optimized = optimizeMobileBoot(html, { createBatch: mobileBatches.register });
              html = optimized.html;
              mobileBootLean = optimized.changed;
            }
            if (!html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${injectHtml}`);
            }
            const out = Buffer.from(html, "utf8");
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders["content-length"];
            delete outHeaders["transfer-encoding"];
            outHeaders["content-length"] = String(out.length);
            outHeaders["cache-control"] = "no-store";
            if (mobileBootLean) outHeaders["x-dsh-pocket-mobile-boot"] = "lean";
            delete outHeaders["etag"];
            delete outHeaders["last-modified"];
            delete outHeaders["expires"];
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on("error", () => res.destroy());
          return;
        }
        const acceptEncoding = String(req.headers["accept-encoding"] ?? "");
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes("text/event-stream");
        const knownLen = Number(proxyRes.headers["content-length"] || 0);
        const shouldCompress = (canGzip || canBr) && !isCompressed(proxyRes.headers) && !isEventStream && (contentType.includes("application/json") || contentType.startsWith("text/")) && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? "br" : "gzip";
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders["content-length"];
          delete outHeaders["transfer-encoding"];
          outHeaders["content-encoding"] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, staticCacheHeaders(req.url, outHeaders));
          const z = enc === "br" ? createBrotliCompress({ params: { [zlibConstants3.BROTLI_PARAM_QUALITY]: 6 } }) : createGzip();
          proxyRes.pipe(z).pipe(res);
          res.on("close", () => {
            proxyRes.destroy();
            z.destroy();
          });
          proxyRes.on("error", () => {
            z.destroy();
            res.destroy();
          });
          proxyRes.on("aborted", () => {
            z.destroy();
            res.destroy();
          });
          z.on("error", () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, staticCacheHeaders(req.url, proxyRes.headers));
        proxyRes.pipe(res);
        res.on("close", () => proxyRes.destroy());
        proxyRes.on("error", () => res.destroy());
        proxyRes.on("close", () => {
          if (!res.writableEnded) res.destroy();
        });
      }
    );
    proxyReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`dsh-pocket: \u65E0\u6CD5\u8FDE\u63A5\u4E0A\u6E38 dsh web\uFF08${upstream.host}:${upstream.port}\uFF09\u2014\u2014\u5148\u542F\u52A8 dsh web | ${err.message}`);
    });
    req.pipe(proxyReq);
  });
  server.on("upgrade", (req, socket, head) => {
    const host2 = policyHost(req, String(req.headers.host ?? ""));
    const isPublic = classifyHost(host2) === "public";
    if (!isPublic && !isLoopbackHost(host2) && !lanAccessEnabled()) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (auth) {
      const token = isProtectedHost(host2, auth.isProtected) ? auth.getToken?.(host2) ?? null : null;
      const altTokens = token && typeof auth.getAltTokens === "function" ? auth.getAltTokens(host2) ?? [] : [];
      const acceptedTokens = token ? [token, ...altTokens] : [];
      const wsIp2 = clientIp(req);
      const wsGuess = hasQueryToken(req);
      if (token && wsGuess) {
        const rl = limiter?.status(wsIp2) ?? { locked: false, retryAfter: 0 };
        if (rl.locked) {
          socket.write(`HTTP/1.1 429 Too Many Requests\r
Retry-After: ${rl.retryAfter}\r
Connection: close\r
\r
`);
          socket.destroy();
          return;
        }
      }
      const wsAuth = authCheck(req, acceptedTokens, auth.sessionKey ?? null);
      if (token && !wsAuth.ok) {
        if (wsGuess) {
          limiter?.record(wsIp2);
          log?.(`dsh-pocket: bad ws ?token= from ${wsIp2} | WS \u5BC6\u7801\u9519\u8BEF IP: ${wsIp2}`);
        }
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (token && wsAuth.ok && wsGuess) limiter?.clear(wsIp2);
    }
    if (tihu && typeof tihu.handleUpgrade === "function" && tihu.handleUpgrade(req, socket, head)) return;
    const wsId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const wsStarted = Date.now();
    const wsPath = String(req.url ?? "").slice(0, 240);
    const wsUa = String(req.headers["user-agent"] ?? "").slice(0, 220);
    const wsIp = clientIp(req);
    let wsOpened = false;
    let wsLogged = false;
    let wsBytesIn = 0;
    let wsBytesOut = 0;
    let wsCloseReason = "";
    let wsQueueStats = null;
    const logWsClose = () => {
      if (!wsOpened || wsLogged) return;
      wsLogged = true;
      appendDiagnostic({
        ev: "ws-close",
        id: wsId,
        host: host2,
        ip: wsIp,
        ua: wsUa,
        path: wsPath,
        durMs: Date.now() - wsStarted,
        bytesIn: wsBytesIn,
        bytesOut: wsBytesOut,
        reason: wsCloseReason || "unknown",
        ...typeof wsQueueStats === "function" ? { queue: wsQueueStats() } : {}
      });
    };
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest2({
      // 同样清掉历史遗留的 dsh-desktop-* 参数（issue #75）
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: stripDesktopMarkers(req.url),
      headers,
      agent: false
    });
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      }
      const wsDeflateValue = wsDeflate && decideWsDeflate(req.headers["sec-websocket-extensions"]);
      if (wsDeflateValue) raw.push(`Sec-WebSocket-Extensions: ${wsDeflateValue}`);
      socket.write(`${raw.join("\r\n")}\r
\r
`);
      if (proxyHead?.length) socket.write(proxyHead);
      wsOpened = true;
      appendDiagnostic({
        ev: "ws-open",
        id: wsId,
        host: host2,
        ip: wsIp,
        ua: wsUa,
        path: wsPath
      });
      socket.on("data", (chunk) => {
        wsBytesIn += chunk.length;
      });
      proxySocket.on("data", (chunk) => {
        wsBytesOut += chunk.length;
      });
      if (wsDeflateValue && wsDeflate) {
        const wsDef = wsDeflate({
          client: socket,
          upstream: proxySocket,
          onFailure: noteWsDeflateFailure,
          onError: (err) => log?.(`dsh-pocket: ws-deflate failed: ${err?.message ?? err}`)
        });
        wsQueueStats = () => wsDef.stats().queue;
        socket.on("close", () => {
          try {
            wsDef.close();
          } catch {
          }
        });
        proxySocket.on("close", () => {
          try {
            wsDef.close();
          } catch {
          }
        });
      } else {
        socket.pipe(proxySocket, { end: false });
        proxySocket.pipe(socket, { end: false });
      }
      if (heartbeat !== false) {
        attachWebSocketHeartbeat(socket, heartbeat ?? {}, (reason) => {
          wsCloseReason ||= reason;
        });
      }
      const teardown = () => {
        try {
          proxySocket.resetAndDestroy?.() ?? proxySocket.destroy();
        } catch {
          try {
            proxySocket.destroy();
          } catch {
          }
        }
        try {
          socket.destroy();
        } catch {
        }
      };
      proxySocket.on("error", () => {
        wsCloseReason ||= "upstream-error";
        try {
          socket.destroy();
        } catch {
        }
        logWsClose();
      });
      proxySocket.on("close", () => {
        wsCloseReason ||= "upstream";
        logWsClose();
        teardown();
      });
      socket.on("close", () => {
        wsCloseReason ||= "browser";
        logWsClose();
        teardown();
      });
      socket.on("end", () => {
        wsCloseReason ||= "browser-end";
        tapEnd();
      });
      proxySocket.on("end", () => {
        wsCloseReason ||= "upstream-end";
        tapEnd();
      });
      function tapEnd() {
        logWsClose();
        teardown();
      }
    });
    proxyReq.on("response", (proxyRes) => {
      if (proxyRes.statusCode === 101) return;
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ""}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
        }
        socket.end(raw.join("\r\n") + "\r\n\r\n");
        proxyRes.resume();
      } catch {
        socket.destroy();
      }
    });
    proxyReq.on("error", () => socket.destroy());
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on("error", () => socket.destroy());
  });
  const clientSockets = /* @__PURE__ */ new Set();
  server.on("connection", (sock) => {
    clientSockets.add(sock);
    sock.on("close", () => clientSockets.delete(sock));
    sock.on("error", () => {
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((r) => {
          for (const s of clientSockets) {
            try {
              s.destroy();
            } catch {
            }
          }
          server.close(() => r());
        })
      });
    });
  });
}

// src/pocket-host/tunnel.mjs
import { spawn, execSync } from "node:child_process";
import { mkdir, access, chmod, rm, stat, rename, cp, open } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2, dirname as dirname2 } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
var QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
var TUNNEL_PROTOCOLS = ["quic", "http2"];
async function startWithProtocolFallback(label, signal, attempt) {
  const failures = [];
  for (const protocol of TUNNEL_PROTOCOLS) {
    if (signal?.aborted) throw new Error("\u5DF2\u53D6\u6D88 | cancelled");
    try {
      return await attempt(protocol);
    } catch (err) {
      const msg = err?.message ?? String(err);
      failures.push(`${protocol}: ${msg}`);
      if (signal?.aborted || /已取消|cancelled/.test(msg)) throw err;
      console.warn(`dsh-pocket: ${label} \u534F\u8BAE ${protocol} \u672A\u5C31\u7EEA\uFF0C\u56DE\u9000\u4E0B\u4E00\u4E2A | ${label} protocol ${protocol} failed: ${msg}`);
    }
  }
  throw new Error(
    `cloudflared \u65E0\u6CD5\u5EFA\u7ACB\u8FB9\u7F18\u8FDE\u63A5\uFF08\u5DF2\u5C1D\u8BD5 ${TUNNEL_PROTOCOLS.join(" / ")}\uFF09| no Cloudflare edge connection (tried ${TUNNEL_PROTOCOLS.join(" / ")}): ${failures.join(" || ")}`
  );
}
async function confirmPublicReachable(url, { signal, timeoutMs = 15e3 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "timeout";
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5e3) });
      if (res.status < 500) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 1e3));
  }
  console.warn(`dsh-pocket: \u516C\u7F51\u53EF\u8FBE\u6027\u786E\u8BA4\u8D85\u65F6\uFF08${lastErr}\uFF09\uFF0C\u4ECD\u6309\u5DF2\u5C31\u7EEA\u8FD4\u56DE | reachability confirm timed out: ${lastErr}`);
  return false;
}
function firstMeaningfulErrorLine(buf) {
  const lines = String(buf ?? "").trim().split(/\r?\n/);
  const usageIdx = lines.findIndex((l) => /^(?:Incorrect Usage|flag provided but not defined|unknown flag|unknown command)/i.test(l.trim()));
  if (usageIdx >= 0) return lines[usageIdx].trim().slice(0, 500);
  return lines.slice(-4).join("\n").trim().slice(0, 500);
}
function platformBinary() {
  const archMap = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "arm" };
  const a = archMap[process.arch] ?? process.arch;
  const os3 = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  return { os: os3, a, ext: os3 === "windows" ? ".exe" : "" };
}
function platformAssets() {
  const { os: os3, a } = platformBinary();
  if (os3 === "windows") return [`cloudflared-windows-${a}.exe`];
  if (os3 === "darwin") return [`cloudflared-darwin-${a}.tgz`];
  return [`cloudflared-linux-${a}`, `cloudflared-linux-${a}.tgz`];
}
var CLOUDFLARED_MIRRORS = [
  (asset) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`
];
var TUNA_BOTTLES = "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/";
var PARALLEL_SEGMENTS = 8;
var MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
var PROBE_SIZE = 2 * 1024 * 1024;
var SLOW_SPEED_THRESHOLD = 0.3;
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
async function mergeParts(partFiles, dest) {
  const { createReadStream } = await import("node:fs");
  const out = createWriteStream(dest);
  try {
    for (const f of partFiles) {
      await new Promise((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on("error", reject);
        rs.pipe(out, { end: false });
        rs.on("end", resolve);
      });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}
async function downloadFile(url, dest, { signal, segments = PARALLEL_SEGMENTS } = {}) {
  let head = null;
  try {
    head = await fetch(url, { method: "HEAD", signal });
  } catch {
    head = null;
  }
  const len = head ? Number(head.headers.get("content-length") || 0) : 0;
  const acceptsRanges = head ? String(head.headers.get("accept-ranges") || "").toLowerCase() === "bytes" : false;
  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return len || 0;
  }
  const probeBytes = Math.min(PROBE_SIZE, len);
  const probeStart = Date.now();
  try {
    const probeRes = await fetch(url, { signal, headers: { Range: `bytes=0-${probeBytes - 1}` } });
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`);
    const probeBody = await probeRes.arrayBuffer();
    const probeMs = Date.now() - probeStart;
    const probeSpeed = probeMs > 0 ? probeBytes / probeMs : Infinity;
    if (probeMs < 500 || probeSpeed >= SLOW_SPEED_THRESHOLD) {
      const { createWriteStream: createWriteStream2, createReadStream } = await import("node:fs");
      const w = createWriteStream2(dest);
      await new Promise((resolve, reject) => {
        w.on("error", reject);
        w.write(Buffer.from(probeBody));
        w.end(resolve);
      });
      const restRes = await fetch(url, { signal, headers: { Range: `bytes=${probeBytes}-${len - 1}` } });
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`);
      await pipeline(Readable.fromWeb(restRes.body), createWriteStream2(dest, { flags: "a" }));
      return len;
    }
    await rm(dest, { force: true }).catch(() => {
    });
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {
    });
    if (!/HTTP|fetch/i.test(String(err?.message ?? ""))) throw err;
  }
  const parts = [];
  const chunk = Math.ceil(len / segments);
  for (let i = 0; i < segments; i++) {
    const start = i * chunk;
    const end = i === segments - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(parts.map(async (p) => {
      const res = await fetch(url, { signal, headers: { Range: `bytes=${p.start}-${p.end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${p.start}-${p.end})`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(p.file));
    }));
    await mergeParts(parts.map((p) => p.file), dest);
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {
    })));
  }
  return len;
}
async function tsinghuaBottleUrl({ os: os3, a }) {
  if (os3 !== "darwin") return null;
  let res;
  try {
    res = await fetch(TUNA_BOTTLES, { signal: AbortSignal.timeout(2e4) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let html;
  try {
    html = await res.text();
  } catch {
    return null;
  }
  const MACOS_CODES = "monterey|ventura|sonoma|sequoia|tahoe";
  const pattern = os3 === "darwin" ? new RegExp(`cloudflared-([0-9.]+)\\.${a === "arm64" ? "arm64_" : ""}(${MACOS_CODES})\\.bottle\\.tar\\.gz`, "g") : new RegExp(`cloudflared-([0-9.]+)\\.${a === "arm64" ? "arm64" : "x86_64"}_linux\\.bottle\\.tar\\.gz`, "g");
  let best = null;
  let bestV = "";
  for (const m of html.matchAll(pattern)) {
    if (m[1] > bestV) {
      bestV = m[1];
      best = m[0];
    }
  }
  return best ? `${TUNA_BOTTLES}${best}` : null;
}
async function downloadCloudflared(binPath, signal) {
  const { os: os3, a, ext } = platformBinary();
  const dir = dirname2(binPath);
  const tmpFile = join2(dir, `cloudflared.download`);
  const isWindows = os3 === "windows";
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12e4)]) : AbortSignal.timeout(12e4);
  const bottle = os3 === "darwin" ? await tsinghuaBottleUrl({ os: os3, a }).catch(() => null) : null;
  const assets = platformAssets();
  let lastErr = null;
  let usedAsset = null;
  for (let ai = 0; ai < assets.length && usedAsset === null; ai++) {
    const asset = assets[ai];
    const sources = [];
    if (bottle && asset.endsWith(".tgz")) {
      sources.push({ url: bottle, host: "mirrors.tuna.tsinghua.edu.cn" });
    }
    for (const m of CLOUDFLARED_MIRRORS) sources.push({ url: m(asset), host: hostOf(m(asset)) });
    for (let i = 0; i < sources.length; i++) {
      const { url, host } = sources[i];
      console.log(`\u2B07\uFE0F  \u4E0B\u8F7D cloudflared\uFF08${asset}\uFF0C\u6E90 ${i + 1}/${sources.length}\uFF1A${host}\uFF09\u2026`);
      try {
        await downloadFile(url, tmpFile, { signal: fetchSignal });
        const st = await stat(tmpFile);
        if (st.size < 1024 * 1024) throw new Error(`\u6587\u4EF6\u5F02\u5E38\u5C0F\uFF08${st.size} \u5B57\u8282\uFF09\uFF0C\u7591\u4F3C\u955C\u50CF\u9519\u8BEF\u9875`);
        usedAsset = asset;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await rm(tmpFile, { force: true }).catch(() => {
        });
        console.warn(`  \u26A0\uFE0F \u6E90 ${i + 1} \u5931\u8D25\uFF1A${err?.message ?? err}\uFF0C\u5C1D\u8BD5\u4E0B\u4E00\u4E2A\u2026`);
      }
    }
  }
  if (usedAsset === null) {
    throw new Error(
      `cloudflared \u4E0B\u8F7D\u5931\u8D25\uFF1A\u6240\u6709\u6E90\u90FD\u4E0D\u901A\uFF08\u6700\u540E\u9519\u8BEF\uFF1A${lastErr?.message ?? lastErr}\uFF09\u3002` + (isWindows ? `Windows \u53EF\u624B\u52A8\u5B89\u88C5\u540E\u91CD\u8BD5\uFF1Awinget install cloudflared\uFF1B\u6216\u4E0B\u8F7D ${assets[0]} \u653E\u5230 ${dir} \u76EE\u5F55 | download failed \u2014 try: winget install cloudflared, or put the exe into ${dir}` : `\u4E5F\u53EF\u4EE5\u81EA\u5DF1\u88C5\u597D\u540E\u5728 settings.json \u5199 "cloudflaredPath": "/path/to/cloudflared" \u8DF3\u8FC7\u4E0B\u8F7D\uFF08\u6216\u7528\u73AF\u5883\u53D8\u91CF DSH_POCKET_CLOUDFLARED\uFF09\uFF1B\u6216\u7528\u5305\u7BA1\u7406\u5668\u5B89\u88C5\uFF1Aapt/dnf install cloudflared | all mirrors failed \u2014 install cloudflared manually and set "cloudflaredPath" in settings.json, or: apt/dnf install cloudflared`)
    );
  }
  let extracted = join2(dir, `cloudflared${ext}`);
  if (!usedAsset.endsWith(".tgz")) {
    await rename(tmpFile, extracted).catch(async () => {
      await cp(tmpFile, extracted).catch(() => {
      });
    });
  } else {
    const extractDir = join2(dir, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-xzf", tmpFile, "-C", extractDir], { stdio: "ignore", windowsHide: true });
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`cloudflared \u89E3\u538B\u5931\u8D25\uFF08code=${code}\uFF09`)));
        child.once("error", (err) => reject(
          err?.code === "ENOENT" ? new Error(`\u7CFB\u7EDF\u91CC\u6CA1\u6709 tar \u547D\u4EE4\uFF0C\u65E0\u6CD5\u89E3\u538B ${usedAsset} \u2014\u2014 \u53EF\u6539\u7528 linux \u88F8\u4E8C\u8FDB\u5236\uFF08\u9ED8\u8BA4\u5DF2\u5982\u6B64\uFF09\u6216\u624B\u52A8\u5B89\u88C5\u540E\u8BBE\u7F6E cloudflaredPath | no tar on this system`) : err
        ));
      });
      const { readdir: readdir2 } = await import("node:fs/promises");
      let found = null;
      const direct = join2(extractDir, `cloudflared${ext}`);
      try {
        if ((await stat(direct)).isFile()) found = direct;
      } catch {
      }
      if (!found) {
        const verDir = join2(extractDir, "cloudflared");
        try {
          const vers = await readdir2(verDir);
          for (const v of vers) {
            const bin = join2(verDir, v, "bin", `cloudflared${ext}`);
            try {
              if ((await stat(bin)).isFile()) {
                found = bin;
                break;
              }
            } catch {
            }
          }
        } catch {
        }
      }
      if (!found) throw new Error("cloudflared \u89E3\u538B\u6210\u529F\u4F46\u672A\u627E\u5230\u4E8C\u8FDB\u5236 | binary not found after extract");
      if (found !== extracted) {
        await rename(found, extracted).catch(async () => {
          await cp(found, extracted).catch(() => {
          });
        });
      }
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
  if (!isWindows) await chmod(extracted, 493);
  await rm(tmpFile, { force: true }).catch(() => {
  });
  return extracted;
}
function cloudflaredOnPath() {
  try {
    execSync(process.platform === "win32" ? "where cloudflared" : "command -v cloudflared", { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
var downloading = null;
async function resolveCloudflared({ home, onPhase = () => {
}, signal } = {}) {
  const explicit = process.env.DSH_POCKET_CLOUDFLARED;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      throw new Error(
        `DSH_POCKET_CLOUDFLARED \u6307\u5411\u7684\u8DEF\u5F84\u4E0D\u53EF\u6267\u884C\uFF1A${explicit} | cloudflaredPath is set but not accessible: ${explicit}`
      );
    }
  }
  if (cloudflaredOnPath()) return "cloudflared";
  const dshHome2 = home ?? process.env.DSH_HOME ?? join2(homedir2(), ".dsh");
  const cacheDir = join2(dshHome2, "dsh-pocket", "bin");
  const { os: os3, a, ext } = platformBinary();
  const candidates = [
    join2(cacheDir, `cloudflared${ext}`),
    join2(cacheDir, `cloudflared-${os3}-${a}${ext}`)
  ];
  for (const bin of candidates) {
    try {
      await access(bin);
      if (os3 === "linux") {
        try {
          const fd = await open(bin, "r");
          const head = Buffer.alloc(8192);
          await fd.read(head, 0, 8192, 0);
          await fd.close();
          if (head.includes("@@HOMEBREW_PREFIX@@")) {
            await rm(bin, { force: true }).catch(() => {
            });
            console.warn("dsh-pocket: discarding unusable Homebrew-bottle cloudflared cache | \u4E22\u5F03\u4E0D\u53EF\u7528\u7684 Homebrew bottle \u7F13\u5B58\uFF0C\u91CD\u65B0\u4E0B\u8F7D");
            continue;
          }
        } catch {
        }
      }
      return bin;
    } catch {
    }
  }
  onPhase("downloading");
  await mkdir(cacheDir, { recursive: true });
  if (!downloading) {
    downloading = downloadCloudflared(join2(cacheDir, `cloudflared${ext}`), signal).finally(() => {
      downloading = null;
    });
  }
  return downloading;
}
async function startNamedTunnel(opts) {
  return startWithProtocolFallback("named", opts?.signal, (protocol) => startNamedTunnelOnce(opts, protocol));
}
async function startNamedTunnelOnce({ token, home, signal, onPhase = () => {
} }, protocol) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase("starting");
  const child = spawn(bin, ["--no-autoupdate", "tunnel", "run", "--protocol", protocol], {
    stdio: ["ignore", "pipe", "pipe"],
    // GUI 宿主（DSH Desktop）里不隐藏会弹一个黑控制台窗口——用户明确不要
    windowsHide: true,
    env: { ...process.env, TUNNEL_TOKEN: String(token ?? "") }
  });
  let cleanup = null;
  let rejectErr = null;
  child.on("error", (err) => {
    cleanup?.();
    onPhase?.("error");
    rejectErr?.(new Error(`cloudflared \u542F\u52A8\u5931\u8D25\uFF1A${err?.message ?? err}\uFF08\u53EF\u5220\u9664 $DSH_HOME/dsh-pocket/bin \u7F13\u5B58\u540E\u91CD\u8BD5\uFF09`));
  });
  onPhase("registering");
  await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += String(chunk);
      if (/Registered tunnel connection/i.test(buf)) {
        cleanup();
        onPhase("ready");
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(
        `cloudflared \u9000\u51FA\uFF08code=${code}\uFF09${tail ? "\uFF1A" + tail : ""}\u2014\u2014\u8BF7\u68C0\u67E5 Tunnel Token \u662F\u5426\u6709\u6548\u3001\u57DF\u540D Service \u662F\u5426\u6307\u5411\u672C\u673A\u4EE3\u7406\u7AEF\u53E3 | tunnel exited (code=${code})${tail ? ": " + tail : ""} \u2014 check the Tunnel Token and the ingress hostname`
      ));
    };
    cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error("\u5DF2\u53D6\u6D88 | cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        "cloudflared \u542F\u52A8\u8D85\u65F6\uFF0830s\uFF09\u2014\u2014\u8BF7\u68C0\u67E5 Tunnel Token \u662F\u5426\u6709\u6548\u3001\u57DF\u540D Service \u662F\u5426\u6307\u5411\u672C\u673A\u4EE3\u7406\u7AEF\u53E3\uFF0C\u4EE5\u53CA\u662F\u5426\u5F00\u7740\u4EE3\u7406/VPN\uFF08Clash \u7B49 TUN \u6A21\u5F0F\u4F1A\u6390\u65AD\u96A7\u9053\u8FDE\u63A5\uFF09 | timeout \u2014 check the token, the ingress hostname, and quit any proxy/VPN (TUN mode)"
      ));
    }, 3e4);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    rejectErr = reject;
  });
  const exitListeners = /* @__PURE__ */ new Set();
  child.on("exit", (code) => {
    for (const cb of exitListeners) cb(code);
  });
  return {
    url: null,
    // 固定域名由调用方（service）按设置拼 https://<hostname>
    kill: () => {
      try {
        child.kill();
      } catch {
      }
    },
    /** 注册「进程已退出」回调，返回取消函数。 */
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    }
  };
}
async function startQuickTunnel(opts) {
  return startWithProtocolFallback("quick", opts?.signal, (protocol) => startQuickTunnelOnce(opts, protocol));
}
async function startQuickTunnelOnce({ port, home, signal, onPhase = () => {
} }, protocol) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase("starting");
  const child = spawn(bin, ["--no-autoupdate", "tunnel", "--url", `http://127.0.0.1:${port}`, "--protocol", protocol], {
    stdio: ["ignore", "pipe", "pipe"],
    // GUI 宿主（DSH Desktop）里不隐藏会弹一个黑控制台窗口——用户明确不要
    windowsHide: true
  });
  child.on("error", (err) => {
    cleanup?.();
    onPhase?.("error");
    rejectErr?.(new Error(`cloudflared \u542F\u52A8\u5931\u8D25\uFF1A${err?.message ?? err}\uFF08\u53EF\u5220\u9664 $DSH_HOME/dsh-pocket/bin \u7F13\u5B58\u540E\u91CD\u8BD5\uFF09`));
  });
  onPhase("registering");
  let cleanup = null;
  let rejectErr = null;
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    let foundUrl = null;
    const onData = (chunk) => {
      buf += String(chunk);
      if (!foundUrl) {
        const m = buf.match(QUICK_TUNNEL_URL_RE);
        if (m) foundUrl = m[0];
      }
      if (foundUrl && /Registered tunnel connection/i.test(buf)) {
        cleanup();
        resolve(foundUrl);
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(`cloudflared \u9000\u51FA\uFF08code=${code}\uFF09${tail ? "\uFF1A" + tail : ""}`));
    };
    cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error("\u5DF2\u53D6\u6D88 | cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        "cloudflared \u542F\u52A8\u8D85\u65F6\uFF0830s\uFF09\u2014\u2014\u8BF7\u68C0\u67E5\u662F\u5426\u5F00\u7740\u4EE3\u7406/VPN\uFF08Clash \u7B49 TUN \u6A21\u5F0F\u4F1A\u6390\u65AD\u96A7\u9053\u8FDE\u63A5\uFF09\uFF0C\u9000\u51FA\u4EE3\u7406\u540E\u91CD\u8BD5 | timeout \u2014 if you run a proxy/VPN (Clash etc., TUN mode), it can block the tunnel; quit it and retry"
      ));
    }, 3e4);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    rejectErr = reject;
  });
  await confirmPublicReachable(url, { signal });
  onPhase("ready");
  const exitListeners = /* @__PURE__ */ new Set();
  child.on("exit", (code) => {
    for (const cb of exitListeners) cb(code);
  });
  return {
    url,
    kill: () => {
      try {
        child.kill();
      } catch {
      }
    },
    /** 注册「进程已退出」回调，返回取消函数。 */
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    }
  };
}

// src/pocket-host/ssh-tunnel.mjs
import { spawn as spawn2, execFile } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import http from "node:http";
var POWERSHELL = process.platform === "win32" ? existsSync2("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe" : "";
var STDERR_LIMIT = 4e3;
var MAX_AUTO_CLEANUPS = 3;
var MAX_KILL_TARGETS = 6;
function findTunnelProcesses(cfg, { execFn = execFile } = {}) {
  if (!cfg?.host || !cfg?.remotePort) return Promise.resolve([]);
  const needle = `-R 0.0.0.0:${cfg.remotePort}:127.0.0.1:`;
  const target = `@${cfg.host}`;
  return new Promise((resolve) => {
    try {
      if (process.platform === "win32") {
        const ps = `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -like '*${target}*' } | ForEach-Object { Write-Output $_.ProcessId }`;
        execFn(
          POWERSHELL,
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
          { windowsHide: true, timeout: 1e4 },
          (err, stdout) => {
            resolve(String(stdout ?? "").split(/\s+/).map((s) => Number(s)).filter(Number.isInteger));
          }
        );
      } else {
        execFn("pgrep", ["-f", `${needle}`], { timeout: 1e4 }, (err, stdout) => {
          resolve(err ? [] : String(stdout ?? "").split(/\s+/).map((s) => Number(s)).filter(Number.isInteger));
        });
      }
    } catch {
      resolve([]);
    }
  });
}
function killStaleTunnels(cfg, { onKill, execFn = execFile } = {}) {
  if (!cfg?.host || !cfg?.remotePort) return Promise.resolve([]);
  const needle = `-R 0.0.0.0:${cfg.remotePort}:127.0.0.1:`;
  const target = `@${cfg.host}`;
  return new Promise((resolve) => {
    try {
      if (process.platform === "win32") {
        const ps = `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -like '*${target}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }`;
        execFn(
          POWERSHELL,
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
          { windowsHide: true, timeout: 1e4 },
          (err, stdout) => {
            const killed = String(stdout ?? "").split(/\s+/).filter(Boolean);
            if (killed.length) onKill?.(killed);
            resolve(killed);
          }
        );
      } else {
        execFile(
          "pkill",
          ["-f", `${needle}.*${target}`],
          { windowsHide: true, timeout: 1e4 },
          (err) => {
            if (!err) onKill?.(["pkill"]);
            resolve(err ? [] : ["pkill"]);
          }
        );
      }
    } catch {
      resolve([]);
    }
  });
}
var SSH_TUNNEL_DEFAULTS = Object.freeze({
  enabled: false,
  host: "",
  port: 22,
  user: "",
  remotePort: 7080,
  keyPath: "",
  /** 0 = 跟随插件代理实际端口（推荐）；>0 用于手工指到别的本地端口 */
  localPort: 0
});
function toPort(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}
function normalizeSshTunnelConfig(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: v.enabled === true,
    host: String(v.host ?? "").trim(),
    port: toPort(v.port, SSH_TUNNEL_DEFAULTS.port),
    user: String(v.user ?? "").trim(),
    remotePort: toPort(v.remotePort, SSH_TUNNEL_DEFAULTS.remotePort),
    keyPath: String(v.keyPath ?? "").trim(),
    localPort: Number.isInteger(Number(v.localPort)) && Number(v.localPort) > 0 ? Number(v.localPort) : 0
  };
}
function sshTunnelConfigured(cfg) {
  return Boolean(cfg && cfg.host && cfg.user && cfg.keyPath);
}
function sshBinary() {
  if (process.platform === "win32") {
    const p = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
    if (existsSync2(p)) return p;
  }
  return "ssh";
}
function knownHostsNull() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}
function childEnv() {
  return { ...process.env, SSH_ASKPASS: "", DISPLAY: "" };
}
function buildSshArgs(cfg, localPort) {
  const args = [
    "-N",
    "-R",
    `0.0.0.0:${cfg.remotePort}:127.0.0.1:${localPort}`,
    "-i",
    cfg.keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${knownHostsNull()}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "TCPKeepAlive=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=10",
    // ERROR 级别仍会打印 `Error: remote port forwarding failed for listen port N`
    // （2026-10-20 实测），足够分类，又不至于把 stderr 灌满。
    "-o",
    "LogLevel=ERROR",
    "-o",
    "BatchMode=yes"
  ];
  if (cfg.port && cfg.port !== 22) args.push("-p", String(cfg.port));
  args.push(cfg.user ? `${cfg.user}@${cfg.host}` : String(cfg.host));
  return args;
}
function buildRemoteCmdArgs(cfg) {
  const args = [
    "-T",
    "-i",
    cfg.keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${knownHostsNull()}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "BatchMode=yes"
  ];
  if (cfg.port && cfg.port !== 22) args.push("-p", String(cfg.port));
  args.push(cfg.user ? `${cfg.user}@${cfg.host}` : String(cfg.host));
  return args;
}
function oneLine(s, limit = 320) {
  const lines = String(s ?? "").replace(/\r/g, "").split("\n").map((x) => x.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).filter(Boolean);
  return lines.slice(-3).join(" / ").slice(0, limit);
}
var FAILURE_PATTERNS = Object.freeze([
  ["port_occupied", /remote port forwarding failed|remote forward failure|port forwarding failed|could not request remote|address already in use/i],
  ["auth", /permission denied|too many authentication|no supported authentication|no matching (?:key|host key|public key)|invalid format|unprotected private key|bad permissions|load private key|no such identity|not allowed because/i],
  ["hostkey", /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|man-in-the-middle/i],
  ["dns", /could not resolve hostname|name or service not known|temporary failure in name resolution/i],
  ["network", /ssh: connect to host|connection timed out|connection refused|no route to host|network is unreachable|connection reset by peer|connection closed by remote host|kex_exchange_identification|server unexpectedly closed|timeout, server not responding|broken pipe|packet write/i]
]);
function classifySshFailure(stderr, code = null) {
  const s = String(stderr ?? "");
  for (const [reason, re] of FAILURE_PATTERNS) {
    const m = s.match(re);
    if (m) return { reason, detail: oneLine(m[0], 120), code };
  }
  return { reason: s ? "unknown" : "unknown", detail: "", code };
}
function classifyProbeFailure(message) {
  const s = String(message ?? "");
  if (/ECONNREFUSED/i.test(s)) return "no_listener";
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|socket hang up|probe timeout|timed out/i.test(s)) {
    return /probe timeout|socket hang up|ECONNRESET|EPIPE/i.test(s) ? "stale_or_halfopen" : "network";
  }
  return "unknown";
}
var DIAG_MARKS = Object.freeze({
  tools: "@@DSHPOCKET_TOOLS@@",
  holders: "@@DSHPOCKET_HOLDERS@@",
  sshd: "@@DSHPOCKET_SSHD@@",
  tree: "@@DSHPOCKET_TREE@@",
  end: "@@DSHPOCKET_END@@"
});
var DIAG_ORDER = [DIAG_MARKS.tools, DIAG_MARKS.holders, DIAG_MARKS.sshd, DIAG_MARKS.tree, DIAG_MARKS.end];
function awkPortFilter(port) {
  return `awk '$4 ~ /:${port}$/'`;
}
function remoteDiagnoseCommand(cfg) {
  const p = Number(cfg.remotePort);
  const s = Number(cfg.port) || 22;
  return [
    `echo ${DIAG_MARKS.tools}`,
    "command -v ss; command -v awk; command -v ps",
    `echo ${DIAG_MARKS.holders}`,
    `ss -ltnp 2>/dev/null | ${awkPortFilter(p)}`,
    `echo ${DIAG_MARKS.sshd}`,
    `ss -ltnp 2>/dev/null | ${awkPortFilter(s)}`,
    `echo ${DIAG_MARKS.tree}`,
    "ps -o pid=,ppid=,comm= -C sshd,sshd-session 2>/dev/null",
    `echo ${DIAG_MARKS.end}`
  ].join("; ");
}
function parseRemoteDiagnosis(stdout) {
  const text = String(stdout ?? "").replace(/\r/g, "");
  const pos = [];
  for (const mark of DIAG_ORDER) {
    const i = text.indexOf(mark);
    if (i < 0) return { ok: false, error: "\u8FDC\u7AEF\u8BCA\u65AD\u8F93\u51FA\u4E0D\u5B8C\u6574\uFF08ssh \u672A\u5EFA\u7ACB\u6216\u8F93\u51FA\u88AB\u6539\u5199\uFF09\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | remote diagnosis incomplete" };
    pos.push(i);
  }
  for (let i = 1; i < pos.length; i += 1) {
    if (pos[i] <= pos[i - 1]) return { ok: false, error: "\u8FDC\u7AEF\u8BCA\u65AD\u8F93\u51FA\u987A\u5E8F\u5F02\u5E38\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | remote diagnosis out of order" };
  }
  const section = (mark) => {
    const idx = DIAG_ORDER.indexOf(mark);
    const start = pos[idx] + mark.length;
    const end = idx + 1 < DIAG_ORDER.length ? pos[idx + 1] : text.length;
    return text.slice(start, end).split("\n").map((l) => l.trim()).filter(Boolean);
  };
  const tools = section(DIAG_MARKS.tools);
  const has = (name2) => tools.some((t) => new RegExp(`(^|/)${name2}$`).test(t));
  if (!has("ss") || !has("awk") || !has("ps")) {
    return { ok: false, error: `\u8FDC\u7AEF\u7F3A\u5C11 ss/awk/ps\uFF0C\u65E0\u6CD5\u786E\u8BA4\u7AEF\u53E3\u5360\u7528\u8005\u8EAB\u4EFD\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | remote lacks ss/awk/ps: ${tools.join(",") || "(empty)"}` };
  }
  return { ok: true, tools, holders: section(DIAG_MARKS.holders), sshdListeners: section(DIAG_MARKS.sshd), tree: section(DIAG_MARKS.tree) };
}
function parseSsLine(line) {
  const cols = line.split(/\s+/);
  const owners = [];
  const usersMatch = line.match(/users:\((.+)\)\s*$/);
  const body = usersMatch ? usersMatch[1] : "";
  const quoted = /"([^"]*)",\s*pid=(\d+)/g;
  let m;
  while ((m = quoted.exec(body)) !== null) owners.push({ name: m[1], pid: Number(m[2]) });
  if (!owners.length) {
    const plain = /([A-Za-z0-9_@:.[\]+%/ -]+),\s*pid=(\d+)/g;
    while ((m = plain.exec(body)) !== null) owners.push({ name: m[1], pid: Number(m[2]) });
  }
  return { state: cols[0] ?? "", addr: cols[3] ?? "", owners, raw: line.slice(0, 200) };
}
function parsePsLine(line) {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] };
}
function planRemoteKills(parsed, cfg) {
  const port = Number(cfg?.remotePort);
  const sshPort = Number(cfg?.port) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "\u8FDC\u7AEF\u7AEF\u53E3\u914D\u7F6E\u975E\u6CD5\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | invalid remote port" };
  if (port === sshPort) return { ok: false, error: `\u8FDC\u7AEF\u7AEF\u53E3\u5C31\u662F SSH \u670D\u52A1\u7AEF\u53E3 :${sshPort}\uFF0C\u62D2\u7EDD\u6E05\u7406 | refusing to touch the sshd service port` };
  if (!parsed || parsed.ok === false) return { ok: false, error: parsed?.error ?? "\u7F3A\u5C11\u8BCA\u65AD\u7ED3\u679C | no diagnosis" };
  const holders = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of parsed.holders) {
    const line = parseSsLine(raw);
    if (!/^(LISTEN|UNQ)/i.test(line.state)) {
      return { ok: false, error: `\u7AEF\u53E3 ${port} \u7684\u76D1\u542C\u884C\u65E0\u6CD5\u89E3\u6790\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | unparsable listener line: ${line.raw}` };
    }
    if (!line.owners.length) {
      return { ok: false, error: `\u7AEF\u53E3 ${port} \u7684\u5360\u7528\u8005\u8EAB\u4EFD\u4E0D\u53EF\u89C1\uFF08\u6743\u9650\u6216\u5185\u6838 socket\uFF09\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | cannot identify holder: ${line.raw}` };
    }
    for (const o of line.owners) {
      if (!/^sshd/i.test(o.name) || !Number.isInteger(o.pid)) {
        return { ok: false, error: `\u7AEF\u53E3 ${port} \u88AB\u975E sshd \u8FDB\u7A0B\u5360\u7528\uFF08${o.name || "?"} pid=${o.pid}\uFF09\uFF0C\u62D2\u7EDD\u6E05\u7406 | port held by non-sshd process` };
      }
      if (!seen.has(o.pid)) {
        seen.add(o.pid);
        holders.push({ pid: o.pid, name: o.name, addr: line.addr });
      }
    }
  }
  if (!holders.length) return { ok: true, holders: [], kill: [], note: `\u8FDC\u7AEF\u7AEF\u53E3 ${port} \u7A7A\u95F2\uFF0C\u65E0\u9700\u6E05\u7406 | remote port free` };
  const protectedPids = /* @__PURE__ */ new Set([1]);
  for (const raw of parsed.sshdListeners) for (const o of parseSsLine(raw).owners) if (Number.isInteger(o.pid)) protectedPids.add(o.pid);
  const tree = parsed.tree.map(parsePsLine).filter(Boolean);
  const byPid = new Map(tree.map((p) => [p.pid, p]));
  const childrenOf = /* @__PURE__ */ new Map();
  for (const p of tree) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p.pid);
  }
  const kill = [];
  const killSet = /* @__PURE__ */ new Set();
  const add = (entry) => {
    if (!killSet.has(entry.pid)) {
      killSet.add(entry.pid);
      kill.push(entry);
    }
  };
  for (const h of holders) {
    if (h.pid <= 1) return { ok: false, error: `\u5360\u7528\u8FDB\u7A0B pid=${h.pid} \u975E\u6CD5\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | refusing to touch pid ${h.pid}` };
    if (protectedPids.has(h.pid)) return { ok: false, error: `\u5360\u7528\u8FDB\u7A0B\u540C\u65F6\u662F SSH(:${sshPort}) \u76D1\u542C\u8FDB\u7A0B\uFF0C\u62D2\u7EDD\u6E05\u7406 | holder is also the sshd service listener` };
    add({ pid: h.pid, name: h.name, role: "holder" });
    let cur = h.pid;
    for (let depth = 0; depth < 3; depth += 1) {
      const node = byPid.get(cur);
      if (!node) break;
      const parent = byPid.get(node.ppid);
      if (!parent || parent.pid <= 1) break;
      if (protectedPids.has(parent.pid)) break;
      if (!/^sshd/i.test(parent.comm)) break;
      const kids = childrenOf.get(parent.pid) ?? [];
      if (!kids.length || !kids.every((k) => killSet.has(k))) break;
      add({ pid: parent.pid, name: parent.comm, role: "priv-parent" });
      cur = parent.pid;
    }
  }
  if (kill.length > MAX_KILL_TARGETS) {
    return { ok: false, error: `\u6E05\u7406\u76EE\u6807\u8FC7\u591A\uFF08${kill.length} \u4E2A pid\uFF09\uFF0C\u5224\u5B9A\u4E3A\u5F02\u5E38\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | too many kill targets` };
  }
  return { ok: true, holders, kill };
}
function runRemoteSsh(cfg, command, timeoutMs = 2e4, { execFn = execFile } = {}) {
  if (!sshTunnelConfigured(cfg)) return Promise.resolve({ ok: false, error: "SSH \u96A7\u9053\u672A\u914D\u7F6E | not configured", stdout: "", stderr: "" });
  return new Promise((resolve) => {
    let args;
    try {
      args = [...buildRemoteCmdArgs(cfg), command];
    } catch (err) {
      resolve({ ok: false, error: oneLine(err?.message ?? err), stdout: "", stderr: "" });
      return;
    }
    try {
      execFn(
        sshBinary(),
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20, env: childEnv() },
        (err, stdout, stderr) => {
          const killed = Boolean(err && err.killed);
          resolve({
            ok: !err,
            killed,
            exitCode: err && Number.isInteger(err.code) ? err.code : err ? 1 : 0,
            error: err ? killed ? `timeout after ${timeoutMs}ms` : oneLine(err.message ?? err) : "",
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            reason: err ? classifySshFailure(stderr).reason : ""
          });
        }
      );
    } catch (err) {
      resolve({ ok: false, error: `ssh \u6267\u884C\u5931\u8D25: ${oneLine(err?.message ?? err)}`, stdout: "", stderr: "", killed: false, exitCode: 1, reason: "unknown" });
    }
  });
}
async function reclaimRemotePort(cfg, {
  log = console,
  run = runRemoteSsh,
  // 注意：不能 unref——这是被 await 的清理间隔，unref 会让短命进程（维护脚本）在
  // 清理进行到一半时因为没有其它句柄而直接退出（2026-10-20 故障注入实测踩到）。
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  diagnoseCommand = remoteDiagnoseCommand,
  timeoutMs = 2e4
} = {}) {
  const rec = { at: Date.now(), ok: false, holders: [], kill: [], killed: [], error: "", note: "", stage: "diagnose" };
  const info = (...a) => (log.info ?? log.log)?.call(log, ...a);
  const warn = (...a) => log.warn?.(...a);
  if (!sshTunnelConfigured(cfg)) {
    rec.error = "SSH \u96A7\u9053\u672A\u914D\u7F6E | not configured";
    return rec;
  }
  if (Number(cfg.remotePort) === (Number(cfg.port) || 22)) {
    rec.error = "\u8FDC\u7AEF\u7AEF\u53E3\u5373 SSH \u670D\u52A1\u7AEF\u53E3\uFF0C\u62D2\u7EDD\u6E05\u7406 | refusing ssh port";
    return rec;
  }
  const diag = await run(cfg, diagnoseCommand(cfg), timeoutMs);
  rec.stage = "diagnose";
  if (diag.killed) {
    rec.error = "\u8FDC\u7AEF\u8BCA\u65AD\u8D85\u65F6\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | diagnosis timed out";
    return rec;
  }
  if (diag.error && !diag.stdout.trim()) {
    const tail = oneLine(diag.stderr || diag.error, 200);
    rec.error = `\u8FDC\u7AEF\u8BCA\u65AD\u8FDE\u63A5\u5931\u8D25\uFF08${diag.reason || "unknown"}\uFF09\uFF1A${tail}`;
    return rec;
  }
  const parsed = parseRemoteDiagnosis(diag.stdout);
  if (!parsed.ok) {
    rec.error = parsed.error;
    return rec;
  }
  const plan = planRemoteKills(parsed, cfg);
  rec.holders = (plan.holders ?? []).map((h) => ({ pid: h.pid, name: h.name }));
  rec.kill = (plan.kill ?? []).map((k) => ({ pid: k.pid, name: k.name, role: k.role }));
  if (!plan.ok) {
    rec.error = plan.error;
    return rec;
  }
  if (!plan.kill.length) {
    rec.ok = true;
    rec.note = plan.note ?? "\u65E0\u9700\u6E05\u7406";
    rec.stage = "free";
    return rec;
  }
  const pids = plan.kill.map((k) => k.pid).filter((p) => Number.isInteger(p) && p > 1);
  const pidArg = pids.join(" ");
  if (!pids.length || !/^\d+( \d+)*$/.test(pidArg)) {
    rec.error = "\u6E05\u7406\u76EE\u6807 pid \u4E0D\u5408\u6CD5\uFF0C\u5DF2\u653E\u5F03\u81EA\u52A8\u6E05\u7406 | invalid pid list";
    return rec;
  }
  warn(`dsh-pocket: remote port ${cfg.remotePort} held by ${rec.kill.map((k) => `${k.name}(pid=${k.pid})`).join(", ")} \u2014 cleaning up | \u8FDC\u7AEF\u7AEF\u53E3\u88AB\u65E7\u96A7\u9053\u5360\u7528\uFF0C\u81EA\u52A8\u6E05\u7406`);
  rec.stage = "term";
  await run(cfg, `kill ${pidArg}`, 15e3);
  rec.killed = pids;
  await sleep(1500);
  let still = await run(cfg, `ss -ltnp 2>/dev/null | ${awkPortFilter(cfg.remotePort)}`, 15e3);
  if (String(still.stdout ?? "").trim()) {
    rec.stage = "kill";
    await run(cfg, `kill -KILL ${pidArg}`, 15e3);
    await sleep(1200);
    still = await run(cfg, `ss -ltnp 2>/dev/null | ${awkPortFilter(cfg.remotePort)}`, 15e3);
  }
  const free = !String(still.stdout ?? "").trim();
  rec.ok = free;
  rec.error = free ? "" : `\u6E05\u7406\u540E\u8FDC\u7AEF\u7AEF\u53E3 ${cfg.remotePort} \u4ECD\u88AB\u5360\u7528 | port still held`;
  if (free) info(`dsh-pocket: remote port ${cfg.remotePort} released (pid ${pidArg}) | \u8FDC\u7AEF\u7AEF\u53E3\u5DF2\u91CA\u653E`);
  return rec;
}
var DEFAULT_CLEANUP_LIMIT = MAX_AUTO_CLEANUPS;
function createSshTunnel({
  getConfig,
  getLocalPort = () => 3081,
  log = console,
  probeIntervalMs = 2e4,
  probeTimeoutMs = 8e3,
  maxBackoffMs = 6e4,
  startingGraceMs = 45e3,
  cleanupLimit = DEFAULT_CLEANUP_LIMIT,
  spawnFn = spawn2,
  execFn = execFile,
  reclaim = reclaimRemotePort,
  findProcesses = findTunnelProcesses
} = {}) {
  const info = (...a) => (log.info ?? log.log).call(log, ...a);
  const warn = (...a) => log.warn.call(log, ...a);
  const state = {
    phase: "off",
    // off | starting | online | retrying | error
    reason: "",
    // port_occupied | auth | hostkey | dns | network | key_missing | cleanup_limit | probe | spawn | unknown
    adopted: false,
    // 已有一份健康隧道，不是本进程拉起的
    adoptedExternal: false,
    // 收养的是外部（手动/维护进程）起的隧道
    adoptedPid: null,
    // 收养时看到的本机 ssh pid
    pid: null,
    restarts: 0,
    attempts: 0,
    // 连续重连轮次（上线归零）
    autoKills: 0,
    // 连续自动清理次数（上线归零）
    cleanups: [],
    // 自动清理记录（最近 8 条）
    lastError: "",
    lastErrorAt: null,
    lastStderr: "",
    lastProbeAt: null,
    lastProbeStatus: 0,
    nextRetryAt: null,
    spawnedAt: null,
    url: ""
  };
  let child = null;
  let stopped = true;
  let probeTimer = null;
  let retryTimer = null;
  let backoff = 3e3;
  let failures = 0;
  const expectedExits = /* @__PURE__ */ new WeakSet();
  let starting = null;
  const currentConfig = () => normalizeSshTunnelConfig(typeof getConfig === "function" ? getConfig() : getConfig);
  function currentLocalPort(cfg) {
    const p = cfg.localPort > 0 ? cfg.localPort : Number(getLocalPort());
    return toPort(p, 3081);
  }
  function urlOf(cfg) {
    return cfg.host ? `http://${cfg.host}:${cfg.remotePort}` : "";
  }
  function setFailed(reason, message) {
    state.reason = reason || "unknown";
    state.lastError = oneLine(message, 400);
    state.lastErrorAt = Date.now();
  }
  function pushCleanup(rec) {
    state.cleanups = [rec, ...state.cleanups].slice(0, 8);
  }
  function probeOnce(cfg) {
    return new Promise((resolve) => {
      try {
        const req = http.request(
          {
            host: cfg.host,
            port: cfg.remotePort,
            path: "/",
            method: "GET",
            timeout: probeTimeoutMs,
            headers: { "user-agent": "dsh-pocket-tunnel-probe" }
          },
          (res) => {
            res.resume();
            state.lastProbeAt = Date.now();
            state.lastProbeStatus = res.statusCode ?? 0;
            resolve({ ok: true, status: res.statusCode ?? 0 });
          }
        );
        req.on("timeout", () => {
          req.destroy(new Error("probe timeout"));
        });
        req.on("error", (err) => {
          state.lastProbeAt = Date.now();
          state.lastProbeStatus = 0;
          resolve({ ok: false, error: err?.message ?? String(err) });
        });
        req.end();
      } catch (err) {
        resolve({ ok: false, error: err?.message ?? String(err) });
      }
    });
  }
  function clearTimers() {
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }
  function ensureProbeTimer() {
    if (probeTimer || stopped) return;
    probeTimer = setInterval(() => {
      void checkOnceSafely(false);
    }, probeIntervalMs);
    if (probeTimer.unref) probeTimer.unref();
  }
  function scheduleRetry(cfg, why, { reason = null, delayMs = null } = {}) {
    if (stopped) return;
    setFailed(reason ?? state.reason, why ?? state.lastError);
    state.attempts += 1;
    state.phase = "retrying";
    const delay = Number.isInteger(delayMs) ? Math.max(500, delayMs) : backoff;
    state.nextRetryAt = Date.now() + delay;
    info(`dsh-pocket: ssh tunnel down (${reason ?? state.reason}, attempt ${state.attempts}) \u2014 retry in ${Math.round(delay / 1e3)}s | \u56FA\u5B9A\u516C\u7F51\u96A7\u9053\u65AD\u5F00\uFF08${state.attempts} \u6B21\u91CD\u8BD5\uFF0C${Math.round(delay / 1e3)} \u79D2\u540E\u91CD\u8FDE\uFF09`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      void startSafely();
    }, delay);
    if (retryTimer.unref) retryTimer.unref();
    backoff = Math.min(maxBackoffMs, Math.round(backoff * 2));
  }
  function markOnline(cfg) {
    failures = 0;
    backoff = 3e3;
    state.attempts = 0;
    state.autoKills = 0;
    state.phase = "online";
    state.reason = "";
    state.lastError = "";
    state.nextRetryAt = null;
    state.url = urlOf(cfg);
  }
  function killChild() {
    if (!child) return;
    const c = child;
    child = null;
    state.pid = null;
    expectedExits.add(c);
    try {
      c.kill();
    } catch {
    }
  }
  function spawnTunnel(cfg, localPort) {
    const args = buildSshArgs(cfg, localPort);
    info(`dsh-pocket: starting ssh reverse tunnel ${cfg.host}:${cfg.remotePort} -> 127.0.0.1:${localPort} | \u542F\u52A8\u56FA\u5B9A\u516C\u7F51\u96A7\u9053`);
    let c;
    try {
      c = spawnFn(sshBinary(), args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        env: childEnv()
      });
    } catch (err) {
      setFailed("spawn", `spawn failed: ${err?.message ?? err}`);
      warn(`dsh-pocket: ssh spawn threw | \u62C9\u8D77 ssh \u5931\u8D25: ${state.lastError}`);
      scheduleRetry(cfg, state.lastError, { reason: "spawn" });
      return;
    }
    child = c;
    state.pid = c.pid ?? null;
    state.spawnedAt = Date.now();
    state.adopted = false;
    state.adoptedExternal = false;
    state.adoptedPid = null;
    state.phase = "starting";
    let stderrTail = "";
    if (c.stderr) {
      try {
        c.stderr.setEncoding("utf8");
      } catch {
      }
      c.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-STDERR_LIMIT);
      });
      c.stderr.on("error", () => {
      });
    }
    c.once("error", (err) => {
      if (child === c) {
        child = null;
        state.pid = null;
      }
      scheduleRetry(cfg, `spawn failed: ${err?.message ?? err}`, { reason: "spawn" });
    });
    c.once("exit", (code, signal) => {
      if (child === c) {
        child = null;
        state.pid = null;
      }
      if (expectedExits.has(c)) {
        expectedExits.delete(c);
        return;
      }
      if (stopped) return;
      const cls = classifySshFailure(stderrTail, code);
      state.lastStderr = oneLine(stderrTail, 300);
      setFailed(cls.reason, `ssh exited (code=${code}${signal ? `, signal=${signal}` : ""})${state.lastStderr ? `: ${state.lastStderr}` : ""}`);
      state.restarts += 1;
      if (cls.reason === "port_occupied") {
        warn("dsh-pocket: ssh refused to bind remote port \u2014 stale remote tunnel | \u8FDC\u7AEF\u7AEF\u53E3\u88AB\u65E7\u96A7\u9053\u5360\u7528\uFF0C\u51C6\u5907\u81EA\u52A8\u6E05\u7406");
        scheduleRetry(cfg, state.lastError, { reason: "port_occupied", delayMs: Math.min(backoff, 2e3) });
        return;
      }
      scheduleRetry(cfg, state.lastError, { reason: cls.reason });
    });
    const t = setTimeout(() => {
      void checkOnceSafely(true);
    }, 3500);
    if (t.unref) t.unref();
  }
  async function maybeReclaimRemotePort(cfg, probeClass) {
    if (probeClass === "no_listener") return true;
    if (state.autoKills >= cleanupLimit) {
      const msg = `\u8FDC\u7AEF 0.0.0.0:${cfg.remotePort} \u4ECD\u88AB\u65E7\u96A7\u9053\u5360\u7528\uFF0C\u81EA\u52A8\u6E05\u7406\u5DF2\u8FDE\u7EED\u5C1D\u8BD5 ${state.autoKills} \u6B21\u4ECD\u672A\u6062\u590D\uFF0C\u9700\u8981\u4EBA\u5DE5\u5904\u7406\uFF08\u6216\u5728\u670D\u52A1\u5668\u4E0A kill \u6389\u76D1\u542C ${cfg.remotePort} \u7684 sshd-session\uFF09| auto cleanup limit reached`;
      setFailed("cleanup_limit", msg);
      warn(`dsh-pocket: remote port cleanup limit reached (${state.autoKills}/${cleanupLimit}) \u2014 giving up on reclaim | \u81EA\u52A8\u6E05\u7406\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u9700\u4EBA\u5DE5\u5904\u7406`);
      pushCleanup({ at: Date.now(), ok: false, stage: "limit", error: msg, holders: [], kill: [], killed: [] });
      return false;
    }
    state.autoKills += 1;
    let rec;
    try {
      rec = await reclaim(cfg, { log, run: (c, command, ms) => runRemoteSsh(c, command, ms, { execFn }) });
    } catch (err) {
      rec = { at: Date.now(), ok: false, stage: "error", error: oneLine(err?.message ?? err), holders: [], kill: [], killed: [] };
    }
    pushCleanup(rec);
    if (rec.ok) {
      info(`dsh-pocket: remote port reclaimed (attempt ${state.autoKills}/${cleanupLimit})${rec.killed?.length ? ` pid=${rec.killed.join(",")}` : ""} | \u8FDC\u7AEF\u7AEF\u53E3\u5DF2\u6E05\u7406`);
      return true;
    }
    setFailed("port_occupied", rec.error || "\u8FDC\u7AEF\u7AEF\u53E3\u6E05\u7406\u5931\u8D25 | remote reclaim failed");
    warn(`dsh-pocket: remote port reclaim failed: ${state.lastError} | \u8FDC\u7AEF\u7AEF\u53E3\u81EA\u52A8\u6E05\u7406\u5931\u8D25`);
    return false;
  }
  async function checkOnce(afterSpawn = false) {
    if (stopped) return;
    const cfg = currentConfig();
    if (!cfg.enabled) {
      stop();
      return;
    }
    if (!sshTunnelConfigured(cfg)) {
      setFailed("not_configured", "sshTunnel \u7F3A\u5C11 host / user \u6216 keyPath | missing host, user or keyPath");
      ensureProbeTimer();
      return;
    }
    if (child && state.phase === "starting" && state.spawnedAt && Date.now() - state.spawnedAt > startingGraceMs) {
      info("dsh-pocket: ssh not online within grace period \u2014 recycling | ssh \u957F\u65F6\u95F4\u672A\u5EFA\u7ACB\uFF0C\u56DE\u6536\u91CD\u8FDE");
      killChild();
      scheduleRetry(cfg, "ssh not online within grace period", { reason: "network", delayMs: 1e3 });
      return;
    }
    const probe = await probeOnce(cfg);
    if (stopped) return;
    if (probe.ok) {
      markOnline(cfg);
      if (afterSpawn) info(`dsh-pocket: ssh tunnel online \u2014 ${state.url} | \u56FA\u5B9A\u516C\u7F51\u5730\u5740\u5DF2\u53EF\u7528`);
      return;
    }
    if (!child && state.phase !== "online") return;
    if (!afterSpawn && child && state.spawnedAt && Date.now() - state.spawnedAt < 12e3) return;
    failures += 1;
    const need = afterSpawn ? 4 : 2;
    if (failures < need) return;
    failures = 0;
    if (child) {
      info("dsh-pocket: ssh tunnel probe failed \u2014 recycling process | \u96A7\u9053\u63A2\u6D3B\u5931\u8D25\uFF0C\u56DE\u6536 ssh \u8FDB\u7A0B\u91CD\u8FDE");
      killChild();
    } else {
      state.adopted = false;
      state.adoptedPid = null;
      state.adoptedExternal = false;
    }
    setFailed("probe", `probe failed: ${probe.error ?? "unknown"}`);
    scheduleRetry(currentConfig(), state.lastError, { reason: "probe" });
  }
  function checkOnceSafely(afterSpawn = false) {
    return Promise.resolve().then(() => checkOnce(afterSpawn)).catch((err) => {
      warn(`dsh-pocket: ssh tunnel probe threw | \u96A7\u9053\u63A2\u6D3B\u5F02\u5E38: ${oneLine(err?.message ?? err)}`);
      if (!stopped) scheduleRetry(currentConfig(), `probe threw: ${err?.message ?? err}`, { reason: "unknown" });
    });
  }
  function startSafely() {
    return Promise.resolve().then(() => start()).catch((err) => {
      setFailed("unknown", `start failed: ${err?.message ?? err}`);
      warn(`dsh-pocket: ssh tunnel start threw | \u56FA\u5B9A\u516C\u7F51\u96A7\u9053\u542F\u52A8\u5F02\u5E38: ${state.lastError}`);
      if (!stopped) scheduleRetry(currentConfig(), state.lastError, { reason: "unknown" });
    });
  }
  async function start() {
    if (starting) return starting;
    starting = (async () => {
      await null;
      const cfg = currentConfig();
      state.url = urlOf(cfg);
      if (!cfg.enabled || !sshTunnelConfigured(cfg)) {
        state.reason = cfg.enabled ? "not_configured" : "";
        stop();
        return;
      }
      stopped = false;
      if (!existsSync2(cfg.keyPath)) {
        setFailed("key_missing", `private key not found: ${cfg.keyPath} | \u627E\u4E0D\u5230\u79C1\u94A5`);
        warn(`dsh-pocket: ssh key not found: ${cfg.keyPath} | \u627E\u4E0D\u5230\u79C1\u94A5\uFF0C\u56FA\u5B9A\u516C\u7F51\u5730\u5740\u6682\u65F6\u65E0\u6CD5\u542F\u52A8\uFF08\u4F1A\u6301\u7EED\u91CD\u8BD5\uFF09`);
        scheduleRetry(cfg, state.lastError, { reason: "key_missing" });
        return;
      }
      if (child) {
        ensureProbeTimer();
        return;
      }
      const probe = await probeOnce(cfg);
      if (stopped) return;
      if (probe.ok) {
        markOnline(cfg);
        state.adopted = true;
        state.phase = "online";
        let pids = [];
        try {
          pids = await findProcesses(cfg, { execFn });
        } catch {
        }
        state.adoptedPid = pids[0] ?? null;
        state.adoptedExternal = true;
        info(`dsh-pocket: existing ssh tunnel adopted \u2014 ${state.url}${state.adoptedPid ? ` (local ssh pid=${state.adoptedPid})` : " (external process)"} | \u5DF2\u6709\u56FA\u5B9A\u516C\u7F51\u96A7\u9053\uFF0C\u76F4\u63A5\u6CBF\u7528\uFF08\u4E0D\u518D\u65B0\u5EFA\uFF09`);
        ensureProbeTimer();
        return;
      }
      const killedLocal = await killStaleTunnels(cfg, {
        execFn,
        onKill: (pids) => info(`dsh-pocket: killed stale local ssh tunnel pid=${pids.join(",")} | \u6E05\u7406\u672C\u673A\u6B8B\u7559\u96A7\u9053`)
      });
      if (killedLocal.length) pushCleanup({ at: Date.now(), ok: true, stage: "local", holders: [], kill: [], killed: killedLocal, error: "" });
      if (stopped) return;
      const probeClass = classifyProbeFailure(probe.error);
      if (probeClass === "stale_or_halfopen" || probeClass === "unknown") {
        await maybeReclaimRemotePort(cfg, probeClass);
      } else {
        setFailed("network", `probe failed: ${probe.error ?? "unknown"}`);
      }
      if (stopped) return;
      spawnTunnel(cfg, currentLocalPort(cfg));
      ensureProbeTimer();
    })().finally(() => {
      starting = null;
    });
    return starting;
  }
  function stop() {
    stopped = true;
    clearTimers();
    killChild();
    state.phase = "off";
    state.adopted = false;
    state.adoptedExternal = false;
    state.adoptedPid = null;
    state.nextRetryAt = null;
    state.attempts = 0;
  }
  async function restart() {
    stop();
    state.restarts = 0;
    state.autoKills = 0;
    state.reason = "";
    state.lastError = "";
    backoff = 3e3;
    failures = 0;
    return start();
  }
  function status() {
    const cfg = currentConfig();
    return {
      enabled: cfg.enabled,
      configured: sshTunnelConfigured(cfg),
      host: cfg.host,
      remotePort: cfg.remotePort,
      sshPort: cfg.port,
      user: cfg.user,
      keySet: Boolean(cfg.keyPath),
      // 只暴露私钥文件名（不含目录）与是否存在——足够诊断 key_missing，不把本机路径全发给手机
      keyName: String(cfg.keyPath ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "",
      keyExists: Boolean(cfg.keyPath) && existsSync2(cfg.keyPath),
      localPort: currentLocalPort(cfg),
      url: state.url || urlOf(cfg),
      phase: state.phase,
      reason: state.reason,
      adopted: state.adopted,
      adoptedExternal: state.adoptedExternal,
      adoptedPid: state.adoptedPid,
      pid: state.pid,
      restarts: state.restarts,
      attempts: state.attempts,
      autoKills: state.autoKills,
      cleanupLimit,
      cleanups: state.cleanups.slice(0, 4).map((r) => ({
        at: r.at,
        ok: r.ok,
        stage: r.stage,
        killed: r.killed ?? [],
        holders: (r.holders ?? []).map((h) => `${h.name || "?"}:${h.pid}`),
        error: r.error ?? ""
      })),
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      lastStderr: state.lastStderr,
      lastProbeAt: state.lastProbeAt,
      lastProbeStatus: state.lastProbeStatus,
      nextRetryAt: state.nextRetryAt
    };
  }
  return { start, startSafely, stop, restart, status, checkOnce, probeOnce, _state: state };
}

// src/pocket-host/ip.mjs
function isValidIpv4(value) {
  const m = String(value ?? "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m !== null && m.slice(1).every((part) => {
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

// src/pocket-host/service.mjs
var require2 = createRequire(import.meta.url);
async function qrDataUrl(text, { width = 220, margin = 1 } = {}) {
  const QRCode = require2("qrcode");
  return QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin, width, type: "image/png" });
}
var PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/;
var PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;
var VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;
function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name2, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name2)) score += 20;
      else if (VPN_IFACE_RE.test(name2)) score -= 50;
      candidates.push({ ip, score, order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}
function detectWsl() {
  try {
    const v = readFileSync2("/proc/version", "utf8").toLowerCase();
    if (v.includes("microsoft") || v.includes("wsl")) return true;
  } catch {
  }
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}
function parseIpconfig(text, { includeVpn = false } = {}) {
  const out = [];
  const blocks = String(text).split(/\r?\n(?=\S)/);
  const ipRe = /IPv4[^0-9]{0,40}((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)/;
  for (const block of blocks) {
    const title = String(block.split(/\r?\n/)[0] ?? "");
    if (!includeVpn && VPN_IFACE_RE.test(title)) continue;
    const m = block.match(ipRe);
    if (m) out.push(m[0].replace(/^IPv4[^0-9]*/i, ""));
  }
  return out;
}
function runIpconfig() {
  const candidates = ["ipconfig.exe", "/mnt/c/Windows/System32/ipconfig.exe"];
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= candidates.length) return resolve(null);
      execFile2(candidates[i], [], { timeout: 5e3, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return tryNext(i + 1);
        resolve(String(stdout));
      });
    };
    tryNext(0);
  });
}
async function lanIPv4() {
  if (detectWsl()) {
    try {
      const out = await runIpconfig();
      const candidates = parseIpconfig(out ?? "");
      const ip = candidates.find((c) => PRIVATE_IPV4_RE.test(c)) ?? candidates[0];
      if (ip) return ip;
    } catch {
    }
  }
  return selectLanIPv4(networkInterfaces());
}
async function listLanCandidates() {
  if (detectWsl()) {
    try {
      const out = await runIpconfig();
      const ips2 = parseIpconfig(out ?? "", { includeVpn: true });
      if (ips2.length) return [...new Set(ips2)];
    } catch {
    }
  }
  const ips = [];
  for (const [name2, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      if (!ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}
function createPocketService({
  dshPort,
  port = 3081,
  home,
  internals = {},
  /** 局域网地址手动覆盖：返回 IPv4 字符串；空值表示自动选择 */
  getLanIpOverride,
  /** 局域网访问总开关：返回 boolean；默认开启。关闭后代理拒绝局域网 Host 请求 */
  getLanEnabled = () => true,
  /** 代理注入 HTML 的内容（桌面端补丁等由 lib/index.js 传入；默认 randomUUID polyfill） */
  injectHtml,
  /** 访问令牌认证配置（issue #13）：{ getToken, isProtected }，传给代理 */
  auth,
  /** @type {() => string} dsh web 浏览器会话启动 token（issue #77；老版本返回空字符串） */
  launchToken = () => "",
  /** 隧道配置（issue #66）：() => ({ mode:'quick'|'named', token, hostname })；named 用固定域名 */
  getTunnelConfig,
  /** 固定公网地址（SSH 反向隧道）配置读取：() => normalized config；由 lib/index.js 传入 */
  getSshTunnelConfig,
  /** 固定公网地址守护（测试注入：{ start, stop, restart, status }） */
  sshTunnel,
  /** 隧道就绪回调（lib/index.js 用它轮换公网密码；参数为 'quick'|'named'） */
  onTunnelReady,
  /** 鹈鹕（tihu）模拟设备：{ page: () => string, handleUpgrade: (req, socket, head) => boolean }。
   *  由 lib/index.js 传入；代理在鉴权之后把 /tihu 与 /tihu/lane 交给它。 */
  tihu = null,
  /** 日志（DSH 宿主 ctx.logger 有 info/warn/error；默认 console 无 info，自动退回 log）。
   *  隧道自动恢复的成败必须走这里：console 输出在 DSH Desktop 里不进日志文件，
   *  出问题时无法排查（2026-09-07 实测教训）。 */
  log = console
} = {}) {
  const logInfo = (...args) => (log.info ?? log.log).call(log, ...args);
  const logWarn = (...args) => log.warn(...args);
  const createProxy = internals.createProxy ?? createPocketProxy;
  const startTunnel = internals.startTunnel ?? startQuickTunnel;
  const startNamed = internals.startNamedTunnel ?? startNamedTunnel;
  const getLanOverride = () => {
    const value = String(getLanIpOverride?.() ?? "").trim();
    return isValidIpv4(value) ? value : "";
  };
  const getLan = async () => getLanOverride() || (internals.lanIPv4 ? internals.lanIPv4() : lanIPv4());
  let lanCandidateCache = null;
  const getLanCandidates = async () => {
    if (internals.lanCandidates) return internals.lanCandidates();
    const now = Date.now();
    if (!lanCandidateCache || now - lanCandidateCache.at > 15e3) {
      lanCandidateCache = { at: now, ips: await listLanCandidates() };
    }
    return lanCandidateCache.ips;
  };
  let proxy = null;
  const fixedTunnel = sshTunnel ?? (getSshTunnelConfig ? createSshTunnel({
    getConfig: getSshTunnelConfig,
    getLocalPort: () => proxy?.port ?? port,
    log
  }) : null);
  let tunnel = null;
  let tunnelAbort = null;
  let tunnelPromise = null;
  const tunnelState = { phase: "idle", detail: "", startedAt: null };
  const qrCache = /* @__PURE__ */ new Map();
  const encodeQr = internals.encodeQr ?? qrDataUrl;
  async function qrCached(text) {
    if (!text) return null;
    if (!qrCache.has(text)) {
      if (qrCache.size >= 8) {
        const oldest = qrCache.keys().next().value;
        qrCache.delete(oldest);
      }
      qrCache.set(text, encodeQr(text).catch(() => null));
    }
    return qrCache.get(text);
  }
  const autoStatePath = home ? join3(home, "dsh-pocket", "tunnel-auto.json") : null;
  let autoStateQueue = Promise.resolve();
  function persistAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try {
        await mkdir2(dirname3(autoStatePath), { recursive: true });
        await writeFile(autoStatePath, JSON.stringify({ at: Date.now() }), "utf8");
      } catch {
      }
    });
    return autoStateQueue;
  }
  function clearAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try {
        await rm2(autoStatePath, { force: true });
      } catch {
      }
    });
    return autoStateQueue;
  }
  return {
    dshPort,
    /** 启动局域网代理（幂等）。端口被占（EADDRINUSE，如桌面版与普通环境同时运行）时自动尝试下一个端口。 */
    async startProxy() {
      if (proxy) return proxy;
      let lastErr = null;
      for (let p = port; p < port + 10; p++) {
        try {
          proxy = await createProxy({
            port: p,
            host: "0.0.0.0",
            upstream: { host: "127.0.0.1", port: dshPort },
            ...injectHtml ? { injectHtml } : {},
            ...auth ? { auth } : {},
            // 每次请求实时读开关：设置页切换后立即生效，无需重启代理
            lanAccessEnabled: () => getLanEnabled(),
            // dsh web 浏览器会话启动 token（issue #77）：实时取，新版 dsh 才有
            ...launchToken ? { launchToken } : {},
            // 鹈鹕（tihu）：页面与 lane 都在鉴权之后接走，不额外开端口
            ...tihu ? { tihu } : {}
          });
          if (p !== port) {
            logInfo(`dsh-pocket: port ${port} busy, proxy on ${p} | \u7AEF\u53E3 ${port} \u88AB\u5360\u7528\uFF0C\u4EE3\u7406\u6539\u7528 ${p}`);
          }
          break;
        } catch (err) {
          if (err?.code !== "EADDRINUSE") throw err;
          lastErr = err;
        }
      }
      if (!proxy) throw lastErr ?? new Error("proxy start failed | \u4EE3\u7406\u542F\u52A8\u5931\u8D25");
      if (fixedTunnel) {
        void fixedTunnel.start().catch((err) => {
          logWarn("dsh-pocket: fixed tunnel start failed | \u56FA\u5B9A\u516C\u7F51\u96A7\u9053\u542F\u52A8\u5931\u8D25: %s", err?.message ?? err);
        });
      }
      return proxy;
    },
    /** 启动公网隧道（幂等；返回公网 URL）。进度写进 tunnelState。并发调用单飞。 */
    async startTunnel() {
      await this.startProxy();
      if (tunnel) return tunnel.url;
      if (tunnelPromise) return tunnelPromise;
      const controller = new AbortController();
      tunnelAbort = controller;
      tunnelState.startedAt = Date.now();
      const onPhase = (phase) => {
        tunnelState.phase = phase;
        if (phase === "downloading") tunnelState.detail = "\u9996\u6B21\u4E0B\u8F7D cloudflared\uFF08\u7EA6 20MB\uFF09| first run downloads cloudflared (~20MB)";
        else if (phase === "starting") tunnelState.detail = "\u542F\u52A8\u96A7\u9053\u8FDB\u7A0B\u2026 | starting tunnel\u2026";
        else if (phase === "registering") tunnelState.detail = "\u8FDE\u63A5 Cloudflare \u8FB9\u7F18\uFF08\u901A\u5E38 5-30 \u79D2\uFF09| connecting to Cloudflare edge (usually 5-30s)";
        else if (phase === "ready") tunnelState.detail = "\u96A7\u9053\u5C31\u7EEA | ready";
      };
      const p = (async () => {
        await null;
        try {
          const cfg = typeof getTunnelConfig === "function" ? getTunnelConfig() ?? {} : {};
          if (cfg?.mode === "named") {
            if (!cfg.token || !cfg.hostname) {
              throw new Error(
                "\u547D\u540D\u96A7\u9053\u672A\u914D\u7F6E\u5B8C\u6574\uFF1A\u9700\u8981 Tunnel Token \u548C\u56FA\u5B9A\u57DF\u540D\uFF08\u8BBE\u7F6E\u9875\u300C\u56FA\u5B9A\u57DF\u540D\u300D\u91CC\u586B\u5199\uFF09 | named tunnel is incomplete \u2014 set the Tunnel Token and the fixed hostname in Settings"
              );
            }
            const result = await startNamed({ token: cfg.token, home, signal: controller.signal, onPhase });
            tunnel = { url: `https://${cfg.hostname}`, kill: result.kill, onExit: result.onExit };
          } else {
            const result = await startTunnel({ port: proxy.port, home, signal: controller.signal, onPhase });
            tunnel = typeof result === "string" ? { url: result, kill: () => {
            } } : result;
          }
          tunnelState.phase = "ready";
          tunnel.onExit?.((code) => {
            if (controller.signal.aborted) return;
            tunnelState.phase = "error";
            tunnelState.detail = `\u96A7\u9053\u8FDB\u7A0B\u9000\u51FA\uFF08code=${code}\uFF09 | tunnel process exited (code=${code})`;
          });
          void persistAutoTunnel();
          try {
            onTunnelReady?.(cfg?.mode === "named" ? "named" : "quick");
          } catch {
          }
          return tunnel.url;
        } catch (err) {
          if (!controller.signal.aborted) {
            tunnelState.phase = "error";
            tunnelState.detail = err?.message ?? String(err);
          }
          tunnelState.startedAt = null;
          throw err;
        } finally {
          if (tunnelPromise === p) tunnelPromise = null;
        }
      })();
      tunnelPromise = p;
      return p;
    },
    /**
     * 停止公网隧道（代理保持）。
     * @param {{ keepAutoMarker?: boolean }} [opts] - keepAutoMarker=true 用于进程退出/
     *   自重启（dispose / pocketRestart）：隧道是随进程被动消失的，不是用户主动关闭，
     *   必须保留 tunnel-auto.json，下次启动才能自动恢复（issue #11 的本意）。
     *   默认（设置页手动关闭、恢复出厂）删除标记。
     */
    stopTunnel({ keepAutoMarker = false } = {}) {
      tunnelAbort?.abort();
      tunnelAbort = null;
      tunnelPromise = null;
      if (tunnel) tunnel.kill();
      tunnel = null;
      tunnelState.phase = "idle";
      tunnelState.detail = "";
      tunnelState.startedAt = null;
      if (!keepAutoMarker) void clearAutoTunnel();
    },
    /** 启动时自动恢复上次开启的公网隧道（DSH 重启后 cloudflared 子进程被杀，issue #11）。 */
    async restoreTunnelIfNeeded() {
      logInfo("dsh-pocket: auto-restore check | \u81EA\u52A8\u6062\u590D\u68C0\u67E5\uFF1A\u8BFB\u53D6\u4E0A\u6B21\u96A7\u9053\u72B6\u6001");
      if (!autoStatePath || tunnel || tunnelPromise) return;
      let has = false;
      try {
        const raw = await readFile(autoStatePath, "utf8");
        has = /"at"\s*:/.test(raw);
      } catch {
        return;
      }
      if (!has) return;
      logInfo("dsh-pocket: auto-restore: marker found, starting tunnel | \u53D1\u73B0\u4E0A\u6B21\u5F00\u542F\u6807\u8BB0\uFF0C\u5C1D\u8BD5\u81EA\u52A8\u6062\u590D");
      try {
        await this.startTunnel();
        logInfo("dsh-pocket: public tunnel auto-restored | \u5DF2\u81EA\u52A8\u6062\u590D\u516C\u7F51\u96A7\u9053");
      } catch (err) {
        logWarn("dsh-pocket: tunnel auto-restore failed | \u81EA\u52A8\u6062\u590D\u96A7\u9053\u5931\u8D25: %s", err?.message ?? err);
      }
    },
    /** 状态快照（RPC 返回，不含敏感信息；二维码 data URL 本地生成 + 缓存）。 */
    async status() {
      const lan = await getLan();
      const proxyPort2 = proxy?.port ?? null;
      const lanUrl = lan && proxyPort2 ? `http://${lan}:${proxyPort2}` : null;
      const lanIpOverride2 = getLanOverride();
      const lanCandidates = [...new Set(await getLanCandidates())];
      if (lanIpOverride2 && !lanCandidates.includes(lanIpOverride2)) lanCandidates.push(lanIpOverride2);
      return {
        proxyRunning: proxy !== null,
        proxyPort: proxyPort2,
        lanUrl,
        lanQr: await qrCached(lanUrl),
        lanCandidates,
        lanIpOverride: lanIpOverride2,
        tunnelRunning: tunnel !== null,
        tunnelUrl: tunnel?.url ?? null,
        tunnelQr: await qrCached(tunnel?.url ?? null),
        tunnelState: { ...tunnelState },
        // 隧道配置脱敏视图（issue #66）：token 永不回显，只有 tokenSet 布尔值
        tunnelConfig: (() => {
          const cfg = typeof getTunnelConfig === "function" ? getTunnelConfig() ?? {} : {};
          return {
            mode: cfg?.mode === "named" ? "named" : "quick",
            hostname: typeof cfg?.hostname === "string" ? cfg.hostname : "",
            tokenSet: Boolean(cfg?.token)
          };
        })(),
        // 固定公网地址（SSH 反向隧道）状态：地址/在线阶段/是否沿用已有隧道/失败原因
        sshTunnel: fixedTunnel?.status() ?? null,
        dshPort
      };
    },
    /** 固定公网地址：按当前配置重启（设置改完后调用）。 */
    restartFixedTunnel() {
      return fixedTunnel?.restart?.() ?? Promise.resolve();
    },
    /** 固定公网地址：立即停止（关闭开关时调用）。 */
    stopFixedTunnel() {
      fixedTunnel?.stop?.();
    },
    /** 停止一切（插件卸载时）。 */
    /** 停止一切（插件卸载时）。进程退出不是用户手动关闭：保留自动恢复标记。 */
    async dispose() {
      try {
        fixedTunnel?.stop?.();
      } catch {
      }
      this.stopTunnel({ keepAutoMarker: true });
      if (proxy) {
        const p = proxy;
        proxy = null;
        try {
          await p.close();
        } catch {
        }
      }
    }
  };
}

// src/pocket-host/runtime.mjs
var GLOBAL_KEY = Symbol.for("dsh-assistant.pocket.runtime.v1");
function disposeService(service) {
  try {
    void Promise.resolve(service?.dispose?.()).catch(() => {
    });
  } catch {
  }
}
function acquirePocketRuntime(revision, factory, { graceMs = 15e3 } = {}) {
  const previous = globalThis[GLOBAL_KEY];
  if (previous && previous.revision === revision) {
    if (previous.disposeTimer) clearTimeout(previous.disposeTimer);
    previous.disposeTimer = null;
    previous.users++;
    return previous;
  }
  if (previous) {
    if (previous.disposeTimer) clearTimeout(previous.disposeTimer);
    process.removeListener("exit", previous.onExit);
    disposeService(previous.service);
  }
  const runtime = {
    revision,
    service: factory(),
    users: 1,
    graceMs,
    disposeTimer: null,
    onExit: null
  };
  runtime.onExit = () => disposeService(runtime.service);
  process.once("exit", runtime.onExit);
  globalThis[GLOBAL_KEY] = runtime;
  return runtime;
}
function releasePocketRuntime(runtime) {
  const current = globalThis[GLOBAL_KEY];
  if (!current || current !== runtime) return;
  current.users = Math.max(0, current.users - 1);
  if (current.users > 0) return;
  if (current.disposeTimer) clearTimeout(current.disposeTimer);
  current.disposeTimer = setTimeout(() => {
    if (globalThis[GLOBAL_KEY] !== current || current.users > 0) return;
    process.removeListener("exit", current.onExit);
    delete globalThis[GLOBAL_KEY];
    disposeService(current.service);
  }, current.graceMs);
  current.disposeTimer.unref?.();
}

// src/pocket-host/web-rpc.js
import { promises as fs2 } from "node:fs";
import path2 from "node:path";
import os2 from "node:os";

// src/client/pocket/api.js
var POCKET_RPC_CHANNEL = "/dsh-pocket";
var POCKET_ENDPOINTS = Object.freeze({
  status: "pocket.status",
  tunnelStart: "tunnel.start",
  tunnelStop: "tunnel.stop",
  tunnelSetConfig: "tunnel.setConfig",
  version: "pocket.version",
  update: "pocket.update",
  restart: "pocket.restart",
  lanTokenRefresh: "token.lanRefresh",
  lanAuthSetEnabled: "lanAuth.setEnabled",
  lanSetOverride: "lan.setOverride",
  lanSetEnabled: "lan.setEnabled",
  pinSetCustom: "pin.setCustom",
  pocketReset: "pocket.reset",
  // 固定公网地址（SSH 反向隧道）：开关；地址/主机等配置写 settings.json
  sshTunnelSetEnabled: "sshTunnel.setEnabled",
  // 六项连接配置（P0-4）：host / port / user / remotePort / keyPath / localPort（设置页可改）
  sshTunnelSetConfig: "sshTunnel.setConfig",
  // 立即重连（自愈失败时的人工触发）：会先收养健康隧道，再清理远端旧占用，最后新建
  sshTunnelReconnect: "sshTunnel.reconnect",
  // 移动端「复制文件内容」（issue #17）：手机经此 RPC 让主机读取文件正文，
  // 再写入剪贴板——因为手机无法直接打开电脑上的文件。
  fileRead: "pocket.fileRead",
  // 悬浮球：浏览电脑上的目录/文件（一定是电脑磁盘，不是手机存储）。
  fsList: "fs.list",
  // 悬浮球：手机附件落盘到电脑，返回绝对路径（正文内联 [file: 路径] 引用）。
  fsSaveUpload: "fs.saveUpload"
});
function redactStatus(s) {
  return {
    proxyRunning: s?.proxyRunning === true,
    proxyPort: s?.proxyPort ?? null,
    lanUrl: s?.lanUrl ?? null,
    lanQr: s?.lanQr ?? null,
    lanCandidates: Array.isArray(s?.lanCandidates) ? s.lanCandidates : [],
    lanIpOverride: s?.lanIpOverride ?? "",
    tunnelRunning: s?.tunnelRunning === true,
    tunnelUrl: s?.tunnelUrl ?? null,
    tunnelQr: s?.tunnelQr ?? null,
    tunnelState: s?.tunnelState ?? { phase: "idle" },
    tunnelConfig: s?.tunnelConfig ?? { mode: "quick", hostname: "", tokenSet: false },
    // 固定公网地址（SSH 反向隧道）状态：{ enabled, configured, url, phase, adopted, restarts, lastError, … }
    sshTunnel: s?.sshTunnel ?? null,
    dshPort: s?.dshPort ?? null
  };
}

// src/pocket-host/fs-rpc.mjs
import { execFile as execFile3 } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}
function uploadsDir() {
  return path.join(dshHome(), "dsh-pocket", "uploads");
}
function resolvePath(raw, cwd) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    if (/^~[/\\]?/.test(s)) return path.resolve(os.homedir(), s.replace(/^~[/\\]?/, ""));
    if (path.isAbsolute(s)) return path.resolve(s);
    return path.resolve(typeof cwd === "string" && cwd ? cwd : process.cwd(), s);
  } catch {
    return null;
  }
}
var MAX_LIST_ENTRIES = 1e3;
var desktopCache = null;
function desktopDir() {
  if (process.env.DSH_POCKET_DESKTOP) return Promise.resolve(process.env.DSH_POCKET_DESKTOP);
  if (desktopCache) return desktopCache;
  const fallback = path.join(os.homedir(), "Desktop");
  if (process.platform !== "win32") {
    desktopCache = Promise.resolve(fallback);
    return desktopCache;
  }
  desktopCache = new Promise((resolve) => {
    execFile3(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath("Desktop")'],
      { encoding: "utf8", timeout: 5e3, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout ?? "").trim();
        resolve(err || !out ? fallback : out);
      }
    );
  });
  return desktopCache;
}
async function listDrives() {
  if (process.platform !== "win32") return ["/"];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const found = await Promise.all(letters.map(async (letter) => {
    try {
      await fs.access(`${letter}:\\`);
      return `${letter}:\\`;
    } catch {
      return null;
    }
  }));
  const drives = found.filter(Boolean);
  return drives.length > 0 ? drives : ["C:\\"];
}
function byName(a, b) {
  return a.name.localeCompare(b.name);
}
function ancestryCrumbs(target) {
  const crumbs = [];
  let current = target;
  for (; ; ) {
    const parent = path.dirname(current);
    crumbs.unshift({ name: parent === current ? current : path.basename(current), path: current });
    if (parent === current) return crumbs;
    current = parent;
  }
}
async function listFs(rawPath, opts = {}) {
  const { includeFiles = false, cwd, maxEntries = MAX_LIST_ENTRIES } = opts;
  const home = os.homedir();
  if (rawPath !== void 0 && rawPath !== null && String(rawPath).trim() !== "" && resolvePath(rawPath, cwd) === null) {
    throw new Error(`\u8DEF\u5F84\u975E\u6CD5\uFF1A${rawPath} | invalid path`);
  }
  const target = resolvePath(rawPath, home) ?? home;
  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u76EE\u5F55\uFF1A${target}\uFF08${err?.message ?? String(err)}\uFF09 | cannot list directory`);
  }
  const rows = [];
  let truncated = false;
  for (const dirent of dirents) {
    const isDir = dirent.isDirectory();
    if (!isDir && !dirent.isFile()) continue;
    if (rows.length >= maxEntries) {
      truncated = true;
      break;
    }
    rows.push({
      name: dirent.name,
      path: path.join(target, dirent.name),
      kind: isDir ? "dir" : "file",
      hidden: dirent.name.startsWith(".")
    });
  }
  rows.sort((a, b) => a.kind === b.kind ? byName(a, b) : a.kind === "dir" ? -1 : 1);
  const entries = [];
  for (const row of rows) {
    if (!includeFiles && row.kind !== "dir") continue;
    let stat3 = null;
    try {
      stat3 = await fs.stat(row.path);
    } catch {
      continue;
    }
    entries.push({ ...row, size: stat3.size, mtimeMs: stat3.mtimeMs });
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
  }
  const [desktop, drives] = await Promise.all([desktopDir(), listDrives()]);
  return { path: target, home, desktop, drives, crumbs: ancestryCrumbs(target), entries, truncated };
}
var MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
function leafName(name2) {
  const leaf = path.basename(String(name2 ?? "").replace(/\\/g, "/")).trim();
  if (!leaf || leaf === "." || leaf === "..") return null;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(leaf)) return null;
  return leaf;
}
async function saveUpload(input) {
  const leaf = leafName(input?.name);
  if (!leaf) throw new Error(`\u6587\u4EF6\u540D\u975E\u6CD5\uFF1A${input?.name} | invalid file name`);
  let buf;
  try {
    buf = Buffer.from(String(input?.data ?? ""), "base64");
  } catch {
    throw new Error("\u9644\u4EF6\u6570\u636E\u975E\u6CD5\uFF08\u9700 base64\uFF09 | invalid attachment data");
  }
  if (buf.length === 0) throw new Error("\u9644\u4EF6\u4E3A\u7A7A | empty attachment");
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`\u9644\u4EF6\u8FC7\u5927\uFF08${(buf.length / 1024 / 1024).toFixed(1)} MB\uFF09\uFF0C\u4E0A\u9650 25 MB | attachment too large`);
  }
  const dir = uploadsDir();
  await fs.mkdir(dir, { recursive: true });
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  const target = path.join(dir, `${stamp}-${suffix}-${leaf}`);
  await fs.writeFile(target, buf);
  return { path: target, size: buf.length };
}

// src/pocket-host/web-rpc.js
var FILE_READ_MAX = 4 * 1024 * 1024;
var POCKET_RPC_BODY_MAX = 8 * 1024 * 1024;
var POCKET_RPC_UPLOAD_MAX = 40 * 1024 * 1024;
var ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
var INVALID_REQUEST_RPC_ID = "invalid-request";
var LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return void 0;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || !ENDPOINT_SEGMENT_PATTERN.test(seg))) {
    return void 0;
  }
  return endpoint;
}
function serverResponseJson(rpcId, result) {
  return JSON.stringify({ type: "server-response", rpcId, result });
}
function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (!host) return false;
  const hostName = host.split(":")[0];
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function pocketFetchHandler(channel, handler, log) {
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
      if (request.method !== "POST" || endpoint === void 0) {
        return new Response("not found", { status: 404 });
      }
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const rpcId = body && typeof body.rpcId === "string" ? body.rpcId : INVALID_REQUEST_RPC_ID;
      const method = body && typeof body.method === "string" ? body.method : null;
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return new Response(
          serverResponseJson(INVALID_REQUEST_RPC_ID, {
            ok: false,
            error: { code: "bad-request", message: "invalid client-request message", details: { issues: [] } }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (method !== endpoint) {
        return new Response(
          serverResponseJson(rpcId, {
            ok: false,
            error: {
              code: "bad-request",
              message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
              details: { issues: [] }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      try {
        const result = await handler(endpoint, body.payload, request.signal);
        return new Response(serverResponseJson(rpcId, result), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      } catch (err) {
        log.error?.("dsh-pocket: rpc %s failed | RPC \u5931\u8D25: %s", endpoint, err?.message ?? err);
        return new Response(`handler failure: ${String(err)}`, { status: 500 });
      }
    }
  };
}
async function pocketHttpBridge(req, res, fetchHandler, maxBodyBytes) {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const declaredLen = req.headers["content-length"];
  if (declaredLen !== void 0 && Number(declaredLen) > maxBodyBytes) {
    res.writeHead(413, { connection: "close" });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBodyBytes) {
      tooLarge = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    res.writeHead(413, { connection: "close" });
    res.end();
    req.destroy();
    return;
  }
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url}`;
  const init = {
    method: req.method ?? "GET",
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, v]) => typeof v === "string")
    ),
    signal: abort.signal
  };
  if (chunks.length > 0) init.body = Buffer.concat(chunks);
  const request = new Request(url, init);
  const response = await fetchHandler.fetch(request);
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
      });
    }
    if (res.writableEnded) break;
  }
  res.end();
}
function mountPocketWebRoute(ctx, { channel, handler, log }) {
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== "function") return null;
  const connection = ctx?.connection;
  const fetchHandler = pocketFetchHandler(channel, handler, log);
  const route = {
    kind: "prefix",
    path: channel,
    handler: async (req, res) => {
      let rejection;
      if (typeof connection?.requestRejection === "function") {
        try {
          rejection = connection.requestRejection(req);
        } catch {
          rejection = 403;
        }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
      if (rejection !== void 0) {
        res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
        res.end(rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }
      const reqEndpoint = endpointFromPath(channel, (req.url ?? "").split("?")[0]);
      const bodyMax = reqEndpoint === POCKET_ENDPOINTS.fsSaveUpload ? POCKET_RPC_UPLOAD_MAX : POCKET_RPC_BODY_MAX;
      await pocketHttpBridge(req, res, fetchHandler, bodyMax);
    }
  };
  const registered = webServer.register(route);
  const cleanup = typeof registered === "function" ? () => {
    try {
      registered();
    } catch {
    }
  } : registered && typeof registered.then === "function" ? /* @__PURE__ */ (() => {
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      try {
        const d = await registered;
        if (typeof d === "function") d();
      } catch {
      }
    };
  })() : () => {
  };
  return cleanup;
}
function ok(value) {
  return { ok: true, value };
}
function fail(code, message) {
  if (code === "cancelled") return { ok: false, error: { code: "cancelled", message, details: {} } };
  return { ok: false, error: { code: "bad-request", message, details: { issues: [{ message }] } } };
}
function killHint(port) {
  if (process.platform === "win32") {
    return `netstat -ano | findstr :${port}\uFF08\u627E LISTENING \u7684 PID\uFF09\u2192 taskkill /PID <PID> /F`;
  }
  return `lsof -ti :${port} | xargs kill -9`;
}
function installPocketRpc(ctx, { service, log = console, desktop = false, runUpdate = null, restart = null, restartNotice = null, getToken = null, getLanToken: getLanToken2 = null, refreshLanToken: refreshLanToken2 = null, getLanAuthEnabled = null, setLanAuthEnabled: setLanAuthEnabled2 = null, getLanEnabled = null, setLanEnabled: setLanEnabled2 = null, getLanIpOverride = null, setLanIpOverride: setLanIpOverride2 = null, getPinCustom = null, setCustomPin: setCustomPin2 = null, getTunnelConfig = null, setTunnelConfig = null, resetPocket = null, setSshTunnelEnabled = null, setSshTunnelConfig: setSshTunnelConfig2 = null, reconnectSshTunnel = null }) {
  const pocketRpcHandler = async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail("cancelled", "The request was cancelled.");
    const statusPayload = async () => {
      let notice = null;
      try {
        notice = await restartNotice?.() ?? null;
      } catch {
        notice = null;
      }
      const s = await service.status();
      return ok({
        ...redactStatus(s),
        desktop,
        restartNotice: notice,
        killHint: killHint(s.dshPort ?? 3080),
        accessToken: getToken?.() ?? null,
        lanToken: getLanToken2?.() ?? null,
        lanAuthEnabled: getLanAuthEnabled?.() ?? true,
        lanEnabled: getLanEnabled?.() ?? true,
        publicPinCustom: getPinCustom?.("public") ?? false,
        lanPinCustom: getPinCustom?.("lan") ?? false,
        tunnelConfig: getTunnelConfig?.() ?? { mode: "quick", hostname: "", tokenSet: false }
      });
    };
    try {
      if (endpoint === POCKET_ENDPOINTS.status) {
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.lanTokenRefresh) {
        const fresh = refreshLanToken2?.() ?? null;
        if (!fresh) return fail("bad-request", "\u5C40\u57DF\u7F51\u5BC6\u7801\u5237\u65B0\u4E0D\u53EF\u7528 | LAN PIN refresh unavailable");
        return ok({ lanToken: fresh });
      }
      if (endpoint === POCKET_ENDPOINTS.lanAuthSetEnabled) {
        const enabled = setLanAuthEnabled2?.(payload?.on === true);
        if (enabled === void 0) return fail("bad-request", "\u5C40\u57DF\u7F51\u5BC6\u7801\u5F00\u5173\u4E0D\u53EF\u7528 | LAN PIN switch unavailable");
        return ok({ lanAuthEnabled: enabled });
      }
      if (endpoint === POCKET_ENDPOINTS.lanSetEnabled) {
        const enabled = setLanEnabled2?.(payload?.on === true);
        if (enabled === void 0) return fail("bad-request", "\u5C40\u57DF\u7F51\u8BBF\u95EE\u5F00\u5173\u4E0D\u53EF\u7528 | LAN access switch unavailable");
        return ok({ lanEnabled: enabled });
      }
      if (endpoint === POCKET_ENDPOINTS.lanSetOverride) {
        try {
          const ip = setLanIpOverride2?.(payload?.ip ?? "");
          if (ip === void 0) return fail("bad-request", "\u5C40\u57DF\u7F51\u5730\u5740\u8BBE\u7F6E\u4E0D\u53EF\u7528 | LAN address setting unavailable");
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.pinSetCustom) {
        const which = payload?.which === "public" || payload?.which === "lan" ? payload.which : null;
        if (!which) return fail("bad-request", "\u672A\u77E5\u5BC6\u7801\u7C7B\u578B | unknown PIN kind");
        try {
          const pin = setCustomPin2?.(which, payload?.value);
          if (pin === void 0) return fail("bad-request", "\u81EA\u5B9A\u4E49\u5BC6\u7801\u4E0D\u53EF\u7528 | custom PIN unavailable");
          return ok({ which, pin, custom: true });
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelSetConfig) {
        if (!setTunnelConfig) return fail("bad-request", "\u96A7\u9053\u914D\u7F6E\u4E0D\u53EF\u7528 | tunnel config unavailable");
        try {
          setTunnelConfig({ mode: payload?.mode, hostname: payload?.hostname, token: payload?.token });
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.pocketReset) {
        if (payload?.confirm !== true) {
          return fail("bad-request", "\u6062\u590D\u51FA\u5382\u8BBE\u7F6E\u9700\u8981\u786E\u8BA4 | factory reset requires confirmation");
        }
        if (!resetPocket) return fail("bad-request", "\u6062\u590D\u51FA\u5382\u8BBE\u7F6E\u4E0D\u53EF\u7528 | factory reset unavailable");
        try {
          service.stopTunnel();
          resetPocket();
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelStart) {
        if (payload?.disclaimer !== true) {
          return fail("bad-request", "\u5F00\u542F\u516C\u7F51\u524D\u8BF7\u5148\u9605\u8BFB\u5E76\u52FE\u9009\u5B89\u5168\u514D\u8D23\u58F0\u660E | please accept the security disclaimer before enabling public access");
        }
        await service.startTunnel();
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelStop) {
        service.stopTunnel();
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.sshTunnelSetEnabled) {
        if (!setSshTunnelEnabled) return fail("bad-request", "\u56FA\u5B9A\u516C\u7F51\u5730\u5740\u4E0D\u53EF\u7528 | fixed tunnel unavailable");
        try {
          setSshTunnelEnabled(payload?.on === true);
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.sshTunnelSetConfig) {
        if (!setSshTunnelConfig2) return fail("bad-request", "\u56FA\u5B9A\u516C\u7F51\u5730\u5740\u4E0D\u53EF\u7528 | fixed tunnel unavailable");
        try {
          setSshTunnelConfig2(payload && typeof payload === "object" ? payload : {});
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.sshTunnelReconnect) {
        if (!reconnectSshTunnel) return fail("bad-request", "\u56FA\u5B9A\u516C\u7F51\u5730\u5740\u4E0D\u53EF\u7528 | fixed tunnel unavailable");
        try {
          const p = reconnectSshTunnel();
          if (p && typeof p.catch === "function") p.catch((err) => log.warn?.("dsh-pocket: fixed tunnel reconnect failed | \u56FA\u5B9A\u516C\u7F51\u96A7\u9053\u91CD\u8FDE\u5931\u8D25: %s", err?.message ?? err));
          return await statusPayload();
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.version) {
        return ok({ current: runUpdate?.currentVersion?.() ?? null, loaded: runUpdate?.loadedVersion?.() ?? null });
      }
      if (endpoint === POCKET_ENDPOINTS.fileRead) {
        const raw = String(payload?.path ?? "").trim();
        if (!raw) return fail("bad-request", "\u7F3A\u5C11\u6587\u4EF6\u8DEF\u5F84 | missing path");
        let abs;
        try {
          if (/^~[/\\]?/.test(raw)) {
            abs = path2.resolve(os2.homedir(), raw.replace(/^~[/\\]?/, ""));
          } else if (path2.isAbsolute(raw)) {
            abs = path2.resolve(raw);
          } else {
            const base = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
            abs = path2.resolve(base, raw);
          }
        } catch {
          return fail("bad-request", "\u8DEF\u5F84\u975E\u6CD5 | invalid path");
        }
        let stat3;
        try {
          stat3 = await fs2.stat(abs);
        } catch {
          return fail("bad-request", `\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${abs} | file not found`);
        }
        if (stat3.isDirectory()) return fail("bad-request", "\u8FD9\u662F\u76EE\u5F55\uFF0C\u4E0D\u662F\u6587\u4EF6 | it is a directory");
        if (stat3.size > FILE_READ_MAX) {
          return fail("bad-request", `\u6587\u4EF6\u8FC7\u5927\uFF08${(stat3.size / 1024 / 1024).toFixed(1)} MB\uFF09\uFF0C\u65E0\u6CD5\u590D\u5236 | file too large`);
        }
        let buf;
        try {
          buf = await fs2.readFile(abs);
        } catch (err) {
          return fail("bad-request", `\u8BFB\u53D6\u5931\u8D25\uFF1A${err?.message ?? String(err)} | read failed`);
        }
        if (buf.subarray(0, 8192).includes(0)) {
          return fail("bad-request", "\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u590D\u5236\u6587\u672C | binary file");
        }
        return ok({ content: buf.toString("utf8"), path: abs, size: stat3.size });
      }
      if (endpoint === POCKET_ENDPOINTS.fsList) {
        try {
          const result = await listFs(payload?.path, {
            includeFiles: payload?.includeFiles === true,
            cwd: typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : void 0
          });
          return ok(result);
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.fsSaveUpload) {
        try {
          const saved = await saveUpload({ name: payload?.name, data: payload?.data });
          return ok({ ...saved, uploadsDir: uploadsDir() });
        } catch (err) {
          return fail("bad-request", err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.update) {
        if (desktop) return fail("bad-request", "\u684C\u9762\u7248\u66F4\u65B0\u7531 DSH Desktop \u7BA1\u7406\uFF0C\u5DF2\u5728\u6B64\u73AF\u5883\u505C\u7528 | updates are managed by DSH Desktop here");
        if (!runUpdate) return fail("bad-request", "\u66F4\u65B0\u4E0D\u53EF\u7528 | update unavailable");
        const result = await runUpdate.perform(payload?.profile ?? "web");
        if (result?.ok && restart) {
          const rr = restart();
          result.autoRestart = rr?.helperPid != null;
        }
        return ok(result);
      }
      if (endpoint === POCKET_ENDPOINTS.restart) {
        if (desktop) return fail("bad-request", "\u684C\u9762\u7248\u91CD\u542F\u7531 DSH Desktop \u7BA1\u7406\uFF0C\u5DF2\u5728\u6B64\u73AF\u5883\u505C\u7528 | restart is managed by DSH Desktop here");
        if (!restart) return fail("bad-request", "\u91CD\u542F\u4E0D\u53EF\u7528 | restart unavailable");
        const result = restart();
        if (!result || result.helperPid == null) {
          return fail("bad-request", `\u91CD\u542F\u5931\u8D25\uFF1A${result?.error ?? "\u672A\u77E5"} | restart failed`);
        }
        const dshPort = service.dshPort ?? 3080;
        return ok({ ...result, hint: `\u91CD\u542F\u540E\u8FDB\u7A0B\u5728\u540E\u53F0\u8FD0\u884C\uFF1B\u5982\u9700\u505C\u6B62\uFF1A${killHint(dshPort)}` });
      }
      return fail("bad-request", `Unknown endpoint: ${endpoint}`);
    } catch (err) {
      log.error?.("dsh-pocket: rpc %s failed | RPC \u5931\u8D25: %s", endpoint, err?.message ?? err);
      return fail("bad-request", err?.message ?? String(err));
    }
  };
  const directMount = mountPocketWebRoute(ctx, { channel: POCKET_RPC_CHANNEL, handler: pocketRpcHandler, log });
  if (directMount) return directMount;
  if (!ctx?.connection?.rpc?.handle) {
    log.warn?.("dsh-pocket: DSH Host Connection RPC unavailable \u2014 settings tab disabled | \u65E0 Connection RPC\uFF0C\u8BBE\u7F6E\u9875\u4E0D\u53EF\u7528");
    return () => {
    };
  }
  return ctx.connection.rpc.handle(POCKET_RPC_CHANNEL, pocketRpcHandler, { authority: "loopback" });
}

// src/pocket-host/restart.js
import { spawn as spawn3 } from "node:child_process";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
function dshPortFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") {
      const n = Number(args[i + 1]);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    } else if (a.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    }
  }
  return 3080;
}
function restartLaunch() {
  if (process.versions.electron) {
    return {
      file: process.argv[0],
      // GUI exe
      args: [],
      cwd: process.cwd()
    };
  }
  return {
    file: process.argv[0],
    // node
    args: [...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    // [flags] <bin.js> + web [flags]
    cwd: process.cwd()
  };
}
function helperCode(launch, logOut, logErr, port) {
  const spawn6 = "const { spawn } = require('node:child_process')";
  const fs3 = "const fs = require('node:fs')";
  const net = "const net = require('node:net')";
  const file = `const file = ${JSON.stringify(launch.file)}`;
  const args = `const args = ${JSON.stringify(launch.args)}`;
  const cwd = `const cwd = ${JSON.stringify(launch.cwd)}`;
  const o = `const logOut = ${JSON.stringify(logOut)}`;
  const e = `const logErr = ${JSON.stringify(logErr)}`;
  const env = [
    "const childEnv = { ...process.env }",
    "delete childEnv.ELECTRON_RUN_AS_NODE",
    "delete childEnv.ELECTRON_NO_ATTACH_CONSOLE"
  ].join("\n");
  const body = [
    "function portFree(p, cb) {",
    '  const s = net.connect(p, "127.0.0.1")',
    '  s.once("connect", () => { s.destroy(); cb(false) })',
    // 还能连上 = 端口仍被占用
    '  s.once("error", () => cb(true))',
    // 连接被拒 = 已释放
    "}",
    "function waitPort(p, tries, cb) {",
    "  portFree(p, (free) => {",
    "    if (free || tries <= 0) cb(free)",
    "    else setTimeout(() => waitPort(p, tries - 1, cb), 200)",
    "  })",
    "}",
    `waitPort(${port}, 100, (free) => {`,
    // 最多 100×200ms = 20s；超时也照常拉起（宁可试拉、日志留痕，也不让 dsh 起不来）
    "  setTimeout(() => {",
    "    try {",
    '      const out = fs.openSync(logOut, "a")',
    '      const err = fs.openSync(logErr, "a")',
    '      const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", out, err], env: childEnv })',
    "      child.unref()",
    "    } catch (ex) {",
    '      try { fs.appendFileSync(logErr, "restart helper failed: " + (ex && ex.message) + "\\n") } catch {}',
    "    }",
    "  }, 300)",
    "})"
  ].join("\n");
  return [spawn6, fs3, net, file, args, cwd, o, e, env, body].join("\n");
}
function restartHost({ handoffMs = 1500, internals = {} } = {}) {
  const spawnFn = internals.spawn ?? spawn3;
  const killFn = internals.kill ?? ((pid) => process.kill(pid, "SIGTERM"));
  const launch = restartLaunch();
  const port = dshPortFromArgs(launch.args);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logOut = join4(tmpdir(), `dsh-pocket-restart-${stamp}.out.log`);
  const logErr = join4(tmpdir(), `dsh-pocket-restart-${stamp}.err.log`);
  let helperPid = null;
  try {
    const helper = spawnFn(process.execPath, ["-e", helperCode(launch, logOut, logErr, port)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env
    });
    helper.unref?.();
    helper.on?.("error", () => {
    });
    helperPid = helper.pid ?? null;
    setTimeout(() => {
      try {
        killFn(process.pid);
      } catch {
      }
    }, 500);
  } catch (err) {
    return { helperPid: null, logOut, logErr, error: err?.message ?? String(err) };
  }
  return { helperPid, logOut, logErr };
}

// src/tihu/lane.ts
import { createHash as createHash3, randomUUID } from "node:crypto";
import { existsSync as existsSync5 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join7 } from "node:path";

// src/tihu/protocol.ts
var TIHU_PROTOCOL_VERSION = "0";
var TIHU_UPSTREAM_TYPES = [
  "hello",
  "audio.frame",
  "text.input",
  "confirm.reply",
  "session.end",
  "sessions.query",
  "session.bind",
  "screen.gesture",
  "voice.list",
  "voice.create",
  "voice.select",
  "ping"
];
var TIHU_MAX_MESSAGE_BYTES = 6 * 1024 * 1024;
var TIHU_MAX_TEXT_CHARS = 4e3;
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTihuEnvelope(value) {
  if (!isObject(value)) return false;
  if (value.v !== TIHU_PROTOCOL_VERSION) return false;
  if (typeof value.type !== "string" || value.type === "") return false;
  if (typeof value.id !== "string" || value.id === "") return false;
  if (typeof value.seq !== "number" || !Number.isFinite(value.seq)) return false;
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return false;
  return isObject(value.payload);
}
function looksLikeWavBase64(audioBase64) {
  if (typeof audioBase64 !== "string" || audioBase64.length < 12) return false;
  return audioBase64.startsWith("UklGR");
}
function parseUpstream(raw) {
  try {
    let value = raw;
    if (typeof raw === "string") {
      if (raw.length > TIHU_MAX_MESSAGE_BYTES) return null;
      value = JSON.parse(raw);
    } else if (Buffer.isBuffer(raw)) {
      if (raw.length > TIHU_MAX_MESSAGE_BYTES) return null;
      value = JSON.parse(raw.toString("utf8"));
    }
    if (!isTihuEnvelope(value)) return null;
    const type = value.type;
    if (!TIHU_UPSTREAM_TYPES.includes(type)) return null;
    const payload = value.payload;
    switch (type) {
      case "hello": {
        if (typeof payload.clientId !== "string" || payload.clientId === "") return null;
        if (payload.clientId.length > 200) return null;
        if (payload.sessionId !== void 0 && (typeof payload.sessionId !== "string" || payload.sessionId.length > 256)) return null;
        if (payload.auto !== void 0 && typeof payload.auto !== "boolean") return null;
        if (payload.capabilities !== void 0 && !isObject(payload.capabilities)) return null;
        return value;
      }
      case "audio.frame": {
        if (typeof payload.audioBase64 !== "string" || payload.audioBase64 === "") return null;
        if (payload.audioBase64.length > TIHU_MAX_MESSAGE_BYTES) return null;
        if (payload.format !== "wav") return null;
        if (payload.sampleRate !== 16e3 || payload.channels !== 1 || payload.bits !== 16) return null;
        return value;
      }
      case "text.input": {
        if (typeof payload.text !== "string") return null;
        if (payload.text.length > TIHU_MAX_TEXT_CHARS) return null;
        return value;
      }
      case "confirm.reply": {
        if (typeof payload.confirmId !== "string" || payload.confirmId === "") return null;
        if (typeof payload.approved !== "boolean") return null;
        return value;
      }
      case "session.end": {
        if (payload.sessionId !== void 0 && (typeof payload.sessionId !== "string" || payload.sessionId.length > 256)) return null;
        if (payload.reason !== void 0 && typeof payload.reason !== "string") return null;
        return value;
      }
      case "sessions.query": {
        if (payload.limit !== void 0) {
          if (typeof payload.limit !== "number" || !Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 50) return null;
        }
        if (payload.checkId !== void 0 && (typeof payload.checkId !== "string" || payload.checkId.length > 256)) return null;
        return value;
      }
      case "session.bind": {
        if (payload.auto !== void 0 && typeof payload.auto !== "boolean") return null;
        if (payload.sessionId !== void 0 && (typeof payload.sessionId !== "string" || payload.sessionId.length > 256)) return null;
        const manual = typeof payload.sessionId === "string" && payload.sessionId !== "";
        if (!manual && payload.auto !== true) return null;
        return value;
      }
      case "voice.list":
        return value;
      case "voice.select": {
        if (typeof payload.name !== "string" || payload.name === "" || payload.name.length > 32) return null;
        if (payload.edgeVoice !== void 0 && (typeof payload.edgeVoice !== "string" || payload.edgeVoice.length > 64)) return null;
        if (payload.offlineOnly !== void 0 && typeof payload.offlineOnly !== "boolean") return null;
        return value;
      }
      case "voice.create": {
        if (typeof payload.name !== "string" || payload.name === "" || payload.name.length > 32) return null;
        if (!/^[A-Za-z0-9_-]+$/.test(payload.name)) return null;
        if (typeof payload.wavBase64 !== "string" || payload.wavBase64 === "") return null;
        if (payload.wavBase64.length > TIHU_MAX_MESSAGE_BYTES) return null;
        if (payload.note !== void 0 && typeof payload.note !== "string") return null;
        return value;
      }
      case "screen.gesture": {
        if (payload.action === "swipe") {
          if (typeof payload.dy !== "number" || !Number.isFinite(payload.dy)) return null;
          if (payload.phase !== "start" && payload.phase !== "move" && payload.phase !== "end") return null;
          return value;
        }
        if (payload.action === "tap") {
          if (typeof payload.x !== "number" || typeof payload.y !== "number") return null;
          if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return null;
          if (payload.hit !== void 0 && payload.hit !== "chip" && payload.hit !== "screen") return null;
          if (payload.targetSessionId !== void 0 && (typeof payload.targetSessionId !== "string" || payload.targetSessionId.length > 256)) return null;
          return value;
        }
        return null;
      }
      case "ping":
        return value;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
function createSeq() {
  let seq = 0;
  return () => {
    seq += 1;
    return seq;
  };
}
function buildDownstream(type, payload, seq, id) {
  return {
    v: TIHU_PROTOCOL_VERSION,
    type,
    id: id ?? randomId("srv"),
    seq,
    ts: Date.now(),
    payload
  };
}
function randomId(prefix = "tihu") {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
function summarizeForLog(message) {
  const type = typeof message?.type === "string" ? message.type : "?";
  const id = typeof message?.id === "string" ? message.id.slice(0, 40) : "?";
  const payload = isObject(message?.payload) ? { ...message.payload } : {};
  if (typeof payload.audioBase64 === "string") payload.audioBase64 = `<${payload.audioBase64.length} \u5B57\u7B26>`;
  let body = "";
  try {
    body = JSON.stringify(payload).slice(0, 300);
  } catch {
    body = "<unserializable>";
  }
  return `${type}#${id} ${body}`;
}
function toTtsSegments(text, perSegment = 80, maxSegments = Number.POSITIVE_INFINITY) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean === "") return [];
  const parts = [];
  let rest = clean;
  while (rest !== "" && parts.length < maxSegments) {
    if (rest.length <= perSegment) {
      parts.push(rest);
      break;
    }
    const window = rest.slice(0, perSegment);
    const match = window.match(/^[\s\S]*[。！？；!?;]/);
    const boundary = match === null ? 0 : match[0].length;
    const cut = boundary >= Math.ceil(perSegment * 0.5) ? boundary : perSegment;
    const safeCut = Math.max(1, Math.min(cut, rest.length));
    parts.push(rest.slice(0, safeCut).trim());
    rest = rest.slice(safeCut).trim();
  }
  return parts.filter(Boolean);
}

// src/tihu/guard.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync2, copyFileSync, readFileSync as readFileSync3, statSync as statSync2, writeFileSync } from "node:fs";
import { dirname as dirname4, isAbsolute, join as join5, relative, resolve as resolvePath2 } from "node:path";
var TIHU_DIR = ".tihu";
var SNAPSHOTS_DIR = "snapshots";
var AUDIT_FILE = "audit.jsonl";
var TOOL_PATTERNS = [
  { re: /^(write|write_file|create_file|create)$/i, kind: "write", label: "\u5199\u6587\u4EF6" },
  { re: /^(edit|edit_file|multi_edit|apply_patch|str_replace|str_replace_editor|replace)$/i, kind: "edit", label: "\u6539\u6587\u4EF6" },
  { re: /^(delete|delete_file|remove|rm|move|rename|unlink)$/i, kind: "delete", label: "\u5220\u9664/\u79FB\u52A8" },
  { re: /^(shell|bash|sh|pwsh|powershell|cmd|terminal|exec|execute|run|run_command|run_code)$/i, kind: "shell", label: "\u6267\u884C\u547D\u4EE4" },
  { re: /^(send|send_email|email|mail|upload|post|publish|notify)$/i, kind: "send", label: "\u5BF9\u5916\u53D1\u9001" }
];
var DANGEROUS_TOKENS = new RegExp(
  [
    // 写 / 删 / 移动 / 改名（只用不含糊的全名 + 无歧义的别名；
    // 像 md/ri/ni 这种两字母别名会和 `.md` 文件名、路径撞车，不收）
    String.raw`\b(rm|rmdir|del|erase|unlink|Remove-Item|Move-Item|mv|move|Rename-Item|ren|rename)\b`,
    String.raw`\b(New-Item|mkdir|Set-Content|Add-Content|Clear-Content|Out-File|Tee-Object|tee|Copy-Item|xcopy|robocopy)\b`,
    // 重定向（含 PowerShell 的 *>）
    String.raw`(^|[^|])\s?>>?\s*[^\s|]`,
    String.raw`\*\s?>>?`,
    // 进程 / 系统状态
    String.raw`\b(Stop-Process|Start-Process|taskkill|kill|shutdown|restart|Format-Volume|Format-Disk|reg\s+(add|delete|import)|schtasks|Set-Service|Stop-Service|Start-Service)\b`,
    // 提权 / 执行任意代码
    String.raw`\b(sudo|runas|chmod|chown|Invoke-Expression|iex|Start-Job|npx)\b`,
    // 包管理（会落盘、会联网）
    String.raw`\b(pip|conda|apt|apt-get|yum|dnf|brew|winget|choco|Install-Module|Install-Package|Uninstall-)\b`,
    // 对外发送 / 下载落盘
    String.raw`\b(git\s+(push|commit|reset|clean|checkout|switch|merge|rebase|stash|apply|rm|mv|tag\s+-d|init|clone))\b`,
    String.raw`\b(npm\s+(i|install|uninstall|publish|ci|update)|pnpm\s+(add|install|remove|publish|update)|yarn\s+(add|install|publish))\b`,
    String.raw`\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*?(\s-o\s|\s-O\s|--output|\s-d\s|--data|\s-F\s|--form|-Method\s+(POST|PUT|DELETE|PATCH)|-X\s*(POST|PUT|DELETE|PATCH)|\s-T\s|--upload-file)`,
    String.raw`\b(scp|sftp|ssh|rsync|ftp|telnet)\b`
  ].join("|"),
  "i"
);
var READ_ONLY_VERBS = /* @__PURE__ */ new Set([
  "ls",
  "dir",
  "get-childitem",
  "gci",
  "pwd",
  "get-location",
  "cd",
  "chdir",
  "pushd",
  "popd",
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "more",
  "less",
  "bat",
  "grep",
  "rg",
  "select-string",
  "sls",
  "findstr",
  "find",
  "wc",
  "sort",
  "uniq",
  "diff",
  "cmp",
  "tree",
  "stat",
  "du",
  "df",
  "echo",
  "write-output",
  "write-host",
  "format-table",
  "format-list",
  "ft",
  "fl",
  "select-object",
  "select",
  "where-object",
  "where",
  "foreach-object",
  "measure-object",
  "measure",
  "convertfrom-json",
  "convertto-json",
  "out-string",
  "get-help",
  "help",
  "man",
  "test-path",
  "get-item",
  "get-itemproperty",
  "get-filehash",
  "resolve-path",
  "split-path",
  "join-path",
  "git",
  "node",
  "npm",
  "pnpm",
  "python",
  "py",
  "jq",
  "where",
  "which",
  "get-command",
  "gcm",
  "whoami",
  "hostname",
  "ver",
  "uname",
  "get-process",
  "ps",
  "get-service",
  "get-date",
  "get-childitem",
  "ipconfig",
  "systeminfo",
  "nslookup",
  "ping",
  "curl",
  "wget",
  "get-netstat",
  "netstat",
  "net",
  "ls-files"
]);
var GIT_READ_ONLY = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "remote",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "reflog",
  "config",
  "tag",
  "stash",
  "help",
  "version",
  "whatchanged"
]);
function verbOf(token) {
  const cleaned = String(token ?? "").replace(/^["']|["']$/g, "");
  const base = cleaned.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, "").toLowerCase();
}
function isReadOnlySegment(segment) {
  let text = segment.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(text)) text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  if (text === "") return true;
  const tokens = text.split(/\s+/);
  const verb = verbOf(tokens[0]);
  if (!READ_ONLY_VERBS.has(verb)) return false;
  if (verb === "git") {
    const sub = String(tokens[1] ?? "").toLowerCase();
    if (sub === "") return true;
    if (!GIT_READ_ONLY.has(sub)) return false;
    if (sub === "config") return tokens.some((t) => /^(--get|--get-all|--list|-l)$/i.test(t));
    if (sub === "tag" || sub === "branch") return !tokens.some((t) => /^-(d|D|m|M|f|u)$/.test(t));
    return true;
  }
  if (verb === "npm" || verb === "pnpm") {
    const sub = String(tokens[1] ?? "").toLowerCase();
    return ["ls", "list", "view", "v", "--version", "-v", "why", "root", "bin"].includes(sub);
  }
  if (verb === "node" || verb === "python" || verb === "py") {
    if (tokens.some((t) => /^(-e|-c|--eval|--exec)$/i.test(t))) return false;
    return tokens.length === 2 && /^(-v|--version|-V)$/i.test(tokens[1]);
  }
  if (verb === "curl" || verb === "wget") {
    return !tokens.some((t) => /^(-o|-O|-d|-F|-T|-X|--output|--data|--form|--upload-file|--request)$/i.test(t));
  }
  return true;
}
function isReadOnlyCommand(command) {
  const text = String(command ?? "").trim();
  if (text === "") return false;
  if (DANGEROUS_TOKENS.test(text)) return false;
  const segments = text.split(/;|&&|\|\||\||\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}
function classifyTool(name2, targetExists, command) {
  const raw = String(name2 ?? "");
  for (const pattern of TOOL_PATTERNS) {
    if (!pattern.re.test(raw)) continue;
    const touchesFiles = pattern.kind === "write" || pattern.kind === "edit" || pattern.kind === "delete";
    const dangerous = pattern.kind === "delete" || pattern.kind === "send" || pattern.kind === "shell" && !isReadOnlyCommand(String(command ?? "")) || (pattern.kind === "write" || pattern.kind === "edit") && targetExists === true;
    return { kind: pattern.kind, touchesFiles, dangerous, label: pattern.label };
  }
  return { kind: "other", touchesFiles: false, dangerous: false, label: "\u5176\u5B83" };
}
function targetPathOf(args) {
  if (typeof args !== "object" || args === null) return void 0;
  const record = args;
  for (const key of ["path", "file_path", "filePath", "file", "target", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return void 0;
}
function commandOf(args) {
  if (typeof args !== "object" || args === null) return void 0;
  const record = args;
  for (const key of ["command", "cmd", "script", "code", "input"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return String(value).slice(0, 500);
  }
  return void 0;
}
function relativeInsideRoot(root, target) {
  if (typeof root !== "string" || root === "" || typeof target !== "string" || target === "") return null;
  const absolute = isAbsolute(target) ? target : resolvePath2(root, target);
  const rel = relative(resolvePath2(root), resolvePath2(absolute));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}
function tihuDirOf(workspace) {
  const dir = join5(workspace, TIHU_DIR);
  mkdirSync2(dir, { recursive: true });
  return dir;
}
function takeSnapshot(workspace, target, stamp) {
  const snapshotRoot = join5(tihuDirOf(workspace), SNAPSHOTS_DIR, stamp ?? timestampSlug());
  const rel = relativeInsideRoot(workspace, target);
  if (rel === null) {
    return { copied: false, snapshotRoot, existed: false, reason: "outside-workspace" };
  }
  const source = join5(workspace, rel);
  if (!existsSync3(source)) {
    return { copied: false, snapshotRoot, relativePath: rel, existed: false, reason: "not-found" };
  }
  try {
    const info = statSync2(source);
    if (!info.isFile()) {
      return { copied: false, snapshotRoot, relativePath: rel, existed: true, reason: "not-a-file" };
    }
    const destination = join5(snapshotRoot, rel);
    mkdirSync2(dirname4(destination), { recursive: true });
    copyFileSync(source, destination);
    return { copied: true, snapshotRoot, snapshotPath: destination, relativePath: rel, existed: true, size: info.size };
  } catch (error) {
    return { copied: false, snapshotRoot, relativePath: rel, existed: true, reason: error?.message ?? String(error) };
  }
}
function timestampSlug(date = /* @__PURE__ */ new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}
function appendAudit(workspace, entry) {
  try {
    const file = join5(tihuDirOf(workspace), AUDIT_FILE);
    appendFileSync2(file, `${JSON.stringify(entry)}
`, "utf8");
    return true;
  } catch {
    return false;
  }
}
function diffSummary(before, after) {
  const normalize = (value) => String(value ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  const a = normalize(before).split("\n");
  const b = normalize(after).split("\n");
  if (a.length > 4e3 || b.length > 4e3) {
    const delta = b.length - a.length;
    return { added: delta > 0 ? delta : 0, removed: delta < 0 ? -delta : 0, summary: delta === 0 ? "\u5185\u5BB9\u6709\u53D8\u5316\uFF08\u8D85\u957F\u6587\u4EF6\uFF0C\u672A\u505A\u9010\u884C diff\uFF09" : `\u884C\u6570 ${delta > 0 ? "+" : ""}${delta}` };
  }
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const removed = a.length - prefix - suffix;
  const added = b.length - prefix - suffix;
  if (removed === 0 && added === 0) return { added: 0, removed: 0, summary: "\u5185\u5BB9\u672A\u53D8\u5316" };
  const parts = [];
  if (added > 0) parts.push(`+${added} \u884C`);
  if (removed > 0) parts.push(`-${removed} \u884C`);
  return { added, removed, summary: parts.join(" ") };
}
function readTextOrEmpty(path3) {
  try {
    return existsSync3(path3) ? readFileSync3(path3, "utf8") : "";
  } catch {
    return "";
  }
}
function createConfirmBroker(options = {}) {
  const pending = /* @__PURE__ */ new Map();
  let counter = 0;
  const settle = (id, outcome) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    return true;
  };
  return {
    ask(input) {
      counter += 1;
      const id = `confirm-${Date.now().toString(36)}-${counter}`;
      const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1e3, Math.floor(input.timeoutMs)) : 6e4;
      const request = { id, title: String(input.title ?? ""), detail: String(input.detail ?? ""), timeoutMs, risk: input.risk, sessionId: input.sessionId };
      return new Promise((resolvePromise) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolvePromise({ outcome: "timeout", id });
        }, timeoutMs);
        pending.set(id, { resolve: (outcome) => resolvePromise({ outcome, id }), timer, request });
        try {
          options.onAsk?.(request);
        } catch {
        }
      });
    },
    reply(confirmId, approved) {
      return settle(confirmId, approved ? "approved" : "rejected");
    },
    pendingCount() {
      return pending.size;
    },
    failAll(outcome = "offline") {
      for (const id of [...pending.keys()]) settle(id, outcome);
    }
  };
}

// src/tihu/screen-spec.ts
var SCREEN_SPEC = {
  /** 屏宽（设备像素 = CSS px，1:1）。 */
  widthPx: 320,
  /** 屏高。 */
  heightPx: 240,
  /** 四边内边距。 */
  paddingPx: 8,
  /** 中文正文字号。 */
  bodyFontPx: 16,
  /** 正文行高。 */
  bodyLineHeightPx: 20,
  /** 正文每行字符数（约 18 个汉字）。 */
  bodyCharsPerLine: 18,
  /** 正文最多行数（内容区 224px，16px/20px 行高）。 */
  maxBodyLines: 4,
  /** 标题字号（加粗）。 */
  titleFontPx: 18,
  /** 标题最大字符数。 */
  titleChars: 28,
  /** stage 小字字号。 */
  stageFontPx: 12,
  /** stage 最大字符数。 */
  stageChars: 10,
  /** reply 模式：可视正文行数（16px/20px 行高）。 */
  replyVisibleLines: 10
};
var SCREEN_PHYSICAL = {
  diagonalInches: 2.4,
  widthMm: 61,
  heightMm: 45.7,
  /** 96 CSS px / 25.4 mm。 */
  pxPerMm: 96 / 25.4
};
var ACTUAL_SIZE_SCALE = SCREEN_PHYSICAL.widthMm * SCREEN_PHYSICAL.pxPerMm / SCREEN_SPEC.widthPx;
var CONTENT_WIDTH_PX = SCREEN_SPEC.widthPx - SCREEN_SPEC.paddingPx * 2;
function charWidthEm(char) {
  const code = char.codePointAt(0) ?? 0;
  const wide = code >= 4352 && code <= 4447 || code >= 11904 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65040 && code <= 65135 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 127744 && code <= 129791;
  return wide ? 1 : 0.47;
}
function measureTextPx(text, fontPx) {
  let width = 0;
  for (const char of String(text ?? "")) width += charWidthEm(char) * fontPx;
  return width;
}
function fitLine(value, maxWidthPx = CONTENT_WIDTH_PX, fontPx = SCREEN_SPEC.bodyFontPx) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "";
  if (measureTextPx(text, fontPx) <= maxWidthPx) return text;
  const chars = [...text];
  const ellipsisWidth = measureTextPx("\u2026", fontPx);
  let width = 0;
  let out = "";
  for (const char of chars) {
    const next = width + charWidthEm(char) * fontPx;
    if (next + ellipsisWidth > maxWidthPx) break;
    out += char;
    width = next;
  }
  return out === "" ? "\u2026" : `${out}\u2026`;
}
function wrapTextPx(value, maxWidthPx = CONTENT_WIDTH_PX, fontPx = SCREEN_SPEC.bodyFontPx) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return [];
  const lines = [];
  let current = "";
  let width = 0;
  for (const char of [...text]) {
    const charWidth = charWidthEm(char) * fontPx;
    if (current !== "" && width + charWidth > maxWidthPx) {
      lines.push(current.trimEnd());
      current = "";
      width = 0;
    }
    current += char;
    width += charWidth;
  }
  if (current !== "") lines.push(current.trimEnd());
  return lines;
}
function clipScreenText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "";
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}\u2026`;
}

// src/tihu/page.ts
function tihuPageHtml(options) {
  const lane = JSON.stringify(options.lanePath);
  const protocol = JSON.stringify(options.protocol);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>\u9E48\u9E55 \xB7 \u6A21\u62DF\u8BBE\u5907</title>
<style>
  :root { --bg:#0b0f14; --panel:#121821; --line:#1f2a37; --fg:#e6edf3; --dim:#8b98a5; --accent:#3fb6a8; --warn:#e2b03f; --err:#e05f5f; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system, "Segoe UI", "Noto Sans SC", system-ui, sans-serif; }
  body { padding:12px; display:flex; flex-direction:column; gap:10px; max-width:760px; margin:0 auto; }
  header { display:flex; align-items:baseline; gap:8px; }
  header b { font-size:15px; letter-spacing:.5px; }
  header span { color:var(--dim); font-size:12px; }
  #conn { margin-left:auto; font-size:12px; color:var(--dim); }
  #conn.on { color:var(--accent); }
  #conn.off { color:var(--err); }
  /* \u2500\u2500 \u771F\u673A\u5C4F\u5E55\uFF1AESP32-S3-BOX-3B \xB7 2.4\u2033 \xB7 320\xD7240\uFF0C1:1 CSS px\uFF0C\u5916\u58F3\u53EA\u662F\u88C5\u9970 \u2500\u2500 */
  .device-wrap { display:flex; flex-direction:column; gap:8px; }
  .device-title { font-size:12px; color:var(--dim); letter-spacing:.5px; }
  .device-caption { font-size:12px; color:var(--accent); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .device-caption.none { color:var(--dim); }
  .device-caption.bad { color:var(--err); }
  .device { width:max-content; zoom:var(--screen-scale, 1); }
  .bezel { background:linear-gradient(180deg,#2a3440,#151c24); border-radius:18px; padding:16px 16px 14px;
    box-shadow:0 10px 24px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06); }
  .mics { display:flex; justify-content:center; gap:16px; margin:0 0 10px; }
  .mics span { width:6px; height:6px; border-radius:50%; background:#0a0e13;
    box-shadow:inset 0 1px 2px rgba(0,0,0,.9), 0 0 0 1px #39434f; }
  .grille { display:flex; justify-content:center; gap:3px; margin-top:10px; }
  .grille span { width:3px; height:9px; border-radius:2px; background:#0a0e13; box-shadow:inset 0 1px 1px rgba(255,255,255,.05); }
  .dock { width:62%; height:10px; margin:10px auto 0; border-radius:50%;
    background:radial-gradient(ellipse at center, rgba(0,0,0,.55), transparent 70%); filter:blur(1px); }
  /* \u4EC5\u5C4F\u5E55\uFF1A\u53BB\u6389\u5916\u58F3\u88C5\u9970\uFF0C\u53EA\u7559 320\xD7240 \u7CBE\u786E\u8FB9\u754C */
  .shell-off .bezel { background:none; padding:0; border-radius:0; box-shadow:none; }
  .shell-off .mics, .shell-off .grille, .shell-off .dock { display:none; }
  .shell-off #screen { border:1px solid var(--accent); border-radius:0; }
  /* \u5C4F\u5E55\u672C\u4F53\uFF1A\u56FA\u5B9A 320\xD7240\uFF08screen-spec\uFF09\uFF0C\u5185\u5BB9\u6309 8px \u5185\u8FB9\u8DDD\u6392\u7248\uFF0C\u7EDD\u4E0D\u6EDA\u52A8 */
  #screen { position:relative; width:320px; height:240px; box-sizing:border-box; padding:8px; overflow:hidden;
    touch-action:none;
    background:#05080b; color:var(--fg); border:1px solid #000; border-radius:3px;
    display:flex; flex-direction:column; gap:4px; }
  #screen .stage { font-size:12px; line-height:14px; letter-spacing:1px; color:var(--accent);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .title { font-size:18px; font-weight:700; line-height:22px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen ul { margin:0; padding:0; list-style:none; font-size:16px; line-height:20px; color:#c3ccd5; }
  #screen ul li { white-space:normal; overflow-wrap:anywhere; }
  #screen .reply-body { display:none; flex:1; overflow:hidden; font-size:16px; line-height:20px; color:#d9e2ea; }
  #screen .reply-line { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .reply-line.cur { background:var(--accent); color:#04110f; border-radius:3px; }
  #screen .home-body { display:none; flex:1; overflow:hidden; }
  #screen.home-mode .home-body { display:block; }
  #screen.home-mode .title, #screen.home-mode ul, #screen.home-mode .reply-body, #screen.home-mode .bar { display:none; }
  #screen .home-item { height:36px; box-sizing:border-box; padding:1px 0; overflow:hidden; }
  #screen .home-row1 { display:flex; align-items:center; gap:6px; font-size:16px; font-weight:700; line-height:20px; white-space:nowrap; }
  #screen .home-dot { width:8px; height:8px; border-radius:50%; flex:none; background:#6b7785; }
  #screen .home-row1 .name { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .home-row2 { font-size:12px; line-height:14px; color:#8b97a5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .home-dot.running { background:#35d07f; }
  #screen .home-dot.idle { background:#6b7785; }
  #screen .home-dot.done { background:#4f8ef7; }
  #screen .pending-rail { position:absolute; right:0; top:8px; bottom:8px; width:64px; padding:4px; box-sizing:border-box;
    display:none; flex-direction:column; gap:4px; z-index:3; }
  #screen.rail-on .pending-rail { display:flex; }
  #screen.rail-on .title, #screen.rail-on ul, #screen.rail-on .reply-body, #screen.rail-on .home-body { width:240px; }
  #screen .pending-chip { width:56px; height:34px; box-sizing:border-box; padding:2px 3px; border-radius:5px;
    background:rgba(20,28,40,.82); border:1px solid rgba(120,180,255,.55); overflow:hidden; }
  #screen .pending-name { font-size:11px; line-height:15px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .pending-sub { font-size:10px; line-height:13px; color:#9fb0bf; display:flex; align-items:center; gap:3px; }
  #screen .pending-dot { width:5px; height:5px; border-radius:50%; background:#35d07f; }
  #screen .pending-more { font-size:10px; color:#9fb0bf; text-align:center; }
  #screen .scroll-hint { position:absolute; right:8px; bottom:6px; font-size:11px; line-height:14px;
    color:#9fb0bf; background:rgba(5,8,11,.82); padding:1px 4px; border-radius:3px; pointer-events:none; }
  #screen.reply-mode .title, #screen.reply-mode ul, #screen.reply-mode .bar { display:none; }
  #screen.reply-mode .reply-body { display:block; }
  #screen .bar { margin-top:auto; display:flex; align-items:center; gap:6px; font-size:10px; color:var(--dim); }
  #screen .track { flex:1; height:5px; border-radius:3px; background:#182230; overflow:hidden; }
  #screen .fill { height:100%; width:0; background:var(--accent); transition:width .3s; }
  #screen.busy .stage { color:var(--warn); } #screen.alert .stage { color:var(--err); } #screen.ok .stage { color:var(--accent); }
  .screen-tools { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .screen-tools button { padding:6px 10px; font-size:12px; }
  .screen-tools button.on { border-color:var(--accent); background:#132420; }
  .screen-tools .hint { margin-left:auto; }
  select, #voiceName, #voiceNote { font:inherit; color:var(--fg); background:#0d131b; border:1px solid var(--line); border-radius:9px; padding:8px 10px; width:100%; }
  /* \u5C4F\u4E0B\u7684\u4F1A\u8BDD\u9009\u62E9\u5668\uFF1A\u6CA1\u6709\u4F1A\u8BDD\u65F6\u5C55\u5F00\u3001\u7ED1\u5B9A\u540E\u6536\u8D77\uFF08\u6309\u94AE\u53EF\u518D\u5C55\u5F00\uFF09 */
  .sess-now { font-size:13px; line-height:1.35; margin:0 0 8px; word-break:break-word; }
  .sess-now.none { color:var(--warn); }
  .sess-now.bad { color:var(--err); }
  .cu-warn { display:none; background:#3a1414; border:1px solid #b04545; color:#ffd9d9;
    border-radius:8px; padding:8px 10px; font-size:12px; line-height:1.45; margin:0 0 8px; }
  .sess-item.off { opacity:.55; border-style:dashed; cursor:default; }
  .sess-list { display:flex; flex-direction:column; gap:6px; max-height:34vh; overflow:auto; }
  .sess-item { text-align:left; display:flex; flex-direction:column; gap:2px; padding:8px 10px; }
  .sess-item .t { font-size:13px; line-height:1.3; }
  .sess-item .m { font-size:11px; color:var(--dim); }
  .sess-item.on { border-color:var(--accent); background:#132420; }
  .row { display:flex; gap:8px; align-items:stretch; }
  button { font:inherit; color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:10px 12px; }
  button:active { background:#1a2431; }
  button[disabled] { opacity:.45; }
  #talk { flex:1; background:linear-gradient(180deg,#1b6f66,#155a53); border-color:#2a8f84; font-weight:600; touch-action:none; user-select:none; }
  #talk.rec { background:linear-gradient(180deg,#8a2f2f,#5f2222); border-color:#b04545; }
  label.file { display:flex; align-items:center; justify-content:center; padding:10px 12px; border:1px dashed var(--line); border-radius:9px; color:var(--dim); font-size:13px; }
  label.file input { display:none; }
  #drop { position:fixed; inset:0; background:rgba(10,20,30,.9); color:var(--fg); display:none; align-items:center; justify-content:center; font-size:18px; z-index:9; }
  #drop.on { display:flex; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .card h4 { margin:0 0 6px; font-size:11px; letter-spacing:1.5px; color:var(--dim); font-weight:600; }
  #transcript { min-height:38px; font-size:14px; word-break:break-word; }
  #transcript.empty { color:var(--dim); }
  #events { max-height:22vh; overflow:auto; font-size:12px; color:#a9b6c3; display:flex; flex-direction:column-reverse; }
  #events div { padding:2px 0; border-top:1px dashed #182230; }
  #events div:first-child { border-top:0; }
  #events .alert { color:var(--err); } #events .done { color:var(--accent); } #events .progress { color:#a9b6c3; }
  #ask { border-color:#b04545; display:none; }
  #ask.on { display:block; }
  #ask .detail { font-size:13px; color:#e8c5c5; word-break:break-all; margin:6px 0 8px; }
  #ask .row button { flex:1; }
  #ask .yes { background:#1d5f4f; border-color:#2a8f74; }
  textarea { width:100%; min-height:64px; resize:vertical; font:inherit; color:var(--fg); background:#0d131b; border:1px solid var(--line); border-radius:9px; padding:8px 10px; }
  .hint { font-size:11px; color:var(--dim); }
  .hint code { color:#c3ccd5; }
</style>
</head>
<body>
<header>
  <b>\u9E48\u9E55 \xB7 \u6A21\u62DF\u8BBE\u5907</b><span>\u534F\u8BAE v0</span>
  <span id="conn">\u8FDE\u63A5\u4E2D\u2026</span>
</header>

<div class="device-wrap" id="deviceWrap">
  <div class="device-title">ESP32-S3-BOX-3B \xB7 2.4\u2033 \xB7 320\xD7240 \xB7 \u89E6\u6478\u5C4F</div>
  <div class="device-caption none" id="sessLine">\u5F53\u524D\u4F1A\u8BDD\uFF1A\u672A\u9009\u5B9A</div>
  <div class="device" id="device">
    <div class="bezel">
      <div class="mics"><span></span><span></span></div>
      <div id="screen">
        <div class="stage" id="stage">\u8FDE\u63A5</div>
        <div class="title" id="title">\u6B63\u5728\u8FDE\u63A5\u5BBF\u4E3B\u2026</div>
        <ul id="bullets"></ul>
        <div id="replyBody" class="reply-body"></div>
        <div id="homeBody" class="home-body"></div>
        <div id="pendingRail" class="pending-rail"></div>
        <div id="scrollHint" class="scroll-hint"></div>
        <div class="bar"><span id="progress">\u2014</span><div class="track"><div class="fill" id="fill"></div></div></div>
      </div>
      <div class="grille"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
    </div>
    <div class="dock"></div>
  </div>
  <div class="screen-tools">
    <button data-scale="1">1\xD7</button>
    <button data-scale="2" class="on">2\xD7</button>
    <button data-scale="actual">\u5B9E\u9645\u5C3A\u5BF8</button>
    <button id="shellToggle">\u4EC5\u5C4F\u5E55</button>
    <span class="hint" id="scaleHint">640 \xD7 480 \u663E\u793A</span>
  </div>
</div>

<div class="card" id="sessCard">
  <h4>\u5F53\u524D\u4F1A\u8BDD\uFF08Computer Use \u6A21\u5F0F\uFF09</h4>
  <div class="cu-warn" id="cuWarn"></div>
  <div class="sess-now none" id="sessNow">\u8FD8\u6CA1\u6709\u9009\u5B9A\u4F1A\u8BDD\uFF0C\u70B9\u4E0B\u9762\u9009\u4E00\u4E2A</div>
  <div class="sess-list" id="sessList"></div>
  <div class="row" style="margin-top:8px">
    <button id="sessSwitch" style="display:none">\u6362\u4E2A\u4F1A\u8BDD</button>
    <button id="sessAuto" style="display:none">\u6062\u590D\u81EA\u52A8</button>
    <button id="sessRefresh" style="flex:1">\u5237\u65B0\u4F1A\u8BDD\u5217\u8868</button>
  </div>
  <div class="hint" id="sessHint">\u5217\u8868\u53EA\u663E\u793A Computer Use \u6A21\u5F0F\u4F1A\u8BDD\uFF1B\u9ED8\u8BA4\u81EA\u52A8\u7ED1\u5B9A\u6700\u8FD1\u6D3B\u8DC3\u7684\u4E00\u6761\uFF0C\u624B\u52A8\u9009\u4E00\u6B21\u540E\u4EE5\u624B\u52A8\u4E3A\u51C6\u3002</div>
</div>

<div class="card" id="voiceCard">
  <h4>\u97F3\u8272 \xB7 \u672C\u5730 TTS\uFF08Qwen3-TTS 0.6B\uFF09</h4>
  <div class="row">
    <select id="voiceSelect" style="flex:1"></select>
    <button id="voiceRefresh">\u5237\u65B0</button>
  </div>
  <div class="row" style="margin-top:8px">
    <input id="voiceName" placeholder="\u97F3\u8272\u540D\uFF08\u82F1\u6587/\u6570\u5B57/\u4E0B\u5212\u7EBF\uFF09" style="flex:1" />
    <label class="file" style="flex:1">\u4E0A\u4F20\u53C2\u8003\u97F3\u9891\uFF083\u201310 \u79D2\uFF09<input id="voiceFile" type="file" accept="audio/*"></label>
  </div>
  <div class="row" style="margin-top:8px">
    <select id="edgeVoiceSelect" style="flex:1">
      <option value="zh-CN-YunjianNeural">\u515C\u5E95\u97F3\u8272\uFF1A\u4E91\u5065 Yunjian</option>
      <option value="zh-CN-YunxiNeural">\u515C\u5E95\u97F3\u8272\uFF1A\u4E91\u5E0C Yunxi</option>
      <option value="zh-CN-XiaoxiaoNeural">\u515C\u5E95\u97F3\u8272\uFF1A\u6653\u6653 Xiaoxiao</option>
      <option value="zh-CN-YunyangNeural">\u515C\u5E95\u97F3\u8272\uFF1A\u4E91\u626C Yunyang</option>
    </select>
  </div>
  <label class="hint" style="display:flex;align-items:center;gap:6px;margin-top:8px">
    <input id="offlineOnly" type="checkbox" style="width:auto" /> \u4EC5\u79BB\u7EBF\uFF08\u7981\u7528 edge \u4E91\u5065\uFF0C\u8D70\u672C\u5730 Qwen\uFF09
  </label>
  <input id="voiceNote" placeholder="\u5907\u6CE8\uFF08\u53EF\u9009\uFF09" style="margin-top:8px" />
  <div class="hint" id="voiceHint">\u4EC5\u53EF\u7528\u4E8E\u4F60\u672C\u4EBA\u6216\u5DF2\u83B7\u6388\u6743\u7684\u97F3\u8272\uFF1B\u53C2\u8003\u97F3\u9891\u53EA\u5728\u672C\u673A\u5904\u7406\uFF0C\u4E0D\u4E0A\u4F20\u4E91\u7AEF\u3002</div>
</div>

<div class="row">
  <button id="talk">\u6309\u4F4F\u8BF4\u8BDD</button>
  <label class="file">\u9009 WAV \u6587\u4EF6<input id="file" type="file" accept="audio/*"></label>
</div>
<div class="hint">\u6CA1\u6709\u9EA6\u514B\u98CE\uFF1F\u70B9\u300C\u9009 WAV \u6587\u4EF6\u300D\u6216\u628A\u97F3\u9891\u6587\u4EF6\u62D6\u8FDB\u9875\u9762\uFF0C\u8D70\u7684\u662F\u540C\u4E00\u6761 audio.frame \u4E0A\u884C\u3002</div>

<div class="card">
  <h4>\u8F6C\u5199 / \u8F93\u5165</h4>
  <div id="transcript" class="empty">\uFF08\u8FD8\u6CA1\u6709\u5185\u5BB9\uFF09</div>
  <div class="row" style="margin-top:8px">
    <button id="retry">\u64A4\u56DE\u91CD\u8BF4</button>
    <button id="speak" title="\u628A\u672C\u8F6E\u56DE\u590D\u4ECE\u5934\u518D\u5FF5\u4E00\u904D">\u91CD\u8BFB\u4E00\u904D</button>
    <button id="ttsStop" title="\u7ACB\u523B\u505C\u6B62\u6717\u8BFB">\u505C\u6B62\u6717\u8BFB</button>
  </div>
  <textarea id="text" placeholder="\u6587\u5B57\u515C\u5E95\uFF1A\u76F4\u63A5\u8F93\u5165\u8981\u4EA4\u7ED9\u4F1A\u8BDD\u7684\u8BDD"></textarea>
  <div class="row" style="margin-top:8px"><button id="send" style="flex:1">\u53D1\u9001\u5230\u5F53\u524D\u4F1A\u8BDD</button></div>
  <div class="row" style="margin-top:8px"><button id="end" style="flex:1;border-color:#b04545">\u7ED3\u675F\u672C\u6B21\u8BED\u97F3\u4F1A\u8BDD</button></div>
  <div class="hint">\u300C\u7ED3\u675F\u300D\u4F1A\u7ACB\u523B\u89E3\u9664\u5371\u9669\u52A8\u4F5C\u95F8\u95E8\uFF08\u4E0D\u7528\u7B49 120 \u79D2\u7A7A\u95F2\uFF09\uFF0C\u4E4B\u540E\u4F60\u81EA\u5DF1\u5728\u4F1A\u8BDD\u91CC\u7684\u64CD\u4F5C\u5B8C\u5168\u4E0D\u53D7\u5F71\u54CD\u3002</div>
</div>

<div class="card" id="ask">
  <h4>\u26A0 \u5371\u9669\u52A8\u4F5C\u786E\u8BA4</h4>
  <div class="title" id="askTitle">\u2014</div>
  <div class="detail" id="askDetail"></div>
  <div class="row"><button class="yes" id="askYes">\u786E\u8BA4</button><button id="askNo">\u53D6\u6D88</button></div>
</div>

<div class="card">
  <h4>\u4E8B\u4EF6</h4>
  <div id="events"></div>
</div>

<div id="drop">\u677E\u5F00\u5373\u53EF\u4E0A\u4F20\u8FD9\u6BB5\u97F3\u9891</div>

<script>
(function () {
  'use strict';
  var LANE = ${lane};
  var PROTOCOL = ${protocol};
  /* \u771F\u673A\u5C4F\u5E55\u89C4\u683C\uFF1A\u4E0E src/tihu/screen-spec.ts \u540C\u4E00\u4EFD\u5E38\u91CF\uFF08\u9875\u9762\u53EA\u6D88\u8D39\uFF0C\u4E0D\u53E6\u5199\u6570\u503C\uFF09\u3002 */
  var SCREEN = ${JSON.stringify(SCREEN_SPEC)};
  var ACTUAL_SCALE = ${JSON.stringify(ACTUAL_SIZE_SCALE)};
  function clipScreen(value, max) {
    var text = String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    if (text === '') return '';
    var chars = Array.from(text);
    if (chars.length <= max) return text;
    return chars.slice(0, Math.max(1, max - 1)).join('') + '\u2026';
  }
  function fitLines(lines, maxLines) {
    return (lines || []).filter(function (line) { return String(line || '').trim() !== ''; }).slice(0, maxLines);
  }
  /** \u6309\u50CF\u7D20\u5BBD\u5EA6\u6298\u884C\uFF08CJK 1em / ASCII 0.47em\uFF09\uFF0C\u4E0E screen-spec \u540C\u4E00\u4F30\u7B97\u3002 */
  function wrapPx(text, width, fontPx) {
    var out = [];
    var current = '';
    var used = 0;
    var chars = Array.from(String(text || ''));
    for (var i = 0; i < chars.length; i += 1) {
      var code = chars[i].codePointAt(0) || 0;
      var wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff);
      var charWidth = (wide ? 1 : 0.47) * fontPx;
      if (current !== '' && used + charWidth > width) {
        out.push(current);
        current = '';
        used = 0;
      }
      current += chars[i];
      used += charWidth;
    }
    if (current !== '') out.push(current);
    return out;
  }
  var $ = function (id) { return document.getElementById(id); };
  var state = { ws: null, seq: 0, clientId: '', sessionId: '', sessionTitle: '', sessionSource: '',
    sessions: [], listLoaded: false, querying: false, showList: false,
    sessionBound: false, computerUse: null, sessionPreset: '', cuTotal: 0, total: 0,
    mode: 'auto', lastAutoId: '',
    lastTranscript: '', asking: null, recorder: null, chunks: [], retryTimer: 0, audioPending: false, audioTimer: 0,
    ttsTurnTexts: [], ttsAudioSeen: {},
    audioCtx: null, pcmSources: [], pcmNextTime: 0, turnPcm: [],
    voice: 'default', voices: [], voiceEngine: null,
    reply: null, replyCharPos: 0, replyTimer: 0, highlightLock: false, audioStarted: false, screenMode: 'status', pending: [] };

  /* ---------- \u4F1A\u8BDD\u5B9A\u4F4D ----------
     2026-11-07 P0\uFF1AlocalStorage **\u6309 origin \u9694\u79BB**\u3002\u7528\u6237\u5728\u684C\u9762\u5BBF\u4E3B
     \uFF08http://127.0.0.1:57440\uFF09\u9009\u8FC7\u4F1A\u8BDD\uFF0C\u6253\u5F00\u516C\u7F51 http://<\u516C\u7F51IP>:<\u7AEF\u53E3>/tihu \u65F6
     \u90A3\u4E2A key \u6839\u672C\u4E0D\u5B58\u5728 \u2014\u2014 \u65E7\u5B9E\u73B0\u76F4\u63A5\u62A5\u300C\u8FD8\u6CA1\u6709\u4F1A\u8BDD\u300D\u3002\u73B0\u5728\u6309\u8FD9\u4E2A\u987A\u5E8F\u627E\uFF1A
       1. URL ?session=<id>\uFF08\u6700\u9AD8\u4F18\u5148\u7EA7\uFF0C\u7ED1\u5B9A\u540E\u5199\u56DE\uFF09\uFF1B
       2. \u672C origin \u81EA\u5DF1\u7684 dsh.tihu.session\uFF08\u9875\u9762\u81EA\u5DF1\u9009\u8FC7\u7684\uFF09\uFF1B
       3. \u5BBD\u677E\u8BFB\u4E00\u6B21 dsh.sessions.current\uFF08\u53EA\u5728\u540C origin \u6253\u5F00\u65F6\u624D\u6709\u7528\uFF09\uFF1B
       4. \u90FD\u6CA1\u6709 \u2192 \u4E0D\u62A5\u9519\uFF0C\u663E\u793A\u4E0B\u9762\u7684\u9009\u62E9\u5668\uFF0C\u70B9\u4E00\u6761\u5373\u7ED1\u5B9A\u3002
   */
  var SESSION_KEY = 'dsh.tihu.session';
  var LEGACY_SESSION_KEY = 'dsh.sessions.current';

  function urlSessionId() {
    try { return new URLSearchParams(location.search).get('session') || ''; } catch (e) { return ''; }
  }
  /** \u4ECE\u4EFB\u610F\u6587\u672C\u91CC\u5BBD\u677E\u62A0\u4E00\u4E2A\u4F1A\u8BDD id\uFF08\u65E7 key \u53EF\u80FD\u662F JSON\u3001\u4E5F\u53EF\u80FD\u662F\u88F8\u5B57\u7B26\u4E32\uFF09\u3002 */
  function looseSessionId(raw) {
    if (!raw) return '';
    var match = String(raw).match(/session-[0-9a-zA-Z-]{8,}/);
    if (match) return match[0];
    try {
      var value = JSON.parse(raw);
      var fields = [value, value && value.sessionId, value && value.id, value && value.current];
      for (var i = 0; i < fields.length; i += 1) {
        if (typeof fields[i] === 'string' && /^[0-9a-zA-Z/_-]{8,}$/.test(fields[i])) return fields[i];
      }
    } catch (e) { /* \u4E0D\u662F JSON\uFF1A\u5FFD\u7565 */ }
    return '';
  }
  function storedSessionId() {
    try { return localStorage.getItem(SESSION_KEY) || ''; } catch (e) { return ''; }
  }
  function rememberSessionId(sessionId) {
    try {
      if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* \u9690\u79C1\u6A21\u5F0F\u5FFD\u7565 */ }
  }
  function legacySessionId() {
    try { return looseSessionId(localStorage.getItem(LEGACY_SESSION_KEY)); } catch (e) { return ''; }
  }
  function pickInitialSession() {
    // \u81EA\u52A8\u7ED1\u5B9A\u4F18\u5148\u7EA7\uFF1AURL\uFF08\u663E\u5F0F\uFF09> \u4E0A\u6B21\u8BB0\u4F4F\u7684\uFF08\u6821\u9A8C\u540E\uFF09> \u6700\u8FD1\u6D3B\u8DC3\u7684 CU\uFF08\u5BBF\u4E3B\u81EA\u52A8\uFF09> \u9009\u62E9\u5668\u3002
    var fromUrl = urlSessionId();
    if (fromUrl) return { id: fromUrl, source: 'url', mode: 'manual' };
    var stored = storedSessionId();
    if (stored) return { id: stored, source: 'local', mode: 'manual' };
    var legacy = legacySessionId();
    if (legacy) return { id: legacy, source: 'legacy', mode: 'manual' };
    return { id: '', source: '', mode: 'auto' };
  }
  /** \u4E0A\u6B21\u81EA\u52A8\u7ED1\u5B9A\u5230\u7684\u4F1A\u8BDD id\uFF08localStorage\uFF0C\u7528\u6765\u8BC6\u522B\u300C\u5DF2\u81EA\u52A8\u8DDF\u968F\u5230\u300D\uFF09\u3002 */
  function lastAutoSessionId() {
    try { return localStorage.getItem('dsh.tihu.auto') || ''; } catch (e) { return ''; }
  }
  function rememberAutoSessionId(sessionId) {
    try {
      if (sessionId) localStorage.setItem('dsh.tihu.auto', sessionId);
      else localStorage.removeItem('dsh.tihu.auto');
    } catch (e) { /* \u9690\u79C1\u6A21\u5F0F\u5FFD\u7565 */ }
  }
  function shortId(sessionId) {
    if (!sessionId) return '';
    return String(sessionId).replace(/^session-/, '').slice(0, 8);
  }

  /* ---------- \u5C4F ---------- */
  function fitTextPx(text, width, fontPx) {
    var chars = Array.from(String(text || ''));
    var out = '';
    var used = 0;
    for (var i = 0; i < chars.length; i += 1) {
      var code = chars[i].codePointAt(0) || 0;
      var wide = (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff);
      var w = (wide ? 1 : 0.47) * fontPx;
      if (used + w + fontPx * 0.47 > width) return out === '' ? '\u2026' : out + '\u2026';
      out += chars[i];
      used += w;
    }
    return out;
  }
  function renderPending(payload) {
    var screen = $('screen');
    var rail = $('pendingRail');
    var items = Array.isArray(payload.pending) ? payload.pending : [];
    state.pending = items;
    rail.innerHTML = '';
    if (items.length > 0) screen.classList.add('rail-on');
    else screen.classList.remove('rail-on');
    for (var i = 0; i < items.length && i < 4; i += 1) {
      var chip = document.createElement('div');
      chip.className = 'pending-chip';
      chip.dataset.sessionId = items[i].sessionId;
      var name = document.createElement('div');
      name.className = 'pending-name';
      name.textContent = fitTextPx(items[i].title || items[i].sessionId, 48, 11);
      var sub = document.createElement('div');
      sub.className = 'pending-sub';
      var dot = document.createElement('span');
      dot.className = 'pending-dot';
      sub.appendChild(dot);
      sub.appendChild(document.createTextNode('\u65B0\u56DE\u590D'));
      chip.appendChild(name);
      chip.appendChild(sub);
      rail.appendChild(chip);
    }
    if ((payload.pendingCount || items.length) > items.length) {
      var more = document.createElement('div');
      more.className = 'pending-more';
      more.textContent = '+' + ((payload.pendingCount || items.length) - items.length);
      rail.appendChild(more);
    }
  }

  function renderScreen(payload) {
    var screen = $('screen');
    renderPending(payload || {});
    if (payload && payload.mode === 'home' && payload.home) {
      state.screenMode = 'home';
      state.reply = null;
      state.highlightLock = false;
      $('stage').textContent = '\u9879\u76EE ' + payload.home.total + ' \u4E2A \xB7 ' + (payload.home.page.index + 1) + '/' + payload.home.page.total;
      $('replyBody').innerHTML = '';
      var homeBody = $('homeBody');
      homeBody.innerHTML = '';
      var projects = payload.home.projects || [];
      for (var pi = 0; pi < projects.length; pi += 1) {
        var project = projects[pi];
        var item = document.createElement('div');
        item.className = 'home-item';
        var row1 = document.createElement('div');
        row1.className = 'home-row1';
        var dot = document.createElement('span');
        dot.className = 'home-dot ' + (project.status || 'idle');
        var name = document.createElement('span');
        name.className = 'name';
        name.textContent = project.name;
        row1.appendChild(dot);
        row1.appendChild(name);
        var row2 = document.createElement('div');
        row2.className = 'home-row2';
        row2.textContent = project.summary || '';
        item.appendChild(row1);
        item.appendChild(row2);
        homeBody.appendChild(item);
      }
      screen.className = 'home-mode';
      return;
    }
    if (payload && payload.mode === 'reply' && payload.reply) {
      state.screenMode = 'reply';
      var lockedIndex = state.highlightLock && state.reply ? state.reply.currentIndex : null;
      state.reply = payload.reply;
      if (lockedIndex !== null && payload.reply.sentences.some(function (s) { return s.index === lockedIndex; })) {
        state.reply.currentIndex = lockedIndex;
      }
      if (typeof payload.reply.charPos === 'number') state.replyCharPos = payload.reply.charPos;
      $('stage').textContent = clipScreen(payload.stage || '\u56DE\u7B54\u4E2D', SCREEN.stageChars);
      screen.className = (payload.tone || 'ok') + ' reply-mode';
      renderReply();
      return;
    }
    state.screenMode = 'status';
    state.reply = null;
    // \u4E25\u683C\u6309 320\xD7240 \u89C4\u683C\u6392\u7248\uFF1Astage \u226410\u3001\u6807\u9898 \u226428 \u4E14\u5355\u884C\u3001\u6B63\u6587\u6700\u591A 3 \u884C \xD718 \u5B57\u3002
    // \u591A\u51FA\u6765\u7684\u5185\u5BB9\u7559\u5728\u4E8B\u4EF6\u533A\uFF0C\u5C4F\u5E55\u4E0A\u4E0D\u5141\u8BB8\u51FA\u73B0\u534A\u884C\u6216\u6EDA\u52A8\u6761\u3002
    $('stage').textContent = clipScreen(payload.stage || '', SCREEN.stageChars);
    $('title').textContent = clipScreen(payload.title || '', SCREEN.titleChars);
    var list = $('bullets');
    list.innerHTML = '';
    fitLines(payload.bullets || [], SCREEN.maxBodyLines, SCREEN.bodyCharsPerLine).forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    });
    $('replyBody').innerHTML = '';
    screen.className = payload.tone || 'idle';
    var progress = payload.progress;
    if (progress && typeof progress.done === 'number') {
      $('progress').textContent = progress.total ? (progress.done + '/' + progress.total) : String(progress.done);
      $('fill').style.width = progress.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) + '%' : '0%';
    }
  }

  /* reply \u6A21\u5F0F\u6E32\u67D3\uFF1A\u53E5\u5B50\u7A97\u53E3 \u2192 \u6BCF\u884C 18 \u5B57 \u2192 \u53EF\u89C6 10 \u884C\uFF0C\u5F53\u524D\u53E5\u53CD\u8272\u5E76\u5C45\u4E2D\u3002 */
  function renderReply() {
    var reply = state.reply;
    var body = $('replyBody');
    if (!reply || !Array.isArray(reply.sentences)) return;
    var lines = [];
    if (Array.isArray(reply.lines) && reply.lines.length) {
      for (var li = 0; li < reply.lines.length; li += 1) {
        lines.push({ text: reply.lines[li].text, index: reply.lines[li].sentenceIndex });
      }
    } else {
      var contentWidth = (SCREEN.widthPx || 320) - 2 * (SCREEN.paddingPx || 8);
      for (var i = 0; i < reply.sentences.length; i += 1) {
        var sentence = reply.sentences[i];
        var wrapped = wrapPx(sentence.text || '', contentWidth, SCREEN.bodyFontPx || 16);
        for (var w = 0; w < wrapped.length; w += 1) lines.push({ text: wrapped[w], index: sentence.index });
      }
    }
    var current = typeof reply.currentIndex === 'number' ? reply.currentIndex : 0;
    var visible = SCREEN.replyVisibleLines;
    var currentLine = 0;
    for (var j = 0; j < lines.length; j += 1) { if (lines[j].index === current) { currentLine = j; break; } }
    // \u5BBF\u4E3B\u5DF2\u7ECF\u6309 scrollOffset \u5207\u597D\u53EF\u89C6\u7A97\u53E3\uFF0C\u9875\u9762\u76F4\u63A5\u6E32\u67D3\uFF0C\u4E0D\u518D\u81EA\u884C\u5C45\u4E2D\u3002
    var start = 0;
    body.innerHTML = '';
    for (var k = start; k < Math.min(start + visible, lines.length); k += 1) {
      var div = document.createElement('div');
      div.className = 'reply-line' + (state.audioStarted && lines[k].index === current ? ' cur' : '');
      div.textContent = lines[k].text;
      body.appendChild(div);
    }
    var hint = $('scrollHint');
    if (hint) {
      var scroll = reply.scroll || { offset: 0, maxOffset: 0 };
      if (scroll.offset > 0) hint.textContent = '\u2191 \u4E0A\u65B9\u8FD8\u6709 ' + scroll.offset + ' \u884C';
      else if (scroll.maxOffset > 0) hint.textContent = '\u2193 \u4E0B\u65B9\u8FD8\u6709 ' + scroll.maxOffset + ' \u884C';
      else hint.textContent = '';
    }
  }

  function addEvent(kind, text) {
    var row = document.createElement('div');
    row.className = kind;
    row.textContent = new Date().toLocaleTimeString() + '  ' + text;
    $('events').appendChild(row);
  }

  /* ---------- \u4F1A\u8BDD\u9009\u62E9\u5668\uFF08\u5C4F\u4E0B\uFF0C\u53EA\u5217 Computer Use \u6A21\u5F0F\uFF09 ----------
   * \u9E48\u9E55\u8981\u9760 GUI \u770B\u5C4F\u5E55\u3001\u70B9\u6309\u94AE\uFF1A\u53EA\u6709 Computer Use / \u7535\u8111\u64CD\u4F5C\u6A21\u5F0F\u7684\u4F1A\u8BDD\u80FD\u63A5\u8FD9\u6D3B\u3002
   * \u6A21\u5F0F\u5224\u5B9A**\u53EA\u8BA4\u5BBF\u4E3B\u8FD4\u56DE\u7684 agentPreset**\uFF08\u6295\u5F71 agentPreset\uFF0C\u56DE\u9000 header\uFF09\uFF0C
   * \u4E0D\u9760\u6807\u9898\u731C\u3002\u5BBF\u4E3B\u53EA\u4E0B\u53D1 CU \u4F1A\u8BDD\uFF1B\u975E CU \u4F1A\u8BDD\u5728\u9875\u9762\u4E0A\u53EA\u80FD\u662F\u300C\u5F53\u524D\uFF08\u4E0D\u53EF\u7528\uFF09\u300D\u7070\u8272\u884C\u3002
   */
  function sessionLabel() {
    if (state.sessionTitle) return state.sessionTitle;
    return state.sessionId ? shortId(state.sessionId) : '';
  }
  function requestSessions() {
    if (!state.ws || state.ws.readyState !== 1) return;
    state.listLoaded = false;
    state.querying = true;
    renderSessionList();
    send('sessions.query', { limit: 20, checkId: state.sessionId || undefined });
  }
  function setComputerUseNotice(ok, preset) {
    state.computerUse = ok;
    state.sessionPreset = preset || '';
    var warn = $('cuWarn');
    if (ok === false) {
      warn.textContent = '\u26A0 \u8FD9\u6761\u4F1A\u8BDD\u4E0D\u662F Computer Use \u6A21\u5F0F'
        + (state.sessionPreset ? '\uFF08' + state.sessionPreset + '\uFF09' : '')
        + '\uFF1A\u65E0\u6CD5\u770B\u5C4F/\u70B9\u6309\u3002\u8BF7\u4ECE\u4E0B\u9762\u6362\u4E00\u4E2A Computer Use \u4F1A\u8BDD\u3002';
    } else {
      warn.textContent = '';
    }
  }
  function renderSessionBar() {
    var label = sessionLabel();
    var modeText = state.mode === 'auto' ? '\uFF08\u81EA\u52A8\uFF09' : '\uFF08\u624B\u52A8\uFF09';
    if (state.sessionBound) {
      $('sessNow').textContent = '\u5F53\u524D\u4F1A\u8BDD\uFF1A' + label + modeText;
      $('sessNow').className = 'sess-now' + (state.computerUse === false ? ' bad' : '');
      $('sessLine').textContent = '\u5F53\u524D\u4F1A\u8BDD\uFF1A' + label + modeText;
      $('sessLine').className = 'device-caption' + (state.computerUse === false ? ' bad' : '');
    } else if (state.sessionId) {
      $('sessNow').textContent = '\u6B63\u5728\u786E\u8BA4\u4F1A\u8BDD ' + shortId(state.sessionId) + '\u2026';
      $('sessNow').className = 'sess-now';
      $('sessLine').textContent = '\u5F53\u524D\u4F1A\u8BDD\uFF1A\u786E\u8BA4\u4E2D' + modeText;
      $('sessLine').className = 'device-caption none';
    } else {
      $('sessNow').textContent = state.mode === 'auto'
        ? '\u6B63\u5728\u81EA\u52A8\u7ED1\u5B9A\u6700\u8FD1\u6D3B\u8DC3\u7684 Computer Use \u4F1A\u8BDD\u2026'
        : '\u8FD8\u6CA1\u6709\u9009\u5B9A\u4F1A\u8BDD\uFF0C\u70B9\u4E0B\u9762\u9009\u4E00\u4E2A';
      $('sessNow').className = 'sess-now none';
      $('sessLine').textContent = '\u5F53\u524D\u4F1A\u8BDD\uFF1A\u672A\u9009\u5B9A' + modeText;
      $('sessLine').className = 'device-caption none';
    }
    $('sessSwitch').style.display = state.sessionBound ? '' : 'none';
    $('sessSwitch').textContent = state.showList ? '\u6536\u8D77\u4F1A\u8BDD\u5217\u8868' : '\u6362\u4E2A\u4F1A\u8BDD';
    $('sessAuto').style.display = (state.sessionBound && state.mode === 'manual') ? '' : 'none';
    $('sessList').style.display = (state.sessionBound && !state.showList && state.computerUse !== false) ? 'none' : 'flex';
    $('cuWarn').style.display = state.computerUse === false ? 'block' : 'none';
  }
  function renderSessionList() {
    var box = $('sessList');
    box.innerHTML = '';
    // \u5F53\u524D\u7ED1\u5B9A\u7684\u975E CU \u4F1A\u8BDD\uFF1A\u7F6E\u7070\u4FDD\u7559\uFF08\u7528\u6237\u53EF\u80FD\u4ECE ?session= \u663E\u5F0F\u6307\u5B9A\uFF09\uFF0C\u4E0D\u53EF\u70B9\u3002
    if (state.sessionBound && state.computerUse === false && state.sessionId) {
      var current = document.createElement('div');
      current.className = 'sess-item off';
      var currentTitle = document.createElement('span');
      currentTitle.className = 't';
      currentTitle.textContent = (state.sessionTitle || ('\u4F1A\u8BDD ' + shortId(state.sessionId))) + '\uFF08\u5F53\u524D\uFF09';
      var currentMeta = document.createElement('span');
      currentMeta.className = 'm';
      currentMeta.textContent = '\u975E Computer Use\uFF0C\u8BED\u97F3\u64CD\u4F5C\u4E0D\u53EF\u7528';
      current.appendChild(currentTitle);
      current.appendChild(currentMeta);
      box.appendChild(current);
    }
    if (!state.sessions.length) {
      var note = document.createElement('div');
      note.className = 'hint';
      note.textContent = state.listLoaded
        ? (state.cuTotal === 0
            ? '\u8FD8\u6CA1\u6709 Computer Use \u6A21\u5F0F\u4F1A\u8BDD\uFF1A\u5148\u5728\u684C\u9762\u7AEF\u65B0\u5EFA\u4E00\u4E2A Computer Use \u6A21\u5F0F\u4F1A\u8BDD\uFF0C\u518D\u56DE\u6765\u70B9\u300C\u5237\u65B0\u4F1A\u8BDD\u5217\u8868\u300D\u3002'
            : '\u6700\u8FD1\u4F1A\u8BDD\u91CC\u6CA1\u6709 Computer Use \u6A21\u5F0F\uFF08\u5171 ' + state.total + ' \u6761\uFF09\uFF1A\u8BF7\u5237\u65B0\uFF0C\u6216\u65B0\u5EFA\u4E00\u4E2A CU \u4F1A\u8BDD\u3002')
        : '\u6B63\u5728\u8BFB\u53D6\u4F1A\u8BDD\u5217\u8868\u2026';
      box.appendChild(note);
      return;
    }
    state.sessions.forEach(function (row) {
      var item = document.createElement('button');
      item.className = 'sess-item' + (row.sessionId === state.sessionId ? ' on' : '');
      var title = document.createElement('span');
      title.className = 't';
      title.textContent = row.title || ('\u4F1A\u8BDD ' + shortId(row.sessionId));
      var meta = document.createElement('span');
      meta.className = 'm';
      meta.textContent = 'Computer Use \xB7 ' + (row.live ? '\u684C\u9762\u6253\u5F00\u4E2D' : '\u672A\u6253\u5F00') + ' \xB7 ' + shortId(row.sessionId);
      item.appendChild(title);
      item.appendChild(meta);
      item.onclick = function () { chooseSession(row.sessionId, row.title || ''); };
      box.appendChild(item);
    });
  }
  function chooseSession(sessionId, title) {
    if (!sessionId) return;
    state.sessionId = sessionId;
    state.sessionTitle = title || '';
    state.showList = false;
    renderSessionBar();
    renderSessionList();
    addEvent('progress', '\u6B63\u5728\u7ED1\u5B9A Computer Use \u4F1A\u8BDD ' + shortId(sessionId) + '\u2026');
    send('session.bind', { sessionId: sessionId });
  }
  function checkedTitle(sessionId) {
    for (var i = 0; i < state.sessions.length; i += 1) {
      if (state.sessions[i].sessionId === sessionId && state.sessions[i].title) return state.sessions[i].title;
    }
    return '';
  }
  /** \u624B\u52A8\u4F1A\u8BDD\u5931\u6548 / \u4E0D\u662F CU\uFF1A\u6309\u4F18\u5148\u7EA7\u56DE\u843D\u5230\u300C\u81EA\u52A8\u7ED1\u5B9A\u6700\u8FD1\u6D3B\u8DC3 CU\u300D\u3002 */
  function fallbackToAuto(reason) {
    state.sessionId = '';
    state.sessionTitle = '';
    state.sessionBound = false;
    state.sessionSource = '';
    state.computerUse = null;
    state.sessionPreset = '';
    state.mode = 'auto';
    rememberSessionId('');
    setComputerUseNotice(null, '');
    state.showList = true;
    $('sessHint').textContent = reason + '\u5DF2\u6539\u4E3A\u81EA\u52A8\u7ED1\u5B9A\u6700\u8FD1\u6D3B\u8DC3\u7684 Computer Use \u4F1A\u8BDD\u3002';
    addEvent('alert', reason + '\u5DF2\u6539\u4E3A\u81EA\u52A8\u7ED1\u5B9A');
    renderSessionBar();
    renderSessionList();
    if (state.ws && state.ws.readyState === 1) send('session.bind', { auto: true });
  }
  function handleSessionList(payload) {
    state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    state.listLoaded = true;
    state.querying = false;
    state.cuTotal = typeof payload.cuTotal === 'number' ? payload.cuTotal : state.sessions.length;
    state.total = typeof payload.total === 'number' ? payload.total : state.cuTotal;

    var check = payload.check;
    if (state.sessionId && check && check.sessionId === state.sessionId) {
      // \u4E0D\u5B58\u5728\uFF1A\u53EF\u8BFB\u63D0\u793A + \u56DE\u843D\u5230\u81EA\u52A8\uFF08\u4E0D\u767D\u5C4F\uFF09\u3002
      if (check.found === false) {
        handleSessionInvalid({
          sessionId: state.sessionId,
          reason: '\u4F1A\u8BDD ' + shortId(state.sessionId) + ' \u4E0D\u5728\u5BBF\u4E3B\u4F1A\u8BDD\u5217\u8868\u91CC\uFF08\u53EF\u80FD\u5DF2\u5F52\u6863\u6216\u5220\u9664\uFF09\u3002'
        });
        return;
      }
      var cu = check.computerUse === true;
      if (state.sessionSource === 'url') {
        // ?session= \u663E\u5F0F\u6307\u5B9A \u2014\u2014 \u5141\u8BB8\u7ED1\u5B9A\u975E CU\uFF0C\u4F46\u5FC5\u987B\u663E\u8457\u63D0\u793A\uFF08\u5BBF\u4E3B\u540C\u65F6\u4E0B\u53D1\u7EA2\u8272\u5C4F\u5E27\uFF09\u3002
        setComputerUseNotice(cu, check.preset);
      } else if (!cu) {
        // \u4E0A\u6B21\u8BB0\u4F4F\u7684\u4F1A\u8BDD\u5DF2\u7ECF\u4E0D\u662F CU / \u4E0D\u662F CU\uFF1A\u6309\u4F18\u5148\u7EA7\u56DE\u843D\u5230\u81EA\u52A8\u3002
        fallbackToAuto('\u4E0A\u6B21\u8BB0\u4F4F\u7684\u4F1A\u8BDD\u4E0D\u662F Computer Use \u6A21\u5F0F\u3002');
        return;
      } else if (!state.sessionBound) {
        // \u4ECD\u662F CU\uFF1A\u9875\u9762\u5148\u786E\u8BA4\uFF0C\u518D\u8BA9\u5BBF\u4E3B\u7ED1\u5B9A\uFF08\u624B\u52A8\uFF09\u3002
        chooseSession(state.sessionId, checkedTitle(state.sessionId) || state.sessionTitle);
        return;
      } else {
        setComputerUseNotice(true, check.preset);
      }
    }

    if (state.sessionId && state.sessionBound) {
      var title = checkedTitle(state.sessionId);
      if (title) state.sessionTitle = title;
    }
    renderSessionBar();
    renderSessionList();
    if (!state.sessionBound && state.listLoaded) {
      $('sessHint').textContent = state.cuTotal === 0
        ? '\u6CA1\u6709\u53EF\u81EA\u52A8\u7ED1\u5B9A\u7684 CU \u4F1A\u8BDD\uFF1A\u5148\u5728\u684C\u9762\u7AEF\u65B0\u5EFA\u4E00\u4E2A Computer Use \u6A21\u5F0F\u4F1A\u8BDD\uFF0C\u518D\u70B9\u300C\u5237\u65B0\u4F1A\u8BDD\u5217\u8868\u300D\u3002'
        : '\u5217\u8868\u53EA\u663E\u793A Computer Use \u6A21\u5F0F\u4F1A\u8BDD\uFF1B\u81EA\u52A8\u6A21\u5F0F\u4F1A\u8DDF\u968F\u6700\u8FD1\u6D3B\u8DC3\u7684\u4E00\u6761\uFF0C\u624B\u52A8\u9009\u4E00\u6B21\u5C31\u4EE5\u624B\u52A8\u4E3A\u51C6\u3002';
    }
  }
  function handleSessionBound(payload) {
    if (!payload || !payload.sessionId) return;
    var auto = payload.auto === true;
    var previousAuto = auto ? state.lastAutoId : '';
    state.mode = auto ? 'auto' : 'manual';
    state.sessionId = payload.sessionId;
    state.sessionTitle = payload.title || state.sessionTitle || '';
    state.sessionBound = true;
    state.showList = false;
    var cu = payload.computerUse === true;
    setComputerUseNotice(cu, payload.preset);
    // \u624B\u52A8\u8BB0\u5FC6\u53EA\u8BB0\u624B\u52A8\u9009\u4E2D\u7684 CU \u4F1A\u8BDD\uFF1B\u81EA\u52A8\u6A21\u5F0F\u4E0D\u5199 dsh.tihu.session\uFF0C\u907F\u514D\u628A\u81EA\u52A8\u9501\u6B7B\u3002
    rememberSessionId(!auto && cu ? payload.sessionId : '');
    if (auto) {
      state.lastAutoId = payload.sessionId;
      rememberAutoSessionId(payload.sessionId);
    }
    renderSessionBar();
    renderSessionList();
    var followed = auto && (payload.followed === true || (previousAuto !== '' && previousAuto !== payload.sessionId));
    if (followed) {
      $('sessHint').textContent = '\u5DF2\u81EA\u52A8\u8DDF\u968F\u5230\uFF1A' + sessionLabel()
        + '\uFF08' + (payload.live ? '\u684C\u9762\u6B63\u5F00\u7740' : '\u672A\u6253\u5F00') + '\uFF09\u3002';
      addEvent('done', '\u5DF2\u81EA\u52A8\u8DDF\u968F\u5230\uFF1A' + sessionLabel());
      return;
    }
    $('sessHint').textContent = cu
      ? (auto
          ? '\u5DF2\u81EA\u52A8\u7ED1\u5B9A\u6700\u8FD1\u6D3B\u8DC3\u7684 Computer Use \u4F1A\u8BDD\uFF1B\u684C\u9762\u7AEF\u5207\u5230\u522B\u7684 CU \u4F1A\u8BDD\u65F6\u4F1A\u81EA\u52A8\u8DDF\u968F\u3002'
          : (payload.live
              ? '\u5DF2\u624B\u52A8\u7ED1\u5B9A Computer Use \u4F1A\u8BDD\uFF0C\u684C\u9762\u6B63\u5F00\u7740\u5B83\u3002'
              : '\u5DF2\u624B\u52A8\u7ED1\u5B9A CU \u4F1A\u8BDD\uFF1B\u5B83\u5F53\u524D\u6CA1\u5728\u684C\u9762\u6253\u5F00\uFF0C\u8BED\u97F3\u6CE8\u5165\u524D\u5148\u5728\u684C\u9762\u6253\u5F00\u3002'))
      : '\u5DF2\u7ED1\u5B9A\uFF0C\u4F46\u8FD9\u6761\u4E0D\u662F Computer Use \u6A21\u5F0F\uFF1A\u65E0\u6CD5\u770B\u5C4F/\u70B9\u6309\uFF0C\u8BF7\u6362\u4E00\u4E2A CU \u4F1A\u8BDD\u3002';
    addEvent(cu ? 'done' : 'alert',
      (cu ? (auto ? '\u5DF2\u81EA\u52A8\u7ED1\u5B9A\uFF1A' : '\u5DF2\u7ED1\u5B9A\u4F1A\u8BDD\uFF1A') : '\u5DF2\u7ED1\u5B9A\u975E CU \u4F1A\u8BDD\uFF1A') + sessionLabel());
  }
  function handleSessionInvalid(payload) {
    if (!payload) return;
    if (state.sessionId === payload.sessionId) {
      state.sessionId = '';
      state.sessionTitle = '';
      state.sessionBound = false;
      if (storedSessionId() === payload.sessionId) rememberSessionId('');
    }
    addEvent('alert', payload.reason || ('\u4F1A\u8BDD ' + shortId(payload.sessionId) + ' \u4E0D\u5B58\u5728\uFF0C\u5DF2\u6539\u4E3A\u81EA\u52A8\u7ED1\u5B9A'));
    fallbackToAuto(payload.reason || ('\u4F1A\u8BDD ' + shortId(payload.sessionId) + ' \u4E0D\u5B58\u5728\u3002'));
  }

  /* ---------- \u672C\u5730 TTS\uFF08PCM\uFF09\u64AD\u653E ----------
     sidecar \u4EE5 24kHz/pcm16 \u6D41\u5F0F\u4E0B\u53D1\uFF0C\u9875\u9762\u7528 WebAudio \u65E0\u7F1D\u6392\u961F\u62FC\u63A5\u3002
     \u9875\u9762\u53EA\u64AD\u653E\u5BBF\u4E3B\u5408\u6210\u7684 PCM\uFF08edge \u4E91\u5065 / Qwen GPU\uFF09\uFF0C\u4E0D\u518D\u4F7F\u7528\u6D4F\u89C8\u5668\u8BED\u97F3\u3002 */
  function ensureAudio() {
    if (state.audioCtx) return state.audioCtx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      state.audioCtx = new Ctx({ sampleRate: 24000 });
    } catch (e) {
      try { state.audioCtx = new Ctx(); } catch (e2) { state.audioCtx = null; }
    }
    return state.audioCtx;
  }
  function stopPcm() {
    for (var i = 0; i < state.pcmSources.length; i += 1) {
      try { state.pcmSources[i].stop(); } catch (e) { /* \u5DF2\u7ED3\u675F */ }
    }
    state.pcmSources = [];
    state.pcmNextTime = 0;
  }
  function playPcm(base64, sampleRate) {
    if (!base64) return null;
    var ctx = ensureAudio();
    if (!ctx) return null;
    try {
      var binary = atob(base64);
      var count = Math.floor(binary.length / 2);
      var samples = new Float32Array(count);
      for (var i = 0; i < count; i += 1) {
        var value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
        if (value >= 0x8000) value -= 0x10000;
        samples[i] = value / 32768;
      }
      var buffer = ctx.createBuffer(1, count, sampleRate);
      buffer.copyToChannel(samples, 0);
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      var startAt = Math.max(ctx.currentTime + 0.03, state.pcmNextTime || 0);
      source.start(startAt);
      state.pcmNextTime = startAt + buffer.duration;
      state.pcmSources.push(source);
      source.onended = function () {
        var index = state.pcmSources.indexOf(source);
        if (index >= 0) state.pcmSources.splice(index, 1);
        if (state.audioCtx && state.pcmNextTime <= state.audioCtx.currentTime + 0.05) state.highlightLock = false;
      };
      // \u91CD\u8BFB\u7F13\u5B58\uFF08\u672C\u8F6E\u5B8C\u6574 PCM\uFF09
      state.turnPcm.push(samples);
      return { startAt: startAt, duration: buffer.duration };
    } catch (e) { /* \u89E3\u7801\u5931\u8D25\uFF1A\u672C\u6761\u53EA\u663E\u793A\u6587\u5B57 */ }
    return null;
  }
  /** \u6309\u771F\u5B9E\u64AD\u653E\u65F6\u523B\u5207\u6362\u5F53\u524D\u53E5\uFF1A\u4E0D\u518D\u7528 tts.audio \u5230\u8FBE\u5373\u8DF3\u3002 */
  function scheduleHighlight(charStart, startAt) {
    if (typeof charStart !== 'number' || !state.reply || !Array.isArray(state.reply.sentences)) return;
    var ctx = state.audioCtx;
    if (!ctx) return;
    state.highlightLock = true;
    var delay = Math.max(0, (startAt - ctx.currentTime) * 1000);
    setTimeout(function () {
      state.audioStarted = true;
      if (!state.reply) return;
      for (var i = 0; i < state.reply.sentences.length; i += 1) {
        var sentence = state.reply.sentences[i];
        if (charStart >= sentence.start && charStart < sentence.end) {
          state.reply.currentIndex = sentence.index;
          renderReply();
          return;
        }
      }
    }, delay);
  }
  function resetTurnAudio() {
    stopPcm();
    clearInterval(state.replyTimer);
    state.replyTimer = 0;
    state.ttsTurnTexts = [];
    state.ttsAudioSeen = {};
    state.turnPcm = [];
    state.highlightLock = false;
    state.audioStarted = false;
  }
  function replayPcm() {
    var chunks = state.turnPcm;
    if (!chunks.length) return false;
    stopPcm();
    var ctx = ensureAudio();
    if (!ctx) return false;
    var when = ctx.currentTime + 0.05;
    for (var i = 0; i < chunks.length; i += 1) {
      var buffer = ctx.createBuffer(1, chunks[i].length, 24000);
      buffer.copyToChannel(chunks[i], 0);
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(when);
      when += buffer.duration;
      state.pcmSources.push(source);
      (function (src) { src.onended = function () { var at = state.pcmSources.indexOf(src); if (at >= 0) state.pcmSources.splice(at, 1); }; })(source);
    }
    state.pcmNextTime = when;
    return true;
  }

  /* ---------- \u97F3\u8272\u9009\u62E9 ---------- */
  function renderVoiceSelect() {
    var select = $('voiceSelect');
    if (!select) return;
    select.innerHTML = '';
    for (var i = 0; i < state.voices.length; i += 1) {
      var option = document.createElement('option');
      option.value = state.voices[i].name;
      option.textContent = state.voices[i].kind === 'default' ? '\u9ED8\u8BA4\u97F3\u8272' : (state.voices[i].name + (state.voices[i].durationMs ? '\uFF08' + Math.round(state.voices[i].durationMs / 1000) + 's\uFF09' : ''));
      if (state.voices[i].name === state.voice) option.selected = true;
      select.appendChild(option);
    }
    var engine = state.voiceEngine;
    if (engine && engine.available === false) {
      $('voiceHint').textContent = '\u65E0\u8BED\u97F3\uFF1A' + (engine.error || '\u5728\u7EBF\u515C\u5E95\u4E0D\u53EF\u7528\u4E14\u672C\u5730\u5F15\u64CE\u672A\u5C31\u7EEA') + '\uFF08\u672C\u6761\u53EA\u663E\u793A\u6587\u5B57\uFF09\u3002';
    } else {
      var model = (engine && engine.model) || '\u672C\u5730\u5F15\u64CE';
      if (model.indexOf('edge-tts') >= 0) {
        $('voiceHint').textContent = '\u5728\u7EBF\u515C\u5E95\uFF1Aedge-tts \u4E91\u5065(Yunjian) / \u97F3\u8272 \u9ED8\u8BA4\u3002\u4EC5\u53EF\u7528\u4E8E\u4F60\u672C\u4EBA\u6216\u5DF2\u83B7\u6388\u6743\u7684\u97F3\u8272\u3002';
      } else {
        $('voiceHint').textContent = '\u672C\u5730 TTS\uFF1A' + model + ' / \u97F3\u8272 ' + state.voice + '\u3002\u4EC5\u53EF\u7528\u4E8E\u4F60\u672C\u4EBA\u6216\u5DF2\u83B7\u6388\u6743\u7684\u97F3\u8272\uFF1B\u53C2\u8003\u97F3\u9891\u53EA\u5728\u672C\u673A\u5904\u7406\u3002';
      }
    }
  }

  /* ---------- WebSocket ----------
     2026-11-06 P0 \u4FEE\u590D\uFF1A**token \u5FC5\u987B\u8FDB\u63E1\u624B URL**\u3002
     \u65E7\u5B9E\u73B0\u53EA\u9760 HttpOnly cookie\uFF1A\u7528 "?token=" \u6253\u5F00\u9875\u9762\u65F6 HTML \u80FD\u62FF\u5230\uFF08\u8D70 query \u5206\u652F\uFF09\uFF0C
     \u4F46\u53EA\u8981\u6D4F\u89C8\u5668\u91CC\u6CA1\u6709\u53EF\u7528 cookie\uFF08\u6216\u5E26\u7740\u4E00\u4E2A\u8FC7\u671F\u7684\u65E7 cookie\uFF09\uFF0CWS \u63E1\u624B\u5C31\u4E00\u5F8B 401\uFF0C
     \u9875\u9762\u8868\u73B0\u4E3A\u6BCF 2 \u79D2 onerror \u91CD\u8FDE\uFF08"WebSocket \u51FA\u9519"\uFF09\u3002\u5B9E\u6D4B\u540C\u4E00\u53F0\u673A\u5668\u4E0A\u7528\u771F\u5B9E
     Chrome \u5E26 token \u63E1\u624B \u2192 101 + \u5C4F\u5E27\uFF1B\u4E0D\u5E26\u4EFB\u4F55\u51ED\u636E \u2192 \u7ACB\u523B\u5931\u8D25\u3002
     \u6240\u4EE5\uFF1AURL \u4E0A\u7684 token \u4F18\u5148\uFF0C\u5176\u6B21 sessionStorage\uFF08\u5237\u65B0/\u6362\u9875\u540E\u4ECD\u7136\u8BB0\u5F97\uFF09\uFF0C
     \u6700\u540E\u624D\u9000\u56DE cookie\u3002\u8FD9\u6761\u4E0D\u6539\u9274\u6743\u5F3A\u5EA6\u2014\u2014\u8FD8\u662F\u540C\u4E00\u4E2A PIN\uFF0C\u53EA\u662F\u6362\u4E2A\u4F4D\u7F6E\u5E26\u3002 */
  function tokenFromUrl() {
    try { return new URLSearchParams(location.search).get('token') || ''; } catch (e) { return ''; }
  }
  function rememberedToken() {
    try { return sessionStorage.getItem('tihu.token') || ''; } catch (e) { return ''; }
  }
  function rememberToken(token) {
    if (!token) return;
    try { sessionStorage.setItem('tihu.token', token); } catch (e) { /* \u9690\u79C1\u6A21\u5F0F\u5FFD\u7565 */ }
  }
  function laneUrl() {
    var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var token = tokenFromUrl() || rememberedToken();
    rememberToken(token);
    var url = scheme + location.host + LANE;
    if (token) url += '?token=' + encodeURIComponent(token);
    return url;
  }

  function connect() {
    var ws = new WebSocket(laneUrl());
    state.ws = ws;
    ws.onopen = function () {
      $('conn').textContent = '\u5DF2\u8FDE\u63A5';
      $('conn').className = 'on';
      state.clientId = state.clientId || ('web-' + Math.random().toString(36).slice(2, 10));
      if (!state.sessionId && !state.sessionBound) {
        var picked = pickInitialSession();
        state.mode = picked.mode;
        if (picked.id) {
          state.sessionId = picked.id;
          state.sessionSource = picked.source;
        }
      }
      state.lastAutoId = state.lastAutoId || lastAutoSessionId();
      // \u81EA\u52A8\u6A21\u5F0F\uFF1A\u4E0D\u5E26 id \u8BA9\u5BBF\u4E3B\u6311\u300C\u6700\u8FD1\u6D3B\u8DC3\u7684 CU \u4F1A\u8BDD\u300D\uFF1B\u624B\u52A8\u6A21\u5F0F\uFF1AURL \u76F4\u63A5\u7ED1\uFF0C
      // \u672C\u673A\u8BB0\u4F4F\u7684\u4F1A\u8BDD\u5148\u8BA9\u5BBF\u4E3B\u6821\u9A8C\u300C\u4ECD\u5B58\u5728\u4E14\u4ECD\u662F CU\u300D\u518D\u7ED1\u3002
      var helloSession = '';
      if (state.mode === 'manual') {
        if (state.sessionBound) helloSession = state.sessionId;
        else if (state.sessionSource === 'url') helloSession = state.sessionId;
      }
      sendHello(helloSession, state.mode === 'auto');
      if (!helloSession && state.mode !== 'auto' && !state.sessionId) {
        // \u4E0D\u62A5\u9519\uFF1A\u63D0\u793A\u53EF\u64CD\u4F5C\uFF0C\u5E76\u5C55\u5F00\u5C4F\u4E0B\u7684\u9009\u62E9\u5668\u3002
        state.showList = true;
        addEvent('progress', '\u8FD8\u6CA1\u6709\u9009\u5B9A\u4F1A\u8BDD\uFF0C\u70B9\u4E0B\u9762\u9009\u4E00\u4E2A');
      }
      renderSessionBar();
      requestSessions();
      send('voice.list', {});
      try { send('voice.select', { name: state.voice || 'default', edgeVoice: $('edgeVoiceSelect').value, offlineOnly: $('offlineOnly').checked }); } catch (e) { /* \u5FFD\u7565 */ }
      clearInterval(state.retryTimer);
      state.retryTimer = setInterval(function () { send('ping', { nonce: String(Date.now()) }); }, 25000);
    };
    ws.onclose = function (event) {
      $('conn').textContent = '\u5DF2\u65AD\u5F00' + (event && event.code ? '\uFF08' + event.code + '\uFF09' : '');
      $('conn').className = 'off';
      state.audioPending = false;
      clearTimeout(state.audioTimer);
      addEvent('alert', '\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF0C2 \u79D2\u540E\u81EA\u52A8\u91CD\u8FDE\uFF08\u671F\u95F4\u53D1\u9001\u7684\u5185\u5BB9\u4E0D\u4F1A\u9001\u8FBE\uFF09');
      clearInterval(state.retryTimer);
      setTimeout(connect, 2000);
    };
    ws.onerror = function () {
      var token = tokenFromUrl() || rememberedToken();
      addEvent('alert', 'WebSocket \u51FA\u9519\uFF08' + (token ? '\u51ED\u636E\u5DF2\u5E26\uFF0C\u68C0\u67E5\u7F51\u7EDC/\u5BBF\u4E3B\u662F\u5426\u5728\u8DD1' : '\u6CA1\u627E\u5230 token\uFF1A\u8BF7\u7528\u5E26 ?token= \u7684\u94FE\u63A5\u6253\u5F00\u672C\u9875') + '\uFF09');
    };
    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (!msg || msg.v !== PROTOCOL) return;           /* \u672A\u77E5\u7248\u672C\uFF1A\u5FFD\u7565 */
      handle(msg.type, msg.payload || {});
    };
  }
  function send(type, payload) {
    if (!state.ws || state.ws.readyState !== 1) { addEvent('alert', '\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u7A0D\u540E\u518D\u8BD5'); return; }
    state.seq += 1;
    state.ws.send(JSON.stringify({
      v: PROTOCOL, type: type, id: 'dev-' + Date.now().toString(36) + '-' + state.seq, seq: state.seq, ts: Date.now(), payload: payload
    }));
  }
  /** \u53D1 hello\uFF1BsessionId \u4E3A\u7A7A\u4E32\u8868\u793A\u300C\u4E0D\u6307\u5B9A\u4F1A\u8BDD\u300D\uFF08\u81EA\u52A8\u6A21\u5F0F\u4E0B\u7531\u5BBF\u4E3B\u6311\u6700\u6D3B\u8DC3 CU\uFF09\u3002 */
  function sendHello(sessionId, auto) {
    send('hello', {
      clientId: state.clientId,
      clientVersion: 'p0-page-5',
      protocol: PROTOCOL,
      capabilities: { screen: true, tts: true, microphone: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) },
      deviceName: '\u6D4F\u89C8\u5668\u6A21\u62DF\u8BBE\u5907',
      sessionId: sessionId || undefined,
      auto: auto === true ? true : undefined
    });
  }

  /* ---------- \u4E0B\u884C\u5904\u7406\uFF08\u672A\u77E5 type \u4E00\u5F8B\u5FFD\u7565\uFF0C\u4E0E\u5BBF\u4E3B\u540C\u4E00\u6761\u7EA6\u5B9A\uFF09 ---------- */
  function handle(type, payload) {
    switch (type) {
      case 'screen.frame':
        // \u65B0\u4E00\u8F6E\u56DE\u590D\u5F00\u59CB\uFF1A\u6E05\u7A7A\u4E0A\u4E00\u8F6E\u6717\u8BFB\uFF08\u961F\u5217 + \u5168\u6587\u7F13\u5B58 + PCM\uFF09\u3002tts.text \u7D27\u8DDF\u5176\u540E\u3002
        if (payload && payload.stage === '\u56DE\u590D') resetTurnAudio();
        renderScreen(payload);
        break;
      case 'transcript':
        state.lastTranscript = payload.text || '';
        state.audioPending = false;
        clearTimeout(state.audioTimer);
        // \u7528\u6237\u65B0\u4E00\u8F6E\u8F93\u5165 = \u65B0\u4E00\u8F6E\u6717\u8BFB\uFF0C\u505C\u6389\u4E0A\u4E00\u8F6E\u6B8B\u7559\u3002
        resetTurnAudio();
        $('transcript').textContent = state.lastTranscript;
        $('transcript').className = '';
        addEvent('progress', '\u8F6C\u5199\uFF1A' + state.lastTranscript);
        break;
      case 'tts.text': {
        var ttsText = String(payload.text || '').trim();
        if (ttsText) state.ttsTurnTexts.push(ttsText);
        break;
      }
      case 'tts.audio': {
        var audioIndex = typeof payload.index === 'number' ? payload.index : 0;
        var isNewSegment = !state.ttsAudioSeen[audioIndex];
        state.ttsAudioSeen[audioIndex] = true;
        if (typeof payload.charStart === 'number') state.replyCharPos = payload.charStart;
        var played = playPcm(String(payload.data || ''), Number(payload.sampleRate) || 24000);
        if (played && isNewSegment && typeof payload.charStart === 'number') {
          scheduleHighlight(payload.charStart, played.startAt);
        }
        break;
      }
      case 'voice.list': {
        state.voices = Array.isArray(payload.voices) ? payload.voices : [];
        state.voiceEngine = payload.engine || null;
        if (typeof payload.selected === 'string' && payload.selected !== '') state.voice = payload.selected;
        renderVoiceSelect();
        break;
      }
      case 'voice.created': {
        var created = payload && payload.voice ? payload.voice : null;
        if (created && created.name) {
          state.voice = created.name;
          send('voice.select', { name: created.name });
          addEvent('done', payload.cached ? ('\u97F3\u8272 ' + created.name + ' \u5DF2\u5B58\u5728\uFF08\u7F13\u5B58\uFF09') : ('\u5DF2\u521B\u5EFA\u97F3\u8272 ' + created.name));
        }
        break;
      }
      case 'event.progress':
        addEvent('progress', (payload.stage ? '[' + payload.stage + '] ' : '') + (payload.text || ''));
        if (typeof payload.done === 'number') { $('progress').textContent = payload.total ? payload.done + '/' + payload.total : String(payload.done); }
        break;
      case 'event.alert':
        if (payload.level === 'error') {
          // \u5BBF\u4E3B\u5DF2\u7ECF\u660E\u786E\u62A5\u9519\uFF08\u8F6C\u5199\u5931\u8D25/\u5E27\u88AB\u62D2\uFF09\uFF0C\u4E0D\u518D\u8BA9 15 \u79D2\u8D85\u65F6\u91CD\u590D\u63D0\u793A\u3002
          state.audioPending = false;
          clearTimeout(state.audioTimer);
        }
        // \u672C\u5730 TTS \u5931\u8D25\uFF1A\u7ACB\u523B\u628A\u6240\u6709\u5F85\u5FF5\u6587\u672C\u4EA4\u7ED9\u7CFB\u7EDF\u8BED\u97F3\uFF0C\u522B\u8BA9\u7528\u6237\u7B49 4 \u79D2\u515C\u5E95\u3002
        addEvent('alert', (payload.level === 'error' ? '\u9519\u8BEF\uFF1A' : '') + (payload.text || ''));
        break;
      case 'event.done': addEvent('done', payload.text || '\u5B8C\u6210'); break;
      case 'confirm.ask': showConfirm(payload); break;
      case 'sessions.list': handleSessionList(payload); break;
      case 'session.bound': handleSessionBound(payload); break;
      case 'session.invalid': handleSessionInvalid(payload); break;
      case 'pong': break;
      default: break; /* \u672A\u77E5 type\uFF1A\u5FFD\u7565 */
    }
  }

  /* ---------- \u5371\u9669\u52A8\u4F5C\u786E\u8BA4 ---------- */
  function showConfirm(payload) {
    state.asking = payload;
    $('askTitle').textContent = payload.title || '\u9700\u8981\u786E\u8BA4';
    $('askDetail').textContent = payload.detail || '';
    $('ask').classList.add('on');
    if (payload.timeoutMs) {
      setTimeout(function () {
        if (state.asking && state.asking.confirmId === payload.confirmId) { reply(payload.confirmId, false); addEvent('alert', '\u786E\u8BA4\u8D85\u65F6\uFF0C\u5DF2\u81EA\u52A8\u53D6\u6D88'); }
      }, payload.timeoutMs);
    }
  }
  function reply(confirmId, approved) {
    state.asking = null;
    $('ask').classList.remove('on');
    send('confirm.reply', { confirmId: confirmId, approved: approved });
  }
  $('askYes').onclick = function () { if (state.asking) reply(state.asking.confirmId, true); };
  $('askNo').onclick = function () { if (state.asking) reply(state.asking.confirmId, false); };

  /* ---------- \u4F1A\u8BDD\u9009\u62E9\u5668\u6309\u94AE ---------- */
  $('sessSwitch').onclick = function () {
    state.showList = !state.showList;
    renderSessionBar();
    renderSessionList();
  };
  /* \u6062\u590D\u81EA\u52A8\uFF1A\u6E05\u6389\u624B\u52A8\u8BB0\u5FC6\uFF0C\u4EA4\u56DE\u5BBF\u4E3B\u300C\u6700\u8FD1\u6D3B\u8DC3 CU \u4F1A\u8BDD\u300D\u81EA\u52A8\u8DDF\u968F\u3002 */
  $('sessAuto').onclick = function () {
    state.sessionId = '';
    state.sessionTitle = '';
    state.sessionBound = false;
    state.sessionSource = '';
    state.computerUse = null;
    state.sessionPreset = '';
    state.mode = 'auto';
    state.showList = false;
    rememberSessionId('');
    setComputerUseNotice(null, '');
    renderSessionBar();
    renderSessionList();
    addEvent('progress', '\u5DF2\u5207\u56DE\u81EA\u52A8\uFF1A\u6B63\u5728\u7ED1\u5B9A\u6700\u8FD1\u6D3B\u8DC3\u7684 Computer Use \u4F1A\u8BDD\u2026');
    send('session.bind', { auto: true });
  };
  $('sessRefresh').onclick = function () { requestSessions(); };

  /* ---------- \u771F\u673A\u5C4F\u5E55\uFF1A\u7F29\u653E\u4E09\u6863 + \u5916\u58F3\u5F00\u5173\uFF08\u53EA\u5F71\u54CD\u663E\u793A\uFF0C\u4E0D\u6539 320\xD7240 \u5185\u5BB9\uFF09 ---------- */
  var SCALE_MODES = {
    '1': { scale: 1, label: '320 \xD7 240 \u663E\u793A\uFF081\xD7\uFF09' },
    '2': { scale: 2, label: '640 \xD7 480 \u663E\u793A\uFF082\xD7\uFF09' },
    'actual': { scale: ACTUAL_SCALE, label: '\u5B9E\u9645\u5C3A\u5BF8\uFF08\u224861 \xD7 45.7 mm\uFF0C\u8FD1\u4F3C\uFF09' }
  };
  var scaleButtons = document.querySelectorAll('.screen-tools button[data-scale]');
  function applyScale(mode) {
    var spec = SCALE_MODES[mode] || SCALE_MODES['2'];
    $('device').style.setProperty('--screen-scale', String(spec.scale));
    $('scaleHint').textContent = spec.label;
    for (var i = 0; i < scaleButtons.length; i += 1) {
      scaleButtons[i].className = scaleButtons[i].getAttribute('data-scale') === mode ? 'on' : '';
    }
  }
  for (var s = 0; s < scaleButtons.length; s += 1) {
    (function (button) {
      button.onclick = function () { applyScale(button.getAttribute('data-scale')); };
    })(scaleButtons[s]);
  }
  applyScale('2');
  var shellOn = true;
  $('shellToggle').onclick = function () {
    shellOn = !shellOn;
    $('deviceWrap').className = 'device-wrap' + (shellOn ? '' : ' shell-off');
    $('shellToggle').textContent = shellOn ? '\u4EC5\u5C4F\u5E55' : '\u663E\u793A\u5916\u58F3';
  };

  /* ---------- \u97F3\u9891\uFF1A\u4EFB\u610F\u97F3\u9891 \u2192 16 kHz \u5355\u58F0\u9053 16 bit WAV ---------- */
  function encodeWav(samples, sampleRate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    var writeText = function (offset, text) { for (var i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    var offset = 44;
    for (var j = 0; j < samples.length; j += 1, offset += 2) {
      var s = Math.max(-1, Math.min(1, samples[j]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buffer);
  }
  function toBase64(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }
  /* \u89E3\u7801 \u2192 \u5355\u58F0\u9053 \u2192 \u7EBF\u6027\u63D2\u503C\u91CD\u91C7\u6837\u5230\u76EE\u6807\u91C7\u6837\u7387 \u2192 WAV */
  function decodeToMono(arrayBuffer, target) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 AudioContext'));
    var context = new Ctx();
    return context.decodeAudioData(arrayBuffer).then(function (audio) {
      var source = audio.numberOfChannels > 1 ? mergeChannels(audio) : audio.getChannelData(0);
      var ratio = audio.sampleRate / target;
      var length = Math.round(source.length / ratio);
      var samples = new Float32Array(length);
      for (var i = 0; i < length; i += 1) {
        var pos = i * ratio;
        var lo = Math.floor(pos);
        var hi = Math.min(lo + 1, source.length - 1);
        var frac = pos - lo;
        samples[i] = source[lo] * (1 - frac) + source[hi] * frac;
      }
      try { context.close(); } catch (e) { /* \u5FFD\u7565 */ }
      return { wav: encodeWav(samples, target), durationMs: Math.round(length / target * 1000), sampleRate: target };
    });
  }
  function decodeAndResample(arrayBuffer) {
    return decodeToMono(arrayBuffer, 16000);
  }
  function mergeChannels(audio) {
    var length = audio.length;
    var merged = new Float32Array(length);
    for (var c = 0; c < audio.numberOfChannels; c += 1) {
      var data = audio.getChannelData(c);
      for (var i = 0; i < length; i += 1) merged[i] += data[i] / audio.numberOfChannels;
    }
    return merged;
  }
  function sendAudio(arrayBuffer, label) {
    if (!state.sessionId) {
      addEvent('alert', '\u8FD8\u6CA1\u6709\u9009\u5B9A\u4F1A\u8BDD\uFF1A\u70B9\u4E0B\u9762\u7684\u4F1A\u8BDD\u5217\u8868\u9009\u4E00\u4E2A');
      state.showList = true;
      renderSessionBar();
      return;
    }
    decodeAndResample(arrayBuffer).then(function (result) {
      addEvent('progress', label + '\uFF1A' + result.durationMs + ' ms\uFF0C\u5DF2\u4E0A\u884C\uFF0C\u7B49\u5F85\u8F6C\u5199\u2026');
      send('audio.frame', {
        format: 'wav', sampleRate: 16000, channels: 1, bits: 16,
        audioBase64: toBase64(result.wav), durationMs: result.durationMs
      });
      // \u9875\u9762\u4FA7\u515C\u5E95\uFF1A15 \u79D2\u6CA1\u7B49\u5230 transcript \u5C31\u660E\u786E\u62A5\u8D85\u65F6\uFF0C\u4E0D\u80FD\u5E72\u7B49\u3002
      state.audioPending = true;
      clearTimeout(state.audioTimer);
      state.audioTimer = setTimeout(function () {
        if (!state.audioPending) return;
        state.audioPending = false;
        addEvent('alert', '\u8F6C\u5199\u8D85\u65F6\uFF1A15 \u79D2\u5185\u6CA1\u6709\u6536\u5230\u8F6C\u5199\u7ED3\u679C\uFF08\u97F3\u9891\u592A\u957F/\u670D\u52A1\u5FD9/\u94FE\u8DEF\u65AD\u4E86\uFF09\uFF0C\u8BF7\u91CD\u8BD5\u6216\u6539\u7528\u6587\u5B57\u8F93\u5165');
      }, 15000);
    }).catch(function (error) {
      addEvent('alert', '\u89E3\u7801\u5931\u8D25\uFF1A' + error.message + '\uFF08\u6362\u6210 16k/44.1k \u7684 WAV/MP3 \u518D\u8BD5\uFF09');
    });
  }

  /* ---------- \u6309\u4F4F\u8BF4\u8BDD ---------- */
  var talk = $('talk');
  function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      addEvent('alert', '\u8FD9\u4E2A\u6D4F\u89C8\u5668\u6CA1\u6709\u9EA6\u514B\u98CE\u63A5\u53E3\uFF1A\u8BF7\u7528\u300C\u9009 WAV \u6587\u4EF6\u300D');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var recorder = new MediaRecorder(stream);
      state.recorder = recorder;
      state.chunks = [];
      recorder.ondataavailable = function (event) { if (event.data && event.data.size > 0) state.chunks.push(event.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' });
        blob.arrayBuffer().then(function (buffer) { sendAudio(buffer, '\u5F55\u97F3'); });
      };
      recorder.start();
      talk.classList.add('rec');
      talk.textContent = '\u677E\u5F00\u53D1\u9001\u2026';
    }).catch(function (error) {
      addEvent('alert', '\u9EA6\u514B\u98CE\u6253\u4E0D\u5F00\uFF1A' + error.message + '\uFF08\u7528\u300C\u9009 WAV \u6587\u4EF6\u300D\u4EE3\u66FF\uFF09');
    });
  }
  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    state.recorder = null;
    talk.classList.remove('rec');
    talk.textContent = '\u6309\u4F4F\u8BF4\u8BDD';
  }
  talk.addEventListener('pointerdown', function (event) { event.preventDefault(); startRecording(); });
  talk.addEventListener('pointerup', function (event) { event.preventDefault(); stopRecording(); });
  talk.addEventListener('pointercancel', stopRecording);
  talk.addEventListener('pointerleave', function () { if (state.recorder) stopRecording(); });

  /* ---------- \u6587\u4EF6 / \u62D6\u62FD ---------- */
  $('file').addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    file.arrayBuffer().then(function (buffer) { sendAudio(buffer, file.name); });
    event.target.value = '';
  });
  var drop = $('drop');
  window.addEventListener('dragover', function (event) { event.preventDefault(); drop.classList.add('on'); });
  window.addEventListener('dragleave', function (event) { if (event.relatedTarget === null) drop.classList.remove('on'); });
  window.addEventListener('drop', function (event) {
    event.preventDefault();
    drop.classList.remove('on');
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) file.arrayBuffer().then(function (buffer) { sendAudio(buffer, file.name); });
  });

  /* ---------- \u6587\u672C / \u64A4\u56DE ---------- */
  $('send').onclick = function () {
    var text = $('text').value.trim();
    if (!text) return;
    if (!state.sessionId) {
      addEvent('alert', '\u8FD8\u6CA1\u6709\u9009\u5B9A\u4F1A\u8BDD\uFF1A\u70B9\u4E0B\u9762\u7684\u4F1A\u8BDD\u5217\u8868\u9009\u4E00\u4E2A');
      state.showList = true;
      renderSessionBar();
      return;
    }
    send('text.input', { text: text, source: 'keyboard' });
    $('transcript').textContent = text;
    $('transcript').className = '';
    $('text').value = '';
  };
  $('retry').onclick = function () {
    state.lastTranscript = '';
    $('transcript').textContent = '\uFF08\u8FD8\u6CA1\u6709\u5185\u5BB9\uFF09';
    $('transcript').className = 'empty';
    addEvent('progress', '\u5DF2\u64A4\u56DE\u4E0A\u4E00\u6761\u8F6C\u5199\uFF0C\u8BF7\u91CD\u65B0\u8BF4');
  };
  /* \u91CD\u8BFB\u4E00\u904D\uFF1A\u628A\u672C\u8F6E\u6240\u6709 tts \u6BB5\u62FC\u56DE\u6765\u7684\u5168\u6587**\u4ECE\u5934\u91CD\u64AD**\uFF08\u4E0D\u662F\u53EA\u8BFB\u6700\u540E\u4E00\u6BB5\uFF09\u3002 */
  $('speak').onclick = function () {
    if (state.turnPcm.length === 0) { addEvent('alert', '\u8FD8\u6CA1\u6709\u53EF\u91CD\u8BFB\u7684\u672C\u5730\u97F3\u9891'); return; }
    if (replayPcm()) addEvent('progress', '\u91CD\u8BFB\u672C\u8F6E\u5168\u6587\uFF08\u672C\u5730\u97F3\u9891\uFF09');
  };
  $('ttsStop').onclick = function () {
    stopPcm();
    addEvent('progress', '\u5DF2\u505C\u6B62\u6717\u8BFB');
  };

  /* ---------- \u97F3\u8272\uFF1A\u9009\u62E9 / \u4E0A\u4F20\u53C2\u8003\u97F3\u9891 ---------- */
  $('voiceSelect').onchange = function () {
    state.voice = this.value || 'default';
    send('voice.select', { name: state.voice, edgeVoice: $('edgeVoiceSelect').value });
    renderVoiceSelect();
  };
  (function initEdgeVoice() {
    var saved = '';
    try { saved = localStorage.getItem('tihu.edgeVoice') || ''; } catch (e) { /* \u5FFD\u7565 */ }
    if (saved) $('edgeVoiceSelect').value = saved;
    try { $('offlineOnly').checked = localStorage.getItem('tihu.offlineOnly') === '1'; } catch (e) { /* \u5FFD\u7565 */ }
  })();
  $('edgeVoiceSelect').onchange = function () {
    try { localStorage.setItem('tihu.edgeVoice', this.value); } catch (e) { /* \u5FFD\u7565 */ }
    send('voice.select', { name: state.voice, edgeVoice: this.value, offlineOnly: $('offlineOnly').checked });
    addEvent('progress', '\u5728\u7EBF\u515C\u5E95\u97F3\u8272\uFF1A' + this.options[this.selectedIndex].textContent);
  };
  $('offlineOnly').onchange = function () {
    try { localStorage.setItem('tihu.offlineOnly', this.checked ? '1' : '0'); } catch (e) { /* \u5FFD\u7565 */ }
    send('voice.select', { name: state.voice, edgeVoice: $('edgeVoiceSelect').value, offlineOnly: this.checked });
    addEvent('progress', this.checked ? '\u5DF2\u5F00\u542F\u4EC5\u79BB\u7EBF\uFF1A\u7981\u7528 edge \u4E91\u5065' : '\u5DF2\u5173\u95ED\u4EC5\u79BB\u7EBF\uFF1A\u4F18\u5148 edge \u4E91\u5065');
  };
  $('voiceRefresh').onclick = function () { send('voice.list', {}); };

  /* ---------- \u5C4F\u5E55\u624B\u52BF\uFF1A\u6EDA\u8F6E / \u62D6\u62FD / \u89E6\u6478 \u2192 screen.gesture\uFF08\u5BBF\u4E3B\u6301\u6709\u6EDA\u52A8\u4F4D\u7F6E\uFF09 ---------- */
  (function bindScreenGestures() {
    var screen = $('screen');
    var dragging = false;
    var lastY = 0;
    var startX = 0;
    var startY = 0;
    var moved = false;
    function swipe(dy, phase) {
      if (!state.reply && state.screenMode !== 'home') return;
      send('screen.gesture', { action: 'swipe', dy: dy, phase: phase });
    }
    screen.addEventListener('wheel', function (event) {
      if (!state.reply && state.screenMode !== 'home') return;
      event.preventDefault();
      swipe(event.deltaY, 'move');
    }, { passive: false });
    screen.addEventListener('pointerdown', function (event) {
      if (!state.reply && state.screenMode !== 'home') return;
      dragging = true;
      moved = false;
      lastY = event.clientY;
      startX = event.clientX;
      startY = event.clientY;
      try { screen.setPointerCapture(event.pointerId); } catch (e) { /* \u5FFD\u7565 */ }
      event.preventDefault();
    });
    screen.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      var dy = event.clientY - lastY;
      lastY = event.clientY;
      if (Math.abs(event.clientX - startX) > 5 || Math.abs(event.clientY - startY) > 5) moved = true;
      if (dy !== 0) swipe(dy, 'move');
      event.preventDefault();
    });
    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      if (!moved && event) {
        var rect = screen.getBoundingClientRect();
        var x = event.clientX - rect.left;
        var y = event.clientY - rect.top;
        var hit = null;
        var chips = document.querySelectorAll('#pendingRail .pending-chip');
        for (var ci = 0; ci < chips.length; ci += 1) {
          var chipRect = chips[ci].getBoundingClientRect();
          if (x >= chipRect.left - rect.left - 8 && x <= chipRect.right - rect.left + 8 &&
              y >= chipRect.top - rect.top - 8 && y <= chipRect.bottom - rect.top + 8) {
            hit = chips[ci].dataset.sessionId;
            break;
          }
        }
        if (hit) send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'chip', targetSessionId: hit });
        else send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'screen' });
        return;
      }
      swipe(0, 'end');
    }
    screen.addEventListener('pointerup', endDrag);
    screen.addEventListener('pointercancel', endDrag);
    screen.addEventListener('touchstart', function (event) {
      if (!state.reply || !event.touches.length) return;
      lastY = event.touches[0].clientY;
      event.preventDefault();
    }, { passive: false });
    screen.addEventListener('touchmove', function (event) {
      if (!state.reply || !event.touches.length) return;
      var dy = event.touches[0].clientY - lastY;
      lastY = event.touches[0].clientY;
      if (dy !== 0) swipe(dy, 'move');
      event.preventDefault();
    }, { passive: false });
    screen.addEventListener('touchend', function (event) {
      if (!state.reply) return;
      swipe(0, 'end');
      event.preventDefault();
    }, { passive: false });
  })();
  $('voiceFile').addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    var typed = String($('voiceName').value || '').trim();
    var fallback = String(file.name || 'voice').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    var name = typed || ('voice-' + fallback + '-' + Date.now().toString(36).slice(-4));
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name) || name === 'default') {
      addEvent('alert', '\u97F3\u8272\u540D\u53EA\u80FD\u5305\u542B\u82F1\u6587/\u6570\u5B57/\u4E0B\u5212\u7EBF/\u77ED\u6A2A\u7EBF\uFF081\u201332 \u5B57\uFF0C\u4E0D\u80FD\u53EB default\uFF09');
      return;
    }
    addEvent('progress', '\u6B63\u5728\u5904\u7406\u53C2\u8003\u97F3\u9891\uFF08' + file.name + '\uFF09\u2026');
    file.arrayBuffer().then(function (buffer) {
      return decodeToMono(buffer, 24000);
    }).then(function (result) {
      if (result.durationMs < 3000 || result.durationMs > 10000) {
        addEvent('alert', '\u53C2\u8003\u97F3\u9891\u9700 3\u201310 \u79D2\uFF08\u5F53\u524D ' + (result.durationMs / 1000).toFixed(1) + ' \u79D2\uFF09');
        return;
      }
      send('voice.create', {
        name: name,
        wavBase64: toBase64(result.wav),
        note: String($('voiceNote').value || '').trim()
      });
      addEvent('progress', '\u5DF2\u4E0A\u4F20\u53C2\u8003\u97F3\u9891\uFF08' + (result.durationMs / 1000).toFixed(1) + ' \u79D2\uFF09\uFF0C\u7B49\u5F85 embedding\u2026');
    }).catch(function (error) {
      addEvent('alert', '\u53C2\u8003\u97F3\u9891\u89E3\u7801\u5931\u8D25\uFF1A' + error.message);
    });
  });

  /* \u300C\u7ED3\u675F\u672C\u6B21\u8BED\u97F3\u4F1A\u8BDD\u300D\uFF1A\u5BBF\u4E3B\u4FA7\u7ACB\u523B\u5173\u6389\u5371\u9669\u52A8\u4F5C\u95F8\u95E8\uFF08session.end\uFF09\uFF0C
     \u4E0D\u7B49 120 \u79D2\u7A7A\u95F2\u7A97\u53E3\u8FC7\u671F\u2014\u2014\u7528\u6237\u8BF4\u5B8C\u5C31\u53EF\u4EE5\u653E\u5FC3\u81EA\u5DF1\u5E72\u6D3B\u3002 */
  $('end').onclick = function () {
    send('session.end', { reason: 'button', sessionId: state.sessionId || undefined });
    addEvent('progress', '\u5DF2\u7ED3\u675F\u672C\u6B21\u8BED\u97F3\u4F1A\u8BDD\uFF08\u95F8\u95E8\u5173\u95ED\uFF09');
    $('screen').className = 'idle';
    $('stage').textContent = '\u7A7A\u95F2';
    $('title').textContent = '\u5DF2\u7ED3\u675F\u672C\u6B21\u4F1A\u8BDD';
  };

  renderSessionBar();
  renderSessionList();
  connect();
})();
</script>
</body>
</html>`;
}

// src/tihu/progress.ts
var TIHU_LINE_CHARS = SCREEN_SPEC.bodyCharsPerLine;
var TIHU_TITLE_CHARS = SCREEN_SPEC.titleChars;
var TIHU_EVENT_CHARS = 120;
function clipText(value, max) {
  if (max >= 40) return clipScreenText(value, max);
  const fontPx = max >= 20 ? SCREEN_SPEC.titleFontPx : SCREEN_SPEC.bodyFontPx;
  return fitLine(value, CONTENT_WIDTH_PX, fontPx);
}
function sanitizeScreenLine(value) {
  return String(value ?? "").replace(/^\s*```[a-zA-Z0-9_-]*\s*/, "").replace(/```\s*$/, "").replace(/`/g, "").replace(/\*\*/g, "").replace(/^[-*#>\s]+/, "").replace(/\s+/g, " ").trim();
}
function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1e3));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
function asRecord(value) {
  return value !== null && typeof value === "object" ? value : {};
}
function asArguments(value) {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
}
function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}
function baseNameOf(path3) {
  const parts = String(path3 ?? "").split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? String(path3 ?? "") : parts[parts.length - 1];
}
function describeTool(name2, args) {
  const tool = String(name2 ?? "").trim();
  const lower = tool.toLowerCase();
  const params = asRecord(args);
  const file = firstString(params, ["path", "file_path", "filePath", "file", "filename", "target", "target_file"]);
  const matched = (list) => list.some((item) => lower === item || lower.includes(item));
  if (matched(["read", "read_file", "readfile", "view_file", "cat", "open_file"])) {
    return { stage: "\u8BFB\u6587\u4EF6", title: clipText(`\u8BFB\u53D6 ${baseNameOf(file) || "\u6587\u4EF6"}`, TIHU_TITLE_CHARS), detail: clipText(file, TIHU_EVENT_CHARS) };
  }
  if (matched(["write", "write_file", "writefile", "create_file", "save_file"])) {
    return { stage: "\u5199\u6587\u4EF6", title: clipText(`\u5199\u5165 ${baseNameOf(file) || "\u6587\u4EF6"}`, TIHU_TITLE_CHARS), detail: clipText(file, TIHU_EVENT_CHARS) };
  }
  if (matched(["edit", "apply_patch", "str_replace", "patch"])) {
    return { stage: "\u5199\u6587\u4EF6", title: clipText(`\u4FEE\u6539 ${baseNameOf(file) || "\u6587\u4EF6"}`, TIHU_TITLE_CHARS), detail: clipText(file, TIHU_EVENT_CHARS) };
  }
  if (matched(["web_fetch", "webfetch", "web_search", "websearch", "fetch", "browse"])) {
    const target = firstString(params, ["url", "query", "q", "search", "target"]);
    return { stage: "\u641C\u7D22", title: clipText(`\u8054\u7F51\u67E5 ${target || "\u8D44\u6599"}`, TIHU_TITLE_CHARS), detail: clipText(target, TIHU_EVENT_CHARS) };
  }
  if (matched(["grep", "glob", "search", "find", "select-string"])) {
    const keyword = firstString(params, ["pattern", "query", "q", "glob", "keyword"]);
    return { stage: "\u641C\u7D22", title: clipText(`\u641C\u7D22 ${keyword || "\u5185\u5BB9"}`, TIHU_TITLE_CHARS), detail: clipText(keyword, TIHU_EVENT_CHARS) };
  }
  if (matched(["bash", "pwsh", "powershell", "shell", "terminal", "exec", "run_command", "cmd"])) {
    const command = firstString(params, ["command", "cmd", "script", "input"]);
    return { stage: "\u8DD1\u547D\u4EE4", title: clipText(`\u6267\u884C ${command.slice(0, 30)}`, TIHU_TITLE_CHARS), detail: clipText(command, TIHU_EVENT_CHARS) };
  }
  const detail = firstString(params, ["query", "command", "path", "pattern", "url", "text", "message", "task", "prompt", "id"]);
  return {
    stage: "\u601D\u8003",
    title: clipText(tool || "\u5DE5\u5177\u8C03\u7528", TIHU_TITLE_CHARS),
    detail: clipText(detail, TIHU_EVENT_CHARS)
  };
}
function summarizeToolResult(text, isError) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => sanitizeScreenLine(line)).filter(Boolean);
  const first = lines[0] ?? "";
  const last = lines.length > 0 ? lines[lines.length - 1] : "";
  const head = clipText(first, TIHU_LINE_CHARS - 2);
  const tail = clipText(last, TIHU_LINE_CHARS);
  if (isError) {
    return {
      line: clipText(`\u2717 ${head || "\u6267\u884C\u5931\u8D25"}`, TIHU_LINE_CHARS),
      output: tail !== "" && tail !== head ? tail : ""
    };
  }
  return {
    line: clipText(`\u2713 ${head || "\u5B8C\u6210"}`, TIHU_LINE_CHARS),
    output: tail !== "" && tail !== head ? tail : ""
  };
}
function createProgressState(now = Date.now()) {
  return { turn: 0, step: 0, turnStartedAt: now, lastResult: void 0, lastOutput: "", stage: "\u601D\u8003", title: "\u7B49\u5F85\u6307\u4EE4", tone: "idle" };
}
function bulletsOf(state, now) {
  const lines = [`\u7B2C ${state.step} \u6B65 \xB7 \u5DF2\u7528 ${formatElapsed(now - state.turnStartedAt)}`];
  if (state.lastResult) lines.push(state.lastResult.line);
  if (state.lastOutput) lines.push(state.lastOutput);
  return lines.slice(0, SCREEN_SPEC.maxBodyLines).map((line) => clipText(line, TIHU_LINE_CHARS));
}
function messageText(message) {
  const content = asRecord(message).content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => asRecord(block).type === "text").map((block) => String(asRecord(block).text ?? "")).join("\n").trim();
}
function applySessionEvent(state, event, now = Date.now()) {
  const record = asRecord(event);
  const type = String(record.type ?? "");
  const data = asRecord(record.data);
  if (type === "turn/start") {
    const turn = Number.isFinite(data.turn) ? Number(data.turn) : state.turn + 1;
    state.turn = turn;
    state.step = 0;
    state.turnStartedAt = now;
    state.lastResult = void 0;
    state.lastOutput = "";
    state.stage = "\u601D\u8003";
    state.title = "\u5F00\u59CB\u65B0\u4E00\u8F6E";
    state.tone = "busy";
    return {
      screen: { stage: "\u601D\u8003", title: state.title, bullets: bulletsOf(state, now), tone: "busy" },
      progress: { stage: "turn", text: `\u5F00\u59CB\u7B2C ${turn} \u8F6E` }
    };
  }
  if (type === "step/start") {
    state.step = Number.isFinite(data.step) ? Number(data.step) : state.step + 1;
    state.stage = "\u601D\u8003";
    state.title = "\u601D\u8003\u4E0B\u4E00\u6B65";
    state.tone = "busy";
    return {
      screen: { stage: "\u601D\u8003", title: state.title, bullets: bulletsOf(state, now), tone: "busy" },
      progress: { stage: "step", text: `\u7B2C ${state.step} \u6B65` }
    };
  }
  if (type === "tool/call") {
    const name2 = String(data.name ?? asRecord(data.call).name ?? "\u5DE5\u5177");
    const args = asArguments(data.arguments ?? asRecord(data.call).arguments);
    const action = describeTool(name2, args);
    if (Number.isFinite(data.step)) state.step = Number(data.step);
    state.stage = action.stage;
    state.title = action.title;
    state.tone = "busy";
    return {
      screen: { stage: action.stage, title: action.title, bullets: bulletsOf(state, now), tone: "busy" },
      progress: {
        stage: "tool",
        text: clipText(`${action.title}\uFF5C\u53C2\u6570 ${action.detail || "\uFF08\u65E0\uFF09"}`, TIHU_EVENT_CHARS)
      }
    };
  }
  if (type === "tool/result") {
    const message = asRecord(data.message);
    const text = messageText(message);
    const isError = message.isError === true || data.error !== void 0;
    const summary = summarizeToolResult(text, isError);
    state.lastResult = { ok: !isError, line: summary.line };
    state.lastOutput = summary.output;
    state.tone = isError ? "alert" : "ok";
    return {
      screen: { stage: state.stage, title: state.title, bullets: bulletsOf(state, now), tone: state.tone },
      progress: {
        stage: "result",
        text: clipText(`${summary.line}\uFF5C${text || (isError ? "\u5DE5\u5177\u62A5\u9519" : "\uFF08\u65E0\u8F93\u51FA\uFF09")}`, TIHU_EVENT_CHARS)
      }
    };
  }
  if (type === "assistant/message") {
    const text = messageText(data.message);
    if (text === "") return {};
    const lines = text.split(/\r?\n/).map((line) => sanitizeScreenLine(line)).filter(Boolean);
    const firstLine = lines[0] ?? "";
    state.stage = "\u56DE\u7B54";
    state.title = clipText(`\u56DE\u7B54 ${firstLine}`, TIHU_TITLE_CHARS);
    state.lastResult = { ok: true, line: "\u2713 \u5DF2\u751F\u6210\u56DE\u590D" };
    state.tone = "ok";
    return {
      screen: { stage: "\u56DE\u7B54", title: state.title, bullets: bulletsOf(state, now), tone: "ok" },
      progress: { stage: "answer", text: clipText(text, TIHU_EVENT_CHARS) }
    };
  }
  if (type === "turn/end") {
    const reason = String(asRecord(data.reason).kind ?? "stop");
    const okReason = reason === "completed" || reason === "stop";
    const doneTitle = clipText(`\u5B8C\u6210 \xB7 \u5171 ${state.step} \u6B65 \xB7 \u7528\u65F6 ${formatElapsed(now - state.turnStartedAt)}`, TIHU_TITLE_CHARS);
    state.stage = "\u56DE\u7B54";
    state.title = doneTitle;
    state.tone = okReason ? "ok" : "alert";
    const resultLine = okReason ? state.lastResult?.ok === false ? state.lastResult.line : state.lastResult?.line ?? "\u2713 \u672C\u8F6E\u5B8C\u6210" : state.lastResult?.ok === false ? state.lastResult.line : `\u2717 \u672C\u8F6E\u4E2D\u65AD\uFF08${reason}\uFF09`;
    return {
      // 最终帧保留在屏上（不要立刻清成「本轮完成」）
      screen: {
        stage: "\u56DE\u7B54",
        title: doneTitle,
        bullets: [clipText(resultLine, TIHU_LINE_CHARS)],
        tone: state.tone
      },
      progress: { stage: "end", text: okReason ? "\u672C\u8F6E\u5B8C\u6210" : `\u672C\u8F6E\u7ED3\u675F\uFF08${reason}\uFF09` }
    };
  }
  return {};
}
function confirmationFrame(title, detail) {
  return {
    stage: "\u7B49\u5F85\u786E\u8BA4",
    title: clipText(`\u7B49\u5F85\u786E\u8BA4 ${title || "\u5371\u9669\u64CD\u4F5C"}`, TIHU_TITLE_CHARS),
    bullets: [clipText(detail || "\u8BF7\u786E\u8BA4\u662F\u5426\u6267\u884C", TIHU_LINE_CHARS), "\u5728\u4E0B\u65B9\u70B9\u786E\u8BA4\u6216\u53D6\u6D88"],
    tone: "alert"
  };
}

// src/tihu/tts.ts
import { spawn as spawn4, spawnSync } from "node:child_process";
import { appendFileSync as appendFileSync3, closeSync, existsSync as existsSync4, mkdirSync as mkdirSync3, openSync, readSync } from "node:fs";
import { mkdir as mkdir3, readFile as readFile2, readdir, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname5, join as join6 } from "node:path";

// src/tihu/audio.ts
var TTS_SAMPLE_RATE = 24e3;
var TTS_CHUNK_MS = 120;
var TTS_CHUNK_SAMPLES = Math.round(TTS_SAMPLE_RATE * TTS_CHUNK_MS / 1e3);
var TTS_CHUNK_BYTES = TTS_CHUNK_SAMPLES * 2;
var Pcm16Chunker = class {
  buffer = Buffer.alloc(0);
  pending = null;
  /** 喂入任意字节；返回可以立即下发的块（不含最后一块）。 */
  push(chunk) {
    if (chunk !== void 0 && chunk !== null && chunk.length > 0) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    }
    const out = [];
    while (this.buffer.length >= TTS_CHUNK_BYTES) {
      const block = this.buffer.subarray(0, TTS_CHUNK_BYTES);
      this.buffer = this.buffer.subarray(TTS_CHUNK_BYTES);
      if (this.pending !== null) out.push(this.pending);
      this.pending = Buffer.from(block);
    }
    return out;
  }
  /** 结束：补齐偶数长度并发出最后一块（final=true）。 */
  finish() {
    const out = [];
    let rest = this.buffer;
    if (rest.length % 2 !== 0) rest = rest.subarray(0, rest.length - 1);
    this.buffer = Buffer.alloc(0);
    if (this.pending !== null) {
      const last = this.pending;
      this.pending = null;
      if (rest.length === 0) {
        out.push({ data: last, final: true });
        return out;
      }
      out.push({ data: last, final: false });
    }
    if (rest.length > 0) out.push({ data: Buffer.from(rest), final: true });
    else if (out.length > 0) out[out.length - 1].final = true;
    return out;
  }
  /** 尚未发出的字节数（测试/诊断）。 */
  pendingBytes() {
    return this.buffer.length + (this.pending === null ? 0 : this.pending.length);
  }
};
function parseWav(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      const format = buf.readUInt16LE(body);
      if (format !== 1) return null;
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      };
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = Math.min(size, Math.max(0, buf.length - body));
      break;
    }
    offset = body + size + size % 2;
  }
  if (fmt === null || dataOffset < 0) return null;
  const bytesPerSample = fmt.bits / 8 * fmt.channels;
  if (bytesPerSample <= 0) return null;
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bits: fmt.bits,
    dataOffset,
    dataBytes,
    durationMs: Math.round(dataBytes / bytesPerSample / fmt.sampleRate * 1e3)
  };
}
function validateReferenceWav(buffer) {
  const info = parseWav(buffer);
  if (info === null) return { ok: false, reason: "\u4E0D\u662F\u5408\u6CD5\u7684 PCM WAV \u6587\u4EF6" };
  if (info.channels !== 1) return { ok: false, reason: "\u9700\u8981\u5355\u58F0\u9053\uFF08\u5F53\u524D " + info.channels + " \u58F0\u9053\uFF09" };
  if (info.bits !== 16) return { ok: false, reason: "\u9700\u8981 16bit\uFF08\u5F53\u524D " + info.bits + "bit\uFF09" };
  if (info.sampleRate !== 16e3 && info.sampleRate !== 24e3) {
    return { ok: false, reason: "\u9700\u8981 16k \u6216 24k \u91C7\u6837\u7387\uFF08\u5F53\u524D " + info.sampleRate + "Hz\uFF09" };
  }
  if (info.durationMs < 3e3 || info.durationMs > 1e4) {
    return { ok: false, reason: "\u53C2\u8003\u97F3\u9891\u9700 3\u201310 \u79D2\uFF08\u5F53\u524D " + (info.durationMs / 1e3).toFixed(1) + " \u79D2\uFF09" };
  }
  return { ok: true, info };
}

// src/tihu/tts.ts
var DEFAULT_PORT = 8731;
var HEALTH_TIMEOUT_MS = 18e4;
function tihuRoot() {
  return join6(process.env.DSH_HOME ?? join6(homedir3(), ".dsh"), "tihu");
}
function defaultTtsPaths() {
  const root = tihuRoot();
  return {
    root,
    bin: process.env.TIHU_TTS_SERVER ?? join6(root, "bin", "tts-server.exe"),
    model: process.env.TIHU_TTS_MODEL ?? join6(root, "models", "qwen3-tts-0.6b-q4_k_m.gguf"),
    codec: process.env.TIHU_TTS_CODEC ?? join6(root, "models", "codec-q4_k_m.gguf"),
    serverVoices: process.env.TIHU_TTS_VOICES ?? join6(root, "voices-server")
  };
}
function voiceDirOf(workspace) {
  return join6(workspace, ".tihu", "voices");
}
function normalizeVoiceName(name2) {
  const value = String(name2 ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) return null;
  if (value === "default") return null;
  return value;
}
function binaryKind(path3) {
  try {
    const fd = openSync(path3, "r");
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    if (head.toString("ascii", 0, 2) === "MZ") return "windows";
    if (head[0] === 127 && head[1] === 69 && head[2] === 76 && head[3] === 70) return "linux";
  } catch {
  }
  return process.platform === "win32" ? "windows" : "linux";
}
function toWslPath(path3) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path3);
  if (match === null) return path3.replace(/\\/g, "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}
function wslDistro() {
  return process.env.TIHU_TTS_WSL_DISTRO ?? "Ubuntu";
}
function ensureWslRunning() {
  const result = spawnSync("wsl.exe", ["-d", wslDistro(), "--", "true"], { timeout: 3e4, windowsHide: true });
  if (result.status !== 0) {
    const detail = `${result.stderr?.toString("utf8") ?? ""}${result.stdout?.toString("utf8") ?? ""}`.trim();
    throw new Error(`WSL(${wslDistro()}) \u542F\u52A8\u5931\u8D25\uFF1A${detail || result.error?.message || "\u672A\u77E5\u9519\u8BEF"}`);
  }
}
var TihuTts = class {
  options;
  paths;
  child = null;
  starting = null;
  stderrTail = "";
  port;
  modelLoaded = false;
  lastError = "";
  /** PyTorch sidecar 实际设备（cuda/cpu），启动后由 /health 回填。 */
  activeDevice = (process.env.TIHU_TTS_DEVICE ?? "cpu") === "cuda" ? "cuda" : "cpu";
  /** 显存不足回落 CPU 的提示（页面事件区用）。 */
  fallbackNote = "";
  /** GPU 启动/合成失败后本次进程内不再重试（不回退机械音）。 */
  gpuFailed = false;
  /** 实际出声引擎（用于事件标识）。 */
  activeEngine = "edge";
  lastLabel = "";
  constructor(options) {
    this.options = options;
    this.paths = { ...defaultTtsPaths(), ...options.paths ?? {} };
    this.port = options.port ?? DEFAULT_PORT;
  }
  /** 当前后端：qwen-cuda（默认 GPU）/ q4（弃用备用）/ cpu（调试）/ none。 */
  backend() {
    if (this.options.disabled) return "none";
    const engine = process.env.TIHU_TTS_ENGINE ?? "";
    if (engine === "q4" && existsSync4(this.paths.bin) && existsSync4(this.paths.model) && existsSync4(this.paths.codec)) return "q4";
    if (engine === "cpu" && this.qwenReady()) return "cpu";
    if (this.qwenReady() && !this.gpuFailed) return "qwen-cuda";
    return "none";
  }
  qwenPython() {
    return process.env.TIHU_QWEN_PYTHON ?? join6(this.paths.root, "venv", "Scripts", "python.exe");
  }
  qwenServerScript() {
    return process.env.TIHU_QWEN_SERVER ?? join6(this.paths.root, "qwen-tts-server.py");
  }
  qwenModelDir() {
    return process.env.TIHU_QWEN_MODEL ?? join6(this.paths.root, "models", "qwen3-tts-0.6b-pt");
  }
  qwenReady() {
    return process.platform === "win32" && existsSync4(this.qwenPython()) && existsSync4(this.qwenServerScript()) && existsSync4(join6(this.qwenModelDir(), "model.safetensors"));
  }
  /** 引擎是否可用（edge 或本地 Qwen 任一可用）。 */
  available() {
    return this.edgeReady() || this.backend() !== "none";
  }
  status() {
    const backend = this.backend();
    if (this.activeEngine === "gpu" && backend !== "none") {
      if (backend === "q4") return { available: true, model: "qwen3-tts 0.6b-q4" };
      if (backend === "cpu") return { available: true, model: "qwen3-tts 0.6b-pt" };
      return { available: true, model: "qwen3-tts 0.6b-cuda" };
    }
    if (this.edgeReady()) return { available: true, model: "edge-tts \u4E91\u5065(Yunjian)" };
    if (backend !== "none") return { available: true, model: "qwen3-tts 0.6b-cuda" };
    return {
      available: false,
      error: this.lastError || `\u65E0\u8BED\u97F3\uFF1Aedge \u4E0D\u53EF\u7528\u4E14\u672C\u5730 Qwen \u672A\u5C31\u7EEA\uFF08${this.paths.root}\uFF09`
    };
  }
  /** 显存不足回落 CPU 的原因（无回落返回空串）。 */
  deviceFallback() {
    return this.fallbackNote;
  }
  /** 确保 sidecar 已启动并加载完模型。 */
  async ensureServer() {
    const backend = this.backend();
    if (backend === "none") return;
    if (this.child !== null && this.modelLoaded) return;
    if (this.starting !== null) return this.starting;
    this.starting = this.startServer().catch((error) => {
      if (backend === "qwen-cuda") {
        const message = error?.message ?? String(error);
        this.gpuFailed = true;
        this.fallbackNote = `GPU \u4E0D\u53EF\u7528\uFF1A${message}`;
        this.log(`tts gpu unavailable: ${message}`);
        return;
      }
      throw error;
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async startServer() {
    await mkdir3(this.paths.serverVoices, { recursive: true });
    const port = await this.pickPort();
    this.port = port;
    const backend = this.backend();
    let command = this.paths.bin;
    let args = [
      "--model",
      this.paths.codec,
      "--backbone",
      this.paths.model,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--voice-dir",
      this.paths.serverVoices,
      "--allow-voice-create",
      "--n-threads",
      String(this.options.threads ?? 4),
      "--segment-bytes",
      "160",
      "--stream-chunk-ms",
      String(TTS_CHUNK_MS),
      "--max-frames",
      "400",
      "--temp",
      "0.9",
      "--top-k",
      "50",
      "--top-p",
      "1.0",
      "--repeat-penalty",
      "1.05",
      "--repeat-last-n",
      "4096",
      "--samplers",
      "penalties;temperature;top_k;top_p"
    ];
    if (existsSync4(join6(this.paths.serverVoices, "default.gguf"))) {
      args.push("--speaker-file", join6(this.paths.serverVoices, "default.gguf"));
    }
    if (backend === "qwen-cuda" || backend === "cpu") {
      command = this.qwenPython();
      args = [
        "-u",
        this.qwenServerScript(),
        "--model",
        this.qwenModelDir(),
        "--voices",
        this.paths.serverVoices,
        "--default-ref",
        join6(this.paths.root, "default-ref.wav"),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--threads",
        String(this.options.threads ?? 8),
        "--device",
        backend === "cpu" ? "cpu" : "cuda",
        "--dtype",
        process.env.TIHU_TTS_DTYPE ?? "bf16"
      ];
    } else if (process.platform === "win32" && binaryKind(this.paths.bin) === "linux") {
      ensureWslRunning();
      command = "wsl.exe";
      const libDir = toWslPath(dirname5(this.paths.bin));
      args = ["-d", wslDistro(), "--", "env", `LD_LIBRARY_PATH=${libDir}`, toWslPath(this.paths.bin), ...args.map((arg) => /^[A-Za-z]:[\\/]/.test(arg) ? toWslPath(arg) : arg)];
    }
    this.log(`starting tts sidecar (${backend}): ${command} (port ${port})`);
    const logPath = join6(this.paths.root, "tts-server.log");
    try {
      mkdirSync3(this.paths.root, { recursive: true });
    } catch {
    }
    const appendLog = (line) => {
      try {
        appendFileSync3(logPath, line);
      } catch {
      }
    };
    const child = spawn4(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.stderrTail = "";
    appendLog(`
[${(/* @__PURE__ */ new Date()).toISOString()}] start ${backend} ${command} ${args.join(" ")}
`);
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4e3);
      appendLog(text);
    });
    child.stdout?.on("data", (chunk) => {
      appendLog(chunk.toString("utf8"));
    });
    child.on("exit", (code, signal) => {
      const wasLoaded = this.modelLoaded;
      this.child = null;
      this.modelLoaded = false;
      this.lastError = `\u672C\u5730 TTS \u8FDB\u7A0B\u9000\u51FA\uFF08code=${code ?? "?"} signal=${signal ?? "-"}\uFF09${this.stderrTail ? "\uFF1A" + this.stderrTail.split("\n").filter(Boolean).slice(-2).join(" ") : ""}`;
      if (wasLoaded) this.log(`tts sidecar exited: ${this.lastError}`);
    });
    const started = Date.now();
    for (; ; ) {
      if (Date.now() - started > HEALTH_TIMEOUT_MS) {
        throw new Error(`\u672C\u5730 TTS \u542F\u52A8\u8D85\u65F6\uFF08${Math.round(HEALTH_TIMEOUT_MS / 1e3)}s\uFF09\uFF1A${this.stderrTail.split("\n").filter(Boolean).slice(-3).join(" ") || "\u65E0\u8F93\u51FA"}`);
      }
      if (this.child === null) throw new Error(this.lastError || "\u672C\u5730 TTS \u8FDB\u7A0B\u542F\u52A8\u5931\u8D25");
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          const info = await response.json().catch(() => null);
          if (info?.device === "cuda" || info?.device === "cpu") {
            const requestedCuda = (process.env.TIHU_TTS_DEVICE ?? "cuda") !== "cpu";
            this.activeDevice = info.device;
            if (requestedCuda && info.device === "cpu") {
              this.fallbackNote = `\u663E\u5B58\u4E0D\u8DB3\uFF08\u53EF\u7528 ${Math.round(info.free_mb ?? 0)}MB\uFF09\uFF0C\u5DF2\u56DE\u843D CPU \u5F15\u64CE`;
            }
          }
          break;
        }
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    this.modelLoaded = true;
    this.log(`tts sidecar ready in ${Date.now() - started} ms (port ${this.port})`);
  }
  async pickPort() {
    for (let offset = 0; offset < 8; offset += 1) {
      const port = (this.options.port ?? DEFAULT_PORT) + offset;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
        if (response.ok) {
          this.modelLoaded = true;
          return port;
        }
      } catch {
      }
      return port;
    }
    return this.options.port ?? DEFAULT_PORT;
  }
  /** edge-tts 兜底是否可用（脚本 + Python；ffmpeg 由系统 PATH 提供）。 */
  edgeReady() {
    return existsSync4(this.qwenPython()) && existsSync4(join6(this.paths.root, "tihu-edge-tts.py"));
  }
  /** 当前引擎的中文标识（页面事件区）。 */
  engineLabel(voice) {
    if (this.activeEngine === "edge") return "\u5728\u7EBF\u515C\u5E95\uFF1Aedge-tts \u4E91\u5065(Yunjian)";
    if (this.activeEngine === "none") return "\u65E0\u8BED\u97F3\uFF08\u4EC5\u6587\u5B57\uFF09";
    return `\u672C\u5730 TTS\uFF1Aqwen3-tts 0.6b-cuda / \u97F3\u8272 ${voice || "default"}`;
  }
  /** 引擎切换后取一次提示（空串表示没变化）。 */
  takeEngineNote() {
    const label = this.lastLabel;
    this.lastLabel = "";
    return label;
  }
  /**
   * edge-tts 在线兜底：Python 流式输出 MP3 → ffmpeg 解码 24k PCM。
   * 首块 1.5s 不到立即杀掉，由调用方决定落 Qwen 还是无语音。
   */
  async synthesizeEdge(text, options) {
    const started = Date.now();
    const voice = options.edgeVoice || process.env.TIHU_EDGE_VOICE || "zh-CN-YunjianNeural";
    const py = spawn4(this.qwenPython(), ["-u", join6(this.paths.root, "tihu-edge-tts.py"), "--text", text, "--voice", voice], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const ff = spawn4(process.env.TIHU_FFMPEG ?? "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "24000",
      "pipe:1"
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    py.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    ff.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    py.stdout?.pipe(ff.stdin);
    const chunker = new Pcm16Chunker();
    let chunks = 0;
    let bytes = 0;
    let firstAt = 0;
    const abort = (reason) => {
      try {
        py.kill();
      } catch {
      }
      try {
        ff.kill();
      } catch {
      }
      throw new Error(reason);
    };
    const signal = options?.signal;
    const onAbort = () => abort("edge-tts aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const firstTimer = setTimeout(() => {
      try {
        py.kill();
      } catch {
      }
      try {
        ff.kill();
      } catch {
      }
    }, 3500);
    try {
      await new Promise((resolve, reject) => {
        const done = () => resolve();
        ff.stdout?.on("data", (chunk) => {
          if (firstAt === 0) {
            firstAt = Date.now();
            clearTimeout(firstTimer);
          }
          bytes += chunk.length;
          for (const block of chunker.push(chunk)) {
            options.onChunk({ data: block, seq: chunks, total: 0, final: false });
            chunks += 1;
          }
        });
        ff.on("error", (error) => reject(error));
        ff.on("close", done);
        py.on("close", (code) => {
          if (code !== 0 && firstAt === 0) reject(new Error(`edge-tts \u5931\u8D25\uFF08exit ${code}\uFF09\uFF1A${stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200)}`));
        });
      });
      const tail = chunker.finish();
      if (firstAt === 0 && tail.length === 0) throw new Error(`edge-tts \u6CA1\u6709\u8FD4\u56DE\u97F3\u9891\uFF1A${stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200)}`);
      for (const block of tail) {
        options.onChunk({ data: block.data, seq: chunks, total: chunks + 1, final: block.final });
        chunks += 1;
      }
      const totalMs = Date.now() - started;
      const audioMs = Math.round(bytes / 2 / TTS_SAMPLE_RATE * 1e3);
      if (audioMs < 50) throw new Error("edge-tts \u8FD4\u56DE\u97F3\u9891\u8FC7\u77ED");
      this.log(`edge-tts ok chars=${[...text].length} voice=${voice} first=${firstAt === 0 ? "?" : firstAt - started}ms total=${totalMs}ms audio=${audioMs}ms`);
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstAt === 0 ? totalMs : firstAt - started, audioMs, totalMs, chunks };
    } catch (error) {
      clearTimeout(firstTimer);
      try {
        py.kill();
      } catch {
      }
      try {
        ff.kill();
      } catch {
      }
      throw error;
    } finally {
      clearTimeout(firstTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  /**
   * 合成一段文本并流式输出 PCM 块。
   * @returns 首块耗时 / 总时长 / 块数（用于报告与日志）。
   */
  async synthesize(text, options) {
    const wantsClone = typeof options.voice === "string" && options.voice !== "" && options.voice !== "default";
    const offline = options.offlineOnly === true || process.env.TIHU_OFFLINE_ONLY === "1";
    let primaryError = "";
    let edgeError = "";
    let triedEdge = false;
    if (!wantsClone && !offline && this.edgeReady()) {
      triedEdge = true;
      try {
        const result = await this.synthesizeEdge(text, { ...options, edgeVoice: options.edgeVoice });
        this.setEngine("edge");
        return result;
      } catch (error) {
        primaryError = error?.message ?? String(error);
        edgeError = primaryError;
        this.log(`edge-tts failed: ${primaryError}`);
      }
    }
    const backend = this.backend();
    if (backend !== "none") {
      try {
        const controller = new AbortController();
        const timer = wantsClone ? null : setTimeout(() => controller.abort(), 4500);
        try {
          const result = await this.synthesizeCodec(text, { ...options, signal: options.signal ?? controller.signal });
          this.setEngine("gpu");
          return result;
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      } catch (error) {
        primaryError = error?.message ?? String(error);
        this.gpuFailed = true;
        this.fallbackNote = `\u672C\u5730 Qwen \u5931\u8D25\uFF1A${primaryError}`;
        this.log(`tts qwen failed: ${primaryError}`);
      }
    }
    this.activeEngine = "none";
    this.lastLabel = "\u65E0\u8BED\u97F3\uFF08\u4EC5\u6587\u5B57\uFF09";
    throw new Error(`\u672C\u6B21\u65E0\u8BED\u97F3\uFF1A\u5728\u7EBF\u515C\u5E95\u4E0D\u53EF\u7528\u4E14\u672C\u5730\u5F15\u64CE\u672A\u5C31\u7EEA\uFF08\u5728\u7EBF\uFF1A${edgeError || "\u672A\u542F\u7528"}\uFF1B\u672C\u5730\uFF1A${primaryError || "\u672A\u5C31\u7EEA"}\uFF09`);
  }
  setEngine(engine) {
    this.activeEngine = engine;
    this.lastLabel = this.engineLabel("");
  }
  async synthesizeCodec(text, options) {
    await this.ensureServer();
    const body = {
      model: "qwen3-tts",
      input: text,
      response_format: "pcm",
      text: void 0,
      ...options.voice !== void 0 && options.voice !== "" && options.voice !== "default" ? { voice: { id: await this.resolveServerVoice(options.voice, options.sessionId) } } : {}
    };
    const started = Date.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const firstChunkBudget = this.backend() === "q4" ? 6e4 : 45e3;
    const firstTimer = setTimeout(() => controller.abort(), firstChunkBudget);
    let firstChunkAt = 0;
    let bytes = 0;
    let chunks = 0;
    const chunker = new Pcm16Chunker();
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => "");
        throw new Error(`TTS \u5408\u6210\u5931\u8D25 HTTP ${response.status}\uFF1A${detail.slice(0, 300) || response.statusText}`);
      }
      const reader = response.body.getReader();
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === void 0) continue;
        if (firstChunkAt === 0) {
          firstChunkAt = Date.now();
          clearTimeout(firstTimer);
        }
        bytes += value.length;
        const blocks = chunker.push(value);
        for (const block of blocks) {
          options.onChunk({ data: block, seq: chunks, total: 0, final: false });
          chunks += 1;
        }
      }
      const tail = chunker.finish();
      for (const block of tail) {
        options.onChunk({ data: block.data, seq: chunks, total: chunks + 1, final: block.final });
        chunks += 1;
      }
      const totalMs = Date.now() - started;
      const audioMs = Math.round(bytes / 2 / TTS_SAMPLE_RATE * 1e3);
      if (audioMs < 50) throw new Error("TTS \u6CA1\u6709\u8FD4\u56DE\u6709\u6548\u97F3\u9891\uFF08\u5C11\u4E8E 50ms\uFF09");
      this.log(`tts ok chars=${[...text].length} voice=${options.voice ?? "default"} first=${firstChunkAt === 0 ? "?" : firstChunkAt - started}ms total=${totalMs}ms audio=${audioMs}ms chunks=${chunks}`);
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstChunkAt === 0 ? totalMs : firstChunkAt - started, audioMs, totalMs, chunks };
    } catch (error) {
      const message = error?.name === "AbortError" ? `TTS \u5408\u6210\u8D85\u65F6\uFF08\u9996\u5757 ${Math.round(firstChunkBudget / 1e3)}s \u672A\u8FD4\u56DE\uFF09` : String(error?.message ?? error);
      this.lastError = message;
      throw new Error(message);
    } finally {
      clearTimeout(firstTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  /** 把文本切成 TTS 段（与 tts.text 同一套切分）。 */
  segments(text) {
    return toTtsSegments(text);
  }
  /* ---------- 音色 ---------- */
  workspaceDir(sessionId) {
    const workspace = (sessionId !== void 0 ? this.options.workspaceOf?.(sessionId) : void 0) ?? process.cwd();
    return voiceDirOf(workspace);
  }
  /** 列出工作区音色（默认 + `.tihu/voices/*.json`）。 */
  async listVoices(sessionId) {
    const voices = [{ name: "default", kind: "default" }];
    const dir = this.workspaceDir(sessionId);
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const record = JSON.parse(await readFile2(join6(dir, file), "utf8"));
          const name2 = normalizeVoiceName(record.name);
          if (name2 === null) continue;
          voices.push({
            name: name2,
            kind: "cloned",
            durationMs: record.durationMs,
            sampleRate: record.sampleRate,
            createdAt: record.createdAt,
            note: record.note
          });
        } catch {
        }
      }
    } catch {
    }
    voices.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "default" ? -1 : 1);
    return voices;
  }
  /** 读取工作区音色的 serverVoiceId（没有则视作未创建）。 */
  async readVoiceRecord(sessionId, name2) {
    const normalized = normalizeVoiceName(name2);
    if (normalized === null) return null;
    const file = join6(this.workspaceDir(sessionId), normalized + ".json");
    try {
      return JSON.parse(await readFile2(file, "utf8"));
    } catch {
      return null;
    }
  }
  /**
   * 新建/复用克隆音色。
   * 同一 name 已有 serverVoiceId 且 embedding 文件还在 → 直接命中缓存，不再算 speaker。
   */
  async createVoice(payload, sessionId) {
    const name2 = normalizeVoiceName(payload.name);
    if (name2 === null) throw new Error("\u97F3\u8272\u540D\u53EA\u80FD\u5305\u542B\u82F1\u6587/\u6570\u5B57/\u4E0B\u5212\u7EBF/\u77ED\u6A2A\u7EBF\uFF0C1\u201332 \u5B57\uFF0C\u4E14\u4E0D\u80FD\u662F default");
    if (this.backend() === "none") throw new Error("\u672C\u5730 Qwen \u5F15\u64CE\u672A\u5C31\u7EEA\uFF0C\u65E0\u6CD5\u521B\u5EFA\u514B\u9686\u97F3\u8272");
    const dir = this.workspaceDir(sessionId);
    await mkdir3(dir, { recursive: true });
    const wav = Buffer.from(payload.wavBase64, "base64");
    const valid = validateReferenceWav(wav);
    if (!valid.ok) throw new Error("\u53C2\u8003\u97F3\u9891\u4E0D\u5408\u683C\uFF1A" + valid.reason);
    const existing = await this.readVoiceRecord(sessionId, name2);
    const embedExt = this.backend() === "q4" ? ".gguf" : ".embed.pt";
    if (existing?.serverVoiceId !== void 0 && existsSync4(join6(this.paths.serverVoices, existing.serverVoiceId + embedExt))) {
      return {
        voice: { name: name2, kind: "cloned", durationMs: existing.durationMs, sampleRate: existing.sampleRate, createdAt: existing.createdAt, note: existing.note },
        cached: true
      };
    }
    await this.ensureServer();
    const form = new FormData();
    form.append("name", name2);
    form.append("audio_sample", new Blob([wav], { type: "audio/wav" }), name2 + ".wav");
    const response = await fetch(`http://127.0.0.1:${this.port}/v1/audio/voices`, { method: "POST", body: form });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`\u521B\u5EFA\u97F3\u8272\u5931\u8D25 HTTP ${response.status}\uFF1A${detail.slice(0, 300) || response.statusText}`);
    }
    const created = await response.json();
    const serverVoiceId = typeof created.id === "string" && created.id !== "" ? created.id : "";
    if (serverVoiceId === "") throw new Error("\u521B\u5EFA\u97F3\u8272\u5931\u8D25\uFF1Asidecar \u6CA1\u6709\u8FD4\u56DE voice id");
    await writeFile2(join6(dir, name2 + ".wav"), wav);
    const record = {
      name: name2,
      serverVoiceId,
      sampleRate: valid.info.sampleRate,
      durationMs: valid.info.durationMs,
      createdAt: Date.now(),
      ...payload.note !== void 0 && payload.note !== "" ? { note: payload.note.slice(0, 120) } : {}
    };
    await writeFile2(join6(dir, name2 + ".json"), JSON.stringify(record, null, 2), "utf8");
    this.log(`tts voice created name=${name2} serverVoiceId=${serverVoiceId} duration=${valid.info.durationMs}ms`);
    return {
      voice: { name: name2, kind: "cloned", durationMs: record.durationMs, sampleRate: record.sampleRate, createdAt: record.createdAt, note: record.note },
      cached: false
    };
  }
  async resolveServerVoice(name2, sessionId) {
    const record = await this.readVoiceRecord(sessionId, name2);
    if (record === null || record.serverVoiceId === void 0 || record.serverVoiceId === "") {
      throw new Error(`\u97F3\u8272 ${name2} \u6CA1\u6709\u53EF\u7528\u7684 embedding\uFF0C\u8BF7\u91CD\u65B0\u4E0A\u4F20\u53C2\u8003\u97F3\u9891`);
    }
    if (!existsSync4(join6(this.paths.serverVoices, record.serverVoiceId + (this.backend() === "q4" ? ".gguf" : ".embed.pt")))) {
      throw new Error(`\u97F3\u8272 ${name2} \u7684 embedding \u5DF2\u4E22\u5931\uFF0C\u8BF7\u91CD\u65B0\u4E0A\u4F20\u53C2\u8003\u97F3\u9891`);
    }
    return record.serverVoiceId;
  }
  /** 关掉 sidecar（插件卸载/热重载）。 */
  dispose() {
    const child = this.child;
    this.child = null;
    this.modelLoaded = false;
    if (child !== null) {
      try {
        child.kill();
      } catch {
      }
    }
  }
  log(line) {
    try {
      this.options.log(line);
    } catch {
    }
  }
};

// src/tihu/reply.ts
var SENTENCE_END = /[。！？；!?;]/;
function splitReplySentences(text, maxSentenceChars = 120) {
  const chars = [...String(text ?? "")];
  const out = [];
  let start = 0;
  let index = 0;
  let cursor = 0;
  while (cursor < chars.length) {
    const atBreak = SENTENCE_END.test(chars[cursor]) || chars[cursor] === "\n";
    const tooLong = cursor - start + 1 >= maxSentenceChars;
    if (!atBreak && !tooLong) {
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (end < chars.length && (SENTENCE_END.test(chars[end]) || chars[end] === "\n")) end += 1;
    const slice = chars.slice(start, end).join("").trim();
    if (slice !== "") {
      out.push({ index, start, end, text: slice });
      index += 1;
    }
    start = end;
    cursor = end;
  }
  if (start < chars.length) {
    const slice = chars.slice(start).join("").trim();
    if (slice !== "") out.push({ index, start, end: chars.length, text: slice });
  }
  return out;
}
function replyWindow(sentences, currentIndex, radius = 2) {
  if (sentences.length === 0) return [];
  const index = Math.max(0, Math.min(sentences.length - 1, Number.isFinite(currentIndex) ? currentIndex : 0));
  const start = Math.max(0, index - radius);
  const end = Math.min(sentences.length, index + radius + 1);
  return sentences.slice(start, end);
}
var SPEECH_BREAK = /[，,、：:；;。！？!?\n]/;
function splitSpeechSegments(text, maxChars = 32) {
  const chars = [...String(text ?? "")];
  const sentences = splitReplySentences(text);
  const out = [];
  let index = 0;
  let cursor = 0;
  let sentenceIndex = 0;
  while (cursor < chars.length && sentenceIndex < sentences.length) {
    while (cursor < chars.length && /\s/.test(chars[cursor])) cursor += 1;
    if (cursor >= chars.length) break;
    while (sentenceIndex < sentences.length && sentences[sentenceIndex].end <= cursor) sentenceIndex += 1;
    if (sentenceIndex >= sentences.length) break;
    let end = cursor;
    let lastBreak = -1;
    const limit = Math.min(chars.length, sentences[sentenceIndex].end);
    while (end < limit) {
      const char = chars[end];
      if (SPEECH_BREAK.test(char)) {
        lastBreak = end + 1;
        break;
      }
      if (end - cursor + 1 >= maxChars) {
        lastBreak = end + 1;
        break;
      }
      end += 1;
    }
    if (lastBreak < 0) lastBreak = limit;
    let segmentEnd = Math.min(lastBreak, limit);
    while (segmentEnd > cursor && /\s/.test(chars[segmentEnd - 1])) segmentEnd -= 1;
    const segmentText = chars.slice(cursor, segmentEnd).join("").trim();
    if (segmentText !== "") {
      while (sentenceIndex < sentences.length && sentences[sentenceIndex].end <= cursor) sentenceIndex += 1;
      out.push({ index, text: segmentText, start: cursor, end: segmentEnd, sentenceIndex });
      index += 1;
    }
    cursor = Math.max(lastBreak, cursor + 1);
  }
  return out;
}

// src/tihu/speech-text.ts
function toSpeechText(markdown) {
  let text = String(markdown ?? "");
  text = text.replace(/```[^\n]*\n?/g, " ");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/[^\s)）]+/gi, "\u94FE\u63A5");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)([^*_]+)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, "");
  text = text.replace(/^\s*\|.*\|\s*$/gm, (line) => line.replace(/\|/g, " "));
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, " ");
  text = text.replace(/\|/g, " ");
  text = text.replace(/[\p{Extended_Pictographic}\p{So}\uFE0F\u200D\u20E3]/gu, "");
  text = text.replace(/[\u200B-\u200F\u202A-\u202E]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

// src/tihu/lane.ts
var TIHU_LANE_PATH = "/tihu/lane";
var MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
var TRANSCRIBE_TIMEOUT_MS = 45e3;
var ACTIVE_WINDOW_MS = 12e4;
var CONFIRM_TIMEOUT_MS = 6e4;
function optionalService(ctx, id) {
  try {
    if (ctx && typeof ctx.get === "function") return ctx.get(id);
  } catch {
  }
  return void 0;
}
function sessionIdOf(session) {
  const direct = session?.id;
  if (typeof direct === "string" && direct !== "") return direct;
  const header = session?.header?.id;
  return typeof header === "string" && header !== "" ? header : void 0;
}
function sessionIdOfAgent(agent) {
  return sessionIdOf(agent?.session) ?? (typeof agent?.sessionId === "string" ? agent.sessionId : void 0);
}
function shortSessionId(sessionId) {
  return sessionId.replace(/^session-/, "").slice(0, 8) || sessionId.slice(0, 8);
}
var TIHU_COMPUTER_USE_PRESET = "computer-use";
function buildTihuUserMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: String(text ?? "") }],
    source: { kind: "user" }
  };
}
function websocketAccept(key) {
  return createHash3("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}
function pathnameOf(req) {
  try {
    return new URL(String(req?.url ?? "/"), "http://tihu.invalid").pathname;
  } catch {
    return "";
  }
}
function createTihuRuntime(ctx, options) {
  const log = options.log ?? (() => {
  });
  const devices = /* @__PURE__ */ new Set();
  const activeSessions = /* @__PURE__ */ new Map();
  const screenStates = /* @__PURE__ */ new Map();
  const homeStates = /* @__PURE__ */ new Map();
  const pendingByDisplay = /* @__PURE__ */ new Map();
  const lastReplies = /* @__PURE__ */ new Map();
  const progressStates = /* @__PURE__ */ new Map();
  const replySessions = /* @__PURE__ */ new Set();
  const tts = options.tts?.instance ?? new TihuTts({
    log,
    workspaceOf: options.workspaceOf,
    threads: options.tts?.threads ?? 8,
    ...options.tts?.disabled === true ? { disabled: true } : {},
    ...options.tts?.port === void 0 ? {} : { port: options.tts.port },
    ...options.tts?.paths === void 0 ? {} : { paths: options.tts.paths }
  });
  if (options.tts?.prewarm === true && options.tts?.disabled !== true && tts.backend() === "qwen-cuda") {
    void tts.ensureServer().catch((error) => log(`tihu tts prewarm failed: ${error?.message ?? String(error)}`));
  }
  const confirmBroker = createConfirmBroker({
    onAsk: (request) => {
      for (const device of devices) {
        if (request.sessionId !== void 0 && device.sessionId !== request.sessionId) continue;
        const payload = {
          confirmId: request.id,
          title: request.title,
          detail: request.detail,
          options: ["\u786E\u8BA4", "\u53D6\u6D88"],
          timeoutMs: request.timeoutMs,
          risk: request.risk
        };
        device.send("confirm.ask", payload);
        device.send("screen.frame", confirmationFrame(request.title, request.detail));
      }
      log(`tihu confirm.ask id=${request.id} title=${JSON.stringify(request.title)}`);
    }
  });
  function broadcast(sessionId, type, payload) {
    for (const device of devices) {
      if (device.sessionId !== sessionId) continue;
      device.send(type, payload);
    }
  }
  function screen(sessionId, frame) {
    broadcast(sessionId, "screen.frame", {
      stage: frame.stage,
      title: frame.title,
      bullets: frame.bullets ?? [],
      ...frame.progress === void 0 ? {} : { progress: frame.progress },
      ...frame.mode === void 0 ? {} : { mode: frame.mode },
      ...frame.reply === void 0 ? {} : { reply: frame.reply },
      ...frame.home === void 0 ? {} : { home: frame.home },
      ...frame.pending === void 0 ? {} : { pending: frame.pending },
      ...frame.pendingCount === void 0 ? {} : { pendingCount: frame.pendingCount },
      tone: frame.tone ?? "idle"
    });
  }
  let sessionListCache;
  const SESSION_LIST_TTL_MS = 6e4;
  const titleCache = /* @__PURE__ */ new Map();
  function projectionValuesOf(source) {
    try {
      const projections = optionalService(ctx, "sessionProjections");
      if (projections !== void 0 && typeof projections?.cachedSnapshot === "function") {
        const block = projections.cachedSnapshot(source);
        if (block !== void 0 && block !== null && typeof block.values === "object" && block.values !== null) return block.values;
      }
    } catch {
    }
    try {
      const cache = optionalService(ctx, "sessionProjectionCache");
      if (cache !== void 0 && typeof cache?.cachedSnapshot === "function") {
        const block = cache.cachedSnapshot(source?.header ?? source);
        if (block !== void 0 && block !== null && typeof block.values === "object" && block.values !== null) return block.values;
      }
    } catch {
    }
    return {};
  }
  function titleOf(source) {
    const value = projectionValuesOf(source).title;
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object" && typeof value.title === "string") return value.title;
    return "";
  }
  function presetOf(source) {
    const projected = projectionValuesOf(source).agentPreset;
    if (typeof projected === "string" && projected !== "") return projected;
    const header = source?.header ?? source;
    return typeof header?.agentPreset === "string" ? header.agentPreset : "";
  }
  function isComputerUsePreset(preset) {
    return preset === TIHU_COMPUTER_USE_PRESET;
  }
  function activityOf(source) {
    const header = source?.header ?? source;
    const createdAt = Number.isFinite(header?.createdAt) ? Number(header.createdAt) : 0;
    const metadata = projectionValuesOf(source).sessionListMetadata;
    const lastPromptAt = metadata !== null && typeof metadata === "object" && Number.isFinite(metadata.lastPromptAt) ? Number(metadata.lastPromptAt) : 0;
    return Math.max(createdAt, lastPromptAt);
  }
  function liveSessionRows() {
    const sessions = optionalService(ctx, "sessions");
    const list = typeof sessions?.list === "function" ? sessions.list() : [];
    if (!Array.isArray(list)) return [];
    const rows = [];
    for (const session of list) {
      const sessionId = sessionIdOf(session);
      if (sessionId === void 0) continue;
      rows.push({
        sessionId,
        title: titleOf(session),
        preset: presetOf(session),
        updatedAt: activityOf(session),
        ...typeof session?.header?.cwd === "string" ? { cwd: session.header.cwd } : {},
        ...Number.isFinite(session?.header?.createdAt) ? { createdAt: Number(session.header.createdAt) } : {},
        live: true
      });
    }
    return rows;
  }
  function sortSessionRows(rows) {
    return rows.sort((a, b) => {
      const byActivity = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      if (byActivity !== 0) return byActivity;
      if (a.live !== b.live) return a.live ? -1 : 1;
      return a.sessionId.localeCompare(b.sessionId);
    });
  }
  async function collectSessionRows(force = false) {
    const now = Date.now();
    if (!force && sessionListCache !== void 0 && now - sessionListCache.at < SESSION_LIST_TTL_MS) {
      return { rows: sessionListCache.rows, source: sessionListCache.source };
    }
    const live = liveSessionRows();
    const query = optionalService(ctx, "sessionQuery");
    if (query !== void 0 && typeof query?.listSessions === "function") {
      try {
        const records = await query.listSessions();
        const rows = [];
        const seen = /* @__PURE__ */ new Set();
        for (const record of Array.isArray(records) ? records : []) {
          const sessionId = String(record?.header?.id ?? "");
          if (sessionId === "" || seen.has(sessionId)) continue;
          seen.add(sessionId);
          rows.push({
            sessionId,
            title: titleOf(record?.header),
            preset: presetOf(record?.header),
            updatedAt: activityOf(record?.header),
            ...typeof record?.header?.cwd === "string" ? { cwd: record.header.cwd } : {},
            ...Number.isFinite(record?.header?.createdAt) ? { createdAt: Number(record.header.createdAt) } : {},
            live: record?.live === true
          });
        }
        for (const row of live) if (!seen.has(row.sessionId)) rows.push(row);
        sessionListCache = { at: now, rows: sortSessionRows(rows), source: "sessionQuery" };
        return { rows: sessionListCache.rows, source: "sessionQuery" };
      } catch (error) {
        log(`tihu sessions query failed: ${error?.message ?? String(error)}`);
      }
    }
    sessionListCache = { at: now, rows: sortSessionRows(live), source: "live" };
    return { rows: sessionListCache.rows, source: "live" };
  }
  async function attachTitles(rows) {
    if (rows.length === 0) return rows;
    const query = optionalService(ctx, "sessionQuery");
    if (query === void 0 || typeof query?.readTitleSnapshots !== "function") return rows;
    const now = Date.now();
    const missing = rows.filter((row) => {
      if (row.title !== "") return false;
      const cached = titleCache.get(row.sessionId);
      return cached === void 0 || now - cached.at > 6e4;
    });
    if (missing.length > 0) {
      try {
        const snapshots = await query.readTitleSnapshots(missing.map((row) => row.sessionId));
        for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
          const sessionId = String(snapshot?.session?.id ?? "");
          const raw = snapshot?.title;
          const title = typeof raw === "string" ? raw : typeof raw?.title === "string" ? raw.title : "";
          if (sessionId !== "" && title !== "") titleCache.set(sessionId, { at: now, title });
        }
      } catch (error) {
        log(`tihu session titles failed: ${error?.message ?? String(error)}`);
      }
    }
    return rows.map((row) => {
      const cached = titleCache.get(row.sessionId);
      return cached === void 0 ? row : { ...row, title: cached.title };
    });
  }
  async function listSessionChoices(limit, checkId) {
    let collected;
    try {
      collected = await collectSessionRows();
    } catch (error) {
      log(`tihu sessions list failed: ${error?.message ?? String(error)}`);
      collected = { rows: liveSessionRows(), source: "live" };
    }
    const all = collected.rows;
    const cuRows = all.filter((row) => isComputerUsePreset(row.preset)).sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
    const total = all.length;
    const cuTotal = cuRows.length;
    const checkRow = checkId === void 0 ? void 0 : all.find((row) => row.sessionId === checkId);
    const check = checkId === void 0 ? void 0 : {
      sessionId: checkId,
      found: checkRow !== void 0,
      ...checkRow === void 0 ? {} : { preset: checkRow.preset, computerUse: isComputerUsePreset(checkRow.preset) }
    };
    const top = cuRows.slice(0, limit);
    const titled = await Promise.race([
      attachTitles(top),
      new Promise((resolve) => {
        setTimeout(() => resolve(top), 3e3);
      })
    ]);
    return {
      sessions: titled.map((row) => ({
        sessionId: row.sessionId,
        title: row.title,
        preset: row.preset,
        computerUse: true,
        updatedAt: row.updatedAt,
        ...row.cwd === void 0 ? {} : { cwd: row.cwd },
        ...row.createdAt === void 0 ? {} : { createdAt: row.createdAt },
        live: row.live
      })),
      total,
      cuTotal,
      ...cuRows[0] === void 0 ? {} : { activeSessionId: cuRows[0].sessionId },
      ...check === void 0 ? {} : { check },
      source: collected.source
    };
  }
  async function activeComputerUseRow(force = false) {
    let collected;
    try {
      collected = await collectSessionRows(force);
    } catch {
      return void 0;
    }
    let best;
    for (const row of collected.rows) {
      if (!isComputerUsePreset(row.preset)) continue;
      if (best === void 0 || row.updatedAt > best.updatedAt) best = row;
    }
    return best;
  }
  async function findSession(sessionId) {
    const sessions = optionalService(ctx, "sessions");
    if (sessions !== void 0 && typeof sessions?.get === "function") {
      let live;
      try {
        live = sessions.get(sessionId);
      } catch {
        live = void 0;
      }
      if (live !== void 0 && live !== null) {
        return {
          status: "live",
          row: {
            sessionId: sessionIdOf(live) ?? sessionId,
            title: titleOf(live),
            preset: presetOf(live),
            updatedAt: activityOf(live),
            live: true,
            ...typeof live?.header?.cwd === "string" ? { cwd: live.header.cwd } : {},
            ...Number.isFinite(live?.header?.createdAt) ? { createdAt: Number(live.header.createdAt) } : {}
          }
        };
      }
    }
    const cachedRow = sessionListCache?.rows.find((item) => item.sessionId === sessionId);
    if (cachedRow !== void 0) return { status: cachedRow.live ? "live" : "persisted", row: cachedRow };
    let collected;
    try {
      collected = await collectSessionRows();
    } catch {
      return { status: "unknown" };
    }
    if (collected.source !== "sessionQuery") return { status: "unknown" };
    const row = collected.rows.find((item) => item.sessionId === sessionId);
    return row === void 0 ? { status: "missing" } : { status: row.live ? "live" : "persisted", row };
  }
  async function bindSession(device, sessionId, options2 = {}) {
    const found = await findSession(sessionId);
    if (found.status === "missing") {
      device.sessionId = void 0;
      device.send("session.invalid", {
        sessionId,
        reason: `\u4F1A\u8BDD ${shortSessionId(sessionId)} \u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u5F52\u6863\u6216\u5220\u9664\uFF09\uFF0C\u8BF7\u5728\u4E0B\u9762\u7684\u4F1A\u8BDD\u5217\u8868\u91CC\u91CD\u65B0\u9009\u4E00\u4E2A`,
        showPicker: true
      });
      device.send("event.alert", { level: "warn", text: `\u4F1A\u8BDD ${shortSessionId(sessionId)} \u4E0D\u5B58\u5728\uFF1A\u8BF7\u4ECE\u4E0B\u9762\u7684\u4F1A\u8BDD\u5217\u8868\u91CC\u9009\u4E00\u4E2A` });
      device.send("screen.frame", {
        stage: "\u9009\u62E9\u4F1A\u8BDD",
        title: "\u8FD8\u6CA1\u6709\u9009\u5B9A\u4F1A\u8BDD",
        bullets: [`\u4F1A\u8BDD ${shortSessionId(sessionId)} \u4E0D\u5B58\u5728`, "\u70B9\u4E0B\u9762\u7684\u4F1A\u8BDD\u5217\u8868\u9009\u4E00\u4E2A"],
        tone: "alert"
      });
      log(`tihu bind rejected session=${sessionId} reason=missing`);
      return;
    }
    device.sessionId = sessionId;
    const row = found.row;
    let title = row?.title ?? titleCache.get(sessionId)?.title ?? "";
    if (title === "" && found.status !== "unknown") {
      const base = { sessionId, title: "", preset: row?.preset ?? "", updatedAt: row?.updatedAt ?? 0, live: found.status === "live" };
      const [titled] = await Promise.race([
        attachTitles([base]),
        new Promise((resolve) => {
          setTimeout(() => resolve([base]), 1500);
        })
      ]);
      title = titled?.title ?? "";
    }
    const preset = row?.preset ?? "";
    const computerUse = isComputerUsePreset(preset);
    const live = found.status === "live" || row?.live === true;
    device.send("session.bound", {
      sessionId,
      title,
      live,
      preset,
      computerUse,
      ...options2.auto === true ? { auto: true } : {},
      ...options2.followed === true ? { followed: true } : {}
    });
    if (computerUse) {
      device.send("screen.frame", {
        stage: options2.followed === true ? "\u8DDF\u968F" : "\u4F1A\u8BDD",
        title: options2.followed === true ? title !== "" ? `\u5DF2\u81EA\u52A8\u8DDF\u968F\u5230\uFF1A${title}` : "\u5DF2\u81EA\u52A8\u8DDF\u968F\u5230\u65B0\u7684 CU \u4F1A\u8BDD" : title !== "" ? `\u5DF2\u7ED1\u5B9A\uFF1A${title}` : "\u5DF2\u7ED1\u5B9A\u4F1A\u8BDD",
        bullets: [
          shortSessionId(sessionId),
          live ? "\u684C\u9762\u6B63\u5F00\u7740\u8FD9\u4E2A\u4F1A\u8BDD" : "\u8FD8\u6CA1\u5728\u684C\u9762\u6253\u5F00\uFF08\u6CE8\u5165\u524D\u5148\u6253\u5F00\u5B83\uFF09"
        ],
        tone: "idle"
      });
    } else {
      device.send("event.alert", {
        level: "error",
        text: `\u8FD9\u6761\u4F1A\u8BDD\u4E0D\u662F Computer Use \u6A21\u5F0F\uFF08preset=${preset || "\u672A\u77E5"}\uFF09\uFF1A\u65E0\u6CD5\u770B\u5C4F/\u70B9\u6309\uFF0C\u8BF7\u6362\u4E00\u4E2A Computer Use \u4F1A\u8BDD`
      });
      device.send("screen.frame", {
        stage: "\u975E Computer Use",
        title: "\u8FD9\u6761\u4E0D\u662F Computer Use \u6A21\u5F0F",
        bullets: ["\u65E0\u6CD5\u770B\u5C4F/\u70B9\u6309", "\u8BF7\u6362\u4E00\u4E2A Computer Use \u4F1A\u8BDD"],
        tone: "alert"
      });
    }
    log(`tihu bind session=${sessionId} status=${found.status} preset=${JSON.stringify(preset)} cu=${String(computerUse)} title=${JSON.stringify(title)}`);
  }
  async function autoBindActive(device, reason) {
    const stale = sessionListCache === void 0 || Date.now() - sessionListCache.at > 15e3;
    const active = await activeComputerUseRow(reason === "hello" || stale);
    if (active === void 0) {
      device.sessionId = void 0;
      if (reason === "hello") {
        device.send("event.alert", { level: "warn", text: "\u6CA1\u6709\u53EF\u81EA\u52A8\u7ED1\u5B9A\u7684 Computer Use \u4F1A\u8BDD\uFF1A\u5148\u5728\u684C\u9762\u7AEF\u65B0\u5EFA\u4E00\u4E2A CU \u4F1A\u8BDD" });
        device.send("screen.frame", {
          stage: "\u7B49\u5F85\u4F1A\u8BDD",
          title: "\u6CA1\u6709\u53EF\u81EA\u52A8\u7ED1\u5B9A\u7684 CU \u4F1A\u8BDD",
          bullets: ["\u5148\u5728\u684C\u9762\u7AEF\u65B0\u5EFA Computer Use \u4F1A\u8BDD", "\u518D\u56DE\u6765\u70B9\u300C\u5237\u65B0\u4F1A\u8BDD\u5217\u8868\u300D"],
          tone: "alert"
        });
      }
      log(`tihu auto bind: no computer-use session (${reason})`);
      return;
    }
    const changed = device.sessionId !== active.sessionId;
    await bindSession(device, active.sessionId, { auto: true, followed: reason === "inject" && changed });
    if (reason === "inject" && changed) {
      device.send("event.progress", {
        stage: "\u8DDF\u968F",
        text: `\u5DF2\u81EA\u52A8\u8DDF\u968F\u5230\uFF1A${active.title || shortSessionId(active.sessionId)}`
      });
      log(`tihu auto follow session=${active.sessionId}`);
    }
    log(`tihu auto bind reason=${reason} session=${active.sessionId} changed=${String(changed)}`);
  }
  function replyScreen(sessionId, sentences, currentIndex, charPos, includeAll) {
    const pending = pendingByDisplay.get(sessionId) ?? [];
    const widthPx = pending.length > 0 ? 240 : CONTENT_WIDTH_PX;
    let state = screenStates.get(sessionId);
    if (state === void 0 || state.sentences !== sentences || state.widthPx !== widthPx) {
      const lines = [];
      for (const sentence of sentences) {
        for (const line of wrapTextPx(sentence.text, widthPx, SCREEN_SPEC.bodyFontPx)) {
          lines.push({ text: line, sentenceIndex: sentence.index });
        }
      }
      const offset = state?.offset ?? 0;
      state = { lines, offset, follow: state?.follow ?? true, sentences, currentIndex, charPos, widthPx };
      screenStates.set(sessionId, state);
    }
    state.currentIndex = currentIndex;
    state.charPos = charPos;
    const visibleLines = SCREEN_SPEC.replyVisibleLines;
    const maxOffset = Math.max(0, state.lines.length - visibleLines);
    state.offset = Math.max(0, Math.min(state.offset, maxOffset));
    const list = includeAll ? sentences : replyWindow(sentences, currentIndex);
    const totalChars = sentences.length > 0 ? sentences[sentences.length - 1].end : 0;
    return {
      stage: "\u56DE\u7B54\u4E2D",
      title: "",
      bullets: [],
      tone: "ok",
      mode: "reply",
      reply: {
        sentences: list.map((sentence) => ({ index: sentence.index, start: sentence.start, end: sentence.end, text: sentence.text })),
        currentIndex,
        total: sentences.length,
        totalChars,
        charPos,
        lines: state.lines.slice(state.offset, state.offset + visibleLines),
        scroll: { offset: state.offset, maxOffset },
        follow: state.follow
      },
      pending: pending.slice(0, 4).map((item) => ({ sessionId: item.sessionId, title: item.title, at: item.at, unread: true })),
      pendingCount: pending.length
    };
  }
  function sendReply(sessionId, sentences, currentIndex, charPos, includeAll) {
    screen(sessionId, replyScreen(sessionId, sentences, currentIndex, charPos, includeAll));
  }
  async function sendHome(sessionId) {
    let rows = [];
    try {
      rows = (await collectSessionRows()).rows;
    } catch {
      rows = [];
    }
    const groups = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const cwd = row.cwd ?? "";
      const name2 = cwd === "" ? "\u5176\u4ED6" : cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
      const key = cwd === "" ? "__other__" : cwd;
      if (!groups.has(key)) groups.set(key, { name: name2, rows: [] });
      groups.get(key).rows.push(row);
    }
    const now = Date.now();
    const projects = [...groups.values()].map((group) => {
      const latest = group.rows.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const running = group.rows.some((row) => row.live && now - row.updatedAt < 5 * 6e4);
      const recent = latest !== void 0 && now - latest.updatedAt < 24 * 36e5;
      const status = running ? "running" : recent ? "done" : "idle";
      return {
        name: group.name,
        status,
        summary: latest === void 0 ? "\u6682\u65E0\u4F1A\u8BDD" : latest.title || shortSessionId(latest.sessionId),
        updatedAt: latest?.updatedAt ?? 0
      };
    }).sort((a, b) => {
      const rank = { running: 0, done: 1, idle: 2 };
      return rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt;
    });
    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(projects.length / pageSize));
    const state = homeStates.get(sessionId) ?? { mode: "session", page: 0, done: false };
    state.page = Math.max(0, Math.min(state.page, totalPages - 1));
    state.mode = "home";
    homeStates.set(sessionId, state);
    const pageProjects = projects.slice(state.page * pageSize, (state.page + 1) * pageSize).map((project) => ({
      name: project.name,
      status: project.status,
      summary: project.summary
    }));
    screen(sessionId, {
      stage: "\u63A7\u5236\u5BA4",
      title: "",
      bullets: [],
      tone: "ok",
      mode: "home",
      home: { projects: pageProjects, page: { index: state.page, total: totalPages }, total: projects.length },
      pending: (pendingByDisplay.get(sessionId) ?? []).slice(0, 4).map((item) => ({ sessionId: item.sessionId, title: item.title, at: item.at, unread: true })),
      pendingCount: (pendingByDisplay.get(sessionId) ?? []).length
    });
  }
  function enqueuePending(completedSessionId) {
    const title = sessionListCache?.rows.find((row) => row.sessionId === completedSessionId)?.title || shortSessionId(completedSessionId);
    const displays = /* @__PURE__ */ new Set();
    for (const device of devices) {
      if (device.sessionId !== void 0 && device.sessionId !== completedSessionId) displays.add(device.sessionId);
    }
    for (const display of displays) {
      const list = pendingByDisplay.get(display) ?? [];
      const existing = list.find((item) => item.sessionId === completedSessionId);
      if (existing !== void 0) existing.at = Date.now();
      else list.push({ sessionId: completedSessionId, title, at: Date.now() });
      list.sort((a, b) => a.at - b.at);
      pendingByDisplay.set(display, list);
      const state = screenStates.get(display);
      if (state !== void 0) sendReply(display, state.sentences, state.currentIndex, state.charPos, true);
    }
  }
  function cancelHomeTimer(sessionId) {
    const state = homeStates.get(sessionId);
    if (state?.timer !== void 0) {
      clearTimeout(state.timer);
      state.timer = void 0;
    }
  }
  function scheduleHome(sessionId) {
    const state = homeStates.get(sessionId);
    if (state === void 0 || !state.done) return;
    cancelHomeTimer(sessionId);
    const delay = Number(process.env.TIHU_HOME_AFTER_MS ?? 1e4);
    state.timer = setTimeout(() => {
      const current = homeStates.get(sessionId);
      if (current === void 0 || !current.done) return;
      const scroll = screenStates.get(sessionId);
      if (scroll !== void 0 && !scroll.follow) return;
      void sendHome(sessionId).catch((error) => log(`tihu home failed: ${error?.message ?? String(error)}`));
    }, Number.isFinite(delay) ? delay : 1e4);
  }
  async function speakLocally(device, sessionId, sentences, speechSegments, includeAll) {
    if (speechSegments.length === 0) return;
    if (device.voice && device.voice !== "default" || device.offlineOnly) await tts.ensureServer();
    const status = tts.status();
    if (!status.available) {
      device.send("event.alert", { level: "error", text: `\u672C\u6B21\u65E0\u8BED\u97F3\uFF1A\u5728\u7EBF\u515C\u5E95\u4E0D\u53EF\u7528\u4E14\u672C\u5730\u5F15\u64CE\u672A\u5C31\u7EEA\uFF08\u539F\u56E0\uFF1A${status.error ?? "\u672A\u5B89\u88C5\u6A21\u578B"}\uFF09` });
      setTimeout(() => scheduleHome(sessionId), 50);
      return;
    }
    const voice = device.voice || "default";
    if (tts.deviceFallback() !== "") {
      device.send("event.alert", { level: "warn", text: tts.deviceFallback() });
    }
    device.send("event.progress", { stage: "tts", text: tts.engineLabel(voice) });
    try {
      for (let index = 0; index < speechSegments.length; index += 1) {
        const segment = speechSegments[index];
        const scrollState = screenStates.get(sessionId);
        if (scrollState !== void 0 && scrollState.follow) {
          const lineIndex = scrollState.lines.findIndex((line) => line.sentenceIndex === segment.sentenceIndex);
          if (lineIndex >= 0) {
            const maxOffset = Math.max(0, scrollState.lines.length - SCREEN_SPEC.replyVisibleLines);
            scrollState.offset = Math.max(0, Math.min(lineIndex - 2, maxOffset));
          }
        }
        sendReply(sessionId, sentences, segment.sentenceIndex, segment.start, includeAll);
        await tts.synthesize(segment.text, {
          voice,
          sessionId,
          edgeVoice: device.edgeVoice,
          offlineOnly: device.offlineOnly,
          onChunk: (chunk) => {
            device.send("tts.audio", {
              seq: chunk.seq,
              total: chunk.total,
              sampleRate: 24e3,
              channels: 1,
              format: "pcm16",
              data: chunk.data.toString("base64"),
              index: segment.index,
              text: segment.text,
              charStart: segment.start,
              charEnd: segment.end,
              ...chunk.final ? { final: true } : {}
            });
          }
        });
        const engineNote = tts.takeEngineNote();
        if (engineNote.startsWith("\u5728\u7EBF\u515C\u5E95")) {
          device.send("event.progress", { stage: "tts", text: engineNote });
        }
      }
      const last = sentences[sentences.length - 1];
      sendReply(sessionId, sentences, sentences.length - 1, last.end, includeAll);
      setTimeout(() => scheduleHome(sessionId), 50);
    } catch (error) {
      const message = error?.message ?? String(error);
      log(`tihu tts failed session=${sessionId} voice=${voice}: ${message}`);
      device.send("event.alert", { level: "error", text: `\u672C\u6B21\u65E0\u8BED\u97F3\uFF1A\u5728\u7EBF\u515C\u5E95\u4E0D\u53EF\u7528\u4E14\u672C\u5730\u5F15\u64CE\u672A\u5C31\u7EEA\uFF08\u539F\u56E0\uFF1A${message}\uFF09` });
      setTimeout(() => scheduleHome(sessionId), 50);
    }
  }
  async function transcribe(audioBase64) {
    const speech = optionalService(ctx, "speechController");
    if (speech === void 0 || typeof speech?.transcribe !== "function") {
      throw new Error("\u672C\u673A\u8BED\u97F3\u8F6C\u5199\u4E0D\u53EF\u7528\uFF1A\u5BBF\u4E3B\u6CA1\u6709\u52A0\u8F7D speech \u670D\u52A1\uFF08voice-input / speech-to-text \u63D2\u4EF6\uFF09");
    }
    if (!looksLikeWavBase64(audioBase64)) throw new Error("\u97F3\u9891\u4E0D\u662F WAV\uFF08\u9700\u8981 16k \u5355\u58F0\u9053 16bit\uFF09");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const audio = new Uint8Array(Buffer.from(audioBase64, "base64"));
      const result = await speech.transcribe({ audio, language: "auto", audioBase64 }, controller.signal);
      const text = typeof result === "string" ? result : String(result?.text ?? result?.transcript ?? result?.result ?? "").trim();
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  }
  function inject2(sessionId, text) {
    const agents = optionalService(ctx, "agents");
    const agent = agents?.get?.(sessionId);
    if (agent === void 0 || agent === null || typeof agent.followup !== "function") {
      throw new Error(`\u4F1A\u8BDD ${sessionId.slice(0, 8)}\u2026 \u5F53\u524D\u6CA1\u6709\u6D3B\u52A8 agent\uFF08\u5148\u5728\u624B\u673A\u4E0A\u628A\u8FD9\u4E2A\u4F1A\u8BDD\u6253\u5F00\uFF09`);
    }
    const message = buildTihuUserMessage(text);
    activeSessions.set(sessionId, { until: Date.now() + ACTIVE_WINDOW_MS, messageId: String(message.id) });
    agent.followup(message);
    log(`tihu inject session=${sessionId} chars=${text.length}`);
  }
  function endSession(sessionId) {
    const existed = activeSessions.delete(sessionId);
    if (existed) log(`tihu session end session=${sessionId}`);
    return existed;
  }
  function windowOf(sessionId) {
    const window = activeSessions.get(sessionId);
    if (window === void 0) return void 0;
    if (window.until < Date.now()) {
      activeSessions.delete(sessionId);
      return void 0;
    }
    return window;
  }
  function touchWindow(sessionId) {
    const window = activeSessions.get(sessionId);
    if (window === void 0) return;
    window.until = Date.now() + ACTIVE_WINDOW_MS;
  }
  function lastUserMessageId(session) {
    try {
      const messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : void 0;
      if (!Array.isArray(messages)) return void 0;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== "user") continue;
        return typeof message.id === "string" ? message.id : void 0;
      }
      return void 0;
    } catch {
      return void 0;
    }
  }
  const pendingCalls = /* @__PURE__ */ new Map();
  function tihuTurnOf(exec) {
    const sessionId = sessionIdOfAgent(exec?.agent);
    if (sessionId === void 0) return void 0;
    const window = windowOf(sessionId);
    if (window === void 0) return void 0;
    const last = lastUserMessageId(exec?.agent?.session);
    if (last === void 0) return sessionId;
    return last === window.messageId ? sessionId : void 0;
  }
  function deviceOnlineFor(sessionId) {
    for (const device of devices) {
      if (device.sessionId === sessionId) return true;
    }
    return false;
  }
  function argsOf(exec) {
    return exec?.arguments ?? exec?.args;
  }
  function workspaceFor(sessionId, agent) {
    const fromOption = options.workspaceOf?.(sessionId);
    if (typeof fromOption === "string" && fromOption !== "") return fromOption;
    const cwd = agent?.session?.header?.cwd;
    return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
  }
  const disposePre = ctx.on?.("tools/pre-execute", async (exec, next) => {
    try {
      const sessionId = tihuTurnOf(exec);
      if (sessionId === void 0) return await next();
      const tool = String(exec?.name ?? "");
      const workspace = workspaceFor(sessionId, exec?.agent);
      const args = argsOf(exec);
      const rawTarget = targetPathOf(args);
      const command = commandOf(args);
      const target = rawTarget !== void 0 ? rawTarget : command;
      const exists = rawTarget !== void 0 ? existsSyncSafe(workspace, rawTarget) : void 0;
      const action = classifyTool(tool, exists, command);
      if (!action.touchesFiles && !action.dangerous) return await next();
      let snapshotPath;
      let snapshotRoot;
      if (action.touchesFiles && rawTarget !== void 0) {
        const snapshot = takeSnapshot(workspace, rawTarget, timestampSlug());
        snapshotPath = snapshot.snapshotPath;
        snapshotRoot = snapshot.snapshotRoot;
        if (snapshot.copied) {
          screen(sessionId, {
            stage: "\u52A8\u624B",
            title: `${action.label}\u524D\u5DF2\u5907\u4EFD`,
            bullets: [snapshot.relativePath ?? "", `\u5FEB\u7167\u76EE\u5F55 .tihu/snapshots/${timestampSlug().slice(0, 15)}\u2026`],
            tone: "busy"
          });
          log(`tihu snapshot ${snapshot.relativePath} -> ${snapshot.snapshotPath}`);
        }
      }
      if (action.dangerous) {
        const detail = action.kind === "shell" ? String(command ?? "").slice(0, 300) : String(rawTarget ?? target ?? "");
        if (!deviceOnlineFor(sessionId)) {
          appendAudit(workspace, {
            ts: (/* @__PURE__ */ new Date()).toISOString(),
            source: "tihu",
            sessionId,
            action: action.kind,
            tool,
            ...detail === "" ? {} : { target: detail },
            ...snapshotRoot === void 0 ? {} : { snapshot: snapshotRoot },
            decision: "offline",
            note: "\u8BBE\u5907\u4E0D\u5728\u7EBF\uFF0C\u5371\u9669\u52A8\u4F5C\u76F4\u63A5\u62D2\u7EDD\uFF08\u4E0D\u7B49\u5F85\uFF09"
          });
          return { kind: "deny", reason: "tihu: \u8BBE\u5907\u4E0D\u5728\u7EBF\uFF0C\u5371\u9669\u52A8\u4F5C\u9ED8\u8BA4\u53D6\u6D88" };
        }
        const answer = await confirmBroker.ask({
          title: `${action.label}\uFF1A\u9700\u8981\u4F60\u786E\u8BA4`,
          detail,
          timeoutMs: CONFIRM_TIMEOUT_MS,
          risk: action.kind === "send" ? "medium" : "high",
          sessionId
        });
        const approved = answer.outcome === "approved";
        appendAudit(workspace, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          source: "tihu",
          sessionId,
          action: action.kind,
          tool,
          ...detail === "" ? {} : { target: detail },
          ...snapshotRoot === void 0 ? {} : { snapshot: snapshotRoot },
          decision: approved ? `confirm-${answer.outcome}` : answer.outcome,
          note: approved ? "\u8BBE\u5907\u786E\u8BA4\u901A\u8FC7" : "\u672A\u83B7\u786E\u8BA4\uFF0C\u5DF2\u62D2\u7EDD\u6267\u884C"
        });
        if (!approved) {
          const reason = answer.outcome === "timeout" ? "tihu: \u5371\u9669\u52A8\u4F5C\u786E\u8BA4\u8D85\u65F6\uFF0C\u6309\u53D6\u6D88\u5904\u7406" : answer.outcome === "offline" ? "tihu: \u8BBE\u5907\u4E0D\u5728\u7EBF\uFF0C\u5371\u9669\u52A8\u4F5C\u9ED8\u8BA4\u53D6\u6D88" : "tihu: \u7528\u6237\u5728\u8BBE\u5907\u4E0A\u53D6\u6D88\u4E86\u8FD9\u6B21\u64CD\u4F5C";
          screen(sessionId, { stage: "\u5DF2\u53D6\u6D88", title: action.label, bullets: ["\u5371\u9669\u52A8\u4F5C\u672A\u6267\u884C"], tone: "alert" });
          return { kind: "deny", reason };
        }
        screen(sessionId, { stage: "\u52A8\u624B", title: `${action.label}\uFF1A\u5DF2\u786E\u8BA4`, bullets: [String(detail).slice(0, 20)], tone: "busy" });
      } else {
        appendAudit(workspace, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          source: "tihu",
          sessionId,
          action: action.kind,
          tool,
          ...rawTarget === void 0 ? {} : { target: rawTarget },
          ...snapshotRoot === void 0 ? {} : { snapshot: snapshotRoot },
          decision: "allow",
          note: snapshotPath === void 0 ? "\u65B0\u6587\u4EF6\u6216\u65E0\u6587\u4EF6\u76EE\u6807" : "\u5DF2\u5FEB\u7167"
        });
      }
      if (typeof exec?.callId === "string") {
        pendingCalls.set(exec.callId, { sessionId, workspace, action, tool, target: rawTarget, snapshotPath, snapshotRoot });
      }
      return await next();
    } catch (error) {
      log(`tihu pre-execute failed: ${error?.stack ?? String(error)}`);
      return await next();
    }
  });
  const disposePost = ctx.on?.("tools/post-execute", async (exec, result, next) => {
    try {
      const callId = typeof exec?.callId === "string" ? exec.callId : void 0;
      const pending = callId !== void 0 ? pendingCalls.get(callId) : void 0;
      if (pending !== void 0) {
        pendingCalls.delete(callId);
        const failed = result?.kind === "failure" || result?.ok === false || result?.error !== void 0;
        let diff;
        if (pending.snapshotPath !== void 0 && pending.target !== void 0) {
          const before = readTextOrEmpty(pending.snapshotPath);
          const after = readTextOrEmpty(joinSafe(pending.workspace, pending.target));
          const summary = diffSummary(before, after);
          diff = { added: summary.added, removed: summary.removed };
          if (!failed) {
            screen(pending.sessionId, {
              stage: "\u52A8\u624B",
              title: `${pending.action.label}\u5B8C\u6210`,
              bullets: [pending.target, summary.summary],
              tone: "ok"
            });
          }
          broadcast(pending.sessionId, "event.progress", {
            stage: "diff",
            text: `${pending.target} ${summary.summary}`,
            done: diff.added
          });
        }
        appendAudit(pending.workspace, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          source: "tihu",
          sessionId: pending.sessionId,
          action: pending.action.kind,
          tool: pending.tool,
          ...pending.target === void 0 ? {} : { target: pending.target },
          ...pending.snapshotRoot === void 0 ? {} : { snapshot: pending.snapshotRoot },
          decision: "executed",
          result: failed ? "failed" : "executed",
          ...diff === void 0 ? {} : { diff }
        });
      }
    } catch (error) {
      log(`tihu post-execute failed: ${error?.stack ?? String(error)}`);
    }
    return await next();
  });
  const disposeSession = ctx.on?.("session/event", (session, event) => {
    try {
      const sessionId = sessionIdOf(session);
      if (sessionId === void 0) return;
      if (String(event?.type ?? "") === "user/message" && event?.data?.source?.kind === "user") {
        const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId);
        if (row !== void 0) {
          const at = Number.isFinite(event?.time) ? Number(event.time) : Date.now();
          row.updatedAt = Math.max(row.updatedAt, at);
          if (sessionListCache !== void 0) sessionListCache.rows = sortSessionRows(sessionListCache.rows);
        }
      }
      if (![...devices].some((device) => device.sessionId === sessionId)) return;
      const type = String(event?.type ?? "");
      const data = event?.data ?? {};
      const state = progressStates.get(sessionId) ?? createProgressState();
      progressStates.set(sessionId, state);
      if (type === "turn/start" || type === "step/start" || type === "tool/call" || type === "tool/result") {
        replySessions.delete(sessionId);
      }
      if (type === "turn/start") {
        screenStates.delete(sessionId);
        cancelHomeTimer(sessionId);
        homeStates.set(sessionId, { mode: "session", page: 0, done: false });
      }
      const update = applySessionEvent(state, event);
      if (type === "turn/start") {
        touchWindow(sessionId);
      }
      if (type === "assistant/message") replySessions.add(sessionId);
      const keepReply = type === "turn/end" && replySessions.has(sessionId);
      if (update.screen !== void 0 && !keepReply) screen(sessionId, update.screen);
      if (update.progress !== void 0) broadcast(sessionId, "event.progress", update.progress);
      if (type === "assistant/message") {
        const blocks = data?.message?.content ?? [];
        const text = blocks.filter((b) => b?.type === "text").map((b) => String(b?.text ?? "")).join("\n").trim();
        if (text === "") return;
        const sentences = splitReplySentences(text);
        if (sentences.length === 0) return;
        const speechSegments = splitSpeechSegments(text).map((segment) => ({ ...segment, text: toSpeechText(segment.text) })).filter((segment) => segment.text !== "");
        const includeAll = [...text].length <= 2e3;
        if (speechSegments.length === 0) {
          sendReply(sessionId, sentences, 0, 0, includeAll);
          broadcast(sessionId, "event.alert", {
            level: "error",
            text: "\u672C\u6B21\u65E0\u8BED\u97F3\uFF1A\u6B63\u6587\u53EA\u6709\u7B26\u53F7/\u7A7A\u767D\uFF0C\u5DF2\u6E05\u6D17\u4E3A\u7A7A\uFF08\u4EC5\u663E\u793A\u6587\u5B57\uFF09"
          });
          return;
        }
        speechSegments.forEach((segment) => {
          broadcast(sessionId, "tts.text", {
            text: segment.text,
            index: segment.index,
            total: speechSegments.length,
            lang: "zh-CN",
            charStart: segment.start,
            charEnd: segment.end
          });
        });
        screenStates.delete(sessionId);
        lastReplies.set(sessionId, { sentences, speechSegments, includeAll });
        cancelHomeTimer(sessionId);
        homeStates.set(sessionId, { mode: "session", page: 0, done: false });
        sendReply(sessionId, sentences, 0, 0, includeAll);
        for (const device of devices) {
          if (device.sessionId === sessionId) {
            void speakLocally(device, sessionId, sentences, speechSegments, includeAll).catch((error) => {
              log(`tihu tts task failed: ${error?.message ?? String(error)}`);
            });
          }
        }
        return;
      }
      if (type === "turn/end") {
        const reason = String(data?.reason?.kind ?? "stop");
        const okReason = reason === "stop" || reason === "completed";
        broadcast(sessionId, "event.done", {
          text: okReason ? "\u672C\u8F6E\u5B8C\u6210" : `\u672C\u8F6E\u7ED3\u675F\uFF08${reason}\uFF09`,
          ok: okReason,
          sessionId
        });
        const hs = homeStates.get(sessionId) ?? { mode: "session", page: 0, done: false };
        hs.done = okReason;
        homeStates.set(sessionId, hs);
        if (okReason) enqueuePending(sessionId);
        return;
      }
    } catch (error) {
      log(`tihu session event failed: ${error?.stack ?? String(error)}`);
    }
  });
  function handleUpgrade(req, socket, head) {
    if (pathnameOf(req) !== TIHU_LANE_PATH) return false;
    const key = req?.headers?.["sec-websocket-key"];
    if (typeof key !== "string" || key === "") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "",
      ""
    ].join("\r\n"));
    try {
      socket.setNoDelay?.(true);
    } catch {
    }
    const seqOf = createSeq();
    const device = {
      id: randomId("dev"),
      socket,
      seq: seqOf,
      autoFollow: false,
      voice: "default",
      edgeVoice: process.env.TIHU_EDGE_VOICE ?? "zh-CN-YunjianNeural",
      offlineOnly: process.env.TIHU_OFFLINE_ONLY === "1",
      send(type, payload) {
        try {
          const message = buildDownstream(type, payload, seqOf());
          socket.write(encodeFrame({ fin: true, opcode: 1, payload: Buffer.from(JSON.stringify(message), "utf8") }));
        } catch {
        }
      },
      close() {
        try {
          socket.destroy();
        } catch {
        }
      }
    };
    devices.add(device);
    log(`tihu device connected id=${device.id} ip=${req?.socket?.remoteAddress ?? "?"}`);
    let queue = Promise.resolve();
    const enqueue = (message) => {
      const guard = new Promise((resolve) => {
        setTimeout(() => {
          log("tihu upstream message timed out (60s)");
          resolve();
        }, 6e4).unref?.();
      });
      queue = queue.then(() => Promise.race([handleUpstream(device, message), guard])).catch((error) => {
        log(`tihu upstream failed: ${error?.stack ?? String(error)}`);
      });
    };
    const parser = new WsFrameParser(
      (frame) => {
        try {
          if (frame.opcode === 8) {
            device.close();
            return;
          }
          if (frame.opcode === 9) {
            socket.write(encodeFrame({ fin: true, opcode: 10, payload: frame.payload }));
            return;
          }
          if (frame.opcode !== 1) return;
          if (frame.payload.length > MAX_WS_MESSAGE_BYTES) return;
          const message = parseUpstream(frame.payload);
          if (message === null) {
            const rejected = safeJson(frame.payload);
            log(`tihu ignored message: ${summarizeForLog(rejected)}`);
            if (rejected?.type === "audio.frame") {
              device.send("event.alert", {
                level: "error",
                text: "\u97F3\u9891\u5E27\u88AB\u62D2\u7EDD\uFF1A\u9700\u8981 16k \u5355\u58F0\u9053 16bit WAV\uFF08base64 \u4E0D\u8D85\u8FC7 6 MB\uFF09"
              });
            }
            return;
          }
          enqueue(message);
        } catch (error) {
          log(`tihu frame failed: ${error?.stack ?? String(error)}`);
        }
      },
      (error) => {
        log(`tihu ws parse failed: ${error?.message ?? String(error)}`);
        device.send("event.alert", { level: "error", text: `\u8FDE\u63A5\u6570\u636E\u89E3\u6790\u5931\u8D25\uFF1A${error?.message ?? String(error)}` });
      }
    );
    socket.on("data", (chunk) => parser.push(chunk));
    socket.on("error", () => {
    });
    socket.on("close", () => {
      devices.delete(device);
      if (devices.size === 0) confirmBroker.failAll?.("offline");
      broadcastAll("event.alert", { level: "info", text: "\u8BBE\u5907\u5DF2\u65AD\u5F00" });
      log(`tihu device disconnected id=${device.id}`);
    });
    if (head !== void 0 && head.length > 0) parser.push(head);
    return true;
  }
  function broadcastAll(type, payload) {
    for (const device of devices) device.send(type, payload);
  }
  async function handleUpstream(device, message) {
    const type = String(message.type);
    if (type === "ping") {
      device.send("pong", { nonce: message?.payload?.nonce });
      return;
    }
    if (type === "hello") {
      const payload = message.payload;
      if (payload.protocol !== void 0 && payload.protocol !== TIHU_PROTOCOL_VERSION) {
        device.send("event.alert", { level: "error", text: `\u534F\u8BAE\u7248\u672C\u4E0D\u5339\u914D\uFF1A\u8BBE\u5907 ${payload.protocol} / \u5BBF\u4E3B ${TIHU_PROTOCOL_VERSION}` });
        return;
      }
      device.hello = payload;
      const caps = payload.capabilities ?? {};
      const requested = typeof payload.sessionId === "string" && payload.sessionId !== "" ? payload.sessionId : void 0;
      if (requested !== void 0) {
        device.autoFollow = false;
        await bindSession(device, requested);
      } else if (payload.auto === true) {
        device.autoFollow = true;
        await autoBindActive(device, "hello");
      } else {
        device.autoFollow = false;
        device.sessionId = void 0;
        device.send("screen.frame", {
          stage: "\u8FDE\u63A5",
          title: payload.deviceName ?? "\u9E48\u9E55\u6A21\u62DF\u8BBE\u5907",
          bullets: [
            `\u534F\u8BAE v${TIHU_PROTOCOL_VERSION}`,
            "\u8FD8\u6CA1\u6709\u9009\u5B9A Computer Use \u4F1A\u8BDD\uFF1A\u5728\u9875\u9762\u4E0B\u9762\u7684\u5217\u8868\u91CC\u9009\u4E00\u4E2A",
            caps.microphone === false ? "\u65E0\u9EA6\u514B\u98CE\uFF1A\u7528 WAV \u6587\u4EF6\u9A71\u52A8" : "\u9EA6\u514B\u98CE\u53EF\u7528"
          ],
          tone: "idle"
        });
      }
      device.send("event.progress", { stage: "\u8FDE\u63A5", text: `\u8BBE\u5907 ${device.id} \u5DF2\u5C31\u7EEA` });
      log(`tihu hello client=${payload.clientId} session=${device.sessionId ?? "?"} caps=${JSON.stringify(caps)}`);
      return;
    }
    if (type === "sessions.query") {
      const payload = message.payload ?? {};
      const limit = Number.isSafeInteger(payload.limit) ? Math.min(50, Math.max(1, payload.limit)) : 10;
      const checkId = typeof payload.checkId === "string" && payload.checkId !== "" ? payload.checkId : void 0;
      const list = await listSessionChoices(limit, checkId);
      device.send("sessions.list", list);
      log(`tihu sessions.query limit=${limit} total=${list.total} cuTotal=${list.cuTotal} source=${list.source} check=${checkId ?? "-"}${list.check === void 0 ? "" : ` found=${String(list.check.found)} cu=${String(list.check.computerUse)} preset=${list.check.preset ?? "-"}`}`);
      return;
    }
    if (type === "session.bind") {
      const payload = message.payload ?? {};
      if (payload.auto === true) {
        device.autoFollow = true;
        await autoBindActive(device, "hello");
        return;
      }
      device.autoFollow = false;
      await bindSession(device, String(payload.sessionId ?? ""));
      return;
    }
    if (type === "confirm.reply") {
      const payload = message.payload;
      const handled = confirmBroker.reply(payload.confirmId, payload.approved === true);
      device.send("event.progress", {
        stage: "\u786E\u8BA4",
        text: handled ? payload.approved ? "\u5DF2\u786E\u8BA4\u6267\u884C" : "\u5DF2\u53D6\u6D88\u6267\u884C" : "\u8FD9\u6761\u786E\u8BA4\u5DF2\u8FC7\u671F"
      });
      return;
    }
    if (type === "session.end") {
      const payload = message.payload ?? {};
      const sessionId = device.sessionId ?? (typeof payload.sessionId === "string" ? payload.sessionId : void 0);
      if (sessionId === void 0) {
        device.send("event.progress", { stage: "\u4F1A\u8BDD", text: "\u5F53\u524D\u6CA1\u6709\u7ED1\u5B9A\u4F1A\u8BDD" });
        return;
      }
      const ended = endSession(sessionId);
      confirmBroker.failAll?.("rejected");
      device.send("event.progress", {
        stage: "\u4F1A\u8BDD",
        text: ended ? `\u5DF2\u7ED3\u675F\u672C\u6B21\u8BED\u97F3\u4F1A\u8BDD\uFF08${payload.reason ?? "\u9875\u9762\u6309\u94AE"}\uFF09` : "\u5F53\u524D\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u8BED\u97F3\u4F1A\u8BDD"
      });
      device.send("screen.frame", {
        stage: "\u7A7A\u95F2",
        title: "\u5DF2\u7ED3\u675F\u672C\u6B21\u4F1A\u8BDD",
        bullets: ["\u95F8\u95E8\u5DF2\u5173\u95ED", "\u6309\u4F4F\u8BF4\u8BDD\u53EF\u518D\u5F00\u59CB"],
        tone: "idle"
      });
      return;
    }
    if (type === "screen.gesture") {
      const payload = message.payload;
      if (device.sessionId !== void 0) cancelHomeTimer(device.sessionId);
      if (payload.action === "tap" && device.sessionId !== void 0 && typeof payload.x === "number" && typeof payload.y === "number") {
        if (payload.hit === "chip" && typeof payload.targetSessionId === "string") {
          const target = payload.targetSessionId;
          const display = device.sessionId;
          const list = pendingByDisplay.get(display) ?? [];
          const index = list.findIndex((item) => item.sessionId === target);
          if (index >= 0) {
            list.splice(index, 1);
            pendingByDisplay.set(display, list);
            const reply = lastReplies.get(target);
            await bindSession(device, target);
            screenStates.delete(target);
            homeStates.set(target, { mode: "session", page: 0, done: true });
            if (reply !== void 0) {
              sendReply(target, reply.sentences, 0, 0, reply.includeAll);
              void speakLocally(device, target, reply.sentences, reply.speechSegments, reply.includeAll).catch((error) => {
                log(`tihu chip speak failed: ${error?.message ?? String(error)}`);
              });
            }
          }
          return;
        }
        if (payload.x >= 240 && payload.y >= 180) await sendHome(device.sessionId);
        return;
      }
      if (payload.action === "swipe" && device.sessionId !== void 0 && typeof payload.dy === "number") {
        const home = homeStates.get(device.sessionId);
        if (home?.mode === "home") {
          if (payload.phase === "move" || payload.phase === "end") {
            home.page = Math.max(0, home.page + (payload.dy < 0 ? 1 : payload.dy > 0 ? -1 : 0));
            await sendHome(device.sessionId);
          }
          return;
        }
        const scrollState = screenStates.get(device.sessionId);
        if (scrollState !== void 0) {
          const delta = -payload.dy / SCREEN_SPEC.bodyLineHeightPx;
          if (payload.phase === "move" || payload.phase === "end") {
            const maxOffset = Math.max(0, scrollState.lines.length - SCREEN_SPEC.replyVisibleLines);
            scrollState.offset = Math.max(0, Math.min(scrollState.offset + delta, maxOffset));
            scrollState.follow = scrollState.offset < 0.5;
            sendReply(device.sessionId, scrollState.sentences, scrollState.currentIndex, scrollState.charPos, true);
          }
        }
      }
      return;
    }
    if (type === "voice.list") {
      const voices = await tts.listVoices(device.sessionId);
      device.send("voice.list", { voices, selected: device.voice, engine: tts.status() });
      return;
    }
    if (type === "voice.select") {
      const name2 = String(message.payload?.name ?? "");
      device.voice = name2 === "" ? "default" : name2;
      if (typeof message.payload?.edgeVoice === "string" && message.payload.edgeVoice !== "") device.edgeVoice = message.payload.edgeVoice;
      if (typeof message.payload?.offlineOnly === "boolean") device.offlineOnly = message.payload.offlineOnly;
      if (device.voice !== "default" && tts.available()) {
        void tts.ensureServer().catch((error) => log(`tihu tts clone prewarm failed: ${error?.message ?? String(error)}`));
      }
      device.send("event.progress", { stage: "\u97F3\u8272", text: `\u97F3\u8272\u5DF2\u5207\u6362\uFF1A${device.voice}` });
      return;
    }
    if (type === "voice.create") {
      const payload = message.payload ?? {};
      try {
        const created = await tts.createVoice({
          name: String(payload.name ?? ""),
          wavBase64: String(payload.wavBase64 ?? ""),
          ...typeof payload.note === "string" ? { note: payload.note } : {}
        }, device.sessionId);
        device.send("voice.created", created);
        device.send("event.progress", {
          stage: "\u97F3\u8272",
          text: created.cached ? `\u97F3\u8272 ${created.voice.name} \u5DF2\u5B58\u5728\uFF08\u547D\u4E2D\u7F13\u5B58\uFF09` : `\u5DF2\u521B\u5EFA\u97F3\u8272 ${created.voice.name}`
        });
        device.send("voice.list", {
          voices: await tts.listVoices(device.sessionId),
          selected: device.voice,
          engine: tts.status()
        });
      } catch (error) {
        device.send("event.alert", { level: "error", text: `\u521B\u5EFA\u97F3\u8272\u5931\u8D25\uFF1A${error?.message ?? String(error)}` });
      }
      return;
    }
    if (type === "text.input" || type === "audio.frame") {
      device.send("event.progress", {
        stage: "audio",
        text: type === "audio.frame" ? "\u5DF2\u6536\u5230\u97F3\u9891\uFF0C\u51C6\u5907\u8F6C\u5199" : "\u5DF2\u6536\u5230\u6587\u5B57"
      });
      if (device.autoFollow) {
        try {
          await Promise.race([
            autoBindActive(device, "inject"),
            new Promise((resolve) => {
              setTimeout(() => {
                log("tihu auto follow timeout (5s), keep current session");
                resolve();
              }, 5e3);
            })
          ]);
        } catch (error) {
          log(`tihu auto follow failed: ${error?.message ?? String(error)}`);
        }
      }
      if (device.sessionId === void 0) {
        device.send("event.alert", {
          level: "warn",
          text: device.autoFollow ? "\u6CA1\u6709\u53EF\u81EA\u52A8\u7ED1\u5B9A\u7684 Computer Use \u4F1A\u8BDD\uFF1A\u5148\u5728\u684C\u9762\u7AEF\u65B0\u5EFA\u4E00\u4E2A" : "\u8FD8\u6CA1\u6709\u9009\u5B9A\u4F1A\u8BDD\uFF1A\u70B9\u9875\u9762\u4E0B\u9762\u7684\u4F1A\u8BDD\u5217\u8868\u9009\u4E00\u4E2A"
        });
        return;
      }
      touchWindow(device.sessionId);
      let text = "";
      let source = "keyboard";
      if (type === "text.input") {
        text = String(message.payload.text ?? "").trim();
        source = message.payload.source === "voice" ? "voice" : "keyboard";
        if (text === "") return;
      } else {
        source = "voice";
        device.send("screen.frame", { stage: "\u8046\u542C", title: "\u6B63\u5728\u8F6C\u5199\u2026", bullets: ["\u672C\u673A speech \u670D\u52A1"], tone: "busy" });
        try {
          text = await transcribe(String(message.payload.audioBase64 ?? ""));
        } catch (error) {
          device.send("event.alert", { level: "error", text: `\u8F6C\u5199\u5931\u8D25\uFF1A${error?.message ?? String(error)}` });
          device.send("screen.frame", { stage: "\u8F6C\u5199\u5931\u8D25", title: "\u8BF7\u7528\u6587\u5B57\u8F93\u5165", bullets: [], tone: "alert" });
          return;
        }
        if (text === "") {
          device.send("event.alert", { level: "warn", text: "\u6CA1\u6709\u8BC6\u522B\u5230\u8BED\u97F3\u5185\u5BB9\uFF0C\u8BF7\u518D\u8BF4\u4E00\u6B21" });
          return;
        }
      }
      try {
        device.send("transcript", { text, final: true, source, retryable: true });
        inject2(device.sessionId, text);
        device.send("event.progress", { stage: "\u6CE8\u5165", text: "\u5DF2\u9001\u5165\u5F53\u524D\u4F1A\u8BDD" });
        device.send("screen.frame", { stage: "\u601D\u8003", title: "\u6A21\u578B\u5904\u7406\u4E2D", bullets: [text.slice(0, 20)], tone: "busy" });
      } catch (error) {
        device.send("event.alert", { level: "error", text: `\u6CE8\u5165\u5931\u8D25\uFF1A${error?.message ?? String(error)}` });
      }
    }
  }
  return {
    page: () => tihuPageHtml({ lanePath: TIHU_LANE_PATH, protocol: TIHU_PROTOCOL_VERSION }),
    handleUpgrade,
    dispose: () => {
      ;
      confirmBroker.failAll?.("disposed");
      for (const [sessionId, state] of homeStates) {
        if (state.timer !== void 0) clearTimeout(state.timer);
        homeStates.delete(sessionId);
      }
      tts.dispose();
      for (const device of devices) device.close();
      devices.clear();
      for (const disposer of [disposePre, disposePost, disposeSession]) {
        try {
          if (typeof disposer === "function") disposer();
        } catch {
        }
      }
    },
    stats: () => ({ devices: devices.size, activeSessions: [...activeSessions.keys()], pendingConfirms: confirmBroker.pendingCount?.() ?? 0 })
  };
}
function safeJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return { type: "<unparsable>" };
  }
}
function joinSafe(workspace, target) {
  return isAbsolute2(target) ? target : join7(workspace, target);
}
function existsSyncSafe(workspace, target) {
  try {
    return existsSync5(joinSafe(workspace, target));
  } catch {
    return false;
  }
}

// src/pocket-host/settings.mjs
import { readFileSync as readFileSync4, writeFileSync as writeFileSync2, mkdirSync as mkdirSync4, rmSync, statSync as statSync3 } from "node:fs";
import { join as join8, dirname as dirname6 } from "node:path";
import { homedir as homedir4 } from "node:os";
import { randomBytes } from "node:crypto";
var settingsRel = join8("dsh-pocket", "settings.json");
function settingsPath() {
  return join8(process.env.DSH_HOME ?? join8(homedir4(), ".dsh"), settingsRel);
}
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync4(settingsPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
  }
  return {};
}
function writeSettings(s) {
  try {
    mkdirSync4(dirname6(settingsPath()), { recursive: true });
    writeFileSync2(settingsPath(), JSON.stringify(s, null, 2), { mode: 384 });
  } catch {
  }
  return s;
}
function settingsFileExists() {
  try {
    return statSync3(settingsPath()).isFile();
  } catch {
    return false;
  }
}
function hasOwn(settings, key) {
  return Object.prototype.hasOwnProperty.call(settings ?? {}, key);
}
function ensureFirstRunSettings() {
  try {
    if (settingsFileExists()) return null;
    return writeSettings({ lanEnabled: false, lanAuthEnabled: true });
  } catch {
    return null;
  }
}
function lanEnabled() {
  const s = readSettings();
  if (!hasOwn(s, "lanEnabled")) return settingsFileExists() ? true : false;
  return s.lanEnabled !== false;
}
function setLanEnabled(on) {
  const s = readSettings();
  s.lanEnabled = !!on;
  writeSettings(s);
  return s.lanEnabled;
}
function lanAuthEnabled() {
  const s = readSettings();
  if (!hasOwn(s, "lanAuthEnabled")) return true;
  return s.lanAuthEnabled !== false;
}
function setLanAuthEnabled(on) {
  const s = readSettings();
  s.lanAuthEnabled = !!on;
  writeSettings(s);
  return s.lanAuthEnabled;
}
function lanIpOverride() {
  return readSettings().lanIpOverride ?? "";
}
function setLanIpOverride(value) {
  const ip = String(value ?? "").trim();
  if (ip && !isValidIpv4(ip)) {
    throw new Error("\u5C40\u57DF\u7F51\u5730\u5740\u5FC5\u987B\u662F IPv4 \u5730\u5740 | LAN address must be an IPv4 address");
  }
  const s = readSettings();
  if (ip) s.lanIpOverride = ip;
  else delete s.lanIpOverride;
  writeSettings(s);
  return ip;
}
var PIN_CUSTOM_KEYS = { public: "publicPinCustom", lan: "lanPinCustom" };
function pinCustom(which) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  return readSettings()[key] === true;
}
function setPinCustom(which, on) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  const s = readSettings();
  s[key] = !!on;
  writeSettings(s);
  return !!on;
}
function resetSettings() {
  try {
    rmSync(settingsPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
function tunnelMode() {
  return readSettings().tunnelMode === "named" ? "named" : "quick";
}
function setTunnelMode(mode) {
  if (mode !== "quick" && mode !== "named") {
    throw new Error("\u96A7\u9053\u6A21\u5F0F\u5FC5\u987B\u662F quick \u6216 named | tunnel mode must be quick or named");
  }
  const s = readSettings();
  if (mode === "quick") delete s.tunnelMode;
  else s.tunnelMode = mode;
  writeSettings(s);
  return mode;
}
function tunnelToken() {
  const v = readSettings().tunnelToken;
  return typeof v === "string" ? v : "";
}
function setTunnelToken(value) {
  const v = String(value ?? "").trim();
  if (v) {
    if (v.length < 20 || !/^[A-Za-z0-9+/_=-]+$/.test(v)) {
      throw new Error("Tunnel Token \u683C\u5F0F\u4E0D\u5BF9\uFF08\u5E94\u4E3A Cloudflare \u540E\u53F0\u590D\u5236\u7684\u5B8C\u6574 Token\uFF09 | invalid tunnel token");
    }
  }
  const s = readSettings();
  if (v) s.tunnelToken = v;
  else delete s.tunnelToken;
  writeSettings(s);
  return v;
}
function tunnelHostname() {
  const v = readSettings().tunnelHostname;
  return typeof v === "string" ? v : "";
}
function setTunnelHostname(value) {
  let v = String(value ?? "").trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#\s]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (v) {
    const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
    const IS_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
    if (IS_IPV4.test(v) || !v.includes(".") || !HOSTNAME_RE.test(v)) {
      throw new Error("\u56FA\u5B9A\u57DF\u540D\u683C\u5F0F\u4E0D\u5BF9\uFF08\u5982 pocket.example.com\uFF09 | invalid tunnel hostname");
    }
  }
  const s = readSettings();
  if (v) s.tunnelHostname = v;
  else delete s.tunnelHostname;
  writeSettings(s);
  return v;
}
function proxyPort() {
  const v = Number(readSettings().proxyPort);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : 0;
}
function cloudflaredPath() {
  return readSettings().cloudflaredPath ?? "";
}
function sshTunnelConfig() {
  return normalizeSshTunnelConfig(readSettings().sshTunnel);
}
function setSshTunnelConfig(patch = {}) {
  const current = sshTunnelConfig();
  const merged = { ...current, ...patch && typeof patch === "object" ? patch : {} };
  const host = String(merged.host ?? "").trim();
  if (host) {
    const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
    if (!isValidIpv4(host) && !HOST_RE.test(host)) {
      throw new Error("\u516C\u7F51\u4E3B\u673A\u5FC5\u987B\u662F IPv4 \u6216\u57DF\u540D | tunnel host must be an IPv4 or a hostname");
    }
  }
  const next = normalizeSshTunnelConfig(merged);
  const s = readSettings();
  s.sshTunnel = next;
  writeSettings(s);
  return next;
}

// src/pocket-host/index.js
var name = "dsh-pocket";
var inject = ["connection", "webServer"];
var pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
function currentVersion() {
  try {
    return JSON.parse(readFileSync5(pkgPath, "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
var loadedVersion = currentVersion();
var runtimeRevision = (() => {
  try {
    return createHash4("sha256").update(readFileSync5(fileURLToPath(import.meta.url))).digest("hex");
  } catch {
    return loadedVersion;
  }
})();
var PIN_RE = /^[a-zA-Z0-9]{8}$/;
function writePinToFile(p, fresh) {
  try {
    mkdirSync5(dirname7(p), { recursive: true });
    writeFileSync3(p, fresh, { mode: 384 });
  } catch {
  }
  return fresh;
}
function readPin(p) {
  try {
    const existing = readFileSync5(p, "utf8").trim();
    if (PIN_RE.test(existing)) return existing;
  } catch {
  }
  return null;
}
function newPin() {
  return String(randomInt(1e7, 1e8));
}
function getPocketSessionKey(home) {
  const p = join9(home, "dsh-pocket", "session-key");
  try {
    const existing = readFileSync5(p, "utf8").trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {
  }
  return writePinToFile(p, randomBytes2(16).toString("hex"));
}
var tokenRel = join9("dsh-pocket", "token");
function tokenPath() {
  return join9(process.env.DSH_HOME ?? join9(homedir5(), ".dsh"), tokenRel);
}
function getAccessToken() {
  return readPin(tokenPath()) ?? writePinToFile(tokenPath(), newPin());
}
function rotateAccessToken() {
  if (pinCustom("public")) return getAccessToken();
  return writePinToFile(tokenPath(), newPin());
}
var lanTokenRel = join9("dsh-pocket", "token-lan");
function lanTokenPath() {
  return join9(process.env.DSH_HOME ?? join9(homedir5(), ".dsh"), lanTokenRel);
}
function getLanToken() {
  return readPin(lanTokenPath()) ?? writePinToFile(lanTokenPath(), newPin());
}
function refreshLanToken() {
  setPinCustom("lan", false);
  return writePinToFile(lanTokenPath(), newPin());
}
function tokenForHost(host) {
  if (isLanOverrideHost(host)) return getLanToken();
  return classifyHost(host) === "public" ? getAccessToken() : getLanToken();
}
function hostNameOnly(host) {
  let name2 = String(host ?? "").trim().toLowerCase();
  if (name2.startsWith("[")) {
    const end = name2.indexOf("]");
    if (end >= 0) name2 = name2.slice(1, end);
  } else {
    name2 = name2.replace(/:\d+$/, "");
  }
  return name2;
}
function isLanOverrideHost(host) {
  const override = lanIpOverride().trim().toLowerCase();
  return override.length > 0 && hostNameOnly(host) === override;
}
function setCustomPin(which, value) {
  const v = String(value ?? "").trim();
  if (!PIN_RE.test(v)) throw new Error("\u5BC6\u7801\u5FC5\u987B\u662F 8 \u4F4D\u82F1\u6587\u5B57\u6BCD\u6216\u6570\u5B57 | PIN must be exactly 8 characters (letters and digits only)");
  if (which === "public") {
    writePinToFile(tokenPath(), v);
    setPinCustom("public", true);
    return v;
  }
  if (which === "lan") {
    writePinToFile(lanTokenPath(), v);
    setPinCustom("lan", true);
    return v;
  }
  throw new Error("\u672A\u77E5\u5BC6\u7801\u7C7B\u578B | unknown PIN kind");
}
function resetPocketState() {
  resetSettings();
  writePinToFile(tokenPath(), newPin());
  writePinToFile(lanTokenPath(), newPin());
  return { accessToken: getAccessToken(), lanToken: getLanToken() };
}
var restartNoticeRel = join9("dsh-pocket", "restarted.json");
function restartNoticePath() {
  return join9(process.env.DSH_HOME ?? join9(homedir5(), ".dsh"), restartNoticeRel);
}
async function readRestartNotice() {
  try {
    const raw = JSON.parse(await readFile3(restartNoticePath(), "utf8"));
    if (!raw?.at) return null;
    if (Date.now() - raw.at > 30 * 60 * 1e3) return null;
    return raw;
  } catch {
    return null;
  }
}
function writeRestartNotice() {
  return mkdir4(dirname7(restartNoticePath()), { recursive: true }).then(() => writeFile3(restartNoticePath(), JSON.stringify({ at: Date.now(), pid: process.pid }), "utf8"));
}
async function consumeRestartNotice() {
  const notice = await readRestartNotice();
  if (notice) {
    await rm3(restartNoticePath(), { force: true }).catch(() => {
    });
  }
  return notice;
}
function pocketRestart(service) {
  const result = restartHost();
  if (!result || result.helperPid == null) return result;
  try {
    service?.stopTunnel({ keepAutoMarker: true });
  } catch {
  }
  writeRestartNotice().catch(() => {
  });
  return result;
}
function performUpdate(profile, { timeoutMs = 18e4 } = {}) {
  return new Promise((resolve) => {
    const child = spawn5("dsh", ["plugin", "--profile", profile, "update", "dsh-pocket", "--latest", "-w"], {
      stdio: ["ignore", "pipe", "pipe"],
      // Windows 上裸 spawn('dsh') 解析到无扩展名 POSIX shim → ENOENT；
      // Node 22+ 直接 spawn .cmd 会 EINVAL（CVE-2024-27980），必须走 shell（PR #54）
      shell: process.platform === "win32",
      // 宿主是 GUI 进程：不隐藏就会弹一个黑窗口出来（用户明确不要）
      windowsHide: true
    });
    let out = "";
    const onData = (c) => {
      out += String(c);
      if (out.length > 4e3) out = out.slice(-4e3);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.slice(-800) });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}
function apply(ctx, config = {}, internals = {}) {
  const logger = ctx.logger?.(name) ?? console;
  const dshPort = internals.dshPort ?? ctx.webServer?.port;
  if (!dshPort) {
    logger.error("dsh-pocket: webServer port unavailable \u2014 cannot start proxy | \u62FF\u4E0D\u5230 dsh web \u7AEF\u53E3\uFF0C\u65E0\u6CD5\u542F\u52A8\u4EE3\u7406");
    return () => {
    };
  }
  const pocketHome = (() => {
    const candidates = [
      internals.home,
      (() => {
        try {
          return ctx.get?.("profileContext")?.home;
        } catch {
          return void 0;
        }
      })(),
      process.env.DSH_HOME,
      join9(homedir5(), ".dsh")
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return join9(homedir5(), ".dsh");
  })();
  logger.info("dsh-pocket: home = %s | \u914D\u7F6E\u76EE\u5F55", pocketHome);
  const firstRun = ensureFirstRunSettings();
  if (firstRun) {
    logger.info("dsh-pocket: first run defaults written \u2014 \u5C40\u57DF\u7F51\u8BBF\u95EE\u9ED8\u8BA4\u5173\u95ED\uFF0C\u8BBE\u7F6E\u9875\u91CC\u5F00\u4E00\u4E0B\u624D\u626B\u7801 (settings.json) | \u9996\u542F\u5B89\u5168\u9ED8\u8BA4");
  } else {
    logger.info(`dsh-pocket: lanEnabled = ${lanEnabled() ? "on" : "off"} | \u5C40\u57DF\u7F51\u8BBF\u95EE\u72B6\u6001`);
  }
  const cfPath = cloudflaredPath();
  if (cfPath) {
    process.env.DSH_POCKET_CLOUDFLARED = cfPath;
    logger.info(`dsh-pocket: using custom cloudflared at ${cfPath} (skipping auto-download) | \u4F7F\u7528\u81EA\u5B9A\u4E49 cloudflared \u8DEF\u5F84\uFF08\u8DF3\u8FC7\u81EA\u52A8\u4E0B\u8F7D\uFF09`);
  }
  const isDesktop = internals.isDesktop !== void 0 ? internals.isDesktop === true : !!process.versions.electron || ctx.get?.("desktopProfiles") !== void 0 || ctx.get?.("desktopPnpm") !== void 0;
  if (isDesktop) {
    logger.info("dsh-pocket: DSH Desktop detected \u2014 update/restart disabled here | \u68C0\u6D4B\u5230\u684C\u9762\u7AEF\u73AF\u5883\uFF0C\u66F4\u65B0/\u91CD\u542F\u5DF2\u5173\u95ED");
  }
  const desktopAdvanced = isDesktop && (() => {
    try {
      const raw = readFileSync5(join9(process.env.DSH_HOME ?? join9(homedir5(), ".dsh"), "settings.yaml"), "utf8");
      return /dsh-plugin-desktop\s*:\s*[\s\S]{0,300}?mode\s*:\s*advanced/i.test(raw);
    } catch {
      return false;
    }
  })();
  if (desktopAdvanced) {
    logger.warn("dsh-pocket: DSH Desktop advanced mode \u2014 phone access unsupported, injecting notice | \u684C\u9762\u7AEF advanced \u6A21\u5F0F\uFF1A\u624B\u673A\u8BBF\u95EE\u6682\u4E0D\u652F\u6301\uFF0C\u5DF2\u6CE8\u5165\u63D0\u793A");
  }
  let tihuRuntime = null;
  try {
    tihuRuntime = createTihuRuntime(ctx, {
      log: (line) => {
        try {
          (logger.info ?? logger.log).call(logger, line);
        } catch {
        }
      },
      workspaceOf: (sessionId) => {
        try {
          const cwd = ctx.sessions?.get?.(sessionId)?.header?.cwd;
          return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
        } catch {
          return void 0;
        }
      },
      tts: { prewarm: false }
    });
    logger.info("dsh-pocket: tihu lane ready at /tihu (P0 simulator) | \u9E48\u9E55\u6A21\u62DF\u8BBE\u5907\u9875\u5DF2\u6302\u8F7D");
  } catch (error) {
    logger.warn("dsh-pocket: tihu lane disabled | \u9E48\u9E55 lane \u6302\u8F7D\u5931\u8D25: %s", error?.stack ?? error);
  }
  const runtime = internals.service ? null : acquirePocketRuntime(runtimeRevision, () => createPocketService({
    dshPort,
    // 端口（issue #70）：插件模式优先级 settings.proxyPort > cordis patch config.port > 3081。
    // 3081 被占时 createPocketService 内部 EADDRINUSE 抛错，按 DSH 插件启动失败处理（用户改端口重启即可）。
    port: internals.port ?? config.port ?? (proxyPort() || 3081),
    home: pocketHome,
    internals,
    // 鹈鹕（tihu）：页面与 lane 复用本代理的 token/cookie 鉴权
    ...tihuRuntime ? { tihu: tihuRuntime } : {},
    getLanIpOverride: () => lanIpOverride(),
    getLanEnabled: () => lanEnabled(),
    // 桌面端**不再**注入 dsh-desktop-* 标记（issue #76）：
    //   - 旧版 dsh-plugin-desktop 缺 mode/platform 会抛错，当初正是为此加了补丁（issue #3/#4）；
    //   - 但 2.0.3 起，mode 与 platform **同时缺失**时 parseDesktopClientEnvironment 直接返回
    //     undefined（视作非桌面外壳，跳过全部桌面逻辑），正是手机页需要的效果；
    //   - 反之只要 URL 上出现任一 dsh-desktop-* 标记，客户端就会强制校验整组
    //     （material + semver version + mica），只补两个必然抛 "invalid or missing
    //     dsh-desktop-material" → 插件树加载失败 → 页面变成「打开恢复模式」；
    //   - 更糟的是 decideDesktopBrowserAccess 见到 dsh-desktop-* 前缀就把没有渲染器 token 的
    //     普通浏览器判为 denied（403），刷新后直接打不开。
    // 结论：手机/浏览器访问一律不带这些标记，advanced 模式另加警告覆盖层（issue #19）。
    injectHtml: isDesktop ? DEFAULT_INJECT + (desktopAdvanced ? advancedNoticeScript() : "") : void 0,
    // 访问密码（issue #13 + #18 + #24 + #33 + #66）：公网永远要密码（默认每次开启变新，
    // 用户自定义后不再轮换）；局域网按开关（默认开启；关闭后局域网扫码直连）。
    // 公网的判定是 fail closed：除了 loopback/私网 Host，一切陌生域名（含自建
    // 命名隧道的固定域名）都按公网处理、强制公网密码。
    auth: {
      // 安装级 sessionKey：HMR / DSH 重启不再让手机重新登录；PIN 修改仍会使 cookie 失效。
      sessionKey: getPocketSessionKey(pocketHome),
      getToken: (host) => tokenForHost(host),
      isProtected: (host) => {
        if (isLanOverrideHost(host)) return lanAuthEnabled();
        return classifyHost(host) === "public" ? true : lanAuthEnabled();
      }
    },
    // dsh web 浏览器会话启动 token（issue #77）：新版 dsh（>= 0.1.2-alpha.1）要求根路径
    // 带一次 `?token=` 换 cookie，否则 /api 与 WebSocket 全 401。token 每次进程启动都变，
    // 所以每次请求实时从 connection 服务取；老版本没有这个方法 → 返回空，行为不变。
    launchToken: () => {
      try {
        const fn = ctx.connection?.authenticatedUrl;
        if (typeof fn !== "function") return "";
        const url = new URL(fn.call(ctx.connection, `http://127.0.0.1:${dshPort}`));
        return url.searchParams.get("token") ?? "";
      } catch {
        return "";
      }
    },
    // 隧道模式（issue #66）：'quick'（默认，随机 trycloudflare.com）| 'named'（固定域名）
    getTunnelConfig: () => ({ mode: tunnelMode(), token: tunnelToken(), hostname: tunnelHostname() }),
    // 固定公网地址（SSH 反向隧道，2026-10-18）：代理就绪后由 service 自动拉起，
    // 每次启动/探活都重读 settings，零窗口、断线自动重连。
    getSshTunnelConfig: () => sshTunnelConfig(),
    // 让 service 的日志走宿主 logger（否则隧道排障信息只进 stdout，桌面端看不到）
    log: logger,
    // 隧道就绪回调：快速模式每次开启轮换 8 位密码（旧链接作废）；命名模式地址固定，
    // 不自动轮换（重启后密码不变，用户可用「自定义密码」主动更换）。
    onTunnelReady: (mode) => {
      if (mode === "named") {
        logger.info("dsh-pocket: named tunnel ready \u2014 PIN not rotated | \u547D\u540D\u96A7\u9053\u5C31\u7EEA\uFF08\u516C\u7F51\u5BC6\u7801\u4E0D\u81EA\u52A8\u8F6E\u6362\uFF09");
        return getAccessToken();
      }
      const fresh = rotateAccessToken();
      logger.info("dsh-pocket: public access PIN refreshed | \u516C\u7F51\u8BBF\u95EE\u5BC6\u7801\u5DF2\u66F4\u65B0\uFF08\u81EA\u5B9A\u4E49\u5BC6\u7801\u4E0D\u53D7\u5F71\u54CD\uFF09");
      return fresh;
    }
  }));
  const service = internals.service ?? runtime.service;
  const disposers = [];
  if (tihuRuntime) disposers.push(() => tihuRuntime?.dispose());
  const disposeRpc = installPocketRpc(ctx, {
    service,
    desktop: isDesktop,
    getToken: () => getAccessToken(),
    getLanToken: () => getLanToken(),
    refreshLanToken: () => refreshLanToken(),
    getLanAuthEnabled: () => lanAuthEnabled(),
    setLanAuthEnabled: (on) => setLanAuthEnabled(on),
    getLanEnabled: () => lanEnabled(),
    setLanEnabled: (on) => setLanEnabled(on),
    getLanIpOverride: () => lanIpOverride(),
    setLanIpOverride: (ip) => setLanIpOverride(ip),
    getPinCustom: (which) => pinCustom(which),
    setCustomPin: (which, value) => setCustomPin(which, value),
    // 命名隧道配置（issue #66）：RPC 只回显脱敏视图（token 只写不读）
    getTunnelConfig: () => ({ mode: tunnelMode(), hostname: tunnelHostname(), tokenSet: tunnelToken().length > 0 }),
    // 恢复出厂设置：清空设置文件 + 重设随机密码（RPC 层已先停掉公网隧道）
    resetPocket: () => resetPocketState(),
    setTunnelConfig: ({ mode, hostname, token } = {}) => {
      const m = mode === void 0 ? tunnelMode() : mode;
      if (m !== "quick" && m !== "named") throw new Error("\u672A\u77E5\u96A7\u9053\u6A21\u5F0F | unknown tunnel mode");
      setTunnelMode(m);
      if (hostname !== void 0) setTunnelHostname(hostname);
      if (token !== void 0) setTunnelToken(token);
      return { mode: tunnelMode(), hostname: tunnelHostname(), tokenSet: tunnelToken().length > 0 };
    },
    runUpdate: internals.runUpdate ?? { currentVersion, perform: performUpdate, loadedVersion: () => loadedVersion },
    restart: internals.restart ?? (() => pocketRestart(service)),
    restartNotice: internals.restartNotice ?? consumeRestartNotice,
    // 固定公网地址开关：持久化到 settings.json + 立即生效（开启→按最新配置重启守护）
    setSshTunnelEnabled: (on) => {
      const cfg = setSshTunnelConfig({ enabled: on === true });
      if (cfg.enabled) void service.restartFixedTunnel?.().catch(() => {
      });
      else service.stopFixedTunnel?.();
      return cfg;
    },
    // 六项连接配置（P0-4）：设置页「固定公网地址 → 编辑连接」写回；改完按新配置生效。
    setSshTunnelConfig: (patch) => {
      const input = patch && typeof patch === "object" ? { ...patch } : {};
      if (input.keyPath === void 0) delete input.keyPath;
      for (const key of ["port", "remotePort", "localPort"]) {
        if (input[key] === void 0) continue;
        const n = Number(input[key]);
        if (Number.isFinite(n)) input[key] = n;
        else delete input[key];
      }
      const cfg = setSshTunnelConfig(input);
      if (cfg.enabled) void service.restartFixedTunnel?.().catch(() => {
      });
      return cfg;
    },
    // 立即重连：走 restart()——先探活收养外部健康隧道，再清本机残留 + 远端旧占用，最后新建；
    // 同时重置退避与「连续自动清理」计数（用户主动点 = 给一轮新的自愈预算）。
    reconnectSshTunnel: () => service.restartFixedTunnel?.() ?? Promise.resolve(),
    log: logger
  });
  disposers.push(disposeRpc);
  void service.startProxy().then((proxy) => {
    logger.info("dsh-pocket: proxy ready on :%d | \u5C40\u57DF\u7F51\u4EE3\u7406\u5DF2\u5C31\u7EEA", proxy.port);
    void service.restoreTunnelIfNeeded?.().catch(() => {
    });
  }).catch((err) => {
    logger.error("dsh-pocket: proxy start failed | \u4EE3\u7406\u542F\u52A8\u5931\u8D25: %s", err?.message ?? err);
  });
  ctx.effect(() => async () => {
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {
      }
    }
    if (runtime) releasePocketRuntime(runtime);
    else await service.dispose();
  }, "dsh-pocket: release runtime (graceful HMR handoff)");
}
export {
  apply,
  consumeRestartNotice,
  inject,
  name,
  readRestartNotice
};
