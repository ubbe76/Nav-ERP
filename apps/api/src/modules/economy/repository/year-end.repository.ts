import { and, asc, count, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accountingPeriods,
  accounts,
  fiscalYears,
  fixedAssetDepreciationRuns,
  profitDispositions,
  verificationRows,
  verifications,
  verificationSeries,
  yearEndAccruals,
  yearEndClosings,
  yearEndClosingVerifications,
  type Db,
  type Tx,
} from "@navet/db";
import type { ValuationMethod } from "@navet/shared";
import { OPENING_BALANCE_SERIES } from "../service/verification-poster.js";
import { addDays } from "../service/year-end-calc.js";

// Årsbokslut — executor-based (Db | Tx) functions, same seam as
// vat-settlement.repository.ts: the service passes its own transaction.
type Executor = Db | Tx;

export type ClosingRow = typeof yearEndClosings.$inferSelect;
export type FiscalYearRow = typeof fiscalYears.$inferSelect;
export type PeriodRow = typeof accountingPeriods.$inferSelect;
export type VerificationRef = { id: string; displayNumber: string; date: string };
export type YearEndStep = (typeof yearEndClosingVerifications.$inferSelect)["step"];
export type YearEndRole = (typeof yearEndClosingVerifications.$inferSelect)["role"];

export async function findFiscalYear(executor: Executor, id: string): Promise<FiscalYearRow | null> {
  const [row] = await executor.select().from(fiscalYears).where(eq(fiscalYears.id, id));
  return row ?? null;
}

export async function findFiscalYearCovering(executor: Executor, date: string): Promise<FiscalYearRow | null> {
  const [row] = await executor
    .select()
    .from(fiscalYears)
    .where(and(lte(fiscalYears.startDate, date), gte(fiscalYears.endDate, date)));
  return row ?? null;
}

// The year covering the day after `endDate` — the one the accrual reversal
// lands in and the IB check compares against.
export async function findNextFiscalYear(executor: Executor, endDate: string): Promise<FiscalYearRow | null> {
  return findFiscalYearCovering(executor, addDays(endDate, 1));
}

export async function findPreviousFiscalYear(executor: Executor, startDate: string): Promise<FiscalYearRow | null> {
  const [row] = await executor
    .select()
    .from(fiscalYears)
    .where(lt(fiscalYears.endDate, startDate))
    .orderBy(desc(fiscalYears.endDate))
    .limit(1);
  return row ?? null;
}

export async function listPeriods(executor: Executor, fiscalYearId: string): Promise<PeriodRow[]> {
  return executor
    .select()
    .from(accountingPeriods)
    .where(eq(accountingPeriods.fiscalYearId, fiscalYearId))
    .orderBy(asc(accountingPeriods.startDate));
}

export async function findPeriodForDate(executor: Executor, date: string): Promise<PeriodRow | null> {
  const [row] = await executor
    .select()
    .from(accountingPeriods)
    .where(and(lte(accountingPeriods.startDate, date), gte(accountingPeriods.endDate, date)));
  return row ?? null;
}

// Drafts block steps 2–5 (spec 4.2): a draft could still be booked into
// the year after the closing entries were computed.
export async function countDrafts(executor: Executor, fiscalYearId: string): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(verifications)
    .where(and(eq(verifications.fiscalYearId, fiscalYearId), eq(verifications.status, "draft")));
  return Number(row?.n ?? 0);
}

// The drafts behind the blocker, oldest first, capped for the guide's links.
export async function listDrafts(
  executor: Executor,
  fiscalYearId: string,
  limit: number
): Promise<{ id: string; date: string; description: string }[]> {
  return executor
    .select({ id: verifications.id, date: verifications.date, description: verifications.description })
    .from(verifications)
    .where(and(eq(verifications.fiscalYearId, fiscalYearId), eq(verifications.status, "draft")))
    .orderBy(asc(verifications.date), asc(verifications.createdAt))
    .limit(limit);
}

export async function insertClosing(tx: Tx, values: { fiscalYearId: string; closingDate: string; createdBy: string }): Promise<ClosingRow> {
  const [row] = await tx.insert(yearEndClosings).values(values).returning();
  return row!;
}

export async function findClosing(executor: Executor, id: string): Promise<ClosingRow | null> {
  const [row] = await executor.select().from(yearEndClosings).where(eq(yearEndClosings.id, id));
  return row ?? null;
}

// THE lock of every writing step, close, reopen and disposition: one closing
// row, FOR UPDATE — a second caller waits, then re-reads what the first wrote.
export async function lockClosing(tx: Tx, id: string): Promise<ClosingRow | null> {
  const [row] = await tx.select().from(yearEndClosings).where(eq(yearEndClosings.id, id)).for("update");
  return row ?? null;
}

export async function updateClosing(tx: Tx, id: string, patch: Partial<typeof yearEndClosings.$inferInsert>): Promise<void> {
  await tx
    .update(yearEndClosings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(yearEndClosings.id, id));
}

export async function listClosings(executor: Executor, query: { fiscalYearId?: string; limit: number; offset: number }) {
  const where = query.fiscalYearId ? eq(yearEndClosings.fiscalYearId, query.fiscalYearId) : undefined;
  const rows = await executor
    .select({
      id: yearEndClosings.id,
      fiscalYearId: yearEndClosings.fiscalYearId,
      fiscalYearLabel: fiscalYears.label,
      closingDate: yearEndClosings.closingDate,
      status: yearEndClosings.status,
      createdAt: yearEndClosings.createdAt,
    })
    .from(yearEndClosings)
    .innerJoin(fiscalYears, eq(fiscalYears.id, yearEndClosings.fiscalYearId))
    .where(where)
    .orderBy(desc(fiscalYears.startDate))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await executor.select({ n: count() }).from(yearEndClosings).where(where);
  return { rows, total: Number(total?.n ?? 0) };
}

export async function insertOwnership(
  tx: Tx,
  row: { verificationId: string; closingId: string; step: YearEndStep; role: YearEndRole }
): Promise<void> {
  await tx.insert(yearEndClosingVerifications).values(row);
}

export async function verificationRef(executor: Executor, id: string): Promise<VerificationRef | null> {
  const [row] = await executor
    .select({
      id: verifications.id,
      seriesCode: verificationSeries.code,
      yearLabel: fiscalYears.label,
      number: verifications.verificationNumber,
      date: verifications.date,
    })
    .from(verifications)
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .where(eq(verifications.id, id));
  if (!row) return null;
  return { id: row.id, displayNumber: `${row.seriesCode}-${row.yearLabel}-${row.number}`, date: row.date };
}

export async function listHistory(executor: Executor, closingId: string) {
  const rows = await executor
    .select({
      id: verifications.id,
      seriesCode: verificationSeries.code,
      yearLabel: fiscalYears.label,
      number: verifications.verificationNumber,
      date: verifications.date,
      step: yearEndClosingVerifications.step,
      role: yearEndClosingVerifications.role,
    })
    .from(yearEndClosingVerifications)
    .innerJoin(verifications, eq(verifications.id, yearEndClosingVerifications.verificationId))
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .where(eq(yearEndClosingVerifications.closingId, closingId))
    .orderBy(asc(fiscalYears.startDate), asc(verifications.verificationNumber));
  return rows.map((row) => ({
    verification: { id: row.id, displayNumber: `${row.seriesCode}-${row.yearLabel}-${row.number}`, date: row.date },
    step: row.step,
    role: row.role,
  }));
}

export type AccountRow = typeof accounts.$inferSelect;

export async function findAccountByNumber(executor: Executor, number: string): Promise<AccountRow | null> {
  const [row] = await executor.select().from(accounts).where(eq(accounts.number, number));
  return row ?? null;
}

export async function findAccountById(executor: Executor, id: string): Promise<AccountRow | null> {
  const [row] = await executor.select().from(accounts).where(eq(accounts.id, id));
  return row ?? null;
}

// Debit − credit over every BOOKED row on the account dated ≤ `through`.
export async function accountBalance(executor: Executor, accountId: string, through: string): Promise<number> {
  const [row] = await executor
    .select({ net: sql<string>`COALESCE(SUM(${verificationRows.debit} - ${verificationRows.credit}), 0)` })
    .from(verificationRows)
    .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
    .where(and(eq(verificationRows.accountId, accountId), eq(verifications.status, "booked"), lte(verifications.date, through)));
  return Math.round(Number(row?.net ?? 0) * 100) / 100;
}

// Debit − credit of ONE verification on one account (the live step's share).
export async function verificationAmountOnAccount(executor: Executor, verificationId: string, accountId: string): Promise<number> {
  const [row] = await executor
    .select({ net: sql<string>`COALESCE(SUM(${verificationRows.debit} - ${verificationRows.credit}), 0)` })
    .from(verificationRows)
    .where(and(eq(verificationRows.verificationId, verificationId), eq(verificationRows.accountId, accountId)));
  return Math.round(Number(row?.net ?? 0) * 100) / 100;
}

// Debit − credit per account of ONE verification (the live valutaomvärdering
// a re-run is compared against), netted per account.
export async function verificationAmounts(executor: Executor, verificationId: string): Promise<{ accountId: string; amount: number }[]> {
  const rows = await executor
    .select({
      accountId: verificationRows.accountId,
      net: sql<string>`SUM(${verificationRows.debit} - ${verificationRows.credit})`,
    })
    .from(verificationRows)
    .where(eq(verificationRows.verificationId, verificationId))
    .groupBy(verificationRows.accountId);
  return rows.map((row) => ({ accountId: row.accountId, amount: Math.round(Number(row.net) * 100) / 100 }));
}

// The inventory method of the latest CLOSED closing before this year — the
// guide's default (konsekvensprincipen).
export async function latestClosedInventoryMethod(executor: Executor, beforeStartDate: string): Promise<ValuationMethod | null> {
  const [row] = await executor
    .select({ method: yearEndClosings.inventoryMethod })
    .from(yearEndClosings)
    .innerJoin(fiscalYears, eq(fiscalYears.id, yearEndClosings.fiscalYearId))
    .where(and(eq(yearEndClosings.status, "closed"), lt(fiscalYears.endDate, beforeStartDate), isNotNull(yearEndClosings.inventoryMethod)))
    .orderBy(desc(fiscalYears.endDate))
    .limit(1);
  return (row?.method as ValuationMethod | undefined) ?? null;
}

export type AccrualKind = (typeof yearEndAccruals.$inferSelect)["kind"];

// Steg 4's specification rows, written with the year's verification they
// produced. Append-only: a re-run writes a new set under the new verification.
export async function insertAccruals(
  tx: Tx,
  closingId: string,
  verificationId: string,
  rows: { kind: AccrualKind; balanceAccountId: string; resultAccountId: string; amount: number; description: string }[]
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(yearEndAccruals).values(
    rows.map((row, index) => ({
      closingId,
      verificationId,
      kind: row.kind,
      balanceAccountId: row.balanceAccountId,
      resultAccountId: row.resultAccountId,
      amount: String(row.amount),
      description: row.description,
      sortOrder: index,
    }))
  );
}

export async function listAccruals(executor: Executor, verificationId: string) {
  const balanceAccount = alias(accounts, "balance_account");
  const resultAccount = alias(accounts, "result_account");
  const rows = await executor
    .select({
      id: yearEndAccruals.id,
      kind: yearEndAccruals.kind,
      balanceAccountId: yearEndAccruals.balanceAccountId,
      balanceAccountNumber: balanceAccount.number,
      resultAccountId: yearEndAccruals.resultAccountId,
      resultAccountNumber: resultAccount.number,
      amount: yearEndAccruals.amount,
      description: yearEndAccruals.description,
    })
    .from(yearEndAccruals)
    .innerJoin(balanceAccount, eq(balanceAccount.id, yearEndAccruals.balanceAccountId))
    .innerJoin(resultAccount, eq(resultAccount.id, yearEndAccruals.resultAccountId))
    .where(eq(yearEndAccruals.verificationId, verificationId))
    .orderBy(asc(yearEndAccruals.sortOrder));
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

// Conditional: only an OPEN year flips — false means it was already closed.
// Taking this row lock waits out any booking in flight: the closed-year
// trigger reads the year row FOR SHARE.
export async function markFiscalYearClosed(tx: Tx, fiscalYearId: string, userId: string): Promise<boolean> {
  const rows = await tx
    .update(fiscalYears)
    .set({ status: "closed", closedAt: new Date(), closedBy: userId })
    .where(and(eq(fiscalYears.id, fiscalYearId), eq(fiscalYears.status, "open")))
    .returning({ id: fiscalYears.id });
  return rows.length > 0;
}

// The year row FOR UPDATE. Reopening N takes N+1's row so it serialises
// with N+1's close (which UPDATEs that row first): whichever comes second
// waits, then reads what the first committed.
export async function lockFiscalYear(tx: Tx, id: string): Promise<FiscalYearRow | null> {
  const [row] = await tx.select().from(fiscalYears).where(eq(fiscalYears.id, id)).for("update");
  return row ?? null;
}

export async function markFiscalYearOpen(tx: Tx, fiscalYearId: string): Promise<void> {
  await tx.update(fiscalYears).set({ status: "open", closedAt: null, closedBy: null }).where(eq(fiscalYears.id, fiscalYearId));
}

// Locks the year's OPEN periods; already locked ones keep their stamp.
export async function lockAllPeriods(tx: Tx, fiscalYearId: string, userId: string): Promise<number> {
  const rows = await tx
    .update(accountingPeriods)
    .set({ status: "locked", lockedAt: new Date(), lockedBy: userId })
    .where(and(eq(accountingPeriods.fiscalYearId, fiscalYearId), eq(accountingPeriods.status, "open")))
    .returning({ id: accountingPeriods.id });
  return rows.length;
}

export async function unlockPeriodById(tx: Tx, periodId: string): Promise<void> {
  await tx
    .update(accountingPeriods)
    .set({ status: "open", lockedAt: null, lockedBy: null })
    .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.status, "locked")));
}

// Every booked row of an opening-balance (series I) verification in the
// year, with its reversal links — the IB check nets them per account.
// `reversed` looks at every year: an omföring dated outside the year still
// means the import is no longer something to omföra.
export async function openingBalanceRows(executor: Executor, fiscalYearId: string) {
  return executor
    .select({
      verificationId: verifications.id,
      reversesVerificationId: verifications.reversesVerificationId,
      reversed: sql<boolean>`EXISTS (SELECT 1 FROM verifications r WHERE r.reverses_verification_id = ${verifications.id} AND r.status = 'booked')`,
      seriesCode: verificationSeries.code,
      number: verifications.verificationNumber,
      yearLabel: fiscalYears.label,
      accountId: verificationRows.accountId,
      accountNumber: accounts.number,
      accountName: accounts.name,
      debit: verificationRows.debit,
      credit: verificationRows.credit,
    })
    .from(verificationRows)
    .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(
      and(
        eq(verifications.fiscalYearId, fiscalYearId),
        eq(verifications.status, "booked"),
        eq(verificationSeries.code, OPENING_BALANCE_SERIES.code)
      )
    );
}

// Steg 3's footprint: a register run (not a disposal catch-up) whose AV
// verification is dated on the closing date — undone or not, its rows stay
// on that date, so the closing date can no longer move.
export async function hasDepreciationRunOn(executor: Executor, date: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: fixedAssetDepreciationRuns.id })
    .from(fixedAssetDepreciationRuns)
    .innerJoin(verifications, eq(verifications.id, fixedAssetDepreciationRuns.verificationId))
    .where(and(isNull(fixedAssetDepreciationRuns.disposalAssetId), eq(verifications.date, date)))
    .limit(1);
  return row !== undefined;
}

export type DispositionRow = typeof profitDispositions.$inferSelect;

export async function findActiveDisposition(executor: Executor, closingId: string): Promise<DispositionRow | null> {
  const [row] = await executor
    .select()
    .from(profitDispositions)
    .where(and(eq(profitDispositions.closingId, closingId), isNull(profitDispositions.reversalVerificationId)));
  return row ?? null;
}

export async function insertDisposition(
  tx: Tx,
  values: { closingId: string; agmDate: string; resultAmount: number; dividendAmount: number; verificationId: string; createdBy: string }
): Promise<DispositionRow> {
  const [row] = await tx
    .insert(profitDispositions)
    .values({ ...values, resultAmount: String(values.resultAmount), dividendAmount: String(values.dividendAmount) })
    .returning();
  return row!;
}

export async function markDispositionReversed(tx: Tx, id: string, reversalVerificationId: string): Promise<void> {
  await tx.update(profitDispositions).set({ reversalVerificationId }).where(eq(profitDispositions.id, id));
}
