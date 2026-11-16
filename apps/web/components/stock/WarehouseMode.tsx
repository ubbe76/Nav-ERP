"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { locationOptionLabel, placeName, type LocationOptionInput } from "../../lib/stockLocations";

// Flera lager (System → Inställningar), read once per page by AppShell
// (loadMultipleWarehouses). Without a provider — a page outside the frame —
// the warehouse is shown, as before the setting existed.
const WarehouseModeContext = createContext(true);

export function WarehouseModeProvider({ multipleWarehouses, children }: { multipleWarehouses: boolean; children: ReactNode }) {
  return <WarehouseModeContext.Provider value={multipleWarehouses}>{children}</WarehouseModeContext.Provider>;
}

export function useMultipleWarehouses(): boolean {
  return useContext(WarehouseModeContext);
}

// The place labels bound to the setting: `place(warehouse, name)` and
// `option(location, { inactive })` — so no view has to pass the flag itself.
export function usePlaceLabels() {
  const multipleWarehouses = useMultipleWarehouses();
  const place = useCallback(
    (warehouseName: string | null | undefined, locationName: string, separator?: string) =>
      placeName(warehouseName, locationName, multipleWarehouses, separator),
    [multipleWarehouses]
  );
  const option = useCallback(
    (l: LocationOptionInput, opts: { inactive?: boolean } = {}) => locationOptionLabel(l, { ...opts, multipleWarehouses }),
    [multipleWarehouses]
  );
  return { multipleWarehouses, place, option };
}
