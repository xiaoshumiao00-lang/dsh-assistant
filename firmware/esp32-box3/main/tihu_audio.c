/**
 * 音频实现：一条播放任务 + 一条录音任务。
 *
 * 为什么播放要单独任务：esp_websocket_client 的回调里不能长时间阻塞，
 * 而 esp_codec_dev_write() 会等 I2S DMA。回调只把 PCM 塞进 StreamBuffer，
 * 真正写 codec 的是 audio_task。
 */
#include "tihu_audio.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "config.h"
#include "tihu_ota.h"
#include "tihu_wake.h"
#include "esp_codec_dev.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "bsp/esp-box-3.h"
#include "driver/i2c_master.h"
#include "esp_codec_dev_defaults.h"
#include "es7210_adc.h"

static const char *TAG = "tihu_audio";

/*
 * 播放缓冲 256 KB（PSRAM）：24k/16bit/mono 约 5.4 秒音频。
 * 0.3.5 从 64 KB 提到 256 KB——手机热点 + VPS 反代的链路经常只能送来 ~20 KB/s（实时要 48 KB/s），
 * 缓冲越大越能吃掉一次几百毫秒的抖动。
 */
#define AUDIO_STREAM_BYTES   (256 * 1024)
#define AUDIO_TASK_STACK     4096
#define AUDIO_TASK_PRIO      5

/*
 * 播放格式固定 24 kHz / 16 bit / 单声道（与宿主 tts.audio 的字段一一对应）。
 * 注意 BSP 的 bsp_audio_init() 默认把 I2S 配成 22050 Hz，靠 esp_codec_dev_open()
 * 重配 I2S 时钟/时隙；所以每次开麦/关麦之后都必须重新 speaker_open_24k()。
 */
#define PLAYBACK_RATE        24000
#define PLAYBACK_CHANNELS    1
#define PLAYBACK_BITS        16
#define PLAYBACK_FRAME_BYTES (PLAYBACK_BITS / 8)   /* 16 bit 单声道 = 2 字节/采样 */

/** 起播预缓冲：1200 ms（57600 字节）。0.3.5 从 600 ms 加倍：先攒够再开口，别第一块就饿死。 */
#define AUDIO_PREBUFFER_BYTES (1200 * PLAYBACK_FRAME_BYTES * PLAYBACK_RATE / 1000)
/** 预缓冲最多等这么久（毫秒）：链路慢时不能无限等，等满 2.5 s 就按现有数据开播。 */
#define AUDIO_PREBUFFER_MAX_MS 2500
/** 写 I2S 的粒度：40 ms / 1920 字节（20–40 ms 一块，避免把几百字节的小片段一块块怼进 DMA）。 */
#define AUDIO_WRITE_MS        40
#define AUDIO_WRITE_BYTES     (AUDIO_WRITE_MS * PLAYBACK_FRAME_BYTES * PLAYBACK_RATE / 1000)
/** 欠载时补的静音长度：与 receive 超时同量级（40 ms），把「重复上一段 DMA」换成真静音。 */
#define AUDIO_SILENCE_BYTES   (40 * PLAYBACK_FRAME_BYTES * PLAYBACK_RATE / 1000)
/** 欠载日志限速：最多 2 秒一条（带累计次数），不再每帧刷一条。 */
#define AUDIO_UNDERRUN_LOG_MS 2000

#define MIC_SAMPLE_RATE      16000
#define MIC_CHANNELS         1
#define MIC_CAPTURE_CHANNELS  2
#define MIC_MAX_CAPTURE_BYTES (MIC_SAMPLE_RATE * MIC_CAPTURE_CHANNELS * (MIC_BITS / 8) * TIHU_MIC_MAX_SECONDS)
#define MIC_BITS             16
#define MIC_MAX_PCM_BYTES    (MIC_SAMPLE_RATE * MIC_CHANNELS * (MIC_BITS / 8) * TIHU_MIC_MAX_SECONDS)
#define WAV_HEADER_BYTES     44

static esp_codec_dev_handle_t s_spk;
static esp_codec_dev_handle_t s_mic;
/*
 * 0.6.0：唤醒任务（tihu_wake.c）用 s_mic 常驻监听时会置位。此时 I2S 被切到
 * 16 kHz RX；任何 24 kHz 播放（TTS/叮）之前都必须先关麦，再 speaker_open_24k()。
 * 只在 tihu_audio_wake_mic_open/close 里改；播放任务只读。
 */
static volatile bool s_wake_mic_open;
static StreamBufferHandle_t s_stream;
static TaskHandle_t s_audio_task;
static volatile bool s_paused;
static volatile bool s_playing;
static volatile int64_t s_last_write_ms;
static volatile int64_t s_last_push_ms;
static int s_volume = TIHU_SPEAKER_VOLUME;

/* 播放统计：诊断「滋滋」到底是格式、对齐还是断流。 */
static volatile uint32_t s_stat_chunks;
static volatile uint32_t s_stat_odd_chunks;
static volatile uint32_t s_stat_underruns;
static volatile uint32_t s_stat_writes;
/* 0.6.3：录音期间被丢掉的 tts.audio 块数（既不播也不排队，只记一行日志）。 */
static volatile uint32_t s_stat_rec_drops;
/* 0.3.5 播放质量统计：峰值缓冲、最大空档（缓冲空到重新有真实数据的时长）、结束汇总只打一次。 */
static volatile uint32_t s_stat_peak_buffer;
static volatile uint32_t s_stat_max_gap_ms;
static int64_t s_empty_since_ms = -1;
static int64_t s_underrun_log_ms;
static bool s_summary_logged;
/* 宿主已下发这一轮的 final 块（`播放统计` 只在这之后、缓冲排空时打一次）。 */
static volatile bool s_final_seen;
/* 预缓冲只在一段朗读的**第一次**开播前做；中途欠载后不重新等 1.2 s，免得越等越卡。 */
static volatile bool s_prebuffer_done;
/*
 * 朗读进度（karaoke 高亮用，2026-11-12）：**一整段朗读**期间累计收到了多少 tts.audio 字节、
 * 已经真正写进 I2S 多少字节；只在新一段朗读开始 / playback.control 停止时才清零。
 *
 * 2026-11-12 实机根因（0.3.3 高亮乱跳）：旧实现按 `tts.audio seq==0` 清零，
 * 而宿主是「一行一段」，每行第一块都是 seq=0 —— 每 0.6 s 就把两个计数打回 0，
 * 比例永远在 0–100% 之间来回摆（日志 6/7→5/7→6/7），高亮根本不跟声音。
 *
 * 更进一步：比例（written/pushed）只能表示「排进缓冲的进度」——宿主会预送最多 800 ms、
 * 设备自己还有 32 KB（≈680 ms）播放缓冲，所以比例天然领先/滞后声音一段。真正对得上声音的
 * 是「已送 I2S 的字节数落在哪一行」：宿主每行首块都带 index，这里在 push 前记下该行的
 * 起始字节偏移，读侧用 written 去查表，高亮就跟着真实播放走。
 */
static volatile uint32_t s_bytes_pushed;
static volatile uint32_t s_bytes_written;

/* 一段朗读里的「行起始字节偏移」表：index 由宿主 tts.audio.index 给（完成页＝屏上第几行）。 */
#define TIHU_PROGRESS_MAX_LINES 16
static uint32_t s_line_offset[TIHU_PROGRESS_MAX_LINES];
static volatile bool s_line_valid[TIHU_PROGRESS_MAX_LINES];
static volatile int s_line_top = -1;         /* 收到过的最大行号，-1 = 本段还没有行 */
static portMUX_TYPE s_progress_lock = portMUX_INITIALIZER_UNLOCKED;

/* 录音：s_mic_buf 为 44 字节头 + PCM，放 PSRAM，避免占内部 RAM。 */
static uint8_t *s_mic_buf;
static size_t s_mic_pcm_len;
static volatile bool s_mic_running;
static volatile bool s_mic_active;
static TaskHandle_t s_mic_task;
static SemaphoreHandle_t s_mic_done;

/*
 * 麦克风硬件增益：0.4.0 起**固定 30 dB，不再自适应**。
 *
 * 0.3.8 的自适应（录完按峰值/RMS ±6 dB）在实机上是个来回抖的闭环：
 * 三次录音的峰值/均方根 2852/236、32767/2283、3573/393 —— 一次削顶两次太小。
 * 硬件增益本该只在「整段话都录不进来」时才动，而 ES7210 只有 3 dB 一档，调不出细活。
 * 现在硬件锁 30 dB，响度统一交给录音结束后的软件归一化（normalize_mic_pcm）。
 */
static const float s_mic_gain_db = TIHU_MIC_GAIN_DB;
/*
 * 0.3.9：**不再自己发 I2C 读 ES7210 寄存器**（0.3.6/0.3.8 的 `s_es7210_dev` 版已删）。
 *
 * 原因（2026-11-12「按住 CONFIG 完全没反应」）：那条回读用的是 bsp_i2c_get_handle()
 * 上另挂的一个 0x40 设备句柄，而 ES7210 的寄存器事务本来归 esp_codec_dev 的 codec
 * 句柄管（es7210_update_reg_bit 自己就要读-改-写）。同一颗芯片、同一个总线、两套
 * 设备句柄；录完音删不掉句柄的话，读侧一旦卡住就是录音任务卡死、s_mic_task 不回收，
 * 之后每次按键都静默失败。诊断值不值得这条风险？不值得——增益「实际值」现在由
 * esp_codec_dev_get_in_gain() 给 codec 自己记的请求值 + 本文件的 3 dB 档位表换算，
 * 一个字节的裸 I2C 都不发。
 */

static void put_le16(uint8_t *p, uint16_t value)
{
    p[0] = (uint8_t)(value & 0xFF);
    p[1] = (uint8_t)((value >> 8) & 0xFF);
}

static void put_le32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value & 0xFF);
    p[1] = (uint8_t)((value >> 8) & 0xFF);
    p[2] = (uint8_t)((value >> 16) & 0xFF);
    p[3] = (uint8_t)((value >> 24) & 0xFF);
}

/** 写一个标准的 44 字节 PCM WAV 头。 */
static void write_wav_header(uint8_t *buf, uint32_t pcm_len)
{
    memcpy(buf + 0, "RIFF", 4);
    put_le32(buf + 4, 36 + pcm_len);
    memcpy(buf + 8, "WAVE", 4);
    memcpy(buf + 12, "fmt ", 4);
    put_le32(buf + 16, 16);                       /* fmt 块长度 */
    put_le16(buf + 20, 1);                        /* PCM */
    put_le16(buf + 22, MIC_CHANNELS);
    put_le32(buf + 24, MIC_SAMPLE_RATE);
    put_le32(buf + 28, MIC_SAMPLE_RATE * MIC_CHANNELS * (MIC_BITS / 8)); /* 字节率 */
    put_le16(buf + 32, MIC_CHANNELS * (MIC_BITS / 8));                   /* 块对齐 */
    put_le16(buf + 34, MIC_BITS);
    memcpy(buf + 36, "data", 4);
    put_le32(buf + 40, pcm_len);
}

/** 重新按 24k 打开扬声器；mic 关闭后 I2S 可能停在 16k，必须再对一次。 */
static void speaker_open_24k(void)
{
    if (s_spk == NULL) {
        return;
    }
    esp_codec_dev_sample_info_t fs = {
        .sample_rate = PLAYBACK_RATE,
        .channel = PLAYBACK_CHANNELS,
        .bits_per_sample = PLAYBACK_BITS,
    };
    /* 已打开时先关，避免 WRONG_STATE；未打开时 close 返回错误也无所谓。 */
    (void)esp_codec_dev_close(s_spk);
    esp_err_t err = esp_codec_dev_open(s_spk, &fs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "扬声器打开 24k/1ch/16bit 失败: %s", esp_err_to_name(err));
        ESP_LOGE(TAG, "  → 之后写进去的 PCM 仍按 24k 送，但 I2S 可能停在 BSP 默认 22050：听到的是变调+杂音");
    } else {
        /* 音量要在 open 之后设，open 之前设会报 WRONG_STATE。 */
        esp_codec_dev_set_out_vol(s_spk, s_volume);
        /* 这一行就是「实际 I2S 配置」的现场证据（esp_codec_dev_open 内部重配 clock/slot）。 */
        ESP_LOGI(TAG, "扬声器 I2S：采样率=%d Hz 位深=%d bit 声道=%d（帧=%d 字节；BSP 默认 22050 已被重配）",
                 PLAYBACK_RATE, PLAYBACK_BITS, PLAYBACK_CHANNELS, PLAYBACK_FRAME_BYTES);
    }
}

static void set_speaker_volume(int volume)
{
    if (volume < 0) {
        volume = 0;
    }
    if (volume > 100) {
        volume = 100;
    }
    s_volume = volume;
    if (s_spk != NULL) {
        esp_codec_dev_set_out_vol(s_spk, volume);
    }
}

/** 停声后短暂拉到 0，再恢复：比直接 reset 更不容易留下“咔哒”尾音。 */
static void mute_briefly(void)
{
    if (s_spk == NULL) {
        return;
    }
    esp_codec_dev_set_out_vol(s_spk, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    esp_codec_dev_set_out_vol(s_spk, s_volume);
}

/** 一次朗读结束时的播放质量汇总（只打一次，且必须真的播过东西）。 */
static void log_playback_summary(const char *why)
{
    /*
     * 只在「宿主明确说了这一轮最后一块（final）」之后、且缓冲真的排空时才汇总。
     * 否则行与行之间合成慢留下的 300 ms 空档就会被误判成「读完了」——实机第一次就是
     * 刚播完一行就打了汇总（块=1），整段结束反而没有。
     */
    if (s_summary_logged || s_stat_chunks == 0 || !s_final_seen) {
        return;
    }
    s_summary_logged = true;
    ESP_LOGI(TAG, "播放统计：欠载=%u 最大空档=%ums 峰值缓冲=%uKB（块=%u 奇数块=%u 写次数=%u，%s）",
             (unsigned)s_stat_underruns, (unsigned)s_stat_max_gap_ms,
             (unsigned)(s_stat_peak_buffer / 1024),
             (unsigned)s_stat_chunks, (unsigned)s_stat_odd_chunks,
             (unsigned)s_stat_writes, why);
}

void tihu_audio_mark_final(void)
{
    s_final_seen = true;
}

/**
 * 播放任务：StreamBuffer → 40 ms 成块 → I2S。
 *
 * 0.3.5 三处改动（实机「播放欠载 251 次、声音卡」）：
 *   1) 起播预缓冲 1200 ms（等不到就 2.5 s 封顶），别第一块就喂 DMA；
 *   2) 先把数据攒进 40 ms 的暂存块再写 I2S——网络来的 200–1000 字节碎片不再一块块怼进 DMA；
 *   3) 欠载日志 2 秒限速 + 只在结束时打一条「播放统计」。
 */
static void audio_task(void *arg)
{
    (void)arg;
    /*
     * 40 ms 暂存块。16 bit 单声道以 2 字节为一帧：写 I2S 前必须落在整帧边界上，
     * 落单的尾字节留在 pcm[0] 等下一轮拼（写进半个采样会让之后所有采样两两错位 → 满幅噪声）。
     */
    static uint8_t pcm[AUDIO_WRITE_BYTES];
    size_t staged = 0;
    uint32_t written_after_underrun = 0;
    while (true) {
        if (s_paused) {
            staged = 0;
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        int64_t now = esp_timer_get_time() / 1000;
        /*
         * 起播预缓冲：还没在播时先攒够 1200 ms 再喂 I2S；链路太慢时最多等 2.5 s，
         * 之后按现有数据开播（总比一直憋着强）。
         */
        if (!s_playing && !s_prebuffer_done) {
            size_t avail = xStreamBufferBytesAvailable(s_stream);
            if (avail + staged > s_stat_peak_buffer) {
                s_stat_peak_buffer = (uint32_t)(avail + staged);
            }
            int64_t since_push = now - s_last_push_ms;
            /*
             * 注意两个坑：
             *  1) 不能写「avail>0 才等」——第一块刚到的那一刻 avail 还是 0，直接掉进 receive 就开播了；
             *  2) 光在循环顶部判也不够——audio_task 通常正阻塞在 receive 里，数据一到就返回并往下写。
             * 所以下面 receive 之后**再判一次**，没攒够就把数据留在暂存块里继续等。
             */
            if (!s_final_seen && (avail + staged) < AUDIO_PREBUFFER_BYTES &&
                since_push < AUDIO_PREBUFFER_MAX_MS) {
                vTaskDelay(pdMS_TO_TICKS(10));
                continue;
            }
        }
        size_t room = AUDIO_WRITE_BYTES - staged;
        size_t got = xStreamBufferReceive(s_stream, pcm + staged, room, pdMS_TO_TICKS(20));
        staged += got;
        size_t avail = xStreamBufferBytesAvailable(s_stream);
        if (avail + staged > s_stat_peak_buffer) {
            s_stat_peak_buffer = (uint32_t)(avail + staged);
        }
        if (!s_playing && !s_prebuffer_done && staged > 0) {
            /* receive 之后补判：总量不到 1200 ms 就先别喂 I2S（暂存块保留，下一轮接着攒）。 */
            if (!s_final_seen && (avail + staged) < AUDIO_PREBUFFER_BYTES &&
                (now - s_last_push_ms) < AUDIO_PREBUFFER_MAX_MS) {
                continue;
            }
        }
        /*
         * 满 40 ms 就写；等满 20 ms 还没凑满、但手里已经有数据（链路慢）就把整帧部分先写掉，
         * 免得残片一直积压、起播被拖住。staged==0 且没收到数据 = 真欠载。
         */
        if (staged == 0) {
            if (s_playing && s_spk != NULL) {
                s_stat_underruns++;
                if (s_empty_since_ms < 0) {
                    s_empty_since_ms = now;
                }
                /*
                 * 欠载时**主动写 40 ms 静音**：ESP-IDF 的 I2S 在 DMA 空了以后会重复上一段
                 * DMA 内容（默认 auto_clear=false），那正是一段 20–40 ms 的循环 → 听成「嗡/滋滋」。
                 */
                static const uint8_t silence[AUDIO_SILENCE_BYTES] = {0};
                (void)esp_codec_dev_write(s_spk, (void *)silence, sizeof(silence));
                if (now - s_underrun_log_ms >= AUDIO_UNDERRUN_LOG_MS) {
                    s_underrun_log_ms = now;
                    ESP_LOGW(TAG, "播放欠载累计 %u 次（缓冲空，补 40 ms 静音；日志 2 s 限速一条）",
                             (unsigned)s_stat_underruns);
                }
            }
            if (s_playing && (now - s_last_write_ms) > 300) {
                s_playing = false;
                log_playback_summary("播放结束·缓冲排空");
                /* 播放排空：唤醒任务可以重新开麦（它会自己把 I2S 切回 16 k）。 */
                tihu_wake_resume();
            }
            continue;
        }
        size_t even = staged & ~(size_t)1;
        if (even > 0 && s_spk != NULL) {
            /*
             * 0.6.0 唤醒词：唤醒任务可能正占着 I2S RX（16 kHz）。先让它**自己**关麦
             * （关麦时会把扬声器重新按 24 k 打开），再写 TTS；否则这一块会按 16 k 播出去
             * （变调），而且两个任务会抢同一组 I2S。等不到就让出 CPU 重试，不丢已攒的数据。
             */
            if (s_wake_mic_open) {
                if (!tihu_wake_pause() || s_wake_mic_open) {
                    ESP_LOGW(TAG, "唤醒任务仍占用麦克风，推迟本块播放");
                    vTaskDelay(pdMS_TO_TICKS(20));
                    continue;
                }
            }
            /* esp_codec_dev_write 返回 ESP_CODEC_DEV_OK(0)，不是写入字节数。 */
            int rc = esp_codec_dev_write(s_spk, pcm, (int)even);
            if (rc != ESP_CODEC_DEV_OK) {
                ESP_LOGW(TAG, "speaker write 失败: %d（块长=%u）", rc, (unsigned)even);
                staged = 0;
            } else {
                s_stat_writes++;
                s_bytes_written += (uint32_t)even;
                if (!s_prebuffer_done) {
                    s_prebuffer_done = true;
                    ESP_LOGI(TAG, "起播预缓冲完成：已攒 %u ms 音频（%u 字节）才开 I2S",
                             (unsigned)((uint64_t)(avail + even) * 1000 /
                                        (PLAYBACK_RATE * PLAYBACK_FRAME_BYTES)),
                             (unsigned)(avail + even));
                }
                if (s_empty_since_ms >= 0) {
                    uint32_t gap = (uint32_t)(now - s_empty_since_ms);
                    if (gap > s_stat_max_gap_ms) {
                        s_stat_max_gap_ms = gap;
                    }
                    s_empty_since_ms = -1;
                }
                if (written_after_underrun == 0 && s_stat_underruns > 0) {
                    written_after_underrun = 1;
                    ESP_LOGI(TAG, "播放恢复：欠载累计 %u 次（已重新有数据）", (unsigned)s_stat_underruns);
                }
                /* 落单的半个采样挪到块首，下一轮补成整帧。 */
                size_t keep = staged - even;
                if (keep > 0) {
                    pcm[0] = pcm[even];
                    s_stat_odd_chunks++;
                }
                staged = keep;
                s_last_write_ms = now;
                s_playing = true;
            }
        }
        if (s_playing && (now - s_last_write_ms) > 300) {
            s_playing = false;
            log_playback_summary("播放结束·缓冲排空");
        }
    }
}


/*
 * 2026-11-12：板子上 ES7210 的 I2C 地址实测在 0x41（i2c scan 只见 0x41，不见 0x40），
 * 而 BSP 的 bsp_audio_codec_microphone_init() 写死 0x40 —— 于是 ADC 从来没被正确配置，
 * 录到的是几十个最低位的噪声（whisper 只能听成「嘩嘩嘩」「啪啪啪」）。
 *
 * 所以这里自己做 ES7210 实例：地址可配，开机依次探 0x41 / 0x40 / 0x3E，
 * 谁读出来有信号就用谁，全都没信号才退回 BSP 的老路。
 * 只在自己这套句柄里转，绝不同时持有 BSP 的 mic 句柄（0.3.6 的 I2C 抢总线就是这么挂的）。
 */
static char s_mic_probe_text[360];
static char s_mic_source[48] = "none";
static int  s_mic_probe_best_rms;

static char s_mic_stage[96];

static void mic_stage(const char *what)
{
    size_t n = strlen(s_mic_stage);
    snprintf(s_mic_stage + n, sizeof(s_mic_stage) - n, " %s", what);
}

static esp_codec_dev_handle_t mic_dev_at(uint8_t addr)
{
    snprintf(s_mic_stage, sizeof(s_mic_stage), "a%02X", addr);
    const audio_codec_data_if_t *data_if = bsp_audio_get_codec_itf();
    if (data_if == NULL) {
        ESP_LOGW(TAG, "I2S 还没初始化，先补一次 bsp_audio_init");
        (void)bsp_audio_init(NULL);
        data_if = bsp_audio_get_codec_itf();
    }
    if (data_if == NULL) {
        mic_stage("nodata");
        return NULL;
    }
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) {
        ESP_LOGW(TAG, "I2C 还没初始化，先补一次 bsp_i2c_init");
        (void)bsp_i2c_init();
        bus = bsp_i2c_get_handle();
    }
    if (bus == NULL) {
        mic_stage("nobus");
        return NULL;
    }
    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = BSP_I2C_NUM,
        .addr = addr,
        .bus_handle = bus,
    };
    const audio_codec_ctrl_if_t *ctrl = audio_codec_new_i2c_ctrl(&i2c_cfg);
    if (ctrl == NULL) {
        mic_stage("noctrl");
        return NULL;
    }
    es7210_codec_cfg_t codec_cfg = {0};
    codec_cfg.ctrl_if = ctrl;
    const audio_codec_if_t *codec_if = es7210_codec_new(&codec_cfg);
    if (codec_if == NULL) {
        mic_stage("nocodec");
        return NULL;
    }
    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
        .codec_if = codec_if,
        .data_if = data_if,
    };
    esp_codec_dev_handle_t dev = esp_codec_dev_new(&dev_cfg);
    if (dev == NULL) {
        mic_stage("nodev");
        return NULL;
    }
    mic_stage("dev");
    return dev;
}

/** 在某个地址上开麦读 ~125 ms，返回 RMS，峰值写到 out_peak；返回 <0 表示这个地址不可用。 */
static int mic_probe_rms(uint8_t addr, int *out_peak, esp_err_t *out_err)
{
    *out_peak = 0;
    *out_err = ESP_FAIL;
    esp_codec_dev_handle_t dev = mic_dev_at(addr);
    if (dev == NULL) {
        return -1;
    }
    esp_codec_dev_sample_info_t fs = {
        .sample_rate = MIC_SAMPLE_RATE,
        .channel = MIC_CAPTURE_CHANNELS,
        .bits_per_sample = MIC_BITS,
    };
    esp_err_t err = esp_codec_dev_open(dev, &fs);
    *out_err = err;
    int rms = -2;
    if (err == ESP_OK) {
        esp_codec_dev_set_in_gain(dev, s_mic_gain_db);
        static int16_t probe[320];
        uint64_t sum = 0;
        uint32_t n = 0;
        int32_t peak = 0;
        for (int i = 0; i < 25; i++) {
            if (esp_codec_dev_read(dev, probe, sizeof(probe)) == ESP_CODEC_DEV_OK) {
                for (int k = 0; k < 320; k++) {
                    int32_t v = probe[k];
                    int32_t av = v < 0 ? -v : v;
                    if (av > peak) {
                        peak = av;
                    }
                    sum += (uint64_t)((int64_t)v * (int64_t)v);
                    n++;
                }
            }
        }
        *out_peak = (int)peak;
        rms = n ? (int)sqrt((double)sum / (double)n) : 0;
        esp_codec_dev_close(dev);
    }
    esp_codec_dev_delete(dev);
    return rms;
}

bool tihu_audio_mic_probe_text(char *out, size_t cap)
{
    if (out == NULL || cap == 0) {
        return false;
    }
    snprintf(out, cap, "%s", s_mic_probe_text);
    return s_mic_probe_text[0] != '\0';
}

static void mic_probe_and_init(void)
{
    static const uint8_t kAddrs[] = { 0x41, 0x40, 0x3E };
    const int n_addr = (int)(sizeof(kAddrs) / sizeof(kAddrs[0]));
    int best_rms = -1;
    uint8_t best_addr = 0;
    size_t used = (size_t)snprintf(s_mic_probe_text, sizeof(s_mic_probe_text), "micprobe");
    for (int i = 0; i < n_addr; i++) {
        int peak = 0;
        esp_err_t err = ESP_FAIL;
        int rms = mic_probe_rms(kAddrs[i], &peak, &err);
        used += (size_t)snprintf(s_mic_probe_text + used, sizeof(s_mic_probe_text) - used,
                                 " %02X:rms=%d/pk=%d/err=%d/%s", kAddrs[i], rms, peak, (int)err, s_mic_stage);
        if (used >= sizeof(s_mic_probe_text) - 60) {
            break;
        }
        if (rms > best_rms) {
            best_rms = rms;
            best_addr = kAddrs[i];
        }
    }
    s_mic_probe_best_rms = best_rms;
    snprintf(s_mic_probe_text + used, sizeof(s_mic_probe_text) - used,
             " best=%02X/%d", best_addr, best_rms);
    ESP_LOGI(TAG, "%s", s_mic_probe_text);

    /* 阈值 60：真语音在这个增益下 RMS 至少几百，纯噪声只有几十。 */
    if (best_rms > 60) {
        esp_codec_dev_handle_t dev = mic_dev_at(best_addr);
        if (dev != NULL) {
            s_mic = dev;
            esp_codec_dev_set_in_gain(s_mic, s_mic_gain_db);
            snprintf(s_mic_source, sizeof(s_mic_source), "custom-%02X", best_addr);
            ESP_LOGI(TAG, "麦克风用自建 ES7210 实例（地址 0x%02X）", best_addr);
            return;
        }
    }
    s_mic = bsp_audio_codec_microphone_init();
    snprintf(s_mic_source, sizeof(s_mic_source), s_mic != NULL ? "bsp" : "none");
    if (s_mic == NULL) {
        ESP_LOGW(TAG, "麦克风 codec 初始化失败：按键说话会不可用");
    } else {
        esp_codec_dev_set_in_gain(s_mic, s_mic_gain_db);
    }
}

void tihu_audio_init(void)
{
    s_spk = bsp_audio_codec_speaker_init();
    if (s_spk == NULL) {
        ESP_LOGE(TAG, "扬声器 codec 初始化失败：检查 BSP 版本与板型");
    } else {
        set_speaker_volume(TIHU_SPEAKER_VOLUME);
    }

    /* 探地址 → 选一个真能出声的 ES7210 实例（详见 mic_probe_and_init 注释）。 */
    mic_probe_and_init();

    /* 两个 codec 都 init 完之后再按 24k 打开扬声器，避免 mic init 重配 I2S。 */
    speaker_open_24k();

    /*
     * 播放缓冲放 PSRAM（内部 RAM 一次拿几十 KB 会在启动最紧张时失败，实测报
     * 「播放 StreamBuffer 创建失败」→ TTS 直接没声）。0.3.5 提到 256 KB ≈ 5.4 秒音频。
     */
    s_stream = xStreamBufferCreateWithCaps(AUDIO_STREAM_BYTES, 512,
                                           MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_stream == NULL) {
        s_stream = xStreamBufferCreate(AUDIO_STREAM_BYTES, 512);
    }
    if (s_stream == NULL) {
        ESP_LOGE(TAG, "播放 StreamBuffer 创建失败（PSRAM/内部 RAM 都不够）");
        return;
    }
    /* 32 KB @ 24k/16bit/mono ≈ 682 ms 预缓冲：网络抖动小于这个数就不会断流。 */
    ESP_LOGI(TAG, "播放缓冲：%d 字节（≈%d ms @ %d Hz/%d bit/mono），触发水位 512 字节",
             AUDIO_STREAM_BYTES,
             (int)((int64_t)AUDIO_STREAM_BYTES * 1000 / (PLAYBACK_RATE * PLAYBACK_FRAME_BYTES)),
             PLAYBACK_RATE, PLAYBACK_BITS);
    if (xTaskCreate(audio_task, "tihu_audio", AUDIO_TASK_STACK, NULL,
                    AUDIO_TASK_PRIO, &s_audio_task) != pdPASS) {
        ESP_LOGE(TAG, "播放任务创建失败");
    }

    s_mic_done = xSemaphoreCreateBinary();
    s_mic_buf = heap_caps_malloc(WAV_HEADER_BYTES + MIC_MAX_CAPTURE_BYTES,
                                 MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_mic_buf == NULL) {
        s_mic_buf = malloc(WAV_HEADER_BYTES + MIC_MAX_CAPTURE_BYTES);
    }
    if (s_mic_buf == NULL) {
        ESP_LOGE(TAG, "录音缓冲分配失败（需要 %u 字节）",
                 (unsigned)(WAV_HEADER_BYTES + MIC_MAX_CAPTURE_BYTES));
    }
}

void tihu_audio_push_pcm(const uint8_t *pcm, size_t len)
{
    if (pcm == NULL || len == 0 || s_stream == NULL || s_paused) {
        return;
    }
    /*
     * 0.6.3（用户 2026-11-13 要求「录音期间不许朗读」）：麦克风开着时到达的 tts.audio
     * 既不播也不排队 —— 排队的话会在松手后把攒下的整段朗读一次性放出来，
     * 听起来就是「我刚说完话，设备立刻自顾自念起来」。
     */
    if (tihu_audio_mic_active()) {
        s_stat_rec_drops++;
        if ((s_stat_rec_drops % 50u) == 1u) {
            ESP_LOGW(TAG, "录音中：丢弃 tts.audio %u 字节（累计 %u 块）",
                     (unsigned)len, (unsigned)s_stat_rec_drops);
        }
        return;
    }
    s_stat_chunks++;
    s_bytes_pushed += (uint32_t)len;
    if ((len & 1u) != 0) {
        s_stat_odd_chunks++;
        /* 宿主出口已保证偶数；真到这一步说明上游还是切开了半个采样，先记下来。 */
        ESP_LOGW(TAG, "tts.audio 块长=%u（奇数），已按 2 字节边界拼接（累计 %u 次）",
                 (unsigned)len, (unsigned)s_stat_odd_chunks);
    }
    /*
     * 100 ms 阻塞式背压：done/正文一次会连发几十块（合成比实时快），
     * 只等 20 ms 会把缓冲塞爆、每块丢几十毫秒（听起来是跳字/咔哒）。
     * 阻塞 WS 线程 100 ms 是安全的（心跳在定时器里），换来的是不丢音频。
     */
    size_t sent = xStreamBufferSend(s_stream, pcm, len, pdMS_TO_TICKS(100));
    if (sent < len) {
        /* 仍然塞不下（极端突发）才丢，并记下来；绝不 reset（保留已排队的更接近“继续念”）。 */
        ESP_LOGW(TAG, "播放缓冲满，丢弃 %u 字节（块长=%u）", (unsigned)(len - sent), (unsigned)len);
    }
    size_t avail = xStreamBufferBytesAvailable(s_stream);
    if (avail > s_stat_peak_buffer) {
        s_stat_peak_buffer = (uint32_t)avail;
    }
    /*
     * 这里**不设 s_playing**：0.3.5 之前 push 就把 s_playing 置 true，导致 audio_task 的
     * 「起播预缓冲」分支永远进不去（预缓冲名存实亡）。现在 s_playing 只由 audio_task
     * 在真的写进 I2S 之后置位，预缓冲才真正生效。
     */
    s_last_push_ms = esp_timer_get_time() / 1000;
}

void tihu_audio_stats(uint32_t *chunks, uint32_t *odd_chunks, uint32_t *underruns)
{
    if (chunks != NULL) {
        *chunks = s_stat_chunks;
    }
    if (odd_chunks != NULL) {
        *odd_chunks = s_stat_odd_chunks;
    }
    if (underruns != NULL) {
        *underruns = s_stat_underruns;
    }
}

void tihu_audio_reset_stats(void)
{
    s_stat_chunks = 0;
    s_stat_odd_chunks = 0;
    s_stat_underruns = 0;
    s_stat_writes = 0;
    s_stat_rec_drops = 0;
    s_stat_peak_buffer = 0;
    s_stat_max_gap_ms = 0;
    s_empty_since_ms = -1;
    s_underrun_log_ms = 0;
    s_summary_logged = false;
    s_final_seen = false;
    s_prebuffer_done = false;
    /* 新一段朗读：累计字节和「行起始偏移」一起归零（行号从第 0 行重新数）。 */
    portENTER_CRITICAL(&s_progress_lock);
    s_bytes_pushed = 0;
    s_bytes_written = 0;
    s_line_top = -1;
    for (int i = 0; i < TIHU_PROGRESS_MAX_LINES; i++) {
        s_line_valid[i] = false;
        s_line_offset[i] = 0;
    }
    portEXIT_CRITICAL(&s_progress_lock);
}

void tihu_audio_note_line(int index)
{
    if (index < 0 || index >= TIHU_PROGRESS_MAX_LINES) {
        return;
    }
    /*
     * 这一行的起点用「播放坐标系」记：已送 I2S 的字节 + 还排在 StreamBuffer 里的字节
     * ＝这一块将会在播放时间轴上出现的位置。**不能**用 pushed 当坐标——
     * 暂停/清缓冲/丢块（缓冲满）都会让 pushed 和实际播放位置脱钩。
     */
    portENTER_CRITICAL(&s_progress_lock);
    /*
     * 行号往回走 = 宿主在重读/跳段：旧表已经不适用，整表清掉再记，
     * 否则 written 还在小值时会误命中上一轮的高行号。
     */
    if (s_line_top >= 0 && index <= s_line_top) {
        s_line_top = -1;
        for (int i = 0; i < TIHU_PROGRESS_MAX_LINES; i++) {
            s_line_valid[i] = false;
        }
    }
    size_t queued = s_stream != NULL ? xStreamBufferBytesAvailable(s_stream) : 0;
    s_line_offset[index] = s_bytes_written + (uint32_t)queued;
    s_line_valid[index] = true;
    s_line_top = index;
    portEXIT_CRITICAL(&s_progress_lock);
}

int tihu_audio_current_line(void)
{
    uint32_t written = s_bytes_written;
    int best = -1;
    int top = s_line_top;
    for (int i = 0; i <= top && i < TIHU_PROGRESS_MAX_LINES; i++) {
        if (!s_line_valid[i]) {
            continue;
        }
        if (s_line_offset[i] <= written) {
            best = i;
        }
    }
    return best;
}

bool tihu_audio_progress_idle(void)
{
    uint32_t pushed = s_bytes_pushed;
    uint32_t written = s_bytes_written;
    return pushed == 0 || written >= pushed;
}

bool tihu_audio_playback_progress(uint32_t *pushed, uint32_t *written)
{
    uint32_t p = s_bytes_pushed;
    uint32_t w = s_bytes_written;
    if (pushed != NULL) {
        *pushed = p;
    }
    if (written != NULL) {
        *written = w;
    }
    return p > 0 && w > 0;
}

/* ---------------------- 正弦自检（1 kHz / 0.5 s） ---------------------- */

/*
 * 用同一条 StreamBuffer → audio_task → esp_codec_dev_write 链路播一段已知干净的正弦。
 * 听到干净「嘟」= I2S 采样率/位深/声道与通路正常，问题在分块或网络；
 * 听到爆音/白噪 = 通路本身（codec/采样率/对齐）有问题，先别怀疑宿主。
 */
static void sine_test_task(void *arg)
{
    (void)arg;
    const int total_samples = PLAYBACK_RATE / 2;                 /* 0.5 秒 */
    const int period = PLAYBACK_RATE / 1000;                     /* 1 kHz = 24 样本/周期 */
    const int16_t amp = 9000;                                    /* 约 -11 dBFS，不刺耳 */
    int16_t *buf = heap_caps_malloc(total_samples * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) {
        buf = malloc(total_samples * sizeof(int16_t));
    }
    if (buf == NULL) {
        ESP_LOGE(TAG, "正弦测试：缓冲分配失败");
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "正弦测试开始：1 kHz / %d Hz / %d bit / mono / %d ms",
             PLAYBACK_RATE, PLAYBACK_BITS, total_samples * 1000 / PLAYBACK_RATE);
    for (int i = 0; i < total_samples; i++) {
        int phase = i % period;
        float s = sinf(2.0f * 3.14159265358979f * (float)phase / (float)period);
        buf[i] = (int16_t)(s * (float)amp);
    }
    /* 一次塞满（24 KB < 32 KB 缓冲）：中间不补数据，避免自检自己制造欠载。 */
    tihu_audio_push_pcm((const uint8_t *)buf, (size_t)total_samples * sizeof(int16_t));
    /* 等它真的播完（最长 1.5 s），再报「已播放」。 */
    int waited = 0;
    while (tihu_audio_busy() && waited < 1500) {
        vTaskDelay(pdMS_TO_TICKS(20));
        waited += 20;
    }
    ESP_LOGI(TAG, "正弦测试：24k/16bit/mono 已播放（1 kHz 0.5 s，峰值 %d，等待 %d ms）", amp, waited);
    free(buf);
    vTaskDelete(NULL);
}

void tihu_audio_play_sine_test(void)
{
    if (xTaskCreate(sine_test_task, "tihu_sine", 4096, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "正弦测试任务创建失败");
    }
}

void tihu_audio_stop(void)
{
    s_paused = false;
    s_playing = false;
    if (s_stream != NULL) {
        xStreamBufferReset(s_stream);
    }
    /* 停声＝本轮朗读结束：进度清零（含行偏移表），下次朗读从第 0 行重新高亮。 */
    tihu_audio_reset_stats();
    mute_briefly();
    /* 0.6.0：停声后唤醒任务可以重新开麦（正在录音时会被 mic_active 挡住）。 */
    tihu_wake_resume();
}

void tihu_audio_pause(void)
{
    s_paused = true;
    s_playing = false;
    if (s_stream != NULL) {
        xStreamBufferReset(s_stream);
    }
    if (s_spk != NULL) {
        esp_codec_dev_set_out_vol(s_spk, 0);
    }
}

void tihu_audio_resume(void)
{
    s_paused = false;
    if (s_spk != NULL) {
        esp_codec_dev_set_out_vol(s_spk, s_volume);
    }
}

bool tihu_audio_busy(void)
{
    if (s_paused) {
        return false;
    }
    size_t queued = s_stream == NULL ? 0 : xStreamBufferBytesAvailable(s_stream);
    return queued > 0 || s_playing;
}

void tihu_audio_set_volume(int volume)
{
    set_speaker_volume(volume);
    if (!s_paused && s_spk != NULL) {
        esp_codec_dev_set_out_vol(s_spk, s_volume);
    }
}

/* ---------------------- 录音增益（固定）/ 统计 / 软件归一化（0.4.0） ---------------------- */

/** 开录时算出来的「实际档位」文本，收尾统计行里复用它（本地换算值，无 I2C 回读）。 */
static char s_gain_actual[16] = "?";

/**
 * 把请求 dB 折到 ES7210 的 3 dB 一档（**纯本地换算，不发 I2C**）。
 *
 * 表和 esp_codec_dev 的 es7210 驱动 get_db() 完全一致（0..30 每 3 dB 一档，
 * 然后 34.5 / 36 / 37.5 三个补丁档）：30 dB 请求 → 30 dB 档。
 * 只为了日志里的「实际档位」写得准，不参与任何决策。
 */
static float es7210_step_db(float db)
{
    if (db < 33.0f) {
        int idx = db < 3.0f ? 0 : (int)((db + 0.5f) / 3.0f);
        return (float)idx * 3.0f;
    }
    if (db < 34.5f) {
        return 30.0f;
    }
    if (db < 36.0f) {
        return 34.5f;
    }
    if (db < 37.0f) {
        return 36.0f;
    }
    return 37.5f;
}

/**
 * 录音开始时的增益日志：0.4.0 起硬件增益是常量，只有「计划值 / codec 记的请求值 / 实际档位」。
 *
 * 不再有「上次方向」这类自适应状态——已撤掉；请求值仍从 esp_codec_dev_get_in_gain()
 * 取（纯内存，不发 I2C），实际档位按 ES7210 的 3 dB 表本地换算。
 */
static void log_mic_gain_applied(float want_db)
{
    float codec_db = want_db;
    bool codec_ok = (s_mic != NULL) &&
                    (esp_codec_dev_get_in_gain(s_mic, &codec_db) == ESP_CODEC_DEV_OK);
    float step = es7210_step_db(codec_ok ? codec_db : want_db);
    snprintf(s_gain_actual, sizeof(s_gain_actual), "%.1f", (double)step);
    ESP_LOGI(TAG, "录音开始：硬件增益固定 计划值=%.1f dB codec请求值=%.1f dB 实际档位≈%.1f dB"
                  "（ES7210 3 dB 一档，本地换算；0.4.0 起不再按上次统计升降）",
             (double)want_db, (double)(codec_ok ? codec_db : want_db), (double)step);
}

/**
 * 录音收尾的原始统计（只打日志，不改任何增益）：
 * 采样点数 / 峰值 / 均方根 / 削波数及占比 + 本次硬件增益。
 */
static void log_mic_capture_stats(uint32_t samples, int32_t peak, double rms, uint32_t clip)
{
    double clip_pct = samples > 0 ? (100.0 * (double)clip / (double)samples) : 0.0;
    ESP_LOGI(TAG, "录音统计：采样点=%u 峰值=%d 均方根=%.0f 削波(|x|>=%d)=%u（%.2f%%）"
                  "硬件增益=%.1f dB（实际档位 %s dB）",
             (unsigned)samples, (int)peak, rms, TIHU_MIC_CLIP_LEVEL, (unsigned)clip, clip_pct,
             (double)s_mic_gain_db, s_gain_actual);
}

/**
 * 一阶高通（去直流 / 低频嗡嗡），原地处理 PCM：y[n] = x[n] - x[n-1] + a*y[n-1]。
 *
 * 为什么要有：ES7210 的输入有直流偏置和低频漂移，直接算 RMS 会被偏置抬高，
 * 「这段是不是太轻」就判不出来；归一化放大后偏置还会变成整段波形上移/削掉半边。
 * a = TIHU_HPF_COEF(0.995) @ 16 kHz ⇒ 约 12.7 Hz 截止，人声 100 Hz 以上几乎不动。
 *
 * @param pcm   44 字节头之后的第一笔采样（16 bit 小端宿主字节序 = 小端）
 * @param bytes 实际上传的字节数（按 2 字节对齐截断，落单的尾字节不动）
 */
static void highpass_pcm(uint8_t *pcm, size_t bytes)
{
    size_t frames = bytes / sizeof(int16_t);
    if (frames == 0) {
        return;
    }
    int16_t *samples = (int16_t *)pcm;
    float prev_x = (float)samples[0];
    float prev_y = 0.0f;
    for (size_t i = 0; i < frames; i++) {
        float x = (float)samples[i];
        float y = x - prev_x + TIHU_HPF_COEF * prev_y;
        prev_x = x;
        prev_y = y;
        /* 高通后仍可能瞬间越界（起始样本是阶跃），按 16 bit 饱和，绝不回绕成爆音。 */
        if (y > 32767.0f) {
            y = 32767.0f;
        } else if (y < -32768.0f) {
            y = -32768.0f;
        }
        samples[i] = (int16_t)(y >= 0.0f ? (y + 0.5f) : (y - 0.5f));
    }
}

/** 一段 PCM 的「去直流后」均方根与峰值（0.4.0 归一化用，采样已是高通输出）。 */
static void measure_pcm(const uint8_t *pcm, size_t bytes, double *out_rms, int32_t *out_peak)
{
    size_t frames = bytes / sizeof(int16_t);
    if (frames == 0) {
        if (out_rms != NULL) {
            *out_rms = 0.0;
        }
        if (out_peak != NULL) {
            *out_peak = 0;
        }
        return;
    }
    const int16_t *samples = (const int16_t *)pcm;
    int64_t sum = 0;
    int64_t sum_sq = 0;
    int32_t peak = 0;
    for (size_t i = 0; i < frames; i++) {
        int32_t s = samples[i];
        int32_t a = s < 0 ? -s : s;
        if (a > peak) {
            peak = a;
        }
        sum += s;
        sum_sq += (int64_t)s * (int64_t)s;
    }
    /* 去直流：先减掉均值再算均方根，直流偏置不算「响度」。 */
    double mean = (double)sum / (double)frames;
    double var = (double)sum_sq / (double)frames - mean * mean;
    if (var < 0.0) {
        var = 0.0;
    }
    if (out_rms != NULL) {
        *out_rms = sqrt(var);
    }
    if (out_peak != NULL) {
        *out_peak = peak;
    }
}

/**
 * 录音结束、组 WAV 之前的软件归一化（0.4.0）。
 *
 * 规则（与需求一一对应）：
 *   1) 先一阶高通去直流/低频嗡嗡（highpass_pcm），再算 RMS——否则偏置会把响度算高；
 *   2) 目标 RMS = TIHU_NORM_TARGET_RMS(1500)；
 *   3) g = 1500/RMS，上限 TIHU_NORM_MAX_GAIN(8)；
 *      若 峰值*g > TIHU_NORM_PEAK_CEIL(30000)，按峰值回算 g = 30000/峰值（不制造削顶）；
 *   4) **放大只在「太轻」时生效**：RMS < TIHU_NORM_RMS_TRIGGER(800) 或 峰值 <
 *      TIHU_NORM_PEAK_TRIGGER(8000)；本来正常的录音 g 保持 1.0，
 *      免得把底噪/空调声一起抬上来（whisper 幻觉的主要来源）。
 *   5) 另加一条**只衰减**的分支（不在原需求里，但实测需要）：峰值已经削顶
 *      (≥ TIHU_MIC_CLIP_LEVEL 32000) 且 RMS 高于目标时，按 1500/RMS 回拉
 *      （再受 30000/峰值 与 0.25 下限约束）。0.3.8 的 42 dB 就能录出
 *      峰值 32767 / RMS 2283 的方波，那种波形原样送进 ASR 只会得到幻觉。
 *
 * 归一化后打一条日志：高通后 RMS/峰值 → g（放大/削顶衰减/未动）→ 归一化后 RMS/峰值。
 *
 * @param pcm    44 字节头之后的 PCM（原地改写）
 * @param bytes  PCM 字节数
 * @return 实际使用的增益因子（1.0 = 没动）
 */
static float normalize_mic_pcm(uint8_t *pcm, size_t bytes)
{
    size_t frames = bytes / sizeof(int16_t);
    if (frames == 0) {
        return 1.0f;
    }

    highpass_pcm(pcm, bytes);

    double rms_before = 0.0;
    int32_t peak_before = 0;
    measure_pcm(pcm, bytes, &rms_before, &peak_before);

    float g = 1.0f;
    const bool too_quiet = (rms_before < (double)TIHU_NORM_RMS_TRIGGER) ||
                           (peak_before < TIHU_NORM_PEAK_TRIGGER);
    /*
     * 另一个极端：**已经削顶**（峰值顶到 32000 以上）的录音。
     * 0.3.8 的 42 dB 自适应能录出峰值 32767 / RMS 2283 这种方波，那种东西送进 ASR
     * 只会得到幻觉。放大对它没用（放大只会更糊），所以这里只做**衰减**：
     * 按目标 RMS 回拉，再让峰值落在 30000 以下。衰减不会把底噪抬起来，
     * 与「只在太轻时放大」不冲突（门限那条管的是放大）。
     */
    const bool too_loud = peak_before >= TIHU_MIC_CLIP_LEVEL;
    const char *how = "未动";
    bool hit_max_gain = false;
    bool hit_peak_ceil = false;
    if (too_quiet && !too_loud && rms_before > 0.5) {
        double want = (double)TIHU_NORM_TARGET_RMS / rms_before;
        if (want > (double)TIHU_NORM_MAX_GAIN) {
            want = (double)TIHU_NORM_MAX_GAIN;
            hit_max_gain = true;
        }
        /* 峰值保护：放大后不许顶到 30000，超了就用峰值反推一个更小的 g。 */
        if ((double)peak_before * want > (double)TIHU_NORM_PEAK_CEIL) {
            want = (double)TIHU_NORM_PEAK_CEIL / (double)peak_before;
            hit_peak_ceil = true;
        }
        if (want < 1.0) {
            want = 1.0;   /* 太轻的判定下不衰减：宁可偏轻交给宿主质量门，也不凭空缩小 */
            hit_peak_ceil = false;
        }
        g = (float)want;
        how = "放大";
    } else if (too_loud && rms_before > (double)TIHU_NORM_TARGET_RMS) {
        double want = (double)TIHU_NORM_TARGET_RMS / rms_before;
        if ((double)peak_before * want > (double)TIHU_NORM_PEAK_CEIL) {
            want = (double)TIHU_NORM_PEAK_CEIL / (double)peak_before;
            hit_peak_ceil = true;
        }
        /* 最多衰减到 1/4（−12 dB），再低就是真的没听见人声，缩下去也没用。 */
        if (want < 0.25) {
            want = 0.25;
        }
        g = (float)want;
        how = "削顶衰减";
    }

    if (g != 1.0f) {
        int16_t *samples = (int16_t *)pcm;
        for (size_t i = 0; i < frames; i++) {
            float v = (float)samples[i] * g;
            if (v > 32767.0f) {
                v = 32767.0f;
            } else if (v < -32768.0f) {
                v = -32768.0f;
            }
            samples[i] = (int16_t)(v >= 0.0f ? (v + 0.5f) : (v - 0.5f));
        }
    }

    double rms_after = rms_before;
    int32_t peak_after = peak_before;
    if (g != 1.0f) {
        measure_pcm(pcm, bytes, &rms_after, &peak_after);
    }
    ESP_LOGI(TAG, "归一化：高通后 RMS=%.0f 峰值=%d → g=%.2f（%s）%s%s → 归一化后 RMS=%.0f 峰值=%d"
                  "（目标 RMS=%.0f；放大门限 RMS<%.0f 或 峰值<%d；g≤%.1f；峰值×g≤%.0f）",
             rms_before, (int)peak_before, (double)g, how,
             hit_peak_ceil ? "（受峰值上限限制）" : "",
             hit_max_gain ? "（受 8 倍上限限制）" : "",
             rms_after, (int)peak_after,
             (double)TIHU_NORM_TARGET_RMS, (double)TIHU_NORM_RMS_TRIGGER,
             TIHU_NORM_PEAK_TRIGGER, (double)TIHU_NORM_MAX_GAIN,
             (double)TIHU_NORM_PEAK_CEIL);
    return g;
}

static void mic_task(void *arg)
{
    (void)arg;
    if (s_mic == NULL || s_mic_buf == NULL) {
        s_mic_active = false;
        s_mic_running = false;
        s_mic_task = NULL;
        tihu_wake_resume();
        xSemaphoreGive(s_mic_done);
        vTaskDelete(NULL);
        return;
    }

    esp_codec_dev_sample_info_t fs = {
        .sample_rate = MIC_SAMPLE_RATE,
        .channel = MIC_CAPTURE_CHANNELS,
        .bits_per_sample = MIC_BITS,
    };
    esp_err_t err = esp_codec_dev_open(s_mic, &fs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "麦克风打开失败: %s", esp_err_to_name(err));
        {
            char dfail[128];
            snprintf(dfail, sizeof(dfail), "micopen fail rc=%d src=%s", (int)err, s_mic_source);
            tihu_ota_diag(dfail);
        }
        s_mic_active = false;
        s_mic_running = false;
        s_mic_task = NULL;
        tihu_wake_resume();
        xSemaphoreGive(s_mic_done);
        vTaskDelete(NULL);
        return;
    }
    esp_codec_dev_set_in_gain(s_mic, s_mic_gain_db);
    /* 0.3.6：开录先摊牌——请求的 dB 和 ES7210 寄存器里真正的档位各是多少。 */
    log_mic_gain_applied(s_mic_gain_db);

    /*
     * chunk 用 int16_t 数组而不是 uint8_t：统计要按采样读，避免从 uint8_t 指针强转出
     * 未对齐的 int16 访问。320 个采样 = 640 字节 = 20 ms @ 16k/单声道。
     */
    static int16_t chunk[320];
    size_t pcm_len = 0;
    /* 0.3.6 录音统计：点数/峰值/平方和/削波数，收尾时一次性打出来。 */
    uint64_t sum_sq_ch[MIC_CAPTURE_CHANNELS] = {0};
    uint32_t n_samp_ch[MIC_CAPTURE_CHANNELS] = {0};
    int32_t peak_ch[MIC_CAPTURE_CHANNELS] = {0};
    uint32_t clip_ch[MIC_CAPTURE_CHANNELS] = {0};
    uint32_t n_samples = 0;
    int32_t peak = 0;
    uint32_t clip = 0;
    while (s_mic_running && pcm_len < MIC_MAX_CAPTURE_BYTES) {
        size_t room = MIC_MAX_CAPTURE_BYTES - pcm_len;
        size_t want = room < sizeof(chunk) ? room : sizeof(chunk);
        /* esp_codec_dev_read 返回 ESP_CODEC_DEV_OK(0)；成功时整块 want 已被填满。 */
        int rc = esp_codec_dev_read(s_mic, chunk, (int)want);
        if (rc == ESP_CODEC_DEV_OK) {
            /* 半个采样不参与统计（want 理论上永远是偶数，这里仍然按 2 字节对齐截断）。 */
                size_t frames = want / sizeof(int16_t);
                for (size_t i2 = 0; i2 + MIC_CAPTURE_CHANNELS <= frames; i2 += MIC_CAPTURE_CHANNELS) {
                    for (int c = 0; c < MIC_CAPTURE_CHANNELS; c++) {
                        int32_t s = chunk[i2 + c];
                        int32_t a2 = s < 0 ? -s : s;
                        if (a2 > peak_ch[c]) {
                            peak_ch[c] = a2;
                        }
                        if (a2 >= TIHU_MIC_CLIP_LEVEL) {
                            clip_ch[c]++;
                        }
                        sum_sq_ch[c] += (uint64_t)((int64_t)s * (int64_t)s);
                        n_samp_ch[c]++;
                    }
                }
                n_samples += (uint32_t)(frames / MIC_CAPTURE_CHANNELS);
            memcpy(s_mic_buf + WAV_HEADER_BYTES + pcm_len, chunk, want);
            pcm_len += want;
        } else {
            ESP_LOGW(TAG, "mic read: %d", rc);
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
    esp_codec_dev_close(s_mic);

    int best = 0;
    double rms_ch[MIC_CAPTURE_CHANNELS] = {0};
    for (int c = 0; c < MIC_CAPTURE_CHANNELS; c++) {
        rms_ch[c] = n_samp_ch[c] ? sqrt((double)sum_sq_ch[c] / (double)n_samp_ch[c]) : 0.0;
    }
    for (int c = 1; c < MIC_CAPTURE_CHANNELS; c++) {
        if (rms_ch[c] > rms_ch[best]) {
            best = c;
        }
    }
    ESP_LOGI(TAG, "多声道录音：ch0 RMS=%.0f 峰值=%d / ch1 RMS=%.0f 峰值=%d → 取 ch%d",
             rms_ch[0], (int)peak_ch[0], MIC_CAPTURE_CHANNELS > 1 ? rms_ch[1] : 0.0,
             MIC_CAPTURE_CHANNELS > 1 ? (int)peak_ch[1] : 0, best);
    {
        char diag[320];
        snprintf(diag, sizeof(diag),
                 "mic ch0 rms=%.0f peak=%d | ch1 rms=%.0f peak=%d | best=%d clip0=%u clip1=%u",
                 rms_ch[0], (int)peak_ch[0],
                 MIC_CAPTURE_CHANNELS > 1 ? rms_ch[1] : 0.0,
                 MIC_CAPTURE_CHANNELS > 1 ? (int)peak_ch[1] : 0, best,
                 (unsigned)clip_ch[0], MIC_CAPTURE_CHANNELS > 1 ? (unsigned)clip_ch[1] : 0u);
        tihu_ota_diag(diag);
    }
    if (pcm_len > 0) {
        size_t total_frames = pcm_len / (sizeof(int16_t) * MIC_CAPTURE_CHANNELS);
        int16_t *src = (int16_t *)(s_mic_buf + WAV_HEADER_BYTES);
        int16_t *dst = src;
        for (size_t f = 0; f < total_frames; f++) {
            dst[f] = src[f * MIC_CAPTURE_CHANNELS + best];
        }
        pcm_len = total_frames * sizeof(int16_t);
    }
    n_samples = n_samp_ch[best];
    peak = peak_ch[best];
    clip = clip_ch[best];
    uint64_t sum_sq = sum_sq_ch[best];
    /* 原始统计（只打日志，不改增益）：采样点/峰值/RMS/削波占比。 */
    log_mic_capture_stats(n_samples, peak,
                          n_samples > 0 ? sqrt((double)sum_sq / (double)n_samples) : 0.0,
                          clip);
    /*
     * 0.4.0：组 WAV 之前做「高通 + 软件归一化」——硬件增益固定 30 dB 之后的响度统一工作。
     * 放在 close 之后、speaker_open_24k 之前：这段纯 CPU（10 s ≈ 160k 采样，几十毫秒），
     * 与 codec/I2S 无关；万一这里慢也只会推迟几十毫秒，不影响下一步恢复 24k 播放。
     */
    if (pcm_len > 0) {
        (void)normalize_mic_pcm(s_mic_buf + WAV_HEADER_BYTES, pcm_len);
    }
    /* 录音期间 I2S 被切到 16k；恢复 24k，下一段 TTS 才不会变调。 */
    speaker_open_24k();
    s_mic_pcm_len = pcm_len;
    s_mic_active = false;
    s_mic_running = false;
    s_mic_task = NULL;
    tihu_wake_resume();
    xSemaphoreGive(s_mic_done);
    vTaskDelete(NULL);
}

/** 上一次录音任务是什么时候建的（ms）：用来判断它到底是「还在录」还是「卡死了」 */
static int64_t s_mic_task_born_ms;
/**
 * 一个录音任务最多活这么久就算「该退没退」。
 *
 * TIHU_MIC_MAX_SECONDS(10 s) 是单次录音上限，任务到这个长度自己收尾退出；
 * 再留 3 s 余量给 codec close / 恢复 24k 扬声器。超过 13 s 还挂着 = 卡死
 * （典型：codec/I2C 事务卡住），0.3.9 起直接回收句柄重开，而不是从此再也录不了。
 */
#define MIC_TASK_STALE_MS ((TIHU_MIC_MAX_SECONDS + 3) * 1000)

bool tihu_audio_mic_ready(void)
{
    return s_mic != NULL && s_mic_buf != NULL && s_mic_done != NULL;
}

bool tihu_audio_mic_start(void)
{
    if (!tihu_audio_mic_ready()) {
        ESP_LOGW(TAG, "录音未就绪：codec=%s 缓冲=%s 信号量=%s（麦克风 codec 初始化失败？）",
                 s_mic != NULL ? "有" : "无",
                 s_mic_buf != NULL ? "有" : "无",
                 s_mic_done != NULL ? "有" : "无");
        return false;
    }
    /*
     * 0.6.0 唤醒词：唤醒任务可能正占着 ES7210/I2S RX（16 k）。先让它**自己**关麦
     * （不在别的任务里 close 正在 read 的句柄），录音任务再独占 codec；否则两边会
     * 同时 open/read 同一个句柄。
     */
    if (!tihu_wake_pause()) {
        ESP_LOGW(TAG, "唤醒任务未让出麦克风，本次不录音");
        return false;
    }
    if (s_mic_task != NULL) {
        int64_t age_ms = esp_timer_get_time() / 1000 - s_mic_task_born_ms;
        if (age_ms < MIC_TASK_STALE_MS) {
            /* 正常并发：上一次录音任务还在跑（例如刚松开又按住），沿用同一个任务。 */
            ESP_LOGW(TAG, "上一次录音任务仍在运行（已 %d ms），本次沿用", (int)age_ms);
            return true;
        }
        /*
         * 卡死自愈（0.3.9）：0.3.8 之前这里直接 return，于是「录音任务卡住一次」
         * 就等于「从此以后每次按 CONFIG 都静默无声」——屏上在听、一个字节都没有。
         * 现在把句柄清掉重开，即使旧任务永远退不出来，下一次按键至少还能录。
         */
        ESP_LOGW(TAG, "上一次录音任务 %d ms 未退出（疑似卡死），回收句柄后重开",
                 (int)age_ms);
        s_mic_running = false;
        s_mic_active = false;
        s_mic_task = NULL;
        (void)xSemaphoreTake(s_mic_done, 0);
    }
    s_mic_pcm_len = 0;
    write_wav_header(s_mic_buf, 0);
    /* 清掉上一次任务留下的信号，避免 stop 立刻返回、录到一半就发出去。 */
    (void)xSemaphoreTake(s_mic_done, 0);
    s_mic_running = true;
    s_mic_active = true;
    s_mic_task_born_ms = esp_timer_get_time() / 1000;
    if (xTaskCreate(mic_task, "tihu_mic", 6144, NULL, 6, &s_mic_task) != pdPASS) {
        s_mic_running = false;
        s_mic_active = false;
        s_mic_task = NULL;
        ESP_LOGE(TAG, "录音任务创建失败（内部 RAM 不够？）");
        tihu_wake_resume();
        return false;
    }
    return true;
}

const uint8_t *tihu_audio_mic_stop(size_t *len)
{
    if (len != NULL) {
        *len = 0;
    }
    if (s_mic_buf == NULL) {
        return NULL;
    }
    if (s_mic_task != NULL) {
        s_mic_running = false;
        /* 等录音任务退出；它退出时会关闭 codec 并 patch 长度。 */
        if (s_mic_done != NULL) {
            if (xSemaphoreTake(s_mic_done, pdMS_TO_TICKS(1500)) != pdTRUE) {
                /*
                 * 1500 ms 没等到：录音任务没按信号退出（卡在 codec open/read/close 里）。
                 * 0.3.9 起只记一条日志并把已有数据交出去；句柄由 mic_start 的
                 * MIC_TASK_STALE_MS 判定回收，绝不因此让后续按键永远录不到音。
                 */
                ESP_LOGW(TAG, "录音任务 1500 ms 未退出（已有 %u 字节数据），先按现有数据上传",
                         (unsigned)s_mic_pcm_len);
            }
        }
    }
    if (s_mic_pcm_len == 0) {
        return NULL;
    }
    write_wav_header(s_mic_buf, (uint32_t)s_mic_pcm_len);
    if (len != NULL) {
        *len = WAV_HEADER_BYTES + s_mic_pcm_len;
    }
    return s_mic_buf;
}

bool tihu_audio_mic_active(void)
{
    return s_mic_active;
}

bool tihu_audio_mic_source_text(char *out, size_t cap)
{
    if (out == NULL || cap == 0) {
        return false;
    }
    snprintf(out, cap, "micsrc=%s", s_mic_source);
    return true;
}

/**
 * 用现有 codec 句柄读 ES7210 关键寄存器（不新建 I2C 设备，避免同地址重复挂载）。
 * 只想看它到底被初始化成什么样：模拟电源/麦克风偏置/增益/时钟。
 */
bool tihu_audio_mic_regs_text(char *out, size_t cap)
{
    if (s_mic == NULL || out == NULL || cap < 32) {
        return false;
    }
    static const uint8_t regs[] = { 0x00, 0x01, 0x02, 0x07, 0x08, 0x40, 0x41, 0x42,
                                    0x43, 0x44, 0x45, 0x46, 0x4B, 0x4C, 0x4D };
    int w = snprintf(out, cap, "es7210 %s", s_mic_source);
    for (size_t i = 0; i < sizeof(regs) / sizeof(regs[0]) && w < (int)cap - 12; i++) {
        int v = -1;
        int rc = esp_codec_dev_read_reg(s_mic, regs[i], &v);
        w += snprintf(out + w, cap - (size_t)w, " %02X=%02X%s", regs[i],
                      (rc == 0) ? (v & 0xFF) : 0xEE, (rc == 0) ? "" : "!");
    }
    return true;
}

/* ------------------- 板内唤醒词：共享麦克风 + 提示音（0.6.0） ------------------- */

/*
 * 唤醒任务（tihu_wake.c）常驻读 ES7210。它和录音任务用的是**同一个** esp_codec_dev
 * 句柄 s_mic：谁要用谁先通过 tihu_wake_pause() 让对方关麦，绝不并发 open/read。
 * 打开时保持 BSP 的 2 声道（两路麦克风），由唤醒任务选一路、降成单声道再喂 AFE。
 */
bool tihu_audio_wake_mic_open(void)
{
    if (s_mic == NULL) {
        ESP_LOGW(TAG, "唤醒监听：麦克风 codec 未初始化");
        return false;
    }
    if (s_mic_active || s_mic_task != NULL) {
        /* 录音优先：唤醒任务不能抢正在录的麦克风。 */
        return false;
    }
    if (s_wake_mic_open) {
        return true;
    }
    esp_codec_dev_sample_info_t fs = {
        .sample_rate = MIC_SAMPLE_RATE,
        .channel = MIC_CAPTURE_CHANNELS,
        .bits_per_sample = MIC_BITS,
    };
    esp_err_t err = esp_codec_dev_open(s_mic, &fs);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "唤醒监听开麦失败: %s", esp_err_to_name(err));
        return false;
    }
    esp_codec_dev_set_in_gain(s_mic, s_mic_gain_db);
    s_wake_mic_open = true;
    ESP_LOGI(TAG, "唤醒监听开麦：%d Hz / %d 声道 / %d bit（与按键录音共用 ES7210，%s）",
             MIC_SAMPLE_RATE, MIC_CAPTURE_CHANNELS, MIC_BITS, s_mic_source);
    return true;
}

int tihu_audio_wake_mic_read(int16_t *interleaved, size_t bytes)
{
    if (!s_wake_mic_open || interleaved == NULL || bytes == 0) {
        return -1;
    }
    /* esp_codec_dev_read 返回 ESP_CODEC_DEV_OK(0)；成功时整块已被填满。 */
    int rc = esp_codec_dev_read(s_mic, interleaved, (int)bytes);
    if (rc != ESP_CODEC_DEV_OK) {
        return -1;
    }
    return (int)(bytes / sizeof(int16_t));
}

void tihu_audio_wake_mic_close(void)
{
    if (!s_wake_mic_open) {
        return;
    }
    esp_codec_dev_close(s_mic);
    /*
     * 16 k RX 关掉后 I2S 还停在 16 k；先把扬声器按 24 k 重开，**最后**才清
     * s_wake_mic_open。顺序不能反：audio_task 用这个标志判断「播放前要不要先让唤醒
     * 任务关麦」；提前清掉会让它在 speaker_open_24k() 还没做完时就开始写 I2S。
     */
    speaker_open_24k();
    s_wake_mic_open = false;
    ESP_LOGI(TAG, "唤醒监听关麦：I2S 已恢复 24 kHz 播放链路");
}

bool tihu_audio_wake_mic_is_open(void)
{
    return s_wake_mic_open;
}

/*
 * 唤醒提示音「叮」：1.5 kHz / 120 ms，8 ms 淡入淡出避免起止爆音。
 * 走与 TTS 完全相同的 StreamBuffer → audio_task → esp_codec_dev_write 链路。
 * 比 0.5 s 的正弦自检短得多——唤醒后要尽快开始录命令，不能等半秒。
 */
static void ding_task(void *arg)
{
    (void)arg;
    const int total_samples = PLAYBACK_RATE * 120 / 1000;
    const int period = PLAYBACK_RATE / 1500;
    const int fade = PLAYBACK_RATE * 8 / 1000;
    const int16_t amp = 7000;
    int16_t *buf = heap_caps_malloc((size_t)total_samples * sizeof(int16_t),
                                    MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) {
        buf = malloc((size_t)total_samples * sizeof(int16_t));
    }
    if (buf == NULL) {
        ESP_LOGW(TAG, "叮：缓冲分配失败");
        vTaskDelete(NULL);
        return;
    }
    for (int i = 0; i < total_samples; i++) {
        float env = 1.0f;
        if (i < fade) {
            env = (float)i / (float)fade;
        } else if (i > total_samples - fade) {
            env = (float)(total_samples - i) / (float)fade;
        }
        float s = sinf(2.0f * 3.14159265358979f * (float)(i % period) / (float)period);
        buf[i] = (int16_t)(s * (float)amp * env);
    }
    tihu_audio_push_pcm((const uint8_t *)buf, (size_t)total_samples * sizeof(int16_t));
    int waited = 0;
    while (tihu_audio_busy() && waited < 600) {
        vTaskDelay(pdMS_TO_TICKS(10));
        waited += 10;
    }
    ESP_LOGI(TAG, "唤醒提示音：1.5 kHz / 120 ms 已播放（等待 %d ms）", waited);
    free(buf);
    vTaskDelete(NULL);
}

void tihu_audio_play_ding(void)
{
    if (xTaskCreate(ding_task, "tihu_ding", 3072, NULL, 5, NULL) != pdPASS) {
        ESP_LOGW(TAG, "叮：任务创建失败");
    }
}
