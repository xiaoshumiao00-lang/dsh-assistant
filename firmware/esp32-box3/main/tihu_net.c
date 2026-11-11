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
            tihu_audio_push_pcm(msg->u.tts.pcm, msg->u.tts.pcm_len);
            if (msg->u.tts.seq == 0) {
                tihu_net_send_playback_state("playing", NULL,
                                             msg->u.tts.index + 1, -1, 0, -1);
            }
            if (msg->u.tts.final) {
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

static void wifi_retry_cb(void *arg)
{
    (void)arg;
    ESP_LOGI(TAG, "重试 Wi-Fi 连接…");
    esp_wifi_connect();
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)arg;
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connected = false;
        tihu_ui_set_connection(false, "Wi-Fi 重连");
        if (s_wifi_retry_timer != NULL) {
            esp_timer_stop(s_wifi_retry_timer);
            esp_timer_start_once(s_wifi_retry_timer, (uint64_t)TIHU_WIFI_RETRY_MS * 1000);
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
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
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                               wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                               wifi_event_handler, NULL));

    wifi_config_t wifi_cfg = {0};
    snprintf((char *)wifi_cfg.sta.ssid, sizeof(wifi_cfg.sta.ssid), "%s", TIHU_WIFI_SSID);
    snprintf((char *)wifi_cfg.sta.password, sizeof(wifi_cfg.sta.password), "%s", TIHU_WIFI_PASSWORD);
    wifi_cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    if (TIHU_WIFI_PASSWORD[0] == '\0') {
        wifi_cfg.sta.threshold.authmode = WIFI_AUTH_OPEN;
    }
    wifi_cfg.sta.pmf_cfg.capable = true;
    wifi_cfg.sta.pmf_cfg.required = false;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);

    esp_timer_start_periodic(s_heartbeat_timer, (uint64_t)TIHU_PING_INTERVAL_MS * 1000);
    ESP_LOGI(TAG, "启动完成：SSID=%s host=%s:%d token=%s",
             TIHU_WIFI_SSID, TIHU_HOST, TIHU_PORT,
             TIHU_TOKEN[0] != '\0' ? "已配置" : "空");
}
