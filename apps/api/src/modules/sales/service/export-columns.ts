// F2: CSV column definitions for the sales module's list endpoints. Column
// labels/order mirror the corresponding web list page's visible columns
// (apps/web/components/sales/*PageClient.tsx) — extra fields useful in an
// export but not shown on screen (addresses, notes, timestamps) are appended
// at the end. Status enums are exported as their Swedish label, mirroring the
// *_STATUS_PILL maps in apps/web/lib/types.ts (there is no server-side
// equivalent, so the labels are inlined here).
import type { CsvColumn } from "@navet/shared";
import type {
  customers,
  invoices,
  invoiceStatusEnum,
  invoiceTypeEnum,
  priceLists,
  salesOrders,
  salesOrderStatusEnum,
  customerPayments,
} from "@navet/db";

// --- Kunder (customers) ---

type CustomerRow = typeof customers.$inferSelect;

export const CUSTOMER_CSV_COLUMNS: CsvColumn<CustomerRow>[] = [
  { label: "Kundnr", value: (r) => r.customerNumber },
  { label: "Namn", value: (r) => r.name },
  { label: "Kontaktperson", value: (r) => r.contactName },
  { label: "E-post", value: (r) => r.email },
  { label: "Telefon", value: (r) => r.phone },
  { label: "Status", value: (r) => (r.active ? "Aktiv" : "Inaktiv") },
  { label: "Adress", value: (r) => r.address },
  { label: "Postnr", value: (r) => r.postalCode },
  { label: "Ort", value: (r) => r.city },
  { label: "Land", value: (r) => r.country },
  { label: "Fakturanamn", value: (r) => r.invoiceName },
  { label: "Fakturaadress", value: (r) => r.invoiceAddress },
  { label: "Fakturapostnr", value: (r) => r.invoicePostalCode },
  { label: "Fakturaort", value: (r) => r.invoiceCity },
  { label: "Fakturaland", value: (r) => r.invoiceCountry },
  { label: "Fakturaepost", value: (r) => r.invoiceEmail },
  { label: "Org.nr", value: (r) => r.orgNumber },
  { label: "Momsreg.nr", value: (r) => r.vatNumber },
  { label: "Vårt leverantörsnummer", value: (r) => r.ourSupplierNumber },
  { label: "Samlingsfaktura", value: (r) => (r.collectiveInvoicing ? "Ja" : "Nej") },
  { label: "Privatperson", value: (r) => (r.privatePerson ? "Ja" : "Nej") },
  { label: "Webbsida", value: (r) => r.website },
  { label: "Kundrabatt %", value: (r) => r.discountPercent },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];

// --- Kundordrar (sales orders) ---

export const SALES_ORDER_STATUS_LABELS: Record<(typeof salesOrderStatusEnum.enumValues)[number], string> = {
  quote: "Offert",
  confirmed: "Bekräftad",
  in_production: "Under tillverkning",
  delivered: "Levererad",
  invoiced: "Fakturerad",
  cancelled: "Avbruten",
  lost: "Förlorad",
};

// The list omits the detail-only freight_quote jsonb (listSalesOrders).
type SalesOrderRow = Omit<typeof salesOrders.$inferSelect, "freightQuote"> & {
  customerName: string;
  nextDeliveryDate: string | null;
  lostReasonName: string | null;
};

export const SALES_ORDER_CSV_COLUMNS: CsvColumn<SalesOrderRow>[] = [
  { label: "Ordernummer", value: (r) => r.orderNumber },
  // Offerter (0138): the OF- number, also on an order that came from one.
  { label: "Offertnummer", value: (r) => r.quoteNumber },
  { label: "Kund", value: (r) => r.customerName },
  { label: "Status", value: (r) => SALES_ORDER_STATUS_LABELS[r.status] },
  { label: "Leveransdatum", value: (r) => r.expectedDeliveryDate, format: "date" },
  { label: "Nästa leveransdatum", value: (r) => r.nextDeliveryDate, format: "date" },
  { label: "Giltig t.o.m.", value: (r) => r.quoteValidUntil, format: "date" },
  { label: "Förlustorsak", value: (r) => r.lostReasonName },
  { label: "Kundens ordernr", value: (r) => r.customerOrderNumber },
  { label: "Kundens förfrågan", value: (r) => r.customerInquiryNumber },
  { label: "Kundens referens", value: (r) => r.customerReference },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Kurs", value: (r) => r.exchangeRate },
  { label: "Notering", value: (r) => r.note },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];

// --- Prislistor (price lists) ---

type PriceListRow = typeof priceLists.$inferSelect & { rowCount: number };

export const PRICE_LIST_CSV_COLUMNS: CsvColumn<PriceListRow>[] = [
  { label: "Kod", value: (r) => r.code },
  { label: "Namn", value: (r) => r.name },
  { label: "Beskrivning", value: (r) => r.description },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Antal rader", value: (r) => r.rowCount, format: "number" },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];

// --- Fakturor (customer invoices) ---

const INVOICE_STATUS_LABELS: Record<(typeof invoiceStatusEnum.enumValues)[number], string> = {
  draft: "Utkast",
  issued: "Utfärdad",
  paid: "Betald",
  cancelled: "Avbruten",
};

const INVOICE_TYPE_LABELS: Record<(typeof invoiceTypeEnum.enumValues)[number], string> = {
  invoice: "Faktura",
  credit: "Kreditfaktura",
};

type InvoiceRow = typeof invoices.$inferSelect & {
  customerName: string;
  netAmount: string;
  vatAmount: string;
  verificationDisplayNumber: string | null;
};

export const INVOICE_CSV_COLUMNS: CsvColumn<InvoiceRow>[] = [
  { label: "Nummer", value: (r) => r.invoiceNumber ?? "Utkast" },
  { label: "Typ", value: (r) => INVOICE_TYPE_LABELS[r.type] },
  { label: "Kund", value: (r) => r.customerName },
  { label: "Fakturadatum", value: (r) => r.invoiceDate, format: "date" },
  { label: "Förfallodatum", value: (r) => r.dueDate, format: "date" },
  {
    // "Belopp" is the gross (incl. moms) — what's actually owed — same rule
    // as the web list's own netAmount+vatAmount sum.
    label: "Belopp",
    value: (r) => Number(r.netAmount) + Number(r.vatAmount),
    format: "money",
  },
  { label: "Status", value: (r) => INVOICE_STATUS_LABELS[r.status] },
  { label: "Valuta", value: (r) => r.currency },
  // Valuta: the receivable in SEK (stamped at Utfärda; empty on a draft).
  { label: "Belopp SEK", value: (r) => (r.grossAmountSek === null ? null : Number(r.grossAmountSek)), format: "money" },
  { label: "OCR", value: (r) => r.ocrNumber },
  { label: "Verifikat", value: (r) => r.verificationDisplayNumber },
  { label: "Notering", value: (r) => r.note },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];

// --- Öppna poster (AR reskontra) ---

export interface OpenInvoiceCsvRow {
  id: string;
  invoiceNumber: string | null;
  type: (typeof invoiceTypeEnum.enumValues)[number];
  customerId: string;
  customerName: string;
  invoiceDate: string | null;
  dueDate: string | null;
  ocrNumber: string | null;
  grossAmount: number;
  openAmount: number;
  currency: string;
  openAmountSek: number | null;
  reminderCount: number;
  reminderFeeCharged: boolean;
}

export const OPEN_INVOICE_CSV_COLUMNS: CsvColumn<OpenInvoiceCsvRow>[] = [
  { label: "Faktura", value: (r) => r.invoiceNumber ?? "" },
  { label: "Kund", value: (r) => r.customerName },
  { label: "Typ", value: (r) => INVOICE_TYPE_LABELS[r.type] },
  { label: "Förfallodatum", value: (r) => r.dueDate, format: "date" },
  { label: "Belopp", value: (r) => r.grossAmount, format: "money" },
  { label: "Öppet belopp", value: (r) => r.openAmount, format: "money" },
  {
    label: "Påminnelser",
    value: (r) =>
      r.reminderCount > 0 ? `Nivå ${r.reminderCount}${r.reminderFeeCharged ? " · avgift" : ""}` : "",
  },
  { label: "Fakturadatum", value: (r) => r.invoiceDate, format: "date" },
  { label: "OCR", value: (r) => r.ocrNumber },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Öppet belopp SEK", value: (r) => r.openAmountSek, format: "money" },
];

// --- Betalningar (customer payments) ---

type PaymentRow = typeof customerPayments.$inferSelect & {
  customerName: string;
  verificationDisplayNumber: string | null;
  cancellationDisplayNumber: string | null;
};

export const PAYMENT_CSV_COLUMNS: CsvColumn<PaymentRow>[] = [
  { label: "BET-nr", value: (r) => r.paymentNumber },
  { label: "Datum", value: (r) => r.paymentDate, format: "date" },
  { label: "Kund", value: (r) => r.customerName },
  { label: "Belopp", value: (r) => r.amount, format: "money" },
  { label: "Valuta", value: (r) => r.currency },
  { label: "Belopp SEK", value: (r) => r.amountSek, format: "money" },
  { label: "Bankavgift SEK", value: (r) => r.bankFeeSek, format: "money" },
  { label: "Konto", value: (r) => r.bankAccountNumber },
  { label: "Verifikat", value: (r) => r.verificationDisplayNumber },
  { label: "Status", value: (r) => (r.cancelledAt === null ? "Registrerad" : "Makulerad") },
  { label: "Notering", value: (r) => r.note },
  { label: "Skapad", value: (r) => r.createdAt.toISOString(), format: "datetime" },
];
