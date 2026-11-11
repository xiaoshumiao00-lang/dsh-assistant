// src/pocket-host/index.js
import { fileURLToPath } from "node:url";
import { spawn as spawn5 } from "node:child_process";
import { readFileSync as readFileSync12, mkdirSync as mkdirSync11, writeFileSync as writeFileSync9 } from "node:fs";
import { writeFile as writeFile3, readFile as readFile3, mkdir as mkdir4, rm as rm3 } from "node:fs/promises";
import { join as join16, dirname as dirname10 } from "node:path";
import { homedir as homedir13 } from "node:os";
import { randomBytes as randomBytes2, randomInt, createHash as createHash5 } from "node:crypto";

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
  const dshHome3 = home ?? process.env.DSH_HOME ?? join2(homedir2(), ".dsh");
  const cacheDir = join2(dshHome3, "dsh-pocket", "bin");
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
import { createHash as createHash4, randomUUID } from "node:crypto";
import { appendFileSync as appendFileSync4, existsSync as existsSync10, mkdirSync as mkdirSync9, readFileSync as readFileSync10, statSync as statSync7, writeFileSync as writeFileSync7 } from "node:fs";
import { homedir as homedir11 } from "node:os";
import { dirname as dirname8, isAbsolute as isAbsolute3, join as join14 } from "node:path";

// src/tihu/protocol.ts
var TIHU_PROTOCOL_VERSION = "0";
var SCREEN_BOUNDS = { widthPx: 320, heightPx: 240 };
function clampCoord(value, max) {
  return Math.max(0, Math.min(max, Math.round(value)));
}
var TIHU_UPSTREAM_TYPES = [
  "hello",
  "audio.frame",
  "text.input",
  "session.end",
  "screen.gesture",
  "voice.list",
  "voice.create",
  "voice.select",
  "tts.sample",
  "task.reply",
  "device.ack",
  "playback.state",
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
      case "session.end": {
        if (payload.sessionId !== void 0 && (typeof payload.sessionId !== "string" || payload.sessionId.length > 256)) return null;
        if (payload.reason !== void 0 && typeof payload.reason !== "string") return null;
        return value;
      }
      case "voice.list":
        return value;
      case "tts.sample": {
        if (payload.text !== void 0) {
          if (typeof payload.text !== "string" || payload.text.length > 200) return null;
        }
        return value;
      }
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
          if (payload.hit !== void 0 && payload.hit !== "screen" && payload.hit !== "action" && payload.hit !== "task") return null;
          if (payload.actionId !== void 0 && (typeof payload.actionId !== "string" || payload.actionId.length > 32)) return null;
          if (payload.taskId !== void 0 && (typeof payload.taskId !== "string" || payload.taskId.length > 64)) return null;
          return {
            ...value,
            payload: {
              ...payload,
              x: clampCoord(payload.x, SCREEN_BOUNDS.widthPx),
              y: clampCoord(payload.y, SCREEN_BOUNDS.heightPx)
            }
          };
        }
        return null;
      }
      case "task.reply": {
        if (payload.taskId !== void 0 && (typeof payload.taskId !== "string" || payload.taskId.length > 64)) return null;
        if (payload.optionIndex !== void 0) {
          if (typeof payload.optionIndex !== "number" || !Number.isSafeInteger(payload.optionIndex)) return null;
          if (payload.optionIndex < 0 || payload.optionIndex > 8) return null;
        }
        if (payload.text !== void 0 && (typeof payload.text !== "string" || payload.text.length > TIHU_MAX_TEXT_CHARS)) return null;
        if (payload.optionText !== void 0 && (typeof payload.optionText !== "string" || payload.optionText.length > 200)) return null;
        if (payload.command !== void 0 && payload.command !== "open" && payload.command !== "board" && payload.command !== "cancel" && payload.command !== "stop") return null;
        if (payload.optionIndex === void 0 && payload.optionText === void 0 && payload.text === void 0 && payload.command === void 0) return null;
        return value;
      }
      case "device.ack": {
        if (typeof payload.opId !== "string" || payload.opId === "" || payload.opId.length > 200) return null;
        if (typeof payload.ok !== "boolean") return null;
        if (payload.reason !== void 0 && (typeof payload.reason !== "string" || payload.reason.length > 200)) return null;
        if (payload.duplicate !== void 0 && typeof payload.duplicate !== "boolean") return null;
        if (payload.stage !== void 0 && (typeof payload.stage !== "string" || payload.stage.length > 120)) return null;
        if (payload.screenVersion !== void 0 && (typeof payload.screenVersion !== "number" || !Number.isFinite(payload.screenVersion))) return null;
        if (payload.listening !== void 0 && typeof payload.listening !== "boolean") return null;
        return value;
      }
      case "playback.state": {
        if (payload.phase !== "idle" && payload.phase !== "playing" && payload.phase !== "paused" && payload.phase !== "listening") return null;
        if (payload.taskId !== void 0 && (typeof payload.taskId !== "string" || payload.taskId.length > 64)) return null;
        for (const key of ["segment", "line", "total", "charStart", "at"]) {
          const field = payload[key];
          if (field !== void 0 && (typeof field !== "number" || !Number.isFinite(field))) return null;
        }
        return value;
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
    const window2 = rest.slice(0, perSegment);
    const match = window2.match(/^[\s\S]*[。！？；!?;]/);
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
  /** 统计行（第四行）字号：比正文小 2 号。 */
  statsFontPx: 14,
  /** 统计行行高。 */
  statsLineHeightPx: 18,
  /** 标题字号（加粗）。 */
  titleFontPx: 18,
  /** 标题最大字符数。 */
  titleChars: 28,
  /** stage 小字字号。 */
  stageFontPx: 12,
  /** stage 最大字符数。 */
  stageChars: 10,
  /** reply 模式：可视正文行数（16px/20px 行高；正文区固定预留一行安全高度后 7 行，见 REPLY_LAYOUT）。 */
  replyVisibleLines: 7,
  /** 棋盘一次显示几行（BOARD_PAGE_SIZE 必须同步；4 行 ×48px 才放得下两行字且不裁切）。 */
  boardRows: 4,
  /** 棋盘一行高度（20px 标题行 + 16px 副行 + 上下各 6px 内边距）。 */
  boardRowHeightPx: 48
};
var DONE_TITLE_FONT_PX = 20;
var DONE_TITLE_LINE_HEIGHT_PX = 22;
var DONE_LAYOUT = {
  stageHeightPx: 14,
  titleHeightPx: 22,
  titleFontPx: DONE_TITLE_FONT_PX,
  titleLineHeightPx: DONE_TITLE_LINE_HEIGHT_PX,
  /** 字号 15px、行高 20px，正文区 (222−14−2−22−2−4−30−3)=145 内最多 7 整行。 */
  visibleLines: 7,
  lineHeightPx: 20,
  /** 正文区（标题下沿 → 动作条上沿）的剩余高度。 */
  bodyHeightPx: 145,
  actionBarHeightPx: 30,
  /** done-view 内部（顶栏↔标题、标题↔正文）的缝。 */
  columnGapPx: 2,
  /** #screen 本身的列间隙（正文区↔动作条）。 */
  screenGapPx: 4,
  /** 动作条底边到屏幕外沿的留白（用户要求 12px）。 */
  bottomInsetPx: 12,
  /** 动作条 margin-bottom = 12 − 8 内边距 − 1 边框。 */
  actionBarMarginBottomPx: 3,
  /** 14 + 2 + 22 + 2 + 145 + 4 + 30 + 3 = 222。 */
  usedHeightPx: 222
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
var TEXT_WRAP_SAFETY_PX = 4;
var PENDING_RAIL_WIDTH_PX = 240;
var REPLY_STAGE_HEIGHT_PX = 14;
var REPLY_ACTION_BAR_HEIGHT_PX = 32;
var REPLY_COLUMN_GAP_PX = 4;
var REPLY_CONTENT_HEIGHT_PX = SCREEN_SPEC.heightPx - SCREEN_SPEC.paddingPx * 2;
var REPLY_BODY_HEIGHT_PX = REPLY_CONTENT_HEIGHT_PX - REPLY_STAGE_HEIGHT_PX - REPLY_ACTION_BAR_HEIGHT_PX - REPLY_COLUMN_GAP_PX * 2;
var REPLY_LINE_HEIGHT_PX = SCREEN_SPEC.bodyLineHeightPx;
var REPLY_SAFE_LINE_PX = SCREEN_SPEC.bodyLineHeightPx;
var REPLY_VISIBLE_LINES = Math.floor((REPLY_BODY_HEIGHT_PX - REPLY_SAFE_LINE_PX) / REPLY_LINE_HEIGHT_PX);
var REPLY_LAYOUT = {
  contentHeightPx: REPLY_CONTENT_HEIGHT_PX,
  stageHeightPx: REPLY_STAGE_HEIGHT_PX,
  actionBarHeightPx: REPLY_ACTION_BAR_HEIGHT_PX,
  columnGapPx: REPLY_COLUMN_GAP_PX,
  bodyHeightPx: REPLY_BODY_HEIGHT_PX,
  lineHeightPx: REPLY_LINE_HEIGHT_PX,
  safeLinePx: REPLY_SAFE_LINE_PX,
  visibleLines: REPLY_VISIBLE_LINES,
  usedHeightPx: REPLY_VISIBLE_LINES * REPLY_LINE_HEIGHT_PX,
  bottomFreePx: REPLY_BODY_HEIGHT_PX - REPLY_VISIBLE_LINES * REPLY_LINE_HEIGHT_PX,
  /** 有气泡轨时的正文宽（240）与轨宽（64）：两者相加不得超过内容宽。 */
  railBodyWidthPx: PENDING_RAIL_WIDTH_PX,
  railWidthPx: 64,
  /** 无轨正文宽（304）。 */
  plainBodyWidthPx: CONTENT_WIDTH_PX
};
var TITLE_BOLD_FACTOR = 1.06;
function charWidthEm(char) {
  const code = char.codePointAt(0) ?? 0;
  const wide = code >= 4352 && code <= 4447 || code >= 11904 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65040 && code <= 65135 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 127744 && code <= 129791;
  if (wide) return 1;
  if (char === " ") return 0.26;
  if (char >= "0" && char <= "9") return 0.56;
  if (char >= "A" && char <= "Z") return 0.62;
  if (char >= "a" && char <= "z") return 0.5;
  if (".,:;!|'`()[]{}/\\-".includes(char)) return 0.32;
  if (char === "_" || char === "@" || char === "%" || char === "&" || char === "#") return 0.56;
  return 0.5;
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
  const limit = Math.max(1, maxWidthPx - TEXT_WRAP_SAFETY_PX);
  const lines = [];
  let current = "";
  let width = 0;
  for (const char of [...text]) {
    const charWidth = charWidthEm(char) * fontPx;
    if (current !== "" && width + charWidth > limit) {
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
function clipScreenTitle(value) {
  return fitLine(value, CONTENT_WIDTH_PX, SCREEN_SPEC.titleFontPx * TITLE_BOLD_FACTOR);
}
function fitScreenLines(lines, maxLines = SCREEN_SPEC.maxBodyLines) {
  const out = [];
  for (const line of lines) {
    for (const wrapped of wrapTextPx(line, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx)) {
      if (out.length >= maxLines) return out;
      out.push(wrapped);
    }
  }
  return out;
}

// src/client/pocket/orb/voice.ts
var TARGET_RATE = 16e3;
function condition(samples) {
  const length = samples.length;
  if (length === 0) return samples;
  let mean = 0;
  for (let i = 0; i < length; i += 1) mean += samples[i];
  mean /= length;
  const out = new Float32Array(length);
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const value = samples[i] - mean;
    out[i] = value;
    const abs = value < 0 ? -value : value;
    if (abs > peak) peak = abs;
  }
  const gain = peak > 1e-4 ? Math.min(0.95 / peak, 8) : 1;
  if (gain !== 1) {
    for (let i = 0; i < length; i += 1) {
      const value = out[i] * gain;
      out[i] = value > 1 ? 1 : value < -1 ? -1 : value;
    }
  }
  return out;
}
function trimSilence(samples) {
  const frameLen = Math.floor(TARGET_RATE * 0.02);
  const frames = Math.floor(samples.length / frameLen);
  if (frames < 5) return samples;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const base = f * frameLen;
    for (let i = base; i < base + frameLen; i += 1) sum += samples[i] * samples[i];
    rms[f] = Math.sqrt(sum / frameLen);
  }
  let maxR = 0;
  for (let f = 0; f < frames; f += 1) if (rms[f] > maxR) maxR = rms[f];
  const threshold = Math.max(6e-3, maxR * 0.05);
  let first = 0;
  while (first < frames && rms[first] < threshold) first += 1;
  let last = frames - 1;
  while (last > first && rms[last] < threshold) last -= 1;
  if (last <= first) return samples;
  const pad = Math.floor(0.15 * TARGET_RATE / frameLen);
  const startSample = Math.max(0, first - pad) * frameLen;
  const endSample = Math.min(samples.length, (last + 1 + pad) * frameLen);
  return endSample > startSample ? samples.subarray(startSample, endSample) : samples;
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
    outline:none;
    display:flex; flex-direction:column; gap:4px; }
  #screen:focus, #screen:focus-visible { outline:none; }
  #screen .stage { font-size:12px; line-height:14px; letter-spacing:1px; color:var(--accent);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen.alert { border-color:#000; }
  #screen.warn { border-color:#000; }
  #screen.warn .stage, #screen.warn .title { color:var(--warn); }
  #screen.ask-mode .cd-row, #screen.ask-mode .cd-track, #screen.ask-mode .cd-fill { display:none !important; }
  #screen.detail-mode .cd-row, #screen.detail-mode .cd-track, #screen.detail-mode .cd-fill { display:none !important; }
  /* \u5B8C\u6210\u64AD\u62A5\u7684\u6717\u8BFB\u6CE2\u5F62\uFF1A\u65B0\u5B8C\u6210\u9875\u5728\u9876\u680F\u91CC\u81EA\u5DF1\u753B\uFF08\u89C1 done-view\uFF09 */
  #screen.alert .title, #screen.alert .stage { color:var(--err); }
  /* \u9996\u9875\u6700\u4E0A\u65B9\u90A3\u4E00\u884C\uFF08\u7528\u6237 2026-11-08 \u786E\u8BA4\uFF09\uFF1A\u539F\u6765\u7684\u300C\u9879\u76EE N \u4E2A \xB7 \u7B2C x/y \u9875\u300D\u6574\u6BB5\u5220\u6389\uFF0C
     \u6362\u6210\u300C\u672C\u5730\u65F6\u949F HH:MM\u300D+\u300C\u4E09\u683C\u4FE1\u53F7\u67F1\u300D\u3002\u8FD9\u4E00\u884C\u5360\u6389 stage \u539F\u6765\u90A3\u4E00\u884C\u7684\u4F4D\u7F6E\uFF0812px/\u884C\u9AD8 14\uFF09\uFF0C
     \u603B\u9AD8\u5EA6\u4E0D\u53D8\uFF08\u5E95\u90E8\u7FFB\u9875\u6761\u5DF2\u5728 2026-11-09 \u5220\u9664\uFF09\u3002\u72B6\u6001\u5C4F\u7684 stage \u884C\u7167\u65E7\u3002
     \u4FE1\u53F7\u67F1\u662F\u7EAF CSS \u5185\u8054\u5143\u7D20\uFF08\u4E09\u6839 <span>\uFF0C\u9AD8\u5EA6\u9012\u589E\u3001\u5E95\u5BF9\u9F50\uFF09\uFF0C\u6CA1\u6709 emoji\u3001\u6CA1\u6709\u56FE\u7247\u3001\u6CA1\u6709\u5916\u90E8\u5B57\u4F53\u56FE\u6807\uFF1B
     \u65AD\u5F00\u53EA\u9760\u989C\u8272\uFF08\u7EA2\uFF09\u533A\u5206\uFF0C\u4E0D\u5199\u300C\u65AD\u5F00\u300D\u4E24\u4E2A\u5B57\u3002 */
  #screen .home-top { display:none; flex:none; align-items:flex-end; gap:8px; height:14px; box-sizing:border-box; }
  #screen.home-mode .home-top { display:flex; }
  #screen.home-mode .stage { display:none; }
  /* \u9876\u884C\u65F6\u949F\u6570\u5B57\u52A0\u7C97\uFF08\u7528\u6237 2026-11-08 \u672C\u8F6E\u8981\u6C42\uFF0C\u53EA\u52A0\u7C97\u8FD9\u4E00\u5904\uFF09\uFF1A\u5B57\u53F7 12px\u3001\u884C\u9AD8 14px\u3001\u989C\u8272\u3001\u4F4D\u7F6E\u3001
     \u4E09\u683C\u4FE1\u53F7\u67F1\u4E0E\u72B6\u6001\u5C4F\u7684 stage \u884C\u5168\u90E8\u7167\u65E7\uFF08\u5E95\u90E8\u7FFB\u9875\u6761\u5DF2\u5220\uFF09\u3002\u7C97\u4F53\u53EA\u628A\u5B57\u5F62\u6491\u5BBD\u7EA6 6%\uFF0812px/700 \u6BD4\u5E38\u89C4\u5BBD\uFF09\uFF0C
     HH:MM \u4E94\u4E2A\u5B57\u7B26\u52A0\u7C97\u540E\u5B9E\u6D4B\u7EA6 40px\uFF0C\u79BB\u53EF\u7528\u5BBD\u8FD8\u5DEE\u5F97\u8FDC\uFF08304 \u2212 \u884C\u95F4\u9699 8 \u2212 \u4FE1\u53F7\u67F1 19 = 277\uFF09\uFF0C
     \u6240\u4EE5\u8FD9\u4E00\u884C\u4E0D\u4F1A\u6362\u884C\u3001\u4E0D\u4F1A\u6EA2\u51FA\u3001\u4E5F\u4E0D\u4F1A\u88AB fitTextPx \u88C1\u6210\u7701\u7565\u53F7\uFF0C\u9876\u884C\u90A3\u5957\u5C3A\u5BF8\u5E38\u91CF\uFF08\u67F1\u5BBD 5\u3001\u67F1\u95F4\u9699 2\u3001\u884C\u95F4\u9699 8\uFF09\u4E0D\u7528\u52A8\u3002
   * \u8FD9\u6761\u89C4\u5219\u53EA\u4F5C\u7528\u5728 .clock \u4E0A\uFF08\u5C4F\u5185 .clock \u53EA\u6709 #homeClock \u8FD9\u4E00\u4E2A\u5143\u7D20\uFF09\u3002 */

  #screen .home-top .clock { font-size:12px; line-height:14px; letter-spacing:1px; color:var(--accent); font-weight:bold;
    font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; flex:none; }
  /* \u4E09\u683C\u4FE1\u53F7\u67F1\uFF1A3 \u6839 \xD75px + 2 \u4E2A\u95F4\u9699 \xD72px = 19px\uFF08\u9875\u9762 JS \u91CC HOME_TOP_* \u5E38\u91CF\u8981\u548C\u8FD9\u4E24\u4E2A\u6570\u5B57\u4E00\u81F4\uFF09\u3002 */
  #screen .home-top .signal { flex:none; margin-left:auto; display:flex; align-items:flex-end; gap:2px; height:13px; }
  #screen .home-top .home-counts { margin-left:auto; font-size:11px; line-height:14px; color:var(--dim); white-space:nowrap; }
  #screen.board-mode .home-top .signal { display:none; }
  #screen .home-top .signal .bar { display:block; width:5px; border-radius:1px; background:#6b7785; }
  #screen .home-top .signal .bar.b1 { height:5px; }
  #screen .home-top .signal .bar.b2 { height:9px; }
  #screen .home-top .signal .bar.b3 { height:13px; }
  #screen .home-top .signal.conn-online .bar { background:#35d07f; }            /* \u5DF2\u8FDE\u4E0A\u5BBF\u4E3B\uFF1A\u7EFF */
  #screen .home-top .signal.conn-connecting .bar { background:#6b7785; opacity:.55; } /* \u8FDE\u63A5\u4E2D / \u91CD\u8FDE\u4E2D\uFF1A\u7070\u3001\u67F1\u6761\u7A0D\u6DE1 */
  #screen .home-top .signal.conn-offline .bar { background:var(--err); }        /* \u65AD\u5F00\uFF1A\u7EA2\uFF08\u53EA\u6709\u989C\u8272\uFF09 */
  #screen .title { font-size:18px; font-weight:700; line-height:22px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen ul { margin:0; padding:0; list-style:none; font-size:16px; line-height:20px; color:#c3ccd5; }
  #screen ul li { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* \u72B6\u6001\u5C4F\u6B63\u6587\uFF1A\u6807\u9898\u4E00\u884C\u3001\u6B63\u6587\u6700\u591A 4 \u884C\uFF1B\u8FDB\u5EA6\u6761\u4E0E\u9876\u884C\u90FD\u8FDB\u4E0D\u4E86\u6B63\u6587\u533A\u3002 */
  #screen .home-body { display:none; flex:1; overflow:hidden; }
  #screen.home-mode .home-body { display:block; }
  #screen.home-mode .title, #screen.home-mode ul,
  #screen.home-mode .action-bar { display:none; }
  /* \u65E7\u5F0F\u7FFB\u9875\u6761\u5DF2\u6574\u4F53\u5220\u9664\uFF08\u7528\u6237 2026-11-09\uFF1A\u8BBE\u5907\u5C4F\u4E0D\u8981\u7FFB\u9875\u63A7\u4EF6\uFF09\u3002
     \u68CB\u76D8\u56FA\u5B9A\u6700\u591A 4 \u6761\uFF08BOARD_PAGE_SIZE\uFF09\uFF1A\u9876\u884C 14 + \u95F4\u9699 4 + 4\xD748 = 210 \u2264 222\uFF0C\u56DB\u884C\u90FD\u5B8C\u6574\u3002 */
  /* \u72B6\u6001\u5C4F/\u56DE\u6267/\u5B8C\u6210\u5C4F\u7684\u5E95\u90E8\u52A8\u4F5C\u6761 */
  #screen .action-bar { display:none; flex:none; gap:6px; padding-top:4px; }
  #screen.has-actions .action-bar { display:flex; }
  #screen .action-bar button { flex:1; min-width:0; min-height:28px; padding:0 2px; white-space:nowrap;
    border-radius:6px; border:1px solid #33414f; background:#1b2430; color:#d9e2ea; font-size:13px; }
  /* \u6309\u94AE\u591A\u4E8E 3 \u4E2A\u65F6\u6536\u5C0F\u4E00\u53F7\u5B57\u53F7\uFF1A304px \u5185\u4E0D\u6362\u884C\u4E0D\u6EA2\u51FA */
  #screen .action-bar.many button { font-size:11px; }
  #screen .action-bar button:active { background:#2c3d4e; }

  #screen .tap-flash { position:absolute; width:28px; height:28px; margin:-14px 0 0 -14px; border-radius:50%;
    background:rgba(255,255,255,.35); pointer-events:none; z-index:5; animation:tapFlash .18s ease-out forwards; }
  @keyframes tapFlash { from { opacity:.8; transform:scale(.4); } to { opacity:0; transform:scale(1.4); } }

  /* \u2500\u2500 \u4EFB\u52A1\u68CB\u76D8\uFF08\u5C4F 1\uFF0C2026-11-09 \u7EDF\u4E00\u6307\u6325\u4F1A\u8BDD\uFF09\u2500\u2500
     \u9876\u884C 14 + \u95F4\u9699 4 + \u6BCF\u9875\u6700\u591A 4 \u884C\u4EFB\u52A1 + \u5E95\u90E8\u7FFB\u9875\u6761 12\uFF082026-11-10 \u7528\u6237\u660E\u786E\u8981\u56DE\u6765\uFF09\uFF1A
     \u5185\u5BB9\u9AD8 222 = \u9876\u884C 14 + \u95F4\u9699 4 + 4\xD748\uFF08\u6BCF\u884C 20px \u6807\u9898 + 16px \u526F\u884C + \u4E0A\u4E0B 6px\uFF09+ \u7FFB\u9875\u6761 12\u3002
     \u7FFB\u9875\u6761\u53EA\u6709\u4E00\u9875\u65F6 JS \u76F4\u63A5\u4E0D\u5EFA\uFF0C\u4EC0\u4E48\u90FD\u4E0D\u663E\u793A\u3002 */
  #screen.board-mode .home-top { display:flex; }
  #screen.board-mode .stage, #screen.board-mode .title, #screen.board-mode ul,
  #screen.board-mode .action-bar { display:none; }
  /* \u68CB\u76D8\uFF1A\u5217\u8868\u533A\u5403\u6389\u7FFB\u9875\u6761\u4E0A\u65B9\u7684\u5168\u90E8\u9AD8\u5EA6\uFF0C\u7FFB\u9875\u6761**\u9489\u5728\u5C4F\u5E95**\uFF08\u7528\u6237 2026-11-10 \u5B9E\u673A\uFF1A
     \u7B2C 2 \u9875\u53EA\u6709 2 \u6761\u65F6\uFF0C\u7FFB\u9875\u680F\u8DDF\u7740\u5217\u8868\u5F80\u4E0A\u8DD1\uFF0C\u4F4D\u7F6E\u548C\u7B2C 1 \u9875\u4E0D\u4E00\u6837\uFF09\u3002
     \u9AD8\u5EA6\u9884\u7B97 222 = \u9876\u884C 14 + \u95F4\u9699 2 + \u5217\u8868\u533A\uFF084\xD748 = 192\uFF09+ \u7FFB\u9875\u6761 12 + \u5E95\u8FB9\u8DDD 2\u3002 */
  #screen.board-mode { gap:2px; }
  #screen.board-mode .home-body { display:flex; flex-direction:column; min-height:0; }
  #screen .board-list { flex:1 1 auto; min-height:0; overflow:hidden; }
  #screen .board-item { height:48px; box-sizing:border-box; padding:6px 0; overflow:hidden; }
  #screen .board-row1 { display:flex; align-items:center; gap:6px; font-size:15px; font-weight:700; line-height:20px; white-space:nowrap; overflow:hidden; }
  /* \u72B6\u6001\u80F6\u56CA\uFF1A\u6587\u5B57\u4F18\u5148\uFF08\u8272\u76F2/\u5F3A\u5149\u4E0B\u4E5F\u8BFB\u5F97\u51FA\uFF09\uFF0C\u989C\u8272\u53EA\u505A\u8F85\u52A9 */
  #screen .board-capsule { flex:none; font-size:11px; line-height:14px; font-weight:700; letter-spacing:.5px;
    padding:1px 5px; border-radius:4px; background:#1b2430; color:#9fb0c0; border:1px solid #2b3a4a; }
  #screen .board-capsule.running { color:#8ef0c4; border-color:#2a6b56; background:#10241e; }
  /* \u300C\u5DF2\u7ED1\u4F1A\u8BDD\u3001\u8FD8\u6CA1\u5F00\u8DD1\u300D\u4ECD\u5C5E\u6392\u961F\u4E2D\uFF1A\u4E0E queued \u540C\u4E00\u5957\u7070\uFF0C\u4E0D\u53E6\u9020\u300C\u6D3E\u5355\u300D\u8272 */
  #screen .board-capsule.dispatched { color:#9fb0c0; border-color:#2b3a4a; background:#1b2430; }
  #screen .board-capsule.awaiting { color:#f7d98a; border-color:#7a5c1f; background:#241d0f; }
  #screen .board-capsule.done { color:#a9c8ff; border-color:#2b4a7a; background:#101a2b; }
  #screen .board-capsule.announced { color:#93a9c4; border-color:#33465c; background:#111820; }
  /* \u5C4F 7 \u6B67\u4E49\u5019\u9009\u5361\uFF1A\u9879\u76EE\u540D + \u6765\u6E90\uFF08\u56FE 3\uFF09 */
  #screen .ask-card { display:flex; align-items:center; gap:7px; margin:4px 0; padding:5px 7px; border:1px solid #2b3a4a; border-radius:7px; background:#111a24; }
  #screen .ask-no { flex:none; width:15px; height:15px; border:1px solid #3fb6a8; border-radius:50%; color:#8ef0c4; font-size:10px; line-height:15px; text-align:center; }
  #screen .ask-main { min-width:0; display:flex; flex-direction:column; }
  #screen .ask-name { font-size:13px; font-weight:700; line-height:15px; color:#e6edf3; }
  #screen .ask-source { font-size:10px; line-height:12px; color:#9fb0c0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #screen .board-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  #screen .board-row2 { display:flex; align-items:center; gap:6px; font-size:12px; line-height:16px; color:#8b97a5; }
  #screen .board-sub { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  /* \u53F3\u4FA7\u72B6\u6001\u56FE\u5F62\uFF08\u7528\u6237 2026-11-10 \u5B9A\u6848\uFF0C\u4E0D\u518D\u7528 10px \u5B9E\u5FC3\u70B9\uFF09\uFF1A\u53F3\u5BF9\u9F50\u3001\u79BB\u5C4F\u5E55\u5916\u6CBF\u6B63\u597D 10px
     \uFF08#screen \u5185\u8FB9\u8DDD 8 + \u8FB9\u6846 1 \u2192 \u5185\u5BB9\u53F3\u754C 311\uFF1B\u56FE\u5F62\u5916\u8FB9\u8DDD 1 \u2192 \u53F3\u754C 310 \u2192 \u8DDD\u5916\u6CBF 10px\uFF09\u3002
     \u5B8C\u6210\uFF1D\u7EFF\u8272\u5B9E\u5FC3\u5706\uFF08\u76F4\u5F84 12px\uFF09\uFF1B\u5F85\u51B3\u7B56\uFF1D\u9EC4\u8272\u5706\u5F62\u91CC\u4E00\u4E2A\u95EE\u53F7\uFF1B
     \u8FDB\u884C\u4E2D\uFF1D\u84DD\u8272\u672A\u95ED\u5408\u5706\u73AF\uFF0C\u5F27\u957F\u6309\u300C\u5DF2\u8FD0\u884C\u65F6\u957F \xF7 30 \u5206\u949F\u300D\u753B\uFF0C\u8DD1\u6EE1\u540E\u505C\u5728\u6EE1\u5708\u5DEE\u4E00\u70B9\u7684\u90A3\u5708\uFF1B
     \u6392\u961F\uFF0F\u6D3E\u5355\uFF1D\u7070\u8272\u7EC6\u73AF\u3002\u90FD\u4E0D\u505A\u5927\u5706\u73AF\uFF0814\xD714 \u4EE5\u5185\uFF0C\u4E0D\u62A2\u884C\u9AD8\uFF09\u3002 */
  #screen .board-status { flex:none; width:14px; height:14px; box-sizing:border-box; margin-left:6px; margin-right:1px; }
  #screen .board-status.done, #screen .board-status.announced { width:12px; height:12px; border-radius:50%; background:#35d07f; }
  #screen .board-status.queued { width:12px; height:12px; border-radius:50%; background:none; border:1px solid #6f7d89; }
  #screen .board-status.dispatched { width:12px; height:12px; border-radius:50%; background:none; border:1px solid #6f7d89; }
  #screen .board-status.announced { background:#2fbf6b; }
  #screen .board-status.awaiting { width:14px; height:14px; border-radius:50%; background:var(--warn);
    color:#1b1305; font-size:11px; font-weight:700; line-height:14px; text-align:center; }
  #screen .board-status.running svg { display:block; width:14px; height:14px; }
  /* \u6709\u540E\u53F0\u5B50\u4EE3\u7406\u8FD8\u5728\u8DD1\uFF08\u7528\u6237 2026-11-10 \u5B9A\u6848\uFF09\uFF1A\u53F3\u4FA7\u72B6\u6001\u56FE\u6807\u6362\u6210\u84DD\u8272\u5B9E\u5FC3\u70B9\uFF0C
     1.2 \u79D2\u4E00\u6B21\u900F\u660E\u5EA6\u547C\u5438\uFF1B\u53EA\u6539 opacity\uFF0C\u4E0D\u505A transform\u3001\u4E0D\u6539\u5BBD\u9AD8\uFF08\u4E0D\u4F4D\u79FB\u3001\u4E0D\u6296\u884C\u9AD8\uFF09\uFF0C
     \u53F3\u5BF9\u9F50\u8FB9\u8DDD\u4ECD\u7531 .board-status \u7684 margin-right:1px \u4FDD\u8BC1\uFF08\u8DDD\u5C4F\u5E55\u5916\u6CBF 10px \u4E0D\u53D8\uFF09\u3002
     \u5B50\u4EE3\u7406\u5168\u7ED3\u675F\u540E childRunning \u6E05\u96F6\uFF0C\u5361\u7247\u81EA\u52A8\u56DE\u5230\u7EFF\u8272\u5B9E\u5FC3\u5706\u300C\u5B8C\u6210\u300D\u3002 */
  #screen .board-status.subagents { width:12px; height:12px; border-radius:50%; background:#4f9fd8;
    animation:boardBreath 1.2s ease-in-out infinite; }
  @keyframes boardBreath { 0%, 100% { opacity:.35; } 50% { opacity:1; } }
  /* \u7FFB\u9875\u6761\uFF1A\u4E0A\u4E00\u9875 / \u7B2C N/M \u9875 / \u4E0B\u4E00\u9875\uFF08\u53EA\u6709\u4E00\u9875\u65F6 JS \u4E0D\u5EFA\u8FD9\u6761\uFF09\u3002
     \u9489\u5728\u5C4F\u5E95\uFF1Aflex:none + margin-bottom:2px \u2192 \u6761\u5E95\u8FB9\u79BB\u5C4F\u5E55\u5916\u6CBF 8+1+2 = 11px\uFF08\u7528\u6237\u8981\u6C42 10\u201312px\uFF09\uFF0C
     \u4E0D\u7BA1\u8FD9\u4E00\u9875\u5269 4 \u6761\u8FD8\u662F 1 \u6761\uFF0C\u5B83\u90FD\u5728\u540C\u4E00\u4E2A\u4F4D\u7F6E\u3002 */
  #screen .board-pager { display:flex; flex:none; align-items:center; justify-content:center; gap:8px;
    height:12px; margin-bottom:2px; }
  #screen .board-pager button { border:0; background:none; padding:0; color:#9fb0c0; font-size:11px; line-height:12px; }
  #screen .board-pager button.cur { color:#5FD2C8; font-weight:700; }
  #screen .board-pager button.off { color:#48525d; }
  #screen .board-pager .page { font-size:11px; line-height:12px; color:#c8d4dd; }
  /* \u5FAE\u6761\uFF1A\u6700\u8FD1 8 \u6B65\u8017\u65F6\uFF08\u53EA\u7ED9\u8282\u594F\u611F\uFF0C\u4E0D\u663E\u793A\u6570\u5B57\uFF09 */
  #screen .board-micro { display:flex; flex:none; align-items:flex-end; gap:2px; height:10px; margin-left:2px; }
  #screen .board-micro span { width:2px; min-height:2px; background:#3fb6a8; border-radius:1px; opacity:.85; }
  /* \u7A7A\u6001\uFF1A\u6CA1\u6709\u4EFB\u52A1\u65F6\u662F\u540C\u4E00\u5F20\u68CB\u76D8\u7684\u53E6\u4E00\u79CD\u8138\uFF08\u4E0D\u662F\u53E6\u5F00\u4E00\u5C4F\uFF09 */
  #screen .board-empty { display:flex; flex-direction:column; align-items:center; justify-content:center;
    height:100%; gap:5px; text-align:center; }
  #screen .board-empty .wave { display:flex; align-items:center; gap:3px; height:20px; }
  #screen .board-empty .wave span { display:block; width:3px; height:20px; border-radius:2px; background:var(--accent);
    animation:wavePulse 1.1s ease-in-out infinite; transform-origin:center; }
  #screen .board-empty .wave span:nth-child(2) { animation-delay:.12s; }
  #screen .board-empty .wave span:nth-child(3) { animation-delay:.24s; }
  #screen .board-empty .wave span:nth-child(4) { animation-delay:.36s; }
  #screen .board-empty .wave span:nth-child(5) { animation-delay:.48s; }
  @keyframes wavePulse { 0%,100% { transform:scaleY(.28); } 50% { transform:scaleY(1); } }
  #screen .board-empty .l1 { font-size:17px; font-weight:700; line-height:20px; }
  #screen .board-empty .l2 { font-size:12px; line-height:16px; color:#9fb0c0; }
  #screen .board-empty .l3 { font-size:12px; line-height:16px; color:#6f7d8b; }
  /* \u2500\u2500 \u5B8C\u6210\u9875\uFF08\u53C2\u8003\u56FE\uFF09\uFF1A\u9876\u680F 14 + \u6807\u9898 22 + \u6B63\u6587\u533A\uFF08\u5269\u4F59\u9AD8\u5EA6\uFF09+ \u4E09\u952E 30 \u2500\u2500
     \u9876\u680F\uFF1A\u5DE6\u300C\u5B8C\u6210\u300D\uFF08\u9752\u3001\u4E0D\u52A0\u7C97\uFF09\uFF0F\u4E2D\u6CE2\u5F62\uFF087 \u6839\u7AD6\u6761\uFF09\uFF0F\u53F3\u300C\u53E6\u6709 N \u6761\u300D\uFF08\u7070\uFF09\uFF0F\u6700\u53F3 \u25B6\uFF08\u9752\uFF09\u3002
     \u6B63\u6587\uFF1A15px/20px\uFF0C\u5F53\u524D\u6717\u8BFB\u884C\u6574\u884C\u94FA\u9752\u5E95\u3001\u9ED1\u5B57\u52A0\u7C97\uFF0C\u5DE6\u53F3\u5404\u7559 8px\uFF0C\u884C\u9996\u4E0D\u7559\u4EFB\u4F55\u56FE\u6807\u3002
     \u5927\u6807\u9898 2026-11-10 \u7528\u6237\u8981\u6C42\u51CF 2 \u53F7\uFF0822px \u2192 20px\uFF0C\u884C\u9AD8 24 \u2192 22\uFF09\u3002
     2026-11-10 \u7B2C\u4E8C\u7248\u7528\u6237\u5B9E\u673A\u8981\u6C42\uFF1A\u6807\u9898/\u6B63\u6587**\u8D34\u9876**\uFF0C\u4E09\u952E**\u56FA\u5B9A\u8D34\u5728\u5C4F\u5E55\u5E95\u90E8**
     \uFF08\u952E\u5E95\u8FB9\u79BB\u5C4F\u5E55\u5916\u6CBF 12px\uFF09\uFF1B\u6B63\u6587\u533A\u5403\u6389\u6807\u9898\u4E0E\u6309\u94AE\u4E4B\u95F4\u7684\u5168\u90E8\u5269\u4F59\u9AD8\u5EA6\uFF0C
     \u7A7A\u51FA\u6765\u7684\u5730\u65B9\u7559\u5728**\u6B63\u6587\u4E0E\u6309\u94AE\u4E4B\u95F4**\uFF0C\u4E0D\u518D\u5806\u5728\u6309\u94AE\u4E0B\u9762\u3002\u884C\u591A\u65F6\u6B63\u6587\u533A\u6309\u5269\u4F59\u9AD8\u5EA6
     \u88C1\u526A/\u6EDA\u52A8\uFF087 \u884C 140 \u2264 145 \u5168\u653E\u5F97\u4E0B\uFF09\uFF0C\u6B63\u6587\u4E0E\u6309\u94AE\u6C38\u4E0D\u91CD\u53E0\u3002
     \u9AD8\u5EA6\u9884\u7B97\uFF1A14 + 2 + 22 + 2 + 145 \u6B63\u6587\u533A + 4 \u5217\u95F4\u9699 + 30 \u4E09\u952E + 3 margin = 222
     \uFF08\u5185\u5BB9\u9AD8 240\u22122\xD78\u22122\xD71\uFF09\u3002\u300C12px \u5E95\u8FB9\u300D= 3px margin + 8px \u5185\u8FB9\u8DDD + 1px \u8FB9\u6846\u3002 */
  #screen .done-view { display:none; flex:1 1 auto; min-height:0; overflow:hidden; flex-direction:column; gap:2px; }
  #screen.done-mode .done-view { display:flex; }
  #screen.done-mode .home-top, #screen.done-mode .stage, #screen.done-mode .title,
  #screen.done-mode ul, #screen.done-mode .steps,
  #screen.done-mode .cd-row, #screen.done-mode .home-body { display:none; }
  #screen .done-bar { position:relative; flex:none; height:14px; display:flex; align-items:center; gap:6px; }
  #screen .done-stage { flex:none; font-size:11px; line-height:14px; color:#5FD2C8; font-weight:400; }
  #screen .done-wave { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:flex; align-items:center; gap:2px; height:14px; }
  #screen .done-wave span { display:block; width:2px; height:5px; border-radius:1px; background:#5FD2C8; animation:doneBarWave .9s ease-in-out infinite; }
  #screen .done-wave span:nth-child(2), #screen .done-wave span:nth-child(6) { height:8px; animation-delay:.1s; }
  #screen .done-wave span:nth-child(3), #screen .done-wave span:nth-child(5) { height:11px; animation-delay:.2s; }
  #screen .done-wave span:nth-child(4) { height:14px; animation-delay:.3s; }
  @keyframes doneBarWave { 0%,100% { transform:scaleY(.55); } 50% { transform:scaleY(1); } }
  #screen .done-more { margin-left:auto; flex:none; font-size:11px; line-height:14px; color:#8b98a5; white-space:nowrap; }
  #screen .done-play { flex:none; font-size:10px; line-height:14px; color:#5FD2C8; margin-left:6px; }
  #screen .done-title { flex:none; height:${DONE_TITLE_LINE_HEIGHT_PX}px; font-size:${DONE_TITLE_FONT_PX}px; font-weight:700;
    line-height:${DONE_TITLE_LINE_HEIGHT_PX}px; color:#ffffff;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* \u6B63\u6587\u5757\u5403\u6389\u6807\u9898\u4E0E\u4E09\u952E\u4E4B\u95F4\u7684\u5269\u4F59\u9AD8\u5EA6\uFF08flex:1\uFF09\uFF1A\u4E00\u884C\u65F6\u4E0B\u9762\u7559\u767D\u4ECD\u5728\u6B63\u6587\u533A\u91CC\uFF0C
     \u6240\u4EE5\u89C6\u89C9\u4E0A\u662F\u300C\u6B63\u6587\u8D34\u9876\u3001\u7A7A\u767D\u5728\u6B63\u6587\u4E0E\u6309\u94AE\u4E4B\u95F4\u300D\uFF0C\u6309\u94AE\u6C38\u8FDC\u8D34\u5728\u5C4F\u5E55\u5E95\u90E8\u3002 */
  #screen .done-body { flex:1 1 auto; min-height:0; overflow:hidden; display:flex; flex-direction:column; justify-content:flex-start; }
  #screen .done-line { flex:none; height:20px; line-height:20px; box-sizing:border-box; padding:0 8px; font-size:15px; color:#e8edf2;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .done-line.cur { background:#5FD2C8; color:#04110f; font-weight:700; border-radius:4px; }
  /* \u4E09\u952E\uFF1A\u6DF1\u7070\u7B49\u5BBD\u5706\u89D2\u3001\u952E\u95F4\u8DDD 8px\u3001\u9AD8 30px\u3001\u6D45\u9752\u5B57\u3002
     margin-top:auto \u628A\u5B83\u9876\u5230\u5C4F\u5E55\u5E95\u90E8\uFF1Bmargin-bottom:3px \u8BA9\u952E\u5E95\u8FB9\u79BB\u5C4F\u5E55\u5916\u6CBF\u6B63\u597D 12px
     \uFF083 + 8 \u5185\u8FB9\u8DDD + 1 \u8FB9\u6846\uFF09\u3002 */
  #screen.done-mode .action-bar { display:flex; flex:none; height:30px; padding:0 4px; gap:8px;
    margin-top:auto; margin-bottom:3px; }
  #screen.done-mode .action-bar button { height:30px; min-height:30px; border:0; border-radius:8px;
    background:#3A3D42; color:#9fe8df; font-size:14px; }
  #screen.done-mode .action-bar button:active { background:#4a4e54; }
  /* \u8FDB\u5EA6\u9875\uFF08\u5C4F 4\uFF0C\u505C\u6B62/\u4E3B\u9875\uFF09\uFF1A\u52A8\u4F5C\u6761\u540C\u6837\u8D34\u5E95\uFF08\u952E\u5E95\u8FB9\u79BB\u5C4F\u5E55\u5916\u6CBF 12px\uFF09\uFF1B
     \u6B63\u6587\uFF08\u6700\u591A 3 \u884C\uFF09\u8D34\u9876\uFF0C\u5269\u4F59\u7A7A\u95F4\u7559\u5728\u6B63\u6587\u4E0E\u6309\u94AE\u4E4B\u95F4\uFF0C\u8D85\u51FA\u6309\u5269\u4F59\u9AD8\u5EA6\u88C1\u526A\u3002 */
  #screen.detail-mode .action-bar { margin-top:auto; margin-bottom:3px; }
  #screen.detail-mode ul { flex:1 1 auto; min-height:0; overflow:hidden; }
  /* \u6D3E\u5355\u56DE\u6267\u7684\u4E09\u62CD\u5706\u70B9\uFF08\u5DF2\u5165\u961F / \u6392\u961F N \u4E2A / \u5F00\u59CB\u8DD1\uFF09\uFF1A\u53EA\u5728 steps \u5E27\u51FA\u73B0 */
  #screen .steps { display:none; flex:none; gap:5px; margin:5px 0 6px; }
  #screen.steps-on .steps { display:flex; }
  #screen .step-arrow { flex:none; color:#5f7183; font-size:10px; line-height:14px; align-self:flex-start; margin-top:0; }
  #screen .step { flex:1; min-width:0; font-size:11px; line-height:14px; text-align:center; color:#6b7785; white-space:nowrap; overflow:hidden; }
  #screen .step::before { content:''; display:block; width:7px; height:7px; border-radius:50%; margin:0 auto 2px; background:#26323e; }
  #screen .step.done { color:var(--accent); }
  #screen .step.done::before { background:var(--accent); }
  #screen .step.active { color:#e6edf3; font-weight:700; }
  #screen .step.active::before { background:#e6edf3; }
  /* \u5012\u8BA1\u65F6\u6761\uFF08\u6D3E\u5355\u56DE\u6267 5 \u79D2\u56DE\u68CB\u76D8 / \u5F85\u51B3\u7B56 60 \u79D2\u6309\u9ED8\u8BA4\u9879\uFF09\uFF1A\u6587\u5B57\u7ED9\u79D2\u6570\uFF0C\u6761\u53EA\u7ED9\u611F\u89C9 */
  #screen .cd-row { display:none; flex:none; align-items:center; gap:6px; font-size:11px; line-height:14px; color:#9fb0c0; }
  #screen.cd-on .cd-row { display:flex; }
  #screen .cd-row #cdText { flex:none; min-width:28px; color:#9fb0c0; font-size:10px; }
  #screen .cd-track { flex:1; height:8px; border-radius:3px; background:#182230; overflow:hidden; }
  #screen .cd-fill { height:100%; width:100%; background-image:linear-gradient(90deg,var(--accent) 0 82%,transparent 82% 100%); background-size:20% 100%; background-repeat:repeat-x; transition:width .95s linear; animation:tihu-cd-flow .9s linear infinite; }
  @keyframes tihu-cd-flow { from { background-position:0 0; } to { background-position:20px 0; } }
  /* \u300C\u5728\u542C \xB7 \u5DF2\u5524\u9192\u300D\uFF08\u5C4F 3\uFF09\uFF1A\u5524\u9192\u8BCD\u547D\u4E2D\u540E\u76D6\u5728\u5C4F\u4E0A\uFF0C\u8BF4\u5B8C\u505C 3 \u79D2\u81EA\u52A8\u53D1\u9001 */
  #screen .listen { display:none; position:absolute; inset:0; z-index:6; background:#05080b;
    padding:8px; box-sizing:border-box; flex-direction:column; align-items:center; justify-content:center; gap:4px; }
  #screen.listen-on .listen { display:flex; }
  #screen .listen .l0 { font-size:12px; line-height:14px; letter-spacing:1px; color:var(--accent); }
  #screen .listen .l1 { font-size:18px; font-weight:700; line-height:22px; }
  #screen .listen .wave { display:flex; align-items:center; gap:4px; height:34px; margin:2px 0; }
  #screen .listen .wave span { display:block; width:4px; height:34px; border-radius:2px; background:var(--accent);
    animation:wavePulse .85s ease-in-out infinite; transform-origin:center; }
  #screen .listen .wave span:nth-child(2) { animation-delay:.08s; }
  #screen .listen .wave span:nth-child(3) { animation-delay:.16s; }
  #screen .listen .wave span:nth-child(4) { animation-delay:.24s; }
  #screen .listen .wave span:nth-child(5) { animation-delay:.32s; }
  #screen .listen .wave span:nth-child(6) { animation-delay:.4s; }
  #screen .listen .wave span:nth-child(7) { animation-delay:.48s; }
  #screen .listen .l2 { font-size:12px; line-height:16px; color:#9fb0c0; }
  #screen .listen .l3 { font-size:12px; line-height:16px; color:#6f7d8b; }
  #screen .listen .heard { font-size:12px; line-height:16px; color:#c3ccd5; max-width:290px; text-align:center;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* \u53F3\u4E0B\u89D2\u90A3\u884C\u300C\u5DF2\u7ED1\u5B9A\uFF1Axxx\u300D\u672C\u8F6E\u642C\u8FDB\u56DE\u7B54\u5C4F\u9876\u884C\u672B\u5C3E\uFF08\u7528\u6237 2026-11-08 \u786E\u8BA4\uFF09\uFF1A\u8FD9\u5757\u5730\u65B9\u6574\u4E2A\u7A7A\u51FA\u6765\uFF0C
     \u53F3\u4E0B\u89D2\u4E0D\u518D\u5199\u4EFB\u4F55\u6587\u5B57\u3001\u4E5F\u4E0D\u663E\u793A\u4EFB\u4F55\u4E1C\u897F\uFF08\u4E0A\u4E00\u8F6E ecf48fa \u5220\u6389\u7684\u6EDA\u52A8\u4F59\u91CF\u89D2\u843D\u63D0\u793A\u300C\u8FD8\u6709 N \u884C\u300D
     \u7EE7\u7EED\u4FDD\u6301\u5220\u9664\uFF0C\u4E0D\u6062\u590D\uFF09\u3002\u56DE\u7B54\u5C4F\u5E95\u90E8\u90A3\u6392\u6309\u94AE\uFF08\u505C\u6B62/\u91CD\u8BFB/\u4E3B\u9875/\u4E0A\u4E00\u6761/\u4E0B\u4E00\u6761\uFF09\u4F4D\u7F6E\u4E0E\u6837\u5F0F\u90FD\u4E0D\u52A8\u3002 */
  /* \u4E3B\u9875\u5C4F\u4E5F\u4ECE\u6765\u4E0D\u663E\u793A\u89D2\u843D\u63D0\u793A\uFF1A\u90A3\u5757\u5730\u65B9\u662F\u7FFB\u9875\u6309\u94AE\u7684\uFF08\u203A \u5728\u53F3\u4E0B\u89D2\uFF09\uFF0C\u4E0D\u80FD\u88AB\u538B\u4F4F */
  /* \u65E7\u7248\u5E95\u90E8\u8FDB\u5EA6\u6761/\u8D2F\u7A7F\u6A2A\u7EBF\u5DF2\u6574\u4F53\u5220\u9664\uFF08\u7528\u6237 2026-11-10\uFF1Anotice/\u6D3E\u5355\u7C7B\u5C4F\u5E95\u90E8\u4E0D\u8BB8\u7559\u88C5\u9970\u7EBF\uFF09\u3002
     \u66FE\u7ECF\u300C> .bar \u9690\u85CF\u300D\u88AB\u540E\u9762\u7684\u300C#screen .bar \u663E\u793A\u300D\u540C\u6743\u91CD\u8986\u76D6\uFF0C
     320\xD7240 \u72B6\u6001\u5C4F\u5E95\u90E8\u5C31\u591A\u51FA\u4E00\u6761 5px \u7684\u6574\u5C4F\u957F\u6A2A\u7EBF\u2014\u2014\u73B0\u5728\u8FDE\u5143\u7D20\u4E00\u8D77\u5220\u6389\u3002 */
  #screen.busy .stage { color:var(--warn); } #screen.alert .stage { color:var(--err); } #screen.ok .stage { color:var(--accent); }
  .screen-tools { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .screen-tools button { padding:6px 10px; font-size:12px; }
  .screen-tools button.on { border-color:var(--accent); background:#132420; }
  .screen-tools button.unsupported { opacity:.45; }
  .screen-tools .hint { margin-left:auto; }
  select, #voiceName, #voiceNote { font:inherit; color:var(--fg); background:#0d131b; border:1px solid var(--line); border-radius:9px; padding:8px 10px; width:100%; }
  /* \u97F3\u9891\u89E3\u9501\u6A2A\u5E45\uFF1A\u6D4F\u89C8\u5668\u81EA\u52A8\u64AD\u653E\u7B56\u7565\u4F1A\u628A\u624B\u52A8\u521B\u5EFA\u7684 AudioContext \u7F6E\u4E3A suspended\uFF0C
     \u6B64\u65F6 PCM \u5168\u90E8\u300C\u5230\u8FBE\u4F46\u4E0D\u51FA\u58F0\u300D\u3002\u70B9\u4E00\u6B21\u9875\u9762\u5373\u53EF\u89E3\u9501\uFF08resume\uFF09\u3002 */
  .audio-warn { display:none; background:#3a2f12; border:1px solid #b08a45; color:#ffe9c2;
    border-radius:8px; padding:8px 10px; font-size:12px; line-height:1.45; margin:8px 12px 0; cursor:pointer; }
  .audio-warn.on { display:block; }
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

<div class="audio-warn" id="audioWarn">\u{1F507} \u70B9\u4E00\u4E0B\u5C4F\u5E55\u542F\u7528\u58F0\u97F3\uFF08\u6D4F\u89C8\u5668\u8981\u6C42\u5148\u6709\u4E00\u6B21\u70B9\u51FB\uFF0C\u5426\u5219\u6717\u8BFB\u53EA\u6709\u6570\u636E\u6CA1\u6709\u58F0\u97F3\uFF09</div>

<div class="device-wrap" id="deviceWrap">
  <div class="device-title">ESP32-S3-BOX-3B \xB7 2.4\u2033 \xB7 320\xD7240 \xB7 \u89E6\u6478\u5C4F</div>
  <div class="device" id="device">
    <div class="bezel">
      <div class="mics"><span></span><span></span></div>
      <div id="screen">
        <div class="stage" id="stage">\u8FDE\u63A5</div>
        <div id="homeTop" class="home-top"><span class="clock" id="homeClock">--:--</span><span class="home-counts" id="boardCounts"></span><span class="signal conn-connecting" id="homeSignal"><span class="bar b1"></span><span class="bar b2"></span><span class="bar b3"></span></span></div>
        <div class="title" id="title">\u6B63\u5728\u8FDE\u63A5\u5BBF\u4E3B\u2026</div>
        <div id="steps" class="steps"></div>
        <ul id="bullets"></ul>
        <div id="doneView" class="done-view">
          <div class="done-bar">
            <span class="done-stage" id="doneStage">\u5B8C\u6210</span>
            <span class="done-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span>
            <span class="done-more" id="doneMore"></span>
            <span class="done-play" aria-hidden="true">\u25B6</span>
          </div>
          <div class="done-title" id="doneTitle"></div>
          <div class="done-body" id="doneBody"></div>
        </div>
        <div id="actionBar" class="action-bar"></div>
        <div id="homeBody" class="home-body"></div>
        <div id="cdRow" class="cd-row"><span id="cdText"></span><div class="cd-track"><div class="cd-fill" id="cdFill"></div></div></div>
        <div id="listen" class="listen">
          <div class="l0">\u5728\u542C \xB7 \u5DF2\u5524\u9192</div>
          <div class="l1">\u6211\u5728\uFF0C\u8BF4\u5427</div>
          <div class="wave"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
          <div class="heard" id="listenHeard"></div>
          <div class="l2">\u8BF4\u5B8C\u505C 3 \u79D2\u518D\u53D1\u9001</div>
          <div class="l3">\u60F3\u6E05\u695A\u518D\u8BF4\u4E0D\u7740\u6025</div>
          <div class="l3">10 \u79D2\u6CA1\u8BF4\u8BDD\u5C31\u9000\u51FA \xB7 \u957F\u6309\u4E5F\u80FD\u8BF4</div>
        </div>
      </div>
      <div class="grille"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
    </div>
    <div class="dock"></div>
  </div>
  <div class="screen-tools">
    <button data-scale="1">1\xD7</button>
    <button data-scale="2" class="on">2\xD7</button>
    <button data-scale="actual">\u5B9E\u9645\u5C3A\u5BF8</button>
    <button id="wake" title="\u514D\u6309\u4F4F\uFF1A\u53EB\u300C\u4F60\u597D\uFF0C\u9E48\u9E55\u300D\u5C31\u80FD\u8BF4\u8BDD\uFF08\u6D4F\u89C8\u5668\u5173\u952E\u8BCD\u8046\u542C\uFF1B\u771F\u673A\u8D70\u56FA\u4EF6\u672C\u5730\u5524\u9192\uFF09">\u514D\u6309\u4F4F</button>
    <button id="shellToggle">\u4EC5\u5C4F\u5E55</button>
    <span class="hint" id="scaleHint">640 \xD7 480 \u663E\u793A</span>
  </div>
</div>


<div class="card" id="voiceCard">
  <h4>\u97F3\u8272 \xB7 \u4E3B\u5F15\u64CE edge-tts\uFF08\u79BB\u7EBF\u515C\u5E95\uFF1A\u672C\u5730 Kokoro\uFF09</h4>
  <div class="row">
    <select id="voiceSelect" style="flex:1"></select>
    <button id="audioTest" title="\u5FF5\u4E00\u53E5\u793A\u4F8B\u8BED\u97F3\uFF0C\u9A8C\u8BC1\u58F0\u97F3\uFF08\u4E0D\u51FA\u58F0\u5C31\u70B9\u5B83\uFF09">\u8BD5\u542C</button>
    <button id="voiceRefresh">\u5237\u65B0</button>
  </div>
  <div class="hint" id="audioTestHint">\u8BD5\u542C\u4F1A\u5148\u89E3\u9501\u97F3\u9891\uFF1A\u6709\u672C\u8F6E\u7F13\u5B58\u5C31\u91CD\u64AD\uFF0C\u5426\u5219\u8BA9\u5BBF\u4E3B\u5FF5\u4E00\u53E5\u793A\u4F8B\uFF08\u8D70\u6B63\u5F0F\u6717\u8BFB\u540C\u4E00\u6761 TTS \u94FE\u8DEF\uFF09\u3002</div>
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
    <input id="offlineOnly" type="checkbox" style="width:auto" /> \u4EC5\u79BB\u7EBF\uFF08\u8DF3\u8FC7 edge \u4E91\u5065\uFF0C\u6539\u7528\u672C\u5730 Kokoro \u515C\u5E95\uFF09
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
  </div>
  <textarea id="text" placeholder="\u6587\u5B57\u515C\u5E95\uFF1A\u76F4\u63A5\u8F93\u5165\u8981\u4EA4\u7ED9\u4F1A\u8BDD\u7684\u8BDD"></textarea>
  <div class="row" style="margin-top:8px"><button id="send" style="flex:1">\u53D1\u9001\u5230\u5F53\u524D\u4F1A\u8BDD</button></div>
  <div class="row" style="margin-top:8px"><button id="end" style="flex:1;border-color:#b04545">\u7ED3\u675F\u672C\u6B21\u8BED\u97F3\u4F1A\u8BDD</button></div>
  <div class="hint">\u300C\u7ED3\u675F\u300D\u4F1A\u7ACB\u523B\u89E3\u9664\u5371\u9669\u52A8\u4F5C\u95F8\u95E8\uFF08\u4E0D\u7528\u7B49 120 \u79D2\u7A7A\u95F2\uFF09\uFF0C\u4E4B\u540E\u4F60\u81EA\u5DF1\u5728\u4F1A\u8BDD\u91CC\u7684\u64CD\u4F5C\u5B8C\u5168\u4E0D\u53D7\u5F71\u54CD\u3002</div>
</div>

<div class="card">
  <h4>\u4E8B\u4EF6</h4>
  <div id="events"></div>
</div>

<div id="drop">\u677E\u5F00\u5373\u53EF\u4E0A\u4F20\u8FD9\u6BB5\u97F3\u9891</div>

<script>
(function () {
  'use strict';
  var TARGET_RATE = 16000;
  var condition = ${condition.toString()};
  var trimSilence = ${trimSilence.toString()};
  var LANE = ${lane};
  var PROTOCOL = ${protocol};
  /* \u771F\u673A\u5C4F\u5E55\u89C4\u683C\uFF1A\u4E0E src/tihu/screen-spec.ts \u540C\u4E00\u4EFD\u5E38\u91CF\uFF08\u9875\u9762\u53EA\u6D88\u8D39\uFF0C\u4E0D\u53E6\u5199\u6570\u503C\uFF09\u3002 */
  var SCREEN = ${JSON.stringify(SCREEN_SPEC)};
  var DONE = ${JSON.stringify(DONE_LAYOUT)};
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
  var state = { ws: null, seq: 0, clientId: '', sessionId: '', 
    
    lastTranscript: '', recorder: null, chunks: [], retryTimer: 0, audioPending: false, audioTimer: 0,
    connState: 'connecting', clockTimer: 0,
    
    audioCtx: null, pcmSources: [], pcmNextTime: 0, pcmLast: null, droppedAudio: false, readRound: null,
    /* \u6717\u8BFB\u81EA\u68C0\uFF1A\u6536\u5230\u591A\u5C11\u5757 / \u6700\u540E\u4E00\u5757\u662F\u5426\u5DF2\u6392\u7A0B / \u88AB\u4E22\u6389\u7684\u5757\u6570\uFF08\u9875\u9762\u4E8B\u4EF6\u533A\u4E0E __tihuAudioCheck \u53EF\u67E5\uFF09 */
    ttsChunks: 0, ttsFinalSeen: false, ttsDropped: 0,
    samplePending: false, sampleTimer: 0,
    voice: 'default', voices: [], voiceEngine: null,
    highlightLock: false, hostAlert: false, screenMode: 'status', screenScale: 2, actions: [], 
    /* \u4EFB\u52A1\u68CB\u76D8\uFF08\u5C4F 1\uFF09\u4E0E\u6D3E\u5355\u56DE\u6267 / \u5F85\u51B3\u7B56\u7684\u9644\u52A0\u5757\uFF082026-11-09 \u7EDF\u4E00\u6307\u6325\u4F1A\u8BDD\uFF09 */
    board: null, steps: [], countdown: null, countdownTimer: 0,
    /* \u5B8C\u6210\u9875\uFF1Adone = { lines, current }\uFF1B\u9AD8\u4EAE\u53EA\u7531\u6BCF\u6BB5 PCM \u7684\u771F\u5B9E\u5F00\u59CB/\u7ED3\u675F\u4E8B\u4EF6\u63A8\u8FDB
       \uFF08\u89C1 segmentStarted/segmentEnded\uFF09\uFF0C\u6CA1\u6709\u4EFB\u4F55\u6309\u65F6\u95F4\u7FFB\u884C\u7684\u515C\u5E95\u8BA1\u65F6\u5668\u3002 */
    done: null, doneRanges: null,
    /* \u5B8C\u6210\u9875\u5F53\u524D\u8FD9\u6761\u4EFB\u52A1\uFF08playback.state \u4E0E\u6682\u505C\u70B9\u90FD\u8981\u5E26 taskId\uFF09 */
    doneTaskId: '',
    /* \u6BB5\u7EA7\u7EED\u64AD\uFF1A\u6682\u505C\u65F6\u8BB0\u4E0B\u7B2C\u51E0\u6BB5\uFF081 \u8D77\uFF09\uFF0C\u7EE7\u7EED\u65F6\u5BBF\u4E3B\u4ECE\u8BE5\u6BB5\u7B2C\u4E00\u4E2A\u5B57\u91CD\u53D1 PCM\u3002
       \u91C7\u6837\u7EA7\u6682\u505C\u4E0D\u53EF\u9760\uFF08WebAudio \u65F6\u95F4\u8F74 + suspended \u65F6\u4E22\u5757\uFF09\uFF0C\u6240\u4EE5\u53EA\u505A\u6BB5\u7EA7\u3002 */
    pausedAt: null,
    /* \u5DF2\u5904\u7406\u7684\u8BBE\u5907\u7EA7 opId\uFF08\u5BBF\u4E3B tool \u7684\u5E42\u7B49\u952E\uFF0C\u4FDD\u7559\u6700\u8FD1 32 \u4E2A\uFF09\uFF1A\u91CD\u590D\u5230\u8FBE\u53EA\u56DE ack \u4E0D\u91CD\u590D\u6267\u884C\u3002 */
    opIds: [],
    /* \u514D\u6309\u4F4F\uFF08\u5524\u9192\u8BCD\u8046\u542C\uFF09\uFF1Abrowser \u5173\u952E\u8BCD \u2192 \u5C4F 3\u300C\u5728\u542C\u300D\u2192 \u505C 3 \u79D2\u53D1\u9001\uFF1B10 \u79D2\u6CA1\u8BF4\u8BDD\u9000\u51FA */
    wake: false, wakeRec: null, wakeRestart: 0, listenOn: false, listenText: '', listenTimer: 0, listenIdle: 0 };

  /* ---------- \u4F1A\u8BDD\u5B9A\u4F4D ----------
     2026-11-09 \u7EDF\u4E00\u6307\u6325\uFF1A\u5F00\u673A\u53EA\u8BA4\u4E24\u79CD\u610F\u56FE \u2014\u2014
       1. URL ?session=<id> \u663E\u5F0F\u6307\u5B9A \u2192 \u624B\u52A8\u7ED1\u5B9A\uFF08\u8001\u9003\u751F\u53E3\uFF0C\u4E00\u6B21\u6709\u6548\uFF09\uFF1B
       2. \u5176\u5B83\u4E00\u5207\uFF08\u542B\u672C\u5730\u8BB0\u4F4F\u8FC7\u7684\u65E7\u4F1A\u8BDD\uFF09\u2192 \u7EDF\u4E00\u6307\u6325\uFF1A\u53D1**\u88F8 hello**\uFF0C
          \u5BBF\u4E3B\u628A\u5B83\u7ED1\u5230\u552F\u4E00\u7684\u300C\u9E48\u9E55\u6307\u6325\u53F0\u300D\uFF0C\u5C4F\u4E0A\u76F4\u63A5\u662F\u4EFB\u52A1\u68CB\u76D8\u3002
     \u672C\u5730\u952E dsh.tihu.session \u4ECD\u968F\u624B\u52A8/\u81EA\u52A8\u7ED1\u5B9A\u66F4\u65B0\uFF08handleSessionInvalid \u9760\u5B83\u5224\u65AD
     \u5931\u6548\u7684\u662F\u4E0D\u662F\u300C\u6211\u4EEC\u81EA\u5DF1\u8BB0\u7684\u90A3\u6761\u300D\uFF09\uFF0C\u4F46**\u4E0D\u518D\u53C2\u4E0E\u5F00\u673A**\uFF1A\u5426\u5219\u4E00\u6B21\u624B\u52A8\u7ED1\u5B9A\u5C31\u4F1A\u88AB
     \u5B83\u6309 origin \u7ED1\u6B7B\uFF0C\u9ED8\u8BA4\u5165\u53E3\u6C38\u8FDC\u56DE\u4E0D\u5230\u68CB\u76D8\uFF082026-11-09 \u5B9E\u6D4B\u7684\u65E7\u4F1A\u8BDD\u5C4F\u5C31\u662F\u8FD9\u6837\u6765\u7684\uFF09\u3002
   */
  var SESSION_KEY = 'dsh.tihu.session';


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
  function renderActions() {
    var bar = $('actionBar');
    bar.innerHTML = '';
    var actions = state.actions || [];
    // \u6309\u94AE\u591A\uFF08>3 \u4E2A\uFF09\u65F6\u6536\u5C0F\u5B57\u53F7\uFF0C304px \u5185\u6324\u5F97\u4E0B\u3001\u4E0D\u6362\u884C\u3002
    bar.className = actions.length > 3 ? 'action-bar many' : 'action-bar';
    for (var i = 0; i < actions.length; i += 1) {
      var button = document.createElement('button');
      button.textContent = actions[i].label;
      button.setAttribute('data-action', actions[i].id);
      bar.appendChild(button);
    }
  }
  /* stage \u884C\u53EF\u7528\u5BBD\uFF1A\u5C4F\u5BBD\u51CF\u53BB\u5DE6\u53F3\u5185\u8FB9\u8DDD\uFF08320 \u2212 2\xD78 = 304\uFF09\u3002 */
  function stageWidthPx() {
    var width = (SCREEN.widthPx || 320) - 2 * (SCREEN.paddingPx || 8);
    return width;
  }
  /**
   * stage \u90A3\u4E00\u884C\u7684 letter-spacing\uFF08CSS\u300C#screen .stage { \u2026 letter-spacing:1px \u300D\u540C\u4E00\u4E2A\u6570\u5B57\uFF09\uFF1A
   * \u53EA\u6309\u5B57\u5BBD\u91CF\u4F1A\u6491\u8FC7 304\uFF0C\u6240\u4EE5\u91CF\u8FD9\u4E00\u884C\u8981\u5E26\u4E0A\u5B83\u3002
   */
  var STAGE_LETTER_SPACING_W = 1;
  /**
   * \u9996\u9875\u9876\u884C\u7684\u5C3A\u5BF8\u5E38\u91CF\uFF1A\u5FC5\u987B\u548C CSS\u300C#screen .home-top .signal\u300D\u90A3\u4E09\u6761\u89C4\u5219\u4E00\u6A21\u4E00\u6837
   * \uFF08\u67F1\u5BBD 5px \xD7 3\u3001\u67F1\u95F4\u9699 2px \xD7 2\u3001\u65F6\u95F4\u4E0E\u56FE\u6807\u95F4\u9699 8px\uFF09\u3002
   */
  var SIGNAL_BAR_W = 5;
  var SIGNAL_GAP_W = 2;
  var SIGNAL_W = SIGNAL_BAR_W * 3 + SIGNAL_GAP_W * 2;   /* 19 */
  var HOME_TOP_GAP_W = 8;

  /** \u672C\u5730\u65F6\u949F\uFF1A\u53EA\u663E\u793A\u5230\u5206\u949F\u300124 \u5C0F\u65F6\u5236\u3001\u96F6\u8865\u9F50 \u2192 19:32\u3002\u4E0D\u53D6\u5BBF\u4E3B\u5E27\u63A8\u9001\uFF08\u9760\u5BBF\u4E3B\u63A8\u4F1A stale\uFF09\u3002 */
  function clockText() {
    var now = new Date();
    var hh = now.getHours();
    var mm = now.getMinutes();
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  /**
   * \u8FDE\u63A5\u72B6\u6001\uFF1A\u63A5\u9875\u9762\u5DF2\u6709\u90A3\u4E00\u4EFD\uFF08#conn \u90A3\u6761 + ws \u5F00/\u5173\uFF09\uFF0C\u4E0D\u65B0\u589E\u534F\u8BAE\u5B57\u6BB5\u3002
   * online = \u5DF2\u8FDE\u4E0A\u5BBF\u4E3B\uFF08\u7EFF\uFF09\uFF1Bconnecting = \u8FDE\u4E0A\u524D / 2 \u79D2\u540E\u91CD\u8FDE\u65F6\u6B63\u5728\u62E8\u53F7\uFF08\u7070\u3001\u67F1\u6761\u7A0D\u6DE1\uFF09\uFF1B
   * offline = \u521A\u521A\u5173\u6389\u8FDE\u63A5\u3001\u8FD8\u6CA1\u5F00\u59CB\u4E0B\u4E00\u6B21\u91CD\u8FDE\uFF08\u7EA2\uFF09\u3002\u65AD\u5F00\u53EA\u6709\u989C\u8272\uFF0C\u6CA1\u6709\u6587\u5B57\u3002
   */
  function setConnState(next) {
    state.connState = next;
    renderHomeTop();
  }
  /** \u9876\u884C\uFF1A\u672C\u5730\u65F6\u949F HH:MM + \u68CB\u76D8\u53F3\u7AEF\u56DB\u6BB5\u8BA1\u6570\uFF08\u7B49\u4F60/\u5728\u8DD1/\u6392\u961F/\u5B8C\u6210\uFF09/ \u4FE1\u53F7\u67F1\uFF08\u9875\u9762\u81EA\u5DF1\u753B\uFF0C\u4E0D\u8BFB\u5BBF\u4E3B\u5E27\uFF09\u3002 */
  function renderHomeTop() {
    var clock = $('homeClock');
    if (clock) clock.textContent = clockText();
    var counts = $('boardCounts');
    if (counts) {
      counts.textContent = state.screenMode === 'board' ? fitTextPx(boardCountsText(state.board && state.board.counts), 240, 11) : '';
    }
  }

  /* ---------- \u4EFB\u52A1\u68CB\u76D8\uFF08\u5C4F 1\uFF09\uFF1A\u4E00\u884C\u4E00\u4EFB\u52A1 ----------
   * \u7248\u5F0F\uFF1A\u9876\u884C\u56DB\u6BB5\u8BA1\u6570\uFF08\u7B49\u4F60 \u5728\u8DD1 \u6392\u961F \u5B8C\u6210\uFF09\u2192 \u6700\u8FD1 5 \u884C\u4EFB\u52A1\u3002\u65E7\u5F0F\u7FFB\u9875\u6761\u5DF2\u6574\u4F53\u5220\u9664
   * \uFF08\u7528\u6237 2026-11-09\uFF1A\u8BBE\u5907\u5C4F\u4E0D\u8981\u4E0A\u4E00\u9875/\u4E0B\u4E00\u9875\uFF09\uFF0C5 \u884C\u5206\u6389\u539F\u6765\u90A3 28px\uFF0C320\xD7240 \u4E0D\u6EA2\u51FA\u3002
   * \u6BCF\u884C\u53EA\u8BF4\u4E09\u4EF6\u4E8B\uFF1A\u72B6\u6001\u80F6\u56CA\uFF08\u6587\u5B57\uFF09\u3001\u4EFB\u52A1\u540D\u3001\u526F\u884C\u300C\u9879\u76EE \xB7 \u7B2C N \u6B65\u300D\uFF0B\u53F3\u4FA7\u65F6\u957F\u73AF\u3002
   * \u6CA1\u6709\u4EFB\u52A1\u65F6\u662F**\u540C\u4E00\u5F20\u68CB\u76D8\u7684\u53E6\u4E00\u79CD\u8138**\uFF08\u7A7A\u6001\uFF09\uFF0C\u4E0D\u53E6\u5F00\u4E00\u5C4F\u3002
   */

  function boardCountsText(counts) {
    var c = counts || {};
    // \u56DB\u6BB5\u8BA1\u6570**\u59CB\u7EC8\u90FD\u5728**\uFF08\u7A7A\u76D8\u4E5F\u8981\u770B\u5230\u56DB\u4E2A 0\uFF09\uFF0C\u987A\u5E8F\u56FA\u5B9A\uFF1A\u7B49\u4F60 \u2192 \u5728\u8DD1 \u2192 \u6392\u961F \u2192 \u5B8C\u6210\u3002
    // \u6BB5\u95F4\u7528\u7A84\u7A7A\u683C\uFF08\u5C0F\u95F4\u8DDD\uFF09\uFF0C\u4E0D\u6362\u884C\uFF1B\u5BBD\u5EA6\u7531 fitTextPx \u515C\u5E95\u7F29\u653E\u3002
    return '\u25CF' + (Number(c.awaiting) || 0) + ' \u7B49\u4F60' + '\u2009\u25CF' + (Number(c.running) || 0) + ' \u5728\u8DD1'
      + '\u2009\u25CF' + (Number(c.queued) || 0) + ' \u6392\u961F' + '\u2009\u25CF' + (Number(c.done) || 0) + ' \u5B8C\u6210';
  }
  function applyScreenClass(base) {
    var screen = $('screen');
    if (!screen) return;
    // \u514D\u6309\u4F4F\u8046\u542C\u300C\u5728\u542C \xB7 \u5DF2\u5524\u9192\u300D\u662F\u76D6\u5728\u5C4F\u4E0A\u7684\u4E00\u5C42\uFF1B\u4EFB\u4F55\u5BBF\u4E3B\u5C4F\u5E27\u91CD\u753B className \u65F6
    // \u5FC5\u987B\u4FDD\u7559\u5B83\uFF0C\u5426\u5219\u540E\u53F0\u4EFB\u52A1\u4E00\u63A8\u5E27\uFF0C\u5524\u9192\u5C4F\u5C31\u5728 10 \u79D2\u524D\u88AB\u64E6\u6389\uFF082026-11-09 \u5B9E\u6D4B\uFF09\u3002
    // \u6D3E\u5355\u4E09\u6B65\u5706\u70B9\u540C\u7406\uFF1ArenderSteps \u5148\u52A0 steps-on\uFF0C\u540E\u4E00\u6B21 className \u4E0D\u80FD\u628A\u5B83\u62B9\u6389\u3002
    var steps = state.steps && state.steps.length ? ' steps-on' : '';
    screen.className = base + (state.listenOn ? ' listen-on' : '') + steps;
  }
  function renderBoard(payload) {
    var screen = $('screen');
    var board = payload.board || {};
    state.board = board;
    state.screenMode = 'board';
    state.hostAlert = false;
    state.highlightLock = false;
    state.actions = [];
    renderActions();
    $('stage').style.display = 'none';
    $('stage').textContent = '';
    var clock = $('homeClock');
    if (clock) renderHomeTop();
    renderSteps([]);
    renderCountdown(null);
    var body = $('homeBody');
    body.innerHTML = '';
    // \u5217\u8868\u533A\u5355\u72EC\u4E00\u5C42\uFF08flex:1\uFF09\uFF1A\u7FFB\u9875\u6761\u5728\u5B83\u4E0B\u9762\uFF0C\u9489\u5728\u5C4F\u5E95 \u2014\u2014 \u4E00\u6761\u8FD8\u662F\u56DB\u6761\u90FD\u4E0D\u5F71\u54CD\u7FFB\u9875\u6761\u7684\u4F4D\u7F6E\u3002
    var list = document.createElement('div');
    list.className = 'board-list';
    body.appendChild(list);
    var rows = Array.isArray(board.rows) ? board.rows : [];
    if (rows.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'board-empty';
      var wave = document.createElement('div');
      wave.className = 'wave';
      for (var wi = 0; wi < 5; wi += 1) wave.appendChild(document.createElement('span'));
      var l1 = document.createElement('div');
      l1.className = 'l1';
      l1.textContent = '\u8FD8\u6CA1\u6709\u4EFB\u52A1';
      var l2 = document.createElement('div');
      l2.className = 'l2';
      l2.textContent = fitTextPx('\u53EB\u300C\u4F60\u597D\uFF0C\u9E48\u9E55\u300D\u8BF4\u4E00\u53E5\uFF0C\u6216\u8005\u70B9\u5C4F', 288, 12);
      var l3 = document.createElement('div');
      l3.className = 'l3';
      l3.textContent = '\u8BF4\u5B8C\u8FD9\u91CC\u5C31\u53D8\u6210\u4EFB\u52A1\u68CB\u76D8';
      empty.appendChild(wave);
      empty.appendChild(l1);
      empty.appendChild(l2);
      empty.appendChild(l3);
      list.appendChild(empty);
    }
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var item = document.createElement('div');
      item.className = 'board-item';
      item.setAttribute('data-task', row.taskId || '');
      var row1 = document.createElement('div');
      row1.className = 'board-row1';
      var capsule = document.createElement('span');
      capsule.className = 'board-capsule ' + (row.state || 'queued');
      capsule.textContent = row.capsule || '';
      var title = document.createElement('span');
      title.className = 'board-title';
      title.textContent = row.title || '';
      row1.appendChild(capsule);
      row1.appendChild(title);
      // \u5FAE\u6761\u653E\u5728\u6807\u9898\u884C\u672B\u5C3E\uFF1A\u526F\u884C\u6700\u53F3\u8FB9\u53EA\u7559\u300C\u72B6\u6001\u56FE\u5F62\u300D\u8FD9\u4E00\u679A\uFF08\u7528\u6237 2026-11-10 \u5B9E\u673A\u53CD\u9988\uFF1A
      // \u53F3\u4FA7\u540C\u65F6\u51FA\u73B0\u6CE2\u5F62+\u5706\u73AF\uFF0C\u770B\u6210\u4E24\u4E2A\u72B6\u6001\u4E86\uFF09\u3002
      if (Array.isArray(row.micro) && row.micro.length > 0) {
        var micro = document.createElement('span');
        micro.className = 'board-micro';
        var maxMicro = Math.max.apply(null, row.micro.map(function (value) { return Number(value) || 0; })) || 1;
        for (var mi = 0; mi < row.micro.length; mi += 1) {
          var bar = document.createElement('span');
          var ratio = Math.max(0, Math.min(1, (Number(row.micro[mi]) || 0) / maxMicro));
          bar.style.height = Math.max(2, Math.round(2 + ratio * 8)) + 'px';
          micro.appendChild(bar);
        }
        row1.appendChild(micro);
      }
      var row2 = document.createElement('div');
      row2.className = 'board-row2';
      var sub = document.createElement('span');
      sub.className = 'board-sub';
      sub.textContent = row.sub || '';
      row2.appendChild(sub);
      /* \u53F3\u4FA7\u72B6\u6001\u56FE\u5F62\uFF08\u7528\u6237 2026-11-10 \u5B9A\u6848\uFF09\uFF1A\u5B8C\u6210\uFF1D\u7EFF\u8272\u5B9E\u5FC3\u5706\uFF08\u76F4\u5F84 12px\uFF09\uFF1B
         \u5F85\u51B3\u7B56\uFF1D\u9EC4\u8272\u5706\u5F62\u91CC\u7684\u95EE\u53F7\uFF1B\u6392\u961F/\u6D3E\u5355\uFF1D\u7070\u8272\u7EC6\u73AF\uFF1B\u8FDB\u884C\u4E2D\uFF1D\u84DD\u8272\u5706\u73AF\uFF0C\u5F27\u957F\u7531\u5BBF\u4E3B\u7684
         ring.percent\uFF08\u5DF2\u8FD0\u884C\u65F6\u957F \xF7 30 \u5206\u949F\uFF09\u753B\u51FA\u6765\uFF0C\u6EE1 30 \u5206\u949F\u540E\u505C\u5728\u5DEE\u4E00\u70B9\u7684\u6574\u5708\u3002 */
      row2.appendChild(boardStatusEl(row));
      item.appendChild(row1);
      item.appendChild(row2);
      list.appendChild(item);
    }
    // \u7FFB\u9875\u6761\uFF1A\u6BCF\u9875 4 \u6761\uFF08BOARD_PAGE_SIZE\uFF09\uFF1B\u53EA\u6709\u4E00\u9875\u65F6\u6574\u6761\u4E0D\u5EFA\uFF08\u7528\u6237 2026-11-10\u300C\u9996\u9875\u6062\u590D\u7FFB\u9875\u300D\uFF09\u3002
    var page = board.page || { index: 0, total: 1 };
    var pageIndex = Math.max(0, Math.floor(Number(page.index) || 0));
    var pageTotal = Math.max(1, Number(page.total) || 1);
    if (rows.length > 0 && pageTotal > 1) {
      var pager = document.createElement('div');
      pager.className = 'board-pager';
      var prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.textContent = '\u4E0A\u4E00\u9875';
      prevBtn.setAttribute('data-action', 'boardPrev');
      prevBtn.className = pageIndex > 0 ? 'cur' : 'off';
      var nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.textContent = '\u4E0B\u4E00\u9875';
      nextBtn.setAttribute('data-action', 'boardNext');
      nextBtn.className = pageIndex < pageTotal - 1 ? 'cur' : 'off';
      var pageText = document.createElement('span');
      pageText.className = 'page';
      pageText.textContent = '\u7B2C ' + (pageIndex + 1) + '/' + pageTotal + ' \u9875';
      pager.appendChild(prevBtn);
      pager.appendChild(pageText);
      pager.appendChild(nextBtn);
      body.appendChild(pager);
    }
    applyScreenClass('board-mode');
  }

  /** \u68CB\u76D8\u884C\u53F3\u4FA7\u90A3\u679A\u72B6\u6001\u56FE\u5F62\uFF0814\xD714\uFF0C\u53F3\u5BF9\u9F50\uFF0C\u79BB\u5C4F\u5E55\u5916\u6CBF 10px\uFF09\u3002 */
  function boardStatusEl(row) {
    var status = document.createElement('span');
    var state = String(row.state || 'queued');
    status.className = 'board-status ' + state;
    // \u540E\u53F0\u5B50\u4EE3\u7406\u8FD8\u5728\u8DD1\uFF08\u542B code_agent \u8D77\u7684\u6807\u51C6\u4F1A\u8BDD\uFF09\uFF1A\u84DD\u8272\u5B9E\u5FC3\u70B9 + 1.2 \u79D2\u547C\u5438\uFF0C
    // \u4E0D\u5199\u4E00\u4E2A\u5B57\u3001\u4E0D\u505A\u4F4D\u79FB\u52A8\u753B\uFF1B\u5B50\u4EE3\u7406\u5168\u505C\u540E blink \u6D88\u5931\uFF0C\u81EA\u52A8\u56DE\u5230\u7EFF\u8272\u5B9E\u5FC3\u5706\u3002
    var blink = row.blink === true || (Number(row.subagents) > 0 && state !== 'awaiting');
    if (blink) {
      status.className = 'board-status subagents';
      status.setAttribute('aria-label', '\u540E\u53F0\u5B50\u4EE3\u7406\u5728\u8DD1');
      return status;
    }
    if (state === 'running') {
      var percent = Number(row.ring && row.ring.percent);
      percent = Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0;
      // \u300C\u8DD1\u6EE1\u5C31\u505C\u5728\u6EE1\u5708\u9644\u8FD1\u300D\uFF1A\u6EE1 30 \u5206\u949F\u8FD8\u7559 6% \u7684\u7A7A\u6863\uFF0C\u8BA9\u4EBA\u770B\u5F97\u51FA\u5B83\u8F6C\u4E86\u4E00\u5708\u3001\u4F46\u6CA1\u8F6C\u6EE1\u3002
      if (percent >= 1) percent = 0.94;
      var radius = 5;
      var circumference = Math.PI * 2 * radius;
      var arc = Math.max(1, circumference * percent);
      // \u6CA1\u6709\u5B50\u4EE3\u7406\u7684\u666E\u901A\u6267\u884C\u4E2D\uFF1A\u4FDD\u6301\u539F\u6765\u7684\u84DD\u8272\u672A\u95ED\u5408\u5F27\u7EBF\u73AF\uFF08\u4E0D\u95EA\u3001\u4E0D\u8F6C\uFF09\u3002
      status.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">'
        + '<circle cx="7" cy="7" r="' + radius + '" fill="none" stroke="#2b3a4a" stroke-width="2"></circle>'
        + '<circle cx="7" cy="7" r="' + radius + '" fill="none" stroke="#4f9fd8" stroke-width="2" stroke-linecap="round"'
        + ' stroke-dasharray="' + arc.toFixed(2) + ' ' + (circumference + 1).toFixed(2) + '"'
        + ' transform="rotate(-90 7 7)"></circle></svg>';
      return status;
    }
    if (state === 'awaiting') {
      status.textContent = row.badge === 'ask' ? '?' : '\xB7';
      return status;
    }
    // \u5B8C\u6210\uFF1D\u7EFF\u8272\u5B9E\u5FC3\u5706\uFF08\u76F4\u5F84 12px\uFF0C\u7531 CSS \u7ED9\uFF09\uFF1B\u6392\u961F\uFF0F\u6D3E\u5355\uFF1D\u7070\u8272\u7EC6\u73AF\uFF08CSS\uFF09\u3002
    return status;
  }

  /* ---------- \u5B8C\u6210\u9875\uFF08\u5C4F 6\uFF0C\u53C2\u8003\u56FE\u7248\u5F0F\uFF09 ----------
   * \u9876\u680F 14 + \u6807\u9898 22 + \u6B63\u6587\u6309\u884C\u6570\uFF08\u6700\u591A 7\xD720\uFF0C\u5F53\u524D\u884C\u9752\u5E95\u9ED1\u5B57\uFF09+ \u4E09\u952E\u8D34\u5E95 30\uFF0C
   * 320\xD7240 \u5185\u4E0D\u6EA2\u51FA\uFF1B\u884C\u5C11\u65F6\u6B63\u6587\u8D34\u6807\u9898\u3001\u7A7A\u767D\u7559\u5728\u6B63\u6587\u4E0E\u6309\u94AE\u4E4B\u95F4\u3002
   * \u884C\u6587\u672C\u7531\u5BBF\u4E3B\u6309\u50CF\u7D20\u6298\u597D\uFF08done.lines\uFF09\uFF0C\u9875\u9762\u53EA\u8D1F\u8D23\u7A97\u53E3\u4E0E\u9AD8\u4EAE\uFF0C\u4E0D\u518D\u4E8C\u6B21\u7FFB\u8BD1\u3002
   *
   * \u9AD8\u4EAE \u2261 \u6BCF\u6BB5 PCM \u7684\u771F\u5B9E\u5F00\u59CB/\u7ED3\u675F\uFF082026-11-10 \u7528\u6237\u5B9E\u673A\u53CD\u9988\u7B2C\u4E8C\u7248\uFF1A\u9AD8\u4EAE\u6BD4\u58F0\u97F3\u5FEB\uFF09\uFF1A
   * **\u4E0D\u518D**\u7528 ctx.currentTime \u5728\u6392\u7A0B\u533A\u95F4\u91CC\u6309\u6BD4\u4F8B\u63A8\u7B97\u5B57\u7B26\u4F4D\u7F6E\uFF08\u65E7 pollDone \u5DF2\u5220\uFF09\u3002
   * \u6BCF\u6BB5 PCM\uFF08\u4E00\u4E2A AudioBufferSourceNode\uFF09\u771F\u6B63\u5F00\u59CB\u7684\u90A3\u4E00\u523B \u2192 \u9501\u5B9A\u5B83\u81EA\u5DF1\u7684
   * charStart/charEnd\uFF08\u4E00\u6BB5\u8DE8\u591A\u884C\u65F6\u5C31\u9AD8\u4EAE\u8D77\u59CB\u884C\uFF0C\u884C\u5185\u8FDB\u5EA6\u4E0D\u663E\u793A\uFF09\uFF1B
   * \u8FD9\u6BB5 onended\uFF08\u771F\u5B9E\u4E8B\u4EF6\uFF09\u2192 \u63A8\u8FDB\u5230\u4E0B\u4E00\u6BB5\u7684\u8D77\u59CB\u884C\u3002\u6D4F\u89C8\u5668\u6CA1\u6709 onstart \u4E8B\u4EF6\uFF0C
   * \u9875\u9762\u7528\u300C\u4E0A\u4E00\u6BB5\u7684 onended\u300D\u5F53\u4E0B\u4E00\u6BB5\u7684\u5F00\u59CB\uFF1A\u4E24\u6BB5\u5728\u540C\u4E00\u6761 AudioContext \u65F6\u95F4\u8F74\u4E0A
   * \u9996\u5C3E\u76F8\u63A5\uFF08startAt \u4E25\u683C\u7B49\u4E8E\u4E0A\u4E00\u6BB5\u7684 end\uFF09\uFF0C\u4E8B\u4EF6\u4E0E\u91C7\u6837\u7EA7\u5BF9\u9F50\uFF1B\u4E2D\u95F4\u6709\u7A7A\u6863\u65F6
   * \u672C\u6BB5\u662F\u5355\u72EC\u6392\u7684\uFF08startAt = now+0.03\uFF09\uFF0C\u6392\u7A0B\u77AC\u95F4\u5C31\u89C6\u4F5C\u5F00\u59CB\u3002\u5168\u7A0B\u4E0D\u505A\u65F6\u95F4\u63A8\u7B97\u3002
   */
  function clearDoneState() {
    state.doneRanges = null;
    state.done = null;
    state.doneTaskId = '';
    var body = $('doneBody');
    if (body) body.innerHTML = '';
  }
  function paintDone() {
    var done = state.done;
    if (!done) return;
    var total = done.lines.length;
    var stage = $('doneStage');
    if (stage) stage.textContent = '\u5B8C\u6210' + (total > 1 ? ' \xB7 ' + (done.current + 1) + '/' + total : '');
    // \u9876\u680F\u53F3\u7AEF\u300C\u53E6\u6709 N \u6761\u300D\u8DDF\u6B63\u6587\u540C\u4E00\u5E27\u3001\u540C\u4E00\u65F6\u523B\u5237\u65B0\uFF08\u4E0D\u5355\u72EC\u8BA1\u65F6\uFF09\u3002
    var more = $('doneMore');
    if (more && state.doneMoreText !== undefined) more.textContent = state.doneMoreText;
    var body = $('doneBody');
    if (!body) return;
    body.innerHTML = '';
    // \u6B63\u6587\u533A\u9AD8\u5EA6\uFF1D\u6807\u9898\u4E0E\u8D34\u5E95\u6309\u94AE\u4E4B\u95F4\u7684\u5269\u4F59\u7A7A\u95F4\uFF08\u4E0D\u56FA\u5B9A 7\xD720\uFF09\uFF1A\u6309\u771F\u5B9E\u53EF\u89C6\u9AD8\u5EA6\u53D6\u6574\u884C\u6570\uFF0C
    // \u653E\u4E0D\u4E0B\u7684\u884C\u4EA4\u7ED9\u7A97\u53E3\u6EDA\u52A8/\u88C1\u526A\uFF0C\u6B63\u6587\u6C38\u8FDC\u4E0D\u4F1A\u538B\u5230\u6309\u94AE\u4E0A\u3002
    var visible = DONE.visibleLines;
    var avail = body.clientHeight;
    if (avail > 0) visible = Math.max(1, Math.min(DONE.visibleLines, Math.floor(avail / DONE.lineHeightPx)));
    var start = Math.max(0, Math.min(done.current - 2, Math.max(0, total - visible)));
    for (var i = start; i < Math.min(total, start + visible); i += 1) {
      var line = document.createElement('div');
      line.className = 'done-line' + (i === done.current ? ' cur' : '');
      line.textContent = done.lines[i];
      body.appendChild(line);
    }
  }
  /** \u5B57\u7B26\u4F4D\u7F6E \u2192 \u884C\uFF08\u4F9D\u636E\u5BBF\u4E3B\u7684 done.ranges\uFF0C\u7801\u70B9\u4E0B\u6807\uFF09\u3002 */
  function lineAtChar(pos) {
    var ranges = state.doneRanges;
    if (!Array.isArray(ranges) || ranges.length === 0) return 0;
    for (var i = 0; i < ranges.length; i += 1) {
      var range = ranges[i];
      if (Array.isArray(range) && pos < Number(range[1])) return i;
    }
    return ranges.length - 1;
  }
  /**
   * \u6717\u8BFB\u6BB5\u5F00\u59CB/\u7ED3\u675F\u5199\u8FDB\u9875\u9762\u4E8B\u4EF6\u533A\uFF08\u7528\u6237 2026-11-10\uFF1A\u6309\u6BB5\u6253\u5370\u65F6\u95F4\uFF0C\u65B9\u4FBF\u548C\u58F0\u97F3\u5BF9\u7167\uFF09\u3002
   * n = \u5BBF\u4E3B\u7ED9\u7684\u6BB5\u53F7\uFF08payload.index + 1\uFF09\u3002\u4E00\u6BB5 120ms \u5206\u5757\u6709\u591A\u4E2A AudioBufferSourceNode\uFF0C
   * \u5F00\u59CB\u53EA\u5728**\u7B2C\u4E00\u5757\u5F00\u59CB**\u65F6\u8BB0\u4E00\u6B21\uFF08payload.seq=0\uFF09\uFF0C\u7ED3\u675F\u53EA\u5728\u8FD9\u4E00\u6BB5\u7684\u6700\u540E\u4E00\u5757\uFF08final\uFF09\u8BB0\u4E00\u6B21\u3002
   */
  function logReadSegment(phase, meta, at) {
    if (!meta) return;
    var index = Number(meta.index);
    if (!isFinite(index)) return;
    if (phase === 'start' ? meta.first !== true : meta.final !== true) return;
    addEvent('progress', '\u6717\u8BFB\u6BB5 ' + (index + 1) + ' ' + (phase === 'start' ? '\u5F00\u59CB' : '\u7ED3\u675F')
      + ' at=' + Math.max(0, Number(at) || 0).toFixed(2) + 's');
  }
  /**
   * \u4E00\u6BB5 PCM **\u771F\u6B63\u5F00\u59CB**\u64AD\u653E\uFF1A\u9501\u5B9A\u5B83\u7684\u5B57\u7B26\u533A\u95F4 \u2192 \u9AD8\u4EAE\u8D77\u59CB\u884C\uFF08\u4E00\u6BB5\u8DE8\u591A\u884C\u53EA\u4EAE\u5F53\u524D\u884C\uFF0C
   * \u884C\u5185\u8FDB\u5EA6\u4E0D\u663E\u793A\uFF09\uFF1B\u540C\u65F6\u5199\u300C\u6717\u8BFB\u6BB5 n \u5F00\u59CB\u300D\u3002\u6D4F\u89C8\u5668\u6CA1\u6709 onstart\uFF1A\u4E0A\u4E00\u6BB5 onended
   * \u89E6\u53D1\u65F6\u672C\u6BB5\u6B63\u597D\u5728\u65F6\u95F4\u8F74\u4E0A\u5F00\u59CB\uFF08\u89C1 playPcm \u7684\u9996\u5C3E\u76F8\u63A5\u5224\u5B9A\uFF09\uFF0C\u6240\u4EE5\u90A3\u91CC\u8C03\u8FD9\u91CC\uFF1B
   * \u7A7A\u6863\u540E\u5355\u72EC\u6392\u7684\u6BB5\u5728\u6392\u7A0B\u77AC\u95F4\u8C03\u7528\uFF0830ms \u540E\u54CD\uFF0C\u8BEF\u5DEE\u8FDC\u5C0F\u4E8E\u4E00\u53E5\uFF0C\u7EDD\u4E0D\u4F1A\u63D0\u524D\u4E00\u53E5\uFF09\u3002
   */
  function segmentStarted(entry) {
    if (!entry || entry.started) return;
    entry.started = true;
    var meta = entry.meta || {};
    var ctx = state.audioCtx;
    logReadSegment('start', meta, ctx ? ctx.currentTime : entry.at);
    // \u6BCF\u6BB5\u771F\u7684\u5F00\u59CB\u54CD \u2192 \u4E0A\u62A5\u4E00\u6B21\uFF08\u5BBF\u4E3B tihu_status \u7684\u300C\u6717\u8BFB\u4E2D \xB7 \u7B2C N \u6BB5\u300D\u8BFB\u5B83\uFF0C\u4E0D\u9760\u731C\uFF09\u3002
    if (meta.read === 'done') reportPlayback('playing');
    if (meta.read !== 'done') return;
    var done = state.done;
    if (!done || state.screenMode !== 'done') return;
    var cs = Number(meta.cs);
    if (!isFinite(cs)) return;
    var line = lineAtChar(cs);
    if (line !== done.current) {
      done.current = line;
      paintDone();
    }
    if (window.__tihuAudioCheck) window.__tihuAudioCheck.doneLine = done.current;
  }
  /**
   * \u4E00\u6BB5 PCM \u64AD\u5B8C\uFF08onended\uFF0C\u771F\u5B9E\u4E8B\u4EF6\uFF09\uFF1A\u5199\u300C\u6717\u8BFB\u6BB5 n \u7ED3\u675F\u300D\uFF1B\u5982\u679C\u4E0B\u4E00\u6BB5\u5DF2\u7ECF\u5728\u540C\u4E00\u6761
   * \u65F6\u95F4\u8F74\u4E0A\u6392\u597D\uFF08entry.next\uFF09\uFF0C\u6B64\u523B\u5C31\u662F\u5B83\u7684\u5F00\u59CB \u2192 \u7ACB\u523B\u628A\u9AD8\u4EAE\u63A8\u8FDB\u5230\u5B83\u7684\u8D77\u59CB\u884C\u3002
   * \u4E0B\u4E00\u6BB5\u8FD8\u6CA1\u5230\uFF0C\u5C31\u505C\u5728\u5F53\u524D\u884C\u7B49\u5B83\u771F\u7684\u5F00\u59CB\uFF08\u7EDD\u4E0D\u6309\u65F6\u95F4\u63D0\u524D\u8DF3\uFF09\u3002
   */
  function segmentEnded(entry) {
    if (!entry) return;
    var meta = entry.meta || {};
    var ctx = state.audioCtx;
    logReadSegment('end', meta, ctx ? ctx.currentTime : entry.at + entry.duration);
    if (entry.next) segmentStarted(entry.next);
  }
  function renderDone(payload) {
    var raw = payload.done || {};
    var lines = (Array.isArray(raw.lines) ? raw.lines : []).map(function (line) { return String(line == null ? '' : line); })
      .filter(function (line) { return line.trim() !== ''; });
    var current = Math.max(0, Math.min(Math.max(0, lines.length - 1), Number(raw.current) || 0));
    // \u65B0\u7684\u4E00\u5C4F\u5B8C\u6210\u9875\uFF08\u91CD\u8BFB/\u8DF3\u6BB5/\u65B0\u4EFB\u52A1\uFF09\uFF1D\u65E7\u6392\u7A0B\u4E00\u5F8B\u4F5C\u5E9F\uFF1A\u4E0D\u6E05\u7684\u8BDD\u91CD\u8BFB\u4F1A\u548C\u4E0A\u4E00\u8F6E PCM
    // \u6392\u5728\u540C\u4E00\u6761\u65F6\u95F4\u8F74\u4E0A\uFF0C\u542C\u8D77\u6765\u5C31\u662F\u300C\u4E24\u904D\u53E0\u5728\u4E00\u8D77\u300D\u3002
    stopPcm();
    state.pausedAt = null;
    state.screenMode = 'done';
    state.hostAlert = false;
    state.highlightLock = false;
    state.done = { lines: lines, current: current };
    state.doneRanges = Array.isArray(raw.ranges) ? raw.ranges : null;
    state.doneTaskId = payload.taskId ? String(payload.taskId) : '';
    state.actions = Array.isArray(payload.actions) ? payload.actions : [];
    state.doneMoreText = payload.more && payload.more.text ? String(payload.more.text) : '';
    $('stage').style.display = 'none';
    $('doneTitle').textContent = payload.title || '';
    $('doneMore').textContent = state.doneMoreText;
    // \u5148\u6302 done-mode \u518D\u753B\u6B63\u6587\uFF1A\u6B63\u6587\u533A\u9AD8\u5EA6\u8981\u6309\u300C\u6309\u94AE\u8D34\u5E95\u540E\u7684\u5269\u4F59\u7A7A\u95F4\u300D\u5B9E\u6D4B\uFF0C
    // \u987A\u5E8F\u53CD\u4E86\u4F1A\u91CF\u5230 display:none \u7684 0\u3002\u4E09\u952E\u4E5F\u5148\u5EFA\u597D\uFF0C\u624D\u6709\u540C\u6837\u7684\u5E03\u5C40\u5C3A\u5BF8\u3002
    renderActions();
    applyScreenClass((payload.tone || 'ok') + ' done-mode' + (state.actions.length ? ' has-actions' : ''));
    paintDone();
  }

  /* \u6D3E\u5355\u56DE\u6267\u7684\u4E09\u62CD\u5706\u70B9\uFF1A\u5DF2\u5165\u961F / \u6392\u961F N \u4E2A / \u5F00\u59CB\u8DD1\uFF08\u5706\u70B9\u7531 CSS \u753B\uFF0C\u6587\u5B57\u7ED9\u72B6\u6001\uFF09 */
  function renderSteps(steps) {
    var screen = $('screen');
    var box = $('steps');
    state.steps = Array.isArray(steps) ? steps : [];
    box.innerHTML = '';
    if (!state.steps.length) { screen.classList.remove('steps-on'); return; }
    for (var i = 0; i < state.steps.length; i += 1) {
      if (i > 0) {
        var arrow = document.createElement('span');
        arrow.className = 'step-arrow';
        arrow.textContent = '\u2192';
        box.appendChild(arrow);
      }
      var step = document.createElement('span');
      step.className = 'step ' + (state.steps[i].state || 'pending');
      step.textContent = state.steps[i].label || '';
      box.appendChild(step);
    }
    screen.classList.add('steps-on');
  }

  /* \u5012\u8BA1\u65F6\u6761\uFF1A\u6587\u5B57\u7ED9\u79D2\u6570\uFF08\u7CBE\u786E\uFF09\uFF0C\u6761\u53EA\u7ED9\u611F\u89C9\uFF1B\u5230 0 \u5C31\u505C\u5728 0\uFF0C\u7531\u5BBF\u4E3B\u51B3\u5B9A\u4E0B\u4E00\u6B65 */
  function renderCountdown(countdown) {
    var screen = $('screen');
    var row = $('cdRow');
    clearInterval(state.countdownTimer);
    state.countdownTimer = 0;
    if (!countdown || typeof countdown.seconds !== 'number') {
      state.countdown = null;
      screen.classList.remove('cd-on');
      return;
    }
    var total = Number(countdown.totalSeconds);
    if (!Number.isFinite(total) || total <= 0) total = Number(countdown.seconds) || 1;
    state.countdown = { left: Math.max(0, Math.round(countdown.seconds)), total: total, text: countdown.text || '' };
    screen.classList.add('cd-on');
    var paint = function () {
      var cd = state.countdown;
      if (!cd) return;
      $('cdText').textContent = cd.text !== '' ? cd.text : (cd.left > 0 ? cd.left + ' \u79D2' : '\u5230\u70B9');
      $('cdFill').style.width = Math.max(0, Math.min(100, Math.round(cd.left / cd.total * 100))) + '%';
    };
    paint();
    state.countdownTimer = setInterval(function () {
      var cd = state.countdown;
      if (!cd) return;
      cd.left = Math.max(0, cd.left - 1);
      paint();
      if (cd.left <= 0) { clearInterval(state.countdownTimer); state.countdownTimer = 0; }
    }, 1000);
  }

  function renderScreen(payload) {
    var screen = $('screen');
    // \u6536\u5230\u4EFB\u4F55\u4E00\u5E27\u90FD\u987A\u624B\u91CD\u753B\u9876\u884C\uFF08\u65F6\u949F\u672C\u6765\u6BCF\u79D2 tick\uFF0C\u8FD9\u91CC\u518D\u8865\u4E00\u6B21\u4FDD\u8BC1\u540C\u4E00\u5E27\u91CC\u4E0D\u4F1A\u82B1\u6389\uFF09\u3002
    renderHomeTop();
    // \u79BB\u5F00\u5B8C\u6210\u9875\u5C31\u6536\u6389\u63A8\u8FDB\u8BA1\u65F6\u5668\uFF08\u5B8C\u6210\u9875\u81EA\u5DF1\u7684 7 \u884C\u9AD8\u4EAE\u4E0D\u80FD\u5E26\u5230\u522B\u7684\u5C4F\u4E0A\uFF09\u3002
    if (!(payload && payload.done)) clearDoneState();
    // 2026-11-09\uFF1A\u65E7\u4E3B\u9875\u4E0E\u65E7\u56DE\u7B54\u5C4F\u6574\u4F53\u5220\u9664\uFF1B\u5BBF\u4E3B\u4E5F\u4E0D\u4F1A\u518D\u53D1\u8FD9\u4E24\u79CD\u5E27\u3002
    // \u5BBF\u4E3B\u4E0D\u4F1A\u518D\u53D1\u8FD9\u4E24\u79CD\u5E27\uFF1B\u4E07\u4E00\u6536\u5230\u4E5F\u76F4\u63A5\u5FFD\u7565\uFF0C\u5C4F\u4E0A\u53EA\u8BA4\u65B0\u4E03\u5C4F\u3002
    if (payload && (payload.mode === 'home' || payload.mode === 'reply') && !payload.board) return;
    // \u56DE\u6267/\u5F85\u51B3\u7B56\u7684\u9644\u52A0\u5757\u6BCF\u5E27\u5148\u6536\u6389\uFF0C\u53EA\u6709\u672C\u5E27\u5E26\u4E86\u624D\u91CD\u753B\uFF08\u5426\u5219\u4E0A\u4E00\u5E27\u7684\u5706\u70B9/\u5012\u8BA1\u65F6\u4F1A\u7559\u5728\u5C4F\u4E0A\uFF09\u3002
    renderSteps(payload && payload.steps);
    renderCountdown(payload && payload.countdown);
    // \u4EFB\u52A1\u68CB\u76D8\uFF08\u5C4F 1\uFF0C\u542B\u7A7A\u6001\uFF09\uFF1Amode \u4E5F\u662F home\uFF0C\u4F46\u8D70 board \u5206\u652F\uFF08\u884C\u662F\u4EFB\u52A1\u4E0D\u662F\u9879\u76EE\uFF09\u3002
    if (payload && payload.board) {
      renderBoard(payload);
      return;
    }
    // \u5B8C\u6210\u9875\uFF1A\u9876\u680F + \u4EFB\u52A1\u540D\u5927\u6807\u9898 + 7 \u884C\u56DE\u7B54\u6458\u8981 + \u4E09\u952E\uFF08\u4E0D\u662F\u65E7\u7684\u72B6\u6001\u5C4F\uFF09\u3002
    if (payload && payload.done) {
      renderDone(payload);
      return;
    }
    state.screenMode = 'status';
    state.hostAlert = payload.tone === 'alert';
    // \u4E25\u683C\u6309 320\xD7240 \u89C4\u683C\u6392\u7248\uFF1Astage \u226410\u3001\u6807\u9898 \u226428 \u4E14\u5355\u884C\u3001\u6B63\u6587\u6700\u591A 3 \u884C \xD718 \u5B57\u3002
    // \u591A\u51FA\u6765\u7684\u5185\u5BB9\u7559\u5728\u4E8B\u4EF6\u533A\uFF0C\u5C4F\u5E55\u4E0A\u4E0D\u5141\u8BB8\u51FA\u73B0\u534A\u884C\u6216\u6EDA\u52A8\u6761\u3002
    var stageText = clipScreen(payload.stage || '', SCREEN.stageChars);
    // \u5C4F 6\u300C\u53E6\u6709 N \u6761\u300D\u6536\u8FDB\u72B6\u6001\u884C\u53F3\u7AEF\uFF08\u56FE 3\uFF1A\u5B8C\u6210 + \u53E6\u6709 2 \u6761\uFF09\u3002
    var moreText = payload.more && payload.more.text ? String(payload.more.text).trim() : '';
    if (moreText !== '') stageText = stageText === '' ? moreText : stageText + ' \xB7 ' + moreText;
    $('stage').textContent = stageText;
    // \u65B0\u56DB\u884C\u683C\u5F0F\u7B2C\u4E00\u884C\u5C31\u662F\u4F1A\u8BDD\u6807\u9898\uFF0C\u6CA1\u6709\u9636\u6BB5\u5C0F\u5B57\u65F6\u4E0D\u8981\u7559\u7A7A\u884C\u3002
    $('stage').style.display = stageText === '' ? 'none' : '';
    $('title').textContent = payload.title || '';
    var list = $('bullets');
    list.innerHTML = '';
    var rawBullets = payload.bullets || [];
    var askCards = payload.ask && Array.isArray(payload.ask.candidates) ? payload.ask.candidates : [];
    if (askCards.length > 0) {
      for (var ai = 0; ai < askCards.length; ai += 1) {
        var card = document.createElement('li');
        card.className = 'ask-card';
        var no = document.createElement('span');
        no.className = 'ask-no';
        no.textContent = String(askCards[ai].index || (ai + 1));
        var main = document.createElement('span');
        main.className = 'ask-main';
        var nm = document.createElement('span');
        nm.className = 'ask-name';
        nm.textContent = askCards[ai].projectName || '';
        var src = document.createElement('span');
        src.className = 'ask-source';
        src.textContent = askCards[ai].source || '';
        main.appendChild(nm);
        main.appendChild(src);
        card.appendChild(no);
        card.appendChild(main);
        list.appendChild(card);
      }
      rawBullets = [];
    }
    // \u7B2C\u56DB\u884C\u7EDF\u8BA1\uFF1A\u5C0F 2 \u53F7\u5B57\u53F7\uFF0C\u6309\u5B83\u81EA\u5DF1\u7684\u5B57\u53F7\u91CF\u5BBD\u4E0E\u6298\u884C\uFF0C\u4E0D\u518D\u5957\u6B63\u6587\u5B57\u7B26\u6570
    var tailCount = typeof payload.statsTail === 'number' ? payload.statsTail : 0;
    if (tailCount > rawBullets.length) tailCount = rawBullets.length;
    var headCount = rawBullets.length - tailCount;
    var statsFont = SCREEN.statsFontPx || 14;
    var statsWidth = (SCREEN.widthPx || 320) - 2 * (SCREEN.paddingPx || 8) - 4;
    var entries = fitLines(rawBullets.slice(0, headCount), SCREEN.maxBodyLines, SCREEN.bodyCharsPerLine).map(function (line) {
      return { text: line, stats: false };
    });
    for (var b = headCount; b < rawBullets.length; b += 1) {
      var wrapped = wrapPx(rawBullets[b], statsWidth, statsFont);
      for (var w = 0; w < wrapped.length; w += 1) entries.push({ text: wrapped[w], stats: true });
    }
    for (var e = 0; e < entries.length; e += 1) {
      var li = document.createElement('li');
      li.textContent = entries[e].text;
      if (entries[e].stats) {
        li.style.fontSize = statsFont + 'px';
        li.style.lineHeight = (SCREEN.statsLineHeightPx || 18) + 'px';
      }
      list.appendChild(li);
    }
    state.actions = Array.isArray(payload.actions) ? payload.actions : [];
    applyScreenClass((payload.tone || 'idle') + (state.actions.length ? ' has-actions' : '') + (payload.stage === '\u8FFD\u95EE' ? ' ask-mode' : '') + (payload.stage === '\u8FDB\u5EA6' ? ' detail-mode' : ''));
    renderActions();
    applyAudioRecovery();
  }

  function addEvent(kind, text) {
    var row = document.createElement('div');
    row.className = kind;
    row.textContent = new Date().toLocaleTimeString() + '  ' + text;
    $('events').appendChild(row);
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
  /* ---------- \u97F3\u9891\u89E3\u9501 ----------
     Chrome \u81EA\u52A8\u64AD\u653E\u7B56\u7565\uFF1A**\u6CA1\u6709\u7528\u6237\u624B\u52BF**\u521B\u5EFA\u7684 AudioContext \u662F suspended\u3002
     \u65E7\u5B9E\u73B0\u53EA new \u4E0D resume\uFF0C\u4E8E\u662F tts.audio \u5168\u90E8\u5230\u8FBE\u3001playPcm \u4E5F\u6392\u8FDB\u65F6\u95F4\u8F74\uFF0C
     \u4F46\u6C38\u8FDC\u4E0D\u51FA\u58F0\uFF08\u5237\u65B0\u9875\u9762\u540E\u5FC5\u73B0\uFF09\u3002\u66F4\u7CDF\u7684\u662F suspended \u65F6 ctx.currentTime \u51BB\u7ED3\uFF0C
     pcmNextTime \u7684\u7D2F\u52A0\u5168\u584C\u7F29\u5230\u540C\u4E00\u65F6\u523B\uFF0C\u4E00\u65E6\u6062\u590D\u4F1A\u8BA9\u6240\u6709\u5757\u540C\u65F6\u70B8\u54CD\u3002
     \u6240\u4EE5\uFF1A\u2460\u4EFB\u4F55\u64AD\u653E\u524D\u5148 resume\uFF1B\u2461suspended \u671F\u95F4\u4E22\u5F03 chunk \u5E76\u63D0\u793A\u70B9\u51FB\u89E3\u9501\uFF0C
     \u4E0D\u6392\u961F\uFF1B\u2462\u7B2C\u4E00\u6B21 pointerdown/keydown/touchstart \u81EA\u52A8\u89E3\u9501\u3002 */
  function resumeAudio() {
    var ctx = state.audioCtx;
    if (!ctx) return null;
    if (ctx.state !== 'suspended') return null;
    try {
      var task = ctx.resume();
      if (task && typeof task.then === 'function') task.then(function () {
        if (audioRunning(ctx)) { hideAudioWarn(); applyAudioRecovery(); }
      }).catch(function () { /* \u89E3\u9501\u5931\u8D25\uFF1A\u7B49\u4E0B\u4E00\u6B21\u624B\u52BF */ });
      return task;
    } catch (e) { return null; }
  }
  function showAudioWarn() {
    var warn = $('audioWarn');
    if (warn && warn.className.indexOf('on') < 0) warn.className = 'audio-warn on';
  }
  function hideAudioWarn() {
    var warn = $('audioWarn');
    if (warn) warn.className = 'audio-warn';
  }
  /** \u7981\u97F3/\u4E22\u5757\u662F\u5C4F\u5185\u6062\u590D\u72B6\u6001\uFF0C\u4E0D\u662F\u5C4F\u5916\u6A2A\u5E45\uFF1B\u540E\u7EED\u6B63\u5E38\u5C4F\u5E27\u4E5F\u4E0D\u80FD\u628A\u5B83\u62B9\u6389\u3002 */
  function applyAudioRecovery() {
    if (!state.droppedAudio || state.hostAlert) return;
    var message = audioRunning(state.audioCtx) ? '\u58F0\u97F3\u5DF2\u542F\u7528 \xB7 \u70B9\u91CD\u8BFB' : '\u70B9\u5C4F\u542F\u7528\u58F0\u97F3 \xB7 \u89E3\u9501\u540E\u70B9\u91CD\u8BFB';
    if (state.screenMode === 'status') {
      $('stage').style.display = '';
      $('stage').textContent = clipScreen(message, SCREEN.stageChars);
      $('screen').classList.add('alert');
    }
  }
  function markAudioDropped() {
    state.droppedAudio = true;
    showAudioWarn();
    applyAudioRecovery();
  }
  function audioRunning(ctx) {
    return ctx !== null && ctx !== undefined && ctx.state === 'running';
  }
  /**
   * \u505C\u6B62/\u91CD\u8BFB/\u6362\u5C4F\uFF1A\u6390\u6389\u5DF2\u6392\u7A0B\u7684 PCM\uFF0C\u5E76**\u6E05\u7A7A\u6BCF\u6BB5\u7684\u5F00\u59CB/\u7ED3\u675F\u56DE\u8C03**\u2014\u2014
   * \u9AD8\u4EAE\u4ECE\u6B64\u4E0D\u518D\u88AB\u4EFB\u4F55\u540E\u7EED\u4E8B\u4EF6\u63A8\u52A8\uFF08\u505C\u5728\u5B9E\u9645\u505C\u4F4F\u7684\u90A3\u4E00\u884C\uFF09\u3002
   * 2026-11-10\uFF1Aonended \u540C\u65F6\u627F\u62C5\u300C\u6717\u8BFB\u6BB5 n \u7ED3\u675F\u300D\u548C\u300C\u4E0B\u4E00\u6BB5\u5F00\u59CB\u300D\u4E24\u4EF6\u4E8B\uFF0C
   * \u5FC5\u987B\u5728\u8FD9\u91CC\u6458\u6389\uFF0C\u5426\u5219\u505C\u6B62\u540E\u961F\u5217\u91CC\u7684\u4E0B\u4E00\u6BB5\u4ECD\u4F1A\u628A\u9AD8\u4EAE\u5F80\u524D\u63A8\u3002
   */
  function stopPcm() {
    for (var i = 0; i < state.pcmSources.length; i += 1) {
      var source = state.pcmSources[i];
      source.onended = null;
      try { source.stop(); } catch (e) { /* \u5DF2\u7ED3\u675F */ }
    }
    state.pcmSources = [];
    state.pcmNextTime = 0;
    state.pcmLast = null;
    // \u88AB\u505C\u6B62\u7684\u8FD9\u4E00\u8F6E\u4E5F\u628A\u8BCA\u65AD\u884C\u6253\u51FA\u6765\uFF08\u5757\u6570/\u91CD\u53E0/\u91C7\u6837\u7387\u7167\u5B9E\u62A5\uFF0C\u65B9\u4FBF\u5BF9\u7167\u5B9E\u673A\u6742\u97F3\uFF09\u3002
    flushReadRound();
  }
  /**
   * \u6BCF\u5757\u9996\u5C3E\u5404 fadeMs \u7EBF\u6027\u6DE1\u5165\u6DE1\u51FA\uFF08\u539F\u4F4D\u6539 samples\uFF0C\u7F3A\u7701 5ms\uFF09\u3002
   * \u5B8C\u6210\u9875\u628A\u4E00\u6761\u5408\u6210\u97F3\u9891\u6309\u884C\u3001\u518D\u6309 120ms \u5207\u5757\u4E0B\u53D1\uFF0C\u5757\u8FB9\u754C\u5E38\u843D\u5728\u6CE2\u5F62\u4E2D\u95F4\uFF1A
   * \u76F4\u63A5\u62FC\u63A5\u5C31\u662F\u6BCF 120ms \u4E00\u58F0\u300C\u5494\u54D2\u300D\uFF1B\u6DE1\u5165\u6DE1\u51FA\u628A\u8FB9\u754C\u8DF3\u53D8\u538B\u5230\u542C\u4E0D\u89C1\u3002
   */
  function shapePcm(samples, rate, fadeMs) {
    var n = samples.length;
    var fade = Math.max(0, Math.round((Number(rate) || 24000) * ((Number(fadeMs) || 5) / 1000)));
    if (samples.length === 0) return 0;
    if (fade <= 1 || n <= 2) return 0;
    var span = Math.min(fade, Math.floor(n / 2));
    for (var i = 0; i < span; i += 1) {
      var gain = i / span;
      samples[i] *= gain;
      samples[n - 1 - i] *= gain;
    }
    return span;
  }
  /** \u5CF0\u503C\u9650\u5E45\uFF1A\u8D85\u8FC7 ceiling\uFF08\u9ED8\u8BA4 -1 dBFS \u2248 0.891\uFF09\u5C31\u6574\u5757\u7B49\u6BD4\u538B\u4E0B\u6765\uFF0C\u907F\u514D\u524A\u6CE2\u6210\u523A\u8033\u7834\u97F3\u3002 */
  function limitPcm(samples, ceiling) {
    var limit = Number(ceiling);
    if (!isFinite(limit) || limit <= 0) limit = 0.891;
    var peak = 0;
    for (var i = 0; i < samples.length; i += 1) {
      var abs = samples[i] < 0 ? -samples[i] : samples[i];
      if (abs > peak) peak = abs;
    }
    if (peak <= limit || peak <= 0) return peak;
    var gain = limit / peak;
    for (var j = 0; j < samples.length; j += 1) samples[j] *= gain;
    return peak;
  }
  /** \u6E05\u6389\u5DF2\u7ECF\u64AD\u5B8C\u7684 source\uFF1A\u540C\u4E00\u8F6E\u91CC\u522B\u8BA9\u4E0A\u4E00\u5757\u7684\u5C3E\u5DF4\u548C\u65B0\u5757\u6324\u5728\u540C\u4E00\u6761\u65F6\u95F4\u8F74\u4E0A\u3002 */
  function recycleSources(nowAt) {
    var keep = [];
    for (var i = 0; i < state.pcmSources.length; i += 1) {
      var source = state.pcmSources[i];
      var endAt = Number(source.__pcmEnd);
      if (isFinite(endAt) && endAt > nowAt - 0.002) { keep.push(source); continue; }
      try { source.onended = null; source.stop(); } catch (e) { /* \u5DF2\u7ED3\u675F */ }
    }
    state.pcmSources = keep;
  }
  /**
   * \u6717\u8BFB\u8BCA\u65AD\uFF08\u7528\u6237 2026-11-10 \u8981\u6C42\uFF09\uFF1A\u6BCF\u8F6E\u8BB0\u300C\u9996\u5757\u5B57\u8282\u6570 / \u603B\u5757\u6570 / \u662F\u5426\u53D1\u751F\u91CD\u53E0 / \u91C7\u6837\u7387\u300D\uFF0C
   * \u8FD9\u4E00\u8F6E\u64AD\u5B8C\uFF08\u6216\u88AB\u505C\u6B62\uFF09\u65F6\u5728\u4E8B\u4EF6\u533A\u6253\u4E00\u884C\uFF0C\u5B9E\u673A\u6709\u6742\u97F3\u65F6\u4E00\u773C\u80FD\u5BF9\u4E0A\u3002
   */
  function noteReadRound(rate, overlap, bytes, meta) {
    var first = meta !== null && meta !== undefined && meta.first === true && Number(meta.index) === 0;
    if (first) flushReadRound(); // \u4E0A\u4E00\u8F6E\u6CA1\u64AD\u5B8C\u5C31\u6765\u4E86\u65B0\u4E00\u8F6E\uFF1A\u5148\u628A\u4E0A\u4E00\u8F6E\u7ED3\u7B97\u6389
    if (state.readRound === null || state.readRound === undefined) {
      state.readRound = { blocks: 0, firstBytes: 0, sampleRate: 0, overlaps: 0 };
    }
    var round = state.readRound;
    round.blocks += 1;
    round.overlaps += overlap ? 1 : 0;
    if (!round.firstBytes) round.firstBytes = Number(bytes) || 0;
    round.sampleRate = Number(rate) || round.sampleRate || 24000;
  }
  function flushReadRound() {
    var round = state.readRound;
    state.readRound = null;
    if (!round || !round.blocks) return;
    addEvent('progress', '\u6717\u8BFB \xB7 \u5757 ' + round.blocks + ' \xB7 \u9996\u5757 ' + round.firstBytes + ' B \xB7 \u91C7\u6837\u7387 '
      + (round.sampleRate || 24000) + ' \xB7 \u91CD\u53E0 ' + round.overlaps);
  }
  function playPcm(base64, sampleRate, cache, meta) {
    if (!base64) return null;
    var ctx = ensureAudio();
    if (!ctx) { markAudioDropped(); return null; }
    // \u672A\u89E3\u9501\uFF1A\u5148 resume\uFF0C\u7B49\u4E0D\u5230 running \u5C31**\u4E22\u5F03\u8FD9\u6BB5**\u5E76\u63D0\u793A\u70B9\u4E00\u4E0B\u9875\u9762\u2014\u2014
    // \u7EDD\u4E0D\u6392\u961F\uFF08suspended \u65F6 currentTime \u51BB\u7ED3\uFF0C\u6392\u8FDB\u53BB\u7684\u65F6\u95F4\u8F74\u4E00\u65E6\u6062\u590D\u4F1A\u5168\u90E8\u70B8\u54CD\uFF09\u3002
    if (!audioRunning(ctx)) {
      resumeAudio();
      if (!audioRunning(ctx)) {
        state.pcmNextTime = 0;
        state.pcmLast = null;
        markAudioDropped();
        return null;
      }
    }
    try {
      var binary = atob(base64);
      // \u5C0F\u7AEF 16 bit \u6709\u7B26\u53F7\uFF08\u5BBF\u4E3B\u6309 pcm16 \u53D1\uFF0C\u91C7\u6837\u7387 24000\uFF09\uFF1A\u6309\u5BF9\u89E3\uFF0C**\u4E0D\u662F** float32\u3002
      // \u5C11\u89C1\u7684\u5947\u6570\u5B57\u8282\uFF08\u534A\u4E2A\u91C7\u6837\uFF09\u76F4\u63A5\u4E22\u5C3E\u5DF4\uFF0C\u907F\u514D\u6574\u6BB5\u9519\u4F4D\u6210\u566A\u58F0\u3002
      var count = Math.floor(binary.length / 2);
      var rate = Number(sampleRate);
      if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) rate = 24000;
      var samples = new Float32Array(count);
      for (var i = 0; i < count; i += 1) {
        var value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
        if (value >= 0x8000) value -= 0x10000;
        samples[i] = value / 32768;
      }
      // \u2460 \u6BCF\u5757\u9996\u5C3E\u5404 5ms \u7EBF\u6027\u6DE1\u5165\u6DE1\u51FA\uFF1APCM \u5207\u6210 120ms \u4E00\u5757\u65F6\uFF0C\u5757\u8FB9\u754C\u5E38\u5E38\u843D\u5728\u6CE2\u5F62\u4E2D\u95F4\uFF0C
      //    \u76F4\u63A5\u62FC\u63A5\u4F1A\u300C\u5494\u54D2\u300D\uFF08\u6BB5\u8FB9\u754C\u540C\u7406\uFF09\u3002\u6DE1\u5165\u6DE1\u51FA\u628A\u8DF3\u53D8\u538B\u5230\u542C\u4E0D\u51FA\u6765\u3002
      shapePcm(samples, rate, 5);
      // \u2461 \u5CF0\u503C\u9650\u5E45\u5230 -1 dBFS\uFF080.891\uFF09\uFF1A\u591A\u5757\u9996\u5C3E\u76F8\u63A5\u3001\u6216\u67D0\u6BB5\u589E\u76CA\u504F\u9AD8\u65F6\u4E0D\u81F3\u4E8E\u524A\u6CE2\u6210\u523A\u8033\u7684\u7834\u97F3\u3002
      limitPcm(samples, 0.891);
      var buffer = ctx.createBuffer(1, count, rate);
      buffer.copyToChannel(samples, 0);
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      // \u2462 \u6392\u7A0B\u7EDD\u4E0D\u91CD\u53E0\uFF1A\u8D77\u70B9 = max(\u73B0\u5728 + 30ms, \u4E0A\u4E00\u5757\u6392\u5230\u54EA\u513F)\u3002\u4E0A\u4E00\u5757\u5DF2\u7ECF\u8FC7\u671F\uFF08\u5361\u987F/\u4E22\u5E27\uFF09
      //    \u5C31\u6E05\u6389\u5B83\u7684\u6B8B\u7559\u3001\u4ECE now+30ms \u91CD\u65B0\u5BF9\u9F50 \u2014\u2014 \u7EDD\u4E0D\u628A\u4E24\u5757 start \u5728\u540C\u4E00\u65F6\u523B\uFF08\u53E0\u52A0\u4F1A\u7206\u97F3\uFF09\u3002
      var nowAt = ctx.currentTime;
      var prevEnd = Number(state.pcmNextTime) || 0;
      if (prevEnd > 0 && prevEnd < nowAt - 0.002) recycleSources(nowAt);
      var startAt = Math.max(nowAt + 0.03, prevEnd);
      var overlap = 0;
      for (var s = 0; s < state.pcmSources.length; s += 1) {
        var liveEnd = Number(state.pcmSources[s].__pcmEnd);
        if (isFinite(liveEnd) && liveEnd > startAt + 1e-6) overlap += 1;
      }
      source.start(startAt);
      state.pcmNextTime = startAt + buffer.duration;
      source.__pcmEnd = state.pcmNextTime;
      state.pcmSources.push(source);
      var entry = { source: source, at: startAt, duration: buffer.duration, meta: meta || null, next: null, started: false };
      // \u6717\u8BFB\u8BCA\u65AD\uFF08\u7528\u6237\u8981\u6C42\uFF09\uFF1A\u6BCF\u8F6E\u9996\u5757/\u603B\u5757\u6570/\u662F\u5426\u91CD\u53E0/\u91C7\u6837\u7387\uFF0C\u8FD9\u4E00\u8F6E\u64AD\u5B8C\u5199\u4E00\u884C\u5230\u4E8B\u4EF6\u533A\u3002
      noteReadRound(rate, overlap > 0, count, meta);
      // \u4E0A\u4E00\u6BB5\u6B63\u597D\u5728 startAt \u7ED3\u675F\uFF08\u540C\u4E00\u65F6\u95F4\u8F74\u9996\u5C3E\u76F8\u63A5\uFF09\u2192 \u5B83\u7684 onended \u5C31\u662F\u672C\u6BB5\u7684\u300C\u5F00\u59CB\u300D\u4E8B\u4EF6\uFF1B
      // \u4E2D\u95F4\u6709\u7A7A\u6863\u65F6\u6CA1\u6709\u53EF\u6302\u7684\u4E0A\u4E00\u6BB5\uFF0C\u6392\u7A0B\u77AC\u95F4\u5C31\u89C6\u4F5C\u5F00\u59CB\uFF0830ms \u540E\u771F\u7684\u54CD\uFF09\u3002
      var prev = state.pcmLast;
      var contiguous = prev !== null && Math.abs(startAt - (prev.at + prev.duration)) < 1e-6;
      if (contiguous) prev.next = entry; else segmentStarted(entry);
      state.pcmLast = entry;
      source.onended = function () {
        var index = state.pcmSources.indexOf(source);
        if (index >= 0) state.pcmSources.splice(index, 1);
        if (state.audioCtx && state.pcmNextTime <= state.audioCtx.currentTime + 0.05) state.highlightLock = false;
        // \u771F\u5B9E\u64AD\u5B8C\uFF1A\u8BB0\u300C\u6717\u8BFB\u6BB5 n \u7ED3\u675F\u300D\uFF1B\u540C\u4E00\u6761\u65F6\u95F4\u8F74\u4E0A\u7684\u4E0B\u4E00\u6BB5\u6B64\u523B\u5F00\u59CB \u2192 \u63A8\u8FDB\u9AD8\u4EAE\u3002
        segmentEnded(entry);
        // \u6717\u8BFB\u7ED3\u675F\u81EA\u68C0\uFF1A\u6700\u540E\u4E00\u5757\u64AD\u5B8C\u3001\u961F\u5217\u6E05\u7A7A \u2192 \u8BB0\u4E00\u884C\uFF08\u5BBF\u4E3B 60 \u79D2\u540E\u81EA\u52A8\u56DE\u68CB\u76D8\uFF09\u3002
        if (state.ttsFinalSeen && state.pcmSources.length === 0) {
          state.ttsFinalSeen = false;
          var endedOk = audioRunning(state.audioCtx);
          console.assert(endedOk, '[tihu] \u6717\u8BFB\u64AD\u5B8C\u65F6 AudioContext \u4E0D\u662F running\uFF1A' + (state.audioCtx && state.audioCtx.state));
          addEvent(endedOk ? 'done' : 'alert', endedOk ? '\u6717\u8BFB\u7ED3\u675F\uFF1A60 \u79D2\u540E\u81EA\u52A8\u56DE\u68CB\u76D8' : '\u6717\u8BFB\u7ED3\u675F\u65F6\u97F3\u9891\u4ECD\u672A\u89E3\u9501\uFF08\u70B9\u4E00\u4E0B\u5C4F\u5E55\u518D\u70B9\u91CD\u8BFB\uFF09');
          flushReadRound();
          reportPlayback('idle');
        }
      };
      // \u91CD\u8BFB\u7F13\u5B58\uFF08\u672C\u8F6E\u5B8C\u6574 PCM\uFF09\uFF1B\u8BD5\u542C\u97F3\u9891\u4E0D\u8FDB\u7F13\u5B58\uFF08\u5426\u5219\u4E0B\u6B21\u300C\u91CD\u8BFB\u300D\u4F1A\u5FF5\u6210\u8BD5\u542C\u53E5\uFF09\u3002
      return entry;
    } catch (e) { markAudioDropped(); /* \u89E3\u7801\u5931\u8D25\uFF1A\u5C4F\u5185\u4FDD\u7559\u91CD\u8BFB\u6062\u590D */ }
    return null;
  }
  /**
   * \u64AD\u653E\u63A7\u5236\uFF08\u89C4\u683C\u4E66 \xA77 \u7B2C 2 \u5904\uFF09\uFF1A\u4ECE\u300C\u624B\u6307\u70B9\u5C4F\u300D\u7684 stop/replay/taskBoard/prev/next \u5206\u652F\u91CC
   * \u62BD\u51FA\u6765\uFF0C\u8BA9\u9875\u9762\u6309\u94AE\u4E0E\u5BBF\u4E3B playback.control \u8D70**\u540C\u4E00\u5957**\u52A8\u4F5C\u3002
   *
   * \u7C92\u5EA6\uFF08\xA78.5\uFF0C\u91CD\u8981\u9650\u5236\uFF09\uFF1A\u6682\u505C/\u7EE7\u7EED\u662F**\u6BB5\u7EA7**\u7684 \u2014\u2014 \u6682\u505C\uFF1D\u6E05\u7A7A\u5DF2\u6392\u7A0B\u961F\u5217\u5E76\u8BB0\u4F4F\u300C\u7B2C N \u6BB5\u300D\uFF0C
   * \u7EE7\u7EED\uFF1D\u5BBF\u4E3B\u4ECE\u8BE5\u6BB5\u7B2C\u4E00\u4E2A\u5B57\u91CD\u53D1 PCM\uFF0C\u672C\u884C\u4F1A\u91CD\u5FF5 1\u20133 \u79D2\u3002\u7EDD\u4E0D\u8DF3\u5B57\u3001\u4E0D\u9519\u4F4D\u3002
   */
  function applyPlayback(action, meta) {
    var info = meta || {};
    if (action === 'stop') {
      stopPcm();
      state.pausedAt = null;
      reportPlayback('idle');
      return { ok: true };
    }
    if (action === 'pause') {
      var hasAudio = state.pcmSources.length > 0;
      if (!hasAudio && !state.done) return { ok: false, reason: 'nothing-playing' };
      var segment = state.done ? state.done.current + 1 : 1;
      stopPcm();
      state.pausedAt = { segment: segment, line: segment - 1, taskId: state.doneTaskId };
      reportPlayback('paused');
      return { ok: true, segment: segment };
    }
    if (action === 'resume' || action === 'seek') {
      var from = info.from || {};
      var wanted = Number(from.segment);
      if (!isFinite(wanted) || wanted < 1) wanted = state.pausedAt ? state.pausedAt.segment : 1;
      if (!state.done) {
        state.pausedAt = null;
        return { ok: false, reason: 'no-done-screen' };
      }
      stopPcm();
      var index = Math.max(0, Math.min(state.done.lines.length - 1, Math.round(wanted) - 1));
      state.done.current = index;
      paintDone();
      state.pausedAt = null;
      reportPlayback('playing');
      return { ok: true, segment: index + 1 };
    }
    return { ok: false, reason: 'unknown-action' };
  }
  /** \u8BD5\u542C\u63D0\u793A\u97F3\uFF1A0.6 \u79D2 440Hz \u6B63\u5F26\uFF0C\u97F3\u91CF\u4E2D\u7B49\uFF08\u76F4\u63A5\u8BC1\u660E\u97F3\u9891\u901A\u8DEF\u53EF\u7528\uFF09\u3002 */
  function playBeep() {
    var ctx = state.audioCtx;
    if (!ctx || !audioRunning(ctx)) return false;
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      var now = ctx.currentTime;
      // \u97F3\u91CF\u4E2D\u7B49 + \u4E24\u7AEF\u5404 20ms \u6E10\u5165\u6E10\u51FA\uFF0C\u907F\u514D\u7206\u97F3\u3002
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
      gain.gain.setValueAtTime(0.12, now + 0.58);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.62);
      return true;
    } catch (e) { return false; }
  }
  /**
   * \u8BD5\u542C\u6309\u94AE\uFF1A\u5148\u89E3\u9501\u97F3\u9891\u3002
   *   1) \u672C\u8F6E\u5DF2\u6709\u7F13\u5B58\u97F3\u9891 \u2192 \u91CD\u64AD\u7F13\u5B58\uFF08\u73B0\u72B6\u4E0D\u53D8\uFF09\uFF1B
   *   2) \u6CA1\u6709\u7F13\u5B58 \u2192 \u53D1 tts.sample \u8BA9\u5BBF\u4E3B\u5FF5\u4E00\u53E5\u793A\u4F8B\uFF0C\u8D70\u4E0E\u6B63\u5F0F\u6717\u8BFB\u5B8C\u5168\u540C\u4E00\u6761\u94FE\u8DEF
   *      \uFF08edge-tts \u4E91\u5065 \u2192 \u5931\u8D25\u6309\u539F\u89C4\u5219\u56DE\u9000\uFF09\u3002\u65E7\u5B9E\u73B0\u8FD9\u91CC\u53EA\u4F1A\u54CD 0.6 \u79D2\u561F\u58F0\uFF0C
   *      \u7528\u6237\u4EE5\u4E3A\u574F\u4E86\u2014\u2014\u561F\u58F0\u964D\u7EA7\u4E3A\u300C\u5408\u6210\u5F7B\u5E95\u5931\u8D25\u300D\u65F6\u7684\u515C\u5E95\u63D0\u793A\u3002
   */
  function audioTest() {
    var hint = $('audioTestHint');
    var setHint = function (text) { if (hint) hint.textContent = text; };
    var ctx = ensureAudio();
    if (!ctx) { setHint('\u8FD9\u53F0\u8BBE\u5907\u6CA1\u6709 WebAudio\uFF0C\u65E0\u6CD5\u8BD5\u542C'); return; }
    var run = function () {
      if (audioRunning(ctx)) hideAudioWarn();
      if (!audioRunning(ctx)) { showAudioWarn(); setHint('\u65E0\u97F3\u9891\uFF08\u70B9\u6211\u5148\uFF09\uFF1A\u6D4F\u89C8\u5668\u8FD8\u6CA1\u89E3\u9501\uFF0C\u5148\u70B9\u4E00\u4E0B\u5C4F\u5E55'); return; }
      state.samplePending = true;
      setHint('\u6B63\u5728\u5408\u6210\u8BD5\u542C\u8BED\u97F3\uFF08edge-tts \u4E91\u5065\uFF09\u2026');
      send('tts.sample', {});
      clearTimeout(state.sampleTimer);
      // \u515C\u5E95\uFF1A\u5408\u6210\u5F7B\u5E95\u5931\u8D25/\u5BBF\u4E3B\u6CA1\u56DE\u97F3\u65F6\uFF0C\u561F\u4E00\u58F0 + \u660E\u8BF4\u5931\u8D25\uFF08\u4E0D\u9759\u9ED8\uFF09\u3002
      state.sampleTimer = setTimeout(function () {
        if (!state.samplePending) return;
        state.samplePending = false;
        var beeped = playBeep();
        setHint(beeped ? '\u8BD5\u542C\u5931\u8D25\uFF1A\u5DF2\u6539\u7528\u63D0\u793A\u97F3\uFF08\u539F\u56E0\u770B\u4E8B\u4EF6\u533A\u7EA2\u5B57\uFF09' : '\u8BD5\u542C\u5931\u8D25\uFF1A\u5408\u6210\u6CA1\u6709\u8FD4\u56DE\uFF08\u770B\u4E8B\u4EF6\u533A\u7EA2\u5B57\uFF09');
        addEvent('alert', '\u9519\u8BEF\uFF1A\u8BD5\u542C\u8BED\u97F3\u6CA1\u6709\u8FD4\u56DE\uFF08\u5BBF\u4E3B TTS \u6CA1\u54CD\u5E94\u8BE5\u8BF7\u6C42\uFF09');
      }, 15000);
    };
    var task = resumeAudio();
    if (task && typeof task.then === 'function') task.then(run, run);
    else run();
  }
  /** \u6536\u5230\u8BD5\u542C\u97F3\u9891\uFF1A\u64AD\u653E + \u660E\u786E\u56DE\u6267\uFF1B\u8BD5\u542C PCM \u4E0D\u8FDB\u672C\u8F6E\u6717\u8BFB\u7F13\u5B58\u3002 */
  function playSampleAudio(base64, sampleRate) {
    state.samplePending = false;
    state.ttsChunks = 0;
    state.ttsFinalSeen = false;
    clearTimeout(state.sampleTimer);
    var played = playPcm(base64, sampleRate, false);
    var hint = $('audioTestHint');
    if (played) {
      if (hint) hint.textContent = '\u5DF2\u64AD\u653E\u8BD5\u542C\u8BED\u97F3';
      addEvent('progress', '\u8BD5\u542C\uFF1A\u5DF2\u64AD\u653E\u8BD5\u542C\u8BED\u97F3');
      return;
    }
    if (hint) hint.textContent = '\u8BD5\u542C\u5931\u8D25\uFF1A\u64AD\u653E\u88AB\u6D4F\u89C8\u5668\u62E6\u4E86\uFF0C\u70B9\u4E00\u4E0B\u5C4F\u5E55\u518D\u8BD5';
    addEvent('alert', '\u8BD5\u542C\u5931\u8D25\uFF1A\u64AD\u653E\u88AB\u6D4F\u89C8\u5668\u62E6\u4E86\uFF08\u5148\u70B9\u4E00\u4E0B\u5C4F\u5E55\u89E3\u9501\u97F3\u9891\uFF09');
  }
  /* \u4E00\u6B21\u6027\u89E3\u9501\uFF1A\u7B2C\u4E00\u6B21\u771F\u5B9E\u624B\u52BF\u91CC resume\uFF0C\u5E76\u64A4\u6389\u300C\u70B9\u4E00\u4E0B\u542F\u7528\u58F0\u97F3\u300D\u6A2A\u5E45\u3002 */
  (function installUnlock() {
    var handler = function () {
      resumeAudio();
      if (state.audioCtx && audioRunning(state.audioCtx)) hideAudioWarn();
    };
    var opts = { once: true, passive: true };
    document.addEventListener('pointerdown', handler, opts);
    document.addEventListener('keydown', handler, opts);
    document.addEventListener('touchstart', handler, opts);
    var warn = $('audioWarn');
    if (warn) warn.onclick = function () { resumeAudio(); if (state.audioCtx && audioRunning(state.audioCtx)) hideAudioWarn(); };
  })();

  /* ---------- \u97F3\u8272\u9009\u62E9 ---------- */
  function renderVoiceSelect() {
    var select = $('voiceSelect');
    if (!select) return;
    select.innerHTML = '';
    for (var i = 0; i < state.voices.length; i += 1) {
      var voice = state.voices[i];
      var option = document.createElement('option');
      option.value = voice.name;
      // \u9ED8\u8BA4\u9879\u662F edge \u4E91\u5065\uFF1BKokoro \u97F3\u8272\uFF08zf_/zm_\uFF09\u9009\u4E2D\u5373\u624B\u52A8\u5207\u5230\u672C\u5730\u515C\u5E95\uFF0C\u540D\u5B57\u5FC5\u987B\u53EF\u533A\u5206\uFF0C
      // \u5426\u5219 100 \u4E2A\u9ED8\u8BA4\u9879\u5168\u5199\u300C\u9ED8\u8BA4\u97F3\u8272\u300D\u5C31\u9009\u4E0D\u51FA\u6765\uFF08\u5207\u8FC7\u53BB\u7684\u97F3\u8272\u8BBE\u7F6E\u4E5F\u4E0D\u80FD\u4E22\uFF09\u3002
      if (voice.name === 'default') {
        option.textContent = voice.note ? String(voice.note) : '\u9ED8\u8BA4\u97F3\u8272';
      } else if (voice.kind === 'default') {
        option.textContent = voice.name + (voice.note ? '\uFF08' + String(voice.note).replace('\u672C\u5730 Kokoro \xB7 ', '') + '\uFF09' : '');
      } else {
        option.textContent = voice.name + (voice.durationMs ? '\uFF08' + Math.round(voice.durationMs / 1000) + 's\uFF09' : '');
      }
      if (voice.name === state.voice) option.selected = true;
      select.appendChild(option);
    }
    var engine = state.voiceEngine;
    if (engine && engine.available === false) {
      $('voiceHint').textContent = '\u65E0\u8BED\u97F3\uFF1A' + (engine.error || '\u5728\u7EBF\u515C\u5E95\u4E0D\u53EF\u7528\u4E14\u672C\u5730\u5F15\u64CE\u672A\u5C31\u7EEA') + '\uFF08\u672C\u6761\u53EA\u663E\u793A\u6587\u5B57\uFF09\u3002';
    } else {
      var model = (engine && engine.model) || '\u672C\u5730\u5F15\u64CE';
      if (model.indexOf('edge-tts') >= 0 && model.indexOf('Kokoro') < 0) {
        $('voiceHint').textContent = '\u4E3B\u5F15\u64CE\uFF1Aedge-tts \u4E91\u5065(Yunjian) / \u97F3\u8272\u9ED8\u8BA4\uFF1B\u9009 zf_/zm_ \u97F3\u8272\u5373\u624B\u52A8\u5207\u5230\u672C\u5730 Kokoro\uFF08\u79BB\u7EBF\u515C\u5E95\uFF09\u3002\u4EC5\u53EF\u7528\u4E8E\u4F60\u672C\u4EBA\u6216\u5DF2\u83B7\u6388\u6743\u7684\u97F3\u8272\u3002';
      } else {
        $('voiceHint').textContent = '\u672C\u5730 Kokoro\uFF1A' + model + ' / \u97F3\u8272 ' + state.voice + '\u3002\u4EC5\u53EF\u7528\u4E8E\u4F60\u672C\u4EBA\u6216\u5DF2\u83B7\u6388\u6743\u7684\u97F3\u8272\uFF1B\u53C2\u8003\u97F3\u9891\u53EA\u5728\u672C\u673A\u5904\u7406\u3002';
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
    // \u6B63\u5728\u62E8\u53F7 = \u8FDE\u63A5\u4E2D\uFF08\u4FE1\u53F7\u67F1\u7070\uFF09\uFF1B\u8FD9\u4E00\u4EFD\u72B6\u6001\u540C\u65F6\u5582\u9996\u9875\u90A3\u4E09\u683C\u4FE1\u53F7\u67F1\uFF0C\u4E0D\u65B0\u589E\u534F\u8BAE\u5B57\u6BB5\u3002
    setConnState('connecting');
    ws.onopen = function () {
      $('conn').textContent = '\u5DF2\u8FDE\u63A5';
      $('conn').className = 'on';
      setConnState('online');
      state.clientId = state.clientId || ('web-' + Math.random().toString(36).slice(2, 10));
      // \u7EDF\u4E00\u6307\u6325\u662F\u552F\u4E00\u5165\u53E3\uFF1A\u6C38\u8FDC\u88F8 hello\uFF08\u5BBF\u4E3B\u7ED1\u300C\u9E48\u9E55\u6307\u6325\u53F0\u300D\uFF0C\u5C4F\u4E0A\u662F\u4EFB\u52A1\u68CB\u76D8\uFF09\u3002
      sendHello('', false);
      // \u89C4\u683C\u4E66 \xA76.3\uFF1A\u8FDE\u4E0A\u5C31\u8865\u4E00\u6761\u300C\u7A7A\u95F2\u300D\uFF0C\u5BBF\u4E3B\u4E22\u6389\u4E0A\u4E00\u8F6E\u8FDE\u63A5\u7559\u4E0B\u7684\u6717\u8BFB/\u6682\u505C\u5047\u8BBE
      // \uFF08\u5426\u5219\u65AD\u7EBF\u91CD\u8FDE\u540E tihu_status \u4F1A\u62A5\u65E7\u7684\u300C\u6717\u8BFB\u4E2D\u300D\uFF09\u3002
      reportPlayback('idle');
      send('voice.list', {});
      // \u4E91\u7AEF\u97F3\u8272\u53EA\u5728\u672C\u9875\u624B\u5DE5\u6539\u8FC7\uFF08localStorage \u6709\u503C\uFF09\u65F6\u624D\u4E0A\u884C\uFF1B\u6CA1\u6539\u8FC7\u5C31\u4E0D\u53D1\uFF0C
      // \u8BA9\u5BBF\u4E3B\u7528\u300C\u8BBE\u7F6E \u2192 \u4E2A\u4EBA\u52A9\u624B \u2192 \u9E48\u9E55\u7AEF \u2192 \u9ED8\u8BA4\u4E91\u97F3\u8272\u300D\uFF08\u6216 TIHU_EDGE_VOICE\uFF09\u2014\u2014
      // \u4EE5\u524D\u6BCF\u6B21\u8FDE\u4E0A\u90FD\u628A\u672C\u9875\u5199\u6B7B\u7684\u4E91\u5065\u63A8\u4E0A\u53BB\uFF0C\u7B49\u4E8E\u628A\u5BBF\u4E3B\u7684\u9ED8\u8BA4\u503C\u538B\u6389\u3002
      (function () {
        var override = '';
        try { override = localStorage.getItem('tihu.edgeVoice') || ''; } catch (e) { /* \u5FFD\u7565 */ }
        var select = $('edgeVoiceSelect');
        var payload = { name: state.voice || 'default', offlineOnly: $('offlineOnly').checked };
        if (override && select && select.querySelector('option[value="' + override + '"]')) { payload.edgeVoice = override; }
        try { send('voice.select', payload); } catch (e) { /* \u5FFD\u7565 */ }
      })();
      clearInterval(state.retryTimer);
      state.retryTimer = setInterval(function () { send('ping', { nonce: String(Date.now()) }); }, 25000);
    };
    ws.onclose = function (event) {
      $('conn').textContent = '\u5DF2\u65AD\u5F00' + (event && event.code ? '\uFF08' + event.code + '\uFF09' : '');
      $('conn').className = 'off';
      // \u65AD\u5F00\uFF1A\u5C4F\u5185\u53EA\u9760\u4FE1\u53F7\u67F1\u53D8\u7EA2\u533A\u5206\uFF0C\u4E0D\u518D\u5F80\u90A3\u4E00\u884C\u524D\u9762\u585E\u300C\u79BB\u7EBF \xB7 \u300D\u6587\u5B57\uFF08\u90A3\u4E00\u884C\u73B0\u5728\u662F\u65F6\u949F\uFF09\u3002
      setConnState('offline');
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
  /* ---------- \u8BBE\u5907\u56DE\u6267 / \u64AD\u653E\u72B6\u6001\uFF082026-11-10\uFF0C\u89C4\u683C\u4E66 \xA76.2\uFF09 ----------
     \u5BBF\u4E3B\u4E0B\u53D1\u5E26 opId \u7684\u4E0B\u884C\uFF08playback.control / voice.listen / session.ended / device.config\uFF09
     \u5FC5\u987B\u56DE\u4E00\u6761 device.ack\uFF0C\u5426\u5219\u5DE5\u5177\u53EA\u80FD\u7B49 1.5 \u79D2\u8D85\u65F6\u3001\u7ED9\u7528\u6237\u4E00\u53E5\u300C\u8BBE\u5907\u672A\u56DE\u6267\u300D\u3002
     opId \u4FDD\u7559\u6700\u8FD1 32 \u4E2A\uFF1A\u540C\u4E00\u4E2A opId \u7B2C\u4E8C\u6B21\u5230\u8FBE\u53EA\u56DE duplicate\uFF0C\u4E0D\u91CD\u590D\u6267\u884C\u3002 */
  /** \u8BBE\u5907\u81EA\u62A5\u7684\u300C\u73B0\u5728\u5728\u54EA\u4E00\u5C4F\u300D\uFF08\u76F4\u63A5\u8FDB\u5DE5\u5177\u8FD4\u56DE\u7684\u7B2C\u4E8C\u6BB5\uFF0C\u6BD4\u5BBF\u4E3B\u731C\u7684\u53EF\u4FE1\uFF09\u3002 */
  function stageEcho() {
    if (state.listenOn) return '\u5728\u542C';
    if (state.screenMode === 'board') {
      var board = state.board || {};
      var page = board.page || {};
      var index = Number(page.index) || 0;
      var total = Math.max(1, Number(page.total) || 1);
      return '\u68CB\u76D8\u7B2C ' + (index + 1) + '/' + total + ' \u9875';
    }
    if (state.screenMode === 'done' && state.done) {
      var lines = state.done.lines.length;
      return '\u5B8C\u6210 \u7B2C ' + (state.done.current + 1) + '/' + lines + ' \u884C';
    }
    var stage = $('stage') ? String($('stage').textContent || '') : '';
    return stage !== '' ? stage : '\u72B6\u6001\u5C4F';
  }
  /** \u56DE\u4E00\u6761 device.ack\uFF1Aok / duplicate / stage \u90FD\u7531\u9875\u9762\u81EA\u5DF1\u8BF4\u3002 */
  function ackDown(payload, extra) {
    if (!payload || typeof payload.opId !== 'string' || payload.opId === '') return false;
    var duplicated = state.opIds.indexOf(payload.opId) >= 0;
    if (!duplicated) {
      state.opIds.push(payload.opId);
      if (state.opIds.length > 32) state.opIds.shift();
    }
    var body = { opId: payload.opId, ok: true, duplicate: duplicated, stage: stageEcho() };
    if (extra) for (var key in extra) { if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key]; }
    send('device.ack', body);
    return duplicated;
  }
  /** \u4E0A\u62A5\u64AD\u653E\u72B6\u6001\uFF08\u9875\u9762\u662F\u552F\u4E00\u5199\u8005\uFF09\uFF1A\u6BCF\u6BB5\u5F00\u59CB/\u7ED3\u675F\u3001\u6682\u505C/\u7EE7\u7EED/\u505C\u6B62\u3001\u8FDB\u51FA\u8046\u542C\u3002 */
  function reportPlayback(phase, extra) {
    var body = { phase: phase, at: Date.now() };
    if (state.doneTaskId) body.taskId = state.doneTaskId;
    if (state.done && state.done.lines && state.done.lines.length) {
      body.segment = state.done.current + 1;
      body.line = state.done.current;
      body.total = state.done.lines.length;
      var range = state.doneRanges && state.doneRanges[state.done.current];
      if (range && typeof range[0] === 'number') body.charStart = range[0];
    }
    if (extra) for (var key in extra) { if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key]; }
    try { send('playback.state', body); } catch (e) { /* \u8FDE\u63A5\u65AD\u4E86\u5C31\u4E22\u6389 */ }
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
        // \u5C4F\u5E27\u4E0D\u80FD\u6E05\u6717\u8BFB\u961F\u5217\uFF1A\u5BBF\u4E3B\u56DE\u590D\u5E27\u7684 stage \u6052\u4E3A\u300C\u56DE\u7B54\u4E2D\u300D\uFF0C\u65E7\u5B9E\u73B0\u5224\u65AD\u7684
        // stage === '\u56DE\u590D' \u4ECE\u672A\u547D\u4E2D\uFF08\u6B7B\u4EE3\u7801\uFF0C2026-11-07 \u65AD\u97F3\u8C03\u67E5\u786E\u8BA4\uFF09\u3002
        // \u6E05\u961F\u5217\u53EA\u7559\u7ED9\u300C\u7528\u6237\u65B0\u7684\u8BED\u97F3\u8F93\u5165\u300D\uFF08transcript \u5206\u652F\uFF09\uFF0C\u5426\u5219\u5FF5\u5230\u4E00\u534A\u4F1A\u88AB\u81EA\u5DF1\u7684\u5C4F\u5E27\u6E05\u6389\u3002
        renderScreen(payload);
        break;
      case 'transcript':
        state.lastTranscript = payload.text || '';
        state.audioPending = false;
        clearTimeout(state.audioTimer);
        // \u7528\u6237\u65B0\u4E00\u8F6E\u8F93\u5165 = \u65B0\u4E00\u8F6E\u6717\u8BFB\uFF0C\u505C\u6389\u4E0A\u4E00\u8F6E\u6B8B\u7559\u3002
        $('transcript').textContent = state.lastTranscript;
        $('transcript').className = '';
        addEvent('progress', '\u8F6C\u5199\uFF1A' + state.lastTranscript);
        break;
      case 'tts.audio': {
        // \u8BD5\u542C\u97F3\u9891\uFF1A\u53EA\u64AD\u3001\u4E0D\u63A8\u8FDB\u9AD8\u4EAE\u3001\u4E0D\u8FDB\u672C\u8F6E\u6717\u8BFB\u7F13\u5B58\uFF08\u8BD5\u542C\u4E0D\u7B97\u4E00\u8F6E\u56DE\u590D\uFF09\u3002
        if (payload.sample === true) {
          resumeAudio();
          playSampleAudio(String(payload.data || ''), Number(payload.sampleRate) || 24000);
          break;
        }
        // \u6B63\u5F0F\u6717\u8BFB\uFF08\u5B8C\u6210\u9875/\u56DE\u7B54\u9875\uFF09\uFF1A\u5BBF\u4E3B\u6309\u5757\u4E0B\u53D1 24kHz PCM\uFF0C\u8FD9\u91CC\u6392\u961F\u64AD\u653E\u3002
        // 2026-11-09 \u65AD\u97F3\u6839\u56E0\uFF1A\u4E0A\u4E00\u8F6E\u5220\u300C\u65E7\u6717\u8BFB\u94FE\u8DEF\u300D\u65F6\u628A\u8FD9\u4E00\u6BB5\u4E00\u8D77\u5220\u4E86\uFF0C\u53EA\u5269\u8BD5\u542C\u5206\u652F\uFF0C
        // \u4E8E\u662F tts.audio \u5168\u90E8\u5230\u8FBE\u3001\u9875\u9762\u4E00\u4E2A\u5B57\u8282\u90FD\u4E0D\u64AD\uFF08\u5B8C\u6210\u9875\u770B\u7740\u5C31\u662F\u6CA1\u58F0\u97F3\uFF09\u3002
        resumeAudio();
        var audioRate = Number(payload.sampleRate) || 24000;
        if (audioRate !== 24000) {
          console.warn('[tihu] \u6717\u8BFB\u91C7\u6837\u7387\u5F02\u5E38', audioRate);
          addEvent('alert', '\u6717\u8BFB\u91C7\u6837\u7387\u5F02\u5E38\uFF1A' + audioRate + '\uFF08\u671F\u671B 24000\uFF09');
        }
        var cs = Number(payload.charStart);
        var ce = Number(payload.charEnd);
        var segIndex = Number(payload.index);
        var chunkPlayed = playPcm(String(payload.data || ''), audioRate, true, {
          index: isFinite(segIndex) ? segIndex : 0,
          cs: isFinite(cs) ? cs : -1,
          ce: isFinite(ce) ? ce : -1,
          first: Number(payload.seq) === 0,
          final: payload.final === true,
          read: payload.read === 'done' ? 'done' : '',
        });
        if (chunkPlayed) {
          state.ttsChunks += 1;
          window.__tihuAudioCheck = { chunks: state.ttsChunks, lastRate: audioRate, lastAt: Date.now(), playing: state.pcmSources.length };
          if (state.ttsChunks === 1) addEvent('progress', '\u6717\u8BFB\u5F00\u59CB\uFF1A' + audioRate + 'Hz');
          if (payload.final === true) { state.ttsFinalSeen = true; addEvent('progress', '\u6717\u8BFB\uFF1A\u6700\u540E\u4E00\u5757\u5DF2\u6392\u5165\u64AD\u653E\u961F\u5217'); }
        } else {
          state.ttsDropped += 1;
        }
        break;
      }
      case 'voice.list': {
        state.voices = Array.isArray(payload.voices) ? payload.voices : [];
        state.voiceEngine = payload.engine || null;
        if (typeof payload.selected === 'string' && payload.selected !== '') state.voice = payload.selected;
        renderVoiceSelect();
        // \u4E91\u7AEF\u97F3\u8272\u56DE\u663E\uFF1A\u672C\u9875\u6CA1\u624B\u5DE5\u6539\u8FC7\uFF08localStorage \u65E0\u503C\uFF09\u65F6\uFF0C\u663E\u793A\u5BBF\u4E3B\u5B9E\u9645\u5728\u7528\u7684\u90A3\u4E2A
        // \uFF08\u6765\u81EA\u300C\u8BBE\u7F6E \u2192 \u4E2A\u4EBA\u52A9\u624B \u2192 \u9E48\u9E55\u7AEF \u2192 \u9ED8\u8BA4\u4E91\u97F3\u8272\u300D\u6216 TIHU_EDGE_VOICE\uFF09\uFF0C\u907F\u514D\u4E24\u8FB9\u540D\u5B57\u5BF9\u4E0D\u4E0A\u3002
        (function () {
          var override = '';
          try { override = localStorage.getItem('tihu.edgeVoice') || ''; } catch (e) { /* \u5FFD\u7565 */ }
          if (override) return;
          var host = typeof payload.edgeVoice === 'string' ? payload.edgeVoice : '';
          var select = $('edgeVoiceSelect');
          if (!host || !select) return;
          if (select.querySelector('option[value="' + host + '"]')) select.value = host;
        })();
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
        break;
      case 'event.alert':
        if (payload.level === 'error') {
          // \u5BBF\u4E3B\u5DF2\u7ECF\u660E\u786E\u62A5\u9519\uFF08\u8F6C\u5199\u5931\u8D25/\u5E27\u88AB\u62D2\uFF09\uFF0C\u4E0D\u518D\u8BA9 15 \u79D2\u8D85\u65F6\u91CD\u590D\u63D0\u793A\u3002
          state.audioPending = false;
          clearTimeout(state.audioTimer);
        }
        // \u8BD5\u542C\u5408\u6210\u5F7B\u5E95\u5931\u8D25\uFF1A\u5BBF\u4E3B\u5DF2\u53D1\u7EA2\u544A\u8B66\uFF0C\u8FD9\u91CC\u8865\u4E00\u58F0\u63D0\u793A\u97F3\u5E76\u6539\u63D0\u793A\u6587\u6848\uFF08\u4E0D\u9759\u9ED8\uFF09\u3002
        if (payload.level === 'error' && String(payload.text || '').indexOf('\u8BD5\u542C') === 0 && state.samplePending) {
          state.samplePending = false;
          clearTimeout(state.sampleTimer);
          var sampleHint = $('audioTestHint');
          var beeped = playBeep();
          if (sampleHint) sampleHint.textContent = beeped ? '\u8BD5\u542C\u5931\u8D25\uFF1A\u5DF2\u6539\u7528\u63D0\u793A\u97F3\uFF08\u539F\u56E0\u89C1\u4E8B\u4EF6\u533A\u7EA2\u5B57\uFF09' : '\u8BD5\u542C\u5931\u8D25\uFF1A\u770B\u4E8B\u4EF6\u533A\u7EA2\u5B57';
        }
        // \u672C\u5730 TTS \u5931\u8D25\uFF1A\u7ACB\u523B\u628A\u6240\u6709\u5F85\u5FF5\u6587\u672C\u4EA4\u7ED9\u7CFB\u7EDF\u8BED\u97F3\uFF0C\u522B\u8BA9\u7528\u6237\u7B49 4 \u79D2\u515C\u5E95\u3002
        addEvent('alert', (payload.level === 'error' ? '\u9519\u8BEF\uFF1A' : '') + (payload.text || ''));
        break;
      case 'session.bound': state.sessionId = payload.sessionId || ''; break;
      /* \u4EFB\u52A1\u767B\u8BB0\u7C3F\uFF082026-11-09 \u7EDF\u4E00\u6307\u6325\uFF09\uFF1A\u68CB\u76D8\u6570\u636E\u65E2\u968F screen.frame.board \u4E0B\u53D1\uFF0C
         \u4E5F\u5355\u72EC\u53D1\u4E00\u6761 task.list\uFF08\u56FA\u4EF6\u53EA\u8BA4\u8FD9\u6761\u4E5F\u6CA1\u95EE\u9898\uFF09\uFF1B\u64AD\u62A5\u5E27\u53EA\u5728\u4E8B\u4EF6\u533A\u8BB0\u4E00\u884C\u3002 */
      case 'task.list':
        if (payload && payload.board) renderBoard(payload);
        break;
      case 'task.update':
        // \u5355\u884C\u53D8\u66F4\uFF1A\u68CB\u76D8\u5728\u5C4F\u4E0A\u65F6\u6309\u6700\u65B0\u4E00\u62CD\u91CD\u753B\u7531 screen.frame \u8D1F\u8D23\uFF0C\u8FD9\u91CC\u53EA\u8BB0\u4E00\u884C\u4E8B\u4EF6\u3002
        if (payload && payload.taskId) addEvent('progress', '\u4EFB\u52A1 ' + payload.taskId + ' \u2192 ' + (payload.capsule || payload.state || ''));
        break;
      case 'task.notify':
        if (payload && payload.text) addEvent(payload.level === 0 ? 'alert' : 'progress', (payload.spoken ? '\u64AD\u62A5\uFF1A' : '\u901A\u77E5\uFF1A') + payload.text);
        break;
      /* ---- 2026-11-10\uFF08\u89C4\u683C\u4E66 \xA76.1\uFF09\uFF1A\u56DB\u7C7B\u53CD\u5411\u63A7\u5236 ----
         \u8FD9\u56DB\u7C7B\u4EE5\u524D\u5230\u4E86\u9875\u9762**\u6CA1\u6709\u4EFB\u4F55\u53CD\u5E94**\uFF0C\u4E8E\u662F\u300C\u505C\u6B62\u6717\u8BFB / \u6682\u505C / \u5F3A\u5236\u5728\u542C / \u7ED3\u675F\u4F1A\u8BDD\u300D
         \u53EA\u80FD\u9760\u5BBF\u4E3B\u5355\u65B9\u9762\u4E0D\u53D1 PCM\u2014\u2014\u9875\u9762\u5DF2\u7ECF\u6392\u8FDB WebAudio \u65F6\u95F4\u8F74\u7684\u5757\u7167\u5FF5\u3002 */
      case 'playback.control': {
        var control = payload || {};
        var applied = applyPlayback(String(control.action || ''), control);
        if (applied.ok !== true) {
          addEvent('progress', '\u64AD\u653E\u63A7\u5236\u88AB\u5FFD\u7565\uFF1A' + (applied.reason || 'unknown'));
          ackDown(control, { ok: false, reason: applied.reason || 'failed' });
          break;
        }
        ackDown(control);
        break;
      }
      case 'voice.listen': {
        var wantListen = payload && payload.on === true;
        if (wantListen) {
          var listenOptions = {};
          if (payload.prompt !== undefined) listenOptions.prompt = String(payload.prompt);
          if (payload.timeoutMs !== undefined) listenOptions.timeoutMs = Number(payload.timeoutMs);
          listenEnter(listenOptions);
        } else {
          listenExit();
        }
        ackDown(payload, { listening: state.listenOn === true });
        addEvent('progress', wantListen ? '\u5BBF\u4E3B\u8BA9\u8FDB\u5165\u300C\u5728\u542C\u300D' : '\u5BBF\u4E3B\u8BA9\u9000\u51FA\u300C\u5728\u542C\u300D');
        break;
      }
      case 'session.ended': {
        renderIdle(payload && payload.reason ? String(payload.reason) : '\u7535\u8111\u7AEF\u6307\u4EE4');
        ackDown(payload);
        break;
      }
      case 'device.config': {
        var configKey = payload && payload.key ? String(payload.key) : '';
        if (configKey === 'voice') {
          var voiceValue = String(payload.value || '');
          var edgeSelect = $('edgeVoiceSelect');
          // \u771F\u6B63\u751F\u6548\u5728\u5BBF\u4E3B\u5408\u6210\u4FA7\uFF08\u4E0B\u4E00\u6761\u64AD\u62A5\u5C31\u7528\u65B0\u97F3\u8272\uFF09\uFF0C\u9875\u9762\u53EA\u628A\u4E0B\u62C9\u663E\u793A\u5BF9\u9F50\u3002
          if (edgeSelect && edgeSelect.querySelector('option[value="' + voiceValue + '"]')) edgeSelect.value = voiceValue;
          addEvent('progress', '\u5BBF\u4E3B\u628A\u4E91\u97F3\u8272\u5207\u5230\uFF1A' + voiceValue);
          ackDown(payload);
          break;
        }
        if (configKey === 'handsfree') {
          var wantHandsfree = payload.value === true;
          if (wantHandsfree && !state.wake) {
            var started = wakeStart();
            ackDown(payload, started === false ? { ok: false, reason: 'unsupported' } : {});
          } else if (!wantHandsfree && state.wake) {
            wakeStop(true);
            ackDown(payload);
          } else {
            ackDown(payload);
          }
          break;
        }
        if (configKey === 'scale') {
          applyScale(String(payload.value || '2'));
          ackDown(payload);
          break;
        }
        ackDown(payload, { ok: false, reason: 'unsupported' });
        break;
      }
      case 'pong': break;
      default: break; /* \u672A\u77E5 type\uFF1A\u5FFD\u7565 */
    }
  }

  /* ---------- \u771F\u673A\u5C4F\u5E55\uFF1A\u7F29\u653E\u4E09\u6863 + \u5916\u58F3\u5F00\u5173\uFF08\u53EA\u5F71\u54CD\u663E\u793A\uFF0C\u4E0D\u6539 320\xD7240 \u5185\u5BB9\uFF09 ---------- */
  var SCALE_MODES = {
    '1': { scale: 1, label: '320 \xD7 240 \u663E\u793A\uFF081\xD7\uFF09' },
    '2': { scale: 2, label: '640 \xD7 480 \u663E\u793A\uFF082\xD7\uFF09' },
    'actual': { scale: ACTUAL_SCALE, label: '\u5B9E\u9645\u5C3A\u5BF8\uFF08\u224861 \xD7 45.7 mm\uFF0C\u8FD1\u4F3C\uFF09' }
  };
  var scaleButtons = document.querySelectorAll('.screen-tools button[data-scale]');
  function applyScale(mode) {
    var spec = SCALE_MODES[mode] || SCALE_MODES['2'];
    state.screenScale = spec.scale;
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
      var conditioned = trimSilence(condition(samples));
      try { context.close(); } catch (e) { /* \u5FFD\u7565 */ }
      return { wav: encodeWav(conditioned, target), durationMs: Math.round(conditioned.length / target * 1000), sampleRate: target };
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
  /** \u628A\u4E00\u6BB5\u97F3\u9891\uFF08\u5F55\u97F3\u6587\u4EF6/\u62D6\u8FDB\u6765\u7684 WAV\uFF09\u89E3\u7801\u6210 16k \u5355\u58F0\u9053\u540E\u4E0A\u884C\uFF08audio.frame\uFF09\u3002
      \u7EDF\u4E00\u6307\u6325\u6CA1\u6709\u300C\u9009\u4F1A\u8BDD\u300D\u8FD9\u56DE\u4E8B\uFF1A\u8FD9\u91CC\u4E0D\u518D\u8BFB state.sessionId\uFF0C\u4E5F\u4E0D\u5F39\u65E7\u4F1A\u8BDD\u5217\u8868\u3002 */
  function uploadWav(arrayBuffer, label) {
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
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, autoGainControl: true, noiseSuppression: false } }).then(function (stream) {
      var recorder = new MediaRecorder(stream);
      state.recorder = recorder;
      state.chunks = [];
      recorder.ondataavailable = function (event) { if (event.data && event.data.size > 0) state.chunks.push(event.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' });
        blob.arrayBuffer().then(function (buffer) { uploadWav(buffer, '\u5F55\u97F3'); });
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
    file.arrayBuffer().then(function (buffer) { uploadWav(buffer, file.name); });
    event.target.value = '';
  });
  var drop = $('drop');
  window.addEventListener('dragover', function (event) { event.preventDefault(); drop.classList.add('on'); });
  window.addEventListener('dragleave', function (event) { if (event.relatedTarget === null) drop.classList.remove('on'); });
  window.addEventListener('drop', function (event) {
    event.preventDefault();
    drop.classList.remove('on');
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) file.arrayBuffer().then(function (buffer) { uploadWav(buffer, file.name); });
  });

  /* ---------- \u6587\u672C / \u64A4\u56DE ---------- */
  $('send').onclick = function () {
    var text = $('text').value.trim();
    if (!text) return;
    send('text.input', { text: text, source: 'keyboard' });
    state.droppedAudio = false;
    hideAudioWarn();
    $('transcript').textContent = text;
    $('transcript').className = '';
    $('text').value = '';
  };
  $('retry').onclick = function () {
    // \u6709\u9884\u89C8/\u5F85\u53D1\u8349\u7A3F\u65F6\u8D70\u5BBF\u4E3B\u91CD\u8BF4\uFF1A\u771F\u6B63\u53D6\u6D88\u8349\u7A3F\u4E0E\u5728\u9014 ASR\uFF0C\u800C\u4E0D\u662F\u53EA\u64E6\u9875\u9762\u6587\u5B57\u3002
    if (state.lastTranscript) {
      send('screen.gesture', { action: 'tap', x: 1, y: 1, hit: 'action', actionId: 'retry' });
    }
    state.lastTranscript = '';
    $('transcript').textContent = '\uFF08\u8FD8\u6CA1\u6709\u5185\u5BB9\uFF09';
    $('transcript').className = 'empty';
    addEvent('progress', '\u5DF2\u53D6\u6D88\u4E0A\u4E00\u6761\u8F6C\u5199\uFF0C\u8BF7\u91CD\u65B0\u8BF4');
  };
  /* \u91CD\u8BFB\u4E00\u904D\uFF1A\u628A\u672C\u8F6E\u6240\u6709 tts \u6BB5\u62FC\u56DE\u6765\u7684\u5168\u6587**\u4ECE\u5934\u91CD\u64AD**\uFF08\u4E0D\u662F\u53EA\u8BFB\u6700\u540E\u4E00\u6BB5\uFF09\u3002 */
  /* \u8BD5\u542C\uFF1A\u5148\u89E3\u9501\u97F3\u9891\uFF1B\u6709\u672C\u8F6E\u7F13\u5B58\u91CD\u64AD\uFF0C\u5426\u5219\u8BF7\u5BBF\u4E3B\u5FF5\u4E00\u53E5\u793A\u4F8B\uFF08\u561F\u58F0\u53EA\u5728\u5408\u6210\u5931\u8D25\u65F6\u51FA\u73B0\uFF09\u3002 */
  $('audioTest').onclick = function () {
    audioTest();
    addEvent('progress', '\u8BD5\u542C\uFF1A\u51C6\u5907\u793A\u4F8B\u8BED\u97F3');
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

  /* ---------- \u514D\u6309\u4F4F \uFF0B \u5524\u9192\u8BCD\u300C\u4F60\u597D\uFF0C\u9E48\u9E55\u300D\uFF08\u5C4F 3\u300C\u5728\u542C \xB7 \u5DF2\u5524\u9192\u300D\uFF09 ----------
   * \u771F\u673A\u662F\u56FA\u4EF6\u672C\u5730\u5173\u952E\u8BCD\u5224\u5B9A\uFF08\u4E0D\u4E0A\u4F20\u97F3\u9891\uFF09\uFF1B\u6A21\u62DF\u9875\u53EA\u80FD\u7528\u6D4F\u89C8\u5668 SpeechRecognition \u505A
   * \u5173\u952E\u8BCD\u8046\u542C\uFF0C\u6240\u4EE5\u5B83\u662F\u4E2A**\u663E\u5F0F\u5F00\u5173**\uFF08\u9ED8\u8BA4\u5173\uFF0C\u70B9\u4E00\u4E0B\u624D\u5F00\uFF09\uFF0C\u4E0D\u5077\u5077\u5360\u9EA6\u514B\u98CE\u3002
   * \u547D\u4E2D\u5173\u952E\u8BCD \u2192 \u5C4F\u4E0A\u76D6\u4E00\u5C42\u300C\u5728\u542C\u300D\u2192 \u7EE7\u7EED\u8BF4 \u2192 \u672B\u5B57\u540E\u9759\u97F3 3 \u79D2\u81EA\u52A8\u53D1\u9001\uFF1B10 \u79D2\u6CA1\u8BF4\u8BDD\u9000\u51FA\u3002
   * \u64AD\u62A5\u4E2D\u53EB\u9192\uFF1A\u5148\u628A\u672C\u5730\u97F3\u9891\u961F\u5217\u6390\u6389\uFF08\u9875\u9762\u4FA7 AEC \u7684\u8F6F\u4EF6\u515C\u5E95\uFF09\uFF0C\u518D\u8FDB\u8046\u542C\u2014\u2014\u5FF5\u4E00\u534A\u4E5F\u80FD\u63D2\u8BDD\u3002
   */
  var WAKE_RE = /\u4F60\u597D[\uFF0C,\u3001\\s]*\u9E48\u9E55/;
  function listenPreview(text) {
    var heard = $('listenHeard');
    if (!heard) return;
    heard.textContent = text === '' ? '' : fitTextPx(text, 288, 12);
  }
  /** \u5C4F\u4E0A\u300C\u5728\u542C\u300D\u90A3\u51E0\u884C\u5B57\uFF1A\u9ED8\u8BA4\u300C\u6211\u5728\uFF0C\u8BF4\u5427\u300D+\u300C10 \u79D2\u6CA1\u8BF4\u8BDD\u5C31\u9000\u51FA \xB7 \u957F\u6309\u4E5F\u80FD\u8BF4\u300D\u3002 */
  var LISTEN_DEFAULT_PROMPT = '\u6211\u5728\uFF0C\u8BF4\u5427';
  function listenHintOf(prompt, timeoutMs) {
    var box = $('listen');
    if (!box) return;
    var l1 = box.querySelector('.l1');
    if (l1) l1.textContent = prompt !== '' ? fitTextPx(prompt, 288, 15) : LISTEN_DEFAULT_PROMPT;
    var hints = box.querySelectorAll('.l3');
    if (hints && hints.length > 0) {
      hints[hints.length - 1].textContent = Math.round(timeoutMs / 1000) + ' \u79D2\u6CA1\u8BF4\u8BDD\u5C31\u9000\u51FA \xB7 \u957F\u6309\u4E5F\u80FD\u8BF4';
    }
  }
  /**
   * \u8FDB\u5165\u300C\u5728\u542C \xB7 \u5DF2\u5524\u9192\u300D\uFF08\u89C4\u683C\u4E66 \xA77 \u7B2C 5 \u5904\uFF09\uFF1A\u5524\u9192\u8BCD\u3001\u9875\u9762 #wake \u5F00\u5173\u3001\u5BBF\u4E3B
   * voice.listen \u4E09\u5904\u5171\u7528\u8FD9\u4E00\u4E2A\u5165\u53E3\u3002options = { prompt, timeoutMs }\u3002
   */
  function listenBegin(options) {
    var opts = options || {};
    var prompt = typeof opts.prompt === 'string' ? opts.prompt.replace(/s+/g, ' ').trim() : '';
    var timeoutMs = Number(opts.timeoutMs);
    if (!isFinite(timeoutMs) || timeoutMs < 3000) timeoutMs = 10000;
    if (timeoutMs > 60000) timeoutMs = 60000;
    state.listenOn = true;
    state.listenText = '';
    state.listenSkip = true;
    $('screen').classList.add('listen-on');
    listenPreview('');
    listenHintOf(prompt, timeoutMs);
    clearTimeout(state.listenIdle);
    // \u4E00\u53E5\u90FD\u6CA1\u8BF4\u5C31\u9000\u51FA\uFF08\u4E0D\u4F1A\u4E00\u76F4\u5F00\u7740\u9EA6\uFF09
    state.listenIdle = setTimeout(function () {
      if (!state.listenOn) return;
      if (String(state.listenText || '').trim() !== '') return;
      addEvent('progress', '\u514D\u6309\u4F4F\uFF1A' + Math.round(timeoutMs / 1000) + ' \u79D2\u6CA1\u8BF4\u8BDD\uFF0C\u5DF2\u9000\u51FA\u8046\u542C');
      listenEnd();
    }, timeoutMs);
    reportPlayback('listening');
  }
  /** \u5BBF\u4E3B\u4E0B\u53D1 voice.listen{on:true} \u7684\u5165\u53E3\uFF1A\u5C4F\u4E0A\u5199\u4E86\u300C\u5728\u542C\u300D\u5C31\u5FC5\u987B\u771F\u7684\u5F00\u9EA6\u3002 */
  function listenEnter(options) {
    if (!state.wake) wakeStart();
    listenBegin(options);
    return true;
  }
  function listenExit() {
    listenEnd();
  }
  function listenEnd() {
    var wasOn = state.listenOn === true;
    state.listenOn = false;
    state.listenText = '';
    state.listenSkip = false;
    clearTimeout(state.listenTimer);
    clearTimeout(state.listenIdle);
    state.listenTimer = 0;
    state.listenIdle = 0;
    var screen = $('screen');
    if (screen) screen.classList.remove('listen-on');
    listenPreview('');
    if (wasOn) reportPlayback(state.done && state.screenMode === 'done' ? 'playing' : 'idle');
  }
  /** \u672B\u5B57\u540E\u9759\u97F3 3 \u79D2 = \u300C\u8BF4\u5B8C\u4E86\u300D\uFF1A\u7559\u51FA\u60F3\u63AA\u8F9E\u7684\u65F6\u95F4\uFF0C\u4E0D\u6253\u65AD\u4EBA\u3002
   *  \u4E00\u53E5\u8BDD\u90FD\u8FD8\u6CA1\u8BF4\u65F6**\u4E0D**\u8D77\u8FD9\u4E2A\u8BA1\u65F6\u2014\u2014\u90A3\u79CD\u60C5\u51B5\u5F52\u300C10 \u79D2\u6CA1\u8BF4\u8BDD\u5C31\u9000\u51FA\u300D\u7BA1\u3002 */
  function listenTouch() {
    clearTimeout(state.listenTimer);
    var text = String(state.listenText || '').trim();
    if (text === '') return;
    clearTimeout(state.listenIdle);
    state.listenIdle = 0;
    state.listenTimer = setTimeout(function () {
      var said = String(state.listenText || '').trim();
      listenEnd();
      if (said === '') return;   // \u53EA\u53EB\u4E86\u5524\u9192\u8BCD\u6CA1\u8BF4\u8BDD\uFF1A\u4E0D\u7B97\u4E00\u6B21\u5524\u9192
      stopPcm();
      send('text.input', { text: said, source: 'voice' });
      addEvent('progress', '\u514D\u6309\u4F4F\uFF1A' + said);
    }, 3000);
  }
  function wakeOnResult(event) {
    var finalText = '';
    var interim = '';
    for (var i = event.resultIndex; i < event.results.length; i += 1) {
      var res = event.results[i];
      var seg = res[0] && res[0].transcript ? res[0].transcript : '';
      if (res.isFinal) finalText += seg;
      else interim += seg;
    }
    if (!state.listenOn) {
      var probe = finalText || interim;
      var hit = probe.match(WAKE_RE);
      if (!hit) return;
      stopPcm();
      listenBegin();
      var tail = probe.slice(hit.index + hit[0].length).replace(/^[\uFF0C,\u3001\u3002.\\s]+/, '');
      if (finalText !== '') {
        state.listenText = tail;
        state.listenSkip = false;
      }
      listenPreview(state.listenText);
      listenTouch();
      return;
    }
    if (finalText !== '') {
      if (state.listenSkip) {
        // \u5173\u952E\u8BCD\u90A3\u4E00\u53E5\u7684 final \u8FDF\u5230\uFF1A\u53BB\u6389\u5173\u952E\u8BCD\u524D\u7F00\u518D\u7D2F\u52A0\uFF0C\u907F\u514D\u628A\u300C\u4F60\u597D\u9E48\u9E55\u300D\u5FF5\u8FDB\u6307\u4EE4
        var kw = finalText.match(WAKE_RE);
        state.listenText += kw ? finalText.slice(kw.index + kw[0].length) : finalText;
        state.listenSkip = false;
      } else {
        state.listenText += finalText;
      }
      listenPreview(state.listenText);
      listenTouch();
      return;
    }
    if (interim !== '') listenPreview(state.listenText + interim);
  }
  function wakeStop(silent) {
    state.wake = false;
    clearTimeout(state.wakeRestart);
    var rec = state.wakeRec;
    state.wakeRec = null;
    if (rec) {
      try { rec.onend = null; rec.stop(); } catch (e) { /* \u5FFD\u7565 */ }
    }
    var btn = $('wake');
    if (btn) btn.classList.remove('on');
    listenEnd();
    if (!silent) addEvent('progress', '\u514D\u6309\u4F4F\uFF1A\u5DF2\u5173\u95ED');
  }
  function wakeStart() {
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      addEvent('alert', '\u8FD9\u4E2A\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u514D\u6309\u4F4F\u8046\u542C\uFF08\u771F\u673A\u8D70\u56FA\u4EF6\u672C\u5730\u5524\u9192\uFF09\uFF1B\u957F\u6309\u8BF4\u8BDD\u4ECD\u53EF\u7528');
      return false;
    }
    var rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = wakeOnResult;
    rec.onerror = function (event) {
      if (event && event.error === 'not-allowed') {
        wakeStop(true);
        addEvent('alert', '\u9EA6\u514B\u98CE\u6743\u9650\u88AB\u62D2\u7EDD\uFF1A\u514D\u6309\u4F4F\u7528\u4E0D\u4E86\uFF0C\u957F\u6309\u8BF4\u8BDD\u4ECD\u53EF\u7528');
      }
    };
    rec.onend = function () {
      if (!state.wake) return;
      clearTimeout(state.wakeRestart);
      state.wakeRestart = setTimeout(function () { try { rec.start(); } catch (e) { /* \u5FFD\u7565 */ } }, 400);
    };
    try { rec.start(); } catch (e) { return false; }
    state.wakeRec = rec;
    state.wake = true;
    $('wake').classList.add('on');
    addEvent('progress', '\u514D\u6309\u4F4F\uFF1A\u53EB\u300C\u4F60\u597D\uFF0C\u9E48\u9E55\u300D\u5C31\u80FD\u8BF4\u8BDD');
    return true;
  }
  $('wake').onclick = function () {
    if (state.wake) wakeStop(false);
    else wakeStart();
  };
  try { if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) $('wake').classList.add('unsupported'); } catch (e) { /* \u5FFD\u7565 */ }


  /* ---------- \u5C4F\u5E55\u624B\u52BF\uFF1A\u6EDA\u8F6E / \u62D6\u62FD / \u89E6\u6478 \u2192 screen.gesture\uFF08\u5BBF\u4E3B\u6301\u6709\u6EDA\u52A8\u4F4D\u7F6E\uFF09 ---------- */
  (function bindScreenGestures() {
    var screen = $('screen');
    var dragging = false;
    var lastY = 0;
    var startX = 0;
    var startY = 0;
    var moved = false;
    function swipe(dy, phase) {
      send('screen.gesture', { action: 'swipe', dy: dy, phase: phase });
    }
    function tapFlash(visX, visY) {
      var flash = document.createElement('div');
      flash.className = 'tap-flash';
      flash.style.left = visX + 'px';
      flash.style.top = visY + 'px';
      screen.appendChild(flash);
      setTimeout(function () { if (flash.parentNode) flash.parentNode.removeChild(flash); }, 200);
    }
    screen.addEventListener('wheel', function (event) {
      event.preventDefault();
      swipe(event.deltaY, 'move');
    }, { passive: false });
    screen.addEventListener('pointerdown', function (event) {
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
        var scale = state.screenScale || 1;
        var rect = screen.getBoundingClientRect();
        var x = (event.clientX - rect.left) / scale;
        var y = (event.clientY - rect.top) / scale;
        tapFlash(event.clientX - rect.left, event.clientY - rect.top);
        var hit = null;
        var under = document.elementFromPoint(event.clientX, event.clientY);
        if (under && under.getAttribute) {
          var actionId = under.getAttribute('data-action');
          if (actionId) {
            // \u505C\u6B62/\u91CD\u8BFB/\u56DE\u4E3B\u9875/\u7FFB\u9875\u7EDF\u4E00\u8D70 applyPlayback\uFF082026-11-10\uFF09\uFF1A\u4E0E\u5BBF\u4E3B playback.control
            // \u5B8C\u5168\u540C\u4E00\u6761\u8DEF\uFF0C\u624B\u6307\u70B9\u548C\u5634\u4E0A\u8BF4\u6548\u679C\u4E00\u81F4\uFF1B\u5DEE\u522B\u53EA\u662F\u4E0D\u56DE\u300C\u5DF2\u505C\u6B62\u6717\u8BFB\u300D\u63D0\u793A\u3002
            if (actionId === 'stop' || actionId === 'home' || actionId === 'prev' || actionId === 'next'
              || actionId === 'taskBoard' || actionId === 'boardPrev' || actionId === 'boardNext') {
              applyPlayback('stop');
            }
            if (actionId === 'pause') applyPlayback('pause');
            if (actionId === 'resume') applyPlayback('resume', {});
            if (actionId === 'replay') {
              if (audioRunning(state.audioCtx)) {
                state.droppedAudio = false;
                hideAudioWarn();
              }
              // \u91CD\u8BFB\uFF1A\u6390\u6389\u65E7\u97F3\u9891 + \u9AD8\u4EAE\u56DE\u7B2C\u4E00\u884C\uFF1B\u5BBF\u4E3B\u91CD\u53D1\u7B2C\u4E00\u6BB5 PCM \u540E
              // \u4ECE\u300C\u6717\u8BFB\u6BB5 1 \u5F00\u59CB\u300D\u8FD9\u4E2A\u4E8B\u4EF6\u91CD\u65B0\u63A8\u8FDB\uFF08\u4E0D\u6309\u65F6\u95F4\u4F30\u7B97\uFF09\u3002
              if (state.done) {
                applyPlayback('seek', { from: { segment: 1 } });
              } else {
                stopPcm();
              }
            }
            if (actionId === 'taskBoard') clearDoneState();
            if (actionId === 'home') tapFlash(event.clientX - rect.left, event.clientY - rect.top);
            send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'action', actionId: actionId });
            return;
          }
        }
        // \u4EFB\u52A1\u68CB\u76D8\u4E0A\u70B9\u4E00\u884C\uFF1A\u770B\u8FD9\u6761\u4EFB\u52A1\u7684\u8BE6\u60C5\uFF08\u5BBF\u4E3B openTask\uFF0C\u4E0D\u6362\u4F1A\u8BDD\u7ED1\u5B9A\uFF09
        if (state.screenMode === 'board') {
          var taskEl = under && under.closest ? under.closest('.board-item') : null;
          var taskId = taskEl && taskEl.getAttribute ? taskEl.getAttribute('data-task') : '';
          if (taskId) {
            send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'task', taskId: taskId });
            return;
          }
        }
        send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'screen' });
        return;
      }
      swipe(0, 'end');
    }
    screen.addEventListener('pointerup', endDrag);
    screen.addEventListener('pointercancel', endDrag);
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
     \u4E0D\u7B49 120 \u79D2\u7A7A\u95F2\u7A97\u53E3\u8FC7\u671F\u2014\u2014\u7528\u6237\u8BF4\u5B8C\u5C31\u53EF\u4EE5\u653E\u5FC3\u81EA\u5DF1\u5E72\u6D3B\u3002
     2026-11-10\uFF1A\u5C4F\u4E0A\u90A3\u5957\u300C\u7A7A\u95F2\u300D\u62BD\u6210 renderIdle()\uFF0C\u5BBF\u4E3B session.ended \u4E0B\u53D1\u65F6\u8D70\u540C\u4E00\u4EFD
     \uFF08\u5426\u5219\u5DE5\u5177\u7ED3\u675F\u4E86\u4F1A\u8BDD\uFF0C\u5C4F\u8FD8\u505C\u5728\u5B8C\u6210\u9875\u3001\u65E7\u6B63\u6587\u8FD8\u80FD\u88AB\u7EED\u64AD\uFF09\u3002 */
  function renderIdle(reason) {
    stopPcm();
    clearDoneState();
    state.pausedAt = null;
    state.listenOn = false;
    state.screenMode = 'status';
    state.actions = [];
    renderActions();
    var screen = $('screen');
    if (screen) screen.className = 'idle';
    var stage = $('stage');
    if (stage) { stage.style.display = ''; stage.textContent = '\u7A7A\u95F2'; }
    var title = $('title');
    if (title) title.textContent = '\u5DF2\u7ED3\u675F\u672C\u6B21\u4F1A\u8BDD';
    var list = $('bullets');
    if (list) list.innerHTML = '';
    addEvent('progress', '\u5DF2\u7ED3\u675F\u672C\u6B21\u8BED\u97F3\u4F1A\u8BDD\uFF08' + (reason || 'button') + '\uFF09');
    reportPlayback('idle');
  }
  $('end').onclick = function () {
    send('session.end', { reason: 'button', sessionId: state.sessionId || undefined });
    renderIdle('button');
  };

  /* \u9996\u9875\u9876\u884C\u8D70\u8868\uFF1A\u6BCF\u79D2 tick \u4E00\u6B21\u65F6\u949F\uFF08\u65F6\u95F4\u7531\u9875\u9762\u81EA\u5DF1\u7684\u672C\u5730\u65F6\u949F\u6E32\u67D3\uFF0C\u4E0D\u7B49\u5BBF\u4E3B\u63A8\u2014\u2014
     \u5BBF\u4E3B\u90A3 30 \u79D2\u4E00\u6B21\u7684\u63A7\u5236\u5BA4\u5DE1\u68C0\uFF08TIHU_HOME_SYNC_MS\uFF09\u53EA\u5237\u65B0\u9879\u76EE\u6E05\u5355\uFF0C\u5E27\u9694 30 \u79D2\u63A8\u4E00\u6B21\u65F6\u949F\u5C31\u4F1A stale\uFF09\u3002
     \u6536\u5230 screen.frame \u65F6 renderScreen \u4E5F\u987A\u624B\u91CD\u753B\u4E00\u6B21\uFF0C\u4FDD\u8BC1\u540C\u4E00\u5E27\u91CC\u65F6\u949F\u4E0D\u4F1A\u82B1\u3002 */
  renderHomeTop();
  state.clockTimer = setInterval(renderHomeTop, 1000);
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
function formatElapsed2(ms) {
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
var TOOL_ACTIONS = {
  screenshot: { stage: "\u641C\u7D22", title: "\u622A\u56FE" },
  wait: { stage: "\u7B49\u5F85\u786E\u8BA4", title: "\u7B49\u5F85" },
  long_wait: { stage: "\u7B49\u5F85\u786E\u8BA4", title: "\u957F\u7B49\u5F85" },
  click: { stage: "\u8DD1\u547D\u4EE4", title: "\u70B9\u51FB" },
  hotkey: { stage: "\u8DD1\u547D\u4EE4", title: "\u6309\u952E" },
  scroll: { stage: "\u8DD1\u547D\u4EE4", title: "\u6EDA\u52A8" },
  drag: { stage: "\u8DD1\u547D\u4EE4", title: "\u62D6\u62FD" },
  input_text: { stage: "\u5199\u6587\u4EF6", title: "\u8F93\u5165\u6587\u5B57" },
  open_in_browser: { stage: "\u641C\u7D22", title: "\u6253\u5F00\u7F51\u9875" },
  open_in_finder: { stage: "\u8BFB\u6587\u4EF6", title: "\u6253\u5F00\u6587\u4EF6/\u76EE\u5F55" },
  open_app: { stage: "\u8DD1\u547D\u4EE4", title: "\u6253\u5F00\u5E94\u7528" },
  list_apps: { stage: "\u641C\u7D22", title: "\u5217\u51FA\u5E94\u7528" },
  code_agent: { stage: "\u601D\u8003", title: "\u6D3E\u53D1\u540E\u53F0\u4EFB\u52A1" },
  ask_user_question: { stage: "\u7B49\u5F85\u786E\u8BA4", title: "\u7B49\u5F85\u786E\u8BA4" },
  skill: { stage: "\u601D\u8003", title: "\u52A0\u8F7D\u6280\u80FD" },
  present: { stage: "\u56DE\u7B54", title: "\u5C55\u793A\u7ED3\u679C" },
  working_directory: { stage: "\u8BFB\u6587\u4EF6", title: "\u5207\u6362\u76EE\u5F55" },
  web_search: { stage: "\u641C\u7D22", title: "\u641C\u7D22" },
  web_fetch: { stage: "\u641C\u7D22", title: "\u6293\u53D6\u7F51\u9875" }
};
function describeToolAction(lower) {
  if (TOOL_ACTIONS[lower] !== void 0) return TOOL_ACTIONS[lower];
  if (lower.startsWith("mnemon_")) return { stage: "\u601D\u8003", title: "\u8BB0\u5FC6\u64CD\u4F5C" };
  return void 0;
}
function describeTool(name2, args) {
  const tool = String(name2 ?? "").trim();
  const lower = tool.toLowerCase();
  const params = asRecord(args);
  const file = firstString(params, ["path", "file_path", "filePath", "file", "filename", "target", "target_file"]);
  const action = describeToolAction(lower);
  if (action !== void 0) {
    const detail2 = firstString(params, ["query", "command", "path", "pattern", "url", "text", "message", "task", "prompt", "id"]);
    return { stage: action.stage, title: clipText(action.title, TIHU_TITLE_CHARS), detail: clipText(detail2, TIHU_EVENT_CHARS) };
  }
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
    title: clipText(`\u6267\u884C ${tool || "\u672A\u77E5\u5DE5\u5177"}`, TIHU_TITLE_CHARS),
    detail: clipText(detail, TIHU_EVENT_CHARS)
  };
}
function humanizeError(text) {
  const raw = String(text ?? "");
  if (/ENOENT|not recognized|not found|找不到|no such file/i.test(raw)) return "\u547D\u4EE4\u6CA1\u627E\u5230";
  if (/EACCES|EPERM|denied|拒绝访问|permission/i.test(raw)) return "\u6CA1\u6709\u6743\u9650";
  if (/ETIMEDOUT|timed out|timeout|超时/i.test(raw)) return "\u8D85\u65F6\u4E86";
  if (/ECONNREFUSED|ECONNRESET|connect|socket|fetch failed/i.test(raw)) return "\u8FDE\u4E0D\u4E0A";
  if (/spawn/i.test(raw)) return "\u7A0B\u5E8F\u6CA1\u8DD1\u8D77\u6765";
  return "\u6267\u884C\u51FA\u9519";
}
function summarizeToolResult(text, isError) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => sanitizeScreenLine(line)).filter((line) => {
    if (line === "") return false;
    if (/^<[^>\s]+\/?>/.test(line)) return false;
    if (/^\[image omitted/i.test(line)) return false;
    if (/^\(sha256:/i.test(line)) return false;
    if (/^Normalized copy/i.test(line)) return false;
    if (/^(Coordinates remain|Waited \d|Clicked screen|Pressed hotkey|Opened https?|position \[)/i.test(line)) return false;
    return true;
  });
  const first = lines[0] ?? "";
  const last = lines.length > 0 ? lines[lines.length - 1] : "";
  const head = clipText(first, TIHU_LINE_CHARS - 2);
  const tail = clipText(last, TIHU_LINE_CHARS);
  if (isError) {
    return { line: clipText(`\u2717 ${humanizeError(text)}`, TIHU_LINE_CHARS), output: "" };
  }
  return {
    line: clipText(`\u2713 ${head || "\u5B8C\u6210"}`, TIHU_LINE_CHARS),
    output: tail
  };
}
function createProgressState(now = Date.now()) {
  return { turn: 0, step: 0, turnStartedAt: now, lastResult: void 0, lastOutput: "", stageWord: "\u601D\u8003", firstLine: "", activity: [], sessionTitle: "", lastEventLine: "", stage: "\u601D\u8003", title: "\u7B49\u5F85\u6307\u4EE4", tone: "idle" };
}
function salientCommand(command) {
  let text = String(command ?? "").replace(/\s+/g, " ").trim();
  const strip = /^(?:Set-Location|cd|sl)\s+(?:"[^"]*"|'[^']*'|\S+)\s*;?\s*/i;
  for (let i = 0; i < 3 && strip.test(text); i += 1) text = text.replace(strip, "");
  const parts = text.split(/;|&&|\|\|/).map((part) => part.trim()).filter(Boolean);
  const last = parts.length > 0 ? parts[parts.length - 1] : text;
  const cleaned = last.replace(/\s*\d?>&\d/g, "").split(/\s\|\s/)[0].trim();
  return cleaned === "" ? last : cleaned;
}
function firstSentence(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "";
  const cut = text.split(/[。！？!?\n]/).map((part) => part.trim()).filter(Boolean)[0] ?? text;
  return cut;
}
function rawOneLine(value) {
  const text = String(value ?? "");
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/\s+/g, " ").trim();
    if (clean !== "") return clean;
  }
  return "";
}
function rawArgsLine(value) {
  if (value === void 0 || value === null) return "";
  if (typeof value === "string") return rawOneLine(value);
  try {
    return rawOneLine(JSON.stringify(value));
  } catch {
    return "";
  }
}
function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(1) + "k";
  return String(Math.round(value));
}
var ENTRY_RULES = [
  { pattern: /^(pwsh|powershell|bash|shell|terminal|exec|run_command|cmd)$/, label: "\u8FD0\u884C\u547D\u4EE4", keys: ["command", "cmd", "script", "input"] },
  { pattern: /^(glob|find|list_files?|ls|list_dir|tree)$/, label: "\u67E5\u627E\u6587\u4EF6", keys: ["pattern", "glob", "query", "path"] },
  { pattern: /^(grep|search|select-string)$/, label: "\u641C\u7D22\u6587\u4EF6\u5185\u5BB9", keys: ["pattern", "query", "q", "keyword"] },
  { pattern: /^(read|read_file|readfile|view_file|cat|open_file)$/, label: "\u8BFB\u6587\u4EF6", keys: ["path", "file_path", "file"] },
  { pattern: /^(write|write_file|writefile|create_file|save_file)$/, label: "\u5199\u6587\u4EF6", keys: ["path", "file_path", "file"] },
  { pattern: /^(edit|multiedit|apply_patch|str_replace|patch|update_file)$/, label: "\u6539\u6587\u4EF6", keys: ["path", "file_path", "file"] },
  { pattern: /^(web_search|websearch)$/, label: "\u7F51\u9875\u641C\u7D22", keys: ["query", "q"] },
  { pattern: /^(web_fetch|webfetch|fetch|browse)$/, label: "\u7F51\u9875\u83B7\u53D6", keys: ["url"] },
  { pattern: /^(todo|todo_write|update_plan|plan)$/, label: "\u66F4\u65B0\u4EFB\u52A1", keys: ["text", "message", "title", "todos"] },
  { pattern: /^(code_agent|task|subagent)$/, label: "\u6D3E\u5B50\u4EFB\u52A1", keys: ["task", "prompt"] },
  { pattern: /^(ask_user_question|confirm)$/, label: "\u7B49\u786E\u8BA4", keys: ["question", "title"] }
];
function sanitizeDetail(value) {
  return String(value ?? "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}
function activityEntryOf(name2, args) {
  const tool = String(name2 ?? "").trim();
  const lower = tool.toLowerCase();
  const params = asRecord(args);
  for (const rule of ENTRY_RULES) {
    if (!rule.pattern.test(lower)) continue;
    let detail = firstString(params, rule.keys);
    if (rule.label === "\u8FD0\u884C\u547D\u4EE4") {
      const description = firstString(params, ["description"]);
      detail = description === "" ? salientCommand(detail) : description;
    } else if (rule.label === "\u8BFB\u6587\u4EF6" || rule.label === "\u5199\u6587\u4EF6" || rule.label === "\u6539\u6587\u4EF6") detail = baseNameOf(detail) || detail;
    return { label: rule.label, detail: sanitizeDetail(detail) };
  }
  const known = describeToolAction(lower);
  const tail = firstString(params, ["query", "command", "path", "pattern", "url", "text", "message", "task", "prompt", "question", "skill"]);
  if (known !== void 0) return { label: known.title, detail: known.title === "\u7B49\u5F85\u786E\u8BA4" ? "" : sanitizeDetail(tail) };
  return { label: "\u5DE5\u5177", detail: sanitizeDetail([tail, tool].filter(Boolean).join(" ")) };
}
var ACTIVITY_MAX = 8;
var THINKING_PLACEHOLDER = "\u6A21\u578B\u63A8\u7406\u4E2D\u2026";
function pushActivity(state, label, detail) {
  const entry = { label, detail: sanitizeDetail(detail) };
  const last = state.activity[state.activity.length - 1];
  if (last !== void 0 && last.label === entry.label && last.detail === entry.detail) return;
  state.activity.push(entry);
  if (state.activity.length > ACTIVITY_MAX) state.activity.splice(0, state.activity.length - ACTIVITY_MAX);
}
function entryLine(entry) {
  const text = entry.detail === "" ? entry.label : entry.label + " \xB7 " + entry.detail;
  return fitLine(text, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx);
}
function statsLine(stats) {
  if (stats === void 0) return "";
  const parts = [];
  if (stats.tokPerSec > 0) parts.push(stats.tokPerSec.toFixed(0) + " tok/s");
  parts.push(stats.totalTokens > 0 ? formatTokens(stats.totalTokens) + " tok" : "tok \u2014");
  parts.push("\u4E0A\u4E0B\u6587 " + stats.contextPercent.toFixed(0) + "%");
  return parts.join(" \xB7 ");
}
function statsCompact(stats) {
  if (stats === void 0) return "\u7EDF\u8BA1\u4E2D\u2026";
  return [
    stats.tokPerSec > 0 ? stats.tokPerSec.toFixed(0) + " tok/s" : "",
    stats.totalTokens > 0 ? formatTokens(stats.totalTokens) : "",
    stats.contextPercent.toFixed(0) + "%"
  ].filter(Boolean).join(" \xB7 ");
}
function statusFrame(state, now, widthPx = CONTENT_WIDTH_PX) {
  const elapsed = formatElapsed2(now - state.turnStartedAt);
  const recent = state.activity.slice(-2).map(entryLine);
  const stepLine = "\u7B2C " + state.step + " \u6B65 \xB7 \u5DF2\u7528 " + elapsed;
  const stats = statsLine(state.stats);
  let bullets;
  if (recent.length >= 2) {
    bullets = [recent[recent.length - 2], recent[recent.length - 1], state.step + " \u6B65 " + elapsed + " \xB7 " + statsCompact(state.stats)];
  } else if (recent.length === 1) {
    bullets = [recent[0], stepLine, stats === "" ? "\u7EDF\u8BA1\u4E2D\u2026" : stats];
  } else {
    bullets = [stepLine, stats === "" ? "\u7EDF\u8BA1\u4E2D\u2026" : stats];
  }
  return {
    stage: "",
    title: fitLine(state.sessionTitle || state.title, widthPx, SCREEN_SPEC.titleFontPx),
    bullets: bullets.map((line, index) => fitLine(line, widthPx, index === bullets.length - 1 ? SCREEN_SPEC.statsFontPx : SCREEN_SPEC.bodyFontPx)).slice(0, SCREEN_SPEC.maxBodyLines),
    // 最后一行恒为「步数 + 用时 + 统计」，页面用小 2 号字号排它（用户 2026-11-08 要求）
    statsTail: 1,
    tone: state.tone
  };
}
function messageText(message) {
  const content = asRecord(message).content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => asRecord(block).type === "text").map((block) => String(asRecord(block).text ?? "")).join("\n").trim();
}
function reasoningText(data) {
  const message = asRecord(data.message);
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    const item = asRecord(block);
    if (item.type !== "thinking" && item.type !== "reasoning") continue;
    const text = typeof item.thinking === "string" ? item.thinking : typeof item.text === "string" ? item.text : typeof item.reasoning === "string" ? item.reasoning : "";
    if (text.trim() !== "") parts.push(text);
  }
  if (parts.length === 0) {
    const stream = Array.isArray(data.stream) ? data.stream : [];
    for (const record of stream) {
      const item = asRecord(record);
      if (item.type === "reasoning-chunks" && Array.isArray(item.texts)) parts.push(item.texts.map(String).join(""));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function applySessionEvent(state, event, now = Date.now(), meta) {
  if (meta?.title !== void 0 && meta.title !== "") state.sessionTitle = meta.title;
  if (meta?.stats !== void 0) state.stats = meta.stats;
  const widthPx = meta?.narrow === true ? PENDING_RAIL_WIDTH_PX : CONTENT_WIDTH_PX;
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
    state.activity = [];
    pushActivity(state, "\u601D\u8003", THINKING_PLACEHOLDER);
    state.lastEventLine = "\u601D\u8003 \xB7 " + THINKING_PLACEHOLDER;
    state.stage = "\u601D\u8003";
    state.title = "\u5F00\u59CB\u65B0\u4E00\u8F6E";
    state.stageWord = "\u601D\u8003";
    state.firstLine = "\u5F00\u59CB\u65B0\u4E00\u8F6E";
    state.tone = "busy";
    return {
      screen: statusFrame(state, now, widthPx),
      progress: { stage: "turn", text: `\u5F00\u59CB\u7B2C ${turn} \u8F6E` }
    };
  }
  if (type === "step/start") {
    state.step = Number.isFinite(data.step) ? Number(data.step) : state.step + 1;
    if (state.activity.length === 0) pushActivity(state, "\u601D\u8003", THINKING_PLACEHOLDER);
    if (state.lastEventLine === "") state.lastEventLine = "\u601D\u8003 \xB7 " + THINKING_PLACEHOLDER;
    state.stage = "\u601D\u8003";
    state.title = "\u601D\u8003\u4E0B\u4E00\u6B65";
    state.stageWord = "\u601D\u8003";
    state.tone = "busy";
    return {
      screen: statusFrame(state, now, widthPx),
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
    state.stageWord = action.stage;
    const item = activityEntryOf(name2, args);
    pushActivity(state, item.label, item.detail);
    const rawName = name2 === "" ? "\u5DE5\u5177" : name2;
    const rawArgs = rawArgsLine(data.arguments ?? asRecord(data.call).arguments);
    state.lastEventLine = `\u5DE5\u5177\u8C03\u7528 \xB7 ${rawName}${rawArgs === "" ? "" : " \xB7 " + rawArgs}`;
    state.tone = "busy";
    return {
      screen: statusFrame(state, now, widthPx),
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
    if (isError) pushActivity(state, "\u51FA\u9519", humanizeError(text));
    state.tone = isError ? "alert" : "ok";
    return {
      screen: statusFrame(state, now, widthPx),
      progress: {
        stage: "result",
        text: clipText(`${summary.line}\uFF5C${text || (isError ? "\u5DE5\u5177\u62A5\u9519" : "\uFF08\u65E0\u8F93\u51FA\uFF09")}`, TIHU_EVENT_CHARS)
      }
    };
  }
  if (type === "assistant/message") {
    const thought = reasoningText(data);
    if (thought !== "") {
      const detail = sanitizeDetail(firstSentence(thought));
      const last = state.activity[state.activity.length - 1];
      const early = state.activity.slice(-2).some((entry) => entry.label === "\u601D\u8003" && entry.detail === detail);
      if (last !== void 0 && last.label === "\u601D\u8003" && last.detail === THINKING_PLACEHOLDER) {
        state.activity[state.activity.length - 1] = { label: "\u601D\u8003", detail };
      } else if (early) {
      } else {
        pushActivity(state, "\u601D\u8003", firstSentence(thought));
      }
    }
    const text = messageText(data.message);
    if (text !== "") state.lastEventLine = "\u56DE\u590D \xB7 " + rawOneLine(text);
    else if (thought !== "") state.lastEventLine = "\u601D\u8003 \xB7 " + rawOneLine(thought);
    if (text === "") return {};
    const lines = text.split(/\r?\n/).map((line) => sanitizeScreenLine(line)).filter(Boolean);
    const firstLine = lines[0] ?? "";
    state.stage = "\u56DE\u7B54";
    state.stageWord = "\u56DE\u7B54";
    state.firstLine = firstSentence(firstLine);
    pushActivity(state, "\u56DE\u7B54", firstSentence(firstLine));
    state.title = clipText(`\u56DE\u7B54 ${firstLine}`, TIHU_TITLE_CHARS);
    state.lastResult = { ok: true, line: "\u2713 \u5DF2\u751F\u6210\u56DE\u590D" };
    state.tone = "ok";
    return {
      screen: statusFrame(state, now, widthPx),
      progress: { stage: "answer", text: clipText(text, TIHU_EVENT_CHARS) }
    };
  }
  if (type === "turn/end") {
    const reason = String(asRecord(data.reason).kind ?? "stop");
    const okReason = reason === "completed" || reason === "stop";
    const doneTitle = fitLine(`${okReason ? "\u5B8C\u6210" : "\u672C\u8F6E\u4E2D\u65AD"} \xB7 \u5171 ${state.step} \u6B65 \xB7 \u7528\u65F6 ${formatElapsed2(now - state.turnStartedAt)}`, widthPx, SCREEN_SPEC.titleFontPx);
    state.stage = "\u56DE\u7B54";
    state.title = doneTitle;
    state.tone = okReason ? "ok" : "alert";
    const resultLine = okReason ? state.lastResult?.ok === false ? state.lastResult.line : state.lastResult?.line ?? "\u2713 \u672C\u8F6E\u5B8C\u6210" : state.lastResult?.ok === false ? state.lastResult.line : `\u2717 \u672C\u8F6E\u4E2D\u65AD\uFF08${reason}\uFF09`;
    return {
      // 最终帧保留在屏上（不要立刻清成「本轮完成」）
      screen: {
        stage: "\u56DE\u7B54",
        title: doneTitle,
        bullets: [fitLine(resultLine, widthPx, SCREEN_SPEC.bodyFontPx)],
        tone: state.tone
      },
      progress: { stage: "end", text: okReason ? "\u672C\u8F6E\u5B8C\u6210" : `\u672C\u8F6E\u7ED3\u675F\uFF08${reason}\uFF09` }
    };
  }
  return {};
}
function applyEarlyThinking(state, thought, now = Date.now(), widthPx = CONTENT_WIDTH_PX) {
  const detail = sanitizeDetail(firstSentence(thought));
  if (detail === "") return void 0;
  state.lastEventLine = "\u601D\u8003 \xB7 " + detail;
  const last = state.activity[state.activity.length - 1];
  if (last !== void 0 && last.label === "\u601D\u8003") {
    if (last.detail === detail) return void 0;
    last.detail = detail;
  } else {
    if (detail === THINKING_PLACEHOLDER) return void 0;
    pushActivity(state, "\u601D\u8003", detail);
  }
  return { screen: statusFrame(state, now, widthPx) };
}
var SPEED_WINDOW_MS = 15e3;
var SPEED_MAX_SAMPLES = 24;
var SPEED_MIN_SPAN_MS = 200;
function pushDecodeSample(samples, sample) {
  const kept = samples.filter((s) => sample.at - s.at <= SPEED_WINDOW_MS && s.decodeTokens <= sample.decodeTokens && s.decodeMs <= sample.decodeMs);
  kept.push(sample);
  return kept.slice(-SPEED_MAX_SAMPLES);
}
function decodeRateOf(samples) {
  if (samples.length < 2) return void 0;
  const last = samples[samples.length - 1];
  const first = samples[0];
  const dTokens = last.decodeTokens - first.decodeTokens;
  const dMs = last.decodeMs - first.decodeMs;
  if (dTokens <= 0 || dMs < SPEED_MIN_SPAN_MS) return void 0;
  return dTokens / (dMs / 1e3);
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

// src/tihu/cloud-voices.ts
var TIHU_CLOUD_VOICES = [
  { id: "zh-CN-YunjianNeural", label: "\u4E91\u5065 Yunjian\uFF08\u7537\u58F0\uFF09", short: "\u4E91\u5065" },
  { id: "zh-CN-YunxiNeural", label: "\u4E91\u5E0C Yunxi\uFF08\u7537\u58F0\uFF09", short: "\u4E91\u5E0C" },
  { id: "zh-CN-XiaoxiaoNeural", label: "\u6653\u6653 Xiaoxiao\uFF08\u5973\u58F0\uFF09", short: "\u6653\u6653" },
  { id: "zh-CN-YunyangNeural", label: "\u4E91\u626C Yunyang\uFF08\u7537\u58F0\uFF09", short: "\u4E91\u626C" }
];
var TIHU_CLOUD_VOICE_DEFAULT = "zh-CN-YunjianNeural";
function isTihuCloudVoice(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") return false;
  return TIHU_CLOUD_VOICES.some((voice) => voice.id === value);
}
function tihuCloudVoiceShortName(raw) {
  const value = String(raw ?? "").trim();
  const hit = TIHU_CLOUD_VOICES.find((voice) => voice.id === value);
  if (hit !== void 0) return hit.short;
  return TIHU_CLOUD_VOICES.find((voice) => voice.id === TIHU_CLOUD_VOICE_DEFAULT)?.short ?? "\u4E91\u5065";
}

// src/tihu/tts.ts
var DEFAULT_PORT = 8731;
var KOKORO_PORT_DEFAULT = DEFAULT_PORT;
var HEALTH_TIMEOUT_MS = 18e4;
var EDGE_FIRST_MS_DEFAULT = 8e3;
var EDGE_FIRST_MS_MIN = 3e3;
var EDGE_FIRST_MS_MAX = 6e4;
function clampMs(raw, min, max, fallback) {
  const value = Number(raw);
  if (raw === void 0 || raw === "" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
function edgeFirstChunkMs() {
  return clampMs(process.env.TIHU_EDGE_FIRST_MS, EDGE_FIRST_MS_MIN, EDGE_FIRST_MS_MAX, EDGE_FIRST_MS_DEFAULT);
}
var LOCAL_FIRST_MS_DEFAULT = 4e3;
var LOCAL_FIRST_MS_MIN = 1e3;
var LOCAL_FIRST_MS_MAX = 6e4;
function localFirstChunkMs() {
  return clampMs(process.env.TIHU_LOCAL_FIRST_MS, LOCAL_FIRST_MS_MIN, LOCAL_FIRST_MS_MAX, LOCAL_FIRST_MS_DEFAULT);
}
function ttsEngine() {
  const raw = String(process.env.TIHU_TTS_ENGINE ?? "").trim().toLowerCase();
  if (raw === "kokoro") return "kokoro";
  if (raw === "qwen" || raw === "cpu" || raw === "q4" || raw === "qwen-cuda") return "qwen";
  return "edge";
}
var KOKORO_ZH_FEMALE = [
  "zf_001",
  "zf_002",
  "zf_003",
  "zf_004",
  "zf_005",
  "zf_006",
  "zf_007",
  "zf_008",
  "zf_017",
  "zf_018",
  "zf_019",
  "zf_021",
  "zf_022",
  "zf_023",
  "zf_024",
  "zf_026",
  "zf_027",
  "zf_028",
  "zf_032",
  "zf_036",
  "zf_038",
  "zf_039",
  "zf_040",
  "zf_042",
  "zf_043",
  "zf_044",
  "zf_046",
  "zf_047",
  "zf_048",
  "zf_049",
  "zf_051",
  "zf_059",
  "zf_060",
  "zf_067",
  "zf_070",
  "zf_071",
  "zf_072",
  "zf_073",
  "zf_074",
  "zf_075",
  "zf_076",
  "zf_077",
  "zf_078",
  "zf_079",
  "zf_083",
  "zf_084",
  "zf_085",
  "zf_086",
  "zf_087",
  "zf_088",
  "zf_090",
  "zf_092",
  "zf_093",
  "zf_094",
  "zf_099"
];
var KOKORO_ZH_MALE = [
  "zm_009",
  "zm_010",
  "zm_011",
  "zm_012",
  "zm_013",
  "zm_014",
  "zm_015",
  "zm_016",
  "zm_020",
  "zm_025",
  "zm_029",
  "zm_030",
  "zm_031",
  "zm_033",
  "zm_034",
  "zm_035",
  "zm_037",
  "zm_041",
  "zm_045",
  "zm_050",
  "zm_052",
  "zm_053",
  "zm_054",
  "zm_055",
  "zm_056",
  "zm_057",
  "zm_058",
  "zm_061",
  "zm_062",
  "zm_063",
  "zm_064",
  "zm_065",
  "zm_066",
  "zm_068",
  "zm_069",
  "zm_080",
  "zm_081",
  "zm_082",
  "zm_089",
  "zm_091",
  "zm_095",
  "zm_096",
  "zm_097",
  "zm_098",
  "zm_100"
];
var KOKORO_VOICES = [
  { sid: 0, name: "af_maple", gender: "f" },
  { sid: 1, name: "af_sol", gender: "f" },
  { sid: 2, name: "bf_vale", gender: "f" },
  ...KOKORO_ZH_FEMALE.map((name2, index) => ({ sid: 3 + index, name: name2, gender: "f" })),
  ...KOKORO_ZH_MALE.map((name2, index) => ({ sid: 58 + index, name: name2, gender: "m" }))
];
var KOKORO_ZH_VOICES = KOKORO_VOICES.filter((voice) => voice.sid >= 3);
var KOKORO_DEFAULT_SID = 35;
function kokoroVoiceName(sid) {
  return KOKORO_VOICES.find((voice) => voice.sid === sid)?.name ?? `sid${sid}`;
}
function kokoroSid(raw) {
  const envRaw = process.env.TIHU_KOKORO_SID;
  const parsed = envRaw === void 0 || String(envRaw).trim() === "" ? Number.NaN : Number(envRaw);
  const fallback = Number.isInteger(parsed) && parsed >= 0 && parsed <= 102 ? parsed : KOKORO_DEFAULT_SID;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw >= 0 && raw <= 102 ? raw : fallback;
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === "default") return fallback;
  const byName2 = KOKORO_VOICES.find((voice) => voice.name.toLowerCase() === value);
  if (byName2 !== void 0) return byName2.sid;
  const numeric = value.startsWith("sid") ? value.slice(3) : value;
  if (/^\d+$/.test(numeric)) {
    const sid = Number(numeric);
    if (sid >= 0 && sid <= 102) return sid;
  }
  return fallback;
}
function isKokoroVoice(raw) {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 && raw <= 102;
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === "default") return false;
  if (KOKORO_VOICES.some((voice) => voice.name.toLowerCase() === value)) return true;
  const numeric = value.startsWith("sid") ? value.slice(3) : value;
  if (!/^\d+$/.test(numeric)) return false;
  const sid = Number(numeric);
  return sid >= 0 && sid <= 102;
}
function offlineFlagReason(offlineOnly) {
  if (offlineOnly === true) return "\u8BBE\u5907\u52FE\u9009\u4E86\u300C\u4EC5\u79BB\u7EBF\u300D";
  if (process.env.TIHU_OFFLINE_ONLY === "1") return "TIHU_OFFLINE_ONLY=1\uFF08\u4EC5\u79BB\u7EBF\uFF09";
  if (process.env.TIHU_HOST_OFFLINE === "1") return "TIHU_HOST_OFFLINE=1\uFF08\u5BBF\u4E3B\u5904\u4E8E\u79BB\u7EBF\u6A21\u5F0F\uFF09";
  return "";
}
var EDGE_PROBE_TIMEOUT_MS = 1500;
var EDGE_PROBE_CACHE_MS = 6e4;
var EDGE_DOWN_TTL_MS = 6e4;
var EDGE_PROBE_URL_DEFAULT = "https://speech.platform.bing.com/";
var edgeProbeCache;
async function probeEdgeReachable() {
  const now = Date.now();
  if (edgeProbeCache !== void 0 && now - edgeProbeCache.at < EDGE_PROBE_CACHE_MS) return edgeProbeCache.reachable;
  const url = process.env.TIHU_EDGE_PROBE_URL ?? EDGE_PROBE_URL_DEFAULT;
  let reachable = false;
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(EDGE_PROBE_TIMEOUT_MS) });
    reachable = true;
  } catch {
    reachable = false;
  }
  edgeProbeCache = { at: now, reachable };
  return reachable;
}
function moduleDir() {
  const pathname = decodeURIComponent(new URL(".", import.meta.url).pathname);
  const withoutSlash = pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\/+$/, "");
  return withoutSlash.replace(/\//g, "\\");
}
function repoModelDirs() {
  const here = moduleDir();
  const roots = [join6(here, "..", ".."), join6(here, ".."), process.cwd()];
  const dirs = [];
  for (const root of roots) {
    const dir = join6(root, "models", "kokoro", "kokoro-multi-lang-v1_1");
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}
function kokoroModelDir() {
  const explicit = process.env.TIHU_KOKORO_MODEL_DIR;
  if (explicit !== void 0 && explicit !== "") return explicit;
  for (const dir of repoModelDirs()) {
    if (existsSync4(join6(dir, "model.onnx"))) return dir;
  }
  return join6(tihuRoot(), "models", "kokoro", "kokoro-multi-lang-v1_1");
}
function kokoroModelPath() {
  const explicit = process.env.TIHU_KOKORO_MODEL;
  if (explicit !== void 0 && explicit !== "") return explicit;
  return join6(kokoroModelDir(), "model.onnx");
}
function kokoroAssetsDir() {
  const modelDir = kokoroModelDir();
  if (existsSync4(join6(modelDir, "tokens.txt"))) return modelDir;
  const sibling = join6(dirname5(modelDir), "kokoro-int8-multi-lang-v1_1");
  return existsSync4(join6(sibling, "tokens.txt")) ? sibling : modelDir;
}
function kokoroPythonPath() {
  const explicit = process.env.TIHU_KOKORO_PY;
  if (explicit !== void 0 && explicit !== "") return explicit;
  return join6(tihuRoot(), "venv-sherpa", "Scripts", process.platform === "win32" ? "python.exe" : "python");
}
function kokoroScriptPath() {
  const explicit = process.env.TIHU_KOKORO_SERVER;
  if (explicit !== void 0 && explicit !== "") return explicit;
  const here = moduleDir();
  const candidates = [
    join6(here, "..", "..", "scripts", "tihu-kokoro-tts-server.py"),
    // src/tihu → 仓库根
    join6(here, "..", "scripts", "tihu-kokoro-tts-server.py"),
    // 打包后 lib → 仓库根
    join6(process.cwd(), "scripts", "tihu-kokoro-tts-server.py")
  ];
  for (const candidate of candidates) {
    if (existsSync4(candidate)) return candidate;
  }
  return candidates[0];
}
var edgeRuntime = globalThis.process ?? { env: {}, platform: "" };
function edgeScriptPath() {
  const explicit = edgeRuntime.env.TIHU_EDGE_SERVER;
  if (explicit !== void 0 && explicit !== "") return explicit;
  const here = moduleDir();
  const candidates = [
    join6(here, "..", "..", "scripts", "tihu-edge-tts.py"),
    join6(here, "..", "scripts", "tihu-edge-tts.py"),
    join6(typeof edgeRuntime.cwd === "function" ? edgeRuntime.cwd() : "", "scripts", "tihu-edge-tts.py")
  ];
  return candidates.find((candidate) => existsSync4(candidate)) ?? candidates[0];
}
function edgePythonCandidates() {
  const explicit = [edgeRuntime.env.TIHU_EDGE_PY, edgeRuntime.env.TIHU_EDGE_PYTHON].filter((value) => typeof value === "string" && value.trim() !== "");
  const win = edgeRuntime.platform === "win32";
  const legacy = join6(tihuRoot(), "venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  const system = win ? ["python", "py"] : ["python3", "python"];
  return [.../* @__PURE__ */ new Set([...explicit, legacy, ...system])];
}
function edgeProbeRun(command, args) {
  return spawnSync(command, args, { timeout: 3e3, stdio: "ignore", windowsHide: true, shell: false });
}
function probeEdgeDependencies(paths, run = edgeProbeRun) {
  const base = { python: paths.python, script: paths.script, ffmpeg: paths.ffmpeg };
  if (!existsSync4(paths.script)) return { ...base, ok: false, error: `\u7F3A edge \u9A71\u52A8\u811A\u672C\uFF1A${paths.script}` };
  const version = run(paths.python, ["--version"]);
  if (version.status !== 0 || version.error !== void 0) return { ...base, ok: false, error: `Python \u4E0D\u53EF\u8FD0\u884C\uFF1A${paths.python}` };
  const imported = run(paths.python, ["-c", "import edge_tts"]);
  if (imported.status !== 0 || imported.error !== void 0) return { ...base, ok: false, error: `Python \u7F3A\u5C11 edge_tts\uFF1A${paths.python}` };
  const ffmpeg = run(paths.ffmpeg, ["-version"]);
  if (ffmpeg.status !== 0 || ffmpeg.error !== void 0) return { ...base, ok: false, error: `ffmpeg \u4E0D\u53EF\u8FD0\u884C\uFF1A${paths.ffmpeg}` };
  return { ...base, ok: true, error: "" };
}
function kokoroInstallHint() {
  const python = kokoroPythonPath();
  const modelDir = kokoroModelDir();
  return [
    `\u2460 \u88C5 Python \u73AF\u5883\uFF08\u6A21\u578B\u968F\u4ED3\u5E93\u81EA\u5E26\uFF0C\u4E0D\u7528\u4E0B\u8F7D\uFF09\uFF1Apython -m venv "${dirname5(dirname5(python))}" && "${python}" -m pip install sherpa-onnx websockets`,
    `\u2461 \u53EA\u6709 models \u76EE\u5F55\u88AB\u5220\u7A7A\u65F6\u624D\u9700\u8981\u8865\u6A21\u578B\uFF1AHF_ENDPOINT=https://hf-mirror.com "${python}" -c "from huggingface_hub import snapshot_download as d; d('csukuangfj/kokoro-multi-lang-v1_1', local_dir=r'${modelDir}')"`
  ].join("\uFF1B");
}
function kokoroMissingFiles() {
  const assets = kokoroAssetsDir();
  const checks = [
    [kokoroPythonPath(), "Python \u8FD0\u884C\u65F6\uFF08venv-sherpa\uFF09"],
    [kokoroScriptPath(), "\u9A71\u52A8\u811A\u672C scripts/tihu-kokoro-tts-server.py"],
    [kokoroModelPath(), "fp32 \u6743\u91CD model.onnx"],
    [join6(assets, "tokens.txt"), "tokens.txt"],
    [join6(assets, "voices.bin"), "voices.bin"],
    [join6(assets, "lexicon-zh.txt"), "lexicon-zh.txt"],
    [join6(assets, "espeak-ng-data"), "espeak-ng-data \u76EE\u5F55"],
    [join6(assets, "number-zh.fst"), "number-zh.fst"],
    [join6(assets, "date-zh.fst"), "date-zh.fst"]
  ];
  const missing = [];
  for (const [path3, label] of checks) {
    if (!existsSync4(path3)) missing.push(`${label}\uFF1A${path3}`);
  }
  return missing;
}
function openWebSocket(url) {
  const ctor = globalThis?.WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("\u5F53\u524D\u8FD0\u884C\u65F6\u6CA1\u6709\u5168\u5C40 WebSocket\uFF08\u9700\u8981 Node 22+\uFF09\uFF1BKokoro \u672C\u5730\u5F15\u64CE\u65E0\u6CD5\u8FDE\u63A5");
  }
  return new ctor(url);
}
function cpuFallbackBlocked(wantsClone, backend) {
  if (wantsClone) return false;
  if (backend !== "cpu") return false;
  return process.env.TIHU_TTS_CPU_FALLBACK !== "1";
}
function localFallbackAbortMs(wantsClone, backend) {
  if (wantsClone) return 0;
  if (backend === "cpu" || backend === "q4") return 0;
  return 4500;
}
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
  /** 实际出声引擎（用于事件标识）：kokoro / gpu(qwen) / edge / none。 */
  engineInUse = "none";
  lastLabel = "";
  /** 本地合成串行锁：最多 1 路在合（Kokoro 只用 4 线程，并发只会互相等）。 */
  localLock = Promise.resolve();
  /**
   * edge 失败后的冷却窗口：同一轮/连续多段朗读里，edge 刚失败过就不要每段都白等两轮
   * （首块门限 8s × 2）；60s 内直接走离线兜底，过期后再给 edge 一次机会。
   */
  edgeDownUntil = 0;
  edgeDownReason = "";
  /** 本机依赖短缓存；与网络探测、edge 失败 cooldown 完全独立。 */
  edgeDepsCache = null;
  constructor(options) {
    this.options = options;
    this.paths = { ...defaultTtsPaths(), ...options.paths ?? {} };
    this.port = options.port ?? KOKORO_PORT_DEFAULT;
  }
  /**
   * 当前**常驻**后端：kokoro（只有显式 `TIHU_TTS_ENGINE=kokoro` 才算）/ qwen-* / none。
   *
   * edge 主用时恒为 `none`：edge 是每次合成现起 Python 进程，不需要常驻 sidecar；
   * Kokoro 只在离线兜底/手切时由 {@link ensureKokoroServer} 按需拉起，**不在这里自启**。
   */
  backend() {
    if (this.options.disabled) return "none";
    const engine = ttsEngine();
    if (engine === "kokoro") return this.kokoroReady() ? "kokoro" : "none";
    if (engine === "edge") return "none";
    const legacy = String(process.env.TIHU_TTS_ENGINE ?? "").trim().toLowerCase();
    if (legacy === "q4" && existsSync4(this.paths.bin) && existsSync4(this.paths.model) && existsSync4(this.paths.codec)) return "q4";
    if (legacy === "cpu" && this.qwenReady()) return "cpu";
    if (this.qwenReady() && !this.gpuFailed) return (process.env.TIHU_TTS_DEVICE ?? "cpu") === "cuda" ? "qwen-cuda" : "cpu";
    return "none";
  }
  /**
   * 这一路实际会优先试哪个引擎（屏上/测试用；不发起任何进程）：
   *   - 显式 `TIHU_TTS_ENGINE=qwen` → qwen（遗留）；
   *   - 显式 kokoro、手选 Kokoro 音色、仅离线/宿主离线 → kokoro；
   *   - 其余 → edge（默认）。
   */
  engineFor(voice, offlineOnly) {
    const engine = ttsEngine();
    if (engine === "qwen") return "qwen";
    if (engine === "kokoro" || isKokoroVoice(voice) || offlineFlagReason(offlineOnly) !== "") return "kokoro";
    return "edge";
  }
  /** 实际出声引擎（状态屏/事件区用）：kokoro | gpu | edge | none。 */
  activeEngine() {
    return this.engineInUse;
  }
  /** 本地 Kokoro 是否就绪（缺文件时与 backend() 一致）。 */
  kokoroReady() {
    return kokoroMissingFiles().length === 0;
  }
  /** 主引擎是不是本地（lane 据此把并发压到 1 路；edge 主用时为 false，最多 3 路）。 */
  localPrimary() {
    return this.backend() === "kokoro" || this.backend() === "qwen-cuda" || this.backend() === "cpu" || this.backend() === "q4";
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
  /** 引擎是否可用（edge 或本地 Kokoro/Qwen 任一可用）。 */
  available() {
    return this.edgeReady() || this.kokoroReady() || this.backend() !== "none";
  }
  status() {
    const backend = this.backend();
    const engine = ttsEngine();
    if (backend === "kokoro") return { available: true, model: "kokoro multi-lang-v1_1 (sherpa-onnx fp32)" };
    if (engine === "kokoro") {
      const missing = kokoroMissingFiles();
      const reason = `Kokoro \u672A\u5C31\u7EEA\uFF08\u7F3A ${missing.length} \u9879\uFF1A${missing.slice(0, 3).join("\uFF1B")}${missing.length > 3 ? " \u2026" : ""}\uFF09\u3002${kokoroInstallHint()}`;
      if (this.edgeReady()) return { available: true, model: "edge-tts \u4E91\u5065(Yunjian)", error: reason };
      return { available: false, error: `${reason}\uFF1Bedge \u515C\u5E95\u4E5F\u4E0D\u53EF\u7528` };
    }
    if (backend === "q4") return { available: true, model: "qwen3-tts 0.6b-q4" };
    if (backend === "cpu") return { available: true, model: "qwen3-tts 0.6b-pt" };
    if (backend === "qwen-cuda") return { available: true, model: "qwen3-tts 0.6b-cuda" };
    if (this.edgeReady()) return { available: true, model: "edge-tts \u4E91\u5065(Yunjian)" };
    const edgeReason = this.edgeDependencies().error;
    if (this.kokoroReady()) {
      return {
        available: true,
        model: "Kokoro multi-lang-v1_1\uFF08\u79BB\u7EBF\u515C\u5E95\uFF09",
        error: `edge \u4E0D\u53EF\u7528\uFF08${edgeReason}\uFF09\uFF0C\u5DF2\u964D\u7EA7\u5230\u672C\u5730 Kokoro`
      };
    }
    return {
      available: false,
      error: this.lastError || `\u65E0\u8BED\u97F3\uFF1Aedge \u4E0D\u53EF\u7528\uFF08${edgeReason}\uFF09\u4E14\u672C\u5730 Kokoro \u672A\u5C31\u7EEA\uFF08${this.paths.root}\uFF09`
    };
  }
  /** 显存不足回落 CPU 的原因（无回落返回空串）。 */
  deviceFallback() {
    return this.fallbackNote;
  }
  /** 确保 sidecar 已启动并加载完模型（只对常驻后端：显式 kokoro / 遗留 qwen）。 */
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
  /**
   * 按需拉起 Kokoro sidecar：**只有**离线兜底触发或用户手切 Kokoro 音色/试听时才调，
   * 默认 edge 主用路径不会碰它（不占 300MB 模型、不吃 4 个核）。
   */
  async ensureKokoroServer() {
    if (this.options.disabled) return;
    if (this.modelLoaded) return;
    if (this.starting !== null) return this.starting;
    this.starting = this.launchKokoro().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async launchKokoro() {
    await mkdir3(this.paths.serverVoices, { recursive: true });
    const port = await this.pickKokoroPort();
    this.port = port;
    if (this.child === null && this.modelLoaded) return;
    await this.startKokoro(port);
  }
  /** 网络是否可达（离线判定的硬依据；测试可覆盖）。 */
  edgeNetworkReachable() {
    return probeEdgeReachable();
  }
  /**
   * 离线兜底的判定（按优先级给**明确依据**，空串 = 不该兜底）：
   *   ① 显式开关：仅离线 / TIHU_OFFLINE_ONLY / TIHU_HOST_OFFLINE；
   *   ② edge 请求失败：先探测网络（探测不到 = 离线；探测得到 = edge 服务不可用）；
   *   ③ edge 未安装（缺 Python 运行时或驱动脚本）。
   * ①②③ 任意一条成立才允许启用 Kokoro。
   */
  async offlineFallbackReason(explicit, edgeError) {
    if (explicit !== "") return explicit;
    if (edgeError !== "") {
      const online = await this.edgeNetworkReachable();
      if (!online) {
        return `\u7F51\u7EDC\u63A2\u6D4B\u5931\u8D25\uFF08${process.env.TIHU_EDGE_PROBE_URL ?? EDGE_PROBE_URL_DEFAULT} 1.5s \u4E0D\u53EF\u8FBE\uFF09\uFF1Bedge \u4E5F\u5931\u8D25\uFF1A${edgeError.slice(0, 120)}`;
      }
      return `edge \u8BF7\u6C42\u5931\u8D25\uFF1A${edgeError.slice(0, 120)}`;
    }
    if (!this.edgeReady()) return `edge \u4E0D\u53EF\u7528\uFF1A${this.edgeDependencies().error}`;
    return "";
  }
  async startServer() {
    await mkdir3(this.paths.serverVoices, { recursive: true });
    const backend = this.backend();
    if (backend === "kokoro") {
      await this.launchKokoro();
      return;
    }
    const port = await this.pickPort();
    this.port = port;
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
        process.env.TIHU_TTS_DTYPE ?? (backend === "cpu" ? "fp32" : "bf16")
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
  /**
   * 启动 Kokoro sidecar：仓库内 `scripts/tihu-kokoro-tts-server.py` +
   * `~/.dsh/tihu/venv-sherpa` 的 Python + fp32 权重。常驻进程，模型只加载一次。
   */
  async startKokoro(port) {
    const missing = kokoroMissingFiles();
    if (missing.length > 0) {
      throw new Error(`Kokoro \u672C\u5730\u5F15\u64CE\u4E0D\u53EF\u7528\uFF0C\u7F3A ${missing.length} \u9879\uFF1A${missing.join("\uFF1B")}\u3002${kokoroInstallHint()}`);
    }
    const assets = kokoroAssetsDir();
    const threads = this.options.threads ?? clampMs(process.env.TIHU_KOKORO_THREADS, 1, 8, 4);
    const command = kokoroPythonPath();
    const args = [
      "-u",
      kokoroScriptPath(),
      "--model-dir",
      kokoroModelDir(),
      "--model",
      kokoroModelPath(),
      "--voices",
      join6(assets, "voices.bin"),
      "--tokens",
      join6(assets, "tokens.txt"),
      "--lexicon",
      [join6(assets, "lexicon-us-en.txt"), join6(assets, "lexicon-zh.txt")].join(","),
      "--data-dir",
      join6(assets, "espeak-ng-data"),
      "--dict-dir",
      join6(assets, "dict"),
      "--rule-fsts",
      [join6(assets, "date-zh.fst"), join6(assets, "phone-zh.fst"), join6(assets, "number-zh.fst")].join(","),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--num-threads",
      String(threads),
      "--sid",
      String(kokoroSid())
    ];
    this.log(`starting tts sidecar (kokoro): ${command} (port ${port}, threads ${threads})`);
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
[${(/* @__PURE__ */ new Date()).toISOString()}] start kokoro ${command} ${args.join(" ")}
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
      this.lastError = `Kokoro \u8FDB\u7A0B\u9000\u51FA\uFF08code=${code ?? "?"} signal=${signal ?? "-"}\uFF09${this.stderrTail ? "\uFF1A" + this.stderrTail.split("\n").filter(Boolean).slice(-2).join(" ") : ""}`;
      if (wasLoaded) this.log(`tts sidecar exited: ${this.lastError}`);
    });
    const started = Date.now();
    for (; ; ) {
      if (Date.now() - started > HEALTH_TIMEOUT_MS) {
        throw new Error(`Kokoro \u542F\u52A8\u8D85\u65F6\uFF08${Math.round(HEALTH_TIMEOUT_MS / 1e3)}s\uFF09\uFF1A${this.stderrTail.split("\n").filter(Boolean).slice(-3).join(" ") || "\u65E0\u8F93\u51FA"}`);
      }
      if (this.child === null) throw new Error(this.lastError || "Kokoro \u8FDB\u7A0B\u542F\u52A8\u5931\u8D25");
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          const info = await response.json().catch(() => null);
          if (info?.engine === "kokoro") {
            this.activeDevice = "cpu";
            this.log(`kokoro health: sr=${info.sample_rate} speakers=${info.num_speakers} load=${info.load_ms}ms`);
            break;
          }
        }
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.modelLoaded = true;
    this.log(`tts sidecar ready in ${Date.now() - started} ms (port ${this.port})`);
  }
  async pickPort() {
    const base = this.options.port ?? this.defaultPort();
    for (let offset = 0; offset < 8; offset += 1) {
      const port = base + offset;
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
    return base;
  }
  /**
   * Kokoro 端口：先找已经在跑的 **Kokoro** 实例复用（热重载/手切来回时不重复加载模型），
   * 端口被别的 sidecar 占着就往后挪；都没人就返回第一个空闲端口。
   */
  async pickKokoroPort() {
    const base = this.options.port ?? this.defaultPort();
    for (let offset = 0; offset < 8; offset += 1) {
      const port = base + offset;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
        if (!response.ok) continue;
        const info = await response.json().catch(() => null);
        if (info?.engine === "kokoro") {
          this.port = port;
          this.modelLoaded = true;
          return port;
        }
      } catch {
        return port;
      }
    }
    return base;
  }
  /** 默认端口：Kokoro（含 edge 主用下的手切/兜底）走 8731（TIHU_TTS_KOKORO_PORT 可挪）；Qwen 沿用 DEFAULT_PORT。 */
  defaultPort() {
    if (ttsEngine() !== "qwen") {
      const raw = Number(process.env.TIHU_TTS_KOKORO_PORT ?? "");
      if (Number.isInteger(raw) && raw > 0 && raw < 65536) return raw;
      return KOKORO_PORT_DEFAULT;
    }
    return DEFAULT_PORT;
  }
  /** edge 依赖：仓库脚本 + 可运行 Python/import edge_tts + ffmpeg；30 秒缓存避免每段重复探测。 */
  edgeDependencies() {
    const script = edgeScriptPath();
    const ffmpeg = edgeRuntime.env.TIHU_FFMPEG ?? "ffmpeg";
    const cached = this.edgeDepsCache;
    const key = `${script}${ffmpeg}${edgePythonCandidates().join("")}`;
    if (cached !== null && cached.key === key && Date.now() - cached.at < 3e4) return cached.status;
    let last = null;
    for (const python of edgePythonCandidates()) {
      const status2 = probeEdgeDependencies({ python, script, ffmpeg });
      if (status2.ok) {
        this.edgeDepsCache = { at: Date.now(), key, status: status2 };
        return status2;
      }
      last = status2;
      if (!existsSync4(script)) break;
    }
    const status = last ?? { ok: false, python: "", script, ffmpeg, error: "\u6CA1\u6709\u53EF\u5019\u9009\u7684 Python" };
    this.edgeDepsCache = { at: Date.now(), key, status };
    return status;
  }
  edgeReady() {
    return this.edgeDependencies().ok;
  }
  /** 当前引擎的中文标识（页面事件区）。 */
  engineLabel(voice) {
    if (this.engineInUse === "kokoro") {
      const sid = kokoroSid(voice);
      return `\u79BB\u7EBF\u515C\u5E95\uFF1A\u672C\u5730 Kokoro ${kokoroVoiceName(sid)}\uFF08sid ${sid}\uFF09`;
    }
    if (this.engineInUse === "edge") return "\u5728\u7EBF\u4E3B\u5F15\u64CE\uFF1Aedge-tts \u4E91\u5065(Yunjian)";
    if (this.engineInUse === "none") return "\u65E0\u8BED\u97F3\uFF08\u4EC5\u6587\u5B57\uFF09";
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
    const deps = this.edgeDependencies();
    if (!deps.ok) throw new Error(`edge \u4F9D\u8D56\u4E0D\u53EF\u7528\uFF1A${deps.error}`);
    const voice = options.edgeVoice || process.env.TIHU_EDGE_VOICE || TIHU_CLOUD_VOICE_DEFAULT;
    const py = spawn4(deps.python, ["-u", deps.script, "--text", text, "--voice", voice], {
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
    let abortedBySignal = false;
    const signal = options?.signal;
    const onAbort = () => {
      abortedBySignal = true;
      try {
        py.kill();
      } catch {
      }
      try {
        ff.kill();
      } catch {
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const firstBudgetMs = edgeFirstChunkMs();
    let firstKilled = false;
    const firstTimer = setTimeout(() => {
      firstKilled = true;
      try {
        py.kill();
      } catch {
      }
      try {
        ff.kill();
      } catch {
      }
    }, firstBudgetMs);
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
        py.on("error", (error) => reject(new Error(`edge Python \u542F\u52A8\u5931\u8D25\uFF1A${error.message}`)));
        py.on("close", (code) => {
          if (code !== 0 && firstAt === 0) reject(new Error(`edge-tts \u5931\u8D25\uFF08exit ${code}\uFF09\uFF1A${stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200)}`));
        });
      });
      const tail = chunker.finish();
      if (abortedBySignal) throw new Error("edge-tts \u5DF2\u53D6\u6D88\uFF08\u672C\u8F6E\u6717\u8BFB\u88AB\u6362\u7ED1/\u66F4\u65B0\u7684\u4E00\u8F6E\u53D6\u4EE3\uFF09");
      if (firstAt === 0 && tail.length === 0) {
        if (firstKilled) throw new Error(`edge-tts \u9996\u5757\u8D85\u65F6\uFF08${firstBudgetMs}ms \u672A\u8FD4\u56DE\u97F3\u9891\uFF09`);
        throw new Error(`edge-tts \u6CA1\u6709\u8FD4\u56DE\u97F3\u9891\uFF1A${stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200)}`);
      }
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
   *
   * 引擎链（2026-11-08 用户拍板）：**Kokoro 本地 → edge 兜底 → （仅显式 qwen）Qwen**。
   * Kokoro 首块超过 `TIHU_LOCAL_FIRST_MS`（默认 2500ms）直接切 edge，不让首句空等。
   * 任一路失败都不静默：向上抛可读错误，lane 发红告警。
   */
  async synthesize(text, options) {
    const engine = ttsEngine();
    const kokoroVoice = isKokoroVoice(options.voice);
    const wantsClone = engine !== "kokoro" && !kokoroVoice && typeof options.voice === "string" && options.voice !== "" && options.voice !== "default";
    const explicitOffline = offlineFlagReason(options.offlineOnly);
    const manualKokoro = engine === "kokoro" || kokoroVoice;
    let localError = "";
    let edgeError = "";
    let fallbackReason = "";
    let kokoroTried = false;
    if (manualKokoro && !wantsClone) {
      kokoroTried = true;
      if (this.kokoroReady()) {
        try {
          const result = await this.synthesizeKokoro(text, options);
          this.setEngine("kokoro", options.voice);
          return result;
        } catch (error) {
          localError = error?.message ?? String(error);
          this.lastError = localError;
          this.log(`kokoro failed\uFF08\u624B\u5207 Kokoro\uFF0C\u5931\u8D25\u540E\u5207 edge\uFF09: ${localError}`);
        }
      } else {
        const missing = kokoroMissingFiles();
        localError = `Kokoro \u672A\u5C31\u7EEA\uFF08\u7F3A ${missing.slice(0, 3).join("\uFF1B")}\uFF09\u3002${kokoroInstallHint()}`;
        this.log(`kokoro skipped: ${localError}`);
      }
    }
    const edgeCooldown = Date.now() < this.edgeDownUntil;
    if (!wantsClone && explicitOffline === "" && edgeCooldown) {
      edgeError = this.edgeDownReason || "edge \u521A\u5931\u8D25\u8FC7\uFF0860s \u51B7\u5374\uFF09";
      this.log(`edge skipped\uFF0860s \u51B7\u5374\uFF1A${edgeError}\uFF09`);
    } else if (!wantsClone && explicitOffline === "" && this.edgeReady()) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await this.synthesizeEdge(text, { ...options, edgeVoice: options.edgeVoice });
          this.edgeDownUntil = 0;
          this.edgeDownReason = "";
          this.setEngine("edge");
          return result;
        } catch (error) {
          edgeError = error?.message ?? String(error);
          const firstChunkTimeout = edgeError.includes("\u9996\u5757\u8D85\u65F6");
          const willRetry = firstChunkTimeout && attempt === 0;
          this.log(`edge-tts failed${willRetry ? "\uFF08\u9996\u5757\u8D85\u65F6\uFF0C\u91CD\u8BD5\u4E00\u6B21 edge\uFF09" : ""}: ${edgeError}`);
          if (!willRetry) {
            if (/已取消|aborted/i.test(edgeError)) break;
            this.edgeDownUntil = Date.now() + EDGE_DOWN_TTL_MS;
            this.edgeDownReason = edgeError;
            break;
          }
        }
      }
    }
    if (!wantsClone && !kokoroTried && engine === "edge") {
      fallbackReason = await this.offlineFallbackReason(explicitOffline, edgeError);
      if (fallbackReason !== "") {
        this.log(`kokoro offline fallback: ${fallbackReason}`);
        if (this.kokoroReady()) {
          try {
            const result = await this.synthesizeKokoro(text, options);
            this.setEngine("kokoro", options.voice);
            this.lastLabel = `${this.engineLabel(options.voice ?? "")}\uFF08\u79BB\u7EBF\u515C\u5E95\uFF09`;
            return result;
          } catch (error) {
            localError = error?.message ?? String(error);
            this.lastError = localError;
            this.log(`kokoro offline fallback failed: ${localError}`);
          }
        } else {
          const missing = kokoroMissingFiles();
          localError = `Kokoro \u672A\u5C31\u7EEA\uFF08\u7F3A ${missing.slice(0, 3).join("\uFF1B")}\uFF09\u3002${kokoroInstallHint()}`;
          this.log(`kokoro fallback skipped: ${localError}`);
        }
      }
    }
    const backend = this.backend();
    if (backend !== "none" && (engine === "qwen" || wantsClone || explicitOffline !== "")) {
      if (cpuFallbackBlocked(wantsClone, backend)) {
        const reason = "\u672C\u5730 Qwen \u8DD1\u5728 CPU\uFF08\u5B9E\u6D4B\u9996\u5305 8\u201354s\uFF09\uFF0C\u5DF2\u4E0D\u518D\u4F5C\u4E3A\u9ED8\u8BA4\u97F3\u8272\u7684\u515C\u5E95\uFF1B\u8981\u7528\u8BF7\u8BBE TIHU_TTS_CPU_FALLBACK=1";
        localError = reason;
        this.lastError = reason;
        this.log(`tts local fallback skipped: ${reason}`);
      } else {
        try {
          const controller = new AbortController();
          const abortMs = localFallbackAbortMs(wantsClone, backend);
          const timer = abortMs > 0 ? setTimeout(() => controller.abort(), abortMs) : null;
          try {
            const result = await this.synthesizeCodec(text, { ...options, signal: options.signal ?? controller.signal });
            this.setEngine("gpu");
            return result;
          } finally {
            if (timer !== null) clearTimeout(timer);
          }
        } catch (error) {
          localError = error?.message ?? String(error);
          this.gpuFailed = true;
          this.fallbackNote = `\u672C\u5730 Qwen \u5931\u8D25\uFF1A${localError}`;
          this.log(`tts qwen failed: ${localError}`);
        }
      }
    }
    this.engineInUse = "none";
    this.lastLabel = "\u65E0\u8BED\u97F3\uFF08\u4EC5\u6587\u5B57\uFF09";
    const detail = [
      edgeError === "" ? "" : `edge\uFF1A${edgeError}`,
      localError === "" ? "" : `Kokoro/Qwen\uFF1A${localError}`,
      fallbackReason === "" ? "" : `\u79BB\u7EBF\u4F9D\u636E\uFF1A${fallbackReason}`,
      explicitOffline === "" ? "" : `\u79BB\u7EBF\u5F00\u5173\uFF1A${explicitOffline}`
    ].filter(Boolean).join("\uFF1B");
    throw new Error(`\u672C\u6B21\u65E0\u8BED\u97F3\uFF1A${detail || "\u6CA1\u6709\u53EF\u7528\u5F15\u64CE\uFF08edge \u672A\u5B89\u88C5\u4E14 Kokoro \u672A\u5C31\u7EEA\uFF09"}`);
  }
  setEngine(engine, voice = "") {
    this.engineInUse = engine;
    this.lastLabel = this.engineLabel(voice);
  }
  /** 本地合成串行化：同时只允许 1 路在合（多设备/多段排队，绝不 12 路并上 CPU）。 */
  serializeLocal(fn) {
    const run = this.localLock.then(fn, fn);
    this.localLock = run.then(() => void 0, () => void 0);
    return run;
  }
  /** 调用按需拉起的 Kokoro sidecar（内部 WS：JSON 请求 + 二进制 PCM）。 */
  async synthesizeKokoro(text, options) {
    await this.ensureKokoroServer();
    return this.serializeLocal(() => this.kokoroRequest(text, options));
  }
  async kokoroRequest(text, options) {
    const started = Date.now();
    const sid = kokoroSid(options.voice);
    const budget = localFirstChunkMs();
    const chunker = new Pcm16Chunker();
    let chunks = 0;
    let bytes = 0;
    let firstChunkAt = 0;
    const socket = openWebSocket(`ws://127.0.0.1:${this.port}/tts`);
    socket.binaryType = "arraybuffer";
    try {
      const meta = await new Promise((resolve, reject) => {
        let settled = false;
        const timers = [];
        const cleanup = () => {
          for (const timer of timers) clearTimeout(timer);
        };
        const fail2 = (message) => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            socket.close();
          } catch {
          }
          reject(new Error(message));
        };
        socket.onerror = () => fail2("Kokoro sidecar \u8FDE\u63A5\u5931\u8D25\uFF08WebSocket error\uFF09");
        socket.onclose = () => {
          if (!settled) fail2("Kokoro sidecar \u63D0\u524D\u5173\u95ED\u8FDE\u63A5");
        };
        socket.onopen = () => {
          try {
            socket.send(JSON.stringify({ type: "synth", id: 1, text, sid, speed: 1 }));
          } catch (error) {
            fail2(`Kokoro \u8BF7\u6C42\u53D1\u9001\u5931\u8D25\uFF1A${error?.message ?? String(error)}`);
          }
        };
        socket.onmessage = (event) => {
          const data = event.data;
          if (typeof data === "string") {
            let message;
            try {
              message = JSON.parse(data);
            } catch {
              return;
            }
            if (message?.type === "error") {
              fail2(`Kokoro \u5408\u6210\u5931\u8D25\uFF1A${String(message?.message ?? "\u672A\u77E5\u9519\u8BEF")}`);
              return;
            }
            if (message?.type === "done") {
              if (settled) return;
              settled = true;
              cleanup();
              try {
                socket.close();
              } catch {
              }
              resolve({
                audio_ms: Number(message?.audio_ms) || 0,
                elapsed_ms: Number(message?.elapsed_ms) || 0,
                cpu_s: Number(message?.cpu_s) || 0
              });
            }
            return;
          }
          const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data?.buffer ?? []);
          if (view.byteLength === 0) return;
          if (firstChunkAt === 0) firstChunkAt = Date.now();
          bytes += view.byteLength;
          for (const block of chunker.push(view)) {
            options.onChunk({ data: block, seq: chunks, total: 0, final: false });
            chunks += 1;
          }
        };
        timers.push(setTimeout(() => fail2(`Kokoro \u9996\u5757\u8D85\u65F6\uFF08${budget}ms \u672A\u8FD4\u56DE\u97F3\u9891\uFF09`), budget));
        timers.push(setTimeout(() => fail2("Kokoro \u5408\u6210\u8D85\u65F6\uFF0860s\uFF09"), 6e4));
        const signal = options.signal;
        if (signal !== void 0) {
          const onAbort = () => fail2("\u5DF2\u53D6\u6D88\uFF08\u672C\u8F6E\u6717\u8BFB\u88AB\u6362\u7ED1/\u66F4\u65B0\u7684\u4E00\u8F6E\u53D6\u4EE3\uFF09");
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const tail = chunker.finish();
      for (const block of tail) {
        options.onChunk({ data: block.data, seq: chunks, total: chunks + 1, final: block.final });
        chunks += 1;
      }
      const totalMs = Date.now() - started;
      const audioMs = Math.round(bytes / 2 / TTS_SAMPLE_RATE * 1e3);
      if (audioMs < 50) throw new Error("Kokoro \u6CA1\u6709\u8FD4\u56DE\u6709\u6548\u97F3\u9891\uFF08\u5C11\u4E8E 50ms\uFF09");
      this.log(`kokoro ok chars=${[...text].length} sid=${sid} first=${firstChunkAt === 0 ? "?" : firstChunkAt - started}ms total=${totalMs}ms audio=${audioMs}ms server=${meta.elapsed_ms ?? "?"}ms cpu=${meta.cpu_s ?? "?"}s chunks=${chunks}`);
      return { sampleRate: TTS_SAMPLE_RATE, firstChunkMs: firstChunkAt === 0 ? totalMs : firstChunkAt - started, audioMs, totalMs, chunks };
    } finally {
      try {
        socket.close();
      } catch {
      }
    }
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
    const firstChunkBudget = this.backend() === "q4" || this.backend() === "cpu" ? 6e4 : 45e3;
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
  /** 列出音色：默认（edge）+ Kokoro 中文音色（离线兜底/手切）+ 工作区克隆音色。
   *  `edgeVoice` 是这台设备实际在用的云端音色（宿主配置/TIHU_EDGE_VOICE/云健），
   *  只用来把这句说明写对——别让用户设了「晓晓」、屏上还写着「云健」。 */
  async listVoices(sessionId, edgeVoice) {
    const primaryKokoro = this.engineFor() === "kokoro";
    const cloudVoice = String(edgeVoice ?? "").trim();
    const voices = [{
      name: "default",
      kind: "default",
      note: primaryKokoro ? `\u9ED8\u8BA4 Kokoro ${kokoroVoiceName(kokoroSid())}` : `\u9ED8\u8BA4\uFF1Aedge-tts ${tihuCloudVoiceShortName(cloudVoice)}(${isTihuCloudVoice(cloudVoice) ? cloudVoice : TIHU_CLOUD_VOICE_DEFAULT})`
    }];
    if (this.kokoroReady()) {
      for (const voice of KOKORO_ZH_VOICES) {
        voices.push({ name: voice.name, kind: "default", note: `\u672C\u5730 Kokoro \xB7 ${voice.gender === "f" ? "\u4E2D\u6587\u5973\u58F0" : "\u4E2D\u6587\u7537\u58F0"} sid ${voice.sid}` });
      }
    }
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

// src/tihu/model-select.ts
var QUEUE = Symbol.for("dsh-assistant.tihu-model-select.queue");
function enqueue(task) {
  const holder = globalThis;
  const previous = holder[QUEUE] ?? Promise.resolve();
  const run = previous.then(task, task);
  holder[QUEUE] = run.then(() => void 0, () => void 0);
  return run;
}
function optionalService(ctx, id) {
  try {
    if (ctx && typeof ctx.get === "function") return ctx.get(id);
  } catch {
  }
  return void 0;
}
function sameSelection(left, right) {
  if (left === void 0) return false;
  return left.provider === right.provider && left.model === right.model && (left.reasoningEffort ?? "") === (right.reasoningEffort ?? "");
}
function errorText(error) {
  return error?.message ?? String(error);
}
function selectModelKeepingDefault(ctx, request, log = () => {
}) {
  return enqueue(() => selectAndRestore(ctx, request, log));
}
async function selectAndRestore(ctx, request, log) {
  const controller = optionalService(ctx, "sessionController");
  const selectModel = controller?.selectModel;
  if (typeof selectModel !== "function") {
    return { ok: false, error: "\u5BBF\u4E3B\u6CA1\u6709 sessionController.selectModel\uFF1A\u8FD9\u53F0\u5BBF\u4E3B\u4E0D\u80FD\u7ED9\u4F1A\u8BDD\u5355\u72EC\u6307\u5B9A\u6A21\u578B" };
  }
  const chosen = {
    provider: request.selection.provider,
    model: request.selection.model,
    ...request.selection.reasoningEffort === void 0 || request.selection.reasoningEffort === "" ? {} : { reasoningEffort: request.selection.reasoningEffort }
  };
  const defaults = optionalService(ctx, "agentDefaultModel");
  const previous = typeof defaults?.currentSelection === "function" ? defaults.currentSelection() : void 0;
  try {
    await selectModel.call(controller, {
      sessionId: request.sessionId,
      provider: chosen.provider,
      model: chosen.model,
      ...chosen.reasoningEffort === void 0 ? {} : { reasoningEffort: chosen.reasoningEffort }
    });
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
  if (typeof defaults?.saveSelection === "function" && previous !== void 0 && typeof previous.provider === "string" && previous.provider !== "" && typeof previous.model === "string" && previous.model !== "" && !sameSelection(previous, chosen)) {
    try {
      await defaults.saveSelection({
        provider: previous.provider,
        model: previous.model,
        ...previous.reasoningEffort === void 0 ? {} : { reasoningEffort: previous.reasoningEffort }
      });
    } catch (error) {
      log(`tihu model: \u5DF2\u7ED9\u4F1A\u8BDD\u9009\u597D\u6A21\u578B\uFF0C\u4F46\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B\u6CA1\u6062\u590D\uFF08${errorText(error)}\uFF09`);
    }
  }
  return { ok: true };
}
function tihuModelEnvOverride(kind, env = globalThis.process?.env ?? {}) {
  const name2 = kind === "foreground" ? "TIHU_MODEL_FOREGROUND" : "TIHU_MODEL_BACKGROUND";
  const raw = String(env?.[name2] ?? "").trim();
  if (raw === "") return null;
  const cut = raw.indexOf("/");
  if (cut <= 0 || cut === raw.length - 1) return null;
  return { provider: raw.slice(0, cut).trim(), model: raw.slice(cut + 1).trim() };
}
function tihuModelOfConfig(tihu, kind) {
  const raw = tihu?.model?.[kind];
  if (!raw || typeof raw !== "object") return null;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (provider === "" || model === "") return null;
  const effort = typeof raw.reasoningEffort === "string" ? raw.reasoningEffort.trim() : "";
  return { provider, model, ...effort === "" ? {} : { reasoningEffort: effort } };
}
function resolveTihuModel(kind, tihu, env = globalThis.process?.env ?? {}) {
  return tihuModelEnvOverride(kind, env) ?? tihuModelOfConfig(tihu, kind);
}

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
var SPEECH_BREAK = /[，,、：:；;。！？!?\n]/;
function splitSpeechSegments(text, maxChars = 80, firstChars = 20) {
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
    const cap = index === 0 ? Math.max(1, Math.min(maxChars, firstChars)) : maxChars;
    let end = cursor;
    let lastBreak = -1;
    const limit = Math.min(chars.length, sentences[sentenceIndex].end);
    while (end < limit) {
      const char = chars[end];
      if (SPEECH_BREAK.test(char)) {
        lastBreak = end + 1;
        break;
      }
      if (end - cursor + 1 >= cap) {
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
function stripToolNoise(input) {
  let text = String(input ?? "");
  text = text.replace(/<([a-zA-Z][a-zA-Z0-9_-]*)>[\s\S]*?<\/\1>/g, " ");
  text = text.replace(/<[^>\s]+\/?>/g, " ");
  const noisyLine = /^\s*(?:[✓✗]\s*)?(?:Waited\s+\d|Clicked screen|Pressed hotkey|Opened https?|Opened app|Coordinates remain|position\s*\[|\[image omitted|\(sha256:|Normalized copy|image\/png|read-only copy|(?:screenshot|wait|long_wait|click|hotkey|scroll|drag|input_text|open_in_browser|open_in_finder|open_app|list_apps|code_agent|ask_user_question|skill|present|working_directory|web_search|web_fetch|截图|等待|长等待|点击|按键|滚动|拖拽|输入文字|打开网页|打开文件\/目录|打开应用|列出应用|派发后台任务|等待确认|加载技能|记忆操作|展示结果|切换目录|搜索|抓取网页)\s*$)/i;
  text = text.split(/\r?\n/).filter((line) => !noisyLine.test(line)).join("\n");
  text = text.replace(/Coordinates remain\s+[\d-]+\s*[-–]\s*\d+/gi, " ");
  text = text.replace(/position\s*\[[^\]]*\]/gi, " ");
  return text;
}
function toSpeechText(markdown) {
  let text = stripToolNoise(markdown);
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

// src/client/pocket/orb/asr-terms.ts
var RULES = [
  // ── 专业术语（土木 / 结构 / AI） ──────────────────────────────────
  [/托扑优化|拓朴优化|拓扑优华|托普优化/g, "\u62D3\u6251\u4F18\u5316"],
  [/磷石膏|林石膏|临石膏|邻石膏|磷石高/g, "\u78F7\u77F3\u818F"],
  [/混凝士|混泥土|混凝土/g, "\u6DF7\u51DD\u571F"],
  [/超高性[能熊]混凝土/g, "\u8D85\u9AD8\u6027\u80FD\u6DF7\u51DD\u571F"],
  [/钢结构|刚结构|钢构结/g, "\u94A2\u7ED3\u6784"],
  [/屈曲模[态太]|屈曲摸态/g, "\u5C48\u66F2\u6A21\u6001"],
  [/有限[元原]|有限园/g, "\u6709\u9650\u5143"],
  [/神经网[络落]|神经网络/g, "\u795E\u7ECF\u7F51\u7EDC"],
  [/数据[集级]|数据急/g, "\u6570\u636E\u96C6"],
  [/温度[场厂]|温度长/g, "\u6E29\u5EA6\u573A"],
  [/拱桥|供桥|公桥/g, "\u62F1\u6865"],
  [/提篮拱|提蓝拱/g, "\u63D0\u7BEE\u62F1"],
  [/揭榜挂帅|揭榜挂师/g, "\u63ED\u699C\u6302\u5E05"],
  [/投入产出比|投入产出率/g, "\u6295\u5165\u4EA7\u51FA\u6BD4"],
  [/工程造价|工程造价/g, "\u5DE5\u7A0B\u9020\u4EF7"],
  [/数字教材|数字交材/g, "\u6570\u5B57\u6559\u6750"],
  [/毕业设计|毕业设[计记]/g, "\u6BD5\u4E1A\u8BBE\u8BA1"],
  [/成图大赛|成图大塞/g, "\u6210\u56FE\u5927\u8D5B"],
  // ── 产品 / 工具名 ────────────────────────────────────────────────
  [/迪普西克|深度求索索|dee[pb]\s?seek/gi, "DeepSeek"],
  [/悬浮球|悬浮求|玄浮球/g, "\u60AC\u6D6E\u7403"],
  [/dsh\s?pocket/gi, "dsh-pocket"],
  [/微信支付|微信支[付服]/g, "\u5FAE\u4FE1\u652F\u4ED8"]
];
var personalRules = [];
function compilePersonalTerms(terms) {
  const out = [];
  for (const term of terms ?? []) {
    const pattern = String(term?.pattern ?? "");
    const replacement = String(term?.replace ?? "");
    if (!pattern || !replacement) continue;
    try {
      out.push([new RegExp(pattern, term.flags && /^[a-z]*$/.test(term.flags) ? term.flags : "g"), replacement]);
    } catch {
    }
  }
  return out;
}
function applyPersonalTerms(terms) {
  personalRules = compilePersonalTerms(terms);
}
function fixTerms(text) {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  for (const [pattern, replacement] of personalRules) out = out.replace(pattern, replacement);
  return out;
}
function cleanFillers(text) {
  return text.replace(/^[嗯嗯\s、，,。．.]+/, "").replace(/[嗯呃额]+$/g, "").replace(/\s{2,}/g, " ").trim();
}

// src/assistant-config.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync6, readFileSync as readFileSync6, renameSync as renameSync4, statSync as statSync5, unlinkSync as unlinkSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { dirname as dirname6, isAbsolute as isAbsolute2, join as join9, resolve as resolvePath5 } from "node:path";

// src/assistant-home.ts
import { copyFileSync as copyFileSync3, existsSync as existsSync6, mkdirSync as mkdirSync5, readdirSync, readFileSync as readFileSync5, renameSync as renameSync3, rmdirSync, statSync as statSync4, unlinkSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join8, resolve as resolvePath4, sep } from "node:path";

// src/assistant-memory.ts
import { copyFileSync as copyFileSync2, existsSync as existsSync5, mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync as renameSync2, statSync as statSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join7, resolve as resolvePath3 } from "node:path";

// src/assistant-home.ts
var AGENTS_MARKER = "<!-- dsh-assistant:assistant-home v1 -->";
var HOME_RULES_MARKER = "<!-- dsh-assistant:home-rules v2 -->";
var PERSONA_BEGIN = "<!-- dsh-assistant:persona v1 begin -->";
var PERSONA_END = "<!-- dsh-assistant:persona v1 end -->";
var OUTPUTS_RETENTION_DAYS = 14;
var JOURNAL_ARCHIVE_AFTER_DAYS = 90;
var NOTE_TOTAL_BYTES_LIMIT = 8 * 1024 * 1024;
var ARCHIVE_SOFT_BYTES_LIMIT = 32 * 1024 * 1024;
var TIDY_INTERVAL_MS = 6 * 60 * 60 * 1e3;
var HOME_RULES_MD = `${HOME_RULES_MARKER}
## \u5BB6\u76EE\u5F55\u89C4\u77E9\uFF08\u4EA7\u7269\u522B\u5806\u5728\u8FD9\u91CC\uFF09
\u8FD9\u91CC\u662F\u300C\u4F4F\u7684\u5730\u65B9\u300D\uFF0C\u4E0D\u662F\u300C\u5E72\u6D3B\u7684\u684C\u5B50\u300D\uFF1A
- \u957F\u671F\u6587\u4EF6\u53EA\u653E\u4E09\u6837\uFF1A\`AGENTS.md\`\u3001\`journal/\`\uFF08\u6309\u5929\u65E5\u5FD7\uFF09\u3001\`notes/\`\uFF08\u957F\u671F\u6863\u6848\uFF09\u3002
- \u4E34\u65F6\u4EA7\u7269\uFF08\u811A\u672C\u3001\u622A\u56FE\u3001\u5BFC\u51FA\u3001\u4E2D\u95F4\u7ED3\u679C\uFF09\u4E00\u5F8B\u5199\u5230 \`outputs/YYYY-MM-DD/\`\uFF0C\u6216\u76F4\u63A5\u5199\u7CFB\u7EDF\u4E34\u65F6\u76EE\u5F55\uFF1B
  \`outputs/\` \u91CC\u8D85\u8FC7 ${OUTPUTS_RETENTION_DAYS} \u5929\u7684\u4E1C\u897F\u4F1A\u88AB\u63D2\u4EF6\u81EA\u52A8\u6E05\u6389\uFF0C\u522B\u628A\u8981\u7559\u7684\u4E1C\u897F\u653E\u8FD9\u3002
- \u8981\u957F\u671F\u4FDD\u7559\u3001\u8981\u4EA4\u4ED8\u3001\u8981\u591A\u8F6E\u8FED\u4EE3\u7684\u4EA7\u7269 \u2192 \u5EFA\u9879\u76EE\u5361\u7247\uFF0C\u4EA7\u7269\u843D\u5728\u90A3\u4E2A\u9879\u76EE\u7684\u6587\u4EF6\u5939\u91CC\u3002
- \u5199\u6587\u4EF6\u524D\u5148\u95EE\u81EA\u5DF1\u4E00\u53E5\uFF1A\u8FD9\u6587\u4EF6\u4E09\u5929\u540E\u8FD8\u6709\u7528\u5417\uFF1F\u6CA1\u7528 \u2192 outputs\uFF1B\u6709\u7528 \u2192 \u5EFA\u5361\u3002
`;
var ARCHIVE_RULES_MARKER = "<!-- dsh-assistant:home-rules v3 -->";
var ARCHIVE_RULES_MD = `${ARCHIVE_RULES_MARKER}
## \u5F52\u6863\u89C4\u77E9\uFF08journal / notes \u6709\u5BB9\u91CF\u4E0A\u9650\uFF09
- \`journal/\` \u53EA\u7559\u6700\u8FD1 ${JOURNAL_ARCHIVE_AFTER_DAYS} \u5929\u7684\u65E5\u5FD7\uFF1B\u66F4\u65E9\u7684\u6309\u5E74\u6574\u4EFD\u642C\u8FDB \`archive/journal/<\u5E74>/\`\u3002
- \`notes/\` \u603B\u4F53\u79EF\u4E0A\u9650 ${Math.round(NOTE_TOTAL_BYTES_LIMIT / 1024 / 1024)}MB\uFF1B\u8D85\u4E86\u5C31\u6309\u6700\u65E7\u7684\u6574\u4EFD\u642C\u8FDB \`archive/notes/\`\u3002
- \u642C\u8D70\u7684\u4E1C\u897F\u63D2\u4EF6**\u4E0D\u4F1A\u5220**\uFF0C\u90FD\u5728 \`archive/\` \u91CC\u770B\u5F97\u89C1\uFF1B\u8981\u771F\u7684\u5220\u5F97\u81EA\u5DF1\u5728\u9762\u677F\u4E0A\u52A8\u624B\u3002
- \`outputs/\` \u624D\u4F1A\u88AB\u81EA\u52A8\u5220\uFF08\u8D85\u8FC7 ${OUTPUTS_RETENTION_DAYS} \u5929\uFF09\u3002
`;
var AGENTS_MD = `${AGENTS_MARKER}
# \u79C1\u4EBA\u52A9\u624B

\u4F60\u662F\u8FD9\u4E2A\u52A9\u624B\u76EE\u5F55\u4E3B\u4EBA\u7684\u79C1\u4EBA\u52A9\u624B\uFF1A\u4E0D\u662F\u4EFB\u52A1\u542F\u52A8\u5668\uFF0C\u4E5F\u4E0D\u662F\u901A\u7528\u5BA2\u670D\u3002\u4F60\u4F4F\u5728\u8FD9\u4E2A\u76EE\u5F55\u91CC\uFF0C
\u957F\u671F\u8BB0\u5F97\u4E3B\u4EBA\u505A\u8FC7\u4EC0\u4E48\u3001\u600E\u4E48\u505A\u4E8B\u3001\u8981\u4EC0\u4E48\u6807\u51C6\u3002

## \u5F00\u53E3\u524D\u5148\u770B\u8BB0\u5FC6
1. \u70ED\u8BB0\u5FC6\u6BCF\u8F6E\u5DF2\u7ECF\u6CE8\u5165\uFF1A\`USER.md\` = \u4ED6\u662F\u8C01\u3001\u504F\u597D\u3001\u96F7\u533A\uFF1B\`MEMORY.md\` = \u9879\u76EE\u4E0E\u73AF\u5883\u7684\u786C\u4E8B\u5B9E\u3002
   \u6309\u5B83\u4EEC\u529E\u4E8B\uFF0C\u5DF2\u7ECF\u8BB0\u4E0B\u7684\u4E0D\u8981\u91CD\u590D\u95EE\u3002
2. \u9700\u8981\u66F4\u65E9\u7684\u7EC6\u8282\uFF1A\u7528 \`mnemon_recall\` \u67E5\u8BB0\u5FC6\u3001\`mnemon_document_search\` \u67E5\u9879\u76EE\u6863\u6848\u3002
   \u8981\u7FFB\u67D0\u6B21\u65E7\u4F1A\u8BDD\u7684\u539F\u6587\uFF0C\u5C31\u95EE\u4ED6\u8981\u6216\u8BA9\u4ED6\u6253\u5F00\u90A3\u6761\u4F1A\u8BDD\u2014\u2014\u4E0D\u8981\u51ED\u7A7A\u731C\u3002
3. \u4E0D\u786E\u5B9A\u7684\u4E8B\u5B9E\u4E0D\u8981\u7F16\u3002\u4E0D\u786E\u5B9A\u65F6\u53EA\u95EE\u4E00\u4E2A\u95EE\u9898\uFF0C\u4E0D\u8981\u8FDE\u95EE\u4E00\u4E32\u3002

## \u76F4\u63A5\u505A\uFF0C\u8FD8\u662F\u5EFA\u9879\u76EE\u5361\u7247
\u9ED8\u8BA4**\u76F4\u63A5\u505A**\uFF1A\u4E00\u53E5\u8BDD\u80FD\u7B54\u3001\u4E00\u6B21\u5DE5\u5177\u8C03\u7528\u80FD\u5B8C\u6210\u3001\u4E0D\u9700\u8981\u591A\u8F6E\u4EA7\u51FA\u7269\u3001\u4E0D\u8DE8\u5929\u7684\u4E8B\u3002
\u5EFA\u8BAE**\u5EFA\u5361**\u7684\u60C5\u5F62\uFF1A\u8981\u4EA7\u51FA\u6587\u4EF6/\u4EE3\u7801/\u8BBA\u6587\u7EA7\u4EA4\u4ED8\u7269\u3001\u8981\u591A\u8F6E\u8FED\u4EE3\u3001\u8981\u540E\u53F0\u8DD1\u5F88\u4E45\u3001\u8981\u5E76\u884C\u63A8\u8FDB\u3001
\u8981\u7ED9\u522B\u4EBA\u770B\u8FDB\u5EA6\u3002
- \u5EFA\u5361\u65F6\u8BF4\u660E\u7406\u7531\uFF0C\u5E76\u7ED9\u51FA\u9879\u76EE\u540D + \u76EE\u5F55\u5EFA\u8BAE\uFF0C\u7B49\u4ED6\u5728\u63A7\u5236\u5BA4\u70B9\u300C\u6DFB\u52A0\u9879\u76EE\u300D\u518D\u5F00\u5DE5
  \uFF08\u7B2C\u4E8C\u6B65\u4F1A\u505A\u6210\u4F60\u76F4\u63A5\u5EFA\u5361\uFF0C\u73B0\u5728\u5148\u522B\u81EA\u5DF1\u7CCA\u4E00\u4E2A\u76EE\u5F55\uFF09\u3002
- \u5224\u65AD\u4E0D\u4E86\u5C31\u95EE\u4E00\u53E5\uFF0C\u4E0D\u8981\u9ED8\u9ED8\u628A\u5C0F\u4E8B\u505A\u6210\u5927\u5DE5\u7A0B\uFF0C\u4E5F\u4E0D\u8981\u628A\u5927\u6D3B\u786C\u585E\u8FDB\u4E00\u53E5\u8BDD\u7684\u5BF9\u8BDD\u91CC\u3002

## \u8BB0\u5FC6\u600E\u4E48\u5199\uFF08\u8FD9\u662F\u300C\u8D8A\u7528\u8D8A\u61C2\u4ED6\u300D\u7684\u5168\u90E8\uFF09
- **\u6536\u5DE5**\uFF08\u4ED6\u8BF4\u300C\u6536\u5DE5 / \u4ECA\u5929\u5230\u8FD9 / \u603B\u7ED3\u4E00\u4E0B\u300D\uFF09\uFF1A\u628A\u8FD9\u4E00\u8F6E\u505A\u4E86\u4EC0\u4E48\u3001\u7ED3\u8BBA\u3001\u5F85\u529E\uFF0C
  \u4E00\u884C\u4E00\u6761\u8FFD\u52A0\u5230 \`journal/YYYY-MM-DD.md\`\uFF1B\u65B0\u51FA\u73B0\u7684\u7A33\u5B9A\u4E8B\u5B9E\u5199\u8FDB \`MEMORY.md\`
  \uFF08\u540C\u4E00\u4EF6\u4E8B\u7528 replace \u8986\u76D6\u65E7\u6761\u76EE\uFF0C\u4E0D\u8981\u65B0\u65E7\u5E76\u5B58\u3001\u4E0D\u8981\u5806\u91CD\u590D\uFF09\u3002
- **\u4ED6\u7EA0\u6B63\u4F60**\uFF08\u300C\u4E0D\u5BF9 / \u4E0D\u662F\u8FD9\u6837 / \u8BB0\u4F4F\u300D\uFF09\uFF1A\u7ACB\u523B\u6539\u8BB0\u5FC6\uFF0C\u5E76\u56DE\u4E00\u53E5\u300C\u5DF2\u6539\uFF1A\u4ECE X \u6539\u6210 Y\u300D\u3002
  \u65E7\u7ED3\u8BBA\u8981\u5220\u6389\u6216\u6807\u5E9F\u5F03\u3002
- \u53EA\u8BB0\u80FD\u957F\u671F\u590D\u7528\u7684\u4E8B\u5B9E\u3001\u504F\u597D\u3001\u51B3\u7B56\u3001\u7ED3\u8BBA\u3002\u4E0D\u8BB0\u5BD2\u6684\u3001\u4E34\u65F6\u8FDB\u5EA6\u3001\u4E00\u6B21\u6027\u7684\u4E2D\u95F4\u7ED3\u679C\u3002
- \u4ED6\u95EE\u300C\u4F60\u8BB0\u5F97\u6211\u4EC0\u4E48\u300D\uFF1A\u5206\u6761\u5217\u51FA \`USER.md\` \u4E0E \`MEMORY.md\` \u7684\u8981\u70B9\uFF0C\u5E76\u6807\u51FA\u6700\u8FD1\u6539\u52A8\u7684\u51E0\u6761\u3002

## \u8BED\u6C14
- \u4E2D\u6587\uFF0C\u76F4\u63A5\u7B80\u6D01\uFF1B\u9996\u53E5\u5E26\u72B6\u6001\u56FE\u6807\uFF1A\u2705 \u5B8C\u6210 / \u26A0\uFE0F \u6CE8\u610F / \u2757 \u98CE\u9669 / \u{1F6A7} \u8FDB\u884C\u4E2D / \u{1F4A1} \u5EFA\u8BAE\u3002
- \u975E\u5FC5\u8981\u5C11\u8D34\u4EE3\u7801\u5757\u3001\u957F\u8DEF\u5F84\u3001\u5927\u6BB5\u62A5\u544A\uFF1B\u8981\u5B8C\u6574\u8868\u683C\u4E0E\u89C4\u683C\u65F6\uFF08\u8BBA\u6587\u3001\u56FE\u8868\u3001Word/Excel\uFF09\u6309\u5B66\u672F\u4EA4\u4ED8\u505A\u3002
- \u62A5\u9519\u5148\u67E5\u6839\u56E0\u518D\u7ED9\u65B9\u6848\uFF1B\u5F02\u5E38\u5148\u5B9A\u4F4D\u518D\u52A8\u624B\u3002

## \u8FB9\u754C
- \u5220\u9664\u3001\u8986\u76D6\u3001\u5BF9\u5916\u53D1\u9001\u3001\u82B1\u94B1\u3001\u63D0\u4EA4\u5230\u8FDC\u7AEF\u4E4B\u524D\u5148\u95EE\u4ED6\u3002
- \u4E0D\u628A\u79C1\u4EBA\u4FE1\u606F\u5199\u8FDB\u5BF9\u5916\u6587\u6863\uFF1B\u4E0D\u5728\u4ED6\u6CA1\u8981\u6C42\u65F6\u64C5\u81EA\u6539\u9879\u76EE\u91CC\u7684\u6587\u4EF6\u3002
- \u6743\u9650\u6309\u9700\uFF1A\u65E5\u5E38\u8BFB\u5199\u8DB3\u591F\uFF0C\u4E0D\u8981\u968F\u624B\u5F00\u6700\u9AD8\u6743\u9650\u3002
`;
function assistantHomeDir() {
  const override = String(process.env.DSH_ASSISTANT_HOME ?? "").trim();
  return override !== "" ? override : join8(homedir5(), ".dsh", "assistant");
}
function personaBlockFromConfig() {
  let persona = null;
  try {
    persona = loadAssistantConfig().persona;
  } catch {
    return "";
  }
  const title = String(persona?.title ?? "").trim();
  const lines = (persona?.lines ?? []).map((line) => String(line ?? "").trim()).filter(Boolean);
  if (!title && lines.length === 0) return "";
  const body = lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- \uFF08\u914D\u7F6E\u6587\u4EF6\u91CC persona.lines \u4E3A\u7A7A\uFF09";
  return [
    "",
    PERSONA_BEGIN,
    "## \u672C\u673A\u4EBA\u8BBE\uFF08\u6765\u81EA ~/.dsh/assistant/config.json\uFF0C\u63D2\u4EF6\u6258\u7BA1\u8FD9\u6BB5\uFF09",
    title,
    body,
    "\uFF08USER.md / MEMORY.md \u662F\u6BCF\u8F6E\u81EA\u52A8\u6CE8\u5165\u7684\u70ED\u8BB0\u5FC6\uFF1B\u8FD9\u6BB5\u53EA\u7ED9 AGENTS.md \u4E00\u4E2A\u56FA\u5B9A\u7684\u81EA\u6211\u4ECB\u7ECD\u3002\uFF09",
    PERSONA_END,
    ""
  ].filter((line) => line !== "").join("\n");
}
function applyPersonaSection(text, block) {
  const start = text.indexOf(PERSONA_BEGIN);
  const end = text.indexOf(PERSONA_END);
  if (start >= 0 && end > start) {
    const before = text.slice(0, start).replace(/\s*$/, "\n\n");
    const after = text.slice(end + PERSONA_END.length).replace(/^\s*\n/, "");
    if (block === "") return (before + after).replace(/\n{3,}/g, "\n\n");
    return before + block + "\n\n" + after.replace(/^\n+/, "");
  }
  if (block === "") return text;
  if (text.includes("\u4F60\u662F\u8FD9\u4E2A\u52A9\u624B\u76EE\u5F55\u4E3B\u4EBA\u7684\u79C1\u4EBA\u52A9\u624B")) return text.replace(/\s*$/, "\n\n") + block;
  return text;
}
function ensureAssistantHome() {
  const dir = assistantHomeDir();
  const journal = join8(dir, "journal");
  const notes = join8(dir, "notes");
  const outputs = join8(dir, "outputs");
  const archive = join8(dir, "archive");
  const agentsFile = join8(dir, "AGENTS.md");
  for (const path3 of [dir, journal, notes, outputs, archive]) {
    try {
      mkdirSync5(path3, { recursive: true });
    } catch {
    }
  }
  try {
    const persona = personaBlockFromConfig();
    if (!existsSync6(agentsFile)) {
      writeFileSync3(agentsFile, AGENTS_MD + HOME_RULES_MD + ARCHIVE_RULES_MD + persona, "utf8");
    } else {
      let current = readFileSync5(agentsFile, "utf8");
      let changed = false;
      if (current.includes(AGENTS_MARKER) && !current.includes(HOME_RULES_MARKER)) {
        current = current.replace(/\s*$/, "\n\n") + HOME_RULES_MD;
        changed = true;
      }
      if (current.includes(AGENTS_MARKER) && !current.includes(ARCHIVE_RULES_MARKER)) {
        current = current.replace(/\s*$/, "\n\n") + ARCHIVE_RULES_MD;
        changed = true;
      }
      const withPersona = applyPersonaSection(current, persona);
      if (withPersona !== current) {
        current = withPersona;
        changed = true;
      }
      if (changed) writeFileSync3(agentsFile, current, "utf8");
    }
  } catch {
  }
  return { dir, journal, notes, agentsFile, outputs, archive };
}

// src/assistant-config.ts
function emptyTihuConfig() {
  return { model: { foreground: null, background: null }, voice: { edge: "" } };
}
var EMPTY = {
  newProjectParent: null,
  skillRoot: null,
  asrTerms: [],
  allowedRoots: [],
  allowAllLocalPaths: false,
  persona: null,
  termEnvAllow: [],
  updateSource: "",
  updateCheckEnabled: false,
  tihu: { model: { foreground: null, background: null }, voice: { edge: "" } },
  sourceFile: "",
  loadError: ""
};
var MAX_BODY_BYTES = 256 * 1024;
function assistantConfigCandidates() {
  const env = String(process.env.DSH_ASSISTANT_CONFIG ?? "").trim();
  if (env) return [resolvePath5(env.replace(/^~(?=$|[\\/])/, homedir6()))];
  const out = [];
  out.push(join9(assistantHomeDir(), "config.json"));
  const home = dshHome2();
  out.push(join9(home, "dsh-assistant-config.json"));
  out.push(join9(home, "assistant", "dsh-assistant-config.json"));
  return out;
}
function dshHome2() {
  const env = process.env.DSH_HOME;
  const value = env !== void 0 && env.trim().length > 0 ? env : join9(homedir6(), ".dsh");
  if (value === "~") return homedir6();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolvePath5(homedir6(), value.slice(2));
  return resolvePath5(value);
}
function normalizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 2) {
      const pattern2 = String(item[0] ?? "");
      const replace2 = String(item[1] ?? "");
      if (pattern2 && replace2) out.push({ pattern: pattern2, replace: replace2 });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item;
    const pattern = String(record.pattern ?? "");
    const replace = String(record.replace ?? "");
    if (!pattern || !replace) continue;
    const flags = typeof record.flags === "string" ? record.flags : void 0;
    out.push(flags ? { pattern, replace, flags } : { pattern, replace });
  }
  return out;
}
function normalizeRoots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const text = String(item ?? "").trim();
    if (!text) continue;
    out.push(resolvePath5(text.replace(/^~(?=$|[\\/])/, homedir6())));
  }
  return out;
}
function normalizePersona(raw) {
  if (typeof raw === "string") {
    const lines2 = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines2.length ? { lines: lines2 } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw;
  const lines = Array.isArray(record.lines) ? record.lines.map((line) => String(line ?? "")).filter((line) => line.trim() !== "") : [];
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!lines.length && !title) return null;
  return { ...title ? { title } : {}, ...lines.length ? { lines } : {} };
}
function stripBom(text) {
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
function normalizeTihuModel(raw) {
  if (!isPlainObject(raw)) return null;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (provider === "" || model === "") return null;
  const effort = typeof raw.reasoningEffort === "string" ? raw.reasoningEffort.trim() : "";
  return { provider, model, ...effort === "" ? {} : { reasoningEffort: effort } };
}
function normalizeTihu(raw) {
  const out = emptyTihuConfig();
  if (!isPlainObject(raw)) return out;
  const model = isPlainObject(raw.model) ? raw.model : {};
  out.model.foreground = normalizeTihuModel(model.foreground);
  out.model.background = normalizeTihuModel(model.background);
  const voice = isPlainObject(raw.voice) ? raw.voice : {};
  const edge = typeof voice.edge === "string" ? voice.edge.trim() : "";
  out.voice.edge = isTihuCloudVoice(edge) ? edge : "";
  return out;
}
var cache = null;
function loadAssistantConfig(force = false) {
  const candidates = assistantConfigCandidates();
  const file = candidates.find((path3) => {
    try {
      return existsSync7(path3) && statSync5(path3).isFile();
    } catch {
      return false;
    }
  }) ?? "";
  if (!file) {
    cache = null;
    return { ...EMPTY };
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync5(file).mtimeMs;
  } catch {
  }
  if (!force && cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.value;
  let value = { ...EMPTY, sourceFile: file };
  try {
    const raw = JSON.parse(stripBom(readFileSync6(file, "utf8")));
    const parsed = raw && typeof raw === "object" ? raw : {};
    const newProjectParent = typeof parsed.newProjectParent === "string" ? parsed.newProjectParent.trim() : "";
    const skillRoot = typeof parsed.skillRoot === "string" ? parsed.skillRoot.trim() : "";
    value = {
      newProjectParent: newProjectParent || null,
      skillRoot: skillRoot || null,
      asrTerms: normalizeRules(parsed.asrTerms),
      allowedRoots: normalizeRoots(parsed.allowedRoots ?? parsed.extraRoots),
      allowAllLocalPaths: parsed.allowAllLocalPaths === true,
      persona: normalizePersona(parsed.persona ?? parsed.personaLines),
      termEnvAllow: Array.isArray(parsed.termEnvAllow) ? parsed.termEnvAllow.map((name2) => String(name2 ?? "").trim()).filter(Boolean) : [],
      updateSource: typeof parsed.updateSource === "string" ? parsed.updateSource.trim() : "",
      updateCheckEnabled: parsed.updateCheckEnabled === true,
      tihu: normalizeTihu(parsed.tihu),
      sourceFile: file,
      loadError: ""
    };
  } catch (err) {
    value = { ...EMPTY, sourceFile: file, loadError: String(err?.message ?? err) };
  }
  cache = { file, mtimeMs, value };
  return value;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/tihu/project-groups.ts
function humanTitle(value) {
  const raw = String(value ?? "").replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, " ").replace(/\b[0-9a-f]{8,32}\b/gi, " ").replace(/[（(]\s*[)）]/g, " ").replace(/\s+/g, " ").trim();
  return raw === "" ? "\u672A\u547D\u540D\u4F1A\u8BDD" : raw;
}
function cardsFromState(state) {
  const root = state ?? {};
  const projects = root.projects ?? root;
  if (projects === null || typeof projects !== "object") return [];
  const layouts = Array.isArray(projects.layouts) ? projects.layouts : [];
  const titles = /* @__PURE__ */ new Map();
  for (const layout of layouts) {
    if (layout === null || typeof layout !== "object") continue;
    titles.set(String(layout.id ?? ""), String(layout.title ?? ""));
  }
  const ids = (value) => Array.isArray(value) ? value.map((item) => String(item)) : [];
  const hidden = new Set(ids(projects.hidden));
  const removed = new Set(ids(projects.removed));
  const folders = projects.folders ?? {};
  const overrides = projects.nameOverrides ?? {};
  const ordered = ids(projects.order);
  const candidates = [];
  const pushed = /* @__PURE__ */ new Set();
  for (const id of ordered) {
    if (!titles.has(id) || pushed.has(id)) continue;
    pushed.add(id);
    candidates.push(id);
  }
  for (const id of titles.keys()) {
    if (pushed.has(id)) continue;
    pushed.add(id);
    candidates.push(id);
  }
  const cards = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of candidates) {
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    if (hidden.has(id) || removed.has(id)) continue;
    const override = typeof overrides[id] === "string" ? String(overrides[id]).trim() : "";
    const name2 = (override !== "" ? override : titles.get(id) ?? "").trim();
    const folder = typeof folders[id] === "string" && String(folders[id]).trim() !== "" ? String(folders[id]) : void 0;
    if (name2 === "" && folder === void 0) continue;
    cards.push(folder === void 0 ? { id, name: name2 } : { id, name: name2, folder });
  }
  return cards;
}
function projectNameOf(cwd) {
  const raw = String(cwd ?? "").replace(/[\\/]+$/, "");
  if (raw === "") return "\u5176\u4ED6";
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());
  const find = (needle) => lower.findIndex((part) => part.includes(needle));
  const hostAlias = hostWorkspaceAliasOf(cwd);
  if (hostAlias !== void 0) return hostAlias;
  if (find("\u9752\u5E74") >= 0 || find("\u57FA\u91D1") >= 0 || find("2027") >= 0) return "\u9752\u5E74\u57FA\u91D1\u7533\u8BF7\u4E66";
  if (find("\u78F7\u77F3\u818F") >= 0) return "\u78F7\u77F3\u818FSCI";
  if (find("dsh-assistant") >= 0 || find("dsh-pocket") >= 0 || find("dsh-tuoguan") >= 0 || find("dsh desktop") >= 0) return "dsh-assistant";
  if (find("strata") >= 0 || find("llm") >= 0) return "STRATA";
  if (find("\u9648\u6F58hbeu") >= 0) return "";
  const last = parts[parts.length - 1] ?? "";
  if (/^(temp|tmp|outputs|node_modules|临时|删除)$/i.test(last)) return "";
  return last;
}
function hostWorkspaceAliasOf(cwd) {
  const parts = String(cwd ?? "").replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
  if (parts.length === 0) return void 0;
  const find = (needle) => parts.findIndex((part) => part.includes(needle));
  if (find("dsh_orb") >= 0 || find("profiles") >= 0 || find(".dsh") >= 0 && find("assistant") >= 0) return "\u4E2A\u4EBA\u52A9\u624B";
  return void 0;
}

// src/cu-peer.mjs
import { createRequire as createRequire2 } from "node:module";
import { readdirSync as readdirSync2 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { join as join10, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
function profileNodeModules() {
  const out = [];
  try {
    const profiles = join10(process.env.DSH_HOME || join10(homedir7(), ".dsh"), "profiles");
    for (const entry of readdirSync2(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      out.push(join10(profiles, entry.name, "node_modules"));
    }
  } catch {
  }
  return out;
}
function bases() {
  const out = [];
  const resources = typeof process !== "undefined" ? process.resourcesPath : "";
  if (resources) {
    out.push(join10(resources, "app.asar", "dsh", "node_modules"));
    out.push(join10(resources, "app.asar", "node_modules"));
    out.push(join10(resources, "app", "dsh", "node_modules"));
    out.push(join10(resources, "app", "node_modules"));
  }
  out.push(...profileNodeModules());
  out.push(join10(process.cwd(), "node_modules"));
  return out;
}
var cache2 = /* @__PURE__ */ new Map();
function resolvePeer(name2) {
  for (const base of bases()) {
    try {
      return createRequire2(pathToFileURL(pathResolve(base, "__dsh_probe__.js")).href).resolve(name2);
    } catch {
    }
  }
  return "";
}
async function loadPeer(name2) {
  if (cache2.has(name2)) return cache2.get(name2);
  const resolved = resolvePeer(name2);
  if (!resolved) {
    throw new Error(`dsh-assistant: \u627E\u4E0D\u5230\u5BBF\u4E3B\u6A21\u5757 ${name2}\uFF08Computer Use \u5DE5\u5177\u9700\u8981\u7531 DSH \u5BBF\u4E3B\u52A0\u8F7D\uFF09`);
  }
  const mod = await import(pathToFileURL(resolved).href);
  cache2.set(name2, mod);
  return mod;
}

// src/tihu/control.ts
function shortSessionId(sessionId) {
  return sessionId.replace(/^session-/, "").slice(0, 8) || sessionId.slice(0, 8);
}
function matchSessionRows(rows, ref) {
  const key = String(ref ?? "").trim();
  if (key === "") return { kind: "all", rows: rows.slice(0, 20) };
  const lower = key.toLowerCase();
  const short = (id) => id.replace(/^session-/, "").slice(0, 8).toLowerCase();
  const exact = rows.filter((row) => row.sessionId === key || short(row.sessionId) === lower || row.title === key);
  if (exact.length === 1) return { kind: "one", row: exact[0] };
  if (exact.length > 1) return { kind: "many", rows: exact.slice(0, 8) };
  const prefix = rows.filter((row) => row.title.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return { kind: "one", row: prefix[0] };
  if (prefix.length > 1) return { kind: "many", rows: prefix.slice(0, 8) };
  const contains = rows.filter((row) => row.title.toLowerCase().includes(lower) || short(row.sessionId).includes(lower));
  if (contains.length === 1) return { kind: "one", row: contains[0] };
  if (contains.length > 1) return { kind: "many", rows: contains.slice(0, 8) };
  return { kind: "none" };
}
function formatSessionCandidates(rows) {
  return rows.map((row, index) => {
    const live = row.live ? "\u5728\u7EBF" : "\u672A\u6253\u5F00";
    const at = row.updatedAt > 0 ? new Date(row.updatedAt).toISOString().slice(0, 16).replace("T", " ") : "\u672A\u77E5\u65F6\u95F4";
    return `${index + 1}. ${row.title || shortSessionId(row.sessionId)}\uFF08${shortSessionId(row.sessionId)} \xB7 ${row.preset || "\u672A\u77E5\u6A21\u5F0F"} \xB7 ${live} \xB7 ${at}\uFF09`;
  }).join("\n");
}
function unknownActionError(action, names) {
  return `\u672A\u77E5 action\u300C${action}\u300D\u3002\u5408\u6CD5 action\uFF1A${names.join(" / ")}\u3002\u7528\u6CD5\u89C1\u5DE5\u5177\u63CF\u8FF0\u3002`;
}
function unknownToolError(name2) {
  return `\u6CA1\u6709\u8FD9\u4E2A\u9E48\u9E55\u5DE5\u5177\u300C${name2}\u300D\u3002\u5408\u6CD5\u5DE5\u5177\uFF1A${tihuToolNames().join(" / ")}\u3002`;
}
function matchTaskRows(rows, ref) {
  const key = String(ref ?? "").trim();
  if (key === "") return { kind: "all", rows: rows.slice(0, 12) };
  const lower = key.toLowerCase();
  const idKey = /^\d+$/.test(lower) ? `t${lower}` : lower;
  const exact = rows.filter((row) => row.taskId.toLowerCase() === idKey);
  if (exact.length === 1) return { kind: "one", row: exact[0] };
  const prefix = rows.filter((row) => row.taskId.toLowerCase().startsWith(idKey));
  if (prefix.length === 1) return { kind: "one", row: prefix[0] };
  if (prefix.length > 1) return { kind: "many", rows: prefix.slice(0, 8) };
  const contains = rows.filter((row) => row.title.toLowerCase().includes(lower));
  if (contains.length === 1) return { kind: "one", row: contains[0] };
  if (contains.length > 1) return { kind: "many", rows: contains.slice(0, 8) };
  return { kind: "none" };
}
function formatTaskRows(rows) {
  return rows.map((row) => `${row.taskId}. ${row.title}\uFF08${row.capsule} \xB7 ${row.sub}\uFF09`).join("\n");
}
function formatDeviceResult(outcome) {
  const parts = [outcome.text, outcome.deviceId];
  const echo = String(outcome.echo ?? "").trim();
  if (echo !== "") parts.push(echo);
  else if (outcome.acked !== true && outcome.already !== true) parts.push("\u8BBE\u5907\u672A\u56DE\u6267");
  const line = parts.join(" \xB7 ");
  const note = String(outcome.note ?? "").trim();
  return note === "" ? line : `${line}\uFF08${note}\uFF09`;
}
function activityAtOf(device) {
  const seen = Number(device.lastSeenAt);
  if (Number.isFinite(seen) && seen > 0) return seen;
  const connected = Number(device.connectedAt);
  if (Number.isFinite(connected) && connected > 0) return connected;
  return 0;
}
function mostActiveDevice(devices) {
  let best;
  let bestAt = -1;
  for (const device of devices) {
    if (device.offline === true) continue;
    const at = activityAtOf(device);
    if (at > bestAt) {
      best = device;
      bestAt = at;
    }
  }
  return best;
}
function deviceListHint(devices) {
  if (devices.length === 0) return "\u5F53\u524D\u6CA1\u6709\u9E48\u9E55\u8BBE\u5907\u5728\u7EBF\uFF1A\u5148\u6253\u5F00\u9E48\u9E55\u6A21\u62DF\u8BBE\u5907\u9875\uFF08/tihu\uFF09\u6216\u7528 tihu_status \u770B\u72B6\u6001\u3002";
  return `\u5728\u7EBF\u8BBE\u5907\uFF1A${devices.map((device) => device.id).join("\u3001")}`;
}
function resolveControlDevice(api, deviceId) {
  const all = api.surface.listDevices().filter((device) => device.offline !== true);
  const wanted = String(deviceId ?? "").trim();
  if (wanted !== "") {
    const hit = all.find((device) => device.id === wanted || device.clientId === wanted);
    if (hit !== void 0) return hit;
    throw new Error(`\u9E48\u9E55\u8BBE\u5907 ${wanted} \u4E0D\u5728\u7EBF\uFF08\u53EF\u80FD\u521A\u65AD\u5F00\u6216\u6362\u4E86\u4E00\u5757\u5C4F\uFF09\u3002${deviceListHint(all)}`);
  }
  if (api.callerSessionId !== void 0 && api.callerSessionId !== "") {
    const bound = api.surface.deviceOfSession(api.callerSessionId);
    if (bound !== void 0) return bound;
  }
  const active = mostActiveDevice(all);
  if (active !== void 0) return active;
  throw new Error("\u5F53\u524D\u6CA1\u6709\u9E48\u9E55\u8BBE\u5907\u5728\u7EBF\uFF1A\u5148\u6253\u5F00\u9E48\u9E55\u6A21\u62DF\u8BBE\u5907\u9875\uFF08/tihu\uFF09\uFF0C\u518D\u7528 tihu_status \u786E\u8BA4\u3002");
}
async function resolveControlSession(api, ref, actionName) {
  if (ref === void 0) throw new Error(`${actionName} \u9700\u8981 session \u53C2\u6570\uFF08\u4F1A\u8BDD\u6807\u9898\u5173\u952E\u8BCD\u6216\u4F1A\u8BDD\u4EE3\u53F7\uFF0C\u5982 98bb83cb\uFF09\u3002`);
  const outcome = await api.surface.listSessions(ref);
  if (outcome.kind === "one") return outcome.row;
  if (outcome.kind === "many") {
    throw new Error(`\u300C${ref}\u300D\u5339\u914D\u5230 ${outcome.rows.length} \u6761\u4F1A\u8BDD\uFF0C\u8BF7\u7528\u66F4\u7CBE\u786E\u7684\u5173\u952E\u8BCD\u6216\u4EE3\u53F7\u533A\u5206\uFF1A
${formatSessionCandidates(outcome.rows)}`);
  }
  if (outcome.kind === "all") throw new Error(`${actionName} \u9700\u8981 session \u53C2\u6570\uFF08\u4F1A\u8BDD\u6807\u9898\u5173\u952E\u8BCD\u6216\u4F1A\u8BDD\u4EE3\u53F7\uFF09\u3002`);
  throw new Error(`\u627E\u4E0D\u5230\u4F1A\u8BDD\u300C${ref}\u300D\uFF1A\u53EF\u4EE5\u5148\u7528 tihu_admin(action=list_sessions) \u52A0\u5173\u952E\u8BCD\u5217\u4E00\u4E0B\u5F53\u524D\u4F1A\u8BDD\u3002`);
}
function normalizeToolArgs(spec, raw) {
  const input = raw ?? {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${spec.name} \u7684\u53C2\u6570\u5FC5\u987B\u662F\u4E00\u4E2A\u5BF9\u8C61\u3002`);
  const out = {};
  for (const [key, param] of Object.entries(spec.parameters)) {
    const value = input[key];
    if (value === void 0 || value === null || typeof value === "string" && value.trim() === "") {
      if (param.required) throw new Error(`${spec.name} \u7F3A\u5C11\u5FC5\u586B\u53C2\u6570 ${key}\uFF08${param.description}\uFF09\u3002`);
      continue;
    }
    if (param.type === "number") {
      const num = typeof value === "number" ? value : Number(String(value));
      if (!Number.isFinite(num)) throw new Error(`${spec.name} \u7684 ${key} \u5FC5\u987B\u662F\u6570\u5B57\uFF08${param.description}\uFF09\uFF0C\u6536\u5230\u300C${String(value)}\u300D\u3002`);
      out[key] = num;
      continue;
    }
    if (param.type === "boolean") {
      out[key] = value === true || value === "true" || value === 1;
      continue;
    }
    const text = String(value).trim();
    if (param.enum !== void 0 && !param.enum.includes(text)) {
      throw new Error(`${spec.name} \u7684 ${key} \u53EA\u80FD\u662F ${param.enum.join(" / ")}\uFF0C\u6536\u5230\u300C${text}\u300D\u3002`);
    }
    out[key] = text;
  }
  return out;
}
function strOf(args, key) {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : void 0;
}
function numOf(args, key) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function boolOf(args, key, fallback) {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}
var DEVICE_PARAM = {
  type: "string",
  required: false,
  description: "\u8BBE\u5907 id \u6216\u9875\u9762 clientId\uFF1B\u4E0D\u586B\uFF1D\u6700\u8FD1\u6D3B\u8DC3\u7684\u90A3\u53F0\uFF08\u89C1 tihu_list_devices\uFF09"
};
function deviceFor(args, api) {
  return resolveControlDevice(api, strOf(args, "deviceId"));
}
var deviceTools = [
  /* ---- A. 播放控制（4） ---- */
  {
    name: "tihu_stop_speaking",
    description: "\u7528\u6237\u8BF4\u300C\u505C\u6B62\u9605\u8BFB / \u522B\u5FF5\u4E86 / \u5B89\u9759 / \u95ED\u5634\u300D\u2192 \u7ACB\u523B\u8BA9\u8BBE\u5907\u505C\u58F0\uFF08\u8FDE\u5DF2\u6392\u8FDB\u64AD\u653E\u961F\u5217\u7684\u97F3\u9891\u4E00\u8D77\u6E05\uFF09\uFF0C\u5C4F\u4E0D\u52A8\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      scope: { type: "string", required: false, description: "round=\u53EA\u505C\u672C\u8F6E\uFF08\u9ED8\u8BA4\uFF09\uFF1Ball=\u8FDE\u6392\u961F\u4E2D\u7684\u64AD\u62A5\u4E00\u8D77\u6E05", enum: ["round", "all"] },
      reason: { type: "string", required: false, description: "\u53EA\u8FDB\u65E5\u5FD7\uFF08\u5982\u300C\u7528\u6237\u8BF4\u505C\u6B62\u9605\u8BFB\u300D\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.stopSpeaking(device.id, {
        scope: strOf(args, "scope") ?? "round",
        ...strOf(args, "reason") === void 0 ? {} : { reason: strOf(args, "reason") }
      }));
    }
  },
  {
    name: "tihu_pause_speaking",
    description: "\u7528\u6237\u8BF4\u300C\u5148\u522B\u5FF5\u4E86 / \u6682\u505C / \u7B49\u4F1A\u513F\u518D\u5FF5\u300D\u2192 \u6682\u505C\u5E76\u8BB0\u4F4F\u505C\u5728\u7B2C\u51E0\u6BB5\u3002\u6CE8\u610F\uFF1A\u7EE7\u7EED\u65F6\u4ECE\u672C\u884C\u5F00\u5934\u91CD\u5FF5 1\u20133 \u79D2\uFF08\u6BB5\u7EA7\u7EED\u64AD\uFF0C\u4E0D\u662F\u91C7\u6837\u7EA7\u65E0\u7F1D\uFF09\u3002",
    parameters: { deviceId: DEVICE_PARAM },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.pauseSpeaking(device.id, {}));
    }
  },
  {
    name: "tihu_resume_speaking",
    description: "\u7528\u6237\u8BF4\u300C\u7EE7\u7EED\u5FF5 / \u63A5\u7740\u8BF4 / \u5FF5\u5B8C\u5B83\u300D\u2192 \u4ECE\u6682\u505C\u90A3\u4E00\u884C\u63A5\u7740\u5FF5\u3002\u6CE8\u610F\uFF1A\u7EE7\u7EED\u4F1A\u4ECE\u672C\u884C\u5F00\u5934\u91CD\u5FF5 1\u20133 \u79D2\uFF08\u6BB5\u7EA7\u7EED\u64AD\uFF0C\u4E0D\u662F\u91C7\u6837\u7EA7\u65E0\u7F1D\uFF09\u3002",
    parameters: { deviceId: DEVICE_PARAM },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.resumeSpeaking(device.id, {}));
    }
  },
  {
    name: "tihu_replay",
    description: "\u7528\u6237\u8BF4\u300C\u91CD\u8BFB / \u518D\u5FF5\u4E00\u904D / \u4ECE\u5934\u5FF5\u300D\u2192 \u628A\u5B8C\u6210\u9875\u6B63\u6587\u4ECE\u7B2C 1 \u6BB5\uFF08\u6216\u6307\u5B9A\u6BB5\uFF09\u91CD\u65B0\u5FF5\u4E00\u904D\uFF0C\u5C4F\u4E0A\u9AD8\u4EAE\u540C\u65F6\u56DE\u5230\u90A3\u4E00\u884C\u3002\u53EA\u80FD\u91CD\u8BFB\u5DF2\u5B8C\u6210\u7684\u4EFB\u52A1\uFF0C\u6B63\u5728\u8DD1\u7684\u4F1A\u88AB\u62D2\u7EDD\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: "string", required: false, description: "\u4EFB\u52A1\u77ED\u53F7\uFF08t3 / 3\uFF09\u6216\u6807\u9898\u5173\u952E\u8BCD\uFF1B\u4E0D\u586B\uFF1D\u5F53\u524D\u5C4F\u4E0A\u90A3\u6761" },
      segment: { type: "number", required: false, description: "\u4ECE\u5B8C\u6210\u9875\u7B2C\u51E0\u6BB5\u5F00\u59CB\uFF081 \u8D77\uFF0C\u9ED8\u8BA4 1\uFF09" },
      line: { type: "number", required: false, description: "\u6309\u5B8C\u6210\u9875\u7B2C\u51E0\u884C\u5B9A\u4F4D\u6BB5\uFF08\u4E0E segment \u4E8C\u9009\u4E00\uFF09" },
      force: { type: "boolean", required: false, description: "\u6B63\u6587\u8FD8\u5728\u5FF5\u5386\u53F2\u65F6\u662F\u5426\u6253\u65AD\u91CD\u8BD5\uFF08\u9ED8\u8BA4 false\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.replay(device.id, {
        ...strOf(args, "taskId") === void 0 ? {} : { taskId: strOf(args, "taskId") },
        ...numOf(args, "segment") === void 0 ? {} : { segment: numOf(args, "segment") },
        ...numOf(args, "line") === void 0 ? {} : { line: numOf(args, "line") },
        force: boolOf(args, "force", false)
      }));
    }
  },
  /* ---- B. 屏幕导航（4） ---- */
  {
    name: "tihu_go_home",
    description: "\u7528\u6237\u8BF4\u300C\u56DE\u4E3B\u9875 / \u56DE\u68CB\u76D8 / \u56DE\u5217\u8868 / \u9000\u51FA\u8FD9\u9875\u300D\u2192 \u8BBE\u5907\u56DE\u4EFB\u52A1\u68CB\u76D8\uFF0C\u9ED8\u8BA4\u540C\u65F6\u505C\u6717\u8BFB\uFF08\u7528\u6237\u8981\u4E3B\u9875\u901A\u5E38\u5C31\u662F\u8981\u5B89\u9759\uFF09\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      all: { type: "boolean", required: false, description: "\u6240\u6709\u5728\u7EBF\u8BBE\u5907\u4E00\u8D77\u56DE\uFF08\u9ED8\u8BA4 false\uFF1D\u53EA\u56DE\u5F53\u524D\u8FD9\u53F0\uFF09" },
      stopSpeaking: { type: "boolean", required: false, description: "\u56DE\u4E3B\u9875\u662F\u5426\u540C\u65F6\u505C\u6717\u8BFB\uFF08\u9ED8\u8BA4 true\uFF09" },
      page: { type: "number", required: false, description: "\u56DE\u7B2C\u51E0\u9875\uFF080 \u8D77\uFF0C\u9ED8\u8BA4 0\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.goHome(device.id, {
        all: boolOf(args, "all", false),
        stopSpeaking: boolOf(args, "stopSpeaking", true),
        ...numOf(args, "page") === void 0 ? {} : { page: numOf(args, "page") }
      }));
    }
  },
  {
    name: "tihu_board_page",
    description: "\u7528\u6237\u8BF4\u300C\u4E0B\u4E00\u9875 / \u4E0A\u4E00\u9875 / \u7FFB\u5230\u7B2C 2 \u9875\u300D\u2192 \u68CB\u76D8\u7FFB\u9875\uFF08\u6BCF\u9875 4 \u6761\uFF0C\u9875\u7801\u81EA\u52A8\u5939\u5230\u771F\u5B9E\u8303\u56F4\uFF0C\u5230\u5E95\u4E86\u5C31\u505C\u5728\u672B\u9875\uFF09\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      direction: { type: "string", required: false, description: "prev / next\uFF08\u9ED8\u8BA4 next\uFF09", enum: ["prev", "next"] },
      page: { type: "number", required: false, description: "\u76F4\u63A5\u6307\u5B9A\u9875\u7801\uFF080 \u8D77\uFF1B\u7ED9\u4E86\u5C31\u5FFD\u7565 direction\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.boardPage(device.id, {
        direction: strOf(args, "direction") ?? "next",
        ...numOf(args, "page") === void 0 ? {} : { page: numOf(args, "page") }
      }));
    }
  },
  {
    name: "tihu_open_task",
    description: "\u7528\u6237\u8BF4\u300C\u6253\u5F00\u7B2C 3 \u6761 / \u770B\u7B2C\u4E8C\u4E2A / \u770B\u770B\u90A3\u6761\u4EFB\u52A1 / \u770B\u6700\u8FD1\u5B8C\u6210\u7684\u300D\u2192 \u6253\u5F00\u67D0\u5F20\u5361\u7684\u8BE6\u60C5\uFF08\u6309\u72B6\u6001\u81EA\u52A8\u8FDB\u5B8C\u6210\u9875/\u5F85\u51B3\u7B56\u9875/\u8FDB\u5EA6\u9875\uFF09\u3002\u300C\u7B2C\u51E0\u4E2A\u300D\u662F**\u5F53\u524D\u68CB\u76D8\u9875\u7684\u884C\u53F7\uFF0C\u4ECE 1 \u5F00\u59CB**\uFF08\u5C4F\u4E0A\u7B2C\u4E00\u884C\uFF1D1\uFF09\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: "string", required: false, description: "\u4EFB\u52A1\u77ED\u53F7 t3 / \u7EAF\u6570\u5B57 3" },
      index: { type: "number", required: false, description: "\u5F53\u524D\u68CB\u76D8\u9875\u7B2C\u51E0\u884C\uFF081 \u8D77\uFF1A\u5C4F\u4E0A\u7B2C\u4E00\u884C\uFF1D1\uFF0C\u300C\u7B2C\u4E8C\u4E2A\u300D\uFF1D2\uFF1B\u4E0D\u4F20\u5C31\u9000\u5316\u6210\u300C\u5F53\u524D\u5C4F\u4E0A\u90A3\u6761/\u6700\u8FD1\u5B8C\u6210\u300D\uFF0C\u53EA\u5728\u7528\u6237\u6CA1\u62A5\u5E8F\u53F7\u65F6\u624D\u5141\u8BB8\uFF09" },
      title: { type: "string", required: false, description: "\u6807\u9898\u5173\u952E\u8BCD\uFF08\u7CBE\u786E > \u524D\u7F00 > \u5305\u542B\uFF0C\u547D\u4E2D\u591A\u6761\u4F1A\u7ED9\u5019\u9009\u6E05\u5355\uFF09" },
      recent: { type: "boolean", required: false, description: "\u6253\u5F00\u6700\u8FD1\u4E00\u6761\u5DF2\u5B8C\u6210\u4EFB\u52A1\uFF08\u66FF\u4EE3\u65E7\u7684 open_recent\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.openTaskCard(device.id, {
        ...strOf(args, "taskId") === void 0 ? {} : { taskId: strOf(args, "taskId") },
        ...numOf(args, "index") === void 0 ? {} : { index: numOf(args, "index") },
        ...strOf(args, "title") === void 0 ? {} : { title: strOf(args, "title") },
        recent: boolOf(args, "recent", false)
      }));
    }
  },
  {
    name: "tihu_follow_task",
    description: "\u7528\u6237\u8BF4\u300C\u76EF\u7740\u8FD9\u6761 / \u4E00\u76F4\u770B\u7740\u5B83\u8DD1 / \u8DDF\u4F4F\u300D\u2192 \u8BA9\u8BBE\u5907\u8DDF\u4F4F\u4E00\u6761\u6B63\u5728\u8DD1\u7684\u4EFB\u52A1\uFF0C\u8FDB\u5EA6\u9875\u6BCF\u79D2\u5237\u65B0\uFF1B\u4E0D\u5728\u8DD1\u7684\u4EFB\u52A1\u4F1A\u81EA\u52A8\u6539\u6210\u770B\u5B83\u5BF9\u5E94\u7684\u5C4F\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: "string", required: false, description: "\u4EFB\u52A1\u77ED\u53F7\uFF1B\u4E0D\u586B\uFF1D\u5F53\u524D\u5C4F\u4E0A\u90A3\u6761" },
      until: { type: "string", required: false, description: "done=\u8DDF\u5230\u4EFB\u52A1\u5B8C\u6210\uFF08\u9ED8\u8BA4\uFF09\uFF1Bturn=\u672C\u8F6E\u7ED3\u675F\u5C31\u56DE\u68CB\u76D8", enum: ["done", "turn"] },
      autoHome: { type: "boolean", required: false, description: "\u7ED3\u675F\u540E\u662F\u5426\u81EA\u52A8\u56DE\u68CB\u76D8\uFF08\u9ED8\u8BA4 false\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.followTask(device.id, {
        ...strOf(args, "taskId") === void 0 ? {} : { taskId: strOf(args, "taskId") },
        until: strOf(args, "until") ?? "done",
        autoHome: boolOf(args, "autoHome", false)
      }));
    }
  },
  /* ---- C. 会话 / 唤醒（2） ---- */
  {
    name: "tihu_end_voice_session",
    description: "\u7528\u6237\u8BF4\u300C\u7ED3\u675F\u4F1A\u8BDD / \u7ED3\u675F\u8FD9\u6B21 / \u522B\u542C\u4E86 / \u6536\u5DE5\u300D\u2192 \u5173\u6389\u8FD9\u53F0\u8BBE\u5907\u7684\u8BED\u97F3\u4F1A\u8BDD\u95F8\u95E8\uFF08\u5C4F\u505C\u5728\u539F\u5730\u53D8\u300C\u7A7A\u95F2\u300D\uFF0C\u4E0D\u81EA\u52A8\u56DE\u68CB\u76D8\uFF09\uFF0C\u5E76\u540C\u65F6\u505C\u58F0\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      reason: { type: "string", required: false, description: "\u7ED3\u675F\u539F\u56E0\uFF08\u53EA\u8FDB\u65E5\u5FD7\uFF0C\u9ED8\u8BA4\u300C\u7535\u8111\u7AEF\u6307\u4EE4\u300D\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.endVoiceSession(device.id, {
        ...strOf(args, "reason") === void 0 ? {} : { reason: strOf(args, "reason") }
      }));
    }
  },
  {
    name: "tihu_wake",
    description: "\u7528\u6237\u8BF4\u300C\u5582 / \u6211\u8BF4\u8BDD\u5462 / \u9192\u9192 / \u5728\u542C\u5417\u300D\u2192 \u5F3A\u5236\u8BBE\u5907\u8FDB\u5165\u300C\u5728\u542C\u300D\u5E76\u5F00\u9EA6\uFF08\u771F\u673A\u9700\u56FA\u4EF6\u652F\u6301 voice.listen\uFF0C\u6A21\u62DF\u9875\u7ACB\u5373\u751F\u6548\uFF09\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      prompt: { type: "string", required: false, description: "\u5C4F\u4E0A\u90A3\u884C\u5C0F\u5B57\uFF08\u5982\u300C\u6211\u5728\uFF0C\u8BF4\u5427\u300D\uFF09\uFF1B\u4E0D\u586B\u7528\u9ED8\u8BA4" },
      timeoutMs: { type: "number", required: false, description: "\u591A\u4E45\u6CA1\u4EBA\u8BF4\u8BDD\u81EA\u52A8\u9000\u51FA\uFF08\u6BEB\u79D2\uFF0C\u5939 3000\u201360000\uFF0C\u9ED8\u8BA4 10000\uFF09" },
      stopSpeaking: { type: "boolean", required: false, description: "\u64AD\u62A5\u4E2D\u5524\u9192\u662F\u5426\u5148\u505C\u58F0\uFF08\u9ED8\u8BA4 true\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.wake(device.id, {
        ...strOf(args, "prompt") === void 0 ? {} : { prompt: strOf(args, "prompt") },
        ...numOf(args, "timeoutMs") === void 0 ? {} : { timeoutMs: numOf(args, "timeoutMs") },
        stopSpeaking: boolOf(args, "stopSpeaking", true)
      }));
    }
  },
  /* ---- D. 待决策（2） ---- */
  {
    name: "tihu_answer_decision",
    description: "\u7528\u6237\u8BF4\u300C\u9009\u7B2C\u4E00\u4E2A / \u540C\u610F / \u62D2\u7EDD / \u7B2C\u4E8C\u4E2A\u300D\u2192 \u66FF\u7528\u6237\u5728\u8BBE\u5907\u5C4F\u4E0A\u7684\u5F85\u51B3\u7B56\u91CC\u70B9\u4E00\u4E2A\u9009\u9879\uFF08\u4E0E\u624B\u6307\u70B9\u5C4F\u540C\u4E00\u6761\u8DEF\uFF0C\u7B54\u6848\u771F\u7684\u4EA4\u56DE\u4F1A\u8BDD\uFF09\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: "string", required: false, description: "\u4EFB\u52A1\u77ED\u53F7\uFF1B\u4E0D\u586B\uFF1D\u5F53\u524D\u5C4F\u4E0A\u90A3\u6761" },
      index: { type: "number", required: false, description: "\u7B2C\u51E0\u9879\uFF081 \u8D77\uFF0C\u4E0E\u5C4F\u4E0A\u6309\u94AE\u5E8F\u53F7\u4E00\u81F4\uFF09" },
      text: { type: "string", required: false, description: "\u9009\u9879\u6587\u672C\uFF08\u7CBE\u786E > \u5305\u542B\uFF09\uFF1B\u4E0E index \u4E8C\u9009\u4E00" },
      by: { type: "string", required: false, description: "\u8C01\u7B54\u7684\uFF08\u5199\u8FDB\u767B\u8BB0\u7C3F answeredBy\uFF0C\u9ED8\u8BA4\u300C\u7535\u8111\u7AEF\u6307\u4EE4\u300D\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.answerDecision(device.id, {
        ...strOf(args, "taskId") === void 0 ? {} : { taskId: strOf(args, "taskId") },
        ...numOf(args, "index") === void 0 ? {} : { index: numOf(args, "index") },
        ...strOf(args, "text") === void 0 ? {} : { text: strOf(args, "text") },
        ...strOf(args, "by") === void 0 ? {} : { by: strOf(args, "by") }
      }));
    }
  },
  {
    name: "tihu_dismiss_decision",
    description: "\u7528\u6237\u8BF4\u300C\u968F\u4FBF / \u6309\u9ED8\u8BA4 / \u4F60\u51B3\u5B9A / \u4EA4\u56DE\u7535\u8111\u300D\u2192 \u6309\u9ED8\u8BA4\u9879\u4E86\u7ED3\uFF08\u7B49\u540C 60 \u79D2\u8D85\u65F6\uFF09\u3001\u6216\u62D2\u7EDD\u3001\u6216\u628A\u51B3\u7B56\u4EA4\u56DE\u7535\u8111\u7AEF\u5361\u7247\u3002\u7EDD\u4E0D\u731C\u9009\u9879\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      taskId: { type: "string", required: false, description: "\u4EFB\u52A1\u77ED\u53F7\uFF1B\u4E0D\u586B\uFF1D\u5F53\u524D\u5C4F\u4E0A\u90A3\u6761" },
      mode: { type: "string", required: false, description: "default=\u6309\u9ED8\u8BA4\u9879\u4E86\u7ED3\uFF1Breject=\u9009\u5426\u5B9A\u9879\uFF1Bdelegate=\u8FD8\u56DE\u7535\u8111\u7AEF", enum: ["default", "reject", "delegate"] }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      return formatDeviceResult(await api.surface.dismissDecision(device.id, {
        ...strOf(args, "taskId") === void 0 ? {} : { taskId: strOf(args, "taskId") },
        mode: strOf(args, "mode") ?? "default"
      }));
    }
  },
  /* ---- E. 状态查询（2） ---- */
  {
    name: "tihu_status",
    description: "\u7528\u6237\u95EE\u300C\u8BBE\u5907\u73B0\u5728\u5728\u5E72\u561B / \u5FF5\u5230\u54EA\u4E86 / \u5728\u542C\u5417 / \u6709\u51E0\u4E2A\u4EFB\u52A1\u300D\u2192 \u8BFB\u8BBE\u5907\u73B0\u72B6\uFF08\u5728\u7EBF\u3001\u7ED1\u5B9A\u3001\u5F53\u524D\u5C4F\u3001\u8BFB\u5230\u7B2C\u51E0\u6BB5\u3001\u68CB\u76D8\u8BA1\u6570\u3001\u5F85\u51B3\u7B56\u3001\u97F3\u8272\uFF09\u3002\u4E0D\u586B deviceId \u5C31\u5217\u5168\u90E8\u3002",
    parameters: {
      deviceId: { type: "string", required: false, description: "\u8BBE\u5907 id \u6216 clientId\uFF1B\u4E0D\u586B\uFF1D\u8FD4\u56DE\u6240\u6709\u8BBE\u5907\u4E00\u884C\u4E00\u6761" }
    },
    run: async (args, api) => {
      const wanted = strOf(args, "deviceId");
      if (wanted !== void 0) {
        const device = resolveControlDevice(api, wanted);
        const view = api.surface.deviceStatus(device.id);
        if (view === void 0) throw new Error(`\u9E48\u9E55\u8BBE\u5907 ${device.id} \u4E0D\u5728\u7EBF\uFF08\u53EF\u80FD\u521A\u65AD\u5F00\uFF09\u3002${deviceListHint(api.surface.listDevices())}`);
        return formatDeviceStatus(view);
      }
      const devices = api.surface.listDevices();
      if (devices.length === 0) throw new Error("\u5F53\u524D\u6CA1\u6709\u9E48\u9E55\u8BBE\u5907\u5728\u7EBF\uFF1A\u5148\u6253\u5F00\u9E48\u9E55\u6A21\u62DF\u8BBE\u5907\u9875\uFF08/tihu\uFF09\u3002");
      const active = mostActiveDevice(devices);
      return devices.map((device) => {
        const view = api.surface.deviceStatus(device.id);
        const mark = device.id === active?.id ? "\uFF08\u9ED8\u8BA4\u63A7\u5236\u8FD9\u53F0\uFF09" : "";
        return view === void 0 ? `${device.id}${mark} \xB7 \u521A\u65AD\u5F00` : `${formatDeviceStatus(view)}${mark}`;
      }).join("\n\n");
    }
  },
  {
    name: "tihu_list_devices",
    description: "\u7528\u6237\u95EE\u300C\u6709\u51E0\u4E2A\u8BBE\u5907 / \u54EA\u51E0\u5757\u5C4F\u5728\u7EBF\u300D\u2192 \u5217\u5728\u7EBF\u9E48\u9E55\u8BBE\u5907\uFF08\u8BBE\u5907\u53F7\u3001\u6700\u8FD1\u6D3B\u8DC3\u3001\u5F53\u524D\u5C4F\u3001\u662F\u5426\u5728\u5FF5\uFF09\u3002\u9ED8\u8BA4\u53EA\u63A7\u6700\u8FD1\u6D3B\u8DC3\u7684\u90A3\u53F0\uFF0C\u8981\u6307\u5B9A\u5C31\u4F20 deviceId\u3002",
    parameters: {
      includeOffline: { type: "boolean", required: false, description: "\u8FDE\u6700\u8FD1 10 \u5206\u949F\u89C1\u8FC7\u7684\u79BB\u7EBF\u8BBE\u5907\u4E5F\u5217\u51FA\u6765\uFF08\u9ED8\u8BA4 false\uFF09" }
    },
    run: async (args, api) => {
      const includeOffline = boolOf(args, "includeOffline", false);
      const devices = api.surface.listDevices(includeOffline);
      if (devices.length === 0) {
        throw new Error("\u5F53\u524D\u6CA1\u6709\u9E48\u9E55\u8BBE\u5907\u5728\u7EBF\uFF1A\u5148\u6253\u5F00\u9E48\u9E55\u6A21\u62DF\u8BBE\u5907\u9875\uFF08/tihu\uFF09\uFF0C\u8FDE\u4E0A\u540E\u518D\u95EE\u4E00\u6B21\u3002");
      }
      const active = mostActiveDevice(devices);
      const lines = devices.map((device) => {
        const view = device.offline === true ? void 0 : api.surface.deviceStatus(device.id);
        const parts = [device.id, `\u6700\u8FD1\u6D3B\u8DC3 ${relativeTime(device.lastSeenAt)}`];
        if (device.offline === true) {
          parts.push("\u5DF2\u79BB\u7EBF");
          return `\xB7 ${parts.join(" \xB7 ")}`;
        }
        if (view?.stage !== void 0 && view.stage !== "") parts.push(view.stage);
        if (view?.board !== void 0) parts.push(`\u5B8C\u6210 ${view.board.counts.done}/${view.board.totalTasks}`);
        parts.push(view?.speaking === true ? "\u6717\u8BFB\u4E2D" : "\u6CA1\u5728\u5FF5");
        if (device.id === active?.id) parts.push("\u9ED8\u8BA4\u63A7\u5236");
        return `\xB7 ${parts.join(" \xB7 ")}`;
      });
      const online = devices.filter((device) => device.offline !== true).length;
      const hint = online > 1 ? "\n\u9ED8\u8BA4\u53EA\u63A7\u6700\u8FD1\u6D3B\u8DC3\u7684\u90A3\u53F0\uFF0C\u8981\u6307\u5B9A\u5C31\u4F20 deviceId\u3002" : "";
      return `${online} \u53F0\u9E48\u9E55\u8BBE\u5907\u5728\u7EBF\uFF1A
${lines.join("\n")}${hint}`;
    }
  },
  /* ---- F. 设置（1） ---- */
  {
    name: "tihu_device_settings",
    description: "\u7528\u6237\u8BF4\u300C\u6362\u4E2A\u58F0\u97F3 / \u7528\u6653\u6653\u5FF5 / \u5F00\u514D\u6309\u4F4F / \u5173\u514D\u6309\u4F4F\u300D\u2192 \u6539\u8BBE\u5907\u97F3\u8272\u6216\u514D\u6309\u4F4F\u3002\u514D\u6309\u4F4F\u53EA\u5728\u6A21\u62DF\u9875/\u6D4F\u89C8\u5668\u751F\u6548\uFF08\u771F\u673A\u662F\u56FA\u4EF6\u672C\u5730\u5524\u9192\uFF09\u3002",
    parameters: {
      deviceId: DEVICE_PARAM,
      key: { type: "string", required: true, description: "voice=\u4E91\u97F3\u8272\uFF1Bhandsfree=\u514D\u6309\u4F4F\u8046\u542C", enum: ["voice", "handsfree"] },
      value: { type: "string", required: true, description: "voice \u586B zh-CN-*Neural \u6216\u97F3\u8272\u540D\uFF1Bhandsfree \u586B on/off\uFF08\u4E5F\u8BA4 true/false\uFF09" }
    },
    run: async (args, api) => {
      const device = deviceFor(args, api);
      const key = strOf(args, "key");
      const raw = strOf(args, "value") ?? "";
      if (key === "voice") {
        if (!/^zh-CN-[A-Za-z]+Neural$/.test(raw)) {
          throw new Error(`tihu_device_settings \u7684 value \u53EA\u8BA4\u4E91\u7AEF\u97F3\u8272\uFF1Azh-CN-YunjianNeural\uFF08\u4E91\u5065\uFF09/ zh-CN-YunxiNeural\uFF08\u4E91\u5E0C\uFF09/ zh-CN-XiaoxiaoNeural\uFF08\u6653\u6653\uFF09/ zh-CN-YunyangNeural\uFF08\u4E91\u626C\uFF09\u3002\u6536\u5230\u300C${raw}\u300D\u3002`);
        }
        return formatDeviceResult(await api.surface.deviceSettings(device.id, { key: "voice", value: raw }));
      }
      const on = raw === "on" || raw === "true" || raw === "1" || raw === "\u5F00";
      if (raw !== "on" && raw !== "off" && raw !== "true" && raw !== "false" && raw !== "1" && raw !== "0" && raw !== "\u5F00" && raw !== "\u5173") {
        throw new Error(`tihu_device_settings \u7684 value \u53EA\u8BA4 on / off\uFF08\u514D\u6309\u4F4F\u5F00\u5173\uFF09\uFF0C\u6536\u5230\u300C${raw}\u300D\u3002`);
      }
      return formatDeviceResult(await api.surface.deviceSettings(device.id, { key: "handsfree", value: on }));
    }
  }
];
function formatDeviceStatus(view) {
  const device = view.device;
  const lines = [];
  const head = [`\u8BBE\u5907 ${device.id}`, `\u6700\u8FD1\u6D3B\u8DC3 ${relativeTime(device.lastSeenAt)}`];
  lines.push(head.join(" \xB7 "));
  lines.push(`\u7ED1\u5B9A\uFF1A${device.sessionId === void 0 || device.sessionId === "" ? "\u672A\u7ED1\u5B9A" : device.sessionId}`);
  const stage = view.stage !== void 0 && view.stage !== "" ? view.stage : "";
  const screenTitle = view.screen?.title !== void 0 && view.screen.title !== "" ? view.screen.title : "";
  const lineInfo = view.playback?.line !== void 0 && view.playback.total !== void 0 && view.playback.total > 0 ? ` \xB7 \u7B2C ${view.playback.line + 1}/${view.playback.total} \u884C` : "";
  const taskInfo = view.taskId === void 0 ? "" : ` \xB7 ${view.taskId}${view.taskTitle === void 0 || view.taskTitle === "" ? "" : `\u300C${view.taskTitle}\u300D`}`;
  lines.push(`\u5C4F\uFF1A${stage === "" ? "\uFF08\u8FD8\u6CA1\u4E0B\u53D1\u8FC7\u5C4F\u5E27\uFF09" : stage}${lineInfo}${taskInfo}${stage === "" && screenTitle !== "" ? ` \xB7 ${screenTitle}` : ""}`);
  const playback = view.playback;
  if (playback === void 0) lines.push("\u64AD\u653E\uFF1A\u9875\u9762\u8FD8\u6CA1\u4E0A\u62A5\uFF08\u8001\u56FA\u4EF6\uFF09");
  else if (playback.phase === "playing") {
    lines.push(`\u64AD\u653E\uFF1A\u6717\u8BFB\u4E2D${playback.segment === void 0 ? "" : ` \xB7 \u7B2C ${playback.segment} \u6BB5`}${playback.total === void 0 ? "" : ` / \u5171 ${playback.total} \u6BB5`}`);
  } else if (playback.phase === "paused") {
    lines.push(`\u64AD\u653E\uFF1A\u5DF2\u6682\u505C${playback.segment === void 0 ? "" : ` \xB7 \u505C\u5728\u7B2C ${playback.segment} \u6BB5`}\uFF08\u7EE7\u7EED\u65F6\u4ECE\u672C\u884C\u5F00\u5934\u5FF5\uFF09`);
  } else if (playback.phase === "listening") {
    lines.push("\u64AD\u653E\uFF1A\u5728\u542C");
  } else {
    lines.push("\u64AD\u653E\uFF1A\u7A7A\u95F2");
  }
  if (view.board !== void 0) {
    const c = view.board.counts;
    lines.push(`\u68CB\u76D8\uFF1A\u7B49\u4F60 ${c.awaiting} \xB7 \u5728\u8DD1 ${c.running} \xB7 \u6392\u961F ${c.queued} \xB7 \u5B8C\u6210 ${c.done}\uFF08\u7B2C ${view.board.page + 1}/${view.board.total} \u9875\uFF0C\u5171 ${view.board.totalTasks} \u6761\uFF09`);
  }
  if (view.decision !== void 0) {
    lines.push(`\u5F85\u51B3\u7B56\uFF1A${view.decision.taskId}\u300C${view.decision.question}\u300D\uFF08\u8FD8\u6709 ${view.decision.secondsLeft} \u79D2\uFF0C\u4E0D\u9009\u6309\u9ED8\u8BA4\u9879\uFF09`);
  }
  lines.push(`\u97F3\u8272\uFF1A${device.voice || "default"} \xB7 \u515C\u5E95 ${device.edgeVoice}${device.offlineOnly ? " \xB7 \u4EC5\u79BB\u7EBF" : ""}`);
  return lines.join("\n");
}
function relativeTime(at, now = Date.now()) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return "\u672A\u77E5";
  const diff = Math.max(0, now - value);
  if (diff < 1500) return "\u521A\u521A";
  if (diff < 6e4) return `${Math.round(diff / 1e3)} \u79D2\u524D`;
  if (diff < 36e5) return `${Math.round(diff / 6e4)} \u5206\u949F\u524D`;
  return `${Math.round(diff / 36e5)} \u5C0F\u65F6\u524D`;
}
var adminActions = /* @__PURE__ */ new Map();
function defineAdmin(name2, handler) {
  adminActions.set(name2, handler);
}
function tihuActionNames() {
  return [...adminActions.keys()];
}
defineAdmin("dispatch", async (args, api) => {
  const text = strOf(args, "text");
  if (text === void 0) throw new Error("dispatch \u9700\u8981 text \u53C2\u6570\uFF08\u7528\u6237\u539F\u8BDD\uFF09\u3002\u53EA\u4F20\u9879\u76EE\u540D\u4E0D\u884C\uFF1A\u8981\u6D3E\u7684\u662F\u300C\u505A\u4EC0\u4E48\u300D\u3002");
  return api.surface.dispatch({
    text,
    ...strOf(args, "target") === void 0 ? {} : { project: strOf(args, "target") },
    ...strOf(args, "title") === void 0 ? {} : { title: strOf(args, "title") },
    ...strOf(args, "session") === void 0 ? {} : { session: strOf(args, "session") },
    ...boolOf(args, "newSession", false) ? { newSession: true } : {}
  });
});
defineAdmin("list_tasks", async (_args, api) => {
  const rows = api.surface.listTasks();
  if (rows.length === 0) return "\u767B\u8BB0\u7C3F\u91CC\u73B0\u5728\u6CA1\u6709\u4EFB\u52A1\uFF08\u68CB\u76D8\u662F\u7A7A\u7684\uFF09\u3002";
  return `\u4EFB\u52A1\uFF08${rows.length} \u6761\uFF09\uFF1A
${formatTaskRows(rows)}`;
});
defineAdmin("cancel_task", async (args, api) => {
  return api.surface.cancelTask(strOf(args, "session"));
});
defineAdmin("task_progress", async (args, api) => {
  const row = await resolveControlSession(api, strOf(args, "session"), "task_progress");
  const view = await api.surface.progress(row.sessionId);
  const stats = view.state?.stats ?? view.stats;
  const status = view.running ? "\u6B63\u5728\u8FD0\u884C" : view.speaking ? "\u6717\u8BFB\u4E2D" : "\u7A7A\u95F2";
  const head = `\u300C${view.title}\u300D\uFF1A${status}`;
  if (view.state === void 0) {
    return `${head} \xB7 \u8FD9\u6761\u4F1A\u8BDD\u5728\u9E48\u9E55 lane \u91CC\u8FD8\u6CA1\u6709\u8FDB\u5EA6\u8BB0\u5F55\uFF08\u81F3\u5C11\u8DD1\u8FC7\u4E00\u8F6E turn \u624D\u4F1A\u8BB0\u5F55\u6B65\u9AA4\uFF09\u3002`;
  }
  const elapsed = formatElapsed2(Math.max(0, Date.now() - view.state.turnStartedAt));
  const speed = stats !== void 0 && stats.tokPerSec > 0 ? ` \xB7 ${stats.tokPerSec.toFixed(1)} tok/s` : "";
  const contextPart = stats !== void 0 && stats.contextPercent > 0 ? ` \xB7 \u4E0A\u4E0B\u6587 ${stats.contextPercent.toFixed(0)}%` : "";
  const total = stats !== void 0 && stats.totalTokens > 0 ? ` \xB7 \u7D2F\u8BA1 ${formatTokens(stats.totalTokens)}` : "";
  const activity = view.state.activity.slice(-4).map((entry) => `${entry.label}${entry.detail !== "" ? ` \xB7 ${entry.detail}` : ""}`).join("\uFF1B");
  return [
    `${head} \xB7 \u7B2C ${view.state.step} \u6B65\uFF08\u7B2C ${view.state.turn} \u8F6E\uFF09\xB7 \u9636\u6BB5\u300C${view.state.stageWord}\u300D\xB7 \u5DF2\u7528\u65F6 ${elapsed}${speed}${contextPart}${total}`,
    ...activity !== "" ? [`\u6700\u8FD1\u6D3B\u52A8\uFF1A${activity}`] : [],
    ...view.state.lastResult !== void 0 ? [`\u4E0A\u4E00\u6B65\u7ED3\u679C\uFF1A${view.state.lastResult.ok ? "\u2713" : "\u2717"} ${view.state.lastResult.line}`] : []
  ].join("\n");
});
defineAdmin("list_sessions", async (args, api) => {
  const outcome = await api.surface.listSessions(strOf(args, "session"));
  if (outcome.kind === "none") {
    throw new Error(`\u627E\u4E0D\u5230\u4F1A\u8BDD\u300C${strOf(args, "session") ?? ""}\u300D\uFF1A\u6362\u4E2A\u5173\u952E\u8BCD\uFF0C\u6216\u7559\u7A7A\u5217\u6700\u8FD1 20 \u6761\u3002`);
  }
  const rows = outcome.kind === "one" ? [outcome.row] : outcome.rows;
  if (rows.length === 0) return "\u5F53\u524D\u6CA1\u6709\u4EFB\u4F55\u4F1A\u8BDD\u3002";
  const ref = strOf(args, "session");
  return `${outcome.kind === "many" ? `\u300C${ref}\u300D\u5339\u914D\u5230 ${rows.length} \u6761\uFF0C\u8BF7\u518D\u7CBE\u786E\u4E00\u4E9B\uFF1A` : "\u4F1A\u8BDD\u5217\u8868\uFF1A"}
${formatSessionCandidates(rows)}`;
});
defineAdmin("archive_session", async (args, api) => {
  if (args.confirm !== true) {
    throw new Error("\u5220\u9664\u4F1A\u8BDD\u662F\u5371\u9669\u64CD\u4F5C\uFF1A\u5FC5\u987B\u5148\u8BA9\u7528\u6237\u53E3\u5934\u786E\u8BA4\uFF0C\u7136\u540E\u4EE5 confirm=true \u518D\u8C03\u4E00\u6B21 tihu_admin\uFF08action=archive_session\uFF09\u3002\u672A\u786E\u8BA4\u4E0D\u4F1A\u6267\u884C\u4EFB\u4F55\u5220\u9664\u3002");
  }
  const row = await resolveControlSession(api, strOf(args, "session"), "archive_session");
  const boundDevices = api.surface.listDevices().filter((device) => device.sessionId === row.sessionId);
  if (boundDevices.length > 0) {
    throw new Error(`\u62D2\u7EDD\u5220\u9664\uFF1A\u4F1A\u8BDD\u300C${row.title}\u300D\u6B63\u7ED1\u5B9A\u5728\u9E48\u9E55\u8BBE\u5907 ${boundDevices.map((device) => device.id).join("\u3001")} \u4E0A\u3002\u8BF7\u5148\u5728\u8BBE\u5907\u4E0A\u6362\u7ED1\u6216\u65AD\u5F00\uFF0C\u518D\u5220\u9664\u3002`);
  }
  return api.surface.archiveSession(row.sessionId);
});
var ADMIN_SPEC = {
  name: "tihu_admin",
  description: "\u975E\u8BBE\u5907\u6742\u9879\uFF08\u8BBE\u5907\u63A7\u5236\u8BF7\u7528 tihu_* \u5177\u540D\u5DE5\u5177\uFF09\uFF1Adispatch=\u6D3E\u5355\uFF08text \u5FC5\u586B\uFF0C\u628A\u7528\u6237\u539F\u8BDD\u6D3E\u7ED9\u67D0\u4E2A\u9879\u76EE\u7684\u4EFB\u52A1\u4F1A\u8BDD\uFF09\uFF1Blist_tasks=\u770B\u767B\u8BB0\u7C3F\uFF1Bcancel_task=\u64A4\u8FD8\u6CA1\u8D77\u8DD1\u7684\u4EFB\u52A1\uFF1Btask_progress=\u67E5\u4F1A\u8BDD\u8DD1\u5230\u7B2C\u51E0\u6B65\uFF1Blist_sessions=\u6309\u5173\u952E\u8BCD\u5217\u4F1A\u8BDD\uFF1Barchive_session=\u5220\u4F1A\u8BDD\uFF08\u987B confirm=true \u4E14\u5148\u5F81\u5F97\u7528\u6237\u53E3\u5934\u786E\u8BA4\uFF09\u3002",
  parameters: {
    action: { type: "string", required: true, description: "\u8981\u6267\u884C\u7684\u64CD\u4F5C", enum: [...adminActions.keys()] },
    session: { type: "string", required: false, description: "\u4F1A\u8BDD\u6807\u9898\u5173\u952E\u8BCD/\u4EE3\u53F7\uFF08task_progress / list_sessions / archive_session \u7528\uFF1Bcancel_task \u4F20\u4EFB\u52A1\u53F7 t3\uFF09" },
    text: { type: "string", required: false, description: "dispatch \u4E13\u7528\uFF1A\u7528\u6237\u539F\u8BDD\uFF08\u8981\u505A\u4EC0\u4E48\uFF09" },
    target: { type: "string", required: false, description: "dispatch \u53EF\u9009\uFF1A\u9879\u76EE\u5361\u540D\u6216\u6587\u4EF6\u5939\u5173\u952E\u8BCD" },
    title: { type: "string", required: false, description: "dispatch \u53EF\u9009\uFF1A\u4EFB\u52A1\u6807\u9898" },
    newSession: { type: "boolean", required: false, description: "dispatch \u53EF\u9009\uFF1A\u660E\u786E\u65B0\u5EFA\u4E00\u6761\u72EC\u7ACB\u4F1A\u8BDD" },
    confirm: { type: "boolean", required: false, description: "archive_session \u4E13\u7528\uFF1A\u5FC5\u987B true\uFF08\u5DF2\u8BA9\u7528\u6237\u53E3\u5934\u786E\u8BA4\uFF09\u624D\u4F1A\u5220\u9664" }
  },
  run: async (args, api) => {
    const action = String(args.action);
    const handler = adminActions.get(action);
    if (handler === void 0) throw new Error(unknownActionError(action, tihuActionNames()));
    return handler(args, api);
  }
};
var TIHU_TOOLS = [...deviceTools, ADMIN_SPEC];
function tihuToolNames() {
  return TIHU_TOOLS.map((tool) => tool.name);
}
function tihuToolSpec(name2) {
  return TIHU_TOOLS.find((tool) => tool.name === name2);
}
function createTihuToolRunner(surface) {
  return async function runTihuTool(name2, rawArgs, caller) {
    const spec = tihuToolSpec(name2);
    if (spec === void 0) throw new Error(unknownToolError(name2));
    try {
      surface.noteToolCall?.(spec.name, rawArgs);
    } catch {
    }
    const args = normalizeToolArgs(spec, rawArgs);
    return spec.run(args, {
      surface,
      ...caller?.sessionId === void 0 || caller.sessionId === "" ? {} : { callerSessionId: caller.sessionId }
    });
  };
}
var TIHU_CONTROL_SECTION_NAME = "tihu:control";
var TIHU_CONTROL_SECTION_TEXT = "\u9E48\u9E55\u8BBE\u5907\u63A7\u5236\u8D70 tihu_* \u5177\u540D\u5DE5\u5177\uFF1A\u52A8\u4F5C\u7C7B\u4E00\u5F8B\u5355\u53F0\u4E0B\u53D1\u3001\u8981\u7B49\u56DE\u6267\uFF0C\u4E0D\u8BB8\u9759\u9ED8\u6210\u529F\u3002\u5220\u9664\u4F1A\u8BDD\u524D\u5FC5\u987B\u5148\u8BA9\u7528\u6237\u53E3\u5934\u786E\u8BA4\uFF0C\u518D\u4EE5 confirm=true \u8C03 tihu_admin\u3002";
function registerControlSection(ctx, log) {
  let systemPrompt;
  try {
    systemPrompt = (typeof ctx?.get === "function" ? ctx.get("systemPrompt") : void 0) ?? ctx?.systemPrompt;
  } catch {
    systemPrompt = ctx?.systemPrompt;
  }
  if (systemPrompt === void 0 || systemPrompt === null || typeof systemPrompt.section !== "function") {
    log("[dsh-assistant] \u6CA1\u6709 systemPrompt \u670D\u52A1\uFF1A\u8DF3\u8FC7 tihu \u63A7\u5236\u5DE5\u5177\u63D0\u793A\uFF08\u4E0D\u5F71\u54CD\u5DE5\u5177\u672C\u8EAB\uFF09");
    return void 0;
  }
  try {
    const off = systemPrompt.section({
      name: TIHU_CONTROL_SECTION_NAME,
      // CU 策略段 1750、播报风格 1800：这里紧随其后。
      order: 1810,
      text: () => TIHU_CONTROL_SECTION_TEXT
    });
    return typeof off === "function" ? off : void 0;
  } catch (error) {
    log(`[dsh-assistant] tihu \u63A7\u5236\u5DE5\u5177\u63D0\u793A\u6CE8\u518C\u5931\u8D25\uFF1A${error?.message ?? String(error)}`);
    return void 0;
  }
}
function serviceOf(ctx, id) {
  try {
    if (ctx && typeof ctx.get === "function") return ctx.get(id);
  } catch {
  }
  return void 0;
}
function callerSessionIdOf(exec) {
  const session = exec?.agent?.session;
  const direct = session?.id;
  if (typeof direct === "string" && direct !== "") return direct;
  const header = session?.header?.id;
  if (typeof header === "string" && header !== "") return header;
  return typeof exec?.agent?.sessionId === "string" && exec.agent.sessionId !== "" ? exec.agent.sessionId : void 0;
}
function jsonSchemaOf(parameters) {
  const properties = {};
  const required = [];
  for (const [key, param] of Object.entries(parameters)) {
    properties[key] = {
      type: param?.type,
      ...param?.description === void 0 ? {} : { description: param.description },
      ...param?.enum === void 0 ? {} : { enum: [...param.enum] }
    };
    if (param?.required === true) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...required.length === 0 ? {} : { required },
    additionalProperties: false
  };
}
async function registerTihuControl(ctx, surface, log = () => {
}) {
  const run = createTihuToolRunner(surface);
  const { defineTool } = await loadPeer("@deepseek-ai/dsh-tools");
  const tools = serviceOf(ctx, "tools") ?? ctx?.tools;
  if (tools === void 0 || tools === null || typeof tools.register !== "function") {
    throw new Error("\u5BBF\u4E3B\u6CA1\u6709 tools \u670D\u52A1\uFF1Atihu \u63A7\u5236\u5DE5\u5177\u6CE8\u518C\u5931\u8D25");
  }
  const offs = [];
  for (const spec of TIHU_TOOLS) {
    const parameters = {};
    for (const [key, param] of Object.entries(spec.parameters)) {
      parameters[key] = {
        type: param.type,
        required: param.required,
        description: param.description,
        ...param.enum === void 0 ? {} : { enum: [...param.enum] }
      };
    }
    const baseDefinition = {
      name: spec.name,
      description: spec.description,
      parameters,
      execute: async (args, exec) => run(spec.name, args, { sessionId: callerSessionIdOf(exec) })
    };
    let definition;
    try {
      definition = defineTool(baseDefinition);
    } catch {
      definition = { ...baseDefinition, parameters: jsonSchemaOf(parameters) };
    }
    const off = tools.register(definition);
    if (typeof off === "function") offs.push(off);
  }
  const offSection = registerControlSection(ctx, log);
  log(`[dsh-assistant] \u9E48\u9E55\u8BBE\u5907\u5DE5\u5177\u5DF2\u6CE8\u518C\uFF0815 \u4E2A\u8BBE\u5907\u5DE5\u5177 + tihu_admin\uFF09`);
  return () => {
    for (const off of offs) {
      try {
        off();
      } catch {
      }
    }
    try {
      offSection?.();
    } catch {
    }
  };
}

// src/tihu/task-ledger.ts
var RING_FULL_MS = 30 * 6e4;
var ANNOUNCE_WINDOW_MS = 8e3;
var ANNOUNCE_SINGLE_DELAY_MS = 400;
var BOARD_PAGE_SIZE = 4;
var LEDGER_MAX_TASKS = 60;
var DONE_KEEP_MS = 3 * 24 * 60 * 6e4;
var LEDGER_SNAPSHOT_VERSION = 1;
var LEDGER_RESTORE_MAX = LEDGER_MAX_TASKS;
var RESTORED_INTERRUPTED_LINE = "\u91CD\u542F\u524D\u672A\u8DD1\u5B8C\uFF0C\u5DF2\u6309\u7ED3\u675F\u5904\u7406";
function capsuleOf(state) {
  switch (state) {
    case "queued":
    case "dispatched":
      return "\u6392\u961F\u4E2D";
    case "running":
      return "\u6267\u884C\u4E2D";
    case "awaiting":
      return "\u5F85\u51B3\u7B56";
    case "done":
    case "announced":
      return "\u5B8C\u6210";
    case "archived":
      return "\u5DF2\u5F52\u6863";
    default:
      return "\u6392\u961F\u4E2D";
  }
}
function isFinishedState(state) {
  return state === "done" || state === "announced";
}
function taskTitleOf(text, maxChars = 18) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().replace(/^[，,。.、\s]+/, "").replace(/[。！？!?；;，,、\s]+$/g, "").trim();
  if (clean === "") return "\u8FD9\u6761\u4EFB\u52A1";
  const chars = [...clean];
  if (chars.length <= maxChars) return clean;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}\u2026`;
}
function subLineOf(task, projectName) {
  const project = String(projectName ?? task.projectName ?? "").trim();
  if (task.source === "pc") return project === "" ? "\u7535\u8111\u7AEF" : `\u7535\u8111\u7AEF \xB7 ${project}`;
  const head = project === "" ? "" : project;
  if (task.waitingCommander === true) return head === "" ? "\u7B49\u6307\u6325\u53F0\u5224\u65AD" : `${head} \xB7 \u7B49\u6307\u6325\u53F0\u5224\u65AD`;
  if (task.state === "queued") return head === "" ? "\u6392\u961F\u4E2D" : `${head} \xB7 \u6392\u961F\u4E2D`;
  if (task.state === "dispatched") return head === "" ? "\u6392\u961F\u4E2D" : `${head} \xB7 \u6392\u961F\u4E2D`;
  if (isFinishedState(task.state)) return head === "" ? "\u5DF2\u5B8C\u6210" : `${head} \xB7 \u5DF2\u5B8C\u6210`;
  if (task.step <= 0) return head === "" ? "\u6267\u884C\u4E2D" : `${head} \xB7 \u6267\u884C\u4E2D`;
  return head === "" ? `\u7B2C ${task.step} \u6B65` : `${head} \xB7 \u7B2C ${task.step} \u6B65`;
}
function ringOf(task, now) {
  if (task.state === "queued" || task.state === "dispatched" || task.state === "archived") return { percent: 0, tone: "empty" };
  if (isFinishedState(task.state)) return { percent: 1, tone: "done" };
  const end = task.state === "awaiting" ? task.updatedAt : now;
  const elapsed = Math.max(0, end - task.startedAt);
  const percent = Math.min(1, elapsed / RING_FULL_MS);
  return { percent, tone: elapsed > RING_FULL_MS ? "warn" : "normal" };
}
function boardTitleOf(task) {
  const title = String(task.title ?? "").trim();
  const project = String(task.projectName ?? "").trim();
  if (title === "" || project === "" || !title.startsWith(project)) return title;
  const rest = title.slice(project.length);
  if (rest !== "" && !/^[\s·:：\-—]/.test(rest)) return title;
  const clean = rest.replace(/^[\s·:：\-—]+/, "").trim();
  return clean === "" ? title : clean;
}
function rowOf(task, now) {
  const row = {
    taskId: task.taskId,
    title: boardTitleOf(task),
    state: task.state === "archived" ? "done" : task.state,
    capsule: capsuleOf(task.state),
    sub: subLineOf(task),
    ring: ringOf(task, now)
  };
  if (task.state === "awaiting") {
    row.badge = "ask";
    row.ring = { percent: 0, tone: "empty" };
  }
  if ((task.childRunning ?? 0) > 0) {
    row.subagents = task.childRunning;
    row.blink = true;
  }
  if (task.stepDurations !== void 0 && task.stepDurations.length > 0) row.micro = task.stepDurations.slice(-8);
  return row;
}
function isPinnedBoardTask(task) {
  return task.source !== "pc";
}
function boardRankOf(task) {
  if (task.state === "awaiting") return 0;
  if (task.state === "running") return 1;
  if (task.state === "dispatched" && (task.childRunning ?? 0) > 0) return 1;
  return 2;
}
function boardRowIndex(raw) {
  const text = typeof raw === "string" ? raw.trim() : raw;
  const num = typeof text === "number" ? text : Number(text);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 1) {
    throw new Error(`\u68CB\u76D8\u884C\u53F7\u4ECE 1 \u5F00\u59CB\uFF08\u5C4F\u4E0A\u7B2C\u4E00\u884C\u5C31\u662F 1\uFF09\uFF0C\u6536\u5230\u7684\u662F ${JSON.stringify(raw)}\uFF1B\u8981\u5F00\u7B2C N \u884C\u8BF7\u4F20 index=N\uFF08N\u22651 \u7684\u6574\u6570\uFF09\u3002`);
  }
  return num;
}
function boardOf(tasks, now, page = 0) {
  const live = tasks.filter((task) => task.state !== "archived");
  const awaitingProjects = new Set(
    live.filter((task) => task.state === "awaiting").map((task) => task.projectId)
  );
  const timeOf = (task) => isFinishedState(task.state) ? task.finishedAt ?? task.updatedAt : task.updatedAt;
  const sorted = [...live].sort((a, b) => {
    const byRank = boardRankOf(a) - boardRankOf(b);
    if (byRank !== 0) return byRank;
    const aProject = awaitingProjects.has(a.projectId) ? 0 : 1;
    const bProject = awaitingProjects.has(b.projectId) ? 0 : 1;
    if (aProject !== bProject) return aProject - bProject;
    const aAt = timeOf(a);
    const bAt = timeOf(b);
    if (aAt !== bAt) return bAt - aAt;
    const byPin = (isPinnedBoardTask(b) ? 1 : 0) - (isPinnedBoardTask(a) ? 1 : 0);
    if (byPin !== 0) return byPin;
    return a.taskId.localeCompare(b.taskId);
  });
  const rows = sorted.map((task) => rowOf(task, now));
  const totalPages = Math.max(1, Math.ceil(rows.length / BOARD_PAGE_SIZE));
  const index = Math.max(0, Math.min(Math.trunc(page), totalPages - 1));
  const counts = countsOf(tasks);
  return {
    rows: rows.slice(index * BOARD_PAGE_SIZE, (index + 1) * BOARD_PAGE_SIZE),
    counts,
    page: { index, total: totalPages },
    total: rows.length,
    empty: rows.length === 0
  };
}
function countsOf(tasks) {
  let running = 0;
  let awaiting = 0;
  let queued = 0;
  let done = 0;
  for (const task of tasks) {
    if (task.state === "running") running += 1;
    else if (task.state === "awaiting") awaiting += 1;
    else if (task.state === "queued" || task.state === "dispatched") queued += 1;
    else if (isFinishedState(task.state)) done += 1;
  }
  return { running, awaiting, queued, done };
}
function clipRecordText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}\u2026` : text;
}
function recordNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function ledgerRecordOf(task) {
  if (task.state === "archived") return void 0;
  const record = {
    taskId: task.taskId,
    source: task.source === "pc" ? "pc" : "tihu",
    title: clipRecordText(task.title, 40),
    projectId: clipRecordText(task.projectId, 80),
    projectName: clipRecordText(task.projectName, 40),
    preset: clipRecordText(task.preset, 24) || "standard",
    state: task.state,
    startedAt: recordNumber(task.startedAt, 0),
    updatedAt: recordNumber(task.updatedAt, 0),
    sessionIds: task.sessionIds.filter((id) => typeof id === "string" && id !== "").slice(0, 4)
  };
  const folder = clipRecordText(task.folder, 260);
  if (folder !== "") record.folder = folder;
  const finishedAt = recordNumber(task.finishedAt, 0);
  if (finishedAt > 0) record.finishedAt = finishedAt;
  const resultLine = clipRecordText(task.resultLine, 120);
  if (resultLine !== "") record.resultLine = resultLine;
  const summary = clipRecordText(task.summary, 120);
  if (summary !== "") record.summary = summary;
  return record;
}
function ledgerSnapshotOf(tasks, now = Date.now()) {
  const records = [];
  for (const task of tasks) {
    const record = ledgerRecordOf(task);
    if (record !== void 0) records.push(record);
  }
  return { v: LEDGER_SNAPSHOT_VERSION, savedAt: now, tasks: records };
}
function recordActivityOf(record) {
  return Math.max(
    recordNumber(record.finishedAt, 0),
    recordNumber(record.updatedAt, 0),
    recordNumber(record.startedAt, 0)
  );
}
function restoreLedgerTasks(records, now = Date.now()) {
  const rows = Array.isArray(records) ? records : [];
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  let dropped = 0;
  let ended = 0;
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") {
      dropped += 1;
      continue;
    }
    const record = raw;
    const taskId = String(record.taskId ?? "").trim();
    const idMatch = /^([tp])(\d+)$/.exec(taskId);
    const savedState = String(record.state ?? "");
    if (idMatch === null || savedState === "archived" || seen.has(taskId)) {
      dropped += 1;
      continue;
    }
    const activity = recordActivityOf(record);
    if (activity <= 0 || now - activity > DONE_KEEP_MS) {
      dropped += 1;
      continue;
    }
    const interrupted = savedState !== "done" && savedState !== "announced";
    if (interrupted) ended += 1;
    const finishedAt = recordNumber(record.finishedAt, 0) || activity;
    const resultLine = interrupted ? RESTORED_INTERRUPTED_LINE : clipRecordText(record.resultLine, 120);
    const task = {
      taskId,
      source: idMatch[1] === "p" || record.source === "pc" ? "pc" : "tihu",
      title: taskTitleOf(record.title),
      projectId: clipRecordText(record.projectId, 80),
      projectName: clipRecordText(record.projectName, 40),
      sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter((id) => typeof id === "string" && id !== "").slice(0, 4) : [],
      preset: clipRecordText(record.preset, 24) || "standard",
      state: "done",
      step: 0,
      turn: 0,
      startedAt: recordNumber(record.startedAt, 0) || finishedAt,
      updatedAt: Math.max(finishedAt, recordNumber(record.updatedAt, 0)),
      finishedAt,
      resultLine,
      summary: clipRecordText(record.summary, 120),
      // 恢复出来的历史**不再播报**：重启后念一堆旧完成会吵死人。
      spokenAt: finishedAt
    };
    const folder = clipRecordText(record.folder, 260);
    if (folder !== "") task.folder = folder;
    seen.add(taskId);
    normalized.push({ task, activity });
  }
  normalized.sort((a, b) => b.activity - a.activity || b.task.taskId.localeCompare(a.task.taskId));
  const kept = normalized.slice(0, LEDGER_RESTORE_MAX);
  dropped += normalized.length - kept.length;
  return { tasks: kept.map((item) => item.task), restored: kept.length, dropped, ended };
}
var TaskLedger = class {
  tasks = /* @__PURE__ */ new Map();
  seq = 0;
  /** 电脑端会话的短号计数器：与派单的 `t` 序列分开，屏上截图才对得上号。 */
  pcSeq = 0;
  /**
   * 归档行的落地口（lane 传「往 journal 追加一行」）。
   * 自动归档（prune）也走它：不然清掉老任务时那一行就悄悄丢了。
   * 注意：node 的 strip-only 模式不支持构造函数参数属性（`constructor(private x)`），
   * 所以这里显式声明字段 ＋ 赋值。
   */
  journal;
  /**
   * 状态变化回调（lane 用来把台账落盘，做跨重启记忆）。
   * 只通知「该存一次」，不做 IO；写盘节奏由调用方防抖。
   */
  onChange;
  constructor(journal, options = {}) {
    this.journal = journal;
    this.onChange = options.onChange;
  }
  /** 状态变了：通知落盘口（回调抛错绝不影响登记簿本身）。 */
  notifyChange() {
    try {
      this.onChange?.();
    } catch {
    }
  }
  /** 新派（或追加）一条任务。返回登记簿里的这一条（同一对象，后续原地更新）。 */
  add(input) {
    const now = input.now ?? Date.now();
    const source = input.source === "pc" ? "pc" : "tihu";
    const seq = source === "pc" ? this.pcSeq += 1 : this.seq += 1;
    const task = {
      taskId: `${source === "pc" ? "p" : "t"}${seq}`,
      source,
      title: taskTitleOf(input.title),
      projectId: input.projectId,
      projectName: input.projectName,
      sessionIds: [...input.sessionIds ?? []],
      preset: input.preset ?? "standard",
      state: input.state ?? "queued",
      step: 0,
      turn: 0,
      startedAt: input.startedAt ?? now,
      updatedAt: now,
      summary: "",
      ...input.folder === void 0 || input.folder === "" ? {} : { folder: input.folder },
      ...input.waitingCommander === true ? { waitingCommander: true } : {}
    };
    this.tasks.set(task.taskId, task);
    this.prune(now);
    this.notifyChange();
    return task;
  }
  /**
   * 从落盘记录恢复（跨重启记住完成历史）。
   *
   * 只入簿、不改盘：写盘由调用方的 onChange 防抖决定。短号计数器按恢复出来
   * 的最大号回填，重启后新派的任务不会撞上 `t1`/`p1`。
   */
  restore(records, now = Date.now()) {
    const result = restoreLedgerTasks(records, now);
    for (const task of result.tasks) {
      if (this.tasks.has(task.taskId)) continue;
      this.tasks.set(task.taskId, task);
      const seq = Number(task.taskId.slice(1));
      if (!Number.isFinite(seq) || seq <= 0) continue;
      if (task.taskId.startsWith("p")) this.pcSeq = Math.max(this.pcSeq, seq);
      else this.seq = Math.max(this.seq, seq);
    }
    return result;
  }
  get(taskId) {
    return this.tasks.get(taskId);
  }
  /**
   * 按会话反查任务（事件归一到任务要靠它）。
   *
   * 一条会话可能挂着两张卡（用户 2026-11-10 实机规则：新一句话接到已完成的旧任务那条会话上时
   * **旧卡留在棋盘上、新卡另起一张**）：归一拿**最近动过**的那张，否则旧的那张（已完成的
   * 任务）会把 turn/start/turn/end 全抢走，新卡永远停在「排队中」、完成也落不到它身上。
   * 时刻相同时取后入簿的那张（＝新卡）。
   */
  ofSession(sessionId) {
    let best;
    for (const task of this.tasks.values()) {
      if (task.state === "archived") continue;
      if (!task.sessionIds.includes(sessionId)) continue;
      if (best === void 0 || task.updatedAt >= best.updatedAt) best = task;
    }
    return best;
  }
  /**
   * 全部任务（含归档；棋盘投影自己会滤掉归档）。
   *
   * 顺序＝入簿顺序（Map 的插入序）：`t` 与 `p` 混排时也能保留真实先后，
   * 不能按短号数字排——`p2` 与 `t2` 会撞号。
   */
  list() {
    return [...this.tasks.values()];
  }
  size() {
    return this.tasks.size;
  }
  /** 屏上当前这条（待决策/详情用）：优先未归档里最新动的。 */
  current() {
    let best;
    for (const task of this.tasks.values()) {
      if (task.state === "archived") continue;
      if (best === void 0 || task.updatedAt >= best.updatedAt) best = task;
    }
    return best;
  }
  /** 绑上承载会话（派单成功后调用）。 */
  attachSession(taskId, sessionId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    if (!task.sessionIds.includes(sessionId)) task.sessionIds.push(sessionId);
    if (task.state === "queued") task.state = "dispatched";
    task.startedAt = task.startedAt === 0 ? now : task.startedAt;
    task.updatedAt = now;
    this.notifyChange();
    return task;
  }
  /**
   * 把「等指挥台判断」的排队卡转成正式任务：只改项目/文件夹/标题与等待标记，
   * **taskId 不变**（用户 2026-11-10 要求：不许因为判出结果就冒出第二张卡）。
   */
  adopt(taskId, input) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    const now = input.now ?? Date.now();
    const title = String(input.title ?? "").trim();
    if (title !== "") task.title = taskTitleOf(title);
    task.projectId = input.projectId;
    task.projectName = input.projectName;
    if (input.folder !== void 0 && input.folder !== "") task.folder = input.folder;
    if (input.preset !== void 0 && input.preset !== "") task.preset = input.preset;
    task.waitingCommander = void 0;
    task.updatedAt = now;
    this.notifyChange();
    return task;
  }
  /** 一条会话改挂到另一张任务（同一句话转正式任务时，旧卡不再持有这条会话）。 */
  detachSession(taskId, sessionId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return;
    const at = task.sessionIds.indexOf(sessionId);
    if (at < 0) return;
    task.sessionIds.splice(at, 1);
    task.updatedAt = now;
    this.notifyChange();
  }
  /** 会话开始跑（turn/start）：排队/派单/回答完 → 执行中。 */
  markRunning(taskId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    if (task.state === "queued" || task.state === "dispatched" || task.state === "awaiting") {
      task.state = "running";
      task.updatedAt = now;
      this.notifyChange();
    }
    return task;
  }
  /**
   * 电脑端（外部）会话的状态同步：状态由**会话活动**推导，不走「派单→执行→完成」的事件链。
   *
   * 与 `markRunning/complete` 的区别（也是这里单独一个方法的原因）：
   *   - 允许 `done → running`：电脑端会话随时可能再被说一句话，任务卡要回到执行中；
   *   - 只有**屏上看得见的字段**（标题/项目/状态/起跑时刻）变了才动 `updatedAt`，
   *     否则每 10 秒一次轮询都会把卡片重新排到最前，棋盘会自己跳；
   *   - 不改 `spokenAt` 之外的播报状态：要不要念由 lane 决定（这里只管数据）。
   *
   * 返回 true 表示「棋盘该重画了」（标题/副行/状态/胶囊变了）。
   */
  syncExternal(taskId, input) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return false;
    const at = Number.isFinite(input.at) ? input.at : Date.now();
    let changed = false;
    const title = String(input.title ?? "").trim();
    if (title !== "" && task.title !== title) {
      task.title = taskTitleOf(title);
      changed = true;
    }
    const project = String(input.projectName ?? "").trim();
    if (project !== "" && task.projectName !== project) {
      task.projectName = project;
      changed = true;
    }
    const folder = String(input.folder ?? "").trim();
    if (folder !== "" && task.folder !== folder) task.folder = folder;
    const summary = String(input.summary ?? "").trim();
    let summaryChanged = false;
    if (summary !== "" && task.resultLine !== summary) {
      task.resultLine = summary;
      summaryChanged = true;
    }
    if (task.state !== input.state) {
      task.state = input.state;
      task.updatedAt = at;
      changed = true;
      if (input.state === "running") {
        task.finishedAt = void 0;
        task.spokenAt = void 0;
        const started = Number(input.startedAt);
        task.startedAt = Number.isFinite(started) && started > 0 ? started : at;
        if (summary !== "") task.summary = summary;
      } else if (input.state === "done") {
        task.finishedAt = at;
        if (summary !== "") task.summary = summary;
      } else {
        task.finishedAt = void 0;
        if (Number.isFinite(Number(input.startedAt))) task.startedAt = Number(input.startedAt);
      }
    } else if (changed) {
      task.updatedAt = at;
    }
    if (changed || summaryChanged) this.notifyChange();
    return changed;
  }
  /**
   * 新一轮开始：步数从 0 重新数。
   *
   * 用户 2026-11-10 实机：进度页上「第 20 步 · 已用 3m28s」把上一轮的步数也累加进来——
   * 已用已经按本轮 turn/start 算了，步数也必须同口径（否则新一轮一开屏就显示第 20 步）。
   */
  resetStep(taskId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return;
    task.step = 0;
    task.lastStepAt = void 0;
    task.stepDurations = void 0;
    task.updatedAt = now;
    this.notifyChange();
  }
  /** 步数推进（tool/call）：只增不减；顺手记最近 8 步耗时给棋盘微条。 */
  noteStep(taskId, step, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return;
    const next = Number.isFinite(step) ? Math.max(0, Math.trunc(step)) : task.step + 1;
    if (next > task.step) {
      const from = task.lastStepAt ?? task.startedAt;
      const elapsed = Math.max(0, now - from);
      task.stepDurations = [...task.stepDurations ?? [], elapsed].slice(-8);
      task.lastStepAt = now;
      task.step = next;
    }
    task.updatedAt = now;
    this.notifyChange();
  }
  /** 里程碑：任务行摘要更新（P2，可播但低优先）。 */
  noteMilestone(taskId, summary, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return;
    const text = String(summary ?? "").trim();
    if (text === "") return;
    task.summary = text;
    task.updatedAt = now;
    this.notifyChange();
  }
  /**
   * 要人（待决策／危险动作确认）：只有托管没点亮时才会走到这里。
   * `options` 与电脑端同序，`defaultIndex` ＝首选项。
   */
  ask(taskId, input) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    const now = input.now ?? Date.now();
    task.state = "awaiting";
    task.question = String(input.question ?? "").trim();
    const detail = String(input.detail ?? "").trim();
    if (detail !== "") task.detail = detail;
    task.options = input.options.slice(0, 4);
    task.defaultIndex = Math.max(0, Math.min(input.defaultIndex ?? 0, task.options.length - 1));
    task.decisionDeadline = now + Math.max(0, input.timeoutMs);
    task.updatedAt = now;
    this.notifyChange();
    return task;
  }
  /** 人答了（点选项 / 口头 / 60 秒到点走默认）：回到执行中。 */
  answer(taskId, by, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    if (task.state !== "awaiting") return task;
    task.state = "running";
    task.answeredBy = by;
    task.question = void 0;
    task.detail = void 0;
    task.options = void 0;
    task.defaultIndex = void 0;
    task.decisionDeadline = void 0;
    task.updatedAt = now;
    this.notifyChange();
    return task;
  }
  /** 完成：写一行结果摘要（不是正文）。 */
  complete(taskId, input = {}) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    const now = input.now ?? Date.now();
    task.state = "done";
    task.finishedAt = now;
    task.updatedAt = now;
    const line = String(input.resultLine ?? "").trim();
    if (line !== "") task.resultLine = line;
    const summary = String(input.summary ?? line).trim();
    if (summary !== "") task.summary = summary;
    task.question = void 0;
    task.detail = void 0;
    task.options = void 0;
    task.decisionDeadline = void 0;
    task.holdingForChildren = void 0;
    task.pendingResultLine = void 0;
    task.childRunning = void 0;
    this.notifyChange();
    return task;
  }
  /**
   * 子代理计数（调用链上还在跑的子会话数）。
   * 返回 true 表示屏上该重画（数量变了）。
   */
  setChildRunning(taskId, count, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return false;
    const next = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
    const previous = task.childRunning ?? 0;
    if (next === previous) return false;
    if (next === 0) task.childRunning = void 0;
    else task.childRunning = next;
    task.updatedAt = now;
    this.notifyChange();
    return true;
  }
  /**
   * 主回合结束了，但子代理还在跑：任务**不能算完成**。
   * 保持执行中、记下子代理数量与主回合结论，等子代理全部结束后再补完成屏/播报。
   */
  holdForChildren(taskId, input = {}) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    const now = input.now ?? Date.now();
    const running = Number.isFinite(input.childRunning) && (input.childRunning ?? 0) > 0 ? Math.trunc(input.childRunning) : 0;
    task.childRunning = running > 0 ? running : void 0;
    task.holdingForChildren = running > 0;
    if (running > 0) {
      task.state = "running";
      task.finishedAt = void 0;
      task.spokenAt = void 0;
      task.updatedAt = now;
    }
    const line = String(input.resultLine ?? "").trim();
    if (line !== "") task.pendingResultLine = line;
    this.notifyChange();
    return task;
  }
  /** 主会话又开了一轮（或重新派单）：子代理挂起状态清掉。 */
  clearChildHold(taskId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return;
    task.childRunning = void 0;
    task.holdingForChildren = void 0;
    task.pendingResultLine = void 0;
    task.updatedAt = now;
    this.notifyChange();
  }
  /**
   * 往旧会话再投一句话（衔接追加）：已完成/已播报的任务回到执行中。
   *
   * 与 `markRunning` 的区别：`markRunning` 只把排队/派单态推进到执行中；这里要能把
   * 已经「完成/已播报」的任务重新拉回执行中，否则续聊的回执会显示一条完成的旧任务。
   */
  reopenForAppend(taskId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    task.state = "running";
    task.finishedAt = void 0;
    task.spokenAt = void 0;
    task.holdingForChildren = void 0;
    task.pendingResultLine = void 0;
    task.updatedAt = now;
    this.notifyChange();
    return task;
  }
  /** 标记已播报（同一条不重复念）；七态第 6 态「已播报」。 */
  markSpoken(taskId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return;
    task.spokenAt = now;
    if (task.state === "done") task.state = "announced";
    this.notifyChange();
  }
  /** 撤单：还没起跑的排队任务直接从棋盘拿掉（起跑过的要先停再撤，那是危险动作）。 */
  drop(taskId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    task.state = "archived";
    task.archivedAt = now;
    this.notifyChange();
    return task;
  }
  /**
   * 归档：任务移出棋盘 ＋ 往 journal 追加一行摘要；**会话不删、文件夹不动**。
   * 返回需要写进 journal 的那一行（调用方只写一次，看 `task.journaled`）。
   */
  archive(taskId, now = Date.now()) {
    const task = this.tasks.get(taskId);
    if (task === void 0) return void 0;
    task.state = "archived";
    task.archivedAt = task.archivedAt ?? now;
    this.notifyChange();
    if (task.journaled === true) return void 0;
    task.journaled = true;
    return journalLineOf(task);
  }
  /** 内存上限：先归档最老的完成态，再归档最老的空闲任务（自动归档也落 journal 一行）。 */
  prune(now = Date.now()) {
    const keep = (taskId) => {
      const line = this.archive(taskId, now);
      if (line !== void 0) this.journal?.(line);
    };
    if (this.tasks.size <= LEDGER_MAX_TASKS) {
      for (const task of this.tasks.values()) {
        if (isFinishedState(task.state) && task.finishedAt !== void 0 && now - task.finishedAt > DONE_KEEP_MS) keep(task.taskId);
        else if (task.source === "pc" && now - task.updatedAt > DONE_KEEP_MS) keep(task.taskId);
      }
      return;
    }
    const byAge = this.list().filter((task) => isFinishedState(task.state) || task.state === "queued" || task.state === "dispatched");
    while (this.tasks.size > LEDGER_MAX_TASKS && byAge.length > 0) {
      const oldest = byAge.shift();
      if (oldest !== void 0) keep(oldest.taskId);
    }
  }
  /** 清空（单测/换绑诊断用）。 */
  clear() {
    this.tasks.clear();
    this.seq = 0;
    this.pcSeq = 0;
    this.notifyChange();
  }
};
function journalLineOf(task, now = Date.now()) {
  const end = task.finishedAt ?? task.archivedAt ?? now;
  const used = Math.max(0, end - task.startedAt);
  const parts = [
    `[${task.taskId}] ${task.title}`,
    task.projectName || "\u672A\u5206\u9879\u76EE",
    task.sessionIds.length === 0 ? "\u65E0\u4F1A\u8BDD" : task.sessionIds.map((id) => id.replace(/^session-/, "").slice(0, 8)).join("+"),
    `\u7528\u65F6 ${formatUsedMs(used)}`,
    task.resultLine ?? (isFinishedState(task.state) ? "\u5DF2\u5B8C\u6210" : "\u5DF2\u5F52\u6863")
  ];
  if (task.answeredBy !== void 0) parts.push(task.answeredBy);
  return `- ${parts.join(" / ")}`;
}
function formatUsedMs(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1e3));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m`;
}
var TaskNotifyBus = class {
  queue = [];
  push(level, taskId, text, now = Date.now()) {
    if (level === 3) return;
    const value = String(text ?? "").trim();
    if (value === "") return;
    this.queue.push({ level, taskId, text: value, at: now });
  }
  /** 还有几条等着念（回主页守门、测试都用它）。 */
  pending() {
    return this.queue.length;
  }
  /**
   * 取一条现在该念的（没有就到点再来）。
   *   - 有 P0 → 立刻取这一条（其余留在队里）；
   *   - P1/P2 攒够 2 条且窗口到了 → 合并成一句；
   *   - 只有 1 条且过了单条延迟 → 立刻念。
   */
  take(now = Date.now()) {
    if (this.queue.length === 0) return void 0;
    const urgent = this.queue.findIndex((item) => item.level === 0);
    if (urgent >= 0) {
      const [item] = this.queue.splice(urgent, 1);
      return { level: 0, taskIds: [item.taskId], text: item.text };
    }
    const first = this.queue[0];
    const waited = now - first.at;
    if (this.queue.length === 1) {
      if (waited < ANNOUNCE_SINGLE_DELAY_MS) return void 0;
      const [item] = this.queue.splice(0, 1);
      return { level: item.level, taskIds: [item.taskId], text: item.text };
    }
    if (waited < ANNOUNCE_WINDOW_MS) return void 0;
    const batch = this.queue.splice(0, this.queue.length);
    const level = Math.min(...batch.map((item) => item.level));
    return { level, taskIds: batch.map((item) => item.taskId), text: mergeAnnouncements(batch) };
  }
  /** 下次该来取的时刻（调用方据此挂定时器，不用轮询）。 */
  nextAt() {
    if (this.queue.length === 0) return void 0;
    const urgent = this.queue.some((item) => item.level === 0);
    if (urgent) return Date.now();
    if (this.queue.length === 1) return this.queue[0].at + ANNOUNCE_SINGLE_DELAY_MS;
    return this.queue[0].at + ANNOUNCE_WINDOW_MS;
  }
  clear() {
    this.queue.length = 0;
  }
};
function mergeAnnouncements(items) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0].text;
  const texts = items.map((item) => String(item.text ?? "").trim()).filter((text) => text !== "");
  if (texts.length === 1) return texts[0];
  const allDone = items.every((item) => item.level === 1);
  const count = texts.length;
  if (!allDone) return texts.join("\uFF1B");
  const head = count >= 4 ? `${count} \u4EF6\u4E8B\u5B8C\u4E86` : `${["\u96F6", "\u4E00", "\u4E24", "\u4E09"][count]}\u4EF6\u4E8B\u5B8C\u4E86`;
  const shown = texts.slice(0, 3);
  const tail = count > 3 ? "\u7B49" : "";
  return `${head}\uFF1A${shown.join("\u3001")}${tail}`;
}
var PROJECT_MATCH_CONFIDENT = 0.3;
function projectMatchConfidenceOf(score, via) {
  if (via === "name" || via === "folder") return 1;
  const value = Number(score);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / 100));
}
function isConfidentProjectRoute(route) {
  if (route.kind !== "card") return false;
  if (route.via === "fragment") return false;
  return route.confidence >= PROJECT_MATCH_CONFIDENT;
}
var COMMAND_PATTERNS = [
  { pattern: /^(?:回|去|看)?(?:任务)?(?:棋盘|主页|首页|看板)$/, command: { kind: "board" } },
  { pattern: /^(?:回)(?:到)?(?:棋盘|主页|首页)$/, command: { kind: "board" } },
  { pattern: /^(?:看|打开|进)(?:一下)?(?:任务|这条|第[一二三四五]条)/, command: { kind: "open" } },
  { pattern: /^(?:停止|停下|别念了|别读了|别说了|别说话|不要念了|不用念了|停止阅读|停止朗读|停)$/, command: { kind: "stop" } },
  { pattern: /^(?:撤单|撤销|取消这条|不做了)$/, command: { kind: "cancel" } },
  { pattern: /^(?:确认|同意|可以|执行|确认删除|删吧|批准)$/, command: { kind: "confirm", approved: true } },
  { pattern: /^(?:取消|不|别|留|先留|先留着|别删|不要)$/, command: { kind: "confirm", approved: false } }
];
function chineseIndex(text) {
  const map = { \u4E00: 1, \u4E8C: 2, \u4E09: 3, \u56DB: 4, \u4E94: 5, \u516D: 6, \u4E03: 7, \u516B: 8, \u4E5D: 9 };
  const raw = String(text ?? "").trim();
  if (raw === "") return void 0;
  const digits = raw.match(/^第?\s*(\d)\s*(?:条|个|号)?$/);
  if (digits !== null) return Number(digits[1]);
  const cn = raw.match(/^第?\s*([一二三四五六七八九])\s*(?:条|个|号)?$/);
  if (cn !== null) return map[cn[1]];
  return void 0;
}
var WAKE_WORD_PREFIX = /^(?:你好|嗨|嘿|喂)?[，,、。．.！!？?～~\s]*鹈鹕[，,、。．.！!？?～~\s]*/;
function stripWakeWord(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return "";
  return raw.replace(WAKE_WORD_PREFIX, "").trim();
}
function parseScreenCommand(text) {
  const raw = String(text ?? "");
  const stripped = stripWakeWord(raw);
  const candidates = stripped !== "" && stripped !== raw.trim() ? [raw, stripped] : [raw];
  for (const candidate of candidates) {
    const command = commandOfText(candidate);
    if (command !== void 0) return command;
  }
  return void 0;
}
function commandOfText(text) {
  const clean = String(text ?? "").replace(/[，,。！!？?\s]+/g, "");
  if (clean === "" || clean.length > 14) return void 0;
  const index = chineseIndex(clean);
  if (index !== void 0) return { kind: "pick", index };
  for (const item of COMMAND_PATTERNS) {
    if (item.pattern.test(clean)) return item.command;
  }
  const openMatch = clean.match(/^(?:看|打开|进)(?:一下)?第([一二三四五\d])(?:条|个)$/);
  if (openMatch !== null) {
    const at = chineseIndex(openMatch[1]);
    if (at !== void 0) return { kind: "open", index: at };
  }
  return void 0;
}
var CONTINUATION = /^(?:接着|继续|再|还|然后|顺便|另外|补充|上一条|那个|这个)/;
var PRODUCE_VERBS = /(生成|写|做|改|画|整理|导出|翻译|跑|运行|部署|提交|分析|调研|排版|校对|建|搭|实现|修复|重构|安装|下载|爬|润色|打磨|精修|出图|存|保存|转换|转成|合并|拆分|替换)/;
function looksSimpleTask(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean === "") return false;
  const chars = [...clean].length;
  if (PRODUCE_VERBS.test(clean)) return false;
  if (/^(?:请|帮我|麻烦)?(?:查看|看|读取|读|查询|查|搜索|总结|解释|翻译|列出|汇报|告诉|分析|什么|怎么|哪|现在|目前|几|谁)/.test(clean)) return true;
  if (chars <= 40 && /[?？]$/.test(clean)) return true;
  return chars <= 12;
}
function scoreCardAlias(text, card) {
  const haystack = normalizeAlias(text);
  if (haystack === "") return { score: 0, matched: "", via: "fragment" };
  const names = [
    { value: card.name, via: "name" },
    ...folderBase(card.folder) === "" ? [] : [{ value: folderBase(card.folder), via: "folder" }]
  ].filter((item) => normalizeAlias(item.value).length >= 2);
  let best = 0;
  let matched = "";
  let via = "fragment";
  for (const item of names) {
    const name2 = normalizeAlias(item.value);
    if (haystack.includes(name2)) {
      const score = 100 + [...name2].length;
      if (score > best || score === best && item.via === "name") {
        best = score;
        matched = item.value;
        via = item.via;
      }
      continue;
    }
    const common = longestCommonRun(haystack, name2);
    if (common >= 2 && common * 10 > best) {
      best = common * 10;
      matched = item.value;
      via = "fragment";
    }
  }
  return { score: best, matched, via };
}
function normalizeAlias(value) {
  return String(value ?? "").toLowerCase().replace(/[\s，,。.!！?？:：、"'"'（）()\[\]【】《》\-_/\\]+/g, "");
}
function folderBase(folder) {
  const parts = String(folder ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}
function longestCommonRun(a, b) {
  const left = [...a];
  const right = [...b];
  if (left.length === 0 || right.length === 0) return 0;
  let best = 0;
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}
function bestCardMatchOf(text, cards) {
  const scored = cards.map((card) => ({ card, ...scoreCardAlias(text, card) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best === void 0) return void 0;
  if (scored.length > 1 && scored[1].score === best.score) return void 0;
  return best.card;
}
function routeQuick(input) {
  const text = String(input.text ?? "").trim();
  if (text === "") return { kind: "none" };
  const scored = input.cards.map((card) => ({ card, ...scoreCardAlias(text, card) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  const exact = scored.filter((item) => item.score >= 100);
  const namedExact = exact.filter((item) => item.via === "name");
  const decisive = namedExact.length > 0 ? namedExact : exact;
  if (decisive.length > 1) return { kind: "ambiguous", candidates: decisive.slice(0, 2).map((item) => item.card) };
  const activeOf = (projectId) => input.tasks.filter((task) => task.source !== "pc").filter((task) => task.state === "running" || task.state === "awaiting" || task.state === "queued" || task.state === "dispatched").filter((task) => projectId === void 0 || task.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (decisive.length === 1) {
    const follow = CONTINUATION.test(text) ? activeOf(decisive[0].card.id) : void 0;
    if (follow !== void 0) return { kind: "append", task: follow };
    return {
      kind: "card",
      card: decisive[0].card,
      matched: decisive[0].matched,
      via: decisive[0].via,
      confidence: projectMatchConfidenceOf(decisive[0].score, decisive[0].via)
    };
  }
  if (CONTINUATION.test(text)) {
    const follow = activeOf(void 0);
    if (follow !== void 0) return { kind: "append", task: follow };
  }
  const best = scored[0];
  if (best !== void 0 && best.score >= 30) {
    const close2 = scored.filter((item) => item.score * 100 >= best.score * 80);
    if (close2.length > 1) return { kind: "ambiguous", candidates: close2.slice(0, 2).map((item) => item.card) };
    return {
      kind: "card",
      card: best.card,
      matched: best.matched,
      via: best.via,
      confidence: projectMatchConfidenceOf(best.score, best.via)
    };
  }
  if (looksSimpleTask(text)) return { kind: "daily" };
  if (best === void 0) return { kind: "none" };
  const close = scored.filter((item) => item.score * 100 >= best.score * 80);
  if (close.length > 1) return { kind: "ambiguous", candidates: close.slice(0, 2).map((item) => item.card) };
  return {
    kind: "card",
    card: best.card,
    matched: best.matched,
    via: best.via,
    confidence: projectMatchConfidenceOf(best.score, best.via)
  };
}
var CONTINUITY_MAX_SESSIONS = 8;
var CONTINUITY_WINDOW_MS = 7 * 24 * 60 * 6e4;
var CONTINUITY_APPEND_SCORE = 0.54;
var CONTINUITY_NEW_SCORE = 0.32;
var CONTINUITY_MARGIN = 0.06;
var CONTINUITY_WEIGHT = { content: 0.65, cue: 0.18, time: 0.17 };
var CONTINUITY_CUES = [
  { pattern: /接着|继续|往下说|接着说/, weight: 0.5 },
  { pattern: /刚才|刚刚|前面|上面|上次|之前|原先|原来|那条|这条|那个|这个|它/, weight: 0.35 },
  { pattern: /再(?:改|调|修|补|加|删|压|缩|写|做|跑|弄|看|试|算|核|对|导|画|排|润|翻)/, weight: 0.3 },
  { pattern: /还有|顺便|另外|补充|然后|下一步|后面|最后/, weight: 0.25 },
  { pattern: /保留|别动|不要动|不动|不变|照旧|沿用|基于|在此基础上/, weight: 0.2 }
];
var CONTINUITY_STOP_CHARS = /* @__PURE__ */ new Set([..."\u7684\u4E86\u7740\u8FC7\u662F\u5728\u548C\u4E0E\u53CA\u6216\u800C\u5E76\u5C31\u90FD\u4E5F\u8FD8\u53C8\u628A\u8FD9\u90A3\u54EA\u4E2A\u4E9B\u4E00\u70B9\u4E0A\u4E0B\u4E2D\u91CC\u5916\u540E\u524D\u6211\u4F60\u4ED6\u5979\u5B83\u4EEC\u5417\u5462\u5427\u554A\u5440\u54E6\u55EF\u8BF7\u5E2E\u9EBB\u70E6\u4F1A\u80FD\u8981\u60F3\u4ECE\u5230\u4E3A\u4EE5\u4E8E\u88AB\u7ED9\u5BF9\u5411"]);
function continuityCandidatesOf(sessions) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const session of sessions) {
    if (session.sessionId === "" || seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    out.push(session);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CONTINUITY_MAX_SESSIONS);
}
function continuityCueScore(text) {
  const value = String(text ?? "");
  let sum = 0;
  for (const cue of CONTINUITY_CUES) if (cue.pattern.test(value)) sum += cue.weight;
  return Math.min(1, sum);
}
function continuityTimeScore(updatedAt, now) {
  const at = Number(updatedAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  const hours = Math.max(0, now - at) / 36e5;
  return 1 / (1 + hours / 24);
}
function contentSeqOf(text) {
  const out = [];
  for (const ch of String(text ?? "").toLowerCase()) {
    if (/\s/.test(ch)) continue;
    if (/[\p{P}\p{S}]/u.test(ch)) continue;
    if (CONTINUITY_STOP_CHARS.has(ch)) continue;
    out.push(ch);
  }
  return out;
}
function bigramsOf(chars) {
  const out = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  return out;
}
function continuityAffinityOf(text, reference) {
  const a = contentSeqOf(text);
  const b = contentSeqOf(reference);
  if (a.length < 2 || b.length < 2) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let sharedChars = 0;
  for (const ch of aSet) if (bSet.has(ch)) sharedChars += 1;
  const coverage = sharedChars / aSet.size;
  const aBigrams = new Set(bigramsOf(a));
  const bBigrams = new Set(bigramsOf(b));
  let sharedBigrams = 0;
  for (const bigram of aBigrams) if (bBigrams.has(bigram)) sharedBigrams += 1;
  const dice = aBigrams.size === 0 ? 0 : 2 * sharedBigrams / (aBigrams.size + bBigrams.size);
  const weight = Math.min(1, a.length / 6);
  return (0.6 * coverage + 0.4 * dice) * weight;
}
function stripHints(text, hints) {
  let value = String(text ?? "");
  for (const hint of hints ?? []) {
    const raw = String(hint ?? "").trim();
    if ([...raw].length < 2) continue;
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(escaped, "gi"), " ");
  }
  return value;
}
function continuityScoreOf(input) {
  const text = String(input.text ?? "").trim();
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const utterance = stripHints(text, input.projectHints);
  const cue = continuityCueScore(text);
  const title = stripHints(input.session.title, input.projectHints);
  const summary = stripHints(input.session.summary ?? "", input.projectHints);
  const content = Math.max(
    continuityAffinityOf(utterance, title),
    summary === "" ? 0 : continuityAffinityOf(utterance, summary)
  );
  const time = continuityTimeScore(input.session.updatedAt, now);
  const score = CONTINUITY_WEIGHT.content * content + CONTINUITY_WEIGHT.cue * cue + CONTINUITY_WEIGHT.time * time;
  return { content, cue, time, score, detail: `content=${content.toFixed(2)} cue=${cue.toFixed(2)} time=${time.toFixed(2)} score=${score.toFixed(2)}` };
}
var CONTINUITY_PREVIOUS_SCORE = 0.3;
function previousSessionFollowUpOf(input) {
  const previous = input.previous;
  if (previous === void 0 || String(input.text ?? "").trim() === "") return void 0;
  const scored = continuityScoreOf({ text: input.text, session: previous, now: input.now, projectHints: input.projectHints });
  return {
    follow: scored.score >= CONTINUITY_PREVIOUS_SCORE,
    confidence: scored.score,
    sessionId: previous.sessionId,
    detail: scored.detail
  };
}
function continuityOf(input) {
  const text = String(input.text ?? "").trim();
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  if (text === "") return { kind: "new", confidence: 0, reason: "\u7A7A\u53E5\u5B50" };
  const sessions = continuityCandidatesOf(input.sessions);
  if (sessions.length === 0) return { kind: "new", confidence: 0, reason: "\u8BE5\u9879\u76EE\u4E0B\u8FD8\u6CA1\u6709 CU \u4F1A\u8BDD" };
  const scored = sessions.map((candidate) => ({
    candidate,
    ...continuityScoreOf({ text, session: candidate, now, projectHints: input.projectHints })
  })).sort((a, b) => b.score - a.score || b.candidate.updatedAt - a.candidate.updatedAt);
  const best = scored[0];
  const second = scored[1];
  const detail = best.detail;
  if (best.score < CONTINUITY_NEW_SCORE) {
    return { kind: "new", confidence: best.score, reason: `\u660E\u786E\u65E0\u5173\uFF1A${detail}` };
  }
  if (best.score >= CONTINUITY_APPEND_SCORE) {
    if (second !== void 0 && best.score - second.score < CONTINUITY_MARGIN) {
      return { kind: "gray", confidence: best.score, sessionId: best.candidate.sessionId, reason: `\u4E24\u6761\u4F1A\u8BDD\u5206\u592A\u8FD1\uFF1A${detail} second=${second.score.toFixed(2)}` };
    }
    return { kind: "append", confidence: best.score, sessionId: best.candidate.sessionId, reason: detail };
  }
  return { kind: "gray", confidence: best.score, sessionId: best.candidate.sessionId, reason: `\u7070\u533A\uFF1A${detail}` };
}
function plainSummaryOf(text, maxChars = 48) {
  const raw = String(text ?? "");
  const withoutBlocks = raw.replace(/```[\s\S]*?```/g, " ").replace(/`([^`\n]*)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>\n]{1,120}>/g, " ").replace(/^\s{0,3}#{1,6}\s*/gm, "").replace(/^\s{0,3}[-*+]\s+/gm, "").replace(/^\s{0,3}>\s?/gm, "").replace(/^\s*\|.*\|\s*$/gm, " ").replace(/[*_~]{1,3}/g, "");
  const kept = [];
  for (const token of withoutBlocks.split(/\s+/)) {
    if (token === "") continue;
    if (/(?:[\\/])/.test(token) && (token.length >= 12 || /^[A-Za-z]:[\\/]/.test(token))) continue;
    kept.push(token);
  }
  const clean = kept.join(" ").replace(/\s+/g, " ").trim();
  if (clean === "") return "";
  const first = clean.split(/[。！？!?\n]/).map((part) => part.trim()).find((part) => part !== "") ?? "";
  if (first === "") return "";
  const chars = [...first];
  return chars.length > maxChars ? `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}\u2026` : first;
}

// src/tihu/task-store.ts
import { mkdirSync as mkdirSync7, readFileSync as readFileSync7, renameSync as renameSync5, unlinkSync as unlinkSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { dirname as dirname7, join as join11 } from "node:path";
var TIHU_LEDGER_FILENAME = "task-ledger.json";
function tihuLedgerPath() {
  const override = String(process.env.TIHU_TASK_LEDGER_FILE ?? "").trim();
  if (override !== "") return override;
  const dshHome3 = String(process.env.DSH_HOME ?? "").trim();
  return join11(dshHome3 !== "" ? dshHome3 : join11(homedir8(), ".dsh"), "tihu", TIHU_LEDGER_FILENAME);
}
function parseLedgerSnapshot(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return void 0;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void 0;
  }
  if (parsed === null || typeof parsed !== "object") return void 0;
  const value = parsed;
  if (Number(value.v) !== LEDGER_SNAPSHOT_VERSION) return void 0;
  if (!Array.isArray(value.tasks)) return void 0;
  const savedAt = Number(value.savedAt);
  return {
    v: LEDGER_SNAPSHOT_VERSION,
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0,
    tasks: value.tasks
  };
}
function writeLedgerSnapshot(snapshot, file = tihuLedgerPath()) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync7(dirname7(file), { recursive: true });
    writeFileSync5(temporary, `${JSON.stringify(snapshot, null, 2)}
`, { encoding: "utf8", mode: 384 });
    renameSync5(temporary, file);
    return true;
  } catch {
    try {
      unlinkSync3(temporary);
    } catch {
    }
    return false;
  }
}
var TaskLedgerStore = class {
  file;
  snapshot;
  delayMs;
  onError;
  timer;
  /** 上次写盘是否成功（诊断/测试用）。 */
  lastWriteOk = true;
  constructor(options) {
    this.file = options.file ?? tihuLedgerPath();
    this.snapshot = options.snapshot;
    this.delayMs = Math.max(0, Math.trunc(options.delayMs ?? 250));
    this.onError = options.onError;
  }
  path() {
    return this.file;
  }
  lastWriteSucceeded() {
    return this.lastWriteOk;
  }
  /**
   * 读历史：文件不存在 → undefined；存在但读不懂 → 记一条日志后 undefined。
   * 注意不在读的时候删除坏文件：留着给人排查，下一次正常写盘会覆盖它。
   */
  load() {
    let text = "";
    try {
      text = readFileSync7(this.file, "utf8");
    } catch {
      return void 0;
    }
    if (text.trim() === "") return void 0;
    const snapshot = parseLedgerSnapshot(text);
    if (snapshot === void 0) {
      this.onError?.(`tihu ledger unreadable, ignored: ${this.file}`);
      return void 0;
    }
    return snapshot;
  }
  /** 状态变了：合并成一次写盘（定时器 unref，不拖住宿主退出）。 */
  schedule() {
    if (this.timer !== void 0) return;
    const timer = setTimeout(() => {
      this.timer = void 0;
      this.flush();
    }, this.delayMs);
    timer.unref?.();
    this.timer = timer;
  }
  /** 立刻写一次（同步）；返回是否成功。 */
  flush() {
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    let snapshot;
    try {
      snapshot = this.snapshot();
    } catch (error) {
      this.lastWriteOk = false;
      this.onError?.(`tihu ledger snapshot failed: ${error?.message ?? String(error)}`);
      return false;
    }
    this.lastWriteOk = writeLedgerSnapshot(snapshot, this.file);
    if (!this.lastWriteOk) this.onError?.(`tihu ledger write failed: ${this.file}`);
    return this.lastWriteOk;
  }
  /** 卸载：清定时器 + 最后写一次（任务状态不能因为卸载丢最后几条）。 */
  dispose() {
    this.flush();
  }
};

// src/tihu/dispatch-protocol.ts
var COMMANDER_REPLY_SHAPE = '{"project":"\u9879\u76EE\u540D","session":"append|new","append_to":"\u4F1A\u8BDD id \u6216\u7A7A"}';
var COMMANDER_CONTROL_SHAPE = '{"intent":"control","tool":"tihu_stop_speaking"}';
var COMMANDER_CLARIFY_SHAPE = '{"intent":"clarify","ask":"\u8981\u95EE\u7528\u6237\u7684\u90A3\u4E00\u53E5\u8BDD"}';
var DEVICE_CONTROL_PRIORITY_SECTION = [
  "\u3010\u8BBE\u5907\u63A7\u5236\u4F18\u5148\u3011\u5148\u5224\u8FD9\u53E5\u8BDD\u662F\u4E0D\u662F\u7528\u6237\u5728**\u6307\u6325\u8FD9\u5757\u8BBE\u5907\u5C4F\u672C\u8EAB**\uFF1A\u6B63\u5728\u6717\u8BFB\u7684\u5185\u5BB9\u3001\u6B63\u5728\u770B\u7684\u9875\u9762\u3001\u6B63\u5728\u7B49\u4ED6\u9009\u7684\u9009\u9879\u3001\u8FD9\u6B21\u8BED\u97F3\u4F1A\u8BDD\u3001\u8FD9\u5757\u5C4F\u8BE5\u770B\u54EA\u6761\u3002",
  "\xB7 **\u4E0B\u9762\u8FD9\u4E9B\u53EA\u662F\u4F8B\u5B50\uFF0C\u4E0D\u662F\u8BCD\u8868**\uFF1A\u6309\u610F\u601D\u5224\uFF0C\u7EDD\u4E0D\u6309\u5B57\u9762\u5339\u914D\u3002\u8BF4\u6CD5\u53EF\u4EE5\u662F\u4EFB\u4F55\u6837\u5B50\u2014\u2014",
  "  \u505C / \u522B\u5FF5\u4E86 / \u5B89\u9759\u70B9 / \u5148\u505C\u4E00\u4E0B / \u522B\u8BFB\u4E86 \u2192 `tihu_stop_speaking`\uFF1B\u6162\u4E00\u70B9 / \u5148\u505C\u5728\u90A3\u513F\u522B\u52A8 / \u7B49\u4F1A\u513F\u518D\u8BF4 \u2192 `tihu_pause_speaking`\uFF1B\u63A5\u7740\u8BF4 / \u7EE7\u7EED\u5FF5 / \u5FF5\u5B8C\u5B83 \u2192 `tihu_resume_speaking`\uFF1B",
  "  \u518D\u6765\u4E00\u904D / \u91CD\u5FF5 / \u4ECE\u5934\u5FF5 / \u521A\u624D\u90A3\u53E5\u518D\u8BF4\u4E00\u6B21 / \u7B2C 3 \u6BB5\u91CD\u8BFB \u2192 `tihu_replay`\uFF1B\u56DE\u4E3B\u754C\u9762 / \u9000\u51FA\u53BB / \u8FD4\u56DE / \u522B\u5360\u7740\u8FD9\u5F20\u5C4F / \u7ED9\u6211\u770B\u56DE\u53BB \u2192 `tihu_go_home`\uFF1B",
  "  \u7FFB\u9875 / \u4E0B\u4E00\u9875 / \u4E0A\u4E00\u9875 / \u5F80\u524D\u7FFB / \u7FFB\u5230\u7B2C 2 \u9875 \u2192 `tihu_board_page`\uFF1B\u770B\u7B2C\u51E0\u5F20\u5361 / \u6253\u5F00\u90A3\u6761\u4EFB\u52A1 / \u770B\u6700\u8FD1\u505A\u5B8C\u7684\u90A3\u6761 \u2192 `tihu_open_task`\uFF1B",
  "  \u8DDF\u7740\u8FD9\u6761 / \u6211\u5C31\u8981\u770B\u8FD9\u6761 / \u76EF\u4F4F\u5B83\u8DD1 \u2192 `tihu_follow_task`\uFF1B\u7ED3\u675F\u8FD9\u6B21\u8BED\u97F3 / \u5173\u6389\u8BED\u97F3 / \u522B\u5728\u542C\u4E86 / \u6536\u5DE5 \u2192 `tihu_end_voice_session`\uFF1B\u6211\u8BF4\u8BDD\u5462 / \u9192\u9192 / \u5728\u542C\u5417 \u2192 `tihu_wake`\uFF1B",
  "  \u7B54\u5E94 / \u9009\u7B2C\u4E8C\u4E2A / \u5C31\u8FD9\u4E2A / \u90A3\u4E2A\u4E0D\u884C \u2192 `tihu_answer_decision`\uFF1B\u968F\u4FBF / \u6309\u9ED8\u8BA4\u6765 / \u4F60\u51B3\u5B9A / \u9A73\u56DE \u2192 `tihu_dismiss_decision`\uFF1B\u73B0\u5728\u4EC0\u4E48\u60C5\u51B5 / \u5728\u5E72\u561B / \u5FF5\u5230\u54EA\u4E86 / \u5C4F\u4E0A\u8FD9\u6761\u8DD1\u5230\u54EA\u4E86 \u2192 `tihu_status`\uFF1B",
  "  \u6709\u51E0\u4E2A\u8BBE\u5907 / \u54EA\u51E0\u5757\u5C4F\u5728\u7EBF \u2192 `tihu_list_devices`\uFF1B\u58F0\u97F3\u6362\u4E2A\u7537\u7684 / \u8BED\u901F\u6162\u70B9 / \u5F00\u514D\u6309\u4F4F \u2192 `tihu_device_settings`\u3002",
  "\xB7 \u5224\u6210\u63A7\u5236\u610F\u56FE \u2192 **\u76F4\u63A5\u8C03\u7528\u90A3\u4E2A tihu_* \u5DE5\u5177**\uFF08\u5DE5\u5177\u540D\u7167\u5B9E\u5199\uFF0C\u522B\u81EA\u5DF1\u7F16\uFF09\u3002\u8C03\u4E86\u5DE5\u5177\u5C31\u4E0D\u8981\u518D\u8F93\u51FA\u6D3E\u5355 JSON\uFF1A\u8FD9\u53E5\u8BDD\u5DF2\u7ECF\u529E\u4E86\uFF0C\u518D\u6D3E\u5355\u5C31\u662F\u529E\u4E24\u904D\u3002",
  "\xB7 **\u300C\u7B2C\u51E0\u4E2A / \u7B2C\u4E8C\u5F20 / \u7B2C\u4E8C\u6761\u300D\uFF1D\u8FD9\u5757\u5C4F\u5F53\u524D\u8FD9\u4E00\u9875\u7684\u884C\u53F7\uFF0C\u4ECE 1 \u5F00\u59CB**\uFF1A\u5C4F\u4E0A\u7B2C\u4E00\u884C\u5C31\u662F 1\uFF0C\u300C\u7B2C\u4E8C\u4E2A\u300D\uFF1D\u7B2C 2 \u884C\u3002\u4E0D\u662F 0 \u8D77\uFF0C\u4E5F\u4E0D\u662F\u300C\u6700\u8FD1\u5B8C\u6210\u7684\u90A3\u6761\u300D\u3002",
  '\xB7 \u8C03 `tihu_open_task` **\u5FC5\u987B\u5E26 `arguments.index`**\uFF08\u4F8B\uFF1A`{"intent":"control","tool":"tihu_open_task","arguments":{"index":2}}`\uFF09\uFF1B\u53EA\u6709\u7528\u6237\u660E\u786E\u8BF4\u4E86\u6807\u9898 / \u4EFB\u52A1\u53F7\uFF0C\u6216\u660E\u8BF4\u300C\u6700\u8FD1\u90A3\u6761\u300D\uFF0C\u624D\u6539\u7528 `title` / `taskId` / `recent:true`\uFF0C\u5176\u4F59\u4E00\u5F8B\u5E26 index\u3002\u62FF\u4E0D\u51C6\u5C31\u56DE clarify \u95EE\u4E00\u53E5\uFF0C\u522B\u53EA\u56DE\u5DE5\u5177\u540D\u3002',
  "\xB7 \u4E0B\u9762\u3010\u8FD9\u5757\u5C4F\u73B0\u5728\u7684\u68CB\u76D8\u3011\u5C31\u662F\u8FD9\u5757\u5C4F**\u5F53\u4E0B\u8FD9\u4E00\u9875**\uFF08\u884C\u53F7 1 \u8D77\u3001\u4E0E\u5C4F\u4E0A\u9010\u884C\u4E00\u81F4\uFF09\uFF1B\u7167\u7740\u5B83\u628A\u300C\u7B2C\u51E0\u4E2A\u300D\u7FFB\u6210 index\u3002",
  "\xB7 \u5224\u6210\u8981\u5E72\u6D3B\uFF08\u5199\u6587\u6863\u3001\u8DD1\u4EE3\u7801\u3001\u67E5\u8D44\u6599\u3001\u6539\u6587\u4EF6\u3001\u505A\u56FE\u3001\u5BA1\u7A3F\u3001\u505A\u4EA4\u4ED8\u7269\u2026\uFF09\u2192 \u624D\u56DE\u6D3E\u5355 JSON\u3002\u6D3E\u5355\u7EDD\u4E0D\u7528\u4E8E\u300C\u8BA9\u8FD9\u5757\u5C4F\u600E\u4E48\u663E\u793A\u300D\u8FD9\u4EF6\u4E8B\u3002",
  '\xB7 \u4E24\u79CD\u89E3\u91CA\u90FD\u8BF4\u5F97\u901A\u3001\u8BF4\u4E0D\u51C6 \u2192 \u53EA\u56DE `{"intent":"clarify","ask":"\u2026"}`\uFF0C\u5C4F\u4E0A\u95EE\u7528\u6237\u4E00\u6B21\uFF1B**\u7EDD\u4E0D\u731C\u7740\u6D3E\u5355**\u3002'
].join("\n");
var FENCE = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g;
function jsonish(text) {
  return String(text ?? "").replace(/[\u201c\u201d\u2018\u2019\uff02]/g, '"').replace(/[：]/g, ":").replace(/[，]/g, ",").replace(/｛/g, "{").replace(/｝/g, "}").replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3').replace(/,\s*([}\]])/g, "$1");
}
function balancedObjects(text) {
  const source = String(text ?? "");
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === "\u201C") {
      inString = true;
      quote = char === "\u201C" ? "\u201D" : char;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(source.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}
function candidatesOf(raw) {
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (text === "") return [];
  const out = [text];
  for (const match of text.matchAll(FENCE)) {
    const body = String(match[1] ?? "").trim();
    if (body !== "") out.push(body);
  }
  for (const source of [...out]) out.push(...balancedObjects(source));
  return out;
}
function stringOf(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function modeOf(value) {
  const text = stringOf(value).toLowerCase();
  if (text === "") return void 0;
  if (/^(?:append|continue|existing|old|same|续|接着|继续|原会话|原有会话|旧会话)$/.test(text)) return "append";
  if (/^(?:new|create|fresh|新建|新|新会话|新任务|另起|另开)$/.test(text)) return "new";
  return void 0;
}
function conclusionOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const record = value;
  const hasSession = record.session !== void 0 || record.mode !== void 0 || record.action !== void 0;
  const hasAppend = record.append_to !== void 0 || record.appendTo !== void 0 || record.sessionId !== void 0 || record.session_id !== void 0 || record.target_session !== void 0;
  const hasProject = record.project !== void 0 || record.target !== void 0 || record.card !== void 0;
  if (!hasSession && !hasAppend && !hasProject) return void 0;
  const project = stringOf(record.project ?? record.target ?? record.card);
  const appendTo = stringOf(record.append_to ?? record.appendTo ?? record.sessionId ?? record.session_id ?? record.target_session);
  let session = modeOf(record.session ?? record.mode ?? record.action);
  if (session === void 0) session = appendTo !== "" ? "append" : "new";
  if (session === "append" && appendTo === "") {
    return void 0;
  }
  if (session === "new") return { project, session: "new", appendTo: "" };
  return { project, session: "append", appendTo };
}
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
var INTENTION_KEYS = ["control", "clarify", "dispatch"];
var INTENTION_WORDS = {
  control: [/^control$|^screen$|^device$|^ui$|^playback$|^panel$/, /^(?:控制|这块屏|屏上|界面|播放|语音)$/],
  clarify: [/^clarify$|^unclear$|^ambiguous$|^ask$|^question$|要问/, /^(?:说不准|两可|歧义)$/],
  dispatch: [/^dispatch$|^work$|^job$|^task$|^new-task$|^派单$|^干活$|^新任务$/, /^(?:派单结论|干活)$/]
};
function intentWordOf(value) {
  const text = stringOf(value).toLowerCase().replace(/[\s_·、，。]/g, "");
  if (text === "") return void 0;
  for (const key of INTENTION_KEYS) {
    if (INTENTION_WORDS[key].some((pattern) => pattern.test(text))) return key;
  }
  return void 0;
}
function toolNameOf(record, allowed) {
  for (const key of ["tool", "tihu_tool", "toolName", "control", "call", "api"]) {
    const value = stringOf(record[key]);
    if (value === "") continue;
    const hit = allowed.find((name2) => name2.toLowerCase() === value.toLowerCase());
    if (hit !== void 0) return { name: hit, said: value };
  }
  return void 0;
}
function toollessSaidOf(record) {
  for (const key of ["tool", "tihu_tool", "control", "action", "intent"]) {
    const value = stringOf(record[key]);
    if (value !== "") return value;
  }
  return "(\u6CA1\u5199\u5DE5\u5177\u540D)";
}
function toolArgsOf(record) {
  for (const key of ["arguments", "args", "params", "parameters"]) {
    const value = record[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return { ...value };
  }
  return {};
}
function clarifyTextOf(record) {
  for (const key of ["ask", "clarify", "question", "need_clarify", "unclear"]) {
    const value = stringOf(record[key]);
    if (value !== "" && value !== "true") return value;
  }
  return "";
}
function decisionOf(value, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const record = value;
  const tool = toolNameOf(record, allowed);
  if (tool !== void 0) return { kind: "control", tool: nameIn(allowed, tool.name), args: toolArgsOf(record) };
  const intent = intentWordOf(record.intent ?? record.kind ?? record.type ?? record.action);
  const question = clarifyTextOf(record);
  if (intent === "clarify" || question !== "") return { kind: "clarify", question };
  if (intent === "control") return { kind: "control-unknown", said: toollessSaidOf(record) };
  const dispatch = conclusionOf(record);
  if (dispatch !== void 0) return { kind: "dispatch", dispatch };
  return void 0;
}
function nameIn(allowed, lowerName) {
  return allowed.find((name2) => name2.toLowerCase() === lowerName.toLowerCase()) ?? lowerName;
}
function parseCommanderDecision(raw, allowed) {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return decisionOf(raw, allowed);
  for (const candidate of candidatesOf(raw)) {
    const direct = tryParse(candidate);
    if (direct !== void 0) {
      const decision2 = decisionOf(direct, allowed);
      if (decision2 !== void 0) return decision2;
      continue;
    }
    const repaired = tryParse(jsonish(candidate));
    if (repaired === void 0) continue;
    const decision = decisionOf(repaired, allowed);
    if (decision !== void 0) return decision;
  }
  const whole = tryParse(jsonish(String(raw ?? "")));
  return whole === void 0 ? void 0 : decisionOf(whole, allowed);
}
function commanderReplyTail(hints = [], boardLines = []) {
  return [
    DEVICE_CONTROL_PRIORITY_SECTION,
    "\u3010\u7ED3\u8BBA\u53EA\u6709\u4E00\u884C\u3011\u4E09\u79CD\u5F62\u72B6\u5404\u56DE\u4E00\u6761\uFF0C\u4E0D\u8BB8\u6DF7\u7740\u56DE\uFF0C\u4E5F\u4E0D\u8BB8\u591A\u89E3\u91CA\u4E00\u4E2A\u5B57\uFF1A",
    `\xB7 \u5224\u6210\u5728\u6307\u6325\u8FD9\u5757\u5C4F \u2192 \u76F4\u63A5\u8C03\u90A3\u4E2A tihu_* \u5DE5\u5177\uFF1B\u53EA\u4F1A\u56DE\u6587\u672C\u5C31\u56DE ${COMMANDER_CONTROL_SHAPE} \u8FD9\u4E00\u884C\uFF08lane \u7167\u7740\u5B83\u8865\u8C03\uFF09\u3002`,
    `\xB7 \u5224\u6210\u4E24\u53EF\u3001\u8BF4\u4E0D\u51C6 \u2192 \u53EA\u56DE ${COMMANDER_CLARIFY_SHAPE} \u8FD9\u4E00\u884C\uFF0C\u5C4F\u4E0A\u95EE\u7528\u6237\u4E00\u6B21\u3002`,
    "\xB7 \u5224\u6210\u8981\u5E72\u6D3B \u2192 \u6309\u4E0B\u9762\u90A3\u884C\u6D3E\u5355 JSON \u56DE\uFF1A",
    `\u683C\u5F0F\uFF1A${COMMANDER_REPLY_SHAPE}`,
    '\xB7 session \u53EA\u80FD\u5199 "append" \u6216 "new" \u8FD9\u4E24\u4E2A\u8BCD\uFF08\u4E0D\u8981\u7167\u6284\u793A\u4F8B\u91CC\u7684 "append|new"\uFF09\u3002',
    "\xB7 \u9879\u76EE\u540D\u7528\u9879\u76EE\u5361\u540D\uFF1B\u6CA1\u6709\u5408\u9002\u7684\u9879\u76EE\u5C31\u5199\u300C\u4E2A\u4EBA\u52A9\u624B\u300D\u3002",
    '\xB7 \u63A5\u7740\u67D0\u6761\u5DF2\u6709\u4F1A\u8BDD\u505A \u2192 "append"\uFF0Cappend_to \u5199\u90A3\u6761\u4F1A\u8BDD\u7684\u77ED\u53F7\uFF1B\u786E\u5B9E\u662F\u4E00\u4EF6\u65B0\u4E8B \u2192 "new"\uFF0Cappend_to \u7559\u7A7A\u3002',
    "\xB7 \u6D3E\u5355\u90A3\u4E00\u884C\u4E4B\u5916\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5B57\u7B26\uFF1A\u4E0D\u8981\u4EE3\u7801\u5757\u56F4\u680F\u3001\u4E0D\u8981\u89E3\u91CA\u3001\u4E0D\u8981\u524D\u540E\u7F00\u3002",
    "\xB7 \u4F60\u53EA\u5224\u65AD\u300C\u8FD9\u53E5\u8BDD\u5F80\u54EA\u513F\u6D3E / \u662F\u4E0D\u662F\u5728\u6307\u6325\u5C4F\u300D\uFF0C\u4E0D\u5E72\u6D3B\u3001\u4E0D\u505A\u6B63\u6587\u3001\u4E0D\u89E3\u91CA\u81EA\u5DF1\u600E\u4E48\u5224\u7684\u3002",
    ...boardLines.length === 0 ? [] : ["\u3010\u8FD9\u5757\u5C4F\u73B0\u5728\u7684\u68CB\u76D8\u3011\uFF08\u884C\u53F7\u4ECE 1 \u5F00\u59CB\uFF0C\u4E0E\u5C4F\u4E0A\u9010\u884C\u4E00\u81F4\uFF09", ...boardLines],
    ...hints.length === 0 ? [] : ["\u6700\u8FD1\u7684\u9879\u76EE\u4F1A\u8BDD\uFF08\u77ED\u53F7 \u6807\u9898\uFF09\uFF1A", ...hints]
  ].join("\n");
}

// src/tihu/pending-interactions.ts
import { existsSync as existsSync8, readFileSync as readFileSync8 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { join as join12 } from "node:path";

// src/tuoguan-autoanswer.ts
var FREE_TEXT_DEFAULT = "auto-hosting\uFF1A\u672A\u63D0\u4F9B\u4EBA\u5DE5\u8F93\u5165\uFF0C\u8BF7\u6309\u9ED8\u8BA4\u5047\u8BBE\u7EE7\u7EED\u3002";
function hasTrue(map, key) {
  if (typeof map !== "object" || map === null) return false;
  return map[key] === true;
}
function tuoguanOnForChain(state, chain) {
  for (const sessionId of chain) {
    if (typeof sessionId !== "string" || sessionId === "") continue;
    if (hasTrue(state?.off, sessionId)) return false;
    if (hasTrue(state?.on, sessionId)) return true;
  }
  return state?.defaultOn !== false;
}
function sessionAncestry(sessionId, agentOf) {
  const chain = [sessionId];
  let current = sessionId;
  for (let depth = 0; depth < 16; depth += 1) {
    const header = safeHeader(agentOf, current);
    if (header === null) break;
    const delegated = header.origin === "subagent" || typeof header.delegationDepth === "number" && header.delegationDepth > 0;
    if (!delegated) break;
    const parent = header.parentSession;
    if (typeof parent !== "string" || parent === "" || parent === current) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}
function safeHeader(agentOf, sessionId) {
  try {
    const header = agentOf(sessionId)?.session?.header;
    return typeof header === "object" && header !== null ? header : null;
  } catch {
    return null;
  }
}

// src/tihu/pending-interactions.ts
var PENDING_QUESTION_FALLBACK = "\u7535\u8111\u7AEF\u5728\u7B49\u4F60\u786E\u8BA4";
var PENDING_OPTION_FALLBACK = "\u7EE7\u7EED";
var APPROVAL_OPTIONS = ["\u5141\u8BB8\u4E00\u6B21", "\u62D2\u7EDD"];
var APPROVAL_OUTCOMES = ["allowed-once", "rejected"];
var APPROVAL_DEFAULT_INDEX = APPROVAL_OPTIONS.indexOf("\u62D2\u7EDD");
var DECISION_TIMEOUT_MS = 6e4;
var PENDING_OFFLINE_CHECK_MS = 2e3;
function tihuDecisionTimeoutMs() {
  const raw = Number(process.env.TIHU_DECISION_TIMEOUT_MS ?? DECISION_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DECISION_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), 10), 10 * 6e4);
}
function clipLine(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "";
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}\u2026`;
}
function sessionIdOfPendingRequest(request) {
  const direct = request?.agent?.session?.id ?? request?.sessionId ?? request?.session?.id;
  if (typeof direct === "string" && direct !== "") return direct;
  const header = request?.agent?.session?.header?.id;
  return typeof header === "string" ? header : "";
}
function displayReasonOf(request) {
  const value = request?.displayReason;
  if (value === null || typeof value !== "object") return "";
  for (const key of ["zh-CN", "zh", "en"]) {
    const text = value[key];
    if (typeof text === "string" && text.trim() !== "") return clipLine(text, 40);
  }
  return "";
}
function approvalDecisionOf(request) {
  const sessionId = sessionIdOfPendingRequest(request);
  if (sessionId === "") return null;
  const toolName = typeof request?.toolName === "string" ? clipLine(request.toolName, 24) : "";
  const reason = clipLine(request?.reason, 40) || displayReasonOf(request);
  const question = reason !== "" ? reason : toolName !== "" ? `\u5141\u8BB8\u4F7F\u7528 ${toolName}\uFF1F` : PENDING_QUESTION_FALLBACK;
  return {
    sessionId,
    kind: "approval",
    question,
    ...toolName === "" ? {} : { detail: toolName },
    options: [...APPROVAL_OPTIONS],
    defaultIndex: APPROVAL_DEFAULT_INDEX,
    answerOf: (index) => {
      const at = Number.isFinite(index) ? Math.max(0, Math.min(Math.trunc(index), APPROVAL_OUTCOMES.length - 1)) : APPROVAL_DEFAULT_INDEX;
      return APPROVAL_OUTCOMES[at];
    }
  };
}
function defaultAnswersOf(questions) {
  return {
    answers: questions.map((question) => {
      const id = typeof question?.id === "string" ? question.id : String(question?.id ?? "");
      const options = Array.isArray(question?.options) ? question.options : [];
      const first = options[0];
      const label = typeof first?.label === "string" ? first.label.trim() : "";
      if (label === "") return { id, selected: [], custom: FREE_TEXT_DEFAULT };
      return { id, selected: [label] };
    })
  };
}
function questionDecisionOf(request) {
  const sessionId = sessionIdOfPendingRequest(request);
  if (sessionId === "") return null;
  const questions = Array.isArray(request?.questions) ? request.questions.filter((item2) => item2 !== null && typeof item2 === "object") : [];
  if (questions.length === 0) return null;
  if (questions.length > 1) {
    return {
      sessionId,
      kind: "question",
      question: PENDING_QUESTION_FALLBACK,
      detail: `\u4E00\u6B21 ${questions.length} \u4E2A\u95EE\u9898`,
      options: [PENDING_OPTION_FALLBACK],
      defaultIndex: 0,
      answerOf: () => defaultAnswersOf(questions)
    };
  }
  const item = questions[0];
  const id = typeof item?.id === "string" ? item.id : "";
  const text = clipLine(item?.question, 40);
  if (id === "" || text === "") return null;
  const optionLabels = (Array.isArray(item?.options) ? item.options : []).map((option) => typeof option?.label === "string" ? option.label.trim() : "").filter((label) => label !== "");
  const header = clipLine(item?.header, 16);
  const detailText = clipLine(item?.detail, 40);
  if (optionLabels.length === 0) {
    return {
      sessionId,
      kind: "question",
      question: text,
      ...header === "" && detailText === "" ? {} : { detail: detailText || header },
      options: [PENDING_OPTION_FALLBACK],
      defaultIndex: 0,
      // 没有选项的题：用官方「其它」口径回一段自由文本（与托管同一条默认话术）。
      answerOf: () => ({ answers: [{ id, selected: [], custom: FREE_TEXT_DEFAULT }] })
    };
  }
  const shown = optionLabels.slice(0, 2);
  const hidden = optionLabels.length - shown.length;
  const detail = clipLine([header, hidden > 0 ? `\u8FD8\u6709 ${hidden} \u4E2A\u9009\u9879\u5728\u7535\u8111\u7AEF` : ""].filter((part) => part !== "").join(" \xB7 "), 40);
  return {
    sessionId,
    kind: "question",
    question: text,
    ...detail === "" ? {} : { detail },
    options: shown,
    defaultIndex: 0,
    answerOf: (index) => {
      const at = Number.isFinite(index) ? Math.max(0, Math.min(Math.trunc(index), shown.length - 1)) : 0;
      return { answers: [{ id, selected: [shown[at] ?? shown[0]] }] };
    }
  };
}
function optionalService2(ctx, id) {
  try {
    if (ctx && typeof ctx.get === "function") return ctx.get(id);
  } catch {
  }
  return void 0;
}
function tuoguanStateFileOf(ctx) {
  const override = String(process.env.TIHU_TUOGUAN_STATE ?? "").trim();
  if (override !== "") return override;
  const profile = optionalService2(ctx, "profileContext");
  if (profile && typeof profile.dir === "string" && profile.dir !== "") return join12(profile.dir, "dsh-tuoguan-state.json");
  const home = optionalService2(ctx, "homePaths");
  const base = home && typeof home.home === "string" && home.home !== "" ? home.home : String(process.env.DSH_HOME ?? "").trim() || join12(homedir9(), ".dsh");
  const desktop = join12(base, "profiles", "desktop", "dsh-tuoguan-state.json");
  if (existsSync8(desktop)) return desktop;
  return join12(base, "dsh-tuoguan-state.json");
}
function normalizeTuoguanState(raw) {
  const record = raw !== null && typeof raw === "object" ? raw : {};
  const pick = (source) => {
    const out = {};
    if (source === null || typeof source !== "object") return out;
    for (const [key, value] of Object.entries(source)) {
      if (typeof key === "string" && key !== "" && value === true) out[key] = true;
    }
    return out;
  };
  const off = pick(record.off);
  const on = pick(record.on);
  for (const key of Object.keys(off)) delete on[key];
  return { off, on, defaultOn: typeof record.defaultOn === "boolean" ? record.defaultOn : true };
}
function readTuoguanStateAt(file) {
  try {
    return normalizeTuoguanState(JSON.parse(readFileSync8(file, "utf8")));
  } catch {
    return { off: {}, on: {}, defaultOn: true };
  }
}
function tuoguanOnForSession(sessionId, ctx, agentOf) {
  if (typeof sessionId !== "string" || sessionId === "") return true;
  try {
    const agents = optionalService2(ctx, "agents");
    const lookup = typeof agentOf === "function" ? agentOf : (id) => {
      try {
        return agents?.get?.(id) ?? null;
      } catch {
        return null;
      }
    };
    const state = readTuoguanStateAt(tuoguanStateFileOf(ctx));
    return tuoguanOnForChain(state, sessionAncestry(sessionId, lookup));
  } catch {
    return true;
  }
}

// src/tihu/task-screens.ts
var RECEIPT_SECONDS = 5;
function boardFrame(board) {
  return {
    stage: "",
    title: "",
    bullets: [],
    tone: board.empty ? "idle" : "ok",
    mode: "home",
    board
  };
}
function receiptFrame(input) {
  const ahead = Math.max(0, Math.trunc(input.queueAhead));
  const folderName = shortFolderPath(input.folder);
  const bullets = [];
  if (input.note !== void 0 && input.note.trim() !== "") bullets.push(input.note.trim());
  if (folderName !== "") bullets.push(`\u6587\u4EF6\u5939 ${folderName}`);
  bullets.push(input.etaText !== void 0 && input.etaText !== "" ? `\u7EA6 ${input.etaText}\u540E\u5F00\u59CB\u8DD1` : "\u9A6C\u4E0A\u5F00\u59CB\u8DD1");
  bullets.push(`${RECEIPT_SECONDS} \u79D2\u540E\u81EA\u52A8\u56DE\u68CB\u76D8`);
  return {
    stage: "\u6D3E\u5355",
    title: clipScreenTitle(`\u5DF2\u6D3E\u7ED9 ${input.projectName || "\u52A9\u624B"}`),
    bullets: fitScreenLines(bullets, 3),
    steps: [
      { label: "\u5DF2\u5165\u961F", state: "done" },
      { label: ahead === 0 ? "\u8F6E\u5230\u5B83" : `\u6392\u961F ${ahead} \u4E2A`, state: ahead === 0 ? "done" : "active" },
      { label: "\u5F00\u59CB\u8DD1", state: ahead === 0 ? "active" : "pending" }
    ],
    countdown: { seconds: RECEIPT_SECONDS, totalSeconds: RECEIPT_SECONDS, text: "" },
    actions: [
      { id: "taskOpen", label: "\u770B\u4EFB\u52A1" },
      { id: "taskCancel", label: "\u64A4\u5355" }
    ],
    taskId: input.taskId,
    tone: "busy",
    mode: "status"
  };
}
var DONE_BODY_FONT_PX = 15;
var DONE_BODY_TEXT_WIDTH_PX = CONTENT_WIDTH_PX - 16;
var DONE_NO_REPLY_TEXT = "\uFF08\u6CA1\u6709\u6587\u5B57\u56DE\u590D\uFF09";
var LEADING_STATUS_MARK = /^[\s\uFEFF]*(?:[\u2705\u2713\u2714\u2611\u2717\u274c]\uFE0F?\s*)+/u;
function stripStatusMarks(text) {
  return String(text ?? "").split("\n").map((line) => line.replace(LEADING_STATUS_MARK, "")).join("\n");
}
var DONE_PATH_MAX_CHARS = 40;
var LEADING_LIST_MARK = /^\s{0,3}[-*+]\s+/;
var LEADING_HEADING_MARK = /^\s{0,3}#{1,6}\s*/;
var THEMATIC_BREAK = /^\s*([-*_])\1{2,}\s*$/;
var LEADING_QUOTE_MARK = /^\s{0,3}>\s?/;
function stripMarkdownMarks(text) {
  return String(text ?? "").split("\n").map((line) => {
    if (/^\s*```/.test(line)) return "";
    let out = line.replace(LEADING_HEADING_MARK, "").replace(LEADING_LIST_MARK, "").replace(LEADING_QUOTE_MARK, "");
    if (THEMATIC_BREAK.test(out)) return "";
    out = out.replace(/\*\*/g, "").replace(/`/g, "");
    return out;
  }).join("\n");
}
function looksLikeAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]/.test(value) || /^\/(?:[^/\s]+\/)+/.test(value);
}
function shrinkFileName(name2, maxChars) {
  const chars = [...name2];
  if (chars.length <= maxChars) return name2;
  const dot = name2.lastIndexOf(".");
  const ext = dot > 0 && name2.length - dot <= 9 ? name2.slice(dot) : "";
  const extChars = [...ext];
  const stem = ext === "" ? chars : chars.slice(0, chars.length - extChars.length);
  const budget = maxChars - 1 - extChars.length;
  if (budget <= 4) return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}\u2026`;
  const headLen = Math.max(1, Math.floor(budget / 2));
  const tailLen = Math.max(1, budget - headLen);
  const head = stem.slice(0, headLen);
  while (head.length > 1 && ["_", "-", ".", " "].includes(head[head.length - 1])) head.pop();
  let tail = stem.slice(stem.length - tailLen);
  const cut = tail.findIndex((char) => char === "_" || char === "-" || char === "." || char === " ");
  if (cut > 0 && tail.length - cut >= 6) tail = tail.slice(cut);
  return `${head.join("")}\u2026${tail.join("")}${ext}`;
}
var PATH_LINE_WIDTH_PX = DONE_BODY_TEXT_WIDTH_PX - TEXT_WRAP_SAFETY_PX;
function abbreviatePath(path3, maxChars = DONE_PATH_MAX_CHARS) {
  const raw = String(path3 ?? "").trim();
  if (raw === "") return "";
  const fitsLine = (value) => measureTextPx(value, DONE_BODY_FONT_PX) <= PATH_LINE_WIDTH_PX;
  if ([...raw].length <= maxChars && fitsLine(raw)) return raw;
  const sep2 = raw.includes("\\") ? "\\" : "/";
  const unc = /^\\\\[^\\/]/.test(raw);
  const posix = !unc && !/^[A-Za-z]:[\\/]/.test(raw) && raw.startsWith("/");
  const parts = raw.split(/[\\/]+/).filter((part) => part !== "");
  if (parts.length < 2) return shrinkFileName(raw, maxChars);
  const head = unc ? `\\\\${parts[0]}` : posix ? `${sep2}${parts[0]}` : parts[0];
  const base = parts[parts.length - 1];
  const withHead = `${head}${sep2}\u2026${sep2}${base}`;
  const candidate = [...withHead].length <= maxChars ? withHead : base;
  if (fitsLine(candidate)) return candidate;
  if (fitsLine(base)) return base;
  for (let limit = Math.min(maxChars, [...base].length) - 1; limit >= 8; limit -= 1) {
    const shrunk = shrinkFileName(base, limit);
    if (fitsLine(shrunk)) return shrunk;
  }
  return shrinkFileName(base, 8);
}
var WINDOWS_PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'`<>|?*，。；！？、）】》」』,;]+/g;
var POSIX_PATH_TOKEN = /(?<![\w:.\/-])\/(?:[^\s/]+\/)+[^\s"'`<>|?*，。；！？、）】》」』,;]+/g;
var BACKTICKED_PATH = /`([^`\n]+)`/g;
function abbreviateLongPaths(text, maxChars = DONE_PATH_MAX_CHARS) {
  const shorten = (token) => abbreviatePath(token, maxChars);
  const coded = String(text ?? "").replace(BACKTICKED_PATH, (whole, inner) => {
    const value = inner.trim();
    return looksLikeAbsolutePath(value) ? abbreviatePath(value, maxChars) : whole;
  });
  return coded.replace(WINDOWS_PATH_TOKEN, (token) => shorten(token)).replace(POSIX_PATH_TOKEN, (token) => shorten(token));
}
function prepareDoneText(text) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
  const withoutMarkdown = stripMarkdownMarks(abbreviateLongPaths(normalized));
  return stripStatusMarks(withoutMarkdown).trim();
}
function doneLinesOf(text) {
  const clean = prepareDoneText(text);
  if (clean === "") return [];
  const lines = [];
  for (const sentence of splitReplySentences(clean)) {
    for (const line of wrapTextPx(sentence.text, DONE_BODY_TEXT_WIDTH_PX, DONE_BODY_FONT_PX)) {
      if (line.trim() !== "") lines.push(line);
    }
  }
  return lines;
}
function doneLineRangesOf(text) {
  const clean = prepareDoneText(text);
  if (clean === "") return [];
  const ranges = [];
  for (const sentence of splitReplySentences(clean)) {
    let cursor = sentence.start;
    for (const line of wrapTextPx(sentence.text, DONE_BODY_TEXT_WIDTH_PX, DONE_BODY_FONT_PX)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const length = [...trimmed].length;
      ranges.push([cursor, cursor + length]);
      cursor += length;
    }
  }
  return ranges;
}
var DONE_SPEECH_MAX_CHARS = 80;
function doneSpeechSegmentsOf(text, maxChars = DONE_SPEECH_MAX_CHARS) {
  const clean = prepareDoneText(text);
  const ranges = doneLineRangesOf(clean);
  if (ranges.length === 0) return [];
  const chars = [...clean];
  const out = [];
  let index = 0;
  let line = 0;
  while (line < ranges.length) {
    const start = ranges[line][0];
    let last = line;
    if (index !== 0) {
      while (last + 1 < ranges.length && ranges[last + 1][1] - start <= maxChars) last += 1;
    }
    const end = ranges[last][1];
    out.push({ index, start, end, firstLine: line, lastLine: last, text: chars.slice(start, end).join("") });
    index += 1;
    line = last + 1;
  }
  return out;
}
function detailFrame(input) {
  const ended = input.ended === true;
  const liveLine = fitLine(input.liveLine || (ended ? "\u5DF2\u7ED3\u675F \xB7 \u672C\u8F6E\u6CA1\u6709\u65B0\u72B6\u6001" : "\u601D\u8003 \xB7 \u6A21\u578B\u63A8\u7406\u4E2D\u2026"), CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx);
  const stepLine = fitLine(ended ? `\u7B2C ${input.step} \u6B65 \xB7 \u5DF2\u7ED3\u675F` : `\u7B2C ${input.step} \u6B65 \xB7 \u5DF2\u7528 ${formatUsedMs(input.elapsedMs)}`, CONTENT_WIDTH_PX, SCREEN_SPEC.bodyFontPx);
  const statsLine2 = fitLine(input.statsLine === "" ? "\u7EDF\u8BA1\u4E2D\u2026" : input.statsLine, CONTENT_WIDTH_PX, SCREEN_SPEC.statsFontPx);
  return {
    stage: "\u8FDB\u5EA6",
    title: clipScreenTitle(input.title === "" ? "\u4EFB\u52A1\u8FDB\u5EA6" : input.title),
    bullets: [liveLine, stepLine, statsLine2].filter((line) => line !== ""),
    statsTail: 1,
    actions: [
      { id: "taskStop", label: "\u505C\u6B62" },
      { id: "taskBoard", label: "\u4E3B\u9875" }
    ],
    taskId: input.taskId,
    tone: ended ? "ok" : "busy",
    mode: "status"
  };
}
function doneFrame(input) {
  const body = String(input.replyText ?? "").trim() !== "" ? String(input.replyText) : (input.bullets ?? []).join(" ").trim() !== "" ? (input.bullets ?? []).join("\n") : input.resultLine || DONE_NO_REPLY_TEXT;
  const lines = doneLinesOf(body);
  const fallback = doneLinesOf(input.resultLine);
  const shown = lines.length > 0 ? lines : fallback;
  const ranges = lines.length > 0 ? doneLineRangesOf(body) : [];
  const rawTitle = input.title === "" ? "\u4EFB\u52A1\u5B8C\u6210" : input.title;
  return {
    stage: "\u5B8C\u6210",
    // 大标题是 20px 加粗（比状态屏标题 18px 大）：按 20px×加粗系数量宽裁一次，
    // 屏幕上的 CSS 省略号只当兜底——宿主先裁，才不会出现「字被浏览器切一半」。
    title: fitLine(rawTitle, CONTENT_WIDTH_PX, DONE_TITLE_FONT_PX * TITLE_BOLD_FACTOR),
    bullets: fitScreenLines([stripStatusMarks(input.resultLine || "\u505A\u5B8C\u4E86")], SCREEN_SPEC.maxBodyLines),
    done: {
      lines: shown,
      current: Math.max(0, Math.min(Math.max(0, shown.length - 1), Math.trunc(Number(input.current) || 0))),
      ...ranges.length === shown.length ? { ranges } : {}
    },
    ...input.others !== void 0 && input.others > 0 ? { more: { count: input.others, text: `\u53E6\u6709 ${input.others} \u6761` } } : {},
    actions: [
      { id: "stop", label: "\u505C\u6B62" },
      { id: "replay", label: "\u91CD\u8BFB" },
      { id: "taskBoard", label: "\u4E3B\u9875" }
    ],
    taskId: input.taskId,
    tone: "ok",
    mode: "status"
  };
}
function decisionFrame(input) {
  const options = input.options.filter((option) => String(option ?? "").trim() !== "");
  const defaultLabel = options[input.defaultIndex ?? 0] ?? options[0] ?? "";
  const bullets = [];
  const detail = String(input.detail ?? "").replace(/\s+/g, " ").trim();
  if (detail !== "") bullets.push(detail);
  if (defaultLabel !== "") bullets.push(`\u4E0D\u9009\u5C31\u6309\u300C${defaultLabel}\u300D`);
  const actions = options.slice(0, 2).map((label, index) => ({ id: `taskAnswer${index + 1}`, label }));
  actions.push({ id: "taskBoard", label: "\u4E3B\u9875" });
  return {
    stage: "\u5F85\u51B3\u7B56",
    title: clipScreenTitle(input.question || input.title || "\u8981\u4F60\u5B9A\u4E00\u4E0B"),
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    countdown: { seconds: Math.max(1, Math.trunc(input.seconds)), totalSeconds: Math.max(1, Math.trunc(input.seconds)), text: "" },
    actions,
    taskId: input.taskId,
    tone: "warn",
    mode: "status"
  };
}
function askWhichFrame(input) {
  const bullets = input.candidates.slice(0, 2).map((item, index) => {
    const doing = String(item.doing ?? "").trim();
    return doing === "" ? `${index + 1} ${item.projectName}` : `${index + 1} ${item.projectName} \xB7 ${doing}`;
  });
  const actions = input.candidates.slice(0, 2).map((_item, index) => ({ id: `pick${index + 1}`, label: String(index + 1) }));
  actions.push({ id: "pickNone", label: "\u90FD\u4E0D\u662F" });
  return {
    stage: "\u8FFD\u95EE",
    title: clipScreenTitle("\u8FD9\u53E5\u8BDD\u6D3E\u7ED9\u8C01\uFF1F"),
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    ask: {
      candidates: input.candidates.slice(0, 2).map((item, index) => ({
        index: index + 1,
        projectName: item.projectName,
        source: String(item.doing ?? "").trim()
      }))
    },
    actions,
    ...input.taskId === void 0 ? {} : { taskId: input.taskId },
    tone: "alert",
    mode: "status"
  };
}
function clarifySessionFrame(input) {
  const title = clipScreenTitle("\u65B0\u5EFA\uFF0C\u8FD8\u662F\u63A5\u7740\u521A\u624D\u90A3\u6761\uFF1F");
  const rawLabel = String(input.sessionTitle ?? "").trim() || "\u521A\u624D\u90A3\u6761";
  const labelChars = [...rawLabel];
  const sessionLabel = labelChars.length > 8 ? `${labelChars.slice(0, 7).join("")}\u2026` : rawLabel;
  const bullets = ["1 \u65B0\u5EFA\u4E00\u6761\u72EC\u7ACB\u4F1A\u8BDD", `2 \u63A5\u7740\u300C${sessionLabel}\u300D`];
  return {
    stage: "\u6F84\u6E05",
    title,
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    ask: {
      candidates: [
        { index: 1, projectName: "\u65B0\u5EFA\u4F1A\u8BDD", source: "" },
        { index: 2, projectName: `\u63A5\u7740\u300C${sessionLabel}\u300D`, source: "" }
      ]
    },
    actions: [{ id: "pick1", label: "\u65B0\u5EFA" }, { id: "pick2", label: "\u63A5\u7740" }],
    ...input.taskId === void 0 ? {} : { taskId: input.taskId },
    tone: "alert",
    mode: "status"
  };
}
function intentClarifyFrame(input) {
  const chars = [...String(input.text ?? "")];
  const shown = chars.length > 12 ? `${chars.slice(0, 11).join("")}\u2026` : chars.join("");
  const asked = String(input.question ?? "").trim();
  const title = clipScreenTitle(asked === "" ? "\u8FD9\u53E5\u662F\u8981\u6211\u5E72\u6D3B\uFF0C\u8FD8\u662F\u53EA\u7BA1\u8FD9\u5757\u5C4F\uFF1F" : asked);
  const bullets = input.alreadyAsked === true ? [shown, "\u8FD9\u53E5\u6211\u5224\u4E0D\u51C6\uFF0C\u91CD\u8BF4\u4E00\u4E0B"] : [`1 \u6D3E\u5B83\u5E72\u6D3B\uFF1A${shown}`, "2 \u5148\u4E0D\u7BA1\uFF08\u8FD9\u53E5\u4E22\u6389\uFF0C\u7B49\u4F60\u91CD\u8BF4\uFF09"];
  return {
    stage: "\u6F84\u6E05",
    title,
    bullets: fitScreenLines(bullets, SCREEN_SPEC.maxBodyLines),
    ...input.alreadyAsked === true ? {} : {
      ask: {
        candidates: [
          { index: 1, projectName: "\u6D3E\u5B83\u5E72\u6D3B", source: shown },
          { index: 2, projectName: "\u5148\u4E0D\u7BA1", source: "" }
        ]
      }
    },
    actions: input.alreadyAsked === true ? [{ id: "taskBoard", label: "\u4E3B\u9875" }] : [{ id: "pick1", label: "\u5E72\u6D3B" }, { id: "pick2", label: "\u4E0D\u7BA1" }],
    tone: "alert",
    mode: "status"
  };
}
function noticeFrame(input) {
  return {
    stage: input.stage,
    title: clipScreenTitle(input.title),
    bullets: fitScreenLines(input.lines ?? [], SCREEN_SPEC.maxBodyLines),
    tone: input.tone ?? "idle",
    mode: "status",
    ...input.taskId === void 0 ? {} : { taskId: input.taskId }
  };
}
function doneAnnouncementOf(task) {
  const title = task.title || "\u521A\u624D\u90A3\u4EF6\u4E8B";
  const line = prepareDoneText(task.resultLine).replace(/\s+/g, " ").trim();
  if (line === "") return `${title}\uFF0C\u505A\u5B8C\u4E86`;
  return `${title}\u2014\u2014${line}`;
}
function folderBase2(folder) {
  const parts = String(folder ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}
function shortFolderPath(folder) {
  const raw = String(folder ?? "");
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length <= 2) return raw;
  const last = [...parts[parts.length - 1]].slice(-10).join("");
  const sep2 = raw.includes("\\") ? "\\" : "/";
  return `${parts[0]}${sep2}\u2026${sep2}${last}`;
}

// src/tihu/preroll.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync9, mkdirSync as mkdirSync8, readdirSync as readdirSync3, readFileSync as readFileSync9, statSync as statSync6, unlinkSync as unlinkSync4, utimesSync, writeFileSync as writeFileSync6 } from "node:fs";
import { homedir as homedir10 } from "node:os";
import { join as join13 } from "node:path";
var PREROLL_MAX_FILES = 120;
var PREROLL_MAX_BYTES = 8 * 1024 * 1024;
var PREROLL_SAMPLE_RATE = 24e3;
var PREROLL_MAX_AUDIO_MS = 2e4;
function defaultPrerollDir() {
  const override = String(process.env.TIHU_PREROLL_DIR ?? "").trim();
  if (override !== "") return override;
  const dshHome3 = String(process.env.DSH_HOME ?? "").trim();
  return join13(dshHome3 !== "" ? dshHome3 : join13(homedir10(), ".dsh"), "tihu", "preroll");
}
function prerollKeyOf(voice, text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const name2 = String(voice ?? "").trim() || "default";
  return createHash3("sha1").update(`${name2}\0${clean}`).digest("hex").slice(0, 16);
}
function prerollAudioMs(bytes) {
  return Math.round(Math.max(0, bytes) / 2 / PREROLL_SAMPLE_RATE * 1e3);
}
var TihuPreroll = class {
  dir;
  hits = 0;
  misses = 0;
  constructor(dir = defaultPrerollDir()) {
    this.dir = dir;
  }
  /** 目录（诊断/测试用）。 */
  dirOf() {
    return this.dir;
  }
  fileOf(key) {
    return join13(this.dir, `${key}.pcm`);
  }
  /** 命中就返回裸 PCM；没命中返回 undefined（调用方去合成）。 */
  get(voice, text) {
    const key = prerollKeyOf(voice, text);
    const file = this.fileOf(key);
    try {
      const data = readFileSync9(file);
      if (data.length === 0) return void 0;
      try {
        const now = /* @__PURE__ */ new Date();
        utimesSync(file, now, now);
      } catch {
      }
      this.hits += 1;
      return data;
    } catch {
      this.misses += 1;
      return void 0;
    }
  }
  /** 存一条；超长/空/写不进去都返回 false（不算错误）。 */
  put(voice, text, pcm) {
    if (pcm.length === 0) return false;
    if (prerollAudioMs(pcm.length) > PREROLL_MAX_AUDIO_MS) return false;
    const key = prerollKeyOf(voice, text);
    try {
      mkdirSync8(this.dir, { recursive: true });
      writeFileSync6(this.fileOf(key), pcm);
      this.prune();
      return true;
    } catch {
      return false;
    }
  }
  /** 按「文件数 + 总字节」两个上限修剪，先删最老的（mtime）。 */
  prune() {
    try {
      if (!existsSync9(this.dir)) return;
      const files = readdirSync3(this.dir).filter((name2) => name2.endsWith(".pcm")).map((name2) => {
        const path3 = join13(this.dir, name2);
        try {
          const info = statSync6(path3);
          return { path: path3, bytes: info.size, mtimeMs: info.mtimeMs };
        } catch {
          return void 0;
        }
      }).filter((item) => item !== void 0).sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = files.reduce((sum, item) => sum + item.bytes, 0);
      let count = files.length;
      for (const item of files) {
        if (count <= PREROLL_MAX_FILES && total <= PREROLL_MAX_BYTES) break;
        try {
          unlinkSync4(item.path);
          count -= 1;
          total -= item.bytes;
        } catch {
        }
      }
    } catch {
    }
  }
  stats() {
    let files = 0;
    let bytes = 0;
    try {
      if (existsSync9(this.dir)) {
        for (const name2 of readdirSync3(this.dir)) {
          if (!name2.endsWith(".pcm")) continue;
          try {
            bytes += statSync6(join13(this.dir, name2)).size;
            files += 1;
          } catch {
          }
        }
      }
    } catch {
    }
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, files, bytes, hitRate: total === 0 ? 0 : this.hits / total };
  }
  /** 清空（测试/排障用：换了音色引擎后想强制重录）。 */
  clear() {
    try {
      if (!existsSync9(this.dir)) return;
      for (const name2 of readdirSync3(this.dir)) {
        if (!name2.endsWith(".pcm")) continue;
        try {
          unlinkSync4(join13(this.dir, name2));
        } catch {
        }
      }
    } catch {
    }
    this.hits = 0;
    this.misses = 0;
  }
};

// src/tihu/host-resolve.ts
function messageOf(error) {
  const text = String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? "unknown error" : text;
}
function codeOf(error) {
  const code = error?.code;
  if (typeof code === "string" && code.trim() !== "") return code.trim();
  const name2 = error?.name;
  return typeof name2 === "string" && name2 !== "Error" ? name2 : "";
}
function tihuRemoteFailureOf(error, prefix = "") {
  const code = codeOf(error);
  const message = messageOf(error);
  const text = code === "" ? message : `${code}\uFF1A${message}`;
  return { code, message: prefix === "" ? text : `${prefix} ${text}` };
}
function looksLikeAgent(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return "session" in record || "followup" in record || "status" in record || "prompt" in record;
}
function tihuResolveAgentFailureOf(returned) {
  if (returned === void 0 || returned === null) {
    return { code: "", message: "resolveAgent \u6CA1\u6709\u8FD4\u56DE\u4F1A\u8BDD agent" };
  }
  if (typeof returned !== "object") {
    return { code: "", message: `resolveAgent \u8FD4\u56DE\u7684\u4E0D\u662F\u5BF9\u8C61\uFF08${typeof returned}\uFF09` };
  }
  const record = returned;
  if ("error" in record) {
    return tihuRemoteFailureOf(record.error, "resolveAgent \u5931\u8D25");
  }
  if ("agent" in record) {
    const agent = record.agent;
    if (agent === void 0 || agent === null) return { code: "session/not-live", message: "resolveAgent \u8FD4\u56DE\u4E86 { agent }\uFF0C\u4F46 agent \u662F\u7A7A\u7684" };
    return void 0;
  }
  if (looksLikeAgent(returned)) return void 0;
  if (typeof record.message === "string") return tihuRemoteFailureOf(returned, "resolveAgent \u5931\u8D25");
  return void 0;
}
function tihuFailureError(failure, sessionId) {
  const error = new Error(`${failure.message}\uFF08\u4F1A\u8BDD ${sessionId.slice(0, 12)}\u2026\uFF09`);
  error.code = failure.code;
  return error;
}

// src/tihu/lane.ts
var TIHU_LANE_PATH = "/tihu/lane";
var BOARD_TICK_MS = 5e3;
var COMMANDER_WAIT_PAINT_MS = 1500;
var TIHU_TOOL_NAME_LIST = tihuToolNames();
var TIHU_SAMPLE_TEXT = "\u8BD5\u542C\uFF1A\u6211\u662F\u4E91\u5065\uFF0C\u58F0\u97F3\u6B63\u5E38\u5417\uFF1F";
function tihuSampleTextOf(edgeVoice) {
  const short = tihuCloudVoiceShortName(edgeVoice);
  return short === "\u4E91\u5065" ? TIHU_SAMPLE_TEXT : `\u8BD5\u542C\uFF1A\u6211\u662F${short}\uFF0C\u58F0\u97F3\u6B63\u5E38\u5417\uFF1F`;
}
var MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
var TRANSCRIBE_TIMEOUT_MS = 45e3;
var ACTIVE_WINDOW_MS = 12e4;
var HOME_AFTER_SPEECH_MS = 6e4;
var DETAIL_AUTO_HOME_MS = 6e4;
var PROGRESS_WATCHDOG_MS = 3e4;
function tihuProgressStaleMs() {
  const raw = Number(process.env.TIHU_PROGRESS_STALE_MS ?? PROGRESS_WATCHDOG_MS);
  if (!Number.isFinite(raw) || raw <= 0) return PROGRESS_WATCHDOG_MS;
  return clampInt(raw, 1e3, 10 * 6e4);
}
function tihuTurnStaleMs() {
  const raw = Number(process.env.TIHU_TURN_STALE_MS ?? 30 * 6e4);
  if (!Number.isFinite(raw) || raw <= 0) return 30 * 6e4;
  return clampInt(raw, 10, 6 * 60 * 6e4);
}
function tihuThinkingFlushMs() {
  const raw = Number(process.env.TIHU_THINKING_FLUSH_MS ?? 300);
  if (!Number.isFinite(raw)) return 300;
  return clampInt(raw, 20, 5e3);
}
function tihuGrayCommanderMs() {
  const raw = Number(process.env.TIHU_GRAY_FALLBACK_MS ?? 9e3);
  if (!Number.isFinite(raw) || raw <= 0) return 9e3;
  return clampInt(raw, 50, 12e4);
}
function tihuClarifyMs() {
  const raw = Number(process.env.TIHU_CLARIFY_MS ?? 15e3);
  if (!Number.isFinite(raw) || raw <= 0) return 15e3;
  return clampInt(raw, 100, 6e4);
}
function tihuReceiptHoldMs() {
  const raw = Number(process.env.TIHU_RECEIPT_MS ?? RECEIPT_SECONDS * 1e3);
  if (!Number.isFinite(raw) || raw <= 0) return RECEIPT_SECONDS * 1e3;
  return clampInt(raw, 50, 3e4);
}
var TIHU_THINKING_MAX_CHARS = 4e3;
function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
var tihuRuntimeEnv = globalThis.process?.env ?? {};
function tihuEdgeVoiceDefault() {
  const env = String(tihuRuntimeEnv.TIHU_EDGE_VOICE ?? "").trim();
  if (env !== "") return env;
  try {
    const configured = String(loadAssistantConfig().tihu?.voice?.edge ?? "").trim();
    if (isTihuCloudVoice(configured)) return configured;
  } catch {
  }
  return TIHU_CLOUD_VOICE_DEFAULT;
}
var PC_ACTIVE_WINDOW_MS = 15e3;
var PC_RUNNING_STILL_MS = 9e4;
var PC_SESSION_WINDOW_MS = DONE_KEEP_MS;
var PC_QUEUED_WINDOW_MS = 10 * 6e4;
var PC_SESSION_MAX = 6;
function tihuPcSyncMs() {
  const raw = Number(tihuRuntimeEnv.TIHU_PC_SYNC_MS ?? 1e4);
  if (!Number.isFinite(raw)) return 1e4;
  return clampInt(raw, 1e3, 5 * 6e4);
}
function externalProjectNameOf(cwd) {
  const folder = String(cwd ?? "").trim();
  if (folder === "") return "";
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  const tail = parts.length === 0 ? "" : String(parts[parts.length - 1]);
  const named = projectNameOf(folder);
  if (named !== "" && named !== "\u5176\u4ED6") return named;
  return tail;
}
function inspectTihuVoiceWav(audioBase64) {
  try {
    const BufferCtor = globalThis.Buffer;
    const buffer = BufferCtor.from(String(audioBase64 ?? ""), "base64");
    const info = parseWav(buffer);
    if (info === null || info.sampleRate !== 16e3 || info.channels !== 1 || info.bits !== 16) return { kind: "reject", reason: "\u97F3\u9891\u683C\u5F0F\u4E0D\u53D7\u652F\u6301" };
    const count = Math.floor(info.dataBytes / 2);
    if (count < 1600) return { kind: "reject", reason: "\u5F55\u97F3\u592A\u77ED" };
    let mean = 0;
    for (let i = 0; i < count; i += 1) mean += buffer.readInt16LE(info.dataOffset + i * 2) / 32768;
    mean /= count;
    let energy = 0;
    let peak = 0;
    const frameSamples = 320;
    let voicedFrames = 0;
    let frames = 0;
    for (let start = 0; start < count; start += frameSamples) {
      const end = Math.min(count, start + frameSamples);
      let frameEnergy = 0;
      for (let i = start; i < end; i += 1) {
        const value = buffer.readInt16LE(info.dataOffset + i * 2) / 32768 - mean;
        energy += value * value;
        frameEnergy += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      frames += 1;
      if (Math.sqrt(frameEnergy / Math.max(1, end - start)) >= 6e-3) voicedFrames += 1;
    }
    const rms = Math.sqrt(energy / Math.max(1, count));
    const voicedMs = Math.round(voicedFrames * frameSamples / 16e3 * 1e3);
    if (peak < 1e-3 || rms < 3e-3 && voicedMs < 100) return { kind: "reject", reason: "\u6CA1\u6709\u542C\u5230\u6709\u6548\u4EBA\u58F0" };
    if (info.durationMs < 600 || voicedMs < 300 || voicedFrames / Math.max(1, frames) < 0.08) return { kind: "review", reason: "\u58F0\u97F3\u8F83\u77ED\u6216\u8F83\u5F31\uFF0C\u8BF7\u786E\u8BA4\u540E\u53D1\u9001" };
    return { kind: "ok", reason: "" };
  } catch {
    return { kind: "reject", reason: "\u97F3\u9891\u65E0\u6CD5\u89E3\u6790" };
  }
}
function tihuVoiceAutoEligible(text) {
  const value = String(text ?? "").trim();
  if ([...value].length < 2) return false;
  if (/(删除|删掉|清空|格式化|写|修改|移动|覆盖|安装|卸载|运行|执行|脚本|重启|停止|关闭|结束|发送|发布|提交|推送|转账|支付|归档|commit|push|deploy|\brm\b|\bdel\b)/i.test(value)) return false;
  return /^(?:请|帮我|麻烦)?(?:查看|看|读取|读|查询|查|搜索|总结|解释|翻译|列出|汇报|告诉|分析|什么|怎么|哪|现在|目前)/.test(value);
}
function optionalService3(ctx, id) {
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
function workspaceIdOf(source) {
  const header = source?.header ?? source;
  const value = header?.workspaceId ?? source?.workspaceId ?? source?.workspace?.id;
  return typeof value === "string" && value !== "" ? value : void 0;
}
function shortSessionId2(sessionId) {
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
var TIHU_LANE_LOG_MAX_BYTES = 2 * 1024 * 1024;
function tihuLaneLogPath() {
  const override = String(process.env.TIHU_LANE_LOG ?? "").trim();
  if (override !== "") return override;
  const dshHome3 = String(process.env.DSH_HOME ?? "").trim();
  return join14(dshHome3 !== "" ? dshHome3 : join14(homedir11(), ".dsh"), "tihu", "lane.log");
}
function compactErrorText(error) {
  const text = String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? "unknown error" : text;
}
function appendTihuLaneLog(sessionId, error, note = "") {
  const message = compactErrorText(error);
  const stackLines = String(error?.stack ?? "").split(/\r?\n/).map((line2) => line2.trim()).filter((line2) => line2 !== "");
  const stackHead = stackLines[0] ?? "";
  const stackFrame = stackLines.find((line2) => line2.startsWith("at ")) ?? "";
  const parts = [
    `[${(/* @__PURE__ */ new Date()).toISOString()}]`,
    `session=${sessionId}`,
    ...note === "" ? [] : [`note=${note}`],
    `message=${JSON.stringify(message)}`,
    ...stackHead === "" ? [] : [`stack=${JSON.stringify(stackHead)}`],
    ...stackFrame === "" || stackFrame === stackHead ? [] : [`frame=${JSON.stringify(stackFrame)}`]
  ];
  const line = `${parts.join(" ")}
`;
  try {
    const file = tihuLaneLogPath();
    mkdirSync9(dirname8(file), { recursive: true });
    try {
      if (statSync7(file).size > TIHU_LANE_LOG_MAX_BYTES) writeFileSync7(file, "", "utf8");
    } catch {
    }
    appendFileSync4(file, line, "utf8");
  } catch {
  }
  return line;
}
function appendTihuLaneNote(note, text) {
  appendTihuLogLine(`[${(/* @__PURE__ */ new Date()).toISOString()}]${note === "" ? "" : ` note=${note}`} message=${JSON.stringify(String(text ?? "").replace(/\s+/g, " ").trim())}
`);
}
var TIHU_TOOL_CALL_ARGS_MAX_CHARS = 200;
function appendTihuToolCallLog(tool, args) {
  let json = "";
  try {
    json = JSON.stringify(args ?? {}) ?? "{}";
  } catch {
    json = '"<args \u4E0D\u53EF\u5E8F\u5217\u5316>"';
  }
  const chars = [...json];
  const text = chars.length > TIHU_TOOL_CALL_ARGS_MAX_CHARS ? `${chars.slice(0, TIHU_TOOL_CALL_ARGS_MAX_CHARS - 1).join("")}\u2026` : json;
  appendTihuLogLine(`[${(/* @__PURE__ */ new Date()).toISOString()}] note=tihu_tool_call tool=${String(tool ?? "").trim() || "-"} args=${text}
`);
}
function appendTihuLogLine(line) {
  try {
    const file = tihuLaneLogPath();
    mkdirSync9(dirname8(file), { recursive: true });
    try {
      if (statSync7(file).size > TIHU_LANE_LOG_MAX_BYTES) writeFileSync7(file, "", "utf8");
    } catch {
    }
    appendFileSync4(file, line, "utf8");
  } catch {
  }
}
function clipScreenBullet(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}\u2026`;
}
function screenReasonOf(error) {
  const message = compactErrorText(error);
  const rules = [
    [/archiv|归档/i, "\u4F1A\u8BDD\u5DF2\u5F52\u6863"],
    [/not loaded|unload|未加载|没加载|加载失败/i, "\u4F1A\u8BDD\u6CA1\u52A0\u8F7D"],
    [/no such|not found|missing|不存在|找不到/i, "\u4F1A\u8BDD\u4E0D\u5B58\u5728"],
    [/busy|in progress|locked|正忙/i, "\u4F1A\u8BDD\u6B63\u5FD9"],
    [/timeout|timed out|超时/i, "\u54CD\u5E94\u8D85\u65F6"],
    [/permission|denied|forbidden|没权限|无权限|权限/i, "\u6CA1\u6709\u6743\u9650"],
    [/closed|disconnect|断开/i, "\u8FDE\u63A5\u65AD\u4E86"],
    [/create|创建|新建|建不/i, "\u5EFA\u4E0D\u51FA\u4F1A\u8BDD"]
  ];
  for (const [pattern, reason] of rules) if (pattern.test(message)) return reason;
  return clipScreenBullet(message, 20);
}
function websocketAccept(key) {
  return createHash4("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
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
  function pendingLog(line) {
    try {
      log(line);
    } catch {
    }
    appendTihuLaneNote("tihu-pending", line);
  }
  const devices = /* @__PURE__ */ new Set();
  const activeSessions = /* @__PURE__ */ new Map();
  const runningSessions = /* @__PURE__ */ new Map();
  const deferredReplies = /* @__PURE__ */ new Map();
  let childReconcileTimer;
  const sessionPresets = /* @__PURE__ */ new Map();
  const lastAssistant = /* @__PURE__ */ new Map();
  const progressStates = /* @__PURE__ */ new Map();
  let disposed = false;
  const ledgerStore = new TaskLedgerStore({
    ...options.taskLedgerPath === void 0 || options.taskLedgerPath === "" ? {} : { file: options.taskLedgerPath },
    snapshot: () => ledgerSnapshotOf(tasks.list()),
    onError: (message) => log(`tihu ledger: ${message}`)
  });
  const tasks = new TaskLedger((line) => appendTaskJournal(line), { onChange: () => ledgerStore.schedule() });
  const notifyBus = new TaskNotifyBus();
  let commanderSessionId;
  let commanderWait;
  const pendingCommanderTask = /* @__PURE__ */ new Map();
  const commanderAsks = [];
  const commanderTurnReplied = /* @__PURE__ */ new Set();
  const commanderToolCalls = /* @__PURE__ */ new Map();
  const controlHandled = /* @__PURE__ */ new Map();
  let fallbackDispatch;
  const FALLBACK_DEDUPE_MS = 5 * 6e4;
  let grayFallback;
  let clarifyTimer;
  let intentClarifyTimer;
  let runRegisteredTihuTool;
  const clarifyAsked = /* @__PURE__ */ new Map();
  const CLARIFY_ONCE_MS = 10 * 6e4;
  const pcTaskOfSession = /* @__PURE__ */ new Map();
  const pcDismissedAt = /* @__PURE__ */ new Map();
  const pcActivityAt = /* @__PURE__ */ new Map();
  const runAnchorAt = /* @__PURE__ */ new Map();
  const turnEndedAt = /* @__PURE__ */ new Map();
  const runEndedAt = /* @__PURE__ */ new Map();
  const progressEventAt = /* @__PURE__ */ new Map();
  const pendingBridges = /* @__PURE__ */ new Map();
  function restoreTaskLedger() {
    const snapshot = ledgerStore.load();
    if (snapshot === void 0) return;
    try {
      const restored = tasks.restore(snapshot.tasks, Date.now());
      for (const task of restored.tasks) {
        if (task.source !== "pc") continue;
        const sessionId = task.sessionIds[0];
        if (sessionId !== void 0 && sessionId !== "") pcTaskOfSession.set(sessionId, task.taskId);
      }
      log(`tihu ledger restore tasks=${restored.restored} dropped=${restored.dropped} ended=${restored.ended} file=${ledgerStore.path()}`);
    } catch (error) {
      log(`tihu ledger restore failed: ${error?.message ?? String(error)}`);
    }
  }
  restoreTaskLedger();
  const flushLedgerOnExit = () => {
    ledgerStore.flush();
  };
  try {
    process.once("exit", flushLedgerOnExit);
  } catch {
  }
  function noteRunAnchor(taskId, at, reset = false) {
    if (!Number.isFinite(at) || at <= 0) return;
    if (reset) {
      runAnchorAt.set(taskId, at);
      return;
    }
    const known = runAnchorAt.get(taskId);
    if (known === void 0 || known <= 0 || at < known) runAnchorAt.set(taskId, at);
  }
  function elapsedOfTask(task, sessionId) {
    let anchor = runAnchorAt.get(task.taskId);
    if (anchor === void 0 || anchor <= 0) {
      const candidates = [task.startedAt, sessionId === void 0 ? void 0 : runningSessions.get(sessionId)].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
      anchor = candidates.length > 0 ? Math.min(...candidates) : Date.now();
      runAnchorAt.set(task.taskId, anchor);
    }
    const endedAt = runEndedAt.get(task.taskId) ?? task.finishedAt;
    const end = endedAt !== void 0 && Number.isFinite(endedAt) && endedAt > 0 ? Math.min(Date.now(), endedAt) : Date.now();
    return Math.max(0, end - anchor);
  }
  function pcStartAnchorOf(sessionId, fallback = Date.now()) {
    const turn = runningSessions.get(sessionId);
    if (turn !== void 0 && Number.isFinite(turn)) return turn;
    const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId);
    const prompted = Number(row?.updatedAt ?? 0);
    if (Number.isFinite(prompted) && prompted > 0) return prompted;
    return fallback;
  }
  let pcSyncTimer;
  let pcSyncing = false;
  let announceTimer;
  let announceHoldUntil = 0;
  const preroll = new TihuPreroll();
  const announcing = /* @__PURE__ */ new Set();
  function cancelSpeaking(device) {
    device.speakEpoch = (device.speakEpoch ?? 0) + 1;
    announcing.delete(device.id);
    device.doneReadingTask = void 0;
  }
  const liveThinking = /* @__PURE__ */ new Map();
  const thinkingTimers = /* @__PURE__ */ new Map();
  const replySessions = /* @__PURE__ */ new Set();
  const tts = options.tts?.instance ?? new TihuTts({
    log,
    workspaceOf: options.workspaceOf,
    ...options.tts?.threads === void 0 ? {} : { threads: options.tts.threads },
    ...options.tts?.disabled === true ? { disabled: true } : {},
    ...options.tts?.port === void 0 ? {} : { port: options.tts.port },
    ...options.tts?.paths === void 0 ? {} : { paths: options.tts.paths }
  });
  if (options.tts?.prewarm === true && options.tts?.disabled !== true && tts.backend() !== "none") {
    void tts.ensureServer().catch((error) => log(`tihu tts prewarm failed: ${error?.message ?? String(error)}`));
  }
  function broadcast(sessionId, type, payload) {
    for (const device of devices) {
      if (device.sessionId !== sessionId) continue;
      device.send(type, payload);
    }
  }
  function screenMetaOf(sessionId) {
    const sessions = optionalService3(ctx, "sessions");
    let live;
    try {
      live = typeof sessions?.get === "function" ? sessions.get(sessionId) : void 0;
    } catch {
      live = void 0;
    }
    if (live === void 0 || live === null) return {};
    const values = projectionValuesOf(live);
    const sumTokens = (node) => {
      if (node === null || typeof node !== "object") return 0;
      let sum = 0;
      for (const [key, value] of Object.entries(node)) {
        if (!/tokens$/i.test(key) || /window|limit/i.test(key)) continue;
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) sum += num;
      }
      return sum;
    };
    const totalTokens = Math.max(
      sumTokens(values?.tokenUsage),
      sumTokens(values?.usage),
      sumTokens(values?.sessionStats),
      0
    );
    const decodeMs = Number(values?.sessionStats?.decodeMs ?? 0);
    const decodeTokens = Number(values?.sessionStats?.decodeTokens ?? 0);
    const sample = { at: Date.now(), decodeMs, decodeTokens };
    const averageTokPerSec = decodeMs > 0 ? decodeTokens / (decodeMs / 1e3) : 0;
    const speedSamples = pushDecodeSample(speedWindows.get(sessionId) ?? [], sample);
    speedWindows.set(sessionId, speedSamples);
    const liveSpeed = decodeRateOf(speedSamples) ?? speedLive.get(sessionId) ?? averageTokPerSec;
    speedLive.set(sessionId, liveSpeed);
    const tokPerSec = liveSpeed;
    const contextWindow = Number(values?.contextPressure?.contextWindow ?? 0);
    const used = Number(values?.contextPressure?.pressureTokens ?? values?.contextPressure?.surfaceTokens ?? 0);
    const contextPercent = contextWindow > 0 ? Math.min(100, used / contextWindow * 100) : 0;
    return { title: titleOf(live), stats: { tokPerSec, totalTokens, contextPercent } };
  }
  const speedWindows = /* @__PURE__ */ new Map();
  const titleFetchAt = /* @__PURE__ */ new Map();
  const speedLive = /* @__PURE__ */ new Map();
  const lastFrames = /* @__PURE__ */ new Map();
  let sessionListCache;
  function titleForSession(sessionId) {
    const live = liveSessionOf(sessionId);
    const projected = live === void 0 ? void 0 : titleOf(live);
    if (projected !== void 0 && projected !== "") return projected;
    const cached = titleCache.get(sessionId)?.title;
    if (cached !== void 0 && cached !== "") return cached;
    const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId);
    if (row?.title !== void 0 && row.title !== "") return row.title;
    return shortSessionId2(sessionId);
  }
  function liveSessionOf(sessionId) {
    const sessions = optionalService3(ctx, "sessions");
    if (sessions === void 0 || typeof sessions?.get !== "function") return void 0;
    try {
      const live = sessions.get(sessionId);
      return live === void 0 || live === null ? void 0 : live;
    } catch {
      return void 0;
    }
  }
  function pushFrame(device, frame) {
    device.screenStage = frame.stage;
    device.send("screen.frame", frame);
  }
  function sendFrame(device, frame, sessionId) {
    const outgoing = { ...frame, bullets: frame.bullets ?? [] };
    lastFrames.set(sessionId ?? device.sessionId ?? device.id, outgoing);
    pushFrame(device, outgoing);
  }
  const sessionListTtlMs = () => clampInt(Number(tihuRuntimeEnv.TIHU_SESSION_LIST_TTL_MS ?? 6e4), 100, 6e5);
  const titleCache = /* @__PURE__ */ new Map();
  function projectionValuesOf(source) {
    try {
      const projections = optionalService3(ctx, "sessionProjections");
      if (projections !== void 0 && typeof projections?.cachedSnapshot === "function") {
        const block = projections.cachedSnapshot(source);
        if (block !== void 0 && block !== null && typeof block.values === "object" && block.values !== null) return block.values;
      }
    } catch {
    }
    try {
      const cache3 = optionalService3(ctx, "sessionProjectionCache");
      if (cache3 !== void 0 && typeof cache3?.cachedSnapshot === "function") {
        const block = cache3.cachedSnapshot(source?.header ?? source);
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
  function headerOfSession(source) {
    return source?.header ?? source;
  }
  function agentSessionIdOf(agent) {
    const header = headerOfSession(agent?.session);
    if (typeof header?.id === "string" && header.id !== "") return header.id;
    return typeof agent?.id === "string" && agent.id !== "" ? agent.id : void 0;
  }
  function liveAgentList() {
    const registry = optionalService3(ctx, "agents");
    try {
      if (typeof registry?.list !== "function") return void 0;
      const listed = registry.list();
      return Array.isArray(listed) ? listed : void 0;
    } catch {
      return void 0;
    }
  }
  const codeAgentParentOf = /* @__PURE__ */ new Map();
  const CODE_AGENT_LINK_MAX = 200;
  function rememberCodeAgentChild(parentId, childId) {
    if (parentId === "" || childId === "" || parentId === childId) return false;
    if (codeAgentParentOf.get(childId) === parentId) return false;
    codeAgentParentOf.set(childId, parentId);
    if (codeAgentParentOf.size > CODE_AGENT_LINK_MAX) {
      const oldest = codeAgentParentOf.keys().next().value;
      if (typeof oldest === "string") codeAgentParentOf.delete(oldest);
    }
    log(`tihu code_agent link child=${childId} parent=${parentId}`);
    return true;
  }
  function codeAgentRegistryRows() {
    const rows = /* @__PURE__ */ new Map();
    const registry = optionalService3(ctx, "codeAgentRegistry");
    if (registry === void 0 || typeof registry?.list !== "function") return rows;
    try {
      const listed = registry.list();
      for (const row of Array.isArray(listed) ? listed : []) {
        const sessionId = typeof row?.sessionId === "string" ? row.sessionId : "";
        const callerId = typeof row?.callerId === "string" ? row.callerId : "";
        if (sessionId === "" || callerId === "") continue;
        rows.set(sessionId, { callerId, state: typeof row?.state === "string" ? row.state : "" });
      }
    } catch {
    }
    return rows;
  }
  function syncCodeAgentLinks() {
    const rows = codeAgentRegistryRows();
    for (const [childId, row] of rows) rememberCodeAgentChild(row.callerId, childId);
    return rows;
  }
  function runningSubagentCountOf(sessionId, agents = liveAgentList()) {
    if (sessionId === "") return 0;
    const registryRows = syncCodeAgentLinks();
    const childrenOf = /* @__PURE__ */ new Map();
    const agentById = /* @__PURE__ */ new Map();
    const addChild = (parentId, childId) => {
      if (childId === void 0 || childId === "") return;
      const siblings = childrenOf.get(parentId) ?? /* @__PURE__ */ new Set();
      siblings.add(childId);
      childrenOf.set(parentId, siblings);
    };
    if (agents !== void 0) {
      for (const agent of agents) {
        const id = agentSessionIdOf(agent);
        if (id !== void 0) agentById.set(id, agent);
        const header = headerOfSession(agent?.session);
        const parent = header?.parentSession;
        if (typeof parent !== "string" || parent === "") continue;
        if (header?.origin !== "subagent") continue;
        addChild(parent, id);
      }
    } else {
      for (const row of sessionListCache?.rows ?? []) {
        if (row.origin !== "subagent" || row.parentSession === void 0) continue;
        addChild(row.parentSession, row.sessionId);
      }
    }
    for (const [childId, parentId] of codeAgentParentOf) addChild(parentId, childId);
    const childRunning = (childId) => {
      const agent = agentById.get(childId);
      const state = registryRows.get(childId)?.state;
      if (state === "running") return true;
      if (agent?.status === "running") return true;
      const statusUnknown = agent === void 0 || agent.status === void 0;
      return statusUnknown && runningSessions.has(childId) && state !== "completed" && state !== "stopped";
    };
    let running = 0;
    const pending = [sessionId];
    const visited = /* @__PURE__ */ new Set([sessionId]);
    while (pending.length > 0) {
      const parentId = pending.shift();
      for (const childId of childrenOf.get(parentId) ?? []) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        if (childRunning(childId)) running += 1;
        pending.push(childId);
      }
    }
    return running;
  }
  function ancestorSessionIdsOf(session, sessionId) {
    const chain = [sessionId];
    const seen = /* @__PURE__ */ new Set([sessionId]);
    let current = session;
    for (let depth = 0; depth < 32; depth += 1) {
      const header = headerOfSession(current);
      const parent = header?.parentSession;
      if (typeof parent !== "string" || parent === "" || seen.has(parent)) break;
      chain.push(parent);
      seen.add(parent);
      const live = liveSessionOf(parent);
      current = live ?? sessionListCache?.rows.find((row) => row.sessionId === parent);
      if (current === void 0) break;
    }
    return chain;
  }
  function reconcileTasksForChild(session, childId, at) {
    for (const ancestorId of ancestorSessionIdsOf(session, childId).slice(1)) {
      const task = tasks.ofSession(ancestorId);
      if (task === void 0) continue;
      const running = runningSubagentCountOf(ancestorId);
      if (tasks.setChildRunning(task.taskId, running, at)) refreshBoards();
      if (running === 0 && task.holdingForChildren === true) finalizeHeldTask(task, at);
    }
  }
  function reconcileTasksForCodeChild(parentId, at) {
    const task = tasks.ofSession(parentId);
    if (task === void 0) return;
    const running = runningSubagentCountOf(parentId);
    if (tasks.setChildRunning(task.taskId, running, at)) refreshBoards();
    if (running === 0 && task.holdingForChildren === true) {
      finalizeHeldTask(task, at);
      log(`tihu code_agent settled task=${task.taskId} parent=${parentId}`);
    }
  }
  function showReplyScreen(task, input) {
    const resultLine = String(input.resultLine ?? "").trim() || "\u505A\u5B8C\u4E86";
    task.doneText = input.reply;
    if (String(task.resultLine ?? "").trim() === "") task.resultLine = resultLine;
    const frame = doneFrame({
      taskId: task.taskId,
      title: task.title,
      resultLine,
      replyText: input.reply || DONE_NO_REPLY_TEXT,
      bullets: replyBulletsOf(input.reply)
    });
    for (const device of devices) {
      if (!device.unified) continue;
      if (device.receiptTimer !== void 0 || device.pendingPick !== void 0) continue;
      const focused = device.focusedTask === void 0 ? void 0 : tasks.get(device.focusedTask);
      if (focused?.state === "awaiting") continue;
      disarmAutoHome(device);
      device.focusedTask = task.taskId;
      device.onBoard = false;
      sendFrame(device, frame, device.sessionId);
      sendTaskUpdate(device, task);
      readDoneScreen(device, task);
    }
    pushTaskNotify(task, 1, doneAnnouncementOf(task));
    refreshBoards();
  }
  function showCompletedTask(task, input) {
    const resultLine = String(input.resultLine ?? "").trim() || "\u505A\u5B8C\u4E86";
    tasks.complete(task.taskId, { resultLine, now: input.at });
    showReplyScreen(task, { reply: input.reply, resultLine });
  }
  function finalizeHeldTask(task, at = Date.now()) {
    const sessionId = task.sessionIds[task.sessionIds.length - 1];
    const stored = deferredReplies.get(task.taskId);
    deferredReplies.delete(task.taskId);
    const reply = stored?.reply ?? (sessionId === void 0 ? "" : cachedAssistantText(sessionId));
    const resultLine = stored?.resultLine ?? task.pendingResultLine ?? (firstSentenceOf(reply) || "\u505A\u5B8C\u4E86");
    const alreadyRead = stored?.announcedAt !== void 0;
    task.childRunning = void 0;
    task.holdingForChildren = void 0;
    task.pendingResultLine = void 0;
    if (alreadyRead) {
      tasks.complete(task.taskId, { resultLine, now: at });
      if (String(task.doneText ?? "").trim() === "") task.doneText = reply;
      refreshBoards();
      for (const device of devices) {
        if (!device.unified) continue;
        if (device.focusedTask !== task.taskId) continue;
        sendTaskUpdate(device, task);
      }
      log(`tihu subagents settled task=${task.taskId} children=0 silent=1`);
      return;
    }
    showCompletedTask(task, { reply, resultLine, at });
    log(`tihu subagents settled task=${task.taskId} children=0`);
  }
  function reconcileChildTasks(reason) {
    if (disposed) return;
    const now = Date.now();
    const agents = liveAgentList();
    let changed = false;
    for (const task of tasks.list()) {
      if (task.state === "archived" || task.state === "awaiting") continue;
      if (task.sessionIds.length === 0) continue;
      if (task.state === "done" || task.state === "announced") {
        if ((task.childRunning ?? 0) === 0 && task.holdingForChildren !== true) continue;
      }
      const sessionId = task.sessionIds[task.sessionIds.length - 1];
      const running = runningSubagentCountOf(sessionId, agents);
      if ((task.childRunning ?? 0) !== running) {
        tasks.setChildRunning(task.taskId, running, now);
        changed = true;
      }
      if (running === 0 && task.holdingForChildren === true) {
        finalizeHeldTask(task, now);
        changed = true;
      }
    }
    if (changed) {
      refreshBoards();
      log(`tihu subagent reconcile reason=${reason}`);
    }
  }
  function ensureChildReconcile() {
    if (childReconcileTimer !== void 0) return;
    const timer = setInterval(() => {
      try {
        reconcileChildTasks("tick");
      } catch (error) {
        log(`tihu subagent reconcile failed: ${error?.message ?? String(error)}`);
      }
    }, 2e3);
    timer.unref?.();
    childReconcileTimer = timer;
  }
  function activityOf(source) {
    const header = source?.header ?? source;
    const createdAt = Number.isFinite(header?.createdAt) ? Number(header.createdAt) : 0;
    const metadata = projectionValuesOf(source).sessionListMetadata;
    const lastPromptAt = metadata !== null && typeof metadata === "object" && Number.isFinite(metadata.lastPromptAt) ? Number(metadata.lastPromptAt) : 0;
    return Math.max(createdAt, lastPromptAt);
  }
  function liveSessionRows() {
    const sessions = optionalService3(ctx, "sessions");
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
        ...typeof session?.header?.parentSession === "string" ? { parentSession: session.header.parentSession } : {},
        ...session?.header?.origin === "subagent" ? { origin: "subagent" } : {},
        ...workspaceIdOf(session) === void 0 ? {} : { workspaceId: workspaceIdOf(session) },
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
    if (!force && sessionListCache !== void 0 && now - sessionListCache.at < sessionListTtlMs()) {
      return { rows: sessionListCache.rows, source: sessionListCache.source };
    }
    const live = liveSessionRows();
    const query = optionalService3(ctx, "sessionQuery");
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
            ...typeof record?.header?.parentSession === "string" ? { parentSession: record.header.parentSession } : {},
            ...record?.header?.origin === "subagent" ? { origin: "subagent" } : {},
            ...workspaceIdOf(record) === void 0 ? {} : { workspaceId: workspaceIdOf(record) },
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
  async function findSession(sessionId) {
    const sessions = optionalService3(ctx, "sessions");
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
            ...workspaceIdOf(live) === void 0 ? {} : { workspaceId: workspaceIdOf(live) },
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
      collected = void 0;
    }
    if (collected?.source === "sessionQuery") {
      const row = collected.rows.find((item) => item.sessionId === sessionId);
      return row === void 0 ? { status: "missing" } : { status: row.live ? "live" : "persisted", row };
    }
    try {
      const agent = optionalService3(ctx, "agents")?.get?.(sessionId);
      const live = agent?.session;
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
            ...workspaceIdOf(live) === void 0 ? {} : { workspaceId: workspaceIdOf(live) },
            ...Number.isFinite(live?.header?.createdAt) ? { createdAt: Number(live.header.createdAt) } : {}
          }
        };
      }
      if (agent !== void 0 && agent !== null && typeof agent.followup === "function") {
        return {
          status: "live",
          row: {
            sessionId,
            title: titleCache.get(sessionId)?.title ?? "",
            preset: sessionPresets.get(sessionId) ?? "",
            updatedAt: Date.now(),
            live: true
          }
        };
      }
    } catch {
    }
    return { status: "unknown" };
  }
  function flushLiveThinking(sessionId) {
    const buffer = liveThinking.get(sessionId);
    if (buffer === void 0 || buffer.text === "") return;
    const state = progressStates.get(sessionId);
    if (state === void 0) return;
    const update = applyEarlyThinking(state, buffer.text, Date.now(), CONTENT_WIDTH_PX);
    if (update === void 0) return;
    const task = tasks.ofSession(sessionId);
    if (task !== void 0) refreshFocusedDetail(task);
  }
  function scheduleLiveThinking(sessionId) {
    if (thinkingTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      thinkingTimers.delete(sessionId);
      try {
        flushLiveThinking(sessionId);
      } catch (error) {
        log(`tihu thinking flush failed: ${error?.message ?? String(error)}`);
      }
    }, tihuThinkingFlushMs());
    timer.unref?.();
    thinkingTimers.set(sessionId, timer);
  }
  function stopLiveThinking(sessionId, flush) {
    const timer = thinkingTimers.get(sessionId);
    if (timer !== void 0) {
      clearTimeout(timer);
      thinkingTimers.delete(sessionId);
    }
    if (flush) flushLiveThinking(sessionId);
    liveThinking.delete(sessionId);
  }
  let cardCache;
  function projectsStateFile() {
    let file = process.env.TIHU_PROJECTS_STATE ?? "";
    if (file !== "") return file;
    let dir = "";
    try {
      const profile = optionalService3(ctx, "profileContext");
      if (typeof profile?.dir === "string" && profile.dir !== "") dir = profile.dir;
    } catch {
    }
    if (dir === "") {
      try {
        const homePaths = optionalService3(ctx, "homePaths");
        if (typeof homePaths?.home === "string" && homePaths.home !== "") dir = homePaths.home;
      } catch {
      }
    }
    if (dir === "") dir = process.env.DSH_HOME ?? process.cwd();
    return join14(dir, "dsh-assistant-state.json");
  }
  function projectCards() {
    const file = projectsStateFile();
    try {
      const info = statSync7(file);
      if (cardCache !== void 0 && cardCache.mtimeMs === info.mtimeMs) return cardCache.cards;
      const parsed = JSON.parse(readFileSync10(file, "utf8"));
      const cards = cardsFromState(parsed);
      cardCache = { mtimeMs: info.mtimeMs, cards };
      return cards;
    } catch {
      return void 0;
    }
  }
  function writeProjectsState(mutate) {
    const file = projectsStateFile();
    try {
      const raw = JSON.parse(readFileSync10(file, "utf8"));
      const projects = raw?.projects ?? raw;
      if (projects === null || typeof projects !== "object" || Array.isArray(projects)) return false;
      if (!mutate(projects)) return false;
      const next = raw?.projects === void 0 ? { projects, view: null, revision: Number(raw?.revision ?? 0) + 1, updatedAt: (/* @__PURE__ */ new Date()).toISOString() } : { ...raw, revision: Number(raw?.revision ?? 0) + 1, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      writeFileSync7(file, JSON.stringify(next, null, 2), "utf8");
      cardCache = void 0;
      return true;
    } catch (error) {
      log(`tihu projects state write failed: ${error?.message ?? String(error)}`);
      return false;
    }
  }
  const LAYOUT_DEFAULTS = {
    leftWidth: { default: 260, min: 160, max: 480 },
    chatWidth: { default: 360, min: 240, max: 600 },
    chatWidthRatio: 0.3,
    topHeight: { default: 200, min: 120, max: 480 },
    topHeightRatio: 0.35,
    chatSide: "right",
    chatFullHeight: false,
    chatHidden: false,
    chatOnly: false
  };
  function dispatchProjectCard(name2, folder) {
    const title = name2.trim();
    if (title === "" || folder.trim() === "") return void 0;
    const id = `card-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
    let created;
    const ok2 = writeProjectsState((projects) => {
      const layouts = Array.isArray(projects.layouts) ? projects.layouts : [];
      const folders = projects.folders !== null && typeof projects.folders === "object" ? projects.folders : {};
      const overrides = projects.nameOverrides !== null && typeof projects.nameOverrides === "object" ? projects.nameOverrides : {};
      const order = Array.isArray(projects.order) ? projects.order : [];
      const template = layouts.find((layout2) => layout2?.id === ASSISTANT_CARD.id) ?? layouts.find((layout2) => layout2 !== null && typeof layout2 === "object");
      const layout = template === void 0 || template === null ? { id, title, left: null, top: null, main: [{ id: "p1", title: "\u7A97\u53E31", min: 200, content: null }], ...LAYOUT_DEFAULTS } : { ...JSON.parse(JSON.stringify(template)), id, title };
      projects.layouts = [...layouts, layout];
      projects.folders = { ...folders, [id]: folder };
      projects.nameOverrides = { ...overrides, [id]: title };
      projects.order = [id, ...order.filter((item) => String(item) !== id)];
      created = { id, name: title, folder };
      return true;
    });
    if (!ok2 || created === void 0) return void 0;
    log(`tihu card created id=${created.id} name=${JSON.stringify(title)} folder=${folder}`);
    return created;
  }
  function resolveCardForDispatch(hint, text) {
    const cards = projectCards() ?? [];
    const key = String(hint ?? "").trim();
    if (key !== "") {
      const lower = key.toLowerCase();
      const hit = cards.find((card) => card.id === key || card.name === key || card.name.toLowerCase().includes(lower) || String(card.folder ?? "").toLowerCase().includes(lower));
      if (hit !== void 0) return hit;
    }
    const scored = cards.map((card) => ({ card, ...scoreCardAlias(text, card) })).filter((item) => item.score > 0).sort((a, b) => (b.via === "name" ? 1 : 0) - (a.via === "name" ? 1 : 0) || b.score - a.score);
    if (scored.length > 0) return scored[0].card;
    if (key === "") return void 0;
    const folder = isAbsolute3(key) ? key : join14(assistantFolder(), key);
    return dispatchProjectCard(nameFromFolder(key), folder);
  }
  function nameFromFolder(path3) {
    const parts = String(path3 ?? "").split(/[\\/]+/).filter(Boolean);
    const last = parts.length === 0 ? "" : parts[parts.length - 1];
    return last === "" ? "\u65B0\u9879\u76EE" : last;
  }
  function workspaceRegistryRows() {
    const registry = optionalService3(ctx, "workspaceRegistry");
    if (registry === void 0 || typeof registry.list !== "function") return void 0;
    let listed;
    try {
      listed = registry.list();
    } catch (error) {
      log(`tihu workspaceRegistry.list failed: ${error?.message ?? String(error)}`);
      return void 0;
    }
    if (!Array.isArray(listed)) return void 0;
    const items = [];
    for (const entry of listed) {
      try {
        const path3 = typeof entry?.path === "string" ? entry.path : "";
        const title = typeof entry?.title === "string" ? entry.title : "";
        if (path3 === "" && title === "") continue;
        const rawUpdatedAt = entry?.updatedAt;
        const parsed = typeof rawUpdatedAt === "string" ? Date.parse(rawUpdatedAt) : Number(rawUpdatedAt);
        const sessionIds = Array.isArray(entry?.sessionIds) ? entry.sessionIds.map((id) => String(id)) : [];
        items.push({
          id: typeof entry?.id === "string" ? entry.id : "",
          path: path3,
          title,
          sessionIds,
          updatedAt: Number.isFinite(parsed) ? parsed : 0
        });
      } catch (error) {
        log(`tihu workspace entry skipped: ${error?.message ?? String(error)}`);
      }
    }
    return items;
  }
  async function transcribe(audioBase64, externalSignal) {
    const speech = optionalService3(ctx, "speechController");
    if (speech === void 0 || typeof speech?.transcribe !== "function") {
      throw new Error("\u672C\u673A\u8BED\u97F3\u8F6C\u5199\u4E0D\u53EF\u7528\uFF1A\u5BBF\u4E3B\u6CA1\u6709\u52A0\u8F7D speech \u670D\u52A1\uFF08voice-input / speech-to-text \u63D2\u4EF6\uFF09");
    }
    if (!looksLikeWavBase64(audioBase64)) throw new Error("\u97F3\u9891\u4E0D\u662F WAV\uFF08\u9700\u8981 16k \u5355\u58F0\u9053 16bit\uFF09");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    const cancel = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", cancel, { once: true });
    try {
      const audio = new Uint8Array(Buffer.from(audioBase64, "base64"));
      const result = await speech.transcribe({ audio, language: "auto", audioBase64 }, controller.signal);
      const text = typeof result === "string" ? result : String(result?.text ?? result?.transcript ?? result?.result ?? "").trim();
      applyPersonalTerms(loadAssistantConfig().asrTerms);
      return cleanFillers(fixTerms(text)).trim();
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    }
  }
  function windowOf(sessionId) {
    const window2 = activeSessions.get(sessionId);
    if (window2 === void 0) return void 0;
    if (window2.until < Date.now()) {
      activeSessions.delete(sessionId);
      return void 0;
    }
    return window2;
  }
  function endSession(sessionId) {
    const existed = activeSessions.delete(sessionId);
    if (existed) log(`tihu session end session=${sessionId}`);
    return existed;
  }
  function touchWindow(sessionId) {
    const window2 = activeSessions.get(sessionId);
    if (window2 === void 0) return;
    window2.until = Date.now() + ACTIVE_WINDOW_MS;
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
    const window2 = sessionId === void 0 ? void 0 : windowOf(sessionId);
    const last = lastUserMessageId(exec?.agent?.session);
    if (sessionId === void 0) return void 0;
    const task = tasks.ofSession(sessionId);
    if (task !== void 0 && task.source !== "pc" && task.state !== "done" && task.state !== "announced" && task.state !== "archived") return sessionId;
    if (window2 === void 0) return void 0;
    if (last === void 0) return sessionId;
    if (window2.messageId === "") return sessionId;
    return last === window2.messageId ? sessionId : void 0;
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
    let dispatched = false;
    let dangerousAction = false;
    const runNext = async () => {
      dispatched = true;
      return await next();
    };
    try {
      const sessionId = tihuTurnOf(exec);
      if (sessionId === void 0) return await runNext();
      const tool = String(exec?.name ?? "");
      const workspace = workspaceFor(sessionId, exec?.agent);
      const args = argsOf(exec);
      const rawTarget = targetPathOf(args);
      const command = commandOf(args);
      const target = rawTarget !== void 0 ? rawTarget : command;
      const exists = rawTarget !== void 0 ? existsSyncSafe(workspace, rawTarget) : void 0;
      const action = classifyTool(tool, exists, command);
      dangerousAction = action.dangerous;
      if (!action.touchesFiles && !action.dangerous) return await runNext();
      let snapshotPath;
      let snapshotRoot;
      if (action.touchesFiles && rawTarget !== void 0) {
        const snapshot = takeSnapshot(workspace, rawTarget, timestampSlug());
        snapshotPath = snapshot.snapshotPath;
        snapshotRoot = snapshot.snapshotRoot;
        if (snapshot.copied) log(`tihu snapshot ${snapshot.relativePath} -> ${snapshot.snapshotPath}`);
      }
      if (action.dangerous) {
        const detail = action.kind === "shell" ? String(command ?? "").slice(0, 300) : String(rawTarget ?? target ?? "");
        appendAudit(workspace, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          source: "tihu",
          sessionId,
          action: action.kind,
          tool,
          ...detail === "" ? {} : { target: detail },
          ...snapshotRoot === void 0 ? {} : { snapshot: snapshotRoot },
          decision: "host-approval",
          note: "\u5371\u9669\u52A8\u4F5C\u4EA4\u7535\u8111\u7AEF\u5BA1\u6279\uFF08\u8BBE\u5907\u5C4F\u4E0D\u663E\u793A\u6388\u6743\u8BF7\u6C42\uFF09"
        });
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
      return await runNext();
    } catch (error) {
      log(`tihu pre-execute failed: ${error?.stack ?? String(error)}`);
      if (dispatched) throw error;
      if (dangerousAction) return { kind: "deny", reason: "tihu: \u95F8\u5185\u90E8\u51FA\u9519\uFF0C\u5371\u9669\u52A8\u4F5C\u9ED8\u8BA4\u4E0D\u6267\u884C" };
      return await runNext();
    }
  });
  function codeAgentChildIdOf(exec, result) {
    const args = argsOf(exec);
    const fromArgs = typeof args?.session_id === "string" && args.session_id.trim() !== "" ? args.session_id.trim() : void 0;
    const seen = /* @__PURE__ */ new Set();
    const pick = (value, depth) => {
      if (value === null || typeof value !== "object" || depth > 4 || seen.has(value)) return void 0;
      seen.add(value);
      for (const key of ["session_id", "sessionId", "childSessionId"]) {
        const found = value[key];
        if (typeof found === "string" && found.trim() !== "") return found.trim();
      }
      for (const key of ["value", "result", "output", "data", "payload"]) {
        const found = pick(value[key], depth + 1);
        if (found !== void 0) return found;
      }
      return void 0;
    };
    return pick(result, 0) ?? fromArgs;
  }
  function handleCodeAgentTool(exec, result) {
    const rawTool = String(exec?.name ?? "");
    const tool = rawTool.includes("/") ? rawTool.slice(rawTool.lastIndexOf("/") + 1) : rawTool;
    if (tool !== "code_agent" && tool !== "code_agent_stop") return;
    const parentId = sessionIdOfAgent(exec?.agent);
    if (parentId === void 0) return;
    const args = argsOf(exec);
    if (tool === "code_agent_stop") {
      const stopped = typeof args?.session_id === "string" ? args.session_id.trim() : "";
      if (stopped === "") return;
      syncCodeAgentLinks();
      reconcileTasksForCodeChild(codeAgentParentOf.get(stopped) ?? parentId, Date.now());
      return;
    }
    const childId = codeAgentChildIdOf(exec, result);
    if (childId === void 0 || childId === "") {
      log("tihu code_agent link skipped: no session_id in result");
      return;
    }
    rememberCodeAgentChild(parentId, childId);
    syncCodeAgentLinks();
    const at = Date.now();
    const running = runningSubagentCountOf(parentId);
    const task = tasks.ofSession(parentId);
    if (task === void 0 || task.state === "archived" || task.state === "awaiting") return;
    let changed = tasks.setChildRunning(task.taskId, running, at);
    if (running > 0 && (task.state === "done" || task.state === "announced")) {
      const reply = lastAssistant.get(parentId)?.text ?? "";
      const resultLine = firstSentenceOf(reply) || task.resultLine || "\u505A\u5B8C\u4E86";
      tasks.holdForChildren(task.taskId, { childRunning: running, resultLine, now: at });
      deferredReplies.set(task.taskId, { reply, resultLine, announcedAt: at });
      changed = true;
    }
    if (changed) refreshBoards();
    log(`tihu code_agent child=${childId} parent=${parentId} running=${running}`);
  }
  const disposePost = ctx.on?.("tools/post-execute", async (exec, result, next) => {
    try {
      handleCodeAgentTool(exec, result);
    } catch (error) {
      log(`tihu code_agent hook failed: ${error?.stack ?? String(error)}`);
    }
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
  function showInputError(device, error, friendly) {
    const first = clipScreenBullet(friendly ?? compactErrorText(error), 18);
    const reason = screenReasonOf(error);
    const bullets = first === reason ? [first] : [first, reason];
    device.send("event.alert", { level: "error", text: `${first}\uFF08${reason}\uFF09` });
    sendFrame(device, {
      stage: "\u4F1A\u8BDD",
      title: "\u6307\u4EE4\u672A\u53D1\u9001",
      bullets: fitScreenLines(bullets, 3),
      tone: "alert",
      mode: "status"
    });
  }
  function showDispatchStuck(device, error, headLine) {
    const reason = screenReasonOf(error);
    const head = headLine ?? "\u9879\u76EE\u5DF2\u5B9A\uFF0C\u5BBF\u4E3B\u6CA1\u5EFA\u8D77\u4F1A\u8BDD";
    const lines = fitScreenLines([head, reason], 3);
    device.send("event.alert", { level: "error", text: `\u8FD9\u6761\u6CA1\u6D3E\u51FA\u53BB\uFF08${reason}\uFF09` });
    sendFrame(device, {
      stage: "\u4F1A\u8BDD",
      title: "\u8FD9\u6761\u6CA1\u6D3E\u51FA\u53BB",
      bullets: lines,
      tone: "alert",
      mode: "status"
    });
  }
  async function routeCommittedText(device, text) {
    if (device.unified) {
      await dispatchUtterance(device, text);
      const key2 = device.sessionId;
      if (key2 !== void 0) touchWindow(key2);
      return true;
    }
    await dispatchUtterance(device, text);
    const key = device.sessionId;
    if (key !== void 0) touchWindow(key);
    return true;
  }
  function cancelPendingVoice(device) {
    const pending = device.pendingVoice;
    if (pending?.timer !== void 0) clearTimeout(pending.timer);
    device.pendingVoice = void 0;
  }
  function invalidateVoiceInput(device) {
    device.voiceAttempt += 1;
    cancelPendingVoice(device);
    try {
      device.cancelAsr?.();
    } catch {
    }
    device.cancelAsr = void 0;
  }
  async function commitPendingVoice(device, pending) {
    if (device.pendingVoice !== pending || !devices.has(device)) return;
    if (pending.attempt !== device.voiceAttempt) {
      cancelPendingVoice(device);
      return;
    }
    if (pending.timer !== void 0) clearTimeout(pending.timer);
    device.pendingVoice = void 0;
    if (device.sessionId !== pending.sessionId) {
      showInputError(device, new Error(`\u5DF2\u5207\u6362\u5230\uFF1A${titleForSession(device.sessionId ?? "")}\uFF1B\u8BF7\u91CD\u8BF4\u4E00\u6B21`));
      return;
    }
    await routeCommittedText(device, pending.text);
    device.send("event.progress", { stage: "\u6CE8\u5165", text: "\u5DF2\u9001\u5165\u5F53\u524D\u4F1A\u8BDD" });
  }
  function previewVoice(device, text, attempt, quality) {
    if (attempt !== device.voiceAttempt || device.sessionId === void 0 || !devices.has(device)) return;
    cancelPendingVoice(device);
    const sessionId = device.sessionId;
    const autoEligible = quality.kind === "ok" && tihuVoiceAutoEligible(text) && !runningSessions.has(sessionId);
    const pending = { attempt, text, sessionId, autoEligible };
    device.pendingVoice = pending;
    device.send("transcript", { text, final: true, source: "voice", retryable: true });
    sendFrame(device, {
      stage: "\u6211\u542C\u5230",
      title: "\u786E\u8BA4\u8FD9\u53E5\u6307\u4EE4",
      bullets: fitScreenLines([`\u6211\u542C\u5230\uFF1A${text}`, quality.kind === "review" ? quality.reason : autoEligible ? "\u7EA6 2 \u79D2\u540E\u81EA\u52A8\u53D1\u9001" : "\u8BF7\u70B9\u53D1\u9001\uFF0C\u6216\u70B9\u91CD\u8BF4"], 3),
      tone: autoEligible ? "busy" : "idle",
      mode: "status",
      actions: [{ id: "send", label: "\u53D1\u9001" }, { id: "retry", label: "\u91CD\u8BF4" }]
    }, sessionId);
    if (!autoEligible) return;
    pending.timer = setTimeout(() => {
      if (device.pendingVoice !== pending) return;
      void commitPendingVoice(device, pending).catch((error) => showInputError(device, error));
    }, options.previewDelayMs ?? 2e3);
  }
  function replyBulletsOf(reply) {
    const text = String(reply ?? "").replace(/\s+/g, " ").trim();
    if (text === "") return [];
    const parts = text.split(/[。！？!?\n]/).map((part) => part.trim()).filter(Boolean);
    return parts.slice(0, 3).map((part) => taskTitleOf(part, 30));
  }
  function pruneStaleTurns() {
    const stale = tihuTurnStaleMs();
    const now = Date.now();
    for (const [sessionId, startedAt] of runningSessions) {
      if (now - startedAt < stale) continue;
      runningSessions.delete(sessionId);
      log(`tihu stale turn pruned session=${sessionId}`);
    }
  }
  const disposeSession = ctx.on?.("session/event", (session, event) => {
    try {
      const sessionId = sessionIdOf(session);
      if (sessionId === void 0) return;
      const type = String(event?.type ?? "");
      const data = event?.data ?? {};
      const at = Date.now();
      if (type === "user/message" && data?.source?.kind === "user") {
        const row = sessionListCache?.rows.find((item) => item.sessionId === sessionId);
        if (row !== void 0) {
          const time = Number.isFinite(event?.time) ? Number(event.time) : at;
          row.updatedAt = Math.max(row.updatedAt, time);
          if (sessionListCache !== void 0) sessionListCache.rows = sortSessionRows(sessionListCache.rows);
        }
      }
      const sessionPreset = presetOf(session);
      if (sessionPreset !== "") sessionPresets.set(sessionId, sessionPreset);
      if (type === "turn/start") {
        runningSessions.set(sessionId, at);
        turnEndedAt.delete(sessionId);
        const startedTask = tasks.ofSession(sessionId);
        if (startedTask !== void 0) {
          runEndedAt.delete(startedTask.taskId);
          progressEventAt.set(startedTask.taskId, at);
        }
        stopLiveThinking(sessionId, false);
        touchWindow(sessionId);
        for (const device of devices) {
          if (device.sessionId !== sessionId) continue;
          if (device.voiceUi?.timer !== void 0) clearTimeout(device.voiceUi.timer);
          device.voiceUi = void 0;
        }
      } else if (type === "turn/end") {
        runningSessions.delete(sessionId);
        turnEndedAt.set(sessionId, at);
        pcActivityAt.delete(sessionId);
        const endedTask = tasks.ofSession(sessionId);
        if (endedTask !== void 0) {
          runEndedAt.set(endedTask.taskId, at);
          progressEventAt.set(endedTask.taskId, at);
          const progress = progressStates.get(sessionId);
          if (progress !== void 0) {
            progress.lastEventLine = "";
            progress.activity = [];
          }
        }
        setTimeout(pruneStaleTurns, 0);
      }
      if (headerOfSession(session)?.origin === "subagent" && (type === "turn/start" || type === "turn/end")) {
        reconcileTasksForChild(session, sessionId, at);
      }
      if (type === "turn/start" || type === "turn/end") {
        if (!codeAgentParentOf.has(sessionId)) syncCodeAgentLinks();
        const codeParent = codeAgentParentOf.get(sessionId);
        if (codeParent !== void 0) reconcileTasksForCodeChild(codeParent, at);
      }
      if (type === "assistant/message") {
        const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
        const text = stripToolNoise(blocks.filter((b) => b?.type === "text").map((b) => String(b?.text ?? "")).join("\n")).trim();
        if (text !== "") lastAssistant.set(sessionId, { text, at });
      }
      if (sessionId === commanderSessionId) {
        const turnValue = Number(data?.turn);
        const turn = Number.isFinite(turnValue) && turnValue > 0 ? turnValue : void 0;
        if (type === "turn/start") {
          assignCommanderTurn(turn ?? 0);
        } else if (type === "tool/call") {
          noteCommanderToolCall(turn, data?.name ?? data?.call?.name ?? "");
        } else if (type === "assistant/message") {
          const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
          const replyText = stripToolNoise(blocks.filter((b) => b?.type === "text").map((b) => String(b?.text ?? "")).join("\n")).trim();
          if (replyText !== "") {
            void settleCommanderReply(replyText, false, turn).catch((error) => log(`tihu commander reply settle failed: ${error?.message ?? String(error)}`));
          }
        } else if (type === "turn/end") {
          const entry = lastAssistant.get(sessionId);
          const ask = commanderAskForTurn(turn, true);
          const fresh = entry !== void 0 && (ask === void 0 || entry.at >= ask.askedAt);
          void settleCommanderReply(fresh ? entry.text : "", true, turn).catch((error) => log(`tihu commander reply settle failed: ${error?.message ?? String(error)}`));
        }
      }
      const taskOfSession = tasks.ofSession(sessionId);
      if (taskOfSession !== void 0 && taskOfSession.source === "pc") {
        const livePreset = presetOf(session) || sessionPresets.get(sessionId) || "";
        if (livePreset !== "" && !isComputerUsePreset(livePreset)) {
          archivePcTask(taskOfSession.taskId, at, `preset=${livePreset}`);
          return;
        }
        if (type !== "turn/end") pcActivityAt.set(sessionId, at);
        if (type === "turn/start" || type === "step/start" || type === "tool/call" || type === "assistant/message") {
          progressEventAt.set(taskOfSession.taskId, at);
        }
        const progress = progressStates.get(sessionId) ?? createProgressState();
        progressStates.set(sessionId, progress);
        applySessionEvent(progress, event, at, screenMetaOf(sessionId));
        if (type !== "turn/end") refreshFocusedDetail(taskOfSession);
        if (type === "turn/start") {
          noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || at, true);
          tasks.resetStep(taskOfSession.taskId, at);
          tasks.syncExternal(taskOfSession.taskId, { state: "running", startedAt: progress.turnStartedAt || at, at });
          refreshBoards();
          followRunningTask(taskOfSession);
        } else if (type === "step/start" || type === "tool/call") {
          const stepValue = Number(data?.step);
          tasks.noteStep(taskOfSession.taskId, Number.isFinite(stepValue) ? stepValue : progress.step, at);
          noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || at);
          refreshFocusedDetail(taskOfSession);
          refreshBoards();
        } else if (type === "assistant/message") {
          const pcLine = plainSummaryOf(lastAssistant.get(sessionId)?.text ?? "");
          if (pcLine !== "") {
            noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || pcStartAnchorOf(sessionId, at));
            tasks.syncExternal(taskOfSession.taskId, taskOfSession.state === "running" ? { state: "running", summary: pcLine, at } : { state: "running", startedAt: pcStartAnchorOf(sessionId, at), summary: pcLine, at });
          }
        } else if (type === "turn/end") {
          const pcReason = finishReasonOf(data);
          const pcOk = pcReason === "stop" || pcReason === "completed";
          if (taskOfSession.state === "awaiting" && !settlePendingDecisionDefault(taskOfSession.taskId, "\u56DE\u5408\u7ED3\u675F")) {
            tasks.answer(taskOfSession.taskId, "\u56DE\u5408\u7ED3\u675F", at);
          }
          const doneReply = lastAssistant.get(sessionId)?.text ?? cachedAssistantText(sessionId);
          const pcResult = plainSummaryOf(doneReply) || (pcOk ? "\u505A\u5B8C\u4E86" : `\u4E2D\u65AD\uFF08${pcReason}\uFF09`);
          const childRunning = runningSubagentCountOf(sessionId);
          tasks.setChildRunning(taskOfSession.taskId, childRunning, at);
          if (childRunning > 0) {
            tasks.holdForChildren(taskOfSession.taskId, { childRunning, resultLine: pcResult, now: at });
            const deferred = { reply: doneReply, resultLine: pcResult, announcedAt: void 0 };
            deferredReplies.set(taskOfSession.taskId, deferred);
            if (String(doneReply ?? "").trim() !== "") {
              showReplyScreen(taskOfSession, { reply: doneReply, resultLine: pcResult });
              deferred.announcedAt = at;
            }
            refreshBoards();
            leaveStaleProgress(taskOfSession, "pc-turn-end-held");
            log(`tihu pc held for subagents task=${taskOfSession.taskId} children=${childRunning} announced=${deferred.announcedAt !== void 0}`);
            return;
          }
          showCompletedTask(taskOfSession, { reply: doneReply, resultLine: firstSentenceOf(doneReply) || pcResult, at });
          log(`tihu pc done task=${taskOfSession.taskId} ok=${String(pcOk)} line=${JSON.stringify(pcResult)}`);
        }
        return;
      }
      if (taskOfSession !== void 0) {
        const progress = progressStates.get(sessionId) ?? createProgressState();
        progressStates.set(sessionId, progress);
        applySessionEvent(progress, event, at, screenMetaOf(sessionId));
        const stepValue = Number(data?.step);
        if (type === "turn/start") {
          tasks.markRunning(taskOfSession.taskId, at);
          tasks.clearChildHold(taskOfSession.taskId, at);
          noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || at, true);
          tasks.resetStep(taskOfSession.taskId, at);
          refreshBoards();
          refreshFocusedDetail(taskOfSession);
        } else if (type === "step/start" || type === "tool/call") {
          progressEventAt.set(taskOfSession.taskId, at);
          tasks.noteStep(taskOfSession.taskId, Number.isFinite(stepValue) ? stepValue : progress.step, at);
          noteRunAnchor(taskOfSession.taskId, progress.turnStartedAt || at);
          refreshFocusedDetail(taskOfSession);
          refreshBoards();
        } else if (type !== "turn/end") {
          if (type === "assistant/message" || type === "tool/result") progressEventAt.set(taskOfSession.taskId, at);
          refreshFocusedDetail(taskOfSession);
        } else if (type === "turn/end") {
          const reason = finishReasonOf(data);
          const ok2 = reason === "stop" || reason === "completed";
          if (taskOfSession.state === "awaiting" && !settlePendingDecisionDefault(taskOfSession.taskId, "\u56DE\u5408\u7ED3\u675F")) {
            tasks.answer(taskOfSession.taskId, "\u56DE\u5408\u7ED3\u675F", at);
          }
          const reply = lastAssistant.get(sessionId)?.text ?? cachedAssistantText(sessionId);
          const resultLine = firstSentenceOf(reply) || (ok2 ? "\u505A\u5B8C\u4E86" : `\u4E2D\u65AD\uFF08${reason}\uFF09`);
          const childRunning = runningSubagentCountOf(sessionId);
          tasks.setChildRunning(taskOfSession.taskId, childRunning, at);
          if (childRunning > 0) {
            tasks.holdForChildren(taskOfSession.taskId, { childRunning, resultLine, now: at });
            const deferred = { reply, resultLine, announcedAt: void 0 };
            deferredReplies.set(taskOfSession.taskId, deferred);
            if (String(reply ?? "").trim() !== "") {
              showReplyScreen(taskOfSession, { reply, resultLine });
              deferred.announcedAt = at;
            }
            refreshBoards();
            leaveStaleProgress(taskOfSession, "turn-end-held");
            log(`tihu task held for subagents task=${taskOfSession.taskId} children=${childRunning} announced=${deferred.announcedAt !== void 0}`);
            return;
          }
          showCompletedTask(taskOfSession, { reply, resultLine, at });
          log(`tihu task done task=${taskOfSession.taskId} ok=${String(ok2)} line=${JSON.stringify(resultLine)}`);
        }
        return;
      }
      if (type === "turn/end" && sessionId === commanderSessionId) {
        const reply = lastAssistant.get(sessionId)?.text ?? "";
        const line = plainSummaryOf(reply, 60);
        if (line === "") return;
        for (const device of devices) {
          if (!device.unified) continue;
          const key = device.sessionId ?? device.id;
          if (device.screenStage !== "\u56DE\u7B54") continue;
          if (device.receiptTimer !== void 0 || device.pendingPick !== void 0) continue;
          const lines = replyBulletsOf(reply).slice(0, 2);
          const frame = noticeFrame({ stage: "\u56DE\u7B54", title: line, lines, tone: "ok" });
          lastFrames.set(key, frame);
          pushFrame(device, frame);
          void speakAnnouncement(device, line).then((spokenMs) => {
            if (spokenMs >= 0) armAutoHome(device, spokenMs);
          }).catch((error) => log(`tihu answer speak failed: ${error?.message ?? String(error)}`));
        }
      }
    } catch (error) {
      log(`tihu session event failed: ${error?.stack ?? String(error)}`);
    }
  });
  const disposeAssistantStream = ctx.on?.("agent/assistant-stream", (payload) => {
    try {
      const sessionId = sessionIdOfAgent(payload?.agent);
      if (sessionId === void 0) return;
      const frame = payload?.frame;
      if (frame === null || typeof frame !== "object") return;
      if (frame.type === "start") {
        stopLiveThinking(sessionId, false);
        liveThinking.set(sessionId, { attemptId: String(frame.attemptId ?? ""), text: "" });
        return;
      }
      if (frame.type === "chunk") {
        const chunk = frame.chunk;
        if (chunk?.type !== "reasoning-delta" || typeof chunk.text !== "string" || chunk.text === "") return;
        const buffer = liveThinking.get(sessionId);
        if (buffer === void 0) return;
        if (buffer.text.length < TIHU_THINKING_MAX_CHARS) buffer.text += chunk.text;
        scheduleLiveThinking(sessionId);
        return;
      }
      if (frame.type === "end") stopLiveThinking(sessionId, true);
    } catch (error) {
      log(`tihu assistant stream failed: ${error?.message ?? String(error)}`);
    }
  });
  const disposeApprovalRequest = registerPendingWaterfall("approval", "approval/request");
  const disposeQuestionRequest = registerPendingWaterfall("question", "user-questions/request");
  function handleUpgrade(req, socket, head) {
    if (pathnameOf(req) !== TIHU_LANE_PATH) return false;
    try {
      socket.on?.("error", (error) => log(`tihu socket error: ${error?.message ?? String(error)}`));
    } catch {
    }
    try {
      return handleUpgradeSession(req, socket, head);
    } catch (error) {
      log(`tihu upgrade failed: ${error?.stack ?? String(error)}`);
      try {
        socket.destroy?.();
      } catch {
      }
      return true;
    }
  }
  function handleUpgradeSession(req, socket, head) {
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
      unified: true,
      bindEpoch: 0,
      autoBindEpoch: 0,
      voiceAttempt: 0,
      commitInFlight: false,
      connectedAt: Date.now(),
      voice: "default",
      edgeVoice: tihuEdgeVoiceDefault(),
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
      },
      // 停止/重读/回主页/P0 打断都走这里：把轮次号 +1，正在下发的那一轮 PCM 立刻哑火。
      cancelRound() {
        cancelSpeaking(device);
      }
    };
    devices.add(device);
    let queue = Promise.resolve();
    const enqueue2 = (message) => {
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
          const actionId = message.type === "screen.gesture" ? String(message.payload?.actionId ?? "") : "";
          if (message.type === "audio.frame" || message.type === "text.input" || message.type === "session.end" || message.type === "screen.gesture" && actionId !== "send") invalidateVoiceInput(device);
          if (message.type === "device.ack") {
            const ack = message.payload;
            device.lastSeenAt = Date.now();
            settleDeviceAck(ack);
            if (ack.ok !== true) log(`tihu device ack not-ok device=${device.id} op=${ack.opId} reason=${ack.reason ?? "-"}`);
            return;
          }
          enqueue2(message);
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
      invalidateVoiceInput(device);
      rememberRecentDevice(device);
      devices.delete(device);
      try {
        device.cancelRound?.();
      } catch {
      }
      if (devices.size === 0) {
        stopPcSync();
      }
      broadcastAll("event.alert", { level: "info", text: "\u8BBE\u5907\u5DF2\u65AD\u5F00" });
      log(`tihu device disconnected id=${device.id}`);
    });
    if (head !== void 0 && head.length > 0) parser.push(head);
    return true;
  }
  function broadcastAll(type, payload) {
    for (const device of devices) device.send(type, payload);
  }
  function tihuAckTimeoutMs() {
    return clampInt(Number(tihuRuntimeEnv.TIHU_ACK_TIMEOUT_MS ?? 1500), 40, 1e4);
  }
  const pendingAcks = /* @__PURE__ */ new Map();
  function awaitDeviceAck(device, type, payload) {
    const opId = randomId("op");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(opId);
        log(`tihu ack timeout device=${device.id} type=${type} op=${opId}`);
        resolve(void 0);
      }, tihuAckTimeoutMs());
      pendingAcks.set(opId, { resolve, timer });
      device.send(type, { ...payload, opId });
    });
  }
  function settleDeviceAck(ack) {
    const pending = pendingAcks.get(ack.opId);
    if (pending === void 0) return;
    pendingAcks.delete(ack.opId);
    clearTimeout(pending.timer);
    pending.resolve(ack);
  }
  function clearPendingAcks() {
    for (const pending of pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve(void 0);
    }
    pendingAcks.clear();
  }
  async function handleUpstream(device, message) {
    const type = String(message.type);
    if (type === "ping") {
      device.send("pong", { nonce: message?.payload?.nonce });
      return;
    }
    device.lastSeenAt = Date.now();
    if (type === "device.ack") {
      const ack = message.payload;
      settleDeviceAck(ack);
      if (ack.ok !== true) log(`tihu device ack not-ok device=${device.id} op=${ack.opId} reason=${ack.reason ?? "-"}`);
      return;
    }
    if (type === "playback.state") {
      const payload = message.payload;
      const changed = device.playback?.phase !== payload.phase;
      device.playback = payload;
      if (changed) log(`tihu playback device=${device.id} phase=${payload.phase} seg=${payload.segment ?? "-"} line=${payload.line ?? "-"}`);
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
      device.autoFollow = false;
      device.unified = true;
      device.focusedTask = void 0;
      device.onBoard = true;
      device.playback = void 0;
      device.pausedAt = void 0;
      const commander = await ensureCommanderSession();
      if (commander !== void 0) {
        device.sessionId = commander;
        device.send("session.bound", {
          sessionId: commander,
          title: titleForSession(commander),
          project: projectNameOf(liveSessionOf(commander)?.header?.cwd),
          live: true,
          preset: TASK_PRESET,
          computerUse: false
        });
        device.send("event.progress", { stage: "\u6307\u6325", text: "\u7EDF\u4E00\u6307\u6325\u5DF2\u5C31\u7EEA\uFF1A\u8BF4\u4E00\u53E5\u8BDD\u5C31\u6D3E\u5355\uFF0C\u4E0D\u7528\u6311\u4F1A\u8BDD" });
        ensurePcSync();
        ensureChildReconcile();
        void syncExternalSessions().catch((error) => log(`tihu pc sync failed: ${error?.message ?? String(error)}`));
        sendBoard(device);
      } else {
        device.sessionId = void 0;
        device.focusedTask = void 0;
        sendFrame(device, noticeFrame({ stage: "", title: "\u9E48\u9E55\u6307\u6325\u53F0\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u542F", lines: [], tone: "alert" }));
        device.send("event.alert", { level: "error", text: "\u9E48\u9E55\u6307\u6325\u53F0\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u542F" });
        log("tihu unified mode unavailable: commander session could not be created");
      }
      device.send("event.progress", { stage: "\u8FDE\u63A5", text: `\u8BBE\u5907 ${device.id} \u5DF2\u5C31\u7EEA` });
      log(`tihu hello client=${payload.clientId} session=${device.sessionId ?? "?"} caps=${JSON.stringify(caps)}`);
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
      device.send("event.progress", {
        stage: "\u4F1A\u8BDD",
        text: ended ? `\u5DF2\u7ED3\u675F\u672C\u6B21\u8BED\u97F3\u4F1A\u8BDD\uFF08${payload.reason ?? "\u9875\u9762\u6309\u94AE"}\uFF09` : "\u5F53\u524D\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u8BED\u97F3\u4F1A\u8BDD"
      });
      sendBoard(device);
      return;
    }
    if (type === "task.reply") {
      const payload = message.payload ?? {};
      if (payload.command === "board") {
        await runScreenCommand(device, { kind: "board" });
        return;
      }
      if (payload.command === "stop") {
        await runScreenCommand(device, { kind: "stop" });
        return;
      }
      if (payload.command === "cancel") {
        await runScreenCommand(device, { kind: "cancel" });
        return;
      }
      if (payload.command === "open") {
        const target = payload.taskId ?? device.focusedTask;
        if (target !== void 0 && openTask(device, target)) return;
        await runScreenCommand(device, { kind: "open" });
        return;
      }
      if (typeof payload.optionText === "string" && payload.optionText.trim() !== "") {
        const target = payload.taskId === void 0 ? device.focusedTask === void 0 ? void 0 : tasks.get(device.focusedTask) : tasks.get(payload.taskId);
        if (target !== void 0 && target.state === "awaiting") {
          const list = (target.options ?? []).filter((option) => String(option ?? "").trim() !== "");
          const key = payload.optionText.trim();
          const exact = list.findIndex((label) => label.trim() === key);
          const index = exact >= 0 ? exact : list.findIndex((label) => label.includes(key) || key.includes(label));
          if (index >= 0) {
            if (!answerPendingDecision(target.taskId, index, "\u8BBE\u5907\u8BED\u97F3")) tasks.answer(target.taskId, "\u8BBE\u5907\u8BED\u97F3", Date.now());
            device.send("event.progress", { stage: "\u5F85\u51B3\u7B56", text: `\u5DF2\u9009\uFF1A${list[index]}` });
            leaveDecisionScreens(target.taskId, device.id);
            sendBoard(device);
          } else {
            device.send("event.progress", { stage: "\u5F85\u51B3\u7B56", text: `\u6CA1\u5BF9\u4E0A\u9009\u9879\u300C${key}\u300D\uFF1A${list.join(" / ")}` });
          }
        }
        return;
      }
      if (payload.optionIndex !== void 0) {
        const target = payload.taskId === void 0 ? device.focusedTask === void 0 ? void 0 : tasks.get(device.focusedTask) : tasks.get(payload.taskId);
        if (target !== void 0 && target.state === "awaiting") {
          const index = Math.max(0, Math.min(Math.trunc(payload.optionIndex), Math.max(0, (target.options ?? []).length - 1)));
          const label = (target.options ?? [])[index] ?? "";
          if (!answerPendingDecision(target.taskId, index, "\u8BBE\u5907\u70B9\u9009")) tasks.answer(target.taskId, "\u8BBE\u5907\u70B9\u9009", Date.now());
          device.send("event.progress", { stage: "\u5F85\u51B3\u7B56", text: `\u5DF2\u9009\uFF1A${label}` });
          leaveDecisionScreens(target.taskId, device.id);
          sendBoard(device);
        }
        return;
      }
      return;
    }
    if (type === "screen.gesture") {
      const payload = message.payload;
      if (payload.action === "tap" && typeof payload.x === "number" && typeof payload.y === "number") {
        const sid = device.sessionId;
        if (payload.hit === "action" && typeof payload.actionId === "string") {
          const actionId = payload.actionId;
          if (actionId === "taskBoard") {
            try {
              device.cancelRound?.();
            } catch {
            }
            if (commanderWait !== void 0) device.waitMuted = true;
            await runScreenCommand(device, { kind: "board" });
            return;
          }
          if (actionId === "boardPrev" || actionId === "boardNext") {
            const current = Math.max(0, Math.trunc(device.boardPage ?? 0));
            const step = actionId === "boardNext" ? 1 : -1;
            const next = Math.max(0, current + step);
            if (next === current && step < 0) return;
            device.boardPage = next;
            sendBoard(device);
            log(`tihu board page device=${device.id} page=${device.boardPage + 1}`);
            return;
          }
          if (actionId === "replay") {
            const target = device.focusedTask === void 0 ? tasks.list().filter((task) => task.state === "done" || task.state === "announced").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0] : tasks.get(device.focusedTask);
            if (target !== void 0) {
              try {
                device.cancelRound?.();
              } catch {
              }
              if (String(target.doneText ?? "").trim() === "") {
                await showDone(device, target, true);
              } else {
                readDoneScreen(device, target);
              }
            }
            return;
          }
          if (actionId === "taskAnswer1" || actionId === "taskAnswer2") {
            const target = device.focusedTask === void 0 ? void 0 : tasks.get(device.focusedTask);
            if (target !== void 0 && target.state === "awaiting") {
              const raw = actionId === "taskAnswer1" ? 0 : 1;
              const index = Math.max(0, Math.min(raw, Math.max(0, (target.options ?? []).length - 1)));
              const label = (target.options ?? [])[index] ?? "";
              if (!answerPendingDecision(target.taskId, index, "\u8BBE\u5907\u70B9\u9009")) {
                tasks.answer(target.taskId, "\u8BBE\u5907\u70B9\u9009", Date.now());
              }
              device.send("event.progress", { stage: "\u5F85\u51B3\u7B56", text: `\u5DF2\u9009\uFF1A${label}` });
              leaveDecisionScreens(target.taskId, device.id);
              await runScreenCommand(device, { kind: "board" });
            }
            return;
          }
          if (actionId === "taskOpen") {
            const target = device.focusedTask ?? boardOf(tasks.list(), Date.now(), Math.max(0, device.boardPage ?? 0)).rows[0]?.taskId;
            if (target !== void 0) openTask(device, target);
            return;
          }
          if (actionId === "taskCancel") {
            const target = device.focusedTask ?? tasks.list().filter((task) => task.state === "queued").sort((a, b) => b.updatedAt - a.updatedAt)[0]?.taskId;
            if (target !== void 0) await cancelTask(device, target);
            return;
          }
          if (actionId === "taskStop") {
            try {
              device.cancelRound?.();
            } catch {
            }
            device.send("event.progress", { stage: "\u505C\u6B62", text: "\u5DF2\u505C\u6B62\u6717\u8BFB\uFF08\u4EFB\u52A1\u8FD8\u5728\u8DD1\uFF09" });
            return;
          }
          if (actionId === "pick1" || actionId === "pick2") {
            const index = actionId === "pick1" ? 1 : 2;
            if (device.pendingIntent !== void 0) {
              await resolveIntentClarify(device, index === 1 ? "work" : "skip");
              return;
            }
            if (device.pendingClarify !== void 0) {
              await resolveClarify(device, index === 1 ? "new" : "same");
              return;
            }
            const pick = device.pendingPick;
            device.pendingPick = void 0;
            const card = pick?.candidates[index - 1];
            if (pick !== void 0 && card !== void 0) await dispatchWithContinuity(device, pick.text, card, { via: "pick" }, { allowCommander: true });
            return;
          }
          if (actionId === "pickNone") {
            if (device.pendingIntent !== void 0) {
              await resolveIntentClarify(device, "skip");
              return;
            }
            if (device.pendingClarify !== void 0) {
              await resolveClarify(device, "new");
              return;
            }
            const pick = device.pendingPick;
            device.pendingPick = void 0;
            if (pick !== void 0) await dispatchWithContinuity(device, pick.text, ASSISTANT_CARD, { via: "pick-none" }, { allowCommander: true });
            return;
          }
          if (actionId === "send") {
            const pending = device.pendingVoice;
            if (pending !== void 0) await commitPendingVoice(device, pending).catch((error) => showInputError(device, error));
            return;
          }
          if (actionId === "retry") {
            cancelPendingVoice(device);
            device.send("transcript", { text: "", final: true, source: "voice", retryable: true });
            sendFrame(device, {
              stage: "\u91CD\u8BF4",
              title: "\u8BF7\u91CD\u65B0\u8BF4",
              bullets: ["\u4E0A\u4E00\u6761\u672A\u53D1\u9001", "\u8BF4\u5B8C\u540E\u518D\u786E\u8BA4"],
              tone: "idle",
              mode: "status"
            }, sid);
            return;
          }
          if (actionId === "stop") {
            try {
              device.cancelRound?.();
            } catch {
            }
            device.send("event.progress", { stage: "\u505C\u6B62", text: "\u5DF2\u505C\u6B62\u6717\u8BFB" });
            return;
          }
          return;
        }
        if (payload.hit === "task" && typeof payload.taskId === "string") {
          openTask(device, String(payload.taskId));
          return;
        }
        if (payload.x >= 240 && payload.y >= 180) await runScreenCommand(device, { kind: "board" });
        return;
      }
      return;
    }
    if (type === "voice.list") {
      const voices = await tts.listVoices(device.sessionId, device.edgeVoice);
      device.send("voice.list", { voices, selected: device.voice, edgeVoice: device.edgeVoice, engine: tts.status() });
      return;
    }
    if (type === "voice.select") {
      const name2 = String(message.payload?.name ?? "");
      device.voice = name2 === "" ? "default" : name2;
      if (typeof message.payload?.edgeVoice === "string" && message.payload.edgeVoice !== "") device.edgeVoice = message.payload.edgeVoice;
      if (typeof message.payload?.offlineOnly === "boolean") device.offlineOnly = message.payload.offlineOnly;
      if (isKokoroVoice(device.voice) || device.offlineOnly) {
        if (typeof tts.ensureKokoroServer === "function") {
          void tts.ensureKokoroServer().catch((error) => log(`tihu kokoro prewarm failed: ${error?.message ?? String(error)}`));
        }
      } else if (device.voice !== "default" && tts.available()) {
        void tts.ensureServer().catch((error) => log(`tihu tts clone prewarm failed: ${error?.message ?? String(error)}`));
      }
      device.send("event.progress", { stage: "\u97F3\u8272", text: `\u97F3\u8272\u5DF2\u5207\u6362\uFF1A${device.voice}` });
      return;
    }
    if (type === "tts.sample") {
      const requested = typeof message.payload?.text === "string" ? message.payload.text.trim() : "";
      const sampleText = requested === "" ? tihuSampleTextOf(device.edgeVoice) : [...requested].slice(0, 60).join("");
      if (!tts.available()) {
        device.send("event.alert", {
          level: "error",
          text: `\u8BD5\u542C\u65E0\u8BED\u97F3\uFF1A${tts.status().error ?? "\u672C\u5730\u5F15\u64CE\u672A\u5C31\u7EEA"}\uFF08\u5DF2\u6539\u7528\u63D0\u793A\u97F3\uFF09`
        });
        return;
      }
      if (isKokoroVoice(device.voice) || device.offlineOnly) {
        if (typeof tts.ensureKokoroServer === "function") {
          try {
            await tts.ensureKokoroServer();
          } catch {
          }
        }
      } else if (device.voice && device.voice !== "default") {
        try {
          await tts.ensureServer();
        } catch {
        }
      }
      try {
        const result = await tts.synthesize(sampleText, {
          voice: device.voice,
          sessionId: device.sessionId,
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
              index: 0,
              text: sampleText,
              sample: true,
              ...chunk.final ? { final: true } : {}
            });
          }
        });
        log(`tihu tts sample ok chars=${[...sampleText].length} voice=${device.voice} audio=${Math.round(Number(result?.audioMs) || 0)}ms`);
      } catch (error) {
        const reason = error?.message ?? String(error);
        log(`tihu tts sample failed: ${reason}`);
        device.send("event.alert", { level: "error", text: `\u8BD5\u542C\u65E0\u8BED\u97F3\uFF1A${reason}\uFF08\u5DF2\u6539\u7528\u63D0\u793A\u97F3\uFF09` });
      }
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
          voices: await tts.listVoices(device.sessionId, device.edgeVoice),
          selected: device.voice,
          edgeVoice: device.edgeVoice,
          engine: tts.status()
        });
      } catch (error) {
        device.send("event.alert", { level: "error", text: `\u521B\u5EFA\u97F3\u8272\u5931\u8D25\uFF1A${error?.message ?? String(error)}` });
      }
      return;
    }
    if (type === "text.input" || type === "audio.frame") {
      const inputTarget = device.sessionId;
      const source = type === "audio.frame" ? "voice" : message.payload.source === "voice" ? "voice" : "keyboard";
      if (type === "text.input" && message.payload.source === "retry") {
        device.send("transcript", { text: "", final: true, source: "voice", retryable: true });
        sendFrame(device, { stage: "\u91CD\u8BF4", title: "\u8BF7\u91CD\u65B0\u8BF4", bullets: ["\u4E0A\u4E00\u6761\u672A\u53D1\u9001"], tone: "idle", mode: "status" });
        return;
      }
      device.send("event.progress", {
        stage: "audio",
        text: type === "audio.frame" ? "\u5DF2\u6536\u5230\u97F3\u9891\uFF0C\u51C6\u5907\u8F6C\u5199" : "\u5DF2\u6536\u5230\u6587\u5B57"
      });
      if (device.sessionId === void 0) {
        device.send("event.alert", { level: "warn", text: "\u9E48\u9E55\u6307\u6325\u53F0\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u542F" });
        sendFrame(device, noticeFrame({ stage: "", title: "\u9E48\u9E55\u6307\u6325\u53F0\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u542F", lines: [], tone: "alert" }));
        return;
      }
      const expectedTarget = device.sessionId;
      if (type === "audio.frame") {
        const attempt = device.voiceAttempt;
        const quality = inspectTihuVoiceWav(String(message.payload.audioBase64 ?? ""));
        if (quality.kind === "reject") {
          device.send("transcript", { text: "", final: true, source: "voice", retryable: true });
          device.send("event.alert", { level: "warn", text: quality.reason });
          sendFrame(device, { stage: "\u6CA1\u542C\u6E05", title: "\u8BF7\u9760\u8FD1\u540E\u91CD\u8BF4", bullets: [quality.reason], tone: "alert", mode: "status" }, expectedTarget);
          return;
        }
        sendFrame(device, { stage: "\u6B63\u5728\u8F6C\u5199", title: "\u6B63\u5728\u8BC6\u522B\u8BED\u97F3", bullets: ["\u672C\u673A speech \u670D\u52A1"], tone: "busy", mode: "status" }, expectedTarget);
        const asr = new AbortController();
        device.cancelAsr = () => asr.abort();
        let text2 = "";
        try {
          text2 = await transcribe(String(message.payload.audioBase64 ?? ""), asr.signal);
        } catch (error) {
          if (attempt !== device.voiceAttempt || asr.signal.aborted) return;
          device.send("transcript", { text: "", final: true, source: "voice", retryable: true });
          device.send("event.alert", { level: "error", text: `\u8F6C\u5199\u5931\u8D25\uFF1A${error?.message ?? String(error)}` });
          sendFrame(device, { stage: "\u8F6C\u5199\u5931\u8D25", title: "\u8BF7\u91CD\u8BF4\u4E00\u6B21", bullets: ["\u4E5F\u53EF\u4EE5\u70B9\u91CD\u8BF4\u540E\u518D\u8BD5"], tone: "alert", mode: "status" }, expectedTarget);
          return;
        } finally {
          device.cancelAsr = void 0;
        }
        if (attempt !== device.voiceAttempt || device.sessionId !== expectedTarget) {
          if (device.sessionId !== expectedTarget) showInputError(device, new Error("\u8BC6\u522B\u671F\u95F4\u76EE\u6807\u5DF2\u5207\u6362\uFF0C\u8BF7\u91CD\u8BF4\u4E00\u6B21"));
          return;
        }
        if (text2 === "") {
          device.send("transcript", { text: "", final: true, source: "voice", retryable: true });
          device.send("event.alert", { level: "warn", text: "\u6CA1\u6709\u8BC6\u522B\u5230\u8BED\u97F3\u5185\u5BB9\uFF0C\u8BF7\u518D\u8BF4\u4E00\u6B21" });
          sendFrame(device, { stage: "\u6CA1\u542C\u6E05", title: "\u8BF7\u518D\u8BF4\u4E00\u6B21", bullets: ["\u8FD9\u6B21\u6CA1\u6709\u8BC6\u522B\u5230\u5185\u5BB9"], tone: "alert", mode: "status" }, expectedTarget);
          return;
        }
        previewVoice(device, text2, attempt, quality);
        return;
      }
      const text = String(message.payload.text ?? "").trim();
      if (text === "") return;
      try {
        device.send("transcript", { text, final: true, source, retryable: true });
        const screenOwned = await routeCommittedText(device, text);
        device.send("event.progress", { stage: "\u6CE8\u5165", text: "\u5DF2\u9001\u5165\u5F53\u524D\u4F1A\u8BDD" });
        if (!screenOwned) {
          sendFrame(device, { stage: "\u601D\u8003", title: "\u6A21\u578B\u5904\u7406\u4E2D", bullets: [text.slice(0, 20)], tone: "busy" });
        }
      } catch (error) {
        showInputError(device, error);
      }
    }
  }
  const COMMANDER_TITLE = "\u9E48\u9E55\u6307\u6325\u53F0";
  const MEMORY_QUESTION = /^(?:你还记得|还记得|上次|之前|刚才|我们说过|记不记得)/;
  const ASSISTANT_CARD = { id: "wt-assistant", name: "\u4E2A\u4EBA\u52A9\u624B" };
  const TASK_PRESET = "standard";
  const DISPATCH_PRESET = TIHU_COMPUTER_USE_PRESET;
  function assistantFolder() {
    try {
      return ensureAssistantHome().dir;
    } catch {
      return process.env.DSH_ASSISTANT_HOME ?? process.cwd();
    }
  }
  async function createSessionAt(folder, preset) {
    const base = folder !== "" ? { cwd: folder } : {};
    const controller = optionalService3(ctx, "sessionController");
    if (typeof controller?.create === "function") {
      try {
        const created = await controller.create({ ...base, agentPreset: preset });
        const sessionId = typeof created === "string" ? created : typeof created?.sessionId === "string" ? created.sessionId : void 0;
        if (typeof sessionId === "string" && sessionId !== "") {
          sessionListCache = void 0;
          return sessionId;
        }
        log(`tihu sessionController.create returned no sessionId: ${String(JSON.stringify(created ?? null)).slice(0, 140)}`);
      } catch (error) {
        log(`tihu sessionController.create failed: ${error?.message ?? String(error)}`);
      }
    }
    const remote = optionalService3(ctx, "remote");
    if (typeof remote?.session?.create === "function") {
      try {
        const result = await remote.session.create({ ...base, agentPreset: preset });
        if (result?.ok === true && typeof result?.value?.sessionId === "string" && result.value.sessionId !== "") {
          sessionListCache = void 0;
          return result.value.sessionId;
        }
        log(`tihu remote.session.create rejected: ${String(JSON.stringify(result?.error ?? null)).slice(0, 140)}`);
      } catch (error) {
        log(`tihu remote.session.create failed: ${error?.message ?? String(error)}`);
      }
    }
    log(`tihu create session unavailable: ${["sessionController", "remote", "sessions", "agents"].map((id) => `${id}=${optionalService3(ctx, id) === void 0 ? "missing" : "ok"}`).join(" ")}`);
    return void 0;
  }
  async function applyTihuModel(sessionId, kind, note) {
    let tihu;
    try {
      tihu = loadAssistantConfig().tihu;
    } catch {
      tihu = void 0;
    }
    const selection = resolveTihuModel(kind, tihu);
    if (selection === null) return;
    const label = kind === "foreground" ? "\u524D\u53F0" : "\u540E\u53F0";
    const result = await selectModelKeepingDefault(ctx, { sessionId, selection }, log);
    if (result.ok) {
      log(`tihu model ${kind} applied session=${sessionId} ${selection.provider}/${selection.model}\uFF08${note}\uFF09`);
      try {
        appendTihuLaneNote("tihu-model", `\u5DF2\u6307\u5B9A${label}\u6A21\u578B session=${sessionId} ${selection.provider}/${selection.model}`);
      } catch {
      }
      return;
    }
    log(`tihu model ${kind} NOT applied session=${sessionId}: ${result.error}`);
    try {
      appendTihuLaneNote("tihu-model", `\u6307\u5B9A${label}\u6A21\u578B\u5931\u8D25 session=${sessionId}\uFF1A${result.error}`);
    } catch {
    }
  }
  async function titleSession(sessionId, title) {
    const controller = optionalService3(ctx, "sessionController");
    if (typeof controller?.rename !== "function") return false;
    try {
      await controller.rename({ sessionId, title });
      return true;
    } catch (error) {
      log(`tihu rename session=${sessionId} failed: ${error?.message ?? String(error)}`);
      return false;
    }
  }
  function armTihuWindow(sessionId, messageId = "") {
    activeSessions.set(sessionId, { until: Date.now() + ACTIVE_WINDOW_MS, messageId });
  }
  function sessionForMessageId(sessionId) {
    try {
      return optionalService3(ctx, "agents")?.get?.(sessionId)?.session ?? liveSessionOf(sessionId);
    } catch {
      return void 0;
    }
  }
  const PROMPT_RETRY_DELAY_MS = [300, 800];
  async function promptOnce(sessionId, blocks) {
    const sessionsSvc = optionalService3(ctx, "sessions");
    if (typeof sessionsSvc?.using === "function") {
      armTihuWindow(sessionId);
      let before;
      let delivered = false;
      try {
        await sessionsSvc.using(sessionId, { source: "tihu-dispatch" }, async (reference) => {
          const session = reference?.binding?.session;
          before = lastUserMessageId(session);
          await session?.prompt(blocks, "steer");
          delivered = true;
          const after = lastUserMessageId(session);
          if (after !== void 0 && after !== before) armTihuWindow(sessionId, after);
        });
        return { ok: true };
      } catch (error) {
        if (delivered) {
          appendTihuLaneLog(sessionId, error, "after-delivery");
          log(`tihu prompt session=${sessionId} delivered, dispose threw: ${error?.message ?? String(error)}`);
          return { ok: true };
        }
        activeSessions.delete(sessionId);
        return { ok: false, error, fromUsing: true };
      }
    }
    armTihuWindow(sessionId);
    try {
      const before = lastUserMessageId(sessionForMessageId(sessionId));
      const agent = optionalService3(ctx, "agents")?.get?.(sessionId);
      if (agent === void 0 || agent === null || typeof agent.followup !== "function") {
        throw new Error(`\u4F1A\u8BDD ${sessionId.slice(0, 8)}\u2026 \u5F53\u524D\u6CA1\u6709\u6D3B\u52A8 agent`);
      }
      const message = buildTihuUserMessage(String(blocks[0]?.text ?? ""));
      for (const block of blocks.slice(1)) message.content.push({ type: "text", text: block.text });
      armTihuWindow(sessionId, String(message.id));
      agent.followup(message);
      const after = lastUserMessageId(sessionForMessageId(sessionId));
      if (after !== void 0 && after !== before) armTihuWindow(sessionId, after);
      return { ok: true };
    } catch (error) {
      activeSessions.delete(sessionId);
      return { ok: false, error, fromUsing: false };
    }
  }
  async function ensureAppendTarget(sessionId) {
    const running = appendResumeInFlight.get(sessionId);
    if (running !== void 0) return await running;
    const work = resumeAppendTargetOnce(sessionId);
    appendResumeInFlight.set(sessionId, work);
    try {
      return await work;
    } finally {
      if (appendResumeInFlight.get(sessionId) === work) appendResumeInFlight.delete(sessionId);
    }
  }
  const appendResumeInFlight = /* @__PURE__ */ new Map();
  async function resumeAppendTargetOnce(sessionId) {
    const agents = optionalService3(ctx, "agents");
    const liveAgent = () => {
      try {
        return agents?.get?.(sessionId);
      } catch {
        return void 0;
      }
    };
    const already = liveAgent();
    if (already !== void 0 && already !== null) return { ok: true, resumed: false };
    const sessionsSvc = optionalService3(ctx, "sessions");
    if (typeof sessionsSvc?.using === "function") return { ok: true, resumed: false };
    const controller = optionalService3(ctx, "sessionController");
    let resolveFailure;
    if (typeof controller?.resolveAgent === "function") {
      let returned;
      try {
        returned = await controller.resolveAgent(sessionId);
      } catch (error) {
        resolveFailure = tihuRemoteFailureOf(error, "resolveAgent \u629B\u9519");
      }
      if (resolveFailure === void 0) {
        const failure = tihuResolveAgentFailureOf(returned);
        if (failure !== void 0) {
          resolveFailure = failure;
        } else {
          const resolved = liveAgent();
          if (resolved !== void 0 && resolved !== null) {
            try {
              appendTihuLaneLog(sessionId, new Error(`\u627F\u63A5\u76EE\u6807\u7A7A\u95F2 \u2192 resolveAgent \u6302\u56DE\u6D3B\u52A8 agent\uFF08\u4F1A\u8BDD ${sessionId}\uFF09`), "append-resolve-agent-ok");
            } catch {
            }
            return { ok: true, resumed: true };
          }
          resolveFailure = { code: "session/not-live", message: "resolveAgent \u8BF4\u62FF\u5230\u4E86 agent\uFF0C\u4F46 ctx.agents \u8FD8\u67E5\u4E0D\u5230\u8FD9\u6761\u4F1A\u8BDD" };
        }
      }
    }
    if (typeof controller?.resume === "function") {
      let resumeFailure;
      try {
        await controller.resume(sessionId);
      } catch (error) {
        resumeFailure = tihuRemoteFailureOf(error, "resume \u629B\u9519");
      }
      const mounted = liveAgent();
      if (mounted !== void 0 && mounted !== null) {
        try {
          appendTihuLaneLog(sessionId, new Error(`\u627F\u63A5\u76EE\u6807\u7A7A\u95F2 \u2192 \u8001\u5BBF\u4E3B resume \u6302\u56DE\u6D3B\u52A8 agent\uFF08\u4F1A\u8BDD ${sessionId}\uFF09`), "append-resume-agent-ok");
        } catch {
        }
        return { ok: true, resumed: true };
      }
      if (resumeFailure === void 0 && mounted === void 0) {
        resumeFailure = { code: "session/not-live", message: resolveFailure === void 0 ? "resume \u4E4B\u540E\u4ECD\u7136\u6CA1\u6709\u6D3B\u52A8 agent" : "resume \u4E4B\u540E\u4ECD\u7136\u6CA1\u6709\u6D3B\u52A8 agent\uFF08resolveAgent \u5148\u5931\u8D25\uFF09" };
      }
      if (resumeFailure !== void 0) {
        const combined = resolveFailure === void 0 ? resumeFailure : { code: resumeFailure.code, message: `${resolveFailure.message}\uFF1B${resumeFailure.message}` };
        return { ok: false, resumed: false, error: tihuFailureError(combined, sessionId) };
      }
      return { ok: false, resumed: false, error: tihuFailureError({ code: "session/not-live", message: "resume \u4E4B\u540E ctx.agents \u4ECD\u67E5\u4E0D\u5230\u8FD9\u6761\u4F1A\u8BDD" }, sessionId) };
    }
    if (resolveFailure !== void 0) {
      try {
        appendTihuLaneLog(sessionId, new Error(`\u627F\u63A5\u76EE\u6807\u6302\u4E0D\u56DE\u6765\uFF1AresolveAgent\u5931\u8D25\uFF1A${resolveFailure.message}`), "append-resolve-agent-failed");
      } catch {
      }
      return { ok: false, resumed: false, error: tihuFailureError(resolveFailure, sessionId) };
    }
    if (controller === void 0) {
      return { ok: false, resumed: false, error: new Error(`\u5BBF\u4E3B\u6CA1\u6709 sessionController \u670D\u52A1\uFF0C\u65E0\u6CD5\u6062\u590D\u7A7A\u95F2\u4F1A\u8BDD ${sessionId.slice(0, 12)}\u2026\uFF08\u53EF\u6062\u590D\u5165\u53E3\uFF1AresolveAgent/resume\uFF09`) };
    }
    return { ok: false, resumed: false, error: new Error(`\u5BBF\u4E3B sessionController \u6CA1\u6709 resolveAgent \u4E5F\u6CA1\u6709 resume\uFF0C\u65E0\u6CD5\u6062\u590D\u7A7A\u95F2\u4F1A\u8BDD ${sessionId.slice(0, 12)}\u2026`) };
  }
  function rebindCommanderSession(previous, next) {
    if (previous === next) return;
    for (const device of devices) {
      if (device.sessionId !== previous) continue;
      device.sessionId = next;
      device.send("session.bound", {
        sessionId: next,
        title: titleForSession(next),
        project: projectNameOf(liveSessionOf(next)?.header?.cwd),
        live: true,
        preset: TASK_PRESET,
        computerUse: false
      });
    }
  }
  let commanderRebuilding;
  async function rebuildCommanderSession(failedSessionId) {
    if (commanderRebuilding !== void 0) return await commanderRebuilding;
    commanderRebuilding = (async () => {
      commanderSessionId = void 0;
      const rebuilt = await ensureCommanderSession({ fresh: true });
      if (rebuilt === void 0) return void 0;
      rebindCommanderSession(failedSessionId, rebuilt);
      log(`tihu commander rebuilt old=${failedSessionId} new=${rebuilt}`);
      return rebuilt;
    })();
    try {
      return await commanderRebuilding;
    } finally {
      commanderRebuilding = void 0;
    }
  }
  async function promptSession(sessionId, blocks) {
    const isCommander = sessionId === commanderSessionId;
    let last;
    for (let attempt = 0; attempt <= PROMPT_RETRY_DELAY_MS.length; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, PROMPT_RETRY_DELAY_MS[attempt - 1]);
        });
        if (disposed) return { ok: false, error: last?.error ?? new Error("\u9E48\u9E55\u5DF2\u5378\u8F7D"), fromUsing: false };
      }
      const result = await promptOnce(sessionId, blocks);
      if (result.ok) return result;
      last = result;
      const failure = result.error ?? new Error("\u6295\u9012\u5931\u8D25");
      appendTihuLaneLog(sessionId, failure, `attempt=${attempt + 1}/${PROMPT_RETRY_DELAY_MS.length + 1}`);
      log(`tihu prompt session=${sessionId} attempt=${attempt + 1} failed: ${failure?.message ?? String(failure)}`);
      if (result.fromUsing !== true) break;
    }
    if (!isCommander || disposed) {
      return { ok: false, error: last?.error ?? new Error("\u6295\u9012\u5931\u8D25"), fromUsing: false };
    }
    const rebuilt = await rebuildCommanderSession(sessionId);
    if (rebuilt === void 0) {
      log(`tihu commander rebuild failed old=${sessionId}`);
      return { ok: false, error: last?.error ?? new Error("\u6307\u6325\u4F1A\u8BDD\u91CD\u5EFA\u5931\u8D25"), fromUsing: false };
    }
    const retried = await promptOnce(rebuilt, blocks);
    if (retried.ok) {
      log(`tihu commander retry ok old=${sessionId} new=${rebuilt}`);
      return retried;
    }
    appendTihuLaneLog(rebuilt, retried.error, "attempt=rebuild");
    log(`tihu commander retry failed session=${rebuilt}: ${retried.error?.message ?? String(retried.error)}`);
    return { ok: false, error: retried.error, fromUsing: retried.fromUsing };
  }
  const commanderModelApplied = /* @__PURE__ */ new Set();
  async function ensureCommanderModel(sessionId) {
    if (commanderModelApplied.has(sessionId)) return;
    commanderModelApplied.add(sessionId);
    await applyTihuModel(sessionId, "background", "\u6307\u6325\u53F0");
  }
  async function ensureCommanderSession(options2 = {}) {
    if (options2.fresh !== true && commanderSessionId !== void 0) {
      const found = await findSession(commanderSessionId);
      if (found.status !== "missing") {
        await ensureCommanderModel(commanderSessionId);
        return commanderSessionId;
      }
      commanderSessionId = void 0;
    }
    if (options2.fresh === true) commanderSessionId = void 0;
    if (options2.fresh !== true) {
      let rows = [];
      try {
        rows = (await collectSessionRows()).rows;
      } catch {
        rows = [];
      }
      const existing = rows.find((row) => String(row.title ?? "").includes(COMMANDER_TITLE));
      if (existing !== void 0) {
        commanderSessionId = existing.sessionId;
        log(`tihu commander reused session=${existing.sessionId}`);
        await ensureCommanderModel(commanderSessionId);
        return commanderSessionId;
      }
    }
    const created = await createSessionAt(assistantFolder(), TASK_PRESET);
    if (created === void 0) return void 0;
    await ensureCommanderModel(created);
    commanderSessionId = created;
    const titled = await titleSession(created, COMMANDER_TITLE);
    log(`tihu commander created session=${created}${titled ? " titled" : " (title not set)"}`);
    return created;
  }
  function resolveTaskFolder(card) {
    const folder = String(card.folder ?? "").trim();
    return folder !== "" ? folder : assistantFolder();
  }
  function folderKeyOf(folder) {
    return String(folder ?? "").trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  }
  function sameProjectFolder(base, child) {
    const left = folderKeyOf(base);
    const right = folderKeyOf(child);
    if (left === "" || right === "") return false;
    return right === left || right.startsWith(`${left}\\`);
  }
  function continuityHintsOf(card, folder) {
    const hints = [String(card.name ?? "").trim(), folderBase2(folder)];
    return hints.filter((hint, index) => [...hint].length >= 2 && hints.indexOf(hint) === index);
  }
  function previousDispatchTask() {
    let best;
    for (const task of tasks.list()) {
      if (task.source === "pc") continue;
      if (task.state === "archived") continue;
      if (task.sessionIds.every((sessionId) => sessionId === "")) continue;
      if (best === void 0 || task.updatedAt >= best.updatedAt) best = task;
    }
    return best;
  }
  function previousSessionOf(task) {
    const sessionId = [...task.sessionIds].reverse().find((id) => id !== "");
    if (sessionId === void 0) return void 0;
    const title = humanTitle(task.title);
    const summary = String(task.resultLine || task.doneText || task.summary || "").slice(0, 160);
    return {
      sessionId,
      title: title !== "" ? title : String(task.title ?? ""),
      ...summary === "" ? {} : { summary },
      updatedAt: task.updatedAt
    };
  }
  async function followPreviousDispatch(device, text, skipProjectId) {
    const previous = previousDispatchTask();
    if (previous === void 0) return void 0;
    if (skipProjectId !== void 0 && previous.projectId === skipProjectId) return void 0;
    const session = previousSessionOf(previous);
    if (session === void 0) return void 0;
    const card = {
      id: previous.projectId,
      name: previous.projectName,
      ...previous.folder === void 0 || previous.folder === "" ? {} : { folder: previous.folder }
    };
    const folder = resolveTaskFolder(card);
    const hint = previousSessionFollowUpOf({
      text,
      previous: session,
      now: Date.now(),
      projectHints: continuityHintsOf(card, folder)
    });
    if (hint === void 0 || !hint.follow) {
      if (hint !== void 0) log(`tihu previous-follow skipped project=${card.id} score=${hint.confidence.toFixed(2)} ${hint.detail}`);
      return void 0;
    }
    log(`tihu previous-follow append project=${card.id} session=${session.sessionId} score=${hint.confidence.toFixed(2)} ${hint.detail}`);
    const appendMeta = { via: "previous", continuity: "append", confidence: hint.confidence, clarify: "no" };
    const task = await appendToSession(
      device,
      text,
      card,
      { sessionId: session.sessionId, ...session.title === "" ? {} : { title: session.title } },
      appendMeta
    );
    if (task === void 0) {
      return { message: appendMeta.failureShown === true ? "\u5DF2\u8BB0\u4E0B\uFF1A\u5BBF\u4E3B\u6CA1\u5EFA\u8D77\u4F1A\u8BDD\uFF08\u4E0D\u7528\u91CD\u8BF4\uFF09\u3002" : "\u9519\u8BEF\uFF1A\u90A3\u6761\u4F1A\u8BDD\u6CA1\u63A5\u4F4F\u8FD9\u53E5\u8BDD\u3002" };
    }
    if (!task.sessionIds.includes(session.sessionId)) {
      return { task, message: `\u90A3\u6761\u4F1A\u8BDD\u63A5\u4E0D\u4F4F\uFF0C\u5DF2\u5728\u300C${task.projectName}\u300D\u65B0\u5EFA\u4F1A\u8BDD\u6D3E\u51FA\uFF1A${task.title}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF09` };
    }
    return { task, message: `\u5DF2\u63A5\u7740\u300C${task.projectName}\u300D\u539F\u6709\u4F1A\u8BDD\u6D3E\u51FA\uFF1A${task.title}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF09` };
  }
  function weakProjectHitOf(route) {
    if (route.kind !== "card") return void 0;
    if (isConfidentProjectRoute(route)) return void 0;
    return { card: route.card, confidence: route.confidence, via: route.via ?? "fragment" };
  }
  async function projectCuSessionsOf(card) {
    let rows = [];
    try {
      rows = (await collectSessionRows()).rows;
    } catch {
      rows = [];
    }
    const folder = resolveTaskFolder(card);
    const now = Date.now();
    const candidates = [];
    for (const row of rows) {
      if (row.sessionId === commanderSessionId) continue;
      if (!isComputerUsePreset(row.preset)) continue;
      if (!sameProjectFolder(folder, row.cwd)) continue;
      if (!(row.updatedAt > 0) || now - row.updatedAt > CONTINUITY_WINDOW_MS) continue;
      const task = tasks.ofSession(row.sessionId);
      const title = humanTitle(String(task?.title ?? row.title ?? ""));
      const summary = String(task?.summary || task?.resultLine || task?.doneText || "").slice(0, 160);
      candidates.push({
        sessionId: row.sessionId,
        title: title !== "" ? title : String(row.title ?? ""),
        ...summary === "" ? {} : { summary },
        updatedAt: row.updatedAt
      });
    }
    return continuityCandidatesOf(candidates);
  }
  function findContinuityTarget(candidates, ref) {
    const key = String(ref ?? "").trim();
    if (key === "") return void 0;
    const shortOf = (sessionId) => sessionId.replace(/^session-/, "").slice(0, 8).toLowerCase();
    const lower = key.toLowerCase();
    return candidates.find((item) => item.sessionId === key) ?? candidates.find((item) => shortOf(item.sessionId) === shortOf(key) || shortOf(item.sessionId) === lower) ?? candidates.find((item) => item.title === key) ?? candidates.find((item) => item.title.toLowerCase().includes(lower));
  }
  function logDispatchDecision(projectName, sessionId, meta) {
    const confidence = meta.confidence === void 0 ? "-" : meta.confidence.toFixed(2);
    const message = `\u6D3E\u5355\u51B3\u7B56 \u9879\u76EE=${projectName} \u547D\u4E2D=${meta.via} \u4F1A\u8BDD=${sessionId === void 0 || sessionId === "" ? "\u65B0\u5EFA" : sessionId} \u8854\u63A5=${meta.continuity} \u7F6E\u4FE1=${confidence} \u6F84\u6E05=${meta.clarify}`;
    try {
      appendTihuLaneLog(sessionId === void 0 || sessionId === "" ? "-" : sessionId, new Error(message), "dispatch-decision");
    } catch {
    }
    log(`tihu ${message}`);
  }
  function appendTailOf(card, folder) {
    return `\u3010\u7EED\u804A \xB7 \u9E48\u9E55\u3011\u8FD9\u4E00\u53E5\u662F\u63A5\u7740\u672C\u6761\u4F1A\u8BDD\u524D\u9762\u7684\u4E8B\u7EE7\u7EED\u505A\uFF08\u9879\u76EE\u300C${card.name}\u300D\uFF0C\u5DE5\u4F5C\u76EE\u5F55 ${folder} \u4E0D\u53D8\uFF09\u3002\u5728\u5DF2\u6709\u8FDB\u5C55\u4E0A\u589E\u91CF\u4FEE\u6539\uFF0C\u522B\u4ECE\u5934\u518D\u6765\uFF0C\u4E5F\u522B\u52A8\u524D\u9762\u5DF2\u7ECF\u786E\u8BA4\u8FC7\u7684\u90E8\u5206\u3002\u505A\u5B8C\u540E\u7528\u7B80\u6D01\u4E2D\u6587\u8BF4\u660E\u7ED3\u679C\uFF1A\u5148\u7ED9\u7ED3\u8BBA\uFF0C\u518D\u7ED9\u5173\u952E\u6570\u5B57\u6216\u8FDB\u5C55\uFF0C\u6587\u5B57\u4E0D\u8981\u592A\u957F\uFF0C\u786E\u5B9E\u9700\u8981\u957F\u6587\u672C\u7684\u60C5\u51B5\u9664\u5916\uFF08\u4F8B\u5982\u7528\u6237\u660E\u786E\u8981\u6C42\u5168\u6587\u6717\u8BFB\u3001\u5B8C\u6574\u6E05\u5355\uFF09\uFF0C\u9002\u5408\u76F4\u63A5\u6717\u8BFB\uFF1B\u4E0D\u8981\u8868\u683C\u3001\u5217\u8868\u3001\u4EE3\u7801\u5757\u6216\u957F\u8DEF\u5F84\u3002`;
  }
  function doingOf(projectId) {
    const active = tasks.list().filter((task) => task.projectId === projectId && task.state !== "archived" && task.state !== "done").sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (active === void 0) return "";
    if (active.state === "awaiting") return "\u5728\u7B49\u4F60\u7B54\u4E00\u53E5";
    if (active.step > 0) return `\u5728\u8DD1\u7B2C ${active.step} \u6B65`;
    return "\u5728\u8DD1";
  }
  function externalTitleOf(row) {
    const raw = String(row.title ?? "").trim();
    return taskTitleOf(humanTitle(raw !== "" ? raw : titleForSession(row.sessionId)));
  }
  function archivePcTask(taskId, now, why) {
    pcTaskOfSession.forEach((value, sessionId) => {
      if (value === taskId) pcTaskOfSession.delete(sessionId);
    });
    if (tasks.get(taskId)?.state === "archived") return false;
    const line = tasks.archive(taskId, now);
    if (line !== void 0) appendTaskJournal(line);
    for (const device of devices) {
      if (device.focusedTask !== taskId) continue;
      sendBoard(device);
    }
    refreshBoards();
    log(`tihu pc task archive task=${taskId} why=${why}`);
    return true;
  }
  async function syncExternalSessions() {
    if (disposed || pcSyncing) return;
    pcSyncing = true;
    try {
      let rows;
      try {
        rows = (await collectSessionRows()).rows;
      } catch (error) {
        log(`tihu pc sync list failed: ${error?.message ?? String(error)}`);
        return;
      }
      if (disposed) return;
      const now = Date.now();
      const agents = liveAgentList();
      const bound = /* @__PURE__ */ new Set();
      for (const task of tasks.list()) {
        if (task.source === "pc") continue;
        for (const sessionId of task.sessionIds) bound.add(sessionId);
      }
      const wanted = /* @__PURE__ */ new Map();
      for (const row of rows) {
        if (wanted.size >= PC_SESSION_MAX) break;
        const sessionId = row.sessionId;
        if (sessionId === "") continue;
        if (sessionId === commanderSessionId) continue;
        if (bound.has(sessionId)) continue;
        if (!isComputerUsePreset(row.preset)) continue;
        const known = pcTaskOfSession.get(sessionId);
        const createdAt = Number(row.createdAt) || 0;
        const updatedAt = Number(row.updatedAt) || 0;
        const agentRunning = runningSessions.has(sessionId);
        const activity = Math.max(updatedAt, pcActivityAt.get(sessionId) ?? 0);
        const blank = activity <= createdAt && lastAssistant.get(sessionId) === void 0;
        if (!agentRunning && (activity <= 0 || now - activity > PC_SESSION_WINDOW_MS)) continue;
        if (blank && now - createdAt > PC_QUEUED_WINDOW_MS) continue;
        if (known === void 0) {
          const dismissed = pcDismissedAt.get(sessionId);
          if (dismissed !== void 0 && activity <= dismissed) continue;
        }
        const endedAt = turnEndedAt.get(sessionId) ?? 0;
        const turnOver = endedAt > 0 && (updatedAt <= 0 || endedAt >= updatedAt);
        const running = agentRunning || !turnOver && now - activity <= PC_ACTIVE_WINDOW_MS;
        const stillRunning = !running && !turnOver && known !== void 0 && known !== "" && tasks.get(known ?? "")?.state === "running" && now - activity <= PC_RUNNING_STILL_MS;
        const childRunning = runningSubagentCountOf(sessionId, agents);
        const state = blank ? "queued" : running || stillRunning || childRunning > 0 ? "running" : "done";
        const start = updatedAt > 0 ? updatedAt : activity > 0 ? activity : createdAt || now;
        wanted.set(sessionId, { row, state, activity: activity > 0 ? activity : createdAt || now, start, childRunning });
      }
      let changed = false;
      const trustList = rows.length > 0;
      for (const [sessionId, taskId] of [...pcTaskOfSession]) {
        if (wanted.has(sessionId)) continue;
        if (!trustList) continue;
        const row = rows.find((item) => item.sessionId === sessionId);
        const why = row === void 0 ? "session gone" : `preset=${row.preset || "?"}`;
        if (archivePcTask(taskId, now, why)) changed = true;
      }
      for (const [sessionId, item] of wanted) {
        const title = externalTitleOf(item.row);
        const projectName = externalProjectNameOf(item.row.cwd) || "\u7535\u8111\u7AEF";
        const existingId = pcTaskOfSession.get(sessionId);
        if (existingId === void 0) {
          const task = tasks.add({
            title,
            projectId: `pc:${sessionId}`,
            projectName,
            ...item.row.cwd === void 0 ? {} : { folder: item.row.cwd },
            preset: item.row.preset,
            sessionIds: [sessionId],
            source: "pc",
            state: item.state,
            startedAt: item.start,
            now
          });
          pcTaskOfSession.set(sessionId, task.taskId);
          tasks.setChildRunning(task.taskId, item.childRunning, now);
          if (item.state === "running") noteRunAnchor(task.taskId, pcStartAnchorOf(sessionId, item.start));
          changed = true;
          log(`tihu pc task add task=${task.taskId} session=${sessionId} state=${item.state} children=${item.childRunning} title=${JSON.stringify(task.title)}`);
          continue;
        }
        if (tasks.setChildRunning(existingId, item.childRunning, now)) changed = true;
        if (tasks.get(existingId)?.state === "awaiting") continue;
        const summary = item.state === "done" ? plainSummaryOf(lastAssistant.get(sessionId)?.text ?? "") : "";
        if (tasks.syncExternal(existingId, {
          title,
          projectName,
          ...item.row.cwd === void 0 ? {} : { folder: item.row.cwd },
          state: item.state,
          // 锚点＝这轮真正开始的时刻（列表投影里的 lastPromptAt），不是「此刻」：
          // 用此刻就会让「已用」在每次轮询归零（实机那条「已用 0s 永远不动」）。
          startedAt: pcStartAnchorOf(sessionId, item.start),
          at: now,
          ...summary === "" ? {} : { summary }
        })) changed = true;
      }
      if (changed) refreshBoards();
      reconcileChildTasks("pc-sync");
    } finally {
      pcSyncing = false;
    }
  }
  function ensurePcSync() {
    if (disposed || pcSyncTimer !== void 0) return;
    const timer = setInterval(() => {
      void syncExternalSessions().catch((error) => log(`tihu pc sync failed: ${error?.message ?? String(error)}`));
    }, tihuPcSyncMs());
    timer.unref?.();
    pcSyncTimer = timer;
  }
  function stopPcSync() {
    if (pcSyncTimer !== void 0) {
      clearInterval(pcSyncTimer);
      pcSyncTimer = void 0;
    }
  }
  async function openExternalTask(device, task) {
    if (device.receiptTimer !== void 0) {
      clearTimeout(device.receiptTimer);
      device.receiptTimer = void 0;
    }
    disarmAutoHome(device);
    device.pendingPick = void 0;
    device.focusedTask = task.taskId;
    device.onBoard = false;
    progressEventAt.set(task.taskId, Date.now());
    const frame = taskDetailFrameOf(task) ?? noticeFrame({ stage: "\u7535\u8111\u7AEF", title: task.title, lines: ["\u8FD9\u6761\u4F1A\u8BDD\u8FD8\u6CA1\u5F00\u59CB\u8DD1"], tone: "idle" });
    sendFrame(device, frame, device.sessionId);
    armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, "\u8FDB\u5EA6");
    ensureDetailTicker();
    device.send("event.progress", {
      stage: "\u7535\u8111\u7AEF",
      text: `\u7535\u8111\u7AEF\u4F1A\u8BDD\uFF1A${task.title}\uFF1B\u70B9/\u8BF4\u300C\u56DE\u68CB\u76D8\u300D\u53EF\u56DE\u6765`
    });
    log(`tihu pc open task=${task.taskId} session=${task.sessionIds[0] ?? "-"}`);
  }
  function dismissExternalTask(task) {
    for (const [sessionId, taskId] of [...pcTaskOfSession]) {
      if (taskId !== task.taskId) continue;
      pcDismissedAt.set(sessionId, Date.now());
      pcTaskOfSession.delete(sessionId);
    }
  }
  let boardTicker;
  function boardFrameFor(page) {
    const board = boardOf(tasks.list(), Date.now(), page);
    return { frame: boardFrame(board), board };
  }
  function sendBoard(device, resetPage = false) {
    const key = device.sessionId ?? device.id;
    const { frame, board } = boardFrameFor(resetPage ? 0 : Math.max(0, Math.trunc(device.boardPage ?? 0)));
    device.boardPage = board.page.index;
    if (device.receiptTimer !== void 0) {
      clearTimeout(device.receiptTimer);
      device.receiptTimer = void 0;
    }
    disarmAutoHome(device);
    device.pendingPick = void 0;
    device.focusedTask = void 0;
    device.onBoard = true;
    device.followUntil = void 0;
    device.doneReadingTask = void 0;
    lastFrames.set(key, frame);
    pushFrame(device, frame);
    device.send("task.list", { board });
    log(`tihu board device=${device.id} rows=${board.rows.length} page=${board.page.index + 1}/${board.page.total} awaiting=${board.counts.awaiting} running=${board.counts.running} queued=${board.counts.queued} done=${board.counts.done}`);
    device.boardHasRunning = board.rows.some((row) => row.state === "running");
    ensureBoardTicker();
  }
  function ensureBoardTicker() {
    if (boardTicker !== void 0) return;
    boardTicker = setInterval(() => {
      const stillRunning = [...devices].some((device) => device.unified && device.onBoard === true && device.focusedTask === void 0 && device.boardHasRunning === true);
      if (!stillRunning) {
        clearInterval(boardTicker);
        boardTicker = void 0;
        return;
      }
      refreshBoards();
    }, BOARD_TICK_MS);
    boardTicker.unref?.();
  }
  function refreshBoards() {
    for (const device of devices) {
      if (!device.unified) continue;
      if (device.focusedTask !== void 0) continue;
      if (device.onBoard !== true) continue;
      sendBoard(device);
    }
  }
  function broadcastBoardSnapshot() {
    const board = boardOf(tasks.list(), Date.now());
    for (const device of devices) {
      if (device.unified) device.send("task.list", { board });
    }
  }
  function followRunningTask(task) {
    if (task.source !== "pc") return;
    if (!taskRunningNow(task)) {
      log(`tihu follow skipped task=${task.taskId} state=${task.state}`);
      return;
    }
    for (const device of devices) {
      if (!device.unified) continue;
      if (device.receiptTimer !== void 0 || device.pendingPick !== void 0) continue;
      if (device.pendingVoice !== void 0) continue;
      const frame = taskDetailFrameOf(task);
      if (frame === void 0) continue;
      disarmAutoHome(device);
      device.focusedTask = task.taskId;
      device.onBoard = false;
      progressEventAt.set(task.taskId, Date.now());
      sendFrame(device, frame, device.sessionId);
      armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, "\u8FDB\u5EA6");
      ensureDetailTicker();
      log(`tihu follow task=${task.taskId} device=${device.id}`);
    }
  }
  function taskRunningNow(task) {
    if (task.state !== "running") return false;
    if ((task.childRunning ?? 0) > 0) return true;
    const sessionId = task.sessionIds[task.sessionIds.length - 1];
    return sessionId !== void 0 && runningSessions.has(sessionId);
  }
  function pendingDeviceOnline() {
    for (const device of devices) if (device.unified) return true;
    return false;
  }
  function activeUnifiedDevice() {
    let best;
    let bestAt = -1;
    for (const device of devices) {
      if (!device.unified) continue;
      const at = device.lastSeenAt ?? device.connectedAt ?? 0;
      if (at > bestAt) {
        best = device;
        bestAt = at;
      }
    }
    return best;
  }
  function decisionTimeoutLabel(ms) {
    const seconds = Math.round(ms / 1e3);
    return seconds >= 1 ? `\u8BBE\u5907 ${seconds} \u79D2\u8D85\u65F6` : "\u8BBE\u5907\u8D85\u65F6";
  }
  function leaveDecisionScreens(taskId, exceptDeviceId) {
    for (const device of devices) {
      if (!device.unified) continue;
      if (exceptDeviceId !== void 0 && device.id === exceptDeviceId) continue;
      if (device.focusedTask !== taskId) continue;
      if (device.screenStage !== "\u5F85\u51B3\u7B56") continue;
      disarmAutoHome(device);
      sendBoard(device);
    }
  }
  function announcePendingDecision(task, reveal) {
    const question = String(task.question ?? "").trim();
    const text = `\u5728\u7B49\u4F60\u5B9A\uFF1A${question === "" ? "\u4E00\u6761\u786E\u8BA4" : question}`;
    for (const device of devices) {
      if (!device.unified) continue;
      device.send("task.notify", { level: 2, taskId: task.taskId, text, spoken: false });
    }
    refreshBoards();
    reveal();
    pendingLog(`tihu decision ask task=${task.taskId} session=${task.sessionIds[0] ?? "-"} question=${JSON.stringify(task.question ?? "")} options=${JSON.stringify(task.options ?? [])} default=${String(task.defaultIndex ?? 0)}`);
  }
  function holdPendingDecision(decision, task, request, next) {
    return new Promise((resolve, reject) => {
      const timeoutMs = tihuDecisionTimeoutMs();
      const shownOn = /* @__PURE__ */ new Set();
      const reveal = () => {
        if (bridge.settled || disposed) return;
        for (const device of devices) {
          if (!device.unified) continue;
          if (shownOn.has(device.id)) continue;
          if (device.receiptTimer !== void 0 || device.pendingPick !== void 0 || device.pendingVoice !== void 0) continue;
          if (device.screenStage === "\u5F85\u51B3\u7B56" && device.focusedTask !== task.taskId) continue;
          const from = device.onBoard === true ? "board" : device.focusedTask === void 0 ? "idle" : `task:${device.focusedTask}`;
          showDecision(device, task);
          shownOn.add(device.id);
          pendingLog(`tihu decision show task=${task.taskId} device=${device.id} from=${from}`);
        }
      };
      const previous = pendingBridges.get(task.taskId);
      if (previous !== void 0) previous.settle(previous.decision.defaultIndex, "\u88AB\u65B0\u95EE\u9898\u9876\u66FF");
      const bridge = {
        taskId: task.taskId,
        sessionId: decision.sessionId,
        decision,
        settled: false,
        timer: void 0,
        watch: void 0,
        onAbort: void 0,
        settle(index, by) {
          if (bridge.settled) return;
          bridge.settled = true;
          clearPendingBridge(bridge);
          tasks.answer(task.taskId, by, Date.now());
          leaveDecisionScreens(task.taskId);
          refreshBoards();
          pendingLog(`tihu decision answer task=${task.taskId} by=${by} index=${String(index)} option=${JSON.stringify(decision.options[index] ?? "")}`);
          resolve(decision.answerOf(index));
        },
        delegate(by) {
          if (bridge.settled) return;
          bridge.settled = true;
          clearPendingBridge(bridge);
          pendingLog(`tihu decision delegate task=${task.taskId} why=${by}`);
          void Promise.resolve().then(() => next()).then(
            (value) => {
              tasks.answer(task.taskId, "\u7535\u8111\u7AEF\u4F5C\u7B54", Date.now());
              leaveDecisionScreens(task.taskId);
              refreshBoards();
              resolve(value);
            },
            (error) => {
              tasks.answer(task.taskId, "\u7535\u8111\u7AEF\u4F5C\u7B54", Date.now());
              leaveDecisionScreens(task.taskId);
              refreshBoards();
              reject(error);
            }
          );
        }
      };
      pendingBridges.set(task.taskId, bridge);
      tasks.ask(task.taskId, {
        question: decision.question,
        options: decision.options,
        defaultIndex: decision.defaultIndex,
        ...decision.detail === void 0 ? {} : { detail: decision.detail },
        timeoutMs
      });
      announcePendingDecision(task, reveal);
      const timer = setTimeout(() => bridge.settle(decision.defaultIndex, decisionTimeoutLabel(timeoutMs)), timeoutMs);
      bridge.timer = timer;
      const watch = setInterval(() => {
        if (disposed) return;
        if (!pendingDeviceOnline()) {
          bridge.delegate("\u8BBE\u5907\u5DF2\u79BB\u7EBF");
          return;
        }
        reveal();
      }, PENDING_OFFLINE_CHECK_MS);
      watch.unref?.();
      bridge.watch = watch;
      const signal = request?.signal;
      if (signal !== null && typeof signal === "object" && typeof signal.addEventListener === "function") {
        const onAbort = () => {
          if (bridge.settled) return;
          bridge.settled = true;
          clearPendingBridge(bridge);
          tasks.answer(task.taskId, "\u8BF7\u6C42\u5DF2\u53D6\u6D88", Date.now());
          leaveDecisionScreens(task.taskId);
          refreshBoards();
          pendingLog(`tihu decision abort task=${task.taskId}`);
          resolve(decision.answerOf(decision.defaultIndex));
        };
        bridge.onAbort = onAbort;
        bridge.signal = signal;
        try {
          signal.addEventListener("abort", onAbort, { once: true });
        } catch {
        }
      }
    });
  }
  function clearPendingBridge(bridge) {
    if (bridge.timer !== void 0) clearTimeout(bridge.timer);
    bridge.timer = void 0;
    if (bridge.watch !== void 0) clearInterval(bridge.watch);
    bridge.watch = void 0;
    if (pendingBridges.get(bridge.taskId) === bridge) pendingBridges.delete(bridge.taskId);
    const signal = bridge.signal;
    if (signal !== void 0 && bridge.onAbort !== void 0) {
      try {
        signal.removeEventListener("abort", bridge.onAbort);
      } catch {
      }
    }
    bridge.onAbort = void 0;
  }
  function answerPendingDecision(taskId, index, by) {
    const bridge = pendingBridges.get(taskId);
    if (bridge === void 0) return false;
    bridge.settle(index, by);
    return true;
  }
  function settlePendingDecisionDefault(taskId, by) {
    const bridge = pendingBridges.get(taskId);
    if (bridge === void 0) return false;
    bridge.settle(bridge.decision.defaultIndex, by);
    return true;
  }
  async function handlePendingInteraction(kind, request, next) {
    try {
      const decision = kind === "approval" ? approvalDecisionOf(request) : questionDecisionOf(request);
      if (decision === null) {
        pendingLog(`tihu decision skip kind=${kind} session=${sessionIdOfPendingRequest(request)} why=no-request`);
        return await next();
      }
      const task = tasks.ofSession(decision.sessionId);
      if (task === void 0 || task.state === "archived") {
        pendingLog(`tihu decision skip session=${decision.sessionId} kind=${kind} why=no-task`);
        return await next();
      }
      if (tuoguanOnForSession(decision.sessionId, ctx)) {
        pendingLog(`tihu decision skip task=${task.taskId} kind=${kind} why=tuoguan`);
        return await next();
      }
      if (!pendingDeviceOnline()) {
        pendingLog(`tihu decision skip task=${task.taskId} kind=${kind} why=no-device`);
        return await next();
      }
      return await holdPendingDecision(decision, task, request, next);
    } catch (error) {
      pendingLog(`tihu decision failed kind=${kind} session=${sessionIdOfPendingRequest(request)}: ${error?.stack ?? String(error)}`);
      return await next();
    }
  }
  function registerPendingWaterfall(kind, event) {
    try {
      if (typeof ctx?.on !== "function") throw new Error("\u5BBF\u4E3B\u6CA1\u6709 ctx.on\uFF08\u4E8B\u4EF6\u603B\u7EBF\u4E0D\u53EF\u7528\uFF09");
      const off = ctx.on(event, (request, next) => handlePendingInteraction(kind, request, next), { prepend: true });
      if (typeof off !== "function") throw new Error("ctx.on \u6CA1\u6709\u8FD4\u56DE\u5378\u8F7D\u51FD\u6570\uFF08\u63A5\u53E3\u53D8\u4E86\uFF1F\uFF09");
      pendingLog(`tihu pending waterfall ready ${event} kind=${kind} prepend=1`);
      return off;
    } catch (error) {
      pendingLog(`tihu pending waterfall \u6302\u4E0D\u4E0A ${event} kind=${kind}: ${error?.message ?? String(error)}`);
      return void 0;
    }
  }
  function leaveStaleProgress(task, why) {
    for (const device of devices) {
      if (!device.unified) continue;
      if (device.focusedTask !== task.taskId) continue;
      if (device.screenStage !== "\u8FDB\u5EA6") continue;
      if (device.receiptTimer !== void 0 || device.pendingPick !== void 0) continue;
      if (device.followUntil === "done" && task.state === "running") continue;
      log(`tihu progress leave device=${device.id} task=${task.taskId} why=${why}`);
      sendBoard(device);
    }
  }
  function disarmAutoHome(device) {
    if (device.homeTimer !== void 0) clearTimeout(device.homeTimer);
    device.homeTimer = void 0;
    device.homeTask = void 0;
  }
  function armScreenHome(device, waitMs, taskId, expectStage) {
    disarmAutoHome(device);
    device.homeTask = taskId;
    const wait = Math.max(0, Math.round(Number(waitMs) || 0));
    const timer = setTimeout(() => {
      device.homeTimer = void 0;
      if (!devices.has(device)) return;
      if (device.onBoard === true) return;
      if (device.homeTask !== taskId) return;
      if (taskId !== void 0 && device.focusedTask !== taskId) return;
      if (expectStage !== void 0 && device.screenStage !== expectStage) return;
      device.homeTask = void 0;
      log(`tihu auto home device=${device.id} task=${taskId ?? "-"} stage=${expectStage ?? "-"}`);
      sendBoard(device);
    }, wait);
    timer.unref?.();
    device.homeTimer = timer;
    log(`tihu auto home armed device=${device.id} after=${wait}ms stage=${expectStage ?? "-"}`);
  }
  function armAutoHome(device, spokenMs, taskId) {
    armScreenHome(device, Math.max(0, Math.round(Number(spokenMs) || 0)) + HOME_AFTER_SPEECH_MS, taskId);
  }
  function sendTaskUpdate(device, task) {
    if (!device.unified) return;
    const board = boardOf([task], Date.now());
    const row = board.rows[0];
    if (row === void 0) return;
    device.send("task.update", {
      taskId: task.taskId,
      state: row.state,
      capsule: row.capsule,
      sub: row.sub,
      ring: row.ring,
      ...task.summary === "" ? {} : { summary: task.summary }
    });
  }
  function pushTaskNotify(task, level, text) {
    const taskId = task?.taskId ?? "";
    notifyBus.push(level, taskId, text);
    if (level === 0) {
      announceHoldUntil = 0;
    } else if ((level === 1 || level === 2) && announceHoldUntil === 0 && tasks.list().some((item) => item.taskId !== taskId && (item.state === "running" || item.state === "queued" || item.state === "awaiting"))) {
      announceHoldUntil = Date.now() + ANNOUNCE_WINDOW_MS;
    }
    for (const device of devices) {
      if (!device.unified) continue;
      device.send("task.notify", { level, taskId, text, ...taskId === "" ? {} : { bubbleId: taskId }, spoken: false });
    }
    scheduleAnnounce();
  }
  function scheduleAnnounce() {
    if (disposed) return;
    if (announceTimer !== void 0) {
      clearTimeout(announceTimer);
      announceTimer = void 0;
    }
    const next = notifyBus.nextAt();
    if (next === void 0) return;
    const at = Math.max(next, announceHoldUntil);
    announceTimer = setTimeout(() => {
      announceTimer = void 0;
      try {
        flushAnnounce();
      } catch (error) {
        log(`tihu announce failed: ${error?.stack ?? String(error)}`);
      }
    }, Math.max(0, at - Date.now()));
    announceTimer.unref?.();
  }
  function flushAnnounce() {
    const item = notifyBus.take();
    if (item === void 0) {
      scheduleAnnounce();
      return;
    }
    announceHoldUntil = 0;
    for (const taskId of item.taskIds) if (taskId !== "") tasks.markSpoken(taskId);
    for (const device of devices) {
      if (!device.unified) continue;
      if (item.level === 0) {
        try {
          device.cancelRound?.();
        } catch {
        }
      }
      const alreadyRead = item.taskIds.some((taskId) => taskId !== "" && taskId === device.doneReadingTask);
      device.send("task.notify", {
        level: item.level,
        taskId: item.taskIds[0] ?? "",
        text: item.text,
        spoken: !alreadyRead
      });
      if (alreadyRead) {
        log(`tihu announce skipped device=${device.id} task=${device.doneReadingTask}\uFF08\u5B8C\u6210\u9875\u6574\u6BB5\u6B63\u6587\u5728\u5FF5\uFF0C\u4E0D\u91CD\u590D\u5FF5\u6807\u9898\uFF09`);
        continue;
      }
      void speakAnnouncement(device, item.text).then((spokenMs) => {
        if (spokenMs >= 0) armAutoHome(device, spokenMs, item.taskIds[0] || void 0);
      }).catch((error) => log(`tihu announce speak failed: ${error?.message ?? String(error)}`));
    }
    log(`tihu announce level=${item.level} tasks=${item.taskIds.join(",")} text=${JSON.stringify(item.text)}`);
    scheduleAnnounce();
  }
  async function speakAnnouncement(device, text) {
    const key = device.sessionId ?? "__unbound__";
    const segments = splitSpeechSegments(text).map((segment) => ({ ...segment, text: toSpeechText(segment.text) })).filter((segment) => segment.text !== "");
    if (segments.length === 0) return -1;
    if (announcing.has(device.id)) return -1;
    const epoch = device.speakEpoch = (device.speakEpoch ?? 0) + 1;
    announcing.add(device.id);
    const stale = () => device.speakEpoch !== epoch;
    let spokenMs = 0;
    const cacheable = segments.length === 1;
    const sendPcm = (pcm, segment, final = true) => {
      device.send("tts.audio", {
        seq: 0,
        total: 1,
        sampleRate: 24e3,
        channels: 1,
        format: "pcm16",
        data: pcm.toString("base64"),
        index: segment.index,
        text: segment.text,
        charStart: segment.start,
        charEnd: segment.end,
        ...final ? { final: true } : {}
      });
    };
    try {
      if (cacheable) {
        const cached = preroll.get(device.voice, segments[0].text);
        if (cached !== void 0) {
          sendPcm(cached, segments[0]);
          log(`tihu announce preroll hit chars=${[...segments[0].text].length} audio=${prerollAudioMs(cached.length)}ms`);
          return prerollAudioMs(cached.length);
        }
      }
      if (!tts.available()) {
        try {
          await tts.ensureServer();
        } catch {
        }
      }
      const status = tts.status();
      if (!status.available) {
        device.send("event.alert", { level: "error", text: `\u672C\u6B21\u65E0\u8BED\u97F3\uFF1A${status.error ?? "\u672C\u5730\u5F15\u64CE\u672A\u5C31\u7EEA"}\uFF08\u4EFB\u52A1\u7ED3\u679C\u5DF2\u4E0A\u5C4F\uFF09` });
        return 0;
      }
      for (const segment of segments) {
        if (stale()) return spokenMs;
        const startedAt = Date.now();
        const parts = [];
        const result = await tts.synthesize(segment.text, {
          voice: device.voice,
          sessionId: key,
          edgeVoice: device.edgeVoice,
          offlineOnly: device.offlineOnly,
          onChunk: (chunk) => {
            if (stale()) return;
            if (cacheable) parts.push(chunk.data);
            spokenMs += chunk.data.length / 2 / 24e3 * 1e3;
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
        if (cacheable && parts.length > 0) {
          preroll.put(device.voice, segment.text, Buffer.concat(parts));
        }
      }
      return spokenMs;
    } catch (error) {
      log(`tihu announce synth failed: ${error?.message ?? String(error)}`);
      device.send("event.alert", { level: "error", text: `\u64AD\u62A5\u6CA1\u5FF5\u51FA\u6765\uFF1A${error?.message ?? String(error)}\uFF08\u4EFB\u52A1\u7ED3\u679C\u5DF2\u4E0A\u5C4F\uFF09` });
      return spokenMs;
    } finally {
      if (device.speakEpoch === epoch) announcing.delete(device.id);
    }
  }
  const DONE_READ_CHUNK_MS = 120;
  const DONE_READ_SAMPLE_RATE = 24e3;
  const DONE_READ_CHUNK_BYTES = Math.round(DONE_READ_SAMPLE_RATE * DONE_READ_CHUNK_MS / 1e3) * 2;
  const DONE_READ_AHEAD = 2;
  function sliceSegmentByLines(pcm, segment, ranges, chars) {
    const lines = ranges.slice(segment.firstLine, segment.lastLine + 1);
    if (lines.length === 0 || pcm.length === 0) return [];
    const even = (value) => Math.max(0, Math.min(pcm.length, Math.round(value / 2) * 2));
    const weights = lines.map(([start, end]) => Math.max(1, [...toSpeechText(chars.slice(start, end).join(""))].length));
    const totalWeight = weights.reduce((total, value) => total + value, 0) || 1;
    const cuts = [];
    let used = 0;
    for (let i = 0; i < lines.length; i += 1) {
      used += weights[i] ?? 1;
      const raw = i === lines.length - 1 ? pcm.length : Math.round(pcm.length * (used / totalWeight));
      cuts.push(even(raw));
    }
    for (let i = 1; i < cuts.length; i += 1) cuts[i] = Math.max(cuts[i], cuts[i - 1]);
    cuts[cuts.length - 1] = even(pcm.length);
    const out = [];
    let from = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const [start, end] = lines[i];
      const slice = pcm.subarray(Math.min(from, pcm.length), Math.max(Math.min(from, pcm.length), cuts[i] ?? pcm.length));
      if (slice.length > 0) out.push({ line: segment.firstLine + i, start, end, pcm: slice });
      from = cuts[i] ?? pcm.length;
    }
    return out;
  }
  function chunkLinePcm(pcm) {
    const body = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, Math.max(0, pcm.length - 1));
    if (body.length === 0) return [];
    if (body.length <= DONE_READ_CHUNK_BYTES) return [body];
    const parts = [];
    for (let at = 0; at < body.length; at += DONE_READ_CHUNK_BYTES) {
      parts.push(body.subarray(at, Math.min(body.length, at + DONE_READ_CHUNK_BYTES)));
    }
    return parts;
  }
  async function readDoneBody(device, task, fromLine = 0) {
    const key = device.sessionId ?? "__unbound__";
    const body = doneBodyTextOf(task);
    const ranges = doneLineRangesOf(body);
    const plan = doneSpeechSegmentsOf(body);
    if (plan.length === 0 || ranges.length === 0) return -1;
    if (!tts.available()) {
      try {
        await tts.ensureServer();
      } catch {
      }
    }
    const status = tts.status();
    if (!status.available) {
      device.send("event.alert", { level: "error", text: `\u672C\u6B21\u65E0\u8BED\u97F3\uFF1A${status.error ?? "\u672C\u5730\u5F15\u64CE\u672A\u5C31\u7EEA"}\uFF08\u4EFB\u52A1\u7ED3\u679C\u5DF2\u4E0A\u5C4F\uFF09` });
      return 0;
    }
    const epoch = device.speakEpoch = (device.speakEpoch ?? 0) + 1;
    device.doneReadingTask = task.taskId;
    announcing.add(device.id);
    const stale = () => device.speakEpoch !== epoch;
    const chars = [...body];
    let spokenMs = 0;
    let failedLines = 0;
    const queued = [];
    const launchSegment = (index) => {
      if (index < 0 || index >= plan.length || queued[index] !== void 0) return;
      const segment = plan[index];
      const speech = toSpeechText(segment.text);
      if (speech === "") {
        queued[index] = Promise.resolve(Buffer.alloc(0));
        return;
      }
      const cached = preroll.get(device.voice, speech);
      if (cached !== void 0) {
        log(`tihu done read preroll hit line=${segment.firstLine} chars=${[...speech].length}`);
        queued[index] = Promise.resolve(cached);
        return;
      }
      const parts = [];
      queued[index] = tts.synthesize(speech, {
        voice: device.voice,
        sessionId: key,
        edgeVoice: device.edgeVoice,
        offlineOnly: device.offlineOnly,
        // 完成页朗读不在这里直接下发：先攒齐这一段的 PCM，再按行切开按序发（行边界＝区间边界）。
        onChunk: (chunk) => {
          if (!stale()) parts.push(chunk.data);
        }
      }).then(() => Buffer.concat(parts)).then((pcm) => {
        if (pcm.length > 0) preroll.put(device.voice, speech, pcm);
        return pcm;
      }).catch((error) => {
        log(`tihu done read synth failed line=${segment.firstLine}: ${error?.message ?? String(error)}`);
        failedLines += 1;
        return Buffer.alloc(0);
      });
    };
    launchSegment(0);
    const startIndex = (() => {
      if (fromLine <= 0) return 0;
      const found = plan.findIndex((segment) => segment.lastLine >= fromLine);
      return found < 0 ? 0 : found;
    })();
    for (let index = startIndex; index < plan.length; index += 1) {
      if (stale()) return spokenMs;
      for (let ahead = 1; ahead <= DONE_READ_AHEAD; ahead += 1) launchSegment(index + ahead);
      const pcm = await queued[index] ?? Buffer.alloc(0);
      if (stale()) return spokenMs;
      for (const line of sliceSegmentByLines(pcm, plan[index], ranges, chars)) {
        const blocks = chunkLinePcm(line.pcm);
        const lastLine = index === plan.length - 1 && line.line === plan[index].lastLine;
        const lineText = chars.slice(line.start, line.end).join("");
        for (let seq = 0; seq < blocks.length; seq += 1) {
          if (stale()) return spokenMs;
          spokenMs += blocks[seq].length / 2 / DONE_READ_SAMPLE_RATE * 1e3;
          device.send("tts.audio", {
            seq,
            total: blocks.length,
            sampleRate: DONE_READ_SAMPLE_RATE,
            channels: 1,
            format: "pcm16",
            data: blocks[seq].toString("base64"),
            index: line.line,
            text: lineText,
            charStart: line.start,
            charEnd: line.end,
            read: "done",
            ...lastLine && seq === blocks.length - 1 ? { final: true } : {}
          });
        }
      }
    }
    if (failedLines > 0) {
      device.send("event.alert", { level: "warn", text: `\u6709\u51E0\u884C\u6CA1\u5FF5\u51FA\u6765\uFF08${failedLines} \u884C\uFF0C\u5F15\u64CE/\u7F51\u7EDC\u95EE\u9898\uFF09\uFF0C\u5176\u4F59\u7167\u5E38\u5728\u5FF5` });
    }
    return spokenMs;
  }
  function readDoneScreen(device, task, fromLine = 0) {
    void readDoneBody(device, task, fromLine).then((spokenMs) => {
      if (spokenMs > 0) armScreenHome(device, spokenMs + HOME_AFTER_SPEECH_MS, task.taskId, "\u5B8C\u6210");
    }).catch((error) => log(`tihu done read failed: ${error?.message ?? String(error)}`));
  }
  function taskDetailFrameOf(task) {
    const sessionId = task.sessionIds[task.sessionIds.length - 1];
    if (sessionId === void 0) return void 0;
    const state = progressStates.get(sessionId);
    const stats = state?.stats ?? screenMetaOf(sessionId).stats;
    const statsLine2 = stats === void 0 ? "" : [
      stats.tokPerSec > 0 ? `${stats.tokPerSec.toFixed(0)} tok/s` : "",
      stats.totalTokens > 0 ? `${formatTokens(stats.totalTokens)} tok` : "",
      `\u4E0A\u4E0B\u6587 ${stats.contextPercent.toFixed(0)}%`
    ].filter((part) => part !== "").join(" \xB7 ");
    const title = task.title;
    const endedAt = runEndedAt.get(task.taskId) ?? task.finishedAt;
    const ended = endedAt !== void 0 && Number.isFinite(endedAt) && endedAt > 0;
    return detailFrame({
      taskId: task.taskId,
      title,
      liveLine: state?.lastEventLine ?? "",
      step: Math.max(task.step, state?.step ?? 0),
      // 已用时间按「这条任务这一轮跑起来的锚点」算：锚点先到先记、**永不被轮询推到后面**；
      // 回合结束（runEndedAt / finishedAt）那一刻封顶，不跨回合累计（见 elapsedOfTask）。
      elapsedMs: elapsedOfTask(task, sessionId),
      statsLine: statsLine2,
      ended
    });
  }
  function cachedAssistantText(sessionId) {
    const known = String(lastAssistant.get(sessionId)?.text ?? "").trim();
    if (known !== "") return known;
    const live = liveSessionOf(sessionId);
    const text = lastAssistantTextOfEvents(typeof live?.snapshotEvents === "function" ? live.snapshotEvents() : void 0);
    if (text !== "") lastAssistant.set(sessionId, { text, at: Date.now() });
    return text;
  }
  async function readAssistantText(sessionId) {
    const immediate = cachedAssistantText(sessionId);
    if (immediate !== "") return immediate;
    const query = optionalService3(ctx, "sessionQuery");
    if (query === void 0 || typeof query.readSession !== "function") return "";
    try {
      const loaded = await query.readSession(sessionId);
      const text = lastAssistantTextOfEvents(loaded?.events);
      if (text !== "") lastAssistant.set(sessionId, { text, at: Date.now() });
      return text;
    } catch (error) {
      log(`tihu done text read failed session=${sessionId}: ${error?.message ?? String(error)}`);
      return "";
    }
  }
  function doneReadingTextOf(task) {
    const text = String(task.doneText ?? "").trim();
    if (text !== "") return text;
    const line = String(task.resultLine ?? "").trim();
    if (line !== "") return line;
    return String(task.summary ?? "").trim();
  }
  function doneBodyTextOf(task) {
    return prepareDoneText(doneReadingTextOf(task) || DONE_NO_REPLY_TEXT);
  }
  function doneScreenOf(task, current = 0) {
    const body = doneBodyTextOf(task);
    const resultLine = String(task.resultLine ?? "").trim() || body || DONE_NO_REPLY_TEXT;
    return doneFrame({
      taskId: task.taskId,
      title: task.title,
      resultLine,
      replyText: body,
      current
    });
  }
  function clearReceipt(device) {
    if (device.receiptTimer !== void 0) clearTimeout(device.receiptTimer);
    device.receiptTimer = void 0;
  }
  async function showDone(device, task, speak = true) {
    clearReceipt(device);
    disarmAutoHome(device);
    device.pendingPick = void 0;
    device.focusedTask = task.taskId;
    device.onBoard = false;
    if (String(task.doneText ?? "").trim() === "") {
      const sessionId = task.sessionIds[task.sessionIds.length - 1];
      if (sessionId !== void 0) {
        const text = await readAssistantText(sessionId);
        if (!devices.has(device) || device.focusedTask !== task.taskId || device.onBoard === true) return;
        if (text !== "") {
          task.doneText = text;
          if (String(task.resultLine ?? "").trim() === "") task.resultLine = firstSentenceOf(text);
        }
      }
    }
    sendFrame(device, doneScreenOf(task), device.sessionId);
    armScreenHome(device, HOME_AFTER_SPEECH_MS, task.taskId, "\u5B8C\u6210");
    if (!speak) return;
    readDoneScreen(device, task);
  }
  function showDecision(device, task) {
    clearReceipt(device);
    disarmAutoHome(device);
    device.pendingPick = void 0;
    device.focusedTask = task.taskId;
    device.onBoard = false;
    const seconds = Math.max(5, Math.round(((task.decisionDeadline ?? Date.now() + 6e4) - Date.now()) / 1e3));
    sendFrame(device, decisionFrame({
      taskId: task.taskId,
      title: task.title,
      ...task.question === void 0 ? {} : { question: task.question },
      ...task.detail === void 0 ? {} : { detail: task.detail },
      options: task.options ?? [],
      ...task.defaultIndex === void 0 ? {} : { defaultIndex: task.defaultIndex },
      seconds
    }), device.sessionId);
    armScreenHome(device, seconds * 1e3, task.taskId, "\u5F85\u51B3\u7B56");
  }
  function showDetail(device, task) {
    const frame = taskDetailFrameOf(task);
    if (frame === void 0) return false;
    clearReceipt(device);
    disarmAutoHome(device);
    device.pendingPick = void 0;
    device.focusedTask = task.taskId;
    device.onBoard = false;
    progressEventAt.set(task.taskId, Date.now());
    sendFrame(device, frame, device.sessionId);
    armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, "\u8FDB\u5EA6");
    ensureDetailTicker();
    return true;
  }
  function openTask(device, taskId) {
    const task = tasks.get(taskId);
    if (task === void 0) return false;
    disarmAutoHome(device);
    if (task.state === "done" || task.state === "announced") {
      void showDone(device, task);
      return true;
    }
    if (task.state === "awaiting") {
      showDecision(device, task);
      return true;
    }
    if (task.source === "pc") {
      void openExternalTask(device, task).catch((error) => log(`tihu pc open failed: ${error?.message ?? String(error)}`));
      return true;
    }
    return showDetail(device, task);
  }
  let detailTicker;
  const leavingProgress = /* @__PURE__ */ new Set();
  function ensureDetailTicker() {
    if (detailTicker !== void 0) return;
    detailTicker = setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      const staleMs = tihuProgressStaleMs();
      for (const device of devices) {
        if (!device.unified) continue;
        if (device.onBoard === true) continue;
        if (device.focusedTask === void 0) continue;
        if (device.receiptTimer !== void 0 || device.pendingPick !== void 0) continue;
        if (device.screenStage !== "\u8FDB\u5EA6") continue;
        const key = device.sessionId ?? device.id;
        const task = tasks.get(device.focusedTask);
        if (task === void 0) continue;
        if (task.state === "done" || task.state === "announced") {
          if (!leavingProgress.has(device.id)) {
            leavingProgress.add(device.id);
            void showDone(device, task, false).finally(() => {
              leavingProgress.delete(device.id);
            });
          }
          continue;
        }
        if (task.state === "awaiting") {
          showDecision(device, task);
          continue;
        }
        if (task.state === "archived") {
          sendBoard(device);
          continue;
        }
        const lastAt = progressEventAt.get(task.taskId) ?? 0;
        if (lastAt > 0 && now - lastAt >= staleMs) {
          log(`tihu progress watchdog device=${device.id} task=${task.taskId} idle=${now - lastAt}ms`);
          sendBoard(device);
          continue;
        }
        const frame = taskDetailFrameOf(task);
        if (frame === void 0) continue;
        lastFrames.set(key, frame);
        pushFrame(device, frame);
      }
    }, 1e3);
    detailTicker.unref?.();
  }
  function refreshFocusedDetail(task) {
    if (task.state === "done" || task.state === "announced" || task.state === "awaiting") return;
    for (const device of devices) {
      if (!device.unified) continue;
      if (device.onBoard === true) continue;
      if (device.focusedTask !== task.taskId) continue;
      if (device.receiptTimer !== void 0 || device.pendingPick !== void 0) continue;
      if (device.screenStage !== "\u8FDB\u5EA6") continue;
      const key = device.sessionId ?? device.id;
      const frame = taskDetailFrameOf(task);
      if (frame === void 0) continue;
      lastFrames.set(key, frame);
      pushFrame(device, frame);
      armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, "\u8FDB\u5EA6");
    }
  }
  function showReceipt(device, task, note) {
    const key = device.sessionId ?? "__unbound__";
    const queuedAhead = tasks.list().filter((item) => (item.state === "queued" || item.state === "dispatched") && item.taskId !== task.taskId).length;
    const frame = receiptFrame({
      taskId: task.taskId,
      projectName: task.projectName,
      ...task.folder === void 0 ? {} : { folder: task.folder },
      ...note === void 0 || note === "" ? {} : { note },
      queueAhead: queuedAhead,
      ...queuedAhead > 0 ? { etaText: `${queuedAhead} \u5206\u949F` } : { etaText: "1 \u5206\u949F" }
    });
    lastFrames.set(key, frame);
    const targets = [activeUnifiedDevice() ?? device];
    for (const target of targets) {
      disarmAutoHome(target);
      target.focusedTask = task.taskId;
      pushFrame(target, frame);
      sendTaskUpdate(target, task);
      target.send("task.list", { board: boardOf(tasks.list(), Date.now()) });
      if (target.receiptTimer !== void 0) clearTimeout(target.receiptTimer);
      target.receiptTimer = setTimeout(() => {
        target.receiptTimer = void 0;
        if (!devices.has(target)) return;
        if (target.focusedTask !== task.taskId) return;
        const latest = tasks.get(task.taskId) ?? task;
        if (latest.state === "running" || latest.state === "awaiting") {
          if (openTask(target, latest.taskId)) {
            log(`tihu receipt hold -> ${latest.state} task=${latest.taskId}`);
            return;
          }
        } else if (latest.state === "done" || latest.state === "announced") {
          void showDone(target, latest, false);
          log(`tihu receipt hold -> done task=${latest.taskId}`);
          return;
        }
        sendBoard(target);
        log(`tihu receipt hold -> board task=${latest.taskId} state=${latest.state}`);
      }, tihuReceiptHoldMs());
      target.receiptTimer.unref?.();
    }
  }
  async function dispatchToCard(device, text, card, title, meta) {
    const folder = resolveTaskFolder(card);
    const decision = meta ?? { via: "rule", continuity: "new", clarify: "no" };
    stopCommanderWait();
    const reuseTaskId = decision.reuseTaskId ?? pendingCommanderTaskIdOf(text);
    let task;
    if (reuseTaskId !== void 0) {
      const existing = tasks.get(reuseTaskId);
      if (existing !== void 0 && existing.state !== "archived" && !isFinishedState(existing.state)) {
        task = tasks.adopt(existing.taskId, {
          title: title ?? text,
          projectId: card.id,
          projectName: card.name,
          folder,
          preset: DISPATCH_PRESET
        });
      }
    }
    if (task === void 0) {
      task = tasks.add({
        title: title ?? text,
        projectId: card.id,
        projectName: card.name,
        folder,
        // 派单会话必须是 computer-use：设备屏要能看屏/点按，且必须是「项目文件夹」不变。
        preset: DISPATCH_PRESET
      });
    }
    const noteDegradedFailure = (failedSession, error, headLine) => {
      if (decision.keepTaskOnFailure !== true) return;
      const reason = compactErrorText(error);
      try {
        appendTihuLaneLog(failedSession ?? "-", new Error(`\u964D\u7EA7\u518D\u5931\u8D25 \u4EFB\u52A1=${task.taskId} \u76EE\u6807\u4F1A\u8BDD=${failedSession ?? "\u6CA1\u5EFA\u8D77\u6765"} \u9879\u76EE=${card.name}\uFF1A${reason}`), "append-degrade-failed");
      } catch {
      }
      log(`tihu dispatch degraded failed task=${task.taskId} session=${failedSession ?? "-"} project=${card.id} reason=${reason}`);
      if (device !== void 0) {
        showDispatchStuck(device, error, headLine);
        decision.failureShown = true;
      }
    };
    const sessionId = await createSessionAt(folder, DISPATCH_PRESET);
    if (sessionId === void 0) {
      const message = "\u5BBF\u4E3B\u8FD8\u4E0D\u80FD\u65B0\u5EFA\u4F1A\u8BDD\uFF08sessionController.create \u4E0D\u53EF\u7528\uFF0C\u89C1 tihu \u65E5\u5FD7\uFF09\uFF0C\u8FD9\u6B21\u6CA1\u6D3E\u51FA\u53BB";
      decision.failure = new Error(message);
      if (decision.keepTaskOnFailure !== true) {
        tasks.drop(task.taskId);
        releasePendingCommanderTask(task.taskId);
        refreshBoards();
        broadcastBoardSnapshot();
      } else {
        releasePendingCommanderTask(task.taskId);
        refreshBoards();
      }
      noteDegradedFailure(void 0, new Error(message), "\u540C\u9879\u76EE\u4E5F\u5EFA\u4E0D\u8D77\u4F1A\u8BDD\uFF0C\u5DF2\u7559\u5728\u68CB\u76D8");
      if (device !== void 0 && decision.quietFailure !== true) {
        showInputError(device, new Error(message), "\u4EFB\u52A1\u4F1A\u8BDD\u6CA1\u5EFA\u8D77\u6765\uFF0C\u8BF7\u91CD\u8BF4");
      }
      log(`tihu dispatch failed: no session service`);
      return void 0;
    }
    await applyTihuModel(sessionId, "foreground", "\u6D3E\u5355");
    const blocks = [
      { type: "text", text },
      {
        type: "text",
        text: `\u3010\u6D3E\u5355 \xB7 \u9E48\u9E55\u3011\u9E48\u9E55\u662F\u4E3B\u4EBA\u5BB6\u91CC\u7684\u8BED\u97F3\u5C0F\u5C4F\u52A9\u624B\uFF0C\u8D1F\u8D23\u628A\u8BBE\u5907\u4E0A\u8BF4\u7684\u8BDD\u8F6C\u4EA4\u7ED9\u5BF9\u5E94\u9879\u76EE\uFF0C\u7535\u8111\u7AEF\u518D\u6267\u884C\u4EFB\u52A1\u3002\u8FD9\u53E5\u8BDD\u5DF2\u6D3E\u5230\u300C${card.name}\u300D\uFF0C\u5DE5\u4F5C\u76EE\u5F55\u662F ${folder}\u3002\u505A\u5B8C\u540E\u7528\u7B80\u6D01\u4E2D\u6587\u8BF4\u660E\u7ED3\u679C\uFF1A\u5148\u7ED9\u7ED3\u8BBA\uFF0C\u518D\u7ED9\u5173\u952E\u6570\u5B57\u6216\u8FDB\u5C55\uFF0C\u6587\u5B57\u4E0D\u8981\u592A\u957F\uFF0C\u786E\u5B9E\u9700\u8981\u957F\u6587\u672C\u7684\u60C5\u51B5\u9664\u5916\uFF08\u4F8B\u5982\u7528\u6237\u660E\u786E\u8981\u6C42\u5168\u6587\u6717\u8BFB\u3001\u5B8C\u6574\u6E05\u5355\uFF09\uFF0C\u9002\u5408\u76F4\u63A5\u6717\u8BFB\uFF1B\u4E0D\u8981\u8868\u683C\u3001\u5217\u8868\u3001\u4EE3\u7801\u5757\u6216\u957F\u8DEF\u5F84\u3002`
      }
    ];
    tasks.attachSession(task.taskId, sessionId);
    const sent = await promptSession(sessionId, blocks);
    if (!sent.ok) {
      decision.failure = sent.error;
      if (decision.keepTaskOnFailure !== true) {
        tasks.drop(task.taskId);
        releasePendingCommanderTask(task.taskId);
        refreshBoards();
        broadcastBoardSnapshot();
      } else {
        releasePendingCommanderTask(task.taskId);
        refreshBoards();
      }
      logDispatchDecision(card.name, sessionId, decision);
      noteDegradedFailure(sessionId, sent.error, "\u8FD9\u53E5\u6CA1\u6295\u8FDB\u53BB\uFF0C\u5DF2\u5728\u540C\u9879\u76EE\u65B0\u5EFA\uFF0C\u7A0D\u540E\u91CD\u8BD5");
      if (device !== void 0 && decision.quietFailure !== true) showInputError(device, sent.error, "\u4EFB\u52A1\u4F1A\u8BDD\u6CA1\u6709\u63A5\u4F4F\u8FD9\u6761\u6D88\u606F\uFF0C\u8BF7\u91CD\u8BF4");
      return void 0;
    }
    if (decision.reopenTask === true) tasks.reopenForAppend(task.taskId);
    if (decision.continuity === "new" && decision.reuseTaskId !== void 0 && decision.keepTaskOnFailure === true) {
      try {
        appendTihuLaneLog(sessionId, new Error(`\u964D\u7EA7\u6295\u9012\u6210\u529F \u4EFB\u52A1=${task.taskId} \u4F1A\u8BDD=${sessionId} \u9879\u76EE=${card.name} \u8BDD=${JSON.stringify(taskTitleOf(text, 24))}`), "append-degrade-delivered");
      } catch {
      }
    }
    fallbackDispatch = { key: dispatchKeyOf(text), taskId: task.taskId, at: Date.now() };
    releasePendingCommanderTask(task.taskId);
    log(`tihu dispatch task=${task.taskId} project=${card.id} session=${sessionId} folder=${folder} preset=${DISPATCH_PRESET}`);
    clearGrayFallback();
    clearClarifyPrompt();
    logDispatchDecision(card.name, sessionId, decision);
    if (device !== void 0) {
      showReceipt(device, task, decision.note);
      refreshBoards();
    }
    return task;
  }
  async function appendToSession(device, text, card, target, meta) {
    const folder = resolveTaskFolder(card);
    stopCommanderWait();
    clearGrayFallback();
    clearClarifyPrompt();
    const existing = tasks.ofSession(target.sessionId);
    if (existing !== void 0 && existing.source === "pc") {
      archivePcTask(existing.taskId, Date.now(), "tihu append");
    }
    const reuseTaskId = meta.reuseTaskId ?? pendingCommanderTaskIdOf(text);
    let task;
    if (reuseTaskId !== void 0) {
      const reused = tasks.get(reuseTaskId);
      if (reused !== void 0 && reused.state !== "archived" && !isFinishedState(reused.state)) {
        task = tasks.adopt(reused.taskId, {
          title: text,
          projectId: card.id,
          projectName: card.name,
          folder,
          preset: DISPATCH_PRESET
        });
        if (existing !== void 0 && existing.taskId !== task.taskId) {
          tasks.detachSession(existing.taskId, target.sessionId);
          if (existing.state !== "done" && existing.state !== "announced" && existing.state !== "archived") {
            const removed = tasks.archive(existing.taskId, Date.now());
            if (removed !== void 0) appendTaskJournal(removed);
            log(`tihu append replace old task=${existing.taskId} -> ${task.taskId}`);
          }
        }
        tasks.attachSession(task.taskId, target.sessionId);
      }
    }
    const closedPrevious = existing !== void 0 && (existing.source === "pc" || existing.state === "archived" || isFinishedState(existing.state));
    if (task === void 0) {
      if (existing === void 0 || closedPrevious) {
        task = tasks.add({
          title: text,
          projectId: card.id,
          projectName: card.name,
          folder,
          preset: DISPATCH_PRESET,
          sessionIds: [target.sessionId]
        });
        tasks.attachSession(task.taskId, target.sessionId);
        if (closedPrevious) {
          log(`tihu append new task=${task.taskId} (previous task=${existing?.taskId} state=${existing?.state} \u5DF2\u7ED3\u675F\uFF0C\u4E0D\u590D\u7528)`);
        }
      } else {
        tasks.reopenForAppend(existing.taskId);
        task = existing;
      }
    }
    const deliverable = await ensureAppendTarget(target.sessionId);
    let failure;
    let failureNote = "append-resume-failed";
    let failureStage = "resume";
    if (!deliverable.ok) {
      failure = deliverable.error ?? new Error("\u76EE\u6807\u4F1A\u8BDD\u6CA1\u6709\u6D3B\u52A8 agent");
    } else {
      if (deliverable.resumed) {
        try {
          appendTihuLaneLog(target.sessionId, new Error("\u627F\u63A5\u76EE\u6807\u7A7A\u95F2 \u2192 \u5DF2 resume \u540E\u6295\u9012"), "append-resume-ok");
        } catch {
        }
        log(`tihu append resume ok session=${target.sessionId} project=${card.id}`);
      }
      failureStage = "\u6295\u9012";
      failureNote = "append-prompt-failed";
      const sent = await promptSession(target.sessionId, [
        { type: "text", text },
        { type: "text", text: appendTailOf(card, folder) }
      ]);
      if (sent.ok) {
        tasks.markRunning(task.taskId);
        tasks.noteMilestone(task.taskId, `\u8FFD\u52A0\uFF1A${taskTitleOf(text)}`);
        fallbackDispatch = { key: dispatchKeyOf(text), taskId: task.taskId, at: Date.now() };
        releasePendingCommanderTask(task.taskId);
        logDispatchDecision(card.name, target.sessionId, meta);
        log(`tihu append task=${task.taskId} project=${card.id} session=${target.sessionId} folder=${folder} preset=${DISPATCH_PRESET}`);
        if (device !== void 0) {
          showReceipt(device, task, meta.note);
          refreshBoards();
        }
        return task;
      }
      failure = sent.error ?? new Error("\u6295\u9012\u5931\u8D25");
    }
    const reason = failure?.message ?? String(failure);
    try {
      appendTihuLaneLog(target.sessionId, new Error(`append \u5931\u8D25 \u2192 \u540C\u9879\u76EE\u65B0\u5EFA\uFF1A${failureStage}\u5931\u8D25\uFF1A${reason}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF09`), failureNote);
    } catch {
    }
    log(`tihu append ${failureStage} failed session=${target.sessionId} task=${task.taskId} project=${card.id} reason=${reason} -> new session in same project`);
    const degradeMeta = {
      via: meta.via,
      continuity: "new",
      ...meta.confidence === void 0 ? {} : { confidence: meta.confidence },
      clarify: meta.clarify,
      // 同一句话同一张卡：沿用这句自己的 taskId，棋盘上不许冒出第二张。
      reuseTaskId: task.taskId,
      note: "\u90A3\u6761\u4F1A\u8BDD\u6CA1\u63A5\u4F4F\uFF0C\u5DF2\u5728\u540C\u9879\u76EE\u65B0\u5EFA",
      reopenTask: true,
      keepTaskOnFailure: true,
      quietFailure: true
    };
    const degraded = await dispatchToCard(device, text, card, task.title, degradeMeta);
    if (degradeMeta.failureShown === true) meta.failureShown = true;
    if (degradeMeta.failure !== void 0) meta.failure = degradeMeta.failure;
    if (degraded !== void 0) {
      tasks.detachSession(degraded.taskId, target.sessionId);
      refreshBoards();
      const fresh = degraded.sessionIds[degraded.sessionIds.length - 1] ?? "";
      try {
        appendTihuLaneLog(fresh || target.sessionId, new Error(`append \u5931\u8D25 \u2192 \u540C\u9879\u76EE\u65B0\u5EFA\uFF1A\u5DF2\u6D3E\u5230 ${fresh}\uFF08\u4EFB\u52A1 ${degraded.taskId}\uFF0C\u9879\u76EE ${card.name}\uFF09`), "append-degraded");
      } catch {
      }
      log(`tihu append degraded task=${degraded.taskId} old=${target.sessionId} new=${fresh} project=${card.id}`);
      return degraded;
    }
    if (device !== void 0 && meta.failureShown !== true) showDispatchStuck(device, meta.failure ?? failure);
    meta.failureShown = true;
    return void 0;
  }
  async function dispatchWithContinuity(device, text, card, meta, options2 = {}) {
    let candidates = [];
    try {
      candidates = await projectCuSessionsOf(card);
    } catch (error) {
      log(`tihu continuity list failed: ${error?.message ?? String(error)}`);
    }
    const folder = resolveTaskFolder(card);
    const decision = continuityOf({
      text,
      sessions: candidates,
      now: Date.now(),
      projectHints: continuityHintsOf(card, folder)
    });
    const hitSession = decision.kind === "append" ? decision.sessionId : decision.kind === "gray" ? decision.sessionId ?? "-" : "-";
    log(`tihu continuity project=${card.id} via=${meta.via} kind=${decision.kind} score=${decision.confidence.toFixed(2)} session=${hitSession} ${decision.reason}`);
    if (decision.kind === "append") {
      const target = candidates.find((item) => item.sessionId === decision.sessionId);
      const appendMeta = { via: meta.via, continuity: "append", confidence: decision.confidence, clarify: "no" };
      const task = await appendToSession(
        device,
        text,
        card,
        { sessionId: decision.sessionId, ...target?.title === void 0 || target.title === "" ? {} : { title: target.title } },
        appendMeta
      );
      if (task === void 0) {
        return { message: appendMeta.failureShown === true ? "\u5DF2\u8BB0\u4E0B\uFF1A\u5BBF\u4E3B\u6CA1\u5EFA\u8D77\u4F1A\u8BDD\uFF08\u4E0D\u7528\u91CD\u8BF4\uFF09\u3002" : "\u9519\u8BEF\uFF1A\u90A3\u6761\u4F1A\u8BDD\u6CA1\u63A5\u4F4F\u8FD9\u53E5\u8BDD\u3002" };
      }
      if (!task.sessionIds.includes(decision.sessionId)) {
        return { task, message: `\u90A3\u6761\u4F1A\u8BDD\u63A5\u4E0D\u4F4F\uFF0C\u5DF2\u5728\u300C${task.projectName}\u300D\u65B0\u5EFA\u4F1A\u8BDD\u6D3E\u51FA\uFF1A${task.title}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF09` };
      }
      return { task, message: `\u5DF2\u63A5\u7740\u300C${task.projectName}\u300D\u539F\u6709\u4F1A\u8BDD\u6D3E\u51FA\uFF1A${task.title}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF09` };
    }
    if (decision.kind === "new") {
      const task = await dispatchToCard(device, text, card, void 0, { via: meta.via, continuity: "new", confidence: decision.confidence, clarify: "no" });
      if (task === void 0) return { message: "\u9519\u8BEF\uFF1A\u8FD9\u6761\u4EFB\u52A1\u6CA1\u6D3E\u51FA\u53BB\uFF08\u5BBF\u4E3B\u4E0D\u80FD\u65B0\u5EFA\u4F1A\u8BDD\uFF0C\u6216\u4EFB\u52A1\u4F1A\u8BDD\u6CA1\u63A5\u4F4F\u6D88\u606F\uFF09\u3002" };
      return { task, message: `\u5DF2\u6D3E\u7ED9\u300C${task.projectName}\u300D\uFF1A${task.title}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF0C\u843D\u5728 ${task.folder ?? "\u9ED8\u8BA4\u76EE\u5F55"}\uFF09` };
    }
    if (options2.allowCommander === true && device !== void 0) {
      const asked = await askGrayCommander(device, text, card, decision, candidates, meta.via);
      return {
        message: asked ? "\u8FD9\u53E5\u8BDD\u7684\u8854\u63A5\u5728\u7070\u533A\uFF1A\u5DF2\u8BF7\u6307\u6325\u4F1A\u8BDD\u5224\u4E00\u6B21\uFF08\u63A5\u7740\u54EA\u6761 / \u8FD8\u662F\u65B0\u5EFA\uFF09\u3002" : "\u8FD9\u53E5\u8BDD\u7684\u8854\u63A5\u5728\u7070\u533A\uFF1A\u8BBE\u5907\u5C4F\u4E0A\u4F1A\u95EE\u4E00\u6B21\u300C\u65B0\u5EFA\uFF0C\u8FD8\u662F\u63A5\u7740\u521A\u624D\u90A3\u6761\u300D\u3002"
      };
    }
    await showSessionClarify(device, text, card, decision, candidates, meta.via);
    return { message: "\u5DF2\u5728\u8BBE\u5907\u5C4F\u4E0A\u95EE\u4E00\u6B21\uFF1A\u65B0\u5EFA\uFF0C\u8FD8\u662F\u63A5\u7740\u521A\u624D\u90A3\u6761\uFF08\u540C\u4E00\u6761\u4EFB\u52A1\u53EA\u95EE\u4E00\u6B21\uFF0C\u4E0D\u7B54\u5C31\u6309\u65B0\u5EFA\u6D3E\u51FA\uFF09\u3002" };
  }
  async function askGrayCommander(device, text, card, decision, candidates, via) {
    const commander = await ensureCommanderSession();
    if (commander === void 0) {
      await showSessionClarify(device, text, card, { ...decision }, candidates, via);
      return false;
    }
    device.unified = true;
    stopCommanderWait();
    const key = device.sessionId ?? device.id;
    device.onBoard = false;
    const frame = noticeFrame({
      stage: "\u6D3E\u5355",
      title: "\u6B63\u5728\u770B\u662F\u4E0D\u662F\u63A5\u7740\u505A",
      lines: candidates.length > 0 ? [taskTitleOf(text, 16), `\u5019\u9009 ${candidates.length} \u6761\u4F1A\u8BDD`] : [taskTitleOf(text, 16)],
      tone: "busy"
    });
    lastFrames.set(key, frame);
    const targets = [...devices].filter((item) => item.unified);
    if (targets.length === 0) targets.push(device);
    for (const target of targets) {
      if (target.receiptTimer !== void 0) {
        clearTimeout(target.receiptTimer);
        target.receiptTimer = void 0;
      }
      disarmAutoHome(target);
      target.focusedTask = void 0;
      pushFrame(target, frame);
    }
    const list = candidates.map((candidate, index) => {
      const short = candidate.sessionId.replace(/^session-/, "").slice(0, 8);
      const at = candidate.updatedAt > 0 ? new Date(candidate.updatedAt).toISOString().slice(5, 16).replace("T", " ") : "\u672A\u77E5\u65F6\u95F4";
      return `${index + 1}. ${candidate.title || "\u672A\u547D\u540D\u4F1A\u8BDD"}\uFF08${short} \xB7 ${at}\uFF09`;
    });
    const tail = [
      `\u3010\u4F1A\u8BDD\u8854\u63A5 \xB7 \u7070\u533A\u3011\u9879\u76EE\u300C${card.name}\u300D\u4E0B\u6700\u8FD1\u6709\u8FD9\u4E9B Computer Use \u4F1A\u8BDD\uFF1A`,
      list.length === 0 ? "\uFF08\u8FD8\u6CA1\u6709 CU \u4F1A\u8BDD\uFF09" : list.join("\n"),
      `\u7528\u6237\u8FD9\u53E5\u8BDD\uFF1A\u300C${text}\u300D`,
      "\u5224\u65AD\u5B83\u662F\u4E0D\u662F\u63A5\u7740\u5176\u4E2D\u67D0\u6761\u5728\u505A\uFF08\u5185\u5BB9\u8FDE\u7EED\u3001\u6307\u4EE3\u3001\u65F6\u95F4\u63A5\u8FD1\u90FD\u7B97\uFF09\uFF0C\u7136\u540E**\u53EA\u8F93\u51FA\u4E00\u884C JSON**\uFF1A",
      `{"project":"${card.name}","session":"append|new","append_to":"<\u90A3\u6761\u7684\u77ED\u53F7\uFF0C\u65B0\u5EFA\u7559\u7A7A>"}`,
      '\xB7 \u63A5\u7740\u67D0\u6761 \u2192 "append"\uFF0Cappend_to \u5199\u90A3\u6761\u7684\u77ED\u53F7\uFF1B\u786E\u5B9E\u662F\u4E00\u4EF6\u65B0\u4E8B \u2192 "new"\uFF0Cappend_to \u7559\u7A7A\u3002',
      '\u4E0D\u8981\u505A\u6B63\u6587\u3001\u4E0D\u8981\u89E3\u91CA\u3001\u4E0D\u8981\u8C03\u7528\u4EFB\u4F55\u5DE5\u5177\uFF1B\u9664\u8FD9\u4E00\u884C JSON \u5916\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5B57\u7B26\u3002\u62FF\u4E0D\u51C6\u5C31 "new"\u3002'
    ].join("\n");
    const sent = await promptSession(commander, [{ type: "text", text }, { type: "text", text: tail }]);
    if (!sent.ok) {
      await showSessionClarify(device, text, card, { ...decision }, candidates, via);
      return false;
    }
    dropContinuityAsks();
    pushCommanderAsk({
      key: dispatchKeyOf(text),
      text,
      kind: "continuity",
      card,
      candidates,
      confidence: decision.confidence,
      via,
      askedAt: Date.now()
    });
    armGrayFallback(device, text, card, decision, candidates, via);
    return true;
  }
  function armGrayFallback(device, text, card, decision, candidates, via) {
    clearGrayFallback({ keepAsks: true });
    const waitMs = tihuGrayCommanderMs();
    const timer = setTimeout(() => {
      grayFallback = void 0;
      if (disposed) return;
      dropCommanderAsk(dispatchKeyOf(text));
      try {
        appendTihuLaneLog("-", new Error(`\u7070\u533A\u8854\u63A5\u8D85\u65F6\uFF1A${Math.round(waitMs / 1e3)} \u79D2\u5185\u6307\u6325\u53F0\u6CA1\u6709\u6D3E\u51FA\u300C${taskTitleOf(text, 24)}\u300D`), "continuity-gray-timeout");
      } catch {
      }
      log(`tihu continuity-gray timeout after=${waitMs}ms text=${JSON.stringify(text)}`);
      void showSessionClarify(device, text, card, decision, candidates, via).catch((error) => log(`tihu clarify failed: ${error?.message ?? String(error)}`));
    }, waitMs);
    timer.unref?.();
    grayFallback = { text, key: dispatchKeyOf(text), card, confidence: decision.confidence, via, timer };
  }
  function clearGrayFallback(options2 = {}) {
    if (grayFallback === void 0) return;
    clearTimeout(grayFallback.timer);
    grayFallback = void 0;
    if (options2.keepAsks !== true) dropContinuityAsks();
  }
  function clearClarifyPrompt() {
    if (clarifyTimer !== void 0) {
      clearTimeout(clarifyTimer);
      clarifyTimer = void 0;
    }
    if (intentClarifyTimer !== void 0) {
      clearTimeout(intentClarifyTimer);
      intentClarifyTimer = void 0;
    }
    for (const item of devices) {
      item.pendingClarify = void 0;
      item.pendingIntent = void 0;
    }
  }
  async function showSessionClarify(device, text, card, decision, candidates, via) {
    const key = dispatchKeyOf(text);
    const askedAt = clarifyAsked.get(key);
    if (askedAt !== void 0 && Date.now() - askedAt < CLARIFY_ONCE_MS) {
      await dispatchToCard(device, text, card, void 0, { via, continuity: "new", confidence: decision.confidence, clarify: "asked" });
      return;
    }
    clarifyAsked.set(key, Date.now());
    for (const [oldKey, at] of clarifyAsked) {
      if (Date.now() - at > CLARIFY_ONCE_MS) clarifyAsked.delete(oldKey);
    }
    const sessionId = decision.sessionId ?? "";
    if (sessionId === "") {
      await dispatchToCard(device, text, card, void 0, { via, continuity: "new", confidence: decision.confidence, clarify: "no" });
      return;
    }
    const sessionTitle = candidates.find((item) => item.sessionId === sessionId)?.title ?? "";
    const frame = clarifySessionFrame({ sessionTitle });
    const targets = [...devices].filter((item) => item.unified);
    if (targets.length === 0 && device !== void 0) targets.push(device);
    if (targets.length === 0) {
      await dispatchToCard(void 0, text, card, void 0, { via, continuity: "new", confidence: decision.confidence, clarify: "asked" });
      return;
    }
    stopCommanderWait();
    clearGrayFallback();
    const displayKey = device?.sessionId ?? device?.id ?? targets[0].sessionId ?? targets[0].id;
    lastFrames.set(displayKey, frame);
    for (const target of targets) {
      disarmAutoHome(target);
      if (target.receiptTimer !== void 0) {
        clearTimeout(target.receiptTimer);
        target.receiptTimer = void 0;
      }
      target.pendingPick = void 0;
      target.pendingClarify = {
        text,
        card,
        sessionId,
        sessionTitle,
        confidence: decision.confidence,
        via
      };
      target.focusedTask = void 0;
      target.onBoard = false;
      pushFrame(target, frame);
    }
    if (clarifyTimer !== void 0) clearTimeout(clarifyTimer);
    const timer = setTimeout(() => {
      clarifyTimer = void 0;
      if (disposed) return;
      const waiting = [...devices].find((item) => item.pendingClarify !== void 0);
      const pending = waiting?.pendingClarify;
      if (pending === void 0) return;
      clearClarifyPrompt();
      log(`tihu clarify timeout text=${JSON.stringify(pending.text)}`);
      void dispatchToCard(waiting, pending.text, pending.card, void 0, {
        via: pending.via,
        continuity: "new",
        confidence: pending.confidence,
        clarify: "asked"
      }).catch((error) => log(`tihu clarify timeout dispatch failed: ${error?.message ?? String(error)}`));
    }, tihuClarifyMs());
    timer.unref?.();
    clarifyTimer = timer;
    log(`tihu clarify ask project=${card.id} session=${sessionId} score=${decision.confidence.toFixed(2)} title=${JSON.stringify(sessionTitle)}`);
  }
  async function resolveClarify(device, choice) {
    const pending = device.pendingClarify;
    if (pending === void 0) return;
    clearClarifyPrompt();
    if (choice === "same" && pending.sessionId !== "") {
      await appendToSession(
        device,
        pending.text,
        pending.card,
        { sessionId: pending.sessionId, ...pending.sessionTitle === "" ? {} : { title: pending.sessionTitle } },
        { via: pending.via, continuity: "append", confidence: pending.confidence, clarify: "yes" }
      );
      return;
    }
    await dispatchToCard(device, pending.text, pending.card, void 0, {
      via: pending.via,
      continuity: "new",
      confidence: pending.confidence,
      clarify: "yes"
    });
  }
  function clarifyChoiceOf(text) {
    const clean = String(text ?? "").replace(/[\s，,。.!！?？:：、；;]+/g, "");
    if (clean === "") return void 0;
    const index = chineseIndex(clean);
    if (index === 1) return "new";
    if (index === 2) return "same";
    if (/^(?:新建|新的|新的一条|新会话|另起|另开|重新开|单开)$/.test(clean)) return "new";
    if (/^(?:接着|继续|原来那条|原来的|刚才那条|那条|同一个|同一会话|还那条)$/.test(clean)) return "same";
    return void 0;
  }
  function askWhich(device, candidates, text) {
    const list = candidates.slice(0, 2).map((card) => ({ id: card.id, name: card.name, ...card.folder === void 0 ? {} : { folder: card.folder } }));
    list.sort((a, b) => {
      const ai = text.indexOf(a.name);
      const bi = text.indexOf(b.name);
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
    });
    const key = device.sessionId ?? device.id;
    for (const target of devices) if (target.unified) target.onBoard = false;
    const frame = askWhichFrame({ candidates: list.map((card) => ({ projectName: card.name, doing: doingOf(card.id) || (card.folder ? `\u6587\u4EF6\u5939 ${folderBase2(card.folder)}` : "\u6682\u65E0\u5728\u8DD1\u4EFB\u52A1") })) });
    lastFrames.set(key, frame);
    const targets = [...devices].filter((item) => item.unified);
    if (targets.length === 0) targets.push(device);
    for (const target of targets) {
      target.pendingPick = { candidates: list, text };
      if (target.receiptTimer !== void 0) {
        clearTimeout(target.receiptTimer);
        target.receiptTimer = void 0;
      }
      target.focusedTask = void 0;
      pushFrame(target, frame);
    }
    pushTaskNotify(void 0, 0, `\u8FD9\u53E5\u8BDD\u6D3E\u7ED9\u8C01\uFF1A${list.map((card, index) => `${index + 1} ${card.name}`).join("\uFF0C")}`);
    log(`tihu ask-which device=${device.id} candidates=${list.map((card) => card.id).join(",")}`);
  }
  async function answerDirect(device, text) {
    const commander = await ensureCommanderSession();
    if (commander === void 0) {
      showInputError(device, new Error("\u4F1A\u8BDD\u65B0\u5EFA\u5931\u8D25\uFF1A\u5BBF\u4E3B sessionController \u4E0D\u53EF\u7528"), "\u6307\u6325\u4F1A\u8BDD\u8FD8\u6CA1\u5EFA\u597D\uFF0C\u8BF7\u91CD\u8BF4");
      return;
    }
    device.unified = true;
    const key = device.sessionId ?? device.id;
    device.onBoard = false;
    const frame = noticeFrame({ stage: "\u56DE\u7B54", title: "\u6211\u5728\uFF0C\u76F4\u63A5\u7B54", lines: [taskTitleOf(text, 18)], tone: "busy" });
    lastFrames.set(key, frame);
    const targets = [...devices].filter((item) => item.unified);
    if (targets.length === 0) targets.push(device);
    for (const target of targets) {
      if (target.receiptTimer !== void 0) {
        clearTimeout(target.receiptTimer);
        target.receiptTimer = void 0;
      }
      disarmAutoHome(target);
      target.pendingPick = void 0;
      target.focusedTask = void 0;
      pushFrame(target, frame);
    }
    const sent = await promptSession(commander, [
      { type: "text", text },
      { type: "text", text: "\u3010\u53EA\u8BFB\u95EE\u7B54 \xB7 \u9E48\u9E55\u3011\u8FD9\u662F\u8BB0\u5FC6/\u53EA\u8BFB\u95EE\u7B54\uFF1A\u76F4\u63A5\u56DE\u7B54\u4E3B\u4EBA\uFF1B\u4E0D\u8981\u8C03\u7528 tihu dispatch\uFF0C\u4E0D\u8981\u65B0\u5EFA\u4EFB\u52A1\u3002" }
    ]);
    if (!sent.ok) showInputError(device, sent.error, "\u6307\u6325\u4F1A\u8BDD\u6CA1\u6709\u63A5\u4F4F\u8FD9\u53E5\u8BDD\uFF0C\u8BF7\u91CD\u8BF4");
  }
  function dispatchKeyOf(text) {
    return String(text ?? "").toLowerCase().replace(/[\s，,。.!！?？:：、；;"'"'（）()\[\]【】《》\-_/\\]+/g, "");
  }
  function pendingCommanderTaskIdOf(text) {
    const key = dispatchKeyOf(text);
    const hit = pendingCommanderTask.get(key);
    if (hit === void 0) return void 0;
    const task = tasks.get(hit.taskId);
    if (task === void 0 || task.state === "archived") {
      pendingCommanderTask.delete(key);
      return void 0;
    }
    return hit.taskId;
  }
  function releasePendingCommanderTask(taskId) {
    for (const [key, hit] of pendingCommanderTask) {
      if (hit.taskId === taskId) pendingCommanderTask.delete(key);
    }
    dropCommanderAsksForTask(taskId);
    if (commanderWait?.taskId === taskId) stopCommanderWait();
  }
  function pushCommanderAsk(ask) {
    const at = commanderAsks.findIndex((item) => item.key === ask.key);
    if (at >= 0) commanderAsks.splice(at, 1);
    commanderAsks.push(ask);
  }
  function dropCommanderAsk(key) {
    for (let i = commanderAsks.length - 1; i >= 0; i -= 1) {
      if (commanderAsks[i].key === key) commanderAsks.splice(i, 1);
    }
  }
  function dropCommanderAsksForTask(taskId) {
    for (let i = commanderAsks.length - 1; i >= 0; i -= 1) {
      if (commanderAsks[i].taskId === taskId) commanderAsks.splice(i, 1);
    }
  }
  function dropContinuityAsks() {
    for (let i = commanderAsks.length - 1; i >= 0; i -= 1) {
      if (commanderAsks[i].kind === "continuity") commanderAsks.splice(i, 1);
    }
  }
  function clipForLog(value, maxChars = 80) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    const chars = [...text];
    return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}\u2026` : text;
  }
  async function commanderSessionHints() {
    const hints = [];
    for (const card of projectCards() ?? []) {
      if (hints.length >= 8) break;
      let candidates = [];
      try {
        candidates = await projectCuSessionsOf(card);
      } catch {
        candidates = [];
      }
      for (const candidate of candidates.slice(0, 3)) {
        if (hints.length >= 8) break;
        const short = candidate.sessionId.replace(/^session-/, "").slice(0, 8);
        const title = candidate.title.trim() === "" ? "\u672A\u547D\u540D\u4F1A\u8BDD" : taskTitleOf(candidate.title, 14);
        hints.push(`- ${card.name}: ${short} ${title}`);
      }
    }
    return hints;
  }
  function cardForCommanderProject(project) {
    const key = String(project ?? "").trim();
    if (key === "") return void 0;
    if (/个人助手|assistant/i.test(key)) return ASSISTANT_CARD;
    const cards = projectCards() ?? [];
    const lower = key.toLowerCase();
    return cards.find((card) => card.id === key || card.name === key) ?? cards.find((card) => card.name.toLowerCase().includes(lower) || lower.includes(card.name.toLowerCase())) ?? cards.find((card) => String(card.folder ?? "").toLowerCase().includes(lower));
  }
  function commanderAskForTurn(turn, final = false) {
    if (turn !== void 0) {
      const hit = commanderAsks.find((ask) => ask.turn === turn);
      if (hit !== void 0) return hit;
      if (final && commanderTurnReplied.has(turn)) return void 0;
      const unassigned = commanderAsks.filter((ask) => ask.turn === void 0);
      return unassigned.length === 1 ? unassigned[0] : void 0;
    }
    return commanderAsks.length === 1 ? commanderAsks[0] : void 0;
  }
  function assignCommanderTurn(turn) {
    if (!Number.isFinite(turn) || turn <= 0) return;
    const ask = commanderAsks.find((item) => item.turn === void 0);
    if (ask !== void 0) ask.turn = turn;
  }
  async function settleCommanderReply(raw, final, turn) {
    const ask = commanderAskForTurn(turn, final);
    if (ask === void 0) return;
    if (turn !== void 0) {
      commanderTurnReplied.add(turn);
      if (commanderTurnReplied.size > 64) {
        const keep = [...commanderTurnReplied].sort((a, b) => a - b).slice(-32);
        commanderTurnReplied.clear();
        for (const value of keep) commanderTurnReplied.add(value);
      }
    }
    const decision = parseCommanderDecision(raw, TIHU_TOOL_NAME_LIST);
    if (decision === void 0) {
      if (!final) return;
      commanderAsks.splice(commanderAsks.indexOf(ask), 1);
      await fallbackCommanderReply(ask, raw);
      return;
    }
    commanderAsks.splice(commanderAsks.indexOf(ask), 1);
    if (decision.kind === "control") {
      await runCommanderControl(ask, decision);
      return;
    }
    if (decision.kind === "clarify" || decision.kind === "control-unknown") {
      const why = decision.kind === "control-unknown" ? `\u5224\u6210\u63A7\u5236\u610F\u56FE\uFF0C\u4F46\u300C${decision.said}\u300D\u4E0D\u662F\u5DE5\u5177\u6CE8\u518C\u8868\u91CC\u7684\u540D\u5B57` : "\u4E24\u79CD\u89E3\u91CA\u90FD\u8BF4\u5F97\u901A";
      log(`tihu semantic clarify kind=${decision.kind} text=${JSON.stringify(ask.text)} \u4E3A\u4EC0\u4E48=${why}`);
      try {
        appendTihuLaneLog(commanderSessionId ?? "-", new Error(`\u6307\u6325\u53F0\u7ED3\u8BBA=\u4E24\u53EF\uFF08${why}\uFF09\u539F\u6587=${JSON.stringify(clipForLog(raw))}`), "commander-clarify");
      } catch {
      }
      await askIntentClarify(ask, decision.kind === "clarify" ? decision.question : "");
      return;
    }
    await applyCommanderReply(ask, decision.dispatch, raw);
  }
  async function applyCommanderReply(ask, reply, raw) {
    stopCommanderWait();
    if (controlHandledOf(ask.text)) {
      log(`tihu commander dispatch skipped\uFF08\u8FD9\u53E5\u5DF2\u7ECF\u6309\u5C4F\u4E0A\u547D\u4EE4\u529E\u8FC7\uFF09text=${JSON.stringify(ask.text)}`);
      return;
    }
    if (justDispatchedOf(ask.text)) {
      log(`tihu commander dispatch skipped\uFF08\u8FD9\u53E5\u521A\u6D3E\u6210\u4EFB\u52A1 ${justDispatchedOf(ask.text)?.taskId}\uFF09text=${JSON.stringify(ask.text)}`);
      return;
    }
    const selfTool = commanderCalledToolForTurn(ask.turn);
    if (selfTool !== void 0) {
      noteControlHandled(ask.key, selfTool);
      log(`tihu commander dispatch skipped\uFF08\u8FD9\u4E00\u8F6E\u6307\u6325\u53F0\u81EA\u5DF1\u8C03\u4E86 ${selfTool}\uFF09text=${JSON.stringify(ask.text)}`);
      try {
        appendTihuLaneLog(commanderSessionId ?? "-", new Error(`\u6307\u6325\u53F0\u81EA\u5DF1\u8C03\u4E86\u5DE5\u5177 ${selfTool} \u2192 \u8FD9\u53E5\u4E0D\u6D3E\u5355\uFF08\u4E00\u53E5\u53EA\u6709\u4E00\u6761\u8DEF\u7531\uFF09`), "commander-self-tool");
      } catch {
      }
      return;
    }
    const device = [...devices].find((item) => item.unified);
    const card = ask.kind === "continuity" && ask.card !== void 0 ? ask.card : cardForCommanderProject(reply.project);
    const target = card ?? ASSISTANT_CARD;
    const meta = {
      via: ask.via,
      continuity: reply.session,
      confidence: ask.confidence ?? 1,
      clarify: "no",
      ...ask.taskId === void 0 ? {} : { reuseTaskId: ask.taskId }
    };
    const line = `\u6307\u6325\u53F0 JSON \u7ED3\u8BBA \u539F\u6587=${JSON.stringify(clipForLog(raw))} \u9879\u76EE=${reply.project || "(\u672A\u70B9\u540D)"} \u843D\u70B9=${target.name} \u4F1A\u8BDD=${reply.session}${reply.appendTo === "" ? "" : ` \u7EED=${reply.appendTo}`}`;
    try {
      appendTihuLaneLog(commanderSessionId ?? "-", new Error(line), "commander-json");
    } catch {
    }
    log(`tihu ${line}`);
    if (reply.session === "append") {
      let candidates = [];
      try {
        candidates = await projectCuSessionsOf(target);
      } catch {
        candidates = [];
      }
      const hit = findContinuityTarget(candidates, reply.appendTo);
      if (hit !== void 0) {
        const task = await appendToSession(device, ask.text, target, hit, { ...meta, continuity: "append" });
        if (task !== void 0) return;
        return;
      }
      try {
        appendTihuLaneLog("-", new Error(`\u6307\u6325\u53F0\u8BF4\u7EED ${reply.appendTo}\uFF0C\u4F46\u9879\u76EE\u300C${target.name}\u300D\u4E0B\u6CA1\u6709\u8FD9\u6761 CU \u4F1A\u8BDD\uFF1B\u6309\u65B0\u5EFA\u6D3E\u51FA`), "commander-append-miss");
      } catch {
      }
      log(`tihu commander append miss target=${reply.appendTo} project=${target.id}`);
    }
    const followed = await followPreviousDispatch(device, ask.text, target.id);
    if (followed !== void 0) {
      reportFollowFailure(device, followed);
      return;
    }
    const outcome = await dispatchWithContinuity(device, ask.text, target, { via: ask.via }, { allowCommander: false });
    if (outcome.task === void 0 && outcome.message.startsWith("\u9519\u8BEF")) {
      showInputError(device, new Error(outcome.message), "\u8FD9\u6761\u6CA1\u6D3E\u51FA\u53BB\uFF0C\u8BF7\u91CD\u8BF4");
    }
  }
  async function fallbackCommanderReply(ask, raw) {
    if (ask.kind === "continuity") {
      log(`tihu commander continuity reply unusable text=${JSON.stringify(clipForLog(raw))}`);
      return;
    }
    if (controlHandledOf(ask.text)) {
      stopCommanderWait();
      log(`tihu commander fallback skipped\uFF08\u8FD9\u53E5\u5DF2\u7ECF\u6309\u5C4F\u4E0A\u547D\u4EE4\u529E\u8FC7\uFF09text=${JSON.stringify(ask.text)}`);
      return;
    }
    const selfTool = commanderCalledToolForTurn(ask.turn);
    if (selfTool !== void 0) {
      stopCommanderWait();
      noteControlHandled(ask.key, selfTool);
      log(`tihu commander fallback skipped\uFF08\u8FD9\u4E00\u8F6E\u6307\u6325\u53F0\u81EA\u5DF1\u8C03\u4E86 ${selfTool}\uFF09text=${JSON.stringify(ask.text)}`);
      try {
        appendTihuLaneLog(commanderSessionId ?? "-", new Error(`\u6307\u6325\u53F0\u81EA\u5DF1\u8C03\u4E86\u5DE5\u5177 ${selfTool} \u2192 \u8FD9\u53E5\u4E0D\u6D3E\u5355\uFF08\u4E00\u53E5\u53EA\u6709\u4E00\u6761\u8DEF\u7531\uFF09`), "commander-self-tool");
      } catch {
      }
      return;
    }
    stopCommanderWait();
    const reason = String(raw ?? "").trim() === "" ? "\u56DE\u590D\u4E3A\u7A7A" : "\u56DE\u590D\u91CC\u6CA1\u6709\u53EF\u7528\u7ED3\u8BBA";
    const device = deviceOfCommanderAsk(ask);
    const followed = await followPreviousDispatch(device, ask.text);
    if (followed !== void 0) return;
    const cards = projectCards() ?? [];
    const route = routeQuick({ text: ask.text, cards, tasks: tasks.list() });
    if (ask.kind === "intent" && !workSignalOf(route)) {
      try {
        appendTihuLaneLog("-", new Error(`${reason}\uFF08${clipForLog(raw) || "\u7A7A"}\uFF09\uFF1A\u672C\u5730\u4E5F\u6CA1\u6709\u5DE5\u4F5C\u4FE1\u53F7 \u2192 \u5C4F\u4E0A\u95EE\u4E00\u6B21\uFF0C\u4E0D\u731C\u7740\u6D3E\u5355`), "commander-clarify");
      } catch {
      }
      log(`tihu commander ${reason} text=${JSON.stringify(ask.text)} -> \u95EE\u4E00\u6B21\uFF08\u4E0D\u6D3E\u5355\uFF09`);
      await askIntentClarify(ask, "");
      return;
    }
    try {
      appendTihuLaneLog("-", new Error(`${reason}\uFF08${clipForLog(raw) || "\u7A7A"}\uFF09\uFF0C\u9000\u56DE routeQuick/\u6700\u4F73\u5361`), "commander-fallback");
    } catch {
    }
    log(`tihu commander ${reason} -> routeQuick/best-card fallback text=${JSON.stringify(ask.text)}`);
    let card;
    let via = "commander-fallback";
    let note = "\u6307\u6325\u53F0\u6CA1\u7ED9\u51FA\u7ED3\u8BBA\uFF0C\u5148\u6309\u6700\u4F73\u5361\u6D3E\u51FA";
    if (route.kind === "card") {
      if (!isConfidentProjectRoute(route)) {
        card = ASSISTANT_CARD;
        via = "fallback-weak-assistant";
        note = "\u5224\u4E0D\u51C6\u9879\u76EE\uFF0C\u5148\u6D3E\u7ED9\u4E2A\u4EBA\u52A9\u624B";
      } else {
        card = route.card;
        via = "fallback-route";
      }
    } else if (route.kind === "daily") {
      card = ASSISTANT_CARD;
      via = "fallback-daily";
    } else if (route.kind === "append") {
      card = { id: route.task.projectId, name: route.task.projectName, ...route.task.folder === void 0 ? {} : { folder: route.task.folder } };
      via = "fallback-append";
    } else if (route.kind === "ambiguous") {
      card = route.candidates[0];
      via = "fallback-best";
    }
    if (card === void 0) card = bestCardMatchOf(ask.text, cards);
    if (card === void 0) card = ASSISTANT_CARD;
    const task = await dispatchToCard(device, ask.text, card, void 0, {
      via,
      continuity: "new",
      clarify: "no",
      reuseTaskId: ask.taskId,
      note
    });
    if (task !== void 0) log(`tihu commander fallback dispatched task=${task.taskId} project=${card.id} via=${via}`);
  }
  function stopCommanderWait() {
    if (commanderWait === void 0) return;
    clearInterval(commanderWait.ticker);
    if (commanderWait.paintTimer !== void 0) clearTimeout(commanderWait.paintTimer);
    commanderWait = void 0;
  }
  function commanderWaitFrameOf(text, startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1e3));
    return {
      // 语义路由这一屏不预设是派单：指挥台可能判成「这句话是冲这块屏说的」。
      ...noticeFrame({ stage: "\u5224\u65AD", title: "\u6B63\u5728\u5224\u65AD\u8FD9\u53E5\u8BDD", lines: [taskTitleOf(text, 16), `\u5DF2\u7B49 ${seconds} \u79D2`], tone: "busy" }),
      // 等待不设超时：必须给一个「主页」出口，用户回棋盘后判断仍在后台继续。
      actions: [{ id: "taskBoard", label: "\u4E3B\u9875" }]
    };
  }
  function beginCommanderWait(device, text, taskId) {
    stopCommanderWait();
    const startedAt = Date.now();
    const key = device.sessionId ?? device.id;
    for (const target of devices) target.waitMuted = false;
    const draw = () => {
      if (disposed || commanderWait === void 0) return;
      const frame = commanderWaitFrameOf(text, startedAt);
      lastFrames.set(device.sessionId ?? device.id, frame);
      for (const target of devices) {
        if (!target.unified) continue;
        if (target.waitMuted === true) continue;
        disarmAutoHome(target);
        if (target.receiptTimer !== void 0) {
          clearTimeout(target.receiptTimer);
          target.receiptTimer = void 0;
        }
        target.pendingPick = void 0;
        target.focusedTask = void 0;
        target.onBoard = false;
        pushFrame(target, frame);
      }
    };
    const firstTimer = setTimeout(() => {
      draw();
      if (disposed || commanderWait === void 0) return;
      const ticker = setInterval(draw, 1e3);
      ticker.unref?.();
      commanderWait.ticker = ticker;
    }, COMMANDER_WAIT_PAINT_MS);
    firstTimer.unref?.();
    commanderWait = { text, key, taskId, startedAt, ticker: firstTimer, paintTimer: firstTimer };
    log(`tihu commander wait session=${commanderSessionId ?? "-"} text=${JSON.stringify(text)}`);
  }
  async function fallbackCommanderDispatch(device, text, pendingTaskId, error, stage) {
    stopCommanderWait();
    const reason = error?.message ?? String(error);
    log(`tihu commander ${stage} failed -> personal assistant fallback: ${reason}`);
    try {
      const task2 = await dispatchToCard(device, text, ASSISTANT_CARD, void 0, {
        via: "commander-fallback",
        continuity: "new",
        clarify: "no",
        ...pendingTaskId === void 0 ? {} : { reuseTaskId: pendingTaskId },
        note: "\u6307\u6325\u53F0\u6CA1\u63A5\u4F4F\uFF0C\u5148\u6D3E\u7ED9\u4E2A\u4EBA\u52A9\u624B"
      });
      if (task2 !== void 0) {
        device.send("event.progress", {
          stage: "\u6D3E\u5355",
          text: "\u6307\u6325\u53F0\u6CA1\u63A5\u4F4F\uFF0C\u5DF2\u5148\u6D3E\u7ED9\u4E2A\u4EBA\u52A9\u624B"
        });
        log(`tihu commander fallback task=${task2.taskId} session=${task2.sessionIds[task2.sessionIds.length - 1] ?? "-"}`);
        return;
      }
    } catch (failure) {
      log(`tihu commander fallback dispatch threw: ${failure?.message ?? String(failure)}`);
    }
    const task = pendingTaskId === void 0 ? void 0 : tasks.get(pendingTaskId);
    if (task !== void 0 && task.state !== "archived") {
      tasks.drop(task.taskId);
      refreshBoards();
    }
    broadcastBoardSnapshot();
    if (pendingTaskId !== void 0) releasePendingCommanderTask(pendingTaskId);
    showInputError(device, error, "\u6307\u6325\u53F0\u6CA1\u63A5\u4F4F\uFF0C\u4E2A\u4EBA\u52A9\u624B\u4E5F\u6CA1\u6D3E\u51FA\u53BB\uFF0C\u8BF7\u91CD\u8BF4");
  }
  function controlHandledOf(text) {
    const hit = controlHandled.get(dispatchKeyOf(text));
    if (hit === void 0 || Date.now() - hit.at > FALLBACK_DEDUPE_MS) return void 0;
    return hit;
  }
  function noteControlHandled(key, tool) {
    controlHandled.set(key, { tool, at: Date.now() });
    for (const [oldKey, hit] of controlHandled) {
      if (Date.now() - hit.at > FALLBACK_DEDUPE_MS) controlHandled.delete(oldKey);
    }
  }
  function justDispatchedOf(text) {
    const hit = fallbackDispatch;
    if (hit === void 0) return void 0;
    if (hit.key !== dispatchKeyOf(text)) return void 0;
    if (Date.now() - hit.at > FALLBACK_DEDUPE_MS) return void 0;
    return hit;
  }
  function workSignalOf(route) {
    return route.kind === "card" && isConfidentProjectRoute(route);
  }
  function deviceOfCommanderAsk(ask) {
    if (ask.device !== void 0) {
      const direct = [...devices].find((item) => item.id === ask.device);
      if (direct !== void 0) return direct;
    }
    return [...devices].find((item) => item.unified);
  }
  function noteCommanderToolCall(turn, rawName) {
    const name2 = String(rawName ?? "").trim();
    if (!TIHU_TOOL_NAME_LIST.some((tool) => tool.toLowerCase() === name2.toLowerCase()) || name2 === "") return;
    const key = turn ?? 0;
    const rows = commanderToolCalls.get(key) ?? [];
    rows.push(name2);
    commanderToolCalls.set(key, rows);
    if (commanderToolCalls.size > 64) {
      const keep = [...commanderToolCalls.keys()].sort((a, b) => a - b).slice(-32);
      for (const oldKey of [...commanderToolCalls.keys()]) if (!keep.includes(oldKey)) commanderToolCalls.delete(oldKey);
    }
    log(`tihu semantic control \u6307\u6325\u53F0\u81EA\u5DF1\u8C03\u4E86 ${name2} turn=${key}`);
  }
  function commanderCalledToolForTurn(turn) {
    if (turn === void 0) return void 0;
    const rows = commanderToolCalls.get(turn);
    if (rows === void 0 || rows.length === 0) return void 0;
    return rows[0];
  }
  function registeredToolRunner() {
    const runner = runRegisteredTihuTool;
    if (runner === void 0) throw new Error("\u63A7\u5236\u9762\u8FD8\u6CA1\u5EFA\u8D77\u6765\uFF08tihu \u8FD0\u884C\u65F6\u5185\u90E8\u987A\u5E8F\u4E0D\u5BF9\uFF09");
    return runner;
  }
  function showControlOutcome(device, tool, result) {
    const line = String(result ?? "").split("\n")[0] ?? "";
    log(`tihu semantic control tool=${tool} \u7ED3\u679C=${JSON.stringify(clipForLog(result))}`);
    device.send("event.progress", { stage: "\u5C4F\u4E0A\u547D\u4EE4", text: clipScreenBullet(line, 40) });
  }
  async function runCommanderControl(ask, decision) {
    stopCommanderWait();
    clearGrayFallback();
    const device = deviceOfCommanderAsk(ask);
    const called = commanderCalledToolForTurn(ask.turn);
    if (called !== void 0) {
      noteControlHandled(ask.key, called);
      log(`tihu semantic control text=${JSON.stringify(ask.text)} \u6A21\u578B\u5DF2\u81EA\u8C03 ${called} -> \u4E0D\u8865\u8C03\u3001\u4E0D\u6D3E\u5355`);
      return;
    }
    const args = { ...decision.args ?? {} };
    if (device !== void 0 && args.deviceId === void 0) args.deviceId = device.id;
    try {
      const result = await registeredToolRunner()(decision.tool, args, { sessionId: commanderSessionId });
      noteControlHandled(ask.key, decision.tool);
      try {
        appendTihuLaneLog(commanderSessionId ?? "-", new Error(`\u6307\u6325\u53F0\u8BED\u4E49\u7ED3\u8BBA=\u63A7\u5236\u610F\u56FE \u5DE5\u5177=${decision.tool} \u8FD9\u53E5=${JSON.stringify(clipForLog(ask.text))}`), "commander-control");
      } catch {
      }
      if (device !== void 0) showControlOutcome(device, decision.tool, result);
    } catch (error) {
      noteControlHandled(ask.key, decision.tool);
      log(`tihu semantic control tool=${decision.tool} failed: ${error?.message ?? String(error)}`);
      try {
        appendTihuLaneLog(commanderSessionId ?? "-", error, "commander-control-failed");
      } catch {
      }
      if (device !== void 0) showInputError(device, error, "\u8FD9\u53E5\u662F\u5C4F\u4E0A\u547D\u4EE4\uFF0C\u6CA1\u529E\u6210\uFF08\u6CA1\u6709\u6D3E\u5355\uFF09");
    }
  }
  async function askIntentClarify(ask, question) {
    stopCommanderWait();
    clearGrayFallback();
    const askedAt = clarifyAsked.get(ask.key);
    const alreadyAsked = askedAt !== void 0 && Date.now() - askedAt < CLARIFY_ONCE_MS;
    if (!alreadyAsked) clarifyAsked.set(ask.key, Date.now());
    for (const [oldKey, at] of clarifyAsked) {
      if (Date.now() - at > CLARIFY_ONCE_MS) clarifyAsked.delete(oldKey);
    }
    const device = deviceOfCommanderAsk(ask);
    const targets = [...devices].filter((item) => item.unified);
    if (targets.length === 0 && device !== void 0) targets.push(device);
    if (targets.length === 0) {
      log(`tihu semantic clarify \u6CA1\u6709\u53EF\u95EE\u7684\u5C4F\uFF0C\u8FD9\u53E5\u4E0D\u6D3E\u5355 text=${JSON.stringify(ask.text)}`);
      return;
    }
    const frame = intentClarifyFrame({ text: ask.text, question, alreadyAsked });
    for (const target of targets) {
      disarmAutoHome(target);
      if (target.receiptTimer !== void 0) {
        clearTimeout(target.receiptTimer);
        target.receiptTimer = void 0;
      }
      target.pendingPick = void 0;
      target.pendingClarify = void 0;
      target.focusedTask = void 0;
      target.onBoard = false;
      target.pendingIntent = { text: ask.text, question, key: ask.key };
      lastFrames.set(target.sessionId ?? target.id, frame);
      pushFrame(target, frame);
    }
    pushTaskNotify(void 0, 0, alreadyAsked ? "\u8FD9\u53E5\u5224\u4E0D\u51C6\uFF0C\u8BF7\u91CD\u8BF4" : `\u8FD9\u53E5\u4E24\u53EF\uFF0C\u5148\u95EE\u4E00\u53E5\uFF1A${ask.text}`);
    if (intentClarifyTimer !== void 0) clearTimeout(intentClarifyTimer);
    const timer = setTimeout(() => {
      intentClarifyTimer = void 0;
      if (disposed) return;
      for (const item of devices) {
        const pending = item.pendingIntent;
        if (pending === void 0) continue;
        item.pendingIntent = void 0;
        log(`tihu semantic clarify \u6CA1\u7B54\uFF0C\u8FD9\u53E5\u4E0D\u6D3E\u5355 text=${JSON.stringify(pending.text)}`);
        void runScreenCommand(item, { kind: "board" });
      }
    }, tihuClarifyMs());
    timer.unref?.();
    intentClarifyTimer = timer;
    log(`tihu semantic clarify text=${JSON.stringify(ask.text)} \u5DF2\u95EE\u8FC7=${alreadyAsked}`);
  }
  async function resolveIntentClarify(device, choice) {
    const pending = device.pendingIntent;
    if (pending === void 0) return;
    device.pendingIntent = void 0;
    if (intentClarifyTimer !== void 0) {
      clearTimeout(intentClarifyTimer);
      intentClarifyTimer = void 0;
    }
    if (choice === "skip") {
      log(`tihu semantic clarify \u7528\u6237\u9009\u300C\u5148\u4E0D\u7BA1\u300D\uFF0C\u8FD9\u53E5\u4E0D\u6D3E\u5355 text=${JSON.stringify(pending.text)}`);
      await runScreenCommand(device, { kind: "board" });
      return;
    }
    const cards = projectCards() ?? [];
    const route = routeQuick({ text: pending.text, cards, tasks: tasks.list() });
    const card = route.kind === "card" ? route.card : bestCardMatchOf(pending.text, cards) ?? ASSISTANT_CARD;
    log(`tihu semantic clarify \u7528\u6237\u9009\u300C\u5E72\u6D3B\u300D\uFF0C\u6309\u6700\u4F73\u5361\u6D3E\u51FA text=${JSON.stringify(pending.text)} project=${card.id}`);
    await dispatchWithContinuity(device, pending.text, card, { via: "clarified-work" }, { allowCommander: false });
  }
  async function askCommander(device, text, options2 = {}) {
    device.unified = true;
    stopCommanderWait();
    const key = dispatchKeyOf(text);
    const kind = options2.kind ?? "intent";
    try {
      const commander = await ensureCommanderSession();
      if (commander === void 0) {
        await fallbackCommanderDispatch(device, text, void 0, new Error("\u4F1A\u8BDD\u65B0\u5EFA\u5931\u8D25\uFF1A\u5BBF\u4E3B sessionController \u4E0D\u53EF\u7528"), "ensure");
        return;
      }
      beginCommanderWait(device, text);
      pushCommanderAsk({
        key,
        text,
        kind,
        device: device.id,
        via: "commander",
        askedAt: Date.now()
      });
      let hints = [];
      try {
        hints = await commanderSessionHints();
      } catch {
        hints = [];
      }
      let boardLines = [];
      try {
        boardLines = commanderBoardLines(device);
      } catch {
        boardLines = [];
      }
      const sent = await promptSession(commander, [{ type: "text", text }, { type: "text", text: commanderReplyTail(hints, boardLines) }]);
      if (!sent.ok) {
        dropCommanderAsk(key);
        await fallbackCommanderDispatch(device, text, void 0, sent.error, "prompt");
      }
    } catch (error) {
      dropCommanderAsk(key);
      await fallbackCommanderDispatch(device, text, void 0, error, "exception");
    }
  }
  async function cancelTask(device, taskId) {
    const task = tasks.get(taskId);
    if (task === void 0) {
      device.send("event.progress", { stage: "\u64A4\u5355", text: "\u6CA1\u6709\u8FD9\u6761\u4EFB\u52A1" });
      return false;
    }
    if (task.source === "pc") {
      const removed = tasks.archive(task.taskId);
      if (removed !== void 0) appendTaskJournal(removed);
      dismissExternalTask(task);
      device.focusedTask = void 0;
      sendFrame(device, noticeFrame({ stage: "\u64A4\u5355", title: `\u5DF2\u64A4\u6389\uFF1A${task.title}`, lines: ["\u7535\u8111\u7AEF\u4F1A\u8BDD\u7167\u5E38\uFF0C\u53EA\u662F\u4E0D\u518D\u4E0A\u5C4F"], tone: "idle" }));
      refreshBoards();
      log(`tihu cancel pc task=${task.taskId}`);
      return true;
    }
    if (task.state === "running" || task.state === "awaiting") {
      device.send("event.progress", {
        stage: "\u64A4\u5355",
        text: `\u300C${task.title}\u300D\u5DF2\u7ECF\u5F00\u8DD1\u4E86\uFF1A\u8981\u64A4\u5F97\u5148\u5728\u7535\u8111\u7AEF\u505C\u6389\u5B83\uFF0C\u505C\u4E86\u518D\u64A4`
      });
      sendFrame(device, noticeFrame({ stage: "\u64A4\u5355", title: "\u8FD9\u6761\u5DF2\u7ECF\u5F00\u8DD1\u4E86", lines: ["\u5728\u7535\u8111\u7AEF\u505C\u6389\u5B83\uFF0C\u518D\u64A4"], tone: "alert" }));
      return false;
    }
    const journal = tasks.archive(task.taskId);
    if (journal !== void 0) appendTaskJournal(journal);
    device.focusedTask = void 0;
    sendFrame(device, noticeFrame({ stage: "\u64A4\u5355", title: `\u5DF2\u64A4\u6389\uFF1A${task.title}`, lines: ["\u8FD8\u6CA1\u5F00\u59CB\u8DD1\uFF0C\u76F4\u63A5\u62FF\u6389\u4E86"], tone: "idle" }));
    sendTaskUpdate(device, task);
    refreshBoards();
    log(`tihu cancel task=${task.taskId}`);
    return true;
  }
  function appendTaskJournal(line) {
    try {
      const home = ensureAssistantHome();
      const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const file = join14(home.journal, `${day}.md`);
      const header = `## \u4EFB\u52A1\u5F52\u6863
`;
      let prefix = "";
      try {
        const existing = readFileSync10(file, "utf8");
        if (!existing.includes("## \u4EFB\u52A1\u5F52\u6863")) prefix = existing.endsWith("\n") ? `
${header}` : `

${header}`;
      } catch {
        prefix = `# ${day}

${header}`;
      }
      appendFileSync4(file, `${prefix}${line}
`, "utf8");
    } catch (error) {
      log(`tihu journal failed: ${error?.message ?? String(error)}`);
    }
  }
  async function runScreenCommand(device, command) {
    if (command.kind === "board") {
      sendBoard(device, true);
      return;
    }
    if (command.kind === "open") {
      const rows = boardOf(tasks.list(), Date.now(), Math.max(0, device.boardPage ?? 0)).rows;
      const target = command.index !== void 0 ? rows[command.index - 1] : rows[0];
      if (target === void 0) {
        sendFrame(device, noticeFrame({ stage: "\u4EFB\u52A1", title: "\u73B0\u5728\u6CA1\u6709\u53EF\u770B\u7684\u4EFB\u52A1", lines: ["\u8BF4\u4E00\u53E5\u8BDD\u5C31\u6D3E\u5355"], tone: "idle" }));
        return;
      }
      openTask(device, target.taskId);
      return;
    }
    if (command.kind === "stop") {
      let outcome;
      try {
        outcome = await stopDevicePlayback(device);
      } catch (error) {
        showInputError(device, error, "\u505C\u6B62\u6717\u8BFB\u5931\u8D25");
        return;
      }
      if (outcome.kind === "idle") {
        device.send("event.progress", { stage: "\u505C\u6B62", text: "\u672C\u6765\u5C31\u6CA1\u5728\u6717\u8BFB" });
        return;
      }
      if (outcome.kind === "listening") {
        device.send("event.progress", {
          stage: "\u505C\u6B62",
          text: outcome.ack === void 0 ? "\u5DF2\u9000\u51FA\u300C\u5728\u542C\u300D\uFF08\u8BBE\u5907\u672A\u56DE\u6267\uFF09" : "\u5DF2\u9000\u51FA\u300C\u5728\u542C\u300D"
        });
        return;
      }
      if (outcome.kind === "sent") {
        device.send("event.progress", { stage: "\u505C\u6B62", text: "\u5DF2\u4E0B\u53D1\u505C\u6B62\uFF08\u8BBE\u5907\u672A\u56DE\u6267\uFF09" });
        return;
      }
      const echo = ackEcho(outcome.ack);
      device.send("event.progress", {
        stage: "\u505C\u6B62",
        text: echo === void 0 ? "\u5DF2\u505C\u6B62\u6717\u8BFB" : `\u5DF2\u505C\u6B62\u6717\u8BFB\uFF08\u505C\u5728 ${echo}\uFF09`
      });
      return;
    }
    if (command.kind === "cancel") {
      const target = device.focusedTask ?? tasks.list().filter((task) => task.state === "queued" || task.state === "running").sort((a, b) => b.updatedAt - a.updatedAt)[0]?.taskId;
      if (target === void 0) {
        sendFrame(device, noticeFrame({ stage: "\u64A4\u5355", title: "\u73B0\u5728\u6CA1\u6709\u53EF\u64A4\u7684\u4EFB\u52A1", lines: [], tone: "idle" }));
        return;
      }
      await cancelTask(device, target);
      return;
    }
    if (command.kind === "confirm") {
      device.send("event.progress", { stage: "\u6388\u6743", text: "\u9700\u8981\u5728\u7535\u8111\u7AEF\u786E\u8BA4\uFF0C\u8BBE\u5907\u5C4F\u4E0D\u5904\u7406\u6388\u6743" });
      return;
    }
    if (command.kind === "pick") {
      if (device.pendingClarify !== void 0) {
        await resolveClarify(device, command.index === 1 ? "new" : "same");
        return;
      }
      if (device.pendingPick !== void 0) {
        const pick = device.pendingPick;
        device.pendingPick = void 0;
        const card = pick.candidates[command.index - 1];
        if (card !== void 0) {
          await dispatchWithContinuity(device, pick.text, card, { via: "pick" }, { allowCommander: true });
          return;
        }
      }
      const rows = boardOf(tasks.list(), Date.now()).rows;
      const target = rows[command.index - 1];
      if (target !== void 0) openTask(device, target.taskId);
    }
  }
  async function dispatchUtterance(device, text) {
    const value = stripWakeWord(String(text ?? ""));
    if (value === "") return;
    if (device.pendingIntent !== void 0) {
      const index = chineseIndex(value);
      if (index === 1 || index === 2) {
        await resolveIntentClarify(device, index === 1 ? "work" : "skip");
        return;
      }
      const dropped = device.pendingIntent;
      device.pendingIntent = void 0;
      if (intentClarifyTimer !== void 0) {
        clearTimeout(intentClarifyTimer);
        intentClarifyTimer = void 0;
      }
      log(`tihu semantic clarify \u7528\u6237\u8BF4\u4E86\u522B\u7684\uFF0C\u539F\u6765\u90A3\u53E5\u4E0D\u731C\u7740\u6D3E\u5355 text=${JSON.stringify(dropped.text)}`);
    }
    if (device.pendingClarify !== void 0) {
      const choice = clarifyChoiceOf(value);
      if (choice !== void 0) {
        await resolveClarify(device, choice);
        return;
      }
      await resolveClarify(device, "new");
    }
    const pick = device.pendingPick;
    if (pick !== void 0) {
      const index = chineseIndex(value);
      if (index !== void 0 && index <= pick.candidates.length) {
        device.pendingPick = void 0;
        const card = pick.candidates[index - 1];
        await dispatchWithContinuity(device, pick.text, card, { via: "pick" }, { allowCommander: true });
        return;
      }
      if (/^(都不是|都不对|不对)/.test(value)) {
        device.pendingPick = void 0;
        await dispatchWithContinuity(device, pick.text, ASSISTANT_CARD, { via: "pick" }, { allowCommander: true });
        return;
      }
      device.pendingPick = void 0;
    }
    if (MEMORY_QUESTION.test(value)) {
      await answerDirect(device, value);
      return;
    }
    const command = parseScreenCommand(value);
    if (command !== void 0) {
      await runScreenCommand(device, command);
      return;
    }
    const route = routeQuick({ text: value, cards: projectCards() ?? [], tasks: tasks.list() });
    if (route.kind === "card") {
      const followed2 = await followPreviousDispatch(device, value, route.card.id);
      if (followed2 !== void 0) {
        reportFollowFailure(device, followed2);
        return;
      }
      const weak = weakProjectHitOf(route);
      if (weak !== void 0) {
        const context = previousDispatchTask();
        const corroborated = context !== void 0 && context.projectId === weak.card.id;
        if (!corroborated) {
          const reason = `\u4F4E\u7F6E\u4FE1\u9879\u76EE\u547D\u4E2D\uFF08via=${weak.via} \u7F6E\u4FE1=${weak.confidence.toFixed(2)}\uFF09\u4E0D\u5355\u72EC\u5B9A\u843D\u70B9\uFF0C\u4EA4\u7ED9\u6307\u6325\u53F0\u5224`;
          try {
            appendTihuLaneLog("-", new Error(reason), "weak-project-hit");
          } catch {
          }
          log(`tihu weak-project hit project=${weak.card.id} via=${weak.via} confidence=${weak.confidence.toFixed(2)} -> commander`);
          await askCommander(device, value);
          return;
        }
        log(`tihu weak-project hit project=${weak.card.id} via=${weak.via} confidence=${weak.confidence.toFixed(2)} corroborated by previous dispatch`);
      }
      await dispatchWithContinuity(device, value, route.card, { via: route.via ?? "card" }, { allowCommander: true });
      return;
    }
    if (route.kind === "append" || route.kind === "daily") {
      const followed2 = await followPreviousDispatch(device, value);
      if (followed2 !== void 0) {
        reportFollowFailure(device, followed2);
        return;
      }
      await askCommander(device, value);
      return;
    }
    if (route.kind === "ambiguous") {
      askWhich(device, route.candidates, value);
      return;
    }
    const followed = await followPreviousDispatch(device, value);
    if (followed !== void 0) {
      reportFollowFailure(device, followed);
      return;
    }
    await askCommander(device, value);
  }
  function reportFollowFailure(device, outcome) {
    if (outcome.task !== void 0 || !outcome.message.startsWith("\u9519\u8BEF")) return;
    showInputError(device, new Error(outcome.message), "\u8FD9\u6761\u6CA1\u6D3E\u51FA\u53BB\uFF0C\u8BF7\u91CD\u8BF4");
  }
  function controlDeviceOf(device) {
    return {
      id: device.id,
      ...typeof device.hello?.clientId === "string" && device.hello.clientId !== "" ? { clientId: device.hello.clientId } : {},
      ...device.sessionId === void 0 ? {} : { sessionId: device.sessionId },
      autoFollow: device.autoFollow,
      voice: device.voice,
      edgeVoice: device.edgeVoice,
      offlineOnly: device.offlineOnly,
      connectedAt: device.connectedAt,
      ...device.lastSeenAt === void 0 ? {} : { lastSeenAt: device.lastSeenAt },
      ...device.screenStage === void 0 ? {} : { screenStage: device.screenStage },
      ...device.handsfree === void 0 ? {} : { handsfree: device.handsfree }
    };
  }
  function findControlDevice(deviceId) {
    return [...devices].find((device) => device.id === deviceId || device.hello?.clientId === deviceId);
  }
  const RECENT_DEVICE_TTL_MS = 10 * 6e4;
  const recentDevices = /* @__PURE__ */ new Map();
  function rememberRecentDevice(device) {
    try {
      const now = Date.now();
      const snapshot = controlDeviceOf(device);
      recentDevices.set(device.id, {
        at: now,
        view: { ...snapshot, offline: true, lastSeenAt: device.lastSeenAt ?? now }
      });
      for (const [id, entry] of recentDevices) {
        if (now - entry.at > RECENT_DEVICE_TTL_MS) recentDevices.delete(id);
      }
      if (recentDevices.size > 20) {
        const oldest = [...recentDevices.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest !== void 0) recentDevices.delete(oldest[0]);
      }
    } catch {
    }
  }
  function controlRowOf(row) {
    return { sessionId: row.sessionId, title: humanTitle(row.title), preset: row.preset, live: row.live, updatedAt: row.updatedAt };
  }
  function onlineDeviceHint() {
    const ids = [...devices].map((device) => device.id);
    return ids.length === 0 ? "\u5F53\u524D\u6CA1\u6709\u9E48\u9E55\u8BBE\u5907\u5728\u7EBF\uFF1A\u5148\u5728\u624B\u673A/\u6D4F\u89C8\u5668\u6253\u5F00 /tihu\u3002" : `\u5728\u7EBF\u8BBE\u5907\uFF1A${ids.join("\u3001")}`;
  }
  function requireControlDevice(deviceId) {
    const device = findControlDevice(deviceId);
    if (device !== void 0) return device;
    throw new Error(`\u9E48\u9E55\u8BBE\u5907 ${deviceId} \u4E0D\u5728\u7EBF\uFF08\u53EF\u80FD\u521A\u65AD\u5F00\u6216\u6362\u4E86\u4E00\u5757\u5C4F\uFF09\u3002${onlineDeviceHint()}`);
  }
  function deviceSpeaking(device) {
    if (announcing.has(device.id)) return true;
    if (device.playback !== void 0) return device.playback.phase === "playing";
    return false;
  }
  async function stopDevicePlayback(device, scope = "round") {
    if (device.playback?.phase === "listening") {
      const ack2 = await awaitDeviceAck(device, "voice.listen", { on: false });
      device.playback = { phase: "idle", at: Date.now() };
      return { kind: "listening", ack: ack2 };
    }
    if (!deviceSpeaking(device)) return { kind: "idle" };
    try {
      device.cancelRound?.();
    } catch {
    }
    device.pausedAt = void 0;
    const ack = await awaitDeviceAck(device, "playback.control", { action: "stop", scope });
    if (ack !== void 0 && ack.ok === false) {
      throw new Error(`\u8BBE\u5907\u62D2\u7EDD\u505C\u6B62\u6717\u8BFB\uFF1A${ack.reason ?? "\u539F\u56E0\u672A\u77E5"}\uFF08${device.id}\uFF09`);
    }
    if (ack !== void 0) device.playback = { phase: "idle", at: Date.now() };
    return ack === void 0 ? { kind: "sent" } : { kind: "stopped", ack };
  }
  function boardEchoOf(device) {
    const board = boardOf(tasks.list(), Date.now(), Math.max(0, Math.trunc(device.boardPage ?? 0)));
    const counts = board.counts;
    return `\u68CB\u76D8\u7B2C ${board.page.index + 1}/${board.page.total} \u9875\uFF08\u7B49\u4F60 ${counts.awaiting} \xB7 \u5728\u8DD1 ${counts.running} \xB7 \u6392\u961F ${counts.queued} \xB7 \u5B8C\u6210 ${counts.done}\uFF09`;
  }
  function numberedRowsOfBoard(board) {
    return board.rows.map((row, index) => `${index + 1}) ${row.taskId} ${row.capsule} ${clipForLog(row.title, 14)}`);
  }
  function commanderBoardLines(device) {
    const board = boardOf(tasks.list(), Date.now(), Math.max(0, Math.trunc(device.boardPage ?? 0)));
    const rows = numberedRowsOfBoard(board);
    return [
      `\uFF08\u8FD9\u5757\u5C4F\u5728\u7B2C ${board.page.index + 1}/${board.page.total} \u9875\uFF1B\u884C\u53F7\u4ECE 1 \u5F00\u59CB\uFF0C\u5C4F\u4E0A\u7B2C\u4E00\u884C\uFF1D1\uFF0C\u300C\u7B2C\u4E8C\u4E2A\u300D\uFF1D\u7B2C 2 \u884C\uFF09`,
      ...rows.length === 0 ? ["\uFF08\u8FD9\u9875\u6CA1\u6709\u4EFB\u52A1\uFF09"] : rows
    ];
  }
  function screenEchoOf(device) {
    const stage = device.screenStage ?? "";
    const playback = device.playback;
    if (stage === "\u5B8C\u6210") {
      const total = Number(playback?.total);
      const line = Number(playback?.line);
      if (Number.isFinite(total) && total > 0 && Number.isFinite(line)) return `\u5B8C\u6210 \u7B2C ${line + 1}/${total} \u884C`;
      return "\u5B8C\u6210";
    }
    if (stage !== "") return stage;
    if (device.onBoard === true) return boardEchoOf(device);
    return "\u5C4F\u672A\u4E0A\u62A5";
  }
  function ackEcho(ack) {
    const stage = String(ack?.stage ?? "").trim();
    return stage === "" ? void 0 : stage;
  }
  function controlTaskRows() {
    return tasks.list().filter((task) => task.state !== "archived").map((task) => ({ taskId: task.taskId, title: task.title, capsule: capsuleOf(task.state), sub: subLineOf(task) }));
  }
  function stageWordOf(task) {
    if (task.state === "done" || task.state === "announced") return "\u5B8C\u6210\u9875";
    if (task.state === "awaiting") return "\u5F85\u51B3\u7B56\u9875";
    if (task.state === "running") return "\u8FDB\u5EA6\u9875";
    return "\u6392\u961F\u5361";
  }
  function resolveControlTask(device, options2) {
    const pool = tasks.list().filter((task) => task.state !== "archived");
    const latestFinished = () => [...pool].filter((task) => task.state === "done" || task.state === "announced").sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))[0];
    if (options2.recent === true) {
      const latest2 = latestFinished();
      if (latest2 === void 0) throw new Error("\u73B0\u5728\u6CA1\u6709\u5DF2\u5B8C\u6210\u7684\u4EFB\u52A1\u3002");
      return latest2;
    }
    const ref = options2.taskId ?? options2.title;
    if (ref !== void 0) {
      const outcome = matchTaskRows(controlTaskRows(), ref);
      if (outcome.kind === "one") {
        const hit = tasks.get(outcome.row.taskId);
        if (hit !== void 0) return hit;
      }
      if (outcome.kind === "many") {
        throw new Error(`\u300C${ref}\u300D\u5339\u914D\u5230 ${outcome.rows.length} \u6761\u4EFB\u52A1\uFF0C\u7528\u4EFB\u52A1\u53F7\u518D\u7CBE\u786E\u4E00\u4E9B\uFF1A
${outcome.rows.map((row) => `${row.taskId}. ${row.title}\uFF08${row.capsule}\uFF09`).join("\n")}`);
      }
      const hints = pool.slice(0, 5).map((task) => `${task.taskId}. ${task.title}\uFF08${capsuleOf(task.state)}\uFF09`);
      throw new Error(`\u627E\u4E0D\u5230\u4EFB\u52A1\u300C${ref}\u300D\u3002\u68CB\u76D8\u4E0A\u6700\u591A\u8FD9\u51E0\u6761\uFF1A
${hints.length === 0 ? "\uFF08\u4E00\u6761\u90FD\u6CA1\u6709\uFF09" : hints.join("\n")}`);
    }
    if (device.focusedTask !== void 0) {
      const focused = tasks.get(device.focusedTask);
      if (focused !== void 0) return focused;
    }
    const latest = latestFinished();
    if (latest !== void 0) return latest;
    const first = pool[0];
    if (first !== void 0) return first;
    throw new Error("\u73B0\u5728\u6CA1\u6709\u4EFB\u4F55\u4EFB\u52A1\uFF1A\u5148\u6D3E\u4E00\u6761\uFF08tihu_admin action=dispatch\uFF09\u3002");
  }
  function resolveDecisionTask(device, taskId) {
    const awaiting = tasks.list().filter((task) => task.state === "awaiting");
    const suffix = awaiting.length === 0 ? "\u3002" : `\uFF1A\u8FD8\u6709 ${awaiting.length} \u6761\u5728\u7B49\u4F60\uFF1A${awaiting.map((task) => `${task.taskId}\u300C${task.question ?? ""}\u300D`).join("\u3001")}`;
    if (taskId !== void 0) {
      const got = tasks.get(taskId);
      if (got !== void 0 && got.state === "awaiting") return got;
      throw new Error(`\u4EFB\u52A1 ${taskId} \u73B0\u5728\u6CA1\u6709\u5F85\u51B3\u7B56${suffix}`);
    }
    const focused = device?.focusedTask === void 0 ? void 0 : tasks.get(device.focusedTask);
    if (focused !== void 0 && focused.state === "awaiting") return focused;
    const only = awaiting.length === 1 ? awaiting[0] : void 0;
    if (only !== void 0) return only;
    if (awaiting.length === 0) throw new Error("\u5F53\u524D\u6CA1\u6709\u5F85\u51B3\u7B56\uFF1A\u6CA1\u6709\u4EBA\u5728\u7B49\u4F60\u62CD\u677F\u3002");
    throw new Error(`\u6709 ${awaiting.length} \u6761\u5F85\u51B3\u7B56\uFF0C\u8BF7\u7528 taskId \u6307\u5B9A\uFF1A
${awaiting.map((task) => `${task.taskId}\u300C${task.question ?? ""}\u300D`).join("\n")}`);
  }
  const control = {
    // 工具入参留痕：`tihu_tool_call tool=… args=…`（模型自己调与补调都走同一个执行器）。
    noteToolCall: (tool, args) => {
      try {
        appendTihuToolCallLog(tool, args);
      } catch {
      }
    },
    listDevices: (includeOffline = false) => {
      const online = [...devices].map(controlDeviceOf);
      if (includeOffline !== true) return online;
      const now = Date.now();
      const offline = [...recentDevices.values()].filter((entry) => now - entry.at <= RECENT_DEVICE_TTL_MS && !online.some((item) => item.id === entry.view.id)).map((entry) => ({ ...entry.view }));
      return [...online, ...offline];
    },
    deviceOfSession: (sessionId) => {
      const device = [...devices].find((item) => item.sessionId === sessionId);
      return device === void 0 ? void 0 : controlDeviceOf(device);
    },
    deviceStatus: (deviceId) => {
      const device = findControlDevice(deviceId);
      if (device === void 0) return void 0;
      const display = device.sessionId ?? device.id;
      const frame = lastFrames.get(display);
      const board = boardOf(tasks.list(), Date.now(), Math.max(0, Math.trunc(device.boardPage ?? 0)));
      const focused = device.focusedTask === void 0 ? void 0 : tasks.get(device.focusedTask);
      const bridge = focused === void 0 ? void 0 : pendingBridges.get(focused.taskId);
      const playback = device.playback;
      const deadline = focused?.decisionDeadline;
      return {
        device: controlDeviceOf(device),
        display,
        pinned: device.onBoard === true,
        // 真事实：完成页正文读页面自报的 playback；播报没有 read 元数据，回落到宿主轮次。
        speaking: deviceSpeaking(device),
        ...device.screenStage === void 0 || device.screenStage === "" ? {} : { stage: device.screenStage },
        ...playback === void 0 ? {} : {
          playback: {
            phase: playback.phase,
            ...playback.taskId === void 0 ? {} : { taskId: playback.taskId },
            ...playback.segment === void 0 ? {} : { segment: playback.segment },
            ...playback.line === void 0 ? {} : { line: playback.line },
            ...playback.total === void 0 ? {} : { total: playback.total },
            ...playback.charStart === void 0 ? {} : { charStart: playback.charStart }
          }
        },
        ...focused === void 0 ? {} : { taskId: focused.taskId, taskTitle: focused.title },
        board: {
          page: board.page.index,
          total: Math.max(1, board.page.total),
          counts: board.counts,
          totalTasks: board.total
        },
        ...focused === void 0 || focused.state !== "awaiting" || bridge === void 0 ? {} : {
          decision: {
            taskId: focused.taskId,
            question: String(focused.question ?? "").trim(),
            options: focused.options ?? [],
            secondsLeft: deadline === void 0 ? 0 : Math.max(0, Math.round((deadline - Date.now()) / 1e3)),
            ...focused.defaultIndex === void 0 ? {} : { defaultIndex: focused.defaultIndex }
          }
        },
        ...frame === void 0 ? {} : { screen: { stage: frame.stage ?? "", title: frame.title ?? "", mode: frame.mode ?? "status", bullets: frame.bullets ?? [] } }
      };
    },
    listSessions: async (fragment) => {
      try {
        const collected = await collectSessionRows();
        return matchSessionRows(collected.rows.map(controlRowOf), fragment);
      } catch {
        return { kind: "none" };
      }
    },
    progress: async (sessionId) => {
      const found = await findSession(sessionId);
      const title = found.row?.title !== void 0 && found.row.title !== "" ? humanTitle(found.row.title) : titleForSession(sessionId);
      const state = progressStates.get(sessionId);
      return {
        sessionId,
        title,
        running: runningSessions.has(sessionId),
        speaking: false,
        ...state === void 0 ? {} : { state: { turn: state.turn, step: state.step, stage: state.stage, stageWord: state.stageWord, title: state.title, turnStartedAt: state.turnStartedAt, activity: state.activity.slice(-6), ...state.lastResult === void 0 ? {} : { lastResult: state.lastResult }, ...state.stats === void 0 ? {} : { stats: state.stats } } },
        stats: screenMetaOf(sessionId).stats
      };
    },
    archiveSession: async (sessionId) => {
      const registry = optionalService3(ctx, "workspaceRegistry");
      if (registry === void 0 || typeof registry.archiveSession !== "function") return "\u9519\u8BEF\uFF1A\u5BBF\u4E3B\u6CA1\u6709 workspaceRegistry \u670D\u52A1\uFF0C\u65E0\u6CD5\u5F52\u6863\u4F1A\u8BDD";
      const found = await findSession(sessionId);
      if (found.status === "missing") return `\u9519\u8BEF\uFF1A\u4F1A\u8BDD ${shortSessionId2(sessionId)} \u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u5F52\u6863\u6216\u5220\u9664\uFF09`;
      try {
        await registry.archiveSession(sessionId, { stopActivity: true });
      } catch (error) {
        return `\u9519\u8BEF\uFF1A\u5F52\u6863\u5931\u8D25\uFF08${error?.message ?? String(error)}\uFF09`;
      }
      sessionListCache = void 0;
      return `\u5DF2\u5220\u9664\uFF08\u5F52\u6863\uFF09\u4F1A\u8BDD\u300C${found.row?.title !== void 0 && found.row.title !== "" ? humanTitle(found.row.title) : shortSessionId2(sessionId)}\u300D`;
    },
    /* ---- 15 个具名设备工具的落地实现（control.ts 只做参数校验与文案，这里才是真动作） ---- */
    stopSpeaking: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      const outcome = await stopDevicePlayback(device, options2.scope ?? "round");
      if (outcome.kind === "listening") {
        return {
          text: "\u5DF2\u9000\u51FA\u300C\u5728\u542C\u300D",
          deviceId: device.id,
          ...outcome.ack === void 0 ? {} : { acked: true },
          echo: "\u9EA6\u514B\u98CE\u5DF2\u5173"
        };
      }
      if (outcome.kind === "idle") {
        return { text: "\u672C\u6765\u5C31\u6CA1\u5728\u6717\u8BFB", deviceId: device.id, already: true, echo: `\u505C\u5728 ${screenEchoOf(device)}` };
      }
      if (outcome.kind === "sent") return { text: "\u5DF2\u4E0B\u53D1\u505C\u6B62", deviceId: device.id };
      return { text: "\u5DF2\u505C\u6B62\u6717\u8BFB", deviceId: device.id, acked: true, echo: `\u505C\u5728 ${ackEcho(outcome.ack) ?? screenEchoOf(device)}` };
    },
    pauseSpeaking: async (deviceId) => {
      const device = requireControlDevice(deviceId);
      if (device.playback?.phase === "paused") {
        const paused = device.pausedAt;
        return {
          text: "\u672C\u6765\u5C31\u5DF2\u7ECF\u6682\u505C",
          deviceId: device.id,
          already: true,
          echo: paused === void 0 ? screenEchoOf(device) : `\u505C\u5728\u7B2C ${paused.segment} \u6BB5\uFF08\u7EE7\u7EED\u65F6\u4ECE\u672C\u884C\u5F00\u5934\u5FF5\uFF09`
        };
      }
      if (!deviceSpeaking(device)) {
        return { text: "\u672C\u6765\u5C31\u6CA1\u5728\u6717\u8BFB\uFF0C\u65E0\u9700\u6682\u505C", deviceId: device.id, already: true, echo: screenEchoOf(device) };
      }
      const segment = Math.max(1, Math.trunc(Number(device.playback?.segment ?? 1)) || 1);
      const line = Number.isFinite(Number(device.playback?.line)) ? Math.max(0, Math.trunc(Number(device.playback?.line))) : segment - 1;
      const taskId = device.playback?.taskId ?? device.focusedTask;
      try {
        device.cancelRound?.();
      } catch {
      }
      const ack = await awaitDeviceAck(device, "playback.control", { action: "pause" });
      if (ack !== void 0 && ack.ok === false) throw new Error(`\u8BBE\u5907\u62D2\u7EDD\u6682\u505C\uFF1A${ack.reason ?? "\u539F\u56E0\u672A\u77E5"}\uFF08${device.id}\uFF09`);
      device.pausedAt = { segment, line, ...taskId === void 0 ? {} : { taskId } };
      device.playback = { phase: "paused", segment, line, ...taskId === void 0 ? {} : { taskId }, at: Date.now() };
      return {
        text: "\u5DF2\u6682\u505C",
        deviceId: device.id,
        ...ack === void 0 ? {} : { acked: true },
        echo: `\u505C\u5728\u7B2C ${segment} \u6BB5\uFF08\u7EE7\u7EED\u65F6\u4ECE\u672C\u884C\u5F00\u5934\u5FF5\uFF09`
      };
    },
    resumeSpeaking: async (deviceId) => {
      const device = requireControlDevice(deviceId);
      const paused = device.pausedAt;
      if (paused === void 0 && device.playback?.phase !== "paused") {
        if (deviceSpeaking(device)) return { text: "\u672C\u6765\u5C31\u5728\u5FF5\uFF0C\u4E0D\u7528\u7EE7\u7EED", deviceId: device.id, already: true };
        throw new Error("\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u6717\u8BFB\uFF1A\u8FD9\u53F0\u8BBE\u5907\u4E0A\u6CA1\u6709\u6682\u505C\u70B9\uFF08\u5BBF\u4E3B\u91CD\u542F/\u8BBE\u5907\u91CD\u8FDE\u540E\u4F4D\u7F6E\u4F1A\u4E22\uFF09\u3002\u7528 tihu_replay \u4ECE\u5934\u91CD\u8BFB\u3002");
      }
      const segment = Math.max(1, Math.trunc(Number(paused?.segment ?? device.playback?.segment ?? 1)) || 1);
      const taskId = paused?.taskId ?? device.playback?.taskId ?? device.focusedTask;
      const task = taskId === void 0 ? void 0 : tasks.get(taskId);
      if (task === void 0 || task.state !== "done" && task.state !== "announced") {
        throw new Error("\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u6717\u8BFB\uFF1A\u90A3\u6761\u4EFB\u52A1\u5DF2\u7ECF\u4E0D\u5728\u5B8C\u6210\u9875\u4E86\uFF08\u5F52\u6863\u6216\u6362\u5C4F\uFF09\u3002\u7528 tihu_replay \u4ECE\u5934\u91CD\u8BFB\u3002");
      }
      const ack = await awaitDeviceAck(device, "playback.control", { action: "resume", from: { taskId: task.taskId, segment } });
      if (ack !== void 0 && ack.ok === false) throw new Error(`\u8BBE\u5907\u62D2\u7EDD\u7EE7\u7EED\uFF1A${ack.reason ?? "\u539F\u56E0\u672A\u77E5"}\uFF08${device.id}\uFF09`);
      device.pausedAt = void 0;
      device.focusedTask = task.taskId;
      device.onBoard = false;
      pushFrame(device, doneScreenOf(task, segment - 1));
      readDoneScreen(device, task, segment - 1);
      return {
        text: "\u5DF2\u7EE7\u7EED",
        deviceId: device.id,
        ...ack === void 0 ? {} : { acked: true },
        echo: `\u4ECE\u7B2C ${segment} \u884C\u7EE7\u7EED\uFF08\u672C\u884C\u5F00\u5934\u91CD\u5FF5\uFF09`
      };
    },
    replay: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      const task = resolveControlTask(device, {
        ...options2.taskId === void 0 ? {} : { taskId: options2.taskId }
      });
      if (task.state === "running" || task.state === "queued" || task.state === "dispatched") {
        throw new Error(`\u300C${task.title}\u300D\u8FD8\u5728\u8DD1\uFF0C\u53EA\u6709\u5B8C\u6210\u9875\u80FD\u91CD\u8BFB\uFF08\u7B49\u5B83\u5B8C\u6210\uFF09\u3002`);
      }
      if (task.state === "awaiting") {
        throw new Error(`\u300C${task.title}\u300D\u6B63\u5728\u7B49\u4F60\u62CD\u677F\uFF0C\u6CA1\u6709\u53EF\u91CD\u8BFB\u7684\u6B63\u6587\uFF1A\u5148\u7528 tihu_answer_decision \u7B54\u6389\u5B83\u3002`);
      }
      if (String(task.doneText ?? "").trim() === "") {
        const sessionId = task.sessionIds[task.sessionIds.length - 1];
        if (sessionId !== void 0) {
          const text = await readAssistantText(sessionId);
          if (text !== "") {
            task.doneText = text;
            if (String(task.resultLine ?? "").trim() === "") task.resultLine = firstSentenceOf(text);
          }
        }
      }
      const body = doneBodyTextOf(task);
      const lines = doneLinesOf(body);
      const total = Math.max(1, lines.length);
      const wanted = options2.line !== void 0 ? Math.trunc(options2.line) + 1 : Math.max(1, Math.trunc(Number(options2.segment ?? 1)) || 1);
      const from = Math.max(1, Math.min(total, wanted));
      const clamped = from !== wanted;
      try {
        device.cancelRound?.();
      } catch {
      }
      device.doneReadingTask = void 0;
      device.focusedTask = task.taskId;
      device.onBoard = false;
      device.pausedAt = void 0;
      pushFrame(device, doneScreenOf(task, from - 1));
      readDoneScreen(device, task, from - 1);
      return {
        text: `\u6B63\u5728\u91CD\u8BFB\u300C${task.title}\u300D\u7B2C ${from} \u6BB5\uFF08\u5171 ${total} \u6BB5\uFF09${clamped ? `\uFF08\u539F\u8BF7\u6C42\u7B2C ${wanted} \u6BB5\u5DF2\u5939\u5230\u8303\u56F4\u5185\uFF09` : ""}`,
        deviceId: device.id,
        acked: true,
        echo: `\u5B8C\u6210 \u7B2C ${from}/${total} \u884C`
      };
    },
    goHome: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      const stop = options2.stopSpeaking !== false;
      const targets = options2.all === true ? [...devices].filter((item) => item.unified) : [device];
      const page = Math.max(0, Math.trunc(Number(options2.page ?? 0)) || 0);
      let already = 0;
      let wasSpeaking = false;
      for (const target of targets) {
        if (target.playback?.phase === "listening") {
          target.send("voice.listen", { on: false });
          target.playback = { phase: "idle", at: Date.now() };
        }
        if (stop) {
          if (deviceSpeaking(target)) wasSpeaking = true;
          try {
            target.cancelRound?.();
          } catch {
          }
          target.pausedAt = void 0;
        }
        const alreadyHome = target.onBoard === true && target.focusedTask === void 0 && target.receiptTimer === void 0 && target.screenStage === "" && Math.max(0, Math.trunc(target.boardPage ?? 0)) === page;
        if (alreadyHome) {
          already += 1;
          continue;
        }
        target.boardPage = page;
        sendBoard(target, false);
      }
      const primary = targets[0] ?? device;
      if (stop && wasSpeaking) await awaitDeviceAck(primary, "playback.control", { action: "stop", scope: "round" });
      const awaiting = tasks.list().filter((task) => task.state === "awaiting").length;
      return {
        text: already === targets.length ? "\u672C\u6765\u5C31\u5728\u4E3B\u9875" : "\u5DF2\u56DE\u4E3B\u9875",
        deviceId: primary.id,
        ...already === targets.length ? { already: true } : { acked: true },
        echo: boardEchoOf(primary),
        ...awaiting > 0 ? { note: `\u8FD8\u6709 ${awaiting} \u6761\u5F85\u51B3\u7B56\u5728\u7B49\u4F60\uFF08\u6CA1\u66FF\u4F60\u7B54\uFF09` } : {}
      };
    },
    boardPage: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      const current = Math.max(0, Math.trunc(device.boardPage ?? 0));
      const board = boardOf(tasks.list(), Date.now(), current);
      const total = Math.max(1, board.page.total);
      if (total <= 1) {
        return { text: "\u68CB\u76D8\u53EA\u6709 1 \u9875", deviceId: device.id, already: true, echo: boardEchoOf(device) };
      }
      const wanted = options2.page !== void 0 ? Math.trunc(Number(options2.page)) : current + (options2.direction === "prev" ? -1 : 1);
      const target = Math.max(0, Math.min(total - 1, wanted));
      if (target === current) {
        const edge = options2.page !== void 0 ? "\u5DF2\u7ECF\u662F\u8FD9\u4E00\u9875" : options2.direction === "prev" ? "\u5DF2\u7ECF\u662F\u7B2C\u4E00\u9875" : "\u5DF2\u7ECF\u662F\u6700\u540E\u4E00\u9875";
        return { text: edge, deviceId: device.id, already: true, echo: boardEchoOf(device) };
      }
      device.boardPage = target;
      sendBoard(device, false);
      const pageBoard = boardOf(tasks.list(), Date.now(), target);
      const rows = pageBoard.rows.map((row, index) => `${index + 1}. ${row.title}\uFF08${row.capsule}\uFF09`);
      return {
        text: `\u5DF2\u7FFB\u5230\u7B2C ${target + 1}/${total} \u9875`,
        deviceId: device.id,
        acked: true,
        echo: `\u7B2C ${target + 1}/${total} \u9875${rows.length === 0 ? "\uFF08\u8FD9\u9875\u6CA1\u6709\u4EFB\u52A1\uFF09" : `\uFF1A${rows.join(" / ")}`}`
      };
    },
    openTaskCard: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      let task;
      const page = Math.max(0, Math.trunc(device.boardPage ?? 0));
      const pageBoard = boardOf(tasks.list(), Date.now(), page);
      const pageRows = numberedRowsOfBoard(pageBoard);
      if (options2.index !== void 0) {
        const index = boardRowIndex(options2.index);
        const row = pageBoard.rows[index - 1];
        if (row === void 0) {
          throw new Error(`\u68CB\u76D8\u7B2C ${pageBoard.page.index + 1}/${pageBoard.page.total} \u9875\u6CA1\u6709\u7B2C ${index} \u884C\uFF08\u8FD9\u9875\u53EA\u6709 ${pageBoard.rows.length} \u6761\uFF09\u3002\u8FD9\u9875\u7684\u884C\u53F7\u662F\uFF1A${pageRows.length === 0 ? "\uFF08\u7A7A\uFF09" : `
${pageRows.join("\n")}`}`);
        }
        const hit = tasks.get(row.taskId);
        if (hit === void 0) throw new Error(`\u7B2C ${index} \u884C\uFF08${row.taskId}\uFF09\u521A\u4ECE\u68CB\u76D8\u4E0A\u6D88\u5931\uFF0C\u8BF7\u91CD\u65B0\u770B\u4E00\u773C\u68CB\u76D8\u3002`);
        task = hit;
      } else {
        task = resolveControlTask(device, {
          ...options2.taskId === void 0 ? {} : { taskId: options2.taskId },
          ...options2.title === void 0 ? {} : { title: options2.title },
          recent: options2.recent === true
        });
        if (options2.taskId === void 0 && options2.title === void 0 && options2.recent !== true) {
          try {
            appendTihuLaneNote("tihu_open_task_fallback", `tool=tihu_open_task \u8FD9\u6B21\u6CA1\u5E26 index/title/taskId/recent \u2192 \u5F00\u4E86 ${task.taskId}\u300C${clipForLog(task.title, 30)}\u300D\uFF1B\u5C4F\u4E0A\u7B2C ${pageBoard.page.index + 1}/${pageBoard.page.total} \u9875\u884C\u53F7\uFF1A${pageRows.length === 0 ? "\uFF08\u7A7A\uFF09" : pageRows.join(" / ")}`);
          } catch {
          }
        }
      }
      openTask(device, task.taskId);
      return {
        text: `\u5DF2\u6253\u5F00 ${task.taskId}\u300C${task.title}\u300D\uFF08${capsuleOf(task.state)}\uFF09`,
        deviceId: device.id,
        acked: true,
        echo: stageWordOf(task)
      };
    },
    followTask: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      const task = resolveControlTask(device, {
        ...options2.taskId === void 0 ? {} : { taskId: options2.taskId }
      });
      if (!taskRunningNow(task)) {
        openTask(device, task.taskId);
        return {
          text: `\u300C${task.title}\u300D\u6CA1\u5728\u8DD1\uFF08${capsuleOf(task.state)}\uFF09\uFF0C\u7ED9\u4F60\u770B${stageWordOf(task)}`,
          deviceId: device.id,
          acked: true,
          echo: stageWordOf(task)
        };
      }
      if (device.screenStage === "\u8FDB\u5EA6" && device.focusedTask !== void 0 && device.focusedTask !== task.taskId) {
        return { text: "\u7528\u6237\u5DF2\u7ECF\u5207\u8D70\uFF0C\u672A\u8DDF\u968F", deviceId: device.id, already: true, echo: screenEchoOf(device) };
      }
      const frame = taskDetailFrameOf(task);
      if (frame === void 0) throw new Error(`\u300C${task.title}\u300D\u8FD8\u6CA1\u5EFA\u8D77\u4F1A\u8BDD\uFF0C\u6682\u65F6\u6CA1\u6709\u8FDB\u5EA6\u53EF\u770B\u3002`);
      disarmAutoHome(device);
      device.focusedTask = task.taskId;
      device.onBoard = false;
      device.followUntil = options2.until === "turn" ? "turn" : "done";
      progressEventAt.set(task.taskId, Date.now());
      sendFrame(device, frame, device.sessionId);
      armScreenHome(device, DETAIL_AUTO_HOME_MS, task.taskId, "\u8FDB\u5EA6");
      ensureDetailTicker();
      const sessionId = task.sessionIds[task.sessionIds.length - 1];
      const elapsed = sessionId === void 0 ? "" : ` \xB7 \u5DF2\u7528 ${formatElapsed(elapsedOfTask(task, sessionId))}`;
      return {
        text: `\u5DF2\u8DDF\u968F ${task.taskId}\u300C${task.title}\u300D`,
        deviceId: device.id,
        acked: true,
        echo: `\u5F53\u524D \u7B2C ${Math.max(task.step, 0)} \u6B65${elapsed}`
      };
    },
    endVoiceSession: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      if (deviceSpeaking(device)) {
        try {
          device.cancelRound?.();
        } catch {
        }
      }
      const sessionId = device.sessionId;
      const ended = sessionId === void 0 ? false : endSession(sessionId);
      const ack = await awaitDeviceAck(device, "session.ended", {
        ...sessionId === void 0 ? {} : { sessionId },
        reason: options2.reason ?? "\u7535\u8111\u7AEF\u6307\u4EE4",
        at: Date.now()
      });
      device.pausedAt = void 0;
      device.playback = { phase: "idle", at: Date.now() };
      return {
        text: ended ? "\u5DF2\u7ED3\u675F\u672C\u6B21\u8BED\u97F3\u4F1A\u8BDD\uFF08\u95F8\u95E8\u5173\u95ED\uFF09" : "\u5F53\u524D\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u8BED\u97F3\u4F1A\u8BDD",
        deviceId: device.id,
        ...ack === void 0 ? {} : { acked: true },
        ...ended ? {} : { already: true },
        echo: "\u5C4F\u505C\u5728 \u7A7A\u95F2"
      };
    },
    wake: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      const timeoutMs = clampInt(Number(options2.timeoutMs ?? 1e4), 3e3, 6e4);
      const prompt = String(options2.prompt ?? "").trim();
      if (options2.stopSpeaking !== false && deviceSpeaking(device)) {
        try {
          device.cancelRound?.();
        } catch {
        }
        await awaitDeviceAck(device, "playback.control", { action: "stop", scope: "round" });
        device.pausedAt = void 0;
      }
      if (device.playback?.phase === "listening") {
        device.send("voice.listen", { on: true, ...prompt === "" ? {} : { prompt }, timeoutMs });
        return { text: "\u672C\u6765\u5C31\u5728\u300C\u5728\u542C\u300D\uFF0C\u5DF2\u66F4\u65B0\u63D0\u793A", deviceId: device.id, already: true, echo: "\u5728\u542C" };
      }
      const ack = await awaitDeviceAck(device, "voice.listen", {
        on: true,
        ...prompt === "" ? {} : { prompt },
        timeoutMs
      });
      if (ack !== void 0 && ack.ok === false) {
        throw new Error(ack.reason === "mic-denied" ? "\u8BBE\u5907\u6CA1\u6709\u9EA6\u514B\u98CE\u6743\u9650\uFF1A\u5728\u6D4F\u89C8\u5668\u91CC\u5141\u8BB8\u9EA6\u514B\u98CE\u540E\u518D\u8BF4\u4E00\u6B21\u3002" : `\u8BBE\u5907\u6CA1\u80FD\u8FDB\u5165\u5728\u542C\uFF1A${ack.reason ?? "\u539F\u56E0\u672A\u77E5"}\uFF08${device.id}\uFF09`);
      }
      device.playback = { phase: "listening", at: Date.now() };
      return {
        text: `\u5DF2\u8FDB\u5165\u5728\u542C\uFF08${Math.round(timeoutMs / 1e3)} \u79D2\u65E0\u4EBA\u8BF4\u8BDD\u81EA\u52A8\u9000\u51FA\uFF09`,
        deviceId: device.id,
        ...ack === void 0 ? {} : { acked: true },
        echo: "\u5728\u542C",
        note: "\u771F\u673A\u9700\u56FA\u4EF6\u652F\u6301 voice.listen\uFF0C\u5426\u5219\u53EA\u5728\u6A21\u62DF\u9875\u751F\u6548"
      };
    },
    answerDecision: async (deviceId, options2) => {
      const device = findControlDevice(deviceId);
      if (options2.taskId !== void 0) {
        const known = tasks.get(options2.taskId);
        if (known !== void 0 && known.state !== "awaiting") {
          return {
            text: `\u8FD9\u6761\u5DF2\u7ECF\u7B54\u8FC7\u4E86\uFF08${known.answeredBy ?? "\u522B\u5904"}\uFF09\uFF0C\u4E0D\u518D\u6539\u53E3`,
            deviceId: device?.id ?? "\u7535\u8111\u7AEF",
            already: true,
            echo: known.taskId
          };
        }
      }
      const task = resolveDecisionTask(device, options2.taskId);
      const list = (task.options ?? []).filter((option) => String(option ?? "").trim() !== "");
      if (list.length === 0) throw new Error(`\u4EFB\u52A1 ${task.taskId} \u7684\u5F85\u51B3\u7B56\u6CA1\u6709\u9009\u9879\u53EF\u7B54\u3002`);
      let index = -1;
      if (options2.index !== void 0) {
        const wanted = Math.trunc(Number(options2.index));
        if (!Number.isFinite(wanted) || wanted < 1 || wanted > list.length) {
          throw new Error(`\u7B2C ${String(options2.index)} \u9879\u4E0D\u5B58\u5728\uFF1A\u8FD9\u6761\u53EA\u6709 ${list.length} \u4E2A\u9009\u9879\uFF1A${list.map((label2, i) => `${i + 1}. ${label2}`).join(" / ")}\uFF08\u4E0D\u66FF\u4F60\u731C\uFF09`);
        }
        index = wanted - 1;
      } else if (options2.text !== void 0 && options2.text.trim() !== "") {
        const key = options2.text.trim();
        const pairs = list.map((label2, i) => [label2, i]);
        const exact = pairs.filter(([label2]) => label2 === key);
        const fuzzy = exact.length > 0 ? exact : pairs.filter(([label2]) => label2.includes(key) || key.includes(label2));
        if (fuzzy.length === 0) throw new Error(`\u6CA1\u6709\u300C${key}\u300D\u8FD9\u4E2A\u9009\u9879\uFF1A${list.map((label2, i) => `${i + 1}. ${label2}`).join(" / ")}`);
        if (fuzzy.length > 1) throw new Error(`\u300C${key}\u300D\u547D\u4E2D\u591A\u4E2A\u9009\u9879\uFF1A${fuzzy.map(([label2, i]) => `${i + 1}. ${label2}`).join(" / ")}\u3002\u8BF7\u8BF4\u7B2C\u51E0\u9879\u3002`);
        index = fuzzy[0][1];
      } else {
        throw new Error("\u7ED9 index\uFF08\u7B2C\u51E0\u9879\uFF0C1 \u8D77\uFF09\u6216 text\uFF08\u9009\u9879\u6587\u672C\uFF09\uFF0C\u5426\u5219\u7B49\u4E8E\u66FF\u4F60\u778E\u9009\u3002");
      }
      const by = String(options2.by ?? "\u7535\u8111\u7AEF\u6307\u4EE4");
      const label = list[index];
      if (!answerPendingDecision(task.taskId, index, by)) tasks.answer(task.taskId, by, Date.now());
      if (device !== void 0) {
        leaveDecisionScreens(task.taskId, device.id);
        sendBoard(device);
      } else {
        refreshBoards();
      }
      return {
        text: `\u5DF2\u9009\u300C${label}\u300D\uFF08\u7B2C ${index + 1} \u9879\uFF09`,
        deviceId: device?.id ?? "\u7535\u8111\u7AEF",
        acked: true,
        echo: `${task.taskId}${device === void 0 ? " \xB7 \u5DF2\u5728\u7535\u8111\u7AEF\u4F5C\u7B54" : ""}`
      };
    },
    dismissDecision: async (deviceId, options2) => {
      const device = findControlDevice(deviceId);
      const task = resolveDecisionTask(device, options2.taskId);
      const list = (task.options ?? []).filter((option) => String(option ?? "").trim() !== "");
      const mode = options2.mode ?? "default";
      if (mode === "delegate") {
        const bridge = pendingBridges.get(task.taskId);
        if (bridge === void 0) {
          if (device === void 0) {
            return { text: "\u8BBE\u5907\u672C\u6765\u5C31\u4E0D\u5728\u7EBF\uFF0C\u7535\u8111\u7AEF\u5361\u7247\u4E00\u76F4\u5728\u7B49", deviceId: "\u7535\u8111\u7AEF", already: true, echo: `${task.taskId} \xB7 \u7535\u8111\u7AEF` };
          }
          throw new Error(`\u4EFB\u52A1 ${task.taskId} \u6CA1\u6709\u6302\u7740\u7684\u5F85\u51B3\u7B56\uFF08\u53EF\u80FD\u5DF2\u7ECF\u4EA4\u7ED9\u7535\u8111\u7AEF\u4E86\uFF09\u3002`);
        }
        if (device !== void 0) leaveDecisionScreens(task.taskId, device.id);
        bridge.delegate("\u7535\u8111\u7AEF\u4EA4\u56DE");
        return {
          text: "\u5DF2\u628A\u51B3\u7B56\u4EA4\u56DE\u7535\u8111\u7AEF",
          deviceId: device?.id ?? "\u7535\u8111\u7AEF",
          acked: true,
          echo: `${task.taskId} \xB7 \u7535\u8111\u7AEF\u5361\u7247\u7EE7\u7EED\u7B49`
        };
      }
      let index;
      if (mode === "reject") {
        const pairs = list.map((label2, i) => [label2, i]);
        const found = pairs.filter(([label2]) => /^(拒绝|取消|否|不同意|不要|不用|no|cancel|reject)$/i.test(label2.trim()));
        if (found.length === 0) {
          throw new Error(`\u9009\u9879\u91CC\u6CA1\u6709\u300C\u62D2\u7EDD/\u53D6\u6D88\u300D\u8FD9\u7C7B\u5426\u5B9A\u9879\uFF1A${list.map((label2, i) => `${i + 1}. ${label2}`).join(" / ")}\u3002\u7EDD\u4E0D\u731C\uFF0C\u8BF7\u7528 tihu_answer_decision \u6307\u5B9A\u7B2C\u51E0\u9879\u3002`);
        }
        index = found[0][1];
      } else {
        index = Math.max(0, Math.min(Math.max(0, list.length - 1), Math.trunc(Number(task.defaultIndex ?? 0))));
      }
      const label = list[index] ?? "\u9ED8\u8BA4\u9879";
      const by = mode === "reject" ? "\u7535\u8111\u7AEF\u62D2\u7EDD" : "\u7535\u8111\u7AEF\u6309\u9ED8\u8BA4\u9879";
      if (!answerPendingDecision(task.taskId, index, by)) tasks.answer(task.taskId, by, Date.now());
      if (device !== void 0) {
        leaveDecisionScreens(task.taskId, device.id);
        sendBoard(device);
      } else {
        refreshBoards();
      }
      return {
        text: mode === "reject" ? `\u5DF2\u6309\u62D2\u7EDD\u5904\u7406\uFF1A\u300C${label}\u300D\uFF08\u7B2C ${index + 1} \u9879\uFF09` : `\u5DF2\u6309\u9ED8\u8BA4\u9879\u300C${label}\u300D\u4E86\u7ED3\uFF08\u7B49\u540C 60 \u79D2\u8D85\u65F6\uFF09`,
        deviceId: device?.id ?? "\u7535\u8111\u7AEF",
        acked: true,
        echo: task.taskId
      };
    },
    deviceSettings: async (deviceId, options2) => {
      const device = requireControlDevice(deviceId);
      if (options2.key === "voice") {
        const value = String(options2.value ?? "");
        if (!isTihuCloudVoice(value)) throw new Error(`\u4E0D\u662F\u5408\u6CD5\u7684\u4E91\u7AEF\u97F3\u8272\uFF1A${value}`);
        const ack = await awaitDeviceAck(device, "device.config", { key: "voice", value });
        device.edgeVoice = value;
        return ack === void 0 ? { text: `\u97F3\u8272\u5DF2\u5207\u5230 ${tihuCloudVoiceShortName(value)}\uFF08${value}\uFF09`, deviceId: device.id } : { text: `\u97F3\u8272\u5DF2\u5207\u5230 ${tihuCloudVoiceShortName(value)}\uFF08${value}\uFF09`, deviceId: device.id, acked: true, echo: ackEcho(ack) };
      }
      if (options2.key === "handsfree") {
        const on = options2.value === true;
        const ack = await awaitDeviceAck(device, "device.config", { key: "handsfree", value: on });
        if (ack !== void 0 && ack.ok === false) {
          return {
            text: "\u8FD9\u53F0\u8BBE\u5907\u4E0D\u652F\u6301\u514D\u6309\u4F4F\uFF08\u771F\u673A\u8D70\u56FA\u4EF6\u672C\u5730\u5524\u9192\uFF09",
            deviceId: device.id,
            already: true,
            acked: true,
            echo: "\u514D\u6309\u4F4F\u672A\u751F\u6548"
          };
        }
        device.handsfree = on;
        return {
          text: on ? "\u5DF2\u5F00\u514D\u6309\u4F4F" : "\u5DF2\u5173\u514D\u6309\u4F4F",
          deviceId: device.id,
          ...ack === void 0 ? {} : { acked: true },
          note: "\u53EA\u5728\u6A21\u62DF\u9875/\u6D4F\u89C8\u5668\u751F\u6548\uFF1B\u771F\u673A\u662F\u56FA\u4EF6\u672C\u5730\u5524\u9192"
        };
      }
      throw new Error(`deviceSettings \u53EA\u652F\u6301 voice / handsfree\uFF0C\u6536\u5230\u300C${String(options2.key)}\u300D\u3002`);
    },
    dispatch: async (input) => {
      const text = String(input.text ?? "").trim();
      if (text === "") return "\u9519\u8BEF\uFF1Adispatch \u9700\u8981 text\uFF08\u7528\u6237\u539F\u8BDD\uFF0C\u4E5F\u5C31\u662F\u300C\u8981\u505A\u4EC0\u4E48\u300D\uFF09\u3002";
      if (fallbackDispatch !== void 0 && fallbackDispatch.key === dispatchKeyOf(text) && Date.now() - fallbackDispatch.at < FALLBACK_DEDUPE_MS) {
        log(`tihu dispatch skipped duplicate text=${JSON.stringify(text)} task=${fallbackDispatch.taskId || "-"}`);
        return `\u8FD9\u6761\u521A\u521A\u5DF2\u7ECF\u6D3E\u6210\u4EFB\u52A1 ${fallbackDispatch.taskId} \u4E86\uFF0C\u4E0D\u7528\u518D\u6D3E\u4E00\u6B21\u3002`;
      }
      const handled = controlHandledOf(text);
      if (handled !== void 0) {
        log(`tihu dispatch skipped\uFF08\u8FD9\u53E5\u5DF2\u6309\u5C4F\u4E0A\u547D\u4EE4\u529E\u8FC7 tool=${handled.tool}\uFF09text=${JSON.stringify(text)}`);
        return `\u8FD9\u53E5\u8BDD\u5DF2\u7ECF\u6309\u5C4F\u4E0A\u547D\u4EE4\u529E\u8FC7\uFF08${handled.tool}\uFF09\uFF0C\u6CA1\u6709\u6D3E\u5355\uFF0C\u4E5F\u4E0D\u7528\u518D\u6D3E\u4E00\u6B21\u3002`;
      }
      let card;
      const folderHint = String(input.folder ?? "").trim();
      if (folderHint !== "") {
        const known = (projectCards() ?? []).find((item) => String(item.folder ?? "").toLowerCase() === folderHint.toLowerCase());
        card = known ?? dispatchProjectCard(nameFromFolder(folderHint), folderHint) ?? void 0;
      } else {
        card = resolveCardForDispatch(input.project, text);
      }
      if (card === void 0) card = ASSISTANT_CARD;
      const device = [...devices].find((item) => item.unified);
      const key = dispatchKeyOf(text);
      const grayResolution = grayFallback !== void 0 && grayFallback.key === key;
      const grayConfidence = grayResolution ? grayFallback?.confidence : void 0;
      const sessionHint = String(input.session ?? "").trim();
      if (sessionHint !== "") {
        const candidates = await projectCuSessionsOf(card);
        const target = findContinuityTarget(candidates, sessionHint);
        if (target === void 0) {
          return `\u6CA1\u627E\u5230\u8981\u63A5\u7740\u7684\u4F1A\u8BDD\u300C${sessionHint}\u300D\uFF1A\u5B83\u5FC5\u987B\u662F\u8BE5\u9879\u76EE\u6587\u4EF6\u5939\u4E0B\u7684 Computer Use \u4F1A\u8BDD\uFF08\u53EF\u4EE5\u5148\u7528 list_sessions \u770B\u77ED\u53F7\uFF09\u3002`;
        }
        const appendMeta = { via: "commander", continuity: "append", confidence: grayConfidence ?? 1, clarify: "no" };
        const task = await appendToSession(
          device,
          text,
          card,
          { sessionId: target.sessionId, ...target.title === "" ? {} : { title: target.title } },
          appendMeta
        );
        if (task === void 0) {
          return appendMeta.failureShown === true ? "\u5DF2\u8BB0\u4E0B\uFF1A\u5BBF\u4E3B\u6CA1\u5EFA\u8D77\u4F1A\u8BDD\uFF08\u8FD9\u53E5\u8BDD\u8FD8\u5728\u68CB\u76D8\u4E0A\uFF0C\u4E0D\u7528\u91CD\u8BF4\uFF09\u3002" : "\u9519\u8BEF\uFF1A\u90A3\u6761\u4F1A\u8BDD\u6CA1\u63A5\u4F4F\u8FD9\u6761\u6D88\u606F\uFF08\u5BBF\u4E3B\u6295\u9012\u5931\u8D25\uFF09\u3002";
        }
        if (!task.sessionIds.includes(target.sessionId)) {
          return `\u90A3\u6761\u4F1A\u8BDD\u63A5\u4E0D\u4F4F\uFF0C\u5DF2\u5728\u300C${task.projectName}\u300D\u65B0\u5EFA\u4F1A\u8BDD\u6D3E\u51FA\uFF1A${task.title}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF09`;
        }
        return `\u5DF2\u63A5\u7740\u300C${task.projectName}\u300D\u539F\u6709\u4F1A\u8BDD\u6D3E\u51FA\uFF1A${task.title}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF09`;
      }
      if (input.newSession === true || grayResolution) {
        const task = await dispatchToCard(device, text, card, input.title, {
          via: "commander",
          continuity: "new",
          ...grayConfidence === void 0 ? {} : { confidence: grayConfidence },
          clarify: grayResolution ? "yes" : "no"
        });
        if (task === void 0) return "\u9519\u8BEF\uFF1A\u8FD9\u6761\u4EFB\u52A1\u6CA1\u6D3E\u51FA\u53BB\uFF08\u5BBF\u4E3B\u4E0D\u80FD\u65B0\u5EFA\u4F1A\u8BDD\uFF0C\u6216\u4EFB\u52A1\u4F1A\u8BDD\u6CA1\u63A5\u4F4F\u6D88\u606F\uFF09\u3002";
        return `\u5DF2\u6D3E\u7ED9\u300C${task.projectName}\u300D\uFF1A${task.title}\uFF08\u4EFB\u52A1 ${task.taskId}\uFF0C\u843D\u5728 ${task.folder ?? "\u9ED8\u8BA4\u76EE\u5F55"}\uFF09`;
      }
      const outcome = await dispatchWithContinuity(device, text, card, { via: "commander" }, { allowCommander: false });
      return outcome.message;
    },
    listTasks: () => tasks.list().filter((task) => task.state !== "archived").map((task) => ({ taskId: task.taskId, title: task.title, capsule: capsuleOf(task.state), sub: subLineOf(task) })),
    cancelTask: async (ref) => {
      const rows = tasks.list().filter((task2) => task2.state !== "archived").map((task2) => ({ taskId: task2.taskId, title: task2.title, capsule: capsuleOf(task2.state), sub: subLineOf(task2) }));
      if (rows.length === 0) return "\u767B\u8BB0\u7C3F\u91CC\u73B0\u5728\u6CA1\u6709\u4EFB\u52A1\uFF0C\u6CA1\u6709\u53EF\u64A4\u7684\u3002";
      const outcome = matchTaskRows(rows, ref);
      if (outcome.kind === "none") return `\u627E\u4E0D\u5230\u4EFB\u52A1\u300C${ref ?? ""}\u300D\uFF1A\u7528 list_tasks \u770B\u4E00\u4E0B\u4EFB\u52A1\u53F7\u3002`;
      if (outcome.kind === "many") return `\u300C${ref ?? ""}\u300D\u5339\u914D\u5230 ${outcome.rows.length} \u6761\u4EFB\u52A1\uFF0C\u8BF7\u7528\u4EFB\u52A1\u53F7\u518D\u7CBE\u786E\u4E00\u4E9B\uFF1A
${outcome.rows.map((row2) => `${row2.taskId}. ${row2.title}\uFF08${row2.capsule}\uFF09`).join("\n")}`;
      const row = outcome.kind === "one" ? outcome.row : outcome.rows[0];
      const task = tasks.get(row.taskId);
      if (task === void 0) return `\u627E\u4E0D\u5230\u4EFB\u52A1 ${row.taskId}\u3002`;
      const device = [...devices].find((item) => item.unified);
      if (device !== void 0) {
        const ok2 = await cancelTask(device, task.taskId);
        return ok2 ? `\u5DF2\u64A4\u6389\u4EFB\u52A1 ${task.taskId}\u300C${task.title}\u300D` : `\u4EFB\u52A1 ${task.taskId}\u300C${task.title}\u300D\u5DF2\u7ECF\u5F00\u8DD1\u4E86\uFF1A\u5148\u8BA9\u4EFB\u52A1\u505C\u4E0B\u518D\u64A4\u3002`;
      }
      const journal = tasks.archive(task.taskId);
      if (journal !== void 0) appendTaskJournal(journal);
      if (task.source === "pc") dismissExternalTask(task);
      return `\u5DF2\u64A4\u6389\u4EFB\u52A1 ${task.taskId}\u300C${task.title}\u300D`;
    }
  };
  runRegisteredTihuTool = createTihuToolRunner(control);
  return {
    control,
    page: () => tihuPageHtml({ lanePath: TIHU_LANE_PATH, protocol: TIHU_PROTOCOL_VERSION }),
    handleUpgrade,
    dispose: () => {
      disposed = true;
      for (const bridge of [...pendingBridges.values()]) bridge.settle(bridge.decision.defaultIndex, "\u63D2\u4EF6\u5378\u8F7D");
      pendingBridges.clear();
      stopCommanderWait();
      pendingCommanderTask.clear();
      commanderAsks.length = 0;
      commanderTurnReplied.clear();
      commanderToolCalls.clear();
      controlHandled.clear();
      clearGrayFallback();
      clearClarifyPrompt();
      fallbackDispatch = void 0;
      runRegisteredTihuTool = void 0;
      if (childReconcileTimer !== void 0) clearInterval(childReconcileTimer);
      childReconcileTimer = void 0;
      deferredReplies.clear();
      stopPcSync();
      if (detailTicker !== void 0) clearInterval(detailTicker);
      detailTicker = void 0;
      if (announceTimer !== void 0) clearTimeout(announceTimer);
      announceTimer = void 0;
      notifyBus.clear();
      for (const device of devices) {
        if (device.receiptTimer !== void 0) clearTimeout(device.receiptTimer);
        device.receiptTimer = void 0;
        if (device.homeTimer !== void 0) clearTimeout(device.homeTimer);
        device.homeTimer = void 0;
      }
      for (const [sessionId, timer] of thinkingTimers) {
        clearTimeout(timer);
        thinkingTimers.delete(sessionId);
      }
      liveThinking.clear();
      tts.dispose();
      for (const device of devices) {
        invalidateVoiceInput(device);
        if (device.voiceUi?.timer !== void 0) clearTimeout(device.voiceUi.timer);
        device.close();
      }
      clearPendingAcks();
      devices.clear();
      for (const disposer of [disposePre, disposePost, disposeSession, disposeAssistantStream, disposeApprovalRequest, disposeQuestionRequest]) {
        try {
          if (typeof disposer === "function") disposer();
        } catch {
        }
      }
      try {
        process.off("exit", flushLedgerOnExit);
      } catch {
      }
      ledgerStore.dispose();
    },
    stats: () => ({ devices: devices.size, activeSessions: [...activeSessions.keys()], tasks: tasks.size() })
  };
}
function safeJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return { type: "<unparsable>" };
  }
}
function finishReasonOf(data) {
  const record = data !== null && typeof data === "object" ? data : {};
  const reason = record.reason;
  if (typeof reason === "string") return reason;
  const kind = (reason !== null && typeof reason === "object" ? reason.kind : void 0) ?? record.kind;
  return typeof kind === "string" ? kind : "stop";
}
function lastAssistantTextOfEvents(events) {
  if (!Array.isArray(events)) return "";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "assistant/message") continue;
    const blocks = Array.isArray(event?.data?.message?.content) ? event.data.message.content : [];
    const text = stripToolNoise(blocks.filter((block) => block?.type === "text").map((block) => String(block?.text ?? "")).join("\n")).trim();
    if (text !== "") return text;
  }
  return "";
}
function firstSentenceOf(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean === "") return "";
  const first = clean.split(/[。！？!?\n]/).map((part) => part.trim()).filter(Boolean)[0] ?? clean;
  const chars = [...first];
  return chars.length > 24 ? `${chars.slice(0, 23).join("")}\u2026` : first;
}
function joinSafe(workspace, target) {
  return isAbsolute3(target) ? target : join14(workspace, target);
}
function existsSyncSafe(workspace, target) {
  try {
    return existsSync10(joinSafe(workspace, target));
  } catch {
    return false;
  }
}

// src/pocket-host/settings.mjs
import { readFileSync as readFileSync11, writeFileSync as writeFileSync8, mkdirSync as mkdirSync10, rmSync, statSync as statSync8 } from "node:fs";
import { join as join15, dirname as dirname9 } from "node:path";
import { homedir as homedir12 } from "node:os";
import { randomBytes } from "node:crypto";
var settingsRel = join15("dsh-pocket", "settings.json");
function settingsPath() {
  return join15(process.env.DSH_HOME ?? join15(homedir12(), ".dsh"), settingsRel);
}
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync11(settingsPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
  }
  return {};
}
function writeSettings(s) {
  try {
    mkdirSync10(dirname9(settingsPath()), { recursive: true });
    writeFileSync8(settingsPath(), JSON.stringify(s, null, 2), { mode: 384 });
  } catch {
  }
  return s;
}
function settingsFileExists() {
  try {
    return statSync8(settingsPath()).isFile();
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
    return JSON.parse(readFileSync12(pkgPath, "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
var loadedVersion = currentVersion();
var runtimeRevision = (() => {
  try {
    return createHash5("sha256").update(readFileSync12(fileURLToPath(import.meta.url))).digest("hex");
  } catch {
    return loadedVersion;
  }
})();
var PIN_RE = /^[a-zA-Z0-9]{8}$/;
function writePinToFile(p, fresh) {
  try {
    mkdirSync11(dirname10(p), { recursive: true });
    writeFileSync9(p, fresh, { mode: 384 });
  } catch {
  }
  return fresh;
}
function readPin(p) {
  try {
    const existing = readFileSync12(p, "utf8").trim();
    if (PIN_RE.test(existing)) return existing;
  } catch {
  }
  return null;
}
function newPin() {
  return String(randomInt(1e7, 1e8));
}
function getPocketSessionKey(home) {
  const p = join16(home, "dsh-pocket", "session-key");
  try {
    const existing = readFileSync12(p, "utf8").trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {
  }
  return writePinToFile(p, randomBytes2(16).toString("hex"));
}
var tokenRel = join16("dsh-pocket", "token");
function tokenPath() {
  return join16(process.env.DSH_HOME ?? join16(homedir13(), ".dsh"), tokenRel);
}
function getAccessToken() {
  return readPin(tokenPath()) ?? writePinToFile(tokenPath(), newPin());
}
function rotateAccessToken() {
  if (pinCustom("public")) return getAccessToken();
  return writePinToFile(tokenPath(), newPin());
}
var lanTokenRel = join16("dsh-pocket", "token-lan");
function lanTokenPath() {
  return join16(process.env.DSH_HOME ?? join16(homedir13(), ".dsh"), lanTokenRel);
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
var restartNoticeRel = join16("dsh-pocket", "restarted.json");
function restartNoticePath() {
  return join16(process.env.DSH_HOME ?? join16(homedir13(), ".dsh"), restartNoticeRel);
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
  return mkdir4(dirname10(restartNoticePath()), { recursive: true }).then(() => writeFile3(restartNoticePath(), JSON.stringify({ at: Date.now(), pid: process.pid }), "utf8"));
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
      join16(homedir13(), ".dsh")
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return join16(homedir13(), ".dsh");
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
      const raw = readFileSync12(join16(process.env.DSH_HOME ?? join16(homedir13(), ".dsh"), "settings.yaml"), "utf8");
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
  if (tihuRuntime) {
    registerTihuControl(ctx, tihuRuntime.control, (line) => {
      try {
        (logger.info ?? logger.log).call(logger, line);
      } catch {
      }
    }).then((off) => {
      if (typeof off === "function") disposers.push(off);
    }).catch((error) => {
      logger.warn("dsh-pocket: tihu control tool disabled | \u9E48\u9E55\u63A7\u5236\u5DE5\u5177\u6CE8\u518C\u5931\u8D25: %s", error?.stack ?? error);
    });
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
