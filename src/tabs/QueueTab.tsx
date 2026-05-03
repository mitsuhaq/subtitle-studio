import { useEffect, useRef, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import {
  PixelArrowLeft,
  PixelCheck,
  PixelFolder,
  PixelList,
  PixelRefresh,
  PixelType,
  PixelX,
} from "../components/icons";
import { usePipeline } from "../state/usePipeline";
import type { BatchItem } from "../state/usePipeline";
import { useNavigation } from "../state/navigation";
import type { PipelineProgress } from "../lib/tauri";
import { TranscriptEditor } from "../components/TranscriptEditor";

const STAGES = [
  "Извлечение аудио",
  "Транскрипция",
  "Вшивание субтитров",
  "Готово",
] as const;

export default function QueueTab() {
  const { state, cancel, reset, reveal, reorderBatch, removeFromBatch } =
    usePipeline();
  const { goto } = useNavigation();
  const stageIndex = stageIdx(state.progress?.stage);
  const elapsed = useElapsed(state.phase === "running");
  const idle =
    state.phase === "idle" && !state.batch && !state.videoPath;
  const [editor, setEditor] = useState<{ srt: string; video: string | null } | null>(null);
  const openEditor = (srt: string, video: string | null = null) =>
    setEditor({ srt, video });

  if (idle) {
    return (
      <div className="p-6 max-w-5xl mx-auto grid gap-6">
        <GlassCard>
          <div className="text-center py-10 text-sm text-zinc-500 space-y-3">
            <PixelList size={24} className="mx-auto text-zinc-600" />
            <div>Очередь пуста.</div>
            <button className="btn-ghost mx-auto" onClick={() => goto("main")}>
              <PixelArrowLeft size={14} />
              К выбору файлов
            </button>
          </div>
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="p-6 grid gap-6 max-w-5xl mx-auto">
      {state.batch ? (
        <BatchPanel
          state={state}
          stageIndex={stageIndex}
          elapsed={elapsed}
          onCancel={cancel}
          onReset={reset}
          onReveal={reveal}
          onBackToMain={() => goto("main")}
          onReorder={reorderBatch}
          onRemove={removeFromBatch}
          onEdit={openEditor}
        />
      ) : (
        <SinglePanel
          state={state}
          stageIndex={stageIndex}
          elapsed={elapsed}
          onCancel={cancel}
          onReset={reset}
          onReveal={reveal}
          onBackToMain={() => goto("main")}
          onEdit={openEditor}
        />
      )}
      <TranscriptEditor
        open={!!editor}
        srtPath={editor?.srt ?? null}
        videoPath={editor?.video ?? null}
        onClose={() => setEditor(null)}
      />
    </div>
  );
}

function BatchPanel({
  state,
  stageIndex,
  elapsed,
  onCancel,
  onReset,
  onReveal,
  onBackToMain,
  onReorder,
  onRemove,
  onEdit,
}: {
  state: ReturnType<typeof usePipeline>["state"];
  stageIndex: number;
  elapsed: number;
  onCancel: () => void;
  onReset: () => void;
  onReveal: (path: string) => void;
  onBackToMain: () => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (i: number) => void;
  onEdit: (srtPath: string, videoPath?: string | null) => void;
}) {
  const isRunning = state.phase === "running";
  const batch = state.batch!;
  const doneCount = batch.filter((b) => b.status === "done").length;
  const errCount = batch.filter((b) => b.status === "error").length;
  const cancelledCount = batch.filter((b) => b.status === "cancelled").length;
  const allFinished = !isRunning && batch.every((b) => b.status !== "pending");

  return (
    <GlassCard
      className={
        allFinished && doneCount > 0 && errCount === 0 ? "animate-gold-flash" : ""
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-zinc-500 uppercase tracking-wide">
            Очередь · {state.batchIndex + 1} / {batch.length}
          </div>
          <div className="text-sm text-zinc-200 mt-1 truncate max-w-md">
            {isRunning && state.videoPath
              ? state.videoPath.split("/").pop()
              : allFinished
                ? `Готово ${doneCount} · ошибок ${errCount}${cancelledCount ? ` · отменено ${cancelledCount}` : ""}`
                : "Ожидает запуска"}
          </div>
        </div>
        {!isRunning && (
          <div className="flex items-center gap-2">
            <button className="btn-ghost" onClick={onBackToMain}>
              <PixelArrowLeft size={14} />
              К файлам
            </button>
            <button className="btn-ghost" onClick={onReset}>
              <PixelRefresh size={14} />
              Очистить
            </button>
          </div>
        )}
      </div>

      {state.phase !== "idle" && (
        <div className="mt-5">
          <ProgressSection
            progress={state.progress}
            phase={state.phase}
            stageIndex={stageIndex}
            elapsed={elapsed}
            onCancel={onCancel}
          />
        </div>
      )}

      <BatchListWithDnD
        items={batch}
        activeIndex={isRunning ? state.batchIndex : -1}
        isRunning={isRunning}
        onReorder={onReorder}
        onRemove={onRemove}
        onReveal={onReveal}
        onEdit={onEdit}
      />
    </GlassCard>
  );
}

function BatchListWithDnD({
  items,
  activeIndex,
  isRunning,
  onReorder,
  onRemove,
  onReveal,
  onEdit,
}: {
  items: BatchItem[];
  activeIndex: number;
  isRunning: boolean;
  onReorder: (from: number, to: number) => void;
  onRemove: (i: number) => void;
  onReveal: (path: string) => void;
  onEdit: (srtPath: string, videoPath?: string | null) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  return (
    <div className="mt-4 grid gap-1.5 max-h-80 overflow-auto">
      {items.map((item, i) => (
        <BatchRow
          key={item.path}
          item={item}
          index={i}
          active={i === activeIndex}
          isDragging={dragIdx === i}
          isDragOver={overIdx === i && dragIdx !== null && dragIdx !== i}
          canReorder={!isRunning && item.status === "pending"}
          canRemove={!isRunning || i !== activeIndex}
          onDragStart={() => setDragIdx(i)}
          onDragEnd={() => {
            setDragIdx(null);
            setOverIdx(null);
          }}
          onDragOver={() => setOverIdx(i)}
          onDrop={() => {
            if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i);
            setDragIdx(null);
            setOverIdx(null);
          }}
          onRemove={() => onRemove(i)}
          onReveal={onReveal}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}

function SinglePanel({
  state,
  stageIndex,
  elapsed,
  onCancel,
  onReset,
  onReveal,
  onBackToMain,
  onEdit,
}: {
  state: ReturnType<typeof usePipeline>["state"];
  stageIndex: number;
  elapsed: number;
  onCancel: () => void;
  onReset: () => void;
  onReveal: (path: string) => void;
  onBackToMain: () => void;
  onEdit: (srtPath: string, videoPath?: string | null) => void;
}) {
  return (
    <GlassCard>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">
            Видео
          </div>
          <code className="block mt-1 text-[12px] text-zinc-200 break-all">
            {state.videoPath}
          </code>
          <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3">
            Сохранить субтитры
          </div>
          <code className="block mt-1 text-[12px] text-gold-200/80 break-all">
            {state.outputSrt}
          </code>
        </div>
        {(state.phase === "done" ||
          state.phase === "error" ||
          state.phase === "cancelled") && (
          <div className="flex items-center gap-2 shrink-0">
            <button className="btn-ghost" onClick={onBackToMain}>
              <PixelArrowLeft size={14} />К файлам
            </button>
            <button className="btn-ghost" onClick={onReset}>
              <PixelRefresh size={14} />
              Новое
            </button>
          </div>
        )}
      </div>

      {state.phase !== "idle" && (
        <div className="mt-5">
          <ProgressSection
            progress={state.progress}
            phase={state.phase}
            stageIndex={stageIndex}
            elapsed={elapsed}
            onCancel={onCancel}
          />
        </div>
      )}

      {state.phase === "done" && state.result && (
        <div className="mt-5 p-4 rounded-xl bg-gold-500/10 border border-gold-500/30 text-sm text-gold-100/95 space-y-2 animate-gold-flash">
          <div className="flex items-start gap-3">
            <PixelCheck
              size={16}
              className="text-gold-300 mt-0.5 shrink-0"
            />
            <div className="flex-1 min-w-0">
              Готово · {state.result.cues_count} субтитров,{" "}
              {Math.round(state.result.duration)} с
              {state.result.detected_language
                ? ` · язык: ${state.result.detected_language}`
                : ""}
            </div>
          </div>
          <ResultRow
            label="SRT"
            path={state.result.output_srt}
            onShow={() => onReveal(state.result!.output_srt)}
            onEdit={() =>
              onEdit(state.result!.output_srt, state.videoPath ?? null)
            }
          />
          {state.result.output_video && (
            <ResultRow
              label="Видео"
              path={state.result.output_video}
              onShow={() => onReveal(state.result!.output_video!)}
              highlight
            />
          )}
        </div>
      )}

      {state.phase === "cancelled" && (
        <div className="mt-5 p-4 rounded-xl bg-white/[0.04] border border-white/10 text-sm text-zinc-300">
          Прервано пользователем.
        </div>
      )}

      {state.phase === "error" && state.error && (
        <div className="mt-5 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-200/95 flex items-start gap-3">
          <PixelX size={16} className="text-red-300 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0 break-all">{state.error}</div>
        </div>
      )}
    </GlassCard>
  );
}

function ProgressSection({
  progress,
  phase,
  stageIndex,
  elapsed,
  onCancel,
}: {
  progress: PipelineProgress | null;
  phase: string;
  stageIndex: number;
  elapsed: number;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs gap-1">
        {STAGES.map((s, i) => (
          <StagePill
            key={s}
            label={s}
            state={pillState(phase, stageIndex, i)}
          />
        ))}
      </div>
      {phase === "running" && (
        <>
          <div className="flex items-center justify-between gap-2 text-[12px]">
            <div className="flex items-center gap-2 text-zinc-300 min-w-0">
              <PixelSpinner className="text-gold-300 shrink-0" size={14} />
              <span className="truncate">
                {progress?.stage ?? "Подготовка"}
                {progress?.detail ? ` · ${progress.detail}` : ""}
              </span>
            </div>
            <div className="flex items-center gap-3 text-zinc-500 tabular-nums shrink-0">
              <span>{formatElapsed(elapsed)}</span>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={onCancel}>
                <PixelX size={12} />
                Прервать
              </button>
            </div>
          </div>
          <ProgressBar
            value={progress?.pos ?? 0}
            total={progress?.total ?? 0}
            label={
              progress?.total
                ? `${formatTime(progress.pos)} / ${formatTime(progress.total)}`
                : "—"
            }
            pulsing={!progress?.total}
          />
        </>
      )}
    </div>
  );
}

function ResultRow({
  label,
  path,
  onShow,
  onEdit,
  highlight = false,
}: {
  label: string;
  path: string;
  onShow: () => void;
  onEdit?: () => void;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 pl-7">
      <span
        className={`text-[10px] uppercase tracking-wide shrink-0 px-1.5 py-0.5 rounded border ${
          highlight
            ? "border-gold-500/50 bg-gold-500/15 text-gold-200"
            : "border-white/10 bg-white/5 text-zinc-400"
        }`}
      >
        {label}
      </span>
      <code className="flex-1 min-w-0 text-[11px] text-gold-200/90 break-all truncate">
        {path}
      </code>
      {onEdit && (
        <button
          className="btn-ghost shrink-0 px-2 py-1 text-xs"
          onClick={onEdit}
          title="Редактировать транскрипт"
        >
          <PixelType size={12} />
          Править
        </button>
      )}
      <button className="btn-ghost shrink-0 px-2 py-1 text-xs" onClick={onShow}>
        <PixelFolder size={12} />
        Показать
      </button>
    </div>
  );
}

function BatchRow({
  item,
  index,
  active,
  isDragging,
  isDragOver,
  canReorder,
  canRemove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onRemove,
  onReveal,
  onEdit,
}: {
  item: BatchItem;
  index: number;
  active: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  canReorder: boolean;
  canRemove: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onRemove: () => void;
  onReveal: (path: string) => void;
  onEdit: (srtPath: string, videoPath?: string | null) => void;
}) {
  const name = item.path.split("/").pop() || item.path;
  const status = (() => {
    switch (item.status) {
      case "pending":
        return { dot: "bg-zinc-700", label: "ожидает" };
      case "running":
        return { dot: "bg-gold-300 animate-pulse", label: "идёт" };
      case "done":
        return { dot: "bg-gold-300", label: "готово" };
      case "cancelled":
        return { dot: "bg-zinc-500", label: "отменено" };
      case "error":
        return { dot: "bg-red-400", label: "ошибка" };
    }
  })();
  const showVideo = item.result?.output_video;
  return (
    <div
      draggable={canReorder}
      onDragStart={(e) => {
        if (!canReorder) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!canReorder) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(e) => {
        if (!canReorder) return;
        e.preventDefault();
        onDrop();
      }}
      className={`group flex items-center justify-between gap-3 text-[12px] px-3 py-1.5 rounded-md border transition-colors ${
        active
          ? "border-gold-500/40 bg-gold-500/5"
          : isDragOver
            ? "border-gold-500/60 bg-gold-500/10"
            : "border-white/[0.04]"
      } ${isDragging ? "opacity-50" : ""} ${canReorder ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {canReorder && (
          <span className="text-zinc-600 shrink-0 select-none" aria-hidden>
            ⋮⋮
          </span>
        )}
        <span className={`w-1.5 h-1.5 rounded-full ${status.dot} shrink-0`} />
        <span className="truncate text-zinc-200">{name}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-zinc-500">{status.label}</span>
        {item.status === "done" && item.result && (
          <button
            className="btn-ghost px-1.5 py-0.5 text-[10px]"
            onClick={() => onEdit(item.result!.output_srt, item.path)}
            title="Редактировать транскрипт"
          >
            <PixelType size={10} />
            Править
          </button>
        )}
        {item.status === "done" && showVideo && (
          <button
            className="btn-ghost px-1.5 py-0.5 text-[10px]"
            onClick={() => onReveal(showVideo)}
          >
            <PixelFolder size={10} />
            Показать
          </button>
        )}
        {item.status === "done" && !showVideo && item.result && (
          <button
            className="btn-ghost px-1.5 py-0.5 text-[10px]"
            onClick={() => onReveal(item.result!.output_srt)}
          >
            <PixelFolder size={10} />
            SRT
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Убрать из очереди"
            className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-300 transition-opacity"
          >
            <PixelX size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

type PillState = "pending" | "active" | "done" | "error";

function pillState(
  phase: string,
  stageIndex: number,
  i: number,
): PillState {
  if (phase === "error" || phase === "cancelled") {
    if (i < stageIndex) return "done";
    if (i === stageIndex) return phase === "error" ? "error" : "pending";
    return "pending";
  }
  if (i < stageIndex) return "done";
  if (i === stageIndex) return phase === "done" ? "done" : "active";
  return "pending";
}

function StagePill({ label, state }: { label: string; state: PillState }) {
  const base = "flex-1 text-center px-3 py-1.5 rounded-lg border";
  const cls =
    state === "done"
      ? "bg-gold-500/15 border-gold-500/40 text-gold-200"
      : state === "active"
        ? "bg-white/[0.05] border-gold-500/30 text-gold-100/90 animate-gold-pulse"
        : state === "error"
          ? "bg-red-500/10 border-red-500/30 text-red-200"
          : "bg-white/[0.02] border-white/10 text-zinc-500";
  return <div className={`${base} ${cls}`}>{label}</div>;
}

function stageIdx(stage?: string | null): number {
  if (!stage) return -1;
  return (STAGES as readonly string[]).indexOf(stage);
}

function useElapsed(running: boolean): number {
  const [now, setNow] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      startRef.current = null;
      setNow(0);
      return;
    }
    startRef.current = performance.now();
    const id = window.setInterval(() => {
      if (startRef.current != null) {
        setNow(performance.now() - startRef.current);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [running]);

  return now;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s} с`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
