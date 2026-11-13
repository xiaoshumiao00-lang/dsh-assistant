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
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "iot_button.h"
#include "nvs_flash.h"
#include "tihu_audio.h"
#include "tihu_net.h"
#include "tihu_ota.h"
#include "tihu_volume.h"
#include "tihu_wake.h"
#include "ui.h"
#include "bsp/esp-box-3.h"

static const char *TAG = "tihu_main";
static bool s_ptt_active;
/** 本次按住因为「麦克风未就绪」没开麦：松手时只收屏，不做 mic_stop/上传。 */
static bool s_ptt_mic_failed;

#define TIHU_UI_TASK_STACK   (12 * 1024)
#define TIHU_UI_TASK_PRIO    3
#define TIHU_UI_TICK_MS      10
#define TIHU_MEMLOG_MS       10000   /* 内存水位日志间隔（10 s） */

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
        if ((loops % (TIHU_MEMLOG_MS / TIHU_UI_TICK_MS)) == 0) {
            unsigned flush = tihu_ui_flush_count();
            /* 每 10 秒一条内存水位：内部堆/最大连续块/历史最低 + PSRAM，掉得下去就是泄漏。 */
            ESP_LOGI(TAG, "内存水位：内部堆 %u B（最大块 %u B，最低 %u B）/ PSRAM %u B（最大块 %u B，最低 %u B）；"
                          "UI handler=%u flush=%u(+%u)",
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
                     loops, flush, flush - last_flush);
            last_flush = flush;
        }
        vTaskDelay(pdMS_TO_TICKS(TIHU_UI_TICK_MS));
    }
}

/*
 * 按住 CONFIG 键说话。
 *
 * ⚠ 这两个回调**跑在 esp_timer 任务里**（iot_button 用 esp_timer 每 5 ms 轮询按键，
 * dispatch_method = ESP_TIMER_TASK），WS 心跳、录音收尾、音量小条、OTA 定时全排在
 * 同一个任务上。所以顺序铁律是：
 *   1) 先给屏上反馈、先给宿主发自证 alert（短操作、有界超时）；
 *   2) 再做停声/开麦这类可能慢的事；
 *   3) 任何一步失败都必须留下看得见的痕迹，不允许静默 return。
 *
 * 0.3.9：屏上反馈**无条件先出现**——只要检测到按下就先显示「在听 · 请说话」，
 * 麦克风没准备好再改成「麦克风未就绪」。0.3.8 是先开麦再上屏，于是「开麦那步卡住」
 * 和「根本没按到」在屏上、在宿主侧长得一模一样，这正是这次排查最贵的那段成本。
 */

/*
 * 语音唤醒（0.6.0）：板内 ESP-SR WakeNet9 中文唤醒词「嗨，乐鑫」（wn9_hilexin）。
 *
 * 0.5.0 是「没人按键时循环录 1.8 s → 发给宿主 /tihu/wake 判是不是鹈鹕」，
 * 依赖网络与宿主；0.6.0 把模型和推理都搬到板子上：tihu_wake.c 常驻跑 AFE+WakeNet，
 * 命中后先叮一声，再直接调用下面的 voice_command_record()（屏上「在听 · 请说话」
 * + 录 5 秒 + tihu_net_send_wav 上传），整条链路不再问宿主。
 *
 * 原 wake_task / WAKE_PROBE_MS 那段 HTTP 轮询已删除；tihu_ota_wake_check() 保留但不再调用。
 */
#define WAKE_COMMAND_MS   5000

static void voice_command_record(void)
{
    tihu_ui_set_listening(true, "在听 · 请说话");
    tihu_net_send_alert("info", "语音唤醒 鹈鹕");
    if (!tihu_audio_mic_start()) {
        ESP_LOGW(TAG, "唤醒后开麦失败");
        tihu_ui_set_listening(false, NULL);
        return;
    }
    vTaskDelay(pdMS_TO_TICKS(WAKE_COMMAND_MS));
    tihu_ui_set_listening(false, NULL);
    size_t len = 0;
    const uint8_t *wav = tihu_audio_mic_stop(&len);
    if (wav != NULL && len > 44) {
        ESP_LOGI(TAG, "语音命令录音结束：%u 字节", (unsigned)len);
        tihu_net_send_wav(wav, len);
    } else {
        ESP_LOGW(TAG, "语音唤醒后没录到音频");
    }
}


/*
 * 0.6.3：按住说话的开麦任务 —— 先「叮」，播完再切 16 k 开麦。
 *
 * 为什么必须是独立任务：ptt_press 跑在 esp_timer 任务里，阻塞 100+ ms 会吞掉抬手事件；
 * 而「叮」本身要 120 ms 才播完，播到一半切 16 k 会变成闷响，麦克风也会把它录进去。
 * 抬手早于开麦（极短一按）就干脆不录，免得麦克风在后面一直开着。
 */
static void ptt_ding_task(void *arg)
{
    (void)arg;
    tihu_audio_play_ding();
    /* 叮是 120 ms；播放任务由 push 之后才 busy，先等一小会儿再等排空。 */
    vTaskDelay(pdMS_TO_TICKS(60));
    for (int i = 0; i < 25 && tihu_audio_busy(); i++) {
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    if (!s_ptt_active) {
        ESP_LOGW(TAG, "抬手早于开麦：本次不录音（提示音已播完）");
        vTaskDelete(NULL);
        return;
    }
    if (!tihu_audio_mic_start()) {
        /* 麦克风没就绪：屏上必须说清楚，并给宿主发同样的告警，不许按下了毫无提示。 */
        tihu_ui_set_listening(true, "麦克风未就绪");
        ESP_LOGE(TAG, "按键按下但麦克风未就绪：本次不录音（松开也不会上传）");
        tihu_net_send_alert("warn", "麦克风未就绪");
        /* 仍然让 s_ptt_active 留着：松手时要靠 release 把「麦克风未就绪」覆盖层收掉。 */
        s_ptt_mic_failed = true;
    }
    vTaskDelete(NULL);
}

static void ptt_press(void *handle, void *usr_data)
{
    (void)handle;
    (void)usr_data;
    if (s_ptt_active) {
        return;
    }
    s_ptt_active = true;

    /* 1) 屏上先出「在听」，不依赖 codec/I2C/WS 任何一步。 */
    tihu_ui_set_listening(true, "在听 · 请说话");
    /* 2) 自证：宿主日志里出现这一行 = 按键回调真的跑到了。 */
    ESP_LOGI(TAG, "按键按下 录音开始");
    tihu_net_send_alert("info", "按键按下 录音开始");

    /* 按住说话优先于宿主 voice.listen 的自动收尾，避免录到一半被定时器截走。 */
    tihu_net_cancel_listen();
    /* 录音前先停声：BOX-3 的 speaker/mic 共用 I2S，24k 与 16k 同时开容易把声音带偏。 */
    tihu_audio_stop();

    /*
     * 0.6.3：按下去先「叮」一声（用户 2026-11-13 明确要求录音提示音），
     * 等它播完再切 16 k 开麦 —— 反过来会把 24 k 的叮按 16 k 播成闷响，
     * 而且麦克风一开，提示音自己也会被录进上行 WAV。
     *
     * 为什么放独立任务：本回调跑在 esp_timer 任务里（iot_button 每 5 ms 轮询按键），
     * 在这里阻塞 100+ ms 会吞掉抬手事件，所以「叮 + 排空 + 开麦」整体挪出去。
     */
    if (xTaskCreate(ptt_ding_task, "ptt_ding", 4096, NULL, 5, NULL) != pdPASS) {
        ESP_LOGW(TAG, "叮：任务创建失败，退回直接开麦");
        if (!tihu_audio_mic_start()) {
            tihu_ui_set_listening(true, "麦克风未就绪");
            ESP_LOGE(TAG, "按键按下但麦克风未就绪：本次不录音（松开也不会上传）");
            tihu_net_send_alert("warn", "麦克风未就绪");
            s_ptt_mic_failed = true;
        }
    }
}

static void ptt_release(void *handle, void *usr_data)
{
    (void)handle;
    (void)usr_data;
    if (!s_ptt_active) {
        return;
    }
    s_ptt_active = false;
    ESP_LOGI(TAG, "按键松开 上传中");
    tihu_net_send_alert("info", "按键松开 上传中");
    /* 先收屏，再等录音任务交数据（mic_stop 最多等 1.5 s）。 */
    tihu_ui_set_listening(false, NULL);
    if (s_ptt_mic_failed) {
        s_ptt_mic_failed = false;
        ESP_LOGW(TAG, "本次按下没有开麦（已有「麦克风未就绪」告警），松开不发送");
        return;
    }
    size_t len = 0;
    const uint8_t *wav = tihu_audio_mic_stop(&len);
    if (wav != NULL && len > 44) {
        ESP_LOGI(TAG, "录音结束：%u 字节（约 %d ms）",
                 (unsigned)len, (int)(((len - 44) * 1000) / (16000 * 2)));
        tihu_net_send_wav(wav, len);
    } else {
        ESP_LOGW(TAG, "没有录到音频（麦克风未初始化或按得太短）");
        tihu_net_send_alert("warn", "没有录到音频");
    }
}

/*
 * 开机自检：启动 5 秒后程序化点一下完成页的「停止」按钮。
 *
 * 现场没人按按钮，所以用它证明「触摸/按钮链路到宿主是通的」：
 * 走的是和真手指完全相同的回调（lv_obj_send_event → done_btn_cb → screen.gesture），
 * 串口会有三行关键：`按钮命中 actionId=stop`、`screen.gesture 发送结果=成功`、
 * `自检回执 type=event.progress`（宿主对 stop 的回包）。
 *
 * 5 秒时 Wi-Fi 可能还没连上宿主（第一次发送会失败并打日志），所以失败就每 10 秒再试，
 * 最多 12 次；成功一次后等 6 秒收宿主回包就收工，全程只打日志、不改屏上内容。
 */
static void selftest_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(5000));
    ESP_LOGW(TAG, "=== 开机自检：5 秒到，模拟点一下完成页「停止」（actionId=stop）===");
    tihu_net_watch_selftest(true);
    bool sent = false;
    for (int attempt = 1; attempt <= 12 && !sent; attempt++) {
        int64_t began = esp_timer_get_time();
        sent = tihu_ui_simulate_action(0);
        int cost_ms = (int)((esp_timer_get_time() - began) / 1000);
        ESP_LOGI(TAG, "开机自检第 %d/12 次：screen.gesture %s（耗时 %d ms，WS %s）",
                 attempt, sent ? "已发出" : "未发出", cost_ms,
                 tihu_net_connected() ? "已连接" : "未连接");
        if (!sent) {
            vTaskDelay(pdMS_TO_TICKS(10000));
        }
    }
    if (sent) {
        ESP_LOGI(TAG, "开机自检：已发出，等宿主 ack 6 秒（看下面「自检回执」行）");
        vTaskDelay(pdMS_TO_TICKS(6000));
        ESP_LOGI(TAG, "开机自检结束：见上方 自检回执 type=...");
    } else {
        ESP_LOGW(TAG, "开机自检结束：12 次都没发出去（一直没连上宿主）");
    }
    tihu_net_watch_selftest(false);
    vTaskDelete(NULL);
}

static void buttons_init(void)
{
    /*
     * 只建 CONFIG 键（GPIO0），不走 bsp_iot_button_create()。
     *
     * 原因：BOXS-3 的按键表里 BSP_BUTTON_MAIN 是 GT911 上的「触摸主页键」，
     * bsp_iot_button_create() 在 BSP 的静态 tp 为空时会**再 new 一个 GT911 实例**。
     * 现在触摸由 tihu_touch.c 自己持有，两个实例轮流读同一颗芯片会互相吃掉报点
     * （一个把 0x814E 状态读走，另一个就永远看不到按下）。
     * MAIN 键本固件没用到；外壳静音触摸区（GPIO1 = BSP_BUTTON_MUTE_IO）由
     * tihu_volume.c 自己配 GPIO + 判手势（单击静音 / 双击复位 85 / 长按连续变音量）。
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
    /*
     * 板内唤醒词（0.6.0）：ESP-SR WakeNet9「嗨，乐鑫」，模型编在 app 分区里。
     * 必须在 tihu_net_start() 之后启动——没联网时唤醒任务不会开麦。
     * 命中后由 tihu_wake 任务先叮一声，再直接调用 voice_command_record()。
     */
    tihu_wake_start(voice_command_record);
    /* OTA 客户端：独立任务 + 10 分钟定时；没联网时自己打「尚未联网，跳过」。
     * 放在 tihu_net_start() 之后，宿主地址一旦被 tihu_net 解析出来就会同步进去。 */
    tihu_ota_start();
    buttons_init();
    /* 机身外壳静音触摸区（GPIO1）→ 音量手势；放在 audio 之后，改音量才有 codec 可写。 */
    tihu_volume_start();
    if (xTaskCreate(selftest_task, "tihu_selftest", 4096, NULL, 3, NULL) != pdPASS) {
        ESP_LOGW(TAG, "开机自检任务创建失败（不影响正常使用）");
    }

    ESP_LOGI(TAG, "启动完成：UI 任务常驻（app_main 返回不影响屏幕与网络）");
}
