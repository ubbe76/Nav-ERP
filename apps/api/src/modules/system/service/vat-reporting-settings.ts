import { inArray, sql } from "drizzle-orm";
import { systemSettings, type Db, type Tx } from "@navet/db";
import {
  VAT_REPORTING_PERIODS,
  type UpdateVatReportingSettingsInput,
  type VatReportingPeriod,
  type VatReportingSettings,
} from "@navet/shared";

// Redovisningsperiod för moms and the contact the periodisk sammanställning
// file names (Momskoder). A leaf like posting-settings.ts — the economy
// module reads and writes the keys through it (GET/PATCH
// /settings/vat-reporting), so the key strings and defaults live in one
// place. Not part of GET /settings: the Ekonomi permission maintains them.
export const VAT_REPORTING_PERIOD_KEY = "vat_reporting_period";
export const VAT_CONTACT_NAME_KEY = "vat_contact_name";
export const VAT_CONTACT_PHONE_KEY = "vat_contact_phone";
export const VAT_CONTACT_EMAIL_KEY = "vat_contact_email";

const KEYS = [VAT_REPORTING_PERIOD_KEY, VAT_CONTACT_NAME_KEY, VAT_CONTACT_PHONE_KEY, VAT_CONTACT_EMAIL_KEY];

export const DEFAULT_VAT_REPORTING_PERIOD: VatReportingPeriod = "quarter";

function decodePeriod(raw: string | null): VatReportingPeriod {
  return (VAT_REPORTING_PERIODS as readonly string[]).includes(raw ?? "")
    ? (raw as VatReportingPeriod)
    : DEFAULT_VAT_REPORTING_PERIOD;
}

const blankToNull = (raw: string | null) => (raw === null || raw.trim() === "" ? null : raw);

export async function readVatReportingSettings(executor: Db | Tx): Promise<VatReportingSettings> {
  const rows = await executor
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, KEYS));
  const get = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  return {
    period: decodePeriod(get(VAT_REPORTING_PERIOD_KEY)),
    contactName: blankToNull(get(VAT_CONTACT_NAME_KEY)),
    contactPhone: blankToNull(get(VAT_CONTACT_PHONE_KEY)),
    contactEmail: blankToNull(get(VAT_CONTACT_EMAIL_KEY)),
  };
}

// Upserts the given fields; a cleared contact field is stored as "" (decoded
// back to null). Returns the keys actually written, for the audit entry.
export async function writeVatReportingSettings(
  executor: Db | Tx,
  input: UpdateVatReportingSettingsInput
): Promise<string[]> {
  const writes: [string, string][] = [];
  if (input.period !== undefined) writes.push([VAT_REPORTING_PERIOD_KEY, input.period]);
  if (input.contactName !== undefined) writes.push([VAT_CONTACT_NAME_KEY, input.contactName ?? ""]);
  if (input.contactPhone !== undefined) writes.push([VAT_CONTACT_PHONE_KEY, input.contactPhone ?? ""]);
  if (input.contactEmail !== undefined) writes.push([VAT_CONTACT_EMAIL_KEY, input.contactEmail ?? ""]);
  for (const [key, value] of writes) {
    await executor
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: sql`excluded.value` } });
  }
  return writes.map(([key]) => key);
}
