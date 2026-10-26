"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { scrapReasonsOf, type DeviationReason } from "./quality";

// The reasons a kassation can choose from (active, flagged Kassation), or null
// while they load / when they could not be read. An empty list means the
// installation has no kassationsorsaker: the report then takes free text as
// before. The API decides which applies (scrap-reason-required).
// refreshKey: change it to read the register again (the terminal does on each
// Stämpla ut, so a reason an administrator just added or inactivated shows).
export function useScrapReasons(refreshKey?: unknown): DeviationReason[] | null {
  const [reasons, setReasons] = useState<DeviationReason[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<DeviationReason[]>("/api/v1/deviation-reasons")
      .then((all) => {
        if (!cancelled) setReasons(scrapReasonsOf(all));
      })
      .catch(() => {
        if (!cancelled) setReasons(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return reasons;
}
