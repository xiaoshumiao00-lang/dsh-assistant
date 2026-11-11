/**
 * 屏 1：任务棋盘。
 *
 * 版式（320×240）：
 *   y=4   四段计数（等你/在跑/排队/完成）
 *   y=26  4 行任务，每行 46px：状态胶囊 + 20px 标题 + 15px 副行
 *   y=218 页码与连接状态
 *
 * 点一行 = screen.gesture{tap, hit:"task", taskId}，与模拟页同一路径。
 */
#include "ui.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "tihu_net.h"

#define ROW_X       8
#define ROW_Y       26
#define ROW_W       304
#define ROW_H       46
#define ROW_GAP     2

#define COL_PANEL   0x151C24
#define COL_TEXT    0xE6EDF3
#define COL_MUTED   0x8B93A1

static char s_task_ids[TIHU_MAX_BOARD_ROWS][48];
static lv_obj_t *s_rows[TIHU_MAX_BOARD_ROWS];
static lv_obj_t *s_counts;
static lv_obj_t *s_page;
static lv_obj_t *s_conn;
static lv_obj_t *s_empty;
static lv_obj_t *s_tone_bar;

static void board_row_cb(lv_event_t *event)
{
    int index = (int)(uintptr_t)lv_event_get_user_data(event) - 1;
    if (index < 0 || index >= TIHU_MAX_BOARD_ROWS) {
        return;
    }
    if (s_task_ids[index][0] == '\0') {
        return;
    }
    lv_obj_t *row = lv_event_get_target(event);
    lv_area_t area;
    lv_obj_get_coords(row, &area);
    tihu_net_send_tap((area.x1 + area.x2) / 2, (area.y1 + area.y2) / 2,
                      "task", NULL, s_task_ids[index]);
}

lv_obj_t *tihu_ui_board_create(lv_obj_t *parent)
{
    lv_obj_t *screen = lv_obj_create(parent);
    lv_obj_set_pos(screen, 0, 0);
    lv_obj_set_size(screen, 320, 240);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x0B0F14), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(screen, 0, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

    s_counts = tihu_ui_label(screen, "等你0 在跑0 排队0 完成0",
                             tihu_ui_font_body(), lv_color_hex(COL_TEXT),
                             8, 4, 288, 18);

    s_tone_bar = lv_obj_create(screen);
    lv_obj_set_pos(s_tone_bar, 8, 22);
    lv_obj_set_size(s_tone_bar, 304, 3);
    lv_obj_set_style_radius(s_tone_bar, 1, 0);
    lv_obj_set_style_border_width(s_tone_bar, 0, 0);
    tihu_ui_apply_tone_bar(s_tone_bar, "idle");

    for (int i = 0; i < TIHU_MAX_BOARD_ROWS; i++) {
        lv_obj_t *row = lv_obj_create(screen);
        s_rows[i] = row;
        lv_obj_set_pos(row, ROW_X, ROW_Y + i * (ROW_H + ROW_GAP));
        lv_obj_set_size(row, ROW_W, ROW_H);
        lv_obj_set_style_bg_color(row, lv_color_hex(COL_PANEL), 0);
        lv_obj_set_style_bg_opa(row, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(row, 5, 0);
        lv_obj_set_style_border_width(row, 0, 0);
        lv_obj_set_style_pad_all(row, 0, 0);
        lv_obj_add_flag(row, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_event_cb(row, board_row_cb, LV_EVENT_CLICKED,
                            (void *)(uintptr_t)(i + 1));

        lv_obj_t *capsule = tihu_ui_label(row, "", tihu_ui_font_body(),
                                          lv_color_hex(0x07120C), 6, 6, 50, 18);
        lv_obj_set_style_bg_opa(capsule, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(capsule, 3, 0);
        lv_obj_set_style_text_align(capsule, LV_TEXT_ALIGN_CENTER, 0);

        lv_obj_t *title = tihu_ui_label(row, "", tihu_ui_font_title(),
                                        lv_color_hex(COL_TEXT), 60, 2, 224, 24);
        lv_label_set_long_mode(title, LV_LABEL_LONG_DOT);

        lv_obj_t *sub = tihu_ui_label(row, "", tihu_ui_font_body(),
                                      lv_color_hex(COL_MUTED), 60, 25, 218, 18);
        lv_label_set_long_mode(sub, LV_LABEL_LONG_DOT);

        lv_obj_t *dot = lv_obj_create(row);
        lv_obj_set_pos(dot, 288, 20);
        lv_obj_set_size(dot, 9, 9);
        lv_obj_set_style_radius(dot, 5, 0);
        lv_obj_set_style_border_width(dot, 0, 0);
        lv_obj_set_style_bg_color(dot, lv_color_hex(0x3A4654), 0);
        lv_obj_clear_flag(dot, LV_OBJ_FLAG_SCROLLABLE);

        /* 子对象不吞点击：点标题/胶囊/圆点也要落到整行。 */
        lv_obj_add_flag(capsule, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_EVENT_BUBBLE);
        lv_obj_add_flag(title, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_EVENT_BUBBLE);
        lv_obj_add_flag(sub, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_EVENT_BUBBLE);
        lv_obj_add_flag(dot, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_EVENT_BUBBLE);

        lv_obj_add_flag(row, LV_OBJ_FLAG_HIDDEN);
    }

    s_empty = tihu_ui_label(screen, "还没有任务", tihu_ui_font_title(),
                            lv_color_hex(COL_MUTED), 8, 96, 304, 28);
    lv_obj_set_style_text_align(s_empty, LV_TEXT_ALIGN_CENTER, 0);

    s_page = tihu_ui_label(screen, "第 1/1 页", tihu_ui_font_body(),
                           lv_color_hex(COL_MUTED), 8, 218, 160, 18);
    s_conn = tihu_ui_label(screen, "连接中", tihu_ui_font_body(),
                           lv_color_hex(COL_MUTED), 168, 218, 144, 18);
    lv_obj_set_style_text_align(s_conn, LV_TEXT_ALIGN_RIGHT, 0);
    return screen;
}

void tihu_ui_board_update(lv_obj_t *screen, const tihu_screen_frame_t *frame)
{
    (void)screen;
    if (frame == NULL) {
        return;
    }
    const tihu_board_t *board = &frame->board;
    char text[96];
    snprintf(text, sizeof(text), "等你%d 在跑%d 排队%d 完成%d",
             board->awaiting, board->running, board->queued, board->done);
    lv_label_set_text(s_counts, text);

    char page_text[64];
    snprintf(page_text, sizeof(page_text), "第 %d/%d 页",
             board->page_index + 1, board->page_total > 0 ? board->page_total : 1);
    lv_label_set_text(s_page, page_text);
    lv_label_set_text(s_conn, tihu_ui_connection_text());

    const char *tone = frame->tone[0] != '\0' ? frame->tone : "idle";
    tihu_ui_apply_tone_bar(s_tone_bar, tone);
    lv_obj_set_style_text_color(s_counts, tihu_ui_tone_color(tone), 0);

    if (board->row_count == 0) {
        lv_obj_clear_flag(s_empty, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(s_empty, board->empty ? "还没有任务" : "这一页没有任务");
    } else {
        lv_obj_add_flag(s_empty, LV_OBJ_FLAG_HIDDEN);
    }

    for (int i = 0; i < TIHU_MAX_BOARD_ROWS; i++) {
        lv_obj_t *row = s_rows[i];
        if (i >= board->row_count) {
            lv_obj_add_flag(row, LV_OBJ_FLAG_HIDDEN);
            s_task_ids[i][0] = '\0';
            continue;
        }
        const tihu_board_row_t *data = &board->rows[i];
        lv_obj_clear_flag(row, LV_OBJ_FLAG_HIDDEN);
        snprintf(s_task_ids[i], sizeof(s_task_ids[i]), "%s", data->task_id);

        /* 子对象顺序：0=胶囊 1=标题 2=副行 3=圆点 */
        lv_obj_t *capsule = lv_obj_get_child(row, 0);
        lv_obj_t *title = lv_obj_get_child(row, 1);
        lv_obj_t *sub = lv_obj_get_child(row, 2);
        lv_obj_t *dot = lv_obj_get_child(row, 3);

        lv_label_set_text(capsule, data->capsule[0] != '\0' ? data->capsule : "排队中");
        lv_obj_set_style_bg_color(capsule, tihu_ui_state_color(data->state), 0);
        lv_label_set_text(title, data->title);
        lv_label_set_text(sub, data->sub);
        lv_obj_set_style_bg_color(dot, tihu_ui_state_color(data->state), 0);
        if (data->badge_ask) {
            lv_obj_set_style_bg_color(dot, lv_color_hex(0xF5A623), 0);
        }
    }
}
