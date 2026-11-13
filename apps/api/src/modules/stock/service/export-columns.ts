// F2: CSV columns for GET /stock/balances/csv, /stock/transactions/csv,
// /stock-counts/csv and /stock/locations/register/csv — mirror the
// corresponding web Table column order/labels:
//   apps/web/app/lager/page.tsx (balances)
//   apps/web/app/lager/transaktioner/page.tsx (transactions)
//   apps/web/app/lager/inventering/page.tsx (stock counts)
//   apps/web/app/lager/platser/page.tsx (the lagerplatsregister)
import type {
  StockCountStatus,
  StockLocationRegisterRow,
  StockLocationUnitBalance,
  StockTransactionReference,
  StockTransactionType,
} from "@navet/shared";
import { formatCsvNumber, type CsvColumn } from "@navet/shared";

export interface StockBalanceExportRow {
  articleNumber: string;
  articleName: string;
  warehouseName: string | null;
  locationName: string | null;
  // Spärrad lagerplats (0185) — the web shows it as a tag after the place.
  locationBlocked: boolean | null;
  quantityOnHand: string | number;
}

export const stockBalanceExportColumns: CsvColumn<StockBalanceExportRow>[] = [
  { label: "Artikelnummer", value: (r) => r.articleNumber },
  { label: "Benämning", value: (r) => r.articleName },
  { label: "Lager", value: (r) => r.warehouseName },
  { label: "Lagerplats", value: (r) => r.locationName },
  { label: "Spärrad", value: (r) => (r.locationBlocked ? "Ja" : "Nej") },
  { label: "Saldo", value: (r) => r.quantityOnHand, format: "number" },
];

// Server-side mirror of the web's STOCK_TRANSACTION_TYPE_LABELS (apps/web/lib/types.ts)
// — duplicated rather than shared across the app boundary.
const STOCK_TRANSACTION_TYPE_LABELS: Record<StockTransactionType, string> = {
  purchase_receipt: "Inköpsmottagning",
  sales_delivery: "Kundleverans",
  mo_consumption: "Materialförbrukning",
  mo_receipt: "Tillverkningsmottagning",
  inventory_adjustment: "Inventeringsjustering",
  stock_transfer: "Lagerflytt",
};

export interface StockTransactionExportRow {
  createdAt: string | Date;
  // Värderingsdatum (#26) — = createdAt except for a stock count registered
  // per underlagets datum.
  valuedAt: string | Date;
  articleNumber: string;
  articleName: string;
  warehouseName: string | null;
  locationName: string | null;
  // Batch (#8): the row's batch number; null = Okänd / not batchstyrd.
  batchNumber?: string | null;
  transactionType: StockTransactionType;
  quantityDelta: string | number;
  balance: string | number | null;
  reference: StockTransactionReference | null;
  createdByName: string | null;
  unitCost: string | number | null;
  value: string | number | null;
  note: string | null;
}

// Same text as the web's Källa cell. A transfer's negative leg went TO the
// counterpart, the positive leg came FROM it.
export function stockReferenceLabel(ref: StockTransactionReference | null, quantityDelta: string | number): string | null {
  if (!ref) return null;
  switch (ref.kind) {
    case "purchase_order":
    case "sales_order":
    case "manufacturing_order":
    case "stock_count":
      return ref.number;
    case "manual":
      return "Manuell";
    case "transfer":
      return `${Number(quantityDelta) < 0 ? "Flytt till" : "Flytt från"} ${ref.counterpartLocation}`;
  }
}

// Order mirrors the web table: Datum, Artikel, Lagerplats, Batch, Typ, Mängd, Saldo,
// Källa, Vem, À-pris, Värde, Anteckning — plus Registrerad after Datum, which
// the web shows under the date only when the two differ (#26: Datum is the
// värderingsdatum, Registrerad when the row was booked). Saldo is only included when the export
// is filtered to one article; À-pris/Värde are dropped entirely for users
// without cost access (includeCost = false) and blank where there is no cost.
export function stockTransactionColumns(includeCost: boolean, includeBalance: boolean): CsvColumn<StockTransactionExportRow>[] {
  const columns: CsvColumn<StockTransactionExportRow>[] = [
    {
      label: "Datum",
      value: (r) => (r.valuedAt instanceof Date ? r.valuedAt.toISOString() : r.valuedAt),
      format: "datetime",
    },
    {
      label: "Registrerad",
      value: (r) => (r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt),
      format: "datetime",
    },
    { label: "Artikel", value: (r) => `${r.articleNumber} — ${r.articleName}` },
    { label: "Lagerplats", value: (r) => (r.locationName ? `${r.warehouseName} — ${r.locationName}` : null) },
    // Batch (#8): blank for Okänd and for articles without batches.
    { label: "Batch", value: (r) => r.batchNumber ?? null },
    { label: "Typ", value: (r) => STOCK_TRANSACTION_TYPE_LABELS[r.transactionType] },
    { label: "Mängd", value: (r) => r.quantityDelta, format: "number" },
    ...(includeBalance ? [{ label: "Saldo", value: (r: StockTransactionExportRow) => r.balance, format: "number" as const }] : []),
    { label: "Källa", value: (r) => stockReferenceLabel(r.reference, r.quantityDelta) },
    { label: "Vem", value: (r) => r.createdByName },
  ];
  if (includeCost) {
    columns.push(
      { label: "À-pris", value: (r) => r.unitCost, format: "number" },
      { label: "Värde", value: (r) => r.value, format: "money" }
    );
  }
  columns.push({ label: "Anteckning", value: (r) => r.note });
  return columns;
}

// Server-side mirror of the web's STOCK_COUNT_STATUS_LABELS (apps/web/lib/types.ts)
// — duplicated rather than shared across the app boundary.
const STOCK_COUNT_STATUS_LABELS: Record<StockCountStatus, string> = {
  open: "Pågår",
  posted: "Registrerad",
  cancelled: "Avbruten",
};

export interface StockCountExportRow {
  countNumber: string;
  warehouseName: string;
  locationName: string;
  status: StockCountStatus;
  blocksTransactions: boolean;
  countedCount: number;
  rowCount: number;
  createdAt: string | Date;
}

export const stockCountExportColumns: CsvColumn<StockCountExportRow>[] = [
  { label: "Nummer", value: (r) => r.countNumber },
  { label: "Lagerplats", value: (r) => `${r.warehouseName} — ${r.locationName}` },
  { label: "Status", value: (r) => STOCK_COUNT_STATUS_LABELS[r.status] },
  { label: "Spärr", value: (r) => (r.blocksTransactions ? "Ja" : "Nej") },
  { label: "Räknade", value: (r) => `${r.countedCount} / ${r.rowCount}` },
  {
    label: "Skapad",
    value: (r) => (r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt),
    format: "datetime",
  },
];

// Saldo per unit in one cell, as the register shows it: "35,5 kg · 120 st"
// (the numbers in the CSV's number format). Empty when nothing stands there.
export function unitBalancesText(balances: StockLocationUnitBalance[]): string {
  return balances.map((b) => `${formatCsvNumber(b.quantity)} ${b.unitCode}`).join(" · ");
}

export const stockLocationRegisterExportColumns: CsvColumn<StockLocationRegisterRow>[] = [
  { label: "Lager", value: (r) => r.warehouseName },
  { label: "Lagerplats", value: (r) => r.name },
  { label: "Etikettkod", value: (r) => r.labelCode },
  { label: "Fast", value: (r) => (r.fixed ? "Ja" : "Nej") },
  { label: "Spärrad", value: (r) => (r.blocked ? "Ja" : "Nej") },
  { label: "Spärrad sedan", value: (r) => r.blockedAt, format: "datetime" },
  { label: "Anteckning", value: (r) => r.blockedNote },
  { label: "Artiklar", value: (r) => r.articleCount, format: "number" },
  { label: "Saldo", value: (r) => unitBalancesText(r.balances) },
  { label: "Status", value: (r) => (r.active ? "Aktiv" : "Inaktiv") },
];
