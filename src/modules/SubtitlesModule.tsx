import { useState } from "react";
import { TabBar } from "../components/TabBar";
import type { TabId } from "../components/TabBar";
import {
  PixelFilm,
  PixelType,
  PixelList,
} from "../components/icons";
import MainTab from "../tabs/MainTab";
import StyleTab from "../tabs/StyleTab";
import QueueTab from "../tabs/QueueTab";
import { NavigationProvider } from "../state/navigation";
import { usePipeline } from "../state/usePipeline";

const SUB_TABS = [
  { id: "main" as const, label: "Main", icon: PixelFilm },
  { id: "style" as const, label: "Style", icon: PixelType },
  { id: "queue" as const, label: "Queue", icon: PixelList },
];

/**
 * Wraps the original Subtitles workflow (Main → Style → Queue wizard) into
 * one module so it lives alongside CorridorKey / Eye Contact / Audio Fix.
 * The TabBar moves *inside* the module — the top-level chrome only carries
 * module switching.
 */
export default function SubtitlesModule() {
  const [active, setActive] = useState<TabId>("main");
  const { state } = usePipeline();
  const queueIsHot =
    state.phase === "running" ||
    !!state.batch?.some((b) => b.status === "pending" || b.status === "running");
  const badged = new Set<TabId>(queueIsHot ? ["queue"] : []);

  return (
    <NavigationProvider active={active} goto={setActive}>
      <div className="flex flex-col">
        <div className="px-6 pt-6 flex justify-center">
          <TabBar
            tabs={SUB_TABS}
            active={active}
            onChange={setActive}
            badged={badged}
          />
        </div>
        <div>
          <Panel show={active === "main"}>
            <MainTab />
          </Panel>
          <Panel show={active === "style"}>
            <StyleTab />
          </Panel>
          <Panel show={active === "queue"}>
            <QueueTab />
          </Panel>
        </div>
      </div>
    </NavigationProvider>
  );
}

function Panel({
  show,
  children,
}: {
  show: boolean;
  children: React.ReactNode;
}) {
  return <div className={show ? "animate-fade-in" : "hidden"}>{children}</div>;
}
