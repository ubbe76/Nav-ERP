"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Columns3 } from "lucide-react";
import { useUserPrefs } from "../UserPrefsProvider";
import { applyListColumns, canHideColumn, listColumnsKey, type ColumnLike, type ListColumnsEntry } from "../../lib/listColumns";
import styles from "./ListColumns.module.css";

// Kolumner (Nav som program, punkt 6): a list page's columns as the user set
// them up — hidden columns left out, dragged widths applied — saved per user
// and list (the page's path). The page puts `chooser` in its ListToolbar and
// hands `columns` and `onColumnResize` to its Table:
//
//   const view = useListColumns(columns);
//   <ListToolbar>{filters}{view.chooser}</ListToolbar>
//   <Table columns={view.columns} onColumnResize={view.onColumnResize} … />
export function useListColumns<C extends ColumnLike>(
  columns: C[]
): { columns: C[]; chooser: ReactNode; onColumnResize?: (key: string, width: number | null) => void } {
  const pathname = usePathname();
  const key = listColumnsKey(pathname);
  const { listColumns, setListColumns } = useUserPrefs();
  const entry = key ? listColumns[key] : undefined;
  const shown = useMemo(() => applyListColumns(columns, entry), [columns, entry]);

  if (!key) return { columns, chooser: null };

  const current: ListColumnsEntry = entry ?? { hidden: [], widths: {} };
  function onColumnResize(columnKey: string, width: number | null) {
    const widths = { ...current.widths };
    if (width === null) delete widths[columnKey];
    else widths[columnKey] = width;
    setListColumns(key!, { hidden: current.hidden, widths });
  }

  return {
    columns: shown,
    onColumnResize,
    chooser: <ColumnChooser columns={columns} entry={current} onChange={(next) => setListColumns(key, next)} />,
  };
}

function ColumnChooser({
  columns,
  entry,
  onChange,
}: {
  columns: ColumnLike[];
  entry: ListColumnsEntry;
  onChange: (entry: ListColumnsEntry | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const hideable = columns.filter(canHideColumn);
  const hidden = new Set(entry.hidden);
  const changed = entry.hidden.length > 0 || Object.keys(entry.widths).length > 0;

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
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

  if (hideable.length === 0) return null;

  function toggle(key: string, show: boolean) {
    const next = show ? entry.hidden.filter((k) => k !== key) : [...entry.hidden, key];
    onChange({ hidden: next, widths: entry.widths });
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        data-changed={changed || undefined}
        onClick={() => setOpen(!open)}
      >
        <Columns3 size={15} strokeWidth={1.8} aria-hidden="true" />
        Kolumner
      </button>
      {open && (
        <div className={styles.panel} id={panelId} role="group" aria-label="Kolumner i listan">
          <ul className={styles.list}>
            {hideable.map((column) => (
              <li key={column.key}>
                <label className={styles.option}>
                  <input
                    type="checkbox"
                    checked={!hidden.has(column.key)}
                    onChange={(e) => toggle(column.key, e.target.checked)}
                  />
                  {column.label}
                </label>
              </li>
            ))}
          </ul>
          <p className={styles.hint}>
            Dra i kanten på en kolumnrubrik för att ändra bredden; dubbelklicka på kanten för att återställa den.
          </p>
          <button type="button" className={styles.reset} disabled={!changed} onClick={() => onChange(null)}>
            Återställ kolumnerna
          </button>
        </div>
      )}
    </div>
  );
}
