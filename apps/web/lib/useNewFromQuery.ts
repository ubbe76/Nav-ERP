"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// ?ny=1 opens a list page's "+ Ny …" dialog at once — the favourites'
// action shortcuts (lib/favoriteActions.ts) and the module hubs' "+ Ny …"
// links. The parameter is taken off the address after opening, so closing
// the dialog and following the same shortcut again (also from the page
// itself, where nothing remounts) opens it again, and a reload does not.
// `enabled` is the button's own condition — a user who may not create gets
// the list, never the dialog.
export function useNewFromQuery(open: () => void, enabled = true): void {
  const params = useSearchParams();
  const router = useRouter();
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
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    // params is read for the rest of the address only; `wanted` is what triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, enabled]);
}
