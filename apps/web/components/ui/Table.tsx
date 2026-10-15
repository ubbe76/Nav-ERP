import type { ReactNode } from "react";
import styles from "./Table.module.css";

interface Column {
  key: string;
  label: string;
  width: string;
  align?: "left" | "right";
  // Replaces `label` in the header cell only (e.g. a select-all checkbox).
  // `label` stays a plain string because it also drives `data-label`, the
  // heading the mobile stack prints in front of every cell.
  header?: ReactNode;
}

interface TableProps<T extends { id: string }> {
  columns: Column[];
  rows: T[];
  renderCell: (row: T, columnKey: string) => ReactNode;
  emptyText?: string;
  // Summary row keyed by column — omitted keys render empty. Used for the
  // order total on the document cards.
  footer?: Record<string, ReactNode>;
  // A row marked from the keyboard (artikelregistret's search field walks it
  // with the arrow keys) — styled like a hovered row with an accent edge.
  highlightedRowId?: string | null;
}

// Horizontal spacing lives inside the cells (see Table.module.css): 20px at
// the table's edges and 12px between columns. The whole table is ONE grid,
// so header, rows and footer share the same track resolution and always
// line up — with one grid per row, `fr` tracks were floored by each row's
// own min-content and the columns drifted apart from the header.
const EDGE_PADDING = 20;
const COLUMN_GAP = 12;

// Callers give widths as the visible content width ("70px", "1fr",
// "minmax(220px, 2fr)"). Fixed px tracks are widened by the padding their
// cell carries so a "70px" column still shows 70px of content; flexible
// tracks absorb the padding the way they absorbed the old gap.
function trackWidth(width: string, index: number, count: number): string {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(width.trim());
  if (!px) return width;
  const extra = (index === 0 ? EDGE_PADDING : 0) + (index === count - 1 ? EDGE_PADDING : COLUMN_GAP);
  return `${Number(px[1]) + extra}px`;
}

export function Table<T extends { id: string }>({
  columns,
  rows,
  renderCell,
  emptyText = "Inga rader att visa",
  footer,
  highlightedRowId,
}: TableProps<T>) {
  const gridTemplate = columns.map((c, i) => trackWidth(c.width, i, columns.length)).join(" ");

  return (
    <div className={styles.table} style={{ gridTemplateColumns: gridTemplate }}>
      <div className={styles.headerRow}>
        {columns.map((col) => (
          <div key={col.key} className={styles.headerCell} data-align={col.align ?? "left"}>
            {col.header ?? col.label}
          </div>
        ))}
      </div>
      {rows.length === 0 && <div className={styles.empty}>{emptyText}</div>}
      {rows.map((row) => (
        <div className={styles.row} key={row.id} data-highlighted={row.id === highlightedRowId || undefined}>
          {columns.map((col) => (
            <div key={col.key} className={styles.cell} data-align={col.align ?? "left"} data-label={col.label}>
              {renderCell(row, col.key)}
            </div>
          ))}
        </div>
      ))}
      {footer && rows.length > 0 && (
        <div className={styles.footerRow}>
          {columns.map((col) => (
            <div
              key={col.key}
              className={styles.cell}
              data-align={col.align ?? "left"}
              // Only labelled cells get a label in the mobile stack —
              // otherwise the empty summary columns each print a heading.
              data-label={footer[col.key] === undefined ? undefined : col.label}
            >
              {footer[col.key]}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
