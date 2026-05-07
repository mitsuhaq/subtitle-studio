import { useState } from "react";
import { useUpdater } from "../state/updater";
import { PixelArrowRight, PixelDownload, PixelSparkles, PixelX } from "./icons";

/**
 * Floating top banner that appears when a new version is detected by the
 * silent hourly poller. Click "Установить" to start the download (which is
 * driven by the same UpdaterProvider that powers UpdaterCard, so progress
 * stays visible there). "Позже" hides the banner until the next time a
 * *different* version is discovered.
 */
export function UpdateBanner() {
  const { update, phase, bannerDismissed, install, dismissBanner } =
    useUpdater();
  const [expanded, setExpanded] = useState(false);

  const visible =
    !!update &&
    !bannerDismissed &&
    (phase === "ready" || phase === "downloading" || phase === "installed");
  if (!visible) return null;

  // GitHub release notes ride along on `update.body`; only offer the
  // expand toggle when there's something to expand to.
  const hasNotes = !!update!.body && update!.body.trim().length > 0;

  return (
    <div className="absolute inset-x-0 top-0 z-30 flex justify-center pointer-events-none px-4 pt-3">
      <div className="pointer-events-auto max-w-xl w-full bg-gold-500/[0.08] border border-gold-500/40 backdrop-blur-xl rounded-xl shadow-goldStrong">
        <div className="flex items-center gap-3 px-4 py-3">
          <PixelSparkles size={16} className="text-gold-300 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-zinc-100">
              Доступно обновление{" "}
              <span className="text-gold-200">v{update!.version}</span>
            </div>
            <div className="text-[11px] text-zinc-400 truncate">
              {phase === "downloading"
                ? "Скачивание…"
                : phase === "installed"
                  ? "Установлено, перезапуск…"
                  : hasNotes
                    ? "Жми «Подробнее» — посмотреть что нового."
                    : "Можно установить — приложение перезапустится автоматически."}
            </div>
          </div>
          {hasNotes && phase === "ready" && (
            <button
              type="button"
              onClick={() => setExpanded((s) => !s)}
              className="text-[11px] text-gold-200/90 hover:text-gold-100 underline-offset-2 hover:underline shrink-0 flex items-center gap-1"
            >
              <span>{expanded ? "Свернуть" : "Подробнее"}</span>
              <PixelArrowRight
                size={10}
                className={`transition-transform ${expanded ? "rotate-90" : ""}`}
              />
            </button>
          )}
          {phase === "ready" && (
            <button className="btn-primary !py-1.5 !px-3" onClick={install}>
              <PixelDownload size={14} />
              <span>Установить</span>
            </button>
          )}
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="Скрыть"
            className="text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded-md"
          >
            <PixelX size={14} />
          </button>
        </div>
        {expanded && hasNotes && (
          <div className="px-4 pb-3 pt-1 border-t border-gold-500/20">
            <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap leading-relaxed max-h-72 overflow-auto bg-bg-950/40 border border-white/[0.05] rounded-lg p-3">
              {update!.body}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
