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
void tihu_net_send_tap(int x, int y, const char *hit,
                       const char *action_id, const char *task_id);
void tihu_net_send_session_end(const char *reason);
void tihu_net_send_ack(const char *op_id, bool ok, const char *reason,
                       const char *stage, int screen_version);
void tihu_net_send_playback_state(const char *phase, const char *task_id,
                                  int segment, int line, int total, int char_start);

/** 按键说话开始时调用：取消 voice.listen 的自动收尾定时器，避免抢走这次录音。 */
void tihu_net_cancel_listen(void);
