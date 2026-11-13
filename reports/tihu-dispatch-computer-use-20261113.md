# 鹈鹕派单铁律：语音只能落 computer-use（2026-11-13）

## 结论（根因）

**`src/tihu/lane.ts:4507`（改前 :4397）——指挥台是按「标题里含『鹈鹕指挥台』」找回来的，没有核对标题是否整条相等、也没有核对模式。**

事故链：

1. 那句「改 D:\dsh-assistant 鹈鹕指挥台喂给模型的现场信息…」派出去后，CU 会话的模型调了 `code_agent`；
2. `vendor/computer-use/code-agent.js:270,273` 会给后台 code agent **在父会话目录下新建一个以任务 slug 命名的子目录**、并固定 `agentPreset: "standard"`；
3. 这条新会话的标题正好含「鹈鹕指挥台」→ 下一次 hello 的 `ensureCommanderSession` 用 `title.includes()` 把它认成指挥台；
4. 从此**所有语音都投进这条标准模式会话**（用户截图那条就是它）。

会话记录实证（`~/.dsh/storages/session_projcache/sessions/session-5394ba96-….json`）：

- `:7` `cwd = D:\dsh-assistant\改-d-dsh-assistant-鹈鹕指挥台喂给模型的现场信息-当前太薄-只有`
- `:184` `agentPreset = "standard"`，`:15` `title = 改 D:\dsh-assistant 鹈鹕指挥台喂`

即：**不是「建会话时没传模式」，也不是「默认就是 standard」，也不是模型回退。** 新建派单会话一直传的是 `computer-use`；这次是一条**由 code_agent 按设计建出来的 standard 子会话被误认成了指挥台**，于是语音绕过了所有 CU 过滤。

## 还漏的路径（已一并堵上）

| 路径 | 问题 | 现在 |
|---|---|---|
| `lane.ts:4507` 指挥台找回 | 标题子串匹配，任务会话也能被认成指挥台 | 只认「标题整条＝鹈鹕指挥台」且 `preset=standard`（指挥台本来就只看单、不看屏） |
| `lane.ts:6218` 新建派单会话 | 只传 `agentPreset`，**从不核对宿主落没落上**（宿主 `create` 其实返回 `agentPreset`，旧代码丢了） | 建完按「宿主回执 > 活会话/行投影」核对，不是 `computer-use` 就**拒绝使用**并在屏上说「会话没建成电脑操作模式」 |
| `lane.ts:6315` 复用已有会话（语音+键盘共用） | 目标哪怕是标准模式也照投 | 投递前硬闸 `allowDispatchTarget`：读到非 CU → 拒绝投递、屏上「那条会话是标准模式，不能派」、不改派、不建卡 |
| 读页硬绑定（`deliverReadPin`） | 同样不查模式 | 走同一个硬闸（noDegrade 仍是「不降级、不改派」，只是拒投 + 提示） |

键盘手打与语音共用 `text.input → 同一个派单器 → appendToSession/dispatchToCard`，所以**一条闸同时管两边**，没有分裂实现。

## 模型与模式的关系

两者**互不决定**：

- 模式＝会话头/投影的 `agentPreset`（`standard` / `computer-use` …），由宿主预设注册表在**建会话时**写进会话；派单走 `DISPATCH_PRESET='computer-use'`，指挥台走 `TASK_PRESET='standard'`（`lane.ts:3931,3934`）。
- 模型＝建完之后 `sessionController.selectModel` 单独写入的 `model/selection`（`lane.ts:6240`，`model-select.ts` 顶部说明）。

所以把指挥台/任务模型换成 `deepseek-official`、`DeepSeek-V4.1-Flash` 之类**不会**把会话变成 standard，`standard` 也不会因为换模型变 CU。本次标准模式的唯一来源是 code_agent 的 `agentPreset:"standard"`。模型不支持看屏时表现为「点了没反应/瞎点」，那是模型能力问题，不是模式问题——模式仍应是 CU，闸门也照拦非 CU。

## 实测

- `node build.mjs`：exit 0（`lib/index.js / client.js / computer-use*.js / pocket.js` 全出）
- `node scripts/test-tihu-protocol.mjs`：**PASS 267/267**（基线 259 + 新增 3 条用例 8 条断言：指挥台不被标题带字样骗、建会话模式没落上必拒、读页 pin 到标准模式必拦）
- 读页硬绑定、指挥台判断保留、派单前同步、模型以会话运行为准：未动，原用例全绿。

## 兜底行为

- 读不到模式（老宿主 / 会话还没投影）：放行并记 lane.log（不因读不到就把话吞掉）；
- 读到非 CU：屏上一句短提示（`那条会话是标准模式，不能派` + 原因摘要）+ lane.log `target-not-computer-use`，不建卡、不改派；
- 新建模式没落上：任务卡撤掉，屏上「会话没建成电脑操作模式」，lane.log `create-preset-mismatch`。

## 改动与备份

- `src/tihu/lane.ts`（备份 `src/tihu/lane.ts.bak-20261113-205324`）
- `scripts/test-tihu-protocol.mjs`（备份 `scripts/test-tihu-protocol.mjs.bak-20261113-205324`）
- 现场探针/解压脚本：`C:\Users\Administrator\.dsh\repro\tihu-dispatch-mode\`（未入库）

注：`session-5394ba96` 就是本次被误派的会话本身（记录在 `~/.dsh/storages/session_projcache/sessions/` 与 `~/.dsh/sessions/--D-dsh-assistant-…--/`），已确认 `agentPreset=standard`；`D:\dsh-assistant` 下若干以句子命名的目录是 code_agent 按 slug 建的工作目录，可另行清理（本次未动）。
