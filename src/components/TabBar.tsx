import type { ComponentType } from "react";
import type { IconProps } from "./icons";

export type TabId = "main" | "style" | "queue" | "setup";

export type TabIcon = ComponentType<IconProps>;

interface Props {
  tabs: { id: TabId; label: string; icon: TabIcon }[];
  active: TabId;
  onChange: (id: TabId) => void;
  /** Tab ids that should show a small pulsing dot (e.g. background activity). */
  badged?: ReadonlySet<TabId>;
}

export function TabBar({ tabs, active, onChange, badged }: Props) {
  return (
    <nav className="flex items-center gap-1 p-1 rounded-xl glass">
      {tabs.map(({ id, label, icon: Icon }) => {
        const isActive = id === active;
        const showBadge = badged?.has(id) && !isActive;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={[
              "relative px-3 h-9 rounded-lg flex items-center gap-2 text-sm transition-all duration-200",
              isActive
                ? "bg-gold-500/15 text-gold-200 shadow-gold"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]",
            ].join(" ")}
          >
            <Icon size={14} className={isActive ? "text-gold-300" : ""} />
            {label}
            {showBadge && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-gold-300 animate-tab-pulse" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
