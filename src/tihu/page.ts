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
import { condition as conditionVoicePcm, trimSilence as trimVoiceSilence } from '../client/pocket/orb/voice.ts'
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
  #screen.alert { border-color:var(--err); }
  #screen.alert .title, #screen.alert .stage { color:var(--err); }
  /* 首页最上方那一行（用户 2026-11-08 确认）：原来的「项目 N 个 · 第 x/y 页」整段删掉，
     换成「本地时钟 HH:MM」+「三格信号柱」。这一行占掉 stage 原来那一行的位置（12px/行高 14），
     总高度不变，底部翻页条不会被顶出 224px 内容高。状态屏 / 回答屏的 stage 行照旧。
     信号柱是纯 CSS 内联元素（三根 <span>，高度递增、底对齐），没有 emoji、没有图片、没有外部字体图标；
     断开只靠颜色（红）区分，不写「断开」两个字。 */
  #screen .home-top { display:none; flex:none; align-items:flex-end; gap:8px; height:14px; box-sizing:border-box; }
  #screen.home-mode .home-top { display:flex; }
  #screen.home-mode .stage { display:none; }
  /* 顶行时钟数字加粗（用户 2026-11-08 本轮要求，只加粗这一处）：字号 12px、行高 14px、颜色、位置、
     三格信号柱、底部翻页条、回答屏与状态屏的 stage 行全部照旧。粗体只把字形撑宽约 6%（12px/700 比常规宽），
     HH:MM 五个字符加粗后实测约 40px，离可用宽还差得远（304 − 行间隙 8 − 信号柱 19 = 277；rail-on 时 240 − 27 = 213），
     所以这一行不会换行、不会溢出、也不会被 fitTextPx 裁成省略号，顶行那套尺寸常量（柱宽 5、柱间隙 2、行间隙 8）不用动。
     这条规则只作用在 .clock 上（屏内 .clock 只有 #homeClock 这一个元素）：首页项目名 .home-row1、摘要行 .home-row2、
     最近回答行 .home-recent 都不在这条规则上，不会被带着一起变粗。 */
  #screen .home-top .clock { font-size:12px; line-height:14px; letter-spacing:1px; color:var(--accent); font-weight:bold;
    font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; flex:none; }
  /* 三格信号柱：3 根 ×5px + 2 个间隙 ×2px = 19px（页面 JS 里 HOME_TOP_* 常量要和这两个数字一致）。 */
  #screen .home-top .signal { flex:none; margin-left:auto; display:flex; align-items:flex-end; gap:2px; height:13px; }
  #screen .home-top .signal .bar { display:block; width:5px; border-radius:1px; background:#6b7785; }
  #screen .home-top .signal .bar.b1 { height:5px; }
  #screen .home-top .signal .bar.b2 { height:9px; }
  #screen .home-top .signal .bar.b3 { height:13px; }
  #screen .home-top .signal.conn-online .bar { background:#35d07f; }            /* 已连上宿主：绿 */
  #screen .home-top .signal.conn-connecting .bar { background:#6b7785; opacity:.55; } /* 连接中 / 重连中：灰、柱条稍淡 */
  #screen .home-top .signal.conn-offline .bar { background:var(--err); }        /* 断开：红（只有颜色） */
  #screen .title { font-size:18px; font-weight:700; line-height:22px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen ul { margin:0; padding:0; list-style:none; font-size:16px; line-height:20px; color:#c3ccd5; }
  #screen ul li { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* 回答屏正文（2026-11-08 第二轮：气泡不压文字、末行不裁）：
     垂直预算 224 = 顶行 14 + 间隙 4×2 + 正文 170 + 按钮行 32（与 screen-spec 的 REPLY_LAYOUT 同一组数字）。
     正文固定 7 行 × 20px = 140，末行下面留 30px（其中 20px 是一整行安全高度）：
     右侧气泡轨（64px，正文在 rail-on 时让到 240px）、进度条（reply-mode 收掉）、顶行都进不了这块；
     宿主只下发 7 行，页面最多也只画 7 行，绝不把第 8 行裁成半行。 */
  #screen .reply-body { display:none; flex:1; min-height:0; overflow:hidden; font-size:16px; line-height:20px; color:#d9e2ea; }
  #screen .reply-line { white-space:nowrap; overflow:hidden; }
  #screen .reply-line.cur { background:var(--accent); color:#04110f; border-radius:3px; }
  #screen .home-body { display:none; flex:1; overflow:hidden; }
  #screen.home-mode .home-body { display:block; }
  #screen.home-mode .title, #screen.home-mode ul, #screen.home-mode .reply-body, #screen.home-mode .bar,
  #screen.home-mode .action-bar, #screen.home-mode .run-list { display:none; }
  /* 首页底部翻页条（用户 2026-11-08 要求）：只在 home-mode 显示，按钮 min-height 28px，flex 布局。
     这一行占掉底部 28px + 4px 间隙，所以项目行必须收进 30px：224 内容高 = 顶行 14（时钟 + 信号柱）+ 间隙 4
     + 最近回答 20 + 5×30 + 间隙 4 + 翻页条 28 = 220（不留半行）。顶行的高度与原来那行 stage 一模一样，
     换行走不会把翻页条顶出屏幕。 */
  #screen .home-pager { display:none; flex:none; align-items:center; gap:6px; }
  #screen.home-mode .home-pager { display:flex; }
  #screen .home-pager button { flex:none; width:64px; min-height:28px; padding:0; border-radius:6px;
    border:1px solid #33414f; background:#1b2430; color:#d9e2ea; font-size:16px; line-height:26px; }
  #screen .home-pager button.off { opacity:.45; }
  #screen .home-pager button:active { background:#2c3d4e; }
  #screen .home-pager .page { flex:1; min-width:0; text-align:center; font-size:13px; line-height:16px;
    color:#9fb0c0; white-space:nowrap; overflow:hidden; }
  /* 回复屏底部动作条（停止 / 重读 / 主页） */
  #screen .action-bar { display:none; flex:none; gap:6px; padding-top:4px; }
  #screen.reply-mode .action-bar, #screen.has-actions .action-bar { display:flex; }
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
  #screen .home-item { height:30px; box-sizing:border-box; padding:0; overflow:hidden; }
  #screen .home-row1 { display:flex; align-items:center; gap:6px; font-size:16px; font-weight:700; line-height:18px; white-space:nowrap; }
  #screen .home-dot { width:8px; height:8px; border-radius:50%; flex:none; background:#6b7785; }
  #screen .home-row1 .name { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .home-row2 { font-size:12px; line-height:12px; color:#8b97a5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .home-dot.running { background:#35d07f; }
  #screen .home-dot.idle { background:#6b7785; }
  #screen .home-dot.done { background:#4f8ef7; }
  /* 首页顶部「最近回答 · 会话名」行：单行省略，点它回到那条回答的朗读屏 */
  #screen .home-recent { display:block; height:20px; box-sizing:border-box; margin:0 0 2px; padding:0 4px;
    border:1px solid #2a5a54; border-radius:4px; background:rgba(20,44,40,.55);
    font-size:13px; line-height:16px; color:#9fd8cf; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* ── 任务棋盘（屏 1，2026-11-09 统一指挥会话）──
     与首页同一副骨架（顶行 14 + 5 行 + 底部翻页 28），只是行的语义从「项目」变成「任务」：
     一行 34px（比项目行高 4px，要塞下「胶囊 + 任务名」和「项目 · 第 N 步」两行字）。
     内容高 224 = 顶行 14 + 间隙 4 + 5×34 + 间隙 4 + 翻页 28 = 220，仍不留半行。 */
  #screen.board-mode .home-top { display:flex; }
  #screen.board-mode .stage, #screen.board-mode .title, #screen.board-mode ul,
  #screen.board-mode .reply-body, #screen.board-mode .bar, #screen.board-mode .action-bar,
  #screen.board-mode .run-list { display:none; }
  #screen.board-mode .home-body { display:block; }
  #screen.board-mode .home-pager { display:flex; }
  #screen .board-item { height:34px; box-sizing:border-box; padding:1px 0; overflow:hidden; }
  #screen .board-row1 { display:flex; align-items:center; gap:6px; font-size:15px; font-weight:700; line-height:18px; white-space:nowrap; overflow:hidden; }
  /* 状态胶囊：文字优先（色盲/强光下也读得出），颜色只做辅助 */
  #screen .board-capsule { flex:none; font-size:11px; line-height:14px; font-weight:700; letter-spacing:.5px;
    padding:1px 5px; border-radius:4px; background:#1b2430; color:#9fb0c0; border:1px solid #2b3a4a; }
  #screen .board-capsule.running { color:#8ef0c4; border-color:#2a6b56; background:#10241e; }
  #screen .board-capsule.dispatched { color:#9fd8ff; border-color:#2b5a7a; background:#0f1c26; }
  #screen .board-capsule.awaiting { color:#f7d98a; border-color:#7a5c1f; background:#241d0f; }
  #screen .board-capsule.done { color:#a9c8ff; border-color:#2b4a7a; background:#101a2b; }
  #screen .board-capsule.announced { color:#93a9c4; border-color:#33465c; background:#111820; }
  #screen .board-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  #screen .board-merged { flex:none; font-size:11px; color:#7c8b99; }
  #screen .board-row2 { display:flex; align-items:center; gap:6px; font-size:12px; line-height:14px; color:#8b97a5; }
  #screen .board-sub { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  /* 时长环（满圈＝30 分钟）：进行中按已用时长画弧，跑久了转琥珀，完成满环，排队空环。
     环只做辅助，精确时长在详情屏用文字给。 */
  #screen .board-ring { position:relative; flex:none; width:14px; height:14px; border-radius:50%;
    background:conic-gradient(var(--ring, #3fb6a8) calc(var(--p, 0) * 1turn), #26323e 0); }
  #screen .board-ring i { position:absolute; left:3px; top:3px; width:8px; height:8px; border-radius:50%; background:#05080b; display:block; }
  #screen .board-ring.warn { --ring: var(--warn); }
  #screen .board-ring.done { --ring: #4f8ef7; }
  #screen .board-ring.empty { background:#26323e; }
  /* 微条：最近 8 步耗时（只给节奏感，不显示数字） */
  #screen .board-micro { display:flex; flex:none; align-items:flex-end; gap:2px; height:10px; margin-left:auto; margin-right:5px; }
  #screen .board-micro span { width:2px; min-height:2px; background:#3fb6a8; border-radius:1px; opacity:.85; }
  /* 待决策行右侧是琥珀问号徽标（不显示时长：这条在等人，不是「跑得久」） */
  #screen .board-ask { flex:none; width:14px; height:14px; border-radius:50%; background:var(--warn);
    color:#241d0f; font-size:11px; line-height:14px; font-weight:700; text-align:center; }
  /* 空态：没有任务时是同一张棋盘的另一种脸（不是另开一屏） */
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
  /* 派单回执的三拍圆点（已入队 / 排队 N 个 / 开始跑）：只在 steps 帧出现 */
  #screen .steps { display:none; flex:none; gap:6px; margin-top:4px; }
  #screen.steps-on .steps { display:flex; }
  #screen .step { flex:1; min-width:0; font-size:11px; line-height:14px; text-align:center; color:#6b7785; white-space:nowrap; overflow:hidden; }
  #screen .step::before { content:''; display:block; width:7px; height:7px; border-radius:50%; margin:0 auto 2px; background:#26323e; }
  #screen .step.done { color:var(--accent); }
  #screen .step.done::before { background:var(--accent); }
  #screen .step.active { color:#e6edf3; font-weight:700; }
  #screen .step.active::before { background:#e6edf3; }
  /* 倒计时条（派单回执 5 秒回棋盘 / 待决策 60 秒按默认项）：文字给秒数，条只给感觉 */
  #screen .cd-row { display:none; flex:none; align-items:center; gap:6px; font-size:11px; line-height:14px; color:#9fb0c0; }
  #screen.cd-on .cd-row { display:flex; }
  #screen .cd-track { flex:1; height:4px; border-radius:2px; background:#182230; overflow:hidden; }
  #screen .cd-fill { height:100%; width:100%; background:var(--accent); transition:width .95s linear; }
  /* 「在听 · 已唤醒」（屏 3）：唤醒词命中后盖在屏上，说完停 3 秒自动发送 */
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
  #screen .pending-rail { position:absolute; right:0; top:8px; bottom:8px; width:64px; padding:4px; box-sizing:border-box;
    display:none; flex-direction:column; gap:4px; z-index:3; }
  #screen.rail-on .pending-rail { display:flex; }
  #screen.rail-on .title, #screen.rail-on ul, #screen.rail-on .reply-body, #screen.rail-on .home-body,
  #screen.rail-on .home-pager, #screen.rail-on .home-top { width:240px; }
  #screen .pending-chip { width:56px; height:34px; box-sizing:border-box; padding:2px 3px; border-radius:5px;
    background:rgba(20,28,40,.82); border:1px solid rgba(120,180,255,.55); overflow:hidden; }
  #screen .pending-name { font-size:11px; line-height:15px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .pending-sub { font-size:10px; line-height:13px; color:#9fb0bf; display:flex; align-items:center; gap:3px; }
  #screen .pending-dot { width:5px; height:5px; border-radius:50%; background:#35d07f; }
  #screen .pending-more { font-size:10px; color:#9fb0bf; text-align:center; }
  /* 右下角那行「已绑定：xxx」本轮搬进回答屏顶行末尾（用户 2026-11-08 确认）：这块地方整个空出来，
     右下角不再写任何文字、也不显示任何东西（上一轮 ecf48fa 删掉的滚动余量角落提示「还有 N 行」
     继续保持删除，不恢复）。回答屏底部那排按钮（停止/重读/主页/上一条/下一条）位置与样式都不动。 */
  #screen .scroll-hint { display:none; position:absolute; right:8px; bottom:6px; font-size:11px; line-height:14px;
    color:#9fb0bf; background:rgba(5,8,11,.82); padding:1px 4px; border-radius:3px; pointer-events:none; }
  /* 主页屏也从来不显示角落提示：那块地方是翻页按钮的（› 在右下角），不能被压住 */
  #screen.home-mode .scroll-hint { display:none; }
  #screen.reply-mode .title, #screen.reply-mode ul, #screen.reply-mode .bar { display:none; }
  #screen.reply-mode .reply-body { display:block; }
  #screen .bar { margin-top:auto; display:flex; align-items:center; gap:6px; font-size:10px; color:var(--dim); }
  #screen .track { flex:1; height:5px; border-radius:3px; background:#182230; overflow:hidden; }
  #screen .fill { height:100%; width:0; background:var(--accent); transition:width .3s; }
  #screen.busy .stage { color:var(--warn); } #screen.alert .stage { color:var(--err); } #screen.ok .stage { color:var(--accent); }
  .screen-tools { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .screen-tools button { padding:6px 10px; font-size:12px; }
  .screen-tools button.on { border-color:var(--accent); background:#132420; }
  .screen-tools button.unsupported { opacity:.45; }
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
        <div id="homeTop" class="home-top"><span class="clock" id="homeClock">--:--</span><span class="signal conn-connecting" id="homeSignal"><span class="bar b1"></span><span class="bar b2"></span><span class="bar b3"></span></span></div>
        <div class="title" id="title">正在连接宿主…</div>
        <ul id="bullets"></ul>
        <div id="runList" class="run-list"></div>
        <div id="replyBody" class="reply-body"></div>
        <div id="actionBar" class="action-bar"></div>
        <div id="homeBody" class="home-body"></div>
        <div id="homePager" class="home-pager"></div>
        <div id="steps" class="steps"></div>
        <div id="cdRow" class="cd-row"><span id="cdText"></span><div class="cd-track"><div class="cd-fill" id="cdFill"></div></div></div>
        <div id="listen" class="listen">
          <div class="l0">在听 · 已唤醒</div>
          <div class="l1">我在，说吧</div>
          <div class="wave"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
          <div class="heard" id="listenHeard"></div>
          <div class="l2">说完停 3 秒再发送</div>
          <div class="l3">想清楚再说不着急</div>
          <div class="l3">10 秒没说话就退出 · 长按也能说</div>
        </div>
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
    <button id="wake" title="免按住：叫「你好，鹈鹕」就能说话（浏览器关键词聆听；真机走固件本地唤醒）">免按住</button>
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
  <h4>音色 · 主引擎 edge-tts（离线兜底：本地 Kokoro）</h4>
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
    <input id="offlineOnly" type="checkbox" style="width:auto" /> 仅离线（跳过 edge 云健，改用本地 Kokoro 兜底）
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
  var TARGET_RATE = 16000;
  var condition = ${conditionVoicePcm.toString()};
  var trimSilence = ${trimVoiceSilence.toString()};
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
    mode: 'unified', bindIntent: '', lastAutoId: '',
    lastTranscript: '', asking: null, recorder: null, chunks: [], retryTimer: 0, audioPending: false, audioTimer: 0,
    connState: 'connecting', clockTimer: 0,
    ttsTurnTexts: [], ttsAudioSeen: {},
    audioCtx: null, pcmSources: [], pcmNextTime: 0, turnPcm: [], droppedAudio: false,
    samplePending: false, sampleTimer: 0,
    voice: 'default', voices: [], voiceEngine: null,
    reply: null, replyCharPos: 0, replyTimer: 0, highlightLock: false, audioStarted: false, hostAlert: false, screenMode: 'status', pending: [], boundProject: '', homeProjects: [], screenScale: 2, actions: [], running: [],
    /* 任务棋盘（屏 1）与派单回执 / 待决策的附加块（2026-11-09 统一指挥会话） */
    board: null, steps: [], countdown: null, countdownTimer: 0,
    /* 免按住（唤醒词聆听）：browser 关键词 → 屏 3「在听」→ 停 3 秒发送；10 秒没说话退出 */
    wake: false, wakeRec: null, wakeRestart: 0, listenOn: false, listenText: '', listenTimer: 0, listenIdle: 0 };

  /* ---------- 会话定位 ----------
     2026-11-09 统一指挥：开机只认两种意图 ——
       1. URL ?session=<id> 显式指定 → 手动绑定（老逃生口，一次有效）；
       2. 其它一切（含本地记住过的旧会话）→ 统一指挥：发**裸 hello**，
          宿主把它绑到唯一的「鹈鹕指挥台」，屏上直接是任务棋盘。
     本地键 dsh.tihu.session 仍随手动/自动绑定更新（handleSessionInvalid 靠它判断
     失效的是不是「我们自己记的那条」），但**不再参与开机**：否则一次手动绑定就会被
     它按 origin 绑死，默认入口永远回不到棋盘（2026-11-09 实测的旧会话屏就是这样来的）。
   */
  var SESSION_KEY = 'dsh.tihu.session';

  function urlSessionId() {
    try { return new URLSearchParams(location.search).get('session') || ''; } catch (e) { return ''; }
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
  function pickInitialSession() {
    // 记住的会话不参与开机：默认（无 ?session=）一律统一指挥。
    var fromUrl = urlSessionId();
    if (fromUrl) return { id: fromUrl, source: 'url', mode: 'manual' };
    return { id: '', source: '', mode: 'unified' };
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

  /**
   * 绑定信息：本轮从右下角搬到回答屏顶行末尾（用户 2026-11-08 确认）。文字内容取的还是本来那一套
   * 状态——state.sessionBound 决定出不出，内容用 state.boundProject（项目名优先）→ state.sessionTitle →
   * 「未命名会话」兜底，跟旧的角落提示一模一样，没有换成语义不同的东西；未绑定就整段不出（不写「未绑定」占位）。
   * 只用在回答屏（reply 分支，见 replyStageText / bindTailOf）：首页顶行仍是上一轮的加粗时钟 + 三格信号柱，
   * 状态屏顶行也不加绑定信息；右下角那个角落提示什么都不显示（CSS display:none + 不写任何文字）。
   */
  function bindLabelOf() {
    return state.sessionBound
      ? ('已绑定：' + (state.boundProject || state.sessionTitle || '未命名会话'))
      : '';
  }
  function updateScrollHint() {
    // 角落提示不再显示任何东西（CSS .scroll-hint 也已 display:none）；绑定文字改由回答屏顶行排
    $('scrollHint').textContent = '';
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
  /* stage 行可用宽：气泡轨占掉屏右侧 64px，stage 那行也得让开（rail-on 时 240，否则 304）。 */
  function stageWidthPx() {
    var width = (SCREEN.widthPx || 320) - 2 * (SCREEN.paddingPx || 8);
    return state.pending && state.pending.length > 0 ? Math.min(width, width - 64) : width;
  }
  /** 估算一行文本的渲染宽度（与 fitTextPx 同一套字宽估算）。 */
  function textWidthPx(text, fontPx) {
    var chars = Array.from(String(text || ''));
    var used = 0;
    for (var i = 0; i < chars.length; i += 1) {
      var code = chars[i].codePointAt(0) || 0;
      var wide = (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff);
      used += (wide ? 1 : 0.47) * fontPx;
    }
    return used;
  }
  /** stage 行 = 文案 + 尾巴：超宽就裁文案、保住尾巴（方案 B 要求位置一定看得见）。 */
  function stageWithTail(body, tail, fontPx) {
    if (tail === '') return fitTextPx(body, stageWidthPx(), fontPx);
    var room = Math.max(1, stageWidthPx() - textWidthPx(tail, fontPx));
    var shown = body === '' ? '' : fitTextPx(body, room, fontPx);
    return shown === '' ? tail : shown + tail;
  }
  /**
   * stage 那一行的 letter-spacing（CSS「#screen .stage { … letter-spacing:1px 」同一个数字）：
   * 尾巴越接越长（本轮又接了「· 已绑定：…」），只按字宽量会撑过 304/240，所以量这一行要带上它。
   * （首页顶行那套常量——柱宽 5、柱间隙 2、行间隙 8——本轮没有变，还是和 CSS 一模一样。）
   */
  var STAGE_LETTER_SPACING_W = 1;
  /** 按 stage 行算宽：字宽估算 + 每格 1px 的 letter-spacing。 */
  function stageTextWidthPx(text, fontPx) {
    return textWidthPx(text, fontPx) + Array.from(String(text || '')).length * STAGE_LETTER_SPACING_W;
  }
  /** stage 行专用的截断：和 fitTextPx 同规则（超宽才省略），但每格带上 letter-spacing，算出来的行宽就是渲染行宽。 */
  function stageFitPx(text, width, fontPx) {
    var chars = Array.from(String(text || ''));
    var out = '';
    var used = 0;
    for (var i = 0; i < chars.length; i += 1) {
      var code = chars[i].codePointAt(0) || 0;
      var wide = (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff);
      var w = (wide ? 1 : 0.47) * fontPx + STAGE_LETTER_SPACING_W;
      if (used + w > width) return out === '' ? '…' : out + '…';
      out += chars[i];
      used += w;
    }
    return out;
  }
  /**
   * stage 行 = 文案 + 必保尾巴（窗口位置数字）+ 可选尾巴（已绑定信息）。溢出时的优先顺序
   * （用户 2026-11-08 确认）：先裁文案，「1/5」数字和「已绑定：…」两个尾巴都保住；两个尾巴
   * 自己就撑满一整行时，才用省略号裁绑定文字（位置数字永不被动）。
   * 这一行 CSS 是 white-space:nowrap + overflow:hidden，绝不换行；宽度全由这里定量算掉
   * （letter-spacing 也计入，整行渲染宽保证不超过 304 / rail-on 240）。
   */
  function stageWithTails(body, keepTail, optionalTail, fontPx) {
    var available = stageWidthPx();
    var optional = optionalTail || '';
    if (optional === '') return stageWithTail(body, keepTail, fontPx);   /* 未绑定：上一轮方案 B 原样 */
    var keepW = stageTextWidthPx(keepTail, fontPx);
    var optW = stageTextWidthPx(optional, fontPx);
    if (keepW + optW <= available) {
      // 两个尾巴都保：只裁文案
      var room = Math.max(1, available - keepW - optW);
      var shown = body === '' ? '' : stageFitPx(body, room, fontPx);
      return shown === '' ? keepTail + optional : shown + keepTail + optional;
    }
    // 尾巴自己就超宽：先裁文案保住位置数字，剩下的宽度才给绑定文字上省略号
    var base = body === '' ? '' : stageFitPx(body, Math.max(1, available - keepW), fontPx);
    base = base === '' ? keepTail : base + keepTail;
    var room = Math.max(0, available - stageTextWidthPx(base, fontPx));
    if (room < stageTextWidthPx('…', fontPx)) return base;
    return base + stageFitPx(optional, room, fontPx);
  }
  /**
   * 首页顶行的尺寸常量：必须和 CSS「#screen .home-top .signal」那三条规则一模一样
   * （柱宽 5px × 3、柱间隙 2px × 2、时间与图标间隙 8px）。
   * 可用宽度取 stageWidthPx()：有气泡轨时 240，没有时 304，两种都要排得下。
   */
  var SIGNAL_BAR_W = 5;
  var SIGNAL_GAP_W = 2;
  var SIGNAL_W = SIGNAL_BAR_W * 3 + SIGNAL_GAP_W * 2;   /* 19 */
  var HOME_TOP_GAP_W = 8;

  /** 本地时钟：只显示到分钟、24 小时制、零补齐 → 19:32。不取宿主帧推送（靠宿主推会 stale）。 */
  function clockText() {
    var now = new Date();
    var hh = now.getHours();
    var mm = now.getMinutes();
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  /**
   * 连接状态：接页面已有那一份（#conn 那条 + ws 开/关），不新增协议字段。
   * online = 已连上宿主（绿）；connecting = 连上前 / 2 秒后重连时正在拨号（灰、柱条稍淡）；
   * offline = 刚刚关掉连接、还没开始下一次重连（红）。断开只有颜色，没有文字。
   */
  function setConnState(next) {
    state.connState = next;
    renderHomeTop();
  }
  function connClassOf() {
    if (state.connState === 'online') return 'conn-online';
    if (state.connState === 'offline') return 'conn-offline';
    return 'conn-connecting';
  }
  /** 首页顶行：时钟 + 信号柱，整行宽度和 stage 同一套可用宽（rail-on 240 / 否则 304）。
   *  棋盘模式（屏 1）这一行改成右对齐的三段计数「●2 在跑 ●1 等你 ●1 排队」（设计 §8.3）。 */
  function renderHomeTop() {
    var signal = $('homeSignal');
    if (signal) signal.className = 'signal ' + connClassOf();
    var clock = $('homeClock');
    if (!clock) return;
    // 棋盘模式这一行是三段计数，其余模式是本地时钟——两者走同一条 fitTextPx 排版。
    var text = state.screenMode === 'board' ? boardCountsText(state.board && state.board.counts) : clockText();
    var room = Math.max(1, stageWidthPx() - SIGNAL_W - HOME_TOP_GAP_W);
    clock.textContent = fitTextPx(text, room, SCREEN.stageFontPx || 12);
  }
  /**
   * 朗读屏 stage 行（方案 B + 本轮绑定信息）：文案不动，末尾追加「· 窗口起始行/总行」，
   * 再接「· 已绑定：<项目名>」。左边的数字取宿主 scroll.offset（绝对窗口起始行，宿主按
   * scrollOffset 切好可视窗口），右边的数字取宿主新加的 scroll.total（整段回复折完的总行）。
   * 绑定文字是页面侧已有的那份状态（bindLabelOf），宿主 lane 不为它新增协议字段或消息类型。
   * 首页顶行（加粗时钟 + 三格信号柱）与状态屏顶行都不加绑定信息。
   */
  function bindTailOf() {
    var label = bindLabelOf();
    return label === '' ? '' : ' · ' + label;
  }
  function replyStageText(payload) {
    var reply = payload.reply || {};
    var scroll = reply.scroll || {};
    var offset = Number(scroll.offset);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    var delivered = Array.isArray(reply.lines) ? reply.lines.length : 0;
    var total = Number(scroll.total);
    if (!Number.isFinite(total) || total < offset + delivered) total = offset + delivered;
    // 完成播报不显示「第 x/y 段」位置；改由 stage 右端带「另有 N 条」。
    var position = reply.noPosition === true ? '' : ' · ' + (offset + 1) + '/' + total;
    var more = payload.more && payload.more.text ? ' · ' + payload.more.text : '';
    return stageWithTails(String(payload.stage || '回答中'), position + more, bindTailOf(), SCREEN.stageFontPx || 12);
  }
  /** 主页底部翻页条：‹ 上一页 / 第 x/y 页 / › 下一页；越界的一侧置灰（点它宿主也不动页码）。 */
  function renderHomePager(payload) {
    var pager = $('homePager');
    var home = payload.home || {};
    var page = home.page || { index: 0, total: 1 };
    var total = Number(page.total);
    if (!Number.isFinite(total) || total < 1) total = 1;
    var index = Number(page.index);
    if (!Number.isFinite(index) || index < 0) index = 0;
    if (index > total - 1) index = total - 1;
    pager.innerHTML = '';
    var prev = document.createElement('button');
    prev.textContent = '‹';
    prev.className = index > 0 ? '' : 'off';
    prev.setAttribute('data-action', 'homePrev');
    var label = document.createElement('span');
    label.className = 'page';
    label.textContent = '第 ' + (index + 1) + '/' + total + ' 页';
    var next = document.createElement('button');
    next.textContent = '›';
    next.className = index < total - 1 ? '' : 'off';
    next.setAttribute('data-action', 'homeNext');
    pager.appendChild(prev);
    pager.appendChild(label);
    pager.appendChild(next);
  }
  /* ---------- 任务棋盘（屏 1）：一行一任务 ----------
   * 版式照设计：顶行三段计数（●N 在跑 ●N 等你 ●N 排队）→ 5 行任务 → 底部翻页。
   * 每行只说三件事：状态胶囊（文字）、任务名、副行「项目 · 第 N 步」＋右侧时长环。
   * 待决策行右侧是琥珀问号（不显示时长）；同一项目连续多条折叠成「+N 条」。
   * 没有任务时是**同一张棋盘的另一种脸**（空态），不另开一屏。
   */
  function boardCountsText(counts) {
    var c = counts || {};
    // 三段计数**始终都在**（空盘也要看到三个 0）：设计 §8「顶行三段计数归零」，
    // 不能因为某一档是 0 就把它省掉——省掉以后空盘顶行只剩「● 0 在跑」，和文档不一致。
    // 宽度由 fitTextPx 兜底缩放，320px 放得下「●0 在跑　●0 等你　●0 排队」。
    return '●' + (Number(c.running) || 0) + ' 在跑　●' + (Number(c.awaiting) || 0) + ' 等你　●' + (Number(c.queued) || 0) + ' 排队';
  }
  function applyScreenClass(base) {
    var screen = $('screen');
    if (!screen) return;
    // 免按住聆听「在听 · 已唤醒」是盖在屏上的一层；任何宿主屏帧重画 className 时
    // 必须保留它，否则后台任务一推帧，唤醒屏就在 10 秒前被擦掉（2026-11-09 实测）。
    screen.className = base + (state.listenOn ? ' listen-on' : '');
  }
  function renderBoard(payload) {
    var screen = $('screen');
    var board = payload.board || {};
    state.board = board;
    state.screenMode = 'board';
    state.hostAlert = false;
    state.reply = null;
    state.highlightLock = false;
    state.actions = [];
    state.running = [];
    renderActions();
    renderRunning();
    $('stage').style.display = 'none';
    $('stage').textContent = '';
    $('replyBody').innerHTML = '';
    var clock = $('homeClock');
    if (clock) clock.textContent = fitTextPx(boardCountsText(board.counts), Math.max(1, stageWidthPx() - SIGNAL_W - HOME_TOP_GAP_W), SCREEN.stageFontPx || 12);
    renderHomePager({ home: { page: board.page || { index: 0, total: 1 } } });
    renderSteps([]);
    renderCountdown(null);
    var body = $('homeBody');
    body.innerHTML = '';
    var rows = Array.isArray(board.rows) ? board.rows : [];
    if (rows.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'board-empty';
      var wave = document.createElement('div');
      wave.className = 'wave';
      for (var wi = 0; wi < 5; wi += 1) wave.appendChild(document.createElement('span'));
      var l1 = document.createElement('div');
      l1.className = 'l1';
      l1.textContent = '还没有任务';
      var l2 = document.createElement('div');
      l2.className = 'l2';
      l2.textContent = fitTextPx('叫「你好，鹈鹕」说一句，或者点屏', 288, 12);
      var l3 = document.createElement('div');
      l3.className = 'l3';
      l3.textContent = '说完这里就变成任务棋盘';
      empty.appendChild(wave);
      empty.appendChild(l1);
      empty.appendChild(l2);
      empty.appendChild(l3);
      body.appendChild(empty);
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
      if (Number(row.merged) > 0) {
        var merged = document.createElement('span');
        merged.className = 'board-merged';
        merged.textContent = '+' + row.merged + ' 条';
        row1.appendChild(merged);
      }
      var row2 = document.createElement('div');
      row2.className = 'board-row2';
      var sub = document.createElement('span');
      sub.className = 'board-sub';
      sub.textContent = row.sub || '';
      row2.appendChild(sub);
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
        row2.appendChild(micro);
      }
      if (row.badge === 'ask') {
        var ask = document.createElement('span');
        ask.className = 'board-ask';
        ask.textContent = '?';
        row2.appendChild(ask);
      } else {
        var ring = document.createElement('span');
        var tone = (row.ring && row.ring.tone) || 'normal';
        ring.className = 'board-ring' + (tone === 'normal' ? '' : ' ' + tone);
        ring.style.setProperty('--p', String(Math.max(0, Math.min(1, Number(row.ring && row.ring.percent) || 0))));
        ring.appendChild(document.createElement('i'));
        row2.appendChild(ring);
      }
      item.appendChild(row1);
      item.appendChild(row2);
      body.appendChild(item);
    }
    applyScreenClass('board-mode' + (state.pending && state.pending.length ? ' rail-on' : ''));
    updateScrollHint();
  }

  /* 派单回执的三拍圆点：已入队 / 排队 N 个 / 开始跑（圆点由 CSS 画，文字给状态） */
  function renderSteps(steps) {
    var screen = $('screen');
    var box = $('steps');
    state.steps = Array.isArray(steps) ? steps : [];
    box.innerHTML = '';
    if (!state.steps.length) { screen.classList.remove('steps-on'); return; }
    for (var i = 0; i < state.steps.length; i += 1) {
      var step = document.createElement('span');
      step.className = 'step ' + (state.steps[i].state || 'pending');
      step.textContent = state.steps[i].label || '';
      box.appendChild(step);
    }
    screen.classList.add('steps-on');
  }

  /* 倒计时条：文字给秒数（精确），条只给感觉；到 0 就停在 0，由宿主决定下一步 */
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
      $('cdText').textContent = cd.text !== '' ? cd.text : (cd.left > 0 ? cd.left + ' 秒' : '到点');
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
    renderPending(payload || {});
    updateScrollHint();
    // 收到任何一帧都顺手重画顶行（时钟本来每秒 tick，这里再补一次保证同一帧里不会花掉）。
    renderHomeTop();
    // 回执/待决策的附加块每帧先收掉，只有本帧带了才重画（否则上一帧的圆点/倒计时会留在屏上）。
    renderSteps(payload && payload.steps);
    renderCountdown(payload && payload.countdown);
    // 任务棋盘（屏 1，含空态）：mode 也是 home，但走 board 分支（行是任务不是项目）。
    if (payload && payload.board) {
      renderBoard(payload);
      return;
    }
    if (payload && payload.mode === 'home' && payload.home) {
      state.screenMode = 'home';
      state.hostAlert = false;
      state.reply = null;
      state.highlightLock = false;
      // 首页最上方那一行现在由页面自己负责：本地时钟 HH:MM + 三格信号柱。
      // 宿主 home 帧的 stage 已经空着（不再写「项目 N 个 · 第 x/y 页」），那一行在 home-mode 收掉；
      // 「项目 N 个」总数整段删除、不挪到屏内别的地方；状态屏 / 回答屏的 stage 行保持原样。
      $('stage').style.display = 'none';
      $('stage').textContent = '';
      renderHomeTop();
      renderHomePager(payload);
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
      applyScreenClass('home-mode' + (state.pending && state.pending.length ? ' rail-on' : ''));
      updateScrollHint();
      return;
    }
    if (payload && payload.mode === 'reply' && payload.reply) {
      state.screenMode = 'reply';
      state.hostAlert = payload.tone === 'alert';
      var lockedIndex = state.highlightLock && state.reply ? state.reply.currentIndex : null;
      state.reply = payload.reply;
      if (lockedIndex !== null && payload.reply.sentences.some(function (s) { return s.index === lockedIndex; })) {
        state.reply.currentIndex = lockedIndex;
      }
      if (typeof payload.reply.charPos === 'number') state.replyCharPos = payload.reply.charPos;
      // 朗读屏 stage 行末尾追加窗口位置（方案 B）：底部不加指示条，那个挡过主页按钮的角落提示仍保持删掉。
      $('stage').style.display = '';
      $('stage').textContent = replyStageText(payload);
      applyScreenClass((payload.tone || 'ok') + ' reply-mode' + (state.pending && state.pending.length ? ' rail-on' : ''));
      renderReply();
      state.running = [];
      renderRunning();
      state.actions = payload.actions || [];
      renderActions();
      applyAudioRecovery();
      return;
    }
    state.screenMode = 'status';
    state.reply = null;
    state.hostAlert = payload.tone === 'alert';
    // 严格按 320×240 规格排版：stage ≤10、标题 ≤28 且单行、正文最多 3 行 ×18 字。
    // 多出来的内容留在事件区，屏幕上不允许出现半行或滚动条。
    var stageText = clipScreen(payload.stage || '', SCREEN.stageChars);
    // 屏 6「另有 N 条」收进状态行右端（图 3：完成 + 另有 2 条）。
    var moreText = payload.more && payload.more.text ? String(payload.more.text).trim() : '';
    if (moreText !== '') stageText = stageText === '' ? moreText : stageText + ' · ' + moreText;
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
    state.actions = Array.isArray(payload.actions) ? payload.actions : [];
    applyScreenClass((payload.tone || 'idle') + (state.pending && state.pending.length ? ' rail-on' : '') + (state.actions.length ? ' has-actions' : ''));
    renderActions();
    state.running = payload.running || [];
    renderRunning();
    var progress = payload.progress;
    if (progress && typeof progress.done === 'number') {
      $('progress').textContent = progress.total ? (progress.done + '/' + progress.total) : String(progress.done);
      $('fill').style.width = progress.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) + '%' : '0%';
    }
    applyAudioRecovery();
  }

  /* reply 模式渲染：句子窗口 → 按 304/240 像素折行 → 可视 7 行（末行下留一整行安全高度），当前句反色。 */
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
    var highlight = state.audioStarted || reply.highlightCurrent === true;
    var currentLine = 0;
    for (var j = 0; j < lines.length; j += 1) { if (lines[j].index === current) { currentLine = j; break; } }
    // 宿主已经按 scrollOffset 切好可视窗口，页面直接渲染，不再自行居中。
    var start = 0;
    body.innerHTML = '';
    for (var k = start; k < Math.min(start + visible, lines.length); k += 1) {
      var div = document.createElement('div');
      div.className = 'reply-line' + (highlight && lines[k].index === current ? ' cur' : '');
      div.textContent = lines[k].text;
      body.appendChild(div);
    }
    // 角落不再显示还剩几行的提示，它挡住了主页按钮（可视窗口由宿主 scrollOffset 决定）
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
    var modeText = state.mode === 'auto' ? '（自动）' : state.mode === 'unified' ? '（统一指挥）' : '（手动）';
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
        : state.mode === 'unified'
          ? '正在建立统一指挥（任务棋盘）…'
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
    // 显式点选 = 离开统一指挥（老逃生口）：之后的绑定都按手动会话算。
    state.bindIntent = 'manual';
    state.mode = 'manual';
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
      // 统一指挥：绑的是「鹈鹕指挥台」（standard），它不是 CU，也永远不算失效；
      // 这里一个分支都不能走，否则一次列表刷新就把屏打回旧会话 / 自动跟随。
      if (state.mode !== 'unified') {
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
    }

    if (state.sessionId && state.sessionBound) {
      var title = checkedTitle(state.sessionId);
      if (title) state.sessionTitle = title;
    }
    renderSessionBar();
    renderSessionList();
    if (!state.sessionBound && state.listLoaded && state.mode !== 'unified') {
      $('sessHint').textContent = state.cuTotal === 0
        ? '没有可自动绑定的 CU 会话：先在桌面端新建一个 Computer Use 模式会话，再点「刷新会话列表」。'
        : '列表只显示 Computer Use 模式会话；自动模式会跟随最近活跃的一条，手动选一次就以手动为准。';
    }
  }
  function handleSessionBound(payload) {
    if (!payload || !payload.sessionId) return;
    var auto = payload.auto === true;
    // 统一指挥：这次绑定是页面主动发裸 hello 换来的（宿主绑的是唯一指挥会话）。
    // 它既不是「自动跟随」，也不是用户挑的那条会话 —— 重连时必须继续发裸 hello，
    // 一旦把它当手动会话回传 sessionId，宿主就退回老路径（device.unified=false）。
    var unified = !auto && state.bindIntent === 'unified';
    state.bindIntent = '';
    var previousAuto = auto ? state.lastAutoId : '';
    state.mode = auto ? 'auto' : unified ? 'unified' : 'manual';
    state.sessionId = payload.sessionId;
    state.sessionTitle = payload.title || state.sessionTitle || '';
    state.boundProject = payload.project || '';
    state.sessionBound = true;
    state.showList = false;
    var cu = payload.computerUse === true;
    if (unified) {
      // 指挥会话是 standard 模式，本来就不看屏/不点鼠标：不按「非 CU」告警，也不记 id
      //（记了下次开机就会被它按 origin 绑死，默认入口又回不到棋盘）。
      setComputerUseNotice(null, payload.preset);
    } else {
      setComputerUseNotice(cu, payload.preset);
      // 自动绑定只更新展示，不删除上次手动记忆；显式「恢复自动」才由对应按钮清除。
      if (!auto && cu) rememberSessionId(payload.sessionId);
    }
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
    if (unified) {
      $('sessHint').textContent = '统一指挥已就绪：说一句话就派单，屏上是任务棋盘；要看某条会话用下面的「换个会话」。';
      addEvent('done', '统一指挥已就绪：' + sessionLabel());
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
    if (state.mode === 'unified') {
      // 统一指挥下面没有「退回自动跟随」这条路：指挥会话丢了就再发一次裸 hello，
      // 宿主会重建/复用「鹈鹕指挥台」，屏还是任务棋盘。
      state.bindIntent = 'unified';
      state.showList = false;
      addEvent('alert', payload.reason || '指挥会话不见了，正在重新建立');
      if (state.ws && state.ws.readyState === 1) sendHello('', false);
      renderSessionBar();
      return;
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
      if (task && typeof task.then === 'function') task.then(function () {
        if (audioRunning(ctx)) { hideAudioWarn(); applyAudioRecovery(); }
      }).catch(function () { /* 解锁失败：等下一次手势 */ });
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
  /** 禁音/丢块是屏内恢复状态，不是屏外横幅；后续正常屏帧也不能把它抹掉。 */
  function applyAudioRecovery() {
    if (!state.droppedAudio || state.hostAlert) return;
    var message = audioRunning(state.audioCtx) ? '声音已启用 · 点重读' : '点屏启用声音 · 解锁后点重读';
    if (state.screenMode === 'reply' && state.reply) {
      $('stage').style.display = '';
      $('stage').textContent = replyStageText({ stage: message, reply: state.reply });
      $('screen').className = 'alert reply-mode' + (state.pending && state.pending.length ? ' rail-on' : '');
    } else if (state.screenMode === 'status') {
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
    if (!ctx) { markAudioDropped(); return null; }
    // 未解锁：先 resume，等不到 running 就**丢弃这段**并提示点一下页面——
    // 绝不排队（suspended 时 currentTime 冻结，排进去的时间轴一旦恢复会全部炸响）。
    if (!audioRunning(ctx)) {
      resumeAudio();
      if (!audioRunning(ctx)) {
        state.pcmNextTime = 0;
        markAudioDropped();
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
    } catch (e) { markAudioDropped(); /* 解码失败：屏内保留重读恢复 */ }
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
    state.droppedAudio = false;
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
      var voice = state.voices[i];
      var option = document.createElement('option');
      option.value = voice.name;
      // 默认项是 edge 云健；Kokoro 音色（zf_/zm_）选中即手动切到本地兜底，名字必须可区分，
      // 否则 100 个默认项全写「默认音色」就选不出来（切过去的音色设置也不能丢）。
      if (voice.name === 'default') {
        option.textContent = voice.note ? String(voice.note) : '默认音色';
      } else if (voice.kind === 'default') {
        option.textContent = voice.name + (voice.note ? '（' + String(voice.note).replace('本地 Kokoro · ', '') + '）' : '');
      } else {
        option.textContent = voice.name + (voice.durationMs ? '（' + Math.round(voice.durationMs / 1000) + 's）' : '');
      }
      if (voice.name === state.voice) option.selected = true;
      select.appendChild(option);
    }
    var engine = state.voiceEngine;
    if (engine && engine.available === false) {
      $('voiceHint').textContent = '无语音：' + (engine.error || '在线兜底不可用且本地引擎未就绪') + '（本条只显示文字）。';
    } else {
      var model = (engine && engine.model) || '本地引擎';
      if (model.indexOf('edge-tts') >= 0 && model.indexOf('Kokoro') < 0) {
        $('voiceHint').textContent = '主引擎：edge-tts 云健(Yunjian) / 音色默认；选 zf_/zm_ 音色即手动切到本地 Kokoro（离线兜底）。仅可用于你本人或已获授权的音色。';
      } else {
        $('voiceHint').textContent = '本地 Kokoro：' + model + ' / 音色 ' + state.voice + '。仅可用于你本人或已获授权的音色；参考音频只在本机处理。';
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
    // 正在拨号 = 连接中（信号柱灰）；这一份状态同时喂首页那三格信号柱，不新增协议字段。
    setConnState('connecting');
    ws.onopen = function () {
      $('conn').textContent = '已连接';
      $('conn').className = 'on';
      setConnState('online');
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
      // 三种握手，只由「这次带什么」决定：
      //   unified（默认）—— 裸 hello：宿主绑唯一的指挥会话，屏上是任务棋盘；
      //   manual —— ?session= 显式指定（老逃生口）；
      //   auto —— 点过「恢复自动」或手动会话失效（老逃生口）。
      // 统一模式**重连也只发裸 hello**：把上次绑到的指挥会话 id 回传，宿主会当成
      // 手动绑定（device.unified=false），屏又退回那条会话的旧屏。
      var helloSession = '';
      if (state.mode === 'manual') {
        if (state.sessionBound) helloSession = state.sessionId;
        else if (state.sessionSource === 'url') helloSession = state.sessionId;
      }
      state.bindIntent = state.mode === 'unified' ? 'unified' : 'manual';
      sendHello(helloSession, state.mode === 'auto');
      if (!helloSession && state.mode === 'manual' && !state.sessionId) {
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
      // 断开：屏内只靠信号柱变红区分，不再往那一行前面塞「离线 · 」文字（那一行现在是时钟）。
      setConnState('offline');
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
        if (payload.index === 0) {
          state.droppedAudio = false;
          hideAudioWarn();
        }
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
      /* 任务登记簿（2026-11-09 统一指挥）：棋盘数据既随 screen.frame.board 下发，
         也单独发一条 task.list（固件只认这条也没问题）；播报帧只在事件区记一行。 */
      case 'task.list':
        if (payload && payload.board) renderBoard(payload);
        break;
      case 'task.update':
        // 单行变更：棋盘在屏上时按最新一拍重画由 screen.frame 负责，这里只记一行事件。
        if (payload && payload.taskId) addEvent('progress', '任务 ' + payload.taskId + ' → ' + (payload.capsule || payload.state || ''));
        break;
      case 'task.notify':
        if (payload && payload.text) addEvent(payload.level === 0 ? 'alert' : 'progress', (payload.spoken ? '播报：' : '通知：') + payload.text);
        break;
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
      var conditioned = trimSilence(condition(samples));
      try { context.close(); } catch (e) { /* 忽略 */ }
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
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, autoGainControl: true, noiseSuppression: false } }).then(function (stream) {
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
    state.droppedAudio = false;
    hideAudioWarn();
    $('transcript').textContent = text;
    $('transcript').className = '';
    $('text').value = '';
  };
  $('retry').onclick = function () {
    // 有预览/待发草稿时走宿主重说：真正取消草稿与在途 ASR，而不是只擦页面文字。
    if (state.lastTranscript) {
      send('screen.gesture', { action: 'tap', x: 1, y: 1, hit: 'action', actionId: 'retry' });
    }
    state.lastTranscript = '';
    $('transcript').textContent = '（还没有内容）';
    $('transcript').className = 'empty';
    addEvent('progress', '已取消上一条转写，请重新说');
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

  /* ---------- 免按住 ＋ 唤醒词「你好，鹈鹕」（屏 3「在听 · 已唤醒」） ----------
   * 真机是固件本地关键词判定（不上传音频）；模拟页只能用浏览器 SpeechRecognition 做
   * 关键词聆听，所以它是个**显式开关**（默认关，点一下才开），不偷偷占麦克风。
   * 命中关键词 → 屏上盖一层「在听」→ 继续说 → 末字后静音 3 秒自动发送；10 秒没说话退出。
   * 播报中叫醒：先把本地音频队列掐掉（页面侧 AEC 的软件兜底），再进聆听——念一半也能插话。
   */
  var WAKE_RE = /你好[，,、\\s]*鹈鹕/;
  function listenPreview(text) {
    var heard = $('listenHeard');
    if (!heard) return;
    heard.textContent = text === '' ? '' : fitTextPx(text, 288, 12);
  }
  function listenBegin() {
    state.listenOn = true;
    state.listenText = '';
    state.listenSkip = true;
    $('screen').classList.add('listen-on');
    listenPreview('');
    clearTimeout(state.listenIdle);
    // 10 秒一句都没说：退出聆听（不会一直开着麦）
    state.listenIdle = setTimeout(function () {
      if (!state.listenOn) return;
      if (String(state.listenText || '').trim() !== '') return;
      addEvent('progress', '免按住：10 秒没说话，已退出聆听');
      listenEnd();
    }, 10000);
  }
  function listenEnd() {
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
  }
  /** 末字后静音 3 秒 = 「说完了」：留出想措辞的时间，不打断人。
   *  一句话都还没说时**不**起这个计时——那种情况归「10 秒没说话就退出」管。 */
  function listenTouch() {
    clearTimeout(state.listenTimer);
    var text = String(state.listenText || '').trim();
    if (text === '') return;
    clearTimeout(state.listenIdle);
    state.listenIdle = 0;
    state.listenTimer = setTimeout(function () {
      var said = String(state.listenText || '').trim();
      listenEnd();
      if (said === '') return;   // 只叫了唤醒词没说话：不算一次唤醒
      stopPcm();
      send('text.input', { text: said, source: 'voice' });
      addEvent('progress', '免按住：' + said);
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
      var tail = probe.slice(hit.index + hit[0].length).replace(/^[，,、。.\\s]+/, '');
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
        // 关键词那一句的 final 迟到：去掉关键词前缀再累加，避免把「你好鹈鹕」念进指令
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
      try { rec.onend = null; rec.stop(); } catch (e) { /* 忽略 */ }
    }
    var btn = $('wake');
    if (btn) btn.classList.remove('on');
    listenEnd();
    if (!silent) addEvent('progress', '免按住：已关闭');
  }
  function wakeStart() {
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      addEvent('alert', '这个浏览器不支持免按住聆听（真机走固件本地唤醒）；长按说话仍可用');
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
        addEvent('alert', '麦克风权限被拒绝：免按住用不了，长按说话仍可用');
      }
    };
    rec.onend = function () {
      if (!state.wake) return;
      clearTimeout(state.wakeRestart);
      state.wakeRestart = setTimeout(function () { try { rec.start(); } catch (e) { /* 忽略 */ } }, 400);
    };
    try { rec.start(); } catch (e) { return false; }
    state.wakeRec = rec;
    state.wake = true;
    $('wake').classList.add('on');
    addEvent('progress', '免按住：叫「你好，鹈鹕」就能说话');
    return true;
  }
  $('wake').onclick = function () {
    if (state.wake) wakeStop(false);
    else wakeStart();
  };
  try { if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) $('wake').classList.add('unsupported'); } catch (e) { /* 忽略 */ }


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
            if (actionId === 'stop' || actionId === 'home' || actionId === 'prev' || actionId === 'next' ||
                actionId === 'homePrev' || actionId === 'homeNext') stopPcm();
            if (actionId === 'replay' && audioRunning(state.audioCtx)) {
              state.droppedAudio = false;
              hideAudioWarn();
            }
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
        // 任务棋盘上点一行：看这条任务的详情（宿主 openTask，不换会话绑定）
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
  /* 首页顶行走表：每秒 tick 一次时钟（时间由页面自己的本地时钟渲染，不等宿主推——
     宿主那 30 秒一次的控制室巡检（TIHU_HOME_SYNC_MS）只刷新项目清单，帧隔 30 秒推一次时钟就会 stale）。
     收到 screen.frame 时 renderScreen 也顺手重画一次，保证同一帧里时钟不会花。 */
  renderHomeTop();
  state.clockTimer = setInterval(renderHomeTop, 1000);
  connect();
})();
</script>
</body>
</html>`
}
