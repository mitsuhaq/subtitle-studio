import { useEffect, useRef, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import {
  PixelArrowRight,
  PixelCheck,
  PixelFolder,
  PixelMic,
  PixelRefresh,
  PixelSparkles,
  PixelUpload,
  PixelX,
} from "../components/icons";
import { ModuleGate } from "../components/SideDrawer";
import { OutputDirCard } from "../components/OutputDirCard";
import { useModuleDrop } from "../state/useModuleDrop";
import {
  audioFixCancel,
  audioFixRun,
  notify,
  onAudioFixProgress,
  pickVideoFile,
  revealInShell,
  VIDEO_EXTS,
} from "../lib/tauri";
import type {
  AudioFixOptions,
  AudioFixProgress,
  AudioFixResult,
} from "../lib/tauri";

const isVideoPath = (p: string) =>
  VIDEO_EXTS.some((ext) => p.toLowerCase().endsWith(`.${ext}`));

type Phase = "idle" | "running" | "done" | "error" | "cancelled";

const LUFS_PRESETS: { label: string; value: number; hint: string }[] = [
  { label: "Стриминг (-16)", value: -16, hint: "YouTube/Spotify" },
  { label: "Подкаст (-19)", value: -19, hint: "Apple Podcasts" },
  { label: "ТВ (-23)", value: -23, hint: "EBU R128 broadcast" },
];

export default function AudioFixModule() {
  return (
    <ModuleGate moduleId="audio_fix">
      <AudioFixInner />
    </ModuleGate>
  );
}

function AudioFixInner() {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [denoise, setDenoise] = useState(true);
  const [loudnorm, setLoudnorm] = useState(true);
  const [targetLufs, setTargetLufs] = useState(-16);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<AudioFixProgress | null>(null);
  const [result, setResult] = useState<AudioFixResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useModuleDrop("audio_fix", (paths) => {
    const v = paths.find(isVideoPath);
    if (v) setVideoPath(v);
  });

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;
    onAudioFixProgress((p) => setProgress(p)).then((un) => {
      if (aborted) un();
      else unlisten = un;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  const elapsed = useElapsed(phase === "running");
  const canRun =
    !!videoPath && phase !== "running" && (denoise || loudnorm);

  const run = async () => {
    if (!videoPath) return;
    setPhase("running");
    setProgress(null);
    setError(null);
    setResult(null);
    const opts: AudioFixOptions = {
      denoise,
      loudnorm,
      target_lufs: targetLufs,
    };
    try {
      const r = await audioFixRun(videoPath, opts);
      setResult(r);
      setPhase("done");
      const name = r.output_video.split("/").pop() ?? r.output_video;
      await notify("Zonthor Studio — звук обработан", name);
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

  const cancel = () => {
    audioFixCancel().catch(() => {});
  };

  const browse = async () => {
    const p = await pickVideoFile();
    if (p) setVideoPath(p);
  };

  return (
    <div className="p-6 grid gap-6 max-w-5xl mx-auto">
      <GlassCard>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <PixelMic size={16} className="text-gold-300" />
              Audio Fix — шумодав и нормализация громкости
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              RNNoise убирает фоновый шум, EBU R128 loudnorm выравнивает уровень
              под платформу. Видео остаётся без изменений (поток копируется).
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn-ghost" onClick={browse} disabled={phase === "running"}>
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
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-zinc-500 uppercase tracking-wide">
                Видео
              </div>
              <code className="block mt-1 text-[12px] text-zinc-200 break-all">
                {videoPath}
              </code>
            </div>
            {phase !== "running" && (
              <button
                className="btn-ghost shrink-0"
                onClick={() => {
                  setVideoPath(null);
                  setResult(null);
                  setPhase("idle");
                  setError(null);
                }}
              >
                <PixelRefresh size={14} />
                Сбросить
              </button>
            )}
          </div>
        </GlassCard>
      )}

      <GlassCard>
        <h2 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2">
          <PixelSparkles size={14} className="text-gold-300" />
          Что сделать
        </h2>

        <div className="grid gap-3">
          <Toggle
            checked={denoise}
            onChange={setDenoise}
            label="Шумоподавление (RNNoise)"
            hint="Убирает фоновый шум: вентилятор, улицу, эхо комнаты."
          />
          <Toggle
            checked={loudnorm}
            onChange={setLoudnorm}
            label="Нормализация громкости (EBU R128)"
            hint="Выравнивает средний уровень под выбранную платформу."
          />

          {loudnorm && (
            <div className="ml-6 mt-1 grid gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500">Целевой уровень</span>
                <span className="text-[11px] text-gold-200/90 tabular-nums">
                  {targetLufs.toFixed(1)} LUFS
                </span>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={-30}
                  max={-6}
                  step={0.5}
                  value={targetLufs}
                  onChange={(e) => setTargetLufs(Number(e.target.value))}
                  className="flex-1 accent-gold-500"
                />
                <input
                  type="number"
                  min={-30}
                  max={-6}
                  step={0.5}
                  value={targetLufs}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setTargetLufs(v);
                  }}
                  className="w-20 bg-bg-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-gold-500/50 tabular-nums"
                />
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {LUFS_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setTargetLufs(p.value)}
                    className={`px-2.5 py-1.5 rounded border text-[11px] transition-colors ${
                      Math.abs(targetLufs - p.value) < 0.01
                        ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                        : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
                    }`}
                    title={p.hint}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-zinc-600">
                Тише = ниже число (−30 = очень тихо · −6 = почти максимум, риск
                клиппинга). EBU-стандарт −23, стриминг обычно −16…−14.
              </div>
            </div>
          )}
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

      <OutputDirCard moduleId="audio_fix" moduleLabel="Audio Fix" disabled={phase === "running"} />
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
        checked
          ? "border-gold-500/40 bg-gold-500/[0.05]"
          : "border-white/[0.06] bg-white/[0.02] hover:border-gold-500/30"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-gold-500 mt-0.5 w-4 h-4"
      />
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-medium ${checked ? "text-gold-200" : "text-zinc-200"}`}>
          {label}
        </div>
        <div className="text-[11px] text-zinc-500 mt-0.5">{hint}</div>
      </div>
    </label>
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
