"use client";

import { navigateTo } from "../lib/tabNavigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { API_URL } from "../lib/api";
import {
  MIN_SEARCH_LENGTH,
  RECENT_KEY,
  addRecent,
  matchPages,
  palettePages,
  parseRecent,
  searchesFor,
  type PaletteRecord,
  type RecentPage,
} from "../lib/commandPalette";
import { useAccessUser } from "./PermissionsProvider";
import shellStyles from "./AppShell.module.css";
import styles from "./CommandPalette.module.css";

interface Entry {
  key: string;
  href: string;
  title: string;
  kind: string;
}

interface Group {
  label: string;
  entries: Entry[];
}

function readRecent(): RecentPage[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

function writeRecent(list: RecentPage[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private window or blocked storage — the list just stays empty.
  }
}

// Sök och kommandon (Nav som program, punkt 2): Ctrl+K (⌘K) or the field in
// the toolbar opens one search over the pages the user may open, documents,
// articles, customers and suppliers. Without text it lists the pages visited
// last. ↑/↓ choose, Enter opens, Esc closes. Only Ctrl+K is taken from the
// browser — never Ctrl+P, Ctrl+L or other browser shortcuts.
export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const user = useAccessUser();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<{ query: string; byKind: PaletteRecord[][] } | null>(null);
  const [recent, setRecent] = useState<RecentPage[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);

  const pages = useMemo(() => (user ? palettePages(user) : []), [user]);
  const searches = useMemo(() => (user ? searchesFor(user) : []), [user]);

  // Ctrl+K / ⌘K anywhere opens the palette (and closes it again).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((was) => !was);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Senast öppnade: the page's own title (the shell's .title, as Favorit
  // reads it) once it has rendered, under its address with filters.
  useEffect(() => {
    const href = `${pathname}${searchParams.size > 0 ? `?${searchParams.toString()}` : ""}`;
    const timer = window.setTimeout(() => {
      const title = pathname === "/" ? "Översikt" : document.querySelector(`.${shellStyles.title}`)?.textContent?.trim();
      if (!title) return;
      writeRecent(addRecent(readRecent(), { href, title: title.slice(0, 80) }));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [pathname, searchParams]);

  // Opening never clears the field and the input takes focus as it mounts
  // (autoFocus), so someone who types right after Ctrl+K loses nothing; the
  // text is cleared when the palette closes.
  useEffect(() => {
    if (open) {
      setRecent(readRecent());
      setActive(0);
    } else {
      setQuery("");
      setRecords(null);
    }
  }, [open]);

  // The record searches: debounced, every list in parallel, a late answer
  // for an older query is dropped.
  const trimmed = query.trim();
  useEffect(() => {
    if (!open || trimmed.length < MIN_SEARCH_LENGTH || searches.length === 0) {
      setRecords(null);
      return;
    }
    const mine = ++seq.current;
    const timer = window.setTimeout(async () => {
      const byKind = await Promise.all(
        searches.map(async (s) => {
          try {
            const res = await fetch(`${API_URL}${s.url(trimmed)}`, { credentials: "include" });
            if (!res.ok) return [];
            const body = (await res.json()) as { rows?: Record<string, unknown>[] };
            return (body.rows ?? []).map(s.map);
          } catch {
            return [];
          }
        })
      );
      if (mine === seq.current) setRecords({ query: trimmed, byKind });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, trimmed, searches]);

  const groups: Group[] = useMemo(() => {
    if (trimmed === "") {
      const items = recent.filter((r) => r.href !== `${pathname}`);
      return items.length > 0 ? [{ label: "Senast öppnade", entries: items.map((r) => ({ key: `recent:${r.href}`, href: r.href, title: r.title, kind: "" })) }] : [];
    }
    const out: Group[] = [];
    const docs = (records?.query === trimmed ? records.byKind : []).flat();
    if (docs.length > 0) out.push({ label: "Dokument och register", entries: docs });
    const hits = matchPages(trimmed, pages);
    if (hits.length > 0) {
      out.push({
        label: "Gå till",
        entries: hits.map((p) => ({ key: `page:${p.href}`, href: p.href, title: p.title, kind: p.module })),
      });
    }
    return out;
  }, [trimmed, records, pages, recent, pathname]);

  const flat = groups.flatMap((g) => g.entries);
  const searching = trimmed.length >= MIN_SEARCH_LENGTH && records?.query !== trimmed && searches.length > 0;

  useEffect(() => {
    setActive(0);
  }, [trimmed, records]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  // A document opens as a tab when the tabs are on, and from inside a tab
  // the frame around it opens what was chosen (punkt 5, lib/tabNavigation.ts).
  function go(entry: Entry) {
    setOpen(false);
    navigateTo(entry.href, entry.title, (href) => router.push(href));
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = flat[active];
      if (entry) go(entry);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  useEffect(() => {
    document.getElementById(`palette-item-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let index = -1;
  return (
    <>
      <button ref={triggerRef} type="button" className={styles.trigger} onClick={() => setOpen(true)} aria-label="Sök eller gå till (Ctrl+K)">
        <span className={styles.triggerText}>
          <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          <span className={styles.triggerLabel}>Sök eller gå till …</span>
        </span>
        <span className={styles.kbd}>Ctrl K</span>
      </button>
      {/* In a portal: the toolbar is a stacking context (sticky + z-index),
          and the mobile menu button would otherwise sit above the palette. */}
      {open &&
        createPortal(
        <div className={styles.overlay} onPointerDown={(e) => e.target === e.currentTarget && close()}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Sök och kommandon">
            <div className={styles.inputRow}>
              <Search size={18} strokeWidth={1.8} aria-hidden="true" />
              <input
                ref={inputRef}
                autoFocus
                className={styles.input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ordernummer, artikel, kund eller sida …"
                aria-label="Sök"
                aria-controls="palette-results"
                aria-activedescendant={flat[active] ? `palette-item-${active}` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <span className={styles.kbd}>Esc</span>
            </div>
            <div className={styles.results} id="palette-results" role="listbox">
              {groups.map((group) => (
                <div key={group.label} role="group" aria-label={group.label}>
                  <div className={styles.group}>{group.label}</div>
                  {group.entries.map((entry) => {
                    index += 1;
                    const i = index;
                    return (
                      <button
                        key={entry.key}
                        id={`palette-item-${i}`}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        data-active={i === active}
                        className={styles.item}
                        onPointerMove={() => setActive(i)}
                        onClick={() => go(entry)}
                      >
                        <span className={styles.itemTitle}>{entry.title}</span>
                        {entry.kind && <span className={styles.itemKind}>{entry.kind}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
              {flat.length === 0 && (
                <div className={styles.empty}>
                  {trimmed === ""
                    ? "Skriv ett ordernummer, ett artikelnummer, en kund eller namnet på en sida."
                    : searching
                      ? "Söker …"
                      : "Inget matchar."}
                </div>
              )}
            </div>
            <div className={styles.footer}>
              <span>
                <span className={styles.kbd}>↑</span> <span className={styles.kbd}>↓</span> välj
              </span>
              <span>
                <span className={styles.kbd}>Enter</span> öppna
              </span>
              <span>
                <span className={styles.kbd}>Esc</span> stäng
              </span>
            </div>
          </div>
        </div>,
          document.body
        )}
    </>
  );
}
