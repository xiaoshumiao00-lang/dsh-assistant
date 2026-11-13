package com.chenpan.assistant;

import android.content.Context;

import org.tensorflow.lite.Interpreter;

import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.io.File;
import java.io.FileOutputStream;

/**
 * 本地唤醒词网络（1.3.5，自训练 TFLite，不依赖任何账号）。
 *
 * 输入：16k 单声道 1.5s（24000 采样）→ 40 维 log-mel、10ms 帧移 → 150×40；
 * 输出：3 类 softmax（0=无人声，1=鹈鹕，2=你好鹈鹕），唤醒分数取 max(p1,p2)。
 * 每 100ms 滑一次窗，连续 2 帧过阈值才触发（防抖）。
 *
 * 特征必须与 tools/wake/train.py logmel() 逐位对齐，否则模型看到的分布不对：
 *   - **幅度谱** |X|（不是功率谱 re²+im²）；
 *   - **周期** Hann：cos(2πi/400)（不是对称窗 i/399）；
 *   - 真实帧数 148（(24000-400)/160+1），其余 2 帧在 log 域补 **0**（tf.pad 补的是 0，
 *     不是 log(1e-6)），然后对全部 150 帧做 mean/std 标准化。
 */
public final class WakeNet {

    public static final int SR = 16000;
    public static final int WIN = 24000;
    public static final int N_MELS = 40;
    public static final int N_FRAMES = 150;
    /** 训练侧 tf.signal.stft 实际算出的帧数，多出来的帧在 log 域补 0。 */
    public static final int N_REAL_FRAMES = 148;
    private static final int FFT = 512;
    private static final int BINS = FFT / 2 + 1;

    private final Interpreter interp;
    private final int modelBytes;
    private final float[][] mel = new float[N_MELS][BINS];
    private final float[] hann = new float[400];
    private final float[] window = new float[FFT];
    private final float[] mag = new float[BINS];
    private final float[] re = new float[FFT];
    private final float[] im = new float[FFT];
    private final int[] rev = new int[FFT];
    private final float[] cosT = new float[FFT / 2];
    private final float[] sinT = new float[FFT / 2];
    private final float[][][][] input = new float[1][N_FRAMES][N_MELS][1];
    private final float[][] output = new float[1][3];

    public WakeNet(Context ctx) throws Exception {
        MappedByteBuffer model = loadModel(ctx);
        modelBytes = model.capacity();
        Interpreter.Options opt = new Interpreter.Options();
        opt.setNumThreads(2);
        interp = new Interpreter(model, opt);
        buildMel();
        for (int i = 0; i < 400; i++) {
            hann[i] = (float) (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 400.0));   // 周期窗，与训练一致
        }
        for (int i = 0; i < FFT; i++) {
            int r = 0;
            int x = i;
            for (int b = 0; b < 9; b++) {
                r = (r << 1) | (x & 1);
                x >>= 1;
            }
            rev[i] = r;
        }
        for (int i = 0; i < FFT / 2; i++) {
            cosT[i] = (float) Math.cos(-2 * Math.PI * i / FFT);
            sinT[i] = (float) Math.sin(-2 * Math.PI * i / FFT);
        }
    }

    /**
     * 模型从 assets 落到 filesDir 再用（assets 不能直接 mmap）。
     *
     * 1.3.5 修：旧逻辑只在「文件不存在」时复制，换 APK 后 filesDir 里还是**旧模型**，
     * 模型换了也不生效。现在按字节数比对，和 assets 不一致就重新复制。
     */
    private static MappedByteBuffer loadModel(Context ctx) throws Exception {
        File f = new File(ctx.getFilesDir(), "wake_cnn.tflite");
        InputStream in = ctx.getAssets().open("wake_cnn.tflite");
        int assetLen = in.available();
        if (!f.exists() || assetLen <= 0 || f.length() != assetLen) {
            FileOutputStream out = new FileOutputStream(f);
            byte[] b = new byte[1 << 16];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
            out.close();
        }
        in.close();
        FileChannel ch = new java.io.RandomAccessFile(f, "r").getChannel();
        return ch.map(FileChannel.MapMode.READ_ONLY, 0, ch.size());
    }

    private void buildMel() {
        double fMin = 40.0, fMax = 7600.0;
        double mMin = 2595.0 * Math.log10(1 + fMin / 700.0);
        double mMax = 2595.0 * Math.log10(1 + fMax / 700.0);
        double[] pts = new double[N_MELS + 2];
        for (int i = 0; i < pts.length; i++) {
            pts[i] = 700.0 * (Math.pow(10, (mMin + (mMax - mMin) * i / (N_MELS + 1)) / 2595.0) - 1);
        }
        int bins = FFT / 2 + 1;
        double[] freq = new double[bins];
        for (int k = 0; k < bins; k++) freq[k] = (double) k * SR / FFT;
        for (int m = 1; m <= N_MELS; m++) {
            for (int k = 0; k < bins; k++) {
                double f = freq[k];
                double v = 0.0;
                if (f >= pts[m - 1] && f <= pts[m]) {
                    v = (f - pts[m - 1]) / (pts[m] - pts[m - 1]);
                } else if (f > pts[m] && f <= pts[m + 1]) {
                    v = (pts[m + 1] - f) / (pts[m + 1] - pts[m]);
                }
                mel[m - 1][k] = (float) Math.max(0.0, v);
            }
        }
    }

    private void fft(float[] r, float[] i) {
        for (int k = 0; k < FFT; k++) {
            int j = rev[k];
            if (j > k) {
                float t = r[k]; r[k] = r[j]; r[j] = t;
                t = i[k]; i[k] = i[j]; i[j] = t;
            }
        }
        for (int size = 2; size <= FFT; size <<= 1) {
            int half = size >> 1;
            int step = FFT / size;
            for (int start = 0; start < FFT; start += size) {
                for (int k = 0; k < half; k++) {
                    int idx = k * step;
                    float wr = cosT[idx], wi = sinT[idx];
                    int a = start + k, b = a + half;
                    float xr = r[b] * wr - i[b] * wi;
                    float xi = r[b] * wi + i[b] * wr;
                    r[b] = r[a] - xr;
                    i[b] = i[a] - xi;
                    r[a] += xr;
                    i[a] += xi;
                }
            }
        }
    }

    /** 24000 采样 → 填充好的输入张量（训练口径：幅度谱、周期 Hann、148 帧 + 2 帧补 0）。 */
    public synchronized void features(short[] samples, int off) {
        for (int f = 0; f < N_REAL_FRAMES; f++) {
            int base = off + f * 160;
            for (int k = 0; k < FFT; k++) {
                window[k] = 0f;
                re[k] = 0f;
                im[k] = 0f;
            }
            for (int k = 0; k < 400; k++) {
                int s = base + k;
                window[k] = (s >= 0 && s < samples.length ? samples[s] : 0f) / 32768f * hann[k];
            }
            System.arraycopy(window, 0, re, 0, FFT);
            fft(re, im);
            for (int k = 0; k < BINS; k++) {
                mag[k] = (float) Math.sqrt(re[k] * re[k] + im[k] * im[k]);   // 幅度谱
            }
            for (int m = 0; m < N_MELS; m++) {
                float acc = 0f;
                for (int k = 0; k < BINS; k++) {
                    acc += mag[k] * mel[m][k];
                }
                input[0][f][m][0] = (float) Math.log(acc + 1e-6);
            }
        }
        // 训练侧 tf.pad 在 log-mel 域补的是 0（不是 log(1e-6)），必须照做
        for (int f = N_REAL_FRAMES; f < N_FRAMES; f++) {
            for (int m = 0; m < N_MELS; m++) {
                input[0][f][m][0] = 0f;
            }
        }
        float mean = 0f;
        for (int f = 0; f < N_FRAMES; f++) {
            for (int m = 0; m < N_MELS; m++) {
                mean += input[0][f][m][0];
            }
        }
        mean /= (N_FRAMES * N_MELS);
        float var = 0f;
        for (int f = 0; f < N_FRAMES; f++) {
            for (int m = 0; m < N_MELS; m++) {
                float d = input[0][f][m][0] - mean;
                var += d * d;
            }
        }
        float std = (float) Math.sqrt(var / (N_FRAMES * N_MELS)) + 1e-5f;
        for (int f = 0; f < N_FRAMES; f++) {
            for (int m = 0; m < N_MELS; m++) {
                input[0][f][m][0] = (input[0][f][m][0] - mean) / std;
            }
        }
    }

    /** 模型文件字节数（自检/事件行用）。 */
    public int modelBytes() {
        return modelBytes;
    }

    /** @return {classIdx, score}，score=max(p1,p2)。 */
    public synchronized float[] score(short[] samples, int off) {
        features(samples, off);
        interp.run(input, output);
        float p1 = output[0][1], p2 = output[0][2];
        int idx = p1 >= p2 ? 1 : 2;
        return new float[]{idx, Math.max(p1, p2)};
    }

    public void close() {
        try {
            interp.close();
        } catch (Throwable ignored) {
            // 忽略
        }
    }
}
