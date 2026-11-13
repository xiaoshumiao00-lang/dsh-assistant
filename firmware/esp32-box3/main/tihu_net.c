/**
 * 网络层：STA Wi-Fi → 局域网 WebSocket → 鹈鹕 lane。
 *
 * 三个容易踩的坑，代码里都直接处理了：
 *   1. 板子上的 127.0.0.1 是板子自己，TIHU_HOST 必须是电脑的局域网 IP；
 *   2. WS 握手必须把 token 放在 URL 里（模拟页也这么做，cookie 在固件里不存在）；
 *   3. 断线后要重发裸 hello，不能带上次的 sessionId，否则会被当成手动逃生口。
 */
#include "tihu_net.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include "lwip/sockets.h"
#include "netdb.h"

#include "config.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "tihu_audio.h"
#include "tihu_discover.h"
#include "tihu_ota.h"
#include "tihu_protocol.h"
#include "tihu_provision.h"
#include "tihu_wifi.h"
#include "ui.h"

static const char *TAG = "tihu_net";

/**
 * 诊断宏：置 1 才打「逐分片」的下行日志（payload_offset/payload_len 一行一条分片）。
 * websocket_task 栈很紧张，默认关掉；只在抓分片/重组问题时临时改成 1。
 */
#ifndef TIHU_WS_DEBUG
#define TIHU_WS_DEBUG 0
#endif

/**
 * 用户明确点名「板子不许再连」的网络（2026-11-12）：开机从 NVS 删一次，之后绝不写回。
 * config.h 的种子 SSID 也已置空，双保险。
 */
#define TIHU_WIFI_BANNED_SSID "HBEU-Student"

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1
#define WS_RX_MAX          32768

static EventGroupHandle_t s_wifi_events;
static esp_websocket_client_handle_t s_ws;
static bool s_ws_started;
static int s_ws_task_stack;          /* 实际给 websocket_task 的栈（启动时按内部堆挑） */
static bool s_connected;
static char s_uri[320];
static char s_client_id[64];
static int64_t s_last_rx_ms;
static esp_timer_handle_t s_heartbeat_timer;
static esp_timer_handle_t s_listen_timer;
static esp_timer_handle_t s_audio_idle_timer;

/* Wi-Fi 选网状态（wifi_manager_task 独占写，事件回调只置位/通知）。 */
static TaskHandle_t s_wifi_task;
static volatile bool s_connecting;      /* 有一次 connect 正在等结果 */
static volatile bool s_wifi_up;         /* 当前这次连接已拿到 IP */
static volatile bool s_host_known;      /* 宿主地址已确定（发现或回退） */
static int s_host_port = TIHU_PORT;
static bool s_host_tls;                 /* 公网模式且 wss:// 时为 true */
static bool s_host_public;              /* 当前宿主来自公网入口（NVS host_mode=public） */
static char s_host_ip[TIHU_PUBLIC_HOST_MAX];
static char s_host_token[80];
static char s_wifi_ip[20];
static char s_wifi_ssid[33];

/*
 * WS 分片重组：正常一条 screen.frame/tts.audio 都小于 32KB。
 *
 * 这块 32 KB 原来是静态数组（.bss，直接占内部 DRAM）。内部堆本来只剩 ~19 KB 时，
 * esp_websocket_client 连 8 KB 任务栈都建不出来——把这块整体挪到 PSRAM，
 * 内部堆一次性让出 32 KB（2026-11-11 公网模式实测根因之一）。
 */
static char *s_rx_buf;
static size_t s_rx_len;

/** 懒分配 32 KB 重组缓冲（PSRAM）；失败返回 false，之后下行按分片丢弃。 */
static bool rx_buf_ensure(void)
{
    if (s_rx_buf != NULL) {
        return true;
    }
    s_rx_buf = heap_caps_malloc(WS_RX_MAX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_rx_buf == NULL) {
        ESP_LOGE(TAG, "WS 重组缓冲 %d B 分配失败（PSRAM 不够？）", WS_RX_MAX);
        return false;
    }
    ESP_LOGI(TAG, "WS 重组缓冲 %d B 走 PSRAM（内部 DRAM 让出 %d B）", WS_RX_MAX, WS_RX_MAX);
    return true;
}

/* 开机自检窗口：见 tihu_net_watch_selftest()。 */
static volatile bool s_selftest_watch;
/* 网络体检只跑一次（第一次 WS 出错时）。 */
static bool s_probe_done;

static void start_ws(void);
static void handle_text(const char *data, size_t len);
static void net_probe_task(void *arg);

/* ------------------------------ 发送 ------------------------------ */

static bool send_json_ticks(char *json, TickType_t ticks)
{
    if (json == NULL) {
        ESP_LOGW(TAG, "WS 上行组包失败（返回 NULL，多半是内存不足）——没有发送");
        return false;
    }
    if (!s_connected || s_ws == NULL) {
        ESP_LOGW(TAG, "WS 上行没发：WebSocket 未连接（字节=%d）", (int)strlen(json));
        tihu_free_message(json);
        return false;
    }
    int want = (int)strlen(json);
    /* 上行日志带上 type，串口里能直接看出是哪一条（hello / ping / ack / screen.gesture…）。 */
    char typebuf[28] = "?";
    const char *tp = strstr(json, "\"type\":\"");
    if (tp != NULL) {
        tp += 8;
        const char *te = strchr(tp, '"');
        size_t n = te != NULL ? (size_t)(te - tp) : 0;
        if (n > 0 && n < sizeof(typebuf)) {
            memcpy(typebuf, tp, n);
            typebuf[n] = '\0';
        }
    }
    int sent = esp_websocket_client_send_text(s_ws, json, want, ticks);
    bool ok = sent == want;
    ESP_LOGI(TAG, "WS 上行 type=%s 字节=%d 发送返回=%d → %s", typebuf, want, sent,
             ok ? "已写入" : "不完整");
    if (!ok) {
        ESP_LOGW(TAG, "WS 发送不完整 (%d/%d)，下一次心跳会触发重连", sent, want);
    }
    tihu_free_message(json);
    return ok;
}

static bool send_json(char *json)
{
    /* 常规上行：允许等 10 s（一条 base64 WAV 有 400 KB 级，慢链路要时间）。 */
    return send_json_ticks(json, pdMS_TO_TICKS(10000));
}

bool tihu_net_send_alert(const char *level, const char *text)
{
    /*
     * 0.3.9 诊断旁路：按键回调（跑在 esp_timer 任务里）发一条 event.alert 自证。
     *
     * 为什么单独给 300 ms 上限：这条消息只用来「让宿主日志里出现一行」，
     * 没有任何功能语义；而 esp_timer 任务是全系统的定时器心脏（iot_button 每 5 ms
     * 在这里轮询按键、WS 心跳/录音收尾定时器也在这里），为了一条诊断消息把它
     * 卡上 10 秒，换来的是按键彻底失灵——正好是这次要避免的症状。
     */
    if (text == NULL || text[0] == '\0') {
        return false;
    }
    if (!s_connected || s_ws == NULL) {
        ESP_LOGW(TAG, "事件只打日志（WS 未连接）：level=%s text=%s",
                 level != NULL ? level : "info", text);
        return false;
    }
    return send_json_ticks(tihu_build_alert(level, text), pdMS_TO_TICKS(300));
}
bool tihu_net_connected(void)
{
    return s_connected;
}

void tihu_net_send_text(const char *text, const char *source)
{
    send_json(tihu_build_text_input(text, source));
}

void tihu_net_send_wav(const uint8_t *wav, size_t len)
{
    if (wav == NULL || len <= 44) {
        return;
    }
    int duration_ms = (int)(((len - 44) * 1000) / (16000 * 2));
    send_json(tihu_build_audio_frame(wav, len, duration_ms));
}

bool tihu_net_send_tap(int x, int y, const char *hit,
                       const char *action_id, const char *task_id)
{
    char *json = tihu_build_screen_tap(x, y, hit, action_id, task_id);
    if (json == NULL) {
        ESP_LOGE(TAG, "screen.gesture 组包失败（内存不足？）x=%d y=%d hit=%s actionId=%s",
                 x, y, hit != NULL ? hit : "", action_id != NULL ? action_id : "");
        return false;
    }
    bool ok = send_json(json);
    if (!ok) {
        /* 点屏唯一的下行出口：失败必须能在串口里看见，否则屏上就是「点了没反应」。 */
        ESP_LOGW(TAG, "screen.gesture 没发出去（%s）：x=%d y=%d hit=%s actionId=%s taskId=%s",
                 s_connected ? "WS 写失败" : "WebSocket 未连接",
                 x, y, hit != NULL ? hit : "",
                 action_id != NULL ? action_id : "", task_id != NULL ? task_id : "");
    }
    return ok;
}

void tihu_net_watch_selftest(bool on)
{
    s_selftest_watch = on;
    ESP_LOGI(TAG, "自检回执窗口：%s（这期间每条下行都打 type=）", on ? "开" : "关");
}

void tihu_net_send_session_end(const char *reason)
{
    send_json(tihu_build_session_end(reason));
}

void tihu_net_send_ack(const char *op_id, bool ok, const char *reason,
                       const char *stage, int screen_version)
{
    send_json(tihu_build_device_ack(op_id, ok, reason, stage, screen_version));
}

void tihu_net_send_playback_state(const char *phase, const char *task_id,
                                  int segment, int line, int total, int char_start)
{
    send_json(tihu_build_playback_state(phase, task_id, segment, line, total, char_start));
}

/* ------------------------------ 下行分发 ------------------------------ */

static void show_text_screen(const char *stage, const char *title,
                             const char *line, const char *tone)
{
    /*
     * 静态：tihu_screen_frame_t 带 done.lines[16] ≈5 KB，压在 websocket 任务（8 KB 栈）上会爆栈。
     * 本函数只在 WS 任务里调，单实例足够。
     */
    static tihu_screen_frame_t frame;
    memset(&frame, 0, sizeof(frame));
    snprintf(frame.stage, sizeof(frame.stage), "%s", stage != NULL ? stage : "");
    snprintf(frame.title, sizeof(frame.title), "%s", title != NULL ? title : "");
    if (line != NULL && line[0] != '\0') {
        snprintf(frame.bullets[0], sizeof(frame.bullets[0]), "%s", line);
        frame.bullet_count = 1;
    }
    snprintf(frame.tone, sizeof(frame.tone), "%s", tone != NULL ? tone : "idle");
    snprintf(frame.mode, sizeof(frame.mode), "status");
    tihu_ui_show_frame(&frame);
}

static void audio_idle_cb(void *arg)
{
    (void)arg;
    if (!tihu_audio_busy()) {
        tihu_net_send_playback_state("idle", NULL, 0, -1, 0, -1);
    }
}

static void arm_audio_idle(size_t pcm_len)
{
    if (s_audio_idle_timer == NULL) {
        return;
    }
    int64_t duration_ms = (int64_t)((pcm_len / 2) * 1000 / 24000);
    esp_timer_stop(s_audio_idle_timer);
    esp_timer_start_once(s_audio_idle_timer, (uint64_t)(duration_ms + 500) * 1000);
}

static void listen_timeout_cb(void *arg)
{
    (void)arg;
    size_t len = 0;
    const uint8_t *wav = tihu_audio_mic_stop(&len);
    tihu_ui_set_listening(false, NULL);
    if (wav != NULL && len > 44) {
        tihu_net_send_wav(wav, len);
    }
    tihu_net_send_playback_state("idle", NULL, 0, -1, 0, -1);
}

void tihu_net_cancel_listen(void)
{
    if (s_listen_timer != NULL) {
        esp_timer_stop(s_listen_timer);
    }
}

static void handle_screen(const tihu_screen_frame_t *frame)
{
    tihu_ui_show_frame(frame);
    if (frame->op_id[0] != '\0') {
        tihu_net_send_ack(frame->op_id, true, NULL, tihu_ui_stage_name(), frame->frame_seq);
    }
}

static void handle_playback(const tihu_playback_control_t *control)
{
    const char *action = control->action;
    bool ok = true;
    const char *reason = NULL;

    if (strcmp(action, "stop") == 0) {
        if (s_audio_idle_timer != NULL) {
            esp_timer_stop(s_audio_idle_timer);
        }
        tihu_audio_stop();
        tihu_net_send_playback_state("idle", NULL, 0, -1, 0, -1);
    } else if (strcmp(action, "pause") == 0) {
        if (s_audio_idle_timer != NULL) {
            esp_timer_stop(s_audio_idle_timer);
        }
        tihu_audio_pause();
        tihu_net_send_playback_state("paused", NULL, 0, -1, 0, -1);
    } else if (strcmp(action, "resume") == 0) {
        tihu_audio_resume();
        tihu_net_send_playback_state("playing", control->from_task_id,
                                     control->from_segment, control->from_line, 0, -1);
    } else if (strcmp(action, "seek") == 0) {
        /* 段级 seek：先停当前声，宿主随后从 from.segment 重发 PCM。 */
        if (s_audio_idle_timer != NULL) {
            esp_timer_stop(s_audio_idle_timer);
        }
        tihu_audio_stop();
        tihu_net_send_playback_state("idle", control->from_task_id,
                                     control->from_segment, control->from_line, 0, -1);
    } else {
        ok = false;
        reason = "unsupported";
    }

    tihu_net_send_ack(control->op_id, ok, reason, tihu_ui_stage_name(), -1);
    if (!ok) {
        ESP_LOGW(TAG, "不认识的 playback.control action=%s", action);
    }
}

static void handle_voice_listen(const tihu_voice_listen_t *listen)
{
    if (listen->on) {
        /* 先停声再开麦：避免 24k 播放和 16k 录音抢同一个 I2S。 */
        tihu_audio_stop();
        if (!tihu_audio_mic_start()) {
            /* 0.3.9：宿主让开麦但麦克风没就绪——屏上必须说清楚，并回一条不成功回执。 */
            ESP_LOGW(TAG, "voice.listen：麦克风未就绪，无法进入在听");
            tihu_ui_set_listening(true, "麦克风未就绪");
            tihu_net_send_alert("warn", "麦克风未就绪");
            tihu_net_send_ack(listen->op_id, false, "mic_not_ready", tihu_ui_stage_name(), -1);
            return;
        }
        tihu_ui_set_listening(true, listen->prompt[0] != '\0' ? listen->prompt : "在听 · 请说话");
        int timeout_ms = listen->timeout_ms;
        if (timeout_ms < 3000) {
            timeout_ms = 3000;
        }
        if (timeout_ms > 60000) {
            timeout_ms = 60000;
        }
        if (s_listen_timer != NULL) {
            esp_timer_stop(s_listen_timer);
            esp_timer_start_once(s_listen_timer, (uint64_t)timeout_ms * 1000);
        }
        tihu_net_send_ack(listen->op_id, true, NULL, "在听", -1);
    } else {
        tihu_net_cancel_listen();
        size_t len = 0;
        (void)tihu_audio_mic_stop(&len);   /* 丢弃：宿主明确要求退出在听 */
        tihu_ui_set_listening(false, NULL);
        tihu_net_send_playback_state("idle", NULL, 0, -1, 0, -1);
        tihu_net_send_ack(listen->op_id, true, NULL, tihu_ui_stage_name(), -1);
    }
}

static void handle_config(const tihu_device_config_t *config)
{
    if (strcmp(config->key, "voice") == 0) {
        /* 真机的音色由宿主 edge-tts/Qwen 合成，设备只负责播放，回执说明这一点。 */
        tihu_net_send_ack(config->op_id, true, NULL, "音色由宿主合成", -1);
    } else if (strcmp(config->key, "handsfree") == 0) {
        /* 固件没有本地唤醒词；不要假装成功。 */
        tihu_net_send_ack(config->op_id, false, "unsupported", tihu_ui_stage_name(), -1);
    } else if (strcmp(config->key, "scale") == 0) {
        tihu_net_send_ack(config->op_id, false, "unsupported", tihu_ui_stage_name(), -1);
    } else {
        tihu_net_send_ack(config->op_id, false, "unsupported", tihu_ui_stage_name(), -1);
    }
}

static void handle_downstream(const tihu_downstream_t *msg)
{
    /* 开机自检窗口里把宿主回包点出来（tts.audio 每秒几十帧，跳过）。 */
    if (s_selftest_watch && msg->type != TIHU_DOWN_TTS_AUDIO) {
        ESP_LOGI(TAG, "自检回执 type=%s（宿主已收到设备的 screen.gesture）", msg->type_name);
    }
    switch (msg->type) {
    case TIHU_DOWN_SCREEN_FRAME:
        handle_screen(&msg->u.screen);
        break;
    case TIHU_DOWN_TTS_AUDIO:
        if (msg->u.tts.pcm != NULL && msg->u.tts.pcm_len > 0) {
            /*
             * karaoke 进度只在「一整段朗读真的重新开始」时清零：
             * 宿主是「一行一段」，每行第一块都是 seq=0；旧代码见 seq==0 就 reset_stats()，
             * 等于每 0.6 s 把 pushed/written 打回 0，比例永远在 0–100% 之间来回摆
             * （实机日志 6/7→5/7→6/7，高亮完全不跟声音）。现在要求 seq==0 **且** 段号
             * index==0 **且** 播放已排空，才算新一轮。
             */
            if (!msg->u.tts.sample && msg->u.tts.seq == 0 && msg->u.tts.index == 0 &&
                tihu_audio_progress_idle()) {
                tihu_audio_reset_stats();
            }
            /* 每块长度必须上串口：奇数块/超长块是「滋滋」的第一手证据。 */
            ESP_LOGI(TAG, "tts.audio seq=%d 块长=%u 字节（%u 采样）index=%d sample=%d final=%d",
                     msg->u.tts.seq, (unsigned)msg->u.tts.pcm_len,
                     (unsigned)(msg->u.tts.pcm_len / 2), msg->u.tts.index,
                     msg->u.tts.sample ? 1 : 0, msg->u.tts.final ? 1 : 0);
            /* 每行首块（seq==0）在 push 之前记下这一行的起始字节偏移：karaoke 按它查行号。 */
            if (!msg->u.tts.sample && msg->u.tts.seq == 0) {
                tihu_audio_note_line(msg->u.tts.index);
            }
            tihu_audio_push_pcm(msg->u.tts.pcm, msg->u.tts.pcm_len);
            if (msg->u.tts.seq == 0) {
                tihu_net_send_playback_state("playing", NULL,
                                             msg->u.tts.index + 1, -1, 0, -1);
            }
            if (msg->u.tts.final) {
                /*
                 * 播放质量汇总不在这里打：此刻音频还在缓冲里播（最多 5 秒），欠载数会偏小。
                 * 只标一个 final，由 audio_task 在真正排空时打
                 * 「播放统计：欠载=N 最大空档=xxms 峰值缓冲=xxKB」。
                 */
                tihu_audio_mark_final();
                arm_audio_idle(msg->u.tts.pcm_len);
            }
        }
        break;
    case TIHU_DOWN_PLAYBACK_CONTROL:
        handle_playback(&msg->u.playback);
        break;
    case TIHU_DOWN_VOICE_LISTEN:
        handle_voice_listen(&msg->u.listen);
        break;
    case TIHU_DOWN_DEVICE_CONFIG:
        handle_config(&msg->u.config);
        break;
    case TIHU_DOWN_SESSION_ENDED:
        tihu_audio_stop();
        tihu_net_cancel_listen();
        tihu_ui_set_listening(false, NULL);
        show_text_screen("空闲", "本次语音会话已结束",
                         msg->u.ended.reason[0] != '\0' ? msg->u.ended.reason : "可以重新说一句话",
                         "idle");
        tihu_net_send_ack(msg->u.ended.op_id, true, NULL, "空闲", -1);
        break;
    case TIHU_DOWN_EVENT_ALERT:
        ESP_LOGW(TAG, "宿主告警[%s]：%s", msg->u.alert.level, msg->u.alert.text);
        tihu_ui_show_alert(msg->u.alert.text);
        break;
    case TIHU_DOWN_TRANSCRIPT:
        ESP_LOGI(TAG, "转写：%s", msg->u.transcript.text);
        break;
    case TIHU_DOWN_EVENT_PROGRESS:
        ESP_LOGI(TAG, "事件[%s]：%s", msg->u.progress.stage, msg->u.progress.text);
        break;
    case TIHU_DOWN_PONG:
        break;
    case TIHU_DOWN_UNKNOWN:
    default:
        ESP_LOGI(TAG, "忽略未知下行 type=%s", msg->type_name);
        break;
    }
}

/** 从 JSON 里抠一个字符串字段（只用于 device.ota 这种小指令，够用就好）。 */
static void json_field_str(const char *json, const char *key, char *out, size_t cap)
{
    out[0] = '\0';
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (p == NULL) {
        return;
    }
    const char *colon = strchr(p + strlen(pat), ':');
    const char *q1 = colon != NULL ? strchr(colon, '"') : NULL;
    if (q1 == NULL) {
        return;
    }
    const char *q2 = strchr(q1 + 1, '"');
    if (q2 == NULL) {
        return;
    }
    size_t n = (size_t)(q2 - q1 - 1);
    if (n >= cap) {
        n = cap - 1;
    }
    memcpy(out, q1 + 1, n);
    out[n] = '\0';
}

/**
 * 下行 device.ota：宿主要求「立即检查 / 立即升级」。
 * payload 里 url/version 都可选；url 支持相对路径（/tihu/ota/manifest）或绝对地址。
 */
static void handle_device_ota(const char *data, size_t len)
{
    char buf[512];
    size_t n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
    if (data != NULL) {
        memcpy(buf, data, n);
    }
    buf[n] = '\0';
    char url[160];
    char ver[40];
    json_field_str(buf, "url", url, sizeof(url));
    json_field_str(buf, "version", ver, sizeof(ver));
    ESP_LOGW(TAG, "收到 device.ota：立即检查 OTA（目标版本=%s，清单=%s）",
             ver[0] != '\0' ? ver : "(由清单决定)", url[0] != '\0' ? url : "(默认 /tihu/ota/manifest)");
    tihu_ota_trigger("ws device.ota", url);
}

static void handle_text(const char *data, size_t len)
{
    /*
     * 为什么是 static：tihu_downstream_t 有 screen.bullets[4][160] 这些，≈1.2 KB。
     * 放在 websocket_task 栈上（原来 4 KB）第一帧下行就能把栈压爆——2026-11-12 实测。
     * 这个函数只由 websocket_task 调用（单线程），静态缓冲安全。
     */
    static tihu_downstream_t msg;
    if (!tihu_parse_downstream(data, len, &msg)) {
        ESP_LOGW(TAG, "坏帧或非 v0 信封，已忽略 (%u 字节)", (unsigned)len);
        return;
    }
    /* 每帧一行、只拼两个短参数（诊断期要求：收到任何下行都看得见，但别再给 WS 栈加压）。 */
    ESP_LOGI(TAG, "下行帧 type=%s %uB", msg.type_name, (unsigned)len);
    if (strcmp(msg.type_name, "device.ota") == 0) {
        handle_device_ota(data, len);
        tihu_downstream_free(&msg);
        return;
    }
    handle_downstream(&msg);
    tihu_downstream_free(&msg);
}

/* ------------------------------ WS 事件 ------------------------------ */

#if TIHU_AUDIO_SELFTEST
/** 一次开机只自检一次（断线重连不重复「嘟」）。 */
static volatile bool s_selftest_done;

/**
 * 开机音频自检：先播 0.5 s 正弦（验证 I2S/codec 通路），再向宿主请求一句 tts.sample
 * （验证真实 TTS 链路 + 当前音色）。两段之间留 1.2 s，避免叠在一起听不清。
 */
static void audio_selftest_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(800));
    tihu_audio_play_sine_test();
    vTaskDelay(pdMS_TO_TICKS(1500));
    ESP_LOGI(TAG, "音频自检：向宿主请求 tts.sample（%s）", TIHU_AUDIO_SELFTEST_TEXT);
    send_json(tihu_build_tts_sample(TIHU_AUDIO_SELFTEST_TEXT));
    vTaskDelete(NULL);
}
#endif

static void ws_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)base;
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;

    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED: {
        s_connected = true;
        s_last_rx_ms = tihu_protocol_now_ms();
        s_rx_len = 0;
        ESP_LOGI(TAG, "WebSocket 已连接（HTTP 101 升级成功，握手完成）：%s（TLS=%s）", s_uri,
                 s_host_tls ? "开，未校验证书（仅测试）" : "关");
        tihu_ui_set_connection(true, "已连接");
        /* hello 诊断：先量字节再发（send_json 内部会 free 这包，之后不能再看它的指针）。 */
        char *hello = tihu_build_hello(s_client_id, TIHU_DEVICE_NAME);
        int hello_bytes = hello != NULL ? (int)strlen(hello) : 0;
        ESP_LOGI(TAG, "CONNECTED 事件里已调用 send_json(hello)：clientId=%s 组包%s 字节=%d",
                 s_client_id, hello != NULL ? "成功" : "失败（返回 NULL，多半内存不足）", hello_bytes);
        bool hello_ok = send_json(hello);
        ESP_LOGI(TAG, "hello 发送结果：%s（字节=%d；上行日志行含 esp_websocket_client_send_text 的返回值）",
                 hello_ok ? "成功" : "失败", hello_bytes);
        /* 协议 §6.3：重连先报 idle，宿主丢掉上一轮“朗读中”的假设。 */
        tihu_net_send_playback_state("idle", NULL, 0, -1, 0, -1);
#if TIHU_AUDIO_SELFTEST
        if (!s_selftest_done) {
            s_selftest_done = true;
            if (xTaskCreate(audio_selftest_task, "tihu_selftest", 4096, NULL, 4, NULL) != pdPASS) {
                ESP_LOGE(TAG, "音频自检任务创建失败");
            }
        }
#endif
        break;
    }

    case WEBSOCKET_EVENT_DISCONNECTED:
        s_connected = false;
        s_rx_len = 0;
        ESP_LOGW(TAG, "WebSocket 断开，等待自动重连");
        tihu_ui_set_connection(false, "重连中");
        tihu_audio_stop();
        break;

    case WEBSOCKET_EVENT_CLOSED:
        /* clean close 之后客户端不会自己再连；把标志放下，心跳会重新 start。 */
        s_connected = false;
        s_ws_started = false;
        s_rx_len = 0;
        ESP_LOGW(TAG, "WebSocket 已关闭，等待下一次心跳重连");
        break;

    case WEBSOCKET_EVENT_DATA:
        if (data == NULL) {
            break;
        }
        s_last_rx_ms = tihu_protocol_now_ms();
        /* 诊断版：非文本帧也要看得见（宿主发二进制/ping/关闭帧时不要闷在肚子里）。 */
        if (data->op_code != 0x1) {
            ESP_LOGI(TAG, "下行非文本 op=0x%02x len=%d", (unsigned)data->op_code, data->data_len);
        }
        if (data->op_code == 0x9) {
            break;  /* 底层 ping 由 esp_websocket_client 自己回 pong */
        }
        if (data->op_code != 0x1) {
            break;
        }
#if TIHU_WS_DEBUG
        ESP_LOGI(TAG, "下行分片 off=%d len=%d total=%d", (int)data->payload_offset,
                 data->data_len, (int)data->payload_len);
#endif
        /* 分片重组：payload_offset==0 表示新的一条消息。 */
        if (!rx_buf_ensure()) {
            break;
        }
        if (data->payload_offset == 0) {
            s_rx_len = 0;
        }
        if (s_rx_len + (size_t)data->data_len > WS_RX_MAX) {
            ESP_LOGW(TAG, "下行消息超过 %d 字节，丢弃", WS_RX_MAX);
            s_rx_len = 0;
            break;
        }
        memcpy(s_rx_buf + s_rx_len, data->data_ptr, (size_t)data->data_len);
        s_rx_len += (size_t)data->data_len;
        if (data->payload_offset + data->data_len >= data->payload_len) {
            handle_text(s_rx_buf, s_rx_len);
            s_rx_len = 0;
        }
        break;

    case WEBSOCKET_EVENT_ERROR:
        s_connected = false;
        if (!s_probe_done) {
            /* 第一次连不上就跑一次网络体检（只诊断，不影响重连）。 */
            s_probe_done = true;
            if (xTaskCreate(net_probe_task, "tihu_netprobe", 4096, NULL, 2, NULL) != pdPASS) {
                ESP_LOGW(TAG, "网络体检任务创建失败（不影响重连）");
            }
        }
        if (data != NULL) {
            /* 公网/局域网都要能一眼看出「TCP 没通 / TLS 没过 / HTTP 升级被拒」。 */
            ESP_LOGW(TAG, "WebSocket 错误：type=%d http=%d errno=%d tls_esp=0x%x 目标=%s",
                     (int)data->error_handle.error_type,
                     data->error_handle.esp_ws_handshake_status_code,
                     data->error_handle.esp_transport_sock_errno,
                     (unsigned)data->error_handle.esp_tls_last_esp_err, s_uri);
        } else {
            ESP_LOGW(TAG, "WebSocket 错误，底层会自动重连");
        }
        tihu_ui_set_connection(false, "重连中");
        break;

    default:
        break;
    }
}

/** 内存水位：WS 启动前后、失败时都打一条，看是不是内部 RAM 卡住的。 */
static void log_ws_mem(const char *why)
{
    ESP_LOGI(TAG, "WS 内存（%s）：内部堆 %u B / 最大块 %u B / 历史最低 %u B，PSRAM %u B / 最大块 %u B",
             why,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
}

/* --------------------------- 连不上时的网络体检 --------------------------- */

/*
 * 「WebSocket 错误 type=1 … select() timeout」有两种可能：真没网（网关/防火墙丢 SYN），
 * 或者只是路由/ARP 不通。一次性的 TCP 体检能把它们区分开：
 *   通 0       → 目标可达
 *   -102       → 超时，SYN 没人回（路由/防火墙/AP 隔离）
 *   ECONNREFUSED → 端口关着但主机可达（网络本身是好的）
 * 只在第一次 WS 出错时跑一次，不打扰正常重连。
 */
static int probe_tcp(const char *host, int port, int timeout_ms)
{
    struct sockaddr_in dest;
    memset(&dest, 0, sizeof(dest));
    dest.sin_family = AF_INET;
    dest.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &dest.sin_addr) != 1) {
        return -101;
    }
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) {
        return -103;
    }
    int flags = fcntl(s, F_GETFL, 0);
    fcntl(s, F_SETFL, flags | O_NONBLOCK);
    int rc = connect(s, (struct sockaddr *)&dest, sizeof(dest));
    if (rc != 0 && errno != EINPROGRESS) {
        int e = errno;
        close(s);
        return -e;
    }
    fd_set wfds;
    FD_ZERO(&wfds);
    FD_SET(s, &wfds);
    struct timeval tv = {timeout_ms / 1000, (timeout_ms % 1000) * 1000};
    rc = select(s + 1, NULL, &wfds, NULL, &tv);
    if (rc == 0) {
        close(s);
        return -102;
    }
    int soerr = 0;
    socklen_t len = sizeof(soerr);
    getsockopt(s, SOL_SOCKET, SO_ERROR, &soerr, &len);
    close(s);
    return soerr;
}

static void probe_report(const char *host, int port)
{
    int e = probe_tcp(host, port, 4000);
    if (e == 0) {
        ESP_LOGI(TAG, "体检 %s:%d → 通", host, port);
    } else if (e == -102) {
        ESP_LOGW(TAG, "体检 %s:%d → 超时（SYN 没回应：路由/防火墙/AP 隔离）", host, port);
    } else if (e == ECONNREFUSED) {
        ESP_LOGW(TAG, "体检 %s:%d → 端口关闭（主机可达，网络本身没问题）", host, port);
    } else {
        ESP_LOGW(TAG, "体检 %s:%d → 失败 code=%d", host, port, e);
    }
}

static void net_probe_task(void *arg)
{
    (void)arg;
    wifi_ap_record_t ap;
    memset(&ap, 0, sizeof(ap));
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        ESP_LOGI(TAG, "体检：AP ssid=\"%s\" rssi=%d dBm ch=%d bssid=%02x:%02x:%02x:%02x:%02x:%02x",
                 ap.ssid, ap.rssi, ap.primary, ap.bssid[0], ap.bssid[1], ap.bssid[2],
                 ap.bssid[3], ap.bssid[4], ap.bssid[5]);
    }
    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t ip;
    memset(&ip, 0, sizeof(ip));
    if (sta != NULL && esp_netif_get_ip_info(sta, &ip) == ESP_OK) {
        ESP_LOGI(TAG, "体检：本机 " IPSTR " 掩码 " IPSTR " 网关 " IPSTR,
                 IP2STR(&ip.ip), IP2STR(&ip.netmask), IP2STR(&ip.gw));
        char gw[16];
        snprintf(gw, sizeof(gw), IPSTR, IP2STR(&ip.gw));
        probe_report(gw, 80);
        probe_report(gw, 443);
    }
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int gai = getaddrinfo("www.baidu.com", "443", &hints, &res);
    ESP_LOGI(TAG, "体检：DNS www.baidu.com → %s", gai == 0 ? "解析成功" : "解析失败");
    if (res != NULL) {
        freeaddrinfo(res);
    }
    probe_report("223.5.5.5", 53);
    probe_report("49.234.20.84", 80);
    probe_report("49.234.20.84", 443);
    probe_report("49.234.20.84", 8443);
    probe_report("49.234.20.84", 7080);
    ESP_LOGI(TAG, "体检结束（上行是 TCP connect，不代表 TLS/业务层）");
    vTaskDelete(NULL);
}

/**
 * 按当前内部堆挑 websocket_task 的栈：8 KB 优先，拿不出连续块就退 6144，再不行回 4096。
 *
 * 为什么不再固定 4 KB：2026-11-12 实机第一次收到下行（session.bound）就
 * `***ERROR*** A stack overflow in task websocket_task`，4 KB 顶不住「解析 + 打日志」。
 * 32 KB 重组缓冲挪到 PSRAM 之后，内部最大块回到 30 KB 量级，8 KB 栈可以分配了。
 * 阈值留 2 KB 余量：任务控制块 + esp_websocket_client 启动时自己的 malloc 也要内部 RAM。
 */
static int ws_task_stack_pick(void)
{
    static const int cand[] = {8192, 6144};
    size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    for (size_t i = 0; i < sizeof(cand) / sizeof(cand[0]); i++) {
        if (largest >= (size_t)cand[i] + 2048u) {
            return cand[i];
        }
    }
    return 4096;
}

static void start_ws(void)
{
    if (s_ws == NULL) {
        s_ws_task_stack = ws_task_stack_pick();
        esp_websocket_client_config_t cfg = {
            .uri = s_uri,
            .reconnect_timeout_ms = 3000,
            .network_timeout_ms = 10000,
            /*
             * 2 KB：原来 16 KB。esp_websocket_client 的 rx/tx 两块缓冲是 malloc，
             * 默认能力=内部优先，16 KB×2 直接在内部堆里吃掉 32 KB——内部堆只剩 19 KB
             * 时这比任务栈更致命。2 KB 后内部只占 4 KB，大消息靠分片重组，行为不变。
             */
            .buffer_size = 2048,
            .disable_auto_reconnect = false,
            /*
             * 任务栈：原来 4 KB（当初内部堆没有 8 KB 连续块，8 KB 根本建不出来），
             * 结果第一帧下行就爆栈。现在按内部堆动态挑（见 ws_task_stack_pick）。
             */
            .task_stack = s_ws_task_stack,
        };
        ESP_LOGW(TAG, "WS 任务栈：%d B（候选 8192/6144/4096，内部堆 %u B，内部最大块 %u B）",
                 s_ws_task_stack,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        if (s_host_tls) {
            /* 测试阶段只求连通：不装 CA、不比对证书 CN（走公网时链路上仍是 TLS 加密）。
             * 正式发布前应改成 crt_bundle_attach = esp_crt_bundle_attach。 */
            cfg.skip_cert_common_name_check = true;
        }
        s_ws = esp_websocket_client_init(&cfg);
        if (s_ws == NULL) {
            ESP_LOGE(TAG, "esp_websocket_client_init 失败（栈 %d B，内部最大块 %u B）",
                     s_ws_task_stack,
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            log_ws_mem("init 失败");
            return;
        }
        esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);
    }
    if (!s_ws_started) {
        log_ws_mem("start 前");
        esp_err_t err = esp_websocket_client_start(s_ws);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "WebSocket 启动失败: %s（栈 %d B 需要一块连续内部 RAM；内部最大块 %u B）",
                     esp_err_to_name(err), s_ws_task_stack,
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            log_ws_mem("start 失败");
            if (heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) < 12288) {
                ESP_LOGE(TAG, "内部最大块 < 12 KB：xTaskCreate 必失败。需要继续往 PSRAM 挪缓冲，"
                              "或改成 xTaskCreateWithCaps(..., MALLOC_CAP_SPIRAM) 建 WS 任务");
            }
            return;
        }
        s_ws_started = true;
        ESP_LOGI(TAG, "WebSocket 启动：%s（TLS=%s，栈 %d B / 缓冲 2048 B）", s_uri,
                 s_host_tls ? "开，未校验证书（仅测试）" : "关", s_ws_task_stack);
        log_ws_mem("启动后");
    }
}

static const char *wifi_reason_cn(uint8_t reason)
{
    switch (reason) {
    case WIFI_REASON_AUTH_EXPIRE:
        return "认证超时（密码或加密方式不匹配）";
    case WIFI_REASON_AUTH_LEAVE:
        return "AP 主动断开（认证阶段）";
    case WIFI_REASON_ASSOC_EXPIRE:
        return "关联超时（信号弱/AP 忙）";
    case WIFI_REASON_ASSOC_TOOMANY:
        return "AP 关联数已满";
    case WIFI_REASON_NOT_AUTHED:
        return "未认证就收到数据（AP 要求重新认证）";
    case WIFI_REASON_NOT_ASSOCED:
        return "未关联就收到数据";
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
        return "四次握手超时＝密码不对（也见于 PMF/WPA3 混用）";
    case WIFI_REASON_AUTH_FAIL:
        return "AP 拒绝认证（密码错；热点刚开机/STA 表满/刚踢过人时也会瞬时拒绝——下一次重试能通就不是密码问题）";
    case WIFI_REASON_ASSOC_FAIL:
        return "关联被拒（加密方式不兼容）";
    case WIFI_REASON_CONNECTION_FAIL:
        return "连接失败（AP 拒绝或还没准备好；重试能通属瞬时拒绝）";
    case WIFI_REASON_NO_AP_FOUND:
        return "扫不到这个 SSID（不在 2.4G / 隐藏 / 已关机）";
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
        return "扫到 SSID 但加密不兼容（可能是 WPA3 专用或 WPA2/WPA3 混合）";
    case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
        return "扫到 SSID 但低于 authmode 阈值（不是 WPA2-PSK）";
    case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
        return "扫到 SSID 但信号太弱";
    case WIFI_REASON_802_1X_AUTH_FAILED:
        return "802.1X 认证失败（这是企业网，不是 WPA2 个人版）";
    case WIFI_REASON_BEACON_TIMEOUT:
        return "丢 beacon（信号中断）";
    case WIFI_REASON_STA_LEAVING:
        return "设备主动离开（本地断开）";
    default:
        return "未归类的 reason，按上面的码去对 esp_wifi_types.h";
    }
}
/* ------------------------------ Wi-Fi：多网络记忆 + 自动选网 ------------------------------ */

/*
 * 一条完整的决策链（串口里每一步都有）：
 *   扫可见 AP → 只在「已记住」里选（最后成功的排第一，其余按信号强弱）
 *   → 逐个试；连上就把 SSID 记成「最后成功」，下次开机优先
 *   → 全失败就开配网热点 Pelican-Setup-xxxx，等手机加网络（保存后重启）
 *   → 宿主地址：UDP 广播发现 → 回退 NVS 上次成功的地址 → 回退 config.h（调试用）
 * 掉线不重启、不要求用户干预：置位后由本任务重新扫、重新选。
 */

static void start_ws(void);
static void build_uri(void);
static bool resolve_host(void);

/** 候选的加密方式：按 SSID 回查扫描结果；没扫到就按 WPA2-PSK 猜。 */
static uint8_t authmode_of(const tihu_ap_info_t *aps, int ap_count, const char *ssid)
{
    for (int i = 0; i < ap_count; i++) {
        if (strcmp(aps[i].ssid, ssid) == 0) {
            return aps[i].authmode;
        }
    }
    return (uint8_t)WIFI_AUTH_WPA2_PSK;
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)arg;
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        /* 不在这里自动连：选什么网、按什么顺序，全交给 wifi_manager_task。 */
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_CONNECTED) {
        ESP_LOGI(TAG, "STA 已关联 AP，等 DHCP…");
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_AP_START) {
        ESP_LOGI(TAG, "配网热点已启动（AP_START）：\"%s\"", tihu_provision_ap_ssid());
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *evt = (wifi_event_sta_disconnected_t *)event_data;
        uint8_t reason = evt != NULL ? evt->reason : 0;
        ESP_LOGW(TAG, "Wi-Fi 断开 reason=%u：%s", (unsigned)reason, wifi_reason_cn(reason));
        tihu_ui_set_connection(false, "Wi-Fi 断开");
        if (s_connecting) {
            /* 正在等结果的那次尝试失败：立刻叫醒 try_connect，别干等 12 秒超时。 */
            xEventGroupSetBits(s_wifi_events, WIFI_FAIL_BIT);
        } else if (s_wifi_up) {
            s_wifi_up = false;
            if (s_wifi_task != NULL) {
                xTaskNotifyGive(s_wifi_task);
            }
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        snprintf(s_wifi_ip, sizeof(s_wifi_ip), IPSTR, IP2STR(&event->ip_info.ip));
        s_wifi_up = true;
        ESP_LOGI(TAG, "Wi-Fi 已获取 IP：%s（ssid=\"%s\"）", s_wifi_ip, s_wifi_ssid);
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
        tihu_ui_set_connection(false, "找宿主");
    }
}

/**
 * 试一组凭据（单次）：写 STA 配置 → connect → 等 GOT_IP（最多 TIHU_WIFI_TRY_TIMEOUT_MS）。
 * 失败会主动 disconnect，让下一组候选干净地开始。
 */
static bool try_connect_once(const tihu_wifi_cred_t *cred, int rssi, uint8_t authmode)
{
    ESP_LOGI(TAG, "  正在试：ssid=\"%s\" rssi=%d auth=%s", cred->ssid, rssi,
             tihu_wifi_auth_name(authmode));
    tihu_ui_set_connection(false, "连接 Wi-Fi");

    wifi_config_t cfg = {0};
    /* 长度已由 NVS 写入时校验过（SSID≤32、密码≤64），这里按目标字段上限截断，不再走 snprintf
     * ——GCC 的 -Wformat-truncation 对它报警（报错等于编不过）。 */
    memcpy(cfg.sta.ssid, cred->ssid, strnlen(cred->ssid, sizeof(cfg.sta.ssid) - 1));
    memcpy(cfg.sta.password, cred->password,
           strnlen(cred->password, sizeof(cfg.sta.password) - 1));
    if (cred->password[0] == '\0') {
        cfg.sta.threshold.authmode = WIFI_AUTH_OPEN;
    } else if (authmode == (uint8_t)WIFI_AUTH_WPA3_PSK) {
        cfg.sta.threshold.authmode = WIFI_AUTH_WPA3_PSK;
    } else {
        cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    }
    cfg.sta.threshold.rssi = -127;
    cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    /* PMF（802.11w）可选、不强制：有些手机热点强制 PMF 会和 WPA2-PSK 打架。 */
    cfg.sta.pmf_cfg.capable = false;
    cfg.sta.pmf_cfg.required = false;

    snprintf(s_wifi_ssid, sizeof(s_wifi_ssid), "%s", cred->ssid);
    snprintf(s_wifi_ip, sizeof(s_wifi_ip), "%s", "-");
    xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);
    s_connecting = true;

    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &cfg);
    if (err == ESP_OK) {
        err = esp_wifi_connect();
    }
    if (err != ESP_OK) {
        s_connecting = false;
        ESP_LOGW(TAG, "  发起连接失败：%s", esp_err_to_name(err));
        return false;
    }

    EventBits_t bits = xEventGroupWaitBits(s_wifi_events, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                           pdTRUE, pdFALSE,
                                           pdMS_TO_TICKS(TIHU_WIFI_TRY_TIMEOUT_MS));
    s_connecting = false;
    if (bits & WIFI_CONNECTED_BIT) {
        return true;
    }
    ESP_LOGW(TAG, "  这次没连上 \"%s\"（%s）", cred->ssid,
             (bits & WIFI_FAIL_BIT) ? "AP 拒绝/密码不对/关联失败" : "超时没拿到 IP");
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(600));
    return false;
}

/**
 * 试一组凭据（带重试）：reason=2「认证超时」这类多半是热点瞬时状态（手机热点刚开机、
 * 睡眠唤醒、STA 表还没准备好），同一条凭据紧跟着再试 1–2 次往往就过了。
 * 每次仍是独立的 TIHU_WIFI_TRY_TIMEOUT_MS；成功立刻返回。
 */
static bool try_connect(const tihu_wifi_cred_t *cred, int rssi, uint8_t authmode)
{
    for (int attempt = 1; attempt <= TIHU_WIFI_CONNECT_ATTEMPTS; attempt++) {
        if (attempt > 1) {
            ESP_LOGW(TAG, "  重试第 %d/%d 次：ssid=\"%s\"（上一次认证超时/关联失败后重来）",
                     attempt - 1, TIHU_WIFI_CONNECT_ATTEMPTS - 1, cred->ssid);
            vTaskDelay(pdMS_TO_TICKS(800));
        }
        if (try_connect_once(cred, rssi, authmode)) {
            return true;
        }
    }
    return false;
}

/* ------------------------------ 找宿主（UDP 发现 → NVS → config.h） ------------------------------ */

/** 按要求的那一行格式落日志：发现宿主 ip=... port=... 来源=udp|nvs；公网模式另打一条。 */
static void log_host_source(const char *source)
{
    if (s_host_tls) {
        ESP_LOGI(TAG, "公网模式 → wss://%s:%d/tihu/lane（来源=%s）", s_host_ip, s_host_port, source);
        ESP_LOGW(TAG, "公网 TLS：未校验证书（skip_cert_common_name_check），仅测试阶段");
    } else {
        ESP_LOGI(TAG, "发现宿主 ip=%s port=%d 来源=%s", s_host_ip, s_host_port, source);
    }
}

static bool resolve_host(void)
{
    s_host_known = false;
    s_host_public = false;

#if TIHU_FORCE_HOST
    /*
     * -1) 编译期强制宿主：优先于 NVS 的 host_mode=public。
     *     实机联调切「局域网直连本机」时不用进配网页清公网配置，也不碰 NVS 半字节。
     *     完全不发 UDP 广播，也不去连公网入口（下面那些分支都不会执行）。
     *     当前 TIHU_FORCE_HOST=0，这整段不参与编译，只作以后联调开关。
     */
    if (TIHU_HOST[0] != '\0') {
        s_host_tls = false;   /* 强制模式一律走 ws:// 局域网，不继承 NVS 的 TLS 配置 */
        snprintf(s_host_ip, sizeof(s_host_ip), "%s", TIHU_HOST);
        s_host_port = TIHU_PORT;
        snprintf(s_host_token, sizeof(s_host_token), "%s", TIHU_TOKEN);
        s_host_known = true;
        log_host_source("forced");
        ESP_LOGW(TAG, "强制宿主模式：ws://%s:%d（忽略 NVS 公网配置）", TIHU_HOST, TIHU_PORT);
        return true;
    }
    ESP_LOGW(TAG, "TIHU_FORCE_HOST=1 但 TIHU_HOST 为空：退回 UDP 发现");
#endif

    /*
     * 0) 公网模式：配网页里填了「公网地址」+ token 就以它为准，
     *    完全不发 UDP 广播（避免同一个设备既被发现又走公网、宿主上出现两条 lane）。
     *    留空则 host_mode=lan，落回下面的局域网发现。
     *    注意：TIHU_FORCE_HOST=1 时上面那一支已经先返回，不会走到这里。
     */
    tihu_public_cfg_t pub;
    tihu_wifi_public_get(&pub);
    if (pub.enabled) {
        snprintf(s_host_ip, sizeof(s_host_ip), "%s", pub.host);
        s_host_port = pub.port > 0 ? pub.port : (pub.tls ? 443 : 80);
        s_host_tls = pub.tls;
        s_host_public = true;   /* OTA 端口要跟着公网端口走（见 build_uri） */
        snprintf(s_host_token, sizeof(s_host_token), "%s", pub.token[0] != '\0' ? pub.token : TIHU_TOKEN);
        s_host_known = true;
        log_host_source("nvs/public");

        /*
         * 域名场景先把 DNS 结果打出来：解析失败时 WS 只会报「错误 type=0 errno=-1」，
         * 串口里分不清是 DNS、端口还是 TLS 的问题。这里失败也继续（自动重连会再试）。
         */
        struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_STREAM};
        struct addrinfo *res = NULL;
        int rc = getaddrinfo(s_host_ip, NULL, &hints, &res);
        if (rc == 0 && res != NULL) {
            char ipbuf[20] = {0};
            struct sockaddr_in *sin = (struct sockaddr_in *)res->ai_addr;
            inet_ntoa_r(sin->sin_addr, ipbuf, sizeof(ipbuf));
            ESP_LOGI(TAG, "公网 DNS：%s → %s", s_host_ip, ipbuf);
        } else {
            ESP_LOGW(TAG, "公网 DNS 解析失败：%s（rc=%d=%s）", s_host_ip, rc,
                     rc == EAI_AGAIN ? "EAI_AGAIN" : (rc == EAI_NONAME ? "EAI_NONAME" : "see lwip netdb"));
        }
        if (res != NULL) {
            freeaddrinfo(res);
        }
        return true;
    }
    s_host_tls = false;

    /* 1) 主路径：UDP 广播发现（不写死 IP）。 */
    char ip[64] = {0};
    char token[80] = {0};
    int port = 0;
    if (tihu_discover_host(ip, sizeof(ip), &port, token, sizeof(token), 2600)) {
        snprintf(s_host_ip, sizeof(s_host_ip), "%s", ip);
        s_host_port = port > 0 ? port : TIHU_PORT;
        snprintf(s_host_token, sizeof(s_host_token), "%s", token[0] != '\0' ? token : TIHU_TOKEN);
        s_host_known = true;
        tihu_wifi_remember_host(s_host_ip, s_host_port, s_host_token);
        log_host_source("udp");
        return true;
    }

    /* 2) 回退：NVS 里上次发现成功的地址（同一局域网重启宿主时最省事）。 */
    char nvs_ip[64] = {0};
    char nvs_token[80] = {0};
    int nvs_port = 0;
    if (tihu_wifi_last_host(nvs_ip, sizeof(nvs_ip), &nvs_port, nvs_token, sizeof(nvs_token))
        && nvs_ip[0] != '\0') {
        snprintf(s_host_ip, sizeof(s_host_ip), "%s", nvs_ip);
        s_host_port = nvs_port > 0 ? nvs_port : TIHU_PORT;
        snprintf(s_host_token, sizeof(s_host_token), "%s", nvs_token[0] != '\0' ? nvs_token : TIHU_TOKEN);
        s_host_known = true;
        log_host_source("nvs");
        return true;
    }

    /* 3) 兼容旧的写死配置（调试时可用）。 */
    if (TIHU_HOST[0] != '\0') {
        snprintf(s_host_ip, sizeof(s_host_ip), "%s", TIHU_HOST);
        s_host_port = TIHU_PORT;
        snprintf(s_host_token, sizeof(s_host_token), "%s", TIHU_TOKEN);
        s_host_known = true;
        log_host_source("config");
        return true;
    }

    ESP_LOGW(TAG, "找不到宿主：UDP 发现没回包，NVS/config 里也没有地址；10 秒后重试");
    return false;
}

/* ------------------------------ 选网任务 ------------------------------ */

/** 掉线后彻底扔掉旧客户端：换网后宿主 IP 可能变，下一次 start_ws 要按新 URI 建。 */
static void ws_reset(void)
{
    if (s_ws != NULL) {
        esp_websocket_client_stop(s_ws);
        esp_websocket_client_destroy(s_ws);
        s_ws = NULL;
    }
    s_ws_started = false;
    s_connected = false;
}

static void wifi_manager_task(void *arg)
{
    (void)arg;
    static tihu_ap_info_t aps[32];
    tihu_wifi_cred_t cand[TIHU_WIFI_MAX_NETWORKS];
    int rssi[TIHU_WIFI_MAX_NETWORKS];
    bool is_last[TIHU_WIFI_MAX_NETWORKS];
    tihu_wifi_cred_t saved[TIHU_WIFI_MAX_NETWORKS];

    for (;;) {
        s_host_known = false;
        tihu_ui_set_connection(false, "扫描 Wi-Fi");
        ESP_LOGI(TAG, "=== 选网开始：先扫可见 AP ===");
        int ap_count = tihu_wifi_scan(aps, 32);
        int saved_count = tihu_wifi_saved(saved, TIHU_WIFI_MAX_NETWORKS);
        int cand_count = tihu_wifi_candidates(aps, ap_count, cand, TIHU_WIFI_MAX_NETWORKS,
                                              rssi, is_last);
        ESP_LOGI(TAG, "已记住 %d/%d 个网络，其中候选 %d 个（可见 AP %d 个）",
                 saved_count, TIHU_WIFI_MAX_NETWORKS, cand_count, ap_count);

        bool connected = false;
        for (int i = 0; i < cand_count; i++) {
            ESP_LOGI(TAG, "候选 %d/%d：ssid=\"%s\" rssi=%d%s", i + 1, cand_count, cand[i].ssid,
                     rssi[i], is_last[i] ? "（最后成功，优先）" : "");
            if (try_connect(&cand[i], rssi[i], authmode_of(aps, ap_count, cand[i].ssid))) {
                ESP_LOGI(TAG, "已连上 Wi-Fi：ssid=\"%s\" ip=%s", cand[i].ssid, s_wifi_ip);
                tihu_wifi_mark_connected(cand[i].ssid);
                connected = true;
                break;
            }
        }

        if (!connected) {
            ESP_LOGW(TAG, "没有可用网络（候选 %d 个全部失败）→ 开配网热点", cand_count);
            ESP_LOGW(TAG, "手机连 \"%s\"，密码 \"%s\"，浏览器打开 http://192.168.4.1/ 选 Wi-Fi",
                     tihu_provision_ap_ssid(), TIHU_SETUP_AP_PASSWORD);
            tihu_ui_set_connection(false, "配网热点");
            tihu_ui_show_alert("没有可用 Wi-Fi：手机连 Pelican-Setup 热点后打开 192.168.4.1 配网");
            tihu_provision_start();
            /*
             * 配网待机：**不再原地躺平**。每 TIHU_PROVISION_RETRY_MS（25 s）重扫一次，
             * 把 NVS 里记住的网络再试一遍 —— 手机热点（Mi9）重启后常见的 reason=2
             * 认证超时往往过几十秒就自己好了，光等用户来配网等于把设备锁死。
             * 配网页保存新网络仍会 esp_restart() 立即重连，不受这个循环影响。
             */
            for (int round = 1;; round++) {
                vTaskDelay(pdMS_TO_TICKS(TIHU_PROVISION_RETRY_MS));
                int ac = tihu_wifi_scan(aps, 32);
                int cc = tihu_wifi_candidates(aps, ac, cand, TIHU_WIFI_MAX_NETWORKS,
                                              rssi, is_last);
                ESP_LOGW(TAG, "配网待机重试第 %d 次：已记住 %d 个网络，候选 %d 个（可见 AP %d 个）",
                         round, saved_count, cc, ac);
                bool got = false;
                for (int i = 0; i < cc; i++) {
                    ESP_LOGI(TAG, "  配网待机尝试：ssid=\"%s\" rssi=%d%s", cand[i].ssid, rssi[i],
                             is_last[i] ? "（最后成功，优先）" : "");
                    if (try_connect(&cand[i], rssi[i], authmode_of(aps, ac, cand[i].ssid))) {
                        got = true;
                        break;
                    }
                }
                if (!got) {
                    continue;   /* 下一轮再试，配网页一直可用 */
                }
                ESP_LOGW(TAG, "连上 ssid=\"%s\"，关闭配网热点（ip=%s）", s_wifi_ssid, s_wifi_ip);
                tihu_wifi_mark_connected(s_wifi_ssid);
                tihu_provision_stop();
                tihu_ui_set_connection(false, "找宿主");
                vTaskDelay(pdMS_TO_TICKS(800));
                connected = true;
                break;
            }
        }

        /* 连上了：清掉历史通知，再找宿主。 */
        ulTaskNotifyTake(pdTRUE, 0);
        if (resolve_host()) {
            build_uri();
            start_ws();
        }

        /* 等掉线；顺带每 10 秒补一次发现（宿主晚开机也能自己接上）。 */
        for (;;) {
            BaseType_t notified = xTaskNotifyWait(0, 0, NULL, pdMS_TO_TICKS(10000));
            if (notified == pdTRUE) {
                break;
            }
            if (!s_host_known) {
                if (resolve_host()) {
                    build_uri();
                    start_ws();
                }
            } else if (!s_ws_started) {
                start_ws();
            }
        }

        ESP_LOGW(TAG, "Wi-Fi 掉线 → 关掉旧 WebSocket，重新选网");
        ws_reset();
        esp_wifi_disconnect();
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

/* ------------------------------ 心跳 ------------------------------ */

static void heartbeat_cb(void *arg)
{
    (void)arg;
    if (!s_connected) {
        /* 拿到 IP 后如果第一次 start 失败，靠心跳再试，不要求用户重启。 */
        if (!s_ws_started && s_host_known) {
            start_ws();
        }
        return;
    }
    int64_t now = tihu_protocol_now_ms();
    if (now - s_last_rx_ms > TIHU_RX_TIMEOUT_MS) {
        ESP_LOGW(TAG, "%d ms 没有下行，主动断线重连", TIHU_RX_TIMEOUT_MS);
        esp_websocket_client_close(s_ws, pdMS_TO_TICKS(1000));
        s_ws_started = false;
        return;
    }
    send_json(tihu_build_ping());
}

/* ------------------------------ 启动 ------------------------------ */

static void build_uri(void)
{
    const char *scheme = s_host_tls ? "wss" : "ws";
    /*
     * OTA 端口跟随宿主模式：
     *   - 公网模式：用公网端口（7080）。VPS:7080 的 ssh -R 反代到本机 relay 3099，
     *     relay 同时服务 /tihu/ota 与 /tihu/lane —— 公网上没有 3099 这个口，绝不能去连它。
     *   - 局域网直连/强制 host：用本机 relay 的 TIHU_OTA_PORT(3099)。
     */
    int ota_port = s_host_public ? s_host_port : TIHU_OTA_PORT;
    tihu_ota_set_host(s_host_ip, ota_port, s_host_tls);
    if (s_host_token[0] != '\0') {
        snprintf(s_uri, sizeof(s_uri), "%s://%s:%d/tihu/lane?token=%s",
                 scheme, s_host_ip, s_host_port, s_host_token);
    } else {
        snprintf(s_uri, sizeof(s_uri), "%s://%s:%d/tihu/lane", scheme, s_host_ip, s_host_port);
    }
}

/**
 * 一次性删掉用户点名禁用的网络（TIHU_WIFI_BANNED_SSID）。
 *
 * 只删这一条：其余 SSID/密码原样保留，NVS 不擦、不重建。
 * 删完把剩下的清单打出来，串口里能直接核对「谁还在、谁没了」。
 */
static void tihu_wifi_purge_banned(void)
{
    if (!tihu_wifi_saved_find(TIHU_WIFI_BANNED_SSID, NULL)) {
        ESP_LOGI(TAG, "NVS 里没有 \"%s\"，无需删除", TIHU_WIFI_BANNED_SSID);
        return;
    }
    bool ok = tihu_wifi_forget(TIHU_WIFI_BANNED_SSID);
    tihu_wifi_cred_t left[TIHU_WIFI_MAX_NETWORKS];
    int left_n = tihu_wifi_saved(left, TIHU_WIFI_MAX_NETWORKS);
    ESP_LOGW(TAG, "已按用户要求删除网络 %s，剩余 %d 个（%s）", TIHU_WIFI_BANNED_SSID, left_n,
             ok ? "NVS 已提交" : "删除返回 false，请查 NVS");
    for (int i = 0; i < left_n; i++) {
        ESP_LOGW(TAG, "  保留 %d/%d：ssid=\"%s\" 密码%s", i + 1, left_n, left[i].ssid,
                 left[i].password[0] != '\0' ? "已记" : "空（开放）");
    }
}

void tihu_net_start(void)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_client_id, sizeof(s_client_id), "esp32-box3-%02x%02x%02x",
             mac[3], mac[4], mac[5]);

    tihu_wifi_store_init();
    /* 用户要求：板子不许再连校园网 —— 开机删一次（其它网络一字不动）。 */
    tihu_wifi_purge_banned();
    /* config.h 里的 SSID 只当「种子」：NVS 里没有才补写一次，绝不覆盖配网页加的网络。
     * 种子为空（当前就是空）时这一步整段跳过；即便有人把种子写成被禁用的 SSID 也不写。 */
    if (TIHU_WIFI_SSID[0] != '\0' && strcmp(TIHU_WIFI_SSID, TIHU_WIFI_BANNED_SSID) == 0) {
        ESP_LOGW(TAG, "config.h 种子 SSID 是禁用的 \"%s\"，不写入 NVS", TIHU_WIFI_BANNED_SSID);
    } else if (TIHU_WIFI_SSID[0] != '\0' && !tihu_wifi_saved_find(TIHU_WIFI_SSID, NULL)) {
        tihu_wifi_save(TIHU_WIFI_SSID, TIHU_WIFI_PASSWORD);
        ESP_LOGI(TAG, "config.h 种子 SSID \"%s\" 补进 NVS（之后以 NVS 为准）", TIHU_WIFI_SSID);
    }
    /* 公网入口同理：只补一次，落过 host_mode 之后一律以 NVS（配网页）为准。
     * TIHU_FORCE_HOST=1 时连补写都不做：不往 NVS 里塞 host_mode=public，
     * 已有的 3 条 Wi-Fi 记忆和公网配置原样保留。 */
    if (TIHU_PUBLIC_HOST[0] != '\0' && !TIHU_FORCE_HOST && !tihu_wifi_host_mode_set()) {
        bool pub_tls = TIHU_PUBLIC_TLS != 0;
        int pub_port = TIHU_PUBLIC_PORT > 0 ? TIHU_PUBLIC_PORT : (pub_tls ? 443 : 80);
        if (tihu_wifi_public_save(TIHU_PUBLIC_HOST, pub_port, pub_tls, TIHU_PUBLIC_TOKEN)) {
            ESP_LOGI(TAG, "config.h 种子公网入口 %s://%s:%d 补进 NVS（之后以配网页为准）",
                     pub_tls ? "wss" : "ws", TIHU_PUBLIC_HOST, pub_port);
        }
    }

    s_wifi_events = xEventGroupCreate();

    esp_timer_create_args_t beat_args = {
        .callback = heartbeat_cb,
        .name = "tihu_ping",
    };
    esp_timer_create(&beat_args, &s_heartbeat_timer);

    esp_timer_create_args_t listen_args = {
        .callback = listen_timeout_cb,
        .name = "tihu_listen",
    };
    esp_timer_create(&listen_args, &s_listen_timer);

    esp_timer_create_args_t idle_args = {
        .callback = audio_idle_cb,
        .name = "tihu_audio_idle",
    };
    esp_timer_create(&idle_args, &s_audio_idle_timer);

    ESP_ERROR_CHECK(esp_netif_init());
    esp_err_t loop_err = esp_event_loop_create_default();
    if (loop_err != ESP_OK && loop_err != ESP_ERR_INVALID_STATE) {
        ESP_ERROR_CHECK(loop_err);
    }
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_LOGI(TAG, "esp_wifi_init 前：内部堆 %u B（最大块 %u B），PSRAM %u B",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    esp_err_t wifi_err = esp_wifi_init(&init_cfg);
    if (wifi_err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_init 失败: %s（0x%x）——内部 RAM 不够，查 CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP",
                 esp_err_to_name(wifi_err), wifi_err);
        return;
    }
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                               wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                               wifi_event_handler, NULL));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    /* 国家码 CN：不加这句时驱动按 "01"（世界域）只扫 1–11 信道，而国内路由器 /
     * Windows 移动热点常落在 12/13——设备就「看得见别的 AP，唯独看不到它」。 */
    esp_err_t country_err = esp_wifi_set_country_code("CN", true);
    if (country_err != ESP_OK) {
        ESP_LOGW(TAG, "设置国家码 CN 失败：%s（12/13 信道可能扫不到）", esp_err_to_name(country_err));
    }
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);

    if (xTaskCreate(wifi_manager_task, "wifi_manager", 6144, NULL, 4, &s_wifi_task) != pdPASS) {
        ESP_LOGE(TAG, "选网任务创建失败：设备将无法连 Wi-Fi");
        s_wifi_task = NULL;
    }

    esp_timer_start_periodic(s_heartbeat_timer, (uint64_t)TIHU_PING_INTERVAL_MS * 1000);

#if defined(CONFIG_ESP_WIFI_11KV_SUPPORT)
    ESP_LOGW(TAG, "编译期开了 802.11k/v（CONFIG_ESP_WIFI_11KV_SUPPORT），漫游辅助可能干扰首连");
#endif

    tihu_public_cfg_t pub;
    tihu_wifi_public_get(&pub);
#if TIHU_FORCE_HOST
    if (TIHU_HOST[0] != '\0') {
        ESP_LOGW(TAG, "强制宿主模式：ws://%s:%d（忽略 NVS 公网配置，不发 UDP 发现；NVS host_mode=%s 原样保留）",
                 TIHU_HOST, TIHU_PORT, pub.enabled ? "public" : "lan");
        ESP_LOGI(TAG, "启动完成：令牌=%s，种子 SSID=%s，宿主模式=强制 host（ws://%s:%d），发现端口=%d",
                 TIHU_TOKEN[0] != '\0' ? "已配置" : "空",
                 TIHU_WIFI_SSID[0] != '\0' ? TIHU_WIFI_SSID : "（用 NVS）",
                 TIHU_HOST, TIHU_PORT, TIHU_DISCOVER_PORT);
        return;
    }
    ESP_LOGW(TAG, "TIHU_FORCE_HOST=1 但 TIHU_HOST 为空：按局域网发现模式继续");
#endif
    ESP_LOGI(TAG, "启动完成：令牌=%s，种子 SSID=%s，宿主模式=%s，发现端口=%d",
             TIHU_TOKEN[0] != '\0' ? "已配置" : "空",
             TIHU_WIFI_SSID[0] != '\0' ? TIHU_WIFI_SSID : "（用 NVS）",
             pub.enabled ? "公网（配网页已填）" : "局域网（先 UDP 发现）",
             TIHU_DISCOVER_PORT);
    if (pub.enabled) {
        ESP_LOGI(TAG, "公网入口：%s://%s:%d（token %s）",
                 pub.tls ? "wss" : "ws", pub.host, pub.port, pub.token[0] != '\0' ? "已填" : "空");
    }
}
