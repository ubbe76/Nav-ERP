import { and, eq } from "drizzle-orm";
import { stockCountSessions, stockLocations, type Db, type Tx } from "@navet/db";
import { LocationUnderStockCountError } from "./stock.errors.js";

// Frysvakten (D2): when an open stock-count session with blocks_transactions
// covers a location, every stock_transactions writer must refuse the WHOLE
// location — not just the counted articles, since an uncounted article
// landing mid-count would be double-booked after posting. Same Db | Tx leaf
// shape as resolveStockLocation/deactivateEmptyLocation, called explicitly
// by every writer right after the location is resolved. The stock-count
// posting itself writes directly in its own repository function and
// deliberately does NOT call this.
export async function assertLocationNotUnderCount(db: Db | Tx, locationId: string): Promise<void> {
  const [session] = await db
    .select({
      countNumber: stockCountSessions.countNumber,
      locationName: stockLocations.name,
    })
    .from(stockCountSessions)
    .innerJoin(stockLocations, eq(stockLocations.id, stockCountSessions.locationId))
    .where(
      and(
        eq(stockCountSessions.locationId, locationId),
        eq(stockCountSessions.status, "open"),
        eq(stockCountSessions.blocksTransactions, true)
      )
    )
    .limit(1);
  if (session) throw new LocationUnderStockCountError(session.locationName, session.countNumber);
}
