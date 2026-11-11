/**
 * 鹈鹕（tihu）协议 v0 —— 固件侧线格式。
 *
 * 与 D:\dsh-assistant\src\tihu\protocol.ts 对齐：
 *   - 信封 { v:"0", type, id, seq, ts, payload }；
 *   - 字段只增不删，未知 type 一律忽略；
 *   - 上行：hello / text.input / audio.frame / screen.gesture / session.end /
 *           device.ack / playback.state / ping；
 *   - 下行：screen.frame / tts.audio / playback.control / voice.listen /
 *           device.config / session.ended / pong（其余已知类型忽略）。
 *
 * 本文件只负责 JSON 构造与解析，不碰网络、不碰屏、不碰音频。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TIHU_PROTOCOL_VERSION "0"

#define TIHU_MAX_BULLETS      4
#define TIHU_MAX_ACTIONS      4
#define TIHU_MAX_BOARD_ROWS   4
#define TIHU_MAX_DONE_LINES   7
#define TIHU_TEXT_MAX         160
#define TIHU_TITLE_MAX        160
#define TIHU_ID_MAX           64
#define TIHU_OP_ID_MAX        128

/** 屏上动作按钮（完成页的 停止/重读/主页 等）。 */
typedef struct {
    char id[32];
    char label[32];
} tihu_action_t;

/** 棋盘一行：状态胶囊 + 标题 + 副行 + 右侧状态环。 */
typedef struct {
    char task_id[48];
    char title[TIHU_TEXT_MAX];
    char state[20];
    char capsule[24];
    char sub[TIHU_TEXT_MAX];
    int  ring_percent;              /* 0–100，宿主给的是 0–1，这里换算成百分比 */
    char ring_tone[16];             /* normal / warn / done / empty */
    bool badge_ask;
    int  subagents;
    bool blink;
} tihu_board_row_t;

typedef struct {
    bool present;
    tihu_board_row_t rows[TIHU_MAX_BOARD_ROWS];
    int  row_count;
    int  running;
    int  awaiting;
    int  queued;
    int  done;
    int  page_index;                /* 0 起 */
    int  page_total;
    int  total;
    bool empty;
} tihu_board_t;

typedef struct {
    bool present;
    char lines[TIHU_MAX_DONE_LINES][TIHU_TEXT_MAX];
    int  line_count;
    int  current;
} tihu_done_t;

/** 一帧 screen.frame 的固件投影（只保留固件会画/会用的字段）。 */
typedef struct {
    char stage[48];
    char title[TIHU_TITLE_MAX];
    char bullets[TIHU_MAX_BULLETS][TIHU_TEXT_MAX];
    int  bullet_count;
    bool has_progress;
    int  progress_done;
    int  progress_total;
    char tone[12];                  /* idle / busy / ok / alert / warn */
    char mode[12];                  /* home / status */
    tihu_action_t actions[TIHU_MAX_ACTIONS];
    int  action_count;
    int  stats_tail;
    bool has_board;
    tihu_board_t board;
    bool has_done;
    tihu_done_t done;
    char task_id[48];
    char op_id[TIHU_OP_ID_MAX];
    int  frame_seq;
} tihu_screen_frame_t;

/** 下行 tts.audio：解析后已经把 base64 解成 PCM。 */
typedef struct {
    int  seq;
    int  total;
    int  sample_rate;
    int  channels;
    int  index;                     /* 段号，0 起 */
    bool final;
    bool read_done;                 /* payload.read == "done" */
    bool sample;                    /* 试听，不写进正文高亮 */
    uint8_t *pcm;                   /* 调用方用 tihu_downstream_free() 释放 */
    size_t   pcm_len;
} tihu_tts_audio_t;

typedef struct {
    char op_id[TIHU_OP_ID_MAX];
    char action[16];                /* stop / pause / resume / seek */
    char scope[16];                 /* round / all */
    int  epoch;
    bool has_from;
    char from_task_id[48];
    int  from_segment;              /* 1 起 */
    int  from_line;                 /* 0 起 */
} tihu_playback_control_t;

typedef struct {
    char op_id[TIHU_OP_ID_MAX];
    bool on;
    char prompt[96];
    int  timeout_ms;
} tihu_voice_listen_t;

typedef struct {
    char op_id[TIHU_OP_ID_MAX];
    char key[32];                   /* voice / handsfree / scale */
    char value[96];
    bool value_is_bool;
    bool value_bool;
} tihu_device_config_t;

typedef struct {
    char op_id[TIHU_OP_ID_MAX];
    char session_id[64];
    char reason[96];
    int64_t at;
} tihu_session_ended_t;

typedef struct {
    char text[TIHU_TEXT_MAX];
    bool final;
    char source[16];
} tihu_transcript_t;

typedef struct {
    char level[16];
    char text[TIHU_TEXT_MAX];
} tihu_alert_t;

typedef struct {
    char stage[32];
    char text[TIHU_TEXT_MAX];
    int  done;
    int  total;
} tihu_progress_t;

typedef struct {
    char nonce[64];
} tihu_pong_t;

typedef enum {
    TIHU_DOWN_UNKNOWN = 0,
    TIHU_DOWN_SCREEN_FRAME,
    TIHU_DOWN_TTS_AUDIO,
    TIHU_DOWN_PLAYBACK_CONTROL,
    TIHU_DOWN_VOICE_LISTEN,
    TIHU_DOWN_DEVICE_CONFIG,
    TIHU_DOWN_SESSION_ENDED,
    TIHU_DOWN_TRANSCRIPT,
    TIHU_DOWN_EVENT_ALERT,
    TIHU_DOWN_EVENT_PROGRESS,
    TIHU_DOWN_PONG,
} tihu_down_type_t;

/** 一条下行消息的解析结果。union 里只有 tts.pcm 需要释放。 */
typedef struct {
    tihu_down_type_t type;
    char type_name[48];
    char id[TIHU_ID_MAX];
    int  seq;
    int64_t ts;
    union {
        tihu_screen_frame_t     screen;
        tihu_tts_audio_t        tts;
        tihu_playback_control_t playback;
        tihu_voice_listen_t     listen;
        tihu_device_config_t    config;
        tihu_session_ended_t    ended;
        tihu_transcript_t       transcript;
        tihu_alert_t            alert;
        tihu_progress_t         progress;
        tihu_pong_t             pong;
    } u;
} tihu_downstream_t;

/* ---------- 构造（返回 malloc 的 JSON 文本，用 tihu_free_message 释放） ---------- */

char *tihu_build_hello(const char *client_id, const char *device_name);
char *tihu_build_text_input(const char *text, const char *source);
/** 试听请求：宿主用当前音色合成一句样例并以 tts.audio(sample=true) 回来（音频自检用）。 */
char *tihu_build_tts_sample(const char *text);
char *tihu_build_audio_frame(const uint8_t *wav, size_t wav_len, int duration_ms);
char *tihu_build_screen_tap(int x, int y, const char *hit,
                            const char *action_id, const char *task_id);
char *tihu_build_session_end(const char *reason);
char *tihu_build_device_ack(const char *op_id, bool ok, const char *reason,
                            const char *stage, int screen_version);
char *tihu_build_playback_state(const char *phase, const char *task_id,
                                int segment, int line, int total, int char_start);
char *tihu_build_ping(void);
void  tihu_free_message(char *json);

/* ---------- 解析 ---------- */

/**
 * 解析一条下行文本。
 *
 * 返回值：信封合法返回 true（未知 type 也返回 true，type=UNKNOWN），
 * 坏 JSON / 缺 v,type,id,seq,ts,payload 返回 false。
 * 解析前会 memset(out)；tts.pcm 需要 tihu_downstream_free() 释放。
 */
bool tihu_parse_downstream(const char *json, size_t len, tihu_downstream_t *out);
void tihu_downstream_free(tihu_downstream_t *msg);

/** 毫秒时间戳（设备本地时钟，宿主只用于日志）。 */
int64_t tihu_protocol_now_ms(void);
