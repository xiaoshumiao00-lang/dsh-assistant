/**
 * Wi-Fi + WebSocket 客户端。
 *
 * 连接地址与模拟页完全一致：
 *   ws://<host>:3081/tihu/lane?token=<LAN PIN>
 * 连上后先发裸 hello（不带 sessionId / auto），宿主会把它绑到唯一的鹈鹕指挥台，
 * 随后主动推棋盘帧。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void tihu_net_start(void);
bool tihu_net_connected(void);

void tihu_net_send_text(const char *text, const char *source);
void tihu_net_send_wav(const uint8_t *wav, size_t len);
/**
 * 设备侧自证告警（0.3.9 诊断旁路）：向宿主发 `event.alert{level,text}`。
 *
 * 只为了「让宿主日志里出现一行」——按键按下/松开、麦克风未就绪都发一条，
 * 宿主没连上时只打串口日志。发送超时只有 300 ms（调用方可能是 esp_timer
 * 任务里的按键回调，不能长占），失败/未连接都不影响录音与上传。
 * @returns true = 真的写进了 WebSocket。
 */
bool tihu_net_send_alert(const char *level, const char *text);
/** 发 screen.gesture{tap}；返回是否真的写进了 WebSocket（失败会在串口打日志）。 */
bool tihu_net_send_tap(int x, int y, const char *hit,
                       const char *action_id, const char *task_id);
/**
 * 开机自检窗口：打开后，这期间收到的每一条下行（tts.audio 除外）都往串口写一行
 * `自检回执 type=...`，用来证明设备发的 screen.gesture 宿主真的收到了并回了包。
 */
void tihu_net_watch_selftest(bool on);
void tihu_net_send_session_end(const char *reason);
void tihu_net_send_ack(const char *op_id, bool ok, const char *reason,
                       const char *stage, int screen_version);
void tihu_net_send_playback_state(const char *phase, const char *task_id,
                                  int segment, int line, int total, int char_start);

/** 按键说话开始时调用：取消 voice.listen 的自动收尾定时器，避免抢走这次录音。 */
void tihu_net_cancel_listen(void);
