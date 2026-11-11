/**
 * ESP32-S3-BOX-3B 鹈鹕设备固件入口。
 *
 * 启动顺序：
 *   NVS → LVGL 三屏 + 静态首页 → 常驻 UI 任务 → 音频 codec → Wi-Fi/WebSocket → CONFIG 键。
 *
 * 板子上没有“本地唤醒词”：按住顶部 CONFIG 键（GPIO0）说话，松开即上传 16k WAV。
 * 宿主下发 voice.listen 时也会自动开麦，超时后自动上传。
 *
 * 注意 app_main 末尾会返回（ESP-IDF 的 main_task 就此结束），这**不是**“程序停了”：
 * 屏幕由 tihu_ui_task 常驻驱动，网络由 websocket/wifi 任务驱动，按键由 iot_button 驱动。
 */
#include <stdbool.h>
#include <stdio.h>

#include "config.h"
#include "button_gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "iot_button.h"
#include "nvs_flash.h"
#include "tihu_audio.h"
#include "tihu_net.h"
#include "ui.h"
#include "bsp/esp-box-3.h"

static const char *TAG = "tihu_main";
static bool s_ptt_active;

#define TIHU_UI_TASK_STACK   (12 * 1024)
#define TIHU_UI_TASK_PRIO    3
#define TIHU_UI_TICK_MS      10

/**
 * 常驻 UI 任务。
 *
 * 关键：LVGL 的**渲染**只能在栈够大的任务里做。一屏 320×240 中文标签，
 * lv_refr_now/lv_timer_handler 的调用链（lv_refr → lv_draw_label → 字库）要 5–7 KB
 * 栈；放在 8 KB 的 main 任务或 4 KB 的 websocket 任务里就会踩爆栈、指针乱飞、
 * 面板反复重启（实测 backtrace：vApplicationStackOverflowHook + lv_draw_label_iterate_characters）。
 * 所以这里给 12 KB 栈，并且第一次循环先同步刷一帧，保证开机立刻有画面。
 *
 * esp_lvgl_port 自己也有 taskLVGL 在跑 lv_timer_handler；两边共用 BSP 的递归锁，
 * 不会并发进 LVGL。每 5 秒往串口报一次 handler/flush 计数，只看日志就知道屏在刷。
 */
static void tihu_ui_task(void *arg)
{
    (void)arg;
    unsigned loops = 0;
    unsigned last_flush = 0;
    ESP_LOGI(TAG, "UI 任务已进入常驻循环：%d ms/帧，栈 %d B，core=%d",
             TIHU_UI_TICK_MS, TIHU_UI_TASK_STACK, xPortGetCoreID());

    for (;;) {
        if (bsp_display_lock(pdMS_TO_TICKS(200))) {
            if (loops == 0) {
                /* 开机第一帧同步刷出：不依赖 tick，也不依赖宿主。 */
                lv_refr_now(NULL);
            }
            lv_timer_handler();
            bsp_display_unlock();
        }
        loops++;
        if ((loops % (5000 / TIHU_UI_TICK_MS)) == 0) {
            unsigned flush = tihu_ui_flush_count();
            ESP_LOGI(TAG, "UI 心跳：handler=%u flush=%u(+%u) 内部堆余=%uB PSRAM 余=%uB",
                     loops, flush, flush - last_flush,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
            last_flush = flush;
        }
        vTaskDelay(pdMS_TO_TICKS(TIHU_UI_TICK_MS));
    }
}

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
    /*
     * 只建 CONFIG 键（GPIO0），不走 bsp_iot_button_create()。
     *
     * 原因：BOX-3 的按键表里 BSP_BUTTON_MAIN 是 GT911 上的「触摸主页键」，
     * bsp_iot_button_create() 在 BSP 的静态 tp 为空时会**再 new 一个 GT911 实例**。
     * 现在触摸由 tihu_touch.c 自己持有，两个实例轮流读同一颗芯片会互相吃掉报点
     * （一个把 0x814E 状态读走，另一个就永远看不到按下）。
     * MUTE / MAIN 两个键本固件都没用到，所以只建需要的那一个。
     */
    const button_config_t btn_cfg = {0};
    const button_gpio_config_t gpio_cfg = {
        .gpio_num = BSP_BUTTON_CONFIG_IO,
        .active_level = 0,
    };
    button_handle_t btn = NULL;
    esp_err_t err = iot_button_new_gpio_device(&btn_cfg, &gpio_cfg, &btn);
    if (err != ESP_OK || btn == NULL) {
        ESP_LOGW(TAG, "CONFIG 键初始化失败: %s", esp_err_to_name(err));
        return;
    }
    iot_button_register_cb(btn, BUTTON_PRESS_DOWN, NULL, ptt_press, NULL);
    iot_button_register_cb(btn, BUTTON_PRESS_UP, NULL, ptt_release, NULL);
    ESP_LOGI(TAG, "按住 CONFIG 键说话，松开上传");
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

    /* 先把屏点亮、把静态首页画出来，再谈网络：宿主不在也要看得见。 */
    tihu_ui_init();
    tihu_ui_show_boot("连接中…");
    if (xTaskCreate(tihu_ui_task, "tihu_ui", TIHU_UI_TASK_STACK, NULL,
                    TIHU_UI_TASK_PRIO, NULL) != pdPASS) {
        ESP_LOGE(TAG, "UI 任务创建失败：屏幕会停在首帧");
    }

    tihu_audio_init();
    tihu_net_start();
    buttons_init();

    ESP_LOGI(TAG, "启动完成：UI 任务常驻（app_main 返回不影响屏幕与网络）");
}
