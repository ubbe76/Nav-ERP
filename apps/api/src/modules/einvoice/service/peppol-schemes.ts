// Peppol participant identifier schemes (ISO 6523 ICD) per country — pure,
// no DB imports. Spec 2026-11-05-e-faktura-utland-automatik: a customer
// without an own Peppol-id gets one derived from its organisation number
// ONLY where the country's national business register is the Peppol address
// (Peppol code list v9.7, all Active): SE 0007 organisationsnummer, NO 0192
// organisasjonsnummer, DK 0184 CVR-nummer, BE 0208 ondernemingsnummer. Every
// other country (Finland's 0216 OVT carries an optional suffix, Germany and
// the Netherlands have several schemes in use) needs the id typed on the
// customer — Kontrollera asks the directory in the customer's country.
//
// PEPPOL-COMMON-R040..R049 (fatal, schematron 3.0.22) check these schemes
// wherever they appear — EndpointID, PartyIdentification/ID and CompanyID —
// so identifierProblem() repeats them for ubl-check: a wrong check digit is
// refused in Nav with a sentence instead of by the access point.
import { isLuhnValid } from "@navet/shared";

interface CountryScheme {
  scheme: string;
  // The register number as Peppol writes it, or null when the stored
  // organisation number is not one.
  normalize(raw: string): string | null;
}

const digitsOf = (raw: string) => raw.replace(/\D/g, "");

// Swedish organisationsnummer: ten digits (a leading century "16" is
// tolerated and dropped). Null when it is anything else.
export function orgNumberDigits(raw: string | null | undefined): string | null {
  const digits = digitsOf(raw ?? "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("16")) return digits.slice(2);
  return null;
}

const exactDigits = (length: number) => (raw: string) => {
  const digits = digitsOf(raw);
  return digits.length === length ? digits : null;
};

const COUNTRY_SCHEMES: Readonly<Record<string, CountryScheme>> = {
  SE: { scheme: "0007", normalize: orgNumberDigits },
  // Organisasjonsnummer, nine digits ("NO 912 345 678 MVA" ⇒ 912345678).
  NO: { scheme: "0192", normalize: exactDigits(9) },
  // CVR-nummer, eight digits ("DK12345678").
  DK: { scheme: "0184", normalize: exactDigits(8) },
  // Ondernemingsnummer, ten digits starting with 0 or 1 ("0123.456.789");
  // the old nine-digit form gets its leading 0.
  BE: {
    scheme: "0208",
    normalize: (raw) => {
      const digits = digitsOf(raw);
      const ten = digits.length === 9 ? `0${digits}` : digits;
      return /^[01]\d{9}$/.test(ten) ? ten : null;
    },
  },
};

const countryOf = (country: string | null | undefined) => (country ?? "").trim().toUpperCase();

// The scheme an organisation number of this country is written with, null
// when Nav does not know one.
export function orgNumberScheme(country: string | null | undefined): string | null {
  return COUNTRY_SCHEMES[countryOf(country)]?.scheme ?? null;
}

// The organisation number as the country's scheme writes it (SE: ten digits),
// null without a known scheme or when the number does not fit it.
export function normalizedOrgNumber(country: string | null | undefined, raw: string | null | undefined): string | null {
  const entry = COUNTRY_SCHEMES[countryOf(country)];
  if (!entry || !raw?.trim()) return null;
  return entry.normalize(raw);
}

// "scheme:value" derived from the organisation number, or null.
export function derivedPeppolId(country: string | null | undefined, orgNumber: string | null | undefined): string | null {
  const scheme = orgNumberScheme(country);
  const value = normalizedOrgNumber(country, orgNumber);
  return scheme && value ? `${scheme}:${value}` : null;
}

// GS1 mod 10 (u:gln): weights 3,1,3,… from the right over all but the check digit.
function glnValid(value: string): boolean {
  const body = value.slice(0, -1).split("").reverse().map(Number);
  const sum = body.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(value.slice(-1));
}

// Norwegian mod 11 (u:mod11): weights 3,2,7,6,5,4,3,2 from the left.
function mod11Valid(value: string): boolean {
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(value[i]), 0);
  return Number(value) > 0 && (11 - (sum % 11)) % 11 === Number(value[8]);
}

// Belgian mod 97 (u:mod97-0208), first digit 0 or 1 (code list).
function mod97Valid(value: string): boolean {
  return /^[01]/.test(value) && 97 - (Number(value.slice(0, 8)) % 97) === Number(value.slice(8));
}

const IDENTIFIER_RULES: Record<string, { pattern: RegExp; check?: (v: string) => boolean; what: string }> = {
  "0007": { pattern: /^\d{10}$/, check: isLuhnValid, what: "ett svenskt organisationsnummer med tio siffror och rätt kontrollsiffra" },
  "0088": { pattern: /^\d{13}$/, check: glnValid, what: "ett GLN med 13 siffror och rätt kontrollsiffra" },
  "0192": { pattern: /^\d{9}$/, check: mod11Valid, what: "ett norskt organisationsnummer med nio siffror och rätt kontrollsiffra" },
  "0184": { pattern: /^(DK)?\d{8}$/, what: "ett danskt CVR-nummer med åtta siffror" },
  "0208": { pattern: /^\d{10}$/, check: mod97Valid, what: "ett belgiskt företagsnummer med tio siffror och rätt kontrollsiffror" },
};

// Why a value is not a valid identifier in the scheme (Swedish, for
// ubl-check), or null when it is — or when Nav does not know the scheme's
// format (the access point then judges).
export function identifierProblem(scheme: string, value: string): string | null {
  const rule = IDENTIFIER_RULES[scheme.trim()];
  if (!rule) return null;
  const v = value.trim();
  if (!rule.pattern.test(v) || (rule.check && !rule.check(v))) return rule.what;
  return null;
}

// Countries whose Peppol-id Nav derives — the customer card's hint.
export const DERIVED_PEPPOL_COUNTRIES = Object.keys(COUNTRY_SCHEMES);
