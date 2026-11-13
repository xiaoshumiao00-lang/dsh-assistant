/**
 * 机身外壳静音触摸区 → 音量手势（0.3.6）。
 *
 * 手势：
 *   单击       静音 / 取消静音（取消时回到静音前的音量；真把 codec 输出写成 0）
 *   双击       恢复默认音量 85
 *   长按       从当前音量开始连续变化：先降到底 0，再 0→100，再 100→0，往返循环；
 *              松手定格在当前音量并存进 NVS（掉电重启还是这个音量）
 *
 * 屏上反馈：顶部浮一条 26 px 的小条「音量 62」/「静音」，2 秒后自动消失。
 */
#pragma once

#include <stdbool.h>

/** 起一条 20 ms 轮询任务接管 GPIO1；app_main 里在 tihu_audio_init() 之后调用。 */
void tihu_volume_start(void);

/** 当前逻辑音量 0–100（静音时返回的是静音前的音量，不是 0）。 */
int tihu_volume_get(void);

/** 现在是否静音（codec 输出已被写成 0）。 */
bool tihu_volume_muted(void);
