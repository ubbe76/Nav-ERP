import nodemailer from "nodemailer";
import type { EmailDocumentType, ListEmailLogQuery } from "@navet/shared";
import type { SmtpConfig, SystemService } from "../../system/service/system.service.js";
import type { MailRepository } from "../repository/mail.repository.js";

export class SmtpNotConfiguredError extends Error {
  constructor() {
    super("SMTP is not configured — set the mail server under Systeminställningar");
    this.name = "SmtpNotConfiguredError";
  }
}

export class MailSendError extends Error {
  constructor(cause: string) {
    super(`Email could not be sent: ${cause}`);
    this.name = "MailSendError";
  }
}

export class EmailLogEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`Email log entry ${id} not found`);
    this.name = "EmailLogEntryNotFoundError";
  }
}

export interface OutgoingMail {
  documentType: EmailDocumentType;
  documentId: string | null;
  to: string;
  subject: string;
  message: string;
  // The document PDF first, then any article drawings.
  attachments?: { filename: string; content: Buffer }[];
  attachDrawings?: boolean;
  // Konfigurator 4b: Visa tilläggspriser as resolved for THIS send (quote/
  // order confirmation only) — logged so Skicka om renders the same
  // attachment. Omitted/null = not applicable to the document type.
  showConfigurationPrices?: boolean | null;
}

// Minimal slice of nodemailer's Transporter — lets tests inject a fake
// transport instead of talking SMTP.
export interface MailTransport {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    text: string;
    attachments?: { filename: string; content: Buffer }[];
  }): Promise<unknown>;
}

export type MailTransportFactory = (config: SmtpConfig) => MailTransport;

// A fresh transport per send — SMTP settings can change at runtime and
// document email volumes are far too small for pooling to matter.
const nodemailerTransportFactory: MailTransportFactory = (config) =>
  nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
  });

export function createMailService(
  repo: MailRepository,
  system: Pick<SystemService, "getSmtpConfig">,
  transportFactory: MailTransportFactory = nodemailerTransportFactory
) {
  return {
    // Sends one email and logs the attempt. Throws on failure (after logging)
    // so callers can skip their status transition when nothing went out.
    async sendMail(mail: OutgoingMail) {
      const config = await system.getSmtpConfig();
      if (!config) throw new SmtpNotConfiguredError();

      const fromEmail = config.fromEmail || config.user;
      const from = config.fromName ? `"${config.fromName.replace(/"/g, "")}" <${fromEmail}>` : fromEmail;
      const transport = transportFactory(config);

      try {
        await transport.sendMail({
          from,
          to: mail.to,
          subject: mail.subject,
          text: mail.message,
          attachments: mail.attachments && mail.attachments.length > 0 ? mail.attachments : undefined,
        });
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        await repo.logEmail({
          documentType: mail.documentType,
          documentId: mail.documentId,
          recipient: mail.to,
          subject: mail.subject,
          message: mail.message,
          attachDrawings: mail.attachDrawings ?? false,
          showConfigurationPrices: mail.showConfigurationPrices ?? null,
          status: "failed",
          error: cause,
        });
        throw new MailSendError(cause);
      }

      return repo.logEmail({
        documentType: mail.documentType,
        documentId: mail.documentId,
        recipient: mail.to,
        subject: mail.subject,
        message: mail.message,
        attachDrawings: mail.attachDrawings ?? false,
        showConfigurationPrices: mail.showConfigurationPrices ?? null,
        status: "sent",
        error: null,
      });
    },

    async sendTestMail(to: string) {
      return this.sendMail({
        documentType: "test",
        documentId: null,
        to,
        subject: "Testmejl från Nav-ERP",
        message: "SMTP-inställningarna fungerar — det här är ett testmejl från Nav-ERP.",
      });
    },

    async listEmailLog(query: ListEmailLogQuery) {
      return repo.listEmailLog(query);
    },

    async getEmailLogEntry(id: string) {
      const row = await repo.findById(id);
      if (!row) throw new EmailLogEntryNotFoundError(id);
      return row;
    },
  };
}

export type MailService = ReturnType<typeof createMailService>;
