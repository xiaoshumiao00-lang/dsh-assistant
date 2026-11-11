/**
 * 配网热点 + HTTP 配网页（手机直接点）。
 *
 * 只依赖 IDF 自带 esp_http_server；页面全内联，不落文件系统。
 * 安全边界：这是「设备不在任何网络里」时才开的兜底通道，AP 密码固定（config.h 可改），
 * 配网页只允许读扫描结果 + 增删 NVS 里的 Wi-Fi，不暴露任何令牌或宿主信息。
 */
#include "tihu_provision.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "tihu_wifi.h"

static const char *TAG = "tihu_provision";

#define PROVISION_HTTP_PORT   80
#define PROVISION_BODY_MAX    512
#define PROVISION_SCAN_MAX    32

static httpd_handle_t s_server;
static bool s_active;
static bool s_ap_netif_created;
static char s_ap_ssid[33];
/* httpd 任务栈最后落在哪：内部 RAM（正常）还是 PSRAM（内部实在挤不出来时的兜底）。 */
static bool s_stack_in_psram;

/** 写 NVS（Wi-Fi save/forget、公网 save/clear）；栈在 PSRAM 时转给内部栈小任务，见文件后半段定义。 */
static bool nvs_job_run(bool is_save, const char *ssid, const char *password);
static bool nvs_public_run(const char *host, int port, bool tls, const char *token);

/* ------------------------------ 小工具 ------------------------------ */

/** HTML 转义（SSID 里可能出现 & < > " '）。 */
static void esc_html(const char *in, char *out, size_t len)
{
    if (out == NULL || len == 0) {
        return;
    }
    size_t w = 0;
    for (const char *p = in != NULL ? in : ""; *p != '\0' && w + 7 < len; p++) {
        switch (*p) {
        case '&': w += (size_t)snprintf(out + w, len - w, "&amp;"); break;
        case '<': w += (size_t)snprintf(out + w, len - w, "&lt;"); break;
        case '>': w += (size_t)snprintf(out + w, len - w, "&gt;"); break;
        case '"': w += (size_t)snprintf(out + w, len - w, "&quot;"); break;
        case '\'': w += (size_t)snprintf(out + w, len - w, "&#39;"); break;
        default: out[w++] = *p; break;
        }
    }
    out[w] = '\0';
}

/** JS 字符串字面量转义（单引号包裹）。 */
static void esc_js(const char *in, char *out, size_t len)
{
    if (out == NULL || len == 0) {
        return;
    }
    size_t w = 0;
    for (const char *p = in != NULL ? in : ""; *p != '\0' && w + 6 < len; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '\'' || c == '\\') {
            out[w++] = '\\';
            out[w++] = (char)c;
        } else if (c < 0x20) {
            w += (size_t)snprintf(out + w, len - w, "\\x%02x", c);
        } else {
            out[w++] = (char)c;
        }
    }
    out[w] = '\0';
}

/* ------------------------------ 响应组装 ------------------------------ */

/*
 * 响应头只允许三样：
 *   Content-Type: text/html; charset=utf-8   —— 固定，由这里设
 *   Content-Length                           —— 由 esp_http_server 按正文长度自动写，
 *                                               绝不手写、也不许 hand-write 一个错值
 *   Connection: close                        —— 配网页只服务一次请求，发完就断
 * 正文一律走 body：页面先在内存里拼成一整块，再一次性 httpd_resp_send() 发出去。
 * 不再用 chunked 边拼边发 —— chunked 没有 Content-Length，浏览器侧看不出总长度，
 * 也没法一眼判断「头是不是被撑大了」。
 */

/* 整页缓冲上限：头 ~1.9 KB + 已存网络 8×~230 B + 扫描结果 32×~150 B + 表单 ~1 KB，留一倍余量。 */
#define PROVISION_PAGE_MAX   16384

static char  *s_page;           /* 整页 HTML 缓冲（PSRAM） */
static size_t s_page_cap;
static size_t s_page_len;
static bool   s_page_truncated;

static void page_reset(void)
{
    s_page_len = 0;
    s_page_truncated = false;
    if (s_page != NULL && s_page_cap > 0) {
        s_page[0] = '\0';
    }
}

/** 往整页缓冲里追加一段格式化文本（超长就截断并置位，结尾统一报一次）。 */
static void page_add(const char *fmt, ...)
{
    if (s_page == NULL || s_page_len + 1 >= s_page_cap) {
        s_page_truncated = true;
        return;
    }
    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(s_page + s_page_len, s_page_cap - s_page_len, fmt, args);
    va_end(args);
    if (n < 0) {
        s_page_truncated = true;
        return;
    }
    if ((size_t)n >= s_page_cap - s_page_len) {
        s_page_len = s_page_cap - 1;
        s_page_truncated = true;
        return;
    }
    s_page_len += (size_t)n;
}

static const char *method_name(httpd_method_t method)
{
    switch (method) {
    case HTTP_GET: return "GET";
    case HTTP_POST: return "POST";
    case HTTP_HEAD: return "HEAD";
    case HTTP_PUT: return "PUT";
    case HTTP_PATCH: return "PATCH";
    case HTTP_DELETE: return "DELETE";
    case HTTP_OPTIONS: return "OPTIONS";
    default: return "?";
    }
}

/**
 * 按 esp_http_server 真正写出去的字节复算一遍响应头，用途只有两个：
 *   1. 打出「响应头总长」——下次谁再把正文塞进头里，串口一眼就能看出来；
 *   2. 把头的键值清单打成一行（\r\n 换成 " | "），和浏览器开发者工具里的
 *      Response Headers 一一对应。
 * @returns 响应头（含结尾空行）的字节数。
 */
static size_t resp_hdr_summary(const char *status, size_t body_len,
                               const char *extra_field, const char *extra_value,
                               char *out, size_t out_len)
{
    char raw[512];
    int n = snprintf(raw, sizeof(raw),
                     "HTTP/1.1 %s\r\nContent-Type: text/html; charset=utf-8\r\n"
                     "Content-Length: %u\r\nConnection: close\r\n",
                     status, (unsigned)body_len);
    if (n > 0 && (size_t)n < sizeof(raw) && extra_field != NULL && extra_value != NULL) {
        int m = snprintf(raw + n, sizeof(raw) - (size_t)n, "%s: %s\r\n", extra_field, extra_value);
        if (m > 0) {
            n += m;
        }
    }
    if (n > 0 && (size_t)n + 2 < sizeof(raw)) {
        raw[n++] = '\r';
        raw[n++] = '\n';
        raw[n] = '\0';
    } else {
        n = 0;
        raw[0] = '\0';
    }

    size_t w = 0;
    /* n - 2：末尾那对空行（\r\n）不算内容，打完最后一个头就收尾。 */
    for (int i = 0; i + 2 < n; i++) {
        if (raw[i] == '\r') {
            continue;
        }
        if (raw[i] == '\n') {
            if (w + 3 < out_len) {
                out[w++] = ' ';
                out[w++] = '|';
                out[w++] = ' ';
            }
            continue;
        }
        if (w + 1 < out_len) {
            out[w++] = raw[i];
        }
    }
    if (out_len > 0) {
        out[w] = '\0';
    }
    return (size_t)n;
}

/**
 * 发一个完整的 HTML 响应：Content-Type + Content-Length（httpd 自动）+ Connection: close，
 * 外加调用方指定的一个短头（只允许 Location —— 重定向语义必需，依旧只是几十字节）。
 * 每个 URI 都打一行「方法 + 路径 + 状态 + 正文字节数 + 响应头字节数」。
 */
static esp_err_t send_html(httpd_req_t *req, const char *status,
                           const char *body, size_t body_len,
                           const char *extra_field, const char *extra_value)
{
    char summary[512];
    size_t hdr_len = resp_hdr_summary(status, body_len, extra_field, extra_value,
                                      summary, sizeof(summary));
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Connection", "close");
    if (extra_field != NULL && extra_value != NULL) {
        httpd_resp_set_hdr(req, extra_field, extra_value);
    }
    ESP_LOGI(TAG, "%s %s → %s · 正文 %u B · 响应头 %u B · 内部堆余 %u B",
             method_name(req->method), req->uri, status, (unsigned)body_len,
             (unsigned)hdr_len,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    ESP_LOGI(TAG, "  响应头清单：%s", summary);
    esp_err_t err = httpd_resp_send(req, body, (ssize_t)body_len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "  发送失败：%s", esp_err_to_name(err));
    }
    return err;
}

/** Content-Type 里取 boundary 不需要；这里只认 urlencoded 表单。 */
static int body_read(httpd_req_t *req, char *buf, size_t len)
{
    int total = 0;
    int want = (int)(req->content_len < (size_t)(len - 1) ? req->content_len : (size_t)(len - 1));
    while (total < want) {
        int got = httpd_req_recv(req, buf + total, (size_t)(want - total));
        if (got <= 0) {
            if (got == HTTPD_SOCK_ERR_TIMEOUT) {
                continue;
            }
            return total;
        }
        total += got;
    }
    buf[total] = '\0';
    return total;
}

static void url_decode(const char *in, char *out, size_t len)
{
    size_t w = 0;
    for (size_t i = 0; in[i] != '\0' && w + 1 < len; i++) {
        char c = in[i];
        if (c == '+') {
            out[w++] = ' ';
        } else if (c == '%' && in[i + 1] != '\0' && in[i + 2] != '\0') {
            char hex[3] = {in[i + 1], in[i + 2], '\0'};
            out[w++] = (char)strtol(hex, NULL, 16);
            i += 2;
        } else {
            out[w++] = c;
        }
    }
    out[w] = '\0';
}

/** 从 urlencoded 表单里取一个字段（未解码）；返回是否找到。 */
static bool form_field(const char *body, const char *key, char *out, size_t len)
{
    char needle[32];
    snprintf(needle, sizeof(needle), "%s=", key);
    const char *p = body;
    while ((p = strstr(p, needle)) != NULL) {
        if (p == body || p[-1] == '&') {
            p += strlen(needle);
            size_t n = strcspn(p, "&");
            if (n >= len) {
                n = len - 1;
            }
            memcpy(out, p, n);
            out[n] = '\0';
            return true;
        }
        p += strlen(needle);
    }
    return false;
}

/* ------------------------------ 页面 ------------------------------ */

static const char *PAGE_HEAD =
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>鹈鹕配网</title><style>"
    "*{box-sizing:border-box}"
    "body{margin:0;padding:16px 14px 40px;font-family:-apple-system,BlinkMacSystemFont,"
    "\"PingFang SC\",\"Microsoft YaHei\",sans-serif;background:#f2f3f5;color:#1c1c1e;font-size:16px;line-height:1.5}"
    "h1{font-size:22px;margin:4px 0 2px}"
    "h2{font-size:16px;margin:22px 0 8px;color:#3a3a3c}"
    ".sub{color:#8e8e93;font-size:13px;margin:0 0 12px}"
    ".card{background:#fff;border-radius:14px;padding:6px 12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}"
    "ul{list-style:none;margin:0;padding:0}"
    "li{display:flex;align-items:center;gap:10px;padding:11px 2px;border-bottom:1px solid #f0f0f2}"
    "li:last-child{border-bottom:none}"
    ".name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    ".meta{color:#8e8e93;font-size:12px;white-space:nowrap}"
    "button{font:inherit;border:none;border-radius:10px;padding:8px 14px;background:#e9e9eb;color:#c0392b}"
    "button.primary{width:100%;background:#0a84ff;color:#fff;font-weight:600;padding:13px;margin-top:12px}"
    "input{width:100%;font:inherit;padding:12px;margin-top:10px;border:1px solid #d8d8dc;border-radius:10px;background:#fff}"
    ".hint{color:#8e8e93;font-size:12px;margin-top:8px}"
    ".empty{color:#8e8e93;padding:12px 2px}"
    "</style></head><body>";

static void page_head(const char *mode_text)
{
    page_add("%s", PAGE_HEAD);
    tihu_wifi_cred_t saved[TIHU_WIFI_MAX_NETWORKS];
    int saved_count = tihu_wifi_saved(saved, TIHU_WIFI_MAX_NETWORKS);
    char ssid_esc[300];
    esc_html(s_ap_ssid, ssid_esc, sizeof(ssid_esc));
    page_add("<h1>鹈鹕配网</h1><p class=\"sub\">%s · 热点 %s · 已记住 %d/%d 个网络</p>",
             mode_text, ssid_esc, saved_count, TIHU_WIFI_MAX_NETWORKS);
}

/** 已保存网络 + 添加表单。 */
static void page_saved(void)
{
    tihu_wifi_cred_t saved[TIHU_WIFI_MAX_NETWORKS];
    int saved_count = tihu_wifi_saved(saved, TIHU_WIFI_MAX_NETWORKS);
    page_add("<h2>已保存的网络</h2><div class=\"card\"><ul>");
    if (saved_count == 0) {
        page_add("<li><span class=\"name empty\">还没有保存任何网络</span></li>");
    }
    for (int i = 0; i < saved_count; i++) {
        char ssid_esc[300];
        esc_html(saved[i].ssid, ssid_esc, sizeof(ssid_esc));
        page_add("<li><span class=\"name\">%s</span><span class=\"meta\">%s</span>"
                 "<form method=\"post\" action=\"/delete\">"
                 "<input type=\"hidden\" name=\"ssid\" value=\"%s\">"
                 "<button type=\"submit\">删除</button></form></li>",
                 ssid_esc, saved[i].password[0] != '\0' ? "有密码" : "开放",
                 ssid_esc);
    }
    page_add("</ul></div>");
    page_add("<h2>添加网络</h2><form method=\"post\" action=\"/save\" id=\"addForm\">"
             "<input name=\"ssid\" id=\"ssid\" placeholder=\"Wi-Fi 名称（SSID）\" "
             "required maxlength=\"32\" autocomplete=\"off\" autocapitalize=\"off\">"
             "<input name=\"password\" id=\"password\" type=\"password\" "
             "placeholder=\"密码（开放网络留空）\" maxlength=\"64\" autocomplete=\"off\">"
             "<button class=\"primary\" type=\"submit\">保存并重启</button>"
             "<p class=\"hint\">保存后设备自动重启，连上后会自动关闭这个热点。</p>"
             "</form>");
}

/**
 * 公网地址（可选）：填了就走公网直连，留空就走局域网 UDP 发现。
 * 两个输入框是独立表单（/public）：只改公网地址不需要再填一遍 Wi-Fi。
 */
static void page_public(void)
{
    tihu_public_cfg_t cfg;
    tihu_wifi_public_get(&cfg);

    page_add("<h2>公网地址（可选）</h2><div class=\"card\">");
    if (cfg.enabled) {
        char host_esc[300];
        esc_html(cfg.host, host_esc, sizeof(host_esc));
        page_add("<p class=\"hint\" style=\"margin:10px 2px 4px\">当前：%s://%s:%d（token %s）</p>",
                 cfg.tls ? "wss" : "ws", host_esc, cfg.port,
                 cfg.token[0] != '\0' ? "已填" : "空");
    } else {
        page_add("<p class=\"hint\" style=\"margin:10px 2px 4px\">当前：局域网模式（UDP 发现宿主）</p>");
    }
    page_add("<form method=\"post\" action=\"/public\" id=\"publicForm\">"
             "<input name=\"public\" id=\"public\" maxlength=\"95\" autocomplete=\"off\" "
             "autocapitalize=\"off\" placeholder=\"公网地址（可选，例 wss://49.234.20.84:7080）\">"
             "<input name=\"token\" id=\"ptoken\" type=\"password\" maxlength=\"79\" "
             "autocomplete=\"off\" placeholder=\"token（pocket 的公网 PIN）\">"
             "<button class=\"primary\" type=\"submit\">保存公网地址并重启</button>"
             "<p class=\"hint\">填了就走公网（wss:// 或 ws:// 直连），留空就走局域网发现。"
             "地址要带端口，端口必须和隧道/反代对外暴露的一致；保存后设备重启生效。</p>"
             "</form></div>");
}

/** 扫到的 SSID（点一下填进上面表单）。 */
static void page_scan(void)
{
    /* static：httpd 只有一个任务、这里串行；放静态区是为了从栈里省出 1.2 KB
     * （内部 RAM 只剩 ~20 KB，httpd 任务栈给不到 8 KB，见 tihu_provision_start）。 */
    static tihu_ap_info_t aps[PROVISION_SCAN_MAX];
    int count = tihu_wifi_scan(aps, PROVISION_SCAN_MAX);
    page_add("<h2>扫到的网络（%d 个，点一下填入上方）</h2><div class=\"card\"><ul>", count);
    if (count == 0) {
        page_add("<li><span class=\"name empty\">没扫到 2.4G 网络，点刷新再试</span></li>");
    }
    for (int i = 0; i < count; i++) {
        char ssid_esc[300];
        char ssid_js[300];
        esc_html(aps[i].ssid, ssid_esc, sizeof(ssid_esc));
        esc_js(aps[i].ssid, ssid_js, sizeof(ssid_js));
        page_add("<li onclick=\"pick('%s')\"><span class=\"name\">%s%s</span>"
                 "<span class=\"meta\">%d dBm · %s</span></li>",
                 ssid_js, ssid_esc,
                 tihu_wifi_saved_find(aps[i].ssid, NULL) ? " ✓" : "",
                 aps[i].rssi, tihu_wifi_auth_name(aps[i].authmode));
    }
    page_add("</ul></div>");
    page_add("<script>"
             "function pick(s){var a=document.getElementById('ssid');"
             "a.value=s;document.getElementById('password').focus();"
             "a.scrollIntoView({behavior:'smooth',block:'center'});}"
             "</script>"
             "<p class=\"hint\" style=\"margin-top:20px\">"
             "<a href=\"/\">刷新扫描结果</a></p></body></html>");
}

/* ------------------------------ 路由 ------------------------------ */

static esp_err_t handler_root(httpd_req_t *req)
{
    if (s_page == NULL) {
        static const char OOM_PAGE[] =
            "<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:sans-serif;padding:20px\">"
            "<h2>配网页缓冲申请失败</h2><p>内部 PSRAM 不足，请断电重上后再试。</p></body>";
        return send_html(req, "503 Service Unavailable", OOM_PAGE, sizeof(OOM_PAGE) - 1, NULL, NULL);
    }
    page_reset();
    page_head("配网热点已开启");
    page_saved();
    page_public();
    page_scan();
    if (s_page_truncated) {
        ESP_LOGW(TAG, "配网页超过缓冲上限 %u B，内容被截断（扫描结果多时属正常，页面仍可提交）",
                 (unsigned)s_page_cap);
    }
    esp_err_t err = send_html(req, "200 OK", s_page, s_page_len, NULL, NULL);
    /* 栈余量是「httpd 任务栈到底够不够」的硬证据：Words × 4 B。 */
    ESP_LOGI(TAG, "  httpd 栈最低余量 %u B",
             (unsigned)uxTaskGetStackHighWaterMark(NULL) * (unsigned)sizeof(StackType_t));
    return err;
}

static esp_err_t handler_favicon(httpd_req_t *req)
{
    return send_html(req, "204 No Content", NULL, 0, NULL, NULL);
}

/** 不在路由表里的 GET（手机连上热点时的「需要登录网络」探测）：一律引到首页。 */
static esp_err_t handler_catch_all(httpd_req_t *req)
{
    return send_html(req, "302 Found", NULL, 0, "Location", "http://192.168.4.1/");
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1400));   /* 先把「已保存，正在重启」发出去 */
    ESP_LOGW(TAG, "配网完成：关闭配网热点，回 STA 模式，重启生效");
    tihu_provision_stop();
    esp_restart();
}

/** 先把响应发完再重启（响应已在调用方 send_html 里发出）。 */
static void kick_restart(void)
{
    if (xTaskCreate(restart_task, "tihu_prov_restart", 3072, NULL, 5, NULL) != pdPASS) {
        ESP_LOGW(TAG, "重启任务创建失败，直接重启");
        tihu_provision_stop();
        esp_restart();
    }
}

static esp_err_t handler_save(httpd_req_t *req)
{
    char body[PROVISION_BODY_MAX];
    body_read(req, body, sizeof(body));
    char raw_ssid[200] = {0};
    char raw_pw[200] = {0};
    char ssid[TIHU_WIFI_SSID_MAX] = {0};
    char password[TIHU_WIFI_PASSWORD_MAX] = {0};
    form_field(body, "ssid", raw_ssid, sizeof(raw_ssid));
    form_field(body, "password", raw_pw, sizeof(raw_pw));
    url_decode(raw_ssid, ssid, sizeof(ssid));
    url_decode(raw_pw, password, sizeof(password));

    if (ssid[0] == '\0') {
        static const char NO_SSID_PAGE[] =
            "<!doctype html><meta charset=\"utf-8\">"
            "<body style=\"font-family:sans-serif;padding:20px\">"
            "<h2>没填 Wi-Fi 名称</h2><p><a href=\"/\">返回</a></p></body>";
        return send_html(req, "400 Bad Request", NO_SSID_PAGE, sizeof(NO_SSID_PAGE) - 1, NULL, NULL);
    }

    ESP_LOGI(TAG, "配网页 POST /save：ssid=\"%s\" 密码=%s", ssid,
             password[0] != '\0' ? "已填" : "空（开放网络）");
    bool ok = nvs_job_run(true, ssid, password);
    if (!ok) {
        static const char FAIL_PAGE[] =
            "<!doctype html><meta charset=\"utf-8\">"
            "<body style=\"font-family:sans-serif;padding:20px\">"
            "<h2>保存失败</h2><p>NVS 写入失败，请重试。</p>"
            "<p><a href=\"/\">返回</a></p></body>";
        return send_html(req, "500 Internal Server Error", FAIL_PAGE, sizeof(FAIL_PAGE) - 1, NULL, NULL);
    }

    char ssid_esc[300];
    esc_html(ssid, ssid_esc, sizeof(ssid_esc));
    /* 拼成一整块（SSID 转义后最长 190 B，页面本身 ~400 B，1 KB 够）。 */
    char ok_page[1024];
    int ok_len = snprintf(ok_page, sizeof(ok_page),
                          "<!doctype html><meta charset=\"utf-8\">"
                          "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                          "<body style=\"font-family:-apple-system,sans-serif;padding:24px;line-height:1.6\">"
                          "<h2>已保存 %s</h2>"
                          "<p>设备正在重启并尝试连接；连不上会自动回到这个热点。</p>"
                          "<p style=\"color:#8e8e93\">稍等 10 秒后刷新本页可以查看结果。</p>"
                          "<p><a href=\"/\">刷新</a></p></body>",
                          ssid_esc);
    if (ok_len < 0) {
        ok_len = 0;
    }
    if (ok_len >= (int)sizeof(ok_page)) {
        ok_len = (int)sizeof(ok_page) - 1;
    }
    send_html(req, "200 OK", ok_page, (size_t)ok_len, NULL, NULL);
    kick_restart();
    return ESP_OK;
}

/**
 * POST /public —— 存「公网地址 + token」。
 *   - 地址留空 = 清除公网配置，host_mode=lan（下次开机重新走 UDP 发现）；
 *   - 地址非空但 token 空 = 拒绝（公网入口一定有 pocket 鉴权）；
 *   - 地址格式不对 = 拒绝并给出可照抄的示例。
 */
static esp_err_t handler_public(httpd_req_t *req)
{
    char body[PROVISION_BODY_MAX];
    body_read(req, body, sizeof(body));

    char raw_public[128] = {0};
    char raw_token[96] = {0};
    char public_url[112] = {0};
    char token[TIHU_PUBLIC_TOKEN_MAX] = {0};
    form_field(body, "public", raw_public, sizeof(raw_public));
    form_field(body, "token", raw_token, sizeof(raw_token));
    url_decode(raw_public, public_url, sizeof(public_url));
    url_decode(raw_token, token, sizeof(token));

    char host[TIHU_PUBLIC_HOST_MAX] = {0};
    int port = 0;
    bool tls = false;

    if (public_url[0] == '\0') {
        bool ok = nvs_public_run("", 0, false, NULL);
        ESP_LOGI(TAG, "配网页 POST /public：地址留空 → 清除公网配置（%s）", ok ? "成功" : "失败");
        static const char CLEARED[] =
            "<!doctype html><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<body style=\"font-family:-apple-system,sans-serif;padding:24px;line-height:1.6\">"
            "<h2>已切回局域网模式</h2>"
            "<p>设备正在重启；连上 Wi-Fi 后用 UDP 广播找宿主。</p>"
            "<p><a href=\"/\">刷新</a></p></body>";
        send_html(req, ok ? "200 OK" : "500 Internal Server Error", CLEARED,
                  sizeof(CLEARED) - 1, NULL, NULL);
        if (ok) {
            kick_restart();
        }
        return ESP_OK;
    }

    if (token[0] == '\0') {
        static const char NO_TOKEN[] =
            "<!doctype html><meta charset=\"utf-8\">"
            "<body style=\"font-family:sans-serif;padding:20px\">"
            "<h2>公网模式要填 token</h2>"
            "<p>token 就是 pocket 的公网 PIN（8 位），填在「公网地址」下面那个框里。</p>"
            "<p><a href=\"/\">返回</a></p></body>";
        return send_html(req, "400 Bad Request", NO_TOKEN, sizeof(NO_TOKEN) - 1, NULL, NULL);
    }

    if (!tihu_wifi_parse_public(public_url, host, sizeof(host), &port, &tls)) {
        static const char BAD_URL[] =
            "<!doctype html><meta charset=\"utf-8\">"
            "<body style=\"font-family:sans-serif;padding:20px\">"
            "<h2>公网地址格式不对</h2>"
            "<p>照这个写：<code>wss://49.234.20.84:7080</code> 或 <code>wss://example.com:80</code>；"
            "只写主机名时默认 wss 443 / ws 80。</p>"
            "<p><a href=\"/\">返回</a></p></body>";
        return send_html(req, "400 Bad Request", BAD_URL, sizeof(BAD_URL) - 1, NULL, NULL);
    }

    ESP_LOGI(TAG, "配网页 POST /public：%s://%s:%d（token 已填，长度 %u）",
             tls ? "wss" : "ws", host, port, (unsigned)strlen(token));
    bool ok = nvs_public_run(host, port, tls, token);
    if (!ok) {
        static const char FAIL_PAGE[] =
            "<!doctype html><meta charset=\"utf-8\">"
            "<body style=\"font-family:sans-serif;padding:20px\">"
            "<h2>保存失败</h2><p>NVS 写入失败，请重试。</p>"
            "<p><a href=\"/\">返回</a></p></body>";
        return send_html(req, "500 Internal Server Error", FAIL_PAGE, sizeof(FAIL_PAGE) - 1, NULL, NULL);
    }

    char host_esc[300];
    esc_html(host, host_esc, sizeof(host_esc));
    /* static：httpd 任务栈可能只有 4 KB，1 KB 的整页放栈上太奢侈（请求串行，复用安全）。 */
    static char ok_page[1024];
    int ok_len = snprintf(ok_page, sizeof(ok_page),
                          "<!doctype html><meta charset=\"utf-8\">"
                          "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                          "<body style=\"font-family:-apple-system,sans-serif;padding:24px;line-height:1.6\">"
                          "<h2>已保存公网入口</h2>"
                          "<p><code>%s://%s:%d</code></p>"
                          "<p>设备正在重启；开机后直接连这个地址的 <code>/tihu/lane</code>，"
                          "不再发 UDP 发现。</p>"
                          "<p style=\"color:#8e8e93\">连不上会自动重试；想改回局域网就在本页把地址留空再保存。</p>"
                          "<p><a href=\"/\">刷新</a></p></body>",
                          tls ? "wss" : "ws", host_esc, port);
    if (ok_len < 0) {
        ok_len = 0;
    }
    if (ok_len >= (int)sizeof(ok_page)) {
        ok_len = (int)sizeof(ok_page) - 1;
    }
    send_html(req, "200 OK", ok_page, (size_t)ok_len, NULL, NULL);
    kick_restart();
    return ESP_OK;
}

static esp_err_t handler_delete(httpd_req_t *req)
{
    char body[PROVISION_BODY_MAX];
    body_read(req, body, sizeof(body));
    char raw[200] = {0};
    char ssid[TIHU_WIFI_SSID_MAX] = {0};
    form_field(body, "ssid", raw, sizeof(raw));
    url_decode(raw, ssid, sizeof(ssid));
    if (ssid[0] != '\0') {
        nvs_job_run(false, ssid, NULL);
        ESP_LOGI(TAG, "配网页删除网络 \"%s\"", ssid);
    }
    return send_html(req, "303 See Other", NULL, 0, "Location", "/");
}

/* ------------------------------ NVS 写入（PSRAM 栈兜底时用） ------------------------------ */

/*
 * NVS 的 save/forget 会擦写 flash。擦写期间 cache 被关闭，**栈在 PSRAM 的任务**
 * 这时只要用到栈就会命中 assert(esp_task_stack_is_sane_cache_disabled())
 * （esp-idf/components/spi_flash/cache_utils.c），直接 panic。
 * 正常情况 httpd 栈在内部 RAM，这里就是一次普通调用；万一内部 RAM 实在挤不出来、
 * 退化到 PSRAM 栈，就把这次写入交给一个 4 KB 内部栈的小任务，httpd 任务只等结果。
 */
static SemaphoreHandle_t s_nvs_done;
static char s_nvs_ssid[TIHU_WIFI_SSID_MAX];
static char s_nvs_password[TIHU_WIFI_PASSWORD_MAX];
static char s_nvs_public_host[TIHU_PUBLIC_HOST_MAX];
static char s_nvs_public_token[TIHU_PUBLIC_TOKEN_MAX];
static int  s_nvs_public_port;
static bool s_nvs_public_tls;

/** 这一次要写什么。三种都走同一个小任务，避免 PSRAM 栈擦 flash 时 panic。 */
typedef enum {
    NVS_OP_WIFI_SAVE = 0,
    NVS_OP_WIFI_FORGET,
    NVS_OP_PUBLIC_SAVE,      /* host 为空 = 清除公网、回局域网 */
} nvs_op_t;

static nvs_op_t s_nvs_op;
static bool s_nvs_result;

static void nvs_job_task(void *arg)
{
    (void)arg;
    switch (s_nvs_op) {
    case NVS_OP_WIFI_SAVE:
        s_nvs_result = tihu_wifi_save(s_nvs_ssid, s_nvs_password);
        break;
    case NVS_OP_WIFI_FORGET:
        s_nvs_result = tihu_wifi_forget(s_nvs_ssid);
        break;
    case NVS_OP_PUBLIC_SAVE:
        s_nvs_result = s_nvs_public_host[0] != '\0'
                           ? tihu_wifi_public_save(s_nvs_public_host, s_nvs_public_port,
                                                   s_nvs_public_tls, s_nvs_public_token)
                           : tihu_wifi_public_clear();
        break;
    default:
        s_nvs_result = false;
        break;
    }
    xSemaphoreGive(s_nvs_done);
    vTaskDelete(NULL);
}

static bool nvs_job_run(bool is_save, const char *ssid, const char *password)
{
    s_nvs_op = is_save ? NVS_OP_WIFI_SAVE : NVS_OP_WIFI_FORGET;
    snprintf(s_nvs_ssid, sizeof(s_nvs_ssid), "%s", ssid);
    snprintf(s_nvs_password, sizeof(s_nvs_password), "%s", password != NULL ? password : "");
    if (!s_stack_in_psram) {
        return is_save ? tihu_wifi_save(ssid, password) : tihu_wifi_forget(ssid);
    }
    if (s_nvs_done == NULL) {
        s_nvs_done = xSemaphoreCreateBinary();
    }
    if (s_nvs_done == NULL ||
        xTaskCreate(nvs_job_task, "tihu_nvs", 4096, NULL, 6, NULL) != pdPASS) {
        ESP_LOGW(TAG, "内部栈任务起不来，退回在 httpd 任务里直接写 NVS");
        return is_save ? tihu_wifi_save(ssid, password) : tihu_wifi_forget(ssid);
    }
    if (xSemaphoreTake(s_nvs_done, pdMS_TO_TICKS(5000)) != pdTRUE) {
        ESP_LOGW(TAG, "NVS 写入超时（5 s）");
        return false;
    }
    return s_nvs_result;
}

/** 存/清公网入口；host 为空 = 清除（回局域网发现）。 */
static bool nvs_public_run(const char *host, int port, bool tls, const char *token)
{
    const char *h = host != NULL ? host : "";
    const char *t = token != NULL ? token : "";
    s_nvs_op = NVS_OP_PUBLIC_SAVE;
    s_nvs_public_port = port;
    s_nvs_public_tls = tls;
    snprintf(s_nvs_public_host, sizeof(s_nvs_public_host), "%s", h);
    snprintf(s_nvs_public_token, sizeof(s_nvs_public_token), "%s", t);
    if (!s_stack_in_psram) {
        return h[0] != '\0' ? tihu_wifi_public_save(h, port, tls, t) : tihu_wifi_public_clear();
    }
    if (s_nvs_done == NULL) {
        s_nvs_done = xSemaphoreCreateBinary();
    }
    if (s_nvs_done == NULL ||
        xTaskCreate(nvs_job_task, "tihu_nvs", 4096, NULL, 6, NULL) != pdPASS) {
        ESP_LOGW(TAG, "内部栈任务起不来，退回在 httpd 任务里直接写 NVS");
        return h[0] != '\0' ? tihu_wifi_public_save(h, port, tls, t) : tihu_wifi_public_clear();
    }
    if (xSemaphoreTake(s_nvs_done, pdMS_TO_TICKS(5000)) != pdTRUE) {
        ESP_LOGW(TAG, "NVS 写入超时（5 s）");
        return false;
    }
    return s_nvs_result;
}

/* ------------------------------ 启停 ------------------------------ */

const char *tihu_provision_ap_ssid(void)
{
    if (s_ap_ssid[0] == '\0') {
        uint8_t mac[6] = {0};
        esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
        snprintf(s_ap_ssid, sizeof(s_ap_ssid), "%s%02X%02X", TIHU_SETUP_AP_PREFIX, mac[4], mac[5]);
    }
    return s_ap_ssid;
}

static bool register_uri(httpd_handle_t server, const char *uri, httpd_method_t method,
                         const char *method_name, esp_err_t (*handler)(httpd_req_t *))
{
    httpd_uri_t route = {
        .uri = uri,
        .method = method,
        .handler = handler,
        .user_ctx = NULL,
    };
    esp_err_t err = httpd_register_uri_handler(server, &route);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "注册 %s %s 失败：%s", method_name, uri, esp_err_to_name(err));
        return false;
    }
    return true;
}

void tihu_provision_start(void)
{
    if (s_active) {
        return;
    }
    const char *ap_ssid = tihu_provision_ap_ssid();

    if (!s_ap_netif_created) {
        esp_netif_t *ap_netif = esp_netif_create_default_wifi_ap();
        s_ap_netif_created = ap_netif != NULL;
        if (!s_ap_netif_created) {
            ESP_LOGE(TAG, "创建 AP netif 失败：配网热点起不来");
            return;
        }
    }

    wifi_config_t ap_cfg = {0};
    snprintf((char *)ap_cfg.ap.ssid, sizeof(ap_cfg.ap.ssid), "%s", ap_ssid);
    snprintf((char *)ap_cfg.ap.password, sizeof(ap_cfg.ap.password), "%s", TIHU_SETUP_AP_PASSWORD);
    ap_cfg.ap.ssid_len = (uint8_t)strlen(ap_ssid);
    ap_cfg.ap.channel = 1;
    ap_cfg.ap.max_connection = 4;
    ap_cfg.ap.authmode = TIHU_SETUP_AP_PASSWORD[0] != '\0' ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    /* 明确 CCMP（AES）：结构体清零后 pairwise_cipher = 0，而 IDF 的头文件写得很清楚——
     * 「枚举值在 TKIP 之前视为非法，会退回默认套件 TKIP+CCMP」。带 TKIP 的热点
     * Windows 11 已经彻底不认：手机/电脑上「看得见、连不上」（报「特定的网络不可用」，
     * AP 侧连关联请求都收不到）。所以这里必须显式指定 CCMP（组播密钥由它派生）。 */
    if (ap_cfg.ap.authmode != WIFI_AUTH_OPEN) {
        ap_cfg.ap.pairwise_cipher = WIFI_CIPHER_TYPE_CCMP;
    }
    ap_cfg.ap.pmf_cfg.required = false;

    esp_err_t err = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "切 APSTA 失败：%s", esp_err_to_name(err));
        return;
    }
    err = esp_wifi_set_config(WIFI_IF_AP, &ap_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "写 AP 配置失败：%s", esp_err_to_name(err));
        return;
    }
    err = esp_wifi_start();
    if (err != ESP_OK && err != ESP_ERR_WIFI_INIT_STATE) {
        ESP_LOGW(TAG, "esp_wifi_start（APSTA）返回 %s", esp_err_to_name(err));
    }

    /* 2.4G 上强制 HT20 + 只用 11b/g：某些手机/笔记本驱动对 softAP 的 HT40/11n
     * 处理很挑（表现为「扫得到、连不上」，AP 侧日志是 `removing station ... after
     * unsuccessful auth/assoc`）。配网页只求可靠，不求速率。
     * 注意：这两句会让 softAP 重新应用配置，串口里会再出现一次 AP_START 和
     * DHCP server started —— 那是 Wi-Fi 事件，不是 httpd 重复启动。放在
     * httpd_start 之前，保证网页服务起在一个已经稳定的 AP 上。 */
    esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW_HT20);
    esp_wifi_set_protocol(WIFI_IF_AP, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G);

    /* 只允许一个 httpd：重复调用不会起第二个服务，也不会重复注册 URI。 */
    if (s_server != NULL) {
        ESP_LOGW(TAG, "HTTP 服务已在运行，忽略重复启动");
        s_active = true;
        return;
    }

    httpd_config_t http_cfg = HTTPD_DEFAULT_CONFIG();
    http_cfg.server_port = PROVISION_HTTP_PORT;
    http_cfg.max_open_sockets = 2;      /* 1 个配网客户端 + 浏览器偶尔并发的 favicon */
    http_cfg.backlog_conn = 2;
    http_cfg.lru_purge_enable = true;
    http_cfg.max_uri_handlers = 8;
    /* 兜底路由（通配 URI）需要通配匹配（默认 NULL = 精确匹配）。 */
    http_cfg.uri_match_fn = httpd_uri_match_wildcard;

    /*
     * 根因（2026-11-11 真机）：AP 起来之后内部 RAM 只剩 ~18–19 KB，而且是碎的。
     * httpd 的任务栈默认要 8 KB **连续内部 RAM**，xTaskCreate 拿不到就返回
     * ESP_ERR_HTTPD_TASK —— 现象就是「热点能连、192.168.4.1 打不开」。
     *
     * 关键坑：这里**只能调用一次 httpd_start**。IDF 5.3 里任务创建失败时走的是
     * httpd_delete()，而 httpd_delete 不关 listen_fd（只有 httpd_server_deinit
     * 会关），80 端口就被那个失败实例占死了；再试第二次一定报
     * `httpd_server_init: error in listen (112)`（EADDRINUSE）。
     * 所以先按「最大连续内部块」算一个一定放得下的栈（FreeRTOS 的 TCB 和栈
     * 是一块连续内存，留 768 B 给 TCB/对齐），内部实在不够才退 PSRAM。
     */
    const size_t internal_largest =
        heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    const size_t tcb_margin = 768;
    size_t stack_used;
    uint32_t stack_caps;
    if (internal_largest >= 8192 + tcb_margin) {
        stack_used = 8192;
        stack_caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    } else if (internal_largest >= 6144 + tcb_margin) {
        stack_used = 6144;
        stack_caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    } else if (internal_largest >= 4096 + tcb_margin) {
        stack_used = 4096;
        stack_caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    } else {
        /* 内部 RAM 连 4 KB 连续块都没有：任务栈退到 PSRAM（NVS 写会因此改走内部栈任务）。 */
        stack_used = 8192;
        stack_caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
    }
    const bool stack_in_psram = (stack_caps & MALLOC_CAP_SPIRAM) != 0;

    ESP_LOGI(TAG, "启动 httpd 前：内部空闲 %u B（最大连续块 %u B），PSRAM 空闲 %u B；max_open_sockets=%d",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)internal_largest,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
             (int)http_cfg.max_open_sockets);
    ESP_LOGI(TAG, "httpd 选栈：stack_size=%u（%s），task_caps=0x%x（最大连续块 %u B − 768 B TCB 余量）",
             (unsigned)stack_used, stack_in_psram ? "PSRAM" : "内部 RAM",
             (unsigned)stack_caps, (unsigned)internal_largest);

    /* 整页缓冲放 PSRAM：内部 RAM 只剩不到 20 KB，放不下这个页面。 */
    if (s_page == NULL) {
        s_page = heap_caps_malloc(PROVISION_PAGE_MAX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        s_page_cap = s_page != NULL ? PROVISION_PAGE_MAX : 0;
        if (s_page == NULL) {
            ESP_LOGE(TAG, "配网页缓冲（PSRAM %u B）申请失败：GET / 会返回 503",
                     (unsigned)PROVISION_PAGE_MAX);
        } else {
            ESP_LOGI(TAG, "配网页缓冲：PSRAM %u B（整页拼好后一次发，Content-Length 由 httpd 自动写）",
                     (unsigned)PROVISION_PAGE_MAX);
        }
    }

    http_cfg.stack_size = stack_used;
    http_cfg.task_caps = stack_caps;
    err = httpd_start(&s_server, &http_cfg);    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HTTP 服务启动失败：%s(0x%x)，stack_size=%u，task_caps=0x%x（热点还在，但网页打不开）",
                 esp_err_to_name(err), (unsigned)err, (unsigned)stack_used, (unsigned)stack_caps);
        return;
    }
    ESP_LOGI(TAG, "httpd_start 成功：stack_size=%u（%s），返回码 %s(0x%x)",
             (unsigned)stack_used, stack_in_psram ? "PSRAM" : "内部 RAM",
             esp_err_to_name(err), (unsigned)err);
    s_stack_in_psram = stack_in_psram;
    if (stack_in_psram) {
        ESP_LOGW(TAG, "httpd 栈落在 PSRAM（%u B）：NVS 写入已改走内部栈小任务", (unsigned)stack_used);
    }

    int registered = 0;
    registered += register_uri(s_server, "/", HTTP_GET, "GET", handler_root);
    registered += register_uri(s_server, "/save", HTTP_POST, "POST", handler_save);
    registered += register_uri(s_server, "/public", HTTP_POST, "POST", handler_public);
    registered += register_uri(s_server, "/delete", HTTP_POST, "POST", handler_delete);
    registered += register_uri(s_server, "/favicon.ico", HTTP_GET, "GET", handler_favicon);
    registered += register_uri(s_server, "/*", HTTP_GET, "GET", handler_catch_all);
    ESP_LOGI(TAG, "配网页 HTTP 服务已就绪：端口 %d，栈 %u B（%s），max_open_sockets=%d，路由注册 %d/6",
             PROVISION_HTTP_PORT, (unsigned)stack_used,
             stack_in_psram ? "PSRAM" : "内部 RAM", (int)http_cfg.max_open_sockets, registered);

    s_active = true;
    wifi_config_t applied = {0};
    if (esp_wifi_get_config(WIFI_IF_AP, &applied) == ESP_OK) {
        ESP_LOGI(TAG, "AP 实际配置：ssid=\"%s\" ch=%d auth=%d cipher=%d hidden=%d bw=HT20/11bg",
                 (char *)applied.ap.ssid, applied.ap.channel, (int)applied.ap.authmode,
                 (int)applied.ap.pairwise_cipher, (int)applied.ap.ssid_hidden);
    }
    ESP_LOGW(TAG, "配网热点已开启：SSID=\"%s\" 密码=\"%s\" 地址=http://192.168.4.1/",
             ap_ssid, TIHU_SETUP_AP_PASSWORD[0] != '\0' ? TIHU_SETUP_AP_PASSWORD : "(开放)");
}

void tihu_provision_stop(void)
{
    if (s_server != NULL) {
        httpd_stop(s_server);
        s_server = NULL;
        ESP_LOGW(TAG, "配网页已关闭");
    }
    if (s_page != NULL) {
        heap_caps_free(s_page);
        s_page = NULL;
        s_page_cap = 0;
        s_page_len = 0;
    }
    if (s_active) {
        esp_wifi_set_mode(WIFI_MODE_STA);
        s_active = false;
        ESP_LOGW(TAG, "配网热点已关闭，回 STA 模式");
    }
}

bool tihu_provision_active(void)
{
    return s_active;
}
