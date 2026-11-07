#!/usr/bin/env python
"""edge-tts 单句流式合成：MP3 直接写到 stdout。

Node 侧用 ffmpeg 从管道解码成 24kHz/mono/pcm16，首块 1.5s 不到就杀掉切 SAPI。
失败（离线/403/超时）以非 0 退出。
"""
import argparse
import asyncio
import os
import sys


async def run(text: str, voice: str, rate: str, timeout: float, proxy: str | None) -> None:
    import edge_tts

    version = str(getattr(edge_tts, "__version__", "0"))
    if tuple(int(x) for x in version.split(".")[:3] if x.isdigit()) < (7, 3, 1):
        # 7.2.x 的 Sec-MS-GEC/DRM 实现已过期，Bing WSS 一律 403；7.3.1 已修正。
        print(f"edge-tts 版本过旧（{version}）会导致 403，请升级到 7.3.1+", file=sys.stderr)
        raise RuntimeError(f"edge-tts {version} 版本过旧（Sec-MS-GEC 已过期，403），请升级 7.3.1+")
    communicate = edge_tts.Communicate(text, voice, rate=rate, proxy=proxy)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            sys.stdout.buffer.write(chunk["data"])
            sys.stdout.buffer.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", default="zh-CN-YunjianNeural")
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--rate", default=os.environ.get("TIHU_EDGE_RATE", "+45%"))
    parser.add_argument("--proxy", default=os.environ.get("TIHU_EDGE_PROXY", "http://127.0.0.1:7897"))
    args = parser.parse_args()
    try:
        asyncio.run(asyncio.wait_for(run(args.text, args.voice, args.rate, args.timeout, args.proxy), timeout=args.timeout))
    except Exception as error:  # noqa: BLE001
        print(f"edge-tts failed: {error!r}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
