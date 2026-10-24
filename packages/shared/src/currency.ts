import { z } from "zod";
import { businessDateSchema } from "./business-date.js";
import { listQuerySchema } from "./list.js";

// Valuta (bokföringsgranskningen etapp 2). The ONE place amounts in a foreign
// currency are converted to SEK — the supplier invoice posting, the payment
// registration's frigjort SEK, the reskontra's SEK sums and (later) the
// customer side and the year-end revaluation all go through these functions,
// so two readers can never disagree by an öre about the same document.
//
// The document is facit in its own currency and the bookkeeping is in SEK: a
// document carries a rate (SEK per 1 unit of its currency, numeric(14,6)),
// SEK documents have rate 1 and behave exactly as before the feature.
//
// Arithmetic is EXACT: amounts are öre (two decimals) and rates micro-units
// (six decimals), multiplied as BigInt and rounded half away from zero —
// the same result as Postgres' round(amount * rate, 2), and symmetric for the
// negative amounts of a credit note (a float round2 is not: round2(-1.005)
// is -1).

export const SEK = "SEK";

// ISO 4217: three letters, normalized to upper case.
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Must be a three-letter currency code");

// SEK per 1 unit of the currency. numeric(14,6): positive, six decimals at
// most (rounded, so a typed 11.1310004 is stored as 11.131).
export const exchangeRateValueSchema = z.coerce
  .number()
  .positive()
  .max(99_999_999)
  .transform((value) => Math.round(value * 1e6) / 1e6)
  .refine((value) => value > 0, "Must be at least 0.000001");

const MICRO_PER_UNIT = 1_000_000n;

function ore(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

function micro(rate: number): bigint {
  return BigInt(Math.round(rate * 1e6));
}

// Integer division rounded half away from zero.
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const rounded = (n % d) * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function fromOre(value: bigint): number {
  // -0 would print as "-0" in a few places; normalize.
  const n = Number(value) / 100;
  return n === 0 ? 0 : n;
}

// The SEK value of an amount at a rate, to the öre.
export function toSek(amount: number, rate: number): number {
  return fromOre(divideRounded(ore(amount) * micro(rate), MICRO_PER_UNIT));
}

// The amount in a document currency that a SEK amount is worth at the
// document's rate (SEK per 1 unit), to the öre — the other direction of
// toSek: an article's försäljningspris (SEK, up to four decimals), the
// configurator's price additions and a freight row's kundpris on an order in
// EUR. Exact like toSek (the SEK amount is read at four decimals, the rate at
// six), rounded half away from zero. SEK (rate 1) returns the amount to the
// öre.
export function fromSek(amountSek: number, rate: number): number {
  const m = micro(rate);
  if (m <= 0n) throw new Error("A rate must be positive");
  // amount × 10^4 (four decimals) × 10^6 / (rate × 10^6 × 100) = öre.
  return fromOre(divideRounded(BigInt(Math.round(amountSek * 1e4)) * MICRO_PER_UNIT, m * 100n));
}

// Kundfakturans SEK-belopp — the customer side of the restmetod
// (documentSekAmounts): the receivable is exactly toSek(brutto), the VAT
// exactly toSek(Σ moms), and every row's net and VAT their own toSek. What
// the rows leave over in öre goes on the row with the largest net (the net
// remainder) and on the row with the largest VAT (the VAT remainder — never
// a 0 % row, which has no VAT to carry it), so the verification balances and
// every ledger total is the toSek of the document's own total. Amounts are
// as stored (positive, also on a credit note). For SEK (rate 1) every figure
// equals the document's own.
export type InvoiceSekAmounts = {
  grossAmount: number;
  vatAmount: number;
  netAmount: number;
  rows: { lineAmount: number; vatAmount: number }[];
};

export function invoiceSekAmounts(input: {
  rate: number;
  rows: { lineAmount: number; vatAmount: number }[];
}): InvoiceSekAmounts {
  const gross = input.rows.reduce((sum, row) => sum + ore(row.lineAmount) + ore(row.vatAmount), 0n);
  const vat = input.rows.reduce((sum, row) => sum + ore(row.vatAmount), 0n);
  const doc = documentSekAmounts({
    rate: input.rate,
    grossAmount: fromOre(gross),
    vatAmount: fromOre(vat),
    rows: input.rows.map((row) => row.lineAmount),
  });
  const lines = doc.rows.map((amount) => ore(amount));
  const vats = input.rows.map((row) => ore(toSek(row.vatAmount, input.rate)));
  const largest = (values: number[]) => {
    let index = -1;
    values.forEach((value, i) => {
      if (index === -1 || Math.abs(value) > Math.abs(values[index]!)) index = i;
    });
    return index;
  };
  const netRemainder = ore(doc.remainder);
  if (netRemainder !== 0n) {
    const i = largest(input.rows.map((row) => row.lineAmount));
    if (i >= 0) lines[i] = lines[i]! + netRemainder;
  }
  const vatRemainder = ore(doc.vatAmount) - vats.reduce((sum, value) => sum + value, 0n);
  if (vatRemainder !== 0n) {
    const i = largest(input.rows.map((row) => row.vatAmount));
    if (i >= 0) vats[i] = vats[i]! + vatRemainder;
  }
  return {
    grossAmount: doc.grossAmount,
    vatAmount: doc.vatAmount,
    netAmount: doc.netAmount,
    rows: input.rows.map((_, i) => ({ lineAmount: fromOre(lines[i]!), vatAmount: fromOre(vats[i]!) })),
  };
}

// part / whole × wholeSek, to the öre — the proportional SEK share of a part
// of a document whose SEK total is already fixed (a partial payment of an
// invoice whose gross_amount_sek was stamped at attest).
export function sekShare(part: number, whole: number, wholeSek: number): number {
  const w = ore(whole);
  if (w === 0n) return 0;
  return fromOre(divideRounded(ore(part) * ore(wholeSek), w));
}

// Leverantörsfakturans SEK-belopp — the restmetod: the debt is exactly
// toSek(brutto), the VAT toSek(moms), every row toSek(rad), and whatever the
// rows do not explain is the remainder (skuld − moms) − Σ rader, so the
// verification always balances and the debt is always exactly toSek(brutto).
// For SEK (rate 1) every figure equals the document's own.
export type DocumentSekAmounts = {
  grossAmount: number;
  vatAmount: number;
  netAmount: number;
  rows: number[];
  remainder: number;
};

export function documentSekAmounts(input: {
  rate: number;
  grossAmount: number;
  vatAmount: number;
  rows: number[];
}): DocumentSekAmounts {
  const grossAmount = toSek(input.grossAmount, input.rate);
  const vatAmount = toSek(input.vatAmount, input.rate);
  const netAmount = fromOre(ore(grossAmount) - ore(vatAmount));
  const rows = input.rows.map((amount) => toSek(amount, input.rate));
  const rowTotal = rows.reduce((sum, amount) => sum + ore(amount), 0n);
  return { grossAmount, vatAmount, netAmount, rows, remainder: fromOre(ore(netAmount) - rowTotal) };
}

// Frigjort SEK — what one payment row takes off the invoice's SEK debt
// (gross_amount_sek, stamped at attest):
//
//   * a row that SETTLES the invoice releases everything still booked:
//     gross_amount_sek − what earlier (non-cancelled) payments released, so
//     an invoice paid in any number of parts releases exactly its
//     gross_amount_sek;
//   * a partial payment releases its proportional share,
//     applied / brutto × gross_amount_sek.
//
// The write-off (tolerance rule, only on a settling row) takes its own
// proportional share and the applied part the rest. SEK invoices skip the
// arithmetic altogether: SEK released = the amounts themselves.
export function releasedSek(input: {
  currency: string;
  grossAmount: number;
  grossAmountSek: number;
  previouslyReleasedSek: number;
  appliedAmount: number;
  writeOffAmount: number;
  settles: boolean;
}): { appliedAmountSek: number; writeOffAmountSek: number } {
  if (input.currency === SEK) {
    return { appliedAmountSek: input.appliedAmount, writeOffAmountSek: input.writeOffAmount };
  }
  const writeOffAmountSek = input.writeOffAmount === 0 ? 0 : sekShare(input.writeOffAmount, input.grossAmount, input.grossAmountSek);
  if (input.settles) {
    const total = ore(input.grossAmountSek) - ore(input.previouslyReleasedSek);
    return { appliedAmountSek: fromOre(total - ore(writeOffAmountSek)), writeOffAmountSek };
  }
  return { appliedAmountSek: sekShare(input.appliedAmount, input.grossAmount, input.grossAmountSek), writeOffAmountSek };
}

// The payment tolerance (payment_tolerance, kr) in an invoice's own currency:
// what may be written off on a EUR invoice is what is worth at most the
// tolerance in SEK at the invoice's rate (5 kr at 11,13 = 0,44 EUR). Rounded
// DOWN to the öre so the write-off never exceeds the setting.
export function toleranceInCurrency(toleranceSek: number, rate: number, currency: string): number {
  if (currency === SEK) return toleranceSek;
  const m = micro(rate);
  if (m <= 0n) return 0;
  // öre(tolerance) × 10^6 / rate_micro, truncated.
  return fromOre((ore(toleranceSek) * MICRO_PER_UNIT) / m);
}

// What a payment's SEK bank movement leaves over after the SEK it released:
// amount_sek − bank_fee_sek − Σ frigjort SEK (applied part). Positive = we
// paid more SEK than the debt was booked at = kursförlust; negative =
// kursvinst. Exposed on the payment card as exchangeRateDifferenceSek with
// the opposite sign (positive = vinst), which is how it reads to a user.
export function paymentExchangeDifference(input: {
  amountSek: number;
  bankFeeSek: number;
  appliedAmountsSek: number[];
}): number {
  const applied = input.appliedAmountsSek.reduce((sum, amount) => sum + ore(amount), 0n);
  return fromOre(ore(input.amountSek) - ore(input.bankFeeSek) - applied);
}

// The customer side of paymentExchangeDifference: an incoming payment
// releases Σ frigjort SEK (applied part) from the receivable, while the bank
// account got amount_sek (the bank's movement — what landed on it, or for a
// refund left it) and the bank kept bank_fee_sek. Positive = less SEK came
// in than the receivable was booked at = kursförlust; negative = kursvinst.
// Exposed on the payment card as exchangeRateDifferenceSek with the opposite
// sign (positive = vinst), like the supplier side.
export function receiptExchangeDifference(input: {
  amountSek: number;
  bankFeeSek: number;
  appliedAmountsSek: number[];
}): number {
  const applied = input.appliedAmountsSek.reduce((sum, amount) => sum + ore(amount), 0n);
  return fromOre(applied - ore(input.amountSek) - ore(input.bankFeeSek));
}

// Valutaomvärdering (årsbokslutet): one open invoice in another currency
// valued at the balance day's rate — revalued SEK = toSek(open amount, rate),
// difference = revalued − the open SEK value booked for it, to the öre.
// Signs follow the reskontra (+ = the customer owes us / we owe): a positive
// difference on a receivable is a kursvinst, on a payable a kursförlust.
export function revaluationDifference(openAmount: number, bookedSek: number, rate: number): { revaluedSek: number; difference: number } {
  const revaluedSek = toSek(openAmount, rate);
  return { revaluedSek, difference: fromOre(ore(revaluedSek) - ore(bookedSek)) };
}

// --- Valutakurser (exchange_rates) ---

// Where a stored rate came from: fetched from Sveriges Riksbank (SWEA) or
// entered by hand (Ekonomi → Valutakurser, POST /exchange-rates).
export const EXCHANGE_RATE_SOURCES = ["riksbank", "manual"] as const;
export type ExchangeRateSource = (typeof EXCHANGE_RATE_SOURCES)[number];

// System setting exchange_rate_source: riksbank (default) = look the rate up
// at Riksbanken (manual rates for the exact day win, and cover currencies
// Riksbanken does not publish); manual = only the manual rates.
export const exchangeRateModeSchema = z.enum(["riksbank", "manual"]);
export type ExchangeRateMode = z.infer<typeof exchangeRateModeSchema>;

// Where a document's own rate came from (supplier_invoices.exchange_rate_source,
// null for SEK): Riksbanken, the Valutakurser register (a manual rate looked
// up automatically), typed on the document itself, or the linked purchase
// order's rate (the fallback when no rate could be looked up). Only a rate
// typed on the document is never looked up again when the document date
// changes.
export const DOCUMENT_RATE_SOURCES = ["riksbank", "register", "manual", "purchase_order"] as const;
export type DocumentRateSource = (typeof DOCUMENT_RATE_SOURCES)[number];

// GET /exchange-rates?currency&date — the rate for the date: the latest
// banking day ≤ date (Riksbanken publishes none for weekends and holidays).
export const exchangeRateQuerySchema = z.object({
  currency: currencyCodeSchema,
  date: businessDateSchema,
});
export type ExchangeRateQuery = z.infer<typeof exchangeRateQuerySchema>;

export const listExchangeRatesQuerySchema = listQuerySchema.extend({
  currency: currencyCodeSchema.optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
  source: z.enum(EXCHANGE_RATE_SOURCES).optional(),
});
export type ListExchangeRatesQuery = z.infer<typeof listExchangeRatesQuerySchema>;

// POST /exchange-rates — a manual rate (replaces an earlier manual rate for
// the same currency and day). SEK has no rate to enter.
export const createExchangeRateSchema = z.object({
  currency: currencyCodeSchema.refine((value) => value !== SEK, "SEK always has rate 1"),
  date: businessDateSchema,
  rate: exchangeRateValueSchema,
});
export type CreateExchangeRateInput = z.infer<typeof createExchangeRateSchema>;

// POST /exchange-rates/fetch — Hämta från Riksbanken for an interval (one
// call to Riksbanken, every published day stored). At most 93 days.
export const fetchExchangeRatesSchema = z
  .object({
    currency: currencyCodeSchema.refine((value) => value !== SEK, "SEK always has rate 1"),
    from: businessDateSchema,
    to: businessDateSchema,
  })
  .refine((value) => value.from <= value.to, { message: "from must not be after to", path: ["from"] })
  .refine(
    (value) => (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 <= 93,
    { message: "At most 93 days at a time", path: ["to"] }
  );
export type FetchExchangeRatesInput = z.infer<typeof fetchExchangeRatesSchema>;

// GET/PATCH /exchange-rate-settings (admin). The API key is write-only:
// "" keeps the stored key, null removes it; GET answers apiKeySet.
export const updateExchangeRateSettingsSchema = z
  .object({
    source: exchangeRateModeSchema.optional(),
    apiKey: z.string().trim().max(200).nullable().optional(),
  })
  .strict();
export type UpdateExchangeRateSettingsInput = z.infer<typeof updateExchangeRateSettingsSchema>;
