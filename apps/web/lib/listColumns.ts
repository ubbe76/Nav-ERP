// Täthet och kolumner (Nav som program, punkt 6). Mirrors the settings in
// packages/shared/src/user-settings.ts (TABLE_DENSITIES, listColumnsSchema)
// — the web can't import @navet/shared (see lib/units.ts); the constants are
// compared by web-list-columns.test.ts.

export const TABLE_DENSITIES = ["normal", "compact"] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];
export const DENSITY_LABELS: Record<TableDensity, string> = { normal: "Normal", compact: "Kompakt" };

export const LIST_COLUMN_MIN_WIDTH = 40;
export const LIST_COLUMN_MAX_WIDTH = 1600;

// Per list page (its path): the column keys the user hid and the widths they
// dragged, in content px (what the column shows — Table adds the padding).
export interface ListColumnsEntry {
  hidden: string[];
  widths: Record<string, number>;
}
export type ListColumns = Record<string, ListColumnsEntry>;

// The part of a Table column this needs (components/ui/Table.tsx).
export interface ColumnLike {
  key: string;
  label: string;
  width: string;
  header?: unknown;
}

// A control column: the select-all checkbox (a header of its own) or the ⋯
// actions (no heading).
function isControlColumn(column: ColumnLike): boolean {
  return column.header !== undefined || column.label.trim() === "";
}

// What may be hidden: never a control column, nor the first column after
// them — the row's number or name, the link Enter opens (on a list with
// checkboxes that is the second column). Shaped for Array.filter.
export function canHideColumn(column: ColumnLike, index: number, columns: readonly ColumnLike[]): boolean {
  if (isControlColumn(column)) return false;
  return columns.findIndex((c) => !isControlColumn(c)) !== index;
}

// The columns as the user set them up: hidden ones left out (only those that
// may be hidden — a stored key for a column that has become the first one
// is ignored) and dragged widths as fixed px. A key that no longer exists
// matches nothing.
export function applyListColumns<C extends ColumnLike>(columns: C[], entry: ListColumnsEntry | undefined): C[] {
  if (!entry) return columns;
  const hidden = new Set(entry.hidden);
  return columns
    .filter((column, index) => !(hidden.has(column.key) && canHideColumn(column, index, columns)))
    .map((column) => {
      const width = entry.widths[column.key];
      return width === undefined ? column : { ...column, width: `${width}px` };
    });
}

export function clampColumnWidth(width: number): number {
  return Math.min(LIST_COLUMN_MAX_WIDTH, Math.max(LIST_COLUMN_MIN_WIDTH, Math.round(width)));
}

// The list's key: its path, as the settings schema takes it (lower case,
// a-z 0-9 / _ -). A path outside that — an id in it — gets no settings.
// An id in the path (a card's own list) would give every card its own
// settings, so such a path gets none.
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/;
export function listColumnsKey(pathname: string): string | null {
  const key = pathname.replace(/\/+$/, "") || "/";
  if (UUID_SEGMENT.test(key)) return null;
  return /^\/[a-z0-9/_-]{0,79}$/.test(key) ? key : null;
}

export function isEmptyEntry(entry: ListColumnsEntry): boolean {
  return entry.hidden.length === 0 && Object.keys(entry.widths).length === 0;
}
