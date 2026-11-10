import { and, eq, gte, lte } from "drizzle-orm";
import { accountingPeriods, fiscalYears, type Db, type Tx } from "@navet/db";

// The period and year covering `date`, read FOR SHARE — the year row first,
// then the period row. Shared by the poster's assertPostablePeriod and the
// manual Bokför's in-tx re-check (economy.repository.ts bookVerificationInTx)
// so every booking locks in the same order.
//
// Inside a transaction a Lås period (or Stäng år) landing mid-booking either
// committed before these reads and is seen, or waits until the booking
// commits; a plain read let the lock commit in between and the verification
// land in the locked period. The order is the one closeYear writes in (year
// row, then every period), and Lås/Lås upp take only the period row (the
// unlock trigger then reads the year FOR SHARE, which a booking's share lock
// never blocks), so bookings and locks never deadlock. Outside a transaction
// the locks end with the statement. Leaf file: no economy imports.
export async function lockPostingPeriod(
  executor: Db | Tx,
  date: string
): Promise<{ status: string; yearStatus: string; yearLabel: string } | null> {
  const [year] = await executor
    .select({ id: fiscalYears.id, status: fiscalYears.status, label: fiscalYears.label })
    .from(fiscalYears)
    .where(and(lte(fiscalYears.startDate, date), gte(fiscalYears.endDate, date)))
    .for("share");
  if (!year) return null;
  const [period] = await executor
    .select({ status: accountingPeriods.status })
    .from(accountingPeriods)
    .where(
      and(eq(accountingPeriods.fiscalYearId, year.id), lte(accountingPeriods.startDate, date), gte(accountingPeriods.endDate, date))
    )
    .for("share");
  return period ? { status: period.status, yearStatus: year.status, yearLabel: year.label } : null;
}
