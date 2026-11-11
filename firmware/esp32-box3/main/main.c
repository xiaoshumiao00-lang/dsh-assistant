/**
 * ESP32-S3-BOX-3B 鹈鹕设备固件入口。
 *
 * 启动顺序：
 *   NVS → LVGL 三屏 → 音频 codec → Wi-Fi/WebSocket → CONFIG 键（按住说话）。
 *
 * 板子上没有“本地唤醒词”：按住顶部 CONFIG 键（GPIO0）说话，松开即上传 16k WAV。
 * 宿主下发 voice.listen 时也会自动开麦，超时后自动上传。
 */
#include <stdbool.h>
#include <stdio.h>

#include "config.h"
#include "esp_log.h"
#include "esp_system.h"
#include "iot_button.h"
#include "nvs_flash.h"
#include "tihu_audio.h"
#include "tihu_net.h"
#include "ui.h"
#include "bsp/esp-box-3.h"

static const char *TAG = "tihu_main";
static bool s_ptt_active;

static void ptt_press(void *handle, void *usr_data)
{
    (void)handle;
    (void)usr_data;
    if (s_ptt_active) {
        return;
    }
    s_ptt_active = true;
    /* 按住说话优先于宿主 voice.listen 的自动收尾，避免录到一半被定时器截走。 */
    tihu_net_cancel_listen();
    /* 录音前先停声：BOX-3 的 speaker/mic 共用 I2S，24k 与 16k 同时开容易把声音带偏。 */
    tihu_audio_stop();
    tihu_audio_mic_start();
    tihu_ui_set_listening(true, "正在听 · 松开上传");
    ESP_LOGI(TAG, "开始录音");
}

static void ptt_release(void *handle, void *usr_data)
{
    (void)handle;
    (void)usr_data;
    if (!s_ptt_active) {
        return;
    }
    s_ptt_active = false;
    size_t len = 0;
    const uint8_t *wav = tihu_audio_mic_stop(&len);
    tihu_ui_set_listening(false, NULL);
    if (wav != NULL && len > 44) {
        ESP_LOGI(TAG, "录音结束：%u 字节（约 %d ms）",
                 (unsigned)len, (int)(((len - 44) * 1000) / (16000 * 2)));
        tihu_net_send_wav(wav, len);
    } else {
        ESP_LOGW(TAG, "没有录到音频（麦克风未初始化或按得太短）");
    }
}

static void buttons_init(void)
{
    button_handle_t btns[BSP_BUTTON_NUM] = {NULL};
    int count = 0;
    esp_err_t err = bsp_iot_button_create(btns, &count, BSP_BUTTON_NUM);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "按键初始化失败: %s", esp_err_to_name(err));
        return;
    }
    if (BSP_BUTTON_CONFIG < count && btns[BSP_BUTTON_CONFIG] != NULL) {
        iot_button_register_cb(btns[BSP_BUTTON_CONFIG], BUTTON_PRESS_DOWN, NULL,
                               ptt_press, NULL);
        iot_button_register_cb(btns[BSP_BUTTON_CONFIG], BUTTON_PRESS_UP, NULL,
                               ptt_release, NULL);
        ESP_LOGI(TAG, "按住 CONFIG 键说话，松开上传");
    } else {
        ESP_LOGW(TAG, "没有找到 CONFIG 键，只能用 voice.listen 或屏幕操作");
    }
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_LOGI(TAG, "鹈鹕 BOX-3B 固件 %s 启动", TIHU_FIRMWARE_VERSION);
    tihu_ui_init();
    tihu_audio_init();
    tihu_net_start();
    buttons_init();
}
