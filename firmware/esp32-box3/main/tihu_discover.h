/**
 * UDP 广播发现宿主：发 `TIHU_DISCOVER?` 到 255.255.255.255:3082，
 * 收 `TIHU_HOST <ip> <port> <token>`（宿主 dsh-assistant 的 discover 响应器回）。
 *
 * 为什么要发现：手机热点/家里路由/公司网的网段都不一样，写死 IP 一换地方就废。
 * 发现失败再退回 NVS 里上次成功的地址（见 tihu_net.c 的 resolve_host）。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#define TIHU_DISCOVER_PORT   3082
#define TIHU_DISCOVER_QUERY  "TIHU_DISCOVER?"

/**
 * 广播一轮（最多 timeout_ms，内部重发几次）。
 * @param ip        — 回包里的 IPv4（如 "10.113.136.60"）
 * @param port      — 回包里的端口（通常 3081）
 * @param token     — 回包里的令牌（可为空串）
 * @param timeout_ms — 总预算，建议 2500
 * @returns true = 收到合法回包
 */
bool tihu_discover_host(char *ip, size_t ip_len, int *port,
                        char *token, size_t token_len, int timeout_ms);
