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
 * 1.1.0 起一个 APK 两个屏（同一个 Activity 里切容器，不重开 Activity）：
 *   · 助手屏 —— 电脑上 DSH 的那套页面（同一份 HTML/CSS/JS、同一个会话、同一套插件）；
 *   · 鹈鹕屏 —— 49.234.20.84:7080/tihu 的模拟设备页，首次进入才创建 WebView（lazy），
 *     切走时不销毁、切回不重载；并在底部装一个真的录音 + 本地 whisper 转写的语音按钮。
 *
 * 自适应（手机 / 折叠屏 / 平板）：
 *   1. 不锁方向、resizeableActivity，Activity 自己吞掉配置变化（configChanges），
 *      折叠、展开、分屏、转屏都不重建 WebView，不白屏重载；
 *   2. WebView 打开 useWideViewPort、关掉 loadWithOverviewMode，页面按自己的 viewport 排版；
 *   3. 鹈鹕屏的手机适配只靠注入 CSS/JS（全部包在 @media (max-width:700px) 里），
 *      桌面宽屏打开时一个字都不生效，页面保持原样。
 */
public class MainActivity extends Activity {

    /**
     * 助手地址：通用版留空（首次打开进设置页自己填）。
     * 构建脚本 build.ps1 会按 flavor 覆盖这一行；这个源文件默认就是通用版的空值。
     */
    private static final String DEFAULT_URL = "";
    /**
     * 鹈鹕地址：通用版同样留空（首次两项都空，设置页里可以「一键填入常用地址」）。
     * 由 build.ps1 按 flavor 覆盖。
     */
    private static final String DEFAULT_TIHU_URL = "";

    /** 设置页「一键填入常用地址」用的两个常用值（也是占位提示里写的那两条）。 */
    private static final String COMMON_ASSISTANT_URL = "http://49.234.20.84:7080";
    private static final String COMMON_TIHU_URL = "http://49.234.20.84:7080/tihu?token=96528673";

    private static final String PREFS = "dsh_assistant";
    private static final String KEY_URL = "home_url";
    private static final String KEY_TIHU_URL = "tihu_url";
    private static final String KEY_SCREEN = "screen";
    /**
     * 「默认进入页面」：assistant | tihu。空串＝没配置（沿用 KEY_SCREEN 的「上次停留」）。
     * 只在**冷启动**读它（见 onCreate 的落地屏规则）；切屏仍然写 KEY_SCREEN。
     */
    private static final String KEY_START_SCREEN = "start_screen";
    /** 鹈鹕朗读音量 0–100 与静音态（只发给页面 WebAudio，不碰系统媒体音量）。 */
    private static final String KEY_VOL = "tihu_volume";
    private static final String KEY_MUTED = "tihu_muted";
    /** 主题：light（默认）/ dark。 */
    private static final String KEY_THEME = "tihu_theme";
    /**
     * 1.3.9：以下三个键是 Porcupine 时代的遗留（AccessKey / .ppn / 灵敏度）。
     * 只保留键名，**不再读也不再写**；老设备上已有的值不会报错、也不会唤起 Porcupine。
     */
    private static final String KEY_WAKE_KEY = "wake_access_key";
    private static final String KEY_WAKE_PPN = "wake_ppn_path";
    private static final String KEY_WAKE_SENS = "wake_sensitivity";
    private static final String KEY_WAKE_ON = "wake_enabled";
    private static final String KEY_ACCENT = "tihu_accent";
    private static final String KEY_SOUND = "tihu_sound";
    private static final String KEY_WAKE_TH = "wake_threshold";
    private static final String KEY_BALL_X = "ball_x";
    private static final String KEY_BALL_Y = "ball_y";

    // 浅色主题的原生配色（白底深字，强调色用深一档的青绿）
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
    private static final int REQ_MIC = 1003;

    private static final int BG = 0xFF0F1115;
    private static final int CARD = 0xFF161A21;
    private static final int TEXT = 0xFFE6E8EB;
    private static final int DIM = 0xFF8A9099;
    private static final int ACCENT = 0xFF3B82F6;
    private static final int TEAL = 0xFF3FB6A8;
    private static final int RED = 0xFFE05F5F;
    private static final int AMBER = 0xFFE2B03F;

    /** 语音输入状态机。 */
    private static final int V_IDLE = 0;
    private static final int V_REC = 1;
    private static final int V_ASR = 2;
    private static final int V_DONE = 3;
    private static final int V_ERR = 4;

    /**
     * 录音上限（2026-11-13：60 秒 → 180 秒，用户要求最长 3 分钟）。
     *
     * 3 分钟 16k/单声道/16bit PCM = 180 × 32000 = 5.76MB，WAV 头 44 字节；
     * 服务端（lane 的 /tihu/asr 与公网 relay）同步放宽到 8MB，别再按 2MB 算。
     * 到上限**不是取消**：录音线程 break 后走 onRecordingFinished → 转写 → 悬浮卡
     * → 1.5 秒自动发送，和用户手动点「结束」完全同一条链路。
     */
    private static final int REC_MAX_MS = 180000;
    /** 页面底部给语音条留的高度（CSS px）。1.1.1 起语音条上方多了一条音量条，这里要跟着加。 */
    private static final int PAD_IDLE = 240;
    private static final int PAD_REC = 300;

    private SharedPreferences prefs;
    private FrameLayout root;
    /** 两个屏共用的容器：助手 WebView 常驻，鹈鹕 WebView 首次进入才加进来。 */
    private FrameLayout screenHost;
    private WebView web;
    private WebView tihuWeb;
    private boolean onTihu;
    private boolean tihuReady;
    /** 浅色主题（默认 true）。只影响鹈鹕屏；助手屏保持原样。 */
    private boolean lightTheme = true;

    // ---- 语音唤醒（1.3.5 起是板内 WakeNet；Porcupine 只保留类文件，不再实例化/启动）----
    private boolean panelOpen;
    private WakeNet wakeModel;
    private WakeEngine wakeLocal;
    private boolean soundOn = true;
    private float wakeThreshold = 0.75f;
    private int ballX = -1;
    private int ballY = -1;
    private RecorderButtonDrawable micDraw;
    private float recProgress;
    private int accentPreset;
    private TextView recLine;

    private int accentMain() {
        if (accentPreset == 1) return 0xFF1E3A8A;
        if (accentPreset == 2) return 0xFFB45309;
        return L_ACCENT;
    }

    private int accentSecond() {
        if (accentPreset == 1) return 0xFF0EA5E9;
        if (accentPreset == 2) return 0xFFD97706;
        return 0xFF1D4ED8;
    }

    private final Runnable recProgTick = new Runnable() {
        @Override
        public void run() {
            if (voiceState != V_REC) return;
            long ms = SystemClock.elapsedRealtime() - recStartMs;
            recProgress = Math.min(1f, ms / (float) REC_MAX_MS);

            if (recLine != null) {
                int sec = (int) (ms / 1000);
                // 3 分钟上限后秒数会过 99，必须按 m:ss 显示（旧写法 "0:" + 秒会变成 0:179）。
                String mmss = (sec / 60) + ":" + (sec % 60 < 10 ? "0" + (sec % 60) : String.valueOf(sec % 60));
                recLine.setText("在听… " + mmss + " · 再点一下结束（满 3 分钟自动发送）");
            }
            handler.postDelayed(this, 1000);
        }
    };
    private String wakeKeyword = "鹈鹕";
    private final java.util.ArrayList<String> wakeEvents = new java.util.ArrayList<String>();

    private View setupView;
    private View errorView;
    private TextView errorDetail;
    private View tihuErrorView;
    private TextView tihuErrorDetail;

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

    // ---- 底部语音条 ----
    private View voiceBar;
    private TextView micBtn;
    private TextView cancelBtn;
    private WaveView wave;



    // ---- 鹈鹕朗读音量（只作用于页面 WebAudio，不使用 AudioManager）----
    private View volumeBar;
    private TextView muteBtn;
    private TextView volumePct;
    private TextView settingsBtn;
    /** 连接状态小圆点（代替被隐藏的 header 里那行 #conn）。 */
    private View connDot;
    private String connState = "idle";

    /** 用户设定的音量 0–100（静音时仍保留这个值，便于恢复）。 */
    private int volumePctValue = 80;
    /** 静音开关：true 时下发给页面的是 0。 */
    private boolean volumeMuted;
    /** 静音前最后一次非零音量。 */
    private int volumeLastNonZero = 80;

    private int voiceState = V_IDLE;
    private volatile int voiceGen;
    private volatile boolean recStop;
    private volatile boolean recCancelled;
    private volatile boolean autoStopped;
    private AudioRecord recorder;
    private Thread recThread;
    private HttpURLConnection asrConn;
    private String pendingText;
    private String lastAsrText;
    private long recStartMs;
    private android.animation.ValueAnimator pulseAnim;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable backLongPress;
    private boolean backLongFired;
    private long lastBackAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        // 朗读音量：冷启动就按上次的值准备好（切屏回来/重建都不会跳）
        volumePctValue = prefs.getInt(KEY_VOL, 80);
        if (volumePctValue < 0) volumePctValue = 0;
        if (volumePctValue > 100) volumePctValue = 100;
        volumeMuted = prefs.getBoolean(KEY_MUTED, false) || volumePctValue == 0;
        volumeLastNonZero = volumePctValue > 0 ? volumePctValue : 80;

        // 主题：默认浅色；用户切过就按记住的来
        lightTheme = !"dark".equals(prefs.getString(KEY_THEME, "light"));
        ballX = prefs.getInt(KEY_BALL_X, -1);
        ballY = prefs.getInt(KEY_BALL_Y, -1);
        accentPreset = prefs.getInt(KEY_ACCENT, 0);
        soundOn = prefs.getBoolean(KEY_SOUND, true);
        wakeThreshold = prefs.getFloat(KEY_WAKE_TH, 0.75f);
        // 1.3.8：阈值合法区间 0.00–1.00（旧版本存下来的越界值也夹回来）
        if (Float.isNaN(wakeThreshold)) wakeThreshold = 0.75f;
        wakeThreshold = Math.max(0f, Math.min(1f, wakeThreshold));
        wakeThreshold = Math.round(wakeThreshold * 100f) / 100f;
        prefs.edit().putFloat(KEY_WAKE_TH, wakeThreshold).apply();

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);

        screenHost = new FrameLayout(this);
        screenHost.setBackgroundColor(BG);
        root.addView(screenHost, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        buildScreenButton();
        buildVoiceBar();
        applyNativeTheme();

        web = buildWebView(false);
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
        if (TextUtils.isEmpty(prefs.getString(KEY_TIHU_URL, "")) && !TextUtils.isEmpty(DEFAULT_TIHU_URL)) {
            // 只有构建时预置了鹈鹕地址才自动带上（通用版是空，留给用户填）
            prefs.edit().putString(KEY_TIHU_URL, DEFAULT_TIHU_URL).apply();
        }
        String tihu = tihuUrl();
        boolean haveAssistant = !TextUtils.isEmpty(saved);
        boolean haveTihu = !TextUtils.isEmpty(tihu);

        // 落地屏规则（1.1.0）：
        //   · 两个地址都有 → 进上次停留的屏（记住 KEY_SCREEN）；
        //   · 只有鹈鹕地址 → 直接进鹈鹕屏（不然就是一块白屏）；
        //   · 两个都空 → 进设置页（绝不白屏）。
        String lastScreen = prefs.getString(KEY_SCREEN, "assistant");
        // 「默认进入页面」（鹈鹕设置 → 默认进入页面）优先于「上次停留的屏」：
        // 冷启动必须可预期。没配置/非法值（老设备、手改 prefs）时退回旧行为，绝不白屏。
        String configuredStart = normalizeStartScreen(prefs.getString(KEY_START_SCREEN, ""));
        if (!configuredStart.isEmpty()) lastScreen = configuredStart;
        boolean startTihu = haveTihu && ("tihu".equals(lastScreen) || !haveAssistant);

        if (!haveAssistant && !haveTihu) {
            showSetup(false);
        } else if (startTihu) {
            onTihu = true;
            updateScreenButton();
            if (haveAssistant) web.loadUrl(saved);
            // 1.3.8 修 bug：这里以前只把 onTihu 置 true，却没有做 WebView 的显隐切换，
            // 结果显示的是助手 WebView、原生浮层却按「鹈鹕屏」显示 —— 个人助手页面上
            // 露出录音按钮和音量条。启动屏和 switchScreen 必须走同一套显隐时序。
            if (ensureTihu()) {
                web.setVisibility(View.GONE);
                if (tihuWeb != null) tihuWeb.setVisibility(View.VISIBLE);
            } else {
                onTihu = false;
            }
        } else {
            web.loadUrl(saved);
        }
        if (firstRun && haveAssistant) {
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
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

    // ---------------------------------------------------------------- 两屏切换

    /**
     * 归一「默认进入页面」：只认 assistant / tihu（大小写、首尾空白容忍），
     * 其它一律当「没配置」（空串）。非法值不抛错、不落盘，由 startScreenSet() 回报给设置卡。
     */
    private static String normalizeStartScreen(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(java.util.Locale.US);
        if ("tihu".equals(value)) return "tihu";
        if ("assistant".equals(value)) return "assistant";
        return "";
    }

    private String tihuUrl() {
        String u = prefs.getString(KEY_TIHU_URL, "");
        if (TextUtils.isEmpty(u)) u = DEFAULT_TIHU_URL;
        return u == null ? "" : u.trim();
    }

    /** 鹈鹕 WebView 首次进入才创建；之后一直留在内存里，切回来不重载。 */
    private boolean ensureTihu() {
        String url = tihuUrl();
        if (TextUtils.isEmpty(url)) {
            showSetup(true);
                return false;
        }
        if (tihuWeb != null) return true;
        tihuWeb = buildWebView(true);
        tihuWeb.setVisibility(View.GONE);
        screenHost.addView(tihuWeb, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        tihuReady = false;
        tihuWeb.loadUrl(url);
        return true;
    }

    private void switchScreen(boolean toTihu, boolean remember) {
        if (toTihu) {
            if (!ensureTihu()) return;
            if (voiceState == V_REC || voiceState == V_ASR) {
                cancelVoice(false);
                    }
            onTihu = true;
            web.setVisibility(View.GONE);
            tihuWeb.setVisibility(View.VISIBLE);
            if (tihuReady) startConnPolling();
            else if (tihuWeb != null && !TextUtils.isEmpty(tihuUrl())
                    && !TihuVoiceUtil.isTihuPage(tihuWeb.getUrl())) {
                // 上次加载失败/超时降级后这里可能停在助手路由或空白页：切回来重新拉一次。
                tihuWeb.loadUrl(tihuUrl());
            }
        } else {
            if (TextUtils.isEmpty(prefs.getString(KEY_URL, ""))) {
                // 通用版首次只填了鹈鹕地址：助手地址还没有，别给一块白屏
                showSetup(true);
                        return;
            }
            onTihu = false;
            stopConnPolling();
            if (tihuWeb != null) tihuWeb.setVisibility(View.GONE);
            web.setVisibility(View.VISIBLE);
            hideLoading();
            if (voiceState == V_REC || voiceState == V_ASR) {
                cancelVoice(false);
                    }
        }
        if (remember) {
            prefs.edit().putString(KEY_SCREEN, onTihu ? "tihu" : "assistant").apply();
        }
        updateScreenButton();
        refreshChrome();
        applyNativeTheme();
        if (onTihu) startWakeIfNeeded(); else stopWake();
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint({"SetJavaScriptEnabled"})
    private WebView buildWebView(boolean tihu) {
        WebView w = new WebView(this);
        w.setBackgroundColor(tihu ? 0xFF0B0F14 : BG);
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
        if (tihu) {
            // 鹈鹕页的 viewport 允许缩放（initial-scale=1、不锁 maximum-scale）：
            // 这里放开双指缩放，但不显示 +/- 缩放按钮，默认仍是 1 倍。
            s.setSupportZoom(true);
            s.setBuiltInZoomControls(true);
            s.setDisplayZoomControls(false);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(w, true);

        w.setWebViewClient(new AppClient(tihu));
        w.setWebChromeClient(new AppChrome());
        if (tihu) {
            // 页面里的「深色/浅色」开关通过这个桥把选择交给原生（状态栏、音量条也要跟着变）
            w.addJavascriptInterface(new TihuBridge(), "TihuNative");
        }

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
        web = buildWebView(false);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        screenHost.addView(web, 0, lp);
        web.setVisibility(onTihu ? View.GONE : View.VISIBLE);

        String saved = prefs.getString(KEY_URL, DEFAULT_URL);
        String base = originOf(saved);
        web.loadUrl(base.isEmpty() ? saved : base + "/");
    }

    private void recoverTihuWebView() {
        if (tihuWeb != null) {
            try {
                screenHost.removeView(tihuWeb);
                tihuWeb.setWebChromeClient(null);
                tihuWeb.setWebViewClient(null);
                tihuWeb.destroy();
            } catch (Throwable ignored) {
                // 同上
            }
            tihuWeb = null;
        }
        tihuReady = false;
        ensureTihu();
        if (onTihu && tihuWeb != null) {
            tihuWeb.setVisibility(View.VISIBLE);
            }
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
        private final boolean tihu;

        AppClient(boolean tihu) {
            this.tihu = tihu;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (tihu) {
                tihuReady = false;
                hideTihuError();
                // 一离开 /tihu（加载中、被导航到助手路由）就先把原生浮层收掉，不能等收尾回调。
                refreshChrome();
                handler.removeCallbacks(tihuLoadTimeout);
                handler.postDelayed(tihuLoadTimeout, 20000);
                return;
            }
            // 弱网（尤其是走公网隧道）时首屏要等十几秒，以前这段时间是纯黑屏，
            // 看起来像卡死/点不动。给一个带秒数和「改地址」的过渡层，让等待可见、可退出。
            if (!onTihu) showLoading();
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
            if (tihu) {
                handler.removeCallbacks(tihuLoadTimeout);
                // 1.3.8：只有真正落在 /tihu 路由的文档才算「鹈鹕页就绪」。
                // 页面自己跳到助手路由 / about:blank 时，绝不能往里注入设置面板、
                // 更不能把录音按钮/音量条露出来。
                if (!TihuVoiceUtil.isTihuPage(url)) {
                    tihuReady = false;
                    refreshChrome();
                    return;
                }
                tihuReady = true;
                hideTihuError();
                if (tihuWeb != null) {
                    tihuWeb.evaluateJavascript(TihuVoiceUtil.fitJs(), null);
                    // 手机屏只留显示屏：其余配置/调试块收进右上角齿轮里的「鹈鹕设置」面板
                    tihuWeb.evaluateJavascript(TihuVoiceUtil.settingsJs(), null);
                    // 朗读音量：给 WebAudio 的 connect 打补丁（每个 context 一枚 masterGain）
                    tihuWeb.evaluateJavascript(TihuVoiceUtil.volumeJs(), null);
                    tihuWeb.evaluateJavascript(TihuVoiceUtil.scrollJs(), null);
                    applyTihuVolume();
                    if (onTihu) startConnPolling();
                    startWakeIfNeeded();
                }
                refreshChrome();
                return;
            }
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
            if (tihu) {
                // 鹈鹕页主文档 4xx/5xx：能回助手屏就回，别把用户卡在一张坏页上。
                if (request != null && request.isForMainFrame() && errorResponse != null
                        && errorResponse.getStatusCode() >= 400) {
                    degradeTihu("鹈鹕页打不开（HTTP " + errorResponse.getStatusCode() + "）");
                }
                return;
            }
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
            if (tihu) recoverTihuWebView();
            else recoverWebView();
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                String d = error == null ? "" : String.valueOf(error.getDescription());
                if (tihu) degradeTihu("鹈鹕页打不开：" + d);
                else showError(d);
            }
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                if (tihu) degradeTihu("鹈鹕页打不开：" + (description == null ? "" : description));
                else showError(description == null ? "" : description);
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
            showErrorLine("这台设备打不开这个链接");
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
                showErrorLine("这台设备没有文件选择器");
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
        if (requestCode == REQ_MIC) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (ok) {
                startRecording();
            } else {
                boolean again = false;
                try {
                    again = shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO);
                } catch (Throwable ignored) {
                    // 个别 ROM 这里会抛，当作「不再询问」
                }
                if (again) {
                    showErrorLine("需要麦克风权限，请在系统设置 → 应用 → 个人助手 → 权限 里打开");
                    showErrorLine("需要麦克风权限才能录音");
                } else {
                    showMicPermissionDialog();
                }
            }
        }
    }

    /** 权限被永久拒绝：明确告诉用户，并给一条去系统设置的路。 */
    private void showMicPermissionDialog() {
        if (isFinishing()) return;
        showErrorLine("麦克风权限被拒绝，去系统设置里打开");
        new AlertDialog.Builder(this)
                .setTitle("需要麦克风权限")
                .setMessage("语音输入要把你说的话录下来转成文字。\n"
                        + "可以在系统设置 → 应用 → 个人助手 → 权限 里打开「麦克风」，再回来按一下麦克风按钮。")
                .setPositiveButton("去系统设置", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        try {
                            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                            i.setData(Uri.fromParts("package", getPackageName(), null));
                            startActivity(i);
                        } catch (Throwable t) {
                            showErrorLine("打不开系统设置，请手动到「应用权限」里开麦克风");
                        }
                    }
                })
                .setNegativeButton("取消", null)
                .show();
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
            showErrorLine("这个文件要到电脑上下载");
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
        desc.setText("两个地址各填各的（至少填一个就能用）：\n"
                + "· 助手地址：电脑上 DSH → 设置 → 个人助手 → 手机访问 给的那个入口；\n"
                + "· 鹈鹕地址：带 token 的 /tihu 链接。\n"
                + "通用版首次打开两项都是空的——可以手填，也可以点下面的「一键填入常用地址」。\n"
                + "填一次就记住，之后打开直接进上次停留的那个屏。");
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
        input.setHint("http://192.168.1.10:3081");
        input.setSelectAllOnFocus(true);
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputLp.topMargin = dp(6);
        form.addView(input, inputLp);

        TextView label2 = new TextView(this);
        label2.setText("鹈鹕地址（模拟设备页）");
        label2.setTextColor(TEXT);
        label2.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        label2.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams l2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        l2.topMargin = dp(18);
        form.addView(label2, l2);

        final EditText input2 = new EditText(this);
        String savedTihu = prefs.getString(KEY_TIHU_URL, "");
        input2.setText(TextUtils.isEmpty(savedTihu) ? DEFAULT_TIHU_URL : savedTihu);
        input2.setSingleLine(true);
        input2.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input2.setTextColor(TEXT);
        input2.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        input2.setHintTextColor(DIM);
        input2.setHint("http://49.234.20.84:7080/tihu?token=…");
        input2.setSelectAllOnFocus(true);
        LinearLayout.LayoutParams inputLp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputLp2.topMargin = dp(6);
        form.addView(input2, inputLp2);

        TextView asrHint = new TextView(this);
        asrHint.setText("语音接口按上面的鹈鹕地址自动推导：域名 + /tihu/asr（不用单独填）");
        asrHint.setTextColor(DIM);
        asrHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams ah = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ah.topMargin = dp(6);
        form.addView(asrHint, ah);

        // 通用版两项默认都空：给出常用值，一键填进空着的那格（不覆盖用户已经填好的）
        TextView common = new TextView(this);
        common.setText("常用地址：\n"
                + "助手  " + COMMON_ASSISTANT_URL + "\n"
                + "鹈鹕  " + COMMON_TIHU_URL);
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
                boolean filled = false;
                if (TextUtils.isEmpty(input.getText().toString().trim())) {
                    input.setText(COMMON_ASSISTANT_URL);
                    filled = true;
                }
                if (TextUtils.isEmpty(input2.getText().toString().trim())) {
                    input2.setText(COMMON_TIHU_URL);
                    filled = true;
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
                String url = normalizeUrl(input.getText().toString());
                String tihuRaw = input2.getText().toString().trim();
                String tihu = TextUtils.isEmpty(tihuRaw) ? "" : normalizeUrl(tihuRaw);
                boolean wantTihu = !TextUtils.isEmpty(tihuRaw);
                String assistantRaw = input.getText().toString().trim();
                // 通用版两项都空：至少填一个才能用，不许点完保存还是一片空白
                if (url == null && !wantTihu) {
                    toast("两个地址至少填一个：助手地址或鹈鹕地址");
                    return;
                }
                if (url == null && !assistantRaw.isEmpty()) {
                    toast("助手地址看起来不对，例如 http://192.168.1.10:3081");
                    return;
                }
                if (wantTihu && tihu == null) {
                    toast("鹈鹕地址看起来不对，要 http:// 或 https:// 开头");
                    return;
                }
                String oldUrl = prefs.getString(KEY_URL, "");
                String oldTihu = prefs.getString(KEY_TIHU_URL, "");
                prefs.edit()
                        .putString(KEY_URL, url == null ? "" : url)
                        .putString(KEY_TIHU_URL, tihu == null ? "" : tihu)
                        .apply();
                hideSetup();
                hideError();
                if (url != null && (!url.equals(oldUrl) || web.getUrl() == null)) {
                    web.loadUrl(url);
                }
                // 鹈鹕地址保存即生效：已经在内存里的鹈鹕屏立刻重载
                if (tihuWeb != null && !tihu.equals(oldTihu)) {
                    tihuReady = false;
                    tihuWeb.loadUrl(tihu.isEmpty() ? "about:blank" : tihu);
                }
                        // 两个地址任一填好就能进对应屏：只填了鹈鹕就直接进鹈鹕屏
                if (url == null && !tihu.isEmpty()) {
                    switchScreen(true, true);
                } else if (onTihu && tihu.isEmpty()) {
                    switchScreen(false, true);
                }
            }
        });

        TextView tip = new TextView(this);
        tip.setText("· 家里同一个 WiFi 可用局域网地址，出门用固定公网地址\n"
                + "· 需要访问密码就在页面里输入一次，之后长期记住\n"
                + "· 想换地址：长按返回键，随时回到这一页\n"
                + "· 语音输入走 鹈鹕地址/域名 + /tihu/asr → 电脑上的本地 whisper");
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

    /**
     * 鹈鹕页加载看门狗（1.3.8）：20 秒还没加载完就走降级，不让用户对着白屏干等。
     * onPageStarted 里重新计时，onPageFinished / 降级时取消。
     */
    private final Runnable tihuLoadTimeout = new Runnable() {
        @Override
        public void run() {
            if (!onTihu || tihuReady) return;
            degradeTihu("鹈鹕页加载超时");
        }
    };

    /**
     * 鹈鹕页加载失败或超时：有助手地址就切回助手屏（降级），没有就停在鹈鹕错误页。
     *
     * 降级路径必须走 switchScreen，它统一处理 WebView 显隐、refreshChrome、stopWake，
     * 否则就会留下「助手页 + 鹈鹕浮层」的错位（本次 bug 1 的另一半根因）。
     */
    private void degradeTihu(String why) {
        handler.removeCallbacks(tihuLoadTimeout);
        tihuReady = false;
        if (!onTihu) return;
        String saved = prefs.getString(KEY_URL, "");
        if (TextUtils.isEmpty(saved)) {
            showTihuError(why);
            return;
        }
        toast(why + "，已回个人助手页");
        switchScreen(false, true);
    }

    /** 鹈鹕屏自己的出错页（措辞和助手屏分开，重试的是鹈鹕地址）。 */
    private void showTihuError(String detail) {
        tihuReady = false;
        if (tihuErrorView == null) {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            box.setBackgroundColor(0xFF0B0F14);
            box.setPadding(dp(28), dp(28), dp(28), dp(28));

            TextView t = new TextView(this);
            t.setText("鹈鹕页打不开");
            t.setTextColor(TEXT);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
            t.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            box.addView(t);

            tihuErrorDetail = new TextView(this);
            tihuErrorDetail.setTextColor(DIM);
            tihuErrorDetail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            tihuErrorDetail.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            dl.topMargin = dp(10);
            box.addView(tihuErrorDetail, dl);

            TextView hint = new TextView(this);
            hint.setText("公网隧道可能断了（VPS → 3099 relay）。\n可以先回助手屏，或点下面重试。");
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
                    hideTihuError();
                    if (tihuWeb != null) {
                        tihuReady = false;
                        tihuWeb.loadUrl(tihuUrl());
                    } else {
                        ensureTihu();
                    }
                }
            });
            row.addView(retry);

            Button back = new Button(this);
            back.setText("回助手屏");
            back.setAllCaps(false);
            back.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    switchScreen(false, true);
                }
            });
            LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            bl.leftMargin = dp(12);
            row.addView(back, bl);

            tihuErrorView = box;
            root.addView(tihuErrorView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        if (tihuErrorDetail != null) {
            tihuErrorDetail.setText(TextUtils.isEmpty(detail) ? "" : detail);
        }
        tihuErrorView.setVisibility(View.VISIBLE);
        refreshChrome();
    }

    private void hideTihuError() {
        if (tihuErrorView != null) tihuErrorView.setVisibility(View.GONE);
    }

    // ------------------------------------------------------------ 首屏等待层

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
                            switchScreen(!onTihu, true);
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
    /** 录音时把切屏球缩到 32dp / 40% 透明度 / 左移 6dp，避开「× 取消」胶囊；只改视觉，不动 ballX/ballY。 */
    private void setBallRecordingMode(boolean recording) {
        if (screenBtn == null) return;
        screenBtn.animate().cancel();
        screenBtn.animate()
                .scaleX(recording ? 0.8f : 1f)
                .scaleY(recording ? 0.8f : 1f)
                .translationX(recording ? -dp(6) : 0f)
                .alpha(recording ? 0.4f : 0.6f)
                .setDuration(150)
                .start();
    }

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

    private void updateScreenButton() {        if (screenBtn == null) return;
        // 按钮上写的是「点它去哪个屏」：助手屏上显示「鹈」，鹈鹕屏上显示「助」。
        screenBtn.setText(onTihu ? "助" : "鹈");
        screenBtn.setAlpha(0.6f);
    }

    // ------------------------------------- 语音唤醒（1.3.9：只用板内 WakeNet）

    private boolean wakeOn() {
        return prefs.getBoolean(KEY_WAKE_ON, true);
    }

    /**
     * 只有「当前是鹈鹕页 + App 在前台 + 开关打开 + 不在录音/转写」才启动。
     *
     * 1.3.9：Porcupine 彻底退出启动路径（WakeController.java 只保留文件，不再实例化/start）。
     * 这里不再看 AccessKey / .ppn / 灵敏度，直接走板内 WakeNet。
     * wake_enabled 仍是唯一真相：关闭后任何回调路径进来都只能 stopWake()。
     */
    private void startWakeIfNeeded() {
        if (!wakeOn() || !currentPageIsTihu()) {
            stopWake();
            return;
        }
        if (voiceState == V_REC || voiceState == V_ASR) {
            stopWake();
            return;
        }
        startLocalWake();
    }

    private float wakeScore;
    private int wakeRms;
    /** 本地唤醒引擎的失败原因（空串＝正常）。有值时 wakeStateJson 报 state=error。 */
    private String wakeLocalError = "";
    /** 本次进程是否已经把「引擎启动」记进事件（避免每次切屏刷屏）。 */
    private boolean wakeStartLogged;

    /** 本地唤醒：只在鹈鹕屏前台、非录音/转写、开关打开时启动。 */
    private void startLocalWake() {
        // 1.3.8：wake_enabled 是唯一真相；关掉后从任何回调进来都只能把引擎停掉。
        if (!wakeOn() || !currentPageIsTihu() || voiceState == V_REC || voiceState == V_ASR) {
            stopWake();
            return;
        }
        if (wakeLocal != null && wakeLocal.isRunning()) return;
        // 再判一次（可能在加载模型的同时用户点了关闭），避免「关了又自己起来」。
        if (!wakeOn()) {
            stopWake();
            return;
        }
        try {
            boolean fresh = wakeModel == null;
            if (fresh) wakeModel = new WakeNet(this);
            wakeLocalError = "";
            final int modelBytes = wakeModel.modelBytes();
            if (fresh) {
                addWakeEvent("（引擎）", "模型加载 " + (modelBytes / 1024) + "KB 采样" + WakeNet.SR
                        + " 输入" + WakeNet.N_FRAMES + "x" + WakeNet.N_MELS);
            }
            wakeLocal = new WakeEngine(wakeModel, new WakeEngine.Listener() {
                @Override
                public void onWake(int cls, float score) {
                    wakeScore = score;
                    handler.post(new Runnable() {
                        @Override
                        public void run() {
                            onWakeDetected("鹈鹕");
                        }
                    });
                }

                @Override
                public void onScore(float score, int rms) {
                    wakeScore = score;
                    wakeRms = rms;
                }

                @Override
                public void onError(final String reason) {
                    wakeLocalError = reason == null ? "未知错误" : reason;
                    wakeStartLogged = false;
                    handler.post(new Runnable() {
                        @Override
                        public void run() {
                            addWakeEvent("（错误）", wakeLocalError);
                            showErrorLine("语音唤醒不可用：" + wakeLocalError);
                        }
                    });
                }
            });
            wakeLocal.setThreshold(wakeThreshold);
            wakeLocal.start();
            if (!wakeStartLogged) {
                wakeStartLogged = true;
                addWakeEvent("（引擎）", "引擎启动 模型" + (modelBytes / 1024) + "KB 采样" + WakeNet.SR
                        + " 阈值" + String.format(java.util.Locale.US, "%.2f", wakeThreshold));
            }
        } catch (Throwable e) {
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            wakeModel = null;
            wakeLocalError = "模型加载失败：" + msg;
            wakeStartLogged = false;
            addWakeEvent("（错误）", wakeLocalError);
            showErrorLine("唤醒模型加载失败：" + msg);
        }
    }

    private void stopWake() {
        /*
         * 1.3.9：Porcupine 已不再启动（wake 字段已删），这里只停板内 WakeNet。
         * stopWake 可能从开关、切屏、onPause、录音结束等任意路径进来，必须幂等。
         */
        if (wakeLocal != null) {
            try {
                wakeLocal.stop();
            } catch (Throwable ignored) {
                // 已经停了
            }
            wakeLocal = null;
        }
        wakeStartLogged = false;
    }

    private void onWakeDetected(String keyword) {
        // 关闭唤醒/离开鹈鹕页之后，可能还有一帧命中回调在队列里：直接丢掉，不许偷偷开录。
        if (!wakeOn() || !currentPageIsTihu()) {
            stopWake();
            return;
        }
        wakeKeyword = TextUtils.isEmpty(keyword) ? "鹈鹕" : keyword;
        stopWake();
        if (voiceState == V_REC || voiceState == V_ASR) return;
        stopWake();
        addWakeEvent(wakeKeyword, "命中 · 分数 " + String.format(java.util.Locale.US, "%.2f", wakeScore)
                + " · 阈值 " + String.format(java.util.Locale.US, "%.2f", wakeThreshold));
        try {
            android.os.Vibrator v = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v != null) v.vibrate(60);
        } catch (Throwable ignored) {
            // 没有振动马达就算了
        }
        startRecording();
    }

    private void addWakeEvent(String keyword, String info) {
        String t = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date());
        wakeEvents.add(0, WakeRules.eventLine(t, keyword, info));
        while (wakeEvents.size() > 10) wakeEvents.remove(wakeEvents.size() - 1);
    }

    private void scheduleWakeRestart() {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                startWakeIfNeeded();
            }
        }, 320);
    }

    private String wakeStateJson() {
        boolean enabled = wakeOn();
        // 1.3.9：Porcupine 已退出，状态只看 wake_enabled + 板内引擎的失败原因；
        // 不再读 AccessKey/.ppn/灵敏度，也不再输出 hasKey/hasPpn/sens 这些过期字段。
        String st = WakeRules.idleState(enabled);
        String err = "";
        if (enabled && wakeLocalError != null && !wakeLocalError.isEmpty()) {
            st = WakeRules.ERROR;
            err = wakeLocalError;
        }
        if (!enabled) {
            st = WakeRules.OFF;
            err = "";
        }
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"state\":\"").append(st).append("\",");
        sb.append("\"text\":\"").append(WakeRules.statusText(st, err).replace("\\", "\\\\").replace("\"", "\\\"")).append("\",");
        sb.append("\"switchEnabled\":").append(WakeRules.switchEnabled()).append(',');
        sb.append("\"enabled\":").append(enabled).append(',');
        sb.append("\"error\":\"").append(err.replace("\\", "\\\\").replace("\"", "\\\"")).append("\"");
        sb.append("}");
        return sb.toString();
    }

    private String wakeEventsJson() {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < wakeEvents.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append('"').append(wakeEvents.get(i).replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
        }
        return sb.append(']').toString();
    }

    // ------------------------------------------------------- 浅色/深色主题

    /** 页面里「深色/浅色」按钮 → 原生（状态栏、音量条、切屏圆钮一起变）。 */
    public class TihuBridge {
        @android.webkit.JavascriptInterface
        public String getTheme() {
            return lightTheme ? "light" : "dark";
        }

        @android.webkit.JavascriptInterface
        public void setTheme(String value) {
            final boolean light = !"dark".equals(value);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (lightTheme == light) return;
                    lightTheme = light;
                    prefs.edit().putString(KEY_THEME, light ? "light" : "dark").apply();
                    applyNativeTheme();
                }
            });
        }

        @android.webkit.JavascriptInterface
        public void panelOpen(final String value) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    panelOpen = "1".equals(value);
                    refreshChrome();
                }
            });
        }

        @android.webkit.JavascriptInterface
        public String startScreenValue() {
            return normalizeStartScreen(prefs.getString(KEY_START_SCREEN, ""));
        }

        /**
         * 设置「默认进入页面」。只接受 assistant / tihu；非法值不落盘，回 "err:invalid"，
         * 设置卡据此回显原因（不静默存垃圾）。重启 App 后才生效（冷启动读一次）。
         */
        @android.webkit.JavascriptInterface
        public String startScreenSet(final String value) {
            String next = normalizeStartScreen(value);
            if (next.isEmpty()) return "err:invalid";
            prefs.edit().putString(KEY_START_SCREEN, next).apply();
            return "ok:" + next;
        }

        @android.webkit.JavascriptInterface
        public void resetBall() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    resetBallToDefault();
                }
            });
        }

        @android.webkit.JavascriptInterface
        public void setTtsPlaying(final String v) {
            if (wakeLocal != null) wakeLocal.setPaused("1".equals(v));
        }

        @android.webkit.JavascriptInterface
        public void wakeSetThreshold(final String v) {
            float th;
            try {
                th = Float.parseFloat(v);
            } catch (Throwable t) {
                th = wakeThreshold;
            }
            if (Float.isNaN(th)) th = wakeThreshold;
            // 1.3.8：阈值范围 0.00–1.00（默认 0.75）。0 与 1 都是合法值，不再夹到 0.3–0.9；
            // 落盘也按两位小数对齐滑条显示，避免「显示 0.76、实际 0.755」。
            wakeThreshold = Math.max(0f, Math.min(1f, th));
            wakeThreshold = Math.round(wakeThreshold * 100f) / 100f;
            prefs.edit().putFloat(KEY_WAKE_TH, wakeThreshold).apply();
            if (wakeLocal != null) wakeLocal.setThreshold(wakeThreshold);
        }

        @android.webkit.JavascriptInterface
        public String wakeThresholdValue() {
            return String.format(java.util.Locale.US, "%.2f", wakeThreshold);
        }

        /** 实时分数 / 实时 rms，例："0.62/1300"（1.3.5 起带 rms，方便判断是能量门限还是模型的问题）。 */
        @android.webkit.JavascriptInterface
        public String wakeScoreValue() {
            return String.format(java.util.Locale.US, "%.2f/%d", wakeScore, wakeRms);
        }

        @android.webkit.JavascriptInterface
        public String wakeRmsValue() {
            return String.valueOf(wakeRms);
        }

        @android.webkit.JavascriptInterface
        public void setAccent(String value) {
            final int idx;
            try {
                idx = Math.max(0, Math.min(2, Integer.parseInt(value)));
            } catch (Throwable t) {
                return;
            }
            prefs.edit().putInt(KEY_ACCENT, idx).apply();
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    accentPreset = idx;
                    applyNativeTheme();
                    if (voiceState == V_REC && micDraw != null) micDraw.setRecording(true);
                }
            });
        }

        @android.webkit.JavascriptInterface
        public String wakeState() {
            return wakeStateJson();
        }

        @android.webkit.JavascriptInterface
        public String wakeEventLines() {
            return wakeEventsJson();
        }

        @android.webkit.JavascriptInterface
        public void wakeSetEnabled(final String value) {
            final boolean on = "1".equals(value) || "true".equals(value);
            // 持久化：存在 SharedPreferences（KEY_WAKE_ON），重启后仍是上次的开/关状态。
            // 这里是唯一真相：wakeStateJson()/wakeEnabled()/startWakeIfNeeded() 都只读它。
            prefs.edit().putBoolean(KEY_WAKE_ON, on).apply();
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    /*
                     * 关：停掉板内 WakeNet（wakeLocal），释放麦克风并把它置空；
                     *     之后任何 startWakeIfNeeded() 路径都会先看 wake_enabled 直接 return。
                     * 开：只有在「鹈鹕屏 + 前台 + 不在录音/转写」时才真的启动 ——
                     *     正在录音或转录时切开关绝不打断当前流程，录完 scheduleWakeRestart 会自己接上。
                     */
                    if (on) {
                        startWakeIfNeeded();
                    } else {
                        stopWake();   // 只停 wakeLocal（WakeEngine.stop 会掐麦并退出线程）
                    }
                    addWakeEvent("（唤醒开关）", on ? "已打开：重新监听唤醒词" : "已关闭：不再被唤醒词唤醒");
                }
            });
        }

        /** 当前唤醒开关状态："1" 开 / "0" 关（DSH 端设置页据此渲染开关）。 */
        @android.webkit.JavascriptInterface
        public String wakeEnabled() {
            return wakeOn() ? "1" : "0";
        }

        /** 一键反转（DSH 端只放一个开关时用），返回反转后的状态："1"/"0"。 */
        @android.webkit.JavascriptInterface
        public String wakeToggle() {
            final boolean next = !wakeOn();
            wakeSetEnabled(next ? "1" : "0");
            return next ? "1" : "0";
        }

        @android.webkit.JavascriptInterface
        public void wakeReload() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    stopWake();
                    startWakeIfNeeded();
                    addWakeEvent("（引擎）", "手动重载");
                }
            });
        }
    }

    /** 原生这一侧的配色：音量条 / 提示胶囊 / 切屏圆钮 / 齿轮 / 麦克风 / 系统栏。 */
    private void applyNativeTheme() {
        boolean light = lightTheme;
        int panel = light ? L_CARD : 0xD9101820;
        int line = light ? L_LINE : 0x553FB6A8;
        int fg = light ? L_TEXT : TEXT;
        int dim = light ? L_DIM : DIM;
        int accent = light ? L_ACCENT : TEAL;

        if (volumeBar != null && volumeBar instanceof VolumeBar) {
            ((VolumeBar) volumeBar).setLight(light);
            ((VolumeBar) volumeBar).setAccent(accentMain());
            ((VolumeBar) volumeBar).setState(volumePctValue, volumeMuted);
        }
        if (muteBtn != null) muteBtn.setTextColor(volumeMuted ? dim : accent);
        if (volumePct != null) volumePct.setTextColor(volumeMuted ? dim : fg);
        if (settingsBtn != null) {
            settingsBtn.setBackground(roundBg(light ? 0xFFF3F4F6 : 0x33101820, 8, light ? L_LINE : 0x441F2A37));
            settingsBtn.setTextColor(fg);
        }

        if (screenBtn != null) {
            screenBtn.setBackground(roundBg(light ? 0xF2FFFFFF : 0xCC101820, 23, light ? L_ACCENT : 0xCC3FB6A8));
            screenBtn.setTextColor(light ? L_TEXT : 0xFFEAF6F4);
        }
        if (micBtn != null) setMicLook(voiceState == V_REC);
        if (cancelBtn != null) cancelBtn.setTextColor(light ? L_TEXT : 0xFFDCE6EC);
        if (connDot != null) setConnDot(connState);
        if (tihuWeb != null) tihuWeb.setBackgroundColor(light ? L_BG : 0xFF0B0F14);
        applySystemBars(light && onTihu);
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

    // ------------------------------------------------------- 底部语音条

    private void buildVoiceBar() {
        FrameLayout bar = new FrameLayout(this);
        bar.setVisibility(View.GONE);
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        blp.gravity = Gravity.BOTTOM;
        root.addView(bar, blp);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(dp(12), dp(8), dp(12), dp(10));
        bar.addView(col, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 音量条（只在鹈鹕屏出现）：只控制页面里的朗读音量，不碰系统媒体音量。
        // 位置在显示屏正下方、麦克风按钮上方，高 38dp，不挤压显示屏（页面那边有 padding-bottom）。
        VolumeBar vol = new VolumeBar(this);
        vol.setListener(new VolumeBar.Listener() {
            @Override
            public void onVolumeChanged(int pct, boolean muted) {
                if (pct > 0) {
                    volumePctValue = pct;
                    volumeLastNonZero = pct;
                    volumeMuted = false;
                } else {
                    volumeMuted = true;
                }
                if (volumeBar instanceof VolumeBar) ((VolumeBar) volumeBar).setState(volumePctValue, volumeMuted);
                applyTihuVolume();
                saveVolume();
            }

            @Override
            public void onGearClick() {
                openTihuSettings();
            }
        });
        LinearLayout.LayoutParams vrlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        vrlp.bottomMargin = dp(6);
        col.addView(vol, vrlp);
        volumeBar = vol;
        vol.setState(volumePctValue, volumeMuted);


        
        recLine = new TextView(this);
        recLine.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        recLine.setGravity(Gravity.CENTER);
        recLine.setTextColor(lightTheme ? L_DIM : DIM);
        recLine.setVisibility(View.GONE);
        LinearLayout.LayoutParams rllp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rllp.bottomMargin = dp(2);
        col.addView(recLine, rllp);

        wave = new WaveView(this);
        wave.setVisibility(View.INVISIBLE);
        LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        wlp.bottomMargin = dp(4);
        col.addView(wave, wlp);

        FrameLayout row = new FrameLayout(this);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(124));
        rlp.bottomMargin = dp(24);
        col.addView(row, rlp);

        micBtn = new TextView(this);
        micDraw = new RecorderButtonDrawable();
        micDraw.setDensity(getResources().getDisplayMetrics().density);
        micBtn.setBackground(micDraw);
        micBtn.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        micBtn.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent e) {
                if (e.getActionMasked() == MotionEvent.ACTION_DOWN) {
                    v.animate().scaleX(0.96f).scaleY(0.96f).setDuration(90).start();
                    if (micDraw != null) micDraw.setPressed(true);
                } else if (e.getActionMasked() == MotionEvent.ACTION_UP
                        || e.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                    v.animate().scaleX(1f).scaleY(1f).setDuration(120).start();
                    if (micDraw != null) micDraw.setPressed(false);
                }
                return false;
            }
        });
        micBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        micBtn.setTextColor(lightTheme ? L_ACCENT : Color.WHITE);
        micBtn.setGravity(Gravity.CENTER);
        setMicLook(false);
        micBtn.setContentDescription("语音输入");
        micBtn.setClickable(true);
        // 正方形按钮：可点区域正好盖住那圈圆环（2026-11-13 极简化后不再是 96×128 的机身）。
        FrameLayout.LayoutParams mlp = new FrameLayout.LayoutParams(dp(112), dp(112));
        mlp.gravity = Gravity.CENTER;
        row.addView(micBtn, mlp);

        cancelBtn = new TextView(this);
        cancelBtn.setText("× 取消");
        cancelBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        cancelBtn.setTextColor(lightTheme ? 0xFF334155 : 0xFFDCE6EC);
        cancelBtn.setGravity(Gravity.CENTER);
        GradientDrawable cbg = new GradientDrawable();
        cbg.setShape(GradientDrawable.RECTANGLE);
        cbg.setCornerRadius(dp(20));
        cbg.setColor(lightTheme ? 0xFFEEF2F4 : 0xFF1B2430);
        cbg.setStroke(dp(1), lightTheme ? 0xFFDDE3E8 : 0x44FFFFFF);
        cancelBtn.setBackground(cbg);
        cancelBtn.setVisibility(View.GONE);
        cancelBtn.setContentDescription("取消这次录音");
        cancelBtn.setClickable(true);
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(dp(96), dp(40));
        clp.gravity = Gravity.START | Gravity.CENTER_VERTICAL;
        row.addView(cancelBtn, clp);

        voiceBar = bar;

        micBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onMicClick();
            }
        });
        cancelBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                cancelVoice(true);
            }
        });

        syncVolumeUi();
    }

    // ------------------------------------------- 鹈鹕朗读音量（WebAudio，不碰系统音量）

    /** 滑块/百分比/静音图标三者与真实状态对齐（设置进度不会反过来再触发下发）。 */
    private void syncVolumeUi() {
        int shown = volumeMuted ? 0 : volumePctValue;
        if (volumeBar instanceof VolumeBar) ((VolumeBar) volumeBar).setState(volumePctValue, volumeMuted);
        
        if (muteBtn != null) {
            muteBtn.setText(volumeMuted ? "🔇" : "🔊");
            muteBtn.setTextColor(volumeMuted ? DIM : TEAL);
        }
        if (volumePct != null) {
            volumePct.setText(shown + "%");
            volumePct.setTextColor(volumeMuted ? DIM : TEXT);
        }

    }

    /** 一键静音 / 恢复上次音量。 */
    private void toggleMute() {
        if (volumeMuted) {
            volumeMuted = false;
            if (volumePctValue <= 0) {
                volumePctValue = volumeLastNonZero > 0 ? volumeLastNonZero : 80;
            }
        } else {
            if (volumePctValue > 0) volumeLastNonZero = volumePctValue;
            volumeMuted = true;
        }
        syncVolumeUi();
        applyTihuVolume();
        saveVolume();
    }

    /** 把当前音量（0–100，静音按 0 算）下发给页面：只调 WebAudio 的 masterGain。 */
    private void applyTihuVolume() {
        if (tihuWeb == null || !tihuReady) return;
        double v = (volumeMuted ? 0 : volumePctValue) / 100.0;
        String js = "window.__tihuSetVolume&&window.__tihuSetVolume("
                + String.format(java.util.Locale.US, "%.3f", v) + ")";
        tihuWeb.evaluateJavascript(js, null);
    }

    private void saveVolume() {
        prefs.edit().putInt(KEY_VOL, volumePctValue).putBoolean(KEY_MUTED, volumeMuted).apply();
    }

    /** 齿轮：打开页面里的「鹈鹕设置」面板（面板与节点搬移都在注入脚本里，见 settingsJs）。 */
    private void openTihuSettings() {
        if (tihuWeb == null || !tihuReady) {
            showErrorLine("鹈鹕页面还没准备好");
            return;
        }
        tihuWeb.evaluateJavascript(
                "window.__tihuPanel&&window.__tihuPanel.open&&window.__tihuPanel.open()", null);
    }

    // ---- 连接状态小圆点（替代被隐藏的 header 行 #conn） ----

    /** 每 3 秒问一次页面的 #conn，把「已连接/断开/连接中」映射成音量条左端那颗小点。 */
    private final Runnable connTick = new Runnable() {
        @Override
        public void run() {
            handler.removeCallbacks(this);
            // 1.3.8：顺手复核一次浮层可见性。页面内 pushState / 会话跳转不一定触发
            // onPageStarted/Finished，3 秒一次的轮询保证「助手页 + 鹈鹕浮层」不会长期残留。
            refreshChrome();
            if (onTihu && tihuWeb != null && tihuReady) {
                tihuWeb.evaluateJavascript(
                        "(function(){try{var c=document.getElementById('conn');if(!c){return 'none';}"
                                + "var s=String(c.className||'');"
                                + "if(s.indexOf('off')>=0){return 'off';}"
                                + "if(s.indexOf('on')>=0){return 'on';}"
                                + "return 'idle';}catch(e){return 'none';}})()",
                        new android.webkit.ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (value == null) return;
                                setConnDot(value.replace("\"", ""));
                            }
                        });
            }
            handler.postDelayed(this, 3000);
        }
    };

    private void startConnPolling() {
        handler.removeCallbacks(connTick);
        handler.postDelayed(connTick, 800);
    }

    private void stopConnPolling() {
        handler.removeCallbacks(connTick);
    }

    private void setConnDot(String state) {
        connState = state == null ? "idle" : state;
        if (connDot == null) return;
        int color;
        if ("on".equals(state)) color = lightTheme ? L_ACCENT : TEAL;
        else if ("off".equals(state)) color = RED;
        else color = lightTheme ? 0xFF9CA3AF : 0xFF6B7785;
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(color);
        connDot.setBackground(d);
    }

    private void setMicLook(boolean recording) {
        if (micBtn == null) return;
        if (micDraw == null) {
            micDraw = new RecorderButtonDrawable();
            micDraw.setDensity(getResources().getDisplayMetrics().density);
            micBtn.setBackground(micDraw);
        }
        micDraw.setColors(accentMain(), accentSecond(), lightTheme);
        micDraw.setRecording(recording);

        micBtn.setText("");
    }

    private void startPulse() {
        stopPulse();
        pulseAnim = android.animation.ValueAnimator.ofFloat(0f, 1f);
        pulseAnim.setDuration(900);
        pulseAnim.setRepeatCount(android.animation.ValueAnimator.INFINITE);
        pulseAnim.setRepeatMode(android.animation.ValueAnimator.REVERSE);
        pulseAnim.addUpdateListener(new android.animation.ValueAnimator.AnimatorUpdateListener() {
            @Override
            public void onAnimationUpdate(android.animation.ValueAnimator a) {
                float v = (Float) a.getAnimatedValue();
                float s = 1f + 0.07f * v;
                micBtn.setScaleX(s);
                micBtn.setScaleY(s);
                micBtn.setAlpha(1f - 0.18f * v);
            }
        });
        pulseAnim.start();
    }

    private void stopPulse() {
        if (pulseAnim != null) {
            try {
                pulseAnim.cancel();
            } catch (Throwable ignored) {
                // 忽略
            }
            pulseAnim = null;
        }
        if (micBtn != null) {
            micBtn.setScaleX(1f);
            micBtn.setScaleY(1f);
            micBtn.setAlpha(1f);
        }
    }

    private void showErrorLine(final String text) {
        if (recLine == null) return;
        recLine.setTextColor(0xFFDC2626);
        recLine.setText(text);
        recLine.setVisibility(View.VISIBLE);
        final Object tok = "errline";
        handler.removeCallbacksAndMessages(tok);
        handler.postAtTime(new Runnable() {
            @Override
            public void run() {
                if (recLine != null) {
                    recLine.setText("");
                    recLine.setVisibility(View.GONE);
                }
            }
        }, tok, SystemClock.uptimeMillis() + 3000);
    }

    /** 结束/取消后把状态行整个收掉（不弹任何东西）。 */
    private void clearStatusLine() {
        if (recLine != null) {
            handler.removeCallbacksAndMessages("errline");
            recLine.setText("");
            recLine.setVisibility(View.GONE);
        }
    }

    private void setVoiceState(int st) {
        voiceState = st;
        boolean busy = (st == V_REC || st == V_ASR);
        if (cancelBtn != null) cancelBtn.setVisibility(busy || st == V_ERR ? View.VISIBLE : View.GONE);
        if (st != V_REC) {
            stopPulse();
        }
        if (st == V_REC) {
            // 2026-11-13：录音按钮改成「话筒 + 一圈圆环」后不再做呼吸放大（那是多余装饰），
            // 状态只靠圆环颜色与上方那行「在听…」文字表达。
            stopPulse();
            micBtn.setEnabled(true);
        } else if (st == V_ASR) {
            setMicLook(false);
            micBtn.setAlpha(0.55f);
        } else if (st == V_DONE) {
            setMicLook(false);
        } else if (st == V_ERR) {
            setMicLook(false);
        } else {
            setMicLook(false);
        }
        if (st == V_REC) setVoicePad(PAD_REC);
        else if (st == V_IDLE || st == V_DONE || st == V_ERR) setVoicePad(PAD_IDLE);
    }

    /** 让页面底部留出语音条的高度（注入 CSS 变量，只在小屏生效）。 */
    private void setVoicePad(final int px) {
        if (tihuWeb == null || !tihuReady) return;
        tihuWeb.evaluateJavascript(
                "window.__tihuVoicePad&&window.__tihuVoicePad(" + px + ");", null);
    }

    /** 当前真正显示的页面是不是鹈鹕页（onTihu 只表示「停在鹈鹕屏」，不代表 URL 还是 /tihu）。 */
    private boolean currentPageIsTihu() {
        if (!onTihu || !tihuReady || tihuWeb == null) return false;
        return TihuVoiceUtil.isTihuPage(tihuWeb.getUrl());
    }

    /** 悬浮按钮 / 语音条在覆盖页（设置、错误、等待）出现时让位。 */
    private void refreshChrome() {
        boolean block = (setupView != null && setupView.getVisibility() == View.VISIBLE)
                || (errorView != null && errorView.getVisibility() == View.VISIBLE)
                || (tihuErrorView != null && tihuErrorView.getVisibility() == View.VISIBLE)
                || (loadingView != null && loadingView.getVisibility() == View.VISIBLE);
        // 1.3.8：原生浮层（录音按钮 + 音量条）只属于「当前 URL 确实是 /tihu」的鹈鹕页。
        // 不能只看 onTihu：鹈鹕 WebView 被页面自己导航到助手路由后，onTihu 仍为 true，
        // 旧写法就会在个人助手页面上露出鹈鹕浮层并拦截触摸。
        boolean tihuSurface = currentPageIsTihu() && !panelOpen;
        boolean show = !block && tihuSurface;
        // 切屏球：两个屏都要有，面板打开时也在（用户靠它切回去）；只让位给设置/错误/等待这些全屏页
        if (screenBtn != null) {
            screenBtn.setVisibility(block ? View.GONE : View.VISIBLE);
        }
        if (voiceBar != null) {
            voiceBar.setVisibility(show ? View.VISIBLE : View.GONE);
        }
    }

    // ------------------------------------------------------- 语音：点击入口

    private void onMicClick() {
        if (!onTihu) {
            switchScreen(true, true);
            return;
        }
        if (voiceState == V_REC) {
            stopRecording(false);
            return;
        }
        if (voiceState == V_ASR) {
    
            return;
        }
        if (!tihuReady || tihuWeb == null) {
            showErrorLine("鹈鹕页面还没加载完，等两三秒再按");
            showErrorLine("页面还没就绪，稍等一下再按");
            return;
        }
        if (voiceState == V_ERR && !TextUtils.isEmpty(pendingText)) {
            // 上次转写成功但页面注入失败：直接把那段文字再发一次
            setVoiceState(V_ASR);
                injectText(pendingText);
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        startRecording();
    }

    // ------------------------------------------------------- 语音：录音

    private void startRecording() {
        // 录音期间禁止朗读（2026-11-13）：按下这一瞬间先让页面掐掉正在念的 PCM 并开闸门，
        // 再开麦 —— 顺序反了的话，提示音/朗读的尾巴会被录进去，麦克风也已经占上了。
        jsRecGate(true);
        playTone(ToneFx.START);
        String asr = TihuVoiceUtil.asrUrlOf(tihuUrl());
        if (TextUtils.isEmpty(asr)) {
            jsRecGate(false);
            setVoiceState(V_ERR);
            showErrorLine("鹈鹕地址推不出语音接口：" + TihuVoiceUtil.asrUrlProblem(tihuUrl()));
            showErrorLine("先到设置里把鹈鹕地址填成 http(s):// 开头");
            return;
        }
        pendingText = null;
        lastAsrText = null;
        recStop = false;
        recCancelled = false;
        autoStopped = false;
        final int gen = ++voiceGen;

        AudioRecord rec = null;
        int bufSize = 0;
        try {
            int min = AudioRecord.getMinBufferSize(TihuVoiceUtil.SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            bufSize = Math.max(min > 0 ? min : 4096, 6400);
            rec = createRecorder(MediaRecorder.AudioSource.VOICE_RECOGNITION, bufSize);
            if (rec == null) rec = createRecorder(MediaRecorder.AudioSource.MIC, bufSize);
        } catch (Throwable t) {
            rec = null;
        }
        if (rec == null) {
            jsRecGate(false);
            setVoiceState(V_ERR);
            showErrorLine("打不开麦克风（可能被别的应用占着）");
            showErrorLine("麦克风打不开");
            return;
        }

        recorder = rec;
        final AudioRecord r = rec;
        final int buf = bufSize;
        try {
            r.startRecording();
        } catch (Throwable t) {
            try {
                r.release();
            } catch (Throwable ignored) {
                // 忽略
            }
            recorder = null;
            jsRecGate(false);
            setVoiceState(V_ERR);
            showErrorLine("录音启动失败：" + t.getMessage());
            return;
        }

        recStartMs = SystemClock.elapsedRealtime();
        setMicLook(true);
        stopWake();
        setVoiceState(V_REC);
        setBallRecordingMode(true);
        wave.begin();
        recProgress = 0f;
        if (recLine != null) {
            recLine.setText("在听… 0:00 · 再点一下结束（满 3 分钟自动发送）");
            recLine.setVisibility(View.VISIBLE);
            recLine.setTextColor(lightTheme ? L_DIM : DIM);
        }
        handler.removeCallbacks(recProgTick);
        handler.postDelayed(recProgTick, 200);
        recThread = new Thread(new Runnable() {
            @Override
            public void run() {
                ByteArrayOutputStream out = new ByteArrayOutputStream(32000 * 8);
                short[] bufShorts = new short[Math.max(1600, buf / 2)];
                byte[] bufBytes = new byte[bufShorts.length * 2];
                boolean auto = false;
                try {
                    while (!recStop) {
                        int n = r.read(bufShorts, 0, bufShorts.length);
                        if (n > 0) {
                            double sum = 0;
                            int peak = 0;
                            for (int i = 0; i < n; i++) {
                                short s = bufShorts[i];
                                int a = s < 0 ? -s : s;
                                if (a > peak) peak = a;
                                sum += (double) s * (double) s;
                                bufBytes[2 * i] = (byte) (s & 0xFF);
                                bufBytes[2 * i + 1] = (byte) ((s >> 8) & 0xFF);
                            }
                            try {
                                out.write(bufBytes, 0, n * 2);
                            } catch (Throwable ignored) {
                                // 内存吃紧就丢掉这一小段
                            }
                            double rms = Math.sqrt(sum / Math.max(1, n));
                            wave.postLevel((float) rms, (float) peak);
                        } else if (n < 0) {
                            break;
                        }
                        if (SystemClock.elapsedRealtime() - recStartMs >= REC_MAX_MS) {
                            auto = true;
                            break;
                        }
                    }
                } catch (Throwable ignored) {
                    // 录音异常：按已录到的部分收尾
                }
                try {
                    r.stop();
                } catch (Throwable ignored) {
                    // 忽略
                }
                try {
                    r.release();
                } catch (Throwable ignored) {
                    // 忽略
                }
                recorder = null;
                final byte[] pcm = out.toByteArray();
                final boolean autoStop = auto;
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (autoStop) {
                            /*
                             * 到 3 分钟上限：走和手动点「结束」完全相同的收尾
                             * （提示音 + 解除录音静音闸门 + 切到「正在转写」），
                             * 然后照常上传转写 —— 绝不取消、不丢这段录音。
                             */
                            stopRecording(true);
                            if (recLine != null) {
                                recLine.setText("已到 3 分钟上限 · 正在转写发送…");
                                recLine.setVisibility(View.VISIBLE);
                            }
                        }
                        onRecordingFinished(gen, pcm, autoStop);
                    }
                });
            }
        }, "tihu-rec");
        recThread.start();
    }

    private AudioRecord createRecorder(int source, int bufSize) {
        try {
            AudioRecord r = new AudioRecord(source, TihuVoiceUtil.SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize);
            if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                try {
                    r.release();
                } catch (Throwable ignored) {
                    // 忽略
                }
                return null;
            }
            return r;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 用户点「结束」或 3 分钟上限（auto=true 时是上限自动收尾，仍照常发送）。 */
    private void stopRecording(boolean auto) {
        recStop = true;
        // 收麦＝录音结束：提示音 + 恢复朗读（页面那边解除静音闸门）。
        playTone(ToneFx.STOP);
        jsRecGate(false);
        handler.removeCallbacks(recProgTick);
        recProgress = 0f;
        if (micDraw != null) micDraw.setRecording(false);
        if (recLine != null) {
            recLine.setText("正在转写…");
            recLine.setVisibility(View.VISIBLE);
        }
        autoStopped = auto;
        if (voiceState == V_REC) {
            stopPulse();
                voiceState = V_ASR;
            if (cancelBtn != null) cancelBtn.setVisibility(View.VISIBLE);
            wave.collapse();
            setVoicePad(PAD_IDLE);
        }
    }

    private void onRecordingFinished(int gen, byte[] pcm, boolean auto) {
        if (gen != voiceGen || recCancelled) {
            // 已经被取消：丢弃，绝不发送
            return;
        }
        stopPulse();
        if (pcm == null || pcm.length < 3200) {
            setVoiceState(V_ERR);
            showErrorLine("录到的声音太短，再说一次");
            wave.collapse();
            return;
        }
        byte[] wav = TihuVoiceUtil.wrapWav(pcm);
        setVoiceState(V_ASR);
        wave.collapse();
        uploadWav(gen, wav);
    }

    /** 取消：立刻停录、断开在途上传、清掉待发文本，什么都不发。 */
    private void cancelVoice(boolean tell) {
        playTone(ToneFx.CANCEL);
        jsRecGate(false);
        boolean wasBusy = (voiceState == V_REC || voiceState == V_ASR);
        voiceGen++;
        recStop = true;
        recCancelled = true;
        pendingText = null;
        if (asrConn != null) {
            try {
                asrConn.disconnect();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        if (recorder != null) {
            try {
                recorder.stop();
            } catch (Throwable ignored) {
                // 忽略
            }
            try {
                recorder.release();
            } catch (Throwable ignored) {
                // 忽略
            }
            recorder = null;
        }
        setBallRecordingMode(false);
        stopPulse();
        handler.removeCallbacks(recProgTick);
        recProgress = 0f;
        if (micDraw != null) micDraw.setRecording(false);
        clearStatusLine();
        wave.collapse();
        setVoiceState(V_IDLE);
        setVoicePad(PAD_IDLE);
        scheduleWakeRestart();


    }

    // ------------------------------------------------------- 语音：上传转写

    private void uploadWav(final int gen, final byte[] wav) {
        final String asrUrl = TihuVoiceUtil.asrUrlOf(tihuUrl());
        final boolean plainHttp = asrUrl.toLowerCase().startsWith("http://");
        new Thread(new Runnable() {
            @Override
            public void run() {
                int code = -1;
                String body = null;
                String err = null;
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(asrUrl).openConnection();
                    asrConn = conn;
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(10000);
                    // 3 分钟录音：whisper.cpp 在 CPU 上要几十秒，45 秒会把长录音判成网络失败。
                    conn.setReadTimeout(180000);
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(wav.length);
                    conn.setRequestProperty("Content-Type", "audio/wav");
                    conn.setRequestProperty("Accept", "application/json");
                    OutputStream os = conn.getOutputStream();
                    try {
                        os.write(wav);
                        os.flush();
                    } finally {
                        try {
                            os.close();
                        } catch (Throwable ignored) {
                            // 忽略
                        }
                    }
                    code = conn.getResponseCode();
                    InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
                    body = readAll(is);
                } catch (Throwable t) {
                    err = t.getClass().getSimpleName() + (t.getMessage() == null ? "" : (": " + t.getMessage()));
                } finally {
                    asrConn = null;
                    if (conn != null) {
                        try {
                            conn.disconnect();
                        } catch (Throwable ignored) {
                            // 忽略
                        }
                    }
                }
                final int fCode = code;
                final String fBody = body;
                final String fErr = err;
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        onAsrResponse(gen, fCode, fBody, fErr, plainHttp);
                    }
                });
            }
        }, "tihu-asr").start();
    }

    private void onAsrResponse(int gen, int code, String body, String err, boolean plainHttp) {
        if (gen != voiceGen) return; // 已作废（用户中断）
        String text = "";
        String apiErr = null;
        if (body != null && !body.isEmpty()) {
            try {
                JSONObject o = new JSONObject(body);
                text = o.optString("text", "");
                apiErr = o.optString("error", "");
            } catch (Throwable t) {
                apiErr = "转写服务返回的不是 JSON";
            }
        }
        if (TextUtils.isEmpty(text)) {
            setVoiceState(V_ERR);
            String msg;
            if (apiErr != null && !apiErr.isEmpty()) {
                msg = "转写失败：" + apiErr;
            } else if (code > 0) {
                msg = "转写失败：HTTP " + code;
            } else {
                msg = "转写失败：" + (err == null ? "网络不通" : err);
            }
            if (plainHttp) {
                msg += "（鹈鹕地址是 http 明文，若系统限制明文请求，可换成 https）";
            }
            showErrorLine(msg);
    
            return;
        }
        lastAsrText = text;
        pendingText = text;
        showProposal(text);
    }

    /** 先把「当前界面」摘要从真实 DOM 抓出来，再拼成一条 text.input 发出去。 */
    private void injectText(final String text) {
        if (tihuWeb == null || !tihuReady) {
            setVoiceState(V_ERR);
            showErrorLine("页面还没准备好，文字没发出去");
            return;
        }
        final int gen = voiceGen;
        tihuWeb.evaluateJavascript("window.__tihuContext?window.__tihuContext():''",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (gen != voiceGen) return;
                        String ctx = "";
                        if (value != null && !"null".equals(value) && !"\"\"".equals(value)) {
                            try {
                                ctx = new JSONObject("{\"v\":" + value + "}").optString("v", "");
                            } catch (Throwable t) {
                                ctx = value.replace("\"", "");
                            }
                        }
                        if (ctx == null) ctx = "";
                        sendToPage(text, ctx.trim(), gen);
                    }
                });
    }

    private void sendToPage(final String text, final String ctx, final int startGen) {
        final int gen = startGen;
        final boolean hasCtx = ctx != null && !ctx.trim().isEmpty();
        final String combined = hasCtx ? (text + "\n【当前界面】" + ctx) : text;
        tihuWeb.evaluateJavascript(TihuVoiceUtil.buildSendJs(combined),
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (gen != voiceGen) return;
                        boolean ok = false;
                        String e = null;
                        String transcript = "";
                        if (value != null && !"null".equals(value)) {
                            try {
                                JSONObject o = new JSONObject(value);
                                ok = o.optBoolean("ok", false);
                                e = o.optString("error", "");
                                transcript = o.optString("transcript", "");
                            } catch (Throwable t) {
                                e = "页面返回看不懂：" + value;
                            }
                        } else {
                            e = "页面没有返回结果（可能已经跳走）";
                        }
                        if (ok) {
                            pendingText = null;
                            setVoiceState(V_DONE);
                            clearStatusLine();
                            scheduleWakeRestart();
                        } else {
                            setVoiceState(V_ERR);
                            showErrorLine("页面没确认发送"
                                    + (TextUtils.isEmpty(e) ? "" : "：" + e));
                            pendingText = text;
                        }
                    }
                });
    }

    private String readAll(InputStream is) {
        if (is == null) return "";
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = is.read(b)) > 0) {
                out.write(b, 0, n);
                if (out.size() > 1 << 20) break;
            }
            return new String(out.toByteArray(), Charset.forName("UTF-8"));
        } catch (Throwable t) {
            return "";
        } finally {
            try {
                is.close();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }

    // ------------------------------------------------------- 波形动画 View

    /**
     * 实时波形：30 根对称竖柱，高度来自录音线程算好的 RMS/峰值。
     * 纯 Canvas 绘制（无第三方库），每帧只重算 30 个浮点数，30fps，主线程不卡。
     * 静音时保留一点呼吸感；结束/取消后平滑收起再隐藏。
     */
    private class WaveView extends View {
        private static final int BARS = 32;
        private final float[] shown = new float[BARS];
        private final float[] weight = new float[BARS];
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private volatile float level;
        private volatile float peak;
        private boolean running;
        private boolean collapsing;
        private long t0;
        private LinearGradient shader;
        private int lastW;
        private int lastH;
        private final Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (!running) return;
                invalidate();
                // 收起动画：柱子都落回 0 之后自己停帧并隐藏，不然会一直挂着一排平线在屏幕上
                if (collapsing && fadedOut()) {
                    running = false;
                    setVisibility(View.INVISIBLE);
                    return;
                }
                postDelayed(this, 33);
            }
        };

        private boolean fadedOut() {
            for (int i = 0; i < BARS; i++) {
                if (shown[i] > 0.006f) return false;
            }
            return true;
        }

        WaveView(Context c) {
            super(c);
            float seed = 7f;
            for (int i = 0; i < BARS; i++) {
                // 固定的伪随机权重（中间高、两边低 + 每根略微不同），看起来像频谱而不是一根齐平的柱子
                float center = 1f - Math.abs(i - (BARS - 1) / 2f) / ((BARS - 1) / 2f);
                seed = (seed * 9301f + 49297f) % 233280f;
                float r = seed / 233280f;
                weight[i] = 0.32f + 0.68f * (float) Math.sqrt(center) * (0.55f + 0.45f * r);
            }
        }

        void begin() {
            t0 = SystemClock.elapsedRealtime();
            running = true;
            collapsing = false;
            level = 0;
            peak = 0;
            for (int i = 0; i < BARS; i++) shown[i] = 0.06f;
            setVisibility(View.VISIBLE);
            removeCallbacks(tick);
            postDelayed(tick, 33);
        }

        void postLevel(float rms, float peakAbs) {
            // 归一化：RMS 约 3000 已经是很正常的人声；超过 30 就顶满
            float l = rms / 3000f;
            if (l > 1f) l = 1f;
            level = l;
            float p = peakAbs / 32768f * 3f;
            if (p > 1f) p = 1f;
            peak = p;
        }

        void collapse() {
            collapsing = true;
            level = 0;
            peak = 0;
            if (!running) {
                setVisibility(View.INVISIBLE);
            }
        }

        @Override
        protected void onDraw(Canvas canvas) {
            int w = getWidth();
            int h = getHeight();
            if (w <= 0 || h <= 0) return;
            if (shader == null || w != lastW || h != lastH) {
                lastW = w;
                lastH = h;
                shader = new LinearGradient(0, h, 0, 0,
                        new int[]{0xFF0F766E, 0xFF1D4ED8, 0xFF0F766E},
                        new float[]{0f, 0.5f, 1f}, Shader.TileMode.CLAMP);
            }
            paint.setShader(shader);

            float gap = dp(5);
            float bw = dp(3);
            float total = bw * BARS + gap * (BARS - 1);
            float x0 = (w - total) / 2f;
            float cy = h / 2f;
            float maxH = Math.min(dp(72), h) - dp(8);
            long now = SystemClock.elapsedRealtime() - t0;

            float target;
            for (int i = 0; i < BARS; i++) {
                if (collapsing) {
                    target = 0f;
                } else {
                    float breathe = 0.055f + 0.035f * (float) Math.sin(now / 620.0 + i * 0.42);
                    float amp = Math.max(level * weight[i], peak * weight[i] * 0.55f);
                    target = breathe + amp;
                    if (target > 1f) target = 1f;
                }
                // 上升快（0.45）、下降慢（0.16）：像真的电平表，不会抖
                float k = target > shown[i] ? 0.45f : 0.16f;
                shown[i] += (target - shown[i]) * k;
                if (shown[i] < 0.004f) shown[i] = 0f;
            }

            float x = x0;
            float r = Math.min(bw / 2f, 3f);
            for (int i = 0; i < BARS; i++) {
                float bh = shown[i] * maxH;
                if (bh < 2f) bh = 2f;
                canvas.drawRoundRect(x, cy - bh / 2f, x + bw, cy + bh / 2f, r, r, paint);
                x += bw + gap;
            }

            if (collapsing && !running) return;
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
        if (tihuErrorView != null && tihuErrorView.getVisibility() == View.VISIBLE) {
            hideTihuError();
            refreshChrome();
            return;
        }
        if (voiceState == V_REC || voiceState == V_ASR) {
            cancelVoice(true);
            return;
        }
        WebView cur = onTihu ? tihuWeb : web;
        if (cur != null && cur.canGoBack()) {
            cur.goBack();
            // goBack 可能是 /tihu → 助手路由：先立刻收浮层，再等页面回调复核一次。
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
     * 返回键菜单（1.4.2）：只留「设置地址 / 重新加载页面 / 退出应用」三项。
     *
     * 已删：「鹈鹕屏」和「回到助手屏」两项。切屏不靠这个菜单——
     * 左下角那颗常驻切屏球才是唯一入口（助手屏上写「鹈」，鹈鹕屏上写「助」，点一下切过去），
     * 另外出错页有「回助手屏」、设置页连上也直接落到对应屏，所以两屏都还进得去。
     *
     * 也没有「取消」按钮：AlertDialog 默认 cancelable，点弹窗外面或按返回键就关掉
     * （弹窗有自己的 Window 抢焦点，不会落进 Activity 的 dispatchKeyEvent 里）。
     */
    private void showBackMenu() {
        final String[] items = new String[]{"设置地址", "重新加载页面", "退出应用"};
        AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle(onTihu ? "鹈鹕屏" : "个人助手")
                .setCancelable(true)
                .setItems(items, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        if (which == 0) {
                            showSetup(true);
                        } else if (which == 1) {
                            if (onTihu) {
                                if (tihuWeb != null) {
                                    tihuReady = false;
                                    tihuWeb.loadUrl(tihuUrl());
                                }
                            } else {
                                String saved = prefs.getString(KEY_URL, "");
                                if (TextUtils.isEmpty(saved)) showSetup(true);
                                else {
                                    hideError();
                                    web.loadUrl(saved);
                                }
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
        stopConnPolling();
        stopWake();
        if (voiceState == V_REC || voiceState == V_ASR) {
            cancelVoice(false);
        }
        if (web != null) {
            web.onPause();
        }
        if (tihuWeb != null) {
            tihuWeb.onPause();
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
        if (tihuWeb != null) tihuWeb.onResume();
        if (onTihu && tihuReady) startConnPolling();
        refreshChrome();
        startWakeIfNeeded();
        applySystemBars(lightTheme && onTihu);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        cancelVoice(false);
        if (web != null) {
            web.setWebChromeClient(null);
            web.setWebViewClient(null);
            screenHost.removeView(web);
            web.destroy();
            web = null;
        }
        if (tihuWeb != null) {
            tihuWeb.setWebChromeClient(null);
            tihuWeb.setWebViewClient(null);
            screenHost.removeView(tihuWeb);
            tihuWeb.destroy();
            tihuWeb = null;
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
        if (tihuWeb != null) {
            tihuWeb.getSettings().setTextZoom(100);
            tihuWeb.requestLayout();
            // 横竖屏切换后重新算一次缩放，避免 320px 设备框顶出横向滚动条
            tihuWeb.evaluateJavascript("window.__tihuFit&&window.__tihuFit();", null);
        }
        refreshChrome();
    }

    // ---------------------------------------------- 转录确认卡（1.3.0，1.5 秒自动发送）
    private LinearLayout cardView;
    private TextView cardText;
    private EditText cardEdit;
    private ProgressBar cardBar;
    private String cardPending;
    private boolean cardEditing;
    private static final long CARD_MS = 1500;
    private long cardStart;

    private final Runnable cardTick = new Runnable() {
        @Override
        public void run() {
            if (cardView == null || cardView.getVisibility() != View.VISIBLE || cardEditing) return;
            long dt = SystemClock.uptimeMillis() - cardStart;
            if (dt >= CARD_MS) {
                sendCard();
                return;
            }
            if (cardBar != null) cardBar.setProgress((int) (100 - dt * 100 / CARD_MS));
            handler.postDelayed(this, 40);
        }
    };

    private void buildCard() {
        cardView = new LinearLayout(this);
        cardView.setOrientation(LinearLayout.VERTICAL);
        cardView.setPadding(dp(14), dp(12), dp(14), dp(10));
        cardView.setBackground(roundBg(lightTheme ? 0xFFFFFFFF : 0xFF121821, 16,
                lightTheme ? 0xFFE5E7EB : 0xFF33414F));
        cardView.setElevation(dp(8));
        cardView.setVisibility(View.GONE);
        cardText = new TextView(this);
        cardText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        cardText.setTextColor(lightTheme ? 0xFF111827 : 0xFFE6EDF3);
        cardText.setMaxLines(6);
        cardText.setEllipsize(TextUtils.TruncateAt.END);
        cardView.addView(cardText);
        cardEdit = new EditText(this);
        cardEdit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        cardEdit.setTextColor(lightTheme ? 0xFF111827 : 0xFFE6EDF3);
        cardEdit.setVisibility(View.GONE);
        cardView.addView(cardEdit);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.END);
        TextView edit = new TextView(this);
        edit.setText("修改");
        edit.setPadding(dp(12), dp(8), dp(12), dp(8));
        edit.setTextColor(accentMain());
        edit.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                enterEdit();
            }
        });
        TextView cancel = new TextView(this);
        cancel.setText("取消");
        cancel.setPadding(dp(12), dp(8), dp(12), dp(8));
        cancel.setTextColor(lightTheme ? 0xFF6B7280 : 0xFF9CA3AF);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                dismissCard();
                playTone(ToneFx.CANCEL);
            }
        });
        row.addView(edit);
        row.addView(cancel);
        cardView.addView(row);
        cardBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        cardBar.setMax(100);
        cardBar.setProgress(100);
        cardView.addView(cardBar);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER_HORIZONTAL | Gravity.CENTER_VERTICAL;
        lp.leftMargin = dp(16);
        lp.rightMargin = dp(16);
        root.addView(cardView, lp);
    }

    private void showProposal(String text) {
        if (cardView == null) buildCard();
        cardPending = text;
        cardEditing = false;
        cardText.setText(text);
        cardText.setVisibility(View.VISIBLE);
        cardEdit.setVisibility(View.GONE);
        cardView.setVisibility(View.VISIBLE);
        cardView.setAlpha(0f);
        cardView.animate().alpha(1f).setDuration(150).start();
        cardStart = SystemClock.uptimeMillis();
        if (cardBar != null) cardBar.setProgress(100);
        handler.removeCallbacks(cardTick);
        handler.post(cardTick);
    }

    private void enterEdit() {
        cardEditing = true;
        handler.removeCallbacks(cardTick);
        cardText.setVisibility(View.GONE);
        cardEdit.setText(cardPending);
        cardEdit.setVisibility(View.VISIBLE);
        if (cardBar != null) cardBar.setProgress(100);
    }

    private void sendCard() {
        String text = cardEditing && cardEdit != null ? cardEdit.getText().toString().trim() : cardPending;
        dismissCard();
        if (text == null || text.isEmpty()) return;
        playTone(ToneFx.SENT);
        injectText(text);
    }

    private void dismissCard() {
        handler.removeCallbacks(cardTick);
        if (cardView == null) return;
        cardView.animate().alpha(0f).setDuration(120).withEndAction(new Runnable() {
            @Override
            public void run() {
                if (cardView != null) cardView.setVisibility(View.GONE);
            }
        }).start();
    }

    // ------------------------------------------------------------ 小工具

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void playTone(int kind) {
        if (!soundOn || !onTihu || !tihuReady) return;
        ToneFx.play(this, kind);
    }

    /**
     * 录音闸门（2026-11-13）：把「麦克风正在用」告诉页面。
     *
     * 页面里的朗读是 WebAudio 排在同一条时间轴上的 PCM，壳这边停不掉；
     * 只有页面自己 stop() 才真的静音 —— 所以开始录音前 __tihuRec(true)、收麦后 __tihuRec(false)。
     */
    private void jsRecGate(boolean on) {
        if (tihuWeb == null || !tihuReady) return;
        try {
            tihuWeb.evaluateJavascript(
                    "window.__tihuRec&&window.__tihuRec(" + (on ? "true" : "false") + ");", null);
        } catch (Throwable ignored) {
            // 页面还没注入这个桥（旧页面）：录音照常，只是回到旧行为
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}
