#!/usr/bin/env python
"""edge-tts 常驻 worker：一次启动，顺序处理任意多条合成请求。

为什么存在（2026-11-22 实测）：单句脚本每次请求都要付 python 进程启动 +
import edge_tts + 建连的固定开销约 1.4s（probe 另计 0.5s），分块流式朗读会把这笔
开销乘到每一块上。常驻 worker 把固定开销摊成一次，单块合成只剩网络 + 合成本身。

协议（stdin 行帧，stdout 行帧 + 长度帧，全部二进制安全）：
  请求：stdin 一行 JSON
        {"id": N, "text": "...", "voice": "...", "rate": "+45%",
         "timeout": 20, "proxy": null}
  成功：stdout 一行 JSON 头 {"id": N, "ok": true, "bytes": M}，紧跟 M 字节 MP3，一次 flush
  失败：stdout 一行 JSON {"id": N, "ok": false, "error": "..."}

单协程顺序处理（一个 worker 同时只跑一条）；每条 asyncio.wait_for 兜底超时，
超时的请求回错误帧继续下一条，不会拖死队列。EOF / 任何未捕获异常 = 进程退出，
宿主据此判死并换新 worker（仍只走微软 edge-tts，绝不换引擎）。
"""
import asyncio
import json
import sys


def _force_threaded_resolver() -> None:
    """aiohttp DNS 换线程解析器（与 edge-tts.py 同一根因修复，见该文件 docstring）。"""
    import aiohttp.connector
    import aiohttp.resolver

    aiohttp.connector.DefaultResolver = aiohttp.resolver.ThreadedResolver


async def _read_line() -> bytes:
    # Windows 上 stdin 没有真正的异步读，丢线程池阻塞 readline
    return await asyncio.get_event_loop().run_in_executor(None, sys.stdin.buffer.readline)


async def _synth_one(req: dict, proxy: str | None) -> bytes:
    import edge_tts

    audio = bytearray()
    communicate = edge_tts.Communicate(
        str(req["text"]), str(req["voice"]), rate=str(req.get("rate") or "+45%"), proxy=proxy
    )
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            audio += chunk["data"]
    return bytes(audio)


def _write_frame(head: dict, payload: bytes) -> None:
    sys.stdout.buffer.write(json.dumps(head, ensure_ascii=False).encode("utf-8") + b"\n")
    if payload:
        sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


async def _main() -> int:
    _force_threaded_resolver()
    import edge_tts

    version = str(getattr(edge_tts, "__version__", "0"))
    if tuple(int(x) for x in version.split(".")[:3] if x.isdigit()) < (7, 3, 1):
        print(f"edge-tts 版本过旧（{version}）会导致 403，请升级到 7.3.1+", file=sys.stderr)
        return 3

    while True:
        line = await _read_line()
        if not line:
            return 0  # 宿主关掉 stdin = 正常退出
        try:
            req = json.loads(line.decode("utf-8"))
            req_id = req.get("id")
        except Exception:  # noqa: BLE001
            _write_frame({"id": None, "ok": False, "error": "bad request frame"}, b"")
            continue
        timeout = float(req.get("timeout") or 20)
        try:
            coro = _synth_one(req, req.get("proxy") or None)
            audio = await asyncio.wait_for(coro, timeout=timeout)
            if not audio:
                raise RuntimeError("edge-tts 空输出")
            _write_frame({"id": req_id, "ok": True, "bytes": len(audio)}, audio)
        except asyncio.TimeoutError:
            _write_frame({"id": req_id, "ok": False, "error": f"edge-tts 超时（{timeout:.0f}s）"}, b"")
        except Exception as error:  # noqa: BLE001
            _write_frame({"id": req_id, "ok": False, "error": str(error)[:300]}, b"")


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(_main()))
    except Exception as error:  # noqa: BLE001
        print(f"edge-tts worker failed: {error!r}", file=sys.stderr)
        raise SystemExit(3)
