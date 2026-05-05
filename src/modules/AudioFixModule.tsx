import { useEffect, useRef, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import { ProgressBar } from "../components/ProgressBar";
import { PixelSpinner } from "../components/PixelSpinner";
import {
  PixelArrowRight,
  PixelCheck,
  PixelFolder,
  PixelMic,
  PixelRefresh,
  PixelSparkles,
  PixelUpload,
  PixelX,
} from "../components/icons";
import { ModuleGate } from "../components/SideDrawer";
import { OutputDirCard } from "../components/OutputDirCard";
import { useModuleDrop } from "../state/useModuleDrop";
import {
  audioFixCancel,
  audioFixRun,
  notify,
  onAudioFixProgress,
  pickAudioFile,
  pickMediaFile,
  revealInShell,
  VIDEO_EXTS,
} from "../lib/tauri";
import type {
  AmbientPreset,
  AudioFixOptions,
  AudioFixProgress,
  AudioFixResult,
  RoomPreset,
  VocalMode,
} from "../lib/tauri";

// AudioFix happily takes audio-only files too: ffmpeg copies the absent video
// stream as no-op (`-c:v copy` is a no-op when there's no video), so the
// output is also pure audio in the same container — same logic, no special
// case in the backend.
const AUDIO_EXTS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "flac",
  "wma",
];
const isMediaPath = (p: string) => {
  const lower = p.toLowerCase();
  return (
    VIDEO_EXTS.some((ext) => lower.endsWith(`.${ext}`)) ||
    AUDIO_EXTS.some((ext) => lower.endsWith(`.${ext}`))
  );
};

type Phase = "idle" | "running" | "done" | "error" | "cancelled";

// Peak dBFS targets (not LUFS). Same scale that After Effects / Premiere
// show on their meters, so the value the user picks here is exactly what
// they'd read off their NLE's audio panel after rendering.
const PEAK_PRESETS: { label: string; value: number; hint: string }[] = [
  { label: "Голос (−1 dB)", value: -1, hint: "Громко, на грани клиппинга" },
  { label: "Онлайн (−3 dB)", value: -3, hint: "Стандарт для YouTube/соцсетей" },
  { label: "С хедрумом (−6 dB)", value: -6, hint: "Запас под последующий мастеринг" },
];

const AMBIENT_PRESETS: { id: AmbientPreset; label: string; hint: string }[] = [
  { id: "room_tone", label: "Комната", hint: "Лёгкий гул пустой комнаты" },
  { id: "pink_room", label: "Студия", hint: "Нейтральный розовый шум" },
  { id: "white_air", label: "Шипение", hint: "Лёгкое воздушное шипение" },
  { id: "ac_hum", label: "Кондиционер", hint: "Низкочастотный гул вентиляции" },
  { id: "distant_rumble", label: "Дальний гул", hint: "Очень низкий городской фон" },
  { id: "wind_mic", label: "Ветер в микрофон", hint: "Порывы ветра, бьющие по микрофону" },
  { id: "hall_crowd", label: "Толпа в зале", hint: "Гомон зала с людьми" },
  { id: "museum_crowd", label: "Толпа в музее", hint: "Тихий шепчущий гомон" },
  { id: "street", label: "Улица", hint: "Ветер + проезжающие машины" },
];

const ROOM_PRESETS: { id: RoomPreset; label: string; hint: string }[] = [
  { id: "studio", label: "Студия", hint: "Лёгкое затухание — ~0.3 с" },
  { id: "stage", label: "Сцена", hint: "Средняя комната — ~0.7 с" },
  { id: "hall", label: "Зал", hint: "Большой зал — ~1.5 с" },
  { id: "cathedral", label: "Собор", hint: "Длинный реверб — ~2.5 с" },
];

export default function AudioFixModule() {
  return (
    <ModuleGate moduleId="audio_fix">
      <AudioFixInner />
    </ModuleGate>
  );
}

function AudioFixInner() {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [denoise, setDenoise] = useState(true);
  const [loudnorm, setLoudnorm] = useState(true);
  // Default peak target -3 dBFS — broadcast-safe and the de-facto standard
  // for YouTube/Instagram uploads. Users coming from AE/Premiere will see
  // exactly this number on their VU meters.
  const [targetLufs, setTargetLufs] = useState(-3);

  // Ambient overlay: bundled preset XOR custom file. `null` on both = off.
  const [ambientPreset, setAmbientPreset] = useState<AmbientPreset | null>(null);
  const [ambientCustomPath, setAmbientCustomPath] = useState<string | null>(null);
  const [ambientLevelDb, setAmbientLevelDb] = useState(-20);

  // Room reverb: one of the bundled IR presets, or null = bypass.
  const [roomPreset, setRoomPreset] = useState<RoomPreset | null>(null);
  const [roomWetPct, setRoomWetPct] = useState(30);

  // Vocal/karaoke split via ffmpeg mid/side. null = passthrough.
  const [vocalMode, setVocalMode] = useState<VocalMode | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<AudioFixProgress | null>(null);
  const [result, setResult] = useState<AudioFixResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useModuleDrop("audio_fix", (paths) => {
    const v = paths.find(isMediaPath);
    if (v) setVideoPath(v);
  });

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;
    onAudioFixProgress((p) => setProgress(p)).then((un) => {
      if (aborted) un();
      else unlisten = un;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  const elapsed = useElapsed(phase === "running");
  const ambientEnabled = ambientPreset !== null || ambientCustomPath !== null;
  const canRun =
    !!videoPath &&
    phase !== "running" &&
    (denoise ||
      loudnorm ||
      ambientEnabled ||
      roomPreset !== null ||
      vocalMode !== null);

  const run = async () => {
    if (!videoPath) return;
    setPhase("running");
    setProgress(null);
    setError(null);
    setResult(null);
    const opts: AudioFixOptions = {
      denoise,
      loudnorm,
      target_lufs: targetLufs,
      ambient_preset: ambientCustomPath ? null : ambientPreset,
      ambient_custom_path: ambientCustomPath,
      ambient_level_db: ambientLevelDb,
      room_preset: roomPreset,
      room_wet_pct: roomWetPct,
      vocal_mode: vocalMode,
    };
    try {
      const r = await audioFixRun(videoPath, opts);
      setResult(r);
      setPhase("done");
      const name = r.output_video.split("/").pop() ?? r.output_video;
      await notify("Zonthor Studio — звук обработан", name);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("Прервано") || msg.includes("cancelled")) {
        setPhase("cancelled");
      } else {
        setError(msg);
        setPhase("error");
      }
    }
  };

  const cancel = () => {
    audioFixCancel().catch(() => {});
  };

  const browse = async () => {
    const p = await pickMediaFile();
    if (p) setVideoPath(p);
  };

  return (
    <div className="p-6 grid gap-6 max-w-5xl mx-auto">
      <GlassCard>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <PixelMic size={16} className="text-gold-300" />
              Audio Fix — шумодав и нормализация громкости
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              RNNoise убирает фоновый шум. Нормализация поднимает пик до
              указанного уровня в dBFS — шкала совпадает с After Effects /
              Premiere. Видео-поток копируется как есть.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn-ghost" onClick={browse} disabled={phase === "running"}>
              <PixelUpload size={16} />
              <span>Файл</span>
            </button>
            <button
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={run}
              disabled={!canRun}
            >
              <span>Запустить</span>
              <PixelArrowRight size={16} />
            </button>
          </div>
        </div>
      </GlassCard>

      {!videoPath && (
        <GlassCard className="border-dashed border-white/10 hover:border-gold-500/40 transition-colors">
          <div className="h-56 grid place-items-center text-zinc-500 text-sm text-center">
            Drag &amp; drop видео или аудио сюда
            <br />
            <span className="text-zinc-600 text-[11px]">
              видео: .mp4 .mov .mkv .avi .webm · аудио: .mp3 .wav .m4a .aac
              .ogg .flac
            </span>
          </div>
        </GlassCard>
      )}

      {videoPath && (
        <GlassCard>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-zinc-500 uppercase tracking-wide">
                Видео
              </div>
              <code className="block mt-1 text-[12px] text-zinc-200 break-all">
                {videoPath}
              </code>
            </div>
            {phase !== "running" && (
              <button
                className="btn-ghost shrink-0"
                onClick={() => {
                  setVideoPath(null);
                  setResult(null);
                  setPhase("idle");
                  setError(null);
                }}
              >
                <PixelRefresh size={14} />
                Сбросить
              </button>
            )}
          </div>
        </GlassCard>
      )}

      <GlassCard>
        <h2 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2">
          <PixelSparkles size={14} className="text-gold-300" />
          Что сделать
        </h2>

        <div className="grid gap-3">
          <Toggle
            checked={denoise}
            onChange={setDenoise}
            label="Шумоподавление (RNNoise)"
            hint="Убирает фоновый шум: вентилятор, улицу, эхо комнаты."
          />
          <Toggle
            checked={loudnorm}
            onChange={setLoudnorm}
            label="Нормализация громкости (peak dBFS)"
            hint="Поднимает пик аудио до указанного уровня — те же цифры что в After Effects."
          />

          {loudnorm && (
            <div className="ml-6 mt-1 grid gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500">Целевой пик</span>
                <span className="text-[11px] text-gold-200/90 tabular-nums">
                  {targetLufs.toFixed(1)} dBFS
                </span>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={-30}
                  max={0}
                  step={0.5}
                  value={targetLufs}
                  onChange={(e) => setTargetLufs(Number(e.target.value))}
                  className="flex-1 accent-gold-500"
                />
                <input
                  type="number"
                  min={-30}
                  max={0}
                  step={0.5}
                  value={targetLufs}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setTargetLufs(v);
                  }}
                  className="w-20 bg-bg-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-gold-500/50 tabular-nums"
                />
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {PEAK_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setTargetLufs(p.value)}
                    className={`px-2.5 py-1.5 rounded border text-[11px] transition-colors ${
                      Math.abs(targetLufs - p.value) < 0.01
                        ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                        : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
                    }`}
                    title={p.hint}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-zinc-600">
                0 dBFS = цифровой максимум (клиппинг). −1…−3 — нормально для
                публикации. −6 оставляет запас под мастеринг. Шкала идентична
                индикатору пика в AE / Premiere.
              </div>
            </div>
          )}
        </div>
      </GlassCard>

      <AmbientCard
        preset={ambientPreset}
        setPreset={(p) => {
          setAmbientPreset(p);
          if (p) setAmbientCustomPath(null);
        }}
        customPath={ambientCustomPath}
        setCustomPath={(p) => {
          setAmbientCustomPath(p);
          if (p) setAmbientPreset(null);
        }}
        levelDb={ambientLevelDb}
        setLevelDb={setAmbientLevelDb}
      />

      <RoomCard
        preset={roomPreset}
        setPreset={setRoomPreset}
        wetPct={roomWetPct}
        setWetPct={setRoomWetPct}
      />

      <VocalCard mode={vocalMode} setMode={setVocalMode} />

      {phase === "running" && (
        <GlassCard>
          <div className="flex items-center justify-between gap-2 text-[12px] mb-3">
            <div className="flex items-center gap-2 text-zinc-300">
              <PixelSpinner className="text-gold-300 shrink-0" size={14} />
              <span>{progress?.stage ?? "Подготовка"}</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-zinc-500 tabular-nums">
                {formatElapsed(elapsed)}
              </span>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={cancel}>
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
        </GlassCard>
      )}

      {phase === "cancelled" && (
        <GlassCard>
          <div className="text-sm text-zinc-300">Прервано пользователем.</div>
        </GlassCard>
      )}

      {phase === "done" && result && (
        <GlassCard className="animate-gold-flash">
          <div className="flex items-center gap-3">
            <PixelCheck size={16} className="text-gold-300 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gold-100/95">Готово</div>
              <code className="block text-[11px] text-gold-200/90 break-all mt-1">
                {result.output_video}
              </code>
            </div>
            <button
              className="btn-ghost shrink-0"
              onClick={() => revealInShell(result.output_video)}
            >
              <PixelFolder size={14} />
              Показать
            </button>
          </div>
        </GlassCard>
      )}

      {phase === "error" && error && (
        <GlassCard>
          <div className="flex items-start gap-3 text-sm text-red-200/95">
            <PixelX size={16} className="text-red-300 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0 break-all">{error}</div>
          </div>
        </GlassCard>
      )}

      <OutputDirCard moduleId="audio_fix" moduleLabel="Audio Fix" disabled={phase === "running"} />
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
        checked
          ? "border-gold-500/40 bg-gold-500/[0.05]"
          : "border-white/[0.06] bg-white/[0.02] hover:border-gold-500/30"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-gold-500 mt-0.5 w-4 h-4"
      />
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-medium ${checked ? "text-gold-200" : "text-zinc-200"}`}>
          {label}
        </div>
        <div className="text-[11px] text-zinc-500 mt-0.5">{hint}</div>
      </div>
    </label>
  );
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

function AmbientCard({
  preset,
  setPreset,
  customPath,
  setCustomPath,
  levelDb,
  setLevelDb,
}: {
  preset: AmbientPreset | null;
  setPreset: (p: AmbientPreset | null) => void;
  customPath: string | null;
  setCustomPath: (p: string | null) => void;
  levelDb: number;
  setLevelDb: (db: number) => void;
}) {
  const enabled = preset !== null || customPath !== null;
  return (
    <GlassCard>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
          <PixelSparkles size={14} className="text-gold-300" />
          Подмешать фон
        </h2>
        {enabled && (
          <button
            type="button"
            onClick={() => {
              setPreset(null);
              setCustomPath(null);
            }}
            className="text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Выключить
          </button>
        )}
      </div>
      <p className="text-[11px] text-zinc-500 mb-3">
        Лёгкий ambient под голос — оживляет «стерильную» запись. Все встроенные
        пресеты — синтетический шум, для реалистичной толпы или музея кидайте
        свой файл.
      </p>

      <div className="grid grid-cols-3 gap-1.5 mb-3">
        {AMBIENT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            onClick={() => setPreset(preset === p.id ? null : p.id)}
            className={`px-2 py-1.5 rounded border text-[11px] transition-colors ${
              preset === p.id
                ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-3">
        <button
          className="btn-ghost"
          onClick={async () => {
            const p = await pickAudioFile();
            if (p) setCustomPath(p);
          }}
        >
          <PixelFolder size={14} />
          {customPath ? "Заменить файл" : "Свой файл"}
        </button>
        {customPath && (
          <>
            <code className="flex-1 min-w-0 text-[11px] text-gold-200/80 break-all truncate">
              {customPath}
            </code>
            <button
              type="button"
              onClick={() => setCustomPath(null)}
              className="text-zinc-500 hover:text-red-300"
            >
              <PixelX size={12} />
            </button>
          </>
        )}
      </div>

      {enabled && (
        <div className="grid gap-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Уровень фона</span>
            <span className="text-gold-200/90 tabular-nums">
              {levelDb.toFixed(0)} dB
            </span>
          </div>
          <input
            type="range"
            min={-40}
            max={0}
            step={1}
            value={levelDb}
            onChange={(e) => setLevelDb(Number(e.target.value))}
            className="w-full accent-gold-500"
          />
          <div className="text-[10px] text-zinc-600">
            −20 dB — обычно достаточно, чтобы фон был слышен но не мешал голосу.
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function VocalCard({
  mode,
  setMode,
}: {
  mode: VocalMode | null;
  setMode: (m: VocalMode | null) => void;
}) {
  const OPTIONS: { id: VocalMode; label: string; hint: string }[] = [
    { id: "extract", label: "Вытащить вокал", hint: "Оставить только то, что в центре стерео-картины (обычно вокал)" },
    { id: "remove", label: "Убрать вокал (караоке)", hint: "Подавить центр стерео-картины — минусовка" },
  ];
  return (
    <GlassCard>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
          <PixelSparkles size={14} className="text-gold-300" />
          Голос / музыка
        </h2>
        {mode && (
          <button
            type="button"
            onClick={() => setMode(null)}
            className="text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Выключить
          </button>
        )}
      </div>
      <p className="text-[11px] text-zinc-500 mb-3">
        Простое разделение через mid/side: работает на стерео-миксах с
        вокалом по центру (радио-стиль). На записях с жёстко спанорамированным
        или продублированным вокалом результат будет ниже, чем у
        нейросетевого Demucs — без 1 ГБ модели по-другому не получится.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            title={opt.hint}
            onClick={() => setMode(mode === opt.id ? null : opt.id)}
            className={`px-2.5 py-2 rounded border text-[12px] transition-colors ${
              mode === opt.id
                ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </GlassCard>
  );
}

function RoomCard({
  preset,
  setPreset,
  wetPct,
  setWetPct,
}: {
  preset: RoomPreset | null;
  setPreset: (p: RoomPreset | null) => void;
  wetPct: number;
  setWetPct: (v: number) => void;
}) {
  return (
    <GlassCard>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
          <PixelSparkles size={14} className="text-gold-300" />
          Реверб «комнаты»
        </h2>
        {preset && (
          <button
            type="button"
            onClick={() => setPreset(null)}
            className="text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Выключить
          </button>
        )}
      </div>
      <p className="text-[11px] text-zinc-500 mb-3">
        Имитация акустики помещения через свёрточный реверб. Подходит когда надо
        «вписать» сухой голос в более живой пространственный микс.
      </p>

      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {ROOM_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            onClick={() => setPreset(preset === p.id ? null : p.id)}
            className={`px-2 py-1.5 rounded border text-[11px] transition-colors ${
              preset === p.id
                ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-gold-500/30"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preset && (
        <div className="grid gap-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Сила эффекта</span>
            <span className="text-gold-200/90 tabular-nums">{wetPct.toFixed(0)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={wetPct}
            onChange={(e) => setWetPct(Number(e.target.value))}
            className="w-full accent-gold-500"
          />
          <div className="text-[10px] text-zinc-600">
            0% — голос как был. 30% — натурально. 100% — почти один реверб
            (для эффекта).
          </div>
        </div>
      )}
    </GlassCard>
  );
}
