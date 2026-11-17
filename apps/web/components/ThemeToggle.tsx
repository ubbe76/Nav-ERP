"use client";

import { Select } from "./ui/Field";
import { useThemeBoot } from "./ThemeBootProvider";
import styles from "./ThemeToggle.module.css";

// Up to three themes: the segmented control; more: a Select. Hidden when the
// administrator has locked the choice. The current theme and the choice
// itself live in ThemeBootProvider, which also re-applies the rule when the
// boot data changes — so this control always shows what <html> has.
//
// browserOnly (the login page): the choice is kept in this browser only —
// there is no signed-in user to save it on. After a login the user's own
// saved choice, if any, takes over (selectTheme).
export function ThemeToggle({ browserOnly = false }: { browserOnly?: boolean }) {
  const { boot, theme, choose } = useThemeBoot();

  if (boot.locked) return null;

  const current = theme ?? boot.defaultTheme;
  const pick = (id: string) => choose(id, { browserOnly });

  if (boot.themes.length > 3) {
    return (
      <Select aria-label="Tema" value={current} onChange={(e) => pick(e.target.value)} size="sm">
        {boot.themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </Select>
    );
  }

  // Until the provider's first effect has read this browser's choice, no
  // segment is marked — on a visible control (the login page) the default
  // would otherwise light up for a moment before the stored theme.
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="Tema">
      {boot.themes.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={theme === t.id}
          data-active={theme === t.id}
          onClick={() => pick(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
