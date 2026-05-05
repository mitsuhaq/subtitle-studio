import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { notify } from "../lib/tauri";

/// First check waits this long after launch — long enough for the sidecar
/// to finish booting so a "checking…" toast doesn't compete with setup UI.
const STARTUP_DELAY_MS = 5_000;
/// Re-check cadence while the app stays open.
const POLL_INTERVAL_MS = 60 * 60 * 1_000;

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "ready"
  | "downloading"
  | "installed"
  | "uptodate"
  | "error";

interface UpdaterCtx {
  phase: UpdaterPhase;
  current: string;
  update: Update | null;
  /** Set to true once we've already auto-shown the banner for this update;
   *  user can dismiss it but the banner won't keep popping up on re-checks. */
  bannerDismissed: boolean;
  downloaded: number;
  total: number;
  error: string | null;
  manualCheck: () => Promise<void>;
  install: () => Promise<void>;
  dismissBanner: () => void;
}

const Ctx = createContext<UpdaterCtx | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [current, setCurrent] = useState<string>("…");
  const [update, setUpdate] = useState<Update | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Tracks the version we already notified about so we don't ding the user
  // again on the next hourly poll if the same update is still pending.
  const notifiedVersion = useRef<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setCurrent)
      .catch(() => setCurrent("?"));
  }, []);

  const runCheck = useCallback(async (silent: boolean) => {
    if (!silent) {
      setError(null);
      setPhase("checking");
    }
    try {
      const u = await check();
      if (!u) {
        if (!silent) setPhase("uptodate");
        return;
      }
      setUpdate(u);
      setPhase("ready");
      // Only ding + show banner the first time we discover this version.
      if (notifiedVersion.current !== u.version) {
        notifiedVersion.current = u.version;
        setBannerDismissed(false);
        if (silent) {
          notify(
            "Zonthor Studio — есть обновление",
            `Доступна версия ${u.version}`,
          );
        }
      }
    } catch (e) {
      // Silent checks must not spam errors into the UI — the user didn't ask.
      if (!silent) {
        setError(formatErr(e));
        setPhase("error");
      } else {
        console.warn("[updater] silent check failed:", e);
      }
    }
  }, []);

  // Startup + hourly poll. Single effect, single interval, cleared on unmount.
  useEffect(() => {
    const startupTimer = window.setTimeout(() => {
      runCheck(true);
    }, STARTUP_DELAY_MS);
    const pollTimer = window.setInterval(() => {
      runCheck(true);
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(pollTimer);
    };
  }, [runCheck]);

  const manualCheck = useCallback(() => runCheck(false), [runCheck]);

  const install = useCallback(async () => {
    if (!update) return;
    setError(null);
    setDownloaded(0);
    setTotal(0);
    setPhase("downloading");
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setTotal(event.data.contentLength ?? 0);
          setDownloaded(0);
        } else if (event.event === "Progress") {
          setDownloaded((d) => d + event.data.chunkLength);
        } else if (event.event === "Finished") {
          setPhase("installed");
        }
      });
      await relaunch();
    } catch (e) {
      setError(formatErr(e));
      setPhase("error");
    }
  }, [update]);

  const dismissBanner = useCallback(() => setBannerDismissed(true), []);

  return (
    <Ctx.Provider
      value={{
        phase,
        current,
        update,
        bannerDismissed,
        downloaded,
        total,
        error,
        manualCheck,
        install,
        dismissBanner,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useUpdater(): UpdaterCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUpdater must be used inside UpdaterProvider");
  return v;
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
