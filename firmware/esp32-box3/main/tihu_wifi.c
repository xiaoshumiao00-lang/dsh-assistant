/**
 * 多网络记忆 + 扫描 + 候选排序。实现在这里，串口日志用 TAG=tihu_wifi。
 */
#include "tihu_wifi.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "tihu_wifi";
static const char *NVS_NS = "tihu_wifi";

static nvs_handle_t s_nvs;
static bool s_nvs_ready;

/* ------------------------------ NVS 小工具 ------------------------------ */

void tihu_wifi_store_init(void)
{
    if (s_nvs_ready) {
        return;
    }
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &s_nvs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS 打开失败（%s）：Wi-Fi 记忆与宿主记忆都不生效", esp_err_to_name(err));
        return;
    }
    s_nvs_ready = true;

    char host[64] = {0};
    int port = 0;
    char token[64] = {0};
    int saved = 0;
    tihu_wifi_cred_t creds[TIHU_WIFI_MAX_NETWORKS];
    saved = tihu_wifi_saved(creds, TIHU_WIFI_MAX_NETWORKS);
    (void)tihu_wifi_last_host(host, sizeof(host), &port, token, sizeof(token));
    ESP_LOGI(TAG, "NVS 就绪：已记住 %d/%d 个网络，上次宿主=%s:%d",
             saved, TIHU_WIFI_MAX_NETWORKS, host[0] != '\0' ? host : "（无）", port);
}

static void key_of(const char *prefix, int index, char *out, size_t len)
{
    snprintf(out, len, "%s%d", prefix, index);
}

static bool read_str(const char *key, char *out, size_t len)
{
    if (!s_nvs_ready) {
        return false;
    }
    size_t need = len;
    esp_err_t err = nvs_get_str(s_nvs, key, out, &need);
    return err == ESP_OK;
}

static bool write_str(const char *key, const char *value)
{
    if (!s_nvs_ready) {
        return false;
    }
    if (nvs_set_str(s_nvs, key, value) != ESP_OK) {
        return false;
    }
    return nvs_commit(s_nvs) == ESP_OK;
}

/** 当前最大落库序号 + 1（只用于「写满时淘汰最旧」）。 */
static uint32_t next_seq(void)
{
    uint32_t max_seq = 0;
    for (int i = 0; i < TIHU_WIFI_MAX_NETWORKS; i++) {
        char key[8];
        key_of("q", i, key, sizeof(key));
        uint32_t seq = 0;
        if (s_nvs_ready && nvs_get_u32(s_nvs, key, &seq) == ESP_OK && seq > max_seq) {
            max_seq = seq;
        }
    }
    return max_seq + 1;
}

static bool slot_ssid(int index, char *out, size_t len)
{
    char key[8];
    key_of("s", index, key, sizeof(key));
    out[0] = '\0';
    return read_str(key, out, len);
}

int tihu_wifi_saved(tihu_wifi_cred_t *out, int max)
{
    if (out == NULL || max <= 0) {
        return 0;
    }
    int count = 0;
    for (int i = 0; i < TIHU_WIFI_MAX_NETWORKS && count < max; i++) {
        tihu_wifi_cred_t cred = {0};
        if (!slot_ssid(i, cred.ssid, sizeof(cred.ssid)) || cred.ssid[0] == '\0') {
            continue;
        }
        char key[8];
        key_of("p", i, key, sizeof(key));
        /* 开放网络没有密码键：读不到就当空密码。 */
        read_str(key, cred.password, sizeof(cred.password));
        out[count++] = cred;
    }
    return count;
}

bool tihu_wifi_saved_find(const char *ssid, tihu_wifi_cred_t *out)
{
    if (ssid == NULL || ssid[0] == '\0') {
        return false;
    }
    tihu_wifi_cred_t creds[TIHU_WIFI_MAX_NETWORKS];
    int count = tihu_wifi_saved(creds, TIHU_WIFI_MAX_NETWORKS);
    for (int i = 0; i < count; i++) {
        if (strcmp(creds[i].ssid, ssid) == 0) {
            if (out != NULL) {
                *out = creds[i];
            }
            return true;
        }
    }
    return false;
}

bool tihu_wifi_save(const char *ssid, const char *password)
{
    if (ssid == NULL || ssid[0] == '\0') {
        return false;
    }
    if (strlen(ssid) >= TIHU_WIFI_SSID_MAX || strlen(password != NULL ? password : "") >= TIHU_WIFI_PASSWORD_MAX) {
        ESP_LOGW(TAG, "SSID/密码太长，拒绝保存（SSID≤32 字节，密码≤64 字节）");
        return false;
    }
    if (!s_nvs_ready) {
        return false;
    }
    const char *pw = password != NULL ? password : "";

    int target = -1;
    int used = 0;
    uint32_t oldest_seq = UINT32_MAX;
    int oldest_slot = -1;
    for (int i = 0; i < TIHU_WIFI_MAX_NETWORKS; i++) {
        char cur[33] = {0};
        if (!slot_ssid(i, cur, sizeof(cur)) || cur[0] == '\0') {
            continue;
        }
        used++;
        if (strcmp(cur, ssid) == 0) {
            target = i;
            break;
        }
        char key[8];
        key_of("q", i, key, sizeof(key));
        uint32_t seq = 0;
        if (nvs_get_u32(s_nvs, key, &seq) != ESP_OK) {
            seq = 0;
        }
        if (seq < oldest_seq) {
            oldest_seq = seq;
            oldest_slot = i;
        }
    }

    if (target < 0) {
        if (used < TIHU_WIFI_MAX_NETWORKS) {
            for (int i = 0; i < TIHU_WIFI_MAX_NETWORKS; i++) {
                char cur[33] = {0};
                if (!slot_ssid(i, cur, sizeof(cur)) || cur[0] == '\0') {
                    target = i;
                    break;
                }
            }
        } else {
            /* 已满：只淘汰最旧那条，其余网络原样保留。 */
            target = oldest_slot;
            if (target < 0) {
                target = 0;
            }
            char kicked[33] = {0};
            slot_ssid(target, kicked, sizeof(kicked));
            ESP_LOGW(TAG, "已记满 %d 个网络，淘汰最旧的 \"%s\" 给 \"%s\" 让位",
                     TIHU_WIFI_MAX_NETWORKS, kicked, ssid);
        }
    }
    if (target < 0) {
        return false;
    }

    char key[8];
    key_of("s", target, key, sizeof(key));
    if (!write_str(key, ssid)) {
        ESP_LOGE(TAG, "写 NVS 失败：%s", key);
        return false;
    }
    key_of("p", target, key, sizeof(key));
    if (pw[0] != '\0') {
        if (!write_str(key, pw)) {
            ESP_LOGE(TAG, "写 NVS 失败：%s", key);
            return false;
        }
    } else {
        nvs_erase_key(s_nvs, key);
        nvs_commit(s_nvs);
    }
    key_of("q", target, key, sizeof(key));
    nvs_set_u32(s_nvs, key, next_seq());
    nvs_commit(s_nvs);

    ESP_LOGI(TAG, "已保存网络 \"%s\"（槽位 %d，密码%s）", ssid, target, pw[0] != '\0' ? "已写" : "空=开放");
    return true;
}

bool tihu_wifi_forget(const char *ssid)
{
    if (ssid == NULL || ssid[0] == '\0') {
        return false;
    }
    for (int i = 0; i < TIHU_WIFI_MAX_NETWORKS; i++) {
        char cur[33] = {0};
        if (!slot_ssid(i, cur, sizeof(cur)) || strcmp(cur, ssid) != 0) {
            continue;
        }
        char key[8];
        key_of("s", i, key, sizeof(key));
        nvs_erase_key(s_nvs, key);
        key_of("p", i, key, sizeof(key));
        nvs_erase_key(s_nvs, key);
        key_of("q", i, key, sizeof(key));
        nvs_erase_key(s_nvs, key);
        nvs_commit(s_nvs);
        char last[33] = {0};
        if (tihu_wifi_last_ssid(last, sizeof(last)) && strcmp(last, ssid) == 0) {
            nvs_erase_key(s_nvs, "last");
            nvs_commit(s_nvs);
        }
        ESP_LOGI(TAG, "已删除网络 \"%s\"（槽位 %d）", ssid, i);
        return true;
    }
    return false;
}

bool tihu_wifi_last_ssid(char *out, size_t len)
{
    if (out == NULL || len == 0) {
        return false;
    }
    out[0] = '\0';
    return read_str("last", out, len) && out[0] != '\0';
}

bool tihu_wifi_mark_connected(const char *ssid)
{
    if (ssid == NULL || ssid[0] == '\0') {
        return false;
    }
    return write_str("last", ssid);
}

bool tihu_wifi_last_host(char *host, size_t host_len, int *port,
                         char *token, size_t token_len)
{
    if (host == NULL || host_len == 0) {
        return false;
    }
    host[0] = '\0';
    if (token != NULL && token_len > 0) {
        token[0] = '\0';
    }
    bool ok = read_str("host", host, host_len) && host[0] != '\0';
    if (port != NULL) {
        uint16_t stored = 0;
        *port = (s_nvs_ready && nvs_get_u16(s_nvs, "port", &stored) == ESP_OK) ? (int)stored : 0;
    }
    if (token != NULL && token_len > 0) {
        read_str("token", token, token_len);
    }
    return ok;
}

bool tihu_wifi_remember_host(const char *host, int port, const char *token)
{
    if (host == NULL || host[0] == '\0') {
        return false;
    }
    if (!write_str("host", host)) {
        return false;
    }
    uint16_t p = (uint16_t)(port > 0 ? port : 3081);
    if (s_nvs_ready) {
        nvs_set_u16(s_nvs, "port", p);
        nvs_commit(s_nvs);
    }
    if (token != NULL) {
        write_str("token", token);
    }
    return true;
}

/* ------------------------------ 扫描 ------------------------------ */

const char *tihu_wifi_auth_name(uint8_t authmode)
{
    switch ((wifi_auth_mode_t)authmode) {
    case WIFI_AUTH_OPEN: return "OPEN";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA-PSK";
    case WIFI_AUTH_WPA2_PSK: return "WPA2-PSK";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2-PSK";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-ENTERPRISE";
    case WIFI_AUTH_WPA3_PSK: return "WPA3-SAE";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3-SAE";
    case WIFI_AUTH_WAPI_PSK: return "WAPI-PSK";
    default: return "未知";
    }
}

int tihu_wifi_scan(tihu_ap_info_t *out, int max)
{
    if (out == NULL || max <= 0) {
        return 0;
    }
    wifi_scan_config_t cfg = {
        .ssid = NULL,
        .bssid = NULL,
        .channel = 0,
        .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
    };
    esp_err_t err = esp_wifi_scan_start(&cfg, true);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "扫描启动失败：%s", esp_err_to_name(err));
        return 0;
    }

    uint16_t ap_num = 0;
    esp_wifi_scan_get_ap_num(&ap_num);
    if (ap_num == 0) {
        ESP_LOGI(TAG, "扫描到 0 个 AP（2.4G 可见范围里一个都没有？先确认路由器是 2.4G 且没关）");
        return 0;
    }
    if (ap_num > 48) {
        ap_num = 48;   /* 只取前 48 条：够了，也省内部 RAM */
    }
    wifi_ap_record_t *recs = calloc(ap_num, sizeof(*recs));
    if (recs == NULL) {
        ESP_LOGW(TAG, "扫描结果分配失败（%u 条）", (unsigned)ap_num);
        return 0;
    }
    uint16_t got = ap_num;
    esp_wifi_scan_get_ap_records(&got, recs);

    int count = 0;
    for (uint16_t i = 0; i < got && count < max; i++) {
        const char *ssid = (const char *)recs[i].ssid;
        if (ssid[0] == '\0') {
            continue;
        }
        bool merged = false;
        for (int j = 0; j < count; j++) {
            if (strcmp(out[j].ssid, ssid) == 0) {
                if (recs[i].rssi > out[j].rssi) {
                    out[j].rssi = recs[i].rssi;
                    out[j].channel = recs[i].primary;
                    out[j].authmode = (uint8_t)recs[i].authmode;
                }
                merged = true;
                break;
            }
        }
        if (merged) {
            continue;
        }
        snprintf(out[count].ssid, sizeof(out[count].ssid), "%s", ssid);
        out[count].rssi = recs[i].rssi;
        out[count].channel = recs[i].primary;
        out[count].authmode = (uint8_t)recs[i].authmode;
        count++;
    }
    free(recs);

    /* 信号从强到弱：候选顺序的一半依据。 */
    for (int i = 1; i < count; i++) {
        tihu_ap_info_t cur = out[i];
        int j = i - 1;
        while (j >= 0 && out[j].rssi < cur.rssi) {
            out[j + 1] = out[j];
            j--;
        }
        out[j + 1] = cur;
    }

    ESP_LOGI(TAG, "扫描到 %d 个 AP：", count);
    for (int i = 0; i < count; i++) {
        ESP_LOGI(TAG, "  AP[%d] ssid=\"%s\" rssi=%d ch=%d auth=%s%s",
                 i, out[i].ssid, out[i].rssi, out[i].channel,
                 tihu_wifi_auth_name(out[i].authmode),
                 tihu_wifi_saved_find(out[i].ssid, NULL) ? "（已记住）" : "");
    }
    return count;
}

/* ------------------------------ 候选排序 ------------------------------ */

int tihu_wifi_candidates(const tihu_ap_info_t *aps, int ap_count,
                         tihu_wifi_cred_t *out, int max,
                         int *rssi_of, bool *is_last)
{
    if (out == NULL || max <= 0) {
        return 0;
    }
    tihu_wifi_cred_t saved[TIHU_WIFI_MAX_NETWORKS];
    int saved_count = tihu_wifi_saved(saved, TIHU_WIFI_MAX_NETWORKS);
    char last[33] = {0};
    bool has_last = tihu_wifi_last_ssid(last, sizeof(last));

    bool used[TIHU_WIFI_MAX_NETWORKS] = {false};
    int count = 0;

    /* 1) 最后成功的那个永远排第一（这轮没扫到也试一次，兼容隐藏 SSID）。 */
    if (has_last) {
        for (int i = 0; i < saved_count; i++) {
            if (strcmp(saved[i].ssid, last) != 0) {
                continue;
            }
            if (count < max) {
                out[count] = saved[i];
                int rssi = -127;
                for (int a = 0; a < ap_count; a++) {
                    if (strcmp(aps[a].ssid, saved[i].ssid) == 0) {
                        rssi = aps[a].rssi;
                        break;
                    }
                }
                if (rssi_of != NULL) {
                    rssi_of[count] = rssi;
                }
                if (is_last != NULL) {
                    is_last[count] = true;
                }
                count++;
            }
            used[i] = true;
            break;
        }
    }

    /* 2) 其余「已记住且可见」的网络，按扫描结果（已是 RSSI 降序）依次加进来。 */
    for (int a = 0; a < ap_count && count < max; a++) {
        for (int i = 0; i < saved_count; i++) {
            if (used[i] || strcmp(saved[i].ssid, aps[a].ssid) != 0) {
                continue;
            }
            out[count] = saved[i];
            if (rssi_of != NULL) {
                rssi_of[count] = aps[a].rssi;
            }
            if (is_last != NULL) {
                is_last[count] = false;
            }
            used[i] = true;
            count++;
            break;
        }
    }
    return count;
}
