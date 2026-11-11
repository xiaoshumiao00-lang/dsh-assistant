# ESP32-S3-BOX-3B 到货当天 · 10 步上机清单

> 目标：从「全新开箱」到「鹈鹕宿主上能推棋盘、能按键说话、能播报、能点按钮、能停止朗读、断线能自己回来」。
>
> 前置：电脑和板子在同一 Wi-Fi；DSH 的局域网访问已打开；`main/config.h` 四处已填好；`idf.py build` 已成功。
>
> 每一步都按「做什么 → 看到什么算过 → 不过先查哪里」写。**不要跳步**：第 1 步不过，后面的音频/触摸问题会混在一起。

---

## 1. 官方 demo：屏、触摸、麦克风、喇叭

**做什么**

- 不烧本固件，先用出厂 demo（或 esp-bsp 的 `box3_demo`）上电。
- 看屏是否正常亮、颜色是否偏；点屏幕四周和中间；对麦克风说话看波形/识别；放一段 demo 音。

**看到什么算过**

- 320×240 全屏无花屏/无偏移；触摸点按位置和手指一致（不是旋转 90°/镜像）。
- 麦克风说话有反应；喇叭能出声，音量旋钮/按键有效。

**不过先查哪里**

- 屏不亮：USB 供电/数据线、背光排线、BSP 板型是否 `esp-box-3`。
- 触摸错位：BSP 的触摸型号（GT911/TT21100）与屏幕批次；不要自己写触摸驱动。
- 麦克风/喇叭无声：`bsp_audio_codec_speaker_init()` / `microphone_init()` 返回值；ES8311/ES7210 是否被 BSP 正确识别；喇叭是否插到底。

---

## 2. 连 Wi-Fi

**做什么**

- 烧本固件：`idf.py -p COMx flash monitor`。
- 看串口和屏。

**看到什么算过**

- 串口出现 `Wi-Fi 已获取 IP：192.168.x.x`。
- 屏从「正在连接 Wi-Fi…」切到「连宿主」或直接进棋盘。
- 电脑上 `ping 192.168.x.x` 通。

**不过先查哪里**

- `Wi-Fi 已获取 IP` 不出现：SSID/密码（2.4G、ASCII 先试）、`TIHU_WIFI_SSID` 是否被截断、路由器是否开了 AP 隔离/ MAC 过滤。
- 一直重启：PSRAM 配置（第 6 个坑）或供电不足；先 `idf.py erase-flash` 再烧。
- 有 IP 但 ping 不通：电脑和板子不在同一网段；Windows 防火墙/路由器客户端隔离。

---

## 3. 连宿主（WebSocket）

**做什么**

- 保持 monitor，观察串口；同时看电脑 `~/.dsh/tihu/lane.log`（或 DSH 日志）。
- 用手机/电脑浏览器打开 `http://<电脑IP>:3081/tihu?token=<PIN>`，确认宿主本身在线。

**看到什么算过**

- 串口：`WebSocket 已连接：ws://<host>:3081/tihu/lane?token=...`。
- 宿主日志：`tihu hello client=esp32-box3-xxxxxx`。
- 屏顶/底部连接点变绿（或显示「已连接」）。

**不过先查哪里**

- 一直 `WebSocket 断开，等待自动重连`：`TIHU_HOST` 是不是 `127.0.0.1`；3081 防火墙；token 是否和 `/tihu` 的 PIN 一致（错了会 401）。
- 连上就断：WS `buffer_size` 太小或宿主返回了超过 32KB 的单条消息；看串口 `下行消息超过 ... 丢弃`。
- 浏览器能开 `/tihu` 但板子连不上：浏览器可能走了公网/代理；板子走的是局域网直连，必须同网段 + 3081 入站放行。

---

## 4. hello 成功（绑定指挥台）

**做什么**

- 看宿主日志里 hello 之后的 `session.bound` / `event.progress`。
- 看屏是否从「连接中」切到棋盘。

**看到什么算过**

- 宿主回 `session.bound`（`title` 是「鹈鹕指挥台」之类），并下发第一帧 `screen.frame{board:...}`。
- 串口没有 `协议版本不匹配`。
- 屏进入棋盘（可以是空态「还没有任务」）。

**不过先查哪里**

- 屏停在「鹈鹕指挥台不可用，请重启」：宿主侧指挥会话建不出来；重启 DSH/口袋宿主，或看 `lane.log` 的 `unified mode unavailable`。
- 屏停在旧项目卡片：hello 可能带了 `sessionId`/`auto`；本固件是裸 hello，检查是否被别的代码改过。
- `协议版本不匹配`：`TIHU_PROTOCOL_VERSION` 被改过；宿主只认 `"0"`。

---

## 5. 棋盘推送

**做什么**

- 在电脑端 `/tihu` 或指挥台派一条任务（或让已有任务出现在棋盘）。
- 看板子 4 行、顶行计数、底部页码。

**看到什么算过**

- 4 行以内任务按宿主顺序出现：状态胶囊 + 标题 + 副行（项目 · 第 N 步）。
- 顶行四段计数和宿主 `/tihu` 页面一致；底部 `第 x/y 页`。
- 有在跑任务时右侧圆点蓝色，完成绿色，待决策琥珀。

**不过先查哪里**

- 行数不对/空白：`screen.frame` 的 `board.rows` 是否被解析（串口 log 没有解析错误）；`TIHU_MAX_BOARD_ROWS` 是否被改小。
- 中文方块：`chars.txt` 缺字；补字后重跑 `tools/gen_font_subset.ps1`。
- 计数对不上：宿主 `/tihu` 和板子收到的不是同一帧（一个连了公网、一个连了局域网）；确认两边都连同一个宿主。

---

## 6. 按键说话

**做什么**

- 按住 BOX-3 顶部 CONFIG 键（GPIO0），说一句「你好，鹈鹕」，松开。
- 看屏上「正在听 · 松开上传」、串口、宿主转写。

**看到什么算过**

- 按下出现「在听」覆盖层；松开后串口出现 `录音结束：... 字节`。
- 宿主收到 `audio.frame` 并转写；`/tihu` 页出现转写文本/任务回执。
- 录音时长和按住时间大致一致（不是 0 字节、不是固定 1 秒）。

**不过先查哪里**

- 0 字节：麦克风 codec 没初始化（`tihu_audio` 日志）、CONFIG 键没注册（`没有找到 CONFIG 键`）、按住时间太短。
- 声音很小/爆音：`TIHU_MIC_GAIN_DB` 调到 30–42 之间试；ES7210 增益不是越大越好。
- 一直「在听」不结束：`voice.listen` 的 timeout 或按键松开事件没到；先松手再按一次。
- 上传后宿主说音频格式错：必须是 16k/单声道/16bit WAV；不要改 `audio.frame` 的 `sampleRate`。

---

## 7. 播报（24k PCM）

**做什么**

- 让宿主回一句话（或在 `/tihu` 点试听），板子应出声。
- 看屏上完成页/播报状态。

**看到什么算过**

- 喇叭出声，语速正常（不是尖/慢），首块 1–2 秒内开始。
- 串口没有 `tts.audio 需要 24k 单声道` / base64 解码失败。
- 屏上完成页正文高亮随声音走（宿主发 `done.current` 时）。

**不过先查哪里**

- 完全无声：`bsp_audio_codec_speaker_init()` 返回 NULL、音量 0、`esp_codec_dev_open(24k)` 失败；看 `tihu_audio` 日志。
- 声音尖/快：PCM 被当成 16k 播；确认 `tts.audio` 是 24k，且 speaker 以 24k 打开。
- 断断续续：WS 缓冲/播放缓冲被填满（`播放缓冲满`）；把 `buffer_size` 和 `AUDIO_STREAM_BYTES` 调大。
- 首块很慢：宿主 TTS 本身慢；与本固件无关，先看宿主 `lane.log` 的合成耗时。

---

## 8. 点按钮（screen.gesture）

**做什么**

- 在完成页点「停止 / 重读 / 主页」；在棋盘点一行。
- 看串口和宿主日志。

**看到什么算过**

- 串口 `screen.gesture` 发出；宿主按 `actionId` 执行（停止/重读/回棋盘/打开任务）。
- 完成页「主页」后屏回棋盘；「重读」后宿主重发完成帧和 PCM。
- 宿主 `device.ack` 能结算（如果该动作带 `opId`）。

**不过先查哪里**

- 点了没反应：按钮坐标是否在屏内、`hit` 是否是 `"action"`、`actionId` 是否是宿主认识的 `stop/replay/taskBoard`；看串口是否真的发出了。
- 点行没反应：`hit` 是 `"task"` 且 `taskId` 非空；空 `taskId` 会被固件忽略。
- 坐标错位：屏幕旋转/触摸校准；先回第 1 步。

---

## 9. 停止朗读

**做什么**

- 播报中，在电脑端让 agent 调「停止朗读」，或点完成页「停止」。

**看到什么算过**

- 声音在 1 秒内停（不是把已缓冲的 1–2 句念完）。
- 宿主日志出现 `playback.control` + `device.ack`，工具返回「已停止」而不是「设备未回执」。
- 屏不跳走（停声不换屏），或按「主页」才回棋盘。

**不过先查哪里**

- 还在念：固件没收到 `playback.control`，或 `opId` 为空导致没回 ack；看串口 `不认识的 playback.control action`。
- 宿主报「设备未回执」：ack 没发出去/WS 断了；`device.ack` 必须在渲染/停声后立即发，不要等音频结束。
- 点「停止」按钮无效：`actionId` 必须是 `"stop"`（不是 `"taskStop"`；进度页才是 `taskStop`）。

---

## 10. 断线重连

**做什么**

- 播报/棋盘状态下，拔掉路由器 Wi-Fi 或给板子断电 10 秒再上电；也可以关掉 DSH 的局域网访问再打开。
- 观察串口、屏、宿主日志。

**看到什么算过**

- 串口：`WebSocket 断开，等待自动重连` → `Wi-Fi 已获取 IP` → `WebSocket 已连接` → 重新 `hello`。
- 宿主重新收到裸 hello，并重新下发棋盘；屏回到棋盘（不是卡在上一帧完成页）。
- 重连后点按钮/按键说话仍然有效；`playback.state` 先报 idle，宿主不再以为还在朗读。

**不过先查哪里**

- 不重连：Wi-Fi 重试定时器是否在跑（`TIHU_WIFI_RETRY_MS`）；WS 的 `reconnect_timeout_ms`；host 是否变了 IP。
- 重连后屏停在旧完成页：`hello` 后宿主应发新棋盘；如果没发，看 `lane.log` 的 `sendBoard`。固件本身不缓存旧屏（重启后是全新状态）。
- 重连后宿主说「设备未回执」：`s_connected` 还没置位就发了控制；等 `WEBSOCKET_EVENT_CONNECTED` 后的 hello 完成再操作。
- 反复重连：token 过期/防火墙；或两台上游抢同一个 clientId（MAC 尾号相同），改 `TIHU_DEVICE_NAME`/clientId 规则。

---

## 附：一口气跑完的最短路径

```powershell
$env:IDF_PATH = "C:\esp\esp-idf"
. "$env:IDF_PATH\export.ps1"
cd D:\dsh-assistant\firmware\esp32-box3
idf.py set-target esp32s3
# 改 main/config.h 四处
idf.py build
idf.py -p COM5 flash monitor
```

通过标准：第 10 步结束后，板子断电再上电，30 秒内自己回到棋盘；按住 CONFIG 说一句话，电脑端 `/tihu` 能看到任务回执；让 agent 说「停止朗读」，板子 1 秒内安静且工具返回「已停止」。

---

## 附：最容易卡住的 3 个点（提前打预防针）

1. **`TIHU_HOST` 写成 `127.0.0.1`**：板子会连自己，永远连不上宿主；必须是电脑局域网 IP，且 3081 入站放行。
2. **BSP 3.x 与 ESP-IDF 5.2 不兼容**：`idf_component.yml` 要求 `>=5.3`；要么升 5.3，要么降 BSP 并处理 LVGL 8/9 差异。不要在 5.2 上硬编。
3. **中文 `--symbols` 经过 `npx.cmd` 会乱码**：字模会生成错字/方块；必须用本目录的 `gen_font_subset.ps1`（内部走 Node 读 UTF-8 `chars.txt`），不要手敲 `npx lv_font_conv --symbols 中文...`。
