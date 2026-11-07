#!/usr/bin/env python
"""edge-tts 单句流式合成：MP3 直接写到 stdout。

Node 侧用 ffmpeg 从管道解码成 24kHz/mono/pcm16，首块 1.5s 不到就杀掉切 SAPI。
失败（离线/403/超时）以非 0 退出。
"""
import argparse
import asyncio
import sys


async def run(text: str, voice: str, timeout: float) -> None:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            sys.stdout.buffer.write(chunk["data"])
            sys.stdout.buffer.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", default="zh-CN-YunjianNeural")
    parser.add_argument("--timeout", type=float, default=15.0)
    args = parser.parse_args()
    try:
        asyncio.run(asyncio.wait_for(run(args.text, args.voice, args.timeout), timeout=args.timeout))
    except Exception as error:  # noqa: BLE001
        print(f"edge-tts failed: {error!r}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
