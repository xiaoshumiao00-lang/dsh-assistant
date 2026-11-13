# -*- coding: utf-8 -*-
"""
图 2 · 派单出口 · 任务状态机 · 播报优先级（premium 高端期刊风，sf_flow 口径）

画布 16.8 x 9.8 英寸，逻辑坐标 168 x 98（10 单位/英寸）
主题四套：teal（完成 已播报 出口 直接答） blue（排队 派单 执行中 追加 新派）
rose（需要人的环节：待决策 追问澄清） slate（归档 屏与喇叭 缓存）
箭头：FWD 前向派单 / FFLOW 簿内推进 / BWD 结果回传与播报（此处用 FLOW 表示簿内推进，BWD 表示回传）
容器几何：A y 62..95，B y 32..58，C y 8..30
"""
import sys
sys.path.insert(0, r"C:\Users\Administrator\.dsh\skills\aca-04-visual\scripts")

from sf_premium import *  # noqa: E402

OUT_PNG = "fig2_tihu_dispatch_ledger.png"
OUT_PDF = "fig2_tihu_dispatch_ledger.pdf"
OUT_SVG = "fig2_tihu_dispatch_ledger.svg"

fig, ax = new_canvas(16.8, 9.8, 168, 98)

X0, CW = 4.0, 160.0            # 容器 x 4..164

# ================= 容器 A：入口 · 判定 · 四出口 =========================
container(ax, X0, 62.0, CW, 33.0)
header(ax, 12.0, 91.0, 144.0, 3.5, "① 一句话只进指挥会话", theme="teal", size=14.5, z=5)

# 设备卡（屏与喇叭）——通知落点，同时也是一句话的来源
cell(ax, 10.0, 63.5, 26.0, 26.5, "鹈鹕屏与喇叭",
     "一句话进来\n\n结果从屏与喇叭回\n\n不回会话列表", theme="slate", tsize=13.5, bsize=12)
# 判定卡
cell(ax, 60.0, 79.0, 48.0, 9.5, "路由判定",
     "快路径命中 · 或读簿与记忆选项目", theme="teal", tsize=13.5, bsize=12)
arrow(ax, 36.5, 83.5, 59.0, 83.5, color=FWD, lw=2.6, z=6)

# 判定 → 四出口（树形支路，主干不穿卡）
ax.plot([84.0, 84.0], [79.0, 74.5], color=FWD, lw=2.4, zorder=4)
ax.plot([54.0, 149.5], [74.5, 74.5], color=FWD, lw=2.4, zorder=4)
outs = [(40.0, "自己直接答", "问答 记忆 小计算", "teal"),
        (72.0, "追加到已有任务", "投进正在跑的那条", "blue"),
        (104.0, "新派任务会话", "新建在最新步骤目录", "blue"),
        (136.0, "追问澄清一句", "歧义时上屏等人答", "rose")]
for x, title, body, th in outs:
    cell(ax, x, 63.5, 28.0, 8.0, title, body, theme=th, tsize=13.5, bsize=12)
    arrow(ax, x + 14.0, 74.5, x + 14.0, 71.9, color=FWD, lw=2.4, ms=15, z=6)

# ================= 容器 B：任务状态机 ==================================
container(ax, X0, 32.0, CW, 26.0)
header(ax, 12.0, 54.5, 144.0, 3.5, "② 任务登记簿的状态机", theme="blue", size=14.5, z=5)

STATE_W, STATE_H, STATE_Y = 19.0, 9.0, 37.0
state_defs = [(14.0, "排队", "blue", "收单入簿"),
              (35.0, "派单", "blue", "定项目定会话"),
              (56.0, "执行中", "blue", "turn 入簿"),
              (77.0, "待决策", "rose", "托管自动答"),
              (98.0, "完成", "teal", "结果摘要"),
              (119.0, "已播报", "teal", "屏与耳已发"),
              (140.0, "归档", "slate", "一行进 journal")]
for x, title, th, body in state_defs:
    cell(ax, x, STATE_Y, STATE_W, STATE_H, title, body, theme=th, tsize=13, bsize=11.5)
for x in (14.0, 35.0, 56.0, 77.0, 98.0, 119.0):
    arrow(ax, x + 19.2, STATE_Y + 4.5, x + 20.8, STATE_Y + 4.5, color=FLOW, lw=2.2, ms=13, z=4)

# 待决策 → 执行中：答完继续跑（卡片下方弧线，不穿容器边）
arrow(ax, 86.5, STATE_Y - 0.7, 65.5, STATE_Y - 0.7, color=BWD, lw=2.2, ls="--", ms=13, rad=-0.5, z=4)
txt(ax, 76.0, 34.4, "答完继续跑", size=11.5, color=BWD,
    bbox=dict(fc="white", ec="none", pad=1.4), z=7)

# A 的出口 → 状态机（追加 与 新派 落进入簿）
arrow(ax, 86.0, 63.5, 86.0, 58.6, color=FWD, lw=2.4, z=4)
arrow(ax, 118.0, 63.5, 118.0, 58.6, color=FWD, lw=2.4, z=4)
txt(ax, 58.0, 60.6, "指令入队", size=11.5, bbox=dict(fc="white", ec="none", pad=1.4), z=7)
txt(ax, 141.0, 60.6, "新会话入簿", size=11.5, bbox=dict(fc="white", ec="none", pad=1.4), z=7)

# ================= 容器 C：通知与播报 ==================================
container(ax, X0, 8.0, CW, 22.0)
header(ax, 12.0, 26.5, 144.0, 3.5, "③ 通知总线与播报优先级", theme="teal", size=14.5, z=5)
NOT_W, NOT_H, NOT_Y = 27.0, 15.0, 10.0
nots = [(96.0, "完成事件进簿", "按任务聚合去重", "teal"),
        (66.0, "优先级四档", "决策 大于 完成\n大于 里程碑 大于 进度", "rose"),
        (36.0, "合并成一句", "八秒内多条只播一次", "teal"),
        (6.0, "屏与耳朵同发", "气泡轨 ＋ 任务行\n缓存与预录", "slate")]
for x, title, body, th in nots:
    cell(ax, x, NOT_Y, NOT_W, NOT_H, title, body, theme=th, tsize=13.5, bsize=12)
for x1, x2 in ((95.6, 93.4), (65.6, 63.4), (35.6, 33.4)):
    arrow(ax, x1, NOT_Y + 7.5, x2, NOT_Y + 7.5, color=FLOW, lw=2.2, ms=13, z=4)

# 完成 状态 → 通知链（近垂直，不穿其它卡）
arrow(ax, 107.5, 37.0, 109.5, 25.4, color=BWD, lw=2.4, rad=0.06, z=4)
txt(ax, 124.0, 31.0, "完成即通知", size=11.5, bbox=dict(fc="white", ec="none", pad=1.4), z=7)

# 通知 → 设备（左缘回到入口卡）
ax.plot([6.0, 1.6, 1.6], [17.5, 17.5, 73.0], color=BWD, lw=2.6, zorder=3)
arrow(ax, 1.6, 73.0, 9.5, 73.0, color=BWD, lw=2.6, ms=16, z=6)
txt(ax, 1.6, 44.0, "一句播报 与 完成气泡", size=12.5, color=BWD, weight="bold", rot=90, z=7,
    bbox=dict(fc="white", ec="none", pad=1.8))

# ================= 图例与图名 ==========================================
legend_dot(ax, 8.0, 4.0, FWD, "派单前向", size=12)
legend_dot(ax, 46.0, 4.0, FLOW, "簿内与队列推进", size=12)
legend_dot(ax, 96.0, 4.0, BWD, "结果与播报", size=12)
legend_dot(ax, 132.0, 4.0, THEMES["rose"]["deep"], "需要人的环节", size=12)
txt(ax, 84.0, 0.4, "图 2 派单出口 任务状态机与播报优先级", size=13.5, weight="bold", font=HEI)

fig.savefig(OUT_PNG, dpi=300, bbox_inches="tight", facecolor="white")
fig.savefig(OUT_PDF, bbox_inches="tight", facecolor="white")
fig.savefig(OUT_SVG, bbox_inches="tight", facecolor="white")
print("written:", OUT_PNG, OUT_PDF, OUT_SVG)
