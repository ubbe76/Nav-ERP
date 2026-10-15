"use client";

import { useArticleOverview } from "./ArticleOverviewProvider";
import { useCanOpen } from "../PermissionsProvider";
import styles from "./ArticleOverview.module.css";

interface ArticleOverviewButtonProps {
  articleId: string;
  // For the accessible name only — the visible button is icon-only.
  articleNumber?: string;
  // "row" (26 px, inline after an article number in a table) or "toolbar"
  // (34 px, beside HelpLink in a card header).
  size?: "row" | "toolbar";
}

// Opens (or re-targets) the floating Artikelöversikt panel for one article.
// preventDefault/stopPropagation so it can sit inside a row link or a
// clickable row without navigating.
export function ArticleOverviewButton({ articleId, articleNumber, size = "row" }: ArticleOverviewButtonProps) {
  const { show } = useArticleOverview();
  const canOpen = useCanOpen();
  if (!canOpen("/artiklar/oversikt")) return null;
  const label = articleNumber ? `Artikelöversikt för ${articleNumber}` : "Artikelöversikt";
  return (
    <button
      type="button"
      className={size === "toolbar" ? styles.toolbarButton : styles.rowButton}
      title="Artikelöversikt"
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        show(articleId);
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <path d="M3 3.5h10M3 8h10M3 12.5h10" />
        <circle cx="1.8" cy="3.5" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="1.8" cy="8" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="1.8" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}
