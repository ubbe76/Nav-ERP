import { and, asc, eq, gte, inArray, lte, notExists, sql } from "drizzle-orm";
import {
  accounts,
  fixedAssets,
  vatSettlements,
  verificationRows,
  verifications,
  yearEndClosingVerifications,
  type Db,
  type Tx,
} from "@navet/db";
import type { VatBoxSetting } from "@navet/shared";

// Momsrapport (B5) — the economy module's first multi-account aggregation:
// every account's booked debit/credit sums over a date range, GROUP BY
// account. Db|Tx-composable leaf (same seam as assertPostablePeriod /
// readPostingSettings): the report reads through the plain Db, the settle
// path re-reads through its own transaction as the in-tx authority.
//
// Settlement verifications AND their reversals are excluded BY IDENTITY
// (vat_settlements links, not dates): after a momsomföring the report must
// keep showing the declared period's real trade (not zeros), a reversal
// booked in a later month must not pollute that month's report, and a
// re-settle after reversal must see the original movements again. The two
// always net to zero per account, so excluding both is invisible to any
// range's arithmetic.
//
// Disposal verifications of the anläggningsregister (fixed_assets.
// disposal_verification_id) are excluded the same way: the customer invoice
// credits the mellankonto and the disposal debits it, so without the
// exclusion the sale would net to zero and never reach ruta 05. Their
// catch-up depreciation verifications touch only 78xx/12xx (no momsruta)
// and are left alone. Disposal verifications can never be reversed (no
// Ångra avyttring, Omför blocked for AV), so no reversal clause is needed.
//
// Verifications the year-end closing guide booked (year_end_closing_
// verifications) are excluded the same way: an accrual on a revenue account
// with a momsruta would otherwise lift December's box and lower January's,
// and no closing entry is momspliktig omsättning.
export type VatAccountMovement = {
  accountId: string;
  accountNumber: string;
  accountName: string;
  vatBox: VatBoxSetting | null;
  debit: number;
  credit: number;
};

export async function readVatAccountMovements(executor: Db | Tx, from: string, to: string): Promise<VatAccountMovement[]> {
  const rows = await executor
    .select({
      accountId: verificationRows.accountId,
      accountNumber: accounts.number,
      accountName: accounts.name,
      vatBox: accounts.vatBox,
      debit: sql<string>`COALESCE(SUM(${verificationRows.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${verificationRows.credit}), 0)`,
    })
    .from(verificationRows)
    .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(
      and(
        eq(verifications.status, "booked"),
        gte(verifications.date, from),
        lte(verifications.date, to),
        notExists(
          executor
            .select({ one: sql`1` })
            .from(vatSettlements)
            .where(eq(vatSettlements.verificationId, verifications.id))
        ),
        // reverses_verification_id IS NULL makes the subquery empty, so
        // ordinary verifications pass without a separate null guard.
        notExists(
          executor
            .select({ one: sql`1` })
            .from(vatSettlements)
            .where(eq(vatSettlements.verificationId, verifications.reversesVerificationId))
        ),
        notExists(
          executor
            .select({ one: sql`1` })
            .from(fixedAssets)
            .where(eq(fixedAssets.disposalVerificationId, verifications.id))
        ),
        notExists(
          executor
            .select({ one: sql`1` })
            .from(yearEndClosingVerifications)
            .where(eq(yearEndClosingVerifications.verificationId, verifications.id))
        )
      )
    )
    .groupBy(verificationRows.accountId, accounts.number, accounts.name, accounts.vatBox)
    .orderBy(asc(accounts.number));

  return rows.map((row) => ({
    accountId: row.accountId,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    vatBox: row.vatBox as VatBoxSetting | null,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }));
}

// The configured VAT-role accounts for the report's settlement preview —
// resolved by number so roles with no movement in the range still render
// with their account identity (and so a missing account is reportable).
export async function findAccountsByNumbers(executor: Db | Tx, numbers: string[]) {
  if (numbers.length === 0) return [];
  return executor
    .select({ id: accounts.id, number: accounts.number, name: accounts.name, active: accounts.active, vatBox: accounts.vatBox })
    .from(accounts)
    .where(inArray(accounts.number, numbers));
}
