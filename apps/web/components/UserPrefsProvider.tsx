"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDocumentTabs } from "./tabs/DocumentTabs";
import { apiFetch } from "../lib/api";
import { isEmptyEntry, type ListColumns, type ListColumnsEntry, type TableDensity } from "../lib/listColumns";
import { NAV_LABEL_SIZES, type NavLabels } from "../lib/navLabels";
import { isEmbedded, type TabMessage } from "../lib/documentTabs";
import { postToFrame } from "../lib/tabNavigation";

// Täthet och kolumner (Nav som program, punkt 6): the user's density and
// per-list column setup, read with the page (AppShell) and changed here.
// The app frame carries data-density, which ui/Table's CSS reads.
interface UserPrefsValue {
  density: TableDensity;
  setDensity: (density: TableDensity) => void;
  listColumns: ListColumns;
  // null (or an empty entry) = Återställ: the list as built.
  setListColumns: (key: string, entry: ListColumnsEntry | null) => void;
  // Flikar (Programramen).
  documentTabs: boolean;
  setDocumentTabs: (on: boolean) => void;
  // Programramen: the module panel folded away.
  navPanelCollapsed: boolean;
  setNavPanelCollapsed: (collapsed: boolean) => void;
  // Namn under ikonerna: the rail's names and their size (off = icons only).
  navLabels: NavLabels;
  setNavLabels: (labels: NavLabels) => void;
}

const UserPrefsContext = createContext<UserPrefsValue>({
  density: "normal",
  setDensity: () => {},
  listColumns: {},
  setListColumns: () => {},
  documentTabs: true,
  setDocumentTabs: () => {},
  navPanelCollapsed: false,
  setNavPanelCollapsed: () => {},
  navLabels: "off",
  setNavLabels: () => {},
});

// The state is this tab's from the first render on: later server renders
// (a client navigation re-renders AppShell) never overwrite it, so a change
// whose PATCH is still on its way can't be undone by a page read before it
// landed. Saves run one at a time, in the order they were made; a failed save
// keeps the choice for this page view (it is a convenience, not data).
export function UserPrefsProvider({
  initialDensity,
  initialListColumns,
  initialDocumentTabs = true,
  initialNavPanelCollapsed = false,
  initialNavLabels = "off",
  className,
  children,
}: {
  initialDensity: TableDensity;
  initialListColumns: ListColumns;
  initialDocumentTabs?: boolean;
  initialNavPanelCollapsed?: boolean;
  initialNavLabels?: NavLabels;
  className?: string;
  children: ReactNode;
}) {
  const [density, setDensityState] = useState(initialDensity);
  const [listColumns, setListColumnsState] = useState(initialListColumns);
  const [documentTabs, setDocumentTabsState] = useState(initialDocumentTabs);
  const [navPanelCollapsed, setNavPanelCollapsedState] = useState(initialNavPanelCollapsed);
  const [navLabels, setNavLabelsState] = useState(initialNavLabels);
  // The tabs live in the root layout (they outlive this frame); they follow
  // the user's setting.
  const tabsControl = useDocumentTabs();
  const setTabsEnabled = tabsControl.setEnabled;
  useEffect(() => setTabsEnabled(documentTabs), [setTabsEnabled, documentTabs]);
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

  const setDocumentTabs = useCallback(
    (on: boolean) => {
      setDocumentTabsState(on);
      save({ documentTabs: on });
    },
    [save]
  );

  const setNavPanelCollapsed = useCallback(
    (collapsed: boolean) => {
      setNavPanelCollapsedState(collapsed);
      save({ navPanelCollapsed: collapsed });
    },
    [save]
  );

  // Namn under ikonerna. The menu is the frame's (hidden inside a tab), so a
  // choice made in a tab — Mina inställningar — is told to the frame, which
  // shows it without saving it again.
  const setNavLabels = useCallback(
    (labels: NavLabels) => {
      setNavLabelsState(labels);
      save({ navLabels: labels });
      if (isEmbedded()) postToFrame({ type: "nav-labels", navLabels: labels });
    },
    [save]
  );
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin || (e.source as Window | null)?.parent !== window) return;
      const message = e.data as TabMessage | null;
      if (message?.type !== "nav-labels") return;
      const labels = NAV_LABEL_SIZES.find((size) => size === message.navLabels);
      if (labels) setNavLabelsState(labels);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const value = useMemo(
    () => ({
      density,
      setDensity,
      listColumns,
      setListColumns,
      documentTabs,
      setDocumentTabs,
      navPanelCollapsed,
      setNavPanelCollapsed,
      navLabels,
      setNavLabels,
    }),
    [density, setDensity, listColumns, setListColumns, documentTabs, setDocumentTabs, navPanelCollapsed, setNavPanelCollapsed, navLabels, setNavLabels]
  );
  return (
    <UserPrefsContext.Provider value={value}>
      {/* data-app-frame: one column inside a tab (globals.css); data-tabs-pref:
          the frame's own page is hidden on a wide screen while the tabs come on. */}
      <div className={className} data-density={density} data-app-frame="" data-tabs-pref={documentTabs ? "" : undefined}>
        {children}
      </div>
    </UserPrefsContext.Provider>
  );
}

export function useUserPrefs(): UserPrefsValue {
  return useContext(UserPrefsContext);
}
