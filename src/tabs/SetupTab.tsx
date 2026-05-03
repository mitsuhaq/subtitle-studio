import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import { UpdaterCard } from "../components/UpdaterCard";
import {
  PixelCheck,
  PixelCircle,
  PixelDownload,
  PixelFolder,
  PixelHdd,
  PixelRefresh,
  PixelX,
} from "../components/icons";
import { useSetup } from "../state/useSetup";
import { formatBytes } from "../lib/format";
import type {
  Component,
  ComponentStatus,
  ProgressPayload,
} from "../lib/tauri";

const WHISPER_HINT = "Whisper large-v3 — около 3 ГБ. Загрузка с Hugging Face.";
const FFMPEG_HINT =
  "FFmpeg portable — около 25 МБ. macOS: evermeet.cx, Windows: BtbN.";

type Phase = "idle" | "running" | "done" | "error" | "cancelled";

export default function SetupTab() {
  const setup = useSetup();
  const { status } = setup;

  return (
    <div className="p-6 max-w-5xl mx-auto grid gap-6">
      <GlassCard>
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <PixelHdd size={16} className="text-gold-300" />
              Установка зависимостей
            </h2>
            <p className="text-sm text-zinc-400 mt-1 max-w-xl">
              Whisper large-v3 и FFmpeg будут загружены в локальную папку{" "}
              <code className="text-gold-200/80">./data/</code> рядом с
              приложением. Перенос на другой компьютер не требует
              переустановки.
            </p>
            {status?.data_dir && (
              <code className="block mt-2 text-[11px] text-zinc-500 break-all">
                {status.data_dir}
              </code>
            )}
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <button className="btn-ghost" onClick={setup.reveal}>
              <PixelFolder size={16} />
              Открыть data/
            </button>
            <button className="btn-ghost" onClick={setup.refresh}>
              <PixelRefresh size={16} />
              Проверить
            </button>
          </div>
        </div>
      </GlassCard>

      <ComponentCard
        component="whisper"
        title="Whisper large-v3"
        hint={WHISPER_HINT}
        status={status?.whisper}
        progress={setup.whisper.progress}
        phase={setup.whisper.phase}
        error={setup.whisper.error}
        onDownload={setup.startWhisper}
        onCancel={() => setup.cancel("whisper")}
      />

      <ComponentCard
        component="ffmpeg"
        title="FFmpeg"
        hint={FFMPEG_HINT}
        status={status?.ffmpeg}
        progress={setup.ffmpeg.progress}
        phase={setup.ffmpeg.phase}
        error={setup.ffmpeg.error}
        onDownload={setup.startFfmpeg}
        onCancel={() => setup.cancel("ffmpeg")}
        onBrowse={setup.browseFfmpeg}
      />

      <UpdaterCard />
    </div>
  );
}

interface CardProps {
  component: Component;
  title: string;
  hint: string;
  status: ComponentStatus | undefined;
  progress: ProgressPayload | null;
  phase: Phase;
  error: string | null;
  onDownload: () => void;
  onCancel: () => void;
  onBrowse?: () => void;
}

function ComponentCard({
  title,
  hint,
  status,
  progress,
  phase,
  error,
  onDownload,
  onCancel,
  onBrowse,
}: CardProps) {
  const installed = !!status?.installed;
  const running = phase === "running";

  return (
    <GlassCard>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StateBadge installed={installed} running={running} error={!!error} />
            <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          </div>
          <p className="text-sm text-zinc-400 mt-1">{hint}</p>
          {status?.path && (
            <code className="block mt-2 text-[11px] text-zinc-500 break-all">
              {status.path}
            </code>
          )}
          {status?.installed && status.size_bytes > 0 && (
            <div className="mt-1 text-[11px] text-zinc-500">
              {formatBytes(status.size_bytes)}
              {status.version ? ` · ${status.version}` : ""}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onBrowse && !running && (
            <button className="btn-ghost" onClick={onBrowse}>
              <PixelFolder size={16} />
              Указать путь
            </button>
          )}
          {running ? (
            <button className="btn-ghost" onClick={onCancel}>
              <PixelX size={16} />
              Отменить
            </button>
          ) : (
            <button className="btn-primary" onClick={onDownload}>
              <PixelDownload size={16} />
              {installed ? "Перезагрузить" : "Скачать"}
            </button>
          )}
        </div>
      </div>

      {running && (
        <div className="mt-5 space-y-3">
          <div className="text-[12px] text-zinc-300 flex items-center gap-2">
            <PixelSpinner className="text-gold-300" size={14} />
            <span>
              {progress?.stage ?? "Подготовка"}
              {progress?.file ? ` · ${progress.file}` : ""}
            </span>
          </div>
          <ProgressBar
            value={progress?.grand_downloaded ?? 0}
            total={progress?.grand_total ?? 0}
            label={
              progress?.grand_total
                ? `${formatBytes(progress.grand_downloaded)} / ${formatBytes(progress.grand_total)}`
                : "—"
            }
            pulsing={!progress?.grand_total}
          />
          {progress?.file && progress.file_total > 0 && (
            <ProgressBar
              value={progress.file_downloaded}
              total={progress.file_total}
              label={`${progress.file} · ${formatBytes(progress.file_downloaded)} / ${formatBytes(progress.file_total)}`}
            />
          )}
        </div>
      )}

      {phase === "cancelled" && (
        <div className="mt-4 text-sm text-zinc-400 bg-white/[0.04] border border-white/10 rounded-xl p-3">
          Загрузка отменена.
        </div>
      )}

      {phase === "error" && error && (
        <div className="mt-4 text-sm text-red-300/90 bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          {error}
        </div>
      )}
    </GlassCard>
  );
}

function StateBadge({
  installed,
  running,
  error,
}: {
  installed: boolean;
  running: boolean;
  error: boolean;
}) {
  if (running) return <PixelSpinner className="text-gold-300" size={14} />;
  if (error) return <PixelX size={14} className="text-red-400" />;
  if (installed) return <PixelCheck size={14} className="text-gold-300" />;
  return <PixelCircle size={14} className="text-zinc-600" />;
}
