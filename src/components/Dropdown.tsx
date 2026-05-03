import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface DropdownItem {
  value: string;
  label?: ReactNode;
  hint?: string;
}

interface DropdownProps {
  value: string;
  items: DropdownItem[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  emptyText?: string;
  className?: string;
  itemClassName?: string;
  /** Render a small badge / icon inside the trigger button (e.g. "*" for dirty) */
  trailing?: ReactNode;
  /** Render a custom preview for an item — shown both in trigger and rows. */
  renderItem?: (item: DropdownItem, opts: { active: boolean }) => ReactNode;
  width?: string; // tailwind width class for trigger (e.g. "w-48"); otherwise auto
}

/**
 * Custom select that ditches the OS-native chrome (looks awful on macOS) for a
 * frosted-glass popover that matches the rest of the app. Renders into a
 * portal so it can escape `overflow:hidden` parents, with positioning recalc'd
 * on resize / scroll.
 */
export function Dropdown({
  value,
  items,
  onChange,
  placeholder = "—",
  searchable = false,
  emptyText = "Ничего не найдено",
  className = "",
  itemClassName = "",
  trailing,
  renderItem,
  width,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = useMemo(
    () => items.find((i) => i.value === value) ?? null,
    [items, value],
  );

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return items;
    const q = query.trim().toLowerCase();
    return items.filter((i) =>
      (i.value + " " + (typeof i.label === "string" ? i.label : ""))
        .toLowerCase()
        .includes(q),
    );
  }, [items, query, searchable]);

  // Keep highlight inside filtered range
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered, highlight]);

  // Position popover under trigger and recalc on scroll/resize
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  // Click-outside / Esc to close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (
        !popRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter" && filtered[highlight]) {
        e.preventDefault();
        choose(filtered[highlight].value);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered, highlight]);

  // Focus search input when opened
  useEffect(() => {
    if (open && searchable) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, searchable]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  const triggerLabel = selected ? (
    renderItem ? (
      renderItem(selected, { active: false })
    ) : (
      (selected.label ?? selected.value)
    )
  ) : (
    <span className="text-zinc-500">{placeholder}</span>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        className={`relative inline-flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] hover:border-gold-500/30 text-sm text-zinc-200 transition-colors ${width ?? "min-w-[10rem]"} ${className}`}
      >
        <span className="truncate flex-1 text-left">{triggerLabel}</span>
        <span className="flex items-center gap-1 text-zinc-500 shrink-0">
          {trailing}
          <Caret open={open} />
        </span>
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={popRef}
            id={listId}
            role="listbox"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              minWidth: pos.width,
              zIndex: 1000,
            }}
            className="rounded-xl border border-white/10 bg-bg-900/95 backdrop-blur-xl shadow-2xl shadow-black/60 overflow-hidden animate-fade-in"
          >
            {searchable && (
              <div className="p-2 border-b border-white/[0.06]">
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                  placeholder="Поиск…"
                  className="w-full bg-bg-950/60 border border-white/10 rounded-md px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-gold-500/50"
                />
              </div>
            )}
            <div className="max-h-72 overflow-auto py-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs text-zinc-500">{emptyText}</div>
              ) : (
                filtered.map((item, idx) => {
                  const active = item.value === value;
                  const hot = idx === highlight;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => choose(item.value)}
                      onMouseEnter={() => setHighlight(idx)}
                      className={`w-full flex items-center justify-between gap-3 px-3 py-1.5 text-sm text-left transition-colors ${
                        active
                          ? "bg-gold-500/15 text-gold-200"
                          : hot
                            ? "bg-white/[0.07] text-zinc-100"
                            : "text-zinc-300"
                      } ${itemClassName}`}
                    >
                      <span className="truncate flex-1">
                        {renderItem
                          ? renderItem(item, { active })
                          : (item.label ?? item.value)}
                      </span>
                      {item.hint && (
                        <span className="text-[10px] text-zinc-500 shrink-0">
                          {item.hint}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
      fill="currentColor"
    >
      <path d="M1 3l4 4 4-4z" />
    </svg>
  );
}
