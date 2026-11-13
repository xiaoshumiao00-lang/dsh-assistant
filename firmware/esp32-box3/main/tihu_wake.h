/**
 * 板内语音唤醒：ESP-SR WakeNet9 中文唤醒词「嗨，乐鑫」（wn9_hilexin）。
 *
 * 与 0.5.0 的「录 1.8 s → 发给宿主 /tihu/wake 判」完全不同：模型、AFE、推理全部在
 * 板子上跑，不联网也能唤醒。模型包（main/models/srmodels.bin）用 target_add_binary_data
 * 打进 **app 分区**，开机由 srmodel_load() 从内嵌段载入，不依赖独立的 model 分区，
 * 所以一次 OTA 就能把唤醒词模型和固件一起升级。
 *
 * 用法（main.c）：
 *   tihu_wake_start(voice_command_record);   // tihu_net_start() 之后
 * 命中后先「叮」一声，再调回调（回调里做屏上提示 + 录 5 s + 上传）。
 */
#pragma once

#include <stdbool.h>

/** 唤醒命中后的回调（在唤醒任务里执行，栈 8 KB，可阻塞几秒）。 */
typedef void (*tihu_wake_cb_t)(void);

/**
 * 启动常驻唤醒任务（只启动一次；重复调用直接返回）。
 *
 * @param on_wake 命中回调；NULL 表示只叮一声不做事（调试用）。
 */
void tihu_wake_start(void (*on_wake)(void));

/**
 * 让出麦克风：置暂停并等唤醒任务关掉 ES7210/I2S RX（最多 1 s）。
 *
 * 录音（tihu_audio_mic_start）和播放（audio_task 第一次写 I2S）前必须调用：
 * BOX-3 的 mic/speaker 共用一条 I2S，16 k RX 与 24 k TX 不能同时存在。
 *
 * @returns true = 麦克风已空闲，可以安全打开；false = 超时（唤醒任务仍占着）。
 */
bool tihu_wake_pause(void);

/** 解除暂停（录音结束 / 播放排空后调用），唤醒任务会重新开麦。 */
void tihu_wake_resume(void);

/** 唤醒任务是否已经跑起来（AFE 建好、模型载入成功）。 */
bool tihu_wake_running(void);
