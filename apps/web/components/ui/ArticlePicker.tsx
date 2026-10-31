"use client";

import { SearchPicker } from "./SearchPicker";
import type { Article } from "../../lib/types";
import styles from "./SearchPicker.module.css";

// The closed field only needs the id (to highlight the current pick) and
// whatever formatLabel reads, so callers that don't hold a full Article —
// the Artikelöversikt, which gets its article from its own endpoint — can
// still pre-fill the picker. Search results (onChange) are full Articles.
export type ArticlePickerValue = Pick<Article, "id" | "articleNumber" | "name">;

interface ArticlePickerProps {
  id?: string;
  value: ArticlePickerValue | null;
  onChange: (article: Article | null) => void;
  placeholder?: string;
  // Hidden from the results — e.g. the article whose BOM is being edited.
  excludeId?: string;
  // What the closed input shows for the picked article. Defaults to
  // "number — benämning"; the article card's header passes the number alone
  // because the benämning already has its own field beside it.
  formatLabel?: (article: ArticlePickerValue) => string;
  // Order-row pickers: hide configurator templates in variant mode (a variant
  // is ordered, never the template) via ?orderable=true.
  orderable?: boolean;
  // Order-row pickers that can open Konfigurera: templates in variant mode are
  // listed again (requires orderable) and marked Konfigurerbar.
  configurable?: boolean;
}

// Searchable article combobox (sökbar artikelväljare) — a thin wrapper over
// the generic SearchPicker (see SearchPicker.tsx for the debounce/keyboard/
// blur mechanics) configured for /api/v1/articles, with the article
// register's two-column number/benämning option row (+ fantom flag).
export function ArticlePicker({
  id,
  value,
  onChange,
  placeholder = "Sök artikelnummer eller benämning…",
  excludeId,
  formatLabel = (article) => `${article.articleNumber} — ${article.name}`,
  orderable = false,
  configurable = false,
}: ArticlePickerProps) {
  return (
    <SearchPicker<Article>
      id={id}
      endpoint={orderable ? `/api/v1/articles?orderable=true${configurable ? "&configurable=true" : ""}` : "/api/v1/articles"}
      // SearchPicker reads value.id and formatLabel(value) only, so the
      // narrower ArticlePickerValue is safe to hand it as an Article.
      value={value as Article | null}
      onChange={onChange}
      formatLabel={formatLabel}
      placeholder={placeholder}
      excludeId={excludeId}
      emptyText="Inga artiklar matchar sökningen"
      renderOption={(article) => (
        <>
          <span className={styles.optionNumber}>{article.articleNumber}</span>
          <span className={styles.optionName}>
            {article.name}
            {article.isPhantom ? " · Fantom" : ""}
            {configurable && (article.configuratorMode === "variants" || article.configuratorMode === "to_order") ? " · Konfigurerbar" : ""}
          </span>
        </>
      )}
    />
  );
}
