import type { Db, Tx } from "@navet/db";
import { linkDeviationInTx } from "../../quality/repository/deviation-link-tx.js";
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
import {
  buyerVatNumberProblem,
  buyerVatNumberWarning,
  DEFAULT_VAT_RATE,
  fromSek,
  invoiceSekAmounts,
  SEK,
  domesticVatCodeForRate,
  isVatCode,
  isVatRate,
  round2,
  salesRowIsGoods,
  salesVatCode,
  toUnitPrice,
  toUnitQuantity,
  VAT_CODE_CATALOG,
  vatCodeEntry,
  type OrderRowConfiguration,
  type SalesVatCustomer,
} from "@navet/shared";
import { rowConfigurationLines } from "../../configurator/service/configuration-lines.js";
import type { InvoiceableShipment, InvoiceRepository, InvoiceRowWrite, IssueStamp } from "../repository/invoice.repository.js";
import type { DocumentPdfInput, DocumentSettingsReader, PaymentReminderPdfInput } from "../../mail/service/document-pdf.js";
import { extraDescriptionFor } from "../../mail/service/document-pdf.js";
import { ZeroAmountPostingError, type PostingVatCode } from "../../economy/service/verification-poster.js";
import {
  documentVatCode,
  InvalidVatCodeError,
  vatCodeRef,
  type DocumentVatCodeRow,
  type VatCodeBook,
} from "../../economy/service/document-vat-code.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { CustomerNotFoundError, InvalidStatusTransitionError } from "./sales.service.js";
// G1: append-only audit trail — optional with a no-op default (see
// sales.service.ts's identical comment) so the many pre-existing test call
// sites keep compiling; app.ts wires the real one.
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import {
  ExchangeRateUnavailableError,
  type ExchangeRateReader,
  type ReferenceRateReader,
} from "../../system/service/exchange-rates.js";
import { stockholmDateOf, stockholmToday } from "../../system/service/delivery-days.js";
import { dueDateFromTerm } from "../../system/service/due-date.js";
import {
  accruedInterestText,
  addDays as addCalendarDays,
  halfYearStartsBetween,
  LATE_INTEREST_TERMS_TEXT,
  lateInterest,
} from "./late-interest.js";

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
    // Valuta: the invoice's currency and the rate it is booked at (SEK per 1
    // unit; 1 for SEK) — the poster books everything in SEK.
    doc: { invoiceNumber: string; type: InvoiceType; invoiceDate: string; customerName: string; currency?: string; exchangeRate?: number },
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
  // Valuta: one invoice per customer and currency (null when nothing was
  // billed or the customer could not be read).
  currency: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: "draft" | "issued" | "skipped" | "failed";
  rowCount: number;
  error: string | null;
  // Faktura i vänteläge: Utfärda direkt was asked for but the customer's
  // invoices are reviewed first — the invoice stays a draft.
  onHold?: boolean;
};

// Valuta: an order row (or a shipment's order) in another currency than the
// invoice's — one invoice, one currency. 400 invoice-row-currency-mismatch.
export class InvoiceRowCurrencyMismatchError extends Error {
  constructor(
    public rowCurrency: string,
    public invoiceCurrency: string
  ) {
    super(`Raden är i ${rowCurrency} men fakturan är i ${invoiceCurrency} — en faktura har en valuta`);
    this.name = "InvoiceRowCurrencyMismatchError";
  }
}

// Valuta: a rate that does not fit the invoice — another rate than 1 on a
// SEK invoice, or a rate on a credit note (which takes its source invoice's).
// 400 invoice-exchange-rate with reason sek|credit.
export class InvoiceExchangeRateError extends Error {
  constructor(public reason: "sek" | "credit") {
    super(
      reason === "sek"
        ? "En faktura i SEK har alltid kursen 1"
        : "En kreditfaktura har alltid den krediterade fakturans kurs"
    );
    this.name = "InvoiceExchangeRateError";
  }
}

// Valuta: the påminnelseavgift is a Swedish statutory amount in kronor — it
// is charged on SEK invoices only. 409 reminder-fee-currency.
export class ReminderFeeCurrencyError extends Error {
  constructor(public currency: string) {
    super(`Påminnelseavgift kan bara tas ut på fakturor i SEK — fakturan är i ${currency}`);
    this.name = "ReminderFeeCurrencyError";
  }
}

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
// Dröjsmålsränta (inkassokostnadslagen 5 § andra stycket): a påminnelse-
// avgift is payable only to the extent it exceeds the förseningsersättning
// — once an active förseningsersättning is charged on the invoice, the
// reminder goes without a fee. 409 reminder-fee-after-late-fee.
export class ReminderFeeAfterLateFeeError extends Error {
  constructor(public invoiceId: string) {
    super(`Invoice ${invoiceId} already carries a förseningsersättning — the reminder fee is covered by it`);
    this.name = "ReminderFeeAfterLateFeeError";
  }
}

export class ReminderFeeAlreadyChargedError extends Error {
  constructor(id: string) {
    super(`Invoice ${id} has already been charged a reminder fee`);
    this.name = "ReminderFeeAlreadyChargedError";
  }
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
  // Momskod: an explicit choice wins over vatRate (a bare rate = its
  // domestic code), which wins over the derivation (salesVatCode).
  vatCodeId?: string | null;
  // Leveransdatum: set (also null) ⇒ used verbatim; undefined ⇒ the linked
  // order row's last non-undone delivery day.
  deliveryDate?: string | null;
  // A credit note's copy of its source row: the code is kept even when it
  // has been deactivated since. Never client input.
  copiedFromSource?: boolean;
  // Konfigurator 4b: the row's configuration copy. Set ⇒ used verbatim (a
  // credit note copies its source row's); undefined ⇒ the linked order
  // row's. Never client input — the route schemas have no such field.
  configuration?: OrderRowConfiguration | null;
  // Kostnadsställen och projekt: the row's own choice (null = none);
  // undefined on a new row = the linked order's header, else the article
  // group's Kostnadsställe (förval); undefined on a PATCH = the row's.
  costCenterId?: string | null;
  projectId?: string | null;
  // A credit note's copy: the SOURCE row's objects. A value equal to the
  // source's is kept as it is (the same booking mirrored, never re-checked);
  // an override that differs is the user's choice and held to the rule.
  // Never client input.
  sourceDimensions?: { costCenterId: string | null; projectId: string | null };
  // Dröjsmålsränta: the row's own revenue account (räntefaktura rows); a
  // credit note copies it. undefined on a PATCH keeps the row's. Never
  // client input — the route schemas have no such field.
  revenueAccount?: string | null;
};

// What every row of one create/addRow/PATCH needs to know once: the
// customer's VAT facts, the company's momskoder and the freight article
// (goods for the derivation).
type RowContext = {
  customerId: string;
  customer: SalesVatCustomer;
  book: VatCodeBook;
  freightArticleId: string | null;
  // Valuta: the invoice's currency — a linked order row (or shipment order)
  // must be in it.
  currency: string;
};

// The row's own state, when this is a PATCH.
type ExistingRowState = {
  salesOrderRowId: string | null;
  quantity: number;
  shipmentId?: string | null;
  vatCodeId?: string;
  deliveryDate?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  revenueAccount?: string | null;
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
  freight: InvoiceFreightReader = { freightArticleId: async () => null },
  // Valuta: the invoice date's rate at Utfärda, and today's rate for a
  // freight row whose shipment has no order rate to take. Optional so the
  // fixtures that only invoice in SEK need not wire it; without it a foreign
  // invoice needs a rate typed in (else 409 exchange-rate-unavailable).
  rates: ExchangeRateReader | null = null,
  // Dröjsmålsränta: the referensräntor for the reminder PDF's "Upplupen
  // dröjsmålsränta" line (fetched from Riksbanken when missing, before any
  // transaction). Optional: without it the line is simply left out.
  referenceRates: ReferenceRateReader | null = null,
  // Extra benämning: whether the invoice is among the documents that print
  // it. Optional: without it no invoice prints the text.
  documentSettings: DocumentSettingsReader | null = null
) {
  // Valuta: the rate for a currency and day (SEK = 1), looked up BEFORE any
  // transaction — it may call Riksbanken.
  async function lookupRate(currency: string, date: string): Promise<number> {
    if (currency === SEK) return 1;
    if (!rates) throw new ExchangeRateUnavailableError(currency, date);
    return (await rates.getRate(currency, date)).rate;
  }

  // Valuta: a shipment's freight row in the currency of its order — the
  // kundpris (SEK) converted with that order's rate; a shipment without an
  // order rate takes today's rate for `fallbackCurrency` (the invoice's /
  // customer's). SEK is the kundpris itself.
  async function shipmentPrice(s: InvoiceableShipment, fallbackCurrency: string): Promise<{ currency: string; unitPrice: number }> {
    const currency = s.orderCurrency ?? fallbackCurrency;
    const sek = Number(s.customerPrice);
    if (currency === SEK) return { currency, unitPrice: sek };
    const rate =
      s.orderCurrency === currency && s.orderExchangeRate !== null
        ? Number(s.orderExchangeRate)
        : await lookupRate(currency, stockholmToday());
    return { currency, unitPrice: fromSek(sek, rate) };
  }

  // Valuta: the SEK figures of an invoice at its rate — the receivable, VAT
  // and net exactly as Utfärda books them (invoiceSekAmounts); null for a
  // foreign draft whose rate is decided at Utfärda.
  function sekPreview(invoice: { currency: string; exchangeRate: string | null }, rows: { lineAmount: string; vatAmount: string }[]) {
    const rate = invoice.currency === SEK ? 1 : invoice.exchangeRate === null ? null : Number(invoice.exchangeRate);
    if (rate === null) return null;
    const sek = invoiceSekAmounts({ rate, rows: rows.map((r) => ({ lineAmount: Number(r.lineAmount), vatAmount: Number(r.vatAmount) })) });
    return { grossAmount: sek.grossAmount, vatAmount: sek.vatAmount, netAmount: sek.netAmount };
  }
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
    const extraDescription = extraDescriptionFor(
      documentSettings ? await documentSettings.getSettings() : {},
      "invoice"
    );
    const customerArticleNumbers = await repo.customerArticleNumberMap(invoice.customerId, rows.map((r) => r.articleId));
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

    // Momskoder (spec 4.3): the invoice texts of the codes on the invoice,
    // once each, in catalog order — the company's own text per code.
    const textByCode = new Map(rows.map((r) => [r.vatCode.code, r.vatCode.invoiceText] as const));
    const vatTexts = VAT_CODE_CATALOG.flatMap((entry) => {
      const text = textByCode.get(entry.code)?.trim();
      return text ? [text] : [];
    });

    // Valuta (ML 17 kap. 29 §): an invoice in another currency also states
    // its VAT in SEK — the VAT the F verification booked (the restmetod's
    // toSek(Σ moms)) at the invoice's rate, signed like the PDF's amounts.
    // Nothing for SEK, for an invoice without VAT, or without a rate.
    const rate = invoice.currency !== SEK && invoice.exchangeRate !== null ? Number(invoice.exchangeRate) : null;
    const vatSek =
      rate === null ? 0 : invoiceSekAmounts({ rate, rows: rows.map((r) => ({ lineAmount: Number(r.lineAmount), vatAmount: Number(r.vatAmount) })) }).vatAmount;
    const vatInSek = rate !== null && vatSek !== 0 ? { amount: sign * vatSek, rate } : null;

    // Dröjsmålsränta (kontrakt, beslut 15): the terms text under the
    // payment terms when the routine is on and the customer has
    // Dröjsmålsränta — on an invoice, never a credit note or a räntefaktura.
    const lateInterestText = !isCredit && (await lateInterestTermsText(invoice)) ? LATE_INTEREST_TERMS_TEXT : null;

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
      // Valuta: the invoice's own currency.
      currency: invoice.currency,
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
        // Momskoder: the VAT summary groups per code (two 0 % codes are two
        // lines with their own names).
        vatCode: { code: r.vatCode.code, name: r.vatCode.name },
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
        // Leveransdatum (ML 17 kap. 24 § p. 7): printed next to the order
        // reference only when it differs from the invoice date.
        deliveredDate: r.deliveryDate && r.deliveryDate !== invoice.invoiceDate ? r.deliveryDate : null,
        // Konfigurator 4b: the row's own configuration copy, with the price
        // additions per the customer's Visa tilläggspriser as it is when the
        // PDF is built — i.e. at issue, since the PDF is archived right then
        // and every later print serves the archived bytes.
        configurationLines: rowConfigurationLines(r.configuration, customer?.showConfigurationPrices ?? false),
        extraDescription: extraDescription(r.articleExtraDescription),
        customerArticleNumber: r.articleId ? (customerArticleNumbers.get(r.articleId) ?? null) : null,
        setupForArticleNumber: r.setupForArticleNumber,
      })),
      showTotal: true,
      vat: { perRow: true },
      vatInSek,
      vatTexts,
      // Köparens momsregistreringsnummer — the issue snapshot.
      buyerVatNumber: invoice.vatNumber,
      // Snapshot: what the customer was at issue, not what they are now.
      pricesIncludeVat: invoice.privatePerson,
      dueDate,
      orderReference: creditReference,
      ourSupplierNumberAtCustomer: customer?.ourSupplierNumber ?? null,
      lateInterestText,
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

  // Whether the invoice's PDF/reminder carries the dröjsmålsränta terms
  // text: Debitera dröjsmålsränta is on, the customer has Dröjsmålsränta,
  // and the invoice is not itself a räntefaktura.
  async function lateInterestTermsText(invoice: RawInvoice): Promise<boolean> {
    // The routine only charges SEK invoices (listLateInterestSources), so a
    // foreign-currency invoice promises nothing it will not get.
    if (invoice.currency !== SEK) return false;
    const settings = await repo.getLateInterestSettings();
    if (!settings.lateInterestEnabled) return false;
    const customer = await repo.findCustomerById(invoice.customerId);
    if (!customer?.lateInterest) return false;
    return !(await repo.isLateInterestInvoice(invoice.id));
  }

  // "Upplupen dröjsmålsränta t.o.m. {i dag}: {belopp} kr" for the reminder
  // — information only, computed by the same lateInterest as the routine
  // (from the day after the due date, or after the last active charged
  // period, through today). Null when nothing applies, when the reference
  // rate is missing, or when the interest is 0. Reads referensräntor
  // before any transaction (Riksbanken may be called).
  async function accruedInterestLine(invoice: RawInvoice): Promise<string | null> {
    if (invoice.type !== "invoice" || invoice.currency !== SEK || !invoice.dueDate) return null;
    if (!(await lateInterestTermsText(invoice))) return null;
    const settings = await repo.getLateInterestSettings();
    const customer = await repo.findCustomerById(invoice.customerId);
    const today = stockholmToday();
    const charges = await repo.listLateInterestCharges(invoice.id);
    const lastCharged = charges
      .filter((charge) => charge.active && charge.toDate !== null)
      .map((charge) => charge.toDate!)
      .sort()
      .at(-1);
    // lateInterest starts the day after `dueDate`: hand it the last charged
    // day as the "due date" so the accrued period starts after it.
    const dueDate = lastCharged && lastCharged > invoice.dueDate ? lastCharged : invoice.dueDate;
    if (dueDate >= today) return null;
    const agreedRate = customer?.lateInterestRate === null || customer?.lateInterestRate === undefined ? null : Number(customer.lateInterestRate);
    const starts = agreedRate === null ? halfYearStartsBetween(addCalendarDays(dueDate, 1), today) : [];
    const rates = starts.length > 0 && referenceRates ? await referenceRates.ensureReferenceRates(starts) : new Map<string, number>();
    const rows = await repo.listRows(invoice.id);
    const principal = round2(rows.reduce((sum, row) => sum + Number(row.lineAmount) + Number(row.vatAmount), 0));
    const result = lateInterest({
      principal,
      dueDate,
      through: today,
      payments: await repo.listLateInterestPayments(invoice.id),
      rates: [...rates].map(([validFrom, rate]) => ({ validFrom, rate })),
      margin: settings.lateInterestMargin,
      agreedRate,
    });
    if (result.amount === null || result.amount <= 0) return null;
    return accruedInterestText(today, result.amount);
  }

  // Dröjsmålsränta: an active förseningsersättning on the invoice.
  async function hasActiveLateFee(invoiceId: string): Promise<boolean> {
    return (await repo.listLateInterestCharges(invoiceId)).some((charge) => charge.active && charge.fee > 0);
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
    // Dröjsmålsränta: the terms text and the accrued interest (information,
    // never charged by the reminder).
    const lateInterestText = (await lateInterestTermsText(invoice)) ? LATE_INTEREST_TERMS_TEXT : null;
    const accruedInterest = lateInterestText ? await accruedInterestLine(invoice) : null;
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
      // Valuta: the reminder is written in the invoice's currency.
      currency: invoice.currency,
      grossAmount: context.gross,
      settledAmount: context.settled,
      feeAmount: round2(context.chargedFee + newFee),
      amountDue: round2(context.open + newFee),
      payment: { ocrNumber: invoice.ocrNumber, dueDate },
      lateInterestText,
      accruedInterestText: accruedInterest,
    });
    return { filename: `Betalningspåminnelse-${invoice.invoiceNumber}.pdf`, content };
  }

  // currency: the invoice's (undefined = the customer's — the readers that
  // only derive momskoder).
  async function rowContext(customerId: string, currency?: string): Promise<RowContext> {
    const [customer, book, freightArticleId] = await Promise.all([
      repo.findCustomerById(customerId),
      repo.vatCodeBook(),
      freight.freightArticleId(),
    ]);
    if (!customer) throw new CustomerNotFoundError(customerId);
    return { customerId, customer, book, freightArticleId, currency: currency ?? customer.currency };
  }

  // The derived momskod of a row (spec 4.1): the customer's facts, goods or
  // service, and the article's own rate — a free row is goods at 25 %.
  async function derivedVatCode(ctx: RowContext, articleId: string | null): Promise<DocumentVatCodeRow> {
    const article = articleId ? await repo.findArticleForVat(articleId) : null;
    const code = salesVatCode({
      customer: ctx.customer,
      isGoods: salesRowIsGoods({ articleId, articleType: article?.type ?? null, freightArticleId: ctx.freightArticleId }),
      articleRate: article?.vatRate ?? DEFAULT_VAT_RATE,
    });
    return documentVatCode(ctx.book, { code }, "sales");
  }

  // The row's momskod: explicit id → a bare rate's domestic code → the code
  // the row already carries (PATCH) → the derivation.
  async function resolveVatCode(
    ctx: RowContext,
    input: RowInput,
    articleId: string | null,
    existingRow?: ExistingRowState
  ): Promise<DocumentVatCodeRow> {
    if (input.vatCodeId) {
      const kept = input.copiedFromSource === true || existingRow?.vatCodeId === input.vatCodeId;
      return documentVatCode(ctx.book, { id: input.vatCodeId }, "sales", { allowInactive: kept });
    }
    if (input.vatRate !== undefined && input.vatRate !== null) {
      if (!isVatRate(input.vatRate)) throw new InvalidVatCodeError("unknown", `rate ${input.vatRate}`, "sales");
      return documentVatCode(ctx.book, { code: domesticVatCodeForRate(input.vatRate) }, "sales");
    }
    if (existingRow?.vatCodeId) return documentVatCode(ctx.book, { id: existingRow.vatCodeId }, "sales", { allowInactive: true });
    return derivedVatCode(ctx, articleId);
  }

  // Validates the optional delfakturering link and computes the unit
  // snapshot, momskod, leveransdatum and line/vat amounts.
  async function resolveRow(
    ctx: RowContext,
    input: RowInput,
    // The row's own current state, when this is a PATCH — used to exclude
    // its own already-invoiced quantity from the over-invoicing/over-credit
    // guard below, and to keep its momskod/leveransdatum.
    existingRow?: ExistingRowState,
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
    const invoiceCustomerId = ctx.customerId;
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
      // Valuta: the freight of an order in another currency belongs on an
      // invoice in that currency.
      if (shipment.orderCurrency !== null && shipment.orderCurrency !== ctx.currency) {
        throw new InvoiceRowCurrencyMismatchError(shipment.orderCurrency, ctx.currency);
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
    // Kostnadsställen och projekt: the default for a new row without its own.
    let dimensionFallback: { costCenterId: string | null; projectId: string | null } | null = null;
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
      // Valuta: the row's price is in its order's currency.
      if (orderRow.currency !== ctx.currency) throw new InvoiceRowCurrencyMismatchError(orderRow.currency, ctx.currency);
      unitId = orderRow.unitId;
      unitFactor = orderRow.unitFactor !== null ? Number(orderRow.unitFactor) : null;
      quantityDelivered = Number(orderRow.quantityDelivered);
      if (input.configuration === undefined) configuration = (orderRow.configuration as OrderRowConfiguration | null) ?? null;
      dimensionFallback = { costCenterId: orderRow.orderCostCenterId, projectId: orderRow.orderProjectId };
    }
    // Per field, like the supplier side: the cost center is the order
    // header's, else the article group's Kostnadsställe (förval); the project
    // is the order header's only. A free row without an article has no default.
    if (articleId && (dimensionFallback === null || dimensionFallback.costCenterId === null)) {
      dimensionFallback = {
        costCenterId: await repo.findArticleGroupDefaultCostCenter(articleId),
        projectId: dimensionFallback?.projectId ?? null,
      };
    }
    // A credit note's copy keeps the source row's objects as they are (an
    // object closed since the source was issued stays — it is the same
    // booking mirrored) while an override that differs is a choice; a PATCH
    // keeps the row's own unless the field is sent.
    const dimensions = await repo.resolveDimensions(
      { costCenterId: input.costCenterId, projectId: input.projectId },
      {
        existing:
          input.sourceDimensions ??
          (existingRow ? { costCenterId: existingRow.costCenterId ?? null, projectId: existingRow.projectId ?? null } : null),
        fallback: dimensionFallback,
      }
    );

    // Momskod (spec 4.2): the VAT is computed on the code's rate, and
    // vat_rate keeps that rate as the row's snapshot.
    const vatCode = await resolveVatCode(ctx, input, articleId, existingRow);
    const vatRate = vatCodeEntry(vatCode.code).rate;

    // Leveransdatum (spec 4.4): explicit wins; a PATCH that keeps the order
    // link keeps the row's date; otherwise the order row's last delivery.
    let deliveryDate: string | null;
    if (input.deliveryDate !== undefined) deliveryDate = input.deliveryDate;
    else if (existingRow && existingRow.salesOrderRowId === salesOrderRowId) deliveryDate = existingRow.deliveryDate ?? null;
    else deliveryDate = salesOrderRowId ? await repo.latestDeliveryDate(salesOrderRowId) : null;

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
      vatCodeId: vatCode.id,
      lineAmount,
      vatAmount,
      deliveryDate,
      configuration,
      ...dimensions,
      revenueAccount: input.revenueAccount !== undefined ? input.revenueAccount : (existingRow?.revenueAccount ?? null),
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

  // The köparens momsregistreringsnummer a draft is checked against and
  // stamps at Utfärda: the customer's current one, except on a credit note,
  // which keeps the number of the invoice it credits (the supply it reverses
  // was made to that number). A credit note whose source is gone falls back
  // to the customer's.
  async function issueVatNumber(
    invoice: { type: InvoiceType; creditedInvoiceId: string | null },
    customer: { vatNumber: string | null }
  ): Promise<string | null> {
    if (invoice.type === "credit" && invoice.creditedInvoiceId) {
      const source = await repo.findRawById(invoice.creditedInvoiceId);
      if (source) return source.vatNumber;
    }
    return customer.vatNumber;
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
    //
    // Momskoder: each row carries vatCode { id, code, name, rate,
    // invoiceText }. buyerVatNumber is the köparens momsregistreringsnummer
    // the invoice shows — on a draft the number issuing would stamp (the
    // customer's current one; a credit note's source invoice's), the issue
    // snapshot afterwards — and vatNumberProblem (drafts only) is what
    // Utfärda would refuse, so the card can warn ahead of it.
    // vatNumberWarning (drafts only) is the non-blocking remark on an EU
    // sale whose number belongs to another member state than the
    // customer's country (buyerVatNumberWarning).
    async getInvoice(id: string) {
      const header = await repo.findById(id);
      if (!header) return null;
      const [rows, openAmount, openAmountSek, payments, reminders, creditedBy, lateInterestCharges, isLateInterestInvoice] =
        await Promise.all([
          repo.listRows(id),
          repo.getOpenAmount(id),
          repo.getOpenAmountSek(id),
          repo.listPaymentsForInvoice(id),
          repo.listRemindersForInvoice(id),
          repo.listCreditedBy(id),
          repo.listLateInterestCharges(id),
          repo.isLateInterestInvoice(id),
        ]);
      let buyerVatNumber = header.vatNumber;
      let vatNumberProblem: ReturnType<typeof buyerVatNumberProblem> = null;
      let vatNumberWarning: ReturnType<typeof buyerVatNumberWarning> = null;
      if (header.status === "draft") {
        const customer = await repo.findCustomerById(header.customerId);
        if (customer) {
          buyerVatNumber = await issueVatNumber(header, customer);
          const check = {
            codes: rows.flatMap((row) => (isVatCode(row.vatCode.code) ? [row.vatCode.code] : [])),
            vatNumber: buyerVatNumber,
            country: customer.country,
          };
          vatNumberProblem = buyerVatNumberProblem(check);
          vatNumberWarning = vatNumberProblem ? null : buyerVatNumberWarning(check);
        } else {
          buyerVatNumber = null;
        }
      }
      return {
        ...header,
        buyerVatNumber,
        vatNumberProblem,
        vatNumberWarning,
        rows: rows.map((row) => ({ ...row, vatCode: { ...vatCodeRef(row.vatCode), invoiceText: row.vatCode.invoiceText } })),
        openAmount,
        // Valuta: the SEK figures at the invoice's rate (null for a foreign
        // draft without a typed rate — decided at Utfärda), and the open
        // amount's booked SEK value (null until issued). Positive like the
        // rows; the sign is `type`.
        sekAmounts: sekPreview(header, rows),
        openAmountSek,
        payments,
        reminders,
        creditedBy,
        // Dröjsmålsränta: the charges made on this source invoice (period,
        // amounts, the räntefaktura, derived `active`) and whether the
        // invoice is itself a räntefaktura.
        lateInterestCharges: lateInterestCharges.map((charge) => ({
          id: charge.id,
          fromDate: charge.fromDate,
          toDate: charge.toDate,
          days: charge.days,
          amount: charge.amount,
          fee: charge.fee,
          chargeInvoiceId: charge.chargeInvoiceId,
          chargeInvoiceNumber: charge.chargeInvoiceNumber,
          active: charge.active,
        })),
        isLateInterestInvoice,
      };
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
      // Valuta: the caller's currency, else the first linked order row's (or
      // shipment order's), else the customer's — every linked row must then
      // be in it (resolveRow). A rate sent here is typed in on the draft.
      let currency = input.currency;
      if (currency === undefined) {
        const linked = input.rows.find((r) => r.salesOrderRowId);
        if (linked) currency = (await repo.findSalesOrderRowForInvoicing(linked.salesOrderRowId!))?.currency;
      }
      if (currency === undefined) {
        const freightRow = input.rows.find((r) => r.shipmentId);
        if (freightRow) currency = (await repo.findShipmentForInvoicing(freightRow.shipmentId!))?.orderCurrency ?? undefined;
      }
      currency ??= customer.currency;
      let exchangeRate: number | null = null;
      if (input.exchangeRate !== undefined) {
        if (currency === SEK) {
          if (input.exchangeRate !== 1) throw new InvoiceExchangeRateError("sek");
        } else {
          exchangeRate = input.exchangeRate;
        }
      }
      const ctx = await rowContext(input.customerId, currency);
      const batchAccumulated = new Map<string, number>();
      const rows: InvoiceRowWrite[] = [];
      for (const r of input.rows) {
        const resolved = await resolveRow(ctx, r, undefined, batchAccumulated);
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
            currency,
            exchangeRate,
            exchangeRateManual: exchangeRate !== null,
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
      // Momskoder: a credit row mirrors its source row's momskod and
      // leveransdatum (spec 4.2) — the prefill copies them, and an override
      // row takes them from its source row unless it says otherwise: the one
      // it names (sourceRowId — a free row has nothing else to match on),
      // else the one that billed the same order row.
      const sourceRows = await repo.listRows(invoiceId);
      let rowInputs: RowInput[];
      if (input.rows !== undefined) {
        rowInputs = input.rows.map(({ sourceRowId, ...r }) => {
          const source = sourceRowId
            ? sourceRows.find((row) => row.id === sourceRowId)
            : r.salesOrderRowId
              ? sourceRows.find((row) => row.salesOrderRowId === r.salesOrderRowId)
              : undefined;
          if (sourceRowId && !source) throw new InvoiceRowNotFoundError(sourceRowId);
          if (!source) return r;
          const explicitCode = r.vatCodeId !== undefined || (r.vatRate !== undefined && r.vatRate !== null);
          return {
            ...r,
            ...(explicitCode ? {} : { vatCodeId: source.vatCodeId, copiedFromSource: true }),
            ...(r.deliveryDate !== undefined ? {} : { deliveryDate: source.deliveryDate }),
            // Kostnadsställen och projekt: the source row's unless the
            // override says otherwise — a copied value is kept as it is, a
            // differing override is held to the rule (sourceDimensions).
            ...(r.costCenterId !== undefined ? {} : { costCenterId: source.costCenterId }),
            ...(r.projectId !== undefined ? {} : { projectId: source.projectId }),
            sourceDimensions: { costCenterId: source.costCenterId, projectId: source.projectId },
            // The credit nets the account the source row was booked on (a
            // räntefaktura's 8313) — never client input, so always copied.
            revenueAccount: source.revenueAccount,
          };
        });
      } else {
        rowInputs = sourceRows.map((r) => ({
          articleId: r.articleId,
          salesOrderRowId: r.salesOrderRowId,
          description: r.description,
          quantity: Number(r.quantity),
          unitPrice: Number(r.unitPrice),
          discountPercent: Number(r.discountPercent),
          vatCodeId: r.vatCodeId,
          deliveryDate: r.deliveryDate,
          copiedFromSource: true,
          // The credit copies the SOURCE row's configuration, not the order
          // row's (identical in practice — an invoiced row cannot be
          // reconfigured — but the credit mirrors the invoice it credits).
          configuration: r.configuration as OrderRowConfiguration | null,
          // …and its objects, so the credit nets the revenue per object.
          costCenterId: r.costCenterId,
          projectId: r.projectId,
          sourceDimensions: { costCenterId: r.costCenterId, projectId: r.projectId },
          // Dröjsmålsränta: a credit of a räntefaktura nets the same account.
          revenueAccount: r.revenueAccount,
        }));
      }

      // Same sequential-resolve + running-tally pattern as create() above,
      // but the tally SUBTRACTS: multiple credit rows in this one call
      // against the same salesOrderRowId must accumulate their combined
      // negative effect on net invoiced, not each be checked against the
      // same stale pre-insert read.
      // Valuta: the credit note is in the source invoice's currency and is
      // booked at the source invoice's rate (Skatteverket: a kreditnota is
      // converted with the original invoice's rate).
      const ctx = await rowContext(source.customerId, source.currency);
      const batchAccumulated = new Map<string, number>();
      const rows: InvoiceRowWrite[] = [];
      for (const r of rowInputs) {
        const resolved = await resolveRow(ctx, r, undefined, batchAccumulated, "credit");
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
          currency: source.currency,
          exchangeRate: source.exchangeRate === null ? null : Number(source.exchangeRate),
          exchangeRateManual: false,
        },
        rows,
        createdBy,
        // Avvikelser (Skapa kreditfaktura): the case link in the credit
        // note's own transaction.
        input.deviationId
          ? (tx, creditId) =>
              linkDeviationInTx(tx, { deviationId: input.deviationId!, documentType: "credit_invoice", documentId: creditId, userId: createdBy })
          : undefined
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
      const patch: { paymentTermId?: string | null; note?: string | null; exchangeRate?: number | null; exchangeRateManual?: boolean } = {};
      if (input.paymentTermId !== undefined) patch.paymentTermId = input.paymentTermId;
      if (input.note !== undefined) patch.note = input.note;
      // Valuta: a rate typed in on a foreign draft (null = automatic again —
      // the invoice date's rate at Utfärda). SEK takes only 1 (a no-op); a
      // credit note keeps its source invoice's rate.
      if (input.exchangeRate !== undefined) {
        if (invoice.type === "credit") throw new InvoiceExchangeRateError("credit");
        if (invoice.currency === SEK) {
          if (input.exchangeRate !== null && input.exchangeRate !== 1) throw new InvoiceExchangeRateError("sek");
        } else {
          patch.exchangeRate = input.exchangeRate;
          patch.exchangeRateManual = input.exchangeRate !== null;
        }
      }
      const updated = await repo.updateHeader(id, patch);
      // null means a concurrent issue() already froze this invoice between
      // the check above and the repo's own row-locked draft guard.
      if (!updated) throw new InvalidStatusTransitionError(`Cannot change invoice ${id}: it is no longer a draft`);
      await audit.log({
        entityType: "invoice",
        entityId: invoice.invoiceNumber ?? invoice.id,
        action: "updated",
        detail: {
          before: { paymentTermId: invoice.paymentTermId, note: invoice.note, exchangeRate: invoice.exchangeRate },
          after: { paymentTermId: updated.paymentTermId, note: updated.note, exchangeRate: updated.exchangeRate },
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
      const resolved = await resolveRow(await rowContext(invoice.customerId, invoice.currency), input, undefined, undefined, invoice.type);
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
        // Momskod: only an explicit vatCodeId or vatRate changes it — the
        // row otherwise keeps its own code (resolveRow's existingRow).
        vatRate: input.vatRate,
        vatCodeId: input.vatCodeId,
        // undefined keeps the row's date while the order link is unchanged.
        deliveryDate: input.deliveryDate,
        // Kostnadsställen och projekt: undefined keeps the row's, null clears.
        costCenterId: input.costCenterId,
        projectId: input.projectId,
      };
      const row = await repo.updateRow(
        invoiceId,
        rowId,
        await resolveRow(
          await rowContext(invoice.customerId, invoice.currency),
          merged,
          {
            salesOrderRowId: existing.salesOrderRowId,
            quantity: Number(existing.quantity),
            shipmentId: existing.shipmentId,
            vatCodeId: existing.vatCodeId,
            deliveryDate: existing.deliveryDate,
            costCenterId: existing.costCenterId,
            projectId: existing.projectId,
            revenueAccount: existing.revenueAccount,
          },
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
    // Momskoder: each row carries the code it would get (vatCodeId +
    // vatCode), the same derivation create() runs when the row is sent
    // without a code.
    async listInvoiceableOrders(customerId: string) {
      const ctx = await rowContext(customerId);
      const orders = await repo.listInvoiceableOrders(customerId);
      return orders.map((order) => ({
        ...order,
        rows: order.rows.map((r) => {
          const code = salesVatCode({
            customer: ctx.customer,
            isGoods: salesRowIsGoods({ articleId: r.articleId, articleType: r.articleType, freightArticleId: ctx.freightArticleId }),
            articleRate: Number(r.vatRate),
          });
          const vatCode = ctx.book.byCode.get(code);
          return { ...r, vatCodeId: vatCode?.id ?? null, vatCode: vatCode ? vatCodeRef(vatCode) : null };
        }),
      }));
    },

    // Frakt etapp 2: the customer's booked, unbilled shipments for the
    // dialog's Frakt group — each with the freight article (and its VAT
    // rate) the row will carry and the default row text.
    async listInvoiceableShipments(customerId: string) {
      const ctx = await rowContext(customerId);
      const freightArticleId = ctx.freightArticleId;
      if (!freightArticleId) return [];
      const [article, vatRate, rows] = await Promise.all([
        articleReader.getArticle(freightArticleId),
        repo.findArticleVatRate(freightArticleId),
        repo.listInvoiceableShipments(customerId, freightArticleId),
      ]);
      // Momskoder: freight follows the goods (salesRowIsGoods).
      const code = salesVatCode({ customer: ctx.customer, isGoods: true, articleRate: vatRate ?? DEFAULT_VAT_RATE });
      const vatCode = ctx.book.byCode.get(code);
      // Valuta: each shipment in its order's currency — customerPrice stays
      // the kundpris in SEK, unitPrice is what the row bills in `currency`.
      const out = [];
      for (const r of rows) {
        const { orderCurrency: _orderCurrency, orderExchangeRate: _orderExchangeRate, ...rest } = r;
        let priced: { currency: string; unitPrice: number | null };
        try {
          priced = await shipmentPrice(r, ctx.currency);
        } catch (err) {
          if (!(err instanceof ExchangeRateUnavailableError)) throw err;
          priced = { currency: r.orderCurrency ?? ctx.currency, unitPrice: null };
        }
        out.push({
          ...rest,
          currency: priced.currency,
          unitPrice: priced.unitPrice,
          articleId: freightArticleId,
          articleNumber: article?.articleNumber ?? "",
          articleName: article?.name ?? "",
          vatRate: String(vatRate ?? DEFAULT_VAT_RATE),
          vatCodeId: vatCode?.id ?? null,
          vatCode: vatCode ? vatCodeRef(vatCode) : null,
          description: freightRowDescription(r),
        });
      }
      return out;
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
        let customerOnHold = false;
        const base: CollectiveInvoicingResult = {
          customerId,
          customerNumber: null,
          name: null,
          currency: null,
          invoiceId: null,
          invoiceNumber: null,
          status: "failed",
          rowCount: 0,
          error: null,
        };
        // Valuta: one invoice per currency — the rows grouped on their
        // order's currency (shipments on theirs, priced in it). A failure
        // reading the customer is one result; each currency's invoice is
        // its own result, created (and issued) in its own transactions.
        const byCurrency = new Map<string, CreateInvoiceInput["rows"]>();
        try {
          const customer = await repo.findCustomerById(customerId);
          if (!customer) throw new CustomerNotFoundError(customerId);
          base.customerNumber = customer.customerNumber;
          base.name = customer.name;
          customerOnHold = customer.invoiceOnHold;
          if (!customer.collectiveInvoicing) {
            throw new Error(`Customer ${customer.customerNumber} is not flagged for collective invoicing`);
          }
          const add = (currency: string, row: CreateInvoiceInput["rows"][number]) => {
            const list = byCurrency.get(currency) ?? [];
            list.push(row);
            byCurrency.set(currency, list);
          };
          for (const order of await repo.listInvoiceableOrders(customerId)) {
            for (const r of order.rows) {
              add(order.currency, {
                articleId: r.articleId,
                salesOrderRowId: r.salesOrderRowId,
                description: r.articleName,
                // Base-unit quantity/price, exactly what resolveRow stores.
                // vatRate is left out: resolveRow then takes the article's
                // current rate, which is what listInvoiceableOrders reports.
                quantity: r.rest,
                unitPrice: Number(r.unitPrice),
                discountPercent: Number(r.discountPercent),
              });
            }
          }
          // Frakt etapp 2: the customer's unbilled shipments AFTER the order
          // rows — one row each, customer price, the freight article. A
          // customer with only freight left is billed too.
          if (freightArticleId) {
            for (const s of await repo.listInvoiceableShipments(customerId, freightArticleId)) {
              const priced = await shipmentPrice(s, customer.currency);
              add(priced.currency, {
                articleId: freightArticleId,
                shipmentId: s.shipmentId,
                description: freightRowDescription(s),
                quantity: 1,
                unitPrice: priced.unitPrice,
                discountPercent: 0,
              });
            }
          }
        } catch (err) {
          results.push({ ...base, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        if (byCurrency.size === 0) {
          results.push({ ...base, status: "skipped" });
          continue;
        }
        // SEK first, then the other currencies alphabetically.
        const currencies = [...byCurrency.keys()].sort((a, b) => (a === SEK ? -1 : b === SEK ? 1 : a.localeCompare(b)));
        for (const currency of currencies) {
          const rows = byCurrency.get(currency)!;
          const result: CollectiveInvoicingResult = { ...base, currency };
          try {
            const invoice = await service.create({ customerId, currency, rows }, userId, { collective: true });
            result.invoiceId = invoice!.id;
            result.rowCount = rows.length;
            result.status = "draft";
            if (input.issue && customerOnHold) {
              result.onHold = true;
            } else if (input.issue) {
              const issued = await service.issue(invoice!.id, userId);
              result.invoiceNumber = issued!.invoiceNumber;
              result.status = "issued";
            }
          } catch (err) {
            result.error = err instanceof Error ? err.message : String(err);
          }
          results.push(result);
        }
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

      // Köparens momsregistreringsnummer: a credit note carries (and is
      // checked against) the number of the invoice it credits — the supply
      // it reverses was made to that number, whatever the customer's is now.
      const buyerVatNumber = await issueVatNumber(invoice, customer);

      const now = new Date();
      // A Stockholm day, whatever the container's zone.
      const invoiceDate = stockholmDateOf(now);
      // Valuta: the rate the invoice is booked at, decided here — before the
      // transaction, since the lookup may call Riksbanken. SEK is 1; a rate
      // typed on the draft wins; a credit note keeps its source invoice's
      // rate; otherwise the invoice date's rate (ML 8 kap. 21 §), and none at
      // all is a 409 exchange-rate-unavailable (type the rate on the draft).
      let exchangeRate: number;
      if (invoice.currency === SEK) exchangeRate = 1;
      else if (invoice.exchangeRateManual && invoice.exchangeRate !== null) exchangeRate = Number(invoice.exchangeRate);
      else if (invoice.type === "credit") {
        const source = invoice.creditedInvoiceId ? await repo.findRawById(invoice.creditedInvoiceId) : null;
        const sourceRate = invoice.exchangeRate ?? source?.exchangeRate ?? null;
        exchangeRate = sourceRate !== null ? Number(sourceRate) : await lookupRate(invoice.currency, invoiceDate);
      } else exchangeRate = await lookupRate(invoice.currency, invoiceDate);
      // Invoice address with fallback to the visiting address — same rule as
      // renderInvoicePdf in sales.service.ts.
      const useInvoiceAddress = Boolean(customer.invoiceAddress);
      const stamp: IssueStamp = {
        exchangeRate,
        exchangeRateManual: invoice.exchangeRateManual,
        invoiceDate,
        dueDate: dueDateFromTerm(invoiceDate, paymentTerm?.code ?? null),
        // Fakturanamn (c/o, holding company) replaces the customer name on
        // the invoice when the customer has a separate invoice address.
        customerName: (useInvoiceAddress && customer.invoiceName) || customer.name,
        customerNumber: customer.customerNumber,
        invoiceAddress: useInvoiceAddress ? customer.invoiceAddress : customer.address,
        invoicePostalCode: useInvoiceAddress ? customer.invoicePostalCode : customer.postalCode,
        invoiceCity: useInvoiceAddress ? customer.invoiceCity : customer.city,
        invoiceCountry: useInvoiceAddress ? (customer.invoiceCountry ?? customer.country) : customer.country,
        orgNumber: customer.orgNumber,
        vatNumber: buyerVatNumber,
        privatePerson: customer.privatePerson,
        paymentTermCode: paymentTerm?.code ?? null,
        paymentTermName: paymentTerm?.name ?? null,
      };

      // A posting failure (locked period, missing account, unknown VAT rate)
      // propagates out of the repository untouched and is mapped to 409 by
      // the routes — the whole transition rolls back with it, FA number
      // included.
      // Momskoder: the rows' codes are checked against the number being
      // stamped and the customer's own country inside the transaction.
      const result = await repo.issueInvoice(id, stamp, invoice.type, userId, poster, {
        vatNumber: buyerVatNumber,
        country: customer.country,
      });
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
        detail: {
          type: invoice.type,
          ...(invoice.currency === SEK ? {} : { currency: invoice.currency, exchangeRate, grossAmountSek: result.invoice.grossAmountSek }),
        },
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
      // Valuta: no påminnelseavgift on an invoice in another currency.
      if (withFee && invoice.currency !== SEK) throw new ReminderFeeCurrencyError(invoice.currency);
      const context = await reminderContext(invoice);
      if (context.open <= 0) throw new NothingToRemindError(id);
      // Dröjsmålsränta: an active förseningsersättning covers the fee —
      // the preview drops it quietly, like an already charged fee.
      const fee = withFee && context.chargedFee === 0 && !(await hasActiveLateFee(invoice.id)) ? await repo.getReminderFee() : 0;
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
      // Valuta: the påminnelseavgift is a SEK amount by law — refused on an
      // invoice in another currency before anything is sent.
      if (input.withFee && invoice.currency !== SEK) throw new ReminderFeeCurrencyError(invoice.currency);
      const context = await reminderContext(invoice);
      if (context.open <= 0) throw new NothingToRemindError(id);
      if (input.withFee && context.chargedFee > 0) throw new ReminderFeeAlreadyChargedError(id);
      // Dröjsmålsränta (inkassokostnadslagen 5 §): the fee is covered by an
      // active förseningsersättning — refused before anything is sent.
      if (input.withFee && (await hasActiveLateFee(id))) throw new ReminderFeeAfterLateFeeError(id);

      const fee = input.withFee ? await repo.getReminderFee() : 0;
      // The poster refuses a zero fee (rightly — it would be an empty
      // verification), but it would refuse it INSIDE the transaction, i.e.
      // after the email went out. Catch the misconfiguration here instead.
      if (input.withFee && fee <= 0) throw new ZeroAmountPostingError();

      const level = context.reminders.length + 1;
      const now = new Date();
      const reminderDate = stockholmDateOf(now);
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
          case "late_fee_charged":
            throw new ReminderFeeAfterLateFeeError(id);
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
