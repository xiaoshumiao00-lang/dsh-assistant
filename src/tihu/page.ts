/**
 * 鹈鹕（tihu）P0 模拟设备页。
 *
 * 一条 HTML 即可：无构建、无框架、无外部资源（手机远程链路上少一次请求就少一次失败）。
 * 页面由 pocket 代理在**鉴权之后**直接吐出（见 proxy.mjs 的 /tihu 分支），
 * 所以它和手机上的 DSH 页面是同一个源、同一份 cookie——不需要第二套登录。
 *
 * P0 的两条音频来源（效果完全一致，都走 audio.frame）：
 *   1. 按住说话：getUserMedia + MediaRecorder → 解码 → 重采样 16 kHz 单声道 16 bit → WAV；
 *   2. 无麦克风：选本地 WAV 文件（或拖进来）→ 同一条解码/重采样/上行路径。
 *      台式机没有麦克风时用这一条，验收不依赖手机。
 *
 * TTS 只播放宿主下发的 PCM（edge 云健 / Qwen GPU）；页面不再使用浏览器语音。
 */
import { ACTUAL_SIZE_SCALE, SCREEN_SPEC } from './screen-spec.ts'
export function tihuPageHtml(options: { lanePath: string; protocol: string }): string {
  const lane = JSON.stringify(options.lanePath)
  const protocol = JSON.stringify(options.protocol)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>鹈鹕 · 模拟设备</title>
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
  /* ── 真机屏幕：ESP32-S3-BOX-3B · 2.4″ · 320×240，1:1 CSS px，外壳只是装饰 ── */
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
  /* 仅屏幕：去掉外壳装饰，只留 320×240 精确边界 */
  .shell-off .bezel { background:none; padding:0; border-radius:0; box-shadow:none; }
  .shell-off .mics, .shell-off .grille, .shell-off .dock { display:none; }
  .shell-off #screen { border:1px solid var(--accent); border-radius:0; }
  /* 屏幕本体：固定 320×240（screen-spec），内容按 8px 内边距排版，绝不滚动 */
  #screen { position:relative; width:320px; height:240px; box-sizing:border-box; padding:8px; overflow:hidden;
    touch-action:none;
    background:#05080b; color:var(--fg); border:1px solid #000; border-radius:3px;
    display:flex; flex-direction:column; gap:4px; }
  #screen .stage { font-size:12px; line-height:14px; letter-spacing:1px; color:var(--accent);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .title { font-size:18px; font-weight:700; line-height:22px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen ul { margin:0; padding:0; list-style:none; font-size:16px; line-height:20px; color:#c3ccd5; }
  #screen ul li { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .reply-body { display:none; flex:1; overflow:hidden; font-size:16px; line-height:20px; color:#d9e2ea; }
  #screen .reply-line { white-space:nowrap; overflow:hidden; }
  #screen .reply-line.cur { background:var(--accent); color:#04110f; border-radius:3px; }
  #screen .home-body { display:none; flex:1; overflow:hidden; }
  #screen.home-mode .home-body { display:block; }
  #screen.home-mode .title, #screen.home-mode ul, #screen.home-mode .reply-body, #screen.home-mode .bar,
  #screen.home-mode .action-bar, #screen.home-mode .run-list { display:none; }
  /* 回复屏底部动作条（停止 / 重读 / 主页） */
  #screen .action-bar { display:none; flex:none; gap:6px; padding-top:4px; }
  #screen.reply-mode .action-bar { display:flex; }
  #screen .action-bar button { flex:1; min-width:0; min-height:28px; padding:0 2px; white-space:nowrap;
    border-radius:6px; border:1px solid #33414f; background:#1b2430; color:#d9e2ea; font-size:13px; }
  /* 有历史可翻时是 5 个按钮（停止/重读/主页/上一条/下一条）：小一号字号，304px 内不换行不溢出 */
  #screen .action-bar.many button { font-size:11px; }
  #screen .action-bar button:active { background:#2c3d4e; }
  /* 状态屏底部：其他正在运行的会话 */
  #screen .run-list { display:none; flex:none; margin-top:6px; }
  #screen.run-on .run-list { display:block; }
  #screen .run-row { display:flex; align-items:center; gap:6px; height:22px; font-size:13px; color:#9fb0c0;
    border-top:1px solid #1e2a36; }
  #screen .run-row .dot { width:6px; height:6px; border-radius:50%; background:#35d07f; flex:none; }
  #screen .run-row .t { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  #screen .run-row .go { color:#4f8ef7; font-size:12px; flex:none; }
  #screen .tap-flash { position:absolute; width:28px; height:28px; margin:-14px 0 0 -14px; border-radius:50%;
    background:rgba(255,255,255,.35); pointer-events:none; z-index:5; animation:tapFlash .18s ease-out forwards; }
  @keyframes tapFlash { from { opacity:.8; transform:scale(.4); } to { opacity:0; transform:scale(1.4); } }
  #screen .home-item { height:36px; box-sizing:border-box; padding:1px 0; overflow:hidden; }
  #screen .home-row1 { display:flex; align-items:center; gap:6px; font-size:16px; font-weight:700; line-height:20px; white-space:nowrap; }
  #screen .home-dot { width:8px; height:8px; border-radius:50%; flex:none; background:#6b7785; }
  #screen .home-row1 .name { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .home-row2 { font-size:12px; line-height:14px; color:#8b97a5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .home-dot.running { background:#35d07f; }
  #screen .home-dot.idle { background:#6b7785; }
  #screen .home-dot.done { background:#4f8ef7; }
  /* 首页顶部「最近回答 · 会话名」行：单行省略，点它回到那条回答的朗读屏 */
  #screen .home-recent { display:block; height:20px; box-sizing:border-box; margin:0 0 2px; padding:0 4px;
    border:1px solid #2a5a54; border-radius:4px; background:rgba(20,44,40,.55);
    font-size:13px; line-height:16px; color:#9fd8cf; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
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
  /* 屏下的会话选择器：没有会话时展开、绑定后收起（按钮可再展开） */
  .sess-now { font-size:13px; line-height:1.35; margin:0 0 8px; word-break:break-word; }
  .sess-now.none { color:var(--warn); }
  .sess-now.bad { color:var(--err); }
  .cu-warn { display:none; background:#3a1414; border:1px solid #b04545; color:#ffd9d9;
    border-radius:8px; padding:8px 10px; font-size:12px; line-height:1.45; margin:0 0 8px; }
  /* 音频解锁横幅：浏览器自动播放策略会把手动创建的 AudioContext 置为 suspended，
     此时 PCM 全部「到达但不出声」。点一次页面即可解锁（resume）。 */
  .audio-warn { display:none; background:#3a2f12; border:1px solid #b08a45; color:#ffe9c2;
    border-radius:8px; padding:8px 10px; font-size:12px; line-height:1.45; margin:8px 12px 0; cursor:pointer; }
  .audio-warn.on { display:block; }
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
  <b>鹈鹕 · 模拟设备</b><span>协议 v0</span>
  <span id="conn">连接中…</span>
</header>

<div class="audio-warn" id="audioWarn">🔇 点一下屏幕启用声音（浏览器要求先有一次点击，否则朗读只有数据没有声音）</div>

<div class="device-wrap" id="deviceWrap">
  <div class="device-title">ESP32-S3-BOX-3B · 2.4″ · 320×240 · 触摸屏</div>
  <div class="device-caption none" id="sessLine">当前会话：未选定</div>
  <div class="device" id="device">
    <div class="bezel">
      <div class="mics"><span></span><span></span></div>
      <div id="screen">
        <div class="stage" id="stage">连接</div>
        <div class="title" id="title">正在连接宿主…</div>
        <ul id="bullets"></ul>
        <div id="runList" class="run-list"></div>
        <div id="replyBody" class="reply-body"></div>
        <div id="actionBar" class="action-bar"></div>
        <div id="homeBody" class="home-body"></div>
        <div id="pendingRail" class="pending-rail"></div>
        <div id="scrollHint" class="scroll-hint"></div>
        <div class="bar"><span id="progress">—</span><div class="track"><div class="fill" id="fill"></div></div></div>
      </div>
      <div class="grille"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
    </div>
    <div class="dock"></div>
  </div>
  <div class="screen-tools">
    <button data-scale="1">1×</button>
    <button data-scale="2" class="on">2×</button>
    <button data-scale="actual">实际尺寸</button>
    <button id="shellToggle">仅屏幕</button>
    <span class="hint" id="scaleHint">640 × 480 显示</span>
  </div>
</div>

<div class="card" id="sessCard">
  <h4>当前会话（Computer Use 模式）</h4>
  <div class="cu-warn" id="cuWarn"></div>
  <div class="sess-now none" id="sessNow">还没有选定会话，点下面选一个</div>
  <div class="sess-list" id="sessList"></div>
  <div class="row" style="margin-top:8px">
    <button id="sessSwitch" style="display:none">换个会话</button>
    <button id="sessAuto" style="display:none">恢复自动</button>
    <button id="sessRefresh" style="flex:1">刷新会话列表</button>
  </div>
  <div class="hint" id="sessHint">列表只显示 Computer Use 模式会话；默认自动绑定最近活跃的一条，手动选一次后以手动为准。</div>
</div>

<div class="card" id="voiceCard">
  <h4>音色 · 本地 TTS（Qwen3-TTS 0.6B）</h4>
  <div class="row">
    <select id="voiceSelect" style="flex:1"></select>
    <button id="audioTest" title="念一句示例语音，验证声音（不出声就点它）">试听</button>
    <button id="voiceRefresh">刷新</button>
  </div>
  <div class="hint" id="audioTestHint">试听会先解锁音频：有本轮缓存就重播，否则让宿主念一句示例（走正式朗读同一条 TTS 链路）。</div>
  <div class="row" style="margin-top:8px">
    <input id="voiceName" placeholder="音色名（英文/数字/下划线）" style="flex:1" />
    <label class="file" style="flex:1">上传参考音频（3–10 秒）<input id="voiceFile" type="file" accept="audio/*"></label>
  </div>
  <div class="row" style="margin-top:8px">
    <select id="edgeVoiceSelect" style="flex:1">
      <option value="zh-CN-YunjianNeural">兜底音色：云健 Yunjian</option>
      <option value="zh-CN-YunxiNeural">兜底音色：云希 Yunxi</option>
      <option value="zh-CN-XiaoxiaoNeural">兜底音色：晓晓 Xiaoxiao</option>
      <option value="zh-CN-YunyangNeural">兜底音色：云扬 Yunyang</option>
    </select>
  </div>
  <label class="hint" style="display:flex;align-items:center;gap:6px;margin-top:8px">
    <input id="offlineOnly" type="checkbox" style="width:auto" /> 仅离线（禁用 edge 云健，走本地 Qwen）
  </label>
  <input id="voiceNote" placeholder="备注（可选）" style="margin-top:8px" />
  <div class="hint" id="voiceHint">仅可用于你本人或已获授权的音色；参考音频只在本机处理，不上传云端。</div>
</div>

<div class="row">
  <button id="talk">按住说话</button>
  <label class="file">选 WAV 文件<input id="file" type="file" accept="audio/*"></label>
</div>
<div class="hint">没有麦克风？点「选 WAV 文件」或把音频文件拖进页面，走的是同一条 audio.frame 上行。</div>

<div class="card">
  <h4>转写 / 输入</h4>
  <div id="transcript" class="empty">（还没有内容）</div>
  <div class="row" style="margin-top:8px">
    <button id="retry">撤回重说</button>
    <button id="speak" title="把本轮回复从头再念一遍">重读一遍</button>
    <button id="ttsStop" title="立刻停止朗读">停止朗读</button>
  </div>
  <textarea id="text" placeholder="文字兜底：直接输入要交给会话的话"></textarea>
  <div class="row" style="margin-top:8px"><button id="send" style="flex:1">发送到当前会话</button></div>
  <div class="row" style="margin-top:8px"><button id="end" style="flex:1;border-color:#b04545">结束本次语音会话</button></div>
  <div class="hint">「结束」会立刻解除危险动作闸门（不用等 120 秒空闲），之后你自己在会话里的操作完全不受影响。</div>
</div>

<div class="card" id="ask">
  <h4>⚠ 危险动作确认</h4>
  <div class="title" id="askTitle">—</div>
  <div class="detail" id="askDetail"></div>
  <div class="row"><button class="yes" id="askYes">确认</button><button id="askNo">取消</button></div>
</div>

<div class="card">
  <h4>事件</h4>
  <div id="events"></div>
</div>

<div id="drop">松开即可上传这段音频</div>

<script>
(function () {
  'use strict';
  var LANE = ${lane};
  var PROTOCOL = ${protocol};
  /* 真机屏幕规格：与 src/tihu/screen-spec.ts 同一份常量（页面只消费，不另写数值）。 */
  var SCREEN = ${JSON.stringify(SCREEN_SPEC)};
  var ACTUAL_SCALE = ${JSON.stringify(ACTUAL_SIZE_SCALE)};
  function clipScreen(value, max) {
    var text = String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    if (text === '') return '';
    var chars = Array.from(text);
    if (chars.length <= max) return text;
    return chars.slice(0, Math.max(1, max - 1)).join('') + '…';
  }
  function fitLines(lines, maxLines) {
    return (lines || []).filter(function (line) { return String(line || '').trim() !== ''; }).slice(0, maxLines);
  }
  /** 按像素宽度折行（CJK 1em / ASCII 0.47em），与 screen-spec 同一估算。 */
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
    samplePending: false, sampleTimer: 0,
    voice: 'default', voices: [], voiceEngine: null,
    reply: null, replyCharPos: 0, replyTimer: 0, highlightLock: false, audioStarted: false, screenMode: 'status', pending: [], boundProject: '', homeProjects: [], screenScale: 2, actions: [], running: [] };

  /* ---------- 会话定位 ----------
     2026-11-07 P0：localStorage **按 origin 隔离**。用户在桌面宿主
     （http://127.0.0.1:57440）选过会话，打开公网 http://<公网IP>:<端口>/tihu 时
     那个 key 根本不存在 —— 旧实现直接报「还没有会话」。现在按这个顺序找：
       1. URL ?session=<id>（最高优先级，绑定后写回）；
       2. 本 origin 自己的 dsh.tihu.session（页面自己选过的）；
       3. 宽松读一次 dsh.sessions.current（只在同 origin 打开时才有用）；
       4. 都没有 → 不报错，显示下面的选择器，点一条即绑定。
   */
  var SESSION_KEY = 'dsh.tihu.session';
  var LEGACY_SESSION_KEY = 'dsh.sessions.current';

  function urlSessionId() {
    try { return new URLSearchParams(location.search).get('session') || ''; } catch (e) { return ''; }
  }
  /** 从任意文本里宽松抠一个会话 id（旧 key 可能是 JSON、也可能是裸字符串）。 */
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
    } catch (e) { /* 不是 JSON：忽略 */ }
    return '';
  }
  function storedSessionId() {
    try { return localStorage.getItem(SESSION_KEY) || ''; } catch (e) { return ''; }
  }
  function rememberSessionId(sessionId) {
    try {
      if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* 隐私模式忽略 */ }
  }
  function legacySessionId() {
    try { return looseSessionId(localStorage.getItem(LEGACY_SESSION_KEY)); } catch (e) { return ''; }
  }
  function pickInitialSession() {
    // 自动绑定优先级：URL（显式）> 上次记住的（校验后）> 最近活跃的 CU（宿主自动）> 选择器。
    var fromUrl = urlSessionId();
    if (fromUrl) return { id: fromUrl, source: 'url', mode: 'manual' };
    var stored = storedSessionId();
    if (stored) return { id: stored, source: 'local', mode: 'manual' };
    var legacy = legacySessionId();
    if (legacy) return { id: legacy, source: 'legacy', mode: 'manual' };
    return { id: '', source: '', mode: 'auto' };
  }
  /** 上次自动绑定到的会话 id（localStorage，用来识别「已自动跟随到」）。 */
  function lastAutoSessionId() {
    try { return localStorage.getItem('dsh.tihu.auto') || ''; } catch (e) { return ''; }
  }
  function rememberAutoSessionId(sessionId) {
    try {
      if (sessionId) localStorage.setItem('dsh.tihu.auto', sessionId);
      else localStorage.removeItem('dsh.tihu.auto');
    } catch (e) { /* 隐私模式忽略 */ }
  }
  function shortId(sessionId) {
    if (!sessionId) return '';
    return String(sessionId).replace(/^session-/, '').slice(0, 8);
  }

  /* ---------- 屏 ---------- */
  function fitTextPx(text, width, fontPx) {
    var chars = Array.from(String(text || ''));
    var out = '';
    var used = 0;
    for (var i = 0; i < chars.length; i += 1) {
      var code = chars[i].codePointAt(0) || 0;
      var wide = (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff);
      var w = (wide ? 1 : 0.47) * fontPx;
      if (used + w + fontPx * 0.47 > width) return out === '' ? '…' : out + '…';
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
      sub.appendChild(document.createTextNode('新回复'));
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

  /* 页脚：绑定状态每帧都刷新（旧实现只在主页帧更新，会话屏帧里一直是陈旧的「未绑定」）。 */
  function updateScrollHint() {
    $('scrollHint').textContent = state.sessionBound
      ? ('已绑定：' + (state.boundProject || state.sessionTitle || '未命名会话'))
      : '';
  }
  function renderActions() {
    var bar = $('actionBar');
    bar.innerHTML = '';
    var actions = state.actions || [];
    // 5 个按钮（停止/重读/主页/上一条/下一条）时收小字号，304px 内挤得下、不换行。
    bar.className = actions.length > 3 ? 'action-bar many' : 'action-bar';
    for (var i = 0; i < actions.length; i += 1) {
      var button = document.createElement('button');
      button.textContent = actions[i].label;
      button.setAttribute('data-action', actions[i].id);
      bar.appendChild(button);
    }
  }
  function renderRunning() {
    var list = $('runList');
    var screen = $('screen');
    list.innerHTML = '';
    var rows = state.running || [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = document.createElement('div');
      row.className = 'run-row';
      row.setAttribute('data-session', rows[i].sessionId);
      var dot = document.createElement('span');
      dot.className = 'dot';
      var text = document.createElement('span');
      text.className = 't';
      text.textContent = rows[i].title;
      var go = document.createElement('span');
      go.className = 'go';
      go.textContent = '切换';
      row.appendChild(dot);
      row.appendChild(text);
      row.appendChild(go);
      list.appendChild(row);
    }
    if (rows.length) screen.classList.add('run-on'); else screen.classList.remove('run-on');
  }
  function renderScreen(payload) {
    var screen = $('screen');
    renderPending(payload || {});
    updateScrollHint();
    if (payload && payload.mode === 'home' && payload.home) {
      state.screenMode = 'home';
      state.reply = null;
      state.highlightLock = false;
      $('stage').textContent = '项目 ' + payload.home.total + ' 个 · ' + (payload.home.page.index + 1) + '/' + payload.home.page.total;
      $('replyBody').innerHTML = '';
      var homeBody = $('homeBody');
      homeBody.innerHTML = '';
      var projects = payload.home.projects || [];
      // 首页顶部「最近回答 · 会话名」：只有该会话存了回复才显示（点它回到那条回答的朗读屏）。
      var recent = payload.home.recent;
      if (recent && recent.sessionId) {
        var recentRow = document.createElement('div');
        recentRow.className = 'home-recent';
        recentRow.id = 'homeRecent';
        recentRow.setAttribute('data-session', recent.sessionId);
        var railOn = state.pending && state.pending.length > 0;
        recentRow.textContent = fitTextPx('最近回答 · ' + (recent.title || '最近会话'), railOn ? 232 : 292, 13);
        homeBody.appendChild(recentRow);
      }
      state.homeProjects = projects;
      state.actions = [];
      state.running = [];
      renderActions();
      renderRunning();
      for (var pi = 0; pi < projects.length; pi += 1) {
        var project = projects[pi];
        var item = document.createElement('div');
        item.className = 'home-item';
        if (project.sessionId) item.setAttribute('data-session', project.sessionId);
        if (project.name) item.setAttribute('data-project', project.name);
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
      // 保留 rail-on：renderPending 刚按本帧 pending 加上的类不能被整串覆盖（气泡轨要一直可见）。
      screen.className = 'home-mode' + (state.pending && state.pending.length ? ' rail-on' : '');
      updateScrollHint();
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
      $('stage').textContent = clipScreen(payload.stage || '回答中', SCREEN.stageChars);
      screen.className = (payload.tone || 'ok') + ' reply-mode' + (state.pending && state.pending.length ? ' rail-on' : '');
      renderReply();
      state.running = [];
      renderRunning();
      state.actions = payload.actions || [];
      renderActions();
      return;
    }
    state.screenMode = 'status';
    state.reply = null;
    // 严格按 320×240 规格排版：stage ≤10、标题 ≤28 且单行、正文最多 3 行 ×18 字。
    // 多出来的内容留在事件区，屏幕上不允许出现半行或滚动条。
    var stageText = clipScreen(payload.stage || '', SCREEN.stageChars);
    $('stage').textContent = stageText;
    // 新四行格式第一行就是会话标题，没有阶段小字时不要留空行。
    $('stage').style.display = stageText === '' ? 'none' : '';
    $('title').textContent = payload.title || '';
    var list = $('bullets');
    list.innerHTML = '';
    var rawBullets = payload.bullets || [];
    // 第四行统计：小 2 号字号，按它自己的字号量宽与折行，不再套正文字符数
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
    $('replyBody').innerHTML = '';
    screen.className = (payload.tone || 'idle') + (state.pending && state.pending.length ? ' rail-on' : '');
    state.actions = [];
    renderActions();
    state.running = payload.running || [];
    renderRunning();
    var progress = payload.progress;
    if (progress && typeof progress.done === 'number') {
      $('progress').textContent = progress.total ? (progress.done + '/' + progress.total) : String(progress.done);
      $('fill').style.width = progress.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) + '%' : '0%';
    }
  }

  /* reply 模式渲染：句子窗口 → 每行 18 字 → 可视 10 行，当前句反色并居中。 */
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
      var contentWidth = (SCREEN.widthPx || 320) - 2 * (SCREEN.paddingPx || 8) - 4;
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
    // 宿主已经按 scrollOffset 切好可视窗口，页面直接渲染，不再自行居中。
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
      if (scroll.offset > 0) hint.textContent = '↑ 上方还有 ' + scroll.offset + ' 行';
      else if (scroll.maxOffset > 0) hint.textContent = '↓ 下方还有 ' + scroll.maxOffset + ' 行';
      else hint.textContent = '';
    }
  }

  function addEvent(kind, text) {
    var row = document.createElement('div');
    row.className = kind;
    row.textContent = new Date().toLocaleTimeString() + '  ' + text;
    $('events').appendChild(row);
  }

  /* ---------- 会话选择器（屏下，只列 Computer Use 模式） ----------
   * 鹈鹕要靠 GUI 看屏幕、点按钮：只有 Computer Use / 电脑操作模式的会话能接这活。
   * 模式判定**只认宿主返回的 agentPreset**（投影 agentPreset，回退 header），
   * 不靠标题猜。宿主只下发 CU 会话；非 CU 会话在页面上只能是「当前（不可用）」灰色行。
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
      warn.textContent = '⚠ 这条会话不是 Computer Use 模式'
        + (state.sessionPreset ? '（' + state.sessionPreset + '）' : '')
        + '：无法看屏/点按。请从下面换一个 Computer Use 会话。';
    } else {
      warn.textContent = '';
    }
  }
  function renderSessionBar() {
    var label = sessionLabel();
    var modeText = state.mode === 'auto' ? '（自动）' : '（手动）';
    if (state.sessionBound) {
      $('sessNow').textContent = '当前会话：' + label + modeText;
      $('sessNow').className = 'sess-now' + (state.computerUse === false ? ' bad' : '');
      $('sessLine').textContent = '当前会话：' + label + modeText;
      $('sessLine').className = 'device-caption' + (state.computerUse === false ? ' bad' : '');
    } else if (state.sessionId) {
      $('sessNow').textContent = '正在确认会话 ' + shortId(state.sessionId) + '…';
      $('sessNow').className = 'sess-now';
      $('sessLine').textContent = '当前会话：确认中' + modeText;
      $('sessLine').className = 'device-caption none';
    } else {
      $('sessNow').textContent = state.mode === 'auto'
        ? '正在自动绑定最近活跃的 Computer Use 会话…'
        : '还没有选定会话，点下面选一个';
      $('sessNow').className = 'sess-now none';
      $('sessLine').textContent = '当前会话：未选定' + modeText;
      $('sessLine').className = 'device-caption none';
    }
    $('sessSwitch').style.display = state.sessionBound ? '' : 'none';
    $('sessSwitch').textContent = state.showList ? '收起会话列表' : '换个会话';
    $('sessAuto').style.display = (state.sessionBound && state.mode === 'manual') ? '' : 'none';
    $('sessList').style.display = (state.sessionBound && !state.showList && state.computerUse !== false) ? 'none' : 'flex';
    $('cuWarn').style.display = state.computerUse === false ? 'block' : 'none';
  }
  function renderSessionList() {
    var box = $('sessList');
    box.innerHTML = '';
    // 当前绑定的非 CU 会话：置灰保留（用户可能从 ?session= 显式指定），不可点。
    if (state.sessionBound && state.computerUse === false && state.sessionId) {
      var current = document.createElement('div');
      current.className = 'sess-item off';
      var currentTitle = document.createElement('span');
      currentTitle.className = 't';
      currentTitle.textContent = (state.sessionTitle || ('会话 ' + shortId(state.sessionId))) + '（当前）';
      var currentMeta = document.createElement('span');
      currentMeta.className = 'm';
      currentMeta.textContent = '非 Computer Use，语音操作不可用';
      current.appendChild(currentTitle);
      current.appendChild(currentMeta);
      box.appendChild(current);
    }
    if (!state.sessions.length) {
      var note = document.createElement('div');
      note.className = 'hint';
      note.textContent = state.listLoaded
        ? (state.cuTotal === 0
            ? '还没有 Computer Use 模式会话：先在桌面端新建一个 Computer Use 模式会话，再回来点「刷新会话列表」。'
            : '最近会话里没有 Computer Use 模式（共 ' + state.total + ' 条）：请刷新，或新建一个 CU 会话。')
        : '正在读取会话列表…';
      box.appendChild(note);
      return;
    }
    state.sessions.forEach(function (row) {
      var item = document.createElement('button');
      item.className = 'sess-item' + (row.sessionId === state.sessionId ? ' on' : '');
      var title = document.createElement('span');
      title.className = 't';
      title.textContent = row.title || ('会话 ' + shortId(row.sessionId));
      var meta = document.createElement('span');
      meta.className = 'm';
      meta.textContent = 'Computer Use · ' + (row.live ? '桌面打开中' : '未打开') + ' · ' + shortId(row.sessionId);
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
    addEvent('progress', '正在绑定 Computer Use 会话 ' + shortId(sessionId) + '…');
    send('session.bind', { sessionId: sessionId });
  }
  function checkedTitle(sessionId) {
    for (var i = 0; i < state.sessions.length; i += 1) {
      if (state.sessions[i].sessionId === sessionId && state.sessions[i].title) return state.sessions[i].title;
    }
    return '';
  }
  /** 手动会话失效 / 不是 CU：按优先级回落到「自动绑定最近活跃 CU」。 */
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
    $('sessHint').textContent = reason + '已改为自动绑定最近活跃的 Computer Use 会话。';
    addEvent('alert', reason + '已改为自动绑定');
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
      // 不存在：可读提示 + 回落到自动（不白屏）。
      if (check.found === false) {
        handleSessionInvalid({
          sessionId: state.sessionId,
          reason: '会话 ' + shortId(state.sessionId) + ' 不在宿主会话列表里（可能已归档或删除）。'
        });
        return;
      }
      var cu = check.computerUse === true;
      if (state.sessionSource === 'url') {
        // ?session= 显式指定 —— 允许绑定非 CU，但必须显著提示（宿主同时下发红色屏帧）。
        setComputerUseNotice(cu, check.preset);
      } else if (!cu) {
        // 上次记住的会话已经不是 CU / 不是 CU：按优先级回落到自动。
        fallbackToAuto('上次记住的会话不是 Computer Use 模式。');
        return;
      } else if (!state.sessionBound) {
        // 仍是 CU：页面先确认，再让宿主绑定（手动）。
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
        ? '没有可自动绑定的 CU 会话：先在桌面端新建一个 Computer Use 模式会话，再点「刷新会话列表」。'
        : '列表只显示 Computer Use 模式会话；自动模式会跟随最近活跃的一条，手动选一次就以手动为准。';
    }
  }
  function handleSessionBound(payload) {
    if (!payload || !payload.sessionId) return;
    var auto = payload.auto === true;
    var previousAuto = auto ? state.lastAutoId : '';
    state.mode = auto ? 'auto' : 'manual';
    state.sessionId = payload.sessionId;
    state.sessionTitle = payload.title || state.sessionTitle || '';
    state.boundProject = payload.project || '';
    state.sessionBound = true;
    state.showList = false;
    var cu = payload.computerUse === true;
    setComputerUseNotice(cu, payload.preset);
    // 手动记忆只记手动选中的 CU 会话；自动模式不写 dsh.tihu.session，避免把自动锁死。
    rememberSessionId(!auto && cu ? payload.sessionId : '');
    if (auto) {
      state.lastAutoId = payload.sessionId;
      rememberAutoSessionId(payload.sessionId);
    }
    renderSessionBar();
    renderSessionList();
    var followed = auto && (payload.followed === true || (previousAuto !== '' && previousAuto !== payload.sessionId));
    if (followed) {
      $('sessHint').textContent = '已自动跟随到：' + sessionLabel()
        + '（' + (payload.live ? '桌面正开着' : '未打开') + '）。';
      addEvent('done', '已自动跟随到：' + sessionLabel());
      return;
    }
    $('sessHint').textContent = cu
      ? (auto
          ? '已自动绑定最近活跃的 Computer Use 会话；桌面端切到别的 CU 会话时会自动跟随。'
          : (payload.live
              ? '已手动绑定 Computer Use 会话，桌面正开着它。'
              : '已手动绑定 CU 会话；它当前没在桌面打开，语音注入前先在桌面打开。'))
      : '已绑定，但这条不是 Computer Use 模式：无法看屏/点按，请换一个 CU 会话。';
    addEvent(cu ? 'done' : 'alert',
      (cu ? (auto ? '已自动绑定：' : '已绑定会话：') : '已绑定非 CU 会话：') + sessionLabel());
  }
  function handleSessionInvalid(payload) {
    if (!payload) return;
    if (state.sessionId === payload.sessionId) {
      state.sessionId = '';
      state.sessionTitle = '';
      state.sessionBound = false;
      if (storedSessionId() === payload.sessionId) rememberSessionId('');
    }
    addEvent('alert', payload.reason || ('会话 ' + shortId(payload.sessionId) + ' 不存在，已改为自动绑定'));
    fallbackToAuto(payload.reason || ('会话 ' + shortId(payload.sessionId) + ' 不存在。'));
  }

  /* ---------- 本地 TTS（PCM）播放 ----------
     sidecar 以 24kHz/pcm16 流式下发，页面用 WebAudio 无缝排队拼接。
     页面只播放宿主合成的 PCM（edge 云健 / Qwen GPU），不再使用浏览器语音。 */
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
  /* ---------- 音频解锁 ----------
     Chrome 自动播放策略：**没有用户手势**创建的 AudioContext 是 suspended。
     旧实现只 new 不 resume，于是 tts.audio 全部到达、playPcm 也排进时间轴，
     但永远不出声（刷新页面后必现）。更糟的是 suspended 时 ctx.currentTime 冻结，
     pcmNextTime 的累加全塌缩到同一时刻，一旦恢复会让所有块同时炸响。
     所以：①任何播放前先 resume；②suspended 期间丢弃 chunk 并提示点击解锁，
     不排队；③第一次 pointerdown/keydown/touchstart 自动解锁。 */
  function resumeAudio() {
    var ctx = state.audioCtx;
    if (!ctx) return null;
    if (ctx.state !== 'suspended') return null;
    try {
      var task = ctx.resume();
      if (task && typeof task.then === 'function') task.catch(function () { /* 解锁失败：等下一次手势 */ });
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
  function audioRunning(ctx) {
    return ctx !== null && ctx !== undefined && ctx.state === 'running';
  }
  function stopPcm() {
    for (var i = 0; i < state.pcmSources.length; i += 1) {
      try { state.pcmSources[i].stop(); } catch (e) { /* 已结束 */ }
    }
    state.pcmSources = [];
    state.pcmNextTime = 0;
  }
  function playPcm(base64, sampleRate, cache) {
    if (!base64) return null;
    var ctx = ensureAudio();
    if (!ctx) return null;
    // 未解锁：先 resume，等不到 running 就**丢弃这段**并提示点一下页面——
    // 绝不排队（suspended 时 currentTime 冻结，排进去的时间轴一旦恢复会全部炸响）。
    if (!audioRunning(ctx)) {
      resumeAudio();
      if (!audioRunning(ctx)) {
        state.pcmNextTime = 0;
        showAudioWarn();
        return null;
      }
    }
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
      // 重读缓存（本轮完整 PCM）；试听音频不进缓存（否则下次「重读」会念成试听句）。
      if (cache !== false) state.turnPcm.push(samples);
      return { startAt: startAt, duration: buffer.duration };
    } catch (e) { /* 解码失败：本条只显示文字 */ }
    return null;
  }
  /** 按真实播放时刻切换当前句：不再用 tts.audio 到达即跳。 */
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
  /** 试听提示音：0.6 秒 440Hz 正弦，音量中等（直接证明音频通路可用）。 */
  function playBeep() {
    var ctx = state.audioCtx;
    if (!ctx || !audioRunning(ctx)) return false;
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      var now = ctx.currentTime;
      // 音量中等 + 两端各 20ms 渐入渐出，避免爆音。
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
   * 试听按钮：先解锁音频。
   *   1) 本轮已有缓存音频 → 重播缓存（现状不变）；
   *   2) 没有缓存 → 发 tts.sample 让宿主念一句示例，走与正式朗读完全同一条链路
   *      （edge-tts 云健 → 失败按原规则回退）。旧实现这里只会响 0.6 秒嘟声，
   *      用户以为坏了——嘟声降级为「合成彻底失败」时的兜底提示。
   */
  function audioTest() {
    var hint = $('audioTestHint');
    var setHint = function (text) { if (hint) hint.textContent = text; };
    var ctx = ensureAudio();
    if (!ctx) { setHint('这台设备没有 WebAudio，无法试听'); return; }
    var run = function () {
      if (audioRunning(ctx)) hideAudioWarn();
      if (!audioRunning(ctx)) { showAudioWarn(); setHint('无音频（点我先）：浏览器还没解锁，先点一下屏幕'); return; }
      if (state.turnPcm.length > 0 && replayPcm()) { setHint('已播放本轮缓存音频'); return; }
      state.samplePending = true;
      setHint('正在合成试听语音（edge-tts 云健）…');
      send('tts.sample', {});
      clearTimeout(state.sampleTimer);
      // 兜底：合成彻底失败/宿主没回音时，嘟一声 + 明说失败（不静默）。
      state.sampleTimer = setTimeout(function () {
        if (!state.samplePending) return;
        state.samplePending = false;
        var beeped = playBeep();
        setHint(beeped ? '试听失败：已改用提示音（原因看事件区红字）' : '试听失败：合成没有返回（看事件区红字）');
        addEvent('alert', '错误：试听语音没有返回（宿主 TTS 没响应该请求）');
      }, 15000);
    };
    var task = resumeAudio();
    if (task && typeof task.then === 'function') task.then(run, run);
    else run();
  }
  /** 收到试听音频：播放 + 明确回执；试听 PCM 不进本轮朗读缓存。 */
  function playSampleAudio(base64, sampleRate) {
    state.samplePending = false;
    clearTimeout(state.sampleTimer);
    var played = playPcm(base64, sampleRate, false);
    var hint = $('audioTestHint');
    if (played) {
      if (hint) hint.textContent = '已播放试听语音';
      addEvent('progress', '试听：已播放试听语音');
      return;
    }
    if (hint) hint.textContent = '试听失败：播放被浏览器拦了，点一下屏幕再试';
    addEvent('alert', '试听失败：播放被浏览器拦了（先点一下屏幕解锁音频）');
  }
  /* 一次性解锁：第一次真实手势里 resume，并撤掉「点一下启用声音」横幅。 */
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

  /* ---------- 音色选择 ---------- */
  function renderVoiceSelect() {
    var select = $('voiceSelect');
    if (!select) return;
    select.innerHTML = '';
    for (var i = 0; i < state.voices.length; i += 1) {
      var option = document.createElement('option');
      option.value = state.voices[i].name;
      option.textContent = state.voices[i].kind === 'default' ? '默认音色' : (state.voices[i].name + (state.voices[i].durationMs ? '（' + Math.round(state.voices[i].durationMs / 1000) + 's）' : ''));
      if (state.voices[i].name === state.voice) option.selected = true;
      select.appendChild(option);
    }
    var engine = state.voiceEngine;
    if (engine && engine.available === false) {
      $('voiceHint').textContent = '无语音：' + (engine.error || '在线兜底不可用且本地引擎未就绪') + '（本条只显示文字）。';
    } else {
      var model = (engine && engine.model) || '本地引擎';
      if (model.indexOf('edge-tts') >= 0) {
        $('voiceHint').textContent = '在线兜底：edge-tts 云健(Yunjian) / 音色 默认。仅可用于你本人或已获授权的音色。';
      } else {
        $('voiceHint').textContent = '本地 TTS：' + model + ' / 音色 ' + state.voice + '。仅可用于你本人或已获授权的音色；参考音频只在本机处理。';
      }
    }
  }

  /* ---------- WebSocket ----------
     2026-11-06 P0 修复：**token 必须进握手 URL**。
     旧实现只靠 HttpOnly cookie：用 "?token=" 打开页面时 HTML 能拿到（走 query 分支），
     但只要浏览器里没有可用 cookie（或带着一个过期的旧 cookie），WS 握手就一律 401，
     页面表现为每 2 秒 onerror 重连（"WebSocket 出错"）。实测同一台机器上用真实
     Chrome 带 token 握手 → 101 + 屏帧；不带任何凭据 → 立刻失败。
     所以：URL 上的 token 优先，其次 sessionStorage（刷新/换页后仍然记得），
     最后才退回 cookie。这条不改鉴权强度——还是同一个 PIN，只是换个位置带。 */
  function tokenFromUrl() {
    try { return new URLSearchParams(location.search).get('token') || ''; } catch (e) { return ''; }
  }
  function rememberedToken() {
    try { return sessionStorage.getItem('tihu.token') || ''; } catch (e) { return ''; }
  }
  function rememberToken(token) {
    if (!token) return;
    try { sessionStorage.setItem('tihu.token', token); } catch (e) { /* 隐私模式忽略 */ }
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
      $('conn').textContent = '已连接';
      $('conn').className = 'on';
      $('stage').textContent = $('stage').textContent.replace(/^离线 · /, '');
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
      // 自动模式：不带 id 让宿主挑「最近活跃的 CU 会话」；手动模式：URL 直接绑，
      // 本机记住的会话先让宿主校验「仍存在且仍是 CU」再绑。
      var helloSession = '';
      if (state.mode === 'manual') {
        if (state.sessionBound) helloSession = state.sessionId;
        else if (state.sessionSource === 'url') helloSession = state.sessionId;
      }
      sendHello(helloSession, state.mode === 'auto');
      if (!helloSession && state.mode !== 'auto' && !state.sessionId) {
        // 不报错：提示可操作，并展开屏下的选择器。
        state.showList = true;
        addEvent('progress', '还没有选定会话，点下面选一个');
      }
      renderSessionBar();
      requestSessions();
      send('voice.list', {});
      try { send('voice.select', { name: state.voice || 'default', edgeVoice: $('edgeVoiceSelect').value, offlineOnly: $('offlineOnly').checked }); } catch (e) { /* 忽略 */ }
      clearInterval(state.retryTimer);
      state.retryTimer = setInterval(function () { send('ping', { nonce: String(Date.now()) }); }, 25000);
    };
    ws.onclose = function (event) {
      $('conn').textContent = '已断开' + (event && event.code ? '（' + event.code + '）' : '');
      $('conn').className = 'off';
      if (state.screenMode === 'home' && !$('stage').textContent.startsWith('离线 · ')) {
        $('stage').textContent = '离线 · ' + $('stage').textContent;
      }
      state.audioPending = false;
      clearTimeout(state.audioTimer);
      addEvent('alert', '连接已断开，2 秒后自动重连（期间发送的内容不会送达）');
      clearInterval(state.retryTimer);
      setTimeout(connect, 2000);
    };
    ws.onerror = function () {
      var token = tokenFromUrl() || rememberedToken();
      addEvent('alert', 'WebSocket 出错（' + (token ? '凭据已带，检查网络/宿主是否在跑' : '没找到 token：请用带 ?token= 的链接打开本页') + '）');
    };
    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (!msg || msg.v !== PROTOCOL) return;           /* 未知版本：忽略 */
      handle(msg.type, msg.payload || {});
    };
  }
  function send(type, payload) {
    if (!state.ws || state.ws.readyState !== 1) { addEvent('alert', '连接未就绪，稍后再试'); return; }
    state.seq += 1;
    state.ws.send(JSON.stringify({
      v: PROTOCOL, type: type, id: 'dev-' + Date.now().toString(36) + '-' + state.seq, seq: state.seq, ts: Date.now(), payload: payload
    }));
  }
  /** 发 hello；sessionId 为空串表示「不指定会话」（自动模式下由宿主挑最活跃 CU）。 */
  function sendHello(sessionId, auto) {
    send('hello', {
      clientId: state.clientId,
      clientVersion: 'p0-page-5',
      protocol: PROTOCOL,
      capabilities: { screen: true, tts: true, microphone: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) },
      deviceName: '浏览器模拟设备',
      sessionId: sessionId || undefined,
      auto: auto === true ? true : undefined
    });
  }

  /* ---------- 下行处理（未知 type 一律忽略，与宿主同一条约定） ---------- */
  function handle(type, payload) {
    switch (type) {
      case 'screen.frame':
        // 屏帧不能清朗读队列：宿主回复帧的 stage 恒为「回答中」，旧实现判断的
        // stage === '回复' 从未命中（死代码，2026-11-07 断音调查确认）。
        // 清队列只留给「用户新的语音输入」（transcript 分支），否则念到一半会被自己的屏帧清掉。
        renderScreen(payload);
        break;
      case 'transcript':
        state.lastTranscript = payload.text || '';
        state.audioPending = false;
        clearTimeout(state.audioTimer);
        // 用户新一轮输入 = 新一轮朗读，停掉上一轮残留。
        resetTurnAudio();
        $('transcript').textContent = state.lastTranscript;
        $('transcript').className = '';
        addEvent('progress', '转写：' + state.lastTranscript);
        break;
      case 'tts.text': {
        var ttsText = String(payload.text || '').trim();
        if (ttsText) state.ttsTurnTexts.push(ttsText);
        break;
      }
      case 'tts.audio': {
        // 试听音频：只播、不推进高亮、不进本轮朗读缓存（试听不算一轮回复）。
        if (payload.sample === true) {
          resumeAudio();
          playSampleAudio(String(payload.data || ''), Number(payload.sampleRate) || 24000);
          break;
        }
        var audioIndex = typeof payload.index === 'number' ? payload.index : 0;
        var isNewSegment = !state.ttsAudioSeen[audioIndex];
        state.ttsAudioSeen[audioIndex] = true;
        if (typeof payload.charStart === 'number') state.replyCharPos = payload.charStart;
        // 每个音频块到达都补一次 resume：浏览器自动播放策略可能在任何时刻把 ctx 挂回 suspended。
        resumeAudio();
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
          addEvent('done', payload.cached ? ('音色 ' + created.name + ' 已存在（缓存）') : ('已创建音色 ' + created.name));
        }
        break;
      }
      case 'event.progress':
        addEvent('progress', (payload.stage ? '[' + payload.stage + '] ' : '') + (payload.text || ''));
        if (typeof payload.done === 'number') { $('progress').textContent = payload.total ? payload.done + '/' + payload.total : String(payload.done); }
        break;
      case 'event.alert':
        if (payload.level === 'error') {
          // 宿主已经明确报错（转写失败/帧被拒），不再让 15 秒超时重复提示。
          state.audioPending = false;
          clearTimeout(state.audioTimer);
        }
        // 试听合成彻底失败：宿主已发红告警，这里补一声提示音并改提示文案（不静默）。
        if (payload.level === 'error' && String(payload.text || '').indexOf('试听') === 0 && state.samplePending) {
          state.samplePending = false;
          clearTimeout(state.sampleTimer);
          var sampleHint = $('audioTestHint');
          var beeped = playBeep();
          if (sampleHint) sampleHint.textContent = beeped ? '试听失败：已改用提示音（原因见事件区红字）' : '试听失败：看事件区红字';
        }
        // 本地 TTS 失败：立刻把所有待念文本交给系统语音，别让用户等 4 秒兜底。
        addEvent('alert', (payload.level === 'error' ? '错误：' : '') + (payload.text || ''));
        break;
      case 'event.done': addEvent('done', payload.text || '完成'); break;
      case 'confirm.ask': showConfirm(payload); break;
      case 'sessions.list': handleSessionList(payload); break;
      case 'session.bound': handleSessionBound(payload); break;
      case 'session.invalid': handleSessionInvalid(payload); break;
      case 'pong': break;
      default: break; /* 未知 type：忽略 */
    }
  }

  /* ---------- 危险动作确认 ---------- */
  function showConfirm(payload) {
    state.asking = payload;
    $('askTitle').textContent = payload.title || '需要确认';
    $('askDetail').textContent = payload.detail || '';
    $('ask').classList.add('on');
    if (payload.timeoutMs) {
      setTimeout(function () {
        if (state.asking && state.asking.confirmId === payload.confirmId) { reply(payload.confirmId, false); addEvent('alert', '确认超时，已自动取消'); }
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

  /* ---------- 会话选择器按钮 ---------- */
  $('sessSwitch').onclick = function () {
    state.showList = !state.showList;
    renderSessionBar();
    renderSessionList();
  };
  /* 恢复自动：清掉手动记忆，交回宿主「最近活跃 CU 会话」自动跟随。 */
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
    addEvent('progress', '已切回自动：正在绑定最近活跃的 Computer Use 会话…');
    send('session.bind', { auto: true });
  };
  $('sessRefresh').onclick = function () { requestSessions(); };

  /* ---------- 真机屏幕：缩放三档 + 外壳开关（只影响显示，不改 320×240 内容） ---------- */
  var SCALE_MODES = {
    '1': { scale: 1, label: '320 × 240 显示（1×）' },
    '2': { scale: 2, label: '640 × 480 显示（2×）' },
    'actual': { scale: ACTUAL_SCALE, label: '实际尺寸（≈61 × 45.7 mm，近似）' }
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
    $('shellToggle').textContent = shellOn ? '仅屏幕' : '显示外壳';
  };

  /* ---------- 音频：任意音频 → 16 kHz 单声道 16 bit WAV ---------- */
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
  /* 解码 → 单声道 → 线性插值重采样到目标采样率 → WAV */
  function decodeToMono(arrayBuffer, target) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('浏览器不支持 AudioContext'));
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
      try { context.close(); } catch (e) { /* 忽略 */ }
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
      addEvent('alert', '还没有选定会话：点下面的会话列表选一个');
      state.showList = true;
      renderSessionBar();
      return;
    }
    decodeAndResample(arrayBuffer).then(function (result) {
      addEvent('progress', label + '：' + result.durationMs + ' ms，已上行，等待转写…');
      send('audio.frame', {
        format: 'wav', sampleRate: 16000, channels: 1, bits: 16,
        audioBase64: toBase64(result.wav), durationMs: result.durationMs
      });
      // 页面侧兜底：15 秒没等到 transcript 就明确报超时，不能干等。
      state.audioPending = true;
      clearTimeout(state.audioTimer);
      state.audioTimer = setTimeout(function () {
        if (!state.audioPending) return;
        state.audioPending = false;
        addEvent('alert', '转写超时：15 秒内没有收到转写结果（音频太长/服务忙/链路断了），请重试或改用文字输入');
      }, 15000);
    }).catch(function (error) {
      addEvent('alert', '解码失败：' + error.message + '（换成 16k/44.1k 的 WAV/MP3 再试）');
    });
  }

  /* ---------- 按住说话 ---------- */
  var talk = $('talk');
  function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      addEvent('alert', '这个浏览器没有麦克风接口：请用「选 WAV 文件」');
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
        blob.arrayBuffer().then(function (buffer) { sendAudio(buffer, '录音'); });
      };
      recorder.start();
      talk.classList.add('rec');
      talk.textContent = '松开发送…';
    }).catch(function (error) {
      addEvent('alert', '麦克风打不开：' + error.message + '（用「选 WAV 文件」代替）');
    });
  }
  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    state.recorder = null;
    talk.classList.remove('rec');
    talk.textContent = '按住说话';
  }
  talk.addEventListener('pointerdown', function (event) { event.preventDefault(); startRecording(); });
  talk.addEventListener('pointerup', function (event) { event.preventDefault(); stopRecording(); });
  talk.addEventListener('pointercancel', stopRecording);
  talk.addEventListener('pointerleave', function () { if (state.recorder) stopRecording(); });

  /* ---------- 文件 / 拖拽 ---------- */
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

  /* ---------- 文本 / 撤回 ---------- */
  $('send').onclick = function () {
    var text = $('text').value.trim();
    if (!text) return;
    if (!state.sessionId) {
      addEvent('alert', '还没有选定会话：点下面的会话列表选一个');
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
    $('transcript').textContent = '（还没有内容）';
    $('transcript').className = 'empty';
    addEvent('progress', '已撤回上一条转写，请重新说');
  };
  /* 重读一遍：把本轮所有 tts 段拼回来的全文**从头重播**（不是只读最后一段）。 */
  $('speak').onclick = function () {
    if (state.turnPcm.length === 0) { addEvent('alert', '还没有可重读的本地音频'); return; }
    if (replayPcm()) addEvent('progress', '重读本轮全文（本地音频）');
  };
  $('ttsStop').onclick = function () {
    stopPcm();
    addEvent('progress', '已停止朗读');
  };
  /* 试听：先解锁音频；有本轮缓存重播，否则请宿主念一句示例（嘟声只在合成失败时出现）。 */
  $('audioTest').onclick = function () {
    audioTest();
    addEvent('progress', '试听：准备示例语音');
  };

  /* ---------- 音色：选择 / 上传参考音频 ---------- */
  $('voiceSelect').onchange = function () {
    state.voice = this.value || 'default';
    send('voice.select', { name: state.voice, edgeVoice: $('edgeVoiceSelect').value });
    renderVoiceSelect();
  };
  (function initEdgeVoice() {
    var saved = '';
    try { saved = localStorage.getItem('tihu.edgeVoice') || ''; } catch (e) { /* 忽略 */ }
    if (saved) $('edgeVoiceSelect').value = saved;
    try { $('offlineOnly').checked = localStorage.getItem('tihu.offlineOnly') === '1'; } catch (e) { /* 忽略 */ }
  })();
  $('edgeVoiceSelect').onchange = function () {
    try { localStorage.setItem('tihu.edgeVoice', this.value); } catch (e) { /* 忽略 */ }
    send('voice.select', { name: state.voice, edgeVoice: this.value, offlineOnly: $('offlineOnly').checked });
    addEvent('progress', '在线兜底音色：' + this.options[this.selectedIndex].textContent);
  };
  $('offlineOnly').onchange = function () {
    try { localStorage.setItem('tihu.offlineOnly', this.checked ? '1' : '0'); } catch (e) { /* 忽略 */ }
    send('voice.select', { name: state.voice, edgeVoice: $('edgeVoiceSelect').value, offlineOnly: this.checked });
    addEvent('progress', this.checked ? '已开启仅离线：禁用 edge 云健' : '已关闭仅离线：优先 edge 云健');
  };
  $('voiceRefresh').onclick = function () { send('voice.list', {}); };

  /* ---------- 屏幕手势：滚轮 / 拖拽 / 触摸 → screen.gesture（宿主持有滚动位置） ---------- */
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
      try { screen.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
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
        var chips = document.querySelectorAll('#pendingRail .pending-chip');
        for (var ci = 0; ci < chips.length; ci += 1) {
          var chipRect = chips[ci].getBoundingClientRect();
          if (event.clientX >= chipRect.left - 8 && event.clientX <= chipRect.right + 8 &&
              event.clientY >= chipRect.top - 8 && event.clientY <= chipRect.bottom + 8) {
            hit = chips[ci].dataset.sessionId;
            break;
          }
        }
        if (hit) { send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'chip', targetSessionId: hit }); return; }
        var under = document.elementFromPoint(event.clientX, event.clientY);
        if (under && under.getAttribute) {
          var actionId = under.getAttribute('data-action');
          if (actionId) {
            // 主页/翻页都算「退出本轮朗读」：和停止一样先把页面音频队列掐掉（宿主也会 cancelRound），
            // 差别只是不回「已停止朗读」提示。
            if (actionId === 'stop' || actionId === 'home' || actionId === 'prev' || actionId === 'next') stopPcm();
            if (actionId === 'home') tapFlash(event.clientX - rect.left, event.clientY - rect.top);
            send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'action', actionId: actionId });
            return;
          }
          var rowEl = under.closest ? under.closest('.run-row') : null;
          var rowSession = rowEl && rowEl.getAttribute('data-session');
          if (rowSession) {
            send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'switch', targetSessionId: rowSession });
            return;
          }
        }
        var recentEl = under && under.closest ? under.closest('.home-recent') : null;
        if (recentEl) {
          var recentSession = recentEl.getAttribute('data-session');
          if (recentSession) { send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'recent', sessionId: recentSession }); return; }
        }
        // 项目行按元素命中：首页顶部多了「最近回答」行，不能再按固定 36px 行高算下标。
        if (state.screenMode === 'home') {
          var projectEl = under && under.closest ? under.closest('.home-item') : null;
          if (projectEl) {
            var projectSession = projectEl.getAttribute('data-session');
            if (projectSession) {
              send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'project', project: projectEl.getAttribute('data-project') || '', sessionId: projectSession });
              return;
            }
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
      addEvent('alert', '音色名只能包含英文/数字/下划线/短横线（1–32 字，不能叫 default）');
      return;
    }
    addEvent('progress', '正在处理参考音频（' + file.name + '）…');
    file.arrayBuffer().then(function (buffer) {
      return decodeToMono(buffer, 24000);
    }).then(function (result) {
      if (result.durationMs < 3000 || result.durationMs > 10000) {
        addEvent('alert', '参考音频需 3–10 秒（当前 ' + (result.durationMs / 1000).toFixed(1) + ' 秒）');
        return;
      }
      send('voice.create', {
        name: name,
        wavBase64: toBase64(result.wav),
        note: String($('voiceNote').value || '').trim()
      });
      addEvent('progress', '已上传参考音频（' + (result.durationMs / 1000).toFixed(1) + ' 秒），等待 embedding…');
    }).catch(function (error) {
      addEvent('alert', '参考音频解码失败：' + error.message);
    });
  });

  /* 「结束本次语音会话」：宿主侧立刻关掉危险动作闸门（session.end），
     不等 120 秒空闲窗口过期——用户说完就可以放心自己干活。 */
  $('end').onclick = function () {
    send('session.end', { reason: 'button', sessionId: state.sessionId || undefined });
    addEvent('progress', '已结束本次语音会话（闸门关闭）');
    $('screen').className = 'idle';
    $('stage').textContent = '空闲';
    $('title').textContent = '已结束本次会话';
  };

  renderSessionBar();
  renderSessionList();
  connect();
})();
</script>
</body>
</html>`
}
