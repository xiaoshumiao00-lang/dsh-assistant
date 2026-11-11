/**
 * 鹈鹕设备固件配置（ESP32-S3-BOX-3B）。
 *
 * 这个文件就是「上机前唯一要改的地方」：Wi-Fi、宿主地址、令牌。
 * 令牌就是本机 pocket 的局域网访问 PIN（打开 /tihu 时 URL 里的 ?token=...）。
 *
 * 注意：127.0.0.1 在板子上指向板子自己，必须填电脑在局域网里的 IPv4 地址。
 */
#pragma once

/* ---------- 必填 ---------- */

/** 2.4 GHz Wi-Fi 名称（ESP32-S3 不支持 5 GHz）。 */
#define TIHU_WIFI_SSID      "YOUR_WIFI_SSID"

/** Wi-Fi 密码；开放网络留空字符串。 */
#define TIHU_WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

/** 电脑（DSH 宿主）在局域网里的 IPv4，例如 "192.168.1.23"。 */
#define TIHU_HOST           "192.168.1.23"

/** pocket 代理端口，默认 3081。 */
#define TIHU_PORT           3081

/** pocket 的局域网 PIN；不需要鉴权时留空字符串。 */
#define TIHU_TOKEN          "YOUR_LAN_PIN"

/* ---------- 设备身份 ---------- */

/** 屏上/宿主日志里显示的名字。 */
#define TIHU_DEVICE_NAME    "鹈鹕 BOX-3B"

/** 固件版本，只进 hello 日志。 */
#define TIHU_FIRMWARE_VERSION "0.1.0"

/* ---------- 可选：音频 ---------- */

/** 麦克风增益（dB）。ES7210 在 BOX-3 上 30–42 dB 比较合适。 */
#define TIHU_MIC_GAIN_DB    36.0f

/** 扬声器音量 0–100。 */
#define TIHU_SPEAKER_VOLUME 70

/** 一次按键录音最长秒数（超过后继续按住也不再录）。 */
#define TIHU_MIC_MAX_SECONDS 10

/* ---------- 可选：网络时序 ---------- */

/** 应用层 ping 间隔（毫秒）。 */
#define TIHU_PING_INTERVAL_MS 15000

/** 这么久没收到任何下行就主动断开重连（毫秒）。 */
#define TIHU_RX_TIMEOUT_MS    60000

/** Wi-Fi 断开后重连间隔（毫秒）。 */
#define TIHU_WIFI_RETRY_MS    3000
