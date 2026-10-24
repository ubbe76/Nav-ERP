import { eq } from "drizzle-orm";
import { db, vatCodes } from "@navet/db";
import { VAT_CODE_CATALOG, type VatCode } from "@navet/shared";
import type { PostingVatCode } from "../../src/modules/economy/service/verification-poster.js";

// Momskoder fixtures. The vat_codes rows are seeded by migration 0142 and no
// suite truncates them (nothing they reference is truncated either), so a
// test that edits a code restores the catalog defaults with resetVatCodes.

export async function vatCodeId(code: VatCode): Promise<string> {
  const [row] = await db.select({ id: vatCodes.id }).from(vatCodes).where(eq(vatCodes.code, code));
  if (!row) throw new Error(`vat_codes has no ${code} — is migration 0142 applied?`);
  return row.id;
}

export async function postingVatCode(code: VatCode): Promise<PostingVatCode> {
  const [row] = await db
    .select({
      id: vatCodes.id,
      code: vatCodes.code,
      revenueAccount: vatCodes.revenueAccount,
      outputVatAccount: vatCodes.outputVatAccount,
      inputVatAccount: vatCodes.inputVatAccount,
      costAccount: vatCodes.costAccount,
      baseAccount: vatCodes.baseAccount,
      baseCounterAccount: vatCodes.baseCounterAccount,
    })
    .from(vatCodes)
    .where(eq(vatCodes.code, code));
  if (!row) throw new Error(`vat_codes has no ${code}`);
  return row;
}

// Every row back to the catalog's defaults (what the migration seeds with no
// posting settings in system_settings).
export async function resetVatCodes(): Promise<void> {
  for (const entry of VAT_CODE_CATALOG) {
    await db
      .update(vatCodes)
      .set({
        name: entry.label,
        invoiceText: entry.invoiceText,
        active: true,
        revenueAccount: entry.slots.revenue?.account ?? null,
        outputVatAccount: entry.slots.outputVat?.account ?? null,
        inputVatAccount: entry.slots.inputVat?.account ?? null,
        costAccount: entry.slots.cost?.account ?? null,
        baseAccount: entry.slots.base?.account ?? null,
        baseCounterAccount: entry.slots.baseCounter?.account ?? null,
      })
      .where(eq(vatCodes.code, entry.code));
  }
}
