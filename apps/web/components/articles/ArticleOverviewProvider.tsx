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
  close: () => void;
}

const noop = () => {};

// The default is a no-op so a button rendered outside the provider (the
// dashboard keeps its own inline shell) is harmless rather than a crash.
const ArticleOverviewContext = createContext<ArticleOverviewContextValue>({
  articleId: null,
  show: noop,
  close: noop,
});

export function useArticleOverview() {
  return useContext(ArticleOverviewContext);
}

export function ArticleOverviewProvider({ children }: { children: ReactNode }) {
  const [articleId, setArticleId] = useState<string | null>(null);
  const show = useCallback((id: string) => setArticleId(id), []);
  const close = useCallback(() => setArticleId(null), []);
  const value = useMemo(() => ({ articleId, show, close }), [articleId, show, close]);

  return (
    <ArticleOverviewContext.Provider value={value}>
      {children}
      <ArticleOverviewPanel />
    </ArticleOverviewContext.Provider>
  );
}
