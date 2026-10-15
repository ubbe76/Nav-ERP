"use client";

import { useEffect, useState } from "react";
import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY, isThemeId, type ThemeId } from "../lib/themes";
import styles from "./ThemeToggle.module.css";

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);

  // The layout's boot script already applied the stored theme before paint —
  // just mirror it into the toggle's state.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (isThemeId(current)) setTheme(current);
  }, []);

  function select(next: ThemeId) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked — the choice still holds for this page view.
    }
  }

  return (
    <div className={styles.segmented}>
      {THEMES.map((t) => (
        <button key={t.id} data-active={theme === t.id} onClick={() => select(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
