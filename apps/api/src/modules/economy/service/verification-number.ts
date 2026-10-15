import { and, eq, sql } from "drizzle-orm";
import { verificationCounters, type Tx } from "@navet/db";

// Allocates the next verifikatnummer for (series, fiscal year) and advances
// the counter — atomic UPDATE…RETURNING on the counter row (implicit row
// lock). Tx-ONLY by signature: the caller MUST run this inside the same
// transaction as the booking so a failed booking rolls the number back
// (BFL: unbroken series). The counter row materializes lazily on first use
// (onConflictDoNothing + retry keeps a concurrent creator's count).
export async function allocateVerificationNumber(tx: Tx, seriesId: string, fiscalYearId: string): Promise<number> {
  const bump = () =>
    tx
      .update(verificationCounters)
      .set({ nextNumber: sql`${verificationCounters.nextNumber} + 1` })
      .where(and(eq(verificationCounters.seriesId, seriesId), eq(verificationCounters.fiscalYearId, fiscalYearId)))
      .returning();

  let [row] = await bump();
  if (!row) {
    await tx
      .insert(verificationCounters)
      .values({ seriesId, fiscalYearId })
      .onConflictDoNothing({ target: [verificationCounters.seriesId, verificationCounters.fiscalYearId] });
    [row] = await bump();
  }
  if (!row) throw new Error("verification counter could not be materialized");
  return row.nextNumber - 1;
}
