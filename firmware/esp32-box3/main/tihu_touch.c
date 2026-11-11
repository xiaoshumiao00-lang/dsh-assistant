/**
 * GT911 触摸：可重试初始化、读失败不重启、按下/抬起打点。
 *
 * 背景（2026-11-11 真机日志 build/serial_final.log）：
 *   I (2936) ESP-BOX-3: Setting LCD backlight: 100%
 *   E (3038) i2c.master: I2C transaction unexpected nack detected
 *   E (3071) GT911: esp_lcd_touch_gt911_read_data(232): I2C read error!
 *   ESP_ERROR_CHECK failed ... file: esp_lvgl_port/src/lvgl9/esp_lvgl_port_touch.c line 127
 *   abort() ... Rebooting...
 * 也就是：上电后第一次读触摸就 NACK，esp_lvgl_port 的 ESP_ERROR_CHECK 直接把板子重启，
 * 重启前屏已经画好，看起来像「按钮点了没反应」。
 *
 * 本文件不用 lvgl_port_add_touch，自己建 indev 并接管 read 回调：
 *   - 读失败 = 丢这一帧坐标 + 限频日志，绝不 abort；
 *   - 初始化最多 3 次（间隔 100 ms），全失败就降级为无触摸并打日志；
 *   - 每次按下/抬起/移动都往串口写 `touch: x=... y=... pressed ...`。
 */
#include "tihu_touch.h"

#include <stdint.h>

#include "bsp/esp-box-3.h"
#include "bsp/touch.h"
#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_lcd_touch.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "touch";

#define TOUCH_RETRY_MAX       3
#define TOUCH_RETRY_DELAY_MS  100
#define TOUCH_PROBE_MAX       5
#define TOUCH_MOVE_LOG_MS     120
#define TOUCH_FAIL_LOG_EVERY  200

/* GT911 寄存器：0x814E 状态（bit7=有数据，低 4 位=触点数），0x8150 起是第 1 点。 */
#define TOUCH_GT911_STATUS_REG 0x814E
#define TOUCH_GT911_POINT1_REG 0x8150

/*
 * INT 边沿探针：GT911 每检测到一次触摸都会把 INT 拉低（电平由 BSP 配成下降沿中断）。
 * 数一下这条线上的下降沿，就能把两种「点不动」彻底分开：
 *   - 边沿计数一直 0 → 控制器压根没检测到手指（面板/供电/芯片问题，软件无解）；
 *   - 边沿在涨但 0x814E 读不到数据 → 芯片报了，是我们的读取时序/寄存器问题。
 * 只装一个 ISR 计数，不参与点击逻辑，量产也不会影响行为。
 */
static volatile uint32_t s_int_edges;

static void IRAM_ATTR touch_int_isr(void *arg)
{
    (void)arg;
    s_int_edges++;
}

static void touch_int_probe_start(void)
{
    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "INT 探针：gpio_install_isr_service 失败 %s", esp_err_to_name(err));
        return;
    }
    err = gpio_set_intr_type(BSP_LCD_TOUCH_INT, GPIO_INTR_NEGEDGE);
    if (err == ESP_OK) {
        err = gpio_isr_handler_add(BSP_LCD_TOUCH_INT, touch_int_isr, NULL);
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "INT 探针已挂：GPIO%d 下降沿计数（每 5 秒一行日志里报）",
                 (int)BSP_LCD_TOUCH_INT);
    } else {
        ESP_LOGW(TAG, "INT 探针没挂上：%s", esp_err_to_name(err));
    }
}

static esp_lcd_touch_handle_t s_tp;
static lv_indev_t *s_indev;
static bool s_ready;
static volatile uint32_t s_read_fail;
static volatile uint32_t s_read_ok;
static volatile uint32_t s_press_count;
static uint8_t s_status_peak;
static int s_last_x = -1;
static int s_last_y = -1;
static int s_last_pressed;
static int s_last_move_log_ms;
static int s_last_report_ms;

static int touch_now_ms(void)
{
    return (int)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

uint32_t tihu_touch_read_fail_count(void)
{
    return s_read_fail;
}

uint32_t tihu_touch_read_ok_count(void)
{
    return s_read_ok;
}

uint32_t tihu_touch_press_count(void)
{
    return s_press_count;
}

bool tihu_touch_ready(void)
{
    return s_ready;
}

/**
 * LVGL 每次轮询（默认 30 ms 一次）都会调到这里。
 *
 * 关键点：esp_lcd_touch_read_data 失败时**只 return**，把 data->state 留在
 * RELEASED——LVGL 会认为手指抬起来了，这一帧没有点击，但程序继续跑。
 * 原来 lvgl_port_touchpad_read 里这里包着 ESP_ERROR_CHECK，才会 abort。
 */
static void touch_read_cb(lv_indev_t *indev, lv_indev_data_t *data)
{
    (void)indev;
    data->state = LV_INDEV_STATE_RELEASED;
    data->point.x = s_last_x >= 0 ? s_last_x : 0;
    data->point.y = s_last_y >= 0 ? s_last_y : 0;

    if (s_tp == NULL || s_tp->io == NULL) {
        return;
    }

    /*
     * 自己读寄存器，不走 esp_lcd_touch_read_data()：
     * 那个函数在「没有新数据」时也会往 0x814E 写 0 清状态（每 30 ms 一次），
     * 实测 30 ms 轮询下它读到的状态永远是 0x00，而同一时刻直接读 0x814E 能看到
     * 0x80（有数据）。这里改成「只有真的取到一帧才清状态」。
     */
    uint8_t status = 0;
    esp_err_t err = esp_lcd_panel_io_rx_param(s_tp->io, TOUCH_GT911_STATUS_REG,
                                              &status, 1);
    if (err != ESP_OK) {
        s_read_fail++;
        if (s_read_fail <= 5 || (s_read_fail % TOUCH_FAIL_LOG_EVERY) == 0) {
            ESP_LOGW(TAG, "GT911 读失败（第 %u 次）：%s；丢一帧坐标，不重启",
                     (unsigned)s_read_fail, esp_err_to_name(err));
        }
        return;
    }
    s_read_ok++;
    if (status > s_status_peak) {
        s_status_peak = status;
    }

    int now = touch_now_ms();
    bool pressed = false;
    int nx = 0;
    int ny = 0;

    if ((status & 0x80) && (status & 0x0F) > 0) {
        uint8_t point[8] = {0};
        err = esp_lcd_panel_io_rx_param(s_tp->io, TOUCH_GT911_POINT1_REG, point,
                                        sizeof(point));
        if (err == ESP_OK) {
            /* 原始字节一并打出来：GT911 的坐标可能是大端，也需要看有没有移位。
             * 解出来 (x,y) 落在 0..319/0..239 之外时，就靠这 8 个字节定位。 */
            ESP_LOGI(TAG, "GT911 原始点：%02X %02X %02X %02X %02X %02X %02X %02X（状态=0x%02X）",
                     point[0], point[1], point[2], point[3], point[4], point[5],
                     point[6], point[7], (unsigned)status);
            uint16_t x_le = (uint16_t)(point[1] | (point[2] << 8));
            uint16_t x_be = (uint16_t)((point[1] << 8) | point[2]);
            uint16_t y_le = (uint16_t)(point[3] | (point[4] << 8));
            uint16_t y_be = (uint16_t)((point[3] << 8) | point[4]);
            /* 哪个端序落在 320×240 里就用哪个，两个都超范围就按小端（BSP 驱动的约定）。 */
            bool le_ok = x_le < 320 && y_le < 240;
            bool be_ok = x_be < 320 && y_be < 240;
            if (!le_ok && be_ok) {
                nx = x_be;
                ny = y_be;
            } else {
                nx = x_le;
                ny = y_le;
            }
            pressed = true;
        } else {
            s_read_fail++;
            ESP_LOGW(TAG, "GT911 坐标读失败：%s", esp_err_to_name(err));
        }
    }
    /* 只有「这一帧真的处理完了」才写 0 清状态，让芯片重新开始下一帧。 */
    if (status & 0x80) {
        uint8_t clear = 0;
        esp_lcd_panel_io_tx_param(s_tp->io, TOUCH_GT911_STATUS_REG, &clear, 1);
    }

    /* 心跳：每 5 秒一行，证明 LVGL 在轮询、以及 GT911 见过的最高状态位。
     * 峰值一直是 0x00 → 芯片根本没报过数据（面板/供电/配置）；
     * 峰值 0x80 以上 → 芯片报了，问题在坐标解析或命中。 */
    if (now - s_last_report_ms >= 5000) {
        s_last_report_ms = now;
        ESP_LOGI(TAG, "轮询 %u 次（成功 %u 失败 %u），报点 %u 次，状态峰值=0x%02X，"
                      "INT边沿=%u INT电平=%d，最近=%d,%d",
                 (unsigned)(s_read_ok + s_read_fail), (unsigned)s_read_ok,
                 (unsigned)s_read_fail, (unsigned)s_press_count,
                 (unsigned)s_status_peak, (unsigned)s_int_edges,
                 gpio_get_level(BSP_LCD_TOUCH_INT),
                 s_last_x, s_last_y);
    }

    if (!pressed) {
        if (s_last_pressed) {
            ESP_LOGI(TAG, "touch: x=%d y=%d pressed 0", s_last_x, s_last_y);
        }
        s_last_pressed = 0;
        return;
    }

    s_press_count++;
    data->point.x = nx;
    data->point.y = ny;
    data->state = LV_INDEV_STATE_PRESSED;

    if (!s_last_pressed) {
        ESP_LOGI(TAG, "touch: x=%d y=%d pressed 1", nx, ny);
        s_last_move_log_ms = now;
    } else if ((nx != s_last_x || ny != s_last_y) &&
               now - s_last_move_log_ms >= TOUCH_MOVE_LOG_MS) {
        ESP_LOGI(TAG, "touch: x=%d y=%d pressed 1（移动）", nx, ny);
        s_last_move_log_ms = now;
    }
    s_last_x = nx;
    s_last_y = ny;
    s_last_pressed = 1;
}

static bool touch_create(void)
{
    for (int attempt = 1; attempt <= TOUCH_RETRY_MAX; attempt++) {
        esp_err_t err = bsp_touch_new(NULL, &s_tp);
        if (err == ESP_OK && s_tp != NULL) {
            ESP_LOGI(TAG, "GT911 初始化成功（第 %d/%d 次）", attempt, TOUCH_RETRY_MAX);
            return true;
        }
        ESP_LOGW(TAG, "GT911 初始化失败（第 %d/%d 次）：%s；%d ms 后重试",
                 attempt, TOUCH_RETRY_MAX, esp_err_to_name(err), TOUCH_RETRY_DELAY_MS);
        s_tp = NULL;
        if (attempt < TOUCH_RETRY_MAX) {
            vTaskDelay(pdMS_TO_TICKS(TOUCH_RETRY_DELAY_MS));
        }
    }
    return false;
}

/*
 * 上机诊断：把 GT911 的关键寄存器打出来。
 *
 * 0x814E 状态一直是 0x00（bit7=有数据）＝控制器根本没检测到手指，
 * 这时候再怎么改 LVGL 都没用，必须看芯片自己的配置有没有复位/休眠。
 *   0x8040 命令寄存器（0x05=进睡眠）
 *   0x8047 配置版本；0x8048/49 Xmax；0x804A/4B Ymax；0x804C 触点数
 *   0x804D/4E 模块开关；0x8055 低功耗控制；0x8056 刷新率
 */
static void touch_dump_registers(const char *why)
{
    if (s_tp == NULL || s_tp->io == NULL) {
        return;
    }
    uint8_t cmd = 0;
    uint8_t cfg[24] = {0};
    esp_err_t e1 = esp_lcd_panel_io_rx_param(s_tp->io, 0x8040, &cmd, 1);
    esp_err_t e2 = esp_lcd_panel_io_rx_param(s_tp->io, 0x8047, cfg, sizeof(cfg));
    uint8_t status = 0;
    esp_lcd_panel_io_rx_param(s_tp->io, 0x814E, &status, 1);
    if (e1 != ESP_OK || e2 != ESP_OK) {
        ESP_LOGW(TAG, "GT911 寄存器读取失败（%s）：cmd=%s cfg=%s",
                 why, esp_err_to_name(e1), esp_err_to_name(e2));
        return;
    }
    ESP_LOGI(TAG, "GT911 寄存器（%s）：命令=0x%02X 状态=0x%02X 配置版=%u "
                  "Xmax=%u Ymax=%u 触点数=%u 开关1=0x%02X 开关2=0x%02X "
                  "低功耗=0x%02X 刷新=%u",
             why, (unsigned)cmd, (unsigned)status, (unsigned)cfg[0],
             (unsigned)(cfg[1] | (cfg[2] << 8)), (unsigned)(cfg[3] | (cfg[4] << 8)),
             (unsigned)cfg[5], (unsigned)cfg[6], (unsigned)cfg[7],
             (unsigned)cfg[14], (unsigned)cfg[15]);
}

static void touch_from_sleep(void)
{
    if (s_tp == NULL) {
        return;
    }
    ESP_LOGI(TAG, "GT911 唤醒：拉一次 INT（esp_lcd_touch_exit_sleep），50 ms 后再看状态");
    esp_err_t err = esp_lcd_touch_exit_sleep(s_tp);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "GT911 唤醒失败：%s", esp_err_to_name(err));
    }
    vTaskDelay(pdMS_TO_TICKS(50));
    touch_dump_registers("唤醒后");
}

/**
 * 关于「给 GT911 打硬件复位」的实验结论（2026-11-11，别再走这条弯路）：
 *
 * BSP 的 touch 配置里 rst_gpio_num = NC（RST 与 LCD 共用 GPIO48），驱动从不复位
 * 触摸芯片，所以曾尝试按手册补一次「INT 低 + RST 低脉冲」。实测结果更糟：复位后
 * GT911 直接不应答 I2C（bsp_touch_new 连续 3 次 ESP_ERR_NOT_FOUND），屏还在、
 * 触摸彻底没了。结论：**不要碰 GPIO48/GPIO3 的复位时序**，保持 BSP 的上电状态。
 */

bool tihu_touch_init(lv_display_t *disp)
{
    if (!touch_create()) {
        ESP_LOGE(TAG, "触摸降级：GT911 连续 %d 次初始化失败，本次启动没有触摸；"
                      "屏照常可用，按钮只能由宿主（工具/语音）触发",
                 TOUCH_RETRY_MAX);
        return false;
    }

    /* 上电第一次读经常 NACK（GT911 配置刚灌完）。先在这里吃掉并重试，
     * 不让它成为 LVGL 任务里的第一帧读。 */
    touch_dump_registers("初始化后");
    touch_from_sleep();
    for (int i = 1; i <= TOUCH_PROBE_MAX; i++) {
        uint8_t status = 0;
        esp_err_t err = esp_lcd_panel_io_rx_param(s_tp->io, TOUCH_GT911_STATUS_REG,
                                                  &status, 1);
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "触摸读探测通过（第 %d/%d 次）：0x814E=0x%02X", i, TOUCH_PROBE_MAX,
                     (unsigned)status);
            break;
        }
        ESP_LOGW(TAG, "触摸读探测失败（%d/%d）：%s；%d ms 后重试",
                 i, TOUCH_PROBE_MAX, esp_err_to_name(err), TOUCH_RETRY_DELAY_MS);
        if (i == TOUCH_PROBE_MAX) {
            ESP_LOGW(TAG, "触摸读探测仍未通过：照常注册 indev，读失败只在点击时打日志");
        }
        vTaskDelay(pdMS_TO_TICKS(TOUCH_RETRY_DELAY_MS));
    }

    if (disp == NULL) {
        ESP_LOGE(TAG, "触摸降级：没有 LVGL display，无法注册 indev");
        return false;
    }

    /* LVGL 的 timer/对象表不是线程安全的：创建 indev 要拿 BSP 的递归锁。 */
    if (!bsp_display_lock(pdMS_TO_TICKS(1000))) {
        ESP_LOGE(TAG, "触摸降级：拿不到 LVGL 锁，无法注册 indev");
        return false;
    }
    s_indev = lv_indev_create();
    if (s_indev == NULL) {
        bsp_display_unlock();
        ESP_LOGE(TAG, "触摸降级：lv_indev_create 失败（内存不足？）");
        return false;
    }
    lv_indev_set_type(s_indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(s_indev, touch_read_cb);
    lv_indev_set_display(s_indev, disp);
    bsp_display_unlock();
    touch_int_probe_start();
    s_ready = true;
    ESP_LOGI(TAG, "触摸就绪：indev=%p disp=%p（自注册 read 回调；读失败只丢帧不重启）",
             (void *)s_indev, (void *)disp);
    return true;
}
