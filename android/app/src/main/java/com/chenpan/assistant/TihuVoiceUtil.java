package com.chenpan.assistant;

/**
 * 鹈鹕屏语音输入里那些「纯逻辑」的部分：WAV 头、地址推导、注入到页面的 CSS/JS 文本。
 *
 * 这里刻意不引用任何 Android API（没有 Uri、没有 WebView、没有 Context），
 * 因为它是可以在桌面 JVM 上用 javac + java 直接跑自测的：
 * 见 tools/VoiceUtilSelfTest.java（断言 WAV 头字段、含引号/换行/中文的文本生成的 JS 合法）。
 *
 * 上层 MainActivity 只负责：AudioRecord 采 PCM → 调 wavHeader() 拼 WAV → 调 asrUrlOf() 拿地址
 * → POST → 调 buildSendJs() 把转写文本塞进页面 #text 并点 #send。
 */
public final class TihuVoiceUtil {

    /** 录音参数：16 kHz / 单声道 / 16 bit PCM，和 relay→whisper 的输入要求一致。 */
    public static final int SAMPLE_RATE = 16000;
    public static final int CHANNELS = 1;
    public static final int BITS_PER_SAMPLE = 16;

    private TihuVoiceUtil() {
    }

    // ------------------------------------------------------------------ WAV

    /** 标准 44 字节 PCM WAV 头；pcmBytes = data 段字节数。 */
    public static byte[] wavHeader(int pcmBytes) {
        int dataLen = pcmBytes < 0 ? 0 : pcmBytes;
        int channels = CHANNELS;
        int bits = BITS_PER_SAMPLE;
        int blockAlign = channels * bits / 8;
        int byteRate = SAMPLE_RATE * blockAlign;

        byte[] h = new byte[44];
        putAscii(h, 0, "RIFF");
        putLe32(h, 4, 36 + dataLen);
        putAscii(h, 8, "WAVE");
        putAscii(h, 12, "fmt ");
        putLe32(h, 16, 16);
        putLe16(h, 20, 1);
        putLe16(h, 22, channels);
        putLe32(h, 24, SAMPLE_RATE);
        putLe32(h, 28, byteRate);
        putLe16(h, 32, blockAlign);
        putLe16(h, 34, bits);
        putAscii(h, 36, "data");
        putLe32(h, 40, dataLen);
        return h;
    }

    /** PCM 字节 + 头，凑成一个完整的 WAV 文件。 */
    public static byte[] wrapWav(byte[] pcm) {
        if (pcm == null) pcm = new byte[0];
        byte[] out = new byte[44 + pcm.length];
        System.arraycopy(wavHeader(pcm.length), 0, out, 0, 44);
        System.arraycopy(pcm, 0, out, 44, pcm.length);
        return out;
    }

    private static void putAscii(byte[] b, int off, String s) {
        for (int i = 0; i < s.length(); i++) {
            b[off + i] = (byte) s.charAt(i);
        }
    }

    private static void putLe16(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xFF);
        b[off + 1] = (byte) ((v >>> 8) & 0xFF);
    }

    private static void putLe32(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xFF);
        b[off + 1] = (byte) ((v >>> 8) & 0xFF);
        b[off + 2] = (byte) ((v >>> 16) & 0xFF);
        b[off + 3] = (byte) ((v >>> 24) & 0xFF);
    }

    // ------------------------------------------------------------- 地址推导

    /** http(s)://host[:port]，去掉路径与参数；不合法返回 ""。 */
    public static String originOf(String url) {
        if (url == null) return "";
        String s = url.trim();
        int schemeEnd = s.indexOf("://");
        if (schemeEnd <= 0) return "";
        String scheme = s.substring(0, schemeEnd).toLowerCase();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return "";
        String rest = s.substring(schemeEnd + 3);
        int cut = rest.length();
        int a = rest.indexOf('/');
        int b = rest.indexOf('?');
        int c = rest.indexOf('#');
        if (a >= 0 && a < cut) cut = a;
        if (b >= 0 && b < cut) cut = b;
        if (c >= 0 && c < cut) cut = c;
        String hostPort = rest.substring(0, cut);
        if (hostPort.isEmpty()) return "";
        // 去掉可能存在的 user:pass@
        int at = hostPort.lastIndexOf('@');
        if (at >= 0) hostPort = hostPort.substring(at + 1);
        if (hostPort.isEmpty()) return "";
        for (int i = 0; i < hostPort.length(); i++) {
            char ch = hostPort.charAt(i);
            if (ch == ' ') return "";
        }
        return scheme + "://" + hostPort;
    }

    /**
     * ASR 地址 = 鹈鹕地址的 origin + /tihu/asr。
     * 用户只填一个「鹈鹕地址」，ASR 地址自动跟着走（不单独暴露一个输入框）。
     */
    public static String asrUrlOf(String tihuUrl) {
        String origin = originOf(tihuUrl);
        return origin.isEmpty() ? "" : origin + "/tihu/asr";
    }

    /** 推不出地址时给用户看的中文原因。 */
    public static String asrUrlProblem(String tihuUrl) {
        String u = tihuUrl == null ? "" : tihuUrl.trim();
        if (u.isEmpty()) return "还没填鹈鹕地址";
        if (asrUrlOf(u).isEmpty()) return "鹈鹕地址不是 http/https 开头，推不出语音接口";
        if (u.toLowerCase().startsWith("http://")) {
            return "鹈鹕地址是 http 明文，语音接口可能被系统拦（建议 https 或确认网络）";
        }
        return "";
    }

    /**
     * 这个 URL 是不是真正的鹈鹕页（路径 /tihu 或 /tihu/...，不含 /tihu/asr）。
     *
     * 为什么需要：鹈鹕屏是独立 WebView，但页面里点登录/返回/会话可能把它导航到
     * 助手的「/」路由。这时 onTihu 仍是 true、tihuReady 也是 true，只按这两个标志
     * 显示原生浮层，就会在 DSH 个人助手页面上露出鹈鹕的录音按钮和音量条。
     * 可见性必须按「当前真正显示的 URL」判，不能只看切屏标志。
     */
    public static boolean isTihuPage(String url) {
        if (url == null) return false;
        String s = url.trim();
        int schemeEnd = s.indexOf("://");
        if (schemeEnd <= 0) return false;
        String scheme = s.substring(0, schemeEnd).toLowerCase(java.util.Locale.US);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
        String rest = s.substring(schemeEnd + 3);
        int hostEnd = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                hostEnd = i;
                break;
            }
        }
        if (hostEnd >= rest.length()) return false;   // 没有路径 → 助手首页
        String path = rest.substring(hostEnd);
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        int h = path.indexOf('#');
        if (h >= 0) path = path.substring(0, h);
        if (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);
        String lower = path.toLowerCase(java.util.Locale.US);
        if ("/tihu/asr".equals(lower)) return false;
        return "/tihu".equals(lower) || lower.startsWith("/tihu/");
    }

    // ------------------------------------------------------------- 注入页面

    /**
     * 生成「把文本填进 #text 再点 #send」的 JS。
     * 返回一个对象 {ok, sent, transcript, error}：
     *   ok = 页面的 #transcript 回读内容与发送文本一致（这是发送成功的唯一判据，不靠猜）。
     */
    public static String buildSendJs(String text) {
        String lit = jsString(text == null ? "" : text);
        return "(function(){try{"
                + "var t=" + lit + ";"
                + "var e=document.getElementById('text');"
                + "if(!e){return {ok:false,error:'页面上找不到输入框 #text'};}"
                + "e.value=t;"
                + "var s=document.getElementById('send');"
                + "if(!s){return {ok:false,error:'页面上找不到发送按钮 #send'};}"
                + "s.click();"
                + "var tr=document.getElementById('transcript');"
                + "var got=tr?String(tr.textContent||''):'';"
                + "var n=function(x){return String(x).replace(/^\\s+|\\s+$/g,'');};"
                + "var ok=n(got)===n(t)&&n(t).length>0;"
                + "return {ok:ok,sent:t,transcript:got,error:ok?'':'页面 #transcript 里没有出现这段文字'};"
                + "}catch(err){return {ok:false,error:String((err&&err.message)||err)};}})()";
    }

    /**
     * Java 字符串 → 合法的 JS 字符串字面量（带引号）。
     * 和 JSON.stringify 等价，另外把 U+2028/U+2029 也转义掉（老 WebView 会当成换行导致语法错），
     * 并把 < 转成 \\u003c，防止文本里出现 </script> 之类被 HTML 解析器提前截断。
     */
    public static String jsString(String s) {
        StringBuilder sb = new StringBuilder(s == null ? 2 : s.length() + 2);
        sb.append('"');
        if (s != null) {
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"':
                        sb.append("\\\"");
                        break;
                    case '\\':
                        sb.append("\\\\");
                        break;
                    case '\n':
                        sb.append("\\n");
                        break;
                    case '\r':
                        sb.append("\\r");
                        break;
                    case '\t':
                        sb.append("\\t");
                        break;
                    case '\b':
                        sb.append("\\b");
                        break;
                    case '\f':
                        sb.append("\\f");
                        break;
                    case '<':
                        sb.append("\\u003c");
                        break;
                    case '>':
                        sb.append("\\u003e");
                        break;
                    case '\u2028':
                        sb.append("\\u2028");
                        break;
                    case '\u2029':
                        sb.append("\\u2029");
                        break;
                    default:
                        if (c < 0x20) {
                            sb.append("\\u");
                            String hex = Integer.toHexString(c);
                            for (int k = hex.length(); k < 4; k++) sb.append('0');
                            sb.append(hex);
                        } else {
                            sb.append(c);
                        }
                }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private static final String LIGHT_CSS =
            // 页面底子
            "html.tihu-light body{background:#f7f8fa!important;color:#111827!important;}"
            + "html.tihu-light header b,html.tihu-light header span{color:#111827!important;}"
            + "html.tihu-light #conn{color:#6b7280!important;}"
            + "html.tihu-light #conn.on{color:#0f766e!important;}"
            + "html.tihu-light #conn.off{color:#dc2626!important;}"
            + "html.tihu-light .hint,html.tihu-light .device-title,html.tihu-light .device-caption{color:#6b7280!important;}"
            + "html.tihu-light .card{background:#fff!important;border-color:#e5e7eb!important;color:#111827!important;"
            + "box-shadow:0 1px 2px rgba(17,24,39,.06)!important;}"
            + "html.tihu-light h4{color:#111827!important;}"
            + "html.tihu-light input,html.tihu-light select,html.tihu-light textarea{background:#fff!important;"
            + "color:#111827!important;border:1px solid #d1d5db!important;}"
            + "html.tihu-light button{background:#f3f4f6!important;color:#111827!important;border-color:#d1d5db!important;}"
            + "html.tihu-light .file{background:#fff!important;color:#111827!important;border-color:#d1d5db!important;}"
            + "html.tihu-light #transcript,html.tihu-light #events{color:#111827!important;}"
            + "html.tihu-light #events div{border-color:#eee!important;}"
            + "html.tihu-light #drop{background:#f9fafb!important;color:#111827!important;border-color:#0f766e!important;}"
            + "html.tihu-light #audioWarn{background:#fff7ed!important;color:#92400e!important;border-color:#fed7aa!important;}"
            // 设置面板
            + "html.tihu-light #tihu-settings{background:rgba(17,24,39,.35)!important;}"
            + "html.tihu-light #tihu-settings .ts-card{background:#fff!important;border-color:#e5e7eb!important;}"
            + "html.tihu-light #tihu-settings .ts-head{border-bottom-color:#e5e7eb!important;}"
            + "html.tihu-light #tihu-settings .ts-title{color:#111827!important;}"
            + "html.tihu-light #tihu-settings .ts-close{background:#f3f4f6!important;color:#111827!important;"
            + "border-color:#d1d5db!important;}"
            + "html.tihu-light #tihu-settings .ts-theme{background:#f3f4f6!important;color:#111827!important;"
            + "border-color:#d1d5db!important;}"
            // 显示屏本体（浅色皮肤）
            + "html.tihu-light #screen{background:#fff!important;color:#111827!important;border-color:#d1d5db!important;}"
            + "html.tihu-light #screen .stage{color:#0f766e!important;}"
            + "html.tihu-light #screen .title{color:#111827!important;}"
            + "html.tihu-light #screen ul{color:#374151!important;}"
            + "html.tihu-light #screen .home-top .clock{color:#0f766e!important;}"
            + "html.tihu-light #screen .home-top .home-counts{color:#6b7280!important;}"
            + "html.tihu-light #screen .home-top .signal .bar{background:#9ca3af!important;}"
            + "html.tihu-light #screen .home-top .signal.conn-online .bar{background:#16a34a!important;}"
            + "html.tihu-light #screen .home-top .signal.conn-connecting .bar{background:#9ca3af!important;}"
            + "html.tihu-light #screen .home-top .signal.conn-offline .bar{background:#dc2626!important;}"
            + "html.tihu-light #screen .board-item{background:#fff!important;border-color:#e5e7eb!important;"
            + "box-shadow:0 1px 2px rgba(17,24,39,.05)!important;}"
            + "html.tihu-light #screen .board-pager button{background:#fff!important;border-color:#e5e7eb!important;"
            + "color:#374151!important;}"
            + "html.tihu-light #screen .board-row1{color:#111827!important;}"
            + "html.tihu-light #screen .board-row2{color:#6b7280!important;}"
            + "html.tihu-light #screen .board-capsule{background:#f3f4f6!important;color:#374151!important;"
            + "border-color:#d1d5db!important;}"
            + "html.tihu-light #screen .board-capsule.running{background:#ecfdf5!important;color:#065f46!important;"
            + "border-color:#a7f3d0!important;}"
            + "html.tihu-light #screen .board-capsule.awaiting{background:#fffbeb!important;color:#92400e!important;"
            + "border-color:#fde68a!important;}"
            + "html.tihu-light #screen .board-capsule.done{background:#eff6ff!important;color:#1e40af!important;"
            + "border-color:#bfdbfe!important;}"
            + "html.tihu-light #screen .board-capsule.announced{background:#f1f5f9!important;color:#475569!important;"
            + "border-color:#cbd5e1!important;}"
            + "html.tihu-light #screen .board-status.done,html.tihu-light #screen .board-status.announced{"
            + "background:#16a34a!important;}"
            + "html.tihu-light #screen .board-status.queued,html.tihu-light #screen .board-status.dispatched{"
            + "border-color:#9ca3af!important;}"
            + "html.tihu-light #screen .ask-card{background:#f9fafb!important;border-color:#e5e7eb!important;}"
            + "html.tihu-light #screen .ask-name{color:#111827!important;}"
            + "html.tihu-light #screen .ask-source{color:#6b7280!important;}"
            + "html.tihu-light #screen .ask-no{color:#0f766e!important;border-color:#0f766e!important;}"
            + "html.tihu-light #screen .board-pager .page{color:#374151!important;}"
            + "html.tihu-light #screen .board-pager button{color:#6b7280!important;}"
            + "html.tihu-light #screen .board-pager button.cur{color:#0f766e!important;}"
            + "html.tihu-light #screen .board-pager button.off{color:#cbd5e1!important;}"
            + "html.tihu-light #screen .action-bar button{background:#f3f4f6!important;color:#111827!important;"
            + "border-color:#d1d5db!important;}"
            + "html.tihu-light #screen .done-stage,html.tihu-light #screen .done-play{color:#0f766e!important;}"
            + "html.tihu-light #screen .done-line{color:#111827!important;}"
            + "html.tihu-light #screen .done-line.cur{background:#0f766e!important;color:#fff!important;}"
            + "html.tihu-light #screen .done-more{color:#6b7280!important;}"
            + "html.tihu-light #screen .done-wave span{background:#0f766e!important;}"
            + "html.tihu-light #screen .step{color:#9ca3af!important;}"
            + "html.tihu-light #screen .step::before{background:#e5e7eb!important;}"
            + "html.tihu-light #screen .step.done{color:#0f766e!important;}"
            + "html.tihu-light #screen .step.done::before{background:#0f766e!important;}"
            + "html.tihu-light #screen .step.active{color:#111827!important;}"
            + "html.tihu-light #screen .step.active::before{background:#111827!important;}"
            + "html.tihu-light #screen .step-arrow{color:#cbd5e1!important;}"
            + "html.tihu-light #screen .cd-row,html.tihu-light #screen .cd-row #cdText{color:#6b7280!important;}"
            + "html.tihu-light #screen .cd-track{background:#e5e7eb!important;}"
            + "html.tihu-light #screen .cd-fill{background:#0f766e!important;}"
            + "html.tihu-light #screen .board-empty .l2,html.tihu-light #screen .board-empty .l3{color:#6b7280!important;}"
            + "html.tihu-light #screen .listen{background:#fff!important;color:#111827!important;}"
            + "html.tihu-light #screen .listen .l1,html.tihu-light #screen .listen .l2,"
            + "html.tihu-light #screen .listen .l3,html.tihu-light #screen .listen .heard{color:#374151!important;}";

    /**
     * 手机适配样式：整段包在 @media (max-width:700px) 里 ——
     * 桌面/宽屏打开时一个字都不生效，页面保持原样（硬约束）。
     * 变量 --tihu-voice-pad 由 App 在录音时调大，--tihu-fit 由 fitJs() 按窗口宽度算。
     *
     * 1.1.1：手机屏上只留模拟设备的显示屏。除「显示屏所在的那个顶层块」（JS 会打上
     * .tihu-keep 标记）与 App 自己的齿轮/设置面板外，所有 body 顶层块一律 display:none；
     * 这些被隐藏的块会被 settingsJs() **整体搬进「鹈鹕设置」面板**（移动真实节点，
     * 原有事件监听全部有效），关面板时按原索引放回。
     */
    public static final String MOBILE_CSS =
            "@media (max-width:700px){"
                    + "html,body{height:auto!important;min-height:100%!important;}"
                    + "html{overflow-x:hidden!important;-webkit-text-size-adjust:100%!important;}"
                    + "body{max-width:100vw!important;width:100%!important;"
                    + "padding:10px 10px calc(var(--tihu-voice-pad,300px) + env(safe-area-inset-bottom,0px)) 10px!important;"
                    + "display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:flex-start!important;"
                    + "gap:8px!important;}"
                    + "body>*:not([data-tihu-keep]):not(#tihu-gear):not(#tihu-settings):not(.device-wrap):not(#deviceWrap):not(.device){display:none!important;}"
                    + "body>[data-tihu-keep]{margin:6px auto 0 auto!important;max-width:100%!important;}"
                    + ".device{zoom:var(--tihu-fit,1)!important;}"
                    + ".device-wrap{max-width:100%!important;overflow:hidden!important;}"
                    + ".device-wrap .screen-tools{display:none!important;}"
                    // 1.1.2：硬件规格说明行（“ESP32-S3-BOX-3B · 2.4″ · 320×240 · 触摸屏”等）
                    // 一律不显示，省下的高度全给显示屏；运行态（连接状态）改由音量条左端的小圆点表示。
                    + ".device-title,.device-caption{display:none!important;}"
                    // 1.1.2：小屏上显示屏撑满可用区域 —— 宽按屏宽等比放大（--tihu-fit），
                    // 高由 JS 按「音量条上沿」的剩余高度算成逻辑高度（--tihu-screen-h）写进来。
                    // 1.2.6：屏幕内的长文本可纵向滚动（细滚动条 + 8px 内边距）
                    + "#screen ul,#screen .done-body,#screen .board-list,#screen .home-body{"
                    + "overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;min-height:0!important;"
                    + "scrollbar-width:thin!important;scrollbar-color:rgba(17,24,39,.25) transparent!important;}"
                    + "#screen ul,#screen .done-body{padding-right:8px!important;}"
                    + "#screen *::-webkit-scrollbar{width:4px!important;height:4px!important;}"
                    + "#screen *::-webkit-scrollbar-thumb{background:rgba(17,24,39,.22)!important;border-radius:2px!important;}"
                    + "#screen *::-webkit-scrollbar-track{background:transparent!important;}"
                    + "html:not(.tihu-light) #screen *::-webkit-scrollbar-thumb{background:rgba(230,237,243,.28)!important;}"
                    + "#tihu-scroll-latest{position:absolute!important;right:8px!important;bottom:8px!important;z-index:9!important;"
                    + "font-size:11px!important;line-height:16px!important;padding:3px 10px!important;border-radius:12px!important;"
                    + "border:1px solid #d1d5db!important;background:#ffffff!important;color:#111827!important;display:none!important;}"
                    + "#tihu-scroll-latest.on{display:block!important;}"
                    + "html:not(.tihu-light) #tihu-scroll-latest{background:#121821!important;color:#e6edf3!important;"
                    + "border-color:#33414f!important;}"                    + "#screen{height:var(--tihu-screen-h,240px)!important;max-height:none!important;min-height:180px!important;}"
                    + "#screen .board-list{display:flex!important;flex-direction:column!important;}"
                    + "#screen .board-item{flex:1 1 0!important;height:auto!important;min-height:48px!important;"
                    + "max-height:132px!important;display:flex!important;flex-direction:column!important;"
                    + "justify-content:center!important;}"
                    + "header b{font-size:16px!important;}"
                    + "#conn,.hint,.device-title,.device-caption,.hint *{font-size:13px!important;line-height:1.5!important;}"
                    + "input,select,textarea,button,.file{font-size:15px!important;}"
                    + "input,select,.file{min-height:44px!important;}"
                    + "button{min-height:44px!important;padding:0 12px!important;}"
                    + "textarea{min-height:88px!important;}"
                    + "#transcript,#events{font-size:14px!important;line-height:1.55!important;}"
                    + "#screen button{min-height:24px!important;padding:0 2px!important;font-size:12px!important;}"
                    + "#screen .action-bar button{min-height:28px!important;font-size:12px!important;}"
                    + "#screen{max-width:100%!important;}"
                    // 设置面板：底部半屏浮层，深色圆角，内部滚动（齿轮已挪到原生音量条最右端）
                    + "#tihu-settings{position:fixed!important;inset:0!important;z-index:2147483001!important;"
                    + "background:rgba(0,0,0,.55)!important;display:none!important;"
                    + "align-items:flex-end!important;justify-content:center!important;}"
                    + "#tihu-settings.open{display:flex!important;}"
                    + "#tihu-settings .ts-card{width:100%!important;max-width:760px!important;max-height:88vh!important;"
                    + "background:#121821!important;border:1px solid #1f2a37!important;"
                    + "border-radius:18px 18px 0 0!important;display:flex!important;flex-direction:column!important;"
                    + "overflow:hidden!important;padding-bottom:env(safe-area-inset-bottom,0px)!important;"
                    + "box-shadow:0 -10px 30px rgba(0,0,0,.5)!important;}"
                    + "#tihu-settings .ts-head{display:flex!important;align-items:center!important;"
                    + "padding:12px 14px!important;border-bottom:1px solid #1f2a37!important;gap:10px!important;}"
                    + "#tihu-settings .ts-title{font-size:16px!important;font-weight:700!important;color:#e6edf3!important;}"
                    + "#tihu-settings .ts-theme{margin-left:auto!important;min-height:32px!important;"
                    + "padding:0 12px!important;border-radius:10px!important;background:#1b2430!important;"
                    + "color:#d9e2ea!important;border:1px solid #33414f!important;font-size:13px!important;}"
                    + "#tihu-settings .ts-close{margin-left:8px!important;min-height:36px!important;"
                    + "padding:0 14px!important;border-radius:10px!important;background:#1b2430!important;"
                    + "color:#d9e2ea!important;border:1px solid #33414f!important;font-size:14px!important;}"
                    + "#tihu-settings .ts-body{overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;"
                    + "padding:10px 12px 18px!important;display:flex!important;flex-direction:column!important;"
                    + "gap:8px!important;}"
                    + "#tihu-settings .ts-body .card{margin:0!important;}"
                    // 1.2.1：会话行做成卡片（状态点/标签右对齐，页脚小胶囊）
                    + "#screen .board-list{display:flex!important;flex-direction:column!important;gap:8px!important;}"
                    + "#screen .board-item{flex:1 1 0!important;height:auto!important;min-height:44px!important;"
                    + "max-height:120px!important;display:flex!important;flex-direction:column!important;"
                    + "justify-content:center!important;border-radius:12px!important;padding:8px 12px!important;"
                    + "border:1px solid #1f2a37!important;background:#121821!important;}"
                    + "#screen .board-row1{font-size:15px!important;font-weight:700!important;line-height:20px!important;}"
                    + "#screen .board-row2{font-size:12px!important;line-height:16px!important;}"
                    + "#screen .board-pager{justify-content:center!important;gap:8px!important;}"
                    + "#screen .board-pager button{font-size:12px!important;padding:2px 10px!important;"
                    + "border:1px solid #1f2a37!important;border-radius:10px!important;background:#121821!important;}"
                    + LIGHT_CSS
                    + "}"
                    + "@media (max-width:380px){"
                    + "body{padding-left:8px!important;padding-right:8px!important;}"
                    + "header b{font-size:15px!important;}"
                    + "}";

    /**
     * 小屏浅色主题（1.1.2 默认）：只在 @media (max-width:700px) 里、且 html 带 .tihu-light 时生效。
     * 切回深色 = 去掉这个 class，页面自身的深色规则原样回来（桌面端根本不会带这个类）。
     */

    /** 把 MOBILE_CSS 注入页面 + 装好缩放/高度计算（只在窄屏生效；宽屏一个属性都不写）。 */
    public static String fitJs() {
        return "(function(){try{"
                + "var css=" + jsString(MOBILE_CSS) + ";"
                + "var old=document.getElementById('tihu-app-css');"
                + "if(old&&old.parentNode){old.parentNode.removeChild(old);}"
                + "var st=document.createElement('style');"
                + "st.id='tihu-app-css';"
                + "st.appendChild(document.createTextNode(css));"
                + "(document.head||document.documentElement).appendChild(st);"
                // 用页面自带的 .shell-off（page.ts 里那套规则）去掉手机外壳；
                // 加在 #device 与 .bezel 上（页面只重写 #deviceWrap.className，不会抹掉这两个）。
                + "function setShell(on){try{"
                + "var dev=document.getElementById('device');"
                + "if(dev&&dev.classList){if(on){dev.classList.add('shell-off');}else{dev.classList.remove('shell-off');}}"
                + "var scr=document.getElementById('screen');"
                + "var bez=scr?scr.parentNode:null;"
                + "if(bez&&bez.classList){if(on){bez.classList.add('shell-off');}else{bez.classList.remove('shell-off');}}"
                + "}catch(e){}}"
                // 浅色/深色：默认浅色；原生侧通过 TihuNative 记住选择，页面重建后照样恢复。
                + "function applyThemeClass(on){try{var el=document.documentElement;if(!el||!el.classList){return;}"
                + "if(on){el.classList.add('tihu-light');}else{el.classList.remove('tihu-light');}}catch(e){}}"
                + "if(!window.__tihuThemeInit){window.__tihuThemeInit=true;"
                + "var t0='light';"
                + "try{if(window.TihuNative&&TihuNative.getTheme){t0=String(TihuNative.getTheme()||'light');}}catch(e){}"
                + "window.__tihuTheme=(t0==='dark')?'dark':'light';}"
                + "window.__tihuSetTheme=function(v){try{"
                + "var t=(String(v)==='dark')?'dark':'light';"
                + "window.__tihuTheme=t;"
                + "applyThemeClass(t==='light'&&(document.documentElement.clientWidth||window.innerWidth||0)<=700);"
                + "try{if(window.TihuNative&&TihuNative.setTheme){TihuNative.setTheme(t);}}catch(e){}"
                + "}catch(e){}};"
                + "if(!window.__tihuFit){"
                + "window.__tihuFit=function(){try{"
                + "var root=document.documentElement;"
                + "var w=root.clientWidth||window.innerWidth||0;"
                + "if(w>700){setShell(false);root.style.removeProperty('--tihu-fit');root.style.removeProperty('--tihu-screen-h');"
                + "applyThemeClass(false);return;}"
                + "setShell(true);"
                + "applyThemeClass(window.__tihuTheme!=='dark');"
                // 宽度：320 逻辑宽 → 屏宽（左右各留 4px，324 是 320+2 边框再留 2px 安全量）
                + "if(!w||w<80){return;}var s=(w-8)/324;if(s>3)s=3;if(s<0.75)s=0.75;"
                // 高度：视口 - 顶部 8 - 底部预留 240（语音条 + 提示位）- 间隙 6 - 顶部留白 14，
                // 再换算成逻辑高度；最后按真实滚动高度再收一次，保证整页不出纵向滚动。
                + "var vh=window.innerHeight||root.clientHeight||0;"
                + "var pad=300;try{var cs=getComputedStyle(document.documentElement);var pv=parseFloat(cs.getPropertyValue('--tihu-voice-pad'));if(pv>0)pad=pv;}catch(e){}var avail=vh-8-pad-6-14;if(avail<200)avail=200;"
                + "var lh=avail/s;if(lh<240)lh=240;if(lh>480)lh=480;"
                + "root.style.setProperty('--tihu-fit',String(s));"
                + "root.style.setProperty('--tihu-screen-h',Math.round(lh)+'px');"
                + "for(var k=0;k<2;k++){"
                + "var sh=(document.body&&document.body.scrollHeight)||0;"
                + "if(sh<=0||!vh)break;"
                + "var over=sh-vh;"
                + "if(over<=0)break;"
                + "lh=Math.floor(lh-over/s-1);if(lh<240)lh=240;"
                + "root.style.setProperty('--tihu-screen-h',lh+'px');"
                + "}"
                + "}catch(e){}};"
                + "window.addEventListener('resize',window.__tihuFit);"
                + "window.addEventListener('orientationchange',function(){setTimeout(window.__tihuFit,120);});"
                + "}"
                + "window.__tihuVoicePad=function(px){try{"
                + "document.documentElement.style.setProperty('--tihu-voice-pad',String(px));"
                + "}catch(e){}};"
                + "window.__tihuFit();"
                + "return 'ok';"
                + "}catch(e){return 'err:'+e;}})()";
    }

    /**
     * 手机屏的「鹈鹕设置」：右上角齿轮 + 底部半屏浮层。
     *
     * 只做两件事：
     *   1. 把「显示屏所在块」（#screen 的 body 级祖先）打上 .tihu-keep，其余 body 顶层块
     *      **整体搬进面板**（移动真实节点 —— 文字兜底、日志、音色下拉的原有事件监听全部照旧有效）；
     *   2. 关闭时按原索引把节点放回 body，反复开关不坏。
     *
     * 宽屏（>700px）直接返回 'wide'，一个 DOM 都不碰 —— 电脑 Chrome 里的 /tihu 零变化。
     * 注入只发生在鹈鹕 WebView，桌面端根本拿不到这段脚本。
     */
    /**
     * 语音命令的「当前界面」摘要：直接从真实 DOM 抓，不生成、不占位。
     * 棋盘态读 #boardCounts、翻页条页码、每个 .board-item 的实际文字；
     * 其它屏读标题/列表/完成页正文/澄清候选。超过 400 字截断。
     * 读不到返回空串（原生据此报错，绝不只发半句）。
     */
    public static String contextJs() {
        return "(function(){try{"
                + "var s=document.getElementById('screen');"
                + "if(!s){return '';}"
                + "function txt(el){if(!el){return '';}var t=el.textContent?String(el.textContent):'';"
                + "return t.replace(/\\s+/g,' ').trim();}"
                + "function all(sel){try{return s.querySelectorAll(sel);}catch(e){return [];}}"
                + "function one(sel){try{return s.querySelector(sel);}catch(e){return null;}}"
                + "var parts=[];"
                + "var mode=String(s.className||'');"
                + "var counts=txt(document.getElementById('boardCounts'));"
                + "if(counts){parts.push(counts);}"
                + "if(mode.indexOf('board-mode')>=0){"
                + "var pg=txt(one('.board-pager .page'));if(pg){parts.push(pg);}"
                + "var items=all('.board-item');"
                + "for(var i=0;i<items.length&&i<8;i++){var line=txt(items[i]);if(line){parts.push((i+1)+'.'+line);}}"
                + "}else{"
                + "var st=txt(one('.stage'));if(st){parts.push(st);}"
                + "var ti=txt(one('.title'));if(ti){parts.push(ti);}"
                + "var li=all('ul li');for(var j=0;j<li.length&&j<6;j++){var x=txt(li[j]);if(x){parts.push('·'+x);}}"
                + "var dn=(txt(one('.done-title'))+' '+txt(one('.done-body'))).trim();if(dn){parts.push(dn);}"
                + "var ask=all('.ask-name');for(var k=0;k<ask.length&&k<6;k++){var a=txt(ask[k]);if(a){parts.push('候选:'+a);}}"
                + "}"
                + "var out=parts.join(' · ');"
                + "if(!out){"
                + "var raw='';try{raw=String(s.innerText||'');}catch(e){raw='';}"
                + "if(!raw){raw=String(s.textContent||'');}"
                + "var lines=String(raw).split(/\\n+/);var keep=[];"
                + "for(var li2=0;li2<lines.length;li2++){var ln=lines[li2].replace(/\\s+/g,' ').trim();if(!ln){continue;}"
                + "var statusWords=['完成','在跑','排队','等你','连接'];"
                + "var skipLine=false;"
                + "for(var sw=0;sw<statusWords.length;sw++){if(ln===statusWords[sw]&&String(raw).split(ln).length>2){skipLine=true;break;}}"
                + "if(skipLine){continue;}"
                + "if(ln==='完成'&&counts&&counts.indexOf('完成')>=0){continue;}"
                + "if(keep.length&&keep[keep.length-1]===ln){continue;}"
                + "keep.push(ln);}"
                + "out=keep.join(' · ');"
                + "}"
                + "if(out.length>400){out=out.slice(0,400);}"
                + "return out;"
                + "}catch(e){return '';}})()";
    }
    /**
     * 小屏阅读滚动（1.2.6）：让 #screen 里的长文本容器可纵向滚动，并做「跟随最新」。
     * 挂钩容器：#screen 内的 ul（朗读/回复要点）、.done-body（完成页正文）、
     * .board-list（棋盘列表）、.home-body（状态屏正文）。
     * 用户手动上翻后不再自动贴底，右下角浮出「回到最新」胶囊；点一下滚到底并恢复跟随。
     * 宽屏（>700px）直接返回 'wide'，一个节点都不碰。
     */
    public static String scrollJs() {
        return "(function(){try{"
                + "var W=document.documentElement.clientWidth||window.innerWidth||0;"
                + "if(W>700){return 'wide';}"
                + "var s=document.getElementById('screen');"
                + "if(!s){return 'no-screen';}"
                + "var pill=document.getElementById('tihu-scroll-latest');"
                + "if(!pill){pill=document.createElement('button');pill.id='tihu-scroll-latest';"
                + "pill.setAttribute('type','button');pill.textContent='回到最新';"
                + "pill.addEventListener('click',function(e){try{if(e&&e.preventDefault){e.preventDefault();}}catch(x){}"
                + "if(window.__tihuScrollToLatest){window.__tihuScrollToLatest();}});"
                + "s.appendChild(pill);}"
                + "var boxes=[];"
                + "function add(el){if(el&&boxes.indexOf(el)<0){boxes.push(el);}}"
                + "add(s.querySelector('ul'));"
                + "add(s.querySelector('.done-body'));"
                + "add(s.querySelector('.board-list'));"
                + "add(s.querySelector('.home-body'));"
                + "var follow=true;var lastUserAt=0;"
                + "function overflowing(el){return el&&el.scrollHeight>el.clientHeight+4;}"
                + "function atBottom(el){return el.scrollHeight-el.scrollTop-el.clientHeight<=8;}"
                + "function refreshPill(){var need=false;"
                + "for(var i=0;i<boxes.length;i++){if(overflowing(boxes[i])&&!atBottom(boxes[i])){need=true;break;}}"
                + "pill.className=need?'on':'';}"
                + "function toBottom(){for(var i=0;i<boxes.length;i++){if(boxes[i]){boxes[i].scrollTop=boxes[i].scrollHeight;}}"
                + "follow=true;lastUserAt=Date.now();refreshPill();}"
                + "window.__tihuScrollToLatest=toBottom;"
                + "function mark(el){el.setAttribute('data-tihu-scroll','1');"
                + "try{el.style.overflowY='auto';}catch(e){}"
                + "el.addEventListener('scroll',function(){lastUserAt=Date.now();follow=atBottom(el);refreshPill();},"
                + "{passive:true});}"
                + "for(var i=0;i<boxes.length;i++){mark(boxes[i]);}"
                + "if(window.MutationObserver){var mo=new MutationObserver(function(){"
                + "if(!follow&&Date.now()-lastUserAt<3000){refreshPill();return;}"
                + "if(follow){for(var i=0;i<boxes.length;i++){if(boxes[i]&&overflowing(boxes[i])){boxes[i].scrollTop=boxes[i].scrollHeight;}}}"
                + "refreshPill();});"
                + "mo.observe(s,{childList:true,subtree:true,characterData:true});}"
                + "for(var j=0;j<boxes.length;j++){if(boxes[j]&&overflowing(boxes[j])){boxes[j].scrollTop=boxes[j].scrollHeight;}}"
                + "refreshPill();"
                + "return 'ok';"
                + "}catch(e){return 'err:'+e;}})()";
    }
    public static String settingsJs() {
        return "(function(){try{"
                + "var W=document.documentElement.clientWidth||window.innerWidth||0;"
                + "if(W>700){return 'wide';}"
                + "if(window.__tihuPanel&&window.__tihuPanel.ready){return 'ok';}"
                + "var body=document.body;"
                + "var screenEl=document.getElementById('screen');"
                + "if(!body||!screenEl){return 'no-screen';}"
                + "var holder=screenEl;"
                + "while(holder.parentNode&&holder.parentNode!==body){holder=holder.parentNode;}"
                + "if(holder.parentNode!==body){return 'no-holder';}"
                // 用 data-* 标记而不是 class：页面自己会重写 #deviceWrap.className（shellToggle 那一段），
                // class 会被抹掉，属性不会。
                + "holder.setAttribute('data-tihu-keep','1');"
                + "var panel=null;var panelBody=null;var moved=[];var opened=false;"
+ "function wakeBridge(){return window.TihuNative||null;}"
+ "function wakeStateObj(){try{var b=wakeBridge();if(!b||!b.wakeState){return null;}return JSON.parse(b.wakeState());}catch(e){return null;}}"
+ "function makeWakeCard(){"
+ "var c=document.createElement('div');c.className='card ts-wake';"
+ "var h=document.createElement('h4');h.textContent='语音唤醒（板内 WakeNet）';c.appendChild(h);"
+ "var lab=document.createElement('label');lab.className='hint ts-wake-on';lab.style.display='flex';lab.style.alignItems='center';lab.style.gap='8px';lab.style.margin='2px 0 6px';"
+ "var chk=document.createElement('input');chk.type='checkbox';chk.style.width='18px';chk.style.height='18px';chk.style.margin='0';"
+ "lab.appendChild(chk);lab.appendChild(document.createTextNode('语音唤醒（只在鹈鹕屏前台监听）'));c.appendChild(lab);"
+ "var st=document.createElement('div');st.className='hint ts-wake-status';c.appendChild(st);"
+ "var trow=document.createElement('div');trow.className='row';"
+ "var tlab=document.createElement('span');tlab.className='hint';tlab.textContent='阈值';"
+ "var trng=document.createElement('input');trng.type='range';trng.min='0';trng.max='1';trng.step='0.01';"
+ "var tval=document.createElement('span');tval.className='hint';"
+ "var tHint=document.createElement('div');tHint.className='hint ts-wake-th-hint';tHint.style.color='#DC2626';"
+ "function syncT(){var v=Number(trng.value);if(!isFinite(v)){v=0.75;trng.value='0.75';}"
+ "tval.textContent=v.toFixed(2);tHint.textContent=(v<=0)?'过低会频繁误唤醒':'';}"
+ "var tv0='0.75';try{var b0=wakeBridge();if(b0&&b0.wakeThresholdValue){tv0=String(b0.wakeThresholdValue());}}catch(e){tv0='0.75';}"
+ "trng.value=tv0;"
+ "syncT();"
+ "trng.addEventListener('input',syncT);"
+ "trng.addEventListener('change',function(){syncT();"
+ "try{var b=wakeBridge();if(b&&b.wakeSetThreshold){b.wakeSetThreshold(String(trng.value));}}catch(e){}});"
+ "trow.appendChild(tlab);trow.appendChild(trng);trow.appendChild(tval);c.appendChild(trow);c.appendChild(tHint);"
+ "var score=document.createElement('div');score.className='hint ts-wake-score';score.textContent='实时分数 — · rms —';c.appendChild(score);"
+ "function tick(){try{var b=wakeBridge();if(b&&b.wakeScoreValue){"
+ "var p=String(b.wakeScoreValue()||'').split('/');"
+ "score.textContent='实时分数 '+(p[0]||'—')+' · rms '+(p[1]||'—');}}catch(e){}}"
+ "tick();"
+ "window.__tihuWakeScoreTick=tick;"
+ "window.__tihuWakeScoreStart=function(){if(window.__tihuWakeScoreTimer){return;}"
+ "window.__tihuWakeScoreTimer=setInterval(function(){try{if(window.__tihuWakeScoreTick){window.__tihuWakeScoreTick();}}catch(e){}},500);};"
+ "window.__tihuWakeScoreStop=function(){if(window.__tihuWakeScoreTimer){clearInterval(window.__tihuWakeScoreTimer);window.__tihuWakeScoreTimer=0;}};"
+ "var rl=document.createElement('button');rl.setAttribute('type','button');rl.textContent='重新加载引擎';rl.style.display='block';rl.style.margin='10px 0 6px';c.appendChild(rl);"
                + "var srow2=document.createElement('label');srow2.className='hint';srow2.style.display='flex';srow2.style.alignItems='center';srow2.style.gap='8px';srow2.style.margin='4px 0';"
                + "var schk=document.createElement('input');schk.type='checkbox';schk.style.width='18px';schk.style.height='18px';schk.style.margin='0';"
                + "try{var b2=wakeBridge();schk.checked=!(b2&&b2.soundState&&b2.soundState()==='0');}catch(e){schk.checked=true;}"
                + "schk.addEventListener('change',function(){try{var b=wakeBridge();if(b&&b.setSound){b.setSound(schk.checked?'1':'0');}}catch(e){}});"
                + "srow2.appendChild(schk);srow2.appendChild(document.createTextNode('提示音'));c.appendChild(srow2);"
+ "var crow=document.createElement('div');crow.className='row ts-accent';crow.style.margin='6px 0 2px';"
+ "var names=['青绿','靛蓝','琥珀'];"
+ "for(var ci=0;ci<3;ci++){(function(idx){var b=document.createElement('button');b.setAttribute('type','button');"
+ "b.textContent=names[idx];b.addEventListener('click',function(e){try{e.preventDefault();}catch(x){}"
+ "var nb=wakeBridge();if(nb&&nb.setAccent){nb.setAccent(String(idx));}});crow.appendChild(b);})(ci);}"
+ "c.appendChild(crow);"
+ "var ev=document.createElement('div');ev.className='hint ts-wake-events';ev.style.marginTop='8px';c.appendChild(ev);"
+ "function refresh(){"
+ "var s=wakeStateObj();"
+ "if(!s){st.textContent='还没接上 App（TihuNative 不可用）';chk.disabled=true;return;}"
+ "st.textContent=s.text||'';"
+ "chk.checked=!!s.enabled;chk.disabled=!s.switchEnabled;"
+ "try{var bt=wakeBridge();if(bt&&bt.wakeThresholdValue){var tv=Number(bt.wakeThresholdValue());if(isFinite(tv)){trng.value=tv.toFixed(2);syncT();}}}catch(e){}"
+ "tick();"
+ "var lines=[];try{var b=wakeBridge();if(b&&b.wakeEventLines){lines=JSON.parse(b.wakeEventLines())||[];}}catch(e){}"
+ "ev.textContent=lines.length?lines.join(String.fromCharCode(10)):'（还没有命中记录；命中后会显示时间 / 关键词 / 分数）';"
+ "}"
+ "chk.addEventListener('change',function(){var b=wakeBridge();"
+ "if(b&&b.wakeSetEnabled){b.wakeSetEnabled(chk.checked?'1':'0');}setTimeout(refresh,150);});"
+ "rl.addEventListener('click',function(e){try{e.preventDefault();}catch(x){}"
+ "var b=wakeBridge();if(b&&b.wakeReload){b.wakeReload();}setTimeout(refresh,600);});"
+ "window.__tihuWakeRefresh=refresh;"
+ "setTimeout(refresh,60);"
+ "return c;}"
                // 指挥台模型（2026-11-13）：手机端唯一允许改的模型设置。
                // 权威值存在宿主的 ~/.dsh/assistant/config.json（tihu.model.background），
                // 这里只做「读现值 + 列目录 + 写配置」，没有任何新桥方法，全靠同源 HTTP：
                //   GET  /api/assistant/config  → { tihu: { model: { background: {provider, model} | null } } }
                //   GET  /api/assistant/models  → { catalog: { default:{provider,model},
                //                                   groups: [{ id, name, models: [{ id, name }] }] } }
                //   注意：宿主下发的就是 groups（与电脑端模型选择器同一份目录）。早期这里按扁平的
                //   catalog.models 读，永远读不到东西，下拉就只剩「跟随默认」+「当前保存」两项。
                //   POST /api/assistant/config  ← { tihu: { model: { background: {…} | null } } }
                // 生效由 lane 负责：下一次 hello / 派单时按配置签名同步到「鹈鹕指挥台」会话。
                // 3 秒拿不到就当失败（离线 / 宿主没开 / 公网代理卡住），由 failLoad 退回两项。
                + "var MODEL_MS=3000;"
                + "function modelJson(url,opt,ms){"
                + "var budget=ms||MODEL_MS;"
                + "return new Promise(function(resolve,reject){"
                + "var settled=false;var timer=null;var ctl=null;var req=opt||{};"
                + "function done(ok,v){if(settled){return;}settled=true;"
                + "if(timer){clearTimeout(timer);timer=null;}"
                + "if(ok){resolve(v);}else{try{if(ctl){ctl.abort();}}catch(e){}reject(v);}}"
                + "timer=setTimeout(function(){done(false,new Error('超时 '+Math.round(budget/1000)+' 秒'));},budget);"
                + "try{"
                + "var F=window.fetch||fetch;"
                + "if(window.AbortController){ctl=new window.AbortController();req={};"
                + "for(var k in (opt||{})){req[k]=opt[k];}req.signal=ctl.signal;}"
                + "F.call(window,url,req).then(function(r){"
                + "return r.text().then(function(t){"
                + "var d=null;try{d=JSON.parse(t);}catch(e){}"
                + "if(!r.ok){done(false,new Error(d&&d.error?String(d.error):('HTTP '+r.status)));return;}"
                + "if(!d){done(false,new Error('返回不是 JSON（HTTP '+r.status+'）'));return;}"
                + "done(true,d);"
                + "});}).catch(function(e){done(false,e);});"
                + "}catch(e){done(false,e);}"
                + "});}"
                + "function makeModelCard(){"
                + "var c=document.createElement('div');c.className='card ts-model';"
                // 手机端「模型设置不可用」那条补丁只放行这一张卡（见 modelSettingsNotice.ts 的 SELF_SERVICE_CARD）
                + "c.setAttribute('data-tihu-model-card','1');"
                + "var h=document.createElement('h4');h.textContent='指挥台模型';c.appendChild(h);"
                + "var note=document.createElement('div');note.className='hint';"
                + "note.textContent='「鹈鹕指挥台」那条会话（判项目、判续聊、判这一句，不占屏）用它。手机这里选的值是权威值，电脑端手动改模型不算数。';"
                + "c.appendChild(note);"
                + "var st=document.createElement('div');st.className='hint ts-model-status';st.textContent='正在读取…';c.appendChild(st);"
                + "var pick=document.createElement('select');pick.className='ts-model-pick';c.appendChild(pick);"
                + "var row=document.createElement('div');row.className='row';"
                + "var save=document.createElement('button');save.setAttribute('type','button');save.textContent='保存';"
                + "var reload=document.createElement('button');reload.setAttribute('type','button');reload.textContent='重新读取';"
                + "row.appendChild(save);row.appendChild(reload);c.appendChild(row);"
                + "var msg=document.createElement('div');msg.className='hint ts-model-msg';c.appendChild(msg);"
                + "var models=[];var saved=null;var def=null;var busy=false;var fallbackMode=false;"
                // 宿主目录形状：{ catalog: { default:{provider,model}, groups:[{ id, name, models:[{ id, name }] }] } }
                // 拍平成展示行：provider=组 id、groupName=组显示名、name=模型显示名，
                // 与电脑端模型选择器（assistant-settings.tsx 的 optgroup）同一份目录、同一套名字。
                + "function flatten(cat){"
                + "var out=[];var c=(cat&&cat.catalog)?cat.catalog:(cat||{});"
                + "var groups=(c&&c.groups)?c.groups:[];"
                + "for(var i=0;i<groups.length;i++){"
                + "var g=groups[i]||{};var pid=String(g.id||'');var gn=String(g.name||g.id||'');"
                + "var list=(g.models&&g.models.length)?g.models:[];"
                + "for(var j=0;j<list.length;j++){var m=list[j]||{};var mid=String(m.id||'');"
                + "if(!pid||!mid){continue;}"
                + "out.push({provider:pid,model:mid,name:String(m.name||mid),groupName:gn||pid});}}"
                // 兼容早期扁平结构（catalog.models），宿主降级时也不至于又变空
                + "if(!out.length&&c&&c.models&&c.models.length){"
                + "for(var k=0;k<c.models.length;k++){var f=c.models[k]||{};"
                + "if(!f.provider||!f.model){continue;}"
                + "out.push({provider:String(f.provider),model:String(f.model),"
                + "name:String(f.name||f.model),groupName:String(f.groupName||f.provider)});}}"
                + "return out;}"
                + "function stale(){"
                + "if(!saved){return false;}"
                + "for(var i=0;i<models.length;i++){"
                + "if(models[i].provider===saved.provider&&models[i].model===saved.model){return false;}}"
                + "return true;}"
                + "function render(){"
                + "while(pick.children&&pick.children.length){pick.removeChild(pick.children[0]);}"
                + "var o0=document.createElement('option');o0.value='';"
                + "o0.textContent=def?('跟随电脑端默认模型（'+def.provider+' / '+def.model+'）'):'跟随电脑端默认模型';"
                + "pick.appendChild(o0);"
                + "var hit=-1;var lastG='';var og=null;"
                + "for(var i=0;i<models.length;i++){"
                + "var gn=models[i].groupName||models[i].provider;"
                + "if(gn!==lastG){og=document.createElement('optgroup');og.label=gn;pick.appendChild(og);lastG=gn;}"
                + "var o=document.createElement('option');o.value=String(i);"
                + "o.textContent=models[i].name?String(models[i].name):String(models[i].model);"
                + "if(og){og.appendChild(o);}else{pick.appendChild(o);}"
                + "if(saved!==null&&models[i].provider===saved.provider&&models[i].model===saved.model){hit=i;}"
                + "}"
                // 当前保存值不在目录里（提供方被删/改名）：单独回显 + 明说；选它不写配置，绝不偷偷覆盖。
                + "if(saved!==null&&(hit<0||fallbackMode)){"
                + "var ox=document.createElement('option');ox.value='saved';"
                + "ox.textContent='当前：'+saved.provider+'/'+saved.model+(fallbackMode?'':'（不在列表里）');"
                + "if(o0.nextSibling){pick.insertBefore(ox,o0.nextSibling);}else{pick.appendChild(ox);}"
                + "}"
                + "pick.value=(hit<0)?(saved!==null?'saved':''):String(hit);"
                + "}"
                + "function errText(e){return (e&&e.message)?String(e.message):String(e);}"
                + "function staleNote(){"
                + "if(!saved){return '';}"
                + "return stale()?('；当前：'+saved.provider+'/'+saved.model+'（不在列表里）'):('；当前：'+saved.provider+'/'+saved.model);"
                + "}"
                // 拉不到（离线 / 3 秒超时 / 返回空）：退回原来的两项，并在面板上明说，不静默糊弄。
                // 老 WebView 没有 fetch / 页面被限制：绝不能把异常抛到 open()，否则整个设置面板打不开。
                + "function failLoad(e){"
                + "fallbackMode=true;models=[];render();save.disabled=false;"
                + "st.textContent='没拉到模型列表，先用默认'+(saved?('（当前：'+saved.provider+'/'+saved.model+'）'):'')+'：'+errText(e);"
                + "}"
                + "function load(){"
                + "msg.textContent='';st.textContent='正在读取…';save.disabled=true;fallbackMode=false;"
                + "try{"
                + "modelJson('/api/assistant/config',{cache:'no-store',credentials:'same-origin'},MODEL_MS).then(function(cfg){"
                + "var t=(cfg&&cfg.tihu&&cfg.tihu.model)?cfg.tihu.model.background:null;"
                + "saved=(t&&t.provider&&t.model)?{provider:String(t.provider),model:String(t.model)}:null;"
                + "return modelJson('/api/assistant/models',{cache:'no-store',credentials:'same-origin'},MODEL_MS);"
                + "}).then(function(cat){"
                + "var c=(cat&&cat.catalog)?cat.catalog:(cat||{});"
                + "def=(c&&c.default&&c.default.provider)?{provider:String(c.default.provider),model:String(c.default.model)}:null;"
                + "models=flatten(cat);"
                + "if(!models.length){throw new Error('模型目录是空的（宿主还没配提供方？）');}"
                + "render();"
                + "var groups=0;var last='';"
                + "for(var i=0;i<models.length;i++){var g=models[i].groupName;if(g!==last){groups++;last=g;}}"
                + "st.textContent='共 '+models.length+' 个可选模型 · '+groups+' 个提供方'+staleNote();"
                + "save.disabled=false;"
                + "}).catch(failLoad);"
                + "}catch(e){failLoad(e);}"
                + "}"
                + "function commit(){"
                + "if(busy){return;}"
                + "var v=pick.value;var job=null;"
                + "if(v===''){job={provider:'',model:''};}"
                + "else if(v==='saved'){msg.textContent=fallbackMode?"
                + "'列表没拉到，保留当前值没动；点「重新读取」再试。'"
                + ":'当前这条不在目录里，没有改动；请在下面重新选一条。';return;}"
                + "else{var m=models[Number(v)];if(!m){msg.textContent='选项失效了，请点「重新读取」';return;}"
                + "job={provider:m.provider,model:m.model};}"
                + "busy=true;save.disabled=true;msg.textContent='正在保存…';"
                + "var body={tihu:{model:{background:job.provider?{provider:job.provider,model:job.model}:null}}};"
                + "function done(){busy=false;save.disabled=false;}"
                + "function failed(e){done();msg.textContent='保存失败：'+errText(e);}"
                + "try{"
                + "modelJson('/api/assistant/config',{method:'POST',cache:'no-store',credentials:'same-origin',"
                + "headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(){"
                + "saved=job.provider?{provider:job.provider,model:job.model}:null;"
                + "if(job.provider){fallbackMode=false;}"
                + "render();done();"
                + "msg.textContent=job.provider?('已保存：'+job.provider+'/'+job.model+'（下一次派单生效）'):'已保存：跟随电脑端默认模型';"
                + "}).catch(failed);"
                + "}catch(e){failed(e);}"
                + "}"
                + "save.addEventListener('click',function(e){try{e.preventDefault();}catch(x){}commit();});"
                + "reload.addEventListener('click',function(e){try{e.preventDefault();}catch(x){}load();});"
                + "load();"
                + "return c;}"
                // 默认进入页面（1.4.0）：冷启动落在「个人助手」还是「鹈鹕」。
                // 只读写 SharedPreferences（TihuNative.startScreenValue/startScreenSet），
                // 启动时由 MainActivity.onCreate 的落地屏规则读取——改完**重启 App 才生效**。
                + "function makeStartCard(){"
                + "var c=document.createElement('div');c.className='card ts-start';"
                + "c.setAttribute('data-tihu-start-card','1');"
                + "var h=document.createElement('h4');h.textContent='默认进入页面';c.appendChild(h);"
                + "var note=document.createElement('div');note.className='hint';"
                + "note.textContent='从桌面点开 App（冷启动）先落在这一屏。屏幕右上角切屏不受影响。改完要重启 App 才生效。';"
                + "c.appendChild(note);"
                + "var st=document.createElement('div');st.className='hint ts-start-status';c.appendChild(st);"
                + "var row=document.createElement('div');row.className='row';"
                + "var bA=document.createElement('button');bA.setAttribute('type','button');"
                + "var bT=document.createElement('button');bT.setAttribute('type','button');"
                + "row.appendChild(bA);row.appendChild(bT);c.appendChild(row);"
                + "var msg=document.createElement('div');msg.className='hint ts-start-msg';c.appendChild(msg);"
                + "function startBridge(){return window.TihuNative||null;}"
                + "function startValue(){"
                + "try{var b=startBridge();if(b&&b.startScreenValue){return String(b.startScreenValue()||'');}}catch(e){}"
                + "return '';"
                + "}"
                + "function startRefresh(){"
                + "var v=startValue();"
                + "st.textContent=v==='tihu'?'当前：鹈鹕':(v==='assistant'?'当前：个人助手':'当前：未设置（跟随上次停留的屏）');"
                + "bA.textContent=(v==='assistant'?'✓ ':'')+'个人助手';"
                + "bT.textContent=(v==='tihu'?'✓ ':'')+'鹈鹕';"
                + "}"
                + "function startPick(next,label){"
                + "msg.textContent='';"
                + "try{var b=startBridge();"
                + "if(!b||!b.startScreenSet){msg.textContent='设置失败：壳还没接上（TihuNative.startScreenSet 不可用）';return;}"
                + "var r=String(b.startScreenSet(next)||'');"
                + "if(r.indexOf('ok:')!==0){msg.textContent='设置失败：这个值不被接受（只认 个人助手 / 鹈鹕）';return;}"
                + "msg.textContent='已保存：默认进入「'+label+'」，重启 App 后生效';"
                + "startRefresh();"
                + "}catch(e){msg.textContent='设置失败：'+(e&&e.message?String(e.message):String(e));}"
                + "}"
                // 点选即存（与强调色那三个按钮同一种交互）；不做「立即跳屏」——重启才生效。
                + "bA.addEventListener('click',function(e){try{e.preventDefault();}catch(x){}startPick('assistant','个人助手');});"
                + "bT.addEventListener('click',function(e){try{e.preventDefault();}catch(x){}startPick('tihu','鹈鹕');});"
                + "startRefresh();"
                + "return c;}"
                + "function buildPanel(){"
                + "if(panel){return;}"
                + "panel=document.createElement('div');panel.id='tihu-settings';panel.className='tihu-settings';"
                + "panel.addEventListener('click',function(e){if(e&&e.target===panel){close();}});"
                + "var card=document.createElement('div');card.className='ts-card';"
                + "var head=document.createElement('div');head.className='ts-head';"
                + "var title=document.createElement('div');title.className='ts-title';title.textContent='鹈鹕设置';"
                + "var themeBtn=document.createElement('button');themeBtn.className='ts-theme';"
                + "themeBtn.setAttribute('type','button');"
                + "themeBtn.textContent=(window.__tihuTheme==='dark')?'浅色':'深色';"
                + "themeBtn.addEventListener('click',function(e){try{if(e&&e.preventDefault){e.preventDefault();}}catch(x){}"
                + "var next=(window.__tihuTheme==='dark')?'light':'dark';"
                + "if(window.__tihuSetTheme){window.__tihuSetTheme(next);}"
                + "themeBtn.textContent=(next==='dark')?'浅色':'深色';"
                + "});"
                + "var btn=document.createElement('button');btn.id='tihu-settings-close';btn.className='ts-close';"
                + "btn.setAttribute('type','button');btn.textContent='关闭';"
                + "btn.addEventListener('click',function(e){try{if(e&&e.preventDefault){e.preventDefault();}}catch(x){}close();});"
                + "head.appendChild(title);head.appendChild(themeBtn);head.appendChild(btn);"
+ "var rb=document.createElement('button');rb.className='ts-reset-ball';rb.setAttribute('type','button');rb.textContent='还原悬浮球';rb.addEventListener('click',function(e){try{e.preventDefault();}catch(x){}try{if(window.TihuNative&&TihuNative.resetBall){TihuNative.resetBall();}}catch(x){}});"
                + "panelBody=document.createElement('div');panelBody.className='ts-body';panelBody.appendChild(rb);"
+ "panelBody.appendChild(makeWakeCard());"
+ "panelBody.appendChild(makeModelCard());"
+ "panelBody.appendChild(makeStartCard());"
                + "card.appendChild(head);card.appendChild(panelBody);panel.appendChild(card);"
                + "body.appendChild(panel);"
                + "}"
                + "function stash(){"
                + "moved=[];"
                + "var kids=Array.prototype.slice.call(body.children);"
                + "for(var i=0;i<kids.length;i++){"
                + "var el=kids[i];"
                + "if(!el||el===panel||el.id==='tihu-gear'){continue;}"
                + "if(el&&el.getAttribute&&el.getAttribute('data-tihu-keep')==='1'){continue;}"
                + "var tag=(el.tagName||'').toUpperCase();"
                + "if(tag==='SCRIPT'||tag==='STYLE'||tag==='LINK'){continue;}"
                + "moved.push({node:el,parent:body,index:i});"
                + "}"
                + "var inner=Array.prototype.slice.call(holder.children);"
                + "for(var k=0;k<inner.length;k++){"
                + "var t=inner[k];"
                + "if((String(t.className||'')+' ').indexOf('screen-tools')>=0){moved.push({node:t,parent:holder,index:-1});break;}"
                + "}"
                + "}"
                + "function putBack(rec){try{"
                + "if(rec.index>=0){body.insertBefore(rec.node,body.children[rec.index]||null);}"
                + "else{rec.parent.appendChild(rec.node);}"
                + "}catch(e){}}"
                + "function open(){"
                + "if(opened){return;}"
                + "buildPanel();stash();"
                + "for(var i=0;i<moved.length;i++){panelBody.appendChild(moved[i].node);}"
                + "panel.classList.add('open');"
+ "try{if(window.__tihuWakeRefresh){window.__tihuWakeRefresh();}}catch(e){}"
+ "try{if(window.__tihuWakeScoreStart){window.__tihuWakeScoreStart();}}catch(e){}"
                + "try{body.style.overflow='hidden';}catch(e){}"
                + "opened=true;"
                + "try{if(window.TihuNative&&TihuNative.panelOpen){TihuNative.panelOpen('1');}}catch(e){}"
                + "}"
                + "function close(){"
                + "if(!opened){return;}"
                + "for(var i=0;i<moved.length;i++){putBack(moved[i]);}"
                + "moved=[];"
                + "if(panel&&panel.classList){panel.classList.remove('open');}"
                + "try{if(window.__tihuWakeScoreStop){window.__tihuWakeScoreStop();}}catch(e){}"
                + "try{body.style.overflow='';}catch(e){}"
                + "opened=false;"
                + "try{if(window.TihuNative&&TihuNative.panelOpen){TihuNative.panelOpen('0');}}catch(e){}"
                + "}"
                // 1.1.2：齿轮不再注入页面 —— 它现在挂在**原生音量条最右端**，
                // 点击走 window.__tihuPanel.open()。这里只保留开/关入口。
                + "if(!window.__tihuPanelResize){"
                + "window.__tihuPanelResize=true;"
                + "window.addEventListener('resize',function(){try{"
                + "var w=document.documentElement.clientWidth||window.innerWidth||0;"
                + "if(w>700&&opened){close();}"
                + "}catch(e){}});"
                + "}"
                + "window.__tihuPanel={ready:true,open:open,close:close,isOpen:function(){return opened;},"
                + "movedCount:function(){return moved.length;}};"
                + "return 'ok';"
                + "}catch(e){return 'err:'+e;}})()";
    }

    /**
     * 鹈鹕朗读音量（1.1.1）：给 AudioNode.prototype.connect 打补丁，
     * 凡是连到「该 AudioContext 的 destination」的连接，一律改接到每个 context 一枚的
     * masterGain 上（masterGain → destination）。这样只影响页面里的 WebAudio 播放
     * （TTS 的 PCM 与试听提示音都走 ctx.destination），完全不碰系统媒体音量。
     *
     * - 每个 context 一枚 gain，用数组当 Map（老 WebView 上没有 Map 也能跑）；
     * - 补丁打在原型上，页面之后新建/重建的 AudioContext 也会自动挂上；
     * - 音量用 setTargetAtTime(…, 0.05) 平滑 50ms，避免爆音；
     * - 值写进 localStorage（tihu.voiceVolume），页面内部重建后自己恢复；
     * - 页面一个 AudioContext 都还没有时也先记下目标值，等播放时（ensure 里）就用它。
     * - 原生侧只调用 window.__tihuSetVolume(0..1)，绝不调用 AudioManager。
     */
    public static String volumeJs() {
        return "(function(){try{"
                + "if(window.__tihuVolume&&window.__tihuVolume.ready){return 'ok';}"
                + "var KEY='tihu.voiceVolume';"
                + "var target=1;"
                + "try{var raw=window.localStorage?window.localStorage.getItem(KEY):null;"
                + "if(raw!==null&&raw!==''){var n0=Number(raw);if(isFinite(n0)&&n0>=0&&n0<=1){target=n0;}}}catch(e){}"
                + "var gains=[];"
                + "var origConnect=null;"
                + "function findGain(ctx){for(var i=0;i<gains.length;i++){if(gains[i].ctx===ctx){return gains[i].gain;}}return null;}"
                + "function ensure(ctx){"
                + "var g=findGain(ctx);if(g){return g;}"
                + "try{g=ctx.createGain();}catch(e){return null;}"
                + "try{g.__tihuMaster=true;}catch(e){}"
                + "try{g.gain.value=target;}catch(e){}"
                + "gains.push({ctx:ctx,gain:g});"
                + "try{origConnect.call(g,ctx.destination);}catch(e){}"
                + "return g;"
                + "}"
                + "function apply(v){"
                + "target=v;"
                + "try{if(window.localStorage){window.localStorage.setItem(KEY,String(v));}}catch(e){}"
                + "for(var i=0;i<gains.length;i++){"
                + "var g=gains[i].gain;"
                + "try{"
                + "var p=g.gain;"
                + "if(p&&p.setTargetAtTime){p.setTargetAtTime(v,(g.context&&g.context.currentTime)||0,0.05);}"
                + "else if(p){p.value=v;}"
                + "}catch(e){try{g.gain.value=v;}catch(x){}}"
                + "}"
                + "}"
                + "var AC=window.AudioContext||window.webkitAudioContext;"
                + "var proto=window.AudioNode?window.AudioNode.prototype:null;"
                + "if(proto&&!proto.__tihuPatched){"
                + "origConnect=proto.connect;"
                + "proto.connect=function(dest){"
                + "try{"
                + "if(!this.__tihuMaster&&this.context&&dest===this.context.destination){"
                + "var g=ensure(this.context);"
                + "if(g){"
                + "var args=Array.prototype.slice.call(arguments);"
                + "args[0]=g;"
                + "return origConnect.apply(this,args);"
                + "}"
                + "}"
                + "}catch(e){}"
                + "return origConnect.apply(this,arguments);"
                + "};"
                + "proto.__tihuPatched=true;"
                + "}"
                + "window.__tihuSetVolume=function(v){"
                + "var n=Number(v);if(!isFinite(n)){return;}"
                + "n=n<0?0:(n>1?1:n);"
                + "try{apply(n);}catch(e){}"
                + "};"
                + "window.__tihuVolume={ready:true,get:function(){return target;},apply:apply,"
                + "gainFor:function(ctx){return findGain(ctx);},contexts:function(){return gains.length;}};"
                + "return proto?'ok':'no-audionode';"
                + "}catch(e){return 'err:'+e;}})()";
    }
}
