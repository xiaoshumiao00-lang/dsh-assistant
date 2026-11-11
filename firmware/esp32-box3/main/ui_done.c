/**
 * 屏 6：完成页。
 *
 * 版式（320×240）：
 *   y=4    tone 条
 *   y=10   「完成 · 3/12」
 *   y=28   20px 大标题（任务名，不是回答第一句）
 *   y=56   7 行正文，15px/20px；当前朗读行青底黑字
 *   y=202  停止 / 重读 / 主页 三键
 *
 * 高亮只跟宿主下发的 done.current 走；真正的“念到哪”由宿主的 tts.audio
 * charStart/charEnd 换算成行后再次下发，固件不按时间猜。
 *
 * 三个键的 actionId 必须用宿主完成页 actions 的原名（src/tihu/task-screens.ts 里
 * done 屏 actions = stop / replay / taskBoard），点一下发
 * `screen.gesture{tap, hit:"action", actionId}`，宿主 lane.ts 按这三个 id 分派。
 */
#include "ui.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "bsp/esp-box-3.h"
#include "tihu_audio.h"
#include "tihu_net.h"

#define COL_PANEL   0x151C24
#define COL_TEXT    0xE6EDF3
#define COL_MUTED   0x8B93A1
#define COL_CYAN    0x54D6E8
#define COL_DARK    0x07120C

static lv_obj_t *s_tone_bar;
static lv_obj_t *s_stage;
static lv_obj_t *s_conn;
static lv_obj_t *s_title;
static lv_obj_t *s_lines[TIHU_MAX_DONE_LINES];
static lv_obj_t *s_buttons[3];
static char s_action_ids[3][40];
static char s_task_id[48];
/* 最近一次按钮点击的发送结果（tihu_ui_simulate_action 用它回话给开机自检）。 */
static bool s_last_send_ok;

static void done_btn_cb(lv_event_t *event)
{
    int index = (int)(uintptr_t)lv_event_get_user_data(event) - 1;
    if (index < 0 || index >= 3) {
        return;
    }
    if (s_action_ids[index][0] == '\0') {
        ESP_LOGW("ui", "按钮命中但 actionId 为空（index=%d）", index);
        return;
    }
    ESP_LOGI("ui", "按钮命中 actionId=%s（完成页第 %d 键）", s_action_ids[index], index + 1);
    /*
     * 「停止」必须**本机立刻停声**，不能只等宿主：
     * 宿主收到 screen.gesture{actionId:'stop'} 后只把朗读轮次号 +1（不再下发新的 PCM，
     * 见 src/tihu/lane.ts 的 cancelSpeaking），并**不会**补发 playback.control{stop}；
     * 设备缓冲区里已经排进去的那一段会继续念完——现场就是「按了停止，声音还在」。
     * 先本地停，再照常上报（宿主那边同样会掐掉这一轮）。
     */
    if (strcmp(s_action_ids[index], "stop") == 0 || strcmp(s_action_ids[index], "taskStop") == 0) {
        tihu_audio_stop();
        ESP_LOGI("ui", "停止键：本地已停声（不等宿主 playback.control）");
    }
    s_last_send_ok = tihu_ui_send_action(s_action_ids[index], s_task_id,
                                         lv_event_get_target(event));
}

bool tihu_ui_simulate_action(int index)
{
    if (index < 0 || index >= 3 || s_buttons[index] == NULL) {
        ESP_LOGW("ui", "自检模拟点击失败：完成页按钮 %d 不存在", index);
        return false;
    }
    if (!bsp_display_lock(pdMS_TO_TICKS(1000))) {
        ESP_LOGW("ui", "自检模拟点击失败：拿不到 LVGL 锁");
        return false;
    }
    s_last_send_ok = false;
    /* 与真手指同一条链路：LVGL 收到 PRESSED/CLICKED → 上面两个回调。 */
    lv_obj_send_event(s_buttons[index], LV_EVENT_PRESSED, NULL);
    lv_obj_send_event(s_buttons[index], LV_EVENT_CLICKED, NULL);
    bsp_display_unlock();
    return s_last_send_ok;
}

/* 按下即打点：不等 CLICKED，先确认「手指落在哪、落在哪个按钮的矩形里」。 */
static void done_btn_pressed_cb(lv_event_t *event)
{
    int index = (int)(uintptr_t)lv_event_get_user_data(event) - 1;
    if (index < 0 || index >= 3) {
        return;
    }
    lv_indev_t *indev = lv_indev_active();
    lv_point_t point = {0, 0};
    if (indev != NULL) {
        lv_indev_get_point(indev, &point);
    }
    lv_area_t area;
    lv_obj_get_coords(lv_event_get_target(event), &area);
    lv_obj_t *label = lv_obj_get_child(s_buttons[index], 0);
    ESP_LOGI("ui", "按下「%s」：触摸点 x=%d y=%d，按钮区 [%d,%d]-[%d,%d]，actionId=%s",
             label != NULL ? lv_label_get_text(label) : "?",
             (int)point.x, (int)point.y,
             (int)area.x1, (int)area.y1, (int)area.x2, (int)area.y2,
             s_action_ids[index]);
}

/*
 * 完成页容器自己的按下事件：按钮没吃到时才会走到这里（按钮事件不冒泡）。
 * 有一条 `完成页被按下但没落在按钮上` 就说明触摸在报点、但坐标/命中区不对——
 * 和「触摸根本没报点」是完全不同的两种故障，串口里一眼能分开。
 */
static void done_screen_pressed_cb(lv_event_t *event)
{
    (void)event;
    lv_indev_t *indev = lv_indev_active();
    lv_point_t point = {0, 0};
    if (indev != NULL) {
        lv_indev_get_point(indev, &point);
    }
    ESP_LOGW("ui", "完成页被按下但没落在按钮上：x=%d y=%d（三键在 y=202..232）",
             (int)point.x, (int)point.y);
}

lv_obj_t *tihu_ui_done_create(lv_obj_t *parent)
{
    lv_obj_t *screen = lv_obj_create(parent);
    lv_obj_set_pos(screen, 0, 0);
    lv_obj_set_size(screen, 320, 240);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x0B0F14), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(screen, 0, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    /* 容器不滚动 = 子对象坐标不会被滚动偏移偷偷带走（命中区跟画面对得上）。 */
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(screen, LV_DIR_NONE);
    lv_obj_add_flag(screen, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(screen, done_screen_pressed_cb, LV_EVENT_PRESSED, NULL);

    s_tone_bar = lv_obj_create(screen);
    lv_obj_set_pos(s_tone_bar, 8, 4);
    lv_obj_set_size(s_tone_bar, 304, 3);
    lv_obj_set_style_radius(s_tone_bar, 1, 0);
    lv_obj_set_style_border_width(s_tone_bar, 0, 0);
    tihu_ui_apply_tone_bar(s_tone_bar, "ok");

    s_stage = tihu_ui_label(screen, "完成", tihu_ui_font_body(),
                            lv_color_hex(COL_CYAN), 8, 10, 180, 18);
    s_conn = tihu_ui_label(screen, "连接中", tihu_ui_font_body(),
                           lv_color_hex(COL_MUTED), 188, 10, 124, 18);
    lv_obj_set_style_text_align(s_conn, LV_TEXT_ALIGN_RIGHT, 0);

    s_title = tihu_ui_label(screen, "任务完成", tihu_ui_font_title(),
                            lv_color_hex(COL_TEXT), 8, 28, 304, 26);
    lv_label_set_long_mode(s_title, LV_LABEL_LONG_DOT);

    for (int i = 0; i < TIHU_MAX_DONE_LINES; i++) {
        s_lines[i] = tihu_ui_label(screen, "", tihu_ui_font_body(),
                                   lv_color_hex(COL_TEXT), 8, 56 + i * 20, 304, 20);
        lv_label_set_long_mode(s_lines[i], LV_LABEL_LONG_CLIP);
        lv_obj_set_style_bg_opa(s_lines[i], LV_OPA_TRANSP, 0);
        lv_obj_set_style_pad_left(s_lines[i], 2, 0);
    }

    static const char *default_ids[3] = {"stop", "replay", "taskBoard"};
    static const char *default_labels[3] = {"停止", "重读", "主页"};
    for (int i = 0; i < 3; i++) {
        lv_obj_t *btn = lv_button_create(screen);
        s_buttons[i] = btn;
        lv_obj_set_pos(btn, 8 + i * 104, 202);
        lv_obj_set_size(btn, 96, 30);
        lv_obj_set_style_bg_color(btn, lv_color_hex(COL_PANEL), 0);
        lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(btn, 5, 0);
        lv_obj_set_style_border_width(btn, 0, 0);
        lv_obj_set_style_pad_all(btn, 0, 0);
        /*
         * 可点三件套，缺一个就「点了没反应」：
         *   1) 按钮自己必须 CLICKABLE（lv_button 默认有，这里写明防止以后被改掉）；
         *   2) 按钮不能滚动，否则按下拖动会被当成滚动、CLICKED 不发射；
         *   3) 里面的文字 label 默认不 CLICKABLE（lv_label_constructor 里 set_clickable(false)），
         *      命中会落到按钮上——不要给它加 CLICKABLE，否则它会吞掉整块命中区。
         */
        lv_obj_add_flag(btn, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_event_cb(btn, done_btn_pressed_cb, LV_EVENT_PRESSED,
                            (void *)(uintptr_t)(i + 1));
        lv_obj_add_event_cb(btn, done_btn_cb, LV_EVENT_CLICKED,
                            (void *)(uintptr_t)(i + 1));
        lv_obj_t *label = tihu_ui_label(btn, default_labels[i],
                                        tihu_ui_font_body(), lv_color_hex(COL_TEXT),
                                        0, 4, 96, 22);
        lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
        snprintf(s_action_ids[i], sizeof(s_action_ids[i]), "%.39s", default_ids[i]);

        /* 先跑一次布局，坐标才是真的；否则 get_coords 还停在 [0,0]-[-1,-1]。 */
        lv_obj_update_layout(btn);
        lv_area_t area;
        lv_obj_get_coords(btn, &area);
        ESP_LOGI("ui", "按钮 #%d「%s」actionId=%s 命中区 [%d,%d]-[%d,%d] clickable=%d",
                 i + 1, default_labels[i], default_ids[i],
                 (int)area.x1, (int)area.y1, (int)area.x2, (int)area.y2,
                 (int)lv_obj_has_flag(btn, LV_OBJ_FLAG_CLICKABLE));
    }
    return screen;
}

void tihu_ui_done_update(lv_obj_t *screen, const tihu_screen_frame_t *frame)
{
    (void)screen;
    if (frame == NULL || !frame->has_done) {
        return;
    }
    const tihu_done_t *done = &frame->done;

    char stage[64];
    if (done->line_count > 0) {
        snprintf(stage, sizeof(stage), "完成 · %d/%d",
                 done->current + 1, done->line_count);
    } else {
        snprintf(stage, sizeof(stage), "完成");
    }
    lv_label_set_text(s_stage, stage);
    lv_label_set_text(s_conn, tihu_ui_connection_text());
    tihu_ui_apply_tone_bar(s_tone_bar, frame->tone);

    lv_label_set_text(s_title, frame->title[0] != '\0' ? frame->title : "任务完成");

    /* 7 行窗口：当前行尽量放在第 3 行，和模拟页一样提前两行。 */
    int visible = TIHU_MAX_DONE_LINES;
    int start = done->current - 2;
    if (start < 0) {
        start = 0;
    }
    if (start > done->line_count - visible) {
        start = done->line_count - visible;
    }
    if (start < 0) {
        start = 0;
    }

    for (int i = 0; i < visible; i++) {
        int index = start + i;
        if (index < done->line_count) {
            lv_label_set_text(s_lines[i], done->lines[index]);
        } else {
            lv_label_set_text(s_lines[i], "");
        }
        bool current = (index == done->current && index < done->line_count);
        lv_obj_set_style_bg_opa(s_lines[i], current ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
        if (current) {
            lv_obj_set_style_bg_color(s_lines[i], lv_color_hex(COL_CYAN), 0);
            lv_obj_set_style_text_color(s_lines[i], lv_color_hex(COL_DARK), 0);
        } else {
            lv_obj_set_style_text_color(s_lines[i], lv_color_hex(COL_TEXT), 0);
        }
    }

    snprintf(s_task_id, sizeof(s_task_id), "%s", frame->task_id);
    static const char *default_ids[3] = {"stop", "replay", "taskBoard"};
    static const char *default_labels[3] = {"停止", "重读", "主页"};
    for (int i = 0; i < 3; i++) {
        if (i < frame->action_count) {
            snprintf(s_action_ids[i], sizeof(s_action_ids[i]), "%.39s", frame->actions[i].id);
            lv_obj_t *label = lv_obj_get_child(s_buttons[i], 0);
            lv_label_set_text(label, frame->actions[i].label[0] != '\0'
                                    ? frame->actions[i].label : default_labels[i]);
        } else {
            snprintf(s_action_ids[i], sizeof(s_action_ids[i]), "%.39s", default_ids[i]);
            lv_obj_t *label = lv_obj_get_child(s_buttons[i], 0);
            lv_label_set_text(label, default_labels[i]);
        }
    }
}
