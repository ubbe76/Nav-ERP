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
  // Kolumnordning: the movable columns' keys in the user's order.
  order?: string[];
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

// Kolumnordning: the movable columns — the same as may be hidden — take the
// user's order in the places movable columns have; the control columns and
// the first column (the number, the link Enter opens) never move. Keys not
// in the order keep their built order after the ordered ones.
export function orderColumns<C extends ColumnLike>(columns: C[], order: readonly string[] | undefined): C[] {
  if (!order || order.length === 0) return columns;
  const movable = columns.filter(canHideColumn);
  const rank = new Map(order.map((key, i) => [key, i]));
  const sorted = movable
    .map((column, i) => ({ column, i }))
    .sort((a, b) => (rank.get(a.column.key) ?? Infinity) - (rank.get(b.column.key) ?? Infinity) || a.i - b.i)
    .map(({ column }) => column);
  let next = 0;
  return columns.map((column, index) => (canHideColumn(column, index, columns) ? sorted[next++]! : column));
}

// The new order after moving `fromKey` before `toKey` (after it with
// `after`), as the movable columns' keys. A move onto a column that cannot
// move, or of one, changes nothing.
export function movedColumnOrder(
  columns: readonly ColumnLike[],
  order: readonly string[] | undefined,
  fromKey: string,
  toKey: string,
  after: boolean
): string[] {
  const keys = orderColumns([...columns], order)
    .filter(canHideColumn)
    .map((c) => c.key);
  if (!keys.includes(fromKey) || !keys.includes(toKey) || fromKey === toKey) return keys;
  const without = keys.filter((k) => k !== fromKey);
  const at = without.indexOf(toKey) + (after ? 1 : 0);
  without.splice(at, 0, fromKey);
  return without;
}

// The columns as the user set them up: in their order, hidden ones left out
// (only those that may be hidden — a stored key for a column that has
// become the first one is ignored) and dragged widths as fixed px. A key
// that no longer exists matches nothing.
export function applyListColumns<C extends ColumnLike>(columns: C[], entry: ListColumnsEntry | undefined): C[] {
  if (!entry) return columns;
  const hidden = new Set(entry.hidden);
  const ordered = orderColumns(columns, entry.order);
  return ordered
    .filter((column, index) => !(hidden.has(column.key) && canHideColumn(column, index, ordered)))
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
  return entry.hidden.length === 0 && Object.keys(entry.widths).length === 0 && (entry.order?.length ?? 0) === 0;
}
