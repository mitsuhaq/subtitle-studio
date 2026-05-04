"""Render Whisper cues to an ASS file consumable by FFmpeg `subtitles=` filter.

Only the parts we actually need on stage 4: a single "Default" style derived
from the user's SubtitleStyle, and one Dialogue line per cue. Stage 5 will
extend this with per-word colouring, per-cue overrides, etc.
"""

from __future__ import annotations

import dataclasses

from .srt import Cue


@dataclasses.dataclass
class AssStyle:
    font_family: str = "Inter"
    font_size: int = 38
    primary_color: str = "#FFFFFF"
    outline_color: str = "#000000"
    back_color: str = "#000000"
    back_alpha: int = 70  # percent (0=transparent overlay, 100=opaque)
    bold: bool = True
    italic: bool = False
    outline_width: float = 2.5
    shadow_offset: float = 1.0
    border_style: int = 1  # 1=outline+shadow, 3=opaque box
    alignment: int = 2  # ASS keypad: 1-9 (2=bottom centre)
    margin_v: int = 50
    margin_l: int = 60
    margin_r: int = 60
    bg_padding: float = 8.0  # used as `Outline` thickness when border_style==3


def _hex_to_ass_color(hex_color: str, alpha_pct: int = 0) -> str:
    """Convert ``#RRGGBB`` → ASS ``&HAABBGGRR``.

    ASS colours are AA-BB-GG-RR (alpha first, then BGR). ASS alpha is
    inverted: ``00`` = fully opaque, ``FF`` = fully transparent. ``alpha_pct``
    here is "fill percent" (100=opaque, 0=transparent), the convention used
    in the rest of the app.
    """
    h = (hex_color or "#FFFFFF").lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    alpha_pct = max(0, min(100, alpha_pct))
    a = int(round((100 - alpha_pct) * 2.55))
    return f"&H{a:02X}{b:02X}{g:02X}{r:02X}"


def _format_time(t: float) -> str:
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t - h * 3600 - m * 60
    return f"{h}:{m:02d}:{s:05.2f}"


def write_ass(
    cues: list[Cue],
    style: AssStyle,
    path: str,
    play_w: int = 1920,
    play_h: int = 1080,
) -> None:
    primary = _hex_to_ass_color(style.primary_color, alpha_pct=100)
    bold = -1 if style.bold else 0
    italic = -1 if style.italic else 0

    # In opaque-box mode the `Outline` field stops being a stroke and starts
    # acting as the box's padding. Swap in `bg_padding` so the user has a
    # dedicated control for that case.
    border_outline = (
        style.bg_padding if style.border_style == 3 else style.outline_width
    )

    # For horizontally-centered alignments (2, 5, 8) we force MarginL = MarginR = 0
    # in the style. libass otherwise sometimes off-centers when the values
    # are equal — most commonly when the chosen font has a fallback that
    # widens the rendered text past the available area. Centered alignments
    # don't actually need horizontal margins (the text is centered in the
    # full screen anyway), so we drop them.
    is_h_center = style.alignment in (2, 5, 8)
    eff_ml = 0 if is_h_center else style.margin_l
    eff_mr = 0 if is_h_center else style.margin_r

    # libass opaque-box (BorderStyle=3) renders the background using
    # OutlineColour. Alpha on the box is unreliable across libass builds —
    # the box is always 100% opaque in this mode.
    if style.border_style == 3:
        outline = _hex_to_ass_color(style.back_color, alpha_pct=100)
        back = _hex_to_ass_color(style.back_color, alpha_pct=100)
    else:
        outline = _hex_to_ass_color(style.outline_color, alpha_pct=100)
        back = _hex_to_ass_color(style.back_color, alpha_pct=style.back_alpha)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {play_w}\n"
        f"PlayResY: {play_h}\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n"
        "YCbCr Matrix: TV.709\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{style.font_family},{style.font_size},{primary},"
        f"&H00000000,{outline},{back},{bold},{italic},0,0,100,100,0,0,"
        f"{style.border_style},{border_outline},{style.shadow_offset},"
        f"{style.alignment},{eff_ml},{eff_mr},"
        f"{style.margin_v},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
    )

    lines = [header]
    for c in cues:
        # Only sanitisation we need: collapse newlines and escape ASS braces
        # (which would otherwise be parsed as tag overrides).
        text = c.text.replace("\n", " ").replace("{", "(").replace("}", ")")
        # Belt-and-braces alignment override — keeps libass strictly on the
        # numpad-position we asked for even if the style line gets parsed
        # weirdly by some build.
        prefix = "{\\an" + str(int(style.alignment)) + "}"
        lines.append(
            f"Dialogue: 0,{_format_time(c.start)},{_format_time(c.end)},"
            f"Default,,0,0,0,,{prefix}{text}\n"
        )

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
