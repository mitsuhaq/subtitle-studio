import { useEffect, useRef, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import {
  PixelArrowRight,
  PixelCheck,
  PixelDownload,
  PixelFolder,
  PixelRefresh,
  PixelScissors,
  PixelSparkles,
  PixelUpload,
  PixelX,
} from "../components/icons";
import { ModuleGate } from "../components/SideDrawer";
import { OutputDirCard } from "../components/OutputDirCard";
import { useModuleDrop } from "../state/useModuleDrop";
import {
  chromaKeyCancel,
  chromaKeyRun,
  notify,
  onChromaProgress,
  pickVideoFile,
  revealInShell,
  VIDEO_EXTS,
} from "../lib/tauri";
import type {
  ChromaBackgroundKind,
  ChromaOptions,
  ChromaProgress,
  ChromaResult,
} from "../lib/tauri";

const isVideoPath = (p: string) =>
  VIDEO_EXTS.some((ext) => p.toLowerCase().endsWith(`.${ext}`));

type Phase = "idle" | "running" | "done" | "error" | "cancelled";

const BG_KINDS: { id: ChromaBackgroundKind; label: string; hint: string }[] = [
  { id: "transparent", label: "Прозрачный", hint: "Сохранить с альфа-каналом" },
  { id: "color", label: "Цвет", hint: "Сплошной цвет фона" },
  { id: "image", label: "Картинка", hint: "Композитинг на изображение" },
  { id: "video", label: "Видео", hint: "Композитинг на ролик" },
];

export default function RotobrushModule() {
  return (
    <ModuleGate moduleId="rotobrush">
      <RotobrushInner />
    </ModuleGate>
  );
}

function RotobrushInner() {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [bgKind, setBgKind] = useState<ChromaBackgroundKind>("transparent");
  const [bgColor, setBgColor] = useState<string>("#000000");
  const [bgPath, setBgPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ChromaProgress | null>(null);
  const [result, setResult] = useState<ChromaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useModuleDrop("rotobrush", (paths) => {
    const v = paths.find(isVideoPath);
    if (v) setVideoPath(v);
  });

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;
    onChromaProgress((p) => setProgress(p)).then((un) => {
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
    !!videoPath &&
    phase !== "running" &&
    (bgKind !== "image" && bgKind !== "video" ? true : !!bgPath);

  const run = async () => {
    if (!videoPath) return;
    setPhase("running");
    setProgress(null);
    setError(null);
    setResult(null);
    const opts: ChromaOptions = {
      background_kind: bgKind,
      background_color: bgKind === "color" ? bgColor : null,
      background_path:
        bgKind === "image" || bgKind === "video" ? bgPath : null,
      mode: "rotobrush",
    };
    try {
      const r = await chromaKeyRun(videoPath, opts);
      setResult(r);
      setPhase("done");
      const name = r.output_video.split("/").pop() ?? r.output_video;
      await notify("Zonthor Studio — ротоскоп готов", name);
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
    chromaKeyCancel().catch(() => {});
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
              <PixelScissors size={16} className="text-gold-300" />
              Rotobrush — вырезать человека с любого фона
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              Та же RVM-нейросеть, но без агрессивных правок зелёного. Подходит
              для произвольного фона — улицы, комнаты, природы.
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
          Чем заменить фон
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {BG_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setBgKind(k.id)}
              className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
                bgKind === k.id
                  ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                  : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
              }`}
            >
              <div className="text-[13px] font-medium">{k.label}</div>
              <div className="text-[10px] text-zinc-500 mt-1">{k.hint}</div>
            </button>
          ))}
        </div>

        {bgKind === "color" && (
          <div className="mt-4 flex items-center gap-3">
            <span className="text-xs text-zinc-500">Цвет</span>
            <input
              type="color"
              value={bgColor}
              onChange={(e) => setBgColor(e.target.value)}
              className="w-9 h-7 rounded border border-white/10 bg-transparent cursor-pointer"
            />
            <input
              type="text"
              value={bgColor}
              onChange={(e) => setBgColor(e.target.value)}
              className="w-24 bg-bg-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-gold-500/50"
            />
          </div>
        )}

        {(bgKind === "image" || bgKind === "video") && (
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <button
              className="btn-ghost"
              onClick={async () => {
                const p = await pickVideoFile();
                if (p) setBgPath(p);
              }}
            >
              <PixelFolder size={14} />
              {bgPath ? "Заменить файл" : "Выбрать файл"}
            </button>
            {bgPath && (
              <code className="text-[11px] text-gold-200/80 break-all">
                {bgPath}
              </code>
            )}
          </div>
        )}
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
            label={progress?.total ? `${progress.pos.toFixed(0)} / ${progress.total.toFixed(0)}` : "—"}
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

      <OutputDirCard moduleId="rotobrush" moduleLabel="Rotobrush" disabled={phase === "running"} />

      <GlassCard className="text-[11px] text-zinc-500">
        <div className="flex items-center gap-2">
          <PixelDownload size={12} />
          Чистый RVM matting — без despill и без chromakey-препроцесса. Зелёная
          одежда / трава на сабжекте сохранится. На сложных фонах могут быть
          ошибки — RVM лучше всего работает по людям.
        </div>
      </GlassCard>
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
