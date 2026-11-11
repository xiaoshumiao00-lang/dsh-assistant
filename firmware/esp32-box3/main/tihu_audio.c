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

#define AUDIO_STREAM_BYTES   (32 * 1024)
#define AUDIO_TASK_STACK     4096
#define AUDIO_TASK_PRIO      5

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
static int s_volume = TIHU_SPEAKER_VOLUME;

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
        .sample_rate = 24000,
        .channel = 1,
        .bits_per_sample = 16,
    };
    /* 已打开时先关，避免 WRONG_STATE；未打开时 close 返回错误也无所谓。 */
    (void)esp_codec_dev_close(s_spk);
    esp_err_t err = esp_codec_dev_open(s_spk, &fs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "扬声器打开 24k/1ch/16bit 失败: %s", esp_err_to_name(err));
    } else {
        /* 音量要在 open 之后设，open 之前设会报 WRONG_STATE。 */
        esp_codec_dev_set_out_vol(s_spk, s_volume);
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
    uint8_t buf[1024];
    while (true) {
        if (s_paused) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        size_t got = xStreamBufferReceive(s_stream, buf, sizeof(buf), pdMS_TO_TICKS(40));
        if (got == 0) {
            if (s_playing && (esp_timer_get_time() / 1000 - s_last_write_ms) > 300) {
                s_playing = false;
            }
            continue;
        }
        if (s_spk != NULL) {
            /* esp_codec_dev_write 返回 ESP_CODEC_DEV_OK(0)，不是写入字节数。 */
            int rc = esp_codec_dev_write(s_spk, buf, (int)got);
            if (rc != ESP_CODEC_DEV_OK) {
                ESP_LOGW(TAG, "speaker write 失败: %d", rc);
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
    size_t sent = xStreamBufferSend(s_stream, pcm, len, pdMS_TO_TICKS(20));
    if (sent < len) {
        /* 不 reset：丢掉新旧都听不清，保留已经排队的部分更接近“继续念”。 */
        ESP_LOGW(TAG, "播放缓冲满，丢弃 %u 字节", (unsigned)(len - sent));
    }
    s_playing = true;
    s_last_write_ms = esp_timer_get_time() / 1000;
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
