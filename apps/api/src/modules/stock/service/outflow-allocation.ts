// Uttag där saldot finns — the ONE rule for where an outflow without a chosen
// location is taken from (utleverans, materialuttag, lego receipt draw), and
// the order the pick list prints the locations in, so the paper and the
// booking say the same thing. Pure: no DB imports; outflow-locations.ts reads
// the balances and calls this.
//
//   1. The article's own Lagerplats (when active) up to its positive balance.
//   2. Other locations with a positive balance in pick-list order (warehouse,
//      location), the "***" fallback last. Locations under a BLOCKING stock
//      count are skipped (a draw there would be refused anyway), and so are
//      Spärrade lagerplatser (0185) — their stock is not usable.
//   3. What is still missing is the remainder — the caller takes it from
//      resolveStockLocation (own location, else "***") and lets it go negative
//      there, exactly as every outflow did before the split.
//
// Quantities are the stock column's 4 decimals; a part is never 0.

export interface OutflowCandidate {
  locationId: string;
  warehouseName: string;
  locationName: string;
  // sum(quantity_delta) for the article on the location.
  quantityOnHand: number;
  // The location is articles.default_location_id.
  isDefault: boolean;
  active: boolean;
  // Skipped: an open stock count with blocks_transactions covers the
  // location, or the location itself is a Spärrad lagerplats.
  blocked: boolean;
}

export interface OutflowPart {
  locationId: string;
  quantity: number;
}

export const FALLBACK_LOCATION_NAME = "***";

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

// Pick-list order: the article's own location first, then by warehouse and
// location name, the fallback last. Same collation as the terminal's material
// sort (sv, numeric) so "A2" sorts before "A10".
export function compareOutflowLocations(
  a: Pick<OutflowCandidate, "warehouseName" | "locationName" | "isDefault">,
  b: Pick<OutflowCandidate, "warehouseName" | "locationName" | "isDefault">
): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  const aFallback = a.locationName === FALLBACK_LOCATION_NAME;
  const bFallback = b.locationName === FALLBACK_LOCATION_NAME;
  if (aFallback !== bFallback) return aFallback ? 1 : -1;
  return (
    a.warehouseName.localeCompare(b.warehouseName, "sv", { numeric: true }) ||
    a.locationName.localeCompare(b.locationName, "sv", { numeric: true })
  );
}

export function allocateOutflow(
  quantity: number,
  candidates: readonly OutflowCandidate[]
): { parts: OutflowPart[]; remainder: number } {
  const parts: OutflowPart[] = [];
  let left = round4(quantity);
  if (left <= 0) return { parts, remainder: 0 };

  const usable = candidates
    .filter((c) => c.active && !c.blocked && c.quantityOnHand > 0)
    .sort(compareOutflowLocations);

  for (const candidate of usable) {
    if (left <= 0) break;
    const take = round4(Math.min(left, candidate.quantityOnHand));
    if (take <= 0) continue;
    parts.push({ locationId: candidate.locationId, quantity: take });
    left = round4(left - take);
  }
  return { parts, remainder: Math.max(left, 0) };
}

// The remainder lands on the fallback location; when the allocation already
// drew from it (the own location held part of the quantity) the two merge
// into one part, so a draw never writes two rows on the same location.
export function withRemainder(parts: OutflowPart[], remainder: number, fallbackLocationId: string): OutflowPart[] {
  if (remainder <= 0) return parts;
  const existing = parts.find((p) => p.locationId === fallbackLocationId);
  if (existing) {
    return parts.map((p) => (p === existing ? { ...p, quantity: round4(p.quantity + remainder) } : p));
  }
  return [...parts, { locationId: fallbackLocationId, quantity: remainder }];
}
