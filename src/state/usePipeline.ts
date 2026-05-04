import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  cancelTranscription,
  defaultSrtPath,
  listVideosInFolder,
  loadQueue,
  notify,
  onPipelineProgress,
  pickFolder,
  pickVideoFile,
  revealInShell,
  saveQueue,
  sidecarStatus,
  transcribeVideo,
} from "../lib/tauri";
import type {
  PipelineProgress,
  SidecarStatusInfo,
  TranscribeOptions,
  TranscribeResult,
} from "../lib/tauri";

export type Phase = "idle" | "running" | "done" | "error" | "cancelled";

export interface BatchItem {
  path: string;
  result: TranscribeResult | null;
  error: string | null;
  status: "pending" | "running" | "done" | "error" | "cancelled";
}

export interface PipelineState {
  phase: Phase;
  progress: PipelineProgress | null;
  result: TranscribeResult | null;
  error: string | null;
  videoPath: string | null;
  outputSrt: string | null;
  sidecar: SidecarStatusInfo | null;
  /** Pending or running queue of files. Filled by drop-folder / drop-many /
   * folder-picker; **not** auto-started — waits for the user to click
   * "Транскрибировать". */
  batch: BatchItem[] | null;
  batchIndex: number;
}

const initialState: PipelineState = {
  phase: "idle",
  progress: null,
  result: null,
  error: null,
  videoPath: null,
  outputSrt: null,
  sidecar: null,
  batch: null,
  batchIndex: 0,
};

type PipelineApi = ReturnType<typeof usePipelineState>;

const PipelineContext = createContext<PipelineApi | null>(null);

export function PipelineProvider({ children }: { children: ReactNode }) {
  const api = usePipelineState();
  return createElement(PipelineContext.Provider, { value: api }, children);
}

export function usePipeline(): PipelineApi {
  const ctx = useContext(PipelineContext);
  if (!ctx) {
    throw new Error("usePipeline must be used inside <PipelineProvider>");
  }
  return ctx;
}

function usePipelineState() {
  const [state, setState] = useState<PipelineState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mounted = useRef(true);
  const cancelRequested = useRef(false);

  const refreshSidecar = useCallback(async () => {
    try {
      const s = await sidecarStatus();
      if (mounted.current) setState((cur) => ({ ...cur, sidecar: s }));
    } catch {
      /* ignore */
    }
  }, []);

  const selectVideo = useCallback(async (path: string) => {
    try {
      const srt = await defaultSrtPath(path);
      setState((cur) => ({
        ...cur,
        videoPath: path,
        outputSrt: srt,
        result: null,
        error: null,
        progress: null,
        phase: "idle",
        batch: null,
        batchIndex: 0,
      }));
    } catch (err) {
      setState((cur) => ({ ...cur, error: String(err) }));
    }
  }, []);

  /** Fill the queue but don't start — the user must press "Транскрибировать". */
  const queueBatch = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    const items: BatchItem[] = paths.map((p) => ({
      path: p,
      result: null,
      error: null,
      status: "pending",
    }));
    setState({
      ...initialState,
      sidecar: stateRef.current.sidecar,
      batch: items,
      batchIndex: 0,
    });
  }, []);

  /** Append more files to the existing queue (or start one). De-dupes. */
  const appendToBatch = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setState((cur) => {
      const existing = cur.batch ?? [];
      const have = new Set(existing.map((b) => b.path));
      const incoming: BatchItem[] = paths
        .filter((p) => !have.has(p))
        .map((p) => ({ path: p, result: null, error: null, status: "pending" }));
      if (incoming.length === 0) return cur;
      // If we currently have a single-file selection (batch=null, videoPath set),
      // promote it to a queue first so the user doesn't lose it.
      let base: BatchItem[];
      if (existing.length > 0) {
        base = existing;
      } else if (cur.videoPath) {
        base = [
          { path: cur.videoPath, result: null, error: null, status: "pending" },
        ];
      } else {
        base = [];
      }
      return {
        ...cur,
        videoPath: null,
        outputSrt: null,
        result: null,
        error: null,
        progress: null,
        phase: "idle",
        batch: [...base, ...incoming.filter((i) => !base.some((b) => b.path === i.path))],
        batchIndex: 0,
      };
    });
  }, []);

  /** Reorder pending items via from→to indices. Won't move running/done. */
  const reorderBatch = useCallback((from: number, to: number) => {
    if (from === to) return;
    setState((cur) => {
      if (!cur.batch) return cur;
      const next = cur.batch.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...cur, batch: next };
    });
  }, []);

  /** Drop one file from the queue (only if it's not currently running). */
  const removeFromBatch = useCallback((index: number) => {
    setState((cur) => {
      if (!cur.batch) return cur;
      if (cur.phase === "running" && index === cur.batchIndex) return cur;
      const next = cur.batch.slice();
      next.splice(index, 1);
      if (next.length === 0) {
        return {
          ...initialState,
          sidecar: cur.sidecar,
        };
      }
      return { ...cur, batch: next };
    });
  }, []);

  const tryFolder = useCallback(
    async (folder: string) => {
      try {
        const videos = await listVideosInFolder(folder, false);
        if (videos.length === 0) {
          setState((cur) => ({
            ...cur,
            error: `В папке нет видео: ${folder}`,
          }));
          return;
        }
        if (videos.length === 1) {
          await selectVideo(videos[0]);
        } else {
          queueBatch(videos);
        }
      } catch (err) {
        setState((cur) => ({ ...cur, error: String(err) }));
      }
    },
    [selectVideo, queueBatch],
  );

  // Persistence: save *pending* paths whenever the queue changes, and
  // restore them on mount. We only keep the user's intent (paths in order),
  // not progress state — running/done/error are session-local.
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    const pending = state.batch
      ?.filter((b) => b.status === "pending")
      .map((b) => b.path) ?? [];
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      saveQueue(pending).catch((e) => console.warn("queue save failed", e));
    }, 250);
  }, [state.batch]);

  useEffect(() => {
    let cancelled = false;
    loadQueue()
      .then((paths) => {
        if (cancelled || paths.length === 0) return;
        if (stateRef.current.batch || stateRef.current.videoPath) return;
        const items: BatchItem[] = paths.map((p) => ({
          path: p,
          result: null,
          error: null,
          status: "pending",
        }));
        setState((cur) => ({ ...cur, batch: items, batchIndex: 0 }));
      })
      .catch((e) => console.warn("queue load failed", e));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    refreshSidecar();
    const id = window.setInterval(refreshSidecar, 2000);

    // StrictMode mounts the effect twice. The two `.then`s below resolve
    // *after* the first cleanup runs, so without an `aborted` guard the
    // first listener leaks (cleanup ran while unlisten was still null) and
    // every Tauri event fires our handler twice. Track ours explicitly:
    // if cleanup already ran, immediately unlisten the late arrival.
    let aborted = false;
    let unlistenProgress: (() => void) | null = null;

    onPipelineProgress((p) => {
      // eslint-disable-next-line no-console
      console.log("[pipeline progress]", p);
      setState((cur) => ({ ...cur, progress: p }));
    }).then((un) => {
      if (aborted) un();
      else unlistenProgress = un;
    });

    // Drop-into-window dispatch lives in each module instead of here, so
    // a single drop only feeds the *active* module (Subtitles when its
    // tab is open, CorridorKey when its tab is, etc.). Otherwise the
    // same files would land in every module's queue at once.

    return () => {
      aborted = true;
      mounted.current = false;
      window.clearInterval(id);
      unlistenProgress?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSidecar]);

  const browse = useCallback(async () => {
    const path = await pickVideoFile();
    if (path) await selectVideo(path);
  }, [selectVideo]);

  const browseFolder = useCallback(async () => {
    const folder = await pickFolder();
    if (folder) await tryFolder(folder);
  }, [tryFolder]);

  const transcribeOne = useCallback(
    async (videoPath: string, outputSrt: string, opts?: TranscribeOptions) => {
      cancelRequested.current = false;
      setState((cur) => ({
        ...cur,
        phase: "running",
        result: null,
        error: null,
        progress: { stage: "Подготовка", detail: null, pos: 0, total: 0 },
      }));
      try {
        const result = await transcribeVideo(videoPath, outputSrt, opts);
        setState((cur) => ({ ...cur, phase: "done", result, error: null }));
        return { ok: true as const, result };
      } catch (err) {
        const msg = String(err);
        const cancelled =
          cancelRequested.current ||
          msg.includes("Прервано") ||
          msg.includes("cancelled");
        setState((cur) => ({
          ...cur,
          phase: cancelled ? "cancelled" : "error",
          error: cancelled ? null : msg,
        }));
        return { ok: false as const, cancelled, error: msg };
      } finally {
        cancelRequested.current = false;
      }
    },
    [],
  );

  const runBatch = useCallback(
    async (paths: string[], opts?: TranscribeOptions) => {
      for (let i = 0; i < paths.length; i++) {
        if (cancelRequested.current) break;
        const path = paths[i];
        const srt = await defaultSrtPath(path);
        setState((cur) => ({
          ...cur,
          videoPath: path,
          outputSrt: srt,
          batchIndex: i,
          batch:
            cur.batch?.map((b, idx) =>
              idx === i ? { ...b, status: "running" } : b,
            ) ?? null,
        }));
        const out = await transcribeOne(path, srt, opts);
        setState((cur) => ({
          ...cur,
          batch:
            cur.batch?.map((b, idx) =>
              idx === i
                ? {
                    ...b,
                    status: out.ok
                      ? "done"
                      : out.cancelled
                        ? "cancelled"
                        : "error",
                    result: out.ok ? out.result : null,
                    error: out.ok ? null : out.error,
                  }
                : b,
            ) ?? null,
        }));
        if (!out.ok && out.cancelled) break;
      }
    },
    [transcribeOne],
  );

  const transcribe = useCallback(
    async (opts?: TranscribeOptions) => {
      const cur = stateRef.current;
      if (cur.batch && cur.batch.length > 0) {
        await runBatch(
          cur.batch.map((b) => b.path),
          opts,
        );
        const after = stateRef.current.batch ?? [];
        const done = after.filter((b) => b.status === "done").length;
        const errs = after.filter((b) => b.status === "error").length;
        const total = after.length;
        if (!cancelRequested.current) {
          await notify(
            "Zonthor Studio — очередь готова",
            errs > 0
              ? `${done} из ${total} · ошибок: ${errs}`
              : `${done} из ${total} файлов обработано`,
          );
        }
        return;
      }
      if (cur.videoPath && cur.outputSrt) {
        const r = await transcribeOne(cur.videoPath, cur.outputSrt, opts);
        if (r.ok) {
          const name = cur.videoPath.split("/").pop() ?? cur.videoPath;
          await notify("Zonthor Studio — готово", name);
        }
      }
    },
    [runBatch, transcribeOne],
  );

  const cancel = useCallback(async () => {
    cancelRequested.current = true;
    try {
      await cancelTranscription();
    } catch (err) {
      console.error(err);
    }
  }, []);

  const reset = useCallback(() => {
    setState((cur) => ({
      ...initialState,
      sidecar: cur.sidecar,
    }));
  }, []);

  const reveal = useCallback(async (path: string) => {
    try {
      await revealInShell(path);
    } catch (err) {
      console.error(err);
    }
  }, []);

  return {
    state,
    browse,
    browseFolder,
    transcribe,
    cancel,
    reset,
    reveal,
    selectVideo,
    appendToBatch,
    reorderBatch,
    removeFromBatch,
  };
}
