/**
 * 三屏容器与共用样式。
 *
 * 版式固定 320×240：所有坐标都是屏幕绝对坐标，不跟随字体/缩放变化。
 * 宿主已经按 320×240 折好行、裁好标题，固件只负责画。
 */
#include "ui.h"

#include <stdio.h>
#include <string.h>

#include "config.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "bsp/esp-box-3.h"
#include "tihu_net.h"

LV_FONT_DECLARE(tihu_font_20)
LV_FONT_DECLARE(tihu_font_15)

static const char *TAG = "tihu_ui";

#define COL_BG      0x0B0F14
#define COL_PANEL   0x151C24
#define COL_TEXT    0xE6EDF3
#define COL_MUTED   0x8B93A1
#define COL_CYAN    0x54D6E8
#define COL_GREEN   0x43B581
#define COL_BLUE    0x4F9FD8
#define COL_AMBER   0xF5A623
#define COL_RED     0xE5484D
#define COL_GRAY    0x3A4654

#if LVGL_VERSION_MAJOR >= 9
#define TIHU_ACTIVE_SCREEN() lv_screen_active()
#else
#define TIHU_ACTIVE_SCREEN() lv_scr_act()
#endif

typedef enum {
    SCREEN_BOARD = 0,
    SCREEN_PROGRESS,
    SCREEN_DONE,
} screen_id_t;

static bool s_ready;
static lv_obj_t *s_board;
static lv_obj_t *s_progress;
static lv_obj_t *s_done;
static lv_obj_t *s_conn_dot;
static lv_obj_t *s_alert;
static lv_obj_t *s_listen;
static esp_timer_handle_t s_alert_timer;
static screen_id_t s_current = SCREEN_PROGRESS;
static char s_conn_text[32] = "连接中";
static bool s_connected;

static void hide_alert(void *arg);

/* ------------------------------ 显示探针 ------------------------------ */

/*
 * 只靠串口判断「屏幕到底有没有在刷」：把 LVGL 的 flush 回调包一层，统计调用次数
 * 和像素面积，再原样转发给 BSP 的回调（不碰 display 的 user_data）。
 */
static volatile unsigned s_flush_count;
static lv_display_flush_cb_t s_raw_flush;

static void flush_probe_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    s_flush_count++;
    if (s_raw_flush != NULL) {
        s_raw_flush(disp, area, px_map);
    }
}

unsigned tihu_ui_flush_count(void)
{
    return s_flush_count;
}

bool tihu_ui_ready(void)
{
    return s_ready;
}

/* ------------------------------ 共用样式 ------------------------------ */

const lv_font_t *tihu_ui_font_title(void)
{
    return &tihu_font_20;
}

const lv_font_t *tihu_ui_font_body(void)
{
    return &tihu_font_15;
}

lv_color_t tihu_ui_tone_color(const char *tone)
{
    if (tone == NULL) {
        return lv_color_hex(COL_GRAY);
    }
    if (strcmp(tone, "busy") == 0) {
        return lv_color_hex(COL_BLUE);
    }
    if (strcmp(tone, "ok") == 0) {
        return lv_color_hex(COL_GREEN);
    }
    if (strcmp(tone, "alert") == 0) {
        return lv_color_hex(COL_RED);
    }
    if (strcmp(tone, "warn") == 0) {
        return lv_color_hex(COL_AMBER);
    }
    return lv_color_hex(COL_GRAY);
}

lv_color_t tihu_ui_state_color(const char *state)
{
    if (state == NULL) {
        return lv_color_hex(COL_GRAY);
    }
    if (strcmp(state, "running") == 0) {
        return lv_color_hex(COL_BLUE);
    }
    if (strcmp(state, "awaiting") == 0) {
        return lv_color_hex(COL_AMBER);
    }
    if (strcmp(state, "done") == 0 || strcmp(state, "announced") == 0) {
        return lv_color_hex(COL_GREEN);
    }
    return lv_color_hex(COL_GRAY);
}

void tihu_ui_apply_tone_bar(lv_obj_t *bar, const char *tone)
{
    if (bar == NULL) {
        return;
    }
    lv_obj_set_style_bg_color(bar, tihu_ui_tone_color(tone), 0);
}

lv_obj_t *tihu_ui_label(lv_obj_t *parent, const char *text, const lv_font_t *font,
                        lv_color_t color, lv_coord_t x, lv_coord_t y,
                        lv_coord_t width, lv_coord_t height)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_pos(label, x, y);
    lv_obj_set_size(label, width, height);
    lv_label_set_text(label, text != NULL ? text : "");
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, color, 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_clear_flag(label, LV_OBJ_FLAG_SCROLLABLE);
    return label;
}

void tihu_ui_send_action(const char *action_id, const char *task_id,
                         lv_obj_t *origin)
{
    int x = 160;
    int y = 220;
    if (origin != NULL) {
        lv_area_t area;
        lv_obj_get_coords(origin, &area);
        x = (area.x1 + area.x2) / 2;
        y = (area.y1 + area.y2) / 2;
    }
    tihu_net_send_tap(x, y, "action", action_id, task_id);
}

const char *tihu_ui_connection_text(void)
{
    return s_conn_text;
}

bool tihu_ui_connected(void)
{
    return s_connected;
}

/* ------------------------------ 对外入口 ------------------------------ */

void tihu_ui_init(void)
{
    /*
     * 不用 bsp_display_start()：它内部用 ESP_LVGL_PORT_INIT_CONFIG() 的默认值
     * （LVGL 任务栈 7 KB）。7 KB 画中文 + 一次性建三屏很容易踩到栈顶，这里把
     * LVGL 任务栈提到 12 KB、tick 周期锁 5 ms，再把返回值/分辨率打进日志。
     */
    bsp_display_cfg_t disp_cfg = {
        .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG(),
        .buffer_size = BSP_LCD_H_RES * CONFIG_BSP_LCD_DRAW_BUF_HEIGHT,
        .double_buffer =
#if CONFIG_BSP_LCD_DRAW_BUF_DOUBLE
        1,
#else
        0,
#endif
        .flags = {
            .buff_dma = true,
            .buff_spiram = false,
        },
    };
    disp_cfg.lvgl_port_cfg.task_stack = 12 * 1024;
    disp_cfg.lvgl_port_cfg.timer_period_ms = 5;
    disp_cfg.lvgl_port_cfg.task_max_sleep_ms = 500;

    lv_display_t *disp = bsp_display_start_with_config(&disp_cfg);
    if (disp == NULL) {
        ESP_LOGE(TAG, "bsp_display_start 失败：检查 BSP/PSRAM 配置");
        return;
    }
    /* 探针要尽早挂：后面每一帧的 flush 都记进计数。 */
    s_raw_flush = lv_display_get_flush_cb(disp);
    lv_display_set_flush_cb(disp, flush_probe_cb);
    ESP_LOGI(TAG, "bsp_display_start 返回 %p：%dx%d，color=%d，draw buf=%d px，dbl=%d",
             (void *)disp,
             (int)lv_display_get_horizontal_resolution(disp),
             (int)lv_display_get_vertical_resolution(disp),
             (int)lv_display_get_color_format(disp),
             (int)disp_cfg.buffer_size, (int)disp_cfg.double_buffer);
    ESP_LOGI(TAG, "LVGL 任务：栈 %d B / 优先级 %d / tick %d ms；flush 探针已挂（原回调 %p）",
             12000, (int)disp_cfg.lvgl_port_cfg.task_priority,
             (int)disp_cfg.lvgl_port_cfg.timer_period_ms, (void *)s_raw_flush);

    bsp_display_lock(0);

    lv_obj_t *scr = TIHU_ACTIVE_SCREEN();
    lv_obj_set_style_bg_color(scr, lv_color_hex(COL_BG), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    s_board = tihu_ui_board_create(scr);
    s_progress = tihu_ui_progress_create(scr);
    s_done = tihu_ui_done_create(scr);

    s_conn_dot = lv_obj_create(scr);
    lv_obj_set_pos(s_conn_dot, 306, 4);
    lv_obj_set_size(s_conn_dot, 8, 8);
    lv_obj_set_style_radius(s_conn_dot, 4, 0);
    lv_obj_set_style_border_width(s_conn_dot, 0, 0);
    lv_obj_set_style_bg_color(s_conn_dot, lv_color_hex(COL_AMBER), 0);
    lv_obj_clear_flag(s_conn_dot, LV_OBJ_FLAG_SCROLLABLE);

    /* 告警条：默认藏着，event.alert 时盖在当前屏上方。 */
    s_alert = lv_obj_create(scr);
    lv_obj_set_pos(s_alert, 8, 92);
    lv_obj_set_size(s_alert, 304, 44);
    lv_obj_set_style_bg_color(s_alert, lv_color_hex(COL_RED), 0);
    lv_obj_set_style_bg_opa(s_alert, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s_alert, 6, 0);
    lv_obj_set_style_border_width(s_alert, 0, 0);
    lv_obj_add_flag(s_alert, LV_OBJ_FLAG_HIDDEN);
    lv_obj_t *alert_label = tihu_ui_label(s_alert, "", tihu_ui_font_body(),
                                         lv_color_hex(0xFFFFFF), 8, 4, 288, 36);
    lv_obj_set_user_data(s_alert, alert_label);

    /* 在听覆盖层：宿主 voice.listen 或按住 CONFIG 键时出现。 */
    s_listen = lv_obj_create(scr);
    lv_obj_set_pos(s_listen, 40, 88);
    lv_obj_set_size(s_listen, 240, 56);
    lv_obj_set_style_bg_color(s_listen, lv_color_hex(COL_GREEN), 0);
    lv_obj_set_style_bg_opa(s_listen, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s_listen, 8, 0);
    lv_obj_set_style_border_width(s_listen, 0, 0);
    lv_obj_add_flag(s_listen, LV_OBJ_FLAG_HIDDEN);
    lv_obj_t *listen_label = tihu_ui_label(s_listen, "在听 · 请说话",
                                           tihu_ui_font_title(), lv_color_hex(0x07120C),
                                           8, 14, 224, 28);
    lv_obj_set_style_text_align(listen_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_user_data(s_listen, listen_label);

    /* 初始屏：连接中。等第一帧 screen.frame 到达后自动切棋盘。 */
    /* 初始屏：静态首页（不依赖宿主）。等第一帧 screen.frame 到达后自动切棋盘。 */
    tihu_screen_frame_t boot = {0};
    snprintf(boot.stage, sizeof(boot.stage), "鹈鹕");
    snprintf(boot.title, sizeof(boot.title), "%s", TIHU_DEVICE_NAME);
    snprintf(boot.bullets[0], sizeof(boot.bullets[0]), "连接中…");
    snprintf(boot.bullets[1], sizeof(boot.bullets[1]), "按住 CONFIG 说话");
    boot.bullet_count = 2;
    snprintf(boot.tone, sizeof(boot.tone), "busy");
    snprintf(boot.mode, sizeof(boot.mode), "status");
    snprintf(boot.actions[0].id, sizeof(boot.actions[0].id), "home");
    snprintf(boot.actions[0].label, sizeof(boot.actions[0].label), "主页");
    snprintf(boot.actions[1].id, sizeof(boot.actions[1].id), "stop");
    snprintf(boot.actions[1].label, sizeof(boot.actions[1].label), "停止");
    boot.action_count = 2;
    tihu_ui_progress_update(s_progress, &boot);

    lv_obj_add_flag(s_board, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_done, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_progress, LV_OBJ_FLAG_HIDDEN);
    s_current = SCREEN_PROGRESS;

    esp_timer_create_args_t alert_args = {
        .callback = hide_alert,
        .arg = NULL,
        .name = "tihu_alert",
    };
    esp_timer_create(&alert_args, &s_alert_timer);

    /* 首帧不在这里刷：tihu_ui_init 跑在 main 任务（8 KB 栈）里，lv_refr_now 会在
     * 调用者栈上做整屏渲染，实测直接把 main 任务栈踩爆。首帧交给 tihu_ui_task
     * （12 KB 栈）在循环第一次迭代同步刷出。 */
    bsp_display_unlock();
    bsp_display_backlight_on();
    s_ready = true;
    ESP_LOGI(TAG, "UI 就绪：320x240，三屏已创建；首帧交给 UI 任务同步刷出（当前 flush=%u）",
             tihu_ui_flush_count());
}

void tihu_ui_show_boot(const char *status)
{
    if (!s_ready) {
        return;
    }
    tihu_screen_frame_t boot = {0};
    snprintf(boot.stage, sizeof(boot.stage), "鹈鹕");
    snprintf(boot.title, sizeof(boot.title), "%s", TIHU_DEVICE_NAME);
    snprintf(boot.bullets[0], sizeof(boot.bullets[0]), "%s",
             status != NULL && status[0] != '\0' ? status : "连接中…");
    snprintf(boot.bullets[1], sizeof(boot.bullets[1]), "按住 CONFIG 说话");
    boot.bullet_count = 2;
    snprintf(boot.tone, sizeof(boot.tone), "busy");
    snprintf(boot.mode, sizeof(boot.mode), "status");
    snprintf(boot.actions[0].id, sizeof(boot.actions[0].id), "home");
    snprintf(boot.actions[0].label, sizeof(boot.actions[0].label), "主页");
    snprintf(boot.actions[1].id, sizeof(boot.actions[1].id), "stop");
    snprintf(boot.actions[1].label, sizeof(boot.actions[1].label), "停止");
    boot.action_count = 2;

    bsp_display_lock(0);
    lv_obj_add_flag(s_board, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_done, LV_OBJ_FLAG_HIDDEN);
    tihu_ui_progress_update(s_progress, &boot);
    lv_obj_clear_flag(s_progress, LV_OBJ_FLAG_HIDDEN);
    s_current = SCREEN_PROGRESS;
    bsp_display_unlock();
}

void tihu_ui_show_frame(const tihu_screen_frame_t *frame)
{
    if (!s_ready || frame == NULL) {
        return;
    }
    /* 旧主页/旧回答屏没有 board/done，按协议直接忽略。 */
    if (!frame->has_board && !frame->has_done && strcmp(frame->mode, "home") == 0) {
        return;
    }
    bsp_display_lock(0);
    lv_obj_add_flag(s_board, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_progress, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_done, LV_OBJ_FLAG_HIDDEN);

    if (frame->has_board) {
        tihu_ui_board_update(s_board, frame);
        lv_obj_clear_flag(s_board, LV_OBJ_FLAG_HIDDEN);
        s_current = SCREEN_BOARD;
    } else if (frame->has_done) {
        tihu_ui_done_update(s_done, frame);
        lv_obj_clear_flag(s_done, LV_OBJ_FLAG_HIDDEN);
        s_current = SCREEN_DONE;
    } else {
        tihu_ui_progress_update(s_progress, frame);
        lv_obj_clear_flag(s_progress, LV_OBJ_FLAG_HIDDEN);
        s_current = SCREEN_PROGRESS;
    }
    bsp_display_unlock();
}

void tihu_ui_set_connection(bool connected, const char *text)
{
    s_connected = connected;
    if (text != NULL) {
        snprintf(s_conn_text, sizeof(s_conn_text), "%s", text);
    } else {
        snprintf(s_conn_text, sizeof(s_conn_text), "%s", connected ? "已连接" : "连接中");
    }
    if (!s_ready) {
        return;
    }
    bsp_display_lock(0);
    lv_obj_set_style_bg_color(s_conn_dot,
                              lv_color_hex(connected ? COL_GREEN : COL_AMBER), 0);
    bsp_display_unlock();
}

void tihu_ui_set_listening(bool on, const char *prompt)
{
    if (!s_ready) {
        return;
    }
    bsp_display_lock(0);
    if (on) {
        lv_obj_t *label = (lv_obj_t *)lv_obj_get_user_data(s_listen);
        if (label != NULL) {
            lv_label_set_text(label, prompt != NULL && prompt[0] != '\0' ? prompt : "在听 · 请说话");
        }
        lv_obj_clear_flag(s_listen, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(s_listen, LV_OBJ_FLAG_HIDDEN);
    }
    bsp_display_unlock();
}

static void hide_alert(void *arg)
{
    (void)arg;
    if (!s_ready) {
        return;
    }
    bsp_display_lock(0);
    lv_obj_add_flag(s_alert, LV_OBJ_FLAG_HIDDEN);
    bsp_display_unlock();
}

void tihu_ui_show_alert(const char *text)
{
    if (!s_ready || text == NULL) {
        return;
    }
    bsp_display_lock(0);
    lv_obj_t *label = (lv_obj_t *)lv_obj_get_user_data(s_alert);
    if (label != NULL) {
        lv_label_set_text(label, text);
    }
    lv_obj_clear_flag(s_alert, LV_OBJ_FLAG_HIDDEN);
    bsp_display_unlock();
    if (s_alert_timer != NULL) {
        esp_timer_stop(s_alert_timer);
        esp_timer_start_once(s_alert_timer, 5000 * 1000);
    }
}

const char *tihu_ui_stage_name(void)
{
    if (s_current == SCREEN_BOARD) {
        return "棋盘";
    }
    if (s_current == SCREEN_DONE) {
        return "完成";
    }
    return "进度";
}
