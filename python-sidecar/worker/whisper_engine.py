"""Faster-Whisper engine wrapper.

Lazy-loads ``large-v3`` from a directory the parent process picks (so the
sidecar can be reused across model installs without restart). Auto-selects a
sensible compute backend per platform — CTranslate2 currently has no Python
binding for Metal, so on macOS we run on CPU with int8 quantisation (still
fast on M-series; uses every CPU thread by default).

The transcribe call is exposed as a *generator* yielding individual segments
so the FastAPI layer can stream progress and cancel mid-flight.
"""

from __future__ import annotations

import logging
import os
import platform
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path

from faster_whisper import WhisperModel

from .srt import Word

log = logging.getLogger(__name__)


class CancelledError(Exception):
    """Raised when transcription was cancelled by the caller."""


def _performance_core_count() -> int:
    """Best-effort count of *performance* cores on Apple Silicon.

    On M-series CPUs, mixing P- and E-cores in a CTranslate2 worker pool
    typically *slows things down* — the OS rebalances threads between core
    classes mid-decode and cache locality is lost. We pin to P-cores only.

    Falls back to ``os.cpu_count()`` if the sysctl probe fails or we're
    not on macOS.
    """
    if platform.system() == "Darwin":
        try:
            out = subprocess.check_output(
                ["sysctl", "-n", "hw.perflevel0.physicalcpu"],
                stderr=subprocess.DEVNULL,
                timeout=1.0,
            )
            n = int(out.strip())
            if n > 0:
                return n
        except Exception:
            pass
    return max(1, os.cpu_count() or 4)


class TranscriptionEngine:
    def __init__(self, model_dir: Path):
        self.model_dir = Path(model_dir)
        self._model: WhisperModel | None = None
        self._device, self._compute_type = self._auto_device()
        self._cpu_threads = _performance_core_count()

    @staticmethod
    def _auto_device() -> tuple[str, str]:
        if os.environ.get("CT2_USE_CUDA") or platform.system() == "Linux":
            return ("cuda", "float16")
        # int8_float32 dequantises matmul accumulators in fp32 — on Apple
        # Silicon this is slightly faster than pure int8 with the same
        # accuracy because the AMX path likes fp32 better.
        return ("cpu", "int8_float32")

    @property
    def model(self) -> WhisperModel:
        if self._model is None:
            log.info(
                "loading Whisper model from %s on %s/%s (cpu_threads=%d)",
                self.model_dir,
                self._device,
                self._compute_type,
                self._cpu_threads,
            )
            self._model = WhisperModel(
                str(self.model_dir),
                device=self._device,
                compute_type=self._compute_type,
                cpu_threads=self._cpu_threads,
                num_workers=1,
            )
        return self._model

    def stream_transcription(
        self,
        audio_path: Path | str,
        cancel: threading.Event,
        *,
        language: str | None = None,
        translate: bool = False,
        vad: bool = True,
        beam_size: int = 1,
    ) -> Iterator[tuple[str, dict]]:
        """Yield (event_type, payload) tuples.

        Event types:
        - ``meta`` once at start with detected language and total duration
        - ``segment`` for every decoded segment, with end-position and words
        - (raises CancelledError if the cancel flag is set between segments)
        """
        segments, info = self.model.transcribe(
            str(audio_path),
            language=language,
            task="translate" if translate else "transcribe",
            vad_filter=vad,
            word_timestamps=True,
            beam_size=beam_size,
            condition_on_previous_text=False,
        )
        yield (
            "meta",
            {
                "language": info.language,
                "language_probability": float(info.language_probability),
                "duration": float(info.duration),
            },
        )

        for seg in segments:
            if cancel.is_set():
                raise CancelledError()
            words: list[Word] = []
            if seg.words:
                for w in seg.words:
                    words.append(Word(start=w.start, end=w.end, text=w.word))
            else:
                words.append(Word(start=seg.start, end=seg.end, text=seg.text))
            yield (
                "segment",
                {
                    "end": float(seg.end),
                    "text": seg.text,
                    "words": words,
                },
            )
