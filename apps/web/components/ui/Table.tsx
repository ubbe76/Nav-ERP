import { Fragment, type ReactNode } from "react";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { ColumnDragGrip } from "./ColumnDragGrip";
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
  // A row typed straight into the table (Programramen steg 3: + Ny rad on the
  // order cards) — after the rows, before the summary row, keyed by column
  // like the footer. `span` lets a cell take the next columns too (the
  // article picker over Artikelnummer and Benämning).
  entryRow?: { cells: Record<string, ReactNode>; span?: Record<string, number> };
  // A row marked from the keyboard (artikelregistret's search field walks it
  // with the arrow keys) — styled like a hovered row with an accent edge.
  highlightedRowId?: string | null;
  // Kolumnbredd (Nav som program, punkt 6): every header cell gets a drag
  // edge; the new content width (null = reset) goes here. Only from a client
  // component — useListColumns hands it out.
  onColumnResize?: (key: string, width: number | null) => void;
  // Kolumnordning: the movable columns get a grip in their header cell; a
  // drop calls this. Only from a client component — useListColumns hands
  // out both.
  onColumnReorder?: (fromKey: string, toKey: string, after: boolean) => void;
  reorderableKeys?: readonly string[];
  // Återkoppling (Nav som program, punkt 7): while the rows are on their way
  // the table shows grey placeholder rows in its own shape instead of a
  // "Hämtar …" line. Only while there are no rows to show yet.
  loading?: boolean;
  loadingRows?: number;
  // The row the user is working in: a click anywhere in it or focus moving
  // into one of its fields (React's onFocus bubbles). Behovsberäkning points
  // the open Artikelöversikt panel at the row's article with it.
  onRowFocus?: (row: T) => void;
  // An unfolded part under a row, across every column (the kundorder row's
  // Leveransläge list). null/undefined = nothing is drawn. It scrolls with
  // the table but its content stays at the left edge. Wide screens only:
  // in the stacked row cards of a phone it is hidden (it would land after
  // the card's last line) — the caller shows it inside a cell there.
  rowDetail?: (row: T) => ReactNode;
}

// Placeholder widths, varied so the rows don't read as a solid block.
const SKELETON_WIDTHS = ["70%", "55%", "85%", "60%", "75%"];

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
function trackExtra(index: number, count: number): number {
  return (index === 0 ? EDGE_PADDING : 0) + (index === count - 1 ? EDGE_PADDING : COLUMN_GAP);
}

function trackWidth(width: string, index: number, count: number): string {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(width.trim());
  if (!px) return width;
  return `${Number(px[1]) + trackExtra(index, count)}px`;
}

// A flexible track with a content floor: "minmax(<floor + gap>px, <fr>fr)".
// trackWidth widens only plain px tracks by the padding their cell carries,
// so a minmax() floor has to include the 12px column gap itself — use this
// for columns that should share the spare width (the figure columns on the
// order cards) without shrinking below their content.
export function shareTrack(contentPx: number, fr = 1): string {
  return `minmax(${contentPx + COLUMN_GAP}px, ${fr}fr)`;
}

export function Table<T extends { id: string }>({
  columns,
  rows,
  renderCell,
  emptyText = "Inga rader att visa",
  footer,
  entryRow,
  highlightedRowId,
  onColumnResize,
  onColumnReorder,
  reorderableKeys,
  loading = false,
  loadingRows = 5,
  onRowFocus,
  rowDetail,
}: TableProps<T>) {
  const gridTemplate = columns.map((c, i) => trackWidth(c.width, i, columns.length)).join(" ");
  const skeleton = loading && rows.length === 0;
  // Lås första kolumnen (user's choice 2026-11-23): a table wider than its
  // card scrolls sideways with the first column held at the left edge, like
  // a spreadsheet — the order cards beside the narrow list are 580–740 px on
  // a laptop. Not when the first column is unlabelled (a select checkbox):
  // a pinned checkbox says nothing about the row.
  const stickyFirst = columns.length > 1 && columns[0]!.label.trim() !== "";

  return (
    // data-table / data-row: the keyboard shortcuts' handles (KeyboardShortcuts —
    // ↑/↓ and Enter in a list, right-click opens the row's ⋯ menu).
    <div
      className={styles.table}
      style={{ gridTemplateColumns: gridTemplate }}
      data-table=""
      data-sticky-first={stickyFirst || undefined}
      aria-busy={skeleton || undefined}
    >
      <div className={styles.headerRow}>
        {columns.map((col, i) => (
          <div key={col.key} className={styles.headerCell} data-align={col.align ?? "left"}>
            {onColumnReorder && reorderableKeys?.includes(col.key) && (
              <ColumnDragGrip columnKey={col.key} label={col.label} onReorder={onColumnReorder} />
            )}
            {col.header ?? col.label}
            {onColumnResize && (
              <ColumnResizeHandle
                label={col.label}
                extra={trackExtra(i, columns.length)}
                onResize={(width) => onColumnResize(col.key, width)}
              />
            )}
          </div>
        ))}
      </div>
      {skeleton &&
        Array.from({ length: loadingRows }, (_, r) => (
          <div className={styles.row} key={`skeleton-${r}`} aria-hidden="true">
            {columns.map((col, c) => (
              <div key={col.key} className={styles.cell} data-align={col.align ?? "left"} data-label={col.label}>
                {col.label.trim() !== "" && col.header === undefined && (
                  <span className={styles.skeleton} style={{ width: SKELETON_WIDTHS[(r + c) % SKELETON_WIDTHS.length] }} />
                )}
              </div>
            ))}
          </div>
        ))}
      {skeleton && <span className={styles.srOnly}>Hämtar …</span>}
      {rows.length === 0 && !skeleton && !entryRow && <div className={styles.empty}>{emptyText}</div>}
      {rows.map((row) => {
        const detail = rowDetail?.(row);
        return (
          <Fragment key={row.id}>
            <div
              className={styles.row}
              data-row=""
              data-highlighted={row.id === highlightedRowId || undefined}
              onClick={onRowFocus ? () => onRowFocus(row) : undefined}
              onFocus={onRowFocus ? () => onRowFocus(row) : undefined}
            >
              {columns.map((col) => (
                <div key={col.key} className={styles.cell} data-align={col.align ?? "left"} data-label={col.label}>
                  {renderCell(row, col.key)}
                </div>
              ))}
            </div>
            {detail != null && detail !== false && (
              <div className={styles.rowDetail}>
                <div className={styles.rowDetailBody}>{detail}</div>
              </div>
            )}
          </Fragment>
        );
      })}
      {entryRow && (
        <div className={styles.entryRow} data-entry-row="">
          {entryCells(columns, entryRow.span).map(({ col, span }) => (
            <div
              key={col.key}
              className={styles.cell}
              data-align={col.align ?? "left"}
              data-label={entryRow.cells[col.key] === undefined ? undefined : col.label}
              style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
            >
              {entryRow.cells[col.key]}
            </div>
          ))}
        </div>
      )}
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

// The entry row's cells: a spanning cell swallows the columns it covers.
function entryCells(columns: Column[], spans: Record<string, number> = {}): { col: Column; span: number }[] {
  const out: { col: Column; span: number }[] = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    const span = Math.max(1, Math.min(spans[col.key] ?? 1, columns.length - i));
    out.push({ col, span });
    i += span - 1;
  }
  return out;
}

// Återkoppling (Nav som program, punkt 7): a table-shaped placeholder for a
// view whose table (and its columns) only exist once the data has arrived —
// the reports, the open items. The text is read out to screen readers only.
export function TableSkeleton({ label, columns = 5, rows = 5 }: { label: string; columns?: number; rows?: number }) {
  const template = Array.from({ length: columns }, (_, i) => (i === 0 ? "minmax(140px, 2fr)" : "minmax(80px, 1fr)")).join(" ");
  const cells = Array.from({ length: columns }, (_, i) => i);
  return (
    <div className={`${styles.table} ${styles.skeletonTable}`} style={{ gridTemplateColumns: template }} role="status" aria-busy="true">
      <span className={styles.srOnly}>{label}</span>
      <div className={styles.headerRow} aria-hidden="true">
        {cells.map((c) => (
          <div key={c} className={styles.headerCell}>
            <span className={styles.skeleton} style={{ width: "45%" }} />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={styles.row} aria-hidden="true">
          {cells.map((c) => (
            <div key={c} className={styles.cell} data-align={c === 0 ? "left" : "right"}>
              <span className={styles.skeleton} style={{ width: SKELETON_WIDTHS[(r + c) % SKELETON_WIDTHS.length] }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
