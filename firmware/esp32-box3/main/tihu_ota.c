/**
 * 固件 OTA 客户端：向宿主（relay 3099）拉清单 → 流式下载 → sha256 校验 → 切槽重启。
 *
 * 关键约束（2026-11-12 用户定案）：
 *   1. 跑在独立任务里，绝不塞进 websocket_task（那个任务栈/时序都经不起 HTTP）。
 *   2. 不整块缓存：PSRAM 16 KB 小缓冲循环 esp_ota_write。
 *   3. 失败（连不上/HTTP 非 200/长度不符/sha 不符/esp_ota_end 失败）一律
 *      esp_ota_abort 保留原槽，且 10 分钟内不再重试，日志写清原因。
 *   4. 双击槽：写进「非当前运行」的那个槽。
 */
#include "tihu_ota.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "cJSON.h"
#include "tihu_audio.h"
#include "config.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "driver/i2c_master.h"
#include "esp_codec_dev_defaults.h"
#include "bsp/esp-box-3.h"
#include <ctype.h>
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"

static const char *TAG = "tihu_ota";

#define OTA_CHUNK_BYTES        (16 * 1024)
/* 定时检查间隔：0.3.7 起 30 分钟 → 10 分钟（用户嫌等太久；一次清单只几十字节，代价可忽略）。 */
#define OTA_CHECK_PERIOD_MS    (10 * 60 * 1000)   /* 定时检查间隔 */
#define OTA_RETRY_BACKOFF_MS   (10 * 60 * 1000)   /* 失败后 10 分钟不再试（保持不变） */
#define OTA_HTTP_TIMEOUT_MS    10000
#define OTA_JSON_MAX           2048
#define OTA_PATH_MAX           160

static TaskHandle_t s_task;
static char s_host[64];                    /* relay 的 IP（由 tihu_net 同步过来） */
static int  s_port = TIHU_OTA_PORT;
static bool s_tls;                         /* 宿主入口是 https 时为 true（公网 TLS=1 才会） */
static bool s_started;
static volatile bool s_busy;
static int64_t s_backoff_until_ms;
static char s_next_manifest[OTA_PATH_MAX] = "/tihu/ota/manifest";

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

bool tihu_ota_busy(void)
{
    return s_busy;
}

void tihu_ota_set_host(const char *ip, int port, bool tls)
{
    if (ip == NULL || ip[0] == '\0') {
        return;
    }
    bool changed = strcmp(s_host, ip) != 0 || (port > 0 && port != s_port) || tls != s_tls;
    snprintf(s_host, sizeof(s_host), "%s", ip);
    if (port > 0) {
        s_port = port;
    }
    s_tls = tls;
    if (changed) {
        ESP_LOGI(TAG, "OTA 宿主更新：%s://%s:%d（清单 %s）", s_tls ? "https" : "http",
                 s_host, s_port, s_next_manifest);
    }
}

/** STA 侧是否拿到 IP（配网热点模式/没连上都算「尚未联网」）。 */
static bool sta_has_ip(void)
{
    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (sta == NULL) {
        return false;
    }
    esp_netif_ip_info_t ip;
    memset(&ip, 0, sizeof(ip));
    if (esp_netif_get_ip_info(sta, &ip) != ESP_OK) {
        return false;
    }
    return ip.ip.addr != 0;
}

/** 当前运行槽的描述（串口里要看清「现在跑的是哪个槽、下次写到哪个槽」）。 */
static void log_slots(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    const esp_partition_t *upd = esp_ota_get_next_update_partition(NULL);
    ESP_LOGI(TAG, "分区：运行槽=%s @0x%06x（%u KB），OTA 写槽=%s @0x%06x（%u KB）",
             run != NULL ? run->label : "?", run != NULL ? (unsigned)run->address : 0u,
             run != NULL ? (unsigned)(run->size / 1024) : 0u,
             upd != NULL ? upd->label : "（无，分区表不是双槽？）",
             upd != NULL ? (unsigned)upd->address : 0u,
             upd != NULL ? (unsigned)(upd->size / 1024) : 0u);
}

/** 小 JSON 的 GET（清单文件几 KB 以内）。成功返回 HTTP 200 且 body 非空。 */
static bool http_get_small(const char *url, char *buf, size_t cap, int *out_len)
{
    *out_len = 0;
    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = OTA_HTTP_TIMEOUT_MS,
        .buffer_size = 1024,
        .user_agent = "pelican-box3-ota",
        .skip_cert_common_name_check = s_tls,
    };
    esp_http_client_handle_t cli = esp_http_client_init(&cfg);
    if (cli == NULL) {
        ESP_LOGE(TAG, "清单请求：esp_http_client_init 失败");
        return false;
    }
    bool ok = false;
    if (esp_http_client_open(cli, 0) != ESP_OK) {
        ESP_LOGE(TAG, "清单请求：连不上 %s", url);
        esp_http_client_cleanup(cli);
        return false;
    }
    int64_t clen = esp_http_client_fetch_headers(cli);
    int status = esp_http_client_get_status_code(cli);
    if (status != 200) {
        ESP_LOGW(TAG, "清单请求：HTTP %d（%s）", status, url);
        esp_http_client_close(cli);
        esp_http_client_cleanup(cli);
        return false;
    }
    int total = 0;
    for (;;) {
        if ((size_t)total + 1 >= cap) {
            ESP_LOGW(TAG, "清单超过 %u 字节，截断", (unsigned)cap);
            break;
        }
        int r = esp_http_client_read(cli, buf + total, (int)(cap - 1 - (size_t)total));
        if (r <= 0) {
            break;
        }
        total += r;
    }
    buf[total] = '\0';
    *out_len = total;
    ok = total > 0;
    ESP_LOGI(TAG, "清单请求：HTTP %d，Content-Length=%lld，读到 %d 字节",
             status, (long long)clen, total);
    esp_http_client_close(cli);
    esp_http_client_cleanup(cli);
    return ok;
}

/** 算「当前运行镜像」的 sha256（只算 manifest 给的 size 那么多字节，避免每次哈希 6 MB）。 */
static bool running_sha256_hex(long long bytes, char out[65])
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    if (run == NULL) {
        return false;
    }
    size_t limit = run->size;
    if (bytes > 0 && (size_t)bytes < limit) {
        limit = (size_t)bytes;
    }
    uint8_t *buf = heap_caps_malloc(OTA_CHUNK_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) {
        return false;
    }
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0);
    bool ok = true;
    for (size_t off = 0; off < limit;) {
        size_t n = limit - off;
        if (n > OTA_CHUNK_BYTES) {
            n = OTA_CHUNK_BYTES;
        }
        if (esp_partition_read(run, off, buf, n) != ESP_OK) {
            ok = false;
            break;
        }
        mbedtls_sha256_update(&ctx, buf, n);
        off += n;
    }
    unsigned char digest[32] = {0};
    if (ok) {
        mbedtls_sha256_finish(&ctx, digest);
        for (int i = 0; i < 32; i++) {
            snprintf(out + i * 2, 3, "%02x", digest[i]);
        }
        out[64] = '\0';
    }
    mbedtls_sha256_free(&ctx);
    free(buf);
    return ok;
}

static void hex_of(const unsigned char digest[32], char out[65])
{
    for (int i = 0; i < 32; i++) {
        snprintf(out + i * 2, 3, "%02x", digest[i]);
    }
    out[64] = '\0';
}

/**
 * 流式下载并写入备用槽。
 * @returns true = 已 esp_ota_set_boot_partition 成功（调用方随后重启）。
 */
static bool ota_download_apply(const char *path, const char *want_sha, long long want_size)
{
    const esp_partition_t *upd = esp_ota_get_next_update_partition(NULL);
    if (upd == NULL) {
        ESP_LOGE(TAG, "下载中止：没有可写的 OTA 槽（分区表不是双槽？）");
        return false;
    }
    char url[256];
    snprintf(url, sizeof(url), "%s://%s:%d%s", s_tls ? "https" : "http", s_host, s_port, path);

    uint8_t *buf = heap_caps_malloc(OTA_CHUNK_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) {
        ESP_LOGE(TAG, "下载中止：%d 字节 PSRAM 缓冲分配失败", OTA_CHUNK_BYTES);
        return false;
    }

    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = OTA_HTTP_TIMEOUT_MS,
        .buffer_size = 2048,
        .user_agent = "pelican-box3-ota",
        .skip_cert_common_name_check = s_tls,
    };
    esp_http_client_handle_t cli = esp_http_client_init(&cfg);
    if (cli == NULL) {
        ESP_LOGE(TAG, "下载中止：esp_http_client_init 失败");
        free(buf);
        return false;
    }

    esp_ota_handle_t handle = 0;
    bool begun = false;
    bool ok = false;
    long long written = 0;
    int status = 0;

    if (esp_http_client_open(cli, 0) != ESP_OK) {
        ESP_LOGE(TAG, "下载中止：连不上 %s", url);
        goto done;
    }
    {
        long long clen = esp_http_client_fetch_headers(cli);
        status = esp_http_client_get_status_code(cli);
        if (status != 200) {
            ESP_LOGE(TAG, "下载中止：HTTP %d（%s）", status, url);
            goto done;
        }
        ESP_LOGI(TAG, "开始下载：%s（Content-Length=%lld，清单 size=%lld）", url, clen, want_size);
        if (clen > 0 && want_size > 0 && clen != want_size) {
            ESP_LOGW(TAG, "长度对不上：Content-Length=%lld 清单=%lld（继续下，最后按 sha 判）",
                     clen, want_size);
        }
        if ((size_t)upd->size < (size_t)(want_size > 0 ? want_size : 0)) {
            ESP_LOGE(TAG, "下载中止：清单 size=%lld 超过槽容量 %u 字节",
                     want_size, (unsigned)upd->size);
            goto done;
        }
    }

    if (esp_ota_begin(upd, OTA_SIZE_UNKNOWN, &handle) != ESP_OK) {
        ESP_LOGE(TAG, "下载中止：esp_ota_begin 失败（槽 %s）", upd->label);
        goto done;
    }
    begun = true;
    {
        mbedtls_sha256_context ctx;
        mbedtls_sha256_init(&ctx);
        mbedtls_sha256_starts(&ctx, 0);
        int last_pct = -1;
        bool io_err = false;
        for (;;) {
            int r = esp_http_client_read(cli, (char *)buf, OTA_CHUNK_BYTES);
            if (r < 0) {
                ESP_LOGE(TAG, "下载中止：读失败（已写 %lld 字节）", written);
                io_err = true;
                break;
            }
            if (r == 0) {
                break;   /* 正常结束 */
            }
            if (esp_ota_write(handle, buf, (size_t)r) != ESP_OK) {
                ESP_LOGE(TAG, "下载中止：esp_ota_write 失败（已写 %lld 字节）", written);
                io_err = true;
                break;
            }
            mbedtls_sha256_update(&ctx, buf, (size_t)r);
            written += r;
            if (want_size > 0) {
                int pct = (int)((written * 100) / want_size);
                if (pct / 10 > last_pct / 10) {
                    last_pct = pct;
                    ESP_LOGI(TAG, "下载中 %d%%（%lld/%lld 字节）", pct, written, want_size);
                }
            } else if ((written % (512 * 1024)) < OTA_CHUNK_BYTES) {
                ESP_LOGI(TAG, "下载中 %lld 字节（清单没给 size）", written);
            }
        }
        unsigned char digest[32] = {0};
        bool hashed = !io_err && written > 0;
        if (hashed) {
            mbedtls_sha256_finish(&ctx, digest);
        }
        mbedtls_sha256_free(&ctx);
        if (io_err) {
            goto done;
        }

        if (want_size > 0 && written != want_size) {
            ESP_LOGE(TAG, "下载中止：实收 %lld 字节，清单声明 %lld", written, want_size);
            goto done;
        }
        if (want_sha != NULL && want_sha[0] != '\0') {
            char got[65];
            hex_of(digest, got);
            if (strcasecmp(got, want_sha) != 0) {
                ESP_LOGE(TAG, "校验失败：sha256 不符（收到 %.16s… 期望 %.16s…）", got, want_sha);
                goto done;
            }
            ESP_LOGI(TAG, "校验通过：sha256=%.16s…（%lld 字节）", got, written);
        } else {
            ESP_LOGW(TAG, "清单没给 sha256，跳过完整性校验（仅靠 esp_ota_end 的镜像校验）");
        }
    }

    if (esp_ota_end(handle) != ESP_OK) {
        ESP_LOGE(TAG, "下载中止：esp_ota_end 校验失败（镜像不合法）");
        begun = false;   /* esp_ota_end 失败时 handle 已失效，不能再 abort */
        goto done;
    }
    begun = false;
    if (esp_ota_set_boot_partition(upd) != ESP_OK) {
        ESP_LOGE(TAG, "切换启动槽失败（%s）", upd->label);
        goto done;
    }
    ESP_LOGI(TAG, "已切换到新槽 %s，准备重启", upd->label);
    ok = true;

done:
    if (begun && handle != 0) {
        esp_ota_abort(handle);
        ESP_LOGW(TAG, "已 esp_ota_abort：原槽保持不变（本次写入 %lld 字节作废）", written);
    }
    esp_http_client_close(cli);
    esp_http_client_cleanup(cli);
    free(buf);
    return ok;
}

/** 一次完整的检查（清单 + 需要就更）。 */
static void ota_check(const char *why)
{
    if (s_busy) {
        ESP_LOGI(TAG, "检查跳过：上一次 OTA 还在跑");
        return;
    }
    int64_t now = now_ms();
    if (now < s_backoff_until_ms) {
        ESP_LOGW(TAG, "检查跳过：上次失败，%.1f 分钟后再试（原因=%s）",
                 (s_backoff_until_ms - now) / 60000.0, why);
        return;
    }
    /* 先判联网：没 Wi-Fi（配网热点模式）时连宿主地址都还没解析出来，
     * 报「尚未联网」才是真原因，别让「不知道宿主地址」把话说岔。 */
    if (!sta_has_ip()) {
        ESP_LOGW(TAG, "检查跳过：尚未联网（配网热点模式/没连上 Wi-Fi），原因=%s", why);
        return;
    }
    const bool absolute = strncmp(s_next_manifest, "http://", 7) == 0 ||
                          strncmp(s_next_manifest, "https://", 8) == 0;
    if (!absolute && s_host[0] == '\0') {
        ESP_LOGW(TAG, "检查跳过：还不知道宿主地址（原因=%s）", why);
        return;
    }

    s_busy = true;
    char url[320];
    const char *scheme = s_tls ? "https" : "http";
    if (absolute) {
        snprintf(url, sizeof(url), "%s%cclient=esp32-box3&version=%s", s_next_manifest,
                 strchr(s_next_manifest, '?') != NULL ? '&' : '?', TIHU_FIRMWARE_VERSION);
    } else {
        snprintf(url, sizeof(url), "%s://%s:%d%s?client=esp32-box3&version=%s",
                 scheme, s_host, s_port, s_next_manifest, TIHU_FIRMWARE_VERSION);
    }
    ESP_LOGI(TAG, "开始检查：%s（当前版本 %s，原因=%s）", url, TIHU_FIRMWARE_VERSION, why);

    char *json = malloc(OTA_JSON_MAX);
    if (json == NULL) {
        ESP_LOGE(TAG, "检查中止：清单缓冲 malloc 失败");
        s_busy = false;
        return;
    }
    int len = 0;
    if (!http_get_small(url, json, OTA_JSON_MAX, &len)) {
        ESP_LOGW(TAG, "检查失败：清单拿不到（%d 字节），%d 分钟内不再重试",
                 len, OTA_RETRY_BACKOFF_MS / 60000);
        s_backoff_until_ms = now_ms() + OTA_RETRY_BACKOFF_MS;
        free(json);
        s_busy = false;
        return;
    }

    cJSON *root = cJSON_Parse(json);
    if (root == NULL) {
        ESP_LOGE(TAG, "检查失败：清单不是合法 JSON：%.80s", json);
        s_backoff_until_ms = now_ms() + OTA_RETRY_BACKOFF_MS;
        free(json);
        s_busy = false;
        return;
    }
    const cJSON *jv = cJSON_GetObjectItem(root, "version");
    const cJSON *ju = cJSON_GetObjectItem(root, "url");
    const cJSON *js = cJSON_GetObjectItem(root, "sha256");
    const cJSON *jz = cJSON_GetObjectItem(root, "size");
    /*
     * 必须拷出来再 cJSON_Delete：以前直接用 jv->valuestring，删完树再拼下载 URL，
     * 拼出来是野指针（实机日志：`Error parse url http://49.234.20.84:7080<乱码>/firmware`
     * → `esp_http_client_init 失败`）。2026-11-12 实测踩到。
     */
    char ver_buf[40] = {0};
    char path_buf[OTA_PATH_MAX] = {0};
    char sha_buf[80] = {0};
    snprintf(ver_buf, sizeof(ver_buf), "%s", cJSON_IsString(jv) ? jv->valuestring : "");
    snprintf(path_buf, sizeof(path_buf), "%s",
             cJSON_IsString(ju) && ju->valuestring[0] != '\0' ? ju->valuestring : "/tihu/ota/firmware");
    snprintf(sha_buf, sizeof(sha_buf), "%s", cJSON_IsString(js) ? js->valuestring : "");
    const char *ver = ver_buf;
    const char *path = path_buf;
    const char *sha = sha_buf;
    long long size = cJSON_IsNumber(jz) ? (long long)jz->valuedouble : 0;
    ESP_LOGI(TAG, "清单：version=%s size=%lld sha256=%.16s… url=%s（当前 %s）",
             ver[0] != '\0' ? ver : "(空)", size, sha[0] != '\0' ? sha : "(空)", path,
             TIHU_FIRMWARE_VERSION);

    bool need = false;
    if (ver[0] != '\0' && strcmp(ver, TIHU_FIRMWARE_VERSION) != 0) {
        need = true;
        ESP_LOGI(TAG, "有新版本：%s → %s", TIHU_FIRMWARE_VERSION, ver);
    } else if (sha[0] != '\0') {
        /* 版本号相同也允许「内容变了」：比一下当前运行镜像的 sha。 */
        char mine[65];
        if (running_sha256_hex(size, mine)) {
            if (strcasecmp(mine, sha) != 0) {
                need = true;
                ESP_LOGW(TAG, "版本号相同但镜像不同：本地 %.16s… vs 清单 %.16s… → 照样升级",
                         mine, sha);
            } else {
                ESP_LOGI(TAG, "已是最新：版本与 sha256 都一致（%.16s…）", mine);
            }
        } else {
            ESP_LOGW(TAG, "运行镜像 sha 算不出来，按「已是最新」处理");
        }
    } else {
        ESP_LOGI(TAG, "已是最新：version=%s", TIHU_FIRMWARE_VERSION);
    }
    cJSON_Delete(root);
    free(json);

    if (!need) {
        s_busy = false;
        return;
    }

    if (!ota_download_apply(path, sha, size)) {
        ESP_LOGE(TAG, "本次升级失败：保留原槽，%d 分钟内不再重试",
                 OTA_RETRY_BACKOFF_MS / 60000);
        s_backoff_until_ms = now_ms() + OTA_RETRY_BACKOFF_MS;
        s_busy = false;
        return;
    }

    ESP_LOGI(TAG, "升级完成，2 秒后重启进新固件");
    vTaskDelay(pdMS_TO_TICKS(2000));
    esp_restart();
}

/**
 * 给宿主发一行诊断（GET /tihu/diag?text=...）；relay 会把它写进 relay.log。
 * 只做「发出去」，不等业务结果：失败就算了，录音/OTA 都不受它影响。
 */
void tihu_ota_diag(const char *text)
{
    if (text == NULL || s_host[0] == '\0') {
        return;
    }
    char enc[300];
    size_t w = 0;
    for (const char *p2 = text; *p2 != '\0' && w + 4 < sizeof(enc); p2++) {
        unsigned char c = (unsigned char)*p2;
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            enc[w++] = (char)c;
        } else {
            snprintf(enc + w, 4, "%%%02X", c);
            w += 3;
        }
    }
    enc[w] = '\0';
    char url[420];
    snprintf(url, sizeof(url), "%s://%s:%d/tihu/diag?text=%s",
             s_tls ? "https" : "http", s_host, s_port, enc);
    char tiny[32];
    int len = 0;
    (void)http_get_small(url, tiny, sizeof(tiny), &len);
}


/**
 * 把一小段 WAV 发给宿主的 /tihu/wake，由本地 whisper 判是不是「鹈鹕」。
 * 返回 true 表示唤醒词命中（请求失败一律当没命中，绝不阻塞主流程太久）。
 */
bool tihu_ota_wake_check(const uint8_t *wav, size_t len)
{
    if (wav == NULL || len < 1000 || s_host[0] == '\0') {
        return false;
    }
    char url[192];
    snprintf(url, sizeof(url), "%s://%s:%d/tihu/wake",
             s_tls ? "https" : "http", s_host, s_port);
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 15000,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t cli = esp_http_client_init(&cfg);
    if (cli == NULL) {
        return false;
    }
    esp_http_client_set_header(cli, "Content-Type", "audio/wav");
    esp_http_client_set_post_field(cli, (const char *)wav, (int)len);
    bool hit = false;
    esp_err_t err = esp_http_client_perform(cli);
    if (err == ESP_OK && esp_http_client_get_status_code(cli) == 200) {
        char body[192];
        int total = 0;
        while (total < (int)sizeof(body) - 1) {
            int r = esp_http_client_read(cli, body + total, (int)(sizeof(body) - 1 - total));
            if (r <= 0) {
                break;
            }
            total += r;
        }
        body[total] = '\0';
        hit = strstr(body, "\"wake\":true") != NULL;
        if (hit) {
            ESP_LOGI(TAG, "唤醒词命中：%s", body);
        }
    } else {
        ESP_LOGW(TAG, "唤醒检测请求失败：%s", esp_err_to_name(err));
    }
    esp_http_client_cleanup(cli);
    return hit;
}

/** 扫一遍 I2C 总线，把在线地址报给宿主（判断板子上到底是 ES7210 还是别的 ADC）。 */
static void report_i2c_scan(void)
{
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) {
        tihu_ota_diag("i2c scan: bus null");
        return;
    }
    char out[256];
    int w = snprintf(out, sizeof(out), "i2c scan:");
    for (int a = 0x08; a < 0x78 && w < (int)sizeof(out) - 8; a++) {
        if (i2c_master_probe(bus, a, 20) == ESP_OK) {
            w += snprintf(out + w, sizeof(out) - (size_t)w, " %02X", a);
        }
    }
    tihu_ota_diag(out);
    ESP_LOGI(TAG, "%s", out);
}


/** 只读探测：0x40/0x41/0x3E 上到底有没有芯片应答、读回什么（写会毁配置，所以只读）。 */
static void report_codec_regs(void)
{
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) {
        tihu_ota_diag("regs: bus null");
        return;
    }
    static const uint8_t addrs[] = { 0x40, 0x41, 0x3E, 0x18 };
    for (int i = 0; i < (int)(sizeof(addrs) / sizeof(addrs[0])); i++) {
        int cnt = 0;
        for (int k = 0; k < 3; k++) {
            if (i2c_master_probe(bus, addrs[i], 50) == ESP_OK) {
                cnt++;
            }
        }
        audio_codec_i2c_cfg_t cfg = {
            .port = BSP_I2C_NUM,
            .addr = addrs[i],
            .bus_handle = bus,
        };
        const audio_codec_ctrl_if_t *ctrl = audio_codec_new_i2c_ctrl(&cfg);
        int r0 = -99;
        int v0 = -1;
        int r1 = -99;
        int v1 = -1;
        if (ctrl != NULL) {
            uint8_t b0 = 0;
            uint8_t b1 = 0;
            r0 = ctrl->read_reg(ctrl, 0x00, 1, &b0, 1);
            v0 = b0;
            r1 = ctrl->read_reg(ctrl, 0x01, 1, &b1, 1);
            v1 = b1;
            audio_codec_delete_ctrl_if(ctrl);
        }
        char line[150];
        snprintf(line, sizeof(line), "reg %02X probe=%d/3 r0=%d/%02X r1=%d/%02X",
                 addrs[i], cnt, r0, v0 & 0xFF, r1, v1 & 0xFF);
        tihu_ota_diag(line);
    }
}

static void ota_task(void *arg)
{
    (void)arg;
    /* 启动后先等一会儿：让选网、WS 握手、UI 首帧先跑完，别和它们抢内存。 */
    vTaskDelay(pdMS_TO_TICKS(20000));
    tihu_ota_diag("boot diag v=" TIHU_FIRMWARE_VERSION);
    for (;;) {
        ota_check("首次启动");
        /* 等 10 分钟；期间收到 device.ota 会提前唤醒。 */
        if (xTaskNotifyWait(0, 0xffffffff, NULL, pdMS_TO_TICKS(OTA_CHECK_PERIOD_MS)) == pdTRUE) {
            ota_check("ws device.ota");
        }
    }
}

void tihu_ota_trigger(const char *why, const char *url)
{
    if (url != NULL && url[0] != '\0') {
        snprintf(s_next_manifest, sizeof(s_next_manifest), "%s", url);
        ESP_LOGI(TAG, "device.ota 指定清单地址：%s", s_next_manifest);
    }
    ESP_LOGI(TAG, "收到立即检查请求（%s）", why != NULL ? why : "未说明");
    if (s_task == NULL) {
        ESP_LOGW(TAG, "OTA 任务还没起来，请求先忽略");
        return;
    }
    xTaskNotifyGive(s_task);
}

void tihu_ota_start(void)
{
    if (s_started) {
        return;
    }
    s_started = true;

    /* 双槽 + 出厂无 factory 槽：开机必须把当前镜像标成 valid，否则 bootloader 会回滚。 */
    const esp_partition_t *run = esp_ota_get_running_partition();
    if (run != NULL && (run->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_0 ||
                        run->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_1)) {
        esp_ota_img_states_t st;
        if (esp_ota_get_state_partition(run, &st) == ESP_OK) {
            if (st == ESP_OTA_IMG_PENDING_VERIFY) {
                esp_ota_mark_app_valid_cancel_rollback();
                ESP_LOGW(TAG, "当前镜像处于待验证态，已标记 valid（取消回滚）");
            } else {
                ESP_LOGI(TAG, "当前镜像状态=0x%x（已 valid）", (unsigned)st);
            }
        }
    }
    log_slots();

    if (s_port <= 0) {
        s_port = TIHU_OTA_PORT;
    }
    /* 还没同步到宿主时，先用编译期 TIHU_HOST 顶上（强制宿主调试模式常见）。 */
    if (s_host[0] == '\0' && TIHU_HOST[0] != '\0') {
        snprintf(s_host, sizeof(s_host), "%s", TIHU_HOST);
    }

    /* 定时检查由 ota_task 里的 xTaskNotifyWait 超时承担（10 分钟），不再单独建 esp_timer。 */
    if (xTaskCreate(ota_task, "tihu_ota", 8192, NULL, 3, &s_task) != pdPASS) {
        ESP_LOGE(TAG, "OTA 任务创建失败（栈 8192 B）");
        s_task = NULL;
    } else {
        ESP_LOGI(TAG, "OTA 客户端就绪：每 %d 分钟检查一次，失败退避 %d 分钟，缓冲 %d KB(PSRAM)",
                 OTA_CHECK_PERIOD_MS / 60000, OTA_RETRY_BACKOFF_MS / 60000,
                 OTA_CHUNK_BYTES / 1024);
    }
}
