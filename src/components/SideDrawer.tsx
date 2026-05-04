import { useEffect } from "react";
import { createPortal } from "react-dom";
import { MODULES, useModules } from "../state/modules";
import type { ModuleId } from "../state/modules";
import { PixelDiamond, PixelWrench } from "./icons";

interface Props {
  open: boolean;
  setupOpen: boolean;
  onClose: () => void;
  onOpenSetup: () => void;
  /** Called whenever a module is picked — Shell uses it to close any
   *  fullscreen overlay (e.g. Setup) so we land on the chosen module. */
  onModulePick: () => void;
}

/**
 * Slide-from-left drawer that lists every module + the Setup shortcut.
 * Locked modules are still shown but greyed out with a hint about which
 * components need to install before they unlock.
 */
export function SideDrawer({
  open,
  setupOpen,
  onClose,
  onOpenSetup,
  onModulePick,
}: Props) {
  const { active, setActive, isAvailable } = useModules();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return createPortal(
    <>
      <div
        className={`fixed inset-0 z-[900] bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />
      <aside
        className={`fixed left-0 top-0 z-[901] h-screen w-72 bg-bg-950/85 backdrop-blur-2xl border-r border-white/[0.08] flex flex-col transition-transform duration-200 shadow-[8px_0_40px_-8px_rgba(0,0,0,0.6)] ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-white/[0.06]">
          <PixelDiamond size={18} className="text-gold-300" />
          <div className="leading-tight">
            <div className="text-sm font-semibold text-zinc-100">
              Zonthor Studio
            </div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wide">
              Модули
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-auto p-2.5 grid gap-1.5">
          {MODULES.map((m) => {
            const Icon = m.icon;
            const available = isAvailable(m.id);
            // Active highlight only when the module is *visible*. If Setup
            // is on top, we don't want any module to look "current" — that
            // was the bug where Subtitles still glowed gold while Setup
            // covered the screen.
            const isActive = active === m.id && !setupOpen;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  if (!available) return;
                  setActive(m.id);
                  onModulePick();
                  onClose();
                }}
                disabled={!available}
                className={`group flex items-start gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                  isActive
                    ? "bg-gold-500/15 border-gold-500/40 text-gold-200"
                    : available
                      ? "bg-white/[0.03] border-white/[0.06] text-zinc-200 hover:border-gold-500/30 hover:bg-white/[0.06]"
                      : "bg-white/[0.01] border-white/[0.04] text-zinc-600 cursor-not-allowed"
                }`}
              >
                <Icon
                  size={16}
                  className={
                    isActive
                      ? "text-gold-300 mt-0.5"
                      : available
                        ? "text-gold-300/80 mt-0.5"
                        : "text-zinc-700 mt-0.5"
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium flex items-center gap-2">
                    {m.name}
                    {!available && (
                      <span className="text-[9px] uppercase tracking-wide text-zinc-600 px-1.5 py-0.5 border border-white/[0.06] rounded">
                        не установлено
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5 leading-snug">
                    {m.tagline}
                  </div>
                  {!available && m.requires.length > 0 && (
                    <div className="text-[10px] text-zinc-600 mt-1.5">
                      Нужно: {m.requires.join(", ")}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </nav>

        <div className="p-2.5 border-t border-white/[0.06]">
          <button
            type="button"
            onClick={() => {
              onOpenSetup();
              onClose();
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-colors ${
              setupOpen
                ? "bg-gold-500/15 border-gold-500/40 text-gold-200"
                : "bg-white/[0.03] border-white/[0.06] text-zinc-200 hover:border-gold-500/30 hover:bg-white/[0.06]"
            }`}
          >
            <PixelWrench
              size={16}
              className={setupOpen ? "text-gold-300" : "text-gold-300/80"}
            />
            <div className="min-w-0 flex-1 text-left">
              <div className="text-[13px] font-medium">Setup</div>
              <div
                className={`text-[11px] ${
                  setupOpen ? "text-gold-200/70" : "text-zinc-500"
                }`}
              >
                Установка моделей и зависимостей
              </div>
            </div>
          </button>
        </div>
      </aside>
    </>,
    document.body,
  );
}

/** Convenience guard component — wraps a locked module so its content is
 *  hidden behind a "go install X" call to action. */
export function ModuleGate({
  moduleId,
  children,
}: {
  moduleId: ModuleId;
  children: React.ReactNode;
}) {
  const { isAvailable } = useModules();
  if (isAvailable(moduleId)) return <>{children}</>;
  const def = MODULES.find((m) => m.id === moduleId);
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="glass rounded-2xl p-6 text-center space-y-3">
        <div className="text-sm text-zinc-400">Модуль ещё не активирован</div>
        <div className="text-base text-zinc-100">{def?.name ?? moduleId}</div>
        {def && (
          <>
            <div className="text-sm text-zinc-500 max-w-md mx-auto">
              {def.tagline}
            </div>
            {def.requires.length > 0 && (
              <div className="text-[12px] text-zinc-500 mt-2">
                Установите{" "}
                <span className="text-gold-300/90">
                  {def.requires.join(", ")}
                </span>{" "}
                во вкладке Setup, чтобы активировать.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
