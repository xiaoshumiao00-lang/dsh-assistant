# dsh-assistant

DeepSeek Harness 一体化助手插件：**悬浮球 → 控制室**，外加**手机扫码远程访问**与**托管模式**。

它把三个既有插件的能力装进同一个包，不改动原插件代码：

- **工作台（dsh-worktable，MIT）**：控制室、项目 / 会话、分栏工作区、模板流程；
- **手机访问（dsh-pocket，GPL-2.0）**：局域网/公网代理、二维码、SSH 固定隧道、移动端适配、语音输入；
- **托管（dsh-tuoguan，MIT）**：提问 / 审批按默认项自动应答，状态存宿主、手机与电脑同步。

> 本包整体按 **GPL-2.0** 发布（因为内含 dsh-pocket 的 GPL 代码）。原插件的 LICENSE 与版权归各自作者。

## 界面

| 控制室（电脑） | 控制室（手机） |
|---|---|
| ![控制室桌面](docs/screenshots/control-room-desktop.png) | ![控制室手机](docs/screenshots/control-room-mobile.png) |

| 新建会话（默认上次使用的模型） | 添加项目（模板 / 布局 / 文件夹） |
|---|---|
| ![新建会话](docs/screenshots/new-session-computer-use.png) | ![添加项目](docs/screenshots/add-project.png) |

## 主要功能

### 悬浮球 → 全屏控制室（手机 / 电脑一致）

- **桌面端两颗悬浮球**：窗口内一颗页内球（可拖动、记住位置）+ 窗口外一颗原生 Electron 小窗（始终置顶、可拖到 DSH 窗口之外）；两颗都打开控制室，头像与「启用悬浮球」开关共用。网页 / CLI / 手机环境只有页内球。dsh-orb 自带的悬浮球已关闭，只保留这一套入口。
- **页内球始终可见、就是控制室的开关**：控制室打开期间它不消失，浮在控制室之上；点一下打开、再点一下关闭（电脑与手机一致）。窗口外那颗原生球仍只负责打开。
- 控制室侧栏不再出现「工作台」区块，唯一入口是悬浮球。
- 项目卡片按屏幕宽度自动排列；**列数是设备本地偏好**：电脑与手机分开保存、互不同步（dock 可手动 1–5 列）。
- 卡片状态色：**绿 = 进行中、黄 = 等待决策、红 = 异常终止**（点开项目确认后复位）、蓝 = 已完成。
- 卡片中间实时显示最新一条进度（如「运行命令 · 搜索标题栏高度」），每 2.5 秒从会话 history 刷新。
- 每张卡片两个醒目的新建按钮：**「＋ 新建 / 对话」** 与 **「＋ 新建 / 电脑操作」**，分别新建普通对话 / 电脑操作会话；模型默认选中上次使用的模型（电脑操作另可选后台模型），不再出现「默认」空选项。
- 卡片「会话列表」：项目文件夹下全部会话（含模板步骤子目录），支持置顶 / 重命名 / 分叉 / 归档 / 恢复。
- 底部 dock「项目管理」：隐藏 / 恢复 / 删除项目（只删控制室条目，不动文件夹与会话）。
- 底部 dock「眼睛」按钮：一键隐藏未工作的项目卡片——只留进行中 / 等待决策 / 异常终止，再点恢复全部；开启时按钮高亮并显示卡片数量角标。

### 临时卡片「正在运行」

不在任何已创建项目文件夹里运行的会话（例如随手在桌面、下载目录或 DSH 默认工作目录里开的对话），
以前在控制室完全看不到。现在会自动收进一张临时卡片：

- **运行中 / 等你决策时**：卡片常驻，状态灯、实时进度、运行时长、子代理数、会话列表、＋新建会话都与其他项目卡片一致。
- **结束后**：该会话**一直保留**在卡片上，直到你手动点「会话列表 → 收工」；不按时间自动消失。
  点开某条已结束会话只是进入查看，不会把它移出卡片。
- **收工后**：只把这一轮已结束的会话从卡片移除；会话本身、磁盘日志、侧栏入口一律不动，随时可以继续对话。
- 收工只对「这一轮已结束」生效；同一会话下一轮再跑完时会重新出现。
- 卡片上的「＋ 新建 / 对话」与「＋ 新建 / 电脑操作」会在最近一条游离会话的目录里新建会话（继续收纳进这张卡片），
  不会把新会话绑定到任何真实项目，因此不会「藏」进项目卡片而看不见。

### Computer Use 坐标（原 dsh-orb 设置）

- 设置 →「个人助手」→ Computer Use 新增**「使用千分比坐标（0–1000）」**开关。
- 打开：模型按截图的 0–1000 比例给点击位置；关闭：按截图原始像素给位置。**GUI 点击经常偏就关掉它**。
- 坐标方式在会话创建时固定：切换后请新建一个「＋ 新建 / 电脑操作」会话；已打开的会话保持原样。

### 项目 / 会话模型

- 项目 = 文件夹 + 布局 + 绑定会话；项目文件夹下的所有会话自动归入该项目。
- **跨端同步**：项目、文件夹、绑定、模板进度与控制室视图存宿主（`/api/assistant/state`），手机与电脑第一次打开就一致，之后改动 5 秒内互推。
- 添加项目保留模板库（空白 / 论文写作 / 迭代收敛）+ 布局 + 文件夹；不选时按时间 `YYYYMMDDHHmm` 自动新建。
- **「添加项目」不跳出控制室**：弹窗浮在控制室之上；手机端「选择位置」打开的是**电脑文件夹浏览器**（不再触发电脑端系统对话框）。

### 私人助手（v0.2.9）

不用开项目卡片，直接找「会记得你做过什么」的助手。

- **控制室里是一张普通卡片**：图标 🤖、名称「私人助手」、默认排第一。状态灯（绿/黄/红/蓝）、中间实时进度、运行时长、子代理数、「会话列表」、「＋新建 / 对话」「＋新建 / 电脑操作」、重命名、换图标、隐藏、拖拽排序——与其他项目卡完全同一套逻辑，不是另写的卡片类型。
- **助手会话不再混进「正在运行」临时卡片**：助手目录被认作项目文件夹后，该目录下的会话归这张卡；删卡后写 `removed` 墓碑，不再自动重建（用户删掉就是明确不要）。
- **建卡时机**：首次同步（宿主状态覆盖本地）之后才建，且按 `layouts/removed` 变化重试最多 6 次——避免「建好又被采纳覆盖吃掉」。
- **三个入口，互不抢单击**：轻点悬浮球仍是控制室（行为没改）；**长按悬浮球 600ms** 进助手；电脑上 **Ctrl+Alt+A** 全局热键；控制室顶栏右侧的「🤖 私人助手」按钮兜底。
- **助手住在固定目录** `~/.dsh/assistant/`：`AGENTS.md`（人设 + 「什么时候直接做、什么时候建卡」+ 记忆规则，只在缺失时写入，不覆盖手改）、`journal/YYYY-MM-DD.md`（收工日志）、`notes/`（长期档案）、`outputs/`（杂物间）。
- **家目录不会越用越臃肿**：会话日志根本不在这个目录（DSH 存在 `~/.dsh/sessions/<目录编码>/`），这里只有记忆资产 + 临时产物。`outputs/` 里超过 **14 天**的文件由插件每 6 小时自动清一次（`POST /api/assistant/tidy` 也可手动清），`journal/` `notes/` `AGENTS.md` 一概不碰。要长期保留的产物应该建卡，落进项目文件夹。
- **每次打开都是新会话**：上下文不随使用无限增长；「记得你」靠 USER/MEMORY/AGENTS/journal 这套记忆，不靠一条会话的上下文。同目录同模式的空白会话会被复用，不堆空白；历史会话都在卡片「会话列表」里可回看。
- **默认 computer-use 模式**（能看屏幕、点界面）；dsh-orb 被停用时自动退回标准模式。
- **默认沿用上一次的模型**：先读上一条助手会话实际在用的模型（用户可能在对话页换过），没有记录时退回本机上次选过的模型。
- **记忆闭环**：热记忆（`USER.md` / `MEMORY.md` 每轮注入）+ 人设里的收工蒸馏（写 journal、更新记忆、纠正即覆盖）+ `mnemon` 检索；记忆真值在 `~/.mnemon/runtime/`。
- 宿主路由：`GET /api/assistant/home`、`GET /api/assistant/memory`、`GET|POST /api/assistant/tidy`、`GET|POST /api/assistant/open-assistant`（热键/外部唤起，带 intent 复用悬浮球长轮询）。
- 直达：`…/?assistant=chat` 或 `…/#assistant`。
- **升级后需重启一次 DSH Desktop**：宿主新增的路由、全局热键与桌面球长按都要宿主重启才生效（只刷新页面只能拿到新客户端）。

### 手机访问（原 dsh-pocket 全套）

- 设置 →「个人助手」→ 手机访问：局域网 / 公网二维码、访问密码、SSH 固定隧道、移动端布局。
- 手机访问使用独立 Cordis 生命周期；个人助手其他模块热重载不会重启代理 / SSH，登录会话密钥持久化，更新与重启不再强制手机重登。
- 手机默认只精简桌面原生能力、埋点与开发期 HMR；系统设置、Skill、自动化任务、记忆系统等用户功能完整保留。需要完整插件树时仍可在地址加 `?dsh-full-plugins=1`。
- 独立的「手机访问」设置页签已删除，内容收进「个人助手」。

### 托管（原 dsh-tuoguan）

- composer 右侧「托管」开关；开启后提问 / 审批自动按默认项应答。
- 状态存宿主，手机与电脑同步；默认开启（只记录被显式关闭的会话）。

## 安装

```powershell
cd D:\dsh-assistant
npm run build

# 装进 desktop profile：建 junction，并把 dsh-pocket / dsh-worktable / dsh-tuoguan
# 从 bundles 换成 dsh-assistant（自动备份 package.json，可回退）
node scripts\install-assistant.mjs desktop

# 重启 DSH Desktop
```

回退：`C:\Users\Administrator\.dsh\profiles\desktop\package.json.bak-assistant-<时间戳>` 复制回 `package.json`，重启即可。

## 开发

```powershell
npm run build   # lib/index.js（宿主）+ lib/client.js（客户端）
npm run check   # node --check 两个产物
```

客户端 bundle 走 `window.__ModuleLoader__.load({ id: 'dsh-assistant', factory })` 握手，react / `@deepseek-ai/*` 保持 external。

## 目录

- `src/assistant.ts`：宿主入口（工作台 + 托管 + 跨端状态 + 桌面球；手机访问已拆为独立入口）
- `src/index.ts`：原工作台宿主（/api/worktable/*）
- `src/pocket.ts` + `lib/pocket.js`：手机访问独立 Cordis 入口（`dsh-assistant/pocket`），独立构建、独立生命周期
- `src/web-routes.ts`：webServer 路由集中登记与注销，防热重载重复注册导致 apply 中途失败
- `src/pocket-host/`：原 dsh-pocket 宿主（代理 / 隧道 / RPC）；含 `runtime.mjs`（跨 HMR 复用运行实例）、`mobile-boot.mjs`（手机端模块精简与批次权重）、`mobile-batch.mjs`（本地合包 + gzip/Brotli）
- `src/tuoguan-host.ts`：原 dsh-tuoguan 宿主（/.dsh-tuoguan/state）
- `src/assistant-store.ts`：项目 / 视图跨端同步
- `src/desktop-ball.ts`：Electron 原生桌面悬浮球
- `src/client/index.tsx`：工作台客户端（控制室 / 分栏 / 模板流程）
- `src/client/projectFolderSheet.tsx`：新建 / 更改项目文件夹的「选择位置」（复用悬浮球那套 PathBrowser）
- `src/client/clipboard.ts`：剪贴板写入（安全上下文走 Clipboard API，http 页面同步 execCommand 兜底）
- `src/client/control-room.tsx`：悬浮球打开的全屏控制室
- `src/client/assistant-settings.tsx`：设置「个人助手」
- `src/client/tuoguan.tsx`：托管开关与自动应答
- `src/client/pocket/`：原 dsh-pocket 客户端

## 致谢

- [dsh-worktable](https://github.com/xiaoshumiao00-lang/dsh-worktable)（MIT）
- [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（GPL-2.0）
- [dsh-tuoguan](https://github.com/xiaoshumiao00-lang/dsh-tuoguan)（MIT）
