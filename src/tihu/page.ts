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
 * TTS 用浏览器 speechSynthesis（zh-CN）——**临时方案**，见 tihuSpeak() 里的 P1 注释。
 */
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
  body { padding:12px; display:flex; flex-direction:column; gap:10px; max-width:560px; margin:0 auto; }
  header { display:flex; align-items:baseline; gap:8px; }
  header b { font-size:15px; letter-spacing:.5px; }
  header span { color:var(--dim); font-size:12px; }
  #conn { margin-left:auto; font-size:12px; color:var(--dim); }
  #conn.on { color:var(--accent); }
  #conn.off { color:var(--err); }
  /* 320×240 屏幕区：按容器宽度等比放大，比例永远是 4:3 */
  #screen { position:relative; width:100%; aspect-ratio:4/3; max-height:46vh; background:#05080b; border:1px solid var(--line);
    border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:6px; overflow:hidden; }
  #screen .stage { font-size:11px; letter-spacing:2px; color:var(--accent); text-transform:uppercase; }
  #screen .title { font-size:17px; font-weight:600; line-height:1.25; }
  #screen ul { margin:0; padding-left:16px; color:#c3ccd5; font-size:13px; }
  #screen ul li { margin:2px 0; }
  #screen .bar { margin-top:0; display:flex; align-items:center; gap:8px; font-size:12px; color:var(--dim); }
  #screen .track { flex:1; height:6px; border-radius:3px; background:#182230; overflow:hidden; }
  #screen .fill { height:100%; width:0; background:var(--accent); transition:width .3s; }
  #screen.busy .stage { color:var(--warn); } #screen.alert .stage { color:var(--err); } #screen.ok .stage { color:var(--accent); }
  /* 屏上常驻一行「当前会话名」：不参与 screen.frame 渲染，绑定后一直可见 */
  #screen .sess { margin-top:auto; font-size:11px; color:var(--accent); border-top:1px solid var(--line);
    padding-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #screen .sess.none { color:var(--dim); }
  /* 屏下的会话选择器：没有会话时展开、绑定后收起（按钮可再展开） */
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
  <b>鹈鹕 · 模拟设备</b><span>协议 v0</span>
  <span id="conn">连接中…</span>
</header>

<div id="screen">
  <div class="stage" id="stage">连接</div>
  <div class="title" id="title">正在连接宿主…</div>
  <ul id="bullets"></ul>
  <div class="sess none" id="sessLine">会话：未选定</div>
  <div class="bar"><span id="progress">—</span><div class="track"><div class="fill" id="fill"></div></div></div>
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
    <button id="speak" title="P1 会用本地 VITS 替换">重读一遍</button>
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
  var $ = function (id) { return document.getElementById(id); };
  var state = { ws: null, seq: 0, clientId: '', sessionId: '', sessionTitle: '', sessionSource: '',
    sessions: [], listLoaded: false, querying: false, showList: false,
    sessionBound: false, computerUse: null, sessionPreset: '', cuTotal: 0, total: 0,
    mode: 'auto', lastAutoId: '',
    lastTranscript: '', asking: null, recorder: null, chunks: [], retryTimer: 0 };

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
  function renderScreen(payload) {
    $('stage').textContent = payload.stage || '';
    $('title').textContent = payload.title || '';
    var list = $('bullets');
    list.innerHTML = '';
    (payload.bullets || []).forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    });
    var screen = $('screen');
    screen.className = payload.tone || 'idle';
    var progress = payload.progress;
    if (progress && typeof progress.done === 'number') {
      $('progress').textContent = progress.total ? (progress.done + '/' + progress.total) : String(progress.done);
      $('fill').style.width = progress.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) + '%' : '0%';
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
      $('sessLine').className = 'sess' + (state.computerUse === false ? ' none' : '');
    } else if (state.sessionId) {
      $('sessNow').textContent = '正在确认会话 ' + shortId(state.sessionId) + '…';
      $('sessNow').className = 'sess-now';
      $('sessLine').textContent = '当前会话：确认中' + modeText;
      $('sessLine').className = 'sess none';
    } else {
      $('sessNow').textContent = state.mode === 'auto'
        ? '正在自动绑定最近活跃的 Computer Use 会话…'
        : '还没有选定会话，点下面选一个';
      $('sessNow').className = 'sess-now none';
      $('sessLine').textContent = '当前会话：未选定' + modeText;
      $('sessLine').className = 'sess none';
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

  /* ---------- TTS ----------
     P0 临时方案：浏览器自带 speechSynthesis（zh-CN）。
     P1 要换成**宿主机上的本地 VITS（sherpa-onnx）**：宿主合成 24kHz Opus，
     经 tts.audio 帧下发，板子/页面只负责播放——因为远程链路上手机的
     speechSynthesis 音色依赖系统、离线不可用，而且真板子没有这个 API。 */
  function tihuSpeak(text) {
    if (!text) return;
    if (!('speechSynthesis' in window)) { addEvent('alert', '本浏览器不支持 speechSynthesis，跳过朗读'); return; }
    try {
      var utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'zh-CN';
      utter.rate = 1.02;
      var zh = window.speechSynthesis.getVoices().filter(function (v) { return /zh|Chinese/i.test(v.lang + v.name); });
      if (zh.length) utter.voice = zh[0];
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    } catch (e) { addEvent('alert', '朗读失败：' + e.message); }
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
      clearInterval(state.retryTimer);
      state.retryTimer = setInterval(function () { send('ping', { nonce: String(Date.now()) }); }, 25000);
    };
    ws.onclose = function (event) {
      $('conn').textContent = '已断开' + (event && event.code ? '（' + event.code + '）' : '');
      $('conn').className = 'off';
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
      case 'screen.frame': renderScreen(payload); break;
      case 'transcript':
        state.lastTranscript = payload.text || '';
        $('transcript').textContent = state.lastTranscript;
        $('transcript').className = '';
        addEvent('progress', '转写：' + state.lastTranscript);
        break;
      case 'tts.text': tihuSpeak(payload.text || ''); break;
      case 'event.progress':
        addEvent('progress', (payload.stage ? '[' + payload.stage + '] ' : '') + (payload.text || ''));
        if (typeof payload.done === 'number') { $('progress').textContent = payload.total ? payload.done + '/' + payload.total : String(payload.done); }
        break;
      case 'event.alert': addEvent('alert', (payload.level === 'error' ? '错误：' : '') + (payload.text || '')); break;
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
  /* 解码 → 单声道 → 线性插值重采样到 16k → WAV */
  function decodeAndResample(arrayBuffer) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('浏览器不支持 AudioContext'));
    var context = new Ctx();
    return context.decodeAudioData(arrayBuffer).then(function (audio) {
      var source = audio.numberOfChannels > 1 ? mergeChannels(audio) : audio.getChannelData(0);
      var target = 16000;
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
      return { wav: encodeWav(samples, target), durationMs: Math.round(length / target * 1000) };
    });
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
      addEvent('progress', label + '：' + result.durationMs + ' ms，已上行');
      send('audio.frame', {
        format: 'wav', sampleRate: 16000, channels: 1, bits: 16,
        audioBase64: toBase64(result.wav), durationMs: result.durationMs
      });
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
  $('speak').onclick = function () { if (state.lastTranscript) tihuSpeak(state.lastTranscript); };

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
