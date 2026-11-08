"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "../lib/api";
import { isEmptyEntry, type ListColumns, type ListColumnsEntry, type TableDensity } from "../lib/listColumns";

// Täthet och kolumner (Nav som program, punkt 6): the user's density and
// per-list column setup, read with the page (AppShell) and changed here.
// The app frame carries data-density, which ui/Table's CSS reads.
interface UserPrefsValue {
  density: TableDensity;
  setDensity: (density: TableDensity) => void;
  listColumns: ListColumns;
  // null (or an empty entry) = Återställ: the list as built.
  setListColumns: (key: string, entry: ListColumnsEntry | null) => void;
}

const UserPrefsContext = createContext<UserPrefsValue>({
  density: "normal",
  setDensity: () => {},
  listColumns: {},
  setListColumns: () => {},
});

// The state is this tab's from the first render on: later server renders
// (a client navigation re-renders AppShell) never overwrite it, so a change
// whose PATCH is still on its way can't be undone by a page read before it
// landed. Saves run one at a time, in the order they were made; a failed save
// keeps the choice for this page view (it is a convenience, not data).
export function UserPrefsProvider({
  initialDensity,
  initialListColumns,
  className,
  children,
}: {
  initialDensity: TableDensity;
  initialListColumns: ListColumns;
  className?: string;
  children: ReactNode;
}) {
  const [density, setDensityState] = useState(initialDensity);
  const [listColumns, setListColumnsState] = useState(initialListColumns);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const save = useCallback((body: object) => {
    queue.current = queue.current
      .then(() => apiFetch("/api/v1/me/settings", { method: "PATCH", body: JSON.stringify(body) }))
      .catch(() => {});
  }, []);

  const setDensity = useCallback(
    (next: TableDensity) => {
      setDensityState(next);
      save({ density: next });
    },
    [save]
  );

  const setListColumns = useCallback(
    (key: string, entry: ListColumnsEntry | null) => {
      const value = entry && !isEmptyEntry(entry) ? entry : null;
      setListColumnsState((current) => {
        const next = { ...current };
        if (value) next[key] = value;
        else delete next[key];
        return next;
      });
      save({ listColumns: { [key]: value } });
    },
    [save]
  );

  const value = useMemo(
    () => ({ density, setDensity, listColumns, setListColumns }),
    [density, setDensity, listColumns, setListColumns]
  );
  return (
    <UserPrefsContext.Provider value={value}>
      <div className={className} data-density={density}>
        {children}
      </div>
    </UserPrefsContext.Provider>
  );
}

export function useUserPrefs(): UserPrefsValue {
  return useContext(UserPrefsContext);
}
