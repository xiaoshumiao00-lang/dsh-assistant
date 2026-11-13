/**
 * 固件 OTA 客户端（拉清单 → 流式下载 → sha256 校验 → 切槽重启）。
 *
 * 设计约定（2026-11-12 用户拍板，别自己换方案）：
 *   - 宿主侧由 relay（3099）直接服务 /tihu/ota/manifest 与 /tihu/ota/firmware，
 *     其它路径仍反代到 pocket 3081；所以 OTA 的 HTTP 端口是 TIHU_OTA_PORT(3099)，
 *     而 WebSocket lane 仍是 TIHU_PORT(3081)。
 *   - 双 OTA 槽：app 写进「非当前」的那个槽（esp_ota_get_next_update_partition），
 *     写完校验通过才 esp_ota_set_boot_partition + esp_restart。
 *   - 失败一律 esp_ota_abort（原槽不动）+ 10 分钟退避，绝不半途而废。
 *   - 不整块缓存在 RAM：PSRAM 16 KB 小缓冲循环写。
 *
 * 调用方：main.c 在 tihu_net_start() 之后调 tihu_ota_start()；
 *         tihu_net.c 在解析出宿主地址时调 tihu_ota_set_host()；
 *         收到 WS 下行 device.ota 时调 tihu_ota_trigger()。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** 建 OTA 任务 + 10 分钟定时器（幂等，重复调用无副作用）。 */
void tihu_ota_start(void);

/**
 * 同步宿主地址（relay 在哪个 IP/端口上跑）。
 * @param port 公网模式传 TIHU_PUBLIC_PORT（7080，VPS 上 ssh -R 反代到本机 relay），
 *             局域网直连模式传 TIHU_OTA_PORT（3099）。port<=0 时用 TIHU_OTA_PORT。
 * @param tls  宿主入口是不是 https（公网 TLS=0 时传 false）
 */
void tihu_ota_set_host(const char *ip, int port, bool tls);

/**
 * 立即检查一次（WS 下行 device.ota 或别处手动触发）。
 * @param why 日志里写的原因，例如 "ws device.ota"
 * @param url 可选：payload 里给的清单地址（覆盖默认 /tihu/ota/manifest）
 */
void tihu_ota_trigger(const char *why, const char *url);

/** 正在下载/校验时为 true（别的地方要避免同时重启板子）。 */
bool tihu_ota_busy(void);

/**
 * 把一行诊断文本发到宿主 relay 的 /tihu/diag（relay 日志会记 DIAG <text>）。
 * 没有网/宿主地址未知时静默丢弃，绝不影响主流程。
 */
void tihu_ota_diag(const char *text);

/** 把一段 WAV 发到宿主 /tihu/wake，判断是不是唤醒词「鹈鹕」。 */
bool tihu_ota_wake_check(const uint8_t *wav, size_t len);
