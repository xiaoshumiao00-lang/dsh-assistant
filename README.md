# dsh-assistant

DeepSeek Harness 一体化助手插件：**悬浮球 → 控制室**，外带**手机扫码远程访问**。

它把两个既有插件的能力装进同一个包，不改动原插件代码：

- **工作台（dsh-worktable，MIT）**：项目 / 会话模型、分栏工作区、控制室、模板流程（论文写作 / 迭代收敛）。侧栏不再出现「工作台」区块，控制室一律从悬浮球进入；
- **手机访问（dsh-pocket，GPL-2.0）**：局域网/公网代理、二维码、SSH 固定隧道、移动端抽屉适配、悬浮球、语音输入。

> 本包整体按 **GPL-2.0** 发布（因为内含 dsh-pocket 的 GPL 代码）。原插件的 LICENSE 与版权归各自作者。

## 界面

| 控制室（电脑 · 自动 5 列） | 控制室（手机 · 自动 2 列） |
|---|---|
| ![控制室桌面](docs/screenshots/control-room-desktop.png) | ![控制室手机](docs/screenshots/control-room-mobile.png) |

| 新建会话（Computer Use） | 添加项目（模板 / 布局 / 文件夹） |
|---|---|
| ![新建会话](docs/screenshots/new-session-computer-use.png) | ![添加项目](docs/screenshots/add-project.png) |

## 主要功能

### 悬浮球 → 全屏控制室（手机 / 电脑一致）

- 右下角悬浮球（可拖动）点击即打开全屏控制室，Esc / 右上角 ✕ 关闭。
- 每个项目一张独立卡片（图标 + 名称），卡片按屏幕宽度**自动排列**（手机 2 列、平板 3 列、电脑 5 列；也可在底部 dock 手动指定 1–5 列）。
- 卡片状态色：
  - **绿色 = 进行中**（会话正在跑，旋转描边）
  - **黄色 = 等待决策**（宿主 pendingInteraction）
  - **红色 = 异常终止**（会话面 `lastAgentError`，呼吸脉冲；点开项目确认后复位）
  - 蓝色 ✓ = 已完成（保留原完成提醒）
- 卡片底部「会话列表」：该项目文件夹下（含模板各步骤子目录）的全部会话，**置顶 / 重命名 / 分叉 / 归档 / 恢复**；归档项可一键展开。
- 卡片底部「新建会话」：**标准模式** 或 **Computer Use 模式**；Computer Use 可分别选择**前台模型**（该会话）与**后台模型**（dsh-orb 后台 Agent，全局）。
- 「添加项目」：**模板（可选：空白 / 论文写作模板 / 迭代收敛）** + 布局模式 + 项目名称（可留空，默认 = 文件夹名）+ 项目文件夹；不手选文件夹时自动在默认父目录下按时间命名（`YYYYMMDDHHmm`，例如 `202609272036`）。
- 顶部模板库、底部主题/形状/背景/列数/公告 dock 全部保留。

### 项目 / 会话模型

- 项目 = 文件夹（`projects.folders`）+ 收藏的布局（`projects.layouts`）+ 绑定会话（`projects.bindings`）。
- 项目文件夹下的所有会话自动归入该项目（按 `cwd` 前缀匹配，含模板步骤子目录）。
- 数据沿用 dsh-worktable 的 localStorage 键（`dsh.worktable.view.v1` / `dsh.worktable.projects.v1`），所以**现有项目无需迁移**，直接出现在新控制室。

### 远程访问（原 dsh-pocket 全套）

- 设置 → 手机访问：局域网 / 公网二维码、访问密码、SSH 固定隧道、更新与重启提示。
- 手机与电脑看到的是同一个 DSH Web（WebSocket 透传），控制室同一套 UI。
- 移动端抽屉布局、悬浮球、快捷输入页（抽屉底部入口）全部保留。

## 安装

```powershell
# 1) 构建
cd D:\dsh-assistant
npm run build

# 2) 装进 desktop profile（自动建 junction、把 dsh-pocket / dsh-worktable 从 bundles 换成 dsh-assistant）
node scripts\install-assistant.mjs desktop

# 3) 重启 DSH Desktop
```

回退：`C:\Users\Administrator\.dsh\profiles\desktop\package.json.bak-assistant-<时间戳>` 复制回 `package.json`，重启即可（两个原插件仍在磁盘上）。

## 开发

```powershell
npm run build   # lib/index.js（宿主）+ lib/client.js（客户端，~2.1MB）
npm run check   # node --check 两个产物
```

客户端 bundle 走 `window.__ModuleLoader__.load({ id: 'dsh-assistant', factory })` 握手，react / `@deepseek-ai/*` 保持 external。

## 目录

- `src/index.ts`：原工作台宿主（/api/worktable/*、原生皮肤模板）
- `src/assistant.ts`：宿主入口（工作台半部 + 手机访问半部）
- `src/client/index.tsx`：原工作台客户端（侧栏 / 分栏 / 控制室 / 模板流程）
- `src/client/pocket/`：原 dsh-pocket 客户端（设置页、移动端、悬浮球）
- `src/client/control-room.tsx`：悬浮球打开的全屏控制室浮层
- `src/client/orb-bridge.ts`：悬浮球 ⇄ 控制室桥
- `src/pocket-host/`：原 dsh-pocket 宿主（代理 / 隧道 / RPC）

## 致谢

- [dsh-worktable](https://github.com/xiaoshumiao00-lang/dsh-worktable)（MIT）
- [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（GPL-2.0）
