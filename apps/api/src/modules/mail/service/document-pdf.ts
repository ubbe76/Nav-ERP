import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { minutesPerUnitToSecondsPerUnit, minutesPerUnitToUnitsPerHour, VAT_CODES, type ExtraDescriptionDocument } from "@navet/shared";
import { CODE128_QUIET_ZONE, code128TotalModules, encodeCode128 } from "./code128.js";
import type { SystemService } from "../../system/service/system.service.js";

// One shared A4 layout for all outgoing business documents (förfrågan,
// inköpsorder, offert, orderbekräftelse): company header with logo, document
// title/number/date, partner address block, row table, optional total.
// Built with pdfkit — the built-in Helvetica fonts cover åäö (WinAnsi).

export interface DocumentPdfRow {
  articleNumber: string;
  articleName: string;
  quantity: string;
  unit: string | null;
  unitPrice: string | null; // null = unanswered price (förfrågan)
  // Revision line printed under the article name (e.g. "Rev B · Ritn 4711
  // rev C") — set by the callsite when "show_revisions_on_documents" is on.
  revisionInfo?: string | null;
  // "Ytbehandling: … · Färg: …" from the article (formatArticleAttributes)
  // — printed right after the revision line. The callsite decides which
  // rows carry it: lego rows on IO/RFQ, every row on quote/confirmation,
  // never invoices.
  articleInfo?: string | null;
  // The article's "Extra benämning" (multi-line), printed right after the
  // articleInfo line. The callsite sets it only when the document kind is in
  // the setting extraDescriptionDocuments (see extraDescriptionFor).
  extraDescription?: string | null;
  // Sales documents: Kundens artikelnummer — printed as "Ert art.nr: X", the
  // first info line under the name.
  customerArticleNumber?: string | null;
  // Ställkostnad: the article number of the row this setup charge belongs to
  // — printed as "Ställkostnad för X" (quote, order confirmation, invoice).
  setupForArticleNumber?: string | null;
  // Invoice-only: this row's VAT rate, used to group the perRow VAT summary
  // (DocumentPdfInput.vat = { perRow: true }) — ignored by every other
  // document type and by the single-rate vat: { rate } branch.
  vatRate?: number | null;
  // Invoice-only: the row's momskod — the perRow VAT summary groups per code
  // (rate + code), so two 0 % codes print as two lines with their own names.
  // Omitted = grouped by rate alone, as before the momskoder.
  vatCode?: { code: string; name: string } | null;
  // Invoice-only: the row's STORED net/VAT amounts (invoice_rows.lineAmount/
  // vatAmount — already round2:ed per row, the same figures the ledger
  // posting and the API list/card sum). When present these are the
  // authority for both this row's own "Summa" cell and every total below —
  // quantity × unitPrice is display-unit-converted and can diverge from them
  // by a rounding öre. Every other document type (inquiry/PO/quote/order)
  // never sets these, so their rows keep the old quantity × unitPrice math
  // via the fallback below.
  lineAmount?: string | null;
  vatAmount?: string | null;
  // C3: the row's discount (sales_order_rows/invoice_rows.discountPercent),
  // printed in its own "Rabatt" column. Undefined/null/0 all render as an
  // empty cell — the vast majority of rows/documents have no discount, and
  // the column must stay invisible for them (documents without any
  // discounted row must look exactly like they did before this field
  // existed).
  discountPercent?: string | null;
  // Lego (purchase order only): the TO reference printed as an 8pt line
  // under the article name ("Lego för PO-2044 · Op 20 · Svetsning").
  moReference?: string | null;
  // Invoice-only: the sales order (and the customer's order number) this row
  // settles, as an 8pt sub-line ("Order KO2500123 · Ert ordernr 4711") — a
  // samlingsfaktura mixes orders, so this is per row, not a header field.
  orderReference?: string | null;
  // Invoice-only: Leveransdatum (ML 17 kap. 24 § p. 7) — printed as
  // "Levererad <date>" next to the order reference. The callsite sets it only
  // when it differs from the invoice date.
  deliveredDate?: string | null;
  // Lego: one-off ställpris — printed as its own sub-line and added ONCE to
  // the row amount (qty × unitPrice + setupPrice) and the total.
  setupPrice?: string | null;
  // Lego: net weight (article weight × quantity) printed as a sub-line when
  // the operation's "Visa nettovikt" is on; null/undefined prints nothing.
  netWeightKg?: number | null;
  // Purchase order: this row's own Önskat leveransdatum, printed as a
  // sub-line — the callsite sets it only when it differs from the header's.
  requestedDeliveryDate?: string | null;
  // Quote/order confirmation: this row's own Leveransdatum, likewise only
  // when it differs from the header's.
  deliveryDate?: string | null;
  // Konfigurator 4b: "Grupp: Värde" per choice of a configured row
  // (configurationLines), printed among the info lines under the name —
  // with the price additions only when the callsite put them there.
  configurationLines?: string[];
}

// Narrow settings view for document printing — implemented by SystemService
// (same pattern as timereport's settings reader).
export interface DocumentSettingsReader {
  getSettings(): Promise<{
    showRevisionsOnDocuments: boolean;
    showOrderRevisionOnDocuments: boolean;
    // The documents that print the article's Extra benämning. Optional so
    // the many narrow settings fakes need not carry it — absent = none.
    extraDescriptionDocuments?: ExtraDescriptionDocument[];
    // Kod på pallkort — the system default the services fall back on.
    palletCardCode: PalletCardCodeType;
  }>;
}

// The Extra benämning a row prints on `kind`: the article's text when the
// setting lists the document, else null. ONE rule for every callsite.
export function extraDescriptionFor(
  settings: { extraDescriptionDocuments?: ExtraDescriptionDocument[] },
  kind: ExtraDescriptionDocument
): (text: string | null | undefined) => string | null {
  const on = settings.extraDescriptionDocuments?.includes(kind) ?? false;
  return (text) => (on && text ? text : null);
}

// "Ytbehandling: Pulverlack RAL 9010 · Färg: Vit" — an empty half is left
// out, both empty → null so the row prints no extra line.
export function formatArticleAttributes(article: {
  surfaceTreatment: string | null;
  colour: string | null;
}): string | null {
  const parts = [
    article.surfaceTreatment ? `Ytbehandling: ${article.surfaceTreatment}` : null,
    article.colour ? `Färg: ${article.colour}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Shared formatter for the per-row revision line: the article's active
// revision plus each drawing number with its active drawing revision.
export function formatRevisionInfo(
  info: { revision: string | null; drawings: { drawingNumber: string; revision: string | null }[] } | undefined
): string | null {
  if (!info) return null;
  const parts: string[] = [];
  if (info.revision) parts.push(`Rev ${info.revision}`);
  for (const d of info.drawings) {
    parts.push(d.revision ? `Ritn ${d.drawingNumber} rev ${d.revision}` : `Ritn ${d.drawingNumber}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Vald leveransadress på kundordern — printed as its own block next to the
// customer block on offert/orderbekräftelse and on the pick list.
export interface DeliveryAddressBlock {
  label: string;
  address: string;
  postalCode: string | null;
  city: string | null;
  // ISO 3166-1 alpha-2; printed as a trailing line only when ≠ SE.
  country?: string | null;
}

export interface PartnerBlock {
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country?: string | null;
}

// Swedish names for the countries that actually occur in the customer
// register; anything else prints as its ISO code, which is still readable.
const COUNTRY_NAMES: Record<string, string> = {
  DK: "Danmark",
  NO: "Norge",
  FI: "Finland",
  DE: "Tyskland",
  PL: "Polen",
  IT: "Italien",
  EE: "Estland",
  LV: "Lettland",
  LT: "Litauen",
  NL: "Nederländerna",
  BE: "Belgien",
  FR: "Frankrike",
  ES: "Spanien",
  GB: "Storbritannien",
  US: "USA",
};

// Address lines below the name: street, "postnr ort", and the country when
// it is not Sweden — a Swedish sender never prints "Sverige" on domestic
// mail. A multi-row street (Monitor's Adressrad 1–3 are stored joined with
// newlines) is split into one entry per row: the partner block advances y
// by a fixed line height per entry, so an embedded newline would draw the
// second row on top of "postnr ort".
export function addressLines(a: {
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country?: string | null;
}): string[] {
  const country = a.country?.trim().toUpperCase();
  const streetRows = (a.address ?? "")
    .split(/\r\n|\r|\n/)
    .map((row) => row.trim())
    .filter((row) => row !== "");
  return [
    ...streetRows,
    [a.postalCode, a.city].filter(Boolean).join(" "),
    country && country !== "SE" ? (COUNTRY_NAMES[country] ?? country) : null,
  ].filter((line): line is string => Boolean(line));
}

export interface DocumentPdfInput {
  title: string; // "Förfrågan" | "Inköpsorder" | "Offert" | "Orderbekräftelse" | "Faktura"
  documentNumber: string;
  date: Date;
  partnerLabel: string; // "Leverantör" | "Kund" | "Fakturaadress"
  partner: PartnerBlock;
  currency: string;
  rows: DocumentPdfRow[];
  // Förfrågan is a question, not an offer — no total line there.
  showTotal: boolean;
  // Invoice-only: the totals become Summa exkl. moms / Moms / Att betala.
  // { rate } is the legacy single-rate invoice (stamped sales-order
  // reprints); { perRow: true } groups DocumentPdfRow.vatRate into one
  // "Moms (X %)" line per distinct rate (the customer invoice module).
  vat?: { rate: number } | { perRow: true } | null;
  // Momskoder: the invoice texts of the codes on the document ("Unionsintern
  // leverans …", "Omvänd betalningsskyldighet") — printed once each under the
  // totals, in the order given (the catalog's). Sales documents only.
  vatTexts?: string[];
  // Köparens momsregistreringsnummer — "Ert momsreg.nr:" under the date
  // (invoice: the issue snapshot).
  buyerVatNumber?: string | null;
  // Valuta (ML 17 kap. 29 § första stycket, mervärdesskattedirektivet art.
  // 230): an invoice in another currency than SEK also states the VAT in
  // SEK — "Moms i SEK: 2 782,75 (kurs 11,131000)" under the totals. The
  // amount is the VAT the F verification booked (invoiceSekAmounts), signed
  // like the document's amounts (negative on a credit note). Omitted/null
  // prints nothing (SEK, no VAT, or no rate yet).
  vatInSek?: { amount: number; rate: number } | null;
  // Invoice-only: a framed payment box (OCR-nummer, Bankgiro/Plusgiro from
  // the already-loaded company info, Förfallodatum) drawn above the footer
  // once the VAT/total block is done. Omitted (null/undefined) draws no box.
  payment?: { ocrNumber: string | null; dueDate: Date | null } | null;
  // The order's revision number (bumped on content changes) — printed after
  // the document number ("Inköpsorder IO2500123 / 2") on quote/order
  // confirmation/PO, not on the invoice. Callsites pass null when the
  // "show_order_revision_on_documents" setting is off.
  revision?: number | null;
  // Invoice-only meta lines under the date.
  dueDate?: Date | null;
  orderReference?: string | null;
  // Offerter (0138): the OF- number an order confirmation came from —
  // "Vår offert: OF-1001" under the date. The callsite passes it only when
  // the order's number differs from its quote number.
  quoteReference?: string | null;
  // Kundnummer — the customer's number in our register: live on quote/order
  // confirmation, the frozen snapshot on invoices. Sales documents only.
  partnerNumber?: string | null;
  // Kundens ordernummer (sales documents only).
  customerOrderNumber?: string | null;
  // Kundens förfrågan — "Er förfrågan:", the customer's inquiry/RFQ
  // reference (quote and order confirmation only).
  customerInquiryNumber?: string | null;
  // "Er referens" — the customer's reference on sales documents, the
  // supplier's contact on the PO. "Vår referens" — our buyer on the PO.
  yourReference?: string | null;
  ourReference?: string | null;
  // Önskat leveransdatum (inquiry/PO) — when we want the goods; rows with a
  // date of their own carry DocumentPdfRow.requestedDeliveryDate.
  requestedDeliveryDate?: string | null;
  // Leveransdatum (quote/order confirmation) — the day the customer gets the
  // goods; rows with a date of their own carry DocumentPdfRow.deliveryDate.
  deliveryDate?: string | null;
  // Giltig t.o.m. (quote only): "Offerten gäller till och med <date>." under
  // the meta lines. ISO date like every other date on the documents.
  validUntil?: string | null;
  // Our customer number at the supplier (vårt kundnummer hos leverantören) —
  // printed on inquiry/PO. Deliberately NOT labelled "Vårt kundnr:", which
  // the carrier line below already uses for our number at the CARRIER.
  ourCustomerNumberAtSupplier?: string | null;
  // Vårt leverantörsnummer hos kunden — the mirror on sales documents: the
  // number the customer files us under. Printed live (no snapshot).
  ourSupplierNumberAtCustomer?: string | null;
  // Privatperson (sales documents): à-pris and Summa cells are grossed up by
  // each row's vatRate, a "Priser inklusive moms" note precedes the table,
  // and the totals block becomes one gross line ("Att betala" when `vat` is
  // set, otherwise "Summa inkl. moms") plus "Varav moms". The underlying
  // amounts are untouched — this is presentation only.
  pricesIncludeVat?: boolean;
  deliveryAddress?: DeliveryAddressBlock | null;
  // Villkor ("code · name" strings) — printed below the address blocks when set.
  deliveryTerm?: string | null;
  paymentTerm?: string | null;
  carrier?: string | null;
  // The company's own customer number at the order's carrier — printed after
  // the carrier when the company pays the freight (purchase documents only).
  carrierCustomerNumber?: string | null;
  // Dröjsmålsränta (invoice only): "Vid betalning efter förfallodagen
  // debiteras dröjsmålsränta enligt räntelagen." under the terms, when the
  // routine is on and the customer has Dröjsmålsränta.
  lateInterestText?: string | null;
}

// Plocklista — picking instructions for a sales order delivery: remaining
// quantities per row plus where the stock is, with a column to tick off.
export interface PickListRow {
  articleNumber: string;
  articleName: string;
  quantityToPick: number;
  unit: string | null;
  locations: string[]; // e.g. "Huvudlager — A1: 6"
  // Konfigurator 4b: the configured row's choices under the name — never
  // with prices (this is a shop-floor document).
  configurationLines?: string[];
  // The row's own Leveransdatum — the callsite sets it only when it differs
  // from the order's (printed in the header).
  deliveryDate?: string | null;
  // Extra benämning (multi-line) — set when the setting lists the pick list.
  extraDescription?: string | null;
  // Kundens artikelnummer — "Ert art.nr: X".
  customerArticleNumber?: string | null;
}

export interface PickListPdfInput {
  documentNumber: string; // the sales order number
  printedAt: Date;
  customerName: string;
  expectedDeliveryDate: string | null;
  note: string | null;
  rows: PickListRow[];
  customerOrderNumber?: string | null;
  customerReference?: string | null;
  deliveryAddress?: DeliveryAddressBlock | null;
}

// Följesedel (delivery note) — C2. One per leveranstillfälle (delivery
// occasion): what shipped THIS time plus what had already shipped before it,
// so the recipient (and the file copy) can tell partial deliveries apart.
// Same customer/address blocks as the pick list — this is the pick list's
// mirror once the goods have actually gone out, sent to the customer rather
// than the shop floor, so unlike the pick list it DOES carry the company
// footer (see renderDeliveryNote).
export interface DeliveryNoteRow {
  articleNumber: string;
  articleName: string;
  quantity: number; // delivered on THIS occasion, in the row's display unit
  unit: string | null;
  // Delivered before this occasion (derived by subtraction in the
  // repository — see sales.repository.ts's getDeliveryForPdf), same unit.
  priorDelivered: number;
  // Konfigurator 4b: the configured row's choices under the name — never
  // with prices (the delivery note carries no prices at all).
  configurationLines?: string[];
  // Extra benämning (multi-line) — set when the setting lists the delivery note.
  extraDescription?: string | null;
  // Kundens artikelnummer — "Ert art.nr: X".
  customerArticleNumber?: string | null;
  // Ångra utleverans: the row was undone — printed as a line under the name.
  undoneAt?: Date | null;
}

export interface DeliveryNotePdfInput {
  documentNumber: string; // the delivery's FS- number
  orderNumber: string; // the sales order this delivery belongs to
  deliveredAt: Date;
  customerName: string;
  rows: DeliveryNoteRow[];
  // Ångra utleverans: every row undone — the header says so.
  undoneAt?: Date | null;
  customerOrderNumber?: string | null;
  customerReference?: string | null;
  deliveryAddress?: DeliveryAddressBlock | null;
  // Frakt: the booked shipment's carrier and fraktsedelsnummer, printed in the
  // header block. Null/omitted = not booked through Nav.
  carrier?: { carrierName: string | null; trackingNumber: string | null } | null;
}

// Betalningspåminnelse (B3) — an outgoing document about an invoice, not an
// invoice of its own: no row table, just the reference to the unpaid invoice
// and what is left to pay on it. Every amount is passed in ALREADY COMPUTED
// from the STORED figures (invoice_rows' own line/vat amounts and the open
// amount from open-amounts.ts, the single aggregation authority) — this
// renderer never recomputes money, exactly like the invoice's own totals
// prefer stored amounts over quantity × unitPrice (see DocumentPdfRow).
export interface PaymentReminderPdfInput {
  // 1, 2, 3 ... — printed in the title ("Betalningspåminnelse 2").
  level: number;
  documentNumber: string; // the invoice's FA number
  printedAt: Date;
  invoiceDate: Date | null;
  dueDate: Date | null;
  // The invoice's FROZEN address snapshot, never the live customer.
  partner: PartnerBlock;
  currency: string;
  grossAmount: number;
  // What payments/credits have taken off the invoice so far (positive) —
  // printed as a deduction.
  settledAmount: number;
  // Every reminder fee on the invoice, INCLUDING the one this reminder is
  // about to charge. 0 prints no fee line at all.
  feeAmount: number;
  amountDue: number;
  payment?: { ocrNumber: string | null; dueDate: Date | null } | null;
  // Dröjsmålsränta: the terms text and "Upplupen dröjsmålsränta t.o.m. …"
  // — information under the body text, never a charge on this document.
  lateInterestText?: string | null;
  accruedInterestText?: string | null;
}

// Reklamationsrapport (Kvalitet): one avvikelse as a letter — Reklamation to
// a supplier, Reklamationsbesked to a customer, Avvikelserapport internally.
// Everything arrives pre-formatted from the quality service; no costs and no
// prices ever reach this renderer. `details` (the dialog's choice) adds the
// investigation and the decision.
export interface DeviationReportPdfInput {
  title: string;
  // Outgoing letters get the company footer; the internal report page numbers.
  outgoing: boolean;
  documentNumber: string;
  date: string;
  partnerLabel: string | null;
  partner: PartnerBlock | null;
  references: { label: string; value: string }[];
  sections: { label: string; text: string }[];
}

// Löneunderlag — the printable payroll basis for a period: one section per
// employee with pre-formatted label/hours rows (formatting, zero-row
// skipping and Swedish labels all happen in the payroll service; this
// renderer only lays out what it is given).
export interface PayrollReportPdfInput {
  periodLabel: string; // "Löneunderlag juni 2026"
  status: string; // "Låst 2026-07-05" | "Ej låst (preliminärt)"
  employees: {
    employeeNumber: string;
    name: string;
    employmentTypeLabel: string;
    rows: { label: string; hours: string }[];
  }[];
}

// Ekonomirapporter (B6a). Same division of labour as the payroll report:
// the economy service formats every amount and Swedish label, these
// renderers only lay out what they are given — which is why every amount
// below is already a string.

// Balansräkning and resultaträkning share this shape: a flat sequence of
// rows whose `kind` decides indentation, weight and rules.
export interface FinancialStatementPdfInput {
  title: string;
  subtitle: string;
  // Resultaträkningen med budget: column headings; every row then carries
  // `amounts` (one per column, right-aligned) and `amount` is ignored. More
  // than four columns go landscape.
  columns?: string[];
  rows: {
    kind: "group" | "line" | "account" | "subtotal" | "total";
    label: string;
    // null = a heading with no figure of its own.
    amount: string | null;
    amounts?: string[];
  }[];
}

export interface GeneralLedgerPdfInput {
  title: string;
  subtitle: string;
  accounts: {
    heading: string;
    openingAmount: string;
    closingAmount: string;
    rows: { date: string; verification: string; text: string; debit: string; credit: string; balance: string }[];
  }[];
  emptyText: string;
}

// Avskrivningsplan (anläggningsregistret): one block per tillgångsgrupp —
// asset rows, then two movement lines (anskaffningsvärde IB→UB, ack IB→UB)
// — a totals row and the reconciliation lines. Economy formats every amount.
export interface FixedAssetPlanPdfInput {
  title: string;
  subtitle: string;
  categories: {
    heading: string;
    rows: { number: string; name: string; acquired: string; cost: string; yearDepreciation: string; accumulated: string; bookValue: string }[];
    movement: string[];
  }[];
  totals: { cost: string; yearDepreciation: string; accumulated: string; bookValue: string };
  reconciliation: string[];
  emptyText: string;
}

export interface VerificationListPdfInput {
  title: string;
  subtitle: string;
  verifications: {
    heading: string;
    rows: { account: string; text: string; debit: string; credit: string }[];
    totalDebit: string;
    totalCredit: string;
  }[];
  emptyText: string;
}

// Orderförteckning (reports module formats every cell). Landscape A4: one
// line per order, or — withRows — an order heading line followed by its rows.
export interface OrderRegisterPdfInput {
  title: string;
  subtitle: string;
  partnerLabel: string; // "Kund" / "Leverantör"
  doneLabel: string; // "Levererat" / "Mottaget"
  withRows: boolean;
  orders: {
    orderNumber: string;
    orderDate: string;
    partner: string;
    status: string;
    deliveryDate: string;
    currency: string;
    orderValue: string;
    restValue: string;
    rows: {
      articleNumber: string;
      articleName: string;
      quantity: string;
      done: string;
      rest: string;
      unit: string;
      unitPrice: string;
      amount: string;
      restAmount: string;
      deliveryDate: string;
    }[];
  }[];
  totals: { label: string; orderValue: string; restValue: string };
  emptyText: string;
}

// Räknelista (D2) — count sheet for a stock-count session: article rows with
// an empty "Räknat" column to fill in by hand. Blind by default: the booked
// balance column only prints when showBalances is set.
export interface StockCountSheetPdfRow {
  articleNumber: string;
  articleName: string;
  unit: string | null;
  snapshotQuantity: number | null; // null when hidden (blind count)
}

export interface StockCountSheetPdfInput {
  documentNumber: string;
  printedAt: Date;
  warehouseName: string;
  locationName: string;
  blocksTransactions: boolean;
  note: string | null;
  showBalances: boolean;
  rows: StockCountSheetPdfRow[];
}

// Tillverkningsorder — the shop-floor printout handed to the operator.
export interface ManufacturingOrderPdfInput {
  orderNumber: string;
  printedAt: Date;
  articleNumber: string;
  articleName: string;
  quantity: string;
  statusLabel: string;
  note: string | null;
  // E3 (KO→TO-koppling, Task 6): set only when the MO is linked to a sales
  // order row — rendered as an extra "Kundorder:" header line, omitted
  // entirely (not even a blank line) when null/undefined.
  salesOrderRef?: { orderNumber: string; customerName: string } | null;
  // E2: planned finish date — header line, omitted when null.
  dueDate?: string | null;
  // Konfigurator 4c: a beställningsvara's choices, "Grupp: Värde" (no prices) —
  // printed under the article line in the header. Omitted/empty ⇒ nothing.
  configurationLines?: string[];
  // The article's Extra benämning (multi-line) — printed under the article
  // line when the setting lists the manufacturing order.
  extraDescription?: string | null;
  operations: {
    sequenceNo: number;
    workCenterName: string;
    /** The resource's three-digit code — printed with the operation. */
    workCenterCode?: string;
    /**
     * "Beskrivning" — what the step IS, snapshotted at release. It takes the
     * place of the resource NAME in the Operation column (the table is
     * already exactly CONTENT_WIDTH wide, so there is no room for a column of
     * its own); the resource stays visible as its code. Falls back to the
     * resource name when the operation has no description.
     */
    description?: string | null;
    setupTime: string;
    runTimePerUnit: string;
    // Display preference snapshotted at release — runTimePerUnit is always in
    // minutes per unit; "units_per_hour" prints as "st/h" (60/runTimePerUnit)
    // instead. Optional so existing work-card.test.ts fixtures keep compiling.
    timeUnit?: "minutes_per_unit" | "units_per_hour" | "seconds_per_unit";
    estimatedTime: number;
    // "Kommentar" on the routing operation, snapshotted at release. Rendered
    // as an indented line under the operation row, and only when the
    // beredare ticked "Skriv ut på arbetskortet".
    comment?: string | null;
    printOnWorkCard?: boolean;
    // "Packinstruktion" — how the articles are packed ahead of the next
    // operation/shipment, snapshotted at release. Rendered as an indented
    // line under the operation row, ALWAYS when set (shop-floor
    // information, unlike the comment it is not gated by printOnWorkCard).
    packingInstructions?: string | null;
  }[];
  materials: {
    articleNumber: string;
    articleName: string;
    quantityPlanned: string;
    quantityConsumed: string;
    unit: string;
    // Sequence number of the operation this material is linked to
    // (mo_material_consumptions.mo_operation_id); null/undefined when the
    // material is unlinked and drawn at final reporting instead — rendered
    // as "—". Optional so existing work-card.test.ts fixtures keep compiling.
    operationSequenceNo?: number | null;
  }[];
}

// Pallkort (pallet card) — the paper placed ON the pallet when an operation
// is reported or a delivery leaves the building. Printed on the TOP HALF of
// a portrait A4 so the sheet can be folded in the middle and still show the
// whole card. Two variants: "final" (last operation of a KO-linked TO, or a
// customer delivery — carries the customer and order numbers, TILL KUND) and
// "internal" (a pallet moving to the next operation on the shop floor,
// INTERNT). Everything is pre-formatted by the calling service (mail owns
// the paper, the modules own the content) — the renderer only lays out
// label/value pairs in big type readable from a distance.
//
// Kod på pallkort: `code` says which machine-readable code the article
// number and the order number get — none (the plain card), a Code 128
// barcode under the value or a QR code beside it. The SERVICE resolves the
// effective type (customer's choice ?? system setting); the renderer never
// reads settings. Omitted = none, so every existing call renders as before.
export type PalletCardCodeType = "none" | "barcode" | "qr";

interface PalletCardCommon {
  articleNumber: string;
  articleName?: string | null;
  quantity: number;
  unit?: string | null;
  code?: PalletCardCodeType;
  // Datum in the card's footer — the event's time (the report's created_at,
  // the delivery's delivered_at) or the print time. Formatted in
  // Europe/Stockholm. Omitted = now, so the date is always printed.
  printedAt?: Date;
  // Rapporterad av — the employee/user who reported; omitted when unknown.
  reportedBy?: string | null;
  // The footer's reference: "FS-123" on a delivery card, "TO-456 · op 20" on
  // an operation card.
  reference?: string | null;
  // Kolli: this card's number among the cards printed for the same row/
  // operation — "Kolli 2 av 3", always printed; omitted ⇒ "Kolli 1 av 1".
  parcel?: { index: number; count: number };
}

export type PalletCardPdfInput =
  | (PalletCardCommon & {
      kind: "final";
      customerName: string;
      // Kundens ordernummer — may be missing on the order; rendered as "—".
      customerOrderNumber: string | null;
      // Vårt kundordernummer (the sales order's own number).
      orderNumber: string;
      // The sales order's chosen delivery address (null = no LEVERANSADRESS
      // cell at all).
      deliveryAddress?: { address: string; postalCode: string | null; city: string | null; country: string | null } | null;
    })
  | (PalletCardCommon & {
      kind: "internal";
      // The manufacturing order's number.
      orderNumber: string;
      // Pre-formatted "seq · description/resource" — null/omitted when this
      // was the last operation of an unlinked order (the cell prints "—").
      nextOperation?: string | null;
    });

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89; // A4 portrait, points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const TABLE_BOTTOM = 780;

// Manufacturing order column layouts.
const MO_OP_COLS = {
  seq: { x: 0, w: 30 },
  workCenter: { x: 35, w: 150 },
  setup: { x: 190, w: 65 },
  perUnit: { x: 260, w: 70 },
  estimated: { x: 335, w: 65 },
  done: { x: 405, w: 90 },
} as const;

const MO_MAT_COLS = {
  op: { x: 0, w: 25 },
  articleNumber: { x: 30, w: 95 },
  articleName: { x: 130, w: 120 },
  unit: { x: 255, w: 32 },
  planned: { x: 292, w: 56 },
  consumed: { x: 353, w: 56 },
  sign: { x: 414, w: 81 },
} as const;

// Pick list column layout: x offsets within the content area + widths.
const PICK_COLS = {
  articleNumber: { x: 0, w: 85 },
  articleName: { x: 90, w: 135 },
  quantity: { x: 230, w: 55 },
  unit: { x: 290, w: 40 },
  locations: { x: 335, w: 115 },
  picked: { x: 455, w: 40 },
} as const;

// Räknelista (D2) column layout: x offsets within the content area + widths.
const COUNT_COLS = {
  articleNumber: { x: 0, w: 100 },
  articleName: { x: 105, w: 190 },
  unit: { x: 300, w: 45 },
  balance: { x: 350, w: 70 },
  counted: { x: 430, w: 65 },
} as const;

// Delivery note (följesedel) column layout: x offsets within the content
// area + widths.
const DELIVERY_NOTE_COLS = {
  articleNumber: { x: 0, w: 90 },
  articleName: { x: 95, w: 180 },
  quantity: { x: 280, w: 70 },
  unit: { x: 355, w: 50 },
  priorDelivered: { x: 410, w: 85 },
} as const;

// Löneunderlag: label/hours two-column layout — hours right-aligned in a
// narrow column, label takes the rest of the content width.
const PAYROLL_COLS = {
  label: { x: 0, w: 400 },
  hours: { x: 400, w: 95 },
} as const;

// B6a report layouts.
const STATEMENT_AMOUNT_COL = { x: 385, w: 110 } as const;

const LEDGER_COLS = {
  date: { x: 0, w: 60 },
  verification: { x: 62, w: 75 },
  text: { x: 140, w: 155 },
  debit: { x: 297, w: 62 },
  credit: { x: 361, w: 62 },
  balance: { x: 425, w: 70 },
} as const;

const FIXED_ASSET_PLAN_COLS = {
  number: { x: 0, w: 42 },
  name: { x: 46, w: 132 },
  acquired: { x: 182, w: 52 },
  cost: { x: 238, w: 64 },
  yearDepreciation: { x: 306, w: 60 },
  accumulated: { x: 370, w: 62 },
  bookValue: { x: 436, w: 59 },
} as const;

// Orderförteckning, landscape content width ≈ 742 pt.
const ORDER_REGISTER_TABLE_BOTTOM = 530;
const ORDER_REGISTER_ORDER_COLS = {
  orderNumber: { x: 0, w: 75 },
  orderDate: { x: 78, w: 60 },
  partner: { x: 141, w: 215 },
  status: { x: 359, w: 95 },
  deliveryDate: { x: 457, w: 76 },
  currency: { x: 536, w: 36 },
  orderValue: { x: 575, w: 82 },
  restValue: { x: 660, w: 82 },
} as const;
const ORDER_REGISTER_ROW_COLS = {
  articleNumber: { x: 12, w: 80 },
  articleName: { x: 95, w: 165 },
  quantity: { x: 263, w: 52 },
  done: { x: 318, w: 52 },
  rest: { x: 373, w: 52 },
  unit: { x: 428, w: 32 },
  unitPrice: { x: 463, w: 62 },
  amount: { x: 528, w: 72 },
  restAmount: { x: 603, w: 72 },
  deliveryDate: { x: 680, w: 62 },
} as const;

const VERIFICATION_LIST_COLS = {
  account: { x: 0, w: 200 },
  text: { x: 205, w: 165 },
  debit: { x: 372, w: 60 },
  credit: { x: 435, w: 60 },
} as const;

// Column layout: x offsets within the content area + widths. C3 added
// "discount" between À-pris and Summa — same total width as before.
// Two layouts for the order-document table: the Rabatt column only exists
// when some row actually carries a discount (C3 follow-up — inquiry/PO rows
// never do, and an empty header column stole ~47 pt from Benämning there).
// Without it, Benämning reclaims the width and Summa keeps its position.
const COLS_WITH_DISCOUNT = {
  articleNumber: { x: 0, w: 90 },
  articleName: { x: 95, w: 148 },
  quantity: { x: 248, w: 48 },
  unit: { x: 300, w: 40 },
  unitPrice: { x: 345, w: 50 },
  discount: { x: 398, w: 44 },
  amount: { x: 445, w: 50 },
} as const;

const COLS_NO_DISCOUNT = {
  articleNumber: { x: 0, w: 90 },
  articleName: { x: 95, w: 195 },
  quantity: { x: 295, w: 48 },
  unit: { x: 347, w: 40 },
  unitPrice: { x: 392, w: 50 },
  amount: { x: 445, w: 50 },
} as const;

function colsFor(hasDiscount: boolean) {
  return hasDiscount ? COLS_WITH_DISCOUNT : (COLS_NO_DISCOUNT as typeof COLS_WITH_DISCOUNT & { discount?: undefined });
}

// Exported for the B6a economy reports, which format their own amounts
// (economy owns the content, mail owns the paper) and therefore need this
// function's WinAnsi handling — a balance sheet is full of negative numbers.
export function formatNumber(value: number, decimals = 2): string {
  // sv-SE renders a negative sign as U+2212 (MINUS SIGN), which the
  // Helvetica standard font's WinAnsiEncoding has no glyph for — pdfkit
  // silently substitutes the wrong character. Credit notes are the first
  // caller to ever feed a negative amount through here, so normalize to the
  // plain ASCII hyphen-minus WinAnsi does support; positive output (every
  // other document) is unaffected.
  return value
    .toLocaleString("sv-SE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace("−", "-");
}

// "2026-10-20 14:32" in Europe/Stockholm — the pallet card's Datum, so a
// container running UTC still prints the clock the operator saw.
const STOCKHOLM_DATE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
export function formatStockholmDateTime(date: Date): string {
  return STOCKHOLM_DATE_TIME.format(date);
}

// Times on the work card: comma decimal, at most two decimals and no
// trailing zeros — "10 min", "6 min", "8,57 min", "7 st/h", never
// "6,0000 min" or "8,5714 min". A positive time too small for two decimals
// keeps two significant digits ("0,0042 min") instead of printing "0 min".
// Same WinAnsi minus handling as formatNumber.
function formatTime(value: number): string {
  const options = value > 0 && value < 0.005 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 };
  return value.toLocaleString("sv-SE", options).replace("−", "-");
}

function formatQuantity(raw: string): string {
  const n = Number(raw);
  return Number.isInteger(n) ? n.toLocaleString("sv-SE") : formatNumber(n);
}

// C3: the Rabatt column's cell text — "<n> %" in formatQuantity's style
// (whole percentages print without decimals), or "" for null/undefined/0 so
// a document with no discounted rows renders with a visibly empty column.
function formatDiscount(raw: string | null | undefined): string {
  if (raw == null || Number(raw) === 0) return "";
  return `${formatQuantity(raw)} %`;
}

// C3: a row's own discount as a 0-1 fraction (0 for null/undefined) — shared
// by the row table's fallback amount and computePerRowVatGroups' fallback
// net below, so both compute the same number for a row with no stored
// lineAmount.
function discountFactor(raw: string | null | undefined): number {
  return raw == null ? 0 : Number(raw) / 100;
}

// Groups invoice rows by vatRate for the perRow VAT summary — net amount and
// the VAT it implies, sorted highest rate first. Rows with no price (never
// true for invoices, but rows is a shared type) are excluded, same as the
// row table. Net/VAT PREFER the row's stored lineAmount/vatAmount (the
// authoritative, already-round2:ed figures the ledger/API also sum) — the
// VAT total is therefore the SUM of each row's own rounded VAT, not a
// recomputation on the summed net, which is exactly what can diverge by a
// rounding öre on multi-row/odd-rate invoices. Rows without stored amounts
// (every non-invoice document type reusing this renderer) fall back to the
// original quantity × unitPrice × (1 − discount) / net × rate formula,
// mirroring the row table's own fallback below — C3 added the discount
// factor there (an invoice row always has lineAmount, so this branch is
// currently only exercised by non-invoice callers, but it stays consistent
// with the row table regardless).
//
// Momskoder: rows carrying a vatCode group per code (rate + code) — sorted
// highest rate first, then in catalog order — and each group knows the
// code's name, so the summary can print a 0 % EU sale and a momsfri row as
// two lines. Rows without a vatCode group by rate alone (code null).
export type PerRowVatGroup = { rate: number; code: string | null; name: string | null; net: number; vatAmount: number };

export function computePerRowVatGroups(rows: DocumentPdfRow[]): PerRowVatGroup[] {
  const groups = new Map<string, PerRowVatGroup>();
  for (const row of rows) {
    if (row.unitPrice === null) continue;
    const rate = row.vatRate ?? 0;
    const net =
      row.lineAmount != null
        ? Number(row.lineAmount)
        : Number(row.quantity) * Number(row.unitPrice) * (1 - discountFactor(row.discountPercent));
    const vatAmount = row.vatAmount != null ? Number(row.vatAmount) : net * (rate / 100);
    const code = row.vatCode?.code ?? null;
    const key = `${rate}|${code ?? ""}`;
    const group = groups.get(key) ?? { rate, code, name: row.vatCode?.name ?? null, net: 0, vatAmount: 0 };
    group.net += net;
    group.vatAmount += vatAmount;
    groups.set(key, group);
  }
  const catalogIndex = (code: string | null) => (code === null ? -1 : (VAT_CODES as readonly string[]).indexOf(code));
  return [...groups.values()].sort((a, b) => b.rate - a.rate || catalogIndex(a.code) - catalogIndex(b.code));
}

// A summary group prints a line when it has VAT, or when it is a 0 % CODE
// (its name tells the reader why there is no VAT); a bare 0 % rate group
// (no code — documents from before the momskoder) prints none, as before.
function vatGroupPrints(group: PerRowVatGroup): boolean {
  return group.rate !== 0 || group.code !== null;
}

function vatGroupLabel(group: PerRowVatGroup): string {
  return group.rate !== 0 ? `Moms (${group.rate} %)` : (group.name ?? "Moms (0 %)");
}

// 8pt grey info lines under a row's name. A line may hold "\n" (Extra
// benämning) or wrap in the column, so each takes 11pt per PRINTED line —
// measured here once and reused by the drawing, so the row height and the
// drawing can never disagree.
function measureInfoLines(doc: PDFKit.PDFDocument, lines: string[], width: number) {
  doc.fontSize(8);
  const single = doc.heightOfString("X", { width });
  const counts = lines.map((line) => Math.max(1, Math.round(doc.heightOfString(line, { width }) / single)));
  doc.fontSize(9);
  return { single, counts, height: counts.reduce((sum, count) => sum + count, 0) * 11 };
}

function drawInfoLines(
  doc: PDFKit.PDFDocument,
  lines: string[],
  measured: ReturnType<typeof measureInfoLines>,
  x: number,
  y: number,
  width: number
) {
  if (lines.length === 0) return;
  doc.fontSize(8).fillColor("#666666");
  let infoY = y;
  lines.forEach((line, i) => {
    doc.text(line, x, infoY, { width, lineGap: 11 - measured.single });
    infoY += measured.counts[i]! * 11;
  });
  doc.fontSize(9).fillColor("#000000");
}

export function createDocumentPdfService(system: Pick<SystemService, "getCompanyInfo" | "getLogo">) {
  // Shared scaffolding: a new A4 document with the company header + logo
  // drawn, plus the promise that resolves to the finished buffer.
  // `landscape` is for wide internal reports (orderförteckningen); every
  // page-size-dependent position below reads doc.page, not the portrait
  // constants.
  async function startDocument(options: { landscape?: boolean } = {}) {
    const [company, logo] = await Promise.all([system.getCompanyInfo(), system.getLogo()]);

    // bufferPages keeps pages addressable so the footer can be stamped on
    // every page after the content is laid out.
    const doc = new PDFDocument({
      size: "A4",
      layout: options.landscape ? "landscape" : "portrait",
      margin: PAGE_MARGIN,
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    const left = PAGE_MARGIN;

    // Company name/address/logo strip. Extracted into a redrawable closure
    // for documents where every PAGE is a standalone paper (the pallet card
    // prints one card per page, and each card goes on its own pallet) —
    // every other renderer draws it once, on the first page only.
    const drawHeader = () => {
      doc.font("Helvetica-Bold").fontSize(14).text(company?.name || "", left, PAGE_MARGIN);
      doc.font("Helvetica").fontSize(9).fillColor("#444444");
      const companyLines = [
        company?.address,
        [company?.postalCode, company?.city].filter(Boolean).join(" "),
        [company?.phone, company?.email].filter(Boolean).join(" · "),
      ].filter((line): line is string => Boolean(line));
      for (const line of companyLines) doc.text(line);
      doc.fillColor("#000000");

      // Logo top-right. pdfkit reads PNG/JPEG buffers; anything else is skipped.
      if (logo?.logo) {
        try {
          doc.image(logo.logo, doc.page.width - PAGE_MARGIN - 120, PAGE_MARGIN - 5, { fit: [120, 45], align: "right" });
        } catch {
          // Unsupported image format — render without logo rather than failing the document.
        }
      }
    };
    drawHeader();

    return { doc, finished, company, drawHeader };
  }

  // Payment/registration footer stamped on every page of OUTGOING documents
  // (inquiry, purchase order, quote, order confirmation). Internal documents
  // (pick list, TO printout) stay clean. Empty fields are skipped entirely.
  function drawFooter(doc: typeof PDFDocument.prototype, company: Awaited<ReturnType<SystemService["getCompanyInfo"]>>) {
    const registrationLine = [
      company?.orgNumber ? `Org.nr: ${company.orgNumber}` : null,
      company?.vatNumber ? `VAT-nr: ${company.vatNumber}` : null,
      company?.companySeat ? `Säte: ${company.companySeat}` : null,
      company?.fSkatt ? "Godkänd för F-skatt" : null,
    ].filter(Boolean);
    const paymentLine = [
      company?.bankgiro ? `Bankgiro: ${company.bankgiro}` : null,
      company?.plusgiro ? `Plusgiro: ${company.plusgiro}` : null,
      company?.bankName ? `Bank: ${company.bankName}` : null,
      company?.iban ? `IBAN: ${company.iban}` : null,
      company?.bic ? `BIC: ${company.bic}` : null,
    ].filter(Boolean);
    const contactLine = [company?.phone, company?.email, company?.website].filter(Boolean);

    const lines = [registrationLine, paymentLine, contactLine]
      .filter((parts) => parts.length > 0)
      .map((parts) => parts.join(" · "));
    if (lines.length === 0) return;

    const left = PAGE_MARGIN;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Zeroed bottom margin so writing inside it doesn't trigger a new page.
      const previousBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;

      let y = 838 - lines.length * 10 - 6;
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 5;
      doc.font("Helvetica").fontSize(7.5).fillColor("#666666");
      for (const line of lines) {
        doc.text(line, left, y, { width: CONTENT_WIDTH, align: "center", lineBreak: false });
        y += 10;
      }
      doc.fillColor("#000000");

      doc.page.margins.bottom = previousBottom;
    }
  }

  // "Sida X av Y" stamped bottom-right on every page of INTERNAL documents
  // (reports, pick list, count sheet, TO printout, payroll) once the content
  // is laid out — bufferPages keeps them addressable, same mechanism as
  // drawFooter. Single-page documents stay unnumbered. Outgoing documents
  // keep their payment footer instead; the two would share the same strip.
  function drawPageNumbers(doc: typeof PDFDocument.prototype) {
    const range = doc.bufferedPageRange();
    if (range.count <= 1) return;
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Zeroed bottom margin so writing inside it doesn't trigger a new page.
      const previousBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(7.5).fillColor("#666666");
      doc.text(`Sida ${i - range.start + 1} av ${range.count}`, PAGE_MARGIN, doc.page.height - 30, {
        width: doc.page.width - PAGE_MARGIN * 2,
        align: "right",
        lineBreak: false,
      });
      doc.fillColor("#000000");
      doc.page.margins.bottom = previousBottom;
    }
  }

  // Framed payment box (OCR-nummer / Bankgiro / Plusgiro / Förfallodatum)
  // drawn above the footer once the amounts are done, shared by the invoice
  // and the payment reminder — a reminder that printed a different payment
  // box than the invoice it reminds about would be a support case waiting to
  // happen. `company` is the object the caller already loaded (and the footer
  // uses) — no second fetch. Empty lines are skipped; nothing to print draws
  // no box at all. Returns the y to continue at.
  function drawPaymentBox(
    doc: typeof PDFDocument.prototype,
    company: Awaited<ReturnType<SystemService["getCompanyInfo"]>>,
    startY: number,
    payment: { ocrNumber: string | null; dueDate: Date | null }
  ): number {
    const boxLines = [
      payment.ocrNumber ? `OCR-nummer: ${payment.ocrNumber}` : null,
      company?.bankgiro ? `Bankgiro: ${company.bankgiro}` : null,
      company?.plusgiro ? `Plusgiro: ${company.plusgiro}` : null,
      payment.dueDate ? `Förfallodatum: ${payment.dueDate.toISOString().slice(0, 10)}` : null,
    ].filter((line): line is string => Boolean(line));
    if (boxLines.length === 0) return startY;

    let y = startY + 14;
    const boxHeight = 14 + boxLines.length * 14 + 20;
    // Same page-break guard idiom as the VAT block — a framed box colliding
    // with the footer is worse than starting it on a fresh page.
    if (y + boxHeight > TABLE_BOTTOM) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, boxHeight).strokeColor("#cccccc").lineWidth(0.5).stroke();
    let by = y + 10;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#888888").text("BETALNING", PAGE_MARGIN + 12, by);
    by += 14;
    doc.font("Helvetica").fontSize(10).fillColor("#000000");
    for (const line of boxLines) {
      doc.text(line, PAGE_MARGIN + 12, by);
      by += 14;
    }
    return y + boxHeight;
  }

  async function render(input: DocumentPdfInput): Promise<Buffer> {
    const { doc, finished, company } = await startDocument();
    const left = PAGE_MARGIN;

    // --- Document title ---
    let y = 130;
    const numberWithRevision = `${input.documentNumber}${input.revision != null ? ` / ${input.revision}` : ""}`;
    doc.font("Helvetica-Bold").fontSize(18).text(`${input.title} ${numberWithRevision}`, left, y);
    y += 26;
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#444444")
      .text(`Datum: ${input.date.toISOString().slice(0, 10)}`, left, y);
    y += 14;
    if (input.dueDate) {
      doc.text(`Förfallodatum: ${input.dueDate.toISOString().slice(0, 10)}`, left, y);
      y += 14;
    }
    if (input.orderReference) {
      doc.text(`Ordernummer: ${input.orderReference}`, left, y);
      y += 14;
    }
    if (input.quoteReference) {
      doc.text(`Vår offert: ${input.quoteReference}`, left, y);
      y += 14;
    }
    if (input.partnerNumber) {
      doc.text(`Kundnr: ${input.partnerNumber}`, left, y);
      y += 14;
    }
    if (input.buyerVatNumber && input.buyerVatNumber.trim() !== "") {
      doc.text(`Ert momsreg.nr: ${input.buyerVatNumber.trim()}`, left, y);
      y += 14;
    }
    if (input.customerOrderNumber) {
      doc.text(`Ert ordernummer: ${input.customerOrderNumber}`, left, y);
      y += 14;
    }
    if (input.customerInquiryNumber) {
      doc.text(`Er förfrågan: ${input.customerInquiryNumber}`, left, y);
      y += 14;
    }
    if (input.yourReference) {
      doc.text(`Er referens: ${input.yourReference}`, left, y);
      y += 14;
    }
    if (input.ourReference) {
      doc.text(`Vår referens: ${input.ourReference}`, left, y);
      y += 14;
    }
    if (input.requestedDeliveryDate) {
      doc.text(`Önskat leveransdatum: ${input.requestedDeliveryDate}`, left, y);
      y += 14;
    }
    if (input.deliveryDate) {
      doc.text(`Leveransdatum: ${input.deliveryDate}`, left, y);
      y += 14;
    }
    if (input.validUntil) {
      doc.text(`Offerten gäller till och med ${input.validUntil}.`, left, y);
      y += 14;
    }
    if (input.ourCustomerNumberAtSupplier) {
      doc.text(`Vårt kundnummer hos er: ${input.ourCustomerNumberAtSupplier}`, left, y);
      y += 14;
    }
    if (input.ourSupplierNumberAtCustomer) {
      doc.text(`Vårt leverantörsnr hos er: ${input.ourSupplierNumberAtCustomer}`, left, y);
      y += 14;
    }
    doc.fillColor("#000000");
    y += 10;

    // --- Partner address block (+ delivery address block beside it) ---
    const blockTop = y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#888888").text(input.partnerLabel.toUpperCase(), left, y);
    y += 13;
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(11).text(input.partner.name, left, y);
    y += 15;
    doc.font("Helvetica").fontSize(10);
    const partnerLines = addressLines(input.partner);
    for (const line of partnerLines) {
      doc.text(line, left, y);
      y += 14;
    }

    if (input.deliveryAddress) {
      const deliveryX = left + 260;
      let dy = blockTop;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#888888").text("LEVERANSADRESS", deliveryX, dy);
      dy += 13;
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(11).text(input.deliveryAddress.label, deliveryX, dy);
      dy += 15;
      doc.font("Helvetica").fontSize(10);
      const deliveryLines = addressLines(input.deliveryAddress);
      for (const line of deliveryLines) {
        doc.text(line, deliveryX, dy, { width: CONTENT_WIDTH - 260 });
        dy += doc.heightOfString(line, { width: CONTENT_WIDTH - 260 });
      }
      y = Math.max(y, dy);
    }
    y += 20;

    // --- Terms (leverans-/betalningsvillkor, speditör) ---
    const termLines = [
      input.deliveryTerm ? `Leveransvillkor: ${input.deliveryTerm}` : null,
      input.paymentTerm ? `Betalningsvillkor: ${input.paymentTerm}` : null,
      input.carrier
        ? `Speditör: ${input.carrier}${input.carrierCustomerNumber ? ` · Vårt kundnr: ${input.carrierCustomerNumber}` : ""}`
        : null,
      input.lateInterestText ?? null,
    ].filter((line): line is string => Boolean(line));
    if (termLines.length > 0) {
      doc.font("Helvetica").fontSize(10).fillColor("#444444");
      for (const line of termLines) {
        doc.text(line, left, y);
        y += 14;
      }
      doc.fillColor("#000000");
      y += 10;
    }

    if (input.pricesIncludeVat) {
      doc.font("Helvetica").fontSize(10).fillColor("#444444").text("Priser inklusive moms", left, y);
      doc.fillColor("#000000");
      y += 18;
    }

    // --- Row table ---
    // The Rabatt column only exists when some row carries a discount —
    // inquiry/PO rows never do, and their Benämning reclaims the width.
    const COLS = colsFor(input.rows.some((row) => Number(row.discountPercent ?? 0) !== 0));
    const drawTableHeader = () => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#555555");
      doc.text("Artikelnummer", left + COLS.articleNumber.x, y, { width: COLS.articleNumber.w });
      doc.text("Benämning", left + COLS.articleName.x, y, { width: COLS.articleName.w });
      doc.text("Antal", left + COLS.quantity.x, y, { width: COLS.quantity.w, align: "right" });
      doc.text("Enhet", left + COLS.unit.x, y, { width: COLS.unit.w });
      doc.text("À-pris", left + COLS.unitPrice.x, y, { width: COLS.unitPrice.w, align: "right" });
      if (COLS.discount) doc.text("Rabatt", left + COLS.discount.x, y, { width: COLS.discount.w, align: "right" });
      doc.text("Summa", left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
      y += 14;
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 8;
      doc.fillColor("#000000").font("Helvetica").fontSize(9);
    };

    drawTableHeader();

    let total = 0;
    let hasUnpricedRows = false;
    for (const row of input.rows) {
      const nameHeight = doc.heightOfString(row.articleName, { width: COLS.articleName.w });
      // 8pt info lines under the name: revision, plus the lego row's TO
      // reference / ställpris / nettovikt (each on its own line), and the
      // configured row's choices (konfigurator 4b).
      const infoLines = [
        row.customerArticleNumber ? `Ert art.nr: ${row.customerArticleNumber}` : null,
        row.setupForArticleNumber ? `Ställkostnad för ${row.setupForArticleNumber}` : null,
        row.revisionInfo ?? null,
        row.articleInfo ?? null,
        row.extraDescription ?? null,
        ...(row.configurationLines ?? []),
        row.moReference ?? null,
        // The order reference and the invoice row's Leveransdatum share one
        // sub-line ("Order KO… · Ert ordernr … · Levererad 2026-10-01").
        [row.orderReference ?? null, row.deliveredDate ? `Levererad ${row.deliveredDate}` : null]
          .filter((part): part is string => part !== null)
          .join(" · ") || null,
        row.setupPrice != null ? `Ställpris: ${formatNumber(Number(row.setupPrice))} ${input.currency}` : null,
        row.netWeightKg != null ? `Nettovikt: ${formatNumber(row.netWeightKg, 1)} kg` : null,
        row.requestedDeliveryDate ? `Önskat leveransdatum: ${row.requestedDeliveryDate}` : null,
        row.deliveryDate ? `Leveransdatum: ${row.deliveryDate}` : null,
      ].filter((line): line is string => line !== null);
      // An info line that wraps in the name column (a long order reference
      // with its Levererad date) takes 11pt per printed line, not one slot.
      doc.fontSize(8);
      const singleInfoLine = doc.heightOfString("X", { width: COLS.articleName.w });
      const infoLineCounts = infoLines.map((line) =>
        Math.max(1, Math.round(doc.heightOfString(line, { width: COLS.articleName.w }) / singleInfoLine))
      );
      doc.fontSize(9);
      const infoHeight = infoLineCounts.reduce((sum, count) => sum + count, 0) * 11;
      const rowHeight = Math.max(nameHeight + infoHeight, 11) + 6;
      if (y + rowHeight > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
        drawTableHeader();
      }
      const quantity = Number(row.quantity);
      const unitPrice = row.unitPrice === null ? null : Number(row.unitPrice);
      // Stored lineAmount is the authority when present (see DocumentPdfRow's
      // comment) — quantity/unitPrice are display-unit-converted and can
      // diverge from it by a rounding öre. Falls back to quantity ×
      // unitPrice × (1 − discount) for every document type that never sets
      // lineAmount (C3 added the discount factor, mirrored in
      // computePerRowVatGroups' own fallback above). A lego row's one-off
      // ställpris is added once on top.
      const rowAmount =
        (row.lineAmount != null
          ? Number(row.lineAmount)
          : quantity * unitPrice! * (1 - discountFactor(row.discountPercent))) +
        (row.setupPrice != null ? Number(row.setupPrice) : 0);
      if (unitPrice === null) hasUnpricedRows = true;
      else total += rowAmount;

      // Privatperson: the printed à-pris/Summa cells carry VAT; `total` stays
      // net so the VAT grouping below is the same as for every other document.
      const vatRateFraction = (row.vatRate ?? 0) / 100;
      const shownUnitPrice =
        unitPrice === null ? null : input.pricesIncludeVat ? unitPrice * (1 + vatRateFraction) : unitPrice;
      const shownAmount = input.pricesIncludeVat
        ? rowAmount + (row.vatAmount != null ? Number(row.vatAmount) : rowAmount * vatRateFraction)
        : rowAmount;

      doc.text(row.articleNumber, left + COLS.articleNumber.x, y, { width: COLS.articleNumber.w });
      doc.text(row.articleName, left + COLS.articleName.x, y, { width: COLS.articleName.w });
      doc.text(formatQuantity(row.quantity), left + COLS.quantity.x, y, { width: COLS.quantity.w, align: "right" });
      doc.text(row.unit ?? "", left + COLS.unit.x, y, { width: COLS.unit.w });
      doc.text(shownUnitPrice === null ? "–" : formatNumber(shownUnitPrice), left + COLS.unitPrice.x, y, {
        width: COLS.unitPrice.w,
        align: "right",
      });
      if (COLS.discount)
        doc.text(formatDiscount(row.discountPercent), left + COLS.discount.x, y, {
          width: COLS.discount.w,
        align: "right",
      });
      doc.text(unitPrice === null ? "–" : formatNumber(shownAmount), left + COLS.amount.x, y, {
        width: COLS.amount.w,
        align: "right",
      });
      if (infoLines.length > 0) {
        doc.fontSize(8).fillColor("#666666");
        let infoY = y + nameHeight + 1;
        infoLines.forEach((line, i) => {
          doc.text(line, left + COLS.articleName.x, infoY, { width: COLS.articleName.w, lineGap: 11 - singleInfoLine });
          infoY += infoLineCounts[i]! * 11;
        });
        doc.fontSize(9).fillColor("#000000");
      }
      y += rowHeight;
    }

    doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
    y += 10;

    // perRow needs to know how many distinct non-zero-rate "Moms (X %)"
    // lines it will print before deciding whether the block still fits on
    // this page — computed once and reused by the drawing branch below so
    // the two can never disagree about the line count. null for every other
    // vat variant (legacy single-rate / no vat), which keeps their reserved
    // height the fixed three lines it always was.
    const perRowVatGroups =
      input.showTotal && input.vat && !("rate" in input.vat) ? computePerRowVatGroups(input.rows) : null;
    // The single-rate/no-vat block is always Summa + [Moms] + Att betala —
    // three 15pt lines. perRow reserves one 15pt row per distinct non-zero
    // rate instead (Summa + N Moms lines + Att betala), so 2+ rates don't
    // overflow the reserved space into the footer zone.
    const vatInSekLine = input.showTotal && input.vatInSek ? input.vatInSek : null;
    const vatBlockHeight = (perRowVatGroups ? (2 + perRowVatGroups.filter(vatGroupPrints).length) * 15 : 45) + (vatInSekLine ? 15 : 0);

    // Break to a fresh page rather than colliding with the footer when the
    // table ends near the bottom.
    if (input.showTotal && y + vatBlockHeight > TABLE_BOTTOM) {
      doc.addPage();
      y = PAGE_MARGIN;
    }

    if (input.showTotal && input.pricesIncludeVat) {
      // Privatperson: one gross line plus "Varav moms". The VAT is summed per
      // row through computePerRowVatGroups (stored vatAmount when present,
      // otherwise net × rate) — the same figures the cells above showed.
      const vatTotal = computePerRowVatGroups(input.rows).reduce((sum, g) => sum + g.vatAmount, 0);
      const labelX = left + COLS.quantity.x - 60;
      const labelW = COLS.unitPrice.x - COLS.quantity.x + 110;
      doc.font("Helvetica-Bold").fontSize(10);
      const grossLabel = input.vat ? `Att betala ${input.currency}` : `Summa inkl. moms ${input.currency}`;
      doc.text(grossLabel, labelX, y, { width: labelW, align: "right" });
      doc.text(formatNumber(total + vatTotal), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
      y += 15;
      doc.font("Helvetica").fontSize(10);
      doc.text("Varav moms", labelX, y, { width: labelW, align: "right" });
      doc.text(formatNumber(vatTotal), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
    } else if (input.showTotal && input.vat && "rate" in input.vat) {
      // Invoice totals: net, VAT and the amount to pay.
      const vatAmount = total * (input.vat.rate / 100);
      const labelX = left + COLS.quantity.x - 60;
      const labelW = COLS.unitPrice.x - COLS.quantity.x + 110;
      doc.font("Helvetica").fontSize(10);
      doc.text(`Summa exkl. moms ${input.currency}`, labelX, y, { width: labelW, align: "right" });
      doc.text(formatNumber(total), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
      y += 15;
      doc.text(`Moms (${input.vat.rate} %)`, labelX, y, { width: labelW, align: "right" });
      doc.text(formatNumber(vatAmount), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
      y += 15;
      doc.font("Helvetica-Bold").fontSize(10);
      doc.text(`Att betala ${input.currency}`, labelX, y, { width: labelW, align: "right" });
      doc.text(formatNumber(total + vatAmount), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
    } else if (input.showTotal && perRowVatGroups) {
      // Per-sats momssummering: one "Moms (X %)" line per distinct rate
      // present on the invoice, highest rate first. 0 %-rader contribute no
      // line of their own (their VAT is always 0) but their net amount still
      // counts toward "Summa exkl. moms"/"Att betala" via `total` above.
      const labelX = left + COLS.quantity.x - 60;
      const labelW = COLS.unitPrice.x - COLS.quantity.x + 110;
      doc.font("Helvetica").fontSize(10);
      doc.text(`Summa exkl. moms ${input.currency}`, labelX, y, { width: labelW, align: "right" });
      doc.text(formatNumber(total), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
      y += 15;
      let vatTotal = 0;
      for (const group of perRowVatGroups) {
        vatTotal += group.vatAmount;
        if (!vatGroupPrints(group)) continue;
        doc.text(vatGroupLabel(group), labelX, y, { width: labelW, align: "right" });
        doc.text(formatNumber(group.vatAmount), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
        y += 15;
      }
      doc.font("Helvetica-Bold").fontSize(10);
      doc.text(`Att betala ${input.currency}`, labelX, y, { width: labelW, align: "right" });
      doc.text(formatNumber(total + vatTotal), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
    } else if (input.showTotal) {
      doc.font("Helvetica-Bold").fontSize(10);
      const label = hasUnpricedRows ? `Summa (exkl. rader utan pris) ${input.currency}` : `Summa ${input.currency}`;
      doc.text(label, left + COLS.quantity.x - 60, y, { width: COLS.unitPrice.x - COLS.quantity.x + 110, align: "right" });
      doc.text(formatNumber(total), left + COLS.amount.x, y, { width: COLS.amount.w, align: "right" });
    }

    // Valuta: the VAT in SEK under the totals (ML 17 kap. 29 §).
    if (vatInSekLine) {
      y += 15;
      doc.font("Helvetica").fontSize(9).fillColor("#444444");
      doc.text(`Moms i SEK: ${formatNumber(vatInSekLine.amount)} (kurs ${formatNumber(vatInSekLine.rate, 6)})`, left, y, {
        width: CONTENT_WIDTH,
        align: "right",
      });
      doc.fillColor("#000000");
    }

    // Momskoder (spec 4.3): the codes' invoice texts, once each, under the
    // totals (ML 17 kap. 24 §: why no Swedish VAT is charged).
    const vatTexts = (input.vatTexts ?? []).filter((text) => text.trim() !== "");
    if (vatTexts.length > 0) {
      y += input.showTotal ? 24 : 10;
      doc.font("Helvetica").fontSize(9).fillColor("#444444");
      for (const text of vatTexts) {
        const height = doc.heightOfString(text, { width: CONTENT_WIDTH });
        if (y + height > TABLE_BOTTOM) {
          doc.addPage();
          y = PAGE_MARGIN;
        }
        doc.text(text, left, y, { width: CONTENT_WIDTH });
        y += height + 3;
      }
      doc.fillColor("#000000");
    }

    // Payment box (OCR/giro/förfallodatum), shared with the payment reminder.
    if (input.payment) y = drawPaymentBox(doc, company, y, input.payment);

    drawFooter(doc, company);
    doc.end();
    return finished;
  }

  // Betalningspåminnelse — an OUTGOING document (drawFooter, unlike the pick
  // list / TO printout), built on the same scaffolding as render() above but
  // with an amount summary instead of a row table: the customer already has
  // the invoice, what they need here is the level, what is left and how to
  // pay it.
  async function renderPaymentReminder(input: PaymentReminderPdfInput): Promise<Buffer> {
    const { doc, finished, company } = await startDocument();
    const left = PAGE_MARGIN;

    let y = 130;
    doc.font("Helvetica-Bold").fontSize(18).text(`Betalningspåminnelse ${input.level}`, left, y);
    y += 26;
    doc.font("Helvetica").fontSize(10).fillColor("#444444");
    doc.text(`Datum: ${input.printedAt.toISOString().slice(0, 10)}`, left, y);
    y += 14;
    // The reference block — which invoice this is about.
    doc.text(`Faktura ${input.documentNumber}`, left, y);
    y += 14;
    if (input.invoiceDate) {
      doc.text(`Fakturadatum: ${input.invoiceDate.toISOString().slice(0, 10)}`, left, y);
      y += 14;
    }
    if (input.dueDate) {
      doc.text(`Förfallodatum: ${input.dueDate.toISOString().slice(0, 10)}`, left, y);
      y += 14;
    }
    doc.fillColor("#000000");
    y += 10;

    // Address block — the invoice's frozen snapshot, same layout as render().
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#888888").text("FAKTURAADRESS", left, y);
    y += 13;
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(11).text(input.partner.name, left, y);
    y += 15;
    doc.font("Helvetica").fontSize(10);
    const partnerLines = addressLines(input.partner);
    for (const line of partnerLines) {
      doc.text(line, left, y);
      y += 14;
    }
    y += 20;

    const body = "Vi kan inte se att nedanstående faktura har betalats. Vänligen betala snarast.";
    doc.text(body, left, y, { width: CONTENT_WIDTH });
    y += doc.heightOfString(body, { width: CONTENT_WIDTH }) + 4;
    // Dröjsmålsränta: the terms and the accrued interest, as information.
    for (const line of [input.lateInterestText, input.accruedInterestText]) {
      if (!line) continue;
      doc.text(line, left, y, { width: CONTENT_WIDTH });
      y += doc.heightOfString(line, { width: CONTENT_WIDTH }) + 4;
    }
    y += 12;

    // Amount summary. Labels right-aligned into a wide column, amounts
    // right-aligned at the content edge — the same shape as the invoice's
    // Summa/Moms/Att betala block.
    const labelX = left + 150;
    const labelW = 250;
    const amountX = left + CONTENT_WIDTH - 90;
    const amountW = 90;
    const amountLine = (label: string, value: number, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      doc.text(label, labelX, y, { width: labelW, align: "right" });
      doc.text(formatNumber(value), amountX, y, { width: amountW, align: "right" });
      y += 15;
    };

    doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
    y += 10;
    amountLine(`Fakturabelopp inkl. moms ${input.currency}`, input.grossAmount);
    // Printed as the deduction it is — a payment reduces what is left. An
    // untouched invoice (the most common reminder of all) prints no line at
    // all, same convention as the fee line below: sv-SE renders -0 as
    // "-0,00", which reads as a mistake on a document that goes to a customer.
    if (input.settledAmount !== 0) amountLine("Betalt/krediterat", -input.settledAmount);
    // A fee-free reminder prints no fee line at all (0,00 kr would only
    // invite the question whether one was charged).
    if (input.feeAmount !== 0) amountLine("Påminnelseavgift", input.feeAmount);
    doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
    y += 8;
    amountLine(`Att betala ${input.currency}`, input.amountDue, true);

    if (input.payment) y = drawPaymentBox(doc, company, y, input.payment);

    drawFooter(doc, company);
    doc.end();
    return finished;
  }

  async function renderDeviationReport(input: DeviationReportPdfInput): Promise<Buffer> {
    const { doc, finished, company } = await startDocument();
    const left = PAGE_MARGIN;

    let y = 130;
    doc.font("Helvetica-Bold").fontSize(18).text(input.title, left, y);
    y += 26;
    doc.font("Helvetica").fontSize(10).fillColor("#444444");
    doc.text(`Nummer: ${input.documentNumber}`, left, y);
    y += 14;
    doc.text(`Datum: ${input.date}`, left, y);
    y += 14;
    for (const ref of input.references) {
      doc.text(`${ref.label}: ${ref.value}`, left, y, { width: CONTENT_WIDTH });
      y += 14;
    }
    doc.fillColor("#000000");
    y += 10;

    if (input.partner) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#888888").text(input.partnerLabel ?? "", left, y);
      y += 13;
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(11).text(input.partner.name, left, y);
      y += 15;
      doc.font("Helvetica").fontSize(10);
      for (const line of addressLines(input.partner)) {
        doc.text(line, left, y);
        y += 14;
      }
      y += 16;
    }

    // One labelled paragraph per section; a section that would collide with
    // the footer starts on a fresh page (long texts flow on from there).
    for (const section of input.sections) {
      doc.font("Helvetica").fontSize(10);
      const height = doc.heightOfString(section.text, { width: CONTENT_WIDTH });
      if (y + 14 + Math.min(height, 60) > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#888888").text(section.label.toUpperCase(), left, y);
      y += 13;
      doc.font("Helvetica").fontSize(10).fillColor("#000000").text(section.text, left, y, { width: CONTENT_WIDTH });
      y = doc.y + 12;
    }

    if (input.outgoing) drawFooter(doc, company);
    else drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  async function renderPickList(input: PickListPdfInput): Promise<Buffer> {
    const { doc, finished } = await startDocument();
    const left = PAGE_MARGIN;

    let y = 130;
    doc.font("Helvetica-Bold").fontSize(18).text(`Plocklista ${input.documentNumber}`, left, y);
    y += 26;
    doc.font("Helvetica").fontSize(10).fillColor("#444444");
    doc.text(`Utskriven: ${input.printedAt.toISOString().slice(0, 10)}`, left, y);
    y += 14;
    doc.text(`Kund: ${input.customerName}`, left, y);
    y += 14;
    if (input.customerOrderNumber) {
      doc.text(`Ert ordernummer: ${input.customerOrderNumber}`, left, y);
      y += 14;
    }
    if (input.customerReference) {
      doc.text(`Er referens: ${input.customerReference}`, left, y);
      y += 14;
    }
    if (input.deliveryAddress) {
      const addressParts = [input.deliveryAddress.label, ...addressLines(input.deliveryAddress)];
      const line = `Leveransadress: ${addressParts.join(", ")}`;
      doc.text(line, left, y, { width: CONTENT_WIDTH });
      y += doc.heightOfString(line, { width: CONTENT_WIDTH });
    }
    if (input.expectedDeliveryDate) {
      doc.text(`Leveransdatum: ${input.expectedDeliveryDate}`, left, y);
      y += 14;
    }
    if (input.note) {
      doc.text(`Anteckning: ${input.note}`, left, y, { width: CONTENT_WIDTH });
      y += doc.heightOfString(`Anteckning: ${input.note}`, { width: CONTENT_WIDTH }) + 4;
    }
    doc.fillColor("#000000");
    y += 12;

    const drawTableHeader = () => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#555555");
      doc.text("Artikelnummer", left + PICK_COLS.articleNumber.x, y, { width: PICK_COLS.articleNumber.w });
      doc.text("Benämning", left + PICK_COLS.articleName.x, y, { width: PICK_COLS.articleName.w });
      doc.text("Att plocka", left + PICK_COLS.quantity.x, y, { width: PICK_COLS.quantity.w, align: "right" });
      doc.text("Enhet", left + PICK_COLS.unit.x, y, { width: PICK_COLS.unit.w });
      doc.text("Lagerplats (saldo)", left + PICK_COLS.locations.x, y, { width: PICK_COLS.locations.w });
      doc.text("Plockat", left + PICK_COLS.picked.x, y, { width: PICK_COLS.picked.w, align: "right" });
      y += 14;
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 8;
      doc.fillColor("#000000").font("Helvetica").fontSize(9);
    };

    drawTableHeader();

    for (const row of input.rows) {
      const locationText = row.locations.length > 0 ? row.locations.join("\n") : "–";
      const nameHeight = doc.heightOfString(row.articleName, { width: PICK_COLS.articleName.w });
      // Konfigurator 4b: 8pt choice lines under the name, then the row's own
      // date, counted into the row height (a plain row has none, so it is
      // laid out exactly as before).
      const infoLines = [
        ...(row.customerArticleNumber ? [`Ert art.nr: ${row.customerArticleNumber}`] : []),
        ...(row.extraDescription ? [row.extraDescription] : []),
        ...(row.configurationLines ?? []),
        ...(row.deliveryDate ? [`Leveransdatum: ${row.deliveryDate}`] : []),
      ];
      const measured = measureInfoLines(doc, infoLines, PICK_COLS.articleName.w);
      const rowHeight =
        Math.max(nameHeight + measured.height, doc.heightOfString(locationText, { width: PICK_COLS.locations.w }), 11) + 8;
      if (y + rowHeight > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
        drawTableHeader();
      }
      doc.text(row.articleNumber, left + PICK_COLS.articleNumber.x, y, { width: PICK_COLS.articleNumber.w });
      doc.text(row.articleName, left + PICK_COLS.articleName.x, y, { width: PICK_COLS.articleName.w });
      doc
        .font("Helvetica-Bold")
        .text(formatQuantity(String(row.quantityToPick)), left + PICK_COLS.quantity.x, y, {
          width: PICK_COLS.quantity.w,
          align: "right",
        })
        .font("Helvetica");
      doc.text(row.unit ?? "", left + PICK_COLS.unit.x, y, { width: PICK_COLS.unit.w });
      doc.text(locationText, left + PICK_COLS.locations.x, y, { width: PICK_COLS.locations.w });
      // Empty line for the picker to tick off by hand.
      doc.text("____", left + PICK_COLS.picked.x, y, { width: PICK_COLS.picked.w, align: "right" });
      drawInfoLines(doc, infoLines, measured, left + PICK_COLS.articleName.x, y + nameHeight + 1, PICK_COLS.articleName.w);
      y += rowHeight;
    }

    if (input.rows.length === 0) {
      doc.text("Inget kvar att plocka — alla rader är levererade.", left, y);
      y += 16;
    }

    doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
    y += 24;
    doc.font("Helvetica").fontSize(10).text("Plockat av: ______________________    Datum: ______________", left, y);

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  // Räknelista (D2) — mirrors renderPickList's shape (internal document, no
  // payment footer). Blind by default: the "Bokfört" column and its cells
  // print only when input.showBalances is set, so the counter can't see the
  // expected answer while they count.
  async function renderStockCountSheet(input: StockCountSheetPdfInput): Promise<Buffer> {
    const { doc, finished } = await startDocument();
    const left = PAGE_MARGIN;

    let y = 130;
    doc.font("Helvetica-Bold").fontSize(18).text(`Räknelista ${input.documentNumber}`, left, y);
    y += 26;
    doc.font("Helvetica").fontSize(10).fillColor("#444444");
    doc.text(`Utskriven: ${input.printedAt.toISOString().slice(0, 10)}`, left, y);
    y += 14;
    doc.text(`Lagerplats: ${input.warehouseName} — ${input.locationName}`, left, y);
    y += 14;
    if (input.blocksTransactions) {
      doc.text("Lagertransaktioner är spärrade under inventeringen.", left, y);
      y += 14;
    }
    if (input.note) {
      doc.text(`Anteckning: ${input.note}`, left, y, { width: CONTENT_WIDTH });
      y += doc.heightOfString(`Anteckning: ${input.note}`, { width: CONTENT_WIDTH }) + 4;
    }
    doc.fillColor("#000000");
    y += 12;

    const drawTableHeader = () => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#555555");
      doc.text("Artikelnummer", left + COUNT_COLS.articleNumber.x, y, { width: COUNT_COLS.articleNumber.w });
      doc.text("Benämning", left + COUNT_COLS.articleName.x, y, { width: COUNT_COLS.articleName.w });
      doc.text("Enhet", left + COUNT_COLS.unit.x, y, { width: COUNT_COLS.unit.w });
      if (input.showBalances) {
        doc.text("Bokfört", left + COUNT_COLS.balance.x, y, { width: COUNT_COLS.balance.w, align: "right" });
      }
      doc.text("Räknat", left + COUNT_COLS.counted.x, y, { width: COUNT_COLS.counted.w, align: "right" });
      y += 14;
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 8;
      doc.fillColor("#000000").font("Helvetica").fontSize(9);
    };

    drawTableHeader();

    for (const row of input.rows) {
      const rowHeight =
        Math.max(doc.heightOfString(row.articleName, { width: COUNT_COLS.articleName.w }), 11) + 10;
      if (y + rowHeight > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
        drawTableHeader();
      }
      doc.text(row.articleNumber, left + COUNT_COLS.articleNumber.x, y, { width: COUNT_COLS.articleNumber.w });
      doc.text(row.articleName, left + COUNT_COLS.articleName.x, y, { width: COUNT_COLS.articleName.w });
      doc.text(row.unit ?? "", left + COUNT_COLS.unit.x, y, { width: COUNT_COLS.unit.w });
      if (input.showBalances && row.snapshotQuantity !== null) {
        doc.text(formatQuantity(String(row.snapshotQuantity)), left + COUNT_COLS.balance.x, y, {
          width: COUNT_COLS.balance.w,
          align: "right",
        });
      }
      // Empty line for the counter to fill in by hand.
      doc.text("__________", left + COUNT_COLS.counted.x, y, { width: COUNT_COLS.counted.w, align: "right" });
      y += rowHeight;
    }

    if (input.rows.length === 0) {
      doc.text("Inga rader — lagerplatsen har inget bokfört saldo.", left, y);
      y += 16;
    }

    doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
    y += 24;
    doc.font("Helvetica").fontSize(10).text("Räknat av: ______________________    Datum: ______________", left, y);

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  // Följesedel — mirrors renderPickList's header/address blocks, but for the
  // goods that have already shipped: FS-number + leveransdatum, this
  // occasion's quantity and what was delivered before it. Unlike the pick
  // list (an internal picking aid) this document leaves the building with
  // the goods, so it gets the same company footer as the outgoing quote/PO/
  // invoice — see drawFooter's own comment on that split.
  async function renderDeliveryNote(input: DeliveryNotePdfInput): Promise<Buffer> {
    const { doc, finished, company } = await startDocument();
    const left = PAGE_MARGIN;

    let y = 130;
    doc.font("Helvetica-Bold").fontSize(18).text(`Följesedel ${input.documentNumber}`, left, y);
    y += 26;
    doc.font("Helvetica").fontSize(10).fillColor("#444444");
    doc.text(`Leveransdatum: ${input.deliveredAt.toISOString().slice(0, 10)}`, left, y);
    y += 14;
    if (input.undoneAt) {
      doc.font("Helvetica-Bold").text(`Ångrad ${formatStockholmDateTime(input.undoneAt)}`, left, y).font("Helvetica");
      y += 14;
    }
    doc.text(`Ordernummer: ${input.orderNumber}`, left, y);
    y += 14;
    doc.text(`Kund: ${input.customerName}`, left, y);
    y += 14;
    if (input.customerOrderNumber) {
      doc.text(`Ert ordernummer: ${input.customerOrderNumber}`, left, y);
      y += 14;
    }
    if (input.customerReference) {
      doc.text(`Er referens: ${input.customerReference}`, left, y);
      y += 14;
    }
    if (input.carrier?.carrierName) {
      doc.text(`Transportör: ${input.carrier.carrierName}`, left, y);
      y += 14;
    }
    if (input.carrier?.trackingNumber) {
      doc.text(`Fraktsedelsnr: ${input.carrier.trackingNumber}`, left, y);
      y += 14;
    }
    if (input.deliveryAddress) {
      const addressParts = [input.deliveryAddress.label, ...addressLines(input.deliveryAddress)];
      const line = `Leveransadress: ${addressParts.join(", ")}`;
      doc.text(line, left, y, { width: CONTENT_WIDTH });
      y += doc.heightOfString(line, { width: CONTENT_WIDTH });
    }
    doc.fillColor("#000000");
    y += 12;

    const drawTableHeader = () => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#555555");
      doc.text("Artikel", left + DELIVERY_NOTE_COLS.articleNumber.x, y, { width: DELIVERY_NOTE_COLS.articleNumber.w });
      doc.text("Benämning", left + DELIVERY_NOTE_COLS.articleName.x, y, { width: DELIVERY_NOTE_COLS.articleName.w });
      doc.text("Levererat", left + DELIVERY_NOTE_COLS.quantity.x, y, {
        width: DELIVERY_NOTE_COLS.quantity.w,
        align: "right",
      });
      doc.text("Enhet", left + DELIVERY_NOTE_COLS.unit.x, y, { width: DELIVERY_NOTE_COLS.unit.w });
      doc.text("Tidigare levererat", left + DELIVERY_NOTE_COLS.priorDelivered.x, y, {
        width: DELIVERY_NOTE_COLS.priorDelivered.w,
        align: "right",
      });
      y += 14;
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 8;
      doc.fillColor("#000000").font("Helvetica").fontSize(9);
    };

    drawTableHeader();

    for (const row of input.rows) {
      const nameHeight = doc.heightOfString(row.articleName, { width: DELIVERY_NOTE_COLS.articleName.w });
      // Konfigurator 4b: 8pt choice lines under the name, counted into the
      // row height (a plain row has none, so it is laid out exactly as before).
      // An undone row gets one more 8pt line of the same kind.
      const infoLines = [
        ...(row.customerArticleNumber ? [`Ert art.nr: ${row.customerArticleNumber}`] : []),
        ...(row.extraDescription ? [row.extraDescription] : []),
        ...(row.configurationLines ?? []),
        ...(row.undoneAt ? [`Ångrad ${formatStockholmDateTime(row.undoneAt)}`] : []),
      ];
      const measured = measureInfoLines(doc, infoLines, DELIVERY_NOTE_COLS.articleName.w);
      const rowHeight = Math.max(nameHeight + measured.height, 11) + 8;
      if (y + rowHeight > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
        drawTableHeader();
      }
      doc.text(row.articleNumber, left + DELIVERY_NOTE_COLS.articleNumber.x, y, {
        width: DELIVERY_NOTE_COLS.articleNumber.w,
      });
      doc.text(row.articleName, left + DELIVERY_NOTE_COLS.articleName.x, y, { width: DELIVERY_NOTE_COLS.articleName.w });
      doc
        .font("Helvetica-Bold")
        .text(formatQuantity(String(row.quantity)), left + DELIVERY_NOTE_COLS.quantity.x, y, {
          width: DELIVERY_NOTE_COLS.quantity.w,
          align: "right",
        })
        .font("Helvetica");
      doc.text(row.unit ?? "", left + DELIVERY_NOTE_COLS.unit.x, y, { width: DELIVERY_NOTE_COLS.unit.w });
      doc.text(formatQuantity(String(row.priorDelivered)), left + DELIVERY_NOTE_COLS.priorDelivered.x, y, {
        width: DELIVERY_NOTE_COLS.priorDelivered.w,
        align: "right",
      });
      drawInfoLines(
        doc,
        infoLines,
        measured,
        left + DELIVERY_NOTE_COLS.articleName.x,
        y + nameHeight + 1,
        DELIVERY_NOTE_COLS.articleName.w
      );
      y += rowHeight;
    }

    doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();

    drawFooter(doc, company);
    doc.end();
    return finished;
  }

  async function renderManufacturingOrder(input: ManufacturingOrderPdfInput): Promise<Buffer> {
    const { doc, finished } = await startDocument();
    const left = PAGE_MARGIN;

    let y = 130;
    doc.font("Helvetica-Bold").fontSize(18).text(`Tillverkningsorder ${input.orderNumber}`, left, y);
    y += 26;
    doc.font("Helvetica").fontSize(10).fillColor("#444444");
    doc.text(`Utskriven: ${input.printedAt.toISOString().slice(0, 10)}    Status: ${input.statusLabel}`, left, y);
    doc.fillColor("#000000");
    y += 22;

    if (input.salesOrderRef) {
      doc.font("Helvetica").fontSize(10);
      doc.text(`Kundorder: ${input.salesOrderRef.orderNumber} — ${input.salesOrderRef.customerName}`, left, y);
      y += 16;
    }

    if (input.dueDate) {
      doc.font("Helvetica").fontSize(10);
      doc.text(`Planerat färdigdatum: ${input.dueDate}`, left, y);
      y += 16;
    }

    // A long number + name wraps within the page; the lines below follow its
    // real height instead of a fixed step (they were printed on top of the
    // second line).
    const heading = `${input.articleNumber} — ${input.articleName}`;
    doc.font("Helvetica-Bold").fontSize(13).text(heading, left, y, { width: CONTENT_WIDTH });
    y += doc.heightOfString(heading, { width: CONTENT_WIDTH }) + 5;
    if (input.extraDescription) {
      doc.font("Helvetica").fontSize(9).fillColor("#444444");
      doc.text(input.extraDescription, left, y, { width: CONTENT_WIDTH });
      y += doc.heightOfString(input.extraDescription, { width: CONTENT_WIDTH }) + 6;
      doc.fillColor("#000000");
    }
    // Konfigurator 4c: the choice lines under the article — the same 8 pt
    // grey sub-lines the customer documents print under a configured row.
    if (input.configurationLines && input.configurationLines.length > 0) {
      doc.font("Helvetica").fontSize(8).fillColor("#666666");
      for (const line of input.configurationLines) {
        doc.text(line, left, y, { width: CONTENT_WIDTH });
        y += 11;
      }
      doc.fillColor("#000000");
      y += 4;
    }
    doc.font("Helvetica").fontSize(11).text(`Antal att tillverka: ${formatQuantity(input.quantity)}`, left, y);
    y += 18;
    if (input.note) {
      doc.fontSize(10).text(`Anteckning: ${input.note}`, left, y, { width: CONTENT_WIDTH });
      y += doc.heightOfString(`Anteckning: ${input.note}`, { width: CONTENT_WIDTH }) + 6;
    }
    y += 12;

    // --- Operations ---
    doc.font("Helvetica-Bold").fontSize(12).text("Operationer", left, y);
    y += 18;

    if (input.operations.length === 0) {
      doc.font("Helvetica").fontSize(10).text("Inga operationer — ordern är inte frisläppt än.", left, y);
      y += 20;
    } else {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#555555");
      doc.text("Op", left + MO_OP_COLS.seq.x, y, { width: MO_OP_COLS.seq.w });
      doc.text("Operation", left + MO_OP_COLS.workCenter.x, y, { width: MO_OP_COLS.workCenter.w });
      doc.text("Ställtid", left + MO_OP_COLS.setup.x, y, { width: MO_OP_COLS.setup.w, align: "right" });
      doc.text("Stycktid", left + MO_OP_COLS.perUnit.x, y, { width: MO_OP_COLS.perUnit.w, align: "right" });
      doc.text("Beräknat", left + MO_OP_COLS.estimated.x, y, { width: MO_OP_COLS.estimated.w, align: "right" });
      doc.text("Klart (sign)", left + MO_OP_COLS.done.x, y, { width: MO_OP_COLS.done.w, align: "right" });
      y += 14;
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 8;
      doc.fillColor("#000000").font("Helvetica").fontSize(9);

      for (const op of input.operations) {
        if (y + 20 > TABLE_BOTTOM) {
          doc.addPage();
          y = PAGE_MARGIN;
        }
        doc.text(String(op.sequenceNo), left + MO_OP_COLS.seq.x, y, { width: MO_OP_COLS.seq.w });
        // Description over resource name, with the code kept as a prefix so
        // the operator can still see which machine the step runs on.
        const label = op.description?.trim() || op.workCenterName;
        const withCode = op.workCenterCode ? `${op.workCenterCode} · ${label}` : label;
        doc.text(withCode, left + MO_OP_COLS.workCenter.x, y, {
          width: MO_OP_COLS.workCenter.w,
          height: 18,
          ellipsis: true,
        });
        // Operation times are MINUTES throughout (the beredning input unit;
        // costing divides by 60) — the old "h" suffix here was wrong.
        doc.text(`${formatTime(Number(op.setupTime))} min`, left + MO_OP_COLS.setup.x, y, {
          width: MO_OP_COLS.setup.w,
          align: "right",
        });
        const runTimePerUnit = Number(op.runTimePerUnit);
        // Display guard: a stored value of 0 (or less) has no meaningful
        // st/h conversion (division by zero/negative) — always show it in
        // minutes regardless of the operation's chosen unit.
        const perUnitText =
          op.timeUnit === "units_per_hour" && runTimePerUnit > 0
            ? `${formatTime(minutesPerUnitToUnitsPerHour(runTimePerUnit))} st/h`
            : op.timeUnit === "seconds_per_unit"
              ? `${formatTime(minutesPerUnitToSecondsPerUnit(runTimePerUnit))} sek`
              : `${formatTime(runTimePerUnit)} min`;
        doc.text(perUnitText, left + MO_OP_COLS.perUnit.x, y, {
          width: MO_OP_COLS.perUnit.w,
          align: "right",
        });
        doc.text(`${formatTime(op.estimatedTime)} min`, left + MO_OP_COLS.estimated.x, y, {
          width: MO_OP_COLS.estimated.w,
          align: "right",
        });
        doc.text("______", left + MO_OP_COLS.done.x, y, { width: MO_OP_COLS.done.w, align: "right" });
        y += 20;

        // The comment wraps, so its height is measured before it is drawn —
        // same heightOfString advance as the MO's "Anteckning:" header line.
        const comment = op.printOnWorkCard ? op.comment?.trim() : null;
        if (comment) {
          const indent = MO_OP_COLS.workCenter.x;
          const width = CONTENT_WIDTH - indent;
          const height = doc.heightOfString(comment, { width });
          if (y + height > TABLE_BOTTOM) {
            doc.addPage();
            y = PAGE_MARGIN;
          }
          doc.fillColor("#444444").text(comment, left + indent, y, { width });
          doc.fillColor("#000000");
          y += height + 8;
        }

        // Packinstruktion — shop-floor information, so it always prints when
        // set (unlike the comment above, it is not gated by
        // printOnWorkCard, which governs the comment only).
        const packingInstructions = op.packingInstructions?.trim();
        if (packingInstructions) {
          const indent = MO_OP_COLS.workCenter.x;
          const width = CONTENT_WIDTH - indent;
          const text = `Packning: ${packingInstructions}`;
          const height = doc.heightOfString(text, { width });
          if (y + height > TABLE_BOTTOM) {
            doc.addPage();
            y = PAGE_MARGIN;
          }
          doc.fillColor("#444444").text(text, left + indent, y, { width });
          doc.fillColor("#000000");
          y += height + 8;
        }
      }
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 16;
    }

    // --- Materials ---
    if (y + 60 > TABLE_BOTTOM) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#000000").text("Material", left, y);
    y += 18;

    if (input.materials.length === 0) {
      doc.font("Helvetica").fontSize(10).text("Inget material — ordern är inte frisläppt än.", left, y);
      y += 20;
    } else {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#555555");
      doc.text("Op", left + MO_MAT_COLS.op.x, y, { width: MO_MAT_COLS.op.w });
      doc.text("Artikelnummer", left + MO_MAT_COLS.articleNumber.x, y, { width: MO_MAT_COLS.articleNumber.w });
      doc.text("Benämning", left + MO_MAT_COLS.articleName.x, y, { width: MO_MAT_COLS.articleName.w });
      doc.text("Enhet", left + MO_MAT_COLS.unit.x, y, { width: MO_MAT_COLS.unit.w });
      doc.text("Planerat", left + MO_MAT_COLS.planned.x, y, { width: MO_MAT_COLS.planned.w, align: "right" });
      doc.text("Uttaget", left + MO_MAT_COLS.consumed.x, y, { width: MO_MAT_COLS.consumed.w, align: "right" });
      doc.text("Uttaget (sign)", left + MO_MAT_COLS.sign.x, y, { width: MO_MAT_COLS.sign.w, align: "right" });
      y += 14;
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 8;
      doc.fillColor("#000000").font("Helvetica").fontSize(9);

      for (const material of input.materials) {
        const nameHeight = doc.heightOfString(material.articleName, { width: MO_MAT_COLS.articleName.w });
        const rowHeight = Math.max(nameHeight, 11) + 9;
        if (y + rowHeight > TABLE_BOTTOM) {
          doc.addPage();
          y = PAGE_MARGIN;
        }
        doc.text(
          material.operationSequenceNo != null ? String(material.operationSequenceNo) : "—",
          left + MO_MAT_COLS.op.x,
          y,
          { width: MO_MAT_COLS.op.w },
        );
        doc.text(material.articleNumber, left + MO_MAT_COLS.articleNumber.x, y, {
          width: MO_MAT_COLS.articleNumber.w,
        });
        doc.text(material.articleName, left + MO_MAT_COLS.articleName.x, y, { width: MO_MAT_COLS.articleName.w });
        doc.text(material.unit, left + MO_MAT_COLS.unit.x, y, { width: MO_MAT_COLS.unit.w });
        doc.text(formatQuantity(material.quantityPlanned), left + MO_MAT_COLS.planned.x, y, {
          width: MO_MAT_COLS.planned.w,
          align: "right",
        });
        doc.text(formatQuantity(material.quantityConsumed), left + MO_MAT_COLS.consumed.x, y, {
          width: MO_MAT_COLS.consumed.w,
          align: "right",
        });
        doc.text("______", left + MO_MAT_COLS.sign.x, y, { width: MO_MAT_COLS.sign.w, align: "right" });
        y += rowHeight;
      }
      doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
      y += 24;
    }

    doc.font("Helvetica").fontSize(10).text("Utförd av: ______________________    Datum: ______________", left, y);

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  // Pallkort — one standalone card per PAGE (each card goes on its own
  // pallet), all content on the TOP HALF of a portrait A4 so the sheet can
  // be folded at the middle. Internal document: no payment footer, page
  // numbers only when there are several cards (drawPageNumbers is a no-op on
  // a single page). A framed card under the company header: a black title
  // band (PALLKORT · TILL KUND/INTERNT), the article with its code and the
  // quantity side by side, a grid of label/value cells, and a bottom row
  // of cells with date, reporter and reference. Big bold values under small grey
  // labels — the card is read from a distance on the shop floor / loading
  // dock. The grid is laid out two cells per row (rather than one full-width
  // cell per field) because the full set — article, name, customer, address,
  // two order numbers with barcodes, quantity — does not fit above the fold
  // stacked vertically.
  async function renderPalletCard(cards: PalletCardPdfInput[]): Promise<Buffer> {
    const { doc, finished, drawHeader } = await startDocument();
    const left = PAGE_MARGIN;
    const right = PAGE_MARGIN + CONTENT_WIDTH;
    const fold = PAGE_HEIGHT / 2;
    const cardTop = 104;
    const pad = 8;
    const BARCODE_HEIGHT = 20;
    const QR_SIZE = 56;

    // Small grey uppercase label above each value.
    const label = (text: string, x: number, y: number) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#777777");
      doc.text(text, x, y, { lineBreak: false });
      doc.fillColor("#000000");
    };
    // One line, big and bold — ellipsis instead of wrapping, so a long value
    // can never push the card past the fold.
    const value = (text: string, x: number, y: number, size: number, width: number) => {
      doc.font("Helvetica-Bold").fontSize(size).fillColor("#000000");
      doc.text(text, x, y, { width, height: size * 1.25, ellipsis: true });
    };
    // The quantity: shrinks the font (never below 20 pt) until the value and
    // its unit fit on one line — "1 234,5 kg" must stay whole.
    const fitValue = (text: string, x: number, y: number, size: number, width: number) => {
      doc.font("Helvetica-Bold").fillColor("#000000");
      let fontSize = size;
      while (fontSize > 20 && doc.fontSize(fontSize).widthOfString(text) > width) fontSize -= 2;
      doc.fontSize(fontSize).text(text, x, y + (size - fontSize) / 2, { width, height: fontSize * 1.25, ellipsis: true });
    };
    const thinLine = (x1: number, y1: number, x2: number, y2: number) => {
      doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(0.5).strokeColor("#000000").stroke();
    };

    // Code 128 under a value: scaled to the width available (never wider
    // than maxWidth, modules never thinner than 0.5 pt — below that a
    // printer cannot hold the bars apart, so a very long text prints no
    // barcode). Returns whether anything was drawn.
    const drawBarcode = (text: string, x: number, y: number, maxWidth: number): boolean => {
      const widths = encodeCode128(text);
      if (!widths) return false;
      const modules = code128TotalModules(widths);
      const moduleWidth = Math.min(1, maxWidth / modules);
      if (moduleWidth < 0.5) return false;
      let cursor = x + CODE128_QUIET_ZONE * moduleWidth;
      widths.forEach((w, i) => {
        if (i % 2 === 0) doc.rect(cursor, y, w * moduleWidth, BARCODE_HEIGHT).fill("#000000");
        cursor += w * moduleWidth;
      });
      doc.fillColor("#000000");
      return true;
    };
    // QR code (error correction M) in a square of `size` pt including a
    // 4-module quiet zone on each side. Byte mode carries å/ä/ö, so this
    // never falls back.
    const drawQr = (text: string, x: number, y: number, size: number) => {
      const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
      const cell = size / (modules.size + 8);
      const origin = 4 * cell;
      for (let row = 0; row < modules.size; row++) {
        for (let col = 0; col < modules.size; col++) {
          if (modules.get(row, col)) doc.rect(x + origin + col * cell, y + origin + row * cell, cell, cell).fill("#000000");
        }
      }
      doc.fillColor("#000000");
    };

    // A cell holding a coded value (order number): label, value and the code
    // under (barcode) or beside (QR) it. Returns the cell's content height.
    const codedCellHeight = (code: PalletCardCodeType) =>
      code === "barcode" ? 6 + 9 + 21 + 3 + BARCODE_HEIGHT + 5 : code === "qr" ? 6 + QR_SIZE + 6 : 6 + 9 + 21 + 6;
    const codedCell = (text: string, labelText: string, x: number, y: number, width: number, code: PalletCardCodeType) => {
      label(labelText, x + pad, y + 6);
      const valueWidth = code === "qr" ? width - 2 * pad - QR_SIZE - 6 : width - 2 * pad;
      value(text, x + pad, y + 15, 18, valueWidth);
      if (code === "barcode") drawBarcode(text, x + pad, y + 39, Math.min(width - 2 * pad, CONTENT_WIDTH / 2));
      if (code === "qr") drawQr(text, x + width - pad - QR_SIZE, y + 6, QR_SIZE);
    };
    const plainCell = (text: string, labelText: string, x: number, y: number, width: number) => {
      label(labelText, x + pad, y + 6);
      value(text, x + pad, y + 15, 18, width - 2 * pad);
    };

    cards.forEach((card, index) => {
      if (index > 0) {
        doc.addPage();
        drawHeader();
      }
      const code: PalletCardCodeType = card.code ?? "none";

      // 1. Title band.
      doc.rect(left, cardTop, CONTENT_WIDTH, 20).fill("#000000");
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff");
      doc.text("PALLKORT", left + pad, cardTop + 5.5, { lineBreak: false });
      doc.text(card.kind === "final" ? "TILL KUND" : "INTERNT", left, cardTop + 5.5, {
        width: CONTENT_WIDTH - pad,
        align: "right",
        lineBreak: false,
      });
      doc.fillColor("#000000");

      // 2. Article (left column) and 4. quantity (right column), side by side.
      let y = cardTop + 20;
      const articleColWidth = Math.round(CONTENT_WIDTH * 0.6);
      const qtyColX = left + articleColWidth;
      const qtyColWidth = CONTENT_WIDTH - articleColWidth;
      const yA = y + 6;
      label("ARTIKELNUMMER", left + pad, yA);
      const numberWidth = code === "qr" ? articleColWidth - 2 * pad - QR_SIZE - 6 : articleColWidth - 2 * pad;
      value(card.articleNumber, left + pad, yA + 10, 30, numberWidth);
      let yName = yA + 48;
      if (code === "barcode") {
        drawBarcode(card.articleNumber, left + pad, yA + 44, Math.min(articleColWidth - 2 * pad, CONTENT_WIDTH / 2));
        yName = yA + 44 + BARCODE_HEIGHT + 5;
      } else if (code === "qr") {
        drawQr(card.articleNumber, left + articleColWidth - pad - QR_SIZE, yA, QR_SIZE);
        yName = yA + QR_SIZE + 6;
      }
      label("BENÄMNING", left + pad, yName);
      // Two-line budget before ellipsizing — same bold-black treatment as
      // value(), which is single-line only, so a direct doc.text call with a
      // taller fixed box (up to 2 lines at 13 pt).
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#000000");
      doc.text(card.articleName || "—", left + pad, yName + 10, { width: articleColWidth - 2 * pad, height: 32, ellipsis: true });
      const rowABottom = yName + 10 + 30 + 6;

      label("ANTAL", qtyColX + pad, yA);
      fitValue(
        `${formatQuantity(String(card.quantity))}${card.unit ? ` ${card.unit}` : ""}`,
        qtyColX + pad,
        yA + 12,
        40,
        qtyColWidth - 2 * pad
      );
      // Kolli n av m under the quantity, in its own cell — read together
      // with the quantity when the pallets are counted.
      const parcel = card.parcel ?? { index: 1, count: 1 };
      thinLine(qtyColX, yA + 66, right, yA + 66);
      value(`Kolli ${parcel.index} av ${parcel.count}`, qtyColX + pad, yA + 74, 18, qtyColWidth - 2 * pad);
      thinLine(qtyColX, y, qtyColX, rowABottom);
      y = rowABottom;
      thinLine(left, y, right, y);

      // 3. Grid.
      const half = CONTENT_WIDTH / 2;
      if (card.kind === "final") {
        // At most three lines: street (every row on one line), postal code +
        // city, country — the last only when ≠ SE, as every other document.
        const address = card.deliveryAddress
          ? [
              card.deliveryAddress.address
                .split(/\r\n|\r|\n/)
                .map((row) => row.trim())
                .filter((row) => row !== "")
                .join(", "),
              ...addressLines({ ...card.deliveryAddress, address: null }),
            ].filter((line) => line !== "")
          : [];
        // Beside an address the customer gets half the width: a name that
        // does not fit at 18 pt shrinks to 14 pt, and failing that wraps to
        // two 13 pt lines (the row grows to hold them).
        const nameWidth = half - 2 * pad;
        doc.font("Helvetica-Bold");
        const nameSize =
          address.length === 0 ? 18 : ([18, 16, 14].find((size) => doc.fontSize(size).widthOfString(card.customerName) <= nameWidth) ?? 13);
        const nameHeight = nameSize === 13 ? 2 * 13 * 1.25 : 21;
        const rowBHeight = 6 + 9 + Math.max(nameHeight, address.length * 11) + 6;
        if (address.length > 0) {
          label("KUND", left + pad, y + 6);
          doc.font("Helvetica-Bold").fontSize(nameSize).fillColor("#000000");
          doc.text(card.customerName, left + pad, y + 15 + (nameSize === 13 ? 0 : 18 - nameSize), {
            width: nameWidth,
            height: nameSize === 13 ? nameHeight : nameSize * 1.25,
            ellipsis: true,
          });
          thinLine(left + half, y, left + half, y + rowBHeight);
          label("LEVERANSADRESS", left + half + pad, y + 6);
          doc.font("Helvetica-Bold").fontSize(10).fillColor("#000000");
          address.forEach((line, i) => {
            doc.text(line, left + half + pad, y + 16 + i * 11, { width: half - 2 * pad, height: 11, ellipsis: true });
          });
        } else {
          plainCell(card.customerName, "KUND", left, y, CONTENT_WIDTH);
        }
        y += rowBHeight;
        thinLine(left, y, right, y);

        const rowCHeight = codedCellHeight(code);
        plainCell(card.customerOrderNumber || "—", "KUNDENS ORDERNUMMER", left, y, half);
        thinLine(left + half, y, left + half, y + rowCHeight);
        codedCell(card.orderNumber, "VÅRT KUNDORDERNUMMER", left + half, y, half, code);
        y += rowCHeight;
      } else {
        const rowBHeight = codedCellHeight(code);
        codedCell(card.orderNumber, "TILLVERKNINGSORDER", left, y, half, code);
        thinLine(left + half, y, left + half, y + rowBHeight);
        // "—" rather than no cell, so the grid keeps its shape on the last
        // operation of an unlinked order.
        plainCell(card.nextOperation || "—", "NÄSTA OPERATION", left + half, y, half);
        y += rowBHeight;
      }
      thinLine(left, y, right, y);

      // 5. Bottom row: date · reporter · reference as ordinary cells — a
      // small grey footer line was easy to miss on the dock. No reporter
      // (the delivery card never names one, a TO card only when known) ⇒
      // two cells instead of three.
      const bottomCells: [string, string][] = [
        ["DATUM", formatStockholmDateTime(card.printedAt ?? new Date())],
        ...(card.reportedBy ? [["RAPPORTERAD AV", card.reportedBy] as [string, string]] : []),
        ["REFERENS", card.reference || "—"],
      ];
      const cellWidth = CONTENT_WIDTH / bottomCells.length;
      bottomCells.forEach(([labelText, text], i) => {
        const x = left + i * cellWidth;
        if (i > 0) thinLine(x, y, x, y + 32);
        label(labelText, x + pad, y + 5);
        value(text, x + pad, y + 14, 12, cellWidth - 2 * pad);
      });
      y += 32;

      // The frame around the whole card (1 pt) — ends above the fold.
      doc.rect(left, cardTop, CONTENT_WIDTH, y - cardTop).lineWidth(1).strokeColor("#000000").stroke();

      // Fold mark at exactly half the page height — the lower half stays
      // empty on purpose (it folds away behind the card).
      doc
        .moveTo(left, fold)
        .lineTo(right, fold)
        .dash(3, { space: 5 })
        .strokeColor("#bbbbbb")
        .lineWidth(0.5)
        .stroke();
      doc.undash();
    });

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  // Löneunderlag — internal document, no drawFooter (same as the pick list /
  // TO printout above). One section per employee: a bold name/number/
  // employment-form line, then its pre-formatted label/hours rows, with a
  // thin separator before the next employee. Rows and sections use the same
  // TABLE_BOTTOM page-break check as every other table in this file — a
  // section is free to break across a page boundary, nothing is repeated.
  async function renderPayrollReport(input: PayrollReportPdfInput): Promise<Buffer> {
    const { doc, finished } = await startDocument();
    const left = PAGE_MARGIN;

    let y = 130;
    doc.font("Helvetica-Bold").fontSize(18).text(input.periodLabel, left, y);
    y += 24;
    doc.font("Helvetica").fontSize(10).fillColor("#444444").text(input.status, left, y);
    doc.fillColor("#000000");
    y += 24;

    input.employees.forEach((employee, index) => {
      // Reserve the header's own 18pt PLUS the first row's 13pt (when there
      // is one) before deciding to print the header here — reserving only
      // the header's own height let the header land as low as y=764 and
      // print alone, with the row loop's own check (y+13 > TABLE_BOTTOM)
      // then breaking before its first iteration, orphaning the header at
      // the bottom of a page with all its rows starting the next one. This
      // mirrors renderManufacturingOrder's "Material" section header, which
      // reserves its own height plus a following row (`y + 60 > TABLE_BOTTOM`)
      // for the same reason. An employee with zero rows (all-zero minutes)
      // has nothing to orphan, so only its own 18pt is reserved.
      const headerReserve = 18 + (employee.rows.length > 0 ? 13 : 0);
      if (y + headerReserve > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(`${employee.name} (${employee.employeeNumber}) — ${employee.employmentTypeLabel}`, left, y, {
          width: CONTENT_WIDTH,
        });
      y += 18;

      doc.font("Helvetica").fontSize(9.5);
      for (const row of employee.rows) {
        if (y + 13 > TABLE_BOTTOM) {
          doc.addPage();
          y = PAGE_MARGIN;
        }
        doc.text(row.label, left + PAYROLL_COLS.label.x, y, { width: PAYROLL_COLS.label.w });
        doc.text(row.hours, left + PAYROLL_COLS.hours.x, y, { width: PAYROLL_COLS.hours.w, align: "right" });
        y += 13;
      }

      // Thin separator before the next employee — none after the last one.
      if (index < input.employees.length - 1) {
        y += 6;
        if (y + 1 > TABLE_BOTTOM) {
          doc.addPage();
          y = PAGE_MARGIN;
        } else {
          doc.moveTo(left, y).lineTo(left + CONTENT_WIDTH, y).strokeColor("#cccccc").lineWidth(0.5).stroke();
          y += 14;
        }
      }
    });

    if (input.employees.length === 0) {
      doc.font("Helvetica").fontSize(10).text("Inga anställda i perioden.", left, y);
    }

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  // Shared opening for the three B6a reports: title + subtitle, returning
  // the cursor position the body starts from.
  function startReport(doc: PDFKit.PDFDocument, title: string, subtitle: string): number {
    const left = PAGE_MARGIN;
    let y = 130;
    doc.font("Helvetica-Bold").fontSize(18).text(title, left, y);
    y += 24;
    doc.font("Helvetica").fontSize(10).fillColor("#444444").text(subtitle, left, y);
    doc.fillColor("#000000");
    return y + 24;
  }

  // Balansräkning and resultaträkning share one renderer — both are a flat
  // sequence of indented labelled rows with a right-aligned amount. Economy
  // decides the sequence and formats every amount; this only draws it.
  async function renderFinancialStatement(input: FinancialStatementPdfInput): Promise<Buffer> {
    const columns = input.columns ?? [];
    const multi = columns.length > 0;
    const { doc, finished } = await startDocument({ landscape: columns.length > 4 });
    const left = PAGE_MARGIN;
    const right = doc.page.width - PAGE_MARGIN;
    const bottom = doc.page.height - 62;
    let y = startReport(doc, input.title, input.subtitle);

    // Multi-column: the amount columns hang from the right edge, the label
    // takes what is left. Single-column: the classic statement layout.
    const columnWidth = columns.length > 4 ? 76 : 78;
    const columnX = (index: number) => right - (columns.length - index) * columnWidth;
    const amountsStart = multi ? columnX(0) : left + STATEMENT_AMOUNT_COL.x;
    const rule = (atY: number) =>
      doc
        .moveTo(amountsStart, atY)
        .lineTo(multi ? right : left + STATEMENT_AMOUNT_COL.x + STATEMENT_AMOUNT_COL.w, atY)
        .strokeColor("#666666")
        .lineWidth(0.5)
        .stroke();
    const columnHeader = () => {
      if (!multi) return;
      doc.font("Helvetica-Bold").fontSize(8.5);
      columns.forEach((heading, index) => {
        doc.text(heading, columnX(index), y, { width: columnWidth - 4, align: "right", lineBreak: false });
      });
      y += 12;
      doc.moveTo(left, y).lineTo(right, y).strokeColor("#999999").lineWidth(0.5).stroke();
      y += 4;
    };

    const STYLE = {
      group: { indent: 0, font: "Helvetica-Bold", size: 11, gapBefore: 8, rule: "none" },
      line: { indent: 12, font: "Helvetica-Bold", size: 9.5, gapBefore: 2, rule: "none" },
      account: { indent: 24, font: "Helvetica", size: 9, gapBefore: 0, rule: "none" },
      subtotal: { indent: 0, font: "Helvetica-Bold", size: 10, gapBefore: 4, rule: "single" },
      total: { indent: 0, font: "Helvetica-Bold", size: 11, gapBefore: 6, rule: "double" },
    } as const;

    columnHeader();
    for (const row of input.rows) {
      const style = STYLE[row.kind];
      y += style.gapBefore;
      if (y + 16 > bottom) {
        doc.addPage();
        y = PAGE_MARGIN;
        columnHeader();
      }

      if (style.rule !== "none") rule(y - 3);

      doc.font(style.font).fontSize(style.size);
      doc.text(row.label, left + style.indent, y, {
        width: amountsStart - left - style.indent - 6,
        // The narrow label column of the multi-column layout cuts with an
        // ellipsis instead of wrapping into the next row.
        ...(multi ? { height: style.size + 3, ellipsis: true } : {}),
      });
      if (multi) {
        (row.amounts ?? []).forEach((amount, index) => {
          doc.text(amount, columnX(index), y, { width: columnWidth - 4, align: "right", lineBreak: false });
        });
      } else if (row.amount !== null) {
        doc.text(row.amount, left + STATEMENT_AMOUNT_COL.x, y, {
          width: STATEMENT_AMOUNT_COL.w,
          align: "right",
        });
      }
      y += style.size + 4;

      if (style.rule === "double") {
        rule(y);
        y += 4;
      }
    }

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  async function renderGeneralLedger(input: GeneralLedgerPdfInput): Promise<Buffer> {
    const { doc, finished } = await startDocument();
    const left = PAGE_MARGIN;
    let y = startReport(doc, input.title, input.subtitle);

    if (input.accounts.length === 0) {
      doc.font("Helvetica").fontSize(10).text(input.emptyText, left, y);
      doc.end();
      return finished;
    }

    for (const account of input.accounts) {
      // Reserve the heading plus the opening-balance line that always
      // follows it, so a heading never lands alone at the foot of a page
      // (same rule as renderPayrollReport's employee header). The heading
      // height is measured — a long account name wraps instead of colliding.
      doc.font("Helvetica-Bold").fontSize(11);
      const headingAdvance = doc.heightOfString(account.heading, { width: CONTENT_WIDTH }) + 6;
      if (y + headingAdvance + 13 > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      doc.text(account.heading, left, y, { width: CONTENT_WIDTH });
      y += headingAdvance;

      doc.font("Helvetica").fontSize(9);
      doc.text("Ingående saldo", left + LEDGER_COLS.text.x, y, { width: LEDGER_COLS.text.w });
      doc.text(account.openingAmount, left + LEDGER_COLS.balance.x, y, {
        width: LEDGER_COLS.balance.w,
        align: "right",
      });
      y += 13;

      for (const row of account.rows) {
        // The free-text cell wraps — its measured height drives the row.
        const rowHeight = Math.max(doc.heightOfString(row.text, { width: LEDGER_COLS.text.w }), 10) + 3;
        if (y + rowHeight > TABLE_BOTTOM) {
          doc.addPage();
          y = PAGE_MARGIN;
        }
        doc.text(row.date, left + LEDGER_COLS.date.x, y, { width: LEDGER_COLS.date.w });
        doc.text(row.verification, left + LEDGER_COLS.verification.x, y, {
          width: LEDGER_COLS.verification.w,
        });
        doc.text(row.text, left + LEDGER_COLS.text.x, y, { width: LEDGER_COLS.text.w });
        doc.text(row.debit, left + LEDGER_COLS.debit.x, y, { width: LEDGER_COLS.debit.w, align: "right" });
        doc.text(row.credit, left + LEDGER_COLS.credit.x, y, { width: LEDGER_COLS.credit.w, align: "right" });
        doc.text(row.balance, left + LEDGER_COLS.balance.x, y, {
          width: LEDGER_COLS.balance.w,
          align: "right",
        });
        y += rowHeight;
      }

      if (y + 15 > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      doc.font("Helvetica-Bold").fontSize(9);
      doc.text("Utgående saldo", left + LEDGER_COLS.text.x, y, { width: LEDGER_COLS.text.w });
      doc.text(account.closingAmount, left + LEDGER_COLS.balance.x, y, {
        width: LEDGER_COLS.balance.w,
        align: "right",
      });
      doc.font("Helvetica");
      y += 20;
    }

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  async function renderVerificationList(input: VerificationListPdfInput): Promise<Buffer> {
    const { doc, finished } = await startDocument();
    const left = PAGE_MARGIN;
    let y = startReport(doc, input.title, input.subtitle);

    if (input.verifications.length === 0) {
      doc.font("Helvetica").fontSize(10).text(input.emptyText, left, y);
      doc.end();
      return finished;
    }

    for (const verification of input.verifications) {
      // The heading and the text cells wrap freely (free-text descriptions,
      // long account names) — measure the wrapped height and let it drive
      // the cursor, so a wrapped line can never collide with the next row.
      doc.font("Helvetica-Bold").fontSize(10.5);
      const headingAdvance = doc.heightOfString(verification.heading, { width: CONTENT_WIDTH }) + 6;
      const headerReserve = headingAdvance + (verification.rows.length > 0 ? 13 : 0);
      if (y + headerReserve > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      doc.text(verification.heading, left, y, { width: CONTENT_WIDTH });
      y += headingAdvance;

      doc.font("Helvetica").fontSize(9);
      for (const row of verification.rows) {
        const rowHeight =
          Math.max(
            doc.heightOfString(row.account, { width: VERIFICATION_LIST_COLS.account.w }),
            doc.heightOfString(row.text, { width: VERIFICATION_LIST_COLS.text.w }),
            10,
          ) + 3;
        if (y + rowHeight > TABLE_BOTTOM) {
          doc.addPage();
          y = PAGE_MARGIN;
        }
        doc.text(row.account, left + VERIFICATION_LIST_COLS.account.x, y, {
          width: VERIFICATION_LIST_COLS.account.w,
        });
        doc.text(row.text, left + VERIFICATION_LIST_COLS.text.x, y, {
          width: VERIFICATION_LIST_COLS.text.w,
        });
        doc.text(row.debit, left + VERIFICATION_LIST_COLS.debit.x, y, {
          width: VERIFICATION_LIST_COLS.debit.w,
          align: "right",
        });
        doc.text(row.credit, left + VERIFICATION_LIST_COLS.credit.x, y, {
          width: VERIFICATION_LIST_COLS.credit.w,
          align: "right",
        });
        y += rowHeight;
      }

      if (y + 15 > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      doc.font("Helvetica-Bold").fontSize(9);
      doc.text("Summa", left + VERIFICATION_LIST_COLS.text.x, y, { width: VERIFICATION_LIST_COLS.text.w });
      doc.text(verification.totalDebit, left + VERIFICATION_LIST_COLS.debit.x, y, {
        width: VERIFICATION_LIST_COLS.debit.w,
        align: "right",
      });
      doc.text(verification.totalCredit, left + VERIFICATION_LIST_COLS.credit.x, y, {
        width: VERIFICATION_LIST_COLS.credit.w,
        align: "right",
      });
      doc.font("Helvetica");
      y += 20;
    }

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  async function renderOrderRegister(input: OrderRegisterPdfInput): Promise<Buffer> {
    const { doc, finished } = await startDocument({ landscape: true });
    const left = PAGE_MARGIN;
    const O = ORDER_REGISTER_ORDER_COLS;
    const R = ORDER_REGISTER_ROW_COLS;
    let y = startReport(doc, input.title, input.subtitle);
    const cell = (text: string, col: { x: number; w: number }, align: "left" | "right" = "left") =>
      // One line per cell: the height cap makes pdfkit cut a too-long text
      // with an ellipsis instead of wrapping into the next row.
      doc.text(text, left + col.x, y, { width: col.w, height: 11, align, ellipsis: true });

    const orderHeader = () => {
      doc.font("Helvetica-Bold").fontSize(8.5);
      cell("Order", O.orderNumber);
      cell("Orderdatum", O.orderDate);
      cell(input.partnerLabel, O.partner);
      cell("Status", O.status);
      cell("Leveransdatum", O.deliveryDate);
      cell("Valuta", O.currency);
      cell("Ordervärde", O.orderValue, "right");
      cell("Restvärde", O.restValue, "right");
      y += 12;
      if (input.withRows) {
        doc.font("Helvetica-Oblique").fontSize(8);
        cell("Artikel", R.articleNumber);
        cell("Benämning", R.articleName);
        cell("Antal", R.quantity, "right");
        cell(input.doneLabel, R.done, "right");
        cell("Rest", R.rest, "right");
        cell("Enhet", R.unit);
        cell("À-pris", R.unitPrice, "right");
        cell("Belopp", R.amount, "right");
        cell("Restbelopp", R.restAmount, "right");
        cell("Leveransdatum", R.deliveryDate);
        y += 11;
      }
      doc
        .moveTo(left, y)
        .lineTo(doc.page.width - PAGE_MARGIN, y)
        .strokeColor("#999999")
        .lineWidth(0.5)
        .stroke();
      y += 4;
    };
    // A new page repeats the column header so every sheet reads on its own.
    const ensure = (height: number) => {
      if (y + height > ORDER_REGISTER_TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
        orderHeader();
      }
    };

    if (input.orders.length === 0) {
      doc.font("Helvetica").fontSize(10).text(input.emptyText, left, y);
      doc.end();
      return finished;
    }

    orderHeader();
    for (const order of input.orders) {
      // An order heading never lands alone at the foot of a page.
      ensure(input.withRows && order.rows.length > 0 ? 24 : 12);
      doc.font(input.withRows ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
      cell(order.orderNumber, O.orderNumber);
      cell(order.orderDate, O.orderDate);
      cell(order.partner, O.partner);
      cell(order.status, O.status);
      cell(order.deliveryDate, O.deliveryDate);
      cell(order.currency, O.currency);
      cell(order.orderValue, O.orderValue, "right");
      cell(order.restValue, O.restValue, "right");
      y += 12;

      if (input.withRows) {
        doc.font("Helvetica").fontSize(8);
        for (const row of order.rows) {
          ensure(11);
          cell(row.articleNumber, R.articleNumber);
          cell(row.articleName, R.articleName);
          cell(row.quantity, R.quantity, "right");
          cell(row.done, R.done, "right");
          cell(row.rest, R.rest, "right");
          cell(row.unit, R.unit);
          cell(row.unitPrice, R.unitPrice, "right");
          cell(row.amount, R.amount, "right");
          cell(row.restAmount, R.restAmount, "right");
          cell(row.deliveryDate, R.deliveryDate);
          y += 11;
        }
        y += 5;
      }
    }

    ensure(20);
    doc
      .moveTo(left, y)
      .lineTo(doc.page.width - PAGE_MARGIN, y)
      .strokeColor("#666666")
      .lineWidth(0.5)
      .stroke();
    y += 5;
    doc.font("Helvetica-Bold").fontSize(9);
    doc.text(input.totals.label, left, y, { width: O.orderValue.x - 5, height: 12, ellipsis: true });
    cell(input.totals.orderValue, O.orderValue, "right");
    cell(input.totals.restValue, O.restValue, "right");

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  async function renderFixedAssetPlan(input: FixedAssetPlanPdfInput): Promise<Buffer> {
    const { doc, finished } = await startDocument();
    const left = PAGE_MARGIN;
    const C = FIXED_ASSET_PLAN_COLS;
    let y = startReport(doc, input.title, input.subtitle);
    const ensure = (height: number) => {
      if (y + height > TABLE_BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
    };
    const amountCell = (text: string, col: { x: number; w: number }) =>
      doc.text(text, left + col.x, y, { width: col.w, align: "right" });

    if (input.categories.length === 0) {
      doc.font("Helvetica").fontSize(10).text(input.emptyText, left, y);
      y += 18;
    }

    for (const category of input.categories) {
      ensure(60);
      doc.font("Helvetica-Bold").fontSize(11).text(category.heading, left, y, { width: CONTENT_WIDTH });
      y += 16;
      doc.font("Helvetica-Bold").fontSize(8.5);
      doc.text("Nr", left + C.number.x, y, { width: C.number.w });
      doc.text("Benämning", left + C.name.x, y, { width: C.name.w });
      doc.text("Anskaffad", left + C.acquired.x, y, { width: C.acquired.w });
      amountCell("Ansk.värde UB", C.cost);
      amountCell("Årets avskr.", C.yearDepreciation);
      amountCell("Ack. avskr. UB", C.accumulated);
      amountCell("Bokfört värde", C.bookValue);
      y += 14;

      doc.font("Helvetica").fontSize(8.5);
      for (const row of category.rows) {
        const rowHeight = Math.max(doc.heightOfString(row.name, { width: C.name.w }), 10) + 3;
        ensure(rowHeight);
        doc.text(row.number, left + C.number.x, y, { width: C.number.w });
        doc.text(row.name, left + C.name.x, y, { width: C.name.w });
        doc.text(row.acquired, left + C.acquired.x, y, { width: C.acquired.w });
        amountCell(row.cost, C.cost);
        amountCell(row.yearDepreciation, C.yearDepreciation);
        amountCell(row.accumulated, C.accumulated);
        amountCell(row.bookValue, C.bookValue);
        y += rowHeight;
      }
      doc.font("Helvetica-Oblique").fontSize(8.5);
      for (const line of category.movement) {
        ensure(12);
        doc.text(line, left + C.name.x, y, { width: CONTENT_WIDTH - C.name.x });
        y += 12;
      }
      y += 10;
    }

    ensure(24);
    doc
      .moveTo(left, y - 3)
      .lineTo(left + CONTENT_WIDTH, y - 3)
      .strokeColor("#666666")
      .lineWidth(0.5)
      .stroke();
    doc.font("Helvetica-Bold").fontSize(9.5);
    doc.text("Summa", left + C.name.x, y, { width: C.name.w });
    amountCell(input.totals.cost, C.cost);
    amountCell(input.totals.yearDepreciation, C.yearDepreciation);
    amountCell(input.totals.accumulated, C.accumulated);
    amountCell(input.totals.bookValue, C.bookValue);
    y += 24;

    ensure(30);
    doc.font("Helvetica-Bold").fontSize(9.5).text("Avstämning mot huvudboken", left, y);
    y += 14;
    doc.font("Helvetica").fontSize(9);
    for (const line of input.reconciliation) {
      const height = doc.heightOfString(line, { width: CONTENT_WIDTH }) + 3;
      ensure(height);
      doc.text(line, left, y, { width: CONTENT_WIDTH });
      y += height;
    }

    drawPageNumbers(doc);
    doc.end();
    return finished;
  }

  return {
    render,
    renderPaymentReminder,
    renderDeviationReport,
    renderPickList,
    renderStockCountSheet,
    renderDeliveryNote,
    renderManufacturingOrder,
    renderPalletCard,
    renderPayrollReport,
    renderFinancialStatement,
    renderGeneralLedger,
    renderVerificationList,
    renderFixedAssetPlan,
    renderOrderRegister,
  };
}

export type DocumentPdfService = ReturnType<typeof createDocumentPdfService>;
