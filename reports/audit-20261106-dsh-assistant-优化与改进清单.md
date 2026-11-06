# dsh-assistant 只读审计 · 优化与改进清单（2026-11-06）

状态：🚧 只读审计完成 · 未改任何代码 / 未重启宿主 / 未重打包 app.asar / 未碰 LICENSE·NOTICE / 未 commit

审计范围：`D:\dsh-assistant`（HEAD 4a905dd，v0.2.16，含未提交 `src/turn-guard.ts` + `lib/index.js` + `scripts/test-turn-guard.mjs`）、`D:\dsh-pocket`、宿主 `@deepseek-ai/*` 编译产物与 `C:\Users\Administrator\.dsh` 运行时实况、`D:\dsh-app`（Android WebView 壳）。基线三份文档（10-27 / 11-02 v0.2.13 / 11-06 P0-P2）已读，本文件只写**增量**，不复述其结论。

## 0. 一句话结论

⚠️ 基线七项里有 **5 项仍未做**（a/c/d/e/f），新发现的 7 项（1–7）**全部未修**；本轮新增 36 条薄弱点，其中 5 条涉密（GitHub PAT 明文、PIN/token 明文回显、助手正文前 40 字进日志、签名材料与本机截图留在 `D:\dsh-app\out\`、写死公网 IP 进 APK）。建议动手的 14 条是低成本不动协议（P0-1 … P0-14），5 条需要改协议或需要宿主/发版批准（P1），另有 9 项建议划掉。

---

## 1. 基线七项当前状态表

| 项 | 内容 | 当前状态 | 证据（文件:行） |
|---|---|---|---|
| a | 下行大帧分块 / 开屏快照瘦身 | ❌ 未做 | `src/pocket-host/downlink-lanes.mjs` 全文只有 lanes/合并/限速，无任何分帧逻辑；实况证据：`C:\Users\Administrator\.dsh\dsh-pocket\diagnostic.jsonl` 的 `ws-close.queue.maxFrameBytes = 4416076`（最近 6 条同一量级），`peakQueuedBytes = 4547788 / 4714045` |
| b | SSH 隧道加 `-C` 压缩 | ❌ 未做 → **建议划掉** | `src/pocket-host/ssh-tunnel.mjs` 两处 ssh 参数构造（`buildSshArgs` :163-183、`buildRemoteCmdArgs` :186-201）均无 `-C`；替代已生效：WS 重框 permessage-deflate（`ws-deflate.mjs`）+ HTTP brotli q6（`proxy.mjs:1232-1265`） |
| c | 宿主 control 全量 baseline / ControlQueue 无上限 | ❌ 未做（宿主侧） | 产物 `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/control.js:35`（`yield { type:'baseline' }`）、`:43-60` 全表重建；`ControlQueue` `:66-106`（`:67` Deque 无容量、`:70-77` 无条件 pushBack，不合并同 key 帧）；源仓对照 `D:\deepseek-harness\packages\api\session-controller\src\control.ts:47`、`:82-121` |
| d | 静态资产缓存 + ETag/304 + Service Worker | ⚠️ 部分做 | 插件侧已 immutable：`proxy.mjs:103-108`（在 `:1253,1267` 应用）；HTML 注入后**主动摘掉验证器**：`proxy.mjs:1221-1225`（`cache-control: no-store`，删 `etag/last-modified/expires`）；宿主侧无 ETag/304 也无 SW：asar 内 `@deepseek-ai` 自有 1925 个 .js 全扫 0 命中，只有三方 `fresh`/`send` 有；自有 max-age 仅 `dsh-client-modules/lib/index.js:160,986` |
| e | 移动端首屏瘦身 / 代码分割 | ⚠️ 只做了一半 | `src/pocket-host/mobile-boot.mjs:5-10` 可省模块仍 4 项、`:16-34` 权重表仍 17 条、`:35` 未列出的模块一律按 10000 估、`:36` `MOBILE_BATCH_COUNT = 3`、`:95-102` LPT 装箱；`src/client/**` 全仓无 `import(`/`React.lazy`（0 命中）→ 宿主 bundle 表不动就无法真正分割 |
| f | 长会话 DOM 上限 / 虚拟列表 | ❌ 未做 | 插件侧无任何截断：`src/client/compositionGate.ts`（只让路，不裁 DOM）、`src/client/pocket/orb/OrbOverlay.tsx:251 HISTORY_PAGE = 40` 是唯一分页；`src/client/pocket/mobile/mobile-apply.tsx:46-50` 自己写着「实测 ~2 万个 DOM 节点」，但没有裁表 |
| g | 宿主配置残留清理 | ❌ 未做（值已核实） | `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml:17 transcriptView: detailed`、`:18 performanceUsage: detailed` 覆盖插件层 `D:\dsh-assistant\cordis.patch.yml:67-68 condensed / disabled`；宿主分页仍 `lib/client.js:2178 maxMessages: 500`（源仓 `session.ts:54` 同值）；`dsh-pocket/settings.json:2 lanEnabled: false`（语义 `src/pocket-host/settings.mjs:62-67` 新装默认 false、`:74-78` 老装缺键按 true） |

补充（本轮新核实的环境事实）：`dsh-assistant` 安装副本是 **Junction**（`profiles\desktop\node_modules\dsh-assistant` → `D:\dsh-assistant`，`package.json:21 link:`），两侧 SHA256 完全一致（`lib/index.js` = `449D352D…`），所以「双副本陷阱」对 dsh-assistant 不存在；但对 **dsh-pocket 仍然存在**：安装副本是注册表实体副本（`package.json:17 "^2.10.6"`，非 junction），开发克隆 `client/client.js` 已过期（dev 2026-10-25 15:58 / 316,841B 未压缩 vs 安装 2026-11-01 23:00 / 223,450B 压缩），刷新脚本只读写安装副本（`D:\dsh-pocket\scripts\build-installed-client.mjs:8-10`）。

---

## 2. 上一轮新发现 1–7 的复核

| # | 上轮发现 | 是否已修 | 证据 |
|---|---|---|---|
| 1 | `sessionTailCache` Map 无上限、过期条目不清 | ❌ 未修 | `src/client/sessionTailCache.ts:20`（无 size 上限）、`:36`（只比 TTL，过期仍留）、`:40`（仅失败才 delete）；无 sweep/cap |
| 2 | 下行 12MB「硬上限」其实照单全收 | ❌ 未修 | `src/pocket-host/downlink-lanes.mjs:32 DEFAULT_MAX_QUEUED_BYTES = 12_000_000`；`:286-292` 注释写「硬上限」但只是 `stats.overflowEvents += 1` + `onOverflow?.()`，紧接着仍 `pending.push(item); queuedBytes += meta.bytes;` |
| 3 | Deflate/Inflate 队列无上限、且没接 overflow 通知 | ❌ 未修 | `src/pocket-host/ws-deflate.mjs:129-133` 与 `:183-187` 无界 push；`:264-288` 调 `createDownlinkScheduler` 只给 `encode`/`write`，**不给 `limits`、不给 `onOverflow`** → 上层的 overflow 记账无处可看 |
| 4 | mobile-batch 同一定义存 identity+gzip+br 三份、缓存 8 代 | ❌ 未修 | `src/pocket-host/mobile-batch.mjs:23-31`（`definitions` Map、裁到 8 代）、`:66-68`（`{identity, gzip, br}` 三份 Buffer 永久留在 promise 里）、`:10 MAX_RESPONSE_BYTES = 24MB` 只是单条上游响应上限 |
| 5 | `StrictHostKeyChecking=no` + 空 known_hosts | ❌ 未修 | `src/pocket-host/ssh-tunnel.mjs:168-169` 与 `:190-191`；实况 `settings.json:4-12`：`enabled: true`、`host 49.234.20.84`、`user root`、`remotePort 7080`、`keyPath D:/dsh-frp/id_ed25519` |
| 6 | 首屏批次权重表覆盖不全（75 模块只有 17 条权重） | ❌ 未修 | `src/pocket-host/mobile-boot.mjs:16-34`（17 条）+ `:35`（默认 10000）→ 未列模块按同一估值装箱 |
| 7 | 上游 401（宿主登录轮转）时代理不丢旧 cookie 重试 | ❌ 未修 | `src/pocket-host/proxy.mjs` 全文无「401 → 清 cookie → 重放」路径；壳侧只有 Android 自愈（`MainActivity.java:296-326`） |

未提交的那一笔（turn-guard 按 turn 配额）：✅ 已生效可用。`src/turn-guard.ts:45 VERSION '1.1.0'`、`:228 countGuardInjections`、`:266-286 judge(..., turn)`；`node scripts\test-turn-guard.mjs` 本轮实测跑绿（Node v24.13.0，exit 0）；产物已含新逻辑（`lib/index.js:3091-3141`）；实况日志已出现新口径（`dsh-assistant-turn-guard.log` 2026-11-06 04:04Z 行：`verdict turn=2 steer=false branch=text-ok injected=0/3 dayInjected=0 scoped=turn`）。但**这笔还没 commit、没有 CHANGELOG 条目、没有版本号/ tag**（见 P0-13）。

---

## 3. P0 · 低成本、不动协议、只改插件/壳内部（建议照做，14 条）

> 统一「验证方式」列里，测试脚本落 `scripts/test-*.mjs` 并进 `npm test`（现 CI：`.github\workflows\ci.yml:35-45`）。

**P0-1 给尾快照缓存加上限与清扫**
- 做什么：`map` 加 `maxEntries`（如 512）+ 每次 `run()` 顺手扫一遍过期条目（或 LRU `delete` 最旧），别让过期条目连 payload 一直挂在 resolved promise 上。
- 在哪：[src/client/sessionTailCache.ts](../src/client/sessionTailCache.ts)：20 / 36 / 40。
- 成本：低。风险：低（被淘汰的键下一轮必定重取，语义与 TTL 命中一致）。
- 验证：新增 `scripts/test-tail-cache.mjs` 断言 `size()` 不超过上限；对照实况计数器 `diagnostic.jsonl` 的 `tailCand / tailFetch`（现 1014 / 54）看命中率不降。

**P0-2 给会话面快照缓存加清扫**
- 做什么：同 P0-1（cap + 定时 sweep）；并考虑在 `session/list` 通知处调用已有的 `invalidateAll()`（现在全仓只有创建，没有调用点）。
- 在哪：[src/client/faceSnapshotCache.ts](../src/client/faceSnapshotCache.ts)：37 / 44 / 53 / 60；使用点 [src/client/index.tsx](../src/client/index.tsx):2450,2465-2467。
- 成本：低。风险：低（100ms 窗口本来就短）。
- 验证：扩 `scripts/test-face-cache.mjs` 断言 `cachedIds()` 长度上限；跑长会话（现 1326 条会话）看 WebView RSS 不掉。

**P0-3 turn-guard 日志轮转 + 正文脱敏**
- 做什么：`appendFileSync` 之前判 `size > 200KB` 就 rename 到 `.1`（和 `diagnostics.mjs` 同一套）；把 `text=` 字段改成只留长度与首字符类型（或不留正文）。现在实测：`dsh-assistant-turn-guard.log` 5,725B 在 12:04 仍在增长，且日志里落的是**助手回复前 40 字**（含本机绝对路径）；旁边还留着一份旧独立插件的孤儿文件 `dsh-turn-guard.log`（14,172B，11-05 20:04）没清。
- 在哪：[src/turn-guard.ts](../src/turn-guard.ts)：659（`appendFileSync`，无轮转）；629（`text=` 前 40 字）；对照有轮转的写法 `src/pocket-host/diagnostics.mjs:17-29`。
- 成本：低。风险：低（丢的只是排查文本）。
- 验证：跑一轮托管后看文件大小；新用例断言「写 250KB 后出现 `.1`」。

**P0-4 把 overflow 通知真的接上（先记账，不改行为）**
- 做什么：`attachWsDeflate` 调 `createDownlinkScheduler` 时补 `limits` 与 `onOverflow`，把 `overflowEvents` 送进 `appendDiagnostic`（现在 ws-close 汇总里 `overflow: 0` 就是因为没人调用）。
- 在哪：[src/pocket-host/ws-deflate.mjs](../src/pocket-host/ws-deflate.mjs)：264-288；记账处 `src/pocket-host/downlink-lanes.mjs`:286-290；落盘 `src/pocket-host/diagnostics.mjs`:44。
- 成本：低。风险：无（只加观测）。
- 验证：手机端跑一次长会话开屏，看 `diagnostic.jsonl` 的 `queue.overflowEvents` 是否出现非零值。

**P0-5 让 deflate 队列有上限、失败必 resolve**
- 做什么：① `DeflateQueue/InflateQueue` 的 `queue` 加上限（超限即 `fail()`）；② `push` 在 `this.failed` 时仍要回调（`cb(err)`），否则 `encode()` 的 promise 永不 settle → 下行排空循环 `await` 永久挂住（现在只有 `closed` 会 reject）。
- 在哪：[src/pocket-host/ws-deflate.mjs](../src/pocket-host/ws-deflate.mjs)：129-133、183-187、265-279（`encode` 的 promise）、`:272` 是唯一 reject 路径。
- 成本：低。风险：低（挂死 → 变成明确断开，已有 breaker/心跳兜底）。
- 验证：新增 `scripts/test-ws-deflate.mjs`（现全仓 **0** 处测试引用 `ws-deflate.mjs`）：喂一条 64MB 级消息 + 制造 `failed` 状态，断言 promise 一定 settle。

**P0-6 mobile-batch 只留一份字节**
- 做什么：三副本里删掉 `br`（或 `gzip`），或把 `definitions` 由「8 代缓存」改成「保留定义、按需重算」；至少给缓存加总量上限（现 8 代 × 最多 3 lane × 三份 ≈ 上百 MB）。
- 在哪：[src/pocket-host/mobile-batch.mjs](../src/pocket-host/mobile-batch.mjs)：23-31、62-75（缓存与三份编码在 `:66-68`）。
- 成本：低。风险：低（首屏批次只在 HTML 变化时重算；不可变资产另有 `proxy.mjs:103-109` 的 immutable）。
- 验证：`scripts/measure-mobile-batch.mjs` 连跑 3 次开屏，看宿主 RSS 峰值与批次命中时间。

**P0-7 上行/下行分帧记账 + 硬上限真落地**
- 做什么：先落「超限即丢弃 low 帧 + 计数 + 通知」（保持 high 帧不变），同时给单帧设 2MB 软目标：>2MB 的 low 帧拆成多条 `continuation` 帧（`ws-deflate.mjs` 已有 `rsv1`/`fin` 与解析器，能拼回）。
- 在哪：[src/pocket-host/downlink-lanes.mjs](../src/pocket-host/downlink-lanes.mjs)：286-296；分帧需配套 [src/pocket-host/ws-deflate.mjs](../src/pocket-host/ws-deflate.mjs):274（`rsv1` 判定）、`:297-320`（分片重组）。
- 成本：中。风险：中（客户端必须能重组；分片边界已处理，但 breaker 路径要一起改）。
- 验证：实况断言 `diagnostic.jsonl` 的 `maxFrameBytes` 从 4,416,076 降到 <2MB；`scripts/test-downlink-lanes.mjs` 增用例。

**P0-8 诊断写入去同步化 + 未认证 `page` 写入限流**
- 做什么：`appendFileSync` 改成批量异步（或至少对 `page` 事件也走 `diagRateLimited`）；现 `page` 分支在鉴权之前、且没有 rate limit 调用，公网扫地址（实测 `diagnostic.jsonl` 里已出现 `host 49.234.20.84` / `49.234.20.84:7080` 的 `page` 记录，UA 是 X11 Chrome/Firefox 扫描器）每次 GET 都落盘一次。
- 在哪：[src/pocket-host/proxy.mjs](../src/pocket-host/proxy.mjs)：911-959（诊断端点，先于鉴权）、963-974（`page` 写入，无限流）；`src/pocket-host/diagnostics.mjs`:44。
- 成本：低。风险：低。
- 验证：从公网 `curl` 连打 200 次 `/`，看日志增长与 429 计数。

**P0-9 uploads 目录配额**
- 做什么：给 `$DSH_HOME/dsh-pocket/uploads` 加总量上限（如 500MB / 最近 200 个文件）+ 启动时清旧；现在只限单文件 25MB。
- 在哪：[src/pocket-host/fs-rpc.mjs](../src/pocket-host/fs-rpc.mjs)：193-213（`saveUpload` 无总量/数量上限，落盘见 `:206-211`）；`uploadsDir` 见 `:21-22`，`MAX_LIST_ENTRIES` 见 `:45`。
- 成本：低。风险：低。
- 验证：连续上传后看目录大小；新增用例断言「超限后返回 `quota-exceeded`」。

**P0-10 SSH 清理命令改参数化，别再拼 PowerShell 字符串**
- 做什么：把 `ps` 串里的 `${needle}` / `@${cfg.host}` 换成传参（`-EncodedCommand` base64，或 `execFn('ssh', ['-o', ..., 'host', 'cmd'])` 数组）；`normalizeSshTunnelConfig`（`:130-141`）也补一次 host 校验（现在只在 setter 路径 `settings.mjs:303-317` 有 `HOST_RE`，手工改 settings.json 可绕过）。
- 在哪：[src/pocket-host/ssh-tunnel.mjs](../src/pocket-host/ssh-tunnel.mjs)：55-61、85-90、126-137；校验源 [src/pocket-host/settings.mjs](../src/pocket-host/settings.mjs):303-317。
- 成本：低。风险：低（只改内部调用形态）。
- 验证：`scripts/test-ssh-tunnel-args.mjs`（新增）断言「host 含 `;`/`"` 时被拒」+ 远端清理仍只杀目标端口。

**P0-11 构建产物漂移门控 + lockfile**
- 做什么：`build` 后比对 `lib/*.js` hash（或 CI 加 `git diff --exit-code lib/`）；补 `package-lock.json` 并把 CI 换成 `npm ci`（现 CI 注释自认「无 lockfile → `npm install` 按 semver 解析」）。
- 在哪：证据：`src/turn-guard.ts` mtime 07:51:37 晚于 `lib/index.js` 07:51:09（内容抽查一致，但顺序说明**产物可能落后源码**）；`.github\workflows\ci.yml:5,30-33`；`D:\dsh-pocket\scripts\build-installed-client.mjs:8-10` 只读写安装副本 → 开发克隆 bundle 永久过期。
- 成本：低。风险：无。
- 验证：`npm run build` 后 `git status --porcelain lib/` 应为空。

**P0-12 壳侧 401 自愈补总闸（不动协议，随下次发版）**
- 做什么：① 正文嗅探「没有 authentication required」时**不要**把计数归零（现归零可绕开 `>=4` 硬门，形成无限 `loadUrl`）；② 加时间窗/退避；③ `recoverWebView` 时重置 `authRecovering`（现在渲染进程被杀后标志可能永久 true，后续自愈被全短路）；④ 第 3 次不要 `removeAllCookies(null)` 不分 origin（连访问密码一并清）。
- 在哪：`D:\dsh-app\app\src\main\java\com\chenpan\assistant\MainActivity.java`：296-326（自愈入口）、312-313（归零）、234-253（`recoverAuth`，235 互斥 / 238 `>=4` / 245-247 全清 cookie）、206-228（`recoverWebView`，不重置 92-93）。
- 成本：低（纯壳逻辑）。风险：中（改错会削弱自愈；需真机验证）。
- 验证：`adb shell` 造 401 循环，看自愈次数上限与 `dsh_pocket_token` 是否保留；发版前用 P0-14 的产物门控核对签名。

**P0-13 把 turn-guard 这笔按 turn 配额改动收尾（版本/CHANGELOG/commit）**
- 做什么：这笔修改目前在工作区（`git status` 四个 M 文件，+297/−47），`VERSION = '1.1.0'`（src:45）与包版本 0.2.16、CHANGELOG 0.2.16 那一节都没有对应条目；仓库**无任何 tag**（`git tag --list` 空）。发版一致性门控 `scripts/test-release-consistency.mjs:25-31` 只要求「CHANGELOG 有当前版本那节」，改不动它。
- 在哪：`src/turn-guard.ts:45`；`CHANGELOG.md`（最新节 0.2.16 = :7）；`scripts/test-release-consistency.mjs:19-31`。
- 成本：低。风险：无（但必须先确认宿主重启生效）。
- 验证：`node scripts\test-release-consistency.mjs` 跑绿 + `git log --follow src/turn-guard.ts` 出现该笔 commit。

**P0-14 泄密残留清理（涉密，低成本必做）**
- 做什么：① 轮换 `D:\dsh-pocket\.git\config` 里内嵌明文 GitHub PAT 的 origin URL（改成不带凭据的 URL + 凭据助手/环境变量）；② `assistant.keystore` 口令从 `build.ps1` 与 README 里撤走（改用环境变量），并补 `.gitignore`；③ 把 `D:\dsh-app` 纳入 git 之前先清掉 `out\` 里的签名材料与本机私人路径记录。
- 在哪：`D:\dsh-pocket\.git\config`（origin URL 含 `ghp_…`）；`D:\dsh-app\build.ps1:43,149`（口令明文）、`:141-144`（`-dname CN=…L=Xiaogan,ST=Hubei`）、`D:\dsh-app\README.md:59`；`D:\dsh-app` 无 `.git`/`.gitignore`（实测）；`D:\dsh-app\out\send-list*.txt`、`out\screen-*.png` ×19。
- 成本：低。风险：无（纯清理；但**必须真轮换 PAT**，只改 URL 不换 token 等于没修）。
- 验证：`git -C D:\dsh-pocket remote -v` 不再出现 token；旧 token 在 GitHub 侧已撤销；新 `git status` 里 `out/`、`assistant.keystore` 被忽略。

---

## 4. P1 · 需改协议 / 需宿主批准 / 需发版或需你点头（5 条）

**P1-1 下行大帧协议：开屏快照分段下发（真正的 a 项）**
- 做什么：要么插件把 >2MB 的 low 帧拆片（P0-7 是记账版），要么请宿主在 `session-controller` 侧把 baseline/开屏快照按 `turnWindow` 分批下发。插件单方面拆帧对客户端不透明（客户端拿到的是 mux 帧），需要一次协议讨论。
- 在哪：宿主 `@deepseek-ai/dsh-api-session-controller/lib/types/control.js:35,43-60` ↔ 源仓 `src/control.ts:47`；插件 `src/pocket-host/downlink-lanes.mjs`。
- 成本：中（改协议）/高（改宿主）。风险：中（乱序、重组失败即白屏）。
- 验证：真机开长会话（1326 条会话那条）看首屏时间 + `ws-close.queue.maxFrameBytes`。

**P1-2 宿主 ControlQueue 上限与合并**
- 做什么：请宿主给 `ControlQueue` 加容量、并按 `sessionId+key` 合并投影帧（插件无法代劳，插件只能在自己下行侧合并——`downlink-lanes.mjs:270-284` 已做）。
- 在哪：产物 `lib/types/control.js:66-106`（`:67` 无容量 Deque、`:70-77` 无条件 push）；源仓 `src/control.ts:82-121`，broadcast `:77-79`。
- 成本：中（宿主 PR）。风险：中（合并改变帧语义，需宿主测试）。
- 验证：宿主侧压力测试（高频 title/running 抖动）看队列长度。

**P1-3 把宿主视图配置改回瘦身档（g 项收尾，纯本机配置）**
- 做什么：`cordis.patch.yml:17-18` 的 `detailed/detailed` 改回插件层给的 `condensed/disabled`（插件层 `cordis.patch.yml:67-68` 已给好值）。**注意：这要重启 DSH Desktop 才生效，本任务不许重启，所以只做建议不动手。**
- 在哪：`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml:14,17,18`（298 行 / 15,394B / mtime 11-06 11:42:36）；层级说明见该文件 `:1-3` 注释与备份链（同目录 21 个 `.bak-*`）。
- 成本：低。风险：低（可一键回退，备份已留）。
- 验证：重启后真机看会话详情行数与 DOM 节点数（现注释自述 ~2 万节点）。

**P1-4 公网入口传输加密与隧道加固（finding 5 的正解）**
- 做什么：三件：① `StrictHostKeyChecking=no`/`UserKnownHostsFile=NUL` → `accept-new` + 真 known_hosts 文件；② `user: root` → 专用低权账户（插件在 VPS 上跑 `ps`/`kill` 清理，见 `ssh-tunnel.mjs:277,474-485`）；③ 入口从 `http://host:7080` 换成 TLS（Cloudflare named tunnel 已是 https：`tunnel.mjs:501-604`；或 VPS 侧 nginx）。首屏与 PIN 现在全程明文。
- 在哪：`src/pocket-host/ssh-tunnel.mjs:168-169,190-191`；`urlOf` 的 `http://` 见 `:573`；实况 `C:\Users\Administrator\.dsh\dsh-pocket\settings.json:4-12`；对照 `src/pocket-host/tunnel.mjs:1,492-604`。
- 成本：中（需你确认指纹/换账户/装证书）。风险：中（改错即连不通；已有退避与状态页可诊断）。
- 验证：`ssh -o VerifiedHostKeyFile=` 一次；真机开手机访问，看 `diagnostic.jsonl` 的 `page`/`ws-close` host 字段是否变 https。

**P1-5 手机→本机配置的权限分层（真正的越权链）**
- 做什么：`POST /api/assistant/config` 现在只要 PIN 过即可写：`allowAllLocalPaths: true` + `confirm:"ALLOW-ALL"`（口令是**源码里公开常量**，`assistant-local-config.tsx:188` 与 README 都写着）→ `path-guard.ts:125` 立即全放行 → 工作台 `fs`/`git`/`mkdir`/`term`/`open-folder`（`src/index.ts:207-268,640-708`，term 走 `powershell.exe` 且 env 白名单 `path-guard.ts:154-168`）就变成整盘读写+可起 shell；`persona` 字段还会把内容写进 `AGENTS.md` 托管段（`assistant-config.ts:397-403` → `assistant-home.ts syncPersonaSection`，`applyConfigSideEffects` `:551-561`）= 给后续 agent 注入人设（间接提示注入）。建议：把「危险字段」限定为**仅本机回环可写**（或需要宿主 UI 二次确认）。
- 在哪：`src/assistant-config.ts:584-597`（无来源判定）、`src/path-guard.ts:74-100,125`（默认根含 `homedir()`）、`src/index.ts:696-701`（fixed cmd + 绝对路径参数，无 shell，安全）。
- 成本：中（需改协议：区分本机/远程写权限）。风险：中（可能挡住你从手机改配置的正常用法）。
- 验证：从手机 POST 一次 `allowAllLocalPaths`，看是否 403/需确认；再从手机 POST `persona`，看 AGENTS.md 托管段是否被改。

---

## 5. P2 · 观察项与本轮新增薄弱点（六类 36 条，全部带证据；不用马上动手的那几条已标「观察」）

### A. 性能 / 内存
1. `sessionTailCache.ts:20,36,40` — 无上限、过期条目连快照 payload 长期挂在 resolved promise 上。危害：手机 WebView 长时间开着控制室时稳定增长。→ P0-1。
2. `faceSnapshotCache.ts:37,44,53` — 无 cap、无 sweep、每 sid 存整棵会话面投影；全仓无 `invalidate` 调用点（`index.tsx:2450,2465-2467`）。危害：会话数增长后常驻内存。→ P0-2。
3. `ws-deflate.mjs:43-44` — `push(chunk)` 每次 `Buffer.concat` 整个已累积缓冲；上游 4.4MB 帧按 TCP 切片到达 → 每片重拼一次（近 O(n²)）。危害：隧道下行 CPU 尖峰、手机卡顿。验证：加 `maxFrameBytes` 后测吞吐。
4. `mobile-batch.mjs:66-68` — 每代三份 Buffer 常驻（见 P0-6）。
5. `web-rpc.js:150-173` — `pocketHttpBridge` 把整个上游响应读进 `chunks` 再 `Buffer.concat`；17MB+ 长会话历史一次进内存（代理侧已有流式压缩 `proxy.mjs:1232-1265`，RPC 桥没有）。危害：宿主进程瞬时峰值。建议：改流式管道。成本中，风险中。
6. body 级 subtree/attributes 观察者共 10 处：`mobile-apply.tsx:524,590,632,692`、`fileGuard.ts:222,248`、`drawer-chrome.ts:112`、`splitObserver.ts:9`、`split.tsx:1099`、`bottomOverlay.ts:302`。`compositionGate` 只把**回调**降到每 300–500ms 一次，mutation **记录**照样为每个观察者生成。危害：2 万节点页面上流式渲染时观察者记录复制成本线性叠加。建议：合并成一条观察者 + 分发（P1 级别，成本中）。
7. `turn-guard.ts:164,273,312` — 每个「即将收尾」的 turn 做 2 次全量 `snapshotEvents()` 扫描（`judge` 里的 `eventsOf(session)` 与 `lastAssistantEvent(session)`），补刀时再多一次 `lastToolError(session)`。危害：长会话（实测数百 step）每步 O(N) ×2-3。建议：把注入计数改为增量记账（`ctx.on('user/message')` 累加），`judge` 只读最后一条 assistant。成本低-中，风险低。

### B. 健壮性
8. `ws-deflate.mjs:130,184,265-279` — `failed` 时 `push` 不回调 → `encode()` promise 永不 settle → 下行排空循环永久挂住（现只有 `closed` 会 reject，见 `:272`）。→ P0-5。
9. `downlink-lanes.mjs:286-292` — 「硬上限」名不副实（只记账仍入队），且 `onOverflow` 无人接（`ws-deflate.mjs:264-288`）。→ P0-4/P0-7。
10. `proxy.mjs` 全文无 `req.setTimeout`/`proxyReq` 总超时（grep 结果只有 `destroy`，无 `timeout`；`:1446,1453`）——上游 dsh web 卡死时该请求一直占一条 client socket。建议：给 `proxyReq` 加 30s 整体超时。成本低，风险低。
11. `proxy.mjs:103-109` 与 `:1221-1225` 之间缺一致策略：不可变资产走 immutable，注入过的 HTML 却把 `etag/last-modified/expires` 全删 → 每次整页重下（配合 d 项，见 §6 划掉）。
12. `settings.mjs:41` / `index.js:65-71`（`writePinToFile`）的 `mode: 0o600` 在 Windows 上不等效（NTFS ACL 不认 Node 的 mode），PIN/sessionKey 明文文件靠默认 ACL。建议：改用显式 `icacls` 或宿主凭据助手。成本中，风险低（本机已有 ACL）。
13. `index.js:475-479` `startProxy()` 失败即不重试（`ssh-tunnel.mjs` 反而有全套退避 `:631-647`）——一次端口占用把手机访问整段关到重启。成本低，风险低。
14. 壳侧自愈竞态：`MainActivity.java:312-313` 归零 + `235/238` 硬门 + `206-228` 不重置 `authRecovering` → 循环自愈 / 永久短路。→ P0-12。

### C. 安全 / 隐私
15. `web-rpc.js:292-293` — status RPC 明文回显 `accessToken`（公网 PIN）与 `lanToken`（局域网 PIN）；公网入口的一台设备拿到 status 就顺带知道局域网密码。另 `:295 lanEnabled ?? true` 与 `settings.mjs:62-67` 的「新装默认 false」口径不一致。成本低，风险中。
16. `web-rpc.js:419` `pocket.fileRead`（绝对路径、≤4MB）与 `:466` `fsList`、`fs-rpc.mjs:32`（`resolvePath`）、`:82`（`listDrives` A–Z 盘符枚举）——**这条链不走 `path-guard`**（guard 只护工作台路由 `src/index.ts:207-268,668-708`）。加上默认根含 `homedir()`（`path-guard.ts:89`），手机 PIN 可枚举整个用户目录。建议：给 fs-rpc 也套同一 allowlist。成本低，风险低-中（可能挡住合法用法）。
17. `assistant-config.ts:584-597` + `path-guard.ts:125` + `persona` 写 `AGENTS.md`（`:397-403`, `:551-561`）= 见 P1-5 的越权/间接注入链；`confirm` 常量在源码与文档里公开（`assistant-local-config.tsx:188`）。
18. `ssh-tunnel.mjs:168-169,190-191` `StrictHostKeyChecking=no` + `UserKnownHostsFile=NUL`，且 `sshTunnel.user = root`（实况 `settings.json:8`）：中间人可拿整条 http 会话（含 PIN、cookie）。→ P1-4。
19. `turn-guard.ts:629` 把助手回复前 40 字（含本机绝对路径）明文写盘；`proxy.mjs:933-939,963-974` 把 UA/IP 明文写盘且 `page` 未经鉴权与限流。→ P0-3/P0-8。
20. `D:\dsh-pocket\.git\config` 的 origin URL **内嵌明文 GitHub PAT**（`ghp_…`）。建议：立即轮换该 token、改 `credential.helper` 或环境变量。成本低，风险高（若仓库外发即泄露）。
21. 壳侧：`MF:24 usesCleartextTraffic=true` 无 `networkSecurityConfig`、`MainActivity.java:171 MIXED_CONTENT_ALWAYS_ALLOW`、`:184-186 setSafeBrowsingEnabled(false)`、`:188-190` 第三方 cookie 全接受、`:356-367 route()` 把任意 scheme 直接 `ACTION_VIEW`（远端页可诱发 `intent://`/`file://`/`content://`）、`:422-423` 权限已给即整包 `grant()` 无二次确认、`:65 DEFAULT_URL http://49.234.20.84:7080` 写死进 APK、`MF:18 allowBackup=true` 无 backup 例外（`home_url` + WebView cookie/DB 可被系统备份导出）。建议：`networkSecurityConfig` 只放本机/VPS 域、scheme 白名单只留 http/https、401 自愈保留 cookie origin 精确清除（现 `:255-271` 已只按新 origin 逐名清，旧端口残留）。成本中，风险中。

### D. 可维护性
22. 测试覆盖偏斜：`scripts/` 只有 6 处引用 `src/pocket-host/`（`downlink-lanes / proxy / mobile-boot / runtime / settings / index`），**ssh-tunnel.mjs(951 行)、ws-deflate.mjs(377)、tunnel.mjs(632)、web-rpc.js(533)、fs-rpc.mjs(214)、mobile-batch.mjs(111) 零直接测试**。成本低，风险低。
23. 无 tag、无 CHANGELOG 条目对应新改动（见 P0-13）；`D:\dsh-app` **不是 git 仓库**（无 `.git`/`.gitignore`），`out\` 留着 `*-unsigned.apk`、`*-aligned.apk`、`META-INF/ASSISTAN.RSA+SF`、`*.idsig`、`out\send-list*.txt`（内含本机私人路径）、`out\screen-*.png` ×19（DSH 页面截图）→ 转发该目录即外泄签名材料与本机影像。
24. 悬空链接残留：`profiles\desktop\node_modules\@deepseek-ai` 下 9 个 SymbolicLink 目标根 `D:\DeepSeek harness desktops` 已不存在（真实目录是 `D:\DeepSeek Harness Desktop`），声明在 `profiles\desktop\package.json:5,7-14`；仅 `:6` 的 `dsh-client-ui-conversation` 有效 → 下次装/卸插件可能报「找不到包」。
25. 诊断日志孤儿：`dsh-turn-guard.log`（旧独立插件遗留）与 `dsh-assistant-focus.log`(140KB) 无清理路径。
26. `web-routes.ts:31-36` 直接操作宿主私有路由表（`server.exact`/`prefixes`）来接管旧泄漏路由 —— 宿主实现一变即失效（注释已自认 `:29-30`）。属观察项。
27. 文档漂移：`README.md:10,25` 写「1 秒」而实现是 1100ms（`MainActivity.java:700`）；`README.md:7-8` 示例产物名仍 1.0.0 而 dist 已是 1.0.2；`docs/guide-安装说明.md:3` 声称与 `tools/make_guide_friend.py` 一一对应，实为脚本硬编码文案（py:61-130 不读 md）。

### E. 手机 UX
28. 长会话截断仍未做（f 项）：插件只在控制室卡片分页（`OrbOverlay.tsx:251`），会话详情页无任何裁剪/懒加载；宿主 `maxMessages: 500` 未调（`lib/client.js:2178`）。
29. 401 自愈 UX：第 3 次 `removeAllCookies(null)` 连访问密码一起清（`MainActivity.java:245-247`），用户要重输 PIN；`clearAuthCookies`（`:255-271`）按新 origin 逐名清、旧端口清不到 + `:268-270` 空 catch。
30. http 入口下麦克风不可用而壳侧**完全没有提示**（`MainActivity` 全文 0 处 getUserMedia/isSecureContext 文案），只有文档层说明；`MF:7-9 RECORD_AUDIO` 已申请但用不上。建议：错误页/顶栏加一句「要语音请走 https」。成本低，风险无。
31. 无预热与无退缓存：`MainActivity.java:183 LOAD_DEFAULT`，全仓无 `preConnect`/`setOffscreenPreRenderer`/`processPriority`/`clearCache`/`onLowMemory`（grep 0 命中）→ 首屏冷启动与 WebView 被杀后重开的代价都在用户身上。成本低（一行 API），风险低。
32. 保活只有 `largeHeap`+`singleTask`+`onRenderProcessGone` 重建（`MF:22,32`；`MainActivity.java:333-337`）；无 Service/WAKE_LOCK。属设计决定，观察。

### F. APK 壳 / 发布链
33. `build.ps1:8-9` `VersionName` 默认 1.0.0 与 `VersionCode=1` 默认，两者与产物名解耦（`:59`）→ 可产出「版本名不同、versionCode 相同」的包，装机不升级。
34. `build.ps1:155` `apksigner verify` 后无 `$LASTEXITCODE` 检查 → 验签失败仍打印「完成」；无 `aapt2 badging`、无 `Get-FileHash`（grep 0）。
35. `build.ps1:43` keystore 口令明文 `dsh-assistant-2026`、`:149 --ks-pass "pass:…"` 进命令行、`:141-144 -dname CN=…L=Xiaogan,ST=Hubei` 身份外泄、`assistant.keystore` 落仓库根且无 `.gitignore`；README 也把口令写进文档。
36. dist 是手工改名复制（脚本不写 `dist\`，实测 `dist\个人助手-通用版-1.0.2.apk` 与 `out\assistant-generic-1.0.2.apk` SHA256 一致）；personal 1.0.2 只存在于 `out\`，dist 没有 → 发版清单不可靠。

---

## 6. 建议划掉 / 不值得做的项

1. ❌ **b 项（SSH `-C` 压缩）**：WS 已 permessage-deflate 重框、HTTP 已 brotli q6（实测 1.00MB vs 1.20MB，`proxy.mjs:1232-1236` 注释），再叠 `-C` 只给 ssh 隧道字节加 CPU，收益近乎 0。
2. ❌ **自建 Service Worker（d 项的 SW 半截）**：入口是 http 明文（`ssh-tunnel.mjs:573`、`MainActivity.java:65`），**非 secure context 不能注册 SW**；要做就得先做 P1-4（TLS）。先把 SW 划掉，只做「不可变资产 + 保留 HTML 验证器」这一半。
3. ❌ **插件侧自己做代码分割（e 项的 `import()` 半截）**：bundle 表由宿主 `dsh-client-modules` 生成（`lib/index.js:160,986` 的 immutable 即其产物），插件无权改表；插件侧已经做了 4 模块省略 + 3 lane 装箱，再做分割只会和宿主表冲突。改成观察项。
4. ❌ **给 turn-guard 再加「按自然日硬阈值」**：新笔已给 `dayInjected` 只进日志（`src/turn-guard.ts:183-184`），实况 `branch=text-ok injected=0/3` 说明判定没被撑满；加硬闸会误伤 186 步那种长 GUI 任务。
5. ❌ **给 fs-rpc 另写一套 allowlist**：与 `path-guard` 重复；正解是把 `path-guard` 套到 fs-rpc 上（见 §5 C16），或只做 uploads 配额（P0-9）。
6. ❌ **在壳里做虚拟列表 / DOM 裁剪（f 项的壳侧半截）**：宿主 Lexical/React 渲染，壳层裁剪 DOM 会打断组合输入与滚动锚定，风险高于收益；f 项只在「宿主视图改回 condensed」（P1-3）+ 插件分页上收口。
7. ❌ **调小宿主 `maxMessages: 500`**：那是宿主分页语义，插件无权改且会影响电脑端；改由 P1-2 一并讨论。
8. ❌ **给 APK 上 WebView 缓存（`LOAD_CACHE_ELSE_PAGE` 之类）**：入口每跳都带 `?dsh-pocket-auth=1` 注入与 launch token（`proxy.mjs` 的注入分支 + `index.js:383-392`），缓存旧 HTML 会跳过补丁（正是 `:1218-1220` 注释里写过的坑）；只做 `preConnect` 预热即可（§5 E31）。
9. ❌ **重写 dsh-pocket 为单一源**：dsh-assistant 已经靠 junction 收口（`package.json:21`）；dsh-pocket 侧只需把「改哪边」写清 + 让 `build-installed-client.mjs` 也刷新 dev 副本（低成本一行），不必合并仓库。

## 7. 基线七项一句话处置建议

- a → 走 P0-7（先记账/真硬上限），协议级拆帧留给 P1-1。
- b → 划掉。
- c → 插件侧无解，P1-2 提宿主 PR；插件下行合并已存在。
- d → 保留插件 immutable；补「HTML 不删验证器 + 宿主 ETag/304」，SW 划掉。
- e → 保留 4 省略 + 3 lane；权重表补 `settings-account`/`plugin-manager`（把 17 条扩到覆盖全部模块，成本低，属 P0 附加项）。
- f → 只做 P1-3（宿主视图回 condensed）+ 插件分页；不裁 DOM。
- g → 只剩 `transcriptView/performanceUsage` 两项本机值需要改，`lanEnabled` 已是 false；改完要重启宿主（本轮没做）。

## 8. 本轮只读声明

未修改任何源码/产物；未重启 DSH Desktop；未重打包 `app.asar`；未触碰 `LICENSE`/`NOTICE`；未 commit、未 tag。执行的读操作：`git status/log/tag`、`node scripts\test-turn-guard.mjs`（跑绿，exit 0）、`Get-FileHash` 比对 repo↔安装副本、读取 `diagnostic.jsonl` 尾行与计数器、读取 `dsh-pocket/settings.json`、`profiles\desktop\cordis.patch.yml` 关键行、asar 头部解析（子代理，未改宿主）。新增文件只有本份报告。
