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

/** 开始录音（16k 单声道）。重复调用会被忽略。 */
void tihu_audio_mic_start(void);

/**
 * 停止录音并返回完整 WAV（含 44 字节头）。
 * 返回的缓冲在下一次 mic_start 前有效；len 为 0 表示这次没有录到东西。
 */
const uint8_t *tihu_audio_mic_stop(size_t *len);

/** 是否正在录音。 */
bool tihu_audio_mic_active(void);

/**
 * 播 0.5 秒 1 kHz 正弦（24 kHz / 16 bit / 单声道），走与真实 TTS 完全相同的播放链路。
 * 用来区分「通路坏了」还是「网络/分块坏了」：听到干净的一声「嘟」= I2S/codec 正常。
 * 非阻塞：内部起一次性任务，播完打一行 `正弦测试：24k/16bit/mono 已播放`。
 */
void tihu_audio_play_sine_test(void);

/** 播放统计（诊断用）：收到的块数 / 奇数块数 / 欠载次数。传 NULL 的项忽略。 */
void tihu_audio_stats(uint32_t *chunks, uint32_t *odd_chunks, uint32_t *underruns);

/** 清零播放统计（每次 final 块/重新开始朗读时调）。 */
void tihu_audio_reset_stats(void);
