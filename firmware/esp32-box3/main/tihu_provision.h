/**
 * 配网热点（Pelican-Setup-XXXX）+ 极简 HTTP 配网页。
 *
 * 触发条件只有一个：开机把 NVS 里记住的网络都试完还没连上。
 * 页面三块：扫到的 SSID（带 dBm）、已保存的网络（可删）、添加网络（存 NVS 后重启）。
 */
#pragma once

#include <stdbool.h>

/** 起 AP（APSTA）+ HTTP 服务；可重复调用（已起就不重复建）。 */
void tihu_provision_start(void);

/** 关配网页 + 关 AP，回到纯 STA。保存成功重启前会调用一次。 */
void tihu_provision_stop(void);

/** AP 是否开着。 */
bool tihu_provision_active(void);

/** AP 名（Pelican-Setup-XXXX）；没起过也返回将要用的名字，便于串口/屏幕显示。 */
const char *tihu_provision_ap_ssid(void);
