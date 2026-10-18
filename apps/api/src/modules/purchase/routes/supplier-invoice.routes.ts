import type { FastifyInstance } from "fastify";
import {
  createSupplierInvoiceRowSchema,
  createSupplierInvoiceSchema,
  listSupplierInvoicesQuerySchema,
  updatePaymentReferenceSchema,
  updateSupplierInvoiceHeaderSchema,
  updateSupplierInvoiceRowSchema,
} from "@navet/shared";
import type { SupplierInvoiceService } from "../service/supplier-invoice.service.js";
import {
  DuplicateSupplierInvoiceNumberError,
  InvalidSupplierInvoiceFileTypeError,
  MAX_SUPPLIER_INVOICE_FILE_BYTES,
  SupplierInvoiceFileLockedError,
  SupplierInvoiceFileNotFoundError,
  PoMatchMismatchError,
  SupplierInvoiceHasPaymentsError,
  SupplierInvoiceInPaymentBatchError,
  SupplierInvoiceNotFoundError,
  SupplierInvoiceRowNotFoundError,
  VerificationAlreadyReversedError,
} from "../service/supplier-invoice.service.js";
import { InvalidStatusTransitionError, SupplierNotFoundError } from "../service/purchase.service.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { errorBody } from "../../system/service/error-body.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { SUPPLIER_INVOICE_CSV_COLUMNS } from "../service/export-columns.js";
// Automatkontering (B2): attest books an L verification and makulering
// reverses it, so every way the posting can refuse surfaces here.
import { AccountingPeriodLockedError } from "../../economy/service/accounting-period-lock.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  NonSekSupplierInvoiceError,
  SupplierInvoiceAmountMismatchError,
  UnknownVatRateError,
  ZeroAmountPostingError,
} from "../../economy/service/verification-poster.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function supplierInvoiceRoutes(app: FastifyInstance, opts: { service: SupplierInvoiceService }) {
  const { service } = opts;

  // Shared error mapper for the supplier-invoice routes.
  function invoiceError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (
      err instanceof SupplierInvoiceNotFoundError ||
      err instanceof SupplierInvoiceRowNotFoundError ||
      err instanceof SupplierInvoiceFileNotFoundError ||
      err instanceof SupplierNotFoundError
    ) {
      return reply.code(404).send(errorBody(err as Error));
    }
    if (
      err instanceof InvalidStatusTransitionError ||
      err instanceof DuplicateSupplierInvoiceNumberError ||
      // The posting refused, so the transition never happened — a conflict
      // with the current state of the books, not a bad request.
      //
      // Auth asymmetry, deliberate: every /economy route is admin-only, but
      // these supplier-invoice routes are plain-auth — so a non-admin
      // approving or cancelling an invoice writes (or reverses) a
      // verification as a side effect, and sees these bookkeeping errors,
      // without being allowed to open Ekonomi. The posting is a consequence
      // of the purchase transition it is already entitled to make, never a
      // free hand into the books: it is a fixed, server-derived posting with
      // no client-supplied accounts or amounts.
      err instanceof AccountingPeriodLockedError ||
      err instanceof NoAccountingPeriodForPostingError ||
      err instanceof MissingPostingAccountError ||
      err instanceof UnknownVatRateError ||
      err instanceof ZeroAmountPostingError ||
      err instanceof SupplierInvoiceAmountMismatchError ||
      err instanceof NonSekSupplierInvoiceError ||
      err instanceof VerificationAlreadyReversedError ||
      // Leverantörsreskontra (B4): makulering refused because live payments
      // still point at the invoice — a conflict with the current state of the
      // ledger, same shape as the bookkeeping refusals above.
      err instanceof SupplierInvoiceHasPaymentsError ||
      // Bankfiler: reserved in a live payment batch (makulering, betalningsreferens).
      err instanceof SupplierInvoiceInPaymentBatchError ||
      // Underlag on an attested/cancelled invoice is räkenskapsinformation.
      err instanceof SupplierInvoiceFileLockedError
    ) {
      return reply.code(409).send(errorBody(err as Error));
    }
    if (err instanceof PoMatchMismatchError || err instanceof InvalidSupplierInvoiceFileTypeError) {
      return reply.code(400).send(errorBody(err));
    }
    throw err;
  }

  app.get("/supplier-invoices", async (req) =>
    service.list(listSupplierInvoicesQuerySchema.parse(req.query))
  );

  registerListCsvRoute(app, {
    path: "/supplier-invoices/csv",
    querySchema: listSupplierInvoicesQuerySchema,
    filenameBase: "leverantorsfakturor",
    columns: SUPPLIER_INVOICE_CSV_COLUMNS,
    fetch: (q) => service.list(q),
  });

  app.post("/supplier-invoices", async (req, reply) => {
    const input = createSupplierInvoiceSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input, req.user!.id));
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/supplier-invoices/:id", async (req, reply) => {
    const invoice = await service.getInvoice(req.params.id);
    if (!invoice) return reply.code(404).send({ error: "Supplier invoice not found" });
    return invoice;
  });

  app.patch<{ Params: { id: string } }>("/supplier-invoices/:id", async (req, reply) => {
    const input = updateSupplierInvoiceHeaderSchema.parse(req.body);
    try {
      return await service.updateHeader(req.params.id, input, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // Bankfiler: OCR/meddelande — editable in draft and approved, unlike the
  // rest of the header (draft only).
  app.patch<{ Params: { id: string } }>("/supplier-invoices/:id/payment-reference", async (req, reply) => {
    const input = updatePaymentReferenceSchema.parse(req.body);
    try {
      return await service.updatePaymentReference(req.params.id, input, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/supplier-invoices/:id/rows", async (req, reply) => {
    const input = createSupplierInvoiceRowSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.addRow(req.params.id, input));
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>(
    "/supplier-invoices/:id/rows/:rowId",
    async (req, reply) => {
      const input = updateSupplierInvoiceRowSchema.parse(req.body);
      try {
        return await service.updateRow(req.params.id, req.params.rowId, input);
      } catch (err) {
        return invoiceError(err, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; rowId: string } }>(
    "/supplier-invoices/:id/rows/:rowId",
    async (req, reply) => {
      try {
        await service.deleteRow(req.params.id, req.params.rowId);
        return reply.code(204).send();
      } catch (err) {
        return invoiceError(err, reply);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/supplier-invoices/:id/approve", async (req, reply) => {
    try {
      return await service.approve(req.params.id, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // No POST /supplier-invoices/:id/pay (B4): paid is set by the payment
  // registration (supplier-payment.repository.ts) when a payment settles the
  // open amount, and unset when one is cancelled.

  app.post<{ Params: { id: string } }>("/supplier-invoices/:id/cancel", async (req, reply) => {
    try {
      return await service.cancel(req.params.id, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // --- Underlag: the supplier's invoice as PDF/scan (räkenskapsinformation) ---

  app.get<{ Params: { id: string } }>("/supplier-invoices/:id/files", async (req, reply) => {
    try {
      return await service.listFiles(req.params.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/supplier-invoices/:id/files", async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_SUPPLIER_INVOICE_FILE_BYTES } });
    if (!file) return reply.code(400).send({ error: "No file provided" });
    const data = await file.toBuffer();
    // fastify-multipart truncates instead of throwing once the limit is hit.
    if (file.file.truncated) return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
    try {
      const row = await service.addFile(
        req.params.id,
        { filename: file.filename, contentType: file.mimetype, data },
        req.user!.id
      );
      return reply.code(201).send(row);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.get<{ Params: { id: string; fileId: string } }>("/supplier-invoices/:id/files/:fileId", async (req, reply) => {
    try {
      const file = await service.downloadFile(req.params.id, req.params.fileId);
      reply.header("Content-Type", file.contentType);
      // inline: the invoice opens straight in the browser's viewer.
      reply.header("Content-Disposition", contentDisposition(file.filename, "inline"));
      return reply.send(file.data);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; fileId: string } }>(
    "/supplier-invoices/:id/files/:fileId",
    async (req, reply) => {
      try {
        await service.deleteFile(req.params.id, req.params.fileId, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        return invoiceError(err, reply);
      }
    }
  );
}
