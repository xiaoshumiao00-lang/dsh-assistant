/**
 * 机身外壳静音触摸区 → 音量手势（0.3.6）。
 *
 * ── 硬件结论（先查清楚再写，别硬编）────────────────────────────────────────
 * ESP32-S3-BOX-3 的外壳触摸区就是 **GPIO_NUM_1**：
 *   - `main/../managed_components/espressif__esp-box-3/include/bsp/esp-box-3.h`
 *     里同一个管脚有两个名字：`BSP_BUTTON_MUTE_IO (GPIO_NUM_1)`（按键表里
 *     `.active_level = 0`，低电平＝按下）和 `BSP_MUTE_STATUS (GPIO_NUM_1)`，
 *     注释原文「Mute: This button is wired to Logic Gates and its result is mapped
 *     to GPIO_NUM_1」——触摸区的信号经板上逻辑门后落到 GPIO1。
 *   - 它和屏幕里那个红圆圈完全是两条通道：红圈是 GT911 电容触摸（I2C 0x5D/0x14），
 *     归 esp_lcd_touch 管，见 tihu_touch.c。
 *   - **不能**用 `bsp_iot_button_create()`：那张按键表里还有 `BSP_BUTTON_MAIN`
 *     （GT911 上的虚拟主页键），BSP 会为它再 new 一个 GT911 实例把触摸状态位抢走
 *     （2026-11-11 实机踩过）。所以这里只碰 GPIO1，自己配 GPIO + 自己判手势。
 *
 * ── 为什么自己轮询而不是 iot_button ─────────────────────────────────────
 * 要求里有「按住不放连续变音量、松手定格」，iot_button 的 LONG_PRESS_HOLD 是事件
 * 回调，做连续步进还要再挂一个定时器；直接 20 ms 读电平最直白，也省一次注册。
 */
#include "tihu_volume.h"

#include <stdio.h>

#include "config.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "tihu_audio.h"
#include "ui.h"
#include "bsp/esp-box-3.h"

static const char *TAG = "tihu_vol";

#define VOL_TASK_STACK     3072
/*
 * 0.3.9：优先级从 4 降到 2——它只读一个 GPIO，不该压在 UI(3)/录音(6) 前面。
 * 0.3.6 的 4 比 UI 任务高，真机上若这条线锁死在低电平，长按斜坡每 100 ms
 * 抢一次 CPU/显示锁，屏上反馈（「在听」覆盖层）会被拖慢。
 */
#define VOL_TASK_PRIO      2
#define VOL_POLL_MS        20    /* 20 ms 轮询：够快，也远小于 100 ms 的步进 */
/*
 * 单次长按最多连续变 15 s（≈ 从 85 降到底 + 升到 100 + 再降回 85 的一整圈）就自己定格。
 * 两个用途：一是给「按住不放」一个明确的停止点，二是万一这条线在真机上是锁存的静音状态
 * 而不是按下电平（松手也不回高），最多扫一圈就停，不会无限循环下去。
 */
#define VOL_RAMP_MAX_MS    15000
/** 单击待定窗口：松手后 330 ms 没有第二次按下，就按单击（静音/取消静音）处理。 */
#define VOL_CLICK_WAIT_MS  330

static int s_volume = TIHU_VOL_DEFAULT;   /* 逻辑音量 0–100 */
static bool s_muted;
static int s_pre_mute = TIHU_VOL_DEFAULT;

/* 手势状态机（只在 vol_task 里改，别的任务只读 s_volume/s_muted） */
static bool s_pressed;
static int64_t s_press_at_ms;
static int64_t s_last_step_ms;
static bool s_ramping;
static int s_ramp_dir = -1;               /* 先向下 */
static bool s_ramp_warned;                /* 本次按下已经因为「超时保护」定格过：不再重新开坡 */
static int64_t s_pending_click_ms;        /* >0 = 单击待定，等双击窗口过去再生效 */
static int64_t s_last_short_release_ms;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void save_volume(void)
{
    nvs_handle_t h;
    if (nvs_open("tihu", NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "音量保存失败：NVS 打不开");
        return;
    }
    esp_err_t err = nvs_set_i32(h, "volume", s_volume);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "音量保存失败: %s", esp_err_to_name(err));
    }
}

static void load_volume(void)
{
    nvs_handle_t h;
    if (nvs_open("tihu", NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    int32_t v = TIHU_VOL_DEFAULT;
    if (nvs_get_i32(h, "volume", &v) == ESP_OK && v >= 0 && v <= 100) {
        s_volume = (int)v;
    }
    nvs_close(h);
}

/** 把「逻辑音量 + 静音状态」落到 codec：静音时真的写 0，不是只记标志。 */
static void apply_volume(bool toast)
{
    tihu_audio_set_volume(s_muted ? 0 : s_volume);
    if (toast) {
        tihu_ui_show_volume(s_volume, s_muted);
    }
}

static void toggle_mute(void)
{
    if (!s_muted) {
        s_pre_mute = s_volume > 0 ? s_volume : TIHU_VOL_DEFAULT;
        s_muted = true;
        tihu_audio_set_volume(0);
        ESP_LOGI(TAG, "单击：静音（codec 输出=0，静音前音量=%d）", s_pre_mute);
    } else {
        s_muted = false;
        s_volume = s_pre_mute > 0 ? s_pre_mute : TIHU_VOL_DEFAULT;
        tihu_audio_set_volume(s_volume);
        ESP_LOGI(TAG, "单击：取消静音，音量回到 %d", s_volume);
    }
    tihu_ui_show_volume(s_volume, s_muted);
}

static void reset_default_volume(void)
{
    bool was_muted = s_muted;
    s_muted = false;
    s_volume = TIHU_VOL_DEFAULT;
    tihu_audio_set_volume(s_volume);
    save_volume();
    ESP_LOGI(TAG, "双击：恢复默认音量 %d%s", s_volume, was_muted ? "（同时取消静音）" : "");
    tihu_ui_show_volume(s_volume, false);
}

/** 长按开始：先解除静音（否则连续调音量听不出变化），方向从当前向下。 */
static void ramp_begin(void)
{
    if (s_muted) {
        s_muted = false;
        s_volume = s_pre_mute > 0 ? s_pre_mute : TIHU_VOL_DEFAULT;
        ESP_LOGI(TAG, "长按：先取消静音，从音量 %d 开始", s_volume);
    }
    s_ramping = true;
    s_ramp_dir = -1;
    s_last_step_ms = now_ms();
    ESP_LOGI(TAG, "长按开始：从音量 %d 向下，%d ms/步 × %d 点（到 0 后折返 100，往返循环）",
             s_volume, TIHU_VOL_STEP_MS, TIHU_VOL_STEP);
    tihu_ui_show_volume(s_volume, s_muted);
}
/** 走一步：到 0 或 100 各停一拍再折返，听感上就是连续来回扫。 */
static void ramp_step(void)
{
    if (s_ramp_dir < 0) {
        if (s_volume <= 0) {
            s_ramp_dir = 1;                       /* 已经在 0：这一拍折返向上 */
        } else {
            s_volume = (s_volume - TIHU_VOL_STEP < 0) ? 0 : s_volume - TIHU_VOL_STEP;
        }
    } else {
        if (s_volume >= 100) {
            s_ramp_dir = -1;                      /* 已经在 100：这一拍折返向下 */
        } else {
            s_volume = (s_volume + TIHU_VOL_STEP > 100) ? 100 : s_volume + TIHU_VOL_STEP;
        }
    }
    apply_volume(true);
}

static void ramp_end(const char *why)
{
    if (!s_ramping) {
        return;
    }
    s_ramping = false;
    save_volume();
    ESP_LOGI(TAG, "长按结束（%s）：定格在音量 %d 并已保存", why, s_volume);
    tihu_ui_show_volume(s_volume, s_muted);
}

/** 单击/双击的落地：单击晚 350 ms 生效，给双击留判断窗口。 */
static void run_pending_click(void)
{
    s_pending_click_ms = 0;
    toggle_mute();
}

static void vol_task(void *arg)
{
    (void)arg;
    for (;;) {
        int64_t t = now_ms();
        bool down = gpio_get_level(BSP_BUTTON_MUTE_IO) == 0;   /* active_level=0 */

        if (down && !s_pressed) {
            s_pressed = true;
            s_press_at_ms = t;
            s_ramp_warned = false;
            /* 又按下了：上一次单击作废，等这次松手再判单击还是双击。 */
            s_pending_click_ms = 0;
        } else if (down && s_pressed) {
            int64_t held = t - s_press_at_ms;
            if (!s_ramping && !s_ramp_warned && held >= TIHU_VOL_LONG_PRESS_MS) {
                ramp_begin();
            } else if (s_ramping && (t - s_last_step_ms) >= TIHU_VOL_STEP_MS) {
                s_last_step_ms = t;
                if (held > VOL_RAMP_MAX_MS) {
                    /*
                     * 兜底（日志限速：一次按下只说一次）：真机上这条线若是锁存的静音状态
                     * 而不是按下电平，松手也不会回高。0.3.9 起定格一次就置 s_ramp_warned，
                     * 不再「定格→立刻重新开坡」地空转（0.3.6 会在这种锁存场景下每 100 ms
                     * 抢一次 CPU 和显示锁，屏上「在听」覆盖层因此可能迟迟不出现）。
                     */
                    if (!s_ramp_warned) {
                        s_ramp_warned = true;
                        ESP_LOGW(TAG, "长按已连续变化 %d ms，强制定格（若松手后电平仍为低，"
                                      "说明这条线是锁存状态而非按下电平；本次按下不再继续）",
                                 VOL_RAMP_MAX_MS);
                    }
                    ramp_end("超时保护");
                } else {
                    ramp_step();
                }
            }
        } else if (!down && s_pressed) {
            s_pressed = false;
            int64_t dur = t - s_press_at_ms;
            if (s_ramping) {
                ramp_end("松手");
            } else if (dur < TIHU_VOL_LONG_PRESS_MS) {
                if (s_last_short_release_ms > 0 && (t - s_last_short_release_ms) <= TIHU_VOL_DOUBLE_MS) {
                    s_last_short_release_ms = 0;
                    reset_default_volume();
                } else {
                    s_last_short_release_ms = t;
                    s_pending_click_ms = t;
                }
            }
        }

        /* 单击待定超时 → 真的当单击处理（静音/取消静音）。 */
        if (s_pending_click_ms > 0 && (t - s_pending_click_ms) >= VOL_CLICK_WAIT_MS) {
            run_pending_click();
        }

        vTaskDelay(pdMS_TO_TICKS(VOL_POLL_MS));
    }
}

/*
 * 编译期硬护栏：这个模块**只许碰 GPIO1**（外壳静音触摸区）。
 * 按住说话用的是 GPIO0（iot_button 管的 CONFIG 键），一旦两者是同一根线，音量手势
 * 就会和按键抢线，「按了没反应」正是这么来的那类事故。宁可编不过。
 *
 * 注意写成 _Static_assert 而不是 #if：GPIO_NUM_x 是枚举常量而不是宏，
 * 在 #if 里会被当成 0，于是恒等于「相等」，护栏会误报（0.3.9 首次编译就踩到）。
 */
_Static_assert(BSP_BUTTON_MUTE_IO != BSP_BUTTON_CONFIG_IO,
               "tihu_volume.c 只许操作 GPIO1（BSP_BUTTON_MUTE_IO），不能与 CONFIG 键同脚");

void tihu_volume_start(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << BSP_BUTTON_MUTE_IO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&io);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "GPIO%d 配置失败: %s（音量手势不可用）", BSP_BUTTON_MUTE_IO, esp_err_to_name(err));
        return;
    }

    load_volume();
    s_muted = false;
    s_pre_mute = s_volume;
    tihu_audio_set_volume(s_volume);

    /*
     * 开机就为低电平 = 触摸区这条线当前是「静音」状态（说明它带锁存/状态语义）。
     * 记一条日志：真机上如果长按松手后电平不回高，就是这里先警告过的那种情况。
     */
    int boot_level = gpio_get_level(BSP_BUTTON_MUTE_IO);
    if (boot_level == 0) {
        ESP_LOGW(TAG, "GPIO%d 开机即为低电平：触摸区当前处于静音状态（这条线带锁存语义）",
                 BSP_BUTTON_MUTE_IO);
    }

    if (xTaskCreate(vol_task, "tihu_vol", VOL_TASK_STACK, NULL, VOL_TASK_PRIO, NULL) != pdPASS) {
        ESP_LOGE(TAG, "音量任务创建失败");
        return;
    }
    ESP_LOGI(TAG, "音量手势就绪：GPIO%d（外壳静音触摸区，active_low）；当前音量=%d，"
                  "默认=%d，长按 %d ms 起连续变化（%d ms/步 × %d），双击 %d ms 内",
             BSP_BUTTON_MUTE_IO, s_volume, TIHU_VOL_DEFAULT,
             TIHU_VOL_LONG_PRESS_MS, TIHU_VOL_STEP_MS, TIHU_VOL_STEP, TIHU_VOL_DOUBLE_MS);
}

int tihu_volume_get(void)
{
    return s_volume;
}

bool tihu_volume_muted(void)
{
    return s_muted;
}
