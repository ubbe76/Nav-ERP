"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Modal } from "./ui/Modal";
import styles from "./KeyboardShortcuts.module.css";

// Tangentbordet först (Nav som program, punkt 4). Only plain keys, and only
// while no field has the focus and no dialog is open, so typing is never
// taken over; the browser's own shortcuts are left alone:
// - ? shows the shortcuts,
// - N clicks the page's "+ Ny …" (its tooltip says so),
// - ↑/↓ move a marked row in a list (a page with ListControls' toolbar —
//   elsewhere the arrows scroll as usual), Enter opens it, Esc unmarks it,
// - a right-click on a table row opens its ⋯ menu (a right-click on a link
//   keeps the browser's menu, e.g. Öppna i ny flik).
export const SHORTCUTS: { keys: string[]; text: string }[] = [
  { keys: ["Ctrl", "K"], text: "Sök eller gå till" },
  { keys: ["N"], text: "Ny (sidans + Ny …)" },
  { keys: ["↑", "↓"], text: "Flytta i listan" },
  { keys: ["Enter"], text: "Öppna den markerade raden" },
  { keys: ["Ctrl", "S"], text: "Spara formuläret du står i" },
  { keys: ["Esc"], text: "Stäng dialogen eller avmarkera raden" },
  { keys: ["?"], text: "Visa kortkommandon" },
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function dialogOpen(): boolean {
  if (document.querySelector("dialog[open], [role='dialog'][aria-modal='true']")) return true;
  try {
    // An open ⋯ menu (popover) keeps its own arrow keys. Older browsers lack
    // the pseudo-class and throw.
    return !!document.querySelector(":popover-open");
  } catch {
    return false;
  }
}

// The list's table: the first one after the list toolbar.
function listRows(): HTMLElement[] {
  const toolbar = document.querySelector("main [data-list-toolbar]");
  if (!toolbar) return [];
  const table = [...document.querySelectorAll<HTMLElement>("main [data-table]")].find(
    (t) => toolbar.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING
  );
  if (!table) return [];
  return [...table.querySelectorAll<HTMLElement>(":scope > [data-row]")].filter((row) => row.querySelector("a[href]"));
}

function newButton(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>("main a[href], main button");
  for (const el of candidates) {
    const text = el.textContent?.trim() ?? "";
    if (text.startsWith("+ Ny") && el.offsetParent !== null && !(el as HTMLButtonElement).disabled) return el;
  }
  return null;
}

export function KeyboardShortcuts() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);
  const focused = useRef<HTMLElement | null>(null);

  function mark(row: HTMLElement | null) {
    focused.current?.removeAttribute("data-kbd-focus");
    focused.current = row;
    if (row) {
      row.setAttribute("data-kbd-focus", "");
      // A table row is display: contents (its cells sit in the grid), so
      // the first cell is what has a box to scroll to.
      (row.firstElementChild ?? row).scrollIntoView({ block: "nearest" });
    }
  }

  // A new page or a new filter starts unmarked.
  useEffect(() => {
    mark(null);
  }, [pathname, searchParams]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTyping(e.target) || dialogOpen()) return;

      if (e.key === "?") {
        e.preventDefault();
        setSheetOpen(true);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        const button = newButton();
        if (button) {
          e.preventDefault();
          button.click();
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = listRows();
        if (rows.length === 0) return;
        e.preventDefault();
        const current = focused.current && rows.includes(focused.current) ? rows.indexOf(focused.current) : -1;
        const next =
          e.key === "ArrowDown" ? Math.min(current + 1, rows.length - 1) : current === -1 ? rows.length - 1 : Math.max(current - 1, 0);
        mark(rows[next]!);
        return;
      }
      if (e.key === "Enter" && focused.current?.isConnected) {
        // A focused button or link keeps its own Enter.
        const active = document.activeElement;
        if (active && active !== document.body && !focused.current.contains(active)) return;
        const link = focused.current.querySelector<HTMLAnchorElement>("a[href]");
        if (link) {
          e.preventDefault();
          link.click();
        }
        return;
      }
      if (e.key === "Escape" && focused.current) {
        mark(null);
      }
    }

    function onContextMenu(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target || target.closest("a[href]")) return;
      const row = target.closest<HTMLElement>("[data-row]");
      const trigger = row?.querySelector<HTMLButtonElement>("[data-row-menu]");
      if (!trigger) return;
      e.preventDefault();
      trigger.click();
    }

    // The shortcut in the tooltip: the button N would click gets "(N)" in
    // its title when the pointer or the focus reaches it — marked then
    // rather than on render, since the pages draw their "+ Ny …" themselves
    // and some only after their data has arrived. A title of its own is kept.
    function onPointOrFocus(e: Event) {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("a[href], button");
      if (!el || el.hasAttribute("data-kbd-hint") || el !== newButton()) return;
      el.setAttribute("data-kbd-hint", "");
      el.setAttribute("aria-keyshortcuts", "N");
      if (!el.title) el.title = `${el.textContent?.trim().replace(/^\+\s*/, "") ?? "Ny"} (N)`;
    }

    document.addEventListener("keydown", onKey);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("mouseover", onPointOrFocus);
    document.addEventListener("focusin", onPointOrFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("mouseover", onPointOrFocus);
      document.removeEventListener("focusin", onPointOrFocus);
    };
  }, []);

  return (
    <Modal open={sheetOpen} onClose={() => setSheetOpen(false)} title="Kortkommandon" compact>
      <dl className={styles.list}>
        {SHORTCUTS.map((s) => (
          <div key={s.text} className={styles.row}>
            <dt className={styles.keys}>
              {s.keys.map((k) => (
                <kbd key={k} className={styles.kbd}>
                  {k}
                </kbd>
              ))}
            </dt>
            <dd className={styles.text}>{s.text}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.hint}>
        Genvägarna gäller när du inte skriver i ett fält. På Mac är Ctrl ⌘. Högerklick på en rad öppnar radens ⋯-meny.
      </p>
    </Modal>
  );
}
