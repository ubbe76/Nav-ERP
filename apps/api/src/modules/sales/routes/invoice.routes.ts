import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createCreditInvoiceSchema,
  createInvoiceRowSchema,
  createInvoiceSchema,
  listInvoicesQuerySchema,
  runCollectiveInvoicingSchema,
  sendDocumentEmailSchema,
  sendReminderSchema,
  updateInvoiceHeaderSchema,
  updateInvoiceRowSchema,
} from "@navet/shared";
import { AccountingPeriodLockedError } from "../../economy/service/accounting-period-lock.js";
import { MailSendError, SmtpNotConfiguredError } from "../../mail/service/mail.service.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  PaymentBankAccountConflictError,
  UnknownVatRateError,
  VatCodeAmountMismatchError,
  VatCodeNotApplicableError,
  ZeroAmountPostingError,
} from "../../economy/service/verification-poster.js";
import type { InvoiceService } from "../service/invoice.service.js";
import {
  CollectiveInvoicingCustomerError,
  EmptyInvoiceError,
  InvoiceNotFoundError,
  ArchivedReminderNotFoundError,
  InvoiceRowNotFoundError,
  InvalidShipmentInvoiceRowError,
  NothingToRemindError,
  NotCreditableError,
  OverCreditError,
  OverInvoicingError,
  ReminderFeeAlreadyChargedError,
  SalesOrderRowMismatchError,
  ShipmentAlreadyInvoicedError,
  InvoiceExchangeRateError,
  InvoiceRowCurrencyMismatchError,
  ReminderFeeCurrencyError,
} from "../service/invoice.service.js";
import { ExchangeRateUnavailableError } from "../../system/service/exchange-rates.js";
import { ShipmentNotBillableError, VatNumberRequiredError } from "../service/sales.errors.js";
import { InvalidVatCodeError } from "../../economy/service/document-vat-code.js";
import { CustomerNotFoundError, InvalidStatusTransitionError } from "../service/sales.service.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { INVOICE_CSV_COLUMNS } from "../service/export-columns.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function invoiceRoutes(app: FastifyInstance, opts: { service: InvoiceService }) {
  const { service } = opts;

  // Shared error mapper for the invoice routes — same shape as
  // supplierInvoiceRoutes' invoiceError.
  function invoiceError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    // Momskoder: a row's chosen code is unknown, inactive or not a sales
    // code (400), and Utfärda's momsregistreringsnummer rule (409) — both
    // carry `reason` for the card.
    if (err instanceof InvalidVatCodeError) return reply.code(400).send({ ...errorBody(err), reason: err.reason });
    if (err instanceof VatNumberRequiredError) return reply.code(409).send({ ...errorBody(err), reason: err.reason });
    // Valuta: no rate for the invoice's currency and date at Utfärda (or for
    // a freight row) — the card asks for the rate; a row in another currency
    // than the invoice's; a rate that does not fit (SEK, credit note); a
    // påminnelseavgift on an invoice in another currency.
    if (err instanceof ExchangeRateUnavailableError) {
      return reply.code(409).send({ ...errorBody(err), currency: err.currency, date: err.date });
    }
    if (err instanceof InvoiceRowCurrencyMismatchError) {
      return reply.code(400).send({ ...errorBody(err), rowCurrency: err.rowCurrency, invoiceCurrency: err.invoiceCurrency });
    }
    if (err instanceof InvoiceExchangeRateError) return reply.code(400).send({ ...errorBody(err), reason: err.reason });
    if (err instanceof ReminderFeeCurrencyError) return reply.code(409).send({ ...errorBody(err), currency: err.currency });
    if (
      err instanceof InvoiceNotFoundError ||
      err instanceof ArchivedReminderNotFoundError ||
      err instanceof InvoiceRowNotFoundError ||
      err instanceof CustomerNotFoundError
    ) {
      return reply.code(404).send(errorBody(err as Error));
    }
    // The automatkontering (B2) failures all mean the same thing to the
    // caller as a rejected transition: the invoice is untouched and stays a
    // draft until the bookkeeping side is fixed (period reopened, account
    // seeded/activated, VAT rate corrected).
    //
    // Auth asymmetry, deliberate: every /economy route is admin-only, but
    // these invoice routes are plain-auth — so a non-admin issuing an
    // invoice writes a verification as a side effect, and sees these
    // bookkeeping errors, without being allowed to open Ekonomi. The posting
    // is a consequence of the sales transition it is already entitled to
    // make, never a free hand into the books: it is a fixed, server-derived
    // posting with no client-supplied accounts or amounts.
    if (
      err instanceof InvalidStatusTransitionError ||
      err instanceof OverInvoicingError ||
      err instanceof OverCreditError ||
      err instanceof NotCreditableError ||
      err instanceof EmptyInvoiceError ||
      // Samlingsfaktura customers are billed by the routine, not by hand.
      err instanceof CollectiveInvoicingCustomerError ||
      // Kundreskontra (B3): "nothing to remind about" and "the fee is already
      // charged" are both "the state does not allow this", like every other
      // 409 here. ReminderFeeAlreadyChargedError doubles as the mapping for
      // the partial unique index's 23505 (the service normalizes it).
      err instanceof NothingToRemindError ||
      err instanceof ReminderFeeAlreadyChargedError ||
      // Frakt etapp 2: the same freight is already on an invoice (pre-check
      // or the unique index behind it).
      err instanceof ShipmentAlreadyInvoicedError ||
      // Frakt-uppföljning: the shipment is cancelled or being cancelled,
      // seen under the insert's FOR SHARE lock.
      err instanceof ShipmentNotBillableError ||
      err instanceof AccountingPeriodLockedError ||
      err instanceof NoAccountingPeriodForPostingError ||
      err instanceof MissingPostingAccountError ||
      err instanceof UnknownVatRateError ||
      // Momskoder: a row's code and amounts disagree, or the code is not a
      // sales code — a data problem on the draft, refused at issue.
      err instanceof VatCodeAmountMismatchError ||
      err instanceof VatCodeNotApplicableError ||
      err instanceof ZeroAmountPostingError ||
      // The reminder fee account and accounts receivable pointing at ONE
      // account: a configuration conflict, refused before the email goes out.
      err instanceof PaymentBankAccountConflictError ||
      // The two mail failures, mapped the same way sales.routes/purchase.routes
      // map them for their own document sends (this mapper predates the
      // invoice's own send-email route and was missing them).
      err instanceof SmtpNotConfiguredError
    ) {
      return reply.code(409).send(errorBody(err as Error));
    }
    if (err instanceof MailSendError) return reply.code(502).send(errorBody(err));
    if (err instanceof SalesOrderRowMismatchError || err instanceof InvalidShipmentInvoiceRowError) {
      return reply.code(400).send(errorBody(err));
    }
    throw err;
  }

  app.get("/invoices", async (req) => service.list(listInvoicesQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/invoices/csv",
    querySchema: listInvoicesQuerySchema,
    filenameBase: "fakturor",
    columns: INVOICE_CSV_COLUMNS,
    fetch: (q) => service.list(q),
  });

  app.post("/invoices", async (req, reply) => {
    const input = createInvoiceSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input, req.user!.id));
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", async (req, reply) => {
    const invoice = await service.getInvoice(req.params.id);
    if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
    return invoice;
  });

  app.patch<{ Params: { id: string } }>("/invoices/:id", async (req, reply) => {
    const input = updateInvoiceHeaderSchema.parse(req.body);
    try {
      return await service.updateHeader(req.params.id, input, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/rows", async (req, reply) => {
    const input = createInvoiceRowSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.addRow(req.params.id, input, req.user!.id));
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>("/invoices/:id/rows/:rowId", async (req, reply) => {
    const input = updateInvoiceRowSchema.parse(req.body);
    try {
      return await service.updateRow(req.params.id, req.params.rowId, input, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; rowId: string } }>("/invoices/:id/rows/:rowId", async (req, reply) => {
    try {
      await service.deleteRow(req.params.id, req.params.rowId, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/issue", async (req, reply) => {
    try {
      return await service.issue(req.params.id, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // No POST /invoices/:id/pay (B3): "betald" is set by registering a payment
  // (POST /payments, payment.routes.ts), which settles the open amount and
  // books it — not by a manual status flip.

  app.post<{ Params: { id: string } }>("/invoices/:id/cancel", async (req, reply) => {
    try {
      return await service.cancel(req.params.id, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // Raises a credit note (draft) against an issued/paid original invoice.
  app.post<{ Params: { id: string } }>("/invoices/:id/credit", async (req, reply) => {
    const input = createCreditInvoiceSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createCredit(req.params.id, input, req.user!.id));
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/invoices/:id/pdf", async (req, reply) => {
    try {
      const { filename, content } = await service.renderPdf(req.params.id);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // sendDocumentEmailSchema also carries attachDrawings — the invoice
  // module ignores it (SendInvoiceEmailInput has no such field; invoices
  // never attach article drawings, see InvoiceMailSender's comment).
  app.post<{ Params: { id: string } }>("/invoices/:id/send-email", async (req, reply) => {
    const input = sendDocumentEmailSchema.parse(req.body);
    try {
      await service.sendEmail(req.params.id, input);
      return reply.code(204).send();
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // Betalningspåminnelse (B3). The email goes out FIRST and the fee is booked
  // in the transaction right after it (see sendReminder's own comment), so a
  // 409 from here can mean either "refused before anything happened" or "the
  // email went out but the state changed under it" — both are safe to retry.
  app.post<{ Params: { id: string } }>("/invoices/:id/reminders", async (req, reply) => {
    const input = sendReminderSchema.parse(req.body);
    try {
      return await service.sendReminder(req.params.id, input, req.user!.id);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // A sent reminder exactly as emailed (the archived copy).
  app.get<{ Params: { id: string; reminderId: string } }>(
    "/invoices/:id/reminders/:reminderId/pdf",
    async (req, reply) => {
      try {
        const { filename, content } = await service.reminderPdf(req.params.id, req.params.reminderId);
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", contentDisposition(filename));
        return reply.send(content);
      } catch (err) {
        return invoiceError(err, reply);
      }
    }
  );

  // Preview of the reminder PDF — renders without sending or persisting.
  // NOT z.coerce.boolean() for withFee: it turns the string "false" into true
  // (same pitfall as listOpenInvoicesQuerySchema's overdueOnly).
  app.get<{ Params: { id: string } }>("/invoices/:id/reminder-pdf", async (req, reply) => {
    const { withFee } = z
      .object({
        withFee: z
          .enum(["true", "false"])
          .optional()
          .transform((value) => value === "true"),
      })
      .parse(req.query);
    try {
      const { filename, content } = await service.renderReminderPdf(req.params.id, withFee);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // Samlingsfakturering: flagged customers with something left to bill, and
  // the run that creates (optionally issues) one invoice per selected customer.
  app.get("/collective-invoicing/candidates", async () => service.listCollectiveInvoicingCandidates());

  app.post("/collective-invoicing/run", async (req) => {
    const input = runCollectiveInvoicingSchema.parse(req.body);
    // Per-customer failures come back in the result rows, never as an HTTP
    // error — one bad customer must not hide the invoices that were created.
    return service.runCollectiveInvoicing(input, req.user!.id);
  });

  // Draft candidates for the "create from delivered order(s)" prefill.
  app.get("/invoiceable-orders", async (req, reply) => {
    const { customerId } = z.object({ customerId: z.string().uuid() }).parse(req.query);
    try {
      return await service.listInvoiceableOrders(customerId);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });

  // Frakt etapp 2: the customer's booked, unbilled shipments for the dialog.
  app.get("/invoiceable-shipments", async (req, reply) => {
    const { customerId } = z.object({ customerId: z.string().uuid() }).parse(req.query);
    try {
      return await service.listInvoiceableShipments(customerId);
    } catch (err) {
      return invoiceError(err, reply);
    }
  });
}
