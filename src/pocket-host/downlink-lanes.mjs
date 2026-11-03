// 手机侧下行「分道 + 背压 + 合并 + 饥饿闸门 + 深队列放行预算」调度器（P0-1）。
//
// 为什么需要它：mux 只有一条物理 socket，会话开场快照 / follow 批量事件这些
// MB 级大帧会把「这条 TCP 的发送缓冲」灌满，于是同一个隧道里的点击（交互 RPC 的
// 响应、control 小帧）只能排在它们后面——用户看到的就是「点了没反应」。
// 本模块在**写 socket 之前**把下行消息分成两条道：
//   - high：交互/状态小帧（默认 ≤ 2048 B），可以越过还在排队的 low 大帧先发；
//   - low ：快照/批量事件等大帧，只在没有可越过高帧时才发。
// 两道闸门保证「既不卡死、也不洪灌」：
//   - 饥饿闸门（maxLowLaneWaitMs，默认 4 s）：low 大帧被小帧插队到超时后，按原顺序放它走；
//   - 深队列放行预算（deepQueueBytes + lowLaneWindowBytes/lowLaneWindowMs）：队列已经堆了
//     好几 MB 时，这一窗口已经放过东西就把下一条超大 low 帧先留在本地，让后排的小帧越过去。
//     实测过 peakQueuedBytes 2.79 MB / 单帧最大 2.79 MB —— 手机端读端就是被这种帧连堵两次。
//
// 约束（必须遵守，否则会破坏 mux 协议）：
//   1. **同一条逻辑流（streamId）内部严格保序**——高帧只能越过「另一条流」的帧；
//      未解析出 streamId 的帧视为「谁都不能越过」，最保守。
//   2. 越过只发生在「大帧还没开始写」时；一旦某条大帧开始 encode/写 socket，
//      后续小帧必须等它写完（RFC 6455 5.6 不允许数据帧在另一条消息的分片中间插入，
//      控制帧除外，而控制帧本来就不经过本队列）。
//   3. 只有「同一 key 的再生型状态帧」允许合并（新的覆盖旧的）；唯一性帧
//      （交互响应、end/error 收尾帧）永不丢。
//
// 背压：write() 返回 false（Node socket 缓冲已满）时暂停下游、等 'drain' 再继续，
// 不再像以前那样无条件 client.write() 把字节全推给 ssh.exe/VPS 的缓冲。

/** 默认分道阈值：加密后/编码前明文 ≤ 该值的消息走 high。 */
export const DEFAULT_HIGH_LANE_BYTES = 2048;
/** 默认高水位：排队字节超过它就开始记账（并不丢帧）。 */
export const DEFAULT_HIGH_WATER_BYTES = 1_500_000;
/** 默认硬上限：超过后只允许「合并」，不允许新增更多 low 帧进队。 */
export const DEFAULT_MAX_QUEUED_BYTES = 12_000_000;
/** 默认饥饿闸门：low 帧被小帧插队最长 4 s，之后按原顺序放它走。 */
export const DEFAULT_MAX_LOW_LANE_WAIT_MS = 4000;
/** 默认「深队列」判定线：本地排队的字节超过它就开始按窗口放行 low 帧。 */
export const DEFAULT_DEEP_QUEUE_BYTES = 1_500_000;
/** 默认放行窗口 / 窗口内允许放过的 low 字节。 */
export const DEFAULT_LOW_LANE_WINDOW_MS = 1000;
export const DEFAULT_LOW_LANE_WINDOW_BYTES = 256 * 1024;

const TYPE_RE = /"type":"(item|end|error|init|open|ack|event)"/;
const STREAM_RE = /"streamId":"([A-Za-z0-9_.:-]{1,64})"|"streamId":([0-9]{1,20})/;
const PROJECTION_RE = /"type":"item".*?"value":\{"type":"projection","sessionId":"([^"]{1,80})","key":"([^"]{1,64})"/;

/**
 * 从一条下行明文消息里读出分道所需的元信息。
 * 只做前缀正则，不解析整段 JSON（大帧有 10 MB+，不能为了分类再 JSON.parse）。
 * @param {Buffer|string} text - 明文消息（deflate 之前的完整消息）
 * @returns {{lane: 'high'|'low', streamId: string|null, coalesceKey: string|null, bytes: number, kind: string}}
 */
export function classifyDownlinkMessage(text) {
  const buf = typeof text === 'string' ? null : text;
  const bytes = buf ? buf.length : Buffer.byteLength(text, 'utf8');
  // 只看前 512 B：mux 信封字段都在最前面；大帧的小值内容不参与分类。
  const head = buf ? buf.subarray(0, 512).toString('utf8') : String(text).slice(0, 512);
  const type = TYPE_RE.exec(head);
  const kind = type ? type[1] : 'unknown';
  const stream = STREAM_RE.exec(head);
  const streamId = stream ? (stream[1] ?? stream[2]) : null;
  const proj = kind === 'item' ? PROJECTION_RE.exec(head) : null;
  const coalesceKey = proj ? `p:${streamId ?? '?'}:${proj[1]}:${proj[2]}` : null;
  const lane = bytes <= DEFAULT_HIGH_LANE_BYTES ? 'high' : 'low';
  return { lane, streamId, coalesceKey, bytes, kind };
}

/**
 * 下行调度器。
 *
 * @param {object} options
 * @param {(text: Buffer, opcode: number) => Promise<{frame: Buffer, raw: boolean}>} options.encode
 *   把明文编码成一条可写帧（内部负责 deflate / 不压缩回退）。
 * @param {(frame: Buffer) => boolean} options.write - 写 socket，返回 Node 语义的 backpressure 标记。
 * @param {() => number} [options.now] - 时钟（测试可注入）。
 * @param {{highBytes?: number, highWaterBytes?: number, maxQueuedBytes?: number, allowBypass?: boolean,
 *   maxLowLaneWaitMs?: number（0 = 关掉饥饿闸门）, paceWhenDeep?: boolean（false = 关掉深队列放行预算）,
 *   deepQueueBytes?: number, lowLaneWindowMs?: number, lowLaneWindowBytes?: number}} [options.limits]
 * @param {(snapshot: object) => void} [options.onOverflow]
 */
export function createDownlinkScheduler({ encode, write, now = () => Date.now(), limits = {}, onOverflow = null }) {
  const highBytes = limits.highBytes ?? DEFAULT_HIGH_LANE_BYTES;
  const highWaterBytes = limits.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
  const maxQueuedBytes = limits.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const allowBypass = limits.allowBypass !== false;
  // 低档帧最多等这么久：之后它就优先于新来的高档帧（不再被一直插队）。
  // 3 Mbps 那条 pipe 一旦被大帧灌满，新来的小帧（点开会话的开场快照 / follow 批量事件）
  // 不能无限等下去 —— 这就是手机上「有任务在跑就哪都慢」剩下的那一挡。
  // 同一条逻辑流内部仍然严格保序：这一刀只放宽「不同流之间」的先后。
  const maxLowLaneWaitMs = Number(limits.maxLowLaneWaitMs ?? DEFAULT_MAX_LOW_LANE_WAIT_MS);
  const agingGate = maxLowLaneWaitMs > 0;
  const paceWhenDeep = limits.paceWhenDeep !== false;
  // 深队列时才生效的「放行预算」：队列已经堆了 > 1.5 MB 的大帧时，再往隧道里灌只会让
  // 手机端的读端一直堵在一个大帧上（实测过 peakQueuedBytes 2.79 MB、单帧最大 2.79 MB）。
  // 窗口里已经放过东西就先按住下一条超大 low 帧，让排队的高档小帧越过去。
  const deepQueueBytes = Number(limits.deepQueueBytes ?? DEFAULT_DEEP_QUEUE_BYTES);
  const lowLaneWindowMs = Number(limits.lowLaneWindowMs ?? DEFAULT_LOW_LANE_WINDOW_MS);
  const lowLaneWindowBytes = Number(limits.lowLaneWindowBytes ?? DEFAULT_LOW_LANE_WINDOW_BYTES);

  /** @type {Array<{text: Buffer, opcode: number, meta: object, seq: number, at: number}>} */
  let pending = [];
  let seq = 0;
  let queuedBytes = 0;
  let draining = false;
  let closed = false;
  let blockedSince = 0;
  let blockedMs = 0;
  // 深队列放行预算：windowStart = 窗口起点，windowBytes = 这个窗口里已经放进隧道的 low 字节
  let windowStart = 0;
  let windowBytes = 0;
  /** @type {NodeJS.Timeout | null} */
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
    pacedEvents: 0,
  };

  function snapshot() {
    stats.queuedBytes = queuedBytes;
    stats.blockedMs = blockedMs + (blockedSince ? now() - blockedSince : 0);
    return { ...stats };
  }

  // 同一个 TCP chunk 里常常一次到好几条 mux 帧；先攒一个微任务再选帧，
  // 这样「大帧 + 紧跟的小帧」能在同一批里按分道规则排序（不攒就会先发大帧）。
  let drainScheduled = false;
  function scheduleDrain() {
    if (drainScheduled || draining || closed) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      void drainLoop();
    });
  }

  /** 同一条流上还有更早的待发帧吗？（有则不允许越过） */
  function streamBlockedFor(item) {
    if (item.meta.streamId === null) return true;
    for (const other of pending) {
      if (other === item) break;
      if (other.meta.streamId === null) return true;
      if (other.meta.streamId === item.meta.streamId) return true;
    }
    return false;
  }

  /** 窗口滚动：每 lowLaneWindowMs 重新算「这个窗口里能放进隧道的 low 字节」。 */
  function rollWindow(clock) {
    if (clock - windowStart >= lowLaneWindowMs) {
      windowStart = clock;
      windowBytes = 0;
    }
  }

  /** 被预算挡下的 low 帧必须在窗口滚动时被重新调度（不重新调度就永远不会动）。 */
  function scheduleWindowWake() {
    if (wakeTimer !== null || closed) return;
    const wait = Math.max(1, lowLaneWindowMs - (now() - windowStart));
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      scheduleDrain();
    }, wait);
    if (typeof wakeTimer.unref === 'function') wakeTimer.unref();
  }

  /** 选下一条：优先 high 且可安全越过；等太久的 low 就不再让别人插队。 */
  function pick() {
    if (pending.length === 0) return null;
    if (!allowBypass) return pending.shift();
    const clock = now();
    rollWindow(clock);
    const head = pending[0];
    // 队列头那条已经等够时限：直接按原顺序发它。
    // 这一挡是关键：没有它，low 大帧会被「一直有新来的小帧」插队插到底，
    // 大帧自己反而永远发不出去（下行整条链路停滞，手机端表现为一直转圈）。
    if (agingGate && head.meta.lane === 'low' && clock - head.at >= maxLowLaneWaitMs) {
      pending.shift();
      stats.agedLow += 1;
      return head;
    }
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      if (item.meta.lane !== 'high') continue;
      if (streamBlockedFor(item)) continue;
      pending.splice(i, 1);
      if (i > 0) stats.reordered += 1;
      return item;
    }
    // 深队列 + 这一窗口已经放过东西 + 这条大帧会超出窗口预算：先把它留在本地队列，
    // 期间后面来的高档小帧可以越过去 —— 点击响应不再排在 MB 级帧之后。
    // 窗口是空的就先让它走（一条孤零零的开屏快照不该因此慢一拍）。
    if (paceWhenDeep
      && head.meta.lane === 'low'
      && queuedBytes > deepQueueBytes
      && windowBytes > 0
      && windowBytes + head.meta.bytes > lowLaneWindowBytes) {
      stats.pacedEvents += 1;
      scheduleWindowWake();
      return null;
    }
    return pending.shift();
  }

  async function drainLoop() {
    if (draining || closed) return;
    draining = true;
    try {      for (;;) {
        if (closed) return;
        const item = pick();
        if (!item) return;
        queuedBytes -= item.meta.bytes;
        let encoded;
        try {
          encoded = await encode(item.text, item.opcode);
        } catch (error) {
          // 编码失败由上层熔断（ws-deflate 会 fail 整条连接），这里只把当前项丢掉。
          stats.dropped += 1;
          onOverflow?.({ reason: 'encode-failed', error: String(error?.message ?? error), ...snapshot() });
          continue;
        }
        if (closed) return;
        if (item.meta.bytes > stats.maxFrameBytes) stats.maxFrameBytes = item.meta.bytes;
        stats.bytesOut += encoded.frame.length;
        // 窗口预算只算 low 档（high 档不受预算限制，它本来就是为了让点击有反应）
        if (item.meta.lane === 'low') windowBytes += item.meta.bytes;
        const accepted = write(encoded.frame);
        stats.sent += 1;
        if (!accepted) {
          // 背压：等 'drain'，期间不再取下一帧（不让本机缓冲继续膨胀）。
          blockedSince = now();
          await new Promise((resolve) => {
            const onDrain = () => { drainResolve = null; resolve(); };
            drainResolve = onDrain;
          });
          if (blockedSince) { blockedMs += now() - blockedSince; blockedSince = 0; }
        }
      }
    } finally {
      draining = false;
    }
  }

  /** @type {null | (() => void)} */
  let drainResolve = null;

  return {
    /** 收一条下行明文消息。 */
    push(text, opcode = 1) {
      if (closed) return;
      const buf = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
      const meta = classifyDownlinkMessage(buf);
      meta.lane = meta.bytes <= highBytes ? 'high' : 'low';
      stats.enqueued += 1;
      stats.bytesIn += meta.bytes;
      if (meta.lane === 'high') stats.highFrames += 1; else stats.lowFrames += 1;
      const item = { text: buf, opcode, meta, seq: ++seq, at: now() };
      // 合并：同一 key 的再生型状态帧，新值覆盖旧值（旧帧位置保留，语义仍是「最新值」）。
      if (meta.coalesceKey) {
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          if (pending[i].meta.coalesceKey === meta.coalesceKey) {
            queuedBytes -= pending[i].meta.bytes;
            // 排队起始时刻保留最早的那次：合并只换内容，不能让等了很久的槽重新计时
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
      if (queuedBytes + meta.bytes > maxQueuedBytes && meta.lane === 'low') {
        // 硬上限：low 帧进队会撑爆本机内存。先试合并（上面已试），否则记账并通知上层。
        stats.overflowEvents += 1;
        onOverflow?.({ reason: 'queue-overflow', ...snapshot() });
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
    paused() { return drainResolve !== null; },
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
    snapshot,
  };

  function peak() {
    if (queuedBytes > stats.peakQueuedBytes) stats.peakQueuedBytes = queuedBytes;
  }
}
