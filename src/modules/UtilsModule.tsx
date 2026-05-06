import { useEffect, useRef, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import {
  PixelArrowRight,
  PixelCheck,
  PixelFolder,
  PixelRefresh,
  PixelSparkles,
  PixelUpload,
  PixelToolbox,
  PixelX,
} from "../components/icons";
import {
  notify,
  onUtilsProgress,
  pickImageFile,
  pickMediaFile,
  pickVideoFile,
  probeVideoDuration,
  revealInShell,
  utilConvert,
  utilOverlay,
  utilTrim,
  utilsCancel,
  VIDEO_EXTS,
} from "../lib/tauri";
import type { UtilProgress, UtilResult } from "../lib/tauri";
import { useModuleDrop } from "../state/useModuleDrop";
import { OutputDirCard } from "../components/OutputDirCard";
import { TimecodePicker, formatTimecode } from "../components/TimecodePicker";

const AUDIO_EXTS = ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "wma"];
const isVideoPath = (p: string) =>
  VIDEO_EXTS.some((ext) => p.toLowerCase().endsWith(`.${ext}`));
const isAudioPath = (p: string) =>
  AUDIO_EXTS.some((ext) => p.toLowerCase().endsWith(`.${ext}`));
const isMediaPath = (p: string) => isVideoPath(p) || isAudioPath(p);

type Op = "trim" | "convert" | "overlay";
type Phase = "idle" | "running" | "done" | "error" | "cancelled";

const FORMATS: { value: string; label: string; group: "video" | "audio" }[] = [
  { value: "mp4", label: "MP4 (H.264)", group: "video" },
  { value: "mov", label: "MOV", group: "video" },
  { value: "webm", label: "WebM (VP9)", group: "video" },
  { value: "mkv", label: "MKV", group: "video" },
  { value: "gif", label: "GIF", group: "video" },
  { value: "mp3", label: "MP3", group: "audio" },
  { value: "wav", label: "WAV", group: "audio" },
  { value: "aac", label: "AAC", group: "audio" },
  { value: "m4a", label: "M4A", group: "audio" },
];

export default function UtilsModule() {
  const [op, setOp] = useState<Op>("trim");
  const [videos, setVideos] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UtilProgress | null>(null);
  const [results, setResults] = useState<UtilResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);

  // Trim
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [duration, setDuration] = useState(0);

  // Convert
  const [targetFormat, setTargetFormat] = useState("mp4");

  // Overlay
  const [overlayPath, setOverlayPath] = useState<string | null>(null);

  useModuleDrop("utils", (paths) => {
    // Overlay puts an image *on top of* a video — meaningless for audio.
    // Trim and Convert work on any media stream, so they accept audio
    // alongside video.
    const filter = op === "overlay" ? isVideoPath : isMediaPath;
    const dropped = paths.filter(filter);
    if (dropped.length > 0) {
      setVideos((cur) => Array.from(new Set([...cur, ...dropped])));
    }
  });

  // Probe duration of the first selected video for the trim sliders.
  // Routed through Rust+ffmpeg (probe_video_duration) instead of the old
  // `<video asset://…>` trick — that approach silently never fired
  // `loadedmetadata` for some path layouts (spaces in volume names, drive
  // letters on Windows) which left both the slider AND the timecode picker
  // stuck on `disabled` because duration was never set.
  useEffect(() => {
    if (op !== "trim" || videos.length === 0) return;
    let cancelled = false;
    probeVideoDuration(videos[0])
      .then((dur) => {
        if (cancelled || !Number.isFinite(dur) || dur <= 0) return;
        setDuration(dur);
        setStartSec(0);
        setEndSec(dur);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("probe_video_duration failed:", err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [op, videos]);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;
    onUtilsProgress((p) => setProgress(p)).then((un) => {
      if (aborted) un();
      else unlisten = un;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  const elapsed = useElapsed(phase === "running");

  const browse = async () => {
    const p = op === "overlay" ? await pickVideoFile() : await pickMediaFile();
    if (p) setVideos((cur) => Array.from(new Set([...cur, p])));
  };

  const removeAt = (i: number) =>
    setVideos((cur) => cur.filter((_, idx) => idx !== i));

  const reset = () => {
    setVideos([]);
    setPhase("idle");
    setProgress(null);
    setResults([]);
    setError(null);
  };

  const cancel = () => {
    utilsCancel().catch(() => {});
  };

  const canRun =
    videos.length > 0 &&
    phase !== "running" &&
    (op !== "overlay" || !!overlayPath) &&
    (op !== "trim" || endSec > startSec);

  const run = async () => {
    setPhase("running");
    setProgress(null);
    setResults([]);
    setError(null);
    setBatchIndex(0);

    const out: UtilResult[] = [];
    for (let i = 0; i < videos.length; i++) {
      setBatchIndex(i);
      const v = videos[i];
      try {
        let r: UtilResult;
        if (op === "trim") {
          r = await utilTrim(v, {
            start: startSec > 0 ? startSec : null,
            end: endSec > 0 && endSec < duration ? endSec : null,
          });
        } else if (op === "convert") {
          r = await utilConvert(v, { target: targetFormat });
        } else {
          if (!overlayPath) throw new Error("Не выбрана картинка");
          r = await utilOverlay(v, { overlay_path: overlayPath });
        }
        out.push(r);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("Прервано") || msg.includes("cancelled")) {
          setResults(out);
          setPhase("cancelled");
          return;
        }
        setError(msg);
        setResults(out);
        setPhase("error");
        return;
      }
    }
    setResults(out);
    setPhase("done");
    await notify(
      "Zonthor Studio — утилиты готовы",
      `${out.length} ${out.length === 1 ? "файл" : "файлов"}`,
    );
  };

  return (
    <div className="p-6 grid gap-6 max-w-5xl mx-auto">
      <GlassCard>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <PixelToolbox size={16} className="text-gold-300" />
              Утилиты — обрезка, перекодировка, оверлей
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              Закидывайте видео пачкой. Выбранная операция применится к каждому
              файлу по очереди.
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

      <GlassCard>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { id: "trim" as const, label: "Обрезать" },
              { id: "convert" as const, label: "Перекодировать" },
              { id: "overlay" as const, label: "Наложить картинку" },
            ]
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setOp(t.id)}
              className={`px-3 py-2 rounded-lg border text-[13px] transition-colors ${
                op === t.id
                  ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                  : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-5">
          {op === "trim" && (
            <TrimPanel
              start={startSec}
              end={endSec}
              duration={duration}
              onStart={setStartSec}
              onEnd={setEndSec}
              multiple={videos.length > 1}
            />
          )}
          {op === "convert" && (
            <ConvertPanel
              target={targetFormat}
              onTarget={setTargetFormat}
              audioOnlyInput={
                videos.length > 0 && videos.every(isAudioPath)
              }
            />
          )}
          {op === "overlay" && (
            <OverlayPanel
              overlayPath={overlayPath}
              onPick={async () => {
                const p = await pickImageFile();
                if (p) setOverlayPath(p);
              }}
              onClear={() => setOverlayPath(null)}
            />
          )}
        </div>
      </GlassCard>

      {videos.length === 0 ? (
        <GlassCard className="border-dashed border-white/10 hover:border-gold-500/40 transition-colors">
          <div className="h-40 grid place-items-center text-zinc-500 text-sm text-center">
            {op === "overlay" ? (
              <>
                Drag &amp; drop видео сюда (можно сразу несколько)
                <br />
                <span className="text-zinc-600 text-[11px]">
                  .mp4 .mov .mkv .avi .webm .flv .m4v
                </span>
              </>
            ) : (
              <>
                Drag &amp; drop видео или аудио сюда (можно сразу несколько)
                <br />
                <span className="text-zinc-600 text-[11px]">
                  видео: .mp4 .mov .mkv .webm · аудио: .mp3 .wav .m4a .aac .flac
                </span>
              </>
            )}
          </div>
        </GlassCard>
      ) : (
        <GlassCard>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-zinc-500 uppercase tracking-wide">
              Файлы · {videos.length}
            </div>
            {phase !== "running" && (
              <button className="btn-ghost" onClick={reset}>
                <PixelRefresh size={14} />
                Очистить
              </button>
            )}
          </div>
          <div className="grid gap-1.5 max-h-72 overflow-auto">
            {videos.map((v, i) => (
              <div
                key={v}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-[12px] ${
                  phase === "running" && i === batchIndex
                    ? "border-gold-500/40 bg-gold-500/5"
                    : "border-white/[0.04]"
                }`}
              >
                <span className="truncate flex-1 text-zinc-200">
                  {v.split("/").pop()}
                </span>
                {phase !== "running" && (
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="text-zinc-500 hover:text-red-300"
                  >
                    <PixelX size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      {phase === "running" && (
        <GlassCard>
          <div className="flex items-center justify-between gap-2 text-[12px] mb-3">
            <div className="flex items-center gap-2 text-zinc-300">
              <PixelSpinner className="text-gold-300 shrink-0" size={14} />
              <span>
                {progress?.stage ?? "Подготовка"} · {batchIndex + 1} /{" "}
                {videos.length}
              </span>
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

      {(phase === "done" || phase === "error") && results.length > 0 && (
        <GlassCard
          className={phase === "done" ? "animate-gold-flash" : ""}
        >
          <div className="text-sm font-semibold text-zinc-100 flex items-center gap-2 mb-3">
            <PixelCheck size={14} className="text-gold-300" />
            Готово · {results.length} файл{results.length === 1 ? "" : results.length < 5 ? "а" : "ов"}
          </div>
          <div className="grid gap-1.5">
            {results.map((r) => (
              <div
                key={r.output_path}
                className="flex items-center gap-2 text-[12px] px-3 py-1.5 rounded-md border border-gold-500/20 bg-gold-500/[0.04]"
              >
                <PixelSparkles size={12} className="text-gold-300/80 shrink-0" />
                <code className="flex-1 min-w-0 text-gold-200/90 break-all truncate">
                  {r.output_path}
                </code>
                <button
                  className="btn-ghost shrink-0 px-2 py-1 text-[11px]"
                  onClick={() => revealInShell(r.output_path)}
                >
                  <PixelFolder size={10} />
                  Показать
                </button>
              </div>
            ))}
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

      <OutputDirCard moduleId="utils" moduleLabel="Утилиты" disabled={phase === "running"} />
    </div>
  );
}

function TrimPanel({
  start,
  end,
  duration,
  onStart,
  onEnd,
  multiple,
}: {
  start: number;
  end: number;
  duration: number;
  onStart: (n: number) => void;
  onEnd: (n: number) => void;
  multiple: boolean;
}) {
  // Slider step (10 ms) matches the Timecode picker's centisecond precision,
  // so dragging and typing snap to the same grid.
  const STEP = 0.01;
  const safeMax = Math.max(STEP, duration);
  return (
    <div className="grid gap-4">
      {multiple && (
        <div className="text-[11px] text-zinc-500">
          Тайминг применится одинаково ко всем файлам в очереди.
        </div>
      )}
      <Row label="Начало">
        <TimecodePicker
          value={start}
          onChange={(v) => {
            const next = Math.min(Math.max(0, v), Math.max(0, end - STEP));
            onStart(next);
          }}
          max={Math.max(0, end - STEP)}
          disabled={duration === 0}
        />
        <input
          type="range"
          min={0}
          max={safeMax}
          step={STEP}
          value={start}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), end - STEP);
            onStart(v);
          }}
          disabled={duration === 0}
          className="flex-1 accent-gold-500 disabled:opacity-50"
        />
      </Row>
      <Row label="Конец">
        <TimecodePicker
          value={end}
          onChange={(v) => {
            const next = Math.max(Math.min(duration, v), start + STEP);
            onEnd(next);
          }}
          max={duration}
          disabled={duration === 0}
        />
        <input
          type="range"
          min={0}
          max={safeMax}
          step={STEP}
          value={end}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), start + STEP);
            onEnd(v);
          }}
          disabled={duration === 0}
          className="flex-1 accent-gold-500 disabled:opacity-50"
        />
      </Row>
      {duration > 0 && (
        <div className="text-[11px] text-zinc-500">
          Длительность: {formatTimecode(duration)} · Останется:{" "}
          {formatTimecode(Math.max(0, end - start))}
        </div>
      )}
    </div>
  );
}

function ConvertPanel({
  target,
  onTarget,
  audioOnlyInput,
}: {
  target: string;
  onTarget: (s: string) => void;
  /** True when every queued source is audio-only — video targets get
   *  disabled because there's no video stream to encode into them. */
  audioOnlyInput: boolean;
}) {
  const groups: Record<"video" | "audio", typeof FORMATS> = {
    video: FORMATS.filter((f) => f.group === "video"),
    audio: FORMATS.filter((f) => f.group === "audio"),
  };
  return (
    <div className="grid gap-4">
      {(["video", "audio"] as const).map((g) => {
        const groupDisabled = g === "video" && audioOnlyInput;
        return (
          <div key={g}>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-2">
              {g === "video"
                ? audioOnlyInput
                  ? "Видео-форматы (нет видео-потока в исходнике)"
                  : "Видео-форматы"
                : "Аудио (вырезать звук)"}
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {groups[g].map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => !groupDisabled && onTarget(f.value)}
                  disabled={groupDisabled}
                  className={`px-2.5 py-1.5 rounded border text-[11px] transition-colors ${
                    target === f.value
                      ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                      : groupDisabled
                        ? "border-white/[0.04] bg-white/[0.01] text-zinc-600 cursor-not-allowed"
                        : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OverlayPanel({
  overlayPath,
  onPick,
  onClear,
}: {
  overlayPath: string | null;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="text-[11px] text-zinc-500">
        Картинка масштабируется до размера видео и накладывается полностью —
        используйте PNG с альфа-каналом, чтобы оставить фон видео видимым в
        прозрачных областях.
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button className="btn-ghost" onClick={onPick}>
          <PixelFolder size={14} />
          {overlayPath ? "Заменить картинку" : "Выбрать картинку"}
        </button>
        {overlayPath && (
          <>
            <code className="text-[11px] text-gold-200/80 break-all flex-1 min-w-0">
              {overlayPath}
            </code>
            <button
              type="button"
              onClick={onClear}
              className="text-zinc-500 hover:text-red-300"
            >
              <PixelX size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-3">
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
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
