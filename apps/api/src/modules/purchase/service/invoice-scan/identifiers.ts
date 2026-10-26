import { BIC_PATTERN, EU_COUNTRY_CODES, isLuhnValid, isValidIban } from "@navet/shared";

// Fakturaskanning — the identifiers a Swedish supplier invoice prints, found
// in a line of text (spec §3.3 punkt 1). Pure: no DB, no pdf. Every finder
// returns NORMALIZED values (digits only, or upper case without spaces) so
// they compare directly with the supplier register's columns.

// The VAT prefixes of the other EU countries (Greece is EL, Northern
// Ireland XI). SE has its own, stricter pattern.
const FOREIGN_VAT_PREFIXES = [
  ...EU_COUNTRY_CODES.filter((code) => code !== "SE" && code !== "GR"),
  "EL",
  "XI",
];

const ORG_LABEL = /org(?:anisations)?\.?\s*-?\s*n(?:umme)?r|org\.?\s*nr|organisationsnummer|corporate id|reg\.?\s*no/i;
const BANKGIRO_LABEL = /bankgiro|\bbg\b|\bbg-?nr/i;
const PLUSGIRO_LABEL = /plusgiro|postgiro|\bpg\b|\bpg-?nr/i;
const BIC_LABEL = /\bbic\b|\bswift\b/i;

// Ten digits as a Swedish organisationsnummer (a leading century "16" is
// dropped) — null when it is anything else. Matches the register's
// orgNumberDigits.
export function normalizeOrgNumber(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && (digits.startsWith("16") || digits.startsWith("19") || digits.startsWith("20"))) return digits.slice(2);
  return null;
}

export function isValidOrgNumber(digits: string): boolean {
  return /^\d{10}$/.test(digits) && isLuhnValid(digits);
}

export function normalizeVatNumber(raw: string | null | undefined): string | null {
  const value = (raw ?? "").replace(/[\s.-]/g, "").toUpperCase();
  return value === "" ? null : value;
}

export function normalizeIban(raw: string | null | undefined): string | null {
  const value = (raw ?? "").replace(/\s/g, "").toUpperCase();
  return value === "" ? null : value;
}

export function normalizeGiro(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits === "" ? null : digits;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// Organisationsnummer: NNNNNN-NNNN anywhere, ten bare digits only on a line
// that names it — Luhn over the ten digits either way.
export function findOrgNumbers(line: string): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(/(?<![\d-])(\d{6})-(\d{4})(?![\d-])/g)) found.push(m[1]! + m[2]!);
  if (ORG_LABEL.test(line)) {
    for (const m of line.matchAll(/(?<!\d)(\d{10})(?!\d)/g)) found.push(m[1]!);
  }
  return unique(found.filter(isValidOrgNumber));
}

// Svenskt momsregistreringsnummer: SE + the organisationsnummer + 01.
export function findSwedishVatNumbers(line: string): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(/(?<![A-Z0-9])SE\s?(\d{6})[\s-]?(\d{4})\s?01(?!\d)/g)) {
    const digits = m[1]! + m[2]!;
    if (isValidOrgNumber(digits)) found.push(`SE${digits}01`);
  }
  return unique(found);
}

// Another EU country's VAT number: its prefix + 2–13 characters with at
// least two digits (case-sensitive, so ordinary words never match).
export function findForeignVatNumbers(line: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`(?<![A-Za-z0-9])(${FOREIGN_VAT_PREFIXES.join("|")})\\s?((?=[0-9A-Z]*\\d[0-9A-Z]*\\d)[0-9A-Z]{2,13})(?![A-Za-z0-9])`, "g");
  for (const m of line.matchAll(pattern)) found.push(m[1]! + m[2]!);
  return unique(found);
}

// The text after the first match of a label — where a giro number stands
// when one line carries several ("Bankgiro 123-4567  Plusgiro 12 34 56-7").
function afterLabel(line: string, label: RegExp): string | null {
  const m = label.exec(line);
  return m ? line.slice(m.index + m[0].length) : null;
}

// Bankgiro: NNN-NNNN or NNNN-NNNN after a bankgiro label, Luhn.
export function findBankgiros(line: string): string[] {
  const rest = afterLabel(line, BANKGIRO_LABEL);
  if (rest === null) return [];
  const m = /(?<![\d-])(\d{3,4})-(\d{4})(?![\d-])/.exec(rest);
  if (!m) return [];
  const digits = m[1]! + m[2]!;
  return isLuhnValid(digits) ? [digits] : [];
}

// Plusgiro: up to eight digits (often grouped "12 34 56-7") ending in -N
// after a plusgiro label, Luhn.
export function findPlusgiros(line: string): string[] {
  const rest = afterLabel(line, PLUSGIRO_LABEL);
  if (rest === null) return [];
  const m = /(?<![\d-])((?:\d[\s]?){1,7})-(\d)(?![\d-])/.exec(rest);
  if (!m) return [];
  const digits = m[1]!.replace(/\s/g, "") + m[2]!;
  return digits.length >= 2 && digits.length <= 8 && isLuhnValid(digits) ? [digits] : [];
}

// IBAN in groups of four or as one token, mod 97. The groups are tried from
// the longest run down, so a word after the number ("… 7890 BIC") never
// spoils it.
export function findIbans(line: string): string[] {
  const found: string[] = [];
  for (const m of line.toUpperCase().matchAll(/(?<![A-Z0-9])([A-Z]{2}\d{2})((?:\s?[A-Z0-9]{1,4}){3,9})/g)) {
    const groups = m[2]!.trim().split(/\s+/).flatMap((g) => g.match(/.{1,4}/g) ?? []);
    for (let k = groups.length; k >= 3; k--) {
      const iban = m[1]! + groups.slice(0, k).join("");
      if (isValidIban(iban)) {
        found.push(iban);
        break;
      }
    }
  }
  return unique(found);
}

export function findBics(line: string): string[] {
  const rest = afterLabel(line, BIC_LABEL);
  if (rest === null) return [];
  const found: string[] = [];
  for (const m of rest.matchAll(/(?<![A-Z0-9])([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)(?![A-Z0-9])/g)) {
    if (BIC_PATTERN.test(m[1]!)) found.push(m[1]!);
  }
  return unique(found);
}

// OCR (Bankgirot's reference): 2–25 digits with a valid mod 10 check digit.
export function isValidOcr(digits: string): boolean {
  return /^\d{2,25}$/.test(digits) && isLuhnValid(digits);
}
