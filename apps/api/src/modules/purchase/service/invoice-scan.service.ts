import { createHash } from "node:crypto";
import {
  emptyInvoiceScanResult,
  emptyScanField,
  INVOICE_SCAN_FILE_TYPES,
  invoiceScanResultSchema,
  isUncertain,
  type CreateSupplierInvoiceInput,
  type InvoiceScanEngine,
  type InvoiceScanResult,
  type InvoiceScanStatus,
  type ListInvoiceScansQuery,
} from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { stockholmToday } from "../../system/service/delivery-days.js";
import type { ExistingScan, InvoiceScanRepository, InvoiceScanRow } from "../repository/invoice-scan.repository.js";
import { InvalidStatusTransitionError } from "./purchase.service.js";
import type { SupplierInvoiceService } from "./supplier-invoice.service.js";
import type { InvoiceScanSettingsService } from "./invoice-scan-settings.service.js";
import { canPerform, type InvoiceScanAction } from "./invoice-scan/invoice-scan-status.js";
import { allLines, extractPdfText, hasTextLayer, PDF_MAX_PAGES, PdfUnreadableError, type PdfText, type PdfTextLine } from "./invoice-scan/pdf-text.js";
import { interpretRules, learnLabels, matchSupplier, type CompanyIdentity, type FinalValues, type HintLabel } from "./invoice-scan/rules-interpreter.js";
import { matchInvoiceRows, matchPurchaseOrder, purchaseOrderTokens } from "./invoice-scan/po-matching.js";

// Fakturaskanning — the Fakturainkorg (spec §2–§5). Files come in, the rules
// interpret them to a proposal, a person reviews and creates the supplier
// invoice DRAFT (Skapa leverantörsfaktura). Never automatic bookkeeping,
// never automatic attest. The status whitelist is invoice-scan-status.ts.

export class InvoiceScanNotFoundError extends Error {
  constructor(id: string) {
    super(`Invoice scan ${id} not found`);
    this.name = "InvoiceScanNotFoundError";
  }
}

// The same file is already in the inbox (not rejected). 409 with the
// existing scan.
export class InvoiceScanDuplicateError extends Error {
  constructor(public existing: ExistingScan) {
    super(`The file is already in the invoice inbox as ${existing.scanNumber}`);
    this.name = "InvoiceScanDuplicateError";
  }
}

// Tolka med AI without a configured AI interpretation (always, until the AI
// step of the spec is built). 409.
export class InvoiceScanAiNotConfiguredError extends Error {
  constructor() {
    super("AI-tolkning är inte inställd — välj läge och ange API-nyckel under System → Fakturaskanning");
    this.name = "InvoiceScanAiNotConfiguredError";
  }
}

// What a CompanyInfoRow must carry (System → Företagsuppgifter).
export interface InvoiceScanCompanyReader {
  getCompanyInfo(): Promise<{
    name: string;
    orgNumber: string | null;
    vatNumber: string | null;
    bankgiro: string | null;
    plusgiro: string | null;
    iban: string | null;
    postalCode: string | null;
  } | null>;
}

export interface UploadedFile {
  filename: string;
  contentType: string;
  data: Buffer;
  // fastify-multipart truncates at the size limit instead of throwing.
  truncated: boolean;
}

const TEXTS = {
  unreadable: "PDF:en gick inte att läsa",
  noTextLayer: "PDF:en saknar textlager (skannad) — den kan tolkas med AI, annars fyll i fälten för hand",
  image: "Bilder tolkas inte lokalt — tolka med AI eller fyll i fälten för hand",
  tooLarge: "Filen är för stor — max 20 MB",
  empty: "Filen är tom",
  wrongType: "Filtypen stöds inte — ladda upp PDF, JPEG eller PNG",
  notMatchingType: "Filens innehåll är inte en PDF, JPEG eller PNG",
};

// The first bytes of each accepted type — a browser's mimetype alone is not
// enough to let a file into the bookkeeping.
function hasSignature(contentType: string, data: Buffer): boolean {
  if (contentType === "application/pdf") return data.subarray(0, 1024).includes("%PDF-");
  if (contentType === "image/jpeg") return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (contentType === "image/png") return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return false;
}

// The stored jsonb, validated on read. An unknown version (or anything that
// does not parse) is reported as no result — Tolka igen gives a new one.
function parseResult(raw: unknown): InvoiceScanResult | null {
  if (raw === null || raw === undefined) return null;
  const parsed = invoiceScanResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function createInvoiceScanService(deps: {
  repo: InvoiceScanRepository;
  supplierInvoices: Pick<SupplierInvoiceService, "prepareCreate" | "createInTx" | "auditCreated" | "getInvoice">;
  company: InvoiceScanCompanyReader;
  settings: Pick<InvoiceScanSettingsService, "read">;
  audit?: AuditWriter;
  // Stockholm day (date plausibility); the tests pin it.
  today?: () => string;
  // The PDF text extraction; the tests may inject a failing one.
  extractText?: (data: Buffer) => Promise<PdfText>;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo, supplierInvoices, company, settings } = deps;
  const audit = deps.audit ?? { log: async () => {} };
  const today = deps.today ?? stockholmToday;
  const extract = deps.extractText ?? ((data: Buffer) => extractPdfText(data));
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  function assertAllowed(action: InvoiceScanAction, status: InvoiceScanStatus) {
    if (!canPerform(action, status)) {
      throw new InvalidStatusTransitionError(`Cannot ${action} an invoice scan in status "${status}"`);
    }
  }

  async function companyIdentity(): Promise<CompanyIdentity> {
    const info = await company.getCompanyInfo();
    return {
      name: info?.name ?? null,
      orgNumber: info?.orgNumber ?? null,
      vatNumber: info?.vatNumber ?? null,
      bankgiro: info?.bankgiro ?? null,
      plusgiro: info?.plusgiro ?? null,
      iban: info?.iban ?? null,
      postalCode: info?.postalCode ?? null,
    };
  }

  // The local post-processing every interpretation goes through (the rules
  // now, the AI's answer from step 2): the duplicate check and, with Matcha
  // mot inköpsorder, the purchase order and its rows.
  async function postProcess(result: InvoiceScanResult, lines: PdfTextLine[]): Promise<InvoiceScanResult> {
    const supplierId = result.supplier.matchedSupplierId;
    if (supplierId && result.invoiceNumber.value) {
      const existing = await repo.findSupplierInvoiceByNumber(supplierId, result.invoiceNumber.value);
      if (existing) {
        result.duplicateOf = { supplierInvoiceId: existing.id, registrationNumber: existing.registrationNumber };
        result.checks.push(`Leverantören har redan en faktura med fakturanummer ${result.invoiceNumber.value} (${existing.registrationNumber})`);
      }
    }
    const { poMatching } = await settings.read();
    if (!poMatching) {
      // Inställningen av: no purchase order fields, the rows stay free rows.
      result.purchaseOrderReference = emptyScanField();
      result.purchaseOrderId = emptyScanField();
      result.rows = result.rows.map((row) => ({ ...row, articleId: null, purchaseOrderRowId: null }));
      return result;
    }
    if (!supplierId) return result;
    const [orders, prefix] = await Promise.all([repo.receivedPurchaseOrders(supplierId), repo.purchaseOrderPrefix()]);
    const match = matchPurchaseOrder({
      reference: result.purchaseOrderReference.value,
      tokens: purchaseOrderTokens(lines.map((l) => l.text), prefix),
      orders,
      prefix,
    });
    if (match) {
      result.purchaseOrderId = { value: match.purchaseOrderId, confidence: match.confidence, source: "rules" };
      if (result.rows.length > 0) {
        result.rows = matchInvoiceRows(result.rows, await repo.purchaseOrderRowsForMatch(match.purchaseOrderId, supplierId));
      }
    }
    return result;
  }

  async function rulesResult(text: PdfText): Promise<InvoiceScanResult> {
    const lines = allLines(text);
    const [companyId, suppliers] = await Promise.all([companyIdentity(), repo.supplierIdentities()]);
    const match = matchSupplier(lines, companyId, suppliers);
    const hints: HintLabel[] = match.matchedSupplierId ? await repo.hintsFor(match.matchedSupplierId) : [];
    const result = interpretRules({ lines, company: companyId, suppliers, hints, today: today(), match });
    return postProcess(result, lines);
  }

  // The rules on one scan, outside any transaction. A PDF pdfjs cannot read
  // leaves the scan where it was with the check; never throws for the file's
  // sake. null when the scan is gone or no longer pending (a concurrent
  // Avvisa/Skapa won).
  async function runRules(id: string): Promise<InvoiceScanRow | null> {
    const scan = await repo.findWithData(id);
    if (!scan || !canPerform("interpret", scan.status) || !scan.data) return null;
    if (scan.contentType !== "application/pdf") {
      return repo.writeResult(id, {
        result: emptyInvoiceScanResult([TEXTS.image]),
        interpretedBy: "rules",
        hasTextLayer: null,
        pageCount: null,
        interpreted: true,
      });
    }
    let text: PdfText;
    try {
      text = await extract(scan.data);
    } catch (err) {
      if (!(err instanceof PdfUnreadableError)) log("invoice scan: text extraction failed", { scan: scan.scanNumber, error: (err as Error)?.name });
      return repo.writeResult(id, {
        result: emptyInvoiceScanResult([TEXTS.unreadable]),
        interpretedBy: null,
        hasTextLayer: null,
        pageCount: null,
        interpreted: false,
      });
    }
    const textLayer = hasTextLayer(text);
    const result = textLayer ? await rulesResult(text) : emptyInvoiceScanResult([TEXTS.noTextLayer]);
    if (text.truncated) result.checks.push(`PDF:en har ${text.pageCount} sidor — bara de ${PDF_MAX_PAGES} första lästes`);
    return repo.writeResult(id, {
      result,
      interpretedBy: "rules",
      hasTextLayer: textLayer,
      pageCount: text.pageCount,
      interpreted: true,
    });
  }

  function listRow(row: Awaited<ReturnType<InvoiceScanRepository["list"]>>["rows"][number]) {
    const { result: raw, ...columns } = row;
    const result = parseResult(raw);
    return {
      ...columns,
      supplierId: result?.supplier.matchedSupplierId ?? null,
      invoiceNumber: result?.invoiceNumber.value ?? null,
      grossAmount: result?.grossAmount.value ?? null,
      currency: result?.currency.value ?? null,
      // Osäker: a pending scan whose main fields are not all sure.
      uncertain: result !== null && (row.status === "new" || row.status === "interpreted") && isUncertain(result),
    };
  }

  const service = {
    async list(query: ListInvoiceScansQuery) {
      const { rows, total } = await repo.list(query);
      return { rows: rows.map(listRow), total };
    },

    async get(id: string) {
      const row = await repo.findById(id);
      if (!row) throw new InvoiceScanNotFoundError(id);
      const { result: raw, ...columns } = row;
      const result = parseResult(raw);
      const { poMatching } = await settings.read();
      return {
        ...columns,
        result,
        // A stored result in an unknown shape — Tolka igen replaces it.
        resultOutdated: raw !== null && result === null,
        uncertain: result !== null && isUncertain(result),
        // Tolka med AI: built in the AI step of the spec; until then never
        // available (POST …/interpret with engine "ai" answers 409).
        aiAvailable: false,
        poMatching,
      };
    },

    async readFile(id: string) {
      const file = await repo.readFile(id);
      if (!file) throw new InvoiceScanNotFoundError(id);
      return file;
    },

    // One or several files. A bad file never fails the others: rejected
    // (type, size, content) and duplicates are reported beside the created
    // ones. The rules run per created scan after its insert (the scan exists
    // even if they crash), before the answer.
    async upload(files: UploadedFile[], userId: string | null) {
      const created: ReturnType<typeof listRow>[] = [];
      const duplicates: { filename: string; existing: ExistingScan }[] = [];
      const rejected: { filename: string; reason: string }[] = [];
      for (const file of files) {
        if (!(INVOICE_SCAN_FILE_TYPES as readonly string[]).includes(file.contentType)) {
          rejected.push({ filename: file.filename, reason: TEXTS.wrongType });
          continue;
        }
        if (file.truncated) {
          rejected.push({ filename: file.filename, reason: TEXTS.tooLarge });
          continue;
        }
        if (file.data.length === 0) {
          rejected.push({ filename: file.filename, reason: TEXTS.empty });
          continue;
        }
        if (!hasSignature(file.contentType, file.data)) {
          rejected.push({ filename: file.filename, reason: TEXTS.notMatchingType });
          continue;
        }
        const sha256 = createHash("sha256").update(file.data).digest("hex");
        const inserted = await repo.insert({
          source: "upload",
          filename: file.filename.slice(0, 255),
          contentType: file.contentType,
          sizeBytes: file.data.length,
          sha256,
          data: file.data,
          uploadedBy: userId,
        });
        if (!inserted.ok) {
          duplicates.push({ filename: file.filename, existing: inserted.existing });
          continue;
        }
        await audit.log({
          entityType: "invoice_scan",
          entityId: inserted.scan.scanNumber,
          action: "received",
          detail: { source: "upload", filename: inserted.scan.filename, sizeBytes: inserted.scan.sizeBytes, sha256 },
          userId,
        });
        try {
          await runRules(inserted.scan.id);
        } catch (err) {
          log("invoice scan: interpretation failed", { scan: inserted.scan.scanNumber, error: (err as Error)?.name });
        }
        const row = await repo.listRow(inserted.scan.id);
        if (row) created.push(listRow(row));
      }
      return { created, duplicates, rejected };
    },

    // Tolka igen (rules) — Tolka med AI arrives with the AI step.
    async interpret(id: string, engine: InvoiceScanEngine) {
      const scan = await repo.findById(id);
      if (!scan) throw new InvoiceScanNotFoundError(id);
      assertAllowed("interpret", scan.status);
      if (engine === "ai") throw new InvoiceScanAiNotConfiguredError();
      const written = await runRules(id);
      if (!written) {
        const now = await repo.findById(id);
        if (!now) throw new InvoiceScanNotFoundError(id);
        assertAllowed("interpret", now.status);
      }
      return service.get(id);
    },

    // Skapa leverantörsfaktura: ONE transaction — the scan locked FOR
    // UPDATE (pending, else 409), the supplier invoice draft through the
    // supplier invoice service's own createInTx, the file moved into
    // supplier_invoice_files (same name, type and sha256), the scan
    // converted with data = NULL, and the leverantörsinlärning. A duplicate
    // invoice number (409 as today) changes nothing. The rate lookup and the
    // text extraction for the learning happen before the transaction.
    async convert(id: string, input: CreateSupplierInvoiceInput, userId: string) {
      const scan = await repo.findWithData(id);
      if (!scan) throw new InvoiceScanNotFoundError(id);
      assertAllowed("convert", scan.status);

      let labels: HintLabel[] = [];
      if (scan.data && scan.contentType === "application/pdf" && scan.hasTextLayer !== false) {
        try {
          const text = await extract(scan.data);
          if (hasTextLayer(text)) {
            const purchaseOrderReference = input.purchaseOrderId ? await repo.purchaseOrderNumber(input.purchaseOrderId) : null;
            const nonZero = (v: number | undefined) => (v === undefined || Math.abs(v) < 0.005 ? null : v);
            const finals: FinalValues = {
              invoiceNumber: input.invoiceNumber,
              invoiceDate: input.invoiceDate,
              dueDate: input.dueDate ?? null,
              paymentReference: input.paymentReference?.value ?? null,
              grossAmount: nonZero(input.grossAmount),
              netAmount: nonZero(input.netAmount),
              vatAmount: nonZero(input.vatAmount),
              purchaseOrderReference,
            };
            labels = learnLabels(allLines(text), finals);
          }
        } catch {
          // An unreadable file learns nothing; the conversion goes on.
          labels = [];
        }
      }

      const prepared = await supplierInvoices.prepareCreate(input);
      const { invoice, file } = await repo.transaction(async (tx) => {
        const locked = await repo.lockInTx(tx, id);
        if (!locked) throw new InvoiceScanNotFoundError(id);
        assertAllowed("convert", locked.status);
        if (!locked.data) throw new InvalidStatusTransitionError("The invoice scan has no file to move");
        const created = await supplierInvoices.createInTx(tx, input, userId, prepared);
        const fileRow = await repo.insertInvoiceFileInTx(tx, {
          supplierInvoiceId: created.id,
          filename: locked.filename,
          contentType: locked.contentType,
          sizeBytes: locked.sizeBytes,
          sha256: locked.sha256,
          data: locked.data,
          uploadedBy: userId,
        });
        const converted = await repo.markConvertedInTx(tx, id, { supplierInvoiceId: created.id, supplierInvoiceFileId: fileRow.id });
        if (!converted) throw new InvalidStatusTransitionError("The invoice scan was changed by someone else");
        await repo.upsertHintsInTx(tx, input.supplierId, labels);
        return { invoice: created, file: fileRow };
      });

      await supplierInvoices.auditCreated(invoice, userId, { fromScan: scan.scanNumber });
      await audit.log({
        entityType: "supplier_invoice",
        entityId: invoice.registrationNumber,
        action: "file_added",
        detail: { filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256, fromScan: scan.scanNumber },
        userId,
      });
      await audit.log({
        entityType: "invoice_scan",
        entityId: scan.scanNumber,
        action: "converted",
        detail: { supplierInvoice: invoice.registrationNumber, learnedLabels: labels.length },
        userId,
      });
      return supplierInvoices.getInvoice(invoice.id);
    },

    async reject(id: string, reason: string, userId: string | null) {
      const scan = await repo.findById(id);
      if (!scan) throw new InvoiceScanNotFoundError(id);
      assertAllowed("reject", scan.status);
      const row = await repo.reject(id, reason, userId);
      if (!row) throw new InvalidStatusTransitionError("The invoice scan was changed by someone else");
      await audit.log({ entityType: "invoice_scan", entityId: row.scanNumber, action: "rejected", detail: { reason }, userId });
      return service.get(id);
    },

    async restore(id: string, userId: string | null) {
      const scan = await repo.findById(id);
      if (!scan) throw new InvoiceScanNotFoundError(id);
      assertAllowed("restore", scan.status);
      const result = await repo.restore(id);
      if (!result.ok) {
        if (result.reason === "duplicate") throw new InvoiceScanDuplicateError(result.existing);
        throw new InvalidStatusTransitionError("The invoice scan was changed by someone else");
      }
      await audit.log({ entityType: "invoice_scan", entityId: result.scan.scanNumber, action: "restored", userId });
      return service.get(id);
    },

    // Räkenskapsinformation: only a rejected scan (the user has judged that
    // the file is not an invoice) can be deleted — logged with the file's
    // name, sha256 and the reason.
    async remove(id: string, userId: string | null) {
      const scan = await repo.findById(id);
      if (!scan) throw new InvoiceScanNotFoundError(id);
      assertAllowed("delete", scan.status);
      const deleted = await repo.deleteRejected(id);
      if (!deleted) throw new InvalidStatusTransitionError("The invoice scan was changed by someone else");
      await audit.log({
        entityType: "invoice_scan",
        entityId: deleted.scanNumber,
        action: "deleted",
        detail: { filename: deleted.filename, sha256: deleted.sha256, reason: deleted.rejectedReason },
        userId,
      });
    },
  };

  return service;
}

export type InvoiceScanService = ReturnType<typeof createInvoiceScanService>;
