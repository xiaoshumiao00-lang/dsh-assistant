# -*- coding: utf-8 -*-
"""鹈鹕 320×240 屏渲染（4×，1280×960）— 统一指挥版 · 第二轮美化

设计口径（本轮用户反馈）：
  1. 动效语言：波形（在听 / 播报中）、环形进度（任务完成度）、步骤点（第几步）、倒计时条。
  2. 只留有用信息：删掉「不用按住」「16 kHz 单声道」这类解释性废话。
  3. 八屏：1 棋盘 / 2 派单回执 / 3 唤醒 / 4 任务详情 / 5 危险确认 / 6 完成播报 / 7 歧义追问 / 8 空闲。
尺寸/字号/颜色仍取 src/tihu/screen-spec.ts 与 src/tihu/page.ts 的真实 token。
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

S = 4
W, H = 320 * S, 240 * S
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screens")
os.makedirs(OUT, exist_ok=True)

C = dict(
    bg="#05080b", panel="#121821", line="#1f2a37", fg="#e6edf3", dim="#8b98a5",
    accent="#3fb6a8", accent_soft="#17403a", warn="#e2b03f", err="#e05f5f",
    body="#c3ccd5", reply="#d9e2ea", summary="#8b97a5",
    run="#35d07f", done="#4f8ef7", idle="#6b7785",
    ok_dark="#04110f", btn_bg="#1b2430", btn_bd="#33414f", hint="#9fb0bf",
    okbg="#1d5f4f", okbd="#2a8f74", badbg="#2a1414", badbd="#b04545",
    summary_bg="#0d201c", summary_bd="#2a5a54", summary_fg="#9fd8cf",
    track="#182230", soft="#0f1620",
)

FONT_DIR = r"C:\Windows\Fonts"
FILES = {"hei": "simhei.ttf"}
_cache = {}


def font(name, size):
    key = (name, size)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(os.path.join(FONT_DIR, FILES[name]), int(size * S))
    return _cache[key]


def px(v):
    return int(round(v * S))


def screen():
    img = Image.new("RGB", (W, H), C["bg"])
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W - 1, H - 1], outline="#000000", width=px(1))
    return img, d


def fit(d, s, f, maxw):
    if d.textlength(s, font=f) <= px(maxw):
        return s
    while s and d.textlength(s + "…", font=f) > px(maxw):
        s = s[:-1]
    return s + "…"


_ANCHOR = {"la": "lt", "ra": "rt", "ma": "mt", "mm": "mm", "cc": "mm"}


def text(d, x, y, s, size, color, name="hei", maxw=None, anchor="la", bold_size=None):
    f = font(name, bold_size or size)
    if maxw is not None:
        s = fit(d, s, f, maxw)
    d.text((px(x), px(y)), s, font=f, fill=color, anchor=_ANCHOR.get(anchor, anchor))


def save(img, name):
    p = os.path.join(OUT, name)
    img.save(p, "PNG")
    print("written:", name)
    return p


# ------------------------------------------------------------------ 组件
def wave(d, cx, cy, heights, color=None, bw=8, gap=8):
    """竖向波形：一圈从中心向两边递减的竖条。"""
    color = color or C["accent"]
    n = len(heights)
    total = n * bw + (n - 1) * gap
    x = cx - total / 2
    for i, hgt in enumerate(heights):
        d.rounded_rectangle([px(x), px(cy - hgt / 2), px(x + bw), px(cy + hgt / 2)],
                            radius=px(bw / 2), fill=color)
        x += bw + gap


def ring(d, cx, cy, r, frac, color=None, track=None, width=5):
    color = color or C["accent"]
    track = track or C["track"]
    box = [px(cx - r), px(cy - r), px(cx + r), px(cy + r)]
    d.arc(box, 0, 360, fill=track, width=px(width))
    if frac > 0:
        d.arc(box, -90, -90 + 360 * min(frac, 1.0), fill=color, width=px(width))


def dots(d, x, y, total, done, cur=None, r=3, gap=11, color=None, dim=None):
    color = color or C["accent"]
    dim = dim or "#2b3745"
    for i in range(total):
        cc = color if i < done else (color if (cur is not None and i == cur) else dim)
        if cur is not None and i == cur:
            d.ellipse([px(x + i * gap - r - 1), px(y - r - 1), px(x + i * gap + r + 1), px(y + r + 1)],
                      outline=color, width=px(1))
        d.ellipse([px(x + i * gap - r), px(y - r), px(x + i * gap + r), px(y + r)], fill=cc)


def tri(d, cx, cy, dirn, size, color):
    s = size
    if dirn < 0:
        pts = [(cx - s * 0.45, cy), (cx + s * 0.5, cy - s * 0.62), (cx + s * 0.5, cy + s * 0.62)]
    else:
        pts = [(cx + s * 0.45, cy), (cx - s * 0.5, cy - s * 0.62), (cx - s * 0.5, cy + s * 0.62)]
    d.polygon([(px(a), px(b)) for a, b in pts], fill=color)


def clock(d, s="15:42", x=8):
    text(d, x, 8, s, 12, C["accent"], bold_size=12)


def signal(d, x_right=312, online=True):
    base_y = 20
    col = C["run"] if online else C["err"]
    x = x_right - (3 * 5 + 2 * 2)
    for i, hgt in enumerate([5, 9, 13]):
        d.rounded_rectangle([px(x + i * 7), px(base_y - hgt), px(x + i * 7 + 5), px(base_y)],
                            radius=px(1), fill=col)


def stage_row(d, label, color, sub=None):
    text(d, 8, 8, label, 12, color)
    if sub:
        text(d, 312, 8, sub, 12, C["dim"], anchor="rt")


def title_row(d, s, color=None, maxw=304):
    text(d, 8, 26, s, 18, color or C["fg"], maxw=maxw, bold_size=18)


def pager(d, idx=1, total=2, x0=8, x1=312):
    y = 202
    d.rounded_rectangle([px(x0), px(y), px(x0 + 64), px(y + 28)], radius=px(6),
                        fill=C["btn_bg"], outline=C["btn_bd"], width=px(1))
    tri(d, x0 + 32, y + 14, -1, 11, "#d9e2ea")
    d.rounded_rectangle([px(x1 - 64), px(y), px(x1), px(y + 28)], radius=px(6),
                        fill=C["btn_bg"], outline=C["btn_bd"], width=px(1))
    tri(d, x1 - 32, y + 14, 1, 11, "#d9e2ea")
    text(d, (x0 + x1) / 2, y + 14, f"{idx}/{total} 页 · 点行看详情", 12, C["hint"], anchor="mm")


def buttons(d, items, y=196, h=28, x0=8, x1=312, gap=8, size=13):
    n = len(items)
    w = (x1 - x0 - gap * (n - 1)) / n
    for i, (label, kind) in enumerate(items):
        bx = x0 + i * (w + gap)
        if kind == "ok":
            bg, bd, fg = C["okbg"], C["okbd"], "#d9f5ee"
        elif kind == "bad":
            bg, bd, fg = C["badbg"], C["badbd"], "#ffd9d9"
        else:
            bg, bd, fg = C["btn_bg"], C["btn_bd"], "#d9e2ea"
        d.rounded_rectangle([px(bx), px(y), px(bx + w), px(y + h)], radius=px(6),
                            fill=bg, outline=bd, width=px(1))
        text(d, bx + w / 2, y + h / 2, label, size, fg, anchor="mm")


def chip(d, x, y, w, h, label, bg, fg, size=10):
    d.rounded_rectangle([px(x), px(y), px(x + w), px(y + h)], radius=px(4),
                        fill=bg, outline=fg, width=px(1))
    text(d, x + w / 2, y + h / 2, label, size, fg, anchor="mm")


def barline(d, x0, x1, y, frac, color=None, h=5, label=None, label_size=10):
    color = color or C["accent"]
    d.rounded_rectangle([px(x0), px(y), px(x1), px(y + h)], radius=px(h / 2), fill=C["track"])
    if frac > 0:
        d.rounded_rectangle([px(x0), px(y), px(x0 + (x1 - x0) * min(frac, 1.0)), px(y + h)],
                            radius=px(h / 2), fill=color)
    if label:
        text(d, x1, y - 10, label, label_size, C["dim"], anchor="rt")


# ================================================================== 屏 1 棋盘
# 环＝已用时长：满圈 30 分钟（半小时刻度），超过就绕满转琥珀；精确值写在副行
TASKS = [("run", "执行中", "改写第 3 段", "青年基金申请书 · 第 4 步 · 12′20″", 12.3),
         ("warn", "待决策", "删旧结果文件", "dsh-assistant · 等你一句话 · 3′08″", 3.1),
         ("run", "执行中", "补温度场图", "磷石膏 SCI · 第 2 步 · 41′05″", 41.1),
         ("queue", "排队", "整理今日产出", "控制室 · 前面 2 条", None),
         ("done", "完成", "查快递到哪了", "个人助手 · 已播报 · 1′12″", 1.2)]
CHIP = {"run": ("#0d2a24", "#3fb6a8"), "warn": ("#2a2410", "#e2b03f"),
        "done": ("#101f38", "#4f8ef7"), "queue": ("#1a1f26", "#8b98a5")}
RINGC = {"run": "#3fb6a8", "warn": "#e2b03f", "done": "#4f8ef7", "queue": "#33414f"}


def s01_home():
    img, d = screen()
    # 顶行：时钟 + 右端两项计数（左上角连接点已按用户要求删掉）
    text(d, 8, 8, "15:42", 12, C["accent"], bold_size=12)
    x = 304.0
    for cnt, label, col in ((1, "排队", C["hint"]), (1, "等你", C["warn"]), (2, "在跑", C["run"])):
        s = f"{cnt} {label}"
        w = d.textlength(s, font=font("hei", 11)) / S
        x -= w
        text(d, x, 9, s, 11, C["body"])
        x -= 7
        d.ellipse([px(x), px(12.5), px(x + 5), px(17.5)], fill=col)
        x -= 12
    y = 28
    for i, (st, tag, name, sub, mins) in enumerate(TASKS):
        if i:
            d.line([px(8), px(y - 0.5), px(312), px(y - 0.5)], fill="#121a22", width=px(1))
        bg, fg = CHIP[st]
        chip(d, 8, y + 1, 42, 16, tag, bg, fg)
        text(d, 56, y, name, 16, C["fg"], maxw=214, bold_size=16)
        if st == "warn":
            # 待决策：明确问号，不画时长环
            d.ellipse([px(286), px(y + 1), px(302), px(y + 17)], outline=C["warn"], width=px(1))
            text(d, 294, y + 9, "?", 11, C["warn"], anchor="mm")
        elif mins is None:
            ring(d, 294, y + 9, 8, 0.0, color=RINGC[st], width=3)
        else:
            # 环＝已用时长：满圈 30 分钟；完成＝满环；超过 30 分钟绕满转琥珀
            ring(d, 294, y + 9, 8, 1.0 if st == "done" else min(mins / 30.0, 1.0),
                 color=C["warn"] if (st != "done" and mins > 30) else RINGC[st], width=3)
        text(d, 56, y + 19, sub, 12, C["summary"], maxw=250)
        y += 34
    pager(d, 1, 2)
    return save(img, "s01_home_board.png")


# ================================================================== 屏 2 派单回执
def s02_dispatch():
    img, d = screen()
    stage_row(d, "派单", C["accent"])
    title_row(d, "已派给 青年基金申请书", maxw=304)
    # 三步：已入队 → 排队 N 个 → 开始跑（第二颗点自己带内容，下方不再重复排队行）
    steps = [("已入队", True), ("排队 2 个", False), ("开始跑", False)]
    xs = [24, 160, 296]
    for i, (s, active) in enumerate(steps):
        if i < 2:
            d.line([px(xs[i] + 8), px(60), px(xs[i + 1] - 8), px(60)], fill=C["track"], width=px(2))
        d.ellipse([px(xs[i] - 6), px(54), px(xs[i] + 6), px(66)],
                  fill=C["accent"] if active else C["track"],
                  outline=C["accent"] if active else C["btn_bd"], width=px(1))
        text(d, xs[i], 74, s, 11, C["accent"] if active else C["hint"], anchor="mt")
    # 这一句落在哪个文件夹
    text(d, 8, 104, "文件夹", 11, C["hint"])
    text(d, 56, 101, "E:\\…\\青年基金申请书", 14, C["accent"], maxw=252)
    d.line([px(8), px(128), px(312), px(128)], fill="#121a22", width=px(1))
    text(d, 8, 136, "约 1 分钟后开始跑", 12, C["hint"])
    text(d, 8, 158, "5 秒后自动回棋盘", 12, C["hint"])
    barline(d, 8, 312, 176, 0.8, h=4)
    buttons(d, [("看任务", "ok"), ("撤单", "plain")], y=190, h=32)
    return save(img, "s02_dispatch_receipt.png")


# ================================================================== 屏 3 唤醒
def s03_listen():
    img, d = screen()
    stage_row(d, "在听", C["accent"], sub="已唤醒")
    title_row(d, "我在，说吧")
    wave(d, 160, 112, [14, 30, 52, 30, 66, 30, 52, 30, 14])
    text(d, 160, 160, "说完停 3 秒再发送", 12, C["summary_fg"], anchor="mm")
    d.line([px(8), px(182), px(312), px(182)], fill=C["line"], width=px(1))
    text(d, 160, 196, "想清楚再说不着急", 11, C["hint"], anchor="mm")
    text(d, 160, 218, "10 秒没说话就退出 · 长按也能说", 11, C["hint"], anchor="mm")
    return save(img, "s03_listen.png")


# ================================================================== 屏 4 任务详情
def icon_step(d, x, y, num, color=None):
    """步骤徽标：圆角方块 + 数字。"""
    color = color or C["accent"]
    d.rounded_rectangle([px(x), px(y), px(x + 22), px(y + 18)], radius=px(4),
                        fill="#0d2a24", outline=color, width=px(1))
    text(d, x + 11, y + 9, str(num), 12, color, anchor="mm", bold_size=12)


def icon_clock(d, x, y, color=None):
    """时钟图标：圆 + 时针分针。"""
    color = color or C["accent"]
    cx, cy, r = x + 9, y + 9, 8
    d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], outline=color, width=px(2))
    d.line([px(cx), px(cy), px(cx), px(cy - 4.5)], fill=color, width=px(2))
    d.line([px(cx), px(cy), px(cx + 3.5), px(cy + 2)], fill=color, width=px(2))


def s04_detail():
    img, d = screen()
    # 沿用现有执行页：stage＝工具阶段词，标题＝「执行 xxx」，正文＝步数用时＋结果两行＋统计
    stage_row(d, "跑命令", C["warn"])
    title_row(d, "第 7 步 · 已用 1m23s", maxw=304)
    # 实时两行照现在的鹈鹕屏（标签 · 明细），再统计一行
    text(d, 8, 56, "工具 · read_image", 16, C["body"], maxw=304)
    text(d, 8, 78, "思考 · s05 now shows 项目 · 会话 and …", 16, C["body"], maxw=304)
    text(d, 8, 104, "82 tok/s · 12.3k tok · 上下文 41%", 14, C["dim"], maxw=304)
    d.line([px(8), px(152), px(312), px(152)], fill=C["line"], width=px(1))
    text(d, 8, 160, "青年基金申请书 · 改写第 3 段", 12, C["summary"], maxw=304)
    buttons(d, [("看会话", "ok"), ("停止", "plain"), ("回棋盘", "plain")], y=196, h=30, size=12)
    return save(img, "s04_task_detail.png")


# ================================================================== 屏 5 待决策
def s05_decision():
    """待决策：只在「托管」没点亮时出现；写清是哪个项目文件夹、哪条会话的决策。"""
    img, d = screen()
    d.rectangle([0, 0, W - 1, H - 1], outline=C["warn"], width=px(2))
    stage_row(d, "待决策", C["warn"], sub="托管未开")
    title_row(d, "删掉 3 个旧结果文件？", maxw=304)
    text(d, 8, 52, "青年基金申请书 · 改写第 3 段", 11, C["summary"], maxw=304)
    text(d, 8, 70, ".tihu/snapshots/20261109-1542/", 11, C["dim"], maxw=304)
    opts = [("确认删除", "默认", True), ("先留着，别删", "", False)]
    y = 88
    for label, tag, primary in opts:
        bg = "#2a2410" if primary else "#121821"
        bd = C["warn"] if primary else C["btn_bd"]
        d.rounded_rectangle([px(8), px(y), px(312), px(y + 38)], radius=px(8),
                            fill=bg, outline=bd, width=px(1))
        d.ellipse([px(20), px(y + 12), px(38), px(y + 30)],
                  outline=C["warn"] if primary else C["btn_bd"], width=px(2))
        if primary:
            d.ellipse([px(24), px(y + 16), px(34), px(y + 26)], fill=C["warn"])
        text(d, 48, y + 9, label, 15, C["fg"], maxw=200, bold_size=15)
        if tag:
            chip(d, 258, y + 11, 46, 16, tag, "#2a2410", C["warn"], size=10)
        y += 46
    text(d, 8, 184, "60 秒不答，就按「确认删除」走", 11, C["hint"])
    barline(d, 8, 312, 198, 0.7, color=C["warn"], h=4)
    text(d, 160, 216, "说「确认」或「留着」也行", 11, C["hint"], anchor="mm")
    return save(img, "s05_pending_decision.png")


# ================================================================== 屏 6 完成播报
def s06_reply():
    img, d = screen()
    text(d, 8, 8, "完成", 12, C["accent"])
    wave(d, 162, 14, [5, 9, 14, 9, 5], color=C["accent"], bw=3, gap=2)
    # 另有完成的，收进状态行：一句 + 右箭头
    text(d, 252, 8, "另有 2 条", 12, C["summary_fg"], anchor="rt")
    tri(d, 308, 15, 1, 8, C["summary_fg"])
    text(d, 8, 30, "第 3 段改写完成", 18, C["fg"], maxw=304, bold_size=18)
    lines = ["温度场结果已收敛，跨中腹板", "温差 1.1 ℃，比目标 1.5 ℃ 还好。",
             "第 4 步把边界拆成了两段：", "夜间常数 2.448 ℃，白天用 ERA5。",
             "图和表已落到 04-结果 目录。", "文件名按昨天的规范改了。",
             "要接着改第 3 段吗？"]
    y = 56
    for i, ln in enumerate(lines):
        if i == 1:
            d.rounded_rectangle([px(6), px(y - 1), px(310), px(y + 19)], radius=px(3), fill=C["accent"])
            text(d, 8, y, ln, 16, C["ok_dark"], maxw=298)
        else:
            text(d, 8, y, ln, 16, C["reply"], maxw=298)
        y += 20
    buttons(d, [("停止", "plain"), ("重读", "plain"), ("主页", "plain")], y=200, size=13)
    return save(img, "s06_reply_done.png")


# ================================================================== 屏 7 歧义追问
def s07_ask():
    img, d = screen()
    stage_row(d, "追问", C["warn"], sub="只问一次")
    title_row(d, "这句话派给谁？", maxw=304)
    opts = [("1", "青年基金申请书", "第 3 段 · 昨天在跑"),
            ("2", "磷石膏 SCI", "温度场图 · 刚改完")]
    y = 66
    for no, nm, sub in opts:
        d.rounded_rectangle([px(8), px(y), px(312), px(y + 48)], radius=px(8),
                            fill=C["chipbg"] if False else "#0f1620", outline=C["btn_bd"], width=px(1))
        d.ellipse([px(18), px(y + 13), px(42), px(y + 37)], outline=C["accent"], width=px(2))
        text(d, 30, y + 25, no, 15, C["accent"], anchor="mm")
        text(d, 52, y + 7, nm, 16, C["fg"], maxw=250, bold_size=16)
        text(d, 52, y + 28, sub, 11, C["summary"], maxw=250)
        y += 56
    buttons(d, [("1", "ok"), ("2", "plain"), ("都不是", "plain")], y=200, h=28, size=13)
    return save(img, "s07_ask_which.png")


# ================================================================== 屏 1 空态（不再单独占一屏）
def s01_empty():
    """空闲不再是另一屏：还是屏 1，只是棋盘空着，中间给一句怎么开始。"""
    img, d = screen()
    text(d, 8, 8, "15:44", 12, C["accent"], bold_size=12)
    x = 304.0
    for cnt, label, col in ((0, "排队", C["hint"]), (0, "等你", C["warn"]), (0, "在跑", C["run"])):
        s = f"{cnt} {label}"
        w = d.textlength(s, font=font("hei", 11)) / S
        x -= w
        text(d, x, 9, s, 11, C["dim"])
        x -= 7
        d.ellipse([px(x), px(12.5), px(x + 5), px(17.5)], fill=col)
        x -= 12
    wave(d, 160, 92, [10, 22, 34, 22, 34, 22, 10], color=C["accent"])
    text(d, 160, 132, "还没有任务", 18, C["fg"], anchor="mm", bold_size=18)
    text(d, 160, 158, "叫「你好，鹈鹕」说一句，或者点屏", 12, C["summary_fg"], anchor="mm")
    text(d, 160, 178, "说完这里就变成任务棋盘", 11, C["hint"], anchor="mm")
    return save(img, "s01_empty_board.png")


if __name__ == "__main__":
    s01_home(); s01_empty(); s02_dispatch(); s03_listen(); s04_detail()
    s05_decision(); s06_reply(); s07_ask()
