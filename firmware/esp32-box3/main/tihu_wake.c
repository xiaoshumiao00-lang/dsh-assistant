/**
 * 板内语音唤醒（ESP-SR 2.6 / AFE v1 / WakeNet9「嗨，乐鑫」）。
 *
 * 数据流：
 *   ES7210 (I2S RX, 16 kHz / 2 ch / 16 bit) → 每 30 ms 读 1920 B
 *     → 选一路更好的麦克风（开机前 8 帧比较 RMS）→ 单声道 480 采样
 *     → 攒成 AFE 的 feed 帧（get_feed_chunksize，通常是 512 采样 / 32 ms）
 *     → afe->feed() + afe->fetch_with_delay() → wakeup_state == WAKENET_DETECTED
 *     → 关麦（I2S 恢复 24 k）→ 叮 120 ms → on_wake()（main.c 的 voice_command_record）
 *
 * 为什么必须「关麦再叮」：BOX-3 的 ES7210(RX) 与 ES8311(TX) 共用同一组 I2S 时钟，
 * 唤醒时 I2S 被切到 16 kHz，直接播 24 kHz 的叮会变调；tihu_audio_wake_mic_close()
 * 在关麦后会把扬声器重新按 24 kHz 打开。
 *
 * 与录音/播放的互斥：
 *   - 唤醒任务独占 RX；录音前 tihu_audio_mic_start() 调 tihu_wake_pause()，
 *     播放前 audio_task 调 tihu_wake_pause()，都由唤醒任务**自己** close codec
 *     （不在别的任务里 close 正在 read 的句柄）。
 *   - 回调返回后 reset_buffer，避免把回调期间的静音/残留喂进检测。
 */
#include "tihu_wake.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "esp_afe_config.h"
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "model_path.h"
#include "tihu_audio.h"
#include "tihu_net.h"
#include "tihu_ota.h"

static const char *TAG = "tihu_wake";

/** 唤醒任务：栈 8 KB（AFE fetch + 推理 + 回调里的 WAV 组装都在这个任务里）。 */
#define WK_TASK_NAME          "tihu_wake_sr"
#define WK_TASK_STACK         (8 * 1024)
#define WK_TASK_PRIO          4

/** 从 ES7210 读的帧长：30 ms @ 16 kHz = 480 采样（单声道）。 */
#define WK_FRAME_MS           30
#define WK_SAMPLE_RATE        16000
#define WK_FRAME_SAMPLES      ((WK_SAMPLE_RATE * WK_FRAME_MS) / 1000)
/** ES7210 在 BSP 里按 2 通道采（两路麦克风），读出来是交织的。 */
#define WK_MIC_CHANNELS       2
#define WK_RAW_SAMPLES        (WK_FRAME_SAMPLES * WK_MIC_CHANNELS)
/** 开麦后用前 8 帧（240 ms）比较两路麦克风的能量，选一路喂 AFE（不做混音，避免梳状滤波）。 */
#define WK_CH_PROBE_FRAMES    8
/** tihu_wake_pause() 等唤醒任务让出麦克风的上限。 */
#define WK_RELEASE_TIMEOUT_MS 1000

/* target_add_binary_data() 生成的符号：main/models/srmodels.bin → _binary_srmodels_bin_* */
extern const uint8_t srmodels_bin_start[] asm("_binary_srmodels_bin_start");
extern const uint8_t srmodels_bin_end[] asm("_binary_srmodels_bin_end");

static SemaphoreHandle_t s_state_lock;    /* 保护 s_paused / s_mic_held 的短临界区 */
static SemaphoreHandle_t s_mic_released;  /* 唤醒任务关麦后 give，pause() 在此等 */
static volatile bool s_paused;
static volatile bool s_mic_held;
static volatile bool s_running;
static tihu_wake_cb_t s_on_wake;

static const esp_afe_sr_iface_t *s_afe;
static esp_afe_sr_data_t *s_afe_data;
static int16_t *s_feed_buf;
static int s_feed_chunk;      /* AFE 每帧采样数（单声道） */
static int s_feed_fill;
static volatile uint32_t s_frames_fed;
static volatile uint32_t s_wake_hits;
static volatile int s_last_rms;
static volatile int s_last_ch;
static volatile uint32_t s_open_fails;
static volatile uint32_t s_read_fails;
static volatile int s_should_listen;
static char *s_model_name;

static void wake_mic_close(void)
{
    bool held;
    if (s_state_lock != NULL) {
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        held = s_mic_held;
        s_mic_held = false;
        xSemaphoreGive(s_state_lock);
    } else {
        held = s_mic_held;
        s_mic_held = false;
    }
    if (!held) {
        return;
    }
    /* 只由唤醒任务调用：close codec + 把 I2S 拉回 24 kHz，供叮/TTS 使用。 */
    tihu_audio_wake_mic_close();
    xSemaphoreGive(s_mic_released);
}

static bool wake_mic_open(void)
{
    /* 先清掉上一次 close 留在信号量里的令牌，避免 pause() 误以为已经让出。 */
    (void)xSemaphoreTake(s_mic_released, 0);

    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    if (s_paused || s_mic_held) {
        xSemaphoreGive(s_state_lock);
        return false;
    }
    s_mic_held = true;
    xSemaphoreGive(s_state_lock);

    if (!tihu_audio_wake_mic_open()) {
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        s_mic_held = false;
        xSemaphoreGive(s_state_lock);
        return false;
    }
    return true;
}

bool tihu_wake_pause(void)
{
    if (!s_running || s_state_lock == NULL) {
        return true;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    s_paused = true;
    bool held = s_mic_held;
    xSemaphoreGive(s_state_lock);

    if (!held) {
        return true;
    }
    if (xSemaphoreTake(s_mic_released, pdMS_TO_TICKS(WK_RELEASE_TIMEOUT_MS)) != pdTRUE) {
        ESP_LOGW(TAG, "等待唤醒任务释放麦克风超时（%d ms）：本次不开麦", WK_RELEASE_TIMEOUT_MS);
        return false;
    }
    return true;
}

void tihu_wake_resume(void)
{
    if (!s_running || s_state_lock == NULL) {
        return;
    }
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    s_paused = false;
    xSemaphoreGive(s_state_lock);
}

bool tihu_wake_running(void)
{
    return s_running;
}

/** 唤醒命中：关麦 → 叮 → 回调 → 清 AFE 缓冲。全部在唤醒任务上下文里。 */
static void wake_on_detected(const afe_fetch_result_t *res)
{
    s_wake_hits++;
    ESP_LOGW(TAG, "唤醒命中：wakenet#%d word#%d（模型 %s，%d 采样），先叮一声再录音",
             res->wakenet_model_index, res->wake_word_index,
             s_model_name != NULL ? s_model_name : "?",
             res->wake_word_length);

    /* 关麦（含恢复 24 k）之后才能播；唤醒期间不能在被占用的 I2S 上写 TTS。 */
    wake_mic_close();

    tihu_audio_play_ding();
    /* 叮是 120 ms；播放任务由 push 之后才 busy，先等一小会儿再等排空。 */
    vTaskDelay(pdMS_TO_TICKS(60));
    for (int i = 0; i < 25 && tihu_audio_busy(); i++) {
        vTaskDelay(pdMS_TO_TICKS(20));
    }

    if (s_on_wake != NULL) {
        s_on_wake();
    }

    /* 回调里录了 5 s、I2S 来回切过；丢掉旧帧再继续检测。 */
    if (s_afe != NULL && s_afe_data != NULL) {
        (void)s_afe->reset_buffer(s_afe_data);
    }
    s_feed_fill = 0;
}

static bool should_listen(void)
{
    /* 播放语音、正在录音、网络没连、被显式暂停 → 不碰 I2S。 */
    return s_running && !s_paused && tihu_net_connected() &&
           !tihu_audio_busy() && !tihu_audio_mic_active();
}

static void wake_task(void *arg)
{
    (void)arg;
    int16_t *raw = heap_caps_malloc(WK_RAW_SAMPLES * sizeof(int16_t),
                                    MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (raw == NULL) {
        raw = malloc(WK_RAW_SAMPLES * sizeof(int16_t));
    }
    if (raw == NULL) {
        ESP_LOGE(TAG, "唤醒任务：读缓冲分配失败（%u B）",
                 (unsigned)(WK_RAW_SAMPLES * sizeof(int16_t)));
        s_running = false;
        vTaskDelete(NULL);
        return;
    }

    int ch = 0;
    int probe = 0;
    uint64_t sq[WK_MIC_CHANNELS] = {0};
    tihu_ota_diag("wake task loop begin");
    ESP_LOGI(TAG, "唤醒任务已启动：任务名=%s 栈=%d B 优先级=%d core=%d；"
                  "读帧=%d ms/%d 采样/2 声道，AFE feed=%d 采样",
             WK_TASK_NAME, WK_TASK_STACK, WK_TASK_PRIO, xPortGetCoreID(),
             WK_FRAME_MS, WK_FRAME_SAMPLES, s_feed_chunk);

    while (s_running) {
        s_should_listen = should_listen() ? 1 : 0;
        {
            static uint32_t hb = 0;
            static int64_t hb_ms = 0;
            static uint32_t hb_last_frame = 0;
            int64_t now_ms = esp_timer_get_time() / 1000;
            if (hb_ms == 0 || now_ms - hb_ms >= 5000) {
                hb++;
                hb_ms = now_ms;
                char line[200];
                snprintf(line, sizeof(line),
                         "wake hb=%u listen=%d net=%d busy=%d micact=%d held=%d paused=%d afe=%d frames=%u(+%u) rms=%d ch=%d hits=%u ofail=%u rfail=%u",
                         (unsigned)hb, s_should_listen, (int)tihu_net_connected(),
                         (int)tihu_audio_busy(), (int)tihu_audio_mic_active(),
                         (int)s_mic_held, (int)s_paused, s_afe != NULL ? 1 : 0,
                         (unsigned)s_frames_fed, (unsigned)(s_frames_fed - hb_last_frame),
                         s_last_rms, s_last_ch, (unsigned)s_wake_hits,
                         (unsigned)s_open_fails, (unsigned)s_read_fails);
                hb_last_frame = s_frames_fed;
                tihu_ota_diag(line);
            }
        }
        if (!should_listen()) {
            if (s_mic_held) {
                wake_mic_close();
            }
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        if (!s_mic_held) {
            if (!wake_mic_open()) {
                s_open_fails++;
                vTaskDelay(pdMS_TO_TICKS(500));
                continue;
            }
            probe = 0;
            ch = 0;
            sq[0] = 0;
            sq[1] = 0;
            /* 刚开 codec：等 I2S 时钟稳定，前几十毫秒容易是咔哒声。 */
            vTaskDelay(pdMS_TO_TICKS(50));
            if (s_paused) {
                /* 开麦期间别人（录音/播放）要麦：立刻还回去，别多读一帧。 */
                wake_mic_close();
                continue;
            }
        }

        int got = tihu_audio_wake_mic_read(raw, WK_RAW_SAMPLES * sizeof(int16_t));
        if (got <= 0) {
            s_read_fails++;
            ESP_LOGW(TAG, "读 ES7210 失败（%d），先关麦重开", got);
            wake_mic_close();
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        int frames = got / WK_MIC_CHANNELS;

        /* 开麦后先比两路麦克风：BOX-3 两路都在 ES7210 上，但灵敏度/孔位有差异。 */
        if (probe < WK_CH_PROBE_FRAMES) {
            for (int i = 0; i < frames; i++) {
                for (int c = 0; c < WK_MIC_CHANNELS; c++) {
                    int32_t v = raw[i * WK_MIC_CHANNELS + c];
                    sq[c] += (uint64_t)((int64_t)v * (int64_t)v);
                }
            }
            probe++;
            if (probe == WK_CH_PROBE_FRAMES) {
                double rms0 = sqrt((double)sq[0] / (double)(WK_FRAME_SAMPLES * probe));
                double rms1 = sqrt((double)sq[1] / (double)(WK_FRAME_SAMPLES * probe));
                ch = (rms1 > rms0) ? 1 : 0;
                ESP_LOGI(TAG, "麦克风声道选择：ch0 RMS=%.0f / ch1 RMS=%.0f → 用 ch%d",
                         rms0, rms1, ch);
            }
            continue;
        }

        for (int i = 0; i < frames; i++) {
            s_feed_buf[s_feed_fill++] = raw[i * WK_MIC_CHANNELS + ch];
            {
                static uint32_t rms_acc = 0;
                static uint32_t rms_n = 0;
                int32_t v = raw[i * WK_MIC_CHANNELS + ch];
                rms_acc += (uint32_t)((int32_t)v * v / 256);
                if (++rms_n >= 512) {
                    s_last_rms = (int)sqrt((double)rms_acc / (double)rms_n * 256.0);
                    s_last_ch = ch;
                    rms_acc = 0;
                    rms_n = 0;
                }
            }
            if (s_feed_fill < s_feed_chunk) {
                continue;
            }
            s_feed_fill = 0;
            s_frames_fed++;
            (void)s_afe->feed(s_afe_data, s_feed_buf);

            /*
             * fetch 用 0 超时（非阻塞）：AFE 内部按自己的帧率出结果，出多少取多少，
             * 绝不在这里等 2 s——否则同一任务里的 feed 会被饿死，形成死锁。
             */
            afe_fetch_result_t *res = NULL;
            while ((res = s_afe->fetch_with_delay(s_afe_data, 0)) != NULL) {
                if (res->ret_value == ESP_FAIL) {
                    ESP_LOGW(TAG, "AFE fetch 失败");
                    break;
                }
                if (res->wakeup_state == WAKENET_DETECTED) {
                    wake_on_detected(res);
                    break;
                }
            }
        }
    }

    free(raw);
    ESP_LOGW(TAG, "唤醒任务退出");
    vTaskDelete(NULL);
}

void tihu_wake_start(void (*on_wake)(void))
{
    if (s_running) {
        ESP_LOGW(TAG, "唤醒任务已经在跑，忽略重复启动");
        return;
    }
    s_on_wake = on_wake;
    tihu_ota_diag("wake start begin");

    s_state_lock = xSemaphoreCreateMutex();
    s_mic_released = xSemaphoreCreateBinary();
    if (s_state_lock == NULL || s_mic_released == NULL) {
        ESP_LOGE(TAG, "唤醒任务：信号量创建失败");
        return;
    }

    size_t blob_len = (size_t)(srmodels_bin_end - srmodels_bin_start);
    ESP_LOGI(TAG, "内嵌唤醒词模型包：%u 字节（%.1f KB，编进 app 分区）",
             (unsigned)blob_len, (double)blob_len / 1024.0);
    if (blob_len < 32) {
        ESP_LOGE(TAG, "模型包异常（%u B）：检查 main/models/srmodels.bin", (unsigned)blob_len);
        return;
    }

    /*
     * 复制到 PSRAM 再解析：内嵌段由 .S 生成，符号本身不保证 4 字节对齐，
     * 而模型包内部按 int32 读头部/偏移；PSRAM 堆分配天然对齐。
     */
    uint8_t *blob = heap_caps_malloc(blob_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (blob == NULL) {
        blob = malloc(blob_len);
    }
    if (blob == NULL) {
        ESP_LOGE(TAG, "模型包缓冲分配失败（%u B）", (unsigned)blob_len);
        return;
    }
    memcpy(blob, srmodels_bin_start, blob_len);

    srmodel_list_t *models = srmodel_load(blob);
    if (models == NULL || models->num <= 0) {
        ESP_LOGE(TAG, "模型包解析失败：srmodel_load 返回空");
        free(blob);
        return;
    }
    for (int i = 0; i < models->num; i++) {
        ESP_LOGI(TAG, "模型[%d] %s：%s", i, models->model_name[i],
                 models->model_info[i] != NULL ? models->model_info[i] : "-");
    }

    char *wn = esp_srmodel_filter(models, ESP_WN_PREFIX, "hilexin");
    if (wn == NULL) {
        wn = esp_srmodel_filter(models, ESP_WN_PREFIX, NULL);
    }
    if (wn == NULL) {
        ESP_LOGE(TAG, "模型包里没有 WakeNet（hilexin）模型");
        return;
    }
    s_model_name = wn;

    /* 单声道输入 "M"：AFE 只做 NS + VAD + WakeNet，不做 AEC/BSS（没有参考通道）。 */
    afe_config_t *cfg = afe_config_init("M", models, AFE_TYPE_SR, AFE_MODE_HIGH_PERF);
    if (cfg == NULL) {
        ESP_LOGE(TAG, "afe_config_init 失败");
        return;
    }
    cfg->wakenet_init = true;
    cfg->wakenet_model_name = wn;
    cfg->wakenet_mode = DET_MODE_95;
    cfg->aec_init = false;   /* 没有播放参考通道 */
    cfg->se_init = false;    /* 单麦不做盲源分离 */
    cfg->ns_init = true;     /* WebRTC 噪声抑制：远场/空调噪声下更稳 */
    cfg->vad_init = true;
    cfg->agc_init = true;    /* 远场小声也能被 WakeNet 看见 */
    cfg->afe_type = AFE_TYPE_SR;
    cfg->memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;
    cfg->fixed_first_channel = true;
    cfg->fixed_output_channel = true;
    cfg->debug_init = false;
    (void)afe_config_check(cfg);
    afe_config_print(cfg);

    s_afe = esp_afe_handle_from_config(cfg);
    if (s_afe == NULL) {
        ESP_LOGE(TAG, "esp_afe_handle_from_config 失败");
        afe_config_free(cfg);
        return;
    }
    s_afe_data = s_afe->create_from_config(cfg);
    if (s_afe_data == NULL) {
        ESP_LOGE(TAG, "AFE 实例创建失败（PSRAM/内部 RAM 不够？）");
        afe_config_free(cfg);
        return;
    }
    int feed_samples = s_afe->get_feed_chunksize(s_afe_data);
    int feed_ch = s_afe->get_feed_channel_num(s_afe_data);
    int feed_rate = s_afe->get_samp_rate(s_afe_data);
    if (feed_samples <= 0 || feed_ch <= 0) {
        ESP_LOGE(TAG, "AFE 参数异常：feed=%d 采样 / %d 声道", feed_samples, feed_ch);
        s_afe->destroy(s_afe_data);
        s_afe_data = NULL;
        afe_config_free(cfg);
        return;
    }
    s_feed_chunk = feed_samples;
    s_feed_buf = heap_caps_malloc((size_t)feed_samples * feed_ch * sizeof(int16_t),
                                  MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_feed_buf == NULL) {
        s_feed_buf = malloc((size_t)feed_samples * feed_ch * sizeof(int16_t));
    }
    if (s_feed_buf == NULL) {
        ESP_LOGE(TAG, "AFE feed 缓冲分配失败");
        s_afe->destroy(s_afe_data);
        s_afe_data = NULL;
        afe_config_free(cfg);
        return;
    }
    s_feed_fill = 0;
    afe_config_free(cfg);

    ESP_LOGI(TAG, "AFE 就绪：%d Hz / %d 声道输入，feed=%d 采样/帧（%d ms），唤醒词=%s",
             feed_rate, feed_ch, feed_samples,
             feed_samples * 1000 / (feed_rate > 0 ? feed_rate : WK_SAMPLE_RATE), wn);

    s_running = true;
    if (xTaskCreate(wake_task, WK_TASK_NAME, WK_TASK_STACK, NULL, WK_TASK_PRIO,
                    NULL) != pdPASS) {
        s_running = false;
        ESP_LOGE(TAG, "唤醒任务创建失败（内部 RAM 不够？需要 %d B）", WK_TASK_STACK);
    }
}
