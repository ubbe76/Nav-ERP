"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ArticleOverviewPanel } from "./ArticleOverviewPanel";

// Artikelöversikt panel state — ONE floating panel per page, mounted by
// AppShell, targeted from any list row via ArticleOverviewButton. `show` on
// an already open panel just re-targets it, which is what makes "click
// another row and the panel follows" work without any per-page wiring.
interface ArticleOverviewContextValue {
  articleId: string | null;
  show: (articleId: string) => void;
  // Re-targets the panel only while it is open — a page calls it for the row
  // the user works in (Behovsberäkning: a click in the row or focus in its
  // Antal field), so an open panel follows along and a closed one stays shut.
  follow: (articleId: string) => void;
  close: () => void;
  // The Behovsberäkning page registers its run and typed quantities here
  // (null when it unmounts); the overview then shows the planned view.
  setPlanning: (planning: ArticleOverviewPlanning | null) => void;
}

// What the Behovsberäkning page shares with the overview (user's goal
// 2026-11-24: see the demand a proposal is ordered against): which run it
// shows — the overview refetches when it changes — and the quantities typed
// into Förslag/Antal per proposal key (lib/articleOverviewPlanned.ts).
export interface ArticleOverviewPlanning {
  computedAt: string | null;
  typed: ReadonlyMap<string, number>;
}

const noop = () => {};

// The default is a no-op so a button rendered outside the provider (the
// dashboard keeps its own inline shell) is harmless rather than a crash.
const ArticleOverviewContext = createContext<ArticleOverviewContextValue>({
  articleId: null,
  show: noop,
  follow: noop,
  close: noop,
  setPlanning: noop,
});

// Its own context: the typed quantities change on every keystroke, and only
// the overview content reads them — the row buttons stay put.
const ArticleOverviewPlanningContext = createContext<ArticleOverviewPlanning | null>(null);

export function useArticleOverview() {
  return useContext(ArticleOverviewContext);
}

export function useArticleOverviewPlanning() {
  return useContext(ArticleOverviewPlanningContext);
}

export function ArticleOverviewProvider({ children }: { children: ReactNode }) {
  const [articleId, setArticleId] = useState<string | null>(null);
  const [planning, setPlanning] = useState<ArticleOverviewPlanning | null>(null);
  const show = useCallback((id: string) => setArticleId(id), []);
  const follow = useCallback((id: string) => setArticleId((open) => (open === null ? null : id)), []);
  const close = useCallback(() => setArticleId(null), []);
  const value = useMemo(() => ({ articleId, show, follow, close, setPlanning }), [articleId, show, follow, close]);

  return (
    <ArticleOverviewContext.Provider value={value}>
      <ArticleOverviewPlanningContext.Provider value={planning}>
        {children}
        <ArticleOverviewPanel />
      </ArticleOverviewPlanningContext.Provider>
    </ArticleOverviewContext.Provider>
  );
}
