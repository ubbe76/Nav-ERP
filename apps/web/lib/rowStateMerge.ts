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

// After the server recomputed (Uppdatera, or its one-minute cache ran out):
// every saved state is checked against `fresh` — every line of the current
// filter, not just the shown page. A state whose key is gone (the proposal
// moved to another week — the key carries the week — or was covered) is
// dropped, so it is never sent with its old behovsdatum; an untouched one is
// rebuilt from the new proposal; a touched one keeps what the user chose
// (`keepChoice`) on top of the new proposal's data.
export function reconcileWithRecomputed<S extends { touched: boolean }, R>(
  prev: Record<string, S>,
  fresh: R[],
  keyOf: (row: R) => string,
  make: (row: R) => S,
  keepChoice: (old: S, rebuilt: S) => S
): Record<string, S> {
  const byKey = new Map(fresh.map((row) => [keyOf(row), row]));
  const next: Record<string, S> = {};
  for (const [key, state] of Object.entries(prev)) {
    const row = byKey.get(key);
    if (row === undefined) continue;
    const rebuilt = make(row);
    next[key] = state.touched ? keepChoice(state, rebuilt) : rebuilt;
  }
  return next;
}
