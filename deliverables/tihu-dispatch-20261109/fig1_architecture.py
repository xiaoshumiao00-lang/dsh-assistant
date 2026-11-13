# -*- coding: utf-8 -*-
"""
图 1 · 鹈鹕助手「统一指挥会话」目标架构（premium 高端期刊风 · sf_arch）

画布：16.8 x 11.2 英寸，逻辑坐标 168 x 112（10 单位/英寸＝premium 150 基准的 1.12 倍）
分层序（自上而下）：① 设备 → ② 通道 → ③ 指挥会话 → ④ 执行池 → ⑤ 登记簿与通知；右缘竖栏＝记忆与路由
主题数：slate（设备·通道·记忆栏）/ teal（指挥·登记簿）/ blue（执行池）/ rose（旧机制·闸门）＝ 4 套 ✔
单元区几何：cell 标题落在 cell 底 + 0.74h，正文中心落在 0.30h，正文至多 3 行（12pt，行距 1.5 ≈ 2.4 单位/行）
"""
import sys
sys.path.insert(0, r"C:\Users\Administrator\.dsh\skills\aca-04-visual\scripts")

from matplotlib.patches import FancyBboxPatch, Rectangle, Circle  # noqa: E402
from sf_premium import *  # noqa: E402

OUT_PNG = "fig1_tihu_dispatch_architecture.png"
OUT_PDF = "fig1_tihu_dispatch_architecture.pdf"
OUT_SVG = "fig1_tihu_dispatch_architecture.svg"

fig, ax = new_canvas(16.8, 11.2, 168, 112)

# ---------------------------------------------------------------- 布局常量
BAND_X, BAND_W = 4.0, 132.0          # 分层容器 x 4..136
CELL_XS = [6.0, 37.5, 69.0, 100.5]   # 四列，列宽 29.5，间距 2.5
CELL_W = 29.5
RAIL_X, RAIL_W = 140.0, 26.0         # 右缘竖栏容器 x 140..166
RAIL_CELL_X, RAIL_CELL_W = 142.0, 22.0

# band 几何：容器底 / 容器高 / 标题条底 / 单元区底 / 单元区高
BANDS = {
    "dev":  dict(cy=92.0, ch=16.0, hy=104.5, cy_cell=93.0, ch_cell=11.0),
    "lane": dict(cy=74.0, ch=14.0, hy=84.5, cy_cell=75.0, ch_cell=10.0),
    "disp": dict(cy=48.0, ch=23.0, hy=67.5, cy_cell=49.0, ch_cell=18.0),
    "work": dict(cy=27.0, ch=17.0, hy=40.5, cy_cell=28.0, ch_cell=12.0),
    "task": dict(cy=6.0,  ch=17.0, hy=19.5, cy_cell=7.0,  ch_cell=12.0),
}
GAPS = {  # 层间通道中线：用于放箭头与箭头文字
    "dev_lane": 88.5, "lane_disp": 71.5, "disp_work": 46.0, "work_task": 24.5,
}

# ---------------------------------------------------------------- ① 设备层
b = BANDS["dev"]
container(ax, BAND_X, b["cy"], BAND_W, b["ch"])
header(ax, BAND_X + 2, b["hy"], 96.0, 3.5, "① 鹈鹕设备 · 唯一入口", theme="slate", size=14.5, z=5)
cell(ax, CELL_XS[0], b["cy_cell"], CELL_W, b["ch_cell"], "语音入口",
     "按住说话 · 松开转写\n一句话只进指挥会话", theme="slate", tsize=13.5, bsize=12)
cell(ax, CELL_XS[1], b["cy_cell"], CELL_W, b["ch_cell"], "触屏点按",
     "点任务行看详情\n点确认键放行", theme="slate", tsize=13.5, bsize=12)
cell(ax, CELL_XS[2], b["cy_cell"], CELL_W, b["ch_cell"], "扬声器",
     "完成播报 · 告警\n重读 · 语速可调", theme="slate", tsize=13.5, bsize=12)

# 屏幕示意卡：320×240 主页＝任务棋盘 ＋ 完成气泡轨
# 语义色取自已用四套主题：完成＝teal，进行中＝blue，待决策＝rose，气泡＝teal
MX = CELL_XS[3]
cell(ax, MX, b["cy_cell"], CELL_W, b["ch_cell"], None, None, theme="slate")
SW, SH = 14.0, 10.5                   # 320:240 等比
SX, SY = 101.6, 93.4                  # 屏体：x 101.6..115.6, y 93.4..103.9
ax.add_patch(FancyBboxPatch((SX, SY), SW, SH, boxstyle="round,pad=0,rounding_size=0.35",
                            fc=WHITE, ec=THEMES["slate"]["deep"], lw=1.4, zorder=4))
# 屏内状态条（深色 1.6 高，11pt 白字整条装下）
ax.add_patch(Rectangle((SX + 0.6, 101.9), SW - 1.2, 1.6,
                       fc=THEMES["slate"]["deep"], ec="none", zorder=5))
txt(ax, SX + SW / 2, 102.7, "任务棋盘主页", size=11, color=WHITE, weight="bold", z=7, font=HEI)
# 任务行 1.2 高，行首状态点 r0.36
row_y, row_theme = [100.3, 98.7, 97.1], ["teal", "blue", "rose"]
for i, th in enumerate(row_theme):
    ax.add_patch(FancyBboxPatch((SX + 1.8, row_y[i]), 7.6, 1.2,
                                boxstyle="round,pad=0,rounding_size=0.2",
                                fc=THEMES[th]["fill"], ec=THEMES[th]["deep"], lw=0.8, zorder=5))
    ax.add_patch(Circle((SX + 1.2, row_y[i] + 0.6), 0.36,
                        fc=THEMES[th]["deep"], ec="none", zorder=6))
# 完成气泡轨（屏右侧 1.8 宽）
for i in range(2):
    ax.add_patch(FancyBboxPatch((SX + SW - 3.0, row_y[i]), 1.8, 1.2,
                                boxstyle="round,pad=0,rounding_size=0.2",
                                fc=THEMES["teal"]["fill"], ec=THEMES["teal"]["deep"], lw=0.9, zorder=6))
# 屏底动作条
ax.add_patch(FancyBboxPatch((SX + 0.6, 94.0), SW - 1.2, 0.9,
                            boxstyle="round,pad=0,rounding_size=0.2",
                            fc=THEMES["slate"]["fill"], ec=THEMES["slate"]["deep"], lw=0.9, zorder=5))
txt(ax, 122.5, 99.0, "320×240\n一行一任务\n完成气泡轨", size=11.5, color=BLACK, z=7)

# ---------------------------------------------------------------- ② 通道层
b = BANDS["lane"]
container(ax, BAND_X, b["cy"], BAND_W, b["ch"])
header(ax, BAND_X + 2, b["hy"], BAND_W - 4, 3.5, "② 通道层 · lane 与设备协议", theme="slate", size=14.5, z=5)
cell(ax, CELL_XS[0], b["cy_cell"], CELL_W, b["ch_cell"], "上行帧",
     "audio.frame 16 kHz\n点按与确认应答", theme="slate", tsize=13.5, bsize=12)
cell(ax, CELL_XS[1], b["cy_cell"], CELL_W, b["ch_cell"], "下行帧",
     "screen.frame 与 tts.audio\n新增 task.* 通知", theme="slate", tsize=13.5, bsize=12)
cell(ax, CELL_XS[2], b["cy_cell"], CELL_W, b["ch_cell"], "同一条通道",
     "pocket 鉴权复用\n不新开端口 无第二密码", theme="slate", tsize=13.5, bsize=12)
cell(ax, CELL_XS[3], b["cy_cell"], CELL_W, b["ch_cell"], "旧机制 移除",
     "会话选择器 自动跟随\n手动与自动绑定代际", theme="rose", tsize=13.5, bsize=12)

# ---------------------------------------------------------------- ③ 指挥会话
b = BANDS["disp"]
container(ax, BAND_X, b["cy"], BAND_W, b["ch"])
header(ax, BAND_X + 2, b["hy"], BAND_W - 4, 3.5, "③ 指挥会话 · Dispatcher 唯一对话入口", theme="teal", size=14.5, z=5)
cell(ax, CELL_XS[0], b["cy_cell"], CELL_W, b["ch_cell"], "意图解析",
     "转写清洗与词表\n工具噪音剥离\n该不该自动发送", theme="teal", tsize=13.5, bsize=12)
cell(ax, CELL_XS[1], b["cy_cell"], CELL_W, b["ch_cell"], "路由 快路径",
     "项目别名命中\n上一条任务接续\n同项目正在跑", theme="teal", tsize=13.5, bsize=12)
cell(ax, CELL_XS[2], b["cy_cell"], CELL_W, b["ch_cell"], "路由 慢路径",
     "读登记簿与记忆\n模型选目标项目\n歧义就追问一句", theme="teal", tsize=13.5, bsize=12)
cell(ax, CELL_XS[3], b["cy_cell"], CELL_W, b["ch_cell"], "派单动作",
     "新派任务会话\n追加到已有任务\n自己直接答 · 汇报", theme="teal", tsize=13.5, bsize=12)

# ---------------------------------------------------------------- ④ 执行池
b = BANDS["work"]
container(ax, BAND_X, b["cy"], BAND_W, b["ch"])
header(ax, BAND_X + 2, b["hy"], BAND_W - 4, 3.5, "④ 任务执行池 · 每个任务一条会话", theme="blue", size=14.5, z=5)
cell(ax, CELL_XS[0], b["cy_cell"], CELL_W, b["ch_cell"], "standard 会话",
     "落在项目文件夹\n模板最新步骤目录\n串行排队注入", theme="blue", tsize=13.5, bsize=12)
cell(ax, CELL_XS[1], b["cy_cell"], CELL_W, b["ch_cell"], "computer-use 会话",
     "看屏与点按\n前台 GUI 独占\n后台步骤回传", theme="blue", tsize=13.5, bsize=12)
cell(ax, CELL_XS[2], b["cy_cell"], CELL_W, b["ch_cell"], "子代理并行",
     "fan-out 并行推进\n结果回父会话\n不入设备绑定", theme="blue", tsize=13.5, bsize=12)
cell(ax, CELL_XS[3], b["cy_cell"], CELL_W, b["ch_cell"], "托管与工具闸门",
     "决策自动应答\n危险动作先确认\n快照与审计留痕", theme="rose", tsize=13.5, bsize=12)

# ---------------------------------------------------------------- ⑤ 登记簿与通知
b = BANDS["task"]
container(ax, BAND_X, b["cy"], BAND_W, b["ch"])
header(ax, BAND_X + 2, b["hy"], BAND_W - 4, 3.5, "⑤ 任务登记簿 与 通知总线 · 屏幕与播报的唯一事实源", theme="teal", size=13.5, z=5)
cell(ax, CELL_XS[0], b["cy_cell"], CELL_W, b["ch_cell"], "任务登记簿",
     "排队 派单 执行 待决策\n完成 已播报 归档", theme="teal", tsize=13.5, bsize=12)
cell(ax, CELL_XS[1], b["cy_cell"], CELL_W, b["ch_cell"], "事件归一化",
     "turn 与 tool 事件\n按任务映射与去重", theme="teal", tsize=13.5, bsize=12)
cell(ax, CELL_XS[2], b["cy_cell"], CELL_W, b["ch_cell"], "屏投影",
     "主页即任务棋盘\n点一行看一条任务", theme="teal", tsize=13.5, bsize=12)
cell(ax, CELL_XS[3], b["cy_cell"], CELL_W, b["ch_cell"], "播报优先级",
     "决策 > 完成 > 进度\n合并成一句 · 缓存", theme="teal", tsize=13.5, bsize=12)

# ---------------------------------------------------------------- ⑥ 记忆与路由竖栏
container(ax, RAIL_X, 6.0, RAIL_W, 102.0)
header(ax, RAIL_CELL_X, 104.5, RAIL_CELL_W, 3.5, "记忆与路由", theme="slate", size=13.5, z=5)
cell(ax, RAIL_CELL_X, 86.0, RAIL_CELL_W, 14.0, "热记忆",
     "USER 与 MEMORY\n每轮注入偏好", theme="slate", tsize=13, bsize=12)
cell(ax, RAIL_CELL_X, 52.0, RAIL_CELL_W, 14.0, "项目路由表",
     "项目＝文件夹\n别名 最新步骤", theme="slate", tsize=13, bsize=12)
cell(ax, RAIL_CELL_X, 14.0, RAIL_CELL_W, 14.0, "收工蒸馏",
     "journal 一行一条\n摘要外置进簿", theme="slate", tsize=13, bsize=12)

# ---------------------------------------------------------------- 层间箭头
def spine_pair(top_edge, bottom_edge, mid, down_label, up_label, down_color, up_color):
    """跨层通道：左列箭头向下（前向），右列箭头向上（回传），文字落在通道中线。"""
    down_x, up_x = 40.0, 90.0
    arrow(ax, down_x, top_edge, down_x, bottom_edge, color=down_color, lw=2.6, z=4)
    arrow(ax, up_x, bottom_edge, up_x, top_edge, color=up_color, lw=2.4, z=4)
    txt(ax, 22.0, mid, down_label, size=11.5, bbox=dict(fc="white", ec="none", pad=1.4), z=7)
    txt(ax, 108.0, mid, up_label, size=11.5, bbox=dict(fc="white", ec="none", pad=1.4), z=7)

spine_pair(92.0, 88.0, 90.0, "audio.frame", "屏帧与音频", FLOW, FLOW)
spine_pair(74.0, 71.0, 72.5, "转写后的句子", "下发屏帧", FWD, BWD)
spine_pair(48.0, 44.0, 46.0, "派单 新建或追加", "进度与结果", FWD, BWD)
spine_pair(27.0, 23.0, 25.0, "turn 事件", "摘要回指挥", FLOW, BWD)

# 通知 → 设备（左缘回传主干）
ax.plot([5.0, 1.6, 1.6], [8.0, 8.0, 97.0], color=BWD, lw=2.6, zorder=3)
arrow(ax, 1.6, 97.0, 5.5, 97.0, color=BWD, lw=2.6, ms=16, z=6)
txt(ax, 1.6, 58.0, "语音播报与完成气泡", size=12.5, color=BWD, weight="bold", rot=90, z=7,
    bbox=dict(fc="white", ec="none", pad=1.8))

# 记忆栏 → 指挥 / 登记簿（辅助虚线）
arrow(ax, 141.0, 59.0, 131.0, 59.0, color=FLOW, lw=1.8, ls="--", ms=14, z=4)
arrow(ax, 141.0, 22.0, 131.0, 14.0, color=FLOW, lw=1.8, ls="--", ms=14, rad=0.18, z=4)

# ---------------------------------------------------------------- 图例与图名
legend_dot(ax, 8.0, 3.2, FWD, "指令前向", size=12)
legend_dot(ax, 44.0, 3.2, FLOW, "帧与事件", size=12)
legend_dot(ax, 82.0, 3.2, BWD, "结果与播报", size=12)
legend_dot(ax, 124.0, 3.2, CONTAINER_EC, "辅助支路", size=12)
txt(ax, 84.0, -1.5, "图 1 鹈鹕助手统一指挥架构 目标形态", size=13.5, weight="bold", font=HEI)

fig.savefig(OUT_PNG, dpi=300, bbox_inches="tight", facecolor="white")
fig.savefig(OUT_PDF, bbox_inches="tight", facecolor="white")
fig.savefig(OUT_SVG, bbox_inches="tight", facecolor="white")
print("written:", OUT_PNG, OUT_PDF, OUT_SVG)
