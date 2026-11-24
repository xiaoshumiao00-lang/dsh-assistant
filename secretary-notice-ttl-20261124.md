# 通知卡存活时间：10 分钟 → 10 秒（2026-11-24）

代码提交：`fa38141`（本地，未 push）；本报告单独一条 docs 提交。

## 一、结论先行

- 通知卡 TTL 由 10 分钟改成 **10 秒**（`NOTICE_CARD_TTL_MS = 10 * 1000`）。
- 10 秒精度不用分钟文本硬凑：**主判据是「页面第一次看到这张通知卡」的到达时刻**（`Date.now()`，按 cardKey 落 localStorage），钟面文本只作兜底。
- 为什么不用宿主 DOM 的秒级字段：核实过没有。宿主 `MessageIconActions` 只渲染 `data-clock="start|end"` + `formatMessageClock` 的分钟文本；整份 `app.asar` 里 `data-message-time` / `data-created-at` / `data-clock-ms` 一次都没命中。历史接口 `item.time` 是 epoch ms 但只覆盖分页取回的老卡，最新那张卡不在其中，不能当主判据。
- 误差上界（都是**晚**，没有一条往早里偏）：秒级路径 **≤1.5 秒**（观察延迟 ≤0.5 秒 + 挂载层定时器下限 1 秒）；只有钟面文本时 **≤59.999 秒**。认不出钟面又没到达记录 → 永不过期（没有证据不许收）。
- 刷新后不丢：到达记录在 localStorage，整页刷新沿用同一条；只有「存储被清 / 换浏览器 profile / 通知到达时秘书页没开」才退到钟面兜底。

## 二、改了哪几个文件哪几处

| 文件 | 行号 | 改了什么 |
| --- | --- | --- |
| `src/client/pocket/orb/secretary-cards.ts` | 1670–1698 | 整段注释重写：写清需求原话、①精度来源 ②钟面兜底 ③两条判据取更早 ④认不出钟面 ⑤刷新后的退化与修剪，以及两条判据的误差上界 |
| `src/client/pocket/orb/secretary-cards.ts` | 1699 | `NOTICE_CARD_TTL_MS`：`10 * 60 * 1000` → **`10 * 1000`** |
| `src/client/pocket/orb/secretary-cards.ts` | 1703 / 1705 | 新增 `NOTICE_ARRIVAL_STORAGE_KEY`（`dsh.assistant.secretary.notice-arrival`）、`MAX_NOTICE_ARRIVAL_KEYS = 200` |
| `src/client/pocket/orb/secretary-cards.ts` | 1745 | 新增 `NoticePrecision = 'seconds' \| 'minute' \| 'none'`（精确度来源可断言、可写报告） |
| `src/client/pocket/orb/secretary-cards.ts` | 1758–1781 | 新增 `noticeExpiry(row, now, ttl, arrivalAt)`：秒级 + 钟面两条判据合成，取更早的过期时点；用户卡永远不收；带日期钟面直接收 |
| `src/client/pocket/orb/secretary-cards.ts` | 1782–1799 | `nearestNoticeExpiryMs` 增加第 4 个参数 `arrivalOf`（挂载层定时器按「到达 + 10 秒」排，不再固定等分钟末） |
| `src/client/pocket/orb/secretary-cards.ts` | 1800–1810 | `noticeCardExpired` 增加第 4 个参数 `arrivalAt` |
| `src/client/pocket/orb/secretary-cards.ts` | 1828–1903 | 新增 `createSecretaryNoticeArrivalStore`：`at/observe/observeAll/prune/snapshot/reset`；localStorage + 内存兜底；**只增不改**（幂等）；按 200 条修剪；写失败静默降级 |
| `src/client/pocket/orb/secretary-cards.ts` | 1905–1911 | 新增进程内单例 `noticeArrivalStore()` |
| `src/client/pocket/orb/secretary-cards.ts` | 1160–1166 | `buildSecretaryPagerCards` 过滤过期通知卡时带上到达时刻（口径与卡片渲染同一套） |
| `src/client/pocket/orb/secretary-cards.ts` | 2490 附近 | 测试面导出补 `NOTICE_ARRIVAL_STORAGE_KEY / MAX_NOTICE_ARRIVAL_KEYS / noticeExpiry / createSecretaryNoticeArrivalStore / noticeArrivalStore` |
| `src/client/pocket/orb/SecretaryUserCard.tsx` | 10、11 | 头部注释：满 10 分钟 → 活 10 秒（改档说明） |
| `src/client/pocket/orb/SecretaryUserCard.tsx` | 38 | 导入 `noticeArrivalStore / NOTICE_CARD_TTL_MS` |
| `src/client/pocket/orb/SecretaryUserCard.tsx` | 157–160 | 卡片渲染取到达时刻 → `noticeCardExpired(row, now, TTL, arrival)`（没有记录就退钟面） |
| `src/client/pocket/orb/SecretaryUserCard.tsx` | 415–418 | 扫描里 `observeAll(...)`：**第一眼看到**这批通知卡就地记到达时刻（在 `buildSecretaryPagerCards` 之前，首帧那张卡也有 10 秒起点） |
| `src/client/pocket/orb/SecretaryUserCard.tsx` | 432–434 | 过期定时器按到达时刻排（`nearestNoticeExpiryMs` 传 `arrivalOf`） |
| `scripts/test-secretary-cards.mjs` | 321–343 / 547–575 | 旧「10 分钟」断言全改 10 秒口径：TTL=10000、满 10 秒还不许提前收（钟面兜底等分钟末）、分钟末+10 秒才收；带日期钟面「远超 10 秒」 |
| `scripts/test-secretary-cards.mjs` | 577–643 | **新增两条用例**：① 秒级来源（到达+10 秒到点；9.5 秒还在、10.5 秒已收；差 1ms 不收、整 10 秒收；幂等不改；刷新后同一条记录；定时器按 10 秒排）② 只有钟面文本（**刚好 3 秒仍显示**；误差上界 ≤60 秒；两条判据取更早；钟面已过期就收） |
| `scripts/test-secretary-card-visual.mjs` | 17 / 279 / 286 / 794 | 文案与注释：满 10 分钟 → 活满 10 秒（fixture 的空壳是手写 DOM，判据不依赖 TTL） |
| `scripts/smoke-secretary-page.mjs` | 1343 | 现场探针 `TTL_MS = 10 * 1000` |
| `scripts/smoke-secretary-page.mjs` | 988 / 1338–1339 / 1391 / 2077 | 现场文案与用例名改 10 秒口径 |
| `scripts/smoke-secretary-page.mjs` | 2104–2120 | 刷新后先 `open-assistant` 回固定秘书会话 + 等 `body[data-dsh-secretary="1"]` + 等第一张卡出现（最多 30 秒），替代写死的 6 秒 |
| `scripts/smoke-secretary-page.mjs` | 2314 附近 | 量插话/过程行之前同样先等卡片层挂上 |
| `scripts/smoke-secretary-page.mjs` | 1951–2010 | 10 秒 TTL 下「点 chip → 跳走 → 回来」会超过存活期：现场补投一条同样通知再验点击语义；断言改成可观测结果（点完 chip 红点不出现、`data-unread=0`） |
| `lib/client.js` / `lib/index.js` | — | `node build.mjs` 重建产物 |

未动（红线全部保持）：`SECRETARY_READONLY_TOOLS`、`SECRETARY_GOAL_TOOLS`、`secretaryToolDenied`、通知回合闸（`src/assistant-secretary.ts` 里那句「10 分钟兜底过期」是**工具闸**的陈旧窗口，与卡片 TTL 无关，按红线未碰）、`steering` 插话卡片、附件卡片规则、`FOLD_*` 预算与 162px、朗读按钮/32px 标识、900/600/200 观感口径。

## 三、10 秒精度到底怎么保证的

**时间源（按优先级实测的顺序）**

1. 宿主 DOM 的秒级字段：**没有**。`D:\DSH Desktop\resources\app.asar` 里搜 `data-clock` 只有两处命中——一条 CSS（`.actions[data-clock=end]`）和 `MessageIconActions` 组件（`"data-clock": clock` + `formatMessageClock(time, t, day)` 的文本子节点）；`data-message-time` / `data-created-at` / `data-clock-ms` 全程 0 命中。所以 DOM 上拿不到 epoch。
2. 通知载荷/历史接口的 epoch：`GET /api/assistant/secretary/history` 的每个 item 带 `time`（epoch ms，冒烟日志里实测 `"time":1795528712403`），但只覆盖**分页取回的老卡**；最新那张卡是新消息，不在已取回的窗口里，不能当主判据（也解释了为什么不能用它：要多一次取数、还拿不到最新）。
3. **采用**：页面首次观察到该通知卡时记 `Date.now()`（`observeAll` 在扫描里、在挂载卡之前），按 cardKey（`notice:<宿主消息 key>`）写 localStorage。

**误差上界（全部偏向晚）**

| 路径 | 过期时点 | 误差上界 | 方向 |
| --- | --- | --- | --- |
| 秒级（有到达记录） | `到达时刻 + 10 秒` | 观察延迟 ≤0.5 秒（扫描去抖 `SCAN_DEBOUNCE_MS=120ms` + 首帧补扫 `RESCAN_DELAY_MS=400ms`）+ 挂载层定时器下限 `Math.max(1000, …)` ⇒ **≈1.5 秒** | 只晚 |
| 钟面兜底（没到达记录） | `那一分钟的最后 + 10 秒` = 分钟起点 + 59.999 秒 + 10 秒 | 钟面把发送时刻最多往前推 59.999 秒 ⇒ **最坏晚 59.999 秒** | 只晚 |
| 两者都有 | 取更早的那个 | 两个上界都只晚 ⇒ 取早者仍不早于真实过期时点 | 只晚 |
| 认不出钟面且无到达记录 | 不设过期（`expired=false`） | — | 永不过期 |

**为什么不可能提前收（硬证明）**：设真实发送时刻 `S`、TTL `T=10s`。
- 到达判据：`A ≥ S`（观察只会晚于发送）⇒ `A+T ≥ S+T`。
- 钟面判据：`M = minuteStart(S) + 59999 + T`，而 `minuteStart(S) ≤ S ≤ minuteStart(S)+59999` ⇒ `M ≥ S+T`。
- 合成判据取 `min(A+T, M)`，两者都 `≥ S+T` ⇒ 合成过期时点也 `≥ S+T`。∴ 任何一条判据判「过期」时，真实 10 秒一定已经过完。测试里两条用例把这个性质分别锁死（9.5 秒还在 / 10.5 秒已收；只有钟面时「刚好 3 秒」必须仍显示）。

**整页刷新后怎么退化**

- 到达记录在 localStorage（`dsh.assistant.secretary.notice-arrival`，`{cardKey: epochMs}`，最多 200 条、只增不改），刷新后沿用同一条 ⇒ 刷新不损失精度，也不需要重读会话日志、不改宿主数据。
- 只有下列情况退到钟面兜底（误差 ≤59.999 秒晚）：存储被清、换了浏览器 profile、通知到达时秘书页没开（扫描只在 `secretaryPageActive()` 时跑，回来后首次观察即记为到达）。
- 写 localStorage 失败 / 非浏览器环境：静默降级成进程内 Map，10 秒判据在同一次会话内照旧生效。

## 四、改前 / 改后关键代码

改前（`secretary-cards.ts`）：

```ts
export const NOTICE_CARD_TTL_MS = 10 * 60 * 1000
export function noticeCardExpired(row, now = Date.now(), ttlMs = NOTICE_CARD_TTL_MS): boolean {
  if (row.kind !== CARD_KIND_NOTICE) return false
  return noticeExpiryFromClock(row.clockText, now, ttlMs).expired   // 只有分钟文本：分钟末 + TTL
}
```

改后：

```ts
export const NOTICE_CARD_TTL_MS = 10 * 1000
export function noticeExpiry(row, now = Date.now(), ttlMs = NOTICE_CARD_TTL_MS, arrivalAt = null): NoticeExpiryDetail {
  const clock = noticeExpiryFromClock(row.clockText, now, ttlMs)      // 钟面兜底（分钟末 + TTL）
  if (row.kind !== CARD_KIND_NOTICE) return { ...clock, expired: false, expiresAt: null, precision: 'none' }
  const secondsAt = Number.isFinite(arrivalAt) && arrivalAt > 0 ? arrivalAt + ttlMs : null
  if (clock.reason === 'dated-label') return { ..., expired: true, ... }   // 带日期 → 必然早于 TTL
  const expiresAt = Math.min(...[secondsAt, clock.expiresAt].filter(Number.isFinite))
  return { ..., expiresAt, expired: now >= expiresAt, precision: secondsAt !== null ? 'seconds' : 'minute' }
}
// 组件侧
const noticeArrival = notice ? noticeArrivalStore().at(speechKey) : null
const noticeExpired = notice ? noticeCardExpired(row, Date.now(), NOTICE_CARD_TTL_MS, noticeArrival) : false
// 扫描侧（在挂卡之前）
arrivals.observeAll(next.filter((r) => r.kind === CARD_KIND_NOTICE).map((r) => noticeCardSpeechKey(r.key, r.turnNo)))
```

## 五、测试（RED → GREEN，原始输出）

**RED（旧代码 + 新断言）**：`node scripts\test-secretary-cards.mjs` → 57 个用例里 **53 PASS / 4 FAIL**：

- `FAIL 卡片 kind 常量…`：`AssertionError: 通知卡 TTL = 10 秒（2026-11-24 改档）`（当时仍是 `10*60*1000`）
- `FAIL 通知卡过期算术（2026-11-24 改档 10 秒）…`：`AssertionError: 分钟末 + 10 秒铁定收`（旧 10 分钟 TTL 下 +70 秒还没过期）
- `FAIL 通知卡 10 秒（秒级来源）…`、`FAIL 通知卡 10 秒（只有钟面文本）…`：`surface.createSecretaryNoticeArrivalStore` 不存在（TypeError）＋秒级语义未实现

**GREEN（最终树）**

| 命令 | 原始结果 |
| --- | --- |
| `node build.mjs` | `[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js`，EXIT=0 |
| `npm run check` | EXIT=0（六个产物 `node --check` 全过） |
| `node scripts\test-secretary-cards.mjs` | `PASS 57/57 secretary-cards` |
| `node scripts\test-secretary-card-visual.mjs` | PASS 81 项，收尾 `CARD VISUAL PASS`，EXIT=0 |
| `node scripts\test-assistant-secretary.mjs` | `PASS 25/25 assistant-secretary` |
| `node scripts\test-secretary-notice-turn.mjs` | `PASS 5/5 secretary-notice-turn` |
| `node scripts\smoke-secretary-page.mjs` | `PASS` 130 项 / `FAIL` 0，收尾 `SMOKE PASS 全部通过`，EXIT=0 |
| `npm test` | EXIT=0；全链 PASS 行 331 条、FAIL 行 0 条，末行 `test-cu-title-bold: 全绿` |

**冒烟过程中修掉的三处现场假设（照实报，不是为过而放松）**

1. **刷新后停在 CU 会话页**：前面点通知卡引用跳到 CU 会话，`page.reload()` 会按 `localStorage.dsh.sessions.current` 恢复「上次那条会话」⇒ 探针量到 `fullTotal:0 / cardBacked:0` 的假失败。**先证明与本次改动无关**：把我的两个客户端源文件 `git stash`、重建回旧代码再跑同一份冒烟，同样在这几项失败（`SMOKE FAIL 4 项`，`{"fullTotal":0,"cardBacked":0}`）——stash 已 pop 复原。修法：刷新后先 `open-assistant` 回固定秘书会话、等 `body[data-dsh-secretary="1"]`、再等第一张卡出现（最多 30 秒）；等不到仍照旧断言失败。
2. **通知卡可能已被自动朗读先标已读**：`before.unread` 实测可能是 `"0"`（摘要里 `{"before":{"dot":false,"unread":"0"}}`），原断言要求「点之前必须是未读」会假失败。改成断言可观测结果：点完 chip 之后红点不出现、`data-unread="0"`；`before` / `readListed` 仍打进现场证据。
3. **10 秒 TTL 让「点 chip → 跳走 → 回来」那一趟必然超时**：所以现场补投一条同样的通知来验**点击语义**，不依赖某一条卡的存活时间（断言不放松：仍然要求点完 chip 后红点不出现）。

## 六、提交与状态

```
$ git show --stat --oneline fa38141
fa38141 feat(secretary): 通知卡存活时间 10 分钟改 10 秒，秒级到达时刻为准、钟面只作兜底（只晚不早）
 lib/client.js                               | 202 ++++++++++++------------
 lib/index.js                                | 117 +++++++++++++-
 scripts/smoke-secretary-page.mjs            |  81 ++++++++--
 scripts/test-secretary-card-visual.mjs      |  10 +-
 scripts/test-secretary-cards.mjs            |  83 ++++++++--
 src/client/pocket/orb/SecretaryUserCard.tsx |  29 ++--
 src/client/pocket/orb/secretary-cards.ts    | 230 +++++++++++++++++++++++++---
 7 files changed, 580 insertions(+), 172 deletions(-)
```

- 代码提交短号：`fa38141`；本报告单独一条 docs 提交。
- 未 push（`origin/main` 仍是 `5843725`）；未重启宿主；未跑 `dev:web`；未删/未覆盖用户文件；`git add` 只加了上表 7 个文件。

## 七、没验到的部分

1. **宿主进程没重启**：本次只改插件源码 + 重建 `lib/`，宿主那边若还持有旧 bundle，页面上的 10 秒行为要等宿主重载后才稳定生效；本轮按要求不重启，所以「重启后真实页面上的 10 秒生命周期」没有做端到端目视取证。
2. **观察延迟是读代码+日志推的**：`SCAN_DEBOUNCE_MS=120ms`、`RESCAN_DELAY_MS=400ms`、定时器下限 1 秒都在代码里，但真实机器上「发送 → 首次观察」的延迟分布没有单独打点统计，`≤1.5 秒` 是上界推断而不是实测分位数。
3. **钟面兜底路径没有现场样本**：现网通知行都带 `[data-clock]` 分钟文本且有到达记录，纯「只有钟面」的退化路径只在单测里验证。
4. **跨设备/清缓存**：localStorage 被清后按钟面兜底（≤59.999 秒晚）是设计推断，没有在真机上清缓存实测。
5. **10 秒对用户主观感受的影响**（会不会「还没看清就没了」）没有现场取样；如果嫌太短，只需要改 `NOTICE_CARD_TTL_MS` 一个常量，秒级判据自动跟着走。
