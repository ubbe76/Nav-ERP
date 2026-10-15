import type { FastifyInstance } from "fastify";
import { listEmailLogQuerySchema, satisfiesRule, sendTestEmailSchema } from "@navet/shared";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { ForbiddenError } from "../../auth/middleware/permission.middleware.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { errorBody } from "../../system/service/error-body.js";
import { emailLogExportColumns } from "../service/export-columns.js";
import type { MailService } from "../service/mail.service.js";
import { resendAccessRule } from "../service/resend-access.js";
import { EmailLogEntryNotFoundError, MailSendError, SmtpNotConfiguredError } from "../service/mail.service.js";
import type { PurchaseService } from "../../purchase/service/purchase.service.js";
import type { SalesService } from "../../sales/service/sales.service.js";
import type { InvoiceService } from "../../sales/service/invoice.service.js";
import {
  InquiryNotFoundError,
  InvalidStatusTransitionError as PurchaseInvalidStatusTransitionError,
  PurchaseOrderNotFoundError,
} from "../../purchase/service/purchase.service.js";
import {
  InvalidStatusTransitionError as SalesInvalidStatusTransitionError,
  SalesOrderNotFoundError,
} from "../../sales/service/sales.service.js";
import { InvoiceNotFoundError, NothingToRemindError } from "../../sales/service/invoice.service.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run. The email log is readable by any logged-in
// user (the document cards show their own send history); the test mail
// button lives on the admin-only settings page.
export async function mailRoutes(
  app: FastifyInstance,
  opts: {
    service: MailService;
    purchaseService: PurchaseService;
    salesService: SalesService;
    invoiceService: InvoiceService;
  }
) {
  const { service, purchaseService, salesService, invoiceService } = opts;

  function mailError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (
      err instanceof EmailLogEntryNotFoundError ||
      err instanceof InquiryNotFoundError ||
      err instanceof PurchaseOrderNotFoundError ||
      err instanceof SalesOrderNotFoundError
    ) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    // Old email_log rows with documentType "invoice" point at a sales order
    // id (pre-C1 stamped orders never had a real invoice row) — surface that
    // distinctly instead of the generic invoice-not-found message.
    if (err instanceof InvoiceNotFoundError) {
      return reply
        .code(404)
        .send({ error: "Fakturan finns inte — äldre fakturor är stämplade på kundordern och kan inte skickas om härifrån" });
    }
    if (
      err instanceof SmtpNotConfiguredError ||
      err instanceof PurchaseInvalidStatusTransitionError ||
      err instanceof SalesInvalidStatusTransitionError ||
      // Resending a påminnelse for an invoice that has since been settled.
      err instanceof NothingToRemindError
    ) {
      return reply.code(409).send({ error: (err as Error).message });
    }
    if (err instanceof MailSendError) return reply.code(502).send(errorBody(err));
    throw err;
  }

  app.get("/email-log", async (req) => service.listEmailLog(listEmailLogQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/email-log/csv",
    querySchema: listEmailLogQuerySchema,
    filenameBase: "e-postlogg",
    columns: emailLogExportColumns,
    fetch: (query) => service.listEmailLog(query),
  });

  // Re-runs the original document send with the logged recipient/subject/
  // message against the document's CURRENT data — this is for failed sends,
  // so regenerating the PDF is exactly what the user wants.
  app.post<{ Params: { id: string } }>("/email-log/:id/resend", async (req, reply) => {
    try {
      const entry = await service.getEmailLogEntry(req.params.id);
      // The module rule let in Inköp OR Försäljning; the document type
      // decides which of them may re-run this particular send.
      if (!satisfiesRule(req.user!, resendAccessRule(entry.documentType))) {
        return reply.code(403).send(errorBody(new ForbiddenError()));
      }
      const input = {
        to: entry.recipient,
        subject: entry.subject,
        message: entry.message,
        attachDrawings: entry.attachDrawings,
      };
      switch (entry.documentType) {
        case "inquiry":
          return await purchaseService.sendInquiryEmail(entry.documentId!, input);
        case "purchase_order":
          return await purchaseService.sendPurchaseOrderEmail(entry.documentId!, input);
        // Visa tilläggspriser is replayed as logged (undefined on old rows ⇒
        // the customer's current setting, as a fresh send would).
        case "quote":
          return await salesService.sendSalesOrderEmail(entry.documentId!, {
            ...input,
            variant: "quote",
            showConfigurationPrices: entry.showConfigurationPrices ?? undefined,
          });
        case "order_confirmation":
          return await salesService.sendSalesOrderEmail(entry.documentId!, {
            ...input,
            variant: "confirmation",
            showConfigurationPrices: entry.showConfigurationPrices ?? undefined,
          });
        case "invoice":
          return await invoiceService.sendEmail(entry.documentId!, input);
        // Betalningspåminnelse (B3): resending re-runs the whole reminder
        // routine against the invoice's CURRENT state — including a fresh
        // level and a new invoice_reminders row, which is exactly right for
        // the failed send this button exists for (that attempt persisted
        // nothing). ALWAYS fee-free: the påminnelseavgift can only be charged
        // once and must be an explicit choice on the invoice card, never a
        // side effect of pressing "Skicka om".
        case "payment_reminder":
          return await invoiceService.sendReminder(entry.documentId!, { ...input, withFee: false }, req.user!.id);
        case "test":
          return await service.sendTestMail(entry.recipient);
      }
    } catch (err) {
      return mailError(err, reply);
    }
  });

  app.post("/mail/test", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = sendTestEmailSchema.parse(req.body);
    try {
      return await service.sendTestMail(input.to);
    } catch (err) {
      return mailError(err, reply);
    }
  });
}
