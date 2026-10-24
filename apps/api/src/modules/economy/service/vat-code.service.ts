import { count, eq, inArray, isNotNull } from "drizzle-orm";
import { accounts, postingRules, vatCodes, type Db } from "@navet/db";
import {
  VAT_CODES,
  VAT_CODE_ACCOUNT_FIELDS,
  VAT_CODE_SLOTS,
  isVatCode,
  vatCodeEntry,
  type ImportVatInput,
  type UpdateVatCodeInput,
  type VatBoxSetting,
  type VatCode,
  type VatCodeAccountView,
  type VatCodeSlot,
  type VatCodeView,
} from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { findVatCodeRow, listVatCodeRows, loadPostingVatCodes } from "../repository/vat-codes.js";
import { VatCodeNotFoundError } from "./economy.service.js";
import { VatCodeAccountConflictError, type VerificationPoster } from "./verification-poster.js";

// Momskoder (bokföringsgranskningen etapp 1): the register view over the
// fixed catalog + the company's vat_codes rows, the edit (names, invoice
// text, active, accounts per slot) and the importmoms posting. No create and
// no delete — the catalog decides which codes exist.

// A slot that is not the code's own: the catalog decides which accounts a
// code posts to (a domestic code has no cost account, an EU sale no VAT).
export class VatCodeSlotNotUsedError extends Error {
  constructor(code: string, slot: VatCodeSlot) {
    super(`VAT code ${code} does not use the ${slot} account`);
    this.name = "VatCodeSlotNotUsedError";
  }
}

// The account a slot points at must exist in the chart and be active — the
// same rule the poster enforces at posting time, asked when it is set.
export class VatCodeAccountInvalidError extends Error {
  constructor(
    public accountNumber: string,
    reason: "missing" | "inactive"
  ) {
    super(
      reason === "missing"
        ? `Account ${accountNumber} does not exist in the chart of accounts`
        : `Account ${accountNumber} is inactive`
    );
    this.name = "VatCodeAccountInvalidError";
  }
}

// An importmoms row whose code is unknown, inactive or not an import code.
export class ImportVatCodeError extends Error {
  constructor(id: string, reason: "unknown" | "inactive" | "not_import") {
    super(
      reason === "unknown"
        ? `VAT code ${id} not found`
        : reason === "inactive"
          ? `VAT code ${id} is inactive`
          : `VAT code ${id} is not an import VAT code`
    );
    this.name = "ImportVatCodeError";
  }
}

const SLOT_COLUMN = {
  revenue: "revenueAccount",
  outputVat: "outputVatAccount",
  inputVat: "inputVatAccount",
  cost: "costAccount",
  base: "baseAccount",
  baseCounter: "baseCounterAccount",
} as const satisfies Record<VatCodeSlot, keyof typeof vatCodes.$inferSelect>;

type VatCodeRow = typeof vatCodes.$inferSelect;

// "ruta 35" / "ingen ruta" — the Swedish wording the VAT report's warnings
// share.
export function boxText(box: VatBoxSetting | null): string {
  return box === null || box === "none" ? "ingen ruta" : `ruta ${box}`;
}
type AccountInfo = { number: string; name: string; active: boolean; vatBox: VatBoxSetting | null };

function accountView(code: VatCode, slot: VatCodeSlot, row: VatCodeRow, chart: Map<string, AccountInfo>): VatCodeAccountView {
  const expected = vatCodeEntry(code).slots[slot]!;
  const accountNumber = row[SLOT_COLUMN[slot]] ?? expected.account;
  const account = chart.get(accountNumber);
  const actualBox = account?.vatBox ?? null;
  const warning: VatCodeAccountView["warning"] = !account
    ? "missing"
    : !account.active
      ? "inactive"
      : actualBox !== expected.box
        ? "box_mismatch"
        : null;
  return {
    slot,
    accountNumber,
    defaultAccountNumber: expected.account,
    expectedBox: expected.box,
    accountName: account?.name ?? null,
    accountActive: account?.active ?? null,
    actualBox,
    warning,
  };
}

export function buildVatCodeView(row: VatCodeRow, chart: Map<string, AccountInfo>, ruleCount: number): VatCodeView {
  // Rows are seeded from the catalog; a code outside it would be a manual
  // DB edit and is reported as such rather than rendered half-way.
  if (!isVatCode(row.code)) throw new Error(`vat_codes row ${row.code} is not in the catalog`);
  const entry = vatCodeEntry(row.code);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    invoiceText: row.invoiceText,
    active: row.active,
    label: entry.label,
    direction: entry.direction,
    kind: entry.kind,
    rate: entry.rate,
    requiresBuyerVatNumber: entry.requiresBuyerVatNumber,
    defaultInvoiceText: entry.invoiceText,
    accounts: VAT_CODE_SLOTS.filter((slot) => entry.slots[slot] !== undefined).map((slot) =>
      accountView(row.code as VatCode, slot, row, chart)
    ),
    ruleCount,
  };
}

// Catalog order — the order the Momskoder page and the selects list codes.
const CATALOG_INDEX = new Map(VAT_CODES.map((code, index) => [code, index] as const));

export function createVatCodeService(deps: { db: Db; poster: VerificationPoster; audit: AuditWriter }) {
  const { db, poster, audit } = deps;

  async function chartFor(numbers: string[]): Promise<Map<string, AccountInfo>> {
    const unique = [...new Set(numbers)];
    if (unique.length === 0) return new Map();
    const rows = await db
      .select({ number: accounts.number, name: accounts.name, active: accounts.active, vatBox: accounts.vatBox })
      .from(accounts)
      .where(inArray(accounts.number, unique));
    return new Map(rows.map((row) => [row.number, { ...row, vatBox: row.vatBox as VatBoxSetting | null }] as const));
  }

  async function ruleCounts(): Promise<Map<string, number>> {
    const rows = await db
      .select({ vatCodeId: postingRules.vatCodeId, rules: count() })
      .from(postingRules)
      .where(isNotNull(postingRules.vatCodeId))
      .groupBy(postingRules.vatCodeId);
    return new Map(rows.map((row) => [row.vatCodeId!, Number(row.rules)] as const));
  }

  function slotNumbers(row: VatCodeRow): string[] {
    if (!isVatCode(row.code)) return [];
    const entry = vatCodeEntry(row.code);
    return VAT_CODE_SLOTS.flatMap((slot) => (entry.slots[slot] ? [row[SLOT_COLUMN[slot]] ?? entry.slots[slot]!.account] : []));
  }

  async function view(row: VatCodeRow): Promise<VatCodeView> {
    const [chart, counts] = await Promise.all([chartFor(slotNumbers(row)), ruleCounts()]);
    return buildVatCodeView(row, chart, counts.get(row.id) ?? 0);
  }

  return {
    // Every code in catalog order (the table's alphabetical order is not
    // the order the law/the page groups them in).
    async list(): Promise<VatCodeView[]> {
      const rows = (await listVatCodeRows(db)).filter((row) => isVatCode(row.code));
      const [chart, counts] = await Promise.all([chartFor(rows.flatMap(slotNumbers)), ruleCounts()]);
      return rows
        .sort((a, b) => CATALOG_INDEX.get(a.code as VatCode)! - CATALOG_INDEX.get(b.code as VatCode)!)
        .map((row) => buildVatCodeView(row, chart, counts.get(row.id) ?? 0));
    },

    // Partial edit. Accounts: only the catalog's slots, "" = the catalog
    // default, and the resulting account must exist and be active; two slots
    // of one code may not share an account (the posting would cancel
    // itself). Deactivating a code a posting rule points at is allowed but
    // answered with a warning. Logged as vat_code_changed with before/after
    // of the changed fields.
    async update(id: string, input: UpdateVatCodeInput, userId: string) {
      const existing = await findVatCodeRow(db, id);
      if (!existing || !isVatCode(existing.code)) throw new VatCodeNotFoundError(id);
      const code = existing.code;
      const entry = vatCodeEntry(code);

      const patch: Partial<VatCodeRow> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.invoiceText !== undefined) patch.invoiceText = input.invoiceText;
      if (input.active !== undefined) patch.active = input.active;

      for (const slot of VAT_CODE_SLOTS) {
        const value = input[VAT_CODE_ACCOUNT_FIELDS[slot]];
        if (value === undefined) continue;
        const slotDefault = entry.slots[slot];
        if (!slotDefault) {
          // "" on a slot the code does not use is a no-op (it stays empty).
          if (value === "") continue;
          throw new VatCodeSlotNotUsedError(code, slot);
        }
        patch[SLOT_COLUMN[slot]] = value === "" ? slotDefault.account : value;
      }

      const merged = { ...existing, ...patch };
      const numbers = slotNumbers(merged);
      const changedNumbers = VAT_CODE_SLOTS.flatMap((slot) => {
        const next = patch[SLOT_COLUMN[slot]];
        return next !== undefined && next !== null && next !== existing[SLOT_COLUMN[slot]] ? [next] : [];
      });
      const chart = await chartFor(numbers);
      for (const number of changedNumbers) {
        const account = chart.get(number);
        if (!account) throw new VatCodeAccountInvalidError(number, "missing");
        if (!account.active) throw new VatCodeAccountInvalidError(number, "inactive");
      }
      const seen = new Set<string>();
      for (const number of numbers) {
        if (seen.has(number)) throw new VatCodeAccountConflictError(code, number);
        seen.add(number);
      }

      const changedFields = (Object.keys(patch) as (keyof VatCodeRow)[]).filter((key) => patch[key] !== existing[key]);
      let updated = existing;
      if (changedFields.length > 0) {
        const [row] = await db
          .update(vatCodes)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(vatCodes.id, id))
          .returning();
        updated = row!;
        await audit.log({
          entityType: "vat_code",
          entityId: code,
          action: "vat_code_changed",
          detail: {
            before: Object.fromEntries(changedFields.map((key) => [key, existing[key]])),
            after: Object.fromEntries(changedFields.map((key) => [key, updated[key]])),
          },
          userId,
        });
      }

      const result = await view(updated);
      const warnings: string[] = [];
      if (!result.active && result.ruleCount > 0) {
        warnings.push(
          `Momskoden ${code} är inaktiv men används av ${result.ruleCount} ${result.ruleCount === 1 ? "konteringsregel" : "konteringsregler"}`
        );
      }
      for (const account of result.accounts) {
        if (account.warning === "box_mismatch") {
          warnings.push(`Konto ${account.accountNumber} har ${boxText(account.actualBox)} men ska ha ${boxText(account.expectedBox)}`);
        }
      }
      return { vatCode: result, warnings };
    },

    // Importmoms (POST /import-vat): one IM verification for the customs
    // decision's rows. The codes are read and validated outside the
    // transaction (they are configuration) and re-loaded inside it for the
    // posting, the same split as the invoice postings.
    async postImportVat(input: ImportVatInput, userId: string) {
      const ids = input.rows.map((row) => row.vatCodeId);
      const rowsById = new Map(
        (await db.select().from(vatCodes).where(inArray(vatCodes.id, [...new Set(ids)]))).map((row) => [row.id, row] as const)
      );
      for (const id of ids) {
        const row = rowsById.get(id);
        if (!row || !isVatCode(row.code)) throw new ImportVatCodeError(id, "unknown");
        if (vatCodeEntry(row.code).kind !== "import") throw new ImportVatCodeError(row.code, "not_import");
        if (!row.active) throw new ImportVatCodeError(row.code, "inactive");
      }
      return db.transaction(async (tx) => {
        const codes = await loadPostingVatCodes(tx, ids);
        const posted = await poster.postImportVat(
          tx,
          {
            date: input.date,
            description: input.description,
            rows: input.rows.map((row) => ({ vatCode: codes.get(row.vatCodeId)!, taxBase: row.taxBase })),
          },
          userId
        );
        return { verification: { id: posted.verificationId, displayNumber: posted.displayNumber } };
      });
    },
  };
}

export type VatCodeService = ReturnType<typeof createVatCodeService>;
