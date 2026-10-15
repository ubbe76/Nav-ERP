// Keyboard walk over a result list from its search field (artikelregistret):
// ArrowDown marks the first row and moves down, stopping at the last;
// ArrowUp moves up and from the first row leaves the list (null = no row
// marked — Enter then just runs the search). A stale index (the list shrank)
// is pulled back inside before moving.
export function moveRowHighlight(current: number | null, key: "ArrowDown" | "ArrowUp", rowCount: number): number | null {
  if (rowCount === 0) return null;
  const at = current === null ? null : Math.min(current, rowCount - 1);
  if (key === "ArrowDown") return at === null ? 0 : Math.min(at + 1, rowCount - 1);
  if (at === null || at === 0) return null;
  return at - 1;
}
