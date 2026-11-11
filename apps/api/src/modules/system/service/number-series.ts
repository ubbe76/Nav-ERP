import { eq, getTableName, is, sql } from "drizzle-orm";
import { PgVarchar } from "drizzle-orm/pg-core";
import {
  customerPayments,
  deliveries,
  deviations,
  fixedAssets,
  inquiries,
  invoiceScans,
  invoices,
  manufacturingOrders,
  numberSeries,
  paymentBatches,
  purchaseOrders,
  salesOrders,
  shipments,
  stockCountSessions,
  supplierInvoices,
  supplierPayments,
  type Db,
  type Tx,
} from "@navet/db";
import { isUniqueViolation } from "./db-errors.js";

// Issues the next order number for a series (e.g. "purchase_order") and
// advances the counter — a single atomic UPDATE...RETURNING, so the implicit
// row lock makes this safe under concurrent order creation without a
// separate SELECT ... FOR UPDATE.
//
// Two calling conventions, depending on what a gap in the series means:
//
// - Document series (purchase/sales orders, inquiries, invoices, payments,
//   verifications): call inside the same transaction as the document insert
//   (pass `tx`). A gap is a bookkeeping problem there, so a failed insert
//   must not burn a number — rolling back that transaction rolls back this
//   UPDATE with it.
// - Register series (supplier/customer numbers): go through
//   insertWithSeriesNumber below instead of calling this directly. Those
//   series have no bookkeeping-continuity requirement, and a manually chosen
//   number is never reserved in them — the counter can walk straight into
//   one — so a collision needs to retry with the *next* number rather than
//   fail outright. That only works if the allocation survives the failed
//   insert's rollback, which is exactly what calling it outside any
//   transaction (on `db`, not `tx`) buys: this UPDATE commits as its own
//   statement regardless of what the insert that follows does.
export class NumberSeriesNotConfiguredError extends Error {
  constructor(key: string) {
    super(`Number series "${key}" not configured`);
    this.name = "NumberSeriesNotConfiguredError";
  }
}

// Retries exhausted — the series kept colliding with taken numbers. A
// conflict-storm outcome (retryable), mapped to 409 with a named code so the
// web can say which series is stuck instead of showing a raw unique-violation.
export class SeriesExhaustedError extends Error {
  constructor(readonly seriesKey: string) {
    super(`Number series "${seriesKey}" exhausted its collision retries`);
    this.name = "SeriesExhaustedError";
  }
}

// Artikelnummer — the default article number series (migration 0127). The
// user's own article series get generated keys; article-number.ts issues
// their numbers (skipping taken ones), not getNextOrderNumber.
export const DEFAULT_ARTICLE_SERIES_KEY = "article";

export async function getNextOrderNumber(db: Db | Tx, key: string): Promise<string> {
  const [row] = await db
    .update(numberSeries)
    .set({ nextNumber: sql`${numberSeries.nextNumber} + 1` })
    .where(eq(numberSeries.key, key))
    .returning();
  if (!row) throw new NumberSeriesNotConfiguredError(key);

  return formatSeriesNumber(row.prefix, row.nextNumber - 1, row.digits);
}

// How a series prints a number: the prefix and the number zero-padded to
// `digits` (0 = no padding). The one formatting rule — getNextOrderNumber
// and Nummerserier's guard below both go through it.
export function formatSeriesNumber(prefix: string, number: number, digits: number): string {
  return `${prefix}${digits > 0 ? String(number).padStart(digits, "0") : String(number)}`;
}

// The document column each document series numbers. The register series
// (customer, supplier) and the article series are not here: they step over
// taken numbers themselves (insertWithSeriesNumber, article-number.ts) and
// their columns are varchar(50). sales_order and quote share one column;
// credit notes take their numbers from "invoice". A new document series
// belongs here — systemgranskning.test.ts compares the map with
// number_series and information_schema.
const DOCUMENT_NUMBER_COLUMNS = {
  purchase_order: purchaseOrders.orderNumber,
  sales_order: salesOrders.orderNumber,
  quote: salesOrders.orderNumber,
  manufacturing_order: manufacturingOrders.orderNumber,
  inquiry: inquiries.inquiryNumber,
  invoice: invoices.invoiceNumber,
  supplier_invoice: supplierInvoices.registrationNumber,
  customer_payment: customerPayments.paymentNumber,
  supplier_payment: supplierPayments.paymentNumber,
  stock_count: stockCountSessions.countNumber,
  fixed_asset: fixedAssets.assetNumber,
  payment_batch: paymentBatches.batchNumber,
  invoice_scan: invoiceScans.scanNumber,
  deviation: deviations.deviationNumber,
  delivery: deliveries.deliveryNumber,
  shipment: shipments.shipmentNumber,
};
type DocumentNumberColumn = (typeof DOCUMENT_NUMBER_COLUMNS)[keyof typeof DOCUMENT_NUMBER_COLUMNS];

export interface DocumentSeriesTarget {
  table: string;
  column: string;
  // The column's varchar width — the longest number the series may print.
  width: number;
  // The unique constraint drizzle names <table>_<column>_unique.
  constraint: string;
}

function documentNumberColumn(key: string): DocumentNumberColumn | null {
  return Object.hasOwn(DOCUMENT_NUMBER_COLUMNS, key)
    ? DOCUMENT_NUMBER_COLUMNS[key as keyof typeof DOCUMENT_NUMBER_COLUMNS]
    : null;
}

function targetOf(column: DocumentNumberColumn): DocumentSeriesTarget {
  const table = getTableName(column.table);
  const width = is(column, PgVarchar) ? column.length : undefined;
  return { table, column: column.name, width: width ?? Number.POSITIVE_INFINITY, constraint: `${table}_${column.name}_unique` };
}

// Where a document series' numbers go — null for the register and article
// series (and an unknown key).
export function documentSeriesTarget(key: string): DocumentSeriesTarget | null {
  const column = documentNumberColumn(key);
  return column ? targetOf(column) : null;
}

export function documentSeriesKeys(): string[] {
  return Object.keys(DOCUMENT_NUMBER_COLUMNS);
}

// Whether a document already carries `number` in the series' column.
export async function documentNumberTaken(executor: Db | Tx, key: string, number: string): Promise<boolean> {
  const column = documentNumberColumn(key);
  if (!column) return false;
  const rows = await executor.execute(sql`select 1 from ${column.table} where ${column} = ${number} limit 1`);
  return rows.length > 0;
}

// A document create whose series number was already taken (a counter moved
// back past existing documents some other way than Nummerserier, which
// refuses it — an import, a restore, a hand edit). Mapped once by the global
// error handler (app.ts) from the column's unique violation: 409, never the
// raw 500, and the transaction has rolled the number back.
export class DocumentNumberTakenError extends Error {
  constructor(readonly table: string) {
    super(`The next number in the series is already taken in ${table} — set Nästa nummer past it under System → Nummerserier`);
    this.name = "DocumentNumberTakenError";
  }
}

// The unique violation of a document series' number column, as the domain
// error — null for every other error.
export function documentNumberTakenError(err: unknown): DocumentNumberTakenError | null {
  for (const column of new Set(Object.values(DOCUMENT_NUMBER_COLUMNS))) {
    const target = targetOf(column);
    if (isUniqueViolation(err, target.constraint)) return new DocumentNumberTakenError(target.table);
  }
  return null;
}

// How many taken numbers insertWithSeriesNumber will step over before giving
// up — bounded so a genuinely broken series can't spin forever.
const SERIES_COLLISION_RETRIES = 5;

// Self-healing insert for register series (supplier/customer numbers so
// far): allocates the next number on `db` (see getNextOrderNumber's doc
// comment above for why not `tx`) and runs `insert` with it. If `insert`
// fails on a unique violation, the allocation has already committed
// independently of that failure, so the counter has genuinely moved past
// the collision — the next attempt issues a fresh number instead of the
// same taken one. Bounded by SERIES_COLLISION_RETRIES so a genuinely broken
// series can't spin forever; any non-unique-violation error rethrows
// immediately without retrying.
//
// Only safe for callers whose `insert` has no unique constraint other than
// the series number itself, with every other reference pre-validated before
// this runs — under those conditions a unique violation here can only be
// the number colliding, so retrying (and thereby burning the number) is
// exactly the desired self-heal rather than an unwanted side effect.
//
// Callers own the manual-number case: when the caller supplied their own
// number, skip this helper entirely and insert directly — that duplicate is
// the caller's error and must surface as a 409, never retried.
export async function insertWithSeriesNumber<T>(
  db: Db,
  key: string,
  insert: (issued: string) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const issued = await getNextOrderNumber(db, key);
    try {
      return await insert(issued);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (attempt >= SERIES_COLLISION_RETRIES) throw new SeriesExhaustedError(key);
    }
  }
}
