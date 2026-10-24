// Mirror of the arithmetic in packages/shared/src/currency.ts — the web can't
// import @navet/shared (see lib/units.ts). NO imports, so a test can load this
// file directly and compare it case by case with the shared functions. Display
// only: the server re-derives every figure inside its own row-locked
// transaction, this file just lets the forms preview what it will book.
//
// Arithmetic is EXACT: amounts are öre (two decimals) and rates micro-units
// (six decimals), multiplied as BigInt and rounded half away from zero — the
// same result as Postgres' round(amount * rate, 2), and symmetric for the
// negative amounts of a credit note (a float round2 is not).

export const SEK = "SEK";

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

// Leverantörsfakturans SEK-belopp — the restmetod: the debt is exactly
// toSek(brutto), the VAT toSek(moms), every row toSek(rad), and whatever the
// rows do not explain is the remainder. For SEK (rate 1) every figure equals
// the document's own.
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

// part / whole × wholeSek, to the öre.
export function sekShare(part: number, whole: number, wholeSek: number): number {
  const w = ore(whole);
  if (w === 0n) return 0;
  return fromOre(divideRounded(ore(part) * ore(wholeSek), w));
}

// What one payment row takes off the invoice's SEK debt (gross_amount_sek):
// a row that settles the invoice releases everything still booked, a partial
// payment its proportional share; the write-off takes its own share.
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

// The payment tolerance (kr) in an invoice's own currency — what is worth at
// most the tolerance in SEK at the invoice's rate, rounded DOWN to the öre.
export function toleranceInCurrency(toleranceSek: number, rate: number, currency: string): number {
  if (currency === SEK) return toleranceSek;
  const m = micro(rate);
  if (m <= 0n) return 0;
  return fromOre((ore(toleranceSek) * MICRO_PER_UNIT) / m);
}

// What a payment's SEK bank movement leaves over after the SEK it released:
// amount_sek − bank_fee_sek − Σ frigjort SEK. Positive = kursförlust, negative
// = kursvinst (the payment card shows the opposite sign: positive = vinst).
export function paymentExchangeDifference(input: {
  amountSek: number;
  bankFeeSek: number;
  appliedAmountsSek: number[];
}): number {
  const applied = input.appliedAmountsSek.reduce((sum, amount) => sum + ore(amount), 0n);
  return fromOre(ore(input.amountSek) - ore(input.bankFeeSek) - applied);
}

// --- Display helpers (web only) ---

// Suggestions for the currency fields (a datalist — any ISO 4217 code is
// accepted by the API, and Riksbanken publishes more than these).
export const COMMON_CURRENCIES = ["EUR", "USD", "GBP", "NOK", "DKK", "CHF", "JPY", "CNY", "PLN", "CZK", "HUF", "CAD", "AUD"] as const;

// "kr" for SEK, otherwise the ISO code — how amounts are written next to a
// document's own currency.
export function currencyLabel(currency: string): string {
  return currency === SEK ? "kr" : currency;
}

// Kursvinst/kursförlust text for a signed difference where POSITIVE = vinst
// (the API's exchangeRateDifferenceSek, and the preview's flipped
// paymentExchangeDifference).
export function exchangeDifferenceText(gainSek: number, format: (value: number) => string): string {
  if (gainSek === 0) return "Ingen kursdifferens";
  return gainSek > 0 ? `Kursvinst ${format(gainSek)} kr` : `Kursförlust ${format(Math.abs(gainSek))} kr`;
}

// A rate as it is written: up to six decimals, Swedish comma, no trailing
// zeros ("11,131" not "11,131000") but at least two decimals ("11,00").
export function formatRate(rate: number | string): string {
  const n = Number(rate);
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

// Where a document's rate came from, as shown next to the Kurs field
// ("Riksbanken 2026-10-23", "manuell", …).
export type DocumentRateSourceValue = "riksbank" | "register" | "manual" | "purchase_order";

export function documentRateSourceText(source: DocumentRateSourceValue | null, date: string | null): string | null {
  switch (source) {
    case "riksbank":
      return date ? `Riksbanken ${date}` : "Riksbanken";
    case "register":
      return date ? `egen kurs i Valutakurser ${date}` : "egen kurs i Valutakurser";
    case "manual":
      return "manuell";
    case "purchase_order":
      return "inköpsorderns kurs";
    default:
      return null;
  }
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
