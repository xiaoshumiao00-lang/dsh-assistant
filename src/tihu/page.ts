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
import { ACTUAL_SIZE_SCALE, DONE_LAYOUT, DONE_TITLE_FONT_PX, DONE_TITLE_LINE_HEIGHT_PX, SCREEN_SPEC } from './screen-spec.ts'
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
  /* 完成播报的朗读波形：新完成页在顶栏里自己画（见 done-view） */
  #screen.alert .title, #screen.alert .stage { color:var(--err); }
  /* 首页最上方那一行（用户 2026-11-08 确认）：原来的「项目 N 个 · 第 x/y 页」整段删掉，
     换成「本地时钟 HH:MM」+「三格信号柱」。这一行占掉 stage 原来那一行的位置（12px/行高 14），
     总高度不变（底部翻页条已在 2026-11-09 删除）。状态屏的 stage 行照旧。
     信号柱是纯 CSS 内联元素（三根 <span>，高度递增、底对齐），没有 emoji、没有图片、没有外部字体图标；
     断开只靠颜色（红）区分，不写「断开」两个字。 */
  #screen .home-top { display:none; flex:none; align-items:flex-end; gap:8px; height:14px; box-sizing:border-box; }
  #screen.home-mode .home-top { display:flex; }
  #screen.home-mode .stage { display:none; }
  /* 顶行时钟数字加粗（用户 2026-11-08 本轮要求，只加粗这一处）：字号 12px、行高 14px、颜色、位置、
     三格信号柱与状态屏的 stage 行全部照旧（底部翻页条已删）。粗体只把字形撑宽约 6%（12px/700 比常规宽），
     HH:MM 五个字符加粗后实测约 40px，离可用宽还差得远（304 − 行间隙 8 − 信号柱 19 = 277），
     所以这一行不会换行、不会溢出、也不会被 fitTextPx 裁成省略号，顶行那套尺寸常量（柱宽 5、柱间隙 2、行间隙 8）不用动。
   * 这条规则只作用在 .clock 上（屏内 .clock 只有 #homeClock 这一个元素）。 */

  #screen .home-top .clock { font-size:12px; line-height:14px; letter-spacing:1px; color:var(--accent); font-weight:bold;
    font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; flex:none; }
  /* 三格信号柱：3 根 ×5px + 2 个间隙 ×2px = 19px（页面 JS 里 HOME_TOP_* 常量要和这两个数字一致）。 */
  #screen .home-top .signal { flex:none; margin-left:auto; display:flex; align-items:flex-end; gap:2px; height:13px; }
  #screen .home-top .home-counts { margin-left:auto; font-size:11px; line-height:14px; color:var(--dim); white-space:nowrap; }
  #screen.board-mode .home-top .signal { display:none; }
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
  /* 状态屏正文：标题一行、正文最多 4 行；进度条与顶行都进不了正文区。 */
  #screen .home-body { display:none; flex:1; overflow:hidden; }
  #screen.home-mode .home-body { display:block; }
  #screen.home-mode .title, #screen.home-mode ul,
  #screen.home-mode .action-bar { display:none; }
  /* 旧式翻页条已整体删除（用户 2026-11-09：设备屏不要翻页控件）。
     棋盘固定最多 4 条（BOARD_PAGE_SIZE）：顶行 14 + 间隙 4 + 4×48 = 210 ≤ 222，四行都完整。 */
  /* 状态屏/回执/完成屏的底部动作条 */
  #screen .action-bar { display:none; flex:none; gap:6px; padding-top:4px; }
  #screen.has-actions .action-bar { display:flex; }
  #screen .action-bar button { flex:1; min-width:0; min-height:28px; padding:0 2px; white-space:nowrap;
    border-radius:6px; border:1px solid #33414f; background:#1b2430; color:#d9e2ea; font-size:13px; }
  /* 按钮多于 3 个时收小一号字号：304px 内不换行不溢出 */
  #screen .action-bar.many button { font-size:11px; }
  #screen .action-bar button:active { background:#2c3d4e; }

  #screen .tap-flash { position:absolute; width:28px; height:28px; margin:-14px 0 0 -14px; border-radius:50%;
    background:rgba(255,255,255,.35); pointer-events:none; z-index:5; animation:tapFlash .18s ease-out forwards; }
  @keyframes tapFlash { from { opacity:.8; transform:scale(.4); } to { opacity:0; transform:scale(1.4); } }

  /* ── 任务棋盘（屏 1，2026-11-09 统一指挥会话）──
     顶行 14 + 间隙 4 + 每页最多 4 行任务 + 底部翻页条 12（2026-11-10 用户明确要回来）：
     内容高 222 = 顶行 14 + 间隙 4 + 4×48（每行 20px 标题 + 16px 副行 + 上下 6px）+ 翻页条 12。
     翻页条只有一页时 JS 直接不建，什么都不显示。 */
  #screen.board-mode .home-top { display:flex; }
  #screen.board-mode .stage, #screen.board-mode .title, #screen.board-mode ul,
  #screen.board-mode .action-bar { display:none; }
  /* 棋盘：列表区吃掉翻页条上方的全部高度，翻页条**钉在屏底**（用户 2026-11-10 实机：
     第 2 页只有 2 条时，翻页栏跟着列表往上跑，位置和第 1 页不一样）。
     高度预算 222 = 顶行 14 + 间隙 2 + 列表区（4×48 = 192）+ 翻页条 12 + 底边距 2。 */
  #screen.board-mode { gap:2px; }
  #screen.board-mode .home-body { display:flex; flex-direction:column; min-height:0; }
  #screen .board-list { flex:1 1 auto; min-height:0; overflow:hidden; }
  #screen .board-item { height:48px; box-sizing:border-box; padding:6px 0; overflow:hidden; }
  #screen .board-row1 { display:flex; align-items:center; gap:6px; font-size:15px; font-weight:700; line-height:20px; white-space:nowrap; overflow:hidden; }
  /* 状态胶囊：文字优先（色盲/强光下也读得出），颜色只做辅助 */
  #screen .board-capsule { flex:none; font-size:11px; line-height:14px; font-weight:700; letter-spacing:.5px;
    padding:1px 5px; border-radius:4px; background:#1b2430; color:#9fb0c0; border:1px solid #2b3a4a; }
  #screen .board-capsule.running { color:#8ef0c4; border-color:#2a6b56; background:#10241e; }
  #screen .board-capsule.dispatched { color:#9fd8ff; border-color:#2b5a7a; background:#0f1c26; }
  #screen .board-capsule.awaiting { color:#f7d98a; border-color:#7a5c1f; background:#241d0f; }
  #screen .board-capsule.done { color:#a9c8ff; border-color:#2b4a7a; background:#101a2b; }
  #screen .board-capsule.announced { color:#93a9c4; border-color:#33465c; background:#111820; }
  /* 屏 7 歧义候选卡：项目名 + 来源（图 3） */
  #screen .ask-card { display:flex; align-items:center; gap:7px; margin:4px 0; padding:5px 7px; border:1px solid #2b3a4a; border-radius:7px; background:#111a24; }
  #screen .ask-no { flex:none; width:15px; height:15px; border:1px solid #3fb6a8; border-radius:50%; color:#8ef0c4; font-size:10px; line-height:15px; text-align:center; }
  #screen .ask-main { min-width:0; display:flex; flex-direction:column; }
  #screen .ask-name { font-size:13px; font-weight:700; line-height:15px; color:#e6edf3; }
  #screen .ask-source { font-size:10px; line-height:12px; color:#9fb0c0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #screen .board-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  #screen .board-merged { flex:none; font-size:11px; color:#7c8b99; }
  #screen .board-row2 { display:flex; align-items:center; gap:6px; font-size:12px; line-height:16px; color:#8b97a5; }
  #screen .board-sub { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  /* 右侧状态图形（用户 2026-11-10 定案，不再用 10px 实心点）：右对齐、离屏幕外沿正好 10px
     （#screen 内边距 8 + 边框 1 → 内容右界 311；图形外边距 1 → 右界 310 → 距外沿 10px）。
     完成＝绿色实心圆（直径 12px）；待决策＝黄色圆形里一个问号；
     进行中＝蓝色未闭合圆环，弧长按「已运行时长 ÷ 30 分钟」画，跑满后停在满圈差一点的那圈；
     排队／派单＝灰色细环。都不做大圆环（14×14 以内，不抢行高）。 */
  #screen .board-status { flex:none; width:14px; height:14px; box-sizing:border-box; margin-left:6px; margin-right:1px; }
  #screen .board-status.done, #screen .board-status.announced { width:12px; height:12px; border-radius:50%; background:#35d07f; }
  #screen .board-status.queued { width:12px; height:12px; border-radius:50%; background:none; border:1px solid #6f7d89; }
  #screen .board-status.dispatched { width:12px; height:12px; border-radius:50%; background:none; border:1px solid #6fb3e5; }
  #screen .board-status.announced { background:#2fbf6b; }
  #screen .board-status.awaiting { width:14px; height:14px; border-radius:50%; background:var(--warn);
    color:#1b1305; font-size:11px; font-weight:700; line-height:14px; text-align:center; }
  #screen .board-status.running svg { display:block; width:14px; height:14px; }
  /* 翻页条：上一页 / 第 N/M 页 / 下一页（只有一页时 JS 不建这条）。
     钉在屏底：flex:none + margin-bottom:2px → 条底边离屏幕外沿 8+1+2 = 11px（用户要求 10–12px），
     不管这一页剩 4 条还是 1 条，它都在同一个位置。 */
  #screen .board-pager { display:flex; flex:none; align-items:center; justify-content:center; gap:8px;
    height:12px; margin-bottom:2px; }
  #screen .board-pager button { border:0; background:none; padding:0; color:#9fb0c0; font-size:11px; line-height:12px; }
  #screen .board-pager button.cur { color:#5FD2C8; font-weight:700; }
  #screen .board-pager button.off { color:#48525d; }
  #screen .board-pager .page { font-size:11px; line-height:12px; color:#c8d4dd; }
  /* 微条：最近 8 步耗时（只给节奏感，不显示数字） */
  #screen .board-micro { display:flex; flex:none; align-items:flex-end; gap:2px; height:10px; margin-left:2px; }
  #screen .board-micro span { width:2px; min-height:2px; background:#3fb6a8; border-radius:1px; opacity:.85; }
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
  /* ── 完成页（参考图）：顶栏 14 + 标题 22 + 正文区（剩余高度）+ 三键 30 ──
     顶栏：左「完成」（青、不加粗）／中波形（7 根竖条）／右「另有 N 条」（灰）／最右 ▶（青）。
     正文：15px/20px，当前朗读行整行铺青底、黑字加粗，左右各留 8px，行首不留任何图标。
     大标题 2026-11-10 用户要求减 2 号（22px → 20px，行高 24 → 22）。
     2026-11-10 第二版用户实机要求：标题/正文**贴顶**，三键**固定贴在屏幕底部**
     （键底边离屏幕外沿 12px）；正文区吃掉标题与按钮之间的全部剩余高度，
     空出来的地方留在**正文与按钮之间**，不再堆在按钮下面。行多时正文区按剩余高度
     裁剪/滚动（7 行 140 ≤ 145 全放得下），正文与按钮永不重叠。
     高度预算：14 + 2 + 22 + 2 + 145 正文区 + 4 列间隙 + 30 三键 + 3 margin = 222
     （内容高 240−2×8−2×1）。「12px 底边」= 3px margin + 8px 内边距 + 1px 边框。 */
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
  /* 正文块吃掉标题与三键之间的剩余高度（flex:1）：一行时下面留白仍在正文区里，
     所以视觉上是「正文贴顶、空白在正文与按钮之间」，按钮永远贴在屏幕底部。 */
  #screen .done-body { flex:1 1 auto; min-height:0; overflow:hidden; display:flex; flex-direction:column; justify-content:flex-start; }
  #screen .done-line { flex:none; height:20px; line-height:20px; box-sizing:border-box; padding:0 8px; font-size:15px; color:#e8edf2;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #screen .done-line.cur { background:#5FD2C8; color:#04110f; font-weight:700; border-radius:4px; }
  /* 三键：深灰等宽圆角、键间距 8px、高 30px、浅青字。
     margin-top:auto 把它顶到屏幕底部；margin-bottom:3px 让键底边离屏幕外沿正好 12px
     （3 + 8 内边距 + 1 边框）。 */
  #screen.done-mode .action-bar { display:flex; flex:none; height:30px; padding:0 4px; gap:8px;
    margin-top:auto; margin-bottom:3px; }
  #screen.done-mode .action-bar button { height:30px; min-height:30px; border:0; border-radius:8px;
    background:#3A3D42; color:#9fe8df; font-size:14px; }
  #screen.done-mode .action-bar button:active { background:#4a4e54; }
  /* 进度页（屏 4，停止/主页）：动作条同样贴底（键底边离屏幕外沿 12px）；
     正文（最多 3 行）贴顶，剩余空间留在正文与按钮之间，超出按剩余高度裁剪。 */
  #screen.detail-mode .action-bar { margin-top:auto; margin-bottom:3px; }
  #screen.detail-mode ul { flex:1 1 auto; min-height:0; overflow:hidden; }
  /* 派单回执的三拍圆点（已入队 / 排队 N 个 / 开始跑）：只在 steps 帧出现 */
  #screen .steps { display:none; flex:none; gap:5px; margin:5px 0 6px; }
  #screen.steps-on .steps { display:flex; }
  #screen .step-arrow { flex:none; color:#5f7183; font-size:10px; line-height:14px; align-self:flex-start; margin-top:0; }
  #screen .step { flex:1; min-width:0; font-size:11px; line-height:14px; text-align:center; color:#6b7785; white-space:nowrap; overflow:hidden; }
  #screen .step::before { content:''; display:block; width:7px; height:7px; border-radius:50%; margin:0 auto 2px; background:#26323e; }
  #screen .step.done { color:var(--accent); }
  #screen .step.done::before { background:var(--accent); }
  #screen .step.active { color:#e6edf3; font-weight:700; }
  #screen .step.active::before { background:#e6edf3; }
  /* 倒计时条（派单回执 5 秒回棋盘 / 待决策 60 秒按默认项）：文字给秒数，条只给感觉 */
  #screen .cd-row { display:none; flex:none; align-items:center; gap:6px; font-size:11px; line-height:14px; color:#9fb0c0; }
  #screen.cd-on .cd-row { display:flex; }
  #screen .cd-row #cdText { flex:none; min-width:28px; color:#9fb0c0; font-size:10px; }
  #screen .cd-track { flex:1; height:8px; border-radius:3px; background:#182230; overflow:hidden; }
  #screen .cd-fill { height:100%; width:100%; background-image:linear-gradient(90deg,var(--accent) 0 82%,transparent 82% 100%); background-size:20% 100%; background-repeat:repeat-x; transition:width .95s linear; animation:tihu-cd-flow .9s linear infinite; }
  @keyframes tihu-cd-flow { from { background-position:0 0; } to { background-position:20px 0; } }
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
  /* 右下角那行「已绑定：xxx」本轮搬进回答屏顶行末尾（用户 2026-11-08 确认）：这块地方整个空出来，
     右下角不再写任何文字、也不显示任何东西（上一轮 ecf48fa 删掉的滚动余量角落提示「还有 N 行」
     继续保持删除，不恢复）。回答屏底部那排按钮（停止/重读/主页/上一条/下一条）位置与样式都不动。 */
  /* 主页屏也从来不显示角落提示：那块地方是翻页按钮的（› 在右下角），不能被压住 */
  /* 旧版底部进度条/贯穿横线已整体删除（用户 2026-11-10：notice/派单类屏底部不许留装饰线）。
     曾经「> .bar 隐藏」被后面的「#screen .bar 显示」同权重覆盖，
     320×240 状态屏底部就多出一条 5px 的整屏长横线——现在连元素一起删掉。 */
  #screen.busy .stage { color:var(--warn); } #screen.alert .stage { color:var(--err); } #screen.ok .stage { color:var(--accent); }
  .screen-tools { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .screen-tools button { padding:6px 10px; font-size:12px; }
  .screen-tools button.on { border-color:var(--accent); background:#132420; }
  .screen-tools button.unsupported { opacity:.45; }
  .screen-tools .hint { margin-left:auto; }
  select, #voiceName, #voiceNote { font:inherit; color:var(--fg); background:#0d131b; border:1px solid var(--line); border-radius:9px; padding:8px 10px; width:100%; }
  /* 音频解锁横幅：浏览器自动播放策略会把手动创建的 AudioContext 置为 suspended，
     此时 PCM 全部「到达但不出声」。点一次页面即可解锁（resume）。 */
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
  <b>鹈鹕 · 模拟设备</b><span>协议 v0</span>
  <span id="conn">连接中…</span>
</header>

<div class="audio-warn" id="audioWarn">🔇 点一下屏幕启用声音（浏览器要求先有一次点击，否则朗读只有数据没有声音）</div>

<div class="device-wrap" id="deviceWrap">
  <div class="device-title">ESP32-S3-BOX-3B · 2.4″ · 320×240 · 触摸屏</div>
  <div class="device" id="device">
    <div class="bezel">
      <div class="mics"><span></span><span></span></div>
      <div id="screen">
        <div class="stage" id="stage">连接</div>
        <div id="homeTop" class="home-top"><span class="clock" id="homeClock">--:--</span><span class="home-counts" id="boardCounts"></span><span class="signal conn-connecting" id="homeSignal"><span class="bar b1"></span><span class="bar b2"></span><span class="bar b3"></span></span></div>
        <div class="title" id="title">正在连接宿主…</div>
        <div id="steps" class="steps"></div>
        <ul id="bullets"></ul>
        <div id="doneView" class="done-view">
          <div class="done-bar">
            <span class="done-stage" id="doneStage">完成</span>
            <span class="done-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span>
            <span class="done-more" id="doneMore"></span>
            <span class="done-play" aria-hidden="true">▶</span>
          </div>
          <div class="done-title" id="doneTitle"></div>
          <div class="done-body" id="doneBody"></div>
        </div>
        <div id="actionBar" class="action-bar"></div>
        <div id="homeBody" class="home-body"></div>
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
  </div>
  <textarea id="text" placeholder="文字兜底：直接输入要交给会话的话"></textarea>
  <div class="row" style="margin-top:8px"><button id="send" style="flex:1">发送到当前会话</button></div>
  <div class="row" style="margin-top:8px"><button id="end" style="flex:1;border-color:#b04545">结束本次语音会话</button></div>
  <div class="hint">「结束」会立刻解除危险动作闸门（不用等 120 秒空闲），之后你自己在会话里的操作完全不受影响。</div>
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
  var DONE = ${JSON.stringify(DONE_LAYOUT)};
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
  var state = { ws: null, seq: 0, clientId: '', sessionId: '', 
    
    lastTranscript: '', recorder: null, chunks: [], retryTimer: 0, audioPending: false, audioTimer: 0,
    connState: 'connecting', clockTimer: 0,
    
    audioCtx: null, pcmSources: [], pcmNextTime: 0, pcmLast: null, droppedAudio: false, readRound: null,
    /* 朗读自检：收到多少块 / 最后一块是否已排程 / 被丢掉的块数（页面事件区与 __tihuAudioCheck 可查） */
    ttsChunks: 0, ttsFinalSeen: false, ttsDropped: 0,
    samplePending: false, sampleTimer: 0,
    voice: 'default', voices: [], voiceEngine: null,
    highlightLock: false, hostAlert: false, screenMode: 'status', screenScale: 2, actions: [], 
    /* 任务棋盘（屏 1）与派单回执 / 待决策的附加块（2026-11-09 统一指挥会话） */
    board: null, steps: [], countdown: null, countdownTimer: 0,
    /* 完成页：done = { lines, current }；高亮只由每段 PCM 的真实开始/结束事件推进
       （见 segmentStarted/segmentEnded），没有任何按时间翻行的兜底计时器。 */
    done: null, doneRanges: null,
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
  function renderActions() {
    var bar = $('actionBar');
    bar.innerHTML = '';
    var actions = state.actions || [];
    // 按钮多（>3 个）时收小字号，304px 内挤得下、不换行。
    bar.className = actions.length > 3 ? 'action-bar many' : 'action-bar';
    for (var i = 0; i < actions.length; i += 1) {
      var button = document.createElement('button');
      button.textContent = actions[i].label;
      button.setAttribute('data-action', actions[i].id);
      bar.appendChild(button);
    }
  }
  /* stage 行可用宽：屏宽减去左右内边距（320 − 2×8 = 304）。 */
  function stageWidthPx() {
    var width = (SCREEN.widthPx || 320) - 2 * (SCREEN.paddingPx || 8);
    return width;
  }
  /**
   * stage 那一行的 letter-spacing（CSS「#screen .stage { … letter-spacing:1px 」同一个数字）：
   * 只按字宽量会撑过 304，所以量这一行要带上它。
   */
  var STAGE_LETTER_SPACING_W = 1;
  /**
   * 首页顶行的尺寸常量：必须和 CSS「#screen .home-top .signal」那三条规则一模一样
   * （柱宽 5px × 3、柱间隙 2px × 2、时间与图标间隙 8px）。
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
  /** 顶行：本地时钟 HH:MM + 棋盘右端三段计数 / 信号柱（页面自己画，不读宿主帧）。 */
  function renderHomeTop() {
    var clock = $('homeClock');
    if (clock) clock.textContent = clockText();
    var counts = $('boardCounts');
    if (counts) {
      counts.textContent = state.screenMode === 'board' ? fitTextPx(boardCountsText(state.board && state.board.counts), 170, 11) : '';
    }
  }

  /* ---------- 任务棋盘（屏 1）：一行一任务 ----------
   * 版式：顶行三段计数（●N 在跑 等你 排队）→ 最近 5 行任务。旧式翻页条已整体删除
   * （用户 2026-11-09：设备屏不要上一页/下一页），5 行分掉原来那 28px，320×240 不溢出。
   * 每行只说三件事：状态胶囊（文字）、任务名、副行「项目 · 第 N 步」＋右侧时长环。
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
    // 派单三步圆点同理：renderSteps 先加 steps-on，后一次 className 不能把它抹掉。
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
    // 列表区单独一层（flex:1）：翻页条在它下面，钉在屏底 —— 一条还是四条都不影响翻页条的位置。
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
      if (Number(row.merged) > 0) {
        var merged = document.createElement('span');
        merged.className = 'board-merged';
        merged.textContent = '+' + row.merged + ' 条';
        row1.appendChild(merged);
      }
      // 微条放在标题行末尾：副行最右边只留「状态图形」这一枚（用户 2026-11-10 实机反馈：
      // 右侧同时出现波形+圆环，看成两个状态了）。
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
      /* 右侧状态图形（用户 2026-11-10 定案）：完成＝绿色实心圆（直径 12px）；
         待决策＝黄色圆形里的问号；排队/派单＝灰色细环；进行中＝蓝色圆环，弧长由宿主的
         ring.percent（已运行时长 ÷ 30 分钟）画出来，满 30 分钟后停在差一点的整圈。 */
      row2.appendChild(boardStatusEl(row));
      item.appendChild(row1);
      item.appendChild(row2);
      list.appendChild(item);
    }
    // 翻页条：每页 4 条（BOARD_PAGE_SIZE）；只有一页时整条不建（用户 2026-11-10「首页恢复翻页」）。
    var page = board.page || { index: 0, total: 1 };
    var pageIndex = Math.max(0, Math.floor(Number(page.index) || 0));
    var pageTotal = Math.max(1, Number(page.total) || 1);
    if (rows.length > 0 && pageTotal > 1) {
      var pager = document.createElement('div');
      pager.className = 'board-pager';
      var prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.textContent = '上一页';
      prevBtn.setAttribute('data-action', 'boardPrev');
      prevBtn.className = pageIndex > 0 ? 'cur' : 'off';
      var nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.textContent = '下一页';
      nextBtn.setAttribute('data-action', 'boardNext');
      nextBtn.className = pageIndex < pageTotal - 1 ? 'cur' : 'off';
      var pageText = document.createElement('span');
      pageText.className = 'page';
      pageText.textContent = '第 ' + (pageIndex + 1) + '/' + pageTotal + ' 页';
      pager.appendChild(prevBtn);
      pager.appendChild(pageText);
      pager.appendChild(nextBtn);
      body.appendChild(pager);
    }
    applyScreenClass('board-mode');
  }

  /** 棋盘行右侧那枚状态图形（14×14，右对齐，离屏幕外沿 10px）。 */
  function boardStatusEl(row) {
    var status = document.createElement('span');
    var state = String(row.state || 'queued');
    status.className = 'board-status ' + state;
    if (state === 'running') {
      var percent = Number(row.ring && row.ring.percent);
      percent = Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0;
      // 「跑满就停在满圈附近」：满 30 分钟还留 6% 的空档，让人看得出它转了一圈、但没转满。
      if (percent >= 1) percent = 0.94;
      var radius = 5;
      var circumference = Math.PI * 2 * radius;
      var arc = Math.max(1, circumference * percent);
      status.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">'
        + '<circle cx="7" cy="7" r="' + radius + '" fill="none" stroke="#2b3a4a" stroke-width="2"></circle>'
        + '<circle cx="7" cy="7" r="' + radius + '" fill="none" stroke="#4f9fd8" stroke-width="2" stroke-linecap="round"'
        + ' stroke-dasharray="' + arc.toFixed(2) + ' ' + (circumference + 1).toFixed(2) + '"'
        + ' transform="rotate(-90 7 7)"></circle></svg>';
      return status;
    }
    if (state === 'awaiting') {
      status.textContent = row.badge === 'ask' ? '?' : '·';
      return status;
    }
    // 完成＝绿色实心圆（直径 12px，由 CSS 给）；排队／派单＝灰色细环（CSS）。
    return status;
  }

  /* ---------- 完成页（屏 6，参考图版式） ----------
   * 顶栏 14 + 标题 22 + 正文按行数（最多 7×20，当前行青底黑字）+ 三键贴底 30，
   * 320×240 内不溢出；行少时正文贴标题、空白留在正文与按钮之间。
   * 行文本由宿主按像素折好（done.lines），页面只负责窗口与高亮，不再二次翻译。
   *
   * 高亮 ≡ 每段 PCM 的真实开始/结束（2026-11-10 用户实机反馈第二版：高亮比声音快）：
   * **不再**用 ctx.currentTime 在排程区间里按比例推算字符位置（旧 pollDone 已删）。
   * 每段 PCM（一个 AudioBufferSourceNode）真正开始的那一刻 → 锁定它自己的
   * charStart/charEnd（一段跨多行时就高亮起始行，行内进度不显示）；
   * 这段 onended（真实事件）→ 推进到下一段的起始行。浏览器没有 onstart 事件，
   * 页面用「上一段的 onended」当下一段的开始：两段在同一条 AudioContext 时间轴上
   * 首尾相接（startAt 严格等于上一段的 end），事件与采样级对齐；中间有空档时
   * 本段是单独排的（startAt = now+0.03），排程瞬间就视作开始。全程不做时间推算。
   */
  function clearDoneState() {
    state.doneRanges = null;
    state.done = null;
    var body = $('doneBody');
    if (body) body.innerHTML = '';
  }
  function paintDone() {
    var done = state.done;
    if (!done) return;
    var total = done.lines.length;
    var stage = $('doneStage');
    if (stage) stage.textContent = '完成' + (total > 1 ? ' · ' + (done.current + 1) + '/' + total : '');
    // 顶栏右端「另有 N 条」跟正文同一帧、同一时刻刷新（不单独计时）。
    var more = $('doneMore');
    if (more && state.doneMoreText !== undefined) more.textContent = state.doneMoreText;
    var body = $('doneBody');
    if (!body) return;
    body.innerHTML = '';
    // 正文区高度＝标题与贴底按钮之间的剩余空间（不固定 7×20）：按真实可视高度取整行数，
    // 放不下的行交给窗口滚动/裁剪，正文永远不会压到按钮上。
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
  /** 字符位置 → 行（依据宿主的 done.ranges，码点下标）。 */
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
   * 朗读段开始/结束写进页面事件区（用户 2026-11-10：按段打印时间，方便和声音对照）。
   * n = 宿主给的段号（payload.index + 1）。一段 120ms 分块有多个 AudioBufferSourceNode，
   * 开始只在**第一块开始**时记一次（payload.seq=0），结束只在这一段的最后一块（final）记一次。
   */
  function logReadSegment(phase, meta, at) {
    if (!meta) return;
    var index = Number(meta.index);
    if (!isFinite(index)) return;
    if (phase === 'start' ? meta.first !== true : meta.final !== true) return;
    addEvent('progress', '朗读段 ' + (index + 1) + ' ' + (phase === 'start' ? '开始' : '结束')
      + ' at=' + Math.max(0, Number(at) || 0).toFixed(2) + 's');
  }
  /**
   * 一段 PCM **真正开始**播放：锁定它的字符区间 → 高亮起始行（一段跨多行只亮当前行，
   * 行内进度不显示）；同时写「朗读段 n 开始」。浏览器没有 onstart：上一段 onended
   * 触发时本段正好在时间轴上开始（见 playPcm 的首尾相接判定），所以那里调这里；
   * 空档后单独排的段在排程瞬间调用（30ms 后响，误差远小于一句，绝不会提前一句）。
   */
  function segmentStarted(entry) {
    if (!entry || entry.started) return;
    entry.started = true;
    var meta = entry.meta || {};
    var ctx = state.audioCtx;
    logReadSegment('start', meta, ctx ? ctx.currentTime : entry.at);
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
   * 一段 PCM 播完（onended，真实事件）：写「朗读段 n 结束」；如果下一段已经在同一条
   * 时间轴上排好（entry.next），此刻就是它的开始 → 立刻把高亮推进到它的起始行。
   * 下一段还没到，就停在当前行等它真的开始（绝不按时间提前跳）。
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
    state.screenMode = 'done';
    state.hostAlert = false;
    state.highlightLock = false;
    state.done = { lines: lines, current: current };
    state.doneRanges = Array.isArray(raw.ranges) ? raw.ranges : null;
    state.actions = Array.isArray(payload.actions) ? payload.actions : [];
    state.doneMoreText = payload.more && payload.more.text ? String(payload.more.text) : '';
    $('stage').style.display = 'none';
    $('doneTitle').textContent = payload.title || '';
    $('doneMore').textContent = state.doneMoreText;
    // 先挂 done-mode 再画正文：正文区高度要按「按钮贴底后的剩余空间」实测，
    // 顺序反了会量到 display:none 的 0。三键也先建好，才有同样的布局尺寸。
    renderActions();
    applyScreenClass((payload.tone || 'ok') + ' done-mode' + (state.actions.length ? ' has-actions' : ''));
    paintDone();
  }

  /* 派单回执的三拍圆点：已入队 / 排队 N 个 / 开始跑（圆点由 CSS 画，文字给状态） */
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
        arrow.textContent = '→';
        box.appendChild(arrow);
      }
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
    // 收到任何一帧都顺手重画顶行（时钟本来每秒 tick，这里再补一次保证同一帧里不会花掉）。
    renderHomeTop();
    // 离开完成页就收掉推进计时器（完成页自己的 7 行高亮不能带到别的屏上）。
    if (!(payload && payload.done)) clearDoneState();
    // 2026-11-09：旧主页与旧回答屏整体删除；宿主也不会再发这两种帧。
    // 宿主不会再发这两种帧；万一收到也直接忽略，屏上只认新七屏。
    if (payload && (payload.mode === 'home' || payload.mode === 'reply') && !payload.board) return;
    // 回执/待决策的附加块每帧先收掉，只有本帧带了才重画（否则上一帧的圆点/倒计时会留在屏上）。
    renderSteps(payload && payload.steps);
    renderCountdown(payload && payload.countdown);
    // 任务棋盘（屏 1，含空态）：mode 也是 home，但走 board 分支（行是任务不是项目）。
    if (payload && payload.board) {
      renderBoard(payload);
      return;
    }
    // 完成页：顶栏 + 任务名大标题 + 7 行回答摘要 + 三键（不是旧的状态屏）。
    if (payload && payload.done) {
      renderDone(payload);
      return;
    }
    state.screenMode = 'status';
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
    state.actions = Array.isArray(payload.actions) ? payload.actions : [];
    applyScreenClass((payload.tone || 'idle') + (state.actions.length ? ' has-actions' : '') + (payload.stage === '追问' ? ' ask-mode' : '') + (payload.stage === '进度' ? ' detail-mode' : ''));
    renderActions();
    applyAudioRecovery();
  }

  function addEvent(kind, text) {
    var row = document.createElement('div');
    row.className = kind;
    row.textContent = new Date().toLocaleTimeString() + '  ' + text;
    $('events').appendChild(row);
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
   * 停止/重读/换屏：掐掉已排程的 PCM，并**清空每段的开始/结束回调**——
   * 高亮从此不再被任何后续事件推动（停在实际停住的那一行）。
   * 2026-11-10：onended 同时承担「朗读段 n 结束」和「下一段开始」两件事，
   * 必须在这里摘掉，否则停止后队列里的下一段仍会把高亮往前推。
   */
  function stopPcm() {
    for (var i = 0; i < state.pcmSources.length; i += 1) {
      var source = state.pcmSources[i];
      source.onended = null;
      try { source.stop(); } catch (e) { /* 已结束 */ }
    }
    state.pcmSources = [];
    state.pcmNextTime = 0;
    state.pcmLast = null;
    // 被停止的这一轮也把诊断行打出来（块数/重叠/采样率照实报，方便对照实机杂音）。
    flushReadRound();
  }
  /**
   * 每块首尾各 fadeMs 线性淡入淡出（原位改 samples，缺省 5ms）。
   * 完成页把一条合成音频按行、再按 120ms 切块下发，块边界常落在波形中间：
   * 直接拼接就是每 120ms 一声「咔哒」；淡入淡出把边界跳变压到听不见。
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
  /** 峰值限幅：超过 ceiling（默认 -1 dBFS ≈ 0.891）就整块等比压下来，避免削波成刺耳破音。 */
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
  /** 清掉已经播完的 source：同一轮里别让上一块的尾巴和新块挤在同一条时间轴上。 */
  function recycleSources(nowAt) {
    var keep = [];
    for (var i = 0; i < state.pcmSources.length; i += 1) {
      var source = state.pcmSources[i];
      var endAt = Number(source.__pcmEnd);
      if (isFinite(endAt) && endAt > nowAt - 0.002) { keep.push(source); continue; }
      try { source.onended = null; source.stop(); } catch (e) { /* 已结束 */ }
    }
    state.pcmSources = keep;
  }
  /**
   * 朗读诊断（用户 2026-11-10 要求）：每轮记「首块字节数 / 总块数 / 是否发生重叠 / 采样率」，
   * 这一轮播完（或被停止）时在事件区打一行，实机有杂音时一眼能对上。
   */
  function noteReadRound(rate, overlap, bytes, meta) {
    var first = meta !== null && meta !== undefined && meta.first === true && Number(meta.index) === 0;
    if (first) flushReadRound(); // 上一轮没播完就来了新一轮：先把上一轮结算掉
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
    addEvent('progress', '朗读 · 块 ' + round.blocks + ' · 首块 ' + round.firstBytes + ' B · 采样率 '
      + (round.sampleRate || 24000) + ' · 重叠 ' + round.overlaps);
  }
  function playPcm(base64, sampleRate, cache, meta) {
    if (!base64) return null;
    var ctx = ensureAudio();
    if (!ctx) { markAudioDropped(); return null; }
    // 未解锁：先 resume，等不到 running 就**丢弃这段**并提示点一下页面——
    // 绝不排队（suspended 时 currentTime 冻结，排进去的时间轴一旦恢复会全部炸响）。
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
      // 小端 16 bit 有符号（宿主按 pcm16 发，采样率 24000）：按对解，**不是** float32。
      // 少见的奇数字节（半个采样）直接丢尾巴，避免整段错位成噪声。
      var count = Math.floor(binary.length / 2);
      var rate = Number(sampleRate);
      if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) rate = 24000;
      var samples = new Float32Array(count);
      for (var i = 0; i < count; i += 1) {
        var value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
        if (value >= 0x8000) value -= 0x10000;
        samples[i] = value / 32768;
      }
      // ① 每块首尾各 5ms 线性淡入淡出：PCM 切成 120ms 一块时，块边界常常落在波形中间，
      //    直接拼接会「咔哒」（段边界同理）。淡入淡出把跳变压到听不出来。
      shapePcm(samples, rate, 5);
      // ② 峰值限幅到 -1 dBFS（0.891）：多块首尾相接、或某段增益偏高时不至于削波成刺耳的破音。
      limitPcm(samples, 0.891);
      var buffer = ctx.createBuffer(1, count, rate);
      buffer.copyToChannel(samples, 0);
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      // ③ 排程绝不重叠：起点 = max(现在 + 30ms, 上一块排到哪儿)。上一块已经过期（卡顿/丢帧）
      //    就清掉它的残留、从 now+30ms 重新对齐 —— 绝不把两块 start 在同一时刻（叠加会爆音）。
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
      // 朗读诊断（用户要求）：每轮首块/总块数/是否重叠/采样率，这一轮播完写一行到事件区。
      noteReadRound(rate, overlap > 0, count, meta);
      // 上一段正好在 startAt 结束（同一时间轴首尾相接）→ 它的 onended 就是本段的「开始」事件；
      // 中间有空档时没有可挂的上一段，排程瞬间就视作开始（30ms 后真的响）。
      var prev = state.pcmLast;
      var contiguous = prev !== null && Math.abs(startAt - (prev.at + prev.duration)) < 1e-6;
      if (contiguous) prev.next = entry; else segmentStarted(entry);
      state.pcmLast = entry;
      source.onended = function () {
        var index = state.pcmSources.indexOf(source);
        if (index >= 0) state.pcmSources.splice(index, 1);
        if (state.audioCtx && state.pcmNextTime <= state.audioCtx.currentTime + 0.05) state.highlightLock = false;
        // 真实播完：记「朗读段 n 结束」；同一条时间轴上的下一段此刻开始 → 推进高亮。
        segmentEnded(entry);
        // 朗读结束自检：最后一块播完、队列清空 → 记一行（宿主 60 秒后自动回棋盘）。
        if (state.ttsFinalSeen && state.pcmSources.length === 0) {
          state.ttsFinalSeen = false;
          var endedOk = audioRunning(state.audioCtx);
          console.assert(endedOk, '[tihu] 朗读播完时 AudioContext 不是 running：' + (state.audioCtx && state.audioCtx.state));
          addEvent(endedOk ? 'done' : 'alert', endedOk ? '朗读结束：60 秒后自动回棋盘' : '朗读结束时音频仍未解锁（点一下屏幕再点重读）');
          flushReadRound();
        }
      };
      // 重读缓存（本轮完整 PCM）；试听音频不进缓存（否则下次「重读」会念成试听句）。
      return entry;
    } catch (e) { markAudioDropped(); /* 解码失败：屏内保留重读恢复 */ }
    return null;
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
    state.ttsChunks = 0;
    state.ttsFinalSeen = false;
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
      // 统一指挥是唯一入口：永远裸 hello（宿主绑「鹈鹕指挥台」，屏上是任务棋盘）。
      sendHello('', false);
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
        $('transcript').textContent = state.lastTranscript;
        $('transcript').className = '';
        addEvent('progress', '转写：' + state.lastTranscript);
        break;
      case 'tts.audio': {
        // 试听音频：只播、不推进高亮、不进本轮朗读缓存（试听不算一轮回复）。
        if (payload.sample === true) {
          resumeAudio();
          playSampleAudio(String(payload.data || ''), Number(payload.sampleRate) || 24000);
          break;
        }
        // 正式朗读（完成页/回答页）：宿主按块下发 24kHz PCM，这里排队播放。
        // 2026-11-09 断音根因：上一轮删「旧朗读链路」时把这一段一起删了，只剩试听分支，
        // 于是 tts.audio 全部到达、页面一个字节都不播（完成页看着就是没声音）。
        resumeAudio();
        var audioRate = Number(payload.sampleRate) || 24000;
        if (audioRate !== 24000) {
          console.warn('[tihu] 朗读采样率异常', audioRate);
          addEvent('alert', '朗读采样率异常：' + audioRate + '（期望 24000）');
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
          if (state.ttsChunks === 1) addEvent('progress', '朗读开始：' + audioRate + 'Hz');
          if (payload.final === true) { state.ttsFinalSeen = true; addEvent('progress', '朗读：最后一块已排入播放队列'); }
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
      case 'session.bound': state.sessionId = payload.sessionId || ''; break;
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
  /** 把一段音频（录音文件/拖进来的 WAV）解码成 16k 单声道后上行（audio.frame）。
      统一指挥没有「选会话」这回事：这里不再读 state.sessionId，也不弹旧会话列表。 */
  function uploadWav(arrayBuffer, label) {
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
        blob.arrayBuffer().then(function (buffer) { uploadWav(buffer, '录音'); });
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

  /* ---------- 文本 / 撤回 ---------- */
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
        var under = document.elementFromPoint(event.clientX, event.clientY);
        if (under && under.getAttribute) {
          var actionId = under.getAttribute('data-action');
          if (actionId) {
            // 停止/回主页/翻页都算「退出本轮朗读」：和停止一样先把页面音频队列掐掉（宿主也会 cancelRound），
            // 差别只是不回「已停止朗读」提示。
            if (actionId === 'stop' || actionId === 'home' || actionId === 'prev' || actionId === 'next'
              || actionId === 'taskBoard' || actionId === 'boardPrev' || actionId === 'boardNext') stopPcm();
            if (actionId === 'replay' && audioRunning(state.audioCtx)) {
              state.droppedAudio = false;
              hideAudioWarn();
            }
            if (state.done && actionId === 'replay') {
              // 重读：掐掉旧音频 + 清空每段回调，高亮回第一行；宿主重发第一段 PCM 后
              // 从「朗读段 1 开始」这个事件重新推进（不按时间估算）。
              stopPcm();
              state.done.current = 0;
              paintDone();
            }
            if (actionId === 'taskBoard') clearDoneState();
            if (actionId === 'home') tapFlash(event.clientX - rect.left, event.clientY - rect.top);
            send('screen.gesture', { action: 'tap', x: x, y: y, hit: 'action', actionId: actionId });
            return;
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
