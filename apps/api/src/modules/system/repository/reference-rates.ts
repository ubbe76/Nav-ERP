import { desc, eq, inArray, sql } from "drizzle-orm";
import { referenceRates, type Db, type Tx } from "@navet/db";
import type { ExchangeRateSource } from "@navet/shared";

// Referensränta — the DB leaf of system/service/exchange-rates.ts (the same
// Db | Tx seam as exchange-rates.ts). One row per calendar half-year
// (valid_from unique); a manual row wins over Riksbanken's for the same
// half-year, so the Riksbanken upsert never touches a manual row.

export type ReferenceRateRow = { id: string; validFrom: string; rate: number; source: ExchangeRateSource };

function toRow(row: { id: string; validFrom: string; rate: string; source: string }): ReferenceRateRow {
  return { id: row.id, validFrom: row.validFrom, rate: Number(row.rate), source: row.source as ExchangeRateSource };
}

// Every stored half-year, latest first.
export async function listReferenceRates(executor: Db | Tx): Promise<ReferenceRateRow[]> {
  const rows = await executor.select().from(referenceRates).orderBy(desc(referenceRates.validFrom));
  return rows.map(toRow);
}

// The rates for the given half-year starts, whatever their source.
export async function referenceRatesFor(executor: Db | Tx, validFroms: string[]): Promise<Map<string, ReferenceRateRow>> {
  const unique = [...new Set(validFroms)];
  if (unique.length === 0) return new Map();
  const rows = await executor.select().from(referenceRates).where(inArray(referenceRates.validFrom, unique));
  return new Map(rows.map((row) => [row.validFrom, toRow(row)] as const));
}

export async function findReferenceRateById(executor: Db | Tx, id: string): Promise<ReferenceRateRow | null> {
  const [row] = await executor.select().from(referenceRates).where(eq(referenceRates.id, id));
  return row ? toRow(row) : null;
}

// Riksbanken's rate for a half-year: inserted, or updated when the stored
// row is Riksbanken's own (a correction) — a manual row is left alone.
export async function upsertRiksbankReferenceRate(executor: Db | Tx, validFrom: string, rate: number): Promise<void> {
  await executor
    .insert(referenceRates)
    .values({ validFrom, rate: String(rate), source: "riksbank" })
    .onConflictDoUpdate({
      target: referenceRates.validFrom,
      set: { rate: String(rate) },
      setWhere: sql`${referenceRates.source} = 'riksbank'`,
    });
}

// Lägg till (manual): replaces whatever the half-year holds, Riksbanken's
// row included — the manual decision wins. `previous` tells the audit trail
// what it replaced.
export async function upsertManualReferenceRate(
  executor: Db | Tx,
  input: { validFrom: string; rate: number },
  userId: string | null
): Promise<{ row: ReferenceRateRow; previous: ReferenceRateRow | null }> {
  const [existing] = await executor.select().from(referenceRates).where(eq(referenceRates.validFrom, input.validFrom));
  const [row] = await executor
    .insert(referenceRates)
    .values({ validFrom: input.validFrom, rate: String(input.rate), source: "manual", createdBy: userId })
    .onConflictDoUpdate({
      target: referenceRates.validFrom,
      set: { rate: String(input.rate), source: "manual", createdBy: userId, createdAt: new Date() },
    })
    .returning();
  return { row: toRow(row!), previous: existing ? toRow(existing) : null };
}

export async function deleteReferenceRateRow(executor: Db | Tx, id: string): Promise<void> {
  await executor.delete(referenceRates).where(eq(referenceRates.id, id));
}
