import type { Db, Tx } from "@navet/db";
import type {
  CreateCreditInvoiceInput,
  CreateInvoiceInput,
  CreateInvoiceRowInput,
  InvoiceType,
  ListInvoicesQuery,
  RunCollectiveInvoicingInput,
  SendReminderInput,
  UpdateInvoiceHeaderInput,
  UpdateInvoiceRowInput,
} from "@navet/shared";
import { DEFAULT_VAT_RATE, round2, toUnitPrice, toUnitQuantity, type OrderRowConfiguration } from "@navet/shared";
import { rowConfigurationLines } from "../../configurator/service/configuration-lines.js";
import type { InvoiceRepository, InvoiceRowWrite, IssueStamp } from "../repository/invoice.repository.js";
import type { DocumentPdfInput, PaymentReminderPdfInput } from "../../mail/service/document-pdf.js";
import { ZeroAmountPostingError, type PostingVatCode } from "../../economy/service/verification-poster.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { CustomerNotFoundError, InvalidStatusTransitionError } from "./sales.service.js";
// G1: append-only audit trail — optional with a no-op default (see
// sales.service.ts's identical comment) so the many pre-existing test call
// sites keep compiling; app.ts wires the real one.
import type { AuditWriter } from "../../system/repository/audit.repository.js";

// Narrow slices of mail/pdf services — same cross-module pattern as
// StockBalanceReader in sales.service.ts. No CompanyInfoReader here: the
// payment box's Bankgiro/Plusgiro text is drawn by InvoicePdfRenderer from
// its OWN already-loaded company data (the same loader the document footer
// uses) — fetching it again here would be a redundant second round trip for
// data this module never reads itself.
export interface InvoiceMailSender {
  sendMail(mail: {
    // A påminnelse (B3) is logged against the invoice's own id, so the card's
    // send history shows invoice and reminder emails in one list.
    documentType: "invoice" | "payment_reminder";
    documentId: string;
    to: string;
    subject: string;
    message: string;
    attachments?: { filename: string; content: Buffer }[];
  }): Promise<unknown>;
}

export interface InvoicePdfRenderer {
  render(input: DocumentPdfInput): Promise<Buffer>;
  renderPaymentReminder(input: PaymentReminderPdfInput): Promise<Buffer>;
}

// G1: resolves a human-readable article number for row audit detail — same
// cross-module reader shape as sales.service.ts's/purchase.service.ts's own
// getArticle-based lookup (articleFiles.getArticle). Optional: a free-text
// invoice row carries no articleId and simply logs without articleNumber, as
// it always has.
export interface ArticleNumberReader {
  // `name` is what listInvoiceableShipments labels the freight article with;
  // the audit detail only ever uses articleNumber.
  getArticle(id: string): Promise<{ articleNumber: string; name?: string } | null>;
}

// Frakt etapp 2 — which article is the freight article (shipping settings),
// injected so the invoice module never reads another module's settings keys.
// Same consumer-declared reader shape as ArticleNumberReader above.
export interface InvoiceFreightReader {
  freightArticleId(): Promise<string | null>;
}

// Automatkontering (B2): the slice of the economy module's VerificationPoster
// this module uses — declared here, at the consumer, like every other
// cross-module reader in sales (StockBalanceReader, RegisterReferenceReader).
// Tx-composable by design: the posting happens inside issueInvoice's own
// transaction, so the verification, the verifikatnummer and the FA number
// either all commit or all roll back.
export interface CustomerInvoicePoster {
  postCustomerInvoice(
    tx: Tx,
    doc: { invoiceNumber: string; type: InvoiceType; invoiceDate: string; customerName: string },
    // Amounts exactly as stored on the invoice rows — always POSITIVE, also
    // for a credit note (the poster mirrors from doc.type itself) — with each
    // row's momskod as loaded in the same transaction.
    rows: { articleGroupId: string | null; lineAmount: number; vatAmount: number; vatRate: number; vatCode: PostingVatCode }[],
    userId: string
  ): Promise<{ verificationId: string; displayNumber: string }>;
}

// Kundreskontra (B3): the påminnelseavgift half of the poster, declared at the
// consumer like CustomerInvoicePoster above. Tx-composable for the same
// reason: the fee's verification, the reminder row and its verifikatnummer
// commit or roll back together.
export interface InvoiceReminderPoster {
  postReminderFee(
    tx: Tx,
    doc: { invoiceNumber: string; reminderDate: string; customerName: string; feeAmount: number },
    userId: string
  ): Promise<{ verificationId: string; displayNumber: string }>;

  // Pre-flight: throws the SAME typed errors postReminderFee would when the
  // posting is impossible for configuration reasons (missing/inactive fee or
  // receivable account, no accounting period covering the date, a locked
  // one). Called BEFORE the reminder email goes out — see sendReminder.
  assertReminderFeePostable(executor: Db | Tx, reminderDate: string): Promise<void>;
}

// The input to sendEmail — mirrors SendDocumentEmailInput minus
// attachDrawings (the invoice module has no article-drawing attachments).
export type SendInvoiceEmailInput = { to: string; subject: string; message: string };

export class ArchivedReminderNotFoundError extends Error {
  constructor(reminderId: string) {
    super(`No archived PDF for reminder ${reminderId}`);
    this.name = "ArchivedReminderNotFoundError";
  }
}

export class InvoiceNotFoundError extends Error {
  constructor(id: string) {
    super(`Invoice ${id} not found`);
    this.name = "InvoiceNotFoundError";
  }
}

// Issuing a draft with no rows would mint an FA number for an empty document.
export class EmptyInvoiceError extends Error {
  constructor(id: string) {
    super(`Invoice ${id} has no rows`);
    this.name = "EmptyInvoiceError";
  }
}

export class InvoiceRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Invoice row ${id} not found`);
    this.name = "InvoiceRowNotFoundError";
  }
}

// A row's linked sales order row must belong to the invoice's own customer
// and match the row's own article — in the style of PoMatchMismatchError.
export class SalesOrderRowMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesOrderRowMismatchError";
  }
}

// A linked row's quantity, plus what's already invoiced (drafts included),
// would exceed what's actually been delivered on the sales order row.
export class OverInvoicingError extends Error {
  constructor() {
    super("Invoiced quantity would exceed the delivered quantity for this sales order row");
    this.name = "OverInvoicingError";
  }
}

// A credit row's quantity would credit more than what's currently net
// invoiced (issued+paid+drafts, credits already negated) for this sales
// order row — the credit-note mirror of OverInvoicingError.
export class OverCreditError extends Error {
  constructor() {
    super("Credited quantity would exceed the net invoiced quantity for this sales order row");
    this.name = "OverCreditError";
  }
}

// A credit note may only be raised against an issued or paid ORIGINAL
// invoice — never a draft/cancelled invoice, and never a credit note itself
// (no credit-of-credit).
export class NotCreditableError extends Error {
  constructor(id: string) {
    super(`Invoice ${id} cannot be credited: it must be an issued or paid invoice, not itself a credit note`);
    this.name = "NotCreditableError";
  }
}

// Samlingsfaktura: a customer flagged collective_invoicing is billed by the
// collective invoicing routine only — the ordinary create() refuses them so
// nobody bills one order by hand while the routine sweeps the rest. Credit
// notes and row edits on an existing draft are unaffected.
export class CollectiveInvoicingCustomerError extends Error {
  constructor(customerId: string) {
    super(`Customer ${customerId} is billed by collective invoicing — use the samlingsfakturering routine`);
    this.name = "CollectiveInvoicingCustomerError";
  }
}

// Frakt etapp 2: a row with shipmentId breaks one of the freight row's rules
// (customer, status, article, order link, quantity) — the message is what the
// user sees, so it is Swedish, in the style of the shipping module's errors.
export class InvalidShipmentInvoiceRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidShipmentInvoiceRowError";
  }
}

// The same freight must never be billed twice: thrown by resolveRow's
// pre-check, and by create/addRow when the partial unique index
// invoice_rows_shipment_unique catches what raced past it.
export class ShipmentAlreadyInvoicedError extends Error {
  constructor(shipmentNumber: string) {
    super(`Frakten för ${shipmentNumber} är redan fakturerad`);
    this.name = "ShipmentAlreadyInvoicedError";
  }
}

// The freight row's default text: "Frakt DHL Paket (FR-2026-12)", truncated
// to the column's 255 chars. Used by the dialog's prefill and the collective
// invoicing routine; a user may overwrite it ("manuellt vinner").
export function freightRowDescription(s: { carrierName: string | null; productName: string | null; shipmentNumber: string }) {
  const name = [s.carrierName, s.productName].filter(Boolean).join(" ");
  return `Frakt ${name ? `${name} ` : ""}(${s.shipmentNumber})`.slice(0, 255);
}

// The partial unique index on invoice_rows.shipment_id fired — mirrors the
// shipping repository's isActiveLinkViolation (postgres.js reports the
// constraint name on the error or on its cause, like the code itself).
function isShipmentInvoicedViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
  return (e.constraint_name ?? e.cause?.constraint_name) === "invoice_rows_shipment_unique";
}

// The routine's per-customer outcome. `failed` carries the error message;
// `skipped` means nothing was left to bill; `draft`/`issued` carry the
// invoice. A create that succeeded but whose issue failed reports `draft`
// WITH an error — the draft exists and can be issued by hand.
export type CollectiveInvoicingResult = {
  customerId: string;
  customerNumber: string | null;
  name: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: "draft" | "issued" | "skipped" | "failed";
  rowCount: number;
  error: string | null;
};

// A reminder demands money: there has to be some. Covers both "issued but
// nothing left open" (paid off without the paid-flip, or written off) and a
// credit note, whose open amount points the other way — we owe THEM.
export class NothingToRemindError extends Error {
  constructor(id: string) {
    super(`Invoice ${id} has no open amount to remind about`);
    this.name = "NothingToRemindError";
  }
}

// Lagen om ersättning för inkassokostnader allows ONE påminnelseavgift per
// invoice. Further reminders are free of charge — this is what refuses the
// second fee (the partial unique index invoice_reminders_one_fee is the
// backstop for anything that races past the check).
export class ReminderFeeAlreadyChargedError extends Error {
  constructor(id: string) {
    super(`Invoice ${id} has already been charged a reminder fee`);
    this.name = "ReminderFeeAlreadyChargedError";
  }
}

// dueDate: invoiceDate + parseInt(paymentTermCode) days when the code is a
// finite number of days ("30" -> 30 dagar netto), else null (a code like
// "KONTANT" just prints the term itself, no computed due date) — same parse
// as renderInvoicePdf in sales.service.ts. Computed off the SAME `now`
// instant the caller formats as invoiceDate (not a re-parse of that string)
// so the day-count is exact regardless of server timezone, and formatted
// with the same sv-SE local-date idiom used elsewhere in the codebase.
function computeDueDate(now: Date, paymentTermCode: string | null): string | null {
  const termDays = Number.parseInt(paymentTermCode ?? "", 10);
  if (!Number.isFinite(termDays)) return null;
  return new Date(now.getTime() + termDays * 24 * 60 * 60 * 1000).toLocaleDateString("sv-SE");
}

// A row as the client may send it (create or the merged result of a PATCH).
type RowInput = {
  articleId?: string | null;
  salesOrderRowId?: string | null;
  // Frakt etapp 2: the booked shipment a freight row bills.
  shipmentId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent?: number;
  vatRate?: number | null;
  // Konfigurator 4b: the row's configuration copy. Set ⇒ used verbatim (a
  // credit note copies its source row's); undefined ⇒ the linked order
  // row's. Never client input — the route schemas have no such field.
  configuration?: OrderRowConfiguration | null;
};

export function createInvoiceService(
  repo: InvoiceRepository,
  mail: InvoiceMailSender,
  pdf: InvoicePdfRenderer,
  // One object satisfies both halves (the economy module's VerificationPoster);
  // they are declared separately because they are used by two unrelated flows —
  // issuing an invoice (F) and charging a reminder fee (K).
  poster: CustomerInvoicePoster & InvoiceReminderPoster,
  // G1: optional, defaults to a no-op — see the import comment above.
  audit: AuditWriter = { log: async () => {} },
  // G1: optional, defaults to "no lookup" — see ArticleNumberReader above.
  articleReader: ArticleNumberReader = { getArticle: async () => null },
  // Frakt etapp 2: optional, defaults to "no freight article" — then no
  // shipment is ever offered for billing and a shipment row is refused.
  freight: InvoiceFreightReader = { freightArticleId: async () => null }
) {
  // Raw invoice row (findRawById's return shape) — the slice buildPdf needs.
  type RawInvoice = NonNullable<Awaited<ReturnType<InvoiceRepository["findRawById"]>>>;

  // G1: resolves articleNumber for row audit detail — null for a free-text
  // row (no articleId) or an articleId the reader doesn't recognize.
  async function articleNumberFor(articleId: string | null) {
    if (!articleId) return null;
    const article = await articleReader.getArticle(articleId);
    return article?.articleNumber ?? null;
  }

  // Shared by renderPdf and sendEmail so both guard/load the invoice
  // identically (same pattern as sales.service's getInvoicePdf/
  // sendInvoiceEmail pair) while building the PDF exactly once per call.
  async function buildPdf(invoice: RawInvoice) {
    const rows = await repo.listRows(invoice.id);
    const isCredit = invoice.type === "credit";
    // Credits: quantities stay positive, unit prices (and thus every
    // downstream line amount / total / Att betala) are negated — the
    // renderer itself never restructures its arithmetic for this, it just
    // receives already-negative unitPrice values (assembled here, per the
    // "smaller diff" choice over a renderer-side sign flag).
    const sign = isCredit ? -1 : 1;

    // Credit notes reference their source invoice's OWN FA number in the
    // header, using the same field the sales-order documents use for
    // "Ordernummer" (orderReference).
    let creditReference: string | null = null;
    if (isCredit && invoice.creditedInvoiceId) {
      const source = await repo.findRawById(invoice.creditedInvoiceId);
      creditReference = source?.invoiceNumber ? `Krediterar faktura ${source.invoiceNumber}` : null;
    }

    const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : null;

    // Vårt leverantörsnummer is deliberately NOT snapshotted (same rule as
    // suppliers.our_customer_number): the customer's number for us is theirs
    // to change, and a reprint should carry the current one.
    const customer = await repo.findCustomerById(invoice.customerId);

    const content = await pdf.render({
      title: isCredit ? "Kreditfaktura" : "Faktura",
      documentNumber: invoice.invoiceNumber!,
      date: invoice.invoiceDate ? new Date(invoice.invoiceDate) : new Date(),
      partnerLabel: "Fakturaadress",
      // Snapshot columns only — never the live customer, so a reprint after
      // the customer is renamed/moved still shows what was true at issue.
      partner: {
        name: invoice.customerName ?? "",
        address: invoice.invoiceAddress,
        postalCode: invoice.invoicePostalCode,
        city: invoice.invoiceCity,
        country: invoice.invoiceCountry,
      },
      currency: "SEK",
      // Printed in the row's own unit — quantity/unitPrice are stored in the
      // article's base unit (see resolveRow's comment), unitFactor is the
      // snapshot taken when the row was linked/created. Mirrors
      // sales.service.ts's renderInvoicePdf/renderSalesOrderPdf.
      rows: rows.map((r) => ({
        articleNumber: r.articleNumber ?? "",
        articleName: r.articleName ?? r.description,
        quantity: String(toUnitQuantity(Number(r.quantity), r.unitFactor)),
        unit: r.unitCode,
        unitPrice: String(toUnitPrice(Number(r.unitPrice), r.unitFactor) * sign),
        discountPercent: r.discountPercent,
        vatRate: Number(r.vatRate),
        // Stored amounts (invoice_rows.lineAmount/vatAmount) are the PDF's
        // monetary authority — the same round2:ed figures the B2 ledger
        // posting and the API list/card already sum, so all three agree on
        // multi-row/odd-rate invoices where per-row-round2 VAT can diverge
        // from VAT recomputed on the summed net. Stored amounts are ALWAYS
        // positive (see invoice_rows' own comment); credits get the same
        // sign treatment already applied to unitPrice above.
        lineAmount: String(sign * Number(r.lineAmount)),
        vatAmount: String(sign * Number(r.vatAmount)),
        // Which order (and the customer's own order number) the row settles
        // — per row rather than in the header, since a samlingsfaktura mixes
        // several orders. Free rows print nothing.
        orderReference: r.salesOrderRowId
          ? `Order ${r.salesOrderNumber}${r.customerOrderNumber ? ` · Ert ordernr ${r.customerOrderNumber}` : ""}`
          : null,
        // Konfigurator 4b: the row's own configuration copy, with the price
        // additions per the customer's Visa tilläggspriser as it is when the
        // PDF is built — i.e. at issue, since the PDF is archived right then
        // and every later print serves the archived bytes.
        configurationLines: rowConfigurationLines(r.configuration, customer?.showConfigurationPrices ?? false),
      })),
      showTotal: true,
      vat: { perRow: true },
      // Snapshot: what the customer was at issue, not what they are now.
      pricesIncludeVat: invoice.privatePerson,
      dueDate,
      orderReference: creditReference,
      ourSupplierNumberAtCustomer: customer?.ourSupplierNumber ?? null,
      // Snapshot column only — never the live customer (same rule as the
      // address block above).
      partnerNumber: invoice.customerNumber,
      // OCR/dueDate come straight off the invoice itself — issued/paid means
      // both were already stamped at issue. Bankgiro/Plusgiro are filled in
      // by the renderer from its own company data. A credit note DOES get its
      // own ocrNumber stamped at issue (issueInvoice mints one for every
      // type), but it is nothing to pay — there is no OCR-betalning against a
      // credit, so the payment box is omitted entirely rather than printing
      // an OCR-nummer/Förfallodatum nobody should use.
      payment: isCredit ? undefined : { ocrNumber: invoice.ocrNumber, dueDate },
    });

    const prefix = isCredit ? "Kreditfaktura" : "Faktura";
    return { filename: `${prefix}-${invoice.invoiceNumber}.pdf`, content };
  }

  // Everything a reminder needs to know about the invoice's money, read once.
  // The three figures are DERIVED, never recomputed differently from the
  // authorities they come from:
  //   * gross   — the STORED row amounts (invoice_rows.lineAmount/vatAmount),
  //               the same figures the ledger posting and the invoice PDF use,
  //   * open    — open-amounts.ts, the single aggregation authority (it
  //               already includes any fee charged earlier),
  //   * settled — what payments/credits have taken off, obtained from the
  //               identity open = gross − settled + fee rather than by summing
  //               the payment rows a second time. One authority, one answer.
  async function reminderContext(invoice: RawInvoice) {
    const [rows, open, reminders] = await Promise.all([
      repo.listRows(invoice.id),
      repo.getOpenAmount(invoice.id),
      repo.listRemindersForInvoice(invoice.id),
    ]);
    const sign = invoice.type === "credit" ? -1 : 1;
    const gross = round2(sign * rows.reduce((sum, row) => sum + Number(row.lineAmount) + Number(row.vatAmount), 0));
    const chargedFee = round2(reminders.reduce((sum, reminder) => sum + Number(reminder.fee), 0));
    return { open: round2(open), reminders, gross, chargedFee, settled: round2(gross + chargedFee - open) };
  }

  // `newFee` is the fee this reminder is ABOUT to charge (0 for a fee-free
  // one): it is printed because the customer is being asked to pay it, and the
  // transaction that persists it runs right after the email goes out.
  async function buildReminderPdf(
    invoice: RawInvoice,
    context: Awaited<ReturnType<typeof reminderContext>>,
    level: number,
    newFee: number,
    printedAt: Date
  ) {
    const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : null;
    const content = await pdf.renderPaymentReminder({
      level,
      documentNumber: invoice.invoiceNumber!,
      printedAt,
      invoiceDate: invoice.invoiceDate ? new Date(invoice.invoiceDate) : null,
      dueDate,
      // Snapshot columns only — never the live customer (same rule as the
      // invoice's own PDF).
      partner: {
        name: invoice.customerName ?? "",
        address: invoice.invoiceAddress,
        postalCode: invoice.invoicePostalCode,
        city: invoice.invoiceCity,
        country: invoice.invoiceCountry,
      },
      currency: "SEK",
      grossAmount: context.gross,
      settledAmount: context.settled,
      feeAmount: round2(context.chargedFee + newFee),
      amountDue: round2(context.open + newFee),
      payment: { ocrNumber: invoice.ocrNumber, dueDate },
    });
    return { filename: `Betalningspåminnelse-${invoice.invoiceNumber}.pdf`, content };
  }

  // Validates the optional delfakturering link and computes the unit
  // snapshot, VAT rate, and line/vat amounts.
  async function resolveRow(
    invoiceCustomerId: string,
    input: RowInput,
    // The row's own current state, when this is a PATCH — used to exclude
    // its own already-invoiced quantity from the over-invoicing/over-credit
    // guard below.
    existingRow?: { salesOrderRowId: string | null; quantity: number; shipmentId?: string | null },
    // Running per-salesOrderRowId tally of rows already resolved earlier in
    // THIS SAME create()/createCredit() batch (not yet persisted, so
    // getInvoicedQuantities can't see them) — without this, two rows in one
    // call linked to the same order row would each be checked against the
    // same stale pre-insert "already invoiced" figure instead of
    // cumulatively. Pre-signed by the caller: create() accumulates
    // positively (matches how invoice rows count in the CASE aggregate),
    // createCredit() accumulates negatively (matches how credit rows count) —
    // resolveRow just adds it, unaware of the sign convention itself.
    batchAccumulated?: Map<string, number>,
    // The invoice this row belongs to — "invoice" rows are checked against
    // the over-invoicing guard (may not exceed delivered), "credit" rows
    // against the over-credit guard (net invoiced may not go below 0).
    type: InvoiceType = "invoice"
  ): Promise<InvoiceRowWrite> {
    const articleId = input.articleId ?? null;
    const salesOrderRowId = input.salesOrderRowId ?? null;

    // Frakt etapp 2: a freight row is bound to its booked shipment — the
    // invoice's own customer, the configured freight article, no order link
    // (the shipment IS the link), exactly one unit. Price and text are the
    // client's. Never on a credit note (a credit copies amounts, not links).
    // Checked BEFORE the order-row link below so "no order link" is reported
    // as the freight rule it is, not as an article mismatch on that link.
    const shipmentId = input.shipmentId ?? null;
    if (shipmentId) {
      const invalid = (message: string) => new InvalidShipmentInvoiceRowError(message);
      if (type === "credit") throw invalid("En kreditfaktura kan inte kopplas till en försändelse");
      const freightArticleId = await freight.freightArticleId();
      const shipment = await repo.findShipmentForInvoicing(shipmentId);
      if (!shipment) throw invalid("Försändelsen finns inte");
      if (shipment.customerId !== invoiceCustomerId) throw invalid(`${shipment.shipmentNumber} tillhör en annan kund`);
      if (shipment.status !== "booked" && shipment.status !== "delivered") {
        throw invalid(`${shipment.shipmentNumber} är inte bokad`);
      }
      if (!freightArticleId) throw invalid("Ingen fraktartikel är vald — välj en under System → Frakt");
      if (articleId !== freightArticleId) throw invalid("Fraktraden ska ha fraktartikeln");
      if (salesOrderRowId) throw invalid("Fraktraden kan inte kopplas till en orderrad");
      if (input.quantity !== 1) throw invalid("Fraktraden ska ha antal 1");
      // A PATCH re-resolves the row with its own shipmentId — only a NEW link
      // must be unbilled; the unique index is the race-proof guard.
      if (shipment.invoiced && existingRow?.shipmentId !== shipmentId) {
        throw new ShipmentAlreadyInvoicedError(shipment.shipmentNumber);
      }
    }

    // Unit snapshot: a linked row copies the order row's unit/factor. A free
    // row (no link) has no unitId of its own to resolve against the
    // article's alternative units — the invoice row input carries no unitId
    // — so it is always stored in the base unit (null/null), whether or not
    // it carries an articleId.
    let unitId: string | null = null;
    let unitFactor: number | null = null;
    let quantityDelivered = 0;
    // Konfigurator 4b: a caller-supplied copy wins (credit note), else the
    // linked order row's; a free row has none.
    let configuration: OrderRowConfiguration | null = input.configuration ?? null;

    if (salesOrderRowId) {
      const orderRow = await repo.findSalesOrderRowForInvoicing(salesOrderRowId);
      if (!orderRow) throw new SalesOrderRowMismatchError("The linked sales order row does not exist");
      if (orderRow.customerId !== invoiceCustomerId) {
        throw new SalesOrderRowMismatchError("The linked sales order row belongs to a different customer");
      }
      if (articleId === null || orderRow.articleId !== articleId) {
        throw new SalesOrderRowMismatchError("The linked sales order row is for a different article");
      }
      unitId = orderRow.unitId;
      unitFactor = orderRow.unitFactor !== null ? Number(orderRow.unitFactor) : null;
      quantityDelivered = Number(orderRow.quantityDelivered);
      if (input.configuration === undefined) configuration = (orderRow.configuration as OrderRowConfiguration | null) ?? null;
    }

    // vatRate: explicit input wins, else the article's own default, else the
    // standard rate.
    let vatRate = input.vatRate ?? null;
    if (vatRate === null) {
      vatRate = articleId !== null ? await repo.findArticleVatRate(articleId) : null;
      vatRate ??= DEFAULT_VAT_RATE;
    }

    // discountPercent is baked into lineAmount with a single rounding — same
    // rule as the order row's own discount (sales.service.ts) — rather than
    // rounded separately and subtracted, so 900.00 (not 900.00±0.01) is what
    // gets stored and posted. A linked row (salesOrderRowId set) gets its
    // discount from the INPUT, never looked up from the order row itself —
    // same principle as unitPrice: the row is whatever the client sends
    // (the web prefills it from listInvoiceableOrders). A free row defaults
    // to 0.
    const discountPercent = input.discountPercent ?? 0;
    const lineAmount = round2(input.quantity * input.unitPrice * (1 - discountPercent / 100));
    const vatAmount = round2(lineAmount * (vatRate / 100));

    // Over-invoicing / over-credit guard — only for rows linked to a sales
    // order row; free rows are never guarded (nothing to reconcile against).
    if (salesOrderRowId) {
      const invoiced = await repo.getInvoicedQuantities([salesOrderRowId], { includeDrafts: true });
      let netInvoiced = invoiced.get(salesOrderRowId) ?? 0;
      if (existingRow && existingRow.salesOrderRowId === salesOrderRowId) {
        // Exclude this row's own prior contribution before re-validating
        // against its new quantity. The aggregate CASE counts invoice rows
        // + and credit rows -, so "excluding" is the opposite operation for
        // each: subtract for an invoice row, add back for a credit row.
        netInvoiced += type === "credit" ? existingRow.quantity : -existingRow.quantity;
      }
      // Already signed by the caller per this batch's invoice type.
      netInvoiced += batchAccumulated?.get(salesOrderRowId) ?? 0;

      if (type === "credit") {
        if (netInvoiced - input.quantity < 0) {
          throw new OverCreditError();
        }
      } else if (netInvoiced + input.quantity > quantityDelivered) {
        throw new OverInvoicingError();
      }
    }

    return {
      articleId,
      salesOrderRowId,
      shipmentId,
      description: input.description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      discountPercent,
      unitId,
      unitFactor,
      vatRate,
      lineAmount,
      vatAmount,
      configuration,
    };
  }

  // Frakt etapp 2: the partial unique index invoice_rows_shipment_unique
  // fired under create/addRow — a concurrent writer billed the same
  // shipment between resolveRow's pre-check and this insert. Rethrown as the
  // same 409 the pre-check gives, named after the shipment when it can still
  // be read. Any other error is left to the caller to rethrow as is.
  async function rethrowShipmentConflict(err: unknown, rows: InvoiceRowWrite[]): Promise<void> {
    if (!isShipmentInvoicedViolation(err)) return;
    // Several freight rows can share one invoice — re-read each linked
    // shipment and name the one the other writer actually took.
    for (const row of rows) {
      if (!row.shipmentId) continue;
      const shipment = await repo.findShipmentForInvoicing(row.shipmentId);
      if (shipment?.invoiced) throw new ShipmentAlreadyInvoicedError(shipment.shipmentNumber);
    }
    throw new ShipmentAlreadyInvoicedError("försändelsen");
  }

  // The invoice PDF a customer actually gets: the archived copy when there
  // is one, otherwise rendered NOW and archived (first writer wins) — so the
  // first PDF ever shown or sent is the one every later reprint/email
  // serves, and live company data (bankgiro, address, logo) can never alter
  // an issued invoice after the fact. Normally archived right at issue.
  async function archivedInvoicePdf(invoice: RawInvoice): Promise<{ filename: string; content: Buffer }> {
    const existing = await repo.findDocument(invoice.id, { kind: "invoice" });
    if (existing) return { filename: existing.filename, content: existing.data };
    const archived = await repo.archiveInvoiceDocument(invoice.id, await buildPdf(invoice));
    return { filename: archived.filename, content: archived.data };
  }

  const service = {
    async list(query: ListInvoicesQuery) {
      return repo.list(query);
    },

    // Joined header + rows for the detail view, plus the kundreskontra (B3)
    // slice: what is still open on the invoice and which payments have
    // touched it. The open amount is DERIVED (open-amounts.ts is the single
    // authority) — there is no stored balance to read, and a draft simply
    // reports what its rows would become at issue.
    //
    // reminders[] joins the shape the same way payments[] does, from its own
    // repository read — a charged fee is already part of openAmount above.
    //
    // creditedBy[] is the reverse of creditedInvoiceId — every non-cancelled
    // credit note that targets this invoice — so the card can link forward
    // to a credit the same way it already links back to the source invoice
    // (creditedInvoiceId). Empty for a credit note itself (nothing credits a
    // credit note in this model).
    async getInvoice(id: string) {
      const header = await repo.findById(id);
      if (!header) return null;
      const [rows, openAmount, payments, reminders, creditedBy] = await Promise.all([
        repo.listRows(id),
        repo.getOpenAmount(id),
        repo.listPaymentsForInvoice(id),
        repo.listRemindersForInvoice(id),
        repo.listCreditedBy(id),
      ]);
      return { ...header, rows, openAmount, payments, reminders, creditedBy };
    },

    // opts.collective is the routine's back door past the samlingsfaktura
    // guard — never set from a route.
    async create(input: CreateInvoiceInput, createdBy: string, opts: { collective?: boolean } = {}) {
      const customer = await repo.findCustomerById(input.customerId);
      if (!customer) throw new CustomerNotFoundError(input.customerId);
      if (customer.collectiveInvoicing && !opts.collective) {
        throw new CollectiveInvoicingCustomerError(customer.id);
      }
      // A collection invoice may bill rows against several of the customer's
      // orders in one go — resolveRow validates each row's own order/article
      // match independently, so mixing orders (same customer) is allowed and
      // a row against another customer's order fails per-row. Rows are
      // resolved SEQUENTIALLY (not Promise.all) and share a running
      // batchAccumulated tally so two rows linked to the same
      // salesOrderRowId within this one call are checked cumulatively
      // against the over-invoicing guard, not each against the same stale
      // pre-insert "already invoiced" read.
      const batchAccumulated = new Map<string, number>();
      const rows: InvoiceRowWrite[] = [];
      for (const r of input.rows) {
        const resolved = await resolveRow(input.customerId, r, undefined, batchAccumulated);
        rows.push(resolved);
        if (resolved.salesOrderRowId) {
          batchAccumulated.set(
            resolved.salesOrderRowId,
            (batchAccumulated.get(resolved.salesOrderRowId) ?? 0) + resolved.quantity
          );
        }
      }
      let invoice;
      try {
        invoice = await repo.create(
          {
            customerId: input.customerId,
            paymentTermId: input.paymentTermId ?? null,
            note: input.note ?? null,
          },
          rows,
          createdBy
        );
      } catch (err) {
        await rethrowShipmentConflict(err, rows);
        throw err;
      }
      return service.getInvoice(invoice.id);
    },

    // Raises a credit note against an issued/paid invoice — draft, same
    // customer/paymentTermId as the source, rows prefilled as positive
    // copies of the source's own rows unless input.rows overrides (partial
    // credit). Afterwards editable via the ordinary draft row endpoints
    // (addRow/updateRow/deleteRow) exactly like any other draft.
    async createCredit(invoiceId: string, input: CreateCreditInvoiceInput, createdBy: string) {
      const source = await repo.findRawById(invoiceId);
      if (!source) throw new InvoiceNotFoundError(invoiceId);
      if (source.type !== "invoice" || (source.status !== "issued" && source.status !== "paid")) {
        throw new NotCreditableError(invoiceId);
      }

      // input.rows, when provided (even an empty array), overrides the
      // prefill entirely — undefined means "mirror every row on the source".
      let rowInputs: RowInput[];
      if (input.rows !== undefined) {
        rowInputs = input.rows;
      } else {
        const sourceRows = await repo.listRows(invoiceId);
        rowInputs = sourceRows.map((r) => ({
          articleId: r.articleId,
          salesOrderRowId: r.salesOrderRowId,
          description: r.description,
          quantity: Number(r.quantity),
          unitPrice: Number(r.unitPrice),
          discountPercent: Number(r.discountPercent),
          vatRate: Number(r.vatRate),
          // The credit copies the SOURCE row's configuration, not the order
          // row's (identical in practice — an invoiced row cannot be
          // reconfigured — but the credit mirrors the invoice it credits).
          configuration: r.configuration as OrderRowConfiguration | null,
        }));
      }

      // Same sequential-resolve + running-tally pattern as create() above,
      // but the tally SUBTRACTS: multiple credit rows in this one call
      // against the same salesOrderRowId must accumulate their combined
      // negative effect on net invoiced, not each be checked against the
      // same stale pre-insert read.
      const batchAccumulated = new Map<string, number>();
      const rows: InvoiceRowWrite[] = [];
      for (const r of rowInputs) {
        const resolved = await resolveRow(source.customerId, r, undefined, batchAccumulated, "credit");
        rows.push(resolved);
        if (resolved.salesOrderRowId) {
          batchAccumulated.set(
            resolved.salesOrderRowId,
            (batchAccumulated.get(resolved.salesOrderRowId) ?? 0) - resolved.quantity
          );
        }
      }

      const credit = await repo.create(
        {
          customerId: source.customerId,
          paymentTermId: source.paymentTermId,
          note: null,
          type: "credit",
          creditedInvoiceId: invoiceId,
        },
        rows,
        createdBy
      );
      // Logged under the SOURCE invoice (it already has an FA number; the
      // new credit note is still a numberless draft) — visible on the
      // invoice being credited, same "row events log under the parent
      // document" idea extended to a related document's creation.
      await audit.log({
        entityType: "invoice",
        entityId: source.invoiceNumber ?? source.id,
        action: "credit_created",
        detail: { creditInvoiceId: credit.id },
        userId: createdBy,
      });
      return service.getInvoice(credit.id);
    },

    // Header edits are allowed only in draft.
    async updateHeader(id: string, input: UpdateInvoiceHeaderInput, userId?: string | null) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new InvoiceNotFoundError(id);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot change an invoice in status "${invoice.status}"`);
      }
      const patch: { paymentTermId?: string | null; note?: string | null } = {};
      if (input.paymentTermId !== undefined) patch.paymentTermId = input.paymentTermId;
      if (input.note !== undefined) patch.note = input.note;
      const updated = await repo.updateHeader(id, patch);
      // null means a concurrent issue() already froze this invoice between
      // the check above and the repo's own row-locked draft guard.
      if (!updated) throw new InvalidStatusTransitionError(`Cannot change invoice ${id}: it is no longer a draft`);
      await audit.log({
        entityType: "invoice",
        entityId: invoice.invoiceNumber ?? invoice.id,
        action: "updated",
        detail: {
          before: { paymentTermId: invoice.paymentTermId, note: invoice.note },
          after: { paymentTermId: updated.paymentTermId, note: updated.note },
        },
        userId: userId ?? null,
      });
      return service.getInvoice(id);
    },

    async addRow(invoiceId: string, input: CreateInvoiceRowInput, userId?: string | null) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new InvoiceNotFoundError(invoiceId);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot change rows on an invoice in status "${invoice.status}"`);
      }
      const resolved = await resolveRow(invoice.customerId, input, undefined, undefined, invoice.type);
      let row;
      try {
        row = await repo.addRow(invoiceId, resolved);
      } catch (err) {
        await rethrowShipmentConflict(err, [resolved]);
        throw err;
      }
      // null means a concurrent issue() already froze this invoice between
      // the check above and the repo's own row-locked draft guard.
      if (!row) throw new InvalidStatusTransitionError(`Cannot add a row to invoice ${invoiceId}: it is no longer a draft`);
      await audit.log({
        entityType: "invoice",
        entityId: invoice.invoiceNumber ?? invoice.id,
        action: "row_added",
        detail: {
          articleNumber: await articleNumberFor(row.articleId),
          description: row.description,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          discountPercent: row.discountPercent,
        },
        userId: userId ?? null,
      });
      return row;
    },

    async updateRow(invoiceId: string, rowId: string, input: UpdateInvoiceRowInput, userId?: string | null) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new InvoiceNotFoundError(invoiceId);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot change rows on an invoice in status "${invoice.status}"`);
      }
      const existing = await repo.findRow(invoiceId, rowId);
      if (!existing) throw new InvoiceRowNotFoundError(rowId);
      // Merge the patch onto the current row, then re-validate + recompute.
      const merged: RowInput = {
        articleId: input.articleId !== undefined ? input.articleId : existing.articleId,
        salesOrderRowId: input.salesOrderRowId !== undefined ? input.salesOrderRowId : existing.salesOrderRowId,
        // Frakt etapp 2: the PATCH schema omits shipmentId — the link is
        // kept as is, and re-resolving with it keeps the freight rules
        // (article, quantity 1, no order link) in force on every edit.
        shipmentId: existing.shipmentId,
        description: input.description ?? existing.description,
        quantity: input.quantity ?? Number(existing.quantity),
        unitPrice: input.unitPrice ?? Number(existing.unitPrice),
        discountPercent: input.discountPercent !== undefined ? input.discountPercent : Number(existing.discountPercent),
        vatRate: input.vatRate !== undefined ? input.vatRate : Number(existing.vatRate),
      };
      const row = await repo.updateRow(
        invoiceId,
        rowId,
        await resolveRow(
          invoice.customerId,
          merged,
          { salesOrderRowId: existing.salesOrderRowId, quantity: Number(existing.quantity), shipmentId: existing.shipmentId },
          undefined,
          invoice.type
        )
      );
      if (!row) throw new InvoiceRowNotFoundError(rowId);
      await audit.log({
        entityType: "invoice",
        entityId: invoice.invoiceNumber ?? invoice.id,
        action: "row_updated",
        detail: {
          // The row's (possibly new, post-update) article — updateRow is the
          // one row mutation that CAN swap the article, unlike the sales/
          // purchase order row equivalents.
          articleNumber: await articleNumberFor(row.articleId),
          before: {
            description: existing.description,
            quantity: existing.quantity,
            unitPrice: existing.unitPrice,
            discountPercent: existing.discountPercent,
          },
          after: {
            description: row.description,
            quantity: row.quantity,
            unitPrice: row.unitPrice,
            discountPercent: row.discountPercent,
          },
        },
        userId: userId ?? null,
      });
      return row;
    },

    async deleteRow(invoiceId: string, rowId: string, userId?: string | null) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new InvoiceNotFoundError(invoiceId);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot change rows on an invoice in status "${invoice.status}"`);
      }
      const existing = await repo.findRow(invoiceId, rowId);
      const row = await repo.deleteRow(invoiceId, rowId);
      if (!row) throw new InvoiceRowNotFoundError(rowId);
      await audit.log({
        entityType: "invoice",
        entityId: invoice.invoiceNumber ?? invoice.id,
        action: "row_deleted",
        detail: existing
          ? {
              articleNumber: await articleNumberFor(existing.articleId),
              description: existing.description,
              quantity: existing.quantity,
              unitPrice: existing.unitPrice,
            }
          : null,
        userId: userId ?? null,
      });
    },

    // Draft candidates for the "create from delivered order(s)" prefill.
    async listInvoiceableOrders(customerId: string) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      return repo.listInvoiceableOrders(customerId);
    },

    // Frakt etapp 2: the customer's booked, unbilled shipments for the
    // dialog's Frakt group — each with the freight article (and its VAT
    // rate) the row will carry and the default row text.
    async listInvoiceableShipments(customerId: string) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      const freightArticleId = await freight.freightArticleId();
      if (!freightArticleId) return [];
      const [article, vatRate, rows] = await Promise.all([
        articleReader.getArticle(freightArticleId),
        repo.findArticleVatRate(freightArticleId),
        repo.listInvoiceableShipments(customerId, freightArticleId),
      ]);
      return rows.map((r) => ({
        ...r,
        articleId: freightArticleId,
        articleNumber: article?.articleNumber ?? "",
        articleName: article?.name ?? "",
        vatRate: String(vatRate ?? DEFAULT_VAT_RATE),
        description: freightRowDescription(r),
      }));
    },

    // Samlingsfakturering: flagged customers with something left to bill
    // (order rows and, Frakt etapp 2, unbilled shipments).
    async listCollectiveInvoicingCandidates() {
      return repo.listCollectiveInvoicingCandidates(await freight.freightArticleId());
    },

    // Samlingsfakturering: ONE invoice per selected customer covering every
    // delivered-but-uninvoiced order row (the same rows/quantities the
    // create dialog prefills from listInvoiceableOrders), optionally issued
    // right away. Customers are processed sequentially and independently —
    // create() and issue() are each their own transaction, so one customer's
    // failure (posting error, race) is reported on its own row and never
    // rolls back or stops the others.
    async runCollectiveInvoicing(input: RunCollectiveInvoicingInput, userId: string) {
      const results: CollectiveInvoicingResult[] = [];
      // One settings read for the whole run — the freight article does not
      // change per customer.
      const freightArticleId = await freight.freightArticleId();
      for (const customerId of input.customerIds) {
        const result: CollectiveInvoicingResult = {
          customerId,
          customerNumber: null,
          name: null,
          invoiceId: null,
          invoiceNumber: null,
          status: "failed",
          rowCount: 0,
          error: null,
        };
        try {
          const customer = await repo.findCustomerById(customerId);
          if (!customer) throw new CustomerNotFoundError(customerId);
          result.customerNumber = customer.customerNumber;
          result.name = customer.name;
          if (!customer.collectiveInvoicing) {
            throw new Error(`Customer ${customer.customerNumber} is not flagged for collective invoicing`);
          }
          const orders = await repo.listInvoiceableOrders(customerId);
          const rows: CreateInvoiceInput["rows"] = orders.flatMap((order) =>
            order.rows.map((r) => ({
              articleId: r.articleId,
              salesOrderRowId: r.salesOrderRowId,
              description: r.articleName,
              // Base-unit quantity/price, exactly what resolveRow stores.
              // vatRate is left out: resolveRow then takes the article's
              // current rate, which is what listInvoiceableOrders reports.
              quantity: r.rest,
              unitPrice: Number(r.unitPrice),
              discountPercent: Number(r.discountPercent),
            }))
          );
          // Frakt etapp 2: the customer's unbilled shipments AFTER the order
          // rows — one row each, customer price, the freight article. A
          // customer with only freight left is billed too.
          if (freightArticleId) {
            for (const s of await repo.listInvoiceableShipments(customerId, freightArticleId)) {
              rows.push({
                articleId: freightArticleId,
                shipmentId: s.shipmentId,
                description: freightRowDescription(s),
                quantity: 1,
                unitPrice: Number(s.customerPrice),
                discountPercent: 0,
              });
            }
          }
          if (rows.length === 0) {
            result.status = "skipped";
            results.push(result);
            continue;
          }
          const invoice = await service.create({ customerId, rows }, userId, { collective: true });
          result.invoiceId = invoice!.id;
          result.rowCount = rows.length;
          result.status = "draft";
          if (input.issue) {
            const issued = await service.issue(invoice!.id, userId);
            result.invoiceNumber = issued!.invoiceNumber;
            result.status = "issued";
          }
        } catch (err) {
          result.error = err instanceof Error ? err.message : String(err);
        }
        results.push(result);
      }
      return { results };
    },

    // draft -> issued: allocates the FA number + OCR, freezes the customer/
    // payment-term snapshot, books the F verification (automatkontering) and
    // recomputes any linked sales order's status — all inside the same repo
    // transaction. userId owns the verification it books.
    async issue(id: string, userId: string) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new InvoiceNotFoundError(id);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot issue an invoice in status "${invoice.status}"`);
      }
      const rows = await repo.listRows(id);
      if (rows.length === 0) throw new EmptyInvoiceError(id);

      const customer = await repo.findCustomerById(invoice.customerId);
      if (!customer) throw new CustomerNotFoundError(invoice.customerId);

      // The invoice's own payment term wins; falls back to the customer's.
      const paymentTermId = invoice.paymentTermId ?? customer.paymentTermId;
      const paymentTerm = paymentTermId ? await repo.findPaymentTermById(paymentTermId) : null;

      const now = new Date();
      // Invoice address with fallback to the visiting address — same rule as
      // renderInvoicePdf in sales.service.ts.
      const useInvoiceAddress = Boolean(customer.invoiceAddress);
      const stamp: IssueStamp = {
        invoiceDate: now.toLocaleDateString("sv-SE"),
        dueDate: computeDueDate(now, paymentTerm?.code ?? null),
        // Fakturanamn (c/o, holding company) replaces the customer name on
        // the invoice when the customer has a separate invoice address.
        customerName: (useInvoiceAddress && customer.invoiceName) || customer.name,
        customerNumber: customer.customerNumber,
        invoiceAddress: useInvoiceAddress ? customer.invoiceAddress : customer.address,
        invoicePostalCode: useInvoiceAddress ? customer.invoicePostalCode : customer.postalCode,
        invoiceCity: useInvoiceAddress ? customer.invoiceCity : customer.city,
        invoiceCountry: useInvoiceAddress ? (customer.invoiceCountry ?? customer.country) : customer.country,
        orgNumber: customer.orgNumber,
        vatNumber: customer.vatNumber,
        privatePerson: customer.privatePerson,
        paymentTermCode: paymentTerm?.code ?? null,
        paymentTermName: paymentTerm?.name ?? null,
      };

      // A posting failure (locked period, missing account, unknown VAT rate)
      // propagates out of the repository untouched and is mapped to 409 by
      // the routes — the whole transition rolls back with it, FA number
      // included.
      const result = await repo.issueInvoice(id, stamp, invoice.type, userId, poster);
      // ok:false covers two distinct rejections from inside the transaction:
      // "race" is the same lost-the-race report every other conditional repo
      // update in this service gives (a concurrent call already moved this
      // invoice out of "draft" between this method's own status check above
      // and the repo's transaction); "over_invoicing"/"over_crediting" is the
      // re-validation at the actual commitment point catching what the
      // create-time guard's includeDrafts:true snapshot could not — e.g. a
      // draft credit that temporarily "freed" quantity for a second draft
      // invoice, then got cancelled instead of issued (see
      // validateCommittedQuantities in the repository).
      if (!result.ok) {
        if (result.reason === "over_invoicing") throw new OverInvoicingError();
        if (result.reason === "over_crediting") throw new OverCreditError();
        throw new InvalidStatusTransitionError(`Cannot issue invoice ${id}: it is no longer a draft`);
      }
      await audit.log({
        entityType: "invoice",
        entityId: result.invoice.invoiceNumber ?? result.invoice.id,
        action: "issued",
        detail: { type: invoice.type },
        userId,
      });
      // Archive the PDF as issued. Outside the issue transaction (rendering
      // reads committed data); if it fails here, the first print/email
      // archives instead — the issue itself has already happened.
      try {
        const issued = await repo.findRawById(result.invoice.id);
        if (issued) await archivedInvoicePdf(issued);
      } catch {
        // Deliberately not fatal — see above.
      }
      return service.getInvoice(result.invoice.id);
    },

    // issued -> paid has NO invoice-side entry point (B3): it is a
    // consequence of a registered payment settling the whole open amount, and
    // it happens inside that payment's own transaction (payment.repository.ts)
    // together with the K verification. Cancelling the payment reopens the
    // invoice the same way. The old manual markPaid — which could mark an
    // invoice paid without a krona being accounted for — is gone.

    // draft -> cancelled only — corrections after issue go through a credit
    // note instead.
    async cancel(id: string, userId?: string | null) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new InvoiceNotFoundError(id);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot cancel an invoice in status "${invoice.status}"`);
      }
      const cancelled = await repo.cancelInvoice(id);
      // null means a concurrent issue() already moved this invoice out of
      // "draft" between the check above and the repo's conditional UPDATE —
      // without it, a burned FA number could end up on a "cancelled" invoice.
      if (!cancelled) throw new InvalidStatusTransitionError(`Cannot cancel invoice ${id}: it is no longer a draft`);
      // Always a draft here (invoiceNumber is only assigned at issue), so
      // this falls back to the uuid — the "annars uuid" branch of the
      // entityId convention.
      await audit.log({
        entityType: "invoice",
        entityId: cancelled.invoiceNumber ?? cancelled.id,
        action: "cancelled",
        userId: userId ?? null,
      });
      return service.getInvoice(cancelled.id);
    },

    // The invoice PDF exists once the invoice is issued (FA number
    // assigned) — reprints of a paid invoice render the same content.
    async renderPdf(id: string) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new InvoiceNotFoundError(id);
      if (invoice.status !== "issued" && invoice.status !== "paid") {
        throw new InvalidStatusTransitionError(`Cannot print an invoice in status "${invoice.status}"`);
      }
      return archivedInvoicePdf(invoice);
    },

    // Mirrors sendSalesOrderEmail's pattern: load → guard issued/paid →
    // render → mail.sendMail. No status transition — unlike the quote/order
    // confirmation, sending an invoice email never changes its lifecycle.
    async sendEmail(id: string, input: SendInvoiceEmailInput) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new InvoiceNotFoundError(id);
      if (invoice.status !== "issued" && invoice.status !== "paid") {
        throw new InvalidStatusTransitionError(`Cannot email an invoice in status "${invoice.status}"`);
      }
      const attachment = await archivedInvoicePdf(invoice);
      await mail.sendMail({
        documentType: "invoice",
        documentId: invoice.id,
        to: input.to,
        subject: input.subject,
        message: input.message,
        attachments: [attachment],
      });
    },

    // Betalningspåminnelse (B3) — preview only: renders exactly what
    // sendReminder would attach, but persists and sends nothing. `withFee`
    // shows the fee the reminder WOULD charge; a fee that has already been
    // charged is not offered a second time (it is already in the open amount),
    // so the preview quietly drops it rather than 409:ing on a read.
    async renderReminderPdf(id: string, withFee: boolean) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new InvoiceNotFoundError(id);
      if (invoice.status !== "issued") {
        throw new InvalidStatusTransitionError(
          `Cannot send a payment reminder for an invoice in status "${invoice.status}"`
        );
      }
      const context = await reminderContext(invoice);
      if (context.open <= 0) throw new NothingToRemindError(id);
      const fee = withFee && context.chargedFee === 0 ? await repo.getReminderFee() : 0;
      return buildReminderPdf(invoice, context, context.reminders.length + 1, fee, new Date());
    },

    // Sends a påminnelse and, when asked, charges the statutory fee onto the
    // open item. The ORDER is the whole design:
    //
    //   1. guards (issued, something open, the fee not already charged, and —
    //      when charging — a configured fee amount AND a bookable posting:
    //      both accounts active, the reminder date in an open period), so
    //      nothing is refused after the customer has already been mailed.
    //      Every one of those is static configuration, not a race: leaving
    //      them to the transaction would mail the customer a reminder that can
    //      only fail, and the documented retry would mail them again,
    //   2. render the PDF, including the fee the customer is about to owe,
    //   3. SEND THE EMAIL FIRST. A reminder that was never delivered must not
    //      cost the customer 60 kr, and the mail service logs the failed
    //      attempt in email_log either way,
    //   4. ONE transaction: the invoice is row-locked and every guard re-run
    //      against the locked row (a payment may have closed it while the SMTP
    //      round trip was in flight), then the reminder row is inserted and the
    //      fee booked.
    //
    // RETRY SEMANTICS: if step 4 fails after step 3 succeeded, the customer
    // has the email but nothing is recorded — the caller sees the error and
    // may send again, which is the correct recovery (a duplicate mailing is
    // recoverable, a fee charged for an undelivered reminder is not). A
    // re-send can never double-charge: the second attempt's guard, and behind
    // it the partial unique index invoice_reminders_one_fee, allow exactly one
    // fee row per invoice.
    async sendReminder(id: string, input: SendReminderInput, userId: string) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new InvoiceNotFoundError(id);
      if (invoice.status !== "issued") {
        throw new InvalidStatusTransitionError(
          `Cannot send a payment reminder for an invoice in status "${invoice.status}"`
        );
      }
      const context = await reminderContext(invoice);
      if (context.open <= 0) throw new NothingToRemindError(id);
      if (input.withFee && context.chargedFee > 0) throw new ReminderFeeAlreadyChargedError(id);

      const fee = input.withFee ? await repo.getReminderFee() : 0;
      // The poster refuses a zero fee (rightly — it would be an empty
      // verification), but it would refuse it INSIDE the transaction, i.e.
      // after the email went out. Catch the misconfiguration here instead.
      if (input.withFee && fee <= 0) throw new ZeroAmountPostingError();

      const level = context.reminders.length + 1;
      const now = new Date();
      const reminderDate = now.toLocaleDateString("sv-SE");
      // ...and the rest of the posting's configuration preconditions, for
      // exactly the same reason. A FEE-FREE reminder books nothing, so it is
      // deliberately unaffected: sending one during a locked month, or with
      // the fee account retired, is perfectly legal.
      if (input.withFee) await repo.assertFeePostable(poster, reminderDate);
      const attachment = await buildReminderPdf(invoice, context, level, fee, now);

      await mail.sendMail({
        documentType: "payment_reminder",
        documentId: invoice.id,
        to: input.to,
        subject: input.subject,
        message: input.message,
        attachments: [attachment],
      });

      let result;
      try {
        result = await repo.createReminder(
          id,
          { level, fee, sentAt: now, reminderDate, document: attachment },
          userId,
          poster
        );
      } catch (err) {
        // The partial unique index fired: a fee row appeared between the
        // transaction's own check and its insert (only possible for a writer
        // that never took the invoice's row lock).
        if (isUniqueViolation(err)) throw new ReminderFeeAlreadyChargedError(id);
        throw err;
      }
      if (!result.ok) {
        switch (result.reason) {
          case "not_found":
            throw new InvoiceNotFoundError(id);
          case "not_issued":
            throw new InvalidStatusTransitionError(
              `Cannot send a payment reminder for invoice ${id}: it is no longer an issued invoice`
            );
          case "not_open":
            throw new NothingToRemindError(id);
          case "fee_already_charged":
            throw new ReminderFeeAlreadyChargedError(id);
        }
      }
      await audit.log({
        entityType: "invoice",
        entityId: invoice.invoiceNumber ?? invoice.id,
        action: "reminder_sent",
        detail: { level, fee },
        userId,
      });
      return (await service.getInvoice(id))!;
    },

    // A sent betalningspåminnelse exactly as emailed (archived with the
    // reminder row). Reminders sent before the archive existed have none.
    async reminderPdf(invoiceId: string, reminderId: string) {
      const document = await repo.findDocument(invoiceId, { kind: "reminder", reminderId });
      if (!document) throw new ArchivedReminderNotFoundError(reminderId);
      return { filename: document.filename, content: document.data };
    },
  };

  return service;
}

export type InvoiceService = ReturnType<typeof createInvoiceService>;
