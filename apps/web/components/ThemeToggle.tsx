"use client";

import { Select } from "./ui/Field";
import { useThemeBoot } from "./ThemeBootProvider";
import styles from "./ThemeToggle.module.css";

// Up to three themes: the segmented control; more: a Select. Hidden when the
// administrator has locked the choice. The current theme and the choice
// itself live in ThemeBootProvider, which also re-applies the rule when the
// boot data changes — so this control always shows what <html> has.
export function ThemeToggle() {
  const { boot, theme, choose } = useThemeBoot();

  if (boot.locked) return null;

  const current = theme ?? boot.defaultTheme;

  if (boot.themes.length > 3) {
    return (
      <Select aria-label="Tema" value={current} onChange={(e) => choose(e.target.value)} size="sm">
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
        <button key={t.id} data-active={current === t.id} onClick={() => choose(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
