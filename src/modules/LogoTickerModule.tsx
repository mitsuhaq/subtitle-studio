import { useEffect, useRef, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import {
  PixelArrowRight,
  PixelCheck,
  PixelFolder,
  PixelMarquee,
  PixelRefresh,
  PixelUpload,
  PixelX,
} from "../components/icons";
import { OutputDirCard } from "../components/OutputDirCard";
import { TimecodePicker, formatTimecode } from "../components/TimecodePicker";
import { useModuleDrop } from "../state/useModuleDrop";
import {
  IMAGE_EXTS,
  logoTickerCancel,
  logoTickerRun,
  notify,
  onLogoTickerProgress,
  pickImageFiles,
  revealInShell,
} from "../lib/tauri";
import type {
  LogoTickerOptions,
  LogoTickerProgress,
  LogoTickerResult,
} from "../lib/tauri";

const isImagePath = (p: string) =>
  IMAGE_EXTS.some((ext) => p.toLowerCase().endsWith(`.${ext}`));

type Phase = "idle" | "running" | "done" | "error" | "cancelled";

interface AspectPreset {
  id: string;
  label: string;
  /** Canvas width in px — sized to the long edge of the matching video
   *  format so the ticker fits across without scaling. The ticker height
   *  is a separate user-controlled slider; aspect only sets the width. */
  width: number;
}

// The user picks "what video shape is this for" — that's a horizontal
// resolution. Ticker height stays a separate knob since most overlays
// are a thin band, not a full-aspect frame.
const ASPECT_PRESETS: AspectPreset[] = [
  { id: "16x9", label: "16:9 — 1920", width: 1920 },
  { id: "9x16", label: "9:16 — 1080", width: 1080 },
  { id: "1x1", label: "1:1 — 1080", width: 1080 },
  { id: "4x5", label: "4:5 — 1080", width: 1080 },
];

const MAX_DURATION_S = 600; // 10 min

export default function LogoTickerModule() {
  const [logos, setLogos] = useState<string[]>([]);
  const [presetId, setPresetId] = useState<string>(ASPECT_PRESETS[0].id);
  const [customW, setCustomW] = useState(1920);
  const [tickerHeight, setTickerHeight] = useState(120);
  const [duration, setDuration] = useState(30);
  const [speed, setSpeed] = useState(120);
  const [padding, setPadding] = useState(80);
  // 25 fps matches PAL / European broadcast and most editing timelines
  // we ship to. 30/60 stay reachable via the slider.
  const [fps, setFps] = useState(25);

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<LogoTickerProgress | null>(null);
  const [result, setResult] = useState<LogoTickerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve canvas width: preset gives a fixed pixel width per aspect;
  // "custom" lets the user dial in something specific. Height is the
  // ticker band height regardless of aspect.
  const preset = ASPECT_PRESETS.find((p) => p.id === presetId);
  const width = preset ? preset.width : customW;
  const height = tickerHeight;

  useModuleDrop("logo_ticker", (paths) => {
    const accepted = paths.filter(isImagePath);
    if (accepted.length > 0) {
      setLogos((cur) => Array.from(new Set([...cur, ...accepted])));
    }
  });

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;
    onLogoTickerProgress((p) => setProgress(p)).then((un) => {
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
    const ps = await pickImageFiles();
    if (ps.length > 0) {
      setLogos((cur) => Array.from(new Set([...cur, ...ps])));
    }
  };

  const removeAt = (i: number) =>
    setLogos((cur) => cur.filter((_, idx) => idx !== i));

  const moveUp = (i: number) =>
    setLogos((cur) => {
      if (i === 0) return cur;
      const next = [...cur];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });

  const moveDown = (i: number) =>
    setLogos((cur) => {
      if (i >= cur.length - 1) return cur;
      const next = [...cur];
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    });

  const reset = () => {
    setLogos([]);
    setPhase("idle");
    setProgress(null);
    setResult(null);
    setError(null);
  };

  const cancel = () => {
    logoTickerCancel().catch(() => {});
  };

  const canRun =
    logos.length > 0 &&
    width >= 16 &&
    height >= 16 &&
    duration >= 0.5 &&
    speed >= 1 &&
    phase !== "running";

  const run = async () => {
    if (!canRun) return;
    setPhase("running");
    setProgress(null);
    setResult(null);
    setError(null);
    const opts: LogoTickerOptions = {
      width,
      height,
      duration,
      speed,
      padding,
      fps,
    };
    try {
      const r = await logoTickerRun(logos, opts);
      setResult(r);
      setPhase("done");
      const name = r.output_path.split("/").pop() ?? r.output_path;
      await notify("Zonthor Studio — бегущая строка готова", name);
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

  return (
    <div className="p-6 grid gap-6 max-w-5xl mx-auto">
      <GlassCard>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <PixelMarquee size={16} className="text-gold-300" />
              Бегущая строка лого
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              Закидываешь пачку логотипов, выбираешь формат и
              длительность — программа склеивает их в горизонтальную
              ленту, дублирует и пускает по экрану. На выходе .mov с
              прозрачным фоном — кладёшь поверх любого видео в
              редакторе.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn-ghost"
              onClick={browse}
              disabled={phase === "running"}
            >
              <PixelUpload size={16} />
              <span>Файлы</span>
            </button>
            <button
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={run}
              disabled={!canRun}
            >
              <span>Сгенерировать</span>
              <PixelArrowRight size={16} />
            </button>
          </div>
        </div>
      </GlassCard>

      {logos.length === 0 ? (
        <GlassCard className="border-dashed border-white/10 hover:border-gold-500/40 transition-colors">
          <div className="h-40 grid place-items-center text-zinc-500 text-sm text-center">
            Drag &amp; drop логотипы сюда (можно сразу пачкой)
            <br />
            <span className="text-zinc-600 text-[11px]">
              .png .jpg .webp .bmp · с прозрачным фоном для лучшего результата
            </span>
          </div>
        </GlassCard>
      ) : (
        <GlassCard>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-zinc-500 uppercase tracking-wide">
              Логотипы · {logos.length} (порядок слева-направо в строке)
            </div>
            {phase !== "running" && (
              <button className="btn-ghost" onClick={reset}>
                <PixelRefresh size={14} />
                Очистить
              </button>
            )}
          </div>
          <div className="grid gap-1.5 max-h-72 overflow-auto">
            {logos.map((p, i) => (
              <div
                key={p}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-white/[0.06] text-[12px]"
              >
                <span className="text-gold-300/70 tabular-nums w-5 text-right">
                  {i + 1}
                </span>
                <img
                  src={`asset://localhost/${encodeURI(p)}`}
                  alt=""
                  className="h-6 max-w-[80px] object-contain"
                />
                <span className="truncate flex-1 text-zinc-200">
                  {p.split("/").pop()}
                </span>
                {phase !== "running" && (
                  <>
                    <button
                      type="button"
                      onClick={() => moveUp(i)}
                      disabled={i === 0}
                      className="text-zinc-500 hover:text-zinc-200 disabled:opacity-20"
                      title="Влево"
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      onClick={() => moveDown(i)}
                      disabled={i >= logos.length - 1}
                      className="text-zinc-500 hover:text-zinc-200 disabled:opacity-20"
                      title="Вправо"
                    >
                      →
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAt(i)}
                      className="text-zinc-500 hover:text-red-300"
                    >
                      <PixelX size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      <GlassCard>
        <h2 className="text-sm font-semibold text-zinc-200 mb-3">
          Параметры строки
        </h2>
        <div className="grid gap-4">
          <div>
            <div className="text-[11px] text-zinc-500 mb-2">
              Под какой формат видео
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {ASPECT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPresetId(p.id)}
                  className={`px-2.5 py-1.5 rounded border text-[11px] transition-colors ${
                    presetId === p.id
                      ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                      : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPresetId("custom")}
                className={`px-2.5 py-1.5 rounded border text-[11px] transition-colors ${
                  presetId === "custom"
                    ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                    : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
                }`}
              >
                Своя ширина
              </button>
            </div>
            {presetId === "custom" && (
              <div className="mt-3 max-w-xs">
                <label className="text-[11px] text-zinc-500">
                  Ширина строки, px
                  <input
                    type="number"
                    min={16}
                    value={customW}
                    onChange={(e) => setCustomW(Number(e.target.value) || 0)}
                    className="mt-1 w-full bg-bg-900 border border-white/10 rounded px-2 py-1 text-[12px] text-zinc-100 focus:outline-none focus:border-gold-500/50 tabular-nums"
                  />
                </label>
              </div>
            )}
          </div>

          <NumberRow
            label="Высота строки, px"
            value={tickerHeight}
            onChange={setTickerHeight}
            min={40}
            max={500}
            step={10}
            hint="Под эту высоту масштабируются все логотипы (с сохранением пропорций)."
          />

          <div className="grid grid-cols-[180px_1fr] gap-3 items-center">
            <span className="text-xs text-zinc-500">Длительность</span>
            <div className="flex items-center gap-3">
              <TimecodePicker
                value={duration}
                onChange={(v) => setDuration(Math.min(MAX_DURATION_S, Math.max(0.5, v)))}
                max={MAX_DURATION_S}
                min={0.5}
              />
              <input
                type="range"
                min={1}
                max={MAX_DURATION_S}
                step={1}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="flex-1 accent-gold-500"
              />
            </div>
            <div className="col-span-2 text-[10px] text-zinc-600 -mt-1">
              Длина итогового .mov · максимум {formatTimecode(MAX_DURATION_S)}.
              Лента бесшовно повторяется до этого момента.
            </div>
          </div>
          <NumberRow
            label="Скорость, px/сек"
            value={speed}
            onChange={setSpeed}
            min={10}
            max={1000}
            step={10}
            hint="Сколько пикселей лента сдвигается за секунду. ~120 — спокойно, ~300 — бодро."
          />
          <NumberRow
            label="Отступ между лого, px"
            value={padding}
            onChange={setPadding}
            min={0}
            max={500}
            step={5}
            hint="Прозрачный промежуток между соседними логотипами в ленте."
          />
          <NumberRow
            label="FPS"
            value={fps}
            onChange={setFps}
            min={15}
            max={60}
            step={1}
            hint="30 — стандарт. 60 даёт более плавное движение, но удваивает размер файла."
          />
        </div>
      </GlassCard>

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
                {result.output_path}
              </code>
            </div>
            <button
              className="btn-ghost shrink-0"
              onClick={() => revealInShell(result.output_path)}
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
            <div className="flex-1 min-w-0 break-all whitespace-pre-line">
              {error}
            </div>
          </div>
        </GlassCard>
      )}

      <OutputDirCard
        moduleId="logo_ticker"
        moduleLabel="Бегущая строка"
        disabled={phase === "running"}
      />
    </div>
  );
}

function NumberRow({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  hint?: string;
}) {
  return (
    <div className="grid grid-cols-[180px_1fr_90px] gap-3 items-center">
      <span className="text-xs text-zinc-500">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-gold-500"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="bg-bg-900 border border-white/10 rounded px-2 py-1 text-[12px] text-zinc-100 focus:outline-none focus:border-gold-500/50 tabular-nums"
      />
      {hint && (
        <div className="col-span-3 text-[10px] text-zinc-600 -mt-1">
          {hint}
        </div>
      )}
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
