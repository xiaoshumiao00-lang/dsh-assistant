/**
 * 屏 4：任务进度。
 *
 * 数据来自宿主 detailFrame：
 *   stage="进度"，title=任务名，
 *   bullets[0]=最新状态（思考 · … / 工具调用 · …），
 *   bullets[1]="第 N 步 · 已用 1m23s"，bullets[2]=统计行。
 *
 * 固件不自己算用时：宿主每秒重画这一帧，文字跟着帧走，断线时停在最后一眼。
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

static lv_obj_t *s_tone_bar;
static lv_obj_t *s_stage;
static lv_obj_t *s_conn;
static lv_obj_t *s_title;
static lv_obj_t *s_live;
static lv_obj_t *s_step;
static lv_obj_t *s_stats;
static lv_obj_t *s_bar;
static lv_obj_t *s_buttons[2];
static char s_action_ids[2][40];
static char s_task_id[48];

static void progress_btn_cb(lv_event_t *event)
{
    int index = (int)(uintptr_t)lv_event_get_user_data(event) - 1;
    if (index < 0 || index >= 2) {
        return;
    }
    if (s_action_ids[index][0] == '\0') {
        return;
    }
    tihu_ui_send_action(s_action_ids[index], s_task_id,
                        lv_event_get_target(event));
}

lv_obj_t *tihu_ui_progress_create(lv_obj_t *parent)
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
    tihu_ui_apply_tone_bar(s_tone_bar, "busy");

    s_stage = tihu_ui_label(screen, "进度", tihu_ui_font_body(),
                            lv_color_hex(COL_CYAN), 8, 10, 160, 18);
    s_conn = tihu_ui_label(screen, "连接中", tihu_ui_font_body(),
                           lv_color_hex(COL_MUTED), 168, 10, 144, 18);
    lv_obj_set_style_text_align(s_conn, LV_TEXT_ALIGN_RIGHT, 0);

    s_title = tihu_ui_label(screen, "任务进度", tihu_ui_font_title(),
                            lv_color_hex(COL_TEXT), 8, 30, 304, 26);
    lv_label_set_long_mode(s_title, LV_LABEL_LONG_DOT);

    s_live = tihu_ui_label(screen, "思考 · 模型推理中…", tihu_ui_font_body(),
                           lv_color_hex(COL_TEXT), 8, 60, 304, 40);

    s_step = tihu_ui_label(screen, "第 0 步", tihu_ui_font_title(),
                           lv_color_hex(COL_CYAN), 8, 104, 304, 24);

    s_stats = tihu_ui_label(screen, "", tihu_ui_font_body(),
                            lv_color_hex(COL_MUTED), 8, 130, 304, 18);

    s_bar = lv_bar_create(screen);
    lv_obj_set_pos(s_bar, 8, 154);
    lv_obj_set_size(s_bar, 304, 7);
    lv_obj_set_style_bg_color(s_bar, lv_color_hex(COL_PANEL), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_radius(s_bar, 4, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_bar, lv_color_hex(COL_CYAN), LV_PART_INDICATOR);
    lv_obj_set_style_radius(s_bar, 4, LV_PART_INDICATOR);
    lv_bar_set_range(s_bar, 0, 100);
    lv_bar_set_value(s_bar, 0, LV_ANIM_OFF);
    lv_obj_add_flag(s_bar, LV_OBJ_FLAG_HIDDEN);

    for (int i = 0; i < 2; i++) {
        lv_obj_t *btn = lv_button_create(screen);
        s_buttons[i] = btn;
        lv_obj_set_pos(btn, i == 0 ? 8 : 164, 198);
        lv_obj_set_size(btn, 148, 34);
        lv_obj_set_style_bg_color(btn, lv_color_hex(COL_PANEL), 0);
        lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(btn, 5, 0);
        lv_obj_set_style_border_width(btn, 0, 0);
        lv_obj_add_event_cb(btn, progress_btn_cb, LV_EVENT_CLICKED,
                            (void *)(uintptr_t)(i + 1));
        lv_obj_t *label = tihu_ui_label(btn, i == 0 ? "停止" : "主页",
                                        tihu_ui_font_body(), lv_color_hex(COL_TEXT),
                                        0, 6, 148, 22);
        lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_add_flag(btn, LV_OBJ_FLAG_HIDDEN);
    }
    return screen;
}

void tihu_ui_progress_update(lv_obj_t *screen, const tihu_screen_frame_t *frame)
{
    (void)screen;
    if (frame == NULL) {
        return;
    }
    const char *stage = frame->stage[0] != '\0' ? frame->stage : "进度";
    lv_label_set_text(s_stage, stage);
    lv_obj_set_style_text_color(s_stage, tihu_ui_tone_color(frame->tone), 0);
    tihu_ui_apply_tone_bar(s_tone_bar, frame->tone);

    char title[180];
    snprintf(title, sizeof(title), "%s", frame->title[0] != '\0' ? frame->title : "任务进度");
    lv_label_set_text(s_title, title);
    lv_label_set_text(s_conn, tihu_ui_connection_text());

    const char *live = frame->bullet_count > 0 ? frame->bullets[0] : "思考 · 模型推理中…";
    lv_label_set_text(s_live, live);

    char step[180];
    if (frame->bullet_count > 1 && frame->bullets[1][0] != '\0') {
        snprintf(step, sizeof(step), "%s", frame->bullets[1]);
    } else if (frame->has_progress && frame->progress_total > 0) {
        snprintf(step, sizeof(step), "第 %d/%d 步", frame->progress_done, frame->progress_total);
    } else if (frame->has_progress) {
        snprintf(step, sizeof(step), "第 %d 步", frame->progress_done);
    } else {
        snprintf(step, sizeof(step), "处理中…");
    }
    lv_label_set_text(s_step, step);

    const char *stats = frame->bullet_count > 2 ? frame->bullets[2] : "";
    lv_label_set_text(s_stats, stats);

    if (frame->has_progress && frame->progress_total > 0) {
        lv_obj_clear_flag(s_bar, LV_OBJ_FLAG_HIDDEN);
        lv_bar_set_range(s_bar, 0, frame->progress_total);
        int value = frame->progress_done;
        if (value < 0) {
            value = 0;
        }
        if (value > frame->progress_total) {
            value = frame->progress_total;
        }
        lv_bar_set_value(s_bar, value, LV_ANIM_OFF);
    } else {
        lv_obj_add_flag(s_bar, LV_OBJ_FLAG_HIDDEN);
    }

    snprintf(s_task_id, sizeof(s_task_id), "%s", frame->task_id);
    for (int i = 0; i < 2; i++) {
        if (i < frame->action_count) {
            snprintf(s_action_ids[i], sizeof(s_action_ids[i]), "%.39s", frame->actions[i].id);
            lv_obj_t *label = lv_obj_get_child(s_buttons[i], 0);
            lv_label_set_text(label, frame->actions[i].label);
            lv_obj_clear_flag(s_buttons[i], LV_OBJ_FLAG_HIDDEN);
        } else {
            s_action_ids[i][0] = '\0';
            lv_obj_add_flag(s_buttons[i], LV_OBJ_FLAG_HIDDEN);
        }
    }
}
