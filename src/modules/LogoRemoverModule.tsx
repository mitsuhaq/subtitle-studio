import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import {
  PixelArrowRight,
  PixelCheck,
  PixelEraser,
  PixelFolder,
  PixelRefresh,
  PixelUpload,
  PixelX,
} from "../components/icons";
import { OutputDirCard } from "../components/OutputDirCard";
import { useModuleDrop } from "../state/useModuleDrop";
import {
  extractPreviewFrame,
  logoRemoverCancel,
  logoRemoverRun,
  notify,
  onLogoRemoverProgress,
  pickVideoFile,
  probeVideoDimensions,
  revealInShell,
  VIDEO_EXTS,
} from "../lib/tauri";
import type { LogoProgress, LogoRegion, LogoResult } from "../lib/tauri";

const isVideoPath = (p: string) =>
  VIDEO_EXTS.some((ext) => p.toLowerCase().endsWith(`.${ext}`));

type Phase = "idle" | "running" | "done" | "error" | "cancelled";

interface DrawingState {
  /** Mouse anchor (image-relative pixels) where drag started. */
  anchorX: number;
  anchorY: number;
  /** Current mouse position. The actual rectangle is min/max of anchor & cur. */
  curX: number;
  curY: number;
}

export default function LogoRemoverModule() {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  // Source video dimensions (post-rotation, what libass / delogo see).
  // We need them to translate screen-pixel rectangles back to source pixels.
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [regions, setRegions] = useState<LogoRegion[]>([]);
  const [drawing, setDrawing] = useState<DrawingState | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<LogoProgress | null>(null);
  const [result, setResult] = useState<LogoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);

  useModuleDrop("logo_remover", (paths) => {
    const v = paths.find(isVideoPath);
    if (v) loadVideo(v);
  });

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;
    onLogoRemoverProgress((p) => setProgress(p)).then((un) => {
      if (aborted) un();
      else unlisten = un;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  const loadVideo = (path: string) => {
    setVideoPath(path);
    setFrameSrc(null);
    setVideoDims(null);
    setRegions([]);
    setResult(null);
    setError(null);
    setPhase("idle");

    // Probe dimensions (post-rotation) and grab a mid-frame in parallel.
    probeVideoDimensions(path)
      .then(([w, h]) => setVideoDims({ w, h }))
      .catch((err) => console.warn("probe dims failed:", err));
    extractPreviewFrame(path)
      .then((p) => setFrameSrc(`${convertFileSrc(p)}?t=${Date.now()}`))
      .catch((err) => {
        console.warn("preview frame failed:", err);
        setError(String(err));
      });
  };

  const browse = async () => {
    const p = await pickVideoFile();
    if (p) loadVideo(p);
  };

  const reset = () => {
    setVideoPath(null);
    setFrameSrc(null);
    setVideoDims(null);
    setRegions([]);
    setProgress(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  };

  const cancel = () => {
    logoRemoverCancel().catch(() => {});
  };

  const elapsed = useElapsed(phase === "running");

  // ---- Mouse handling on the preview ---------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!imgRef.current || phase === "running") return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDrawing({ anchorX: x, anchorY: y, curX: x, curY: y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    setDrawing({
      ...drawing,
      curX: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      curY: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing || !imgRef.current || !videoDims) {
      setDrawing(null);
      return;
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
    const rect = imgRef.current.getBoundingClientRect();
    // Convert screen coords (relative to <img>) → source video pixels.
    // The rendered image is letterboxed to fit the container, so use the
    // *image*'s bounding rect (not the wrapping div) — that gives us the
    // real on-screen pixel dimensions of the actual frame.
    const sx = videoDims.w / rect.width;
    const sy = videoDims.h / rect.height;
    const x1 = Math.min(drawing.anchorX, drawing.curX) * sx;
    const y1 = Math.min(drawing.anchorY, drawing.curY) * sy;
    const x2 = Math.max(drawing.anchorX, drawing.curX) * sx;
    const y2 = Math.max(drawing.anchorY, drawing.curY) * sy;
    const w = Math.round(x2 - x1);
    const h = Math.round(y2 - y1);
    setDrawing(null);
    // Discard tiny rectangles — usually a stray click rather than a drag.
    if (w < 4 || h < 4) return;
    setRegions((cur) => [
      ...cur,
      { x: Math.round(x1), y: Math.round(y1), w, h },
    ]);
  };

  const removeRegion = (i: number) =>
    setRegions((cur) => cur.filter((_, idx) => idx !== i));

  const canRun = !!videoPath && regions.length > 0 && phase !== "running";

  const run = async () => {
    if (!videoPath) return;
    setPhase("running");
    setProgress(null);
    setError(null);
    setResult(null);
    try {
      const r = await logoRemoverRun(videoPath, regions);
      setResult(r);
      setPhase("done");
      const name = r.output_video.split("/").pop() ?? r.output_video;
      await notify("Zonthor Studio — логотип удалён", name);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("Прервано") || msg.includes("cancelled")) {
        setPhase("cancelled");
      } else {
        setError(msg);
        setPhase("error");
      }
    }
  };

  // Rectangle currently being dragged, in screen pixels for overlay.
  const liveRect = drawing
    ? {
        x: Math.min(drawing.anchorX, drawing.curX),
        y: Math.min(drawing.anchorY, drawing.curY),
        w: Math.abs(drawing.curX - drawing.anchorX),
        h: Math.abs(drawing.curY - drawing.anchorY),
      }
    : null;

  // Existing regions need to come back from source-pixel space to screen-
  // pixel space for display. We do this lazily inside the render to stay
  // correct on window resize without a layout subscription.
  const screenScale = (() => {
    if (!imgRef.current || !videoDims) return null;
    const rect = imgRef.current.getBoundingClientRect();
    return { sx: rect.width / videoDims.w, sy: rect.height / videoDims.h };
  })();

  return (
    <div className="p-6 grid gap-6 max-w-5xl mx-auto">
      <GlassCard>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <PixelEraser size={16} className="text-gold-300" />
              Удалить логотип / водяной знак
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              Обведите прямоугольник вокруг логотипа на превью — FFmpeg
              заполнит эту область интерполяцией соседних пикселей. Подходит
              для статичных логотипов в углу. Двигающийся текст в середине
              кадра требует более сложного алгоритма (ProPainter, в работе).
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn-ghost"
              onClick={browse}
              disabled={phase === "running"}
            >
              <PixelUpload size={16} />
              <span>Файл</span>
            </button>
            <button
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={run}
              disabled={!canRun}
            >
              <span>Запустить</span>
              <PixelArrowRight size={16} />
            </button>
          </div>
        </div>
      </GlassCard>

      {!videoPath && (
        <GlassCard className="border-dashed border-white/10 hover:border-gold-500/40 transition-colors">
          <div className="h-56 grid place-items-center text-zinc-500 text-sm text-center">
            Drag &amp; drop видео сюда
            <br />
            <span className="text-zinc-600 text-[11px]">
              .mp4 .mov .mkv .avi .webm .flv .m4v
            </span>
          </div>
        </GlassCard>
      )}

      {videoPath && (
        <GlassCard>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-zinc-500 uppercase tracking-wide">
                Видео
              </div>
              <code className="block mt-1 text-[12px] text-zinc-200 break-all">
                {videoPath}
              </code>
              {videoDims && (
                <div className="text-[11px] text-zinc-500 mt-1">
                  {videoDims.w} × {videoDims.h}
                </div>
              )}
            </div>
            {phase !== "running" && (
              <button className="btn-ghost shrink-0" onClick={reset}>
                <PixelRefresh size={14} />
                Сбросить
              </button>
            )}
          </div>

          {!frameSrc && (
            <div className="h-56 grid place-items-center text-zinc-500 text-sm">
              <PixelSpinner size={16} className="text-gold-300" />
              <span className="ml-2">Готовлю превью…</span>
            </div>
          )}

          {frameSrc && (
            <div
              className="relative w-full select-none touch-none cursor-crosshair"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img
                ref={imgRef}
                src={frameSrc}
                alt="Preview frame"
                className="w-full h-auto rounded-lg border border-white/10 pointer-events-none"
                draggable={false}
              />
              {/* Existing regions */}
              {screenScale &&
                regions.map((r, i) => (
                  <div
                    key={i}
                    className="absolute border-2 border-gold-400 bg-gold-400/15 pointer-events-none"
                    style={{
                      left: r.x * screenScale.sx,
                      top: r.y * screenScale.sy,
                      width: r.w * screenScale.sx,
                      height: r.h * screenScale.sy,
                    }}
                  >
                    <span className="absolute -top-5 left-0 text-[10px] text-gold-300 bg-bg-950/80 px-1 rounded">
                      #{i + 1}
                    </span>
                  </div>
                ))}
              {/* Currently-drawn rectangle */}
              {liveRect && (
                <div
                  className="absolute border-2 border-dashed border-gold-200 bg-gold-200/20 pointer-events-none"
                  style={{
                    left: liveRect.x,
                    top: liveRect.y,
                    width: liveRect.w,
                    height: liveRect.h,
                  }}
                />
              )}
            </div>
          )}

          {regions.length > 0 && phase !== "running" && (
            <div className="mt-4 grid gap-1.5">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wide">
                Области · {regions.length}
              </div>
              {regions.map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-white/[0.06] text-[12px] text-zinc-300"
                >
                  <span className="text-gold-300/80">#{i + 1}</span>
                  <span className="tabular-nums text-zinc-400">
                    x:{r.x} y:{r.y} · {r.w} × {r.h}px
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => removeRegion(i)}
                    className="text-zinc-500 hover:text-red-300"
                    aria-label="Удалить область"
                  >
                    <PixelX size={12} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-[11px] text-zinc-500 hover:text-zinc-300 self-start mt-1"
                onClick={() => setRegions([])}
              >
                Очистить все
              </button>
            </div>
          )}
        </GlassCard>
      )}

      {phase === "running" && (
        <GlassCard>
          <div className="flex items-center justify-between gap-2 text-[12px] mb-3">
            <div className="flex items-center gap-2 text-zinc-300">
              <PixelSpinner className="text-gold-300 shrink-0" size={14} />
              <span>{progress?.stage ?? "Подготовка"}</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-zinc-500 tabular-nums">
                {formatElapsed(elapsed)}
              </span>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={cancel}>
                <PixelX size={12} />
                Прервать
              </button>
            </div>
          </div>
          <ProgressBar
            value={progress?.pos ?? 0}
            total={progress?.total ?? 0}
            label={
              progress?.total
                ? `${formatTime(progress.pos)} / ${formatTime(progress.total)}`
                : "—"
            }
            pulsing={!progress?.total}
          />
        </GlassCard>
      )}

      {phase === "cancelled" && (
        <GlassCard>
          <div className="text-sm text-zinc-300">Прервано пользователем.</div>
        </GlassCard>
      )}

      {phase === "done" && result && (
        <GlassCard className="animate-gold-flash">
          <div className="flex items-center gap-3">
            <PixelCheck size={16} className="text-gold-300 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gold-100/95">Готово</div>
              <code className="block text-[11px] text-gold-200/90 break-all mt-1">
                {result.output_video}
              </code>
            </div>
            <button
              className="btn-ghost shrink-0"
              onClick={() => revealInShell(result.output_video)}
            >
              <PixelFolder size={14} />
              Показать
            </button>
          </div>
        </GlassCard>
      )}

      {phase === "error" && error && (
        <GlassCard>
          <div className="flex items-start gap-3 text-sm text-red-200/95">
            <PixelX size={16} className="text-red-300 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0 break-all">{error}</div>
          </div>
        </GlassCard>
      )}

      <OutputDirCard
        moduleId="logo_remover"
        moduleLabel="Удаление логотипа"
        disabled={phase === "running"}
      />
    </div>
  );
}

function useElapsed(running: boolean): number {
  const [now, setNow] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!running) {
      startRef.current = null;
      setNow(0);
      return;
    }
    startRef.current = performance.now();
    const id = window.setInterval(() => {
      if (startRef.current != null) {
        setNow(performance.now() - startRef.current);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [running]);
  return now;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s} с`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

