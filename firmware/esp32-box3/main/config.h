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
#define TIHU_TOKEN          "96528673"

/* ---------- Wi-Fi：可留空（留空 = 完全用 NVS 记忆 + 配网热点） ---------- */

/**
 * 编译期种子 SSID：留空字符串就完全不写死。
 * 2026-11-12 用户明确要求「板子不许再连 HBEU-Student」，所以这里留空，
 * 并把那条校园网从 NVS 里删掉（见 tihu_net.c 的 tihu_wifi_purge_banned()）。
 */
#define TIHU_WIFI_SSID      ""

/** 上面那条种子 SSID 的密码；开放网络留空字符串。 */
#define TIHU_WIFI_PASSWORD  ""

/* ---------- 宿主地址：可留空（留空 = UDP 发现 → NVS 上次成功地址） ---------- */

/** 写死的宿主 IPv4，例如 "192.168.1.23"。留空字符串 = 全部靠发现/NVS。 */
#define TIHU_HOST           ""

/** pocket 代理端口，默认 3081。 */
#define TIHU_PORT           3081

/**
 * 强制 host 开关（调试用）：1 = 完全不发 UDP 发现，直接用上面的 TIHU_HOST。
 * 2026-11-12 起恢复为 0：最终版走公网入口（或 NVS 里配的局域网/公网），
 * 不再写死局域网地址；需要局域网直连联调时再把它和 TIHU_HOST 一起临时改回。
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

/**
 * 固件版本，只进 hello 日志，也是 OTA 判断「要不要升级」的依据。
 *
 * 0.6.3（2026-11-13）：按住说话先「叮」再开麦（ptt_ding_task，独立任务不阻塞按键轮询）；
 * 录音期间 tihu_audio_push_pcm() 丢弃 tts.audio —— 录音时不许朗读，松手也不补念。
 *
 * 0.6.0（2026-11-12）：板内语音唤醒——ESP-SR WakeNet9 中文「嗨，乐鑫」（wn9_hilexin），
 * 模型包编进 app 分区（main/models/srmodels.bin），AFE+WakeNet 常驻任务在板子上推理，
 * 不联网、不依赖宿主；命中后叮一声并直接走 voice_command_record()。
 *
 * 0.4.0（2026-11-12）：录音增益策略定型——硬件固定 30 dB（撤掉 0.3.8 的自适应升降），
 * 录完先一阶高通去直流、再按 RMS 归一到 1500（只放大过轻的，最多 8 倍、峰值不超 30000）。
 */
#define TIHU_FIRMWARE_VERSION "0.6.3"

/**
 * OTA 的 HTTP 端口：**跟随宿主模式**，别写死。
 *   - 公网模式（NVS host_mode=public）：用 TIHU_PUBLIC_PORT（7080）——
 *     VPS:7080 的 ssh -R 反代到本机 relay 3099，relay 同时服务 /tihu/ota 下的两个端点和 /tihu/lane。
 *     公网上没有 3099 这个口，所以公网模式绝不能去连 3099。
 *   - 局域网直连/强制 host 模式：用下面这个默认值 3099（本机 relay）。
 */
#define TIHU_OTA_PORT       3099

/* ---------- 可选：音频 ---------- */

/**
 * 麦克风硬件增益（dB）＝**固定值**，0.4.0 起不再自适应。
 *
 * 为什么把 0.3.8 的自适应撤掉：实机三次录音的峰值/均方根是 2852/236、
 * 32767/2283、3573/393——同一个人、同一句话，一次削顶两次太小。自适应在
 * 「一次录完调下一次」的闭环里来回抖，永远抓不到稳态；ES7210 又只有 3 dB 一档，
 * 本来就做不出细调。改成「硬件增益固定 30 dB + 录完在软件里归一化」。
 */
#define TIHU_MIC_GAIN_DB    30.0f

/** 削顶判定阈值：16 bit 满幅 32767，|x| >= 32000 即 ≥97.7% 满幅，基本可判为削波。 */
#define TIHU_MIC_CLIP_LEVEL 32000

/* ---------- 可选：录音软件归一化（0.4.0） ---------- */

/** 归一化目标均方根（去直流后，16 bit 尺度）：1500 ≈ −26.8 dBFS，whisper 最舒服的一段。 */
#define TIHU_NORM_TARGET_RMS    1500.0f

/**
 * 归一化触发门限：**只有「太轻」才放大**。
 * 均方根低于 800 或峰值低于 8000 才动；本来正常的声音（例如峰值 20000）不动它，
 * 免得把底噪、空调声一起抬上来——那正是 whisper 幻觉的来源之一。
 */
#define TIHU_NORM_RMS_TRIGGER   800.0f
#define TIHU_NORM_PEAK_TRIGGER  8000

/** 增益因子上限：最多放大 8 倍（+18 dB），再低就认了，不无限拉噪声。 */
#define TIHU_NORM_MAX_GAIN      8.0f

/** 放大后的峰值天花板：留 3000 余量，绝不因为归一化再制造削顶。 */
#define TIHU_NORM_PEAK_CEIL     30000.0f

/**
 * 一阶高通（去直流/低频嗡嗡）系数：y[n] = x[n] - x[n-1] + a*y[n-1]。
 * a = 0.995 @ 16 kHz ⇒ 截止约 12.7 Hz；只压直流和工频以下的缓慢漂移，
 * 不动 100 Hz 以上的人声。放在归一化**之前**，否则直流偏置会把 RMS 抬高、
 * 让「太轻」判不出来。
 */
#define TIHU_HPF_COEF           0.995f

/** 扬声器音量 0–100（开机默认值；之后由机身静音触摸区的手势改，并记在 NVS 里）。 */
#define TIHU_SPEAKER_VOLUME 85

/* ---------- 可选：机身静音触摸区 → 音量手势 ---------- */

/** 默认/「双击复位」音量。 */
#define TIHU_VOL_DEFAULT       TIHU_SPEAKER_VOLUME

/** 按住多久算长按（毫秒）：到点开始连续变音量。 */
#define TIHU_VOL_LONG_PRESS_MS 600

/** 长按期间每多久走一步（毫秒）。 */
#define TIHU_VOL_STEP_MS       100

/** 每步变几个点（2 点/100 ms → 从 85 降到 0 约 4.3 s，听得出变化又不会一下跳到底）。 */
#define TIHU_VOL_STEP          2

/** 两次单击的间隔小于这个值（毫秒）判为双击。 */
#define TIHU_VOL_DOUBLE_MS     450

/** 一次按键录音最长秒数（超过后继续按住也不再录）。 */
#define TIHU_MIC_MAX_SECONDS 10

/* ---------- 可选：网络时序 ---------- */

/** 应用层 ping 间隔（毫秒）。 */
#define TIHU_PING_INTERVAL_MS 15000

/** 这么久没收到任何下行就主动断开重连（毫秒）。 */
#define TIHU_RX_TIMEOUT_MS    60000

/** 一个候选网络最多等多久拿到 IP（毫秒）。密码错/根本不在时 12 秒足够下结论。 */
#define TIHU_WIFI_TRY_TIMEOUT_MS 12000

/**
 * 同一条凭据最多试几次（1 = 不重试）。
 * reason=2「认证超时」多半是手机热点开机/唤醒后的瞬时状态，紧跟着再试常能过，
 * 所以默认 1 次 + 2 次重试；仍然是每次 12 秒超时。
 */
#define TIHU_WIFI_CONNECT_ATTEMPTS 3

/**
 * 配网热点模式下「待机重试」间隔（毫秒）：每这么久重扫一次并把记住的网络再试一遍。
 * 25 秒足够让手机热点从瞬时拒绝里恢复，也不会把 CPU/射频占满。
 */
#define TIHU_PROVISION_RETRY_MS 25000
