/**
 * UDP 广播发现宿主（lwIP BSD socket）。
 *
 * 报文格式（纯文本一行，两侧都按空格切，不做 JSON——UDP 上少一层解析就少一处坑）：
 *   设备 → 广播 255.255.255.255:3082   `TIHU_DISCOVER?`
 *   宿主 → 单播回源地址           `TIHU_HOST <ip> <port> <token>`
 *
 * 广播会丢包（尤其刚连上 Wi-Fi 时 ARP/组播还没热），所以一轮里重发 3 次、每次等 800 ms。
 */
#include "tihu_discover.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"

static const char *TAG = "tihu_discover";

#define DISCOVER_ATTEMPTS   3
#define DISCOVER_WAIT_MS    800
#define DISCOVER_BUF        128

/** 解析 `TIHU_HOST <ip> <port> <token>`；IPv4 只接受点分四段。 */
static bool parse_reply(const char *text, char *ip, size_t ip_len, int *port,
                        char *token, size_t token_len)
{
    if (strncmp(text, "TIHU_HOST", 9) != 0) {
        return false;
    }
    const char *p = text + 9;
    while (*p == ' ' || *p == '\t') {
        p++;
    }
    char addr[24] = {0};
    size_t w = 0;
    while (*p != '\0' && *p != ' ' && *p != '\r' && *p != '\n' && w + 1 < sizeof(addr)) {
        addr[w++] = *p++;
    }
    addr[w] = '\0';
    while (*p == ' ' || *p == '\t') {
        p++;
    }
    int parsed_port = 0;
    if (*p >= '0' && *p <= '9') {
        parsed_port = (int)strtol(p, (char **)&p, 10);
    }
    while (*p == ' ' || *p == '\t') {
        p++;
    }
    char tok[80] = {0};
    w = 0;
    while (*p != '\0' && *p != '\r' && *p != '\n' && *p != ' ' && w + 1 < sizeof(tok)) {
        tok[w++] = *p++;
    }
    tok[w] = '\0';

    /* IPv4 合法性：四段 0–255。 */
    int a = 0, b = 0, c = 0, d = 0;
    char tail = '\0';
    if (sscanf(addr, "%d.%d.%d.%d%c", &a, &b, &c, &d, &tail) != 4) {
        return false;
    }
    if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) {
        return false;
    }
    if (parsed_port <= 0 || parsed_port > 65535) {
        parsed_port = 3081;
    }

    if (ip != NULL && ip_len > 0) {
        snprintf(ip, ip_len, "%s", addr);
    }
    if (port != NULL) {
        *port = parsed_port;
    }
    if (token != NULL && token_len > 0) {
        snprintf(token, token_len, "%s", tok);
    }
    return true;
}

bool tihu_discover_host(char *ip, size_t ip_len, int *port,
                        char *token, size_t token_len, int timeout_ms)
{
    if (ip == NULL || ip_len == 0) {
        return false;
    }
    ip[0] = '\0';
    if (port != NULL) {
        *port = 0;
    }
    if (token != NULL && token_len > 0) {
        token[0] = '\0';
    }
    if (timeout_ms <= 0) {
        timeout_ms = DISCOVER_ATTEMPTS * DISCOVER_WAIT_MS;
    }

    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGW(TAG, "创建 UDP socket 失败（errno=%d），跳过发现", errno);
        return false;
    }
    int broadcast = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast));
    struct timeval tv = {
        .tv_sec = 0,
        .tv_usec = 300 * 1000,
    };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    struct sockaddr_in dest = {0};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(TIHU_DISCOVER_PORT);
    dest.sin_addr.s_addr = htonl(INADDR_BROADCAST);

    int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    bool found = false;

    for (int attempt = 0; attempt < DISCOVER_ATTEMPTS && !found; attempt++) {
        if (esp_timer_get_time() >= deadline) {
            break;
        }
        int sent = sendto(sock, TIHU_DISCOVER_QUERY, strlen(TIHU_DISCOVER_QUERY), 0,
                          (struct sockaddr *)&dest, sizeof(dest));
        if (sent < 0) {
            ESP_LOGW(TAG, "广播发送失败（errno=%d）", errno);
        } else {
            ESP_LOGI(TAG, "UDP 发现：广播 \"%s\" → 255.255.255.255:%d（第 %d/%d 次）",
                     TIHU_DISCOVER_QUERY, TIHU_DISCOVER_PORT, attempt + 1, DISCOVER_ATTEMPTS);
        }

        int64_t wait_until = esp_timer_get_time() + (int64_t)DISCOVER_WAIT_MS * 1000;
        while (esp_timer_get_time() < wait_until && !found) {
            char buf[DISCOVER_BUF + 1];
            struct sockaddr_in from = {0};
            socklen_t from_len = sizeof(from);
            int n = recvfrom(sock, buf, DISCOVER_BUF, 0, (struct sockaddr *)&from, &from_len);
            if (n <= 0) {
                vTaskDelay(pdMS_TO_TICKS(50));
                continue;
            }
            buf[n] = '\0';
            ESP_LOGI(TAG, "UDP 回包（来自 %s）：%s", inet_ntoa(from.sin_addr), buf);
            if (parse_reply(buf, ip, ip_len, port, token, token_len)) {
                found = true;
            }
        }
    }

    close(sock);
    if (!found) {
        return false;
    }
    ESP_LOGI(TAG, "UDP 发现成功：host=%s port=%d token=%s", ip, port != NULL ? *port : 0,
             (token != NULL && token[0] != '\0') ? "已收到" : "空");
    return true;
}
