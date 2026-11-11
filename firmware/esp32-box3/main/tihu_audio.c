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

static const char *TAG = "tihu_audio";

#define AUDIO_STREAM_BYTES   (64 * 1024)
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

/** 起播预缓冲：600 ms（28800 字节）。edge 分块到达有抖动，攒够再开播，别第一块就断。 */
#define AUDIO_PREBUFFER_BYTES (600 * PLAYBACK_FRAME_BYTES * PLAYBACK_RATE / 1000)
/** 预缓冲最多等这么久（毫秒）：真只有半句话也别一直等。 */
#define AUDIO_PREBUFFER_MAX_MS 600
/** 欠载时补的静音长度：与 receive 超时同量级（40 ms），把「重复上一段 DMA」换成真静音。 */
#define AUDIO_SILENCE_BYTES   (40 * PLAYBACK_FRAME_BYTES * PLAYBACK_RATE / 1000)

#define MIC_SAMPLE_RATE      16000
#define MIC_CHANNELS         1
#define MIC_BITS             16
#define MIC_MAX_PCM_BYTES    (MIC_SAMPLE_RATE * MIC_CHANNELS * (MIC_BITS / 8) * TIHU_MIC_MAX_SECONDS)
#define WAV_HEADER_BYTES     44

static esp_codec_dev_handle_t s_spk;
static esp_codec_dev_handle_t s_mic;
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
static volatile uint32_t s_underrun_warned;

/* 录音：s_mic_buf 为 44 字节头 + PCM，放 PSRAM，避免占内部 RAM。 */
static uint8_t *s_mic_buf;
static size_t s_mic_pcm_len;
static volatile bool s_mic_running;
static volatile bool s_mic_active;
static TaskHandle_t s_mic_task;
static SemaphoreHandle_t s_mic_done;

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

static void audio_task(void *arg)
{
    (void)arg;
    /*
     * 缓冲多留 1 字节：第一格留给「上一块剩下的半个采样」。
     * 16 bit 单声道以 2 字节为一帧，`xStreamBufferReceive` 返回奇数长度时
     * （网络块被截断/缓冲刚好在半个采样处满）绝不能直接写 codec——
     * 一旦写进 I2S，之后所有采样两两错位，24k 语音就变成满幅噪声（实机「滋滋」根因之一）。
     * 做法：奇数则把最后 1 字节留到下一次，拼成整帧再写。
     */
    uint8_t buf[1025];
    uint8_t carry = 0;
    bool has_carry = false;
    uint32_t written_after_underrun = 0;
    while (true) {
        if (s_paused) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        /*
         * 起播预缓冲：刚开播时先攒 600 ms 再喂 DMA，别让第一块刚进 codec 就等下一块。
         * 只对「还没在播」生效；数据迟迟不够（>600 ms）也照播，不无限等。
         */
        if (!s_playing) {
            size_t avail = xStreamBufferBytesAvailable(s_stream);
            int64_t since_push = esp_timer_get_time() / 1000 - s_last_push_ms;
            if (avail > 0 && avail < AUDIO_PREBUFFER_BYTES && since_push < AUDIO_PREBUFFER_MAX_MS) {
                vTaskDelay(pdMS_TO_TICKS(10));
                continue;
            }
        }
        /*
         * 接收上限要按「是否已有半个采样」调：
         *   - 有 carry：buf[0] 被占，最多读 1023 → 拼成整 1024，避免每块都判奇数；
         *   - 无 carry：最多读 1024。
         * （上一版固定读 1024，有 carry 时每块都是 1025 → 日志刷屏且多一次搬运。）
         */
        size_t room = has_carry ? (sizeof(buf) - 2) : (sizeof(buf) - 1);
        size_t got = xStreamBufferReceive(s_stream, buf + 1, room, pdMS_TO_TICKS(40));
        if (got == 0) {
            if (s_playing && s_spk != NULL) {
                s_stat_underruns++;
                /*
                 * 欠载时**主动写 40 ms 静音**：ESP-IDF 的 I2S 在 DMA 空了以后会重复上一段
                 * DMA 内容（默认 auto_clear=false），那正是一段 20–40 ms 的循环 → 听成「嗡/滋滋」。
                 * 用静音把 DMA 喂住，代价是这 40 ms 没声音（可接受的断点），换来不重复旧数据。
                 */
                static const uint8_t silence[AUDIO_SILENCE_BYTES] = {0};
                (void)esp_codec_dev_write(s_spk, (void *)silence, sizeof(silence));
                if (s_stat_underruns == 1 || s_stat_underruns >= s_underrun_warned + 10) {
                    s_underrun_warned = s_stat_underruns;
                    ESP_LOGW(TAG, "播放欠载：第 %u 次（缓冲空，已补 40 ms 静音；旧固件这里会重复 DMA → 嗡/滋滋）",
                             (unsigned)s_stat_underruns);
                }
            }
            if (s_playing && (esp_timer_get_time() / 1000 - s_last_write_ms) > 300) {
                s_playing = false;
            }
            continue;
        }
        size_t total = got;
        size_t off = 1;
        if (has_carry) {
            buf[0] = carry;
            total = got + 1;
            off = 0;
            has_carry = false;
        }
        size_t even = total & ~(size_t)1;   /* 向下取到整帧 */
        if ((total & 1u) != 0) {
            carry = buf[off + total - 1];
            has_carry = true;
            s_stat_odd_chunks++;
            if (s_stat_odd_chunks <= 5 || (s_stat_odd_chunks % 100) == 0) {
                ESP_LOGW(TAG, "块长=%u（奇数），已对齐：末字节暂存，等下一块补成 16-bit 采样（累计 %u 次）",
                         (unsigned)total, (unsigned)s_stat_odd_chunks);
            }
        }
        if (even > 0 && s_spk != NULL) {
            /* esp_codec_dev_write 返回 ESP_CODEC_DEV_OK(0)，不是写入字节数。 */
            int rc = esp_codec_dev_write(s_spk, buf + off, (int)even);
            if (rc != ESP_CODEC_DEV_OK) {
                ESP_LOGW(TAG, "speaker write 失败: %d（块长=%u）", rc, (unsigned)even);
            } else {
                s_stat_writes++;
                if (written_after_underrun == 0 && s_stat_underruns > 0) {
                    written_after_underrun = 1;
                    ESP_LOGI(TAG, "播放恢复：欠载累计 %u 次（已重新有数据）", (unsigned)s_stat_underruns);
                }
            }
        }
        s_last_write_ms = esp_timer_get_time() / 1000;
        s_playing = true;
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

    s_mic = bsp_audio_codec_microphone_init();
    if (s_mic == NULL) {
        ESP_LOGW(TAG, "麦克风 codec 初始化失败：按键说话会不可用");
    } else {
        esp_codec_dev_set_in_gain(s_mic, TIHU_MIC_GAIN_DB);
    }

    /* 两个 codec 都 init 完之后再按 24k 打开扬声器，避免 mic init 重配 I2S。 */
    speaker_open_24k();

    /*
     * 64 KB 一次性从内部 RAM 拿会在启动最紧张的时候失败（实测报
     * “播放 StreamBuffer 创建失败”，TTS 直接没声），放 PSRAM 且减到 32 KB。
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
    s_mic_buf = heap_caps_malloc(WAV_HEADER_BYTES + MIC_MAX_PCM_BYTES,
                                 MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_mic_buf == NULL) {
        s_mic_buf = malloc(WAV_HEADER_BYTES + MIC_MAX_PCM_BYTES);
    }
    if (s_mic_buf == NULL) {
        ESP_LOGE(TAG, "录音缓冲分配失败（需要 %u 字节）",
                 (unsigned)(WAV_HEADER_BYTES + MIC_MAX_PCM_BYTES));
    }
}

void tihu_audio_push_pcm(const uint8_t *pcm, size_t len)
{
    if (pcm == NULL || len == 0 || s_stream == NULL || s_paused) {
        return;
    }
    s_stat_chunks++;
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
    s_playing = true;
    s_last_write_ms = esp_timer_get_time() / 1000;
    s_last_push_ms = s_last_write_ms;
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
    s_underrun_warned = 0;
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
    mute_briefly();
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

static void mic_task(void *arg)
{
    (void)arg;
    if (s_mic == NULL || s_mic_buf == NULL) {
        s_mic_active = false;
        s_mic_running = false;
        s_mic_task = NULL;
        xSemaphoreGive(s_mic_done);
        vTaskDelete(NULL);
        return;
    }

    esp_codec_dev_sample_info_t fs = {
        .sample_rate = MIC_SAMPLE_RATE,
        .channel = MIC_CHANNELS,
        .bits_per_sample = MIC_BITS,
    };
    esp_err_t err = esp_codec_dev_open(s_mic, &fs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "麦克风打开失败: %s", esp_err_to_name(err));
        s_mic_active = false;
        s_mic_running = false;
        s_mic_task = NULL;
        xSemaphoreGive(s_mic_done);
        vTaskDelete(NULL);
        return;
    }
    esp_codec_dev_set_in_gain(s_mic, TIHU_MIC_GAIN_DB);

    uint8_t chunk[640];                   /* 20 ms @ 16k/16bit/单声道 */
    size_t pcm_len = 0;
    while (s_mic_running && pcm_len < MIC_MAX_PCM_BYTES) {
        size_t room = MIC_MAX_PCM_BYTES - pcm_len;
        size_t want = room < sizeof(chunk) ? room : sizeof(chunk);
        /* esp_codec_dev_read 返回 ESP_CODEC_DEV_OK(0)；成功时整块 want 已被填满。 */
        int rc = esp_codec_dev_read(s_mic, chunk, (int)want);
        if (rc == ESP_CODEC_DEV_OK) {
            memcpy(s_mic_buf + WAV_HEADER_BYTES + pcm_len, chunk, want);
            pcm_len += want;
        } else {
            ESP_LOGW(TAG, "mic read: %d", rc);
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
    esp_codec_dev_close(s_mic);
    /* 录音期间 I2S 被切到 16k；恢复 24k，下一段 TTS 才不会变调。 */
    speaker_open_24k();
    s_mic_pcm_len = pcm_len;
    s_mic_active = false;
    s_mic_running = false;
    s_mic_task = NULL;
    xSemaphoreGive(s_mic_done);
    vTaskDelete(NULL);
}

void tihu_audio_mic_start(void)
{
    if (s_mic == NULL || s_mic_buf == NULL || s_mic_done == NULL || s_mic_task != NULL) {
        return;
    }
    s_mic_pcm_len = 0;
    write_wav_header(s_mic_buf, 0);
    if (s_mic_done != NULL) {
        /* 清掉上一次任务留下的信号，避免 stop 立刻返回、录到一半就发出去。 */
        (void)xSemaphoreTake(s_mic_done, 0);
    }
    s_mic_running = true;
    s_mic_active = true;
    if (xTaskCreate(mic_task, "tihu_mic", 4096, NULL, 6, &s_mic_task) != pdPASS) {
        s_mic_running = false;
        s_mic_active = false;
        s_mic_task = NULL;
        ESP_LOGE(TAG, "录音任务创建失败");
    }
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
            xSemaphoreTake(s_mic_done, pdMS_TO_TICKS(1500));
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
