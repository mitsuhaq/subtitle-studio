import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useModules } from "./modules";
import type { ModuleId } from "./modules";

/**
 * Subscribe a single module to drag-and-drop into the window. The handler
 * only fires when *this* module is currently active — otherwise the same
 * files would feed every module's queue simultaneously.
 *
 * The Setup overlay is treated as "no active module" — drops while Setup
 * is on top are ignored, since Setup itself doesn't accept files.
 */
export function useModuleDrop(
  moduleId: ModuleId,
  handler: (paths: string[]) => void,
) {
  const { active } = useModules();
  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        if (active !== moduleId) return;
        handler(event.payload.paths);
      })
      .then((un) => {
        if (aborted) un();
        else unlisten = un;
      });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [active, moduleId, handler]);
}
