"""Robust Video Matting — runs the RVM ONNX model frame-by-frame to produce
either a transparent (RGBA) video or a composited one (over a colour, image
or another video).

The model is `rvm_mobilenetv3_fp32.onnx` from PeterL1n/RobustVideoMatting.
Inputs:  src (1×3×H×W float32 0..1), r1i..r4i (recurrent state), downsample_ratio
Outputs: fgr (1×3×H×W), pha (1×1×H×W), r1o..r4o

Audio is **not** passed through here — the caller is expected to mux the
original audio back in via FFmpeg after we finish writing the video. That
keeps this module free of audio handling and lets us focus on the matting
loop.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import av
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter


class CancelledError(Exception):
    """Raised when the chroma key job was cancelled by the caller."""


def hex_to_rgb(s: str | None) -> tuple[int, int, int]:
    if not s or len(s) < 7:
        return (0, 177, 64)  # default greenscreen-ish
    h = s.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _load_session(model_path: str) -> ort.InferenceSession:
    # CoreML on Apple Silicon → CUDA on Linux+NVIDIA → CPU fallback. The
    # session creation will silently skip providers that aren't available.
    return ort.InferenceSession(
        model_path,
        providers=[
            "CoreMLExecutionProvider",
            "CUDAExecutionProvider",
            "CPUExecutionProvider",
        ],
    )


def run(
    model_path: str,
    input_video: str,
    output_video: str,
    background_kind: str,
    background_color: str | None = None,
    background_path: str | None = None,
    mode: str = "chroma_key",
    on_progress: Callable[[int, int], None] | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    if not Path(model_path).exists():
        raise FileNotFoundError(f"RVM model not found: {model_path}")
    if not Path(input_video).exists():
        raise FileNotFoundError(f"Input video not found: {input_video}")

    sess = _load_session(model_path)

    # Pre-pass (chroma_key mode only): FFmpeg `chromakey` zaps green pixels
    # to black before RVM sees them, so the matting net only has to find a
    # silhouette against pure black. In rotobrush mode the input has any
    # arbitrary background, so this preprocess would do nothing useful and
    # could actively hurt by punching holes in green clothing.
    ffmpeg = _find_ffmpeg()
    matting_source = input_video
    matting_temp: Path | None = None
    if mode == "chroma_key" and ffmpeg is not None:
        matting_temp = Path(output_video).with_name(
            Path(output_video).stem + ".chromakeyed.mp4"
        )
        try:
            _chromakey_to_black(
                ffmpeg,
                input_video,
                str(matting_temp),
                color="0x00FF00",
                similarity=0.45,
                blend=0.0,
            )
            matting_source = str(matting_temp)
        except Exception as exc:  # noqa: BLE001
            print(f"[chroma_key] preprocess failed, falling back: {exc}")
            matting_temp = None

    matting_container = av.open(matting_source)
    matting_stream = matting_container.streams.video[0]
    in_container = av.open(input_video)
    in_stream = in_container.streams.video[0]
    width = in_stream.width
    height = in_stream.height
    fps = in_stream.average_rate or 30
    total_frames = in_stream.frames or 0

    # Output container/codec depending on whether we need an alpha channel.
    if background_kind == "transparent":
        # ProRes 4444 in MOV — universally supported by NLEs and preserves
        # alpha cleanly. Switch the file extension if the caller forgot.
        if not output_video.lower().endswith(".mov"):
            output_video = str(Path(output_video).with_suffix(".mov"))
        out_container = av.open(output_video, "w", format="mov")
        out_stream = out_container.add_stream("prores_ks", rate=fps)
        out_stream.options = {"profile": "4444"}
        out_pix_fmt = "yuva444p10le"
    else:
        out_container = av.open(output_video, "w", format="mp4")
        out_stream = out_container.add_stream("libx264", rate=fps)
        out_stream.options = {"crf": "18", "preset": "medium"}
        out_pix_fmt = "yuv420p"
    out_stream.width = width
    out_stream.height = height
    out_stream.pix_fmt = out_pix_fmt

    # Static background prepared up front for color/image; loaded per-frame
    # for video. None when transparent.
    bg_img: np.ndarray | None = None
    bg_container: av.container.InputContainer | None = None
    if background_kind == "color":
        rgb = hex_to_rgb(background_color)
        bg_img = np.full((height, width, 3), rgb, dtype=np.uint8)
    elif background_kind == "image":
        if not background_path:
            raise ValueError("background_path required for kind=image")
        img = Image.open(background_path).convert("RGB").resize((width, height))
        bg_img = np.array(img)
    elif background_kind == "video":
        if not background_path:
            raise ValueError("background_path required for kind=video")
        bg_container = av.open(background_path)

    # Recurrent state — RVM expects 4 tensors. Initial = zeros, shape grows
    # automatically on first inference.
    r1 = np.zeros((1, 1, 1, 1), dtype=np.float32)
    r2 = np.zeros((1, 1, 1, 1), dtype=np.float32)
    r3 = np.zeros((1, 1, 1, 1), dtype=np.float32)
    r4 = np.zeros((1, 1, 1, 1), dtype=np.float32)

    # Downsample ratio = how aggressively the matting net downsamples
    # internally. Lower = faster, less detail. We bias toward higher quality
    # (cleaner edges) — RVM upstream recipe used 0.25 at 4K but the seam
    # quality is noticeably better at 0.5+ even when slower.
    if max(width, height) >= 1900:
        downsample = 0.5
    elif max(width, height) >= 1280:
        downsample = 0.5
    else:
        downsample = 0.7
    downsample_arr = np.array([downsample], dtype=np.float32)

    bg_iter = (
        bg_container.decode(video=0) if bg_container is not None else None
    )

    frame_idx = 0
    matting_iter = matting_container.decode(matting_stream)
    for frame in in_container.decode(in_stream):
        if cancel is not None and cancel.is_set():
            raise CancelledError()

        # Original RGB is what we composite; matting RGB is what RVM sees.
        # When pre-process is off they're the same source.
        rgb = frame.to_ndarray(format="rgb24")
        try:
            mat_frame = next(matting_iter)
            mat_rgb = mat_frame.to_ndarray(format="rgb24")
        except StopIteration:
            mat_rgb = rgb
        src = (mat_rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]

        fgr, pha, r1, r2, r3, r4 = sess.run(
            None,
            {
                "src": src,
                "r1i": r1,
                "r2i": r2,
                "r3i": r3,
                "r4i": r4,
                "downsample_ratio": downsample_arr,
            },
        )

        # Use the *original* RGB as the foreground (so colours are real),
        # but RVM's alpha based on the chromakeyed input.
        fgr_hwc = rgb.astype(np.float32) / 255.0
        pha_hw = pha[0, 0]  # H,W float32

        # ---- Spill + mask cleanup ----------------------------------------
        # Despill is chroma_key-only — for rotobrush we keep colours intact
        # (green clothing/foliage on the subject must survive).
        if mode == "chroma_key":
            r = fgr_hwc[..., 0]
            g = fgr_hwc[..., 1]
            b = fgr_hwc[..., 2]
            limit = np.minimum(r, b)
            fgr_hwc = np.stack([r, np.minimum(g, limit), b], axis=-1)

        # Mask cleanup — no hard threshold (it stair-steps the contour and
        # eats hair detail). 1 px erosion removes the spill-tainted soft
        # edge, then a moderate Gaussian rebuilds smooth anti-aliased
        # edges from the now-clean mask.
        pha_u8 = (pha_hw * 255.0).clip(0, 255).astype(np.uint8)
        eroded = Image.fromarray(pha_u8).filter(ImageFilter.MinFilter(3))
        feathered = eroded.filter(ImageFilter.GaussianBlur(radius=1.2))
        pha_hw = np.asarray(feathered).astype(np.float32) / 255.0
        # ------------------------------------------------------------------

        if background_kind == "transparent":
            rgba = np.empty((height, width, 4), dtype=np.uint8)
            rgba[..., :3] = (fgr_hwc * 255.0).clip(0, 255).astype(np.uint8)
            rgba[..., 3] = (pha_hw * 255.0).clip(0, 255).astype(np.uint8)
            out_frame = av.VideoFrame.from_ndarray(rgba, format="rgba")
        else:
            if bg_iter is not None:
                try:
                    bg_frame = next(bg_iter)
                except StopIteration:
                    # loop the background video if it's shorter than input
                    bg_container.seek(0)
                    bg_iter = bg_container.decode(video=0)
                    bg_frame = next(bg_iter)
                bg_arr = bg_frame.to_ndarray(format="rgb24")
                if bg_arr.shape[0] != height or bg_arr.shape[1] != width:
                    bg_arr = np.array(
                        Image.fromarray(bg_arr).resize((width, height))
                    )
                bg_img = bg_arr
            assert bg_img is not None
            alpha = pha_hw[..., None]
            composite = (
                fgr_hwc * alpha + bg_img.astype(np.float32) / 255.0 * (1.0 - alpha)
            )
            composite = (composite * 255.0).clip(0, 255).astype(np.uint8)
            out_frame = av.VideoFrame.from_ndarray(composite, format="rgb24")

        for packet in out_stream.encode(out_frame):
            out_container.mux(packet)

        frame_idx += 1
        if on_progress is not None and (frame_idx % 5 == 0 or frame_idx == total_frames):
            on_progress(frame_idx, total_frames)

    # Flush encoder
    for packet in out_stream.encode():
        out_container.mux(packet)
    out_container.close()
    in_container.close()
    matting_container.close()
    if bg_container is not None:
        bg_container.close()
    if matting_temp is not None and matting_temp.exists():
        try:
            matting_temp.unlink()
        except Exception:
            pass

    # Audio passthrough — we wrote a video-only file above; now mux the
    # original audio in. Skipped for transparent (.mov/ProRes 4444) because
    # ProRes containers don't always survive a stream copy round-trip cleanly
    # and the typical use case for transparent is a separate audio track.
    if background_kind != "transparent":
        ffmpeg = _find_ffmpeg()
        if ffmpeg and _has_audio(input_video):
            try:
                _mux_audio(ffmpeg, output_video, input_video)
            except Exception as exc:  # noqa: BLE001
                # Audio failure shouldn't kill the whole job — the user
                # already has a video, just without sound.
                print(f"[chroma_key] audio mux failed: {exc}")

    return {"output_video": output_video, "frames": frame_idx}


def _has_audio(path: str) -> bool:
    try:
        c = av.open(path)
        has = any(s.type == "audio" for s in c.streams)
        c.close()
        return has
    except Exception:
        return False


def _find_ffmpeg() -> str | None:
    """Locate the FFmpeg binary the host app uses. We prefer the portable
    one shipped under `data/ffmpeg/` (so output matches what the rest of
    the pipeline produces), but fall back to system FFmpeg if the user
    pointed Setup at one."""
    # Walk up from sidecar location to find data/.
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "data" / "ffmpeg" / "ffmpeg"
        if cand.exists():
            return str(cand)
        cand = parent / "data" / "ffmpeg" / "ffmpeg.exe"
        if cand.exists():
            return str(cand)
    return shutil.which("ffmpeg")


def _chromakey_to_black(
    ffmpeg: str,
    src: str,
    dst: str,
    color: str = "0x00FF00",
    similarity: float = 0.4,
    blend: float = 0.0,
) -> None:
    """Run FFmpeg's `chromakey` filter as a pre-pass — replaces every pixel
    close to `color` with full transparent black on a video stream. We then
    feed this into RVM, which finds it trivial to mat a subject against
    pure black, eliminating the green-rim artefact entirely.

    Output is yuv420p MP4 (no alpha) — `chromakey` makes the matched pixels
    transparent over a black background, which collapses to *just black*
    after pixel-format flattening, which is exactly what we want.
    """
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        src,
        "-vf",
        f"chromakey=color={color}:similarity={similarity}:blend={blend},format=yuv420p",
        "-an",  # we re-mux audio later anyway
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        dst,
    ]
    subprocess.run(cmd, check=True)


def _mux_audio(ffmpeg: str, video_path: str, source_with_audio: str) -> None:
    tmp = str(Path(video_path).with_suffix(".muxing.mp4"))
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video_path,
        "-i",
        source_with_audio,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",  # optional — don't fail if no audio
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        tmp,
    ]
    subprocess.run(cmd, check=True)
    Path(tmp).replace(video_path)
