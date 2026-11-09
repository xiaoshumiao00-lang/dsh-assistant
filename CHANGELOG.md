# dsh-assistant 更新日志

发布源不再是写死的仓库：真值来自本机配置 `updateSource`（`owner/repo`，默认关闭检查更新）。
控制室里的「更新公告」正文由 `npm run build` 从本文件里当前版本那一节抽出来（见 `build.mjs`），
不再手写常量——改了代码就必须改这一节，公告与实现不会各说各话。

## 起点版（v0.2.17-qidian）

🎯 立项基线：鹈鹕（tihu）语音助理项目从这一版代码起步，版本号**仍是 0.2.17**，只另打 annotated tag `v0.2.17-qidian`

【为什么单独命名】「鹈鹕」要在这个仓库里新建 `src/tihu/`（同进程、不用不加载，复用会话/卡片/控制室/托管 turn-guard/记忆）。动手之前先把**当前这一版**钉成可回的锚点：以后任何一版行为回归，都能 `git checkout v0.2.17-qidian` 对照。版本号不动，是为了不惊动 `dsh.plugin.json` 的版本一致性校验、更新公告与已装用户——`build.mjs` 里那条「两处版本号必须相等」的硬挡照旧成立。

【本次唯一的功能改动：托管 turn-guard 1.1.0】补一步的配额口径从「整条会话累计补几次」改成「**同一个 turn 内**补几次」（默认仍是 3）：`[turn-guard]` 注入按所属 turn 归口，跨 turn、跨自然日自动重置。旧口径下，被定时任务每天复用的会话一旦累计补满 3 次就**永久静音**（2026-11-06 定时任务 turn 41 没被续跑就是这么来的）。同时每次 `agent/turn-stopping` 决策都写一行 `verdict turn=N steer=… branch=… injected=已补/上限 dayInjected=…`，把「被上限拦下」「预设不在名单」「开关关着」这些**不动作**的判定也记进日志，再出问题不用靠猜。会话里找不到 `turn/start` 边界（旧会话、单测夹具）时退回旧的整会话累计口径，判据本身一个字没改。回归 `scripts/test-turn-guard.mjs`，`lib/index.js` 由 `src/` 重新构建、与源码同一次提交。

【随版入库的取证】`reports/audit-20261106-dsh-assistant-优化与改进清单.md`：只读审计的增量结论（基线七项现状、上轮 7 项复核、36 条薄弱点、14 条建议）。只记录现象与证据，本轮不改其中任何一条。

【P0 鹈鹕（tihu）模拟设备链路】`/tihu`（同一台 pocket 代理、同一套 token/cookie 鉴权）→ 按住说话或选 WAV 文件 → 官方 speech 服务转写 → 作为普通用户消息注入当前会话 → 模型执行 → 屏（320×240）逐条显示进度、回复要点与 diff 摘要，并朗读。新增 `src/tihu/{protocol,guard,lane,page}.ts`：协议 v0（未知 type 忽略、字段只增不删）、三道闸（写前快照到 `.tihu/snapshots/`、`audit.jsonl` 审计、删除/覆盖/命令/外发先发 confirm.ask 且超时按取消）。不新开端口、不改 `package.json` 版本；回归 `scripts/test-tihu-protocol.mjs`（22 项）已进 `npm test`。真板子固件、Opus、本地 VITS 留给 P1。

## [0.2.18] - 2026-11-06

🐛 P0 上线后三处真问题：页面 WS 连不上、语音一用完电脑就不能干活、转写注入的是 `[object Object]`

【页面 WS 一直 401（每 2 秒重连）】页面拼 WS 地址时**不带任何凭据**，只指望 HttpOnly cookie；而浏览器里那枚 `dsh_pocket_token` 一旦缺失或过期，`?token=` 打开的页面照样 200（走 query 分支），WS 握手却永远 401，页面就变成每 2 秒一条「WebSocket 出错」。取证：同一台机器用真实 Chrome 打 `ws://49.234.20.84:7080/tihu/lane?token=…` → **101 + screen.frame/event.progress（108 ms）**；同一条链路不带凭据 → 立刻失败（1006）。修法：`laneUrl()` 把 token 带进握手 URL（URL 优先 → sessionStorage 次之 → 最后才是 cookie），token 存进 sessionStorage 供刷新后复用；代理侧 `maybeSeedAuthCookie` 改成「已有 cookie 但与当前 PIN 不匹配时也重种」，不再让一枚过期 cookie 永远修不回来。鉴权强度没变，还是同一个 PIN。

【语音用一次，电脑不能干活】`tools/pre-execute` 旧实现按**工具名**判危险：DSH 的 shell 只有一个工具名 `pwsh`，于是连 `Get-ChildItem` / `git status` 都算危险动作要设备确认，设备不在线就 60 秒超时 → 命令直接失败；再加上活跃窗口 15 分钟、且任何 `turn/start` 都会点亮窗口，用户自己打的命令也被卷进去。现在：①`isReadOnlyCommand()` 按命令原文判只读（ls/dir/Get-ChildItem/grep/Select-String/git status|diff|log|show、只读探测 curl…全部放行；删除/写入/重定向/提权/包安装/`git push`/跑脚本仍拦，拿不到命令原文时 fail closed）；②窗口 120 秒、只在 tihu 注入那一刻点亮，并用「会话最后一条 user 消息是不是刚注入的那条」核对归属——用户后来自己打的字立刻不受约束；③页面新增「结束本次语音会话」按钮（`session.end` 上行）立即清窗口；④设备不在线时危险动作**立即拒绝**，不再干等 60 秒。

【转写结果被 String() 成了 `[object Object]`】`speech.transcribe()` 返回的是 `Transcript{ text, audioSeconds, inferenceSeconds }`，旧代码直接 `String(result)`，于是每次语音注入进会话的都是字面量 `"[object Object]"`（实测日志 `chars=15`）。现在按官方入参 `{ audio, language }` 调用（保留 `audioBase64` 兼容）并归一化成纯文本；`transcript` 帧改成**先回再注入**，即使会话已关也能先看到「我听到的是什么」。

【验证】`scripts/test-tihu-protocol.mjs` 22 → 29 项（只读/危险命令矩阵、Transcript 对象归一化、闸门归属、`session.end` 立即失效）；新增 `scripts/tihu-voice-e2e.mjs` 真语音端到端自测（WAV → audio.frame → transcript → 注入 → 屏帧，打印转写文本与各段耗时）。本机实测：5.615 s 音频、SenseVoice int8 推理 160 ms，audio.frame → transcript 端到端 1.7 s。

【2026-11-07 追加：公网 origin 下「还没有会话」】`localStorage` 按 origin 隔离：用户在桌面宿主 `127.0.0.1:57440` 选过会话，打开公网 `http://49.234.20.84:7080/tihu` 时 `dsh.sessions.current` 根本不存在，旧页面据此直接报「还没有会话」。现在：①连上 lane 后没有会话就向宿主发 `sessions.query`，宿主复用 `ctx.sessionQuery`（手机会话列表同源）返回最近 N 条（在线优先、带标题），页面在屏下渲染选择器，点一条即 `session.bind`；②绑定结果只存**本 origin 自己的** `dsh.tihu.session`，下次自动记住；③`?session=<id>` 优先级最高、绑定后写回，宿主校验不存在时回 `session.invalid` 并给可读提示（不白屏、不绑死）；④兜底顺序 URL → `dsh.tihu.session` → 宽松读一次 `dsh.sessions.current` → 都没有就展示选择器、**不报错**；⑤文案改为「还没有选定会话，点下面选一个」，屏上常驻当前会话名，保留「结束本次语音会话」。协议新增上行 `sessions.query`/`session.bind`、下行 `sessions.list`/`session.bound`/`session.invalid`（字段只增不删）；上行改为按到达顺序串行处理，避免异步绑定校验期间紧跟的 `text.input` 被误丢。`scripts/test-tihu-protocol.mjs` 29 → 33 项。

【2026-11-07 追加：只绑 Computer Use 会话 + 默认自动跟随】鹈鹕要靠 GUI 看屏/点按，只有 Computer Use / 电脑操作模式的会话能接活。①**模式判定**：宿主投影 `agentPreset`（`sessionListMetadata` 同层的行，`init = header.agentPreset ?? null`，之后由 `agent-preset/selected` 更新；`dsh-agent-preset-registry` 注释明确「读投影不读 header」），值必须等于 `computer-use`；不靠标题猜。②选择器只列 CU 会话，非 CU 只在 `?session=` 显式指定时保留为灰色「当前（不可用）」行，且在屏上/卡片红色提示「无法看屏/点按」。③**默认自动绑定**：优先级 URL `?session=` → 上次手动记住的（校验仍存在且仍是 CU）→ 最近活跃的 CU 会话；活跃时间用宿主同口径 `updatedAt = max(header.createdAt, 投影 sessionListMetadata.lastPromptAt)`（最后一次用户发言时间）。④自动跟随：页面每次连上强制重列一次，注入前再判定一次（`session/event` 的 `user/message` 会即时刷新缓存活跃时间，避免每句话都全量列 1870 条）；目标变了就 `session.bound {auto:true, followed:true}` + 屏上「已自动跟随到：…」。⑤手动覆盖：选择器点选后不再漂移，出现「恢复自动」按钮；手动记忆失效/变非 CU 时按优先级回落到自动。⑥屏上常驻「当前会话：<名字>（自动/手动）」。`scripts/test-tihu-protocol.mjs` 33 → 39 项。

【2026-11-07 追加：页面上传 WAV 后没有转写回音（只改了一行：WS 分片重组）】真实公网页面（无痕 Chrome）上传 5.6s WAV：页面显示「已上行」，之后 30 秒无 transcript、无 screen.frame、无报错。用 `scripts/tihu-voice-e2e.mjs` 对同一公网入口跑同一段 WAV → **2.4 秒拿到 transcript 并注入成功**，说明 lane 的音频分支没问题，问题在页面发帧/宿主收帧。抓浏览器实际发出的 WS 帧发现：**Chrome 把 239,799 字节的 audio.frame 拆成了 FIN=0 起始帧(130,631B) + continuation 帧**；`WsFrameParser` 只认 opcode=1 单帧、忽略 continuation，于是第一片被当坏 JSON 静默丢弃 → 页面永远等不到回音。修法：`WsFrameParser` 实现 RFC 6455 §5.4 分片重组（起始帧 + continuation + 总大小上限），对整条 pocket 链路生效。另加三道兜底：①大帧解析失败/`audio.frame` 被拒时回 `event.alert(error)`，不再静默；②自动跟随后台化（5 秒上限）且单条上行 60 秒看门狗，任何一步卡住都不再堵死后续消息；③页面 15 秒无 transcript 报「转写超时」，WS 断开明确提示并 2 秒重连。`scripts/test-tihu-protocol.mjs` 39 → 41 项（含分片重组单测 + 分片 audio.frame 端到端）。实测（公网 + 真文件上传）：09:53:55「已上行」→ 09:53:56「已收到音频」→ 转写「对我做了介绍啊，那么我想说的是呢，大家如果对我的研究感兴趣呢。」→ 注入第 5 轮 → 屏帧「思考/模型处理中」，全程约 1–2 秒。

【2026-11-07 追加：朗读只念几句就没了】两处叠加：①`toTtsSegments()` 上限 4 段 × 80 字，**320 字以后直接丢弃**；②页面每收到一条 `tts.text` 就 `speechSynthesis.cancel()` 再 speak，多段几乎同时到达 → 只剩最后一段。现在：`toTtsSegments(text, perSegment=80)` **不限段数**、按句切完全部文本（无标点长句按 80 字硬切，不丢字），`index/total` 按完整数组下发；页面新增朗读队列 `createTtsQueue`（`src/tihu/tts-queue.ts`，同一份源码注入页面并单测）：顺序播放、段间 200ms、**收到新段不 cancel**；只有「新一轮回复 / 停止朗读 / 重读一遍」才清队列；`onend` 按文本长度 ×1.5+2s 兜底强制推进；队列上限 200 段。「重读一遍」改为重播本轮全文（拼接缓存），新增「停止朗读」按钮（立即 cancel + 清队列 + 事件区记「已停止朗读」）。`scripts/test-tihu-protocol.mjs` 41 → 47 项。

【2026-11-07 追加：屏幕帧「有料」执行面板 + 真机 320×240 视窗】旧屏幕只有「动手 / code_agent / 正在执行…」。新增纯函数 `src/tihu/progress.ts`：把 `session/event` 映射成 stage（思考/读文件/跑命令/写文件/搜索/回答/等待确认）+「动词+目标」标题（Read→读取 <文件>、Write→写入、Edit→修改、Grep→搜索、pwsh→执行 <命令前 30 字>、WebFetch/web_search→联网查；其它工具显示工具名＋`arguments` 主键）+ 3 行正文（`第 N 步 · 已用 12s` / `✓|✗ 上一步摘要` / 输出尾行），全部按码点截断（标题 28、正文 18），失败 tone=alert；`turn/end` 保留「完成 · 共 N 步 · 用时 Xs」最终帧。事件区每次 tool/call 与 tool/result 各一行（参数/结果截 120 字）。同时把屏幕区改成**真机视窗**：新增 `src/tihu/screen-spec.ts`（宽 320/高 240/边距 8/正文 16px·行高 20·每行 18 字·最多 3 行/标题 18 加粗 28 字/stage 12px；物理 61×45.7mm 近似），页面按它渲染固定 320×240 屏 + BOX-3B 外壳（麦克风孔/扬声器格栅/dock 投影），提供 1×/2×（默认）/实际尺寸三档与「显示外壳/仅屏幕」开关；仅屏幕模式保留 1px 精确边界。`scripts/test-tihu-protocol.mjs` 47 → 53 项。

【2026-11-07 追加：完成帧收尾三处小瑕疵】①`turn/end` 帧的正文第一行曾重复标题「共 N 步 · 用时 Xs」，且第 3 行挂着上一轮命令的 stdout 尾行；现在完成帧只保留「结果」一行（正常 → `✓ 已生成回复`，失败 → `✗ 失败原因`），不再重复标题、不再带陈旧输出。②`event.done` 的 `ok` 只认 `reason.kind === 'stop'`，实测 `completed` 被下发 `ok:false`；现在 `completed` / `stop` 归一为 `ok:true` 且文案「本轮完成」，`error/aborted/cancelled` 才 false。③`turn/end` 的 tone 跟随结果：正常 ok、失败 alert；`sessionId` 保持不变。`scripts/test-tihu-protocol.mjs` 53 → 54 项（新增 done.ok/tone 的 completed/error 对照）。实测短任务完成帧：`完成 · 共 2 步 · 用时 7s` + 唯一正文行 `✓ 已生成回复`。

【2026-11-07 追加：默认切 edge 云健 + 仅离线开关 + AR 循环诊断】默认链路按体验重排为 **edge-tts 云健（在线）→ Qwen3-TTS GPU（克隆音色/仅离线）→ SAPI**：默认不预加载 GPU，选克隆音色或开 `tihu.offlineOnly` 才拉起 Qwen；页面新增「仅离线」复选框（localStorage `tihu.offlineOnly`，禁 edge），`voice.select` 带 `offlineOnly`，事件标识仍为「在线兜底：edge-tts 云健(Yunjian)」/「本地 TTS：qwen3-tts 0.6b-cuda」/「离线兜底：Windows SAPI Huihui」。实测：默认 edge 首块 1.96s、音频 2.47s；仅离线 + GPU 强制失败 → SAPI 246ms 出声；克隆音色自动走 Qwen。AR 诊断：talker 已用 KV cache（每步 `input_ids` 长度 1、past 28），GPU kernel 总时长仅 0.58s，墙钟 4.3s 中约 3.7s 是 Python 逐 token 采样/调度开销，decode 0.12s；bf16 RTF 1.5、fp32+TF32 1.32，未达 0.3，需改采样实现或 vLLM 类 runtime。单测 61 项。

【2026-11-07 追加：GPU 瓶颈定位 + edge-tts 云健走 Clash 代理打通】GPU 诊断：`Qwen3TTSModel` 的 `talker`、`speaker_encoder`、`speech_tokenizer.model` 全部已在 `cuda:0`（codec 不在 CPU）；单句拆时 decode 仅 **0.12s**，AR talker **4.49s**（总 4.6s/2.88s 音频）——瓶颈是逐 token 采样/编排，不是 codec 或显存换页；bf16 RTF 1.5，fp32+TF32 中句 1.32 但短句更慢（5.2s），均达不到 0.3。edge-tts：本机 Clash Verge 混合端口实际是 **7897**（7890 未监听），`edge_tts.Communicate(proxy='http://127.0.0.1:7897')` 后云健正常出声；`scripts/tihu-edge-tts.py` 默认代理 `TIHU_EDGE_PROXY=http://127.0.0.1:7897`，流式 MP3→ffmpeg→24k PCM，实测首块 **1.93s**、总 2.19s、音频 2.47s；首块预算放宽到 3.5s（1.5s 内 Python 启动+握手来不及），代理失败/403 仍立即切 SAPI（实测 240ms 首包）。页面兜底音色下拉已接；单测 61 项全绿。
【2026-11-07 追加：TTS 降级链精简为 GPU → SAPI 两级】按用户要求删掉 PyTorch CPU fp32 自动降级与浏览器 `speechSynthesis`：`page.ts` 移除 `TTS_QUEUE_SOURCE`/`createTtsQueue`/`SpeechSynthesisUtterance`/兜底计时，只保留 WebAudio PCM 播放；`src/tihu/tts-queue.ts` 删除。默认引擎改为 Qwen3-TTS 0.6B GPU（PyTorch，`device=cuda`，dtype 实际 bf16——fp16 在 `torch.multinomial` 触发 device-side assert），显存 <2GB / CUDA 不可用 / 加载失败时 Python sidecar 以 exit 3 退出，Node 直接切 Windows SAPI（不再跑 CPU），并发 `event.alert`「GPU 不可用，已切换 Windows SAPI」；SAPI 也失败 → `event.alert(error)`「所有本地 TTS 均不可用，本条只显示文字」，reply 正文保留。引擎标识：`本地 TTS：qwen3-tts 0.6b-cuda / 音色 xxx` 或 `本地 TTS：Windows SAPI / 音色 默认`。Q4 的 `~/.dsh/tihu/bin` 产物保留但标注弃用，仅 `TIHU_TTS_ENGINE=q4` 启用；CPU 调试仅 `TIHU_TTS_ENGINE=cpu`。单测删除 queue 用例，新增「GPU 不可用→SAPI」「SAPI 失败→alert+正文」两条，共 61 项；实测强制 `TIHU_TTS_FORCE_NO_CUDA=1`：首包 337ms、音频 3.5s，走 SAPI；默认 GPU 实测首包 ~4.3s、页面 143 块/17.1s、speech 调用 0。
【2026-11-07 追加：WSL 编译 Q4 tts-server（实测比 PyTorch 慢，默认未切换）】在 WSL2 Ubuntu（GCC 13.3、cmake 3.28）用 g++ 编出 codec.cpp + ggml/llama.cpp 的 `tts-server`（3.5MB，依赖 libttsbackbone/libggml*.so 共 12MB，装到 `~/.dsh/tihu/bin/`）；配置时跳过重复 patch（源码已打过 7 个 patch）。权重：`~/.dsh/tihu/models/qwen3-tts-0.6b-q4_k_m.gguf`（396.7MB）+ `codec-q4_k_m.gguf`（1.286GB，hf-mirror 断点续传完成）。用 `tts-cli --save-speaker` 从 8s 参考生成默认音色 `voices-server/default.gguf`（11KB），server 用 `--speaker-file` 可零参考出声。**实测（4 线程）**：短 8 字首包 ~2.1s、总 9.4s、音频 2.32s、RTF 4.1；中 35 字总 54.8s、音频 8.08s、RTF 6.8；长 86 字超过 60s 未结束（EOS 不稳，需 sampling 参数与 max-frames 兜底）。WSL 进程 RSS 约 3.2GB。对比 PyTorch fp32（RTF 1.94）Q4 反而慢 2–3 倍，克隆音色在 Q4 下 60s 未出声；因此**默认引擎仍保持 PyTorch**，Q4 通过 `TIHU_TTS_ENGINE=q4` 显式启用（sidecar 支持 Windows ELF 直跑与 `wsl -d Ubuntu -- env LD_LIBRARY_PATH=... tts-server ...`，启动前健康检查、日志 `~/.dsh/tihu/tts-server.log`）。页面事件会按后端显示 `qwen3-tts 0.6b-q4` / `qwen3-tts 0.6b-pt`。`scripts/test-tihu-protocol.mjs` 62 项全绿。
按用户决策放弃 WSL/GGUF 路线，改用官方 `qwen-tts` PyPI 包 + `Qwen3-TTS-12Hz-0.6B-Base` 权重（ModelScope 下载，`~/.dsh/tihu/models/qwen3-tts-0.6b-pt`，1.74GB + speech tokenizer 650MB）。新增 `scripts/tihu-qwen-tts-server.py`：独立 Python 进程、只绑 127.0.0.1、强制 CPU（`device_map="cpu"`、fp32、sdpa、8 线程、`inference_mode` + `set_flush_denormal`），实现 `/health`、`/v1/audio/voices`（multipart → `.embed.pt` 落盘，第二次命中缓存）、`/v1/audio/speech`（24k pcm16 分块流）；默认音色用 SAPI 生成的 8s 参考音频建 embedding，无需每次上传参考。`src/tihu/tts.ts` 后端优先级 qwen-pt > codec > sapi，sidecar 日志落 `~/.dsh/tihu/tts-server.log`；`tts.audio` 仍按 120ms 块流式下发，首块在整句合成完返回后立即发出。为降低长句首包，`reply.ts` 新增 `splitSpeechSegments()`：先按句、再按逗号/32 字切语音片段（显示高亮仍按原句），实测长回复 81 块/9.7s 全部由本地 PCM 播放、系统语音 0 次。**性能实测（i7-14700KF、8 线程、fp32/sdpa、实际 sidecar）**：短 8 字首包 4.6s、RTF 2.0；中 35 字 16.0s、RTF 1.94；长 86 字 38.3s、RTF 1.94；进程 RSS 6.5GB。目标首包 ≤2s 未达到；bf16 更慢，torchao int8 weight-only 26s（更慢），int8 dynamic 因自定义模型不可深拷贝失败。可调项：线程 4/6/8/16、语音片段 16–32 字、`TIHU_QWEN_*` 路径覆盖。SAPI 仍保留为降级路径（“不支持克隆”提示不变）。`scripts/test-tihu-protocol.mjs` 61 → 62 项。
【2026-11-07 追加：本地 TTS（P1 第一块）+ 回复正文跟随朗读】目标是 Qwen3-TTS-12Hz-0.6B GGUF Q4 纯 CPU sidecar 替换 speechSynthesis。已落地：①`src/tihu/tts.ts` 独立进程 sidecar（`tts-server` 只绑 127.0.0.1、4 线程、120ms 流式块、8s 首块超时），模型/二进制放 `~/.dsh/tihu/`，缺失时状态可读；②协议新增 `tts.audio`（24k pcm16、`seq/total/index/charStart/charEnd/final`）与 `voice.list|create|select`，保留 `tts.text`；③页面 WebAudio 24k 无缝排队播放（120ms 块），与「停止朗读/重读一遍/新一轮清空」共用一套逻辑；无音频时 4s 兜底 speechSynthesis，宿主失败会发 `event.alert` 并立即降级；④音色目录 `<workspace>/.tihu/voices/<name>.wav|.json`，参考音频 3–10 秒/16k/24k 校验、embedding 由 sidecar 持久化（第二次命中缓存），上传界面带授权合规提示；⑤`src/tihu/audio.ts` 纯函数 PCM 分块/重采样/WAV 校验，单测覆盖块边界、任意 TCP 分片、参考音频。**现实阻塞**：codec.cpp 在 MSVC 下编译失败（`lm_internal.h` 语法、`M_PI` 未定义等 GCC 专属写法），llama.cpp/codec.cpp 已下载但无法产出 `tts-server.exe`；因此运行时自动回退 **Windows SAPI（Huihui zh-CN）** 作为本地占位引擎，页面真机链路已验证（PCM 182 块/21.7s，`speechSynthesis` 0 次）。Qwen 模型只下载了 backbone（396MB），codec（1.29GB）未拉完。⑥屏幕新增 `reply` 模式：`src/tihu/reply.ts` 分句/字符区间/窗口（每行 18 字、可视 10 行、当前句居中反色），`screen-spec.ts` 增加 `replyVisibleLines: 10`；`tts.text/audio` 带 `charStart/charEnd`，本地音频逐句推进高亮，降级时按 4.5 字/秒估算；思考/工具切回 status，turn 结束保持正文最后一屏。实测长回复：reply 模式 10 行、高亮随朗读推进、最终停在最后一句。`scripts/test-tihu-protocol.mjs` 54 → 61 项。

【2026-11-09 统一指挥会话（设计→代码正式落地）】按 `docs/鹈鹕统一指挥会话-架构设计-20261109.md` 把「设备只绑一条指挥会话 ＋ 任务登记簿」做完，**不改协议版本、不加新端口、不动鉴权**。①**登记簿**新增 `src/tihu/task-ledger.ts`（纯逻辑、可注入时钟）：状态机 `排队→执行中→待决策→完成→归档`、棋盘投影（排序固定「待决策→执行中→排队→完成」、同一项目**连续**多条折叠成「+N 条」、时长环满圈 30 分钟超时转琥珀、完成满环、排队空环）、通知总线（P0 插队立刻念／P1·P2 八秒窗口合并成一句／P3 只上屏不念）、派单快路径规则表（点名卡 → 接着说的追加 → 日常小事 → 歧义追问 → 放弃交给慢路径）、口头命令解析（回棋盘/看任务/停止/撤单/确认/拒绝/「第 N 条」）、归档只写一行 journal（自动归档也落，不悄悄丢）。②**屏**新增 `src/tihu/task-screens.ts`：屏 1 任务棋盘（含空态，不另开一屏）、屏 2 派单回执（三拍圆点＋文件夹＋5 秒倒计时＋看任务/撤单）、屏 4 任务详情（标题「第 N 步 · 已用 1m23s」，正文照 `progress.ts` 的 statusFrame 不翻译）、屏 5 待决策（`待决策 · 托管未开`＋电脑端同一个问题、默认项打「·默认」、60 秒倒计时）、屏 6 完成（`另有 N 条`收进状态行）、屏 7 歧义追问（数字序号＋都不是）。③**lane**：设备默认绑唯一指挥会话（按标题「鹈鹕指挥台」找回同一条，找不到才建；`?session=` 与 `auto:true` 保留为逃生口），`autoFollow` 对统一设备失效；说话走派单器——点名卡落 `projects.folders[card]`、日常小事落助手 home（与长按悬浮球一致）、「接着」追加不新建、两卡都点到就追问；新复杂任务调 `dispatchProjectCard()` 建卡并双写 `dsh-assistant-state.json`（克隆既有布局保证控制室能渲染）；完成由**任务**驱动：屏 6 ＋ 一句播报（八秒合并，播报只念标题不念会话 id）；危险动作落成屏 5 待决策（P0 打断当前朗读），`deviceOnlineFor()` 补上「统一指挥设备可替任何任务确认」，否则 P0 档会被误判离线直接拒；`task.reply` 上游接住屏上点选项/口头确认/自由文本（自由文本＝不执行原动作、把话送回任务会话）；`tap hit=task` 看任务详情不换绑定。④**控制面**新增三个 action：`dispatch`（指挥会话唯一的动手方式，带 text/target/title）、`list_tasks`、`cancel`（第 13–15 个）；工具描述与系统提示段落改为「听到的任务一律 dispatch，别自己动手」。⑤**协议**仅增：上行 `task.reply`，下行 `task.list`/`task.update`/`task.notify`；`screen.frame` 增可选 `board`/`steps`/`countdown`/`more`/`taskId`（必填仍是 stage/title/bullets 三个）。⑥**页面**（`src/tihu/page.ts`）：任务棋盘渲染（胶囊写文字、环用 conic-gradient、待决策给琥珀问号、空态波形）、回执三拍圆点与倒计时条、「免按住」开关（浏览器 SpeechRecognition 关键词「你好，鹈鹕」→ 屏 3「在听 · 已唤醒」→ 末字后静音 3 秒自动发送、10 秒没说话退出、播报中叫醒先掐本地音频；真机仍走固件本地唤醒）。⑦**播报预录**新增 `src/tihu/preroll.ts`（`~/.dsh/tihu/preroll/`，键＝音色＋文本、只缓存单句、条数 120 ＋ 总字节 8MB 双上限、命中直接发裸 PCM 不合成），已接进 `speakAnnouncement`；⑧**快路径判定顺序修正**：片段命中项目卡（≥3 字）排到「日常小事」前面——实测 `青年基金第 4 段逻辑理顺` 只有 12 字、没有产出动词，会被判成日常小事扔进助手文件夹；⑨**验证**：`scripts/test-tihu-protocol.mjs` 201 → 213 项（统一指挥 12 条，含待决策走通 broker、§13「10 句同项目零错派」、预录命中不再合成），新增 `scripts/test-tihu-task-ledger.mjs` 44 项（登记簿/棋盘/播报/路由/屏版式）、`scripts/test-tihu-preroll.mjs` 12 项（键/命中/上限/容错），都已进 `npm test`；`npm run build`、`npm test` 全绿；`npm run typecheck` 471 → 482（新增 11 条全是 TS2591「仓库缺 @types/node」类结构性噪音，其中 8 条来自新文件 `preroll.ts`，无逻辑型新错误）、`npm run lint`（3 条既有问题，无新增）照旧。仍待用户拍板三件：P0 决策播报是否打断朗读（现按「打断」实现）、指挥会话能否自答简单问题（现一律派单）、任务完成是否自动「收工蒸馏」进 journal（现只在撤单/归档时写一行）。

【2026-11-09 追加：默认入口真正进棋盘】上一节落地后，浏览器打开 `http://127.0.0.1:3081/tihu?token=…` 仍停在旧会话屏：页面握手只会发 `hello{auto:true}`（没记住会话时）或 `hello{sessionId}`（记住过会话时），lane 把这两种都判成逃生口（`device.unified=false`）；而默认统一指挥分支要求「既无 sessionId 也无 auto」的**裸 hello**，浏览器页永远发不出来。现在 `src/tihu/page.ts` 默认只发裸 hello（`pickInitialSession()` 不再读 localStorage 里记的旧会话），统一指挥绑定后**重连也只发裸 hello**、不回传上次的指挥会话 id（新增客户端状态 `state.bindIntent`，只用来区分「这次绑定是统一指挥还是手动」，不新增任何协议字段）；`?session=` 仍是一次有效的手动逃生口，`session.bind{auto:true}`（「恢复自动」按钮、手动会话失效回落）仍走老的自动跟随；指挥会话是 standard 模式，会话列表刷新不再把它判成「非 CU」并打回自动。`lib/pocket.js` 由 `src/` 同一次重建；`scripts/test-tihu-protocol.mjs` 213/213、`test-tihu-task-ledger.mjs` 44、`test-tihu-preroll.mjs` 12 全绿，`npm run check` 通过，`npm run lint` 仍是既有那 3 条（与本次无关）。

【2026-11-09 再修：指挥会话建不出来，默认入口退回项目卡片】线上 `…/tihu?token=…` 打开仍是项目卡片列表。根因在 `createSessionAt()`：先找 `ctx.get('remote')`——那是**客户端**网关服务（`dsh-api-gateway/lib/client.js` 的 `super(ctx,'remote')`），宿主 ctx 里没有；再退回 `sessions.create(base)` 也错，`SessionStore.create(id, options)` 第一个参数是会话 id、返回 Session 而非 id。两条都失败 → 指挥会话建不出 → 裸 hello 走 `unified=false` 兜底，屏上就是旧项目列表。测试一直预置「鹈鹕指挥台」并断言 `created.length===0`，创建分支零覆盖，所以 213 项全绿也没发现。现在：①主路改 `ctx.get('sessionController').create({cwd, agentPreset})`（Typert 暴露成 `ctx.remote.session` 的宿主本体，返回 `{sessionId}`），`remote.session.create` 只作老宿主兼容；②建完清 `sessionListCache`，否则 `findSession` 把刚建的会话判 missing、`bindSession` 立刻回 `session.invalid`；③新建后立刻用 `sessionController.rename` 写标题「鹈鹕指挥台」，下次 hello 才找得回同一条；④建不出来也不再退回项目卡片，而是**空棋盘 + `event.alert` 诊断**（`sessionController/remote/sessions/agents` 的 missing/ok 写进 tihu 日志）；⑤空盘顶行三段计数**始终显示**（含三个 0，不再因为 0 就省掉，和设计 §8「顶行三段计数归零」一致）；⑥补两条测试：「没有指挥会话时 hello 自动建并进空棋盘」「建不出也进空棋盘、不退回项目卡片」，另把老的「点项目行」用例改成 `?session=` 手动绑定（项目卡片只属于逃生口）。协议零新增、屏内「思考 ·」行未动；`test-tihu-protocol` 215、`task-ledger` 44、`preroll` 12 全绿。

## [0.2.17] - 2026-11-06

📺 平板 / 电视（宽屏、矮视口）专项：控制室卡片不再挤成 4 列被裁，抽屉里点得到会话

【背景】在 960×540 CSS 视口（10.9 吋平板 dpr 2、电视同样）实测：控制室卡片一屏只摆 4 张、第二行被屏幕下边缘裁掉；抽屉里的会话列表可视高度只剩 156 px，整屏只有 1 行会话是真正可点的，其余被裁或与底部账号行重叠——手指点下去命中的是 `BUTTON.triggerRow`，表现就是「点会话没反应」。

【控制室卡片】列数改按**滚动容器**宽度计算（上限 5 → 6），断开「列数 → max-width → 列数」的反馈环；卡片宽度由 JS 量出后写 `--wt-cardW`，不再依赖 `calc(100% / var(--wt-cols))`（旧 WebView 不支持「除以 var()」，算出非法值后卡片退化成内容宽度，这就是一屏 4 张的真因）。间距与顶部留白改 `clamp()`。桌面窗口的最小卡宽给到 210 px（矮屏 160 px、手机 168 px —— 手机端固定 2 列，卡片不会被拉成一整条），卡片不会瘦成一条、名字被截断；卡片高度用 `min-height:258px` 兜底，保证「会话列表」那一行永远完整——之前 1:1 的 aspect-ratio 会把高度压到宽度，1280 宽窗口里卡片只剩 190 px 高，内容被裁。实测 1280×800 → 5 列 227×258、两行 618 px 全部可见；1920×1080 → 6 列 280×280；960×540 → 5 列 174×189（走矮屏断点）；390×844 手机仍是 2 列，与改动前一致。

【抽屉紧凑模式】`max-height:660px` 且窄屏时，抽屉内按钮行压到 30 px、图标 15 px、会话行 28 px（品牌行排除，避免压坏 wordmark），把高度还给会话列表。复测 960×540：完全可点的会话行 1 → 3，点一行后 `dsh.sessions.current` 正常切换、正文出现。

【没做的】「载出会话很慢」不是这两个改动能解决的：实测插件空闲流量只有 22 KB / 45 s（0.5 KB/s），重量来自宿主每次打开都要重传 594 KB 会话列表（本机 2,627 条）与公网隧道本身。索引降频试过 250 ms 节流，但 `test-session-index.mjs` 明确要求「新快照必须立即重建」，会破坏契约，已回退。取证数据见 `reports/宽屏弱设备-取证-20261106.md`，设备上怎么验见 `docs/平板电视-验证清单.md`。

## [0.2.16] - 2026-11-05

🧩 换一台机器/换一个人：不用改源码、不用手写 JSON，只在「设置 → 个人助手 → 本机配置」填几项

【背景】上一轮审计（`docs/本机配置可移植性审计-20261105.md`）逐条列出了「换机就会错」的硬编码。本轮落地 P0 八项，目标是别人在干净机器上装完，只在设置里填几项就能正常用。

【P0-1 写入链路】`POST /api/assistant/config` 真的存在了：以前那个 handler 不看 `req.method`，POST 也会 200 下发查询结果（改动被静默丢弃，最坏的失败方式）。现在 GET/POST/PUT/405 四路分明，字段白名单（`newProjectParent` / `skillRoot` / `asrTerms` / `allowedRoots` / `allowAllLocalPaths` / `persona` / `termEnvAllow` / `updateSource` / `updateCheckEnabled`）+ 逐字段类型校验（未知字段 400 `unknown-field`、路径必须绝对、开关必须布尔）+ 原子写（`<file>.<pid>.tmp` → rename，0o600）+ 写后清读缓存。未管理的键原样保留；已存在的坏 JSON 拒绝覆盖。`allowAllLocalPaths: true` 需要 `confirm:"ALLOW-ALL"`（与 memory-clear 同一种确认）。客户端 `saveAssistantConfig()` 保存后**强制回读**，`reloadAssistantConfig()` 不再是死代码。回归：`scripts/test-assistant-config-write.mjs`（11 项），已进 `npm test`。

【P0-2 设置页】新增「🧩 本机配置」tab，三个分组 + 一个更新分组：目录与路径（`newProjectParent` / `skillRoot`，复用 `PathBrowser` 目录选择器，并显示「当前实际生效值」及来源）、语音词表（`asrTerms` 增删行 / flags / 导入导出 JSON）、目录边界（`allowedRoots` 列表 + `allowAllLocalPaths` 开关，打开时红字警告并要求输入 `ALLOW-ALL`）。同时修掉技能根两处回落不一致（客户端曾拼未展开的 `~/.dsh/skills`，现在只认宿主下发的绝对路径）。

【P0-3 更新源】`updateCheck.ts` 不再写死 `xiaoshumiao00-lang/dsh-assistant`：改成读本机配置 `updateSource` + `updateCheckEnabled`，**默认关闭**（没配就完全不发网络请求，返回 `disabled`）。升级命令、Releases 入口都按本机配置拼，没配时给出「去哪配」的提示而不是指向作者的构建。

【P0-4 SSH 隧道六字段】`host / port / user / remotePort / keyPath / localPort` 现在能在「手机访问 → 固定公网地址 → 编辑连接」里改（RPC `sshTunnel.setConfig`），私钥用文件选择器；不再需要手写 `settings.json`。默认值去掉 `user: 'root'`（改为空 = 必须自己填，少一项就不连），注释里的作者 VPS IP / 私钥路径也清掉了。

【P0-5 保存即生效】目录 allowlist 不再是 apply 时的一次性快照：`path-guard.check()` 每次请求重读本机配置，保存 `allowedRoots` / `allowAllLocalPaths` 后立即生效（另提供 `assistantPathGuard.refresh()` 服务）。`persona` 不再"只写一次"：`syncPersonaSection()` 会在 `<!-- dsh-assistant:persona -->` 之间替换，配置清空则整段移除；用户手写的 AGENTS.md 仍然一个字不动。

【P0-6 摘掉宿主补丁脚本】`scripts/apply-desktop-host-auth-cookie-fix.ps1`（写死作者机器 `D:\DSH Desktop\resources\app.asar` 与某次构建的 SHA-256，会对 `app.asar` 做 monkey patch）已移出仓库到 `.author-local/`（已 gitignore），说明见 `docs/作者本地脚本.md`。随包分发不再包含任何"动宿主安装目录"的脚本。

【P0-7 koffi 懒加载】`src/desktop-focus.ts` 顶层 `import koffi` 改成 `createRequire` 懒加载：非 Windows、原生模块没装好、ABI 不匹配时**只让「前台窗口聚焦」这一项不可用**，插件其余功能照常启动（以前会整插件 import 失败）。新增 `GET /api/assistant/capabilities`，设置页「本机配置」显示这一项是否可用及原因。

【P0-8 打包与文档】README 新增「给其他人装（第三方用户看这一节）」：Node ≥ 22、koffi 原生模块（装不上只降级一项）、peerDependencies（全部 optional）、GPL-2.0 说明、安装命令、装完要填的几项设置。`package.json` 的 `files` 确认只含 `lib/*`、`cordis.patch.yml`、`dsh.plugin.json`、`README.md`、`LICENSE`、`NOTICE`、`vendor/`——不含 `docs/`、`scripts/`、`.author-local/`。

【手机端·进会话不弹输入法】宿主的输入框在挂载/切会话时会主动抢焦点（`dsh-client-ui-conversation` 的 InputBar：`useEffect(..., [locked, sessionId, editor]) → focusDraftEditor()`），桌面端这样是对的，但安卓 WebView 里 DOM focus 一落到 contenteditable 就 `showSoftInput` —— 手机端点进任何会话，第一秒都被键盘糊住。新增 `src/client/pocket/mobile/composerFocusGate.ts`：只在手机布局下把「不是用户点进输入区」的那类程序化聚焦挡在门口，判据是「这次聚焦前 1.2 s 内，用户的 pointerdown 是否落在 `[data-conversation-region="composer"]` 里」。点侧栏会话行 / 悬浮球 / 控制台卡片进来的，不弹键盘；点输入框（含卡片空白、发送钮、命令菜单）照常弹；正在打字时编辑器本来就有焦点，拦与不拦没有差别。只挡宿主那一个 `[data-composer-input]`，插件自己的 textarea（`data-pocket-orb`）、文件选择框、搜索框、重命名框一律不动。真机证据走诊断信标（`~/.dsh/dsh-pocket/diagnostic.jsonl` 里的 `mobile-stage`，`stage=composer-focus-blocked`）。回归 `scripts/test-composer-focus-gate.mjs`（用假 DOM 直接验「挡 / 放行 / 卸载还原」）已进 `npm test`。纯客户端改动，手机整页刷新即生效（宿主按 mtime 重组 bundle 表）；万一还是老行为，重启一次 DSH Desktop 再刷新页面即可。

【注意】宿主侧改动（新路由、koffi 加载方式、allowlist 生效方式）**要重启一次 DSH Desktop**；设置页与面板属于客户端，刷新页面即生效。

## [0.2.15] - 2026-11-05

🔁 Computer Use ↔ 标准模式真正互通：后台任务遇到桌面操作会把这一步交回前台

【问题】CU 会话用 `code_agent` 把文件/搜索/写文档这类活交给标准模式的后台会话后，后台会话**没有屏幕、也没有 GUI 工具**。任务一旦走到「打开微信」「在原生对话框里选个文件」「读一个只有窗口里才看得到的值」，它只能拿标准工具硬猜（反复 shell、瞎试路径、写 SendKeys 脚本），而其实前台 CU 会话点两下就完了。

【现在】`code_agent` 新建/继续后台标准会话时，往**这个后台 agent 自己的工具作用域**里装一个 `computer_use` 工具（`src/cu-bridge.mjs` + `src/cu-bridge-core.mjs`，只由 code-agent 调用，`agent.ctx` 作用域随 agent 一起卸载）：后台把「一具体 GUI 步骤 + 要带回什么」交回启动它的 CU 会话，前台做完后用一两句话回结果，后台拿结果继续。工具是**同步等待**的——调用期间后台保持 running，`code_agent` 的完成通知不会在 GUI 步骤做完前误触发；同一 CU 会话的多个请求**串行**排队，不会两条 notice 交错、各自读到对方的结果。等不到前台（会话已关 / 一直没开始 / 超时 / 后台被停）都会给一段明确的失败结果，让后台继续用现有工具或把桌面步骤写成清单，而不是无限重试。单次回传次数有上限（20）防止来回打转。

【提示词】后台角色文本（`BACKGROUND_ROLE`）明确：遇到可见桌面步骤就调 `computer_use`，不要用 shell/SendKeys/UI Automation 硬顶；`code_agent` 的 description 告诉 CU 前台「后台可能把一步 GUI 交回来，收到 notice 就在本会话做完并回具体结果」；CU 预设 persona 同步加了这条处理规则。回传只走文字，截图留在前台，后台模型不需要视觉能力。

【回归】新增 `scripts/test-cu-bridge.mjs`（15 项：请求文本、按事件只取 notice 之后的第一条 assistant（用户插话也不串）、同一前台串行顺序、找不到前台 / 没开始 / 排队被清空 / 超时 / 取消 / 次数上限、registry 归属优先于创建时父会话），已进 `npm test`。宿主侧改动**要重启一次 DSH Desktop** 才生效；CU 预设 persona 只对新会话生效（现有 CU 会话仍能收到回传，只是少了这条处理提示）。

## [0.2.14] - 2026-11-02

✅ 托管真正「无人值守」：提问 / 审批不再需要把会话点开

【问题】托管开着，但遇到要决策的提问 / 审批仍然卡住，必须点进那张会话卡片才会自动通过，否则一直等。根因是自动应答挂在**客户端** `conversation.composer` 链上（priority −5）：只有那个会话被打开、composer 真的渲染出来，`pendingInteraction` 才会被 settle。会话留在控制室列表里、手机没连、电脑开着别的会话时，请求虽然已经转发到浏览器，却挂在一个没人渲染的卡片上——所以「托管开了」和「自动通过」之间差了一次点击。

【现在】决策应答搬到宿主（`src/tuoguan-autoanswer.ts`）：宿主直接监听 `approval/request` 与 `user-questions/request` 两道 waterfall，托管开着就现场作答——审批 `allowed-once`（与卡片主按钮同一个结果）、plan-review 选 `intent.approve` 指定的批准项、其余提问选首选项、没有选项回一段自由文本。监听用 `{ prepend: true }` 注册，**抢在 `@deepseek-ai/dsh-api-remotes` 把请求转发给浏览器之前**作答，所以浏览器连不连、会话开不开、是不是只留在控制室列表里，都不影响结果。

【不越界】关掉托管的会话一句 `next()` 原样放行，官方审批卡 / 提问卡照旧由客户端渲染；读不到托管状态一律按「不托管」处理（绝不猜着放行）；缺 id、没有会话身份的请求也交回人工。子代理的审批跟随父会话的开关（沿 `header.parentSession` 往上找最近的显式设置），普通 fork（`delegationDepth` 为 0）不继承，免得「从 A 复制出来的 B」跟着 A 走。客户端那条旧链保留，作为没重启宿主的兜底。

【回归】新增 `scripts/test-tuoguan-autoanswer.mjs`（14 项：托管开关链式判定、子代理继承 vs fork 不继承、审批作答与放行、读状态失败、没有会话身份、提问首选项 / plan-review / 无选项 / 缺 id、安装器 `prepend` 真的排在转发监听之前且卸载摘干净），已进 `npm test`。**宿主改动要重启一次 DSH Desktop 才生效。**

### 手机端流畅度·多会话同时运行（2026-11-03）

【卡片状态判定不再每次全扫】`src/client/sessionFactCache.ts` + `src/client/index.tsx`：控制室每一刷（实测约 6.7 次/秒）原来都把「项目关联会话 + 全部游离会话」（本机 1,115 条）各判一边 `在跑 / 等决策 / 完成 / 异常`，每一判都可能读一次会话面快照——手机 WebView 上那就是主线程。现在这四条判定走同一份**跨刷新的事实缓存**：判定本体一字未改，只按「判定输入签名」决定要不要重算——`updatedAt / running / completed / blank / pendingInteraction / 待决 / 本地异常标记 / 子代理计数` 任一变了就立刻重算；没变就按分层节奏取（在跑 800 ms、最近活动过 1 分钟内 800 ms、10 分钟内 6 s、更冷 45 s），并且**任何一条判定说「它在跑」就自动升到热档**（走会话面兜底的那种在跑不会因缓存退化成 45 s）。活动扫描那一挡同样缓存（独立键、不看子代理，口径不变），进度行也不每次都写回缓存 —— 原来「进度没变」的那条会话每次 tick 都满足「该重取了」，会反复重开同一条 follow 流。

【目录归属判定改桶索引】`src/client/sessionIndex.ts` / `src/client/sessionFolder.ts`：「某个目录下有哪些会话」原来是每个项目扫一遍全部会话（O(项目数 × 会话数)），「哪些会话不属于任何项目」同样是 O(会话数 × 目录数) 的内层前缀比较。现在按归一化后的目录键建桶（`dirPositions`：目录 → 该目录会话下标），查询成本变成 O(不同目录数)；`normalizeFolderPath` 挂有界 memo（4,096 条上限）；归属判定改走祖先链查集合。新增回归逐条比对新旧两种算法的输出（含大小写、混合分隔符、尾部斜杠、相似前缀、子代理、无 cwd、顺序一致）→ **判定输出一模一样**。

【扫描取样公平轮转】`src/client/activitySweepPolicy.ts`：一轮最多 2 条（口径不变），但排法从「settle 优先 + 候选插入顺序」改成「settle 优先 + 多久没被取样倒序（从没取过的最先补）+ 同年龄按 sid 定序」。原来同一批会话每轮抢同样的名额，其余在跑的会话永远排不到（卡片进度不更新，而那几条被反复重开的 follow 流一直占着下行链路）。

【悬浮球列表不再每一边都重排】`src/client/pocket/orb/orb-api.ts`：`allRows()` 每被问一遍（列表 / 单行 / 复用空白 / 待决表 / 目标条，一次刷新要问 4-5 遍）就把 1,000+ 会话重建 + 排序一遍。现在按快照身份缓存（宿主每推一版列表 / 推一版工作区就先作废，订阅包装显式失效；另有 150 ms 上限兜底「原地改快照又没走订阅」的宿主），`visibleHistory` 结果也复用同一份数组 —— 内容没变时 `setHistory` 拿到相同引用，React 自己就不必重渲染。

【下行调度器补两道闸】`src/pocket-host/downlink-lanes.mjs`：① 饥饿闸门——`low` 档大帧被小帧插队最长 4 s（`maxLowLaneWaitMs`），之后按原顺序放它走；原来只有「大帧还没开始写」时小帧才越过，于是新的小帧一直插队时大帧自己永远发不出去（实测队列峰值 2.79 MB、单帧最大 2.79 MB）。② 深队列放行预算——本地排队超过 1.5 MB 且这一窗口已经放过东西，下一条超大 `low` 帧先按住留在本地（1 s 窗口 / 256 KB 预算），期间后排小帧可以越过去；窗口是空的就先放（孤零零一条开屏快照不该慢一拍）。同一条逻辑流内部严格保序照旧、不丢帧照旧、不插在半截消息中间照旧，两道闸都是「只放宽不同流之间的先后」并新增 `agedLow` / `pacedEvents` 计数（进 `diagnostic.jsonl` 的 `ws-close.queue`，真机能看见）。回退开关 `limits.maxLowLaneWaitMs = 0` / `limits.paceWhenDeep = false` 各自单独退回原口径。

【回归】新增 `scripts/test-mobile-scan-facts.mjs`（10 项：目录桶索引 / 归属判定 / 规范化缓存与旧算法逐条等价、事实签名失效口径、分层与热档升级、缓存复用与过期、扫描节奏与公平轮转）；`scripts/test-downlink-lanes.mjs` 增 5 项（饥饿闸门、闸门回退、深队列放行预算、预算回退、close 清唤醒定时器），已进 `npm test`（43 个脚本链全绿）。客户端部分手机整页刷新即生效；调度器两道闸要**重启一次 DSH Desktop**。

### 手机端流畅度·真机取数（2026-11-03）

【为什么要加计数】前几刀的收益一直只有策略级数字（少做了多少次判定、少开几条 follow 流），没有手机上的毫秒。手机上又看不到 console，所以把关键计数攒起来、每 60 s 一条 `perf` 信标走**既有**的 `/.dsh-pocket/diag` 通道落进 `diagnostic.jsonl` —— 宿主侧一行没改（它本来就是一行一条 JSON 原样落盘）。

【计了什么】`src/client/perfCounters.ts`（新）+ 四个调用点：会话派生索引重建次数与耗时（`idxBuild` / `idxHit`）、游离会话判定次数与耗时（`unowned`）、悬浮球列表复用命中 / 重建与耗时（`orbHit` / `orbBuild`）、活动扫描轮次与候选 / 实取条数（`sweep` / `tailCand` / `tailFetch`），再加上事实缓存的命中、重算与条目数（`factHit` / `factRecomp` / `factSize`，直接读 `sessionFactStore.stats()`）

【纪律】只有数字、键集固定（上限 64 个键，绝不按会话 id 建键）、payload 零值不写、字段数 ≤ 24、整条 ≤ 1.2 KB；页面不可见时不发；桌面端页面没有那个端点 → **失败一次就永久停发**，不留噪音；信标抛错一律吞掉，绝不影响页面。回退开关：`perfSetEnabled(false)` 一个（关掉就不计数也不发），或删掉 `startPerfBeacon(...)` 那一处调用。

【判读】`~/.dsh/dsh-pocket/diagnostic.jsonl` 里搜 `"name":"perf"`，`p` 就是那一份计数：`idxBuildAvg` 是每次索引重建的毫秒、`tailFetch/sweep` 是每轮实际重开几条 follow 流、`factHit/factRecomp` 是事实缓存省了多少次判定。回归 `scripts/test-perf-counters.mjs`（9 项：累加与取整、耗时三件套、非法输入、键上限、总开关、payload 裁剪与体积、信标按注入定时器上报 / 后台不发 / stop 干净、抛错不打断、单调时钟），已进 `npm test`。

### 手机端流畅度·卡片组装的固定开销（2026-11-03）

【问题】控制室每刷一次卡片（实测 6.7 次/秒），临时卡片会把全部游离会话（本机 1,115 条）排一遍序，再把它们的 id 拼成「按优先级取进度文本」的顺序 —— 后者原来的去重是 `order.includes(value)`，**O(n²)**：一次约 124 万次字符串比较，每次刷新都白花。

【现在】`src/client/sessionRank.ts` 两处纯函数提速：① 排序先把每行的 `pinned / 档位 / 最后活动 / 相对目录 / id` 算成键再排（原来在比较器里每对行现算，还带 `Number()` 强制转换）；② 去重改成「数组保序 + Set 判重」，O(n²) → O(n)。两处的键算法与比较规则都跟旧实现逐字一致，**顺序与去重结果完全不变**。

【数字】本机合成基准（1,115 行 × 300 轮，不是真机毫秒）：排序 29.0 → 27.1 ms（1.1×，V8 对旧比较器本来就不差，这一刀主要是顺带去掉每行重复读字段）；**进度顺序去重 236.3 → 10.9 ms（21.7×）**，折算每次刷新 0.79 ms → 0.036 ms（桌面 CPU），手机上按 5~10 倍算每次省 4~8 ms。

【回归】`scripts/test-session-rank.mjs` 18 → 21 项：测试里原样保留旧比较器与 `includes` 版去重当对照，200 条混合行逐条比对顺序（含 `pinnedFirst: false`）、Proxy 断言每行字段读取 ≤ 4 次、2,000 候选 + 500 重复去重与旧写法一致。两处可各自单独退回旧写法，语义不变。

### 控制室会话列表：底部开关按钮一排显示（2026-11-03）

【问题】卡片「会话列表」浮层最下面的「显示已归档 / 显示空白会话 / 归档空白会话」三颗开关原来是浮层这一列里的独立块，各占一排，列表底部拉三行高。

【现在】`src/client/split.tsx` 把这几颗开关包进一排（`.dsh-wt_sessMoreRow`，flex 横排 + 6px 间距），`src/client/styles.ts` 的 `.dsh-wt_sessMore` 去掉 `align-self:center;margin-top:2px`（改由排容器管间距、chip 文字不换行）。整排没有任何开关可显示时不渲染，不留空档；窄屏放不下才自动换行（手机抽屉宽度不足时同理）。功能与开关口径一字未改。客户端改动，**刷新页面即生效**。


### 分栏标题栏 ✕ 只收起面板，不再把会话切走（2026-11-03）

【问题】工作台分栏（2 栏：窗口1 + 右侧对话）开着时，点左面板右上角 ✕，界面会从当前会话跳到「打开项目之前的那条会话」（本机上是个人助手最新会话），看起来像「关个面板把我踢出项目」。

【根因】`src/client/index.tsx` 里 `splitStore.subscribe` 的回调在 `!splitStore.active` 时无条件执行 `openSessionInHost(projectAttachRef.sessionId)`（回切打开项目前的会话）；这条规则早先只在手机抽屉布局（dsh-pocket）关掉了，桌面端一直保留。

【现在】关闭分栏一律只收起浮层、**不动当前会话**：标题栏 ✕ / Esc / 卡片反选 / 删除布局走的是同一个 `splitStore.close()`，都停在眼前这条对话上。随之删掉已无用的 `projectAttachRef.sessionId` 与 `suppressRestoreRef`（「切到项目之外的会话 = 自动收起项目」的判定一字未改，仍按 `attached` / 绑定会话 / 项目文件夹判定）。客户端改动，**刷新页面即生效**。

### 手机端左上角「三条横线」点不进去（2026-11-03）

【问题】手机上点会话头左上角那颗汉堡钮开抽屉，经常连点几次都没反应，只能靠左边缘右滑。

【根因】按钮本体只有 28×28（`IconPanelMenu` 20px、线条本身只有 15×10），还钉在屏幕左上角 8px/12px 处：拇指落在图标外沿一点点（右侧 / 下方，甚至贴着屏幕边）就落在按钮盒子外面，等于点了空白；而按钮本身没有任何按下反馈，用户只能靠抽屉开没开来猜。手机端诊断流水（`~/.dsh/dsh-pocket/diagnostic.jsonl`）可复核：11-03 07:49 连开三次各 91~106ms，之后 10:05、11:02 两次刷新后的一次会话里 0 次 `drawer-open`，而同期标题在变（人一直在用手机）。

【现在】`mobile.css.ts` 把窄屏按钮放大到 44×44（`left 4 / top 4`，图标中心仍在 26,26，视觉几乎不动），`:active` 加一层按下反馈；会话头左侧让到 44px 给按钮腾位置。`swipe.mjs` 新增命中区判定（`toggleHitZone` / `isInToggleZone` / `classifyToggleTap`）：`drawer-chrome.ts` 在文档捕获阶段用**指针坐标**判「这一下是不是点在左上角那一片」（按钮外扩 6px、下沿只扩 2px 以免抢「对话 / 轨迹」标签条），位移 ≤14px、时长 ≤800ms 才算点击 —— 不依赖「点中了哪个元素」，也不依赖 WebView 有没有合成出 `click`；老 WebView 没有 PointerEvent 时自动退回 touch。

【顺手修掉的两个坑】① 指针路径与合成 `click` 会各翻一次（等于没点）：现在两条路径用 `TOGGLE_DEBOUNCE_MS` / `pointerHandledAt` 互斥，一次点击只翻转一次；② 「点抽屉外就关」的豁免原来只比 `target === toggle`，点在按钮里的 `<svg>/<path>` 上不算，于是关抽屉会「先关再被 click 打开」——改成 `toggle.contains(target)`。开抽屉打点新增 `src`（`btn` / `zone` / `swipe`），下次再有"点不进去"，流水里一眼看出点到底有没有到达。

【回归】新增 `scripts/test-mobile-toggle-zone.mjs`（命中区形状、旧死角必中、标签条 / 标题区不抢、滑动与长按不算点击）与 `scripts/test-mobile-drawer-chrome.mjs`（假 DOM 真跑 `mountDrawerChrome`：按钮开、外沿开、合成 click 不二次翻转、标签条点击不接管、滑动不开、老 WebView 只有 click 也能开、卸载干净），均已进 `npm test`（46 个脚本全过）。客户端改动，**手机刷新页面即生效**。

## [0.2.13] - 2026-11-01
🛠️ 托管补齐最后一段「无人值守」：输出被截断时自动补发「继续」

【托管 · 输出截断自动续写】模型单次输出撞到输出 token 上限时，界面会显示「已达到输出 token 上限／回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出」；在此之前托管只管「提问 / 审批自动应答」，这一步还得人手动点一下，等于把「没人看着」的会话卡在原地。现在托管开着时由插件自己补上：宿主订阅 `session/event`，看到 `turn/end { reason: { kind: 'max-tokens' } }`（与那条提示同一个事件）就往该会话追加一条「继续」，模型照常接着输出。

为什么放宿主、不放客户端 composer：① 托管的语义是「页面关着也照跑」，客户端实现只在有人开着页面时才生效；② 手机 + 电脑 + 分栏可能同时开着同一会话，客户端实现会各发一条，同一次截断补发多遍；③ 宿主事件流是唯一真值，判定与提示本身不会错位。补出去的是一条普通用户消息（`role: user` / `source.kind: user`），聊天里就是一个「继续」气泡，不新增谁也看不懂的消息类型。

不添乱的四道闸（`src/tuoguan-autocontinue.ts`）：① 只在**真没人接手**时补——先等本轮收尾（`agent.whenIdle()`），仍是空闲、且 next-turn 收件箱为空才发，已经有人或别的插件排了活就让那条先跑；② 截断后 90 秒内没等到空闲就放弃，避免久等之后把「继续」补到别的任务上；③ 子代理会话不补（父会话已按 max-tokens 收过它的结果，再让它单独跑一轮没人接收）；④ 连续自动续写 8 次封顶，正常收尾（completed / aborted / error）或真人发话都清零，到顶就停手等你确认——不会因为模型反复撞上限而无限烧 token。同一轮（sessionId + turn）只补一次，会话销毁即清计数。

文案与回归：composer 右侧「托管」胶囊的 tooltip 与「个人助手 → 托管」的说明都写明这条行为（含 8 次封顶）；新增 `scripts/test-tuoguan-autocontinue.mjs`（19 项：托管开关判定、同轮去重、封顶、真人/正常收尾清零、子代理跳过、收件箱有活不插队、保鲜期、状态读不到不抛错、多会话互不影响、安装器真的挂上 `session/event` 且卸载后不再补），已进 `npm test`。**宿主改动要重启一次 DSH Desktop 才生效**，客户端只改了文案（刷新页面即可）。

### 手机端「任务运行时点按钮就卡」三刀（2026-11-02）

【下行分道 + 背压】`src/pocket-host/downlink-lanes.mjs`：把手机侧下行消息分成 high（≤2 KB 的交互/状态帧）与 low（开场快照、follow 批量事件等大帧）两道，**同一条逻辑流内部严格保序**，只有「另一条流的小帧」允许越过还在排队的大帧；`client.write()` 返回 false 时暂停下游、等 `drain` 再继续（以前是无条件把字节推给 ssh.exe / VPS 的发送缓冲）；同一 `(streamId, sessionId, key)` 的 projection 帧按「最新值」合并。排队字节、峰值、越过次数、合并次数、背压时长、最大帧字节都写进 `diagnostic.jsonl` 的 `ws-close.queue`。回归 `scripts/test-downlink-lanes.mjs`（6 项）。

【不再每轮重开 follow】`src/client/activitySweepPolicy.ts`：控制室 1.2 s 活动扫描改成按状态分级取样——在跑 2.5 s 一次、空闲 20 s 一次，每轮最多 2 条（原 6 条）；`src/client/sessionTailCache.ts` 给「同一会话 + 同一参数」的尾快照加 900 ms 窗口与在途去重，失败不缓存；空闲卡片不再请求 `assistantStream`。白屏自愈 3 s 去抖，并与活动扫描互斥（不再出现「resync 又拉一次大快照」和正在跑的流抢同一条下行链路）。

【卡片重组装不再每帧一次】`src/client/cardRefreshPolicy.ts`：控制室卡片的全量重组装从「每动画帧一次」改成最小 150 ms 间隔（前导立即 + 尾随补一次），页面不可见时不刷新、回到前台补一次。回归 `scripts/test-mobile-perf-policy.mjs`（5 项）。

### 会话列表自动藏掉空白会话（2026-11-02）

【为什么列表里那么多条只有名字的会话】`~/.dsh/assistant` 下实测 102 条会话里一半以上**一条消息都没有**（`session.v4.jsonl` 只有会话头 + 权限/沙箱/审批三行），标题就是目录末段名「assistant」。两条来源叠在一起：
① 助手入口每次进都是「新开会话」，只复用**同目录同模式**的空白会话——模式对不上就一直新建；
② 悬浮球/快捷键那一次唤起是**广播给所有正在等的页面**（宿主 `assistant.ts` 的 `wakeClickWaiters`），电脑窗口 + 原生球窗口 + 手机页面各建一条，实测同秒内连出 4-6 条、间隔约 100 ms。

【现在怎么显示】`src/client/split.tsx` 的「会话列表」浮层默认藏掉空白会话（和「已归档」同一套开关口径）：计数、列表渲染、空态文案都走 `sessionRowsVisible`（`src/client/sessionFolder.ts`）；当前正在看的那条空白会话仍保留，否则高亮会指到看不见的行。浮层底部新增「显示空白会话 (N)」按钮，一开就都出来（纯显示过滤，**不删不归档任何会话**）。显示出来的空白行带「空白」标签。

【老宿主的兜底】宿主会话行没有 `blank` 投影时按「标题只有会话 id、或只是目录末段名、且不在跑、未置顶、未归档」判空白（`looksBlankWithoutFlag`）；有真标题的会话不会被误藏。

【所有卡片都这一套，含以后新增的项目卡片】过滤写在共用代码里（`split.tsx` 浮层 + `index.tsx` 的 `projectSessionsOf`），不是只对「个人助手」卡生效：任何一张卡片（新建的项目也一样）打开「会话列表」都藏掉空白会话；「正在运行」那张临时卡本来就不收空白会话。

【一键清掉】浮层底部另有「归档空白会话 (N)」：候选口径与显示同一套判据（`archivableBlankRows`），走宿主归档＝从列表移除、磁盘日志保留，点「显示已归档」能拿回来。不碰当前会话、已置顶、已归档、正在跑的。两段式确认（第一下只把按钮换成「再点一次确认归档」，第二下才真动手——手机上连点容易误触），归档时逐条串打宿主、每次让出一拍，完事 toast 报「成功几条、失败几条」。

回归 `scripts/test-session-list-filter.mjs`（8 项，已进 `npm test`）。纯客户端改动：手机整页刷新 / 电脑刷新即可见，不用重启宿主。

## [0.2.12] - 2026-11-01

🛠️ 0.2.11 之后落地的整改（本机验证，已 commit / 已 push）

【卸载通道】新增 `scripts/uninstall-assistant.mjs`：默认只摘 profile 的 `dsh-assistant` junction 并把 profile 的 `package.json` 从 `*.bak-assistant-*` 备份恢复（没有备份就剥掉依赖项与打包清单条目，同时留一份 `package.json.before-uninstall-<时间戳>`，并提示旧插件要手动补回）；`--purge` 额外把助手数据挪进 `~/.dsh/uninstall-backup-<时间戳>/`（不是删）——`<profile>/dsh-assistant-ball/`、`~/.dsh/assistant/`、本机 `config.json`、两份状态 json、聚焦日志。浏览器侧（IndexedDB `dsh-worktable` 与 `dsh.assistant.*` / `dsh.worktable.*` 的 localStorage 键）脚本碰不到，只列出键名前缀 + 给一段可粘贴的 DevTools 片段；`dsh.sessions.current` 是宿主的，脚本明确不清。`--dry-run` 什么都不动。回归测试 `scripts/test-uninstall-plan.mjs`（含「真实目录不是 junction 时不许删内容」这一条）。README 补「卸载」章节。

【质量门】新增 `npm run lint`（`scripts/lint-standards.mjs`）与 `npm run typecheck`（`tsconfig.json` + `scripts/typecheck.mjs`）两个脚本键（之前 README 宣传了脚本却没加进 package.json——这条现在由 `test-quality-gate.mjs` 盯着）。lint 不引 eslint：查个人化标识与退役仓库名不许复现、两处版本号一致、运行时自名一致、宿主日志不再自称 `[dsh-worktable]`、`.mjs` 脚本里不许出现 TS 注解——它第一次跑就抓出 3 处真问题（`src/client/flow.tsx`、`src/client/index.tsx` 的旧路径示例，以及宿主日志前缀）。typecheck 诚实版：本机实测【过不了】（缺 `@types/node` 与宿主 `.d.ts`），跑不起来时退出码 2 并说明「不是通过了」，绝不打印通过。新增 `.github/workflows/ci.yml`（ubuntu + windows 矩阵，Node 22：install → build → check → test → lint；typecheck 挂 `continue-on-error`）——这份文件本机留着但**没能推上去**：仓库用的 PAT 没有 `workflow` scope，GitHub 直接拒绝「创建/更新 workflow 文件」，要给 token 加上 `workflow` scope 或从网页上传，Actions 才第一次跑起来。

【一键导出诊断包】设置 →「个人助手」页底新增「🧰 导出诊断包（脱敏）」：收插件版本、聚焦日志尾部、桌面球 helper 日志尾部、手机访问诊断流水摘要、状态文件概要、助手目录用量与目录 allowlist 根列表；写盘前统一脱敏（家目录 / DSH 数据根 / profile / 助手目录 / Desktop / 临时目录 / 配置里的私人目录换成 `<HOME>` `<DSH>` `<PROFILE>` `<ROOT>` 标记，残留盘符路径换 `<PATH>`，`pin:` / `token=` / `Bearer …` / 长十六进制串与 JSON 字符串内的 6–8 位数字换 `«已脱敏»`），`dsh-pocket/settings.json` 整份不进包，包里还写清「哪些故意不给」。落 `~/.dsh/assistant/outputs/diagnostics-<时间戳>.json`，UI 给可复制路径 + 体积 + 脱敏替换处数。新宿主路由 `GET /api/assistant/diagnostics`、`POST /api/assistant/diagnostics/export`（**要重启 DSH Desktop**）。回归测试 `scripts/test-assistant-diagnostics.mjs`（6 项）。

【助手档案导出 / 导入】同页新增「📦 导出助手档案」与「📥 导入助手档案」：导出是单一 JSON 清单（AGENTS.md + `journal/` + `notes/` + `archive/` + `config.json` + `USER.md`/`MEMORY.md`/`memories.json` + 状态 json），每项带相对路径、字节数与 SHA-256，整带 `checksum` 与总体积，落 `~/.dsh/assistant/exports/archive-<时间戳>.json`（不在 `outputs/` 的 14 天自动清范围）。导入先验校验和（不对整包拒绝）、把 AGENTS.md/journal/notes 现状备份进 `archive/import-backup-<时间戳>/`、按文件夹判重跳过、内容不同一律【不覆盖】而是另存 `<原名>.imported-<时间戳>.<后缀>`、`state` 区拒收（删除墓碑不写回，报告数量）、路径不许跳出区目录、本机没有的预设显式列进 `missingPresets` 不静默；UI 直接打印「导入了什么 / 跳过了什么 / 冲突另存 / 备份在哪」。新宿主路由 `GET /api/assistant/archive`、`POST /api/assistant/archive/export`、`POST /api/assistant/archive/import`（**要重启 DSH Desktop**）。回归测试 `scripts/test-assistant-archive.mjs`（10 项）。

【README 对齐】「一概不碰 journal/notes」改成实际的按天/按字节归档语义；「三个入口」改成「入口不止三个」（列全长按 600ms、Ctrl+Alt+A、顶栏按钮、卡片会话列表、`?assistant=chat` / `#assistant`、`POST /api/assistant/open-assistant`）；周期数字按代码改回实测量（活动扫描 1.2 秒、同步去抖 800 毫秒、远程轮询 3 秒）。

【点卡片进入哪条会话 = 进行中的优先】原来纯按「最近更新」倒序取第一条：宿主的 `updatedAt` 只在新提示词时前进，于是「最新那条刚跑完的会话」会盖掉「还在跑的那条」——用户点卡片被带进已结束的会话，不是正在进行的会话。现在走 `src/client/sessionRank.ts` 的活跃度档：① 等你回答（黄）② 正在跑（蓝，多条在跑取最近有活动的那条；当前会话本就在这档则保持不变）③ 没有进行中的才按模板「最新步骤」/「最近更新」兜底。「会话列表」浮层用同一套排序（置顶 → 黄 → 蓝 → 异常 → 空闲按最近更新倒序），浮层第一行就是点卡片会进的那条；黄点在列表里显式标「等你回答」。卡片状态判定（`awaitingOf` / `isRunning`）与会话列表、进入判定改走同一对口径（`sessionAwaitingFlag` / `sessionRunningFlag` / `sessionFaceSnapshotOf`），模板步骤判定也合并成一个 `templateFlowStepOf`（会话列表 / 新建会话目录 / 进入项目三处同源，不再各写一份）。附带：点开项目时把「实际进入的那条会话」也一起 ack（原来只 ack 绑定会话，非绑定会话在等决策时光晕熄不掉）。**再补一刀（卡片实时进度跟人走）**：卡片中间那块进度原来按「正在跑的 → 绑定 → 步骤 → 其余关联」逐个回退，最后一级会命中旧会话的成品消息缓存——于是点进去的是 A（正在跑），卡片上却一直挂着 B 的旧内容，而且看着像在「实时变」。现在新增 `progressOrderOf()`：把这条项目的关联会话按活跃度排好（待决策 > 正在跑 > 异常 > 空闲，同档取最近更新），卡片进度就按这个优先级依次取——**点卡片会进入的那条（含它的子代理）永远排第一**，第一条拿得到内容的会话就显示它的最新消息（实时事件 → 宿主日志行 → 最近一条消息三级取），一条都拿不到才显示中性的「正在执行…」。换句话说：卡片上滚动的永远是「当前优先级最高那条会话的最新内容」，不会再被某条低优先级旧会话的内容顶掉。临时「正在运行」卡片同一套规则。回归测试 `scripts/test-session-rank.mjs`（13 项，已进 `npm test`）。

【点卡片进入哪条会话·第二次修正 = 最后**真正活动过**的那条】用户复报：任务全部跑完之后，点项目卡片还是被带进「很早以前的那条会话」。查出两个根因。① 宿主 `api/session-controller/src/list.ts` 里 `updatedAt = max(header.createdAt, lastPromptAt)`——**只有人工提示才让它前进**。一个 10:00 发提示、22:00 才跑完的长任务，updatedAt 仍停在 10:00；于是「11:00 发过一句、11:05 就结束」的另一条旧会话反而排在它前面，任务一结束就落回这条排序（上一轮只补了「进行中优先」，全部结束之后又回到老的兜底）。② 模板流程项目把「当前/最后步骤会话」摆在所有兜底之前：十步全部跑完（或验证暂停）之后，卡片永远钉在最后一个步骤会话上，用户后来在项目里聊出来的新会话永远轮不到。改法：`src/client/sessionRank.ts` 新增 `sessionLastAt()`（`max(updatedAt, lastAt)`）、`pickLatestSession()`、`pickEnterSession()`，同档排序改按**最后活动**倒序；`pickLatestSession` **不抬置顶**——置顶只决定「会话列表」里排第几行，不该决定点卡片进哪条（一条很早以前置顶的旧会话会永远压住刚跑完的那条，就是这次的现象）。`src/client/index.tsx` 新增 `lastActivityAtOf()`：本端事件窗口最后一条时间 → 会话面 `turnTimings` → 后台任务起止 → 观察到的「跑 → 停」时刻，按 `updatedAt + running + completed` 做版本缓存（卡片 1.2 秒刷一次不重复扫）。`preferredSessionOf()` 改成 ① 进行中（待决 > 在跑，当前会话本就在这一档则保持）② 最后真正活动过的那条（模板步骤会话与普通会话同一杆秤）③ 模板最新步骤（只在一条会话行都拿不到时才用）④ 绑定会话。另外**控制室点卡片进入项目后把卡片绑定跟到实际进入的那条**（`bindEnteredSession`，只限 enter 语义 = 控制室；侧栏点开项目仍只切会话、不改绑定）——否则卡片的状态灯 / 光晕 / 预览还按旧绑定算，看起来就是「还挂在很早以前的会话上」，下次点卡片又要重新挑一遍。两条「同一套判定」的承诺照旧：卡片中间那块实时进度、`＋ 新建会话` 的目录、点卡片进入哪条会话现在都调用 `pickEnterSession` / `sessionLastAt`。回归测试 `scripts/test-session-rank.mjs` 增 5 项（共 18 项，已进 `npm test`）。

【手机端流畅度：左菜单开合慢 / 抽屉右上角那颗没用的按钮 / 语音输入说几个词就自己停】三件一起修，全部在插件的手机层，不碰宿主。

① 「点左上角三条横线后弹左菜单要慢一下」的根因查清了：原来那次「图标 rail → 完整列表」的官方侧栏升级（AppFrame 换列 + SidebarRoot 重挂载 + 会话列表重建）挂在**第一次点汉堡**上，几百毫秒的主线程活儿做完之后，0.28s 的滑行才开始。现在首屏装配完 700 毫秒先补好升级（`armPreUpgrade`），点开抽屉只在那条还没补时同步补做；按下汉堡（pointerdown）就把那一列提到独立合成层，`will-change: transform` 520 毫秒内必撤——久留会让这一列成为宿主设置面板 portal 的包含块，重演「面板偏 102px」那个老 bug。开合耗时改为实测打点（`measureOpen` → 诊断流水里的 `drawer-open` 阶段，带 `ms` 与 `up`），下次打开「一键导出诊断包」就能看到还剩多少毫秒，不用凭猜。

② 抽屉右上角那颗「打开侧边栏」（官方 logoRow 里的 sidebar toggle，用户判定它在手机上没用）在 `mobile.css.ts` 的窄屏规则里收掉：判据三条（`button[class*="_toggle"]` 与中英两种 `aria-label` 兜底），全部限定在抽屉那一列的 `[data-window-drag]` 内部。电脑布局的侧栏、会话头右侧的「打开右侧边栏」都不受影响；官方键盘快捷键（收起/展开侧栏）照旧可用。

③ 新建 `src/client/compositionGate.ts`：一条「别人正在输入时插件不许改 DOM」的纪律。捕获阶段听 `compositionstart` / `compositionend`，加 140 毫秒收尾窗（组合结束后宿主与 Lexical 还在补发节点），加开 / 关抽屉的 360 毫秒让路窗，超过 120 秒的组合自动放行（有的输入法引擎根本不发 `compositionend`，绝不能因此把补丁永久锁死）。手机侧所有 body 级扫描与 DOM 补丁改走 `createGatedThrottle`：**让路窗口内不跑，但批次绝不丢**（按 `skipMs` 重试，最多 12 次后强跑一次），`throttleByFrame` 也统一挂进这条闸门。三个具体中断源堵掉：`fileGuard` 的「复制」按钮注入与「隐藏添加工作区」扫描一律不碰输入框那一棵树（`insideComposer`：`[data-composer-card]`，文本节点走 `parentElement`——Lexical 每个字都在换文本节点），`modelSettingsNotice` 的报错文案替换同理不碰 `[contenteditable]` 本体，统计行折叠 `moveTps` 不搬编辑器里的节点；控制室 1.2 秒活动扫描、3 秒跨端轮询、2 秒修 `dsh.sessions.current`、2 秒贴底测量、任务管理窗 2 秒重渲染、托管状态 2.5 秒轮询都在窗口内跳过（不是取消，下一轮照旧补）。微信键盘 / 讯飞那种「一边说一边出字」被打断的老因就在这儿：插件在宿主 Lexical 编辑器里改 DOM → 宿主重排输入框 → 当场结束组合。

④ 顺带把三个「第三方套件兼容」观察者（explorer 可用性 / preview 开合标记 / 表格抬起动画）从「永久挂着」改成有界确认（`featurePresence.mjs`）：本机跑的是纯 DeepSeek Harness，根本没有 `[data-aionui-*]` 那两列，原来这三个观察者一直在 `document.body` 全量 childList / attributes 上排 querySelector + getComputedStyle（长会话详情实测 ~2 万节点，一次扫描 ~19 毫秒）。现在 15–20 秒窗口内确认不到就不再观察，切布局时 `recheck` 补一次；真有那两列的套件宿主照旧补挂，且只挂一次。

④·补 同一轮里再收三处：`modelSettingsNotice` 的补丁队列给上硬上限（800 个节点封顶，只留最新的那批）并且**输入框那一棵树里的节点根本不进队列**（Lexical 每个字都在换文本节点，过去每一批都排进队列）；分栏工作区的「兜底重锚定」body 观察器也挂上闸门（300 毫秒合并 + 组合 / 开合窗口让路）。反过来，`observeExternalSplit`（外来 `.ta_split` 让位观察器）**保持原样不闸门**：那里是「外来分栏出现就立即让位」的契约，不是扫描优化——契约优先，别为省几毫秒偷偷改掉互斥语义（`scripts/test-split-observer.mjs` 盯着这条）。

另外给语音这条路装了探针：`createVoiceProbe` 只在 `compositionstart` / `compositionend` 这两个边界读一次输入框文本长度（全程只读、绝不写 DOM —— 写输入框那一棵树才是要打断语音的那件事），`createVoiceTally` 把它汇总成一条 `voice-compose` 诊断记录（说了几段 / 各类归类 / 一共进去多少字 / 最长一段多少毫秒）。可疑中止（`interrupted` = 上一段还没等到 `compositionend` 就来了新的一段；`silent-long` = 说了 2.5 秒以上一个字都没进）立刻发一条，正常打字每 20 段合并发一条，不把 beacon 打成「每敲一下发一发」。你在手机上说完一段长语音后打开「一键导出诊断包」，就能看见断在哪一类、总共断了几次。

【流畅度·这一整批不改任何功能】只改「谁去扫、扫多久、什么时刻写」，看得见的外观与行为一字未动（光晕 / 卡片内容 / 抽屉内容 / 语音 / 会话进入判定都照旧）。新回归测试 `scripts/test-bottom-overlay.mjs`（15 项）、`scripts/test-local-store.mjs`（7 项）、`scripts/test-face-cache.mjs`（6 项），都进了 `npm test` 链。

① 底部面板避让（新模块 `src/client/bottomOverlay.ts`）：原来每 2 秒 `document.querySelectorAll('body *')` 把整页元素过一遍、每个都读一遍布局（两三万节点的会话页一次就是一发）。现在 400 个一片、一片跑完再接下一片；样式变化由观察器只盯 `style` 属性补一轮；轮询自适应（交互密集时 6 秒内不扫、安静时 4 秒一轮）；写 inset 前先比新旧值，不需要就不写。`scanOnce` 会先撤掉排队的那一帧；已有扫描活着时观察器不再排第二个。

② localStorage 读缓存（新模块 `src/client/localStore.ts`）：原来卡片每刷新一次就把整份存档读出来再 `JSON.parse` 一遍，模板配置与助手设置也一样。现在读走 `cachedJsonRead`（原始字符串一字不差才复用缓存那份，`null` 不缓存、每次真读）、写走 `cachedJsonWrite`（改完整体落盘一次；循环引用 / 配额溢出不把调用方带炸）。卡片 ack、模板 override、模板 meta 都接上这条。

③ 一次宿主通知只做一次：卡片失效与控制流通知改微任务合并（同一批通知排下来的多次失效只发一次；微任务在一帧之前跑完，卡片仍然这一帧就更新）。生命周期扫描与预览扫描按「任务名」去重排队，不再每条通知各扫一遍。卡片 DOM 桥的观察器不再每轮拆掉重挂（挂上就留住 + 一帧合并 + 订阅失效通道）。每卡只排一次序（排好的 id 列表复用给进入判定与其余口径），半截 JSON 的 fallback 正则改成一次编译。

④ 拖分隔线：拖拽过程每一帧只写一次尺寸（原来每个 mousemove 都写 DOM 并落一次存档），存档 180 毫秒合并落盘、松手与关闭时补最后一笔；关闭前先补落盘再走关闭。

⑤ 手机端悬浮球会话列表：整行记忆化（原来每条宿主通知都要把整个列表连同每一行的日期串重算重渲染）。左滑改「每帧只写一次 transform」，松手时把这帧没写完的平移撤掉、落点交给带 transition 的回弹（滑到底 / 滑回照旧）。录音电平不再每 120 毫秒重渲染整个输入框（改成直接写那一行 DOM），并留 250 毫秒兜底计时器（页面在后台 rAF 被停时超时也能自己收）。输入框自动增高合并到一帧。

⑥ 手机端两处「整页扫」下掉：统计行折叠原来每 300 毫秒整页扫 `[class="_root"]` 再逐个读 `textContent`（一次 ~19 毫秒），现在只扫输入框 dock 那一棵，聊天区流式更新的变更与 dock 无关就不重扫。抽屉 chrome 原来 250 毫秒一轮、48 轮全页 `querySelector` 空转等壳层，现在观察 DOM 变化、补到就停观察 + 最多 4 轮递增兜底。标题诊断不再 1 秒 / 5 秒永不自停地读 `document.title`，改观察 `<title>` 本体；首屏 chrome 计数从 4 次全页扫描并成 1 次。

⑦ 会话面快照加一层 100 毫秒极短缓存（新模块 `src/client/faceSnapshotCache.ts`）：卡片组装、提醒表、待决表、临时卡片判定原本一次通知里要把同一条会话的宿主会话面读三四遍，再乘上同时挂着的实例（侧栏工作台 + headless 数据宿主 + 分栏浮层）。取不到不缓存（下一条消息挂上来马上看得见），过期严格重读；待决 / 在跑的真实变化仍由宿主订阅推出。桌面球状态那条 15 秒轮询在页面被盖到后台时停掉，回到前台立刻补一次。

**光看「断了几次」不够，还要看「谁在那一刻动了输入框」。** 实机反馈是「说半句就停、时好时坏、换个会话又正常」——这不是某条规则的确定行为，而是**竞争**。所以补了 `src/client/composerLedger.ts`：组合进行时在 `[data-composer-card]` 子树、以及宿主 `[data-phase]` 那个祖先上各挂一个观察者，**只读**记录现场——每条 DOM 变更的签名（标签 + CSS-module class）+ 毫秒偏移（去重、最多 8 条），并给出三个判定：`EDITOR-TOUCHED`（变更落进了 Lexical 编辑器本体，最可疑）、`EDITOR-SWAPPED`（编辑器本体在组合期间被换掉 / 脱离文档，几乎必然中断输入法）、`PHASE-FLIP`（宿主在组合期间把 `data-phase` 从 hero 翻成普通，整页重排的经典时机）。可疑中止会把这份现场压成一行（`kind@时长 phase=… 标记 + 前几条变更`，≤180 字）写进 `voice-compose` 的 `last` 字段，诊断包里直接读得到——先分清是宿主重投影、插件补丁、还是新建页→会话的布局翻转，再决定改哪儿。

⑤ 回归测试 `scripts/test-composition-gate.mjs`（27 项：闸门本体判据、140 毫秒收尾窗、120 秒兜底放行、让路不丢批次、`maxSkips` 上限、`insideComposer` 两种判据、存在性闸门到期停轮 / 只挂一次 / 晚挂载补挂、抽屉控制器「开抽屉即让路」且绝不降回 collapsed、以及抽屉收那颗按钮的规则不许落到输入框或会话列表上、语音探针的归类与汇总（可疑中止立刻发一条、正常打字每 20 段合并发一条）），已进 `npm test` 链。`npm run build` / `check` / `lint` / `test` 本机全绿。

## [0.2.11] - 2026-10-30

🛠️ 本版本更新（商业化 P0 收口）

【个人配置外置】仓库里不再有本机路径、本机技能目录、本机人名与语音纠错表：
新建项目的默认位置、技能文件路径、AGENTS.md 人设、语音术语纠错都改成本机配置文件
`~/.dsh/assistant/config.json`（由宿主 `GET /api/assistant/config` 下发给页面）。
配置文件里没有这些值时，全部退回通用默认（平台 Desktop 目录 / `~/.dsh/skills` / 通用术语表），行为不变。

【记忆面板】个人助手设置里新增「🧠 它记下了什么」：列出 USER.md 与 MEMORY.md 的每一条（含 `[importance]`、分支、改于日期），
可逐条删除、可整侧清空、可复制与导出 .md，同时显示助手目录各区（journal / notes / outputs / archive）的文件数、体积与上限状态。
写回走宿主新路由 `/api/assistant/memory-entry-delete` 与 `/api/assistant/memory-clear`：删之前一定先备份，
并且必须重启 DSH Desktop 才生效（面板会讲清楚，不会偷偷刷新）。

【journal / notes 容量策略】助手目录多出 `archive/`：journal 超过 90 天、或文件数超过 180 份、notes 总字节超过 8MB 时，
旧文件**整份搬进 archive/**（插件永不删除，一字不少）；只有 `outputs/`（杂物间）才会被自动删。
archive 自己超过 32MB 时只在面板与日志里提示，插件不再自动搬。

【升级链路闭环】仓库只留一个更新源（`xiaoshumiao00-lang/dsh-assistant`）：控制室、工作台分栏页、更新检查全部共用同一份
升级指令与同一套 localStorage 缓存键；此前分栏页里那条指向已退役仓库的升级命令已删除。运行时插件自名也统一成 `dsh-assistant`。

【AGENTS.md 追加规矩】助手目录的固定人设改由插件托管（`persona v1` 标记段，内容来自本机配置文件），
旧文件缺「家目录规矩」「归档规矩」时只追加那一节，用户手改的正文绝不覆盖。

【质量门】新增回归测试：家目录 / 归档 / 记忆写回 / 默认项目位置解析；`npm test` 逐条跑，构建继续强制两处版本号一致。

## [0.2.10] - 2026-10-28

- 当前会话识别适配 DSH 0.2（`uiWorkspace.selection` → `sessions.current` → 旧快照 → `localStorage dsh.sessions.current` 兜底）。
- 「离开项目」改按项目文件夹判定：模板流程内部各步骤之间切换不再算离开。
- 打开私人助手前先收起项目分栏（助手是单一会话全屏布局）。

## [0.2.9] - 2026-10-27

- 助手家目录分区：`AGENTS.md` + `journal/` + `notes/` + `outputs/`；`outputs/` 超过 14 天自动清理。
- 宿主路由 `/api/assistant/home`、`/api/assistant/tidy`。

## [0.2.8] - 2026-10-26

- 助手卡建卡被首同步吃掉的问题修复；新建会话 / Computer Use 模式 / 沿用上次模型的选择行为修正。

## [0.2.7] - 2026-10-25

- 私人助手在控制室就是一张普通项目卡（图标、排序、按文件夹判重、删除墓碑不重建）。

## [0.2.6] - 2026-10-24

- 私人助手入口：长按悬浮球 600ms / Ctrl+Alt+A / 控制室顶栏「🤖 私人助手」；单击悬浮球仍进控制室不变；`?assistant=chat` 直达。

## [0.2.5] - 2026-10-23

- 手机访问独立生命周期：手机访问改成独立入口（`dsh-assistant/pocket`），有自己的 Cordis 生命周期；工作台 / 控制室 / 客户端代码的热重载不再重启代理与 SSH 隧道。登录密钥改为安装级持久化，DSH 重启 / 更新后手机不必重新输入访问密码（改密码仍会使旧登录失效）。
- 手机首屏更快：手机端只精简桌面原生能力、埋点与开发期 HMR，设置 / Skill / 自动化任务 / 记忆系统等用户功能全部保留；模块在代理里本地合并成少量 JS 再一次性 gzip / Brotli 下发。需要完整插件树时加 `?dsh-full-plugins=1`。
- 路由注册不再泄漏：全部 web 路由集中登记、统一注销，热重载不再因「路由重复」让插件启动到一半失败；旧版本泄漏在宿主里的路由会被自动替换清理。
- 选文件夹只用一套浏览器：手机端「新建项目 / 更改文件夹」与「会话输入框 → 电脑文件」共用同一套路径浏览器；起始目录不存在时自动退到最近可读上级并提示。
- 复制更可靠：http 打开时没有剪贴板 API 的兜底（含 iOS 多行）；路径浏览器地址栏可一键复制。
- 手机顶部标题固定显示产品名，不再被长会话名占满。

## [0.2.4] 及更早

- 0.2.4：只看进行中筛选、临时运行卡片、坐标开关。
- 0.2.3：加号菜单支持再次点击关闭并置顶；更换手机悬浮球默认头像；电脑文件置顶到附件菜单首位；手机端会话支持上传电脑文件。
- 0.2.2：修复提问时控制室仍显示进行中；控制室响应与新建会话流畅性；跨端控制室与会话实时状态。
- 0.2.1：项目管理菜单、按设备列数、独立 Electron 悬浮球、模板步骤进度。
- 0.2.0：合并托管、跨端同步、桌面原生球、设置整合、控制室交互修复；首次同步取项目并集再回写宿主。
- 0.1.x：悬浮球控制室 + 手机访问一体化插件首发；去掉侧栏工作台区块（控制室只从悬浮球进入）。
