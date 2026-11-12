"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
  // The (trimmed) term `results` were fetched for: Enter only picks from a
  // list that belongs to what the box says.
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  // Enter pressed before the list matched the box (typed or scanned "1234" +
  // Enter within the debounce): the search runs at once and its first hit is
  // picked when it lands — never a row of the previous list.
  const enterPending = useRef(false);
  // Typed or arrowed since the list opened. An untouched list must not turn
  // an Enter meant for the form into a new pick (the cached list restored on
  // focus need not contain the current value).
  const interacted = useRef(false);
  const listId = useId();
  const optionId = (index: number) => `${listId}-o${index}`;

  // The rendered/keyboard-navigable list: `results` (and the cache) always
  // hold the unfiltered server rows so a cache entry can be shared across
  // pickers with different excludeId values — the exclusion is applied here,
  // at render time, for the list, keyboard nav, Enter selection and the
  // empty state alike.
  const visible = excludeId ? results.filter((item) => item.id !== excludeId) : results;

  // keepHighlightId: a background refresh of the restored list keeps the
  // highlighted row where it is instead of jumping to the top.
  async function search(query: string, keepHighlightId?: string) {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const separator = endpoint.includes("?") ? "&" : "?";
      const page = await apiFetch<Paged<T>>(
        `${endpoint}${separator}search=${encodeURIComponent(query)}&limit=20`
      );
      if (seq !== requestSeq.current) return; // a newer search superseded this one
      const rows = page.rows;
      setResults(rows);
      setResultsFor(query);
      const rowsVisible = excludeId ? rows.filter((item) => item.id !== excludeId) : rows;
      const kept = keepHighlightId ? rowsVisible.findIndex((item) => item.id === keepHighlightId) : -1;
      setHighlighted(kept >= 0 ? kept : 0);
      searchCache.set(endpoint, { term: query, results: rows, lastSelectedId: searchCache.get(endpoint)?.lastSelectedId });
      if (enterPending.current) {
        enterPending.current = false;
        const first = rowsVisible[0];
        if (first) commit(first, query, rows);
      }
    } catch {
      if (seq === requestSeq.current) {
        setResults([]);
        setResultsFor(query);
        enterPending.current = false;
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (blurRef.current) clearTimeout(blurRef.current);
    },
    []
  );

  function openAndSearch(query: string) {
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void search(query);
    }, query === "" ? 0 : 250);
  }

  // Opens the list: the cached search and rows for this endpoint when there
  // are any (refreshed in the background — a new or changed record shows
  // without typing), otherwise the first 20.
  function openList() {
    interacted.current = false;
    const cached = searchCache.get(endpoint);
    if (cached) {
      // A pending debounced search from before the blur must not be
      // allowed to fire and clobber the restored view below.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      // Continue where the user was: show the last search + results
      // (unfiltered, matching the cache's contract). Highlight the current
      // value if it's in the visible list, else the last pick for this
      // endpoint if it's visible, else — if the remembered pick IS the
      // currently excluded row (e.g. the article-card switcher landed back
      // on the article that was just picked) — the visible row adjacent to
      // where it would have been, else the top row.
      const rows = cached.results as T[];
      setTerm(cached.term);
      setResults(rows);
      setResultsFor(cached.term);
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
      const at = idx >= 0 ? idx : 0;
      setHighlighted(at);
      void search(cached.term, rowsVisible[at]?.id);
      return;
    }
    setTerm("");
    openAndSearch("");
  }

  // Picks `item` and remembers the list it came from — reopening later
  // continues there and highlights this pick. `rows` is the unfiltered list,
  // matching the cache's contract.
  function commit(item: T, query: string, rows: T[]) {
    searchCache.set(endpoint, { term: query, results: rows, lastSelectedId: item.id });
    onChange(item);
    setTerm("");
    setOpen(false);
  }

  function select(item: T) {
    commit(item, term.trim(), results);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      // A closed list (after Esc or a pick) opens again with ArrowDown.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openList();
        interacted.current = true;
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      interacted.current = true;
      setHighlighted((h) => Math.min(h + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      interacted.current = true;
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      // Untouched list with a value already picked: the Enter belongs to the
      // form (submit), not to the list.
      if (!interacted.current && value) {
        setOpen(false);
        return;
      }
      e.preventDefault();
      const query = term.trim();
      if (debounceRef.current !== null || resultsFor !== query) {
        // The list on screen is for an older term: search now, pick the
        // first hit when it lands.
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = null;
        enterPending.current = true;
        void search(query);
        return;
      }
      const hit = visible[highlighted];
      if (hit) select(hit);
    } else if (e.key === "Escape") {
      // Only the list closes: inside a dialog, Esc would otherwise also
      // cancel the dialog (and Modal unmounts the filled-in form).
      e.preventDefault();
      e.stopPropagation();
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
        aria-controls={listId}
        aria-activedescendant={open && visible[highlighted] ? optionId(highlighted) : undefined}
        value={display}
        placeholder={value && !open ? undefined : placeholder}
        onFocus={() => {
          // A blur timer from a quick refocus must not close the list again.
          if (blurRef.current) clearTimeout(blurRef.current);
          blurRef.current = null;
          openList();
        }}
        onChange={(e) => {
          const next = e.target.value;
          interacted.current = true;
          enterPending.current = false;
          setTerm(next);
          if (value) onChange(null); // typing invalidates the previous pick
          openAndSearch(next.trim());
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Delay so a mousedown on an option can complete its click first.
          blurRef.current = setTimeout(() => {
            blurRef.current = null;
            setOpen(false);
          }, 150);
        }}
      />
      {open && (
        <ul className={styles.list} role="listbox" id={listId} ref={listRef}>
          {visible.map((item, index) => (
            <li key={item.id} role="none">
              <button
                id={optionId(index)}
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
          {visible.length === 0 && (
            <li className={styles.empty} role="none">
              {loading ? "Söker…" : emptyText}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
