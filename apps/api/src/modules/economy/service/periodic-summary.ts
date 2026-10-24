import {
  EU_COUNTRY_CODES,
  isEuCountry,
  normalizeVatNumber,
  vatNumberPrefix,
  type PeriodicSummaryInvoiceRef,
  type PeriodicSummaryRow,
  type PeriodicSummaryWarning,
} from "@navet/shared";

// Periodisk sammanställning (Momskoder steg 3) — the pure half: the period
// rule, the buyer's momsregistreringsnummer as reported, and the summing of
// the EU sales per buyer. No DB access; periodic-summary.service.ts feeds it
// the issued invoices' EUV/EUT amounts and the booked ruta 35/39.

export class PeriodicSummaryPeriodInvalidError extends Error {
  constructor(from: string, to: string) {
    super(`Perioden ${from} – ${to} är inte en kalendermånad eller ett kalenderkvartal`);
    this.name = "PeriodicSummaryPeriodInvalidError";
  }
}

export type PeriodicSummaryPeriod = {
  kind: "month" | "quarter";
  // ÅÅMM (month) or ÅÅ-K (quarter) — the file's row 2.
  periodCode: string;
  // ÅÅMM or ÅÅKx — the file name, letters and digits only.
  fileSuffix: string;
};

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Exactly one calendar month or one calendar quarter; anything else (a
// part month, a half year, to before from) is null.
export function periodicSummaryPeriod(from: string, to: string): PeriodicSummaryPeriod | null {
  const match = /^(\d{4})-(\d{2})-01$/.exec(from);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const yy = String(year % 100).padStart(2, "0");
  if (to === lastDayOfMonth(year, month)) {
    const mm = String(month).padStart(2, "0");
    return { kind: "month", periodCode: `${yy}${mm}`, fileSuffix: `${yy}${mm}` };
  }
  if ((month - 1) % 3 === 0 && to === lastDayOfMonth(year, month + 2)) {
    const quarter = (month - 1) / 3 + 1;
    return { kind: "quarter", periodCode: `${yy}-${quarter}`, fileSuffix: `${yy}K${quarter}` };
  }
  return null;
}

// The VAT number prefixes of the OTHER member states (Greece EL) — a
// Swedish buyer never belongs in the periodisk sammanställning.
const FOREIGN_EU_PREFIXES: readonly string[] = EU_COUNTRY_CODES.filter((country) => country !== "SE").map(vatNumberPrefix);
const VALID_BUYER_VAT_NUMBER = new RegExp(`^(${FOREIGN_EU_PREFIXES.join("|")})[A-Z0-9]{2,12}$`);
const ANY_EU_PREFIX: readonly string[] = [...FOREIGN_EU_PREFIXES, "SE"];

export type BuyerVatNumber =
  | { status: "ok"; vatNumber: string }
  | { status: "missing" }
  | { status: "invalid"; vatNumber: string };

// The buyer's number as Skatteverket wants it: normalized (upper case, A–Z
// and 0–9 only), Greece's GR written EL, and — for an invoice issued before
// Utfärda required the prefix — the customer's own country prefix added when
// the number starts with no member state's prefix. Valid = another member
// state's prefix followed by 2–12 characters (at most 14 in all).
// `customerCountry` is the customer's live country (customers.country).
export function buyerVatNumber(raw: string | null, customerCountry: string): BuyerVatNumber {
  let number = normalizeVatNumber(raw);
  if (number === "") return { status: "missing" };
  if (number.startsWith("GR")) number = `EL${number.slice(2)}`;
  const country = customerCountry.trim().toUpperCase();
  const hasPrefix = ANY_EU_PREFIX.some((prefix) => number.startsWith(prefix));
  if (!hasPrefix && country !== "SE" && isEuCountry(country)) number = `${vatNumberPrefix(country)}${number}`;
  return VALID_BUYER_VAT_NUMBER.test(number) ? { status: "ok", vatNumber: number } : { status: "invalid", vatNumber: number };
}

// One issued invoice's EUV or EUT amount (the sum of its rows with that code
// in SEK as the F verification booked them — line_amount_sek — positive also
// on a credit note).
export type EuSalesLine = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceType: "invoice" | "credit";
  // The invoice's snapshot of the buyer's number, as written.
  vatNumber: string | null;
  customerId: string;
  customerName: string;
  customerCountry: string;
  code: "EUV" | "EUT";
  amount: string | number;
};

// A summary row plus whether each column had any rows at all — the file
// writes an empty field for an unused column and 0 for one that nets to 0.
export type PeriodicSummaryAggregateRow = PeriodicSummaryRow & { goodsUsed: boolean; servicesUsed: boolean };

function toOre(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

// Hela kronor from an öre sum, half away from zero — integer arithmetic, so
// no float edge (50 öre ⇒ 1 kr, −50 öre ⇒ −1 kr).
export function oreToKronor(ore: number): number {
  const kronor = Math.floor((Math.abs(ore) + 50) / 100);
  return ore < 0 && kronor !== 0 ? -kronor : kronor;
}

// Plain-digit grouping for the Swedish warning texts ("−2 000" would need
// U+2212; a hyphen keeps the text ASCII).
export function formatKronor(kronor: number): string {
  const sign = kronor < 0 ? "-" : "";
  return `${sign}${String(Math.abs(kronor)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
}

// An öre amount as kronor with two decimals, Swedish style ("1 234,50",
// "-0,30") — the reconciliation compares öre, so its warning shows them.
export function formatOre(ore: number): string {
  const sign = ore < 0 ? "-" : "";
  const magnitude = Math.abs(ore);
  return `${sign}${formatKronor(Math.floor(magnitude / 100))},${String(magnitude % 100).padStart(2, "0")}`;
}

const byInvoiceNumber = (a: PeriodicSummaryInvoiceRef, b: PeriodicSummaryInvoiceRef) =>
  a.invoiceNumber.localeCompare(b.invoiceNumber, "sv");

type Accumulator = {
  vatNumber: string;
  customers: Map<string, string>;
  goodsOre: number;
  servicesOre: number;
  goodsUsed: boolean;
  servicesUsed: boolean;
  invoices: Map<string, string>;
};

type WarningGroup = { kind: PeriodicSummaryWarning["kind"]; message: string; sortKey: string; invoices: Map<string, string> };

const WARNING_ORDER: PeriodicSummaryWarning["kind"][] = ["missing_vat_number", "invalid_vat_number", "non_eu_country", "ledger_difference"];

function invoiceRefs(invoices: Map<string, string>): PeriodicSummaryInvoiceRef[] {
  return [...invoices].map(([id, invoiceNumber]) => ({ id, invoiceNumber })).sort(byInvoiceNumber);
}

// Sums the lines per normalized buyer number (each number once, whichever
// customers and invoices carry it), credit notes negative, öre summed and
// rounded to whole kronor per row. Lines without a usable number stay out of
// the rows and become warnings, as does a customer outside the EU.
// `totalsOre` is the rows' exact öre sum per column (what the
// reconciliation compares with the booked ruta 35/39), `lineCount` how many
// EU-sale lines there were at all — with or without a usable number.
export function aggregatePeriodicSummary(lines: EuSalesLine[]): {
  rows: PeriodicSummaryAggregateRow[];
  warnings: PeriodicSummaryWarning[];
  totalsOre: { goods: number; services: number };
  lineCount: number;
} {
  const rows = new Map<string, Accumulator>();
  const warnings = new Map<string, WarningGroup>();

  function warn(key: string, group: Omit<WarningGroup, "invoices">, line: EuSalesLine) {
    const existing = warnings.get(key) ?? { ...group, invoices: new Map<string, string>() };
    existing.invoices.set(line.invoiceId, line.invoiceNumber);
    warnings.set(key, existing);
  }

  for (const line of lines) {
    const country = line.customerCountry.trim().toUpperCase();
    if (!isEuCountry(country)) {
      warn(
        `non_eu_country:${line.customerId}`,
        {
          kind: "non_eu_country",
          sortKey: line.customerName,
          message: `${line.customerName} har landet ${country}, som inte är ett EU-land — kontrollera momskoden på fakturorna`,
        },
        line
      );
    }

    const buyer = buyerVatNumber(line.vatNumber, country);
    if (buyer.status === "missing") {
      warn(
        `missing_vat_number:${line.customerId}`,
        {
          kind: "missing_vat_number",
          sortKey: line.customerName,
          message: `${line.customerName}: fakturor med EU-försäljning saknar köparens momsregistreringsnummer och kommer inte med i sammanställningen`,
        },
        line
      );
      continue;
    }
    if (buyer.status === "invalid") {
      warn(
        `invalid_vat_number:${line.customerId}:${buyer.vatNumber}`,
        {
          kind: "invalid_vat_number",
          sortKey: `${line.customerName} ${buyer.vatNumber}`,
          message: `${line.customerName}: momsregistreringsnumret ${buyer.vatNumber} är inte ett momsnummer i ett annat EU-land — fakturorna kommer inte med i sammanställningen`,
        },
        line
      );
      continue;
    }

    const row = rows.get(buyer.vatNumber) ?? {
      vatNumber: buyer.vatNumber,
      customers: new Map<string, string>(),
      goodsOre: 0,
      servicesOre: 0,
      goodsUsed: false,
      servicesUsed: false,
      invoices: new Map<string, string>(),
    };
    const ore = toOre(line.amount) * (line.invoiceType === "credit" ? -1 : 1);
    if (line.code === "EUV") {
      row.goodsOre += ore;
      row.goodsUsed = true;
    } else {
      row.servicesOre += ore;
      row.servicesUsed = true;
    }
    row.customers.set(line.customerId, line.customerName);
    row.invoices.set(line.invoiceId, line.invoiceNumber);
    rows.set(buyer.vatNumber, row);
  }

  const accumulated = [...rows.values()];
  return {
    totalsOre: {
      goods: accumulated.reduce((sum, row) => sum + row.goodsOre, 0),
      services: accumulated.reduce((sum, row) => sum + row.servicesOre, 0),
    },
    lineCount: lines.length,
    rows: accumulated
      .sort((a, b) => (a.vatNumber < b.vatNumber ? -1 : a.vatNumber > b.vatNumber ? 1 : 0))
      .map((row) => ({
        vatNumber: row.vatNumber,
        customers: [...row.customers]
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name, "sv") || a.id.localeCompare(b.id)),
        goods: oreToKronor(row.goodsOre),
        triangular: null,
        services: oreToKronor(row.servicesOre),
        invoices: invoiceRefs(row.invoices),
        goodsUsed: row.goodsUsed,
        servicesUsed: row.servicesUsed,
      })),
    warnings: [...warnings.values()]
      .sort(
        (a, b) =>
          WARNING_ORDER.indexOf(a.kind) - WARNING_ORDER.indexOf(b.kind) || a.sortKey.localeCompare(b.sortKey, "sv")
      )
      .map((group) => ({ kind: group.kind, message: group.message, invoices: invoiceRefs(group.invoices) })),
  };
}

// The summary's rows against the VAT report's booked ruta 35/39, both in
// ÖRE: the rows sum exactly the invoice rows the poster booked on 3108/3308,
// so any öre of difference is real — typically a manual verification on
// those accounts, an invoice row with the wrong code or an invoice left out
// for its VAT number. Comparing the per-row rounded kronor with the rounded
// boxes instead would both invent differences (rounding) and hide small
// ones. One warning per column that differs; `differences` is the exact
// öre difference expressed in kronor (0 exactly when the öre agree), so a
// difference of a few öre never reads as "agrees".
export function ledgerDifference(totalOre: number, bookedOre: number): number {
  return (totalOre - bookedOre) / 100;
}

export function ledgerDifferenceWarnings(
  totalsOre: { goods: number; services: number },
  ledgerOre: { box35: number; box39: number }
): PeriodicSummaryWarning[] {
  const columns = [
    { label: "Varor", total: totalsOre.goods, box: "35", booked: ledgerOre.box35 },
    { label: "Tjänster", total: totalsOre.services, box: "39", booked: ledgerOre.box39 },
  ];
  return columns.flatMap(({ label, total, box, booked }) => {
    const difference = total - booked;
    if (difference === 0) return [];
    return [
      {
        kind: "ledger_difference" as const,
        message: `${label}: sammanställningen ${formatOre(total)} kr, bokfört i ruta ${box} ${formatOre(booked)} kr (skillnad ${formatOre(difference)} kr) — typiskt ett manuellt verifikat eller en faktura med fel momskod`,
        invoices: [],
      },
    ];
  });
}
