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
#include "tihu_protocol.h"
#include "ui.h"

static const char *TAG = "tihu_net";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1
#define WS_RX_MAX          32768

static EventGroupHandle_t s_wifi_events;
static esp_websocket_client_handle_t s_ws;
static bool s_ws_started;
static bool s_connected;
static char s_uri[320];
static char s_client_id[64];
static int64_t s_last_rx_ms;
static esp_timer_handle_t s_heartbeat_timer;
static esp_timer_handle_t s_wifi_retry_timer;
static esp_timer_handle_t s_listen_timer;
static esp_timer_handle_t s_audio_idle_timer;

/* WS 分片重组：正常一条 screen.frame/tts.audio 都小于 32KB。 */
static char s_rx_buf[WS_RX_MAX];
static size_t s_rx_len;

static void start_ws(void);
static void handle_text(const char *data, size_t len);

/* ------------------------------ 发送 ------------------------------ */

static bool send_json(char *json)
{
    if (json == NULL) {
        return false;
    }
    if (!s_connected || s_ws == NULL) {
        tihu_free_message(json);
        return false;
    }
    int want = (int)strlen(json);
    int sent = esp_websocket_client_send_text(s_ws, json, want,
                                              pdMS_TO_TICKS(10000));
    bool ok = sent == want;
    if (!ok) {
        ESP_LOGW(TAG, "WS 发送不完整 (%d/%d)，下一次心跳会触发重连", sent, want);
    }
    tihu_free_message(json);
    return ok;
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

void tihu_net_send_tap(int x, int y, const char *hit,
                       const char *action_id, const char *task_id)
{
    send_json(tihu_build_screen_tap(x, y, hit, action_id, task_id));
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
    tihu_screen_frame_t frame = {0};
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
        tihu_audio_mic_start();
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
    switch (msg->type) {
    case TIHU_DOWN_SCREEN_FRAME:
        handle_screen(&msg->u.screen);
        break;
    case TIHU_DOWN_TTS_AUDIO:
        if (msg->u.tts.pcm != NULL && msg->u.tts.pcm_len > 0) {
            if (msg->u.tts.seq == 0) {
                tihu_audio_reset_stats();
            }
            /* 每块长度必须上串口：奇数块/超长块是「滋滋」的第一手证据。 */
            ESP_LOGI(TAG, "tts.audio seq=%d 块长=%u 字节（%u 采样）index=%d sample=%d final=%d",
                     msg->u.tts.seq, (unsigned)msg->u.tts.pcm_len,
                     (unsigned)(msg->u.tts.pcm_len / 2), msg->u.tts.index,
                     msg->u.tts.sample ? 1 : 0, msg->u.tts.final ? 1 : 0);
            tihu_audio_push_pcm(msg->u.tts.pcm, msg->u.tts.pcm_len);
            if (msg->u.tts.seq == 0) {
                tihu_net_send_playback_state("playing", NULL,
                                             msg->u.tts.index + 1, -1, 0, -1);
            }
            if (msg->u.tts.final) {
                uint32_t chunks = 0, odd = 0, underruns = 0;
                tihu_audio_stats(&chunks, &odd, &underruns);
                ESP_LOGI(TAG, "本次播放统计：块=%u 奇数块=%u 欠载=%u（欠载>0 就会听到嗡/滋滋）",
                         (unsigned)chunks, (unsigned)odd, (unsigned)underruns);
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

static void handle_text(const char *data, size_t len)
{
    tihu_downstream_t msg;
    if (!tihu_parse_downstream(data, len, &msg)) {
        ESP_LOGW(TAG, "坏帧或非 v0 信封，已忽略 (%u 字节)", (unsigned)len);
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
 * （验证真实 TTS 链路 + 当前音色）。两段之间留 1.5 s，避免叠在一起听不清。
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
    case WEBSOCKET_EVENT_CONNECTED:
        s_connected = true;
        s_last_rx_ms = tihu_protocol_now_ms();
        s_rx_len = 0;
        ESP_LOGI(TAG, "WebSocket 已连接：%s", s_uri);
        tihu_ui_set_connection(true, "已连接");
        send_json(tihu_build_hello(s_client_id, TIHU_DEVICE_NAME));
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
        if (data->op_code == 0x9) {
            break;  /* 底层 ping 由 esp_websocket_client 自己回 pong */
        }
        if (data->op_code != 0x1) {
            break;
        }
        /* 分片重组：payload_offset==0 表示新的一条消息。 */
        if (data->payload_offset == 0) {
            s_rx_len = 0;
        }
        if (s_rx_len + (size_t)data->data_len > sizeof(s_rx_buf)) {
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
        ESP_LOGW(TAG, "WebSocket 错误，底层会自动重连");
        tihu_ui_set_connection(false, "重连中");
        break;

    default:
        break;
    }
}

static void start_ws(void)
{
    if (s_ws == NULL) {
        esp_websocket_client_config_t cfg = {
            .uri = s_uri,
            .reconnect_timeout_ms = 3000,
            .network_timeout_ms = 10000,
            .buffer_size = 16384,
            .disable_auto_reconnect = false,
            /*
             * 默认 4 KB 栈太紧：这个任务里要跑我们自己注册的事件回调
             * （解析 JSON → 改 LVGL → 回一条 ack），实测 4 KB 会在首帧后踩栈。
             */
            .task_stack = 8192,
        };
        s_ws = esp_websocket_client_init(&cfg);
        if (s_ws == NULL) {
            ESP_LOGE(TAG, "esp_websocket_client_init 失败");
            return;
        }
        esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);
    }
    if (!s_ws_started) {
        esp_err_t err = esp_websocket_client_start(s_ws);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "WebSocket 启动失败: %s", esp_err_to_name(err));
            return;
        }
        s_ws_started = true;
        ESP_LOGI(TAG, "WebSocket 启动：%s", s_uri);
    }
}

/* ------------------------------ Wi-Fi ------------------------------ */

/*
 * 连不上时只看这三类日志就能定位：
 *   1. WIFI_EVENT_STA_DISCONNECTED 的 reason 码 + 中文解释；
 *   2. 15 秒还没拿到 IP 就重扫一次，把目标 SSID 命中没命中、信道、加密方式、RSSI 打出来；
 *   3. 从不断线：失败按 3 s / 6 s / 12 s 退避重试，之后每 15 s 重扫重连一次。
 */

static bool s_wifi_got_ip;
static int s_wifi_retry_count;
static esp_timer_handle_t s_wifi_watchdog;
static TaskHandle_t s_wifi_probe_task;

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

static const char *wifi_auth_name(wifi_auth_mode_t auth)
{
    switch (auth) {
    case WIFI_AUTH_OPEN: return "OPEN";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA-PSK";
    case WIFI_AUTH_WPA2_PSK: return "WPA2-PSK";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2-PSK";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-ENTERPRISE";
    case WIFI_AUTH_WPA3_PSK: return "WPA3-SAE";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3-SAE 混合";
    case WIFI_AUTH_WAPI_PSK: return "WAPI-PSK";
    default: return "未知";
    }
}

/** 重扫一次并把目标 SSID 的可见性/信道/加密/RSSI 打进日志。只探测，不改连接参数。 */
static void wifi_scan_and_report(void)
{
    wifi_scan_config_t scan_cfg = {
        .ssid = (uint8_t *)TIHU_WIFI_SSID,
        .bssid = NULL,
        .channel = 0,
        .show_hidden = true,
    };
    ESP_LOGI(TAG, "Wi-Fi 重扫：找 SSID=\"%s\"…", TIHU_WIFI_SSID);
    esp_err_t err = esp_wifi_scan_start(&scan_cfg, true);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "扫描启动失败: %s", esp_err_to_name(err));
        return;
    }

    uint16_t ap_num = 0;
    esp_wifi_scan_get_ap_num(&ap_num);
    if (ap_num > 8) {
        ap_num = 8;
    }
    wifi_ap_record_t *aps = calloc(ap_num > 0 ? ap_num : 1, sizeof(*aps));
    if (aps == NULL) {
        ESP_LOGW(TAG, "扫描结果分配失败");
        return;
    }
    uint16_t got = ap_num;
    if (got > 0) {
        esp_wifi_scan_get_ap_records(&got, aps);
    }
    bool found = false;
    for (uint16_t i = 0; i < got; i++) {
        ESP_LOGI(TAG, "  AP[%u] ssid=\"%s\" ch=%d rssi=%d auth=%s",
                 (unsigned)i, (char *)aps[i].ssid, aps[i].primary,
                 aps[i].rssi, wifi_auth_name(aps[i].authmode));
        if (strcmp((const char *)aps[i].ssid, TIHU_WIFI_SSID) == 0) {
            found = true;
            ESP_LOGI(TAG, "命中目标 SSID：ch=%d rssi=%d auth=%s bssid=%02x:%02x:%02x:%02x:%02x:%02x",
                     aps[i].primary, aps[i].rssi, wifi_auth_name(aps[i].authmode),
                     aps[i].bssid[0], aps[i].bssid[1], aps[i].bssid[2],
                     aps[i].bssid[3], aps[i].bssid[4], aps[i].bssid[5]);
        }
    }
    free(aps);
    if (!found) {
        ESP_LOGW(TAG, "这次扫描没看到 \"%s\"：先确认手机热点还开着、是 2.4G、SSID 没改",
                 TIHU_WIFI_SSID);
    }
}

/** 扫描要阻塞一两秒，不能放 esp_timer 回调里，所以单开一个任务。 */
static void wifi_probe_task(void *arg)
{
    (void)arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        if (s_wifi_got_ip) {
            continue;
        }
        wifi_scan_and_report();
        ESP_LOGI(TAG, "重扫完毕，再连一次 \"%s\"", TIHU_WIFI_SSID);
        s_wifi_retry_count = 0;
        esp_wifi_connect();
        if (s_wifi_watchdog != NULL) {
            esp_timer_stop(s_wifi_watchdog);
            esp_timer_start_once(s_wifi_watchdog, 15 * 1000 * 1000);
        }
    }
}

/** 15 秒还没 IP：叫探测任务重扫。回调里只通知，不做阻塞事。 */
static void wifi_watchdog_cb(void *arg)
{
    (void)arg;
    if (s_wifi_got_ip || s_wifi_probe_task == NULL) {
        return;
    }
    ESP_LOGW(TAG, "连了 15 秒还没拿到 IP，触发一次重扫");
    xTaskNotifyGive(s_wifi_probe_task);
}

static void wifi_retry_cb(void *arg)
{
    (void)arg;
    if (s_wifi_got_ip) {
        return;
    }
    s_wifi_retry_count++;
    ESP_LOGI(TAG, "重试 Wi-Fi 连接（第 %d 次）…", s_wifi_retry_count);
    esp_wifi_connect();
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)arg;
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
        if (s_wifi_watchdog != NULL) {
            esp_timer_stop(s_wifi_watchdog);
            esp_timer_start_once(s_wifi_watchdog, 15 * 1000 * 1000);
        }
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *evt = (wifi_event_sta_disconnected_t *)event_data;
        uint8_t reason = evt != NULL ? evt->reason : 0;
        s_connected = false;
        s_wifi_got_ip = false;
        tihu_ui_set_connection(false, "Wi-Fi 重连");
        ESP_LOGW(TAG, "Wi-Fi 断开 reason=%u：%s", (unsigned)reason, wifi_reason_cn(reason));
        if (reason == WIFI_REASON_NO_AP_FOUND ||
            reason == WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY ||
            reason == WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD ||
            reason == WIFI_REASON_802_1X_AUTH_FAILED) {
            /* 这几类靠重试救不回来，直接重扫看现场。 */
            if (s_wifi_probe_task != NULL) {
                xTaskNotifyGive(s_wifi_probe_task);
            }
            return;
        }
        if (s_wifi_retry_timer != NULL) {
            esp_timer_stop(s_wifi_retry_timer);
            esp_timer_start_once(s_wifi_retry_timer, (uint64_t)TIHU_WIFI_RETRY_MS * 1000);
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        s_wifi_got_ip = true;
        s_wifi_retry_count = 0;
        if (s_wifi_watchdog != NULL) {
            esp_timer_stop(s_wifi_watchdog);
        }
        ESP_LOGI(TAG, "Wi-Fi 已获取 IP：" IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
        tihu_ui_set_connection(false, "连宿主");
        start_ws();
    }
}

/* ------------------------------ 心跳 ------------------------------ */

static void heartbeat_cb(void *arg)
{
    (void)arg;
    if (!s_connected) {
        /* 拿到 IP 后如果第一次 start 失败，靠心跳再试，不要求用户重启。 */
        if (!s_ws_started) {
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
    if (TIHU_TOKEN[0] != '\0') {
        snprintf(s_uri, sizeof(s_uri), "ws://%s:%d/tihu/lane?token=%s",
                 TIHU_HOST, TIHU_PORT, TIHU_TOKEN);
    } else {
        snprintf(s_uri, sizeof(s_uri), "ws://%s:%d/tihu/lane", TIHU_HOST, TIHU_PORT);
    }
}

void tihu_net_start(void)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_client_id, sizeof(s_client_id), "esp32-box3-%02x%02x%02x",
             mac[3], mac[4], mac[5]);
    build_uri();

    s_wifi_events = xEventGroupCreate();

    esp_timer_create_args_t retry_args = {
        .callback = wifi_retry_cb,
        .name = "wifi_retry",
    };
    esp_timer_create(&retry_args, &s_wifi_retry_timer);

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

    wifi_config_t wifi_cfg = {0};
    snprintf((char *)wifi_cfg.sta.ssid, sizeof(wifi_cfg.sta.ssid), "%s", TIHU_WIFI_SSID);
    snprintf((char *)wifi_cfg.sta.password, sizeof(wifi_cfg.sta.password), "%s", TIHU_WIFI_PASSWORD);
    /* 明确按 WPA2-PSK 连：不试 WPA3/SAE，也不接 WPA2/WPA3 混合的 SAE 分支。 */
    wifi_cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_cfg.sta.threshold.rssi = -127;
    wifi_cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    wifi_cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    if (TIHU_WIFI_PASSWORD[0] == '\0') {
        wifi_cfg.sta.threshold.authmode = WIFI_AUTH_OPEN;
    }
    /* PMF（802.11w）可选、不强制：有些手机热点强制 PMF 会和 WPA2-PSK 打架。 */
    wifi_cfg.sta.pmf_cfg.capable = false;
    wifi_cfg.sta.pmf_cfg.required = false;
#if defined(CONFIG_ESP_WIFI_11KV_SUPPORT)
    ESP_LOGW(TAG, "编译期开了 802.11k/v（CONFIG_ESP_WIFI_11KV_SUPPORT），漫游辅助可能干扰首连");
#else
    ESP_LOGI(TAG, "802.11k/v 漫游辅助：编译期已关闭（ESP_WIFI_11KV_SUPPORT=n）");
#endif

    /* 15 秒看门狗 + 探测任务（扫描会阻塞，不能塞进 esp_timer 回调）。 */
    esp_timer_create_args_t watch_args = {
        .callback = wifi_watchdog_cb,
        .name = "wifi_watch",
    };
    esp_timer_create(&watch_args, &s_wifi_watchdog);
    if (xTaskCreate(wifi_probe_task, "wifi_probe", 4096, NULL, 4,
                    &s_wifi_probe_task) != pdPASS) {
        ESP_LOGW(TAG, "Wi-Fi 探测任务创建失败：15 秒重扫不可用");
        s_wifi_probe_task = NULL;
    }

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);

    esp_timer_start_periodic(s_heartbeat_timer, (uint64_t)TIHU_PING_INTERVAL_MS * 1000);

    ESP_LOGI(TAG, "启动完成：SSID=%s host=%s:%d token=%s（authmode=%s，pmf=可选/不强制）",
             TIHU_WIFI_SSID, TIHU_HOST, TIHU_PORT,
             TIHU_TOKEN[0] != '\0' ? "已配置" : "空",
             TIHU_WIFI_PASSWORD[0] != '\0' ? "WPA2-PSK" : "OPEN");
}
