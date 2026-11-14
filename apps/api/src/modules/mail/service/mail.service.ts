import nodemailer from "nodemailer";
import type { EmailDocumentType, ListEmailLogQuery, MailTemplateLanguage } from "@navet/shared";
import type { SmtpConfig, SystemService } from "../../system/service/system.service.js";
import type { MailRepository } from "../repository/mail.repository.js";
import { SIGNATURE_LOGO_CID, signMail, type MailSignatureService } from "./mail-signature.js";

export class SmtpNotConfiguredError extends Error {
  constructor() {
    super("SMTP is not configured — set the mail server under Systeminställningar");
    this.name = "SmtpNotConfiguredError";
  }
}

export class MailSendError extends Error {
  // The failed email_log row — the attempt is logged before the throw, so a
  // caller that keeps its own log (the alert digest's run row) can point at it.
  readonly emailLogId: string | null;
  constructor(cause: string, emailLogId: string | null = null) {
    super(`Email could not be sent: ${cause}`);
    this.name = "MailSendError";
    this.emailLogId = emailLogId;
  }
}

export class EmailLogEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`Email log entry ${id} not found`);
    this.name = "EmailLogEntryNotFoundError";
  }
}

// The copy as sent: trimmed, without duplicates (case-insensitive) and
// without the recipient itself.
export function normalizeCc(cc: string[] | undefined, to: string): string[] {
  const seen = new Set([to.trim().toLowerCase()]);
  const result: string[] = [];
  for (const raw of cc ?? []) {
    const address = raw.trim();
    const key = address.toLowerCase();
    if (!address || seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

// E-postsignatur: who sends a document mail, and in which language (the
// document's — the signature's labels follow it).
export interface MailSender {
  userId: string;
  language: MailTemplateLanguage;
}

// The sender of a send, or null when no user is behind it.
export function mailSender(userId: string | null | undefined, language: MailTemplateLanguage): MailSender | null {
  return userId ? { userId, language } : null;
}

export interface OutgoingMail {
  documentType: EmailDocumentType;
  documentId: string | null;
  to: string;
  // Kopia (inquiry / purchase order): sent as Cc and logged so Skicka om
  // sends the same copy. Omitted/empty = none.
  cc?: string[];
  subject: string;
  // The plain-text body — what email_log keeps and what Skicka om replays.
  message: string;
  // An HTML alternative of the same content (the alert digest); the text
  // part is always sent with it, so a plain-text client reads the same.
  html?: string;
  // The document PDF first, then any article drawings.
  attachments?: { filename: string; content: Buffer }[];
  attachDrawings?: boolean;
  // Konfigurator 4b: Visa tilläggspriser as resolved for THIS send (quote/
  // order confirmation only) — logged so Skicka om renders the same
  // attachment. Omitted/null = not applicable to the document type.
  showConfigurationPrices?: boolean | null;
  // Avvikelser: the reklamationsrapport's Orsaksanalys/Åtgärd/Beslut choice —
  // logged so Skicka om renders the same attachment. Null = not applicable.
  includeDetails?: boolean | null;
  // The user the mail is from (email_log.sender_id): their E-postsignatur,
  // when switched on, goes under the message — the mail then gets an HTML
  // part with the company logo inline. Omitted/null = a mail no user sends
  // (the test mail, the digest), without a signature.
  sender?: MailSender | null;
}

// Minimal slice of nodemailer's Transporter — lets tests inject a fake
// transport instead of talking SMTP.
export interface MailTransport {
  sendMail(opts: {
    from: string;
    to: string;
    cc?: string[];
    subject: string;
    text: string;
    html?: string;
    // cid/contentType: the signature's inline logo (referenced as cid: in
    // the HTML part).
    attachments?: { filename: string; content: Buffer; cid?: string; contentType?: string }[];
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
  transportFactory: MailTransportFactory = nodemailerTransportFactory,
  signatures: Pick<MailSignatureService, "forSending"> | null = null
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
      const cc = normalizeCc(mail.cc, mail.to);
      const senderId = mail.sender?.userId ?? null;
      // The sender's signature (only for a mail without its own HTML part).
      const signature =
        mail.sender && signatures && mail.html === undefined
          ? await signatures.forSending(mail.sender.userId, mail.sender.language)
          : null;
      const signed = signature ? signMail(mail.message, signature) : null;
      const attachments: { filename: string; content: Buffer; cid?: string; contentType?: string }[] = [
        ...(mail.attachments ?? []),
      ];
      if (signed?.logo) {
        attachments.push({
          filename: signed.logo.filename,
          content: signed.logo.content,
          cid: SIGNATURE_LOGO_CID,
          contentType: signed.logo.contentType,
        });
      }

      try {
        await transport.sendMail({
          from,
          to: mail.to,
          cc: cc.length > 0 ? cc : undefined,
          subject: mail.subject,
          text: signed ? signed.text : mail.message,
          html: signed ? signed.html : mail.html,
          attachments: attachments.length > 0 ? attachments : undefined,
        });
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        const failed = await repo.logEmail({
          documentType: mail.documentType,
          documentId: mail.documentId,
          recipient: mail.to,
          cc,
          subject: mail.subject,
          message: mail.message,
          attachDrawings: mail.attachDrawings ?? false,
          showConfigurationPrices: mail.showConfigurationPrices ?? null,
          includeDetails: mail.includeDetails ?? null,
          senderId,
          status: "failed",
          error: cause,
        });
        throw new MailSendError(cause, failed.id);
      }

      return repo.logEmail({
        documentType: mail.documentType,
        documentId: mail.documentId,
        recipient: mail.to,
        cc,
        subject: mail.subject,
        message: mail.message,
        attachDrawings: mail.attachDrawings ?? false,
        showConfigurationPrices: mail.showConfigurationPrices ?? null,
        includeDetails: mail.includeDetails ?? null,
        senderId,
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
