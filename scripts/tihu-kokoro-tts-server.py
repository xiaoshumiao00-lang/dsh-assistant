#!/usr/bin/env python
"""鹈鹕（tihu）Kokoro 常驻 TTS sidecar：sherpa-onnx + WebSocket，纯 CPU。

形态与 `scripts/tihu-qwen-tts-server.py` 一致：由 `src/tihu/tts.ts` 自己 spawn、
自己健康检查、自己重启；只绑 127.0.0.1；**常驻**进程（模型只加载一次，
实测 fp32 冷加载 1.1–2.1s，不留常驻就每次重启烧掉首包预算）。

协议（宿主 ↔ 本进程，内部协议，不是设备协议）：
    HTTP  GET /health          → {"engine":"kokoro","device":"cpu","sample_rate":24000,...}
    WS    /tts                 → 客户端发 {"type":"synth","id":1,"text":"…","sid":35,"speed":1.0}
                                 服务端按 120ms 分块回二进制 PCM（24000Hz 单声道 s16le），
                                 结束时回 {"type":"done","id":1,"audio_ms":…,"elapsed_ms":…}
                                 失败回 {"type":"error","id":1,"message":"…"}

模型：`~/.dsh/tihu/models/kokoro/kokoro-multi-lang-v1_1/`（**fp32 model.onnx**）。
      实测 int8 版反而慢 2.8–3.5 倍（RTF 1.34 对 0.477），这里显式拒绝 int8 权重。
Python：`~/.dsh/tihu/venv-sherpa/Scripts/python.exe`（sherpa-onnx 2.0.1 + websockets）。

用法（tts.ts 会自动带这些参数）：
    python -u scripts/tihu-kokoro-tts-server.py --port 8731 --num-threads 4
"""
import argparse
import asyncio
import json
import logging
import os
import sys
import time
from http import HTTPStatus

LOG = logging.getLogger("tihu-kokoro")

# 中文音色编号：sherpa-onnx 的 voices.bin 顺序（女声 3–57、男声 58–102）。
ZH_FEMALE_RANGE = (3, 57)
ZH_MALE_RANGE = (58, 102)


def repo_root() -> str:
    """本脚本在 <repo>/scripts/ 下，仓库根 = 上一层。"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def default_model_dir() -> str:
    """优先仓库内 models（开箱即用，随仓库分发），再回退 ~/.dsh 旧安装。"""
    repo = os.path.join(repo_root(), "models", "kokoro", "kokoro-multi-lang-v1_1")
    if os.path.isfile(os.path.join(repo, "model.onnx")):
        return repo
    return os.path.expanduser("~/.dsh/tihu/models/kokoro/kokoro-multi-lang-v1_1")


def resolve_assets_dir(model_dir: str) -> str:
    """词表/音色/espeak/fst 所在目录。

    本机的 fp32 权重目录里只放了 model.onnx（325.6MB），voices.bin、tokens.txt、
    lexicon-*.txt、espeak-ng-data、dict、*.fst 都在 int8 包里 —— 两包的文本前端资产
    完全相同，这里按「先看本目录，再看同级的 int8 包」解析，不复制 100MB。
    """
    if os.path.isfile(os.path.join(model_dir, "tokens.txt")):
        return model_dir
    sibling = os.path.join(os.path.dirname(os.path.normpath(model_dir)), "kokoro-int8-multi-lang-v1_1")
    if os.path.isfile(os.path.join(sibling, "tokens.txt")):
        return sibling
    return model_dir


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="tihu Kokoro TTS sidecar (sherpa-onnx, CPU)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8731)
    p.add_argument("--model-dir", default=os.environ.get("TIHU_KOKORO_MODEL_DIR") or default_model_dir())
    p.add_argument("--model", default="", help="默认 <model-dir>/model.onnx（fp32）")
    p.add_argument("--voices", default="", help="默认 <model-dir>/voices.bin")
    p.add_argument("--tokens", default="", help="默认 <model-dir>/tokens.txt")
    p.add_argument("--data-dir", default="", help="espeak-ng-data，默认 <model-dir>/espeak-ng-data")
    p.add_argument("--lexicon", default="", help="默认 <model-dir>/lexicon-us-en.txt,<model-dir>/lexicon-zh.txt")
    p.add_argument("--dict-dir", default="", help="jieba 词表目录，默认 <model-dir>/dict")
    p.add_argument("--rule-fsts", default="", help="默认 date-zh.fst,phone-zh.fst,number-zh.fst")
    p.add_argument("--num-threads", type=int, default=int(os.environ.get("TIHU_KOKORO_THREADS", "4")))
    p.add_argument("--sid", type=int, default=int(os.environ.get("TIHU_KOKORO_SID", "35")))
    p.add_argument("--speed", type=float, default=1.0)
    return p.parse_args(argv)


def require_file(path: str, what: str) -> str:
    if not os.path.isfile(path):
        raise SystemExit(f"[tihu-kokoro] 缺少{what}：{path}\n"
                         f"  安装模型：python -m pip install -U huggingface_hub && "
                         f"HF_ENDPOINT=https://hf-mirror.com python -c \"from huggingface_hub import snapshot_download as d; "
                         f"d('csukuangfj/kokoro-multi-lang-v1_1', local_dir=r'{default_model_dir()}')\"")
    return path


class KokoroEngine:
    def __init__(self, args):
        self.args = args
        model_dir = args.model_dir
        assets = resolve_assets_dir(model_dir)
        self.model = args.model or os.path.join(model_dir, "model.onnx")
        self.voices = args.voices or os.path.join(assets, "voices.bin")
        self.tokens = args.tokens or os.path.join(assets, "tokens.txt")
        self.data_dir = args.data_dir or os.path.join(assets, "espeak-ng-data")
        lexicon = args.lexicon or ",".join([
            os.path.join(assets, "lexicon-us-en.txt"),
            os.path.join(assets, "lexicon-zh.txt"),
        ])
        self.lexicon = lexicon
        self.dict_dir = args.dict_dir or os.path.join(assets, "dict")
        self.rule_fsts = args.rule_fsts or ",".join([
            os.path.join(assets, "date-zh.fst"),
            os.path.join(assets, "phone-zh.fst"),
            os.path.join(assets, "number-zh.fst"),
        ])

        if "int8" in os.path.basename(self.model).lower():
            raise SystemExit(
                "[tihu-kokoro] 拒绝加载 int8 权重：本机实测 int8 比 fp32 慢 2.8–3.5 倍"
                "（RTF 1.34 对 0.477）。请用 kokoro-multi-lang-v1_1/model.onnx（325.6MB）。")
        require_file(self.model, "模型 model.onnx")
        require_file(self.voices, "音色 voices.bin")
        require_file(self.tokens, "tokens.txt")
        if not os.path.isdir(self.data_dir):
            raise SystemExit(f"[tihu-kokoro] 缺少 espeak-ng-data 目录：{self.data_dir}")
        for item in self.lexicon.split(","):
            require_file(item.strip(), "词典 lexicon")
        for item in self.rule_fsts.split(","):
            if item.strip() != "":
                require_file(item.strip(), "文本规则 fst")

        try:
            import sherpa_onnx
        except ImportError:
            raise SystemExit(
                "[tihu-kokoro] 缺少 Python 包 sherpa-onnx。安装：\n"
                "  ~/.dsh/tihu/venv-sherpa/Scripts/python.exe -m pip install sherpa-onnx websockets")

        t0 = time.perf_counter()
        kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=self.model,
            voices=self.voices,
            tokens=self.tokens,
            data_dir=self.data_dir,
            lexicon=self.lexicon,
            dict_dir=self.dict_dir,
        )
        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=kokoro,
                num_threads=args.num_threads,
                debug=False,
                provider="cpu",
            ),
            rule_fsts=self.rule_fsts,
            max_num_sentences=1,
        )
        self.tts = sherpa_onnx.OfflineTts(cfg)
        self.load_s = time.perf_counter() - t0
        self.sample_rate = int(self.tts.sample_rate)
        self.num_speakers = int(self.tts.num_speakers)
        self.lock = asyncio.Lock()
        LOG.info("model loaded in %.2fs: sr=%d speakers=%d threads=%d model=%s",
                 self.load_s, self.sample_rate, self.num_speakers, args.num_threads,
                 os.path.basename(self.model))

    def synth(self, text: str, sid: int, speed: float):
        """阻塞合成（放到线程池里跑，别卡住事件循环）。"""
        # Windows 没有 resource 模块：time.process_time() 就是本进程的 CPU 秒数
        # （user+sys），用它算「这次合成吃了几核」：cpu_s / wall_s。
        cpu0 = time.process_time()
        t0 = time.perf_counter()
        audio = self.tts.generate(text=text, sid=sid, speed=speed)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        cpu_s = time.process_time() - cpu0
        import numpy as np
        samples = np.asarray(audio.samples, dtype=np.float32)
        return samples, int(audio.sample_rate), elapsed_ms, {"cpu_s": cpu_s}

    def health(self) -> dict:
        return {
            "engine": "kokoro",
            "device": "cpu",
            "status": "ok",
            "sample_rate": self.sample_rate,
            "num_speakers": self.num_speakers,
            "num_threads": self.args.num_threads,
            "model": self.model,
            "load_ms": int(self.load_s * 1000),
            "zh_female": list(ZH_FEMALE_RANGE),
            "zh_male": list(ZH_MALE_RANGE),
        }


def pcm16(samples) -> bytes:
    import numpy as np
    x = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (x * 32767.0).astype(np.int16).tobytes()


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="[tihu-kokoro] %(levelname)s %(message)s")
    args = parse_args(argv)

    try:
        from websockets.asyncio.server import serve
    except ImportError:
        print("[tihu-kokoro] 缺少 websockets 包。安装：\n"
              "  ~/.dsh/tihu/venv-sherpa/Scripts/python.exe -m pip install websockets", file=sys.stderr)
        return 2

    engine = KokoroEngine(args)

    async def handler(ws):
        peer = getattr(ws, "remote_address", None)
        LOG.info("client connected %s", peer)
        try:
            async for raw in ws:
                if isinstance(raw, (bytes, bytearray)):
                    await ws.send(json.dumps({"type": "error", "message": "只接受 JSON 文本帧"}))
                    continue
                try:
                    message = json.loads(raw)
                except Exception:
                    await ws.send(json.dumps({"type": "error", "message": "坏 JSON"}))
                    continue
                kind = str(message.get("type", ""))
                req_id = message.get("id", 0)
                if kind == "ping":
                    await ws.send(json.dumps({"type": "pong", "id": req_id}))
                    continue
                if kind != "synth":
                    await ws.send(json.dumps({"type": "error", "id": req_id, "message": f"未知消息 {kind}"}))
                    continue
                text = str(message.get("text", "")).strip()
                if text == "":
                    await ws.send(json.dumps({"type": "error", "id": req_id, "message": "空文本"}))
                    continue
                sid = int(message.get("sid", args.sid))
                speed = float(message.get("speed", args.speed))
                async with engine.lock:
                    started = time.perf_counter()
                    try:
                        samples, sr, elapsed_ms, cpu = await asyncio.to_thread(engine.synth, text, sid, speed)
                    except Exception as error:  # noqa: BLE001
                        LOG.exception("synth failed")
                        await ws.send(json.dumps({"type": "error", "id": req_id, "message": repr(error)}))
                        continue
                    data = pcm16(samples)
                    step = int(sr * 0.12) * 2  # 120ms / 单声道 16bit
                    for offset in range(0, len(data), step):
                        await ws.send(data[offset:offset + step])
                    await ws.send(json.dumps({
                        "type": "done",
                        "id": req_id,
                        "sample_rate": sr,
                        "audio_ms": int(round(len(samples) * 1000.0 / sr)),
                        "elapsed_ms": int(round(elapsed_ms)),
                        "wall_ms": int(round((time.perf_counter() - started) * 1000)),
                        "cpu_s": round(cpu["cpu_s"], 3),
                        "sid": sid,
                        "chars": len(text),
                    }))
        except Exception:  # 连接被宿主掐断是常态
            LOG.info("client disconnected %s", peer)

    def process_request(connection, request):
        path = getattr(request, "path", "/")
        if path.startswith("/health"):
            return connection.respond(HTTPStatus.OK, json.dumps(engine.health()) + "\n")
        return None

    async def run():
        async with serve(handler, args.host, args.port, process_request=process_request,
                         max_size=8 * 1024 * 1024):
            LOG.info("listening ws://%s:%d/tts (health http://%s:%d/health)",
                     args.host, args.port, args.host, args.port)
            await asyncio.Future()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
