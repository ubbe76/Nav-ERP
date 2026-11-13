// Uttag där saldot finns — the ONE rule for where an outflow without a chosen
// location is taken from (utleverans, materialuttag, lego receipt draw), and
// the order the pick list prints the locations in, so the paper and the
// booking say the same thing. Pure: no DB imports; outflow-locations.ts reads
// the balances and calls this.
//
//   1. The article's huvudplats (when active) up to its positive balance —
//      none when it is "***" (articlePlacePreference).
//   2. Its alternative places (0186) in their order, likewise.
//   3. Other locations with a positive balance in pick-list order (warehouse,
//      location), the "***" fallback last. Locations under a BLOCKING stock
//      count are skipped (a draw there would be refused anyway), and so are
//      Spärrade lagerplatser (0185) — their stock is not usable.
//   4. What is still missing is the remainder — the caller takes it from
//      resolveStockLocation (the huvudplats, else the first usable
//      alternative, else "***") and lets it go negative there, exactly as
//      every outflow did before the split.
//
// Quantities are the stock column's 4 decimals; a part is never 0.
import { round4 } from "@navet/shared";
import { BatchInsufficientError } from "./batch.errors.js";

export interface OutflowCandidate {
  locationId: string;
  warehouseName: string;
  locationName: string;
  // sum(quantity_delta) for the article on the location.
  quantityOnHand: number;
  // The article's own order of places — always articlePlacePreference.
  preference: number | null;
  active: boolean;
  // Skipped: an open stock count with blocks_transactions covers the
  // location, or the location itself is a Spärrad lagerplats.
  blocked: boolean;
}

export interface OutflowPart {
  locationId: string;
  quantity: number;
  // Batch (#8): the batch the part is taken from — null = Okänd. Left out on
  // the path of an article that is not batchstyrd (the writer then books the
  // row without a batch, exactly as before).
  batchId?: string | null;
}

export const FALLBACK_LOCATION_NAME = "***";

// The article's own rank of a place — the ONE rule that inflows
// (usableArticleLocations), Automatiskt (readCandidates) and the pick list
// (balancesForArticles) all read: 0 = the huvudplats
// (articles.default_location_id), 1–20 = an alternative place
// (article_alternative_locations.sort_order), null = any other place.
//
// The "***" fallback is never one of the article's own places: every article
// created without a place, and every imported one, has it as huvudplats, so
// a huvudplats that is "***" counts as NO huvudplats. Its alternatives then
// come first — an inflow lands on the first usable one, Automatiskt and the
// pick list take them before the others — and "***" sorts last, exactly as
// for an article whose huvudplats is empty. The stored value stays "***".
// (PUT refuses "***" as an alternative, so it never has a sort_order.)
export function articlePlacePreference(place: { locationName: string; isPrimary: boolean; sortOrder: number | null }): number | null {
  if (place.locationName === FALLBACK_LOCATION_NAME) return null;
  if (place.isPrimary) return 0;
  return place.sortOrder;
}

// Pick-list order: the article's own places first (huvudplats, then the
// alternatives in order — `preference` from articlePlacePreference), then by
// warehouse and location name, the fallback last. Same collation as the
// terminal's material sort (sv, numeric) so "A2" sorts before "A10".
export function compareOutflowLocations(
  a: Pick<OutflowCandidate, "warehouseName" | "locationName" | "preference">,
  b: Pick<OutflowCandidate, "warehouseName" | "locationName" | "preference">
): number {
  if (a.preference !== b.preference) {
    if (a.preference === null) return 1;
    if (b.preference === null) return -1;
    return a.preference - b.preference;
  }
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

// ---------------------------------------------------------------------------
// Batch (#8) — the same rule per CELL (place, batch) for a batchstyrd
// article. allocateOutflow/withRemainder above are untouched: an article that
// is not batchstyrd goes exactly the way it always did.
//
// Automatiskt (no place, no batch chosen):
//   1. The usable places are the ones above: active, not blocked/under a
//      blocking count, and a NET balance > 0 (OutflowCandidate.quantityOnHand,
//      the sum over the place's batches). Each place has a CEILING = that
//      net balance: a place holding batch X +10 and Okänd −3 physically has 7,
//      and never gives more than 7 — as it never gave more than its positive
//      balance before batches.
//   2. The batches in compareBatches order (FEFO): Okänd (no batch) FIRST,
//      then the dated ones (shortest utgångsdatum first), then the undated,
//      oldest first (Batchdatum, else created_at), then the batch number
//      (the saldoimport creates all its batches in one instant — the number
//      then decides, beslut 16). With `expiredBefore`, expired batches are
//      skipped.
//      Within a batch its cells with a balance > 0 on usable places, in
//      pick-list order (compareOutflowLocations).
//   3. From each cell min(what is left, the cell, the place's remaining
//      ceiling); 4 decimals, never a part of 0.
//   4. What is still missing is the remainder: the caller books it as OKÄND
//      on resolveStockLocation's place (withBatchRemainder) — only Okänd can
//      go negative.
//
// A CHOSEN batch: only that batch's cells (step 2 with one batch). A named
// batch that does not cover the quantity is refused — BatchInsufficientError,
// 409: a named batch never goes negative (beslut 11). Chosen Okänd: the
// remainder as in step 4.
//
// A CHOSEN place (`locationId`): only the cells on it, oldest batch first,
// and no ceiling and no usable-filter — a chosen place may go negative, as it
// always could, and the loader has already tried its block. The remainder
// becomes Okänd on that place.
// ---------------------------------------------------------------------------

export interface BatchCell {
  locationId: string;
  // null = Okänd (stock booked without a batch).
  batchId: string | null;
  batchNumber: string | null;
  batchCreatedAt: Date | null;
  // Utgångsdatum (etapp 2): the batch's LAST usable day, YYYY-MM-DD; null or
  // left out = no date.
  expiresOn?: string | null;
  // The batch's age as a Stockholm day: its Batchdatum, else the day the row
  // was created (the readers compute it in SQL). Left out = created_at alone.
  batchAgeDate?: string | null;
  // sum(quantity_delta) of the cell; may be negative for Okänd.
  quantity: number;
}

type BatchKey = Pick<BatchCell, "batchId" | "batchNumber" | "batchCreatedAt" | "expiresOn" | "batchAgeDate">;

// Utgången = the Stockholm day is past the batch's last usable day. The ONE
// comparison; `today` is always passed in (stockholmToday), never read here.
export function isBatchExpired(expiresOn: string | null | undefined, today: string): boolean {
  return expiresOn != null && expiresOn < today;
}

// The order batches are drawn (and listed) in — FEFO (etapp 2, beslut 10):
//   1. Okänd first (undated, unknown — it should go first);
//   2. the batches WITH an utgångsdatum, the shortest date first;
//   3. the batches WITHOUT one, oldest first.
// Ties (and all of 3): the age day (Batchdatum, else the day of creation),
// then created_at, then the number (sv, numeric), then the id. For an
// article none of whose batches has a date this is exactly the order before
// FEFO — oldest first.
export function compareBatches(a: BatchKey, b: BatchKey): number {
  if (a.batchId === b.batchId) return 0;
  if (a.batchId === null) return -1;
  if (b.batchId === null) return 1;
  const aExpires = a.expiresOn ?? null;
  const bExpires = b.expiresOn ?? null;
  if (aExpires !== bExpires) {
    if (aExpires === null) return 1;
    if (bExpires === null) return -1;
    return aExpires < bExpires ? -1 : 1;
  }
  const aAge = a.batchAgeDate ?? null;
  const bAge = b.batchAgeDate ?? null;
  if (aAge !== null && bAge !== null && aAge !== bAge) return aAge < bAge ? -1 : 1;
  const aTime = a.batchCreatedAt?.getTime() ?? 0;
  const bTime = b.batchCreatedAt?.getTime() ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  return (
    (a.batchNumber ?? "").localeCompare(b.batchNumber ?? "", "sv", { numeric: true }) || (a.batchId < b.batchId ? -1 : 1)
  );
}

type PlaceKey = Pick<OutflowCandidate, "warehouseName" | "locationName" | "preference">;

// Batch first, then the place — the order Automatiskt takes the cells in,
// and so the order the pick list prints them (the paper and the booking say
// the same thing).
export function compareBatchCells(a: { batch: BatchKey; place: PlaceKey }, b: { batch: BatchKey; place: PlaceKey }): number {
  return compareBatches(a.batch, b.batch) || compareOutflowLocations(a.place, b.place);
}

export interface BatchOutflowChoice {
  // Left out = every batch, oldest first; batchId null = Okänd. The number
  // is only for the error text (the cells carry it when the batch has stock).
  batch?: { batchId: string | null; batchNumber?: string | null };
  // A chosen place: only its cells, no ceiling (see above).
  locationId?: string;
  // Utgångna (etapp 2, beslut 8 and 12): a Stockholm day. With NO chosen
  // batch, the cells of a batch whose utgångsdatum is before it are left
  // alone — what they would have covered becomes the remainder (Okänd
  // minus, like any shortage). A CHOSEN batch is never tried against the
  // date: expired stock can be taken by hand. Left out = nothing is skipped
  // (flytt, negativ justering, saldoimporten: moving or scrapping expired
  // stock is exactly what must work).
  expiredBefore?: string | undefined;
}

export function allocateBatchOutflow(
  quantity: number,
  places: readonly OutflowCandidate[],
  cells: readonly BatchCell[],
  choice: BatchOutflowChoice = {}
): { parts: OutflowPart[]; remainder: number } {
  const parts: OutflowPart[] = [];
  let left = round4(quantity);
  if (left <= 0) return { parts, remainder: 0 };

  const placeById = new Map(places.map((p) => [p.locationId, p]));
  // The remaining ceiling per usable place; a chosen place has none.
  const ceiling = new Map<string, number>();
  if (choice.locationId === undefined) {
    for (const p of places) {
      if (p.active && !p.blocked && p.quantityOnHand > 0) ceiling.set(p.locationId, round4(p.quantityOnHand));
    }
  }
  const chosenBatch = choice.batch;
  const candidates = cells
    .filter((c) => c.quantity > 0)
    .filter((c) => (choice.locationId === undefined ? ceiling.has(c.locationId) : c.locationId === choice.locationId))
    .filter((c) => chosenBatch === undefined || c.batchId === chosenBatch.batchId)
    // An expired cell stays in its place's net balance (the ceiling) but is
    // not taken — the ceiling can only be more generous than the cells left.
    .filter((c) => chosenBatch !== undefined || choice.expiredBefore === undefined || !isBatchExpired(c.expiresOn, choice.expiredBefore))
    .sort((a, b) => {
      const byBatch = compareBatches(a, b);
      if (byBatch !== 0) return byBatch;
      const aPlace = placeById.get(a.locationId);
      const bPlace = placeById.get(b.locationId);
      return aPlace && bPlace ? compareOutflowLocations(aPlace, bPlace) : 0;
    });

  for (const cell of candidates) {
    if (left <= 0) break;
    const room = choice.locationId === undefined ? (ceiling.get(cell.locationId) ?? 0) : Infinity;
    const take = round4(Math.min(left, cell.quantity, room));
    if (take <= 0) continue;
    parts.push({ locationId: cell.locationId, quantity: take, batchId: cell.batchId });
    left = round4(left - take);
    if (choice.locationId === undefined) ceiling.set(cell.locationId, round4(room - take));
  }

  const remainder = Math.max(left, 0);
  if (remainder > 0 && chosenBatch && chosenBatch.batchId !== null) {
    const batchNumber = chosenBatch.batchNumber ?? cells.find((c) => c.batchId === chosenBatch.batchId)?.batchNumber ?? chosenBatch.batchId;
    throw new BatchInsufficientError(batchNumber, round4(round4(quantity) - remainder), round4(quantity));
  }
  return { parts, remainder };
}

// The remainder of a batch allocation is booked as Okänd on the place the
// caller resolved (resolveStockLocation, or the chosen place); it merges with
// a part already taken from Okänd on that place, so a draw never writes two
// rows in one cell.
export function withBatchRemainder(parts: OutflowPart[], remainder: number, locationId: string): OutflowPart[] {
  if (remainder <= 0) return parts;
  const existing = parts.find((p) => p.locationId === locationId && (p.batchId ?? null) === null);
  if (existing) {
    return parts.map((p) => (p === existing ? { ...p, quantity: round4(p.quantity + remainder) } : p));
  }
  return [...parts, { locationId, quantity: remainder, batchId: null }];
}
