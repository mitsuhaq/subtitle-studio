/**
 * Four-field timecode editor: `H : MM : SS . CC` (centiseconds, 1/100 s).
 *
 * Centiseconds (not SMPTE frames) so we don't need to know FPS — works the
 * same on 24/25/30/60 fps and on variable-frame-rate phone footage. 1/100 s
 * is below the perceptible threshold for cuts, so users get frame-comparable
 * precision without the FPS-detection landmines.
 *
 * Each field is a plain controlled `<input type="text">` — typing immediately
 * propagates through `onChange`, no internal "editing/draft" state to get out
 * of sync with the parent. Selection-on-focus + arrow / wheel adjustments
 * cover the same UX as a stepper without needing a custom one.
 *
 * Field overflow cascades up the timeline: typing "65" into the seconds
 * field rolls over to +1 minute via partsToSeconds rather than capping at 59.
 */
export interface TimecodePickerProps {
  value: number; // seconds
  onChange: (next: number) => void;
  /** Hard upper bound — clamped on commit. */
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
        max={9}
        onCommit={(v) => commit({ ...parts, h: v })}
        disabled={disabled}
        ariaLabel="Часы"
      />
      <Sep />
      <Field
        value={parts.m}
        max={59}
        pad
        onCommit={(v) => commit({ ...parts, m: v })}
        disabled={disabled}
        ariaLabel="Минуты"
      />
      <Sep />
      <Field
        value={parts.s}
        max={59}
        pad
        onCommit={(v) => commit({ ...parts, s: v })}
        disabled={disabled}
        ariaLabel="Секунды"
      />
      <Sep dot />
      <Field
        value={parts.cc}
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
  /** Soft max for keyboard step / wheel — typing past it just rolls over via
   *  the parent's partsToSeconds, but keyboard +/- stops here. */
  max: number;
  /** Pad to two digits with a leading zero. The hour field skips this so
   *  short timecodes render as "1:02:03.04" instead of "01:02:03.04". */
  pad?: boolean;
  onCommit: (v: number) => void;
  disabled?: boolean;
  ariaLabel: string;
}

/// Single time-component editor. Stateless — re-derives display from `value`
/// every render and propagates each keystroke directly.
function Field({ value, max, pad, onCommit, disabled, ariaLabel }: FieldProps) {
  const display = pad ? String(value).padStart(2, "0") : String(value);

  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        // Strip non-digits so paste of "01:23" or "5 sec" still parses.
        // Keep only the last 3 chars so the field doesn't grow unboundedly
        // while a user is typing — partsToSeconds will roll the overflow up.
        const cleaned = e.target.value.replace(/\D+/g, "").slice(-3);
        onCommit(cleaned ? parseInt(cleaned, 10) : 0);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          onCommit(Math.min(value + 1, max));
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          onCommit(Math.max(value - 1, 0));
        }
      }}
      onWheel={(e) => {
        if (document.activeElement !== e.currentTarget) return;
        const delta = e.deltaY < 0 ? 1 : -1;
        onCommit(Math.max(0, Math.min(value + delta, max)));
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      className="bg-transparent text-zinc-100 text-[13px] tabular-nums text-center outline-none focus:text-gold-200 disabled:cursor-not-allowed"
      style={{ width: "2ch" }}
    />
  );
}

export function formatTimecode(seconds: number): string {
  const p = secondsToParts(seconds);
  return `${p.h}:${String(p.m).padStart(2, "0")}:${String(p.s).padStart(2, "0")}.${String(p.cc).padStart(2, "0")}`;
}
