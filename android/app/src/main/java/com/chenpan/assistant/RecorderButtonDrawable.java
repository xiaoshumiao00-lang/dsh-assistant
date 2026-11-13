package com.chenpan.assistant;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;

/**
 * 极简录音按钮（2026-11-13，用户要求：只画话筒图标 + 一圈圆环，别的什么都不要）。
 *
 * 上一版（1.2.9）是「录音机造型」：圆角矩形机身 + 顶部三条格栅 + 中心圆 + 渐变填充 +
 * 停止方块 + 按下重绘……用户要的是**最简单的那个样子**：
 *
 *   ○   ← 只有一圈圆环（描边，不填充、无阴影、无光晕、无波纹）
 *   ∩   ← 环里一个小话筒：胶囊 + U 形托架 + 支杆 + 底座
 *
 * 录音状态也只改颜色（圆环与话筒换成第二主色、话筒实心），不再多画任何形状；
 * 时长与「在听」由波形上方那行状态文字表达（和以前一样）。
 * 可点区域＝整个 View 的 bounds（安卓壳里做成正方形，正好盖住这圈圆环）。
 */
public class RecorderButtonDrawable extends Drawable {

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF tmp = new RectF();

    /** 0=待机，1=录音（自测断言用）。 */
    private int state = 0;
    private boolean light = true;
    private int accent = 0xFF0F766E;
    private int accent2 = 0xFF1D4ED8;
    private boolean pressed;
    private float density = 2.6f;

    public void setDensity(float d) {
        density = d;
        invalidateSelf();
    }

    public void setColors(int main, int second, boolean isLight) {
        accent = main;
        accent2 = second;
        light = isLight;
        invalidateSelf();
    }

    public void setPressed(boolean value) {
        pressed = value;
        invalidateSelf();
    }

    public boolean isRecording() {
        return state == 1;
    }

    public int state() {
        return state;
    }

    public void setRecording(boolean recording) {
        state = recording ? 1 : 0;
        invalidateSelf();
    }

    private float dp(float v) {
        return v * density;
    }

    @Override
    public void draw(Canvas canvas) {
        RectF b = new RectF(getBounds());
        float cx = b.centerX();
        float cy = b.centerY();
        // 圆环半径：留 2dp 给描边，保证不贴边、也不被 View 边界裁掉。
        float r = Math.min(b.width(), b.height()) / 2f - dp(2);
        if (r <= dp(4)) return;
        int color = state == 1 ? accent2 : (light ? accent : 0xFFE8EEF4);

        // ① 一圈圆环：只描边，环里什么都不填。
        paint.setShader(null);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(2.4f));
        paint.setColor(color);
        canvas.drawCircle(cx, cy, r, paint);

        // ② 话筒（唯一图标）：胶囊麦头 + U 形托架 + 支杆 + 底座。
        float mw = r * 0.30f;              // 麦头宽
        float mh = r * 0.52f;              // 麦头高
        float mcy = cy - r * 0.12f;        // 麦头中心略高于圆心
        if (state == 1) {
            paint.setStyle(Paint.Style.FILL);
            tmp.set(cx - mw / 2f, mcy - mh / 2f, cx + mw / 2f, mcy + mh / 2f);
            canvas.drawRoundRect(tmp, mw / 2f, mw / 2f, paint);
        } else {
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(2.2f));
            tmp.set(cx - mw / 2f, mcy - mh / 2f, cx + mw / 2f, mcy + mh / 2f);
            canvas.drawRoundRect(tmp, mw / 2f, mw / 2f, paint);
        }

        // U 形托架：半圆，开口朝上，正好托住麦头下半截。
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(2.2f));
        paint.setColor(color);
        float uw = mw * 1.55f;
        float ucy = mcy + mh * 0.16f;
        tmp.set(cx - uw / 2f, ucy - uw / 2f, cx + uw / 2f, ucy + uw / 2f);
        canvas.drawArc(tmp, 0, 180, false, paint);

        // 支杆（从托架底部到圆心下方）与底座短线。
        float stemTop = ucy + uw / 2f;
        float stemBottom = Math.min(cy + r * 0.62f, b.bottom - dp(3));
        paint.setStrokeWidth(dp(2.2f));
        canvas.drawLine(cx, stemTop, cx, stemBottom, paint);
        canvas.drawLine(cx - r * 0.20f, stemBottom, cx + r * 0.20f, stemBottom, paint);
    }

    @Override
    public void setAlpha(int alpha) {
        paint.setAlpha(alpha);
    }

    @Override
    public void setColorFilter(ColorFilter cf) {
        paint.setColorFilter(cf);
    }

    @Override
    public int getOpacity() {
        return PixelFormat.TRANSLUCENT;
    }
}
