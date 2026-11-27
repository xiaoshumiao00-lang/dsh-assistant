# 个人助手 · Android 外壳（APK）

一块屏：**助手屏**＝电脑上 DSH 那套页面（同一份 HTML/CSS/JS、同一个会话、同一套插件）。
纯 Java，无 Gradle：`aapt2 → javac → d8 → jar → zipalign → apksigner`。

| 项 | 值 |
| --- | --- |
| 版本 | **1.4.8**（实测 versionCode `35` / versionName `1.4.8`，可覆盖升级 1.4.x） |
| 包名 | `com.chenpan.assistant.generic`（通用版） |
| 交付件 | `android/dist/个人助手-通用版-1.4.8.apk`（86,899 字节，2026-11-27 10:48 构建；构建产物同时在 `android/out/`，同目录另有 `个人助手-通用版-1.4.8.apk.idsig` 5,660 字节） |
| 签名 | `android/assistant.keystore`，alias `assistant`，口令 `***REMOVED***`（**升级必须用同一把**） |
| 最低 / 目标 | Android 7.0（API 24）/ API 34 |

## 1.4.3 的变化：鹈鹕设备功能整条撤掉

鹈鹕（tihu）模拟设备屏连同它的语音能力一起删掉了，APK 只剩助手屏：

- 删：鹈鹕屏 WebView 与它的懒创建/切屏/超时降级/错误面板、录音按钮与波形、`AudioRecord`+WAV+`/tihu/asr` 上传、Porcupine 与本地 TFLite 唤醒模型、音量条与朗读音量注入、浅色主题与齿轮面板、转录确认卡（自动发送）。
- 删文件：`TihuVoiceUtil.java`、`WakeEngine/WakeNet/WakeRules/WakeController.java`、`VolumeBar.java`、`RecorderButtonDrawable.java`、`ToneFx.java`、`assets/wake_cnn.tflite`、`train.py`、`matrix.py`，以及 `third_party/` 里的 TFLite AAR 解包件与 Vosk 模型包。
- 构建脚本不再需要 Porcupine / TensorFlow Lite 的 AAR，也不再把 `libpv_porcupine.so` / `libtensorflowlite_jni.so` 打进 APK。
- 设置页只剩**一个**输入框（助手地址）；「一键填入常用地址」只填这一格。
- 1.4.4 又补了一刀：左下角那颗 40dp 的悬浮切屏球（1.4.3 还留着、显示成「鹈」）整段删掉了 —— `buildScreenButton` / `moveBallTo` / `restoreBall` / `tryRestoreBall` / `resetBallToDefault` / `updateScreenButton` / `refreshChrome` 七个方法、`screenBtn` / `ballX` / `ballY` 三个字段、`KEY_BALL_X` / `KEY_BALL_Y` 两个键、以及 `BallRules.java` 整个文件。界面上再也没有任何悬浮控件。
- 改地址的入口：长按返回键约 1 秒，或长按桌面图标选「设置地址」；返回键退到底也会弹同一个菜单（设置地址 / 重新加载页面 / 退出应用）。
- 体积：1.4.2 的 3.1 MB → 1.4.3 的 78,707 字节 → 1.4.4 的 **74,608 字节**（APK 里已无 `.so`、无 `assets/`）。

## 当前最新版本与 1.4.5–1.4.8 各版变化

最新交付件 = **1.4.8（versionCode 35）**，没有 1.4.9 或更高：`android/dist/` 与 `android/out/` 里最高就是 1.4.8（32 个 APK，1.1.0 起），`android/app/src/main/AndroidManifest.xml` 也没有更新版本号（版本号由 `build.ps1 -VersionName/-VersionCode` 在 `aapt2 link` 时注入）。

实测判据（`aapt2 dump badging` + `apksigner verify`，原始输出在 `outputs/2026-11-28/apk-audit/`）：

```
1.4.8 : package com.chenpan.assistant.generic versionCode=35 versionName=1.4.8  minSdk=24 targetSdk=34
1.4.7 : versionCode=34 versionName=1.4.7  minSdk=24 targetSdk=34
apksigner verify --print-certs: Verifies / v2=true v3=true (v1、v3.1、v4 = false), 1 signer,
  cert SHA-256 b081dc7ba8a54c2fa36ab4f8bffcabedcd9558d922dcea8dcac21cfe04b7a333（1.4.4–1.4.8 全部同一把 assistant.keystore，可覆盖装）
```

| 版本（code） | 一句话结论 | 证据 | APK 字节 |
| --- | --- | --- | --- |
| 1.4.5（32） | 附件下载带上 WebView cookie（Cookie / Referer / User-Agent）＋下载完成/失败广播（`watchDownload`/`reportDownload`、RFC5987 `filename*` 中文名、toast）：修掉 pocket 401 导致通知栏「正在下载」永不结束 | `f86751b`（2026-11-26 18:13，MainActivity +154/-5）、`docs/安卓附件下载-401-根因-20261126.md:185,198` | 74,608 → 78,707 |
| 1.4.6（33） | 图片类附件点击改走原生只读下载链路（同一路径加 `download=1`、服务端强制 `attachment`）＋下载完成拉起系统看图（`isImageDownload` / `openDownloadedImage` / `MimeTypeMap` / `image/*`） | `85d4a13`（2026-11-27 09:10，MainActivity +69/-1）、`docs/秘书回复卡图片-原生下载与看图-20261127.md:21,129-130` | 78,707（与 1.4.5 同字节数） |
| 1.4.7（34） | 所有附件点击统一走系统下载 + 安卓端按 MIME 分流打开（看图 / apk 弹安装 / pdf·office·txt·音频 `ACTION_VIEW` / 其余留通知），`openDownloadedFile` 泛化（`content:` Uri + `FLAG_GRANT_READ_URI_PERMISSION`），清单新增 `REQUEST_INSTALL_PACKAGES` | `f27fe4b`（2026-11-27 09:21，MainActivity +92/-18、Manifest +3）、`docs/秘书回复卡附件-全类型下载-20261127.md:92-95` | 78,704（-3） |
| 1.4.8（35） | 后台保活 ＋ 切回秒恢复 ＋ 后台任务完成播报：新增 `KeepAliveService.java`（前台服务 `dataSync`、常驻通知、`START_STICKY`、`onTaskRemoved` 拉回、9 分钟 Doze 节拍续唤醒锁）、新增 `NativeBridge.java`（`@JavascriptInterface` 桥 `DshAssistantNative`，页面探活 `probePageAlive`）、`MainActivity` 加 onResume 不 reload/自动朗读走原生 `TextToSpeech`、设置页加保活开关与电池优化白名单入口 | `353c99d`（2026-11-27 10:49，Manifest +17、KeepAliveService 288 行、NativeBridge 239 行、MainActivity +132）、`docs/安卓后台保活-秒恢复-20261127.md:8,181-185` | 78,704 → 86,899（+8,195） |

1.4.8 比 1.4.7 多的 8,195 字节，看 APK 条目清单比不出名堂——两版条目**完全同一套**（12 项、无 `lib/*.so`、无 `assets/`）：
AndroidManifest.xml 压缩后 1,447→1,712（未压缩 4,532→5,620：多了 `POST_NOTIFICATIONS`/`FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_DATA_SYNC`/`WAKE_LOCK`/`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 五条权限和 `.KeepAliveService` 那条 `service`，`foregroundServiceType=0x1`＝dataSync），
`classes.dex` 压缩后 17,935→25,005（未压缩 36,296→50,980，即上面那三个 Java 文件的新增代码），META-INF 三项合计 -2；
APK 签名块 5,356→6,212（+856）、本地头 +3、中央目录 +3。逐项相加正好等于 8,195。

1.4.5 / 1.4.6 都是 78,707 字节、1.4.4 是 74,608 字节，1.4.7 是 78,704 字节（1.4.6→1.4.7 dex 长了 1,668 字节但 manifest 也长了 172 字节，压缩率抵消后只差 3 字节）。

## 装到手机

1. 把 `个人助手-通用版-1.4.8.apk` 传到手机（数据线 / U 盘都行）。
2. 点开安装，系统提示「未知来源」时允许一次（自己签名的应用，正常）。同包名可直接覆盖 1.4.x 旧版。
3. 通用版首次打开进「地址设置页」——输入框是空的。

## 首次要填的地址

| 输入框 | 填什么 | 常用值 |
| --- | --- | --- |
| 助手地址（DSH） | 电脑上 DSH → 设置 → 个人助手 → 手机访问 给的入口 | `http://***REMOVED***` |

- 空着点保存会明确提示，不会进一片白屏；懒得复制就点 **「一键填入常用地址」**（只填还空着的那格，不覆盖已填好的）。
- 改地址：**长按返回键约 1 秒**（或长按桌面图标的「设置地址」快捷方式）。宽屏/平板上设置页限宽 560dp。
- 返回键：页面内后退，退到底弹菜单（设置地址 / 重新加载页面 / 退出应用）。
- 登录态自愈、错误页、首屏等待层、文件上传/权限、下载、折叠屏与分屏适配这些都不受本次删除影响。

## 重新构建

```powershell
powershell -ExecutionPolicy Bypass -File D:\dsh-assistant\android\build.ps1 -Flavor generic -VersionName 1.4.8 -VersionCode 35
# 可选：-Sdk D:\android-sdk  -Jdk "C:\Program Files\Eclipse Adoptium\jdk-17.0.17.10-hotspot"
```

- 路径全部由脚本自身位置推导（本目录就是工程根）；SDK/JDK 找不到会报中文错误并提示用 `-Sdk` / `-Jdk` 覆盖。
- 依赖：`D:\android-sdk`（platform 34 + build-tools 34.0.0）、JDK 17。**不再需要 Porcupine / TFLite AAR。**
- 产物：`out\个人助手-通用版-1.4.8.apk`，并自动复制到 `dist\`。
- `-Flavor personal` 仍保留在脚本里（预置助手地址、包名 `com.chenpan.assistant`），日常交付只用 `generic`。

## 核查这台设备里没有鹈鹕残留（1.4.4 的判据）

判据（构建前查源码、构建后查 APK）：

1. 源码：`Select-String '鹈|悬浮|切屏|ball|Ball|overlay|tihu|porcupine|tflite|wake|音量条|录音|波形'` 扫 `android/app/src/main/**` → 只剩 `MainActivity.java:70` 一行「已移除」的说明注释；`BallRules.java` 已不在目录里。
2. `aapt2 dump badging` → `versionCode='31' versionName='1.4.4'`；`aapt2 dump xmltree --file AndroidManifest.xml` → 只有一个 `activity`（`MainActivity`）+ 它的 `intent-filter` 与 `meta-data(shortcuts)`，**没有任何 Service、没有 `SYSTEM_ALERT_WINDOW` 悬浮窗权限**。
3. APK 条目清单（12 项）：`AndroidManifest.xml`、5 个 `res/mipmap-*/ic_launcher.png`、`res/xml/shortcuts.xml`、`resources.arsc`、`classes.dex`、`META-INF/ASSISTAN.{SF,RSA}` + `MANIFEST.MF` —— **没有 `lib/*.so`、没有 `assets/`、没有 drawable 球图标**。
4. `aapt2 dump resources` → 资源表只有 `color/accent`、`color/bg`、`mipmap/ic_launcher`、`string/app_name|shortcut_settings|shortcut_settings_long`、`style/AppTheme`、`xml/shortcuts`，没有 `drawable/…ball…`。
5. 解包扫描 `python android/out/verify-apk.py <apk> <report>` 对 `tihu / 鹈鹕 / 醍醐 / pelican / BallRules / screenBtn / buildScreenButton / moveBallTo / restoreBall / resetBallToDefault / updateScreenButton / refreshChrome / ball_x / ball_y / overlay / SYSTEM_ALERT_WINDOW / Wake / porcupine / tensorflowlite / tflite / wake_cnn / vosk / whisper / /asr / ensureTihu / switchScreen / tihuWeb / VolumeBar / RecorderButton / ToneFx` 命中 **0 次**（1.4.3 那一版命中 13 项，见下）。
6. `apksigner verify --print-certs` exit 0（同一把 `assistant.keystore`）。

> 1.4.3 的教训（用户实测「手机上还剩一个悬浮球」）：那次只改了 `updateScreenButton()` 里的文案，而 `buildScreenButton()` 造球时写死的字面标签（一个汉字符号）从没被那个改过的路径覆盖到——球照样带原标签出厂。判定「已删干净」不能只看改过的地方，得连「出厂第一份代码」也核一边：dex 里有没有 `screenBtn` / `BallRules` / `ball_x` 这些标识符、以及那个字面标签字符本身。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 白屏 / 连不上 | 电脑没开、DSH 没起、公网隧道断了；先用同一个 WiFi 的 `http://<电脑IP>:3081` 试。 |
| 页面里要麦克风却弹权限框 | 页面 `getUserMedia` 只在 https/localhost 才给；走公网 http 时浏览器不授权，需要电脑的 HTTPS 隧道。 |
| 地址填错想改 | 长按返回键 1 秒 → 改地址；或长按桌面图标「设置地址」。 |

## 目录

```
android/
  app/src/main/AndroidManifest.xml              权限、configChanges、resizeable、cleartext
  app/src/main/java/com/chenpan/assistant/
    MainActivity.java                           助手屏外壳（WebView / 设置页 / 返回菜单 / 生命周期）—— 无任何悬浮控件
  app/src/main/res/…                            图标、颜色、样式、快捷方式
  build.ps1                                     无 Gradle 构建（相对路径 + -Sdk/-Jdk）
  assistant.keystore                            签名密钥（必须沿用）
  dist/ out/                                    交付件 / 构建中间产物
```
