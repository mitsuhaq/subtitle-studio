import { useUpdater } from "../state/updater";
import { PixelDownload, PixelSparkles, PixelX } from "./icons";

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

  const visible =
    !!update &&
    !bannerDismissed &&
    (phase === "ready" || phase === "downloading" || phase === "installed");
  if (!visible) return null;

  return (
    <div className="absolute inset-x-0 top-0 z-30 flex justify-center pointer-events-none px-4 pt-3">
      <div className="pointer-events-auto max-w-xl w-full bg-gold-500/[0.08] border border-gold-500/40 backdrop-blur-xl rounded-xl px-4 py-3 shadow-goldStrong flex items-center gap-3">
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
                : "Можно установить — приложение перезапустится автоматически."}
          </div>
        </div>
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
    </div>
  );
}
