"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { apiFetch } from "../../lib/api";
import type { Paged } from "../../lib/types";
import { SPLIT_LISTS, type SplitRow } from "./splitLists";
import { TableIcon, useSetListView } from "./ListViewToggle";
import styles from "./SplitView.module.css";

// Lista och kort (Programramen, steg 2, the user's sketch): the function's
// narrow list on the left — search, quick filters, rows on two lines, "N av
// M", more rows as it scrolls — and the card (or "Välj … i listan") on the
// right. Every card page and the list page in its list view draw one, so the
// list is drawn anew when the card changes: what it showed (rows, search,
// filter, scroll) is kept per list in memory and comes back at once, then
// read again in the background. Narrow screens show the card or the list.

const PAGE = 50;

interface Cached {
  rows: SplitRow[];
  total: number | null;
  search: string;
  filter: number;
  scrollTop: number;
}

// Per browser tab and list; gone on a reload (the list is read again).
const cache = new Map<string, Cached>();

export function SplitView({ list, selectedId, children }: { list: string; selectedId?: string; children: ReactNode }) {
  return (
    <div className={styles.split} data-split-view="" data-selected={selectedId ? "" : undefined}>
      <SplitList list={list} selectedId={selectedId} />
      <div className={styles.detail}>{children}</div>
    </div>
  );
}

export function SplitEmpty({ list }: { list: string }) {
  const config = SPLIT_LISTS[list];
  return <div className={styles.empty}>Välj {config?.noun ?? "en rad"} i listan.</div>;
}

function SplitList({ list, selectedId }: { list: string; selectedId?: string }) {
  const config = SPLIT_LISTS[list]!;
  const saved = cache.get(list);
  const [search, setSearch] = useState(saved?.search ?? "");
  const [filter, setFilter] = useState(saved?.filter ?? 0);
  const [rows, setRows] = useState<SplitRow[]>(saved?.rows ?? []);
  const [total, setTotal] = useState<number | null>(saved?.total ?? null);
  // A new search or filter: the rows fade until the new ones are in. A
  // background read (more rows, the refresh on a new card) changes nothing
  // on screen until it lands.
  const [replacing, setReplacing] = useState(false);
  const loading = useRef(false);
  const [failed, setFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const state = useRef({ rows, total, search, filter });
  state.current = { rows, total, search, filter };
  const setView = useSetListView();

  // The scroll position is read while the list is on screen (on unmount the
  // ref is already gone: the last known one stays).
  const remember = useCallback(() => {
    const s = state.current;
    const scrollTop = scroller.current ? scroller.current.scrollTop : (cache.get(list)?.scrollTop ?? 0);
    cache.set(list, { ...s, scrollTop });
  }, [list]);

  // Where the list was: back at once on a new card.
  useLayoutEffect(() => {
    if (saved && scroller.current) scroller.current.scrollTop = saved.scrollTop;
    // The selected row in view, if it is not.
    const row = scroller.current?.querySelector<HTMLElement>("[data-selected]");
    if (row && scroller.current) {
      const box = scroller.current.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) row.scrollIntoView({ block: "nearest" });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(
    async (offset: number, limit: number, replace = false) => {
      const mine = ++seq.current;
      loading.current = true;
      if (replace) setReplacing(true);
      const { search: q, filter: f } = state.current;
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (q.trim()) params.set("search", q.trim());
      const extra = config.filters[f]?.query;
      const sep = config.api.includes("?") ? "&" : "?";
      try {
        const page = await apiFetch<Paged<unknown>>(`${config.api}${sep}${params.toString()}${extra ? `&${extra}` : ""}`);
        if (mine !== seq.current) return;
        const next = page.rows.map(config.row);
        setRows((current) => (offset === 0 ? next : [...current, ...next.filter((r) => !current.some((c) => c.id === r.id))]));
        setTotal(page.total);
        setFailed(false);
      } catch {
        if (mine === seq.current) setFailed(true);
      } finally {
        if (mine === seq.current) {
          loading.current = false;
          setReplacing(false);
        }
      }
    },
    [config]
  );

  // A new search or filter reads the list from the top; the first read on a
  // new card refreshes as many rows as were shown.
  const first = useRef(true);
  useEffect(() => {
    const keep = first.current ? Math.max(PAGE, state.current.rows.length) : PAGE;
    const wasFirst = first.current;
    first.current = false;
    if (!wasFirst && scroller.current) scroller.current.scrollTop = 0;
    const timer = setTimeout(() => void load(0, Math.min(keep, 200), !wasFirst), wasFirst || !search ? 0 : 250);
    return () => clearTimeout(timer);
  }, [search, filter, load]);

  // More rows as the end comes into view. The list scrolls on its own beside
  // a card; on a narrow screen it is part of the page (overflow visible), and
  // then the window is what the end comes into — watched against the list
  // itself, the end was always "in view" and every page was read, one after
  // the other, the rows fading with each (2026-11-20, an iPhone).
  useEffect(() => {
    const node = sentinel.current;
    const box = scroller.current;
    if (!node || !box) return;
    const root = getComputedStyle(box).overflowY === "visible" ? null : box;
    const observer = new IntersectionObserver(
      (entries) => {
        const s = state.current;
        if (entries[0]?.isIntersecting && !loading.current && s.total !== null && s.rows.length < s.total) {
          void load(s.rows.length, PAGE);
        }
      },
      { root, rootMargin: "200px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [load, rows.length]);

  useEffect(() => remember, [remember]);
  useEffect(() => {
    remember();
  }, [rows, total, search, filter, remember]);

  return (
    <aside className={styles.list} aria-label={config.title}>
      <div className={styles.head}>
        <span className={styles.title}>{config.title}</span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setView(list, "table")}
          title="Visa som tabell"
          aria-label="Visa som tabell"
        >
          <TableIcon />
        </button>
        {config.newHref && (
          <Link href={config.newHref} className={styles.iconButton} data-new="" title={config.newLabel} aria-label={config.newLabel}>
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
          </Link>
        )}
      </div>
      <label className={styles.search}>
        <Search size={14} strokeWidth={1.8} aria-hidden="true" />
        <input
          type="search"
          value={search}
          placeholder={config.searchPlaceholder}
          aria-label={config.searchPlaceholder}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {config.filters.length > 1 && (
        <div className={styles.chips} role="radiogroup" aria-label="Urval">
          {config.filters.map((f, i) => (
            <button
              key={f.label}
              type="button"
              role="radio"
              aria-checked={filter === i}
              className={styles.chip}
              onClick={() => setFilter(i)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
      <div className={styles.rows} ref={scroller} onScroll={remember} data-pending={replacing || undefined}>
        {rows.map((row) => (
          <Link
            key={row.id}
            href={row.href}
            className={styles.row}
            data-selected={row.id === selectedId || undefined}
            aria-current={row.id === selectedId ? "page" : undefined}
          >
            <span className={styles.primary}>{row.primary}</span>
            {row.amount ? <span className={styles.amount}>{row.amount}</span> : <span />}
            <span className={styles.secondary}>{row.secondary}</span>
            {row.status ? (
              <span className={styles.status} data-tone={row.status.tone}>
                {row.status.label}
              </span>
            ) : (
              <span />
            )}
          </Link>
        ))}
        {failed && <p className={styles.note}>Kunde inte läsa listan just nu.</p>}
        {!failed && total === 0 && <p className={styles.note}>Inga träffar.</p>}
        <div ref={sentinel} className={styles.sentinel} />
      </div>
      <div className={styles.foot}>{total === null ? "Hämtar…" : `${rows.length} av ${total}`}</div>
    </aside>
  );
}
