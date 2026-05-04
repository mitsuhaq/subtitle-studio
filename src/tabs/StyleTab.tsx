import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { GlassCard } from "../components/GlassCard";
import { Dropdown } from "../components/Dropdown";
import { PromptModal } from "../components/PromptModal";
import {
  PixelArrowLeft,
  PixelArrowRight,
  PixelCheck,
  PixelRefresh,
  PixelSparkles,
  PixelType,
  PixelX,
} from "../components/icons";
import { usePipeline } from "../state/usePipeline";
import { useNavigation } from "../state/navigation";
import { useHotkeys } from "../state/hotkeys";
import {
  DEFAULT_STYLE,
  deletePreset,
  extractPreviewFrame,
  getSettings,
  listFonts,
  listPresets,
  renderStyledPreview,
  savePreset,
  saveLastStyle,
} from "../lib/tauri";
import type { Preset, SubtitleStyle } from "../lib/tauri";

const ALIGNMENTS: { code: number; label: string; row: 0 | 1 | 2; col: 0 | 1 | 2 }[] = [
  { code: 7, label: "↖", row: 0, col: 0 },
  { code: 8, label: "↑", row: 0, col: 1 },
  { code: 9, label: "↗", row: 0, col: 2 },
  { code: 4, label: "←", row: 1, col: 0 },
  { code: 5, label: "·", row: 1, col: 1 },
  { code: 6, label: "→", row: 1, col: 2 },
  { code: 1, label: "↙", row: 2, col: 0 },
  { code: 2, label: "↓", row: 2, col: 1 },
  { code: 3, label: "↘", row: 2, col: 2 },
];

export default function StyleTab() {
  const { state, transcribe } = usePipeline();
  const { active, goto } = useNavigation();

  const [style, setStyle] = useState<SubtitleStyle>(DEFAULT_STYLE);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeName, setActiveName] = useState<string>("");
  const [fonts, setFonts] = useState<string[]>([]);
  const [burnIn, setBurnIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [autoRatio, setAutoRatio] = useState<number | null>(null);
  const [previewText, setPreviewText] = useState("Lorem ipsum dolor sit");
  // When false (initial / after reset), the preview text is auto-generated
  // from `maxChars` so the user *sees* exactly how many characters their
  // current setting allows. Touching the field flips this to true → manual.
  const [previewTextManual, setPreviewTextManual] = useState(false);
  const [previewFrameSrc, setPreviewFrameSrc] = useState<string | null>(null);
  const [previewFrameError, setPreviewFrameError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // Whisper transcription opts (live alongside style — not part of presets).
  const [initialPrompt, setInitialPrompt] = useState<string>("");
  const [maxCharsAuto, setMaxCharsAuto] = useState<boolean>(true);
  const [maxChars, setMaxChars] = useState<number>(42);

  // Initial load: presets + last_style + system fonts
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, settings, fontList] = await Promise.all([
          listPresets(),
          getSettings(),
          listFonts(),
        ]);
        if (cancelled) return;
        setPresets(list);
        setFonts(fontList);
        const last = settings.last_style;
        if (last) {
          setStyle(last);
          const match = list.find((p) => stylesEqual(p.style, last));
          if (match) setActiveName(match.name);
        } else if (list.length > 0) {
          setStyle(list[0].style);
          setActiveName(list[0].name);
        }
      } catch (err) {
        console.error("style tab load failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Detect aspect of first selected video + grab a real frame as a fast
  // first paint. The styled (with-subtitles) render kicks in via the
  // separate debounced effect below.
  useEffect(() => {
    setAutoRatio(null);
    setPreviewFrameSrc(null);
    setPreviewFrameError(null);
    const path = state.batch?.[0]?.path ?? state.videoPath;
    if (!path) return;
    let cancelled = false;

    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = convertFileSrc(path);
    v.onloadedmetadata = () => {
      if (cancelled || !v.videoWidth || !v.videoHeight) return;
      setAutoRatio(v.videoWidth / v.videoHeight);
    };
    v.onerror = () => {/* fall back to 16:9 */};

    setPreviewLoading(true);
    extractPreviewFrame(path)
      .then((p) => {
        if (cancelled) return;
        setPreviewFrameSrc(`${convertFileSrc(p)}?t=${Date.now()}`);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("preview frame extract failed", err);
        setPreviewFrameError(String(err));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
      v.removeAttribute("src");
      v.load();
    };
  }, [state.batch, state.videoPath]);

  // Debounced styled preview: re-renders the frame *with subtitles burned in
  // by libass*, so what you see is bit-identical to the final video. 400 ms
  // is enough to coalesce slider drags without feeling laggy.
  useEffect(() => {
    const path = state.batch?.[0]?.path ?? state.videoPath;
    if (!path) return;
    const text = (previewText || "Пример субтитра").trim() || "Пример субтитра";
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setPreviewLoading(true);
      renderStyledPreview(path, style, text)
        .then((p) => {
          if (cancelled) return;
          setPreviewFrameSrc(`${convertFileSrc(p)}?t=${Date.now()}`);
          setPreviewFrameError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          console.warn("styled preview failed", err);
          setPreviewFrameError(String(err));
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [style, previewText, state.batch, state.videoPath]);

  // Drop "active preset" highlight when the user edits anything
  useEffect(() => {
    if (!activeName) return;
    const match = presets.find((p) => p.name === activeName);
    if (match && !stylesEqual(match.style, style)) setActiveName("");
  }, [style, activeName, presets]);

  // Live-sync preview text to current max_chars while in auto mode — so a
  // slider drag immediately shows what fits.
  useEffect(() => {
    if (previewTextManual) return;
    setPreviewText(loremForLen(maxChars));
  }, [maxChars, previewTextManual]);

  // Auto max_chars — derived from video width, font size, bold weight.
  // For horizontally-centered alignments (2/5/8) the ASS writer forces
  // MarginL = MarginR = 0, so text actually has the *full* screen width to
  // play with — we mirror that here instead of pessimistically subtracting
  // the user's L/R margins. Glyph factors are tuned to Inter's real
  // metrics (regular ≈0.5×, bold ≈0.55×) and safety is generous (0.95)
  // because libass + WrapStyle=2 won't double-stack lines anymore.
  useEffect(() => {
    if (!maxCharsAuto) return;
    const refH = 1080;
    const refW = (autoRatio ?? 16 / 9) * refH;
    const isHCenter = [2, 5, 8].includes(style.alignment);
    const margins = isHCenter ? 0 : style.margin_l + style.margin_r;
    const usable = Math.max(100, refW - margins);
    // Tighter glyph factor — reflects how mixed-case prose actually
    // measures in Inter (~0.45× regular, 0.5× bold), not the worst-case
    // all-caps width. No safety multiplier — libass + WrapStyle=2 keeps
    // each cue on a single line, and the writer caps cue length itself.
    const glyph = style.font_size * (style.bold ? 0.5 : 0.45);
    const fitted = Math.floor(usable / glyph);
    setMaxChars(Math.max(13, Math.min(40, fitted)));
  }, [
    maxCharsAuto,
    autoRatio,
    style.font_size,
    style.bold,
    style.alignment,
    style.margin_l,
    style.margin_r,
  ]);

  const sidecarReady = state.sidecar?.running ?? false;
  const isRunning = state.phase === "running";
  const hasSelection = !!state.videoPath || !!state.batch;
  const targetCount = state.batch?.length ?? (state.videoPath ? 1 : 0);
  const dirty = useMemo(() => {
    const match = presets.find((p) => p.name === activeName);
    return !match || !stylesEqual(match.style, style);
  }, [presets, activeName, style]);

  const popFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1800);
  };

  const handlePickPreset = (name: string) => {
    if (!name) {
      setActiveName("");
      return;
    }
    const p = presets.find((x) => x.name === name);
    if (p) {
      setStyle(p.style);
      setActiveName(name);
    }
  };

  const handleSaveAs = () => setPromptOpen(true);

  const doSaveAs = async (name: string) => {
    setPromptOpen(false);
    try {
      setBusy(true);
      const saved = await savePreset(name, style);
      const next = await listPresets();
      setPresets(next);
      setActiveName(saved.name);
      popFlash(`Сохранён: ${saved.name}`);
    } catch (err) {
      popFlash(`Ошибка: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleOverwrite = async () => {
    if (!activeName) return;
    try {
      setBusy(true);
      await savePreset(activeName, style);
      const next = await listPresets();
      setPresets(next);
      popFlash(`Обновлён: ${activeName}`);
    } catch (err) {
      popFlash(`Ошибка: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (confirmDelete !== name) {
      setConfirmDelete(name);
      window.setTimeout(
        () => setConfirmDelete((c) => (c === name ? null : c)),
        2500,
      );
      return;
    }
    try {
      setBusy(true);
      await deletePreset(name);
      const next = await listPresets();
      setPresets(next);
      if (activeName === name) setActiveName("");
      setConfirmDelete(null);
      popFlash("Удалён");
    } catch (err) {
      popFlash(`Ошибка: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    try {
      await saveLastStyle(style);
    } catch (err) {
      console.error("saveLastStyle failed", err);
    }
    goto("queue");
    void transcribe({
      burn_in: burnIn,
      style,
      initial_prompt: initialPrompt.trim() || undefined,
      max_chars: maxChars,
    });
  };

  // Space on Style = «Запустить» (when ready). Disabled on every other tab
  // so a stray space-press elsewhere never accidentally kicks off a batch.
  useHotkeys({
    enabled: active === "style",
    space:
      hasSelection && sidecarReady && !isRunning ? handleStart : undefined,
  });

  // Derived strictly from the source video — no manual override. Fall back
  // to 16:9 only until metadata loads.
  const previewRatio = autoRatio ?? 16 / 9;

  return (
    <>
    <PromptModal
      open={promptOpen}
      title="Имя пресета"
      defaultValue={activeName || "Мой пресет"}
      placeholder="Например: Подкаст, Reels…"
      okLabel="Сохранить"
      onSubmit={doSaveAs}
      onCancel={() => setPromptOpen(false)}
    />
    <div className="p-6 grid gap-6 max-w-6xl mx-auto">
      <GlassCard>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <PixelType size={16} className="text-gold-300" />
              Шаг 2 — стиль субтитров
            </h1>
            <p className="text-sm text-zinc-400 mt-1 max-w-md">
              {hasSelection
                ? `Выбрано: ${targetCount} ${targetCount === 1 ? "файл" : "файлов"}.`
                : "Сначала выберите файлы на вкладке Main."}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn-ghost" onClick={() => goto("main")}>
              <PixelArrowLeft size={16} />
              <span>Назад</span>
            </button>
            <label className="flex items-center gap-2 text-xs text-zinc-300 select-none cursor-pointer mr-2 whitespace-nowrap">
              <input
                type="checkbox"
                checked={burnIn}
                onChange={(e) => setBurnIn(e.target.checked)}
                className="accent-gold-500 w-3.5 h-3.5"
              />
              Вшить в видео
            </label>
            <button
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleStart}
              disabled={!hasSelection || !sidecarReady || isRunning}
            >
              <span>Запустить</span>
              <PixelArrowRight size={16} />
            </button>
          </div>
        </div>
      </GlassCard>

      <GlassCard>
        <h2 className="text-sm font-semibold text-zinc-200 mb-3">
          Транскрипция
        </h2>
        <div className="grid gap-3">
          <label className="text-xs text-zinc-500 block">
            Контекст для Whisper
            <textarea
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="Имена, бренды, термины через пробел или запятую — Whisper будет ловить их точнее. Пример: Anthropic, Claude, gradient descent, RAG."
              rows={2}
              className="mt-1.5 w-full bg-bg-900 border border-white/10 rounded px-2.5 py-2 text-[12px] text-zinc-200 leading-snug resize-none focus:outline-none focus:border-gold-500/50"
            />
          </label>

          <div className="grid grid-cols-[1fr_auto] gap-3 items-center">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-zinc-500">
                  Максимум символов в строке
                  {maxCharsAuto && (
                    <span className="text-gold-300/70 ml-2">авто = {maxChars}</span>
                  )}
                </span>
                {!maxCharsAuto && (
                  <span className="text-[11px] text-gold-200/90 tabular-nums">
                    {maxChars}
                  </span>
                )}
              </div>
              <input
                type="range"
                min={13}
                max={40}
                step={1}
                value={maxChars}
                onChange={(e) => {
                  setMaxCharsAuto(false);
                  setMaxChars(Number(e.target.value));
                }}
                disabled={maxCharsAuto}
                className="w-full accent-gold-500 disabled:opacity-50"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer select-none whitespace-nowrap">
              <input
                type="checkbox"
                checked={maxCharsAuto}
                onChange={(e) => setMaxCharsAuto(e.target.checked)}
                className="accent-gold-500 w-3.5 h-3.5"
              />
              Авто
            </label>
          </div>
          <div className="text-[10px] text-zinc-600">
            Авто считает максимум по ширине видео и параметрам шрифта (с
            запасом 8%). Сними галочку чтобы выставить вручную.
          </div>
        </div>
      </GlassCard>

      <GlassCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">
              Пресет
            </label>
            <Dropdown
              value={activeName}
              onChange={handlePickPreset}
              placeholder="— свой стиль —"
              width="w-56"
              trailing={dirty && activeName ? <span className="text-gold-300">*</span> : null}
              items={[
                { value: "", label: "— свой стиль —" },
                ...presets.map((p) => ({
                  value: p.name,
                  label: p.name,
                })),
              ]}
              renderItem={(item) => {
                if (item.value === "") return item.label;
                const isCurrent = item.value === activeName;
                return (
                  <span className="flex items-center gap-2">
                    <span className="truncate">{item.label}</span>
                    {isCurrent && dirty && (
                      <span className="text-[10px] text-gold-300/80">изменён</span>
                    )}
                  </span>
                );
              }}
            />
            {flash && (
              <span className="text-[11px] text-gold-300 ml-2 flex items-center gap-1">
                <PixelCheck size={10} />
                {flash}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {activeName && dirty && (
              <button
                className="btn-ghost"
                onClick={handleOverwrite}
                disabled={busy}
                title="Перезаписать текущий пресет новыми значениями"
              >
                <PixelRefresh size={12} />
                <span>Обновить</span>
              </button>
            )}
            <button
              className="btn-ghost"
              onClick={handleSaveAs}
              disabled={busy}
            >
              <PixelCheck size={12} />
              <span>Сохранить как…</span>
            </button>
            {activeName && (
              <button
                className="btn-ghost text-red-300/80 hover:text-red-200"
                onClick={() => handleDelete(activeName)}
                disabled={busy}
              >
                <PixelX size={12} />
                <span>{confirmDelete === activeName ? "Точно?" : "Удалить"}</span>
              </button>
            )}
          </div>
        </div>

        {presets.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/[0.05]">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1.5">
              Все пресеты
            </div>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <PresetChip
                  key={p.name}
                  name={p.name}
                  active={activeName === p.name}
                  confirmDelete={confirmDelete === p.name}
                  onPick={() => handlePickPreset(p.name)}
                  onDelete={() => handleDelete(p.name)}
                />
              ))}
            </div>
          </div>
        )}
      </GlassCard>

      <div className="grid lg:grid-cols-2 gap-6">
        <GlassCard>
          <h2 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2">
            <PixelSparkles size={14} className="text-gold-300" />
            Параметры
          </h2>
          <StyleForm style={style} onChange={setStyle} fonts={fonts} />
        </GlassCard>

        <GlassCard>
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              <PixelSparkles size={14} className="text-gold-300" />
              Превью
            </h2>
            {autoRatio && (
              <span className="text-[11px] text-zinc-500 tabular-nums">
                {formatAspectLabel(autoRatio)}
              </span>
            )}
          </div>

          <div className="relative mb-3">
            <input
              type="text"
              value={previewText}
              onChange={(e) => {
                setPreviewText(e.target.value);
                setPreviewTextManual(true);
              }}
              placeholder="Текст для примера…"
              className="w-full bg-bg-900 border border-white/10 rounded px-2.5 py-1.5 pr-20 text-xs text-zinc-200 focus:outline-none focus:border-gold-500/50"
            />
            <button
              type="button"
              onClick={() => {
                setPreviewTextManual(false);
                setPreviewText(loremForLen(maxChars));
              }}
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border transition-colors ${
                previewTextManual
                  ? "border-white/15 bg-white/[0.04] text-zinc-300 hover:border-gold-500/30"
                  : "border-gold-500/40 bg-gold-500/15 text-gold-200"
              }`}
              title="Подставлять лорем-ипсум по длине max_chars"
            >
              Lorem
            </button>
          </div>

          <PreviewBox
            style={style}
            ratio={previewRatio}
            text={previewText || "Пример субтитра"}
            frameSrc={previewFrameSrc}
            loading={previewLoading}
            hasVideo={hasSelection}
          />
          <p className="text-[11px] text-zinc-600 mt-3">
            {previewFrameError
              ? `Кадр не извлечён: ${previewFrameError}`
              : previewFrameSrc
                ? "Реальный кадр из середины первого видео. Окошко подстраивается под формат автоматически."
                : hasSelection
                  ? previewLoading
                    ? "Извлекаем кадр…"
                    : "Кадр пока не готов."
                  : "Выберите файлы — покажу кадр из первого."}
          </p>
        </GlassCard>
      </div>
    </div>
    </>
  );
}

function PresetChip({
  name,
  active,
  confirmDelete,
  onPick,
  onDelete,
}: {
  name: string;
  active: boolean;
  confirmDelete: boolean;
  onPick: () => void;
  onDelete: () => void;
}) {
  return (
    <span
      className={`group inline-flex items-center rounded-full border text-xs overflow-hidden transition-colors ${
        active
          ? "border-gold-500/50 bg-gold-500/15 text-gold-200"
          : "border-white/10 bg-white/[0.03] text-zinc-300 hover:border-gold-500/30"
      }`}
    >
      <button
        type="button"
        onClick={onPick}
        className="px-2.5 py-1 hover:bg-white/[0.04]"
      >
        {name}
      </button>
      <button
        type="button"
        onClick={onDelete}
        title={confirmDelete ? "Кликните ещё раз чтобы удалить" : "Удалить пресет"}
        className={`pl-1 pr-2 py-1 border-l border-white/10 ${
          confirmDelete
            ? "bg-red-500/30 text-red-200"
            : "text-zinc-500 hover:text-red-300 hover:bg-red-500/10"
        }`}
      >
        {confirmDelete ? "✕?" : "✕"}
      </button>
    </span>
  );
}

function StyleForm({
  style,
  onChange,
  fonts,
}: {
  style: SubtitleStyle;
  onChange: (s: SubtitleStyle) => void;
  fonts: string[];
}) {
  const set = <K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) =>
    onChange({ ...style, [key]: value });

  const hasOutline = style.outline_width > 0;
  const hasShadow = style.shadow_offset > 0;
  const hasBg = style.border_style === 3;

  // Show only the margins that actually affect this alignment
  const isTop = style.alignment >= 7;
  const isMiddle = style.alignment >= 4 && style.alignment <= 6;
  const isLeft = style.alignment % 3 === 1;
  const isRight = style.alignment % 3 === 0;
  const showVertical = !isMiddle; // middle row anchors to centre, margin_v ignored
  const showLeft = isLeft;
  const showRight = isRight;

  return (
    <div className="grid gap-4 text-sm">
      <Row label="Шрифт">
        <Dropdown
          value={style.font_family}
          onChange={(v) => set("font_family", v)}
          searchable
          width="w-full"
          className="flex-1"
          items={[
            { value: style.font_family, label: style.font_family, hint: "текущий" },
            ...fonts
              .filter((f) => f !== style.font_family)
              .map((f) => ({ value: f, label: f })),
          ]}
          renderItem={(item) => (
            <span style={{ fontFamily: `"${item.value}", system-ui, sans-serif` }}>
              {item.label}
            </span>
          )}
          emptyText={fonts.length === 0 ? "Загрузка шрифтов…" : "Не найдено"}
        />
      </Row>

      <Row label={`Размер · ${style.font_size}px`}>
        <input
          type="range"
          min={16}
          max={120}
          step={1}
          value={style.font_size}
          onChange={(e) => set("font_size", Number(e.target.value))}
          className="flex-1 accent-gold-500"
        />
      </Row>

      <Row label="Цвет текста">
        <ColorInput
          value={style.primary_color}
          onChange={(v) => set("primary_color", v)}
        />
      </Row>

      <Row label="Стиль">
        <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={style.bold}
            onChange={(e) => set("bold", e.target.checked)}
            className="accent-gold-500"
          />
          Bold
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={style.italic}
            onChange={(e) => set("italic", e.target.checked)}
            className="accent-gold-500"
          />
          Italic
        </label>
      </Row>

      {/* Outline ----------------------------------------------------------- */}
      <ToggleSection
        label="Обводка"
        on={hasOutline}
        onToggle={(v) =>
          onChange({ ...style, outline_width: v ? (hasOutline ? style.outline_width : 2.5) : 0 })
        }
        disabled={hasBg}
        disabledHint={hasBg ? "Фон заменяет обводку" : undefined}
      >
        <Row label="Цвет">
          <ColorInput
            value={style.outline_color}
            onChange={(v) => set("outline_color", v)}
          />
        </Row>
        <Row label={`Толщина · ${style.outline_width.toFixed(1)}`}>
          <input
            type="range"
            min={0.5}
            max={8}
            step={0.5}
            value={style.outline_width}
            onChange={(e) => set("outline_width", Number(e.target.value))}
            className="flex-1 accent-gold-500"
          />
        </Row>
      </ToggleSection>

      {/* Shadow ------------------------------------------------------------ */}
      <ToggleSection
        label="Тень"
        on={hasShadow}
        onToggle={(v) =>
          onChange({
            ...style,
            shadow_offset: v ? (hasShadow ? style.shadow_offset : 1.5) : 0,
          })
        }
      >
        <Row label={`Смещение · ${style.shadow_offset.toFixed(1)}`}>
          <input
            type="range"
            min={0.5}
            max={8}
            step={0.5}
            value={style.shadow_offset}
            onChange={(e) => set("shadow_offset", Number(e.target.value))}
            className="flex-1 accent-gold-500"
          />
        </Row>
      </ToggleSection>

      {/* Background ------------------------------------------------------- */}
      <ToggleSection
        label="Фон"
        on={hasBg}
        onToggle={(v) => set("border_style", v ? 3 : 1)}
      >
        <Row label="Цвет">
          <ColorInput
            value={style.back_color}
            onChange={(v) => set("back_color", v)}
          />
        </Row>
        <Row label={`Толщина (padding) · ${style.bg_padding.toFixed(1)}`}>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={style.bg_padding}
            onChange={(e) => set("bg_padding", Number(e.target.value))}
            className="flex-1 accent-gold-500"
          />
        </Row>
      </ToggleSection>

      {/* Position --------------------------------------------------------- */}
      <Row label="Положение">
        <div className="grid grid-cols-3 gap-1">
          {ALIGNMENTS.map((a) => (
            <button
              key={a.code}
              type="button"
              onClick={() => set("alignment", a.code)}
              className={`w-9 h-9 rounded border text-base transition-colors ${
                style.alignment === a.code
                  ? "border-gold-500/60 bg-gold-500/15 text-gold-200"
                  : "border-white/10 bg-white/[0.02] text-zinc-400 hover:border-gold-500/30"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </Row>

      {/* Margins — only the relevant ones for the chosen alignment */}
      {showVertical && (
        <Row label={`${isTop ? "Отступ сверху" : "Отступ снизу"} · ${style.margin_v}px`}>
          <input
            type="range"
            min={0}
            max={500}
            step={2}
            value={style.margin_v}
            onChange={(e) => set("margin_v", Number(e.target.value))}
            className="flex-1 accent-gold-500"
          />
        </Row>
      )}
      {showLeft && (
        <Row label={`Отступ слева · ${style.margin_l}px`}>
          <input
            type="range"
            min={0}
            max={500}
            step={2}
            value={style.margin_l}
            onChange={(e) => set("margin_l", Number(e.target.value))}
            className="flex-1 accent-gold-500"
          />
        </Row>
      )}
      {showRight && (
        <Row label={`Отступ справа · ${style.margin_r}px`}>
          <input
            type="range"
            min={0}
            max={500}
            step={2}
            value={style.margin_r}
            onChange={(e) => set("margin_r", Number(e.target.value))}
            className="flex-1 accent-gold-500"
          />
        </Row>
      )}
    </div>
  );
}

function ToggleSection({
  label,
  on,
  onToggle,
  children,
  disabled = false,
  disabledHint,
}: {
  label: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <div
      className={`rounded-xl border ${on && !disabled ? "border-gold-500/25 bg-gold-500/[0.03]" : "border-white/[0.06] bg-white/[0.01]"} px-3 py-2.5 ${disabled ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs uppercase tracking-wide cursor-pointer select-none">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => onToggle(e.target.checked)}
            disabled={disabled}
            className="accent-gold-500 w-3.5 h-3.5"
          />
          <span className={on ? "text-gold-200" : "text-zinc-400"}>{label}</span>
        </label>
        {disabled && disabledHint && (
          <span className="text-[10px] text-zinc-500">{disabledHint}</span>
        )}
      </div>
      {on && !disabled && (
        <div className="mt-3 grid gap-3">{children}</div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-9 h-7 rounded border border-white/10 bg-transparent cursor-pointer"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 bg-bg-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-gold-500/50"
      />
    </>
  );
}

function PreviewBox({
  style,
  ratio,
  text,
  frameSrc,
  loading,
  hasVideo,
}: {
  style: SubtitleStyle;
  ratio: number;
  text: string;
  frameSrc: string | null;
  loading: boolean;
  hasVideo: boolean;
}) {
  const vAnchor = style.alignment >= 7 ? "top" : style.alignment >= 4 ? "middle" : "bottom";
  const hAnchor =
    style.alignment % 3 === 1 ? "left" : style.alignment % 3 === 2 ? "center" : "right";

  // Reference frame: pretend the source video is 1080-tall regardless of
  // ratio. That way changing the aspect rebases the preview's pixel scale,
  // keeping the relative placement of the subtitle close to the burned result.
  const refHeight = 1080;
  const refWidth = refHeight * ratio;
  // Container width is fixed by the parent grid; we compute scale from there.
  // Using CSS `aspect-ratio` we let the box pick its own pixels — for the text
  // we instead derive a scale from container width via container queries... or
  // a simpler approach: scale text from the ratio. Empirically a 0.04× factor
  // looks right for ~480-540px wide previews.
  const scale = 540 / refWidth; // adjusts so text size feels right at any ratio

  const outlineWidth = Math.max(0, style.outline_width);
  const outlineColor = style.outline_color;
  const hasBg = style.border_style === 3;

  const subStyle: React.CSSProperties = {
    position: "absolute",
    color: style.primary_color,
    fontFamily: `"${style.font_family}", system-ui, sans-serif`,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    fontSize: `${style.font_size * scale}px`,
    textAlign: hAnchor as "left" | "center" | "right",
    whiteSpace: "nowrap",
    lineHeight: 1.2,
  };

  if (!hasBg) {
    subStyle.textShadow = buildOutlineShadow(
      outlineColor,
      outlineWidth * scale,
      style.shadow_offset * scale,
    );
  } else {
    const a = Math.max(0, Math.min(100, style.back_alpha)) / 100;
    subStyle.backgroundColor = hexToRgba(style.back_color, a);
    subStyle.padding = `${style.bg_padding * scale * 0.6}px ${style.bg_padding * scale}px`;
    subStyle.borderRadius = "2px";
    if (style.shadow_offset > 0) {
      subStyle.boxShadow = `${style.shadow_offset * scale}px ${style.shadow_offset * scale}px 0 rgba(0,0,0,0.5)`;
    }
  }

  // Position
  if (vAnchor === "bottom") subStyle.bottom = `${style.margin_v * scale}px`;
  else if (vAnchor === "top") subStyle.top = `${style.margin_v * scale}px`;
  else {
    subStyle.top = "50%";
    subStyle.transform = "translateY(-50%)";
  }

  // Wrapper used for left/right margin + horizontal centring
  const lineWrap: React.CSSProperties = {
    position: "absolute",
    left: hAnchor === "left" ? `${style.margin_l * scale}px` : 0,
    right: hAnchor === "right" ? `${style.margin_r * scale}px` : 0,
    textAlign: hAnchor as "left" | "center" | "right",
  };
  if (vAnchor === "bottom") lineWrap.bottom = `${style.margin_v * scale}px`;
  else if (vAnchor === "top") lineWrap.top = `${style.margin_v * scale}px`;
  else {
    lineWrap.top = "50%";
    lineWrap.transform = "translateY(-50%)";
  }

  // Re-strip placement from inner span (it's on the wrapper now)
  delete subStyle.position;
  delete subStyle.top;
  delete subStyle.bottom;
  delete subStyle.transform;
  delete subStyle.textAlign;

  // Fit-to-box logic: cap by both height and width of the column. We want the
  // preview to *always* show the full frame (no overflow, no crop from the
  // wrong side). `width: min(100%, MAX_H * ratio)` lets wide formats expand
  // to the column edge but pulls vertical formats inwards so they never
  // overshoot MAX_H — `aspect-ratio` then derives the matching height.
  const MAX_H = 420;
  return (
    <div className="w-full flex justify-center">
    <div
      className="relative rounded-lg overflow-hidden border border-white/10 bg-gradient-to-br from-zinc-800 via-zinc-900 to-black"
      style={{
        aspectRatio: String(ratio),
        width: `min(100%, ${MAX_H * ratio}px)`,
        maxHeight: MAX_H,
      }}
    >
      {frameSrc ? (
        // Box ratio == video ratio, so `object-contain` shows the frame in
        // full — no crop, no letterbox in normal cases.
        <img
          src={frameSrc}
          alt=""
          className="absolute inset-0 w-full h-full object-contain"
          draggable={false}
        />
      ) : (
        <div
          className="absolute inset-0 opacity-30"
          style={{
            background:
              "radial-gradient(circle at 30% 40%, rgba(244,208,63,0.18), transparent 50%), radial-gradient(circle at 70% 70%, rgba(212,175,55,0.12), transparent 55%)",
          }}
        />
      )}
      {loading && (
        <div className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] bg-black/50 text-zinc-300 border border-white/10 backdrop-blur-sm">
          Рендерим…
        </div>
      )}
      {/* Without a real video we fall back to a CSS approximation so the
          form still feels alive. With a video, the styled PNG already has
          libass-rendered text — drawing on top would just double it. */}
      {!hasVideo && (
        <div style={lineWrap}>
          <span style={{ ...subStyle, display: "inline-block" }}>{text}</span>
        </div>
      )}
    </div>
    </div>
  );
}

const LOREM_WORDS =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(
    " ",
  );

/** Build a preview line at most `maxChars` characters long, joining whole
 *  Lorem words. If even the first word doesn't fit it gets truncated to
 *  the exact char budget so the user always sees a string of approx that
 *  visual length. */
function loremForLen(maxChars: number): string {
  let out = "";
  for (const w of LOREM_WORDS) {
    const cand = out ? out + " " + w : w;
    if (cand.length > maxChars) break;
    out = cand;
  }
  if (!out) return LOREM_WORDS[0].slice(0, Math.max(1, maxChars));
  return out;
}

function formatAspectLabel(ratio: number): string {
  // Snap to common social-media formats so the badge reads "1:1" not "1.00".
  const COMMON: { ratio: number; label: string }[] = [
    { ratio: 16 / 9, label: "16:9" },
    { ratio: 9 / 16, label: "9:16" },
    { ratio: 1, label: "1:1" },
    { ratio: 4 / 5, label: "4:5" },
    { ratio: 5 / 4, label: "5:4" },
    { ratio: 4 / 3, label: "4:3" },
    { ratio: 3 / 4, label: "3:4" },
    { ratio: 21 / 9, label: "21:9" },
  ];
  for (const c of COMMON) {
    if (Math.abs(ratio - c.ratio) < 0.02) return c.label;
  }
  return ratio.toFixed(2);
}

function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || "#000000").replace("#", "");
  const safe = h.length === 6 ? h : "000000";
  const r = parseInt(safe.slice(0, 2), 16);
  const g = parseInt(safe.slice(2, 4), 16);
  const b = parseInt(safe.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildOutlineShadow(color: string, width: number, shadow: number): string {
  if (width <= 0 && shadow <= 0) return "none";
  const offsets: [number, number][] = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ];
  const stamps = width > 0
    ? offsets.map(([dx, dy]) => `${dx * width}px ${dy * width}px 0 ${color}`).join(", ")
    : "";
  if (shadow > 0) {
    const drop = `${shadow}px ${shadow}px ${shadow * 1.2}px rgba(0,0,0,0.6)`;
    return stamps ? `${stamps}, ${drop}` : drop;
  }
  return stamps || "none";
}

function stylesEqual(a: SubtitleStyle, b: SubtitleStyle): boolean {
  return (
    a.font_family === b.font_family &&
    a.font_size === b.font_size &&
    a.primary_color.toLowerCase() === b.primary_color.toLowerCase() &&
    a.outline_color.toLowerCase() === b.outline_color.toLowerCase() &&
    a.back_color.toLowerCase() === b.back_color.toLowerCase() &&
    a.back_alpha === b.back_alpha &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    Math.abs(a.outline_width - b.outline_width) < 0.01 &&
    Math.abs(a.shadow_offset - b.shadow_offset) < 0.01 &&
    a.border_style === b.border_style &&
    a.alignment === b.alignment &&
    a.margin_v === b.margin_v &&
    a.margin_l === b.margin_l &&
    a.margin_r === b.margin_r &&
    Math.abs(a.bg_padding - b.bg_padding) < 0.01
  );
}
