# 鹈鹕安卓端「安静房间每 ~3 秒自动唤醒」根因调研（Phase 1 证据收集）

- 时间：2026-11-13 19:4x
- 范围：只读调查，未改任何源码，未 git checkout/stash/reset
- 仓库：`D:\dsh-assistant`（`android/` 整目录**未纳入 git**，1.3.5 前后的差异只能用同目录 `.bak-*` 备份比对；工作树当前是 1.3.7→1.3.8 进行中状态）
- 设备实采：`D:\android-sdk\platform-tools\adb.exe devices` → **空列表（no devices/emulators found）**，本机没有连手机，所以拿不到 logcat / 实机 wakeEvents，只能给离线复算结果

---

## 一、唤醒链路（文件:行）

| 环节 | 位置 | 关键值 |
|---|---|---|
| 监听线程 | `android/app/src/main/java/com/chenpan/assistant/WakeEngine.java:130` `loop()` | — |
| 滑窗 | `WakeEngine.java:28` | `WIN = 24000`（16k × 1.5 s）|
| 步进 | `WakeEngine.java:29` | `STEP = 1600`（100 ms）|
| 能量门限 | `WakeEngine.java:31` | `RMS_GATE = 150` |
| 连击帧数 | `WakeEngine.java:33` | `HIT_NEED = 2` |
| 打分阈值 | `WakeEngine.java:39` + `MainActivity.java:180` `wakeThreshold = 0.75f` | 默认 **0.75**，存 `wake_threshold`（`MainActivity.java:115/301-306`）|
| 命中后静默 | `WakeEngine.java:189` | `quietUntil = now + 2000`，但同一行紧接着 `running = false; break;`（186-192）——引擎直接退出，这个 2 s 只在实例存活时有用 |
| 起引擎 | `MainActivity.java:1699` `startLocalWake()`，`180:1751` `setThreshold(wakeThreshold)`，`1752 start()` | 只在「鹈鹕屏 + 前台 + 非录/转写 + wake_enabled」时起（`1671-1689`）|
| 命中回调 | `MainActivity.java:1786-1804` `onWakeDetected()`：先 `stopWake()`，再 `startRecording()` | 命中即停引擎，交给录音链路 |
| 重开延迟 | `MainActivity.java:1812-1818` `scheduleWakeRestart()` | **320 ms** `postDelayed`；调用点 `2820`（取消录音）、`2977`（发送成功）|
| 录音上限 | `MainActivity.java:159` `REC_MAX_MS = 180000`（1.3.5 同期是 60000，见 `MainActivity.java.bak-20261113-154041:152`）| 录音**没有 VAD 自动收尾**，只有手动结束或到上限 |
| 模型 | `android/app/src/main/assets/wake_cnn.tflite`，运行时复制到 filesDir（`WakeNet.java:84-98`）| 244716 B（`eval_after.txt` 首行、`WakeNet.java` 自检行 `1717`）|
| 特征 | `WakeNet.java:153-204` | 幅度谱 + 周期 Hann(400) + 148 帧补 0 + **按窗 mean/std 标准化**（`:184-203`，`std + 1e-5`）|
| 输出 | `WakeNet.java:212-218` | `max(p1,p2)`，3 类 softmax |

### 1.3.5 的阈值改动（核记忆：600→150、3→2）

- 旧版：`WakeEngine.java.bak-20261113-154041:108` `if (rms < 600)`；`:116` `if (hit >= 3)`
- 现行：`WakeEngine.java:31` `RMS_GATE = 150`；`:33` `HIT_NEED = 2`
- 模型 244716 B ✔（`android/tools/wake/out/eval_after.txt:1`：`bytes=244716 in=[1,150,40,1] out=[1,3]`）

### 「3 秒」在唤醒链路里**不存在固定常量**

全仓（`android/app/src/main/java/**`）grep `3000|3 秒`：
- `MainActivity.java:2382` `connTick` 3 s —— 只刷「已连接」小圆点和浮层可见性，**不碰唤醒**
- `MainActivity.java:2471` 错误行 3 s 后自动消失
- `MainActivity.java:3338` `CARD_MS = 1500` 转录卡自动发送
- `page.ts:2196` 末字后静音 3 s 自动发送（浏览器侧免按住，与原生唤醒无关）；`page.ts:2270` 识别重启 400 ms；`page.ts:2140` 10 s 无话退出
- 固件 `main.c:117` `WAKE_COMMAND_MS 5000`（板端，不适用安卓端）
- `WakeEngine` 只有 `quietUntil + 2000`（`:189`）与 `setPaused` 的 300 ms（`:58`）

**结论：3 秒是涌现周期，不是定时器。** 命中→停引擎→（0.32 s 重开）→ 重新攒 1.5 s 窗 → 2 帧确认 0.2 s；叠加 1.3.5 `WakeEngine.stop()` 只 `join(600)`（旧版没有先 `rec.stop()`，见 `.bak-20261113-191911` 与现 `WakeEngine.java:84-111` 的 diff）→ **约 2.4–3.0 s 一轮**，与用户口述的「每 3 秒」吻合。

---

## 二、离线复算（本机跑的只读探针，脚本在 `C:\Users\Administrator\.dsh\repro\wake-false-trigger\`）

特征直接 `import` 仓库的 `score_train.feats()`，与训练/安卓同口径。

1) **真实录音的安静段并不会误报**（`probe3.py`，按 rms 分桶）

| 数据 | rms 区间 | 窗口数 | max score | ≥0.75 |
|---|---|---|---|---|
| real2.wav（33.9 s 正常说话） | 150–300 | 3 | 0.000 | 0 |
| real2.wav | 300–600 | 1 | 0.000 | 0 |
| real2.wav | 600–1200 | 10 | 0.000 | 0 |
| real1.wav（12.5 s，5 次鹈鹕） | 150–300 | 19 | 0.004 | 0 |

→ 单纯「房间底噪 rms 150–600」打不到 0.75（也印证 `eval_after.txt`：real2 全局 max=0.145）。**所以不是"底噪把门限撑过去"这么简单**。

2) 但**退化/平滑输入会让模型满置信**（`probe.py`，12 s 合成）

| 输入 | rms | max | 真机规则触发次数（连续2帧≥0.75）|
|---|---|---|---|
| 数字静音（全 0） | 0 | 0.970 | 53（但 rms<150 被门限挡掉）|
| 直流 +200 | 200 | 0.774 | 53（**过门限就会触发**）|
| 直流 +200 + 0.5 LSB 噪声 | 200 | 0.003 | 0 |
| 白噪声 30/100/300/600/1200 | 同左 | 0.014–0.137 | 0 |
| 极低频平滑噪声（200 ms 滑动平均） | 150/200/400/800 | **1.000** | 53（**任何响度都触发**）|

3) **自己的 TTS 就能把唤醒点着**（`probe4.py`，真机规则扫 `data/neg_wav` 普通 TTS 片段 40 个）

- **20/40（50%）的普通 TTS 片段会触发**，累计 34 次；单段最高 `max=0.964`
- 典型：`n5_031.wav` 9.4 s 内触发 2 次、`n2_022.wav` 7.1 s 内 3 次 → **约每 3–4 秒一次**
- 这与 `eval_after.txt` 的 `[E] TTS negatives … max=0.949 windows>=0.5=77` 完全一致：训练时这些负样本从没被压下去

4) **TTS 期间唤醒根本没被暂停**：
- 唯一暂停入口 `MainActivity.java:1938-1941` `setTtsPlaying()` → `wakeLocal.setPaused()`
- `src/tihu/page.ts` 里 **0 次** 调用 `setTtsPlaying`（只有 `wakeEnabled/wakeSetEnabled/wakeToggle/wakeState`）
- 所以 `WakeEngine.setPaused()`（`:55-59`）在真机上是死代码，页面朗读/播报时引擎照常每 100 ms 打分

5) 灵敏度滑条对本地引擎无效：`wake_sensitivity`（`MainActivity.java:111/1657` 默认 0.5）只喂给 Porcupine（`:1688`）；`startLocalWake()` 只用 `wakeThreshold`（`:1751`）。

---

## 三、结论

### 最可能根因
**唤醒词模型对「类人声」没有区分力，而安静房间里唯一的类人声声源就是手机自己。** 页面朗读（TTS）/提示音回放被自己的麦克风收回去，按真机规则（1.5 s 窗 + 2 帧）约每 3–4 秒就会命中一次；`setTtsPlaying()` 这条暂停通路页面从不调用（`MainActivity.java:1938` ↔ `page.ts` 无引用），所以播报时唤醒一直在打分。定量支撑：50% 普通 TTS 片段在 2 帧@0.75 下触发、34 次/40 段、max 0.964。

### 次要可能
1. **退化输入满置信**：按窗标准化（`WakeNet.java:198` `std+1e-5`）使分数与响度无关；数字静音 0.970、直流 +200 0.774、极低频平滑噪声 1.000（任何 rms）。因此 `RMS_GATE=150` 只能决定「要不要打分」，**不具备按响度过滤误报的能力**；而真机安静段 rms 实测 253–3000（real1/real2），150 这个门限实际上等于放行。
2. **1.3.5 的门限/连击本身就是放大项**：600→150、3→2 帧（`WakeEngine.java:31/33` vs `.bak-…154041:108/116`），单帧噪声就能凑 2 帧；1.3.5 前 real2 误报 3 次、之后 0 次，说明模型改动前更糟——但这次是「有类语音声源」的新场景，阈值改动让命中更容易。
3. **抢麦竞态**：1.3.5 的 `stop()` 只 `join(600)` 不打断阻塞 `read()`（`.bak-191911` vs 现 `:84-111`），命中后立刻 `startRecording()`（`:1803`）可能拿不到麦 → 「麦克风打不开」/录到静音，把一次误报变成一串界面抖动。
4. 灵敏度滑条（`wake_sensitivity`）对本地引擎无效，用户调它没反应 → 排障时容易误判。

### 需要用户提供/下一步验证（不改代码）
1. **30 秒判定**：把手机媒体音量调到 0（或让页面完全不朗读、不播 TTS），静置 2 分钟。**若不再触发 → 自触发坐实**；仍触发则转 2)。
2. **读数**：设置 →「语音唤醒」面板里的命中记录（`wakeEventLines`，`MainActivity.java:2000`）+ 每次命中的 `wakeScoreValue()` = `"分数/rms"`（`MainActivity.java:1967`）。要的是：命中时 score 是否刚好 0.75–0.95、rms 是多少（<600 说明是弱能量路径，>2000 说明是类语音声源）。
3. **安静段原始录音**：手机录 60 s 房间原声（wav, 16k/mono/16bit），跑 `python android\tools\wake\score_train.py quiet.wav`（现有脚本，只读）看 max 是否 ≥0.75、rms 分布是否 ≥150 —— 这能一锤定音「底噪 vs 类语音」。
4. **阈值二分**：面板把阈值 0.75 → 0.95，若频率明显下降，证明走的是「分数」路径（模型问题），而不是「能量」路径。
5. 接 USB 后 `D:\android-sdk\platform-tools\adb.exe devices` 能列出手机，再抓 `adb logcat`（应用侧没有 TAG 日志，只能看 AudioRecord/WebView 报错），主要还是要面板读数。

> 本机当前 **没有** 连接 adb 设备，以上实采全部无法执行，报告中的数字均为离线复算（模型/数据/特征与真机同源）。
