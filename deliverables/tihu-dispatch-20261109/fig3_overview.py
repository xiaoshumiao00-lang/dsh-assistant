# -*- coding: utf-8 -*-
"""图 3 · 鹈鹕助手统一指挥：架构 ＋ 八屏预期效果（一张图看完）

左：入口 → 派单出口 → 项目文件夹判定 → 任务状态机 → 播报优先级 → 分阶段
右：八张真实渲染的 320×240 屏（screens/s01…s08），每屏一行说明
配色：premium 四主题（slate / teal / blue / rose）；箭头三色（FWD / FLOW / BWD）
"""
import os
import sys

import matplotlib.image as mpimg
from matplotlib.patches import FancyBboxPatch

sys.path.insert(0, r"C:\Users\Administrator\.dsh\skills\aca-04-visual\scripts")
from sf_premium import *  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SHOT = os.path.join(HERE, "screens")

OUT_PNG = "fig3_tihu_overview.png"
OUT_PDF = "fig3_tihu_overview.pdf"
OUT_SVG = "fig3_tihu_overview.svg"

fig, ax = new_canvas(20.0, 17.0, 200, 170)


def card(x, ytop, w, h, title, body, theme="slate", tsize=12.5, bsize=11):
    cell(ax, x, ytop - h, w, h, title, body, theme=theme, tsize=tsize, bsize=bsize)


LX, LW = 3.0, 95.0

# ============================================================ ① 入口
container(ax, LX, 150.0, LW, 17.0)
header(ax, LX + 3, 163.5, LW - 8, 3.5, "① 一句话只进指挥会话", theme="teal", size=14, z=5)
card(5.0, 161.0, 38.0, 10.0, "唤醒词 · 点按 · 长按",
     "叫「你好，鹈鹕」就听\n说完停 3 秒发送", "slate", 12, 10.5)
arrow(ax, 43.6, 156.0, 47.4, 156.0, color=FWD, lw=2.6, ms=15, z=6)
card(48.0, 161.0, 45.0, 10.0, "指挥会话 · 只派单不干活",
     "听懂意图 → 选项目 → 报告结果", "teal", 12, 10.5)

# ============================================================ ② 派单四出口
container(ax, LX, 128.0, LW, 17.0)
header(ax, LX + 3, 141.5, LW - 8, 3.5, "② 派单出口 四选一", theme="teal", size=14, z=5)
outs = [(5.0, "自己直接答", "问答 记忆\n不落任务", "teal"),
        (28.5, "追加已有任务", "投进那条会话\n不再选文件夹", "blue"),
        (52.0, "新派任务会话", "新建会话\n落项目文件夹", "blue"),
        (75.5, "追问澄清一句", "歧义只问一句\n不猜项目", "rose")]
for x, t, b, th in outs:
    card(x, 139.0, 21.0, 10.0, t, b, th, 12, 10.5)

# ============================================================ ③ 文件夹判定
container(ax, LX, 99.0, LW, 26.0)
header(ax, LX + 3, 121.5, LW - 8, 3.5, "③ 新派 / 追加：项目文件夹怎么定", theme="blue", size=14, z=5)
rules = [(5.0, "复杂任务 · 已有卡片", "沿用该卡片文件夹\n同文件夹多个会话\n控制室与鹈鹕同一份", "blue"),
         (37.0, "复杂任务 · 新任务", "新建项目卡片\n立即同步到控制室\n文件夹随卡片一起建", "blue"),
         (69.0, "日常简单任务", "落 assistant 文件夹\n与长按悬浮球一致\n不建卡片不占项目", "teal")]
for x, t, b, th in rules:
    card(x, 118.5, 28.0, 18.0, t, b, th, 12, 10.5)

# ============================================================ ④ 状态机
container(ax, LX, 75.0, LW, 18.0)
header(ax, LX + 3, 89.5, LW - 8, 3.5, "④ 任务登记簿 七态", theme="blue", size=14, z=5)
states = [(5.0, "排队", "收单入簿", "blue"), (18.4, "派单", "定项目", "blue"),
          (31.8, "执行中", "turn 入簿", "blue"), (45.2, "待决策", "要人答", "rose"),
          (58.6, "完成", "结果摘要", "teal"), (72.0, "已播报", "屏与耳", "teal"),
          (85.4, "归档", "移出棋盘\n不删会话", "slate")]
for x, t, b, th in states:
    card(x, 87.0, 12.0, 11.0, t, b, th, 11, 9.0)
for x in (5.0, 18.4, 31.8, 45.2, 58.6, 72.0):
    arrow(ax, x + 12.1, 81.8, x + 13.0, 81.8, color=FLOW, lw=2.0, ms=11, z=4)

# ============================================================ ⑤ 播报
container(ax, LX, 49.0, LW, 22.0)
header(ax, LX + 3, 67.5, LW - 8, 3.5, "⑤ 播报优先级 与 合并", theme="teal", size=14, z=5)
prio = [(5.0, "P0 决策", "立即 屏＋声\n打断当前朗读", "rose"),
        (28.5, "P1 完成", "屏气泡逐条\n语音 8 秒攒一句", "teal"),
        (52.0, "P2 里程碑", "可播 低优先\n阶段切换", "teal"),
        (75.5, "P3 进度", "只上屏数字\n不念", "slate")]
for x, t, b, th in prio:
    card(x, 64.0, 21.0, 13.0, t, b, th, 12, 10.5)

# ============================================================ ⑥ 分阶段
container(ax, LX, 21.0, LW, 24.0)
header(ax, LX + 3, 41.5, LW - 8, 3.5, "⑥ 分阶段落地", theme="blue", size=14, z=5)
phases = [(5.0, "P0 播报止血", "完成即气泡＋播报\n不点会话也知结果", "teal"),
          (28.5, "P1 入口 ＋ 派单", "绑指挥会话\ndispatch＋文件夹规则", "blue"),
          (52.0, "P2 登记簿 ＋ 棋盘", "task.* 投影\n主页换任务棋盘", "blue"),
          (75.5, "P3 精修", "合并措辞／缓存预录\n托管自动答／归档", "slate")]
for x, t, b, th in phases:
    card(x, 38.0, 21.5, 15.0, t, b, th, 11.5, 10)

# 主干箭头
for ytop, ybot in ((150.0, 145.1), (128.0, 125.1), (99.0, 93.1)):
    arrow(ax, 20.0, ytop, 20.0, ybot, color=FWD, lw=2.6, ms=14, z=4)
arrow(ax, 20.0, 75.0, 20.0, 71.1, color=FLOW, lw=2.6, ms=14, z=4)

# 播报回传：⑤ → ①
ax.plot([4.0, 1.5, 1.5], [52.0, 52.0, 156.0], color=BWD, lw=2.4, zorder=3)
arrow(ax, 1.5, 156.0, 4.6, 156.0, color=BWD, lw=2.4, ms=14, z=6)
txt(ax, 1.5, 100.0, "屏气泡 与 一句播报", size=11, color=BWD, weight="bold", rot=90, z=7,
    bbox=dict(fc="white", ec="none", pad=1.4))

# ============================================================ 八屏
SEP = 101.5
ax.plot([SEP, SEP], [14.0, 168.0], color="#c9d2da", lw=1.0, ls=(0, (4, 3)), zorder=2)
txt(ax, SEP + 2.0, 92.0, "七屏 ＋ 空态 · 任务状态的投影", size=11, color="#4a5563", rot=90, z=8)

SW, SH = 40.0, 30.0
COLS = (108.0, 154.0)
ROWS = (166.0, 126.0, 86.0, 46.0)
shots = [
    ("s01_home_board.png", "屏 1 · 任务棋盘 · 胶囊＋进度环"),
    ("s02_dispatch_receipt.png", "屏 2 · 派单回执 · 5 秒自动回"),
    ("s03_listen.png", "屏 3 · 唤醒后说话 · 停 3 秒再发"),
    ("s04_task_detail.png", "屏 4 · 任务详情 · 沿用执行页"),
    ("s05_pending_decision.png", "屏 5 · 待决策 · 托管未开才出现"),
    ("s06_reply_done.png", "屏 6 · 完成播报 · 气泡进状态行"),
    ("s07_ask_which.png", "屏 7 · 歧义追问 · 只问一次"),
    ("s01_empty_board.png", "屏 1 空态 · 还没有任务（不另开一屏）"),
]
for i, (fn, cap) in enumerate(shots):
    col, row = i % 2, i // 2
    x, yt = COLS[col], ROWS[row]
    y = yt - SH
    txt(ax, x, yt + 2.6, cap, size=11.5, color="#1f2933", weight="bold", ha="left", z=8)
    ax.add_patch(FancyBboxPatch((x - 1.0, y - 1.0), SW + 2.0, SH + 2.0,
                                boxstyle="round,pad=0,rounding_size=1.2",
                                fc="white", ec="#8a97a5", lw=1.2, zorder=3))
    ax.imshow(mpimg.imread(os.path.join(SHOT, fn)), extent=(x, x + SW, y, y + SH),
              zorder=4, aspect="auto")

# ============================================================ 图例与图名
legend_dot(ax, 5.0, 14.0, FWD, "派单前向", size=11)
legend_dot(ax, 33.0, 14.0, FLOW, "簿内与队列推进", size=11)
legend_dot(ax, 72.0, 14.0, BWD, "结果与播报回传", size=11)
legend_dot(ax, 5.0, 9.0, THEMES["rose"]["deep"], "需要人的环节", size=11)
legend_dot(ax, 33.0, 9.0, THEMES["teal"]["deep"], "完成 / 出口", size=11)
legend_dot(ax, 72.0, 9.0, THEMES["blue"]["deep"], "项目与执行", size=11)

txt(ax, 108.0, 13.0, "回执 5 秒回 · 唤醒停 3 秒发送 · 10 秒无语音退出 · 待决策 60 秒按默认项 · 空闲＝屏 1 空态（不再单开一屏）", size=10, color="#4a5563", ha="left", z=8)
txt(ax, 108.0, 8.5, "动效语言：波形＝在听／在念；环＝上下文占用；微条＝最近 8 步耗时。", size=10, color="#4a5563", ha="left", z=8)

txt(ax, 100.0, 2.0, "图 3 鹈鹕助手统一指挥架构与七屏预期效果", size=13.5, weight="bold", font=HEI, ha="center")

fig.savefig(OUT_PNG, dpi=300, bbox_inches="tight", facecolor="white")
fig.savefig(OUT_PDF, bbox_inches="tight", facecolor="white")
fig.savefig(OUT_SVG, bbox_inches="tight", facecolor="white")
print("written:", OUT_PNG, OUT_PDF, OUT_SVG)
