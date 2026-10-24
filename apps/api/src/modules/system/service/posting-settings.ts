import { inArray } from "drizzle-orm";
import { systemSettings, type Db, type Tx } from "@navet/db";

// Automatic accounting (Ekonomi → automatkontering) — BAS-styled 4-digit
// posting accounts, plus B3's kundreskontra amount settings (payment
// tolerance and reminder fee). Leaf module (system/service/posting-settings,
// same Db|Tx-composable shape as number-series.ts's getNextOrderNumber): no
// dependency on system.repository or system.service, so the economy module's
// verification-poster can read these through the CALLER's own transaction
// (see verification-poster.ts's postCustomerInvoice/postSupplierInvoice)
// instead of a separate connection outside the posting's consistency
// boundary.
//
// This module OWNS the posting-settings key constants and their defaults —
// the one source of truth both readPostingSettings (below) and
// system.service.ts's getSettings()/updateSettings() build on, so the key
// strings and BAS-standard defaults are never duplicated. The revenue and
// VAT accounts per rate are no longer settings: they belong to the momskoder
// (vat_codes), which migration 0142 seeded from the old keys.

export const POSTING_ACCOUNTS_RECEIVABLE_KEY = "posting_accounts_receivable";
export const POSTING_ACCOUNTS_PAYABLE_KEY = "posting_accounts_payable";
export const POSTING_DEFAULT_COST_KEY = "posting_default_cost";
// Kundreskontra (B3): the bank/betalkonto a customer payment is debited
// against, the account a reminder fee is credited to, and the account for
// öres-/kronutjämning (payment write-offs within tolerance).
export const POSTING_BANK_KEY = "posting_bank";
export const POSTING_REMINDER_FEE_ACCOUNT_KEY = "posting_reminder_fee_account";
export const POSTING_PAYMENT_WRITEOFF_KEY = "posting_payment_writeoff";
// Momsrapport (B5): redovisningskonto för moms — the account the
// momsomföring nets the period's VAT accounts onto.
export const POSTING_VAT_SETTLEMENT_KEY = "posting_vat_settlement";
// Årsbokslut (steg 2): the inventory account the lagerförändring adjusts and
// its counter account. One account by design (spec 4.3).
export const POSTING_INVENTORY_KEY = "posting_inventory";
export const POSTING_INVENTORY_CHANGE_KEY = "posting_inventory_change";
// How much a payment may miss the invoice's remaining amount by and still
// count as fully paid (kr), and the fee charged per payment reminder (kr).
export const PAYMENT_TOLERANCE_KEY = "payment_tolerance";
export const REMINDER_FEE_KEY = "reminder_fee";

export const POSTING_SETTINGS_KEYS = [
  POSTING_ACCOUNTS_RECEIVABLE_KEY,
  POSTING_ACCOUNTS_PAYABLE_KEY,
  POSTING_DEFAULT_COST_KEY,
  POSTING_BANK_KEY,
  POSTING_REMINDER_FEE_ACCOUNT_KEY,
  POSTING_PAYMENT_WRITEOFF_KEY,
  POSTING_VAT_SETTLEMENT_KEY,
  POSTING_INVENTORY_KEY,
  POSTING_INVENTORY_CHANGE_KEY,
  PAYMENT_TOLERANCE_KEY,
  REMINDER_FEE_KEY,
] as const;

export interface PostingSettings {
  postingAccountsReceivable: string;
  postingAccountsPayable: string;
  postingDefaultCost: string;
  postingBank: string;
  postingReminderFeeAccount: string;
  postingPaymentWriteOff: string;
  postingVatSettlement: string;
  postingInventory: string;
  postingInventoryChange: string;
  paymentTolerance: number;
  reminderFee: number;
}

// PAXml löneart codes and posting-account codes are stored as plain
// strings — an absent key (never configured) or an explicitly blanked one
// both fall back to the Monitor-like/BAS-standard default rather than
// exporting/posting against an empty code. MOVED here from
// system.service.ts, which re-imports it — used for the PAXml codes too, not
// just posting.
export function codeSetting(value: string | null, fallback: string): string {
  return value === null || value === "" ? fallback : value;
}

// Amount settings (kr) round-trip as numbers but are stored as strings, like
// every other system_settings value. An absent key, a blanked one, or a
// stored value that no longer parses as a finite number all fall back to the
// default rather than leaking NaN into a calculation.
function amountSetting(value: string | null, fallback: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Pure decode over an already-fetched key→value lookup. Shared by
// readPostingSettings (its own tx-scoped select, below) and
// system.service.ts's getSettings() (which already has every settings row
// from ONE repo.getAllSettings() call) — so the BAS-standard/kundreskontra
// defaults live in exactly one place regardless of which query fetched the
// rows.
export function decodePostingSettings(get: (key: string) => string | null): PostingSettings {
  return {
    postingAccountsReceivable: codeSetting(get(POSTING_ACCOUNTS_RECEIVABLE_KEY), "1510"),
    postingAccountsPayable: codeSetting(get(POSTING_ACCOUNTS_PAYABLE_KEY), "2440"),
    postingDefaultCost: codeSetting(get(POSTING_DEFAULT_COST_KEY), "4010"),
    postingBank: codeSetting(get(POSTING_BANK_KEY), "1930"),
    postingReminderFeeAccount: codeSetting(get(POSTING_REMINDER_FEE_ACCOUNT_KEY), "3540"),
    postingPaymentWriteOff: codeSetting(get(POSTING_PAYMENT_WRITEOFF_KEY), "3740"),
    postingVatSettlement: codeSetting(get(POSTING_VAT_SETTLEMENT_KEY), "2650"),
    postingInventory: codeSetting(get(POSTING_INVENTORY_KEY), "1460"),
    postingInventoryChange: codeSetting(get(POSTING_INVENTORY_CHANGE_KEY), "4990"),
    paymentTolerance: amountSetting(get(PAYMENT_TOLERANCE_KEY), 5.0),
    reminderFee: amountSetting(get(REMINDER_FEE_KEY), 60.0),
  };
}

// ONE inArray select over system_settings — the batched replacement for 16
// separate repo.getSetting() round trips. Takes a Db or a Tx: called from
// inside the caller's own transaction (the poster) as well as standalone, the
// same Db|Tx-composable seam as number-series.ts's getNextOrderNumber and
// stock's resolveStockLocation.
export async function readPostingSettings(executor: Db | Tx): Promise<PostingSettings> {
  const rows = await executor
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, POSTING_SETTINGS_KEYS));
  const byKey = new Map(rows.map((row) => [row.key, row.value] as const));
  return decodePostingSettings((key) => byKey.get(key) ?? null);
}
