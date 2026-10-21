// Aviseringar: the three system settings the alerts read — the digest's
// send time, the "supplier invoices due within N days" window and Navs
// adress for the links in the digest mail. A leaf like plan-settings.ts:
// keys, defaults and decodes live here so the settings page, the readers
// and the digest job can never read a value differently.
export const ALERT_DIGEST_TIME_KEY = "alert_digest_time";
export const ALERT_SUPPLIER_INVOICE_DAYS_KEY = "alert_supplier_invoice_days";
export const PUBLIC_BASE_URL_KEY = "public_base_url";

export const DEFAULT_ALERT_DIGEST_TIME = "07:00";
export const DEFAULT_ALERT_SUPPLIER_INVOICE_DAYS = 7;
export const MAX_ALERT_SUPPLIER_INVOICE_DAYS = 60;

export const DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// Absent or junk ⇒ the default.
export function decodeAlertDigestTime(raw: string | null | undefined): string {
  return raw != null && DIGEST_TIME_PATTERN.test(raw) ? raw : DEFAULT_ALERT_DIGEST_TIME;
}

// Absent or junk ⇒ the default; clamped to the schema's range so a stored
// out-of-range value can never widen the window.
export function decodeAlertSupplierInvoiceDays(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_ALERT_SUPPLIER_INVOICE_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_ALERT_SUPPLIER_INVOICE_DAYS) {
    return DEFAULT_ALERT_SUPPLIER_INVOICE_DAYS;
  }
  return parsed;
}

// "" = not configured (the digest is sent without links). A trailing slash
// is dropped so hrefs can be appended as they are.
export function decodePublicBaseUrl(raw: string | null | undefined): string {
  if (raw == null) return "";
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return "";
  return trimmed.replace(/\/+$/, "");
}
