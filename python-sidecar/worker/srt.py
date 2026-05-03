"""SRT writer with one-line cues.

Word-level timestamps from Whisper are folded into single-line subtitle cues
honouring four constraints from the spec:

* a strict character-per-line budget (whole-word — never split a word),
* a configurable minimum cue duration (no flicker),
* a configurable maximum cue duration (long sentences are broken),
* a "pause" split when the silence between two consecutive words exceeds a
  threshold (this stops one cue from spanning a long gap).

Reading speed (CPS) is not enforced as a hard cap — the spec asks for
"comfortable reading"; we use it only to extend cues that finish too quickly
relative to their length, but never beyond ``max_duration``.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterable


@dataclasses.dataclass
class Word:
    start: float  # seconds
    end: float
    text: str


@dataclasses.dataclass
class Cue:
    start: float
    end: float
    text: str


@dataclasses.dataclass
class SrtConfig:
    max_chars: int = 42
    min_duration: float = 0.6
    max_duration: float = 6.0
    target_cps: float = 17.0
    word_pause_split_sec: float = 0.7


def words_to_cues(words: Iterable[Word], cfg: SrtConfig) -> list[Cue]:
    cues: list[Cue] = []
    cur: list[Word] = []
    cur_chars = 0

    def flush() -> None:
        nonlocal cur, cur_chars
        if not cur:
            return
        text = " ".join(w.text.strip() for w in cur).strip()
        if not text:
            cur = []
            cur_chars = 0
            return
        start = cur[0].start
        end = cur[-1].end
        # Stretch to min_duration; never beyond max_duration.
        if end - start < cfg.min_duration:
            end = start + cfg.min_duration
        # If too short for the text length given the target CPS, extend.
        needed = len(text) / max(1.0, cfg.target_cps)
        if end - start < needed:
            end = start + needed
        if end - start > cfg.max_duration:
            end = start + cfg.max_duration
        cues.append(Cue(start, end, text))
        cur = []
        cur_chars = 0

    for w in words:
        wtxt = w.text.strip()
        if not wtxt:
            continue
        added = len(wtxt) + (1 if cur else 0)
        too_long = (cur_chars + added) > cfg.max_chars
        too_far = bool(cur) and (w.start - cur[-1].end) > cfg.word_pause_split_sec
        too_durational = bool(cur) and (w.end - cur[0].start) > cfg.max_duration
        if cur and (too_long or too_far or too_durational):
            flush()
        cur.append(w)
        cur_chars += added
    flush()

    # Avoid overlaps: if cue N+1 starts before cue N ends, push cue N to end
    # at the next cue's start (the next word actually started speaking, so the
    # current cue must end then).
    for i in range(len(cues) - 1):
        if cues[i].end > cues[i + 1].start:
            cues[i].end = max(cues[i].start + cfg.min_duration, cues[i + 1].start)
    return cues


def srt_timestamp(t: float) -> str:
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms == 1000:
        s += 1
        ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(cues: list[Cue], path: str) -> None:
    parts: list[str] = []
    for i, c in enumerate(cues, 1):
        parts.append(str(i))
        parts.append(f"{srt_timestamp(c.start)} --> {srt_timestamp(c.end)}")
        parts.append(c.text)
        parts.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
