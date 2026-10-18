import { createHash } from "node:crypto";
import type { Tx } from "@navet/db";
import {
  round2,
  type CreateSupplierInvoiceInput,
  type CreateSupplierInvoiceRowInput,
  type ListSupplierInvoicesQuery,
  type PaymentReferenceKind,
  type UpdatePaymentReferenceInput,
  type UpdateSupplierInvoiceHeaderInput,
  type UpdateSupplierInvoiceRowInput,
} from "@navet/shared";
import type {
  SupplierInvoiceRepository,
  SupplierInvoiceRowWrite,
} from "../repository/supplier-invoice.repository.js";
import { InvalidStatusTransitionError, SupplierNotFoundError } from "./purchase.service.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
// G1: append-only audit trail — optional with a no-op default (see
// sales.service.ts's identical comment).
import type { AuditWriter } from "../../system/repository/audit.repository.js";

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
      netAmount: number;
      vatAmount: number;
      grossAmount: number;
    },
    // Rows only steer WHICH cost accounts the header net is split over.
    // vatRate is nullable (a freight row may carry no VAT at all) and is only
    // a konteringsregel lookup key here.
    rows: { articleGroupId: string | null; vatRate: number | null; lineAmount: number }[],
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
function computeDueDate(invoiceDate: string, paymentTermCode: string | null): string | null {
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
};

export function createSupplierInvoiceService(
  repo: SupplierInvoiceRepository,
  poster: SupplierInvoicePoster,
  // G1: optional, defaults to a no-op — see sales.service.ts's identical comment.
  audit: AuditWriter = { log: async () => {} }
) {
  // Validates the optional PO-match and computes the line/vat amounts so the
  // stored numbers always equal quantity × unitPrice.
  async function resolveRow(input: RowInput): Promise<SupplierInvoiceRowWrite> {
    const articleId = input.articleId ?? null;
    const purchaseOrderRowId = input.purchaseOrderRowId ?? null;
    // The PO's supplier is deliberately NOT compared with the invoice's: the
    // invoice may be paid to another supplier than the one the goods were
    // ordered from (a factoring company, a parent company), and the match
    // still reconciles price and quantity against the order. The article must
    // line up — that is what the variance is computed on.
    if (purchaseOrderRowId) {
      const poRow = await repo.findPurchaseOrderRowForMatch(purchaseOrderRowId);
      if (!poRow) throw new PoMatchMismatchError("The matched purchase order row does not exist");
      if (articleId === null || poRow.articleId !== articleId) {
        throw new PoMatchMismatchError("The matched purchase order row is for a different article");
      }
    }
    const lineAmount = round2(input.quantity * input.unitPrice);
    const vatRate = input.vatRate ?? null;
    const vatAmount = vatRate !== null ? round2(lineAmount * (vatRate / 100)) : 0;
    return {
      articleId,
      purchaseOrderRowId,
      description: input.description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      lineAmount,
      vatAmount,
      vatRate,
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

  const service = {
    async list(query: ListSupplierInvoicesQuery) {
      return repo.list(query);
    },

    // Joined header + rows (with computed variance) for the detail view, plus
    // the leverantörsreskontra (B4) slice: what is still open on the invoice
    // and which payments have touched it. The open amount is DERIVED
    // (open-amounts.ts is the single authority) — there is no stored balance
    // to read, and a draft simply reports its own gross as open.
    async getInvoice(id: string) {
      const header = await repo.findById(id);
      if (!header) return null;
      const [rows, openAmount, payments, files, paymentBatches] = await Promise.all([
        repo.listRows(id).then((invoiceRows) => invoiceRows.map(withVariance)),
        repo.getOpenAmount(id),
        repo.listPaymentsForInvoice(id),
        repo.listFiles(id),
        repo.listPaymentBatchesForInvoice(id),
      ]);
      return { ...header, rows, openAmount, payments, files, paymentBatches };
    },

    async create(input: CreateSupplierInvoiceInput, createdBy: string) {
      const supplier = await repo.findSupplierById(input.supplierId);
      if (!supplier) throw new SupplierNotFoundError(input.supplierId);
      // Leverantörsreskontra (B4): an explicitly supplied dueDate always wins
      // — the paper invoice's own förfallodatum is the obligation. Only when
      // the client leaves it out is it derived from the supplier's payment
      // term, and only HERE: a draft's PATCH keeps manual control, so an
      // edited due date is never silently recomputed back.
      let dueDate = input.dueDate ?? null;
      if (dueDate === null) {
        const paymentTermCode = supplier.paymentTermId
          ? await repo.findPaymentTermCode(supplier.paymentTermId)
          : null;
        dueDate = computeDueDate(input.invoiceDate, paymentTermCode);
      }
      const rows = await Promise.all(input.rows.map((r) => resolveRow(r)));
      let invoice;
      try {
        invoice = await repo.create(
          {
            supplierId: input.supplierId,
            invoiceNumber: input.invoiceNumber,
            purchaseOrderId: input.purchaseOrderId ?? null,
            invoiceDate: input.invoiceDate,
            dueDate,
            currency: supplier.currency,
            // Zod defaults these to 0 over HTTP; guard the direct-call path too.
            netAmount: input.netAmount ?? 0,
            vatAmount: input.vatAmount ?? 0,
            grossAmount: input.grossAmount ?? 0,
            note: input.note ?? null,
            paymentReferenceKind: input.paymentReference?.kind ?? null,
            paymentReference: input.paymentReference?.value ?? null,
          },
          rows,
          createdBy
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateSupplierInvoiceNumberError(input.invoiceNumber);
        throw err;
      }
      await audit.log({
        entityType: "supplier_invoice",
        entityId: invoice.registrationNumber,
        action: "created",
        detail: { supplierInvoiceNumber: invoice.invoiceNumber, grossAmount: invoice.grossAmount },
        userId: createdBy,
      });
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
      } = {};
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
      return repo.addRow(invoiceId, await resolveRow(input));
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
      };
      const row = await repo.updateRow(invoiceId, rowId, await resolveRow(merged));
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
      // header amounts that don't add up, non-SEK) propagates out of the
      // repository untouched and is mapped to 409 by the routes — the whole
      // transition rolls back with it.
      const result = await repo.approve(id, userId, poster);
      // The only ok:false reason is the lost race the repository's own
      // FOR UPDATE re-read caught: a concurrent approve/cancel moved this
      // invoice out of "draft" between the guard above and the transaction.
      if (!result.ok) {
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
