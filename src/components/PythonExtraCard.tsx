import { useEffect, useState } from "react";
import { GlassCard } from "./GlassCard";
import { ProgressBar } from "./ProgressBar";
import { PixelSpinner } from "./PixelSpinner";
import { PixelCheck, PixelCircle, PixelDownload, PixelX } from "./icons";
import {
  cancelPythonExtra,
  installPythonExtra,
  onProgress,
  pythonExtraStatus,
  uninstallPythonExtra,
} from "../lib/tauri";
import type {
  ProgressPayload,
  PythonExtraDef,
  PythonExtraStatus,
} from "../lib/tauri";
import { formatBytes } from "../lib/format";
import { useModules } from "../state/modules";
import type { ModuleId } from "../state/modules";

type Phase = "idle" | "running" | "done" | "error";

interface Props {
  def: PythonExtraDef;
}

/**
 * Setup card for a Python-venv ML extra (Demucs etc). Same UX shell as
 * ExtraComponentCard but talks to install_python_extra / uninstall etc.
 * Adds a "Удалить" button because these extras eat ~1 GB of disk and
 * users will want to free that without uninstalling the whole app.
 */
export function PythonExtraCard({ def }: Props) {
  const { setAvailability } = useModules();
  const [status, setStatus] = useState<PythonExtraStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const routingKey = `py:${def.id}`;

  const syncAvailability = (installed: boolean) => {
    if (def.gates_modules) {
      def.module_ids.forEach((m) =>
        setAvailability(m as ModuleId, installed),
      );
    }
  };

  const refresh = () => {
    pythonExtraStatus(def.id)
      .then((s) => {
        setStatus(s);
        // Gating extras (e.g. OmniVoice for the voice_clone module) flip
        // their dependent modules' availability so the drawer locks /
        // unlocks the entry. Enhancing extras (Demucs adding a mode to
        // an otherwise-functional Vocal Split) skip this — Vocal Split
        // already works without them.
        syncAvailability(s.installed);
      })
      .catch(() => {});
  };

  useEffect(refresh, [def.id]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let aborted = false;
    onProgress((p) => {
      if (p.component !== routingKey) return;
      setProgress(p);
      if (p.stage === "Готово") {
        setPhase("done");
        // Re-poll on completion so availability flips on. Without this
        // the badge says "installed" (because we set it locally below)
        // but the drawer's lock doesn't lift, since `setAvailability`
        // never sees the change.
        refresh();
      } else if (p.stage === "Удалено") {
        setPhase("idle");
        refresh();
      } else {
        setPhase("running");
      }
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
    setProgress(null);
    try {
      const s = await installPythonExtra(def.id);
      setStatus(s);
      syncAvailability(s.installed);
      setPhase("done");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  const stop = () => {
    cancelPythonExtra(def.id).catch(() => {});
  };

  const remove = async () => {
    if (!confirm(`Удалить ${def.name}? Освободится ~${formatBytes(status?.size_bytes ?? def.size_bytes_hint)}`))
      return;
    try {
      await uninstallPythonExtra(def.id);
      syncAvailability(false);
      refresh();
      setPhase("idle");
    } catch (e) {
      setError(String(e));
    }
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
          </div>
          <p className="text-sm text-zinc-400 mt-1">{def.hint}</p>
          {installed && status && status.size_bytes > 0 && (
            <div className="mt-1 text-[11px] text-zinc-500">
              {formatBytes(status.size_bytes)} · Python {def.python_version}
            </div>
          )}
          {status?.message && (
            <div className="mt-2 text-[11px] text-zinc-500 whitespace-pre-line">
              {status.message}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {running ? (
            <button className="btn-ghost" onClick={stop}>
              <PixelX size={16} />
              Отменить
            </button>
          ) : installed ? (
            <>
              <button className="btn-ghost" onClick={remove}>
                <PixelX size={16} />
                Удалить
              </button>
              <button className="btn-primary" onClick={start}>
                <PixelDownload size={16} />
                Перезагрузить
              </button>
            </>
          ) : (
            <button className="btn-primary" onClick={start}>
              <PixelDownload size={16} />
              Скачать
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
        <div className="mt-4 text-sm text-red-300/90 bg-red-500/10 border border-red-500/30 rounded-xl p-3 whitespace-pre-line">
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
