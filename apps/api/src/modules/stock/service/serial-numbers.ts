import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { articles, numberSeries, stockBatches, stockLocations, stockTransactions, warehouses, type Db, type Tx } from "@navet/db";
import { SERIAL_NUMBERS_MAX } from "@navet/shared";
import { NumberSeriesNotConfiguredError, SeriesExhaustedError, formatSeriesNumber } from "../../system/service/number-series.js";
import {
  BatchKindMismatchError,
  SerialAlreadyInStockError,
  SerialCountMismatchError,
  SerialNumberTooLongError,
  SerialNumbersTooManyError,
  SerialSeriesInvalidError,
} from "./batch.errors.js";
import { normalizeBatchNumber, type StockBatchOrigin, type StockBatchRef } from "./batches.js";
import { trackingOf } from "./batch-tracking.js";

// Serienummer (#8 etapp 2, migration 0215) — the Db | Tx leaf every writer of
// a serienummerstyrd article's stock goes through. A serial number is a
// stock_batches row with kind = 'serial' whose balance is 0 or 1; where it
// stands is the log summed (never a stored place or status).
//
// The writer's rule (stock.md): a NAMED serial number is always booked as
// its own row ±1, after lockSerials; an INFLOW first proves the number is out
// of stock in total (assertSerialsOutOfStock) — also an Ångra that puts a
// number back. The trigger stock_transactions_serial_unit (NV002) is the
// guard behind the rule, never the rule.
//
// Lock order, for every writer: order → serierad → artiklar → platser →
// serienummerrader. The series row first (a TO report that may receive goods
// takes it right after the order row — lockSerialSeriesForReceipt), the
// serial number rows last, sorted on id.

export const DEFAULT_SERIAL_SERIES_KEY = "serial";
const NUMBER_WIDTH = 50;

// The serial number rows FOR NO KEY UPDATE, sorted on id — before the check
// and the INSERT. Outflows of one article are already serialised by the
// article lock; this is for the INFLOWS, which only hold KEY SHARE on the
// article: two simultaneous inleveranser of the same number (or an Ångra
// utleverans against a new inleverans) would otherwise both see balance 0.
// A writer that locked in the list's own order would deadlock (40P01)
// against one with the list reversed. FOR NO KEY UPDATE does not clash with
// the stock rows' FK (KEY SHARE).
export async function lockSerials(tx: Db | Tx, batchIds: readonly string[]): Promise<void> {
  const ids = [...new Set(batchIds)].sort();
  for (let i = 0; i < ids.length; i += 500) {
    await tx
      .select({ id: stockBatches.id })
      .from(stockBatches)
      .where(inArray(stockBatches.id, ids.slice(i, i + 500)))
      .orderBy(asc(stockBatches.id))
      .for("no key update");
  }
}

// None of the numbers stands in stock anywhere — 409 serial-already-in-stock
// with the first one that does and its place. Call after lockSerials.
export async function assertSerialsOutOfStock(tx: Db | Tx, batchIds: readonly string[]): Promise<void> {
  const ids = [...new Set(batchIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const [taken] = await tx
      .select({
        batchNumber: stockBatches.batchNumber,
        warehouseName: warehouses.name,
        locationName: stockLocations.name,
        quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
      })
      .from(stockTransactions)
      .innerJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
      .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
      .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
      .where(inArray(stockTransactions.batchId, ids.slice(i, i + 500)))
      .groupBy(stockBatches.id, stockBatches.batchNumber, warehouses.name, stockLocations.name)
      .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`)
      .orderBy(asc(stockBatches.batchNumber))
      .limit(1);
    if (taken) throw new SerialAlreadyInStockError(taken.batchNumber, `${taken.warehouseName} — ${taken.locationName}`);
  }
}

// At most SERIAL_NUMBERS_MAX numbers per movement (400).
export function assertSerialCountAllowed(count: number): void {
  if (count > SERIAL_NUMBERS_MAX) throw new SerialNumbersTooManyError(count, SERIAL_NUMBERS_MAX);
}

// The article's serial numbers with these numbers, created when missing —
// what an inflow that NAMES its numbers calls (inleverans, a positive
// justering, the saldoimport). One row per number, case-insensitively unique
// per article over both sorts: a number that exists as a BATCH is refused
// (409 batch-kind-mismatch), the first spelling is kept, and `origin` says
// how the number was created. The list must be distinct — compared with
// Postgres' lower(), never JS's (they disagree on å/ä/ö under a C
// collation) — else 400 serial-count-mismatch naming the number. The rows
// are inserted in one statement, sorted, so two writers never wait on each
// other crosswise in the unique index. Returned in the list's order.
export async function getOrCreateSerials(
  tx: Db | Tx,
  input: {
    articleId: string;
    serialNumbers: readonly string[];
    origin: StockBatchOrigin;
    purchaseOrderId?: string | null;
    createdBy?: string | null;
    expiresOn?: string | null | undefined;
  }
): Promise<StockBatchRef[]> {
  const numbers = input.serialNumbers.map((raw) => normalizeBatchNumber(raw));
  if (numbers.length === 0) return [];
  assertSerialCountAllowed(numbers.length);
  // Postgres' own lower() for every number, in the list's order.
  const keyed = (await tx.execute(
    sql`select u.number, lower(u.number) as key from unnest(${sql.param(numbers)}::text[]) with ordinality as u(number, position) order by u.position`
  )) as unknown as { number: string; key: string }[];
  const keys = [...keyed].map((row) => row.key);
  const seen = new Set<string>();
  keys.forEach((key, index) => {
    if (seen.has(key)) throw new SerialCountMismatchError(numbers.length, numbers.length, numbers[index]!);
    seen.add(key);
  });

  const order = numbers.map((number, index) => ({ number, key: keys[index]! })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = 0; i < order.length; i += 500) {
    await tx
      .insert(stockBatches)
      .values(
        order.slice(i, i + 500).map(({ number }) => ({
          articleId: input.articleId,
          batchNumber: number,
          kind: "serial" as const,
          origin: input.origin,
          purchaseOrderId: input.purchaseOrderId ?? null,
          createdBy: input.createdBy ?? null,
          expiresOn: input.expiresOn ?? null,
        }))
      )
      .onConflictDoNothing();
  }
  const byKey = new Map<string, { id: string; batchNumber: string; kind: "batch" | "serial" }>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await tx
      .select({ id: stockBatches.id, batchNumber: stockBatches.batchNumber, kind: stockBatches.kind, key: sql<string>`lower(${stockBatches.batchNumber})` })
      .from(stockBatches)
      .where(and(eq(stockBatches.articleId, input.articleId), inArray(sql`lower(${stockBatches.batchNumber})`, keys.slice(i, i + 500))));
    for (const row of rows) byKey.set(row.key, row);
  }
  return keys.map((key) => {
    const row = byKey.get(key)!;
    if (row.kind !== "serial") throw new BatchKindMismatchError(row.batchNumber, row.kind);
    return { id: row.id, batchNumber: row.batchNumber };
  });
}

// The series a serienummerstyrd article's manufactured styck are numbered
// from: its own (articles.serial_series_key) or the common one.
export async function serialSeriesKeyOf(tx: Db | Tx, articleId: string): Promise<string> {
  const [row] = await tx.select({ key: articles.serialSeriesKey }).from(articles).where(eq(articles.id, articleId));
  return row?.key ?? DEFAULT_SERIAL_SERIES_KEY;
}

// The article's Serienummerserie must be a serial number series (400
// serial-series-invalid). null = the common one, always fine.
export async function assertSerialSeries(tx: Db | Tx, key: string | null | undefined): Promise<void> {
  if (key == null) return;
  const [row] = await tx.select({ forSerials: numberSeries.forSerials }).from(numberSeries).where(eq(numberSeries.key, key));
  if (!row?.forSerials) throw new SerialSeriesInvalidError(key);
}

// A TO report that may receive finished goods of a serienummerstyrd article
// (numbers created vid inleverans) takes the series' row FOR UPDATE right
// after the order row and BEFORE the components' article locks — on BOTH
// paths, the report on the last operation and Slutför order. The report path
// holds the components' article locks when it reaches the receipt, Slutför
// reaches it before them: without one fixed place for the series lock the
// two would wait crosswise (series ↔ article). The row is otherwise only
// taken by Nummerserier's PATCH (one lock, no order). Returns the series key
// when the article is numbered this way, else null (nothing is locked).
export async function lockSerialSeriesForReceipt(tx: Tx, articleId: string): Promise<string | null> {
  if ((await trackingOf(tx, articleId)) !== "serial") return null;
  const key = await serialSeriesKeyOf(tx, articleId);
  const [row] = await tx.select({ key: numberSeries.key }).from(numberSeries).where(eq(numberSeries.key, key)).for("update");
  if (!row) throw new NumberSeriesNotConfiguredError(key);
  return key;
}

const CLAIM_ROUNDS = 20;

// `count` NEW serial numbers for the article out of its series (beslut 3, 4
// and 9: a manufactured styck gets its number at the inleverans, also in the
// terminal). In the REPORT's transaction: a dry run and a failed report roll
// the numbers back, so they burn none; the numbers of a report that is later
// undone are spent (the rows stay, balance 0). One UPDATE takes the whole
// count; numbers that already exist on the article (typed, imported, a
// batch) are stepped over (ON CONFLICT DO NOTHING) and more are taken until
// `count` are created — at most CLAIM_ROUNDS rounds (409 series-exhausted).
// A number longer than the column is 409 serial-number-too-long. Returned in
// the order the series issued them.
export async function claimSerialNumbers(
  tx: Tx,
  input: {
    articleId: string;
    count: number;
    manufacturingOrderId?: string | null;
    createdBy?: string | null;
    expiresOn?: string | null | undefined;
  }
): Promise<StockBatchRef[]> {
  assertSerialCountAllowed(input.count);
  const key = await serialSeriesKeyOf(tx, input.articleId);
  const claimed: StockBatchRef[] = [];
  for (let round = 0; claimed.length < input.count; round++) {
    if (round >= CLAIM_ROUNDS) throw new SeriesExhaustedError(key);
    const need = input.count - claimed.length;
    const [series] = await tx
      .update(numberSeries)
      .set({ nextNumber: sql`${numberSeries.nextNumber} + ${need}` })
      .where(and(eq(numberSeries.key, key), eq(numberSeries.forSerials, true)))
      .returning();
    if (!series) throw new NumberSeriesNotConfiguredError(key);
    const first = series.nextNumber - need;
    const numbers = Array.from({ length: need }, (_, i) => formatSeriesNumber(series.prefix, first + i, series.digits));
    const tooLong = numbers.find((number) => Array.from(number).length > NUMBER_WIDTH);
    if (tooLong !== undefined) throw new SerialNumberTooLongError(key, tooLong, NUMBER_WIDTH);
    const created = await tx
      .insert(stockBatches)
      .values(
        numbers.map((batchNumber) => ({
          articleId: input.articleId,
          // A series whose prefix makes a number the reserved name cannot
          // exist ("Okänd" has no digits), so the numbers are stored as issued.
          batchNumber: batchNumber.trim(),
          kind: "serial" as const,
          origin: "manufacturing_order" as const,
          manufacturingOrderId: input.manufacturingOrderId ?? null,
          createdBy: input.createdBy ?? null,
          expiresOn: input.expiresOn ?? null,
        }))
      )
      .onConflictDoNothing()
      .returning({ id: stockBatches.id, batchNumber: stockBatches.batchNumber });
    const position = new Map(numbers.map((number, index) => [number.trim(), index]));
    claimed.push(...created.sort((a, b) => position.get(a.batchNumber)! - position.get(b.batchNumber)!));
  }
  return claimed;
}
