package com.chenpan.assistant;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 页面 → 原生的桥（2026-11-27「后台收任务完成 + 语音播报」需求）。
 *
 * 这是本应用第一个 @JavascriptInterface 桥（此前 JS 与原生之间只有 WebView 的
 * DownloadListener 这一条隐式通道）。挂在 window.DshAssistantNative 上，
 * 页面侧胶水在 src/client/pocket/orb/native-assistant-bridge.ts。
 *
 * 四件事：
 *   1. isAppInBackground()：原生视角的前后台标记（WebView 的 document.hidden 在个别
 *      ROM 上后台不报 hidden，原生标记是权威判据；onPause/onResume 里更新）；
 *   2. notifyTaskDone(title, text)：任务完成系统通知（渠道 dsh_task_done，高优先级，
 *      点一下回到 MainActivity——singleTask，直接浮回前台那个会话）；
 *   3. speakNative(key, text)：原生 TextToSpeech 播报。后台 WebView 的 AudioContext
 *      被挂起、定时器被节流，页面里那套微软 TTS + WebAudio 在后台不可靠，所以后台
 *      分支改由原生播报；key 去重表就是「已播报」标记——回到前台后页面不会因为
 *      重挂载把同一条再读一遍（页面侧 autoReadSeen 也有一份，双保险）；
 *   4. setKeepAliveEnabled/isKeepAliveEnabled：页面里也能切保活开关。
 *
 * 线程：@JavascriptInterface 方法跑在 WebView 的 JavaBridge 线程，TTS/通知都
 * 切回主线程再做。
 */
public class NativeBridge {

    private static final String TAG = "NativeBridge";

    /** 任务完成通知渠道（IMPORTANCE_HIGH：后台要 heads-up 看得见）。 */
    private static final String CHANNEL_TASK_DONE = "dsh_task_done";
    private static final int NOTIF_BASE_ID = 4201;

    /** 同一卡片 key 的原生播报去重窗口：10 分钟内同 key 只播一次。 */
    private static final long SPOKEN_DEDUP_MS = 10 * 60 * 1000;
    /** TextToSpeech 单次输入上限（引擎普遍 4000 字符），留余量切块。 */
    private static final int TTS_CHUNK = 3500;

    private final WeakReference<Activity> activityRef;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** 原生视角的后台标记：MainActivity.onPause/onResume 更新（静态，桥实例随 WebView 重建）。 */
    private static volatile boolean appInBackground;

    /** 已播报 key → 播报时刻（「已播报」标记；静态，WebView 重建也不丢）。 */
    private static final Map<String, Long> spokenKeys = new HashMap<>();

    private static TextToSpeech tts;
    private static boolean ttsReady;
    private static int notifSeq;

    public NativeBridge(Activity activity) {
        this.activityRef = new WeakReference<>(activity);
    }

    public static void setAppInBackground(boolean background) {
        appInBackground = background;
    }

    /* ---------------------------------------------------------- 前台/后台标记 */

    @JavascriptInterface
    public boolean isAppInBackground() {
        return appInBackground;
    }

    /* -------------------------------------------------------------- 保活开关 */

    @JavascriptInterface
    public boolean isKeepAliveEnabled() {
        Activity activity = activityRef.get();
        return activity != null && KeepAliveService.isEnabled(activity);
    }

    @JavascriptInterface
    public void setKeepAliveEnabled(final boolean enabled) {
        final Activity activity = activityRef.get();
        if (activity == null) return;
        KeepAliveService.setEnabled(activity, enabled);
    }

    /* ---------------------------------------------------------- 任务完成通知 */

    @JavascriptInterface
    public void notifyTaskDone(final String title, final String text) {
        main.post(new Runnable() {
            @Override
            public void run() {
                postTaskDoneNotification(title, text);
            }
        });
    }

    private void postTaskDoneNotification(String title, String text) {
        Activity activity = activityRef.get();
        if (activity == null) return;
        try {
            ensureTaskChannel(activity);
            Intent open = new Intent(activity, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent contentIntent = PendingIntent.getActivity(activity, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(activity, CHANNEL_TASK_DONE)
                    : new Notification.Builder(activity);
            builder.setSmallIcon(activity.getApplicationInfo().icon)
                    .setContentTitle(title == null || title.isEmpty() ? "个人助手 · 任务完成" : title)
                    .setContentText(text == null ? "" : text)
                    .setContentIntent(contentIntent)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_STATUS)
                    .setPriority(Notification.PRIORITY_HIGH);
            NotificationManager nm = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_BASE_ID + (notifSeq++ % 1000), builder.build());
        } catch (Throwable t) {
            Log.w(TAG, "任务完成通知发送失败：" + t);
        }
    }

    /** 任务完成通知渠道：高优先级（后台要看得见），但只响系统默认提示音一次。 */
    private void ensureTaskChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || nm.getNotificationChannel(CHANNEL_TASK_DONE) != null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_TASK_DONE, "任务完成", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("后台时任务完成的提醒；点通知回到会话");
            nm.createNotificationChannel(channel);
        }
    }

    /* ------------------------------------------------------------ 原生 TTS */

    @JavascriptInterface
    public boolean speakNative(final String key, final String text) {
        if (text == null || text.trim().isEmpty()) return false;
        // 「已播报」去重：同一张卡片的 key 在窗口期内只播一次（页面重挂载/模块重求值也不重播）
        String k = key == null ? "" : key;
        long now = System.currentTimeMillis();
        synchronized (spokenKeys) {
            Long at = spokenKeys.get(k);
            if (at != null && now - at < SPOKEN_DEDUP_MS) return true;
            spokenKeys.put(k, now);
            if (spokenKeys.size() > 400) {
                // 表 capped 400：清掉已过窗口期的旧 key，防止长会话无限涨
                java.util.List<String> stale = new java.util.ArrayList<>();
                for (Map.Entry<String, Long> e : spokenKeys.entrySet()) {
                    if (now - e.getValue() >= SPOKEN_DEDUP_MS) stale.add(e.getKey());
                }
                for (String old : stale) spokenKeys.remove(old);
            }
        }
        final String speakKey = k.isEmpty() ? "k" + now : k;
        main.post(new Runnable() {
            @Override
            public void run() {
                speakOnMain(speakKey, text);
            }
        });
        return true;
    }

    private void speakOnMain(String key, String text) {
        Activity activity = activityRef.get();
        if (activity == null) return;
        ensureTts(activity);
        if (tts == null || !ttsReady) {
            // TTS 不可用也不能无声无息：补一条高优先级通知（标题注明语音不可用），至少看得见
            Log.w(TAG, "原生 TTS 不可用，本次只发通知");
            postTaskDoneNotification("个人助手 · 任务完成（语音不可用）", text);
            return;
        }
        try {
            tts.setSpeechRate(1.0f);
            // 长文本切块：首块 QUEUE_FLUSH（打断上一条），后续 QUEUE_ADD 接着播；
            // 音频属性在 ensureTts 里已设为 USAGE_ASSISTANT/CONTENT_TYPE_SPEECH
            android.os.Bundle params = new android.os.Bundle();
            String rest = text;
            boolean first = true;
            int seq = 0;
            while (!rest.isEmpty()) {
                String chunk = rest.length() <= TTS_CHUNK ? rest : rest.substring(0, TTS_CHUNK);
                rest = rest.length() <= TTS_CHUNK ? "" : rest.substring(TTS_CHUNK);
                tts.speak(chunk, first ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD,
                        params, key + "#" + (seq++));
                first = false;
            }
        } catch (Throwable t) {
            Log.w(TAG, "原生播报失败：" + t);
        }
    }

    /** 懒初始化 TTS：首次播报才创建（不占启动时间）；中文优先，失败用系统默认。 */
    private void ensureTts(final Activity activity) {
        if (tts != null) return;
        tts = new TextToSpeech(activity.getApplicationContext(), new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(int status) {
                ttsReady = status == TextToSpeech.SUCCESS;
                if (!ttsReady || tts == null) return;
                try {
                    int r = tts.setLanguage(Locale.CHINESE);
                    if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                        Log.w(TAG, "系统 TTS 缺中文数据，退回默认语言");
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        tts.setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                                        ? AudioAttributes.USAGE_ASSISTANT
                                        : AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build());
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "TTS 初始化参数失败：" + t);
                }
            }
        });
    }
}
