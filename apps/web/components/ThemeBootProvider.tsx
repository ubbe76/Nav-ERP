"use client";

import { createContext, useContext, type ReactNode } from "react";
import { FALLBACK_THEME_BOOT } from "../lib/themes";
import type { ThemeBoot } from "../lib/types";

// The root layout's GET /theme-boot answer, for ThemeToggle: which themes
// exist and whether the choice is locked.
const ThemeBootContext = createContext<ThemeBoot>(FALLBACK_THEME_BOOT);

export function ThemeBootProvider({ boot, children }: { boot: ThemeBoot; children: ReactNode }) {
  return <ThemeBootContext.Provider value={boot}>{children}</ThemeBootContext.Provider>;
}

export function useThemeBoot(): ThemeBoot {
  return useContext(ThemeBootContext);
}
