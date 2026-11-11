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
