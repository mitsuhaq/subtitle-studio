"""Generate the Subtitle Studio app icon.

iOS-26-style "Liquid Glass" squircle, dark base with a soft gold radial glow,
a chunky pixel-art "S" rendered crisply, and a top-half glass highlight.

Run:
    uv run --no-project --python 3.12 --with pillow --with numpy \
        python scripts/make_app_icon.py

Outputs:
    icon-source.png — 1024×1024 squircle PNG ready for `npx tauri icon`.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
OUT = Path("icon-source.png")

# Apple-style superellipse (n≈5 reads as the canonical squircle).
SQUIRCLE_N = 5.0
# Margin between squircle edge and image bbox.
MARGIN = 0


def squircle_mask(size: int, n: float = SQUIRCLE_N, margin: int = 0) -> Image.Image:
    """Return a white-on-black L-mode mask in superellipse shape."""
    half = (size - 2 * margin) / 2
    cx = cy = size / 2
    ys, xs = np.mgrid[0:size, 0:size]
    nx = np.abs((xs - cx) / half)
    ny = np.abs((ys - cy) / half)
    inside = (nx ** n + ny ** n) <= 1.0
    arr = np.where(inside, 255, 0).astype(np.uint8)
    return Image.fromarray(arr, mode="L")


def radial_gradient(size: int, cx: float, cy: float, radius: float,
                    inner=(244, 208, 63, 220), outer=(212, 175, 55, 0)) -> Image.Image:
    """Soft radial fade from `inner` colour to `outer`."""
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    t = np.clip(d / radius, 0.0, 1.0)
    # smoothstep-ish curve
    t = t * t * (3 - 2 * t)
    inner_arr = np.array(inner, dtype=np.float32)
    outer_arr = np.array(outer, dtype=np.float32)
    blend = inner_arr * (1 - t)[..., None] + outer_arr * t[..., None]
    return Image.fromarray(blend.astype(np.uint8), mode="RGBA")


def linear_gradient_v(size: int, top=(255, 255, 255, 70), bottom=(255, 255, 255, 0),
                      stop: float = 0.55) -> Image.Image:
    """Vertical linear gradient, opaque at top, fading to transparent by `stop`."""
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    top_arr = np.array(top, dtype=np.float32)
    bot_arr = np.array(bottom, dtype=np.float32)
    for y in range(size):
        t = min(1.0, (y / size) / stop)
        t = t * t  # ease-out
        c = top_arr * (1 - t) + bot_arr * t
        arr[y, :] = c.astype(np.uint8)
    return Image.fromarray(arr, mode="RGBA")


# Pixel "S" grid shared with the in-app Logo component.
S_GRID = [
    "................",
    "................",
    "....########....",
    "...##########...",
    "..####....####..",
    "..####..........",
    "..####..........",
    "...########.....",
    "....########....",
    ".......######...",
    "..........####..",
    ".####.....####..",
    "..####...####...",
    "...##########...",
    "....########....",
    "................",
]


def render_pixel_s(target_px: int) -> Image.Image:
    """Render the pixel-S into a transparent RGBA tile sized `target_px`."""
    grid = 16
    cell = target_px // grid
    img = Image.new("RGBA", (cell * grid, cell * grid), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Per-row gold gradient (top warmer/lighter, bottom deeper).
    for y, row in enumerate(S_GRID):
        t = y / max(1, len(S_GRID) - 1)
        # interpolate between #fdf6dd → #f4d03f → #a98a2b
        if t < 0.5:
            u = t / 0.5
            r = int(253 * (1 - u) + 244 * u)
            g = int(246 * (1 - u) + 208 * u)
            b = int(221 * (1 - u) + 63 * u)
        else:
            u = (t - 0.5) / 0.5
            r = int(244 * (1 - u) + 169 * u)
            g = int(208 * (1 - u) + 138 * u)
            b = int(63 * (1 - u) + 43 * u)
        for x, ch in enumerate(row):
            if ch == "#":
                x0, y0 = x * cell, y * cell
                draw.rectangle((x0, y0, x0 + cell - 1, y0 + cell - 1), fill=(r, g, b, 255))
    return img


def main() -> None:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # 1. Dark squircle base with subtle vertical gradient (lighter top).
    base_arr = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    for y in range(SIZE):
        t = y / SIZE
        # interpolate #1a1a20 (top) → #050507 (bottom)
        r = int(26 * (1 - t) + 5 * t)
        g = int(26 * (1 - t) + 5 * t)
        b = int(32 * (1 - t) + 7 * t)
        base_arr[y, :] = (r, g, b, 255)
    base = Image.fromarray(base_arr, mode="RGBA")

    # 2. Soft gold radial glow from the upper-left quadrant.
    glow = radial_gradient(
        SIZE,
        cx=SIZE * 0.32,
        cy=SIZE * 0.32,
        radius=SIZE * 0.78,
        inner=(244, 208, 63, 200),
        outer=(212, 175, 55, 0),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=24))
    canvas.alpha_composite(base)
    canvas.alpha_composite(glow)

    # 3. Pixel S: 16 cells, target ~640px → cell=40px.
    s_target = 640
    pixel_s = render_pixel_s(s_target)
    # Drop a soft inset shadow under the S so it reads off the base.
    shadow = Image.new("RGBA", pixel_s.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.bitmap((0, 0), pixel_s.split()[3], fill=(0, 0, 0, 180))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=18))
    sx = (SIZE - pixel_s.width) // 2
    sy = (SIZE - pixel_s.height) // 2 + 18
    canvas.alpha_composite(shadow, (sx, sy + 12))
    canvas.alpha_composite(pixel_s, (sx, sy))

    # 4. Top-half glass highlight (Liquid Glass).
    gloss = linear_gradient_v(SIZE, top=(255, 255, 255, 64), bottom=(255, 255, 255, 0), stop=0.55)
    canvas.alpha_composite(gloss)

    # 5. Subtle inner rim (gold) — paint a thin gold stroke and blur.
    rim = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    rim_mask = squircle_mask(SIZE, n=SQUIRCLE_N)
    rim_inner = squircle_mask(SIZE - 6, n=SQUIRCLE_N)
    inner_padded = Image.new("L", (SIZE, SIZE), 0)
    inner_padded.paste(rim_inner, (3, 3))
    rim_only = Image.eval(rim_mask, lambda v: v).copy()
    # rim = mask − inner_mask
    rim_arr = np.maximum(np.array(rim_only, dtype=np.int16) - np.array(inner_padded, dtype=np.int16), 0).astype(np.uint8)
    rim_alpha = Image.fromarray(rim_arr, mode="L")
    rim_color = Image.new("RGBA", (SIZE, SIZE), (244, 208, 63, 180))
    rim_color.putalpha(rim_alpha)
    canvas.alpha_composite(rim_color)

    # 6. Squircle clip.
    mask = squircle_mask(SIZE, n=SQUIRCLE_N, margin=MARGIN)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), mask=mask)

    out.save(OUT, optimize=True)
    print(f"OK → {OUT.resolve()}  ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
