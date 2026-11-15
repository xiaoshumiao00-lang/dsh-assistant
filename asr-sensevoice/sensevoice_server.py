#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""鹈鹕 SenseVoice 常驻转写服务（127.0.0.1:3098）。

为什么要有这一层
----------------
2026-11-14 实测：手机 APK 录音这条路以前固定走 whisper.cpp（127.0.0.1:3097），
而 `asr_server.py` **每个请求都新起一个 whisper-cli 子进程**：付 CUDA 初始化 +
把 1.5GB 的 medium 模型重新上传一遍，实测只要音频就 1.9s（small）/3.1s（medium），
真录音 2.0–2.6s，撞上 strata（RTX 5080 已被占 12.8GB、GPU 99%）的窗口就 15–28s。
本服务把 SenseVoice-small ONNX **只加载一次、进程不退出**，之后每次转写只剩推理：
量化档案实测 fp32/4 线程 = 0.20 RTF（5 秒音频 983ms），比冷启动的 whisper 快一个数量级。

契约与 whisper 那份保持一致（relay 不用改口径）：
  POST /transcribe            body = 原始 WAV(16k/mono/16bit)，也接受 base64 / multipart
     ?model=fp32|int8        模型选择（默认 fp32）；未知值一律按默认
     200 {"text","ms","audioMs","rms","model","modelKey","engine",...}
  GET  /health               {"ok":true,"model","threads","uptimeSec","requests",...}

行为约定
--------
* 常驻：模型加载一次，进程不退出、不回收（`idleTimeoutMs` 只是与宿主插件对齐的记录项）。
* 串行：`_ASR_LOCK` 一次只跑一段（与宿主插件「一个串行 SenseVoice worker」同构），并发进来排队。
* 分段：SenseVoice 只吃 ≤30 秒窗口，所以长录音按 Silero VAD 切段（阈值 0.5、
  尾静音 0.5s、最短语音 0.25s、段上限 30s），和 cordis.patch.yml 里的插件设置同参数。
* 静音门：与 whisper 那份同一个尺（rms<50 直接空结果、不推理），`minDurationMs` 250。
* 空结果 ≠ 失败：静音/太短/坏音频返回 `{"text":"","reason":...}`；服务出错返回 5xx。
  relay 据此决定要不要退回 whisper（静音不会触发退回，避免白跑一趟模型）。

用法
----
起服务：`D:\\dsh-assistant\\asr-sensevoice\\start-sensevoice.cmd`（健康检查后拉起，日志落 sensevoice.log）
自检：`python sensevoice_server.py --selftest <wav>`（加载模型→转写→打印分段耗时→退出，不起服务）
改回 whisper：`~/.dsh/assistant/config.json` → `tihu.voice.asrEngine: "whisper"`（改完重启 relay）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time
import traceback
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import sherpa_onnx

ROOT = Path(__file__).resolve().parent
SENSEVOICE_HOME = Path(os.path.expanduser("~/.dsh/speech-to-text/sensevoice/models"))

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 3098,
    # fp32 主模型（937,617,178B）；int8（239,233,841B）留给显存紧张的时候手工切
    "model": str(SENSEVOICE_HOME / "sensevoice-onnx/model.onnx"),
    "fallbackModel": str(SENSEVOICE_HOME / "sensevoice-onnx/model.int8.onnx"),
    "tokens": str(SENSEVOICE_HOME / "sensevoice-onnx/tokens.txt"),
    "vadModel": str(SENSEVOICE_HOME / "silero/silero_vad.onnx"),
    "threads": 8,                    # 与 cordis.patch.yml 的插件设置（threads: 8）一致
    "precision": "fp32",             # 与插件设置（precision: fp32）一致
    "idleTimeoutMs": 1800000,        # 与插件设置一致；本服务常驻，不靠它回收
    "resident": True,
    "language": "zh",
    "useItn": True,
    "vadThreshold": 0.5,
    "minSpeechSeconds": 0.25,
    "minSilenceSeconds": 0.5,
    "segmentSeconds": 30,
    # 修头：VAD 判定起始往回保留的前导缓冲（毫秒）与相邻段合并的间隔上限（秒）。
    # 实际生效值看 sensevoice.config.json（2026-11-14 改成 0.15 / 500 / 0.8）。
    "vadStartPadMs": 500,
    "vadMergeGapSeconds": 0.8,
    # 和 whisper 那份 / 宿主 lane.ts 的 TIHU_VOICE_SILENT_RMS 同一把尺（int16 量纲）
    "silenceRms": 50,
    "minDurationMs": 250,
    "maxBytes": 33554432,
    "timeoutSec": 120,
    "ffmpeg": "",
    "simplified": True,
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    path = ROOT / "sensevoice.config.json"
    if path.is_file():
        try:
            cfg.update(json.loads(path.read_text(encoding="utf-8")))
        except Exception as error:  # 配置写坏了就退回默认值，服务必须能起来
            log(f"config 解析失败，用默认值：{error}")
    for key in ("port", "threads", "maxBytes", "timeoutSec", "silenceRms", "minDurationMs",
                "idleTimeoutMs", "segmentSeconds", "vadStartPadMs"):
        try:
            cfg[key] = int(cfg[key])
        except (TypeError, ValueError):
            cfg[key] = DEFAULT_CONFIG[key]
    for key in ("vadThreshold", "minSpeechSeconds", "minSilenceSeconds", "vadMergeGapSeconds"):
        try:
            cfg[key] = float(cfg[key])
        except (TypeError, ValueError):
            cfg[key] = DEFAULT_CONFIG[key]
    return cfg


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}", flush=True)


CFG = load_config()
STATS = {"requests": 0, "failures": 0, "lastMs": 0, "lastText": "", "startedAt": time.time(),
         "modelLoadMs": 0, "vadMs": 0}

# SenseVoice 一次只让一个推理流在跑（onnxruntime 的离线识别器不是并发安全的）。
_ASR_LOCK = threading.Lock()
RECOGNIZER = None
VAD = None
MODEL_PATH = None


# ── 模型与 VAD：启动加载一次，之后常驻在内存 ────────────────────────────────

def _resolve_path(raw: str) -> Path:
    path = Path(os.path.expanduser(str(raw)))
    if not path.is_absolute():
        path = ROOT / path
    return path


def build_recognizer(model_path: Path) -> object:
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model_path),
        tokens=str(_resolve_path(CFG["tokens"])),
        num_threads=int(CFG["threads"]),
        sample_rate=16000,
        feature_dim=80,
        decoding_method="greedy_search",
        provider="cpu",
        language=str(CFG.get("language") or ""),
        use_itn=bool(CFG.get("useItn", True)),
        debug=False,
    )


def build_vad():
    vad_path = _resolve_path(CFG.get("vadModel") or "")
    if not vad_path.is_file():
        return None
    started = time.time()
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(vad_path)
    config.silero_vad.threshold = float(CFG["vadThreshold"])
    config.silero_vad.min_silence_duration = float(CFG["minSilenceSeconds"])
    config.silero_vad.min_speech_duration = float(CFG["minSpeechSeconds"])
    config.silero_vad.max_speech_duration = float(min(30.0, int(CFG["segmentSeconds"])))
    config.sample_rate = 16000
    vad = sherpa_onnx.VadModel.create(config)
    if vad is None:
        return None
    STATS["vadMs"] = int((time.time() - started) * 1000)
    return vad


def init_backends(model_key: str = "") -> None:
    """加载 fp32 主模型；主模型读不到就换 int8（一次性的，之后照样常驻）。"""
    global RECOGNIZER, VAD, MODEL_PATH
    primary = _resolve_path(CFG["model"])
    fallback = _resolve_path(CFG.get("fallbackModel") or "")
    wanted = str(model_key or "").strip().lower()
    candidates = [primary, fallback]
    if wanted in ("int8", "fp32"):
        order = "model" if wanted == "fp32" else "fallbackModel"
        candidates = [_resolve_path(CFG[order])] + candidates
    last_error = ""
    for path in candidates:
        if not path or not path.is_file():
            last_error = f"模型文件不存在：{path}"
            continue
        started = time.time()
        try:
            RECOGNIZER = build_recognizer(path)
        except Exception as error:
            last_error = f"{path.name}: {error}"
            continue
        MODEL_PATH = path
        STATS["modelLoadMs"] = int((time.time() - started) * 1000)
        VAD = build_vad()
        if VAD is None:
            log("Silero VAD 加载失败：改用按长度硬切段（30 秒一段）")
        log(f"模型常驻就绪：{path.name} threads={CFG['threads']} vad={'silero' if VAD else 'none'} "
            f"load={STATS['modelLoadMs']}ms")
        return
    raise RuntimeError(f"SenseVoice 模型加载失败：{last_error}")


def model_key_of(path: Path) -> str:
    return "int8" if "int8" in path.stem.lower() else "fp32"


# ── 繁简 / 幻觉过滤 / 唤醒词同音表：与 whisper 那份同一套 ───────────────────

try:
    from opencc import OpenCC  # type: ignore
    _T2S = OpenCC("t2s") if CFG.get("simplified", True) else None
except Exception:
    _T2S = None

HALLUCINATION_EXACT = {
    "字幕", "字幕组", "中文字幕", "中文字幕制作", "字幕制作", "字幕提供",
    "字幕由amaraorg社区提供", "字幕由amaraorg提供", "amaraorg社区提供",
    "谢谢观看", "谢谢收看", "谢谢收听", "感谢观看", "感谢收看", "感谢收听",
    "谢谢大家观看", "谢谢大家收看", "谢谢您的观看", "谢谢您的收看",
    "请不吝点赞订阅", "请不吝点赞订阅转发打赏支持明镜与点点栏目", "订阅频道",
    "欢迎订阅", "下次再见",
}
HALLUCINATION_PATTERNS = [
    re.compile(r"(请)?(不吝)?(点赞|订阅|转发|打赏|支持|收藏|关注|分享){1,6}(明镜与?点点栏目)?"),
    re.compile(r"(谢谢|感谢)(大家|您|各位|观众)?(的)?(观看|收看|收听|支持|关注)"),
    re.compile(r"(请|欢迎)(大家)?(点赞|订阅|关注|转发)(一下)?"),
    re.compile(r"字幕(由)?[^。]{0,30}(提供|制作)?"),
    re.compile(r"明镜与?点点(栏目)?"),
]

WAKE_HOMOPHONES = (
    "蹄虎", "蹄湖", "蹄呼", "蹄鹕", "提壶", "提虎", "提湖", "提鹕", "提呼",
    "剃胡", "剃鹕", "题湖", "题鹕", "踢湖", "踢鹕", "踢虎", "鹈虎", "鹈湖",
    "鹈壶", "鹈呼", "啼鹕", "啼虎", "梯鹕", "题虎", "媂鹕",
    # 2026-11-14 审计里实际跑出来的新错法（题弧/提弧/皮虎/瓶壶/啼壶/题壶）
    "题弧", "提弧", "啼弧", "皮虎", "皮湖", "瓶壶", "题壶",
)

# SenseVoice 的富标记：<|zh|><|HB|><|Human|>… 一律吃掉（sherpa 有时仍会漏出来）
TAG_RE = re.compile(r"<\|[^<>]{0,24}\|>")
BRACKET_RE = re.compile(r"[【\[][^】\]]{0,20}[】\]]")


def _normalized_for_filter(text: str) -> str:
    return re.sub(r"[\s\u3000\W_]+", "", text or "").lower()


def is_hallucination(text: str) -> bool:
    normalized = _normalized_for_filter(text)
    if not normalized:
        return True
    if normalized in HALLUCINATION_EXACT:
        return True
    return any(pattern.fullmatch(normalized) for pattern in HALLUCINATION_PATTERNS)


def fix_wake_word(text: str) -> str:
    if not text:
        return text
    for word in WAKE_HOMOPHONES:
        if word in text:
            text = text.replace(word, "鹈鹕")
    return text


def strip_markup(text: str) -> str:
    text = TAG_RE.sub("", text or "")
    text = BRACKET_RE.sub("", text)
    text = text.replace("<|", " ").replace("|>", " ")
    return text


def postprocess(text: str) -> str:
    """去标记 -> 繁转简 -> 收空白 -> 过滤整段幻觉（标点留给 relay/lane 那套规则补）。"""
    text = strip_markup(text)
    if _T2S is not None:
        try:
            text = _T2S.convert(text)
        except Exception:
            pass
    text = re.sub(r"\s+", " ", text.replace("\u3000", " ")).strip()
    text = text.strip(" ,，。")
    text = fix_wake_word(text)
    if text and is_hallucination(text):
        log(f"过滤幻觉输出：{text[:60]}")
        return ""
    return text


# ── WAV 解析（与 asr_server.py 同一份实现）──────────────────────────────────

class WavInfo:
    __slots__ = ("sample_rate", "channels", "bits", "duration_ms", "rms", "peak", "pcm")

    def __init__(self, sample_rate, channels, bits, duration_ms, rms, peak, pcm):
        self.sample_rate = sample_rate
        self.channels = channels
        self.bits = bits
        self.duration_ms = duration_ms
        self.rms = rms
        self.peak = peak
        self.pcm = pcm


def parse_wav(data: bytes) -> WavInfo:
    if len(data) < 44:
        raise ValueError(f"太短（{len(data)}B），不是 WAV")
    if data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("缺 RIFF/WAVE 头")
    pos = 12
    fmt = None
    pcm = b""
    while pos + 8 <= len(data):
        chunk_id = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body_start = pos + 8
        if chunk_id == b"fmt ":
            if size >= 16 and body_start + 16 <= len(data):
                tag, channels, rate, _br, _bc, bits = struct.unpack("<HHIIHH", data[body_start:body_start + 16])
                if tag == 0xFFFE and size >= 40:
                    tag = struct.unpack("<H", data[body_start + 24:body_start + 26])[0]
                fmt = (tag, channels, rate, bits)
        elif chunk_id == b"data":
            end = body_start + size if size not in (0, 0xFFFFFFFF) else len(data)
            pcm = data[body_start:min(end, len(data))]
            break
        pos = body_start + size + (size & 1)
    if fmt is None:
        raise ValueError("没有 fmt 块")
    tag, channels, rate, bits = fmt
    if tag != 1:
        raise ValueError(f"不是 PCM（fmt tag={tag}）")
    if channels <= 0 or rate <= 0 or bits not in (8, 16, 24, 32):
        raise ValueError(f"格式异常：{rate}Hz {channels}ch {bits}bit")
    frames = len(pcm) // (channels * (bits // 8))
    duration_ms = int(round(frames * 1000 / rate)) if rate else 0
    rms, peak = 0.0, 0
    if bits == 16 and len(pcm) >= 2:
        values = np.frombuffer(pcm[: frames * channels * 2], dtype=np.int16)
        rms = float(np.sqrt(float(np.mean(np.square(values, dtype=np.float64)))))
        peak = int(np.max(np.abs(values))) if values.size else 0
    return WavInfo(rate, channels, bits, duration_ms, round(rms, 1), peak, pcm)


def media_type_of(content_type: str) -> str:
    return (content_type or "").split(";")[0].strip().lower()


def extract_multipart(body: bytes, content_type: str) -> bytes:
    match = re.search(r'boundary="?([^";]+)"?', content_type or "", re.I)
    if not match:
        raise ValueError("multipart 缺 boundary")
    boundary = ("--" + match.group(1)).encode("latin-1")
    fallback = b""
    for chunk in body.split(boundary):
        chunk = chunk.strip(b"\r\n")
        if not chunk or chunk == b"--":
            continue
        if chunk.endswith(b"--"):
            chunk = chunk[:-2].rstrip(b"\r\n")
        head, sep, payload = chunk.partition(b"\r\n\r\n")
        if not sep:
            continue
        headers = head.decode("latin-1", "replace").lower()
        if "filename=" in headers or re.search(r'\bname="(file|audio|wav|data|upload)"', headers):
            return payload.rstrip(b"\r\n")
        if not fallback:
            fallback = payload
    if fallback:
        return fallback.rstrip(b"\r\n")
    raise ValueError("multipart 里没有音频字段")


def decode_body(raw: bytes) -> bytes:
    """裸 WAV 直接返回；也兼容 data-uri / 纯 base64（lane 的 audio.frame 口径）。"""
    import base64
    stripped = raw.lstrip()
    if stripped.startswith(b"data:") and b";base64," in stripped[:200]:
        return base64.b64decode(stripped.split(b";base64,", 1)[1])
    if stripped[:4] == b"RIFF":
        return raw
    if re.fullmatch(rb"[A-Za-z0-9+/=\s]{8,}", stripped[:400]):
        try:
            decoded = base64.b64decode(stripped, validate=False)
            if decoded[:4] == b"RIFF":
                return decoded
        except Exception:
            pass
    return raw


def to_16k_mono(data: bytes, info: WavInfo) -> tuple[np.ndarray, bool]:
    """返回 float32 单声道 16k 样本（SenseVoice 要的就是这个）。不合法就抛。"""
    if info.sample_rate == 16000 and info.channels == 1 and info.bits == 16:
        return np.frombuffer(info.pcm, dtype=np.int16).astype(np.float32) / 32768.0, False
    ffmpeg = str(CFG.get("ffmpeg") or "").strip()
    if not ffmpeg or not Path(ffmpeg).is_file():
        raise ValueError(f"音频是 {info.sample_rate}Hz/{info.channels}ch/{info.bits}bit，本机没有 ffmpeg 可转码")
    tmp_dir = ROOT / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    stamp = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    src = tmp_dir / f"in-{stamp}.wav"
    dst = tmp_dir / f"in-{stamp}-16k.wav"
    src.write_bytes(data)
    try:
        proc = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                               "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(dst)],
                              capture_output=True, timeout=30)
        if proc.returncode != 0 or not dst.is_file():
            raise ValueError(f"ffmpeg 转码失败：{(proc.stderr or b'').decode('utf-8','replace')[:200]}")
        out = parse_wav(dst.read_bytes())
        return np.frombuffer(out.pcm, dtype=np.int16).astype(np.float32) / 32768.0, True
    finally:
        for path in (src, dst):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


# ── 切段：Silero VAD + 30 秒硬上限（SenseVoice 窗口只有 30 秒）───────────────
# 2026-11-14 修头版（备份 sensevoice_server.py.bak-20261114-202044）：
#   旧版只有 VAD 判定为语音的那一帧才开始记账，说话前面 0.4–0.6 秒的真实语音直接不进段，
#   于是「任务/你好/陈立维」这种句头被吃掉（审计：首字起点实测偏晚 0.38–0.64 秒）。
#   新版改成起止位置记账（段内保留中间静音）+ 起始点往回保留 vadStartPadMs 毫秒
#   + 间隔不超过 vadMergeGapSeconds 的两段并段（跨段上下文不丢）+ 满 30 秒切片后续着切、不丢尾巴。
#   段上限 segmentSeconds=30 与 VAD 的 max_speech_duration 都不动（改小会把句子劈碎，已实测）。

def split_segments(samples: np.ndarray, seg_mode: str = "") -> list[np.ndarray]:
    rate = 16000
    max_seg = int(CFG["segmentSeconds"]) * rate
    if seg_mode == "whole" or VAD is None or samples.size == 0:
        # 跳过 VAD：只按 30 秒硬切（relay 的 SenseVoice 自重试腿走这条）
        return [samples[i:i + max_seg] for i in range(0, samples.size, max_seg)] or [samples]
    window = int(VAD.window_size())
    min_silence = int(VAD.min_silence_duration_samples())
    min_speech = int(VAD.min_speech_duration_samples())
    pad = max(0, int(round(float(CFG.get("vadStartPadMs", 500)) * rate / 1000.0)))
    merge_gap = int(round(float(CFG.get("vadMergeGapSeconds", 0.8)) * rate))
    marks: list[list[int]] = []
    started = False
    seg_start = 0
    seg_end = 0
    silence_run = 0
    pos = 0
    VAD.reset()
    while pos < samples.size:
        chunk = samples[pos:pos + window]
        pos += window
        if chunk.size < window:
            chunk = np.pad(chunk, (0, window - chunk.size))
        # 这一版 pybind 只接 Sequence[float]，且不接收 sample_rate 参数
        if bool(VAD.is_speech(chunk.tolist())):
            if not started:
                started = True
                seg_start = max(0, (pos - window) - pad)  # 前导缓冲：起点往回吃 pad
            seg_end = pos
            silence_run = 0
        elif started:
            silence_run += chunk.size
            if silence_run >= min_silence:
                marks.append([seg_start, seg_end])
                started = False
                silence_run = 0
        if started and seg_end - seg_start >= max_seg:
            marks.append([seg_start, seg_start + max_seg])
            seg_start = seg_end  # 满 30 秒就切，切完从切点续着说，不再丢尾巴
            silence_run = 0
    if started:
        marks.append([seg_start, seg_end])
    merged: list[list[int]] = []
    for mark in marks:
        if mark[1] - mark[0] < min_speech:
            continue
        if merged and mark[0] - merged[-1][1] <= merge_gap:
            merged[-1][1] = max(merged[-1][1], mark[1])  # 间隔短的相邻段并成一段
        else:
            merged.append(list(mark))
    segments: list[np.ndarray] = []
    for start, end in merged:
        start = max(0, min(start, samples.size))
        end = max(start, min(end, samples.size))
        block = samples[start:end]
        for k in range(0, block.size, max_seg):
            segments.append(block[k:k + max_seg])
    return segments or [samples]


def recognize(samples: np.ndarray, seg_mode: str = "") -> tuple[str, int]:
    """单条串行 worker：一段一段喂，返回拼起来的文本与推理毫秒。"""
    started = time.time()
    parts: list[str] = []
    for segment in split_segments(samples, seg_mode):
        if segment.size == 0:
            continue
        stream = RECOGNIZER.create_stream()
        stream.accept_waveform(16000, segment)
        RECOGNIZER.decode_stream(stream)
        text = str(getattr(stream.result, "text", "") or "").strip()
        if text:
            parts.append(text)
    return " ".join(parts), int((time.time() - started) * 1000)


# ── 对外：转写一段音频字节 ──────────────────────────────────────────────────

def transcribe_bytes(raw: bytes, content_type: str, model_key: str = "", seg_mode: str = "") -> dict:
    started = time.time()
    base = {"lang": CFG.get("language") or "zh", "engine": "sensevoice",
            "model": (MODEL_PATH.name if MODEL_PATH else ""),
            "modelKey": (model_key_of(MODEL_PATH) if MODEL_PATH else ""),
            "threads": int(CFG["threads"]), "precision": CFG.get("precision") or "fp32"}
    if RECOGNIZER is None:
        return dict(base, text="", ms=0, reason="SenseVoice 服务未就绪")
    if not raw:
        return dict(base, text="", ms=0, reason="空请求体")
    body = decode_body(raw)
    if media_type_of(content_type) == "multipart/form-data":
        body = extract_multipart(body, content_type)
    if not body:
        return dict(base, text="", ms=int((time.time() - started) * 1000), reason="空音频")
    try:
        info = parse_wav(body)
    except ValueError as error:
        log(f"音频无效，按空结果返回：{len(body)}B {error}")
        return dict(base, text="", ms=int((time.time() - started) * 1000), reason=f"音频无效：{error}")
    if info.duration_ms < CFG["minDurationMs"]:
        return dict(base, text="", ms=int((time.time() - started) * 1000),
                    audioMs=info.duration_ms, rms=info.rms, reason=f"太短（{info.duration_ms}ms）")
    if info.bits == 16 and info.rms < CFG["silenceRms"]:
        log(f"静音跳过：{info.duration_ms}ms rms={info.rms} peak={info.peak}")
        return dict(base, text="", ms=int((time.time() - started) * 1000),
                    audioMs=info.duration_ms, rms=info.rms, reason="silence")
    samples, converted = to_16k_mono(body, info)
    with _ASR_LOCK:
        raw_text, inference_ms = recognize(samples, seg_mode)
    text = postprocess(raw_text)
    elapsed = int((time.time() - started) * 1000)
    STATS["lastMs"] = elapsed
    STATS["lastText"] = text[:80]
    segments = 1 if text else 0
    log(f"transcribe ok：{info.duration_ms}ms 音频 -> {elapsed}ms（推理 {inference_ms}ms）"
        f" 字数={len(text)} model={base['modelKey']} 「{text[:60]}」")
    return dict(base, text=text, ms=elapsed, inferenceMs=inference_ms, audioMs=info.duration_ms,
                rms=info.rms, segments=segments, converted=converted)


class Handler(BaseHTTPRequestHandler):
    server_version = "TihuSenseVoice/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 覆盖默认 stderr 访问日志
        return

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/stats"):
            self._send(200, {
                "ok": RECOGNIZER is not None,
                "engine": "sensevoice",
                "resident": bool(CFG.get("resident", True)),
                "model": MODEL_PATH.name if MODEL_PATH else "",
                "modelPath": str(MODEL_PATH or ""),
                "precision": CFG.get("precision"),
                "threads": CFG["threads"],
                "language": CFG.get("language"),
                "useItn": CFG.get("useItn"),
                "vad": "silero" if VAD is not None else "none",
                "vadThreshold": CFG["vadThreshold"],
                "minSpeechSeconds": CFG["minSpeechSeconds"],
                "minSilenceSeconds": CFG["minSilenceSeconds"],
                "segmentSeconds": CFG["segmentSeconds"],
                "vadStartPadMs": CFG.get("vadStartPadMs"),
                "vadMergeGapSeconds": CFG.get("vadMergeGapSeconds"),
                "idleTimeoutMs": CFG["idleTimeoutMs"],
                "modelLoadMs": STATS["modelLoadMs"],
                "vadLoadMs": STATS["vadMs"],
                "uptimeSec": int(time.time() - STATS["startedAt"]),
                "requests": STATS["requests"],
                "failures": STATS["failures"],
                "lastMs": STATS["lastMs"],
                "lastText": STATS["lastText"],
                "pid": os.getpid(),
            })
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/transcribe":
            self._send(404, {"ok": False, "error": "not found"})
            return
        requested = (parse_qs(parsed.query).get("model") or [""])[0].strip().lower()
        # ?seg=whole：跳过 VAD 切段，只按 30 秒硬切。relay 的 SenseVoice 自重试腿用这条
        # （首段被 VAD 起始门吃掉的录音，重试一次整段喂就能把句子读全）。
        seg_mode = "whole" if (parse_qs(parsed.query).get("seg") or [""])[0].strip().lower() == "whole" else ""
        # 本服务常驻一个模型（fp32 或 int8），`?model=` 只当声明用：
        # 要换量化档位就改 sensevoice.config.json 的 "model" 再重启，别在请求里挑（会白跑）。
        model_note = ""
        if requested in ("fp32", "int8") and MODEL_PATH and model_key_of(MODEL_PATH) != requested:
            model_note = f"忽略 model={requested}，本服务常驻 {model_key_of(MODEL_PATH)}"
        started = time.time()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > CFG["maxBytes"]:
                self._send(413, {"ok": False, "error": "音频太大"})
                return
            raw = self.rfile.read(length) if length > 0 else b""
            STATS["requests"] += 1
            result = transcribe_bytes(raw, self.headers.get("Content-Type") or "", "", seg_mode)
            if model_note:
                result["modelNote"] = model_note
                log(model_note)
            self._send(200, result)
        except Exception as error:
            STATS["failures"] += 1
            log("transcribe 失败：" + "".join(traceback.format_exception_only(type(error), error)).strip())
            self._send(500, {"ok": False, "error": str(error)[:300],
                             "engine": "sensevoice", "ms": int((time.time() - started) * 1000)})


def warmup() -> None:
    """把 onnxruntime 的计算图热一遍，别让第一句人话付编译成本。"""
    try:
        tone = np.zeros(16000, dtype=np.float32)
        tone[:] = 0.01
        with _ASR_LOCK:
            started = time.time()
            stream = RECOGNIZER.create_stream()
            stream.accept_waveform(16000, tone)
            RECOGNIZER.decode_stream(stream)
        log(f"warmup ok：{int((time.time() - started) * 1000)}ms")
    except Exception as error:
        log(f"warmup 失败（不影响对外服务，第一次真请求会慢）：{error}")


def selftest(path: str) -> int:
    started = time.time()
    init_backends()
    data = Path(path).read_bytes()
    info = parse_wav(data)
    samples, _ = to_16k_mono(data, info)
    t0 = time.time()
    with _ASR_LOCK:
        raw_text, inference_ms = recognize(samples)
    text = postprocess(raw_text)
    total = int((time.time() - t0) * 1000)
    print(json.dumps({
        "file": str(path), "audioMs": info.duration_ms, "rms": info.rms,
        "loadMs": int((time.time() - started) * 1000), "modelLoadMs": STATS["modelLoadMs"],
        "inferenceMs": inference_ms, "totalMs": total, "segments": len(split_segments(samples)),
        "text": text,
    }, ensure_ascii=False, indent=1))
    return 0 if text else 2


def main() -> None:
    ap = argparse.ArgumentParser(description="鹈鹕 SenseVoice 常驻转写服务")
    ap.add_argument("--selftest", metavar="WAV", help="加载模型→转写这一个 WAV→打印耗时→退出")
    args = ap.parse_args()
    if args.selftest:
        sys.exit(selftest(args.selftest))
    server = ThreadingHTTPServer((CFG["host"], CFG["port"]), Handler)
    server.daemon_threads = True
    init_backends()
    log(f"listening http://{CFG['host']}:{CFG['port']} model={MODEL_PATH.name} "
        f"threads={CFG['threads']} precision={CFG['precision']} lang={CFG['language']} "
        f"vad={'silero' if VAD else 'none'} resident={bool(CFG.get('resident', True))} pid={os.getpid()}")
    threading.Thread(target=warmup, name="warmup", daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log("stopped")


if __name__ == "__main__":
    sys.exit(main())
