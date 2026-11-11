/**
 * 鹈鹕设备固件配置（ESP32-S3-BOX-3B）。
 *
 * 现在只有**令牌**是编译期必填的；Wi-Fi 与宿主地址都可以留空：
 *   - Wi-Fi 留空 → 只用 NVS 里记住的网络（换地方在配网页里加，不用重刷固件）；
 *   - 宿主留空 → 开机先 UDP 广播发现，发现失败再退回 NVS 里上次成功的地址。
 * 真需要调参时才动「强制 host」那两行。
 */
#pragma once

/* ---------- 必填 ---------- */

/** pocket 的局域网 PIN 兜底值：留空 = 只用 UDP 发现带回的令牌 / NVS 上次成功的令牌。 */
#define TIHU_TOKEN          ""

/* ---------- Wi-Fi：可留空（留空 = 完全用 NVS 记忆 + 配网热点） ---------- */

/**
 * 编译期种子 SSID：留空字符串就完全不写死。
 * 非空时只在「NVS 里还没有这条」时补写一次，之后一律以 NVS 为准——
 * 所以换地方以后即使这里还留着老 SSID，也不会盖掉配网页新加的网络。
 */
#define TIHU_WIFI_SSID      "HBEU-Student"

/** 上面那条种子 SSID 的密码；开放网络留空字符串。 */
#define TIHU_WIFI_PASSWORD  ""

/* ---------- 宿主地址：可留空（留空 = UDP 发现 → NVS 上次成功地址） ---------- */

/** 写死的宿主 IPv4，例如 "192.168.1.23"。留空字符串 = 全部靠发现/NVS。 */
#define TIHU_HOST           ""

/** pocket 代理端口，默认 3081。 */
#define TIHU_PORT           3081

/**
 * 强制 host 开关（调试用）：1 = 完全不发 UDP 发现，直接用上面的 TIHU_HOST。
 * 必须配合非空的 TIHU_HOST；两个都空时这个开关无效（会打一条警告）。
 */
#define TIHU_FORCE_HOST     0

/* ---------- 公网入口：可留空（留空 = 走局域网 UDP 发现） ---------- */

/**
 * 编译期「种子」公网地址：只在 NVS 里还没落过 host_mode 时补写一次，之后以 NVS/配网页为准。
 * 日常用配网页填（192.168.4.1 →「公网地址（可选）」），这里只在首刷/批量烧录用。
 *
 * 端口为什么是 80 而不是 7080：学校 HBEU-Student 对未认证终端只放行 80/443，
 * 7080 这种非 Web 端口 SYN 直接被丢（真机体检：49.234.20.84:80 通、:7080 超时）。
 * 服务器上 nginx 的 `location /` 已经 proxy_pass 到 127.0.0.1:7080（= 现有 ssh -R 隧道），
 * 所以走 80 和走 7080 落到的是同一个 lane，只是绕过了校园网的端口封锁。
 */
#define TIHU_PUBLIC_HOST    "49.234.20.84"
#define TIHU_PUBLIC_PORT    7080
#define TIHU_PUBLIC_TLS     0
#define TIHU_PUBLIC_TOKEN   "96528673"

/* ---------- 配网热点 ---------- */

/** 热点名固定前缀，后面自动接 MAC 后 4 位：Pelican-Setup-<XXXX>。 */
#define TIHU_SETUP_AP_PREFIX "Pelican-Setup-"

/** 配网热点密码（≥8 位；改这里就换密码）。留空 = 开放热点（不推荐）。 */
#define TIHU_SETUP_AP_PASSWORD "pelican123"

/* ---------- 设备身份 ---------- */

/** 屏上/宿主日志里显示的名字。 */
#define TIHU_DEVICE_NAME    "鹈鹕 BOX-3B"

/** 固件版本，只进 hello 日志。 */
#define TIHU_FIRMWARE_VERSION "0.2.0"

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

/** 一个候选网络最多等多久拿到 IP（毫秒）。密码错/根本不在时 12 秒足够下结论。 */
#define TIHU_WIFI_TRY_TIMEOUT_MS 12000
