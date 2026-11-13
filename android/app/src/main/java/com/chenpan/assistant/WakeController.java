package com.chenpan.assistant;

import android.content.Context;

import ai.picovoice.porcupine.PorcupineException;
import ai.picovoice.porcupine.PorcupineManager;
import ai.picovoice.porcupine.PorcupineManagerCallback;
import ai.picovoice.porcupine.PorcupineManagerErrorCallback;

/**
 * Porcupine 唤醒引擎的薄封装：只有 start / stop / 错误记录，不做业务。
 *
 * - 由 SDK 自己开麦克风，所以**录音时必须先 stop()**，否则抢麦；
 * - 缺 AccessKey / 缺 .ppn 时根本不 build（不崩、不弹窗），状态交给 WakeRules 决定；
 * - 初始化失败把 Porcupine 的异常类名 + 原始 message 原样交给上层显示（自检区）。
 */
public final class WakeController {

    public interface Listener {
        void onWake(String keyword);

        void onWakeState(String state, String errorText);
    }

    private PorcupineManager manager;
    private boolean listening;
    private String lastError = "";
    private String state = WakeRules.OFF;
    private final Listener listener;

    public WakeController(Listener listener) {
        this.listener = listener;
    }

    public String state() {
        return state;
    }

    public String lastError() {
        return lastError;
    }

    public boolean isListening() {
        return listening;
    }

    public void start(Context ctx, String accessKey, String ppnPath, float sensitivity) {
        stopQuietly();
        if (accessKey == null || accessKey.trim().isEmpty() || ppnPath == null || ppnPath.isEmpty()) {
            // 1.3.8：缺素材不再等于「未配置」——板内 WakeNet 不依赖它们，状态按开关走。
            state = WakeRules.idleState(false);
            lastError = "";
            notifyState();
            return;
        }
        try {
            PorcupineManagerCallback cb = new PorcupineManagerCallback() {
                @Override
                public void invoke(int keywordIndex) {
                    if (listener != null) listener.onWake("鹈鹕");
                }
            };
            PorcupineManagerErrorCallback err = new PorcupineManagerErrorCallback() {
                @Override
                public void invoke(PorcupineException e) {
                    lastError = WakeRules.errorText(e == null ? "PorcupineException" : e.getClass().getSimpleName(),
                            e == null ? "" : safeMessage(e));
                    state = WakeRules.ERROR;
                    notifyState();
                }
            };
            manager = new PorcupineManager.Builder()
                    .setAccessKey(accessKey.trim())
                    .setKeywordPath(ppnPath)
                    .setSensitivity(sensitivity)
                    .setErrorCallback(err)
                    .build(ctx.getApplicationContext(), cb);
            manager.start();
            listening = true;
            lastError = "";
            state = WakeRules.ON;
        } catch (Throwable t) {
            manager = null;
            listening = false;
            lastError = WakeRules.errorText(t.getClass().getSimpleName(), t.getMessage() == null ? "" : t.getMessage());
            state = WakeRules.ERROR;
        }
        notifyState();
    }

    private static String safeMessage(PorcupineException e) {
        try {
            return e.getMessage() == null ? "" : e.getMessage();
        } catch (Throwable ignored) {
            return "";
        }
    }

    public void stop() {
        stopQuietly();
        if (!WakeRules.ERROR.equals(state)) {
            state = WakeRules.OFF;
        }
        notifyState();
    }

    private void stopQuietly() {
        if (manager != null) {
            try {
                manager.stop();
            } catch (Throwable ignored) {
                // 正在录音/已停止：忽略
            }
            try {
                manager.delete();
            } catch (Throwable ignored) {
                // 忽略
            }
            manager = null;
        }
        listening = false;
    }

    private void notifyState() {
        if (listener != null) listener.onWakeState(state, lastError);
    }
}
