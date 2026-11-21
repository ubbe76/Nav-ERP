"use client";

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Checkbox, Input } from "./Field";
import { LIST_PAGE_SIZE, LIST_PAGE_SIZE_OPTIONS } from "../../lib/listQuery";
import { API_URL, apiFetch } from "../../lib/api";
import { confirmLeave } from "../../lib/unsavedGuard";
import styles from "./ListControls.module.css";
import { ExportMenu } from "./ExportMenu";
import { ListViewToggle } from "../split/ListViewToggle";
import {
  SHOW_FINISHED_PARAM,
  filterParamValue,
  filterSummary,
  groupChosen,
  parseFilterValue,
  showsFinished,
  toggleFilterGroup,
  toggleFilterValue,
  visibleOptions,
  withFinishedRule,
  withoutFinished,
  type MultiFilter,
} from "../../lib/listFilter";

// Återkoppling (Nav som program, punkt 7): while a list's new search, filter
// or page is on its way, <html data-list-pending> fades the table
// (Table.module.css). Several controls navigate, so it is a count.
let pendingNavigations = 0;
function usePendingFlag(pending: boolean) {
  useEffect(() => {
    if (!pending) return;
    pendingNavigations++;
    document.documentElement.setAttribute("data-list-pending", "");
    return () => {
      pendingNavigations = Math.max(pendingNavigations - 1, 0);
      if (pendingNavigations === 0) document.documentElement.removeAttribute("data-list-pending");
    };
  }, [pending]);
}

// The list pages are URL-driven: search, filters and page live in the query
// string, the server component refetches on every change. Filter and search
// changes reset the page.
// The query most recently requested per path. router.replace lands later and
// useSearchParams only follows then, so two quick changes (a search followed by
// a filter) must build on this, not on the stale hook value. Module level since
// several controls on one page share the URL.
let requested: { pathname: string; qs: string } | null = null;

export function useListNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The navigation as a transition: pending until the new rows have arrived.
  const [pending, startTransition] = useTransition();
  usePendingFlag(pending);

  // Forget the requested query once the URL has caught up (or the page changed).
  const currentQs = searchParams.toString();
  useEffect(() => {
    if (requested && (requested.pathname !== pathname || requested.qs === currentQs)) requested = null;
  }, [pathname, currentQs]);

  // Resolves false when the unsaved-changes prompt was declined (nothing
  // navigated). skipGuard: the caller has already asked.
  async function apply(updates: Record<string, string | null>, resetPage: boolean, skipGuard = false): Promise<boolean> {
    if (!skipGuard && !(await confirmLeave({ listNavigation: true }))) return false;
    const base = requested && requested.pathname === pathname ? requested.qs : searchParams.toString();
    const next = new URLSearchParams(base);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete("page");
    const qs = next.toString();
    requested = { pathname, qs };
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    return true;
  }

  return {
    params: searchParams,
    setFilter: (key: string, value: string | null) => apply({ [key]: value }, true),
    // Several params in one navigation (Visa avslutade off also drops the
    // finished statuses from the choice).
    setFilters: (updates: Record<string, string | null>) => apply(updates, true),
    setPage: (page: number, skipGuard = false) => apply({ page: page <= 1 ? null : String(page) }, false, skipGuard),
  };
}

interface ListToolbarProps {
  placeholder?: string;
  // Keys in the search field go here first; preventDefault() keeps the
  // toolbar from handling them (artikelregistret's arrow-key row walk).
  onSearchKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  children?: ReactNode; // filter selects, rendered to the right of the search box
}

export function ListToolbar({ placeholder = "Sök…", onSearchKeyDown, children }: ListToolbarProps) {
  const { params, setFilter } = useListNavigation();
  const [value, setValue] = useState(params.get("search") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlSearch = params.get("search") ?? "";

  // A pending debounce must not fire after the page is left: it would
  // router.replace the list URL and pull the user back.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
    },
    []
  );

  // Follow the URL when it changes from outside (favourite, Senast öppnade,
  // Back) and the user is not mid-typing.
  useEffect(() => {
    if (debounceRef.current) return;
    setValue((cur) => (cur.trim() === urlSearch ? cur : urlSearch));
  }, [urlSearch]);

  function applySearch(next: string) {
    // Declined leave prompt: show the search that is actually applied.
    void setFilter("search", next.trim() || null).then((applied) => {
      if (!applied) setValue(params.get("search") ?? "");
    });
  }

  function onSearchChange(next: string) {
    setValue(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      applySearch(next);
    }, 300);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // The page may claim the key first (e.g. Enter on a keyboard-marked row).
    onSearchKeyDown?.(e);
    if (e.key !== "Enter") return;
    if (e.defaultPrevented) {
      // The page took Enter (opens a row): drop the pending search so it does
      // not navigate back to the list afterwards.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      return;
    }
    // Enter searches at once instead of waiting out the debounce; the hits
    // stay listed below. Only a pending search is applied — a repeated Enter
    // must not re-navigate.
    if (!debounceRef.current) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
    applySearch(value);
  }

  return (
    // data-list-toolbar marks a list page: ↑/↓ move through the table after
    // it (KeyboardShortcuts); elsewhere the arrow keys scroll as usual.
    <div className={styles.toolbar} data-list-toolbar="">
      <div className={styles.search}>
        <Input
          type="search"
          value={value}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Sök i listan"
        />
      </div>
      {children}
      <ListViewToggle />
    </div>
  );
}

// A filter select bound to a query param. Options exclude the "all" choice —
// it is added first with the given label.
export function ListFilterSelect({
  param,
  allLabel,
  options,
  ariaLabel,
}: {
  param: string;
  allLabel: string;
  options: { value: string; label: string }[];
  ariaLabel: string;
}) {
  const { params, setFilter } = useListNavigation();
  return (
    <div className={styles.filter}>
      <div className={styles.selectWrap}>
        <select
          className={styles.select}
          value={params.get(param) ?? ""}
          onChange={(e) => setFilter(param, e.target.value || null)}
          aria-label={ariaLabel}
        >
          <option value="">{allLabel}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className={styles.chevron}>▾</span>
      </div>
    </div>
  );
}

// Flerval (2026-11-21): a status (or type) filter where several values can
// be chosen at once — a button saying what is chosen ("Alla statusar",
// "Öppna", "Utkast, Bekräftad") and a panel of checkboxes: the filter's
// groups (Öppna), its statuses and, apart, what narrows them (Sen). The
// same definition draws the narrow list's chips (lib/statusFilters.ts).
// Each click applies at once; the chosen values are kept here too, so two
// quick clicks build on each other before the address has caught up.
export function ListMultiFilter({ filter, allLabel, ariaLabel }: { filter: MultiFilter; allLabel: string; ariaLabel: string }) {
  const { params, setFilter, setFilters } = useListNavigation();
  const raw = params.get(filter.param) ?? "";
  const rawTicked = params.get(SHOW_FINISHED_PARAM) === "true";
  const [selected, setSelected] = useState(() => parseFilterValue(filter, raw));
  // Visa avslutade (filter.finished): the box, kept here like the choice.
  const [ticked, setTicked] = useState(rawTicked);
  const show = showsFinished(filter, selected, ticked);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Follow the address when it changes from outside (favourite, Back).
  useEffect(() => {
    setSelected(parseFilterValue(filter, raw));
  }, [raw]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setTicked(rawTicked);
  }, [rawTicked]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(next: string[]) {
    setSelected(next);
    // A declined leave prompt: back to what the list shows.
    void setFilter(filter.param, filterParamValue(next) || null).then((applied) => {
      if (!applied) setSelected(parseFilterValue(filter, raw));
    });
  }

  function tick(on: boolean) {
    const next = on ? selected : withoutFinished(filter, selected);
    setTicked(on);
    setSelected(next);
    void setFilters({ [SHOW_FINISHED_PARAM]: on ? "true" : null, [filter.param]: filterParamValue(next) || null }).then((applied) => {
      if (!applied) {
        setTicked(rawTicked);
        setSelected(parseFilterValue(filter, raw));
      }
    });
  }

  const summary = filterSummary(filter, selected, allLabel);
  return (
    <>
    <div className={styles.multi} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.multiTrigger}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${ariaLabel}: ${summary}`}
        data-chosen={selected.length > 0 || undefined}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.multiSummary}>{summary}</span>
        <span className={styles.chevron}>▾</span>
      </button>
      {open && (
        <div className={styles.multiPanel} id={panelId} role="group" aria-label={ariaLabel}>
          {filter.groups && filter.groups.length > 0 && (
            <>
              {filter.groups.map((group) => {
                const state = groupChosen(group, selected);
                return (
                  <label key={group.label} className={styles.multiOption}>
                    <input
                      type="checkbox"
                      checked={state === "all"}
                      ref={(el) => {
                        if (el) el.indeterminate = state === "some";
                      }}
                      onChange={() => choose(toggleFilterGroup(filter, selected, group))}
                    />
                    {group.label}
                  </label>
                );
              })}
              <hr className={styles.multiDivider} />
            </>
          )}
          {visibleOptions(filter, show).map((option) => (
            <label key={option.value} className={styles.multiOption}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => choose(toggleFilterValue(filter, selected, option.value))}
              />
              {option.label}
            </label>
          ))}
          {filter.narrow && filter.narrow.length > 0 && (
            <>
              <hr className={styles.multiDivider} />
              {filter.narrow.map((option) => (
                <label key={option.value} className={styles.multiOption}>
                  <input
                    type="checkbox"
                    checked={selected.includes(option.value)}
                    onChange={() => choose(toggleFilterValue(filter, selected, option.value))}
                  />
                  {option.label}
                </label>
              ))}
              <p className={styles.multiHint}>
                {filter.narrow.map((o) => o.label).join(" och ")} visar de som är sena bland statusarna du har valt, eller
                bland alla om ingen status är vald.
              </p>
            </>
          )}
          <button type="button" className={styles.multiReset} disabled={selected.length === 0} onClick={() => choose([])}>
            Visa alla
          </button>
        </div>
      )}
    </div>
    {filter.finished && (
      <label className={styles.finishedToggle} title={`Visar även ${finishedLabels(filter)}`}>
        <Checkbox checked={show} onChange={(e) => tick(e.target.checked)} />
        {filter.finished.label}
      </label>
    )}
    </>
  );
}

// True while the list leaves its finished orders out — the empty text then
// says where they are.
export function useFinishedHidden(filter: MultiFilter): boolean {
  const params = useSearchParams();
  if (!filter.finished) return false;
  const chosen = parseFilterValue(filter, params.get(filter.param));
  return !showsFinished(filter, chosen, params.get(SHOW_FINISHED_PARAM) === "true");
}

export const FINISHED_HIDDEN_HINT = "Avslutade ordrar visas med Visa avslutade.";

// "stängda och makulerade": the finished statuses as the box's tooltip says them.
function finishedLabels(filter: MultiFilter): string {
  const labels = filter.options.filter((o) => filter.finished?.values.includes(o.value)).map((o) => o.label.toLowerCase());
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} och ${labels.at(-1)}` : (labels[0] ?? "");
}

// A boolean query-param filter rendered as a checkbox — e.g. "Endast
// förfallna"/overdueOnly, "Visa alla artiklar"/showAll. Absent from the URL
// when unchecked, "true" when checked (mirrors ListFilterSelect's "" = all).
export function ListToggleFilter({ param, label }: { param: string; label: string }) {
  const { params, setFilter } = useListNavigation();
  const checked = params.get(param) === "true";
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
      <Checkbox checked={checked} onChange={(e) => setFilter(param, e.target.checked ? "true" : null)} />
      {label}
    </label>
  );
}

// F2: same-filters export for a list page — the API's /csv sibling (and its
// /xlsx twin) accepts the same search/filter query params as the JSON list
// (see registerListCsvRoute), just never paginated, so `page` is dropped
// before building the query string. `endpoint` is the CSV route; ExportMenu
// offers CSV and Excel.
export function ListExportLink({
  endpoint,
  renameParams,
  filter,
}: {
  endpoint: string;
  renameParams?: Record<string, string>;
  // A list that hides its finished orders (Visa avslutade): the export
  // asks for the same rows as the list.
  filter?: MultiFilter;
}) {
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  if (filter) {
    const ruled = withFinishedRule(filter, Object.fromEntries(params.entries()));
    for (const key of [...params.keys()]) params.delete(key);
    for (const [key, value] of Object.entries(ruled)) if (typeof value === "string" && value !== "") params.set(key, value);
  }
  params.delete("page");
  // For pages whose URL param differs from the API's (e.g. ?article= → articleId).
  for (const [from, to] of Object.entries(renameParams ?? {})) {
    const value = params.get(from);
    params.delete(from);
    if (value !== null) params.set(to, value);
  }
  const qs = params.toString();
  return <ExportMenu csvHref={`${API_URL}${endpoint}${qs ? `${endpoint.includes("?") ? "&" : "?"}${qs}` : ""}`} />;
}

// Page-number strip: all pages when few, otherwise first/last plus the
// current page's neighbours with ellipses.
function pageItems(page: number, pageCount: number): (number | "…")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const wanted = new Set([1, 2, page - 1, page, page + 1, pageCount - 1, pageCount]);
  const items: (number | "…")[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (wanted.has(p)) items.push(p);
    else if (items[items.length - 1] !== "…") items.push("…");
  }
  return items;
}

export function Pagination({ total, pageSize = LIST_PAGE_SIZE }: { total: number; pageSize?: number }) {
  const router = useRouter();
  const { params, setPage } = useListNavigation();
  const rawPage = Number.parseInt(params.get("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const shownPage = Math.min(page, pageCount);
  const from = total === 0 ? 0 : (shownPage - 1) * pageSize + 1;
  const to = Math.min(total, shownPage * pageSize);

  // A stale ?page= beyond the last page (rows deleted, link shared) would show
  // an empty list with no buttons; step back to the last page.
  useEffect(() => {
    if (total > 0 && page > pageCount) void setPage(pageCount, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, page, pageCount]);

  // Persists the choice server-side (PATCH /me/settings, upserted per user),
  // then drops the now-stale "page" param and re-runs the server component
  // so listApiQuery()/<Pagination> pick up the new size on the next render.
  async function onPageSizeChange(next: number) {
    if (!(await confirmLeave({ listNavigation: true }))) return;
    try {
      await apiFetch("/api/v1/me/settings", { method: "PATCH", body: JSON.stringify({ listPageSize: next }) });
    } catch {
      // Best-effort — the list still renders with the previous page size;
      // the user can retry the select.
    }
    await setPage(1, true);
    router.refresh();
  }

  return (
    <div className={styles.pagination}>
      <div className={styles.leftGroup}>
        <span className={styles.range}>
          Visar {from.toLocaleString("sv-SE")}–{to.toLocaleString("sv-SE")} av {total.toLocaleString("sv-SE")}
        </span>
        <label className={styles.pageSize}>
          Rader per sida
          <select
            className={styles.pageSizeSelect}
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="Rader per sida"
          >
            {LIST_PAGE_SIZE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pageCount > 1 && (
        <div className={styles.pageButtons}>
          <button type="button" className={styles.pageButton} disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Föregående
          </button>
          {pageItems(page, pageCount).map((item, i) =>
            item === "…" ? (
              <span key={`gap-${i}`} className={styles.ellipsis}>
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                className={styles.pageButton}
                data-active={item === page}
                onClick={() => setPage(item)}
              >
                {item}
              </button>
            )
          )}
          <button
            type="button"
            className={styles.pageButton}
            disabled={page >= pageCount}
            onClick={() => setPage(page + 1)}
          >
            Nästa
          </button>
        </div>
      )}
    </div>
  );
}
