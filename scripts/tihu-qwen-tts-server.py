#!/usr/bin/env python
"""Qwen3-TTS 0.6B PyTorch sidecar (CPU only).

独立于 DSH 主进程：只绑定 127.0.0.1，供 tihu 页面/宿主调用。
HTTP 兼容 codec.cpp 的那套：
  GET  /health
  GET  /v1/audio/voices
  POST /v1/audio/voices   (multipart: name, audio_sample)   -> 提取 speaker embedding 并落盘
  POST /v1/audio/speech   (JSON: input, voice:{id}, response_format:"pcm") -> 24k pcm16

音色缓存：<voices>/<name>.embed.pt + <name>.json；第二次同音色直接 load，不重算。
默认音色：<voices>/default.embed.pt（首次启动由脚本生成，参考音频 --default-ref）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np


def log(*parts):
    print("[qwen-tts]", *parts, flush=True)


def wav_to_int16(wav: np.ndarray) -> bytes:
    wav = np.asarray(wav, dtype=np.float32).reshape(-1)
    wav = np.clip(wav, -1.0, 1.0)
    return (wav * 32767.0).astype("<i2").tobytes()


def resample_linear(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or samples.size == 0:
        return samples.astype(np.float32)
    ratio = src_rate / dst_rate
    out_len = max(1, int(round(samples.size / ratio)))
    pos = np.arange(out_len, dtype=np.float64) * ratio
    lo = np.floor(pos).astype(np.int64)
    hi = np.minimum(lo + 1, samples.size - 1)
    frac = (pos - lo).astype(np.float32)
    return (samples[lo] * (1 - frac) + samples[hi] * frac).astype(np.float32)


class Server:
    def __init__(self, args):
        self.args = args
        self.voices_dir = Path(args.voices)
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self.loaded = {}
        self.model = None
        self.default_prompt = None

    def load_model(self):
        import torch
        from qwen_tts import Qwen3TTSModel

        torch.set_num_threads(self.args.threads)
        torch.set_flush_denormal(True)
        torch.set_grad_enabled(False)
        self.torch = torch
        self.device = "cpu"
        self.dtype_name = "fp32"
        if self.args.device == "cuda":
            if os.environ.get("TIHU_TTS_FORCE_NO_CUDA") == "1":
                log("TIHU_TTS_FORCE_NO_CUDA=1，模拟 GPU 不可用，退出")
                raise SystemExit(3)
            if not torch.cuda.is_available():
                log("cuda 不可用，退出（链路会切 Windows SAPI）")
                raise SystemExit(3)
            free, total = torch.cuda.mem_get_info()
            log(f"cuda free={free / 1024**3:.1f}GiB total={total / 1024**3:.1f}GiB")
            if free < 2 * 1024**3:
                log(f"cuda 可用显存 {free / 1024**2:.0f}MB < 2GB，退出（链路会切 Windows SAPI）")
                raise SystemExit(3)
            self.device = "cuda"
            self.dtype_name = self.args.dtype
        dtype = {
            "bf16": torch.bfloat16,
            "fp16": torch.float16,
            "fp32": torch.float32,
        }[self.dtype_name]
        log(f"loading model {self.args.model} threads={self.args.threads} device={self.device} dtype={self.dtype_name}")
        started = time.time()
        self.model = Qwen3TTSModel.from_pretrained(
            self.args.model,
            device_map={"": "cuda:0"} if self.device == "cuda" else "cpu",
            dtype=dtype,
            attn_implementation="sdpa",
            local_files_only=True,
        )
        log(f"model loaded in {time.time() - started:.1f}s")
        self.load_default()
        # 预热：CUDA 首次 generate 会做 kernel 选择/编译，几十秒；放到启动阶段，
        # 避免第一句回复卡在首包上。
        if self.device == "cuda" and self.default_prompt is not None:
            try:
                warm = time.time()
                with self.torch.inference_mode():
                    self.model.generate_voice_clone(text="你好", language="Chinese", voice_clone_prompt=self.default_prompt)
                log(f"cuda warmup done in {time.time() - warm:.1f}s")
            except Exception as error:  # noqa: BLE001
                log("cuda warmup failed:", repr(error))

    def load_default(self):
        pt = self.voices_dir / "default.embed.pt"
        ref = self.args.default_ref
        try:
            if pt.exists():
                self.default_prompt = self.torch.load(pt, map_location=self.device, weights_only=False)
                log("default voice cache loaded")
            elif ref and Path(ref).exists():
                self.default_prompt = self.model.create_voice_clone_prompt(ref_audio=ref, x_vector_only_mode=True)
                self.torch.save(self.default_prompt, pt)
                log(f"default voice embedding created from {ref}")
        except Exception as error:  # noqa: BLE001
            log("default voice unavailable:", repr(error))
            self.default_prompt = None

    def prompt_for(self, name: str | None):
        if not name or name == "default":
            return self.default_prompt
        pt = self.voices_dir / f"{name}.embed.pt"
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name):
            raise ValueError("bad voice name")
        if name in self.loaded:
            return self.loaded[name]
        if not pt.exists():
            raise ValueError(f"voice {name} has no embedding")
        prompt = self.torch.load(pt, map_location="cpu", weights_only=False)
        self.loaded[name] = prompt
        return prompt

    def synthesize(self, text: str, voice: str | None, language: str = "Chinese"):
        with self.torch.inference_mode():
            wavs, sr = self.model.generate_voice_clone(
                text=text,
                language=language,
                voice_clone_prompt=self.prompt_for(voice),
            )
        wav = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
        if sr != 24000:
            wav = resample_linear(wav, int(sr), 24000)
        return wav_to_int16(wav)

    def create_voice(self, name: str, wav_bytes: bytes):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name) or name == "default":
            raise ValueError("name must be 1-32 chars [A-Za-z0-9_-], not default")
        wav_path = self.voices_dir / f"{name}.wav"
        wav_path.write_bytes(wav_bytes)
        with self.torch.inference_mode():
            prompt = self.model.create_voice_clone_prompt(ref_audio=str(wav_path), x_vector_only_mode=True)
        self.torch.save(prompt, self.voices_dir / f"{name}.embed.pt")
        meta = {
            "id": name,
            "name": name,
            "created_at": int(time.time() * 1000),
            "bytes": len(wav_bytes),
        }
        (self.voices_dir / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        self.loaded[name] = prompt
        return meta


def parse_multipart(handler):
    """解析 multipart/form-data，返回 {name: value | (filename, bytes)}。"""
    content_type = handler.headers.get("Content-Type", "")
    length = int(handler.headers.get("Content-Length", "0"))
    body = handler.rfile.read(length)
    message = BytesParser(policy=email_policy).parsebytes(
        b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    fields = {}
    if not message.is_multipart():
        return fields
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        if part.get_filename():
            fields[name] = (part.get_filename(), payload)
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields


def make_handler(state: Server):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def json_reply(self, code: int, payload: dict):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                gpu = {}
                if state.device == "cuda":
                    free, total = state.torch.cuda.mem_get_info()
                    gpu = {
                        "free_mb": round(free / 1024 / 1024, 1),
                        "reserved_mb": round(state.torch.cuda.memory_reserved() / 1024 / 1024, 1),
                        "max_alloc_mb": round(state.torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
                    }
                self.json_reply(200, {"status": "ok", "model": "qwen3-tts-0.6b", "device": state.device, "dtype": state.dtype_name, "threads": state.args.threads, **gpu})
                return
            if self.path == "/v1/audio/voices":
                names = ["default"] if state.default_prompt is not None else []
                for item in sorted(state.voices_dir.glob("*.json")):
                    try:
                        meta = json.loads(item.read_text(encoding="utf-8"))
                        if isinstance(meta.get("id"), str):
                            names.append(meta["id"])
                    except Exception:  # noqa: BLE001
                        continue
                self.json_reply(200, {"voices": [{"id": name, "name": name} for name in dict.fromkeys(names)]})
                return
            self.json_reply(404, {"error": "not found"})

        def do_POST(self):
            try:
                if self.path == "/v1/audio/voices":
                    fields = parse_multipart(self)
                    name = str(fields.get("name", "")).strip()
                    sample = fields.get("audio_sample")
                    if not name or not isinstance(sample, tuple):
                        self.json_reply(400, {"error": "name and audio_sample are required"})
                        return
                    meta = state.create_voice(name, sample[1])
                    self.json_reply(200, {"id": meta["id"], "name": meta["name"], "created_at": meta["created_at"]})
                    return
                if self.path == "/v1/audio/speech":
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length) or b"{}")
                    text = str(body.get("input", "")).strip()
                    if not text:
                        self.json_reply(400, {"error": "input is required"})
                        return
                    voice = None
                    raw_voice = body.get("voice")
                    if isinstance(raw_voice, dict):
                        voice = raw_voice.get("id")
                    elif isinstance(raw_voice, str):
                        voice = raw_voice
                    started = time.time()
                    pcm = state.synthesize(text, voice)
                    elapsed = time.time() - started
                    log(f"synth chars={len(text)} voice={voice or 'default'} audio={len(pcm)/2/24000:.2f}s elapsed={elapsed:.2f}s")
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/pcm")
                    self.send_header("X-Sample-Rate", "24000")
                    self.send_header("X-Synth-Ms", str(int(elapsed * 1000)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    chunk = 24000 * 2 * 0.12  # 120ms
                    step = int(chunk)
                    for offset in range(0, len(pcm), step):
                        self.wfile.write(pcm[offset: offset + step])
                        self.wfile.flush()
                    return
                self.json_reply(404, {"error": "not found"})
            except Exception as error:  # noqa: BLE001
                log("request failed:", repr(error))
                traceback.print_exc()
                try:
                    self.json_reply(500, {"error": str(error)})
                except Exception:  # noqa: BLE001
                    pass

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--default-ref", default="")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8731)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    parser.add_argument("--dtype", default="bf16", choices=["bf16", "fp16", "fp32"])
    args = parser.parse_args()

    state = Server(args)
    state.load_model()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    log(f"listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
