package com.chenpan.assistant;

/**
 * 切屏悬浮球的坐标规则（纯逻辑，可桌面 JVM 单测）。
 *
 * 1.2.4 的教训：旧版本里悬浮球被卷进「鹈鹕屏专属控件」的隐藏逻辑，助手屏整个消失；
 * 另外持久化的坐标如果落到 root 尺寸之外（换机、转屏、布局改过），球会跑到看不见的地方。
 * 这里把「什么时候算有效坐标」定死：
 *   - root 还没量出尺寸（0×0）→ 无效，回默认左下角；
 *   - 坐标负数或越界 → 先夹进 [0, w-size] / [0, h-size]；
 *   - 屏幕比球还小 → 无效，回默认。
 */
public final class BallRules {

    /** 默认位置：左下角，距边缘 16dp。 */
    public static final int DEFAULT_MARGIN_DP = 16;

    private BallRules() {
    }

    /**
     * @return 夹好的 {x, y}；无效时返回 null（调用方放回默认左下角）。
     */
    public static int[] clamp(int x, int y, int w, int h, int size) {
        if (w <= 0 || h <= 0 || size <= 0) return null;
        if (x < 0 || y < 0) return null;
        int maxX = w - size;
        int maxY = h - size;
        if (maxX < 0 || maxY < 0) return null;
        int cx = Math.min(x, maxX);
        int cy = Math.min(y, maxY);
        return new int[]{cx, cy};
    }
}
