import { sql } from "drizzle-orm";
import { db, type Tx } from "@navet/db";

// The stock log is append-only in the database (migration 0208's trigger
// stock_transactions_append_only). A test that backdates or reprices rows to
// build a history does it here: the triggers are off for this one transaction
// only (session_replication_role = replica, as fast-truncate.ts does), so the
// guard stays on for everything the code under test writes.
export async function editStockLog<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return fn(tx);
  });
}
