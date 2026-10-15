import type { FastifyInstance } from "fastify";
import { createPaymentSchema, listOpenInvoicesQuerySchema, listPaymentsQuerySchema } from "@navet/shared";
import { AccountingPeriodLockedError } from "../../economy/service/accounting-period-lock.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  PaymentAmountMismatchError,
  PaymentBankAccountConflictError,
  ZeroAmountPostingError,
} from "../../economy/service/verification-poster.js";
import { InvoiceNotFoundError } from "../service/invoice.service.js";
import type { PaymentService } from "../service/payment.service.js";
import {
  InvalidOcrError,
  InvoiceNotOpenError,
  PaymentAlreadyCancelledError,
  PaymentExceedsOpenAmountError,
  PaymentNotFoundError,
  PaymentRowMismatchError,
  VerificationAlreadyReversedError,
} from "../service/payment.service.js";
import { CustomerNotFoundError } from "../service/sales.service.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { errorBody } from "../../system/service/error-body.js";
import { OPEN_INVOICE_CSV_COLUMNS, PAYMENT_CSV_COLUMNS } from "../service/export-columns.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function paymentRoutes(app: FastifyInstance, opts: { service: PaymentService }) {
  const { service } = opts;

  // Shared error mapper — mirrors invoice.routes.ts's invoiceError, with the
  // reskontra's own conflicts and the two payment-specific poster errors.
  function paymentError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (
      err instanceof PaymentNotFoundError ||
      err instanceof InvoiceNotFoundError ||
      err instanceof CustomerNotFoundError
    ) {
      return reply.code(404).send(errorBody(err as Error));
    }
    // Everything that means "your payment cannot become what you asked for,
    // given the current state of the open items or the books".
    //
    // Auth asymmetry, deliberate — and WIDER here than for the invoice/
    // supplier-invoice routes, so it is worth stating exactly how far it
    // goes. Every /economy route is admin-only, but these payment routes are
    // plain-auth: a non-admin registering a payment writes a K verification
    // (and an omföring when cancelling one) without being allowed to open
    // Ekonomi. Unlike issuing an invoice, the posting is NOT entirely
    // server-derived — the payer picks the betalkonto, and a tolerance
    // difference lands on the write-off account. It is still bounded, not a
    // free hand into the books: the betalkonto must be an EXISTING, ACTIVE
    // account (the posting resolves it and refuses anything else), the
    // write-off is computed by the server from the invoice's own open amount
    // and the admin-owned tolerance setting — never sent by the client — and
    // the amount is anchored to open items that already exist. What a
    // non-admin can express is "this money arrived against these invoices",
    // nothing more.
    if (
      err instanceof InvoiceNotOpenError ||
      err instanceof PaymentRowMismatchError ||
      err instanceof PaymentExceedsOpenAmountError ||
      err instanceof PaymentAlreadyCancelledError ||
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
      // user CAN pick accounts receivable (or the write-off account) as the
      // betalkonto. The poster is the only place that knows those ids and
      // refuses it there.
      err instanceof PaymentBankAccountConflictError
    ) {
      return reply.code(409).send(errorBody(err as Error));
    }
    if (err instanceof InvalidOcrError) {
      return reply.code(400).send(errorBody(err));
    }
    throw err;
  }

  // Öppna poster (the receivables ledger's own list).
  app.get("/open-invoices", async (req) => service.listOpenInvoices(listOpenInvoicesQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/open-invoices/csv",
    querySchema: listOpenInvoicesQuerySchema,
    filenameBase: "kundreskontra",
    columns: OPEN_INVOICE_CSV_COLUMNS,
    fetch: (q) => service.listOpenInvoices(q),
  });

  // OCR lookup for the registration form: 400 for a reference that is not
  // well-formed, 404 when no open item carries it.
  app.get<{ Params: { ocr: string } }>("/open-invoices/by-ocr/:ocr", async (req, reply) => {
    try {
      const invoice = await service.findOpenByOcr(req.params.ocr);
      if (!invoice) return reply.code(404).send({ error: "No open invoice carries that OCR reference" });
      return invoice;
    } catch (err) {
      return paymentError(err, reply);
    }
  });

  app.get("/payments", async (req) => service.list(listPaymentsQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/payments/csv",
    querySchema: listPaymentsQuerySchema,
    filenameBase: "betalningar",
    columns: PAYMENT_CSV_COLUMNS,
    fetch: (q) => service.list(q),
  });

  app.post("/payments", async (req, reply) => {
    const input = createPaymentSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input, req.user!.id));
    } catch (err) {
      return paymentError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/payments/:id", async (req, reply) => {
    const payment = await service.getPayment(req.params.id);
    if (!payment) return reply.code(404).send({ error: "Payment not found" });
    return payment;
  });

  app.post<{ Params: { id: string } }>("/payments/:id/cancel", async (req, reply) => {
    try {
      return await service.cancel(req.params.id, req.user!.id);
    } catch (err) {
      return paymentError(err, reply);
    }
  });
}
