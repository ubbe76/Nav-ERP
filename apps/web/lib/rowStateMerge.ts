// Per-row UI state (selection, edited quantity) merged with freshly fetched
// rows: a row the user has touched keeps its state ("manuellt vinner"); an
// untouched row is rebuilt from the new data, so a recomputed proposal shows
// up after Uppdatera instead of the value first seen. Rows not in `rows`
// (other pages) are left as they are. No imports — the API tests load it.
export function mergeUntouched<S extends { touched: boolean }, R>(
  prev: Record<string, S>,
  rows: R[],
  keyOf: (row: R) => string,
  make: (row: R) => S
): Record<string, S> {
  const next = { ...prev };
  for (const row of rows) {
    const key = keyOf(row);
    const current = next[key];
    if (!current || !current.touched) next[key] = make(row);
  }
  return next;
}
