import { createContext, useContext, type ReactNode } from "react";
import type { TabId } from "../components/TabBar";

interface NavigationApi {
  active: TabId;
  goto: (tab: TabId) => void;
}

const NavigationContext = createContext<NavigationApi | null>(null);

export function NavigationProvider({
  active,
  goto,
  children,
}: NavigationApi & { children: ReactNode }) {
  return (
    <NavigationContext.Provider value={{ active, goto }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): NavigationApi {
  const ctx = useContext(NavigationContext);
  if (!ctx) {
    throw new Error("useNavigation must be used inside <NavigationProvider>");
  }
  return ctx;
}
