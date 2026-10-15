import { eq, sql } from "drizzle-orm";
import { numberSeries, type Db, type Tx } from "@navet/db";
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

export async function getNextOrderNumber(db: Db | Tx, key: string): Promise<string> {
  const [row] = await db
    .update(numberSeries)
    .set({ nextNumber: sql`${numberSeries.nextNumber} + 1` })
    .where(eq(numberSeries.key, key))
    .returning();
  if (!row) throw new NumberSeriesNotConfiguredError(key);

  const issued = row.nextNumber - 1;
  const numberPart = row.digits > 0 ? String(issued).padStart(row.digits, "0") : String(issued);
  return `${row.prefix}${numberPart}`;
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
