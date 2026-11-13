package com.chenpan.assistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;

/**
 * 极简提示音（1.3.0，1.3.6 修「点了录音没有声音」）：AudioTrack 现场合成正弦音，不引入资源文件。
 *
 * - start：一声「叮」（1046Hz ≈ 1.2 秒音阶里的高音 C，130ms 指数衰减）
 * - stop：下行两音
 * - sent：轻快单音（约 80ms）
 * - cancel：低沉短音
 *
 * 1.3.6 根因：旧实现走 {@code USAGE_ASSISTANCE_SONIFICATION}（系统「提示音/触摸音」那一路），
 * 很多手机这个通道的音量是 0（系统设置里关掉触摸音效、或勿扰/静音档位），于是代码明明
 * 调了 playTone，用户却听不到一点声音；而鹈鹕朗读本身走媒体音量，能正常出声。
 * 现在改成 {@code USAGE_MEDIA} + {@code CONTENT_TYPE_SONIFICATION}：与朗读同一条媒体
 * 通道、同一个音量，朗读能听见，「叮」就一定听得见。不再因为 RingerMode=静音/振动
 * 直接吞掉提示音（媒体音量才是指示音真实开关）。
 */
public final class ToneFx {

    public static final int START = 0;
    public static final int STOP = 1;
    public static final int SENT = 2;
    public static final int CANCEL = 3;

    private static final int RATE = 22050;
    /** 峰值幅度（PCM16，满量程 32767）：12000 ≈ -8.7 dBFS，清晰但不刺耳。 */
    private static final int AMPLITUDE = 12000;

    private ToneFx() {
    }

    private static float[] tones(int kind) {
        if (kind == START) return new float[]{1046f};
        if (kind == STOP) return new float[]{880f, 660f};
        if (kind == SENT) return new float[]{1320f};
        return new float[]{520f, 440f};
    }

    /** 每个音的时长（ms）。 */
    private static int unit(int kind) {
        if (kind == START) return 130;
        if (kind == STOP) return 60;
        if (kind == SENT) return 80;
        return 50;
    }

    public static void play(Context ctx, int kind) {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            // 媒体音量为 0 时提示音注定听不见：直接返回，省一次 AudioTrack 初始化。
            if (am != null && am.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) return;
            float[] freq = tones(kind);
            int unit = unit(kind);
            int per = RATE * unit / 1000;
            short[] pcm = new short[per * freq.length];
            int idx = 0;
            for (float f : freq) {
                for (int i = 0; i < per; i++) {
                    double env;
                    if (kind == START) {
                        // 「叮」：8ms 起振 + 指数衰减（三角包络听起来像「嘀」，不像「叮」）。
                        double attack = Math.min(1.0, i / 8.0);
                        env = attack * Math.exp(-3.6 * i / per);
                    } else {
                        env = Math.min(1.0, Math.min(i / 40.0, (per - i) / 40.0));
                    }
                    pcm[idx++] = (short) (Math.sin(2 * Math.PI * f * i / RATE) * AMPLITUDE * env);
                }
            }
            AudioTrack track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            // 走媒体通道：和朗读同一个音量；系统提示音通道常常是 0。
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setSampleRate(RATE)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setBufferSizeInBytes(pcm.length * 2)
                    .build();
            track.write(pcm, 0, pcm.length);
            track.play();
            final AudioTrack t = track;
            final int holdMs = Math.max(400, unit * freq.length + 200);
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Thread.sleep(holdMs);
                    } catch (InterruptedException ignored) {
                        // 忽略
                    }
                    try {
                        t.stop();
                        t.release();
                    } catch (Throwable ignored) {
                        // 忽略
                    }
                }
            }).start();
        } catch (Throwable ignored) {
            // 提示音失败不影响主流程
        }
    }
}
