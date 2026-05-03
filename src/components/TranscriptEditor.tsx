import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_STYLE,
  getSettings,
  notify,
  readSrt,
  reburnVideo,
  revealInShell,
  writeSrt,
} from "../lib/tauri";
import type { SrtCue } from "../lib/tauri";
import { PixelCheck, PixelFolder, PixelRefresh, PixelX } from "./icons";

interface Props {
  open: boolean;
  srtPath: string | null;
  /** If set, "Сохранить и перевшить" is available — re-runs FFmpeg burn-in on
   *  this video using the latest SRT. Without it only SRT save is offered. */
  videoPath?: string | null;
  onClose: () => void;
  /** Optional callback fired after a successful save (e.g. for a re-burn flow). */
  onSaved?: () => void;
}

/**
 * Modal cue-list editor for an existing `.srt`. Read-only on timestamps —
 * editing those is a different problem (would have to re-derive cue groups
 * from word timings). Text edits round-trip via the backend `write_srt`
 * which writes atomically (`.srt.tmp` → rename).
 */
export function TranscriptEditor({
  open,
  srtPath,
  videoPath,
  onClose,
  onSaved,
}: Props) {
  const [cues, setCues] = useState<SrtCue[]>([]);
  const [original, setOriginal] = useState<SrtCue[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reburning, setReburning] = useState(false);
  const [reburnedPath, setReburnedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load on open / path change
  useEffect(() => {
    if (!open || !srtPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    readSrt(srtPath)
      .then((list) => {
        if (cancelled) return;
        setCues(list);
        setOriginal(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, srtPath]);

  // Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const dirty = JSON.stringify(cues) !== JSON.stringify(original);

  const setText = (i: number, text: string) =>
    setCues((cur) => cur.map((c, idx) => (idx === i ? { ...c, text } : c)));

  const remove = (i: number) =>
    setCues((cur) => cur.filter((_, idx) => idx !== i));

  const save = async (): Promise<boolean> => {
    if (!srtPath) return false;
    setSaving(true);
    setError(null);
    try {
      // Re-index so the .srt has 1, 2, 3, ... after deletions.
      const reindexed = cues.map((c, i) => ({ ...c, index: i + 1 }));
      await writeSrt(srtPath, reindexed);
      setOriginal(reindexed);
      setCues(reindexed);
      onSaved?.();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveAndReburn = async () => {
    if (!srtPath || !videoPath) return;
    setReburnedPath(null);
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    setReburning(true);
    setError(null);
    try {
      const settings = await getSettings();
      const style = settings.last_style ?? DEFAULT_STYLE;
      const out = await reburnVideo(videoPath, srtPath, style);
      setReburnedPath(out);
      const name = out.split("/").pop() ?? out;
      await notify("Subtitle Studio — перевшито", name);
    } catch (e) {
      setError(String(e));
    } finally {
      setReburning(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[min(880px,94vw)] h-[min(720px,90vh)] flex flex-col rounded-2xl border border-white/10 bg-bg-900/95 backdrop-blur-xl shadow-2xl shadow-black/60 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/[0.06]">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100">
              Редактор транскрипта
            </h3>
            <code className="text-[11px] text-zinc-500 truncate block">
              {srtPath ?? "—"}
            </code>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="btn-ghost" onClick={onClose}>
              Закрыть
            </button>
            <button
              className="btn-ghost disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={save}
              disabled={!dirty || saving || reburning || cues.length === 0}
            >
              <PixelCheck size={12} />
              <span>{saving ? "Сохраняем…" : "Сохранить"}</span>
            </button>
            {videoPath && (
              <button
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={saveAndReburn}
                disabled={saving || reburning || cues.length === 0}
                title="Сохранить SRT и перерендерить видео с новыми субтитрами"
              >
                <PixelRefresh size={12} />
                <span>
                  {reburning
                    ? "Вшиваем…"
                    : dirty
                      ? "Сохранить и перевшить"
                      : "Перевшить"}
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading && (
            <div className="text-center text-sm text-zinc-500 py-12">
              Загружаем…
            </div>
          )}
          {error && (
            <div className="mb-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-200/95">
              {error}
            </div>
          )}
          {!loading && !error && cues.length === 0 && (
            <div className="text-center text-sm text-zinc-500 py-12">
              В файле нет реплик.
            </div>
          )}
          <div className="grid gap-2">
            {cues.map((c, i) => (
              <CueRow
                key={`${c.index}-${i}`}
                cue={c}
                onChange={(text) => setText(i, text)}
                onDelete={() => remove(i)}
              />
            ))}
          </div>
        </div>

        {reburnedPath && (
          <div className="px-5 py-2.5 border-t border-white/[0.06] bg-gold-500/[0.06] flex items-center justify-between gap-3 text-[12px] text-gold-200/95">
            <div className="flex items-center gap-2 min-w-0">
              <PixelCheck size={12} />
              <span className="truncate">Готово · {reburnedPath.split("/").pop()}</span>
            </div>
            <button
              className="btn-ghost px-2 py-1 text-[11px]"
              onClick={() => revealInShell(reburnedPath)}
            >
              <PixelFolder size={10} />
              Показать
            </button>
          </div>
        )}

        <div className="px-5 py-2.5 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-500">
          <span>
            {cues.length} реплик{cues.length === 1 ? "а" : ""}
          </span>
          <span>
            {reburning
              ? "Перевшиваем — это занимает столько же, сколько обычное вшивание"
              : dirty
                ? "Есть несохранённые изменения"
                : "Без изменений"}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CueRow({
  cue,
  onChange,
  onDelete,
}: {
  cue: SrtCue;
  onChange: (text: string) => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow textarea so long lines don't need scrolling
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [cue.text]);
  return (
    <div className="group flex items-start gap-3 p-2.5 rounded-lg border border-white/[0.05] bg-white/[0.02] hover:border-white/10 transition-colors">
      <div className="text-[10px] text-zinc-500 tabular-nums shrink-0 w-32 leading-tight pt-1">
        <div>{formatStamp(cue.start_ms)}</div>
        <div className="text-zinc-600">→ {formatStamp(cue.end_ms)}</div>
      </div>
      <textarea
        ref={ref}
        value={cue.text}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 bg-bg-950/40 border border-white/[0.05] rounded px-2 py-1 text-[13px] text-zinc-200 leading-snug resize-none focus:outline-none focus:border-gold-500/50"
        rows={1}
      />
      <button
        type="button"
        onClick={onDelete}
        title="Удалить реплику"
        className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-300 transition-opacity mt-1"
      >
        <PixelX size={12} />
      </button>
    </div>
  );
}

function formatStamp(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const milli = ms % 1_000;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${milli.toString().padStart(3, "0")}`;
}
