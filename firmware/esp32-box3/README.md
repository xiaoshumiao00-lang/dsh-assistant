# 鹈鹕 · ESP32-S3-BOX-3B 固件骨架

给 `127.0.0.1:3081/tihu` 那套模拟设备做一块**同协议的真机**：320×240 触摸屏、24 kHz PCM 播报、16 kHz 麦克风、按住 CONFIG 键说话。宿主侧一行代码都不用改。

> 当前状态：工程结构、CMake、BSP 依赖、协议、三屏 LVGL、字体子集都已落盘；**本机没装 ESP-IDF，尚未实际编译**。到货当天按本文从第 0 步走即可。
>
> 约束：只新增 `firmware/esp32-box3/` 下的文件，没有改 `src/tihu/` 的运行时逻辑，也没有 commit。

---

## 0. 目录

```
firmware/esp32-box3/
├── CMakeLists.txt                  # 顶层工程
├── sdkconfig.defaults              # 16MB flash / octal PSRAM / 4MB app
├── partitions.csv                  # factory 4MB + storage 1MB
├── main/
│   ├── CMakeLists.txt
│   ├── idf_component.yml           # esp-box-3 BSP + esp_websocket_client
│   ├── config.h                    # ★ 唯一要改的文件（SSID/密码/宿主 IP/token）
│   ├── main.c                      # 启动、CONFIG 键按住说话
│   ├── tihu_protocol.h/.c          # 协议 v0：JSON 构造 + 解析（与 protocol.ts 对齐）
│   ├── tihu_net.h/.c               # Wi-Fi + WebSocket + 心跳 + 重连 + 下行分发
│   ├── tihu_audio.h/.c             # 24k 播放 / 16k WAV 录音
│   ├── ui.h / ui.c                 # 三屏容器、tone 色、连接点、告警/在听覆盖层
│   ├── ui_board.c                  # 屏 1：任务棋盘
│   ├── ui_progress.c               # 屏 4：进度
│   ├── ui_done.c                   # 屏 6：完成
│   └── font/                       # 已生成：tihu_font_20.c / tihu_font_15.c / tihu_charset.h
├── tools/
│   ├── gen_font_subset.ps1         # 重新生成字体的入口
│   ├── gen_font_subset.cjs         # 真正读 UTF-8 chars_gb2312.txt 的 Node 脚本
│   ├── gen_charset.py              # GB2312 全码表 + 生僻补充 -> chars_gb2312.txt / tihu_charset.h
│   ├── check_font_chars.cjs        # 离线核对：字符表/屏上文案是否都有字形
│   └── chars_gb2312.txt            # 7470 字：GB2312 全集 + 生僻补充
└── docs/
    └── esp32-box3-bring-up-checklist.md   # 到货当天 10 步验收
```

---

## 1. 协议对齐（与 `src/tihu/protocol.ts` 同一份线格式）

信封固定：

```json
{"v":"0","type":"hello","id":"dev-...","seq":1,"ts":1760000000000,"payload":{}}
```

### 上行（设备 → 宿主）

| type | 何时发 | 关键字段 |
|---|---|---|
| `hello` | WS 连上 | `clientId`（MAC 尾 6 位）、`protocol:"0"`、`capabilities:{screen:true,tts:true,microphone:true,speaker:true}`、`deviceName` |
| `text.input` | 文字兜底（当前未接 UI，函数已留） | `text`、`source` |
| `audio.frame` | 按住 CONFIG 松开 / `voice.listen` 超时 | `format:"wav"`、`sampleRate:16000`、`channels:1`、`bits:16`、`audioBase64`、`durationMs` |
| `screen.gesture` | 点棋盘行 / 完成页三个按钮 | `action:"tap"`、`x`、`y`、`hit`、`actionId`、`taskId` |
| `session.end` | 当前未接 UI（可扩展成长按） | `reason` |
| `device.ack` | 收到 `playback.control` / `voice.listen` / `device.config` / `session.ended` / 带 `opId` 的 `screen.frame` | `opId`、`ok`、`reason`、`stage`、`screenVersion` |
| `playback.state` | 每段开始 / 停 / 暂停 / 继续 / 在听 | `phase`、`segment`、`line`、`total` |
| `ping` | 每 15 秒 | `nonce` |

### 下行（宿主 → 设备）

| type | 固件行为 |
|---|---|
| `screen.frame` | 有 `board` → 棋盘；有 `done` → 完成；否则 → 进度。带 `opId` 时渲染后回 `device.ack` |
| `tts.audio` | base64 解成 PCM，校验 24k/单声道/pcm16，塞播放缓冲 |
| `playback.control` | `stop` 清空并静音、`pause` 静音保留暂停态、`resume` 解除静音、`seek` 停当前声等宿主重发；**都回 ack** |
| `voice.listen` | `on` 开麦并显示「在听」，超时自动上传；`off` 关麦丢弃；回 ack |
| `device.config` | `voice` 回执说明「音色由宿主合成」；`handsfree`/`scale` 如实回 `unsupported`（固件没有本地唤醒词） |
| `session.ended` | 停声、关麦、画空闲屏、回 ack |
| `event.alert` | 屏上红色告警条 5 秒 |
| `pong` | 刷新心跳时间 |
| 其它已知/未知 type | 记一行日志后忽略（协议「字段只增不删、未知忽略」） |

> `device.ack` 的 1.5 秒超时在宿主侧；固件只要收到带 `opId` 的控制就立即回，不要等音频播完。

---

## 2. 从零到跑通

### 2.1 装 ESP-IDF

推荐 **ESP-IDF v5.3.x**（BSP 3.x 的 `idf_component.yml` 要求 `>=5.3`）。v5.2 与 BSP 3.x 不兼容；如果必须用 5.2，需要把 `main/idf_component.yml` 降到 BSP 2.x，并自行处理 LVGL 8/9 差异，本骨架不保证。

Windows PowerShell（管理员不需要，但目录不要有空格/中文）：

```powershell
mkdir C:\esp
cd C:\esp
git clone -b v5.3.2 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
.\install.ps1 esp32s3
```

如果 GitHub 慢，用乐鑫镜像：

```powershell
$env:IDF_GITHUB_ASSETS="dl.espressif.com/github_assets"
.\install.ps1 esp32s3
```

### 2.2 设置 IDF_PATH 并导出环境

每次新开终端都要执行：

```powershell
$env:IDF_PATH = "C:\esp\esp-idf"
. "$env:IDF_PATH\export.ps1"
idf.py --version
```

`export.ps1` 会把 `idf.py`、`esptool.py`、`riscv32-esp-elf-gcc` 等加进 PATH。不要只设 `IDF_PATH` 而不 export，否则 `idf.py` 找不到工具链。

### 2.3 设置目标芯片

```powershell
cd D:\dsh-assistant\firmware\esp32-box3
idf.py set-target esp32s3
```

这一步会生成 `sdkconfig`。`sdkconfig.defaults` 已经写好 16MB flash、八线 PSRAM、4MB app 分区；`set-target` 之后再 `idf.py menuconfig` 检查一遍：

- `Component config → ESP PSRAM → Support for external, SPI-connected RAM` = on
- `SPI RAM config → Mode (QUAD/OCT)` = **Octal**
- `Partition Table → Custom partition table CSV` = on
- `Component config → LVGL` 颜色深度 16（BSP 会带）

### 2.4 改 `main/config.h`

只改这四个常量（其余可选）：

```c
#define TIHU_WIFI_SSID      "你的 2.4G Wi-Fi"
#define TIHU_WIFI_PASSWORD  "Wi-Fi 密码"
#define TIHU_HOST           "192.168.1.23"   // 电脑的局域网 IPv4，不是 127.0.0.1
#define TIHU_TOKEN          "你的局域网 PIN"   // 打开 /tihu 时 URL 里的 ?token=
```

可选：

```c
#define TIHU_MIC_GAIN_DB    36.0f
#define TIHU_SPEAKER_VOLUME 70
```

`TIHU_HOST` 的取法：电脑上 `ipconfig`，看 Wi-Fi 网卡的 IPv4。板子和电脑必须在同一个网段。`TIHU_TOKEN` 在 DSH 的「局域网访问」里查看；如果关闭了局域网访问，手机/板子都连不进来。

### 2.5 编译

```powershell
idf.py build
```

首次 build 会从组件 registry 拉 `espressif/esp-box-3`、`esp_websocket_client` 及其依赖（LVGL、esp_lvgl_port、esp_codec_dev、button 等）。网络不通时先解决代理，或提前把组件放到 `managed_components/`。

产物：

```
build/tihu_box3.bin
build/bootloader/bootloader.bin
build/partition_table/partition-table.bin
```

### 2.6 烧录 + 串口

用一根**能传数据**的 USB-C 线接 BOX-3 的 Type-C 口（不是只能充电的线）。Windows 设备管理器里应出现 `USB JTAG/serial debug unit` 或 `CP210x` 之类的 COM 口。

```powershell
idf.py -p COM5 flash monitor
```

- 烧录波特率可以高（`-b 460800`），**monitor 固定 115200**；
- 退出 monitor：`Ctrl+]`；
- 第一次烧、或改过分区表：先 `idf.py -p COM5 erase-flash`，再 flash；
- 如果 monitor 乱码：确认 `-b 115200`，并检查是不是选到了另一个 COM 口。

### 2.7 首次上电应该看到

1. 背光亮，屏上先出现「连接 / 鹈鹕 BOX-3B / 正在连接 Wi-Fi…」；
2. 串口出现 `Wi-Fi 已获取 IP：192.168.x.x`；
3. 出现 `WebSocket 已连接：ws://.../tihu/lane?token=...`；
4. 宿主 `lane.log` 出现 `tihu hello client=esp32-box3-xxxxxx`；
5. 屏切到棋盘（空态「还没有任务」）；
6. 电脑端 `/tihu` 页面和板子同时在线时，两边都会收到棋盘帧；点板子行/按钮会走同一条 `screen.gesture`。

---

## 3. 字体：不要让它出现方块

`main/font/tihu_font_20.c`、`tihu_font_15.c` 用的是 **GB2312 全字符集**（6763 个汉字 + 682 个区符号/标点/全角字符 + 25 个生僻补充字）+ ASCII 95 字，4bpp PLAIN 位图。完成页正文是宿主任意中文，所以字库按整套标准字符集生成，而不是按固定文案挑字。

- 20px：7565 个字形，位图 1,337,385 B；
- 15px：7565 个字形，位图 760,392 B；
- 两套字库 + 字形描述约 2.12 MiB，app bin 3.85 MB / 8 MB 分区。

出现方块只有两种原因：

1. 字不在 GB2312 里（如「龘靐齉」，已通过 `RARE_SUPPLEMENT` 显式补进 `tools/chars_gb2312.txt`）；
2. 改了字符表但没重新生成 `.c`，或 `.bitmap_format` 不是 0（压缩位图，固件没开解压器）。

重新生成：

```powershell
# 需要 Node.js 18+；默认用 C:\Windows\Fonts\simhei.ttf
# 1) 先按字体真实 cmap 生成字符表（GB2312 全集 + 生僻补充）与自检用码位表
python tools/gen_charset.py
# 2) 再生成两套 LVGL 字库
pwsh -File tools\gen_font_subset.ps1
# 3) 离线核对：字符表、屏上文案是否都命中，bitmap_format 是否为 PLAIN
node tools/check_font_chars.cjs
```

脚本会：

- 读 `tools/chars_gb2312.txt`（UTF-8，`#` 开头是注释，由 `gen_charset.py` 用 Python 的 gb2312 码表生成，不手敲中文）；
- 同时生成 `main/font/tihu_charset.h`（7470 个码位），开机自检随机抽 50 个字验证两套字库都有字形；
- 去重后调 `lv_font_conv` 生成 `main/font/tihu_font_20.c` 和 `tihu_font_15.c`；
- 字号 20px / 15px，4bpp，`no_compress`（`.bitmap_format = 0`），ASCII 0x20–0x7E 自动加入。

> 字号取舍：8 MB app 分区下 4bpp 两套字库约 2.1 MB，bin 3.85 MB、余 4.5 MB，没必要降 2bpp。若以后要上 GBK（2 万字），4bpp 会顶到 4.5 MB 以上，那时应把正文 15px 降 2bpp（中文仍可读），标题 20px 保持 4bpp。
>
> 为什么多了一个 `gen_font_subset.cjs`：Windows 上把中文 `--symbols` 传给 `npx.cmd` 会经过 `cmd.exe`，按 ANSI 代码页重编码，生成的字模和注释都会乱码。PowerShell 只负责启动，Node 脚本自己读 UTF-8 文件，字符不经过命令行。
>
> 字体许可：默认的 SimHei 是 Windows 系统字体，只适合本机自用；要分发固件请换成 **Noto Sans SC / Source Han Sans** 等可再分发字体，并用 `-FontPath` 指过去。

补字流程：把缺的字加到 `tools/chars.txt` 任意一行 → 重跑脚本 → `idf.py build`。不要手改生成的 `.c`，下次生成会被覆盖。

---

## 4. 屏幕与交互

### 屏 1：任务棋盘

- 顶行：`等你 N 在跑 N 排队 N 完成 N`，颜色跟 `tone`（idle 灰 / busy 蓝 / ok 绿 / alert 红 / warn 琥珀）。
- 4 行，每行 46px：左侧状态胶囊（排队中/执行中/待决策/完成）、20px 标题、15px 副行「项目 · 第 N 步」、右侧状态圆点。
- 底部：`第 x/y 页` + 连接状态。
- 点一行发 `screen.gesture{tap, hit:"task", taskId}`。

### 屏 4：进度

- 阶段（进度/派单/待决策/…）、20px 任务标题、最新状态行（思考 · …）、`第 N 步 · 已用 …`、统计行。
- 有 `progress.total` 时画进度条；底部按宿主 `actions` 画「停止 / 主页」。
- 用时不在固件里算：宿主每秒重发这一帧，断线就停在最后一眼，避免本地时钟和宿主对不上。

### 屏 6：完成

- 顶栏 `完成 · 3/12`，20px 任务标题，7 行正文（15px/20px），当前朗读行青底黑字。
- 底部固定三键：**停止 / 重读 / 主页**，点按发 `screen.gesture{tap, hit:"action", actionId, taskId}`。
- 高亮只跟 `done.current` 走，不按时间猜；宿主重发 `done` 帧时窗口会重新对齐。

tone 色值：

| tone | 色值 | 场景 |
|---|---|---|
| `idle` | `#8B93A1` 灰 | 空棋盘/空闲 |
| `busy` | `#4F9FD8` 蓝 | 执行中/派单 |
| `ok` | `#43B581` 绿 | 完成 |
| `alert` | `#E5484D` 红 | 错误/追问 |
| `warn` | `#F5A623` 琥珀 | 待决策 |

---

## 5. 音频链路

- **播放**：`tts.audio` → base64 解码 → 校验 24k/单声道/pcm16 → 64KB StreamBuffer → `audio_task` → `esp_codec_dev_write`。WebSocket 回调不直接写 I2S，避免阻塞。
- **停止**：`playback.control{stop}` 清空 StreamBuffer，音量拉到 0 保持 20ms，再恢复；回 `device.ack`。宿主 1.5 秒等不到回执会显示「设备未回执」。
- **暂停/继续**：段级，不搞采样级。暂停清空当前排队并静音；继续由宿主从当前段重发 PCM，允许本行重念 1–3 秒。
- **录音**：按住 CONFIG（GPIO0）→ 先停声 → `tihu_audio_mic_start` 开 16k/单声道/16bit；松开 → 补 WAV 头 → base64 → `audio.frame`。BOX-3 的 speaker/mic 共用 I2S，**不要一边播报一边录音**；录音结束会重新按 24k 打开扬声器。
- **voice.listen**：宿主强制在听时自动开麦，`timeoutMs` 到点自动停并上传；`off` 则丢弃。没有本地唤醒词，`device.config{handsfree}` 如实回 `unsupported`。

> 采样率不要混：TTS 是 24k，麦克风是 16k。把 16k 数据按 24k 打开播放会变尖/变快；本骨架在 codec open 时就固定了 24k。

---

## 6. 常见坑（按踩坑概率排序）

1. **USB 线只能充电**：电脑完全不出现 COM 口，或设备管理器里是「未知 USB 设备」。换一根带数据线的 USB-C；不要用只有电源的扩展坞。
2. **`127.0.0.1` 在板子上无效**：板子的 `127.0.0.1` 是板子自己。`TIHU_HOST` 必须填电脑的局域网 IPv4。
3. **防火墙拦 3081**：Windows 防火墙放行 DSH/pocket 的 3081 入站；第三方安全软件也要放行。先用手机浏览器打开 `http://<电脑IP>:3081/tihu?token=...` 验证同网段可达。
4. **token 不对/没开局域网访问**：WS 会 401 或直接断开。`TIHU_TOKEN` 必须和 `/tihu` URL 里的 PIN 一致；DSH 设置里打开「局域网访问」。
5. **PSRAM 配置错**：BSP 3.x 要 IDF >=5.3；BOX-3 是 16MB 八线 PSRAM。`CONFIG_SPIRAM_MODE_OCT=y` 没开会在 `bsp_display_start()` 或 LVGL 缓冲分配时崩/重启。`idf.py menuconfig` 检查。
6. **串口 115200**：monitor 默认 115200；如果改了 `CONFIG_ESP_CONSOLE_UART_BAUDRATE`，monitor 也要跟着改。烧录和监视是两件事，`-b` 只影响烧录。
7. **Wi-Fi 只支持 2.4G**：ESP32-S3 不连 5G；SSID/密码里如果有中文/特殊字符，先用简单 ASCII 测试。
8. **WS 单条消息被截断**：`buffer_size=16384`，正常 `tts.audio` 一块约 8KB base64；如果宿主加大块或屏帧变长，调到 32768。`WS_RX_MAX` 也同步。
9. **`hello` 带了 `sessionId`/`auto`**：会走手动逃生口，屏上不是统一棋盘。本骨架发的是**裸 hello**，不要擅自加 `sessionId`。
10. **ack 超时**：`playback.control` 到了但没回 `device.ack`，宿主会报「设备未回执」。检查串口有没有 `不认识的 playback.control action`，以及 `opId` 是否为空。
11. **分区/Flash 大小**：默认 16MB flash + 4MB app。如果拿到的是 8MB 版本，改 `CONFIG_ESPTOOLPY_FLASHSIZE_8MB` 和 `partitions.csv`，否则 `flash` 越界。
12. **改完 `sdkconfig.defaults` 不生效**：已有 `sdkconfig` 时 defaults 只补未设置的项。改分区/PSRAM 后执行 `idf.py fullclean`，或删 `sdkconfig` 再 `set-target`。

---

## 7. 调试入口

- 串口日志 tag：`tihu_main` / `tihu_net` / `tihu_proto` / `tihu_audio` / `tihu_ui`。
- 宿主日志：`~/.dsh/tihu/lane.log`，搜 `tihu hello`、`device ack`、`playback`。
- 模拟页对照：`http://127.0.0.1:3081/tihu?token=...`；真机与模拟页同时在线时，两边会收到同样的 `screen.frame`，可以并排看版式。
- `idf.py size` 看 app 是否接近 4MB；字体占 ~1.6MB，剩余给 LVGL/Wi-Fi/协议。

---

## 8. 到货当天

按 [`docs/esp32-box3-bring-up-checklist.md`](docs/esp32-box3-bring-up-checklist.md) 的 10 步走：官方 demo 验屏/触摸/麦/喇叭 → 连 Wi-Fi → 连宿主 → hello → 棋盘 → 按键说话 → 播报 → 点按钮 → 停止朗读 → 断线重连。每一步都写了「看到什么算过、不过先查哪里」。

---

## 9. 边界

- 不改 `src/tihu/` 的运行时逻辑；本目录只消费它的协议。
- 不引入未声明的第三方库：仅 ESP-IDF 自带的 `esp_websocket_client`、`cJSON`、`mbedtls`、`nvs_flash`，以及 BSP 带入的 `esp_lvgl_port`、`esp_codec_dev`、LVGL。
- 不 push、不 commit；确认清单后再决定是否入库。
