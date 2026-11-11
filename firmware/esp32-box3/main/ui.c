/**
 * 三屏容器与共用样式。
 *
 * 版式固定 320×240：所有坐标都是屏幕绝对坐标，不跟随字体/缩放变化。
 * 宿主已经按 320×240 折好行、裁好标题，固件只负责画。
 */
#include "ui.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "config.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "bsp/esp-box-3.h"
#include "tihu_charset.h"
#include "tihu_net.h"
#include "tihu_touch.h"

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

/* ------------------------------ 字体自检 ------------------------------ */

/*
 * 真机「中文全是空心方框」的两种成因，都在这里一次说清：
 *   1) label 没设中文字体（还在用 LV_FONT_DEFAULT / montserrat，没有汉字）；
 *   2) 字库位图是压缩格式（bitmap_format=1），但固件没开 LV_USE_FONT_COMPRESSED：
 *      字形描述能找到，位图取不出来（lv_font_get_bitmap_fmt_txt 返回 NULL），
 *      绘制层于是按「缺字形」走 LV_USE_FONT_PLACEHOLDER，画一个 1px 空心方框。
 * 两种情况长得一模一样，所以开机就把每个 label 的字体名 / bpp / 缺字数打出来，
 * 再对「鹈」字做一次 lv_font_get_glyph_dsc 断言。
 */

#define TIHU_PROBE_GLYPH 0x9E48u /* 「鹈」U+9E48，标题第一字，缺了必是方框 */

static const char *font_name(const lv_font_t *font)
{
    if (font == NULL) {
        return "(null)";
    }
    if (font == &tihu_font_20) {
        return "tihu_font_20";
    }
    if (font == &tihu_font_15) {
        return "tihu_font_15";
    }
    if (font == LV_FONT_DEFAULT) {
        return "LV_FONT_DEFAULT(无汉字)";
    }
    return "(其它字体)";
}

static const lv_font_fmt_txt_dsc_t *font_txt_dsc(const lv_font_t *font)
{
    if (font == NULL || font->dsc == NULL ||
        font->get_glyph_dsc != lv_font_get_glyph_dsc_fmt_txt) {
        return NULL;
    }
    return (const lv_font_fmt_txt_dsc_t *)font->dsc;
}

static int font_bpp(const lv_font_t *font)
{
    const lv_font_fmt_txt_dsc_t *dsc = font_txt_dsc(font);
    return dsc != NULL ? (int)dsc->bpp : -1;
}

static const char *font_bitmap_format(const lv_font_t *font)
{
    const lv_font_fmt_txt_dsc_t *dsc = font_txt_dsc(font);
    if (dsc == NULL) {
        return "n/a";
    }
    return dsc->bitmap_format == LV_FONT_FMT_TXT_PLAIN ? "PLAIN" : "COMPRESSED";
}

static uint32_t utf8_decode(const char **cursor)
{
    const unsigned char *s = (const unsigned char *)*cursor;
    uint32_t cp = s[0];
    if (cp < 0x80u) {
        *cursor += 1;
        return cp;
    }
    int extra = cp >= 0xF0u ? 3 : (cp >= 0xE0u ? 2 : 1);
    cp &= 0x7Fu >> (extra + 1);
    int used = 0;
    for (; used < extra; used++) {
        unsigned char next = s[1 + used];
        if ((next & 0xC0u) != 0x80u) {
            break;
        }
        cp = (cp << 6) | (next & 0x3Fu);
    }
    *cursor += 1 + used;
    return cp;
}

/* 返回 text 里该字体画不出的字数，缺失字符写进 missing（UTF-8）。 */
static int label_missing_chars(const lv_font_t *font, const char *text,
                               char *missing, size_t missing_len, int *total)
{
    if (missing != NULL && missing_len > 0) {
        missing[0] = '\0';
    }
    if (total != NULL) {
        *total = 0;
    }
    if (font == NULL || text == NULL) {
        return 0;
    }
    int miss = 0;
    int chars = 0;
    size_t used = 0;
    const char *cursor = text;
    while (*cursor != '\0') {
        const char *start = cursor;
        uint32_t cp = utf8_decode(&cursor);
        if (cp == 0) {
            break;
        }
        chars++;
        lv_font_glyph_dsc_t dsc = {0};
        if (!lv_font_get_glyph_dsc(font, &dsc, cp, 0)) {
            miss++;
            if (missing != NULL && used + (size_t)(cursor - start) + 1 < missing_len) {
                memcpy(missing + used, start, (size_t)(cursor - start));
                used += (size_t)(cursor - start);
                missing[used] = '\0';
            }
        } else if (dsc.box_w == 0 || dsc.box_h == 0) {
            /* 空白字符（space）本来就没有位图，不算缺字。 */
            if (cp != ' ' && cp != '\t') {
                miss++;
                if (missing != NULL && used + (size_t)(cursor - start) + 1 < missing_len) {
                    memcpy(missing + used, start, (size_t)(cursor - start));
                    used += (size_t)(cursor - start);
                    missing[used] = '\0';
                }
            }
        }
    }
    if (total != NULL) {
        *total = chars;
    }
    return miss;
}

static void ui_label_report(lv_obj_t *parent, int depth, int *index, int *missing_total)
{
    if (parent == NULL || depth > 4) {
        return;
    }
    uint32_t count = lv_obj_get_child_count(parent);
    for (uint32_t i = 0; i < count; i++) {
        lv_obj_t *child = lv_obj_get_child(parent, i);
        if (child == NULL) {
            continue;
        }
        if (!lv_obj_has_class(child, &lv_label_class)) {
            ui_label_report(child, depth + 1, index, missing_total);
            continue;
        }
        const char *text = lv_label_get_text(child);
        /* 要的是「实际生效」的字体，不是我们请求的那个。 */
        const lv_font_t *font = lv_obj_get_style_text_font(child, LV_PART_MAIN);
        const char *role = font == &tihu_font_20 ? "标题"
                           : font == &tihu_font_15 ? "正文"
                                                   : "非中文字体";
        char missing[32] = {0};
        int total = 0;
        int miss = label_missing_chars(font, text, missing, sizeof(missing), &total);
        (*index)++;
        *missing_total += miss;
        ESP_LOGI(TAG, "label #%d %s font=%s bpp=%d 字数=%d 缺字=%d text=\"%s\"",
                 *index, role, font_name(font), font_bpp(font), total, miss,
                 text != NULL ? text : "");
        if (miss > 0) {
            ESP_LOGE(TAG, "label #%d 用 %s(bpp=%d) 画不出「%s」→ 屏上会是空心方框",
                     *index, font_name(font), font_bpp(font), missing);
        }
    }
}

/* 把码点写成 UTF-8；日志和抽查字符串用得到。 */
static size_t utf8_encode(uint32_t cp, char *out)
{
    if (cp < 0x80u) {
        out[0] = (char)cp;
        return 1;
    }
    if (cp < 0x800u) {
        out[0] = (char)(0xC0u | (cp >> 6));
        out[1] = (char)(0x80u | (cp & 0x3Fu));
        return 2;
    }
    if (cp < 0x10000u) {
        out[0] = (char)(0xE0u | (cp >> 12));
        out[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        out[2] = (char)(0x80u | (cp & 0x3Fu));
        return 3;
    }
    out[0] = (char)(0xF0u | (cp >> 18));
    out[1] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
    out[2] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
    out[3] = (char)(0x80u | (cp & 0x3Fu));
    return 4;
}

/* 字库实际能画出字符表里多少个码位（0 表示整表覆盖）。 */
static unsigned font_coverage(const lv_font_t *font)
{
    unsigned hit = 0;
    for (uint32_t i = 0; i < TIHU_CHARSET_COUNT; i++) {
        lv_font_glyph_dsc_t dsc = {0};
        if (lv_font_get_glyph_dsc(font, &dsc, tihu_charset_cps[i], 0)) {
            hit++;
        }
    }
    return hit;
}

static void missing_append(char *buf, size_t cap, size_t *used, uint32_t cp)
{
    char one[5] = {0};
    size_t len = utf8_encode(cp, one);
    if (*used + len < cap) {
        memcpy(buf + *used, one, len);
        *used += len;
        buf[*used] = '\0';
    }
}

/*
 * 完成页正文是宿主任意的中文，固定文案全命中不代表够用。随机抽 50 个字，
 * 两套字库都要取得到字形——缺字在屏上就是空心方框，只有抽查能提前发现。
 */
static bool ui_font_random_probe(const lv_font_t *a, const lv_font_t *b)
{
    enum { SAMPLES = 50 };
    uint16_t picked[SAMPLES];
    int n = 0;
    while (n < SAMPLES) {
        uint16_t cp = tihu_charset_cps[esp_random() % TIHU_CHARSET_COUNT];
        bool dup = false;
        for (int i = 0; i < n; i++) {
            if (picked[i] == cp) {
                dup = true;
                break;
            }
        }
        if (!dup) {
            picked[n++] = cp;
        }
    }

    char text[SAMPLES * 4 + 1];
    size_t used = 0;
    char miss_a[64] = {0};
    char miss_b[64] = {0};
    size_t used_a = 0;
    size_t used_b = 0;
    for (int i = 0; i < n; i++) {
        used += utf8_encode(picked[i], text + used);
        lv_font_glyph_dsc_t dsc = {0};
        if (!lv_font_get_glyph_dsc(a, &dsc, picked[i], 0)) {
            missing_append(miss_a, sizeof(miss_a), &used_a, picked[i]);
        }
        dsc = (lv_font_glyph_dsc_t){0};
        if (!lv_font_get_glyph_dsc(b, &dsc, picked[i], 0)) {
            missing_append(miss_b, sizeof(miss_b), &used_b, picked[i]);
        }
    }
    text[used] = '\0';

    bool ok = used_a == 0 && used_b == 0;
    ESP_LOGI(TAG, "字形抽查 50 字（随机）：%s", text);
    if (ok) {
        ESP_LOGI(TAG, "字形抽查 PASS：50/50 在 tihu_font_20 与 tihu_font_15 都能取到字形");
    } else {
        ESP_LOGE(TAG, "字形抽查 FAIL：tihu_font_20 缺「%s」，tihu_font_15 缺「%s」",
                 miss_a, miss_b);
    }
    return ok;
}

static void ui_font_selftest(lv_obj_t *root)
{
    const lv_font_t *fonts[2] = {&tihu_font_20, &tihu_font_15};
    for (int i = 0; i < 2; i++) {
        const lv_font_t *font = fonts[i];
        const lv_font_fmt_txt_dsc_t *dsc = font_txt_dsc(font);
        unsigned covered = font_coverage(font);
        /* 规模按「字库实际能画多少字」报，不按生成表里的行数报。 */
        ESP_LOGI(TAG, "字库 %s：%u 字，bpp=%d，%s，line_height=%d（GB2312 全集 %u 码位 + 生僻补充，覆盖 %u/%u）",
                 font_name(font), covered, font_bpp(font), font_bitmap_format(font),
                 (int)font->line_height, (unsigned)TIHU_CHARSET_COUNT, covered,
                 (unsigned)TIHU_CHARSET_COUNT);
        if (covered < TIHU_CHARSET_COUNT) {
            ESP_LOGE(TAG, "字库 %s 覆盖不全：还差 %u 个字（生成字符表与 .c 不一致？）",
                     font_name(font), (unsigned)(TIHU_CHARSET_COUNT - covered));
        }
        if (dsc != NULL && dsc->bitmap_format != LV_FONT_FMT_TXT_PLAIN &&
            LV_USE_FONT_COMPRESSED == 0) {
            ESP_LOGE(TAG, "字库 %s 的位图是压缩格式，但固件没开 LV_USE_FONT_COMPRESSED："
                          "字形能找到、位图取不出来，整屏都会是空心方框",
                     font_name(font));
        }
    }

    lv_font_glyph_dsc_t probe = {0};
    bool has = lv_font_get_glyph_dsc(&tihu_font_20, &probe, TIHU_PROBE_GLYPH, 0);
    ESP_LOGI(TAG, "字形断言：「鹈」U+%04X in tihu_font_20 = %s（box=%dx%d adv=%d）",
             (unsigned)TIHU_PROBE_GLYPH, has ? "存在" : "缺失",
             (int)probe.box_w, (int)probe.box_h, (int)probe.adv_w);
    if (!has) {
        ESP_LOGE(TAG, "字形断言失败：「鹈」不在 tihu_font_20 里，标题「鹈鹕 BOX-3B」必是空心方框");
    }
    assert(has);

    /* 完成页正文是宿主任意中文，固定文案全命中也不代表够用：随机抽 50 个字，
     * 两套字库都必须取得到字形。 */
    ui_font_random_probe(&tihu_font_20, &tihu_font_15);

    int index = 0;
    int missing = 0;
    ui_label_report(root, 0, &index, &missing);
    if (missing == 0) {
        ESP_LOGI(TAG, "字体自检 PASS：%d 个 label 全部命中字库（20=标题 / 15=正文）", index);
    } else {
        ESP_LOGE(TAG, "字体自检 FAIL：%d 个 label 共 %d 个字画不出来，见上面的 label 行", index,
                 missing);
    }
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
    /*
     * 屏幕按钮的唯一出口：screen.gesture{tap, hit:"action", actionId}。
     * 字段名与宿主 src/tihu/protocol.ts 的 parseUpstream('screen.gesture') 分支逐字对齐：
     *   action 只能是 "tap"；hit 只能是 screen/action/task；actionId ≤32 字符。
     * 这三个 id 用宿主完成页 actions 的原名（stop / replay / taskBoard），不自造。
     */
    ESP_LOGI("ui", "发送 screen.gesture action=tap x=%d y=%d hit=action actionId=%s taskId=%s",
             x, y, action_id != NULL ? action_id : "", task_id != NULL ? task_id : "");
    bool ok = tihu_net_send_tap(x, y, "action", action_id, task_id);
    /* 发送结果必须进串口：这是「点了没反应」唯一能定位到的一行。 */
    ESP_LOGI("ui", "screen.gesture 发送结果=%s actionId=%s（WS=%s）",
             ok ? "成功" : "失败", action_id != NULL ? action_id : "",
             s_connected ? "已连接" : "未连接");
    if (!ok) {
        ESP_LOGW("ui", "screen.gesture 没发出去（WebSocket 未连接？）actionId=%s",
                 action_id != NULL ? action_id : "");
    }
}

const char *tihu_ui_connection_text(void)
{
    return s_conn_text;
}

bool tihu_ui_connected(void)
{
    return s_connected;
}

/* ------------------------------ 显示 + 触摸启动 ------------------------------ */

/**
 * 自己起显示，不用 bsp_display_start_with_config()。
 *
 * 两个必须绕开的坑（都来自 BSP / esp_lvgl_port，改不动）：
 *   1) bsp_display_start_with_config() → bsp_display_indev_init() 里触摸初始化失败会
 *      直接让**整个显示启动**返回 NULL（屏不亮），而我们需要「触摸坏了屏还亮」；
 *   2) 它的触摸 indev 读回调里包了 ESP_ERROR_CHECK(esp_lcd_touch_read_data(...))，
 *      GT911 读一次 NACK 就 abort() 重启（实测上电第一次读必 NACK）。
 * 所以显示自己起（配置逐项照抄 BSP 的 bsp_display_lcd_init），触摸交给 tihu_touch.c。
 */
static lv_display_t *tihu_display_init(void)
{
    /*
     * 不用 BSP 默认的 7 KB LVGL 任务栈：7 KB 画中文 + 一次性建三屏很容易踩到栈顶，
     * 这里提到 12 KB、tick 周期锁 5 ms。
     */
    lvgl_port_cfg_t port_cfg = ESP_LVGL_PORT_INIT_CONFIG();
    port_cfg.task_stack = 12 * 1024;
    port_cfg.timer_period_ms = 5;
    port_cfg.task_max_sleep_ms = 500;

    esp_err_t err = lvgl_port_init(&port_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "lvgl_port_init 失败：%s", esp_err_to_name(err));
        return NULL;
    }

    const bsp_display_config_t bus_cfg = {
        .max_transfer_sz = (BSP_LCD_H_RES * CONFIG_BSP_LCD_DRAW_BUF_HEIGHT) * sizeof(uint16_t),
    };
    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_io_handle_t io = NULL;
    err = bsp_display_new(&bus_cfg, &panel, &io);
    if (err != ESP_OK || panel == NULL || io == NULL) {
        ESP_LOGE(TAG, "bsp_display_new 失败：%s（panel=%p io=%p）",
                 esp_err_to_name(err), (void *)panel, (void *)io);
        return NULL;
    }
    esp_lcd_panel_disp_on_off(panel, true);

    /*
     * 注意：**不要**手动给 GT911 打硬件复位（RST 与 LCD 共用 GPIO48）。
     * 实测（2026-11-11）：加「INT 低 + RST 低 10 ms」这一手之后，GT911 再也不应答
     * I2C（bsp_touch_new 连续 3 次 ESP_ERR_NOT_FOUND），比不复位还糟。
     * 触摸芯片保持 BSP 的上电状态；初始化失败只降级，不影响屏幕。
     */

    bool double_buffer = false;
#if CONFIG_BSP_LCD_DRAW_BUF_DOUBLE
    double_buffer = true;
#endif
    const lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = io,
        .panel_handle = panel,
        .buffer_size = BSP_LCD_H_RES * CONFIG_BSP_LCD_DRAW_BUF_HEIGHT,
        .double_buffer = double_buffer,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
        .monochrome = false,
        /* 必须与 BSP bsp_display_lcd_init() 一致：面板在 esp_lcd 里做了 180° 镜像。 */
        .rotation = {
            .swap_xy = false,
            .mirror_x = true,
            .mirror_y = true,
        },
#if LVGL_VERSION_MAJOR >= 9
        .color_format = LV_COLOR_FORMAT_RGB565,
#endif
        .flags = {
            .buff_dma = true,
            .buff_spiram = false,
#if LVGL_VERSION_MAJOR >= 9
            .swap_bytes = (BSP_LCD_BIGENDIAN ? true : false),
#endif
        },
    };

    lv_display_t *disp = lvgl_port_add_disp(&disp_cfg);
    if (disp == NULL) {
        ESP_LOGE(TAG, "lvgl_port_add_disp 失败：屏幕无法启动");
        return NULL;
    }
    ESP_LOGI(TAG, "显示就绪：%p %dx%d，color=%d，draw buf=%d px，dbl=%d",
             (void *)disp,
             (int)lv_display_get_horizontal_resolution(disp),
             (int)lv_display_get_vertical_resolution(disp),
             (int)lv_display_get_color_format(disp),
             (int)disp_cfg.buffer_size, (int)double_buffer);
    ESP_LOGI(TAG, "LVGL 任务：栈 %d B / 优先级 %d / tick %d ms",
             12000, (int)port_cfg.task_priority, (int)port_cfg.timer_period_ms);
    return disp;
}

/* ------------------------------ 对外入口 ------------------------------ */

void tihu_ui_init(void)
{
    lv_display_t *disp = tihu_display_init();
    if (disp == NULL) {
        ESP_LOGE(TAG, "显示启动失败：检查 BSP/PSRAM 配置");
        return;
    }
    /* 探针要尽早挂：后面每一帧的 flush 都记进计数。 */
    s_raw_flush = lv_display_get_flush_cb(disp);
    lv_display_set_flush_cb(disp, flush_probe_cb);
    ESP_LOGI(TAG, "flush 探针已挂（原回调 %p）", (void *)s_raw_flush);

    /* 触摸单独起：3 次重试，失败只降级，不影响屏幕与点击以外的功能。 */
    tihu_touch_init(disp);

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
    /* 字体自检放在 unlock 之前：所有 label 都已创建并设好初始文案。 */
    ui_font_selftest(scr);
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
