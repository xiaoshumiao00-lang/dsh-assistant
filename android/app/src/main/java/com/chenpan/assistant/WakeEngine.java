package com.chenpan.assistant;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

/**
 * 本地唤醒监听线程（1.3.5）：16k/mono/16bit 环形缓冲，每 100ms 打分一次，
 * 连续 2 帧 ≥ 阈值才回调（防抖）。命中后自己停麦克风，由调用方走录音链路。
 *
 * 1.3.5 改动（真人说话唤不醒）：
 *   - 能量门限 600 → 150：真机录音里「鹈鹕」最强窗 rms 只有 2000、弱的只有 157，
 *     原来 600 直接把这些窗跳过了；
 *   - 连续命中 3 帧 → 2 帧（100ms 步进下 3 帧＝词要撑满 0.3s 以上才认）；
 *   - 初始化/录音异常不再静默吞掉，走 onError 上报给界面（写入 wakeEvents + state=error）。
 */
public final class WakeEngine {

    public interface Listener {
        void onWake(int cls, float score);

        void onScore(float score, int rms);

        void onError(String reason);
    }

    private static final int RATE = 16000;
    private static final int WIN = 24000;      // 1.5s
    private static final int STEP = 1600;      // 100ms
    /** 低于这个 rms 直接跳过（不说话时的底噪），真人耳语级也放行。 */
    private static final int RMS_GATE = 150;
    /** 连续多少帧过阈值才认。 */
    private static final int HIT_NEED = 2;

    private final WakeNet net;
    private final Listener listener;
    private volatile boolean running;
    private Thread thread;
    private float threshold = 0.75f;
    private volatile boolean paused;
    private long quietUntil;
    private volatile String lastError = "";
    /** 当前正在用的麦克风（stop() 要能把它掐掉，否则 read() 阻塞时线程退不出来）。 */
    private volatile AudioRecord record;

    public WakeEngine(WakeNet net, Listener l) {
        this.net = net;
        this.listener = l;
    }

    public void setThreshold(float t) {
        threshold = t;
    }

    /** 页面在放 TTS 时暂停判定，避免自己念出来把自己唤醒。 */
    public void setPaused(boolean value) {
        paused = value;
        if (value) quietUntil = System.currentTimeMillis() + 300;
    }

    public boolean isRunning() {
        return running;
    }

    public void start() {
        if (running) return;
        running = true;
        thread = new Thread(new Runnable() {
            @Override
            public void run() {
                loop();
            }
        }, "wake-net");
        thread.start();
    }

    /**
     * 停止监听并确保线程退出（1.3.8）。
     *
     * 旧实现只把 running 置 false 然后 join(600)；但 loop 停在阻塞式 rec.read() 上时，
     * 这个 join 会白等 600ms，线程还攥着麦克风 —— 用户关掉唤醒后本地引擎「看起来没停」。
     * 现在先 stop() 麦克风把 read() 打断，再 join；谁调的都对同一个线程生效。
     */
    public void stop() {
        running = false;
        paused = false;
        AudioRecord r = record;
        if (r != null) {
            try {
                r.stop();
            } catch (Throwable ignored) {
                // 还没 start / 已经 stop：忽略
            }
        }
        Thread t = thread;
        thread = null;
        if (t != null && t != Thread.currentThread()) {
            try {
                t.join(600);
            } catch (InterruptedException ignored) {
                // 忽略
            }
            if (t.isAlive()) {
                try {
                    t.interrupt();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    private void report(String reason) {
        lastError = reason;
        running = false;
        if (listener != null) {
            try {
                listener.onError(reason);
            } catch (Throwable ignored) {
                // 界面回调不能再抛
            }
        }
    }

    /** 最近一次失败原因（空串表示没失败）。 */
    public String lastError() {
        return lastError;
    }

    private void loop() {
        AudioRecord rec = null;
        short[] ring = new short[WIN];
        short[] buf = new short[STEP];
        int hit = 0;
        try {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(min, STEP * 2 * 4));
            record = rec;
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                report("麦克风初始化失败（AudioRecord state=" + rec.getState() + "）：可能被其他应用占用");
                return;
            }
            try {
                rec.startRecording();
            } catch (Throwable t) {
                report("麦克风启动失败（startRecording）：" + t.getClass().getSimpleName()
                        + (t.getMessage() == null ? "" : "：" + t.getMessage()));
                return;
            }
            if (rec.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                report("麦克风未进入录音状态（recordingState=" + rec.getRecordingState() + "），可能被占用");
                return;
            }
            int filled = 0;
            while (running) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) continue;
                if (filled < WIN) {
                    int copy = Math.min(n, WIN - filled);
                    System.arraycopy(buf, 0, ring, filled, copy);
                    filled += copy;
                    if (filled < WIN) continue;
                } else {
                    System.arraycopy(ring, n, ring, 0, WIN - n);
                    System.arraycopy(buf, 0, ring, WIN - n, Math.min(n, WIN));
                }
                if (paused || System.currentTimeMillis() < quietUntil) {
                    hit = 0;
                    continue;
                }
                long rmsSum = 0;
                for (int k = 0; k < WIN; k += 4) rmsSum += (long) ring[k] * ring[k];
                int rms = (int) Math.sqrt(rmsSum / (WIN / 4.0));
                if (rms < RMS_GATE) {
                    hit = 0;
                    if (listener != null) listener.onScore(0f, rms);
                    continue;
                }
                float[] r = net.score(ring, 0);
                if (listener != null) listener.onScore(r[1], rms);
                if (r[1] >= threshold) {
                    hit++;
                    if (hit >= HIT_NEED) {
                        float sc = r[1];
                        int cls = (int) r[0];
                        quietUntil = System.currentTimeMillis() + 2000;
                        running = false;
                        if (listener != null) listener.onWake(cls, sc);
                        break;
                    }
                } else {
                    hit = 0;
                }
            }
        } catch (Throwable t) {
            report("唤醒监听异常：" + t.getClass().getSimpleName()
                    + (t.getMessage() == null ? "" : "：" + t.getMessage()));
        } finally {
            running = false;
            record = null;
            if (rec != null) {
                try {
                    rec.stop();
                } catch (Throwable ignored) {
                    // 忽略
                }
                try {
                    rec.release();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }
}
