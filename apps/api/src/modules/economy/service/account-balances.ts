// Per-account opening/period sums — the single aggregation the financial
// reports stand on. Same shape and Db|Tx seam as vat-account-movements.ts.
//
// CRITICAL DIFFERENCE from readVatAccountMovements: this reader has NO
// notExists exclusions against vat_settlements. The VAT report excludes
// momsomföringar so the boxes show the period's real trade; a balance sheet
// or income statement must do the opposite — a settlement is a real booked
// posting on 2610/2640/2650, and leaving it out would make the balance sheet
// fail to balance. Do not "harmonise" the two readers.
//
// Zero-balance accounts are deliberately NOT filtered out here; the report
// builders decide what to hide. That keeps this reader usable as-is for
// B6b's SIE #IB (opening), #UB (opening+period) and #RES (period).
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { accounts, verificationRows, verifications, type Db, type Tx } from "@navet/db";

export interface AccountBalance {
  accountId: string;
  accountNumber: string;
  accountName: string;
  // Rows strictly before `from` (both 0 when `from` is null).
  openingDebit: number;
  openingCredit: number;
  // Rows within [from, to], inclusive at both ends.
  periodDebit: number;
  periodCredit: number;
}

// Kostnadsställen och projekt: an optional object filter (only the rows
// carrying the cost center and/or the project) and, for the grouped reader,
// which dimension to split the sums on.
export interface DimensionFilter {
  costCenterId?: string;
  projectId?: string;
}

export type BalanceGroupBy = "costCenter" | "project";

// A per-(account, object) balance: objectId null = the rows without one
// ("Utan" in the report).
export interface GroupedAccountBalance extends AccountBalance {
  objectId: string | null;
}

function dimensionConditions(filter: DimensionFilter | undefined) {
  const conditions = [];
  if (filter?.costCenterId) conditions.push(eq(verificationRows.costCenterId, filter.costCenterId));
  if (filter?.projectId) conditions.push(eq(verificationRows.projectId, filter.projectId));
  return conditions;
}

export async function readAccountBalances(
  executor: Db | Tx,
  range: { from: string | null; to: string },
  filter?: DimensionFilter
): Promise<AccountBalance[]> {
  const { from, to } = range;

  // One sweep, one GROUP BY: FILTER splits the opening window from the
  // period window. When `from` is absent there is no "before" window at all,
  // so the opening columns are constant 0 and the period sums run
  // unfiltered — the same reasoning as getLedger's skipped opening query.
  const openingDebit = from
    ? sql<string>`COALESCE(SUM(${verificationRows.debit}) FILTER (WHERE ${verifications.date} < ${from}), 0)`
    : sql<string>`0`;
  const openingCredit = from
    ? sql<string>`COALESCE(SUM(${verificationRows.credit}) FILTER (WHERE ${verifications.date} < ${from}), 0)`
    : sql<string>`0`;
  const periodDebit = from
    ? sql<string>`COALESCE(SUM(${verificationRows.debit}) FILTER (WHERE ${verifications.date} >= ${from}), 0)`
    : sql<string>`COALESCE(SUM(${verificationRows.debit}), 0)`;
  const periodCredit = from
    ? sql<string>`COALESCE(SUM(${verificationRows.credit}) FILTER (WHERE ${verifications.date} >= ${from}), 0)`
    : sql<string>`COALESCE(SUM(${verificationRows.credit}), 0)`;

  const rows = await executor
    .select({
      accountId: verificationRows.accountId,
      accountNumber: accounts.number,
      accountName: accounts.name,
      openingDebit,
      openingCredit,
      periodDebit,
      periodCredit,
    })
    .from(verificationRows)
    .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(and(eq(verifications.status, "booked"), lte(verifications.date, to), ...dimensionConditions(filter)))
    .groupBy(verificationRows.accountId, accounts.number, accounts.name)
    .orderBy(asc(accounts.number));

  return rows.map((row) => ({
    accountId: row.accountId,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    openingDebit: Number(row.openingDebit),
    openingCredit: Number(row.openingCredit),
    periodDebit: Number(row.periodDebit),
    periodCredit: Number(row.periodCredit),
  }));
}

// The same aggregation split per object of ONE dimension (resultaträkningen
// Per kostnadsställe / Per projekt). Summing the groups of an account gives
// exactly readAccountBalances' figure for it — same rows, same windows.
export async function readAccountBalancesGrouped(
  executor: Db | Tx,
  range: { from: string | null; to: string },
  groupBy: BalanceGroupBy,
  filter?: DimensionFilter
): Promise<GroupedAccountBalance[]> {
  const { from, to } = range;
  const objectColumn = groupBy === "costCenter" ? verificationRows.costCenterId : verificationRows.projectId;
  const openingDebit = from
    ? sql<string>`COALESCE(SUM(${verificationRows.debit}) FILTER (WHERE ${verifications.date} < ${from}), 0)`
    : sql<string>`0`;
  const openingCredit = from
    ? sql<string>`COALESCE(SUM(${verificationRows.credit}) FILTER (WHERE ${verifications.date} < ${from}), 0)`
    : sql<string>`0`;
  const periodDebit = from
    ? sql<string>`COALESCE(SUM(${verificationRows.debit}) FILTER (WHERE ${verifications.date} >= ${from}), 0)`
    : sql<string>`COALESCE(SUM(${verificationRows.debit}), 0)`;
  const periodCredit = from
    ? sql<string>`COALESCE(SUM(${verificationRows.credit}) FILTER (WHERE ${verifications.date} >= ${from}), 0)`
    : sql<string>`COALESCE(SUM(${verificationRows.credit}), 0)`;

  const rows = await executor
    .select({
      accountId: verificationRows.accountId,
      accountNumber: accounts.number,
      accountName: accounts.name,
      objectId: objectColumn,
      openingDebit,
      openingCredit,
      periodDebit,
      periodCredit,
    })
    .from(verificationRows)
    .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(and(eq(verifications.status, "booked"), lte(verifications.date, to), ...dimensionConditions(filter)))
    .groupBy(verificationRows.accountId, accounts.number, accounts.name, objectColumn)
    .orderBy(asc(accounts.number));

  return rows.map((row) => ({
    accountId: row.accountId,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    objectId: row.objectId,
    openingDebit: Number(row.openingDebit),
    openingCredit: Number(row.openingCredit),
    periodDebit: Number(row.periodDebit),
    periodCredit: Number(row.periodCredit),
  }));
}
