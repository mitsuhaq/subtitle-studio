import { useEffect } from "react";

type Combo =
  | "open" // Cmd/Ctrl+O
  | "edit" // Cmd/Ctrl+E
  | "escape" // Esc
  | "space"; // Space

type Handler = () => void;

interface Bindings {
  open?: Handler;
  edit?: Handler;
  escape?: Handler;
  space?: Handler;
  /** Skip the listener entirely when false (e.g. wrong tab is active). */
  enabled?: boolean;
}

const isMac = navigator.platform.toLowerCase().includes("mac");

function matchCombo(e: KeyboardEvent): Combo | null {
  const meta = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  if (meta && k === "o") return "open";
  if (meta && k === "e") return "edit";
  if (k === "escape") return "escape";
  if (k === " " || e.code === "Space") return "space";
  return null;
}

/**
 * Process-wide keyboard shortcuts. Each handler may be undefined to opt out;
 * an undefined handler means "let the browser do its thing". Bindings are
 * skipped when the user is typing into an input/textarea/contenteditable so
 * we don't hijack typing.
 */
export function useHotkeys(bindings: Bindings) {
  useEffect(() => {
    if (bindings.enabled === false) return;
    const onKey = (e: KeyboardEvent) => {
      const combo = matchCombo(e);
      if (!combo) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      const inField =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable;
      // Esc is always allowed (closes things, even from inside inputs).
      if (inField && combo !== "escape") return;
      const handler = bindings[combo];
      if (handler) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings]);
}
