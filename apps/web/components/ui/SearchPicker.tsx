"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "../../lib/api";
import type { Paged } from "../../lib/types";
import styles from "./SearchPicker.module.css";

// Module-level cache (survives unmount, e.g. a modal closing/reopening,
// for the lifetime of the page): remembers the last search term + results
// per endpoint, so reopening a picker continues where the user left off
// instead of blanking back to the first 20 rows. Keyed on the endpoint
// string exactly as passed in — the cached rows are always the unfiltered
// server response; excludeId filtering happens at render time (see
// `visible` below), so two pickers hitting the same endpoint with
// different excludeId values (e.g. the BOM component picker on two
// different article cards, or the article-card switcher after navigating
// to a different card) share one cache entry instead of missing on every
// excludeId change.
interface CacheEntry {
  term: string;
  results: unknown[];
  lastSelectedId?: string;
}
const searchCache = new Map<string, CacheEntry>();

interface SearchPickerProps<T extends { id: string }> {
  id?: string;
  // Endpoint the picker searches, e.g. "/api/v1/customers" or
  // "/api/v1/sales-orders?status=in_production" — the picker appends
  // "search=&limit=20" with "&" when the endpoint already carries a query
  // string, "?" otherwise. Response shape is always Paged<T> = { rows, total }.
  endpoint: string;
  value: T | null;
  onChange: (item: T | null) => void;
  // Display in the option list AND in the closed input.
  formatLabel: (item: T) => string;
  placeholder?: string;
  // Hidden from the results — e.g. the record whose own subresource is
  // being edited (BOM component picker excluding the article itself).
  excludeId?: string;
  // Custom option row; defaults to a single line of formatLabel. Lets
  // ArticlePicker keep its number/benämning two-column layout.
  renderOption?: (item: T, state: { highlighted: boolean }) => ReactNode;
  // Message shown in the list when a search has no matches.
  emptyText?: string;
}

// Generic searchable combobox (sökbar väljare): searches the given endpoint
// server-side (debounced, first 20 matches) instead of loading the whole
// register into a <select>. Focus with an empty box lists the first 20 (the
// server's default order), so small registers still behave like a dropdown.
// Every entity picker in the app (articles, customers, suppliers, sales/
// purchase orders, manufacturing orders, …) is this component configured
// with a different endpoint + formatLabel.
export function SearchPicker<T extends { id: string }>({
  id,
  endpoint,
  value,
  onChange,
  formatLabel,
  placeholder = "Sök…",
  excludeId,
  renderOption,
  emptyText = "Inga träffar",
}: SearchPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<T[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The rendered/keyboard-navigable list: `results` (and the cache) always
  // hold the unfiltered server rows so a cache entry can be shared across
  // pickers with different excludeId values — the exclusion is applied here,
  // at render time, for the list, keyboard nav, Enter selection and the
  // empty state alike.
  const visible = excludeId ? results.filter((item) => item.id !== excludeId) : results;

  async function search(query: string) {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const separator = endpoint.includes("?") ? "&" : "?";
      const page = await apiFetch<Paged<T>>(
        `${endpoint}${separator}search=${encodeURIComponent(query)}&limit=20`
      );
      if (seq !== requestSeq.current) return; // a newer search superseded this one
      setResults(page.rows);
      setHighlighted(0);
      searchCache.set(endpoint, { term: query, results: page.rows, lastSelectedId: searchCache.get(endpoint)?.lastSelectedId });
    } catch {
      if (seq === requestSeq.current) setResults([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  function openAndSearch(query: string) {
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void search(query), query === "" ? 0 : 250);
  }

  function select(item: T) {
    // `term`/`results` here already match the open list (either just
    // fetched or restored from cache on open), so re-save them alongside
    // the newly picked id — reopening later highlights this pick. `results`
    // is the unfiltered list, matching the cache's contract.
    searchCache.set(endpoint, { term, results, lastSelectedId: item.id });
    onChange(item);
    setTerm("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = visible[highlighted];
      if (hit) select(hit);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  const display = open ? term : value ? formatLabel(value) : "";

  return (
    <div className={styles.picker}>
      <input
        id={id}
        type="text"
        className={styles.input}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={display}
        placeholder={value && !open ? undefined : placeholder}
        onFocus={() => {
          const cached = searchCache.get(endpoint);
          if (cached) {
            // A pending debounced search from before the blur must not be
            // allowed to fire and clobber the restored view below.
            if (debounceRef.current) clearTimeout(debounceRef.current);
            // Continue where the user was: show the last search + results
            // (unfiltered, matching the cache's contract) without
            // refetching. Highlight the current value if it's in the
            // visible list, else the last pick for this endpoint if it's
            // visible, else — if the remembered pick IS the currently
            // excluded row (e.g. the article-card switcher landed back on
            // the article that was just picked) — the visible row adjacent
            // to where it would have been, else the top row.
            const rows = cached.results as T[];
            setTerm(cached.term);
            setResults(rows);
            setOpen(true);
            const rowsVisible = excludeId ? rows.filter((item) => item.id !== excludeId) : rows;
            let idx = value ? rowsVisible.findIndex((item) => item.id === value.id) : -1;
            if (idx < 0 && cached.lastSelectedId) {
              idx = rowsVisible.findIndex((item) => item.id === cached.lastSelectedId);
            }
            if (idx < 0 && cached.lastSelectedId) {
              const fullIdx = rows.findIndex((item) => item.id === cached.lastSelectedId);
              if (fullIdx >= 0) {
                const countBefore = rows
                  .slice(0, fullIdx)
                  .filter((item) => !excludeId || item.id !== excludeId).length;
                idx = Math.min(countBefore, rowsVisible.length - 1);
              }
            }
            setHighlighted(idx >= 0 ? idx : 0);
            return;
          }
          setTerm("");
          openAndSearch("");
        }}
        onChange={(e) => {
          const next = e.target.value;
          setTerm(next);
          if (value) onChange(null); // typing invalidates the previous pick
          openAndSearch(next.trim());
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Delay so a mousedown on an option can complete its click first.
          setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && (
        <ul className={styles.list} role="listbox" ref={listRef}>
          {visible.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={styles.option}
                data-highlighted={index === highlighted}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(item)}
              >
                {renderOption ? (
                  renderOption(item, { highlighted: index === highlighted })
                ) : (
                  <span className={styles.optionLabel}>{formatLabel(item)}</span>
                )}
              </button>
            </li>
          ))}
          {visible.length === 0 && <li className={styles.empty}>{loading ? "Söker…" : emptyText}</li>}
        </ul>
      )}
    </div>
  );
}
