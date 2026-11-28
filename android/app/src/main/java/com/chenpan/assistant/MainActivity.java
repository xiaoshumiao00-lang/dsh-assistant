package com.chenpan.assistant;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;

/**
 * 个人助手（dsh-assistant 手机/平板端外壳）。
 *
 * 一块屏：电脑上的 DSH 助手页面（同一份 HTML/CSS/JS、同一个会话、同一套插件）。
 * 模拟设备屏那条线连同它的录音按钮 / 本地唤醒 / 音量条 / 悬浮切屏球，已在 1.4.3–1.4.4 一并移除。
 *
 * 自适应（手机 / 折叠屏 / 平板）：
 *   1. 不锁方向、resizeableActivity，Activity 自己吞掉配置变化（configChanges），
 *      折叠、展开、分屏、转屏都不重建 WebView，不白屏重载；
 *   2. WebView 打开 useWideViewPort、关掉 loadWithOverviewMode，页面按自己的 viewport 排版。
 */
public class MainActivity extends Activity {

    /**
     * 助手地址：通用版留空（首次打开进设置页自己填）。
     * 构建脚本 build.ps1 会按 flavor 覆盖这一行；这个源文件默认就是通用版的空值。
     */
    private static final String DEFAULT_URL = "";

    /**
     * 设置页「一键填入常用地址」用的常用值。
     * 1.4.9 起这里不预置任何真实地址（上架壳不许带作者本机入口），留空 = 必须自己填。
     */
    private static final String COMMON_ASSISTANT_URL = "";

    private static final String PREFS = "dsh_assistant";
    private static final String KEY_URL = "home_url";

    // 原生配色（状态栏 / 导航栏）
    private static final int L_BG = 0xFFF7F8FA;
    private static final int L_CARD = 0xFFFFFFFF;

    /** 桌面快捷方式「设置地址」带过来的标记。 */
    private static final String EXTRA_SETTINGS = "open_settings";

    private static final int REQ_FILE = 1001;
    private static final int REQ_PERM = 1002;
    private static final int REQ_NOTIF = 1003;

    private static final int BG = 0xFF0F1115;
    private static final int CARD = 0xFF161A21;
    private static final int TEXT = 0xFFE6E8EB;
    private static final int DIM = 0xFF8A9099;
    private static final int ACCENT = 0xFF3B82F6;

    private SharedPreferences prefs;
    private FrameLayout root;
    /** 承载助手 WebView 的容器。 */
    private FrameLayout screenHost;
    private WebView web;

    private View setupView;
    private View errorView;
    private TextView errorDetail;

    /** 首屏等待层：弱网/隧道下十几秒的黑屏会让用户以为点不动，这里要看得见在等。 */
    private View loadingView;
    private TextView loadingText;
    private int loadingSeconds;

    private android.webkit.ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;

    /** DSH 重启后旧会话 cookie 失效的自愈计数（见 recoverAuth）。 */
    private int authRecoveries;
    private boolean authRecovering;

    /** 设置页「后台保活」区块的两个按钮（onResume 刷新状态文案）。 */
    private Button keepAliveToggle;
    private Button batteryWhitelist;

    /** 设置页「检查更新」区块（1.4.10）：版本行 + 开关 + 源输入 + 状态行 + 忽略这版的恢复按钮。 */
    private TextView versionRow;
    private Button updateCheckToggle;
    private EditText updateSourceInput;
    private Button updateSourceSave;
    private Button updateCheckRun;
    private TextView updateStatusRow;
    private Button updateSkipClear;
    /** 后台查询进行中标志（一次只允许在飞一条请求，重复点不叠加）。 */
    private boolean updateChecking;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable backLongPress;
    private boolean backLongFired;
    private long lastBackAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);

        screenHost = new FrameLayout(this);
        screenHost.setBackgroundColor(BG);
        root.addView(screenHost, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        web = buildWebView();
        screenHost.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        String saved = prefs.getString(KEY_URL, "");
        boolean firstRun = TextUtils.isEmpty(saved);
        // 预置了地址的版本（自己的那台电脑）首次打开直接进页面；
        // 通用版 DEFAULT_URL 为空 → 首次打开先让用户填地址，填过一次以后就不再问。
        if (firstRun && !TextUtils.isEmpty(DEFAULT_URL)) {
            saved = DEFAULT_URL;
            prefs.edit().putString(KEY_URL, saved).apply();
        }
        // 落地规则（1.4.3 单屏）：有地址直接进页面，没地址进设置页（绝不白屏）。
        if (TextUtils.isEmpty(saved)) {
            showSetup(false);
        } else {
            web.loadUrl(saved);
        }
        if (firstRun) {
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    toast("地址已记住，之后打开直接进这个地址");
                }
            }, 2500);
        }

        // 桌面图标长按 →「设置地址」快捷方式（全面屏手势的手机没有返回键可长按）
        Intent intent = getIntent();
        if (intent != null && intent.getIntExtra(EXTRA_SETTINGS, 0) == 1) {
            intent.removeExtra(EXTRA_SETTINGS);
            showSetup(true);
        }

        // 2026-11-27 后台保活：Android 13+ 通知是运行时权限（常驻通知/任务完成通知都要它）；
        // 前台服务把进程钉在高优先级，切后台 WebView 里的 WebSocket 才不会被省电策略冻结。
        ensureNotificationPermission();
        KeepAliveService.start(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getIntExtra(EXTRA_SETTINGS, 0) == 1) {
            intent.removeExtra(EXTRA_SETTINGS);
            showSetup(true);
        }
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint({"SetJavaScriptEnabled"})
    private WebView buildWebView() {
        WebView w = new WebView(this);
        w.setBackgroundColor(BG);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadsImagesAutomatically(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // 页面自己负责排版：禁止双指缩放与「整页缩小以适配」，
        // 但保留 viewport meta 生效（useWideViewPort + 不改 overview）。
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NORMAL);
        s.setDefaultTextEncodingName("UTF-8");
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(w, true);

        w.setWebViewClient(new AppClient());
        w.setWebChromeClient(new AppChrome());

        // JS 桥（2026-11-27 后台播报）：页面在后台收到任务完成时，经它发系统通知、
        // 用原生 TextToSpeech 播报（后台 WebAudio 被挂起，页面那套微软 TTS 不可靠）。
        // 挂在 buildWebView 里：渲染进程被杀重建（recoverWebView）后桥自动还在。
        w.addJavascriptInterface(new NativeBridge(this), "DshAssistantNative");

        w.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                startDownload(url, contentDisposition, mimeType);
            }
        });

        return w;
    }

    /** 渲染进程被杀之后重建一块 WebView（不碰 cookie 与 localStorage，等同于浏览器刷新一次）。 */
    private void recoverWebView() {
        if (web != null) {
            try {
                screenHost.removeView(web);
                web.setWebChromeClient(null);
                web.setWebViewClient(null);
                web.destroy();
            } catch (Throwable ignored) {
                // 进程已经没了，销毁失败无所谓
            }
            web = null;
        }
        web = buildWebView();
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        screenHost.addView(web, 0, lp);

        String saved = prefs.getString(KEY_URL, DEFAULT_URL);
        String base = originOf(saved);
        web.loadUrl(base.isEmpty() ? saved : base + "/");
    }

    /**
     * 登录态自愈：清掉上一轮遗留的 dsh-auth-* cookie，再带 ?dsh-pocket-auth=1 强制重做一次握手。
     * 连清三次还不行就整包清 cookie（用户重新输一次访问密码），再不行交给错误页。
     */
    private void recoverAuth() {
        if (authRecovering) return;
        String base = originOf(prefs.getString(KEY_URL, ""));
        if (base.isEmpty()) return;
        if (authRecoveries >= 4) {
            showError("登录状态一直对不上，请点「改地址」重新确认一次地址和密码");
            return;
        }
        authRecovering = true;
        authRecoveries++;
        CookieManager cm = CookieManager.getInstance();
        if (authRecoveries >= 3) {
            cm.removeAllCookies(null);
            } else {
            clearAuthCookies(cm, base);
        }
        cm.flush();
        web.loadUrl(base + "/?dsh-pocket-auth=1&dsh-pocket-retry=1");
    }

    /** 只删 dsh-auth-* 这几个（新版 DSH 的浏览器会话 cookie），保留访问密码那份 cookie。 */
    private void clearAuthCookies(CookieManager cm, String base) {
        try {
            String cookies = cm.getCookie(base);
            if (cookies == null) return;
            for (String part : cookies.split(";")) {
                int eq = part.indexOf('=');
                if (eq <= 0) continue;
                String name = part.substring(0, eq).trim();
                if (name.startsWith("dsh-auth-")) {
                    cm.setCookie(base, name + "=; Max-Age=0; Path=/");
                }
            }
        } catch (Throwable ignored) {
            // 清不掉就等下一次（第三次会整包清）
        }
    }

    /** http(s)://host[:port]，去掉路径与参数。 */
    private String originOf(String url) {
        if (TextUtils.isEmpty(url)) return "";
        Uri u = Uri.parse(url);
        if (u.getHost() == null || u.getHost().isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        sb.append(u.getScheme() == null ? "http" : u.getScheme()).append("://").append(u.getHost());
        if (u.getPort() > 0) sb.append(':').append(u.getPort());
        return sb.toString();
    }

    private class AppClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // 弱网（尤其是走公网隧道）时首屏要等十几秒，以前这段时间是纯黑屏，
            // 看起来像卡死/点不动。给一个带秒数和「改地址」的过渡层，让等待可见、可退出。
            showLoading();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return route(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return route(Uri.parse(url));
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            hideLoading();
            hideError();
            // DSH 重启后端口会变，但 WebView 里的 dsh-auth-* cookie 不区分端口，仍然会被发出去；
            // 代理见 cookie 已存在就不再补 launch token，上游于是回一段纯文本
            // "dsh web authentication required"。这里识别出来自动清掉旧 cookie 并强制重握手，
            // 用户不用清数据/重装。
            view.evaluateJavascript(
                    "(function(){try{var t=(document.body&&document.body.innerText||'').slice(0,400);"
                            + "return t.indexOf('authentication required')>=0?'auth':'ok'}catch(e){return 'ok'}})()",
                    new android.webkit.ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if (value != null && value.contains("auth")) {
                                recoverAuth();
                            } else {
                                authRecovering = false;
                                authRecoveries = 0;
                            }
                        }
                    });
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceResponse errorResponse) {
            if (request != null && request.isForMainFrame() && errorResponse != null
                    && errorResponse.getStatusCode() == 401) {
                recoverAuth();
            }
        }

        /**
         * 渲染进程被系统杀掉（长会话页面在手机上吃掉太多内存时会发生）。
         * 默认行为是连整个应用一起闪退，这里改成重建一块 WebView 回到首页继续用，
         * 效果等于浏览器里刷新一次。
         */
        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            recoverWebView();
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                String d = error == null ? "" : String.valueOf(error.getDescription());
                showError(d);
            }
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                showError(description == null ? "" : description);
            }
        }
    }

    /** http/https 一律留在应用内（同一个界面、同一套 cookie）；其他 scheme 交给系统。 */
    private boolean route(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if ("http".equals(scheme) || "https".equals(scheme) || "about".equals(scheme)) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            toast("这台设备打不开这个链接");
        }
        return true;
    }

    private class AppChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view,
                                         android.webkit.ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;

            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            try {
                String[] accept = params == null ? null : params.getAcceptTypes();
                if (accept != null) {
                    String first = null;
                    for (String a : accept) {
                        if (a != null && a.contains("/") && !a.contains(",")) {
                            first = a.trim();
                            break;
                        }
                    }
                    if (first != null && first.length() > 0) {
                        intent.setType(first);
                    }
                }
                if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                toast("这台设备没有文件选择器");
                return false;
            }
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            boolean audio = false;
            boolean video = false;
            for (String r : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) video = true;
            }
            if (!audio && !video) {
                request.deny();
                return;
            }
            String need = audio ? Manifest.permission.RECORD_AUDIO : Manifest.permission.CAMERA;
            if (checkSelfPermission(need) == PackageManager.PERMISSION_GRANTED) {
                request.grant(request.getResources());
            } else {
                pendingPermission = request;
                requestPermissions(new String[]{need}, REQ_PERM);
            }
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                                                       android.webkit.GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERM && pendingPermission != null) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (ok) pendingPermission.grant(pendingPermission.getResources());
            else pendingPermission.deny();
            pendingPermission = null;
            return;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE) return;
        if (fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) {
                    result[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ---------------------------------------------------------------- 下载

    /**
     * 秘书回复卡的附件（docx 等）点开后落到这里。
     *
     * 2026-11-26 真机 bug「点了 Word 之后通知栏一直正在下载、既打不开也看不到」的根因：
     * DownloadManager 是**系统下载器**，它不会继承 WebView 的 cookie 罐；而本机 pocket 代理
     * （转发到 DSH 3081）对没有凭证的请求一律回 401。离线实测（同一份 1,605,373 字节的 docx、
     * 同一个入口＝作者自己电脑上的助手入口地址 + /api/worktable/file，源码里不再写死这条地址）：
     *   不带 cookie → HTTP/1.1 401、body `{"error":"unauthorized"}`（24 字节、chunked、**无 content-length**）；
     *   带上 pocket 凭证（`?token=` 与 `dsh_pocket_token` cookie 同一道闸）→ 200 + content-length: 1605373 + 完整 1,605,373 字节。
     * 401 既没有内容长度、又是 chunked + keep-alive，下载器拿不到大小也没处可写，通知栏就停在 0% 不动。
     * 所以这里必须把 CookieManager 里该 URL 的 cookie 原样塞进下载请求。
     */
    @SuppressWarnings("deprecation")
    private void startDownload(String url, String contentDisposition, String mimeType) {
        String name = "";
        try {
            name = fileNameFor(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            // 唯一必需的一条：没有它代理层直接 401，下载永远到不了 100%
            String cookies = CookieManager.getInstance().getCookie(url);
            if (!TextUtils.isEmpty(cookies)) {
                req.addRequestHeader("Cookie", cookies);
                req.addRequestHeader("Referer", originOf(url) + "/");
            }
            // UA 也照搬 WebView 的：pocket 代理按 UA 判「手机首屏」，系统下载器的默认 UA 不是它
            if (web != null) {
                String ua = web.getSettings().getUserAgentString();
                if (!TextUtils.isEmpty(ua)) req.addRequestHeader("User-Agent", ua);
            }
            if (!TextUtils.isEmpty(mimeType) && !"application/octet-stream".equalsIgnoreCase(mimeType)) {
                req.setMimeType(mimeType);
            }
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setVisibleInDownloadsUi(true);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("没有 DownloadManager");
            watchDownload(dm.enqueue(req), name);
        } catch (Throwable t) {
            // 逐字说明为什么没起来：旧文案「这个文件要到电脑上下载」把真因（鉴权/空间/文件名）全盖住了
            String why = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
            toast("下载没起来：" + why + "\n文件：" + name);
        }
    }

    /**
     * 下载落盘用的文件名：优先 RFC 5987 的 `filename*=UTF-8''…`，其次退回 URLUtil.guessFileName。
     *
     * 为什么不能直接信 guessFileName：它只认 `filename=`，而宿主同时给了 ASCII 兜底
     * `filename="___________2026-2027-1 _____-_______.docx"`（实测响应头就是这样），
     * 于是中文名会被一串下划线顶掉——文件下到「下载」里也认不出来。
     */
    private String fileNameFor(String url, String contentDisposition, String mimeType) {
        String fallback = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
        try {
            if (contentDisposition != null) {
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("filename\\*\\s*=\\s*UTF-8''([^;]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
                        .matcher(contentDisposition);
                if (m.find()) {
                    String decoded = java.net.URLDecoder.decode(m.group(1).trim(), "UTF-8");
                    // 落盘名不许带路径分隔符（否则 setDestinationInExternalPublicDir 会抛异常，下载直接起不来）
                    String safe = decoded.replace('\\', '_').replace('/', '_').replace(':', '_').trim();
                    if (!safe.isEmpty()) return safe;
                }
            }
        } catch (Throwable ignored) {
            // 解析失败就用 guessFileName 的兜底名，绝不因此让下载失败
        }
        return TextUtils.isEmpty(fallback) ? "download" : fallback;
    }

    /** 正在等结果的那次下载（只认自己 enqueue 的 id，别去吵系统里别人的下载）。 */
    private long pendingDownloadId = -1;
    private String pendingDownloadName = "";
    private BroadcastReceiver downloadReceiver;

    /**
     * 下载结果回调。此前失败只留在系统通知里（而且卡在「正在下载」），用户既没有文件也没有错误原因；
     * 现在成功/失败都会给一句看得见的话。
     */
    private void watchDownload(long id, String name) {
        pendingDownloadId = id;
        pendingDownloadName = name;
        if (downloadReceiver != null) return;
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
                long done = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (done != pendingDownloadId) return;
                reportDownload(done, pendingDownloadName);
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(r, filter);
            }
            downloadReceiver = r;
        } catch (Throwable ignored) {
            // 注册不上只是少一句提示，不影响下载本身
        }
    }

    private void reportDownload(long id, String name) {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return;
        int status = -1;
        int reason = -1;
        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(id));
            if (c != null && c.moveToFirst()) {
                status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
        }
        if (status == DownloadManager.STATUS_SUCCESSFUL) {
            // 2026-11-27 需求「不只是图片，所有附件（apk/docx/pdf/zip/音频/图片…）都通过下载实现」：
            // 下载完成后按 MIME 分流拉起系统应用——
            //   图片 → 系统看图；apk → 系统安装界面；pdf/office/txt/音频 → ACTION_VIEW 交给对应应用；
            //   zip 等没有默认应用的类型 → 保持通知 + toast，绝不把异常抛给广播回调。
            String mime = downloadMime(id, name);
            if (isImageDownload(id, name)) {
                if (openDownloadedFile(id, name, mime.startsWith("image/") ? mime : "image/*")) {
                    toast("已下载到「下载」并用看图应用打开：" + name);
                } else {
                    toast("已下载到「下载」：" + name + "\n没找到能看图的应用，点通知栏那条打开");
                }
            } else if (APK_MIME.equalsIgnoreCase(mime)) {
                // apk：MIME 必须钉死 application/vnd.android.package-archive，系统包安装器才接得住
                if (openDownloadedFile(id, name, APK_MIME)) {
                    toast("已下载到「下载」，正在打开安装界面：" + name);
                } else {
                    toast("已下载到「下载」：" + name + "\n安装界面拉不起来，请在文件管理器里点它安装");
                }
            } else if (isDirectOpenableMime(mime)) {
                // pdf / office / txt / 音频：交给系统里对应的应用（WPS、阅读器、播放器等）
                if (openDownloadedFile(id, name, mime)) {
                    toast("已下载到「下载」并尝试打开：" + name);
                } else {
                    toast("已下载到「下载」：" + name + "\n没找到能打开它的应用，请在文件管理器中打开");
                }
            } else {
                // zip 等没有默认应用的类型：保持通知 + toast，不抛异常
                toast("已下载到「下载」：" + name + "\n点通知栏那条可以直接打开");
            }
        } else {
            toast("下载失败（" + downloadFailureText(status, reason) + "）\n" + name);
        }
    }

    /** apk 的 MIME：服务端 content-type、系统下载器记录、安装意图三处都必须用它。 */
    private static final String APK_MIME = "application/vnd.android.package-archive";

    /**
     * 这次下载的 MIME：先查系统下载器记的服务端 content-type；是空或 octet-stream 时按落盘名
     * 扩展名推断（MimeTypeMap 在部分机型上缺 apk/OOXML 的项，所以这几类先查小表兜底）。
     */
    private String downloadMime(long id, String name) {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm != null) {
            try {
                String mime = dm.getMimeTypeForDownloadedFile(id);
                if (!TextUtils.isEmpty(mime) && !"application/octet-stream".equalsIgnoreCase(mime)) return mime;
            } catch (Throwable ignored) {
                // 查询失败就靠扩展名兜底
            }
        }
        String ext = "";
        int dot = name == null ? -1 : name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) ext = name.substring(dot + 1).toLowerCase();
        // 分流的关键类型先查小表：机型上的 MimeTypeMap 缺项时不能落成 octet-stream
        if ("apk".equals(ext)) return APK_MIME;
        if ("pdf".equals(ext)) return "application/pdf";
        if ("doc".equals(ext)) return "application/msword";
        if ("docx".equals(ext)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if ("xls".equals(ext)) return "application/vnd.ms-excel";
        if ("xlsx".equals(ext)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if ("ppt".equals(ext)) return "application/vnd.ms-powerpoint";
        if ("pptx".equals(ext)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        String guessed = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return TextUtils.isEmpty(guessed) ? "application/octet-stream" : guessed;
    }

    /**
     * 这几类 MIME 大概率有系统应用能直接打开（图片已在上面分流）：pdf / office / 文本 / 音频。
     * zip、未知二进制不在这里——它们没有默认应用，保持通知 + toast。
     */
    private boolean isDirectOpenableMime(String mime) {
        if (TextUtils.isEmpty(mime)) return false;
        String m = mime.toLowerCase();
        if (m.startsWith("audio/") || m.startsWith("text/")) return true;
        if ("application/pdf".equals(m)) return true;
        if ("application/msword".equals(m) || "application/vnd.ms-excel".equals(m)
                || "application/vnd.ms-powerpoint".equals(m)) return true;
        return m.startsWith("application/vnd.openxmlformats-officedocument.");
    }

    /** 这次下载是不是图片：先看系统下载器记的 MIME，再看落盘名扩展名（服务端 content-type 与文件名总有一个对得上）。 */
    private boolean isImageDownload(long id, String name) {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm != null) {
            try {
                String mime = dm.getMimeTypeForDownloadedFile(id);
                if (mime != null && mime.toLowerCase().startsWith("image/")) return true;
            } catch (Throwable ignored) {
                // 查询失败就靠扩展名兜底
            }
        }
        String lower = name == null ? "" : name.toLowerCase();
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                || lower.endsWith(".gif") || lower.endsWith(".webp") || lower.endsWith(".bmp")
                || lower.endsWith(".svg");
    }

    /**
     * 用系统应用打开刚下好的附件（图片看图 / pdf·office·txt·音频 / apk 弹安装界面）；
     * 返回 false 表示没拉起来（调用方退回 toast 提示，绝不把异常抛给广播回调）。
     *
     * 必须拿 DownloadManager 的 content:// Uri（getUriForDownloadedFile）发 ACTION_VIEW：
     * 直接发 file:// 在 Android 7+ 会抛 FileUriExposedException；content Uri 加
     * FLAG_GRANT_READ_URI_PERMISSION 把这一条记录的读权限临时授给目标应用，不需要 FileProvider。
     * apk 走同一条路：content Uri + application/vnd.android.package-archive → 系统包安装器。
     */
    private boolean openDownloadedFile(long id, String name, String mime) {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return false;
        Uri uri = null;
        try {
            uri = dm.getUriForDownloadedFile(id);
        } catch (Throwable ignored) {
        }
        if (uri == null) return false;
        if (TextUtils.isEmpty(mime)) mime = "application/octet-stream";
        try {
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, mime);
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(view);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        } catch (Throwable t) {
            return false;
        }
    }

    /** DownloadManager 的状态/原因码 → 人话（只翻这条链路上真会遇到的几种）。 */
    private String downloadFailureText(int status, int reason) {
        if (status == DownloadManager.STATUS_PAUSED) {
            return "等待网络，已暂停（code " + reason + "）";
        }
        if (status != DownloadManager.STATUS_FAILED) return "状态 " + status;
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return "手机空间不足";
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
                return "传输中断";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                return "服务器回了错误状态（多半是登录态没带上，回页面重开一次）";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
                return "跳转太多次";
            case DownloadManager.ERROR_CANNOT_RESUME:
                return "不能续传";
            case DownloadManager.ERROR_FILE_ERROR:
                return "写文件失败";
            case DownloadManager.ERROR_UNKNOWN:
                return "原因不明";
            default:
                return "系统下载器报错 code " + reason;
        }
    }

    // ---------------------------------------------------- 1.4.10 检查更新入口

    /**
     * 用户主动按「检查更新」（后菜单第 4 项 / 设置页按钮）才走到这里。
     * 关闭态、源空态都在 UpdateCheck 里当场返回，不发请求；这里也只在这一次点按里发 1 次。
     * 请求跑在后台线程：主线程只负责提示与弹窗，UI 不会被网络卡住。
     */
    private void startUpdateCheck() {
        if (updateChecking) {
            toast("上一次检查还在跑，先等它结束（不会叠加第二次请求）");
            return;
        }
        if (!UpdateCheck.isEnabled(this)) {
            toast("更新检查是关闭的（默认就关）：先在这个应用的设置页开开关并填你自己的 owner/repo，再点检查更新");
            return;
        }
        if (TextUtils.isEmpty(UpdateCheck.trimSource(UpdateCheck.source(this)))) {
            toast("更新源还空着：填「你的GitHub账号名/仓库名」才会去查，空着就是不联网");
            return;
        }
        updateChecking = true;
        toast("正在检查更新：只连 " + UpdateCheck.ALLOWED_API_HOST + "，一次只发 1 个请求，查完就停，不会后台自动查");
        new Thread(new Runnable() {
            @Override
            public void run() {
                UpdateCheck.Result result = null;
                String fatal = "";
                try {
                    result = UpdateCheck.check(MainActivity.this, System.currentTimeMillis());
                } catch (Throwable t) {
                    fatal = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                }
                final UpdateCheck.Result delivered = result;
                final String deliveredFatal = fatal;
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        updateChecking = false;
                        showUpdateResult(delivered, deliveredFatal);
                    }
                });
            }
        }, "dsh-update-check").start();
    }

    /** 结果照实说：失败就是失败，绝不说成「已经是最新版」；有新版本才给「下载并安装」。 */
    private void showUpdateResult(UpdateCheck.Result r, String fatal) {
        if (r == null) {
            toast("检查更新没跑起来：" + (TextUtils.isEmpty(fatal) ? "未知原因" : fatal)
                    + "\n（这次没当成「没有新版本」，可以过一忽再点一次）");
            refreshUpdateRows();
            return;
        }
        boolean installable = !TextUtils.isEmpty(r.latest) && !TextUtils.isEmpty(r.apkUrl);
        if (UpdateCheck.RESULT_NEW.equals(r.status)
                || (UpdateCheck.RESULT_THROTTLED.equals(r.status) && installable)) {
            promptInstallUpdate(r);
        } else {
            toast(r.message);
        }
        refreshUpdateRows();
    }

    /** 有新版本才弹这个窗：主按钮「下载并安装」，副按钮「这版不装」（skipVersion 持久化）。 */
    private void promptInstallUpdate(final UpdateCheck.Result r) {
        String head = UpdateCheck.RESULT_THROTTLED.equals(r.status)
                ? "发现新版本 " + r.latest + "（这一次没联网，用的是 24 小时内查到的结果）"
                : "发现新版本 " + r.latest;
        String note = TextUtils.isEmpty(r.notes) ? "" : ("\n\n更新说明：\n" + r.notes);
        new AlertDialog.Builder(this)
                .setTitle("检查更新")
                .setMessage(head + "\n本机版本：" + (TextUtils.isEmpty(r.localVersion) ? "读不到" : r.localVersion)
                        + "\n装新版要在系统弹出的安装界面里点「安装」确认（本应用没法自己静默装）。" + note)
                .setPositiveButton("下载并安装", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        tryInstallUpdate(r.latest, r.apkUrl, r.apkName);
                    }
                })
                .setNegativeButton("这版不装", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        UpdateCheck.setSkipVersion(MainActivity.this, r.latest);
                        toast("已记下「这版不装」：v " + r.latest + " 不再提示（要恢复就去设置页清掉这条忽略）");
                        refreshUpdateRows();
                    }
                })
                .setNeutralButton("先不弄", null)
                .show();
    }

    /** Android 8+ 装应用要先允许「安装未知应用」；没允许就先说清、只给跳系统设置页的入口（绝不自动授权）。 */
    private boolean installAlreadyPermitted() {
        if (Build.VERSION.SDK_INT < 26) return true;
        try {
            return getPackageManager().canRequestPackageInstalls();
        } catch (Throwable t) {
            return false;
        }
    }

    private void tryInstallUpdate(final String tag, final String apkUrl, final String assetName) {
        if (!installAlreadyPermitted()) {
            new AlertDialog.Builder(this)
                    .setTitle("要装新版，先允许这个应用装应用")
                    .setMessage("这台手机还没允许「个人助手」安装应用。\n"
                            + "点「去设置」打开系统里的「安装未知应用」，把它允许；回到这里再点一次「下载并安装」。\n"
                            + "点「只下载」也行：新版会落到系统「下载」里，你在下载通知或文件管理器里点它一样能装。")
                    .setPositiveButton("去设置", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            try {
                                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                                intent.setData(Uri.parse("package:" + getPackageName()));
                                startActivity(intent);
                            } catch (Throwable t) {
                                toast("这台设备没有这个系统设置页：去系统设置里搜「安装未知应用」");
                            }
                        }
                    })
                    .setNegativeButton("只下载", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            startUpdateDownload(tag, apkUrl, assetName);
                        }
                    })
                    .setNeutralButton("取消", null)
                    .show();
            return;
        }
        startUpdateDownload(tag, apkUrl, assetName);
    }

    /**
     * 下载这条复用 1.4.4 起的系统原生下载链路（DownloadManager.enqueue + 可见下载队列 + 完成通知），
     * 完成以后走既有 reportDownload 的 apk 分流：content:// + ACTION_VIEW + 读权限临时授权 → 系统安装界面。
     * 这里不往下载请求里塞 WebView 的 cookie：GitHub 的公开 release 不需要登录态，
     * 把助手入口的访问密码 cookie 顺手发给 GitHub 纯属泄漏。
     */
    @SuppressWarnings("deprecation")
    private void startUpdateDownload(String tag, String url, String assetName) {
        if (!UpdateCheck.isDownloadUrlAllowed(url, UpdateCheck.source(this))) {
            toast("这个下载地址不合格：只许 https、只许同一个更新源（你自己的 owner/repo）下面的 .apk。已拒绝下载");
            return;
        }
        String name = updateDownloadName(url, assetName, tag);
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType(APK_MIME);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setVisibleInDownloadsUi(true);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("没有 DownloadManager");
            watchDownload(dm.enqueue(req), name);
            toast("正在下载 v" + tag + "（系统「下载」通知里有进度）；下载完会自动弹系统安装界面");
        } catch (Throwable t) {
            String why = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
            toast("下载没起来：" + why + "\n文件：" + name);
        }
    }

    /** 落盘名：优先 GitHub 资产名，其次按 tag 拼一个；一律去掉路径分隔符（防止下载直接起不来）。 */
    private String updateDownloadName(String url, String assetName, String tag) {
        String raw = TextUtils.isEmpty(assetName) ? "" : assetName;
        if (TextUtils.isEmpty(raw) && !TextUtils.isEmpty(url)) {
            String path = Uri.parse(url).getPath();
            if (!TextUtils.isEmpty(path)) {
                int slash = path.lastIndexOf('/');
                raw = slash >= 0 ? path.substring(slash + 1) : path;
            }
        }
        if (TextUtils.isEmpty(raw)) {
            raw = "assistant-" + (TextUtils.isEmpty(tag) ? "update" : tag) + ".apk";
        }
        if (!raw.toLowerCase().endsWith(".apk")) raw = raw + ".apk";
        return raw.replace('\\', '_').replace('/', '_').replace(':', '_').trim();
    }

    /** 设置页「检查更新」那一块的状态文案（按钮没建/设置页没开时调用也无害）。 */
    private void refreshUpdateRows() {
        if (versionRow != null) {
            String name = UpdateCheck.versionName(this);
            int code = UpdateCheck.versionCode(this);
            versionRow.setText("当前版本：" + (TextUtils.isEmpty(name) ? "读不到" : name)
                    + "　versionCode " + (code < 0 ? "?" : String.valueOf(code)));
        }
        if (updateCheckToggle != null) {
            updateCheckToggle.setText("检查更新：" + (UpdateCheck.isEnabled(this)
                    ? "已开启"
                    : "已关闭（默认关闭；关闭期间这个应用不会联网查版本）"));
        }
        if (updateStatusRow != null) {
            String src = UpdateCheck.source(this);
            String skip = UpdateCheck.getSkipVersion(this);
            long last = UpdateCheck.lastCheckAt(this);
            long now = System.currentTimeMillis();
            StringBuilder sb = new StringBuilder();
            if (TextUtils.isEmpty(src)) {
                sb.append("更新源：空　状态：关闭（不联网）");
            } else if (!UpdateCheck.isOwnerRepoForm(src)) {
                sb.append("更新源：「").append(src).append("」不合格　状态：这个源被拒，不会联网");
            } else {
                sb.append("更新源：").append(src)
                        .append(UpdateCheck.isEnabled(this) ? "　状态：可查" : "　状态：关闭（开关没开，不会联网）");
            }
            sb.append("\n节流：24 小时只查一次");
            if (last <= 0L) sb.append("　还没查过");
            else if (UpdateCheck.checkAllowedNow(last, now)) sb.append("　现在可以再查");
            else sb.append("　下次可以再查还差 ").append(UpdateCheck.throttleLeftText(last, now));
            if (!TextUtils.isEmpty(skip)) sb.append("\n「这版不装」：v ").append(skip);
            updateStatusRow.setText(sb.toString());
        }
        if (updateSkipClear != null) {
            updateSkipClear.setVisibility(TextUtils.isEmpty(UpdateCheck.getSkipVersion(this))
                    ? View.GONE : View.VISIBLE);
        }
    }

    // ------------------------------------------------------------- 地址设置页

    private void showSetup(boolean overlay) {
        if (setupView != null) {
            setupView.setVisibility(View.VISIBLE);
                return;
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);

        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setGravity(Gravity.CENTER);
        outer.setPadding(dp(24), dp(28), dp(24), dp(28));
        scroll.addView(outer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 宽屏（平板/折叠屏展开）时限宽，不让输入框横跨整块屏
        int maxW = Math.min(getResources().getDisplayMetrics().widthPixels - dp(48), dp(560));
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        outer.addView(form, new LinearLayout.LayoutParams(
                maxW > 0 ? maxW : ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("个人助手");
        title.setTextColor(TEXT);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        form.addView(title);

        TextView desc = new TextView(this);
        desc.setText("填一个地址就能用：\n"
                + "· 助手地址：电脑上 DSH → 设置 → 个人助手 → 手机访问 给的那个入口。\n"
                + "通用版首次打开是空的，必须自己填（这版壳里没有预置任何人的地址）。\n"
                + "填一次就记住，之后打开直接进这个地址。");
        desc.setTextColor(DIM);
        desc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        desc.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams descLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        descLp.topMargin = dp(10);
        form.addView(desc, descLp);

        TextView label1 = new TextView(this);
        label1.setText("助手地址（DSH）");
        label1.setTextColor(TEXT);
        label1.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        label1.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams l1 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        l1.topMargin = dp(20);
        form.addView(label1, l1);

        final EditText input = new EditText(this);
        String saved = prefs.getString(KEY_URL, "");
        input.setText(TextUtils.isEmpty(saved) ? DEFAULT_URL : saved);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setTextColor(TEXT);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        input.setHintTextColor(DIM);
        input.setHint("http://<你自己的电脑IP>:3081");
        input.setSelectAllOnFocus(true);
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputLp.topMargin = dp(6);
        form.addView(input, inputLp);

        // 1.4.9：通用版不预置任何人的地址，常用值那格改成占位说明；填过一次以后照常记住。
        TextView common = new TextView(this);
        if (TextUtils.isEmpty(COMMON_ASSISTANT_URL)) {
            common.setText("常用地址：无\n"
                    + "助手  照这格式填：http://<你自己的电脑IP>:3081");
        } else {
            common.setText("常用地址：\n"
                    + "助手  " + COMMON_ASSISTANT_URL);
        }
        common.setTextColor(DIM);
        common.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        common.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams commonLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        commonLp.topMargin = dp(12);
        form.addView(common, commonLp);

        Button quick = new Button(this);
        quick.setText(TextUtils.isEmpty(COMMON_ASSISTANT_URL)
                ? "常用地址没预置，请自己填"
                : "一键填入常用地址");
        quick.setAllCaps(false);
        quick.setTextColor(TEXT);
        quick.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        quick.setBackgroundColor(CARD);
        LinearLayout.LayoutParams quickLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        quickLp.topMargin = dp(8);
        form.addView(quick, quickLp);
        quick.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (TextUtils.isEmpty(COMMON_ASSISTANT_URL)) {
                    // 没有预置常用地址：只提示，绝不往输入框里塞占位文字（塞进去照样连不上）
                    toast("这版没有预置常用地址，请自己填电脑上的助手入口地址");
                    return;
                }
                if (TextUtils.isEmpty(input.getText().toString().trim())) {
                    input.setText(COMMON_ASSISTANT_URL);
                }
            }
        });

        Button go = new Button(this);
        go.setText("保存并连接");
        go.setAllCaps(false);
        go.setTextColor(Color.WHITE);
        go.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        go.setBackgroundColor(ACCENT);
        LinearLayout.LayoutParams goLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        goLp.topMargin = dp(18);
        form.addView(go, goLp);
        go.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String assistantRaw = input.getText().toString().trim();
                String url = normalizeUrl(assistantRaw);
                // 通用版默认空：不许点完保存还是一片空白
                if (url == null) {
                    toast("地址不能空着，照 http://<你自己的电脑IP>:3081 这个格式填");
                    return;
                }
                String oldUrl = prefs.getString(KEY_URL, "");
                prefs.edit().putString(KEY_URL, url).apply();
                hideSetup();
                hideError();
                if (!url.equals(oldUrl) || web.getUrl() == null) {
                    web.loadUrl(url);
                }
            }
        });

        // ---- 后台保活（2026-11-27）：前台服务开关 + 电池优化白名单入口。
        //      只给开关与入口，绝不自动弹系统授权页（用户点按钮才跳）。 ----
        TextView kaTitle = new TextView(this);
        kaTitle.setText("后台保活（切后台不重连、任务完成播报）");
        kaTitle.setTextColor(TEXT);
        kaTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        kaTitle.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams kaTitleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        kaTitleLp.topMargin = dp(24);
        form.addView(kaTitle, kaTitleLp);

        keepAliveToggle = new Button(this);
        keepAliveToggle.setAllCaps(false);
        keepAliveToggle.setTextColor(TEXT);
        keepAliveToggle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        keepAliveToggle.setBackgroundColor(CARD);
        LinearLayout.LayoutParams kaLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        kaLp.topMargin = dp(8);
        form.addView(keepAliveToggle, kaLp);
        keepAliveToggle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                boolean next = !KeepAliveService.isEnabled(MainActivity.this);
                KeepAliveService.setEnabled(MainActivity.this, next);
                refreshKeepAliveRows();
                toast(next ? "已开启后台常驻保活" : "已关闭后台常驻保活");
            }
        });

        batteryWhitelist = new Button(this);
        batteryWhitelist.setAllCaps(false);
        batteryWhitelist.setTextColor(TEXT);
        batteryWhitelist.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        batteryWhitelist.setBackgroundColor(CARD);
        LinearLayout.LayoutParams bwLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        bwLp.topMargin = dp(8);
        form.addView(batteryWhitelist, bwLp);
        batteryWhitelist.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    startActivity(KeepAliveService.batteryWhitelistIntent(MainActivity.this));
                } catch (ActivityNotFoundException e) {
                    toast("这台设备没有电池优化设置页");
                }
            }
        });
        refreshKeepAliveRows();

        // ---- 1.4.10 检查更新：默认关闭、更新源要自己填（owner/repo），24 小时只查一次。
        //      这一整块只是开关 + 输入 + 手动按钮；没有定时器、没有后台自动查。 ----
        TextView updateTitle = new TextView(this);
        updateTitle.setText("检查更新（默认关闭）");
        updateTitle.setTextColor(TEXT);
        updateTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        updateTitle.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams updateTitleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        updateTitleLp.topMargin = dp(24);
        form.addView(updateTitle, updateTitleLp);

        versionRow = new TextView(this);
        versionRow.setTextColor(DIM);
        versionRow.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        LinearLayout.LayoutParams versionLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        versionLp.topMargin = dp(8);
        form.addView(versionRow, versionLp);

        TextView updateDesc = new TextView(this);
        updateDesc.setText("更新检查默认是关闭的，要自己填更新源：填你自己的仓库 owner/repo（GitHub 账号名/仓库名），"
                + "留空就是关闭、完全不联网。\n查到的新版只认 https 的 GitHub 发布页，24 小时内只查一次，"
                + "只有你点「检查更新」才发一次请求，本应用不会后台自动联网。");
        updateDesc.setTextColor(DIM);
        updateDesc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        updateDesc.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams updateDescLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        updateDescLp.topMargin = dp(8);
        form.addView(updateDesc, updateDescLp);

        updateCheckToggle = new Button(this);
        updateCheckToggle.setAllCaps(false);
        updateCheckToggle.setTextColor(TEXT);
        updateCheckToggle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        updateCheckToggle.setBackgroundColor(CARD);
        LinearLayout.LayoutParams updateToggleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        updateToggleLp.topMargin = dp(8);
        form.addView(updateCheckToggle, updateToggleLp);
        updateCheckToggle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                boolean next = !UpdateCheck.isEnabled(MainActivity.this);
                UpdateCheck.setEnabled(MainActivity.this, next);
                refreshUpdateRows();
                toast(next
                        ? "已开启更新检查（还要填更新源才会联网）"
                        : "已关闭更新检查：关闭期间不会联网查版本");
            }
        });

        TextView updateSourceLabel = new TextView(this);
        updateSourceLabel.setText("更新源（owner/repo）");
        updateSourceLabel.setTextColor(TEXT);
        updateSourceLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        updateSourceLabel.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams updateSourceLabelLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        updateSourceLabelLp.topMargin = dp(10);
        form.addView(updateSourceLabel, updateSourceLabelLp);

        updateSourceInput = new EditText(this);
        updateSourceInput.setText(UpdateCheck.source(this));
        updateSourceInput.setSingleLine(true);
        updateSourceInput.setInputType(InputType.TYPE_CLASS_TEXT);
        updateSourceInput.setTextColor(TEXT);
        updateSourceInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        updateSourceInput.setHintTextColor(DIM);
        updateSourceInput.setHint("你的GitHub账号名/仓库名（留空就是不联网）");
        updateSourceInput.setSelectAllOnFocus(true);
        LinearLayout.LayoutParams updateSourceInputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        updateSourceInputLp.topMargin = dp(6);
        form.addView(updateSourceInput, updateSourceInputLp);

        updateSourceSave = new Button(this);
        updateSourceSave.setText("保存更新源");
        updateSourceSave.setAllCaps(false);
        updateSourceSave.setTextColor(TEXT);
        updateSourceSave.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        updateSourceSave.setBackgroundColor(CARD);
        LinearLayout.LayoutParams updateSourceSaveLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        updateSourceSaveLp.topMargin = dp(8);
        form.addView(updateSourceSave, updateSourceSaveLp);
        updateSourceSave.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String reason = UpdateCheck.saveSource(MainActivity.this,
                        updateSourceInput.getText().toString());
                refreshUpdateRows();
                toast(reason);
            }
        });

        updateCheckRun = new Button(this);
        updateCheckRun.setText("检查更新（手动查一次）");
        updateCheckRun.setAllCaps(false);
        updateCheckRun.setTextColor(Color.WHITE);
        updateCheckRun.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        updateCheckRun.setBackgroundColor(ACCENT);
        LinearLayout.LayoutParams updateRunLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        updateRunLp.topMargin = dp(8);
        form.addView(updateCheckRun, updateRunLp);
        updateCheckRun.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startUpdateCheck();
            }
        });

        updateSkipClear = new Button(this);
        updateSkipClear.setText("取消「这版不装」，恢复提示");
        updateSkipClear.setAllCaps(false);
        updateSkipClear.setTextColor(TEXT);
        updateSkipClear.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        updateSkipClear.setBackgroundColor(CARD);
        LinearLayout.LayoutParams skipLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        skipLp.topMargin = dp(8);
        form.addView(updateSkipClear, skipLp);
        updateSkipClear.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                UpdateCheck.clearSkipVersion(MainActivity.this);
                refreshUpdateRows();
                toast("已取消「这版不装」：以后查到同一个版本还会提示");
            }
        });

        updateStatusRow = new TextView(this);
        updateStatusRow.setTextColor(DIM);
        updateStatusRow.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        updateStatusRow.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams updateStatusLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        updateStatusLp.topMargin = dp(8);
        form.addView(updateStatusRow, updateStatusLp);

        refreshUpdateRows();

        TextView tip = new TextView(this);
        tip.setText("· 家里同一个 WiFi 可用局域网地址，出门用固定公网地址\n"
                + "· 需要访问密码就在页面里输入一次，之后长期记住\n"
                + "· 想换地址：长按返回键约 1 秒，或长按桌面图标选「设置地址」");
        tip.setTextColor(DIM);
        tip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tip.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams tipLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tipLp.topMargin = dp(22);
        form.addView(tip, tipLp);

        setupView = scroll;
        root.addView(setupView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void hideSetup() {
        if (setupView != null) setupView.setVisibility(View.GONE);
    }

    /** 设置页「后台保活」两行的状态文案（按钮还没建/设置页没开时空调用也无害）。 */
    private void refreshKeepAliveRows() {
        if (keepAliveToggle != null) {
            keepAliveToggle.setText("后台常驻保活（前台服务）："
                    + (KeepAliveService.isEnabled(this) ? "已开启" : "已关闭"));
        }
        if (batteryWhitelist != null) {
            batteryWhitelist.setText("电池优化白名单："
                    + (KeepAliveService.isIgnoringBatteryOptimizations(this) ? "已加入" : "去加入（防厂商杀后台）"));
        }
    }

    private String normalizeUrl(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        if (!s.matches("^[a-zA-Z][a-zA-Z0-9+.\\-]*://.*")) s = "http://" + s;
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) return null;
        if (!u.getScheme().toLowerCase().startsWith("http")) return null;
        return s;
    }

    // --------------------------------------------------------------- 出错页

    private void showError(String detail) {
        if (errorView == null) {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            box.setBackgroundColor(BG);
            box.setPadding(dp(28), dp(28), dp(28), dp(28));

            TextView t = new TextView(this);
            t.setText("连不上电脑");
            t.setTextColor(TEXT);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
            t.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            box.addView(t);

            errorDetail = new TextView(this);
            errorDetail.setTextColor(DIM);
            errorDetail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            errorDetail.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            dl.topMargin = dp(10);
            box.addView(errorDetail, dl);

            TextView hint = new TextView(this);
            hint.setText("检查电脑是否开着、隧道有没有断，或者换个地址。");
            hint.setTextColor(DIM);
            hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            hint.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams hl = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            hl.topMargin = dp(14);
            box.addView(hint, hl);

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rl.topMargin = dp(22);
            box.addView(row, rl);

            Button retry = new Button(this);
            retry.setText("重试");
            retry.setAllCaps(false);
            retry.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    hideError();
                    String saved = prefs.getString(KEY_URL, DEFAULT_URL);
                    web.loadUrl(saved);
                }
            });
            row.addView(retry);

            Button change = new Button(this);
            change.setText("改地址");
            change.setAllCaps(false);
            change.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showSetup(true);
                }
            });
            LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            cl.leftMargin = dp(12);
            row.addView(change, cl);

            errorView = box;
            root.addView(errorView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        if (errorDetail != null) {
            errorDetail.setText(TextUtils.isEmpty(detail) ? "" : detail);
        }
        errorView.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        if (errorView != null) errorView.setVisibility(View.GONE);
    }

    private final Runnable loadingTick = new Runnable() {
        @Override
        public void run() {
            if (loadingView == null || loadingView.getVisibility() != View.VISIBLE) return;
            loadingSeconds++;
            if (loadingText != null) {
                if (loadingSeconds < 8) {
                    loadingText.setText("正在连接电脑… " + loadingSeconds + " 秒");
                } else {
                    loadingText.setText("网络有点慢（可能在走公网隧道）… " + loadingSeconds + " 秒\n"
                            + "可以继续等，也可以点下面换个地址（同一个 WiFi 用局域网地址会快很多）");
                }
            }
            handler.postDelayed(this, 1000);
        }
    };

    private void showLoading() {
        if (loadingView == null) buildLoadingView();
        if (loadingView == null) return;
        loadingSeconds = 0;
        if (loadingText != null) loadingText.setText("正在连接电脑…");
        loadingView.setVisibility(View.VISIBLE);
        loadingView.bringToFront();
        handler.removeCallbacks(loadingTick);
        handler.postDelayed(loadingTick, 1000);
    }

    private void hideLoading() {
        handler.removeCallbacks(loadingTick);
        if (loadingView != null) loadingView.setVisibility(View.GONE);
    }

    private void buildLoadingView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BG);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));

        TextView title = new TextView(this);
        title.setText("个人助手");
        title.setTextColor(TEXT);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        box.addView(title);

        android.widget.ProgressBar bar = new android.widget.ProgressBar(this);
        bar.setIndeterminate(true);
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(dp(34), dp(34));
        bl.topMargin = dp(18);
        box.addView(bar, bl);

        loadingText = new TextView(this);
        loadingText.setText("正在连接电脑…");
        loadingText.setTextColor(DIM);
        loadingText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        loadingText.setGravity(Gravity.CENTER);
        loadingText.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tl.topMargin = dp(14);
        box.addView(loadingText, tl);

        Button change = new Button(this);
        change.setText("改地址");
        change.setAllCaps(false);
        change.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                hideLoading();
                showSetup(true);
            }
        });
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cl.topMargin = dp(18);
        box.addView(change, cl);

        loadingView = box;
        root.addView(loadingView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** 白底 → 状态栏/导航栏图标改深色；深色 → 恢复浅色图标。 */
    @SuppressWarnings("deprecation")
    private void applySystemBars(boolean light) {
        try {
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            decor.setSystemUiVisibility(flags);
            getWindow().setStatusBarColor(light ? L_BG : BG);
            getWindow().setNavigationBarColor(light ? L_CARD : BG);
        } catch (Throwable ignored) {
            // 个别 ROM 上改系统栏失败不影响页面
        }
    }

    // ------------------------------------------------------------ 返回键

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                if (event.getRepeatCount() == 0) {
                    backLongFired = false;
                    backLongPress = new Runnable() {
                        @Override
                        public void run() {
                            backLongFired = true;
                            showSetup(true);
                        }
                    };
                    handler.postDelayed(backLongPress, 1100);
                }
                return true;
            }
            if (event.getAction() == KeyEvent.ACTION_UP) {
                if (backLongPress != null) {
                    handler.removeCallbacks(backLongPress);
                    backLongPress = null;
                }
                if (!backLongFired) handleBack();
                backLongFired = false;
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private void handleBack() {
        if (setupView != null && setupView.getVisibility() == View.VISIBLE) {
            if (!TextUtils.isEmpty(prefs.getString(KEY_URL, ""))) hideSetup();
            return;
        }
        if (errorView != null && errorView.getVisibility() == View.VISIBLE) {
            hideError();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // 已经回到页面首页：全面屏手势的手机没有物理返回键可长按，
        // 所以在「返回」这一步给一个原生的设置入口，永远够得着。
        showBackMenu();
    }

    /**
     * 返回键菜单（1.4.2 起三项；1.4.10 起加第 4 项「检查更新」）：
     * 「设置地址 / 重新加载页面 / 退出应用 / 检查更新」。
     *
     * 没有「取消」按钮：AlertDialog 默认 cancelable，点弹窗外面或按返回键就关掉
     * （弹窗有自己的 Window 抢焦点，不会落进 Activity 的 dispatchKeyEvent 里）。
     */
    private void showBackMenu() {
        final String[] items = new String[]{"设置地址", "重新加载页面", "退出应用", "检查更新"};
        AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle("个人助手")
                .setCancelable(true)
                .setItems(items, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        if (which == 0) {
                            showSetup(true);
                        } else if (which == 1) {
                            String saved = prefs.getString(KEY_URL, "");
                            if (TextUtils.isEmpty(saved)) showSetup(true);
                            else {
                                hideError();
                                web.loadUrl(saved);
                            }
                        } else if (which == 3) {
                            // 1.4.10：只有用户主动按这一项才发一次请求（关闭态只提示、不联网）
                            startUpdateCheck();
                        } else {
                            finish();
                        }
                    }
                })
                .show();
        // 没有「取消」按钮：点弹窗外面也能关（返回键由 Dialog 自己吃掉，见方法注释）。
        dlg.setCanceledOnTouchOutside(true);
    }

    // ------------------------------------------------------------ 生命周期

    @Override
    protected void onPause() {
        // 2026-11-27 后台保活：不再暂停 WebView（WebView.onPause 会停掉媒体与部分处理），
        // 后台恰恰要靠 JS 定时器/WebSocket/音频继续跑（任务完成才能收到并播报）。
        // 渲染省电交给系统（不可见时本来就不绘制），进程保活交给 KeepAliveService。
        NativeBridge.setAppInBackground(true);
        CookieManager.getInstance().flush();
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_UNCHANGED;
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        NativeBridge.setAppInBackground(false);
        if (web != null) web.onResume();
        applySystemBars(false);
        // 保活服务若曾在后台被回收，回到前台立刻补拉（start 内部幂等，已在跑则空转）
        KeepAliveService.start(this);
        refreshKeepAliveRows();
        refreshUpdateRows();
        // 连接断开由页面侧 foreground-nudge 负责（可见即 reconnect + 阶梯补刀）；
        // 这里只探「渲染进程是不是还活着」，绝不无条件 reload——那就是用户骂的重连白等。
        probePageAlive();
    }

    /**
     * 页面探活：给 WebView 递一句 JS，读页面侧暴露的连接状态。
     * 回调来了 = 渲染进程健康，连接状态交给页面侧自愈（foreground-nudge.ts）；
     * 5 秒都没回调 = 渲染进程卡死/被冻结（evaluateJavascript 永远不会回来），
     * 重建一块 WebView 等同于浏览器刷新一次，比让用户对着死页面强。
     */
    private void probePageAlive() {
        if (web == null || web.getUrl() == null) return;
        if (setupView != null && setupView.getVisibility() == View.VISIBLE) return;
        if (errorView != null && errorView.getVisibility() == View.VISIBLE) return;
        final WebView probe = web;
        final boolean[] answered = new boolean[1];
        web.evaluateJavascript(
                "(function(){try{var f=window.__dshAssistantConnState;"
                        + "return typeof f==='function'?String(f()):'unknown'}catch(e){return 'unknown'}})()",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        answered[0] = true;
                    }
                });
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!answered[0] && web == probe) {
                    recoverWebView();
                }
            }
        }, 5000);
    }

    /** Android 13+ 通知是运行时权限：常驻通知与任务完成通知都要它；启动时申请一次，不纠缠。 */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (downloadReceiver != null) {
            try { unregisterReceiver(downloadReceiver); } catch (Throwable ignored) { }
            downloadReceiver = null;
        }
        if (web != null) {
            web.setWebChromeClient(null);
            web.setWebViewClient(null);
            screenHost.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /**
     * 折叠 / 展开 / 转屏 / 分屏 / 改字号：Activity 不重建（configChanges），
     * 这里只需要让 WebView 重新按新的窗口宽度排版即可。
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (web != null) {
            web.getSettings().setTextZoom(100);
            web.requestLayout();
        }
    }

    // ------------------------------------------------------------ 小工具

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}
