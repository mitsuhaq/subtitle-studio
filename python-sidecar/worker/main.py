"""Subtitle Studio worker entry point.

Spawned by the Tauri app. Exposes a tiny FastAPI surface on 127.0.0.1; the
chosen port is printed once on stdout as ``WORKER_READY <port>`` so the
parent process can discover it.

Transcription is exposed as a Server-Sent Events stream on POST /transcribe.
The parent process reads progress events as they arrive and re-emits them
into the Tauri webview. POST /cancel sets a cancellation flag that is
checked between segments.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .ass_writer import AssStyle, write_ass
from .srt import SrtConfig, words_to_cues, write_srt
from .whisper_engine import CancelledError, TranscriptionEngine

log = logging.getLogger("subtitle_worker")

app = FastAPI(title="Subtitle Studio worker", version="0.2.0")


class _State:
    engine: TranscriptionEngine | None = None
    engine_dir: str | None = None
    engine_lock = threading.Lock()
    cancel_event: threading.Event = threading.Event()


state = _State()


class Health(BaseModel):
    status: str
    version: str
    model_loaded: bool
    model_dir: str | None


class StyleModel(BaseModel):
    font_family: str = "Inter"
    font_size: int = 38
    primary_color: str = "#FFFFFF"
    outline_color: str = "#000000"
    back_color: str = "#000000"
    back_alpha: int = 70
    bold: bool = True
    italic: bool = False
    outline_width: float = 2.5
    shadow_offset: float = 1.0
    border_style: int = 1
    alignment: int = 2
    margin_v: int = 50
    margin_l: int = 60
    margin_r: int = 60
    bg_padding: float = 8.0


class TranscribeRequest(BaseModel):
    audio_path: str
    output_srt: str
    model_dir: str
    output_ass: str | None = None
    style: StyleModel | None = None
    language: str | None = None
    translate: bool = False
    vad: bool = True
    beam_size: int = Field(default=1, ge=1, le=10)
    max_chars: int = Field(default=42, ge=10, le=120)
    min_duration: float = Field(default=0.6, ge=0.1, le=10.0)
    max_duration: float = Field(default=6.0, ge=1.0, le=20.0)
    target_cps: float = Field(default=17.0, ge=4.0, le=40.0)


@app.get("/health", response_model=Health)
def health() -> Health:
    return Health(
        status="ok",
        version=app.version,
        model_loaded=state.engine is not None and state.engine._model is not None,
        model_dir=state.engine_dir,
    )


@app.post("/cancel")
def cancel() -> dict:
    state.cancel_event.set()
    return {"ok": True}


def _get_or_load_engine(model_dir: str) -> TranscriptionEngine:
    with state.engine_lock:
        if state.engine is None or state.engine_dir != model_dir:
            log.info("loading engine for %s", model_dir)
            state.engine = TranscriptionEngine(Path(model_dir))
            state.engine_dir = model_dir
        return state.engine


def _sse(event_type: str, payload: dict[str, Any]) -> bytes:
    body = json.dumps({"type": event_type, **payload}, ensure_ascii=False)
    return f"data: {body}\n\n".encode("utf-8")


@app.post("/transcribe")
async def transcribe(req: TranscribeRequest) -> StreamingResponse:
    if not Path(req.model_dir).exists():
        raise HTTPException(400, f"Whisper модель не найдена: {req.model_dir}")
    if not Path(req.audio_path).exists():
        raise HTTPException(400, f"Аудио не найдено: {req.audio_path}")

    state.cancel_event.clear()

    engine = _get_or_load_engine(req.model_dir)

    cfg = SrtConfig(
        max_chars=req.max_chars,
        min_duration=req.min_duration,
        max_duration=req.max_duration,
        target_cps=req.target_cps,
    )

    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def producer() -> None:
        all_words = []
        meta: dict | None = None
        try:
            for event_type, payload in engine.stream_transcription(
                req.audio_path,
                cancel=state.cancel_event,
                language=req.language,
                translate=req.translate,
                vad=req.vad,
                beam_size=req.beam_size,
            ):
                if event_type == "meta":
                    meta = payload
                    loop.call_soon_threadsafe(
                        queue.put_nowait,
                        _sse(
                            "meta",
                            {
                                "language": payload["language"],
                                "language_probability": payload["language_probability"],
                                "duration": payload["duration"],
                            },
                        ),
                    )
                elif event_type == "segment":
                    all_words.extend(payload["words"])
                    pos = payload["end"]
                    total = meta["duration"] if meta else 0.0
                    loop.call_soon_threadsafe(
                        queue.put_nowait,
                        _sse(
                            "progress",
                            {
                                "pos": pos,
                                "total": total,
                                "text": payload["text"],
                            },
                        ),
                    )

            cues = words_to_cues(all_words, cfg)
            write_srt(cues, req.output_srt)
            ass_path: str | None = None
            if req.output_ass:
                style_dict = (req.style or StyleModel()).model_dump()
                write_ass(cues, AssStyle(**style_dict), req.output_ass)
                ass_path = req.output_ass
            done = {
                "cues_count": len(cues),
                "duration": meta["duration"] if meta else 0.0,
                "detected_language": meta["language"] if meta else None,
                "language_probability": meta["language_probability"] if meta else None,
                "output_srt": req.output_srt,
                "output_ass": ass_path,
            }
            loop.call_soon_threadsafe(queue.put_nowait, _sse("done", done))
        except CancelledError:
            log.info("transcription cancelled by client")
            loop.call_soon_threadsafe(
                queue.put_nowait, _sse("cancelled", {})
            )
        except Exception as exc:  # noqa: BLE001
            log.error("transcribe failed: %s\n%s", exc, traceback.format_exc())
            loop.call_soon_threadsafe(
                queue.put_nowait, _sse("error", {"message": str(exc)})
            )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=producer, daemon=True).start()

    async def stream():
        while True:
            chunk = await queue.get()
            if chunk is None:
                break
            yield chunk

    return StreamingResponse(stream(), media_type="text/event-stream")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _watch_parent_and_die() -> None:
    """Self-destruct if the launching Tauri process dies.

    Tokio's ``kill_on_drop`` only fires on a graceful Drop — if the parent
    crashes or is force-killed, the worker survives as an orphan adopted
    by init (ppid=1) and keeps eating CPU forever. Two orthogonal guards:

    1. stdin EOF watcher — Tauri keeps the pipe open; an EOF means the
       parent exited.
    2. ppid poll — backup signal in case stdin behaves weirdly.
    """
    orig_ppid = os.getppid()

    def _exit(reason: str) -> None:
        log.warning("parent gone (%s) — worker self-terminating", reason)
        os._exit(0)

    def _stdin_watcher() -> None:
        try:
            while True:
                chunk = sys.stdin.buffer.read(4096)
                if not chunk:
                    _exit("stdin EOF")
                    return
        except Exception:
            _exit("stdin error")

    def _ppid_watcher() -> None:
        while True:
            time.sleep(2.0)
            try:
                ppid = os.getppid()
            except Exception:
                continue
            if ppid == 1 or (orig_ppid != 1 and ppid != orig_ppid):
                _exit(f"ppid changed {orig_ppid}→{ppid}")
                return

    threading.Thread(target=_stdin_watcher, daemon=True).start()
    threading.Thread(target=_ppid_watcher, daemon=True).start()


def main() -> int:
    # ``force=True`` resets root logger handlers so faster-whisper / uvicorn
    # imports that registered their own handler before us don't double up.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
        force=True,
    )
    _watch_parent_and_die()
    port = _free_port()
    print(f"WORKER_READY {port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
