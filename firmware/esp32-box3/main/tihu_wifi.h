/**
 * 多网络记忆（NVS）+ 扫描 + 「先试哪个」的排序。
 *
 * 换地方不用重刷固件的前提就两条：
 *   1. 连上过的 Wi-Fi 都记在 NVS 里（最多 8 组），不是编译期常量；
 *   2. 开机先扫可见 AP，只在「已记住 + 可见」里按「最后成功 → 信号最强」排。
 *
 * NVS 命名空间 `tihu_wifi`，键位：
 *   s0..s7 / p0..p7 / q0..q7  —— 第 i 组 SSID / 密码 / 落库序号（序号只用来在写满时淘汰最旧的）
 *   last                      —— 最后连上的 SSID（下次优先）
 *   host / port / token       —— 上次发现成功的宿主（UDP 发现失败时回退用）
 *   host_mode                 —— "public" = 走公网地址；其它/缺失 = 局域网（UDP 发现）
 *   public_host / public_port / public_tls / public_token
 *                             —— 公网入口（host 不带 scheme；tls=1 用 wss://，0 用 ws://）
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TIHU_WIFI_MAX_NETWORKS   8
#define TIHU_WIFI_SSID_MAX       33
#define TIHU_WIFI_PASSWORD_MAX   65

/** 一组凭据。 */
typedef struct {
    char ssid[TIHU_WIFI_SSID_MAX];
    char password[TIHU_WIFI_PASSWORD_MAX];
} tihu_wifi_cred_t;

/** 一次扫描里的一个 AP（同一 SSID 多 BSSID 只留信号最强那条）。 */
typedef struct {
    char ssid[TIHU_WIFI_SSID_MAX];
    int8_t rssi;
    uint8_t channel;
    uint8_t authmode;
} tihu_ap_info_t;

/** 打开 NVS 命名空间（main 里 nvs_flash_init 之后调用一次即可）。 */
void tihu_wifi_store_init(void);

/** 读出已保存的全部凭据（按落库顺序）；返回条数。 */
int tihu_wifi_saved(tihu_wifi_cred_t *out, int max);

/** 按 SSID 取已保存的密码；没存过返回 false。 */
bool tihu_wifi_saved_find(const char *ssid, tihu_wifi_cred_t *out);

/** 保存/更新一组凭据（已存在则只更新密码，不覆盖别的网络）；满 8 组时淘汰最旧。 */
bool tihu_wifi_save(const char *ssid, const char *password);

/** 删除一组凭据。 */
bool tihu_wifi_forget(const char *ssid);

/** 最后连上的 SSID（没有就返回 false）。 */
bool tihu_wifi_last_ssid(char *out, size_t len);

/** 连上之后调用：记住「这次成功的是谁」（下次排第一）。 */
bool tihu_wifi_mark_connected(const char *ssid);

/** 上次发现成功的宿主（host/port/token 任一为空串也返回，由调用方判空）。 */
bool tihu_wifi_last_host(char *host, size_t host_len, int *port,
                         char *token, size_t token_len);

/** 发现成功后写回宿主信息（等下次 UDP 发现失败时兜底）。 */
bool tihu_wifi_remember_host(const char *host, int port, const char *token);

/* ------------------------------ 公网入口（NVS） ------------------------------ */

#define TIHU_PUBLIC_HOST_MAX   96
#define TIHU_PUBLIC_TOKEN_MAX  80

/** 公网连接配置；enabled=false 表示走局域网（UDP 发现 → NVS 上次地址）。 */
typedef struct {
    bool enabled;
    bool tls;                            /* true = wss://，false = ws:// */
    int  port;
    char host[TIHU_PUBLIC_HOST_MAX];     /* 只存主机名/IP，不带 scheme 与路径 */
    char token[TIHU_PUBLIC_TOKEN_MAX];
} tihu_public_cfg_t;

/**
 * 解析用户填的「公网地址」。接受 `wss://host:port`、`ws://host:port`、
 * `https://host:port`、`http://host:port`、`host:port` 和裸 `host`；路径部分忽略。
 * 端口缺省：TLS 443 / 明文 80。
 * @returns true = 解析成功（host 非空且端口合法）。
 */
bool tihu_wifi_parse_public(const char *input, char *host, size_t host_len,
                            int *port, bool *tls);

/** 读公网配置（enabled=false 时 host/token 为空串）。 */
void tihu_wifi_public_get(tihu_public_cfg_t *out);

/** host_mode 是否已在 NVS 里落过（编译期种子只补写一次，别覆盖用户在配网页里的选择）。 */
bool tihu_wifi_host_mode_set(void);

/** 存公网配置并把 host_mode 置 public；host 为空 = 清除（host_mode=lan）。 */
bool tihu_wifi_public_save(const char *host, int port, bool tls, const char *token);

/** 清除公网配置（host_mode=lan，下次开机重新走局域网发现）。 */
bool tihu_wifi_public_clear(void);

/**
 * 阻塞扫描（APSTA 下调也可以：配网页靠它列 SSID）。
 * @returns 写进 out 的 AP 个数；已按 RSSI 从强到弱排序、去掉无 SSID 与重复项。
 */
int tihu_wifi_scan(tihu_ap_info_t *out, int max);

/**
 * 生成尝试顺序：最后成功的 SSID 排第一（即便这轮没扫到也试），
 * 其后是「已记住且可见」的网络按 RSSI 降序；没记住的可见 AP 一律不进候选。
 * @param rssi_of — 可选，输出每个候选的 RSSI（没扫到记 -127）
 * @param is_last — 可选，输出该候选是不是「最后成功」
 * @returns 候选个数。
 */
int tihu_wifi_candidates(const tihu_ap_info_t *aps, int ap_count,
                         tihu_wifi_cred_t *out, int max,
                         int *rssi_of, bool *is_last);

/** authmode → 串口里的可读名。 */
const char *tihu_wifi_auth_name(uint8_t authmode);
