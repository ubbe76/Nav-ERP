// Periodisk sammanställning via fil (Skatteverket, "Lämna periodisk
// sammanställning med filöverföring", SKV 574008). Pure builder — the
// service supplies the reporter and the aggregated rows; the unit test pins
// the output against the page's example rows.
//
// The page's rules: row 1 is the identifier, row 2 the reporter (12-digit
// momsregistreringsnummer, ÅÅMM or ÅÅ-K, contact name at most 35 characters,
// phone at most 17 characters — digits with a hyphen after the area code or
// a leading + — and an optional e-mail), then one row per buyer: the VAT
// number with its country prefix, goods, trepartshandel, services. An unused
// column is an empty field, a column that nets to zero is 0, a negative
// amount has a leading minus, and an amount may have at most 12 characters
// including the minus. Every buyer row ends with a semicolon like the
// page's examples ("FI01409351;16400;;;"). CRLF, ISO-8859-1, no blank lines.

export class PeriodicSummaryAmountTooLargeError extends Error {
  constructor(vatNumber: string, amount: number) {
    super(`Beloppet ${amount} för ${vatNumber} har fler än 12 tecken — det går inte att lämna i filen`);
    this.name = "PeriodicSummaryAmountTooLargeError";
  }
}

export const PERIODIC_SUMMARY_FILE_IDENTIFIER = "SKV574008";
const MAX_AMOUNT_CHARS = 12;
const MAX_CONTACT_NAME = 35;
const MAX_PHONE = 17;

// The reporter's momsregistreringsnummer as row 2 wants it: the twelve
// digits (organisationsnummer + 01) without SE. Anything else is null — the
// caller reports the field as missing.
export function reporterVatDigits(raw: string | null | undefined): string | null {
  const normalized = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digits = normalized.startsWith("SE") ? normalized.slice(2) : normalized;
  return /^\d{12}$/.test(digits) ? digits : null;
}

// Spaces removed, then digits with at most one hyphen (after the area code)
// and an optional leading + (a foreign number), at most 17 characters. null =
// missing or not in the format.
export function normalizeContactPhone(raw: string | null | undefined): string | null {
  const phone = (raw ?? "").replace(/\s+/g, "");
  if (phone === "" || phone.length > MAX_PHONE) return null;
  return /^\+?\d+(-\d+)?$/.test(phone) ? phone : null;
}

// The contact name as a field: semicolons (the file's separator) and control
// characters become spaces, runs of spaces collapse. null = missing or
// longer than 35 characters.
export function contactNameField(raw: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const name = (raw ?? "").replace(/[;\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name === "" || name.length > MAX_CONTACT_NAME) return null;
  return name;
}

// The optional e-mail as a field: whitespace and semicolons cannot be part
// of an address, so they are dropped.
function emailField(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[\s;]/g, "");
}

// Letters and digits only in the name, as the page asks.
export function periodicSummaryFileName(fileSuffix: string): string {
  return `PeriodiskSammanstallning${fileSuffix.replace(/[^A-Za-z0-9]/g, "")}.txt`;
}

export type PeriodicSummaryFileRow = {
  vatNumber: string;
  // null = the buyer has no rows in the column (empty field).
  goods: number | null;
  services: number | null;
};

export type PeriodicSummaryFileInput = {
  reporterVatDigits: string;
  periodCode: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  rows: PeriodicSummaryFileRow[];
};

function amountField(vatNumber: string, amount: number | null): string {
  if (amount === null) return "";
  if (!Number.isInteger(amount)) throw new Error(`The periodisk sammanställning takes whole kronor, got ${amount}`);
  // `${-0}` is "0" — no stray minus.
  const text = String(amount === 0 ? 0 : amount);
  if (text.length > MAX_AMOUNT_CHARS) throw new PeriodicSummaryAmountTooLargeError(vatNumber, amount);
  return text;
}

// ISO-8859-1 without throwing: a character outside latin1 (only the contact
// name can carry one) becomes "?".
function latin1(text: string): Buffer {
  let safe = "";
  for (const ch of text) safe += ch.codePointAt(0)! <= 0xff ? ch : "?";
  return Buffer.from(safe, "latin1");
}

export function buildPeriodicSummaryFile(input: PeriodicSummaryFileInput): Buffer {
  const lines = [
    `${PERIODIC_SUMMARY_FILE_IDENTIFIER};`,
    [input.reporterVatDigits, input.periodCode, input.contactName, input.contactPhone, emailField(input.contactEmail)].join(";"),
    ...input.rows.map(
      (row) => `${row.vatNumber};${amountField(row.vatNumber, row.goods)};;${amountField(row.vatNumber, row.services)};`
    ),
  ];
  return latin1(lines.map((line) => `${line}\r\n`).join(""));
}
