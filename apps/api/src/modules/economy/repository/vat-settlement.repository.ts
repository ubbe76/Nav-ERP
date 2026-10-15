import { and, asc, eq, gte, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accountingPeriods,
  fiscalYears,
  vatSettlements,
  verificationSeries,
  verifications,
  type Db,
  type Tx,
} from "@navet/db";

// Momsrapport (B5) data access. Plain executor-based functions rather than a
// bound repository object: every caller is either the report GET (plain Db)
// or the settle transaction (Tx), the same Db|Tx seam as the module's other
// leaves — vat-report.service.ts owns the orchestration.

// Periods overlapping [from, to], ordered — the service validates that they
// exactly tile the range (starts on from, ends on to, no gaps).
export async function findPeriodsInRange(executor: Db | Tx, from: string, to: string) {
  return executor
    .select({
      id: accountingPeriods.id,
      startDate: accountingPeriods.startDate,
      endDate: accountingPeriods.endDate,
      status: accountingPeriods.status,
    })
    .from(accountingPeriods)
    .where(and(lte(accountingPeriods.startDate, to), gte(accountingPeriods.endDate, from)))
    .orderBy(asc(accountingPeriods.startDate));
}

export type OverlappingSettlement = {
  id: string;
  fromDate: string;
  toDate: string;
  verificationId: string;
  displayNumber: string;
  date: string;
  createdAt: Date;
  reversed: boolean;
  reversedBy: { id: string; displayNumber: string } | null;
};

// Settlements whose declared range overlaps [from, to], each with its M
// verification's display number and — when a BOOKED reversal exists — the
// reversal's identity. A settlement with a booked reversal is inactive: it
// no longer blocks the range and the report renders it as "Omförd". (A
// reversal still in draft keeps the settlement active — only booked rows
// change the ledger.)
export async function findSettlementsOverlapping(
  executor: Db | Tx,
  from: string,
  to: string
): Promise<OverlappingSettlement[]> {
  const reversal = alias(verifications, "reversal");
  const reversalSeries = alias(verificationSeries, "reversal_series");
  const reversalYear = alias(fiscalYears, "reversal_year");

  const rows = await executor
    .select({
      id: vatSettlements.id,
      fromDate: vatSettlements.fromDate,
      toDate: vatSettlements.toDate,
      verificationId: vatSettlements.verificationId,
      createdAt: vatSettlements.createdAt,
      date: verifications.date,
      seriesCode: verificationSeries.code,
      yearLabel: fiscalYears.label,
      verificationNumber: verifications.verificationNumber,
      reversalId: reversal.id,
      reversalSeriesCode: reversalSeries.code,
      reversalYearLabel: reversalYear.label,
      reversalNumber: reversal.verificationNumber,
    })
    .from(vatSettlements)
    .innerJoin(verifications, eq(verifications.id, vatSettlements.verificationId))
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .leftJoin(reversal, and(eq(reversal.reversesVerificationId, verifications.id), eq(reversal.status, "booked")))
    .leftJoin(reversalSeries, eq(reversalSeries.id, reversal.seriesId))
    .leftJoin(reversalYear, eq(reversalYear.id, reversal.fiscalYearId))
    .where(and(lte(vatSettlements.fromDate, to), gte(vatSettlements.toDate, from)))
    .orderBy(asc(vatSettlements.fromDate), asc(vatSettlements.createdAt));

  return rows.map((row) => ({
    id: row.id,
    fromDate: row.fromDate,
    toDate: row.toDate,
    verificationId: row.verificationId,
    displayNumber: `${row.seriesCode}-${row.yearLabel}-${row.verificationNumber}`,
    date: row.date,
    createdAt: row.createdAt,
    reversed: row.reversalId !== null,
    reversedBy:
      row.reversalId !== null
        ? { id: row.reversalId, displayNumber: `${row.reversalSeriesCode}-${row.reversalYearLabel}-${row.reversalNumber}` }
        : null,
  }));
}

// Tx-only on purpose: the settlement fact must commit or roll back with the
// M verification it points at.
export async function insertSettlement(
  tx: Tx,
  values: { fromDate: string; toDate: string; verificationId: string; createdBy: string }
) {
  const [row] = await tx.insert(vatSettlements).values(values).returning();
  return row!;
}
