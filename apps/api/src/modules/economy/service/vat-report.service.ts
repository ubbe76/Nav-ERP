import { sql } from "drizzle-orm";
import { postingRules, type Db } from "@navet/db";
import {
  VAT_BOXES,
  VAT_CODE_SLOTS,
  VAT_SETTLED_BOXES,
  isVatCode,
  round2,
  vatCodeEntry,
  type UpdateVatReportingSettingsInput,
  type VatBox,
  type VatBoxSetting,
  type VatCode,
  type VatCodeSlot,
  type VatDeclarationBoxes,
} from "@navet/shared";
import type { PostingAccountNumbers, PostingSettingsReader, VerificationPoster } from "./verification-poster.js";
import { findAccountsByNumbers, readVatAccountMovements, type VatAccountMovement } from "./vat-account-movements.js";
import { boxText } from "./vat-code.service.js";
import { buildVatDeclarationFile, formatVatFileOrgNumber, vatFilePeriod } from "./vat-file.js";
import { listVatCodeRows } from "../repository/vat-codes.js";
import {
  findPeriodsInRange,
  findSettlementsOverlapping,
  insertSettlement,
  type OverlappingSettlement,
} from "../repository/vat-settlement.repository.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import {
  readVatReportingSettings,
  writeVatReportingSettings,
} from "../../system/service/vat-reporting-settings.js";

// Momsrapport (B5): Skatteverkets deklarationsrutor per redovisningsperiod
// (månad, kvartal eller helår — any exact run of accounting periods), derived
// from booked verifications only, plus the momsomföring that closes the
// period onto redovisningskontot för moms.
//
// Box mapping: every account carries its momsruta (accounts.vat_box) and the
// boxes are a pure lookup over the period's movements — manual and
// auto-posted rows alike. The momskoder (migration 0142) only decide which
// account a document posts to; the report never reads documents. Accounts
// without a box are surfaced as warnings instead of being silently left out.

export class VatPeriodNotCoveredError extends Error {
  constructor(from: string, to: string) {
    super(`The range ${from} – ${to} does not exactly cover a contiguous run of accounting periods`);
    this.name = "VatPeriodNotCoveredError";
  }
}

// The momsomföring empties every account whose box enters ruta 49 — so the
// redovisningskonto and the öres account must not carry such a box
// themselves, or the omföring would empty the account it settles onto.
export class VatAccountsNotDistinctError extends Error {
  constructor(accountNumber: string) {
    super(`Account ${accountNumber} carries a VAT box the momsomföring empties — it cannot also take the settlement`);
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

// The declaration file names the company by its organisationsnummer.
export class VatFileOrgNumberMissingError extends Error {
  constructor() {
    super("The company's organisationsnummer is missing or not ten digits — set it under Företagsuppgifter");
    this.name = "VatFileOrgNumberMissingError";
  }
}

// Inköp (20–24), the import base (50) and the ingående moms (48) are debit
// balances; everything else — sales, the bases of exempt sales and every
// utgående moms — is a credit balance.
const DEBIT_POSITIVE_BOXES = new Set<VatBox>(["20", "21", "22", "23", "24", "48", "50"]);
const OUTPUT_VAT_BOXES = ["10", "11", "12", "30", "31", "32", "60", "61", "62"] as const satisfies readonly VatBox[];
const SETTLED_BOXES = new Set<string>(VAT_SETTLED_BOXES);

function emptyBoxes(): VatDeclarationBoxes {
  return Object.fromEntries([...VAT_BOXES, "49"].map((box) => [box, 0])) as VatDeclarationBoxes;
}

function box49(boxes: VatDeclarationBoxes, round: (n: number) => number): number {
  return round(OUTPUT_VAT_BOXES.reduce((sum, box) => sum + boxes[box], 0) - boxes["48"]);
}

// Pure bucketing — exported for unit tests. Öre amounts; ruta 49 =
// (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) − 48.
export function bucketMovements(movements: Pick<VatAccountMovement, "vatBox" | "debit" | "credit">[]): VatDeclarationBoxes {
  const boxes = emptyBoxes();
  for (const movement of movements) {
    if (movement.vatBox === null || movement.vatBox === "none") continue;
    const creditNet = round2(movement.credit - movement.debit);
    boxes[movement.vatBox] = round2(boxes[movement.vatBox] + (DEBIT_POSITIVE_BOXES.has(movement.vatBox) ? -creditNet : creditNet));
  }
  boxes["49"] = box49(boxes, round2);
  return boxes;
}

// Hela kronor, half away from zero (the declaration is stated in whole
// kronor). Exported for its unit test.
export function roundToKronor(amount: number): number {
  const magnitude = Math.round(Math.abs(amount) + 1e-9);
  return amount < 0 && magnitude !== 0 ? -magnitude : magnitude;
}

// Every box rounded to whole kronor; ruta 49 is computed from the ROUNDED
// boxes — the sum Skatteverket checks — not rounded from the öre sum.
export function roundBoxes(boxes: VatDeclarationBoxes): VatDeclarationBoxes {
  const rounded = emptyBoxes();
  for (const box of VAT_BOXES) rounded[box] = roundToKronor(boxes[box]);
  rounded["49"] = box49(rounded, (n) => n);
  return rounded;
}

export type VatUnassignedAccount = { accountNumber: string; accountName: string; net: number };

// Revenue (class 3), VAT (26xx) and purchase-with-VAT (44xx/45xx) accounts
// that moved in the period but have no momsruta.
export function findUnassignedAccounts(movements: VatAccountMovement[]): VatUnassignedAccount[] {
  return movements.flatMap((movement) => {
    const n = movement.accountNumber;
    const relevant = n.startsWith("3") || n.startsWith("26") || n.startsWith("44") || n.startsWith("45");
    const net = round2(movement.credit - movement.debit);
    if (!relevant || movement.vatBox !== null || net === 0) return [];
    return [{ accountNumber: movement.accountNumber, accountName: movement.accountName, net }];
  });
}

type AccountLookup = { number: string; name: string; active: boolean; vatBox: string | null };
type VatCodeRowLike = {
  id: string;
  code: string;
  active: boolean;
  revenueAccount: string | null;
  outputVatAccount: string | null;
  inputVatAccount: string | null;
  costAccount: string | null;
  baseAccount: string | null;
  baseCounterAccount: string | null;
};

const SLOT_COLUMN = {
  revenue: "revenueAccount",
  outputVat: "outputVatAccount",
  inputVat: "inputVatAccount",
  cost: "costAccount",
  base: "baseAccount",
  baseCounter: "baseCounterAccount",
} as const satisfies Record<VatCodeSlot, keyof VatCodeRowLike>;

export type VatCodeBoxMismatch = {
  code: VatCode;
  slot: VatCodeSlot;
  accountNumber: string;
  expectedBox: VatBoxSetting;
  actualBox: VatBoxSetting | null;
  problem: "box_mismatch" | "missing_account";
  message: string;
};

// The momsruta each active code's accounts are expected to carry (the
// catalog's slot box) against what the chart says — a momskod points at an
// account, and only the account's box reaches the declaration, so an EU sale
// posted to a 05 account would otherwise misreport silently.
export function findVatCodeBoxMismatches(codes: VatCodeRowLike[], chart: AccountLookup[]): VatCodeBoxMismatch[] {
  const byNumber = new Map(chart.map((account) => [account.number, account] as const));
  return codes.flatMap((row) => {
    if (!row.active || !isVatCode(row.code)) return [];
    const code = row.code;
    const entry = vatCodeEntry(code);
    return VAT_CODE_SLOTS.flatMap((slot): VatCodeBoxMismatch[] => {
      const expected = entry.slots[slot];
      if (!expected) return [];
      const accountNumber = row[SLOT_COLUMN[slot]] ?? expected.account;
      const account = byNumber.get(accountNumber);
      if (!account) {
        return [
          {
            code,
            slot,
            accountNumber,
            expectedBox: expected.box,
            actualBox: null,
            problem: "missing_account",
            message: `Momskod ${code}: konto ${accountNumber} finns inte i kontoplanen`,
          },
        ];
      }
      const actualBox = account.vatBox as VatBoxSetting | null;
      if (actualBox === expected.box) return [];
      return [
        {
          code,
          slot,
          accountNumber,
          expectedBox: expected.box,
          actualBox,
          problem: "box_mismatch",
          message: `Momskod ${code}: konto ${accountNumber} har ${boxText(actualBox)} men ska ha ${boxText(expected.box)}`,
        },
      ];
    });
  });
}

export type PostingRuleBoxMismatch = {
  ruleId: string;
  groupCode: string;
  groupName: string;
  code: VatCode;
  accountNumber: string;
  expectedBox: VatBoxSetting;
  actualBox: VatBoxSetting | null;
  message: string;
};

type RuleLike = {
  id: string;
  groupCode: string;
  groupName: string;
  vatCodeId: string | null;
  revenueAccountNumber: string | null;
  revenueAccountVatBox: string | null;
  costAccountNumber: string | null;
  costAccountVatBox: string | null;
};

// A rule for exactly a foreign/omvänd code replaces the code's own account,
// so its account must carry the code's box: the revenue account for a sales
// code (EUV/EUT/EXV/EXT/OB), the cost account for an omvänd-moms purchase.
export function findRuleBoxMismatches(rules: RuleLike[], codes: VatCodeRowLike[]): PostingRuleBoxMismatch[] {
  const codeById = new Map(codes.map((row) => [row.id, row] as const));
  return rules.flatMap((rule): PostingRuleBoxMismatch[] => {
    const row = rule.vatCodeId === null ? undefined : codeById.get(rule.vatCodeId);
    if (!row || !isVatCode(row.code)) return [];
    const code = row.code;
    const entry = vatCodeEntry(code);
    if (entry.kind === "domestic" || entry.kind === "non_eu_goods" || entry.kind === "import") return [];
    const slot: VatCodeSlot = entry.direction === "sales" ? "revenue" : "cost";
    const expected = entry.slots[slot];
    const accountNumber = slot === "revenue" ? rule.revenueAccountNumber : rule.costAccountNumber;
    if (!expected || accountNumber === null) return [];
    const actualBox = (slot === "revenue" ? rule.revenueAccountVatBox : rule.costAccountVatBox) as VatBoxSetting | null;
    if (actualBox === expected.box) return [];
    return [
      {
        ruleId: rule.id,
        groupCode: rule.groupCode,
        groupName: rule.groupName,
        code,
        accountNumber,
        expectedBox: expected.box,
        actualBox,
        message: `Konteringsregel ${rule.groupCode} ${rule.groupName} / ${code}: konto ${accountNumber} har ${boxText(actualBox)} men ska ha ${boxText(expected.box)}`,
      },
    ];
  });
}

// UTC day arithmetic on date-only strings — no DST edge to care about.
function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

type PeriodRow = Awaited<ReturnType<typeof findPeriodsInRange>>[number];

// [from, to] must exactly tile a contiguous run of periods: month = one
// period, quarter = three, helår = the fiscal year's — one rule serves all,
// and clipped brutet-år months work unchanged. Gaps only ever appear across
// fiscal-year holes.
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

// Every account the momsomföring empties: a box entering ruta 49 and a
// movement in the range.
function settledMovements(movements: VatAccountMovement[]) {
  return movements
    .filter((movement) => movement.vatBox !== null && SETTLED_BOXES.has(movement.vatBox))
    .map((movement) => ({ ...movement, net: round2(movement.debit - movement.credit) }))
    .filter((movement) => movement.net !== 0);
}

// The redovisningskonto and the öres account outside the settled boxes.
// Exported for its unit test.
export function assertSettlementAccountsOutsideBoxes(
  settings: Pick<PostingAccountNumbers, "postingVatSettlement" | "postingPaymentWriteOff">,
  chart: { number: string; vatBox: string | null }[]
): void {
  for (const number of [settings.postingVatSettlement, settings.postingPaymentWriteOff]) {
    const box = chart.find((account) => account.number === number)?.vatBox ?? null;
    if (box !== null && SETTLED_BOXES.has(box)) throw new VatAccountsNotDistinctError(number);
  }
}

export type VatSettlementPreviewRow = {
  accountId: string;
  accountNumber: string;
  accountName: string;
  vatBox: VatBoxSetting | null;
  debit: number;
  credit: number;
  net: number;
};

const NOOP_AUDIT: AuditWriter = { async log() {} };

export function createVatReportService(deps: {
  db: Db;
  poster: VerificationPoster;
  settings: PostingSettingsReader;
  // The organisationsnummer for the declaration file (Företagsuppgifter).
  company?: { orgNumber(): Promise<string | null> };
  audit?: AuditWriter;
}) {
  const { db, poster, settings } = deps;
  const audit = deps.audit ?? NOOP_AUDIT;

  async function computeReport(from: string, to: string) {
    const periods = await assertRangeCoversPeriods(db, from, to);
    const movements = await readVatAccountMovements(db, from, to);
    const boxes = bucketMovements(movements);
    return { periods, movements, boxes, roundedBoxes: roundBoxes(boxes) };
  }

  return {
    async getReport(query: { from: string; to: string }) {
      const { from, to } = query;
      const { periods, movements, boxes, roundedBoxes } = await computeReport(from, to);
      const postingAccounts = await settings.read(db);

      const codes = await listVatCodeRows(db);
      const slotNumbers = codes.flatMap((row) => {
        if (!isVatCode(row.code)) return [];
        const entry = vatCodeEntry(row.code);
        return VAT_CODE_SLOTS.flatMap((slot) => (entry.slots[slot] ? [row[SLOT_COLUMN[slot]] ?? entry.slots[slot]!.account] : []));
      });
      const chart = await findAccountsByNumbers(db, [
        ...new Set([...slotNumbers, postingAccounts.postingVatSettlement, postingAccounts.postingPaymentWriteOff]),
      ]);
      assertSettlementAccountsOutsideBoxes(postingAccounts, chart);

      const rules = await db.execute<RuleLike>(sql`
        SELECT r.id, g.code AS "groupCode", g.name AS "groupName", r.vat_code_id AS "vatCodeId",
               ra.number AS "revenueAccountNumber", ra.vat_box AS "revenueAccountVatBox",
               ca.number AS "costAccountNumber", ca.vat_box AS "costAccountVatBox"
        FROM ${postingRules} r
        JOIN article_groups g ON g.id = r.article_group_id
        LEFT JOIN accounts ra ON ra.id = r.revenue_account_id
        LEFT JOIN accounts ca ON ca.id = r.cost_account_id
        WHERE r.vat_code_id IS NOT NULL
        ORDER BY g.code`);

      const settled = settledMovements(movements);
      const emptied = round2(settled.reduce((sum, movement) => sum - movement.net, 0));
      const payable = roundedBoxes["49"];
      const accountName = (number: string) => chart.find((account) => account.number === number)?.name ?? null;

      return {
        from,
        to,
        boxes,
        roundedBoxes,
        settlement: {
          rows: settled.map(
            (movement): VatSettlementPreviewRow => ({
              accountId: movement.accountId,
              accountNumber: movement.accountNumber,
              accountName: movement.accountName,
              vatBox: movement.vatBox,
              debit: movement.debit,
              credit: movement.credit,
              net: movement.net,
            })
          ),
          // Kredit (positive) or debet (negative) on redovisningskontot —
          // ruta 49 in whole kronor.
          settlementAccount: {
            number: postingAccounts.postingVatSettlement,
            name: accountName(postingAccounts.postingVatSettlement),
            amount: payable,
          },
          // Kredit (positive) or debet (negative) on öres- och kronutjämning
          // — what the whole-krona declaration leaves of the öre balances.
          roundingAccount: {
            number: postingAccounts.postingPaymentWriteOff,
            name: accountName(postingAccounts.postingPaymentWriteOff),
            amount: round2(emptied - payable),
          },
        },
        settlements: await findSettlementsOverlapping(db, from, to),
        periods,
        warnings: {
          unassignedAccounts: findUnassignedAccounts(movements),
          vatCodeBoxMismatches: findVatCodeBoxMismatches(codes, chart),
          ruleBoxMismatches: findRuleBoxMismatches([...rules], codes),
        },
      };
    },

    // The declaration as Skatteverket's file (eSKDUpload 6.0): the rounded
    // boxes of exactly the range the report shows.
    async getFile(query: { from: string; to: string }) {
      const { from, to } = query;
      const { roundedBoxes } = await computeReport(from, to);
      const orgNumber = formatVatFileOrgNumber((await deps.company?.orgNumber()) ?? null);
      if (orgNumber === null) throw new VatFileOrgNumberMissingError();
      const period = vatFilePeriod(to);
      return {
        filename: `momsdeklaration-${period}.xml`,
        content: buildVatDeclarationFile({ orgNumber, period, boxes: roundedBoxes }),
      };
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
        assertSettlementAccountsOutsideBoxes(
          postingAccounts,
          await findAccountsByNumbers(tx, [postingAccounts.postingVatSettlement, postingAccounts.postingPaymentWriteOff])
        );

        const movements = await readVatAccountMovements(tx, from, to);
        const payable = roundBoxes(bucketMovements(movements))["49"];

        // ZeroAmountPostingError for an all-zero period comes from the
        // poster (its movements filter), like every other posting guard.
        const verification = await poster.postVatSettlement(
          tx,
          {
            fromDate: from,
            toDate: to,
            movements: settledMovements(movements).map((movement) => ({
              accountNumber: movement.accountNumber,
              net: movement.net,
            })),
            payable,
          },
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

    // Redovisningsperiod för moms + the periodisk sammanställning's contact.
    async getReportingSettings() {
      return readVatReportingSettings(db);
    },

    async updateReportingSettings(input: UpdateVatReportingSettingsInput, userId: string) {
      const changedKeys = await writeVatReportingSettings(db, input);
      if (changedKeys.length > 0) {
        await audit.log({ entityType: "system_settings", entityId: null, action: "updated", detail: { changedKeys }, userId });
      }
      return readVatReportingSettings(db);
    },
  };
}

export type VatReportService = ReturnType<typeof createVatReportService>;
export type VatReportSettlement = OverlappingSettlement;
export type VatReportPeriod = PeriodRow;
