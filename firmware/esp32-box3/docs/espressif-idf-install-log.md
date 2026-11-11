# ESP-IDF v5.3 安装与使用记录（ESP32-S3-BOX-3B）

> 安装日期：2026-11-11 12:18–12:45（本机 Windows 11，Git 2.53.0，系统 Python 3.14.3）
> 目的：为 `D:\dsh-assistant\firmware\esp32-box3`（鹈鹕 BOX-3B 固件）提供可编译环境。

## 1. 一句话结论

| 项目 | 值 |
| --- | --- |
| ESP-IDF 路径 | `D:\esp\esp-idf`（tag `v5.3`，commit `e0991fac`） |
| 版本号 | `ESP-IDF v5.3`（`idf.py --version` 原文） |
| 工具链路径 | `C:\Users\Administrator\.espressif\tools\xtensa-esp-elf\esp-13.2.0_20240530\xtensa-esp-elf\bin` |
| 编译器版本 | `xtensa-esp-elf-gcc.exe (crosstool-NG esp-13.2.0_20240530) 13.2.0` |
| Python 环境 | `C:\Users\Administrator\.espressif\python_env\idf5.3_py3.14_env`（Python 3.14.3） |
| 环境入口（双击） | `C:\Users\Administrator\.dsh\assistant\idf-env.cmd`（桌面另有一份 `D:\陈潘HBEU\Desktop\idf-env.cmd`） |
| 占用空间 | `.espressif` ≈ 3.04 GB，`esp-idf` ≈ 0.48 GB（D 盘装完剩 119.9 GB） |

## 2. 验证输出（原文）

```
===IDF_VERSION===
ESP-IDF v5.3

===GCC32S3===
xtensa-esp-elf-gcc.exe (crosstool-NG esp-13.2.0_20240530) 13.2.0
Copyright (C) 2023 Free Software Foundation, Inc.
This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

===PY===
C:\Users\Administrator\.espressif\python_env\idf5.3_py3.14_env\Scripts\python.exe 3.14.3 ...
```

端到端验证：用 `D:\esp\esp-idf\examples\get-started\hello_world` 复制到 `D:\esp\hello-check`，
`idf.py set-target esp32s3 && idf.py build` 全链路通过，生成 207 KB 的 `hello_world.bin`
（日志 `D:\esp\hello-build.log`）。说明编译、链接、镜像生成、分区检查都没问题。

## 3. 怎么进环境

三种方式，任选：

1. **双击** `idf-env.cmd`（`.dsh\assistant` 或桌面）→ 自动 `export.bat` + `cd` 到工程目录，窗口停在那里。
2. 已有命令行窗口里：
   ```bat
   D:\esp\esp-idf\export.bat
   cd /d D:\dsh-assistant\firmware\esp32-box3
   ```
3. PowerShell 里（注意用 `.bat` 而不是 `.ps1`，避免执行策略拦截）：
   ```powershell
   cmd /c "D:\esp\esp-idf\export.bat && cd /d D:\dsh-assistant\firmware\esp32-box3 && cmd"
   ```

每次 `export.bat` 会打印 PATH 列表和 “Done! You can now compile ESP-IDF projects.”，看到这行即环境正常。

## 4. 日常命令（本工程）

```bat
idf.py set-target esp32s3          :: 只在首次/删 sdkconfig 后跑一次；本工程 sdkconfig.defaults 已写死 esp32s3
idf.py build                       :: 编译，产物在 build\tihu_box3.bin
idf.py -p COM5 flash               :: 烧录（把 COM5 换成设备管理器里的实际串口）
idf.py -p COM5 monitor             :: 看串口（Ctrl+] 退出）
idf.py -p COM5 flash monitor       :: 烧完直接进串口
idf.py menuconfig                  :: 图形配置
idf.py fullclean                   :: 彻底清 build（改 sdkconfig/换 target 后用）
```

- BOX-3B 板载 USB-C 直连即可烧录（ESP32-S3 内置 USB-Serial-JTAG），不一定要 USB-UART 小板；
  插上后在设备管理器看是 `USB 串行设备 (COMx)`。
- 板子是 N16R8 级别：16 MB Flash + 8/16 MB Octal PSRAM，`sdkconfig.defaults` 里已配好
  `CONFIG_ESPTOOLPY_FLASHSIZE_16MB` / `CONFIG_SPIRAM_MODE_OCT`。
- 首次 build 会通过组件管理器联网拉 `espressif/esp-box-3`、`lvgl` 等依赖到工程下的
  `managed_components\`，约几十 MB；之后离线可编（除非改了 `idf_component.yml`）。

## 5. 安装过程与踩过的坑（都带原文）

### 5.1 GitHub git 协议被重置 → 用 gitee 镜像（用户已授权）

```
fatal: unable to access 'https://github.com/espressif/esp-idf-monitor.git/': Recv failure: Connection was reset
```
`git clone https://github.com/espressif/esp-idf.git` 在拿到 refs 后 0 字节卡死（无 TCP 连接）。
实测 `codeload.github.com` 正常（约 8 MB/s），**只有 git 协议被墙/重置**。

改用镜像（等价官方源）：
```bat
git clone --depth 1 -b v5.3 --recursive https://gitee.com/EspressifSystems/esp-idf.git D:\esp\esp-idf
```
主仓库 70 MB 左右，1 分钟下完。

### 5.2 gitee 大仓库 submodule 会卡死 → 用 codeload tarball 补齐

`git submodule update --init --recursive` 前面几个（小仓库）正常，到 `esp32-bt-lib` 这种大仓库时
**完全不动、无 TCP 连接**（1 MB/s 起步然后停死，5 分钟 0 字节）。
对策：按 `.gitmodules` 里的 SHA，从 `codeload.github.com` 下 tarball 展开到对应目录（23 个 submodule
全部拉全，共约 165 MB，脚本 `D:\esp\fetch-submodules.ps1`，日志 `D:\esp\submodule-fetch.log`）。

### 5.3 submodule 是快照、没有 .git → CMake 会尝试 init 并 fatal

```
fatal: remote error: upload-pack: not our ref 24c60e2...
CMake Error at D:/esp/esp-idf/tools/cmake/git_submodules.cmake:48 (message):
  Git submodule init failed for components/bootloader/subproject/components/micro-ecc/micro-ecc
```
`git_submodules.cmake` 只在 `git submodule status` 输出前缀为 `-`（未初始化）时才去 init。
对策（`D:\esp\submodule-gitinit.ps1`）：
1. 每个 submodule 目录里 `git init` + 提交一次本地快照，status 变成 `+`（已初始化、commit 不同）；
2. 再对 23 个 submodule 设 `submodule.<name>.ignore = all`，让 `git describe --dirty` 不再把
   它们算成改动 —— 否则 `idf.py --version` 会打印 `ESP-IDF v5.3-dirty`。

> 副作用：`git -C D:\esp\esp-idf status` 里这些 submodule 显示为 “已初始化但 commit 不同”。
> **不要**再跑 `git submodule update --init --recursive`，会把这份快照覆盖掉（而且大概率还是卡死）。

### 5.4 系统 PATH 里的 CMake 4.x 会被 IDF 拒绝

```
Not using an unsupported version of tool cmake found in PATH: 4.4.4.
```
`C:\Python314\Scripts\cmake.exe` 是 4.4.4，ESP-IDF v5.3 只接受 3.x。`export.bat` 会把自带的
`tools\cmake\3.24.0\bin` 排到前面，所以正常情况无碍；**别手动把 CMake 4.x 放到 PATH 最前**。
（`where cmake` 会同时列出两个，第一个是 IDF 的 3.24.0 就对了。）

### 5.5 Python 3.14 能跑，但属于“超纲”

本机只有 Python 3.14.3，ESP-IDF v5.3 官方支持 3.8–3.12。实测 `install.bat` 建 venv、
装 requirements、编译全部正常（`idf5.3_py3.14_env`）。若日后遇到 pip 装包/组件管理器报奇怪的
`SyntaxError`/缺 wheel，最省事的治法是把 Python 3.12 装上并用它重建环境：
```bat
py -3.12 -m venv %USERPROFILE%\.espressif\python_env\idf5.3_py3.12_env
```
（本次不需要。）

### 5.6 用国内镜像下工具链

```bat
set IDF_GITHUB_ASSETS=dl.espressif.cn/github_assets
D:\esp\esp-idf\install.bat esp32s3
```
`dl.espressif.cn` 很快（3.1 GB 工具约 90 秒下完，日志 `D:\esp\install.log`）。
不加这个变量会去 `github.com/espressif/crosstool-NG/releases/...` 下，大概率超时。

## 6. 本工程当前的编译状态（2026-11-11 12:45）

用这套环境编 `esp32-box3`：CMake 配置通过、BSP/LVGL/组件全部拉下来并编译了 1900+ 个目标文件，
**剩余报错都在工程源码/依赖版本，不在工具链**：

1. `main.c:21 / ui.c:14` — `fatal error: esp-box-3.h: No such file or directory`
   BSP 3.x 的头在 `managed_components\espressif__esp-box-3\include\bsp\esp-box-3.h`，
   应写 `#include "bsp/esp-box-3.h"`。
2. `ui_board.c:148 / ui_done.c:124 / ui_progress.c:132` —
   `error: implicit declaration of function 'tihu_ui_connection_text' [-Werror=implicit-function-declaration]`
   头文件里缺声明（`ui.h` 里补一行 `const char *tihu_ui_connection_text(void);`）。
3. `ui_done.c:164 / ui_progress.c:170` —
   `error: '%s' directive output may be truncated writing up to 31 bytes into a region of size 24`
   `s_action_ids[i]` 只有 24 字节，`frame->actions[i].id` 最长 31 字节 → 缓冲改 40，
   或 `snprintf(..., "%.23s", ...)`。
4. 依赖版本：`managed_components\espressif__i2c_bus\i2c_bus_v2.c:104` —
   `error: implicit declaration of function 'i2c_master_get_bus_handle'`
   BSP 3.1.0 的 manifest 允许 `i2c_bus ^1.x`，组件管理器解析到了 1.5.2，而该版本调用的
   `i2c_master_get_bus_handle` 是 IDF 5.4+ 才有的 API。在 `main/idf_component.yml` 里钉住旧版即可：
   ```yaml
   dependencies:
     espressif/i2c_bus: "~1.4.0"
   ```
   然后 `idf.py fullclean && idf.py build` 重新解析。

（这四条属于固件代码本身，本次安装任务未改动这些源文件。）

## 7. 维护提示

- 查看 IDF 状态：`git -C D:\esp\esp-idf describe --tags` → 应为 `v5.3`。
- 想换 IDF 版本：另建 `D:\esp\esp-idf-5.4`，不要就地 `git checkout`（submodule 快照会错位）。
- 卸载：删 `D:\esp\esp-idf` + `C:\Users\Administrator\.espressif`（后者可用
  `D:\esp\esp-idf\idf_tools.py uninstall` 精细卸载）。
- 相关日志：`D:\esp\install.log`（工具链安装）、`D:\esp\submodule-fetch.log`、
  `D:\esp\hello-build.log`、`D:\esp\build-test.log`（本工程编译）、`D:\esp\verify.txt`。

## 8. 首编修错记录（2026-11-11 12:45–12:52，已编过）

**结果**：`idf.py build` 成功，`build\tihu_box3.bin` = **1,684,608 字节（0x19b480，约 1.61 MB）**，
app 分区 8 MB 用掉 20%，剩 80%。日志 `D:\esp\build-box3-3.log`（全量，0 处 error/FAILED）。

### 8.1 改动清单（6 处，含 1 处你未列但必须改的）

| # | 文件 | 改动 | 原因 |
| --- | --- | --- | --- |
| 1 | `main/main.c`、`main/ui.c`、`main/tihu_audio.c` | `#include "esp-box-3.h"` → `#include "bsp/esp-box-3.h"` | BSP 3.x 头文件在 `include/bsp/` 下 |
| 2 | `main/ui.h` | 补 `const char *tihu_ui_connection_text(void);` 和 `bool tihu_ui_connected(void);` | 两者在 `ui.c` 里已有定义，只是没进头文件，三屏 UI 都在调 |
| 3 | `main/ui_done.c` | `s_action_ids[3][24]` → `[3][40]`；3 处 `snprintf` 改成 `"%.39s"` | action id 是 `char[32]`，24 字节缓冲放不下，触发 `-Werror=format-truncation` |
| 4 | `main/ui_progress.c` | `s_action_ids[2][24]` → `[2][40]`；1 处 `snprintf` 改成 `"%.39s"` | 同上 |
| 5 | `main/idf_component.yml` | 增加 `espressif/i2c_bus: "~1.4.0"` | 防解析到 1.5.2（1.5.2 用了 IDF 5.4 的 API）——**但仍需第 6 条**，见下 |
| 6 | `sdkconfig.defaults` | 增加 `CONFIG_I2C_BUS_BACKWARD_CONFIG=y` | 见 8.3：光钉版本不够，1.4.2 在 IDF≥5.3 也走 v2 文件 |

配置侧（对应需求第 5 条，已按 BOX-3B 落实并验证进 `sdkconfig`）：

```ini
CONFIG_IDF_TARGET="esp32s3"                 # esp32s3
CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y           # 16 MB flash
CONFIG_ESPTOOLPY_FLASHMODE_DIO=y            # 见 8.4，QIO 与八线 PSRAM 冲突
CONFIG_ESPTOOLPY_FLASHFREQ_80M=y
CONFIG_SPIRAM=y / MODE_OCT=y / SPEED_80M=y  # 八线(Octal) PSRAM 80 MHz
CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240=y
CONFIG_LV_COLOR_DEPTH_16=y
```

`partitions.csv`：`factory` 由 4 MB 扩到 **8 MB**（0x10000 起），`storage`(spiffs) 由 1 MB 扩到 **2 MB**
（0x810000 起），与 16 MB flash 对齐；并**把注释改成纯 ASCII**（见 8.5）。

### 8.2 报错原文（修之前）

```
D:/dsh-assistant/firmware/esp32-box3/main/main.c:21:10: fatal error: esp-box-3.h: No such file or directory
D:/dsh-assistant/firmware/esp32-box3/main/ui_done.c:124:31: error: implicit declaration of function 'tihu_ui_connection_text' [-Werror=implicit-function-declaration]
D:/dsh-assistant/firmware/esp32-box3/main/ui_done.c:164:65: error: '%s' directive output may be truncated
   writing up to 31 bytes into a region of size 24 [-Werror=format-truncation=]
D:/dsh-assistant/firmware/esp32-box3/managed_components/espressif__i2c_bus/i2c_bus_v2.c:103:9:
   error: implicit declaration of function 'i2c_master_get_bus_handle' [-Werror=implicit-function-declaration]
```

### 8.3 为什么钉到 `~1.4.0` 还不够（关键坑）

钉版本后组件管理器解析到 **i2c_bus 1.4.2**，仍然报同一个错。原因在组件自己的 CMake：

```cmake
if("${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}" VERSION_LESS "5.3" OR CONFIG_I2C_BUS_BACKWARD_CONFIG)
    set(SRC_FILE "i2c_bus.c")      # 旧 driver/i2c
else()
    set(SRC_FILE "i2c_bus_v2.c")   # 新 esp_driver_i2c，内部调用 5.4 才有的 i2c_master_get_bus_handle()
```

也就是**只要 IDF ≥ 5.3 就编 `i2c_bus_v2.c`**，而 `i2c_master_get_bus_handle()` 是 IDF 5.4 才引入的
（5.3 的 `driver/i2c_master.h` 里没有）。组件自带的 Kconfig 就为这种情况留了开关，注释原文：
“Enable this option for backward compatibility with the old I2C driver (only valid in IDF v5.3 and above).”

所以 `CONFIG_I2C_BUS_BACKWARD_CONFIG=y` 才是 5.3 上的正解；本固件不用 IMU/sensor_hub
（BSP 自己用新 API 建 I2C 总线，触摸/按键/音频不经过 i2c_bus），退回旧驱动没有副作用。
**如果以后要启用 IMU（icm42670/sensor_hub），建议把 IDF 升到 5.4+ 再关掉这个开关。**

### 8.4 QIO 写进去也不会生效

`sdkconfig.defaults` 原来写 `CONFIG_ESPTOOLPY_FLASHMODE_QIO=y`，但生成出来的 `sdkconfig` 是
`CONFIG_ESPTOOLPY_FLASHMODE="dio"`：S3 在 `SPIRAM_MODE_OCT` 下 QIO 与八线 PSRAM 抢 SPI 引脚，
Kconfig 会静默改回 DIO。现在直接写 DIO，免得看配置时误以为 QIO 生效了（烧录命令里
`--flash_mode dio` 也是这个原因，正常）。

### 8.5 `partitions.csv` 里不能有中文注释

第一版给 CSV 加了中文注释，构建时冒出 5 次：

```
File "D:\esp\esp-idf\components\partition_table\parttool.py", line 97, in __init__
    partition_table = gen.PartitionTable.from_csv(f.read())
UnicodeDecodeError: 'gbk' codec can't decode byte 0x9a in position 19: illegal multibyte sequence
```

`parttool.py` 用 Windows 本地编码（GBK）读这个 CSV，UTF-8 中文注释会炸（构建还能过，但
分区表相关子步骤报错、`idf.py partition-table*` 会踩坑）。改成纯 ASCII 注释后 0 报错。

### 8.6 编译输出尾部（原文）

```
Generated D:/dsh-assistant/firmware/esp32-box3/build/tihu_box3.bin
[1954/1954] cmd.exe /C "cd /D D:\dsh-assistant\firmware\esp32-box3\build\esp-idf\esptool_py && ... check_sizes.py --offset 0x8000 partition --type app .../partition-table.bin .../tihu_box3.bin"
tihu_box3.bin binary size 0x19b480 bytes. Smallest app partition is 0x800000 bytes. 0x664b80 bytes (80%) free.
Project build complete. To flash, run:
 idf.py flash
or
 idf.py -p PORT flash
or
 python -m esptool --chip esp32s3 -b 460800 --before default_reset --after hard_reset write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m 0x0 build\bootloader\bootloader.bin 0x8000 build\partition_table\partition-table.bin 0x10000 build\tihu_box3.bin
or from the "D:\dsh-assistant\firmware\esp32-box3\build" directory
 python -m esptool --chip esp32s3 -b 460800 --before default_reset --after hard_reset write_flash "@flash_args"
```

### 8.7 功能没有被削掉

8 个自研源文件 + 2 个中文字库全部参与链接（`build\esp-idf\main\CMakeFiles\__idf_main.dir\` 下
`main.c/tihu_net.c/tihu_protocol.c/tihu_audio.c/ui.c/ui_board.c/ui_progress.c/ui_done.c/
font/tihu_font_15.c/font/tihu_font_20.c` 的 .obj 都在），改动只碰了 include 路径、一处头文件声明、
两处缓冲大小和 snprintf 精度；WebSocket 协议收发、三屏 UI、ES8311/ES7210 音频、CONFIG 按键逻辑一行未删。

### 8.8 烧录命令（BOX-3B 插 USB-C 后）

```bat
:: 进环境（或双击 idf-env.cmd）
D:\esp\esp-idf\export.bat
cd /d D:\dsh-assistant\firmware\esp32-box3

idf.py -p COM5 flash monitor      :: COM5 换成设备管理器里的实际串口
:: 只烧不监视： idf.py -p COM5 flash
:: 串口只监视： idf.py -p COM5 monitor      （Ctrl+] 退出）
```

分区表改过（8 MB app），第一次烧建议整片写：`idf.py -p COM5 erase-flash` 再 `flash`。


---

## 9. 真机两处问题修复（2026-11-11 16:20–17:05，已烧 COM3 验证）

真机 ESP32-S3-BOX-3B（COM3，115200）上电后出现两个问题，这一节记录根因、改法与实测日志。

### 9.1 问题一：屏幕只有最上面一条亮条，其余全黑

**不是「LVGL 循环没跑起来」。** `app_main` 返回是 ESP-IDF 的正常行为（main_task 结束、其它任务继续跑）。
真正的原因是我们把 **LVGL 的渲染放进了栈不够大的任务里**，画一帧就踩爆栈，板子反复重启，
屏幕永远停在第 1 帧的一部分（看起来就是顶部一条亮条）。

实测证据（修复前的串口）：

```
I (2076) tihu_ui: UI 就绪：320x240，三屏已创建        <- 屏初始化成功
I (2327) wifi:state: init -> auth (0xb0)
I (2351) main_task: Returned from app_main()
I (3722) tihu_net: 忽略未知下行 type=session.bound     <- 宿主一打招呼
Guru Meditation Error: Core 1 panic'ed (LoadProhibited)
  Backtrace: esp_transport_get_error_handle -> esp_websocket_client_task
```

换一块板子/换一次启动还会变成：

```
assert failed: xQueueSemaphoreTake queue.c:1713 (pxQueue->uxItemSize == 0)
  Backtrace: ... -> esp_websocket_client_task
```

这两条 backtrace 都落在 websocket 任务里、崩在「和 LVGL 无关的指针字段」上，典型的**栈溢出把相邻堆写坏**。
`esp_websocket_client` 默认任务栈只有 **4 KB**，而我们在它的事件回调里直接调 LVGL
（`tihu_ui_show_frame` → `tihu_ui_board_update` → `lv_label_set_text` …）再构 cJSON 回 ack。

用 addr2line 解码后做了对照实验：把同一条渲染链放到 **8 KB 的 main 任务**里（在 `tihu_ui_init` 里调
`lv_refr_now`），立刻得到确定性的证据：

```
***ERROR*** A stack overflow in task main has been detected.
Backtrace: vApplicationStackOverflowHook <- vTaskSwitchContext
         <- lv_draw_label_iterate_characters <- lv_draw_sw_label <- lv_display_refr_timer
         <- lv_refr_now <- tihu_ui_init <- app_main
```

结论：**320×240 一屏中文标签，`lv_refr_now`/`lv_timer_handler` 的调用链要 5–7 KB 栈**。
所以渲染只能在栈 ≥12 KB 的任务里做，而且不能顺手在 `app_main` 里同步刷首帧。

**改法**

| 位置 | 改动 |
| --- | --- |
| `main/ui.c` | 不用 `bsp_display_start()`，改 `bsp_display_start_with_config()`：LVGL 任务栈 12 KB、tick 5 ms；打印返回码/分辨率/颜色格式/draw buf |
| `main/ui.c` | 挂 **flush 探针**（包一层 `lv_display_set_flush_cb`，计数后原样转发），并公开 `tihu_ui_flush_count()` |
| `main/ui.c` | 新增 `tihu_ui_show_boot()`：静态首页「鹈鹕 BOX-3B / 连接中… / 按住 CONFIG 说话 + 底部主页·停止两键」，不依赖宿主 |
| `main/ui.c` | 删掉 `tihu_ui_init` 里的 `lv_refr_now()`（那是 main 任务栈溢出的直接凶手） |
| `main/main.c` | 新增常驻 `tihu_ui_task`（12 KB 栈、10 ms 一帧、`bsp_display_lock` + `lv_timer_handler`），第一次循环先 `lv_refr_now(NULL)` 同步刷首帧；每 5 s 打一条 `UI 心跳：handler/flush/堆余` |
| `main/main.c` | 启动顺序改成「屏 + 首页 → UI 任务 → 音频 → 网络 → 按键」，末尾明确打「app_main 返回不影响屏幕与网络」 |
| `main/tihu_net.c` | websocket 任务栈 4 KB → 8 KB（`cfg.task_stack = 8192`） |
| `sdkconfig` / `sdkconfig.defaults` | `CONFIG_ESP_TIMER_TASK_STACK_SIZE` 3584 → 6144（esp_timer 任务要跑按键/告警/心跳回调，里面有 LVGL 与 cJSON） |

改大栈之后内部 RAM 不够 `esp_wifi_init` 了（报 `ESP_ERR_NO_MEM`，0x101），于是又加了一项：

| 位置 | 改动 |
| --- | --- |
| `sdkconfig` / `sdkconfig.defaults` | `CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y`：LVGL 的 draw buffer（320×100×2 = 62.5 KB）必须留在内部 RAM 做 SPI DMA，WiFi/LWIP 的接收缓冲退到 PSRAM |

改完的串口（同一块板，20 s）：

```
I (1840) tihu_ui: bsp_display_start 返回 0x3fcad5f4：320x240，color=18，draw buf=32000 px，dbl=0
I (1850) tihu_ui: LVGL 任务：栈 12000 B / 优先级 4 / tick 5 ms；flush 探针已挂（原回调 0x42016e34）
I (2107) tihu_ui: UI 就绪：320x240，三屏已创建；首帧交给 UI 任务同步刷出（当前 flush=3）
I (2114) tihu_main: UI 任务已进入常驻循环：10 ms/帧，栈 12288 B，core=0
I (7268) tihu_main: UI 心跳：handler=500 flush=12(+12) 内部堆余=20891B PSRAM 余=16320700B
I (12351) tihu_main: UI 心跳：handler=1000 flush=15(+3) 内部堆余=20351B PSRAM 余=16320700B
I (17438) tihu_main: UI 心跳：handler=1500 flush=18(+3) 内部堆余=20219B PSRAM 余=16317568B
```

`flush` 计数一直涨 = 屏幕真的在刷；宿主推一帧棋盘就 +3 次 flush。
**以后只看串口就知道屏有没有在刷**：`flush` 不涨就是渲染/背光/面板的问题，`handler` 不涨就是任务被吊死。

### 9.2 问题二：Wi-Fi 认证失败（MiMover_8ebca3_MI）

**不是密码问题。** 同一 SSID、同一密码 `12345678@@`，设备第一次 auth 被拒、3 秒后重试就通了：

```
I (4781) wifi:state: init -> auth (0xb0)
I (4773) wifi:state: auth -> init (0x1c0)          <- 第一次尝试失败
W (4775) tihu_net: Wi-Fi 断开 reason=202：AP 拒绝认证（密码错；热点刚开机/STA 表满/刚踢过人时也会瞬时拒绝）
I (13193) tihu_net: 重试 Wi-Fi 连接（第 2 次）…
I (15716) wifi:connected with MiMover_8ebca3_MI, channel 1, BW20, rssi: -38
I (15717) wifi:security: WPA2-PSK, phy: bgn
I (16741) tihu_net: Wi-Fi 已获取 IP：10.113.136.162
```

关键判据：**reason 202（`WIFI_REASON_AUTH_FAIL`）之后重试能连上、security 协商结果是 WPA2-PSK**，
说明密码和 authmode 都对；202/205 是**手机热点侧对首次 auth 的瞬时拒绝**（802.11ax 手机热点在
STA 表冷启动、刚踢人、或与 11k/v 漫游辅助交互时常见）。原固件没有打印 reason、也没有重扫，
所以日志里只剩 `auth -> init (0x1c0)` 无限循环，看起来像"密码错"。

另外：本次排障时还发现**电脑自己掉到了打印机 `DIRECT-D6-HP Laser 136w` 的 Wi-Fi Direct 上**，
于是板子在 10.113.136.0/24、电脑在 192.169.0.0/24，WebSocket 一直 `CONNECTION_TIMEOUT`。
用 `netsh wlan connect name="MiMover_8ebca3_MI"` 把电脑拉回热点后（IP 10.113.136.60）立刻连通。
**以后遇到「Wi-Fi 连上了但连不上宿主」，先确认电脑和板子在同一个网段。**

**改法**（`main/tihu_net.c`）

| 改动 | 说明 |
| --- | --- |
| 打印 disconnect reason + 中文解释 | `WIFI_EVENT_STA_DISCONNECTED` 的 `reason` 逐条对照 `esp_wifi_types.h`：202 密码错/AP 瞬时拒绝、15/204 四次握手超时、201 找不到 SSID、203 关联被拒、23 企业网 802.1X… |
| 明确 WPA2-PSK | `threshold.authmode = WIFI_AUTH_WPA2_PSK`、`threshold.rssi = -127`、`scan_method = WIFI_ALL_CHANNEL_SCAN`、`sort_method = WIFI_CONNECT_AP_BY_SIGNAL`，不试 WPA3/SAE |
| 关 PMF / 11k-v | `pmf_cfg.capable = false; required = false`；11k/v 本来就是 `# CONFIG_ESP_WIFI_11KV_SUPPORT is not set`，启动日志里明打一行确认 |
| 15 s 看门狗 + 重扫 | `esp_timer` 15 s 一发，超时通知 `wifi_probe_task`（扫描会阻塞，不能放 timer 回调）→ 扫到目标 SSID 就打印 `AP[i] ssid/ch/rssi/auth`、命中目标的 BSSID/信道/加密，再重连；找不到 SSID 单独一条中文告警 |
| 失败退避重试 | 断线后 3 s 重试；`201/210/211/23` 这类重试救不回来的直接重扫 |
| 日志 | `esp_wifi_init` 前后打印内部堆/最大块/PSRAM，`esp_wifi_init` 失败改成 ERROR + 提示查 `SPIRAM_TRY_ALLOCATE_WIFI_LWIP`（不再 `ESP_ERROR_CHECK` 直接重启） |
| 附带修好的一件事 | `tihu_audio` 的 64 KB 播放 StreamBuffer 启动时创建失败（`E tihu_audio: 播放 StreamBuffer 创建失败`，TTS 直接没声）→ 改成 `xStreamBufferCreateWithCaps(... MALLOC_CAP_SPIRAM)`、容量 32 KB，内部 RAM 不够再退回调普通分配 |

### 9.3 本次验证的完整 20 秒串口（`idf.py -p COM3 flash` 后复位抓取）

```
I (1560) tihu_main: 鹈鹕 BOX-3B 固件 0.1.0 启动
I (1840) tihu_ui: bsp_display_start 返回 0x3fcad5f4：320x240，color=18，draw buf=32000 px，dbl=0
I (1850) tihu_ui: LVGL 任务：栈 12000 B / 优先级 4 / tick 5 ms；flush 探针已挂（原回调 0x42016e34）
I (2107) tihu_ui: UI 就绪：320x240，三屏已创建；首帧交给 UI 任务同步刷出（当前 flush=3）
I (2114) tihu_main: UI 任务已进入常驻循环：10 ms/帧，栈 12288 B，core=0
I (2204) tihu_net: esp_wifi_init 前：内部堆 84807 B（最大块 31744 B），PSRAM 16417304 B
I (2321) tihu_net: 802.11k/v 漫游辅助：编译期已关闭（ESP_WIFI_11KV_SUPPORT=n）
I (2372) tihu_net: 启动完成：SSID=MiMover_8ebca3_MI host=10.113.136.60:3081 token=已配置（authmode=WPA2-PSK，pmf=可选/不强制）
I (2404) tihu_main: 按住 CONFIG 键说话，松开上传
I (2410) tihu_main: 启动完成：UI 任务常驻（app_main 返回不影响屏幕与网络）
I (4781) wifi:state: init -> auth (0xb0)
I (4791) wifi:state: auth -> assoc (0x0)
I (4864) wifi:state: assoc -> run (0x10)
I (4915) wifi:connected with MiMover_8ebca3_MI, aid = 7, channel 1, BW20, bssid = 9a:9f:4b:68:97:32
I (4915) wifi:security: WPA2-PSK, phy: bgn, rssi: -33
I (5938) esp_netif_handlers: sta ip: 10.113.136.162, mask: 255.255.255.0, gw: 10.113.136.14
I (5939) tihu_net: Wi-Fi 已获取 IP：10.113.136.162
I (5945) websocket_client: Started
I (5947) tihu_net: WebSocket 启动：ws://10.113.136.60:3081/tihu/lane?token=96528673
I (6331) tihu_net: WebSocket 已连接：ws://10.113.136.60:3081/tihu/lane?token=96528673
I (6458) tihu_net: 忽略未知下行 type=session.bound
I (6462) tihu_net: 事件[指挥]：统一指挥已就绪：说一句话就派单，不用挑会话
I (6477) tihu_net: 忽略未知下行 type=task.list
I (6483) tihu_net: 事件[连接]：设备 dev-mwbvk2j8-176a8d17 已就绪
I (7268) tihu_main: UI 心跳：handler=500 flush=12(+12) 内部堆余=20891B PSRAM 余=16320700B
I (7452) tihu_net: 忽略未知下行 type=task.list
I (12351) tihu_main: UI 心跳：handler=1000 flush=15(+3) 内部堆余=20351B PSRAM 余=16320700B
I (12469) tihu_net: 忽略未知下行 type=task.list
I (17438) tihu_main: UI 心跳：handler=1500 flush=18(+3) 内部堆余=20219B PSRAM 余=16317568B
I (17467) tihu_net: 忽略未知下行 type=task.list
```

20 秒内 **无 panic、无重启**，屏在刷、Wi-Fi 通、宿主连上并推帧。

### 9.4 下次再遇到同类现象怎么查（30 秒定位）

1. **屏黑/只有一条**：先看有没有 `UI 心跳` 与 `flush`。
   - `handler` 在涨、`flush` 不涨 → 渲染没触发（缺 invalidate / 面板没 disp_on）或背光；
   - 两个都不涨 → UI 任务被吊死（锁、栈、或任务没创建）；
   - 有 `***ERROR*** A stack overflow in task ...` → 栈给小了，参照 9.1 的表加栈。
2. **Wi-Fi 连不上**：只看 `Wi-Fi 断开 reason=` 那一行。
   - 202/15/204 → 密码或 PMF/WPA3 混用；连续 202 且重试也不通才算密码问题；
   - 201/210/211 → 扫不到或加密不兼容，看紧随其后的 `AP[i]` 扫描清单；
   - 有 IP 但 `WebSocket CONNECTION_TIMEOUT` → 先 `ping` 宿主、确认电脑和板子同网段（9.2 末尾的坑）。
3. 改完务必 `idf.py -p COM3 flash` 后**冷复位抓 20 s**，不要只看编译过没过。

### 9.5 注意：sdkconfig 不入库

`sdkconfig` 在 `.gitignore` 里。本次新增的两个系统配置已同步写进 **`sdkconfig.defaults`**
（`CONFIG_ESP_TIMER_TASK_STACK_SIZE=6144`、`CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y`），
但**已经存在的 `sdkconfig` 不会自动跟随 defaults**：新机器/重装 IDF 后要
`idf.py set-target esp32s3`（或删掉 `sdkconfig`）重新生成，再 `idf.py menuconfig` 核对这两项。
另外 2026-11-11 这次踩到一个坑：用 Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 改 `sdkconfig`
会写入 **BOM**，kconfig 用 GBK 读文件时直接报
`UnicodeDecodeError: 'gbk' codec can't decode byte 0xbf in position 2`，编译直接失败。
改 `sdkconfig` 要用 `[System.IO.File]::WriteAllText($f,$text,(New-Object System.Text.UTF8Encoding($false)))`。

## 10. 真机中文全是空心方框（2026-11-11 16:55–17:20，已烧 COM3 验证）

**现象的两种可能，这次都不是**：`ui.c / ui_board.c / ui_progress.c / ui_done.c` 里所有
`lv_label_create` 都只在 `tihu_ui_label()` 一处，函数里必然 `lv_obj_set_style_text_font(...)`，
没有任何 label 落在 `LV_FONT_DEFAULT`/`lv_font_montserrat_14`；字库 cmap 也把屏上要的
汉字全收了（`鹈` U+9E48 在 20px/15px 里都有）。

**根因是字模的存储格式**：`tools/gen_font_subset.cjs` 调 `lv_font_conv` 的 JS API 时没传
`no_compress`，默认生成的就是 RLE 压缩位图（`.bitmap_format = 1`）；而 `sdkconfig` 里
`CONFIG_LV_USE_FONT_COMPRESSED` 没开。于是：

1. `lv_font_get_glyph_dsc_fmt_txt()` 照常命中（字形描述、adv_w、box 都在），排版因此完全正常；
2. `lv_font_get_bitmap_fmt_txt()` 走进 `#else /*!LV_USE_FONT_COMPRESSED*/` 分支 `return NULL`；
3. `lv_draw_label.c` 里 `dsc->format = dsc->glyph_data ? g.format : LV_FONT_GLYPH_FORMAT_NONE`；
4. `LV_USE_FONT_PLACEHOLDER=y` 把 FORMAT_NONE 画成 **1px 空心边框**——就是照片里的方框。

一句话：**不是没设字体，也不是缺字，是压缩字库没配解压器。**

**改法**

| 位置 | 改动 |
| --- | --- |
| `tools/gen_font_subset.cjs:102` | 加 `no_compress: true`（等价 CLI `--no-compress`），`opts_string` 同步写上 `--no-compress` |
| `main/font/tihu_font_20.c` / `tihu_font_15.c` | 重新生成：`.bitmap_format = 0`(PLAIN)、`.bpp = 4`、字形数 1073、cmap 32+95 / 183+65327 |
| `sdkconfig.defaults:46` + `sdkconfig` | `CONFIG_LV_USE_FONT_COMPRESSED=y`：以后万一又烧进压缩字库也能解，不会再静默画方框 |
| `main/ui.c:114-300` | 新增字体自检：打印两套字库的 bpp/bitmap_format/cmap_num、逐个 label 打印实际生效字体名与缺字、对「鹈」做 `lv_font_get_glyph_dsc` + `assert` |
| `main/ui.c:515` | `tihu_ui_init()` 里 unlock 前调 `ui_font_selftest(scr)` |
| `tools/check_font_chars.cjs`（新增） | 离线核对：解析字体 .c 的 cmap，扫四个 ui 源文件里的屏幕上文案（跳过 ESP_LOG），缺字退出码 1 |

**实测串口**（`idf.py -p COM3 flash` 后冷复位抓 26 s，节选）

```
I (2038) tihu_ui: 字库 tihu_font_20：line_height=21 base_line=4 bpp=4 bitmap_format=PLAIN cmap_num=2；编译期 LV_USE_FONT_COMPRESSED=1
I (2041) tihu_ui: 字库 tihu_font_15：line_height=17 base_line=3 bpp=4 bitmap_format=PLAIN cmap_num=2；编译期 LV_USE_FONT_COMPRESSED=1
I (2054) tihu_ui: 字形断言：「鹈」U+9E48 in tihu_font_20 = 存在（box=20x19 adv=20）
I (2221) tihu_ui: label #19 标题 font=tihu_font_20 bpp=4 字数=9 缺字=0 text="鹈鹕 BOX-3B"
I (2240) tihu_ui: label #21 标题 font=tihu_font_20 bpp=4 字数=12 缺字=0 text="按住 CONFIG 说话"
I (2372) tihu_ui: label #36 正文 font=tihu_font_15 bpp=4 字数=2 缺字=0 text="重读"
I (2409) tihu_ui: 字体自检 PASS：39 个 label 全部命中字库（20=标题 / 15=正文）
```

**下次再看到方框，只看两行**：`bitmap_format=` 是不是 PLAIN，以及 `字体自检` 是不是 PASS。
若 `bitmap_format=COMPRESSED` 而 `LV_USE_FONT_COMPRESSED=0`，日志里会直接
`E tihu_ui: 字库 ... 位图是压缩格式，但固件没开 LV_USE_FONT_COMPRESSED ...`。
