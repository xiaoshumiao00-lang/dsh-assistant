package com.chenpan.assistant;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
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
import android.view.MotionEvent;
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
 * 鹈鹕设备屏与配套的录音 / 本地唤醒 / 音量条已在 1.4.3 随设备功能一起移除。
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

    /** 设置页「一键填入常用地址」用的常用值（也是占位提示里写的那条）。 */
    private static final String COMMON_ASSISTANT_URL = "http://***REMOVED***";

    private static final String PREFS = "dsh_assistant";
    private static final String KEY_URL = "home_url";
    private static final String KEY_BALL_X = "ball_x";
    private static final String KEY_BALL_Y = "ball_y";

    // 原生配色（状态栏 / 导航栏 / 悬浮球）
    private static final int L_BG = 0xFFF7F8FA;
    private static final int L_CARD = 0xFFFFFFFF;
    private static final int L_TEXT = 0xFF111827;
    private static final int L_DIM = 0xFF6B7280;
    private static final int L_LINE = 0xFFE5E7EB;
    private static final int L_ACCENT = 0xFF0F766E;

    /** 桌面快捷方式「设置地址」带过来的标记。 */
    private static final String EXTRA_SETTINGS = "open_settings";

    private static final int REQ_FILE = 1001;
    private static final int REQ_PERM = 1002;

    private static final int BG = 0xFF0F1115;
    private static final int CARD = 0xFF161A21;
    private static final int TEXT = 0xFFE6E8EB;
    private static final int DIM = 0xFF8A9099;
    private static final int ACCENT = 0xFF3B82F6;
    private static final int TEAL = 0xFF3FB6A8;
    private static final int RED = 0xFFE05F5F;
    private static final int AMBER = 0xFFE2B03F;


    private SharedPreferences prefs;
    private FrameLayout root;
    /** 承载助手 WebView 的容器。 */
    private FrameLayout screenHost;
    private WebView web;

    private int ballX = -1;
    private int ballY = -1;

    private int accentMain() {
        return L_ACCENT;
    }

    private int accentSecond() {
        return 0xFF1D4ED8;
    }


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

    // ---- 浮动切屏按钮 ----
    private TextView screenBtn;





    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable backLongPress;
    private boolean backLongFired;
    private long lastBackAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        // 悬浮球位置：冷启动就按上次拖到的位置恢复
        ballX = prefs.getInt(KEY_BALL_X, -1);
        ballY = prefs.getInt(KEY_BALL_Y, -1);

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);

        screenHost = new FrameLayout(this);
        screenHost.setBackgroundColor(BG);
        root.addView(screenHost, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        buildScreenButton();

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
        refreshChrome();

        // 桌面图标长按 →「设置地址」快捷方式（全面屏手势的手机没有返回键可长按）
        Intent intent = getIntent();
        if (intent != null && intent.getIntExtra(EXTRA_SETTINGS, 0) == 1) {
            intent.removeExtra(EXTRA_SETTINGS);
            showSetup(true);
        }
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
            refreshChrome();
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
            // 助手屏每次加载完也刷一次：万一切屏/降级时序错位，这里能把浮层收回去。
            refreshChrome();
        }

        /** 前进/后退（含页面自己的 history.pushState）都要重算一次浮层可见性。 */
        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            refreshChrome();
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            refreshChrome();
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

    private void startDownload(String url, String contentDisposition, String mimeType) {
        try {
            String name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("no DownloadManager");
            dm.enqueue(req);
            } catch (Throwable t) {
            toast("这个文件要到电脑上下载");
        }
    }

    // ------------------------------------------------------------- 地址设置页

    private void showSetup(boolean overlay) {
        if (setupView != null) {
            setupView.setVisibility(View.VISIBLE);
            refreshChrome();
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
                + "通用版首次打开是空的——可以手填，也可以点下面的「一键填入常用地址」。\n"
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
        input.setHint("http://***REMOVED***");
        input.setSelectAllOnFocus(true);
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputLp.topMargin = dp(6);
        form.addView(input, inputLp);

        // 通用版默认空：给出常用值，一键填进空着的那格（不覆盖用户已经填好的）
        TextView common = new TextView(this);
        common.setText("常用地址：\n"
                + "助手  " + COMMON_ASSISTANT_URL);
        common.setTextColor(DIM);
        common.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        common.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams commonLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        commonLp.topMargin = dp(12);
        form.addView(common, commonLp);

        Button quick = new Button(this);
        quick.setText("一键填入常用地址");
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
                    toast("地址不能空着，例如 http://***REMOVED***");
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

        TextView tip = new TextView(this);
        tip.setText("· 家里同一个 WiFi 可用局域网地址，出门用固定公网地址\n"
                + "· 需要访问密码就在页面里输入一次，之后长期记住\n"
                + "· 想换地址：长按左下角的悬浮球，随时回到这一页");
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
        refreshChrome();
    }

    private void hideSetup() {
        if (setupView != null) setupView.setVisibility(View.GONE);
        refreshChrome();
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
        refreshChrome();
    }

    private void hideError() {
        if (errorView != null) errorView.setVisibility(View.GONE);
        refreshChrome();
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
        refreshChrome();
    }

    private void hideLoading() {
        handler.removeCallbacks(loadingTick);
        if (loadingView != null) loadingView.setVisibility(View.GONE);
        refreshChrome();
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

    // ------------------------------------------------------- 浮动切屏按钮

    private void buildScreenButton() {
        screenBtn = new TextView(this);
        screenBtn.setText("鹈");
        screenBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        screenBtn.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        screenBtn.setTextColor(0xFFEAF6F4);
        screenBtn.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(0xCC101820);
        bg.setStroke(dp(1.5f), 0xCC3FB6A8);
        screenBtn.setBackground(bg);
        screenBtn.setAlpha(0.6f);
        screenBtn.setContentDescription("切换屏幕");
        screenBtn.setClickable(true);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(40), dp(40));
        lp.gravity = Gravity.BOTTOM | Gravity.START;
        lp.leftMargin = dp(16);
        lp.bottomMargin = dp(16);
        root.addView(screenBtn, lp);

        screenBtn.setOnTouchListener(new View.OnTouchListener() {
            private float downX, downY;
            private boolean dragging;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX();
                        downY = e.getRawY();
                        dragging = false;
                        v.setAlpha(1f);
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - downX;
                        float dy = e.getRawY() - downY;
                        if (!dragging && Math.hypot(dx, dy) > dp(8)) dragging = true;
                        if (dragging) moveBallTo(e.getRawX(), e.getRawY());
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        v.setAlpha(0.6f);
                        if (!dragging && e.getActionMasked() == MotionEvent.ACTION_UP) {
                            v.animate().scaleX(1.14f).scaleY(1.14f).setDuration(110).start();
                            handler.postDelayed(new Runnable() {
                                @Override
                                public void run() {
                                    screenBtn.animate().scaleX(1f).scaleY(1f).setDuration(150).start();
                                }
                            }, 120);
                            // 单击 = 重新加载当前页面（等效浏览器的刷新；长按才是菜单）
                            if (web != null) web.reload();
                        } else if (dragging) {
                            prefs.edit().putInt(KEY_BALL_X, ballX).putInt(KEY_BALL_Y, ballY).apply();
                        }
                        dragging = false;
                        return true;
                    default:
                        return false;
                }
            }
        });
        restoreBall();
    }

    /** 把悬浮球拖到手指处（按手指为中心），边界夹在 root 内并记住位置。 */
    private void moveBallTo(float cx, float cy) {
        if (screenBtn == null || root == null) return;
        int size = dp(40);
        int w = root.getWidth();
        int h = root.getHeight();
        if (w <= 0 || h <= 0) return;
        int[] pos = BallRules.clamp(Math.round(cx - size / 2f), Math.round(cy - size / 2f), w, h, size);
        if (pos == null) return;
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) screenBtn.getLayoutParams();
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.leftMargin = pos[0];
        lp.topMargin = pos[1];
        lp.bottomMargin = 0;
        screenBtn.setLayoutParams(lp);
        screenBtn.bringToFront();
        screenBtn.invalidate();
        root.requestLayout();
        ballX = pos[0];
        ballY = pos[1];
    }

    /** 启动时恢复悬浮球：root 还没量出尺寸就稍后重试；坐标非法/越界一律回默认左下角。 */
    private void restoreBall() {
        if (ballX < 0 || ballY < 0) return;
        final int attempt = 0;
        tryRestoreBall(0);
    }

    private void tryRestoreBall(final int attempt) {
        if (screenBtn == null || root == null) return;
        int w = root.getWidth();
        int h = root.getHeight();
        int size = dp(40);
        int[] pos = BallRules.clamp(ballX, ballY, w, h, size);
        if (pos == null) {
            if (attempt < 6 && (w <= 0 || h <= 0)) {
                handler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        tryRestoreBall(attempt + 1);
                    }
                }, 120);
            } else {
                resetBallToDefault();
            }
            return;
        }
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) screenBtn.getLayoutParams();
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.leftMargin = pos[0];
        lp.topMargin = pos[1];
        lp.bottomMargin = 0;
        screenBtn.setLayoutParams(lp);
        screenBtn.bringToFront();
        ballX = pos[0];
        ballY = pos[1];
        root.requestLayout();
    }

    /** 默认位置：左下角 16dp（同时清掉落盘的坐标）。 */
    private void resetBallToDefault() {
        if (screenBtn == null) return;
        prefs.edit().remove(KEY_BALL_X).remove(KEY_BALL_Y).apply();
        ballX = -1;
        ballY = -1;
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) screenBtn.getLayoutParams();
        lp.gravity = Gravity.BOTTOM | Gravity.START;
        lp.leftMargin = dp(BallRules.DEFAULT_MARGIN_DP);
        lp.topMargin = 0;
        lp.bottomMargin = dp(BallRules.DEFAULT_MARGIN_DP);
        screenBtn.setLayoutParams(lp);
        screenBtn.bringToFront();
        root.requestLayout();
    }

    private void updateScreenButton() {
        if (screenBtn == null) return;
        // 悬浮球：单击 = 重新加载当前页面，长按 = 菜单（设置地址 / 重新加载 / 退出）
        screenBtn.setText("⟳");
        screenBtn.setAlpha(0.6f);
    }


    /** 白底 → 状态栏/导航栏图标改深色；深色 → 恢复浅色图标。 */
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

    private GradientDrawable roundBg(int color, float radiusDp, int strokeColor) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setCornerRadius(dp(radiusDp));
        d.setColor(color);
        d.setStroke(dp(1), strokeColor);
        return d;
    }


    /** 悬浮球在覆盖页（设置、错误、等待）出现时让位。 */
    private void refreshChrome() {
        boolean block = (setupView != null && setupView.getVisibility() == View.VISIBLE)
                || (errorView != null && errorView.getVisibility() == View.VISIBLE)
                || (loadingView != null && loadingView.getVisibility() == View.VISIBLE);
        // 只让位给设置/错误/等待这些全屏页
        if (screenBtn != null) {
            screenBtn.setVisibility(block ? View.GONE : View.VISIBLE);
        }
    }




    // ------------------------------------------------------- 波形动画 View


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
            // 先立刻复核一次浮层状态，再等页面回调二次确认（和浏览器的后退一样）
            refreshChrome();
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    refreshChrome();
                }
            }, 300);
            return;
        }
        // 已经回到页面首页：全面屏手势的手机没有物理返回键可长按，
        // 所以在「返回」这一步给一个原生的设置入口，永远够得着。
        showBackMenu();
    }

    /**
     * 返回键菜单（1.4.2 起）：只留「设置地址 / 重新加载页面 / 退出应用」三项。
     *
     * 没有「取消」按钮：AlertDialog 默认 cancelable，点弹窗外面或按返回键就关掉
     * （弹窗有自己的 Window 抢焦点，不会落进 Activity 的 dispatchKeyEvent 里）。
     */
    private void showBackMenu() {
        final String[] items = new String[]{"设置地址", "重新加载页面", "退出应用"};
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
        if (web != null) {
            web.onPause();
        }
        CookieManager.getInstance().flush();
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_UNCHANGED;
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        refreshChrome();
        applySystemBars(false);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
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
        refreshChrome();
    }

    // ---------------------------------------------- 转录确认卡（1.3.0，1.5 秒自动发送）







    // ------------------------------------------------------------ 小工具

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }



    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}
