import type { FastifyInstance } from "fastify";
import {
  createSupplierPaymentSchema,
  listOpenSupplierInvoicesQuerySchema,
  listSupplierPaymentsQuerySchema,
} from "@navet/shared";
import { AccountingPeriodLockedError } from "../../economy/service/accounting-period-lock.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  PaymentAmountMismatchError,
  PaymentBankAccountConflictError,
  ZeroAmountPostingError,
} from "../../economy/service/verification-poster.js";
import { SupplierNotFoundError } from "../service/purchase.service.js";
import { SupplierInvoiceNotFoundError } from "../service/supplier-invoice.service.js";
import type { SupplierPaymentService } from "../service/supplier-payment.service.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { errorBody } from "../../system/service/error-body.js";
import { OPEN_SUPPLIER_INVOICE_CSV_COLUMNS, SUPPLIER_PAYMENT_CSV_COLUMNS } from "../service/export-columns.js";
import {
  PaymentMixedCurrenciesError,
  SupplierPaymentAmountSekError,
  SupplierInvoiceNotOpenError,
  SupplierInvoiceReservedError,
  SupplierPaymentAlreadyCancelledError,
  SupplierPaymentExceedsOpenAmountError,
  SupplierPaymentNotFoundError,
  SupplierPaymentRowMismatchError,
  VerificationAlreadyReversedError,
} from "../service/supplier-payment.service.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function supplierPaymentRoutes(app: FastifyInstance, opts: { service: SupplierPaymentService }) {
  const { service } = opts;

  // Shared error mapper — mirrors sales' payment.routes.ts, with the
  // leverantörsreskontra's own conflicts and the two payment-specific poster
  // errors.
  function paymentError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (
      err instanceof SupplierPaymentNotFoundError ||
      err instanceof SupplierInvoiceNotFoundError ||
      err instanceof SupplierNotFoundError
    ) {
      return reply.code(404).send(errorBody(err as Error));
    }
    // Valuta: the request itself does not fit the invoices' currency.
    if (err instanceof PaymentMixedCurrenciesError) {
      return reply.code(400).send({ ...errorBody(err), currencies: err.currencies });
    }
    if (err instanceof SupplierPaymentAmountSekError) {
      return reply.code(400).send({ ...errorBody(err), reason: err.reason, currency: err.currency });
    }
    // Everything that means "your payment cannot become what you asked for,
    // given the current state of the open items or the books".
    //
    // Auth asymmetry, deliberate — and WIDER here than for the
    // supplier-invoice routes, so it is worth stating exactly how far it goes.
    // Every /economy route is admin-only, but these payment routes are
    // plain-auth: a non-admin registering an outgoing payment writes a U
    // verification (and an omföring when cancelling one) without being allowed
    // to open Ekonomi. Unlike approving an invoice, the posting is NOT
    // entirely server-derived — the payer picks the betalkonto the money
    // leaves from, and a tolerance difference lands on the write-off account.
    // It is still bounded, not a free hand into the books: the betalkonto must
    // be an EXISTING, ACTIVE account (the posting resolves it and refuses
    // anything else), the write-off is computed by the server from the
    // invoice's own open amount and the admin-owned tolerance setting — never
    // sent by the client — and the amount is anchored to open items that
    // already exist. What a non-admin can express is "this money was paid
    // against these supplier invoices", nothing more.
    if (
      err instanceof SupplierInvoiceNotOpenError ||
      // Bankfiler: reserved in a live payment batch — only its confirmation pays it.
      err instanceof SupplierInvoiceReservedError ||
      err instanceof SupplierPaymentRowMismatchError ||
      err instanceof SupplierPaymentExceedsOpenAmountError ||
      err instanceof SupplierPaymentAlreadyCancelledError ||
      err instanceof VerificationAlreadyReversedError ||
      err instanceof AccountingPeriodLockedError ||
      err instanceof NoAccountingPeriodForPostingError ||
      err instanceof MissingPostingAccountError ||
      err instanceof ZeroAmountPostingError ||
      // Unreachable through this service, which validates the same identity
      // before the transaction opens — mapped anyway so a future caller bug
      // surfaces as a conflict, not a 500.
      err instanceof PaymentAmountMismatchError ||
      // Reachable: the account picker offers every active account, so the
      // user CAN pick accounts payable (or the write-off account) as the
      // betalkonto. The poster is the only place that knows those ids and
      // refuses it there.
      err instanceof PaymentBankAccountConflictError
    ) {
      return reply.code(409).send(errorBody(err as Error));
    }
    throw err;
  }

  // Öppna poster (the payables ledger's own list). No OCR lookup on this side:
  // supplier invoices are matched manually, never parsed from a reference.
  app.get("/open-supplier-invoices", async (req) =>
    service.listOpenInvoices(listOpenSupplierInvoicesQuerySchema.parse(req.query))
  );

  registerListCsvRoute(app, {
    path: "/open-supplier-invoices/csv",
    querySchema: listOpenSupplierInvoicesQuerySchema,
    filenameBase: "leverantorsreskontra",
    columns: OPEN_SUPPLIER_INVOICE_CSV_COLUMNS,
    fetch: (q) => service.listOpenInvoices(q),
  });

  app.get("/supplier-payments", async (req) => service.list(listSupplierPaymentsQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/supplier-payments/csv",
    querySchema: listSupplierPaymentsQuerySchema,
    filenameBase: "leverantorsbetalningar",
    columns: SUPPLIER_PAYMENT_CSV_COLUMNS,
    fetch: (q) => service.list(q),
  });

  app.post("/supplier-payments", async (req, reply) => {
    const input = createSupplierPaymentSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input, req.user!.id));
    } catch (err) {
      return paymentError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/supplier-payments/:id", async (req, reply) => {
    const payment = await service.getPayment(req.params.id);
    if (!payment) return reply.code(404).send({ error: "Supplier payment not found" });
    return payment;
  });

  app.post<{ Params: { id: string } }>("/supplier-payments/:id/cancel", async (req, reply) => {
    try {
      return await service.cancel(req.params.id, req.user!.id);
    } catch (err) {
      return paymentError(err, reply);
    }
  });
}
