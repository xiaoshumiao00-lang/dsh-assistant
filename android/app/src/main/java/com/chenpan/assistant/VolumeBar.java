package com.chenpan.assistant;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.View;

/**
 * 自绘音量条（1.2.1）：白色圆角胶囊 + 6dp 细轨道 + 深青绿填充 + 白色圆形滑块（带阴影）
 * + 左侧喇叭图标（静音叠加斜线）+ 右侧齿轮（Path 矢量，30dp 命中区）+ 12px 百分比。
 * 不用系统 SeekBar（默认样式是红圈蓝三角，很难看）。
 */
@SuppressLint("ViewConstructor")
public class VolumeBar extends View {

    public interface Listener {
        void onVolumeChanged(int pct, boolean muted);

        void onGearClick();
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path speaker = new Path();
    private final Path gear = new Path();
    private final RectF track = new RectF();
    private int pct = 80;
    private boolean muted = false;
    private boolean light = true;
    private int accentColor;
    private Listener listener;
    private float downX;
    private boolean dragging;

    public VolumeBar(Context c) {
        super(c);
        setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        text.setTextSize(dp(12));
        text.setTextAlign(Paint.Align.RIGHT);
    }

    public void setListener(Listener l) {
        listener = l;
    }

    public void setAccent(int color) {
        accentColor = color;
        invalidate();
    }

    public void setLight(boolean value) {
        light = value;
        invalidate();
    }

    public void setState(int pctValue, boolean isMuted) {
        pct = Math.max(0, Math.min(100, pctValue));
        muted = isMuted;
        invalidate();
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;
        float pad = dp(14);
        float capR = Math.min(dp(22), h / 2f);

        // 胶囊底
        paint.setStyle(Paint.Style.FILL);
        paint.setShadowLayer(dp(2), 0, dp(1), light ? 0x1F111827 : 0x66000000);
        paint.setColor(light ? 0xFFFFFFFF : 0xFF121821);
        canvas.drawRoundRect(new RectF(0, 0, w, h), capR, capR, paint);
        paint.clearShadowLayer();

        // 喇叭图标（左侧 34dp 命中区）
        float iconCx = pad + dp(12);
        float iconCy = h / 2f;
        int fg = light ? 0xFF111827 : 0xFFE6EDF3;
        int accent = accentColor != 0 ? accentColor : (light ? 0xFF0F766E : 0xFF3FB6A8);
        int dim = light ? 0xFF9CA3AF : 0xFF8B98A5;
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(muted ? dim : accent);
        speaker.reset();
        speaker.moveTo(iconCx - dp(7), iconCy - dp(3));
        speaker.lineTo(iconCx - dp(3), iconCy - dp(3));
        speaker.lineTo(iconCx + dp(1), iconCy - dp(7));
        speaker.lineTo(iconCx + dp(1), iconCy + dp(7));
        speaker.lineTo(iconCx - dp(3), iconCy + dp(3));
        speaker.lineTo(iconCx - dp(7), iconCy + dp(3));
        speaker.close();
        canvas.drawPath(speaker, paint);
        // 两道声波
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1.4f));
        canvas.drawArc(new RectF(iconCx + dp(2), iconCy - dp(5), iconCx + dp(9), iconCy + dp(5)), -50, 100, false, paint);
        canvas.drawArc(new RectF(iconCx + dp(4), iconCy - dp(8), iconCx + dp(13), iconCy + dp(8)), -50, 100, false, paint);
        if (muted) {
            paint.setColor(0xFFDC2626);
            paint.setStrokeWidth(dp(1.8f));
            canvas.drawLine(iconCx - dp(8), iconCy + dp(8), iconCx + dp(10), iconCy - dp(8), paint);
        }

        // 齿轮（右侧 30dp 命中区）
        float gearCx = w - pad - dp(9);
        paint.setColor(fg);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1.6f));
        canvas.drawCircle(gearCx, iconCy, dp(6), paint);
        canvas.drawCircle(gearCx, iconCy, dp(2), paint);
        for (int i = 0; i < 6; i++) {
            double a = Math.PI * i / 3.0;
            canvas.drawLine(gearCx + (float) (Math.cos(a) * dp(6)), iconCy + (float) (Math.sin(a) * dp(6)),
                    gearCx + (float) (Math.cos(a) * dp(8.5f)), iconCy + (float) (Math.sin(a) * dp(8.5f)), paint);
        }

        // 百分比
        text.setColor(light ? 0xFF6B7280 : 0xFF8B98A5);
        canvas.drawText((muted ? 0 : pct) + "%", gearCx - dp(13), iconCy + dp(4), text);

        // 轨道
        float left = iconCx + dp(18);
        float right = gearCx - dp(46);
        if (right < left + dp(20)) right = left + dp(20);
        float cy = iconCy;
        float th = dp(3);
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(light ? 0xFFE5E7EB : 0xFF1F2A37);
        track.set(left, cy - th, right, cy + th);
        canvas.drawRoundRect(track, th, th, paint);
        float value = muted ? 0 : pct / 100f;
        if (value > 0) {
            paint.setColor(accent);
            track.set(left, cy - th, left + Math.max(th * 2, (right - left) * value), cy + th);
            canvas.drawRoundRect(track, th, th, paint);
        }

        // 滑块（白圆 + 阴影）
        float thumbX = left + (right - left) * value;
        float thumbR = dp(9);
        paint.setShadowLayer(dp(2), 0, dp(1), 0x33111827);
        paint.setColor(0xFFFFFFFF);
        canvas.drawCircle(thumbX, cy, thumbR, paint);
        paint.clearShadowLayer();
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1));
        paint.setColor(light ? 0xFFE5E7EB : 0xFF33414F);
        canvas.drawCircle(thumbX, cy, thumbR, paint);
    }

    private float trackLeft() {
        return dp(14) + dp(12) + dp(18);
    }

    private float trackRight() {
        return getWidth() - dp(14) - dp(9) - dp(46);
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        float x = e.getX();
        float y = e.getY();
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = x;
                dragging = false;
                return true;
            case MotionEvent.ACTION_MOVE:
                if (Math.abs(x - downX) > dp(4)) dragging = true;
                if (dragging) {
                    applyX(x);
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (!dragging) {
                    if (x > getWidth() - dp(44)) {
                        if (listener != null) listener.onGearClick();
                    } else if (x < dp(44)) {
                        if (listener != null) listener.onVolumeChanged(pct, !muted);
                    } else {
                        applyX(x);
                    }
                }
                return true;
            default:
                return super.onTouchEvent(e);
        }
    }

    private void applyX(float x) {
        float left = trackLeft();
        float right = trackRight();
        if (right <= left) return;
        float v = (x - left) / (right - left);
        v = Math.max(0f, Math.min(1f, v));
        int newPct = Math.round(v * 100);
        if (newPct == 0) {
            if (listener != null) listener.onVolumeChanged(0, true);
        } else {
            if (listener != null) listener.onVolumeChanged(newPct, false);
        }
    }
}
