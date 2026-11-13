package com.chenpan.assistant;

/**
 * 语音唤醒的状态规则（纯逻辑，不碰 Android API，可桌面 JVM 单测）。
 *
 * 1.3.8：1.3.5 起真机已改用板内 WakeNet（WakeEngine + wake_cnn.tflite），
 * 不再需要 Porcupine 的 AccessKey / .ppn 两样外部素材。因此：
 *   - 开关永远可点（switchEnabled 不再看素材）；
 *   - 状态只看 prefs 的 wake_enabled，开=on、关=off，不再出现 needs-key/needs-ppn；
 *   - 旧素材接口保留（老用户填过也不报错，Porcupine 路径仍可用）；
 *   - 初始化失败时把原始错误码/信息翻译成人话（但不能吞掉原文）。
 */
public final class WakeRules {

    /** 缺 AccessKey：开关置灰。 */
    public static final String NEEDS_KEY = "needs-key";
    /** 缺 .ppn：开关置灰。 */
    public static final String NEEDS_PPN = "needs-ppn";
    /** 素材齐全但用户关掉了。 */
    public static final String OFF = "off";
    /** 正在监听。 */
    public static final String ON = "on";
    /** 正在录音（唤醒后），监听暂停。 */
    public static final String PAUSED = "paused";
    /** 初始化失败（错误原文见 lastError）。 */
    public static final String ERROR = "error";

    private WakeRules() {
    }

    /** 当前应该处于什么状态：只由 wake_enabled 决定（运行中的 PAUSED/ERROR 由运行时自己报）。 */
    public static String idleState(boolean enabled) {
        return enabled ? ON : OFF;
    }

    /**
     * 开关能不能点：1.3.8 起恒为 true。
     *
     * 以前这里要求 hasKey && hasPpn，缺一样就把设置页的开关置灰，用户点了没反应；
     * 但 1.3.5 起真机跑的是板内 WakeNet，这两样素材根本不是必需的了。
     * 现在没有任何前置条件：有引擎、有麦克风权限就能开。
     */
    public static boolean switchEnabled() {
        return true;
    }

    /** 状态行上的一句话提示。 */
    public static String statusText(String state, String lastError) {
        if (state == null) state = NEEDS_KEY;
        switch (state) {
            case NEEDS_KEY:
                return "还没填 AccessKey：去 picovoice.ai 控制台建唤醒词「鹈鹕」并下载 .ppn，再把 AccessKey 和文件填进来";
            case NEEDS_PPN:
                return "还没选唤醒词文件（.ppn）：在 picovoice.ai 控制台建「鹈鹕」后下载，点下面「选择 .ppn」";
            case ON:
                return "正在听「鹈鹕」（仅本屏 + App 前台）";
            case PAUSED:
                return "录音中，唤醒监听暂停";
            case OFF:
                return "语音唤醒已关闭";
            case ERROR:
                return "唤醒引擎启动失败：" + (lastError == null || lastError.isEmpty() ? "未知错误" : lastError);
            default:
                return "语音唤醒未就绪";
        }
    }

    /**
     * Porcupine 初始化失败时给用户的解释。必须保留原始信息（错误码/错误名），
     * 只在其后补一句中文，方便排查 invalid access key / 无效 keyword 文件。
     */
    public static String errorText(String errorClass, String message) {
        String raw = (errorClass == null ? "" : errorClass)
                + (message == null || message.isEmpty() ? "" : "：" + message);
        String lower = raw.toLowerCase();
        String hint;
        if (lower.contains("key") && (lower.contains("invalid") || lower.contains("key"))) {
            hint = "AccessKey 无效或未激活（检查是否复制完整、是否已在控制台激活）";
        } else if (lower.contains("keyword") || lower.contains("ppn")) {
            hint = "唤醒词文件无效（请下载与控制台匹配的 .ppn）";
        } else if (lower.contains("activation") || lower.contains("network") || lower.contains("internet")) {
            hint = "首次初始化需要联网校验，请检查网络后重试";
        } else if (lower.contains("throttle")) {
            hint = "初始化太频繁被限流，等一会儿再试";
        } else {
            hint = "请检查 AccessKey / .ppn 后点「重新加载引擎」";
        }
        return hint + "（原始信息：" + raw + "）";
    }

    /** 自检区一行：时间 关键词 分数/事件。 */
    public static String eventLine(String time, String keyword, String info) {
        return time + "  " + (keyword == null || keyword.isEmpty() ? "-" : keyword)
                + "  " + (info == null ? "" : info);
    }
}
