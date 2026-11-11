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
 */
#include "ui.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

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

static void done_btn_cb(lv_event_t *event)
{
    int index = (int)(uintptr_t)lv_event_get_user_data(event) - 1;
    if (index < 0 || index >= 3) {
        return;
    }
    if (s_action_ids[index][0] == '\0') {
        return;
    }
    tihu_ui_send_action(s_action_ids[index], s_task_id,
                        lv_event_get_target(event));
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
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

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
        lv_obj_add_event_cb(btn, done_btn_cb, LV_EVENT_CLICKED,
                            (void *)(uintptr_t)(i + 1));
        lv_obj_t *label = tihu_ui_label(btn, default_labels[i],
                                        tihu_ui_font_body(), lv_color_hex(COL_TEXT),
                                        0, 4, 96, 22);
        lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
        snprintf(s_action_ids[i], sizeof(s_action_ids[i]), "%.39s", default_ids[i]);
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
