import React, { useState } from "react";
import { GoldenGlow } from "./components/GoldenGlow";
import { Logo } from "./components/Logo";
import { SideDrawer } from "./components/SideDrawer";
import { MODULES, ModulesProvider, useModules } from "./state/modules";
import type { ModuleId } from "./state/modules";
import { PipelineProvider, usePipeline } from "./state/usePipeline";
import { UpdaterProvider } from "./state/updater";
import { UpdateBanner } from "./components/UpdateBanner";
import { useHotkeys } from "./state/hotkeys";
import SubtitlesModule from "./modules/SubtitlesModule";
import CorridorKeyModule from "./modules/CorridorKeyModule";
import RotobrushModule from "./modules/RotobrushModule";
import AudioFixModule from "./modules/AudioFixModule";
import VocalSplitModule from "./modules/VocalSplitModule";
import LogoRemoverModule from "./modules/LogoRemoverModule";
import UtilsModule from "./modules/UtilsModule";
import SetupTab from "./tabs/SetupTab";
import { PixelArrowLeft, PixelWrench } from "./components/icons";

export default function App() {
  return (
    <PipelineProvider>
      <ModulesProvider>
        <UpdaterProvider>
          <Shell />
        </UpdaterProvider>
      </ModulesProvider>
    </PipelineProvider>
  );
}

/** Top-level chrome: header with logo-as-menu-button + the active module's
 *  body. Setup is treated as an overlay screen rather than a module so it
 *  never gets locked behind installs. */
function Shell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const { active } = useModules();

  // Cmd/Ctrl+O = open file (only meaningful inside a module that uses it),
  // Esc = close any open overlay first, otherwise let modules handle it.
  const { state, browse, cancel } = usePipeline();
  const isRunning = state.phase === "running";
  useHotkeys({
    open: browse,
    escape: () => {
      if (drawerOpen) {
        setDrawerOpen(false);
        return;
      }
      if (setupOpen) {
        setSetupOpen(false);
        return;
      }
      if (isRunning) cancel();
    },
  });

  return (
    <div className="relative h-screen w-screen overflow-hidden flex flex-col font-sans">
      <GoldenGlow />
      <header className="relative z-10 flex items-center justify-between px-4 h-14 border-b border-white/[0.05] glass">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="relative w-9 h-9 rounded-[10px] overflow-hidden grid place-items-center shadow-gold border border-gold-500/40 hover:shadow-goldStrong hover:border-gold-400/60 transition-all duration-200 active:scale-[0.96]"
            title="Меню модулей"
            aria-label="Открыть меню"
          >
            <div className="absolute inset-0 bg-gradient-to-b from-bg-700 to-bg-950" />
            <div
              className="absolute inset-0 opacity-80"
              style={{
                background:
                  "radial-gradient(circle at 30% 30%, rgba(244,208,63,0.55), rgba(212,175,55,0) 70%)",
              }}
            />
            <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/15 to-transparent pointer-events-none" />
            <Logo size={22} className="relative z-10" />
          </button>
          {setupOpen ? <SetupHeader /> : <ModuleHeader />}
        </div>
        <div className="flex items-center gap-2">
          {setupOpen && (
            <button
              type="button"
              onClick={() => setSetupOpen(false)}
              className="btn-ghost"
            >
              <PixelArrowLeft size={14} />
              <span>К модулю</span>
            </button>
          )}
        </div>
      </header>
      <main className="relative z-10 flex-1 overflow-auto">
        {/* Every module + Setup stays mounted so switching is instant — no
            re-fetch of sidecar status, fonts, presets, or preview frames.
            That re-mount was the source of the half-second freeze. */}
        {MODULES.map((m) => {
          const Component = MODULE_BY_ID[m.id];
          const visible = !setupOpen && active === m.id;
          return (
            <div key={m.id} className={visible ? "block" : "hidden"}>
              <Component />
            </div>
          );
        })}
        <div className={setupOpen ? "block" : "hidden"}>
          <SetupTab />
        </div>
      </main>

      <SideDrawer
        open={drawerOpen}
        setupOpen={setupOpen}
        onClose={() => setDrawerOpen(false)}
        onOpenSetup={() => setSetupOpen(true)}
        onModulePick={() => setSetupOpen(false)}
      />
      <UpdateBanner />
    </div>
  );
}

function SetupHeader() {
  return (
    <div className="flex items-center gap-2 leading-tight">
      <PixelWrench size={14} className="text-gold-300/80" />
      <div>
        <div className="text-sm font-semibold text-zinc-100">Setup</div>
        <div className="text-[11px] text-zinc-500">
          Установка и обновления
        </div>
      </div>
    </div>
  );
}

function ModuleHeader() {
  const { active } = useModules();
  const def = MODULES.find((m) => m.id === active);
  if (!def) return null;
  const Icon = def.icon;
  return (
    <div className="flex items-center gap-2 leading-tight">
      <Icon size={14} className="text-gold-300/80" />
      <div>
        <div className="text-sm font-semibold text-zinc-100">{def.name}</div>
        <div className="text-[11px] text-zinc-500">{def.tagline}</div>
      </div>
    </div>
  );
}

const MODULE_BY_ID: Record<ModuleId, React.ComponentType> = {
  subtitles: SubtitlesModule,
  corridor_key: CorridorKeyModule,
  rotobrush: RotobrushModule,
  audio_fix: AudioFixModule,
  vocal_split: VocalSplitModule,
  logo_remover: LogoRemoverModule,
  utils: UtilsModule,
};
