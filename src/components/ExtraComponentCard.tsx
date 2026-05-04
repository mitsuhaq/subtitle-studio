import { useEffect, useState } from "react";
import { GlassCard } from "./GlassCard";
import { ProgressBar } from "./ProgressBar";
import { PixelSpinner } from "./PixelSpinner";
import {
  PixelCheck,
  PixelCircle,
  PixelDownload,
  PixelX,
} from "./icons";
import {
  cancelExtra,
  downloadExtra,
  extraStatus,
  onProgress,
} from "../lib/tauri";
import type {
  ComponentStatusInfo,
  ExtraComponentDef,
  ProgressPayload,
} from "../lib/tauri";
import { formatBytes } from "../lib/format";
import { useModules } from "../state/modules";
import type { ModuleId } from "../state/modules";

type Phase = "idle" | "running" | "done" | "error";

interface Props {
  def: ExtraComponentDef;
}

/**
 * Install/uninstall card for an extra component (neural-net model). Shares
 * the setup://progress event channel with the built-in Whisper/FFmpeg cards;
 * we filter by the `extra:<id>` routing key the backend emits.
 */
export function ExtraComponentCard({ def }: Props) {
  const { setAvailability } = useModules();
  const [status, setStatus] = useState<ComponentStatusInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const routingKey = `extra:${def.id}`;
  const available = def.url.length > 0;

  // Initial status + sync availability into useModules so the drawer can
  // unlock the matching module immediately on mount.
  useEffect(() => {
    let cancelled = false;
    extraStatus(def.id)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        def.module_ids.forEach((m) =>
          setAvailability(m as ModuleId, s.installed),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [def.id, def.module_ids, setAvailability]);

  // Stream progress for THIS extra only.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let aborted = false;
    onProgress((p) => {
      if (p.component !== routingKey) return;
      setProgress(p);
      if (p.stage === "Готово") setPhase("done");
      else setPhase("running");
    }).then((un) => {
      if (aborted) un();
      else unlisten = un;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [routingKey]);

  const start = async () => {
    setError(null);
    setPhase("running");
    try {
      const s = await downloadExtra(def.id);
      setStatus(s);
      def.module_ids.forEach((m) =>
          setAvailability(m as ModuleId, s.installed),
        );
      setPhase("done");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  const stop = () => {
    cancelExtra(def.id).catch(() => {});
  };

  const installed = !!status?.installed;
  const running = phase === "running";

  return (
    <GlassCard>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge installed={installed} running={running} error={!!error} />
            <h3 className="text-base font-semibold text-zinc-100">
              {def.name}
            </h3>
            {!available && (
              <span className="text-[9px] uppercase tracking-wide text-zinc-500 px-1.5 py-0.5 border border-white/[0.06] rounded">
                скоро
              </span>
            )}
          </div>
          <p className="text-sm text-zinc-400 mt-1">{def.hint}</p>
          {status?.path && (
            <code className="block mt-2 text-[11px] text-zinc-500 break-all">
              {status.path}
            </code>
          )}
          {installed && status && status.size_bytes > 0 && (
            <div className="mt-1 text-[11px] text-zinc-500">
              {formatBytes(status.size_bytes)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {running ? (
            <button className="btn-ghost" onClick={stop}>
              <PixelX size={16} />
              Отменить
            </button>
          ) : (
            <button
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={start}
              disabled={!available}
              title={
                !available
                  ? "Модель ещё не доступна"
                  : installed
                    ? "Перезагрузить"
                    : "Скачать"
              }
            >
              <PixelDownload size={16} />
              {installed ? "Перезагрузить" : "Скачать"}
            </button>
          )}
        </div>
      </div>

      {running && (
        <div className="mt-5 space-y-2">
          <div className="text-[12px] text-zinc-300 flex items-center gap-2">
            <PixelSpinner className="text-gold-300" size={14} />
            <span>{progress?.stage ?? "Подготовка"}</span>
          </div>
          <ProgressBar
            value={progress?.grand_downloaded ?? 0}
            total={progress?.grand_total ?? def.size_bytes_hint}
            label={
              progress?.grand_total
                ? `${formatBytes(progress.grand_downloaded)} / ${formatBytes(progress.grand_total)}`
                : `~${formatBytes(def.size_bytes_hint)}`
            }
            pulsing={!progress?.grand_total}
          />
        </div>
      )}

      {phase === "error" && error && (
        <div className="mt-4 text-sm text-red-300/90 bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          {error}
        </div>
      )}
    </GlassCard>
  );
}

function Badge({
  installed,
  running,
  error,
}: {
  installed: boolean;
  running: boolean;
  error: boolean;
}) {
  if (running) return <PixelSpinner className="text-gold-300" size={14} />;
  if (error) return <PixelX size={14} className="text-red-400" />;
  if (installed) return <PixelCheck size={14} className="text-gold-300" />;
  return <PixelCircle size={14} className="text-zinc-600" />;
}
