"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "../lib/api";
import { FALLBACK_THEME_BOOT, readStoredTheme, selectTheme, THEME_STORAGE_KEY } from "../lib/themes";
import type { ThemeBootClient } from "../lib/types";

interface ThemeBootValue {
  // The root layout's GET /theme-boot answer (without the CSS): which themes
  // exist and whether the choice is locked.
  boot: ThemeBootClient;
  // The theme on <html data-theme> right now (null before the first effect).
  theme: string | null;
  // The theme picker's choice: applied, stored in this browser and saved on
  // the user.
  choose: (id: string) => void;
}

const ThemeBootContext = createContext<ThemeBootValue>({ boot: FALLBACK_THEME_BOOT, theme: null, choose: () => {} });

function applyTheme(id: string) {
  if (document.documentElement.getAttribute("data-theme") !== id) document.documentElement.setAttribute("data-theme", id);
}

export function ThemeBootProvider({ boot, children }: { boot: ThemeBootClient; children: ReactNode }) {
  const [theme, setTheme] = useState<string | null>(null);
  const ids = useMemo(() => boot.themes.map((t) => t.id), [boot.themes]);
  const idsKey = ids.join(" ");

  // The boot script applied the theme before first paint, but it runs once
  // per full page load. A router.refresh() hands this provider new boot data
  // — after a client-side login, a new company default, the lock, a deleted
  // theme — so the same rule (selectTheme) runs again here; on the first
  // run it agrees with the script.
  useEffect(() => {
    const next = selectTheme(ids, boot.defaultTheme, boot.locked, boot.userTheme, readStoredTheme());
    applyTheme(next);
    setTheme(next);
    // ids is keyed by idsKey: a new array with the same ids is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, boot.defaultTheme, boot.locked, boot.userTheme]);

  const choose = useCallback((id: string) => {
    applyTheme(id);
    setTheme(id);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      // Storage blocked — the choice still holds for this page view.
    }
    // Saved on the user so it follows them between computers. Errors are
    // ignored: the choice then lives in this browser.
    apiFetch("/api/v1/me/settings", { method: "PATCH", body: JSON.stringify({ theme: id }) }).catch(() => {});
  }, []);

  const value = useMemo(() => ({ boot, theme, choose }), [boot, theme, choose]);
  return <ThemeBootContext.Provider value={value}>{children}</ThemeBootContext.Provider>;
}

export function useThemeBoot(): ThemeBootValue {
  return useContext(ThemeBootContext);
}
