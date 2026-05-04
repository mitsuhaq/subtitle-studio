import { useEffect, useState } from "react";
import { GlassCard } from "./GlassCard";
import { PixelFolder, PixelX } from "./icons";
import { getSettings, pickFolder, setModuleOutputDir } from "../lib/tauri";

interface Props {
  moduleId: string;
  /** Localised module name shown in the placeholder copy. */
  moduleLabel?: string;
  /** Disable the picker buttons (e.g. while a job is running). */
  disabled?: boolean;
}

/**
 * Per-module output folder picker. Reads/writes
 * `Settings.module_output_dirs[moduleId]` via Tauri commands. When unset,
 * the module saves results next to the source video.
 */
export function OutputDirCard({ moduleId, moduleLabel, disabled }: Props) {
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((s) => {
        if (cancelled) return;
        const map = s.module_output_dirs ?? {};
        setDir(map[moduleId] ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  const pick = async () => {
    const folder = await pickFolder();
    if (!folder) return;
    setBusy(true);
    try {
      const next = await setModuleOutputDir(moduleId, folder);
      setDir(next.module_output_dirs?.[moduleId] ?? null);
    } catch (err) {
      console.error("set module output dir failed", err);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const next = await setModuleOutputDir(moduleId, null);
      setDir(next.module_output_dirs?.[moduleId] ?? null);
    } catch (err) {
      console.error("clear module output dir failed", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassCard>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">
            Папка для сохранения{moduleLabel ? ` · ${moduleLabel}` : ""}
          </div>
          <div className="text-[12px] text-zinc-300 mt-1 break-all">
            {dir ? (
              <code className="text-gold-200/90">{dir}</code>
            ) : (
              <span className="text-zinc-500">
                Рядом с исходным видео (по умолчанию)
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="btn-ghost"
            onClick={pick}
            disabled={busy || disabled}
          >
            <PixelFolder size={14} />
            <span>Выбрать…</span>
          </button>
          {dir && (
            <button
              className="btn-ghost"
              onClick={clear}
              disabled={busy || disabled}
            >
              <PixelX size={12} />
              <span>Сбросить</span>
            </button>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
