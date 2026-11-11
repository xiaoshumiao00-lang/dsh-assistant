/**
 * 鹈鹕协议 v0 的固件实现。
 *
 * 设计纪律与宿主 src/tihu/protocol.ts 一致：
 *   - 所有上行都走同一个信封，seq 单调递增；
 *   - 解析下行时只认必需字段，未知 type 不报错、直接忽略；
 *   - 文本一律按 UTF-8 边界截断，避免把半个汉字写进屏里。
 */
#include "tihu_protocol.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "mbedtls/base64.h"

static const char *TAG = "tihu_proto";
static uint32_t s_seq;

int64_t tihu_protocol_now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

/**
 * 按 UTF-8 边界复制，超长时截到最后一个完整字符。
 * 宿主已经按像素裁过一次，这里只是防坏帧/超长帧把定长数组写爆。
 */
static void copy_str(char *dst, size_t cap, const char *src)
{
    if (dst == NULL || cap == 0) {
        return;
    }
    if (src == NULL) {
        src = "";
    }
    size_t n = strlen(src);
    if (n >= cap) {
        n = cap - 1;
        while (n > 0 && (((unsigned char)src[n]) & 0xC0) == 0x80) {
            n--;
        }
    }
    memcpy(dst, src, n);
    dst[n] = '\0';
}

static const char *json_string(const cJSON *obj, const char *key, const char *fallback)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        return item->valuestring;
    }
    return fallback;
}

static int json_int(const cJSON *obj, const char *key, int fallback)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsNumber(item)) {
        return (int)item->valuedouble;
    }
    return fallback;
}

static bool json_bool(const cJSON *obj, const char *key, bool fallback)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsBool(item)) {
        return cJSON_IsTrue(item);
    }
    if (cJSON_IsNumber(item)) {
        return item->valuedouble != 0;
    }
    return fallback;
}

static void make_id(char *out, size_t cap, const char *prefix)
{
    snprintf(out, cap, "%s-%08lx-%u", prefix,
             (unsigned long)esp_random(), (unsigned)s_seq);
}

/** 新建信封；所有上行构造都从这里开始。 */
static cJSON *new_envelope(const char *type)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return NULL;
    }
    s_seq++;
    char id[TIHU_ID_MAX];
    make_id(id, sizeof(id), "dev");
    cJSON_AddStringToObject(root, "v", TIHU_PROTOCOL_VERSION);
    cJSON_AddStringToObject(root, "type", type);
    cJSON_AddStringToObject(root, "id", id);
    cJSON_AddNumberToObject(root, "seq", (double)s_seq);
    cJSON_AddNumberToObject(root, "ts", (double)tihu_protocol_now_ms());
    return root;
}

static char *finish(cJSON *root)
{
    if (root == NULL) {
        return NULL;
    }
    char *out = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    return out;
}

void tihu_free_message(char *json)
{
    if (json != NULL) {
        cJSON_free(json);
    }
}

/* ============================ 上行构造 ============================ */

char *tihu_build_hello(const char *client_id, const char *device_name)
{
    cJSON *root = new_envelope("hello");
    if (root == NULL) {
        return NULL;
    }
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    cJSON_AddStringToObject(payload, "clientId", client_id != NULL ? client_id : "esp32-box3");
    cJSON_AddStringToObject(payload, "clientVersion", "esp32-box3-" TIHU_PROTOCOL_VERSION);
    cJSON_AddStringToObject(payload, "protocol", TIHU_PROTOCOL_VERSION);
    cJSON_AddStringToObject(payload, "deviceName", device_name != NULL ? device_name : "鹈鹕 BOX-3B");
    cJSON *caps = cJSON_AddObjectToObject(payload, "capabilities");
    cJSON_AddBoolToObject(caps, "screen", true);
    cJSON_AddBoolToObject(caps, "tts", true);
    cJSON_AddBoolToObject(caps, "microphone", true);
    cJSON_AddBoolToObject(caps, "speaker", true);
    return finish(root);
}

char *tihu_build_text_input(const char *text, const char *source)
{
    cJSON *root = new_envelope("text.input");
    if (root == NULL) {
        return NULL;
    }
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    cJSON_AddStringToObject(payload, "text", text != NULL ? text : "");
    if (source != NULL && source[0] != '\0') {
        cJSON_AddStringToObject(payload, "source", source);
    }
    return finish(root);
}

char *tihu_build_tts_sample(const char *text)
{
    cJSON *root = new_envelope("tts.sample");
    if (root == NULL) {
        return NULL;
    }
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    cJSON_AddStringToObject(payload, "text", text != NULL ? text : "");
    return finish(root);
}

char *tihu_build_audio_frame(const uint8_t *wav, size_t wav_len, int duration_ms)
{
    if (wav == NULL || wav_len == 0) {
        return NULL;
    }
    size_t b64_cap = 4 * ((wav_len + 2) / 3) + 1;
    unsigned char *b64 = heap_caps_malloc(b64_cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (b64 == NULL) {
        b64 = malloc(b64_cap);
    }
    if (b64 == NULL) {
        ESP_LOGE(TAG, "audio.frame: base64 缓冲分配失败 (%u 字节)", (unsigned)b64_cap);
        return NULL;
    }
    size_t b64_len = 0;
    int rc = mbedtls_base64_encode(b64, b64_cap, &b64_len, wav, wav_len);
    if (rc != 0) {
        ESP_LOGE(TAG, "audio.frame: base64 编码失败 rc=%d", rc);
        free(b64);
        return NULL;
    }
    /* mbedtls 不写结尾 NUL，cJSON_AddStringToObject 依赖 strlen。 */
    b64[b64_len] = '\0';

    cJSON *root = new_envelope("audio.frame");
    if (root == NULL) {
        free(b64);
        return NULL;
    }
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    cJSON_AddStringToObject(payload, "format", "wav");
    cJSON_AddNumberToObject(payload, "sampleRate", 16000);
    cJSON_AddNumberToObject(payload, "channels", 1);
    cJSON_AddNumberToObject(payload, "bits", 16);
    cJSON_AddStringToObject(payload, "audioBase64", (const char *)b64);
    cJSON_AddNumberToObject(payload, "durationMs", duration_ms > 0 ? duration_ms : 0);
    free(b64);
    return finish(root);
}

char *tihu_build_screen_tap(int x, int y, const char *hit,
                            const char *action_id, const char *task_id)
{
    cJSON *root = new_envelope("screen.gesture");
    if (root == NULL) {
        return NULL;
    }
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    cJSON_AddStringToObject(payload, "action", "tap");
    cJSON_AddNumberToObject(payload, "x", x < 0 ? 0 : (x > 320 ? 320 : x));
    cJSON_AddNumberToObject(payload, "y", y < 0 ? 0 : (y > 240 ? 240 : y));
    if (hit != NULL && hit[0] != '\0') {
        cJSON_AddStringToObject(payload, "hit", hit);
    }
    if (action_id != NULL && action_id[0] != '\0') {
        cJSON_AddStringToObject(payload, "actionId", action_id);
    }
    if (task_id != NULL && task_id[0] != '\0') {
        cJSON_AddStringToObject(payload, "taskId", task_id);
    }
    return finish(root);
}

char *tihu_build_session_end(const char *reason)
{
    cJSON *root = new_envelope("session.end");
    if (root == NULL) {
        return NULL;
    }
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    if (reason != NULL && reason[0] != '\0') {
        cJSON_AddStringToObject(payload, "reason", reason);
    }
    return finish(root);
}

char *tihu_build_device_ack(const char *op_id, bool ok, const char *reason,
                            const char *stage, int screen_version)
{
    if (op_id == NULL || op_id[0] == '\0') {
        /* 没有 opId 的控制不需要回执；返回 NULL 让调用方安静跳过。 */
        return NULL;
    }
    cJSON *root = new_envelope("device.ack");
    if (root == NULL) {
        return NULL;
    }
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    cJSON_AddStringToObject(payload, "opId", op_id);
    cJSON_AddBoolToObject(payload, "ok", ok);
    if (reason != NULL && reason[0] != '\0') {
        cJSON_AddStringToObject(payload, "reason", reason);
    }
    if (stage != NULL && stage[0] != '\0') {
        cJSON_AddStringToObject(payload, "stage", stage);
    }
    if (screen_version >= 0) {
        cJSON_AddNumberToObject(payload, "screenVersion", screen_version);
    }
    return finish(root);
}

char *tihu_build_playback_state(const char *phase, const char *task_id,
                                int segment, int line, int total, int char_start)
{
    cJSON *root = new_envelope("playback.state");
    if (root == NULL) {
        return NULL;
    }
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    cJSON_AddStringToObject(payload, "phase", phase != NULL ? phase : "idle");
    if (task_id != NULL && task_id[0] != '\0') {
        cJSON_AddStringToObject(payload, "taskId", task_id);
    }
    if (segment > 0) {
        cJSON_AddNumberToObject(payload, "segment", segment);
    }
    if (line >= 0) {
        cJSON_AddNumberToObject(payload, "line", line);
    }
    if (total > 0) {
        cJSON_AddNumberToObject(payload, "total", total);
    }
    if (char_start >= 0) {
        cJSON_AddNumberToObject(payload, "charStart", char_start);
    }
    cJSON_AddNumberToObject(payload, "at", (double)tihu_protocol_now_ms());
    return finish(root);
}

char *tihu_build_ping(void)
{
    cJSON *root = new_envelope("ping");
    if (root == NULL) {
        return NULL;
    }
    char nonce[32];
    snprintf(nonce, sizeof(nonce), "%08lx", (unsigned long)esp_random());
    cJSON *payload = cJSON_AddObjectToObject(root, "payload");
    cJSON_AddStringToObject(payload, "nonce", nonce);
    return finish(root);
}

/* ============================ 下行解析 ============================ */

static void parse_actions(const cJSON *payload, tihu_screen_frame_t *f)
{
    const cJSON *actions = cJSON_GetObjectItemCaseSensitive(payload, "actions");
    if (!cJSON_IsArray(actions)) {
        return;
    }
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, actions) {
        if (f->action_count >= TIHU_MAX_ACTIONS) {
            break;
        }
        tihu_action_t *action = &f->actions[f->action_count];
        copy_str(action->id, sizeof(action->id), json_string(item, "id", ""));
        copy_str(action->label, sizeof(action->label), json_string(item, "label", ""));
        if (action->id[0] != '\0') {
            f->action_count++;
        }
    }
}

static void parse_board(const cJSON *payload, tihu_screen_frame_t *f)
{
    const cJSON *board = cJSON_GetObjectItemCaseSensitive(payload, "board");
    if (!cJSON_IsObject(board)) {
        return;
    }
    tihu_board_t *b = &f->board;
    f->has_board = true;
    b->present = true;
    b->empty = json_bool(board, "empty", false);
    b->total = json_int(board, "total", 0);
    const cJSON *counts = cJSON_GetObjectItemCaseSensitive(board, "counts");
    if (cJSON_IsObject(counts)) {
        b->running = json_int(counts, "running", 0);
        b->awaiting = json_int(counts, "awaiting", 0);
        b->queued = json_int(counts, "queued", 0);
        b->done = json_int(counts, "done", 0);
    }
    const cJSON *page = cJSON_GetObjectItemCaseSensitive(board, "page");
    if (cJSON_IsObject(page)) {
        b->page_index = json_int(page, "index", 0);
        b->page_total = json_int(page, "total", 1);
    } else {
        b->page_total = 1;
    }
    if (b->page_total < 1) {
        b->page_total = 1;
    }

    const cJSON *rows = cJSON_GetObjectItemCaseSensitive(board, "rows");
    if (!cJSON_IsArray(rows)) {
        return;
    }
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, rows) {
        if (b->row_count >= TIHU_MAX_BOARD_ROWS) {
            break;
        }
        tihu_board_row_t *row = &b->rows[b->row_count];
        copy_str(row->task_id, sizeof(row->task_id), json_string(item, "taskId", ""));
        copy_str(row->title, sizeof(row->title), json_string(item, "title", ""));
        copy_str(row->state, sizeof(row->state), json_string(item, "state", "queued"));
        copy_str(row->capsule, sizeof(row->capsule), json_string(item, "capsule", ""));
        copy_str(row->sub, sizeof(row->sub), json_string(item, "sub", ""));
        const cJSON *ring = cJSON_GetObjectItemCaseSensitive(item, "ring");
        if (cJSON_IsObject(ring)) {
            double percent = 0;
            const cJSON *p = cJSON_GetObjectItemCaseSensitive(ring, "percent");
            if (cJSON_IsNumber(p)) {
                percent = p->valuedouble;
            }
            if (percent < 0) {
                percent = 0;
            }
            if (percent > 1) {
                percent = 1;
            }
            row->ring_percent = (int)(percent * 100.0 + 0.5);
            copy_str(row->ring_tone, sizeof(row->ring_tone), json_string(ring, "tone", "empty"));
        }
        const char *badge = json_string(item, "badge", "");
        row->badge_ask = strcmp(badge, "ask") == 0;
        row->subagents = json_int(item, "subagents", 0);
        row->blink = json_bool(item, "blink", false);
        if (row->task_id[0] != '\0') {
            b->row_count++;
        }
    }
}

static void parse_done(const cJSON *payload, tihu_screen_frame_t *f)
{
    const cJSON *done = cJSON_GetObjectItemCaseSensitive(payload, "done");
    if (!cJSON_IsObject(done)) {
        return;
    }
    f->has_done = true;
    f->done.present = true;
    f->done.current = json_int(done, "current", 0);
    const cJSON *lines = cJSON_GetObjectItemCaseSensitive(done, "lines");
    if (!cJSON_IsArray(lines)) {
        return;
    }
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, lines) {
        if (f->done.line_count >= TIHU_MAX_DONE_LINES) {
            break;
        }
        if (cJSON_IsString(item) && item->valuestring != NULL) {
            copy_str(f->done.lines[f->done.line_count], TIHU_TEXT_MAX, item->valuestring);
            f->done.line_count++;
        }
    }
    if (f->done.current < 0) {
        f->done.current = 0;
    }
    if (f->done.line_count > 0 && f->done.current >= f->done.line_count) {
        f->done.current = f->done.line_count - 1;
    }
}

static void parse_screen(const cJSON *payload, tihu_screen_frame_t *f)
{
    copy_str(f->stage, sizeof(f->stage), json_string(payload, "stage", ""));
    copy_str(f->title, sizeof(f->title), json_string(payload, "title", ""));
    copy_str(f->tone, sizeof(f->tone), json_string(payload, "tone", "idle"));
    copy_str(f->mode, sizeof(f->mode), json_string(payload, "mode", "status"));
    copy_str(f->task_id, sizeof(f->task_id), json_string(payload, "taskId", ""));
    copy_str(f->op_id, sizeof(f->op_id), json_string(payload, "opId", ""));
    f->frame_seq = json_int(payload, "frameSeq", -1);
    f->stats_tail = json_int(payload, "statsTail", 0);

    const cJSON *bullets = cJSON_GetObjectItemCaseSensitive(payload, "bullets");
    if (cJSON_IsArray(bullets)) {
        const cJSON *item = NULL;
        cJSON_ArrayForEach(item, bullets) {
            if (f->bullet_count >= TIHU_MAX_BULLETS) {
                break;
            }
            if (cJSON_IsString(item) && item->valuestring != NULL) {
                copy_str(f->bullets[f->bullet_count], TIHU_TEXT_MAX, item->valuestring);
                f->bullet_count++;
            }
        }
    }
    const cJSON *progress = cJSON_GetObjectItemCaseSensitive(payload, "progress");
    if (cJSON_IsObject(progress)) {
        f->has_progress = true;
        f->progress_done = json_int(progress, "done", 0);
        f->progress_total = json_int(progress, "total", 0);
    }
    parse_actions(payload, f);
    parse_board(payload, f);
    parse_done(payload, f);
}

static bool decode_tts_pcm(const cJSON *payload, tihu_tts_audio_t *tts)
{
    const char *format = json_string(payload, "format", "pcm16");
    if (strcmp(format, "pcm16") != 0) {
        ESP_LOGW(TAG, "tts.audio 格式不支持：%s", format);
        return false;
    }
    tts->sample_rate = json_int(payload, "sampleRate", 0);
    tts->channels = json_int(payload, "channels", 0);
    if (tts->sample_rate != 24000 || tts->channels != 1) {
        ESP_LOGW(TAG, "tts.audio 需要 24k 单声道，收到 %d/%d", tts->sample_rate, tts->channels);
        return false;
    }
    const char *data = json_string(payload, "data", "");
    if (data[0] == '\0') {
        return false;
    }
    size_t data_len = strlen(data);
    size_t cap = (data_len / 4) * 3 + 4;
    uint8_t *pcm = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (pcm == NULL) {
        pcm = malloc(cap);
    }
    if (pcm == NULL) {
        ESP_LOGE(TAG, "tts.audio PCM 缓冲分配失败 (%u 字节)", (unsigned)cap);
        return false;
    }
    size_t out_len = 0;
    int rc = mbedtls_base64_decode(pcm, cap, &out_len,
                                   (const unsigned char *)data, data_len);
    if (rc != 0 || out_len == 0) {
        ESP_LOGW(TAG, "tts.audio base64 解码失败 rc=%d", rc);
        free(pcm);
        return false;
    }
    tts->pcm = pcm;
    tts->pcm_len = out_len;
    return true;
}

static void parse_tts(const cJSON *payload, tihu_tts_audio_t *tts)
{
    tts->seq = json_int(payload, "seq", 0);
    tts->total = json_int(payload, "total", 0);
    tts->index = json_int(payload, "index", 0);
    tts->final = json_bool(payload, "final", false);
    tts->read_done = strcmp(json_string(payload, "read", ""), "done") == 0;
    tts->sample = json_bool(payload, "sample", false);
    (void)decode_tts_pcm(payload, tts);
}

static void parse_playback(const cJSON *payload, tihu_playback_control_t *p)
{
    copy_str(p->op_id, sizeof(p->op_id), json_string(payload, "opId", ""));
    copy_str(p->action, sizeof(p->action), json_string(payload, "action", ""));
    copy_str(p->scope, sizeof(p->scope), json_string(payload, "scope", "round"));
    p->epoch = json_int(payload, "epoch", 0);
    p->from_line = -1;
    const cJSON *from = cJSON_GetObjectItemCaseSensitive(payload, "from");
    if (cJSON_IsObject(from)) {
        p->has_from = true;
        copy_str(p->from_task_id, sizeof(p->from_task_id), json_string(from, "taskId", ""));
        p->from_segment = json_int(from, "segment", 0);
        p->from_line = json_int(from, "line", -1);
    } else {
        p->from_line = -1;
    }
}

bool tihu_parse_downstream(const char *json, size_t len, tihu_downstream_t *out)
{
    if (out == NULL) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    if (json == NULL || len == 0) {
        return false;
    }
    cJSON *root = cJSON_ParseWithLength(json, len);
    if (root == NULL) {
        return false;
    }
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(root, "v");
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(root, "id");
    const cJSON *seq = cJSON_GetObjectItemCaseSensitive(root, "seq");
    const cJSON *ts = cJSON_GetObjectItemCaseSensitive(root, "ts");
    const cJSON *payload = cJSON_GetObjectItemCaseSensitive(root, "payload");
    if (!cJSON_IsString(v) || strcmp(v->valuestring, TIHU_PROTOCOL_VERSION) != 0 ||
        !cJSON_IsString(type) || !cJSON_IsString(id) ||
        !cJSON_IsNumber(seq) || !cJSON_IsNumber(ts) || !cJSON_IsObject(payload)) {
        cJSON_Delete(root);
        return false;
    }
    copy_str(out->id, sizeof(out->id), id->valuestring);
    copy_str(out->type_name, sizeof(out->type_name), type->valuestring);
    out->seq = (int)seq->valuedouble;
    out->ts = (int64_t)ts->valuedouble;

    const char *t = type->valuestring;
    if (strcmp(t, "screen.frame") == 0) {
        out->type = TIHU_DOWN_SCREEN_FRAME;
        parse_screen(payload, &out->u.screen);
    } else if (strcmp(t, "tts.audio") == 0) {
        out->type = TIHU_DOWN_TTS_AUDIO;
        parse_tts(payload, &out->u.tts);
    } else if (strcmp(t, "playback.control") == 0) {
        out->type = TIHU_DOWN_PLAYBACK_CONTROL;
        parse_playback(payload, &out->u.playback);
    } else if (strcmp(t, "voice.listen") == 0) {
        out->type = TIHU_DOWN_VOICE_LISTEN;
        copy_str(out->u.listen.op_id, sizeof(out->u.listen.op_id), json_string(payload, "opId", ""));
        out->u.listen.on = json_bool(payload, "on", false);
        copy_str(out->u.listen.prompt, sizeof(out->u.listen.prompt), json_string(payload, "prompt", ""));
        out->u.listen.timeout_ms = json_int(payload, "timeoutMs", 10000);
    } else if (strcmp(t, "device.config") == 0) {
        out->type = TIHU_DOWN_DEVICE_CONFIG;
        copy_str(out->u.config.op_id, sizeof(out->u.config.op_id), json_string(payload, "opId", ""));
        copy_str(out->u.config.key, sizeof(out->u.config.key), json_string(payload, "key", ""));
        const cJSON *value = cJSON_GetObjectItemCaseSensitive(payload, "value");
        if (cJSON_IsBool(value)) {
            out->u.config.value_is_bool = true;
            out->u.config.value_bool = cJSON_IsTrue(value);
        } else if (cJSON_IsString(value) && value->valuestring != NULL) {
            copy_str(out->u.config.value, sizeof(out->u.config.value), value->valuestring);
        }
    } else if (strcmp(t, "session.ended") == 0) {
        out->type = TIHU_DOWN_SESSION_ENDED;
        copy_str(out->u.ended.op_id, sizeof(out->u.ended.op_id), json_string(payload, "opId", ""));
        copy_str(out->u.ended.session_id, sizeof(out->u.ended.session_id), json_string(payload, "sessionId", ""));
        copy_str(out->u.ended.reason, sizeof(out->u.ended.reason), json_string(payload, "reason", ""));
        out->u.ended.at = (int64_t)json_int(payload, "at", 0);
    } else if (strcmp(t, "transcript") == 0) {
        out->type = TIHU_DOWN_TRANSCRIPT;
        copy_str(out->u.transcript.text, sizeof(out->u.transcript.text), json_string(payload, "text", ""));
        out->u.transcript.final = json_bool(payload, "final", true);
        copy_str(out->u.transcript.source, sizeof(out->u.transcript.source), json_string(payload, "source", ""));
    } else if (strcmp(t, "event.alert") == 0) {
        out->type = TIHU_DOWN_EVENT_ALERT;
        copy_str(out->u.alert.level, sizeof(out->u.alert.level), json_string(payload, "level", "info"));
        copy_str(out->u.alert.text, sizeof(out->u.alert.text), json_string(payload, "text", ""));
    } else if (strcmp(t, "event.progress") == 0) {
        out->type = TIHU_DOWN_EVENT_PROGRESS;
        copy_str(out->u.progress.stage, sizeof(out->u.progress.stage), json_string(payload, "stage", ""));
        copy_str(out->u.progress.text, sizeof(out->u.progress.text), json_string(payload, "text", ""));
        out->u.progress.done = json_int(payload, "done", 0);
        out->u.progress.total = json_int(payload, "total", 0);
    } else if (strcmp(t, "pong") == 0) {
        out->type = TIHU_DOWN_PONG;
        copy_str(out->u.pong.nonce, sizeof(out->u.pong.nonce), json_string(payload, "nonce", ""));
    } else {
        /* 字段只增不删：宿主要发新消息就发，老固件只记一行日志。 */
        out->type = TIHU_DOWN_UNKNOWN;
    }
    cJSON_Delete(root);
    return true;
}

void tihu_downstream_free(tihu_downstream_t *msg)
{
    if (msg == NULL) {
        return;
    }
    if (msg->type == TIHU_DOWN_TTS_AUDIO && msg->u.tts.pcm != NULL) {
        free(msg->u.tts.pcm);
        msg->u.tts.pcm = NULL;
        msg->u.tts.pcm_len = 0;
    }
}
