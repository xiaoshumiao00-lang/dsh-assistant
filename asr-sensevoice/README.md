# 鹈鹕 SenseVoice 常驻转写服务（127.0.0.1:3098）· watchdog

## 它是什么
手机 APK 的录音这条路（`POST /tihu/asr`）以前的转写出口是 whisper.cpp（3097）：
`asr_server.py` 每来一条请求就新起一个 whisper-cli 子进程 + 全局串行锁，
每次都要付 CUDA 初始化 + 把 1.5GB 的 medium 模型重新传一遍 —— 实测 2 秒音频就要
1.9s(small) / 3.1s(medium)，22 秒真录音 2.0–3.2s，撞上 strata（RTX 5080 已占 12.8GB、
GPU 99%）的窗口会拖到 15–28s（`whisper\asr.log`：p50 2.0s、p95 15.1s、max 28.3s）。

本服务把 SenseVoice-small ONNX **加载一次、进程不退出**（常驻，`idleTimeoutMs` 只是与
宿主插件对齐的记录项），实测 22s 音频 827ms / 5s 181ms / 2s 85ms，纯 CPU 不碰显卡。

## 文件
| 文件 | 作用 |
|---|---|
| `sensevoice_server.py` | 服务本体（`/transcribe`、`/health`、串行锁、Silero VAD 切 30 秒段、同一把静音尺 rms<50、同一份繁简+幻觉过滤） |
| `sensevoice.config.json` | 端口/模型/线程/VAD 参数（fp32、8 线程、常驻） |
| `start-sensevoice.cmd` | 健康检查后拉起，日志 `sensevoice.log`（>20MB 自动转 `.1`）；重复调用安全 |
| `sensevoice-watchdog.ps1` | `/health` 不通就清掉僵死进程再拉起（mutex `Global\TihuSenseVoiceWatchdog`，日志 `sensevoice-watchdog.log`） |

## 自己起服务 / 常驻开机
一次性手工起：
```
cmd /c D:\dsh-assistant\asr-sensevoice\start-sensevoice.cmd
```
让它开机就常驻（照 whisper 那份的画法，20 分钟一次）：
```
schtasks /Create /F /TN TihuSenseVoiceWatchdog /SC MINUTE /MO 20 /RU Administrator /RP ^
 /TR "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"D:\dsh-assistant\asr-sensevoice\sensevoice-watchdog.ps1\""
```

## 自检（不起服务也能量）
```
C:\Users\Administrator\.dsh\tihu\venv-sherpa\Scripts\python.exe ^
  D:\dsh-assistant\asr-sensevoice\sensevoice_server.py --selftest 某个.wav
```
打印：模型加载 ms、音频 ms、推理 ms、总 ms、分段数、文本。

## 引擎切换与回退（在 relay 那侧）
- 开关：`~/.dsh/assistant/config.json` → `tihu.voice.asrEngine`
  = `sensevoice`（默认） / `host-sensevoice` / `whisper`；临时不改文件：`set TIHU_ASR_ENGINE=whisper`
- 自动回退：SenseVoice 腿连不上 / 5xx / 超时 / 空转写 → relay 自动接棒 whisper（`tihu.voice.asrFallback: false` 可关）
- 静音、太短、坏音频不换乘引擎（换了也只是白跑一遍模型，直接判「没听清」）
- 改完必须重启 relay 才生效（重启命令写在 `tihu-tunnel\tihu-relay.cjs` 末尾注释里）

## 与 whisper 的分工
whisper（3097）留着不动，只做两件事：① relay 的兜底腿；② 板端唤醒同音检测
（`POST /tihu/wake`，靠 `asr_server.py` 的 `fix_wake_word` 同音表）——这次没动它。
