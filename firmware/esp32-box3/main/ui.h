/**
 * 320×240 LVGL 三屏：棋盘 / 进度 / 完成。
 *
 * 所有 LVGL 调用都由本模块内部加 bsp_display_lock；网络回调和按键回调可以
 * 直接调 tihu_ui_*，不需要自己加锁。
 */
#pragma once

#include <stdbool.h>

#include "lvgl.h"
#include "tihu_protocol.h"

/* 对外 */
void tihu_ui_init(void);
/* boot 后的静态首页：不依赖宿主，标题「鹈鹕 BOX-3B」+ 状态行 + 底部两键。 */
void tihu_ui_show_boot(const char *status);
/* flush 回调被调用的累计次数（探针在 tihu_ui_init 里挂到 LVGL display 上）。 */
unsigned tihu_ui_flush_count(void);
bool tihu_ui_ready(void);
void tihu_ui_show_frame(const tihu_screen_frame_t *frame);
void tihu_ui_set_connection(bool connected, const char *text);
void tihu_ui_set_listening(bool on, const char *prompt);
void tihu_ui_show_alert(const char *text);
const char *tihu_ui_stage_name(void);
const char *tihu_ui_connection_text(void);
bool tihu_ui_connected(void);

/* 三个屏的创建/刷新（只在 ui.c 里调用，头文件集中声明，避免跨文件 extern） */
lv_obj_t *tihu_ui_board_create(lv_obj_t *parent);
void tihu_ui_board_update(lv_obj_t *screen, const tihu_screen_frame_t *frame);

lv_obj_t *tihu_ui_progress_create(lv_obj_t *parent);
void tihu_ui_progress_update(lv_obj_t *screen, const tihu_screen_frame_t *frame);

lv_obj_t *tihu_ui_done_create(lv_obj_t *parent);
void tihu_ui_done_update(lv_obj_t *screen, const tihu_screen_frame_t *frame);

/* 共用样式 */
const lv_font_t *tihu_ui_font_title(void);
const lv_font_t *tihu_ui_font_body(void);
lv_color_t tihu_ui_tone_color(const char *tone);
lv_color_t tihu_ui_state_color(const char *state);
void tihu_ui_apply_tone_bar(lv_obj_t *bar, const char *tone);
lv_obj_t *tihu_ui_label(lv_obj_t *parent, const char *text, const lv_font_t *font,
                        lv_color_t color, lv_coord_t x, lv_coord_t y,
                        lv_coord_t width, lv_coord_t height);
void tihu_ui_send_action(const char *action_id, const char *task_id,
                         lv_obj_t *origin);
