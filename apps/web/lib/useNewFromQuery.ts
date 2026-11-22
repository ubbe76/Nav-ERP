"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// ?ny=1 opens a list page's "+ Ny …" dialog at once — the favourites'
// action shortcuts (lib/favoriteActions.ts) and the module hubs' "+ Ny …"
// links. The parameter is taken off the address after opening, so closing
// the dialog and following the same shortcut again (also from the page
// itself, where nothing remounts) opens it again, and a reload does not.
// `enabled` is the button's own condition — a user who may not create gets
// the list, never the dialog.
//
// Taken off with the browser's own replaceState, which Next keeps in step
// with useSearchParams without asking the server for the page again: a
// router.replace re-rendered the list page without a query, and on a list
// shown as Lista och kort that is the narrow list — the table (and the
// dialog in it) went away at once, so the narrow list's + did nothing
// (the user 2026-11-21, + Ny tillverkningsorder).
export function useNewFromQuery(open: () => void, enabled = true): void {
  const params = useSearchParams();
  const pathname = usePathname();
  const wanted = params.get("ny") === "1";
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!wanted || !enabled) return;
    openRef.current();
    const rest = new URLSearchParams(params.toString());
    rest.delete("ny");
    const query = rest.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
    // params is read for the rest of the address only; `wanted` is what triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, enabled]);
}
