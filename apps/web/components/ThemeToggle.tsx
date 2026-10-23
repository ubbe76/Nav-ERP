"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { THEME_STORAGE_KEY } from "../lib/themes";
import { Select } from "./ui/Field";
import { useThemeBoot } from "./ThemeBootProvider";
import styles from "./ThemeToggle.module.css";

// Up to three themes: the segmented control; more: a Select. Hidden when the
// administrator has locked the choice.
export function ThemeToggle() {
  const boot = useThemeBoot();
  const [theme, setTheme] = useState<string>(boot.defaultTheme);

  // The layout's boot script already applied the chosen theme before paint —
  // just mirror it into the control's state.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current) setTheme(current);
  }, []);

  if (boot.locked) return null;

  function select(next: string) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked — the choice still holds for this page view.
    }
    // Saved on the user so it follows them between computers. Errors are
    // ignored (403 for Endast läsning: the choice then lives in the browser).
    apiFetch("/api/v1/me/settings", { method: "PATCH", body: JSON.stringify({ theme: next }) }).catch(() => {});
  }

  if (boot.themes.length > 3) {
    return (
      <Select aria-label="Tema" value={theme} onChange={(e) => select(e.target.value)} size="sm">
        {boot.themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </Select>
    );
  }

  return (
    <div className={styles.segmented}>
      {boot.themes.map((t) => (
        <button key={t.id} data-active={theme === t.id} onClick={() => select(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
