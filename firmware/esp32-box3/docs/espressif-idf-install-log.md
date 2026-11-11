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

