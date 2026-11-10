import { createHash } from "node:crypto";
import type { EinvoiceReceiveResult, EinvoiceReceptionLogRow, EinvoiceReceptionOutcome } from "@navet/shared";
import { renderEInvoiceCopy } from "../../mail/service/einvoice-copy-pdf.js";
import {
  safeAttachmentContentType,
  type EInvoiceAttachmentMeta,
  type EInvoiceOriginalInfo,
  type EInvoiceOriginalReader,
  type EInvoiceOriginalView,
  type InvoiceScanEInvoiceImporter,
} from "../../purchase/service/invoice-scan/einvoice-original.js";
import { RECEIVE_ATTACHMENT_MAX_BYTES_TEXT } from "../../purchase/service/invoice-scan/einvoice-texts.js";
import { hasSignature } from "../../purchase/service/invoice-scan/file-signature.js";
import { InvalidStatusTransitionError } from "../../purchase/service/purchase.service.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { EinvoiceRepository, ReceptionInsert, ReceptionRow } from "../repository/einvoice.repository.js";
import { EInvoiceProviderError, type EInvoiceProvider, type ReceivedDocumentRef } from "./einvoice-provider.js";
import type { EinvoiceSettingsService } from "./einvoice-settings.service.js";
import { EinvoiceNotConfiguredError, EinvoiceOtherEnvironmentError, EinvoiceReceiveBusyError, EinvoiceReceptionNotFoundError } from "./einvoice.errors.js";
import type { ReceivedEInvoice, ReceivedEInvoiceAttachment } from "./ubl/received-einvoice.js";
import { looksLikeUblInvoice, readUblInvoice, UblReadError } from "./ubl/ubl-reader.js";

// Mottagning (spec 2026-11-05-e-faktura-mottagning): the job
// `einvoice_receive` (server.ts's job list only, never buildApp) pulls the
// unacknowledged received documents at the access point and turns each
// into a post in the Fakturainkorg. Per document, in an order that makes
// the job idempotent without a transaction over the network:
//   0. the log is checked first: a document read in by a run whose ack
//      failed is only acknowledged again (and interpreted, if the crash
//      came between commit and interpretation); one logged `unreadable` is
//      skipped by the scheduled runs and retried by Hämta nu;
//   1. the original (bytes exactly as served) and, when it is not UBL, the
//      access point's BIS3 rendering are fetched and read with the pure
//      ubl-reader — outside any transaction;
//   2. the PDF is chosen: the first embedded application/pdf, or Nav's
//      visningskopia when there is none (or it is too large / not a PDF);
//   3. ONE transaction: the reception row (ON CONFLICT (environment,
//      provider_invoice_id) DO NOTHING ⇒ already read in) + the inbox post
//      through the purchase module's importer + the link between them;
//   4. after commit: the audit entry, the ack at the access point, then
//      the interpretation into the post's result (interpretEInvoices).
// ONE BAD DOCUMENT NEVER STOPS THE QUEUE: anything but a transport failure
// (EInvoiceProviderError unavailable/unauthorized) is this document's own
// business — it is logged `unreadable` with a Swedish detail and the run
// goes on. The listing is paginated under the lease (renewed per page) and
// a time budget; acknowledged documents leave the listing, so the next
// page starts after those that stayed. Failures become
// einvoice_receive_last_error as Swedish text (never err.message) and the
// alert einvoice_receive_failed.

export const RECEIVE_LEASE_MS = 10 * 60_000;
// A run stops taking new pages after this long (the lease is renewed per
// page, but a run never goes on for ever); the next run takes the rest.
export const RECEIVE_RUN_BUDGET_MS = 8 * 60_000;
// Documents per listing page (B2Brouter caps at 500).
export const RECEIVE_PAGE_SIZE = 100;
// An embedded PDF larger than the inbox's file cap is left in the XML and
// the visningskopia takes its place as the post's file.
export const RECEIVE_ATTACHMENT_MAX_BYTES = RECEIVE_ATTACHMENT_MAX_BYTES_TEXT.limit;

export const RECEIVE_TEXTS = {
  unreadable: "Kunde inte läsas — öppna i B2Brouter",
  unexpected: "Oväntat fel när e-fakturan lästes in",
  noUbl: "B2Brouter har ingen UBL-version av dokumentet",
  attachmentTooLarge: RECEIVE_ATTACHMENT_MAX_BYTES_TEXT.text,
  attachmentNotPdf: "Bilagan var ingen PDF och finns kvar i e-fakturan",
  ackFailed: (n: number) => `${n} dokument kunde inte kvitteras hos B2Brouter — ${n === 1 ? "det" : "de"} hämtas igen vid nästa körning`,
  dismissed: "Markerad som hanterad",
  // The embedded PDF is a file another e-invoice's post already has (the
  // supplier's terms attached to every invoice, say): this document gets the
  // copy as its file instead of being thrown away as a duplicate.
  sharedPdf: (scanNumber: string) => `Den bifogade PDF:en finns redan i inkorgen (${scanNumber}) för en annan e-faktura — visningskopian används`,
} as const;

// The scheduler ticks every 5 minutes; a margin keeps a run from slipping
// one tick per round. Capped at half the interval so 5 minutes still waits.
export function isReceiveDue(lastRunAt: Date | null, intervalMinutes: number, now: Date): boolean {
  if (lastRunAt === null) return true;
  const intervalMs = intervalMinutes * 60_000;
  const margin = Math.min(2.5 * 60_000, intervalMs / 2);
  return now.getTime() - lastRunAt.getTime() >= intervalMs - margin;
}

export interface ReceiveRunResult extends EinvoiceReceiveResult {
  listed: number;
  // Documents already read in by an earlier run (acknowledged again).
  alreadyImported: number;
  // Unreadable documents the scheduled run left alone.
  skipped: number;
  ackFailed: number;
  // The run stopped before the listing was done (budget or lease lost).
  stoppedEarly: boolean;
  error: string | null;
  // The provider error that stopped the run (Hämta nu answers with it).
  thrown?: EInvoiceProviderError;
}

const emptyRun = (): ReceiveRunResult => ({
  listed: 0,
  imported: 0,
  duplicates: 0,
  unreadable: 0,
  alreadyImported: 0,
  skipped: 0,
  ackFailed: 0,
  stoppedEarly: false,
  error: null,
});

// What the reader made of a document: the UBL (from the original or the
// access point's BIS3 rendering) or the Swedish reason it could not be read.
type Reading =
  | { ok: true; einvoice: ReceivedEInvoice; interpretationXml: Buffer | null }
  | { ok: false; reason: string };

const endpointOf = (doc: ReceivedEInvoice): string | null =>
  doc.seller.endpoint ? `${doc.seller.endpoint.scheme ? `${doc.seller.endpoint.scheme}:` : ""}${doc.seller.endpoint.value}` : null;

// The first application/pdf attachment, else null.
export function pickPdfAttachment(attachments: ReceivedEInvoiceAttachment[]): ReceivedEInvoiceAttachment | null {
  return attachments.find((a) => a.mimeCode === "application/pdf") ?? null;
}

// The attachment list as the reception row stores it (never the bytes).
export function attachmentMeta(attachments: ReceivedEInvoiceAttachment[]): EInvoiceAttachmentMeta[] {
  return attachments.map((a) => ({
    index: a.index,
    filename: a.filename?.slice(0, 255) ?? null,
    contentType: safeAttachmentContentType(a.mimeCode),
    sizeBytes: a.sizeBytes,
  }));
}

const isTransportFailure = (err: unknown): err is EInvoiceProviderError =>
  err instanceof EInvoiceProviderError && (err.kind === "unavailable" || err.kind === "unauthorized");

const safeFilename = (name: string) => name.replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 120) || "e-faktura";

type RunMode = { retryUnreadable: boolean; lease?: { until: string } };

export function createEinvoiceReceiveService(deps: {
  repo: EinvoiceRepository;
  settings: EinvoiceSettingsService;
  scans: InvoiceScanEInvoiceImporter;
  audit?: AuditWriter;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  // The visningskopia renderer (pdfkit by default; tests may inject).
  renderCopy?: typeof renderEInvoiceCopy;
}) {
  const { repo, settings, scans } = deps;
  const audit = deps.audit ?? { log: async () => {} };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));
  const renderCopy = deps.renderCopy ?? renderEInvoiceCopy;

  function readWith(original: Buffer, ubl: Buffer | null): Reading {
    try {
      const einvoice = readUblInvoice(ubl ?? original);
      return { ok: true, einvoice, interpretationXml: ubl };
    } catch (err) {
      if (err instanceof UblReadError) return { ok: false, reason: err.message };
      throw err;
    }
  }

  // The original when it is UBL; otherwise the access point's BIS3
  // rendering. Transport failures propagate (the run stops); a document
  // the access point cannot render is unreadable.
  async function readDocument(provider: EInvoiceProvider, providerInvoiceId: string, original: Buffer): Promise<Reading> {
    if (looksLikeUblInvoice(original)) return readWith(original, null);
    let ubl: Buffer;
    try {
      ubl = await provider.getReceivedAsUbl(providerInvoiceId);
    } catch (err) {
      if (err instanceof EInvoiceProviderError && !isTransportFailure(err)) return { ok: false, reason: RECEIVE_TEXTS.noUbl };
      throw err;
    }
    return readWith(original, ubl);
  }

  // Step 2: the post's file and the remarks the copy (and the result) carry.
  async function chooseFile(doc: ReceivedEInvoice): Promise<{ filename: string; pdf: Buffer; remarks: string[] }> {
    const remarks: string[] = [];
    const attachment = pickPdfAttachment(doc.attachments);
    if (attachment) {
      if (attachment.sizeBytes > RECEIVE_ATTACHMENT_MAX_BYTES) remarks.push(RECEIVE_TEXTS.attachmentTooLarge);
      else {
        const content = attachment.content();
        if (hasSignature("application/pdf", content)) {
          return { filename: safeFilename(attachment.filename ?? `${doc.number}.pdf`), pdf: content, remarks };
        }
        remarks.push(RECEIVE_TEXTS.attachmentNotPdf);
      }
    }
    const pdf = await renderCopy(doc, { remarks });
    return { filename: safeFilename(`Visningskopia-${doc.number}.pdf`), pdf, remarks };
  }

  // Step 3 for a readable document: the reception row + the inbox post in
  // ONE transaction. "already" = the unique key refused the row.
  async function importDocument(
    environment: "sandbox" | "production",
    ref: ReceivedDocumentRef,
    original: { xml: Buffer; contentType: string },
    reading: Extract<Reading, { ok: true }>,
    at: Date,
    // An `unreadable` row logged by an earlier run: its identity and
    // interpretation columns are filled once now (the trigger allows that),
    // never a second row.
    existingId: string | null
  ): Promise<{ outcome: EinvoiceReceptionOutcome | "already"; receptionId: string | null; scanId: string | null; scanNumber: string | null }> {
    const doc = reading.einvoice;
    const ensureRow = async (tx: Parameters<typeof repo.insertReceptionInTx>[0], row: ReceptionInsert): Promise<string | null> => {
      if (!existingId) return repo.insertReceptionInTx(tx, row);
      await repo.fillReceptionInTx(tx, existingId, row);
      return existingId;
    };
    const base: ReceptionInsert = {
      environment,
      providerInvoiceId: ref.providerInvoiceId,
      receivedAt: at,
      documentType: doc.type,
      documentNumber: doc.number.slice(0, 100),
      issueDate: doc.issueDate,
      senderEndpoint: endpointOf(doc)?.slice(0, 80) ?? null,
      senderName: doc.seller.name.slice(0, 200),
      currency: doc.currency.slice(0, 3),
      payableAmount: doc.totals.payableAmount.toFixed(2),
      originalXml: original.xml,
      originalSha256: createHash("sha256").update(original.xml).digest("hex"),
      originalContentType: original.contentType.slice(0, 100),
      interpretationXml: reading.interpretationXml,
      attachments: attachmentMeta(doc.attachments),
      outcome: "imported",
      detail: null,
      invoiceScanId: null,
    };

    // Dubblett på avsändare + nummer: the same document sent twice (a
    // resend by the supplier) never becomes a second post. Only a document
    // with a sender endpoint is matched this way — a name is no identity.
    const live = base.senderEndpoint
      ? await repo.findLiveReceptionByDocument({
          environment,
          senderEndpoint: base.senderEndpoint,
          documentType: doc.type,
          documentNumber: base.documentNumber!,
        })
      : null;
    if (live) {
      const receptionId = await repo.transaction((tx) =>
        ensureRow(tx, {
          ...base,
          outcome: "duplicate",
          detail: `Samma ${doc.type === "credit_note" ? "kreditfaktura" : "faktura"} finns redan i inkorgen (${live.scanNumber})`,
          invoiceScanId: live.invoiceScanId,
        })
      );
      return { outcome: receptionId ? "duplicate" : "already", receptionId, scanId: live.invoiceScanId, scanNumber: live.scanNumber };
    }

    let file = await chooseFile(doc);
    let sha256 = createHash("sha256").update(file.pdf).digest("hex");
    return repo.transaction(async (tx) => {
      const receptionId = await ensureRow(tx, base);
      if (!receptionId) return { outcome: "already" as const, receptionId: null, scanId: null, scanNumber: null };
      let imported = await scans.importEInvoiceInTx(tx, { filename: file.filename, pdf: file.pdf, sha256 });
      // The same file as a post of ANOTHER e-invoice (another sender or
      // number — one attachment on every invoice): this document is no
      // duplicate, so it gets the copy as its file. The same file as a post
      // that came another way (scanned, e-mailed) or from this very
      // document stays a duplicate (user decision 2026-11-10; before, the
      // invoice was acknowledged and never reached the inbox).
      if (!imported.ok) {
        const owner = await repo.findReceptionByScan(imported.existing.id, tx);
        const sameDocument =
          owner !== null &&
          owner.documentType === doc.type &&
          owner.documentNumber === base.documentNumber &&
          (owner.senderEndpoint ?? null) === (base.senderEndpoint ?? null);
        if (owner !== null && !sameDocument) {
          const remarks = [...file.remarks, RECEIVE_TEXTS.sharedPdf(imported.existing.scanNumber)];
          file = { filename: safeFilename(`Visningskopia-${doc.number}.pdf`), pdf: await renderCopy(doc, { remarks }), remarks };
          sha256 = createHash("sha256").update(file.pdf).digest("hex");
          imported = await scans.importEInvoiceInTx(tx, { filename: file.filename, pdf: file.pdf, sha256 });
        }
      }
      if (!imported.ok) {
        await repo.updateReceptionOutcome(
          receptionId,
          { outcome: "duplicate", detail: `Filen fanns redan i inkorgen (${imported.existing.scanNumber})`, invoiceScanId: imported.existing.id },
          tx
        );
        return { outcome: "duplicate" as const, receptionId, scanId: imported.existing.id, scanNumber: imported.existing.scanNumber };
      }
      await repo.updateReceptionOutcome(receptionId, { outcome: "imported", detail: file.remarks.length > 0 ? file.remarks.join("; ") : null, invoiceScanId: imported.scan.id }, tx);
      return { outcome: "imported" as const, receptionId, scanId: imported.scan.id, scanNumber: imported.scan.scanNumber };
    });
  }

  // One unreadable document: one log row, its detail updated on every
  // later attempt (the original and its hash are frozen by the NV001
  // trigger; the identity columns are filled when it becomes readable).
  async function logUnreadable(environment: "sandbox" | "production", ref: ReceivedDocumentRef, original: { xml: Buffer; contentType: string }, reason: string, at: Date) {
    const detail = `${RECEIVE_TEXTS.unreadable}: ${reason}`.slice(0, 1000);
    const existing = await repo.findReceptionByProvider(environment, ref.providerInvoiceId);
    if (existing) {
      if (existing.detail !== detail || existing.outcome !== "unreadable") await repo.updateReceptionOutcome(existing.id, { outcome: "unreadable", detail });
      return;
    }
    await repo.transaction((tx) =>
      repo.insertReceptionInTx(tx, {
        environment,
        providerInvoiceId: ref.providerInvoiceId,
        receivedAt: at,
        documentType: null,
        documentNumber: null,
        issueDate: null,
        senderEndpoint: null,
        senderName: null,
        currency: null,
        payableAmount: null,
        originalXml: original.xml,
        originalSha256: createHash("sha256").update(original.xml).digest("hex"),
        originalContentType: original.contentType.slice(0, 100),
        interpretationXml: null,
        attachments: null,
        outcome: "unreadable",
        detail,
        invoiceScanId: null,
      })
    );
  }

  // true = the document left the listing (acknowledged, or already gone at
  // the access point); false = it stays and is listed again.
  async function acknowledge(provider: EInvoiceProvider, ref: ReceivedDocumentRef, result: ReceiveRunResult): Promise<boolean> {
    try {
      await provider.acknowledgeReceived(ref.providerInvoiceId);
      return true;
    } catch (err) {
      if (isTransportFailure(err)) throw err;
      if (err instanceof EInvoiceProviderError && err.kind === "not-found") return true;
      result.ackFailed++;
      log("e-invoice reception: ack failed", { providerInvoiceId: ref.providerInvoiceId, kind: err instanceof EInvoiceProviderError ? err.kind : (err as Error)?.name });
      return false;
    }
  }

  // Steps 0–4 for one listed document. Returns whether it left the listing.
  async function processDocument(provider: EInvoiceProvider, environment: "sandbox" | "production", ref: ReceivedDocumentRef, result: ReceiveRunResult, mode: RunMode): Promise<boolean> {
    const at = now();
    // Step 0: the log before any download.
    const earlier = await repo.findReceptionByProvider(environment, ref.providerInvoiceId);
    if (earlier && earlier.outcome !== "unreadable") {
      // Read in by a run whose ack failed (or whose process died before the
      // interpretation): ack again, interpret what is still untouched.
      result.alreadyImported++;
      if (earlier.invoiceScanId && earlier.outcome === "imported") await scans.interpretEInvoicesIfNew([earlier.invoiceScanId]);
      return acknowledge(provider, ref, result);
    }
    if (earlier && !mode.retryUnreadable) {
      result.skipped++;
      return false;
    }

    let original: { xml: Buffer; contentType: string };
    try {
      original = await provider.getReceivedOriginal(ref.providerInvoiceId);
    } catch (err) {
      if (err instanceof EInvoiceProviderError && err.kind === "not-found") return true;
      throw err;
    }

    let imported: Awaited<ReturnType<typeof importDocument>>;
    let reading: Reading;
    try {
      reading = await readDocument(provider, ref.providerInvoiceId, original.xml);
      if (!reading.ok) {
        result.unreadable++;
        await logUnreadable(environment, ref, original, reading.reason, at);
        return false;
      }
      imported = await importDocument(environment, ref, original, reading, at, earlier?.id ?? null);
    } catch (err) {
      // A transport failure stops the run; anything else is this document's
      // own problem (a value Postgres refused, a crash in the copy …): logged
      // unreadable, never the error's text, and the queue goes on.
      if (isTransportFailure(err)) throw err;
      log("e-invoice reception: document failed", { providerInvoiceId: ref.providerInvoiceId, error: (err as Error)?.name });
      result.unreadable++;
      try {
        await logUnreadable(environment, ref, original, RECEIVE_TEXTS.unexpected, at);
      } catch (logErr) {
        log("e-invoice reception: could not log the failed document", { providerInvoiceId: ref.providerInvoiceId, error: (logErr as Error)?.name });
      }
      return false;
    }

    if (imported.outcome === "already") result.alreadyImported++;
    else if (imported.outcome === "duplicate") result.duplicates++;
    else result.imported++;

    if (imported.outcome === "imported" && imported.scanId) {
      await audit.log({
        entityType: "invoice_scan",
        entityId: imported.scanNumber,
        action: "received",
        detail: {
          source: "einvoice",
          environment,
          providerInvoiceId: ref.providerInvoiceId,
          sender: reading.einvoice.seller.name,
          senderEndpoint: endpointOf(reading.einvoice),
          documentType: reading.einvoice.type,
          documentNumber: reading.einvoice.number,
        },
        userId: null,
      });
    }
    // The ack, then the interpretation — but a transport failure on the ack
    // must not leave the post uninterpreted (the run stops after it).
    let acked = false;
    let ackFailure: unknown = null;
    try {
      acked = await acknowledge(provider, ref, result);
    } catch (err) {
      ackFailure = err;
    }
    if (imported.outcome === "imported" && imported.scanId) await scans.interpretEInvoices([imported.scanId]);
    if (ackFailure) throw ackFailure;
    return acked;
  }

  // One run against the access point, page by page. Acknowledged documents
  // leave the listing, so the next page starts after the ones that stayed
  // (unreadable, skipped, ack failed). Throws EInvoiceProviderError only
  // for the transport itself (the listing or a mid-run connection loss).
  async function runReceive(mode: RunMode = { retryUnreadable: true }): Promise<ReceiveRunResult> {
    const s = await settings.read();
    const provider = await settings.provider({ requireEnabled: false, requireAccount: true });
    const result = emptyRun();
    const started = now().getTime();
    let offset = 0;
    for (;;) {
      const page = await provider.listReceived({ offset, limit: RECEIVE_PAGE_SIZE });
      if (page.documents.length === 0) break;
      result.listed += page.documents.length;
      for (const ref of page.documents) {
        const left = await processDocument(provider, s.environment, ref, result, mode);
        if (!left) offset++;
      }
      if (page.documents.length < RECEIVE_PAGE_SIZE || offset >= page.total) break;
      const at = now();
      if (at.getTime() - started >= RECEIVE_RUN_BUDGET_MS) {
        result.stoppedEarly = true;
        break;
      }
      if (mode.lease) {
        const renewed = await repo.renewReceiveLease(mode.lease.until, new Date(at.getTime() + RECEIVE_LEASE_MS));
        if (!renewed) {
          log("e-invoice reception: lease lost, the run stops", { listed: result.listed });
          result.stoppedEarly = true;
          break;
        }
        mode.lease.until = renewed;
      }
    }
    if (result.ackFailed > 0) result.error = RECEIVE_TEXTS.ackFailed(result.ackFailed);
    return result;
  }

  // The run under the lease, with the stamps: the run stamp is written
  // after the run (also after a failure, so the interval holds); a failure
  // becomes last_error as Swedish text.
  async function runLeased(lease: string, retryUnreadable: boolean): Promise<ReceiveRunResult> {
    const at = now();
    const mode: RunMode = { retryUnreadable, lease: { until: lease } };
    let result = emptyRun();
    try {
      try {
        result = await runReceive(mode);
      } catch (err) {
        if (err instanceof EInvoiceProviderError) {
          log("e-invoice reception: run failed", { kind: err.kind, requestId: err.requestId });
          result.error = err.message;
          result.thrown = err;
        } else if (err instanceof EinvoiceNotConfiguredError) {
          result.error = err.message;
        } else {
          log("e-invoice reception: run crashed", { error: (err as Error)?.name });
          result.error = "Hämtningen av e-fakturor misslyckades oväntat";
        }
      }
      await repo.stampReceiveRun(at, result.error);
      return result;
    } finally {
      // Owner-checked: releases only the lease this run (still) holds.
      await repo.releaseReceiveLease(mode.lease!.until);
    }
  }

  function logRow(r: ReceptionRow & { scanNumber?: string | null }): EinvoiceReceptionLogRow {
    return {
      id: r.id,
      environment: r.environment === "production" ? "production" : "sandbox",
      receivedAt: r.receivedAt.toISOString(),
      documentType: r.documentType === "invoice" || r.documentType === "credit_note" ? r.documentType : null,
      documentNumber: r.documentNumber,
      issueDate: r.issueDate,
      senderEndpoint: r.senderEndpoint,
      senderName: r.senderName,
      currency: r.currency,
      payableAmount: r.payableAmount === null ? null : Number(r.payableAmount),
      outcome: r.outcome as EinvoiceReceptionOutcome,
      detail: r.detail,
      invoiceScanId: r.invoiceScanId,
      scanNumber: r.scanNumber ?? null,
    };
  }

  const service: EInvoiceOriginalReader & {
    runReceive: typeof runReceive;
    runReceiveIfDue: () => Promise<"disabled" | "not-due" | "busy" | ReceiveRunResult>;
    receiveNow: () => Promise<EinvoiceReceiveResult>;
    kick: () => void;
    receptionLog: (limit: number) => Promise<EinvoiceReceptionLogRow[]>;
    dismiss: (receptionId: string, userId: string | null) => Promise<EinvoiceReceptionLogRow>;
  } = {
    runReceive,

    // The scheduler's entry point: only with the reception on and a key +
    // account; the interval and the lease decide. Unreadable documents are
    // left to Hämta nu.
    async runReceiveIfDue() {
      const s = await settings.read();
      if (!s.reception.enabled || !s.apiKey || !s.accountId) return "disabled";
      const at = now();
      if (!isReceiveDue(s.reception.lastRunAt, s.reception.intervalMinutes, at)) return "not-due";
      const lease = await repo.claimReceiveLease(at, RECEIVE_LEASE_MS);
      if (!lease) return "busy";
      return runLeased(lease, false);
    },

    // Hämta nu: a run right away (the interval does not matter, the lease
    // does — 409 einvoice-receive-busy while another run holds it), which
    // also retries the unreadable documents. Works with the reception
    // switch off too, so a sandbox trial can be pulled.
    async receiveNow() {
      await settings.provider({ requireEnabled: false, requireAccount: true });
      const lease = await repo.claimReceiveLease(now(), RECEIVE_LEASE_MS);
      if (!lease) throw new EinvoiceReceiveBusyError();
      const result = await runLeased(lease, true);
      // A transport failure is the answer (the route maps it); a partial run
      // answers with its counts, the stamped error shows on the page.
      if (result.thrown) throw result.thrown;
      return { imported: result.imported, duplicates: result.duplicates, unreadable: result.unreadable };
    },

    // A web hook's received_invoice.created: a run after the answer, when
    // the reception is on; the lease keeps two from overlapping. Never
    // throws, never awaited by the caller.
    kick() {
      void (async () => {
        const s = await settings.read();
        if (!s.reception.enabled || !s.apiKey || !s.accountId) return;
        const lease = await repo.claimReceiveLease(now(), RECEIVE_LEASE_MS);
        if (!lease) return;
        await runLeased(lease, false);
      })().catch((err) => log("e-invoice reception: webhook-triggered run failed", { error: (err as Error)?.name }));
    },

    async receptionLog(limit) {
      return (await repo.listReceptions(limit)).map(logRow);
    },

    // Markera som hanterad: an unreadable document is acknowledged at the
    // access point (gone there counts as done; a transport failure changes
    // nothing) and closed as `dismissed` — the invoice is registered another
    // way. Only from `unreadable`.
    async dismiss(receptionId, userId) {
      const row = await repo.findReception(receptionId);
      if (!row) throw new EinvoiceReceptionNotFoundError(receptionId);
      if (row.outcome !== "unreadable") throw new InvalidStatusTransitionError(`Cannot dismiss a reception with outcome "${row.outcome}"`);
      // The ack goes with the saved key — the other environment's document
      // would answer not-found and be "dismissed" without ever being
      // acknowledged where it lives.
      const { environment } = await settings.read();
      if (row.environment !== environment) throw new EinvoiceOtherEnvironmentError(row.environment === "production" ? "production" : "sandbox");
      const provider = await settings.provider({ requireEnabled: false, requireAccount: true });
      try {
        await provider.acknowledgeReceived(row.providerInvoiceId);
      } catch (err) {
        if (!(err instanceof EInvoiceProviderError && err.kind === "not-found")) throw err;
      }
      await repo.updateReceptionOutcome(receptionId, { outcome: "dismissed", detail: RECEIVE_TEXTS.dismissed });
      await audit.log({
        entityType: "einvoice_reception",
        entityId: receptionId,
        action: "dismissed",
        detail: { environment: row.environment, providerInvoiceId: row.providerInvoiceId, previousDetail: row.detail },
        userId,
      });
      return logRow((await repo.findReception(receptionId))!);
    },

    // --- EInvoiceOriginalReader (the Fakturainkorg's view of the original) ---

    async infoForScan(scanId) {
      const reception = await repo.findReceptionByScan(scanId);
      if (!reception) return null;
      return info(reception);
    },

    async forScan(scanId) {
      const reception = await repo.findReceptionByScan(scanId);
      if (!reception) return null;
      const stored = await repo.readReceptionOriginal(reception.id);
      if (!stored) return null;
      const reading = readWith(stored.originalXml, stored.interpretationXml);
      if (!reading.ok) return null;
      return { ...info(reception), einvoice: reading.einvoice, receptionId: reception.id, attachments: reading.einvoice.attachments } satisfies EInvoiceOriginalView;
    },

    async originalXml(scanId) {
      const reception = await repo.findReceptionByScan(scanId);
      if (!reception) return null;
      const stored = await repo.readReceptionOriginal(reception.id);
      if (!stored) return null;
      return {
        xml: stored.originalXml,
        contentType: stored.originalContentType,
        filename: `e-faktura-${safeFilename(stored.documentNumber ?? reception.providerInvoiceId)}.xml`,
      };
    },

    // The one place the XML is parsed for an attachment: the download.
    async attachment(scanId, index) {
      const found = await service.forScan(scanId);
      const attachment = found?.attachments.find((a) => a.index === index);
      if (!attachment) return null;
      return {
        filename: safeFilename(attachment.filename ?? `bilaga-${index + 1}`),
        contentType: safeAttachmentContentType(attachment.mimeCode),
        data: attachment.content(),
      };
    },
  };

  function info(reception: ReceptionRow): EInvoiceOriginalInfo {
    const stored = Array.isArray(reception.attachments) ? (reception.attachments as EInvoiceAttachmentMeta[]) : [];
    return {
      environment: reception.environment === "production" ? "production" : "sandbox",
      senderEndpoint: reception.senderEndpoint,
      senderName: reception.senderName,
      receivedAt: reception.receivedAt,
      attachments: stored.map((a) => ({ index: a.index, filename: a.filename ?? null, contentType: safeAttachmentContentType(a.contentType), sizeBytes: a.sizeBytes })),
    };
  }

  return service;
}

export type EinvoiceReceiveService = ReturnType<typeof createEinvoiceReceiveService>;

// app.ts decorates the Fastify instance so server.ts can hand the job to
// the scheduler without rebuilding the dependency graph.
declare module "fastify" {
  interface FastifyInstance {
    einvoiceReceive: EinvoiceReceiveService;
  }
}
