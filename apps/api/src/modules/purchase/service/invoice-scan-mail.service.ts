import { createHash } from "node:crypto";
import type { InvoiceScanMailOutcome, ListInvoiceScanMailLogQuery, TestInvoiceScanMailInput } from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { InvoiceScanRepository, InvoiceScanRow } from "../repository/invoice-scan.repository.js";
import type { InvoiceScanService } from "./invoice-scan.service.js";
import type { InvoiceScanSettings, InvoiceScanSettingsService } from "./invoice-scan-settings.service.js";
import { imapflowMailboxFactory } from "./invoice-scan/imapflow-mailbox.js";
import {
  InvoiceMailboxError,
  mailboxErrorText,
  type InvoiceMailbox,
  type InvoiceMailboxConfig,
  type InvoiceMailboxErrorKind,
  type InvoiceMailboxFactory,
  type MailboxMessageRef,
} from "./invoice-scan/invoice-mailbox.js";
import { parseInvoiceMail, type ParsedInvoiceMail } from "./invoice-scan/mail-mime.js";
import { MAIL_SKIP_TEXTS, mailOutcome, messageIdKey, selectMailAttachments, syntheticMessageId } from "./invoice-scan/mail-selection.js";

// Fakturaskanning — the e-mail box (spec §4). The job `invoice_scan_mail`
// runs from server.ts's job list only (never from buildApp), under the lease
// invoice_scan_mail_lease_until, every invoice_scan_mail_interval_minutes
// while the box is turned on. Per letter, in an order that makes the job
// idempotent without a transaction over the network:
//   1. fetch the letter (IMAP, outside any transaction),
//   2. choose the attachments (mail-selection.ts),
//   3. ONE transaction: each chosen attachment as a scan (ON CONFLICT on the
//      (Message-ID, attachment index) key; a live duplicate on sha256 is
//      skipped) and the letter's row in Senast lästa brev,
//   4. move the letter to the processed folder — when that fails the letter
//      is read again next run and the key stops a second scan,
//   5. the rules per new scan, then automatic AI (avsändarregeln inside
//      automaticAi), never in a transaction.
// A failure of the mailbox itself goes to invoice_scan_mail_last_error as
// Swedish text (never err.message) and raises the alert
// invoice_scan_mail_failed; the next run tries again. The password is never
// logged.

export const MAIL_LEASE_MS = 10 * 60_000;
// Letters per run; the rest wait for the next run.
export const MAIL_MAX_LETTERS = 50;
// A letter larger than this is not fetched at all (20 MB attachments, base64
// and a few of them): logged as too_large and moved.
export const MAIL_MAX_MESSAGE_BYTES = 60 * 1024 * 1024;

// The scheduler ticks every minute; a small margin keeps a run from slipping
// a whole tick per round.
export function isMailDue(lastRunAt: Date | null, intervalMinutes: number, now: Date): boolean {
  if (lastRunAt === null) return true;
  const intervalMs = intervalMinutes * 60_000;
  const margin = Math.min(30_000, intervalMs / 2);
  return now.getTime() - lastRunAt.getTime() >= intervalMs - margin;
}

// Testa anslutning (e-postlådan) failed — the message is the Swedish text the
// page shows. 409.
export class InvoiceScanMailTestFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceScanMailTestFailedError";
  }
}

// The kinds that mean the connection itself is gone: the run stops.
const FATAL_KINDS = new Set<InvoiceMailboxErrorKind>(["connection", "timeout", "tls", "auth", "not_configured"]);

function asMailboxError(err: unknown): InvoiceMailboxError {
  return err instanceof InvoiceMailboxError ? err : new InvoiceMailboxError("unexpected", (err as Error)?.name ?? null);
}

function mailboxConfig(s: {
  mailHost: string | null;
  mailPort: number;
  mailTls: boolean;
  mailUser: string | null;
  mailPassword: string | null;
  mailFolder: string;
  mailProcessedFolder: string;
}): InvoiceMailboxConfig | null {
  if (!s.mailHost || !s.mailUser || !s.mailPassword) return null;
  return {
    host: s.mailHost,
    port: s.mailPort,
    tls: s.mailTls,
    user: s.mailUser,
    password: s.mailPassword,
    folder: s.mailFolder,
    processedFolder: s.mailProcessedFolder,
  };
}

const LETTER_TEXTS = {
  noAttachments: "Brevet har inga bilagor",
  unreadable: "Brevet kunde inte läsas (felaktigt format)",
  fetchFailed: "Brevet kunde inte hämtas från e-postservern",
  tooLargeLetter: "Brevet är större än 60 MB och lästes inte",
};

export interface MailRunResult {
  letters: number;
  // The scans created by this run.
  scanIds: string[];
  // Letters that could not be moved to the processed folder.
  moveFailed: number;
}

export function createInvoiceScanMailService(deps: {
  repo: InvoiceScanRepository;
  settings: Pick<InvoiceScanSettingsService, "read">;
  scans: Pick<InvoiceScanService, "interpretReceived" | "automaticAi">;
  // The mailbox (imapflow by default, a fake in tests).
  mailboxes?: InvoiceMailboxFactory;
  audit?: AuditWriter;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo, settings, scans } = deps;
  const mailboxes = deps.mailboxes ?? imapflowMailboxFactory;
  const audit = deps.audit ?? { log: async () => {} };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  type LetterLog = {
    messageId: string | null;
    emailFrom: string | null;
    emailSubject: string | null;
    receivedAt: Date | null;
    outcome: InvoiceScanMailOutcome;
    detail: string | null;
  };

  async function writeLog(row: LetterLog) {
    await repo.transaction((tx) => repo.insertMailLogInTx(tx, { ...row, scanIds: [] }));
  }

  // Step 3: the letter's scans and its log row in ONE transaction.
  async function importLetter(mail: ParsedInvoiceMail): Promise<InvoiceScanRow[]> {
    const selection = selectMailAttachments(mail.attachments);
    const messageId = mail.messageId
      ? messageIdKey(mail.messageId)
      : syntheticMessageId({ from: mail.from, date: mail.date, subject: mail.subject, attachments: mail.attachments.map((a) => a.content) });
    return repo.transaction(async (tx) => {
      const created: InvoiceScanRow[] = [];
      let duplicates = 0;
      const lines: { index: number; text: string }[] = [];
      for (const attachment of selection.selected) {
        const sha256 = createHash("sha256").update(attachment.content).digest("hex");
        const outcome = await repo.insertScanInTx(tx, {
          source: "email",
          filename: attachment.filename,
          contentType: attachment.contentType,
          sizeBytes: attachment.content.length,
          sha256,
          data: attachment.content,
          uploadedBy: null,
          email: {
            messageId,
            attachmentIndex: attachment.index,
            from: mail.from,
            subject: mail.subject,
            receivedAt: mail.date,
          },
        });
        if (outcome.ok) {
          created.push(outcome.scan);
          lines.push({ index: attachment.index, text: `${attachment.filename} → ${outcome.scan.scanNumber}` });
        } else {
          duplicates++;
          const text =
            outcome.reason === "already_imported"
              ? `${attachment.filename} är redan inläst (${outcome.existing.scanNumber})`
              : `${attachment.filename} fanns redan i inkorgen (${outcome.existing.scanNumber})`;
          lines.push({ index: attachment.index, text });
        }
      }
      for (const skipped of selection.skipped) {
        lines.push({ index: skipped.index, text: `${skipped.filename}: ${MAIL_SKIP_TEXTS[skipped.reason]}` });
      }
      lines.sort((a, b) => a.index - b.index);
      await repo.insertMailLogInTx(tx, {
        messageId,
        emailFrom: mail.from,
        emailSubject: mail.subject,
        receivedAt: mail.date,
        outcome: mailOutcome({ created: created.length, duplicates, skipped: selection.skipped }),
        detail: lines.length > 0 ? lines.map((l) => l.text).join("; ") : LETTER_TEXTS.noAttachments,
        scanIds: created.map((s) => s.id),
      });
      return created;
    });
  }

  // Step 4. false when the letter stays (read again next run); a lost
  // connection stops the run.
  async function move(mailbox: InvoiceMailbox, uid: number): Promise<boolean> {
    try {
      await mailbox.moveToProcessed(uid);
      return true;
    } catch (err) {
      const e = asMailboxError(err);
      if (FATAL_KINDS.has(e.kind)) throw e;
      log("invoice scan mail: could not move a letter", { uid, kind: e.kind, detail: e.detail });
      return false;
    }
  }

  // One letter, steps 1–5. Returns the new scans and whether it was moved.
  async function processLetter(mailbox: InvoiceMailbox, ref: MailboxMessageRef): Promise<{ created: InvoiceScanRow[]; moved: boolean }> {
    const blank = { messageId: null, emailFrom: null, emailSubject: null, receivedAt: null };
    if (ref.size !== null && ref.size > MAIL_MAX_MESSAGE_BYTES) {
      await writeLog({ ...blank, outcome: "too_large", detail: LETTER_TEXTS.tooLargeLetter });
      return { created: [], moved: await move(mailbox, ref.uid) };
    }

    let source: Buffer;
    try {
      source = await mailbox.fetch(ref.uid);
    } catch (err) {
      const e = asMailboxError(err);
      if (FATAL_KINDS.has(e.kind)) throw e;
      log("invoice scan mail: could not fetch a letter", { uid: ref.uid, kind: e.kind, detail: e.detail });
      await writeLog({ ...blank, outcome: "error", detail: LETTER_TEXTS.fetchFailed });
      return { created: [], moved: false };
    }

    let mail: ParsedInvoiceMail;
    try {
      mail = await parseInvoiceMail(source);
    } catch (err) {
      log("invoice scan mail: could not parse a letter", { uid: ref.uid, error: (err as Error)?.name });
      await writeLog({ ...blank, outcome: "error", detail: LETTER_TEXTS.unreadable });
      return { created: [], moved: await move(mailbox, ref.uid) };
    }

    const created = await importLetter(mail);
    for (const scan of created) {
      await audit.log({
        entityType: "invoice_scan",
        entityId: scan.scanNumber,
        action: "received",
        detail: { source: "email", filename: scan.filename, sizeBytes: scan.sizeBytes, sha256: scan.sha256, from: mail.from, subject: mail.subject },
        userId: null,
      });
    }
    const moved = await move(mailbox, ref.uid);
    if (created.length > 0) {
      const ids = created.map((s) => s.id);
      await scans.interpretReceived(ids);
      // Queued one scan at a time in this process; the run does not wait.
      void scans.automaticAi(ids);
    }
    return { created, moved };
  }

  async function runMail(config: InvoiceMailboxConfig): Promise<MailRunResult> {
    const mailbox = mailboxes(config);
    const result: MailRunResult = { letters: 0, scanIds: [], moveFailed: 0 };
    try {
      await mailbox.connect();
      const refs = await mailbox.listUnprocessed(MAIL_MAX_LETTERS);
      for (const ref of refs) {
        const letter = await processLetter(mailbox, ref);
        result.letters++;
        result.scanIds.push(...letter.created.map((s) => s.id));
        if (!letter.moved) result.moveFailed++;
      }
      return result;
    } finally {
      await mailbox.close().catch(() => {});
    }
  }

  // The scheduler's entry point. The run stamp is written AFTER the run
  // (also after a failure, so the interval holds); an API that dies mid-run
  // lets the lease expire and the next tick runs again.
  async function runMailIfDue(): Promise<"disabled" | "not-due" | "busy" | (MailRunResult & { error: string | null })> {
    const s: InvoiceScanSettings = await settings.read();
    if (!s.mailEnabled) return "disabled";
    const at = now();
    if (!isMailDue(s.mailLastRunAt, s.mailIntervalMinutes, at)) return "not-due";
    const lease = await repo.claimMailLease(at, MAIL_LEASE_MS);
    if (!lease) return "busy";
    try {
      const config = mailboxConfig(s);
      let result: MailRunResult = { letters: 0, scanIds: [], moveFailed: 0 };
      let error: string | null = null;
      if (!config) {
        error = mailboxErrorText("not_configured");
      } else {
        try {
          result = await runMail(config);
          if (result.moveFailed > 0) error = mailboxErrorText("move_failed", config);
        } catch (err) {
          const e = asMailboxError(err);
          // Never err.message: it may carry the server's answer.
          log("invoice scan mail: run failed", { kind: e.kind, detail: e.detail });
          error = mailboxErrorText(e.kind, config);
        }
      }
      await repo.stampMailRun(at, error);
      return { ...result, error };
    } finally {
      // Owner-checked: releases only the lease this run claimed.
      await repo.releaseMailLease(lease);
    }
  }

  return {
    runMail,
    runMailIfDue,

    // Testa anslutning: logs in with the form's fields (each omitted one is
    // the saved value), checks the folder, counts its unseen letters and
    // whether the processed folder exists. Saves nothing, creates nothing.
    async testMail(input: TestInvoiceScanMailInput = {}) {
      const saved = await settings.read();
      const pick = <T>(value: T | undefined, fallback: T) => (value === undefined ? fallback : value);
      const blankToNull = (v: string | null) => (v && v.trim() !== "" ? v.trim() : null);
      const config = mailboxConfig({
        mailHost: blankToNull(pick(input.mailHost, saved.mailHost)),
        mailPort: pick(input.mailPort, saved.mailPort),
        mailTls: pick(input.mailTls, saved.mailTls),
        mailUser: blankToNull(pick(input.mailUser, saved.mailUser)),
        mailPassword: input.mailPassword && input.mailPassword !== "" ? input.mailPassword : saved.mailPassword,
        mailFolder: pick(input.mailFolder, saved.mailFolder),
        mailProcessedFolder: pick(input.mailProcessedFolder, saved.mailProcessedFolder),
      });
      if (!config) throw new InvoiceScanMailTestFailedError(mailboxErrorText("not_configured"));
      try {
        const inspected = await mailboxes(config).inspect();
        return { ok: true as const, unseen: inspected.unseen, processedFolderExists: inspected.processedFolderExists };
      } catch (err) {
        const e = asMailboxError(err);
        log("invoice scan mail: connection test failed", { kind: e.kind, detail: e.detail });
        throw new InvoiceScanMailTestFailedError(mailboxErrorText(e.kind, config));
      }
    },

    // Senast lästa brev.
    async mailLog(query: ListInvoiceScanMailLogQuery) {
      return { rows: await repo.listMailLog(query.limit) };
    },
  };
}

export type InvoiceScanMailService = ReturnType<typeof createInvoiceScanMailService>;

// app.ts decorates the Fastify instance so server.ts can hand the job to the
// scheduler without rebuilding the dependency graph.
declare module "fastify" {
  interface FastifyInstance {
    invoiceScanMail: InvoiceScanMailService;
  }
}
