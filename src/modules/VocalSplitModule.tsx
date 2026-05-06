import { useEffect, useRef, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import {
  PixelArrowRight,
  PixelCheck,
  PixelFolder,
  PixelRefresh,
  PixelUpload,
  PixelWave,
  PixelX,
} from "../components/icons";
import { OutputDirCard } from "../components/OutputDirCard";
import { useModuleDrop } from "../state/useModuleDrop";
import {
  notify,
  onProgress,
  onVocalSplitProgress,
  pickMediaFile,
  pythonExtraStatus,
  revealInShell,
  vocalSplitCancel,
  vocalSplitDemucsRun,
  vocalSplitRun,
  VIDEO_EXTS,
} from "../lib/tauri";
import type {
  VocalSplitMode,
  VocalSplitProgress,
  VocalSplitResult,
} from "../lib/tauri";

type Engine = "simple" | "demucs";

const AUDIO_EXTS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "flac",
  "wma",
];
const isMediaPath = (p: string) => {
  const lower = p.toLowerCase();
  return (
    VIDEO_EXTS.some((ext) => lower.endsWith(`.${ext}`)) ||
    AUDIO_EXTS.some((ext) => lower.endsWith(`.${ext}`))
  );
};

type Phase = "idle" | "running" | "done" | "error" | "cancelled";

const MODES: { id: VocalSplitMode; label: string; hint: string }[] = [
  {
    id: "extract",
    label: "Вытащить вокал",
    hint: "Оставить только то, что лежит в центре стерео-картины (обычно вокал)",
  },
  {
    id: "remove",
    label: "Убрать вокал (минусовка)",
    hint: "Подавить центр стерео-картины — получится karaoke-версия",
  },
];

export default function VocalSplitModule() {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [mode, setMode] = useState<VocalSplitMode>("extract");
  const [engine, setEngine] = useState<Engine>("simple");
  const [demucsInstalled, setDemucsInstalled] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<VocalSplitProgress | null>(null);
  const [result, setResult] = useState<VocalSplitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useModuleDrop("vocal_split", (paths) => {
    const v = paths.find(isMediaPath);
    if (v) setInputPath(v);
  });

  // Refresh Demucs install state on mount and whenever an install
  // completes. Modules in this app stay mounted while you switch tabs
  // (so their state survives drawer toggles), which means a pure
  // `useEffect(..., [])` would only run once at startup and never see
  // a Setup install land. Riding the `setup://progress` event channel
  // gives us a clean re-poll trigger without a dedicated bus.
  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;

    const refresh = () => {
      pythonExtraStatus("demucs")
        .then((s) => {
          if (aborted) return;
          setDemucsInstalled(s.installed);
          if (!s.installed) setEngine("simple");
        })
        .catch(() => {
          if (!aborted) setDemucsInstalled(false);
        });
    };

    refresh();
    onProgress((p) => {
      // Re-poll on either install completion ("Готово") or removal
      // ("Удалено"). Any other intermediate stage is just chatter from
      // the install pipeline that we don't need to react to.
      if (
        p.component.startsWith("py:") &&
        (p.stage === "Готово" || p.stage === "Удалено")
      ) {
        refresh();
      }
    }).then((un) => {
      if (aborted) un();
      else unlisten = un;
    });

    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;
    onVocalSplitProgress((p) => setProgress(p)).then((un) => {
      if (aborted) un();
      else unlisten = un;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  const elapsed = useElapsed(phase === "running");
  const canRun = !!inputPath && phase !== "running";

  const browse = async () => {
    const p = await pickMediaFile();
    if (p) setInputPath(p);
  };

  const reset = () => {
    setInputPath(null);
    setProgress(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  };

  const cancel = () => {
    vocalSplitCancel().catch(() => {});
  };

  const run = async () => {
    if (!inputPath) return;
    setPhase("running");
    setProgress(null);
    setError(null);
    setResult(null);
    try {
      const r =
        engine === "demucs"
          ? await vocalSplitDemucsRun(inputPath, mode)
          : await vocalSplitRun(inputPath, mode);
      setResult(r);
      setPhase("done");
      const name = r.output_path.split("/").pop() ?? r.output_path;
      await notify("Zonthor Studio — готово", name);
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
              <PixelWave size={16} className="text-gold-300" />
              Голос / музыка — разделение
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              Простое разделение через mid/side: работает на стерео-миксах с
              вокалом по центру (радио-стиль). На записях с жёстко
              спанорамированным или продублированным вокалом результат будет
              хуже — без полноценного нейросетевого демиксера по-другому не
              получится.
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

      {!inputPath && (
        <GlassCard className="border-dashed border-white/10 hover:border-gold-500/40 transition-colors">
          <div className="h-44 grid place-items-center text-zinc-500 text-sm text-center">
            Drag &amp; drop видео или аудио сюда
            <br />
            <span className="text-zinc-600 text-[11px]">
              видео: .mp4 .mov .mkv .webm · аудио: .mp3 .wav .m4a .aac .flac
            </span>
          </div>
        </GlassCard>
      )}

      {inputPath && (
        <GlassCard>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-zinc-500 uppercase tracking-wide">
                Файл
              </div>
              <code className="block mt-1 text-[12px] text-zinc-200 break-all">
                {inputPath}
              </code>
            </div>
            {phase !== "running" && (
              <button className="btn-ghost shrink-0" onClick={reset}>
                <PixelRefresh size={14} />
                Сбросить
              </button>
            )}
          </div>
        </GlassCard>
      )}

      <GlassCard>
        <h2 className="text-sm font-semibold text-zinc-200 mb-3">Движок</h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setEngine("simple")}
            className={`px-3 py-2.5 rounded-lg border text-left transition-colors ${
              engine === "simple"
                ? "border-gold-500/60 bg-gold-500/15"
                : "border-white/10 bg-white/[0.02] hover:border-gold-500/30"
            }`}
          >
            <div className={`text-[13px] ${engine === "simple" ? "text-gold-200" : "text-zinc-200"}`}>
              Простой (mid/side)
            </div>
            <div className="text-[11px] text-zinc-500 mt-0.5">
              Быстро, без модели. Хорош для центр-микса.
            </div>
          </button>
          <button
            type="button"
            onClick={() => demucsInstalled && setEngine("demucs")}
            disabled={!demucsInstalled}
            title={
              demucsInstalled
                ? "Demucs нейросеть"
                : "Demucs ещё не установлен — поставьте через Setup"
            }
            className={`px-3 py-2.5 rounded-lg border text-left transition-colors ${
              engine === "demucs"
                ? "border-gold-500/60 bg-gold-500/15"
                : demucsInstalled
                  ? "border-white/10 bg-white/[0.02] hover:border-gold-500/30"
                  : "border-white/[0.04] bg-white/[0.01] opacity-50 cursor-not-allowed"
            }`}
          >
            <div className={`text-[13px] ${engine === "demucs" ? "text-gold-200" : "text-zinc-200"}`}>
              Demucs (нейросеть)
              {!demucsInstalled && (
                <span className="ml-2 text-[9px] uppercase tracking-wide text-zinc-500">
                  не установлен
                </span>
              )}
            </div>
            <div className="text-[11px] text-zinc-500 mt-0.5">
              Медленнее (~10×), но точнее на сложных миксах.
            </div>
          </button>
        </div>
      </GlassCard>

      <GlassCard>
        <h2 className="text-sm font-semibold text-zinc-200 mb-3">Режим</h2>
        <div className="grid grid-cols-2 gap-2">
          {MODES.map((opt) => (
            <button
              key={opt.id}
              type="button"
              title={opt.hint}
              onClick={() => setMode(opt.id)}
              className={`px-3 py-2.5 rounded-lg border text-left transition-colors ${
                mode === opt.id
                  ? "border-gold-500/60 bg-gold-500/15"
                  : "border-white/10 bg-white/[0.02] hover:border-gold-500/30"
              }`}
            >
              <div className={`text-[13px] ${mode === opt.id ? "text-gold-200" : "text-zinc-200"}`}>
                {opt.label}
              </div>
              <div className="text-[11px] text-zinc-500 mt-0.5">
                {opt.hint}
              </div>
            </button>
          ))}
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
            <div className="flex-1 min-w-0 break-all">{error}</div>
          </div>
        </GlassCard>
      )}

      <OutputDirCard
        moduleId="vocal_split"
        moduleLabel="Голос / музыка"
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
