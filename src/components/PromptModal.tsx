import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PromptModalProps {
  open: boolean;
  title: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Replacement for `window.prompt`, which Tauri WkWebView silently no-ops on
 * macOS. Renders into a portal at body root so it escapes any
 * `overflow:hidden` parents.
 */
export function PromptModal({
  open,
  title,
  defaultValue = "",
  placeholder,
  okLabel = "Ок",
  cancelLabel = "Отмена",
  onSubmit,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-[min(420px,90vw)] rounded-2xl border border-white/10 bg-bg-900/95 backdrop-blur-xl shadow-2xl shadow-black/60 p-5"
      >
        <h3 className="text-sm font-semibold text-zinc-100 mb-3">{title}</h3>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-bg-950/60 border border-white/10 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-gold-500/50"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="submit"
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!value.trim()}
          >
            {okLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
