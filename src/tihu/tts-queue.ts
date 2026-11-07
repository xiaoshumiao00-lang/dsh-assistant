/**
 * 鹈鹕（tihu）页面侧朗读队列 —— 纯状态机。
 *
 * 为什么单独一个文件：页面是**运行时拼出来的 HTML 字符串**（page.ts），拿不到
 * 打包后的模块；而队列调度必须能被单测直接驱动。所以这里用「一份 JS 源码字符串」
 * 同时喂给两处：
 *   1. `tihuPageHtml()` 把 `TTS_QUEUE_SOURCE` 原样嵌进页面 <script>；
 *   2. `scripts/test-tihu-protocol.mjs` 用 `new Function(source + '; return createTtsQueue')`
 *      在同一份代码上做入队/播放/打断/清空/超时推进的纯单测。
 *
 * 行为（2026-11-07 用户要求）：
 *   - 按到达顺序排队，一段念完间隔 200ms 再念下一段；
 *   - **收到新段不 cancel**（旧实现每段都 cancel，只剩最后一句）；
 *   - 只有 stop()（新一轮回复 / 停止朗读 / 重读一遍前）才 cancel + 清队列；
 *   - Chrome 的 `onend` 可能不回调：按文本长度估时 ×1.5 + 2s 强制推进；
 *   - 队列上限 200 段，超出丢弃并上报（防失控）。
 */
export const TTS_QUEUE_SOURCE = `function createTtsQueue(deps) {
  var queue = [];
  var speaking = false;
  var guard = 0;
  var gap = 0;
  var epoch = 0;
  var MAX = 200;
  var CHAR_MS = 220;
  function log(kind, text) { try { if (deps.onEvent) deps.onEvent(kind, text); } catch (e) {} }
  function clearGuard() { if (guard) { deps.clearTimeout(guard); guard = 0; } }
  function clearGap() { if (gap) { deps.clearTimeout(gap); gap = 0; } }
  function pump() {
    if (speaking || queue.length === 0) return;
    var item = queue.shift();
    speaking = true;
    var mine = epoch;
    var estimate = Math.max(1000, item.length * CHAR_MS);
    guard = deps.setTimeout(function () {
      if (mine !== epoch) return;
      log('timeout', item);
      finish();
    }, Math.round(estimate * 1.5) + 2000);
    try {
      log('start', item);
      deps.speak(item, function () { if (mine !== epoch) return; finish(); });
    } catch (e) {
      log('error', String(e));
      finish();
    }
  }
  function finish() {
    if (!speaking) return;
    speaking = false;
    clearGuard();
    // 200ms 间隔：Chrome 连续 speak 容易叠音/丢 onend。
    gap = deps.setTimeout(function () { gap = 0; pump(); }, 200);
  }
  function stop() {
    epoch += 1;
    clearGuard();
    clearGap();
    speaking = false;
    queue = [];
    try { deps.cancel(); } catch (e) {}
    log('stop');
  }
  function enqueue(text) {
    var value = String(text == null ? '' : text).trim();
    if (!value) return;
    if (queue.length >= MAX) { log('drop', value); return; }
    queue.push(value);
    pump();
  }
  function replay(texts) {
    stop();
    var list = Array.isArray(texts) ? texts : [];
    for (var i = 0; i < list.length; i += 1) enqueue(list[i]);
    pump();
  }
  return {
    enqueue: enqueue,
    stop: stop,
    replay: replay,
    pump: pump,
    size: function () { return queue.length; },
    isSpeaking: function () { return speaking; },
    max: MAX
  };
}`

/** 单段时长估算（毫秒/字符），供超时兜底与测试引用。 */
export const TTS_CHAR_MS = 220
