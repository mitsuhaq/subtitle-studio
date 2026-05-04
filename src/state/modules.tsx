import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  PixelCaption,
  PixelKey,
  PixelMic,
  PixelScissors,
  PixelToolbox,
} from "../components/icons";
import type { IconProps } from "../components/icons";

export type ModuleId =
  | "subtitles"
  | "corridor_key"
  | "rotobrush"
  | "audio_fix"
  | "utils";

export interface ModuleDef {
  id: ModuleId;
  name: string;
  /** One-line teaser shown in the drawer + on the locked screen. */
  tagline: string;
  icon: React.ComponentType<IconProps>;
  /** Human-readable list of components that must be installed in Setup
   * before the module unlocks. Empty for ones that work out-of-the-box. */
  requires: string[];
}

export const MODULES: ModuleDef[] = [
  {
    id: "subtitles",
    name: "Субтитры",
    tagline: "Транскрипция Whisper + вшивание FFmpeg.",
    icon: PixelCaption,
    requires: ["Whisper large-v3", "FFmpeg"],
  },
  {
    id: "corridor_key",
    name: "CorridorKey",
    tagline: "Удаление зелёного фона нейросетью.",
    icon: PixelKey,
    requires: ["Robust Video Matting"],
  },
  {
    id: "rotobrush",
    name: "Rotobrush",
    tagline: "Вырезать человека с любого фона (без зелёнки).",
    icon: PixelScissors,
    requires: ["Robust Video Matting"],
  },
  {
    id: "audio_fix",
    name: "Audio Fix",
    tagline: "Шумоподавление и нормализация громкости.",
    icon: PixelMic,
    requires: ["DeepFilterNet"],
  },
  {
    id: "utils",
    name: "Утилиты",
    tagline: "Обрезка, перекодировка, оверлей картинки.",
    icon: PixelToolbox,
    requires: [],
  },
];

interface ModulesApi {
  active: ModuleId;
  setActive: (id: ModuleId) => void;
  /** Whether a given module is unlocked (its requirements are installed). */
  isAvailable: (id: ModuleId) => boolean;
  /** Mark a module as available — called by Setup when its components install. */
  setAvailability: (id: ModuleId, available: boolean) => void;
}

const ModulesContext = createContext<ModulesApi | null>(null);

export function ModulesProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ModuleId>("subtitles");
  // Subtitles is the only module with a real backend right now — start it
  // unlocked so the existing flow keeps working. Setup will flip the others
  // on once their components install.
  const [available, setAvailable] = useState<Record<ModuleId, boolean>>({
    subtitles: true,
    corridor_key: false,
    rotobrush: false,
    audio_fix: false,
    // Utils: pure FFmpeg, always available.
    utils: true,
  });

  const isAvailable = useCallback(
    (id: ModuleId) => available[id] ?? false,
    [available],
  );
  const setAvailability = useCallback(
    (id: ModuleId, value: boolean) =>
      setAvailable((cur) => (cur[id] === value ? cur : { ...cur, [id]: value })),
    [],
  );

  const value = useMemo<ModulesApi>(
    () => ({ active, setActive, isAvailable, setAvailability }),
    [active, isAvailable, setAvailability],
  );

  return (
    <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>
  );
}

export function useModules(): ModulesApi {
  const ctx = useContext(ModulesContext);
  if (!ctx) throw new Error("useModules must be used inside <ModulesProvider>");
  return ctx;
}
