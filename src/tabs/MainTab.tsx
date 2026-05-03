import { useEffect, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import {
  PixelArrowRight,
  PixelFolder,
  PixelRefresh,
  PixelSparkles,
  PixelUpload,
  PixelX,
} from "../components/icons";
import { usePipeline } from "../state/usePipeline";
import type { BatchItem } from "../state/usePipeline";
import { useNavigation } from "../state/navigation";
import {
  getDataDir,
  getSettings,
  pickFolder,
  setOutputDir,
} from "../lib/tauri";

export default function MainTab() {
  const { state, browse, browseFolder, reset, reorderBatch, removeFromBatch } =
    usePipeline();
  const { goto } = useNavigation();
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [outputDir, setOutputDirState] = useState<string | null>(null);
  const [outputBusy, setOutputBusy] = useState(false);

  useEffect(() => {
    getDataDir()
      .then(setDataDir)
      .catch(() => setDataDir(null));
    getSettings()
      .then((s) => setOutputDirState(s.output_dir))
      .catch(() => {});
  }, []);

  const pickOutputDir = async () => {
    const folder = await pickFolder();
    if (!folder) return;
    setOutputBusy(true);
    try {
      const next = await setOutputDir(folder);
      setOutputDirState(next.output_dir);
    } catch (err) {
      console.error("set output dir failed", err);
    } finally {
      setOutputBusy(false);
    }
  };

  const clearOutputDir = async () => {
    setOutputBusy(true);
    try {
      const next = await setOutputDir(null);
      setOutputDirState(next.output_dir);
    } catch (err) {
      console.error("clear output dir failed", err);
    } finally {
      setOutputBusy(false);
    }
  };

  const sidecarReady = state.sidecar?.running ?? false;
  const inBatch = !!state.batch;
  const hasSelection = !!state.videoPath || inBatch;
  const showDropZone = !hasSelection;
  const isRunning = state.phase === "running";

  return (
    <div className="p-6 grid gap-6 max-w-5xl mx-auto">
      <GlassCard>
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <PixelSparkles size={16} className="text-gold-300" />
              Шаг 1 — выберите файлы
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              Перетащите видео или папку сюда, либо откройте через кнопки.
              Дальше — настройка стиля и запуск очереди.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost" onClick={browseFolder} disabled={isRunning}>
              <PixelFolder size={16} />
              Папка
            </button>
            <button className="btn-ghost" onClick={browse} disabled={isRunning}>
              <PixelUpload size={16} />
              Файл
            </button>
            <button
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => goto("style")}
              disabled={!hasSelection || !sidecarReady || isRunning}
            >
              {inBatch
                ? `Транскрибировать (${state.batch!.length})`
                : "Транскрибировать"}
              <PixelArrowRight size={16} />
            </button>
          </div>
        </div>
      </GlassCard>

      {showDropZone && (
        <GlassCard className="border-dashed border-white/10 hover:border-gold-500/40 transition-colors">
          <div className="h-56 grid place-items-center text-zinc-500 text-sm text-center">
            Drag &amp; drop видео или папки сюда
            <br />
            <span className="text-zinc-600 text-[11px]">
              .mp4 .mov .mkv .avi .webm .flv .m4v
            </span>
          </div>
        </GlassCard>
      )}

      {state.videoPath && !state.batch && (
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
            {!isRunning && (
              <button className="btn-ghost shrink-0" onClick={reset}>
                <PixelRefresh size={14} />
                Сбросить
              </button>
            )}
          </div>
        </GlassCard>
      )}

      {state.batch && (
        <GlassCard>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs text-zinc-500 uppercase tracking-wide">
                Очередь файлов
              </div>
              <div className="text-sm text-zinc-200 mt-1">
                {state.batch.length} шт.
              </div>
            </div>
            {!isRunning && (
              <button className="btn-ghost" onClick={reset}>
                <PixelRefresh size={14} />
                Очистить
              </button>
            )}
          </div>
          <BatchList
            items={state.batch}
            activeIndex={isRunning ? state.batchIndex : -1}
            isRunning={isRunning}
            onReorder={reorderBatch}
            onRemove={removeFromBatch}
          />
        </GlassCard>
      )}

      <GlassCard>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-zinc-500 uppercase tracking-wide">
              Папка для результатов
            </div>
            <div className="text-[12px] text-zinc-300 mt-1 break-all">
              {outputDir ? (
                <code className="text-gold-200/90">{outputDir}</code>
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
              onClick={pickOutputDir}
              disabled={outputBusy || isRunning}
            >
              <PixelFolder size={14} />
              <span>Выбрать…</span>
            </button>
            {outputDir && (
              <button
                className="btn-ghost"
                onClick={clearOutputDir}
                disabled={outputBusy || isRunning}
              >
                <PixelX size={12} />
                <span>Сбросить</span>
              </button>
            )}
          </div>
        </div>
      </GlassCard>

      <GlassCard className="text-xs text-zinc-500">
        <div className="flex items-center justify-between gap-4">
          <span>Портативная папка данных:</span>
          <code className="text-gold-200/80 break-all text-right">
            {dataDir ?? "—"}
          </code>
        </div>
        <div className="mt-2 flex items-center justify-between gap-4">
          <span>Python sidecar:</span>
          <span className={sidecarReady ? "text-gold-300" : "text-zinc-500"}>
            {sidecarReady
              ? `онлайн на 127.0.0.1:${state.sidecar?.port}`
              : "запускается…"}
          </span>
        </div>
      </GlassCard>
    </div>
  );
}

function BatchList({
  items,
  activeIndex,
  isRunning,
  onReorder,
  onRemove,
}: {
  items: BatchItem[];
  activeIndex: number;
  isRunning: boolean;
  onReorder: (from: number, to: number) => void;
  onRemove: (i: number) => void;
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
        />
      ))}
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
