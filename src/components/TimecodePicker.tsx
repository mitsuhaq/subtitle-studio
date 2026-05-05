import { useEffect, useRef, useState } from "react";

/**
 * Four-field timecode editor: `H : MM : SS . CC` (centiseconds, 1/100 s).
 *
 * Why centiseconds and not SMPTE frames: kadровая точность тащит за собой
 * необходимость знать FPS источника, и кадровый счётчик ломается на
 * variable-frame-rate записях (телефонные камеры). 100-я доля секунды даёт
 * точность ниже человеческого порога восприятия и работает на любом видео.
 *
 * Каждое поле редактируется напрямую (клик → ввод) и/или со стрелок на
 * клавиатуре / колёсиком мыши. Переполнение поля каскадно бамает старшее
 * (секунды 59 → 60 при +1 → секунды 0 + минуты +1).
 */
export interface TimecodePickerProps {
  value: number; // seconds
  onChange: (next: number) => void;
  /** Hard upper bound — if `value` would exceed `max`, it's clamped on commit. */
  max: number;
  /** Hard lower bound. Defaults to 0. */
  min?: number;
  disabled?: boolean;
}

interface Parts {
  h: number;
  m: number;
  s: number;
  cc: number;
}

function secondsToParts(t: number): Parts {
  const clamped = Math.max(0, t);
  const totalCs = Math.round(clamped * 100);
  const cc = totalCs % 100;
  const totalS = Math.floor(totalCs / 100);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  return { h, m, s, cc };
}

function partsToSeconds(p: Parts): number {
  return p.h * 3600 + p.m * 60 + p.s + p.cc / 100;
}

export function TimecodePicker({
  value,
  onChange,
  max,
  min = 0,
  disabled,
}: TimecodePickerProps) {
  const parts = secondsToParts(value);

  const commit = (next: Parts) => {
    let secs = partsToSeconds(next);
    if (secs < min) secs = min;
    if (secs > max) secs = max;
    onChange(secs);
  };

  return (
    <div
      className={`inline-flex items-center gap-0.5 px-2.5 py-1.5 rounded-md border bg-white/[0.03] ${
        disabled
          ? "border-white/[0.04] opacity-50"
          : "border-white/10 focus-within:border-gold-500/50"
      }`}
    >
      <Field
        value={parts.h}
        width={2}
        max={9}
        onCommit={(v) => commit({ ...parts, h: v })}
        disabled={disabled}
        ariaLabel="Часы"
      />
      <Sep />
      <Field
        value={parts.m}
        width={2}
        max={59}
        pad
        onCommit={(v) => commit({ ...parts, m: v })}
        disabled={disabled}
        ariaLabel="Минуты"
      />
      <Sep />
      <Field
        value={parts.s}
        width={2}
        max={59}
        pad
        onCommit={(v) => commit({ ...parts, s: v })}
        disabled={disabled}
        ariaLabel="Секунды"
      />
      <Sep dot />
      <Field
        value={parts.cc}
        width={2}
        max={99}
        pad
        onCommit={(v) => commit({ ...parts, cc: v })}
        disabled={disabled}
        ariaLabel="Сотые секунды"
      />
    </div>
  );
}

function Sep({ dot = false }: { dot?: boolean }) {
  return (
    <span className="text-zinc-500 text-[13px] select-none px-0.5">
      {dot ? "." : ":"}
    </span>
  );
}

interface FieldProps {
  value: number;
  width: number;
  max: number;
  /** Pad with leading zero to `width` digits. The leftmost field skips this
   *  so "1:02:03.04" renders without a leading "01" hour. */
  pad?: boolean;
  onCommit: (v: number) => void;
  disabled?: boolean;
  ariaLabel: string;
}

/** Single time-component editor — keeps a string draft so the user can type
 *  freely (delete+retype) without the field snapping to a partial value. */
function Field({
  value,
  width,
  max,
  pad,
  onCommit,
  disabled,
  ariaLabel,
}: FieldProps) {
  const [draft, setDraft] = useState<string>(format(value, pad, width));
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  // Sync draft from outside when not actively editing.
  useEffect(() => {
    if (!editing) setDraft(format(value, pad, width));
  }, [value, pad, width, editing]);

  const submit = (raw: string) => {
    const cleaned = raw.replace(/\D+/g, "");
    let n = cleaned ? parseInt(cleaned, 10) : 0;
    if (Number.isNaN(n)) n = 0;
    // Don't clamp to component-local `max` here — let the parent re-clamp
    // against the global timeline so e.g. typing "65" into seconds rolls
    // over into minutes via partsToSeconds rather than capping at 59.
    onCommit(n);
  };

  return (
    <input
      ref={ref}
      type="text"
      inputMode="numeric"
      value={editing ? draft : format(value, pad, width)}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        submit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          onCommit(Math.min(value + 1, max));
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          onCommit(Math.max(value - 1, 0));
        } else if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(format(value, pad, width));
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
      onWheel={(e) => {
        if (document.activeElement !== e.currentTarget) return;
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1 : -1;
        onCommit(Math.max(0, Math.min(value + delta, max)));
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      className="bg-transparent text-zinc-100 text-[13px] tabular-nums text-center outline-none w-[2ch] focus:text-gold-200"
      style={{ width: `${width}ch` }}
    />
  );
}

function format(n: number, pad: boolean | undefined, width: number): string {
  const s = String(Math.max(0, Math.floor(n)));
  if (!pad) return s;
  return s.padStart(width, "0");
}

export function formatTimecode(seconds: number): string {
  const p = secondsToParts(seconds);
  return `${p.h}:${String(p.m).padStart(2, "0")}:${String(p.s).padStart(2, "0")}.${String(p.cc).padStart(2, "0")}`;
}
