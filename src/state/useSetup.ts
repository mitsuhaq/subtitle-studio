import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelDownload,
  downloadFfmpeg,
  downloadWhisper,
  onProgress,
  onStatus,
  openDataDir,
  pickFfmpeg,
  pickFfmpegFile,
  setupStatus,
} from "../lib/tauri";
import type {
  Component,
  ProgressPayload,
  SetupStatus,
} from "../lib/tauri";

type Phase = "idle" | "running" | "done" | "error" | "cancelled";

interface PerComponent {
  phase: Phase;
  progress: ProgressPayload | null;
  error: string | null;
}

const initial: PerComponent = { phase: "idle", progress: null, error: null };

export function useSetup() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [whisper, setWhisper] = useState<PerComponent>(initial);
  const [ffmpeg, setFfmpeg] = useState<PerComponent>(initial);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await setupStatus();
      if (mounted.current) setStatus(s);
    } catch (err) {
      console.error("setup_status failed", err);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const unsubs: Array<Promise<() => void>> = [
      onProgress((p) => {
        const setter = p.component === "whisper" ? setWhisper : setFfmpeg;
        setter((cur) => ({
          ...cur,
          phase: p.stage === "Готово" ? "done" : "running",
          progress: p,
          error: null,
        }));
      }),
      onStatus((s) => setStatus(s)),
    ];
    return () => {
      mounted.current = false;
      unsubs.forEach((u) => u.then((fn) => fn()).catch(() => undefined));
    };
  }, [refresh]);

  const startWhisper = useCallback(async () => {
    setWhisper({ phase: "running", progress: null, error: null });
    try {
      const s = await downloadWhisper();
      setStatus(s);
      setWhisper((c) => ({ ...c, phase: "done" }));
    } catch (err) {
      const msg = String(err);
      setWhisper({
        phase: msg.includes("отменена") ? "cancelled" : "error",
        progress: null,
        error: msg,
      });
    }
  }, []);

  const startFfmpeg = useCallback(async () => {
    setFfmpeg({ phase: "running", progress: null, error: null });
    try {
      const s = await downloadFfmpeg();
      setStatus(s);
      setFfmpeg((c) => ({ ...c, phase: "done" }));
    } catch (err) {
      const msg = String(err);
      setFfmpeg({
        phase: msg.includes("отменена") ? "cancelled" : "error",
        progress: null,
        error: msg,
      });
    }
  }, []);

  const cancel = useCallback(async (component: Component) => {
    try {
      await cancelDownload(component);
    } catch (err) {
      console.error("cancel failed", err);
    }
  }, []);

  const browseFfmpeg = useCallback(async () => {
    const path = await pickFfmpegFile();
    if (!path) return;
    try {
      const s = await pickFfmpeg(path);
      setStatus(s);
    } catch (err) {
      setFfmpeg({ phase: "error", progress: null, error: String(err) });
    }
  }, []);

  const reveal = useCallback(async () => {
    try {
      await openDataDir();
    } catch (err) {
      console.error(err);
    }
  }, []);

  return {
    status,
    whisper,
    ffmpeg,
    refresh,
    startWhisper,
    startFfmpeg,
    cancel,
    browseFfmpeg,
    reveal,
  };
}
