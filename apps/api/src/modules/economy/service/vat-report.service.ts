import { sql } from "drizzle-orm";
import type { Db } from "@navet/db";
import { round2, type VatBox } from "@navet/shared";
import {
  MissingPostingAccountError,
  type PostingAccountNumbers,
  type PostingSettingsReader,
  type VerificationPoster,
} from "./verification-poster.js";
import { findAccountsByNumbers, readVatAccountMovements, type VatAccountMovement } from "./vat-account-movements.js";
import {
  findPeriodsInRange,
  findSettlementsOverlapping,
  insertSettlement,
  type OverlappingSettlement,
} from "../repository/vat-settlement.repository.js";

// Momsrapport (B5): Skatteverkets deklarationsrutor per redovisningsperiod
// (månad eller kvartal — any exact run of accounting periods), derived from
// booked verifications only, plus the momsomföring that closes the period
// onto redovisningskontot för moms.
//
// Box mapping (ekonomi etapp 2, delprojekt 1): every account carries its
// momsruta (accounts.vat_box) and the boxes are a pure lookup over the
// period's movements — manual and auto-posted rows alike. The 0102
// migration backfilled the boxes from the old hybrid rule (configured VAT
// accounts + revenue interval 3000-3799), so reports did not change on
// deploy. Accounts without a box are surfaced as warnings instead of being
// silently left out.

export class VatPeriodNotCoveredError extends Error {
  constructor(from: string, to: string) {
    super(`The range ${from} – ${to} does not exactly cover a contiguous run of accounting periods`);
    this.name = "VatPeriodNotCoveredError";
  }
}

export class VatAccountsNotDistinctError extends Error {
  constructor(accountNumber: string) {
    super(`Account ${accountNumber} is configured for more than one VAT role — the report would double-count it`);
    this.name = "VatAccountsNotDistinctError";
  }
}

export class VatPeriodAlreadySettledError extends Error {
  readonly displayNumber: string;
  constructor(displayNumber: string) {
    super(`The range overlaps an active momsomföring (${displayNumber}) — reverse it before settling again`);
    this.name = "VatPeriodAlreadySettledError";
    this.displayNumber = displayNumber;
  }
}

export type VatReportBoxes = {
  sales05: number;
  salesEu35: number;
  salesExport36: number;
  salesExempt42: number;
  vatOut25_10: number;
  vatOut12_11: number;
  vatOut6_12: number;
  vatIn48: number;
  vatToPay49: number;
};

export type VatRoleKey = "vatOut25" | "vatOut12" | "vatOut6" | "vatIn";

const BOX_TARGET: Record<VatBox, { key: keyof VatReportBoxes; debitPositive?: true }> = {
  "05": { key: "sales05" },
  "35": { key: "salesEu35" },
  "36": { key: "salesExport36" },
  "42": { key: "salesExempt42" },
  "10": { key: "vatOut25_10" },
  "11": { key: "vatOut12_11" },
  "12": { key: "vatOut6_12" },
  "48": { key: "vatIn48", debitPositive: true },
};

// Every posting role that feeds a box, with the box its account is expected
// to carry. A mismatch is reported: the boxes read the account's own
// momsruta, so a setting moved onto an account with another box (momsfri
// försäljning onto a 05 account, utgående moms onto an unclassified one)
// would otherwise misreport silently — the old report followed the setting.
// The four VAT roles are also what the momsomföring empties.
export type VatBoxRoleKey = VatRoleKey | "revenue25" | "revenue12" | "revenue6" | "revenue0";

const BOX_ROLES: { role: VatBoxRoleKey; setting: keyof PostingAccountNumbers; box: VatBox }[] = [
  { role: "vatOut25", setting: "postingVatOut25", box: "10" },
  { role: "vatOut12", setting: "postingVatOut12", box: "11" },
  { role: "vatOut6", setting: "postingVatOut6", box: "12" },
  { role: "vatIn", setting: "postingVatIn", box: "48" },
  { role: "revenue25", setting: "postingRevenue25", box: "05" },
  { role: "revenue12", setting: "postingRevenue12", box: "05" },
  { role: "revenue6", setting: "postingRevenue6", box: "05" },
  { role: "revenue0", setting: "postingRevenue0", box: "42" },
];

export type VatAccountPreview = {
  role: VatRoleKey;
  accountId: string;
  accountNumber: string;
  accountName: string;
  debit: number;
  credit: number;
  net: number;
};

const VAT_ROLES: { role: VatRoleKey; setting: keyof PostingAccountNumbers; label: string }[] = [
  { role: "vatOut25", setting: "postingVatOut25", label: "outgoing VAT 25" },
  { role: "vatOut12", setting: "postingVatOut12", label: "outgoing VAT 12" },
  { role: "vatOut6", setting: "postingVatOut6", label: "outgoing VAT 6" },
  { role: "vatIn", setting: "postingVatIn", label: "incoming VAT" },
];

// Every VAT role (plus redovisningskontot) on its own account, or the
// momsomföring would net one account twice. Exported for its unit test.
export function assertDistinctVatAccounts(settings: PostingAccountNumbers): void {
  const numbers = [...VAT_ROLES.map((role) => settings[role.setting]), settings.postingVatSettlement];
  const seen = new Set<string>();
  for (const number of numbers) {
    if (seen.has(number)) throw new VatAccountsNotDistinctError(number);
    seen.add(number);
  }
}

// UTC day arithmetic on date-only strings — no DST edge to care about.
function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

type PeriodRow = Awaited<ReturnType<typeof findPeriodsInRange>>[number];

// [from, to] must exactly tile a contiguous run of periods: month = one
// period, quarter = three — one rule serves both, and clipped brutet-år
// months work unchanged. Gaps only ever appear across fiscal-year holes.
async function assertRangeCoversPeriods(executor: Parameters<typeof findPeriodsInRange>[0], from: string, to: string) {
  const periods = await findPeriodsInRange(executor, from, to);
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (!first || !last || first.startDate !== from || last.endDate !== to) {
    throw new VatPeriodNotCoveredError(from, to);
  }
  for (let i = 1; i < periods.length; i++) {
    if (periods[i]!.startDate !== nextDay(periods[i - 1]!.endDate)) throw new VatPeriodNotCoveredError(from, to);
  }
  return periods;
}

// Pure bucketing — exported for unit tests.
export function bucketMovements(movements: Pick<VatAccountMovement, "vatBox" | "debit" | "credit">[]): VatReportBoxes {
  const boxes: VatReportBoxes = {
    sales05: 0,
    salesEu35: 0,
    salesExport36: 0,
    salesExempt42: 0,
    vatOut25_10: 0,
    vatOut12_11: 0,
    vatOut6_12: 0,
    vatIn48: 0,
    vatToPay49: 0,
  };
  for (const movement of movements) {
    if (movement.vatBox === null || movement.vatBox === "none") continue;
    const target = BOX_TARGET[movement.vatBox];
    const creditNet = round2(movement.credit - movement.debit);
    boxes[target.key] = round2(boxes[target.key] + (target.debitPositive ? -creditNet : creditNet));
  }
  boxes.vatToPay49 = round2(boxes.vatOut25_10 + boxes.vatOut12_11 + boxes.vatOut6_12 - boxes.vatIn48);
  return boxes;
}

export type VatUnassignedAccount = { accountNumber: string; accountName: string; net: number };

// Revenue (class 3) and VAT (26xx) accounts that moved in the period but
// have no momsruta — exactly what the old interval rule silently dropped.
export function findUnassignedAccounts(movements: VatAccountMovement[]): VatUnassignedAccount[] {
  return movements.flatMap((movement) => {
    const relevant = movement.accountNumber.startsWith("3") || movement.accountNumber.startsWith("26");
    const net = round2(movement.credit - movement.debit);
    if (!relevant || movement.vatBox !== null || net === 0) return [];
    return [{ accountNumber: movement.accountNumber, accountName: movement.accountName, net }];
  });
}

export type VatRoleBoxMismatch = { role: VatBoxRoleKey; accountNumber: string; expectedBox: VatBox; actualBox: string | null };

export function findRoleBoxMismatches(
  settings: PostingAccountNumbers,
  accounts: { number: string; vatBox: string | null }[]
): VatRoleBoxMismatch[] {
  return BOX_ROLES.flatMap(({ role, setting, box: expectedBox }) => {
    const accountNumber = settings[setting];
    const actualBox = accounts.find((account) => account.number === accountNumber)?.vatBox ?? null;
    return actualBox === expectedBox ? [] : [{ role, accountNumber, expectedBox, actualBox }];
  });
}

export function createVatReportService(deps: {
  db: Db;
  poster: VerificationPoster;
  settings: PostingSettingsReader;
}) {
  const { db, poster, settings } = deps;

  // The four roles' movement rows for the settlement preview — all four
  // always present (zero rows included) so the UI can render the omföring
  // card without special cases.
  function vatAccountPreviews(
    postingAccounts: PostingAccountNumbers,
    accounts: Awaited<ReturnType<typeof findAccountsByNumbers>>,
    movements: VatAccountMovement[]
  ): VatAccountPreview[] {
    const movementByNumber = new Map(movements.map((movement) => [movement.accountNumber, movement]));
    return VAT_ROLES.map(({ role, setting, label }) => {
      const number = postingAccounts[setting];
      const account = accounts.find((row) => row.number === number);
      if (!account || !account.active) throw new MissingPostingAccountError(number, label);
      const movement = movementByNumber.get(number);
      const debit = movement?.debit ?? 0;
      const credit = movement?.credit ?? 0;
      return {
        role,
        accountId: account.id,
        accountNumber: number,
        accountName: account.name,
        debit,
        credit,
        net: round2(debit - credit),
      };
    });
  }

  return {
    async getReport(query: { from: string; to: string }) {
      const { from, to } = query;
      const periods = await assertRangeCoversPeriods(db, from, to);
      const postingAccounts = await settings.read(db);
      assertDistinctVatAccounts(postingAccounts);

      const movements = await readVatAccountMovements(db, from, to);
      const boxes = bucketMovements(movements);
      const roleAccounts = await findAccountsByNumbers(
        db,
        BOX_ROLES.map((role) => postingAccounts[role.setting])
      );
      const vatAccounts = vatAccountPreviews(postingAccounts, roleAccounts, movements);
      const settlements = await findSettlementsOverlapping(db, from, to);
      const warnings = {
        unassignedAccounts: findUnassignedAccounts(movements),
        roleBoxMismatches: findRoleBoxMismatches(postingAccounts, roleAccounts),
      };

      return { from, to, boxes, vatAccounts, settlements, periods, warnings };
    },

    // The momsomföring. Everything runs in ONE transaction — advisory lock,
    // in-tx recompute (the GET preview is only advisory, same fast-path/
    // authority split as economy.service's book()), M verification, number
    // and the settlement fact — so a failure anywhere leaves no trace.
    async settle(input: { from: string; to: string }, userId: string) {
      const { from, to } = input;
      return db.transaction(async (tx) => {
        // Settlements are rare; serialize them globally. A unique/exclusion
        // constraint cannot express "active only" (reversal state lives on
        // the verifications side), and without the lock two concurrent
        // settles both pass the overlap check — the other's uncommitted
        // settlement row is invisible — and double-book the omföring.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vat_settlements'))`);

        await assertRangeCoversPeriods(tx, from, to);

        const overlapping = await findSettlementsOverlapping(tx, from, to);
        const active = overlapping.find((settlement) => !settlement.reversed);
        if (active) throw new VatPeriodAlreadySettledError(active.displayNumber);

        const postingAccounts = await settings.read(tx);
        assertDistinctVatAccounts(postingAccounts);

        const movements = await readVatAccountMovements(tx, from, to);
        const movementByNumber = new Map(movements.map((movement) => [movement.accountNumber, movement]));
        const vatMovements = VAT_ROLES.map(({ setting }) => {
          const number = postingAccounts[setting];
          const movement = movementByNumber.get(number);
          return { accountNumber: number, net: round2((movement?.debit ?? 0) - (movement?.credit ?? 0)) };
        });

        // ZeroAmountPostingError for an all-zero period comes from the
        // poster (its movements filter), like every other posting guard.
        const verification = await poster.postVatSettlement(
          tx,
          { fromDate: from, toDate: to, movements: vatMovements },
          userId,
          // Same read as the guards above — no second settings read inside
          // the transaction window.
          postingAccounts
        );

        const settlement = await insertSettlement(tx, {
          fromDate: from,
          toDate: to,
          verificationId: verification.verificationId,
          createdBy: userId,
        });

        return {
          settlement,
          verification: { id: verification.verificationId, displayNumber: verification.displayNumber },
        };
      });
    },
  };
}

export type VatReportService = ReturnType<typeof createVatReportService>;
export type VatReportSettlement = OverlappingSettlement;
export type VatReportPeriod = PeriodRow;
