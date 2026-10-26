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

| 新建会话（可选模型） | 添加项目（模板 / 布局 / 文件夹） |
|---|---|
| ![新建会话](docs/screenshots/new-session-computer-use.png) | ![添加项目](docs/screenshots/add-project.png) |

## 主要功能

### 悬浮球 → 全屏控制室（手机 / 电脑一致）

- **电脑端原生悬浮球**：Electron 宿主下是一个始终置顶的透明小窗，可以拖到 DSH 窗口之外；点击打开控制室。网页 / CLI 环境自动退回页内球。
- 控制室侧栏不再出现「工作台」区块，唯一入口是悬浮球。
- 项目卡片按屏幕宽度自动排列（手机 2 列、平板 3 列、电脑 5 列；dock 可手动 1–5 列）。
- 卡片状态色：**绿 = 进行中、黄 = 等待决策、红 = 异常终止**（点开项目确认后复位）、蓝 = 已完成。
- 卡片中间实时显示最新一条进度（如「运行命令 · 搜索标题栏高度」），每 2.5 秒从会话 history 刷新。
- 每张卡片两个加号：**「＋ 标准」** 与 **「＋ CU」**，分别新建标准 / Computer Use 会话；都可选模型，并分别记住上次选择（CU 另可选后台模型）。
- 卡片「会话列表」：项目文件夹下全部会话（含模板步骤子目录），支持置顶 / 重命名 / 分叉 / 归档 / 恢复。

### 项目 / 会话模型

- 项目 = 文件夹 + 布局 + 绑定会话；项目文件夹下的所有会话自动归入该项目。
- **跨端同步**：项目、文件夹、绑定、模板进度与控制室视图存宿主（`/api/assistant/state`），手机与电脑第一次打开就一致，之后改动 5 秒内互推。
- 添加项目保留模板库（空白 / 论文写作 / 迭代收敛）+ 布局 + 文件夹；不选时按时间 `YYYYMMDDHHmm` 自动新建。
- **「添加项目」不跳出控制室**：弹窗浮在控制室之上；手机端「选择位置」打开的是**电脑文件夹浏览器**（不再触发电脑端系统对话框）。

### 手机访问（原 dsh-pocket 全套）

- 设置 →「个人助手」→ 手机访问：局域网 / 公网二维码、访问密码、SSH 固定隧道、移动端布局。
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

- `src/assistant.ts`：宿主入口（工作台 + 手机访问 + 托管 + 跨端状态 + 桌面球）
- `src/index.ts`：原工作台宿主（/api/worktable/*）
- `src/pocket-host/`：原 dsh-pocket 宿主（代理 / 隧道 / RPC）
- `src/tuoguan-host.ts`：原 dsh-tuoguan 宿主（/.dsh-tuoguan/state）
- `src/assistant-store.ts`：项目 / 视图跨端同步
- `src/desktop-ball.ts`：Electron 原生桌面悬浮球
- `src/client/index.tsx`：工作台客户端（控制室 / 分栏 / 模板流程）
- `src/client/control-room.tsx`：悬浮球打开的全屏控制室
- `src/client/assistant-settings.tsx`：设置「个人助手」
- `src/client/tuoguan.tsx`：托管开关与自动应答
- `src/client/pocket/`：原 dsh-pocket 客户端

## 致谢

- [dsh-worktable](https://github.com/xiaoshumiao00-lang/dsh-worktable)（MIT）
- [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（GPL-2.0）
- [dsh-tuoguan](https://github.com/xiaoshumiao00-lang/dsh-tuoguan)（MIT）
