/**
 * GT911 触摸初始化 + LVGL indev（自带 read 回调）。
 *
 * 为什么不直接用 esp_lvgl_port 的 lvgl_port_add_touch：
 *   它的 read 回调里 `ESP_ERROR_CHECK(esp_lcd_touch_read_data(...))`
 *   （managed_components/espressif__esp_lvgl_port/src/lvgl9/esp_lvgl_port_touch.c:127）
 *   一旦 GT911 在某次读里回 NACK（实测上电后第一次读必现），就会 abort() 重启整块板子，
 *   而且重启前屏已经画出来了——现场看就是「点一下没反应，板子悄悄重启」。
 *
 * 这里的策略：
 *   1) 初始化可重试：最多 3 次、间隔 100 ms；仍失败就降级为「无触摸」，只打日志不重启；
 *   2) 读失败只丢这一帧坐标（打日志、限频），LVGL 继续跑，屏不黑、板子不重启；
 *   3) 每次按下/抬起都打 `touch: x=... y=... pressed ...`，按一下串口就能看出有没有报点。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "lvgl.h"

/** 初始化 GT911 并注册 LVGL indev。失败返回 false（降级为无触摸，不重启）。 */
bool tihu_touch_init(lv_display_t *disp);

/** 触摸是否可用（初始化成功）。 */
bool tihu_touch_ready(void);

/** 累计读失败次数 / 读成功次数 / 报点（按下）次数（串口探针用）。 */
uint32_t tihu_touch_read_fail_count(void);
uint32_t tihu_touch_read_ok_count(void);
uint32_t tihu_touch_press_count(void);
