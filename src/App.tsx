import React, { useState } from "react";
import { TabBar } from "./components/TabBar";
import type { TabId } from "./components/TabBar";
import { GoldenGlow } from "./components/GoldenGlow";
import { Logo } from "./components/Logo";
import {
  PixelFilm,
  PixelType,
  PixelList,
  PixelWrench,
} from "./components/icons";
import MainTab from "./tabs/MainTab";
import StyleTab from "./tabs/StyleTab";
import QueueTab from "./tabs/QueueTab";
import SetupTab from "./tabs/SetupTab";
import { PipelineProvider, usePipeline } from "./state/usePipeline";
import { NavigationProvider } from "./state/navigation";
import { useHotkeys } from "./state/hotkeys";

const TABS = [
  { id: "main" as const, label: "Main", icon: PixelFilm },
  { id: "style" as const, label: "Style", icon: PixelType },
  { id: "queue" as const, label: "Queue", icon: PixelList },
  { id: "setup" as const, label: "Setup", icon: PixelWrench },
];

export default function App() {
  const [active, setActive] = useState<TabId>("main");

  return (
    <PipelineProvider>
      <NavigationProvider active={active} goto={setActive}>
        <GlobalHotkeys active={active} setActive={setActive} />
        <Shell active={active} setActive={setActive} />
      </NavigationProvider>
    </PipelineProvider>
  );
}

/** Owns the layout chrome and reads pipeline state to badge tabs. */
function Shell({
  active,
  setActive,
}: {
  active: TabId;
  setActive: (t: TabId) => void;
}) {
  const { state } = usePipeline();
  // Badge Queue when something is happening but we're looking at another
  // tab — gives a hint that progress is running in the background.
  const queueIsHot =
    state.phase === "running" ||
    !!state.batch?.some((b) => b.status === "pending" || b.status === "running");
  const badged = new Set<TabId>(queueIsHot ? ["queue"] : []);
  return (
    <div className="relative h-screen w-screen overflow-hidden flex flex-col font-sans">
      <GoldenGlow />
      <header className="relative z-10 flex items-center justify-between px-6 h-14 border-b border-white/[0.05] glass">
        <div className="flex items-center gap-3 min-w-[200px]">
          <LogoBadge />
          <div className="leading-tight">
            <div className="text-sm font-semibold text-zinc-100">
              Subtitle Studio
            </div>
            <div className="text-[11px] text-zinc-500">
              Whisper · FFmpeg · Portable
            </div>
          </div>
        </div>
        <TabBar tabs={TABS} active={active} onChange={setActive} badged={badged} />
        <div className="min-w-[200px]" />
      </header>
      <main className="relative z-10 flex-1 overflow-auto">
        <TabPanel show={active === "main"}><MainTab /></TabPanel>
        <TabPanel show={active === "style"}><StyleTab /></TabPanel>
        <TabPanel show={active === "queue"}><QueueTab /></TabPanel>
        <TabPanel show={active === "setup"}><SetupTab /></TabPanel>
      </main>
    </div>
  );
}

/**
 * Keep every tab mounted so component state (selected file, sidecar status,
 * progress subscriptions) survives a tab switch — `hidden` just toggles
 * visibility without unmounting.
 */
function TabPanel({ show, children }: { show: boolean; children: React.ReactNode }) {
  return <div className={show ? "animate-fade-in" : "hidden"}>{children}</div>;
}

/**
 * Process-wide shortcuts that don't depend on which tab is open:
 *   Cmd/Ctrl+O — open file picker
 *   Esc        — cancel running job, otherwise return to Main
 * Tab-specific shortcuts (Space on Style, etc.) live in their own tab.
 */
function GlobalHotkeys({
  active,
  setActive,
}: {
  active: TabId;
  setActive: (t: TabId) => void;
}) {
  const { state, browse, cancel } = usePipeline();
  const isRunning = state.phase === "running";
  useHotkeys({
    open: browse,
    escape: () => {
      if (isRunning) {
        cancel();
        return;
      }
      if (active !== "main") setActive("main");
    },
  });
  return null;
}

/**
 * Mini iOS-style "Liquid Glass" squircle that wraps the pixel logo: dark
 * base, soft gold inner glow, top half glass highlight, gold rim.
 */
function LogoBadge() {
  return (
    <div className="relative w-9 h-9 rounded-[10px] overflow-hidden grid place-items-center shadow-gold border border-gold-500/40">
      {/* base gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-bg-700 to-bg-950" />
      {/* gold radial glow */}
      <div
        className="absolute inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(circle at 30% 30%, rgba(244,208,63,0.55), rgba(212,175,55,0) 70%)",
        }}
      />
      {/* glass highlight */}
      <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/15 to-transparent pointer-events-none" />
      <Logo size={22} className="relative z-10" />
    </div>
  );
}
