import { and, eq, sql } from "drizzle-orm";
import { payrollPeriods, type Tx } from "@navet/db";
import { PayrollPeriodLockedError } from "../service/period-lock.js";

// Löneperiodlåset inside the writer's own transaction. Leaf on purpose
// (schema + the error leaf only): the payroll, timereport, ATF and schedule
// repositories all call it, so it must import none of them.
//
// Why an advisory lock and not FOR SHARE on the period row: the row is
// created lazily (first attestation or lock of the month) and usually does
// not exist while the month is being reported into — FOR SHARE on a missing
// row locks nothing. One advisory key per calendar month instead:
//
//   - every writer the löneunderlag reads (närvarorättning, frånvaro,
//     övertidsval, ATF, schemaöverstyrningar, helgdagar, attest) takes the
//     month SHARED and then reads the status — in its own transaction, so
//     the status it read still holds when it commits;
//   - Lås takes the month EXCLUSIVE, reads the status again, computes the
//     basis and writes (payroll.repository.ts lockPayrollPeriodGuarded).
//     Writers already holding the month have committed by then and are in
//     the basis; writers arriving later wait and are refused.
//
// Lock order: the period lock is taken FIRST in the transaction, before any
// row lock (attendance row, stamps, employee row), months in ascending
// order. Lås holds exactly one month and waits for nothing else, so no
// cycle can form with a writer.
const monthKey = (year: number, month: number) => year * 100 + month;

function distinctMonths(dates: Iterable<string>): { year: number; month: number; date: string }[] {
  const byMonth = new Map<number, { year: number; month: number; date: string }>();
  for (const date of dates) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const key = monthKey(year, month);
    if (!byMonth.has(key)) byMonth.set(key, { year, month, date });
  }
  return [...byMonth.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

async function isLocked(tx: Tx, year: number, month: number): Promise<boolean> {
  const [row] = await tx
    .select({ status: payrollPeriods.status })
    .from(payrollPeriods)
    .where(and(eq(payrollPeriods.year, year), eq(payrollPeriods.month, month)));
  return row?.status === "locked";
}

// Takes the months of `dates` shared (held to the end of the transaction)
// and returns the first given date of each LOCKED month — for the writer
// that skips locked months instead of failing (the holiday seed).
export async function sharePayrollPeriodsInTx(tx: Tx, dates: Iterable<string>): Promise<string[]> {
  const lockedDates: string[] = [];
  for (const { year, month, date } of distinctMonths(dates)) {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('payroll_period'), ${monthKey(year, month)}::int)`);
    if (await isLocked(tx, year, month)) lockedDates.push(date);
  }
  return lockedDates;
}

// The guard itself: the months of `dates` are open and stay open until the
// transaction ends. A locked one ⇒ PayrollPeriodLockedError (409).
export async function assertPayrollPeriodsOpenInTx(tx: Tx, dates: Iterable<string>): Promise<void> {
  const [locked] = await sharePayrollPeriodsInTx(tx, dates);
  if (locked !== undefined) throw new PayrollPeriodLockedError(locked);
}

// Lås: the month exclusively. Waits for every writer holding it shared.
export async function lockPayrollPeriodExclusivelyInTx(tx: Tx, year: number, month: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('payroll_period'), ${monthKey(year, month)}::int)`);
}

// The first day of a period — the date the guard and the error speak of.
export const payrollPeriodFirstDay = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}-01`;
