import { createHash } from "node:crypto";
import type { Tx } from "@navet/db";
import {
  documentSekAmounts,
  isVatCode,
  reverseVatPreview,
  round2,
  SEK,
  type CreateSupplierInvoiceInput,
  type DocumentRateSource,
  type CreateSupplierInvoiceRowInput,
  type ListSupplierInvoicesQuery,
  type PaymentReferenceKind,
  type UpdatePaymentReferenceInput,
  type UpdateSupplierInvoiceHeaderInput,
  type UpdateSupplierInvoiceRowInput,
} from "@navet/shared";
import { supplierInvoiceWarnings } from "./supplier-invoice-warnings.js";
import {
  createSupplierInvoiceRepository,
  type SupplierInvoiceRepository,
  type SupplierInvoiceRowWrite,
} from "../repository/supplier-invoice.repository.js";
import { InvalidStatusTransitionError, SupplierNotFoundError } from "./purchase.service.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import type { PostingVatCode } from "../../economy/service/verification-poster.js";
import {
  documentVatCode,
  supplierVatCode,
  vatCodeRef,
  type VatCodeBook,
} from "../../economy/service/document-vat-code.js";
// G1: append-only audit trail — optional with a no-op default (see
// sales.service.ts's identical comment).
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { ExchangeRateUnavailableError, type ExchangeRateReader } from "../../system/service/exchange-rates.js";

// Automatkontering (B2): the slice of the economy module's VerificationPoster
// this module uses — declared here, at the consumer, like every other
// cross-module reader in purchase (ArticleFileReader, RegisterReferenceReader).
// Tx-composable by design: the posting happens inside the repository's own
// status-flip transaction, so the verification and the status change either
// both commit or both roll back.
export interface SupplierInvoicePoster {
  postSupplierInvoice(
    tx: Tx,
    // The header amounts are authoritative (typed in from the paper invoice);
    // net + VAT must equal gross or the poster refuses.
    doc: {
      registrationNumber: string;
      invoiceNumber: string;
      supplierName: string;
      invoiceDate: string;
      currency: string;
      // Valuta: SEK per 1 unit of the currency (1 for SEK).
      exchangeRate: number;
      netAmount: number;
      vatAmount: number;
      grossAmount: number;
      // The header's momskod (accounts included), loaded in the same tx.
      vatCode: PostingVatCode;
      // Kostnadsställen och projekt: the header's = the rows' default and
      // the remainder's.
      costCenterId?: string | null;
      projectId?: string | null;
    },
    // Rows only steer WHICH cost accounts the header net is split over, under
    // which momskod (null = the header's) and with which objects (null = the
    // header's).
    rows: { articleGroupId: string | null; lineAmount: number; vatCode: PostingVatCode | null; costCenterId?: string | null; projectId?: string | null }[],
    userId: string
  ): Promise<{ verificationId: string; displayNumber: string }>;

  // Books the mirrored omföring of an already-booked verification. Reports
  // `alreadyReversed` instead of duplicating when the source already has a
  // BOOKED reversal (e.g. a manual Omför that was booked) — that correction
  // already stands in the books, so the caller's own transition should still
  // go through. An unbooked omföring draft does NOT count: it rejects the
  // whole transition (23505 → VerificationAlreadyReversedError below).
  reverseBookedVerification(
    tx: Tx,
    sourceVerificationId: string,
    opts: { date: string; description: string },
    userId: string
  ): Promise<{ verificationId: string } | { alreadyReversed: true }>;
}

export class SupplierInvoiceNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier invoice ${id} not found`);
    this.name = "SupplierInvoiceNotFoundError";
  }
}

export class SupplierInvoiceRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier invoice row ${id} not found`);
    this.name = "SupplierInvoiceRowNotFoundError";
  }
}

export class DuplicateSupplierInvoiceNumberError extends Error {
  constructor(invoiceNumber: string) {
    super(`An invoice with number "${invoiceNumber}" already exists for this supplier`);
    this.name = "DuplicateSupplierInvoiceNumberError";
  }
}

// A matched row must line up with the purchase order it points at.
export class PoMatchMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoMatchMismatchError";
  }
}

// Automatkontering (B2): the partial unique index
// verifications_reverses_unique rejected the cancellation's own omföring
// because the invoice's verification already had one. Two ways to get here:
//   * a manual Omför committed while the cancellation was being written —
//     retrying succeeds, since the poster then sees the booked reversal and
//     skips the posting.
//   * a manual Omför exists but is still an UNBOOKED draft — no correction
//     is in the books yet, so the cancellation stays refused until that
//     draft is booked (or deleted) under Ekonomi → Verifikat.
// Mapped to 409 by the routes, same as economy.service's own
// AlreadyReversedError (not reused here: importing it would drag the whole
// economy service into the purchase module).
export class VerificationAlreadyReversedError extends Error {
  constructor() {
    super(
      "The invoice's verification already has an omföring — if it is still a draft, book or delete it, then try cancelling again"
    );
    this.name = "VerificationAlreadyReversedError";
  }
}

// Leverantörsreskontra (B4): an approved invoice with money already
// registered against it must not be makulerad — the payment rows would be
// left pointing at a cancelled invoice while their U verification stays in
// the books. Mapped to 409 by the routes.
export class SupplierInvoiceHasPaymentsError extends Error {
  constructor() {
    super("The invoice has registered payments — cancel them first");
    this.name = "SupplierInvoiceHasPaymentsError";
  }
}

// Bankfiler: the invoice is reserved in a live payment batch; remove it from
// the draft or mark the payment rejected first. Mapped to 409 by the routes.
export class SupplierInvoiceInPaymentBatchError extends Error {
  constructor(public batchNumber: string) {
    super(`The supplier invoice is in payment batch ${batchNumber} — remove it from the batch or mark the payment rejected first`);
    this.name = "SupplierInvoiceInPaymentBatchError";
  }
}

// Valuta: a rate other than 1 on a SEK invoice. 400.
export class SupplierInvoiceExchangeRateError extends Error {
  constructor() {
    super("A supplier invoice in SEK always has exchange rate 1");
    this.name = "SupplierInvoiceExchangeRateError";
  }
}

// Valuta: a foreign-currency invoice without a rate (saved before rates
// existed and never given one) cannot be attested. 409.
export class SupplierInvoiceExchangeRateMissingError extends Error {
  constructor(public currency: string) {
    super(`The supplier invoice in ${currency} has no exchange rate — enter the rate before attesting it`);
    this.name = "SupplierInvoiceExchangeRateMissingError";
  }
}

type ResolvedRate = { exchangeRate: number; exchangeRateSource: DocumentRateSource | null; exchangeRateDate: string | null };

// What prepareCreate resolves before the create's transaction.
export interface PreparedSupplierInvoice {
  supplier: NonNullable<Awaited<ReturnType<SupplierInvoiceRepository["findSupplierById"]>>>;
  rate: ResolvedRate;
}

const SEK_RATE: ResolvedRate = { exchangeRate: 1, exchangeRateSource: null, exchangeRateDate: null };

// Underlag (the supplier's invoice as a file): same formats and size cap as
// the article drawings — PDF and scans.
export const SUPPLIER_INVOICE_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const MAX_SUPPLIER_INVOICE_FILE_BYTES = 20 * 1024 * 1024;

export class SupplierInvoiceFileNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier invoice file ${id} not found`);
    this.name = "SupplierInvoiceFileNotFoundError";
  }
}

export class InvalidSupplierInvoiceFileTypeError extends Error {
  constructor(contentType: string) {
    super(`Filtypen ${contentType} stöds inte — ladda upp PDF, JPEG eller PNG`);
    this.name = "InvalidSupplierInvoiceFileTypeError";
  }
}

// An attested or cancelled invoice's underlag is räkenskapsinformation
// (bokföringslagen 7 kap: kept 7 år) — it can be added to, never removed.
// Mapped to 409 by the routes.
export class SupplierInvoiceFileLockedError extends Error {
  constructor() {
    super("Underlaget kan bara tas bort medan fakturan är ett utkast — efter attest är det räkenskapsinformation");
    this.name = "SupplierInvoiceFileLockedError";
  }
}

// Fakturaskanning: the underlag the Fakturainkorg created the invoice from
// is the received invoice itself — the scan keeps pointing at it. 409.
export class SupplierInvoiceFileFromScanError extends Error {
  constructor(public scanNumber: string) {
    super(`Underlaget kom från fakturainkorgen (${scanNumber}) och kan inte tas bort — det är den mottagna fakturan`);
    this.name = "SupplierInvoiceFileFromScanError";
  }
}

// dueDate: invoiceDate + parseInt(paymentTermCode) days when the code is a
// finite number of days ("30" -> 30 dagar netto), else null (a code like
// "KONTANT" carries no computed due date) — the same parse as sales'
// computeDueDate (invoice.service.ts:170-174). The two differ in what they
// count FROM, on purpose: AR derives the due date from the issuing INSTANT it
// already holds (a Date), while AP has no such instant — the paper invoice's
// own date is typed in, so this variant starts from that string. It is split
// into local components and fed to the Date(y, m, d) constructor rather than
// parsed with new Date("2026-07-01"), which ISO-parses to UTC midnight and
// can land on the previous day once toLocaleDateString renders it in a
// negative-offset timezone.
// Exported for the alerts module (Leverantörsfakturor att betala), which
// derives the due date the same way for an invoice saved without one.
export function computeDueDate(invoiceDate: string, paymentTermCode: string | null): string | null {
  const termDays = Number.parseInt(paymentTermCode ?? "", 10);
  if (!Number.isFinite(termDays)) return null;
  const [y, m, d] = invoiceDate.split("-").map(Number);
  return new Date(y!, m! - 1, d! + termDays).toLocaleDateString("sv-SE");
}

// A row as the client may send it (create or the merged result of a PATCH).
type RowInput = {
  articleId?: string | null;
  purchaseOrderRowId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate?: number | null;
  // Momskod for the row; null/undefined = the invoice's own code.
  vatCodeId?: string | null;
  // Kostnadsställen och projekt: the row's own; null = follows the header,
  // undefined on a new row = the article group's Kostnadsställe (förval),
  // undefined on a PATCH = the row's.
  costCenterId?: string | null;
  projectId?: string | null;
};

export function createSupplierInvoiceService(
  repo: SupplierInvoiceRepository,
  poster: SupplierInvoicePoster,
  // G1: optional, defaults to a no-op — see sales.service.ts's identical comment.
  audit: AuditWriter = { log: async () => {} },
  // Valuta: the rate lookup (Riksbanken / Valutakurser). Optional so the
  // fixtures that never create a foreign invoice need not wire it; without
  // it a foreign invoice takes its explicit rate or the purchase order's.
  rates: ExchangeRateReader | null = null
) {
  // The invoice's rate: SEK is always 1 (an explicit other rate is a 400); a
  // rate typed in wins (source manual); else the lookup for the invoice date
  // (riksbank / register) and, when there is none, the linked purchase
  // order's rate if the order is in the same currency. Nothing at all ⇒ the
  // lookup's ExchangeRateUnavailableError (409, "ange kursen själv").
  async function resolveRate(
    currency: string,
    invoiceDate: string,
    explicit: number | undefined,
    purchaseOrderId: string | null
  ): Promise<ResolvedRate> {
    if (currency === SEK) {
      if (explicit !== undefined && explicit !== 1) throw new SupplierInvoiceExchangeRateError();
      return SEK_RATE;
    }
    if (explicit !== undefined) return { exchangeRate: explicit, exchangeRateSource: "manual", exchangeRateDate: null };
    let unavailable: ExchangeRateUnavailableError = new ExchangeRateUnavailableError(currency, invoiceDate);
    if (rates) {
      try {
        const found = await rates.getRate(currency, invoiceDate);
        return {
          exchangeRate: found.rate,
          exchangeRateSource: found.source === "manual" ? "register" : "riksbank",
          exchangeRateDate: found.date,
        };
      } catch (err) {
        if (!(err instanceof ExchangeRateUnavailableError)) throw err;
        unavailable = err;
      }
    }
    if (purchaseOrderId) {
      const order = await repo.findPurchaseOrderRate(purchaseOrderId);
      if (order && order.currency === currency && order.exchangeRate > 0 && order.exchangeRate !== 1) {
        return { exchangeRate: order.exchangeRate, exchangeRateSource: "purchase_order", exchangeRateDate: null };
      }
    }
    throw unavailable;
  }

  // Validates the optional PO-match and computes the line/vat amounts so the
  // stored numbers always equal quantity × unitPrice. A row's own momskod
  // must be a purchase code (both/purchase) and active — unless it is the
  // code the row already carries (`keepVatCodeId`, a PATCH leaving it alone).
  async function resolveRow(
    r: SupplierInvoiceRepository,
    input: RowInput,
    book: VatCodeBook,
    keepVatCodeId?: string | null,
    // The row's current objects on a PATCH (undefined = a new row).
    existingDimensions?: { costCenterId: string | null; projectId: string | null }
  ): Promise<SupplierInvoiceRowWrite> {
    const vatCodeId = input.vatCodeId ?? null;
    if (vatCodeId !== null) {
      documentVatCode(book, { id: vatCodeId }, "purchase", { allowInactive: vatCodeId === keepVatCodeId });
    }
    const articleId = input.articleId ?? null;
    const purchaseOrderRowId = input.purchaseOrderRowId ?? null;
    // The PO's supplier is deliberately NOT compared with the invoice's: the
    // invoice may be paid to another supplier than the one the goods were
    // ordered from (a factoring company, a parent company), and the match
    // still reconciles price and quantity against the order. The article must
    // line up — that is what the variance is computed on.
    if (purchaseOrderRowId) {
      const poRow = await r.findPurchaseOrderRowForMatch(purchaseOrderRowId);
      if (!poRow) throw new PoMatchMismatchError("The matched purchase order row does not exist");
      if (articleId === null || poRow.articleId !== articleId) {
        throw new PoMatchMismatchError("The matched purchase order row is for a different article");
      }
    }
    const lineAmount = round2(input.quantity * input.unitPrice);
    const vatRate = input.vatRate ?? null;
    const vatAmount = vatRate !== null ? round2(lineAmount * (vatRate / 100)) : 0;
    // Kostnadsställen och projekt: a new row without its own takes the
    // article group's Kostnadsställe (förval); null stays null (= the header's).
    const dimensions = await r.resolveDimensions(
      { costCenterId: input.costCenterId, projectId: input.projectId },
      {
        existing: existingDimensions ?? null,
        fallback: existingDimensions || !articleId ? null : { costCenterId: await r.findArticleGroupDefaultCostCenter(articleId), projectId: null },
      }
    );
    return {
      articleId,
      purchaseOrderRowId,
      description: input.description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      lineAmount,
      vatAmount,
      vatRate,
      vatCodeId,
      ...dimensions,
    };
  }

  // Adds the computed price/quantity deviation to a matched row (null when
  // the row isn't matched to a PO row). Never stored — always derived.
  function withVariance(row: Awaited<ReturnType<SupplierInvoiceRepository["listRows"]>>[number]) {
    const matched = row.purchaseOrderRowId !== null;
    return {
      ...row,
      priceVariance:
        matched && row.poUnitPrice !== null ? round2(Number(row.unitPrice) - Number(row.poUnitPrice)) : null,
      quantityVariance:
        matched && row.poQuantityReceived !== null
          ? round2(Number(row.quantity) - Number(row.poQuantityReceived))
          : null,
    };
  }

  // The invoice's momskod: an explicit choice (active purchase code), else
  // the supplier's Momskod (förval), else the one derived from its country.
  function headerVatCodeId(
    book: VatCodeBook,
    supplier: { country: string; defaultVatCodeId: string | null },
    explicit: string | undefined
  ): string {
    if (explicit) return documentVatCode(book, { id: explicit }, "purchase").id;
    const effective = supplierVatCode(book, supplier);
    // Unreachable while vat_codes holds the whole catalog (migration 0142).
    if (!effective) throw new Error("No momskod found for the supplier");
    return documentVatCode(book, { id: effective.row.id }, "purchase").id;
  }

  const service = {
    async list(query: ListSupplierInvoicesQuery) {
      return repo.list(query);
    },

    // Joined header + rows (with computed variance) for the detail view, plus
    // the leverantörsreskontra (B4) slice: what is still open on the invoice
    // and which payments have touched it. The open amount is DERIVED
    // (open-amounts.ts is the single authority) — there is no stored balance
    // to read, and a draft simply reports its own gross as open.
    //
    // Momskoder: the header's vatCode { id, code, name, rate }, each row's
    // vatCode (null = follows the header) and reverseVat — the förhandsvisning
    // of the omvänd moms the attest will book (reverseVatPreview, the same
    // function the poster books with): [{ code, base, vat }] per reverse code.
    // warnings: string[] — supplierInvoiceWarnings (a domestic code with VAT
    // but no momsbelopp, a non-SEK supplier with land Sverige); never a
    // refusal.
    async getInvoice(id: string) {
      const header = await repo.findById(id);
      if (!header) return null;
      const [rawRows, openAmount, openAmountSek, payments, files, paymentBatches] = await Promise.all([
        repo.listRows(id),
        repo.getOpenAmount(id),
        repo.getOpenAmountSek(id),
        repo.listPaymentsForInvoice(id),
        repo.listFiles(id),
        repo.listPaymentBatchesForInvoice(id),
      ]);
      const { vatCodeCode, vatCodeName, supplierCountry, supplierCurrency, ...headerFields } = header;
      // Valuta: the header and rows in SEK at the invoice's rate — what the
      // attest books (documentSekAmounts, the poster's own restmetod). For a
      // SEK invoice the same figures as the document.
      const sek = documentSekAmounts({
        rate: Number(header.exchangeRate),
        grossAmount: Number(header.grossAmount),
        vatAmount: Number(header.vatAmount),
        rows: rawRows.map((row) => Number(row.lineAmount)),
      });
      const rows = rawRows.map((row) => {
        const { vatCodeCode: rowCode, vatCodeName: rowName, ...rowFields } = withVariance(row);
        return {
          ...rowFields,
          vatCode: row.vatCodeId && rowCode !== null && rowName !== null ? vatCodeRef({ id: row.vatCodeId, code: rowCode, name: rowName }) : null,
        };
      });
      // Omvänd moms on the SEK base, exactly as the poster books it.
      const reverseVat = isVatCode(vatCodeCode)
        ? reverseVatPreview({
            headerCode: vatCodeCode,
            netAmount: sek.netAmount,
            rows: rawRows.map((row, index) => ({
              code: row.vatCodeCode !== null && isVatCode(row.vatCodeCode) ? row.vatCodeCode : null,
              lineAmount: sek.rows[index]!,
            })),
          })
        : [];
      const warnings = isVatCode(vatCodeCode)
        ? supplierInvoiceWarnings({
            headerCode: vatCodeCode,
            netAmount: Number(header.netAmount),
            vatAmount: Number(header.vatAmount),
            rows: rawRows.map((row) => ({
              code: row.vatCodeCode !== null && isVatCode(row.vatCodeCode) ? row.vatCodeCode : null,
              lineAmount: Number(row.lineAmount),
            })),
            supplierCountry,
            supplierCurrency,
          })
        : [];
      return {
        ...headerFields,
        vatCode: vatCodeRef({ id: header.vatCodeId, code: vatCodeCode, name: vatCodeName }),
        reverseVat,
        warnings,
        // Valuta: the SEK figures at the invoice's rate (a draft's preview,
        // after the attest equal to what was booked — sekAmounts.grossAmount
        // = grossAmountSek), and the open amount's booked SEK value (null
        // until attested). A foreign invoice without a rate (source null) is
        // "kurs saknas".
        sekAmounts: { grossAmount: sek.grossAmount, vatAmount: sek.vatAmount, netAmount: sek.netAmount },
        exchangeRateMissing: header.currency !== SEK && header.exchangeRateSource === null,
        rows,
        openAmount,
        openAmountSek,
        payments,
        files,
        paymentBatches,
      };
    },

    // Everything a create needs before its transaction: the supplier and the
    // rate — the rate lookup may call Riksbanken, which never happens inside
    // a transaction (CLAUDE.md, Inga DB-transaktioner över HTTP).
    async prepareCreate(input: CreateSupplierInvoiceInput): Promise<PreparedSupplierInvoice> {
      const supplier = await repo.findSupplierById(input.supplierId);
      if (!supplier) throw new SupplierNotFoundError(input.supplierId);
      const rate = await resolveRate(supplier.currency, input.invoiceDate, input.exchangeRate, input.purchaseOrderId ?? null);
      return { supplier, rate };
    },

    // The supplier invoice draft inside the caller's transaction — the
    // Fakturainkorg's conversion (Db | Tx: every read and write below goes
    // through a repository bound to `tx`). Writes no audit entry; the caller
    // logs after its commit (auditCreated). A duplicate invoice number
    // aborts the caller's transaction (DuplicateSupplierInvoiceNumberError).
    async createInTx(tx: Tx, input: CreateSupplierInvoiceInput, createdBy: string, prepared: PreparedSupplierInvoice) {
      const r = createSupplierInvoiceRepository(tx);
      const { supplier, rate } = prepared;
      // Leverantörsreskontra (B4): an explicitly supplied dueDate always wins
      // — the paper invoice's own förfallodatum is the obligation. Only when
      // the client leaves it out is it derived from the supplier's payment
      // term, and only HERE: a draft's PATCH keeps manual control, so an
      // edited due date is never silently recomputed back.
      let dueDate = input.dueDate ?? null;
      if (dueDate === null) {
        const paymentTermCode = supplier.paymentTermId
          ? await r.findPaymentTermCode(supplier.paymentTermId)
          : null;
        dueDate = computeDueDate(input.invoiceDate, paymentTermCode);
      }
      const book = await r.vatCodeBook();
      const vatCodeId = headerVatCodeId(book, supplier, input.vatCodeId);
      const rows: SupplierInvoiceRowWrite[] = [];
      for (const row of input.rows) rows.push(await resolveRow(r, row, book));
      // Kostnadsställen och projekt (header = the rows' default): the
      // supplier's Kostnadsställe (förval) and the linked purchase order's
      // project unless the caller says otherwise.
      const dimensions = await r.resolveDimensions(
        { costCenterId: input.costCenterId, projectId: input.projectId },
        {
          fallback: {
            costCenterId: supplier.defaultCostCenterId,
            projectId: input.purchaseOrderId ? await r.findPurchaseOrderProject(input.purchaseOrderId) : null,
          },
        }
      );
      try {
        return await r.createInTx(
          tx,
          {
            supplierId: input.supplierId,
            invoiceNumber: input.invoiceNumber,
            purchaseOrderId: input.purchaseOrderId ?? null,
            ...dimensions,
            invoiceDate: input.invoiceDate,
            dueDate,
            currency: supplier.currency,
            ...rate,
            // Zod defaults these to 0 over HTTP; guard the direct-call path too.
            netAmount: input.netAmount ?? 0,
            vatAmount: input.vatAmount ?? 0,
            grossAmount: input.grossAmount ?? 0,
            note: input.note ?? null,
            paymentReferenceKind: input.paymentReference?.kind ?? null,
            paymentReference: input.paymentReference?.value ?? null,
            vatCodeId,
          },
          rows,
          createdBy
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateSupplierInvoiceNumberError(input.invoiceNumber);
        throw err;
      }
    },

    // The `created` audit entry, after the transaction that created it.
    async auditCreated(invoice: { registrationNumber: string; invoiceNumber: string; grossAmount: string; currency: string; exchangeRate: string; exchangeRateSource: string | null }, createdBy: string, extra: Record<string, unknown> = {}) {
      await audit.log({
        entityType: "supplier_invoice",
        entityId: invoice.registrationNumber,
        action: "created",
        detail: {
          supplierInvoiceNumber: invoice.invoiceNumber,
          grossAmount: invoice.grossAmount,
          ...(invoice.currency === SEK ? {} : { currency: invoice.currency, exchangeRate: invoice.exchangeRate, exchangeRateSource: invoice.exchangeRateSource }),
          ...extra,
        },
        userId: createdBy,
      });
    },

    async create(input: CreateSupplierInvoiceInput, createdBy: string) {
      const prepared = await service.prepareCreate(input);
      const invoice = await repo.transaction((tx) => service.createInTx(tx, input, createdBy, prepared));
      await service.auditCreated(invoice, createdBy);
      return service.getInvoice(invoice.id);
    },

    // Header edits are allowed only in draft.
    async updateHeader(id: string, input: UpdateSupplierInvoiceHeaderInput, userId: string | null = null) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new SupplierInvoiceNotFoundError(id);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot change a supplier invoice in status "${invoice.status}"`);
      }
      const patch: {
        supplierId?: string;
        currency?: string;
        exchangeRate?: string;
        exchangeRateSource?: DocumentRateSource | null;
        exchangeRateDate?: string | null;
        invoiceNumber?: string;
        purchaseOrderId?: string | null;
        invoiceDate?: string;
        dueDate?: string | null;
        netAmount?: string;
        vatAmount?: string;
        grossAmount?: string;
        note?: string | null;
        paymentReferenceKind?: PaymentReferenceKind | null;
        paymentReference?: string | null;
        vatCodeId?: string;
        costCenterId?: string | null;
        projectId?: string | null;
      } = {};
      // Kostnadsställen och projekt: a sent field wins (null clears), an
      // omitted one keeps the header's. The project follows a NEW purchase
      // order link when the invoice has none and the PATCH sets none
      // ("manuellt vinner" — a chosen project is never overwritten).
      const dimensions = await repo.resolveDimensions(
        { costCenterId: input.costCenterId, projectId: input.projectId },
        { existing: { costCenterId: invoice.costCenterId, projectId: invoice.projectId } }
      );
      if (dimensions.projectId === null && input.projectId === undefined && input.purchaseOrderId && input.purchaseOrderId !== invoice.purchaseOrderId) {
        const linked = await repo.findPurchaseOrderProject(input.purchaseOrderId);
        // A closed project on the order is dropped silently, like any default.
        if (linked) dimensions.projectId = (await repo.resolveDimensions({}, { fallback: { projectId: linked } })).projectId;
      }
      patch.costCenterId = dimensions.costCenterId;
      patch.projectId = dimensions.projectId;
      // Byte av leverantör (betalas till): the currency is re-snapshotted from
      // the new supplier, as at creation. The due date is left alone — like
      // every other draft edit it stays under manual control.
      let supplierChange: { from: string; to: string } | null = null;
      if (input.supplierId !== undefined && input.supplierId !== invoice.supplierId) {
        const [previous, next] = await Promise.all([
          repo.findSupplierById(invoice.supplierId),
          repo.findSupplierById(input.supplierId),
        ]);
        if (!next) throw new SupplierNotFoundError(input.supplierId);
        patch.supplierId = next.id;
        patch.currency = next.currency;
        supplierChange = {
          from: previous ? `${previous.supplierNumber} ${previous.name}` : invoice.supplierId,
          to: `${next.supplierNumber} ${next.name}`,
        };
      }
      if (input.invoiceNumber !== undefined) patch.invoiceNumber = input.invoiceNumber;
      if (input.purchaseOrderId !== undefined) patch.purchaseOrderId = input.purchaseOrderId;
      if (input.invoiceDate !== undefined) patch.invoiceDate = input.invoiceDate;
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
      if (input.netAmount !== undefined) patch.netAmount = String(input.netAmount);
      if (input.vatAmount !== undefined) patch.vatAmount = String(input.vatAmount);
      if (input.grossAmount !== undefined) patch.grossAmount = String(input.grossAmount);
      if (input.note !== undefined) patch.note = input.note;
      if (input.paymentReference !== undefined) {
        patch.paymentReferenceKind = input.paymentReference?.kind ?? null;
        patch.paymentReference = input.paymentReference?.value ?? null;
      }
      // Momskod (draft only, like every header edit): an active purchase
      // code — the stored one may stay even if deactivated since.
      if (input.vatCodeId !== undefined) {
        const book = await repo.vatCodeBook();
        patch.vatCodeId = documentVatCode(book, { id: input.vatCodeId }, "purchase", {
          allowInactive: input.vatCodeId === invoice.vatCodeId,
        }).id;
      }
      // Valuta (the touched-mönster): a rate typed in always wins (a number,
      // source manual); null asks for the automatic rate again. Left out,
      // the rate is looked up again when the currency changed (byte av
      // leverantör), when the invoice date changed and the stored rate was
      // not typed by hand (source manual), and whenever the rate is missing
      // (a foreign invoice without a source) — whatever else the PATCH
      // changes. Every lookup runs here, before the UPDATE; an automatic
      // lookup that finds nothing leaves the invoice "kurs saknas" (no
      // source) instead of failing the edit — the attest refuses it.
      const currency = patch.currency ?? invoice.currency;
      const invoiceDate = patch.invoiceDate ?? invoice.invoiceDate;
      const currencyChanged = currency !== invoice.currency;
      const dateChanged = invoiceDate !== invoice.invoiceDate;
      const rateMissing = invoice.currency !== SEK && invoice.exchangeRateSource === null;
      const purchaseOrderId = patch.purchaseOrderId !== undefined ? patch.purchaseOrderId : invoice.purchaseOrderId;
      const automaticRate = async (): Promise<ResolvedRate> => {
        try {
          return await resolveRate(currency, invoiceDate, undefined, purchaseOrderId);
        } catch (err) {
          if (!(err instanceof ExchangeRateUnavailableError)) throw err;
          // Kurs saknas: the stored value stays (1 for a new currency) and
          // only the missing source says it — the card's exchangeRateMissing.
          return { exchangeRate: currencyChanged ? 1 : Number(invoice.exchangeRate), exchangeRateSource: null, exchangeRateDate: null };
        }
      };
      let rateChange: ResolvedRate | null = null;
      if (typeof input.exchangeRate === "number") {
        rateChange = await resolveRate(currency, invoiceDate, input.exchangeRate, purchaseOrderId);
      } else if (input.exchangeRate === null) {
        rateChange = await automaticRate();
      } else if (currencyChanged || (currency !== SEK && ((dateChanged && invoice.exchangeRateSource !== "manual") || rateMissing))) {
        rateChange = await automaticRate();
      }
      if (rateChange) {
        patch.exchangeRate = String(rateChange.exchangeRate);
        patch.exchangeRateSource = rateChange.exchangeRateSource;
        patch.exchangeRateDate = rateChange.exchangeRateDate;
      }
      let updated;
      try {
        updated = await repo.updateHeader(id, patch);
      } catch (err) {
        // The unique key is (supplier, invoice number), so a supplier change
        // alone can hit it too.
        if (isUniqueViolation(err)) throw new DuplicateSupplierInvoiceNumberError(input.invoiceNumber ?? invoice.invoiceNumber);
        throw err;
      }
      // The repository's own status guard: an attest (or makulering) won the
      // race after the check above.
      if (!updated) throw new InvalidStatusTransitionError("The supplier invoice was changed by someone else");
      if (supplierChange) {
        await audit.log({
          entityType: "supplier_invoice",
          entityId: invoice.registrationNumber,
          action: "supplier_changed",
          detail: { before: { supplier: supplierChange.from }, after: { supplier: supplierChange.to } },
          userId,
        });
      }
      if (rateChange && (rateChange.exchangeRate !== Number(invoice.exchangeRate) || rateChange.exchangeRateSource !== invoice.exchangeRateSource)) {
        await audit.log({
          entityType: "supplier_invoice",
          entityId: invoice.registrationNumber,
          action: "exchange_rate_changed",
          detail: {
            before: { currency: invoice.currency, exchangeRate: invoice.exchangeRate, exchangeRateSource: invoice.exchangeRateSource },
            after: { currency, exchangeRate: String(rateChange.exchangeRate), exchangeRateSource: rateChange.exchangeRateSource },
          },
          userId,
        });
      }
      return service.getInvoice(id);
    },

    // Bankfiler: OCR/meddelande may change in draft AND approved (it is not
    // bookkeeping data), never on a paid or cancelled invoice.
    async updatePaymentReference(id: string, input: UpdatePaymentReferenceInput, userId: string) {
      const result = await repo.setPaymentReference(id, input.paymentReference);
      if (!result.ok) {
        if (result.reason === "not_found") throw new SupplierInvoiceNotFoundError(id);
        if (result.reason === "in_payment_batch") throw new SupplierInvoiceInPaymentBatchError(result.batchNumber);
        throw new InvalidStatusTransitionError(`Cannot change the payment reference of a supplier invoice in status "${result.status}"`);
      }
      await audit.log({
        entityType: "supplier_invoice",
        entityId: result.invoice.registrationNumber,
        action: "payment_reference_changed",
        detail: { kind: result.invoice.paymentReferenceKind, reference: result.invoice.paymentReference },
        userId,
      });
      return service.getInvoice(id);
    },

    async addRow(invoiceId: string, input: CreateSupplierInvoiceRowInput) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new SupplierInvoiceNotFoundError(invoiceId);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot change rows on a supplier invoice in status "${invoice.status}"`);
      }
      return repo.addRow(invoiceId, await resolveRow(repo, input, await repo.vatCodeBook()));
    },

    async updateRow(invoiceId: string, rowId: string, input: UpdateSupplierInvoiceRowInput) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new SupplierInvoiceNotFoundError(invoiceId);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot change rows on a supplier invoice in status "${invoice.status}"`);
      }
      const existing = await repo.findRow(invoiceId, rowId);
      if (!existing) throw new SupplierInvoiceRowNotFoundError(rowId);
      // Merge the patch onto the current row, then re-validate + recompute.
      const merged: RowInput = {
        articleId: input.articleId !== undefined ? input.articleId : existing.articleId,
        purchaseOrderRowId:
          input.purchaseOrderRowId !== undefined ? input.purchaseOrderRowId : existing.purchaseOrderRowId,
        description: input.description ?? existing.description,
        quantity: input.quantity ?? Number(existing.quantity),
        unitPrice: input.unitPrice ?? Number(existing.unitPrice),
        vatRate:
          input.vatRate !== undefined ? input.vatRate : existing.vatRate !== null ? Number(existing.vatRate) : null,
        vatCodeId: input.vatCodeId !== undefined ? input.vatCodeId : existing.vatCodeId,
        // Kostnadsställen och projekt: undefined keeps the row's, null clears.
        costCenterId: input.costCenterId,
        projectId: input.projectId,
      };
      const row = await repo.updateRow(
        invoiceId,
        rowId,
        await resolveRow(repo, merged, await repo.vatCodeBook(), existing.vatCodeId, { costCenterId: existing.costCenterId, projectId: existing.projectId })
      );
      if (!row) throw new SupplierInvoiceRowNotFoundError(rowId);
      return row;
    },

    async deleteRow(invoiceId: string, rowId: string) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new SupplierInvoiceNotFoundError(invoiceId);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot change rows on a supplier invoice in status "${invoice.status}"`);
      }
      const row = await repo.deleteRow(invoiceId, rowId);
      if (!row) throw new SupplierInvoiceRowNotFoundError(rowId);
    },

    // --- Status flow: draft → approved → paid, cancel from draft/approved ---
    //
    // Automatkontering (B2): attest and makulering of an attested invoice are
    // bookkeeping events, so both go through a repository transaction that
    // books (respectively reverses) the L verification together with the
    // status flip. There is no path that approves without posting, and none
    // that posts without approving.
    //
    // Leverantörsreskontra (B4): "paid" is NOT a transition this service
    // offers. It is set by the payment registration (supplier-payment.
    // repository.ts) when a payment settles the open amount, and unset when
    // that payment is cancelled — so there is no approve() counterpart for it
    // here, and no markPaid in the repository.

    async approve(id: string, userId: string) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new SupplierInvoiceNotFoundError(id);
      if (invoice.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot approve a supplier invoice in status "${invoice.status}"`);
      }
      // A posting failure (locked/absent period, missing or inactive account,
      // header amounts that don't add up) propagates out of the repository
      // untouched and is mapped to 409 by the routes — the whole transition
      // rolls back with it. A foreign invoice is posted in SEK at its own
      // rate (Valuta).
      const result = await repo.approve(id, userId, poster);
      // ok:false is either a foreign invoice without a rate, or the lost race
      // the repository's own FOR UPDATE re-read caught: a concurrent
      // approve/cancel moved this invoice out of "draft" between the guard
      // above and the transaction.
      if (!result.ok) {
        if (result.reason === "exchange_rate_missing") throw new SupplierInvoiceExchangeRateMissingError(invoice.currency);
        throw new InvalidStatusTransitionError("The supplier invoice was changed by someone else");
      }
      await audit.log({
        entityType: "supplier_invoice",
        entityId: invoice.registrationNumber,
        action: "approved",
        userId,
      });
      return service.getInvoice(id);
    },

    async cancel(id: string, userId: string) {
      const invoice = await repo.findRawById(id);
      if (!invoice) throw new SupplierInvoiceNotFoundError(id);
      if (invoice.status === "draft") {
        const row = await repo.cancelDraft(id);
        if (!row) throw new InvalidStatusTransitionError("The supplier invoice was changed by someone else");
      } else if (invoice.status === "approved") {
        let result;
        try {
          result = await repo.cancelApproved(id, userId, poster);
        } catch (err) {
          // The partial unique index verifications_reverses_unique fired: a
          // manual Omför of the same verification committed while this
          // cancellation was writing its own omföring.
          if (isUniqueViolation(err)) throw new VerificationAlreadyReversedError();
          throw err;
        }
        if (!result.ok) {
          if (result.reason === "has_payments") throw new SupplierInvoiceHasPaymentsError();
          if (result.reason === "in_payment_batch") throw new SupplierInvoiceInPaymentBatchError(result.batchNumber);
          throw new InvalidStatusTransitionError("The supplier invoice was changed by someone else");
        }
      } else {
        throw new InvalidStatusTransitionError(`Cannot cancel a supplier invoice in status "${invoice.status}"`);
      }
      await audit.log({
        entityType: "supplier_invoice",
        entityId: invoice.registrationNumber,
        action: "cancelled",
        userId,
      });
      return service.getInvoice(id);
    },

    // --- Underlag ---

    async listFiles(invoiceId: string) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new SupplierInvoiceNotFoundError(invoiceId);
      return repo.listFiles(invoiceId);
    },

    // Allowed in every status: underlag that arrives late (or a second page)
    // can always be ADDED — only removal is restricted (deleteFile).
    async addFile(
      invoiceId: string,
      file: { filename: string; contentType: string; data: Buffer },
      userId: string | null
    ) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new SupplierInvoiceNotFoundError(invoiceId);
      if (!(SUPPLIER_INVOICE_FILE_TYPES as readonly string[]).includes(file.contentType)) {
        throw new InvalidSupplierInvoiceFileTypeError(file.contentType);
      }
      const sha256 = createHash("sha256").update(file.data).digest("hex");
      const row = await repo.addFile({
        supplierInvoiceId: invoiceId,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.data.length,
        sha256,
        data: file.data,
        uploadedBy: userId,
      });
      await audit.log({
        entityType: "supplier_invoice",
        entityId: invoice.registrationNumber,
        action: "file_added",
        detail: { filename: row.filename, sizeBytes: row.sizeBytes, sha256 },
        userId,
      });
      return row;
    },

    async downloadFile(invoiceId: string, fileId: string) {
      const file = await repo.findFile(invoiceId, fileId);
      if (!file) throw new SupplierInvoiceFileNotFoundError(fileId);
      return file;
    },

    async deleteFile(invoiceId: string, fileId: string, userId: string | null) {
      const invoice = await repo.findRawById(invoiceId);
      if (!invoice) throw new SupplierInvoiceNotFoundError(invoiceId);
      const result = await repo.deleteFileIfDraft(invoiceId, fileId);
      if (!result.ok) {
        if (result.reason === "locked") throw new SupplierInvoiceFileLockedError();
        if (result.reason === "from_scan") throw new SupplierInvoiceFileFromScanError(result.scanNumber);
        throw new SupplierInvoiceFileNotFoundError(fileId);
      }
      await audit.log({
        entityType: "supplier_invoice",
        entityId: invoice.registrationNumber,
        action: "file_deleted",
        detail: { filename: result.filename, sha256: result.sha256 },
        userId,
      });
    },
  };

  return service;
}

export type SupplierInvoiceService = ReturnType<typeof createSupplierInvoiceService>;
