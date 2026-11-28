package com.chenpan.assistant;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

/**
 * 常驻连接前台服务（2026-11-27「切后台秒恢复 + 常驻在线」需求）。
 *
 * 为什么需要它：用户切到微信回消息时，本应用退到后台，厂商省电策略（小米/华为/OPPO…）
 * 随时可能冻结或杀掉进程——WebView 里的 WebSocket 随之死掉，回到页面就是「重新连接、
 * 白等几秒」。前台服务把进程优先级钉在「用户可感知」档，系统（包括大多数厂商的
 * 清理名单）不会轻易动它；再配一条最低优先级的常驻通知告诉用户「它还连着」。
 *
 * 四层兜底，一层比一层靠后：
 *   1. startForeground + dataSync 类型（targetSdk 34 的硬要求）；
 *   2. START_STICKY：服务被回收后系统择机拉起；
 *   3. onTaskRemoved：最近任务里被划掉时，约一个 3 秒后的闹钟把自己拉回来；
 *   4. Doze 周期闹钟（setAndAllowWhileIdle，约 9 分钟一拍）：每次到点续一次部分
 *      唤醒锁，让 WebView 的 WS 收发（代理 30s 协议层 ping）有机会在浅睡/Doze
 *      边缘继续跑；深度 Doze 下系统会把闹钟合并进维护窗口，这是平台限制，
 *      回前台时还有页面侧的「可见即重连」兜底（foreground-nudge.ts）。
 *
 * Android 12+ 的后台启动限制：应用在后台时 startForegroundService 会抛
 * ForegroundServiceStartNotAllowedException——start() 里整段 try/catch 吞掉，
 * 因为服务此时多半已经在跑；真没在跑，等回到前台 onResume 会再补一次 start()。
 *
 * 开关：SharedPreferences「dsh_assistant」里的 keepalive_enabled（默认开）。
 * 设置页（MainActivity.showSetup）与 JS 桥（NativeBridge.setKeepAliveEnabled）
 * 都能切；关掉时服务立刻停止，常驻通知随之消失。
 */
public class KeepAliveService extends Service {

    private static final String TAG = "KeepAliveService";

    /** 常驻通知渠道与通知 id（IMPORTANCE_MIN：不响不震不 heads-up）。 */
    private static final String CHANNEL_ID = "dsh_keepalive";
    private static final int NOTIF_ID = 4101;

    /**
     * Service.FOREGROUND_SERVICE_TYPE_DATA_SYNC 的 AOSP 值（=1）。
     * 本机 SDK 的 android-34 android.jar 里 Service 桩缺这组常量（字节码实测），
     * 直接引用编译不过；三参 startForeground 重载在桩里是有的，钉数值即可。
     */
    private static final int FGS_TYPE_DATA_SYNC = 1;

    /** 周期兜底节拍：约 9 分钟（Doze 维护窗口会把多次闹钟合并，这是平台行为）。 */
    private static final long TICK_MS = 9 * 60 * 1000;
    /** 最近任务被划掉后的重启闹钟延迟。 */
    private static final long RESTART_DELAY_MS = 3 * 1000;
    /** 每次节拍续的部分唤醒锁时长（比节拍略长，保证衔接；锁随超时自动释放，不常驻）。 */
    private static final long WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

    private static final String ACTION_TICK = "dsh.keepalive.TICK";
    private static final String ACTION_RESTART = "dsh.keepalive.RESTART";

    private static final String PREFS = "dsh_assistant";
    private static final String KEY_ENABLED = "keepalive_enabled";

    private PowerManager.WakeLock wakeLock;

    /* ------------------------------------------------------------ 开关与启停 */

    /** 保活开关（默认开）：设置页与 JS 桥共用这一份。 */
    public static boolean isEnabled(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        return prefs.getBoolean(KEY_ENABLED, true);
    }

    /** 切开关：开 → 立刻拉起服务；关 → 立刻停掉（常驻通知随之消失）。 */
    public static void setEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit().putBoolean(KEY_ENABLED, enabled).apply();
        if (enabled) start(context);
        else stop(context);
    }

    /**
     * 拉起前台服务（开关关着时什么都不做）。
     * Android 12+ 在后台调用会被 ForegroundServiceStartNotAllowedException 拦住：
     * 吞掉——服务多半已在跑；没在跑就等回前台时 onResume 再补。
     */
    public static void start(Context context) {
        if (!isEnabled(context)) return;
        Intent intent = new Intent(context, KeepAliveService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable t) {
            // ForegroundServiceStartNotAllowedException（API 31+）与厂商限制都落这里
            Log.w(TAG, "startForegroundService 被拦（多半已在跑或等回前台再补）：" + t);
        }
    }

    /** 停掉服务（开关关闭 / 用户明确要求时）。 */
    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, KeepAliveService.class));
        } catch (Throwable t) {
            Log.w(TAG, "stopService 失败：" + t);
        }
    }

    /* ------------------------------------------------------- 电池优化白名单 */

    /** 当前是否已在电池优化白名单（设置页状态行用）。 */
    public static boolean isIgnoringBatteryOptimizations(Context context) {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 跳系统「忽略电池优化」授权页的 Intent（需要 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）。
     * 只在用户点设置页那个按钮时发出——给入口，绝不自动弹。
     */
    public static Intent batteryWhitelistIntent(Context context) {
        return new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + context.getPackageName()));
    }

    /* ------------------------------------------------------------ 服务本体 */

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        renewWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundWithType();
        scheduleTick();
        return START_STICKY;
    }

    /** 最近任务里被划掉：约 3 秒后把自己拉回来（START_STICKY 之外的显式兜底）。 */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        scheduleRestart(RESTART_DELAY_MS);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        cancelAlarm(ACTION_TICK);
        cancelAlarm(ACTION_RESTART);
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 前台化：API 29+ 必须显式钉 dataSync 类型（targetSdk 34 缺类型会直接抛异常）。 */
    private void startForegroundWithType() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, FGS_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, notification);
        }
    }

    /** 常驻低优先级通知：「个人助手常驻连接中」，点一下回页面。 */
    // 消掉 javac 的「已过时 API」提示（Notification.Builder(Context) / setPriority 只在 Android 8 以下走）：
    // Windows PowerShell 5.1 会把本机命令写到 stderr 的一行变成终止错误（build.ps1 里 EAP=Stop），
    // 一句提示就能把整条构建打断——本轮实测；javac 静默后 build.ps1 才能按原样跑通。
    @SuppressWarnings("deprecation")
    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("个人助手常驻连接中")
                .setContentText("切后台也保持在线；任务完成会发通知并语音播报")
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_MIN);
        }
        return builder.build();
    }

    /** 常驻通知渠道：IMPORTANCE_MIN——不响、不震、不 heads-up，只在通知栏占一格。 */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "常驻连接", NotificationManager.IMPORTANCE_MIN);
            channel.setDescription("保持后台在线的常驻通知；关掉「后台常驻保活」后消失");
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
    }

    /* ------------------------------------------------------------ 兜底闹钟 */

    /** 周期兜底：Doze 下唯一还能按时醒的闹钟（不精确，平台会合并，够用）。 */
    private void scheduleTick() {
        setAlarm(ACTION_TICK, TICK_MS);
    }

    /** 最近任务被划掉后的重启闹钟。 */
    private void scheduleRestart(long delayMs) {
        setAlarm(ACTION_RESTART, delayMs);
    }

    private void setAlarm(String action, long delayMs) {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + delayMs, alarmIntent(action));
        } catch (Throwable t) {
            Log.w(TAG, "定闹钟失败（" + action + "）：" + t);
        }
    }

    private void cancelAlarm(String action) {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            am.cancel(alarmIntent(action));
        } catch (Throwable ignored) {
        }
    }

    private PendingIntent alarmIntent(String action) {
        Intent intent = new Intent(this, KeepAliveService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        // API 26+ 后台 startService 会被直接拒绝；getForegroundService 是闹钟唤醒前台服务的
        // 正路（服务活着时只是投递 onStartCommand；服务死了在 Android 8–11 能重新拉起，
        // Android 12+ 若被后台 FGS 启动限制拦住则静默失败——那种情况由 START_STICKY 兜底）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return PendingIntent.getForegroundService(this, action.hashCode(), intent, flags);
        }
        return PendingIntent.getService(this, action.hashCode(), intent, flags);
    }

    /**
     * 每个闹钟节拍都会回到 onStartCommand：续一次唤醒锁、再约下一拍。
     * 唤醒锁带超时自动释放，不会常驻耗电；节拍被 Doze 合并时锁也跟着停，不硬扛。
     */
    private void renewWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:keepalive");
            wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        } catch (Throwable t) {
            Log.w(TAG, "唤醒锁获取失败：" + t);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable ignored) {
        }
        wakeLock = null;
    }
}
