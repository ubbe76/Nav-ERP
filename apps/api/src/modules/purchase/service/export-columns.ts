// F2: CSV column definitions for the purchase module's list endpoints.
// Column labels/order mirror the corresponding web list page's visible
// columns (apps/web/components/purchase/*PageClient.tsx) — extra fields
// useful in an export but not shown on screen (addresses, notes, timestamps)
// are appended at the end. Status enums are exported as their Swedish label,
// mirroring the *_STATUS_PILL maps in apps/web/lib/types.ts (there is no
// server-side equivalent, so the labels are inlined here).
import type { CsvColumn } from "@navet/shared";
import type {
  inquiries,
  inquiryStatusEnum,
  purchaseOrders,
  purchaseOrderStatusEnum,
  suppliers,
  supplierInvoices,
  supplierInvoiceStatusEnum,
  supplierPayments,
} from "@navet/db";

// --- Leverantörer (suppliers) ---

type SupplierRow = typeof suppliers.$inferSelect;

export const SUPPLIER_CSV_COLUMNS: CsvColumn<SupplierRow>[] = [
  { label: "Lev.nr", value: (r) => r.supplierNumber },
  { label: "Namn", value: (r) => r.name },
  { label: "Kontaktperson", value: (r) => r.contactName },
  { label: "E-post", value: (r) => r.email },
  { label: "Telefon", value: (r) => r.phone },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Status", value: (r) => (r.active ? "Aktiv" : "Inaktiv") },
  { label: "Adress", value: (r) => r.address },
  { label: "Postnr", value: (r) => r.postalCode },
  { label: "Ort", value: (r) => r.city },
  { label: "Org.nr", value: (r) => r.orgNumber },
  { label: "Momsreg.nr", value: (r) => r.vatNumber },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];

// --- Förfrågningar (inquiries) ---

const INQUIRY_STATUS_LABELS: Record<(typeof inquiryStatusEnum.enumValues)[number], string> = {
  draft: "Utkast",
  sent: "Skickad",
  answered: "Besvarad",
  ordered: "Beställd",
  cancelled: "Avbruten",
};

type InquiryRow = typeof inquiries.$inferSelect & { supplierName: string };

export const INQUIRY_CSV_COLUMNS: CsvColumn<InquiryRow>[] = [
  { label: "Nummer", value: (r) => r.inquiryNumber },
  { label: "Leverantör", value: (r) => r.supplierName },
  { label: "Status", value: (r) => INQUIRY_STATUS_LABELS[r.status] },
  { label: "Önskat leveransdatum", value: (r) => r.expectedDeliveryDate, format: "date" },
  { label: "Notering", value: (r) => r.note },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];

// --- Inköpsordrar (purchase orders) ---

const PURCHASE_ORDER_STATUS_LABELS: Record<(typeof purchaseOrderStatusEnum.enumValues)[number], string> = {
  draft: "Utkast",
  confirmed: "Bekräftad",
  partially_received: "Delvis mottagen",
  received: "Mottagen",
  closed: "Stängd",
  cancelled: "Avbruten",
};

type PurchaseOrderRow = typeof purchaseOrders.$inferSelect & { supplierName: string };

export const PURCHASE_ORDER_CSV_COLUMNS: CsvColumn<PurchaseOrderRow>[] = [
  { label: "Ordernummer", value: (r) => r.orderNumber },
  { label: "Leverantör", value: (r) => r.supplierName },
  { label: "Status", value: (r) => PURCHASE_ORDER_STATUS_LABELS[r.status] },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Önskat leveransdatum", value: (r) => r.expectedDeliveryDate, format: "date" },
  { label: "Er referens", value: (r) => r.yourReference },
  { label: "Vår referens", value: (r) => r.ourReference },
  { label: "Notering", value: (r) => r.note },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];

// --- Inleveranslogg (goods receipts, per-article — no dedicated list page;
// mirrors the article card's Inköp-flik "Inleveranser" log). ---

export interface GoodsReceiptCsvRow {
  id: string;
  date: Date;
  quantity: string;
  orderNumber: string;
  supplierName: string;
  currency: string;
  unitPrice: string;
  locationName: string | null;
}

export const GOODS_RECEIPT_CSV_COLUMNS: CsvColumn<GoodsReceiptCsvRow>[] = [
  { label: "Datum", value: (r) => r.date.toISOString(), format: "datetime" },
  { label: "Ordernummer", value: (r) => r.orderNumber },
  { label: "Leverantör", value: (r) => r.supplierName },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "À-pris", value: (r) => r.unitPrice, format: "money" },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Lagerplats", value: (r) => r.locationName },
];

// --- Prislogg (price history, per-article — no dedicated list page). ---

export interface PriceHistoryCsvRow {
  id: string;
  date: Date;
  orderNumber: string;
  supplierName: string;
  unitPrice: string;
  currency: string;
  quantity: string;
}

export const PRICE_HISTORY_CSV_COLUMNS: CsvColumn<PriceHistoryCsvRow>[] = [
  { label: "Datum", value: (r) => r.date.toISOString(), format: "datetime" },
  { label: "Ordernummer", value: (r) => r.orderNumber },
  { label: "Leverantör", value: (r) => r.supplierName },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "À-pris", value: (r) => r.unitPrice, format: "money" },
  { label: "Valuta", value: (r) => r.currency },
];

// --- Fakturaunderlag (purchase invoice basis) ---

export interface PurchaseInvoiceBasisCsvRow {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  currency: string;
  status: (typeof purchaseOrderStatusEnum.enumValues)[number];
  receivedAt: string | null;
  receivedValue: string;
  invoiceId: string | null;
  invoiceRegistrationNumber: string | null;
}

export const PURCHASE_INVOICE_BASIS_CSV_COLUMNS: CsvColumn<PurchaseInvoiceBasisCsvRow>[] = [
  { label: "Ordernr", value: (r) => r.orderNumber },
  { label: "Leverantör", value: (r) => r.supplierName },
  { label: "Mottaget", value: (r) => r.receivedAt, format: "datetime" },
  { label: "Mottaget värde", value: (r) => r.receivedValue, format: "money" },
  { label: "Valuta", value: (r) => r.currency },
  {
    label: "Fakturastatus",
    value: (r) => (r.invoiceId ? `Fakturerad (${r.invoiceRegistrationNumber ?? ""})` : "Ej fakturerad"),
  },
  { label: "Orderstatus", value: (r) => PURCHASE_ORDER_STATUS_LABELS[r.status] },
];

// --- Leverantörsfakturor (supplier invoices, AP) ---

const SUPPLIER_INVOICE_STATUS_LABELS: Record<(typeof supplierInvoiceStatusEnum.enumValues)[number], string> = {
  draft: "Utkast",
  approved: "Godkänd",
  paid: "Betald",
  cancelled: "Avbruten",
};

type SupplierInvoiceRow = typeof supplierInvoices.$inferSelect & {
  supplierName: string;
  verificationDisplayNumber: string | null;
};

export const SUPPLIER_INVOICE_CSV_COLUMNS: CsvColumn<SupplierInvoiceRow>[] = [
  { label: "Reg.nr", value: (r) => r.registrationNumber },
  { label: "Leverantörens fakturanr", value: (r) => r.invoiceNumber },
  { label: "Leverantör", value: (r) => r.supplierName },
  { label: "Fakturadatum", value: (r) => r.invoiceDate, format: "date" },
  { label: "Förfallodatum", value: (r) => r.dueDate, format: "date" },
  { label: "Status", value: (r) => SUPPLIER_INVOICE_STATUS_LABELS[r.status] },
  { label: "Belopp", value: (r) => r.grossAmount, format: "money" },
  { label: "Varav moms", value: (r) => r.vatAmount, format: "money" },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Verifikat", value: (r) => r.verificationDisplayNumber },
  { label: "Notering", value: (r) => r.note },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];

// --- Öppna leverantörsfakturor (AP reskontra) ---

export interface OpenSupplierInvoiceCsvRow {
  id: string;
  registrationNumber: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string | null;
  grossAmount: number;
  openAmount: number;
}

export const OPEN_SUPPLIER_INVOICE_CSV_COLUMNS: CsvColumn<OpenSupplierInvoiceCsvRow>[] = [
  { label: "Reg.nr", value: (r) => r.registrationNumber },
  { label: "Leverantörens fakturanr", value: (r) => r.invoiceNumber },
  { label: "Leverantör", value: (r) => r.supplierName },
  { label: "Fakturadatum", value: (r) => r.invoiceDate, format: "date" },
  { label: "Förfallodatum", value: (r) => r.dueDate, format: "date" },
  { label: "Belopp", value: (r) => r.grossAmount, format: "money" },
  { label: "Öppet belopp", value: (r) => r.openAmount, format: "money" },
];

// --- Leverantörsbetalningar (supplier payments) ---

type SupplierPaymentRow = typeof supplierPayments.$inferSelect & {
  supplierName: string;
  verificationDisplayNumber: string | null;
  cancellationDisplayNumber: string | null;
};

export const SUPPLIER_PAYMENT_CSV_COLUMNS: CsvColumn<SupplierPaymentRow>[] = [
  { label: "UTB-nr", value: (r) => r.paymentNumber },
  { label: "Datum", value: (r) => r.paymentDate, format: "date" },
  { label: "Leverantör", value: (r) => r.supplierName },
  { label: "Belopp", value: (r) => r.amount, format: "money" },
  { label: "Konto", value: (r) => r.bankAccountNumber },
  { label: "Verifikat", value: (r) => r.verificationDisplayNumber },
  { label: "Status", value: (r) => (r.cancelledAt === null ? "Registrerad" : "Makulerad") },
  { label: "Notering", value: (r) => r.note },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];
