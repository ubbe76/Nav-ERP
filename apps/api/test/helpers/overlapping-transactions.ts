import { sql } from "drizzle-orm";
import { db, type Tx } from "@navet/db";

// Two transactions that overlap in a fixed order, for the price histories'
// ordering (migration 0190): `first` BEGINs — its now(), the transaction's
// start, is fixed by its first statement — then `second` runs whole and
// commits, and only then does `first` make its change and commit. With
// valid_from = now() the first transaction's later change was recorded as
// the earlier one.
export async function overlappingTransactions(first: (tx: Tx) => Promise<void>, second: () => Promise<void>) {
  let begun!: () => void;
  const firstBegun = new Promise<void>((resolve) => (begun = resolve));
  let release!: () => void;
  const firstMayGoOn = new Promise<void>((resolve) => (release = resolve));
  const firstDone = db.transaction(async (tx) => {
    await tx.execute(sql`select now()`);
    begun();
    await firstMayGoOn;
    await first(tx);
  });
  try {
    await firstBegun;
    // A few milliseconds, so the second transaction's now() is surely later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await second();
  } finally {
    release();
  }
  await firstDone;
}
