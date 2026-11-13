/**
 * 板载音频：24k PCM 播放 + 16k WAV 录音。
 *
 * 播放走 ES8311（BSP 的 speaker codec），录音走 ES7210（BSP 的 microphone codec）。
 * TTS 下行固定 24 kHz / 单声道 / 16 bit；上行语音固定 16 kHz / 单声道 / 16 bit WAV。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * 开机音频自检（诊断「滋滋」用，默认关）。
 *
 * 定义成 1（编译时 -DTIHU_AUDIO_SELFTEST=1 或直接改这里）：网一连上就播 0.5 秒
 * 1 kHz 正弦，再向宿主发一条 `tts.sample` 让它用**当前配置的音色**念一句示例。
 * 串口里能同时看到 `正弦测试：24k/16bit/mono 已播放`、每块 `tts.audio ... 块长=...`、
 * 欠载计数。验证完改回 0（否则每次开机都会「嘟」一声并念一句）。
 *
 * 刻意放在这里而不是 config.h：config.h 是「上机前唯一要改的地方」，容易被别人
 * 按机器改 Wi-Fi/地址；自检开关属于固件行为，不该混进那份本机配置里。
 */
#ifndef TIHU_AUDIO_SELFTEST
#define TIHU_AUDIO_SELFTEST 0
#endif

/** 音频自检念的示例句（≤60 字；宿主会按「试听」链路合成）。 */
#ifndef TIHU_AUDIO_SELFTEST_TEXT
#define TIHU_AUDIO_SELFTEST_TEXT "音频自检：现在是微软晓晓在说话，声音清楚吗？"
#endif

/** 初始化扬声器、麦克风与播放任务；失败只记日志，不阻塞开机。 */
void tihu_audio_init(void);

/** 塞一块 24k pcm16 到播放缓冲；缓冲满时丢弃并记日志（不阻塞 WebSocket）。 */
void tihu_audio_push_pcm(const uint8_t *pcm, size_t len);

/** 立即停声（清空缓冲、静音 20ms 再恢复音量），用于 stop / 新一帧完成页。 */
void tihu_audio_stop(void);

/** 暂停：停声但保留“暂停”状态；宿主随后会从当前段重发 PCM。 */
void tihu_audio_pause(void);

/** 继续：解除暂停并恢复音量。 */
void tihu_audio_resume(void);

/** 是否还有声音在排队/播放（用于 playback.state 与日志）。 */
bool tihu_audio_busy(void);

/** 设置扬声器音量 0–100。 */
void tihu_audio_set_volume(int volume);

/**
 * 开始录音（16k 单声道）。
 *
 * @returns true = 录音任务已经在跑（或上一次任务仍在跑、本次沿用）；
 *          false = 麦克风没准备好（codec/缓冲/信号量缺一个）或任务创建失败——
 *          调用方（按住 CONFIG 键）据此在屏上显示「麦克风未就绪」并给宿主发告警，
 *          不允许「按下了却什么都不说」。
 */
bool tihu_audio_mic_start(void);

/** 麦克风链路是否可用（codec 句柄 + WAV 缓冲 + 完成信号量都建好了）。 */
bool tihu_audio_mic_ready(void);

/**
 * 停止录音并返回完整 WAV（含 44 字节头）。
 * 返回的缓冲在下一次 mic_start 前有效；len 为 0 表示这次没有录到东西。
 */
const uint8_t *tihu_audio_mic_stop(size_t *len);

/** 是否正在录音。 */
bool tihu_audio_mic_active(void);

/* ---------- 板内唤醒词（ESP-SR）共用麦克风接口（0.6.0） ---------- */

/**
 * 唤醒任务打开 ES7210（16 kHz / 2 声道 / 16 bit）做常驻监听。
 *
 * 与录音共用同一个 s_mic 句柄：**只允许在没在录音时**调用；调用方（tihu_wake.c）
 * 必须先通过 tihu_wake_pause() 让录音收尾。成功后 I2S 处于 16 k RX，
 * 播放 24 k 音频前必须先 tihu_audio_wake_mic_close() 再 speaker_open_24k()。
 */
bool tihu_audio_wake_mic_open(void);

/**
 * 读一帧交织的 2 声道 PCM（字节数给偶数，通常是 30 ms = 1920 B）。
 * @returns 读到的 int16 采样数；<0 表示失败或唤醒麦克风没开。
 */
int tihu_audio_wake_mic_read(int16_t *interleaved, size_t bytes);

/** 关闭唤醒麦克风并把 I2S 恢复成 24 kHz（供叮/TTS 使用）。 */
void tihu_audio_wake_mic_close(void);

/** 唤醒麦克风当前是否打开（audio_task 据此决定播放前要不要切回 24 k）。 */
bool tihu_audio_wake_mic_is_open(void);

/**
 * 播一声 120 ms 的「叮」（1.5 kHz / 24 kHz / 16 bit / mono），唤醒命中用。
 * 非阻塞：内部起一次性任务，走与 TTS 完全相同的播放链路。
 */
void tihu_audio_play_ding(void);

/**
 * 播 0.5 秒 1 kHz 正弦（24 kHz / 16 bit / 单声道），走与真实 TTS 完全相同的播放链路。
 * 用来区分「通路坏了」还是「网络/分块坏了」：听到干净的一声「嘟」= I2S/codec 正常。
 * 非阻塞：内部起一次性任务，播完打一行 `正弦测试：24k/16bit/mono 已播放`。
 */
void tihu_audio_play_sine_test(void);

/** 播放统计（诊断用）：收到的块数 / 奇数块数 / 欠载次数。传 NULL 的项忽略。 */
void tihu_audio_stats(uint32_t *chunks, uint32_t *odd_chunks, uint32_t *underruns);

/** 清零播放统计（一次新的朗读开始时调；stop() 内部也会调）。 */
void tihu_audio_reset_stats(void);

/**
 * 记一行字幕的起始位置（在 tihu_audio_push_pcm 之前调）。
 *
 * index 来自宿主 tts.audio.index（完成页＝屏上第几行）。偏移按「播放坐标系」记：
 * 已送 I2S 字节 + 还排在播放缓冲里的字节，正好是这一块将要出现在时间轴上的位置。
 * karaoke 高亮用 {@link tihu_audio_current_line} 查表，不再用比例硬换算行号
 * （比例会被宿主预送/播放缓冲/丢块带偏）。
 */
void tihu_audio_note_line(int index);

/** 「已送 I2S 的字节」落在第几行（宿主行号）；本段还没收到行信息时返回 -1。 */
int tihu_audio_current_line(void);

/** 播放是否已排空（written≥pushed）：用来判断「这是新一段朗读的第一块」。 */
bool tihu_audio_progress_idle(void);

/**
 * 宿主下发本轮最后一个 tts.audio 块（final）时调一次。
 * 播放统计汇总只在 final 之后、缓冲真正排空时打一条，避免行间合成空档被误判成「读完了」。
 */
void tihu_audio_mark_final(void);

/**
 * 本轮朗读的播放进度（karaoke 高亮用）：pushed = 收到的 tts.audio 总字节，
 * written = 已真正送进 I2S 的字节。比例只作日志/兜底，行号用 current_line()。
 * @returns true = 两边都有数据（可以算比例）；传 NULL 的项忽略。
 */
bool tihu_audio_playback_progress(uint32_t *pushed, uint32_t *written);

/** 开机麦克风地址探测结果（给 /tihu/diag 用）。 */
bool tihu_audio_mic_probe_text(char *out, size_t cap);

/** 麦克风句柄来自哪里（custom-XX / bsp / none）。 */
bool tihu_audio_mic_source_text(char *out, size_t cap);

/** 读 ES7210 关键寄存器，拼成一行文本（给 /tihu/diag 用）。 */
bool tihu_audio_mic_regs_text(char *out, size_t cap);
