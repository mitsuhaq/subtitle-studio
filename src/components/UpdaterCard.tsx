import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { GlassCard } from "./GlassCard";
import { ProgressBar } from "./ProgressBar";
import {
  PixelCheck,
  PixelDownload,
  PixelRefresh,
  PixelSparkles,
  PixelX,
} from "./icons";

type Phase = "idle" | "checking" | "ready" | "downloading" | "installed" | "uptodate" | "error";

export function UpdaterCard() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [current, setCurrent] = useState<string>("…");
  const [update, setUpdate] = useState<Update | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setCurrent)
      .catch(() => setCurrent("?"));
  }, []);

  const doCheck = async () => {
    setError(null);
    setUpdate(null);
    setPhase("checking");
    try {
      const u = await check();
      if (!u) {
        setPhase("uptodate");
        return;
      }
      setUpdate(u);
      setPhase("ready");
    } catch (e) {
      setError(formatErr(e));
      setPhase("error");
    }
  };

  const doInstall = async () => {
    if (!update) return;
    setError(null);
    setDownloaded(0);
    setTotal(0);
    setPhase("downloading");
    try {
      await update.downloadAndInstall((event) => {
        // tauri-plugin-updater fires "Started → Progress* → Finished"
        if (event.event === "Started") {
          setTotal(event.data.contentLength ?? 0);
          setDownloaded(0);
        } else if (event.event === "Progress") {
          setDownloaded((d) => d + event.data.chunkLength);
        } else if (event.event === "Finished") {
          setPhase("installed");
        }
      });
      // Restart so the new binary picks up.
      await relaunch();
    } catch (e) {
      setError(formatErr(e));
      setPhase("error");
    }
  };

  return (
    <GlassCard>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
            <PixelSparkles size={14} className="text-gold-300" />
            Обновления
          </h3>
          <p className="text-sm text-zinc-400 mt-1">
            Текущая версия:{" "}
            <code className="text-gold-200/90">{current}</code>
            {update && (
              <>
                {" · "}
                новая:{" "}
                <span className="text-gold-300">{update.version}</span>
              </>
            )}
          </p>
          {update?.body && (
            <pre className="mt-2 text-[11px] text-zinc-400 whitespace-pre-wrap max-h-32 overflow-auto bg-white/[0.03] border border-white/[0.05] rounded p-2">
              {update.body}
            </pre>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(phase === "idle" ||
            phase === "uptodate" ||
            phase === "error" ||
            phase === "installed") && (
            <button className="btn-ghost" onClick={doCheck}>
              <PixelRefresh size={16} />
              Проверить
            </button>
          )}
          {phase === "checking" && (
            <button className="btn-ghost" disabled>
              Проверяем…
            </button>
          )}
          {phase === "ready" && (
            <button className="btn-primary" onClick={doInstall}>
              <PixelDownload size={16} />
              Установить
            </button>
          )}
          {phase === "downloading" && (
            <button className="btn-ghost" disabled>
              Скачиваем…
            </button>
          )}
        </div>
      </div>

      {phase === "downloading" && (
        <div className="mt-4">
          <ProgressBar
            value={downloaded}
            total={total}
            label={
              total
                ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
                : "—"
            }
            pulsing={!total}
          />
        </div>
      )}

      {phase === "uptodate" && (
        <div className="mt-4 text-sm text-zinc-300 bg-white/[0.04] border border-white/10 rounded-xl p-3 flex items-center gap-2">
          <PixelCheck size={14} className="text-gold-300" />У вас последняя
          версия.
        </div>
      )}

      {phase === "installed" && (
        <div className="mt-4 text-sm text-gold-200 bg-gold-500/10 border border-gold-500/30 rounded-xl p-3 flex items-center gap-2">
          <PixelCheck size={14} />
          Обновление установлено. Перезапускаем…
        </div>
      )}

      {phase === "error" && error && (
        <div className="mt-4 text-sm text-red-300/90 bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
          <PixelX size={14} className="text-red-300 mt-0.5 shrink-0" />
          <div className="break-all">{error}</div>
        </div>
      )}
    </GlassCard>
  );
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} Б`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} КБ`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} МБ`;
  return `${(mb / 1024).toFixed(2)} ГБ`;
}
