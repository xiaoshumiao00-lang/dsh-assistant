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
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
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

/** 发一段（不格式化，% 原样）。 */
static esp_err_t chunk_text(httpd_req_t *req, const char *text)
{
    return httpd_resp_send_chunk(req, text, (ssize_t)strlen(text));
}

/** 发一段格式化文本。 */
static esp_err_t chunk_fmt(httpd_req_t *req, const char *fmt, ...)
{
    char buf[512];
    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    if (n <= 0) {
        return ESP_OK;
    }
    if (n >= (int)sizeof(buf)) {
        n = (int)sizeof(buf) - 1;
    }
    return httpd_resp_send_chunk(req, buf, n);
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

static esp_err_t page_head(httpd_req_t *req, const char *mode_text)
{
    esp_err_t err = httpd_resp_set_type(req, "text/html; charset=utf-8");
    if (err != ESP_OK) {
        return err;
    }
    if ((err = chunk_text(req, PAGE_HEAD)) != ESP_OK) {
        return err;
    }
    tihu_wifi_cred_t saved[TIHU_WIFI_MAX_NETWORKS];
    int saved_count = tihu_wifi_saved(saved, TIHU_WIFI_MAX_NETWORKS);
    char ssid_esc[300];
    esc_html(s_ap_ssid, ssid_esc, sizeof(ssid_esc));
    return chunk_fmt(req,
                     "<h1>鹈鹕配网</h1><p class=\"sub\">%s · 热点 %s · 已记住 %d/%d 个网络</p>",
                     mode_text, ssid_esc, saved_count, TIHU_WIFI_MAX_NETWORKS);
}

/** 已保存网络 + 添加表单。 */
static esp_err_t page_saved(httpd_req_t *req)
{
    tihu_wifi_cred_t saved[TIHU_WIFI_MAX_NETWORKS];
    int saved_count = tihu_wifi_saved(saved, TIHU_WIFI_MAX_NETWORKS);
    esp_err_t err = chunk_text(req, "<h2>已保存的网络</h2><div class=\"card\"><ul>");
    if (err != ESP_OK) {
        return err;
    }
    if (saved_count == 0) {
        err = chunk_text(req, "<li><span class=\"name empty\">还没有保存任何网络</span></li>");
        if (err != ESP_OK) {
            return err;
        }
    }
    for (int i = 0; i < saved_count; i++) {
        char ssid_esc[300];
        esc_html(saved[i].ssid, ssid_esc, sizeof(ssid_esc));
        err = chunk_fmt(req,
                        "<li><span class=\"name\">%s</span><span class=\"meta\">%s</span>"
                        "<form method=\"post\" action=\"/delete\">"
                        "<input type=\"hidden\" name=\"ssid\" value=\"%s\">"
                        "<button type=\"submit\">删除</button></form></li>",
                        ssid_esc, saved[i].password[0] != '\0' ? "有密码" : "开放",
                        ssid_esc);
        if (err != ESP_OK) {
            return err;
        }
    }
    if ((err = chunk_text(req, "</ul></div>")) != ESP_OK) {
        return err;
    }
    return chunk_text(req,
                      "<h2>添加网络</h2><form method=\"post\" action=\"/save\" id=\"addForm\">"
                      "<input name=\"ssid\" id=\"ssid\" placeholder=\"Wi-Fi 名称（SSID）\" "
                      "required maxlength=\"32\" autocomplete=\"off\" autocapitalize=\"off\">"
                      "<input name=\"password\" id=\"password\" type=\"password\" "
                      "placeholder=\"密码（开放网络留空）\" maxlength=\"64\" autocomplete=\"off\">"
                      "<button class=\"primary\" type=\"submit\">保存并重启</button>"
                      "<p class=\"hint\">保存后设备自动重启，连上后会自动关闭这个热点。</p>"
                      "</form>");
}

/** 扫到的 SSID（点一下填进上面表单）。 */
static esp_err_t page_scan(httpd_req_t *req)
{
    tihu_ap_info_t aps[PROVISION_SCAN_MAX];
    int count = tihu_wifi_scan(aps, PROVISION_SCAN_MAX);
    esp_err_t err = chunk_fmt(req, "<h2>扫到的网络（%d 个，点一下填入上方）</h2><div class=\"card\"><ul>", count);
    if (err != ESP_OK) {
        return err;
    }
    if (count == 0) {
        err = chunk_text(req, "<li><span class=\"name empty\">没扫到 2.4G 网络，点刷新再试</span></li>");
        if (err != ESP_OK) {
            return err;
        }
    }
    for (int i = 0; i < count; i++) {
        char ssid_esc[300];
        char ssid_js[300];
        esc_html(aps[i].ssid, ssid_esc, sizeof(ssid_esc));
        esc_js(aps[i].ssid, ssid_js, sizeof(ssid_js));
        err = chunk_fmt(req,
                        "<li onclick=\"pick('%s')\"><span class=\"name\">%s%s</span>"
                        "<span class=\"meta\">%d dBm · %s</span></li>",
                        ssid_js, ssid_esc,
                        tihu_wifi_saved_find(aps[i].ssid, NULL) ? " ✓" : "",
                        aps[i].rssi, tihu_wifi_auth_name(aps[i].authmode));
        if (err != ESP_OK) {
            return err;
        }
    }
    if ((err = chunk_text(req, "</ul></div>")) != ESP_OK) {
        return err;
    }
    return chunk_text(req,
                      "<script>"
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
    ESP_LOGI(TAG, "配网页 GET /（来自 %s）", req->uri);
    esp_err_t err = page_head(req, "配网热点已开启");
    if (err == ESP_OK) {
        err = page_saved(req);
    }
    if (err == ESP_OK) {
        err = page_scan(req);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "配网页发送失败：%s", esp_err_to_name(err));
        return ESP_FAIL;
    }
    return httpd_resp_send_chunk(req, NULL, 0);
}

static esp_err_t handler_favicon(httpd_req_t *req)
{
    httpd_resp_set_status(req, "204 No Content");
    return httpd_resp_send(req, NULL, 0);
}

/** 不在路由表里的 GET（手机连上热点时的「需要登录网络」探测）：一律引到首页。 */
static esp_err_t handler_catch_all(httpd_req_t *req)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
    return httpd_resp_send(req, NULL, 0);
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1400));   /* 先把「已保存，正在重启」发出去 */
    ESP_LOGW(TAG, "配网完成：关闭配网热点，回 STA 模式，重启生效");
    tihu_provision_stop();
    esp_restart();
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
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "text/html; charset=utf-8");
        httpd_resp_sendstr(req,
                           "<!doctype html><meta charset=\"utf-8\">"
                           "<body style=\"font-family:sans-serif;padding:20px\">"
                           "<h2>没填 Wi-Fi 名称</h2><p><a href=\"/\">返回</a></p></body>");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "配网页 POST /save：ssid=\"%s\" 密码=%s", ssid,
             password[0] != '\0' ? "已填" : "空（开放网络）");
    bool ok = tihu_wifi_save(ssid, password);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    if (!ok) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        httpd_resp_sendstr(req,
                           "<!doctype html><meta charset=\"utf-8\">"
                           "<body style=\"font-family:sans-serif;padding:20px\">"
                           "<h2>保存失败</h2><p>NVS 写入失败，请重试。</p>"
                           "<p><a href=\"/\">返回</a></p></body>");
        return ESP_OK;
    }

    char ssid_esc[300];
    esc_html(ssid, ssid_esc, sizeof(ssid_esc));
    /* 分段发（不拼一个大会话缓冲）：SSID 最长 32 字节、转义后仍可能 190+ 字节，
     * 一次 snprintf 进固定缓冲会被 -Wformat-truncation 判成可能截断（等于编不过）。 */
    httpd_resp_sendstr_chunk(req,
                             "<!doctype html><meta charset=\"utf-8\">"
                             "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                             "<body style=\"font-family:-apple-system,sans-serif;padding:24px;line-height:1.6\">"
                             "<h2>已保存 ");
    httpd_resp_sendstr_chunk(req, ssid_esc);
    httpd_resp_sendstr_chunk(req,
                             "</h2>"
                             "<p>设备正在重启并尝试连接；连不上会自动回到这个热点。</p>"
                             "<p style=\"color:#8e8e93\">稍等 10 秒后刷新本页可以查看结果。</p>"
                             "<p><a href=\"/\">刷新</a></p></body>");
    httpd_resp_sendstr_chunk(req, NULL);
    if (xTaskCreate(restart_task, "tihu_prov_restart", 3072, NULL, 5, NULL) != pdPASS) {
        ESP_LOGW(TAG, "重启任务创建失败，直接重启");
        tihu_provision_stop();
        esp_restart();
    }
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
        tihu_wifi_forget(ssid);
        ESP_LOGI(TAG, "配网页删除网络 \"%s\"", ssid);
    }
    httpd_resp_set_status(req, "303 See Other");
    httpd_resp_set_hdr(req, "Location", "/");
    return httpd_resp_send(req, NULL, 0);
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

static void register_uri(httpd_handle_t server, const char *uri, httpd_method_t method,
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
    }
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

    httpd_config_t http_cfg = HTTPD_DEFAULT_CONFIG();
    http_cfg.server_port = PROVISION_HTTP_PORT;
    http_cfg.max_open_sockets = 4;
    http_cfg.lru_purge_enable = true;
    http_cfg.stack_size = 8192;
    http_cfg.uri_match_fn = httpd_uri_match_wildcard;
    err = httpd_start(&s_server, &http_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HTTP 服务启动失败：%s（热点还在，但网页打不开）", esp_err_to_name(err));
        return;
    }
    register_uri(s_server, "/", HTTP_GET, "GET", handler_root);
    register_uri(s_server, "/save", HTTP_POST, "POST", handler_save);
    register_uri(s_server, "/delete", HTTP_POST, "POST", handler_delete);
    register_uri(s_server, "/favicon.ico", HTTP_GET, "GET", handler_favicon);
    register_uri(s_server, "/*", HTTP_GET, "GET", handler_catch_all);

    s_active = true;
    /* 2.4G 上强制 HT20 + 只用 11b/g：某些手机/笔记本驱动对 softAP 的 HT40/11n
     * 处理很挑（表现为「扫得到、连不上」，AP 侧日志是 `removing station ... after
     * unsuccessful auth/assoc`）。配网页只求可靠，不求速率。 */
    esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW_HT20);
    esp_wifi_set_protocol(WIFI_IF_AP, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G);
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
