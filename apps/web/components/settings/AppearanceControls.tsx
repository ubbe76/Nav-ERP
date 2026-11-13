"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ThemeToggle } from "../ThemeToggle";
import { useUserPrefs } from "../UserPrefsProvider";
import { useFavorites } from "../FavoritesProvider";
import { useThemeBoot } from "../ThemeBootProvider";
import { DENSITY_LABELS, TABLE_DENSITIES } from "../../lib/listColumns";
import { FAVORITES_PLACEMENTS, FAVORITES_PLACEMENT_LABELS, favoritesPlacement, type FavoritesPlacement } from "../../lib/overviewCards";
import segmentedStyles from "../ThemeToggle.module.css";

// Tema, Täthet, Dokument i flikar and Favoriter — the user menu's settings,
// also shown on Mina inställningar (the user's choice 2026-11-13: copied to
// the page, nothing moved out of the menu yet). One component, so the two
// places can never disagree; each passes its own section/label classes.
export function AppearanceControls({ classes }: { classes: { section?: string; label?: string } }) {
  const router = useRouter();
  const pathname = usePathname();
  const { boot } = useThemeBoot();
  const { density, setDensity, documentTabs, setDocumentTabs } = useUserPrefs();
  const { favorites, inSidebar, onOverview, setPlacement } = useFavorites();
  const [placementSaving, setPlacementSaving] = useState(false);
  const placement = favoritesPlacement(inSidebar, onOverview);

  async function choosePlacement(next: FavoritesPlacement) {
    if (next === placement || placementSaving) return;
    setPlacementSaving(true);
    const saved = await setPlacement(next);
    setPlacementSaving(false);
    // Översikten draws its cards on the server.
    if (saved && pathname === "/") router.refresh();
  }

  return (
    <>
      {/* An administrator may lock the theme (System → Teman). */}
      {!boot.locked && (
        <div className={classes.section}>
          <span className={classes.label}>Tema</span>
          <ThemeToggle />
        </div>
      )}
      {/* Täthet (Nav som program, punkt 6): the row height of the tables. */}
      <div className={classes.section}>
        <span className={classes.label}>Täthet</span>
        <div className={segmentedStyles.segmented} role="radiogroup" aria-label="Täthet">
          {TABLE_DENSITIES.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={density === d}
              data-active={density === d}
              onClick={() => setDensity(d)}
            >
              {DENSITY_LABELS[d]}
            </button>
          ))}
        </div>
      </div>
      {/* Flikar (punkt 5): documents as tabs on a wide screen. */}
      <div className={classes.section}>
        <span className={classes.label}>Dokument i flikar</span>
        <div className={segmentedStyles.segmented} role="radiogroup" aria-label="Dokument i flikar">
          {[true, false].map((on) => (
            <button
              key={String(on)}
              type="button"
              role="radio"
              aria-checked={documentTabs === on}
              data-active={documentTabs === on}
              onClick={() => setDocumentTabs(on)}
            >
              {on ? "På" : "Av"}
            </button>
          ))}
        </div>
      </div>
      {/* Var favoriterna visas: the sidebar group and/or Översikten's card. */}
      {favorites !== null && (
        <div className={classes.section}>
          <span className={classes.label}>Favoriter</span>
          <div className={segmentedStyles.segmented} role="radiogroup" aria-label="Favoriter" aria-busy={placementSaving}>
            {FAVORITES_PLACEMENTS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={placement === p}
                data-active={placement === p}
                disabled={placementSaving}
                onClick={() => void choosePlacement(p)}
              >
                {FAVORITES_PLACEMENT_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
